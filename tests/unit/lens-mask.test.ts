// tests/unit/lens-mask.test.ts: the app's lens mask, the parts a node test can
// reach. DEV-930, lever 9.
//
// The region itself (which pixels the GPU rejects) is a property of the vertex
// shader and the depth test, so it is proved on the emulated XR session by
// `tests/e2e/lens-mask.spec.ts`, by readback. This file holds the pin, the
// three locks that keep it out of every camera but the two eyes, and the depth
// state that makes it a mask rather than a draw.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { isUiObject, UI_LAYER } from '@/render/bloom'
import {
  createLensMask,
  followSessions,
  hiddenFraction,
  LENS_MASK_LAYERS,
  LENS_MASK_ORDER,
  LENS_MASK_RADIUS_DEFAULT,
  LENS_MASK_RADIUS_MAX,
  LENS_MASK_RADIUS_MIN,
  parseLensMaskPin,
} from '@/render/lens-mask'

/** three's eye derivation, as `xr-eye-layers.test.ts` section 1 pins it in the build. */
const eyeMasks = (appMask: number) => {
  const xr = appMask | 0b110
  return { left: xr & -5, right: xr & -3 }
}

const layersOf = (mask: number): THREE.Layers => {
  const l = new THREE.Layers()
  l.mask = mask
  return l
}

describe('?lensMask=', () => {
  it('is ON at the default radius when absent, empty or "on"', () => {
    expect(parseLensMaskPin(null)).toBe(LENS_MASK_RADIUS_DEFAULT)
    expect(parseLensMaskPin('')).toBe(LENS_MASK_RADIUS_DEFAULT)
    expect(parseLensMaskPin('on')).toBe(LENS_MASK_RADIUS_DEFAULT)
  })

  it('is OFF for 0 and "off"', () => {
    expect(parseLensMaskPin('0')).toBeNull()
    expect(parseLensMaskPin('off')).toBeNull()
  })

  it('takes a radius inside the bounds, and warns and keeps the default outside them', () => {
    expect(parseLensMaskPin('1.1')).toBe(1.1)
    const warnings: string[] = []
    for (const bad of ['0.2', '3', 'big', 'NaN']) {
      expect(
        parseLensMaskPin(bad, (m) => warnings.push(m)),
        bad,
      ).toBe(LENS_MASK_RADIUS_DEFAULT)
    }
    expect(warnings).toHaveLength(4)
    expect(LENS_MASK_RADIUS_MIN).toBeLessThan(LENS_MASK_RADIUS_DEFAULT)
    expect(LENS_MASK_RADIUS_MAX).toBeGreaterThan(LENS_MASK_RADIUS_DEFAULT)
  })
})

describe('the default region is conservative', () => {
  it('masks only the corner tips: under 5 % of a symmetric eye, and nothing of the edges', () => {
    // Past the unit circle, the mask cannot reach the middle of any edge of
    // the NDC square: only the corners are outside it.
    expect(LENS_MASK_RADIUS_DEFAULT).toBeGreaterThan(1)
    const f = hiddenFraction(LENS_MASK_RADIUS_DEFAULT)
    expect(f).toBeGreaterThan(0)
    expect(f).toBeLessThan(0.05)
  })

  it('hides more as the circle shrinks, and nothing past the corners', () => {
    expect(hiddenFraction(1.1)).toBeGreaterThan(hiddenFraction(1.25))
    expect(hiddenFraction(Math.SQRT2 + 0.01)).toBe(0)
    // The unit circle inscribed in the square leaves 1 - pi / 4 outside it: an
    // independent value, not the code's own grid.
    expect(hiddenFraction(1, 512)).toBeCloseTo(1 - Math.PI / 4, 3)
  })
})

describe('the mesh is a depth mask, not a draw', () => {
  const mask = createLensMask()
  const material = mask.mesh.material as THREE.ShaderMaterial

  it('writes depth and no colour, with the depth test ON (GL writes no depth without it)', () => {
    expect(material.colorWrite).toBe(false)
    expect(material.depthWrite).toBe(true)
    expect(material.depthTest).toBe(true)
    expect(material.depthFunc).toBe(THREE.LessEqualDepth)
    expect(material.transparent).toBe(false)
  })

  it('is not a UI surface, so bloom never moves it off the eye layers', () => {
    expect(isUiObject(mask.mesh)).toBe(false)
  })

  it('sorts first in each eye: its own order and its GROUP order are below everything', () => {
    // `painterSortStable` compares groupOrder first, then renderOrder. A group
    // in the game with a negative order (a medal holder at -1, the loading
    // scene's mesh at -1) would beat a bare mesh at the rig's group order 0.
    expect(mask.mesh.renderOrder).toBe(LENS_MASK_ORDER)
    expect(mask.object.renderOrder).toBe(LENS_MASK_ORDER)
    expect((mask.object as THREE.Group).isGroup).toBe(true)
    expect(LENS_MASK_ORDER).toBeLessThan(-1000)
  })

  it('is never culled, never casts and is never picked', () => {
    expect(mask.mesh.frustumCulled).toBe(false)
    expect(mask.mesh.castShadow).toBe(false)
    const hits: THREE.Intersection[] = []
    const ray = new THREE.Raycaster(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, -1))
    ray.layers.enableAll()
    mask.mesh.raycast(ray, hits)
    expect(hits).toEqual([])
  })
})

describe('lock 2: on both eye layers, and in no other camera', () => {
  it('reaches both eyes of the app camera, in every state bloom leaves it in', () => {
    const mesh = layersOf(LENS_MASK_LAYERS)
    for (const appMask of [1, 1 | (1 << UI_LAYER)]) {
      const { left, right } = eyeMasks(appMask)
      expect(mesh.test(layersOf(left)), `left, app ${appMask}`).toBe(true)
      expect(mesh.test(layersOf(right)), `right, app ${appMask}`).toBe(true)
    }
  })

  it('is invisible to the app camera itself and to a pass that copies its mask', () => {
    const mesh = layersOf(LENS_MASK_LAYERS)
    const app = 1 | (1 << UI_LAYER)
    expect(mesh.test(layersOf(app)), 'the flat camera').toBe(false)
    // `render/sea-reflection.ts`: the mirror takes the camera's mask less UI.
    expect(mesh.test(layersOf(app & ~(1 << UI_LAYER))), 'the mirror').toBe(false)
    expect(mesh.test(layersOf(1)), 'a default camera (shadow, cube, PMREM)').toBe(false)
  })
})

describe('lock 3: zero vertices for any camera that is not an eye', () => {
  const left = new THREE.PerspectiveCamera()
  const right = new THREE.PerspectiveCamera()
  const other = new THREE.PerspectiveCamera()
  const renderer = (isPresenting: boolean) =>
    ({ xr: { isPresenting, getCamera: () => ({ cameras: [left, right] }) } }) as never
  const draw = (mask: ReturnType<typeof createLensMask>, r: never, camera: THREE.Camera) => {
    mask.mesh.onBeforeRender(
      r,
      new THREE.Scene(),
      camera,
      mask.mesh.geometry,
      mask.mesh.material as never,
      null as never,
    )
    return mask.mesh.geometry.drawRange.count
  }

  it('draws in each eye while presenting', () => {
    const mask = createLensMask()
    expect(draw(mask, renderer(true), left)).toBe(Number.POSITIVE_INFINITY)
    expect(draw(mask, renderer(true), right)).toBe(Number.POSITIVE_INFINITY)
    expect(mask.report().eyeDraws).toBe(2)
  })

  it('draws nothing for another camera, or for an eye camera off a session', () => {
    const mask = createLensMask()
    expect(draw(mask, renderer(true), other)).toBe(0)
    expect(draw(mask, renderer(false), left)).toBe(0)
    // And an eye after a refused pass is restored, not stuck at zero.
    expect(draw(mask, renderer(true), left)).toBe(Number.POSITIVE_INFINITY)
    expect(mask.report().eyeDraws).toBe(1)
  })
})

describe('lock 1: in the rig only from sessionstart to sessionend', () => {
  it('follows the session edges, and the report says so', () => {
    const xr = new THREE.EventDispatcher<{ sessionstart: object; sessionend: object }>()
    const rig = new THREE.Group()
    const mask = createLensMask()
    const stop = followSessions(mask, xr, rig)
    expect(mask.object.parent).toBeNull()
    expect(mask.report().enabled).toBe(false)
    xr.dispatchEvent({ type: 'sessionstart' })
    expect(mask.object.parent).toBe(rig)
    expect(mask.report()).toMatchObject({ enabled: true, attached: true })
    xr.dispatchEvent({ type: 'sessionend' })
    expect(mask.object.parent).toBeNull()
    stop()
    xr.dispatchEvent({ type: 'sessionstart' })
    expect(mask.object.parent, 'unsubscribed').toBeNull()
  })
})

describe('set: the live radius', () => {
  it('turns off at 0 or null, clamps out-of-range radii, and reaches the uniform', () => {
    const mask = createLensMask(null)
    const uniforms = (mask.mesh.material as THREE.ShaderMaterial).uniforms as {
      uRadius: { value: number }
    }
    expect(mask.mesh.visible).toBe(false)
    expect(mask.report().radius).toBeNull()
    expect(mask.set(1.1).radius).toBe(1.1)
    expect(uniforms.uRadius.value).toBe(1.1)
    expect(mask.mesh.visible).toBe(true)
    expect(mask.set(9).radius).toBe(LENS_MASK_RADIUS_MAX)
    expect(mask.set(0.1).radius).toBe(LENS_MASK_RADIUS_MIN)
    expect(mask.set(0).radius).toBeNull()
    expect(mask.mesh.visible).toBe(false)
  })
})
