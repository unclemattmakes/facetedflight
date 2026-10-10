// DEV-585: the clouds' shadows. render/cloud-shadow.ts has the mechanism.
//
// The oracle here is deliberately NOT the raster's own arithmetic (trap 24): a
// 3D ray cast from the receiver toward the sun against every world-space
// triangle of every cloud hull. The raster projects in 2D and interpolates;
// the oracle intersects in 3D. Where they agree, the projection, the axes, the
// uv and the top channel are all right at once.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@/boot/settings'
import { type Edition, editionFeatures, validateEdition } from '@/content/edition-schema'
import type { CloudPlacement, SunLight } from '@/content/level-schema'
import { loadClouds } from '@/game/clouds'
import { createEditionState } from '@/game/edition'
import type { CloudTuning } from '@/render/cloud-look'
import {
  CLOUD_SHADOW_GLSL,
  CLOUD_SHADOW_MAP_MAX,
  CLOUD_TOP_BIAS,
  type CloudShadowRaster,
  cloudShadowFade,
  cloudShadowUv,
  cloudShadowWeight,
  cloudWorldVertices,
  createCloudShadow,
  createCloudShadowUniforms,
  inCloudShadow,
  NO_CLOUD_SHADOW_DEFINE,
  rasterCloudShadow,
  towardSunOf,
} from '@/render/cloud-shadow'
import { createFarShadow, SUN_HEIGHT_GLSL } from '@/render/far-shadow'
import { FRAGMENT_GATES, GATE_DEFINES } from '@/render/fragment-gates'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'
import int01 from '../../content/levels/int_01_hoverJet.json'
import int02 from '../../content/levels/int_02_hoverJet.json'
import rookie01 from '../../content/levels/rookie_01_hoverJet.json'
import { lcg } from './helpers/seeded'

const ANNIVERSARY = anniversaryJson as unknown as Edition
const CLASSIC = classicJson as unknown as Edition

interface LevelLike {
  readonly clouds: CloudPlacement[]
  readonly lighting: { readonly sun: SunLight }
}
const INT01 = int01 as unknown as LevelLike
const INT02 = int02 as unknown as LevelLike
const ROOKIE01 = rookie01 as unknown as LevelLike

/**
 * The oracle: does the ray from `p` toward the sun hit a cloud, and how high
 * is the highest hit? Moller-Trumbore against every world triangle, t > 0.
 */
const rayHits = (
  world: readonly Float64Array[],
  p: readonly [number, number, number],
  l: readonly [number, number, number],
): number | null => {
  let best: number | null = null
  for (const w of world) {
    for (let i = 0; i + 8 < w.length; i += 9) {
      const ax = w[i] as number
      const ay = w[i + 1] as number
      const az = w[i + 2] as number
      const e1x = (w[i + 3] as number) - ax
      const e1y = (w[i + 4] as number) - ay
      const e1z = (w[i + 5] as number) - az
      const e2x = (w[i + 6] as number) - ax
      const e2y = (w[i + 7] as number) - ay
      const e2z = (w[i + 8] as number) - az
      const px = l[1] * e2z - l[2] * e2y
      const py = l[2] * e2x - l[0] * e2z
      const pz = l[0] * e2y - l[1] * e2x
      const det = e1x * px + e1y * py + e1z * pz
      if (Math.abs(det) < 1e-12) continue
      const inv = 1 / det
      const tx = p[0] - ax
      const ty = p[1] - ay
      const tz = p[2] - az
      const u = (tx * px + ty * py + tz * pz) * inv
      if (u < 0 || u > 1) continue
      const qx = ty * e1z - tz * e1y
      const qy = tz * e1x - tx * e1z
      const qz = tx * e1y - ty * e1x
      const v = (l[0] * qx + l[1] * qy + l[2] * qz) * inv
      if (v < 0 || u + v > 1) continue
      const t = (e2x * qx + e2y * qy + e2z * qz) * inv
      if (t <= 0) continue
      const y = p[1] + t * l[1]
      if (best === null || y > best) best = y
    }
  }
  return best
}

/** A world point whose projection is uniformly inside the raster, at a height in [0, 2200]. */
const samplePoint = (r: CloudShadowRaster, rand: () => number): [number, number, number] => {
  const u = r.u0 + rand() * r.width * r.texelU
  const v = r.v0 + rand() * r.height * r.texelV
  const y = rand() * 2200
  const qx = u * r.dirU[0] + v * r.dirV[0]
  const qz = u * r.dirU[1] + v * r.dirV[1]
  return [qx + y * r.k[0], y, qz + y * r.k[1]]
}

/** The live clouds of a level, under a preset: the API the shadow reads. */
const cloudsOf = (
  level: LevelLike,
  edition: Edition | null,
  pool?: { readonly poolSize: number; readonly tintSpread: number },
) => {
  const clouds = loadClouds(level.clouds, { sun: level.lighting.sun, ...(pool ? { pool } : {}) })
  clouds.setCloudLook(
    edition?.render.clouds.enabled ? (edition.render.clouds as unknown as CloudTuning) : null,
  )
  return clouds
}

/**
 * Agreement between the raster's verdict and the 3D oracle, on points away
 * from the shadow's edges (the verdict 1.5 texels either way agrees with
 * itself), plus how many of them were in shadow: a pass on all-lit samples
 * would prove nothing.
 */
const agreement = (
  level: LevelLike,
  edition: Edition | null,
  drift: readonly [number, number, number] = [0, 0, 0],
  samples = 500,
  pool?: { readonly poolSize: number; readonly tintSpread: number },
) => {
  const clouds = cloudsOf(level, edition, pool)
  const l = towardSunOf(level.lighting.sun)
  if (!l) throw new Error('no sun')
  const r = rasterCloudShadow(clouds.hulls, clouds.placementInForce, l)
  if (!r) throw new Error('no raster')
  const world = cloudWorldVertices(clouds.hulls, clouds.placementInForce).map((w) => {
    const out = new Float64Array(w.length)
    for (let i = 0; i < w.length; i += 3) {
      out[i] = (w[i] as number) + drift[0]
      out[i + 1] = (w[i + 1] as number) + drift[1]
      out[i + 2] = (w[i + 2] as number) + drift[2]
    }
    return out
  })
  const rand = lcg(585)
  let tested = 0
  let agree = 0
  let shaded = 0
  const step = 1.5 * Math.max(r.texelU, r.texelV)
  for (let n = 0; n < samples * 4 && tested < samples; n++) {
    const base = samplePoint(r, rand)
    const p: [number, number, number] = [base[0] + drift[0], base[1] + drift[1], base[2] + drift[2]]
    const verdict = inCloudShadow(r, p, drift)
    // Away from edges: the neighbours across the sun agree.
    const across: [number, number, number] = [r.dirV[0] * step, 0, r.dirV[1] * step]
    const along: [number, number, number] = [r.dirU[0] * step, 0, r.dirU[1] * step]
    const near = [
      [p[0] + across[0], p[1], p[2] + across[2]],
      [p[0] - across[0], p[1], p[2] - across[2]],
      [p[0] + along[0], p[1], p[2] + along[2]],
      [p[0] - along[0], p[1], p[2] - along[2]],
      [p[0], p[1] + 3 * CLOUD_TOP_BIAS, p[2]],
      [p[0], p[1] - 3 * CLOUD_TOP_BIAS, p[2]],
    ] as [number, number, number][]
    if (near.some((q) => inCloudShadow(r, q, drift) !== verdict)) continue
    tested++
    const top = rayHits(world, p, l)
    const truth = top !== null
    if (truth === verdict) agree++
    if (truth) shaded++
  }
  return { tested, agree, shaded, raster: r }
}

describe('the numbers somebody edits on purpose', () => {
  it('pins the map cap and both presets in one place', () => {
    expect(CLOUD_SHADOW_MAP_MAX).toBe(1024)
    const a = ANNIVERSARY.render.cloudShadow
    const c = CLASSIC.render.cloudShadow
    expect({ ...a, note: undefined }).toEqual({
      enabled: true,
      strength: 0.8,
      minSunElevation: 1.5,
      note: undefined,
    })
    // Classic is off twice over (Matt, 2026-10-03: "Classic no").
    expect(c.enabled).toBe(false)
    expect(c.strength).toBe(0)
  })

  it('is a registered feature, so vr.disable and ?feature= can name it', () => {
    const paths = editionFeatures(ANNIVERSARY).map(([p]) => p)
    expect(paths).toContain('render.cloudShadow')
  })

  it('refuses a strength outside 0..1 and a NaN elevation', () => {
    const bad = (cs: object) =>
      ({
        ...ANNIVERSARY,
        render: {
          ...ANNIVERSARY.render,
          cloudShadow: { ...ANNIVERSARY.render.cloudShadow, ...cs },
        },
      }) as Edition
    expect(() => validateEdition(bad({ strength: 1.2 }))).toThrow(/cloudShadow.strength/)
    expect(() => validateEdition(bad({ minSunElevation: Number.NaN }))).toThrow(
      /cloudShadow.minSunElevation/,
    )
    expect(() => validateEdition(ANNIVERSARY)).not.toThrow()
  })
})

describe('the headset (Matt, 2026-10-03: "We should have clouds and their shadows in vr")', () => {
  it('neither the clouds nor their shadows are in vr.disable', () => {
    expect(ANNIVERSARY.vr?.disable).not.toContain('render.clouds')
    expect(ANNIVERSARY.vr?.disable).not.toContain('render.cloudShadow')
  })

  it('presenting leaves both on', () => {
    const s = createEditionState(ANNIVERSARY, DEFAULT_SETTINGS)
    s.setImmersive(true)
    expect(s.current.render.clouds.enabled).toBe(true)
    expect(s.current.render.cloudShadow.enabled).toBe(true)
  })
})

describe('the sun', () => {
  it('fades out toward the horizon: int_02_hoverJet none, int_01 and rookie_01 full', () => {
    const a = ANNIVERSARY.render.cloudShadow
    const w = (level: LevelLike) => cloudShadowWeight(a, towardSunOf(level.lighting.sun))
    expect(w(INT02)).toBe(0)
    expect(w(INT01)).toBeCloseTo(0.8, 6)
    expect(w(ROOKIE01)).toBeCloseTo(0.8, 6)
    // The curve itself: off at the minimum, full at twice it, monotone between.
    const sinOf = (deg: number) => Math.sin((deg * Math.PI) / 180)
    expect(cloudShadowFade(sinOf(1.5), 1.5)).toBe(0)
    expect(cloudShadowFade(sinOf(3), 1.5)).toBe(1)
    expect(cloudShadowFade(sinOf(2.25), 1.5)).toBeCloseTo(0.5, 6)
    expect(cloudShadowFade(-0.1, 1.5)).toBe(0)
  })

  it('is null for no sun or a sun below the horizon', () => {
    expect(towardSunOf(null)).toBeNull()
    expect(towardSunOf({ direction: [0, 1, 0] })).toBeNull()
    expect(towardSunOf({ direction: [0, -2, 0] })).toEqual([-0, 1, -0])
  })
})

describe('the projection agrees with a 3D ray cast through the same hulls', () => {
  it("int_01_hoverJet, Anniversary's lifted clouds, the 4-degree sun", () => {
    const { tested, agree, shaded, raster } = agreement(INT01, ANNIVERSARY)
    expect(tested).toBeGreaterThan(300)
    expect(shaded, 'some samples are in shadow').toBeGreaterThan(30)
    expect(agree / tested).toBeGreaterThan(0.99)
    // The map is long along the sun and narrow across it, as the header says.
    expect(raster.width * raster.texelU).toBeGreaterThan(3 * raster.height * raster.texelV)
  })

  it("rookie_01_hoverJet, the 46.5-degree sun, Classic's placements", () => {
    const { tested, agree, shaded } = agreement(ROOKIE01, null)
    expect(tested).toBeGreaterThan(300)
    expect(shaded).toBeGreaterThan(30)
    expect(agree / tested).toBeGreaterThan(0.99)
  })

  it('under a wind with a vertical part, the offset uniform is the whole of the drift', () => {
    const { tested, agree, shaded } = agreement(INT01, ANNIVERSARY, [430, 25, -310])
    expect(tested).toBeGreaterThan(300)
    expect(shaded).toBeGreaterThan(30)
    expect(agree / tested).toBeGreaterThan(0.99)
  })

  it('the shared pool (DEV-785): int_01 under the wind, the raster still agrees with the hulls', () => {
    // The raster reads one hull per PLACEMENT, and seven of int_01's nineteen now
    // read a pool member's blob. The oracle is the same ray march through the
    // same placements' hulls, so a field that fed the shadow the wrong blob or
    // the wrong matrix would disagree here.
    const { tested, agree, shaded } = agreement(INT01, ANNIVERSARY, [430, 25, -310], 500, {
      poolSize: 12,
      tintSpread: 0.08,
    })
    expect(tested).toBeGreaterThan(300)
    expect(shaded).toBeGreaterThan(30)
    expect(agree / tested).toBeGreaterThan(0.99)
  })

  it('a receiver ABOVE a cloud is lit, though it projects onto the cloud', () => {
    const clouds = cloudsOf(ROOKIE01, ANNIVERSARY)
    const l = towardSunOf(ROOKIE01.lighting.sun) as [number, number, number]
    const r = rasterCloudShadow(clouds.hulls, clouds.placementInForce, l) as CloudShadowRaster
    const world = cloudWorldVertices(clouds.hulls, clouds.placementInForce)
    // The highest vertex of the first cloud, and a point 50 m straight above it
    // and one 50 m below the cloud's lowest vertex on the same sun ray.
    const w = world[0] as Float64Array
    let hi = 0
    let lo = 0
    for (let i = 3; i < w.length; i += 3) {
      if ((w[i + 1] as number) > (w[hi + 1] as number)) hi = i
      if ((w[i + 1] as number) < (w[lo + 1] as number)) lo = i
    }
    const centre: [number, number, number] = [
      ((w[hi] as number) + (w[lo] as number)) / 2,
      ((w[hi + 1] as number) + (w[lo + 1] as number)) / 2,
      ((w[hi + 2] as number) + (w[lo + 2] as number)) / 2,
    ]
    const above: [number, number, number] = [centre[0], (w[hi + 1] as number) + 50, centre[2]]
    const below: [number, number, number] = [
      centre[0] - l[0] * 400,
      centre[1] - l[1] * 400,
      centre[2] - l[2] * 400,
    ]
    expect(rayHits(world, below, l), 'the oracle: below is under it').not.toBeNull()
    expect(inCloudShadow(r, below)).toBe(true)
    expect(rayHits(world, above, l), 'the oracle: above is clear').toBeNull()
    expect(inCloudShadow(r, above)).toBe(false)
  })

  it('the drift is a translation: a moved receiver under a moved sky reads the same texel', () => {
    const clouds = cloudsOf(INT01, ANNIVERSARY)
    const l = towardSunOf(INT01.lighting.sun) as [number, number, number]
    const r = rasterCloudShadow(clouds.hulls, clouds.placementInForce, l) as CloudShadowRaster
    const d: [number, number, number] = [120, 7, -40]
    const rand = lcg(7)
    for (let n = 0; n < 50; n++) {
      const p = samplePoint(r, rand)
      const a = cloudShadowUv(r, p)
      const b = cloudShadowUv(r, [p[0] + d[0], p[1] + d[1], p[2] + d[2]], d)
      expect(b[0]).toBeCloseTo(a[0], 9)
      expect(b[1]).toBeCloseTo(a[1], 9)
    }
  })
})

describe('the shader', () => {
  const body = (src: string, name: string): string => {
    const at = src.indexOf(`float ${name}()`)
    const open = src.indexOf('{', at)
    let depth = 0
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++
      if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1)
    }
    throw new Error(`no body for ${name}`)
  }

  it('rides in far-shadow, declared before the sun term that calls it', () => {
    expect(SUN_HEIGHT_GLSL).toContain(CLOUD_SHADOW_GLSL)
    expect(SUN_HEIGHT_GLSL.indexOf('varying vec3 vFf2SunWorld;')).toBeLessThan(
      SUN_HEIGHT_GLSL.indexOf('float ff2CloudShadowTerm()'),
    )
    expect(SUN_HEIGHT_GLSL.indexOf('float ff2CloudShadowTerm()')).toBeLessThan(
      SUN_HEIGHT_GLSL.indexOf('float ff2SunHeightTerm()'),
    )
  })

  it('every exit of the sun term takes the clouds: no bare return 1.0 is left', () => {
    const sun = body(SUN_HEIGHT_GLSL, 'ff2SunHeightTerm')
    // Asked first, above every branch and every other fetch.
    const call = sun.indexOf('float ff2Cloud = ff2CloudShadowTerm();')
    expect(call).toBeGreaterThan(-1)
    expect(call).toBeLessThan(sun.indexOf('#ifdef FF2_NO_SUN_HEIGHT'))
    expect(call).toBeLessThan(sun.indexOf('texture2D('))
    expect(call).toBeLessThan(sun.indexOf('if ('))
    const returns = sun.match(/return [^;]*;/g) ?? []
    expect(returns.length).toBeGreaterThan(4)
    for (const r of returns) expect(r, r).toContain('ff2Cloud')
  })

  it('its own fetch and derivatives come before its only branch', () => {
    const cloud = body(CLOUD_SHADOW_GLSL, 'ff2CloudShadowTerm')
    const branch = cloud.indexOf('if (')
    expect(branch).toBeGreaterThan(-1)
    expect(cloud.indexOf('texture2D(')).toBeLessThan(branch)
    expect(cloud.lastIndexOf('fwidth(')).toBeLessThan(branch)
    expect(cloud.split('texture2D(').length - 1, 'one fetch').toBe(1)
  })

  it('declares every uFf2Cloud name it uses, and the vertex half needs none', () => {
    const used = new Set(CLOUD_SHADOW_GLSL.match(/uFf2Cloud\w*/g) ?? [])
    for (const name of used) {
      expect(CLOUD_SHADOW_GLSL, name).toMatch(new RegExp(`uniform \\w+ ${name};`))
    }
    expect(Object.keys(createCloudShadowUniforms()).sort()).toEqual([...used].sort())
  })

  it('reaches a patched program with its uniforms bound', () => {
    const s = createEditionState(ANNIVERSARY, DEFAULT_SETTINGS)
    const cloud = createCloudShadow(s)
    const far = createFarShadow(s, cloud.uniforms)
    const m = new THREE.MeshStandardMaterial()
    far.applyTo(m)
    const shader = {
      uniforms: {} as Record<string, THREE.IUniform>,
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    }
    m.onBeforeCompile(
      shader as unknown as THREE.WebGLProgramParametersWithUniforms,
      {} as THREE.WebGLRenderer,
    )
    expect(shader.fragmentShader).toContain('ff2CloudShadowTerm()')
    expect(shader.uniforms.uFf2CloudMap).toBe(cloud.uniforms.uFf2CloudMap)
    expect(shader.uniforms.uFf2CloudC).toBe(cloud.uniforms.uFf2CloudC)
    far.dispose()
    cloud.dispose()
  })
})

describe('the live system', () => {
  it('on Anniversary: built from the live placements, on, and the clouds do not receive', () => {
    const s = createEditionState(ANNIVERSARY, DEFAULT_SETTINGS)
    const shadow = createCloudShadow(s)
    const clouds = loadClouds(INT01.clouds, { edition: s, sun: INT01.lighting.sun })
    shadow.setClouds(clouds, INT01.lighting.sun)
    const r = shadow.report
    expect(r.on).toBe(true)
    expect(r.weight).toBeCloseTo(0.8, 6)
    expect(r.clouds).toBe(19)
    expect(r.texels?.[0]).toBeLessThanOrEqual(CLOUD_SHADOW_MAP_MAX)
    expect(shadow.uniforms.uFf2CloudC.value.z).toBeCloseTo(0.8, 6)
    const material = (clouds.group.children[0] as THREE.Mesh).material as THREE.Material
    expect(material.defines?.[NO_CLOUD_SHADOW_DEFINE]).toBe('')
    // The wind: the clouds move, the uniform follows, and the map is not redrawn.
    const map = shadow.uniforms.uFf2CloudMap.value
    clouds.update(100)
    clouds.update(160)
    shadow.update()
    const d = clouds.driftInForce
    expect(Math.hypot(d[0], d[2])).toBeCloseTo(3.5 * 60, 6)
    expect(shadow.uniforms.uFf2CloudA.value.z).not.toBe(0)
    expect(shadow.uniforms.uFf2CloudMap.value).toBe(map)
    // Hidden clouds (the editor's top view) cast nothing.
    clouds.group.visible = false
    shadow.update()
    expect(shadow.uniforms.uFf2CloudC.value.z).toBe(0)
    shadow.setClouds(null, null)
    expect(shadow.report.on).toBe(false)
    clouds.dispose()
    shadow.dispose()
  })

  it('a flip to Classic turns it off, and the map follows the placements actually drawn', () => {
    const s = createEditionState(ANNIVERSARY, DEFAULT_SETTINGS)
    const shadow = createCloudShadow(s)
    const clouds = loadClouds(INT01.clouds, { edition: s, sun: INT01.lighting.sun })
    shadow.setClouds(clouds, INT01.lighting.sun)
    const lifted = shadow.uniforms.uFf2CloudMap.value
    s.setLook(CLASSIC)
    shadow.update()
    expect(shadow.uniforms.uFf2CloudC.value.z).toBe(0)
    // Back: the lifted placements are the ones the map was built for, so no rebuild.
    // Identity compared as a boolean: a failed or negated toBe deep-compares two 1M-texel arrays.
    s.setLook(ANNIVERSARY)
    shadow.update()
    expect(shadow.uniforms.uFf2CloudC.value.z).toBeCloseTo(0.8, 6)
    expect(clouds.placementInForce.altitudeLift).toBe(250)
    expect(shadow.uniforms.uFf2CloudMap.value === lifted, 'kept').toBe(true)
    // The Anniversary look switched off under a live shadow (a ?feature= pin):
    // 2016's placements are drawn, so the map is rebuilt for them.
    s.setFeatureOverrides({ 'render.clouds': false })
    shadow.update()
    expect(clouds.placementInForce.altitudeLift).toBe(0)
    expect(shadow.uniforms.uFf2CloudC.value.z).toBeCloseTo(0.8, 6)
    expect(shadow.uniforms.uFf2CloudMap.value === lifted, 'rebuilt').toBe(false)
    clouds.dispose()
    shadow.dispose()
  })

  it('Classic never rasterises, and int_02_hoverJet at 0.08 degrees never does either', () => {
    const classic = createEditionState(CLASSIC, DEFAULT_SETTINGS)
    const a = createCloudShadow(classic)
    const c1 = loadClouds(INT01.clouds, { edition: classic, sun: INT01.lighting.sun })
    a.setClouds(c1, INT01.lighting.sun)
    expect(a.report.texels).toBeNull()
    expect(a.report.on).toBe(false)
    const anniversary = createEditionState(ANNIVERSARY, DEFAULT_SETTINGS)
    const b = createCloudShadow(anniversary)
    const c2 = loadClouds(INT02.clouds, { edition: anniversary, sun: INT02.lighting.sun })
    b.setClouds(c2, INT02.lighting.sun)
    expect(b.report.texels).toBeNull()
    expect(b.report.weight).toBe(0)
    for (const x of [c1, c2]) x.dispose()
    a.dispose()
    b.dispose()
  })
})

describe('the measurement arm', () => {
  it('is the same define the clouds opt out with, and it returns before the fetch', () => {
    expect(GATE_DEFINES.noCloudShadow).toBe(NO_CLOUD_SHADOW_DEFINE)
    expect(FRAGMENT_GATES).toContain('noCloudShadow')
    const guard = CLOUD_SHADOW_GLSL.indexOf(`#ifdef ${NO_CLOUD_SHADOW_DEFINE}`)
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(CLOUD_SHADOW_GLSL.indexOf('texture2D('))
  })
})
