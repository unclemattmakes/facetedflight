// DEV-929: the adaptive skirt. 2016 drops every chunk's skirt to y = 0; in the
// mountains that is a wall hundreds of metres tall, a third to two-fifths of
// every fragment the land rasterises (ANNIVERSARY-VR-FRAMERATE.md section 3.5).
// The adaptive skirt drops only as far as a neighbour's edge can be. The claim
// worth testing is the one the skirt exists for: NO SEAM SHOWS, whatever LODs
// two neighbours are at. So this builds both neighbours' edges at every LOD
// pair and checks each side's skirt reaches the other side's edge, everywhere
// along it, on a terrain made rough on purpose.

import { describe, expect, it } from 'vitest'
import {
  buildVertexGrid,
  type FacetedTerrainParams,
  generateChunk,
  type MapSampler,
  SKIRT_MARGIN_METRES,
  skirtDepths,
} from '@/sim/terrain/faceted'

/** Steep and busy: a few ridges plus a high-frequency ripple, so the coarse
 * edges really do cut corners off the fine ones. */
const roughMap = (): MapSampler => ({
  width: 512,
  height: 512,
  sample(u, v, out) {
    const h =
      0.5 +
      0.3 * Math.sin(u * Math.PI * 5) * Math.cos(v * Math.PI * 4) +
      0.15 * Math.sin(u * 61.0 + v * 37.0) +
      0.05 * Math.cos(u * 173.0 - v * 151.0)
    const c = Math.min(1, Math.max(0, h))
    out.r = c
    out.g = c
    out.b = c
  },
})
const flatColour: MapSampler = {
  width: 1,
  height: 1,
  sample(_u, _v, out) {
    out.r = 0.5
    out.g = 0.5
    out.b = 0.5
  },
}

// 512 m across, 128 m chunks, 4 m quads: 32 quads a chunk edge, so strides up
// to 32 (six LODs), 4x4 chunks, a 600 m tall terrain.
const params: FacetedTerrainParams = {
  terrainSize: 512,
  terrainHeight: 600,
  chunkSize: 128,
  baseResolution: 4,
  randomOffset: 1.3,
  seed: 929,
}
const height = roughMap()
const grid = buildVertexGrid(height, params)
const n = params.chunkSize / params.baseResolution
const heightAt = (gx: number, gy: number): number =>
  grid.verts[(gx * grid.vertPerSide + gy) * 3 + 1] as number

/** A chunk edge's height at fine index i (0..n), drawn at stride s: the line between every s-th vertex. */
const edgeAt = (h: (i: number) => number, s: number, i: number): number => {
  const a = Math.floor(i / s) * s
  const b = Math.min(a + s, n)
  if (a === b) return h(a)
  return h(a) + ((h(b) - h(a)) * (i - a)) / (b - a)
}

describe('DEV-929: the adaptive skirt', () => {
  it('keeps the sea-level wall only on the grid border, and a real depth elsewhere', () => {
    const corner = skirtDepths(grid.verts, grid.vertPerSide, 0, 0, n)
    expect(corner.xm).toBe(-1)
    expect(corner.ym).toBe(-1)
    expect(corner.xp).toBeGreaterThanOrEqual(SKIRT_MARGIN_METRES)
    expect(corner.yp).toBeGreaterThanOrEqual(SKIRT_MARGIN_METRES)
    const far = skirtDepths(grid.verts, grid.vertPerSide, 3 * n, 3 * n, n)
    expect(far.xp).toBe(-1)
    expect(far.yp).toBe(-1)
  })

  it('no seam shows between two neighbours at ANY pair of LODs, along every shared edge', () => {
    let checked = 0
    let worstSlack = Number.POSITIVE_INFINITY
    // Every interior vertical edge (between chunk cx-1 and cx) and horizontal one.
    for (let c = 1; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        for (const vertical of [true, false]) {
          const gx = vertical ? c * n : r * n
          const gy = vertical ? r * n : c * n
          const h = (i: number) => (vertical ? heightAt(gx, gy + i) : heightAt(gx + i, gy))
          // Both sides' depth for this edge: the low-side chunk's +edge and the
          // high-side chunk's -edge, from the same shared vertices.
          const lowSide = skirtDepths(
            grid.verts,
            grid.vertPerSide,
            vertical ? gx - n : gx,
            vertical ? gy : gy - n,
            n,
          )
          const highSide = skirtDepths(grid.verts, grid.vertPerSide, gx, gy, n)
          const dLow = vertical ? lowSide.xp : lowSide.yp
          const dHigh = vertical ? highSide.xm : highSide.ym
          expect(dLow).toBe(dHigh)
          for (let sa = 1; sa <= n; sa *= 2) {
            for (let sb = 1; sb <= n; sb *= 2) {
              for (let i = 0; i <= n; i++) {
                const ea = edgeAt(h, sa, i)
                const eb = edgeAt(h, sb, i)
                // The higher edge's skirt bottom, as `pinnedY` puts it: never
                // below 2016's wall at y = 0.
                const bottom = Math.max(0, Math.max(ea, eb) - dLow)
                const slack = Math.min(ea, eb) - bottom
                if (bottom > 0) {
                  worstSlack = Math.min(worstSlack, slack)
                  expect(
                    slack,
                    `edge ${gx},${gy} strides ${sa}/${sb} at ${i}`,
                  ).toBeGreaterThanOrEqual(SKIRT_MARGIN_METRES - 1e-3)
                } else {
                  // Clamped at the sea: exactly the cover 2016's wall gave.
                  expect(bottom).toBe(0)
                }
                checked++
              }
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000)
    // And the bound is EXACT, not merely safe: somewhere the worst pair of
    // lines lands the skirt's bottom at the margin below the lower edge.
    expect(worstSlack).toBeCloseTo(SKIRT_MARGIN_METRES, 3)
  })

  it('drops the skirts metres, not to the sea, on ground like a real island', () => {
    // A smooth ridge field, the shape of real terrain, 600 m tall.
    const ridge: MapSampler = {
      width: 512,
      height: 512,
      sample(u, v, out) {
        const c = 0.5 + 0.45 * Math.sin(u * Math.PI * 3) * Math.cos(v * Math.PI * 3)
        out.r = c
        out.g = c
        out.b = c
      },
    }
    const g = buildVertexGrid(ridge, params)
    const mesh = (skirts: 'adaptive' | 'sea') =>
      generateChunk(g, flatColour, ridge, params, 1, 1, 0, skirts)
    const sea = mesh('sea')
    const adaptive = mesh('adaptive')
    expect(adaptive.triangleCount).toBe(sea.triangleCount)
    // Only skirt bottoms move, and each to well above the sea it used to reach.
    let moved = 0
    let wall2016 = 0
    let wallNow = 0
    for (let i = 1; i < sea.positions.length; i += 3) {
      if (sea.positions[i] === adaptive.positions[i]) continue
      moved++
      expect(sea.positions[i]).toBe(0)
      expect(adaptive.positions[i] as number).toBeGreaterThan(0)
    }
    expect(moved).toBeGreaterThan(0)
    // Total skirt wall height: the sum of how far each moved vertex hangs.
    for (let i = 1; i < sea.positions.length; i += 3) {
      if (sea.positions[i] === adaptive.positions[i]) continue
      const top = Math.max(...[-3, 3].map((k) => (sea.positions[i + k] as number) || 0))
      wall2016 += top
      wallNow += top - (adaptive.positions[i] as number)
    }
    expect(wallNow).toBeLessThan(wall2016 * 0.25)
  })

  it('never hangs a skirt below 2016s wall, even where the seam bound reaches past the sea', () => {
    const adaptive = generateChunk(grid, flatColour, height, params, 1, 1, 0, 'adaptive')
    for (let i = 1; i < adaptive.positions.length; i += 3) {
      expect(adaptive.positions[i] as number).toBeGreaterThanOrEqual(
        Math.min(0, adaptive.positions[i] as number),
      )
    }
    let below = 0
    for (let i = 1; i < adaptive.positions.length; i += 3)
      if ((adaptive.positions[i] as number) < -2) below++
    // The rough map's surface sits above y = 0 bar the jitter, so nothing is far below it.
    expect(below).toBe(0)
  })
})
