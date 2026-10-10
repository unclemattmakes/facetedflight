// tests/unit/terrain-roughness.test.ts — `_Shininess` to GGX roughness.
//
// Split out of `terrain-mesh.test.ts`, which is about the Unity-to-three
// handedness conversion and had acquired a second subject.
//
// ── What is under test ────────────────────────────────────────────────────
//
// Two third-party shaders, two scales, one identically-named property:
//
//   land   `Marmoset Specular IBL`   `_Shininess ("Specular Sharpness", Range(2.0, 8.0))`
//   water  VacuumShaders legacy      `_Shininess ("Shininess", Range(0.01, 1))`
//
// One mapping was once applied to both, and the water's 0.201 came out as
// roughness 0.98 — almost perfectly diffuse. That is why the ocean rendered as
// flat-shaded ground for weeks: not a missing water shader, a unit error.
//
// The Marmoset side was then left as `1 - shininess / 10` with an honest
// comment saying it was "an approximation of the RIGHT scale" — a guess, and
// the last open line of DEV-008. It is a transcription now, and these tests
// check the transcription against the 2016 source rather than against its
// answer.

import { describe, expect, it } from 'vitest'
import { TERRAIN } from '@/generated/constants.generated'
import {
  marmosetGlossLod,
  marmosetSpecularPower,
  shininessToRoughness,
} from '@/render/terrain-mesh'

interface MaterialLike {
  readonly shader: string
  readonly specular?: { readonly shininess?: number } | null
}

describe('shininess is not one scale — it is two', () => {
  it('reads the VacuumShaders scale as Blinn-Phong, not as sharpness', () => {
    // `o.Specular = _Shininess` into Unity's legacy BlinnPhong, which raises
    // N.H to `Specular * 128`. 0.201 -> power 25.7 -> sqrt(2/27.7) = 0.269.
    const wet = shininessToRoughness('Assets/VacuumShaders/x/Legacy_Opaque.shader', 0.201)
    expect(wet).toBeCloseTo(0.269, 2)
    // The number the old single mapping produced, for contrast. If a refactor
    // ever collapses the two branches, this is what it would go back to.
    expect(wet).toBeLessThan(1 - 0.201 / 10 - 0.5)
  })

  it('uses the SHADER to decide, not the terrain name', () => {
    // "is this the ocean" is a guess; "which shader was this authored against"
    // is a fact the sheet already carries. Asserted as *the two branches give
    // different answers to the same input* rather than as an ordering — the
    // ordering is what turned out to be a belief. See the test below.
    const islands = TERRAIN.simonet.terrains.islands.material
    const ocean = TERRAIN.simonet.terrains.ocean.material
    expect(islands.shader).toContain('Marmoset')
    expect(ocean.shader).toContain('VacuumShaders')
    const same = 0.5
    expect(shininessToRoughness(ocean.shader, same)).not.toBeCloseTo(
      shininessToRoughness(islands.shader, same),
      3,
    )
  })
})

describe("Marmoset's gloss chain, transcribed rather than approximated", () => {
  it('transcribes glossLOD exactly (MarmosetCore.cginc:231-235)', () => {
    // glossMap = 1 - glossMap; glossMap = 1 - glossMap^2; 7 + g - shininess*g
    const direct = (g: number, s: number) => {
      const a = 1 - g
      const b = 1 - a * a
      return 7 + b - s * b
    }
    for (const g of [0, 0.25, 0.5, 1]) {
      for (const s of [2, 3.73, 5.01, 5.45, 8]) {
        expect(marmosetGlossLod(s, g)).toBeCloseTo(direct(g, s), 12)
      }
    }
    // Gloss 0 pins the LOD at 7 whatever the sharpness is, because sharpness
    // only ever multiplies the gloss term. Worth its own line: it is the one
    // place the two arguments stop being independent.
    expect(marmosetGlossLod(2, 0)).toBe(7)
    expect(marmosetGlossLod(8, 0)).toBe(7)
  })

  it('reads the authored 2..8 range as a specular power of 8..512', () => {
    // The independent check on the whole chain, and the reason this reading is
    // trusted. A slider called "Specular Sharpness" has to get sharper as it
    // rises; Marmoset names the target itself at MarmosetDirect.cginc:147 —
    // "x4.0 to map to Forward specular exponent (Unity:128, Marmoset:512)".
    expect(marmosetSpecularPower(2)).toBeCloseTo(8, 9)
    expect(marmosetSpecularPower(8)).toBeCloseTo(512, 9)
    // ...and the cube mip runs the other way over the same range: 6 (blurry)
    // down to 0 (sharp). Both halves of the shader agree about which way is
    // shinier, which is what makes this a check and not a restatement.
    expect(marmosetGlossLod(2)).toBeCloseTo(6, 9)
    expect(marmosetGlossLod(8)).toBeCloseTo(0, 9)
  })

  it('puts the shipped terrains where the shader puts them', () => {
    // `2 * exp2(shininess)` at gloss 1, then sqrt(2 / (p + 2)).
    const marmoset = 'Assets/Marmoset/Shader/VertexColor/Marmoset Specular IBL.shader'
    // Simonet and Kauai, 5.01.
    expect(shininessToRoughness(marmoset, 5.01)).toBeCloseTo(0.1735, 4)
    // Desert, 2.66 — near the bottom of the authored range, and the roughest
    // land in the game by a factor of two.
    expect(shininessToRoughness(marmoset, 2.66)).toBeCloseTo(0.3696, 4)
    // Alpine and the menu valley, 5.45 — the glossiest.
    expect(shininessToRoughness(marmoset, 5.45)).toBeCloseTo(0.1495, 4)
  })

  it('makes the LAND glossier than the water, which is not what anyone expected', () => {
    // ── Read this before "fixing" it ─────────────────────────────────────
    //
    // The test that stood here asserted the opposite, and it was a belief
    // written twice rather than a measurement: sea *looks* shinier than rock,
    // so the mapping that produced that ordering went unexamined.
    //
    // The shaders disagree. Marmoset's 5.01 is a specular power of 64.4;
    // VacuumShaders' 0.201 is a power of 25.7. The land's lobe really is the
    // tighter one. What makes the sea read as the shiny surface is not its lobe
    // width but its INTENSITY: `_SpecColor` is (0.5, 0.5, 0.5) against the
    // terrain's `_SpecInt: 0.05` — twelve times the reflectance — plus a full
    // Fresnel sky reflection the land does not have (`render/water.ts`). Broad
    // and bright beats tight and dim.
    const land = shininessToRoughness('Assets/Marmoset/x.shader', 5.01)
    const water = shininessToRoughness('Assets/VacuumShaders/x.shader', 0.201)
    expect(land).toBeLessThan(water)
  })
})

describe('the mapping cannot hand the renderer something it cannot use', () => {
  it('clamps, and stays finite, across every scale either shader could mean', () => {
    for (const shader of ['Assets/VacuumShaders/x.shader', 'Assets/Marmoset/x.shader', null]) {
      for (const v of [0, 0.0001, 1, 8, 1e6, -5, Number.NEGATIVE_INFINITY]) {
        const r = shininessToRoughness(shader, v)
        expect(Number.isFinite(r), `${shader} @ ${v}`).toBe(true)
        expect(r).toBeGreaterThanOrEqual(0.04)
        expect(r).toBeLessThanOrEqual(1)
      }
    }
  })

  it('gives every shipped material a roughness inside its own shader range', () => {
    // A SWEEP, not a spot-check. CLAUDE.md: the terrain generator matched the
    // 2016 bake on chunk (0,0) to 4 mm with two real bugs live, because (0,0)
    // is open sea on the grid diagonal. Every environment, every terrain.
    let marmosetCount = 0
    let vacuumCount = 0
    for (const env of Object.values(TERRAIN)) {
      const terrains = (env as { terrains?: Record<string, { material?: MaterialLike }> }).terrains
      if (!terrains) continue
      for (const [name, t] of Object.entries(terrains)) {
        const m = t.material
        if (!m?.shader) continue
        const r = shininessToRoughness(m.shader, m.specular?.shininess ?? 5)
        if (m.shader.includes('Marmoset')) {
          marmosetCount += 1
          // 0.0624 is shininess 8 and 0.4472 is shininess 2 — the two ends of
          // the shader's own `Range(2.0, 8.0)`. Nothing authored can land
          // outside them, so anything that does is a unit error.
          expect(r, name).toBeGreaterThanOrEqual(0.0624)
          expect(r, name).toBeLessThanOrEqual(0.4472)
        } else {
          vacuumCount += 1
          expect(r, name).toBeCloseTo(0.269, 2)
        }
      }
    }
    // Five Marmoset terrains and two oceans across the five environments in the
    // sheet. If either drops, an environment stopped being extracted.
    expect(marmosetCount).toBe(5)
    expect(vacuumCount).toBe(2)
  })
})
