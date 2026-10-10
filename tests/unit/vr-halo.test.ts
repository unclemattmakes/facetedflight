// tests/unit/vr-halo.test.ts — bloom in a headset, as halos. DEV-336.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { type Edition, validateEdition } from '@/content/edition-schema'
import { createInstancedHalos, createSunHalo } from '@/render/vr-halo'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'

const ANNIVERSARY = anniversaryJson as unknown as Edition
const CLASSIC = classicJson as unknown as Edition

describe('stud halos', () => {
  const studs = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial(),
    3,
  )
  studs.name = 'ring-studs'

  it('SHARE the studs’ instance matrix, so a shrink or a move reaches them on the same upload', () => {
    const halos = createInstancedHalos(studs, new THREE.Color(0, 1, 1))
    expect(halos.object.instanceMatrix).toBe(studs.instanceMatrix)
    expect(halos.object.count).toBe(studs.count)
    expect(halos.object.name).toBe('ring-studs-halos')
  })

  it('start hidden, and take their look from the preset', () => {
    const halos = createInstancedHalos(studs, new THREE.Color(0, 1, 1))
    expect(halos.object.visible).toBe(false)
    halos.setLook(1.2, 0.2)
    const u = (halos.object.material as THREE.ShaderMaterial).uniforms
    expect(u.uRadius?.value).toBe(1.2)
    expect(u.uIntensity?.value).toBe(0.2)
  })

  it('are additive light that terrain can hide and that writes no depth', () => {
    const m = createInstancedHalos(studs, new THREE.Color(1, 1, 1)).object
      .material as THREE.ShaderMaterial
    expect(m.blending).toBe(THREE.AdditiveBlending)
    expect(m.depthTest).toBe(true)
    expect(m.depthWrite).toBe(false)
    // Light in the world, not UI: tone-mapped (render/tone.ts's line).
    expect(m.toneMapped).toBe(true)
  })

  it('never sit on a WebXR eye layer (DEV-141)', () => {
    const halos = createInstancedHalos(studs, new THREE.Color(1, 1, 1)).object
    expect(halos.layers.isEnabled(1)).toBe(false)
    expect(halos.layers.isEnabled(2)).toBe(false)
  })
})

describe('the sun halo', () => {
  it('stands `distance` out along the sun direction from the eye', () => {
    const sun = createSunHalo(5000)
    const eye = new THREE.Vector3(10, 200, -30)
    const toward = new THREE.Vector3(0.6, 0.8, 0)
    sun.place(eye, toward)
    expect(sun.object.position.distanceTo(eye)).toBeCloseTo(5000, 6)
    expect(sun.object.position.clone().sub(eye).normalize().dot(toward)).toBeCloseTo(1, 9)
  })

  it('sizes itself as an ANGLE at the eye', () => {
    const sun = createSunHalo(5000)
    sun.setLook(5, 0.3, new THREE.Color(1, 0.9, 0.8))
    const u = (sun.object.material as THREE.ShaderMaterial).uniforms
    expect(Math.atan((u.uRadius?.value as number) / 5000) * (180 / Math.PI)).toBeCloseTo(5, 9)
    expect(u.uIntensity?.value).toBe(0.3)
  })
})

describe('the presets', () => {
  it('give Anniversary a halo and Classic none, whose bloom is off anyway', () => {
    const a = ANNIVERSARY.render.bloom
    expect(a.enabled).toBe(true)
    expect(a.vrHalo.studRadius).toBeGreaterThan(0)
    expect(a.vrHalo.studIntensity).toBeGreaterThan(0)
    const c = CLASSIC.render.bloom
    expect(c.enabled).toBe(false)
    expect(Object.values(c.vrHalo).every((v) => v === 0)).toBe(true)
  })

  it('refuses a negative or missing halo number at load', () => {
    const broken = structuredClone(anniversaryJson) as unknown as {
      render: { bloom: { vrHalo: Record<string, number> } }
    }
    broken.render.bloom.vrHalo.studIntensity = -1
    expect(() => validateEdition(broken as unknown as Edition)).toThrow(/vrHalo\.studIntensity/)
  })
})
