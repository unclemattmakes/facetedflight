// src/render/camera-shake.ts: the flat build's camera shake. DEV-636.
//
// Matt, 2026-10-05: *"camera can shake in flat mode."* And, on the racers:
// *"camera shake when ships whoosh by (i think you mentioned that but wanted to
// +1000)"*.
//
// ── The rule this file keeps, and where it is kept ───────────────────────
//
// ART_DIRECTION pillar 3, amended 2026-10-05. On a MONITOR there is no
// vestibular mismatch and no stereo metre to break, so the camera may move. In
// a headset it may not: a shaken rig shakes the world around a stationary head,
// which is the exact stimulus the comfort block exists to limit. So:
//
//   · the offset is worn by the CAMERA's LOCAL pose for the one render call and
//     taken off again straight after (`createShakeWear`). The rig, the sim body,
//     the HUD's placement and every raycast are placed BEFORE that call and read
//     the un-shaken pose, so a shake cannot leak into any of them;
//   · it is ZERO in an XR session (`shakeAmount`'s `presenting` argument), and
//     in session three does not read the camera's local pose at all anyway;
//   · it is ZERO with Speed FX off and HALF on light (`scale`, the comfort slider
//     resolved to 0 / 0.5 / 1), linearly, so the slider is not a lie.
//
// ── The model: trauma, squared, through smooth noise ─────────────────────
//
// The usual one (Eiserloh, GDC 2016): events ADD trauma (0..1, clamped), trauma
// DECAYS linearly with time, and the offset is `trauma^2` times a smooth noise.
// The square is what makes a small event a tremor and a large one a blow, with
// one number per event rather than a curve per event. The noise is a sum of
// sines with golden-angle phases (the cockpit buffet's own device,
// `game/cockpit-shake.ts`): deterministic in time and continuous, never
// `Math.random()`, so two frames a millisecond apart differ by a millisecond of
// motion rather than a fresh draw. A per-frame random shake at 144 Hz is a
// strobe.
//
// Pure and three-free except for `createShakeWear`, which only touches the
// camera object it is handed.
//
// Both looks: this is gameplay feedback (POLISH-WAVE "the feel rules"), so
// Classic shakes too. It is not an edition flag and it is not in
// `content/editions`: the tuning is below and the slider is the player's.

import type * as THREE from 'three'

/**
 * The tuning, in one place so a playtest changes one object.
 *
 * Metres and radians, the camera's LOCAL axes. The cockpit is 1:1 and the eye
 * sits inside a 0.08 m near plane, so the translation ceiling is centimetres:
 * a hand-held camera in a car, not a camera in a blender.
 */
export const SHAKE_TUNING = {
  /** Trauma lost per second, linear. 1.6 means a full blow is gone in 0.625 s. */
  decayPerSecond: 1.6,
  /** Peak translation at trauma 1, metres. */
  translateMetres: 0.05,
  /** Peak roll at trauma 1, radians (about 2.9 degrees). */
  rollRadians: 0.05,
  /** Peak pitch and yaw at trauma 1, radians (about 1.7 degrees). */
  tiltRadians: 0.03,
  /** The noise's base frequency in Hz; the sum carries two overtones. */
  hz: 11,
} as const

export type ShakeTuning = { readonly [K in keyof typeof SHAKE_TUNING]: number }

/**
 * How much trauma each event adds. Named so a caller says what happened, and a
 * playtest tunes the table rather than hunting call sites.
 *
 * `flyby` is a CEILING: the real amount is `flybyTrauma`'s, by distance and
 * closing speed.
 */
export const TRAUMA = {
  /** A terrain crash past `gameplay.crash.minImpactSpeed`. The large one. */
  crash: 0.9,
  /** A prop broken through (`propHit`). */
  propStrike: 0.5,
  /** A racer struck the player (`ship.hit`). */
  racerHit: 0.45,
  /** GO: the small shove as the ship is released. */
  go: 0.25,
  /** A boost stage rising (120, 240, 350 m/s). */
  boostStage: 0.2,
  /** CLOSE: a near miss with terrain. */
  nearMiss: 0.2,
  /** The most a racer passing can add. */
  flyby: 0.4,
} as const

/** What the camera wears for one render call. Metres and radians. */
export interface CameraShakeOffset {
  x: number
  y: number
  z: number
  /** About the camera's own forward axis. */
  roll: number
  pitch: number
  yaw: number
}

export const createShakeOffset = (): CameraShakeOffset => ({
  x: 0,
  y: 0,
  z: 0,
  roll: 0,
  pitch: 0,
  yaw: 0,
})

const TAU = Math.PI * 2

/** π(3 - √5): spreads the six channels' phases so no two lines up. A maths constant, not a dial. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

/**
 * One channel of the noise, -1..1, from three sines at 1, 1.73 and 2.91 times the
 * base frequency (irrational-ish ratios, so the sum never visibly repeats). The
 * MEAN, so the amplitude asked for is a true ceiling and the bounds test is an
 * assertion rather than an estimate.
 */
const noise = (hz: number, channel: number, t: number): number =>
  (Math.sin(TAU * hz * t + GOLDEN_ANGLE * (channel * 3)) +
    Math.sin(TAU * hz * 1.73 * t + GOLDEN_ANGLE * (channel * 3 + 1)) +
    Math.sin(TAU * hz * 2.91 * t + GOLDEN_ANGLE * (channel * 3 + 2))) /
  3

export interface CameraShake {
  /** 0..1. */
  readonly trauma: number
  /** Add trauma (clamped to 1). A NaN, zero or negative amount does nothing. */
  add(amount: number): void
  /** Decay by `dt` render seconds. A hidden tab's ten-second frame lands on zero, not a blow. */
  step(dt: number): void
  /**
   * The offset at `time` (render seconds) into `out`.
   *
   * Zero when `scale` is not positive, when `presenting` (an XR session), or
   * when there is no trauma. `scale` is the Speed FX slider as 0 / 0.5 / 1 and
   * multiplies LINEARLY.
   */
  sample(
    out: CameraShakeOffset,
    time: number,
    scale: number,
    presenting: boolean,
  ): CameraShakeOffset
  /** Drop all trauma now: a run restart, a screen change, a pause. */
  clear(): void
}

export const createCameraShake = (tuning: ShakeTuning = SHAKE_TUNING): CameraShake => {
  let trauma = 0
  return {
    get trauma() {
      return trauma
    },
    add(amount) {
      if (!(amount > 0)) return
      trauma = trauma + amount > 1 ? 1 : trauma + amount
    },
    step(dt) {
      if (!(dt > 0) || trauma <= 0) return
      trauma = Math.max(0, trauma - tuning.decayPerSecond * dt)
    },
    sample(out, time, scale, presenting) {
      if (presenting || !(scale > 0) || trauma <= 0) {
        out.x = out.y = out.z = out.roll = out.pitch = out.yaw = 0
        return out
      }
      // Trauma squared, then the slider. Linear in `scale`: light is half.
      const k = trauma * trauma * (scale > 1 ? 1 : scale)
      const t = tuning.translateMetres * k
      const r = tuning.rollRadians * k
      const w = tuning.tiltRadians * k
      out.x = t * noise(tuning.hz, 0, time)
      out.y = t * noise(tuning.hz, 1, time)
      // A third of the depth: a shake along the line of sight reads as a zoom.
      out.z = t * 0.33 * noise(tuning.hz, 2, time)
      out.roll = r * noise(tuning.hz, 3, time)
      out.pitch = w * noise(tuning.hz, 4, time)
      out.yaw = w * noise(tuning.hz, 5, time)
      return out
    },
    clear() {
      trauma = 0
    },
  }
}

// ── A racer whooshing past ────────────────────────────────────────────────

/** The range inside which a pass is felt at all, metres. Matt: 10 m rattles, 60 m does not. */
export const FLYBY_RANGE_METRES = 45
/** Distance at and inside which a pass is at full strength, metres. */
export const FLYBY_FULL_METRES = 10
/** Closing speed at which a pass is at full strength, m/s (a boosted ship against a cruising one). */
export const FLYBY_FULL_CLOSING = 120

/**
 * The trauma a racer passing adds, from the closest approach.
 *
 * `distance` is the metres between the two ships at the closest point and
 * `closingSpeed` the m/s they were closing at as they crossed. Linear in
 * closing speed up to `FLYBY_FULL_CLOSING`, INVERSE in distance: `FULL / d`,
 * so a pass at 10 m is the whole ceiling, at 20 m half, at 40 m a quarter, and
 * at `FLYBY_RANGE_METRES` and beyond nothing. The cut at the range is what
 * makes "a pass at 60 m does not rattle" true rather than a small number.
 */
export const flybyTrauma = (closingSpeed: number, distance: number): number => {
  if (!(closingSpeed > 0) || !(distance < FLYBY_RANGE_METRES)) return 0
  const near = Math.min(1, FLYBY_FULL_METRES / Math.max(distance, FLYBY_FULL_METRES))
  const fast = Math.min(1, closingSpeed / FLYBY_FULL_CLOSING)
  // The inverse term is 0.22 at the range's edge; subtract it so the cut is
  // continuous (no step from "a little" to "nothing").
  const edge = FLYBY_FULL_METRES / FLYBY_RANGE_METRES
  const shaped = Math.max(0, (near - edge) / (1 - edge))
  return TRAUMA.flyby * shaped * fast
}

// ── Wearing it ────────────────────────────────────────────────────────────

export interface ShakeWear {
  /** Put `offset` on the camera's LOCAL pose. Remembers what was there. */
  wear(camera: THREE.Camera, offset: CameraShakeOffset): void
  /** Take it off again. A no-op when nothing was worn. */
  restore(camera: THREE.Camera): void
  /** Was an offset on the camera since the last restore? */
  readonly worn: boolean
}

const EPS = 1e-9

/**
 * One wear/restore pair, owned by the caller (never a module scratch: it holds
 * the camera's real pose between the two calls).
 *
 * `wear` composes the rotation onto the camera's own quaternion in its LOCAL
 * axes (roll about local z, pitch about x, yaw about y) and adds the translation
 * to its local position. It does NOT touch a parent: the rig stays where the
 * sim put it. `restore` writes back the exact saved values, so a frame with
 * no shake is bit-identical to a frame that never called either.
 */
export const createShakeWear = (): ShakeWear => {
  const pos = { x: 0, y: 0, z: 0 }
  const quat = { x: 0, y: 0, z: 0, w: 1 }
  let worn = false
  return {
    get worn() {
      return worn
    },
    wear(camera, o) {
      if (
        Math.abs(o.x) < EPS &&
        Math.abs(o.y) < EPS &&
        Math.abs(o.z) < EPS &&
        Math.abs(o.roll) < EPS &&
        Math.abs(o.pitch) < EPS &&
        Math.abs(o.yaw) < EPS
      ) {
        return
      }
      const q = camera.quaternion
      pos.x = camera.position.x
      pos.y = camera.position.y
      pos.z = camera.position.z
      quat.x = q.x
      quat.y = q.y
      quat.z = q.z
      quat.w = q.w
      worn = true
      camera.position.x += o.x
      camera.position.y += o.y
      camera.position.z += o.z
      // Small-angle composition: q * (1, half-angles). Exact enough for under
      // 3 degrees and it allocates nothing.
      const dx = o.pitch * 0.5
      const dy = o.yaw * 0.5
      const dz = o.roll * 0.5
      const dw = 1
      const x = q.x * dw + q.w * dx + q.y * dz - q.z * dy
      const y = q.y * dw + q.w * dy + q.z * dx - q.x * dz
      const z = q.z * dw + q.w * dz + q.x * dy - q.y * dx
      const w = q.w * dw - q.x * dx - q.y * dy - q.z * dz
      const n = 1 / Math.hypot(x, y, z, w)
      q.set(x * n, y * n, z * n, w * n)
      camera.updateMatrixWorld(true)
    },
    restore(camera) {
      if (!worn) return
      worn = false
      camera.position.set(pos.x, pos.y, pos.z)
      camera.quaternion.set(quat.x, quat.y, quat.z, quat.w)
      camera.updateMatrixWorld(true)
    },
  }
}
