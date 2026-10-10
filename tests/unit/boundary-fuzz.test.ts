/**
 * The out-of-bounds static — DEV-127.
 *
 * Matt, 2026-09-16: *"let's do a 'fuzzy screen' visual if players go out of
 * bounds."* Three claims, each against something outside the module:
 *
 *  1. The PROGRESS is the sim's own clock (`sim/boundary.ts`), read by the
 *     legitimate sequence — inside, then out — never by teleporting a fresh
 *     state (DEV-074's lesson).
 *  2. The centre of the frame stays clear until the clock is out: on the
 *     shipped 13 s (`content/levels/int_01_hoverJet.json`, extracted) the
 *     centre pixel is untouched with two seconds left, and with one.
 *  3. Classic draws none of it — `enabled: false` AND `strength: 0`, the
 *     no-op twice over — and the vignette's quad is invisible with it off.
 */
import type * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { Edition, EditionBoundaryFuzz } from '@/content/edition-schema'
import { editionFeatures, validateEdition } from '@/content/edition-schema'
import { FEATHER, R_OPEN } from '@/render/aperture'
import {
  createBoundaryFuzz,
  FUZZ_GRAIN,
  FUZZ_HZ,
  FUZZ_SEED_WRAP,
  fuzzFor,
  R_CORNER,
} from '@/render/boundary-fuzz'
import { createVignette } from '@/render/vignette'
import {
  type BoundarySpec,
  boundaryCountdown,
  boundaryProgress,
  createBoundary,
  stepBoundary,
} from '@/sim/boundary'
import { FIXED_DT } from '@/sim/constants'
import anniversary from '../../content/editions/anniversary.json'
import classic from '../../content/editions/classic.json'
import int01 from '../../content/levels/int_01_hoverJet.json'

const ANNIV = (anniversary as unknown as Edition).boundary.fuzz
const CLASSIC = (classic as unknown as Edition).boundary.fuzz

/** `int_01`'s boundary, as the loader builds it — the shipped 13 s. */
const spec: BoundarySpec = {
  enabled: int01.boundary.enabled,
  centre: { x: 0, y: 0, z: 0 },
  radius: int01.boundary.volume?.radius ?? 0,
  resetDelaySeconds: int01.boundary.resetDelay,
  fadeSeconds: int01.boundary.resetFadeSeconds ?? 2.5,
}
const INSIDE = { x: 0, y: 0, z: 0 }
const OUTSIDE = { x: spec.radius * 2, y: 0, z: 0 }

/** A state that has been inside (armed) and is `seconds` into an excursion. */
const outsideFor = (seconds: number) => {
  const s = createBoundary()
  stepBoundary(s, spec, INSIDE, FIXED_DT)
  let t = 0
  while (t < seconds) {
    stepBoundary(s, spec, OUTSIDE, FIXED_DT)
    t += FIXED_DT
  }
  return s
}

describe('the progress is the boundary clock, read continuously', () => {
  it('is 0 inside, and 0 outside before the ship has ever been in (DEV-074)', () => {
    const s = createBoundary()
    stepBoundary(s, spec, OUTSIDE, FIXED_DT)
    expect(boundaryProgress(s, spec)).toBe(0)
    stepBoundary(s, spec, INSIDE, FIXED_DT)
    expect(boundaryProgress(s, spec)).toBe(0)
  })

  it('rises linearly across the shipped resetDelay and agrees with the banner', () => {
    expect(spec.resetDelaySeconds).toBe(13)
    for (const seconds of [1, 3.25, 6.5, 9.75, 12]) {
      const s = outsideFor(seconds)
      const u = boundaryProgress(s, spec)
      expect(u).toBeCloseTo(seconds / 13, 2)
      // Same clock as the banner: ceil(13 − outsideFor) seconds left.
      expect(boundaryCountdown(s, spec)).toBe(Math.ceil(13 - s.outsideFor))
    }
  })

  it('is 1 for the whole of dying, and 0 again once the run restarts', () => {
    const s = outsideFor(13.5)
    expect(s.phase).toBe('dying')
    expect(boundaryProgress(s, spec)).toBe(1)
    let restarted = false
    for (let i = 0; i < 400 && !restarted; i++) {
      restarted = stepBoundary(s, spec, OUTSIDE, FIXED_DT)
    }
    expect(restarted).toBe(true)
    expect(boundaryProgress(s, spec)).toBe(0)
  })

  it('zeroes the moment you come back inside — a dip is free', () => {
    const s = outsideFor(6)
    expect(boundaryProgress(s, spec)).toBeGreaterThan(0.4)
    stepBoundary(s, spec, INSIDE, FIXED_DT)
    expect(boundaryProgress(s, spec)).toBe(0)
  })

  it('never reads a mission with no boundary', () => {
    const off: BoundarySpec = { ...spec, enabled: false }
    const s = createBoundary()
    stepBoundary(s, off, INSIDE, FIXED_DT)
    stepBoundary(s, off, OUTSIDE, FIXED_DT)
    expect(boundaryProgress(s, off)).toBe(0)
  })
})

describe('the static, from the progress', () => {
  it('is nothing with the flag off, at progress zero, or at strength zero', () => {
    expect(fuzzFor(ANNIV, 0, 0)).toBeNull()
    expect(fuzzFor({ enabled: false, strength: 1 }, 0.5, 0)).toBeNull()
    expect(fuzzFor({ enabled: true, strength: 0 }, 0.5, 0)).toBeNull()
  })

  it('has a level of strength x progress, capped at 1', () => {
    for (const u of [0.1, 0.25, 0.5, 0.75, 0.95, 1]) {
      expect(fuzzFor(ANNIV, u, 0)?.level).toBeCloseTo(Math.min(1, ANNIV.strength * u), 9)
    }
    expect(fuzzFor({ enabled: true, strength: 1 }, 2, 0)?.level).toBe(1)
  })

  it('comes in from the CORNERS: the clear disc starts at the corner and closes to zero', () => {
    // The corner is the farthest pixel: a disc of that radius touches nothing.
    expect(R_CORNER).toBeCloseTo(Math.hypot(0.5, 0.5), 12)
    expect(R_CORNER).toBeLessThan(R_OPEN)
    const early = fuzzFor(ANNIV, 0.01, 0)
    expect(early?.clearRadius).toBeCloseTo(R_CORNER * (1 - 0.01 * 0.01), 9)
    expect(fuzzFor(ANNIV, 1, 0)?.clearRadius).toBe(0)
    let last = Number.POSITIVE_INFINITY
    for (let u = 0.05; u <= 1; u += 0.05) {
      const r = fuzzFor(ANNIV, u, 0)?.clearRadius ?? Number.NaN
      expect(r).toBeLessThan(last)
      last = r
    }
    expect(early?.feather).toBe(FEATHER)
    expect(early?.grain).toBe(FUZZ_GRAIN)
  })

  it('leaves the CENTRE PIXEL untouched with two seconds left, and with one', () => {
    // The shader's band is smoothstep(clear, clear + feather, r); at r = 0 it
    // is zero for any clear radius above zero. Re-derived here in TS so the
    // claim is about the numbers the JSON ships, not about the formula.
    const band = (clear: number, r: number) => {
      const t = Math.min(1, Math.max(0, (r - clear) / FEATHER))
      return t * t * (3 - 2 * t)
    }
    for (const left of [2, 1]) {
      const s = outsideFor(13 - left)
      const f = fuzzFor(ANNIV, boundaryProgress(s, spec), 0)
      expect(f, `${left} s left`).not.toBeNull()
      expect(f?.clearRadius ?? 0, `${left} s left: a disc is still clear`).toBeGreaterThan(0)
      expect(band(f?.clearRadius ?? 0, 0), `${left} s left: centre pixel`).toBe(0)
    }
    // And at the edge midpoint (r = 0.5) with two seconds left it is FULL: the
    // periphery is all noise while the middle is still readable.
    const two = fuzzFor(ANNIV, boundaryProgress(outsideFor(11), spec), 0)
    expect(band(two?.clearRadius ?? 0, 0.5)).toBe(1)
  })

  it('keeps the RETURN banner legible until the last two or three seconds', () => {
    // The banner is on the dashboard, not at the centre: `hud.ts` draws it at
    // 0.54 of the panel's height, and the panel sits low in the frame, so its
    // text is at r ≈ 0.28 UV. This is why the disc closes on the SQUARE of the
    // progress — photographed with a linear disc, the banner was in the noise
    // with four seconds left.
    const BANNER_R = 0.28
    const band = (clear: number, r: number) => {
      const t = Math.min(1, Math.max(0, (r - clear) / FEATHER))
      return t * t * (3 - 2 * t)
    }
    const at = (left: number) => {
      const f = fuzzFor(ANNIV, boundaryProgress(outsideFor(13 - left), spec), 0)
      return band(f?.clearRadius ?? 0, BANNER_R)
    }
    expect(at(4), '4 s left: untouched').toBe(0)
    expect(at(3), '3 s left: untouched').toBe(0)
    expect(at(2), '2 s left: going').toBeGreaterThan(0.3)
    expect(at(1), '1 s left: gone').toBeGreaterThan(0.95)
    // And the static is not legible at all in the FIRST seconds: a disc wider
    // than the corner draws nothing, so the banner and the alarm carry the
    // warning alone until the clock is well under way.
    const first = fuzzFor(ANNIV, boundaryProgress(outsideFor(2), spec), 0)
    expect(band(first?.clearRadius ?? 0, R_CORNER)).toBeLessThan(0.05)
  })

  it('reaches the centre only when the clock is out', () => {
    const f = fuzzFor(ANNIV, 1, 0)
    expect(f?.clearRadius).toBe(0)
    expect(f?.level).toBeCloseTo(ANNIV.strength, 9)
  })
})

describe('the grain clock', () => {
  it(`advances ${FUZZ_HZ} frames a second, whatever the display rate, and wraps`, () => {
    const at72 = createBoundaryFuzz()
    const at144 = createBoundaryFuzz()
    for (let i = 0; i < 72; i++) at72.update(1 / 72)
    for (let i = 0; i < 144; i++) at144.update(1 / 144)
    expect(at72.seed).toBeGreaterThanOrEqual(FUZZ_HZ - 1)
    expect(at72.seed).toBeLessThanOrEqual(FUZZ_HZ)
    expect(at144.seed).toBe(at72.seed)
    for (let i = 0; i < 10_000; i++) at72.update(0.1)
    expect(at72.seed).toBeLessThan(FUZZ_SEED_WRAP)
    expect(at72.seed).toBeGreaterThanOrEqual(0)
  })

  it('is below the display rate — the comfort answer a screen-fixed effect owes', () => {
    expect(FUZZ_HZ).toBeLessThan(72)
  })

  it('ignores a negative delta and hands its seed to the frame', () => {
    const fz = createBoundaryFuzz()
    fz.update(-5)
    expect(fz.seed).toBe(0)
    fz.update(0.5)
    expect(fz.frame(ANNIV, 0.5)?.seed).toBe(fz.seed)
  })
})

describe('the presets', () => {
  it('Classic has the flag off AND the strength at zero — the no-op twice over', () => {
    expect(CLASSIC.enabled).toBe(false)
    expect(CLASSIC.strength).toBe(0)
    expect(fuzzFor({ ...CLASSIC, enabled: true }, 1, 0)).toBeNull()
  })

  it('Anniversary ships it on, below total signal loss', () => {
    expect(ANNIV.enabled).toBe(true)
    expect(ANNIV.strength).toBeGreaterThan(0)
    expect(ANNIV.strength).toBeLessThan(1)
  })

  it('is walked as a feature, so the Classic-is-all-off test sees it', () => {
    const paths = editionFeatures(anniversary as unknown as Edition).map(([p]) => p)
    expect(paths).toContain('boundary.fuzz')
  })

  it('refuses a strength outside 0..1 at load', () => {
    const bad = (strength: number): Edition =>
      ({
        ...(anniversary as unknown as Edition),
        boundary: { fuzz: { enabled: true, strength } as EditionBoundaryFuzz },
      }) as Edition
    expect(() => validateEdition(bad(1.5))).toThrow(/boundary\.fuzz\.strength/)
    expect(() => validateEdition(bad(-0.1))).toThrow(/boundary\.fuzz\.strength/)
    expect(() => validateEdition(bad(Number.NaN))).toThrow(/boundary\.fuzz\.strength/)
    expect(() => validateEdition(bad(0.5))).not.toThrow()
  })
})

describe('on the vignette quad', () => {
  it('draws nothing at rest, something with a frame, and nothing again on null', () => {
    const v = createVignette({ setting: 'off' })
    v.update(null, 1 / 72)
    expect(v.object.visible).toBe(false)
    expect(v.fuzzLevel).toBe(0)
    v.setFuzz(fuzzFor(ANNIV, 0.5, 3))
    expect(v.object.visible).toBe(true)
    expect(v.fuzzLevel).toBeCloseTo(ANNIV.strength * 0.5, 9)
    v.setFuzz(null)
    expect(v.object.visible).toBe(false)
    expect(v.fuzzLevel).toBe(0)
    v.dispose()
  })

  it('is on the UI side of the tone-mapping line, like the pulse', () => {
    const v = createVignette()
    const mat = (v.object as THREE.Mesh).material as THREE.ShaderMaterial
    expect(mat.toneMapped).toBe(false)
    expect(mat.uniforms.uFuzz).toBeDefined()
    expect(mat.uniforms.uFuzzSeed).toBeDefined()
    // The compositing order is the whole point: pulse, then static, then black.
    const src = mat.fragmentShader
    expect(src.indexOf('uPulseColor * pulse')).toBeLessThan(src.indexOf('vec3(grey) * fuzz'))
    expect(src.indexOf('vec3(grey) * fuzz')).toBeLessThan(src.indexOf('uColor * black'))
    v.dispose()
  })

  it('clamps a level above 1 and refuses a zero grain', () => {
    const v = createVignette()
    v.setFuzz({ level: 3, clearRadius: -1, feather: FEATHER, grain: 0, seed: 1 })
    const mat = (v.object as THREE.Mesh).material as THREE.ShaderMaterial
    const f = mat.uniforms.uFuzz?.value as THREE.Vector4
    expect(f.x).toBe(1)
    expect(f.y).toBe(0)
    expect(f.w).toBe(1)
    v.dispose()
  })
})
