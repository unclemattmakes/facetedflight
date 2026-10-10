// src/render/hangar-options-plate.ts: where the pause plate stands when the
// hangar's OPTIONS table opens it (DEV-857).
//
// Matt, 2026-10-08: *"the options table should show the pause panel's OPTIONS
// page."* The page is the pause plate's own (`render/pause.ts`: sound, controls,
// comfort, edition, advanced, credits), drawn on a `createPause` plate. In a
// mission that plate hangs in the cockpit 0.86 m from the eye; in the hangar it
// stands where the letter plate does (`room-code-plate.ts`): 2.0 m out,
// composed onto the CHAIR's home forward so it keeps still while the seat
// turns. Its SIZE is the pause plate's angular size (DEV-882,
// `options-plate-pose.ts`): the same card, scaled by distance. Pure here, so a
// test can hold it in frame without a canvas.

import * as THREE from 'three'
import { seatPitchLocal } from '@/render/hangar'
import { type OptionsPlatePose, optionsPlatePoseAt } from '@/render/options-plate-pose'

/**
 * The plate's pose under the rig: position, and the scale that sizes it. On a
 * flat screen it is centred on the chair's resting look (down at the tables);
 * in a headset its top edge hangs where the title's rows do.
 */
export const optionsPlatePose = (rows: number, bodyM = 0, flat = false): OptionsPlatePose =>
  optionsPlatePoseAt(rows, bodyM, flat, seatPitchLocal())

const _tilt = new THREE.Quaternion()
const X = new THREE.Vector3(1, 0, 0)

/**
 * Put the plate in the hangar, in front of the chair: the pose composed onto
 * the seat's home forward, its face (+z) toward the eye.
 */
export const placeOptionsPlateInRoom = (
  object: THREE.Object3D,
  rows: number,
  bodyM: number,
  seatWorld: THREE.Vector3,
  seatQuaternion: THREE.Quaternion,
  flat = false,
): void => {
  const { position, scale, tilt } = optionsPlatePose(rows, bodyM, flat)
  object.position
    .set(position[0], position[1], position[2])
    .applyQuaternion(seatQuaternion)
    .add(seatWorld)
  // Tipped square to the eye on a flat screen (0 in a headset).
  object.quaternion.copy(seatQuaternion).multiply(_tilt.setFromAxisAngle(X, tilt))
  object.scale.setScalar(scale)
  object.name = 'hangar-options-plate'
}
