// src/net/lap-courses.ts — the courses the lap server can judge, as data.
//
// DEV-372, `docs/plan/PLAYER-GHOSTS.md` §5. The server scores a lap with the
// game's own `scoreGhost`, and `scoreGhost` needs a COURSE: the gates, the
// finish, where the clip's positions are relative to. The game builds those
// from a level through `game/mission.ts`'s `courseGates` — and the Function
// cannot import `game/` or `content/`: `content/load-level.ts` is an
// `import.meta.glob`, which is Vite's, and `content/edition-schema.ts` imports
// the renderer. So the course reaches the server as DATA.
//
// `content/lap-courses.json` is that data. It is GENERATED, never hand-typed
// (hard rule 3): `src/net/lap-courses-build.ts` builds it from the level JSON
// through `courseGates` itself, and `tests/unit/lap-courses.test.ts`
// regenerates it and compares the bytes, so a level, an edition or a flight
// constant that moves without it being rebuilt goes red. Rebuild with
// `node tools/net/write-lap-courses.mjs`.
//
// ── The rules version ─────────────────────────────────────────────────────
//
// A board is keyed by (mission, mode, edition, aircraft VARIANT) and a rules
// version (PLAYER-GHOSTS §3.6; the variant is DEV-380's, and AIRCRAFT-VARIANTS
// §6.3 asks for it): Anniversary and Classic differ in flags that move a lap
// time, a speed variant flies to a different ceiling, and any change to a
// course or to the numbers a ceiling is made of moves what a time means. The
// version is a hash of exactly those — the course entry, the variant's scale
// and ceiling, and the edition's `gameplay` block — so it changes when they
// do, by construction, and a gameplay switch added later changes it without
// anybody remembering to bump anything. `LAP_RULES_EPOCH` is the one
// hand-bumped part: for a change to the FLIGHT MODEL, which moves times and is
// not data.
//
// Which variants an edition has is data too: Classic flies `standard` only
// (`gameplay.variants.enabled` false, as `resolveVariantIn` rules), so its
// entry lists one, and a lap claiming another is refused, not filed.
//
// The CLIENT reads its `rules` from here too (`lapRules`), so the recorder and
// the server cannot disagree about it: there is one string, in one file.
//
// SERVER-SAFE: imports nothing but its own JSON. No game, no content loader,
// no renderer, no DOM.

import data from '../../content/lap-courses.json'

/** The artefact's schema name. A change of shape is a new name. */
export const LAP_COURSES_SCHEMA = 'ff2-lap-courses-1'

/**
 * The hand-bumped half of the rules version. Bump it when a change to the
 * FLIGHT MODEL (not to data) moves what a lap time means — every board then
 * starts again, and the old laps stay raceable from their links until they
 * expire. Changing it changes `content/lap-courses.json`, so the regenerate
 * test makes the bump a deliberate, reviewed edit.
 */
export const LAP_RULES_EPOCH = 1

/** The only mode with a board: a course of rings, a clock and a finish. */
export const LAP_MODE = 'ringAttack'

/**
 * What a lap's `LapMeta.vehicle` says: `<vehicle>:<variant>`, the level's
 * vehicle as the level spells it and the aircraft variant it was flown in
 * (`standard` included — a lap that names no variant is refused rather than
 * guessed at). The recorder (DEV-371) writes this; `lap-validate.ts` reads it
 * with `parseLapVehicle` and CHECKS the variant against the course's edition.
 * A variant id is `^[a-z][a-z0-9-]*$` (`content/aircraft-schema.ts`), so it
 * never holds the colon.
 */
export const lapVehicle = (vehicle: string, variant: string): string => `${vehicle}:${variant}`

/** `lapVehicle`'s inverse, or null for a string that is not `<vehicle>:<variant>`. */
export const parseLapVehicle = (text: string): { vehicle: string; variant: string } | null => {
  const m = /^([A-Za-z][A-Za-z0-9-]*):([a-z][a-z0-9-]*)$/.exec(text)
  return m ? { vehicle: m[1] as string, variant: m[2] as string } : null
}

export type Vec3Tuple = readonly [number, number, number]

/** A gate, SIM space, exactly as `courseGates` builds it. */
export interface LapGate {
  readonly centre: Vec3Tuple
  readonly radius: number
  readonly points: number
  readonly triggerOnce: boolean
}

/** One aircraft variant's board on one course, under one edition. */
export interface LapVariantRules {
  /** The board key's rules half. See the header. */
  readonly rules: string
  /** The numbers this variant's speed ceiling is made of: the sheet, scaled by the variant. */
  readonly ceiling: LapCeiling
}

/** What an edition changes about judging a lap on this course. */
export interface LapEditionRules {
  /**
   * The aircraft variants this edition flies, by id, each with its own board.
   * Classic's holds `standard` alone.
   */
  readonly variants: Readonly<Record<string, LapVariantRules>>
  /**
   * DEV-477: a room's STARTS, SIM space, for the ROOM judge (`room-lap.ts`),
   * on an edition that races rooms; absent on one that does not. The course's
   * start list in the order a room hands it out — the player's pad, then the
   * racers' own (`game/racer-grid.ts`'s `roomStarts`, mirrored) — so a seat's
   * `RoomSeat.start` is an index into it. Not in any `rules` string: a room lap
   * is never on a solo board.
   */
  readonly rooms?: { readonly starts: readonly Vec3Tuple[] }
  /**
   * DEV-126's crash reset, the only mid-lap placement besides the respawn
   * marker. `enabled: false` (Classic) makes every placement but a respawn
   * illegal.
   */
  readonly crash: {
    readonly enabled: boolean
    /** Metres the reset backs down the line from the crash. */
    readonly resetBackMetres: number
    /** Metres the reset may lift a pose above the line to clear the ground. */
    readonly clearanceMetres: number
  }
}

/**
 * The numbers the chain-aware speed ceiling is made of (§3.4), read off the
 * variant's view of the constants sheet (`hoverJetView(scale)`, the same view
 * `createHoverJet` flies). In here rather than imported by the server so that
 * a change to any of them changes the rules version: they are what a lap time
 * is measured against.
 */
export interface LapCeiling {
  /** `Ship_HoverShip.maxSpeed`, before the chain. */
  readonly maxSpeed: number
  /** `EnergySystem_Ship.speedIncreaseAmt`: added to `maxSpeed` per ring. */
  readonly increment: number
  readonly boostMultiplier: number
  readonly mass: number
  readonly drag: number
}

export interface LapCourse {
  readonly mission: string
  readonly mode: string
  /** The level's `vehicle`, as the level JSON spells it. */
  readonly vehicle: string
  /** THREE space. Lap positions are relative to it (`sim/ghost.ts`). */
  readonly worldOffset: Vec3Tuple
  readonly gates: readonly LapGate[]
  /** SIM space. Null for a course with none. */
  readonly finish: {
    readonly x: number
    readonly y: number
    readonly z: number
    readonly radius: number
  } | null
  /** SIM space: where the lift lets go. Tick 0 of a lap is recorded here. */
  readonly release: Vec3Tuple
  /**
   * SIM space: 2016's `SinglePlayerRespawnPosition`. A boundary death restarts
   * the run THERE (`boot/app.ts`: clock, rings and score back to zero), so it
   * is the other legal first key, and a legal placement mid-lap.
   */
  readonly respawn: Vec3Tuple | null
  /** The authored course line, THREE space as the level stores it; null for none. */
  readonly route: readonly Vec3Tuple[] | null
  /** Seconds. A lap's `keyCount` is capped at `timeLimit / FIXED_DT`. */
  readonly timeLimit: number
  /** 2016's leaderboard arithmetic, for display: rings × points + the time bonus. */
  readonly scoring: {
    readonly bonusParTime: number
    readonly timeBonusMultiplier: number
  }
  readonly editions: Readonly<Record<string, LapEditionRules>>
}

export interface LapCourses {
  readonly $schema: typeof LAP_COURSES_SCHEMA
  readonly note: string
  readonly epoch: number
  readonly courses: Readonly<Record<string, LapCourse>>
}

/** The committed artefact. */
export const LAP_COURSES = data as unknown as LapCourses

/** The course for a mission, or null when the server does not judge it. */
export const lapCourse = (mission: string, courses: LapCourses = LAP_COURSES): LapCourse | null =>
  Object.hasOwn(courses.courses, mission) ? (courses.courses[mission] as LapCourse) : null

/**
 * The board for a mission, an edition and an aircraft variant: its rules and
 * ceiling, or null when there is none — an unknown mission or edition, or a
 * variant that edition does not fly.
 */
export const lapVariantRules = (
  mission: string,
  edition: string,
  variant: string,
  courses: LapCourses = LAP_COURSES,
): LapVariantRules | null => {
  const course = lapCourse(mission, courses)
  if (!course || !Object.hasOwn(course.editions, edition)) return null
  const variants = (course.editions[edition] as LapEditionRules).variants
  return Object.hasOwn(variants, variant) ? (variants[variant] as LapVariantRules) : null
}

/**
 * The `rules` string a lap of this mission, edition and aircraft variant must
 * carry — what the recorder writes into `LapMeta.rules` (DEV-371) and what the
 * board is keyed by. Null when there is no board for it. The variant is
 * REQUIRED: a default here would file every lap whose caller forgot it on the
 * standard's board.
 */
export const lapRules = (
  mission: string,
  edition: string,
  variant: string,
  courses: LapCourses = LAP_COURSES,
): string | null => lapVariantRules(mission, edition, variant, courses)?.rules ?? null
