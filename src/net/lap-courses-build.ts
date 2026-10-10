// src/net/lap-courses-build.ts — builds `content/lap-courses.json`. DEV-372.
//
// The ONE writer of the artefact `src/net/lap-courses.ts` describes, and the
// reason it may exist at all under hard rule 3: every number in it is read
// from a level, an edition or an aircraft file, or from the constants sheet,
// through the game's own functions. Nothing here is typed by hand.
//
//   gates     `courseGates(level)`: the liveness walk, the z flip and the
//             gate multiplier, exactly as `game/mission.ts` scores a live run
//   finish    the largest sphere, SIM space, as `game/ghosts.ts` builds it
//   release   `spawn.pos` raised by `spawn.launch.rise`, which is where
//             `game/flight.ts` holds the ship until the lift lets go
//   route     the authored line, as `boot/app.ts`'s crash line reads it
//   variants  which ones an edition flies: `resolveVariantIn`, the game's own
//             rule (Classic: standard, whatever is asked)
//   ceiling   per variant, off `hoverJetView(scale)` — the view
//             `createHoverJet` is built from for that variant (DEV-380)
//   rooms     per edition that races rooms, the start list a room hands out:
//             `game/racer-grid.ts`'s `roomStarts`, mirrored (DEV-477)
//
// It imports `game/` and `content/` but never a loader (no `import.meta.glob`), so
// DEV-851's room judge can build ONE course with it inside a Function
// (`net/room-course.ts`). The shipped courses' server still reads the JSON this
// writes: `tests/unit/lap-courses.test.ts` runs this and compares the result
// with the committed bytes; `tools/net/write-lap-courses.mjs` runs the same test
// in write mode. Building it from the files on disk, through the level loader,
// is `lap-courses-text.ts` (DEV-544).

import { type Aircraft, resolveVariantIn, validateAircraft } from '@/content/aircraft-schema'
import { canonicalJson, fnv1a32, oneLineNumberArrays } from '@/content/canonical-json'
import type { Edition } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import { courseGates } from '@/game/mission'
import { runningMode } from '@/game/modes'
import { roomStarts } from '@/game/racer-grid'
import { type HoverJetSheet, hoverJetView } from '@/sim/hoverjet'
import type { SheetScale } from '@/sim/variant'
import {
  LAP_COURSES_SCHEMA,
  LAP_MODE,
  LAP_RULES_EPOCH,
  type LapCeiling,
  type LapCourse,
  type LapCourses,
  type LapEditionRules,
  type LapVariantRules,
} from './lap-courses'

/**
 * The vehicles with a board, and how a variant's ceiling is read off its view
 * of the sheet. The HoverJet only: the JumpSeat's modes are not Ring Attack.
 */
const CEILING_OF: Readonly<Record<string, (scale: SheetScale) => LapCeiling>> = {
  hoverjet: (scale) => {
    const sheet: HoverJetSheet = hoverJetView(scale)
    return {
      maxSpeed: sheet.ship.maxSpeed,
      increment: sheet.speedChain.speedIncreaseAmt,
      boostMultiplier: sheet.ship.boostMultiplier,
      mass: sheet.rigidbody.mass,
      drag: sheet.rigidbody.drag,
    }
  },
}

/**
 * Does the server judge this level? A Ring Attack course, as the level runs
 * without a `?mode=` request (`runningMode`, the game's own rule), flown by a
 * vehicle with a ceiling, with rings and a finish to time it by.
 */
export const judgedLevel = (level: Level): boolean =>
  runningMode(level) === LAP_MODE &&
  Object.hasOwn(CEILING_OF, level.vehicle) &&
  courseGates(level).length > 0 &&
  level.finish != null

type Tuple = [number, number, number]

const tuple = (v: readonly number[]): Tuple => [v[0] as number, v[1] as number, v[2] as number]

/** Everything in a course but its editions: the part every rules hash covers. */
const courseBody = (level: Level): Omit<LapCourse, 'editions'> => {
  const finish = level.finish as NonNullable<Level['finish']>
  const spawn = level.spawn.pos as readonly number[]
  const rise = level.spawn.launch?.rise ?? 0
  const respawn = level.respawn?.pos as readonly number[] | undefined
  const route = level.route
  return {
    mission: level.id,
    mode: LAP_MODE,
    vehicle: level.vehicle,
    worldOffset: tuple(level.worldOffset as readonly number[]),
    gates: courseGates(level).map((g) => ({
      centre: [g.centre.x, g.centre.y, g.centre.z],
      radius: g.radius,
      points: g.points,
      triggerOnce: g.triggerOnce,
    })),
    finish: {
      x: finish.pos[0] as number,
      y: finish.pos[1] as number,
      z: -(finish.pos[2] as number),
      radius: finish.radius,
    },
    release: [spawn[0] as number, (spawn[1] as number) + rise, -(spawn[2] as number)],
    respawn: respawn ? [respawn[0] as number, respawn[1] as number, -(respawn[2] as number)] : null,
    route: route && route.length > 1 ? route.map(tuple) : null,
    timeLimit: level.timer.timeLimit,
    scoring: {
      bonusParTime: level.timer.bonusParTime,
      timeBonusMultiplier: level.scoring.timeBonusMultiplier,
    },
  }
}

/** An edition's gameplay block without its prose, which moves no lap time. */
const withoutNotes = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutNotes)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) if (k !== 'note') out[k] = withoutNotes(v)
    return out
  }
  return value
}

// DEV-538: the canonical form and its hash moved to `content/canonical-json.ts`,
// so the shipped-course override can use them without importing `game/`.
// Re-exported: this module's callers keep their import.
export { canonicalJson, fnv1a32 }

/** What a variant contributes to its board's rules: its id, its multipliers and the ceiling they make. */
export interface RulesVariant {
  readonly id: string
  readonly scale: SheetScale
  readonly ceiling: LapCeiling
}

/**
 * The gameplay blocks no SOLO lap can feel, left out of the hash. `rooms`
 * (DEV-389) decides whether this edition races rooms, and a room lap never goes on
 * a solo board (plan/MULTIPLAYER.md §11 call 10) — so hashing it would restart
 * every board over a setting none of their laps was flown under. `editor`
 * (DEV-466) decides what the menus offer, and no lap is flown under it at all;
 * nor under `tv` (DEV-480), which only watches.
 */
export const RULES_IGNORE: readonly string[] = ['rooms', 'editor', 'tv']

/** `<epoch>.<hash>` of the course body, the variant and the edition's gameplay. */
export const rulesVersion = (
  body: Omit<LapCourse, 'editions'>,
  variant: RulesVariant,
  gameplay: unknown,
): string => {
  const hashed: Record<string, unknown> = { ...(gameplay as Record<string, unknown>) }
  for (const key of RULES_IGNORE) delete hashed[key]
  return `${LAP_RULES_EPOCH}.${fnv1a32(
    canonicalJson({
      epoch: LAP_RULES_EPOCH,
      course: body,
      variant,
      gameplay: withoutNotes(hashed),
    }),
  )}`
}

/**
 * The variants an edition flies, by the game's own rule: an id is flown when
 * `resolveVariantIn` honours a request for it. On Classic nothing but
 * `standard` is, so nothing else gets a board there.
 */
const flownVariants = (aircraft: Aircraft, edition: Edition) =>
  aircraft.variants.filter((v) => {
    const resolved = resolveVariantIn(aircraft, v.id, edition)
    return resolved.id === v.id && resolved.note === null
  })

const editionRules = (
  level: Level,
  body: Omit<LapCourse, 'editions'>,
  aircraft: Aircraft,
  edition: Edition,
): LapEditionRules => {
  const crash = edition.gameplay.crash
  const ceilingOf = CEILING_OF[body.vehicle] as (scale: SheetScale) => LapCeiling
  const variants: Record<string, LapVariantRules> = {}
  for (const v of flownVariants(aircraft, edition)) {
    // A MECHANIC is a number the sheet does not have (a jump burst, a gravity
    // scale), so no view of the sheet can bound what it does to a lap time.
    // None exists for a vehicle with a board today; the day one does, this
    // refuses to write a ceiling that would not hold, rather than write it.
    if (v.mechanics && Object.keys(v.mechanics).length > 0) {
      throw new Error(
        `lap-courses: the ${body.vehicle}'s "${v.id}" variant has mechanics (${Object.keys(v.mechanics).join(', ')}) no speed ceiling accounts for`,
      )
    }
    const ceiling = ceilingOf(v.scale)
    variants[v.id] = {
      rules: rulesVersion(body, { id: v.id, scale: v.scale, ceiling }, edition.gameplay),
      ceiling,
    }
  }
  return {
    variants,
    crash: {
      enabled: crash.enabled,
      resetBackMetres: crash.resetBackMetres,
      clearanceMetres: crash.clearanceMetres,
    },
    // DEV-477: the room judge's starts — the list a room hands out, THREE
    // mirrored into SIM space (z flips). Outside `rules` (see `RULES_IGNORE`):
    // this block is added after every rules string above was hashed.
    ...(edition.gameplay.rooms.enabled
      ? {
          rooms: {
            starts: roomStarts(level, edition.gameplay.racers).map(
              (s): Tuple => [s.pos[0], s.pos[1], -s.pos[2]],
            ),
          },
        }
      : {}),
  }
}

/**
 * The artefact, as data. `levels` in any order; the output is sorted by
 * mission, and each course's variants in the aircraft file's own order.
 */
export const buildLapCourses = (
  levels: readonly Level[],
  editions: readonly Edition[],
  aircraft: readonly Aircraft[],
): LapCourses => {
  const byVehicle = new Map(
    aircraft.map((a) => [a.vehicle as string, validateAircraft(a, `aircraft ${a.vehicle}`)]),
  )
  const courses: Record<string, LapCourse> = {}
  const sortedEditions = [...editions].sort((a, b) => (a.id < b.id ? -1 : 1))
  for (const level of [...levels].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (!judgedLevel(level)) continue
    const craft = byVehicle.get(level.vehicle)
    if (!craft) throw new Error(`lap-courses: no aircraft file for ${level.vehicle} (${level.id})`)
    const body = courseBody(level)
    const perEdition: Record<string, LapEditionRules> = {}
    for (const edition of sortedEditions)
      perEdition[edition.id] = editionRules(level, body, craft, edition)
    courses[level.id] = { ...body, editions: perEdition }
  }
  return {
    $schema: LAP_COURSES_SCHEMA,
    note:
      'GENERATED by src/net/lap-courses-build.ts from content/levels, content/editions and content/aircraft; never edit. ' +
      'Rebuild: node tools/net/write-lap-courses.mjs. Guarded by tests/unit/lap-courses.test.ts (DEV-372).',
    epoch: LAP_RULES_EPOCH,
    courses,
  }
}

/**
 * The file's bytes: two-space JSON with every array of plain numbers on one
 * line (a route is hundreds of points; one number per line is unreviewable),
 * and a final newline.
 */
export const serialiseLapCourses = (courses: LapCourses): string =>
  `${oneLineNumberArrays(JSON.stringify(courses, null, 2))}\n`
