// tests/unit/tv-teleport.test.ts: DEV-481: the headset's Free camera, as maths.
//
// `tv-teleport.ts`: where an aimed teleport lands (the ground, the air, the
// bounds, never inside a prop) and the rig arithmetic that puts the HEAD
// there and turns about it. Compared against geometry, not against the
// module's own formulas (trap 24): a head position recomposed with three.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  headWorld,
  rigForEye,
  snapTurn,
  TELEPORT_POLICY,
  teleportTarget,
} from '@/game/tv/tv-teleport'

/** The head's world position as three composes it: rig × local head. */
const composedHead = (
  pos: readonly number[],
  yaw: number,
  head: readonly number[],
): THREE.Vector3 =>
  new THREE.Vector3(head[0], head[1], head[2])
    .applyQuaternion(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw))
    .add(new THREE.Vector3(pos[0], pos[1], pos[2]))

describe('DEV-481: teleport targets', () => {
  const flat = { heightAt: () => 0 }

  it('lands where the aim meets the ground, the eye 1.8 m above it', () => {
    const t = teleportTarget([0, 100, 0], [0, -1, -1], flat)
    expect(t?.onGround).toBe(true)
    expect(t?.eye[0]).toBeCloseTo(0, 3)
    expect(t?.eye[2]).toBeCloseTo(-100, 2)
    expect(t?.eye[1]).toBeCloseTo(TELEPORT_POLICY.groundEye, 6)
    expect(t?.distance).toBeCloseTo(100 * Math.SQRT2, 2)
  })

  it('aimed at the sky, goes a fixed way out and stays well above the ground', () => {
    const t = teleportTarget([0, 10, 0], [0, 1, -1], flat)
    expect(t?.onGround).toBe(false)
    expect(t?.distance).toBe(TELEPORT_POLICY.airDistance)
    expect(t?.eye[1]).toBeGreaterThanOrEqual(TELEPORT_POLICY.airAbove)
  })

  it('never lands under a slope it hits side-on', () => {
    // A ramp rising 1 m per metre towards −Z.
    const ramp = { heightAt: (_x: number, z: number) => Math.max(0, -z) }
    const t = teleportTarget([0, 50, 100], [0, -0.2, -1], ramp)
    expect(t).not.toBeNull()
    const [x, y, z] = (t as NonNullable<typeof t>).eye
    for (let dx = -3; dx <= 3; dx++)
      for (let dz = -3; dz <= 3; dz++) expect(y).toBeGreaterThan(ramp.heightAt(x + dx, z + dz))
  })

  it('is pulled back inside the bounds', () => {
    const bounds = { centre: [0, 0, 0] as const, radius: 50 }
    const t = teleportTarget([0, 10, 0], [0, -0.01, -1], { ...flat, bounds })
    const [x, y, z] = (t as NonNullable<typeof t>).eye
    expect(Math.hypot(x, y, z)).toBeLessThanOrEqual(50)
  })

  it('retreats along the aim out of a prop', () => {
    const obstructed = (x: number, _y: number, z: number, r: number) =>
      Math.hypot(x, z + 100) < 5 + r
    const t = teleportTarget([0, 100, 0], [0, -1, -1], { ...flat, obstructed })
    expect(t).not.toBeNull()
    const [x, , z] = (t as NonNullable<typeof t>).eye
    expect(Math.hypot(x, z + 100)).toBeGreaterThanOrEqual(5 + TELEPORT_POLICY.eyeRadius)
    expect(z).toBeGreaterThan(-100)
  })
})

describe('DEV-481: the rig puts the head where it was asked', () => {
  it('rigForEye places the HEAD, not the rig, at the eye, for any yaw and lean', () => {
    const head = [0.4, -0.1, 0.25] as const
    for (const yaw of [0, 0.7, -2.1, Math.PI]) {
      const rig = rigForEye([10, 20, 30], yaw, head)
      const h = composedHead(rig.position, rig.yaw, head)
      expect(h.distanceTo(new THREE.Vector3(10, 20, 30))).toBeLessThan(1e-9)
      expect(new THREE.Vector3(...headWorld(rig, head)).distanceTo(h)).toBeLessThan(1e-9)
    }
  })

  it('a snap turns 30° about the head, right is clockwise from above', () => {
    const head = [0.5, 0, 0] as const
    const rig = rigForEye([0, 0, 0], 0, head)
    const turned = snapTurn(rig, head, 1)
    expect(composedHead(turned.position, turned.yaw, head).length()).toBeLessThan(1e-9)
    // Facing −Z, a right turn faces towards +X: the view's x grows.
    const view = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), turned.yaw)
    expect(view.x).toBeGreaterThan(0)
    expect(THREE.MathUtils.radToDeg(rig.yaw - turned.yaw)).toBeCloseTo(30, 9)
  })
})
