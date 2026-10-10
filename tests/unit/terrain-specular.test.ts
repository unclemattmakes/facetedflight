// tests/unit/terrain-specular.test.ts — `_SpecColor`, `_SpecInt`, `_Fresnel`.
//
// DEV-008's last open line was written down as *"`_SpecColor` on the terrain is
// (1, 0.434, 0.434) — a reddish specular — and `MeshStandardMaterial` has
// nowhere to put a coloured dielectric specular"*, which is true and is the
// small half of it. The port was dropping all THREE specular numbers and
// rendering every land terrain at three's default white dielectric F0 of 0.04,
// which on the environments nobody had measured is wrong by more than the
// colour is:
//
//   simonet.islands / kauai.terrain   F0 (0.0219, 0.0035, 0.0035)
//   alpine.forest  / menu.forest      F0 (0.0019, 0.0021, 0.0028)   21x too bright
//   desert.canyon                     F0 (0.1030, 0.0423, 0.0301)   2.6x too dim (red)
//
// The agreement lesson, in miniature: `_SpecInt` is 0.05 on the ONE environment
// the port is usually looked at, which is small enough to make the item read as
// not worth doing. It is 0.2 on alpine and 0.4 on desert.
//
// ── What these tests check, and what they refuse to check ────────────────
//
// They check the TRANSCRIPTION against the 2016 shader source — the literal
// 1.25, the fifth power, the sRGB conversion — and they check ORDERING facts
// that are true independently of anyone's belief about the formula. They do
// not assert "F0 is (0.0219, ...)", because that is the function's own answer
// written down twice; each number here is reachable from the shader lines
// quoted beside it.

import { describe, expect, it } from 'vitest'
import { TERRAIN } from '@/generated/constants.generated'
import { marmosetSpecularF0, THREE_DIELECTRIC_F0, terrainMaterial } from '@/render/terrain-mesh'

interface SpecLike {
  readonly intensity?: number | null
  readonly color?: readonly number[] | null
  readonly fresnel?: number | null
  readonly shininess?: number | null
}
interface MaterialLike {
  readonly shader?: string | null
  readonly specular?: SpecLike | null
}

const spec = (env: string, leaf: string): SpecLike => {
  const t = (
    TERRAIN as unknown as Record<string, { terrains: Record<string, { material: MaterialLike }> }>
  )[env]?.terrains?.[leaf]
  if (!t?.material?.specular) throw new Error(`no specular for ${env}.${leaf}`)
  return t.material.specular
}
const shader = (env: string, leaf: string): string | null => {
  const t = (
    TERRAIN as unknown as Record<string, { terrains: Record<string, { material: MaterialLike }> }>
  )[env]?.terrains?.[leaf]
  return t?.material?.shader ?? null
}

/** The same transfer function the tint uses, written out independently here. */
const srgb = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

describe('the Marmoset F0 is three numbers, not one colour', () => {
  it('is the identity for a white, full-intensity, zero-Fresnel material', () => {
    // `_SpecInt` 1, `_Fresnel` 0 -> saturate(1.25 - 0)^5 = 1 (the saturate is
    // load-bearing: 1.25^5 is 3.05). `_SpecColor` white -> linear white.
    const f0 = marmosetSpecularF0(1, 0, [1, 1, 1])
    expect(f0[0]).toBeCloseTo(1, 12)
    expect(f0[1]).toBeCloseTo(1, 12)
    expect(f0[2]).toBeCloseTo(1, 12)
  })

  it('saturates the bracket, so _Fresnel 0 and _Fresnel 0.25 give the same answer', () => {
    // `factor.xy = saturate((factor.xx * half2(-1, -fresnel)) + half2(1, 1.25))`
    // — 1.25 - 0.25 is exactly 1, and anything below that clamps to 1 too. A
    // port that dropped the `saturate` would give 3.05 at _Fresnel 0 and 1.0
    // at 0.25, so this separates the two readings.
    expect(marmosetSpecularF0(1, 0, [1, 1, 1])[0]).toBeCloseTo(
      marmosetSpecularF0(1, 0.25, [1, 1, 1])[0],
      12,
    )
  })

  it('raises the bracket to the FIFTH power, not the fourth', () => {
    // `factor.zw = factor.xy * factor.xy; factor.zw *= factor.zw;` is ^4, and
    // then `factor.xy = factor.xy * factor.zw` makes it ^5. Off by one power
    // and Simonet's 0.848 bracket gives 0.517 instead of 0.439 — 18 % of the
    // whole term.
    const fres = 0.5
    expect(marmosetSpecularF0(1, fres, [1, 1, 1])[0]).toBeCloseTo(0.75 ** 5, 12)
    expect(marmosetSpecularF0(1, fres, [1, 1, 1])[0]).not.toBeCloseTo(0.75 ** 4, 6)
  })

  it('LINEARISES _SpecColor, and the channel ratio is what says so', () => {
    // `_SpecColor ("Specular Color", Color)` is declared `Color` in the shader's
    // Properties block, exactly like `_Color`, and `m_ActiveColorSpace: 1`. So
    // Unity converts it on upload — the same argument as the material tint.
    //
    // The discriminating quantity is the RED:GREEN ratio of Simonet's
    // (1, 0.43382, 0.43382): raw it is 1 / 0.43382 = 2.305, linearised it is
    // 1 / srgbToLinear(0.43382) = 6.31. Nothing about the magnitude can tell
    // those apart; the ratio can, and it is 2.7x.
    const s = spec('simonet', 'islands')
    const f0 = marmosetSpecularF0(s.intensity as number, s.fresnel as number, s.color as number[])
    const ratio = (f0[0] as number) / (f0[1] as number)
    expect(ratio).toBeCloseTo(1 / srgb(0.43382353), 4)
    expect(ratio).not.toBeCloseTo(1 / 0.43382353, 2)
  })
})

describe('the four land terrains disagree about this by a factor of 55', () => {
  // The reason the item read as not worth doing for as long as it did: it was
  // only ever priced on Simonet. These are ORDERING facts against three's own
  // dielectric default, which is the number the port was using for all of them.
  const f0Of = (env: string, leaf: string): number[] => {
    const s = spec(env, leaf)
    return marmosetSpecularF0(s.intensity as number, s.fresnel as number, s.color as number[])
  }

  it('puts alpine well BELOW three_s default and desert well ABOVE it', () => {
    const alpine = f0Of('alpine', 'forest')
    const desert = f0Of('desert', 'canyon')
    // alpine: `_SpecInt` 0.2 but `_Fresnel` 0.814, so the bracket is
    // (1.25 - 0.814)^5 = 0.0158 and the product is tiny. The high `_SpecInt`
    // is a trap — it is the GRAZING reflectance, not the base one.
    expect(Math.max(...alpine)).toBeLessThan(THREE_DIELECTRIC_F0 / 10)
    // desert: `_SpecInt` 0.4 against `_Fresnel` 0.437.
    expect(desert[0] as number).toBeGreaterThan(THREE_DIELECTRIC_F0 * 2)
    // ...and they are 55x apart, which is the whole argument for porting it.
    expect((desert[0] as number) / Math.max(...alpine)).toBeGreaterThan(30)
  })

  it('keeps every land terrain a dielectric — no channel reflects like metal', () => {
    for (const [env, leaf] of [
      ['simonet', 'islands'],
      ['kauai', 'terrain'],
      ['alpine', 'forest'],
      ['menu', 'forest'],
      ['desert', 'canyon'],
    ] as const) {
      for (const c of f0Of(env, leaf)) {
        expect(c, `${env}.${leaf}`).toBeGreaterThan(0)
        expect(c, `${env}.${leaf}`).toBeLessThan(0.25)
      }
    }
  })
})

describe('the ocean is left alone', () => {
  it('gives the VacuumShaders terrains no specular colour at all', () => {
    // Its specular is an ADDITIVE Blinn lobe injected by `render/water.ts`
    // (`uSpec`), so an F0 here would be the same reflectance counted twice.
    const s = spec('simonet', 'ocean')
    const m = terrainMaterial({
      tint: null,
      shader: shader('simonet', 'ocean'),
      specular: {
        intensity: s.intensity ?? null,
        shininess: s.shininess ?? null,
        iblBrightness: null,
        color: s.color ?? null,
        fresnel: s.fresnel ?? null,
      },
    })
    expect('specularColor' in m).toBe(false)
  })

  it('gives the land one, scaled so intensity x colour is the measured F0', () => {
    const s = spec('desert', 'canyon')
    const m = terrainMaterial({
      tint: null,
      shader: shader('desert', 'canyon'),
      specular: {
        intensity: s.intensity ?? null,
        shininess: s.shininess ?? null,
        iblBrightness: null,
        color: s.color ?? null,
        fresnel: s.fresnel ?? null,
      },
    }) as unknown as {
      specularIntensity: number
      specularColor: { r: number; g: number; b: number }
    }
    const want = marmosetSpecularF0(s.intensity as number, s.fresnel as number, s.color as number[])
    // three computes F0 as `0.04 * specularIntensity * specularColor`, so the
    // PRODUCT of the two fields is what has to equal the measured reflectance.
    for (const [i, ch] of (['r', 'g', 'b'] as const).entries()) {
      expect(THREE_DIELECTRIC_F0 * m.specularIntensity * m.specularColor[ch]).toBeCloseTo(
        want[i] as number,
        9,
      )
    }
  })

  it('keeps the GRAZING reflectance at 1, which is where the split matters', () => {
    // `material.specularF90 = mix(specularIntensity, 1.0, metalness)`, and
    // metalness is 0 — so `specularIntensity` is not a free parameter, it is
    // the reflectance at 90 degrees. Carrying desert's magnitude there would
    // set F90 to 0.103 / 0.04 = 2.57: **257 % reflectance at grazing**, a
    // non-physical rim on every skyline ridge, on the environment with the
    // strongest specular in the game.
    //
    // So the whole scale goes in the colour and the intensity stays 1, which
    // leaves F90 exactly where `MeshStandardMaterial` had it. This asserts the
    // consequence rather than the field: F90 is `specularIntensity`, and it
    // must not exceed 1 on any land terrain.
    for (const [env, leaf] of [
      ['simonet', 'islands'],
      ['kauai', 'terrain'],
      ['alpine', 'forest'],
      ['menu', 'forest'],
      ['desert', 'canyon'],
    ] as const) {
      const s = spec(env, leaf)
      const m = terrainMaterial({
        tint: null,
        shader: shader(env, leaf),
        specular: {
          intensity: s.intensity ?? null,
          shininess: s.shininess ?? null,
          iblBrightness: null,
          color: s.color ?? null,
          fresnel: s.fresnel ?? null,
        },
      }) as unknown as { specularIntensity: number }
      expect(m.specularIntensity, `${env}.${leaf} F90`).toBeLessThanOrEqual(1)
    }
  })
})
