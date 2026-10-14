// tests/unit/water-underside.test.ts — the ocean, from the wrong side of it.
//
// The launch ride spends about 97 m of its 106 m climb below the surface
// (`int_01_hoverJet.json`: spawn 19.788, rise 106.647, sea level 116.6). 2016
// drew nothing there — its water is `Cull Back`, see `src/render/water.ts`'s
// header — so there is no oracle to diff against and everything here is either
// a GEOMETRIC fact about refraction or a measured bound.
//
// ── This header used to claim the ride was where you SEE it. It is not. ───
//
// The sentence was: *"so the first thing anyone sees in a headset is this
// shader's underside."* It is false, and it is worth leaving the wrong belief
// named rather than quietly deleting it, because of HOW it was wrong.
//
// It was derived: the spawn is 97 m below sea level, therefore the eye is under
// the water, therefore the eye sees the underside. Every step is sound and the
// conclusion does not follow, because **DEV-106 sealed the shaft** — Matt,
// 2026-09-14: *"our 'elevator ride' isn't enclosed, and players can see the
// world as they rise. please implement sides of the elevator shaft."*
// `shaft-walls.test.ts` holds the result: the tube is closed from the room's
// ceiling to the rim, and the order on the way up is REVEAL, then RIM, then
// RELEASE. You ride inside an opaque tube and the world arrives at the rim. The
// water inside the bore is discarded (`FF2_WATER_SHAFT`) and the water outside
// it is behind the walls.
//
// So the underside is seen at the BREACH and on a crash into the sea, not on
// the ride. Caught by Matt, 2026-09-18, reading this file's own claim back
// against the feature he had asked for four days earlier — two features each
// knowing something the other did not, which is CLAUDE.md's agreement lesson
// with the halves in different files.
//
// **What this does NOT change: any of the assertions below.** They are geometry
// — where the refracted ray points, what fraction of the hemisphere the window
// admits, where the specular lobe can fire. Those are true wherever the eye is,
// and a wrong sentence about when a player looks is not a reason to weaken them.
//
// ── What this file can and cannot prove ──────────────────────────────────
//
// Same bargain as `water.test.ts`: the shading lives twice, once in TypeScript
// and once in GLSL, and node cannot run the GLSL. So the numeric tests pin the
// TypeScript oracles and the last block pins the SPELLING of the shader against
// them — including the index of refraction, which is interpolated into the GLSL
// from the TypeScript constant and therefore cannot drift.
//
// ── Test the geometry, not the sign ──────────────────────────────────────
//
// CLAUDE.md's orientation lesson: *"a distance or an aspect ratio is true
// independently of what you believed; a quaternion assertion is your belief
// written twice."* So there is no test here that says "the normal is flipped".
// There are tests that say the refracted ray at the centre of the window points
// at the zenith, that the ray at its rim lies in the horizontal plane, that the
// window admits exactly the fraction of the hemisphere `1 - cos(asin(1/n))`
// predicts, and that the whole sky maps into it. Each of those is false for a
// wrong index, an inverted eta, or a hand-rolled Snell with a sign error.
//
// The one that earned its keep: **the specular gate**. The first version of
// this change left the Blinn-Phong term ungated on the reasoning that a
// down-turned normal collapses `N.h` on its own. The last test in "the sun,
// from underneath" constructs the counter-example instead of believing the
// reasoning, and there is a real place to stand under the water where `N.h` is
// exactly **1** and the lobe fires at full `_SpecColor`.

import { describe, expect, it } from 'vitest'
import { TERRAIN } from '@/generated/constants.generated'
import {
  applyWaterWaves,
  maxFacetTiltRadians,
  orientWaterNormal,
  refractDirection,
  snellWindowRadians,
  WATER_F0,
  WATER_IOR,
  WATER_SURFACE_GLSL,
  waterTransmittance,
} from '@/render/water'
import { shRadiance } from '@/sim/sky-dome'
import int01 from '../../content/levels/int_01_hoverJet.json'

const DEG = 180 / Math.PI
type Vec3 = [number, number, number]

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2])
  return [v[0] / l, v[1] / l, v[2] / l]
}
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** Straight DOWN — the surface normal on the eye's side when the eye is under. */
const DOWN: Vec3 = [0, -1, 0]

/**
 * A ray from an eye under the water toward a patch of surface `deg` from the
 * zenith. This is what the fragment shader calls `viewDir`: it points UP, from
 * the eye to the surface.
 */
const viewFromBelow = (deg: number, azimuth = 0): Vec3 => {
  const a = deg / DEG
  return [Math.sin(a) * Math.cos(azimuth), Math.cos(a), Math.sin(a) * Math.sin(azimuth)]
}

describe("Snell's window is the shape the index of refraction makes it", () => {
  it('puts the critical angle at 48.607 degrees, and F0 at 0.0204', () => {
    // Both are closed forms of WATER_IOR, so this is the one place the 1.333
    // itself is written twice — deliberately, because everything below is a
    // consequence of it and a silent change should land here first.
    expect(WATER_IOR).toBe(1.333)
    expect(snellWindowRadians() * DEG).toBeCloseTo(48.6066, 3)
    expect(WATER_F0).toBeCloseTo(0.0203732, 7)
    expect(WATER_F0).toBeCloseTo(((WATER_IOR - 1) / (WATER_IOR + 1)) ** 2, 12)
  })

  it('aims the middle of the window at the zenith', () => {
    // Looking straight up, the surface does not bend the ray at all. True of
    // any index; false of a sign error in `refract`.
    const t = refractDirection(viewFromBelow(0), DOWN)
    expect(t).not.toBeNull()
    expect((t as Vec3)[0]).toBeCloseTo(0, 9)
    expect((t as Vec3)[1]).toBeCloseTo(1, 9)
    expect((t as Vec3)[2]).toBeCloseTo(0, 9)
  })

  it('lays the RIM of the window flat along the horizon', () => {
    // The geometric statement, and the one a wrong eta cannot satisfy: as the
    // incidence approaches the critical angle the transmitted ray approaches
    // the horizontal plane. Its elevation goes to zero, not to some other
    // angle, and it does so from above.
    const critical = snellWindowRadians() * DEG
    const justInside = refractDirection(viewFromBelow(critical - 1e-4), DOWN)
    expect(justInside).not.toBeNull()
    const elevation = Math.asin((justInside as Vec3)[1]) * DEG
    expect(elevation).toBeGreaterThan(0)
    expect(elevation).toBeLessThan(0.5)

    // And past it there is no transmitted ray at all: total internal
    // reflection, which GLSL spells as the zero vector and this spells as null.
    expect(refractDirection(viewFromBelow(critical + 1e-4), DOWN)).toBeNull()
    expect(refractDirection(viewFromBelow(60), DOWN)).toBeNull()
    expect(refractDirection(viewFromBelow(89), DOWN)).toBeNull()
  })

  it('admits 33.88 % of the upward hemisphere, measured rather than asserted', () => {
    // Integrate the hemisphere by solid angle — uniform in cos(theta), so a
    // regular grid in `u` is a fair sample — and count what gets through.
    // `1 - cos(critical)` is the closed form; this walks the function instead.
    const N = 20_000
    let through = 0
    for (let i = 0; i < N; i++) {
      const cosTheta = (i + 0.5) / N
      const theta = Math.acos(cosTheta) * DEG
      if (refractDirection(viewFromBelow(theta), DOWN)) through++
    }
    const fraction = through / N
    expect(fraction).toBeCloseTo(1 - Math.cos(snellWindowRadians()), 3)
    expect(fraction).toBeCloseTo(0.33877, 3)
  })

  it('fits the WHOLE sky inside it, which is what makes it a window', () => {
    // The other direction: every ray arriving from anywhere in the sky, from
    // straight overhead to the horizon, must refract INTO the cone. If any
    // escaped it, the window would be an aperture rather than the whole sky
    // compressed, and the eta would be the wrong way up.
    const critical = snellWindowRadians() * DEG
    let widest = 0
    for (let deg = 0; deg <= 89.999; deg += 0.25) {
      // Downward into the water, normal up on the air side.
      const incident = norm([Math.sin(deg / DEG), -Math.cos(deg / DEG), 0])
      const t = refractDirection(incident, [0, 1, 0], 1 / WATER_IOR)
      expect(t, `${deg} deg`).not.toBeNull()
      widest = Math.max(widest, Math.acos(-(t as Vec3)[1]) * DEG)
    }
    expect(widest).toBeLessThanOrEqual(critical)
    expect(widest).toBeCloseTo(critical, 1)
  })
})

describe('the rim of the window closes by itself', () => {
  it('lets 97.96 % through at the centre', () => {
    expect(waterTransmittance(1)).toBeCloseTo(1 - WATER_F0, 12)
    expect(waterTransmittance(1)).toBeCloseTo(0.979627, 6)
  })

  it('reaches exactly zero at the critical angle rather than being cut off', () => {
    // This is the anti-clipping property, and it is why the Schlick term is
    // evaluated on the TRANSMITTED angle: `cosT` reaches 0 at the critical
    // angle, so the window arrives at zero on its own. Evaluated on the
    // INCIDENT angle it would still be at 0.7 when `refract` stopped returning
    // a ray, and the window would have a hard bright rim that needed a
    // smoothstep — a tuned number — to hide.
    expect(waterTransmittance(0)).toBe(0)

    const critical = snellWindowRadians() * DEG
    const at = (deg: number): number => {
      const t = refractDirection(viewFromBelow(deg), DOWN)
      return t ? waterTransmittance(dot(t, [0, 1, 0])) : 0
    }
    let previous = Number.POSITIVE_INFINITY
    for (let deg = 0; deg < critical; deg += critical / 2000) {
      const value = at(deg)
      expect(value, `${deg} deg`).toBeLessThanOrEqual(previous + 1e-12)
      previous = value
    }
    // Monotone all the way, and already dark at the last sample inside.
    expect(previous).toBeLessThan(0.02)
  })

  it('spends the outer 5 degrees of the window on the fade', () => {
    // How WIDE the rim is, which is the thing a screenshot shows and a
    // monotonicity test does not. Bisected rather than asserted: the fade runs
    // 0.9 -> 0.5 across the outer 5.03 degrees and 0.5 -> 0 across the last
    // 0.58, so the window has a soft edge and then a thin bright lip, which is
    // what the facets then break up.
    const critical = snellWindowRadians() * DEG
    const incidenceFor = (target: number): number => {
      let lo = 0
      let hi = critical
      for (let i = 0; i < 80; i++) {
        const mid = (lo + hi) / 2
        const t = refractDirection(viewFromBelow(mid), DOWN)
        if (t && waterTransmittance(dot(t, [0, 1, 0])) > target) lo = mid
        else hi = mid
      }
      return (lo + hi) / 2
    }
    expect(critical - incidenceFor(0.9)).toBeCloseTo(5.0325, 3)
    expect(critical - incidenceFor(0.5)).toBeCloseTo(0.5751, 3)
    expect(incidenceFor(0.9)).toBeLessThan(incidenceFor(0.5))
  })
})

describe('the eye decides which way is out', () => {
  const facet: Vec3 = norm([0.1, 0.99, -0.05])

  it('turns the normal toward the eye on both sides', () => {
    // Stated as a question about the EYE rather than about a sign: does the
    // normal point at the thing looking at it?
    const above = orientWaterNormal(facet, 130, 116.6)
    const below = orientWaterNormal(facet, 60, 116.6)
    expect(dot(above, [0, 130 - 116.6, 0] as Vec3)).toBeGreaterThan(0)
    expect(dot(below, [0, 60 - 116.6, 0] as Vec3)).toBeGreaterThan(0)
  })

  it('preserves the facet TILT, so the clamp means the same on both sides', () => {
    // The whole reason the DEV-050 clamp survives this change unedited: turning
    // the normal over is a reflection about the horizontal plane, so its angle
    // away from vertical is untouched and `maxFacetTiltRadians` still bounds
    // it. If this were a rotation, or a `lookAt`, the bound would be a
    // different bound on the underside and the speckle would come back.
    for (const raw of [
      [0.1, 0.99, -0.05],
      [0, 1, 0],
      [0.12, -0.98, 0.16],
      [0.7, 0.7, 0],
    ] as Vec3[]) {
      const f = norm(raw)
      const tilt = Math.acos(Math.min(1, Math.abs(f[1])))
      for (const [eyeY, surfaceY] of [
        [130, 116.6],
        [60, 116.6],
      ] as const) {
        const n = orientWaterNormal(f, eyeY, surfaceY)
        expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1, 12)
        expect(Math.acos(Math.min(1, Math.abs(n[1])))).toBeCloseTo(tilt, 12)
        // and the horizontal bearing is either kept or reversed as a whole,
        // never rotated: the cross product with the input is zero.
        expect(Math.abs(n[0] * f[2] - n[2] * f[0])).toBeCloseTo(0, 12)
      }
    }
    // The clamp itself is unchanged by any of this.
    expect(maxFacetTiltRadians(4, 32) * DEG).toBeCloseTo(10.62, 2)
  })

  it('treats the eye exactly ON the surface as above it', () => {
    // A documented tie-break rather than an accident. The shader spells the
    // same comparison (`cameraPosition.y < surfaceWorld.y`), so the two agree
    // on the one sample where it could matter.
    expect(orientWaterNormal([0, 1, 0], 116.6, 116.6)[1]).toBe(1)
    expect(orientWaterNormal([0, 1, 0], 116.5999, 116.6)[1]).toBe(-1)
  })
})

describe('the sun, from underneath', () => {
  const sun = int01.lighting.sun as { direction: number[]; elevationDeg: number }
  const sky = int01.lighting.sky as { available: boolean; sh: number[][] }
  /** TOWARD the sun, THREE space — the shader's `uSunDir`. */
  const toSun = norm([
    -(sun.direction[0] as number),
    -(sun.direction[1] as number),
    -(sun.direction[2] as number),
  ])

  it('lands inside the window with 0.16 degrees to spare', () => {
    // `int_01`'s sun is 4 degrees above the horizon, which is 86 from the
    // zenith — and 86 degrees of air refracts to 48.45 in water, just inside
    // the 48.61 rim. So the sun IS in the window, and only just. Worth pinning:
    // it is the difference between an underside with the sun blazing through
    // the edge of it and an underside with nothing in it at all.
    expect(sun.elevationDeg).toBeCloseTo(4.0, 3)
    const fromZenith = Math.acos(toSun[1])
    const inside = Math.asin(Math.sin(fromZenith) / WATER_IOR)
    expect(inside * DEG).toBeCloseTo(48.4485, 3)
    expect((snellWindowRadians() - inside) * DEG).toBeCloseTo(0.1581, 3)
    expect(inside).toBeLessThan(snellWindowRadians())
  })

  it('still gets 30 % of its light through at that angle', () => {
    // Being inside the rim is not enough on its own: the transmittance there
    // could have been 1 %. It is 0.297, which is what makes the shaft visible.
    const inside = Math.asin(Math.sin(Math.acos(toSun[1])) / WATER_IOR)
    const t = refractDirection(viewFromBelow(inside * DEG), DOWN) as Vec3
    expect(t).not.toBeNull()
    expect(waterTransmittance(dot(t, [0, 1, 0]))).toBeCloseTo(0.29722, 4)
  })

  it('makes the ceiling brighter toward the sun than away from it', () => {
    // The brief, as a luminance RATIO rather than as a belief about normals —
    // and through the real level's nine sky coefficients, the same ones
    // `render/sky.ts` paints the background with. The SH sky has no disc, so
    // the contrast is a gradient rather than a highlight: 1.12 at the rim.
    expect(sky.available).toBe(true)
    expect(sky.sh).toHaveLength(9)
    const lum = (c: { r: number; g: number; b: number }) =>
      0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
    const azimuth = Math.atan2(toSun[2], toSun[0])
    const ratioAt = (deg: number): number => {
      const toward = viewFromBelow(deg, azimuth)
      const away = viewFromBelow(deg, azimuth + Math.PI)
      // UNITY space for the SH, as the shader does it: our world is mirrored.
      const a = lum(shRadiance(sky.sh, toward[0], toward[1], -toward[2], { r: 0, g: 0, b: 0 }))
      const b = lum(shRadiance(sky.sh, away[0], away[1], -away[2], { r: 0, g: 0, b: 0 }))
      return a / b
    }
    expect(ratioAt(48)).toBeCloseTo(1.1227, 3)
    // and it grows all the way out from the zenith, where by symmetry there is
    // no toward and no away.
    expect(ratioAt(0)).toBeCloseTo(1, 6)
    for (const [a, b] of [
      [0, 15],
      [15, 30],
      [30, 45],
      [45, 48],
    ] as const) {
      expect(ratioAt(b), `${a} -> ${b}`).toBeGreaterThan(ratioAt(a))
    }
  })

  it('CAN glint on the underside, which is why the specular is gated', () => {
    // The claim this replaced was "with the normal turned down, `N.h`
    // collapses and the Blinn-Phong lobe vanishes on its own, so the specular
    // block needs no branch". It is false, and this is a CONSTRUCTION rather
    // than a sweep — so it is a proof of the worst case, not a sample near it.
    //
    // Blinn-Phong is maximal when the half vector IS the normal. Invert that:
    // pick the facet, then solve for the eye direction that puts `h` exactly on
    // it, `toEye = 2 (N . S) N - S`, which is automatically a unit vector. The
    // only question left is whether that eye is under the water — and for a
    // facet tilted the full 7.13 degrees TOWARD the sun's azimuth it is, by
    // 0.178 of downward component. So there is a real place to stand, below the
    // surface, where the ungated term is `_SpecColor` at full strength: a
    // mirror-sharp highlight of a sun that is on the other side of the water.
    const exponent = (TERRAIN.simonet.terrains.ocean.material.specular.shininess as number) * 128
    const specColor = TERRAIN.simonet.terrains.ocean.material.specular.color[0] as number
    expect(exponent).toBeCloseTo(25.728, 3)
    expect(specColor).toBe(0.5)

    const tilt = Math.atan(4 / 32)
    expect(tilt * DEG).toBeCloseTo(7.125, 3)
    const bearing = Math.hypot(toSun[0], toSun[2])
    // Down, leaning the full bound toward the sun's azimuth.
    const n: Vec3 = [
      (Math.sin(tilt) * toSun[0]) / bearing,
      -Math.cos(tilt),
      (Math.sin(tilt) * toSun[2]) / bearing,
    ]
    const ns = dot(n, toSun)
    const toEye: Vec3 = [
      2 * ns * n[0] - toSun[0],
      2 * ns * n[1] - toSun[1],
      2 * ns * n[2] - toSun[2],
    ]
    expect(Math.hypot(toEye[0], toEye[1], toEye[2])).toBeCloseTo(1, 12)
    // The eye is genuinely UNDER this patch of surface. Without this the
    // construction would be describing a viewpoint that cannot occur.
    expect(toEye[1]).toBeCloseTo(-0.17794, 5)
    expect(toEye[1]).toBeLessThan(0)

    const h = norm([toEye[0] + toSun[0], toEye[1] + toSun[1], toEye[2] + toSun[2]])
    expect(dot(n, h)).toBeCloseTo(1, 12)
    expect(specColor * dot(n, h) ** exponent).toBeCloseTo(0.5, 6)
  })
})

describe('the shader spells what the oracles pin', () => {
  it('refracts with the TypeScript index, interpolated rather than retyped', () => {
    expect(WATER_SURFACE_GLSL).toContain(`refract(viewDir, n, ${WATER_IOR})`)
    expect(WATER_SURFACE_GLSL).toContain(String(WATER_F0))
    // Schlick on the TRANSMITTED angle — `dot(t, -n)`, not `dot(viewDir, n)`.
    // The incident-angle form does not reach 1 at the critical angle and would
    // leave a hard rim where `waterTransmittance` promises a soft one.
    expect(WATER_SURFACE_GLSL).toContain('float cosT = clamp(dot(t, -n), 0.0, 1.0)')
    // GLSL's own `refract` rather than a hand-rolled Snell: the zero-vector
    // return IS total internal reflection, and re-deriving it is how a sign
    // gets lost.
    expect(WATER_SURFACE_GLSL).toContain('if (dot(t, t) < 1e-8) return vec3(0.0)')
    // UNITY space for the SH lookup, as everywhere else in this renderer.
    expect(WATER_SURFACE_GLSL).toContain('waterSkyRadiance(vec3(t.x, t.y, -t.z))')
  })

  it('asks the same question the TypeScript twin asks, in the same direction', () => {
    // `orientWaterNormal`'s tie-break is `eyeY < surfaceY`; so is this.
    expect(WATER_SURFACE_GLSL).toContain('return cameraPosition.y < surfaceWorld.y ? -1.0 : 1.0;')
    // And it asks it of `cameraPosition`, three's WORLD-space built-in, which
    // in an XR frame is the per-EYE sub-camera. CLAUDE.md trap 18 is a CPU
    // half and a shader half of one calculation disagreeing about where the
    // eye is; there is no CPU answer that could agree with this one, because
    // anything read off the rig is the midpoint between the two eyes.
    expect(WATER_SURFACE_GLSL).not.toContain('uniform')
  })

  it('wires all three shading decisions to it', () => {
    // Compiled through the real `onBeforeCompile` rather than read off the
    // source, so this is the string the driver would see. A stub shader is
    // enough: the patch is three string replaces on three include hooks.
    const material = new (class {
      side = 0
      needsUpdate = false
      // DEV-936: the sea frees its coast map on its material's dispose event.
      addEventListener(): void {}
      customProgramCacheKey?: () => string
      onBeforeCompile?: (shader: {
        uniforms: object
        vertexShader: string
        fragmentShader: string
      }) => void
    })()
    const ocean = TERRAIN.simonet.terrains.ocean
    const water = applyWaterWaves(
      material as unknown as Parameters<typeof applyWaterWaves>[0],
      ocean.displace,
      {
        specColor: ocean.material.specular.color,
        shininess: ocean.material.specular.shininess,
        sun: {
          direction: int01.lighting.sun.direction,
          colorLinear: int01.lighting.sun.colorLinear,
          intensity: int01.lighting.sun.intensity,
        },
        color: ocean.material.reflection.color,
        fresnel: ocean.material.reflection.fresnel,
        skySh: (int01.lighting.sky as { sh: number[][] }).sh,
        facetMetres: 32,
      },
    )
    expect(water).toBeTruthy()

    // The sea now has two sides. `terrain-mesh.ts` builds every terrain
    // material FrontSide, which culled the underside — but only where a facet
    // happened to face away, so from below it was a sheet with holes in it
    // rather than an absence. 2 is THREE.DoubleSide.
    expect(material.side).toBe(2)

    const shader = {
      uniforms: {},
      vertexShader: '#include <begin_vertex>',
      fragmentShader: '#include <normal_fragment_begin>\n#include <opaque_fragment>',
    }
    material.onBeforeCompile?.(shader)
    const frag = shader.fragmentShader

    // 0. DoubleSide is PAIRED with a per-fragment cull, and the pairing is the
    // load-bearing part: un-culling globally also un-culls the water above the
    // waterline, which drops back-facing facets into the sun's glint band and
    // speckles it white (36 % of a box beside the glint, against 0.6 %). A
    // material that is DoubleSide without this line is the bug.
    expect(frag).toContain('if ((waterEyeSide(vWaterWorld) > 0.0) != gl_FrontFacing) discard;')
    // and it comes BEFORE the shading, not after it.
    expect(frag.indexOf('discard;')).toBeLessThan(frag.indexOf('vec3 dPdx'))

    // 1. the normal turns over with the eye...
    expect(frag).toContain('vec3 up = vec3(0.0, waterEyeSide(vWaterWorld), 0.0);')
    // ...and the old rule is gone. This is the line DEV-050 flagged:
    // "the surface is a sea seen from above, so up wins".
    expect(frag).not.toContain('faceNormal.y < 0.0 ? -faceNormal : faceNormal')
    // 2. the specular only fires from above (see the glint test)...
    expect(frag).toContain('if (waterEyeSide(vWaterWorld) > 0.0) {')
    // 3. ...and the reflection becomes a window from below.
    expect(frag).toContain('if (waterEyeSide(vWaterWorld) < 0.0) {')
    expect(frag).toContain('outgoingLight += waterThroughSurface(viewDir, normal) * uReflect.rgb;')
    // The window is NOT scaled by _ReflectColor's alpha: that is 2016's
    // reflection strength (0.5) and there is no reflection on this side.
    expect(ocean.material.reflection.color[3]).toBe(0.5)
    expect(frag).not.toContain('waterThroughSurface(viewDir, normal) * uReflect.rgb * uReflect.a')
  })
})

// ── DEV-167 / W6: the sea's two sides are a VARIANT, not a constant ────────
//
// Everything above is true of the frame at the BREACH, and of no other frame
// in the game. `DoubleSide` turns off hardware back-face culling for a 262 km
// plate, and a `discard` in the fragment text stops the depth test rejecting a
// fragment before the water's stack — three lights of GGX, an SH sky radiance,
// a Blinn-Phong glint, two screen-space derivatives — has run on it.
//
// **Test the mechanism, not the millisecond** (VR-PERF §0). Node cannot run
// GLSL and cannot time a GPU, so what is asserted here is the three things
// that decide whether the driver ever sees a `discard`: which side the
// material is, which defines are set, and — the structural one — that every
// `discard` in the patch is inside an `#ifdef` that the defines can remove.

const variantMaterial = () => {
  const material = new (class {
    // -1 so a test that reads FrontSide (0) cannot be reading "never written".
    side = -1
    needsUpdate = false
    // DEV-936: the sea frees its coast map on its material's dispose event.
    addEventListener(): void {}
    defines?: Record<string, string>
    customProgramCacheKey?: () => string
    onBeforeCompile?: (shader: {
      uniforms: object
      vertexShader: string
      fragmentShader: string
    }) => void
  })()
  const ocean = TERRAIN.simonet.terrains.ocean
  const water = applyWaterWaves(
    material as unknown as Parameters<typeof applyWaterWaves>[0],
    ocean.displace,
    {
      specColor: ocean.material.specular.color,
      shininess: ocean.material.specular.shininess,
      sun: {
        direction: int01.lighting.sun.direction,
        colorLinear: int01.lighting.sun.colorLinear,
        intensity: int01.lighting.sun.intensity,
      },
      color: ocean.material.reflection.color,
      fresnel: ocean.material.reflection.fresnel,
      skySh: (int01.lighting.sky as { sh: number[][] }).sh,
      facetMetres: 32,
    },
  )
  return { material, water, amplitude: ocean.displace.amplitude }
}

/**
 * three's `Side` values, spelled out rather than imported: this file has no
 * three import and the block above already writes `2` for DoubleSide by hand.
 *
 * **FrontSide is 0**, which is also what an unwritten field would be — so every
 * FrontSide assertion below is paired with one about the defines, and the
 * double is built with a side nobody could mistake for the default.
 */
const FRONT_SIDE = 0
const DOUBLE_SIDE = 2

describe('the sea picks its side from where the eye is', () => {
  it('starts on what shipped, so a caller that never says is unchanged', () => {
    const { material } = variantMaterial()
    expect(material.side).toBe(DOUBLE_SIDE)
    expect(material.defines?.FF2_WATER_TWO_SIDED).toBe('')
  })

  it('goes single-sided with no discard once the eye clears the wave', () => {
    const { material, water, amplitude } = variantMaterial()
    water.setEyeHeight(100, 0)
    expect(material.side).toBe(FRONT_SIDE)
    expect(material.defines?.FF2_WATER_TWO_SIDED).toBeUndefined()
    // And the margin is the WAVE's, not a taste: an eye one amplitude up is
    // still inside the surface's reach and must stay two-sided.
    water.setEyeHeight(amplitude, 0)
    expect(material.side).toBe(DOUBLE_SIDE)
  })

  it('has a hysteresis band, because a flip is a program swap', () => {
    const { material, water, amplitude } = variantMaterial()
    const top = amplitude + 1
    // Coming UP: the band is crossed at `top`.
    water.setEyeHeight(-10, 0)
    expect(material.side).toBe(DOUBLE_SIDE)
    water.setEyeHeight(top + 3, 0)
    expect(material.side).toBe(DOUBLE_SIDE) // still inside the band
    water.setEyeHeight(top + 8, 0)
    expect(material.side).toBe(FRONT_SIDE)
    // Going DOWN again: it does NOT flip back at top + 3. A pilot skimming the
    // sea at the threshold would otherwise swap programs every frame.
    water.setEyeHeight(top + 3, 0)
    expect(material.side).toBe(FRONT_SIDE)
    water.setEyeHeight(top - 1, 0)
    expect(material.side).toBe(DOUBLE_SIDE)
  })

  it('follows a moving sea level, not a remembered one', () => {
    // `seaY` is the plate's world y THIS frame, bob included — the sea rises
    // and falls by up to an amplitude as a whole (`bobAt`).
    const { material, water, amplitude } = variantMaterial()
    water.setEyeHeight(50, 0)
    expect(material.side).toBe(FRONT_SIDE)
    water.setEyeHeight(50, 60)
    expect(material.side).toBe(DOUBLE_SIDE)
    expect(amplitude).toBeGreaterThan(0)
  })

  it('cuts the shaft bore on EITHER side, which is the whole of DEV-106', () => {
    // The two axes are independent and they have to be: the ride crosses the
    // surface at ~87 m of a 106 m shaft while the rim is at ~102, so for
    // fifteen metres the eye is above the water AND still inside the tube.
    // Folding the bore into the two-sided program puts the sea back across the
    // tube for exactly that stretch — the flooded lift DEV-106 exists to fix.
    const { material, water } = variantMaterial()
    water.setShaftBore(10, 20, 30, 116)
    water.setEyeHeight(1000, 0)
    expect(material.side).toBe(FRONT_SIDE)
    expect(material.defines?.FF2_WATER_SHAFT).toBe('')
    water.clearShaftBore()
    expect(material.defines?.FF2_WATER_SHAFT).toBeUndefined()
    expect(material.side).toBe(FRONT_SIDE)
  })

  it('puts every discard behind a define, which is what removes it', () => {
    // The structural one. An `#ifdef` is still in `shader.fragmentShader`
    // whichever variant is live — the GLSL preprocessor is what strips it — so
    // a text search for `discard` cannot tell the variants apart. What it CAN
    // say, and what actually decides whether the driver ever sees one, is that
    // no `discard` sits outside a gate the defines control.
    const { material } = variantMaterial()
    const shader = {
      uniforms: {},
      vertexShader: '#include <begin_vertex>',
      fragmentShader: '#include <normal_fragment_begin>\n#include <opaque_fragment>',
    }
    material.onBeforeCompile?.(shader)
    let open: string | null = null
    const ungated: string[] = []
    for (const line of shader.fragmentShader.split('\n')) {
      const ifdef = /#ifdef\s+(\w+)/.exec(line)
      if (ifdef) open = ifdef[1] as string
      else if (line.includes('#endif')) open = null
      else if (line.includes('discard') && !line.trimStart().startsWith('//')) {
        if (open !== 'FF2_WATER_TWO_SIDED' && open !== 'FF2_WATER_SHAFT') ungated.push(line.trim())
      }
    }
    expect(ungated).toEqual([])
    // ...and both gates are really there, so an empty list cannot mean the
    // discards were deleted instead of gated.
    expect(shader.fragmentShader).toContain('#ifdef FF2_WATER_TWO_SIDED')
    expect(shader.fragmentShader).toContain('#ifdef FF2_WATER_SHAFT')
  })
})

describe('both variants are compiled under the curtain', () => {
  it('warms all four and ends on the one it started on', () => {
    // A ride uses three of the four in twelve seconds, and every one of those
    // moments is inside the shot DEV-094 keeps. A warm that left the sea in a
    // different variant would also be a bug — the caller warms AFTER the world
    // is placed and the eye may already have chosen.
    //
    // `warmVariants` takes a `compile` CALLBACK rather than a renderer, and
    // that is the fix as much as the loop is: `warm-up.ts` supplies it with the
    // flight's render target bound and the launch room hidden, both of which
    // are in three's program cache key. The first version called
    // `renderer.compile` after the warm had returned and built four programs
    // nothing draws.
    const { material, water } = variantMaterial()
    water.setEyeHeight(500, 0)
    expect(material.side).toBe(FRONT_SIDE)
    const seen: string[] = []
    water.warmVariants(() => {
      seen.push(
        `${material.side === DOUBLE_SIDE ? 'two' : 'one'}` +
          `${material.defines?.FF2_WATER_SHAFT === '' ? '+bore' : ''}`,
      )
    })
    // Four distinct variants, and the restore makes five compiles.
    expect(new Set(seen).size).toBe(4)
    expect(seen).toHaveLength(5)
    expect(material.side).toBe(FRONT_SIDE)
    expect(material.defines?.FF2_WATER_SHAFT).toBeUndefined()
  })
})
