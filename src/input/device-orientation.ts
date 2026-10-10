// src/input/device-orientation.ts — the phone IS the neck.
//
// Matt: *"when players are on the mobile version, i'd [like] them to be able to
// move their phone to look around. we did this as a feature in polyfish and i
// think it'd be neat to have the plane in autopilot while looking around with
// the phone."* DEV-292.
//
// ── Lifted from polyfish, and from three before it ───────────────────────
//
// `$FF2_REF/polyfish/src/input/CameraController.js:619-641` is the reference,
// and what polyfish itself has is three's old `DeviceOrientationControls`,
// which was removed from three's core in r13x and is the canonical form of this
// transform. The two multiplies below are its two multiplies, in its order, and
// they are copied rather than re-derived on purpose: CLAUDE.md's orientation
// lesson is that this project has shipped FOUR orientation bugs, that they hide
// on symmetric geometry, and that a quaternion assertion is your belief written
// twice. There is no point being original here.
//
//     q = euler(beta, alpha, -gamma, 'YXZ')     the W3C's Z-X'-Y'' as a quat
//     q *= (-sqrt(0.5), 0, 0, sqrt(0.5))        -90 deg about X
//     q *= axisAngle(z, -screenAngle)           portrait vs landscape
//
// The middle one is the one worth a sentence, because it is the one that looks
// arbitrary. The W3C frame has the device's +z out of the SCREEN, so a phone
// lying face-up on a table is the identity — and a camera at the identity looks
// along −z, which for that phone is straight DOWN through the table. The −90°
// about X turns the frame so that the camera looks out of the phone's BACK,
// which makes "hold the phone up like a window and look through it" the neutral
// pose. That is the gesture the feature is for.
//
// ── THREE-FREE, like the rest of `src/input/` ───────────────────────────
//
// Not one file under `src/input/` imports `three`, and this one does not break
// that for sixteen multiplies. It is also what makes the guard below possible:
// `tests/unit/device-orientation.test.ts` builds the SAME transform out of
// three's own `Quaternion` and `Euler` and fails if the two disagree, which is
// the `xr-eye-layers.test.ts` pattern — a claim about somebody else's maths
// belongs in a test that runs their maths, not in a comment that transcribes
// it. Transcribed formulas rot silently; a differential test cannot.
//
// ── Why it does NOT go through `LookDelta` ──────────────────────────────
//
// `look.ts` speaks in RADIANS THIS FRAME, and that is right for every device it
// serves: a stick is a rate, a mouse is a displacement, a drag is a
// displacement, and all three are things that move a view from wherever it
// already was. A phone's orientation is none of those. It is an ABSOLUTE pose,
// it is the same pose whether the last frame took 5 ms or 500, and integrating
// it as a delta would be a second, lossier copy of a number the device already
// hands over exactly.
//
// So it lands where the HEAD lands. In the cockpit `app.ts` writes the free
// look onto `render.camera.quaternion` — the local pose inside the ship's rig,
// which is precisely "the head inside the aircraft" — and this writes the same
// field with the same meaning. A headset's runtime writes that field too, from
// a real neck, and it is not a coincidence that they are the same field: this
// feature is a neck.
//
// ── And therefore it is NOT clamped ─────────────────────────────────────
//
// `FREE_LOOK_YAW_LIMIT` stops a mouse-look at ~115°, and the reason given is
// that *"a flat-screen player has no proprioception to tell them which way they
// are facing"*. True of a mouse, false of this: the phone in your hand IS the
// proprioception, and a view that stopped turning while the phone kept turning
// would be the control lying about where you are pointed. In a session the
// clamp is already skipped for exactly this reason — there is a neck — and this
// takes the same branch for the same argument.

import { RAD_PER_DEG } from '@/sim/math/scalar'

/** A quaternion as four plain numbers. Deliberately not `THREE.Quaternion`. */
export interface Quat {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly w: number
}

export const IDENTITY_QUAT: Quat = { x: 0, y: 0, z: 0, w: 1 }

/** three's `Quaternion.setFromEuler` for order 'YXZ', and nothing else. */
export const quatFromEulerYXZ = (x: number, y: number, z: number): Quat => {
  const c1 = Math.cos(x / 2)
  const c2 = Math.cos(y / 2)
  const c3 = Math.cos(z / 2)
  const s1 = Math.sin(x / 2)
  const s2 = Math.sin(y / 2)
  const s3 = Math.sin(z / 2)
  return {
    x: s1 * c2 * c3 + c1 * s2 * s3,
    y: c1 * s2 * c3 - s1 * c2 * s3,
    z: c1 * c2 * s3 - s1 * s2 * c3,
    w: c1 * c2 * c3 + s1 * s2 * s3,
  }
}

/** Hamilton product, `a * b` — three's `Quaternion.multiplyQuaternions` order. */
export const quatMultiply = (a: Quat, b: Quat): Quat => ({
  x: a.x * b.w + a.w * b.x + a.y * b.z - a.z * b.y,
  y: a.y * b.w + a.w * b.y + a.z * b.x - a.x * b.z,
  z: a.z * b.w + a.w * b.z + a.x * b.y - a.y * b.x,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
})

/** A rotation of `radians` about +Y. The only axis this file needs one for. */
export const quatAboutY = (radians: number): Quat => ({
  x: 0,
  y: Math.sin(radians / 2),
  z: 0,
  w: Math.cos(radians / 2),
})

/** −90° about X: the screen's normal becomes the view direction. See the header. */
const SCREEN_TO_VIEW: Quat = { x: -Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 }

/**
 * One `deviceorientation` reading as a view orientation.
 *
 * `alpha`, `beta`, `gamma` in DEGREES, as the event delivers them;
 * `screenAngle` in degrees too, from `screen.orientation.angle` — 0 portrait,
 * 90 or 270 landscape. That last argument is passed in rather than read from
 * `screen` here so this function is a function: the same four numbers give the
 * same quaternion in a test, with no globals to stub.
 */
export const deviceQuaternion = (
  alpha: number,
  beta: number,
  gamma: number,
  screenAngle: number,
): Quat => {
  const q = quatFromEulerYXZ(beta * RAD_PER_DEG, alpha * RAD_PER_DEG, -gamma * RAD_PER_DEG)
  const screen = -screenAngle * RAD_PER_DEG
  return quatMultiply(quatMultiply(q, SCREEN_TO_VIEW), {
    x: 0,
    y: 0,
    z: Math.sin(screen / 2),
    w: Math.cos(screen / 2),
  })
}

/**
 * Which way a view orientation points, as a compass bearing in radians.
 *
 * `atan2(-fwd.x, -fwd.z)` on the forward vector, which is polyfish's own
 * formula (`CameraController.js:651-652`). It exists to be SUBTRACTED: see
 * `headFrom`.
 */
export const quatYaw = (q: Quat): number => {
  // (0, 0, −1) rotated by q, expanded. Cheaper and clearer than a Vector3 this
  // file would otherwise have to define.
  const fx = -2 * (q.x * q.z + q.w * q.y)
  const fz = -(1 - 2 * (q.x * q.x + q.y * q.y))
  return Math.atan2(-fx, -fz)
}

/**
 * How far ABOVE the horizon a view orientation points, in radians.
 *
 * `asin` of the forward vector's y, so it is naturally bounded to ±π/2 and
 * needs no clamp of its own. **Positive is UP**, which is `look.ts`'s
 * convention for pitch and `SpringArmInput.lookPitch`'s — the two readers —
 * rather than the flight model's, where positive pitch dives.
 *
 * It exists for DEV-292's second home: the chase camera's arm is orbited by a
 * YAW and a PITCH as scalars, not by a quaternion, so the head pose has to be
 * decomposed before it can drive one. The cockpit still takes the whole
 * quaternion, because there the head is a head and roll is part of it.
 */
export const quatPitch = (q: Quat): number => {
  // The y of (0, 0, −1) rotated by q. Clamped before `asin` because rounding
  // can put a unit vector a few ulps outside [−1, 1] and `asin` returns NaN
  // there — which would reach the arm as a NaN quaternion and take the frame
  // with it, from a rounding error.
  const fy = -2 * (q.y * q.z - q.w * q.x)
  return Math.asin(fy < -1 ? -1 : fy > 1 ? 1 : fy)
}

/**
 * The head pose, with the reference heading taken out.
 *
 * `alpha` is measured from wherever the device thinks north is, so the raw
 * quaternion would have you facing an arbitrary compass bearing the moment you
 * switch this on. `yawOffset` is `-quatYaw(firstReading)`, captured once, and
 * pre-multiplying by it makes "wherever you were pointing when you tapped TILT"
 * mean straight ahead.
 *
 * **Yaw only, and the other two axes stay absolute.** That is polyfish's choice
 * and it is the right one: tipping the phone down should look down, at the
 * angle you tipped it, whatever you were doing when you enabled it. Zeroing
 * pitch as well would make the neutral pose depend on how you happened to be
 * holding the thing, and there is no way to re-find it except by feel.
 */
export const headFrom = (device: Quat, yawOffset: number): Quat =>
  quatMultiply(quatAboutY(yawOffset), device)

/** The live look. `head()` is null whenever it should not be driving the view. */
export interface DeviceLook {
  /** This device reports orientation at all. False on every desktop. */
  readonly supported: boolean
  /** The player has switched it on AND a reading has arrived. */
  readonly active: boolean
  /** The head pose, or null — off, unsupported, or not one reading yet. */
  head(): Quat | null
  /**
   * Turn it on, asking for permission if the platform wants it. Resolves to
   * whether it is now running.
   *
   * **Must be called from inside a user-gesture handler on iOS**:
   * `DeviceOrientationEvent.requestPermission()` rejects otherwise, and a frame
   * callback is not a gesture however recently one happened. That is the whole
   * reason `touch-overlay.ts` grew a tap CALLBACK for this chip instead of a
   * latch the frame loop reads like `AUTO`'s — see `onGyroTap`.
   */
  enable(): Promise<boolean>
  disable(): void
  /** Take the current heading as straight ahead again, without toggling. */
  recentre(): void
  dispose(): void
}

/** What a host with no sensors gets: the same interface, saying no. */
export const noDeviceLook = (): DeviceLook => ({
  supported: false,
  active: false,
  head: () => null,
  enable: async () => false,
  disable: () => {},
  recentre: () => {},
  dispose: () => {},
})

/** The bits of `window` this needs, so a test can hand it four lines of object. */
export interface OrientationHost {
  addEventListener(type: string, listener: (e: Event) => void): void
  removeEventListener(type: string, listener: (e: Event) => void): void
  readonly screen?: { readonly orientation?: { readonly angle?: number } }
}

interface OrientationReading {
  readonly alpha: number | null
  readonly beta: number | null
  readonly gamma: number | null
}

/** iOS 13+ puts the sensors behind a prompt; nothing else implements this. */
interface PermissionGate {
  requestPermission?: () => Promise<'granted' | 'denied' | 'default'>
}

export const attachDeviceLook = (host: OrientationHost | null): DeviceLook => {
  if (host === null || typeof host.addEventListener !== 'function') return noDeviceLook()

  let on = false
  let yawOffset = 0
  /** Null until the first reading. `active` is what that null means to a caller. */
  let head: Quat | null = null
  /** Set by `recentre` and by `enable`, spent by the next reading. */
  let wantReference = true

  const onReading = (event: Event): void => {
    const e = event as unknown as OrientationReading
    // A device that is still working out where it is sends nulls, and on some
    // Android builds it sends them for the first second or so. Dropping them is
    // not defensive coding: `0` here would be a hard snap to north.
    if (e.alpha === null || e.beta === null || e.gamma === null) return
    const device = deviceQuaternion(e.alpha, e.beta, e.gamma, host.screen?.orientation?.angle ?? 0)
    if (wantReference) {
      yawOffset = -quatYaw(device)
      wantReference = false
    }
    head = headFrom(device, yawOffset)
  }

  return {
    supported: true,
    get active() {
      return on && head !== null
    },
    head() {
      return on ? head : null
    },
    async enable() {
      if (on) return true
      const gate = (globalThis as { DeviceOrientationEvent?: PermissionGate })
        .DeviceOrientationEvent
      if (typeof gate?.requestPermission === 'function') {
        try {
          if ((await gate.requestPermission()) !== 'granted') return false
        } catch {
          // Thrown when the call did not come from a gesture, and when the
          // user has denied it before. Neither is an error worth taking the
          // run down for: the chip simply does not light.
          return false
        }
      }
      on = true
      wantReference = true
      head = null
      host.addEventListener('deviceorientation', onReading)
      return true
    },
    disable() {
      if (!on) return
      on = false
      head = null
      host.removeEventListener('deviceorientation', onReading)
    },
    recentre() {
      wantReference = true
    },
    dispose() {
      on = false
      head = null
      host.removeEventListener('deviceorientation', onReading)
    },
  }
}
