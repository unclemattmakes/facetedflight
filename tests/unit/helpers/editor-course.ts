// tests/unit/helpers/editor-course.ts — the editor tests' shared course and
// ground. NOT a `.test.ts`, so vitest does not collect it.
//
// `fittedCourse()` is DEV-468's fixture, moved here from
// `editor-core.test.ts` when DEV-478's `editor-lift.test.ts` needed the same
// line: a valid course along 2016's own `int_01` route, finishing at 2016's
// gate. `islandGround(level)` is the RENDER surface of a sky's island, built
// the way the desk builds it (`desk/ground.ts`'s `deskGround`, handed a
// terrain shaped as `load-terrain.ts` leaves one) from the real height maps —
// gitignored assets, so `haveMaps` (terrain-field.ts) gates every caller.

import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import type { Level } from '@/content/level-schema'
import type { Ground } from '@/editor/core'
import { deskGround } from '@/editor/desk/ground'
import { terrainOriginSim } from '@/game/mission-shape'
import {
  type CustomGround,
  customGroundOf,
  customHeightSampler,
  customTerrainLocal,
  customTerrainParams,
  donorLand,
} from '@/game/terrain/custom-ground'
import {
  environmentTerrains,
  highWaterOf,
  type LoadedTerrain,
  TERRAIN_SEED,
  terrainParams,
} from '@/game/terrain/load-terrain'
import { TERRAIN } from '@/generated/constants.generated'
import type { WaterDisplace } from '@/render/water'
import { buildVertexGrid } from '@/sim/terrain/faceted'
import { type ImageData8, importUnityTexture } from '@/sim/terrain/image-sampler'
import { decodePngBuffer } from '../../../tools/terrain/png.mjs'
import { MAPS, OCEAN_MAPS } from './terrain-field'

const REPO = path.resolve(__dirname, '..', '..', '..')

export { shippedLevels } from './content'

export { fittedCourse } from './fitted-course'

/**
 * A terrain as `load-terrain.ts` leaves one, for `deskGround`: the group at
 * the terrain's own transform (`terrainOriginSim`, mirrored into three as the
 * loader mirrors it), the LOD-0 vertex grid and the imported height map.
 */
const terrainFrom = (key: string, map: string, worldOffset: readonly number[]): LoadedTerrain => {
  const img = decodePngBuffer(fs.readFileSync(path.join(REPO, map)), key) as ImageData8
  const height = importUnityTexture(img)
  const params = terrainParams(key)
  const o = terrainOriginSim(key, worldOffset)
  const group = new THREE.Group()
  group.position.set(o.position[0], o.position[1], -o.position[2])
  group.scale.set(o.scale[0] as number, o.scale[1] as number, o.scale[2] as number)
  group.updateWorldMatrix(true, false)
  const { displace, bobOrigin } = plateWave(key)
  return {
    group,
    params,
    heightMap: height,
    surfaceGrid: buildVertexGrid(height, params),
    restY: group.position.y,
    // DEV-501 follow-up: a sea plate's high-water mark, as `load-terrain.ts` sets it.
    highWater: highWaterOf(displace, bobOrigin),
  } as unknown as LoadedTerrain
}

/**
 * DEV-501 follow-up: a terrain's live wave (null: land, or a frozen sea) and
 * the point its whole-plate bob is evaluated at — the plate's own Unity-space
 * transform position, as `load-terrain.ts` hands `setWaveTime`'s `bobAt`.
 */
export const plateWave = (
  key: string,
): { readonly displace: WaterDisplace | null; readonly bobOrigin: readonly number[] } => {
  const [env, leaf] = key.split('.') as [string, string]
  const entry = (
    TERRAIN as unknown as Record<
      string,
      {
        terrains: Record<
          string,
          {
            displace?: (WaterDisplace & { live?: boolean }) | null
            transform?: { position?: number[]; envRoot?: number[] }
          }
        >
      }
    >
  )[env]?.terrains[leaf]
  const lp = entry?.transform?.position ?? [0, 0, 0]
  const er = entry?.transform?.envRoot ?? [0, 0, 0]
  return {
    displace: entry?.displace?.live ? entry.displace : null,
    bobOrigin: [0, 1, 2].map((i) => (lp[i] as number) + (er[i] as number)),
  }
}

/**
 * DEV-501 follow-up: a PLAYER's island (`customGroundOf(level)`, a seeded or
 * imported ground) as a terrain, built as `load-terrain.ts` builds one: its
 * raw float sampler, `customTerrainParams`, and its corner centred on the
 * donor's land (`customTerrainLocal`) over the donor's composed origin.
 */
const customTerrainFrom = (ground: CustomGround, worldOffset: readonly number[]): LoadedTerrain => {
  const height = customHeightSampler(ground)
  const params = customTerrainParams(ground, TERRAIN_SEED)
  const donor = terrainOriginSim(donorLand(ground.island).key, worldOffset)
  const pos = customTerrainLocal(ground, donor.position)
  const group = new THREE.Group()
  group.position.set(pos[0], pos[1], -pos[2])
  group.scale.set(donor.scale[0] as number, donor.scale[1] as number, donor.scale[2] as number)
  group.updateWorldMatrix(true, false)
  return {
    group,
    params,
    heightMap: height,
    surfaceGrid: buildVertexGrid(height, params),
  } as unknown as LoadedTerrain
}

const grounds = new Map<string, Ground>()

/** The render surface a sky's island shows, land and sea, in the level frame. */
export const islandGround = (level: Level): Ground => {
  // A player's own island is not cached: its key is a ground, not an environment.
  const custom = customGroundOf(level)
  const key = `${level.environment}|${level.worldOffset.join(',')}`
  const hit = custom ? undefined : grounds.get(key)
  if (hit) return hit
  const t = environmentTerrains(level.environment)
  const land = custom
    ? customTerrainFrom(custom, level.worldOffset)
    : terrainFrom(t.land, MAPS[level.environment] as string, level.worldOffset)
  const ocean = islandSea(level)
  const g = deskGround({ land, ocean } as Parameters<typeof deskGround>[0])
  if (!custom) grounds.set(key, g)
  return g
}

const seas = new Map<string, LoadedTerrain | null>()

/** DEV-501 follow-up: a sky's sea plate as `islandGround` builds it, or null with none. */
export const islandSea = (level: Level): LoadedTerrain | null => {
  const key = `${level.environment}|${level.worldOffset.join(',')}`
  if (seas.has(key)) return seas.get(key) ?? null
  const t = environmentTerrains(level.environment)
  const oceanMap = OCEAN_MAPS[level.environment]
  const ocean = t.ocean && oceanMap ? terrainFrom(t.ocean, oceanMap, level.worldOffset) : null
  seas.set(key, ocean)
  return ocean
}
