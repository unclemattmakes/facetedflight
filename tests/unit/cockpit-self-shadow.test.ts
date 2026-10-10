// tests/unit/cockpit-self-shadow.test.ts — the cockpit's shadow on itself.
// DEV-323, answering NEXT.md's look call 6.
//
// Matt: *"in first person, i'd expect the cockpit to cast shadows on itself.
// like the bars should cast shadows on the console."* The sun's map is 0.68 m
// a texel and cannot; `render/cockpit-self-shadow.ts` is a second map over the
// ship alone. What this file holds, and why each half is here:
//
//  1. THE FIT — geometry, not a matrix written twice (the orientation lesson):
//     the sphere lands inside the map for every sun, its centre in the middle,
//     and a translated ship draws the SAME map, which is the whole argument for
//     not snapping it the way the sun's map snaps.
//  2. THE SKIP — the number that takes look call 6's blob away, against the
//     real hull: every hull vertex is inside the reach it skips.
//  3. THE PREMISE — the hull's canopy is closed and opaque from the eye, so it
//     cannot be a caster; the shell's is open and barred. Read off the GLBs,
//     which are gitignored, so that half branches rather than skips (a
//     `describe.skipIf` counterpart would move the skipped count the brief
//     pins, and an in-test branch says the same thing out loud).
//  4. THE SHADER — both anchor shapes, far-shadow composed first, and every
//     name each half uses declared in THAT half (two symbol tables).
//  5. THE CACHE KEY and the define — tagged, chained, and a flip that moves a
//     VALUE and never the key's order (DEV-194).
//  6. THE LIVE SYSTEM on a stub renderer — Classic builds nothing, the pass
//     hands the renderer back even when it throws.
//  7. THE PRESETS and the Advanced page — no eighth row, and why that is safe.

import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { describe, expect, it } from 'vitest'
import { type ComfortSettings, DEFAULT_SETTINGS } from '@/boot/settings'
import type { Edition } from '@/content/edition-schema'
import { applyVrOverrides, editionFeatures, validateEdition } from '@/content/edition-schema'
import { createEditionState } from '@/game/edition'
import { ART_POSITION, ART_SCALE, EYE, SHIP_MODEL_YAW } from '@/game/flight'
import { ADVANCED_FEATURES } from '@/render/advanced-menu'
import {
  applyNearFit,
  COCKPIT_ROOT_NAME,
  COCKPIT_SELF_SHADOW_TAG,
  cockpitSelfShadowEnabled,
  createCockpitSelfShadow,
  createNearShadowUniforms,
  fitNearShadow,
  hasNearShadow,
  installNearShadow,
  mainMapSkip,
  NEAR_DEFINE,
  NEAR_FRAGMENT_PRELUDE,
  NEAR_VERTEX_PRELUDE,
  type NearShadowRenderer,
  nearShadowCastersOf,
  nearShadowPatchFragment,
  nearShadowPatchVertex,
  REPORT_KEY,
  setNearDefine,
} from '@/render/cockpit-self-shadow'
import { sunHeightPatchFragment } from '@/render/far-shadow'
import {
  fitSunShadow,
  lightBasis,
  shadowBiasFor,
  shadowsEnabled,
  type Vec3,
} from '@/render/shadows'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'
import { appFileWith, inOrder } from './helpers/app-source'

const anniversary = anniversaryJson as unknown as Edition
const classic = classicJson as unknown as Edition
const ROOT = process.cwd()
const HIGH: ComfortSettings = { ...DEFAULT_SETTINGS, quality: 'high' }
const LOW: ComfortSettings = { ...DEFAULT_SETTINGS, quality: 'low' }

/** A world point through the near map's own matrix: (u, v, depth), each 0..1 inside. */
const project = (light: THREE.DirectionalLight, p: THREE.Vector3): THREE.Vector3 =>
  p.clone().applyMatrix4(light.shadow.matrix)

/** Points on a sphere, deterministic. */
const spherePoints = (c: Vec3, r: number, n = 240): THREE.Vector3[] => {
  const out: THREE.Vector3[] = []
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n
    const rr = Math.sqrt(1 - y * y)
    const t = golden * i
    out.push(
      new THREE.Vector3(c[0] + r * rr * Math.cos(t), c[1] + r * y, c[2] + r * rr * Math.sin(t)),
    )
  }
  return out
}

/** Sun directions (where light TRAVELS), overhead and grazing included. */
const SUNS: Vec3[] = (() => {
  const out: Vec3[] = [[0, -1, 0]]
  for (const el of [0.5, 4, 20, 46.5, 75, 89.9]) {
    for (let az = 0; az < 360; az += 45) {
      const e = (el * Math.PI) / 180
      const a = (az * Math.PI) / 180
      out.push([Math.cos(e) * Math.sin(a), -Math.sin(e), Math.cos(e) * Math.cos(a)])
    }
  }
  return out
})()

// rookie_01's sun (`lighting.sun.direction`), the mission the photographs use.
const ROOKIE_SUN: Vec3 = [0.109991, -0.725026, -0.679881]

/**
 * The shell's bounding-sphere radius, metres — three's `computeBoundingSphere`
 * on `hoverjet-cockpit.glb` in ship space. Measured, not chosen: §3 re-measures
 * it off the GLB and fails if it moves, so the fits above cannot drift from it.
 */
const SHELL_RADIUS = 3.382

// ── 1. the fit ─────────────────────────────────────────────────────────────

describe('§1 the near box is the ship, seen along the sun', () => {
  it('holds the whole caster sphere inside the map for every sun, overhead and grazing', () => {
    const centre: Vec3 = [812.3, 141.7, -377.9]
    const r = SHELL_RADIUS
    const light = new THREE.DirectionalLight()
    for (const sun of SUNS) {
      applyNearFit(light, fitNearShadow({ centre, radius: r, lightDirection: sun, mapSize: 2048 }))
      for (const p of spherePoints(centre, r)) {
        const q = project(light, p)
        for (const k of ['x', 'y', 'z'] as const) {
          expect(q[k], `sun ${sun.map((n) => n.toFixed(2))}: ${k}`).toBeGreaterThanOrEqual(-1e-9)
          expect(q[k], `sun ${sun.map((n) => n.toFixed(2))}: ${k}`).toBeLessThanOrEqual(1 + 1e-9)
        }
      }
    }
  })

  it('puts the centre in the middle, the up-sun pole at depth 0 and the down-sun pole at 1', () => {
    // Geometry that is true whatever the basis is — not a matrix re-derived.
    // Within 5e-4 of the map (a fifth of a texel at 2048) rather than to float
    // precision, and the reason is three's, found by this test: a sun EXACTLY
    // overhead is `lookAt`'s degenerate case, which nudges the basis by 1e-4.
    // No shipped mission's sun is above 52.6 degrees.
    const centre: Vec3 = [10, 20, 30]
    const light = new THREE.DirectionalLight()
    for (const sun of SUNS) {
      const n = new THREE.Vector3(...sun).normalize()
      applyNearFit(light, fitNearShadow({ centre, radius: 3, lightDirection: sun, mapSize: 1024 }))
      const c = project(light, new THREE.Vector3(...centre))
      expect(c.x).toBeCloseTo(0.5, 3)
      expect(c.y).toBeCloseTo(0.5, 3)
      expect(c.z).toBeCloseTo(0.5, 6)
      const up = project(light, new THREE.Vector3(...centre).addScaledVector(n, -3))
      const down = project(light, new THREE.Vector3(...centre).addScaledVector(n, 3))
      expect(up.z).toBeCloseTo(0, 6)
      expect(down.z).toBeCloseTo(1, 6)
      // And ALONG the light is no lateral move: the pole projects onto the centre.
      expect(up.x).toBeCloseTo(0.5, 3)
      expect(up.y).toBeCloseTo(0.5, 3)
    }
  })

  it('a translated ship draws the SAME map — no crawl — where the sun map’s snap would crawl', () => {
    // The header's argument, as arithmetic. A point on the ship, the ship moved
    // by a distance that is no multiple of anything: the near map sees the
    // point at the same texel, to float precision.
    const light = new THREE.DirectionalLight()
    const c1: Vec3 = [812.3, 141.7, -377.9]
    const t: Vec3 = [37.123457, -2.731937, 11.414213]
    const c2: Vec3 = [c1[0] + t[0], c1[1] + t[1], c1[2] + t[2]]
    const onShip = new THREE.Vector3(0.31, 0.44, -0.9)
    applyNearFit(
      light,
      fitNearShadow({
        centre: c1,
        radius: SHELL_RADIUS,
        lightDirection: ROOKIE_SUN,
        mapSize: 2048,
      }),
    )
    const a = project(light, onShip.clone().add(new THREE.Vector3(...c1)))
    applyNearFit(
      light,
      fitNearShadow({
        centre: c2,
        radius: SHELL_RADIUS,
        lightDirection: ROOKIE_SUN,
        mapSize: 2048,
      }),
    )
    const b = project(light, onShip.clone().add(new THREE.Vector3(...c2)))
    const texels = (d: number) => Math.abs(d) * 2048
    expect(texels(a.x - b.x), 'u moved, in texels').toBeLessThan(1e-6)
    expect(texels(a.y - b.y), 'v moved, in texels').toBeLessThan(1e-6)
    expect(Math.abs(a.z - b.z), 'depth moved').toBeLessThan(1e-9)

    // The same move under the SUN map's texel snap, over the same 6.8 m box
    // at the same 2048: the box moves in whole texels while the ship does not,
    // so a point on the ship lands a FRACTION of a texel elsewhere. That is
    // right for the world (an edge on the ground must not swim) and wrong for
    // the ship (its own bars would crawl across its own console).
    const sunPos: Vec3 = [-ROOKIE_SUN[0] * 1e4, -ROOKIE_SUN[1] * 1e4, -ROOKIE_SUN[2] * 1e4]
    const { x } = lightBasis(sunPos, [0, 0, 0])
    const texelCoord = (centre: Vec3, p: THREE.Vector3): number => {
      const f = fitSunShadow({
        centre,
        lightPosition: sunPos,
        lightTarget: [0, 0, 0],
        boxHalfSize: SHELL_RADIUS,
        mapSize: 2048,
        castDistance: 0,
      })
      const rel = [p.x - sunPos[0], p.y - sunPos[1], p.z - sunPos[2]]
      return (
        ((rel[0] as number) * x[0] +
          (rel[1] as number) * x[1] +
          (rel[2] as number) * x[2] -
          f.left) /
        f.texelSize
      )
    }
    const snapped1 = texelCoord(c1, onShip.clone().add(new THREE.Vector3(...c1)))
    const snapped2 = texelCoord(c2, onShip.clone().add(new THREE.Vector3(...c2)))
    expect(
      Math.abs(snapped1 - snapped2),
      'the snap moved the ship across its own texels',
    ).toBeGreaterThan(0.01)
  })

  it('keeps one texel size for every sun, so the map never breathes as the ship turns', () => {
    const sizes = new Set(
      SUNS.map((sun) =>
        fitNearShadow({
          centre: [0, 0, 0],
          radius: SHELL_RADIUS,
          lightDirection: sun,
          mapSize: 2048,
        }).texelSize.toFixed(12),
      ),
    )
    expect([...sizes]).toEqual([((2 * SHELL_RADIUS) / 2048).toFixed(12)])
  })
})

// ── 2. the skip ────────────────────────────────────────────────────────────

describe('§2 the sun map skips the ship on the shell, and only the ship', () => {
  it('is the reach over the sun map’s depth range, and nothing without a map', () => {
    expect(mainMapSkip(9.2, { near: -100, far: 4800 })).toBeCloseTo(9.2 / 4900, 12)
    expect(mainMapSkip(9.2, null)).toBe(0)
    expect(mainMapSkip(0, { near: 0, far: 10 })).toBe(0)
  })

  it('on Anniversary’s own box: the canopy glass stops shading the shell, a ridge does not', () => {
    // The GLSL compare, in the sun map's normalised depth: lit iff
    // `z + bias - skip <= stored`. Receiver at the centre of the box; an
    // occluder `d` metres up-sun of it. Anniversary's live numbers.
    const sh = anniversary.render.shadows
    const sunPos: Vec3 = [-ROOKIE_SUN[0] * 1e4, -ROOKIE_SUN[1] * 1e4, -ROOKIE_SUN[2] * 1e4]
    const centre: Vec3 = [812.3, 141.7, -377.9]
    const fit = fitSunShadow({
      centre,
      lightPosition: sunPos,
      lightTarget: [0, 0, 0],
      boxHalfSize: sh.boxHalfSize,
      mapSize: sh.mapSize,
      castDistance: sh.castDistance,
    })
    const range = fit.far - fit.near
    const reach = 2 * SHELL_RADIUS
    const skip = mainMapSkip(reach, fit)
    const bias = shadowBiasFor(sh.bias, fit)
    const lit = (d: number, s: number) => {
      const z = 0.5 // anywhere; only differences matter in an orthographic depth
      return z + bias - s <= z - d / range
    }
    // Inside `render.shadows.bias` (0.5 m) the sun map never shaded anything,
    // so the blob is hull a metre or more up-sun of the console: the canopy
    // top, the spine, the tail. All of it is inside the reach (§3 measures it).
    expect(lit(sh.bias - 0.01, 0), 'the sun map’s own bias already lets go under 0.5 m').toBe(true)
    for (const d of [0.8, 3, reach - 0.01]) {
      expect(lit(d, 0), `${d} m of hull shades the shell WITHOUT the skip — the blob`).toBe(false)
      expect(lit(d, skip), `${d} m of hull is skipped`).toBe(true)
    }
    // A ridge, a tree: further than the ship is long, still shadow.
    for (const d of [reach + 0.6, 40, 700]) {
      expect(lit(d, skip), `${d} m up-sun still shades the cockpit`).toBe(false)
    }
  })
})

// ── 3. the premise: which mesh can cast ───────────────────────────────────

describe('§3 the casters are the shell, and the hull cannot be one', () => {
  it('finds the shell’s meshes under the flight and never the hull’s', () => {
    const flight = new THREE.Group()
    flight.name = 'hoverjet'
    const pivot = new THREE.Group()
    const shell = new THREE.Group()
    shell.name = COCKPIT_ROOT_NAME
    const shellMesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial())
    shell.add(shellMesh)
    const hull = new THREE.Group()
    hull.name = 'ship_third_person'
    hull.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()))
    pivot.add(shell, hull)
    flight.add(pivot)
    expect(nearShadowCastersOf(flight)).toEqual([shellMesh])
    // The JumpSeat: no shell by that name, nothing to cast — not a fallback.
    expect(nearShadowCastersOf(new THREE.Group())).toEqual([])
    expect(nearShadowCastersOf(null)).toEqual([])
  })

  const SHELL_GLB = path.join(ROOT, 'public/assets/ships/hoverjet-cockpit.glb')
  const HULL_GLB = path.join(ROOT, 'public/assets/ships/hoverjet-exterior.glb')

  /** A GLB in SHIP space — the three lines every consumer applies. */
  const shipSpace = async (file: string): Promise<THREE.Mesh> => {
    const bytes = fs.readFileSync(file)
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    const scene: THREE.Object3D = await new Promise((resolve, reject) => {
      new GLTFLoader().parse(buffer as ArrayBuffer, '', (g) => resolve(g.scene), reject)
    })
    scene.position.copy(ART_POSITION)
    scene.rotation.y = SHIP_MODEL_YAW
    scene.scale.copy(ART_SCALE)
    const root = new THREE.Group()
    root.add(scene)
    root.updateWorldMatrix(true, true)
    let mesh: THREE.Mesh | null = null
    scene.traverse((n) => {
      if ((n as THREE.Mesh).isMesh) mesh = n as THREE.Mesh
    })
    if (!mesh) throw new Error(`${file}: no mesh`)
    return mesh
  }

  it('the hull’s canopy is closed over the eye, the shell’s is barred — read off the GLBs', async () => {
    const have = fs.existsSync(SHELL_GLB) && fs.existsSync(HULL_GLB)
    if (!have) {
      // The loud half, in-test rather than a skipped counterpart: the GLBs
      // are gitignored (hard rule 7), so on CI this says exactly that.
      expect(fs.existsSync(SHELL_GLB) && fs.existsSync(HULL_GLB)).toBe(false)
      return
    }
    const shell = await shipSpace(SHELL_GLB)
    const hull = await shipSpace(HULL_GLB)
    const ray = new THREE.Raycaster()
    ray.far = 50
    let total = 0
    let hullHits = 0
    let shellHits = 0
    for (let el = 15; el <= 85; el += 5) {
      for (let az = -180; az < 180; az += 7.5) {
        const e = (el * Math.PI) / 180
        const a = (az * Math.PI) / 180
        const d = new THREE.Vector3(
          Math.cos(e) * Math.sin(a),
          Math.sin(e),
          -Math.cos(e) * Math.cos(a),
        )
        ray.set(EYE, d)
        total++
        if (ray.intersectObject(hull, false).length > 0) hullHits++
        if (ray.intersectObject(shell, false).length > 0) shellHits++
      }
    }
    console.info(
      `cockpit-self-shadow: from the eye, ${total} directions 15-85 deg up: the hull blocks ` +
        `${hullHits} (${((100 * hullHits) / total).toFixed(1)} %), the shell ${shellHits} ` +
        `(${((100 * shellHits) / total).toFixed(1)} %)`,
    )
    // Closed: a caster that shades every direction the sun can come from.
    expect(hullHits, 'the hull canopy is closed over the eye').toBe(total)
    // Barred: most of the sky is open through the shell's frame.
    expect(shellHits / total, 'the shell leaves most of the sky open').toBeLessThan(0.5)
    expect(shellHits, 'and it has bars at all').toBeGreaterThan(0)
  })

  it('every hull vertex is inside the shell’s sphere, so the skip covers the whole hull', async () => {
    const have = fs.existsSync(SHELL_GLB) && fs.existsSync(HULL_GLB)
    if (!have) {
      expect(fs.existsSync(SHELL_GLB) && fs.existsSync(HULL_GLB)).toBe(false)
      return
    }
    const shell = await shipSpace(SHELL_GLB)
    const hull = await shipSpace(HULL_GLB)
    shell.geometry.computeBoundingSphere()
    const sphere = (shell.geometry.boundingSphere as THREE.Sphere)
      .clone()
      .applyMatrix4(shell.matrixWorld)
    const p = hull.geometry.attributes.position as THREE.BufferAttribute
    let worst = 0
    for (let i = 0; i < p.count; i++) {
      const v = new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i)).applyMatrix4(hull.matrixWorld)
      worst = Math.max(worst, v.distanceTo(sphere.center) - sphere.radius)
    }
    const triangles = (shell.geometry.index?.count ?? 0) / 3
    console.info(
      `cockpit-self-shadow: shell sphere r=${sphere.radius.toFixed(3)} m (texel ` +
        `${((2 * sphere.radius * 1000) / anniversary.render.cockpitSelfShadow.mapSize).toFixed(2)} mm at ` +
        `${anniversary.render.cockpitSelfShadow.mapSize}), ${triangles} triangles; hull's worst vertex ` +
        `${worst.toFixed(3)} m past it`,
    )
    // To a micron: the two GLBs share their extreme vertices exactly.
    expect(
      worst,
      'a hull vertex outside the shell sphere would escape the skip',
    ).toBeLessThanOrEqual(1e-6)
    // The numbers the Anniversary note quotes (a derived number needs a test, DEV-027).
    expect(sphere.radius).toBeCloseTo(SHELL_RADIUS, 3)
    expect(triangles).toBe(1182)
  })
})

// ── 4. the shader ─────────────────────────────────────────────────────────

const RAW_FRAGMENT = THREE.ShaderLib.physical.fragmentShader
const RAW_VERTEX = THREE.ShaderLib.physical.vertexShader
const DIR_START = '#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )'

/** The directional block of an expanded shader, start to its unroll end. */
const dirBlock = (text: string): string => {
  const start = text.indexOf(DIR_START)
  const end = text.indexOf('#pragma unroll_loop_end', start)
  expect(start, 'the directional block is in the text').toBeGreaterThanOrEqual(0)
  return text.slice(start, end)
}

const count = (text: string, needle: string): number => text.split(needle).length - 1

/** Names used against names declared, in ONE half. */
const undeclared = (text: string): string[] => {
  const used = new Set(
    text.match(/\b(?:[uv]Ff2CockpitNear\w*|ff2CockpitNearShadow|FF2_COCKPIT_MAIN_SKIP)\b/g) ?? [],
  )
  const declared = new Set<string>()
  for (const m of text.matchAll(/\b(?:uniform|varying)\s+\w+\s+(\w+)\s*;/g))
    declared.add(m[1] as string)
  for (const m of text.matchAll(/#define\s+(\w+)/g)) declared.add(m[1] as string)
  for (const m of text.matchAll(/\bfloat\s+(\w+)\s*\([^)]*\)\s*\{/g)) declared.add(m[1] as string)
  return [...used].filter((n) => !declared.has(n))
}

describe('§4 the shader: one term, in the sun’s own block, in either anchor shape', () => {
  it('expands the include when nobody has, and lands inside the directional block', () => {
    const out = nearShadowPatchFragment(RAW_FRAGMENT)
    const block = dirBlock(out)
    expect(count(out, 'ff2CockpitNearShadow('), 'one call site plus the definition').toBe(2)
    expect(count(block, 'ff2CockpitNearShadow('), 'the call is in the directional block').toBe(1)
    expect(count(out, '( directionalLightShadow.shadowBias - FF2_COCKPIT_MAIN_SKIP )')).toBe(1)
    // AFTER the sun's own statement, inside the same shadow `#if`.
    expect(block.indexOf('ff2CockpitNearShadow(')).toBeGreaterThan(block.indexOf('getShadow('))
    // The point and spot loops are three's, untouched.
    const chunk = THREE.ShaderChunk.lights_fragment_begin
    expect(count(out, 'RE_Direct( directLight,')).toBe(count(chunk, 'RE_Direct( directLight,'))
    expect(count(out, 'getPointShadow(')).toBe(count(chunk, 'getPointShadow('))
  })

  it('composes AFTER far-shadow, which is the shipped order, and keeps far-shadow’s min', () => {
    const farFirst = sunHeightPatchFragment(RAW_FRAGMENT)
    expect(farFirst, 'far-shadow expanded the include').not.toContain(
      '#include <lights_fragment_begin>',
    )
    const out = nearShadowPatchFragment(farFirst)
    const block = dirBlock(out)
    expect(block, "far-shadow's min survives").toContain('ff2SunHeightTerm() );')
    expect(count(block, 'ff2CockpitNearShadow(')).toBe(1)
    expect(block.indexOf('ff2CockpitNearShadow(')).toBeGreaterThan(
      block.indexOf('ff2SunHeightTerm() );'),
    )
    expect(count(out, '( directionalLightShadow.shadowBias - FF2_COCKPIT_MAIN_SKIP )')).toBe(1)
  })

  it('and boot/app.ts installs it after far-shadow, before the warm draw', () => {
    // The order the test above depends on, read where somebody would EDIT it:
    // the other order leaves far-shadow no include and the cockpit loses the
    // far-field term with no error at all.
    const farAnchor = 'for (const mat of Array.isArray(m) ? m : [m]) farShadow.applyTo(mat)'
    const build = appFileWith(farAnchor).text
    const [far, near] = inOrder(build, [
      farAnchor,
      'cockpitSelfShadow.attach(loadedFlight.object)',
    ]) as [number, number]
    // DEV-355: the mission's warm is `warmWorldLinked(` — the same warm, with
    // the link wait off the thread — and either spelling is the warm draw.
    const warm = Math.max(
      build.indexOf('warmWorld(', near),
      build.indexOf('warmWorldLinked(', near),
    )
    expect(far, 'the far-shadow traversal').toBeGreaterThan(0)
    expect(near, 'attach after far-shadow').toBeGreaterThan(far)
    expect(warm, 'and before the warm draw').toBeGreaterThan(near)
    // The pass is INSIDE the GPU bracket, before the draw that samples it.
    // `inOrder` throws on any anchor missing after the one before, so the
    // chain cannot pass on a -1 (APP-SPLIT phase 0).
    const frame = appFileWith('const renderT0').text
    inOrder(frame, [
      'const renderT0',
      'gpu.begin()',
      'cockpitSelfShadow.update()',
      'render.renderer.render(stage, render.camera)',
    ])
  })

  it('every name each half uses is declared in THAT half — two symbol tables', () => {
    const vertex = nearShadowPatchVertex(RAW_VERTEX)
    const fragment = nearShadowPatchFragment(sunHeightPatchFragment(RAW_FRAGMENT))
    expect(undeclared(vertex), 'vertex half').toEqual([])
    expect(undeclared(fragment), 'fragment half').toEqual([])
    // And the sweep is looking at something: both halves use the varying.
    expect(vertex).toContain('vFf2CockpitNear =')
    expect(fragment).toContain('vFf2CockpitNear.xyz')
    // The preludes are what declare them, one per half.
    expect(NEAR_VERTEX_PRELUDE).toContain('uniform mat4 uFf2CockpitNearMatrix;')
    expect(NEAR_FRAGMENT_PRELUDE).toContain('uniform sampler2DShadow uFf2CockpitNearMap;')
    expect(NEAR_FRAGMENT_PRELUDE).not.toContain('uFf2CockpitNearMatrix')
  })

  it('writes the coordinate only where three declares what it reads — three as the oracle', () => {
    // `worldPosition` and `shadowWorldNormal` exist under USE_SHADOWMAP with a
    // directional shadow; the vertex term is guarded by the same condition.
    expect(THREE.ShaderChunk.worldpos_vertex).toContain('defined ( USE_SHADOWMAP )')
    expect(THREE.ShaderChunk.shadowmap_vertex).toContain(
      '#if ( defined( USE_SHADOWMAP ) && ( NUM_DIR_LIGHT_SHADOWS > 0',
    )
    expect(THREE.ShaderChunk.shadowmap_vertex).toContain('vec3 shadowWorldNormal')
    const vertex = nearShadowPatchVertex(RAW_VERTEX)
    expect(vertex).toContain(
      `#if ${NEAR_DEFINE} && defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0`,
    )
    expect(vertex.indexOf('vFf2CockpitNear =')).toBeGreaterThan(
      vertex.indexOf('#include <shadowmap_vertex>'),
    )
  })

  it('refuses a lit shader it cannot anchor, and leaves an unlit one alone', () => {
    const lit = RAW_FRAGMENT.replace('#include <lights_fragment_begin>', '// somebody rewrote this')
    expect(() => nearShadowPatchFragment(lit)).toThrow(/lit but has neither/)
    const unlit = THREE.ShaderLib.basic.fragmentShader
    expect(nearShadowPatchFragment(unlit)).toBe(unlit)
    expect(() => nearShadowPatchVertex('void main() {}')).toThrow(/shadowmap_vertex/)
  })
})

// ── 5. the cache key and the define ───────────────────────────────────────

describe('§5 tagged, chained, and a flip that moves a VALUE', () => {
  it('splits the patched shell from an unpatched twin in three’s cache key', () => {
    const a = new THREE.MeshStandardMaterial()
    const b = new THREE.MeshStandardMaterial()
    installNearShadow(a, createNearShadowUniforms())
    expect(a.customProgramCacheKey()).toContain(COCKPIT_SELF_SHADOW_TAG)
    expect(a.customProgramCacheKey()).not.toBe(b.customProgramCacheKey())
    // Twice is once: one tag, one hook.
    const key = a.customProgramCacheKey()
    const hook = a.onBeforeCompile
    installNearShadow(a, createNearShadowUniforms())
    expect(a.customProgramCacheKey()).toBe(key)
    expect(a.onBeforeCompile).toBe(hook)
  })

  it('chains the hook that was there, so far-shadow still runs first', () => {
    const m = new THREE.MeshStandardMaterial()
    m.onBeforeCompile = (shader) => {
      shader.fragmentShader = `// earlier patch\n${shader.fragmentShader}`
    }
    installNearShadow(m, createNearShadowUniforms())
    const shader = {
      uniforms: {} as Record<string, THREE.IUniform>,
      vertexShader: RAW_VERTEX,
      fragmentShader: RAW_FRAGMENT,
    } as unknown as THREE.WebGLProgramParametersWithUniforms
    m.onBeforeCompile(shader, {} as THREE.WebGLRenderer)
    expect(shader.fragmentShader).toContain('// earlier patch')
    expect(shader.fragmentShader).toContain('ff2CockpitNearShadow(')
    expect(Object.keys(shader.uniforms)).toContain('uFf2CockpitNearMap')
  })

  it('flips the define’s VALUE in place — the key order never moves (DEV-194)', () => {
    const m = new THREE.MeshStandardMaterial()
    installNearShadow(m, createNearShadowUniforms())
    const defines = m.defines as Record<string, unknown>
    const order = Object.keys(defines).join(',')
    expect(defines[NEAR_DEFINE]).toBe(0)
    const v0 = m.version
    expect(setNearDefine(m, true)).toBe(true)
    expect(setNearDefine(m, true), 'no change, no recompile').toBe(false)
    expect(setNearDefine(m, false)).toBe(true)
    expect(setNearDefine(m, true)).toBe(true)
    expect(Object.keys(defines).join(','), 'the same keys in the same order').toBe(order)
    expect(defines[NEAR_DEFINE]).toBe(1)
    expect(m.version - v0, 'one recompile per real flip').toBe(3)
    // A material that never carried the patch is never given the define.
    const bare = new THREE.MeshStandardMaterial()
    expect(setNearDefine(bare, true)).toBe(false)
    expect(Object.hasOwn(bare.defines as object, NEAR_DEFINE)).toBe(false)
  })
})

// ── 6. the live system ────────────────────────────────────────────────────

interface Stub extends NearShadowRenderer {
  readonly log: string[]
  throwOnRender: boolean
}

const stubRenderer = (): Stub => {
  let target: THREE.WebGLRenderTarget | null = null
  const log: string[] = []
  const stub: Stub = {
    log,
    throwOnRender: false,
    autoClear: true,
    xr: { enabled: true },
    shadowMap: { autoUpdate: true },
    state: { buffers: { depth: { setMask: (m: boolean) => void log.push(`mask:${m}`) } } },
    info: { autoReset: true, render: { calls: 100, triangles: 5000 } },
    getRenderTarget: () => target,
    setRenderTarget: (t) => {
      target = t
      log.push(t ? `target:${t.width}` : 'target:prev')
    },
    clear: (c, d, s) => void log.push(`clear:${c},${d},${s}`),
    render: (scene, camera) => {
      log.push(`render:${scene.name}:${(camera as THREE.OrthographicCamera).isOrthographicCamera}`)
      if (stub.throwOnRender) throw new Error('context lost')
      let draws = 0
      let tris = 0
      scene.traverse((n) => {
        const g = (n as THREE.Mesh).geometry
        if (!(n as THREE.Mesh).isMesh || !g) return
        draws++
        tris += (g.index?.count ?? 0) / 3
      })
      stub.info.render.calls += draws
      stub.info.render.triangles += tris
    },
  }
  return stub
}

/** A world with a shell and a hull under a flight, in a scene, and a sun in it. */
const world = () => {
  const scene = new THREE.Scene()
  const flight = new THREE.Group()
  flight.name = 'hoverjet'
  flight.position.set(812, 140, -378)
  const shell = new THREE.Group()
  shell.name = COCKPIT_ROOT_NAME
  const material = new THREE.MeshStandardMaterial()
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 1, 6), material)
  shell.add(mesh)
  const hull = new THREE.Group()
  hull.name = 'ship_third_person'
  hull.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()))
  flight.add(shell, hull)
  scene.add(flight)
  const sun = new THREE.DirectionalLight()
  sun.position.set(-ROOKIE_SUN[0] * 1e4, -ROOKIE_SUN[1] * 1e4, -ROOKIE_SUN[2] * 1e4)
  scene.add(sun, sun.target)
  return { scene, flight, shell, material, sun }
}

describe('§6 the live system: Classic builds nothing, and the renderer always comes back', () => {
  it('Classic: no target, no patch, no pass — the shell’s material untouched', () => {
    const w = world()
    const hook = w.material.onBeforeCompile
    const r = stubRenderer()
    const near = createCockpitSelfShadow(r, w.sun, createEditionState(classic, HIGH), () => null)
    near.attach(w.flight)
    near.update()
    expect(near.report).toMatchObject({ on: false, patched: 0, casters: 0, mapSize: 0, passes: 0 })
    expect(r.log, 'the renderer was never touched').toEqual([])
    expect(w.material.onBeforeCompile).toBe(hook)
    expect(Object.hasOwn(w.material.defines as object, NEAR_DEFINE)).toBe(false)
    near.dispose()
  })

  it('Anniversary: patches the shell, draws one proxy per mesh, and hands everything back', () => {
    const w = world()
    const r = stubRenderer()
    const near = createCockpitSelfShadow(r, w.sun, createEditionState(anniversary, HIGH), () => ({
      near: -200,
      far: 4700,
    }))
    near.attach(w.flight)
    expect(hasNearShadow(w.material)).toBe(true)
    expect((w.material.defines as Record<string, unknown>)[NEAR_DEFINE]).toBe(1)
    const before = r.log.length
    near.update()
    const report = near.report
    expect(report.on).toBe(true)
    expect(report.casters, 'one proxy — the shell, never the hull').toBe(1)
    expect(report.calls).toBe(1)
    expect(report.triangles).toBe(12)
    expect(report.passes).toBe(1)
    expect(report.mapSize).toBe(anniversary.render.cockpitSelfShadow.mapSize)
    expect(report.skipMetres).toBeCloseTo(2 * report.radius, 9)
    expect(report.skipNormalised).toBeCloseTo(report.skipMetres / 4900, 12)
    expect(r.log.slice(before)).toEqual([
      `target:${anniversary.render.cockpitSelfShadow.mapSize}`,
      'mask:true',
      'clear:false,true,false',
      'render:cockpit-self-shadow:true',
      'target:prev',
    ])
    expect(r.xr.enabled).toBe(true)
    expect(r.autoClear).toBe(true)
    expect(r.shadowMap.autoUpdate).toBe(true)
    expect(r.info.autoReset).toBe(true)
    expect(r.getRenderTarget()).toBe(null)
    // The report a spec reads, hung on the shell it shadows.
    const fn = w.shell.userData[REPORT_KEY] as () => { passes: number }
    expect(fn().passes).toBe(1)
    near.dispose()
  })

  it('hands the renderer back when the draw THROWS — xr, target, autoClear, autoReset', () => {
    const w = world()
    const r = stubRenderer()
    const near = createCockpitSelfShadow(
      r,
      w.sun,
      createEditionState(anniversary, HIGH),
      () => null,
    )
    near.attach(w.flight)
    r.throwOnRender = true
    expect(() => near.update()).toThrow('context lost')
    expect(r.xr.enabled, 'a headset frame through a flat camera, otherwise').toBe(true)
    expect(r.getRenderTarget()).toBe(null)
    expect(r.autoClear).toBe(true)
    expect(r.shadowMap.autoUpdate).toBe(true)
    expect(r.info.autoReset).toBe(true)
    near.dispose()
  })

  it('draws nothing while the shell is not on screen, and nothing at quality low', () => {
    const w = world()
    const r = stubRenderer()
    const state = createEditionState(anniversary, HIGH)
    const near = createCockpitSelfShadow(r, w.sun, state, () => null)
    near.attach(w.flight)
    const renders = () => r.log.filter((l) => l.startsWith('render:')).length
    w.shell.visible = false // third person
    near.update()
    expect(renders()).toBe(0)
    w.shell.visible = true
    w.scene.remove(w.flight) // a torn-down world
    near.update()
    expect(renders()).toBe(0)
    w.scene.add(w.flight)
    state.setSettings(LOW)
    expect(near.report.on).toBe(false)
    expect(
      (w.material.defines as Record<string, unknown>)[NEAR_DEFINE],
      'the term compiles out',
    ).toBe(0)
    near.update()
    expect(renders()).toBe(0)
    state.setSettings(HIGH)
    near.update()
    expect(renders()).toBe(1)
    near.dispose()
  })

  it('patches nothing on a flight with no shell — the JumpSeat', () => {
    const r = stubRenderer()
    const sun = new THREE.DirectionalLight()
    const near = createCockpitSelfShadow(r, sun, createEditionState(anniversary, HIGH), () => null)
    near.attach(new THREE.Group())
    near.update()
    expect(near.report).toMatchObject({ on: false, patched: 0, mapSize: 0 })
    expect(r.log).toEqual([])
    near.dispose()
  })
})

// ── 7. the presets, and the Advanced page ────────────────────────────────

describe('§7 the presets, and why there is no eighth Advanced row', () => {
  it('Anniversary on, Classic off, `?feature=` switchable, and NOT in vr.disable', () => {
    expect(anniversary.render.cockpitSelfShadow.enabled).toBe(true)
    expect(classic.render.cockpitSelfShadow.enabled).toBe(false)
    expect(new Map(editionFeatures(anniversary)).has('render.cockpitSelfShadow')).toBe(true)
    // A claim, not an omission: one depth draw of ~1.2 k triangles and a
    // per-fragment term on the cockpit alone. If a worn capture disagrees,
    // this is the line to change on purpose.
    expect(applyVrOverrides(anniversary).render.cockpitSelfShadow.enabled).toBe(true)
  })

  it('composes the sun map’s gate: off at quality low, off with render.shadows off', () => {
    expect(cockpitSelfShadowEnabled(anniversary, HIGH)).toBe(true)
    expect(cockpitSelfShadowEnabled(anniversary, LOW)).toBe(false)
    const noMap = {
      ...anniversary,
      render: { ...anniversary.render, shadows: { ...anniversary.render.shadows, enabled: false } },
    } as Edition
    expect(cockpitSelfShadowEnabled(noMap, HIGH)).toBe(false)
  })

  it('has no Advanced row — the SHADOWS row already turns it off, for every state it reads', () => {
    expect(ADVANCED_FEATURES.some((f) => f.path === 'render.cockpitSelfShadow')).toBe(false)
    expect(ADVANCED_FEATURES.length, 'seven toggles; the page header says why').toBe(7)
    // The safety of that: wherever the SHADOWS row reads off, so is this.
    const row = ADVANCED_FEATURES.find((f) => f.path === 'render.shadows')
    expect(row?.effective).toBeDefined()
    for (const settings of [HIGH, LOW]) {
      for (const shadowsOn of [true, false]) {
        const e = {
          ...anniversary,
          render: {
            ...anniversary.render,
            shadows: { ...anniversary.render.shadows, enabled: shadowsOn },
          },
        } as Edition
        const shadowsRow = row?.effective?.(e, { settings, presenting: false }) ?? true
        expect(shadowsRow).toBe(shadowsEnabled(e, settings))
        if (!shadowsRow) expect(cockpitSelfShadowEnabled(e, settings)).toBe(false)
      }
    }
  })

  it('refuses a near map that is not a power of two, and a bias with a hole in it', () => {
    const bad = (patch: Record<string, unknown>) =>
      ({
        ...anniversary,
        render: {
          ...anniversary.render,
          cockpitSelfShadow: { ...anniversary.render.cockpitSelfShadow, ...patch },
        },
      }) as Edition
    expect(() => validateEdition(bad({ mapSize: 1500 }))).toThrow(/cockpitSelfShadow.mapSize/)
    expect(() => validateEdition(bad({ bias: Number.NaN }))).toThrow(/cockpitSelfShadow.bias/)
    expect(() => validateEdition(bad({ normalBias: -1 }))).toThrow(/cockpitSelfShadow.normalBias/)
    expect(() => validateEdition(anniversary)).not.toThrow()
  })
})
