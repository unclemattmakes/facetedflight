// src/render/classic-chase.ts — 2016's OWN third-person camera, ported. DEV-156.
//
// ── What this is, and what it replaces ────────────────────────────────────
//
// DEV-128 read `CamChanger.ChangeCam()`'s `SetParent(camTargets[1], false)` as
// the whole third-person camera and gave Classic a RIGID mount at
// `CamRoot_3rdPerson` — 8.89 m behind the HoverJet, welded, no trail. DEV-150
// found the arm is really 12.5 m and that it lags, and retargeted the
// Anniversary spring; it left Classic drawing the parked pose and wrote the
// defect up. This file is the fix: the shipped constraint stack, ported.
//
// The reparent IS rigid. It parks the rig on a GameObject that does not stay
// still. `shipOffset/CamRoot_3rdPerson` on
// `Resources/PlayerShip_SR14_Photon.prefab` carries FOUR live components
// (`m_Enabled: 1`, whole `m_Father` chain `m_IsActive: 1`), and every one of
// them matters:
//
//   1. `DelayedReparent`  — `Start()` → `WaitForSeconds(0.25f)` →
//      `transform.parent = null`. The camera root is CUT LOOSE FROM THE SHIP a
//      quarter second into the level.
//   2. `SmoothTransformConstraint` — `Vector3.SmoothDamp` (`DampLimited`) on
//      its WORLD position toward `cam target 3rdPerson`, 12.5 m back and 1.7 m
//      up in the ship's frame. `positionSpeed` is SmoothDamp's smoothTime.
//   3. `SmoothLookAtConstraint` — `Quaternion.Slerp` toward a `LookRotation` at
//      `cam target_look_3rdPerson`, which on the HoverJet is 0.27 m behind the
//      ship's own origin: it aims at the SHIP, not down the arm.
//   4. `FixRoll` — `LateUpdate()` → `localEulerAngles = (x, y, 0)`.
//
// ── Why (1) is the load-bearing one ───────────────────────────────────────
//
// Without `DelayedReparent` this whole stack is a NO-OP at steady state, and
// the rigid reading would have been right after all. A transform carried by its
// parent has the same world delta applied to it as to a target parented to the
// same ship, so the SmoothDamp error is untouched by the ship's motion and
// decays to zero: a welded 12.5 m mount, trail and all cancelled. Detached, the
// error is real and the camera settles about `speed × smoothTime` further back.
// The structure decides the number, which is why `detached` is a field here and
// not an assumption — point this at a prefab without the component and it draws
// the rigid camera, because that is what such a prefab would do.
//
// ── And (4) is the one you can SEE ────────────────────────────────────────
//
// `FixRoll` means 2016's third-person horizon is LEVEL, always. The camera
// never banks with the ship. Zeroing the `z` of a ZXY euler leaves the forward
// vector alone — a rotation about z fixes the z axis — so it takes out the roll
// and leaves the aim untouched. The Anniversary preset's `rollFollow` 0.35 is
// therefore a DEVIATION, not a port, and `docs/DEVIATIONS.md` now says so.
//
// ── Frame rate ────────────────────────────────────────────────────────────
//
// SmoothDamp integrates `dt`, so the position is frame-rate independent. The
// look is `Quaternion.Slerp(cur, want, dt * speed)` with the t CLAMPED to 1 —
// which is frame-rate DEPENDENT, and at the HoverJet's `speed: 225` it is
// pinned at 1 for any frame rate at or below 225 fps. So on the HoverJet the
// aim is simply instantaneous, and it is the JumpSeat's 35 that smooths.
// Ported verbatim, clamp included, rather than rewritten as an exponential:
// this is the Classic preset, and 2016's frame-rate dependence is 2016's.
//
// Every number is off the generated sheet (`*.camera.thirdPersonChase`), never
// typed here — DEV-069: when you implement something the sheet has a key for,
// import the key. The only literals in this file are Unity's own SmoothDamp
// coefficients, which are the algorithm and not a tuning value.

import * as THREE from 'three'
import type { ShipChase } from '@/game/ship-camera'

/**
 * `Vector3.SmoothDamp`, Unity's, verbatim — including the `maxSpeed` clamp on
 * the ERROR (not on the speed: Unity clamps `change` to `maxSpeed × smoothTime`)
 * and the overshoot guard. `current` and `velocity` are written in place.
 *
 * Exported so the test can drive it directly against hand-worked values, and
 * because it is the one piece here with an outside oracle: it is
 * `Runtime/Export/Math/Vector3.cs`, and Game Programming Gems 4 §1.10 before
 * that. `smoothTime` is floored at 1e-4 the way Unity floors it.
 */
export const smoothDamp = (
  current: THREE.Vector3,
  target: THREE.Vector3,
  velocity: THREE.Vector3,
  smoothTime: number,
  maxSpeed: number,
  dt: number,
): void => {
  const st = Math.max(1e-4, smoothTime)
  const omega = 2 / st
  const x = omega * dt
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x)

  let changeX = current.x - target.x
  let changeY = current.y - target.y
  let changeZ = current.z - target.z

  // Unity clamps the ERROR to `maxSpeed * smoothTime`. On the HoverJet that is
  // 695 × 0.066 = 45.9 m and never binds; on the JumpSeat it is 100 × 0.1 =
  // 10 m and does — 2016's own `maxLagMetres`, on one vehicle only.
  const maxChange = maxSpeed * st
  const sqrMag = changeX * changeX + changeY * changeY + changeZ * changeZ
  if (sqrMag > maxChange * maxChange) {
    const mag = Math.sqrt(sqrMag)
    changeX = (changeX / mag) * maxChange
    changeY = (changeY / mag) * maxChange
    changeZ = (changeZ / mag) * maxChange
  }

  // Unity shifts the target to the clamped error, then integrates about it.
  const shiftedX = current.x - changeX
  const shiftedY = current.y - changeY
  const shiftedZ = current.z - changeZ

  const tempX = (velocity.x + omega * changeX) * dt
  const tempY = (velocity.y + omega * changeY) * dt
  const tempZ = (velocity.z + omega * changeZ) * dt

  velocity.set(
    (velocity.x - omega * tempX) * exp,
    (velocity.y - omega * tempY) * exp,
    (velocity.z - omega * tempZ) * exp,
  )

  let outX = shiftedX + (changeX + tempX) * exp
  let outY = shiftedY + (changeY + tempY) * exp
  let outZ = shiftedZ + (changeZ + tempZ) * exp

  // Overshoot guard: if the step crossed the ORIGINAL target, stop dead on it.
  const origMinusCurX = target.x - current.x
  const origMinusCurY = target.y - current.y
  const origMinusCurZ = target.z - current.z
  const outMinusOrigX = outX - target.x
  const outMinusOrigY = outY - target.y
  const outMinusOrigZ = outZ - target.z
  if (
    origMinusCurX * outMinusOrigX + origMinusCurY * outMinusOrigY + origMinusCurZ * outMinusOrigZ >
    0
  ) {
    outX = target.x
    outY = target.y
    outZ = target.z
    velocity.set(0, 0, 0)
  }
  current.set(outX, outY, outZ)
}

/**
 * `FixRoll.LateUpdate()`: `transform.localEulerAngles = (x, y, 0)`.
 *
 * Unity's euler order is ZXY, which is three's `'YXZ'` — both mean
 * `R = Ry·Rx·Rz` — so this is the same decomposition, not a lookalike. Dropping
 * the `z` term leaves the ±z axis exactly where it was, so the aim survives and
 * only the bank goes. Degenerate looking straight up or down, where yaw and
 * roll are the same rotation; 2016 has the same degeneracy in the same place,
 * and a camera 12.5 m behind and 1.7 m above a ship it is pointing at never
 * gets near it.
 */
export const levelRoll = (q: THREE.Quaternion): void => {
  _euler.setFromQuaternion(q, 'YXZ')
  _euler.z = 0
  q.setFromEuler(_euler)
}

export interface ClassicChaseInput {
  /** The ship's interpolated pose, THREE space — `flight.object` after `render()`. */
  readonly shipPosition: THREE.Vector3
  readonly shipQuaternion: THREE.Quaternion
  /** RENDER seconds since the last update. `Time.deltaTime` inside the coroutine. */
  readonly dt: number
}

export interface ClassicChase {
  /** Where the camera goes. World space. Read after `update`. */
  readonly position: THREE.Vector3
  readonly quaternion: THREE.Quaternion
  update(spec: ShipChase, input: ClassicChaseInput): void
  /**
   * Forget the damp. The next `update` snaps onto the target with zero damp
   * velocity — for the first frame after CHANGE VIEW, so the camera does not
   * fly in from the cockpit. 2016 gets the same effect from the 0.12 s fade out
   * and 0.2 s wait in `ChangeCam()`; we get it from a snap and a cut.
   */
  reset(): void
}

export const createClassicChase = (): ClassicChase => {
  const position = new THREE.Vector3()
  const quaternion = new THREE.Quaternion()
  // `curDampVelocity` on the constraint: WORLD metres per second, and it
  // persists across frames — it is the whole reason the trail has momentum.
  const dampVelocity = new THREE.Vector3()
  let fresh = true

  // Volatile scratch, valid inside one `update` only — never stored, never read
  // before it is written (trap 19).
  const _target = new THREE.Vector3()
  const _aim = new THREE.Vector3()
  const _up = new THREE.Vector3()

  return {
    position,
    quaternion,
    reset() {
      fresh = true
    },
    update(spec, input) {
      // 1. The chased point and the aim point, in the SHIP's frame. Both rotate
      //    with the ship's FULL attitude, roll included — which is what swings
      //    the camera wide on the outside of a banked turn.
      _target.copy(spec.targetOffset).applyQuaternion(input.shipQuaternion).add(input.shipPosition)
      _aim.copy(spec.aimOffset).applyQuaternion(input.shipQuaternion).add(input.shipPosition)

      // 2. The position. `detached` is `DelayedReparent`: without it the ship
      //    carries the root and the damp converges rigidly onto the target, so
      //    a prefab that lacks the component draws the rigid camera — which is
      //    what such a prefab would actually do.
      if (fresh || !spec.detached) {
        position.copy(_target)
        dampVelocity.set(0, 0, 0)
      } else {
        smoothDamp(position, _target, dampVelocity, spec.smoothTimeSeconds, spec.maxSpeed, input.dt)
      }

      // 3. The aim. `upTarget` is a POINT on the ship that the up vector is
      //    taken TOWARDS (`upVect = upTarget.position - xform.position`), not a
      //    direction — read the field name, it is the trap DEV-150 names. Null
      //    on the JumpSeat, which then uses world up.
      if (spec.upOffset) {
        _up.copy(spec.upOffset).applyQuaternion(input.shipQuaternion).add(input.shipPosition)
        _up.sub(position)
      } else {
        _up.set(0, 1, 0)
      }
      // three's camera form: `Matrix4.lookAt(eye, target, up)` puts −z on the
      // target, which is where a camera looks. `Object3D.lookAt` does exactly
      // this for a camera and the other way round for a mesh (trap 22); this
      // quaternion goes on the RIG and the camera's local pose is identity, so
      // the camera form is the right one.
      _m.lookAt(position, _aim, _up)
      _lookWanted.setFromRotationMatrix(_m)

      // `Quaternion.Slerp(cur, want, dt * speed)`, t clamped to 1 by Unity.
      // Pinned at 1 on the HoverJet (225) at any sane frame rate; a real
      // smoothing, and frame-rate dependent, on the JumpSeat (35).
      if (fresh) {
        quaternion.copy(_lookWanted)
      } else {
        quaternion.slerp(_lookWanted, Math.min(1, Math.max(0, input.dt * spec.lookSpeed)))
      }

      // 4. `FixRoll`, in LateUpdate, after both constraints. The last word.
      if (spec.zeroRoll) levelRoll(quaternion)

      fresh = false
    },
  }
}

const _euler = new THREE.Euler()
const _m = new THREE.Matrix4()
const _lookWanted = new THREE.Quaternion()
