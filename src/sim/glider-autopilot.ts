// src/sim/glider-autopilot.ts — a hands-on-the-stick pilot for `sim/glider.ts`.
//
// ── Why this is in `src/` and not in a test ───────────────────────────────
//
// Because of the brief's sharpest line: *"a glider that cannot complete its own
// mission is not a prototype."* Proving that needs something to fly it, and the
// existing `sim/autopilot.ts` cannot — it commands a vehicle that thrusts along
// body +Z and holds altitude by pointing at things, which is the opposite of a
// vehicle whose only currency is height. Point a glider at a gate below you and
// it arrives at 170 m/s with nothing left; point it at one above you and it
// stalls.
//
// So the controller is different in kind, not in tuning, and it lives beside
// the model it flies. It is also the thing an AI glider racer would need
// (DEV-125's shape), so a test-only copy would have to be written twice.
//
// ── What it does ──────────────────────────────────────────────────────────
//
// Bank-to-turn, exactly as the airframe wants:
//
//   1. put the target in the body frame
//   2. ROLL so the target's bearing lies in the wings-level plane — the amount
//      of bank is proportional to how far off to the side it is
//   3. PITCH toward the target's elevation, but clamped by an ENERGY rule
//      rather than by an angle: never command an attitude that would take the
//      airspeed below the stall band, and never hold the nose down once you
//      already have more speed than the next gate needs
//   4. fire the ROCKET only when the glide will not reach — measured as
//      "required glide ratio to the target exceeds what the airframe can do"
//
// Rule 3 is the whole difference. A position controller flies into the ground
// or into a stall; an energy controller spends height deliberately.
//
// Purity: no three, no DOM, no clock, no RNG (hard rule 4). Fixed dt.

import type { GliderInput, GliderTuning } from './glider'
import { type Quat, rotateVec3, rotateVec3Inverse } from './math/quat'
import { clamp, wrapPi } from './math/scalar'
import { length, sub, type Vec3, v3 } from './math/vec3'

/** Scratch. Module-level, valid only inside one synchronous call. */
const _toTarget = v3()
const _bodyUp = v3()
const _bodyRight = v3()
const _omega = v3()
const _up = v3(0, 1, 0)
const _right = v3(1, 0, 0)

export interface GliderAutopilotTuning {
  /**
   * Stick per radian of BANK error, clamped to +/-1.
   *
   * Note what this is NOT: stick per radian of heading error. The stick
   * commands a roll RATE, so a controller that wires heading error straight to
   * it never stops rolling — it inverts, and from there every other command is
   * backwards. That is not a tuning failure, it is a missing loop, and it is
   * what the first two versions of this file did: gate one, full roll, inverted
   * by second seven, 36 km under the sea by second sixty. Bank is an ANGLE and
   * wants an angle loop.
   */
  readonly rollGain: number
  /**
   * Stick per rad/s of ROLL RATE. The damping half of the bank loop.
   *
   * The airframe's only roll damping is `angularDrag`, a 0.45 s time constant,
   * so a stick that centres exactly on the target bank arrives with the roll
   * still running and sails past it. Proportional-only, this vehicle overshot
   * into a steep bank, and a steep bank plus the back-stick below is a
   * graveyard spiral — which is precisely what it flew, at 221 m/s, straight
   * down, for the whole 60 s budget.
   */
  readonly rollDamping: number
  /** Radians of bank commanded per radian of heading error. */
  readonly bankPerHeading: number
  /** The bank the pilot will not exceed, radians. Past 90 degrees is inverted. */
  readonly maxBank: number
  /**
   * The most back-stick `turnHold` is allowed to add, 0..1.
   *
   * Uncapped it reaches 0.82 at the floored bank and saturates the elevator, so
   * the pilot is holding full back-stick in a steep bank and has nothing left
   * to answer anything else with.
   */
  readonly turnHoldMax: number
  /**
   * Below this much of the wings' own up remaining (world Y of body +Y), the
   * pilot stops flying the course and flies the aeroplane.
   *
   * Unusual-attitude recovery, and not optional: near knife-edge and past it,
   * "heading to the target" and "bank" are both degenerate, and a controller
   * that keeps chasing the gate will hold whatever it was holding all the way
   * into the sea.
   */
  readonly recoverBelowUp: number
  /** Pitch command per radian of FLIGHT-PATH elevation error, clamped to +/-1. */
  readonly pitchGain: number
  /**
   * Back-stick added to hold a banked turn, per unit of `1/cos(bank) - 1`.
   *
   * A banked wing spills lift: the vertical component is `L cos(bank)`, so the
   * turn needs `1/cos(bank)` times the lift to stay level. Without this the
   * glider falls out of every corner, which is exactly what the first version
   * did — it dived 30 km into the sea after the first gate.
   */
  readonly turnHold: number
  /**
   * m/s of margin over `stallSpeed + stallWidth` the pilot insists on keeping.
   * Below it the stick goes forward whatever the target is doing.
   */
  readonly speedMargin: number
  /**
   * Metres of predicted SHORTFALL before the rocket is worth spending.
   *
   * The rule is "where will I be when I get there": glide the remaining
   * horizontal distance at the airframe's best ratio and compare the answer to
   * the target's altitude. Fire only if that arrives this far below it.
   *
   * The obvious metric — "the glide ratio this target demands exceeds mine" —
   * is wrong close in, and wrongly enough to lose the run. A gate 270 m ahead
   * and 11 m below demands 24 : 1, which reads as hopeless; gliding there at
   * 7 : 1 actually arrives 27 m low, comfortably inside a 55 m ring. The old
   * rule fired at every such gate, dumped three seconds of fuel into 100 m/s
   * nobody asked for, and turned the run into a ballistic arc past everything.
   */
  readonly rocketMargin: number
}

export const DEFAULT_GLIDER_AUTOPILOT: GliderAutopilotTuning = {
  rollGain: 2.4,
  rollDamping: 2.4,
  bankPerHeading: 1.1,
  maxBank: 0.9,
  pitchGain: 2,
  turnHold: 0.35,
  turnHoldMax: 0.4,
  recoverBelowUp: 0.45,
  speedMargin: 10,
  rocketMargin: 60,
}

export interface GliderAutopilotBody {
  readonly position: Vec3
  readonly orientation: Quat
  readonly velocity: Vec3
  /** World-space, rad/s. The bank loop needs the RATE as well as the angle. */
  readonly angularVelocity: Vec3
}

/**
 * The best glide ratio this airframe can manage, at its trim point: `Cl / Cd`.
 *
 * Derived from the tuning rather than stated, so a retune moves it and the
 * pilot's rocket decision follows. Valid only because `sim/glider.ts` uses ONE
 * `aeroScale` for lift and drag — see the note on that field for what happens
 * when it does not.
 */
export const bestGlideRatio = (tuning: GliderTuning): number => {
  const cl = tuning.liftSlope * tuning.trimAngleOfAttack
  return cl / (tuning.parasiteDrag + tuning.inducedDrag * cl * cl)
}

/**
 * One tick of pilot intent, written into `out`.
 *
 * `out` is caller-owned on purpose: `ai-racer.ts` shared one input object
 * across every racer and a finished racer flew on with another racer's stick
 * (trap 19, DEV-032). One object per pilot, never a module-level one.
 *
 * ── Everything here is in WORLD terms, and that is the fix ────────────────
 *
 * The first version of this controller worked in the BODY frame: bearing and
 * elevation of the target as the pilot sees them. That is coherent for an
 * aircraft flying wings-level and meaningless for one in a bank, where "pull
 * up" is "turn". It rolled hard toward the first gate, pulled what it thought
 * was up, and flew 30 km straight down.
 *
 * So: heading and elevation are taken of the FLIGHT PATH against the direction
 * to the target, both in world space, and bank only enters through
 * `turnHold` — the extra back-stick a banked wing needs to hold its lift.
 */
export const gliderAutopilotActions = (
  body: GliderAutopilotBody,
  target: Vec3,
  airspeed: number,
  fuel: number,
  vehicle: GliderTuning,
  out: GliderInput,
  tuning: GliderAutopilotTuning = DEFAULT_GLIDER_AUTOPILOT,
): void => {
  sub(_toTarget, target, body.position)
  const range = length(_toTarget)
  if (range < 1e-3 || airspeed < 1e-3) {
    out.roll = 0
    out.pitch = 0
    out.yaw = 0
    out.rocket = false
    return
  }

  const tx = _toTarget.x / range
  const ty = _toTarget.y / range
  const tz = _toTarget.z / range
  const vx = body.velocity.x / airspeed
  const vy = body.velocity.y / airspeed
  const vz = body.velocity.z / airspeed

  // ── Roll: bank toward the heading the target is on ─────────────────────
  //
  // Measured against the FLIGHT PATH, not the nose: the nose is where the
  // sideslip is, and the fin is already dealing with that.
  //
  // The sign is not reasoned, it is measured — a glider holding `roll = +1`
  // turns its flight path toward +x, so a target to the right (positive
  // heading error) wants a positive bank. That measurement is asserted in
  // `glider-autopilot.test.ts`; the orientation lesson says a sign you derived
  // is a sign you believe.
  //
  // Two loops. The OUTER one turns a heading error into a bank to hold, capped
  // at `maxBank`. The INNER one puts the stick where it needs to be to REACH
  // that bank and then centres it. Bank read from the wing, not integrated.
  const headingError = wrapPi(Math.atan2(tx, tz) - Math.atan2(vx, vz))
  rotateVec3(_bodyRight, body.orientation, _right)
  rotateVec3(_bodyUp, body.orientation, _up)
  // `atan2`, NOT `asin`. `asin(-right.y)` saturates at 90 degrees and then
  // FOLDS: an aircraft rolled to 135 degrees reads back as 45, so the
  // controller sees a gentle bank while it is upside down and holds the stick
  // over. That is how the previous version got inverted and stayed there —
  // full back stick, alpha zero, straight down, for 60 s. Bringing `up.y` in
  // gives the full +/-180 and an inverted aircraft reads as inverted.
  // TWO measured facts, and neither is the one that felt obvious:
  //
  //   1. a positive roll input raises the body's right vector, so
  //      `atan2(right.y, up.y)` GROWS with positive roll
  //   2. that same positive bank turns the flight path's heading NEGATIVE
  //
  // Hence `+_bodyRight.y` here and the minus on `wantBank` below. Written the
  // other way round the outer loop is positive feedback: it rolled the glider
  // onto its back inside two seconds, every time, from the first corner.
  //
  // Fact 2 took three attempts because the FIRST measurement of it was a lie.
  // Holding `roll = +1` for six seconds and reading the heading at the end says
  // the heading went positive — but by then the aircraft has rolled through 180
  // degrees and is turning the other way. Read at one second, before it rolls
  // past knife-edge, the answer is the opposite. **A measurement of a sign has
  // to be taken before the thing being measured changes sign.**
  const bank = Math.atan2(_bodyRight.y, _bodyUp.y)

  // Wings level when the attitude has got away from us — see `recoverBelowUp`.
  const recovering = _bodyUp.y < tuning.recoverBelowUp
  const wantBank = recovering
    ? 0
    : clamp(-headingError * tuning.bankPerHeading, -tuning.maxBank, tuning.maxBank)

  rotateVec3Inverse(_omega, body.orientation, body.angularVelocity)
  out.roll = clamp(wrapPi(wantBank - bank) * tuning.rollGain - _omega.z * tuning.rollDamping, -1, 1)

  // ── Pitch: flight-path elevation, plus the bank's tax ──────────────────
  //
  // Positive `pitch` puts the nose DOWN (see `GliderInput`), so aiming at
  // something above is a negative command.
  //
  // While recovering, the target is not the gate: it is LEVEL. Chasing a gate
  // from an unusual attitude is how the attitude got unusual.
  const wantElevation = recovering ? 0 : Math.asin(clamp(ty, -1, 1))
  const elevationError = wantElevation - Math.asin(clamp(vy, -1, 1))
  let pitch = clamp(-elevationError * tuning.pitchGain, -1, 1)

  // The wings' own up, in world: how much of the lift is still fighting
  // gravity. `1/cos(bank) - 1` is the shortfall, and it goes to infinity at 90
  // degrees, so it is floored. `_bodyUp` was measured for the bank loop above.
  pitch -= clamp(tuning.turnHold * (1 / Math.max(_bodyUp.y, 0.3) - 1), 0, tuning.turnHoldMax)

  const floor = vehicle.stallSpeed + vehicle.stallWidth + tuning.speedMargin
  if (airspeed < floor) {
    // Too slow to be choosing. The nose goes down by whatever the deficit is
    // worth, and the target waits. This is the ONLY speed rule: an earlier
    // version also refused to descend when FASTER than the course needed, and
    // that one ballooned — held level with 160 m/s in hand, it climbed away
    // from the gate at 40 m/s and circled. Excess speed is not a problem to be
    // solved, it is height in the bank.
    pitch = Math.max(pitch, clamp((floor - airspeed) / tuning.speedMargin, 0, 1))
  }
  out.pitch = clamp(pitch, -1, 1)

  // ── Yaw: unused ────────────────────────────────────────────────────────
  //
  // Deliberately zero. This airframe yaws at 17 deg/s and every degree of it
  // makes sideslip, which `sideBleed` then charges for. A pilot that turns with
  // the rudder is a pilot that arrives slow.
  out.yaw = 0

  // ── Rocket: only when the glide will not reach ─────────────────────────
  //
  // `required` is the glide ratio the target demands from here, against what
  // the airframe can actually do — computed from the same tuning the physics
  // reads, so a retune cannot leave the pilot believing in a glide the vehicle
  // no longer has. A target at or above this altitude demands infinity, which
  // is the honest answer: no amount of gliding climbs.
  const horizontal = Math.hypot(_toTarget.x, _toTarget.z)
  const arriveAt = body.position.y - horizontal / bestGlideRatio(vehicle)
  // Never while recovering: thrust into an unusual attitude makes it worse, and
  // the rocket is a resource that wants spending on a line, not on a spiral.
  out.rocket = !recovering && fuel > 0 && arriveAt < target.y - tuning.rocketMargin
}
