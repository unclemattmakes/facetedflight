// tests/unit/cloud-look.test.ts — clouds that are clouds (DEV-090), and the
// promise that Classic still has boulders.
//
// Three different promises are being held here, and they fail in three different
// ways:
//
//  1. **The wrap really is three's own diffuse.** Not "a softening term" — the
//     claim in `render/cloud-look.ts` is that `cloudWrapLift` plus three's
//     `saturate(N.L)` equals a wrapped Lambert exactly, so nothing has been
//     invented and `wrap` means what its name says. That is a RELATIONSHIP, and
//     it is asserted as one: `lift + saturate(d) === (d + w) / (1 + w)` clamped,
//     over a sweep of d and w. Asserting "lift at d = 0.3, w = 0.5 is 0.1333"
//     would be re-deriving the expectation the way the code does it, which
//     CLAUDE.md's trap 24 says is not a test.
//
//  2. **Classic contributes NOTHING.** Not almost nothing. The shipped preset
//     renders what it rendered before this row, and because the feature is one
//     program gated on uniforms (DEV-081's argument, DEV-082's precedent) that
//     is a claim about arithmetic rather than about a define. `toBe`, exact
//     floats, every corner of the sweep.
//
//  3. **The preset files say what the DEV row says they say.** Both are read
//     here rather than restated, so a number changed in the JSON and not in the
//     ledger shows up as a failing test rather than as a frame nobody photographed
//     again.
//
// The GLSL half cannot be reached without a GL context, so it is covered by eye
// on the viewpoints the row names and by the same-tick A/B pair. What a unit test
// CAN do is make sure the mirror and the shader are the same four lines twice —
// which is why `CLOUD_LOOK_GLSL` is checked for the terms it must contain, and
// why the injected block is checked for the one property that made it correct:
// the fog gets the last word.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { SunLight } from '@/content/level-schema'
import { loadClouds } from '@/game/clouds'
import {
  applyCloudLook,
  CLOUD_DRIFT_OFF,
  CLOUD_LOOK_GLSL,
  CLOUD_LOOK_OFF,
  CLOUD_PLACEMENT_OFF,
  type CloudLookSettings,
  type CloudTuning,
  cloudDriftOffset,
  cloudDriftSettings,
  cloudLookAdd,
  cloudLookPack,
  cloudLookSettings,
  cloudLookUniforms,
  cloudMaterialSide,
  cloudPlacementSettings,
  cloudRim,
  cloudSunRadiance,
  cloudToSun,
  cloudWrapLift,
  whiteoutStep,
} from '@/render/cloud-look'
import { marmosetSunIntensity } from '@/render/skyshop-ibl'
import { createUnityFog, type UnityFogParams } from '@/render/unity-fog'
import anniversary from '../../content/editions/anniversary.json'
import classic from '../../content/editions/classic.json'
import level from '../../content/levels/int_01_hoverJet.json'

const ANNIVERSARY = anniversary.render.clouds as unknown as CloudTuning
const CLASSIC = classic.render.clouds as unknown as CloudTuning
/** `int_01_hoverJet`'s own sun: warm, intensity 1.3, four degrees up. */
const SUN = level.lighting.sun as unknown as SunLight

const look = (over: Partial<CloudLookSettings> = {}): CloudLookSettings => ({
  ...cloudLookSettings(ANNIVERSARY, SUN),
  ...over,
})

/** GLSL's `clamp(x, 0, 1)`, spelled out — the same thing three's `saturate` is. */
const saturate = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)

/** A sweep over the sphere that includes both poles and the terminator exactly. */
const DOTS = [-1, -0.9, -0.5, -0.25, -0.01, 0, 0.01, 0.25, 0.5, 0.75, 0.999, 1]
const WRAPS = [0, 0.05, 0.25, 0.5, 0.75, 1]

describe('the wrap is three.js own diffuse, re-derived', () => {
  it('plus the hard term IS a wrapped Lambert, at every angle and every wrap', () => {
    // The relationship the whole feature rests on. `render/cloud-look.ts` claims
    // it adds the DIFFERENCE between a wrapped Lambert and the hard one three
    // already wrote, so the sum has to be the wrapped form — not approximately.
    for (const w of WRAPS) {
      for (const d of DOTS) {
        const total = cloudWrapLift(d, w) + saturate(d)
        expect(total).toBeCloseTo(saturate((d + w) / (1 + w)), 12)
      }
    }
  })

  it('is exactly zero at wrap 0 — the Classic identity, not a rounding', () => {
    for (const d of DOTS) expect(cloudWrapLift(d, 0)).toBe(0)
    // And off the sweep, including a dot product that floating point pushed
    // outside [-1, 1], which is the one case a `max(d, 0.0)` would have leaked.
    for (const d of [-1.0000001, 1.0000001, -0.7071068, 0.3333333333333333]) {
      expect(cloudWrapLift(d, 0)).toBe(0)
    }
  })

  it('never DARKENS, at any angle or wrap — it only fills the shaded side', () => {
    // A wrap that subtracted anywhere would make a cloud darker than the rock it
    // is meant to stop looking like, which is the opposite of the row.
    for (const w of WRAPS) {
      for (const d of DOTS) expect(cloudWrapLift(d, w)).toBeGreaterThanOrEqual(0)
    }
  })

  it('leaves the fully lit crown alone and does its work at the terminator', () => {
    const w = ANNIVERSARY.wrap
    // Nothing at all where the sun is straight on: a crown that got brighter
    // would be an exposure change wearing a wrap's name.
    expect(cloudWrapLift(1, w)).toBeCloseTo(0, 12)
    // The most lift is on the dark side of the terminator, and it is the same
    // fraction of a lit face the preset's note claims.
    expect(cloudWrapLift(0, w)).toBeCloseTo(w / (1 + w), 12)
    expect(cloudWrapLift(0, w)).toBeGreaterThan(cloudWrapLift(0.5, w))
    expect(cloudWrapLift(0.5, w)).toBeGreaterThan(cloudWrapLift(0.9, w))
  })

  it('reaches further round the body the higher it is set', () => {
    // Monotone in the knob, which is what makes the lookdev slider legible.
    for (const d of [-0.2, 0, 0.3]) {
      for (let i = 1; i < WRAPS.length; i++) {
        const less = cloudWrapLift(d, WRAPS[i - 1] as number)
        const more = cloudWrapLift(d, WRAPS[i] as number)
        expect(more).toBeGreaterThanOrEqual(less)
      }
    }
  })

  it('at wrap 1 lights the terminator at half a lit face, which is half-Lambert', () => {
    // The endpoint, stated as the textbook value rather than as our arithmetic.
    expect(cloudWrapLift(0, 1) + saturate(0)).toBeCloseTo(0.5, 12)
    expect(cloudWrapLift(-1, 1) + saturate(-1)).toBeCloseTo(0, 12)
  })
})

describe('the rim is a silhouette times a backlight', () => {
  /** Looking straight at a cloud that is straight between you and the sun. */
  const straightAtTheSun = (): { n: [number, number, number]; v: [number, number, number] } => {
    const toSun = cloudToSun(SUN)
    // The view ray points AT the sun, so the surface normal that faces the eye
    // points back along it.
    return { n: [-toSun[0], -toSun[1], -toSun[2]], v: [toSun[0], toSun[1], toSun[2]] }
  }

  it('is zero at rimStrength 0, whatever the geometry — the Classic identity', () => {
    const off = look({ rimStrength: 0 })
    for (const n of [
      [0, 1, 0],
      [1, 0, 0],
      [0, 0, -1],
      [-0.577, 0.577, -0.577],
    ] as [number, number, number][]) {
      for (const v of [
        [0, -1, 0],
        [1, 0, 0],
        [0.577, -0.577, 0.577],
      ] as [number, number, number][]) {
        expect(cloudRim(n, v, off)).toBe(0)
      }
    }
  })

  it('is nothing where the surface faces you squarely, and peaks at the silhouette', () => {
    const { n, v } = straightAtTheSun()
    // N·V = 1: the middle of the disc, no edge.
    expect(cloudRim(n, v, look())).toBeCloseTo(0, 12)
    // A normal at right angles to the view ray IS the silhouette.
    const edge: [number, number, number] = [0, 1, 0]
    const grazing: [number, number, number] = [1, 0, 0]
    expect(cloudRim(edge, grazing, look())).toBeGreaterThan(0)
  })

  it('is strongest with the sun BEHIND the cloud and weakest with it behind YOU', () => {
    // The half the row calls the backlight. A cloud lit from the front has an
    // edge too, because of the 0.5 + 0.5 remap, but much less of one — which is
    // the whole reason that remap is there rather than a hard `saturate(dot)`.
    const toSun = cloudToSun(SUN)
    const edge: [number, number, number] = [0, 1, 0]
    const towardSun: [number, number, number] = [toSun[0], toSun[1], toSun[2]]
    const awayFromSun: [number, number, number] = [-toSun[0], -toSun[1], -toSun[2]]
    const backlit = cloudRim(edge, towardSun, look())
    const frontlit = cloudRim(edge, awayFromSun, look())
    expect(backlit).toBeGreaterThan(frontlit)
    // And the front-lit case is zero to within float noise. Not EXACTLY zero,
    // and the reason is worth a line: `dot(-v, v)` for a normalised v is -1 only
    // in exact arithmetic, so `0.5 + 0.5 * dot` lands at 4e-17 rather than at 0.
    // That is a property of normalisation and not of this term — the identity
    // that has to be exact is `rimStrength` 0, which is asserted above and is a
    // multiply by zero.
    expect(frontlit).toBeCloseTo(0, 15)
  })

  it('gets thinner as rimPower rises', () => {
    // Everywhere except the silhouette itself, where `1 - N·V` is 1 and any
    // power of 1 is 1. Sampling at N·V = 0.5 is inside the band, which is where
    // the exponent is supposed to bite.
    const n: [number, number, number] = [0, 1, 0]
    // A view ray 60 degrees off the normal: N·V = 0.5.
    const v: [number, number, number] = [Math.sqrt(3) / 2, -0.5, 0]
    let previous = Number.POSITIVE_INFINITY
    for (const rimPower of [1, 2, 3, 5, 8, 12]) {
      const value = cloudRim(n, v, look({ rimPower }))
      expect(value).toBeLessThan(previous)
      previous = value
    }
  })
})

describe('what the term adds to the frame', () => {
  const ALBEDO: [number, number, number] = [0.983, 0.752, 0.752]

  it('adds exactly nothing on Classic, at every angle — toBe, not toBeCloseTo', () => {
    const off = cloudLookSettings(CLASSIC, SUN)
    for (const d of DOTS) {
      // Build a normal with this exact dot against the sun, in the plane the sun
      // and +y span.
      const toSun = cloudToSun(off.toSun[1] === 1 ? SUN : SUN)
      const n: [number, number, number] = [toSun[0] * d, toSun[1] * d, toSun[2] * d]
      for (const v of [
        [1, 0, 0],
        [0, -1, 0],
        [-0.577, -0.577, 0.577],
      ] as [number, number, number][]) {
        expect(cloudLookAdd(ALBEDO, n, v, off)).toEqual([0, 0, 0])
      }
    }
  })

  it('adds exactly nothing with CLOUD_LOOK_OFF, which is what a material is built with', () => {
    expect(cloudLookAdd(ALBEDO, [0, 1, 0], [0, -1, 0], CLOUD_LOOK_OFF)).toEqual([0, 0, 0])
  })

  it('is tinted by the CLOUD, so a dark albedo gets less of it', () => {
    // A grey wash over every cloud would be the boulder problem again in white.
    const n: [number, number, number] = [0, 1, 0]
    const v: [number, number, number] = [0, -1, 0]
    const bright = cloudLookAdd([1, 1, 1], n, v, look())
    const dim = cloudLookAdd([0.25, 0.25, 0.25], n, v, look())
    for (let i = 0; i < 3; i++) {
      expect(dim[i] as number).toBeCloseTo((bright[i] as number) * 0.25, 12)
    }
  })

  it('takes the SUN colour at sunTint 1 and a neutral of the same luminance at 0', () => {
    const n: [number, number, number] = [0, 1, 0]
    const v: [number, number, number] = [0, -1, 0]
    const warm = cloudLookAdd([1, 1, 1], n, v, look({ sunTint: 1 }))
    const neutral = cloudLookAdd([1, 1, 1], n, v, look({ sunTint: 0 }))
    // Neutral is grey: all three channels the same, which is the definition.
    expect(neutral[1]).toBeCloseTo(neutral[0] as number, 12)
    expect(neutral[2]).toBeCloseTo(neutral[0] as number, 12)
    // `int_01`'s sun is warm, so the tinted one is redder and bluer the other way.
    expect(warm[0] as number).toBeGreaterThan(neutral[0] as number)
    expect(warm[2] as number).toBeLessThan(neutral[2] as number)
    // And the two carry the SAME luminance, which is what "a neutral of the same
    // luminance" has to mean. Rec. 709, spelled out rather than imported — the
    // weights are a published standard, and importing the port's copy would be
    // re-deriving the expectation the way the code does (trap 24).
    const luma = (c: readonly number[]): number =>
      (c[0] as number) * 0.2126 + (c[1] as number) * 0.7152 + (c[2] as number) * 0.0722
    expect(luma(neutral)).toBeCloseTo(luma(warm), 12)
  })
})

describe('the sun comes from the MISSION, not from the preset', () => {
  it('is the radiance three is handed — colour times intensity, as a light carries it', () => {
    // Checked against three itself rather than against our own arithmetic: build
    // the light the way `applyLighting` does and ask what a shader would see,
    // which is `color * intensity`.
    const light = new THREE.DirectionalLight(0xffffff, marmosetSunIntensity(SUN.intensity))
    light.color.setRGB(
      SUN.colorLinear[0],
      SUN.colorLinear[1],
      SUN.colorLinear[2],
      THREE.LinearSRGBColorSpace,
    )
    const seen = light.color.clone().multiplyScalar(light.intensity)
    const radiance = cloudSunRadiance(SUN)
    expect(radiance[0]).toBeCloseTo(seen.r, 10)
    expect(radiance[1]).toBeCloseTo(seen.g, 10)
    expect(radiance[2]).toBeCloseTo(seen.b, 10)
  })

  it('points AT the sun, which is the NEGATED travel direction, normalised', () => {
    const toSun = cloudToSun(SUN)
    expect(Math.hypot(toSun[0], toSun[1], toSun[2])).toBeCloseTo(1, 12)
    // `SunLight.direction` is the way light travels, so the two must OPPOSE.
    const dot =
      toSun[0] * SUN.direction[0] + toSun[1] * SUN.direction[1] + toSun[2] * SUN.direction[2]
    expect(dot).toBeLessThan(0)
    // And `int_01`'s sun is 4 degrees above the horizon, so the vector pointing
    // at it is barely above the horizontal — a sanity check on the SIGN, which
    // is the half of this that a normalisation cannot get wrong quietly.
    expect(Math.asin(toSun[1]) * (180 / Math.PI)).toBeCloseTo(SUN.elevationDeg, 3)
  })

  it('survives a mission with no light at all rather than producing a NaN', () => {
    expect(cloudSunRadiance(null)).toEqual([0, 0, 0])
    const up = cloudToSun(null)
    expect(Math.hypot(up[0], up[1], up[2])).toBe(1)
  })
})

describe('the placements, and the wind', () => {
  it('Classic is the IDENTITY, in the exact sense — 2016 authored it', () => {
    const p = cloudPlacementSettings(null)
    expect(p).toEqual(CLOUD_PLACEMENT_OFF)
    expect(p.scaleMultiplier).toBe(1)
    expect(p.altitudeLift).toBe(0)
    // And the preset file agrees with the code's idea of "off", so a Classic
    // whose flag was flipped by hand still puts every cloud where 2016 did.
    expect(CLASSIC.scaleMultiplier).toBe(1)
    expect(CLASSIC.altitudeLift).toBe(0)
    expect(CLASSIC.driftSpeed).toBe(0)
  })

  it('grows and lifts every cloud by the preset, and only by the preset', () => {
    const p = cloudPlacementSettings(ANNIVERSARY)
    // Read off the real level, so this is a statement about the SKY and not
    // about two numbers multiplied together.
    const first = level.clouds[0] as { pos: number[]; scale: number[] }
    expect((first.scale[0] as number) * p.scaleMultiplier).toBeCloseTo(
      (first.scale[0] as number) * ANNIVERSARY.scaleMultiplier,
      9,
    )
    expect((first.pos[1] as number) + p.altitudeLift).toBeGreaterThan(first.pos[1] as number)
  })

  it('keeps 2016 flattening: the multiplier goes on all THREE axes', () => {
    // `sim/clouds.ts` says what squashing twice looked like — flying saucers.
    // The placements are already flat (y is 40-50 % of x), so a multiplier that
    // skipped y would flatten them again.
    const p = cloudPlacementSettings(ANNIVERSARY)
    for (const c of level.clouds as { scale: number[] }[]) {
      const before = (c.scale[1] as number) / (c.scale[0] as number)
      const after =
        ((c.scale[1] as number) * p.scaleMultiplier) / ((c.scale[0] as number) * p.scaleMultiplier)
      expect(after).toBeCloseTo(before, 12)
    }
  })

  it('a still sky never moves, at any time — including a silly one', () => {
    for (const t of [0, 1, 1e6, Number.MAX_SAFE_INTEGER]) {
      expect(cloudDriftOffset(t, CLOUD_DRIFT_OFF)).toEqual([0, 0, 0])
      expect(cloudDriftOffset(t, cloudDriftSettings(CLASSIC))).toEqual([0, 0, 0])
    }
  })

  it('drifts at the speed it says, in metres per second, along a normalised direction', () => {
    const d = cloudDriftSettings(ANNIVERSARY)
    const at = (t: number) => cloudDriftOffset(t, d)
    // The DISTANCE is the speed times the time — that is what "m/s" means, and
    // it is the one property a direction that was not normalised would break.
    for (const t of [1, 10, 73, 180]) {
      const [x, y, z] = at(t)
      expect(Math.hypot(x, y, z)).toBeCloseTo(ANNIVERSARY.driftSpeed * t, 9)
    }
    // Linear in time, so it is a function of the clock and not an integrator: a
    // dropped frame cannot leave the sky somewhere else.
    const a = at(20)
    const b = at(40)
    for (let i = 0; i < 3; i++) expect(b[i] as number).toBeCloseTo((a[i] as number) * 2, 9)
    // At t = 0 nothing has moved. Per component rather than `toEqual([0,0,0])`:
    // the direction's negative z times zero is NEGATIVE zero, which `toEqual`
    // distinguishes from zero and a position does not.
    for (const v of at(0)) expect(v).toBeCloseTo(0, 15)
  })

  it('moves a cloud less than its own width over the longest clock in the game', () => {
    // The argument for the number, asserted rather than asserted-in-prose. The
    // 180 s clock is `adv_01_hoverJet`'s and it is the longest; the mean longest
    // axis on `int_01` after the multiplier is what a drift has to stay under, or
    // the sky the mission started with is not the sky it ends with.
    const d = cloudDriftSettings(ANNIVERSARY)
    const [x, y, z] = cloudDriftOffset(180, d)
    const travelled = Math.hypot(x, y, z)
    const axes = (level.clouds as { scale: number[] }[]).map((c) => Math.max(...c.scale))
    const meanWidth = (axes.reduce((a, b) => a + b, 0) / axes.length) * ANNIVERSARY.scaleMultiplier
    expect(travelled).toBeLessThan(meanWidth)
  })

  it('refuses to produce a NaN from a degenerate direction', () => {
    // A preset with a zero direction and a speed is a typo, and the failure
    // shape is the worst kind: every cloud's matrix becomes NaN and the whole
    // sky vanishes from the frustum with nothing in the console.
    expect(cloudDriftOffset(10, { speed: 4, direction: [0, 0, 0] })).toEqual([0, 0, 0])
    expect(cloudDriftOffset(Number.NaN, { speed: 4, direction: [1, 0, 0] })).toEqual([0, 0, 0])
  })
})

describe('the shader half', () => {
  it('mirrors the TypeScript: both terms, the luma, and the 1/pi are all in it', () => {
    // A blunt instrument on purpose. The mirror is the only half a unit test can
    // reach, so the thing worth checking about the GLSL is that it has not
    // drifted away from the maths above — the constants in particular, which are
    // interpolated from the same exported values.
    expect(CLOUD_LOOK_GLSL).toContain('uniform vec4 uCloudLook')
    expect(CLOUD_LOOK_GLSL).toContain('uniform vec3 uCloudSun')
    expect(CLOUD_LOOK_GLSL).toContain('uniform vec3 uCloudToSun')
    // Both halves saturated, which is what makes wrap 0 an identity.
    expect(CLOUD_LOOK_GLSL).toContain('clamp((d + uCloudLook.x) / (1.0 + uCloudLook.x), 0.0, 1.0)')
    expect(CLOUD_LOOK_GLSL).toContain('- clamp(d, 0.0, 1.0)')
    // The backlight remap, not a hard saturate of the dot.
    expect(CLOUD_LOOK_GLSL).toContain('0.5 + 0.5 * dot(toPoint, uCloudToSun)')
    // Rec. 709 and 1/pi, from the exported constants rather than typed twice.
    expect(CLOUD_LOOK_GLSL).toContain('0.2126')
    expect(CLOUD_LOOK_GLSL).toContain(String(1 / Math.PI))
    // And the early out, so Classic does not even pay for the normalize.
    expect(CLOUD_LOOK_GLSL).toContain('return vec3(0.0)')
  })

  it('tags the program cache key, or it would borrow another material shader', () => {
    const material = new THREE.MeshStandardMaterial({ metalness: 0, side: THREE.DoubleSide })
    const plain = new THREE.MeshStandardMaterial({ metalness: 0, side: THREE.DoubleSide })
    applyCloudLook(material, cloudLookUniforms())
    expect(material.customProgramCacheKey()).not.toBe(plain.customProgramCacheKey())
    expect(material.customProgramCacheKey()).toContain('cloud-look')
  })

  it('leaves the FOG last in the fragment shader, which is the whole ordering', () => {
    // The trap this feature could most easily have shipped: a rim painted over
    // the fog, so a cloud at 3 km keeps an edge the atmosphere should have taken
    // — and the symptom reads as "the rim is too strong" rather than as an
    // ordering bug. `render/dressing.ts` records the same trap from the vertex
    // side. Applied in the order `boot/app.ts` applies them: look, then fog.
    const material = new THREE.MeshStandardMaterial({ metalness: 0, side: THREE.DoubleSide })
    applyCloudLook(material, cloudLookUniforms())
    createUnityFog(FOG).applyTo(material)

    const shader = { vertexShader: VERTEX_STUB, fragmentShader: FRAGMENT_STUB, uniforms: {} }
    material.onBeforeCompile(
      shader as unknown as THREE.WebGLProgramParametersWithUniforms,
      null as unknown as THREE.WebGLRenderer,
    )
    const cloud = shader.fragmentShader.indexOf('ff2CloudLook(diffuseColor.rgb')
    const haze = shader.fragmentShader.indexOf('ff2AerialHaze(outgoingLight')
    const fog = shader.fragmentShader.indexOf('outgoingLight = mix(fogTint, outgoingLight, fogFac)')
    expect(cloud).toBeGreaterThan(-1)
    expect(haze).toBeGreaterThan(-1)
    expect(fog).toBeGreaterThan(-1)
    // cloud emits -> the air takes some out of the ray -> the sky is mixed over.
    expect(cloud).toBeLessThan(haze)
    expect(haze).toBeLessThan(fog)
  })

  it('gives the cloud its own world-position varying, so neither patch needs the other', () => {
    const material = new THREE.MeshStandardMaterial({ metalness: 0 })
    applyCloudLook(material, cloudLookUniforms())
    const shader = { vertexShader: VERTEX_STUB, fragmentShader: FRAGMENT_STUB, uniforms: {} }
    material.onBeforeCompile(
      shader as unknown as THREE.WebGLProgramParametersWithUniforms,
      null as unknown as THREE.WebGLRenderer,
    )
    expect(shader.vertexShader).toContain('varying vec3 vCloudWorldPos;')
    // DEV-785: the instance transform is applied BEFORE the model matrix, behind
    // three's own define, so a non-instanced draw (a unit test's mesh, a future
    // caller) compiles the same arithmetic it always did.
    const v = shader.vertexShader
    const local = v.indexOf('vec4 ff2CloudLocal = vec4(transformed, 1.0);')
    const gate = v.indexOf('#ifdef USE_INSTANCING')
    const apply = v.indexOf('ff2CloudLocal = instanceMatrix * ff2CloudLocal;')
    const world = v.indexOf('vCloudWorldPos = (modelMatrix * ff2CloudLocal).xyz;')
    expect(local).toBeGreaterThan(-1)
    expect(gate).toBeGreaterThan(local)
    expect(apply).toBeGreaterThan(gate)
    expect(world).toBeGreaterThan(apply)
    // The world position never reads `transformed` directly again.
    expect(v).not.toContain('modelMatrix * vec4(transformed')
    // Not the fog's, which may or may not have been applied by the time this runs.
    expect(shader.fragmentShader).not.toContain('ff2CloudLook(diffuseColor.rgb, normal, vUnityFog')
  })

  it('hands its uniforms to the shader, so one write reaches all nineteen meshes', () => {
    const material = new THREE.MeshStandardMaterial({ metalness: 0 })
    const uniforms = cloudLookUniforms()
    applyCloudLook(material, uniforms)
    const shader = { vertexShader: VERTEX_STUB, fragmentShader: FRAGMENT_STUB, uniforms: {} }
    material.onBeforeCompile(
      shader as unknown as THREE.WebGLProgramParametersWithUniforms,
      null as unknown as THREE.WebGLRenderer,
    )
    // The SAME objects, not copies — which is what makes a preset flip a uniform
    // write rather than a rebuild.
    expect((shader.uniforms as unknown as { uCloudLook: unknown }).uCloudLook).toBe(
      uniforms.uCloudLook,
    )
  })
})

describe('the preset files say what the row says', () => {
  it('Classic has the feature off AND its numbers at the identity', () => {
    expect(CLASSIC.enabled).toBe(false)
    expect(CLASSIC.wrap).toBe(0)
    expect(CLASSIC.rimStrength).toBe(0)
    expect(CLASSIC.driftSpeed).toBe(0)
    // 0.22 is the identity here rather than 0, because 0.22 is what BOTH presets
    // have rendered since the clouds landed (DEV-028) — `game/clouds.ts`'s
    // `CLOUD_EMISSIVE`. A 0 would make a hand-flipped Classic flag turn the
    // undersides black, which is not "what Classic rendered".
    expect(CLASSIC.emissive).toBe(0.22)
    // And a rimPower of 0 would be a full-strength rim over the whole body.
    expect(CLASSIC.rimPower).toBeGreaterThan(0)
  })

  it('Anniversary is on, lifts the emissive floor, and grows the placements', () => {
    expect(ANNIVERSARY.enabled).toBe(true)
    expect(ANNIVERSARY.wrap).toBeGreaterThan(0)
    expect(ANNIVERSARY.rimStrength).toBeGreaterThan(0)
    expect(ANNIVERSARY.emissive).toBeGreaterThan(CLASSIC.emissive)
    // §1.5 item 4 asks for "larger, higher". Both, or the row is half done.
    expect(ANNIVERSARY.scaleMultiplier).toBeGreaterThan(1)
    expect(ANNIVERSARY.altitudeLift).toBeGreaterThan(0)
    expect(ANNIVERSARY.driftSpeed).toBeGreaterThan(0)
  })

  it('does not lift the layer out of the sky', () => {
    // A lift is only a scale cue while the clouds are still a deck you read the
    // world under. CAMERA_FAR is 6 km; the lowest placement is the one that could
    // go wrong, and it is 539 m on `int_01`.
    const lowest = Math.min(...(level.clouds as { pos: number[] }[]).map((c) => c.pos[1] as number))
    expect(lowest + ANNIVERSARY.altitudeLift).toBeLessThan(3000)
  })

  it('does NOT grow a cloud onto the racing line — a fly-through must be deliberate', () => {
    // The invariant the scale multiplier could quietly break, and the reason it
    // is asserted rather than assumed: an ACCIDENTAL fly-through is not the
    // feature §1.5 asks for, it is a cloud you enter with no interior term, which
    // means popping from a lit silhouette to a DoubleSide backface and reading as
    // broken. It is close on `int_01` — the nearest cloud centre sits 321 m from
    // the line — so this is a live constraint, not a formality.
    //
    // A cloud's geometry is `sim/clouds.ts`'s unit blob at `NOMINAL_RADIUS` 0.5
    // of the MEAN radius, and the lobes push individual vertices out to roughly
    // 1.5x of that, so the margin is measured in normalised radii and asked to
    // clear 1.5 rather than 1.
    const p = cloudPlacementSettings(ANNIVERSARY)
    let nearest = Number.POSITIVE_INFINITY
    for (const c of level.clouds as { i: number; pos: number[]; scale: number[] }[]) {
      const cx = c.pos[0] as number
      const cy = (c.pos[1] as number) + p.altitudeLift
      const cz = c.pos[2] as number
      const rx = (c.scale[0] as number) * p.scaleMultiplier * 0.5
      const ry = (c.scale[1] as number) * p.scaleMultiplier * 0.5
      const rz = (c.scale[2] as number) * p.scaleMultiplier * 0.5
      for (const point of level.route as number[][]) {
        const d = Math.hypot(
          ((point[0] as number) - cx) / rx,
          ((point[1] as number) - cy) / ry,
          ((point[2] as number) - cz) / rz,
        )
        if (d < nearest) nearest = d
      }
    }
    expect(nearest).toBeGreaterThan(1.5)
  })

  it('is packed in the order the GLSL reads it', () => {
    const s = cloudLookSettings(ANNIVERSARY, SUN)
    expect(cloudLookPack(s)).toEqual([s.wrap, s.rimStrength, s.rimPower, s.sunTint])
  })

  it('null means OFF, so Classic tuning values can never become load-bearing', () => {
    // The same contract `attachEditionHaze` and `attachEditionCoast` keep: a
    // disabled feature is handed `null` rather than its own numbers with the flag
    // ignored, so nothing in Classic's block is observable.
    expect(cloudLookSettings(null, SUN)).toEqual(CLOUD_LOOK_OFF)
    expect(cloudPlacementSettings(null)).toEqual(CLOUD_PLACEMENT_OFF)
    expect(cloudDriftSettings(null)).toEqual(CLOUD_DRIFT_OFF)
  })
})

describe('the field itself, which is where the wiring lives', () => {
  // The pure functions above are all reachable without three; the thing that is
  // NOT is whether anything ever writes a matrix. A feature that computes a
  // perfect drift offset and never applies it passes every test in this file so
  // far, so these build the real `LoadedClouds` and read the matrices back.
  //
  // DEV-785: the clouds are instance matrices now, and the claim worth holding
  // is that a placement's matrix is EXACTLY the matrix the per-placement mesh
  // had: built here the old way, an `Object3D` with the three fields and
  // `updateMatrix()`, and compared element for element after the float32
  // rounding the GPU buffer applies (the old uniform was float32 as well).
  type Authored = { pos: number[]; quat: number[]; scale: number[] }
  const authored = level.clouds as unknown as Authored[]
  const placements = level.clouds as unknown as Parameters<typeof loadClouds>[0]
  const POOLED = { poolSize: 12, tintSpread: 0.08 } as const

  /** The matrix the per-placement mesh had, as float32. */
  const oldMatrix = (
    c: Authored,
    k = 1,
    lift = 0,
    wind: readonly number[] = [0, 0, 0],
  ): number[] => {
    const o = new THREE.Object3D()
    o.position.set(
      (c.pos[0] as number) + (wind[0] as number),
      (c.pos[1] as number) + lift + (wind[1] as number),
      (c.pos[2] as number) + (wind[2] as number),
    )
    o.quaternion.set(
      c.quat[0] as number,
      c.quat[1] as number,
      c.quat[2] as number,
      c.quat[3] as number,
    )
    o.scale.set((c.scale[0] as number) * k, (c.scale[1] as number) * k, (c.scale[2] as number) * k)
    o.updateMatrix()
    return Array.from(o.matrix.elements, Math.fround)
  }
  const matrixOf = (c: ReturnType<typeof loadClouds>, i: number): number[] =>
    Array.from(c.matrixOf(i, new THREE.Matrix4()).elements)
  const travelledOf = (c: ReturnType<typeof loadClouds>, i: number): number => {
    const m = matrixOf(c, i)
    const a = authored[i] as Authored
    return Math.hypot(
      (m[12] as number) - (a.pos[0] as number),
      (m[14] as number) - (a.pos[2] as number),
    )
  }

  for (const [label, options] of [
    ['one blob per cloud (no edition)', {}],
    ['the shared pool', { pool: POOLED }],
  ] as const) {
    describe(label, () => {
      it('starts where 2016 put it: every instance matrix is the old mesh matrix', () => {
        const clouds = loadClouds(placements, options)
        for (const [i, c] of authored.entries()) expect(matrixOf(clouds, i)).toEqual(oldMatrix(c))
        clouds.dispose()
      })

      it('grows, lifts and DRIFTS once the preset is pushed: the matrices really move', () => {
        const clouds = loadClouds(placements, { sun: SUN, ...options })
        clouds.setCloudLook(ANNIVERSARY)
        for (const [i, c] of authored.entries()) {
          expect(matrixOf(clouds, i)).toEqual(
            oldMatrix(c, ANNIVERSARY.scaleMultiplier, ANNIVERSARY.altitudeLift),
          )
        }
        const before = matrixOf(clouds, 0)
        clouds.update(0)
        clouds.update(100)
        const wind = cloudDriftOffset(100, cloudDriftSettings(ANNIVERSARY))
        for (const [i, c] of authored.entries()) {
          expect(matrixOf(clouds, i)).toEqual(
            oldMatrix(c, ANNIVERSARY.scaleMultiplier, ANNIVERSARY.altitudeLift, wind),
          )
        }
        expect(matrixOf(clouds, 0)).not.toEqual(before)
        expect(travelledOf(clouds, 0)).toBeCloseTo(ANNIVERSARY.driftSpeed * 100, 2)
        clouds.dispose()
      })

      it('puts every cloud back EXACTLY where 2016 had it on a flip to Classic', () => {
        // The regression this test exists for, and it was found by reading the code
        // back rather than by anything failing. `update` returns early when there is
        // no wind, so a flip from Anniversary to Classic used to leave every cloud
        // wherever the Anniversary wind had pushed it, permanently, because nothing
        // would ever recompute it. Classic's promise is 2016's placements exactly.
        const clouds = loadClouds(placements, { sun: SUN, ...options })
        clouds.setCloudLook(ANNIVERSARY)
        clouds.update(0)
        clouds.update(250)
        clouds.setCloudLook(null)
        for (const [i, c] of authored.entries()) expect(matrixOf(clouds, i)).toEqual(oldMatrix(c))
        // And it STAYS there: a frame after the flip must not drift it again.
        clouds.update(400)
        for (const [i, c] of authored.entries()) expect(matrixOf(clouds, i)).toEqual(oldMatrix(c))
        clouds.dispose()
      })

      it('resumes the wind by the CLOCK on a flip back, not from the flip', () => {
        // The other half of the same decision. The drift is a pure function of the
        // clock, so Anniversary -> Classic -> Anniversary lands where the clock says,
        // not where the sky was when it was last visible.
        const clouds = loadClouds(placements, { sun: SUN, ...options })
        clouds.setCloudLook(ANNIVERSARY)
        clouds.update(0)
        clouds.setCloudLook(null)
        clouds.setCloudLook(ANNIVERSARY)
        clouds.update(120)
        expect(travelledOf(clouds, 0)).toBeCloseTo(ANNIVERSARY.driftSpeed * 120, 2)
        clouds.dispose()
      })

      it('tells three the instances moved, so the GPU buffer and the cull sphere follow', () => {
        const clouds = loadClouds(placements, { sun: SUN, ...options })
        clouds.setCloudLook(ANNIVERSARY)
        clouds.update(0)
        const draw = clouds.pool[0] as (typeof clouds.pool)[number]
        const version = draw.mesh.instanceMatrix.version
        const centre = (draw.mesh.boundingSphere as THREE.Sphere).center.clone()
        clouds.update(200)
        expect(draw.mesh.instanceMatrix.version).toBeGreaterThan(version)
        // 200 s at the shipped speed is hundreds of metres: the sphere has moved.
        expect(
          (draw.mesh.boundingSphere as THREE.Sphere).center.distanceTo(centre),
        ).toBeGreaterThan(100)
        clouds.dispose()
      })
    })
  }
})

// ── stubs ────────────────────────────────────────────────────────────────
//
// The two hooks the patches replace, and enough of three's own text around them
// that the ordering assertion is about the real thing. Not three's whole shader:
// what is being tested is where two injected blocks land relative to each other
// and to the `<opaque_fragment>` include, and that needs the include and nothing
// else.

const VERTEX_STUB = `void main() {
  #include <begin_vertex>
  gl_Position = vec4(transformed, 1.0);
}`

const FRAGMENT_STUB = `void main() {
  vec4 diffuseColor = vec4(1.0);
  vec3 normal = vec3(0.0, 1.0, 0.0);
  vec3 outgoingLight = vec3(0.5);
  #include <opaque_fragment>
}`

const FOG: UnityFogParams = {
  mode: 2,
  density: 0.00025,
  linearStart: 100,
  linearEnd: 2500,
  color: [0.87, 0.66, 0.7],
  distanceFog: true,
  heightFog: true,
  useRadialDistance: true,
  height: 500,
  heightDensity: 0.015,
  startDistance: 256,
}

// ── DEV-276: which faces a cloud draws ────────────────────────────────────
//
// Matt, 2026-09-21: "it'd be nice if ... the cloud geo would be hidden (or at
// least not double-sided)." Culling the back faces is the second half of that
// sentence and delivers the first half for free -- inside a cloud, every face
// between you and the world is a back face, so the hull draws nothing.
//
// The VALUES are pinned here rather than only in the JSON, because this is a
// shipped default and DEV-266's rule is that a default gets one exported name
// and one assertion somebody has to edit on purpose.
describe('which faces a cloud draws (DEV-276)', () => {
  const tuning = (singleSided: boolean): CloudTuning => ({
    enabled: true,
    wrap: 0.5,
    rimStrength: 0.9,
    rimPower: 3,
    sunTint: 0.7,
    emissive: 0.3,
    scaleMultiplier: 1.35,
    altitudeLift: 250,
    driftSpeed: 3.5,
    driftDirection: [1, 0, 0],
    singleSided,
  })

  it('is DoubleSide for Classic, which is what the port has always drawn', () => {
    // `null` IS Classic -- the feature off, the material unchanged.
    expect(cloudMaterialSide(null)).toBe(THREE.DoubleSide)
    // And a preset that carries the flag false must agree with `null`, or the
    // belt and the braces disagree about what Classic is.
    expect(cloudMaterialSide(tuning(false))).toBe(THREE.DoubleSide)
  })

  it('culls the back faces when the preset asks', () => {
    expect(cloudMaterialSide(tuning(true))).toBe(THREE.FrontSide)
  })

  it('is the flag and nothing else that decides it', () => {
    // Every other field moved, the flag held: the answer must not budge. This
    // is the guard against somebody later keying the side off `enabled`, which
    // would silently make Classic single-sided the day its block is enabled.
    const off = { ...tuning(false), enabled: false, wrap: 0, driftSpeed: 0, emissive: 0.22 }
    expect(cloudMaterialSide(off)).toBe(THREE.DoubleSide)
    const on = { ...tuning(true), enabled: false, wrap: 0, driftSpeed: 0, emissive: 0.22 }
    expect(cloudMaterialSide(on)).toBe(THREE.FrontSide)
  })
})

// ── DEV-277: the whiteout envelope ────────────────────────────────────────
//
// Matt: "fade to white immediately when entering and softly fade out when you
// exit." The ASYMMETRY is the feature, so it is what these pin.
describe('the cloud whiteout envelope (DEV-277)', () => {
  const RELEASE = 0.6

  it('goes to full white in ONE step on entry, whatever the frame was', () => {
    // A cloud boundary is a surface you cross in one frame at 90 m/s. Easing in
    // would read as the fog arriving late, which is the complaint this
    // replaces -- so entry must not depend on dt at all.
    expect(whiteoutStep(0, true, 1 / 90, RELEASE, 1)).toBe(1)
    expect(whiteoutStep(0, true, 1 / 30, RELEASE, 1)).toBe(1)
    expect(whiteoutStep(0.4, true, 0.5, RELEASE, 1)).toBe(1)
  })

  it('fades out linearly and actually REACHES zero', () => {
    // An exponential never lands, which would leave every frame after a cloud
    // very slightly milky for ever. Walk it out and require an exact 0.
    let v = 1
    const dt = 1 / 60
    for (let i = 0; i < 60; i++) v = whiteoutStep(v, false, dt, RELEASE, 1)
    expect(v).toBe(0)
  })

  it('takes about `releaseSeconds` to do it', () => {
    let v = 1
    const dt = 1 / 120
    let frames = 0
    while (v > 0 && frames < 10000) {
      v = whiteoutStep(v, false, dt, RELEASE, 1)
      frames++
    }
    // Within ONE FRAME of the release time, which is the honest claim: the last
    // step lands on 0 from whatever float residue is left, so a fixed tolerance
    // in seconds is really a statement about the frame rate. `toBeCloseTo` at 2
    // digits fails here for exactly that reason -- 72 steps of 1/120 is 0.6 to
    // the bit, and the 73rd frame that clears the residue puts it 8 ms over.
    expect(frames * dt).toBeGreaterThanOrEqual(RELEASE - dt)
    expect(frames * dt).toBeLessThanOrEqual(RELEASE + dt)
  })

  it('is off by arithmetic at level 0, not by a branch somewhere else', () => {
    expect(whiteoutStep(0, true, 0.016, RELEASE, 0)).toBe(0)
    // And a level already on screen when the preset drops to 0 must come down,
    // never stick at the old target.
    expect(whiteoutStep(1, true, 0.016, RELEASE, 0)).toBe(0)
  })

  it('clamps a level above 1 and survives a zero or missing release', () => {
    expect(whiteoutStep(0, true, 0.016, RELEASE, 4)).toBe(1)
    // releaseSeconds 0 means "no fade", which must be an instant 0 rather than
    // a division by zero.
    expect(whiteoutStep(1, false, 0.016, 0, 1)).toBe(0)
    expect(Number.isFinite(whiteoutStep(1, false, 0, RELEASE, 1))).toBe(true)
  })

  it('never returns more than the level it is aiming at', () => {
    // Guards the case where the preset is turned DOWN while white is on screen:
    // the carried value is above the new target and must not be held there.
    expect(whiteoutStep(1, false, 0.001, RELEASE, 0.3)).toBeLessThanOrEqual(0.3)
  })
})
