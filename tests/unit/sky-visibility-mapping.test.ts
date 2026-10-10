// tests/unit/sky-visibility-mapping.test.ts — the texel a facet reads is the
// ground UNDER that facet. DEV-333.
//
// `render/sky-visibility.ts` reads its bake at each facet's barycentre uv. The
// arithmetic from uv to texel is symmetric in x and z, so a transposed or
// flipped axis passes any test that only re-derives it (trap 24) and hides on
// symmetric ground (the orientation lesson). So this tests GEOMETRY: over every
// facet of a chunk built by the real generator, on a map with no symmetry, the
// height-field texel the facet's uv resolves to must sit at the facet's own
// height. The two wrong readings are run too, and must FAIL, which is what
// shows this sample can tell them apart.

import { describe, expect, it } from 'vitest'
import { texcoordFor } from '@/render/sky-visibility'
import { buildVertexGrid, type FacetedTerrainParams, generateChunk } from '@/sim/terrain/faceted'
import { buildHeightField, type HeightField } from '@/sim/terrain/height-field'
import { createGreySampler } from '@/sim/terrain/image-sampler'

const W = 65
const data = new Float32Array(W * W)
for (let y = 0; y < W; y++)
  for (let x = 0; x < W; x++) {
    const u = x / (W - 1)
    const v = y / (W - 1)
    // Steep in u, gentle in v, and a ripple off both axes: no symmetry a
    // transpose or a flip could hide in.
    data[y * W + x] = 0.1 + 0.6 * u * u + 0.15 * v + 0.1 * Math.sin(9 * u + 2.3 * v)
  }
const sampler = createGreySampler({ width: W, height: W, data })
const params: FacetedTerrainParams = {
  terrainSize: 512,
  terrainHeight: 200,
  chunkSize: 128,
  baseResolution: 8,
  // No jitter: the facet's corners are then exactly on the collision field.
  randomOffset: 0,
  seed: 1,
}
const field = buildHeightField(sampler, params, { position: [0, 0, 0], scale: [1, 1, 1] })

const heightAt = (f: HeightField, gx: number, gz: number): number => {
  const n = f.vertPerSide
  const x = Math.min(Math.max(gx, 0), n - 1)
  const z = Math.min(Math.max(gz, 0), n - 1)
  const x0 = Math.min(Math.floor(x), n - 2)
  const z0 = Math.min(Math.floor(z), n - 2)
  const fx = x - x0
  const fz = z - z0
  const h = (i: number, j: number) => (f.heights[j * n + i] as number) * f.terrainHeight
  const a = h(x0, z0) + (h(x0 + 1, z0) - h(x0, z0)) * fx
  const b = h(x0, z0 + 1) + (h(x0 + 1, z0 + 1) - h(x0, z0 + 1)) * fx
  return a + (b - a) * fz
}

describe('the bake texel a facet reads is the ground under it', () => {
  const grid = buildVertexGrid(sampler, params)
  // An off-diagonal chunk, away from the origin.
  const chunk = generateChunk(grid, sampler, sampler, params, 3, 1, 0)
  const n = field.vertPerSide

  /** Worst |facet centroid height − field height at the texel it reads|, metres. */
  const worst = (read: (u: number, v: number) => [number, number], stride: number): number => {
    const m = (n - 1) / stride + 1
    let err = 0
    let counted = 0
    for (let t = 0; t < chunk.triangleCount; t++) {
      // The chunk's EDGE SKIRTS are vertical walls down to y = 0 at its border
      // (FacetedTerrain.cs:1031), and their centroid height says nothing about
      // the ground. They have no horizontal footprint; skip those.
      const p = (k: number, c: number) => chunk.positions[t * 9 + k * 3 + c] as number
      const footprint = Math.abs(
        (p(1, 0) - p(0, 0)) * (p(2, 2) - p(0, 2)) - (p(2, 0) - p(0, 0)) * (p(1, 2) - p(0, 2)),
      )
      if (footprint < 1e-6) continue
      counted++
      const u = chunk.uvs[t * 6] as number
      const v = chunk.uvs[t * 6 + 1] as number
      const [uu, vv] = read(u, v)
      // What the shader does: texcoord → texel index → grid texel.
      const gx = (texcoordFor(uu, m) * m - 0.5) * stride
      const gz = (texcoordFor(vv, m) * m - 0.5) * stride
      let y = 0
      for (let k = 0; k < 3; k++) y += (chunk.positions[t * 9 + k * 3 + 1] as number) / 3
      err = Math.max(err, Math.abs(y - heightAt(field, gx, gz)))
    }
    // Most of the chunk is ground; a filter that ate it would pass vacuously.
    expect(counted).toBeGreaterThan(chunk.triangleCount / 2)
    return err
  }

  it('matches to within a facet’s own twist, at stride 1 and 2', () => {
    // A triangle's centroid is the mean of three grid heights; the field is
    // bilinear at that point. They differ by the quad's twist, well under a
    // metre on this map. A wrong axis is tens of metres out.
    expect(worst((u, v) => [u, v], 1)).toBeLessThan(1)
    expect(worst((u, v) => [u, v], 2)).toBeLessThan(1.5)
  })

  it('and the sample can tell: a transposed or flipped read is far out', () => {
    expect(worst((u, v) => [v, u], 1)).toBeGreaterThan(20)
    expect(worst((u, v) => [u, 1 - v], 1)).toBeGreaterThan(10)
  })

  it('the facet uv is the barycentre on all three vertices, so the read is one value per face', () => {
    for (let t = 0; t < chunk.triangleCount; t++) {
      for (let k = 1; k < 3; k++) {
        expect(chunk.uvs[t * 6 + k * 2]).toBe(chunk.uvs[t * 6])
        expect(chunk.uvs[t * 6 + k * 2 + 1]).toBe(chunk.uvs[t * 6 + 1])
      }
    }
  })
})
