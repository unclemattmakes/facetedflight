// tests/unit/title-flypast.test.ts — the title jets fly nose-first.
//
// Matt: *"the ai jets in the title screen seem to be flying backwards? can you
// double-check that's correct?"* They were. `Object3D.lookAt` aims +z; a ship
// that came out of Unity through the z-mirror travels along −z.
//
// The guard is deliberately NOT "assert aimShip produces this quaternion" —
// that is the belief written twice, which is what `docs/DEVIATIONS.md` calls
// the orientation lesson. It is instead: **the title screen must orient a ship
// the same way flight does**, checked against `flipQuaternion` on a real pose.
// That is the comparison that fails when either side changes.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { aimShip } from '@/render/title'
import { flipQuaternion } from '@/render/unity-space'

/** Unity's forward. A body's heading is its own local +z, in sim space. */
const UNITY_FORWARD = new THREE.Vector3(0, 0, 1)

/** What the renderer does to a sim pose: `racers.ts` `render()`, in one line. */
const asFlightWould = (unityYaw: number): THREE.Quaternion => {
  const sim = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), unityYaw)
  return flipQuaternion(new THREE.Quaternion(), sim)
}

/** Where a pose actually points, in three's world: sim forward, z-mirrored. */
const flightHeading = (unityYaw: number): THREE.Vector3 => {
  const sim = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), unityYaw)
  const forward = UNITY_FORWARD.clone().applyQuaternion(sim)
  return new THREE.Vector3(forward.x, forward.y, -forward.z)
}

describe('the ship-heading convention', () => {
  it('a flipped pose travels along its own local −z, not +z', () => {
    // The claim the whole fix rests on, checked at eight yaws rather than one:
    // a single yaw can agree by coincidence, which is how `SHIP_MODEL_YAW`
    // shipped wrong the first time.
    for (let i = 0; i < 8; i++) {
      const yaw = (i * Math.PI) / 4
      const object = new THREE.Object3D()
      object.quaternion.copy(asFlightWould(yaw))
      const minusZ = new THREE.Vector3(0, 0, -1).applyQuaternion(object.quaternion)
      const plusZ = new THREE.Vector3(0, 0, 1).applyQuaternion(object.quaternion)
      const heading = flightHeading(yaw)
      expect(minusZ.dot(heading)).toBeCloseTo(1, 6)
      expect(plusZ.dot(heading)).toBeCloseTo(-1, 6)
    }
  })
})

describe('aimShip', () => {
  it('points the nose along the direction of travel', () => {
    // Eight headings around the compass, plus a climb and a dive, because a
    // circuit does both.
    const headings = [
      ...Array.from({ length: 8 }, (_, i) => {
        const a = (i * Math.PI) / 4
        return new THREE.Vector3(Math.cos(a), 0, Math.sin(a))
      }),
      new THREE.Vector3(1, 0.4, 0.2).normalize(),
      new THREE.Vector3(-0.3, -0.5, 1).normalize(),
    ]
    for (const heading of headings) {
      const ship = new THREE.Object3D()
      ship.position.set(12, 34, -56)
      const target = ship.position.clone().add(heading.clone().multiplyScalar(7))
      aimShip(ship, target, 0)
      const nose = new THREE.Vector3(0, 0, -1).applyQuaternion(ship.quaternion)
      expect(nose.dot(heading)).toBeCloseTo(1, 5)
    }
  })

  it('agrees with what the flight renderer would produce for the same heading', () => {
    // The cross-check that matters: give `aimShip` the heading a flown racer
    // has, and it must arrive at the same orientation the sim path arrives at.
    // Level flight only — `aimShip` has no bank of its own at roll 0 and
    // neither does a yaw-only pose.
    for (let i = 0; i < 8; i++) {
      const yaw = (i * Math.PI) / 4
      const heading = flightHeading(yaw)
      const ship = new THREE.Object3D()
      aimShip(ship, heading.clone().multiplyScalar(10), 0)
      expect(ship.quaternion.angleTo(asFlightWould(yaw))).toBeCloseTo(0, 5)
    }
  })

  it('banks the right wing down on a right turn', () => {
    // The circuit in `title.ts` runs clockwise seen from above, which is a
    // right turn, and the roll passed there is negative. Flying along world +x,
    // the right wing is world +z; a negative roll must put it BELOW the hull.
    const ship = new THREE.Object3D()
    aimShip(ship, new THREE.Vector3(10, 0, 0), -0.5)
    const rightWing = new THREE.Vector3(1, 0, 0).applyQuaternion(ship.quaternion)
    expect(rightWing.z).toBeGreaterThan(0.5)
    expect(rightWing.y).toBeLessThan(-0.1)
    // And the nose is still on the heading after the roll.
    const nose = new THREE.Vector3(0, 0, -1).applyQuaternion(ship.quaternion)
    expect(nose.x).toBeCloseTo(1, 5)
  })

  it('is a pure rotation — it never moves the ship', () => {
    const ship = new THREE.Object3D()
    ship.position.set(-3, 9, 21)
    aimShip(ship, new THREE.Vector3(100, 0, 0), -0.5)
    expect(ship.position.toArray()).toEqual([-3, 9, 21])
  })
})
