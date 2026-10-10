// tests/unit/ui-plate.test.ts: the shared canvas plate (UI-1, reuse/ui-plates).
//
// Three claims, each the one that would hurt if it broke:
//
//  1. The material is the UI's door. `toneMapped: false` is what `bloom.ts`
//     reads to move a plate onto UI_LAYER (3), and layers 1 and 2 are the WebXR
//     eyes (DEV-141), so a plate built without it is a plate absent from one eye
//     or squashed by the tone curve. Asserted through `isUiObject`, the
//     predicate bloom itself uses, so this is the SAME question and not a copy.
//  2. A resized canvas gets a NEW texture, and the material is pointed at it:
//     `needsUpdate` on the old one uploads into the old allocation and the plate
//     comes out squashed (pause.ts learned it, checklist-plate.ts copied it).
//  3. The geometry callback is honoured, so a plate that grows downward from a
//     fixed top edge (pause, room code) keeps doing so across a resize.
//
// No DOM: a stub `document` hands back a canvas-shaped object. Everything else
// in the factory is pure three.

import * as THREE from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isUiObject } from '@/render/bloom'
import {
  createUiMaterial,
  createUiPlate,
  createUiTexture,
  UI_PIXELS_PER_METRE,
} from '@/render/ui-plate'

const fakeCanvas = () => ({
  width: 300,
  height: 150,
  getContext: () => ({}),
})

beforeEach(() => {
  vi.stubGlobal('document', { createElement: () => fakeCanvas() })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createUiPlate', () => {
  const make = (extra = {}) =>
    createUiPlate({ name: 'unit-plate', widthM: 0.5, heightM: 0.2, renderOrder: 11, ...extra })

  it('sizes the canvas from metres and names, orders and hides the mesh', () => {
    const plate = make()
    expect(plate.canvas.width).toBe(Math.round(0.5 * UI_PIXELS_PER_METRE))
    expect(plate.canvas.height).toBe(Math.round(0.2 * UI_PIXELS_PER_METRE))
    expect(plate.object.name).toBe('unit-plate')
    expect(plate.object.renderOrder).toBe(11)
    expect(plate.object.visible).toBe(false)
  })

  it('is an overlay on the UI layer: unlit, untoned, undepthed, and bloom classifies it', () => {
    const { material, object, texture } = make()
    expect(material.toneMapped).toBe(false)
    expect(material.depthTest).toBe(false)
    expect(material.depthWrite).toBe(false)
    expect(material.transparent).toBe(true)
    expect(isUiObject(object)).toBe(true)
    expect(texture.colorSpace).toBe(THREE.SRGBColorSpace)
    expect(texture.anisotropy).toBe(4)
  })

  it('every UI material the module hands out carries the flag, not just the plate', () => {
    const m = createUiMaterial(createUiTexture(fakeCanvas() as unknown as HTMLCanvasElement))
    expect(m.toneMapped).toBe(false)
    expect(m.depthTest).toBe(false)
  })

  it('takes anisotropy and pixel density from the spec', () => {
    const plate = make({ anisotropy: 1, pxPerM: 100 })
    expect(plate.texture.anisotropy).toBe(1)
    expect(plate.canvas.width).toBe(50)
    expect(plate.canvas.height).toBe(20)
  })

  it('resize: a new canvas height, a new texture, the material pointed at it', () => {
    const plate = make()
    const before = plate.texture
    const disposed = vi.fn()
    before.addEventListener('dispose', disposed)
    plate.resize(0.4)
    expect(plate.canvas.height).toBe(Math.round(0.4 * UI_PIXELS_PER_METRE))
    expect(plate.texture).not.toBe(before)
    expect(plate.material.map).toBe(plate.texture)
    expect(plate.texture.anisotropy).toBe(4)
    expect(plate.texture.colorSpace).toBe(THREE.SRGBColorSpace)
    expect(disposed).toHaveBeenCalledTimes(1)
    // And the plane is the new height.
    const g = plate.object.geometry as THREE.PlaneGeometry
    expect(g.parameters.height).toBeCloseTo(0.4, 12)
  })

  it('resize disposes the old plane', () => {
    const plate = make()
    const old = plate.object.geometry
    const disposed = vi.fn()
    old.addEventListener('dispose', disposed)
    plate.resize(0.3)
    expect(plate.object.geometry).not.toBe(old)
    expect(disposed).toHaveBeenCalledTimes(1)
  })

  it('commit uploads the CURRENT texture, not the one it started with', () => {
    const plate = make()
    const first = plate.texture
    plate.resize(0.3)
    const v0 = plate.texture.version
    const v1 = first.version
    plate.commit()
    expect(plate.texture.version).toBe(v0 + 1)
    expect(first.version).toBe(v1)
  })

  it('a top-anchored plane stays top-anchored across a resize', () => {
    const top = (h: number) => {
      const g = new THREE.PlaneGeometry(0.5, h)
      g.translate(0, 0.1 - h / 2, 0)
      return g
    }
    const plate = make({ geometry: top })
    for (const h of [0.2, 0.35, 0.5]) {
      plate.resize(h)
      plate.object.geometry.computeBoundingBox()
      expect(plate.object.geometry.boundingBox?.max.y).toBeCloseTo(0.1, 6)
    }
  })

  it('throws, naming the plate, when there is no 2d context', () => {
    vi.stubGlobal('document', {
      createElement: () => ({ width: 0, height: 0, getContext: () => null }),
    })
    expect(() => make()).toThrow('unit-plate: no 2d context')
  })

  it('dispose releases texture, material and plane', () => {
    const plate = make()
    const t = vi.fn()
    const m = vi.fn()
    const g = vi.fn()
    plate.texture.addEventListener('dispose', t)
    plate.material.addEventListener('dispose', m)
    plate.object.geometry.addEventListener('dispose', g)
    plate.dispose()
    expect([t, m, g].map((f) => f.mock.calls.length)).toEqual([1, 1, 1])
  })
})
