/**
 * `src/sim/math/scalar.ts`: the shared scalar kit (code-reuse audit WP-1).
 *
 * These pin the CONTRACTS the copies relied on, not just the happy path: the
 * ternary clamp's -0 and NaN behaviour, `mix` exact at both ends, `lerp` exact
 * at t = 0, `wrapPi`'s half-open range, and the GLSL hash's coefficients. A
 * change to any of these is a change to a golden trajectory or a shader
 * mirror somewhere, so each has to be edited on purpose.
 */
import { describe, expect, it } from 'vitest'
import {
  clamp,
  clamp01,
  DEG_PER_RAD,
  facetHash01,
  lerp,
  mix,
  RAD_PER_DEG,
  slewToward,
  smooth01,
  smoothstep,
  wrapPi,
} from '@/sim/math/scalar'
import { distance, distanceSq, v3 } from '@/sim/math/vec3'

describe('clamp and clamp01 (ternary form)', () => {
  it('holds a value to the range and returns the bounds themselves', () => {
    expect(clamp(5, 0, 1)).toBe(1)
    expect(clamp(-5, 0, 1)).toBe(0)
    expect(clamp(0.25, 0, 1)).toBe(0.25)
    expect(clamp(3, 2, 4)).toBe(3)
    expect(clamp01(1.5)).toBe(1)
    expect(clamp01(-0.5)).toBe(0)
    expect(clamp01(0.5)).toBe(0.5)
  })

  it('passes NaN through and keeps -0 (the ternary contract; Math.max(0, -0) is +0)', () => {
    expect(Number.isNaN(clamp(Number.NaN, 0, 1))).toBe(true)
    expect(Number.isNaN(clamp01(Number.NaN))).toBe(true)
    expect(Object.is(clamp(-0, 0, 1), -0)).toBe(true)
    expect(Object.is(clamp01(-0), -0)).toBe(true)
  })
})

describe('smoothstep and smooth01', () => {
  it('hits the endpoints exactly and the Hermite midpoint', () => {
    expect(smoothstep(2, 4, 1)).toBe(0)
    expect(smoothstep(2, 4, 2)).toBe(0)
    expect(smoothstep(2, 4, 4)).toBe(1)
    expect(smoothstep(2, 4, 9)).toBe(1)
    expect(smoothstep(2, 4, 3)).toBe(0.5)
    expect(smooth01(0.5)).toBe(0.5)
    expect(smooth01(-1)).toBe(0)
    expect(smooth01(2)).toBe(1)
  })

  it('is the same bits as the three clamp spellings it replaced, -0 included', () => {
    // The replaced copies clamped with `<`, with `<=` and with Math.min/max.
    // They agree everywhere because the clamped value is squared.
    const viaMinMax = (e0: number, e1: number, x: number): number => {
      const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
      return t * t * (3 - 2 * t)
    }
    const viaLte = (t: number): number => {
      const c = t <= 0 ? 0 : t >= 1 ? 1 : t
      return c * c * (3 - 2 * c)
    }
    for (const x of [-3, -0, 0, 0.1, 0.37, 0.5, 0.9, 1, 1.0000001, 7, Number.NaN]) {
      expect(Object.is(smoothstep(0, 1, x), viaMinMax(0, 1, x))).toBe(true)
      expect(Object.is(smooth01(x), viaLte(x))).toBe(true)
    }
    expect(Object.is(smoothstep(0, 1, -0), 0)).toBe(true)
  })
})

describe('mix and lerp round differently and both are kept', () => {
  it('mix is exact at a = 0 and a = 1; lerp is exact at t = 0', () => {
    const x = 0.1
    const y = 0.7
    expect(mix(x, y, 0)).toBe(x)
    expect(mix(x, y, 1)).toBe(y)
    expect(lerp(x, y, 0)).toBe(x)
    expect(mix(0, 10, 0.25)).toBe(2.5)
    expect(lerp(0, 10, 0.25)).toBe(2.5)
  })

  it('differ in the last bit for some inputs, which is why neither aliases the other', () => {
    let differs = 0
    for (let i = 1; i < 200; i++) {
      const a = i / 7
      const b = 1 - i / 13
      const t = i / 199
      if (mix(a, b, t) !== lerp(a, b, t)) differs++
    }
    expect(differs).toBeGreaterThan(0)
  })
})

describe('wrapPi', () => {
  it('maps into (-pi, pi], with pi kept and -pi sent to pi', () => {
    expect(wrapPi(0)).toBe(0)
    expect(wrapPi(Math.PI)).toBe(Math.PI)
    expect(wrapPi(-Math.PI)).toBe(Math.PI)
    expect(wrapPi(3 * Math.PI)).toBeCloseTo(Math.PI, 12)
    expect(wrapPi(-3 * Math.PI)).toBeCloseTo(Math.PI, 12)
    expect(wrapPi(Math.PI + 0.5)).toBeCloseTo(-Math.PI + 0.5, 12)
    const deg350 = (350 * Math.PI) / 180
    expect(wrapPi(deg350)).toBeCloseTo((-10 * Math.PI) / 180, 12)
  })
})

describe('the angle constants say their direction', () => {
  it('are PI / 180 and 180 / PI, by the same expressions the copies used', () => {
    expect(RAD_PER_DEG).toBe(Math.PI / 180)
    expect(DEG_PER_RAD).toBe(180 / Math.PI)
    expect(90 * RAD_PER_DEG).toBe(Math.PI / 2)
    expect(Math.PI * DEG_PER_RAD).toBe(180)
  })
})

describe('slewToward', () => {
  it('moves by at most the step and lands exactly on the target', () => {
    expect(slewToward(0, 1, 0.25)).toBe(0.25)
    expect(slewToward(1, 0, 0.25)).toBe(0.75)
    expect(slewToward(0.9, 1, 0.25)).toBe(1)
    expect(slewToward(0.1, 0, 0.25)).toBe(0)
    expect(slewToward(0.5, 0.5, 0.25)).toBe(0.5)
  })
})

describe('facetHash01', () => {
  it('is fract(sin(i * 12.9898 + 78.233) * 43758.5453), in [0, 1)', () => {
    for (let i = 0; i < 64; i++) {
      const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453
      expect(facetHash01(i)).toBe(x - Math.floor(x))
      expect(facetHash01(i)).toBeGreaterThanOrEqual(0)
      expect(facetHash01(i)).toBeLessThan(1)
    }
  })
})

describe('vec3.distanceSq', () => {
  it('sums dx*dx + dy*dy + dz*dz in that order, and is symmetric', () => {
    const a = v3(1, 2, 3)
    const b = v3(4, 6, 3)
    expect(distanceSq(a, b)).toBe(25)
    expect(distance(a, b)).toBe(5)
    const p = v3(0.1, 0.2, 0.3)
    const q = v3(0.7, 0.11, -0.4)
    const dx = p.x - q.x
    const dy = p.y - q.y
    const dz = p.z - q.z
    expect(distanceSq(p, q)).toBe(dx * dx + dy * dy + dz * dz)
    expect(distanceSq(q, p)).toBe(distanceSq(p, q))
  })
})
