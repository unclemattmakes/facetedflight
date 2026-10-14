// tests/unit/shadows.test.ts — the mission sun's shadow map (DEV-086).
//
// Four things, in the order they would hurt if they broke.
//
//  1. **Classic is untouched.** `renderer.shadowMap.enabled` stays false, the
//     sun never gets `castShadow`, and not one object in a stand-in scene is
//     given a flag. The assertion is the COUNT of objects `applyShadowFlags`
//     moved, which is a stronger claim than "the flags are false" — it says
//     nothing was written at all, so a future Classic cannot arrive at false by
//     setting true and clearing it.
//
//  2. **The box really covers what it says it covers, at 4 degrees.** The whole
//     difficulty of this row is a sun 4 degrees above the horizon, and the
//     temptation is to assert the arithmetic back at itself. So the fit is
//     tested by SAMPLING: points on the sphere it claims to cover are projected
//     into the light's own view and asserted to be inside the six planes. That
//     is true independently of how the fit computes them, which is trap 24's
//     rule — assert the relationship, not the value.
//
//  3. **The snap is a LATTICE, not merely a rounding.** A follow box that
//     re-samples the world onto a different texel grid every frame makes every
//     shadow edge crawl. What proves it is fixed is not "the numbers changed
//     less" — it is that `left` is always an exact multiple of the texel size
//     however far the camera has moved, and that two camera positions inside one
//     texel produce the SAME box.
//
//  4. **Exactly the named classes take part.** A cloud, a ring or the cockpit
//     shell quietly acquiring `castShadow` is a frame-time bill nobody asked for
//     and, for the cockpit, shimmer you cannot look away from in a headset.
//
// No GL context: `createSunShadows` takes the two renderer properties it writes
// as a structural type, and a `DirectionalLight` is plain maths.

import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@/boot/settings'
import type { Edition } from '@/content/edition-schema'
import { applyVrOverrides, EditionSchemaError, validateEdition } from '@/content/edition-schema'
import { createEditionState } from '@/game/edition'
import {
  ALL_CASTERS,
  applyShadowFlags,
  casterSpan,
  createSunShadows,
  fitSunShadow,
  lightBasis,
  type ShadowCasters,
  type ShadowFlags,
  type ShadowRenderer,
  type ShadowRole,
  type ShadowSubject,
  shadowBiasFor,
  shadowCastersFor,
  shadowEdgeFadeUv,
  shadowFlagsFor,
  shadowsEnabled,
  type Vec3,
} from '@/render/shadows'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'
import { appSource } from './helpers/app-source'

const classic = classicJson as unknown as Edition
const anniversary = anniversaryJson as unknown as Edition

/**
 * `int_01_hoverJet`'s own sun, straight out of the level JSON: the direction the
 * light TRAVELS, three space, at an elevation of 4.00003 degrees. Every 4-degree
 * claim below is measured against this rather than against a round number.
 */
const INT01_SUN: Vec3 = [0.962253, -0.069757, 0.263062]

/** `boot/app.ts`'s placement: `-direction x 10000`, target at the origin. */
const lightAt = (direction: Vec3, distance = 10_000): { position: Vec3; target: Vec3 } => ({
  position: [-direction[0] * distance, -direction[1] * distance, -direction[2] * distance],
  target: [0, 0, 0],
})

/** A travel direction for a sun `deg` above the horizon, heading due -x. */
const sunAtElevation = (deg: number): Vec3 => {
  const r = (deg * Math.PI) / 180
  return [-Math.cos(r), -Math.sin(r), 0]
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** Where a world point lands in the light's own view: lateral x/y, depth. */
const inLightView = (
  p: Vec3,
  lightPosition: Vec3,
  lightTarget: Vec3,
): { x: number; y: number; depth: number } => {
  const basis = lightBasis(lightPosition, lightTarget)
  const rel: Vec3 = [p[0] - lightPosition[0], p[1] - lightPosition[1], p[2] - lightPosition[2]]
  return { x: dot(rel, basis.x), y: dot(rel, basis.y), depth: -dot(rel, basis.z) }
}

/** A deterministic spread of directions on the unit sphere. Not random. */
const sphereDirections = (count: number): Vec3[] => {
  const out: Vec3[] = []
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * (i + 0.5)) / count
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const theta = golden * i
    out.push([Math.cos(theta) * r, y, Math.sin(theta) * r])
  }
  return out
}

const flags = (): ShadowFlags => ({ castShadow: false, receiveShadow: false })

// ── 1. the fit ────────────────────────────────────────────────────────────

describe('the shadow box covers the sphere it claims to', () => {
  const boxHalfSize = 700
  const mapSize = 2048
  const castDistance = 3500

  // Every elevation the game could ask for, and the two that matter: 4.00003 is
  // `int_01`'s and 0.5 is the floor `MIN_SUN_SIN` stands for. A fit that is only
  // ever checked under one sun is the agreement lesson waiting to happen.
  for (const deg of [0.5, 4.00003, 15, 45, 89]) {
    it(`holds every point of the sphere with the sun ${deg} degrees up`, () => {
      const dir = sunAtElevation(deg)
      const { position, target } = lightAt(dir)
      // Deliberately NOT the origin: a centre at (0,0,0) is where an error in
      // the "relative to the light" arithmetic cancels itself out.
      const centre: Vec3 = [-1873.5, 412.25, 2107.75]
      const fit = fitSunShadow({
        centre,
        lightPosition: position,
        lightTarget: target,
        boxHalfSize,
        mapSize,
        castDistance,
      })

      // The snap moves the centre by up to half a texel on each lateral axis,
      // so the radius that is GUARANTEED covered is one texel inside the box.
      const radius = boxHalfSize - fit.texelSize
      for (const d of sphereDirections(200)) {
        const p: Vec3 = [
          centre[0] + d[0] * radius,
          centre[1] + d[1] * radius,
          centre[2] + d[2] * radius,
        ]
        const v = inLightView(p, position, target)
        expect(v.x, `x at ${deg} deg`).toBeGreaterThanOrEqual(fit.left)
        expect(v.x, `x at ${deg} deg`).toBeLessThanOrEqual(fit.right)
        expect(v.y, `y at ${deg} deg`).toBeGreaterThanOrEqual(fit.bottom)
        expect(v.y, `y at ${deg} deg`).toBeLessThanOrEqual(fit.top)
        expect(v.depth, `depth at ${deg} deg`).toBeGreaterThanOrEqual(fit.near)
        expect(v.depth, `depth at ${deg} deg`).toBeLessThanOrEqual(fit.far)
      }
    })
  }

  it('reaches castDistance further up-sun than the box, and no further down-sun', () => {
    const { position, target } = lightAt(INT01_SUN)
    const centre: Vec3 = [-1873.5, 412.25, 2107.75]
    const fit = fitSunShadow({
      centre,
      lightPosition: position,
      lightTarget: target,
      boxHalfSize,
      mapSize,
      castDistance,
    })
    const at = inLightView(fit.centre, position, target)
    // Up-sun is TOWARD the light, i.e. a smaller depth. The near plane sits a
    // whole `castDistance` beyond the near face of the box; the far plane sits
    // on the box's far face and not a metre past it, because a caster down-sun
    // of the box cannot shadow anything in it.
    expect(at.depth - fit.near).toBeCloseTo(boxHalfSize + castDistance, 6)
    expect(fit.far - at.depth).toBeCloseTo(boxHalfSize, 6)
    // ...and the depth RANGE — which is what `shadowBiasFor` divides by —
    // depends on the two preset numbers and on nothing about where the box is.
    expect(fit.far - fit.near).toBeCloseTo(2 * boxHalfSize + castDistance, 6)
  })

  it('is one texel per (2 x boxHalfSize / mapSize), which is what the edges cost', () => {
    const { position, target } = lightAt(INT01_SUN)
    for (const [half, size] of [
      [700, 2048],
      [384, 1024],
      [900, 4096],
    ] as const) {
      const fit = fitSunShadow({
        centre: [100, 200, 300],
        lightPosition: position,
        lightTarget: target,
        boxHalfSize: half,
        mapSize: size,
        castDistance: 0,
      })
      expect(fit.texelSize).toBeCloseTo((2 * half) / size, 12)
      // And the box really is `2 x boxHalfSize` wide, which is the other half of
      // what makes that number the texel size.
      expect(fit.right - fit.left).toBeCloseTo(2 * half, 9)
      expect(fit.top - fit.bottom).toBeCloseTo(2 * half, 9)
    }
  })
})

// ── DEV-453: the fade band, in the uv three's own shadow matrix produces ───
//
// The shader measures a fragment's shadow coordinate against the box's faces
// and divides by `uSunTopE`. So the claim worth testing is not what
// `shadowEdgeFadeUv` computes — that would be its own arithmetic written twice
// (trap 24) — but that a point `edgeFade` metres inside a face, pushed through
// the matrix THREE builds from the fit, lands exactly one band from that face.

describe('the edge fade band (DEV-453)', () => {
  const shadowCoordOf = (sun: Vec3, centre: Vec3, offsetLight: Vec3) => {
    const { position, target } = lightAt(sun)
    const s = anniversary.render.shadows
    const fit = fitSunShadow({
      centre,
      lightPosition: position,
      lightTarget: target,
      boxHalfSize: s.boxHalfSize,
      mapSize: s.mapSize,
      castDistance: s.castDistance,
    })
    const light = new THREE.DirectionalLight()
    light.position.fromArray(position)
    light.target.position.fromArray(target)
    light.updateMatrixWorld(true)
    light.target.updateMatrixWorld(true)
    const cam = light.shadow.camera
    cam.left = fit.left
    cam.right = fit.right
    cam.bottom = fit.bottom
    cam.top = fit.top
    cam.near = fit.near
    cam.far = fit.far
    cam.updateProjectionMatrix()
    light.shadow.updateMatrices(light)
    // A point given in the light's own basis about the fit's snapped centre.
    const { x, y, z } = lightBasis(position, target)
    const p = new THREE.Vector3(
      fit.centre[0] + offsetLight[0] * x[0] + offsetLight[1] * y[0] + offsetLight[2] * z[0],
      fit.centre[1] + offsetLight[0] * x[1] + offsetLight[1] * y[1] + offsetLight[2] * z[1],
      fit.centre[2] + offsetLight[0] * x[2] + offsetLight[1] * y[2] + offsetLight[2] * z[2],
    )
    return p.applyMatrix4(light.shadow.matrix)
  }

  it('is edgeFade metres from each face, in the shadow matrix three builds from the fit', () => {
    const s = anniversary.render.shadows
    const band = shadowEdgeFadeUv(s)
    const inside = s.boxHalfSize - s.edgeFade
    for (const sun of [INT01_SUN, sunAtElevation(46.5), sunAtElevation(80)]) {
      const centre: Vec3 = [-1873.5, 412.25, 2107.75]
      // Across the sun, both lateral axes, both sides.
      for (const [axis, sign] of [
        [0, 1],
        [0, -1],
        [1, 1],
        [1, -1],
      ] as const) {
        const off: [number, number, number] = [0, 0, 0]
        off[axis] = sign * inside
        const c = shadowCoordOf(sun, centre, off)
        const uv = axis === 0 ? c.x : c.y
        const toFace = sign > 0 ? 1 - uv : uv
        // Within a texel: the fit snaps its centre to the lattice.
        expect(toFace, `axis ${axis} sign ${sign}`).toBeCloseTo(band.lateral, 3)
      }
      // Down-sun: the FAR plane. The basis' z points TOWARD the light, so
      // down-sun is -z, and the box's far face is boxHalfSize down-sun of it.
      const far = shadowCoordOf(sun, centre, [0, 0, -inside])
      expect(1 - far.z).toBeCloseTo(band.depth, 9)
      // And the face itself is exactly the edge: the fade's zero.
      const face = shadowCoordOf(sun, centre, [0, 0, -s.boxHalfSize])
      expect(1 - face.z).toBeCloseTo(0, 9)
    }
  })

  it('is zero at a zero band, which is the hard edge the shader then draws', () => {
    expect(shadowEdgeFadeUv({ boxHalfSize: 700, castDistance: 3500, edgeFade: 0 })).toEqual({
      lateral: 0,
      depth: 0,
    })
  })
})

describe('the texel snap is a lattice', () => {
  const boxHalfSize = 700
  const mapSize = 2048
  const { position, target } = lightAt(INT01_SUN)
  const fitAt = (centre: Vec3) =>
    fitSunShadow({
      centre,
      lightPosition: position,
      lightTarget: target,
      boxHalfSize,
      mapSize,
      castDistance: 3500,
    })

  it('puts left and bottom on whole texels however far the camera has flown', () => {
    // The invariant a swimming shadow breaks, stated as a relationship rather
    // than as the arithmetic that produced it (trap 24). 400 steps of 0.37 m is
    // a ship crossing 148 m — enough to cross 216 texels.
    const texel = fitAt([0, 0, 0]).texelSize
    for (let i = 0; i < 400; i++) {
      const fit = fitAt([-1873.5 + i * 0.31, 412.25 + i * 0.17, 2107.75 - i * 0.09])
      expect(Math.abs(fit.left / texel - Math.round(fit.left / texel))).toBeLessThan(1e-6)
      expect(Math.abs(fit.bottom / texel - Math.round(fit.bottom / texel))).toBeLessThan(1e-6)
    }
  })

  it('gives two camera positions inside one texel the SAME box', () => {
    // A ship holding station must not move the grid at all — which is also why
    // `refit` can compare the six planes and skip `updateProjectionMatrix`.
    const a = fitAt([-1873.5, 412.25, 2107.75])
    const nudge = a.texelSize / 100
    const b = fitAt([-1873.5 + nudge, 412.25, 2107.75 + nudge])
    expect(b.left).toBe(a.left)
    expect(b.right).toBe(a.right)
    expect(b.bottom).toBe(a.bottom)
    expect(b.top).toBe(a.top)
  })

  it('moves the box in whole texels, never a fraction of one', () => {
    const texel = fitAt([0, 0, 0]).texelSize
    let previous = fitAt([-2000, 400, 2000])
    for (let i = 1; i <= 200; i++) {
      const fit = fitAt([-2000 + i * 1.37, 400, 2000])
      const steps = (fit.left - previous.left) / texel
      expect(Math.abs(steps - Math.round(steps)), `step ${i}`).toBeLessThan(1e-6)
      previous = fit
    }
  })

  it('leaves the DEPTH unsnapped — it samples no grid', () => {
    // Snapping depth would move the near plane for nothing, and at 4 degrees the
    // near plane is the expensive one. Sub-texel motion along the sun must show
    // up in `near`/`far` unchanged laterally.
    const a = fitAt([-1873.5, 412.25, 2107.75])
    const alongSun: Vec3 = [
      -1873.5 + INT01_SUN[0] * 0.01,
      412.25 + INT01_SUN[1] * 0.01,
      2107.75 + INT01_SUN[2] * 0.01,
    ]
    const b = fitAt(alongSun)
    expect(b.near).not.toBe(a.near)
    expect(b.far - b.near).toBeCloseTo(a.far - a.near, 9)
  })
})

describe('the light basis is three own', () => {
  it('agrees with Matrix4.lookAt for the mission sun', () => {
    // The whole value of the snap depends on quantising against the axes the map
    // is actually sampled on. So this compares against three, not against a
    // second copy of the same formula.
    const { position, target } = lightAt(INT01_SUN)
    const basis = lightBasis(position, target)
    const m = new THREE.Matrix4().lookAt(
      new THREE.Vector3(...position),
      new THREE.Vector3(...target),
      new THREE.Vector3(0, 1, 0),
    )
    const e = m.elements
    for (const [i, v] of [basis.x, basis.y, basis.z].entries()) {
      expect(v[0]).toBeCloseTo(e[i * 4 + 0] as number, 9)
      expect(v[1]).toBeCloseTo(e[i * 4 + 1] as number, 9)
      expect(v[2]).toBeCloseTo(e[i * 4 + 2] as number, 9)
    }
  })

  it('survives a sun directly overhead, where cross(up, z) is zero', () => {
    const basis = lightBasis([0, 10_000, 0], [0, 0, 0])
    for (const v of [basis.x, basis.y, basis.z]) {
      expect(Math.hypot(v[0], v[1], v[2])).toBeCloseTo(1, 6)
    }
  })
})

describe('casterSpan says what a 4-degree sun really asks for', () => {
  it('closes the shadow triangle: span x sin(elevation) is the height', () => {
    // The relationship, not the formula. A span that did not satisfy this would
    // not be a distance along the ray at all.
    for (const deg of [4.00003, 10, 30, 60]) {
      const dir = sunAtElevation(deg)
      const span = casterSpan(1536, dir)
      expect(span * Math.sin((deg * Math.PI) / 180)).toBeCloseTo(1536, 6)
    }
  })

  it('is 22 km for Simonet under int_01 sun, which is why castDistance exists', () => {
    // Simonet's `terrainHeight` is 1,536 m (the generated sheet). This is the
    // number the preset's `castDistance` is a deliberate retreat from, and it is
    // asserted so that a reader of the DEV row can check the claim.
    expect(casterSpan(1536, INT01_SUN) / 1000).toBeCloseTo(22.0, 1)
  })

  it('stays finite for a sun on the horizon', () => {
    expect(Number.isFinite(casterSpan(1536, [1, 0, 0]))).toBe(true)
  })
})

describe('the bias is in metres and three is not', () => {
  const fit = fitSunShadow({
    centre: [0, 300, 0],
    ...(() => {
      const l = lightAt(INT01_SUN)
      return { lightPosition: l.position, lightTarget: l.target }
    })(),
    boxHalfSize: 700,
    mapSize: 2048,
    castDistance: 3500,
  })

  it('converts so that bias x depth range is the metres asked for', () => {
    for (const metres of [0, 0.25, 0.5, 2, 11]) {
      expect(shadowBiasFor(metres, fit) * (fit.far - fit.near)).toBeCloseTo(-metres, 9)
    }
  })

  it('is negative, because the depth compare is LEQUAL', () => {
    expect(shadowBiasFor(0.5, fit)).toBeLessThan(0)
    // And a sign slip in the preset cannot invert it: a bias that pushed the
    // receiver AWAY from the light shadows every lit surface with itself.
    expect(shadowBiasFor(-0.5, fit)).toBe(shadowBiasFor(0.5, fit))
  })
})

// ── 2. who takes part ─────────────────────────────────────────────────────

const ALL_ROLES: readonly ShadowRole[] = [
  'terrain-chunk',
  'ocean-chunk',
  'prop-scatter',
  'prop-landmark',
  'ship-exterior',
  'ship-cockpit',
  'racer-hull',
  'cloud',
  'ring',
  'effect',
]

describe('Classic gives nothing a flag', () => {
  it('is {false, false} for every role at every LOD', () => {
    for (const role of ALL_ROLES) {
      for (const lod of [0, 1, 2, 3]) {
        expect(shadowFlagsFor(role, false, lod), `${role} @ LOD ${lod}`).toEqual({
          cast: false,
          receive: false,
        })
      }
    }
  })

  it('writes NOTHING at all to a scene that has never had shadows', () => {
    const subjects: ShadowSubject[] = ALL_ROLES.map((role) => ({ role, target: flags() }))
    // Zero, not "all false": a Classic that arrived at false by setting true and
    // clearing it would recompile every lit material on the way past.
    expect(applyShadowFlags(subjects, false)).toBe(0)
    for (const s of subjects) {
      expect(s.target.castShadow).toBe(false)
      expect(s.target.receiveShadow).toBe(false)
    }
  })
})

describe('Anniversary flags exactly the classes the row names', () => {
  it('casts from LOD 0 land and from nothing coarser — FacetedTerrain.cs:721', () => {
    expect(shadowFlagsFor('terrain-chunk', true, 0)).toEqual({ cast: true, receive: true })
    // And from the detail ring, which is FINER than LOD 0 (DEV-085's LOD -1).
    // `=== 0` left the ten chunks nearest the ship as receivers only — DEV-115.
    expect(shadowFlagsFor('terrain-chunk', true, -1)).toEqual({ cast: true, receive: true })
    for (const lod of [1, 2, 3]) {
      expect(shadowFlagsFor('terrain-chunk', true, lod), `LOD ${lod}`).toEqual({
        cast: false,
        receive: true,
      })
    }
  })

  it('casts and receives on props, casts only on the ship exterior', () => {
    // With 2016's caster set, which is `shadowFlagsFor`'s default — a caller
    // that has not heard of DEV-224 gets the faithful answer.
    expect(shadowFlagsFor('prop-scatter', true)).toEqual({ cast: true, receive: true })
    expect(shadowFlagsFor('prop-landmark', true)).toEqual({ cast: true, receive: true })
    expect(shadowFlagsFor('ship-exterior', true)).toEqual({ cast: true, receive: false })
  })

  it('leaves the ocean, the clouds, the rings, the cockpit and the effects alone', () => {
    for (const role of ['ocean-chunk', 'cloud', 'ring', 'ship-cockpit', 'effect'] as const) {
      for (const lod of [0, 1]) {
        expect(shadowFlagsFor(role, true, lod), `${role} @ LOD ${lod}`).toEqual({
          cast: false,
          receive: false,
        })
      }
    }
  })

  it('applies that table to a mixed scene and touches nothing else', () => {
    const lod0 = flags()
    const lod1 = flags()
    const prop = flags()
    const rock = flags()
    const hull = flags()
    const cloud = flags()
    const ring = flags()
    const subjects: ShadowSubject[] = [
      { role: 'terrain-chunk', target: lod0, lod: 0 },
      { role: 'terrain-chunk', target: lod1, lod: 1 },
      { role: 'prop-scatter', target: prop },
      { role: 'prop-landmark', target: rock },
      { role: 'ship-exterior', target: hull },
      { role: 'cloud', target: cloud },
      { role: 'ring', target: ring },
    ]
    applyShadowFlags(subjects, true)
    expect(lod0).toEqual({ castShadow: true, receiveShadow: true })
    expect(lod1).toEqual({ castShadow: false, receiveShadow: true })
    expect(prop).toEqual({ castShadow: true, receiveShadow: true })
    expect(rock).toEqual({ castShadow: true, receiveShadow: true })
    expect(hull).toEqual({ castShadow: true, receiveShadow: false })
    expect(cloud).toEqual({ castShadow: false, receiveShadow: false })
    expect(ring).toEqual({ castShadow: false, receiveShadow: false })
    // ...and going back to Classic clears every one of them again.
    applyShadowFlags(subjects, false)
    for (const s of subjects) {
      expect(s.target.castShadow).toBe(false)
      expect(s.target.receiveShadow).toBe(false)
    }
  })
})

describe('the quality preset has the last word', () => {
  it('refuses at low, whatever the preset says', () => {
    expect(shadowsEnabled(anniversary, { ...DEFAULT_SETTINGS, quality: 'low' })).toBe(false)
  })

  it('runs at medium and high on Anniversary', () => {
    expect(shadowsEnabled(anniversary, { ...DEFAULT_SETTINGS, quality: 'medium' })).toBe(true)
    expect(shadowsEnabled(anniversary, { ...DEFAULT_SETTINGS, quality: 'high' })).toBe(true)
  })

  it('never runs on Classic, at any quality', () => {
    for (const quality of ['low', 'medium', 'high'] as const) {
      expect(shadowsEnabled(classic, { ...DEFAULT_SETTINGS, quality })).toBe(false)
    }
  })
})

// ── 3. the live system ────────────────────────────────────────────────────

const stubRenderer = (): ShadowRenderer => ({
  shadowMap: { enabled: false, type: THREE.BasicShadowMap },
})

const stubSun = (): THREE.DirectionalLight => {
  const light = new THREE.DirectionalLight(0xffffff, 1)
  light.position.set(-INT01_SUN[0] * 10_000, -INT01_SUN[1] * 10_000, -INT01_SUN[2] * 10_000)
  light.target.position.set(0, 0, 0)
  return light
}

const stubTerrain = () => {
  const calls: boolean[] = []
  return { calls, setShadows: (on: boolean) => calls.push(on) }
}

describe('createSunShadows on Classic', () => {
  it('leaves the renderer, the sun and every object exactly as it found them', () => {
    const renderer = stubRenderer()
    const sun = stubSun()
    const terrain = stubTerrain()
    const prop = flags()
    const rock = flags()
    const hull = flags()
    const state = createEditionState(classic, DEFAULT_SETTINGS)
    const shadows = createSunShadows(renderer, sun, state)
    shadows.attach({
      terrains: [terrain],
      scatter: [prop],
      landmarks: [rock],
      shipExterior: [hull],
    })
    shadows.update(new THREE.PerspectiveCamera())

    expect(renderer.shadowMap.enabled).toBe(false)
    // Untouched, not "set to the right thing": Classic must not even choose a
    // shadow map type, because choosing one is a decision about a map it does
    // not have.
    expect(renderer.shadowMap.type).toBe(THREE.BasicShadowMap)
    expect(sun.castShadow).toBe(false)
    expect(sun.shadow.map).toBe(null)
    expect(prop).toEqual({ castShadow: false, receiveShadow: false })
    expect(rock).toEqual({ castShadow: false, receiveShadow: false })
    expect(hull).toEqual({ castShadow: false, receiveShadow: false })
    expect(terrain.calls.every((c) => c === false)).toBe(true)
    expect(shadows.on).toBe(false)
    expect(shadows.fit).toBe(null)
    shadows.dispose()
  })

  it('is inert with no sun at all, on either preset', () => {
    const renderer = stubRenderer()
    const state = createEditionState(anniversary, DEFAULT_SETTINGS)
    const shadows = createSunShadows(renderer, null, state)
    shadows.attach({ scatter: [flags()], landmarks: [flags()] })
    expect(renderer.shadowMap.enabled).toBe(false)
    expect(shadows.on).toBe(false)
    shadows.dispose()
  })
})

describe('createSunShadows on Anniversary', () => {
  it('turns the map on and fits the box to the camera WORLD position', () => {
    const renderer = stubRenderer()
    const sun = stubSun()
    const terrain = stubTerrain()
    const prop = flags()
    const rock = flags()
    const hull = flags()
    const state = createEditionState(anniversary, DEFAULT_SETTINGS)
    const shadows = createSunShadows(renderer, sun, state)
    shadows.attach({
      terrains: [terrain],
      scatter: [prop],
      landmarks: [rock],
      shipExterior: [hull],
    })

    // A camera inside a rig, which is the cockpit — `camera.position` is the
    // head pose inside it and is the origin until you lean (trap 18). A fit
    // built on the local position would sit at sea level at the world origin
    // while the rig flew the mission.
    const rig = new THREE.Group()
    rig.position.set(-1873.5, 412.25, 2107.75)
    const camera = new THREE.PerspectiveCamera()
    rig.add(camera)
    rig.updateMatrixWorld(true)
    shadows.update(camera)

    expect(renderer.shadowMap.enabled).toBe(true)
    expect(renderer.shadowMap.type).toBe(THREE.PCFShadowMap)
    expect(sun.castShadow).toBe(true)
    // The SHIPPED Anniversary caster set, which since DEV-304 means FLAT:
    // the scatter casts and receives, and the landmarks and the hull are
    // untouched by that row either way. The VR resolution of the same preset
    // is one line below; `canopy-direct.test.ts` owns the pairing with
    // DEV-295's bake.
    expect(prop).toEqual({ castShadow: true, receiveShadow: true })
    // And `vr.disable` takes exactly the scatter back out. Asserted on the
    // SAME objects through the same seam a headset uses, rather than on
    // `shadowFlagsFor` in isolation — `setImmersive` is what `boot/app.ts`
    // calls on `sessionstart` and it is the path that has to write flags.
    // DEV-932: and since then the headset takes the MISSION's map out whole
    // (`render.missionShadows`), so in VR nothing in a mission casts or
    // receives, while the machinery stays on for the hangar's key light.
    state.setImmersive(true)
    expect(prop).toEqual({ castShadow: false, receiveShadow: false })
    expect(rock).toEqual({ castShadow: false, receiveShadow: false })
    expect(sun.castShadow, 'no mission sun map in a headset').toBe(false)
    expect(renderer.shadowMap.enabled, 'the machinery stays, for the hangar').toBe(true)
    state.setImmersive(false)
    expect(prop).toEqual({ castShadow: true, receiveShadow: true })
    expect(rock).toEqual({ castShadow: true, receiveShadow: true })
    expect(hull).toEqual({ castShadow: true, receiveShadow: false })
    expect(terrain.calls.at(-1)).toBe(true)

    const fit = shadows.fit
    expect(fit).not.toBe(null)
    if (!fit) return
    // The box centre is the RIG's world position, to within the snap.
    const drift = Math.hypot(
      fit.centre[0] - rig.position.x,
      fit.centre[1] - rig.position.y,
      fit.centre[2] - rig.position.z,
    )
    expect(drift).toBeLessThanOrEqual(fit.texelSize)
    expect(sun.shadow.mapSize.width).toBe(anniversary.render.shadows.mapSize)
    expect(sun.shadow.camera.right - sun.shadow.camera.left).toBeCloseTo(
      2 * anniversary.render.shadows.boxHalfSize,
      6,
    )
    expect(sun.shadow.normalBias).toBe(anniversary.render.shadows.normalBias)
    expect(sun.shadow.radius).toBe(anniversary.render.shadows.radius)
    expect(sun.shadow.bias * (fit.far - fit.near)).toBeCloseTo(-anniversary.render.shadows.bias, 9)
    shadows.dispose()
  })

  it('does NOT move the light, because boot/app.ts rewrites its position', () => {
    // Two owners of one transform, resolved by whichever ran later in the loop,
    // is the bug this design exists to make impossible. The frame loop swaps the
    // sun between the title screen and the mission every frame; if this file
    // also wrote the position, which sun you got would depend on statement
    // order in `frame`.
    const sun = stubSun()
    const before = sun.position.clone()
    const beforeTarget = sun.target.position.clone()
    const state = createEditionState(anniversary, DEFAULT_SETTINGS)
    const shadows = createSunShadows(stubRenderer(), sun, state)
    const camera = new THREE.PerspectiveCamera()
    camera.position.set(-1873.5, 412.25, 2107.75)
    camera.updateMatrixWorld(true)
    shadows.update(camera)
    expect(sun.position.equals(before)).toBe(true)
    expect(sun.target.position.equals(beforeTarget)).toBe(true)
    shadows.dispose()
  })

  it('clears everything again on a flip back to Classic', () => {
    const renderer = stubRenderer()
    const sun = stubSun()
    const terrain = stubTerrain()
    const prop = flags()
    const rock = flags()
    const hull = flags()
    const state = createEditionState(anniversary, DEFAULT_SETTINGS)
    const shadows = createSunShadows(renderer, sun, state)
    shadows.attach({
      terrains: [terrain],
      scatter: [prop],
      landmarks: [rock],
      shipExterior: [hull],
    })
    expect(rock.castShadow).toBe(true)
    // DEV-224: the scatter is a RECEIVER on Anniversary whatever the caster
    // row says, so a flip back has to clear that too — the bug this asserts
    // is a preset flip that leaves the scatter receiving into a map that no
    // longer exists. `receiveShadow` is the half that makes this test's point;
    // `castShadow` is DEV-304's row and is true in flat.
    expect(prop).toEqual({ castShadow: true, receiveShadow: true })

    state.setLook(classic)
    expect(renderer.shadowMap.enabled).toBe(false)
    expect(sun.castShadow).toBe(false)
    expect(prop).toEqual({ castShadow: false, receiveShadow: false })
    expect(rock).toEqual({ castShadow: false, receiveShadow: false })
    expect(hull).toEqual({ castShadow: false, receiveShadow: false })
    expect(terrain.calls.at(-1)).toBe(false)
    expect(shadows.fit).toBe(null)
    shadows.dispose()
  })

  it('follows the quality slider without a preset change', () => {
    const renderer = stubRenderer()
    const sun = stubSun()
    const state = createEditionState(anniversary, DEFAULT_SETTINGS)
    const shadows = createSunShadows(renderer, sun, state)
    expect(shadows.on).toBe(true)
    state.setSettings({ ...DEFAULT_SETTINGS, quality: 'low' })
    expect(shadows.on).toBe(false)
    expect(renderer.shadowMap.enabled).toBe(false)
    expect(sun.castShadow).toBe(false)
    shadows.dispose()
  })
})

// ── 3b. DEV-224: the scatter leaves the caster set, and nothing else does ──

/** The same preset with `props.scatterShadows` moved, and nothing else moved. */
const withScatterShadows = (e: Edition, enabled: boolean): Edition =>
  ({
    ...e,
    props: { ...e.props, scatterShadows: { ...e.props.scatterShadows, enabled } },
  }) as Edition

describe('the scatter is the one caster class a preset can argue with (DEV-224)', () => {
  it('ships ON in flat and OFF in VR on Anniversary, and is inert on Classic', () => {
    // The shipped values, read off the JSON rather than restated: this is the
    // assertion that fails if somebody flips the row back without a
    // `DEVIATIONS.md` entry, and it is the one that says which way it ships.
    //
    // DEV-304 moved the flat half from false to true (wishlist #33), and put
    // the path in `vr.disable` so the 2.70 ms DEV-224 measured is still not
    // spent in a headset. `tests/unit/canopy-direct.test.ts` owns the half
    // this one cannot see: the caster set and DEV-295's bake must not darken
    // the same ground twice.
    expect(anniversary.props.scatterShadows.enabled).toBe(true)
    expect(applyVrOverrides(anniversary).props.scatterShadows.enabled).toBe(false)
    expect(classic.props.scatterShadows.enabled).toBe(false)
  })

  it('subtracts the scatter from the table and leaves every other role alone', () => {
    // DEV-350 added `racers`; only the scatter moves here.
    const off: ShadowCasters = { ...ALL_CASTERS, scatter: false }
    expect(shadowFlagsFor('prop-scatter', true, 0, off)).toEqual({ cast: false, receive: true })
    // Everything else answers the same with the caster set on or off. Asserted
    // as an EQUALITY between the two answers rather than against a transcribed
    // pair, so it stays true when a row that is not the scatter's moves.
    for (const role of ALL_ROLES) {
      if (role === 'prop-scatter') continue
      for (const lod of [-1, 0, 1, 2]) {
        expect(shadowFlagsFor(role, true, lod, off), `${role} @ LOD ${lod}`).toEqual(
          shadowFlagsFor(role, true, lod, ALL_CASTERS),
        )
      }
    }
  })

  it('composes the quality tier, so low cannot report a caster in a map it has not got', () => {
    const on = withScatterShadows(anniversary, true)
    expect(shadowCastersFor(on, DEFAULT_SETTINGS).scatter).toBe(true)
    expect(shadowCastersFor(on, { ...DEFAULT_SETTINGS, quality: 'low' }).scatter).toBe(false)
    // And the preset's own row is respected at a tier that HAS a map — both
    // ways round, on a preset built to say so rather than on whichever way the
    // shipped JSON happens to be pointing today. DEV-304 flipped that JSON and
    // turned the version of this line that read the shipped preset red, which
    // is the right outcome for an assertion about the PRESET and the wrong one
    // for an assertion about the COMPOSITION.
    expect(shadowCastersFor(withScatterShadows(anniversary, false), DEFAULT_SETTINGS).scatter).toBe(
      false,
    )
    expect(shadowCastersFor(classic, DEFAULT_SETTINGS).scatter).toBe(false)
  })

  it('reaches the MESHES: the flag flips castShadow on the scatter and on nothing else', () => {
    const renderer = stubRenderer()
    const sun = stubSun()
    const terrain = stubTerrain()
    const scatter = [flags(), flags(), flags()]
    const rock = flags()
    const hull = flags()
    const state = createEditionState(withScatterShadows(anniversary, true), DEFAULT_SETTINGS)
    const shadows = createSunShadows(renderer, sun, state)
    shadows.attach({ terrains: [terrain], scatter, landmarks: [rock], shipExterior: [hull] })

    // Arm A — 2016's caster set. Every scatter mesh casts.
    for (const f of scatter) expect(f).toEqual({ castShadow: true, receiveShadow: true })
    const terrainCallsBefore = terrain.calls.length

    // Arm B — the shipped Anniversary row, through the SAME route the Edition
    // page and `VRTO3D_FLAGS_OFF` take: `editionState.set`.
    state.setLook(withScatterShadows(anniversary, false))

    for (const f of scatter) expect(f).toEqual({ castShadow: false, receiveShadow: true })
    // "and on nothing else": the map is still on, the sun still casts, the
    // landmark and the hull did not move, and the terrain was not re-flagged
    // into a different answer.
    expect(shadows.on).toBe(true)
    expect(renderer.shadowMap.enabled).toBe(true)
    expect(sun.castShadow).toBe(true)
    expect(rock).toEqual({ castShadow: true, receiveShadow: true })
    expect(hull).toEqual({ castShadow: true, receiveShadow: false })
    expect(terrain.calls.slice(terrainCallsBefore).every((c) => c === true)).toBe(true)

    // And back, because a switch that only goes one way is a deletion.
    state.setLook(withScatterShadows(anniversary, true))
    for (const f of scatter) expect(f).toEqual({ castShadow: true, receiveShadow: true })
    shadows.dispose()
  })

  it('follows the quality slider too, with no preset change at all', () => {
    const sun = stubSun()
    const scatter = [flags()]
    const state = createEditionState(withScatterShadows(anniversary, true), DEFAULT_SETTINGS)
    const shadows = createSunShadows(stubRenderer(), sun, state)
    shadows.attach({ scatter, landmarks: [] })
    expect(scatter[0]?.castShadow).toBe(true)
    state.setSettings({ ...DEFAULT_SETTINGS, quality: 'low' })
    expect(scatter[0]).toEqual({ castShadow: false, receiveShadow: false })
    shadows.dispose()
  })
})

// ── 3c. the split the shadow map depends on, guarded at the source ─────

describe('boot/app.ts hands the scatter and the landmarks over SEPARATELY', () => {
  // `createSunShadows` can only subtract the scatter if the scatter arrives as
  // its own list. One walk of `liveProps.group.children` would flatten the two
  // classes together again and DEV-224 would silently stop every landmark
  // casting as well — which is sixteen 131–600 m rocks on desert, the only
  // shadows in that environment big enough to read as a scale cue.
  //
  // Reaching that path for real needs two megapixel PNGs, a Worker, the GLBs
  // and a GL context, so this guards the source the way §5 does below.
  // The whole boot tree (APP-SPLIT phase 0): EVERY call site, wherever it lives.
  const app = appSource()
  const loader = fs.readFileSync(path.join(process.cwd(), 'src/game/props/load-props.ts'), 'utf8')

  // EVERY call site, since DEV-359 gave the title screen one of its own: the
  // first draft of this read `indexOf`, which is whichever world happens to be
  // written first in the file.
  const attaches = [...app.matchAll(/sunShadows\.attach\(\{/g)].map((m) =>
    app.slice(m.index ?? 0, (m.index ?? 0) + 400),
  )

  it('attaches scatterMeshes and landmarkMeshes, not a flattened walk of the group', () => {
    expect(attaches.length, 'boot/app.ts no longer attaches a world — re-read this test').toBe(2)
    for (const call of attaches) {
      expect(call).toMatch(/scatter: \w+\?\.scatterMeshes/)
      expect(call).toMatch(/landmarks: \w+\?\.landmarkMeshes/)
      expect(call, 'the two prop classes are flattened into one list again').not.toContain(
        'group.children.flatMap',
      )
    }
  })

  it('the mission and the TITLE each hand their own forest to the map (DEV-359)', () => {
    // The title's map ran with nothing in it until DEV-359, because the only
    // attach was the mission's. The spec that watches the depth pass is
    // `tests/e2e/title-shadows.spec.ts`; this is the cheap half that runs in CI.
    expect(attaches.some((c) => c.includes('scatter: liveProps?.scatterMeshes'))).toBe(true)
    expect(attaches.some((c) => c.includes('scatter: titleProps?.scatterMeshes'))).toBe(true)
    const title = attaches.find((c) => c.includes('titleProps')) ?? ''
    expect(title, "the title's jets, as racers").toMatch(/racers: titleJetLooks/)
    expect(title, "the title's valley").toContain('terrains: [titleValley]')
  })

  it('collects both lists as the meshes are BUILT, so no consumer matches a group name', () => {
    expect(loader).toContain('readonly scatterMeshes: readonly THREE.InstancedMesh[]')
    expect(loader).toContain('readonly landmarkMeshes: readonly THREE.InstancedMesh[]')
    expect(loader).toContain('meshes.push(inst)')
    // The names are still written here and only here; a consumer re-deriving
    // the split from them would be a second copy of the decision.
    expect(app, 'app.ts is matching a props group by name').not.toContain("'props:landmarks'")
  })
})

// ── 4. the preset, and the two holes that do not announce themselves ──────

describe('the preset is validated', () => {
  const withShadows = (patch: Record<string, unknown>): Edition =>
    ({
      ...anniversary,
      render: { ...anniversary.render, shadows: { ...anniversary.render.shadows, ...patch } },
    }) as Edition

  it('accepts both shipped presets', () => {
    expect(() => validateEdition(classic)).not.toThrow()
    expect(() => validateEdition(anniversary)).not.toThrow()
  })

  it('refuses a mapSize that is not a power of two', () => {
    for (const mapSize of [1500, 2049, 0, -2048, 3000]) {
      expect(() => validateEdition(withShadows({ mapSize })), String(mapSize)).toThrow(
        EditionSchemaError,
      )
    }
  })

  it('refuses a mapSize outside 256..4096', () => {
    // A 128 map over a 700 m box is 5.5 m a texel — coarser than a terrain facet
    // — and an 8192 one is 256 MB of depth on a headset.
    expect(() => validateEdition(withShadows({ mapSize: 128 }))).toThrow(EditionSchemaError)
    expect(() => validateEdition(withShadows({ mapSize: 8192 }))).toThrow(EditionSchemaError)
    expect(() => validateEdition(withShadows({ mapSize: 256 }))).not.toThrow()
    expect(() => validateEdition(withShadows({ mapSize: 4096 }))).not.toThrow()
  })

  it('refuses a boxHalfSize of zero or below', () => {
    // Zero is the silent one: the texel size goes to zero, every frame snaps to
    // the same point, and the whole world is shaded by one texel.
    for (const boxHalfSize of [0, -1]) {
      expect(() => validateEdition(withShadows({ boxHalfSize }))).toThrow(EditionSchemaError)
    }
    // With a band inside it (DEV-453): a 1 m box cannot hold Anniversary's.
    expect(() => validateEdition(withShadows({ boxHalfSize: 1, edgeFade: 0.5 }))).not.toThrow()
  })

  it('refuses an edgeFade that is a hole, negative, or as wide as the box (DEV-453)', () => {
    // As wide as the box would fade the map out at the camera itself; a hole
    // is a NaN in every lit fragment's shadow lookup.
    const half = anniversary.render.shadows.boxHalfSize
    for (const edgeFade of [Number.NaN, -1, half, half + 1, Number.POSITIVE_INFINITY]) {
      expect(() => validateEdition(withShadows({ edgeFade })), String(edgeFade)).toThrow(
        EditionSchemaError,
      )
    }
    // Zero is 2016's hard edge: legal, and shipped by neither preset.
    expect(() => validateEdition(withShadows({ edgeFade: 0 }))).not.toThrow()
    expect(() => validateEdition(withShadows({ edgeFade: half - 1 }))).not.toThrow()
  })

  it('ships a band on BOTH presets — Matt: the hard edge is "an artifact i couldn\'t fix at the time"', () => {
    // DEV-453. Classic's map is off, so its number is inert today; it is not
    // zero, because Matt's call is that 2016's hard edge was an artifact and
    // not part of the look Classic keeps.
    expect(anniversary.render.shadows.edgeFade).toBeGreaterThan(0)
    expect(classic.render.shadows.edgeFade).toBeGreaterThan(0)
  })

  it('refuses a hole in any of the four distances', () => {
    for (const key of ['castDistance', 'bias', 'normalBias', 'radius']) {
      expect(() => validateEdition(withShadows({ [key]: Number.NaN })), key).toThrow(
        EditionSchemaError,
      )
      expect(() => validateEdition(withShadows({ [key]: -1 })), key).toThrow(EditionSchemaError)
    }
  })

  it('declares the block in BOTH presets, so a flip cannot read undefined', () => {
    for (const [name, e] of [
      ['classic', classic],
      ['anniversary', anniversary],
    ] as const) {
      expect(e.render.shadows, name).toBeTypeOf('object')
      expect(e.render.shadows.enabled, name).toBeTypeOf('boolean')
    }
    // The invariant DEV-078 made Classic mean: every switchable feature off.
    expect(classic.render.shadows.enabled).toBe(false)
    expect(anniversary.render.shadows.enabled).toBe(true)
  })
})

// ── 5. the one thing a unit test cannot reach, guarded at the source ──────

describe('the terrain re-flags a chunk whose LOD moved', () => {
  // A chunk's LOD changes at RUNTIME: the worker replies with new geometry and
  // `load-terrain.ts` swaps it in. 2016 cast from LOD 0 only, so `castShadow`
  // has to move with the LOD — and a `castShadow` written once from outside is
  // right at boot and wrong from the first band crossing, with the symptom
  // "shadows disappear as you fly toward them", which reads as fog.
  //
  // Reaching that path for real needs two megapixel PNGs, a Worker and a
  // `Promise.all`, so this guards the source instead, the way
  // `program-cache-key.test.ts` guards its own rule. It is the cheaper half of a
  // guard, and it is the half that would actually have caught the regression.
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src/game/terrain/load-terrain.ts'),
    'utf8',
  )

  it('calls applySlotShadow right after the worker reply moves slot.lod', () => {
    const at = source.indexOf('slot.lod = reply.lod')
    expect(at, 'the worker reply no longer assigns slot.lod — re-read this test').toBeGreaterThan(
      -1,
    )
    expect(
      source.slice(at, at + 240),
      'the worker reply changes a chunk LOD without re-flagging its shadow (DEV-086)',
    ).toContain('applySlotShadow(slot)')
  })

  it('routes the LOD-0 rule through shadowFlagsFor rather than writing it twice', () => {
    // `lod === 0` appearing here would be the rule written a second time, which
    // is how the table in `render/shadows.ts` and the terrain would come to
    // disagree — and the test above would still pass while they did.
    expect(source).toContain('shadowFlagsFor(shadowRole, shadowsOn, slot.lod)')
    expect(source).not.toContain('castShadow = slot.lod === 0')
  })

  it('exposes setShadows on every terrain, which is what boot/app.ts attaches', () => {
    expect(source).toContain('setShadows(on: boolean)')
  })
})
