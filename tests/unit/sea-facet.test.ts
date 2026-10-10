// tests/unit/sea-facet.test.ts — a boat's sea triangle IS one the renderer draws.
//
// DEV-447. `seaFacetAt` claims to rebuild, bit for bit, the triangle of the
// SUBDIVIDED, INTERIOR-JITTERED ocean mesh under a point. The only honest oracle
// for that is the mesh: `generateChunk`, then `subdivideTriangleSoup` — the two
// functions the terrain worker finishes an ocean chunk with — searched by brute
// force for the triangle whose nine floats equal the answer, in order.
//
// Equality, not closeness, and that is the point: the soup's interior jitter is
// a `sin(...) * 43758` hash of a FLOAT32 position, so a rebuild that is one ulp
// out lands on a different offset entirely and the triangle simply is not in
// the soup. A "close enough" tolerance would pass that bug.
//
// Ocean-shaped numbers: a 32 m grid, the plates' 2 m `randomOffset`, split 8x8
// — Anniversary's and Classic's LOD 0 rung — over a low-relief map.

import { describe, expect, it } from 'vitest'
import { planWeights, seaFacetAt } from '@/sim/life/sea-facet'
import { subdivideTriangleSoup } from '@/sim/terrain/chunk-to-three'
import {
  buildVertexGrid,
  type FacetedTerrainParams,
  generateChunk,
  type MapSampler,
} from '@/sim/terrain/faceted'
import type { Rgb } from '@/sim/terrain/image-sampler'
import { renderFacetAt } from '@/sim/terrain/surface'
import { lcg } from './helpers/seeded'

const swell = (u: number, v: number): number =>
  0.5 + 0.02 * Math.sin(u * 19.3 + 0.7) * Math.cos(v * 13.1 - 0.2) + 0.01 * Math.sin((u - v) * 37)

const map = (f: (u: number, v: number) => number): MapSampler =>
  ({
    width: 64,
    height: 64,
    sample(u: number, v: number, out: Rgb): Rgb {
      const g = Math.min(1, Math.max(0, f(u, v)))
      out.r = g
      out.g = g
      out.b = g
      return out
    },
  }) as unknown as MapSampler

const PARAMS: FacetedTerrainParams = {
  terrainSize: 1024,
  terrainHeight: 200,
  chunkSize: 256,
  baseResolution: 32,
  randomOffset: 2,
  seed: 20161027,
}
const SPLIT = 8

const heightMap = map(swell)
const colorMap = map(() => 0.5)
const grid = buildVertexGrid(heightMap, PARAMS)

/** The drawn triangle list of chunk (cx, cz), as the worker finishes it before the flip. */
const soupOf = (cx: number, cz: number): Float32Array =>
  subdivideTriangleSoup(
    generateChunk(grid, colorMap, heightMap, PARAMS, cx, cz, 0),
    SPLIT,
    PARAMS.randomOffset,
  ).positions

/** Index of the soup triangle whose nine floats equal `t`, in order, or -1. */
const findExact = (soup: Float32Array, t: Float64Array): number => {
  for (let f = 0; f < soup.length; f += 9) {
    let same = true
    for (let k = 0; k < 9 && same; k++) same = soup[f + k] === t[k]
    if (same) return f / 9
  }
  return -1
}

describe('seaFacetAt — the boat sits on a triangle the renderer drew', () => {
  const soup = soupOf(1, 2)
  const rnd = lcg(447)
  // Chunk (1, 2) spans mesh x 256..512, z 512..768; keep off its skirt ring.
  const points = Array.from({ length: 40 }, () => [256 + 8 + rnd() * 240, 512 + 8 + rnd() * 240])

  it('returns a triangle of the subdivided, jittered soup, bit for bit and in order', () => {
    const t = new Float64Array(9)
    let found = 0
    for (const [x, z] of points) {
      seaFacetAt(grid, heightMap, PARAMS, SPLIT, PARAMS.randomOffset, x as number, z as number, t)
      if (findExact(soup, t) >= 0) found++
    }
    expect(found).toBe(points.length)
  })

  it('and that triangle covers the point it was asked about', () => {
    const t = new Float64Array(9)
    const w = [0, 0, 0]
    for (const [x, z] of points) {
      const inside = seaFacetAt(
        grid,
        heightMap,
        PARAMS,
        SPLIT,
        PARAMS.randomOffset,
        x as number,
        z as number,
        t,
      )
      expect(inside).toBe(true)
      planWeights(t, x as number, z as number, w)
      for (const wk of w) expect(wk).toBeGreaterThanOrEqual(-1e-6)
    }
  })

  it('the interior jitter is real: a rebuild without it misses the soup', () => {
    // The same search with the jitter left out lands on the lattice's
    // un-jittered points. If the soup had no jitter either this would pass,
    // and the two tests above would be proving nothing about the hash.
    const t = new Float64Array(9)
    let missed = 0
    for (const [x, z] of points) {
      seaFacetAt(grid, heightMap, PARAMS, SPLIT, 0, x as number, z as number, t)
      if (findExact(soup, t) < 0) missed++
    }
    expect(missed).toBeGreaterThan(points.length / 2)
  })

  it('with no split it is the grid facet itself (surface.ts’s own search)', () => {
    const plain = generateChunk(grid, colorMap, heightMap, PARAMS, 1, 2, 0).positions
    const t = new Float64Array(9)
    const g = new Float64Array(9)
    for (const [x, z] of points.slice(0, 10)) {
      seaFacetAt(grid, heightMap, PARAMS, 1, PARAMS.randomOffset, x as number, z as number, t)
      renderFacetAt(grid, heightMap, PARAMS, x as number, z as number, 0, g)
      expect(Array.from(t)).toEqual(Array.from(g))
      expect(findExact(plain, t)).toBeGreaterThanOrEqual(0)
    }
  })
})
