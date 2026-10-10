// tests/unit/next-gate-arrow.test.ts — the arrow points where it says (DEV-124).
//
// The orientation lesson, applied: NOT a quaternion assertion. The arrow's
// `base` and `tip` markers are read back through the scene graph into the
// ship's frame, and the angle between (tip - base) and the bearing from the
// mount to the target is what is measured. Within a degree, for a sweep of
// bearings around the whole sphere, with the ship itself placed and rotated
// arbitrarily so a bug that only shows under a non-identity parent cannot
// hide.
//
// Then the cone: dead ahead hides it, the edge feathers it, and both flags
// (off, and no target) hide it.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { EditionNextGateArrow } from '@/content/edition-schema'
import {
  ARROW_AXIS,
  arrowGrowth,
  createNextGateArrow,
  SHIP_FORWARD,
} from '@/render/next-gate-arrow'
import { editionJson as edition } from './helpers/content'

const SPEC: EditionNextGateArrow = {
  enabled: true,
  coneDegrees: 10,
  featherDegrees: 4,
  lengthMetres: 0.08,
  offset: [0, -0.16, -0.8],
  color: [1, 0.623, 0.194],
  emissive: 0.8,
}
const EYE = new THREE.Vector3(0, 0.86, 1.27)

/** A ship somewhere, facing somewhere, with the arrow mounted on it. */
const rig = () => {
  const ship = new THREE.Group()
  ship.position.set(-761, 149, -2007)
  ship.quaternion.setFromEuler(new THREE.Euler(0.3, -2.1, 0.7))
  const arrow = createNextGateArrow()
  ship.add(arrow.object)
  return { ship, arrow }
}

/** (tip - base) in the SHIP's frame, unit length. Read back through matrixWorld. */
const pointing = (ship: THREE.Object3D, arrow: THREE.Object3D): THREE.Vector3 => {
  ship.updateMatrixWorld(true)
  const base = arrow.getObjectByName('base') as THREE.Object3D
  const tip = arrow.getObjectByName('tip') as THREE.Object3D
  const b = ship.worldToLocal(base.getWorldPosition(new THREE.Vector3()))
  const t = ship.worldToLocal(tip.getWorldPosition(new THREE.Vector3()))
  return t.sub(b).normalize()
}

const degBetween = (a: THREE.Vector3, b: THREE.Vector3): number =>
  THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1)))

describe('the arrow points along the bearing to the target', () => {
  it('within a degree, for bearings all round the ship, under a rotated parent', () => {
    const { ship, arrow } = rig()
    const mount = EYE.clone().add(new THREE.Vector3(...(SPEC.offset as [number, number, number])))
    let worst = 0
    let checked = 0
    for (let az = 0; az < 360; az += 30) {
      for (const el of [-60, -20, 0, 20, 60]) {
        const a = THREE.MathUtils.degToRad(az)
        const e = THREE.MathUtils.degToRad(el)
        // Bearing in the ship's frame: azimuth 0 is dead ahead (-z).
        const dir = new THREE.Vector3(
          Math.sin(a) * Math.cos(e),
          Math.sin(e),
          -Math.cos(a) * Math.cos(e),
        )
        const target = mount.clone().addScaledVector(dir, 400)
        arrow.update(target, EYE, SPEC)
        const off = degBetween(dir, SHIP_FORWARD)
        if (off <= SPEC.coneDegrees) {
          expect(arrow.object.visible, `hidden at ${off.toFixed(1)} deg`).toBe(false)
          continue
        }
        expect(arrow.object.visible, `visible at ${off.toFixed(1)} deg`).toBe(true)
        const err = degBetween(pointing(ship, arrow.object), dir)
        worst = Math.max(worst, err)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(40)
    expect(worst).toBeLessThan(1)
  })

  it('has its base at the mount — eye plus the preset`s offset — in the ship`s frame', () => {
    const { ship, arrow } = rig()
    arrow.update(new THREE.Vector3(300, 0, 0), EYE, SPEC)
    ship.updateMatrixWorld(true)
    const base = arrow.object.getObjectByName('base') as THREE.Object3D
    const b = ship.worldToLocal(base.getWorldPosition(new THREE.Vector3()))
    expect(b.x).toBeCloseTo(EYE.x + (SPEC.offset[0] as number), 6)
    expect(b.y).toBeCloseTo(EYE.y + (SPEC.offset[1] as number), 6)
    expect(b.z).toBeCloseTo(EYE.z + (SPEC.offset[2] as number), 6)
    // In FRONT of the eye, below it: on the glareshield, not in the face.
    expect(b.z).toBeLessThan(EYE.z)
    expect(b.y).toBeLessThan(EYE.y)
  })

  it('is lengthMetres from base to tip when fully grown', () => {
    const { ship, arrow } = rig()
    arrow.update(new THREE.Vector3(0, 500, 0), EYE, SPEC)
    ship.updateMatrixWorld(true)
    const base = arrow.object.getObjectByName('base') as THREE.Object3D
    const tip = arrow.object.getObjectByName('tip') as THREE.Object3D
    const len = base
      .getWorldPosition(new THREE.Vector3())
      .distanceTo(tip.getWorldPosition(new THREE.Vector3()))
    expect(len).toBeCloseTo(SPEC.lengthMetres, 6)
  })

  it('unrotated, the geometry itself points along ARROW_AXIS with the tip at the far end', () => {
    // The markers mean nothing unless the drawn shape agrees with them: the
    // pyramid head's apex has to be the +z extreme of the whole object.
    const arrow = createNextGateArrow()
    arrow.object.visible = true
    const box = new THREE.Box3().setFromObject(arrow.object)
    expect(box.min.z).toBeCloseTo(0, 6)
    expect(box.max.z).toBeCloseTo(1, 6)
    expect(ARROW_AXIS.z).toBe(1)
    // Symmetric about its own axis: no lean baked into the shaft or head.
    expect(box.min.x).toBeCloseTo(-box.max.x, 6)
    expect(box.min.y).toBeCloseTo(-box.max.y, 6)
  })
})

describe('the cone', () => {
  it('hides the arrow for a target dead ahead and just inside the cone', () => {
    const { arrow } = rig()
    const mount = EYE.clone().add(new THREE.Vector3(...(SPEC.offset as [number, number, number])))
    arrow.update(mount.clone().add(new THREE.Vector3(0, 0, -600)), EYE, SPEC)
    expect(arrow.object.visible).toBe(false)
    const inside = THREE.MathUtils.degToRad(9)
    arrow.update(
      mount.clone().add(new THREE.Vector3(Math.sin(inside) * 600, 0, -Math.cos(inside) * 600)),
      EYE,
      SPEC,
    )
    expect(arrow.object.visible).toBe(false)
  })

  it('grows from nothing at the cone`s edge to full length past the feather', () => {
    expect(arrowGrowth(10, SPEC)).toBe(0)
    expect(arrowGrowth(12, SPEC)).toBeCloseTo(0.5, 6)
    expect(arrowGrowth(14, SPEC)).toBe(1)
    expect(arrowGrowth(90, SPEC)).toBe(1)
    expect(arrowGrowth(11, { ...SPEC, featherDegrees: 0 })).toBe(1)
    const { arrow } = rig()
    const mount = EYE.clone().add(new THREE.Vector3(...(SPEC.offset as [number, number, number])))
    const half = THREE.MathUtils.degToRad(12)
    arrow.update(
      mount.clone().add(new THREE.Vector3(Math.sin(half) * 600, 0, -Math.cos(half) * 600)),
      EYE,
      SPEC,
    )
    expect(arrow.object.visible).toBe(true)
    expect(arrow.object.scale.x).toBeCloseTo(SPEC.lengthMetres * 0.5, 6)
  })

  it('hides with no target, and with the flag off', () => {
    const { arrow } = rig()
    arrow.update(new THREE.Vector3(500, 0, 0), EYE, SPEC)
    expect(arrow.object.visible).toBe(true)
    arrow.update(null, EYE, SPEC)
    expect(arrow.object.visible).toBe(false)
    arrow.update(new THREE.Vector3(500, 0, 0), EYE, { ...SPEC, enabled: false })
    expect(arrow.object.visible).toBe(false)
  })
})

describe('the presets', () => {
  it('Anniversary shows it, Classic does not, and both keep the same numbers', () => {
    const a = edition('anniversary').hud.nextGateArrow
    const c = edition('classic').hud.nextGateArrow
    expect(a.enabled).toBe(true)
    expect(c.enabled).toBe(false)
    expect({ ...a, enabled: true, note: '' }).toEqual({ ...c, enabled: true, note: '' })
    // Forward of the eye and below it, in three space.
    expect(a.offset[2]).toBeLessThan(0)
    expect(a.offset[1]).toBeLessThan(0)
  })
})
