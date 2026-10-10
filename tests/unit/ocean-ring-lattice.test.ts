// tests/unit/ocean-ring-lattice.test.ts: the rings' vertices ARE the plate's.
//
// DEV-339. The oracle is the plate generator: `generateChunk` then
// `subdivideTriangleSoup`, the two functions the terrain worker finishes an
// ocean chunk with, at every LOD the example ladder uses. Every vertex of every
// non-skirt triangle in a chunk must be a baked lattice point, and every triangle must be one the ring layout draws, which
// is what carries the plate's own `diagonalTopLeftToBottomRight` bit across.
//
// Sampled adversarially, not on convenient flat water (CLAUDE.md): relief that
// flips the diagonal both ways, a window that crosses a chunk seam, and a
// second chunk far from the origin.

import { describe, expect, it } from 'vitest'
import { subdivideTriangleSoup } from '@/sim/terrain/chunk-to-three'
import {
  buildVertexGrid,
  type FacetedTerrainParams,
  generateChunk,
  type MapSampler,
} from '@/sim/terrain/faceted'
import type { Rgb } from '@/sim/terrain/image-sampler'
import {
  bakeRingLattice,
  type RingLattice,
  ringLatticeMax,
  ringStepMesh,
} from '@/sim/terrain/ocean-ring-lattice'
import { ringCellCorner } from '@/sim/terrain/ocean-ring-layout'

const relief = (u: number, v: number): number =>
  0.5 + 0.2 * Math.sin(u * 61.3 + 0.7) * Math.cos(v * 47.1 - 0.2) + 0.1 * Math.sin((u - v) * 137)

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

// Ocean-shaped: 32-unit grid, 1024-unit chunks (32 quads at LOD 0, 4 at LOD 3),
// the plates' randomOffset 2. Four chunks a side so a LOD 3 chunk is whole.
const PARAMS: FacetedTerrainParams = {
  terrainSize: 4096,
  terrainHeight: 40,
  chunkSize: 1024,
  baseResolution: 32,
  randomOffset: 2,
  seed: 20161027,
}
const N = 8

const heightMap = map(relief)
const colorMap = map(() => 0.5)
const grid = buildVertexGrid(heightMap, PARAMS)

interface Soup {
  readonly positions: Float32Array
  readonly quadsPerSide: number
}

const soupOf = (cx: number, cz: number, lod: number): Soup => {
  const quadPerChunk = (PARAMS.chunkSize / PARAMS.baseResolution) >> lod
  return {
    positions: subdivideTriangleSoup(
      generateChunk(grid, colorMap, heightMap, PARAMS, cx, cz, lod),
      N,
      PARAMS.randomOffset,
    ).positions,
    quadsPerSide: quadPerChunk + 2,
  }
}

/** The soup's lattice-index triples for the non-skirt quads, plus the worst miss. */
const compareChunk = (
  cx: number,
  cz: number,
  lod: number,
): { tris: Set<string>; worstEdge: number; worstInterior: number; faces: number } => {
  const spec = { stride: 1 << lod, n: N }
  const quadPerChunk = (PARAMS.chunkSize / PARAMS.baseResolution) >> lod
  const lat = bakeRingLattice(grid, heightMap, PARAMS, spec, {
    gx0: cx * quadPerChunk * N,
    gz0: cz * quadPerChunk * N,
    width: quadPerChunk * N + 1,
    height: quadPerChunk * N + 1,
  })
  const soup = soupOf(cx, cz, lod)
  const perQuad = 2 * N * N * 9
  const tris = new Set<string>()
  let worstEdge = 0
  let worstInterior = 0
  let faces = 0
  const idx = (gx: number, gz: number): number => ((gz - lat.gz0) * lat.width + (gx - lat.gx0)) * 4
  for (let x = 0; x < quadPerChunk; x++) {
    for (let y = 0; y < quadPerChunk; y++) {
      const quad = (x + 1) * soup.quadsPerSide + (y + 1)
      const base = quad * perQuad
      const gx0 = (cx * quadPerChunk + x) * N
      const gz0 = (cz * quadPerChunk + y) * N
      // Every lattice point of this quad: candidates for the soup's vertices.
      for (let t = 0; t < 2 * N * N; t++) {
        const key: string[] = []
        for (let k = 0; k < 3; k++) {
          const o = base + (t * 3 + k) * 3
          const px = soup.positions[o] as number
          const py = soup.positions[o + 1] as number
          const pz = soup.positions[o + 2] as number
          let best = Number.POSITIVE_INFINITY
          let bx = 0
          let bz = 0
          for (let lu = 0; lu <= N; lu++) {
            for (let lv = 0; lv <= N; lv++) {
              const i = idx(gx0 + lu, gz0 + lv)
              const dx = px - (lat.data[i] as number)
              const dy = py - (lat.data[i + 1] as number)
              const dz = pz + (lat.data[i + 2] as number)
              const d = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz))
              if (d < best) {
                best = d
                bx = gx0 + lu
                bz = gz0 + lv
              }
            }
          }
          const interior = best === 0
          if (interior) worstInterior = Math.max(worstInterior, best)
          else worstEdge = Math.max(worstEdge, best)
          key.push(`${bx},${bz}`)
        }
        tris.add(key.sort().join('|'))
        faces++
      }
    }
  }
  return { tris, worstEdge, worstInterior, faces }
}

/** The triangles the ring layout draws over the same chunk, as index triples. */
const layoutTris = (lat: RingLattice, cx: number, cz: number, lod: number): Set<string> => {
  const quadPerChunk = (PARAMS.chunkSize / PARAMS.baseResolution) >> lod
  const out = new Set<string>()
  for (let gx = cx * quadPerChunk * N; gx < (cx + 1) * quadPerChunk * N; gx++) {
    for (let gz = cz * quadPerChunk * N; gz < (cz + 1) * quadPerChunk * N; gz++) {
      const diag = (lat.data[((gz - lat.gz0) * lat.width + (gx - lat.gx0)) * 4 + 3] as number) > 0.5
      for (let t = 0; t < 2; t++) {
        const key: string[] = []
        for (let k = 0; k < 3; k++) {
          const [du, dv] = ringCellCorner(diag, t * 3 + k)
          key.push(`${gx + du},${gz + dv}`)
        }
        out.add(key.sort().join('|'))
      }
    }
  }
  return out
}

describe('ocean ring lattice: the plate twin, level by level', () => {
  // (chunk, lod): the four levels of the example ladder, and a chunk far from
  // the origin that sits across a chunk seam from its neighbours.
  const cases: readonly (readonly [number, number, number])[] = [
    [1, 2, 0],
    [2, 1, 1],
    [1, 1, 2],
    [3, 2, 3],
  ]
  for (const [cx, cz, lod] of cases) {
    it(`LOD ${lod}, chunk (${cx}, ${cz}): every plate vertex is a lattice point, every triangle is drawn`, () => {
      const spec = { stride: 1 << lod, n: N }
      const quadPerChunk = (PARAMS.chunkSize / PARAMS.baseResolution) >> lod
      const lat = bakeRingLattice(grid, heightMap, PARAMS, spec, {
        gx0: cx * quadPerChunk * N,
        gz0: cz * quadPerChunk * N,
        width: quadPerChunk * N + 1,
        height: quadPerChunk * N + 1,
      })
      const got = compareChunk(cx, cz, lod)
      // Exact, not close: every vertex of the soup, edge points included, is a
      // lattice point to the last bit (measured 393,216 of 393,216 at LOD 0).
      expect(got.worstEdge).toBe(0)
      // Every soup face is a triangle of the ring layout, and the layout draws
      // nothing the plate does not.
      const drawn = layoutTris(lat, cx, cz, lod)
      expect(got.faces).toBe(drawn.size)
      for (const t of got.tris) expect(drawn.has(t)).toBe(true)
      expect(got.tris.size).toBe(drawn.size)
    })
  }

  it('the relief really does flip the diagonal both ways (the test is not on one split)', () => {
    const lat = bakeRingLattice(
      grid,
      heightMap,
      PARAMS,
      { stride: 1, n: N },
      {
        gx0: 1024 / 4,
        gz0: 1024 / 4,
        width: 8 * 16,
        height: 8 * 16,
      },
    )
    let diag = 0
    let anti = 0
    for (let lu = 0; lu < 16; lu++)
      for (let lv = 0; lv < 16; lv++) {
        const v = lat.data[(lv * N * lat.width + lu * N) * 4 + 3] as number
        if (v > 0.5) diag++
        else anti++
      }
    expect(diag).toBeGreaterThan(20)
    expect(anti).toBeGreaterThan(20)
  })

  it('the interior of a parent triangle, where the hash lives, is bit for bit', () => {
    // `worstInterior` only counts exact hits, so assert the exact-hit share
    // directly: points strictly inside a parent triangle (i, j > 0, i + j < n)
    // must all be exact, and there are 21 of them per triangle at n = 8.
    const lod = 0
    const spec = { stride: 1, n: N }
    const lat = bakeRingLattice(grid, heightMap, PARAMS, spec, {
      gx0: 1 * 32 * N,
      gz0: 2 * 32 * N,
      width: 32 * N + 1,
      height: 32 * N + 1,
    })
    const soup = soupOf(1, 2, lod)
    const perQuad = 2 * N * N * 9
    let exact = 0
    let total = 0
    for (let x = 0; x < 32; x += 5) {
      for (let y = 0; y < 32; y += 5) {
        const base = ((x + 1) * soup.quadsPerSide + (y + 1)) * perQuad
        for (let o = 0; o < perQuad; o += 3) {
          const px = soup.positions[base + o] as number
          const py = soup.positions[base + o + 1] as number
          const pz = soup.positions[base + o + 2] as number
          total++
          let hit = false
          for (let lu = 0; lu <= N && !hit; lu++)
            for (let lv = 0; lv <= N && !hit; lv++) {
              const i = ((y * N + lv) * lat.width + (x * N + lu)) * 4
              hit =
                px === lat.data[i] && py === lat.data[i + 1] && pz === -(lat.data[i + 2] as number)
            }
          if (hit) exact++
        }
      }
    }
    // Interior points are 21 of the 45 vertices of an 8x8 split triangle, and
    // they are the ones a one-ulp slip in the inputs would re-roll entirely.
    expect(exact).toBe(total)
  })

  it('a level covers the plate: the last index is where the grid ends', () => {
    for (const lod of [0, 1, 2, 3]) {
      const spec = { stride: 1 << lod, n: N }
      const max = ringLatticeMax(PARAMS, spec)
      expect(max).toBe((PARAMS.terrainSize / PARAMS.baseResolution / (1 << lod)) * N)
      expect(ringStepMesh(PARAMS, spec)).toBe((32 * (1 << lod)) / N)
      const edge = bakeRingLattice(grid, heightMap, PARAMS, spec, {
        gx0: max - 1,
        gz0: max - 1,
        width: 5,
        height: 5,
      })
      // Clamped to the two last rows, and the corner is the grid's own vertex.
      expect(edge.width).toBe(2)
      const o = ((edge.height - 1) * edge.width + (edge.width - 1)) * 4
      const last = (grid.vertPerSide * grid.vertPerSide - 1) * 3
      expect(edge.data[o]).toBe(grid.verts[last])
      expect(edge.data[o + 2]).toBe(-(grid.verts[last + 2] as number))
    }
  })
})
