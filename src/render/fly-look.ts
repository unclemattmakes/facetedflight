// src/editor/desk/fly.ts — the desk camera's FLY mode, as pure math. DEV-472
// follow-up (Matt: "right-drag fly-look like UE").
//
// Unreal's viewport: hold the right button and the mouse looks round from where
// the eye is (yaw on X, pitch on Y); W/S go forward and back along the view,
// A/D strafe, Q/E go down and up; the wheel sets how fast. Let go and the
// orbit takes over again from exactly that view.
//
// No DOM here and nothing but three's maths, so `tests/unit/editor-desk.test.ts`
// runs it in node. `camera.ts` owns the listeners and the state.
//
// CONVENTIONS. Yaw 0 looks down -Z (three's camera forward), and a positive
// yaw turns LEFT (towards -X), as `Euler(pitch, yaw, 0, 'YXZ')` does. Pitch is
// up-positive. So a mouse moved right (dx > 0) lowers the yaw, and a mouse
// moved up (dy < 0) raises the pitch: the view follows the hand.

import * as THREE from 'three'

/**
 * The fly-look's feel numbers, shared by the editor desk (DEV-472 follow-up)
 * and TV's Free camera (DEV-481). They live here, not in the editor's policy,
 * so the game can fly a camera without loading the editor (editor-lazy-graph).
 * `editor/desk/policy.ts` reads them from here (the desk keeps its notes on each).
 */
export const FLY_LOOK_POLICY = {
  /** Degrees of look per pixel of mouse travel. */
  flyLookDegreesPerPixel: 0.2,
  /** Short of straight up and straight down. */
  flyPitchLimitDegrees: 85,
  /** Metres a second per metre of height above the render surface (a Matt call, with the two below). */
  flySpeedPerMetre: 1,
  /** The slowest the fly goes, m/s, whatever the height. */
  flySpeedMin: 20,
  /** The fastest, m/s. */
  flySpeedMax: 2000,
  /** One wheel notch multiplies (or divides) the speed by this. */
  flyWheelStep: 1.25,
  /** The wheel's scale on the speed stays within this factor either way. */
  flyWheelRange: 8,
} as const

export interface FlyAngles {
  readonly yaw: number
  readonly pitch: number
}

/** The keys that move the eye while the right button is held. */
export interface FlyKeys {
  readonly forward: boolean
  readonly back: boolean
  readonly left: boolean
  readonly right: boolean
  readonly up: boolean
  readonly down: boolean
}

/** Short of straight up and straight down, radians. */
export const flyPitchLimit = (): number =>
  THREE.MathUtils.degToRad(FLY_LOOK_POLICY.flyPitchLimitDegrees)

/** The yaw and pitch of a view direction (need not be unit length). */
export const anglesOf = (dir: THREE.Vector3): FlyAngles => {
  const len = dir.length() || 1
  const limit = flyPitchLimit()
  const pitch = THREE.MathUtils.clamp(
    Math.asin(THREE.MathUtils.clamp(dir.y / len, -1, 1)),
    -limit,
    limit,
  )
  return { yaw: Math.atan2(-dir.x, -dir.z), pitch }
}

/** A mouse move of (dx, dy) CSS pixels turns the view; pitch stops short of the poles. */
export const flyLook = (a: FlyAngles, dx: number, dy: number): FlyAngles => {
  const k = THREE.MathUtils.degToRad(FLY_LOOK_POLICY.flyLookDegreesPerPixel)
  const limit = flyPitchLimit()
  return {
    yaw: a.yaw - dx * k,
    pitch: THREE.MathUtils.clamp(a.pitch - dy * k, -limit, limit),
  }
}

/** The unit view direction for these angles. */
export const flyForward = (a: FlyAngles, out = new THREE.Vector3()): THREE.Vector3 =>
  out.set(
    -Math.sin(a.yaw) * Math.cos(a.pitch),
    Math.sin(a.pitch),
    -Math.cos(a.yaw) * Math.cos(a.pitch),
  )

/**
 * The view direction of a camera with orientation `q`: its -Z. The desk's
 * camera hangs under nothing, so its own quaternion IS its world one. (It is
 * not the headset's gaze, which only `render/head-pose.ts` may read, DEV-199.)
 */
export const viewOf = (q: THREE.Quaternion, out = new THREE.Vector3()): THREE.Vector3 =>
  out.set(0, 0, -1).applyQuaternion(q)

/** The unit screen-right direction for these angles: level, whatever the pitch. */
export const flyRight = (a: FlyAngles, out = new THREE.Vector3()): THREE.Vector3 =>
  out.set(Math.cos(a.yaw), 0, -Math.sin(a.yaw))

/** The camera's orientation for these angles. */
export const flyQuaternion = (a: FlyAngles, out = new THREE.Quaternion()): THREE.Quaternion =>
  out.setFromEuler(new THREE.Euler(a.pitch, a.yaw, 0, 'YXZ'))

/**
 * How far the eye moves in `seconds` at `speed` metres a second with `keys`
 * held: W/S along the VIEW (pitch included, as Unreal does), A/D along the
 * level right, Q/E straight down and up the world. Diagonals are not faster.
 */
export const flyStep = (
  a: FlyAngles,
  keys: FlyKeys,
  speed: number,
  seconds: number,
  out = new THREE.Vector3(),
): THREE.Vector3 => {
  const f = flyForward(a)
  const r = flyRight(a)
  out.set(0, 0, 0)
  const along = (keys.forward ? 1 : 0) - (keys.back ? 1 : 0)
  const across = (keys.right ? 1 : 0) - (keys.left ? 1 : 0)
  const rise = (keys.up ? 1 : 0) - (keys.down ? 1 : 0)
  out.addScaledVector(f, along).addScaledVector(r, across)
  out.y += rise
  const len = out.length()
  if (len > 0) out.multiplyScalar((speed * seconds) / len)
  return out
}

/**
 * Metres a second, for an eye `height` metres above the RENDER surface and a
 * wheel scale: a fixed fraction of the height a second, inside the policy's
 * range. Low over a ring it creeps; over the whole island it crosses it.
 */
export const flySpeed = (height: number, scale: number): number => {
  const p = FLY_LOOK_POLICY
  const base = THREE.MathUtils.clamp(
    Math.max(height, 0) * p.flySpeedPerMetre,
    p.flySpeedMin,
    p.flySpeedMax,
  )
  return base * scale
}

/** One wheel notch on the fly speed's scale: away from you is faster, as Unreal's is. */
export const flyWheel = (scale: number, deltaY: number): number => {
  const p = FLY_LOOK_POLICY
  if (deltaY === 0) return scale
  const next = deltaY < 0 ? scale * p.flyWheelStep : scale / p.flyWheelStep
  return THREE.MathUtils.clamp(next, 1 / p.flyWheelRange, p.flyWheelRange)
}

/**
 * Where the orbit's target goes when the button is let go: `distance` ahead of
 * the eye along its view. The eye does not move and the view does not turn,
 * so the hand-back has no jump.
 */
export const flyReleaseTarget = (
  position: THREE.Vector3,
  a: FlyAngles,
  distance: number,
  out = new THREE.Vector3(),
): THREE.Vector3 => out.copy(position).addScaledVector(flyForward(a), distance)
