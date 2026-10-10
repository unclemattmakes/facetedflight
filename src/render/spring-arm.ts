// src/render/spring-arm.ts — a third-person camera on a spring arm. DEV-128.
//
// Matt: *"plz add a third-person camera that i can switch to. (UE-spring style
// plz)"*
//
// ── What "UE-spring style" means, part by part ────────────────────────────
//
// Unreal's `USpringArmComponent` is five ideas, and this file has all five:
//
//   1. a PIVOT on the owner (`TargetOffset`) that the arm hangs from;
//   2. an ARM of `TargetArmLength` metres, with the camera at its far end;
//   3. a LAGGED POSITION (`bEnableCameraLag`, `CameraLagSpeed`,
//      `CameraLagMaxDistance`): the arm origin trails the pivot, so acceleration
//      and a boost are visible from outside as the ship pulling away;
//   4. a LAGGED ROTATION (`bEnableCameraRotationLag`), on its own, slower rate,
//      so the ship visibly turns inside the frame before the frame follows;
//   5. a PROBE (`bDoCollisionTest`, `ProbeSize`): the arm is shortened to the
//      first point along it that would put the lens inside something.
//
// Plus two this game adds: the horizon tilts with a FRACTION of the bank
// (`rollFollow` — the Riders Republic cue the triage page names; Unreal's
// `bInheritRoll` is all-or-nothing), and the lens opens with airspeed on the
// speed-FX comfort slider (`fovAddFor`), which is where every effect that
// creates vection lives (ANNIVERSARY.md §2.6).
//
// ── What 2016 had: a RIGID third person, shipped, on X ────────────────────
//
// Both shipped ship prefabs (`PlayerShip_SR14_Photon.prefab`,
// `JumpSeat_Photon.prefab`) carry `CamChanger` on the root with two targets:
// `camTargets[0]` the eye and `camTargets[1]` a `CamRoot_3rdPerson` — on the
// HoverJet 8.89 m behind, 1.73 m above and pitched 10.9° down, on the JumpSeat
// 8.32 m / 2.32 m / 7.3° (the sheet: `hoverjet.camera.thirdPerson`,
// `jumpseat.camera.thirdPerson`). `Input_Ship.cs:312` toggles it on InControl's
// `Action3` — the X button, "CHANGE VIEW" on 2016's own controls poster — and
// `CamChanger.Update()` on the C key; `ChangeCam()` fades out in 0.12 s,
// waits 0.2 s, reparents the camera rig RIGIDLY under the target
// (`SetParent(camTargets[i], false)`), swaps `Art/FirstPerson` for
// `Art/ThirdPerson`, and fades back in over 0.25 s. No lag, no probe, no bank
// follow, no fov. **That rigid camera is what the Classic preset draws**
// (`boot/app.ts`, `rigidThirdPerson`); this file is the Anniversary spring.
//
// The GearVR build (`3rdPerson_Ship.prefab`, never on Steam) had the lagged
// version: a `SmoothTransformConstraint` (`positionSpeed: 0.23`, a per-FRAME
// lerp in Linear mode, `SmoothTransformConstraint.cs:74`) following a target
// 8.35 m back and 1.56 m up, and a `SmoothLookAtConstraint` (`speed: 2`) aimed
// 6 m ahead. Its trail is frame-rate dependent (~8 m at 150 m/s and 60 Hz); the
// lag here is `1 - exp(-dt / tau)`, as `render/flat-fov.ts` does it, and every
// number is in the preset rather than ported from a prefab the build never
// loaded (hard rule 2).
//
// king-tide's chase camera (`src/engine/render/camera.ts`) is the nearer
// relative in this stack — bike-local offset (0, 1.1, -3.7), exponential
// damping 12 on position and look target, pitch clamp — and it has NO probe
// and NO fov term. This is the more complete arm.
//
// ── Where this runs, and where it never does ─────────────────────────────
//
// Render side. It reads the interpolated ship pose `flight.render()` has just
// written and it writes a camera pose; nothing under `src/sim/` can see it. The
// terrain query it needs is `sim/terrain/height-field.ts`'s `terrainHeightAt`,
// which is pure, and it is handed in as a callback in THREE space so this file
// never learns which way the sim's z points.
//
// NEVER in an XR session. In a headset the camera IS the head, and a
// third-person view is a rig placed somewhere the body is not — a comfort
// feature with its own research (research 05 §R7's "never move the camera
// under the head"), not this one. `boot/app.ts` refuses the toggle while
// presenting.
//
// Every number is in the preset: `render.thirdPerson` in
// `content/editions/*.json`. The only literals here are the probe's sample
// count and the settle epsilon, which are resolution rather than tuning.

import * as THREE from 'three'
import { sampleCurve } from '@/audio/speed-curves'
import type { EditionThirdPerson } from '@/content/edition-schema'

/**
 * The collision surface under a point, THREE space: the height of terrain OR
 * sea at (x, z), or `-Infinity` where there is no surface at all.
 */
export type SurfaceHeightAt = (x: number, z: number) => number

export interface SpringArmInput {
  /** The ship's interpolated pose, THREE space — `flight.object` after `render()`. */
  readonly shipPosition: THREE.Vector3
  readonly shipQuaternion: THREE.Quaternion
  /** The free look, radians. Orbits the arm about the pivot; zero is dead astern. */
  readonly lookYaw: number
  readonly lookPitch: number
  /** RENDER seconds since the last update. */
  readonly dt: number
  /** Null while the world has no terrain yet: the arm then never shortens. */
  readonly surfaceHeightAt: SurfaceHeightAt | null
}

export interface SpringArm {
  /** Where the camera goes. World space. Read after `update`. */
  readonly position: THREE.Vector3
  readonly quaternion: THREE.Quaternion
  /** Metres, pivot to camera, AFTER the probe. Equals `block.armLength` in clear air. */
  readonly armLength: number
  /** The lagged pivot, for the specs. World space. */
  readonly pivot: THREE.Vector3
  update(block: EditionThirdPerson, input: SpringArmInput): void
  /**
   * Forget the lag. The next `update` snaps to the resting pose — for the
   * first frame after the toggle, so the camera does not fly in from wherever
   * the cockpit was (king-tide's "first tick snaps").
   */
  reset(): void
}

/**
 * Samples along the arm the probe tests, pivot to lens. 32 on a 24 m arm is a
 * sample every 0.75 m, finer than the 1.5 m `probeRadius`, and the bisection
 * below closes the last interval to a centimetre.
 */
const PROBE_SAMPLES = 32
const PROBE_BISECTIONS = 6

/**
 * Degrees the lens opens by at this airspeed on this slider setting.
 *
 * Pure and total. `speedFx` is the comfort slider resolved to 0 / 0.5 / 1
 * (`game/edition.ts`), and it MULTIPLIES — so `off` is exactly zero at every
 * speed, which is the one property the unit test holds. Zero on a preset with
 * the flag off, because nothing then drives the camera either.
 */
export const fovAddFor = (block: EditionThirdPerson, airspeed: number, speedFx: number): number => {
  if (!block.enabled) return 0
  const k = speedFx > 0 ? speedFx : 0
  if (k === 0) return 0
  return k * sampleCurve(block.fovAddBySpeed, airspeed)
}

/** One step of an exponential ease. `dt <= 0` or `tau <= 0` snaps. */
const easeFactor = (tau: number, dt: number): number =>
  !(dt > 0) || !(tau > 0) ? 1 : 1 - Math.exp(-dt / tau)

/**
 * How much of the arm is clear, as a fraction 0..1 of `length` from `from`
 * along `dir` (unit), keeping `radius` metres between the lens and the
 * surface. 1 means the whole arm.
 *
 * Exported for the geometry test: a wall at a known distance has to shorten
 * the arm to that distance, whichever way the arm is pointing.
 */
export const clearFraction = (
  from: THREE.Vector3,
  dir: THREE.Vector3,
  length: number,
  radius: number,
  surfaceHeightAt: SurfaceHeightAt,
): number => {
  const blocked = (t: number): boolean => {
    const x = from.x + dir.x * length * t
    const y = from.y + dir.y * length * t
    const z = from.z + dir.z * length * t
    const h = surfaceHeightAt(x, z)
    return y - h < radius
  }
  let clear = 0
  let hit = -1
  for (let i = 1; i <= PROBE_SAMPLES; i++) {
    const t = i / PROBE_SAMPLES
    if (blocked(t)) {
      hit = t
      break
    }
    clear = t
  }
  if (hit < 0) return 1
  // Close the interval [clear, hit]: the arm ends at the last clear point.
  for (let i = 0; i < PROBE_BISECTIONS; i++) {
    const mid = (clear + hit) / 2
    if (blocked(mid)) hit = mid
    else clear = mid
  }
  return clear
}

/**
 * How far the arm may be pitched from level, radians — just inside vertical.
 *
 * 1.45 rad is 83.1°, so the arm always keeps ~7° of heading rather than
 * standing on its pole. See the clamp's own comment in `update` for why the
 * guard lives in the arm and not at the call site.
 *
 * Exported so a test asserts against the constant rather than a literal typed
 * twice, and so the number has ONE name — DEV-266's rule about a shipped
 * default, applied to a limit.
 */
export const ARM_PITCH_LIMIT = 1.45

/** `lookPitch`, held inside the pole. Exported for the test; used by `update`. */
export const clampArmPitch = (pitch: number): number =>
  pitch > ARM_PITCH_LIMIT ? ARM_PITCH_LIMIT : pitch < -ARM_PITCH_LIMIT ? -ARM_PITCH_LIMIT : pitch

export const createSpringArm = (): SpringArm => {
  const position = new THREE.Vector3()
  const quaternion = new THREE.Quaternion()
  const pivot = new THREE.Vector3()
  const lagRot = new THREE.Quaternion()
  let armLength = 0
  let fresh = true

  // Volatile scratch, valid inside one `update` only — never stored, never
  // read before it is written (trap 19).
  const _pivotTarget = new THREE.Vector3()
  const _euler = new THREE.Euler()
  const _rotTarget = new THREE.Quaternion()
  const _armQuat = new THREE.Quaternion()
  const _q = new THREE.Quaternion()
  const _dir = new THREE.Vector3()
  const _gap = new THREE.Vector3()

  return {
    position,
    quaternion,
    pivot,
    get armLength() {
      return armLength
    },
    reset() {
      fresh = true
    },
    update(block, input) {
      const dt = input.dt

      // 1. The pivot: the ship's origin plus the offset, in the SHIP's frame.
      _pivotTarget
        .set(block.pivotOffset[0], block.pivotOffset[1], block.pivotOffset[2])
        .applyQuaternion(input.shipQuaternion)
        .add(input.shipPosition)

      // 2. The rotation the arm follows: all of the yaw, a fraction of the
      // pitch, a fraction of the roll. 'YXZ' so yaw is the outer rotation and
      // the two fractions are taken in the ship's own frame.
      _euler.setFromQuaternion(input.shipQuaternion, 'YXZ')
      _euler.set(_euler.x * block.pitchFollow, _euler.y, _euler.z * block.rollFollow, 'YXZ')
      _rotTarget.setFromEuler(_euler)

      // 3. The lags. First frame snaps, then `1 - exp(-dt / tau)` per frame so
      // the feel is the same at 72 Hz and 144 Hz.
      if (fresh) {
        pivot.copy(_pivotTarget)
        lagRot.copy(_rotTarget)
        armLength = block.armLength
        fresh = false
      } else {
        pivot.lerp(_pivotTarget, easeFactor(block.positionLagSeconds, dt))
        // A slerp toward the target, never past it: a shortest-arc slerp is the
        // rotational lerp, and the same factor gives the same time constant.
        lagRot.slerp(_rotTarget, easeFactor(block.rotationLagSeconds, dt))
      }
      // `CameraLagMaxDistance`: a boost from rest must not leave the ship out
      // of frame, so the lagged pivot is never more than this behind the truth.
      _gap.subVectors(pivot, _pivotTarget)
      const gap = _gap.length()
      if (gap > block.maxLagMetres) {
        pivot.copy(_pivotTarget).addScaledVector(_gap, block.maxLagMetres / gap)
      }

      // 4. The arm's own orientation: the lagged follow, then the free look
      // (yaw, then pitch), then the arm raised by `armPitchDeg`. A rotation
      // about +x by θ tilts the forward vector (0, 0, -1) UP for positive θ, so
      // looking down the arm from above is a NEGATIVE pitch.
      const armPitch = THREE.MathUtils.degToRad(block.armPitchDeg)
      _armQuat.copy(lagRot)
      if (input.lookYaw !== 0) _armQuat.multiply(_q.setFromAxisAngle(_Y, input.lookYaw))
      // ── the arm clamps its OWN pole (DEV-292) ────────────────────────
      //
      // Held just inside vertical. At exactly ±90° the arm stands straight up
      // or straight down, and a camera looking along its own axis has no
      // meaningful heading left — the roll becomes whatever the lagged follow
      // happened to leave, and it swings as the ship banks.
      //
      // This changed nothing for the caller that existed when it was written:
      // `createFreeLook` already clamps to `FREE_LOOK_PITCH_LIMIT`, which is
      // 1 rad and well inside this. It is here because DEV-292's phone is NOT
      // clamped — the device's own orientation is the control, and `quatPitch`
      // is an `asin`, so it reaches ±90° exactly when the phone is held flat.
      // A guard on the input would have to be repeated by every future aimer;
      // a guard here is the arm refusing to be degenerate, which is its own
      // business and cannot be forgotten.
      _armQuat.multiply(_q.setFromAxisAngle(_X, clampArmPitch(input.lookPitch) - armPitch))

      // The arm points from the pivot to the camera: the arm frame's +z (behind).
      _dir.set(0, 0, 1).applyQuaternion(_armQuat)

      // 5. The probe. Instant in, eased out: a lens that snapped back to full
      // length as a ridge passed would pop, and one that eased INTO a hillside
      // would spend a frame inside it.
      let desired = block.armLength
      if (input.surfaceHeightAt) {
        const clear = clearFraction(
          pivot,
          _dir,
          block.armLength,
          block.probeRadius,
          input.surfaceHeightAt,
        )
        desired = Math.max(block.minArmLength, clear * block.armLength)
      }
      armLength =
        desired < armLength
          ? desired
          : armLength + (desired - armLength) * easeFactor(block.positionLagSeconds, dt)

      position.copy(pivot).addScaledVector(_dir, armLength)
      // The lens looks along the arm, then `aimPitchDeg` more: negative aims
      // below the pivot and lifts the ship in the frame.
      quaternion
        .copy(_armQuat)
        .multiply(_q.setFromAxisAngle(_X, THREE.MathUtils.degToRad(block.aimPitchDeg)))
    },
  }
}

const _X = new THREE.Vector3(1, 0, 0)
const _Y = new THREE.Vector3(0, 1, 0)
