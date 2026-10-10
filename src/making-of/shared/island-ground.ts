// src/making-of/shared/island-ground.ts: a seeded island, built with the game's
// own terrain functions. DEV-514 (docs/plan/MAKING-OF.md §2.6).
//
// "Synthetic ground, no assets": the game's `synthesiseIsland` gives a height
// grid for a 4 km island, `createGreySampler` wraps it as the map a terrain is
// made from, and `buildVertexGrid` and `buildHeightField` build the two
// surfaces the game builds from a map, the one you SEE and the one you HIT. A
// toy draws a 512 m window of that island around its summit, so it can show
// every facet; the game's tiles are the same function on a larger piece.

import { buildVertexGrid, type FacetedTerrainParams } from '@/sim/terrain/faceted'
import { buildHeightField, type HeightField } from '@/sim/terrain/height-field'
import { createGreySampler, type MapSampler } from '@/sim/terrain/image-sampler'
import { ISLAND_SYNTH_VERSION, synthesiseIsland } from '@/sim/terrain/island-synth'

export interface IslandGroundOptions {
  readonly seed: number
  /** 0 smooth downs .. 1 knife ridges (the editor's own slider). */
  readonly rugged: number
  /** Vertex jitter radius, metres. */
  readonly randomOffset: number
  /** Metres per quad. Read from the constants sheet by the caller. */
  readonly baseResolution: number
  /** Whether the 2016 diagonal-choice bug is reproduced (the game's default). */
  readonly faithfulDiagonalBug: boolean
  /** Window width, metres (default `TILE`). */
  readonly tile?: number
}

export interface IslandGround {
  readonly params: FacetedTerrainParams
  readonly heightMap: MapSampler
  /** The surface you SEE: the grid with the jitter. */
  readonly grid: { verts: Float32Array; vertPerSide: number }
  /** The surface you HIT: the grid without it. */
  readonly field: HeightField
}

/** The toy's world is one 512 m window; the island it is cut from is 4 km across. */
export const TILE = 512
const ISLAND = 4096
const SUMMIT = 300
/** One sample every 8 m across the whole island. */
const EDGE = ISLAND / 8 + 1

interface Synth {
  readonly full: MapSampler
  /** The summit, as 0..1 of the island. */
  readonly peakU: number
  readonly peakV: number
}

const synthCache = new Map<string, Synth>()

const synth = (seed: number, rugged: number): Synth => {
  const key = `${seed}:${rugged}`
  const hit = synthCache.get(key)
  if (hit) return hit
  const e = synthesiseIsland(
    seed,
    { size: ISLAND, height: SUMMIT, rugged, sea: 0.35 },
    EDGE,
    ISLAND_SYNTH_VERSION,
  )
  // Elevation is -1..1 with 0 the waterline; the map wants 0..1.
  const data = new Float32Array(e.length)
  let best = 0
  for (let i = 0; i < e.length; i++) {
    data[i] = Math.max(0, e[i] as number)
    if ((data[i] as number) > (data[best] as number)) best = i
  }
  const made: Synth = {
    full: createGreySampler({ width: EDGE, height: EDGE, data }),
    peakU: (best % EDGE) / (EDGE - 1),
    peakV: Math.floor(best / EDGE) / (EDGE - 1),
  }
  if (synthCache.size > 6) synthCache.clear()
  synthCache.set(key, made)
  return made
}

export const makeIslandGround = (o: IslandGroundOptions): IslandGround => {
  const { full, peakU, peakV } = synth(o.seed, o.rugged)
  const tile = o.tile ?? TILE
  const span = tile / ISLAND
  const u0 = Math.min(1 - span, Math.max(0, peakU - span / 2))
  const v0 = Math.min(1 - span, Math.max(0, peakV - span / 2))
  const edge = tile / o.baseResolution + 1
  const heightMap: MapSampler = {
    width: edge,
    height: edge,
    sample: (u, v, out) => full.sample(u0 + u * span, v0 + v * span, out),
  }
  const params: FacetedTerrainParams = {
    terrainSize: tile,
    terrainHeight: SUMMIT,
    chunkSize: tile / 2,
    baseResolution: o.baseResolution,
    randomOffset: o.randomOffset,
    seed: o.seed,
    faithfulDiagonalBug: o.faithfulDiagonalBug,
  }
  return {
    params,
    heightMap,
    grid: buildVertexGrid(heightMap, params),
    field: buildHeightField(heightMap, params, { position: [0, 0, 0], scale: [1, 1, 1] }),
  }
}

/** The whole 4 km island, not a window: what the fly-over draws chunk by chunk. */
export interface WholeIsland {
  readonly params: FacetedTerrainParams
  readonly heightMap: MapSampler
  readonly grid: { verts: Float32Array; vertPerSide: number }
  /** Chunks per side at `params.chunkSize`. */
  readonly chunksPerSide: number
}

export const makeWholeIsland = (
  seed: number,
  rugged: number,
  baseResolution: number,
  randomOffset: number,
): WholeIsland => {
  const { full } = synth(seed, rugged)
  const params: FacetedTerrainParams = {
    terrainSize: ISLAND,
    terrainHeight: SUMMIT,
    chunkSize: 256,
    baseResolution,
    randomOffset,
    seed,
    faithfulDiagonalBug: true,
  }
  return {
    params,
    heightMap: full,
    grid: buildVertexGrid(full, params),
    chunksPerSide: ISLAND / params.chunkSize,
  }
}

/** The constants sheet's numbers for Simonet's islands, loaded when a toy mounts (it is large). */
export interface SimonetTerrain {
  readonly baseResolution: number
  readonly randomOffset: number
}

export const loadSimonetTerrain = async (): Promise<SimonetTerrain> => {
  const sheet = (await import('../../generated/constants.generated.json')).default as unknown as {
    terrain: { simonet: { terrains: { islands: SimonetTerrain } } }
  }
  const t = sheet.terrain.simonet.terrains.islands
  return { baseResolution: Number(t.baseResolution), randomOffset: Number(t.randomOffset) }
}
