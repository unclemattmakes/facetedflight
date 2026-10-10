// tests/unit/sea-reflection.test.ts: the islands in the sea, flat ultra only. DEV-583.
//
// Four properties, each against something outside the code under test:
//
//  1. The gate. Anniversary AND ultra on a monitor, and nothing else; in a
//     headset never, whatever the edition says (DEV-581's `qualityInForce`).
//  2. The camera, by PROJECTION rather than by its rotation (the orientation
//     lesson: a quaternion assertion is a belief written twice). A point the
//     mirror sees lands where the frame sees its reflection, with screen x
//     mirrored, and the oblique near plane IS the water.
//  3. The water's define is ABSENT when the mirror is off, rebuilt in place
//     with the other two (DEV-194), and its GLSL spells 2016's behaviour.
//  4. The 2016 numbers come from the sheet, which says the shipped oceans were
//     `V_LP_REFLECTIVE_REALTIME` with DEV-021's table.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { type ComfortSettings, DEFAULT_SETTINGS } from '@/boot/settings'
import { type Edition, validateEdition } from '@/content/edition-schema'
import { createEditionState } from '@/game/edition'
import { TERRAIN } from '@/generated/constants.generated'
import {
  cockpitOf,
  createSeaReflection,
  type MirrorSea,
  maskForMirror,
  mirrorTargetSize,
  placeMirrorCamera,
  SHIP_EXTERIOR_NAME,
  seaPlaneY,
  seaReflectionFor,
} from '@/render/sea-reflection'
import {
  applyWaterWaves,
  MIRROR_DEFINE,
  MIRROR_FRAGMENT_GLSL,
  MIRROR_VERTEX_GLSL,
} from '@/render/water'
import type { HeightField } from '@/sim/terrain/height-field'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'
import int01 from '../../content/levels/int_01_hoverJet.json'

const ANNIVERSARY = anniversaryJson as unknown as Edition
const CLASSIC = classicJson as unknown as Edition
const ULTRA: ComfortSettings = { ...DEFAULT_SETTINGS, quality: 'ultra', qualityAuto: false }
/** DEV-837 shipped the flag OFF; the gate's own arithmetic is tested with it on. */
const ANNIVERSARY_MIRROR = {
  ...ANNIVERSARY,
  render: {
    ...ANNIVERSARY.render,
    seaReflection: { ...ANNIVERSARY.render.seaReflection, enabled: true },
  },
} as Edition
const HIGH: ComfortSettings = { ...DEFAULT_SETTINGS, quality: 'high', qualityAuto: false }

describe('the gate: Anniversary, ultra, a monitor', () => {
  it('opens only for all three', () => {
    expect(seaReflectionFor(ANNIVERSARY_MIRROR, ULTRA, false)).toBe(
      ANNIVERSARY_MIRROR.render.seaReflection,
    )
    // A headset: ultra resolves to high, so there is no ultra block to ask.
    expect(seaReflectionFor(ANNIVERSARY_MIRROR, ULTRA, true)).toBeNull()
    for (const q of ['low', 'medium', 'high'] as const) {
      expect(
        seaReflectionFor(ANNIVERSARY_MIRROR, { quality: q, qualityAuto: false }, false),
        q,
      ).toBeNull()
    }
    // DEV-837: as shipped, Anniversary's flag is off, so even ultra on a monitor gets none.
    expect(seaReflectionFor(ANNIVERSARY, ULTRA, false)).toBeNull()
    // Classic: "Classic no" (Matt, 2026-10-03).
    expect(seaReflectionFor(CLASSIC, ULTRA, false)).toBeNull()
  })

  it('ships the values DEV-583 shipped, and the validator refuses a size that cannot be a target', () => {
    // Edit on purpose or not at all (the HUD_RASTER_SHIPPED pattern).
    // DEV-837 (Matt, 2026-10-08): off, the sea looked glassy. The sky's per-facet reflection is the fake.
    expect(ANNIVERSARY.render.seaReflection.enabled).toBe(false)
    expect(ANNIVERSARY.render.seaReflection.resolutionScale).toBe(0.5)
    expect(CLASSIC.render.seaReflection.enabled).toBe(false)
    // DEV-837: off in the preset, so it is no longer in vr.disable (that list names only features that are ON in flat).
    // A pin that turns it on still cannot carry it into a headset: the tier half of the gate is null there.
    expect(ANNIVERSARY.vr?.disable).not.toContain('render.seaReflection')
    const bad = (resolutionScale: number): Edition =>
      ({
        ...ANNIVERSARY,
        render: {
          ...ANNIVERSARY.render,
          seaReflection: { ...ANNIVERSARY.render.seaReflection, resolutionScale },
        },
      }) as Edition
    expect(() => validateEdition(bad(0))).toThrow(/seaReflection.resolutionScale/)
    expect(() => validateEdition(bad(1.5))).toThrow(/seaReflection.resolutionScale/)
    expect(() => validateEdition(bad(Number.NaN))).toThrow(/seaReflection.resolutionScale/)
    expect(() => validateEdition(bad(1))).not.toThrow()
  })

  it('sizes the mirror as a fraction of the drawing buffer, never below one texel', () => {
    expect(mirrorTargetSize(3840, 2160, 0.5)).toEqual({ width: 1920, height: 1080 })
    expect(mirrorTargetSize(2561, 1441, 0.5)).toEqual({ width: 1280, height: 720 })
    expect(mirrorTargetSize(1, 1, 0.5)).toEqual({ width: 1, height: 1 })
  })
})

describe('the mirror camera, by projection', () => {
  const PLANE = 116.4
  const eye = new THREE.PerspectiveCamera(70, 16 / 9, 0.08, 6000)
  eye.position.set(40, 152, -30)
  // Yawed and pitched down, so no axis is special.
  eye.rotation.set(-0.35, 0.6, 0.05, 'YXZ')
  eye.updateMatrixWorld(true)
  const mirror = new THREE.PerspectiveCamera()
  placeMirrorCamera(mirror, eye, PLANE)

  const reflect = (p: THREE.Vector3): THREE.Vector3 => new THREE.Vector3(p.x, 2 * PLANE - p.y, p.z)
  const clipOf = (p: THREE.Vector3, cam: THREE.Camera): THREE.Vector4 =>
    new THREE.Vector4(p.x, p.y, p.z, 1)
      .applyMatrix4(cam.matrixWorldInverse)
      .applyMatrix4(cam.projectionMatrix)

  /** Points the frame sees on the water, and things standing above it. */
  const ahead = (along: number, across: number, height: number): THREE.Vector3 => {
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(eye.quaternion)
    forward.y = 0
    forward.normalize()
    const side = new THREE.Vector3(-forward.z, 0, forward.x)
    return eye.position
      .clone()
      .addScaledVector(forward, along)
      .addScaledVector(side, across)
      .setY(PLANE + height)
  }

  it('sees a point at the frame’s screen y and the opposite screen x', () => {
    for (const [along, across, height] of [
      [120, 0, 0],
      [300, -80, 0],
      [600, 150, 0],
      [400, 40, 60],
      [900, -200, 180],
    ] as const) {
      const p = ahead(along, across, height)
      const seen = clipOf(p, mirror)
      const frame = clipOf(reflect(p), eye)
      expect(seen.w).toBeGreaterThan(0)
      expect(seen.x / seen.w).toBeCloseTo(-(frame.x / frame.w), 6)
      expect(seen.y / seen.w).toBeCloseTo(frame.y / frame.w, 6)
    }
  })

  it('puts its near plane ON the water: on it is the near plane, under it is clipped, over it is drawn', () => {
    for (const [along, across] of [
      [150, 0],
      [500, -120],
      [1200, 300],
    ] as const) {
      const on = clipOf(ahead(along, across, 0), mirror)
      expect(on.z / on.w).toBeCloseTo(-1, 5)
      const under = clipOf(ahead(along, across, -6), mirror)
      expect(under.w).toBeGreaterThan(0)
      expect(under.z).toBeLessThan(-under.w)
      const over = clipOf(ahead(along, across, 40), mirror)
      expect(over.z / over.w).toBeGreaterThan(-1)
      expect(over.z / over.w).toBeLessThan(1)
    }
  })

  it('stands under the water by the eye’s own height, and keeps the eye’s lens', () => {
    expect(mirror.position.y).toBeCloseTo(2 * PLANE - eye.position.y, 9)
    expect(mirror.position.x).toBeCloseTo(eye.position.x, 9)
    expect(mirror.near).toBe(eye.near)
    expect(mirror.far).toBe(eye.far)
  })
})

describe('the plane: the sea’s own surface plus this frame’s bob', () => {
  it('reads the field in SIM space (z negated) and adds the group’s travel from rest', () => {
    const field = {
      analytic: { heightAt: (_x: number, z: number) => 100 + z, inside: () => true },
    } as unknown as HeightField
    const group = new THREE.Group()
    group.position.y = 7.5
    const sea = { heightField: field, restY: 5, group }
    // THREE z = 3 is SIM z = -3: 100 - 3 = 97, plus a 2.5 m bob.
    expect(seaPlaneY(sea, 0, 3)).toBeCloseTo(99.5, 9)
  })
})

describe('what the mirror leaves out', () => {
  it('masks meshes, never a light, keeps the kept subtree, and hands every mask back', () => {
    const flight = new THREE.Group()
    const shell = new THREE.Mesh()
    shell.layers.set(0)
    const lamp = new THREE.PointLight()
    shell.add(lamp)
    const hull = new THREE.Group()
    hull.name = SHIP_EXTERIOR_NAME
    const hullMesh = new THREE.Mesh()
    hull.add(hullMesh)
    flight.add(shell, hull)
    const ui = new THREE.Mesh()
    ui.layers.set(3)
    const unmask = maskForMirror([cockpitOf(flight), ui, null, undefined])
    expect(shell.layers.mask).toBe(0)
    expect(ui.layers.mask).toBe(0)
    // The lamp is still collected (a light count is in the program key).
    expect(lamp.layers.mask).toBe(1)
    // The exterior hull draws by its own rules.
    expect(hullMesh.layers.mask).toBe(1)
    unmask()
    expect(shell.layers.mask).toBe(1)
    expect(ui.layers.mask).toBe(1 << 3)
  })
})

// ── the water ────────────────────────────────────────────────────────────

const OCEAN = TERRAIN.simonet.terrains.ocean
const material = (): {
  side: number
  needsUpdate: boolean
  defines?: Record<string, string>
  customProgramCacheKey?: () => string
  onBeforeCompile?: (shader: {
    uniforms: Record<string, { value: unknown }>
    vertexShader: string
    fragmentShader: string
  }) => void
} =>
  new (class {
    side = -1
    needsUpdate = false
  })()

const seaWith = (realtime: boolean) => {
  const m = material()
  const water = applyWaterWaves(
    m as unknown as Parameters<typeof applyWaterWaves>[0],
    OCEAN.displace,
    {
      specColor: OCEAN.material.specular.color,
      shininess: OCEAN.material.specular.shininess,
      sun: {
        direction: int01.lighting.sun.direction,
        colorLinear: int01.lighting.sun.colorLinear,
        intensity: int01.lighting.sun.intensity,
      },
      color: OCEAN.material.reflection.color,
      fresnel: OCEAN.material.reflection.fresnel,
      distortion: OCEAN.material.reflection.distortion,
      realtime,
      skySh: (int01.lighting.sky as { sh: number[][] }).sh,
      facetMetres: 32,
    },
  )
  return { m, water }
}

describe('the water: the define is absent when the mirror is off', () => {
  it('takes the define in and out, rebuilt last in a fixed order (DEV-194)', () => {
    const { m, water } = seaWith(true)
    expect(water.mirrors).toBe(true)
    expect(m.defines?.[MIRROR_DEFINE]).toBeUndefined()
    const texture = new THREE.Texture()
    water.setMirror(texture)
    expect(m.defines?.[MIRROR_DEFINE]).toBe('')
    const keys = Object.keys(m.defines ?? {})
    expect(keys.indexOf(MIRROR_DEFINE)).toBeGreaterThan(keys.indexOf('FF2_WATER_TWO_SIDED'))
    // A side flip with the mirror on keeps the SAME key order as construction.
    water.setEyeHeight(900, 0)
    water.setEyeHeight(0, 0)
    expect(Object.keys(m.defines ?? {})).toEqual(keys)
    water.setMirror(null)
    expect(MIRROR_DEFINE in (m.defines ?? {})).toBe(false)
  })

  it('refuses the mirror where 2016 had none', () => {
    const { m, water } = seaWith(false)
    expect(water.mirrors).toBe(false)
    water.setMirror(new THREE.Texture())
    expect(MIRROR_DEFINE in (m.defines ?? {})).toBe(false)
  })

  it('warms both mirror states once the mirror has been on, and only the old four before', () => {
    const { m, water } = seaWith(true)
    const seen: string[] = []
    const record = () => seen.push(`${m.side}|${Object.keys(m.defines ?? {}).join(',')}`)
    water.warmVariants(record)
    expect(new Set(seen).size).toBe(4)
    expect(seen).toHaveLength(5)
    seen.length = 0
    water.setMirror(new THREE.Texture())
    water.warmVariants(record)
    expect(new Set(seen).size).toBe(8)
    expect(seen).toHaveLength(9)
    // Restored to the state it was in: mirror on.
    expect(m.defines?.[MIRROR_DEFINE]).toBe('')
  })

  it('reads the mirror in both halves, and the fragment composites it over the sky', () => {
    const { m, water } = seaWith(true)
    water.setMirror(new THREE.Texture())
    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: '#include <begin_vertex>',
      fragmentShader:
        '#include <color_fragment>\n#include <normal_fragment_begin>\n#include <opaque_fragment>',
    }
    m.onBeforeCompile?.(shader)
    // Two symbol tables: the varying is declared in each, under the define.
    expect(shader.vertexShader).toMatch(/#ifdef FF2_WATER_MIRROR\s*varying vec4 vFf2MirrorClip;/)
    expect(shader.vertexShader).toContain(MIRROR_VERTEX_GLSL.trim())
    expect(shader.fragmentShader).toContain('varying vec4 vFf2MirrorClip;')
    // The sky reflection keeps its statement; the mirror changes its SOURCE.
    const frag = shader.fragmentShader
    expect(frag.indexOf('sky = ff2SeaMirror(sky, normal);')).toBeGreaterThan(-1)
    expect(frag.indexOf('sky = ff2SeaMirror(sky, normal);')).toBeLessThan(
      frag.indexOf('outgoingLight += sky * uReflect.rgb'),
    )
    // `_ReflectionDistortion` from the sheet, not typed.
    expect(shader.uniforms.uFf2MirrorDistortion?.value).toBe(OCEAN.material.reflection.distortion)
  })

  it('spells 2016’s lookup: the push before the divide, mirrored x, and an over composite', () => {
    // The push is in clip units, divided by w with the position, so it shrinks
    // with distance as `screenPos + normal.xz * d` then `tex2Dproj` did.
    expect(MIRROR_FRAGMENT_GLSL).toContain('n.xz * (uFf2MirrorDistortion / vFf2MirrorClip.w)')
    // The proper mirror camera sees the plane with screen x reversed (the
    // projection test above), so the lookup reverses it back.
    expect(MIRROR_FRAGMENT_GLSL).toContain('vec2(1.0 - uv.x, uv.y)')
    // Premultiplied over a transparent clear: the scene where drawn, sky elsewhere.
    expect(MIRROR_FRAGMENT_GLSL).toContain('return m.rgb + sky * (1.0 - m.a);')
  })
})

describe('the sheet: 2016’s oceans were realtime mirrors, with DEV-021’s numbers', () => {
  it('reads realtime, distortion 0.3, fresnel 1, roughness 0 and alpha 0.5 off every live sea', () => {
    let seas = 0
    for (const env of Object.values(TERRAIN)) {
      for (const t of Object.values(env.terrains)) {
        const live = (t as { displace?: { live?: boolean } | null }).displace?.live === true
        if (!live) continue
        seas++
        const r = t.material.reflection
        expect(r.realtime).toBe(true)
        expect(r.distortion).toBe(0.3)
        expect(r.fresnel).toBe(1)
        expect(r.roughness).toBe(0)
        expect(r.color[3]).toBe(0.5)
      }
    }
    expect(seas).toBeGreaterThan(0)
  })
})

// ── the live system, without a GL context ───────────────────────────────

const stubRenderer = (presenting: { value: boolean }) =>
  ({
    xr: {
      enabled: false,
      get isPresenting() {
        return presenting.value
      },
    },
    getDrawingBufferSize: (v: THREE.Vector2) => v.set(2560, 1440),
  }) as unknown as THREE.WebGLRenderer

describe('the live system opens and shuts with the settings, the look and the session', () => {
  it('holds a target only while the gate is open, and never in a session', () => {
    const presenting = { value: false }
    const state = createEditionState(ANNIVERSARY_MIRROR, ULTRA)
    const reflection = createSeaReflection({
      renderer: stubRenderer(presenting),
      editionState: state,
      excluded: () => [],
    })
    const { m, water } = seaWith(true)
    const sea: MirrorSea = {
      water,
      heightField: {
        analytic: { heightAt: () => 116, inside: () => true },
      } as unknown as HeightField,
      restY: 0,
      group: new THREE.Group(),
    }
    reflection.setSea(sea)
    expect(reflection.report.on).toBe(true)
    expect(reflection.report.width).toBe(1280)
    expect(reflection.report.height).toBe(720)
    expect(m.defines?.[MIRROR_DEFINE]).toBe('')

    // The quality row to high, mid-run: off, and the target freed.
    state.setSettings(HIGH)
    expect(reflection.report.on).toBe(false)
    expect(reflection.report.width).toBe(0)
    expect(MIRROR_DEFINE in (m.defines ?? {})).toBe(false)
    // ...and back.
    state.setSettings(ULTRA)
    expect(reflection.report.on).toBe(true)
    expect(m.defines?.[MIRROR_DEFINE]).toBe('')

    // A headset session: nothing allocated, nothing kept alive.
    presenting.value = true
    state.setImmersive(true)
    expect(reflection.report.on).toBe(false)
    expect(reflection.report.width).toBe(0)
    expect(MIRROR_DEFINE in (m.defines ?? {})).toBe(false)
    presenting.value = false
    state.setImmersive(false)
    expect(reflection.report.on).toBe(true)

    // Classic, by the look.
    state.setLook(CLASSIC)
    expect(reflection.report.on).toBe(false)
    expect(MIRROR_DEFINE in (m.defines ?? {})).toBe(false)

    reflection.dispose()
  })
})
