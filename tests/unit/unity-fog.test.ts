// tests/unit/unity-fog.test.ts — the fog parameter packing, pinned.
//
// The fog SHADER cannot be unit tested without a GL context, and the screenshot
// spec covers whether it looks right. What can be tested here is the arithmetic
// that turns a mission's authored fog into shader uniforms — and that is where
// a silent error would hide, because wrong-density fog reads as an art choice
// rather than a bug.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { createUnityFog, FOG_EXP, FOG_EXP2, FOG_LINEAR, sceneFogParams } from '@/render/unity-fog'
import int01 from '../../content/levels/int_01_hoverJet.json'

describe('Unity scene fog parameter packing', () => {
  it('rescales density into base 2, because the shader uses exp2', () => {
    const [exp2Coefficient, expCoefficient] = sceneFogParams(FOG_EXP, 1, 0, 0)
    // 1 / ln 2 and 1 / sqrt(ln 2). Unity hard-codes both; so do we, and this is
    // the check that we hard-coded them correctly.
    expect(expCoefficient).toBeCloseTo(1 / Math.LN2, 9)
    expect(exp2Coefficient).toBeCloseTo(1 / Math.sqrt(Math.LN2), 9)
  })

  it('reproduces exp fog: factor = exp(-density * distance)', () => {
    const density = 0.0005
    const distance = 3100
    const [, expCoefficient] = sceneFogParams(FOG_EXP, density, 0, 0)
    // The shader computes exp2(-(coefficient * d)).
    const shader = 2 ** -(expCoefficient * distance)
    expect(shader).toBeCloseTo(Math.exp(-density * distance), 9)

    // And the thing this replaced: three's FogExp2 at the same density is a
    // completely different curve. 0.21 visibility against 0.09 — over twice the
    // fog. That difference is why the fog is hand-written.
    const threeFogExp2 = Math.exp(-((density * distance) ** 2))
    expect(shader).toBeCloseTo(0.2122, 4)
    expect(threeFogExp2).toBeCloseTo(0.0905, 4)
    // Over twice the fog, at the same authored density.
    expect(shader / threeFogExp2).toBeGreaterThan(2.3)
  })

  it('reproduces exp2 fog: factor = exp(-(density * distance)^2)', () => {
    const density = 0.0004
    const distance = 2000
    const [exp2Coefficient] = sceneFogParams(FOG_EXP2, density, 0, 0)
    const f = exp2Coefficient * distance
    expect(2 ** -(f * f)).toBeCloseTo(Math.exp(-((density * distance) ** 2)), 9)
  })

  it('reproduces linear fog: factor = (end - z) / (end - start)', () => {
    const [, , slope, intercept] = sceneFogParams(FOG_LINEAR, 0, 100, 2500)
    for (const z of [100, 800, 2500]) {
      expect(z * slope + intercept).toBeCloseTo((2500 - z) / (2500 - 100), 9)
    }
  })

  it('leaves the linear terms at zero for the exponential modes', () => {
    // A non-zero slope in exp mode would be harmless in the shader (it reads a
    // different channel) but means the packing has drifted from Unity's.
    for (const mode of [FOG_EXP, FOG_EXP2]) {
      const [, , slope, intercept] = sceneFogParams(mode, 0.0005, 100, 2500)
      expect(slope).toBe(0)
      expect(intercept).toBe(0)
    }
  })

  it('survives a degenerate linear range without dividing by zero', () => {
    const [, , slope, intercept] = sceneFogParams(FOG_LINEAR, 0, 500, 500)
    expect(Number.isFinite(slope)).toBe(true)
    expect(Number.isFinite(intercept)).toBe(true)
    // `-invDiff` of zero is -0, which `toBe(0)` rejects. It is still zero.
    expect(Math.abs(slope)).toBe(0)
  })
})

describe('the shipped mission actually needs this', () => {
  it('int_01_hoverJet is fog mode 2 — the one three.js does not have', () => {
    // If this ever becomes 1 or 3, the hand-written fog is still correct but
    // the justification in unity-fog.ts's header is not, and someone will
    // reasonably ask why it exists.
    expect(int01.fog.mode).toBe(FOG_EXP)
    expect(int01.fog.heightFog).toBe(true)
    // The fog plane. Simonet's peaks reach ~1090 m, so they stand well clear of
    // it while the sea is buried — which is the silhouette the game is known for.
    expect(int01.fog.height).toBe(164)
    expect(int01.fog.heightDensity).toBeCloseTo(0.2, 6)
  })
})

describe('colour space — the fog and the sky must agree, exactly', () => {
  // ── The bug this section exists to prevent recurring ────────────────────
  //
  // `unity-fog.ts` used to blend in sRGB and treat `m_FogColor` as if it were
  // already linear, on the stated grounds that "the 2016 project renders in
  // GAMMA colour space". `ProjectSettings.asset` says `m_ActiveColorSpace: 1`
  // — Linear — and the empirical justification offered was about a CPU
  // heightmap read, which has nothing to do with the framebuffer.
  //
  // Meanwhile `render/sky.ts` had been linearising the SAME number all along
  // to paint the horizon. So distant terrain faded toward a rose that was
  // brighter than the sky behind it: a milky sheet in front of the world, and
  // a seam at the skyline. Matt reported it twice as "fog too thick".
  //
  // The invariant is not "the fog is linear" in the abstract. It is that these
  // two consumers of one number stay equal, because the horizon is where a
  // disagreement becomes visible.

  const srgbToLinear = (c: number): number =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4

  const fogFor = (color: [number, number, number]) =>
    createUnityFog({
      mode: int01.fog.mode,
      density: int01.fog.density,
      linearStart: int01.fog.linearStart,
      linearEnd: int01.fog.linearEnd,
      color,
      distanceFog: true,
      heightFog: true,
      useRadialDistance: true,
      height: int01.fog.height,
      heightDensity: int01.fog.heightDensity,
      startDistance: int01.fog.startDistance,
    })

  it('linearises m_FogColor, because Unity linearises unity_FogColor', () => {
    const raw = int01.fog.color.slice(0, 3) as [number, number, number]
    const fog = fogFor(raw)
    expect(fog.linearColor.r).toBeCloseTo(srgbToLinear(raw[0]), 6)
    expect(fog.linearColor.g).toBeCloseTo(srgbToLinear(raw[1]), 6)
    expect(fog.linearColor.b).toBeCloseTo(srgbToLinear(raw[2]), 6)
  })

  it('is a real conversion, not a rounding difference', () => {
    // If someone "simplifies" the linearisation away, the numbers have to move
    // far enough that this test is not measuring float noise. On this mission
    // the green channel goes 0.659 -> 0.392: a third of the range.
    const raw = int01.fog.color.slice(0, 3) as [number, number, number]
    const fog = fogFor(raw)
    expect(raw[1] - fog.linearColor.g).toBeGreaterThan(0.2)
    // And it is DARKER on every channel. Brighter would mean the transfer
    // function is inverted, which is the other way to get this wrong.
    expect(fog.linearColor.r).toBeLessThan(raw[0])
    expect(fog.linearColor.g).toBeLessThan(raw[1])
    expect(fog.linearColor.b).toBeLessThan(raw[2])
  })

  it('matches the sky’s horizon colour, which is the whole point', () => {
    // `render/sky.ts` builds its horizon as srgbToLinear(fog.color). If these
    // two ever drift apart the skyline seams — terrain fading to one rose in
    // front of a sky painted a different one.
    const raw = int01.fog.color.slice(0, 3) as [number, number, number]
    const fog = fogFor(raw)
    const skyHorizon = raw.map(srgbToLinear)
    expect(fog.linearColor.r).toBeCloseTo(skyHorizon[0] as number, 9)
    expect(fog.linearColor.g).toBeCloseTo(skyHorizon[1] as number, 9)
    expect(fog.linearColor.b).toBeCloseTo(skyHorizon[2] as number, 9)
  })

  it('leaves black and white alone, so the transfer function is the right one', () => {
    // Sanity on the curve itself: 0 and 1 are fixed points of sRGB->linear, and
    // a gamma-2.2 approximation would also pass this — but a swapped OETF/EOTF
    // would not.
    expect(fogFor([0, 0, 0]).linearColor.r).toBeCloseTo(0, 9)
    expect(fogFor([1, 1, 1]).linearColor.r).toBeCloseTo(1, 9)
    // 0.5 sRGB is 0.2140 linear. This is the value that distinguishes the real
    // curve from `x^2.2` (which gives 0.2176).
    expect(fogFor([0.5, 0.5, 0.5]).linearColor.r).toBeCloseTo(0.21404, 5)
  })
})

// ── the camera's altitude, which is not `camera.position.y` ───────────────
//
// In the cockpit the camera is a CHILD of the XR rig: `camera.position` is the
// head pose inside the rig — (0, 0, 0) until you lean — and the rig carries the
// half-kilometre of altitude. The shader reads three's built-in
// `cameraPosition`, which is the WORLD position, so reading the local one in
// `update` makes the two halves of the same calculation disagree about where
// the eye is.
//
// The symptom was not subtle and it was not obviously fog. With `k` computed as
// though the eye were at y = 0 — always below the 387 m plane — `g0` stays
// non-zero for every fragment ABOVE the plane, and Lengyel's `g0^2 / |FdotV|`
// then divides by `fragY - cameraPosition.y`: zero at the eye's REAL altitude.
// `g` blows up, `fogFac` goes to zero, and those pixels come out as 100% fog
// colour — a pink line drawn across the mountains at exactly eye level, which
// follows you up and down. Matt reported it as *"the fog horizon seems to draw
// on top of mountains"*, which is exactly what it looked like.
//
// Nothing caught it because every screenshot spec we own uses `?view=cam`, and
// `applyViewpoint` sets the position on the scene-root camera itself — local
// and world are equal there, and the bug cannot occur.
describe('the camera altitude the half-space term is measured from', () => {
  const params = {
    mode: FOG_EXP,
    density: 0.00025,
    linearStart: 100,
    linearEnd: 2500,
    color: [0.866667, 0.658824, 0.698039] as [number, number, number],
    distanceFog: true,
    heightFog: true,
    useRadialDistance: true,
    height: 387,
    heightDensity: 0.0075,
    startDistance: 256,
  }

  /** A camera parented to a rig, exactly as the cockpit builds it. */
  const rigged = (rigY: number, headY = 0) => {
    const rig = new THREE.Group()
    rig.position.set(-391.7, rigY, 1529.7)
    const camera = new THREE.PerspectiveCamera()
    camera.position.set(0, headY, 0)
    rig.add(camera)
    return camera
  }

  it('uses the WORLD altitude when the camera sits inside a rig', () => {
    const fog = createUnityFog(params)
    fog.update(rigged(506))
    // uFogHeight is (height, FdotC, k, heightDensity * 0.5).
    const h = fog.uniforms.uFogHeight.value
    expect(h.x).toBe(387)
    expect(h.y).toBeCloseTo(506 - 387, 4)
    // 506 is ABOVE the plane, so k is 0. Reading the local position gives
    // y = 0, FdotC = -387 and k = 1 — the inversion that drew the line.
    expect(h.z).toBe(0)
  })

  it('puts the camera on the correct side of the plane, rig or no rig', () => {
    const fog = createUnityFog(params)
    for (const [rigY, expectedK] of [
      [120, 1],
      [386, 1],
      [387, 1],
      [388, 0],
      [506, 0],
      [900, 0],
    ] as [number, number][]) {
      fog.update(rigged(rigY))
      expect(fog.uniforms.uFogHeight.value.z, `rig at ${rigY} m`).toBe(expectedK)
      expect(fog.uniforms.uFogHeight.value.y, `rig at ${rigY} m`).toBeCloseTo(rigY - 387, 4)
    }
  })

  it('adds the head pose to the rig, because leaning moves the eye', () => {
    const fog = createUnityFog(params)
    // Standing on the far side of the plane from the rig's own origin: the
    // answer has to come from the sum, not from either half.
    fog.update(rigged(385, 4))
    expect(fog.uniforms.uFogHeight.value.y).toBeCloseTo(389 - 387, 4)
    expect(fog.uniforms.uFogHeight.value.z).toBe(0)
  })

  it('agrees with an unparented camera, which is the case the specs cover', () => {
    // `?view=cam` puts the camera at the scene root, where local == world. That
    // is why every screenshot we have looks right and the headset did not.
    const rig = createUnityFog(params)
    const bare = createUnityFog(params)
    rig.update(rigged(506))
    const camera = new THREE.PerspectiveCamera()
    camera.position.set(-391.7, 506, 1529.7)
    bare.update(camera)
    expect(rig.uniforms.uFogHeight.value.toArray()).toEqual(
      bare.uniforms.uFogHeight.value.toArray(),
    )
  })
})

// ── the colour the fog fades TOWARD ──────────────────────────────────────
//
// Matt: *"how can we get the horizon to blend into the sky better?"*
//
// 2016 fogs toward one colour in every direction. On `int_01` that is
// (0.723, 0.392, 0.445) linear, and the sky it fades into runs 0.27 to 0.51 in
// red and 0.23 to 0.25 in blue depending on bearing — so the fog is 1.4x to
// 2.7x brighter than the sky behind it and nearly twice as blue, and no single
// colour can close that because the sky's own horizon swings by a factor of two
// around the compass.
//
// So the fog takes the sky's radiance along the view ray instead. Measured on
// four views, the colour step across the skyline falls 41% on average.
//
// The GLSL cannot be unit tested without a GL context — what can be, and what
// would silently break the whole thing, is whether the coefficients reach it.
describe('the fog takes its colour from the sky', () => {
  const base = {
    mode: FOG_EXP,
    density: 0.00025,
    linearStart: 100,
    linearEnd: 2500,
    color: [0.866667, 0.658824, 0.698039] as [number, number, number],
    distanceFog: true,
    heightFog: true,
    useRadialDistance: true,
    height: 387,
    heightDensity: 0.0075,
    startDistance: 256,
  }
  const nine = Array.from({ length: 9 }, (_, i) => [i * 0.1, i * 0.2, i * 0.3])

  it('carries all nine coefficients through to the shader, unchanged', () => {
    const fog = createUnityFog({ ...base, skySh: nine })
    const u = fog.uniforms as unknown as {
      uFogSh: { value: { x: number; y: number; z: number }[] }
      uFogSkyMode: { value: number }
    }
    expect(u.uFogSkyMode.value).toBe(1)
    for (let i = 0; i < 9; i++) {
      const v = u.uFogSh.value[i] as { x: number; y: number; z: number }
      expect([v.x, v.y, v.z]).toEqual(nine[i])
    }
  })

  it('falls back to the flat colour for a SHORT coefficient array', () => {
    // Eight coefficients is not a worse sky, it is a DIFFERENT one — and the
    // fog would then fade toward a colour the dome never paints, which is the
    // seam back again in a form nobody would think to look for.
    for (const partial of [nine.slice(0, 8), [], nine.slice(0, 1)]) {
      const fog = createUnityFog({ ...base, skySh: partial })
      expect(
        (fog.uniforms as unknown as { uFogSkyMode: { value: number } }).uFogSkyMode.value,
      ).toBe(0)
    }
  })

  it('falls back for the ten missions with no decoded sky at all', () => {
    // Null and absent both mean "keep 2016's flat colour", which is the only
    // answer available without a sky to sample.
    expect(
      (
        createUnityFog({ ...base, skySh: null }).uniforms as unknown as {
          uFogSkyMode: { value: number }
        }
      ).uFogSkyMode.value,
    ).toBe(0)
    expect(
      (createUnityFog(base).uniforms as unknown as { uFogSkyMode: { value: number } }).uFogSkyMode
        .value,
    ).toBe(0)
  })

  it('normalises the sun direction, because the glow term is a dot product', () => {
    const fog = createUnityFog({ ...base, skySh: nine, sunDirection: [0, -3, 4] })
    const d = (fog.uniforms as unknown as { uFogSunDir: { value: THREE.Vector3 } }).uFogSunDir.value
    expect(d.length()).toBeCloseTo(1, 9)
    expect(d.y).toBeCloseTo(-0.6, 9)
    expect(d.z).toBeCloseTo(0.8, 9)
  })
})
