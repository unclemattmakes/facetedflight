// src/sim/jumpseat-jump.ts — the jumping spider's jump. DEV-383.
//
// Matt, 2026-09-24: *"pull both triggers to charge a 'jump burst' that when
// released, launches players into the air. then a slightly weaker hover jet so
// you control your descent rather than gain altitude."* The plan is
// `docs/plan/AIRCRAFT-VARIANTS.md` §4, and §11 settled its open calls: the
// spider jumps from a SURFACE only (no double jump), and the jump goes along
// the seat's OWN up, so you aim it by leaning.
//
// 2016 had no such thing. Every number here arrives in a `JumpSpec` out of
// `content/aircraft/jumpseat.json`'s `mechanics.jump` (validated by
// `content/aircraft-schema.ts`); this file holds none of its own, which is hard
// rule 3's standard for `src/sim/` (the only literals are the 0 and 1 of a
// clamp and a count).
//
// ── The gesture ───────────────────────────────────────────────────────────
//
// "Both triggers" is the JumpSeat's BOOST gesture on every device (throttle +
// boost; `Input_Manager.cs:220-231` boosts from the left trigger only while the
// right is held, and the port binds it that way on XR, pad, keyboard and
// touch). On a seat that carries a jump the gesture IS the charge, and the seat
// has no boost: `stepJumpSeat` hands its thruster a multiplier of 1 and its
// burn the plain rate whenever it is not charging. So nothing is rebound, and
// a player who knows how to boost a JumpSeat already knows how to charge this
// one.
//
//   · CHARGING = live AND the thruster lit AND throttle > 0 AND boost > 0 AND
//     FOOTING (supported now, or within `graceSeconds`) AND no burst still
//     running. `charge` runs 0 -> 1 over
//     `chargeSeconds`, and stops at 1.
//   · While charging the THRUST is suppressed (the seat settles onto its sprung
//     legs, so the crouch is physics, not an animation) and the tank burns at
//     the seat's own BOOSTED rate, `burnRate x boostBurnRateMultiplier` off the
//     variant's view: the charge is where the spider's boost went, so it costs
//     what its boost would have. The burn stops with the charge at 1: holding a
//     full charge costs nothing but patience.
//   · RELEASE is the tick the charging condition first breaks. It FIRES only if
//     the seat is still supported and lit and has charged for at least
//     `minChargeSeconds`; otherwise the charge is dropped, and what it burnt is
//     spent. So brushing both triggers does not hop, lifting off a slope while
//     charging does not hop, and a tank that runs dry mid-charge does not hop
//     (a latched-off thruster cannot jump: `disableThisWhenEmpty` IS the
//     Thruster, and the jump is the thruster's).
//   · Releasing only the boost side leaves the throttle, and the jet, lit: that
//     is how you control the descent. Releasing both drops you on 2016's
//     DragHack free-fall drag.
//
// ── SUPPORTED ─────────────────────────────────────────────────────────────
//
// Any leg `grounded` (`sim/jumpseat-legs.ts` sets it per leg, per tick) OR the
// hover ray within `hoverHeight` (`HoverMotor.motorActivated` inside the band
// that pushes, the same test `stepJumpSeat` already makes for the DragHack).
// Both are LAST tick's readings, taken before this tick's thrust, which is the
// one consistent moment in the step. So a spider charges standing on a pad, on
// a slope, on the sea (the ocean plate is a collider in 2016 and here) or
// hovering just above any of them; in the air both triggers do nothing but
// lift.
//
// ── The burst ─────────────────────────────────────────────────────────────
//
//   dv = impulseMin + (impulseMax − impulseMin) · curve(charge)
//
// delivered as a DIRECT VELOCITY EDIT along the seat's own +Y, `dv / n` per
// tick over `n = round(burstSeconds / dt)` ticks, AFTER `integrate` and beside
// the hover motor's impulse. The hover motor is this vehicle's precedent for a
// velocity edit (an impulse, "NOT divided by dt"). Along the BODY, re-read each
// tick of the burst: lean before you let go and the jump goes where you lean,
// the way the thruster does. `curve` is `art-lean.ts`'s Unity-shaped `Curve`,
// so the shape is data and a later hand-tune is a JSON edit.
//
// SIM LAYER: no three, no DOM, no wall clock, no randomness, no allocation in
// the hot path. Fixed dt only (D4). Every piece of state is PER SEAT (trap 19),
// and `tests/unit/jumpseat-jump.test.ts` steps a second spider and asserts the
// first's charge did not move.

import { type Curve, evaluateCurve } from './art-lean'
import type { HoverMotorSpec, HoverMotorState } from './hover-motor'
import type { JumpSeatLegs } from './jumpseat-legs'
import { rotateVec3 } from './math/quat'
import { type Vec3, v3 } from './math/vec3'
import type { RigidBody } from './rigidbody'

/**
 * The jump, as content describes it. Every field is Anniversary design with
 * nothing on 2016's sheet to scale, which is why it is a MECHANIC rather than a
 * `scale` key (AIRCRAFT-VARIANTS §2.2).
 */
export interface JumpSpec {
  /** Seconds of charging from empty to full. */
  readonly chargeSeconds: number
  /** A release after less charging than this does nothing. Seconds. */
  readonly minChargeSeconds: number
  /** m/s along the seat's +Y at the lightest release that fires. */
  readonly impulseMin: number
  /** m/s along the seat's +Y at a full charge. */
  readonly impulseMax: number
  /** Charge 0..1 -> how far from `impulseMin` to `impulseMax`, 0..1. */
  readonly curve: Curve
  /** Seconds the dv is spread over, from the release tick. */
  readonly burstSeconds: number
  /**
   * Seconds a seat may go UNSUPPORTED and still count as standing: a
   * platformer's "coyote time". A seat balanced on a crest, or rocking on its
   * gear after a landing, has feet that touch and leave on alternate ticks, and
   * without this the charge it is building is dropped on the first tick a foot
   * lifts. Longer than that and it has left the ground.
   */
  readonly graceSeconds: number
}

/** One seat's jump. PER SEAT, never module-level (trap 19). */
export interface JumpState {
  readonly spec: JumpSpec
  /** 0 .. 1: how full the charge is. */
  charge: number
  /** Seconds charged, capped at `chargeSeconds`. What `minChargeSeconds` is judged on. */
  chargedSeconds: number
  /** The charging condition held on the last tick. Its first false after true is the release. */
  charging: boolean
  /** Ticks of burst still to deliver. 0 when no jump is under way. */
  burstTicksLeft: number
  /** m/s added along the seat's +Y on each burst tick. */
  burstDv: number
  /** The whole dv of the last jump that fired, m/s. An OUTPUT, for the HUD and the tests. */
  lastDv: number
  /** Jumps fired since the last reset. */
  jumps: number
  /** Seconds since the seat was last supported: 0 while it is, Infinity before it ever was. */
  unsupportedFor: number
}

export const createJump = (spec: JumpSpec): JumpState => ({
  spec,
  charge: 0,
  chargedSeconds: 0,
  charging: false,
  burstTicksLeft: 0,
  burstDv: 0,
  lastDv: 0,
  jumps: 0,
  // No footing until the seat has first stood on something: a seat made in
  // the air is not standing for the first `graceSeconds`.
  unsupportedFor: Number.POSITIVE_INFINITY,
})

/** Back to empty: a respawn, a reload. The spec stays. */
export const resetJump = (state: JumpState): void => {
  state.charge = 0
  state.chargedSeconds = 0
  state.charging = false
  state.burstTicksLeft = 0
  state.burstDv = 0
  state.lastDv = 0
  state.jumps = 0
  state.unsupportedFor = Number.POSITIVE_INFINITY
}

/**
 * Has the seat FOOTING: supported now, or within `graceSeconds` of it. What
 * the charge and the release are judged on, and what a pilot reads to know it
 * is standing. As of the last `stepJumpCharge`.
 */
export const jumpFooting = (state: JumpState): boolean =>
  state.unsupportedFor <= state.spec.graceSeconds

/**
 * The dv a release at `charge` delivers, m/s. Exported so the HUD, the pilot
 * and the tests read the one formula rather than three copies of it.
 */
export const jumpDv = (spec: JumpSpec, charge: number): number => {
  const c = charge < 0 ? 0 : charge > 1 ? 1 : charge
  return spec.impulseMin + (spec.impulseMax - spec.impulseMin) * evaluateCurve(spec.curve, c)
}

/** The burst's length in fixed ticks: `burstSeconds / dt`, rounded, and at least one. */
export const burstTicks = (spec: JumpSpec, dt: number): number =>
  Math.max(1, Math.round(spec.burstSeconds / dt))

/**
 * Is the seat standing on, or hovering just over, something it can push off?
 * Any leg grounded, or the hover ray inside the band the motor pushes in. Both
 * are what the LAST tick left behind (see the header).
 */
export const jumpSupported = (
  legs: JumpSeatLegs | null,
  hover: HoverMotorState,
  hoverSpec: HoverMotorSpec,
): boolean => {
  if (hover.active && hover.distance <= hoverSpec.hoverHeight) return true
  if (!legs) return false
  for (const leg of legs.legs) if (leg.grounded) return true
  return false
}

/** What the charge did this tick, for `stepJumpSeat`'s thrust and burn. */
export interface JumpTick {
  /** Charging this tick: the thrust is suppressed and the boost is the charge's. */
  charging: boolean
  /** The charge was not yet full at the start of this tick: it burns at the boosted rate. */
  burning: boolean
  /** A jump fired on this tick; the burst starts after `integrate`. */
  fired: boolean
}

/**
 * Advance the charge one fixed tick, BEFORE the thruster. `held` is the
 * gesture (throttle > 0 and boost > 0), `lit` is `live && thrusterEnabled`, and
 * `supported` is `jumpSupported` for this seat. Writes `out` and returns it.
 */
export const stepJumpCharge = (
  state: JumpState,
  held: boolean,
  lit: boolean,
  supported: boolean,
  dt: number,
  out: JumpTick,
): JumpTick => {
  out.charging = false
  out.burning = false
  out.fired = false
  const spec = state.spec
  state.unsupportedFor = supported ? 0 : state.unsupportedFor + dt
  const footing = jumpFooting(state)
  if (held && lit && footing && state.burstTicksLeft === 0) {
    out.charging = true
    out.burning = state.chargedSeconds < spec.chargeSeconds
    const next = state.chargedSeconds + dt
    state.chargedSeconds = next > spec.chargeSeconds ? spec.chargeSeconds : next
    state.charge = state.chargedSeconds / spec.chargeSeconds
    state.charging = true
    return out
  }
  if (state.charging && lit && footing && state.chargedSeconds >= spec.minChargeSeconds) {
    const dv = jumpDv(spec, state.charge)
    const n = burstTicks(spec, dt)
    state.burstTicksLeft = n
    state.burstDv = dv / n
    state.lastDv = dv
    state.jumps++
    out.fired = true
  }
  state.charging = false
  state.charge = 0
  state.chargedSeconds = 0
  return out
}

// Volatile module-level scratch, written and read inside `applyJumpBurst` only.
const _up: Vec3 = v3()
const UP_BODY: Vec3 = Object.freeze(v3(0, 1, 0)) as Vec3

/**
 * One tick of the burst, AFTER `integrate`: a velocity edit of `burstDv` along
 * the body's CURRENT +Y. Returns true while a burst is under way.
 */
export const applyJumpBurst = (state: JumpState, body: RigidBody): boolean => {
  if (state.burstTicksLeft <= 0) return false
  rotateVec3(_up, body.orientation, UP_BODY)
  body.velocity.x += _up.x * state.burstDv
  body.velocity.y += _up.y * state.burstDv
  body.velocity.z += _up.z * state.burstDv
  state.burstTicksLeft--
  return true
}
