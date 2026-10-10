// tests/unit/classic-chase.test.ts — 2016's own third-person camera. DEV-156.
//
// The Classic preset drew `CamRoot_3rdPerson`'s PARKED pose for four sessions —
// 8.89 m, welded, no trail — because DEV-128 read `CamChanger`'s rigid
// `SetParent` as the whole camera. DEV-150 found the 12.5 m target it damps
// toward and left the fix; this file guards the fix.
//
// ── What is asserted, and why it is not the constants ─────────────────────
//
// Two kinds of assertion, and neither is "the number is the number":
//
//   1. GEOMETRY, the DEV-150 pattern: what fraction of the frame width the
//      ship's 6.1654 m beam covers. A ratio of two measured lengths, true
//      whatever anyone believed about the pose, checked against something
//      OUTSIDE the port — the 2016 Steam screenshots, which measure 11.40 /
//      12.27 / 12.96 % at HUD speeds 153 / 145 / 148 m/s (DEV-150 §3). One test
//      exists only to prove the band SEPARATES: the parked pose and the old
//      guess both have to fall outside it.
//
//   2. RELATIONSHIPS the implementation does not itself compute. `smoothDamp`
//      is Unity's algorithm transcribed, so re-deriving its output with the
//      same formula would test nothing (trap 24). What is checked instead is
//      what a critically damped tracker must do for reasons outside the code:
//      a ramp leaves a steady error of `v·τ`, clamping that error to
//      `maxSpeed × smoothTime` caps the CLOSING SPEED at `maxSpeed`, and a
//      static target is reached without overshoot.
//
// And the sheet keys the port LEANS on are asserted rather than assumed
// (DEV-069): the port skips `GetUserLookRotation` because `pointAxis` and
// `upAxis` are the identity pair on both shipped prefabs, and if a prefab ever
// disagrees this file says so instead of the camera quietly twisting.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { HOVERJET_THIRD_PERSON, HOVERJET_THIRD_PERSON_CHASE } from '@/game/flight'
import { JUMPSEAT_THIRD_PERSON_CHASE } from '@/game/jumpseat-flight'
import type { ShipChase } from '@/game/ship-camera'
import { HOVERJET, JUMPSEAT } from '@/generated/constants.generated'
import { createClassicChase, levelRoll, smoothDamp } from '@/render/classic-chase'

const HJ = HOVERJET_THIRD_PERSON_CHASE
const JS = JUMPSEAT_THIRD_PERSON_CHASE

/** A level ship at `p`, facing −z (three's forward). */
const ship = (x = 0, y = 500, z = 0) => ({
  shipPosition: new THREE.Vector3(x, y, z),
  shipQuaternion: new THREE.Quaternion(),
})

/**
 * Fly straight and level at `speed` until the damp settles, and return the
 * camera. Steps the port's own chase rather than re-deriving where it ought to
 * end up.
 */
const flyStraight = (
  spec: ShipChase,
  speed: number,
  hz = 60,
  seconds = 8,
): { camera: THREE.Vector3; quaternion: THREE.Quaternion; ship: THREE.Vector3 } => {
  const chase = createClassicChase()
  const dt = 1 / hz
  const s = ship()
  for (let i = 0; i < Math.round(seconds * hz); i++) {
    s.shipPosition.z -= speed * dt
    chase.update(spec, { ...s, dt })
  }
  return {
    camera: chase.position.clone(),
    quaternion: chase.quaternion.clone(),
    ship: s.shipPosition.clone(),
  }
}

const settledDistance = (spec: ShipChase, speed: number, hz = 60): number => {
  const out = flyStraight(spec, speed, hz)
  return out.camera.distanceTo(out.ship)
}

describe('the sheet says what the port assumes it says', () => {
  it('both shipped vehicles detach from the ship and level their roll', () => {
    // These two are STRUCTURAL, not tuning, and the whole shape of the camera
    // turns on them: `DelayedReparent` is what makes the damp a real trail
    // rather than a no-op, and `FixRoll` is what makes the horizon level.
    for (const [name, chase] of [
      ['hoverjet', HOVERJET.camera.thirdPersonChase],
      ['jumpseat', JUMPSEAT.camera.thirdPersonChase],
    ] as const) {
      expect(chase.detachesFromShip, `${name} detaches`).toBe(true)
      expect(chase.zeroRoll, `${name} levels its roll`).toBe(true)
      expect(chase.chainLive, `${name} cam root is live`).toBe(true)
      expect(chase.position?.live, `${name} position constraint is live`).toBe(true)
      expect(chase.look?.live, `${name} look constraint is live`).toBe(true)
      expect(chase.position?.interpolation, `${name} damps`).toBe('DampLimited')
      expect(chase.position?.constrainRotation, `${name} does not turn the root`).toBe(false)
    }
  })

  it('the look constraint’s axes are the identity pair, which is why the port skips them', () => {
    // `GetUserLookRotation` is `lookRot * inverse(LookRotation(pointAxis,
    // upAxis))`. With (0,0,1) and (0,1,0) that inverse is the identity and the
    // whole term drops out — which is the only reason `classic-chase.ts` may
    // call `Matrix4.lookAt` and stop. If a prefab ever carries different axes
    // the port is wrong by that rotation, so it is asserted, not assumed.
    for (const [name, chase] of [
      ['hoverjet', HOVERJET.camera.thirdPersonChase],
      ['jumpseat', JUMPSEAT.camera.thirdPersonChase],
    ] as const) {
      expect(chase.look?.pointAxis, `${name} pointAxis`).toEqual({ x: 0, y: 0, z: 1 })
      expect(chase.look?.upAxis, `${name} upAxis`).toEqual({ x: 0, y: 1, z: 0 })
      expect(chase.look?.interpolation, `${name} slerps`).toBe('Spherical')
    }
  })

  it('the parked pose and the chased target are DIFFERENT places', () => {
    // The finding in one line. If these two ever agree, either the extractor
    // has collapsed them or someone has re-pointed the constraint at the
    // parking space — and the old bug is back.
    const parked = HOVERJET_THIRD_PERSON.position.length()
    const chased = HJ.targetOffset.length()
    expect(parked).toBeCloseTo(9.06, 1)
    expect(chased).toBeCloseTo(12.62, 1)
    expect(chased - parked).toBeGreaterThan(3)
  })
})

describe('smoothDamp behaves like a critically damped tracker', () => {
  it('leaves a steady error of v·τ chasing a ramp', () => {
    // The continuous solution of `ẍ = ω²(T − x) − 2ω ẋ` with ω = 2/τ against a
    // target moving at constant `v` is a lag of exactly `v·τ`. That is control
    // theory, not this file's arithmetic, which is what makes it a test.
    const tau = 0.066
    const v = 145
    const pos = new THREE.Vector3(0, 0, 0)
    const vel = new THREE.Vector3()
    const target = new THREE.Vector3(0, 0, 0)
    const dt = 1 / 240
    for (let i = 0; i < 240 * 8; i++) {
      target.z += v * dt
      smoothDamp(pos, target, vel, tau, 1e9, dt)
    }
    const lag = target.z - pos.z
    expect(lag).toBeGreaterThan(v * tau * 0.9)
    expect(lag).toBeLessThan(v * tau * 1.1)
    // And the tracked velocity has converged on the target's.
    expect(vel.z).toBeGreaterThan(v * 0.95)
  })

  it('caps the CLOSING SPEED at maxSpeed, which is what clamping the error buys', () => {
    // Unity clamps `change` to `maxSpeed × smoothTime`, not the speed — but a
    // critically damped tracker closes an error `e` at about `e/τ`, so capping
    // `e` at `maxSpeed·τ` caps the rate at `maxSpeed`. That is the property the
    // field is named for and the one the port depends on, so it is the one
    // asserted. (My first draft asserted that the clamp pulls the camera to
    // within 10 m in a few frames. It does not: from 10 km away it needs a
    // minute and a half, because it is a speed limit and not a leash.)
    const tau = 0.1
    const maxSpeed = 100
    const pos = new THREE.Vector3(0, 0, 10_000)
    const vel = new THREE.Vector3()
    const target = new THREE.Vector3(0, 0, 0)
    let peak = 0
    for (let i = 0; i < 600; i++) {
      const before = pos.z
      smoothDamp(pos, target, vel, tau, maxSpeed, 1 / 60)
      peak = Math.max(peak, (before - pos.z) * 60)
    }
    expect(peak).toBeLessThanOrEqual(maxSpeed)
    expect(peak).toBeGreaterThan(maxSpeed * 0.85)
  })

  it('reaches a static target and does not overshoot it', () => {
    const pos = new THREE.Vector3(0, 0, 40)
    const vel = new THREE.Vector3()
    const target = new THREE.Vector3(0, 0, 0)
    let minZ = Number.POSITIVE_INFINITY
    for (let i = 0; i < 600; i++) {
      smoothDamp(pos, target, vel, 0.066, 695, 1 / 60)
      minZ = Math.min(minZ, pos.z)
    }
    expect(pos.distanceTo(target)).toBeLessThan(0.01)
    expect(minZ).toBeGreaterThan(-0.01)
  })
})

describe('DEV-156: Classic draws 2016’s camera, not the parking space', () => {
  /**
   * The HoverJet's beam: the SYMMETRIC extent of `hoverjet-exterior.glb`'s
   * POSITION accessor, ±3.0827093, node scale exactly 1 — metres, not the
   * centimetre trap. The same number DEV-150's block measures with.
   */
  const BEAM_M = 6.1654

  /**
   * The fraction of the frame's WIDTH a `width`-metre object at `d` metres
   * covers, through a `vfovDeg` VERTICAL lens at `aspect`. TANGENTS, not
   * angles — the units bug DEV-150 caught in DEV-128's table (DEV-027).
   */
  const frameFraction = (width: number, d: number, vfovDeg: number, aspect: number): number =>
    width / d / (2 * Math.tan(THREE.MathUtils.degToRad(vfovDeg) / 2) * aspect)

  /** `render/renderer.ts` builds the scene camera at 70° and Classic adds nothing to it. */
  const RESTING_FOV = 70
  const ASPECT = 16 / 9

  it('settles well behind the parked pose: 18–25 m at cruise, not 9', () => {
    for (const v of [145, 148, 153]) {
      const d = settledDistance(HJ, v)
      expect(d, `${v} m/s`).toBeGreaterThan(18)
      expect(d, `${v} m/s`).toBeLessThan(25)
    }
  })

  it('the ship covers as much of the frame as the 2016 screenshots show', () => {
    // 11.40 / 12.27 / 12.96 % measured, and each is a LOWER bound —
    // foreshortening and JPEG blur only ever shrink a measured width.
    // The port measures 11.84 % at 145 m/s and 11.58 % at 153 — inside the
    // measured spread, which is as close as this can be checked.
    for (const v of [145, 153]) {
      const pct = 100 * frameFraction(BEAM_M, settledDistance(HJ, v), RESTING_FOV, ASPECT)
      expect(pct, `${v} m/s`).toBeGreaterThan(9)
      expect(pct, `${v} m/s`).toBeLessThan(14)
    }
  })

  it('rejects the pose Classic used to draw, and the old 30 m guess', () => {
    // A band that admits only the value it was written for has tested nothing.
    // `CamRoot_3rdPerson`'s parked pose is the bug this row fixes and it has to
    // fall OUTSIDE the band; 30 m was DEV-128's arm plus its lag, and so does it.
    // 27.34 % and 8.26 % against a band of 9–14: both out, from opposite sides.
    const at = (d: number) => 100 * frameFraction(BEAM_M, d, RESTING_FOV, ASPECT)
    expect(at(HOVERJET_THIRD_PERSON.position.length())).toBeGreaterThan(14)
    expect(at(30)).toBeLessThan(9)
  })

  it('the trail is real: the camera sits further back the faster the ship goes', () => {
    // The parked pose could not do this — it is the same distance at every
    // speed, which is what the old Classic e2e test asserted and why the bug
    // survived. A monotone rise in speed is the discriminating case.
    const slow = settledDistance(HJ, 56)
    const cruise = settledDistance(HJ, 145)
    const fast = settledDistance(HJ, 220)
    expect(cruise).toBeGreaterThan(slow + 3)
    expect(fast).toBeGreaterThan(cruise + 3)
  })

  it('is ALMOST frame-rate independent — and the residue is measured, not assumed', () => {
    // Worth being exact about, because DEV-150's row says "frame-rate
    // INDEPENDENT" and that is true of the port's own exponential lag
    // (`1 − exp(−dt/τ)`, which composes exactly) and only APPROXIMATELY true of
    // SmoothDamp. Unity's `exp` is a Padé fit, `1/(1 + x + 0.48x² + 0.235x³)`,
    // and a fit does not compose: measured, the same 150 m/s settles at
    //
    //     30 Hz 20.01 m · 60 Hz 21.21 · 72 Hz 21.42 · 90 Hz 21.64
    //     120 Hz 21.86 · 144 Hz 21.96 · 240 Hz 22.17
    //
    // — a 0.76 m spread across 60–144 Hz, 3.6 % of the distance, always in the
    // same direction. Nothing like a per-frame `Lerp`, which would double, and
    // small enough that nobody will see it; but it is not zero and the ledger
    // should not say it is.
    const a = settledDistance(HJ, 150, 60)
    const b = settledDistance(HJ, 150, 144)
    expect(Math.abs(a - b)).toBeGreaterThan(0.1)
    expect(Math.abs(a - b) / a).toBeLessThan(0.05)
    // Monotone in the frame rate, and bounded at both ends of anything real.
    expect(settledDistance(HJ, 150, 30)).toBeGreaterThan(19)
    expect(settledDistance(HJ, 150, 240)).toBeLessThan(23)
  })

  it('without DelayedReparent it would be RIGID — the two readings disagree', () => {
    // The structural fact decides the number, so the test has to show that it
    // does. `detached: false` is the world where the ship carries the camera
    // root and the damp cancels itself; that world is the 12.6 m target, flat
    // across every speed.
    const welded: ShipChase = { ...HJ, detached: false }
    const slow = settledDistance(welded, 56)
    const fast = settledDistance(welded, 220)
    expect(slow).toBeCloseTo(HJ.targetOffset.length(), 3)
    expect(fast).toBeCloseTo(slow, 3)
    expect(settledDistance(HJ, 220) - fast).toBeGreaterThan(5)
  })
})

describe('the horizon is level, and the lens is on the ship', () => {
  /** The camera's own axes, world space, from the rig quaternion. */
  const axes = (q: THREE.Quaternion) => ({
    // A camera looks down its own −z.
    forward: new THREE.Vector3(0, 0, -1).applyQuaternion(q),
    right: new THREE.Vector3(1, 0, 0).applyQuaternion(q),
    up: new THREE.Vector3(0, 1, 0).applyQuaternion(q),
  })

  it('levelRoll leaves the aim untouched and takes the bank out', () => {
    // GEOMETRY, not a quaternion: the forward vector has to survive to the last
    // digit (a rotation about z fixes the z axis) and the right vector has to
    // come out horizontal. Both are true whatever I believed about euler order.
    const q = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(THREE.MathUtils.degToRad(-17), THREE.MathUtils.degToRad(40), 0.7, 'YXZ'),
    )
    const before = axes(q).forward
    levelRoll(q)
    const after = axes(q)
    expect(after.forward.distanceTo(before)).toBeLessThan(1e-9)
    expect(Math.abs(after.right.y)).toBeLessThan(1e-9)
  })

  it('a hard bank does not tilt the camera', () => {
    // The discriminating case: fly the same ship rolled 60° and level, and the
    // camera's right vector has to stay horizontal in BOTH. This is the fact
    // `rollFollow` 0.35 deviates from on the Anniversary preset.
    for (const rollDeg of [0, 30, 60, -75]) {
      const chase = createClassicChase()
      const s = ship()
      s.shipQuaternion.setFromEuler(new THREE.Euler(0, 0, THREE.MathUtils.degToRad(rollDeg), 'YXZ'))
      for (let i = 0; i < 480; i++) {
        s.shipPosition.z -= 145 / 60
        chase.update(HJ, { ...s, dt: 1 / 60 })
      }
      expect(Math.abs(axes(chase.quaternion).right.y), `roll ${rollDeg}°`).toBeLessThan(1e-6)
    }
  })

  it('the HoverJet’s lens is on the ship and the JumpSeat’s leads it', () => {
    // 2016 authored these differently and the port must not average them: the
    // HoverJet aims 0.27 m BEHIND the ship's origin, the JumpSeat 4.64 m AHEAD.
    // Measured as where the camera ray passes relative to the ship, which is
    // true however the quaternion was built.
    const hj = flyStraight(HJ, 145)
    const hjForward = axes(hj.quaternion).forward
    const toShip = hj.ship.clone().sub(hj.camera)
    const miss = toShip.clone().sub(hjForward.clone().multiplyScalar(toShip.dot(hjForward)))
    expect(toShip.dot(hjForward), 'the ship is in front of the lens').toBeGreaterThan(0)
    expect(miss.length(), 'the ray passes through the ship').toBeLessThan(1)

    // The JumpSeat's aim point is ahead, so the ray passes the ship WIDE — and
    // the sheet says by how much, in its own frame.
    expect(JS.aimOffset.z).toBeLessThan(-4) // three: −z is forward
    expect(HJ.aimOffset.z).toBeGreaterThan(0) // three: +z is behind
  })
})

describe('the JumpSeat is its own camera', () => {
  it('its arm is SHORTER than its parking space, the opposite of the HoverJet', () => {
    // Not a symmetry: 2016 authored the JumpSeat's target INSIDE the parked
    // pose (7.005 m against 8.638 m) and the HoverJet's outside it. A port that
    // shared one block between the vehicles would get one of them wrong.
    expect(JS.targetOffset.length()).toBeCloseTo(7.005, 2)
    expect(JS.targetOffset.length()).toBeLessThan(HJ.targetOffset.length())
  })

  it('its camera cannot fly faster than 100 m/s, and the machine can', () => {
    // `positionMaxSpeed` is a SPEED LIMIT ON THE CAMERA, not a cap on the
    // trail — clamping the error to `maxSpeed × smoothTime` caps the closing
    // rate at `maxSpeed`, which is the test above. The JumpSeat's is 100 m/s
    // and `jumpseat-autopilot-missions.test.ts` derives the machine's own
    // ceiling at about 136 m/s (fully boosted against free-fall drag), with
    // `int_02_jumpSeat` historically seen at 92.
    //
    // So 2016's JumpSeat camera keeps up below about 92 m/s and FALLS BEHIND
    // above it, without bound, for as long as the dive lasts. Measured trails:
    // 1.7 m at 20 m/s, 5.3 at 60, 7.1 at 80 — and then 142 m at 99 and 2.2 km
    // at a sustained 200. That is 2016's own limit and the port keeps it;
    // DEV-156's row says why and leaves the deviation open.
    const trail = (v: number) => settledDistance(JS, v) - JS.targetOffset.length()
    expect(trail(20)).toBeLessThan(2.5)
    expect(trail(60)).toBeLessThan(6)
    expect(trail(80)).toBeLessThan(8)
    // Above the cap the steady state is not a trail at all, it is a divergence.
    expect(trail(120)).toBeGreaterThan(100)
  })

  it('the HoverJet’s cap is 45.9 m of error and nothing it can fly ever reaches it', () => {
    // 695 × 0.066. The trail grows linearly with speed right through the
    // HoverJet's whole envelope, which is what "never binds" looks like from
    // outside: 8.3 m at 145, 12.6 at 220, 17.2 at 300, all ≈ v × 0.0574.
    const trail = (v: number) => settledDistance(HJ, v) - HJ.targetOffset.length()
    const a = trail(145)
    const b = trail(300)
    expect(b / a).toBeGreaterThan((300 / 145) * 0.95)
    expect(b / a).toBeLessThan((300 / 145) * 1.05)
    expect(b).toBeLessThan(HJ.maxSpeed * HJ.smoothTimeSeconds)
  })

  it('its look smooths where the HoverJet’s is instantaneous', () => {
    // `Quaternion.Slerp(cur, want, dt * speed)` with the t clamped to 1. At
    // 60 Hz the HoverJet's 225 gives 3.75 → pinned at 1; the JumpSeat's 35
    // gives 0.583. So one of these is a real smoothing and the other is a cut,
    // and the difference is 2016's, including its frame-rate dependence.
    expect(HJ.lookSpeed / 60).toBeGreaterThan(1)
    expect(JS.lookSpeed / 60).toBeLessThan(1)
    expect(JS.lookSpeed / 144).toBeLessThan(1)
  })
})
