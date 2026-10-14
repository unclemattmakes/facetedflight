// tests/unit/terrain-faceted.test.ts — the faceted look, asserted structurally.
//
// The generator is the one piece of this port with no fallback: the 2016 baked
// meshes are unshippable, so if this is wrong there is no terrain. These tests
// assert the three properties that produce the look, plus the determinism the
// collision heightfield and the CI hash both depend on.

import { describe, expect, it } from 'vitest'
import {
  buildVertexGrid,
  chunkPerSide,
  type FacetedTerrainParams,
  generateChunk,
  grayscale,
  insideUnitSphere,
  type MapSampler,
  makeRandom,
} from '@/sim/terrain/faceted'

/** A deterministic analytic height map — no image decoding in unit tests. */
const ridgeMap = (): MapSampler => ({
  width: 256,
  height: 256,
  sample(u, v, out) {
    const h = 0.5 + 0.5 * Math.sin(u * Math.PI * 3) * Math.cos(v * Math.PI * 3)
    out.r = h
    out.g = h
    out.b = h
  },
})

/** A colour map with sharp regions, so per-face colour is easy to detect. */
const bandedMap = (): MapSampler => ({
  width: 256,
  height: 256,
  sample(u, v, out) {
    out.r = u
    out.g = v
    out.b = u * v
  },
})

// Small terrain so the tests stay fast: 256 m across, 64 m chunks, 8 m quads
// => 32x32 quads overall, 8x8 per chunk, 4x4 chunks.
const params: FacetedTerrainParams = {
  terrainSize: 256,
  terrainHeight: 64,
  chunkSize: 64,
  baseResolution: 8,
  randomOffset: 0.6,
  seed: 12345,
}

const build = (p: FacetedTerrainParams = params) => {
  const height = ridgeMap()
  const color = bandedMap()
  const grid = buildVertexGrid(height, p)
  // 2016's skirt, to the sea: these tests characterise the 2016 generator.
  // DEV-929's adaptive skirt is `terrain-skirts.test.ts`'s.
  return { grid, height, color, chunk: generateChunk(grid, color, height, p, 0, 0, 0, 'sea') }
}

describe('faceted terrain — the three things that make the look', () => {
  it('gives every triangle a single flat colour', () => {
    const { chunk } = build()
    for (let i = 0; i < chunk.triangleCount; i++) {
      const b = i * 9
      // All three vertices of the face must carry identical rgb.
      expect(chunk.colors[b]).toBe(chunk.colors[b + 3])
      expect(chunk.colors[b]).toBe(chunk.colors[b + 6])
      expect(chunk.colors[b + 1]).toBe(chunk.colors[b + 4])
      expect(chunk.colors[b + 2]).toBe(chunk.colors[b + 8 - 6])
    }
  })

  it('fully splits vertices — no triangle shares a vertex with another', () => {
    const { chunk } = build()
    expect(chunk.positions.length).toBe(chunk.triangleCount * 9)
    // Every face has its own normal; adjacent faces on a curved surface must
    // therefore differ, which is what "flat shaded" means.
    const n0 = [chunk.normals[0], chunk.normals[1], chunk.normals[2]]
    let differs = false
    for (let i = 1; i < chunk.triangleCount && !differs; i++) {
      const b = i * 9
      if (
        Math.abs((chunk.normals[b] as number) - (n0[0] as number)) > 1e-6 ||
        Math.abs((chunk.normals[b + 1] as number) - (n0[1] as number)) > 1e-6
      ) {
        differs = true
      }
    }
    expect(differs).toBe(true)
  })

  it('jitters vertices off the regular grid', () => {
    const jittered = build().grid
    const flat = buildVertexGrid(ridgeMap(), { ...params, randomOffset: 0 })
    let moved = 0
    for (let i = 0; i < flat.verts.length; i += 3) {
      if (Math.abs((jittered.verts[i] as number) - (flat.verts[i] as number)) > 1e-9) moved++
    }
    // Essentially every vertex should have moved.
    expect(moved).toBeGreaterThan(flat.verts.length / 3 - 5)
  })

  it('keeps the jitter inside the requested radius', () => {
    const jittered = build().grid
    const flat = buildVertexGrid(ridgeMap(), { ...params, randomOffset: 0 })
    for (let i = 0; i < flat.verts.length; i += 3) {
      const dx = (jittered.verts[i] as number) - (flat.verts[i] as number)
      const dy = (jittered.verts[i + 1] as number) - (flat.verts[i + 1] as number)
      const dz = (jittered.verts[i + 2] as number) - (flat.verts[i + 2] as number)
      expect(Math.hypot(dx, dy, dz)).toBeLessThanOrEqual(params.randomOffset + 1e-6)
    }
  })
})

describe('faceted terrain — determinism', () => {
  it('produces byte-identical geometry for the same seed', () => {
    const a = build().chunk
    const b = build().chunk
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions))
    expect(Array.from(a.colors)).toEqual(Array.from(b.colors))
  })

  it('produces different geometry for a different seed', () => {
    const a = build().chunk
    const b = build({ ...params, seed: 999 }).chunk
    expect(Array.from(a.positions)).not.toEqual(Array.from(b.positions))
  })

  it('never calls Math.random — the sim layer forbids it', () => {
    const real = Math.random
    Math.random = () => {
      throw new Error('the terrain generator must not call Math.random')
    }
    try {
      expect(() => build()).not.toThrow()
    } finally {
      Math.random = real
    }
  })
})

describe('faceted terrain — the skirt that hides LOD seams', () => {
  it('emits one ring of quads beyond the chunk', () => {
    const { chunk } = build()
    const quadPerChunk = params.chunkSize / params.baseResolution
    const withSkirt = (quadPerChunk + 2) * (quadPerChunk + 2) * 2
    expect(chunk.triangleCount).toBe(withSkirt)
  })

  it('pins the outer skirt vertices to y = 0', () => {
    const { chunk } = build()
    let atZero = 0
    for (let i = 1; i < chunk.positions.length; i += 3) {
      if (chunk.positions[i] === 0) atZero++
    }
    // The skirt ring drops a wall to sea level, so a meaningful number of
    // vertices sit exactly at zero. Interior terrain height is never exactly 0.
    expect(atZero).toBeGreaterThan(0)
  })

  // ── The stamp ───────────────────────────────────────────────────────────
  //
  // The skirt shipped without `FacetedTerrain.cs:1031-1038`, and the symptom was
  // a pale dashed line running down distant mountains wherever two chunks sat on
  // different LODs. Matt saw it as *"a fuzzy pink line drawn on top of the
  // mtns"* and read it as a fog artifact, which is what a wrongly-lit sliver of
  // geometry at the far end of the fog looks like.
  //
  // What makes this cheap to assert exactly: a skirt quad is a VERTICAL wall,
  // so the face normal it computes for itself is exactly horizontal — `ny` is
  // 0.0, not approximately. Anything else on a stamped quad is the interior
  // triangle's normal, and nothing else in the generator can produce it.
  const quadIndex = (qx: number, qy: number, quadPerChunk: number): number =>
    (qx + 1) * (quadPerChunk + 2) + (qy + 1)

  it('stamps every edge skirt with its neighbour triangle, not its own wall normal', () => {
    const { chunk } = build()
    const quadPerChunk = params.chunkSize / params.baseResolution

    // The four boundary runs, each as the skirt quad and the interior quad it
    // hangs off. Written out rather than derived so a transposed index in the
    // generator cannot be reproduced by a transposed index here.
    const runs: { skirt: [number, number]; inner: [number, number] }[] = []
    for (let i = 0; i < quadPerChunk; i++) {
      runs.push({ skirt: [-1, i], inner: [0, i] })
      runs.push({ skirt: [quadPerChunk, i], inner: [quadPerChunk - 1, i] })
      runs.push({ skirt: [i, -1], inner: [i, 0] })
      runs.push({ skirt: [i, quadPerChunk], inner: [i, quadPerChunk - 1] })
    }
    expect(runs.length).toBe(quadPerChunk * 4)

    const face = (q: number, half: 0 | 1) => {
      const b = q * 18 + half * 9
      return {
        n: [chunk.normals[b], chunk.normals[b + 1], chunk.normals[b + 2]] as number[],
        verts: [0, 1, 2].map((k) => [
          chunk.positions[b + k * 3],
          chunk.positions[b + k * 3 + 1],
          chunk.positions[b + k * 3 + 2],
        ]) as number[][],
      }
    }
    const same = (a: number[], b: number[]) => a.every((v, i) => v === b[i])

    for (const { skirt, inner } of runs) {
      const sq = quadIndex(skirt[0] as number, skirt[1] as number, quadPerChunk)
      const iq = quadIndex(inner[0] as number, inner[1] as number, quadPerChunk)
      const s0 = face(sq, 0)
      const s1 = face(sq, 1)

      // Both of the skirt quad's triangles carry one normal, and it is not the
      // wall's own — a wall's normal is horizontal to the last bit.
      expect(s0.n).toEqual(s1.n)
      expect(s0.n[1]).not.toBe(0)

      // The two skirt vertices that were NOT pinned to y = 0 are the boundary
      // edge. The interior triangle that shares them is the one whose normal
      // must have been stamped.
      const shared = [...s0.verts, ...s1.verts].filter((v) => v[1] !== 0)
      expect(shared.length).toBeGreaterThanOrEqual(2)
      const owner = [face(iq, 0), face(iq, 1)].find((f) =>
        shared.every((sv) => f.verts.some((iv) => same(iv, sv))),
      )
      expect(owner).toBeDefined()
      expect(s0.n).toEqual((owner as { n: number[] }).n)
    }
  })

  it('leaves the four corner skirt quads alone, as 2016 does', () => {
    const { chunk } = build()
    const quadPerChunk = params.chunkSize / params.baseResolution
    // `FacetedTerrain.cs:1032` bounds the stamp at `i < quadPerSide`, so the
    // corners keep the wall normal they computed. A corner quad has two
    // boundary edges and no single right answer; the original picks neither.
    for (const [qx, qy] of [
      [-1, -1],
      [-1, quadPerChunk],
      [quadPerChunk, -1],
      [quadPerChunk, quadPerChunk],
    ]) {
      const q = quadIndex(qx as number, qy as number, quadPerChunk)
      expect(chunk.normals[q * 18 + 1]).toBe(0)
      expect(chunk.normals[q * 18 + 9 + 1]).toBe(0)
    }
  })
})

describe('faceted terrain — faithfulness to 2016', () => {
  it('reproduces the diagonal-choice bug by default, and can be told not to', () => {
    const faithful = build({ ...params, faithfulDiagonalBug: true }).chunk
    const fixed = build({ ...params, faithfulDiagonalBug: false }).chunk
    // The bug uses `.y` (height) as the V coordinate instead of `.z`, so the
    // two must disagree on at least some quads' diagonals — which shows up as
    // different vertex positions.
    expect(Array.from(faithful.positions)).not.toEqual(Array.from(fixed.positions))
  })

  it("uses Unity's luminance for grayscale, not a channel average", () => {
    // Unity's Color.grayscale is 0.299r + 0.587g + 0.114b. A pure green pixel
    // is much brighter than a pure blue one; an average would tie them.
    expect(grayscale(0, 1, 0)).toBeCloseTo(0.587, 6)
    expect(grayscale(0, 0, 1)).toBeCloseTo(0.114, 6)
    expect(grayscale(1, 1, 1)).toBeCloseTo(1, 6)
  })

  it('matches the original chunk-count math', () => {
    expect(chunkPerSide(params)).toBe(4)
    expect(chunkPerSide({ ...params, terrainSize: 4096, chunkSize: 512 })).toBe(8)
    // Simonet Islands: 4096 m across in 256 m chunks => 16x16.
    expect(chunkPerSide({ ...params, terrainSize: 4096, chunkSize: 256 })).toBe(16)
  })
})

describe('insideUnitSphere', () => {
  it('stays inside the unit ball and fills it', () => {
    const rnd = makeRandom(7)
    const out = { x: 0, y: 0, z: 0 }
    let maxLen = 0
    for (let i = 0; i < 2000; i++) {
      insideUnitSphere(rnd, out)
      const len = Math.hypot(out.x, out.y, out.z)
      expect(len).toBeLessThanOrEqual(1)
      if (len > maxLen) maxLen = len
    }
    // Should get close to the surface over 2000 draws, i.e. it is a ball and
    // not a small blob near the origin.
    expect(maxLen).toBeGreaterThan(0.9)
  })
})

describe('faceted terrain — LOD is a stride over the shared grid', () => {
  it('halves the quads per side at each level', () => {
    const quadPerChunk = params.chunkSize / params.baseResolution // 8
    for (const [lod, expected] of [
      [0, 8],
      [1, 4],
      [2, 2],
    ] as const) {
      const { grid, color, height } = build()
      const chunk = generateChunk(grid, color, height, params, 0, 0, lod)
      expect(chunk.triangleCount).toBe((expected + 2) * (expected + 2) * 2)
      expect(quadPerChunk >> lod).toBe(expected)
    }
  })

  it('covers the same ground at every level', () => {
    const { grid, color, height } = build()
    const extentOf = (lod: number) => {
      const c = generateChunk(grid, color, height, params, 0, 0, lod)
      let min = Number.POSITIVE_INFINITY
      let max = Number.NEGATIVE_INFINITY
      for (let i = 0; i < c.positions.length; i += 3) {
        const x = c.positions[i] as number
        if (x < min) min = x
        if (x > max) max = x
      }
      return [min, max]
    }
    const [min0, max0] = extentOf(0)
    const [min2, max2] = extentOf(2)
    // A coarser LOD must span the same chunk, not a smaller patch of it —
    // otherwise the terrain visibly shrinks as you fly away from it.
    expect(Math.abs((min2 as number) - (min0 as number))).toBeLessThan(
      params.randomOffset * 2 + 1e-6,
    )
    expect(Math.abs((max2 as number) - (max0 as number))).toBeLessThan(
      params.randomOffset * 2 + 1e-6,
    )
  })

  it('lands every LOD vertex on a real grid vertex, jitter included', () => {
    const { grid, color, height } = build()
    const coarse = generateChunk(grid, color, height, params, 0, 0, 1)
    // Build the set of grid vertex positions (x,z rounded) to check membership.
    const gridXZ = new Set<string>()
    for (let i = 0; i < grid.verts.length; i += 3) {
      gridXZ.add(
        `${(grid.verts[i] as number).toFixed(4)},${(grid.verts[i + 2] as number).toFixed(4)}`,
      )
    }
    let hits = 0
    for (let i = 0; i < coarse.positions.length; i += 3) {
      const key = `${(coarse.positions[i] as number).toFixed(4)},${(coarse.positions[i + 2] as number).toFixed(4)}`
      if (gridXZ.has(key)) hits++
    }
    // Every vertex is sampled from the grid, so all of them must be found.
    expect(hits).toBe(coarse.positions.length / 3)
  })

  it('refuses a LOD finer than the chunk allows', () => {
    const { grid, color, height } = build()
    // 8 quads per chunk cannot be halved 4 times.
    expect(() => generateChunk(grid, color, height, params, 0, 0, 4)).toThrow(
      /finer than the chunk/,
    )
  })
})
