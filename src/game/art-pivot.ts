// src/game/art-pivot.ts — the point the cockpit leans ABOUT. DEV-365.
//
// Both ships hang their art off an `art_pivot` that the camera does not
// inherit, and `Rotator_Input` — which lives ON that GameObject, the only
// component there besides its Transform — turns it by `transform.localRotation`.
// A local rotation turns a node about its OWN origin, so 2016's cockpit leans
// about wherever the prefab put `art_pivot`, and the prefab did not put it at
// the ship's origin:
//
//   PlayerShip_SR14_Photon   shipOffset (0, -0.17, 0) / art_pivot (0, 0.29, -1.16)
//                            -> ship (0, 0.12, -1.16), THREE (0, 0.12, 1.16)
//   JumpSeat_Photon          offset (0, 0.42, 0.04) / art_pivot (1) (-0.0203, 0.73, 0.1187)
//                            -> ship (-0.0203, 1.15, 0.1587), THREE (-0.0203, 1.15, -0.1587)
//
// Until DEV-365 both ports built the pivot at the ship's origin and carried the
// prefab's offset on the art instead. That is the same place for the art at
// rest and a different place the moment it turns: the HoverJet's eye is 0.75 m
// from 2016's pivot and 1.53 m from the origin, so the cockpit round your head
// swung about twice as far as 2016's did. `tests/unit/art-pivot.test.ts`
// measures it against the prefab.
//
// So the pivot now stands where 2016's does, and everything hung on it is
// placed in ITS frame: `onPivot` turns a ship-frame point into that frame.
//
// ── The Euler order ───────────────────────────────────────────────────────
//
// `Quaternion.Euler(x, y, z)` turns about z, then x, then y, all about the
// PARENT's axes: R = Ry·Rx·Rz. three names an order by the axes it turns about
// in the OBJECT's frame, first to last, so the same product is three's `'YXZ'`
// (`render/classic-chase.ts` wrote this down for `FixRoll`). The pivot used
// `'ZXY'`, which is Rz·Rx·Ry — the right three angles composed backwards. With
// yaw always 0 that is Rz·Rx against 2016's Rx·Rz, apart by a yaw of about
// pitch x roll: 0.44 degrees at the full diagonal lean, ~6 mm at the dash.
//
// The handedness conversion is unchanged and was right: our world is Unity's
// mirrored in z, which negates a rotation about x or y and leaves one about z
// alone, so a Unity lean (pitch, 0, roll) is three's (-pitch, 0, +roll).

import * as THREE from 'three'
import type { CockpitShakeSample } from '@/game/cockpit-shake'

/** A point, structurally — the sheet's plain objects and three's vectors both fit. */
export interface PointLike {
  readonly x: number
  readonly y: number
  readonly z: number
}

/**
 * A ship-frame point re-expressed in the frame of a pivot standing at `pivot`
 * (THREE space, ship frame) — at rest, which is the frame everything hung on
 * the pivot is authored in. The pivot has no rest rotation or scale on either
 * shipped prefab, so this is a subtraction; `art-pivot.test.ts` reads both.
 */
export const onPivot = (point: PointLike, pivot: PointLike): THREE.Vector3 =>
  new THREE.Vector3(point.x - pivot.x, point.y - pivot.y, point.z - pivot.z)

/**
 * Pose an art pivot: 2016's lean, in Unity DEGREES off `sim/art-lean.ts`, plus
 * the Anniversary buffet (metres and radians, `game/cockpit-shake.ts`), about
 * the pivot's own point `pivot` in the ship's frame. Writes the node and
 * nothing else — the camera is not under it, which is the whole point.
 */
export const poseArtPivot = (
  node: THREE.Object3D,
  pivot: PointLike,
  leanPitch: number,
  leanRoll: number,
  buffet: CockpitShakeSample,
): void => {
  node.rotation.set(
    -THREE.MathUtils.degToRad(leanPitch) + buffet.pitch,
    0,
    THREE.MathUtils.degToRad(leanRoll) + buffet.roll,
    'YXZ',
  )
  node.position.set(pivot.x + buffet.x, pivot.y + buffet.y, pivot.z + buffet.z)
}
