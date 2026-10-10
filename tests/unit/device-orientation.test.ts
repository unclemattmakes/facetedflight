/**
 * tests/unit/device-orientation.test.ts — the gyro transform, against three.
 *
 * ── Why this is a DIFFERENTIAL test and not a table of expected numbers ──
 *
 * `src/input/device-orientation.ts` is sixteen multiplies transcribed out of
 * three's old `DeviceOrientationControls`, because `src/input/` imports no
 * `three` and this file is not going to be the first. A transcription is a
 * claim about somebody else's maths, and CLAUDE.md is explicit about where such
 * a claim belongs: *"a claim about them is read out of three's own build in a
 * test"* — which is how `xr-eye-layers.test.ts` and `xr-head-pose.test.ts`
 * already work.
 *
 * So the oracle here is `THREE.Quaternion` itself. Tests may import three (they
 * run in node and three has no DOM dependency at import), the port may not, and
 * the gap between those two facts is exactly what this file stands in.
 *
 * A table of golden numbers would have been the other option and it is worse in
 * the one way that matters: it would pass forever with the euler ORDER wrong,
 * because I would have generated the table from the same code it is testing.
 * That is CLAUDE.md's *"a test that re-derives its expectation the way the code
 * does has not tested the code"* (trap 24) — and the orientation lesson's
 * short version, **test the geometry, not the rotation**, is why §3 below aims
 * a vector rather than comparing four components.
 *
 * ── Both halves are needed, and that is MEASURED, not assumed ───────────
 *
 * The two blocks look redundant and are not. Verified by breaking the
 * implementation on purpose — two signs flipped in `quatFromEulerYXZ`, which is
 * the euler-order class of bug this whole file exists for:
 *
 *   §1 and §2 go RED.  §3, §4 and §5 stay GREEN.
 *
 * Because every geometric sample below has `gamma = 0`, and at gamma zero the
 * two corrupted terms carry a `sin(0)` and vanish. That is the agreement lesson
 * in one file — *"a rule tested only where two explanations agree has not been
 * tested"* — and it is the reason §1's samples are deliberately off-axis while
 * §3's are deliberately not: one asks whether the arithmetic is three's, the
 * other asks whether three's arithmetic is the arithmetic we wanted. Delete
 * either block and the remaining one passes a build that is wrong.
 */
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  attachDeviceLook,
  deviceQuaternion,
  headFrom,
  IDENTITY_QUAT,
  noDeviceLook,
  type OrientationHost,
  type Quat,
  quatAboutY,
  quatFromEulerYXZ,
  quatMultiply,
  quatPitch,
  quatYaw,
} from '@/input/device-orientation'

const DEG = Math.PI / 180

/** three's answer to the same question, built the way the header describes. */
const threeDeviceQuaternion = (
  alpha: number,
  beta: number,
  gamma: number,
  screenAngle: number,
): THREE.Quaternion => {
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(beta * DEG, alpha * DEG, -gamma * DEG, 'YXZ'),
  )
  q.multiply(new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2))
  q.multiply(
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -screenAngle * DEG),
  )
  return q
}

const close = (a: Quat, b: THREE.Quaternion, label: string): void => {
  for (const k of ['x', 'y', 'z', 'w'] as const) {
    expect(a[k], `${label}.${k}`).toBeCloseTo(b[k], 12)
  }
}

/**
 * A spread of readings that is not a spread of ROUND readings.
 *
 * Every axis at 0 or 90 makes half the sine and cosine terms vanish, which is
 * precisely the case in which a wrong euler order still gives the right answer
 * — the agreement trap, one file along. So the angles here are deliberately
 * off-axis, and the four that are not are kept only as the boundary cases.
 */
const SAMPLES: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 0, 0],
  [37.4, 12.9, -48.3, 0],
  [201.7, -63.2, 27.8, 90],
  [318.05, 84.9, -11.4, 270],
  [96.3, -7.7, 88.1, 180],
  [270, 90, 0, 90],
]

describe('the device-orientation transform agrees with three, term for term', () => {
  it('§1 builds the same quaternion three does, on six off-axis readings', () => {
    for (const [alpha, beta, gamma, screen] of SAMPLES) {
      close(
        deviceQuaternion(alpha, beta, gamma, screen),
        threeDeviceQuaternion(alpha, beta, gamma, screen),
        `a=${alpha} b=${beta} g=${gamma} s=${screen}`,
      )
    }
  })

  it('§2 multiplies and eulers the way three does, independently of §1', () => {
    // §1 could pass with BOTH halves wrong in compensating ways — the classic
    // two-bugs-that-cancel. These pin each helper on its own.
    for (const [x, y, z] of [
      [0.3, -1.1, 2.4],
      [-2.9, 0.77, -0.05],
    ] as const) {
      close(
        quatFromEulerYXZ(x, y, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'YXZ')),
        `euler ${x},${y},${z}`,
      )
    }
    const a = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, -0.9, 1.3, 'YXZ'))
    const b = new THREE.Quaternion().setFromEuler(new THREE.Euler(-1.2, 0.5, 0.2, 'YXZ'))
    close(
      quatMultiply({ x: a.x, y: a.y, z: a.z, w: a.w }, { x: b.x, y: b.y, z: b.z, w: b.w }),
      a.clone().multiply(b),
      'multiply',
    )
    close(
      quatAboutY(0.83),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.83),
      'aboutY',
    )
  })
})

describe('what the transform MEANS, as geometry', () => {
  /** Where a camera at `q` is looking, in world terms. */
  const forward = (q: Quat): THREE.Vector3 =>
    new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w))

  it('§3 a phone held UP like a window looks at the horizon, not at the floor', () => {
    // The claim the header's middle multiply exists to make, and the one a
    // component-by-component check against three cannot make: three would agree
    // with a transform that pointed at the floor, because it would be three's
    // own answer to a question nobody asked.
    //
    // `beta = 90` is the phone stood vertical — screen facing the player, top
    // edge up. Its BACK then faces the horizon, and that is where the view goes.
    const up = forward(deviceQuaternion(0, 90, 0, 0))
    expect(Math.abs(up.y), `held upright, y=${up.y.toFixed(4)}`).toBeLessThan(1e-6)

    // And flat on a table, face-up, it looks straight DOWN — which is the pose
    // the −90° about X is measured from. If that multiply were dropped these
    // two assertions would swap, and only one of them would fail.
    const flat = forward(deviceQuaternion(0, 0, 0, 0))
    expect(flat.y, `flat on a table, y=${flat.y.toFixed(4)}`).toBeCloseTo(-1, 6)
  })

  it('§4 tipping the phone DOWN looks down, and is not undone by the yaw zero', () => {
    // The property `headFrom`'s "yaw only" paragraph claims. Take the reference
    // from an upright phone, then tip it 30 degrees down, and the head must
    // pitch down by 30 — not be re-zeroed to the horizon.
    const reference = deviceQuaternion(140, 90, 0, 0)
    const offset = -quatYaw(reference)
    const tipped = deviceQuaternion(140, 60, 0, 0)
    const y = forward(headFrom(tipped, offset)).y
    expect(Math.asin(Math.max(-1, Math.min(1, y))) / DEG, `pitch ${y}`).toBeCloseTo(-30, 4)
  })

  it('§5 the reference heading is removed: enabling faces you straight ahead', () => {
    // Whatever compass bearing the device reports, the first reading becomes
    // "forward". Four bearings, one answer — which is the whole job of
    // `yawOffset`, and the thing that would otherwise spin a player to north
    // the instant they tapped the chip.
    for (const alpha of [0, 73.2, 180, 299.6]) {
      const device = deviceQuaternion(alpha, 90, 0, 0)
      const head = headFrom(device, -quatYaw(device))
      expect(quatYaw(head), `alpha=${alpha}`).toBeCloseTo(0, 6)
    }
  })
})

describe('the live look', () => {
  /** A window with no `deviceorientation` on it, that records its listeners. */
  const fakeHost = () => {
    const listeners = new Map<string, (e: Event) => void>()
    const host: OrientationHost & { fire: (r: unknown) => void; count: () => number } = {
      addEventListener: (type, fn) => {
        listeners.set(type, fn)
      },
      removeEventListener: (type) => {
        listeners.delete(type)
      },
      screen: { orientation: { angle: 0 } },
      fire: (reading) => listeners.get('deviceorientation')?.(reading as Event),
      count: () => listeners.size,
    }
    return host
  }

  it('§6 reports nothing until it is enabled AND a reading has arrived', () => {
    const host = fakeHost()
    const look = attachDeviceLook(host)
    expect(look.supported).toBe(true)
    expect(look.head()).toBeNull()
    expect(look.active).toBe(false)

    void look.enable()
    // Enabled, but the device has not spoken. `active` must stay false or the
    // caller will swap the view over to a pose that does not exist yet.
    expect(look.active).toBe(false)
    expect(look.head()).toBeNull()

    host.fire({ alpha: 12, beta: 90, gamma: 0 })
    expect(look.active).toBe(true)
    expect(look.head()).not.toBeNull()
  })

  it('§7 drops null readings rather than snapping to north', () => {
    const host = fakeHost()
    const look = attachDeviceLook(host)
    void look.enable()
    host.fire({ alpha: null, beta: null, gamma: null })
    expect(look.head(), 'a null reading is not a reading').toBeNull()
    host.fire({ alpha: 45, beta: 90, gamma: 0 })
    expect(look.head()).not.toBeNull()
    // And the REFERENCE was taken from the first real one, not from the null:
    // yaw comes out zero, which it would not if the null had spent the flag.
    expect(quatYaw(look.head() as Quat)).toBeCloseTo(0, 6)
  })

  it('§8 lets go of the listener, and of the pose, when it is switched off', () => {
    const host = fakeHost()
    const look = attachDeviceLook(host)
    void look.enable()
    host.fire({ alpha: 45, beta: 90, gamma: 0 })
    look.disable()
    expect(host.count(), 'the listener is gone').toBe(0)
    // A stale pose surviving a disable would freeze the view at whatever angle
    // the phone was at when you turned it off — worse than not having it.
    expect(look.head()).toBeNull()
    expect(look.active).toBe(false)
  })

  it('§9 re-references on recentre, so the view can be squared up in the seat', () => {
    const host = fakeHost()
    const look = attachDeviceLook(host)
    void look.enable()
    host.fire({ alpha: 10, beta: 90, gamma: 0 })
    host.fire({ alpha: 100, beta: 90, gamma: 0 })
    // 90 degrees off the reference, and the head says so.
    expect(Math.abs(quatYaw(look.head() as Quat) / DEG)).toBeCloseTo(90, 3)
    look.recentre()
    host.fire({ alpha: 100, beta: 90, gamma: 0 })
    expect(quatYaw(look.head() as Quat)).toBeCloseTo(0, 6)
  })

  it('§11 decomposes the head into the yaw and pitch the chase arm takes', () => {
    // DEV-292's second home. `render/spring-arm.ts` orbits on two SCALARS, not
    // a quaternion, so the head has to come apart before it can drive one —
    // and the two halves have to agree with three about which way is up.
    //
    // The oracle is three's own `applyQuaternion`, for the same reason §1 uses
    // three's `setFromEuler`: `quatPitch` is a hand-expanded rotation of
    // (0, 0, −1) and a transcription needs the thing it was transcribed from.
    for (const [alpha, beta, gamma] of [
      [0, 90, 0],
      [37.4, 12.9, -48.3],
      [201.7, 117.2, 27.8],
      [318.05, 84.9, -11.4],
    ] as const) {
      const q = deviceQuaternion(alpha, beta, gamma, 0)
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(
        new THREE.Quaternion(q.x, q.y, q.z, q.w),
      )
      expect(quatPitch(q), `pitch a=${alpha} b=${beta} g=${gamma}`).toBeCloseTo(
        Math.asin(Math.max(-1, Math.min(1, fwd.y))),
        12,
      )
      expect(quatYaw(q), `yaw a=${alpha} b=${beta} g=${gamma}`).toBeCloseTo(
        Math.atan2(-fwd.x, -fwd.z),
        12,
      )
    }
  })

  it('§12 pitch is POSITIVE looking up, which is the arm’s convention', () => {
    // The sign, on its own, because it is the half a magnitude check cannot
    // see and the half that would put the chase camera underground. `look.ts`
    // and `SpringArmInput.lookPitch` both mean "positive tilts the view UP",
    // and `spring-arm.ts` says so in as many words at the multiply.
    //
    // beta > 90 is the phone leaning BACK — its screen toward the sky, its
    // back toward the ceiling — so the view through it goes up.
    expect(quatPitch(deviceQuaternion(0, 120, 0, 0)), 'leaned back looks up').toBeGreaterThan(0.1)
    expect(quatPitch(deviceQuaternion(0, 60, 0, 0)), 'tipped forward looks down').toBeLessThan(-0.1)
    expect(quatPitch(deviceQuaternion(0, 90, 0, 0)), 'upright is level').toBeCloseTo(0, 6)
  })

  it('§13 never returns NaN, however far outside the unit ball the input drifts', () => {
    // `asin` of anything past 1 is NaN, and a NaN pitch reaches the arm as a
    // NaN quaternion and takes the whole frame with it — from a rounding
    // error. The clamp is cheap; a frame that renders nothing is not.
    const swollen: Quat = { x: 0, y: 0.9, z: 0, w: 0.9 } // not normalised: |q| > 1
    expect(Number.isNaN(quatPitch(swollen))).toBe(false)
    expect(Number.isNaN(quatPitch({ x: 1e3, y: 1e3, z: 1e3, w: 1e3 }))).toBe(false)
  })

  it('§10 a host without listeners is the null object, not a crash', () => {
    expect(attachDeviceLook(null).supported).toBe(false)
    const none = noDeviceLook()
    expect(none.head()).toBeNull()
    expect(none.active).toBe(false)
    expect(IDENTITY_QUAT).toEqual({ x: 0, y: 0, z: 0, w: 1 })
  })
})
