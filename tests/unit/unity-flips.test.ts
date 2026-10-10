// tests/unit/unity-flips.test.ts: every hand-written Unity -> three flip that
// was folded onto `render/unity-space.ts` (code-reuse audit XC-9, WP-4).
//
// A replacement is only legitimate if it computes EXACTLY what it replaced, so
// each old inline expression is copied below as an ORACLE (named `old*`) and
// compared with Object.is against the call that stands in its place, over a few
// thousand random poses that include the awkward values (zero, negative zero,
// unnormalised quaternions, huge and tiny magnitudes). Object.is, not toBeCloseTo:
// the point is that no float operation moved, and it tells -0 from 0.
//
// The sites that are exported (`childMatrixOf`, `landmarkMatrixOf`,
// `shipCameraFromSheet`, `probeRotationFor`) are driven through the REAL
// function. The ones inside a closure or a module-private helper (flight.ts and
// jumpseat-flight.ts `render`, jumpseat-art.ts `placeUnity`, app.ts's launch
// anchor) are compared through the primitive they now call, since that call is
// the whole of what changed there.
//
// And, because an oracle copied from the code under test only proves the
// refactor and not the rule (CLAUDE.md, "test the geometry, not the rotation"),
// the last describe measures GEOMETRY: a known asymmetric offset lands where the
// 2016 conversion says it must, and distances survive the flip.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { SHIP_GROUND_CONTACT } from '@/game/cockpit-common'
import { childMatrixOf, landmarkMatrixOf } from '@/game/props/load-props'
import { shipCameraFromSheet } from '@/game/ship-camera'
import { probeRotationFor } from '@/render/hangar-light'
import {
  applyUnityPose,
  flipPosition,
  flipQuaternion,
  unityPositionTupleToThree,
  unityQuatTupleToThree,
  unityVecToThree,
} from '@/render/unity-space'

// ── a seeded stream, so a failure names its sample ────────────────────────

const stream = (seed: number) => {
  let s = seed >>> 0
  const next = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
  return {
    next,
    /** Mostly ordinary values, sometimes the ones that expose a sign or a default. */
    value: (): number => {
      const pick = next()
      if (pick < 0.04) return 0
      if (pick < 0.08) return -0
      if (pick < 0.12) return 1e-12 * (next() - 0.5)
      if (pick < 0.16) return 1e6 * (next() - 0.5)
      return (next() - 0.5) * 400
    },
  }
}

const SAMPLES = 4000

const same = (a: number, b: number): boolean => Object.is(a, b)

const sameVec = (a: THREE.Vector3, b: THREE.Vector3): boolean =>
  same(a.x, b.x) && same(a.y, b.y) && same(a.z, b.z)

const sameQuat = (a: THREE.Quaternion, b: THREE.Quaternion): boolean =>
  same(a.x, b.x) && same(a.y, b.y) && same(a.z, b.z) && same(a.w, b.w)

const sameMatrix = (a: THREE.Matrix4, b: THREE.Matrix4): boolean =>
  a.elements.every((e, i) => same(e, b.elements[i] as number))

// ── ORACLES: the inline expressions as they stood before the fold ─────────

/** flight.ts `render` and jumpseat-flight.ts `render` (identical lines in both). */
const oldRenderPose = (
  object: THREE.Object3D,
  lerpPos: THREE.Vector3,
  slerpQuat: THREE.Quaternion,
): void => {
  object.position.set(lerpPos.x, lerpPos.y, -lerpPos.z)
  object.quaternion.set(-slerpQuat.x, -slerpQuat.y, slerpQuat.z, slerpQuat.w)
}

/** jumpseat-art.ts `placeUnity`, pose half. */
const oldPlaceUnity = (
  object: THREE.Object3D,
  t: { position: THREE.Vector3; rotation: THREE.Quaternion },
): void => {
  object.position.set(t.position.x, t.position.y, -t.position.z)
  object.quaternion.set(-t.rotation.x, -t.rotation.y, t.rotation.z, t.rotation.w)
}

/** boot/app.ts, the launch anchor: position drops by `drop` first, then flips. */
const oldAnchor = (
  anchor: THREE.Object3D,
  p0: THREE.Vector3,
  q0: THREE.Quaternion,
  drop: number,
): void => {
  anchor.position.set(p0.x, p0.y - drop, -p0.z)
  anchor.quaternion.set(-q0.x, -q0.y, q0.z, q0.w)
}

/** game/props/load-props.ts, the private `unityQuatToThree`. */
const oldUnityQuatToThree = (q: readonly number[]): THREE.Quaternion =>
  new THREE.Quaternion(-(q[0] ?? 0), -(q[1] ?? 0), q[2] ?? 0, q[3] ?? 1)

/** game/props/load-props.ts, `childMatrixOf` as it was. */
const oldChildMatrixOf = (
  mt: { position: readonly number[]; rotation: readonly number[]; scale: readonly number[] } | null,
  out: THREE.Matrix4,
): THREE.Matrix4 => {
  const childPos = new THREE.Vector3(
    mt?.position[0] ?? 0,
    mt?.position[1] ?? 0,
    -(mt?.position[2] ?? 0),
  )
  const childQuat = mt ? oldUnityQuatToThree(mt.rotation) : new THREE.Quaternion()
  const childScale = new THREE.Vector3(mt?.scale[0] ?? 1, mt?.scale[1] ?? 1, mt?.scale[2] ?? 1)
  return out.compose(childPos, childQuat, childScale)
}

/** game/props/load-props.ts, `landmarkMatrixOf` as it was. */
const oldLandmarkMatrixOf = (
  landmark: {
    position: readonly number[]
    rotation?: readonly number[] | null
    scale?: readonly number[] | null
  },
  terrainLocalPosition: readonly number[],
  out: THREE.Matrix4,
): THREE.Matrix4 => {
  const p = landmark.position
  const pos = new THREE.Vector3(
    (p[0] ?? 0) - (terrainLocalPosition[0] ?? 0),
    (p[1] ?? 0) - (terrainLocalPosition[1] ?? 0),
    -((p[2] ?? 0) - (terrainLocalPosition[2] ?? 0)),
  )
  const quat = new THREE.Quaternion().copy(
    landmark.rotation ? oldUnityQuatToThree(landmark.rotation) : new THREE.Quaternion(),
  )
  const s = landmark.scale ?? [1, 1, 1]
  return out.compose(pos, quat, new THREE.Vector3(s[0] ?? 1, s[1] ?? 1, s[2] ?? 1))
}

/** game/ship-camera.ts `shipCameraFromSheet`, the pose half and the private `toThree`. */
const oldShipCamera = (p: { x: number; y: number; z: number }, q: THREE.Quaternion) => ({
  position: new THREE.Vector3(p.x, p.y, -p.z),
  quaternion: new THREE.Quaternion(-q.x, -q.y, q.z, q.w),
})
const oldToThree = (v: { x?: number; y?: number; z?: number } | undefined): THREE.Vector3 =>
  new THREE.Vector3(v?.x ?? 0, v?.y ?? 0, -(v?.z ?? 0))

/** render/hangar-light.ts `probeRotationFor` as it was. */
const oldProbeRotationFor = (
  sky: readonly [number, number, number, number],
  world: THREE.Quaternion,
): [number, number, number, number] => {
  const r = new THREE.Quaternion(-world.x, -world.y, world.z, world.w).multiply(
    new THREE.Quaternion(sky[0], sky[1], sky[2], sky[3]),
  )
  return [r.x, r.y, r.z, r.w]
}

// ── the comparisons ───────────────────────────────────────────────────────

describe('applyUnityPose is the pose block flight.ts, jumpseat-flight.ts and jumpseat-art.ts wrote out', () => {
  it('matches the render() block bit for bit', () => {
    const rng = stream(0xf1197)
    const a = new THREE.Object3D()
    const b = new THREE.Object3D()
    const pos = new THREE.Vector3()
    const quat = new THREE.Quaternion()
    for (let i = 0; i < SAMPLES; i++) {
      pos.set(rng.value(), rng.value(), rng.value())
      quat.set(rng.value(), rng.value(), rng.value(), rng.value())
      oldRenderPose(a, pos, quat)
      applyUnityPose(b, pos, quat)
      expect(sameVec(a.position, b.position), `position sample ${i}`).toBe(true)
      expect(sameQuat(a.quaternion, b.quaternion), `quaternion sample ${i}`).toBe(true)
    }
  })

  it('keeps the Euler mirror of the quaternion in step (the callback fires either way)', () => {
    const rng = stream(0xe01e5)
    const a = new THREE.Object3D()
    const b = new THREE.Object3D()
    for (let i = 0; i < 500; i++) {
      const q = new THREE.Quaternion(rng.value(), rng.value(), rng.value(), rng.value()).normalize()
      oldRenderPose(a, new THREE.Vector3(1, 2, 3), q)
      applyUnityPose(b, { x: 1, y: 2, z: 3 }, q)
      expect(Object.is(a.rotation.x, b.rotation.x)).toBe(true)
      expect(Object.is(a.rotation.y, b.rotation.y)).toBe(true)
      expect(Object.is(a.rotation.z, b.rotation.z)).toBe(true)
    }
  })

  it('matches jumpseat-art placeUnity (the pose half; scale is untouched)', () => {
    const rng = stream(0x1a15)
    const a = new THREE.Object3D()
    const b = new THREE.Object3D()
    for (let i = 0; i < SAMPLES; i++) {
      const t = {
        position: new THREE.Vector3(rng.value(), rng.value(), rng.value()),
        rotation: new THREE.Quaternion(rng.value(), rng.value(), rng.value(), rng.value()),
      }
      oldPlaceUnity(a, t)
      applyUnityPose(b, t.position, t.rotation)
      expect(sameVec(a.position, b.position), `position sample ${i}`).toBe(true)
      expect(sameQuat(a.quaternion, b.quaternion), `quaternion sample ${i}`).toBe(true)
    }
  })

  it('matches the launch anchor in app.ts, with the drop applied to y before the call', () => {
    const rng = stream(0xa9c40)
    const a = new THREE.Object3D()
    const b = new THREE.Object3D()
    for (let i = 0; i < SAMPLES; i++) {
      const p0 = new THREE.Vector3(rng.value(), rng.value(), rng.value())
      const q0 = new THREE.Quaternion(rng.value(), rng.value(), rng.value(), rng.value())
      const drop = rng.value()
      oldAnchor(a, p0, q0, drop)
      applyUnityPose(b, { x: p0.x, y: p0.y - drop, z: p0.z }, q0)
      expect(sameVec(a.position, b.position), `position sample ${i}`).toBe(true)
      expect(sameQuat(a.quaternion, b.quaternion), `quaternion sample ${i}`).toBe(true)
    }
  })
})

describe('the tuple and optional-field helpers keep the defaults they replaced', () => {
  it('unityQuatTupleToThree matches load-props unityQuatToThree, short tuples included', () => {
    const rng = stream(0x7a7)
    for (let i = 0; i < SAMPLES; i++) {
      const len = Math.floor(rng.next() * 5)
      const q = Array.from({ length: len }, () => rng.value())
      expect(
        sameQuat(unityQuatTupleToThree(q), oldUnityQuatToThree(q)),
        `sample ${i} len ${len}`,
      ).toBe(true)
    }
  })

  it('unityQuatTupleToThree writes into the out it is given', () => {
    const out = new THREE.Quaternion()
    const r = unityQuatTupleToThree([1, 2, 3, 4], out)
    expect(r).toBe(out)
    expect([out.x, out.y, out.z, out.w]).toEqual([-1, -2, 3, 4])
  })

  it('unityVecToThree matches ship-camera toThree, absent and partial inputs included', () => {
    const rng = stream(0x7ec)
    for (let i = 0; i < SAMPLES; i++) {
      const v: { x?: number; y?: number; z?: number } | undefined =
        rng.next() < 0.1
          ? undefined
          : {
              ...(rng.next() < 0.8 ? { x: rng.value() } : {}),
              ...(rng.next() < 0.8 ? { y: rng.value() } : {}),
              ...(rng.next() < 0.8 ? { z: rng.value() } : {}),
            }
      expect(sameVec(unityVecToThree(v), oldToThree(v)), `sample ${i}`).toBe(true)
    }
  })

  it('unityPositionTupleToThree matches the inline position flip in childMatrixOf', () => {
    const rng = stream(0x9051)
    for (let i = 0; i < SAMPLES; i++) {
      const mt =
        rng.next() < 0.1
          ? null
          : { position: Array.from({ length: Math.floor(rng.next() * 4) }, () => rng.value()) }
      const old = new THREE.Vector3(
        mt?.position[0] ?? 0,
        mt?.position[1] ?? 0,
        -(mt?.position[2] ?? 0),
      )
      expect(sameVec(unityPositionTupleToThree(mt?.position), old), `sample ${i}`).toBe(true)
    }
  })
})

describe('the real call sites still compute what they computed', () => {
  it('childMatrixOf (load-props) matches its old body, null and short tuples included', () => {
    const rng = stream(0xc41d)
    for (let i = 0; i < SAMPLES; i++) {
      const mt =
        rng.next() < 0.1
          ? null
          : {
              position: Array.from({ length: 3 }, () => rng.value()),
              rotation: Array.from({ length: 4 }, () => rng.value()).map((v) => v),
              scale: Array.from({ length: 3 }, () => rng.value()),
            }
      const got = childMatrixOf(mt, new THREE.Matrix4())
      const want = oldChildMatrixOf(mt, new THREE.Matrix4())
      expect(sameMatrix(got, want), `sample ${i}`).toBe(true)
    }
  })

  it('landmarkMatrixOf (load-props) matches its old body, with and without a rotation', () => {
    const rng = stream(0x1a4d)
    for (let i = 0; i < SAMPLES; i++) {
      const landmark = {
        name: 'rock',
        mesh: 'rock',
        position: [rng.value(), rng.value(), rng.value()],
        ...(rng.next() < 0.7
          ? { rotation: [rng.value(), rng.value(), rng.value(), rng.value()] }
          : {}),
        ...(rng.next() < 0.7 ? { scale: [rng.value(), rng.value(), rng.value()] } : {}),
      }
      const terrain = [rng.value(), rng.value(), rng.value()]
      const got = landmarkMatrixOf(landmark as never, terrain, new THREE.Matrix4())
      const want = oldLandmarkMatrixOf(landmark, terrain, new THREE.Matrix4())
      expect(sameMatrix(got, want), `sample ${i}`).toBe(true)
    }
  })

  it('shipCameraFromSheet matches its old body', () => {
    const rng = stream(0x5c4a)
    for (let i = 0; i < SAMPLES; i++) {
      const p = { x: rng.value(), y: rng.value(), z: rng.value() }
      const q = { x: rng.value(), y: rng.value(), z: rng.value(), w: rng.value() }
      const got = shipCameraFromSheet({ positionInShipRootSpace: p, rotationInShipRootSpace: q })
      const want = oldShipCamera(p, new THREE.Quaternion(q.x, q.y, q.z, q.w))
      expect(sameVec(got.position, want.position), `position sample ${i}`).toBe(true)
      expect(sameQuat(got.quaternion, want.quaternion), `quaternion sample ${i}`).toBe(true)
    }
  })

  it('probeRotationFor (hangar-light) matches its old body', () => {
    const rng = stream(0x9b0be)
    for (let i = 0; i < SAMPLES; i++) {
      const sky = [rng.value(), rng.value(), rng.value(), rng.value()] as [
        number,
        number,
        number,
        number,
      ]
      const world = new THREE.Quaternion(rng.value(), rng.value(), rng.value(), rng.value())
      const got = probeRotationFor(sky, world)
      const want = oldProbeRotationFor(sky, world)
      expect(
        got.every((v, k) => same(v, want[k] as number)),
        `sample ${i}`,
      ).toBe(true)
    }
  })
})

// ── geometry: true whatever the code believes ─────────────────────────────

describe('the conversion is a mirror in z, measured on points', () => {
  // A Unity-space rotation rotates a vector with the same algebra three uses
  // (q v q^-1), so a three Quaternion holding Unity's numbers computes Unity's
  // answer. The EXPECTED three-space point is therefore "rotate in Unity space,
  // then negate z", which involves no flipQuaternion at all.
  const unityWorldPoint = (p: THREE.Vector3, q: THREE.Quaternion, local: THREE.Vector3) =>
    local.clone().applyQuaternion(q).add(p)

  it('a ship nose, 3 m along Unity +Z, yawed 90 degrees, lands 3 m along +X in the world', () => {
    // Unity: ship at (10, 20, 100), yaw 90 about +Y, nose at local (0, 0, 3).
    // Left-handed yaw takes +Z to +X, so the nose is at (13, 20, 100) in Unity
    // and at (13, 20, -100) in three. Written out by hand, not derived.
    const half = Math.SQRT1_2
    const unityQuat = new THREE.Quaternion(0, half, 0, half)
    const object = new THREE.Object3D()
    applyUnityPose(object, { x: 10, y: 20, z: 100 }, unityQuat)
    // The converted mesh puts the nose on three's -Z (the mirror), local (0, 0, -3).
    const nose = object.localToWorld(new THREE.Vector3(0, 0, -3))
    expect(nose.x).toBeCloseTo(13, 9)
    expect(nose.y).toBeCloseTo(20, 9)
    expect(nose.z).toBeCloseTo(-100, 9)
  })

  it('an asymmetric offset, rotated by a tilted body, lands where rotate-then-mirror says', () => {
    const rng = stream(0x6e0)
    const object = new THREE.Object3D()
    for (let i = 0; i < 300; i++) {
      const p = new THREE.Vector3(rng.value(), rng.value(), rng.value())
      const q = new THREE.Quaternion(rng.value(), rng.value(), rng.value(), rng.value()).normalize()
      // Deliberately lopsided in all three axes, so no sign can cancel.
      const local = new THREE.Vector3(0.3, -1.7, 4.4)
      const expected = flipPosition(new THREE.Vector3(), unityWorldPoint(p, q, local))
      applyUnityPose(object, p, q)
      object.updateMatrixWorld(true)
      // The mesh arrives mirrored: its local offset is the flipped one.
      const got = object.localToWorld(flipPosition(new THREE.Vector3(), local))
      expect(got.distanceTo(expected), `sample ${i}`).toBeLessThan(1e-7)
    }
  })

  it('distances between two body points are the same on both sides of the flip', () => {
    const rng = stream(0xd157)
    const object = new THREE.Object3D()
    const a = new THREE.Vector3(1.1, 2.2, 3.3)
    const b = new THREE.Vector3(-0.4, 0.9, -2.5)
    for (let i = 0; i < 300; i++) {
      const p = new THREE.Vector3(rng.value(), rng.value(), rng.value())
      const q = new THREE.Quaternion(rng.value(), rng.value(), rng.value(), rng.value()).normalize()
      const unityGap = unityWorldPoint(p, q, a).distanceTo(unityWorldPoint(p, q, b))
      applyUnityPose(object, p, q)
      object.updateMatrixWorld(true)
      const threeGap = object
        .localToWorld(flipPosition(new THREE.Vector3(), a))
        .distanceTo(object.localToWorld(flipPosition(new THREE.Vector3(), b)))
      expect(Math.abs(threeGap - unityGap), `sample ${i}`).toBeLessThan(1e-7)
    }
  })

  it('a ship-camera offset behind and above the ship stays behind and above it', () => {
    // A camera 2 m above and 8 m BEHIND the ship: Unity -Z is behind. In the
    // converted mesh frame behind is three +Z, which is the sign a dropped
    // negation would turn into "in front of the nose".
    const cam = shipCameraFromSheet({
      positionInShipRootSpace: { x: 0, y: 2, z: -8 },
      rotationInShipRootSpace: { x: 0, y: 0, z: 0, w: 1 },
    })
    expect(cam.position.x).toBe(0)
    expect(cam.position.y).toBe(2)
    expect(cam.position.z).toBe(8)
    // And a pure x lean (pitch) conjugates to the opposite pitch about the mirrored axis.
    const pitch = unityQuatTupleToThree([Math.sin(0.2), 0, 0, Math.cos(0.2)])
    const q = flipQuaternion(new THREE.Quaternion(), {
      x: Math.sin(0.2),
      y: 0,
      z: 0,
      w: Math.cos(0.2),
    })
    expect(sameQuat(pitch, q)).toBe(true)
    expect(pitch.x).toBeCloseTo(-Math.sin(0.2), 12)
  })
})

describe('the ground-contact values both cockpits spread into their collision spec (XC-10)', () => {
  it('are the shipped ones, pinned in one place', () => {
    // `Ship_HoverShip.Flash()`: WaitForSeconds(0.3f), angular drag x3; Unity's
    // default material has no bounce and 0.6 friction. Edit this on purpose.
    expect(SHIP_GROUND_CONTACT).toEqual({
      restitution: 0,
      friction: 0.6,
      flashSeconds: 0.3,
      flashAngularDrag: 3,
    })
  })
})
