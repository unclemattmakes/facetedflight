// src/game/terrain/course-water.ts — a player course's water level, in the
// world. DEV-500.
//
// Matt chose a water level over river splines: one flat water surface at a
// height the creator chooses, on ANY base — a flooded canyon on the desert, a
// fjord in the alpine forest, a lake over Simonet's valleys.
//
// ── What water IS in this game, and so what this is ──────────────────────
//
// The sea is a SECOND FacetedTerrain (`render/water.ts`'s header): its own
// height map, a 262 km plate, the wave in the vertex shader, and — since 2016
// gave it a `TerrainCollider` — a collision surface the flight treats exactly
// as it treats the land (`game/flight.ts`: "terrain or water, whichever is
// higher"). It is a crash surface, not a visual. So a course's water is not a
// new kind of thing: it is THAT plate, lifted (or lowered) so its surface
// stands at the course's level, through the same `loadTerrain` call, the same
// material and the same collision. On a base with no sea (desert, alpine) the
// plate is borrowed from an island that has one; there is no sea-floor plate to
// leave out, because the shipped sea never had one — the land under the water
// IS the floor, and `render/coast.ts` already reads the land's height map for
// the shallows. Nothing here is new physics.
//
// ── The frame ────────────────────────────────────────────────────────────
//
// `PlayerCourseWater.level` is metres above the island's LAND floor — the mesh
// frame `islandWaterline` and DEV-490's `island.height` are in — so the
// validator can bound it from the sheet alone. `seaInLandFrame` is where a given
// plate's own surface stands in that frame; the lift is the difference.
//
// ── Shipped missions ─────────────────────────────────────────────────────
//
// A shipped level carries no water, so `oceanFor` returns its own ocean at lift
// 0, or null on desert and alpine, exactly as before. `tests/unit/course-water.test.ts`
// sweeps every shipped level for that.

import type { Level } from '@/content/level-schema'
import { type PlayerCourseWater, seaInLandFrame } from '@/content/player-course'
import { TERRAIN } from '@/generated/constants.generated'

const WATER = Symbol('course-water')
type Watered = Level & { [WATER]?: PlayerCourseWater }

/** The water a course's level carries (DEV-500), or null: every shipped level. */
export const courseWaterOf = (level: Level | null | undefined): PlayerCourseWater | null =>
  (level as Watered | null | undefined)?.[WATER] ?? null

/** `level` with `water` — a copy; null takes the water away. */
export const withCourseWater = (level: Level, water: PlayerCourseWater | null): Level => {
  const out = { ...level } as Watered
  if (water) out[WATER] = { level: water.level }
  else delete out[WATER]
  return out
}

/**
 * The island whose sea plate a base with none borrows: the first, by name, of
 * the sheet's islands that has an `ocean`. Derived, so a sheet with another sea
 * island changes it without an edit here; Simonet and kauai wear the same ocean
 * files today, so either is the same water.
 */
const hasSea = (island: string): boolean => {
  const sheet = TERRAIN as unknown as Record<string, { terrains: Record<string, unknown> }>
  return Object.hasOwn(sheet, island) && Object.hasOwn(sheet[island]?.terrains ?? {}, 'ocean')
}

export const borrowedSeaIsland = (): string => {
  const sea = Object.keys(TERRAIN).filter(hasSea).sort()[0]
  if (!sea) throw new Error('the sheet has no island with a sea')
  return sea
}

/**
 * The sea plate `level` draws and how far it is lifted, metres: its own at 0
 * on a shipped level; moved to the course's water; borrowed where the base has
 * none. Null: no water at all (desert and alpine, as shipped).
 */
export const oceanFor = (level: Level): { readonly key: string; readonly lift: number } | null => {
  // `load-terrain.ts`'s `environmentTerrains` asks the sheet the same question;
  // asked here from the sheet directly so this file stays free of the renderer.
  const own = hasSea(level.environment)
  const water = courseWaterOf(level)
  if (!water) return own ? { key: `${level.environment}.ocean`, lift: 0 } : null
  const sea = own ? level.environment : borrowedSeaIsland()
  return {
    key: `${sea}.ocean`,
    lift: water.level - seaInLandFrame(sea, level.environment),
  }
}

/**
 * DEV-500: the course's water in the LEVEL's world frame (three y), where its
 * points and pad are: the land floor under the level's `worldOffset`, plus the
 * level. What the editor's ground checks stand the water at.
 */
export const waterWorldY = (level: Level, water: PlayerCourseWater): number =>
  (level.worldOffset[1] as number) + landFloorY(level.environment) + water.level

/** The land's mesh floor above the LevelArt root, metres (local plus env root). */
const landFloorY = (island: string): number => {
  const sheet = TERRAIN as unknown as Record<
    string,
    {
      terrains: Record<
        string,
        { transform?: { position?: readonly number[]; envRoot?: readonly number[] } }
      >
    }
  >
  const env = sheet[island]
  const name = env ? Object.keys(env.terrains).find((n) => n !== 'ocean') : undefined
  const t = name ? env?.terrains[name] : undefined
  return (t?.transform?.position?.[1] ?? 0) + (t?.transform?.envRoot?.[1] ?? 0)
}
