// src/game/ship-camera.ts — a camera pose off the sheet, in the ship's frame.
//
// Its own module because BOTH vehicles read one (`flight.ts`, `jumpseat-flight.ts`)
// and `flight.ts` already imports the JumpSeat loader: a helper defined in
// `flight.ts` and imported back from `jumpseat-flight.ts` is a cycle, and the
// JumpSeat's module-level `JUMPSEAT_THIRD_PERSON` would evaluate it before it
// existed. DEV-128.

import * as THREE from 'three'
import { flipPosition, flipQuaternion, unityVecToThree } from '@/render/unity-space'

/**
 * A camera pose in the SHIP's frame, three space. Where 2016 parented the
 * camera rig on CHANGE VIEW — see `HOVERJET_THIRD_PERSON` in `flight.ts`.
 */
export interface ShipCamera {
  readonly position: THREE.Vector3
  readonly quaternion: THREE.Quaternion
}

/**
 * A `*.camera.*` entry off the sheet, converted the way the ship's own pose is:
 * position flips z, orientation negates x and y (`render/unity-space.ts`).
 * ONE conversion for both vehicles — two would drift, which is how every ghost
 * in the game once flew backwards.
 */
export const shipCameraFromSheet = (entry: {
  readonly positionInShipRootSpace: { readonly x: number; readonly y: number; readonly z: number }
  readonly rotationInShipRootSpace: {
    readonly x: number
    readonly y: number
    readonly z: number
    readonly w: number
  }
}): ShipCamera => {
  const p = entry.positionInShipRootSpace
  const q = entry.rotationInShipRootSpace
  return {
    position: flipPosition(new THREE.Vector3(), p),
    quaternion: flipQuaternion(new THREE.Quaternion(), q),
  }
}

/**
 * What 2016's third-person camera actually DOES, in the ship's frame, three
 * space. DEV-156, and `render/classic-chase.ts` is the mechanism.
 *
 * `ShipCamera` above is where `CamChanger` PARKS the rig. This is where the rig
 * then goes: the constraint stack on that same GameObject, which cuts itself
 * loose from the ship and damps toward a different transform entirely.
 */
export interface ShipChase {
  /** Ship frame, three space. What the damp pulls the camera toward. */
  readonly targetOffset: THREE.Vector3
  /** Ship frame, three space. What the lens points AT — on the HoverJet, the ship itself. */
  readonly aimOffset: THREE.Vector3
  /**
   * Ship frame, three space: a POINT the up vector is taken towards, not a
   * direction (`upVect = upTarget.position - xform.position`). Null means
   * 2016's own fallback, world up — which is what the JumpSeat has.
   */
  readonly upOffset: THREE.Vector3 | null
  /** `SmoothTransformConstraint.positionSpeed` — SmoothDamp's smoothTime, SECONDS. */
  readonly smoothTimeSeconds: number
  /** `positionMaxSpeed`. Unity clamps the ERROR to `maxSpeed × smoothTime`. */
  readonly maxSpeed: number
  /** `SmoothLookAtConstraint.speed`. The Slerp t is `dt × this`, clamped to 1. */
  readonly lookSpeed: number
  /** `FixRoll` is live: the horizon is LEVEL and the camera never banks. */
  readonly zeroRoll: boolean
  /** `DelayedReparent` is live: the root leaves the ship, so the damp is a real trail. */
  readonly detached: boolean
}

/**
 * A `*.camera.thirdPersonChase` entry off the sheet, converted the same way the
 * pose above is: position flips z. ONE conversion for both vehicles, for the
 * same reason — two would drift.
 *
 * The rotations on the sheet are not read. `constrainRotation` is 0 on both
 * shipped prefabs: the transform constraint moves the root and never turns it,
 * and the look constraint decides the orientation from the AIM POINT. A ported
 * quaternion here would be a belief written twice (the orientation lesson).
 */
export const shipChaseFromSheet = (entry: {
  readonly position: {
    readonly target: { readonly positionInShipRootSpace: UnityVec3 } | null
    readonly smoothTimeSeconds: number
    readonly maxSpeed: number
  } | null
  readonly look: {
    readonly target: { readonly positionInShipRootSpace: UnityVec3 } | null
    readonly upTarget: { readonly positionInShipRootSpace: UnityVec3 } | null
    readonly speed: number
  } | null
  readonly detachesFromShip: boolean
  readonly zeroRoll: boolean
}): ShipChase => {
  const toThree = (v: UnityVec3 | undefined): THREE.Vector3 => unityVecToThree(v)
  const up = entry.look?.upTarget?.positionInShipRootSpace
  return {
    targetOffset: toThree(entry.position?.target?.positionInShipRootSpace),
    aimOffset: toThree(entry.look?.target?.positionInShipRootSpace),
    upOffset: up ? toThree(up) : null,
    smoothTimeSeconds: entry.position?.smoothTimeSeconds ?? 0,
    maxSpeed: entry.position?.maxSpeed ?? 0,
    lookSpeed: entry.look?.speed ?? 0,
    zeroRoll: entry.zeroRoll,
    detached: entry.detachesFromShip,
  }
}

interface UnityVec3 {
  readonly x: number
  readonly y: number
  readonly z: number
}
