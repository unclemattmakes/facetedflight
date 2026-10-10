// tests/unit/xr-recenter.test.ts — the offset that puts the pilot's eyes back.
//
// `recenterOffset` is separated from the WebXR call precisely so it can be
// tested here, without a headset, a browser, or a session. The property it has
// to have is simple to state and easy to get subtly wrong:
//
//   applying the offset to the viewer's own pose must leave the viewer at the
//   origin, LEVEL, facing -Z — whatever pose they were in.
//
// "Level" is the load-bearing word. Inheriting the head's pitch and roll tilts
// the whole world to match whatever angle someone's neck happened to be at when
// they pressed the button. In a vehicle you are already rolling, a horizon that
// is not level is both wrong and actively nauseating.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { type Pose, recenterOffset } from '@/render/xr-recenter'

const pose = (position: [number, number, number], q: THREE.Quaternion): Pose => ({
  position: { x: position[0], y: position[1], z: position[2] },
  orientation: { x: q.x, y: q.y, z: q.z, w: q.w },
})

const euler = (pitch: number, yaw: number, roll: number) =>
  new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ'))

/** The viewer's pose expressed in the space the offset creates. */
const afterRecentre = (viewer: Pose) => {
  const offset = recenterOffset(viewer)
  const offsetMatrix = new THREE.Matrix4().compose(
    new THREE.Vector3(offset.position.x, offset.position.y, offset.position.z),
    new THREE.Quaternion(
      offset.orientation.x,
      offset.orientation.y,
      offset.orientation.z,
      offset.orientation.w,
    ),
    new THREE.Vector3(1, 1, 1),
  )
  const viewerMatrix = new THREE.Matrix4().compose(
    new THREE.Vector3(viewer.position.x, viewer.position.y, viewer.position.z),
    new THREE.Quaternion(
      viewer.orientation.x,
      viewer.orientation.y,
      viewer.orientation.z,
      viewer.orientation.w,
    ),
    new THREE.Vector3(1, 1, 1),
  )
  // `getOffsetReferenceSpace(t)` makes `t` the new origin, so a pose expressed
  // in the new space is `t^-1 * pose`.
  const result = new THREE.Matrix4().copy(offsetMatrix).invert().multiply(viewerMatrix)
  const position = new THREE.Vector3()
  const quaternion = new THREE.Quaternion()
  result.decompose(position, quaternion, new THREE.Vector3())
  return { position, quaternion }
}

describe('recentring puts the viewer at the origin', () => {
  it('cancels the head position exactly, from anywhere', () => {
    for (const p of [
      [0, 0, 0],
      [0.4, 1.2, -0.9],
      [-3, 0.05, 12],
    ] as [number, number, number][]) {
      const { position } = afterRecentre(pose(p, euler(0, 0.7, 0)))
      expect(position.length(), `from ${p.join(',')}`).toBeLessThan(1e-6)
    }
  })

  it('leaves the viewer facing -Z after any yaw', () => {
    for (const yaw of [0, 0.5, Math.PI / 2, Math.PI, -2.4, 3.1]) {
      const { quaternion } = afterRecentre(pose([0, 0, 0], euler(0, yaw, 0)))
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion)
      expect(forward.z, `yaw ${yaw}`).toBeCloseTo(-1, 5)
    }
  })
})

describe('yaw only — the world must not inherit your neck', () => {
  it('keeps the horizon level when the head is pitched and rolled', () => {
    // The failure: take the full head orientation. Press recentre while looking
    // down at the stick and the entire island tips up to meet you.
    const { quaternion } = afterRecentre(pose([0, 0, 0], euler(0.6, 1.1, -0.4)))
    // Pitch and roll SURVIVE — recentring does not pretend you are looking
    // straight ahead, it only decides which way is forward. What must be gone is
    // the YAW: the head's forward, flattened onto the ground, now points along
    // -Z with nothing left over.
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion)
    const flat = new THREE.Vector3(forward.x, 0, forward.z).normalize()
    expect(flat.z).toBeCloseTo(-1, 5)
    expect(flat.x).toBeCloseTo(0, 5)
  })

  it('produces an offset that is a pure Y rotation', () => {
    // Stated directly on the offset as well as through the round trip, because
    // the round trip would also pass for an offset that happened to cancel.
    const offset = recenterOffset(pose([1, 2, 3], euler(0.5, -0.9, 0.3)))
    expect(offset.orientation.x).toBeCloseTo(0, 9)
    expect(offset.orientation.z).toBeCloseTo(0, 9)
    // ...and it carries the position through untouched.
    expect(offset.position).toEqual({ x: 1, y: 2, z: 3 })
  })

  it('faces the same way on the ground plane as the head does', () => {
    // THIS TEST CAUGHT A REAL BUG, and only after it was rewritten.
    //
    // Its first version asked "does atan2(forward.x, -forward.z) give back the
    // yaw I put in" — using the SAME atan2 convention the implementation used.
    // The implementation had both signs the wrong way round, the oracle had
    // them the wrong way round too, and the test passed while recentring
    // rotated the world in the wrong direction, DOUBLING the error it was meant
    // to cancel. An oracle that shares the code's assumption tests nothing.
    //
    // So this compares two VECTORS instead: the direction the offset faces on
    // the ground plane, and the direction the head faces on the ground plane.
    // No angle convention appears anywhere.
    for (const [pitch, yaw, roll] of [
      [0, 0.7, 0],
      [1.2, 0.7, 0],
      [-0.9, -2.4, 0.5],
      [0.3, 3.0, -1.1],
    ] as [number, number, number][]) {
      const head = euler(pitch, yaw, roll)
      const offset = recenterOffset(pose([0, 0, 0], head))
      const q = new THREE.Quaternion(
        offset.orientation.x,
        offset.orientation.y,
        offset.orientation.z,
        offset.orientation.w,
      )
      const offsetForward = new THREE.Vector3(0, 0, -1).applyQuaternion(q).setY(0).normalize()
      const headForward = new THREE.Vector3(0, 0, -1).applyQuaternion(head).setY(0).normalize()
      expect(offsetForward.dot(headForward), `pitch ${pitch} yaw ${yaw} roll ${roll}`).toBeCloseTo(
        1,
        5,
      )
    }
  })
})

describe('the poses that break a naive implementation', () => {
  it('picks the BODY’s facing when looking straight up or down', () => {
    // Straight up leaves NO forward direction to project onto the ground plane,
    // and someone who has lost the horizon is exactly the person reaching for
    // this button — so it is a normal input, not an edge case.
    //
    // The first version of this test only checked the result was finite and a
    // pure yaw. It was, and it was 180 DEGREES OUT when looking up: the fallback
    // used the head's up-axis unsigned, and tipping your head back points that
    // axis behind you. "Finite and well-formed" is not the same as "right", and
    // a mutation run is what said so.
    //
    // The reference is the yaw the pilot's BODY is facing, which is what they
    // mean by forward however their neck is angled.
    for (const pitch of [Math.PI / 2, -Math.PI / 2]) {
      for (const yaw of [0.9, -2.2, 3.0]) {
        const offset = recenterOffset(pose([0, 1.6, 0], euler(pitch, yaw, 0)))
        const q = new THREE.Quaternion(
          offset.orientation.x,
          offset.orientation.y,
          offset.orientation.z,
          offset.orientation.w,
        )
        expect(Number.isFinite(q.x + q.y + q.z + q.w), `pitch ${pitch}`).toBe(true)
        expect(q.length()).toBeCloseTo(1, 6)
        // Still a pure yaw.
        expect(q.x).toBeCloseTo(0, 9)
        expect(q.z).toBeCloseTo(0, 9)

        // ...and it is the RIGHT yaw. Compared as vectors against a body facing
        // that same yaw with a level head, so no angle convention is shared with
        // the implementation.
        const offsetForward = new THREE.Vector3(0, 0, -1).applyQuaternion(q).setY(0).normalize()
        const bodyForward = new THREE.Vector3(0, 0, -1)
          .applyQuaternion(euler(0, yaw, 0))
          .setY(0)
          .normalize()
        expect(offsetForward.dot(bodyForward), `pitch ${pitch} yaw ${yaw}`).toBeCloseTo(1, 5)
      }
    }
  })

  it('returns an identity rotation rather than NaN for a degenerate quaternion', () => {
    // A caller handing over a zero quaternion is a bug somewhere else, but a
    // NaN reference space poisons every frame afterwards and is very hard to
    // trace back. Fail visibly, not silently.
    const offset = recenterOffset(pose([0, 0, 0], new THREE.Quaternion(0, 0, 0, 0)))
    for (const v of Object.values(offset.orientation)) expect(Number.isFinite(v)).toBe(true)
  })

  it('is idempotent — recentring twice from the recentred pose changes nothing', () => {
    const first = recenterOffset(pose([0.3, 1.5, -0.2], euler(0.2, 1.9, 0.1)))
    const { position, quaternion } = afterRecentre(pose([0.3, 1.5, -0.2], euler(0.2, 1.9, 0.1)))
    const second = recenterOffset(pose([position.x, position.y, position.z], quaternion))
    expect(second.position.x).toBeCloseTo(0, 6)
    expect(second.position.y).toBeCloseTo(0, 6)
    expect(second.position.z).toBeCloseTo(0, 6)
    expect(Math.abs(second.orientation.w)).toBeCloseTo(1, 5)
    // The first offset was not itself a no-op, or this proves nothing.
    expect(Math.abs(first.orientation.w)).toBeLessThan(0.999)
  })
})
