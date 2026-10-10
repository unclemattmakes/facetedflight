// src/game/mission-shape.ts — the COURSE behind a level-select table.
//
// `render/diorama.ts` draws the real island at 1:6600 from the same height
// field the player will fly over. That is the best thing the hangar has, and it
// is why the level select shows a shape rather than a name: *"levels were
// presented as mini-dioramas of the actual level, with tiny jets flying around
// em."* (Matt) — and 2016 did it literally, `MissionSelector.cs:17-23`
// instantiating the level's own art prefab at 0.5 scale onto the table.
//
// `boot/app.ts` already assembles that tuple for the ONE mission it has loaded.
// Thirteen tables need it for thirteen, without loading thirteen worlds. This
// file is that: the height field, the racing line and the tour of the pads, for
// a mission that is not running — and, since DEV-354, the one pad a Target
// Practice FLIGHT PLAN stands (`missionPad`), which needs no height map at all.
//
// ── What it costs, measured ───────────────────────────────────────────────
//
// A mission's shape needs its environment's HEIGHT map and nothing else — no
// colour map, no chunk geometry, no worker, no material. That matters:
//
//   environment  height    colour      (colour is what `loadTerrain` also pulls)
//   simonet      195 KB     818 KB
//   desert       541 KB    2,462 KB
//   alpine       590 KB    2,424 KB
//   kauai        969 KB    6,752 KB
//
// Reaching for `loadTerrain(key, { visibleRadius: 0 })` would be four lines
// shorter and would fetch and decode **12.4 MB of colour map** to draw four
// 0.44 m models. So the height map is fetched directly and put through
// `buildHeightField`, which is the same call `loadTerrain` makes.
//
// **Trap: `importUnityTexture`, never `createMapSampler`.** Both Simonet maps
// are 1025x1025 with `nPOTScale: 1`, so Unity rescaled them to 1024 at import
// and the generator sampled THAT. Skipping it is worth up to 30 m of height
// inland, and a diorama built on the bare sampler would be a *different island*
// from the one the player flies — subtly, which is the expensive kind.
// (DEV-007.)
//
// ── The placement rule is duplicated, so it is guarded ────────────────────
//
// Where a terrain sits is `local + envRoot + worldOffset`, and that sum lives
// in `load-terrain.ts` behind a private `terrainEntry`. Nothing exports it, and
// this file may not edit that one — so the composition is written twice, which
// is precisely the drift the orientation lesson §5 warns about ("two constants
// that must stay equal should be the same object"; the ghosts flew backwards
// for a fortnight over exactly this).
//
// It cannot be the same object here, so it gets the other half of the deal: a
// test. `tests/unit/mission-shape.test.ts` asserts this placement reproduces
// the world positions that `terrain-env-root.test.ts` measured through a
// SECOND code path entirely — the scene flattener — for all four environments,
// including kauai, the one where the naive rule is wrong by 2.2 km. If
// `load-terrain.ts` ever grows an exported helper, delete the copy and keep the
// test.

import { assetUrl } from '@/content/asset-url'
import { paletteFor } from '@/content/holo-palette'
import type { Level, Pad, PadSolid } from '@/content/level-schema'
import { loadImageData } from '@/content/load-image'
import { loadLevel } from '@/content/load-level'
import { courseGates } from '@/game/mission'
import { type CollectibleKind, isLive, runningMode, scores } from '@/game/modes'
import { liveOrbs } from '@/game/orbs'
import {
  customGroundOf,
  customHeightSampler,
  customTerrainLocal,
  customTerrainParams,
  donorLand,
} from '@/game/terrain/custom-ground'
import {
  environmentTerrains,
  TERRAIN_SEED,
  terrainHeightPath,
  terrainParams,
} from '@/game/terrain/load-terrain'
import { TERRAIN } from '@/generated/constants.generated'
import { buildHeightField, type HeightField, terrainHeightAt } from '@/sim/terrain/height-field'
import type { MapSampler } from '@/sim/terrain/image-sampler'
import { importUnityTexture } from '@/sim/terrain/image-sampler'

/**
 * Everything one LEVEL table needs: the land, and the path its craft flies.
 *
 * ── The land, and no marks (DEV-354) ──────────────────────────────────────
 *
 * Until DEV-354 this carried the mission's objective as geometry — its gates,
 * its pads and their surfaces, its orbs — and the course tables drew it. Matt,
 * 2026-09-24: *"level select - show terrain diorama, no gates. (this was a
 * previous misunderstanding i think on both our counts)"*. The flight plan is
 * said once, on the step that asks for it (`render/mode-mark.ts`), so a level
 * table is the island and nothing marked on it. What is left of the objective
 * here is the one thing a table still USES: the pads, as the tour a JumpSeat
 * craft lobs between (DEV-313 #41c) — drawn as a path, never as targets.
 */
export interface MissionShape {
  readonly field: HeightField
  /**
   * The environment's colour map, thumbnailed to 64 x 64 for the tables, or null
   * when no palette is on disk for it (`content/holo-palette.ts`, DEV-140).
   */
  readonly palette: MapSampler | null
  /** THREE space, as the level stores it. Null where the mission has no route. */
  readonly route: readonly (readonly number[])[] | null
  /**
   * Jump-pad landing centres, THREE space: the tour the table's craft hops,
   * pad to pad. Non-empty only where the pads are the mission's objective —
   * see {@link missionTour}. Not drawn.
   */
  readonly pads: readonly (readonly number[])[]
  /**
   * DEV-579: the sea's surface over this island, SIM y, or null (or absent)
   * where the environment has no ocean: the diorama's waterline
   * ({@link missionSeaLevel}). Absent, the table takes the land field's
   * origin, which is right for alpine and the canyon and was wrong for the
   * two islands.
   */
  readonly seaLevel?: number | null
}

/** What a terrain's sheet entry carries about where it is. See the header. */
interface SheetTransform {
  readonly position?: readonly number[]
  readonly envRoot?: readonly number[]
  readonly scale?: readonly number[]
}
type Sheet = Record<
  string,
  { readonly terrains: Record<string, { readonly transform?: SheetTransform }> }
>

/**
 * A terrain's origin in SIM (Unity) space, and its scale.
 *
 * `worldOffset` arrives in THREE space straight from the level JSON, which is
 * why the z term subtracts rather than adds: the render group goes to
 * `wo.z - tp.z` and the sim is that mirrored, so the sim origin is
 * `tp.z - wo.z`. Leaving `wo` out entirely puts the collision surface 2 km from
 * the terrain you can see — `load-terrain.ts` says so, and this is the same
 * arithmetic.
 *
 * Exported for the guard described in the header. Nothing else should call it.
 */
export const terrainOriginSim = (
  terrainKey: string,
  worldOffsetThree: readonly number[],
): { position: [number, number, number]; scale: number[] } => {
  const [env, leaf] = terrainKey.split('.')
  const entry = env && leaf ? (TERRAIN as unknown as Sheet)[env]?.terrains?.[leaf] : undefined
  if (!entry) throw new Error(`mission-shape: unknown terrain "${terrainKey}"`)
  const local = entry.transform?.position ?? [0, 0, 0]
  const root = entry.transform?.envRoot ?? [0, 0, 0]
  const wo = worldOffsetThree
  return {
    position: [
      (wo[0] as number) + (local[0] as number) + (root[0] as number),
      (wo[1] as number) + (local[1] as number) + (root[1] as number),
      (local[2] as number) + (root[2] as number) - (wo[2] as number),
    ],
    scale: (entry.transform?.scale ?? [1, 1, 1]) as number[],
  }
}

/**
 * Where an environment's height map lives, read from the ASSET MANIFEST.
 *
 * `tools/assets/required-assets.json` is what `load-terrain.ts`'s own `MAP_PATHS`
 * says it mirrors — *"which is the source of truth for paths"* — and its ids
 * follow `terrain.<environment>.height`, keyed by exactly the string a level's
 * `environment` field carries. So reading it here means a fifth environment
 * costs this file nothing: it is added to the manifest (as it must be anyway)
 * and the picker finds it.
 *
 * **Imported dynamically on purpose.** The manifest is 27 KB, most of it
 * provenance prose, and none of it is needed to boot or to fly. A dynamic
 * import puts it in its own chunk that is fetched the first time somebody opens
 * a page of the level select, and never on the path to the first frame.
 */
let manifestPaths: Promise<Map<string, string>> | null = null
const heightPathFor = async (environment: string): Promise<string> => {
  manifestPaths ??= import('../../tools/assets/required-assets.json').then((m) => {
    const rows = (m.default as { assets: { id: string; path: string }[] }).assets
    return new Map(rows.map((a) => [a.id, a.path]))
  })
  const path = (await manifestPaths).get(`terrain.${environment}.height`)
  if (!path) {
    throw new Error(
      `mission-shape: no height map for environment "${environment}". ` +
        `Add "terrain.${environment}.height" to tools/assets/required-assets.json ` +
        'and the matching MAP_PATHS entry to src/game/terrain/load-terrain.ts.',
    )
  }
  return path
}

/**
 * The collision surface for a level's environment, cached.
 *
 * Keyed by environment AND `worldOffset`: every shipped mission uses
 * `(-2048, 0, 2048)`, so the key is one entry per environment today — but the
 * offset is per-LEVEL data and a cache that ignored it would hand a hand-
 * authored course somebody else's placement, which renders as gates floating
 * off the edge of the island and reads as an extraction bug.
 */
const fields = new Map<string, Promise<HeightField>>()

export const missionField = async (level: Level): Promise<HeightField> => {
  // DEV-489: a level over a PLAYER's ground is that ground's field — the one
  // the world build collides against: its heights through the raw float
  // sampler, its extent, centred on its island's land (`customTerrainLocal`
  // over the same composed origin this file builds below). Not cached: the
  // key is a ground, not an environment, and it is 0.1 s at 4 km.
  const ground = customGroundOf(level)
  if (ground) {
    const donor = terrainOriginSim(donorLand(ground.island).key, level.worldOffset)
    return buildHeightField(
      customHeightSampler(ground),
      customTerrainParams(ground, TERRAIN_SEED),
      {
        position: customTerrainLocal(ground, donor.position),
        scale: donor.scale,
      },
    )
  }
  const key = `${level.environment}|${level.worldOffset.join(',')}`
  const hit = fields.get(key)
  if (hit) return hit
  const built = (async () => {
    const land = environmentTerrains(level.environment).land
    const img = await loadImageData(assetUrl(await heightPathFor(level.environment)))
    // DEV-007: the IMPORTED texture, not the PNG on disk. See the header.
    const sampler = importUnityTexture(img)
    return buildHeightField(sampler, terrainParams(land), terrainOriginSim(land, level.worldOffset))
  })()
  fields.set(key, built)
  return built
}

/** Drop every cached field. For tests, and for a future "free the menu" pass. */
export const clearMissionFields = (): void => {
  fields.clear()
  seas.clear()
}

/**
 * A pad's LANDING centre, which is the plate you are aiming at.
 *
 * `pad.pos` is the prop's origin and sits ~21 m below the landing trigger on
 * `adv_01_jumpSeat`'s first pad; at 1:6600 that is 3 mm and invisible either
 * way, but the landing trigger is the thing the mission scores, so it is the
 * point the craft's hop comes down on. Falls back to the prop when a pad has no
 * landing trigger at all.
 */
const padCentre = (pad: Pad): readonly number[] =>
  (pad.landing?.pos as readonly number[] | undefined) ?? pad.pos

/**
 * The order the three collectible kinds are read in, whenever a table has to
 * pick ONE: {@link missionTour} picks a mission's objective with it, and
 * `render/mode-mark.ts`'s `modeMarkKind` picks a flight plan's mark with it.
 * One list, so the two cannot rank the kinds differently. A mode that ever
 * scored two kinds would be drawn as the first — rings are what a race is
 * about. No shipped mode scores more than one.
 */
export const OBJECTIVE_ORDER: readonly CollectibleKind[] = ['ring', 'padZone', 'orb']

/**
 * The path a LEVEL table's craft flies: the racing line, and the pads when the
 * pads are what the mission is about.
 *
 * Split from {@link missionShape} because it is pure, synchronous and the half
 * that carries a judgement — which of three collectible kinds this mission is
 * about. The terrain half is a PNG fetch and a resample; this half is a rule,
 * and a rule wants a test that runs in `environment: 'node'` without a network.
 *
 * It was `missionMarks` until DEV-354 and handed over the objective's gates,
 * pads and orbs for the table to DRAW. Nothing draws them now (see
 * {@link MissionShape}), so what it returns is what is still used: the pads as
 * a tour, which `render/diorama.ts` lobs a JumpSeat along (DEV-313 #41c).
 *
 * The ring count still decides, although no gate is returned: a Ring Attack
 * mission keeps `padZone` LIVE (`MODES.live`), so it is the ring count, read
 * through `courseGates` — the function the SIM uses, not a second walk of
 * `level.routes` — that keeps its craft on the racing line rather than hopping
 * pads it is not scored on.
 */
export const missionTour = (level: Level): Omit<MissionShape, 'field' | 'palette' | 'seaLevel'> => {
  // `route` was in every extracted level JSON and not on `Level`, and this read
  // it through a cast; DEV-466 typed it (`Level.route`).
  const route = level.route ?? null
  const mode = runningMode(level)
  const livePads = level.pads.filter((p: Pad) => p.live)
  const count: Record<CollectibleKind, number> = {
    ring: courseGates(level).length,
    padZone: livePads.length,
    orb: liveOrbs(level).length,
  }

  // ── the objective, or the next best landmark ────────────────────────────
  //
  // **Trap: a mode's objective can be EMPTY in a particular mission.**
  // `int_02_jumpSeat` was one until DEV-061: Free Flight with all twelve of its
  // `EnergyOrb`s `selfActive: false` — 2016's Free Flight is exploration and
  // ends from the menu, so a course with nothing to collect is a legal course.
  // So it falls back to whatever the mode keeps LIVE — for that mission, its
  // nine jump pads, which gave its craft a tour where there was otherwise
  // nothing to fly.
  //
  // Found by the sweep in `mission-shape.test.ts`, not by looking: twelve of
  // thirteen missions agreed with the simple rule, which is the shape the
  // agreement lesson warns about.
  const chosen =
    OBJECTIVE_ORDER.find((k) => scores(mode, k) && count[k] > 0) ??
    OBJECTIVE_ORDER.find((k) => isLive(mode, k) && count[k] > 0) ??
    null
  return {
    pads: chosen === 'padZone' ? livePads.map(padCentre) : [],
    route: route && route.length > 1 ? route : null,
  }
}

/** Load one mission's shape: the island, and the path its craft flies. */
export const missionShape = async (missionId: string): Promise<MissionShape> => {
  const level = await loadLevel(missionId)
  const field = await missionField(level)
  return {
    field,
    palette: paletteFor(level.environment),
    seaLevel: await missionSeaLevel(level),
    ...missionTour(level),
  }
}

/**
 * The sea's surface over an island: the median of the WATER field's height at
 * a grid of points across the land field's square, SIM y. DEV-579.
 *
 * ── Why a table needs it: the land's origin is not the sea ───────────────
 *
 * `render/diorama.ts` drew everything at or under the land field's origin as
 * sea, and that origin is the bottom of the height map, not the water. On
 * alpine and the canyon there is no water and the two agree. On Simonet the
 * origin is -81.7 m and the sea stands at 116.6, so **not one** of the 3,136
 * cells on the table was sea: 1,967 of them were seabed, drawn as land in the
 * seabed's dark colours, and DEV-140's holo lean had been painting them a
 * pale teal that passed for water. Kauai's origin is 68 m, under a 116.6 m
 * sea, so 252 of its cells were seabed too. Found when DEV-579 took the lean
 * away and Simonet's "sea" photographed dark green.
 *
 * A median and not a constant: `render/water.ts` says the surface is a sample
 * and never a number (DEV-064), and the water map does vary (from 114.5 by the
 * islands to 116.6 in open water). At 1:8000 a metre is a tenth of a
 * millimetre, so one number for the table is the miniature's own resolution.
 */
export const seaLevelOver = (land: HeightField, sea: HeightField, grid = 32): number => {
  const spanX = land.terrainSize * (land.scaleX || 1)
  const spanZ = land.terrainSize * (land.scaleZ || 1)
  const ys: number[] = []
  for (let j = 0; j < grid; j++) {
    for (let i = 0; i < grid; i++) {
      const x = land.originX + ((i + 0.5) * spanX) / grid
      const z = land.originZ + ((j + 0.5) * spanZ) / grid
      ys.push(terrainHeightAt(sea, x, z))
    }
  }
  ys.sort((a, b) => a - b)
  return ys[Math.floor(ys.length / 2)] as number
}

/** One sea level per environment and offset, as {@link missionField} caches its land. */
const seas = new Map<string, Promise<number | null>>()

/**
 * The waterline a level table draws at: {@link seaLevelOver} the environment's
 * OCEAN, or null where it has none (alpine, the canyon) or the level is over a
 * player's ground (DEV-489, whose sea is that ground's). Costs one fetch of the
 * water's height map, 25 KB, shared by both islands. A failed fetch is null,
 * so a table falls back to the land's origin rather than losing its island.
 */
export const missionSeaLevel = (level: Level): Promise<number | null> => {
  if (customGroundOf(level)) return Promise.resolve(null)
  const ocean = environmentTerrains(level.environment).ocean
  const path = ocean ? terrainHeightPath(ocean) : null
  if (!ocean || !path) return Promise.resolve(null)
  const key = `${level.environment}|${level.worldOffset.join(',')}`
  const hit = seas.get(key)
  if (hit) return hit
  const built = (async () => {
    try {
      const land = await missionField(level)
      const img = await loadImageData(assetUrl(path))
      // DEV-007: the IMPORTED texture, as the land's.
      const sea = buildHeightField(
        importUnityTexture(img),
        terrainParams(ocean),
        terrainOriginSim(ocean, level.worldOffset),
      )
      return seaLevelOver(land, sea)
    } catch (error: unknown) {
      console.warn(`mission-shape: no sea level for ${level.environment}`, error)
      return null
    }
  })()
  seas.set(key, built)
  return built
}

/**
 * The target a pad-scoring FLIGHT PLAN stands on its table (DEV-354): the first
 * live pad's own landing surface, or null where there is none.
 *
 * `render/mode-mark.ts` lathes it with `buildPadGeometry`, the function
 * `game/pad-art.ts` stands in the world, so the plan's one large target is the
 * pad you land on. Every one of the 49 live shipped pads is the same
 * `jumpPad_04_collider`, so WHICH live pad is a formality today — but a pad is
 * content, and a course that ever placed a different one would show it here
 * with no code change (hard rule 6).
 */
export const missionPad = (level: Level): PadSolid | null =>
  level.pads.find((p: Pad) => p.live && p.solid?.live)?.solid ?? null

/**
 * {@link missionPad} for a mission that is not loaded: its level JSON and
 * nothing else — no height map, which is the whole of what the flight-plan
 * step no longer costs.
 */
export const loadMissionPad = async (missionId: string): Promise<PadSolid | null> =>
  missionPad(await loadLevel(missionId))
