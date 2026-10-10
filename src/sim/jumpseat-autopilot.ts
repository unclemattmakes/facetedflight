// src/sim/jumpseat-autopilot.ts — fly the JumpSeat without a pilot.
//
// ── What this is for, and why it had to exist ─────────────────────────────
//
// `?autopilot=1` flies a course so a human does not have to, and `sim/autopilot.
// ts` has done that for the HoverJet since M1. Run it on any of the six
// **JumpSeat** missions and it scores **nothing at all**: that controller
// commands a vehicle that thrusts along body **+Z**, the JumpSeat thrusts along
// body **+Y**, and the result flies into the nearest hillside inside ten seconds.
// So Target Practice — the dartboard, the accuracy streak, the medal curve, the
// finish slab, `game/targets.ts` entire — had never been played. Every claim
// about it rested on synthetic positions in unit tests.
//
// This file is what lets a run happen. It is a TEST AND DEMO INSTRUMENT, not a
// game feature: it produces the same `JumpSeatInput` a player would and hands it
// to the same `stepJumpSeat`, so it exercises the real flight model, the real
// pad plates, the real streak and the real finish rather than pretending to.
//
// It emits the SIM's own input type rather than `FlightActions`, because the sim
// layer may not reach into `src/input/` (hard rule 4). The game layer adapts.
//
// ── The JumpSeat is not a jet, and the controller is not a pursuit seeker ──
//
// `sim/autopilot.ts` points the nose at the ring and opens the throttle. That
// works because the HoverJet's thrust is its forward axis: aim and go. Nothing
// about it transfers.
//
//   · Thrust is along body **+Y**, so pointing the nose at a pad does nothing.
//     Motion comes from TILTING, and the tilt is the control variable.
//   · **Gravity is always on** at 32 m/s^2 against a thrust of 50, so the
//     controller is holding the machine up every tick it is flying. At the
//     50.2 degree tilt where the vertical component exactly cancels gravity the
//     ship settles at **34.45 m/s** — measured by stepping this model, not
//     reasoned. Boosted (x1.65, so 82.5 m/s^2) the balance is 67.2 degrees and
//     **68.2 m/s**.
//   · **It cannot thrust downward.** There is no negative-Y branch: a desired
//     acceleration pointing below the horizon is a request to invert the ship,
//     and a naive quadrotor law will happily try. Descending is done by
//     *withholding* thrust, which is why `aDes.y` is floored and the tilt is
//     clamped.
//   · **Drag is huge and isotropic.** 1.1/s under power: at 60 m/s that is 66
//     m/s^2 of deceleration for free, more than the ship can produce. Stopping is
//     cheap, accelerating is expensive, and a controller tuned for a jet's
//     inertia over-brakes into a hover.
//
// So this is a cascaded position controller — the quadrotor arrangement, because
// the JumpSeat IS a quadrotor with one nozzle:
//
//     aim point  ->  desired velocity  ->  desired acceleration
//                ->  desired thrust DIRECTION + throttle
//                ->  pitch / roll torques that swing body +Y onto it
//
// Nothing here has an integral term, for `sim/autopilot.ts`'s reason: an
// autopilot that integrates away a standing error masks exactly the flight-model
// regressions it exists to catch.
//
// ── The signs are MEASURED, not reasoned ──────────────────────────────────
//
// Driving each axis alone for 40 ticks from identity and reading the resulting
// basis (`tests/unit/jumpseat-autopilot.test.ts` re-measures all three, so they
// cannot rot):
//
//   pitch +1  ->  body +Y leans to (0, 0.991,  0.133)   thrust tips toward +Z
//   roll  +1  ->  body +Y leans to (-0.074, 0.997, 0)   thrust tips toward -X
//   yaw   +1  ->  body +Z swings to (0.101, 0, 0.995)   nose goes RIGHT
//
// which is exactly the cross product: the body-frame rotation that carries +Y
// onto a unit `u` has axis `(0,1,0) x u = (u.z, 0, -u.x)`, and the torque input
// vector is `(pitch * pitchRate, yaw * yawRate, roll * rollRate)` in BODY axes.
// So **pitch answers to `+u.z` and roll to `-u.x`**, and the yaw column is free
// for pointing the nose. That is a derivation and a measurement agreeing, which
// is the only version worth trusting — see "the agreement lesson".
//
// ── Fuel is the mission, not a detail ─────────────────────────────────────
//
// `maxFuel` 100, `burnRate` 1.9/s, boost x2.35, and the tank goes NEGATIVE. Two
// consequences shape everything below:
//
//  1. **The burn is BINARY in throttle.** `FuelManager.UpdateFuel()` guards on
//     `gasVal > 0` and nothing else, so 5 % throttle costs exactly what 100 %
//     does. Therefore thrust-per-fuel is maximised at FULL throttle and there is
//     no such thing as a fuel-saving idle. The controller closes the throttle
//     completely or opens it properly; `idleThrottle` is 0 for that reason and
//     not for a control one.
//  2. **A full tank is 52.6 s of flight.** Every tour below is longer than that,
//     so a route that does not refuel does not finish — and it took
//     `sim/jumpseat-refuel.ts` existing at all before one could. Holding station
//     inside a pad's 19.7 m refuel sphere nets **+8.1 units/s**, so a second
//     parked over a pad buys 4.3 seconds of flying somewhere else. That trade is
//     the whole of `JumpSeatPilot`'s fuel policy.
//
// ── What it aims at ───────────────────────────────────────────────────────
//
// The **bullseye centre**, never the pad. A pad is a dartboard (`sim/targets.ts`)
// and under the accuracy streak a bullseye raises the multiplier, a mid plate
// holds it and an outer plate RESETS it — so "get near the pad" and "fly the
// mission" are different games. The bullseye box is 14.54 m across and 2.61 m
// thick, and the controller parks in it, which is the one approach whose
// accuracy does not depend on the arrival speed.
//
// SIM LAYER: no three, no DOM, no wall clock, no randomness, no allocation in
// the hot path. Fixed dt only — nothing here ever sees a frame delta (D4).
//
// ── DEV-027: this controller decides ONCE PER SIM STEP ────────────────────
//
// `sim/autopilot.ts`'s header records the bug where the controller decided once
// per FRAME and the same stick was then applied to however many fixed steps that
// frame contained, so its effective rate rode the frame rate and no run was
// reproducible. `stepJumpSeatPilot` takes `dt` and is called from the fixed-step
// loop, exactly once per step. Do not hoist it into a render callback.

import { pathClearance } from './autopilot'
import { FIXED_DT } from './constants'
import type { JumpSeat, JumpSeatInput } from './jumpseat'
import { type HeadBox, headDepth } from './jumpseat-head'
import { jumpDv, jumpFooting } from './jumpseat-jump'
import { type JumpSeatLegSpec, legFootLocal } from './jumpseat-legs'
import { conjugate, type Quat, rotateVec3, rotateVec3Inverse } from './math/quat'
import { clamp } from './math/scalar'
import { copy, distanceSq, set, type Vec3, v3 } from './math/vec3'
import { type PropColliders, propPenetrationAt } from './props/collision'
import { type OrientedBox, sweepHitsBox } from './targets'
import {
  belowField,
  type HeightField,
  highestGroundUnder,
  outsideField,
  PADS_SOLID,
  terrainHeightAt,
  terrainNormalAt,
} from './terrain/height-field'
import type { HullSphere } from './terrain-collision'

export interface JumpSeatAutopilotTuning {
  /**
   * Top speed the guidance will ask for, m/s.
   *
   * 62, which is above the 34.45 m/s the ship holds unboosted and below the
   * 68.2 m/s it holds boosted — both measured. That placement is the boost
   * policy: the demand saturates the unboosted thruster on every straight, which
   * is what `boostDemandFraction` reads to decide the trigger is worth pulling,
   * and it stops short of the boosted ceiling so there is authority left for
   * turning.
   */
  readonly speedCap: number
  /**
   * Desired speed per metre of range, 1/s. The linear run-in.
   *
   * 0.8 means the ship is still at `speedCap` 78 m out and then bleeds off
   * linearly to a stop ON the plate. That is timid for a vehicle that can shed
   * 66 m/s^2 on drag alone, and it is deliberate: arriving slowly is what makes
   * the bullseye a placement problem rather than a timing one, and the
   * re-acceleration it costs is one drag time constant (0.9 s), not a lap.
   * Swept at 0.65 and 1.1; both cost bullseyes, in opposite ways.
   */
  readonly approachGain: number
  /**
   * How high above a pad to cruise, metres, before the run-in starts.
   *
   * 60 m. Pads sit 1 to 386 m above the ground (measured across the six
   * missions, and the 386 is over open sea on `int_01`), so an approach that
   * held the pad's own altitude would fly the low ones through the hillside they
   * are parked on. The terrain term below is the backstop; this is the part that
   * means it rarely has to fire.
   *
   * It is also pure cost: every metre of standoff is climbed AND descended, once
   * per pad, and a climb is the most expensive fuel the ship burns. 90 m was
   * measured and rejected on time; 45 and 50 were measured and rejected on
   * accuracy, because a shorter final descent arrives with more of the cruise
   * still in it and turns bullseyes into mid plates.
   */
  readonly standoffMetres: number
  /**
   * Metres of height given up per metre closed, on the run-in.
   *
   * 0.45 — so the glide starts 133 m out and the aim point walks down onto the
   * pad. Steeper flies a dive-bomb that the sink limit then has to catch;
   * shallower spends the last 300 m skimming whatever the pad is standing on.
   */
  readonly glideSlope: number
  /** Acceleration demanded per m/s of velocity error, 1/s. */
  readonly velocityGain: number
  /**
   * Ceiling on the climb the guidance will ask for, m/s.
   *
   * 45, which is the boosted climb the ship can hold: `(a * boost - g) / drag =
   * (82.5 - 32) / 1.1` = 45.9 m/s. Asking for more would stall against the same
   * arithmetic `maxSinkRate` is derived from, and asking for LESS costs fuel —
   * a climb burns `burnRate / climbRate` per metre, so the slow climb is the
   * expensive one. Unboosted the same figure is 16.4 m/s, which is why a
   * JumpSeat with no fuel to spare goes up slowly and sideways.
   */
  readonly maxClimbRate: number
  /**
   * Floor on the descent the guidance will ask for, m/s.
   *
   * **21, and it is the SUSTAINABLE POWERED sink, not a comfort limit.** Derived
   * from the tuning rather than chosen: at the tilt clamp the thruster still
   * carries `a * cos(maxTilt)` upward, so the steady sink is
   *
   *     (g - a * cos(maxTilt)) / drag = (32 - 50 * cos 1.40) / 1.1 = 21.4 m/s
   *
   * and that number is load-bearing in a way a bigger one is not. Ask for more
   * than the ship can hold under power and the vertical acceleration demand goes
   * to zero, the tilt clamp is `aDes.y * tan(maxTilt)`, and the HORIZONTAL demand
   * collapses with it — the ship stops flying and starts falling. That is not a
   * tuning nicety: `adv_02_jumpSeat`'s fourth leg is 797 m out and 520 m down, a
   * 40 m/s sink cap turned it into a 35-second vertical drop with no forward
   * progress, and the run died there with four pads unvisited.
   *
   * `tests/unit/jumpseat-autopilot.test.ts` measures the real sustained sink and
   * checks this is not above it, so the derivation cannot drift away from the
   * vehicle (DEV-027).
   */
  readonly maxSinkRate: number
  /**
   * How far the thrust axis may be tilted from vertical, radians.
   *
   * 1.40 rad = **80 degrees**, well past the 67.2 degrees of boosted level
   * cruise, and it is not about speed: the cruise curve is flat past 67 degrees
   * (68.2 m/s at 67.2, 69.5 at 70). It is THE DESCENT AUTHORITY. The horizontal
   * acceleration a single thrust vector can deliver is `aDes.y * tan(maxTilt)`,
   * so the tilt clamp is what decides how much forward progress survives a
   * descent — at 70 degrees that factor is 2.75 and at 80 it is 5.67, and the
   * difference is whether `adv_02_jumpSeat`'s 520 m drop is a dive or a fall.
   * `maxSinkRate` below is derived from this, so the two move together.
   */
  readonly maxTilt: number
  /**
   * Attitude stiffness, rad/s^2 per unit of `sin(tilt error)`.
   *
   * Expressed as an ANGULAR ACCELERATION and divided by each axis's own rate at
   * the end, so one number tunes pitch (1.45) and roll (0.8) alike and neither
   * axis inherits the other's authority. 2.6 puts the undamped natural frequency
   * at 1.61 rad/s, about a 2 s swing.
   */
  readonly attitudeGain: number
  /**
   * Attitude damping, rad/s^2 per rad/s of body rate.
   *
   * 1.45, and it is not a taste: the body already carries `angularDrag` 1.75, so
   * the closed-loop damping term is 1.75 + 1.45 = 3.2 = 2 * 1.61, which is
   * critical for the stiffness above. An undamped attitude loop on a vehicle
   * whose thrust IS its attitude does not oscillate about a heading; it
   * oscillates about the ground.
   */
  readonly rateGain: number
  /** Nose-pointing stiffness, rad/s^2 per radian of bearing error. */
  readonly yawGain: number
  /**
   * Ground clearance to hold, metres, when far from a pad.
   *
   * 55, against `sim/autopilot.ts`'s 60 for a jet three times faster. Lower, not
   * higher, and for a reason that only shows up on this vehicle: the term below
   * is a CLIMB demand, and a climb is fuel. On a route whose pads sit 1 to 386 m
   * off the deck, a generous floor spends the tank flying over terrain nobody
   * was going to hit.
   */
  readonly minClearance: number
  /** How far ahead to look, in SECONDS of travel. */
  readonly lookAheadSeconds: number
  /** Path samples for `pathClearance`. Twelve, as the jet's — 8 m terrain quads. */
  readonly clearanceSamples: number
  /**
   * Climb demanded at full terrain urgency, m/s.
   *
   * 30, two thirds of what the ship can do, because this is a proportional term
   * on a probe that moves: full authority on a noisy measurement is how a
   * terrain follower turns into an oscillator. See `_probe` for the half of that
   * problem that was fixed by measuring something else instead.
   */
  readonly clearanceClimbRate: number
  /**
   * How close, metres, the pilot's HEAD may come to anything before the head
   * guard takes over (DEV-403). See `JumpSeatHeadGuard`.
   *
   * 1.0 — half the 2.0 m the head clears at rest on its legs. Swept at 0.25,
   * 0.5 and 1.0 with the old 22-unit `fuelReserve`: the two smaller margins
   * each lost `rookie_02_jumpSeat` to a head strike.
   */
  readonly headMargin: number
  /**
   * How far ahead the head guard looks, in SECONDS of travel.
   *
   * 1.0 — the JumpSeat's own stopping time: with the thrust swung upright its
   * drag of 1.1/s leaves `v / 1.1` metres of travel, so a second of look-ahead
   * is roughly the distance the seat needs to stop in.
   */
  readonly headLookAheadSeconds: number
  /**
   * Samples along that look-ahead, the current pose included. 9: an eighth of
   * a second apart, 4 m at the 34 m/s the seat cruises at unboosted.
   */
  readonly headSamples: number
  /**
   * Inside this range of the pad, the terrain floor tapers to nothing, metres.
   *
   * A pad is certified-clear airspace — 2016 put a dartboard there and expected
   * it to be flown through — exactly as a ring is for the jet. Unlike the jet's
   * hard 120 m switch this is a linear taper, because a pad at 1 m AGL
   * (`rookie_01_jumpSeat`'s fourth) and a pad at 386 m (`int_01_jumpSeat`'s
   * sixth) want very different amounts of relief and a step would give them the
   * same.
   *
   * **The range it tapers on is the range to the PLATE, never to the aim point,
   * and that distinction cost a mission.** With the aim 4 m under the plate, the
   * floor at range r was 0.5r while the ship's own clearance was (r - 4) + the
   * pad's own height off the deck — two lines with different slopes, which meet.
   * On `rookie_01_jumpSeat`'s fourth pad they met at **2.27 m above a plate 1.30
   * m thick**, and the ship hovered there, rock steady, 0.04 m off centre,
   * for the full timeout: a terrain-avoidance term holding the ship off the
   * thing it was avoiding terrain in order to reach. Measured on the range to
   * the plate the two lines cannot cross for any pad above the ground at all.
   */
  readonly padTrustMetres: number
  /**
   * Fraction of unboosted thrust the demand must exceed before boost is held.
   *
   * 0.92. Level cruise at the unboosted balance asks for exactly 1.0, so this
   * fires on every straight and releases in a hover — which is the shape you
   * want, since boost costs 2.35x fuel and a hover is where the fuel comes from.
   */
  readonly boostDemandFraction: number
  /**
   * Never hold boost below this much fuel, units.
   *
   * 30 — about 16 s of unboosted flight, enough to reach a pad from most of a
   * leg. Running the tank dry latches the thruster OFF until a refuel, and with
   * gravity on that is not a penalty, it is the sea.
   */
  readonly boostFuelFloor: number
  /**
   * How far above the bullseye to park while refuelling, metres.
   *
   * 8. The refuel sphere is 19.7 m in radius centred about 4 m above the
   * bullseye centre, so +8 sits 4 m above the sphere's own centre — deep inside
   * it — while lifting the hull clear of a pad whose plates are 1 m off the
   * deck. Parking ON the bullseye to refuel would park on the ground.
   */
  readonly refuelHoldMetres: number
  /**
   * Fuel to keep in hand beyond the next leg's estimate, units.
   *
   * 55, which is 29 s of unboosted flight. The leg estimate itself is
   * optimistic by construction — it prices a straight line at cruise and the
   * route is neither — so the reserve is doing the work the estimate cannot.
   *
   * **It was 22 until DEV-403, and the head strike is what moved it.** At 22 the
   * seat left a pad with a tank that covered the climb only if it hugged the
   * ground: `int_02_jumpSeat` reached pads 4 to 6 by scraping its head up the
   * hillside under them, 25 times. With the head kept clear the climb costs
   * more, the tank ran short on the way, and the pilot fell into a divert
   * cycle — up towards the pad, back down to refuel, up again.
   *
   * Swept over all six with the rule on, after DEV-383 gave the pads their
   * undersides and with the divert's departure priced on this reserve (see the
   * divert): 45, 50, 55 and 60 each take all but at most one pad on every
   * mission with no head strike; 35 and 40 lose `int_02` to a head strike at
   * about 64 s. 50 is inside that band with a passing neighbour either side.
   */
  readonly fuelReserve: number
  /** Multiplier on the straight-line leg estimate. See `fuelReserve`. */
  readonly fuelLegSafety: number
  /**
   * Fuel in hand, beyond the trip to the NEAREST pad, below which the pilot
   * abandons the leg and goes to refuel. Units.
   *
   * 12 — about six seconds of unboosted flight. The trigger is not a fixed tank
   * level, it is "can I still reach a petrol station": each tick the pilot
   * prices the trip to the nearest pad on the route, taken or not, and diverts
   * the moment the tank stops covering it plus this.
   *
   * Without it a run does not degrade, it ENDS. The tank goes negative without
   * limit, `disableThisWhenEmpty` latches the Thruster off, gravity is still on,
   * and the ship falls out of the sky with no way back — on `adv_02_jumpSeat`
   * that was **-174 units and 533 ticks inside a hillside** with eight pads
   * unvisited, and the run reported three pads rather than the "ran out of
   * time" it should have. An instrument that dies silently measures the wrong
   * thing.
   */
  readonly divertFuelMargin: number
  /**
   * How far below the bullseye centre to aim on the final approach, as a
   * fraction of the plate's OWN half-thickness.
   *
   * A fraction rather than metres, so the aim point is inside the plate by
   * construction and cannot be put outside it by a pad that ships a different
   * size. 0.5 puts it 0.65 m under centre on the shipped 1.30 m half, which
   * biases a descent to carry on through the middle instead of asymptoting onto
   * the centre plane — the velocity demand is proportional to range, so the last
   * two metres otherwise take as long as the first twenty.
   *
   * A metre offset was tried first and it is the wrong shape: 4 m below the
   * centre is 2.7 m BELOW the plate, and a ship arriving from underneath —
   * `adv_02_jumpSeat`'s first pad is 465 m above the one before it — settles on
   * that aim and hovers under the dartboard it came to hit. An aim inside the
   * box works from above and below alike.
   */
  readonly strikeDepthFraction: number
  /**
   * How far above the pad's TOP surface to hold until the seat is over the
   * plate's footprint, metres (DEV-120).
   *
   * Before the pads were solid the glide slope ran straight at the bullseye
   * centre, 3 m below the pad root, and the seat flew through the dartboard
   * from the side. The bullseye is the floor of a bowl: its rim is 3.97 m above
   * the plate's centre, and a seat whose glide slope puts it below that at 20 m
   * out lands on the mid ring (a 50) or stops against the outer wall and times
   * the approach out — measured: `int_01_jumpSeat` abandoned 3 of 6 pads,
   * `adv_02_jumpSeat` 3 of 12, with the aim rule unchanged.
   *
   * 6 m is the gear (the feet hang 1.36 m under the ship root) plus room for
   * the vertical loop to arrest the sink the glide slope demands: `velocityGain`
   * 2 on a demand of `approachGain` x range. A first guess of the kind the
   * mission table settles, and the table in DEV-120's row is what settled it.
   */
  readonly padApproachClearance: number
  /**
   * Give up on a pad after this long, seconds.
   *
   * A test instrument must not hang: a controller stuck in a limit cycle over
   * one pad would report a run that scored nothing and never ended, which reads
   * as a scoring bug rather than as a flying one.
   *
   * **40, and the honest thing to say about it is that it barely matters.** The
   * value was swept at 30 / 35 / 40 / 45 / 50 / 55 / 70 s over all six missions,
   * and **the three that complete score exactly the same at every one of them**
   * (2,000 / 3,200 / 2,350). It only moves `adv_01_jumpSeat` and
   * `adv_02_jumpSeat`, which are over the clock at any setting, and there it
   * moves them by a pad in each direction with no trend — chaos on a run the
   * clock was going to cut off regardless.
   *
   * So it is set on the measurement rather than the score: each long mission has
   * exactly one leg that genuinely needs more than half a minute
   * (`adv_01_jumpSeat`'s third climbs 220 m, `adv_02_jumpSeat`'s fourth drops
   * 520 m over 797 m, which is steeper than the vehicle's powered glide), and
   * 40 s is about three approaches. Abandoning a pad costs its plate AND the
   * perfect clear, so being too eager is the expensive mistake: with the clock
   * lifted, 40 s finishes `adv_02`'s whole board (12/12, 5,950) where 35 s
   * leaves it at 11/12 and 4,250.
   */
  readonly waypointTimeoutSeconds: number
  /**
   * Throttle held when the demand is zero. **0, and for a FUEL reason.**
   *
   * Any throttle above zero costs the full 1.9 units/s, so an idle that keeps
   * `Thruster.currentTime` charged — the 1.2 s ramp restarts on every release —
   * would buy smoothness at the price of the whole tank. Non-zero is the knob to
   * turn if the ramp reset ever shows up as a sag on departure.
   */
  readonly idleThrottle: number
  /**
   * Below this the throttle is SHUT rather than cracked. **The single biggest
   * fuel saving in the controller, and it is not a control decision.**
   *
   * Because the burn is binary in throttle, a 7 % command costs exactly what a
   * 100 % command does — 1.9 units/s — while producing 3.5 m/s^2 against
   * gravity's 32. That is what a steady descent asks for, and a steady descent
   * is most of `adv_02_jumpSeat`: one 520 m drop held the throttle at about 7 %
   * for thirty seconds and spent **57 units**, a whole tank and a half of range,
   * on thrust that changed nothing. Shutting it is free — the ship was falling
   * anyway — and it also puts `DragHack` into its 0.65 state, which is 2016's
   * own "let go and drop".
   *
   * It costs the 1.2 s thrust ramp on the way back in. That is the trade, it is
   * shipped behaviour rather than an artefact, and at 55 % of thrust after the
   * first 0.24 s the ramp is far cheaper than the fuel.
   */
  readonly minUsefulThrottle: number
}

export const DEFAULT_JUMPSEAT_AUTOPILOT: JumpSeatAutopilotTuning = {
  speedCap: 62,
  approachGain: 0.8,
  standoffMetres: 60,
  glideSlope: 0.45,
  velocityGain: 2,
  maxClimbRate: 45,
  maxSinkRate: 21,
  maxTilt: 1.4,
  attitudeGain: 2.6,
  rateGain: 1.45,
  yawGain: 1.4,
  minClearance: 55,
  lookAheadSeconds: 2.5,
  clearanceSamples: 12,
  clearanceClimbRate: 30,
  headMargin: 1,
  headLookAheadSeconds: 1,
  headSamples: 9,
  padTrustMetres: 140,
  boostDemandFraction: 0.92,
  boostFuelFloor: 30,
  refuelHoldMetres: 8,
  fuelReserve: 50,
  fuelLegSafety: 1.35,
  divertFuelMargin: 12,
  strikeDepthFraction: 0.5,
  padApproachClearance: 6,
  waypointTimeoutSeconds: 40,
  idleThrottle: 0,
  minUsefulThrottle: 0.12,
}

/**
 * One stop on the tour: **the bullseye plate itself**, not a point near it.
 *
 * It is an `OrientedBox` because a `TargetZone` is one, so `game/targets.ts`'s
 * own bullseye rows satisfy this interface with no adapter and the pilot asks
 * "am I inside the plate?" with `sweepHitsBox` — the scorer's own test, on the
 * scorer's own geometry.
 *
 * That is not tidiness, it is the bug this interface was rewritten to fix. The
 * first version carried a centre and a 4 m arrival radius, and the arrival
 * radius is **three times the plate's 1.30 m half-thickness**: the controller
 * descended beautifully — horizontal error 0.26 to 2.29 m across five pads — and
 * declared victory 3.9 m above a box it never entered, on every pad of every
 * mission. Five pads, zero score, nothing in the telemetry that looked wrong.
 * A test whose arrival condition is looser than the thing it is arriving at
 * measures the controller's opinion of itself.
 *
 * `pad` indexes `livePads(level)` — the same index `TargetsState.padTaken` and
 * `padClosed` are keyed on, so the pilot reads the latch the scorer writes
 * rather than keeping a second opinion about which pads are spent. Two things
 * that must agree should be one thing (orientation lesson §5).
 */
export interface JumpSeatWaypoint extends OrientedBox {
  /** Index into `livePads(level)`. */
  readonly pad: number
  /**
   * How far the pad's HIGHEST surface sits above this plate's centre, metres
   * (DEV-120). The bullseye plate is the floor of a bowl whose rim stands 3.97 m
   * above the plate's centre on every shipped pad; a seat that glides straight
   * at the plate meets that rim. The pilot holds above `padTop` until it is over
   * the plate, then descends. 0 for a pad with no landing surface.
   */
  readonly padTop: number
  /**
   * The pad's outer radius, metres, and how far its UNDERSIDE sits relative to
   * this plate's centre (negative: below it) — DEV-403. With `padTop` they are
   * the slab a head must not enter: see `keepOutsideTheRim`. Absent is a pad
   * the rule does not know the shape of, and the rule leaves it alone.
   */
  readonly padRadius?: number
  readonly padBottom?: number
}

/**
 * The order to take the pads in: nearest-neighbour from the start, then 2-opt,
 * with the finish pad PINNED LAST.
 *
 * The pin is not a preference. `Trigger_Finish_JumpSeat` is a slab inside one
 * pad's prefab and crossing it ends the run (`game/mission.ts`), so a tour that
 * passes the finish pad in the middle scores whatever it had at that moment and
 * stops. Pinning is what makes "visit every pad" and "finish" the same route.
 *
 * Nearest-neighbour alone leaves an obvious crossing on four of the six shipped
 * missions, so the 2-opt pass follows — it is O(n^2) per sweep on at most twelve
 * stops, it is deterministic, and it only ever accepts a strictly shorter tour.
 * The result is not optimal and does not need to be: this is a route for a test
 * instrument, and the honest claim is "no crossings", not "shortest".
 *
 * Straight-line distance, not travel time. The two disagree — a leg that climbs
 * 500 m costs more than one that falls 500 m — but pricing that properly needs
 * the flight model in the planner, and a planner that models the vehicle is a
 * second flight model to keep in step. `docs/DEVIATIONS.md`'s agreement lesson
 * is about exactly that kind of duplicate.
 */
export const planJumpSeatRoute = (
  waypoints: readonly JumpSeatWaypoint[],
  start: Vec3,
  finishPad: number,
): JumpSeatWaypoint[] => {
  const finishIndex = waypoints.findIndex((w) => w.pad === finishPad)
  const pending = waypoints.map((_, i) => i).filter((i) => i !== finishIndex)
  const order: number[] = []
  let from = start

  while (pending.length > 0) {
    let best = 0
    let bestDistance = Number.POSITIVE_INFINITY
    for (let k = 0; k < pending.length; k++) {
      const candidate = waypoints[pending[k] as number] as JumpSeatWaypoint
      const d = distanceSq(from, candidate.centre)
      if (d < bestDistance) {
        bestDistance = d
        best = k
      }
    }
    const chosen = pending.splice(best, 1)[0] as number
    order.push(chosen)
    from = (waypoints[chosen] as JumpSeatWaypoint).centre
  }
  if (finishIndex >= 0) order.push(finishIndex)

  // 2-opt over the OPEN path start -> ... -> finish. The endpoints are fixed:
  // the start is where the ship is and the finish ends the run, so only the
  // interior may be reversed.
  const legLength = (aIndex: number, bIndex: number): number => {
    const a = aIndex < 0 ? start : (waypoints[order[aIndex] as number] as JumpSeatWaypoint).centre
    const b = (waypoints[order[bIndex] as number] as JumpSeatWaypoint).centre
    return Math.sqrt(distanceSq(a, b))
  }
  const last = order.length - 1
  let improved = true
  // Bounded so a pathological input cannot spin. Twelve stops converge in two
  // or three sweeps; the bound is here because a loop with a floating-point
  // acceptance test is a loop that can chatter.
  for (let sweep = 0; improved && sweep < order.length; sweep++) {
    improved = false
    for (let i = 0; i < last; i++) {
      for (let j = i + 1; j < last; j++) {
        const before = legLength(i - 1, i) + legLength(j, j + 1)
        // Reversing [i..j] joins (i-1, j) and (i, j+1).
        const a = i - 1 < 0 ? start : (waypoints[order[i - 1] as number] as JumpSeatWaypoint).centre
        const bi = (waypoints[order[i] as number] as JumpSeatWaypoint).centre
        const bj = (waypoints[order[j] as number] as JumpSeatWaypoint).centre
        const c = (waypoints[order[j + 1] as number] as JumpSeatWaypoint).centre
        const after = Math.sqrt(distanceSq(a, bj)) + Math.sqrt(distanceSq(bi, c))
        if (after < before - 1e-6) {
          for (let lo = i, hi = j; lo < hi; lo++, hi--) {
            const swap = order[lo] as number
            order[lo] = order[hi] as number
            order[hi] = swap
          }
          improved = true
        }
      }
    }
  }

  return order.map((i) => waypoints[i] as JumpSeatWaypoint)
}

/** The tour's straight-line length from `start`, metres. Derived, for reporting. */
export const routeLength = (route: readonly JumpSeatWaypoint[], start: Vec3): number => {
  let total = 0
  let from = start
  for (const stop of route) {
    total += Math.sqrt(distanceSq(from, stop.centre))
    from = stop.centre
  }
  return total
}

/**
 * What the pilot is doing at the stop it is flying to.
 *
 * Three states and no more, because every extra one is a transition that has to
 * be right in both directions.
 */
export type JumpSeatPilotPhase =
  /** Flying at the bullseye centre. Ends when the plate scores. */
  | 'strike'
  /** Parked above the bullseye, taking on fuel. Ends when the tank is enough. */
  | 'refuel'
  /** The tank will not reach the next pad. Going to the nearest one instead. */
  | 'divert'
  /** The route is done. Hold station and do not fall out of the sky. */
  | 'done'

/**
 * The pilot's head, and everything it can touch. DEV-403.
 *
 * 2016's JumpSeat dies when the head box touches anything (`sim/jumpseat-head.
 * ts`), and this controller used to fly straight into it: measured with the
 * rule on, it lost `rookie_02_jumpSeat` at 40.9 s to the skirt of a pad it was
 * not aiming at, and `int_02_jumpSeat` at 52.6 s and `adv_02_jumpSeat` at
 * 71.3 s to a rising hillside. The terrain term above only ever CLIMBS: it saw
 * each of those slopes coming — its look-ahead read the ground 47 to 172 m
 * above the seat — and asked for 30 m/s of climb while the horizontal demand,
 * 40 to 54 m/s of it, carried the seat on into the rock. A seat leaning 30 to
 * 55 degrees into its own travel leads with its head.
 *
 * So when the head is about to meet something — the land or a pad while the
 * head LEADS (the pilot is handed only the land to avoid, and a pad was one of
 * the three), or a prop at any attitude — the guard takes the horizontal
 * demand away, which stands the seat up and puts the head back behind its
 * feet, and stops any descent; if the head is already inside `headMargin` it
 * adds the terrain term's own climb. Stop, then go up, then go on.
 * `jumpSeatHeadThreat` says when it fires and why a landing never does.
 *
 * It is handed the fields the hull collides with, the ones the rule tests, but
 * reads the pads as solid COLUMNS (`headDepth`'s `solidBelow`): judged at the
 * seat's own height, a pad whose slab is still above the head reads as clear,
 * and a seat climbing past it from below or beside put its head into the rim.
 * Measured twice: on a divert before the fuel reserve moved (`adv_01`,
 * `adv_02`), and again once DEV-383 gave the hull the pad's underside, so a
 * seat no longer bounced onto a pad it flew under (`adv_02` at 57 s).
 *
 * The guard alone did not finish the board: see `fuelReserve`, which the head
 * strike also moved.
 */
export interface JumpSeatHeadGuard {
  readonly box: HeadBox
  readonly surfaces: readonly HeightField[]
  /**
   * The forest the head strike counts (Anniversary), or null. The rule tests
   * the props, so the guard has to: flown over Anniversary's forest without
   * it, the pilot's head went into Simonet's sea stack on `adv_02_jumpSeat`,
   * and it no longer does. `int_01_jumpSeat` still grazes a palm in a
   * 60-degree dive the attitude loop cannot stand up in time — DEV-403's row.
   */
  readonly props?: PropColliders | null
}

/**
 * The head's prop spheres grown by `headMargin`, so a prop test answers "within
 * the margin" as the surface test does. Derived once per box and margin and
 * never written after: a cache of immutable data, not scratch.
 */
const marginSpheres = new WeakMap<HeadBox, { margin: number; spheres: HullSphere[] }>()
const propSpheresFor = (box: HeadBox, margin: number): readonly HullSphere[] => {
  const hit = marginSpheres.get(box)
  if (hit && hit.margin === margin) return hit.spheres
  const spheres = box.spheres.map((s) => ({ x: s.x, y: s.y, z: s.z, radius: s.radius + margin }))
  marginSpheres.set(box, { margin, spheres })
  return spheres
}

export interface JumpSeatPilot {
  /** The tour, in flight order. */
  readonly route: readonly JumpSeatWaypoint[]
  /** Which stop is being flown at. `route.length` once the tour is finished. */
  cursor: number
  phase: JumpSeatPilotPhase
  /** Seconds spent on the current stop. Fixed steps only; never a frame delta. */
  onStopSeconds: number
  /** Stops abandoned on the timeout. A run with any of these is a finding. */
  abandoned: number
  /** Route index being diverted to for fuel, or -1. See `divertFuelMargin`. */
  divert: number
  /** Diversions made over the run. Another finding, not a failure. */
  diversions: number
  /**
   * The head and what it can hit, or null (DEV-403). SET BY THE CALLER — the
   * seam and the headless harness — because the pilot is handed only the land
   * to avoid, and a head can meet a pad too. See `JumpSeatHeadGuard`.
   */
  head: JumpSeatHeadGuard | null
  /**
   * The aim point the guidance used on the last step. An OUTPUT, kept so a test
   * or a telemetry dump can read what the controller decided rather than
   * recompute what it believes it should have decided.
   */
  readonly aim: Vec3
  /** Boost held on the last step. An output, same reason. */
  boost: boolean
  /**
   * The jumping spider's hop state (DEV-383): read and written only by
   * `stepSpiderPilot`, and only on a seat that carries a jump. Per pilot, never
   * module-level (trap 19).
   */
  readonly spider: SpiderPilotState
}

export const createJumpSeatPilot = (route: readonly JumpSeatWaypoint[]): JumpSeatPilot => ({
  route,
  cursor: 0,
  phase: route.length > 0 ? 'strike' : 'done',
  onStopSeconds: 0,
  abandoned: 0,
  divert: -1,
  diversions: 0,
  head: null,
  aim: v3(),
  boost: false,
  spider: createSpiderPilotState(),
})

/**
 * Put a pilot back at the start of its tour, for a RESPAWN: 2016 reloads the
 * scene and the run starts from the first pad.
 *
 * Everything `createJumpSeatPilot` builds goes back to what it builds, from
 * the same function, so a field added there is reset here without an edit.
 * Kept: the route (the course has not changed), the head guard (the caller's,
 * DEV-403), and the IDENTITY of `aim` and `spider`, which a caller may hold.
 *
 * Without this a respawn left the cursor where the run died. The seat came
 * back on the respawn marker with its pilot still flying at pad 6, low and
 * straight from the pad, and on `int_02_jumpSeat` it struck its head again
 * within three seconds of every restart: a loop that took one plate in 217 s
 * and read as the run resetting under the test (DEV-530's follow-up).
 */
export const resetJumpSeatPilot = (pilot: JumpSeatPilot): void => {
  const { aim, spider, head } = pilot
  Object.assign(pilot, createJumpSeatPilot(pilot.route), { aim, spider, head })
  aim.x = 0
  aim.y = 0
  aim.z = 0
  Object.assign(spider, createSpiderPilotState())
}

// Volatile module-level scratch. Valid only inside the one synchronous call that
// writes them — never stored, never read across calls.
//
// TRAP 19: `ai-racer.ts` shared ONE `HoverJetInput` across every racer and a
// finished racer flew on with the other racer's stick, frozen, until it went
// into the sea. Invisible to every single-object test, because with one object
// there is nobody to inherit from. Every one of these is written-then-read-then-
// discarded inside a single call, the per-pilot state lives on `JumpSeatPilot`,
// and `tests/unit/jumpseat-autopilot.test.ts` steps a SECOND pilot and asserts
// the first did not move.
const _toAim: Vec3 = v3()
const _vDes: Vec3 = v3()
const _aDes: Vec3 = v3()
const _up: Vec3 = v3()
const _upBody: Vec3 = v3()
const _rateBody: Vec3 = v3()
const _bodyY: Vec3 = v3()
const _bearing: Vec3 = v3()
const _inv: Quat = { x: 0, y: 0, z: 0, w: 1 }
const _bodyUp: Vec3 = v3(0, 1, 0)
/**
 * The body handed to `pathClearance`, carrying the ship's GROUND TRACK rather
 * than its velocity. Volatile scratch like the rest: every field is written at
 * the top of the one call that reads it.
 *
 * `sim/autopilot.ts` probes along the full velocity, which is right for a jet
 * that flies where its nose points. On a machine whose vertical speed swings
 * +21 to -19 while it hunts an altitude it is a feedback loop: climb, and the
 * probe points into empty sky and says there is room; stop climbing, and it
 * points at the hill and says climb. Measured on `adv_02_jumpSeat`'s fourth leg,
 * that cycle burned **eight seconds and 55 m of altitude in the wrong
 * direction** before the ship settled. Probing the ground track asks "what is
 * under where I am going", which is what a pilot reads and does not move when
 * the pitch does.
 */
const _probe = {
  position: v3(),
  orientation: { x: 0, y: 0, z: 0, w: 1 } as Quat,
  velocity: v3(),
}
/** The head guard's projected pose and one offset. Volatile scratch, like `_probe`. */
const _headPose = {
  position: v3(),
  orientation: { x: 0, y: 0, z: 0, w: 1 } as Quat,
}
const _headOffset: Vec3 = v3()

/**
 * When the head would come within `headMargin` of a surface, as a fraction of
 * `headLookAheadSeconds` — 0 is now — or -1 when it will not, or does not lead.
 * See `JumpSeatHeadGuard`.
 *
 * Only a head that LEADS the seat can strike first: it has to reach further
 * along the velocity than any foot does. A seat coming down onto a plate —
 * even leaning into its approach — is led by its feet and never trips this; a
 * seat leaning 30 to 55 degrees into a climb or a shallow dive, which is all
 * four measured strikes, is led by its head. Two cheaper tests were tried and
 * are wrong on this vehicle, both measured on the mission table:
 *
 *   · "the head points along the velocity" fired on ordinary landings, which
 *     lean into the approach, and cost the six missions up to 63 % of their
 *     score in lost bullseyes;
 *   · "which part ARRIVES first, carried along the velocity" never fired: the
 *     feet always arrive first, but the legs are sprung, they fold, and the
 *     seat carries on into the head strike.
 *
 * A leading head is then carried along the velocity for `headLookAheadSeconds`,
 * attitude held — down with a descent, never up with a climb — and the first
 * sample that brings it within `headMargin` of a surface is the answer.
 */
export const jumpSeatHeadThreat = (
  seat: JumpSeat,
  guard: JumpSeatHeadGuard,
  tuning: JumpSeatAutopilotTuning,
): number => {
  const body = seat.body
  const v = body.velocity
  const props = guard.props ?? null
  // How far along the velocity the head reaches, against how far any foot
  // does — both from the seat's own centre, so the comparison is of the shape
  // and not of where the seat is. Only the LAND and the PADS need it: they are
  // what a seat lands on. Nobody lands on a tree (DEV-345 clears every pad's
  // ground of them), so a prop is judged whether the head leads or not — and a
  // 60-degree dive, where the head and the front feet reach equally far, is
  // exactly where the lead test flickers (`int_01_jumpSeat`, into a palm).
  let headReach = Number.NEGATIVE_INFINITY
  for (const p of guard.box.points) {
    rotateVec3(_headOffset, body.orientation, p)
    const reach = _headOffset.x * v.x + _headOffset.y * v.y + _headOffset.z * v.z
    if (reach > headReach) headReach = reach
  }
  let leads = headReach > 0
  const legs = seat.legs
  if (leads && legs) {
    for (let k = 0; k < legs.specs.length && leads; k++) {
      legFootLocal(_headOffset, legs.specs[k] as JumpSeatLegSpec, legs.legs[k]?.angle ?? 0)
      rotateVec3(_headOffset, body.orientation, _headOffset)
      if (_headOffset.x * v.x + _headOffset.y * v.y + _headOffset.z * v.z >= headReach) {
        leads = false
      }
    }
  }
  if (!leads && !props) return -1
  _headPose.orientation.x = body.orientation.x
  _headPose.orientation.y = body.orientation.y
  _headPose.orientation.z = body.orientation.z
  _headPose.orientation.w = body.orientation.w
  const last = Math.max(1, tuning.headSamples - 1)
  for (let i = 0; i <= last; i++) {
    const t = (i / last) * tuning.headLookAheadSeconds
    // Down with the seat, but never UP with it: a climb that has not happened
    // yet does not lift the head over anything. Rising ground is judged at the
    // height the seat is at, a dive at the height it is going to.
    set(
      _headPose.position,
      body.position.x + v.x * t,
      body.position.y + Math.min(0, v.y) * t,
      body.position.z + v.z * t,
    )
    if (leads && headDepth(_headPose, guard.box, guard.surfaces, true) > -tuning.headMargin) {
      return i / last
    }
    if (
      props &&
      propPenetrationAt(
        _headPose.position,
        _headPose.orientation,
        propSpheresFor(guard.box, tuning.headMargin),
        props,
      ) > 0
    ) {
      return i / last
    }
  }
  return -1
}

/**
 * Is the head UNDER a pad — inside a pad's column but clear of the slab? The
 * guard reads the pads as columns, so from under one it sees the head "inside"
 * already; this is the half of that it must not answer with a climb.
 */
export const jumpSeatHeadUnderPad = (
  seat: JumpSeat,
  guard: JumpSeatHeadGuard,
  tuning: JumpSeatAutopilotTuning,
): boolean =>
  headDepth(seat.body, guard.box, guard.surfaces, true) > -tuning.headMargin &&
  headDepth(seat.body, guard.box, guard.surfaces) <= -tuning.headMargin

/** No terrain. Frozen, shared, and only ever read. */
const NO_FIELDS: readonly HeightField[] = Object.freeze([]) as readonly HeightField[]

/**
 * One tick of pilot intent, given an aim point already chosen.
 *
 * `aim` is a point in SIM (Unity) space. `speedCap` and `allowBoost` are passed
 * in rather than read from the tuning so that the fuel policy — which is the
 * caller's business, not the control law's — can throttle the whole controller
 * back without a second tuning object.
 *
 * Returns `out`, mutated. The caller owns it, exactly as `autopilotActions`
 * does, which is what keeps two ships from sharing one stick.
 */
export const jumpSeatAutopilotActions = (
  seat: JumpSeat,
  aim: Vec3,
  out: JumpSeatInput,
  tuning: JumpSeatAutopilotTuning = DEFAULT_JUMPSEAT_AUTOPILOT,
  terrain: readonly HeightField[] = NO_FIELDS,
  speedCap: number = tuning.speedCap,
  allowBoost = true,
  /**
   * Ground clearance the terrain term will insist on, metres — the CALLER's
   * number, because only the caller knows how near the ship is to a piece of
   * airspace 2016 certified by putting a dartboard in it. Defaults to the full
   * `minClearance`, which is the right answer for a call with no route behind
   * it. See `padTrustMetres` for what the pilot passes and the mission it cost.
   */
  clearanceFloor: number = tuning.minClearance,
  /** The pilot's head and what it can hit, or null for no head guard. DEV-403. */
  head: JumpSeatHeadGuard | null = null,
): JumpSeatInput => {
  const body = seat.body

  // ── 1. Where to go, and how fast ────────────────────────────────────────
  _toAim.x = aim.x - body.position.x
  _toAim.y = aim.y - body.position.y
  _toAim.z = aim.z - body.position.z
  const range = Math.hypot(_toAim.x, _toAim.y, _toAim.z)
  const wanted = Math.min(speedCap, tuning.approachGain * range)
  if (range > 1e-4) {
    const k = wanted / range
    _vDes.x = _toAim.x * k
    _vDes.y = _toAim.y * k
    _vDes.z = _toAim.z * k
  } else {
    set(_vDes, 0, 0, 0)
  }

  // ── 2. The ground ───────────────────────────────────────────────────────
  //
  // A climb demand, not a pitch override: on a vehicle whose thrust is its
  // attitude there is no "pull up" that is not also "stop going where you were
  // going", so the terrain has to speak in the same units as the guidance.
  //
  // The floor TAPERS to nothing at the pad rather than switching off inside a
  // radius. `sim/autopilot.ts` uses a step because a ring is 22.6 m of certified
  // air at one altitude; a pad is a dartboard the ship has to reach and the six
  // shipped missions put them between 1 m and 386 m above the ground, so a step
  // would either strand the low ones above their own plates or hand the high
  // ones no protection at all.
  set(_probe.position, body.position.x, body.position.y, body.position.z)
  set(_probe.velocity, body.velocity.x, 0, body.velocity.z)
  _probe.orientation.x = body.orientation.x
  _probe.orientation.y = body.orientation.y
  _probe.orientation.z = body.orientation.z
  _probe.orientation.w = body.orientation.w
  const clearance = pathClearance(_probe, terrain, tuning.lookAheadSeconds, tuning.clearanceSamples)
  const floor = clearanceFloor
  const urgency = clearance < floor && floor > 0 ? clamp((floor - clearance) / floor, 0, 1) : 0
  if (urgency > 0) {
    const climb = urgency * tuning.clearanceClimbRate
    if (_vDes.y < climb) _vDes.y = climb
  }
  // ── Take off before you fly (DEV-120) ──────────────────────────────────
  //
  // The seat cannot thrust downward and cannot sink through a floor. Parked on
  // a pad with the next pad LOWER, the demand is "sink and go sideways"; the
  // vertical half is impossible, and the tilt clamp below shrinks the sideways
  // half to nothing rather than grow the vertical one — so the throttle reads
  // 0.00 and the seat sits, upright, tank full, for the whole timeout. Measured
  // on `int_01_jumpSeat`: 40 s on pad 1, then the pad abandoned. Before the pads
  // were solid the same demand fell straight through the dartboard and flew on.
  //
  // So: in the hover band (`HoverMotor.motorActivated` within `hoverHeight`),
  // wanting to sink, with the aim further away horizontally than the ground is
  // below — that is a floor in the way, and the answer is the terrain term's own
  // climb rate. Descending ONTO an aim that is under the seat is left alone,
  // which is what a landing is.
  const flatToAim = Math.hypot(_toAim.x, _toAim.z)
  const inHoverBand = seat.hover.active && seat.hover.distance <= seat.hoverSpec.hoverHeight
  if (inHoverBand && _vDes.y < 0 && flatToAim > seat.hover.distance) {
    _vDes.y = tuning.clearanceClimbRate
  }
  // ── Keep the head out of it (DEV-403) ──────────────────────────────────
  //
  // Where the term above only climbs, this also STOPS: see `JumpSeatHeadGuard`
  // for the runs it was written against, and `jumpSeatHeadThreat` for what it asks.
  // All or nothing, measured: a braking demand scaled by how soon the head
  // would arrive fired at a tenth of its strength a second out, and from
  // 30 m/s a tenth of a brake does not stop the seat before a pad's skirt.
  if (head) {
    const when = jumpSeatHeadThreat(seat, head, tuning)
    if (when >= 0 && jumpSeatHeadUnderPad(seat, head, tuning)) {
      // UNDER a pad, the slab is overhead and climbing is the one wrong answer:
      // it put `adv_02_jumpSeat`'s head into an underside at 88 s. Stop the
      // climb and leave the horizontal to the aim — `keepOutsideTheRim` sends a
      // seat under its target pad out sideways first.
      if (_vDes.y > 0) _vDes.y = 0
    } else if (when >= 0) {
      _vDes.x = 0
      _vDes.z = 0
      // And stop going DOWN into it; already within the margin, climb out.
      // (Always climbing was tried: `int_02_jumpSeat` then struck at 59 s.)
      const floor = when === 0 ? tuning.clearanceClimbRate : 0
      if (_vDes.y < floor) _vDes.y = floor
    }
  }
  _vDes.y = clamp(_vDes.y, -tuning.maxSinkRate, tuning.maxClimbRate)

  // ── 3. Desired acceleration ─────────────────────────────────────────────
  //
  // Proportional on velocity error, PLUS a feed-forward for the drag the ship
  // will meet at the speed it is being asked to hold, PLUS gravity. The
  // feed-forward is what removes the standing error: Unity linear drag is
  // `v *= 1 - drag*dt`, so holding `v` costs `drag * v` of acceleration for
  // ever, and a pure proportional loop pays for it with a permanent velocity
  // shortfall — 34.45 m/s of cruise asks for 37.9 m/s^2 of it. The SEAT's
  // gravity, which a variant may scale (DEV-384); the world's is not what it
  // is holding up.
  const g = Math.abs(seat.gravity.y)
  _aDes.x = tuning.velocityGain * (_vDes.x - body.velocity.x) + body.drag * _vDes.x
  _aDes.y = tuning.velocityGain * (_vDes.y - body.velocity.y) + body.drag * _vDes.y + g
  _aDes.z = tuning.velocityGain * (_vDes.z - body.velocity.z) + body.drag * _vDes.z

  // And the HOVER MOTOR, fed forward like gravity (DEV-120). Inside its band the
  // motor adds `p² · hoverForce / mass` of velocity every tick — 10 m/s² at 3 m
  // over a floor — and a loop that feeds forward only gravity and drag settles
  // where thrust + hover = g instead of sinking: measured on `rookie_01`'s pad
  // 3, the seat hung 3 m over the bullseye at throttle 0.45 with a 3 m/s sink
  // demanded, for the whole timeout. Before the pads were solid there was no
  // floor under a plate for the motor to see, so this term was zero everywhere
  // it mattered. `stepHoverMotor` is the source of the arithmetic.
  const hover = seat.hover
  if (hover.active && hover.distance <= seat.hoverSpec.hoverHeight) {
    const p = (seat.hoverSpec.hoverHeight - hover.distance) / seat.hoverSpec.hoverHeight
    _aDes.y -= (p * p * seat.hoverSpec.hoverForce) / body.mass / FIXED_DT
  }

  // **The JumpSeat cannot thrust downward.** A desired acceleration below the
  // horizon is a request to invert the ship, and the attitude loop below will
  // take it literally and roll the seat over. Descending is done by withholding
  // thrust — the tilt clamp next is what actually provides the sink authority.
  if (_aDes.y < 0) _aDes.y = 0

  // Tilt clamp: keep the thrust axis within `maxTilt` of vertical by shrinking
  // the horizontal demand, never by growing the vertical one. Growing it would
  // turn "I want to go sideways faster than I can" into "climb", which is the
  // shape of a controller that balloons out of every corner.
  const flat = Math.hypot(_aDes.x, _aDes.z)
  const maxFlat = _aDes.y * Math.tan(tuning.maxTilt)
  if (flat > maxFlat && flat > 1e-6) {
    const k = maxFlat / flat
    _aDes.x *= k
    _aDes.z *= k
  }

  const demand = Math.hypot(_aDes.x, _aDes.y, _aDes.z)
  if (demand > 1e-6) {
    _up.x = _aDes.x / demand
    _up.y = _aDes.y / demand
    _up.z = _aDes.z / demand
  } else {
    set(_up, 0, 1, 0)
  }

  // ── 4. Boost, and what pays for it ──────────────────────────────────────
  //
  // Demand-driven rather than distance-driven, because the thing boost buys is
  // acceleration and the thing that needs it is a saturated thruster. It also
  // releases itself in a hover, which is where the fuel comes from.
  const thrustAccel = seat.tuning.thrustForce / seat.body.mass
  const boost =
    allowBoost &&
    seat.fuel > tuning.boostFuelFloor &&
    demand > thrustAccel * tuning.boostDemandFraction
  const available = thrustAccel * (boost ? seat.tuning.boostMultiplier : 1)

  // ── 5. Throttle ─────────────────────────────────────────────────────────
  //
  // Projected onto the axis the thruster actually points down, so a ship that
  // has not finished swinging onto the demand does not fire the whole 750 N in
  // the wrong direction. `adjustedThrustForce` is deliberately NOT read: it is 0
  // on the first tick of a burn and climbs over 1.2 s, and dividing by it would
  // make the command explode exactly when the ramp is weakest. Pricing the
  // throttle against the STEADY-state thrust means the ramp shows up as the loop
  // seeing less acceleration than it asked for and opening up — which is what a
  // pilot does too.
  rotateVec3(_bodyY, body.orientation, _bodyUp)
  const along = _aDes.x * _bodyY.x + _aDes.y * _bodyY.y + _aDes.z * _bodyY.z
  const asked = clamp(along / available, tuning.idleThrottle, 1)
  const throttle = seat.live
    ? // Shut, not cracked, below `minUsefulThrottle` — the burn is binary, so a
      // token throttle is a full tank spent on nothing. See that field.
      asked < tuning.minUsefulThrottle
      ? 0
      : asked
    : // Before `Trigger_EnableJumpShip` fires there is no thruster, and the burn
      // is NOT gated on it: `FuelManager` guards on `gasVal > 0` alone, so a
      // throttle held through the 7.5 s countdown spends 14.25 units of a
      // 100-unit tank on nothing at all.
      0

  // ── 6. Attitude: swing body +Y onto `_up` ───────────────────────────────
  //
  // The body-frame rotation carrying +Y onto a unit `u` has axis
  // `(0,1,0) x u = (u.z, 0, -u.x)`, whose magnitude is sin of the angle between
  // them. Pitch torque is about body X and roll torque about body Z, so pitch
  // answers to `+u.z` and roll to `-u.x`. Both signs are re-measured in
  // `tests/unit/jumpseat-autopilot.test.ts` by driving the axis and reading the
  // resulting basis, because a sign reasoned out of a left-handed space is a
  // belief written twice.
  //
  // Gains are in ANGULAR ACCELERATION and divided by each axis's own rate, so
  // the 1.45 rad/s^2 of pitch authority and the 0.8 of roll behave alike instead
  // of the roll axis inheriting a gain tuned on the pitch axis.
  rotateVec3Inverse(_upBody, body.orientation, _up)
  conjugate(_inv, body.orientation)
  rotateVec3(_rateBody, _inv, body.angularVelocity)

  const pitchDemand = tuning.attitudeGain * _upBody.z - tuning.rateGain * _rateBody.x
  const rollDemand = -tuning.attitudeGain * _upBody.x - tuning.rateGain * _rateBody.z

  // ── 7. Yaw: point the nose where it is going ────────────────────────────
  //
  // Cosmetic on the physics — yaw turns about the THRUST axis, so it moves the
  // ship nowhere — and not cosmetic on the control: pitch is worth 1.45 rad/s^2
  // and roll 0.8, so a seat facing its target does its steering on the strong
  // axis. Free authority, taken.
  rotateVec3Inverse(_bearing, body.orientation, _toAim)
  const bearing = Math.atan2(_bearing.x, _bearing.z)
  const yawDemand = tuning.yawGain * bearing - tuning.rateGain * _rateBody.y

  out.throttle = throttle
  out.boost = boost ? 1 : 0
  out.pitch = clamp(pitchDemand / seat.tuning.pitchRate, -1, 1)
  out.roll = clamp(rollDemand / seat.tuning.rollRate, -1, 1)
  out.yaw = clamp(yawDemand / seat.tuning.yawRate, -1, 1)
  return out
}

/**
 * Fuel the next leg is estimated to cost, units.
 *
 * Derived, and therefore held to the DEV-027 standard: this is the fuel burnt by
 * **an unboosted straight line from `from` to `to` flown at the level-cruise
 * balance of 34.45 m/s**, times `fuelLegSafety`. It is not a prediction of what
 * the run-in, the climb, the hold or a missed approach will cost — those are
 * what `fuelReserve` is for — and it is deliberately priced at the UNBOOSTED
 * rate because the policy it feeds is "may I still leave this pad", and a ship
 * that has to leave on the reserve will not be boosting.
 *
 * `cruiseSpeed` is passed rather than baked so the day the flight model changes
 * the estimate moves with a measurement instead of with a comment.
 */
export const legFuelEstimate = (
  from: Vec3,
  to: Vec3,
  cruiseSpeed: number,
  burnRate: number,
  safety: number,
): number => (Math.sqrt(distanceSq(from, to)) / cruiseSpeed) * burnRate * safety

/**
 * The unboosted level-cruise speed, m/s — the speed at which the horizontal
 * component of a fully tilted thruster is exactly balanced by linear drag, with
 * the vertical component exactly cancelling gravity.
 *
 *     tilt      cos(t) = g / a            so  sin(t) = sqrt(1 - (g/a)^2)
 *     cruise    v = a * sin(t) / drag
 *
 * With a = 750/15 = 50, g = 32 and drag = 1.1 that is **34.86 m/s**, against the
 * **34.45 m/s** a 60-second integration of `stepJumpSeat` actually settles at.
 * The 1.2 % is Unity's per-step drag (`v *= 1 - drag*dt`) not being the
 * continuous exponential this closed form assumes, and it is the right sign: the
 * discrete form loses slightly more.
 *
 * The closed form is what ships, because the estimate has to follow the tuning
 * rather than a number somebody measured once and pasted. The measurement is the
 * TEST (`tests/unit/jumpseat-autopilot.test.ts` pins the two within 2 %), which
 * is the arrangement DEV-027 asks for: a derived number with a check that it
 * still describes the thing it claims to.
 */
export const jumpSeatCruiseSpeed = (
  seat: JumpSeat,
  drag: number = seat.tuning.dragBase,
): number => {
  const accel = seat.tuning.thrustForce / seat.body.mass
  const g = Math.abs(seat.gravity.y)
  if (accel <= g) return 0
  return (accel * Math.sqrt(1 - (g / accel) ** 2)) / drag
}

/**
 * Advance the pilot one FIXED step: choose the stop, choose the aim, fly at it.
 *
 * `padTaken` is `TargetsState.padTaken` — the scorer's own latch, indexed by
 * live pad. Pass an empty array in a mode that does not score pads
 * (`int_02_jumpSeat` is forced to Free Flight, where the pads are live scenery
 * and nothing ever latches), and the plate containment test and the timeout take
 * over. That is the honest degrade rather than a mode flag in here.
 *
 * Returns `out`, mutated, exactly as `jumpSeatAutopilotActions` does.
 *
 * **Trap 19.** Every piece of state this reads across ticks is a field on
 * `pilot`; the module scratch above is written and read inside this one call.
 * The guard is `tests/unit/jumpseat-autopilot.test.ts` stepping a SECOND pilot
 * and asserting the first's cursor, phase and stick did not move.
 */
/**
 * Never cross a pad's rim below its top. DEV-403, and DEV-120's "approach from
 * above" carried to where it had never needed to go.
 *
 * DEV-120 holds the aim above the pad's top until the seat is over the plate,
 * which is right for a seat that is already above it. A seat BELOW the top —
 * climbing to a pad that stands above the one it left, or under a pad that
 * floats — flew a straight line at that aim, and the line crosses the rim
 * below the top. That used to cost nothing: a hull that met a pad from below
 * was thrown onto its top, because the pad's field was solid to the ground.
 * DEV-383 gave the pad its underside, the seat now meets the slab as the slab,
 * and under DEV-403 the head that clips it ends the run: `adv_02_jumpSeat` at
 * 57 s, climbing at 25-37 m/s into the rim of the pad it was flying to, with
 * the head guard braking and not in time.
 *
 * So while the seat is beside the pad and below its top, it climbs to the top
 * plus `padApproachClearance` where it is, coming no closer than
 * `standoffMetres` beyond the rim; from UNDER the pad it first goes out
 * sideways, at its own height, to `padApproachClearance` beyond the rim (go
 * out before going up; under a pad, up is the slab). Above the top the ordinary approach takes
 * over, and the band between "below the top" and "top plus clearance" is what
 * keeps the two from trading the aim back and forth.
 *
 * "Beside or under" is the geometry, not a flag: outside the pad's footprint,
 * or inside it and below its underside. A seat in the bowl or over it is
 * neither, so a landing and a refuel hold are never touched.
 */
export const keepOutsideTheRim = (
  aim: Vec3,
  seat: JumpSeat,
  stop: JumpSeatWaypoint,
  tuning: JumpSeatAutopilotTuning,
): void => {
  const radius = stop.padRadius
  const bottom = stop.padBottom
  if (radius === undefined || bottom === undefined || !(radius > 0)) return
  const p = seat.body.position
  const top = stop.centre.y + stop.padTop
  if (p.y >= top) return
  const dx = p.x - stop.centre.x
  const dz = p.z - stop.centre.z
  const flat = Math.hypot(dx, dz)
  if (flat <= radius && p.y >= stop.centre.y + bottom) return
  // Straight under the centre there is no bearing; +x is as good as any, and
  // fixed, so the run stays deterministic.
  const ux = flat > 1e-6 ? dx / flat : 1
  const uz = flat > 1e-6 ? dz / flat : 0
  if (flat <= radius) {
    // Under it: out sideways first, at the seat's own height.
    const out = radius + tuning.padApproachClearance
    set(aim, stop.centre.x + ux * out, p.y, stop.centre.z + uz * out)
    return
  }
  // Beside it: climb to the top plus the clearance WHERE THE SEAT IS, coming no
  // closer than `standoffMetres` beyond the rim. An aim AT the rim was the
  // first cut, and `rookie_02_jumpSeat` overshot it: arriving 16 m below the
  // aim with 17 m/s across, the demand was nearly all climb and the momentum
  // carried the seat over the rim below its top.
  const hold = Math.min(flat, radius + tuning.standoffMetres)
  set(aim, stop.centre.x + ux * hold, top + tuning.padApproachClearance, stop.centre.z + uz * hold)
}

export const stepJumpSeatPilot = (
  pilot: JumpSeatPilot,
  seat: JumpSeat,
  out: JumpSeatInput,
  padTaken: readonly boolean[] = [],
  terrain: readonly HeightField[] = NO_FIELDS,
  tuning: JumpSeatAutopilotTuning = DEFAULT_JUMPSEAT_AUTOPILOT,
  dt: number = FIXED_DT,
): JumpSeatInput => {
  // A seat that jumps cannot climb on its jet, so it is flown by the hop
  // planner at the end of this file (DEV-383), not by the controller below.
  if (seat.jump) return stepSpiderPilot(pilot, seat, out, padTaken, terrain, tuning, dt)
  const stop = pilot.route[pilot.cursor]

  if (!stop) {
    // The tour is done. Hold station where the ship is rather than going limp:
    // a run that has crossed the finish still has to stay in the air for the
    // settle window, and a JumpSeat with no throttle falls at 48.8 m/s.
    pilot.phase = 'done'
    copy(pilot.aim, seat.body.position)
    jumpSeatAutopilotActions(seat, pilot.aim, out, tuning, terrain, tuning.speedCap, false)
    pilot.boost = out.boost > 0
    return out
  }

  // ── Can the tank still reach a pad? ─────────────────────────────────────
  //
  // Priced every tick against the NEAREST stop on the route, taken or not,
  // because every pad is a refuel pad (`Trigger_Refuel`, 10 units/s) and a spent
  // dartboard still sells petrol. The trigger is the trip, not a tank level: on
  // `adv_02_jumpSeat` the legs are 450–800 m and the difference between "I have
  // 20 units" and "I have 20 units and the nearest pad is 700 m away" is the
  // difference between landing and the sea.
  //
  // A diversion is not free and is not hidden: it is counted, it pauses the
  // stop's timeout (the leg is not failing, it is being deferred), and it flies
  // at the refuel hold height rather than at the plate, because a pad reached on
  // fumes is a pad you want to arrive above rather than descend into.
  const cruiseNow = jumpSeatCruiseSpeed(seat)
  const fuelTo = (to: Vec3): number =>
    legFuelEstimate(seat.body.position, to, cruiseNow, seat.tuning.burnRate, tuning.fuelLegSafety)
  if (seat.burnsFuel) {
    // **Only divert when the destination is out of reach.** The first version
    // compared the tank against the trip to the nearest pad and nothing else,
    // which turns every mid-leg low-fuel moment into a U-turn: halfway down a
    // 600 m leg the pad behind is as near as the pad ahead, so the ship turned
    // round to buy fuel it was about to be given anyway. That cost
    // `adv_01_jumpSeat` five pads — 8/10 and 2,700 became 3/10 and 600 — while
    // the same change was worth five pads the other way on `adv_02_jumpSeat`.
    // One rule, opposite signs, because the rule was asking the wrong question.
    const canReachTarget = seat.fuel >= fuelTo(stop.centre) + tuning.divertFuelMargin
    if (pilot.divert < 0) {
      if (!canReachTarget) {
        let nearest = -1
        let nearestDistanceSq = Number.POSITIVE_INFINITY
        for (let i = 0; i < pilot.route.length; i++) {
          const candidate = pilot.route[i] as JumpSeatWaypoint
          const d = distanceSq(seat.body.position, candidate.centre)
          if (d < nearestDistanceSq) {
            nearestDistanceSq = d
            nearest = i
          }
        }
        // Nearest IS the destination: there is nothing better to do than carry
        // on and hope, and turning round would only spend the rest of the tank.
        if (nearest >= 0 && nearest !== pilot.cursor) {
          pilot.divert = nearest
          pilot.diversions++
        }
      }
    } else {
      const refuelStop = pilot.route[pilot.divert] as JumpSeatWaypoint
      // Back on the road once the tank covers the trip home AND the leg that was
      // abandoned. Leaving on the bare margin just triggers the next diversion.
      //
      // And the leg is priced with the full `fuelReserve`, not the
      // `divertFuelMargin` that started the diversion (DEV-403): with one line
      // for both, a seat on the line left and diverted again on alternate ticks,
      // and which side of it a long climb fell on decided whole missions —
      // swept, `int_02_jumpSeat` jumped between 9/9 and 6/9 as the reserve moved
      // by 2 units. A full tank leaves regardless, or a leg longer than a tank
      // plus the reserve would hold the seat on the pad for ever.
      const covered = seat.fuel >= fuelTo(stop.centre) + tuning.fuelReserve
      const full = seat.fuel >= seat.tuning.maxFuel
      if ((covered || full) && seat.fuel >= fuelTo(refuelStop.centre) + tuning.fuelReserve) {
        pilot.divert = -1
      }
    }
  } else {
    pilot.divert = -1
  }

  if (pilot.divert >= 0) {
    const refuelStop = pilot.route[pilot.divert] as JumpSeatWaypoint
    pilot.phase = 'divert'
    set(
      pilot.aim,
      refuelStop.centre.x,
      refuelStop.centre.y + tuning.refuelHoldMetres,
      refuelStop.centre.z,
    )
    keepOutsideTheRim(pilot.aim, seat, refuelStop, tuning)
    const plateRange = Math.sqrt(distanceSq(seat.body.position, refuelStop.centre))
    jumpSeatAutopilotActions(
      seat,
      pilot.aim,
      out,
      tuning,
      terrain,
      tuning.speedCap,
      false,
      tuning.minClearance * clamp(plateRange / tuning.padTrustMetres, 0, 1),
      pilot.head,
    )
    pilot.boost = out.boost > 0
    return out
  }
  if (pilot.phase === 'divert') pilot.phase = 'strike'

  pilot.onStopSeconds += dt

  // ── Has this stop been taken? ───────────────────────────────────────────
  //
  // The scorer's latch first, the geometry second, and the geometry is the
  // PLATE — `sweepHitsBox` with the same vector twice, which its own docstring
  // says degrades to a containment test. So "arrived" means "inside the box the
  // scorer scores", in the box's own frame, at the box's own size.
  //
  // `padTaken` is the truth wherever a mode scores pads. The containment test is
  // what keeps Free Flight — `int_02_jumpSeat` is forced to it, the pads are
  // live scenery and nothing ever latches — from parking on the first dartboard
  // for ever, and it is also the tick-zero answer on a mode that does latch.
  const scored = padTaken[stop.pad] === true
  const arrived = scored || sweepHitsBox(stop, seat.body.position, seat.body.position) >= 0

  if (arrived && pilot.phase === 'strike') {
    pilot.phase = 'refuel'
    // The clock restarts on the transition, so the timeout measures ONE thing at
    // a time: "this approach is not working" while striking, and "this pad is
    // not refuelling me" while holding. A single timer spanning both abandons a
    // pad for the crime of a long, legitimate hold on a long leg.
    pilot.onStopSeconds = 0
  }

  // ── The fuel policy ─────────────────────────────────────────────────────
  //
  // Leave when the tank covers the next leg plus the reserve, or when it is
  // full — a pad cannot give more than `maxFuel` (`Trigger_Refuel.AddFuel` is
  // guarded on it) so waiting past full is waiting for ever.
  const next = pilot.route[pilot.cursor + 1]
  const needed = next
    ? legFuelEstimate(
        stop.centre,
        next.centre,
        cruiseNow,
        seat.tuning.burnRate,
        tuning.fuelLegSafety,
      ) + tuning.fuelReserve
    : 0
  const fuelled = !seat.burnsFuel || seat.fuel >= Math.min(needed, seat.tuning.maxFuel)

  if (pilot.phase === 'refuel' && fuelled) {
    pilot.cursor++
    pilot.phase = pilot.cursor < pilot.route.length ? 'strike' : 'done'
    pilot.onStopSeconds = 0
  } else if (pilot.onStopSeconds > tuning.waypointTimeoutSeconds) {
    // A test instrument must not hang. Abandoning a pad costs its score and the
    // streak; hanging on it costs the whole run AND reads as a scoring bug,
    // which is worse. Counted, so a run that does it is a finding rather than a
    // silently shorter tour.
    pilot.abandoned++
    pilot.cursor++
    pilot.phase = pilot.cursor < pilot.route.length ? 'strike' : 'done'
    pilot.onStopSeconds = 0
  }

  const target = pilot.route[pilot.cursor]
  if (!target) {
    pilot.phase = 'done'
    copy(pilot.aim, seat.body.position)
    jumpSeatAutopilotActions(seat, pilot.aim, out, tuning, terrain, tuning.speedCap, false)
    pilot.boost = out.boost > 0
    return out
  }

  // ── The aim point ───────────────────────────────────────────────────────
  //
  // On the way in, a GLIDE SLOPE: the aim sits `standoffMetres` above the
  // bullseye until the run-in, then walks down onto it and stops just inside the
  // plate. Once the plate has scored the aim lifts to the refuel hold, which is
  // inside the 19.7 m sphere and clear of whatever the pad is standing on.
  //
  // And since the pads are SOLID (DEV-120), the slope has a floor until the seat
  // is over the plate: the pad's top plus `padApproachClearance`. Over the
  // plate's own footprint the floor lifts and the seat descends onto the
  // bullseye, which is the floor of the bowl. Approach from above, as a player
  // does, rather than through the dartboard from the side.
  const holding = pilot.phase === 'refuel'
  const dx = target.centre.x - seat.body.position.x
  const dz = target.centre.z - seat.body.position.z
  const flat = Math.hypot(dx, dz)
  // The plate's own footprint, and not a fraction of it: a sweep of 0.3 / 0.5 /
  // 1.0 across the six missions (DEV-120's row) had the full box complete
  // every mission and take the most bullseyes; tighter centring only lengthened
  // the hold and cost pads to the timeout.
  const overPlate = flat < Math.min(target.half.x, target.half.z)
  const glide = Math.min(tuning.standoffMetres, flat * tuning.glideSlope)
  const lift = holding
    ? tuning.refuelHoldMetres
    : overPlate
      ? Math.max(glide, -target.half.y * tuning.strikeDepthFraction)
      : Math.max(glide, target.padTop + tuning.padApproachClearance)
  set(pilot.aim, target.centre.x, target.centre.y + lift, target.centre.z)
  keepOutsideTheRim(pilot.aim, seat, target, tuning)

  // The terrain floor tapers on the range to the PLATE, not to the aim — see
  // `padTrustMetres`, and the 30 s hover it cost before it did.
  const plateRange = Math.sqrt(distanceSq(seat.body.position, target.centre))
  const clearanceFloor = tuning.minClearance * clamp(plateRange / tuning.padTrustMetres, 0, 1)

  jumpSeatAutopilotActions(
    seat,
    pilot.aim,
    out,
    tuning,
    terrain,
    tuning.speedCap,
    !holding,
    clearanceFloor,
    pilot.head,
  )
  pilot.boost = out.boost > 0
  return out
}

// ══ The jumping spider's pilot (DEV-383) ═════════════════════════════════
//
// Everything below is the spider's, in one block. `stepJumpSeatPilot` hands a
// seat that carries a jump to `stepSpiderPilot` on its first line, and nothing
// above this rule reads a spider field.
//
// ── Why the climbing controller cannot fly it ────────────────────────────
//
// The spider's jet is 0.6 of 2016's: 30 m/s² against 32 of gravity, so at full
// throttle it SINKS at 1.8 m/s and cannot climb (Matt: *"control your descent
// rather than gain altitude"*). Height comes from one place — a jump off a
// surface — and the jet only spends it: the best it can do is glide, at the
// lean where the thrust buys the most ground per metre of height,
//
//     cos t = thrust / weight          ratio = (a/g) / sqrt(1 − (a/g)²)
//
// 20.4° and **2.69 : 1** on the spider (`spiderGlide` derives it from the seat).
// The first version flew the climbing controller with that lean and chased an
// aim it could not reach until the tank was dry, on every course.
//
// ── So it plans each hop by flying it first ──────────────────────────────
//
// Settled on a surface, the pilot flies a small set of candidate hops through a
// point-mass model of THIS seat (its mass, its jet, its two drags, its gravity,
// its burn and its jump), over the fields the hull collides with, and takes the
// cheapest: a hop that reaches the stop costs its fuel; one that lands short
// costs its fuel plus the ground left to cover, measured as the EQUIVALENT
// RANGE `flat − ratio · (height above the stop)`, because a metre of height is
// worth `ratio` metres of ground to a seat that can only glide. That is what
// makes it hop UP a hillside toward a pad on a peak rather than straight at it.
// It replans on every landing, so where the model and the seat disagree the
// next hop starts from where the seat really is.
//
// A candidate is a charge, a launch lean toward the stop, whether the jet burns
// on the way up, and the lean it holds on the way down (or shut). The flight
// then flies exactly that policy until the stop is CAPTURED — within the plate's
// half-width plus the distance drag alone would carry it, and above the rim —
// and then hands over to the climbing controller's approach, which brings it
// down onto the bullseye. The model is an instrument, not a second flight model
// to keep in step: nothing it predicts is asserted, and a wrong prediction costs
// one hop, not the run. Where it WAS measured wrong it is kept honest: it asks
// for height in hand over a long glide (`captureSlack`), treats a hop into a
// face on the way up as one that slides back down, and prices a landing on a
// slope and the approach's descent.
//
// ── Its own tour, and the stops it adds ──────────────────────────────────
//
// The straight-line tour sends a seat that cannot climb at a pad it cannot
// reach (`planSpiderTour` has the case). The spider orders the same pads by its
// own leg costs, exactly (Held-Karp), and puts a LAUNCH POINT — flat ground from
// which the pad is in glide reach — before a pad with no such ground near it.
// On a low tank it diverts to the pad it can glide to best; a stop it has made
// no progress on for `stalledPlans` plans is given up, as the climbing pilot's
// timeout gives one up. DEVIATIONS DEV-383 has the six courses.

/** What the spider's hop loop is doing. */
export type SpiderPhase =
  /** Carried by a surface, waiting to be still enough to plan a hop. */
  | 'settle'
  /** Leaning onto the launch attitude, throttle shut. */
  | 'aim'
  /** Both triggers held until the charge reaches what the hop asks for. */
  | 'charge'
  /** Off the ground: the jet flies the planned policy, or the approach once captured. */
  | 'air'

/** One hop, as the planner chose it and the flight flies it. */
export interface SpiderHop {
  /** Unit ground-plane direction toward the stop at planning time. */
  dirX: number
  dirZ: number
  /** Launch lean from vertical toward `dir`, radians. */
  launchLean: number
  /** The charge to release at, 0..1. */
  charge: number
  /** The jet burns on the way up. */
  climbJet: boolean
  /** The lean the jet holds on the way down, radians; negative means the jet is shut. */
  glideLean: number
  /**
   * The fall steers at the stop (a hop FOR it), or holds the hop's own heading
   * (a step on the way: up a hillside, onto a ridge).
   */
  homing: boolean
  /** The model captured the stop. */
  reaches: boolean
  /** Fuel the model spent, units. */
  fuel: number
  /** Seconds the model flew. */
  seconds: number
  /** What the planner scored it. */
  cost: number
  /** Where the model came down, when it did not reach. */
  readonly land: Vec3
  /** The up-component of the surface normal where it came down: 1 is flat. */
  landUp: number
}

export interface SpiderPilotState {
  phase: SpiderPhase
  /** Seconds in `phase`. Fixed steps only. */
  phaseSeconds: number
  /** Hops fired over the run, counted off the seat's own `jump.jumps`. */
  hops: number
  /** Where the seat was when the hop was planned: a slide past `slideMetres` plans again. */
  readonly planned: Vec3
  /** The tank as last seen, and how long it has not risen while taking fuel. */
  lastFuel: number
  refuelStall: number
  /** The tank rose on the last tick: a pad's sphere is paying. */
  rising: boolean
  /** Route index being diverted to for fuel, or -1. */
  divert: number
  /** The diversion's pad has paid at least once. */
  divertPaid: boolean
  /** Diversions over the run. Telemetry. */
  diversions: number
  /** The tour position the progress below is counted for. */
  progressAt: number
  /** The least equivalent range to that stop any plan has started from. */
  bestRange: number
  /** Plans since that range last improved by `progressMetres`. */
  stalled: number
  /**
   * The spider's own tour: indices into `pilot.route`, in the order it flies
   * them, planned on its first live tick by `planSpiderTour`. Empty until then.
   */
  order: number[]
  /** The launch points the tour stops at, beside the route's pads (`pad` -1). */
  readonly launches: JumpSeatWaypoint[]
  /** Candidates on the last plan the model had reaching the stop. Telemetry. */
  reachable: number
  /** Candidates on the last plan the model timed out on, still in the air. Telemetry. */
  timedOut: number
  /** Plans made over the run. */
  plans: number
  /** `seat.jump.jumps` as last seen, so a fire is seen on the tick after it. */
  seenJumps: number
  /** In the air and handed to the approach. */
  captured: boolean
  /** The hop being flown. */
  readonly hop: SpiderHop
}

const createSpiderHop = (): SpiderHop => ({
  dirX: 0,
  dirZ: 1,
  launchLean: 0,
  charge: 1,
  climbJet: true,
  glideLean: -1,
  homing: true,
  reaches: false,
  fuel: 0,
  seconds: 0,
  cost: 0,
  land: v3(),
  landUp: 1,
})

export const createSpiderPilotState = (): SpiderPilotState => ({
  phase: 'settle',
  phaseSeconds: 0,
  hops: 0,
  plans: 0,
  planned: v3(),
  lastFuel: 0,
  refuelStall: 0,
  rising: false,
  divertPaid: false,
  divert: -1,
  diversions: 0,
  progressAt: -1,
  bestRange: Number.POSITIVE_INFINITY,
  stalled: 0,
  order: [],
  launches: [],
  reachable: 0,
  timedOut: 0,
  seenJumps: 0,
  captured: false,
  hop: createSpiderHop(),
})

/**
 * The spider's pilot, as numbers. A TEST AND DEMO INSTRUMENT's tuning, like
 * `DEFAULT_JUMPSEAT_AUTOPILOT` above: each is a choice with its reason, and the
 * course table in DEV-383's row is what settled them.
 */
export interface SpiderPilotTuning {
  /** The charges a hop may release at, 0..1. Full first, then shorter hops for a near stop. */
  readonly charges: readonly number[]
  /** Launch leans toward the stop, radians. 0 is straight up. */
  readonly launchLeans: readonly number[]
  /**
   * Leans the jet may hold on the way down, radians, beside the best glide
   * (always tried) and the jet shut (always tried). Steeper is faster over the
   * ground and so cheaper per metre, at the cost of height.
   */
  readonly glideLeans: readonly number[]
  /**
   * Compass headings tried for a step on the way, when nothing on the heading
   * to the stop reaches it.
   */
  readonly headings: number
  /** Fixed ticks per model step. The model is coarse; the seat is not. */
  readonly modelTicks: number
  /** Longest hop the model flies, seconds. */
  readonly modelSeconds: number
  /** Metres above the pad's rim the model and the flight must be to capture a stop. */
  readonly captureHeight: number
  /**
   * Metres of height the MODEL must have in hand at capture per metre it flew
   * over the ground: the seat loses more on a long glide than the model does
   * (it swings onto each lean rather than snapping to it, and its ramp restarts
   * when the jet relights), measured at about 11 m short over a 900 m glide on
   * `int_01_jumpSeat`. A hop that only just captures in the model is one that
   * arrives under the rim in the air.
   */
  readonly captureSlack: number
  /** Units the model will not spend below: a dry spider cannot jump again. */
  readonly fuelReserve: number
  /** Cost of a hop that lands short, units, before the ground it leaves. */
  readonly missCost: number
  /** Cost of a hop the tank cannot pay for, units: taken only when nothing else can be. */
  readonly overBudgetCost: number
  /** Units per metre of equivalent range left to cover. */
  readonly rangeCost: number
  /** Units per second of flight: ties go to the quicker hop. */
  readonly timeCost: number
  /** m/s: slower than this, a carried seat counts as landed. */
  readonly settleSpeed: number
  /** Seconds it must be that slow before a plan. */
  readonly settleSeconds: number
  /** Plan anyway after this long carried, sliding or not. */
  readonly settleTimeoutSeconds: number
  /** rad: how close to the launch attitude before charging. */
  readonly aimTolerance: number
  /** Charge anyway after this long leaning. */
  readonly aimTimeoutSeconds: number
  /** Leave a pad once the tank holds this fraction of a full one. */
  readonly refuelFraction: number
  /** Give up on a stop after this long. A hop course is slower than a flown one. */
  readonly stopTimeoutSeconds: number
  /**
   * Give up on a stop sooner when this many plans in a row have started no
   * nearer it, in equivalent range, than the best so far by `progressMetres`:
   * a seat in a hollow the planner cannot see out of, spending the clock and
   * the tank on hops that go nowhere.
   */
  readonly stalledPlans: number
  readonly progressMetres: number
  /** The approach's tilt once captured, radians: authority to stop over the plate. */
  readonly approachTilt: number
  /**
   * The least `up` a landing surface's normal may have before a spot counts as
   * a slope the seat will slide down: a landing there costs another hop.
   */
  readonly steepLanding: number
  /** Metres the seat may slide between planning a hop and firing it before it plans again. */
  readonly slideMetres: number
  /**
   * Seconds without the tank rising before a pad is left anyway: the seat has
   * been knocked off the plate, out of the refuel sphere, and waiting for fuel
   * that is not coming is the one way to stall a run for good.
   */
  readonly refuelStallSeconds: number
  /**
   * Below this fraction of a full tank, a plan that cannot reach its stop
   * diverts to the pad it can reach best, for fuel. Every pad refuels, taken or
   * not (`Trigger_Refuel`), and a spider dry away from one is stranded.
   */
  readonly divertFuel: number
  /** Metres around a pad searched for land in glide reach of it, when ordering the tour. */
  readonly tourSearchMetres: number
  /** The grid that search samples, metres. */
  readonly tourSearchStep: number
  /** Metres of equivalent range a leg must have in hand to count as a glide. */
  readonly tourMargin: number
  /** How near a launch point counts as being on it, metres. */
  readonly launchRadius: number
  /**
   * Ground this close to a pad, from which it is in glide reach, makes the pad
   * one the hop planner can reach by itself; only a pad with none (a sea stack)
   * gets a launch point in the tour.
   */
  readonly nearLaunchMetres: number
}

export const DEFAULT_SPIDER_PILOT: SpiderPilotTuning = {
  charges: [1, 0.6, 0.3],
  launchLeans: [0, 0.35, 0.7],
  glideLeans: [0.6, 1],
  headings: 8,
  modelTicks: 4,
  modelSeconds: 150,
  captureHeight: 3,
  captureSlack: 0.03,
  fuelReserve: 4,
  missCost: 20,
  overBudgetCost: 400,
  rangeCost: 0.15,
  timeCost: 0.1,
  settleSpeed: 3,
  settleSeconds: 0.3,
  settleTimeoutSeconds: 3,
  aimTolerance: 0.08,
  aimTimeoutSeconds: 2,
  refuelFraction: 0.98,
  stopTimeoutSeconds: 150,
  stalledPlans: 12,
  progressMetres: 10,
  approachTilt: 0.8,
  steepLanding: 0.8,
  slideMetres: 4,
  refuelStallSeconds: 1.5,
  divertFuel: 0.5,
  tourSearchMetres: 1600,
  tourSearchStep: 32,
  tourMargin: 40,
  launchRadius: 40,
  nearLaunchMetres: 400,
}

/** The seat's best glide: the lean, radians, and the ground per metre of height. */
export const spiderGlide = (seat: JumpSeat): { readonly lean: number; readonly ratio: number } => {
  const r = seat.tuning.thrustForce / seat.body.mass / Math.abs(seat.gravity.y)
  if (!(r < 1)) return { lean: 0, ratio: Number.POSITIVE_INFINITY }
  return { lean: Math.acos(r), ratio: r / Math.sqrt(1 - r * r) }
}

const enterSpider = (sp: SpiderPilotState, phase: SpiderPhase): void => {
  sp.phase = phase
  sp.phaseSeconds = 0
}

// Volatile scratch for `surfaceUpAt`, written and read inside one call.
const _spNormal: Vec3 = v3()

/** The up-component of the normal of the highest surface under (x, y, z); 1 off every field. */
const surfaceUpAt = (fields: readonly HeightField[], x: number, y: number, z: number): number => {
  let best = Number.NEGATIVE_INFINITY
  let up = 1
  for (const field of fields) {
    if (outsideField(field, x, z) || belowField(field, y)) continue
    const h = terrainHeightAt(field, x, z)
    if (h > best) {
      best = h
      terrainNormalAt(field, x, z, _spNormal)
      up = _spNormal.y
    }
  }
  return up
}

/** The rim a stop must be captured above: the pad's top surface, SIM y. */
const rimOf = (stop: JumpSeatWaypoint): number => stop.centre.y + stop.padTop

// Volatile scratch for the spider's section only, written and read inside one call.
const _spUp: Vec3 = v3()
const _spUpBody: Vec3 = v3()
const _spRate: Vec3 = v3()
const _spInv: Quat = { x: 0, y: 0, z: 0, w: 1 }
const _spTry: SpiderHop = createSpiderHop()

/** Swing body +Y onto `up` (unit, world) with the controller's own attitude law. Returns the error, radians. */
const spiderAttitude = (
  seat: JumpSeat,
  up: Vec3,
  out: JumpSeatInput,
  tuning: JumpSeatAutopilotTuning,
): number => {
  const body = seat.body
  rotateVec3Inverse(_spUpBody, body.orientation, up)
  conjugate(_spInv, body.orientation)
  rotateVec3(_spRate, _spInv, body.angularVelocity)
  const pitchDemand = tuning.attitudeGain * _spUpBody.z - tuning.rateGain * _spRate.x
  const rollDemand = -tuning.attitudeGain * _spUpBody.x - tuning.rateGain * _spRate.z
  const yawDemand = -tuning.rateGain * _spRate.y
  out.pitch = clamp(pitchDemand / seat.tuning.pitchRate, -1, 1)
  out.roll = clamp(rollDemand / seat.tuning.rollRate, -1, 1)
  out.yaw = clamp(yawDemand / seat.tuning.yawRate, -1, 1)
  return Math.acos(clamp(_spUpBody.y, -1, 1))
}

/** A unit vector `lean` radians from vertical toward (dirX, dirZ), into `out`. */
const leanedUp = (out: Vec3, dirX: number, dirZ: number, lean: number): Vec3 => {
  const s = Math.sin(lean)
  return set(out, dirX * s, Math.cos(lean), dirZ * s)
}

/**
 * Fly one candidate through the point-mass model from where the seat sits.
 * Writes `hop.reaches`, `fuel`, `seconds` and `land`.
 */
const modelHop = (
  seat: JumpSeat,
  stop: JumpSeatWaypoint,
  fields: readonly HeightField[],
  hop: SpiderHop,
  parked: number,
  tuning: SpiderPilotTuning,
): void => {
  const jump = seat.jump
  if (!jump) return
  const t = seat.tuning
  const a = t.thrustForce / seat.body.mass
  const g = seat.gravity.y
  const h = tuning.modelTicks * FIXED_DT
  const dv = jumpDv(jump.spec, hop.charge)
  const sL = Math.sin(hop.launchLean)
  let px = seat.body.position.x
  let py = seat.body.position.y
  let pz = seat.body.position.z
  let vx = seat.body.velocity.x + dv * sL * hop.dirX
  let vy = seat.body.velocity.y + dv * Math.cos(hop.launchLean)
  let vz = seat.body.velocity.z + dv * sL * hop.dirZ
  const rim = rimOf(stop) + tuning.captureHeight
  const capture = Math.min(stop.half.x, stop.half.z)
  const cosG = Math.cos(hop.glideLean)
  const sinG = Math.sin(hop.glideLean)
  const cosL = Math.cos(hop.launchLean)
  // The charge's own cost: the boosted burn for as long as it fills.
  let fuel = t.burnRate * t.boostBurnRateMultiplier * jump.spec.chargeSeconds * hop.charge
  let time = 0
  hop.reaches = false
  hop.landUp = 1
  set(hop.land, px, py, pz)
  while (time < tuning.modelSeconds) {
    const rising = vy > 0
    const jet = rising ? hop.climbJet : hop.glideLean >= 0
    let ax = 0
    let ay = g
    let az = 0
    if (jet) {
      if (rising) {
        ax = a * sL * hop.dirX
        ay += a * cosL
        az = a * sL * hop.dirZ
      } else {
        // Re-aimed at the stop each step when the hop is FOR the stop, as the
        // flight does; along the hop's own heading when it is a step on the way.
        const dx = hop.homing ? stop.centre.x - px : hop.dirX
        const dz = hop.homing ? stop.centre.z - pz : hop.dirZ
        const d = Math.hypot(dx, dz)
        const ux = d > 1e-6 ? dx / d : 0
        const uz = d > 1e-6 ? dz / d : 0
        ax = a * sinG * ux
        ay += a * cosG
        az = a * sinG * uz
      }
      fuel += t.burnRate * h
    }
    vx += ax * h
    vy += ay * h
    vz += az * h
    const k = 1 - (jet ? t.dragBase : t.dragFreefall) * h
    const f = k > 0 ? k : 0
    vx *= f
    vy *= f
    vz *= f
    px += vx * h
    py += vy * h
    pz += vz * h
    time += h
    const flat = Math.hypot(stop.centre.x - px, stop.centre.z - pz)
    const travelled = Math.hypot(px - seat.body.position.x, pz - seat.body.position.z)
    if (
      py >= rim + tuning.captureSlack * travelled &&
      flat <= capture + Math.hypot(vx, vz) / t.dragBase
    ) {
      hop.reaches = true
      set(hop.land, px, py, pz)
      // The approach still has to come down from here, on the jet, at the sink
      // its tilt allows: priced, so a capture 300 m over the rim is not free.
      const sink = (-g - a * Math.cos(tuning.approachTilt)) / t.dragBase
      if (sink > 0) fuel += (t.burnRate * (py - rim)) / sink
      break
    }
    const ground = highestGroundUnder(fields, px, pz, py)
    if (!Number.isFinite(ground)) {
      time = Number.POSITIVE_INFINITY
      break
    }
    if (vy <= 0 && py <= ground + parked) {
      set(hop.land, px, ground + parked, pz)
      hop.landUp = surfaceUpAt(fields, px, py, pz)
      // Down ON the stop's own plate — landed where it was going, with the
      // height to spare the rim test asks for: that is a capture too.
      if (flat <= capture && py >= stop.centre.y - stop.half.y) hop.reaches = true
      break
    }
    if (py < ground) {
      // Into a face on the way UP: the hull stops against it and the seat slides
      // back down it, so the hop buys nothing. Scored as coming down where it
      // started, on a slope. Without this the model flew through cliffs and
      // landed on top of them, and the pilot fired the same hop into the same
      // wall fifteen times on `adv_01_jumpSeat`.
      set(hop.land, seat.body.position.x, seat.body.position.y, seat.body.position.z)
      hop.landUp = 0
      break
    }
    // Still in the air at the model's horizon: scored from where it got to,
    // which is optimistic about a fall that has not ended and no worse than
    // pretending it never left.
    set(hop.land, px, py, pz)
  }
  hop.fuel = fuel
  hop.seconds = time
}

/**
 * Choose the hop from where the seat is settled: every candidate through
 * `modelHop`, scored, the cheapest kept in `sp.hop`.
 */
export const planSpiderHop = (
  seat: JumpSeat,
  stop: JumpSeatWaypoint,
  fields: readonly HeightField[],
  sp: SpiderPilotState,
  tuning: SpiderPilotTuning = DEFAULT_SPIDER_PILOT,
): SpiderHop => {
  const best = sp.hop
  sp.plans++
  const pos = seat.body.position
  const dx = stop.centre.x - pos.x
  const dz = stop.centre.z - pos.z
  const d = Math.hypot(dx, dz)
  const dirX = d > 1e-6 ? dx / d : 0
  const dirZ = d > 1e-6 ? dz / d : 1
  const ground = highestGroundUnder(fields, pos.x, pos.z, pos.y)
  const parked = Number.isFinite(ground) ? Math.max(0, pos.y - ground) : 0
  const glide = spiderGlide(seat)
  const top = rimOf(stop)
  const budget = seat.burnsFuel ? seat.fuel - tuning.fuelReserve : Number.POSITIVE_INFINITY
  // The best glide's speed over the ground, m/s: what a metre left to cover
  // costs in jet time, and so in fuel, from wherever a hop comes down.
  const accel = seat.tuning.thrustForce / seat.body.mass
  const glideSpeed = (accel * Math.sin(glide.lean)) / seat.tuning.dragBase
  const perMetre = glideSpeed > 0 ? seat.tuning.burnRate / glideSpeed : 0
  set(sp.planned, pos.x, pos.y, pos.z)
  best.cost = Number.POSITIVE_INFINITY
  sp.reachable = 0
  sp.timedOut = 0
  const consider = (hop: SpiderHop): void => {
    modelHop(seat, stop, fields, hop, parked, tuning)
    if (!Number.isFinite(hop.seconds)) return
    if (hop.reaches) sp.reachable++
    if (!hop.reaches && hop.seconds >= tuning.modelSeconds) sp.timedOut++
    const spend = seat.burnsFuel ? hop.fuel : 0
    if (spend > budget && !hop.reaches) return
    // A hop that comes down where it left buys nothing but a charge: it is how
    // a seat under a sea stack spent 150 s bouncing on the water.
    const moved = Math.hypot(hop.land.x - pos.x, hop.land.y - pos.y, hop.land.z - pos.z)
    if (!hop.reaches && moved < tuning.slideMetres) return
    let cost = spend + tuning.timeCost * hop.seconds
    if (!hop.reaches) {
      // What is LEFT from where it comes down, in the same units as what the
      // hop spent: another hop, the jet time to glide the ground still to
      // cover, and — when the stop is out of a glide's reach from there — the
      // equivalent range still to climb. Never less than a hop and a glide:
      // landing higher than the stop needs is not worth anything more.
      const flat = Math.hypot(stop.centre.x - hop.land.x, stop.centre.z - hop.land.z)
      const range = flat - glide.ratio * (hop.land.y - top)
      cost += tuning.missCost + perMetre * flat + tuning.rangeCost * Math.max(0, range)
      if (hop.landUp < tuning.steepLanding) cost += tuning.missCost
    }
    if (spend > budget) cost += tuning.overBudgetCost
    if (cost < best.cost) {
      best.dirX = hop.dirX
      best.dirZ = hop.dirZ
      best.charge = hop.charge
      best.launchLean = hop.launchLean
      best.climbJet = hop.climbJet
      best.glideLean = hop.glideLean
      best.homing = hop.homing
      best.reaches = hop.reaches
      best.fuel = hop.fuel
      best.seconds = hop.seconds
      best.cost = cost
      copy(best.land, hop.land)
    }
  }
  // ── Stage 1: at the stop. Every charge, lean and jet policy on its heading;
  // the fall homes on it. Glide leans: the best glide, the tuning's steeper
  // ones, and the jet shut.
  const glides = tuning.glideLeans.length + 2
  const hop = _spTry
  for (const charge of tuning.charges) {
    for (const launchLean of tuning.launchLeans) {
      for (let c = 0; c < 2; c++) {
        for (let gi = 0; gi < glides; gi++) {
          hop.dirX = dirX
          hop.dirZ = dirZ
          hop.charge = charge
          hop.launchLean = launchLean
          hop.climbJet = c === 0
          hop.homing = true
          hop.glideLean =
            gi === 0 ? glide.lean : gi === glides - 1 ? -1 : (tuning.glideLeans[gi - 1] as number)
          consider(hop)
        }
      }
    }
  }
  // ── Stage 2: when nothing on the heading reaches it, a step on the way. A
  // full charge on every compass heading, leaned, landing where the equivalent
  // range is least: up a hillside, onto a ridge, anywhere a metre of height
  // buys more than the ground it gives up. This is what gets a spider out from
  // under a pad that floats higher than it can jump.
  if (!best.reaches) {
    const n = tuning.headings
    for (let i = 0; i < n; i++) {
      const angle = (2 * Math.PI * i) / n
      for (const launchLean of tuning.launchLeans) {
        if (!(launchLean > 0)) continue
        for (let gi = 0; gi < 2; gi++) {
          hop.dirX = Math.sin(angle)
          hop.dirZ = Math.cos(angle)
          hop.charge = 1
          hop.launchLean = launchLean
          hop.climbJet = false
          hop.homing = false
          hop.glideLean = gi === 0 ? glide.lean : -1
          consider(hop)
        }
      }
    }
  }
  if (!Number.isFinite(best.cost)) {
    // Nothing affordable: the cheapest possible hop, straight at the stop, jet shut.
    best.dirX = dirX
    best.dirZ = dirZ
    best.charge = 1
    best.launchLean = tuning.launchLeans[tuning.launchLeans.length - 1] ?? 0
    best.climbJet = false
    best.glideLean = -1
    best.homing = true
    best.reaches = false
  }
  return best
}

/**
 * The spider's pilot: the stop logic of `stepJumpSeatPilot` (score, refuel,
 * give up on a timeout) around a HOP loop — settle, plan, lean, charge,
 * release, fly the fall — instead of a climb it cannot make.
 */
export const stepSpiderPilot = (
  pilot: JumpSeatPilot,
  seat: JumpSeat,
  out: JumpSeatInput,
  padTaken: readonly boolean[],
  terrain: readonly HeightField[],
  tuning: JumpSeatAutopilotTuning,
  dt: number,
  spider: SpiderPilotTuning = DEFAULT_SPIDER_PILOT,
): JumpSeatInput => {
  const jump = seat.jump
  const sp = pilot.spider
  out.throttle = 0
  out.boost = 0
  out.pitch = 0
  out.roll = 0
  out.yaw = 0
  if (!jump) return out
  // Before `Trigger_EnableJumpShip` fires there is no thruster to charge or
  // burn, and a throttle held through the countdown spends fuel on nothing
  // (the burn is not gated on `live`): sit level and wait.
  if (!seat.live) {
    set(_spUp, 0, 1, 0)
    spiderAttitude(seat, _spUp, out, tuning)
    enterSpider(sp, 'settle')
    return out
  }
  sp.phaseSeconds += dt
  if (sp.order.length === 0 && pilot.route.length > 0) planSpiderTour(pilot, seat, terrain, spider)
  if (jump.jumps !== sp.seenJumps) {
    sp.hops += jump.jumps - sp.seenJumps
    sp.seenJumps = jump.jumps
    sp.captured = false
    enterSpider(sp, 'air')
  }

  const stop = spiderStop(pilot, pilot.cursor)
  if (stop) {
    pilot.onStopSeconds += dt
    // The LAST stop is the finish pad, and a plate scored on its rim is not the
    // finish crossed: `Trigger_Finish_JumpSeat` spans the middle. So there the
    // seat must be in the bullseye itself, as the climbing pilot's containment
    // test asks, before it counts as arrived.
    const last = pilot.cursor === sp.order.length - 1
    const scored = padTaken[stop.pad] === true && !last
    const arrived = scored || sweepHitsBox(stop, seat.body.position, seat.body.position) >= 0
    if (stop.pad < 0) {
      // A launch point: STANDING on it is the whole of it — the next leg's glide
      // is paid for by the jump from here, so passing over it in the air is
      // not arriving, and there is no fuel to wait for. On to the pad.
      if (arrived && jumpFooting(jump) && sp.phase !== 'air') {
        pilot.cursor++
        pilot.phase = 'strike'
        pilot.onStopSeconds = 0
      }
    } else if (arrived && pilot.phase === 'strike') {
      pilot.phase = 'refuel'
      pilot.onStopSeconds = 0
    }
    // A pad that has stopped paying — the seat slid off the plate, out of the
    // sphere — is left rather than waited on (`refuelStallSeconds`).
    sp.rising = seat.fuel > sp.lastFuel
    // Only STANDING without the tank rising is a stall: a bounce off the plate
    // after it scored is not a pad that has stopped paying.
    sp.refuelStall = sp.rising ? 0 : jumpFooting(jump) ? sp.refuelStall + dt : sp.refuelStall
    sp.lastFuel = seat.fuel
    const fuelled =
      !seat.burnsFuel ||
      seat.fuel >= seat.tuning.maxFuel * spider.refuelFraction ||
      sp.refuelStall > spider.refuelStallSeconds
    if (pilot.phase === 'refuel' && fuelled) {
      pilot.cursor++
      pilot.phase = spiderStop(pilot, pilot.cursor) ? 'strike' : 'done'
      pilot.onStopSeconds = 0
      if (sp.phase !== 'air') enterSpider(sp, 'settle')
    } else if (pilot.onStopSeconds > spider.stopTimeoutSeconds) {
      pilot.abandoned++
      pilot.cursor++
      pilot.phase = spiderStop(pilot, pilot.cursor) ? 'strike' : 'done'
      pilot.onStopSeconds = 0
    }
  }
  const body = seat.body
  // Footing, not a single tick's contact: the mechanic's own grace, so a
  // seat whose feet chatter on a crest is standing to the pilot as to the jump.
  const supported = jumpFooting(jump)
  // ── Diverting for fuel ───────────────────────────────────────────────────
  // Flown exactly as a stop is, to the pad chosen; once its sphere is paying
  // the seat holds there until the tank is full (or stops rising), and then
  // takes up the route where it left it.
  let target = spiderStop(pilot, pilot.cursor)
  if (target && sp.divert >= 0) {
    if (sp.rising) sp.divertPaid = true
    const full = seat.fuel >= seat.tuning.maxFuel * spider.refuelFraction
    if (full || (sp.divertPaid && sp.refuelStall > spider.refuelStallSeconds)) sp.divert = -1
    const refuelAt = pilot.route[sp.divert]
    if (sp.divert >= 0 && refuelAt) {
      target = refuelAt
      if (sp.rising && supported) {
        set(_spUp, 0, 1, 0)
        spiderAttitude(seat, _spUp, out, tuning)
        if (sp.phase !== 'settle') enterSpider(sp, 'settle')
        return out
      }
    }
  }
  const speed = Math.hypot(body.velocity.x, body.velocity.y, body.velocity.z)
  const hop = sp.hop

  // Taking fuel on a pad, or done: hold still and level with the throttle shut.
  // In the air (a pad's refuel caught mid-bounce), the approach holds station.
  if (!target || pilot.phase === 'refuel') {
    if (!target) pilot.phase = 'done'
    if (supported) {
      set(_spUp, 0, 1, 0)
      spiderAttitude(seat, _spUp, out, tuning)
      if (sp.phase !== 'settle') enterSpider(sp, 'settle')
      return out
    }
    copy(pilot.aim, body.position)
    spiderApproach(seat, pilot.aim, out, tuning, terrain, spider)
    return out
  }

  if (sp.phase === 'air') {
    if (supported && jump.burstTicksLeft === 0 && speed < spider.settleSpeed) {
      enterSpider(sp, 'settle')
    } else {
      spiderAir(pilot, seat, target, out, tuning, terrain, spider)
      return out
    }
  } else if (!supported && jump.burstTicksLeft === 0 && sp.phaseSeconds > dt) {
    // Knocked off, or slid off an edge while planning: fly it as a fall.
    hop.glideLean = spiderGlide(seat).lean
    hop.climbJet = false
    hop.homing = true
    sp.captured = false
    enterSpider(sp, 'air')
    spiderAir(pilot, seat, target, out, tuning, terrain, spider)
    return out
  }

  // ── On the ground: settle, plan, lean, charge, release ──────────────────
  if (sp.phase === 'settle') {
    set(_spUp, 0, 1, 0)
    spiderAttitude(seat, _spUp, out, tuning)
    const still = speed < spider.settleSpeed && sp.phaseSeconds >= spider.settleSeconds
    if (still || sp.phaseSeconds >= spider.settleTimeoutSeconds) {
      if (sp.divert < 0) {
        if (sp.progressAt !== pilot.cursor) {
          sp.progressAt = pilot.cursor
          sp.bestRange = Number.POSITIVE_INFINITY
          sp.stalled = 0
        }
        const flat = Math.hypot(
          target.centre.x - body.position.x,
          target.centre.z - body.position.z,
        )
        const range = flat - spiderGlide(seat).ratio * (body.position.y - rimOf(target))
        if (range < sp.bestRange - spider.progressMetres) {
          sp.bestRange = range
          sp.stalled = 0
        } else if (++sp.stalled >= spider.stalledPlans) {
          pilot.abandoned++
          pilot.cursor++
          pilot.phase = spiderStop(pilot, pilot.cursor) ? 'strike' : 'done'
          pilot.onStopSeconds = 0
          enterSpider(sp, 'settle')
          return out
        }
      }
      planSpiderHop(seat, target, terrain, sp, spider)
      if (
        !sp.hop.reaches &&
        sp.divert < 0 &&
        seat.burnsFuel &&
        seat.fuel < seat.tuning.maxFuel * spider.divertFuel
      ) {
        const refuelAt = spiderRefuelPad(pilot, seat)
        const pad = pilot.route[refuelAt]
        if (pad && pad !== target) {
          sp.divert = refuelAt
          sp.divertPaid = false
          sp.diversions++
          planSpiderHop(seat, pad, terrain, sp, spider)
        }
      }
      enterSpider(sp, 'aim')
    }
    return out
  }
  // Slid since the plan (a slope, a knock): the plan is from somewhere else.
  const slid = Math.hypot(
    body.position.x - sp.planned.x,
    body.position.y - sp.planned.y,
    body.position.z - sp.planned.z,
  )
  if (slid > spider.slideMetres && !jump.charging) {
    enterSpider(sp, 'settle')
    return out
  }
  leanedUp(_spUp, hop.dirX, hop.dirZ, hop.launchLean)
  const error = spiderAttitude(seat, _spUp, out, tuning)
  if (sp.phase === 'aim') {
    if (error < spider.aimTolerance || sp.phaseSeconds > spider.aimTimeoutSeconds) {
      enterSpider(sp, 'charge')
    }
    return out
  }
  // 'charge': both triggers until the charge is what the hop asks for, then let
  // go of the boost side — and of the throttle too unless the hop climbs on the
  // jet (§4.1: releasing only the boost keeps the jet lit).
  const full = jump.charge >= hop.charge
  out.throttle = full && !hop.climbJet ? 0 : 1
  out.boost = full ? 0 : 1
  return out
}

/**
 * The pad to divert to for fuel: the one the seat can glide to best — least
 * equivalent range, `flat − ratio · height above its rim` — never the finish
 * pad unless that is the stop anyway, because crossing it ends the run.
 */
const spiderRefuelPad = (pilot: JumpSeatPilot, seat: JumpSeat): number => {
  const glide = spiderGlide(seat)
  const finish = pilot.route[pilot.route.length - 1]
  const pos = seat.body.position
  let best = -1
  let bestRange = Number.POSITIVE_INFINITY
  for (let i = 0; i < pilot.route.length; i++) {
    const pad = pilot.route[i] as JumpSeatWaypoint
    if (pad === finish && pad !== spiderStop(pilot, pilot.cursor)) continue
    const flat = Math.hypot(pad.centre.x - pos.x, pad.centre.z - pos.z)
    const range = flat - glide.ratio * (pos.y - rimOf(pad))
    if (range < bestRange) {
      bestRange = range
      best = i
    }
  }
  return best
}

/** The stop at tour position `k`: a pad, or a launch point the tour put before one. */
const spiderStop = (pilot: JumpSeatPilot, k: number): JumpSeatWaypoint | undefined => {
  const sp = pilot.spider
  const i = sp.order[k]
  if (i === undefined) return pilot.route[k]
  return i < pilot.route.length ? pilot.route[i] : sp.launches[i - pilot.route.length]
}

/**
 * The spider's tour: the same pads, the finish still last, in the order a seat
 * that cannot climb can fly them — and, where a pad can only be glided onto
 * from high ground, the LAUNCH POINT on that ground as a stop of its own before
 * it.
 *
 * `planJumpSeatRoute` orders by straight-line distance, which is right for a
 * machine that climbs and wrong for this one: on `int_01_jumpSeat` it takes the
 * pad on the sea stack — 300 m over the water, nothing under it to jump from —
 * straight after a pad at the same height 755 m away, and no hop from there
 * reaches it. From the pad 250 m above it, a kilometre off, one glide does.
 *
 * Each leg is priced from the seat's own numbers — its jump's apex straight up
 * (`spiderApex`), its best glide ratio, a hop's reach over the ground — in the
 * units the hop planner scores in: a hop costs `missCost`, a glide its fuel.
 * A pad in glide reach costs one hop and the glide. One that is not costs the
 * cheapest route through a launch point: a sampled surface within
 * `tourSearchMetres` from which it IS in glide reach, priced as the hops to
 * climb to it and the glide from it. None of either, and the leg is priced out.
 * Then the cheapest order is found exactly (Held-Karp over at most eleven pads,
 * a few thousand states), once, on the first live tick.
 */
const planSpiderTour = (
  pilot: JumpSeatPilot,
  seat: JumpSeat,
  fields: readonly HeightField[],
  tuning: SpiderPilotTuning,
): void => {
  const route = pilot.route
  const n = route.length
  const sp = pilot.spider
  const order = sp.order
  const glide = spiderGlide(seat)
  const apex = spiderApex(seat, tuning)
  const reach = spiderReach(seat, tuning)
  const accel = seat.tuning.thrustForce / seat.body.mass
  const glideSpeed = (accel * Math.sin(glide.lean)) / seat.tuning.dragBase
  const perMetre = glideSpeed > 0 ? seat.tuning.burnRate / glideSpeed : 0
  const here = seat.body.position
  const ground = highestGroundUnder(fields, here.x, here.z, here.y)
  const parked = Number.isFinite(ground) ? Math.max(0, here.y - ground) : 0
  // Every sampled surface from which each pad is in glide reach: x, y, z. And
  // whether any is NEAR it: a pad with such ground close by is reached the way
  // any pad on land is, hop by hop up to it, and needs no launch point.
  const near = route.map(() => false)
  const launches = route.map((pad, index) => {
    const out: number[] = []
    const r = tuning.tourSearchMetres
    const step = tuning.tourSearchStep
    const top = rimOf(pad) + tuning.captureHeight
    for (let dx = -r; dx <= r; dx += step) {
      for (let dz = -r; dz <= r; dz += step) {
        const flat = Math.hypot(dx, dz)
        // Not the pad's own bowl: standing on it is not a way of reaching it.
        if (flat > r || flat <= tuning.launchRadius) continue
        const x = pad.centre.x + dx
        const z = pad.centre.z + dz
        const h = highestGroundUnder(fields, x, z, PADS_SOLID)
        if (!Number.isFinite(h)) continue
        // Ground the seat can stand on: a launch point on a slope slides it
        // off before it jumps.
        if (surfaceUpAt(fields, x, Number.POSITIVE_INFINITY, z) < tuning.steepLanding) continue
        // In glide reach with the model's own slack in hand — the height the
        // seat loses over a glide that the model does not — and the margin.
        const spare = h + parked + apex - top - tuning.captureSlack * flat
        if (flat - glide.ratio * spare <= -tuning.tourMargin) {
          out.push(x, h + parked, z)
          if (flat <= tuning.nearLaunchMetres) near[index] = true
        }
      }
    }
    return out
  })
  // A leg's price and, when it goes through one, the launch point (an index
  // into that pad's list, in threes), or -1 for a straight glide.
  let via = -1
  const legCost = (fromX: number, fromY: number, fromZ: number, to: number): number => {
    via = -1
    const pad = route[to] as JumpSeatWaypoint
    const flat = Math.hypot(pad.centre.x - fromX, pad.centre.z - fromZ)
    const top = rimOf(pad) + tuning.captureHeight
    if (flat - glide.ratio * (fromY + apex - top) <= -tuning.tourMargin) {
      return tuning.missCost + perMetre * flat
    }
    if (near[to]) {
      const climb = Math.max(0, top - fromY)
      const hops = Math.max(Math.ceil(flat / reach), Math.ceil(climb / apex))
      return tuning.missCost * (hops + 1) + perMetre * flat
    }
    const list = launches[to] as number[]
    let best = tuning.overBudgetCost * tuning.overBudgetCost + flat
    for (let i = 0; i < list.length; i += 3) {
      const x = list[i] as number
      const y = list[i + 1] as number
      const z = list[i + 2] as number
      const toLaunch = Math.hypot(x - fromX, z - fromZ)
      const hops = Math.max(Math.ceil(toLaunch / reach), Math.ceil(Math.max(0, y - fromY) / apex))
      const cost =
        tuning.missCost * (hops + 1) + perMetre * Math.hypot(pad.centre.x - x, pad.centre.z - z)
      if (cost < best) {
        best = cost
        via = i
      }
    }
    return best
  }
  if (n <= 2) {
    for (let i = 0; i < n; i++) order.push(i)
    return
  }
  // Held-Karp over the pads before the last (the finish, pinned last).
  const k = n - 1
  const states = 1 << k
  const dp = new Float64Array(states * k).fill(Number.POSITIVE_INFINITY)
  const from = new Int16Array(states * k).fill(-1)
  for (let j = 0; j < k; j++) dp[(1 << j) * k + j] = legCost(here.x, here.y, here.z, j)
  for (let mask = 1; mask < states; mask++) {
    for (let j = 0; j < k; j++) {
      if (!(mask & (1 << j))) continue
      const cost0 = dp[mask * k + j] as number
      if (!Number.isFinite(cost0)) continue
      const a = route[j] as JumpSeatWaypoint
      for (let m = 0; m < k; m++) {
        if (mask & (1 << m)) continue
        const next = mask | (1 << m)
        const cost = cost0 + legCost(a.centre.x, a.centre.y, a.centre.z, m)
        if (cost < (dp[next * k + m] as number)) {
          dp[next * k + m] = cost
          from[next * k + m] = j
        }
      }
    }
  }
  const all = states - 1
  let end = 0
  let bestTotal = Number.POSITIVE_INFINITY
  for (let j = 0; j < k; j++) {
    const a = route[j] as JumpSeatWaypoint
    const total = (dp[all * k + j] as number) + legCost(a.centre.x, a.centre.y, a.centre.z, k)
    if (total < bestTotal) {
      bestTotal = total
      end = j
    }
  }
  const pads: number[] = []
  let mask = all
  let j = end
  while (j >= 0) {
    pads.push(j)
    const prev = from[mask * k + j] as number
    mask &= ~(1 << j)
    j = prev
  }
  pads.reverse()
  pads.push(k)
  // The tour, with a launch point before each pad a leg reaches through one.
  let fx = here.x
  let fy = here.y
  let fz = here.z
  for (const index of pads) {
    legCost(fx, fy, fz, index)
    if (via >= 0) {
      const list = launches[index] as number[]
      const r = tuning.launchRadius
      sp.launches.push({
        centre: v3(list[via] as number, list[via + 1] as number, list[via + 2] as number),
        axes: [v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1)],
        half: v3(r, r, r),
        pad: -1,
        padTop: 0,
      })
      order.push(route.length + sp.launches.length - 1)
    }
    order.push(index)
    const pad = route[index] as JumpSeatWaypoint
    fx = pad.centre.x
    fy = pad.centre.y
    fz = pad.centre.z
  }
}

/**
 * How far over the ground a full-charge hop carries on the level, metres:
 * launched at the widest lean the planner tries, jet shut, back down to the
 * launch height. What a leg over land is priced in hops of.
 */
const spiderReach = (seat: JumpSeat, tuning: SpiderPilotTuning): number => {
  const jump = seat.jump
  if (!jump) return 0
  const lean = Math.max(...tuning.launchLeans)
  const dv = jumpDv(jump.spec, 1)
  const h = tuning.modelTicks * FIXED_DT
  const f0 = 1 - seat.tuning.dragFreefall * h
  const f = f0 > 0 ? f0 : 0
  let vx = dv * Math.sin(lean)
  let vy = dv * Math.cos(lean)
  let x = 0
  let y = 0
  do {
    vy += seat.gravity.y * h
    vx *= f
    vy *= f
    x += vx * h
    y += vy * h
  } while (y > 0)
  return x > 0 ? x : 1
}

/**
 * The height a full charge gains straight up with the jet lit, metres: the
 * seat's own jump, thrust, drag and gravity, stepped as `modelHop` steps them.
 */
const spiderApex = (seat: JumpSeat, tuning: SpiderPilotTuning): number => {
  const jump = seat.jump
  if (!jump) return 0
  const t = seat.tuning
  const a = t.thrustForce / seat.body.mass
  const h = tuning.modelTicks * FIXED_DT
  let vy = jumpDv(jump.spec, 1)
  let y = 0
  while (vy > 0) {
    vy += (a + seat.gravity.y) * h
    const f = 1 - t.dragBase * h
    vy *= f > 0 ? f : 0
    y += vy * h
  }
  return y
}

/** The flight between hops: the planned policy until the stop is captured, then the approach. */
const spiderAir = (
  pilot: JumpSeatPilot,
  seat: JumpSeat,
  stop: JumpSeatWaypoint,
  out: JumpSeatInput,
  tuning: JumpSeatAutopilotTuning,
  terrain: readonly HeightField[],
  spider: SpiderPilotTuning,
): void => {
  const sp = pilot.spider
  const hop = sp.hop
  const body = seat.body
  const dx = stop.centre.x - body.position.x
  const dz = stop.centre.z - body.position.z
  const flat = Math.hypot(dx, dz)
  const vh = Math.hypot(body.velocity.x, body.velocity.z)
  if (
    !sp.captured &&
    body.position.y >= rimOf(stop) + spider.captureHeight &&
    flat <= Math.min(stop.half.x, stop.half.z) + vh / seat.tuning.dragBase
  ) {
    sp.captured = true
  }
  if (sp.captured) {
    const overPlate = flat < Math.min(stop.half.x, stop.half.z)
    const lift = overPlate
      ? -stop.half.y * tuning.strikeDepthFraction
      : stop.padTop + tuning.padApproachClearance
    set(pilot.aim, stop.centre.x, stop.centre.y + lift, stop.centre.z)
    spiderApproach(seat, pilot.aim, out, tuning, terrain, spider)
    return
  }
  // Under the rim and already about over it: no glide can lift it back, so
  // stop spending the jet circling down and drop, to jump again from whatever
  // is below.
  if (
    body.position.y < rimOf(stop) &&
    flat <= Math.max(stop.half.x, stop.half.z) + vh / seat.tuning.dragBase
  ) {
    set(_spUp, 0, 1, 0)
    spiderAttitude(seat, _spUp, out, tuning)
    out.throttle = 0
    return
  }
  const rising = body.velocity.y > 0 || (seat.jump?.burstTicksLeft ?? 0) > 0
  copy(pilot.aim, stop.centre)
  if (rising) {
    leanedUp(_spUp, hop.dirX, hop.dirZ, hop.launchLean)
    spiderAttitude(seat, _spUp, out, tuning)
    out.throttle = hop.climbJet ? 1 : 0
    return
  }
  if (hop.glideLean < 0) {
    set(_spUp, 0, 1, 0)
    spiderAttitude(seat, _spUp, out, tuning)
    out.throttle = 0
    return
  }
  const ux = hop.homing && flat > 1e-6 ? dx / flat : hop.dirX
  const uz = hop.homing && flat > 1e-6 ? dz / flat : hop.dirZ
  leanedUp(_spUp, ux, uz, hop.glideLean)
  spiderAttitude(seat, _spUp, out, tuning)
  out.throttle = 1
}

/**
 * The climbing controller, handed the spider's envelope: a tilt clamp with
 * authority to stop over the plate, and the sink the jet can hold at it.
 */
const spiderApproach = (
  seat: JumpSeat,
  aim: Vec3,
  out: JumpSeatInput,
  tuning: JumpSeatAutopilotTuning,
  terrain: readonly HeightField[],
  spider: SpiderPilotTuning,
): void => {
  const accel = seat.tuning.thrustForce / seat.body.mass
  const g = Math.abs(seat.gravity.y)
  const sink = (g - accel * Math.cos(spider.approachTilt)) / seat.tuning.dragBase
  _spTuning.maxTilt = spider.approachTilt
  _spTuning.maxSinkRate = sink > 0 ? sink : tuning.maxSinkRate
  jumpSeatAutopilotActions(seat, aim, out, _spTuning, terrain, tuning.speedCap, false, 0)
  out.boost = 0
}

/** The climbing controller's defaults, with the two fields `spiderApproach` writes before every read. */
const _spTuning: {
  -readonly [K in keyof JumpSeatAutopilotTuning]: JumpSeatAutopilotTuning[K]
} = { ...DEFAULT_JUMPSEAT_AUTOPILOT }
