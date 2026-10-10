// src/boot/app/chase-camera.ts — `?view=chase`: the camera that follows a
// racer, or the player, from behind and above.
//
// Moved verbatim out of `boot/app.ts` (APP-SPLIT phase 1,
// `docs/plan/APP-SPLIT.md`), with `export` added and nothing else; its
// scratch came with it, and stays volatile — valid only inside one call.
// `WORLD_UP` is shared with the closure, which reads it as a constant; the
// `_chase*` scratch is NOT exported (trap 19: never share volatile scratch).

import * as THREE from 'three'
import type { Flight } from '@/game/flight'
import type { LoadedRacers } from '@/game/racers'
import { CHASE_LEAD, CHASE_OFFSET } from './pins'

// Volatile scratch for `chaseCamera`. Valid only inside one synchronous call.
const _chaseForward = new THREE.Vector3()
const _chaseRight = new THREE.Vector3()
const _chaseEye = new THREE.Vector3()
const _chaseLook = new THREE.Vector3()
const _chasePos = new THREE.Vector3()
const _chaseQuat = new THREE.Quaternion()
export const WORLD_UP = new THREE.Vector3(0, 1, 0)

/**
 * Sit behind a racer (or the player) and watch it fly.
 *
 * Heading only, never roll. The ship's own quaternion is used to find FORWARD,
 * and the side axis is then rebuilt against world up — so a racer banking to
 * 0.8 rad through a gate does not take the camera with it.
 *
 * Silently does nothing while the named target does not exist yet, which is
 * every frame before the level finishes loading.
 *
 * **Both targets are read off the object the RENDER placed, never off a sim
 * body** (DEV-319). The player branch used to read `flight.jet.body` — the raw
 * fixed-step pose — while `flight.render` had just put the INTERPOLATED one on
 * `flight.object` (D4), so the camera held the body and the hull glided up to
 * 1.6 m past it at the step phase: Matt's *"our player ship appears to
 * jitter"*. One read for both is what keeps a third branch from reaching for
 * the sim again.
 */
export const chaseCamera = (
  camera: THREE.Camera,
  target: string,
  racers: LoadedRacers | null,
  flight: Flight | null,
): void => {
  const object =
    target === 'player'
      ? (flight?.object ?? null)
      : (racers?.group.getObjectByName(`racer:${target}`) ?? null)
  if (!object) return
  _chasePos.copy(object.position)
  _chaseQuat.copy(object.quaternion)

  // THREE's convention here: the ship's nose is local -z.
  _chaseForward.set(0, 0, -1).applyQuaternion(_chaseQuat)
  // Flatten, or a ship in a steep climb puts the camera underground.
  _chaseForward.y *= 0.35
  if (_chaseForward.lengthSq() < 1e-9) _chaseForward.set(0, 0, -1)
  _chaseForward.normalize()

  _chaseRight.crossVectors(_chaseForward, WORLD_UP)
  if (_chaseRight.lengthSq() < 1e-9) _chaseRight.set(1, 0, 0)
  _chaseRight.normalize()

  _chaseEye
    .copy(_chasePos)
    .addScaledVector(_chaseRight, CHASE_OFFSET[0])
    .addScaledVector(WORLD_UP, CHASE_OFFSET[1])
    .addScaledVector(_chaseForward, -CHASE_OFFSET[2])
  _chaseLook.copy(_chasePos).addScaledVector(_chaseForward, CHASE_LEAD)

  camera.position.copy(_chaseEye)
  camera.up.copy(WORLD_UP)
  camera.lookAt(_chaseLook)
}
