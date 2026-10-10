// tests/unit/helpers/jumpseat-run.ts — one whole JumpSeat mission, headless.
//
// NOT a `.test.ts`, so vitest does not collect it. It is the harness the mission
// specs share, and keeping it out of them is what stops "the autopilot flies" and
// "the mode scores" from quietly becoming the same assertion written twice.
//
// This is the payoff of the sim being three-free and deterministic: a complete
// Target Practice run — the countdown, the flight model, the sprung legs, the
// terrain, the pad plates, the accuracy streak, the refuel spheres and the
// finish slab — is a few hundred milliseconds of arithmetic with no renderer, no
// DOM and no GPU anywhere near it.
//
// ── It is the GAME's own loop, in the game's own order ────────────────────
//
// The order below is `game/jumpseat-flight.ts`'s `step()` followed by
// `boot/app.ts`'s mission tick, and it is copied deliberately rather than
// invented: a harness that steps the pieces in a different order measures a
// vehicle nobody flies. If either of those files reorders, this has to follow,
// and `tests/unit/jumpseat-autopilot-missions.test.ts` is what would notice —
// its numbers would move.
//
//   1. `stepJumpSeatStart`     the 7.5 s `Trigger_EnableJumpShip` countdown
//   2. the autopilot           one decision per FIXED step (DEV-027)
//   3. `stepJumpSeat`          thrust, torque, legs, gravity, hover, DragHack
//   3b. `headTouches`          the pilot's head box, where 3 put it (DEV-403)
//   4. `stepTerrainCollision`  and the angular-drag flash it leaves behind
//   5. `stepJumpSeatRefuel`    pads pay 10/s while the hull is in the sphere
//   5b. `stepJumpSeatDeaths`   a head strike (DEV-403) or a dry seat no sphere can
//                              reach (DEV-342) loses the run — one at a time
//   6. `stepMission`           plates, streak, finish slab, clock, medals — from GO
//
// ── The terrain is REAL, and that is why this can skip ────────────────────
//
// It builds the mission's own collision height field out of the published
// heightmap, the same `buildHeightField` call `game/terrain/load-terrain.ts`
// makes, including the `worldOffset` + `envRoot` composition DEV-042 corrected.
// Anything less would be measuring a controller flying over an ocean of nothing:
// the pads sit 1 to 386 m above the ground and half the interest is whether the
// route clears what is between them.
//
// `public/assets/` is gitignored and hydrated from R2 (`pnpm assets:pull`), so a
// runner without it skips — LOUDLY, per the house rule that a test which
// silently passes on missing input is worse than no test.
//
// **The OCEAN plate is deliberately absent**, where `boot/app.ts` gives the hull
// both fields. Simonet's sea sits at about 102 m and the lowest any measured run
// reaches is 181 m, alpine and desert have no ocean at all, and building a
// 262 km water plate to prove a surface nobody touches is 1,024 chunks of
// arithmetic for nothing. Stated rather than omitted: if a future controller
// change flies lower, this becomes wrong and the `minY` in the result is what
// would say so.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// The game seam's OWN readers, not copies of them. `markerFor` and
// `startSpecFor` are where `game/jumpseat-flight.ts` reads content;
// `refuelSpheresFor`, `autopilotWaypointsFor` and `autopilotFinishPad` are what
// it builds the run out of. A harness that reimplemented any of them would be
// measuring a mission the game does not fly, and would agree with it right up
// until one of them changed. (CLAUDE.md, "the agreement lesson".)
import type { FlightVariant } from '@/content/aircraft-schema'
import type { GameMode, Level } from '@/content/level-schema'
import {
  autopilotFinishPad,
  autopilotWaypointsFor,
  HEAD_STRIKE,
  headStrikeApplies,
  jumpSeatFor,
  jumpSeatHeadBox,
  markerFor,
  padFieldsFor,
  refuelSpheresFor,
  STRANDED,
  startSpecFor,
} from '@/game/jumpseat-flight'
import { type Medal, medalFor, NO_LEVERS, startMission, stepMission } from '@/game/mission'
import { rulesFor, runningMode } from '@/game/modes'
import { livePads, padZones } from '@/game/targets'
import { JUMPSEAT, TERRAIN } from '@/generated/constants.generated'
import { FIXED_DT } from '@/sim/constants'
import {
  createJumpSeatStart,
  type JumpSeat,
  type JumpSeatInput,
  noJumpSeatInput,
  stepJumpSeat,
  stepJumpSeatStart,
  updateJumpSeatFootProbes,
} from '@/sim/jumpseat'
import {
  createJumpSeatPilot,
  DEFAULT_JUMPSEAT_AUTOPILOT,
  type JumpSeatAutopilotTuning,
  type JumpSeatPilot,
  planJumpSeatRoute,
  routeLength,
  stepJumpSeatPilot,
} from '@/sim/jumpseat-autopilot'
import { createHead, headTouches, stepJumpSeatDeaths } from '@/sim/jumpseat-head'
import { createRefuel, stepJumpSeatRefuel } from '@/sim/jumpseat-refuel'
import { createStranded } from '@/sim/jumpseat-stranded'
import type { Quat } from '@/sim/math/quat'
import { type Vec3, v3 } from '@/sim/math/vec3'
import {
  createPropCollision,
  type PropColliders,
  type PropCollisionSpec,
  stepPropCollision,
} from '@/sim/props/collision'
import type { FacetedTerrainParams } from '@/sim/terrain/faceted'
import { buildHeightField, type HeightField } from '@/sim/terrain/height-field'
import { importUnityTexture } from '@/sim/terrain/image-sampler'
import {
  collisionAngularDrag,
  createTerrainCollision,
  HOVERJET_GROUND,
  hullFromColliders,
  stepTerrainCollision,
  type TerrainCollisionSpec,
} from '@/sim/terrain-collision'
import { decodePng } from '../../../tools/terrain/png.mjs'
import { levelJson } from './content'

/** The six. `int_02` is in here on purpose — see its row in the table. */
export const JUMPSEAT_MISSIONS = [
  'rookie_01_jumpSeat',
  'rookie_02_jumpSeat',
  'int_01_jumpSeat',
  'int_02_jumpSeat',
  'adv_01_jumpSeat',
  'adv_02_jumpSeat',
] as const

export type JumpSeatMissionId = (typeof JUMPSEAT_MISSIONS)[number]

/**
 * The repo root. `fileURLToPath`, not `new URL(...).pathname` — on Windows the
 * latter comes back as `/C:/Users/...` and every join produces `C:\C:\Users\...`.
 */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url))

export const loadJumpSeatLevel = (id: string): Level => levelJson(id)

/**
 * The published heightmap for each environment's LAND terrain.
 *
 * The keys mirror `MAP_PATHS` in `game/terrain/load-terrain.ts`. Kauai is absent
 * because no JumpSeat mission uses it; the six run on alpine, desert and
 * simonet.
 */
const LAND_MAPS: Record<string, { readonly leaf: string; readonly height: string }> = {
  alpine: { leaf: 'forest', height: 'public/assets/terrain/alpine/forest_02-height.png' },
  desert: { leaf: 'canyon', height: 'public/assets/terrain/desert/canyon_04-height.png' },
  simonet: { leaf: 'islands', height: 'public/assets/terrain/simonet/islandgroup-height.png' },
}

/** `game/terrain/load-terrain.ts`'s `TERRAIN_SEED`. Jitter never reaches the field. */
const TERRAIN_SEED = 20160101

interface TerrainEntry {
  readonly terrainSize: number
  readonly terrainHeight: number
  readonly chunkSize: number
  readonly baseResolution: number
  readonly randomOffset: number
  readonly transform?: {
    readonly position?: readonly number[]
    readonly envRoot?: readonly number[]
    readonly scale?: readonly number[]
  }
}

export const jumpSeatTerrainAvailable = (level: Level): boolean => {
  const map = LAND_MAPS[level.environment]
  return map !== undefined && fs.existsSync(path.join(ROOT, map.height))
}

const fieldCache = new Map<string, HeightField>()

/**
 * The mission's collision surface, SIM space.
 *
 * The composition is `game/terrain/load-terrain.ts`'s, verbatim, including the
 * asymmetric z: the render group goes to `(wo.x + tp.x, wo.y + tp.y, wo.z -
 * tp.z)` in three space and the sim is that mirrored in z, so the sim origin is
 * `(wo.x + tp.x, wo.y + tp.y, tp.z - wo.z)`. Getting that wrong puts the
 * collision surface 4 km from the terrain and every run sails straight through
 * the island — which is a green test measuring nothing.
 */
export const jumpSeatHeightField = (level: Level): HeightField => {
  const map = LAND_MAPS[level.environment]
  if (!map) throw new Error(`no published land heightmap for environment "${level.environment}"`)
  return fieldFor(level, map)
}

/**
 * The published heightmap for each environment's SEA, keyed as `LAND_MAPS` is.
 * Simonet is the only JumpSeat environment with one (alpine and desert have no
 * water), and it is `game/terrain/load-terrain.ts`'s `simonet.ocean`.
 */
const OCEAN_MAPS: Record<string, { readonly leaf: string; readonly height: string }> = {
  simonet: { leaf: 'ocean', height: 'public/assets/terrain/simonet/water-height.png' },
}

/**
 * The mission's SEA collision surface, SIM space, or null for an environment
 * with no water — the second field `boot/app.ts` hands the hull.
 *
 * Built only for a run that asks (`JumpSeatRunOptions.ocean`). The standard and
 * overclocked seats never come near it (see the header); the jumping spider
 * (DEV-383) lands on anything, water included, and pushes off it again,
 * because 2016's ocean plate is a `TerrainCollider` like any other.
 */
export const jumpSeatOceanField = (level: Level): HeightField | null => {
  const map = OCEAN_MAPS[level.environment]
  return map ? fieldFor(level, map) : null
}

const fieldFor = (
  level: Level,
  map: { readonly leaf: string; readonly height: string },
): HeightField => {
  const key = `${level.environment}|${map.leaf}|${(level.worldOffset as unknown as number[]).join(',')}`
  const cached = fieldCache.get(key)
  if (cached) return cached

  const sheet = TERRAIN as unknown as Record<
    string,
    { readonly terrains: Record<string, TerrainEntry> }
  >
  const entry = sheet[level.environment]?.terrains?.[map.leaf]
  if (!entry) throw new Error(`no terrain "${level.environment}.${map.leaf}" in the sheet`)

  const image = importUnityTexture(decodePng(path.join(ROOT, map.height)))
  const local = entry.transform?.position ?? [0, 0, 0]
  const envRoot = entry.transform?.envRoot ?? [0, 0, 0]
  const wo = level.worldOffset as unknown as number[]
  const params: FacetedTerrainParams = {
    terrainSize: entry.terrainSize,
    terrainHeight: entry.terrainHeight,
    chunkSize: entry.chunkSize,
    baseResolution: entry.baseResolution,
    randomOffset: entry.randomOffset,
    seed: TERRAIN_SEED,
  } as FacetedTerrainParams
  const built = buildHeightField(image, params, {
    position: [
      (wo[0] as number) + (local[0] as number) + (envRoot[0] as number),
      (wo[1] as number) + (local[1] as number) + (envRoot[1] as number),
      (local[2] as number) + (envRoot[2] as number) - (wo[2] as number),
    ],
    scale: (entry.transform?.scale ?? [1, 1, 1]) as number[],
  })
  fieldCache.set(key, built)
  return built
}

/** THREE space -> SIM space: the z flip, and nothing else. */
const toSim = (p: readonly number[]): Vec3 => v3(p[0] as number, p[1] as number, -(p[2] as number))

export interface JumpSeatRunResult {
  readonly id: string
  readonly mode: string
  readonly pads: number
  /** Distinct pads that scored at least once. */
  readonly padsHit: number
  /**
   * How many pads have yielded something — `targets.padTaken.filter(Boolean)`.
   *
   * The ARRAY is what the JumpSeat autopilot steers by (`stepJumpSeatPilot`'s
   * fourth argument), so this is that counter's scalar and not a second opinion
   * about `padsHit`. They agree under the shipped `PAD_LATCH`; the two exist
   * separately because `padsHit` is the SCORER's tally and this is the PILOT's.
   */
  readonly padTaken: number
  /** `course.passedCount` at the end — the counter the HoverJet autopilot steers by. */
  readonly ringsPassed: number
  /** Plates taken whose tier is the bullseye. */
  readonly bullseyes: number
  readonly midHits: number
  readonly outerHits: number
  readonly score: number
  readonly peakMultiplier: number
  readonly clearBonus: number
  readonly finished: boolean
  readonly finishCrossed: boolean
  /** Mission clock at the end of the run, seconds. */
  readonly elapsed: number
  /** Medals crossed mid-run. Empty in Target Practice, which awards at the end. */
  readonly medals: readonly string[]
  /** The band the run actually earned, by the mission's own curve. */
  readonly medal: Medal | null
  /** Lowest the tank ever reached. Negative means it latched the thruster off. */
  readonly minFuel: number
  /**
   * The stranded rule fired (DEV-342): dry, out of every sphere's reach, and
   * grounded. In the game that RESTARTS the run, so the harness ends it there —
   * a run that has been lost is not flown on for the rest of the safety cap.
   */
  readonly stranded: boolean
  /**
   * The pilot's head touched something (DEV-403): 2016's own JumpSeat death.
   * In the game that RESTARTS the run a second later, so the harness ends it
   * there, as it does for `stranded`. `headStrike` is the first touch, where and
   * when, for the message. With `noHeadStrike` the run flies on and this still
   * reports the first touch — and so on a seat the rule does not apply to yet
   * (`headStrikeApplies`: the jumping spider), as the game flies it on.
   */
  readonly headStruck: boolean
  readonly headStrike: {
    readonly elapsed: number
    readonly tick: number
    readonly position: Vec3
    readonly cursor: number
  } | null
  readonly refuelAdded: number
  /** Fuel the run BURNT: the tank it started with, less what it ended with, plus what the pads added. */
  readonly fuelBurnt: number
  /** Jumps fired (DEV-383). 0 on a seat that carries no jump. */
  readonly jumps: number
  /** Ticks on which the hull was inside the terrain. */
  readonly strikes: number
  readonly abandoned: number
  readonly routeMetres: number
  readonly maxSpeed: number
  readonly minY: number
  readonly finalPosition: Vec3
}

export interface JumpSeatRunOptions {
  readonly tuning?: JumpSeatAutopilotTuning
  /**
   * The mode to REQUEST, as `?mode=` does — `runningMode`'s third input.
   *
   * Undefined is the mission's own, which is what every caller but
   * `mode-crossed-progress.test.ts` wants. It exists so a crossed pairing can be
   * flown through the game's own door rather than by editing a level: the
   * forcing rules in `runningMode` still apply on top of it, so this cannot
   * conjure a mode a level refuses.
   */
  readonly mode?: GameMode
  /**
   * Safety cap on the SIM, seconds. Defaults to **600**, which is not a rule.
   *
   * It used to default to `level.timer.timeLimit`, and that was wrong in a way
   * worth a comment: the harness then imposed the very rule it was being used
   * to measure. Once `MODES.targetPractice.clockEnds` went false (DEV-056) the
   * game stopped ending a Target Practice run on the clock and this cap went on
   * stopping it at 180 s — so the table below still printed "CLOCK", and it was
   * the harness's clock.
   *
   * `mission.finished` is what ends a run. This only exists so a controller
   * that never arrives cannot hang the suite.
   */
  readonly maxSeconds?: number
  /** Fly with no terrain at all — for isolating the controller from the ground. */
  readonly noTerrain?: boolean
  /**
   * Give the HULL the sea too, as `boot/app.ts` does (`jumpSeatOceanField`).
   * Off by default for the reason in the header; the spider's runs turn it on,
   * because a spider that falls short over water lands on it and jumps again.
   */
  readonly ocean?: boolean
  /**
   * The aircraft variant to fly (DEV-384), built by the seam's own
   * `jumpSeatFor`. Undefined is `standard`, which is `createJumpSeat()`.
   */
  readonly variant?: FlightVariant
  /**
   * Fly the pads as they were BEFORE DEV-120: no landing surface, and the
   * plates swept by the body rather than the feet. A measurement knob for the
   * before/after in DEV-120's row, never a way to make a test green — the game
   * has no such switch.
   */
  readonly noPads?: boolean
  /**
   * Fly with the head strike SWITCHED OFF, as every run did before DEV-403 —
   * so a run is flown on past a head touch and `headStruck` still reports the
   * first one. A measurement knob for DEV-403's row, like `noPads`, and never
   * a way to make a test green: the game has no such switch.
   */
  readonly noHeadStrike?: boolean
  /**
   * Anniversary's FOREST (DEV-403), as `tests/unit/helpers/prop-forest.ts`
   * builds it, and the preset's prop spec. Absent is the prop-less flight every
   * run had before.
   *
   * Given, it is stepped where `boot/app.ts` steps it: AFTER the flight, against
   * the HoverJet's hull (the one `app.ts` hands the JumpSeat as well, DEV-136),
   * so the seat bounces off and breaks trees as it does in the game. The head
   * strike counts the props, and so does the pilot's head guard. Colliders it
   * breaks are put back at the end, because `forestFor` caches the forest and
   * the next run must not fly through a clearing this one made.
   */
  readonly forest?: { readonly colliders: PropColliders; readonly spec: PropCollisionSpec }
  /** Hand the PILOT the pads as terrain too (an experiment knob; the game's seam decides). */
  readonly pilotSeesPads?: boolean
  /** Called every step with the live state, for telemetry. */
  readonly watch?: (t: {
    readonly elapsed: number
    readonly position: Vec3
    readonly velocity: Vec3
    readonly fuel: number
    readonly cursor: number
    readonly phase: string
    readonly score: number
    /** The live seat and the stick the pilot just wrote — read, never keep. */
    readonly seat: JumpSeat
    readonly input: JumpSeatInput
    /** The live pilot — read, never keep. */
    readonly pilot: JumpSeatPilot
  }) => void
}

/** The JumpSeat's own hull and contact numbers, exactly as `game/jumpseat-flight.ts` builds them. */
const COLLISION: TerrainCollisionSpec = {
  hull: hullFromColliders(
    JUMPSEAT.shipCollisionColliders as unknown as Parameters<typeof hullFromColliders>[0],
  ),
  restitution: 0,
  friction: 0.6,
  flashSeconds: 0.3,
  flashAngularDrag: 3,
}

/**
 * Fly one mission and report what happened.
 *
 * Deliberately NOT a golden trajectory. What is pinned by the callers is the
 * OUTCOME — pads, bullseyes, score, whether it finished — because the controller
 * is proportional and pinning its path would make every legitimate tuning change
 * a wall of diffs, which is `tests/unit/autopilot.test.ts`'s reasoning and the
 * same reasoning applies twice as hard to a vehicle that is holding itself up.
 */
export const flyJumpSeatMission = (
  level: Level,
  options: JumpSeatRunOptions = {},
): JumpSeatRunResult => {
  const tuning = options.tuning ?? DEFAULT_JUMPSEAT_AUTOPILOT
  const terrain: readonly HeightField[] = options.noTerrain ? [] : [jumpSeatHeightField(level)]
  const ocean = options.ocean && !options.noTerrain ? jumpSeatOceanField(level) : null
  const ground: readonly HeightField[] = ocean ? [...terrain, ocean] : terrain
  // What the HULL hits: the ground (and the sea, when asked) plus the pads'
  // landing surfaces (DEV-120), exactly as `setTerrain` composes them. The PILOT
  // still avoids the land alone, as `app.ts`'s `autopilotTerrain` does — the
  // pads are where it is trying to go.
  const collisionFields: readonly HeightField[] = options.noPads
    ? ground
    : [...ground, ...padFieldsFor(level)]

  const seat = jumpSeatFor(options.variant)
  // `game/jumpseat-flight.ts`'s own line, through the same door: the mode
  // descriptor, asked about the RUNNING mode. A harness that re-derived the fuel
  // rule would agree with the game right up until one of them changed.
  seat.burnsFuel = rulesFor(runningMode(level, options.mode)).burnsFuel
  const marker = markerFor(level)
  const q = marker.quat as unknown as number[]
  const orientation: Quat = {
    // The level JSON is THREE space and the sim is UNITY space: the mirror in z
    // negates a quaternion's x and y. Seeding an unconverted one gives a ship
    // that flies perfectly well backwards, which is what happened to the
    // HoverJet the first time.
    x: -(q[0] as number),
    y: -(q[1] as number),
    z: q[2] as number,
    w: q[3] as number,
  }
  const startPos = toSim(marker.pos as unknown as number[])
  seat.body.position.x = startPos.x
  seat.body.position.y = startPos.y
  seat.body.position.z = startPos.z
  seat.body.orientation.x = orientation.x
  seat.body.orientation.y = orientation.y
  seat.body.orientation.z = orientation.z
  seat.body.orientation.w = orientation.w

  const start = createJumpSeatStart()
  const startSpec = startSpecFor(level)

  const collision = createTerrainCollision()
  const baseAngularDrag = seat.body.angularDrag

  const mission = startMission(level, options.mode)
  // The seam's OWN route, not a second opinion about it — `game/jumpseat-flight.
  // ts` builds this exact tour for `?autopilot=1`.
  const route = planJumpSeatRoute(autopilotWaypointsFor(level), startPos, autopilotFinishPad(level))
  const pilot = createJumpSeatPilot(route)
  // The seam's head guard (DEV-403), over the surfaces the head rule tests.
  // Set below, once those exist.
  const refuel = createRefuel(refuelSpheresFor(level))
  const strandedState = createStranded()
  let stranded = false
  // DEV-403: the seam's own box, off the collider list the hull is built from.
  // It touches what the hull does — `collisionFields`, the pads to their
  // undersides (DEV-383's `belowField`) — and the props, when the run is given
  // `forest`. So does the pilot's head guard.
  const headBox = jumpSeatHeadBox(
    JUMPSEAT.shipCollisionColliders as unknown as Parameters<typeof jumpSeatHeadBox>[0],
  )
  const forest = options.forest
  const propState = forest ? createPropCollision() : null
  const brokenBefore = forest ? forest.colliders.broken.slice() : null
  pilot.head = {
    box: headBox,
    surfaces: collisionFields,
    props: forest?.colliders ?? null,
  }
  const headState = createHead()
  let headStrike: JumpSeatRunResult['headStrike'] = null
  let tick = 0

  const input = noJumpSeatInput()
  const zones = padZones(level)
  const takenBefore = mission.targets.taken.slice()

  let bullseyes = 0
  let midHits = 0
  let outerHits = 0
  let peakMultiplier = 1
  let minFuel = seat.fuel
  let strikes = 0
  let maxSpeed = 0
  let minY = Number.POSITIVE_INFINITY
  let elapsed = 0

  // NOT `level.timer.timeLimit` — see the option's own note. A harness that
  // imposes the rule it is measuring reports the harness.
  const maxSeconds = options.maxSeconds ?? 600
  const steps = Math.ceil(
    (maxSeconds + startSpec.triggerDelaySeconds + startSpec.countdownSeconds) / FIXED_DT,
  )

  let headStruck = false
  for (let i = 0; i < steps && !mission.finished && !stranded && !headStruck; i++) {
    tick++
    if (stepJumpSeatStart(start, startSpec, FIXED_DT)) seat.live = true

    stepJumpSeatPilot(
      pilot,
      seat,
      input,
      mission.targets.padTaken,
      // The spider plans each hop over what the HULL lands on — the pads and
      // the sea included — as the seam hands it (DEV-383).
      options.pilotSeesPads || seat.jump ? collisionFields : terrain,
      tuning,
      FIXED_DT,
    )

    stepJumpSeat(seat, input, collisionFields, FIXED_DT)
    // The head, where the flight model put the seat, before the resolve — the
    // seam's own order (DEV-403).
    const headTouching = headTouches(seat.body, headBox, collisionFields, forest?.colliders ?? null)
    if (headTouching && headStrike === null) {
      headStrike = {
        elapsed: tick * FIXED_DT,
        tick,
        position: v3(seat.body.position.x, seat.body.position.y, seat.body.position.z),
        cursor: pilot.cursor,
      }
    }
    if (stepTerrainCollision(collision, seat.body, collisionFields, COLLISION, FIXED_DT)) strikes++
    seat.body.angularDrag = collisionAngularDrag(collision, COLLISION, baseAngularDrag)
    // The feet, after the collision has placed the body — the seam's own order.
    updateJumpSeatFootProbes(seat)
    stepJumpSeatRefuel(refuel, seat, seat.body.position, FIXED_DT)
    // After the refuel, as the seam does it: both deaths, one at a time.
    const death = stepJumpSeatDeaths(
      headState,
      strandedState,
      // The seam's own gate: the rule is off, for now, on a seat that jumps.
      options.noHeadStrike || !headStrikeApplies(seat) ? false : headTouching,
      seat,
      refuel,
      HEAD_STRIKE,
      STRANDED,
      FIXED_DT,
    )
    if (death === 'fuel') stranded = true
    if (death === 'head') headStruck = true
    // The forest, where `boot/app.ts` steps it: after the flight.
    if (forest && propState) {
      stepPropCollision(
        propState,
        seat.body,
        HOVERJET_GROUND.collision.hull,
        forest.colliders,
        forest.spec,
      )
    }

    // The mission clock only runs once the ship is live — and since DEV-343 the
    // GAME agrees: `boot/app.ts` returns before the scoring while
    // `flight.countdownHolds`, the HoverJet's shape (its lift holds everything
    // through the ride and the 3-2-1). This used to say "the way 2016's does",
    // citing `Trigger_EnableShip` — which is the HOVERJET's rig; 2016 starts no
    // race clock at all in a JumpSeat scene, and for a while the game counted
    // from the first tick while this counted from GO, so the two disagreed by
    // 7.5 s on every time in DEV-056's table.
    if (seat.live) {
      // The plates are scored against the FEET (DEV-120), through the same
      // lever `boot/app.ts` uses; everything else is Classic's zeroed levers.
      stepMission(mission, level, seat.body.position, FIXED_DT, {
        ...NO_LEVERS,
        probes: options.noPads ? undefined : seat.footProbes,
      })
      elapsed = mission.elapsed
    }

    if (seat.fuel < minFuel) minFuel = seat.fuel
    if (mission.targets.multiplier > peakMultiplier) peakMultiplier = mission.targets.multiplier
    const v = seat.body.velocity
    const speed = Math.hypot(v.x, v.y, v.z)
    if (speed > maxSpeed) maxSpeed = speed
    if (seat.body.position.y < minY) minY = seat.body.position.y

    options.watch?.({
      elapsed,
      position: seat.body.position,
      velocity: seat.body.velocity,
      fuel: seat.fuel,
      cursor: pilot.cursor,
      phase: pilot.phase,
      score: mission.targets.score,
      seat,
      input,
      pilot,
    })
  }

  // Put back what this run broke (see `forest`).
  if (forest && brokenBefore) forest.colliders.broken.set(brokenBefore)

  for (let i = 0; i < zones.length; i++) {
    if (!mission.targets.taken[i] || takenBefore[i]) continue
    const points = (zones[i]?.points ?? 0) as number
    if (points === 100) bullseyes++
    else if (points === 50) midHits++
    else outerHits++
  }

  return {
    id: level.id,
    mode: mission.mode,
    pads: livePads(level).length,
    padsHit: mission.targets.padsHit,
    padTaken: mission.targets.padTaken.filter(Boolean).length,
    ringsPassed: mission.course.passedCount,
    bullseyes,
    midHits,
    outerHits,
    score: mission.targets.score,
    peakMultiplier,
    clearBonus: mission.targets.clearBonus,
    finished: mission.finished,
    finishCrossed: mission.finishCrossed,
    elapsed,
    medals: mission.awarded.slice(),
    medal: medalFor(mission, level),
    minFuel,
    stranded,
    // Touched at all — with the rule on, that run was lost (or ended inside the
    // second before the restart); with `noHeadStrike`, the first touch.
    headStruck: headStrike !== null,
    headStrike,
    refuelAdded: refuel.added,
    fuelBurnt: seat.tuning.maxFuel - seat.fuel + refuel.added,
    jumps: seat.jump?.jumps ?? 0,
    strikes,
    abandoned: pilot.abandoned,
    routeMetres: routeLength(route, startPos),
    maxSpeed,
    minY,
    finalPosition: v3(seat.body.position.x, seat.body.position.y, seat.body.position.z),
  }
}
