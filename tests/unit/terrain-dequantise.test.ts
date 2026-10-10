// tests/unit/terrain-dequantise.test.ts — the height between the 8-bit levels
// (DEV-131), and the one invariant that makes it honest: NOTHING it produces is
// more than half a level from the stored map.
//
// The diagnosis these tests rest on was measured, not argued: through
// `importUnityTexture()` on all four shipped maps, 0.0 % of adjacent grid
// heights differ by less than half a level at either pitch, because the grid
// lands on texel centres and the map is 8-bit. So the fixtures below are what
// the maps ARE — quantised ramps — and the claims are about what a
// reconstruction may and may not do to them.

import { describe, expect, it } from 'vitest'
import {
  dequantiseHeightMap,
  heightLevels,
  smoothRadiusTexels,
  UINT8_LEVELS,
} from '@/sim/terrain/dequantise'
import { buildVertexGrid, type FacetedTerrainParams } from '@/sim/terrain/faceted'
import { createMapSampler, type ImageData8 } from '@/sim/terrain/image-sampler'

const rgb = { r: 0, g: 0, b: 0 }

/** A grey RGB map from a height function in LEVELS (0..255), rounded like an exporter. */
const mapOf = (w: number, h: number, level: (x: number, y: number) => number): ImageData8 => {
  const data = new Uint8Array(w * h * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.max(0, Math.min(255, Math.round(level(x, y))))
      const o = (y * w + x) * 3
      data[o] = v
      data[o + 1] = v
      data[o + 2] = v
    }
  }
  return { width: w, height: h, channels: 3, data }
}

/** Sample every texel centre of a sampler as a grey level, u = x / w like the grid does. */
const levelsOf = (
  s: { sample: (u: number, v: number, o: typeof rgb) => void },
  w: number,
  h: number,
) => {
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // `v` is flipped in the sampler; row `y` of the buffer is v = (h - 1 - y) / h.
      s.sample(x / w, (h - 1 - y) / h, rgb)
      out[y * w + x] = rgb.r * UINT8_LEVELS
    }
  }
  return out
}

/** A slope of `perTexel` LEVELS per texel, quantised: shelves and single-level risers. */
const staircase = (w: number, perTexel: number) => mapOf(w, w, (x) => 20 + x * perTexel)

describe('the invariant: never more than half a level from the stored map', () => {
  it('holds on every texel of a quantised slope, at every radius', () => {
    const img = staircase(96, 0.11)
    const stored = levelsOf(createMapSampler(img), 96, 96)
    for (const r of [1, 4, 12, 30]) {
      const out = levelsOf(dequantiseHeightMap(img, r), 96, 96)
      let worst = 0
      for (let i = 0; i < out.length; i++) {
        worst = Math.max(worst, Math.abs((out[i] as number) - (stored[i] as number)))
      }
      expect(worst, `radius ${r}`).toBeLessThanOrEqual(0.5 + 1e-4)
    }
  })

  it('holds on a cliff, which is the case the clamp exists for', () => {
    // Twenty levels in one texel. A blur of radius 12 would smear it over 24
    // texels and put the surface ten levels from the data either side.
    const img = mapOf(64, 64, (x) => (x < 32 ? 40 : 60))
    const stored = levelsOf(createMapSampler(img), 64, 64)
    const out = levelsOf(dequantiseHeightMap(img, 12), 64, 64)
    let worst = 0
    for (let i = 0; i < out.length; i++) {
      worst = Math.max(worst, Math.abs((out[i] as number) - (stored[i] as number)))
    }
    expect(worst).toBeLessThanOrEqual(0.5 + 1e-4)
    // ...and the cliff is still a cliff: the two sides differ by 20 levels
    // less at most half a level on each side — 19, exactly the clamp's bound.
    const y = 32
    const left = out[y * 64 + 20] as number
    const right = out[y * 64 + 44] as number
    expect(right - left).toBeGreaterThanOrEqual(19 - 1e-4)
  })

  it('is white noise in, white noise out, still within the band', () => {
    let seed = 7
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) >>> 0
      return (seed >>> 8) / 16777216
    }
    const img = mapOf(48, 48, () => rnd() * 255)
    const stored = levelsOf(createMapSampler(img), 48, 48)
    const out = levelsOf(dequantiseHeightMap(img, 6), 48, 48)
    for (let i = 0; i < out.length; i++) {
      expect(Math.abs((out[i] as number) - (stored[i] as number))).toBeLessThanOrEqual(0.5 + 1e-4)
    }
  })
})

describe('the terrace becomes a slope', () => {
  it('removes the level runs a gentle quantised slope is made of', () => {
    // 0.11 levels a texel: shelves of nine, one riser — Simonet's p90 shelf.
    const img = staircase(128, 0.11)
    const before = levelsOf(createMapSampler(img), 128, 128)
    const after = levelsOf(dequantiseHeightMap(img, 12), 128, 128)
    const flatRuns = (h: Float32Array): number => {
      let zero = 0
      let total = 0
      const y = 64
      for (let x = 20; x < 107; x++) {
        const d = Math.abs((h[y * 128 + x + 1] as number) - (h[y * 128 + x] as number))
        total++
        if (d < 1e-4) zero++
      }
      return zero / total
    }
    expect(flatRuns(before)).toBeGreaterThan(0.8)
    expect(flatRuns(after)).toBe(0)
  })

  it('reconstructs the ramp the shelves were rounded from, away from the edges', () => {
    const per = 0.11
    const img = staircase(128, per)
    const after = levelsOf(dequantiseHeightMap(img, 12), 128, 128)
    const y = 64
    for (let x = 24; x < 104; x++) {
      const truth = 20 + x * per
      expect(Math.abs((after[y * 128 + x] as number) - truth), `x=${x}`).toBeLessThan(0.5)
    }
    // And the slope is the RAMP's slope, not the staircase's: consecutive
    // deltas are all the same sign and none is a whole level.
    for (let x = 24; x < 103; x++) {
      const d = (after[y * 128 + x + 1] as number) - (after[y * 128 + x] as number)
      expect(d).toBeGreaterThan(0)
      expect(d).toBeLessThan(0.6)
    }
  })

  it('leaves a flat sea flat and a plain constant untouched', () => {
    const img = mapOf(32, 32, () => 13)
    const out = levelsOf(dequantiseHeightMap(img, 8), 32, 32)
    for (let i = 0; i < out.length; i++) expect(out[i]).toBeCloseTo(13, 5)
  })
})

describe('the identity, and the plumbing', () => {
  it('returns the plain sampler for a radius below one — the SAME object, not a copy', () => {
    const img = staircase(16, 0.3)
    const base = createMapSampler(img)
    // Not `toBe(base)` — a fresh sampler is built — but it must be bit-identical
    // to one, everywhere, so `smoothMetres: 0` samples exactly what LOD 0 does.
    const out = dequantiseHeightMap(img, 0)
    const a = { r: 0, g: 0, b: 0 }
    const b = { r: 0, g: 0, b: 0 }
    for (let i = 0; i <= 40; i++) {
      for (let j = 0; j <= 40; j++) {
        base.sample(i / 40, j / 40, a)
        out.sample(i / 40, j / 40, b)
        expect(b.r).toBe(a.r)
        expect(b.g).toBe(a.g)
        expect(b.b).toBe(a.b)
      }
    }
    expect(dequantiseHeightMap(img, 0.4)).not.toBe(base)
  })

  it('reads back as NEUTRAL grey, so grayscale() downstream is the identity', () => {
    const img = staircase(32, 0.2)
    const out = dequantiseHeightMap(img, 4)
    out.sample(0.37, 0.61, rgb)
    expect(rgb.g).toBe(rgb.r)
    expect(rgb.b).toBe(rgb.r)
  })

  it('takes the LUMINANCE of a coloured map, as buildVertexGrid does', () => {
    const data = new Uint8Array([200, 100, 50])
    const img: ImageData8 = { width: 1, height: 1, channels: 3, data }
    const lv = heightLevels(img)
    // Float32 storage: seven significant digits.
    expect(lv.data[0]).toBeCloseTo((0.299 * 200 + 0.587 * 100 + 0.114 * 50) / 255, 6)
  })

  it('converts smoothMetres to texels off the terrain size and the map width', () => {
    // 4096 m over 1024 texels is 4 m a texel on every shipped map: 48 m is 12.
    expect(smoothRadiusTexels(48, 4096, 1024)).toBe(12)
    // Kauai: 8192 m over 2048 texels, also 4 m.
    expect(smoothRadiusTexels(48, 8192, 2048)).toBe(12)
    expect(smoothRadiusTexels(0, 4096, 1024)).toBe(0)
    expect(smoothRadiusTexels(48, 0, 1024)).toBe(0)
  })

  it('is deterministic — two builds from one map agree to the bit', () => {
    const img = staircase(40, 0.17)
    const a = levelsOf(dequantiseHeightMap(img, 5), 40, 40)
    const b = levelsOf(dequantiseHeightMap(img, 5), 40, 40)
    expect(Array.from(a)).toEqual(Array.from(b))
  })

  it('feeds buildVertexGrid like any other sampler, and the grid is smooth where the map stepped', () => {
    const img = staircase(64, 0.11)
    const params: FacetedTerrainParams = {
      terrainSize: 256,
      terrainHeight: 255,
      chunkSize: 64,
      baseResolution: 4,
      randomOffset: 0,
      seed: 1,
    }
    const coarse = buildVertexGrid(createMapSampler(img), params)
    const fine = buildVertexGrid(dequantiseHeightMap(img, 12), params)
    // Row through the middle, heights only. Same length, same range, and the
    // reconstructed one has no two neighbours at exactly the same height.
    const n = coarse.vertPerSide
    let sameCoarse = 0
    let sameFine = 0
    for (let x = 16; x < n - 17; x++) {
      const y = 32
      const c0 = coarse.verts[(x * n + y) * 3 + 1] as number
      const c1 = coarse.verts[((x + 1) * n + y) * 3 + 1] as number
      const f0 = fine.verts[(x * n + y) * 3 + 1] as number
      const f1 = fine.verts[((x + 1) * n + y) * 3 + 1] as number
      if (Math.abs(c1 - c0) < 1e-4) sameCoarse++
      if (Math.abs(f1 - f0) < 1e-4) sameFine++
      expect(Math.abs(f0 - c0)).toBeLessThanOrEqual(0.5 + 1e-3)
    }
    expect(sameCoarse).toBeGreaterThan(20)
    expect(sameFine).toBe(0)
  })
})
