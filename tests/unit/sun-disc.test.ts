// tests/unit/sun-disc.test.ts — the sun has a surface of its own now.
//
// DEV-293, wishlist #22b. Matt: *"our 'sun' shows up oddly on the faceted sky.
// maybe it should be a bloom instead?"* Photographed at
// `?view=cam&cam=sky-only` on `int_01_hoverJet`: an angular, asymmetric SHARD
// with a spike up-left and another right. That was the brightest few TRIANGLES
// of the dome clipped to white, because the disc was a term inside a field
// sampled once per 1.4-degree face and the disc is 1.8 degrees across.
//
// `generateSunCap` gives it a surface at its own angular scale, and
// `tests/unit/sky-dome.test.ts` covers the geometry. What is left is the pair
// of claims that live in `render/sky.ts` and that geometry alone cannot make:
//
//   1. the SHAPE of the profile — a plateau with a monotonic shoulder, not a
//      spike, because a spike would put the whole sun on one vertex and this
//      would be the old bug at a finer tessellation;
//   2. the disc is still brighter than the bloom's high pass, which is the
//      feature §2c actually asked for (*"maybe it should be a bloom instead"*)
//      and which the edition JSON's own note already names.
//
// (2) is checked against the shipped mission and the shipped edition file —
// two files this module does not import and does not know about — rather than
// against a number re-derived the way `sky.ts` derives it. A test that
// recomputes its expectation the way the code does has not tested the code.
//
// ── What is NOT here, and why that is the stronger answer ─────────────────
//
// The pairing between the falloff's zero and the cap's outer radius. That was
// the first thing written in this file, and it was a tautology:
// `SUN_DISC_OUTER_RADIANS` is `acos` of the very cosine `sunDiscAt` steps on,
// there is one name for it, and `bake` hands that name straight to
// `generateSunCap`. The test asserted `acos` is the inverse of `cos`. Check the
// PREMISE, not the outcome — the guarantee is in the derivation, it is written
// down at the constant, and a green run of a tautology would have argued for
// coverage this file does not have.
import { describe, expect, it } from 'vitest'
import { SKY_TUNING, SUN_CAP_TRIANGLES, sunDiscAt, sunDiscOuterRadians } from '@/render/sky'
import anniversary from '../../content/editions/anniversary.json'
import int01 from '../../content/levels/int_01_hoverJet.json'

/** Rec.709 luminance, which is what three's `UnrealBloomPass` thresholds on. */
const luminance = (rgb: readonly number[]): number =>
  0.2126 * (rgb[0] as number) + 0.7152 * (rgb[1] as number) + 0.0722 * (rgb[2] as number)

/**
 * The whole slider, end to end, plus the shipped setting.
 *
 * Every shape claim below is made at EVERY one of these, because the thing a
 * size control has to be is *the same sun, bigger* — a profile that changed
 * shape across its own range would be a different sun at each setting, and a
 * test run only at the default could not tell.
 */
const SIZES = [0.25, 0.5, 1, 2, 3, 5, 8] as const

describe('the sun disc profile, at every size the slider offers', () => {
  it('is a disc and not a point: lit across most of the surface it is given', () => {
    // The failure this catches is a profile collapsed toward its centre —
    // every vertex but the apex at zero, which is one bright triangle and
    // therefore the shard again at a finer tessellation. The claim is about
    // the FRACTION of the cap that carries light, which is true independently
    // of what the edge angles happen to be.
    for (const size of SIZES) {
      const rim = sunDiscOuterRadians(size)
      let lit = 0
      const samples = 400
      for (let i = 0; i < samples; i++) {
        if (sunDiscAt(Math.cos((rim * i) / samples), size) > 0) lit++
      }
      expect(lit / samples, `size ${size}`).toBeGreaterThan(0.9)
      // And it really does go out: a profile that never reached zero would
      // leave a hard step at the rim where the cap meets the dome.
      expect(sunDiscAt(Math.cos(rim), size), `size ${size} rim`).toBe(0)
    }
  })

  it('is monotonic from the rim to the core, and flat inside it', () => {
    for (const size of SIZES) {
      const rim = sunDiscOuterRadians(size)
      let previous = -1
      for (let i = 0; i <= 200; i++) {
        // Walk INWARD, so the profile must never decrease.
        const value = sunDiscAt(Math.cos(rim * (1 - i / 200)), size)
        expect(value, `size ${size} at ring ${i}`).toBeGreaterThanOrEqual(previous)
        previous = value
      }
      // The core is a plateau: everything at or inside it is one brightness,
      // so the disc has a flat blown-out middle rather than one hot vertex.
      expect(sunDiscAt(1, size), `size ${size} centre`).toBe(previous)
      expect(sunDiscAt(Math.cos(rim * 0.1), size), `size ${size} inner`).toBe(previous)
    }
  })

  it('is the SAME sun at every size — the core is a fixed fraction of the rim', () => {
    // This is the claim that makes it a size control rather than seven suns.
    // Measured as a RATIO, so it is true whatever the two angles are and
    // whatever the slider is set to: find the radius where the plateau starts,
    // as a fraction of the radius where the light ends.
    const coreFractionAt = (size: number): number => {
      const rim = sunDiscOuterRadians(size)
      const peak = sunDiscAt(1, size)
      // Walk out from the centre to the first sample that is off the plateau.
      const samples = 20_000
      for (let i = 0; i <= samples; i++) {
        const t = i / samples
        if (sunDiscAt(Math.cos(rim * t), size) < peak) return t
      }
      return 1
    }
    const reference = coreFractionAt(1)
    // 0.5730 / 1.8118 degrees. Stated once so the fraction is a number a
    // reader can check against the two constants, not just against itself.
    expect(reference).toBeCloseTo(0.3163, 3)
    for (const size of SIZES) {
      expect(coreFractionAt(size), `size ${size}`).toBeCloseTo(reference, 3)
    }
  })

  it('scales the ANGLE linearly, which is what "3x the size" means', () => {
    // A cosine scaled instead of an angle would still compile and still draw a
    // sun — just the wrong one, nonlinearly — so this is the assertion that
    // the multiplier means what the slider's label says.
    const oneX = sunDiscOuterRadians(1)
    expect((oneX * 180) / Math.PI, 'DEV-293 1x rim, in degrees').toBeCloseTo(1.812, 2)
    for (const size of SIZES) {
      expect(sunDiscOuterRadians(size) / oneX, `size ${size}`).toBeCloseTo(size, 9)
    }
  })

  it('ships at 3x, which is Matt s call and not a default nobody chose', () => {
    // DEV-294, 2026-09-22: "i'd like it to be 3x the current size", said after
    // looking at the 1x frame. Pinned by VALUE in one place somebody has to
    // edit on purpose — the DEV-266 rule — because `lookdev` reads it, the
    // bake reads it, and a photo spec asserts a diameter that follows from it.
    expect(SKY_TUNING.sunSize).toBe(3)
    expect((sunDiscOuterRadians(SKY_TUNING.sunSize) * 180) / Math.PI).toBeCloseTo(5.435, 2)
  })
})

describe('the sun disc against the frame it has to survive', () => {
  it('clears the bloom high pass on its own, without the threshold moving', () => {
    // DEV-091's rule, quoted in the wishlist's §2c as a caution for whoever
    // took this row: the disc should clear the threshold by being bright, not
    // by the threshold being lowered to meet it.
    const sun = int01.lighting.sun.colorLinear
    const threshold = anniversary.render.bloom.threshold
    const peak = sunDiscAt(1, SKY_TUNING.sunSize)
    expect(luminance(sun.map((c) => c * peak))).toBeGreaterThan(threshold)
    // And the sky AROUND it does not, or the bloom is a wash over the whole
    // dome rather than a halo on the sun. The brightest thing the cap's rim
    // can carry is the glow, which tops out below the sun's own colour.
    expect(luminance(sun)).toBeLessThan(threshold)
  })

  it('does not let the size dial change the brightness of a single pixel', () => {
    // The gain is deliberately not scaled with the size (see `SUN_DISC_GAIN`),
    // so a bigger sun is more pixels at the same radiance rather than brighter
    // pixels. Worth an assertion because the opposite — a peak that drifts
    // with the slider — is the shape of a control that quietly retunes the
    // bloom, and the threshold is the one number DEV-091 says not to move.
    const peaks = SIZES.map((s) => sunDiscAt(1, s))
    expect(new Set(peaks).size, `peaks were ${peaks.join(', ')}`).toBe(1)
  })

  it('costs a rounding error of the dome it is welded into, at every size', () => {
    // The shipped dome is subdivision 5 — 20,480 faces. A sun that cost a
    // meaningful fraction of that would be a perf row rather than a look row,
    // and this frame is 75 % fill (NEXT.md's A/B).
    //
    // `SUN_CAP_TRIANGLES` takes no size, which is the point: the slider scales
    // the cap's ANGLES and never its tessellation, so no census row, no draw
    // call and no vertex count is a function of where it is left.
    expect(SUN_CAP_TRIANGLES).toBeLessThan(20_480 * 0.05)
    // Not zero, which is what a cap built with no rings would be.
    expect(SUN_CAP_TRIANGLES).toBeGreaterThan(0)
  })
})
