// DEV-582: the near cascade. render/near-shadow.ts has the mechanism.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@/boot/settings'
import { type Edition, editionFeatures, validateEdition } from '@/content/edition-schema'
import { createEditionState } from '@/game/edition'
import type { NearShadowRenderer } from '@/render/cockpit-self-shadow'
import { nearShadowPatchFragment } from '@/render/cockpit-self-shadow'
import { sunHeightPatchFragment, sunHeightPatchVertex } from '@/render/far-shadow'
import {
  createNearShadow,
  fitNearCascade,
  MAIN_BIAS_TOKEN,
  NEAR_CASTER_LAYER,
  NEAR_LOOP_LINES,
  NEAR_VERTEX_ANCHOR,
  nearDepthBelow,
  nearEdgeFadeUv,
  nearMainSkip,
  nearReach,
  nearShadowEnabled,
  syncNearCasters,
} from '@/render/near-shadow'
import { fitSunShadow } from '@/render/shadows'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'

const ANNIVERSARY = anniversaryJson as unknown as Edition
const CLASSIC = classicJson as unknown as Edition

describe('the numbers somebody edits on purpose', () => {
  it("pins Anniversary's block, and Classic is off", () => {
    const { note: _n, ...a } = ANNIVERSARY.render.nearShadow
    expect(a).toEqual({
      enabled: true,
      mapSize: 2048,
      boxHalfSize: 80,
      edgeFade: 20,
      bias: 0.06,
      normalBias: 0.05,
      radius: 2,
    })
    expect(CLASSIC.render.nearShadow.enabled).toBe(false)
    // The texel the row argues for: 0.078 m, 8.7x the sun map's 0.68.
    expect((2 * a.boxHalfSize) / a.mapSize).toBeCloseTo(0.078, 3)
  })

  it('is a registered feature and IS in vr.disable until a worn capture exists', () => {
    expect(editionFeatures(ANNIVERSARY).map(([p]) => p)).toContain('render.nearShadow')
    expect(ANNIVERSARY.vr?.disable).toContain('render.nearShadow')
  })

  it('refuses a mapSize that is not a power of two and an edge band as wide as the box', () => {
    const bad = (ns: object) =>
      ({
        ...ANNIVERSARY,
        render: { ...ANNIVERSARY.render, nearShadow: { ...ANNIVERSARY.render.nearShadow, ...ns } },
      }) as Edition
    expect(() => validateEdition(bad({ mapSize: 2000 }))).toThrow(/nearShadow.mapSize/)
    expect(() => validateEdition(bad({ edgeFade: 80 }))).toThrow(/nearShadow.edgeFade/)
    expect(() => validateEdition(bad({ bias: -1 }))).toThrow(/nearShadow.bias/)
    expect(() => validateEdition(ANNIVERSARY)).not.toThrow()
  })
})

describe('when it runs', () => {
  it('flat Anniversary yes; quality low, Classic and a headset no', () => {
    expect(nearShadowEnabled(ANNIVERSARY, DEFAULT_SETTINGS)).toBe(true)
    expect(nearShadowEnabled(ANNIVERSARY, { ...DEFAULT_SETTINGS, quality: 'low' })).toBe(false)
    expect(nearShadowEnabled(CLASSIC, DEFAULT_SETTINGS)).toBe(false)
    const s = createEditionState(ANNIVERSARY, DEFAULT_SETTINGS)
    s.setImmersive(true)
    expect(nearShadowEnabled(s.current, s.settings)).toBe(false)
  })
})

describe('the box', () => {
  const spec = ANNIVERSARY.render.nearShadow
  const sunPos: [number, number, number] = [9000, 700, 2500]
  const sunTarget: [number, number, number] = [0, 0, 0]

  it('is the sun map fit at 80 m, two box widths up-sun and four on down-sun', () => {
    const fit = fitNearCascade(spec, [120.3, 40.7, -88.1], sunPos, sunTarget)
    expect(fit.right - fit.left).toBeCloseTo(160, 9)
    expect(fit.top - fit.bottom).toBeCloseTo(160, 9)
    expect(fit.texelSize).toBeCloseTo(160 / 2048, 12)
    expect(nearReach(80)).toBe(160)
    expect(nearDepthBelow(80)).toBe(320)
    expect(fit.far - fit.near).toBeCloseTo(160 + 160 + 320, 9)
    // Snapped: within half a texel of the eye on both lateral axes, so it holds
    // the eye and the grid stays put in the world.
    const d = Math.hypot(fit.centre[0] - 120.3, fit.centre[1] - 40.7, fit.centre[2] + 88.1)
    expect(d).toBeLessThan(fit.texelSize)
  })

  it('the skip is the reach in the SUN map depth, measured against a real sun fit', () => {
    const shadows = ANNIVERSARY.render.shadows
    const main = fitSunShadow({
      centre: [0, 0, 0],
      lightPosition: sunPos,
      lightTarget: sunTarget,
      boxHalfSize: shadows.boxHalfSize,
      mapSize: shadows.mapSize,
      castDistance: shadows.castDistance,
    })
    const skip = nearMainSkip(spec, main)
    // Back to metres: the skip times the sun map's range is the near reach.
    expect(skip * (main.far - main.near)).toBeCloseTo(nearReach(spec.boxHalfSize), 6)
    expect(nearMainSkip(spec, null)).toBe(0)
  })

  it('the edge band is the near box share of its own extents', () => {
    const band = nearEdgeFadeUv(spec)
    expect(band.lateral).toBeCloseTo(20 / 160, 12)
    expect(band.depth).toBeCloseTo(20 / 640, 12)
  })
})

describe('the shader', () => {
  const vertex = sunHeightPatchVertex(THREE.ShaderLib.physical.vertexShader)
  const fragment = sunHeightPatchFragment(THREE.ShaderLib.physical.fragmentShader)

  it('the vertex half declares what it uses and writes it after three makes its own coordinate', () => {
    expect(vertex).toContain('uniform mat4 uFf2NearMatrix;')
    expect(vertex).toContain('uniform float uFf2NearNormalBias;')
    expect(vertex).toContain('varying vec4 vFf2Near;')
    const anchor = vertex.indexOf(NEAR_VERTEX_ANCHOR)
    const write = vertex.indexOf('vFf2Near = uFf2NearMatrix')
    expect(anchor).toBeGreaterThan(-1)
    expect(write).toBeGreaterThan(anchor)
  })

  it('the near lines come before the statement and never name the sun map bias', () => {
    expect(NEAR_LOOP_LINES).not.toContain(MAIN_BIAS_TOKEN)
    expect(NEAR_LOOP_LINES).not.toMatch(/[{}]/)
    expect(NEAR_LOOP_LINES).toContain('!defined( FF2_COCKPIT_NEAR )')
    expect(fragment.indexOf('ff2NearShade = ( ff2NearCover')).toBeLessThan(
      fragment.indexOf('directLight.color *= min( min('),
    )
    // Exactly once: the cockpit patch finds this token and rewrites its statement.
    expect(fragment.split(MAIN_BIAS_TOKEN).length - 1).toBe(1)
  })

  it("composes with the cockpit's patch: one statement, both skips, the shell opted out", () => {
    const both = nearShadowPatchFragment(fragment)
    expect(both).toContain(
      '( ( directionalLightShadow.shadowBias - FF2_COCKPIT_MAIN_SKIP ) - FF2_NEAR_SKIP )',
    )
    expect(both).toContain('ff2SunHeightTerm() );')
  })

  it('declares every uFf2Near name the fragment half uses', () => {
    const used = new Set(fragment.match(/uFf2Near\w*/g) ?? [])
    for (const name of used) {
      if (name === 'uFf2NearMatrix' || name === 'uFf2NearNormalBias') continue
      expect(fragment, name).toMatch(new RegExp(`uniform \\w+ ${name};`))
    }
    expect([...used].sort()).toEqual(['uFf2NearB', 'uFf2NearC', 'uFf2NearMap'])
  })
})

describe('the casters', () => {
  it('follow castShadow, and a mesh keeps every other layer it had', () => {
    const root = new THREE.Group()
    const casting = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())
    casting.castShadow = true
    const not = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())
    not.layers.enable(3)
    not.layers.enable(NEAR_CASTER_LAYER)
    root.add(casting, not)
    expect(syncNearCasters(root)).toBe(1)
    expect(casting.layers.isEnabled(NEAR_CASTER_LAYER)).toBe(true)
    expect(casting.layers.isEnabled(0)).toBe(true)
    expect(not.layers.isEnabled(NEAR_CASTER_LAYER)).toBe(false)
    expect(not.layers.isEnabled(3)).toBe(true)
  })

  it('is not an XR eye layer, the UI layer or the logo layer', () => {
    expect([1, 2, 3, 23]).not.toContain(NEAR_CASTER_LAYER)
  })
})

interface Stub extends NearShadowRenderer {
  readonly log: string[]
}

const stubRenderer = (): Stub => {
  let target: THREE.WebGLRenderTarget | null = null
  const log: string[] = []
  return {
    log,
    autoClear: true,
    xr: { enabled: true },
    shadowMap: { autoUpdate: true },
    state: { buffers: { depth: { setMask: () => {} } } },
    info: { autoReset: true, render: { calls: 10, triangles: 100 } },
    getRenderTarget: () => target,
    setRenderTarget: (t) => {
      target = t
    },
    clear: () => {},
    render: (scene, camera) => {
      const s = scene as THREE.Scene
      log.push(
        `render:${s.overrideMaterial ? 'override' : 'none'}:${s.background ? 'bg' : 'nobg'}:${camera.layers.mask === 1 << NEAR_CASTER_LAYER}`,
      )
    },
  }
}

const sunLight = (): THREE.DirectionalLight => {
  const sun = new THREE.DirectionalLight()
  sun.position.set(9000, 700, 2500)
  sun.target.position.set(0, 0, 0)
  return sun
}

describe('the live system', () => {
  it('draws the real scene through the caster layer, with the background and override handed back', () => {
    const state = createEditionState(ANNIVERSARY, DEFAULT_SETTINGS)
    const r = stubRenderer()
    const near = createNearShadow(r, sunLight(), state, () => null)
    // Built with its two depth programs warmed.
    // (The warm draw uses the depth material directly, on a two-mesh scene of its own.)
    expect(r.log).toEqual(['render:none:nobg:true'])
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(1, 0, 0)
    const caster = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial())
    caster.castShadow = true
    scene.add(caster)
    const camera = new THREE.PerspectiveCamera()
    camera.position.set(10, 20, 30)
    near.update(scene, camera)
    expect(r.log.at(-1)).toBe('render:override:nobg:true')
    expect(scene.background).toBeInstanceOf(THREE.Color)
    expect(scene.overrideMaterial).toBeNull()
    expect(near.uniforms.uFf2NearC.value.y).toBe(1)
    expect(near.uniforms.uFf2NearMap.value).toBeInstanceOf(THREE.DepthTexture)
    expect(near.uniforms.uFf2NearMatrix.value.equals(new THREE.Matrix4())).toBe(false)
    expect(near.uniforms.uFf2NearB.value.z, 'bias toward the light').toBeLessThan(0)
    expect(near.report.casters).toBe(1)
    expect(near.report.passes).toBe(1)
    // The renderer is handed back.
    expect(r.xr.enabled).toBe(true)
    expect(r.autoClear).toBe(true)
    expect(r.shadowMap.autoUpdate).toBe(true)
    near.dispose()
  })

  it('the hull shadow 100 m below the eye at 46.5 degrees is deep inside the box', () => {
    // The first build's failure, as a test: a cube round the eye left this
    // receiver in the fade band. Sun 46.5 degrees up, ground point straight
    // down the light from the eye at 100 m of altitude.
    const state = createEditionState(ANNIVERSARY, DEFAULT_SETTINGS)
    const sun = new THREE.DirectionalLight()
    const el = (46.5 * Math.PI) / 180
    // Exactly 46.5 degrees up, from the north-east.
    sun.position.set(Math.cos(el) * Math.SQRT1_2, Math.sin(el), Math.cos(el) * Math.SQRT1_2)
    sun.position.multiplyScalar(10000)
    sun.target.position.set(0, 0, 0)
    const near = createNearShadow(stubRenderer(), sun, state, () => null)
    const camera = new THREE.PerspectiveCamera()
    camera.position.set(100, 300, -50)
    near.update(new THREE.Scene(), camera)
    const toSun = sun.position.clone().sub(sun.target.position).normalize()
    expect((Math.asin(toSun.y) * 180) / Math.PI).toBeCloseTo(46.5, 6)
    const foot = camera.position.clone().addScaledVector(toSun, -100 / toSun.y)
    const c = new THREE.Vector4(foot.x, foot.y, foot.z, 1).applyMatrix4(
      near.uniforms.uFf2NearMatrix.value,
    )
    const band = nearEdgeFadeUv(ANNIVERSARY.render.nearShadow)
    expect(Math.abs(c.x / c.w - 0.5)).toBeLessThan(0.01)
    expect(Math.abs(c.y / c.w - 0.5)).toBeLessThan(0.01)
    expect(1 - c.z / c.w, 'clear of the far face and its band').toBeGreaterThan(band.depth)
    near.dispose()
  })

  it('the coordinate it hands the shader lands the eye inside the map', () => {
    const state = createEditionState(ANNIVERSARY, DEFAULT_SETTINGS)
    const near = createNearShadow(stubRenderer(), sunLight(), state, () => null)
    const camera = new THREE.PerspectiveCamera()
    camera.position.set(-412.5, 63.2, 1290.8)
    near.update(new THREE.Scene(), camera)
    const c = new THREE.Vector4(-412.5, 63.2, 1290.8, 1).applyMatrix4(
      near.uniforms.uFf2NearMatrix.value,
    )
    expect(c.x / c.w).toBeGreaterThan(0.45)
    expect(c.x / c.w).toBeLessThan(0.55)
    expect(c.y / c.w).toBeGreaterThan(0.45)
    expect(c.y / c.w).toBeLessThan(0.55)
    // Depth: the reach and half a box in front of it, of 640 m in all.
    expect(c.z / c.w).toBeCloseTo(240 / 640, 2)
    near.dispose()
  })

  it('Classic and a headset draw nothing and switch the term off', () => {
    const classic = createEditionState(CLASSIC, DEFAULT_SETTINGS)
    const r1 = stubRenderer()
    const a = createNearShadow(r1, sunLight(), classic, () => null)
    a.update(new THREE.Scene(), new THREE.PerspectiveCamera())
    expect(r1.log).toEqual([])
    expect(a.uniforms.uFf2NearC.value.y).toBe(0)
    expect(a.uniforms.uFf2NearMap.value).toBeNull()

    const worn = createEditionState(ANNIVERSARY, DEFAULT_SETTINGS)
    const r2 = stubRenderer()
    const b = createNearShadow(r2, sunLight(), worn, () => null)
    worn.setImmersive(true)
    const before = r2.log.length
    b.update(new THREE.Scene(), new THREE.PerspectiveCamera())
    expect(r2.log.length).toBe(before)
    expect(b.uniforms.uFf2NearC.value.y).toBe(0)
    a.dispose()
    b.dispose()
  })
})
