// tests/unit/render-surface.test.ts — the surface sampler agrees with the mesh.
//
// DEV-134. `renderSurfaceHeightAt` claims to answer "what height does the
// RENDERED terrain have here?" The only honest oracle for that is the rendered
// terrain: `generateChunk`'s own triangle buffer, searched by brute force for
// the face covering the point. The sampler must land on that face's plane —
// and it must do so with the JITTER ON, because a grid with no jitter is where
// the collider and the mesh agree and the whole question disappears.
//
// The map is synthetic (the real ones are gitignored assets), high-relief and
// off-axis, so the diagonal choice flips quad to quad and a wrong slot layout
// or a wrong triangle pairing would read metres off rather than millimetres.

import { describe, expect, it } from 'vitest'
import {
  buildVertexGrid,
  type FacetedTerrainParams,
  generateChunk,
  type MapSampler,
} from '@/sim/terrain/faceted'
import { buildHeightField, terrainHeightAt } from '@/sim/terrain/height-field'
import type { Rgb } from '@/sim/terrain/image-sampler'
import { renderSurfaceHeightAt, snapToRenderSurface } from '@/sim/terrain/surface'
import { lcg } from './helpers/seeded'

const relief = (u: number, v: number): number =>
  0.5 + 0.25 * Math.sin(u * 23.1 + 1.3) * Math.cos(v * 17.7 - 0.4) + 0.15 * Math.sin((u + v) * 41)

const map = (f: (u: number, v: number) => number): MapSampler =>
  ({
    width: 128,
    height: 128,
    sample(u: number, v: number, out: Rgb): Rgb {
      const g = Math.min(1, Math.max(0, f(u, v)))
      out.r = g
      out.g = g
      out.b = g
      return out
    },
  }) as unknown as MapSampler

const PARAMS: FacetedTerrainParams = {
  terrainSize: 512,
  terrainHeight: 200,
  chunkSize: 128,
  baseResolution: 8,
  // Simonet's jitter, the largest shipped: the hardest case for the sampler.
  randomOffset: 1.3,
  seed: 20160101,
}

/** The mesh's OWN answer: the plane of the emitted triangle whose plan covers (x, z). */
const meshHeightAt = (positions: Float32Array, x: number, z: number): number | null => {
  for (let t = 0; t < positions.length; t += 9) {
    const ax = positions[t] as number
    const ay = positions[t + 1] as number
    const az = positions[t + 2] as number
    const bx = positions[t + 3] as number
    const by = positions[t + 4] as number
    const bz = positions[t + 5] as number
    const cx = positions[t + 6] as number
    const cy = positions[t + 7] as number
    const cz = positions[t + 8] as number
    const det = (bx - ax) * (cz - az) - (cx - ax) * (bz - az)
    if (Math.abs(det) < 1e-9) continue
    const wb = ((x - ax) * (cz - az) - (cx - ax) * (z - az)) / det
    const wc = ((bx - ax) * (z - az) - (x - ax) * (bz - az)) / det
    const wa = 1 - wb - wc
    if (wa < -1e-9 || wb < -1e-9 || wc < -1e-9) continue
    // Skirt walls are degenerate in plan and never cover an interior point;
    // a wall pinned to y = 0 that did would read as a hole, so skip it.
    if (ay === 0 && by === 0 && cy === 0) continue
    return wa * ay + wb * by + wc * cy
  }
  return null
}

describe('renderSurfaceHeightAt against generateChunk', () => {
  const height = map(relief)
  const colour = map(() => 0.5)
  const grid = buildVertexGrid(height, PARAMS)

  it('lands on the plane of the triangle the mesh actually draws, jitter and diagonal bug included', () => {
    const rnd = lcg(7)
    const chunk = generateChunk(grid, colour, height, PARAMS, 1, 2, 0)
    let checked = 0
    let worst = 0
    for (let i = 0; i < 400; i++) {
      // Inside chunk (1,2), a cell in from the edge so the skirt is not in play.
      const x = 128 + 8 + rnd() * (128 - 16)
      const z = 256 + 8 + rnd() * (128 - 16)
      const truth = meshHeightAt(chunk.positions, x, z)
      if (truth === null) continue
      const got = renderSurfaceHeightAt(grid, height, PARAMS, x, z, 0)
      worst = Math.max(worst, Math.abs(got - truth))
      checked++
    }
    expect(checked).toBeGreaterThan(350)
    expect(worst).toBeLessThan(1e-3)
  })

  it('is NOT the collision surface — the two differ by the jitter, which is the point', () => {
    const field = buildHeightField(height, PARAMS, { position: [0, 0, 0], scale: [1, 1, 1] })
    const rnd = lcg(11)
    let maxGap = 0
    for (let i = 0; i < 400; i++) {
      const x = 16 + rnd() * (512 - 32)
      const z = 16 + rnd() * (512 - 32)
      const a = renderSurfaceHeightAt(grid, height, PARAMS, x, z)
      const b = terrainHeightAt(field, x, z)
      maxGap = Math.max(maxGap, Math.abs(a - b))
    }
    // A vertex moves up to 1.3 m; a slope tilted by one moved corner moves a
    // point on it by more. Well above zero, well below a facet.
    expect(maxGap).toBeGreaterThan(0.3)
    expect(maxGap).toBeLessThan(8)
  })

  it('agrees with the mesh at LOD 1 too, where the stride skips vertices', () => {
    const rnd = lcg(13)
    const chunk = generateChunk(grid, colour, height, PARAMS, 2, 1, 1)
    let checked = 0
    let worst = 0
    for (let i = 0; i < 200; i++) {
      const x = 256 + 16 + rnd() * (128 - 32)
      const z = 128 + 16 + rnd() * (128 - 32)
      const truth = meshHeightAt(chunk.positions, x, z)
      if (truth === null) continue
      worst = Math.max(
        worst,
        Math.abs(renderSurfaceHeightAt(grid, height, PARAMS, x, z, 1) - truth),
      )
      checked++
    }
    expect(checked).toBeGreaterThan(150)
    expect(worst).toBeLessThan(1e-3)
  })

  it('snapToRenderSurface counts what was floating and sinks every base by the asked amount', () => {
    const rnd = lcg(17)
    const n = 50
    const positions = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      const x = 16 + rnd() * 480
      const z = 16 + rnd() * 480
      positions[i * 3] = x
      // Half a metre above the rendered surface, on purpose: every one floats.
      positions[i * 3 + 1] = renderSurfaceHeightAt(grid, height, PARAMS, x, z) + 0.5
      positions[i * 3 + 2] = z
    }
    const floating = snapToRenderSurface(positions, n, grid, height, PARAMS, 0.35, 0.3)
    expect(floating).toBe(n)
    for (let i = 0; i < n; i++) {
      const x = positions[i * 3] as number
      const z = positions[i * 3 + 2] as number
      const ground = renderSurfaceHeightAt(grid, height, PARAMS, x, z)
      // Float32 storage: a 200 m height keeps about 1e-5 m, so ask for a millimetre.
      expect((positions[i * 3 + 1] as number) - ground).toBeCloseTo(-0.35, 3)
    }
    // And a second pass moves nothing that is now under the surface.
    expect(snapToRenderSurface(positions, n, grid, height, PARAMS, 0.35, 0.3)).toBe(0)
  })
})
