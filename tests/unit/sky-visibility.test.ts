// tests/unit/sky-visibility.test.ts — how much sky the terrain leaves a facet.
//
// `docs/plan/SKY-VISIBILITY.md` §7 step 1: analytic cases first, then the
// march held against a DENSE march on a rough field at adversarial samples
// (off-diagonal, high relief, far from the origin), then the real maps.

import { describe, expect, it } from 'vitest'
import type { HeightField } from '@/sim/terrain/height-field'
import {
  buildSkyVisibility,
  buildSunRadiance,
  marchDistances,
  SKY_VISIBILITY_DEFAULTS,
  skyVisibilityAt,
  sliceWeight,
} from '@/sim/terrain/sky-visibility'
import { fieldFor, haveMaps, loadLevelJson } from './helpers/terrain-field'

/** A synthetic field: `n` samples on `step` metres, heights in METRES via a fn. */
const fieldOf = (
  n: number,
  step: number,
  metres: (x: number, z: number) => number,
): HeightField => {
  const terrainHeight = 1000
  const heights = new Float32Array(n * n)
  for (let z = 0; z < n; z++)
    for (let x = 0; x < n; x++) heights[z * n + x] = metres(x, z) / terrainHeight
  return {
    vertPerSide: n,
    heights,
    step,
    terrainSize: (n - 1) * step,
    terrainHeight,
    originX: 0,
    originY: 0,
    originZ: 0,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
  }
}

describe('sliceWeight — cos² of the horizon elevation, clamped at level', () => {
  it('is 1 at or below the horizontal and cos² above it', () => {
    expect(sliceWeight(-3)).toBe(1)
    expect(sliceWeight(0)).toBe(1)
    // 45°: cos² = 0.5.
    expect(sliceWeight(1)).toBeCloseTo(0.5, 12)
    // 60°: cos² = 0.25.
    expect(sliceWeight(Math.tan(Math.PI / 3))).toBeCloseTo(0.25, 12)
  })
})

describe('marchDistances', () => {
  it('runs geometrically from one grid step to the maximum', () => {
    const d = marchDistances(128, 8)
    expect(d[0]).toBe(1)
    expect(d[7]).toBeCloseTo(128, 9)
    for (let k = 1; k < d.length; k++) {
      expect((d[k] as number) / (d[k - 1] as number)).toBeCloseTo(128 ** (1 / 7), 9)
    }
  })
})

describe('buildSkyVisibility — planes see their whole sky', () => {
  it('is exactly 1 on a flat field, everywhere, edges included', () => {
    const v = buildSkyVisibility(
      fieldOf(33, 8, () => 120),
      { maxDistance: 400 },
    )
    expect(v.samplesPerSide).toBe(33)
    for (const x of v.values) expect(x).toBe(1)
    expect(v.min).toBe(1)
  })

  it('is 1 on a TILTED plane at any slope and heading: the probe already has the tilt', () => {
    // The whole reason for the denominator. Without it a 40° hillside in open
    // country reads as half-buried, because its horizon uphill is its own
    // surface. Interior texels only: the edge clamp turns the plane into a
    // plateau beyond the map, which is a real (if artificial) occluder.
    const n = 65
    const step = 8
    const maxDistance = 96 // 12 grid steps, so texels 13..51 never see an edge
    for (const [slope, headingDeg] of [
      [0.2, 0],
      [0.84, 37],
      [1.7, 200],
    ] as const) {
      const h = (headingDeg * Math.PI) / 180
      const f = fieldOf(n, step, (x, z) => 500 + slope * step * (x * Math.cos(h) + z * Math.sin(h)))
      const d = marchDistances(maxDistance / step, 24)
      for (const [gx, gz] of [
        [13, 13],
        [31, 20],
        [47, 51],
      ] as const) {
        // 5 places, not 6: the heights are Float32 and a 0.84 slope rounds.
        expect(skyVisibilityAt(f, gx, gz, d, 16), `slope ${slope} at ${headingDeg}°`).toBeCloseTo(
          1,
          5,
        )
      }
    }
  })
})

describe('buildSkyVisibility — a V-groove, against its closed form', () => {
  // h = s · |x − x0| metres: two walls rising at slope s either side of a
  // floor line along z. At the floor, the plane's own gradient is zero by
  // symmetry (central differences), so every slice's denominator is 1, and in
  // direction φ the wall rises at s·|cos φ| per metre FOREVER, so the horizon is
  // exactly that. V = mean over the azimuths of 1 / (1 + s² cos² φ), and its
  // continuous limit is 1 / √(1 + s²). The expectation is that sum, written out
  // from the geometry, not from the march.
  const n = 129
  const step = 8
  const x0 = 64
  for (const s of [0.3, 1, 2.5]) {
    it(`matches at slope ${s}`, () => {
      const f = fieldOf(n, step, (x) => 10 + s * step * Math.abs(x - x0))
      const azimuths = 16
      let expected = 0
      for (let a = 0; a < azimuths; a++) {
        const c = Math.cos((2 * Math.PI * a) / azimuths)
        expected += 1 / (1 + s * s * c * c)
      }
      expected /= azimuths
      // 400 m out from x0 is 50 steps: inside the map on both sides.
      const d = marchDistances(400 / step, 32)
      expect(skyVisibilityAt(f, x0, 64, d, azimuths)).toBeCloseTo(expected, 6)
      // And the discrete sum is near the continuous limit, which is the number
      // to have in your head: V ≈ 0.71 at 45° walls, 0.37 at 68°.
      expect(expected).toBeCloseTo(1 / Math.sqrt(1 + s * s), 1)
    })
  }
})

describe('buildSkyVisibility — the geometric march against a dense one', () => {
  // A rough field with relief at every scale: two ridge systems off the grid
  // axes, a pit, and hash noise. The dense march takes a sample every quarter
  // grid step out to the same distance, so the ONLY difference is the
  // geometric spacing — which is the approximation to hold.
  const n = 129
  const step = 8
  let seed = 20260923
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }
  const noise = Array.from({ length: n * n }, () => rnd() * 6)
  const f = fieldOf(
    n,
    step,
    (x, z) =>
      300 +
      120 * Math.sin(x * 0.11 + z * 0.047) +
      70 * Math.cos(x * 0.031 - z * 0.13) -
      180 * Math.exp(-((x - 83) ** 2 + (z - 41) ** 2) / 90) +
      (noise[z * n + x] as number),
  )
  const maxSteps = 512 / step
  const dense = new Float64Array(Math.round(maxSteps * 4))
  for (let k = 0; k < dense.length; k++) dense[k] = (k + 1) / 4

  it('agrees to 0.03 at adversarial samples, and to 0.01 on average', () => {
    const geometric = marchDistances(maxSteps, SKY_VISIBILITY_DEFAULTS.samples)
    // Off-diagonal, in the pit, on a ridge flank, and far from the origin.
    const picks: [number, number][] = [
      [83, 41],
      [80, 45],
      [97, 23],
      [111, 7],
      [23, 101],
      [64, 90],
      [37, 58],
      [120, 119],
    ]
    let sum = 0
    for (const [gx, gz] of picks) {
      const a = skyVisibilityAt(f, gx, gz, geometric, 16)
      const b = skyVisibilityAt(f, gx, gz, dense, 16)
      expect(Math.abs(a - b), `at ${gx},${gz}: ${a} vs ${b}`).toBeLessThan(0.03)
      sum += Math.abs(a - b)
    }
    expect(sum / picks.length).toBeLessThan(0.01)
  })

  it('reads the pit as enclosed and the ridge top as open', () => {
    const v = buildSkyVisibility(f, { maxDistance: 512 })
    const at = (x: number, z: number) => v.values[z * v.samplesPerSide + x] as number
    expect(at(83, 41)).toBeLessThan(0.8)
    expect(at(83, 41)).toBeLessThan(at(64, 64))
    expect(v.min).toBeGreaterThan(0)
    expect(v.mean).toBeLessThan(1)
  })
})

describe('the bounce — the sky V takes away comes back as lit terrain', () => {
  const rough = (n: number, step: number) =>
    fieldOf(
      n,
      step,
      (x, z) =>
        200 + 90 * Math.sin(x * 0.19 + z * 0.07) + 60 * Math.cos(x * 0.05 - z * 0.23) + 3 * (x % 3),
    )

  it('under UNIFORM radiance c is exactly c times the terrain share of the facet’s hemisphere', () => {
    // True on any terrain, whatever the geometry, which is why it is the test:
    // it checks the band bookkeeping without believing anything about a shape.
    // `out[3]` is the open-sky share of the facet's WHOLE cosine hemisphere;
    // V is only its upper half, so the identity pairs with `out[3]`, not V.
    const n = 65
    const f = rough(n, 8)
    const c = [0.3, 0.2, 0.1]
    const radiance = new Float32Array(n * n * 3)
    for (let i = 0; i < n * n; i++) radiance.set(c, i * 3)
    const d = marchDistances(300 / 8, 32)
    const out = new Float64Array(4)
    let enclosed = 0
    for (const [gx, gz] of [
      [7, 51],
      [33, 12],
      [40, 44],
      [58, 3],
      [21, 29],
    ] as const) {
      skyVisibilityAt(f, gx, gz, d, 16, radiance, out)
      const terrain = 1 - (out[3] as number)
      if (terrain > 0.05) enclosed++
      for (let k = 0; k < 3; k++) {
        // `fround`: the radiance is Float32, so 0.3 is stored as 0.30000001.
        const want = Math.fround(c[k] as number) * terrain
        expect(out[k], `at ${gx},${gz} channel ${k}`).toBeCloseTo(want, 9)
      }
    }
    // The identity is vacuous with no terrain in view; make sure there is some.
    expect(enclosed).toBeGreaterThan(1)
  })

  it('reaches a steep wall from the lit floor BELOW its horizon (the mesa canyon wall)', () => {
    // A 70° cliff face rising from a flat floor, nothing above the horizon for
    // the wall to see: every bit of terrain it sees is floor, below the
    // horizontal. Weighted against the vertical (DEV-333's first cut) this
    // was ZERO, and mesa canyon's darkest walls did not move by a level.
    const n = 129
    const step = 8
    const x0 = 64
    const rise = Math.tan((70 * Math.PI) / 180) * step
    // The cliff face rises toward −x, so it faces +x, out over the floor.
    const f = fieldOf(n, step, (x) => (x >= x0 ? 20 : 20 + (x0 - x) * rise))
    const floorLit = new Float32Array(n * n * 3)
    for (let z = 0; z < n; z++)
      for (let x = x0; x < n; x++) floorLit.set([0.5, 0.35, 0.25], (z * n + x) * 3)
    const d = marchDistances(400 / step, 32)
    const out = new Float64Array(4)
    // Halfway up the face.
    skyVisibilityAt(f, x0 - 4, 64, d, 16, floorLit, out)
    // A vertical wall over an infinite lit floor gets half of it; a 70° face,
    // which leans back toward the sky, gets less. Well above zero either way.
    expect(out[0]).toBeGreaterThan(0.5 * 0.2)
    expect(out[0]).toBeLessThan(0.5 * 0.5)
  })

  it('is zero on a flat field: nothing rises, nothing bounces', () => {
    const n = 33
    const radiance = new Float32Array(n * n * 3).fill(0.5)
    const v = buildSkyVisibility(
      fieldOf(n, 8, () => 40),
      { maxDistance: 200 },
      radiance,
    )
    expect(v.maxBounce).toBe(0)
  })

  it('in a canyon with ONE wall lit, is exactly half of what two lit walls give', () => {
    // The mesa canyon in one line: a flat floor 8 steps wide between two
    // walls, and only the east one in sun. By mirror symmetry the lit wall
    // fills exactly half the lost sky. The floor is FLAT on purpose: with the
    // receiver on a V's kink, each slice's band lands on its first sample,
    // under a step out, whose radiance blends both sides bilinearly.
    const n = 129
    const step = 8
    const x0 = 64
    const s = 1.2
    const f = fieldOf(n, step, (x) => 10 + s * step * Math.max(0, Math.abs(x - x0) - 4))
    const lit = new Float32Array(n * n * 3)
    const both = new Float32Array(n * n * 3)
    for (let z = 0; z < n; z++)
      for (let x = 0; x < n; x++) {
        both.set([0.6, 0.4, 0.3], (z * n + x) * 3)
        if (x > x0) lit.set([0.6, 0.4, 0.3], (z * n + x) * 3)
      }
    const d = marchDistances(400 / step, 32)
    const one = new Float64Array(3)
    const two = new Float64Array(3)
    skyVisibilityAt(f, x0, 64, d, 16, lit, one)
    skyVisibilityAt(f, x0, 64, d, 16, both, two)
    expect(two[0]).toBeGreaterThan(0.05)
    for (let k = 0; k < 3; k++) expect(one[k]).toBeCloseTo((two[k] as number) / 2, 9)
  })
})

describe('buildSunRadiance', () => {
  it('is albedo · sin(elevation) on flat ground, and zero where the sun is blocked', () => {
    const n = 9
    const f = fieldOf(n, 8, () => 30)
    const albedo = new Float32Array(n * n * 3).fill(0.5)
    const e = (20 * Math.PI) / 180
    const toSun = [Math.cos(e), Math.sin(e), 0] as const
    const lit = new Float32Array(n * n).fill(1)
    lit[40] = 0
    const r = buildSunRadiance(f, toSun, albedo, lit)
    expect(r[0]).toBeCloseTo(0.5 * Math.sin(e), 6)
    expect(r[40 * 3]).toBe(0)
  })

  it('reads a slope facing the sun head-on as the full albedo', () => {
    // A 45° plane rising toward −x faces +x and up; a sun along that normal.
    const n = 9
    const step = 8
    const f = fieldOf(n, step, (x) => 200 - step * x)
    const albedo = new Float32Array(n * n * 3).fill(0.8)
    const r = buildSunRadiance(f, [Math.SQRT1_2, Math.SQRT1_2, 0], albedo, null)
    expect(r[(4 * n + 4) * 3]).toBeCloseTo(0.8, 5)
  })
})

describe('buildSkyVisibility — stride', () => {
  it('computes exactly the texels a stride-1 bake computes at those texels', () => {
    const f = fieldOf(33, 8, (x, z) => 50 * Math.sin(x * 0.4) * Math.cos(z * 0.3))
    const full = buildSkyVisibility(f, { maxDistance: 200 })
    const half = buildSkyVisibility(f, { maxDistance: 200, stride: 2 })
    expect(half.samplesPerSide).toBe(17)
    for (let j = 0; j < 17; j++)
      for (let i = 0; i < 17; i++)
        expect(half.values[j * 17 + i]).toBe(full.values[j * 2 * 33 + i * 2])
  })

  it('refuses a stride that does not divide the grid', () => {
    expect(() =>
      buildSkyVisibility(
        fieldOf(33, 8, () => 0),
        { stride: 3 },
      ),
    ).toThrow(/stride/)
  })
})

describe.skipIf(!haveMaps)('buildSkyVisibility — the shipped islands', () => {
  // Disk work inside the `it`, never in the describe body: CLAUDE.md's
  // `describe.skipIf` trap.
  it('int_01_hoverJet: enclosed ground exists, and the bake is affordable', () => {
    const field = fieldFor(loadLevelJson('int_01_hoverJet'))
    const t0 = performance.now()
    const v = buildSkyVisibility(field)
    const ms = performance.now() - t0
    expect(v.samplesPerSide).toBe(field.vertPerSide)
    expect(v.min).toBeLessThan(0.6)
    expect(v.mean).toBeGreaterThan(0.8)
    // Generous: this runs at world attach behind the loading curtain.
    expect(ms).toBeLessThan(8000)
  })
})

describe.skipIf(haveMaps)('buildSkyVisibility — the shipped islands (no maps here)', () => {
  it('is skipped because the gitignored maps are absent, and says so', () => {
    expect(haveMaps).toBe(false)
  })
})
