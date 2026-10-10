// tests/unit/illustrative.test.ts — the illustrative diffuse warp. DEV-092.
//
// Three things are being held here, and only the first one is about the look.
//
// 1. **The identity at strength 0 is EXACT.** Classic and Anniversary compile
//    one program and Classic's frame must not move by a bit. `mix(x, y, 0.0)`
//    is `x * 1.0 + y * 0.0`, so this is `toBe` on exact floats rather than
//    `toBeCloseTo` — the same property `haze.test.ts` pins for the same reason.
//
// 2. **The patch is anchored to a string in three's own source.** A patch
//    nothing checks is not a guard: `hoverjet.input.controlScheme` said
//    `"verified: a"` for four sessions while the pad flew something else
//    (DEV-069). So the anchor is asserted to be present, and present ONCE, in
//    `THREE.ShaderChunk` — and a three upgrade that moves the line fails here
//    rather than silently un-warping the world.
//
// 3. **The two halves agree.** `illustrativeResponse` in TypeScript and
//    `ff2IllustrativeWarp` in GLSL are the same four lines twice, because a
//    shader cannot be unit tested without a GL context. Nothing can diff GLSL
//    against TypeScript, so what is checked instead is the interface between
//    them: the uniform names the GLSL declares are exactly the ones the module
//    provides, which is the divergence a rename actually produces.
//
// And one that is neither: the composition with the fog. Two patches on one
// material, in both orders, both terms surviving — because the fog gets the last
// word on colour and this one changes the light before it.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { type Edition, validateEdition } from '@/content/edition-schema'
import {
  attachEditionIllustrative,
  createIllustrativeLighting,
  halfLambert,
  ILLUSTRATIVE_ANCHOR,
  ILLUSTRATIVE_GLSL,
  ILLUSTRATIVE_INCLUDE,
  ILLUSTRATIVE_OFF,
  ILLUSTRATIVE_REPLACEMENT,
  type IllustrativeSettings,
  type IllustrativeTuning,
  illustrativeChunk,
  illustrativeIrradiance,
  illustrativePatchFragment,
  illustrativeResponse,
} from '@/render/illustrative'
import { isMarmosetShader } from '@/render/terrain-mesh'
import { createUnityFog } from '@/render/unity-fog'
import anniversary from '../../content/editions/anniversary.json'
import classic from '../../content/editions/classic.json'

/** The shipped Anniversary ramp, straight out of the preset. */
const ANNIV = anniversary.render.illustrative as unknown as IllustrativeTuning
const CLASSIC = classic.render.illustrative as unknown as IllustrativeTuning

/** Rec. 709, the same weights the haze uses and for the same reason. */
const luma = (c: readonly [number, number, number]): number =>
  0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]

/** `int_01_hoverJet`'s sun: linear (0.831, 0.569, 0.391) at intensity 1.3. */
const INT01_SUN: readonly [number, number, number] = [
  0.830882 * 1.3,
  0.569395 * 1.3,
  0.391003 * 1.3,
]

const NLS = [-1, -0.9, -0.75, -0.5, -0.25, -0.01, 0, 0.01, 0.25, 0.5, 0.75, 0.9, 1] as const

const terrainLike = () =>
  new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0, side: THREE.FrontSide })

describe('the anchor is a real string in the three we ship', () => {
  it('is present, and present exactly once, in lights_physical_pars_fragment', () => {
    // The three-upgrade guard. If `RE_Direct_Physical`'s diffuse line moves, this
    // is where we find out — at a red test rather than at a frame that looks
    // fine and has quietly lost the feature.
    const chunk = THREE.ShaderChunk.lights_physical_pars_fragment
    expect(chunk).toContain(ILLUSTRATIVE_ANCHOR)
    expect(chunk.split(ILLUSTRATIVE_ANCHOR)).toHaveLength(2)
  })

  it('is the DIFFUSE line, not `irradiance` — so the specular is untouched', () => {
    // `irradiance` feeds BOTH terms. Substituting it would warp the specular
    // lobe as well, and the Marmoset-derived coloured F0 that DEV-008 spent its
    // last section on is the thing this feature must stand BESIDE.
    const patched = illustrativeChunk()
    expect(patched).toContain(
      'reflectedLight.directSpecular += irradiance * BRDF_GGX_Multiscatter( directLight.direction, geometryViewDir, geometryNormal, material );',
    )
    // ...and `vec3 irradiance = dotNL * directLight.color;` still says exactly
    // what it said, so the specular's input is byte for byte the stock one.
    expect(patched).toContain('vec3 irradiance = dotNL * directLight.color;')
  })

  it("leaves the INDIRECT diffuse alone — the ambient is 2016's own SH (DEV-013)", () => {
    const patched = illustrativeChunk()
    expect(patched).toContain(
      'vec3 diffuse = irradiance * BRDF_Lambert( material.diffuseContribution );',
    )
    expect(patched).not.toContain('ff2IllustrativeWarp( dot( geometryNormal, lightDir ) )')
  })

  it('THROWS when the anchor is gone, rather than returning an unwarped chunk', () => {
    const original = THREE.ShaderChunk.lights_physical_pars_fragment
    try {
      THREE.ShaderChunk.lights_physical_pars_fragment = 'void RE_Direct_Physical() {}'
      expect(() => illustrativeChunk()).toThrow(/no longer contains the diffuse line/)
    } finally {
      THREE.ShaderChunk.lights_physical_pars_fragment = original
    }
  })

  it('substitutes into the REAL stock physical fragment shader', () => {
    // Not a hand-written stand-in: `ShaderLib.physical.fragmentShader` is the
    // source three actually hands `onBeforeCompile`. A test against a fake would
    // be a test of the fake (the agreement lesson).
    const stock = THREE.ShaderLib.physical.fragmentShader
    expect(stock).toContain(ILLUSTRATIVE_INCLUDE)
    const patched = illustrativePatchFragment(stock)
    expect(patched).not.toContain(ILLUSTRATIVE_INCLUDE)
    expect(patched).toContain('vec3 ff2IllustrativeWarp(float nl)')
    expect(patched).toContain(ILLUSTRATIVE_REPLACEMENT)
  })

  it('leaves a shader with no lights chunk alone, which the depth pass is', () => {
    // `WebGLShadowMap` builds its depth passes from its own `MeshDepthMaterial`
    // and copies neither `onBeforeCompile` nor `customProgramCacheKey`, so this
    // case cannot arise on the real path — but returning the source unchanged is
    // the only safe thing to do with it either way.
    const depth = THREE.ShaderLib.depth.fragmentShader
    expect(illustrativePatchFragment(depth)).toBe(depth)
  })
})

describe('the identity at strength 0 is exact, not close', () => {
  it('returns the stock Lambert irradiance bit for bit, on every sign of N·L', () => {
    const off: IllustrativeSettings = { ...ANNIV, strength: 0 }
    for (const nl of NLS) {
      for (const light of [INT01_SUN, [1, 1, 1], [0, 0, 0], [3.3, 0.1, 12]] as const) {
        const stock = Math.min(1, Math.max(0, nl))
        const got = illustrativeIrradiance(nl, light as [number, number, number], off)
        for (let i = 0; i < 3; i++) {
          // `toBe`, deliberately. A `toBeCloseTo` here would pass for a build
          // whose Classic frame had moved, which is the one thing the preset
          // scaffold promises it cannot do.
          expect(got[i]).toBe(stock * (light[i] as number))
        }
      }
    }
  })

  it('is the identity with the ramp AT ITS SHIPPED COLOURS, not only at zeroes', () => {
    // The interesting case: strength 0 with a LOUD ramp behind it. If the mix
    // were `x + a * (y - x)` evaluated in a way that lost the exactness, this is
    // where it would show.
    const loud: IllustrativeSettings = {
      shadow: [0.9, 0.1, 0.1],
      terminator: [0.2, 0.9, 0.3],
      lit: [0.1, 0.2, 0.9],
      overbright: 3.7,
      strength: 0,
    }
    for (const nl of NLS) {
      const got = illustrativeIrradiance(nl, INT01_SUN, loud)
      const stock = Math.min(1, Math.max(0, nl))
      for (let i = 0; i < 3; i++) expect(got[i]).toBe(stock * (INT01_SUN[i] as number))
    }
  })

  it("ILLUSTRATIVE_OFF and Classic's own numbers are both that identity", () => {
    for (const s of [ILLUSTRATIVE_OFF, CLASSIC]) {
      for (const nl of NLS) {
        const got = illustrativeIrradiance(nl, INT01_SUN, s)
        const stock = Math.min(1, Math.max(0, nl))
        for (let i = 0; i < 3; i++) expect(got[i]).toBe(stock * (INT01_SUN[i] as number))
      }
    }
  })
})

describe('the ramp', () => {
  it('puts N·L = 0 at Half-Lambert 0.5 exactly, which is why the middle stop has no position', () => {
    // The one derivation in this feature. The middle stop is the TERMINATOR
    // because Half-Lambert says so, not because anybody chose 0.5 — so it is not
    // a tuning number and is not in the preset.
    expect(halfLambert(0)).toBe(0.5)
    expect(halfLambert(-1)).toBe(0)
    expect(halfLambert(1)).toBe(1)
    // ...and the back hemisphere is not collapsed the way `saturate(N·L)`
    // collapses it: two different back-facing normals get two different answers.
    expect(halfLambert(-0.5)).not.toBe(halfLambert(-0.9))
  })

  it('hits each stop exactly at its own end, times the overbright', () => {
    const at = (nl: number) => illustrativeResponse(nl, ANNIV)
    for (const [nl, stop] of [
      [-1, ANNIV.shadow],
      [0, ANNIV.terminator],
      [1, ANNIV.lit],
    ] as const) {
      const got = at(nl)
      for (let i = 0; i < 3; i++) {
        expect(got[i]).toBeCloseTo((stop[i] as number) * ANNIV.overbright, 12)
      }
    }
  })

  it('is MONOTONE in luminance across the whole sweep', () => {
    // Not a property of a ramp in general — it is a property of THESE stops,
    // whose channels each ascend, and smoothstep between ascending stops
    // ascends. A ramp that dipped would read as a dark ring at some angle to the
    // sun, which is the kind of thing that gets diagnosed as a shadow bug.
    let previous = -1
    for (let i = 0; i <= 400; i++) {
      const nl = -1 + (2 * i) / 400
      const l = luma(illustrativeResponse(nl, ANNIV))
      expect(l).toBeGreaterThanOrEqual(previous)
      previous = l
    }
  })

  it('lifts the shadow side off zero where stock Lambert gives nothing at all', () => {
    // The wrap. `saturate(N·L)` is 0 for the entire back hemisphere, so every
    // facet turned away from the sun is lit by the ambient alone and they are all
    // lit IDENTICALLY — which is exactly the flatness ANNIVERSARY.md §1.4 is
    // about. Two back-facing normals must now differ.
    const off: IllustrativeSettings = { ...ANNIV, strength: 0 }
    expect(luma(illustrativeIrradiance(-0.5, INT01_SUN, off))).toBe(0)
    expect(luma(illustrativeIrradiance(-0.9, INT01_SUN, off))).toBe(0)
    const a = luma(illustrativeIrradiance(-0.5, INT01_SUN, ANNIV))
    const b = luma(illustrativeIrradiance(-0.9, INT01_SUN, ANNIV))
    expect(a).toBeGreaterThan(0)
    expect(a).toBeGreaterThan(b)
  })

  it('settles the LIT half within a stated band, and barely moves the brightest faces', () => {
    // Half-Lambert brightens the mid-tones; that is what it does, and unchecked
    // it flattens a world rather than separating it. This holds the RAMP's own
    // curve — the direct-diffuse response as a multiple of `saturate(N·L)` —
    // which is arithmetic this file can actually verify. What it is NOT is a
    // prediction of the frame: see the note below.
    //
    // 0.1 and not 0, because below about N·L = 0.06 the stock term goes to zero
    // and the ratio diverges by construction. That divergence IS the wrap, and
    // the test below is the one that pins it.
    let worst = 0
    let least = Number.POSITIVE_INFINITY
    for (let i = 0; i <= 900; i++) {
      const nl = 0.1 + (0.9 * i) / 900
      const warp = luma(illustrativeIrradiance(nl, INT01_SUN, ANNIV))
      const stock = luma(illustrativeIrradiance(nl, INT01_SUN, { ...ANNIV, strength: 0 }))
      worst = Math.max(worst, warp / stock)
      least = Math.min(least, warp / stock)
    }
    // Measured on the shipped stops: 1.061x to 2.327x over that range.
    expect(worst).toBeLessThan(2.6)
    expect(least).toBeGreaterThan(1)
    // And the very brightest faces move by 6 %, because `lit` is ~1 and the only
    // thing lifting it is `overbright`: the key light's LEVEL is
    // `render.exposure`'s job, not this term's.
    const peak =
      luma(illustrativeIrradiance(1, INT01_SUN, ANNIV)) /
      luma(illustrativeIrradiance(1, INT01_SUN, { ...ANNIV, strength: 0 }))
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThan(1.1)
  })

  it('does NOT carry the sunset into the shadows, which is what "cool" means here', () => {
    // The honest version of "cool shadow", because the phrase invites a wrong
    // reading. The ramp's shadow stop is cool RELATIVE TO THE SUN — r/b 0.25
    // against the sun's 2.13 — so the fill it adds is cool-neutral rather than
    // blue, and it does not drag `int_01`'s 4-degree sunset into the shaded half.
    // The blue in a FF2 shadow comes from the sky, which is 2016's own SH and
    // which this term never touches (DEV-013).
    const sunRatio = (INT01_SUN[0] as number) / (INT01_SUN[2] as number)
    const irrRatio = (nl: number): number => {
      const irr = illustrativeIrradiance(nl, INT01_SUN, ANNIV)
      return (irr[0] as number) / (irr[2] as number)
    }
    expect(irrRatio(-1)).toBeLessThan(sunRatio * 0.5)
    expect(irrRatio(0)).toBeGreaterThan(sunRatio * 2)
  })

  it('THE FRAME IS NOT THE ARITHMETIC — what these numbers are, and are not', () => {
    // This is a comment with an assertion attached, and it is here because the
    // first pass of this row nearly shipped the opposite mistake (DEV-027's
    // rule: say what a derived number is the ratio OF, and check the frame of
    // reference).
    //
    // Everything above is the RESPONSE CURVE: the multiplier three's
    // `RE_Direct_Physical` applies to the light before `BRDF_Lambert`. It is not
    // what a pixel does. Between the two sit the surface's albedo, the indirect
    // diffuse from the light probe, the env-map specular, the mission fog, the
    // haze, ACES and the exposure — and measured on a registered `island-lit`
    // pair those together turn a ramp that is 2.3x of Lambert at its peak into
    // **+4.5 % of display luminance** on the massif.
    //
    // An earlier version of this file asserted the frame directly, by adding an
    // ambient of (0.313, 0.345, 0.400) to the direct term. That model was wrong
    // by about a factor of ten against the photograph, and the assertions passed
    // anyway — which is exactly the shape of a number with no provenance. The
    // frame measurements live in DEV-092 with the PNG paths beside them.
    //
    // What is left here is the one claim the arithmetic really does support.
    const stock = (nl: number) =>
      luma(illustrativeIrradiance(nl, INT01_SUN, { ...ANNIV, strength: 0 }))
    const warped = (nl: number) => luma(illustrativeIrradiance(nl, INT01_SUN, ANNIV))
    // Two facets turned away from a sun that can still see them are lit
    // IDENTICALLY by the stock term — at nothing — and differently by this one.
    // That, and not a brightness, is what the row is for.
    expect(stock(-0.3)).toBe(0)
    expect(stock(-0.7)).toBe(0)
    expect(warped(-0.3)).toBeGreaterThan(warped(-0.7))
    expect(warped(-0.7)).toBeGreaterThan(0)
  })
})

describe('the two halves have not drifted apart', () => {
  it('the GLSL declares exactly the uniforms the module provides', () => {
    // The divergence a rename produces, and the one thing that CAN be checked
    // mechanically across a language boundary. A stale name is a uniform three
    // never writes, which is a zero, which is a black terrain.
    const declared = [...ILLUSTRATIVE_GLSL.matchAll(/^uniform\s+\w+\s+(\w+)\s*;/gm)].map(
      (m) => m[1] as string,
    )
    const provided = Object.keys(createIllustrativeLighting().uniforms)
    expect([...declared].sort()).toEqual([...provided].sort())
  })

  it('the GLSL is the same four lines the TypeScript is', () => {
    // Not a proof — nothing here can compile GLSL. It pins the operations that
    // the mirror depends on, so a change made to one half and not the other is a
    // visible diff in this file rather than a silent divergence in the middle of
    // the ramp.
    expect(ILLUSTRATIVE_GLSL).toContain('clamp(nl * 0.5 + 0.5, 0.0, 1.0)')
    expect(ILLUSTRATIVE_GLSL).toContain('smoothstep(0.0, 0.5, hl)')
    expect(ILLUSTRATIVE_GLSL).toContain('smoothstep(0.5, 1.0, hl)')
    expect(ILLUSTRATIVE_GLSL).toContain('mix(uWarpShadow, uWarpTerminator, lower)')
    expect(ILLUSTRATIVE_GLSL).toContain('mix(c, uWarpLit, upper) * uWarp.y')
    // And the substitution's cross-fade, in the order the TS mirror takes it.
    expect(ILLUSTRATIVE_REPLACEMENT).toContain('mix( irradiance, ff2IllustrativeWarp(')
    expect(ILLUSTRATIVE_REPLACEMENT).toContain('uWarp.x )')
  })

  it('reads the RAW dot product, not the saturated dotNL above it', () => {
    // `dotNL` is already `saturate`d, and Half-Lambert of a saturated dot only
    // ever spans 0.5..1 — which throws away the entire reason for the
    // reparameterisation and would make the shadow side identical to today while
    // every test on the TypeScript mirror stayed green.
    expect(ILLUSTRATIVE_REPLACEMENT).toContain('dot( geometryNormal, directLight.direction )')
    expect(ILLUSTRATIVE_REPLACEMENT).not.toContain('ff2IllustrativeWarp( dotNL )')
  })
})

describe('the material patch', () => {
  it('tags the program cache key, so a warped material cannot borrow an unwarped program', () => {
    const warped = terrainLike()
    const plain = terrainLike()
    createIllustrativeLighting().applyTo(warped)
    expect(warped.customProgramCacheKey()).toContain('illustrative-warp')
    expect(warped.customProgramCacheKey()).not.toBe(plain.customProgramCacheKey())
  })

  it('is ONE variant: two materials on different tunings still share a program', () => {
    // Every branch in the injected GLSL is on a uniform, which is what lets
    // Classic and Anniversary compile one program per material instead of two.
    const a = terrainLike()
    const b = terrainLike()
    const wa = createIllustrativeLighting()
    const wb = createIllustrativeLighting()
    wa.applyTo(a)
    wb.applyTo(b)
    wa.set(ANNIV)
    wb.set(null)
    expect(a.customProgramCacheKey()).toBe(b.customProgramCacheKey())
  })

  it('is idempotent — 256 chunks sharing one material do not redefine the ramp 256 times', () => {
    // A redefinition of `ff2IllustrativeWarp` does not fail quietly; it fails to
    // compile. `unity-fog.ts` learned this one first.
    const m = terrainLike()
    const warp = createIllustrativeLighting()
    for (let i = 0; i < 8; i++) warp.applyTo(m)
    expect(warp.materialCount).toBe(1)
    const out = runPatch(m)
    expect(out.split('vec3 ff2IllustrativeWarp(float nl)')).toHaveLength(2)
  })

  it('starts at the identity whatever preset is live, and `set` is the only writer', () => {
    // The fog builds the haze zeroed for the same reason: a term that defaults
    // to ON makes the order of two unrelated boot steps visible in the picture.
    const warp = createIllustrativeLighting()
    expect(warp.uniforms.uWarp.value.x).toBe(0)
    warp.set(ANNIV)
    expect(warp.uniforms.uWarp.value.x).toBe(ANNIV.strength)
    expect(warp.uniforms.uWarp.value.y).toBe(ANNIV.overbright)
    expect(warp.uniforms.uWarpTerminator.value.r).toBe(ANNIV.terminator[0])
    warp.set(null)
    expect(warp.uniforms.uWarp.value.x).toBe(0)
  })

  it('puts its uniforms on the shader, or three writes nothing and the terrain goes black', () => {
    const m = terrainLike()
    const warp = createIllustrativeLighting()
    warp.applyTo(m)
    const shader = { fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {} }
    m.onBeforeCompile(shader as never, null as never)
    expect(Object.keys(shader.uniforms).sort()).toEqual(Object.keys(warp.uniforms).sort())
    // The same OBJECTS, not copies — `set` writes through them after compile.
    expect((shader.uniforms as Record<string, unknown>).uWarp).toBe(warp.uniforms.uWarp)
  })
})

describe('it composes with the fog and the haze, in either order', () => {
  const fog = () =>
    createUnityFog({
      mode: 2,
      density: 0.00025,
      linearStart: 100,
      linearEnd: 2500,
      color: [0.87, 0.66, 0.7],
      distanceFog: true,
      heightFog: true,
      useRadialDistance: true,
      height: 387,
      heightDensity: 0.03,
      startDistance: 256,
    })

  for (const warpFirst of [true, false]) {
    it(`survives with the warp ${warpFirst ? 'before' : 'after'} the fog`, () => {
      // The warp changes `RE_Direct`; the fog and the haze change
      // `outgoingLight`. Different hooks, so the only shared resource is
      // `onBeforeCompile` itself — and both patches chain rather than assign,
      // which is what this actually proves.
      const m = terrainLike()
      const warp = createIllustrativeLighting()
      const f = fog()
      if (warpFirst) {
        warp.applyTo(m)
        f.applyTo(m)
      } else {
        f.applyTo(m)
        warp.applyTo(m)
      }
      const out = runPatch(m)
      expect(out).toContain('vec3 ff2IllustrativeWarp(float nl)')
      expect(out).toContain('vec3 ff2AerialHaze(vec3 color, float dist)')
      expect(out).toContain('float unityHalfSpace(vec3 wsDir, vec3 wsPos)')
      expect(out).toContain(ILLUSTRATIVE_REPLACEMENT)
      // Both cache-key tokens survive, whichever went on first.
      expect(m.customProgramCacheKey()).toContain('illustrative-warp')
      expect(m.customProgramCacheKey()).toContain('unity-fog')
    })
  }

  it('the fog still gets the last word on colour', () => {
    // The order that IS load-bearing, and it is an order in the SHADER rather
    // than in the patching: the warp is inside the lighting stack, the haze runs
    // on `outgoingLight` first and the fog mixes the sky over the result. So in
    // the emitted source the fog's `mix(fogTint, outgoingLight, fogFac)` has to
    // come after the haze call, and both after the lighting.
    const m = terrainLike()
    createIllustrativeLighting().applyTo(m)
    fog().applyTo(m)
    const out = runPatch(m)
    const lighting = out.indexOf(ILLUSTRATIVE_REPLACEMENT)
    const haze = out.indexOf('outgoingLight = ff2AerialHaze(')
    const fogMix = out.indexOf('outgoingLight = mix(fogTint, outgoingLight, fogFac)')
    expect(lighting).toBeGreaterThan(-1)
    expect(haze).toBeGreaterThan(lighting)
    expect(fogMix).toBeGreaterThan(haze)
  })
})

describe('the preset contract', () => {
  it('Classic is off AND its numbers are the identity — belt and braces', () => {
    expect(CLASSIC.enabled).toBe(false)
    expect(CLASSIC.strength).toBe(0)
  })

  it('Anniversary is on, and its stops are a ramp rather than a pile of ones', () => {
    expect(ANNIV.enabled).toBe(true)
    expect(ANNIV.strength).toBeGreaterThan(0)
    expect(luma(ANNIV.shadow)).toBeLessThan(luma(ANNIV.terminator))
    expect(luma(ANNIV.terminator)).toBeLessThan(luma(ANNIV.lit))
    // `lit` near 1, or the term is doing exposure's job.
    expect(luma(ANNIV.lit)).toBeGreaterThan(0.9)
    expect(luma(ANNIV.lit)).toBeLessThanOrEqual(1)
  })

  it("hands NULL when the flag is off, so Classic's numbers are unobservable", () => {
    // Not "the preset's numbers with the flag ignored". A disabled feature's
    // tuning must not be able to become load-bearing by accident — the same
    // contract `attachEditionHaze` keeps.
    const seen: (IllustrativeTuning | null)[] = []
    const target = {
      set: (t: IllustrativeTuning | null) => {
        seen.push(t)
      },
    }
    let current = classic as unknown as Edition
    const listeners: (() => void)[] = []
    const state = {
      get current() {
        return current
      },
      subscribe: (fn: () => void) => {
        listeners.push(fn)
        return () => {}
      },
    }
    attachEditionIllustrative(target, state as never)
    expect(seen).toEqual([null])
    current = anniversary as unknown as Edition
    for (const fn of listeners) fn()
    expect(seen[1]).not.toBeNull()
    expect(seen[1]?.strength).toBe(ANNIV.strength)
  })

  it('the validator refuses a hole in the ramp, at LOAD rather than at frame 400', () => {
    // A missing stop reaches `Color.setRGB` as `undefined`, three writes NaN,
    // and every LAND fragment multiplies its diffuse by it — a black island with
    // nothing thrown anywhere. Same failure shape as the haze's missing `range`.
    const holed = structuredClone(anniversary) as unknown as {
      render: { illustrative: Record<string, unknown> }
    }
    delete holed.render.illustrative.terminator
    expect(() => validateEdition(holed as unknown as Edition)).toThrow(
      /render\.illustrative\.terminator/,
    )

    const short = structuredClone(anniversary) as unknown as {
      render: { illustrative: Record<string, unknown> }
    }
    short.render.illustrative.shadow = [0.1, 0.2]
    expect(() => validateEdition(short as unknown as Edition)).toThrow(
      /render\.illustrative\.shadow/,
    )

    const loud = structuredClone(anniversary) as unknown as {
      render: { illustrative: Record<string, number> }
    }
    loud.render.illustrative.strength = 1.4
    expect(() => validateEdition(loud as unknown as Edition)).toThrow(
      /render\.illustrative\.strength/,
    )
  })
})

describe('the sea does not get it', () => {
  it('`isMarmosetShader` is the one place that decides, and it says no to VacuumShaders', () => {
    // The warp shades three's directional light. The ocean is a VacuumShaders
    // surface drawn by `render/water.ts` with its own `uSunColor`, so a warp on
    // that light would reshape a light the water never reads — and the whole
    // point of going through this predicate is that "is this the ocean" is asked
    // ONCE, off the fact the generated sheet carries.
    expect(isMarmosetShader('VacuumShaders/Low Poly Water')).toBe(false)
    expect(isMarmosetShader('Marmoset/Shader/VertexColor/Marmoset Specular IBL')).toBe(true)
    // Absent counts as land: every land terrain in the sheet is Marmoset and the
    // sea's entry is the one that names its shader explicitly.
    expect(isMarmosetShader(null)).toBe(true)
    expect(isMarmosetShader(undefined)).toBe(true)
  })
})

/** Run a material's whole `onBeforeCompile` chain against the stock source. */
function runPatch(m: THREE.Material): string {
  const shader = {
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    uniforms: {},
  }
  m.onBeforeCompile(shader as never, null as never)
  return shader.fragmentShader
}
