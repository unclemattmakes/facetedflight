// tests/unit/helpers/sim-step-harness.ts — one fixed step of `int_01`, headless.
//
// VR-PERF §5.9 H1. Shared by `tests/unit/sim-step-budget.test.ts` (which counts
// and prints, in `pnpm test`) and `tests/bench/sim-step.bench.ts` (which times,
// under `pnpm bench`, by hand and never in CI). One harness so the two cannot
// drift into measuring different things and both be believed.
//
// ── The sequence ──────────────────────────────────────────────────────────
//
// `makePlayer().step()` is the player's half of the closure `boot/app.ts`
// hands to `stepFixed`, in `app.ts`'s order:
//
//   `autopilotActions` -> `stepHoverJet` -> `probeSurface` (the DEV-112 fan)
//   -> `stepMission` with the preset's levers, the fan's `nearest` standing in
//   for `clearance` the way `flight.nearestSurface()` does -> `chainGate` on a
//   scored ring -> `stepBoundary`.
//
// Not in it: the hover motor and terrain collision, which a LAUNCHED HoverJet
// (gravity off, `LaunchElevator.FinishLaunch()`) does not exercise over open
// water; the render layer, which is a different thread of the frame; and the
// props, traffic and ghosts, which are per-mission content rather than the
// step. Anything measured through this is therefore a LOWER bound on the
// game's tick, and the modules that say so say it in those words.
//
// ── The world, and why it is synthetic ───────────────────────────────────
//
// `public/assets/` is gitignored and absent in CI, so a harness that loaded the
// real Simonet height maps would sit behind a `describe.skipIf` that never ran
// where it matters. Instead: `buildHeightField` over a closed-form island map
// on `int_01`'s REAL geometry — a 4096 m terrain on an 8 m pitch whose
// transform is the map's CORNER at sim-space (-2048, 0, -2048), which is where
// its LevelArt sits once `levelOffset` is composed (DEV-042) — plus a flat
// ocean plate on the 256 m world pitch the real one has (a 32 m grid scaled by
// 8). So `sampleBudget(5, FIELDS, 90)` is the same **400** the real island
// gives (`sim/surface-proximity.ts`'s header), and the fan does the same amount
// of work per tick that it does in the game. Nothing is read from disk but the
// level and edition JSON, which are tracked.
//
// No three, no DOM: everything here is sim and content.

import type { Edition } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import {
  courseGates,
  type MissionLevers,
  missionScore,
  startMission,
  stepMission,
} from '@/game/mission'
import { racerStarts } from '@/game/racer-grid'
import { assignTunings } from '@/game/racers'
import { HOVERJET } from '@/generated/constants.generated'
import { threeQuatTupleToUnity, threeTupleToUnity } from '@/render/unity-space'
import { AI_RACER_TUNINGS, type AiRacer, createAiRacer, stepAiRacer } from '@/sim/ai-racer'
import { autopilotActions, nextGate } from '@/sim/autopilot'
import { type BoundarySpec, createBoundary, stepBoundary } from '@/sim/boundary'
import { FIXED_DT } from '@/sim/constants'
import type { Gate } from '@/sim/course'
import { createHoverJet, noInput, stepHoverJet } from '@/sim/hoverjet'
import { chainGate } from '@/sim/speed-chain'
import {
  createSurfaceProximity,
  probeSurface,
  type SurfaceProximity,
} from '@/sim/surface-proximity'
import type { FacetedTerrainParams } from '@/sim/terrain/faceted'
import { buildHeightField, type HeightField } from '@/sim/terrain/height-field'
import type { MapSampler, Rgb } from '@/sim/terrain/image-sampler'
import { type HullSphere, hullFromColliders } from '@/sim/terrain-collision'
import { levelJson, validEdition } from './content'

/** The mission both consumers run. Seven HoverJet courses; this is the release one. */
export const MISSION = 'int_01_hoverJet'

/** Sim seconds a full run covers. The same window `smoke-missions.test.ts` flies. */
export const WINDOW_SECONDS = 30

/** Ticks in that window — the loop bound, and a thing to assert. */
export const TICKS = Math.round(WINDOW_SECONDS / FIXED_DT)

export const LEVEL: Level = levelJson(MISSION)

/** Both presets, through the check `content/load-edition.ts` runs on them. */
export const EDITIONS: readonly Edition[] = ['classic', 'anniversary'].map(validEdition)

export const editionNamed = (id: string): Edition => {
  const hit = EDITIONS.find((e) => e.id === id)
  if (!hit) throw new Error(`sim-step-harness: no preset "${id}"`)
  return hit
}

// ── the world ─────────────────────────────────────────────────────────────

/** `int_01`'s real land geometry: 4096 m on an 8 m pitch. */
const LAND_PARAMS = {
  terrainSize: 4096,
  terrainHeight: 600,
  baseResolution: 8,
  chunkSize: 256,
  randomOffset: 0,
  seed: 1,
} as unknown as FacetedTerrainParams

/**
 * The ocean plate's geometry: a 32 m grid scaled by 8, so its WORLD pitch is
 * 256 m and its march is one sample — which is what makes the budget on the
 * real island 5 x (73 + 7) = 400 rather than 730.
 */
const OCEAN_PARAMS = {
  terrainSize: 4096,
  terrainHeight: 1,
  baseResolution: 32,
  chunkSize: 256,
  randomOffset: 0,
  seed: 1,
} as unknown as FacetedTerrainParams

/**
 * Four islands as a sum of cones, clamped at 0. Closed form, so it is the same
 * surface on every machine; sloped, so a march sometimes stops early and
 * sometimes runs its whole length — which is the case the budget is a bound on.
 */
const islandMap = (): MapSampler =>
  ({
    width: 513,
    height: 513,
    sample(u: number, v: number, out: Rgb): Rgb {
      let g = 0
      for (const [cu, cv, r, h] of [
        [0.32, 0.28, 0.16, 0.85],
        [0.61, 0.44, 0.13, 0.62],
        [0.44, 0.71, 0.18, 0.74],
        [0.78, 0.8, 0.1, 0.5],
      ] as const) {
        const d = Math.hypot(u - cu, v - cv)
        if (d < r) g = Math.max(g, h * (1 - d / r))
      }
      out.r = g
      out.g = g
      out.b = g
      return out
    },
  }) as unknown as MapSampler

const flatMap = (): MapSampler =>
  ({
    width: 129,
    height: 129,
    sample(_u: number, _v: number, out: Rgb): Rgb {
      out.r = 0
      out.g = 0
      out.b = 0
      return out
    },
  }) as unknown as MapSampler

/** Built once: 513 x 513 samples of a closed form, not a file read. */
export const LAND: HeightField = buildHeightField(islandMap(), LAND_PARAMS, {
  position: [-2048, 0, -2048],
  scale: [1, 1, 1],
})
/** Centred on the origin at 8x scale, so it is under the whole course. */
export const OCEAN: HeightField = buildHeightField(flatMap(), OCEAN_PARAMS, {
  position: [-16384, 0, -16384],
  scale: [8, 1, 8],
})
export const FIELDS: readonly HeightField[] = [LAND, OCEAN]

/** The HoverJet's own hull, the way `game/flight.ts` builds it. */
export const HULL: HullSphere[] = hullFromColliders(
  HOVERJET.shipCollisionColliders as unknown as Parameters<typeof hullFromColliders>[0],
)

/** The course, in sim space, the way the loader builds it. */
export const gates = (): Gate[] => courseGates(LEVEL)

// ── the player ────────────────────────────────────────────────────────────

export interface Player {
  /** One fixed step of the player's half, in `app.ts`'s order. */
  readonly step: () => void
  /** Written by the fan every tick; `samples` is what a budget test counts. */
  readonly surface: SurfaceProximity
  readonly state: ReturnType<typeof startMission>
  readonly jet: ReturnType<typeof createHoverJet>
  /** Anything that came apart, with the sim time it came apart at. */
  readonly faults: string[]
}

export const makePlayer = (edition: Edition, course: readonly Gate[]): Player => {
  const jet = createHoverJet()
  jet.launched = true
  threeTupleToUnity(jet.body.position, LEVEL.spawn.pos as number[])
  threeQuatTupleToUnity(jet.body.orientation, LEVEL.spawn.quat as number[])
  jet.body.position.y += LEVEL.spawn.launch?.rise ?? 0

  const state = startMission(LEVEL)
  const input = noInput()
  const boundary = createBoundary()
  const spec: BoundarySpec | null = LEVEL.boundary.volume?.radius
    ? {
        enabled: LEVEL.boundary.enabled,
        centre: threeTupleToUnity({ x: 0, y: 0, z: 0 }, LEVEL.boundary.volume.centre as number[]),
        radius: LEVEL.boundary.volume.radius,
        resetDelaySeconds: LEVEL.boundary.resetDelay,
        fadeSeconds: LEVEL.boundary.resetFadeSeconds ?? 2.5,
      }
    : null
  const surface = createSurfaceProximity()
  const reach = edition.gameplay.proximity.farMetres
  const faults: string[] = []
  let lastScore = 0

  const step = (): void => {
    const target = nextGate(state.course.gates, state.course.passed)
    const gate = target >= 0 ? course[target] : undefined
    if (gate) {
      const after = course[target + 1]?.centre ?? null
      autopilotActions(jet.body, gate.centre, input, undefined, [], Number.POSITIVE_INFINITY, after)
    }
    stepHoverJet(jet, input)
    probeSurface(jet.body, FIELDS, HULL, reach, surface)
    const v = jet.body.velocity
    const speed = Math.hypot(v.x, v.y, v.z)
    const levers: MissionLevers = {
      clearance: surface.nearest,
      speed,
      struck: false,
      proximity: edition.gameplay.proximity,
      gateEvents: edition.gameplay.gateEvents,
    }
    const ring = stepMission(state, LEVEL, jet.body.position, FIXED_DT, levers)
    if (ring >= 0) chainGate(jet.chain)
    if (spec) stepBoundary(boundary, spec, jet.body.position, FIXED_DT)

    // Plain checks on the hot path, the way `smoke-missions.test.ts` does it:
    // 2,459 ticks x two presets x two phases is far too many for an `expect`
    // each, so a fault is collected and asserted once, naming when it happened.
    const p = jet.body.position
    const score = missionScore(state)
    const fault = !(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))
      ? `position ${p.x},${p.y},${p.z}`
      : !Number.isFinite(speed)
        ? `velocity ${speed}`
        : !Number.isFinite(state.elapsed)
          ? 'clock'
          : !Number.isFinite(score) || score < 0
            ? `score ${score}`
            : score < lastScore
              ? `score went DOWN (${lastScore} -> ${score})`
              : null
    if (fault) faults.push(`${edition.id} at ${state.elapsed.toFixed(2)} s: ${fault}`)
    lastScore = score
  }

  return { step, surface, state, jet, faults }
}

// ── the grid ──────────────────────────────────────────────────────────────

/**
 * The grid `game/racers.ts` would build for this preset, in SIM space —
 * `racer-grid.ts` resolving `gameplay.racers`, so the count is the preset's
 * (five on Anniversary, 2016's two pads on Classic) and never a number typed
 * into a test.
 */
export const gridFor = (edition: Edition, course: readonly Gate[]): AiRacer[] => {
  const starts = racerStarts(LEVEL, edition.gameplay.racers)
  const assigned = assignTunings(starts)
  return starts.map((start, i) => {
    const { id, tuning } = assigned[i] as { id: string; tuning: string }
    // The start is THREE space and the sim is that mirrored in z — `racers.ts`.
    const spawn = threeTupleToUnity({ x: 0, y: 0, z: 0 }, [
      start.pos[0],
      start.pos[1],
      start.pos[2],
    ])
    const q = { x: 0, y: 0, z: 0, w: 1 }
    threeQuatTupleToUnity(q, start.quat as unknown as number[])
    return createAiRacer(
      {
        id,
        spawn,
        orientation: [q.x, q.y, q.z, q.w],
        tuning: AI_RACER_TUNINGS[tuning] as (typeof AI_RACER_TUNINGS)[string],
      },
      course,
    )
  })
}

/**
 * Step the whole grid once, `ai-racer.test.ts`'s configuration: the course, no
 * terrain to avoid, no guide route, no crash spec, no prop colliders. The
 * CHEAPEST tick a racer has — see the header.
 */
export const stepGrid = (racers: readonly AiRacer[], course: readonly Gate[]): void => {
  for (const r of racers) stepAiRacer(r, course, [], FIXED_DT)
}
