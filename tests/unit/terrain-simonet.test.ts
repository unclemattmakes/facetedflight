// tests/unit/terrain-simonet.test.ts — the generator against the REAL 2016 data.
//
// The structural tests in terrain-faceted.test.ts prove the algorithm behaves.
// This one proves it survives contact with the actual World Machine maps and
// the actual shipped parameters, which is a different question: bilinear
// sampling at 1025 px into a 513-vertex grid, a V axis that must be flipped,
// and a height scale that turns a mean grey of 34/255 into real metres.
//
// SKIPS when the legacy Unity project is not mounted — CI runners do not have
// it, and a test that silently passes because its input is missing is worse
// than no test. The skip is loud.
//
// ── NOT load-bearing. Read this before trusting it. ───────────────────────
//
// The chunk (0,0) comparison below agreed with the 2016 bake to 4 mm of mean
// height while two real sampler bugs were live (DEV-007). Chunk (0,0) is open
// sea, sits at u,v ~ 0.03, and is on the grid diagonal, which makes it blind to
// an error proportional to u, to an import-time rescale, and to a transposed
// chunk index — all three of which we then found.
//
// This file is kept as a fast, readable smoke test on real data. The actual
// verification is `terrain-oracle-sweep.test.ts`, which walks all 256 chunks.
// Do not add a new fidelity claim here; add it there.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TERRAIN } from '@/generated/constants.generated'
import {
  buildVertexGrid,
  chunkPerSide,
  type FacetedTerrainParams,
  generateChunk,
} from '@/sim/terrain/faceted'
import { importUnityTexture } from '@/sim/terrain/image-sampler'
import { legacyRootOrAbsent } from '../../tools/legacy-root.mjs'
import { decodePng } from '../../tools/terrain/png.mjs'

const LEGACY = legacyRootOrAbsent()

/**
 * Simonet Islands, from the generated sheet — the `FacetedTerrain` component on
 * `Prefabs/Levels/LevelArt_SimonetIslands.prefab`. `terrains.islands` is the
 * 4 km island group; `terrains.ocean` is the separate 32 km ocean plate on the
 * same prefab. Reading the wrong one gives a world 8x too large in 4x coarser
 * chunks, so the key does the choosing rather than an index.
 *
 * Every field below except `seed` carries its prefab, fileID and line in
 * PROVENANCE. `seed` is not a 2016 quantity at all: Unity's `Random` is not
 * portable, so FF2 jitters with its own PRNG (DEV-006) and the 2016 vertex
 * displacements are unreachable by construction. `randomOffset` bounds the
 * disagreement; the seed only has to be fixed.
 */
const ISLANDS = TERRAIN.simonet.terrains.islands

const SIMONET: FacetedTerrainParams = {
  terrainSize: ISLANDS.terrainSize,
  terrainHeight: ISLANDS.terrainHeight,
  chunkSize: ISLANDS.chunkSize,
  baseResolution: ISLANDS.baseResolution,
  randomOffset: ISLANDS.randomOffset,
  seed: 20160101,
}

// The maps come from the sheet too — the guids on the component, resolved to
// asset paths by the extractor's guid index.
const heightMapFile = path.join(LEGACY, ISLANDS.sourceHeightMap)
const colorMapFile = path.join(LEGACY, ISLANDS.sourceColorMap)
const available = fs.existsSync(heightMapFile)

// `importUnityTexture` is the SHIPPED path, from src/sim/ — not a test helper.
// The browser hands the same function pixels out of a canvas. If this harness
// filtered them its own way, the oracle numbers below would certify code the
// game does not run.
//
// It must be `importUnityTexture` and not the bare `createMapSampler`: both
// Simonet maps are 1025x1025 with `nPOTScale: 1`, so Unity resamples them to
// 1024 before the generator ever sees them. Skipping that is worth up to 30 m
// of height inland and exactly nothing in chunk (0,0).
const load = () => ({
  height: importUnityTexture(decodePng(heightMapFile)),
  color: importUnityTexture(decodePng(colorMapFile)),
})

describe('Simonet Islands — the parameters come from the generated sheet', () => {
  it('reads the island group, not the ocean plate that shares the prefab', () => {
    expect(ISLANDS.key).toBe('simonet.islands')
    expect(ISLANDS.sourceHeightMap).toContain('islandgroup_height.png')
    expect(TERRAIN.simonet.terrains.ocean.terrainSize).toBe(32768)
    expect(ISLANDS.terrainSize).toBe(4096)
    expect(TERRAIN.simonet.origin).toBe('shipped-prefab')
  })
})

describe.skipIf(!available)('Simonet Islands — real 2016 data through the generator', () => {
  it('rescales the 1025 px maps to 1024 the way the Unity importer does', () => {
    // Authored at 1025 on disk...
    expect(decodePng(heightMapFile).width).toBe(1025)
    expect(decodePng(colorMapFile).width).toBe(1025)
    // ...and sampled at 1024, because `nPOTScale: 1` is on both .meta files.
    const { height, color } = load()
    expect(height.width).toBe(1024)
    expect(height.height).toBe(1024)
    expect(color.width).toBe(1024)
  })

  it('builds a 513-vertex grid — 4096 m at 8 m per quad', () => {
    const { height } = load()
    const grid = buildVertexGrid(height, SIMONET)
    expect(grid.vertPerSide).toBe(513)
    expect(grid.verts.length).toBe(513 * 513 * 3)
  })

  it('produces island terrain: a low sea-level plain with peaks above it', () => {
    const { height } = load()
    const grid = buildVertexGrid(height, SIMONET)

    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    let sum = 0
    let n = 0
    for (let i = 1; i < grid.verts.length; i += 3) {
      const y = grid.verts[i] as number
      if (y < min) min = y
      if (y > max) max = y
      sum += y
      n++
    }
    const mean = sum / n

    // The map's darkest pixel is 10/255 and its brightest 181/255, scaled by
    // terrainHeight. Allow the jitter radius either side.
    expect(min).toBeGreaterThan((10 / 255) * SIMONET.terrainHeight - SIMONET.randomOffset - 1)
    expect(max).toBeLessThan((181 / 255) * SIMONET.terrainHeight + SIMONET.randomOffset + 1)
    // Peaks well above the plain: this is an island group, not a flat plate.
    expect(max - min).toBeGreaterThan(500)
    // And most of it is low — ocean floor dominates the map.
    expect(mean).toBeLessThan(min + (max - min) * 0.4)
  })

  it('lays out 16 x 16 chunks of 2312 triangles each', () => {
    // FacetedTerrain.cs computes both of these itself (ChunkPerSide, and
    // quadPerChunk inside HeightmapInfo); the extractor emits them alongside
    // the fields they come from. So this checks the port's arithmetic against
    // Unity's rather than against a number typed twice.
    expect(chunkPerSide(SIMONET)).toBe(ISLANDS.chunkPerSide)
    expect(ISLANDS.chunkPerSide).toBe(16)

    const { height, color } = load()
    const grid = buildVertexGrid(height, SIMONET)
    const chunk = generateChunk(grid, color, height, SIMONET, 8, 8)

    const quadPerChunk = ISLANDS.quadPerChunk // 32
    expect(chunk.triangleCount).toBe((quadPerChunk + 2) * (quadPerChunk + 2) * 2)
    expect(chunk.triangleCount).toBe(2312)
  })

  it('places each chunk in its own quarter of the world', () => {
    const { height, color } = load()
    const grid = buildVertexGrid(height, SIMONET)
    const last = ISLANDS.chunkPerSide - 1 // 15
    const a = generateChunk(grid, color, height, SIMONET, 0, 0)
    const b = generateChunk(grid, color, height, SIMONET, last, last)

    const xOf = (c: typeof a) => {
      let min = Number.POSITIVE_INFINITY
      for (let i = 0; i < c.positions.length; i += 3) {
        const x = c.positions[i] as number
        if (x < min) min = x
      }
      return min
    }
    // Chunk (0,0) starts at the origin; the last chunk starts 15 * 256 m away.
    expect(xOf(a)).toBeLessThan(10)
    expect(xOf(b)).toBeGreaterThan(last * SIMONET.chunkSize - 10)
  })

  // Where the land is, measured rather than guessed: sweeping the height map
  // over the 16x16 chunk grid shows peaks up to ~1011 m, with a low, flat
  // water gap around the middle. Chunk (9,13) is the highest; chunk (8,8)
  // sits in the gap. Both are useful, for opposite reasons.
  const LAND_CHUNK = [9, 13] as const
  const WATER_CHUNK = [8, 8] as const

  const facetColours = (cx: number, cy: number) => {
    const { height, color } = load()
    const grid = buildVertexGrid(height, SIMONET)
    const chunk = generateChunk(grid, color, height, SIMONET, cx, cy)
    const seen = new Set<string>()
    for (let i = 0; i < chunk.triangleCount; i++) {
      const b = i * 9
      const r = chunk.colors[b] as number
      const g = chunk.colors[b + 1] as number
      const bl = chunk.colors[b + 2] as number
      expect(r).toBeGreaterThanOrEqual(0)
      expect(r).toBeLessThanOrEqual(1)
      seen.add(`${r.toFixed(3)},${g.toFixed(3)},${bl.toFixed(3)}`)
    }
    return { seen, chunk }
  }

  it('gives a land chunk many distinct facet colours', () => {
    const { seen } = facetColours(...LAND_CHUNK)
    // Terrain colour comes from the map, per face. Over an island with cliffs
    // and beaches that must produce a lot of distinct facets.
    expect(seen.size).toBeGreaterThan(100)
  })

  it('gives an open-water chunk a single flat colour — and that is correct', () => {
    // Chunk (8,8) is the water gap in the middle of the island group. The
    // colour map is genuinely uniform there, so one colour across all 2312
    // triangles is the RIGHT answer, not a sampling bug. Pinning it here so a
    // future change that accidentally makes water noisy gets caught.
    const { seen, chunk } = facetColours(...WATER_CHUNK)
    expect(seen.size).toBe(1)
    expect(chunk.triangleCount).toBe(2312)
  })

  // ── The oracle ───────────────────────────────────────────────────────────
  // Measured from the 2016 bake itself, not from expectation. Chunk (0,0) of
  // `LevelArt_SimonetIslands/terrain_simonetIslands_FacetedChunks.asset`,
  // decoded with `tools/terrain/extract-2016-chunk.py` (UnityPy; the bake is
  // Unity's binary serialisation, not the ForceText YAML the rest of the
  // project uses).
  //
  // Vertex POSITIONS can never match: the jitter comes from a different PRNG
  // (DEV-006), so every vertex is displaced by up to randomOffset = 1.3 m by
  // construction. What must match is everything the jitter cannot explain —
  // counts, structure, and aggregate height.
  const ORACLE_CHUNK_00 = {
    vertexCount: 6936,
    skirtVerticesAtZeroY: 402,
    x: [-0.94, 257.13],
    y: [0.0, 61.51],
    z: [-1.21, 257.08],
    yMean: 56.74,
  } as const

  it('matches the 2016 bake of chunk (0,0)', () => {
    const { height, color } = load()
    const chunk = generateChunk(buildVertexGrid(height, SIMONET), color, height, SIMONET, 0, 0)

    let yMin = Number.POSITIVE_INFINITY
    let yMax = Number.NEGATIVE_INFINITY
    let xMin = Number.POSITIVE_INFINITY
    let xMax = Number.NEGATIVE_INFINITY
    let ySum = 0
    let zeroY = 0
    const n = chunk.positions.length / 3
    for (let i = 0; i < chunk.positions.length; i += 3) {
      const x = chunk.positions[i] as number
      const y = chunk.positions[i + 1] as number
      if (x < xMin) xMin = x
      if (x > xMax) xMax = x
      if (y < yMin) yMin = y
      if (y > yMax) yMax = y
      ySum += y
      if (y === 0) zeroY++
    }

    // Exact: structure is not affected by jitter.
    expect(n).toBe(ORACLE_CHUNK_00.vertexCount)
    expect(zeroY).toBe(ORACLE_CHUNK_00.skirtVerticesAtZeroY)

    // The skirt is a zero-width wall at the chunk edge, so the chunk spans
    // 0..256 plus jitter — NOT 0..264. An outward flange fails here.
    expect(xMin).toBeGreaterThan(-SIMONET.randomOffset - 0.01)
    expect(xMax).toBeLessThan(SIMONET.chunkSize + SIMONET.randomOffset + 0.01)
    expect(Math.abs(xMin - ORACLE_CHUNK_00.x[0])).toBeLessThan(SIMONET.randomOffset)
    expect(Math.abs(xMax - ORACLE_CHUNK_00.x[1])).toBeLessThan(SIMONET.randomOffset)

    // Height: the strongest signal available. Peak within a jitter radius, and
    // the MEAN within centimetres — the jitter is zero-mean, so a systematic
    // error in sampling, V-flip or height scale would show up here immediately.
    expect(yMin).toBe(0)
    expect(Math.abs(yMax - ORACLE_CHUNK_00.y[1])).toBeLessThan(SIMONET.randomOffset)
    expect(Math.abs(ySum / n - ORACLE_CHUNK_00.yMean)).toBeLessThan(0.05)
  })

  it('matches the 2016 bake on every LOD level', () => {
    // Counted from the bake itself with tools/terrain/extract-2016-chunk.py:
    // the Simonet chunk asset holds exactly three mesh sizes, 256 of each —
    // one per chunk in the 16x16 grid, at three levels of detail.
    const ORACLE_LOD_VERTS = [6936, 1944, 600] as const

    const { height, color } = load()
    const grid = buildVertexGrid(height, SIMONET)
    for (let lod = 0; lod < ORACLE_LOD_VERTS.length; lod++) {
      const chunk = generateChunk(grid, color, height, SIMONET, 3, 4, lod)
      expect(chunk.positions.length / 3).toBe(ORACLE_LOD_VERTS[lod])
    }
    // And the level count itself is what the component asks for.
    expect(ISLANDS.lodLevels).toBe(ORACLE_LOD_VERTS.length)
  })

  it('is deterministic on the real data too', () => {
    const { height, color } = load()
    const one = generateChunk(buildVertexGrid(height, SIMONET), color, height, SIMONET, 4, 7)
    const two = generateChunk(buildVertexGrid(height, SIMONET), color, height, SIMONET, 4, 7)
    expect(Array.from(one.positions)).toEqual(Array.from(two.positions))
  })
})

describe.skipIf(available)('Simonet Islands — legacy project not mounted', () => {
  it('is skipped loudly rather than passing vacuously', () => {
    // Reaching here means the real-data suite above did not run. That is fine
    // on CI and NOT fine locally; the message is the point.
    expect(available).toBe(false)
  })
})
