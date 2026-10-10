// src/sim/autopilot.ts — fly the course without a pilot.
//
// ── What this is for ──────────────────────────────────────────────────────
//
// Testing a three-minute course by hand costs three minutes and a human, and
// most of what needs checking — do the gates score, does the LOD pop, does the
// fog read right at altitude, does the frame budget survive the far side of the
// island — needs the whole run, not the first ring.
//
// So this flies it. It produces the same `HoverJetInput` a player would, and
// hands it to the same `stepHoverJet`, so it exercises the real flight model,
// the real scoring and the real gate spheres rather than pretending to. A ghost
// replay would be cheaper and would test none of that.
//
// It emits the SIM's own input type rather than `FlightActions`, because the sim
// layer may not reach into `src/input/` (CLAUDE.md rule 4, and the purity guard
// caught the first draft doing exactly that). The game layer adapts.
//
// It doubles as a golden-trajectory test: `tests/unit/autopilot.test.ts` flies
// all 21 rings of `int_01_hoverJet` headlessly in a few hundred milliseconds,
// so "the course is completable" is a thing CI can assert.
//
// ── The control laws ──────────────────────────────────────────────────────
//
// Proportional, on the error expressed in the ship's OWN frame. Nothing here is
// clever, and that is deliberate: an autopilot with integral terms would mask
// exactly the flight-model regressions it is meant to catch.
//
//   yaw     turn toward the target's bearing
//   pitch   raise or lower the nose to the target's elevation
//   roll    hold the wings level, banked into the turn
//   throttle back off when badly misaligned, so it can turn instead of
//           barrelling past
//
// ── The signs are MEASURED, not reasoned ──────────────────────────────────
//
// Unity is left-handed and the torque goes in on body axes, so the sign of each
// control is easy to get backwards and produces a ship that flies confidently
// away from the course. They were measured by driving each axis alone for 40
// ticks and reading the resulting basis:
//
//   pitch +1  ->  forward.y -0.299   nose DOWN
//   yaw   +1  ->  forward.x +0.222   nose RIGHT
//   roll  +1  ->  right.y   +0.265   banks LEFT
//
// SIM LAYER: no three, no DOM, no wall clock, no allocation in the hot path.

import type { Gate } from './course'
import { cruiseSpeed, type HoverJet, type HoverJetInput } from './hoverjet'
import { conjugate, type Quat, rotateVec3, rotateVec3Inverse } from './math/quat'
import { clamp } from './math/scalar'
import { normalize, sub, type Vec3, v3 } from './math/vec3'
import { fullStickRate } from './rigidbody'
import type { RouteGuidanceOptions } from './route'
import { chainedMaxSpeed } from './speed-chain'
import { type HeightField, highestGroundUnder, PADS_SOLID } from './terrain/height-field'

export interface AutopilotTuning {
  /** Radians of bearing error to full yaw. Smaller is twitchier. */
  readonly yawGain: number
  readonly pitchGain: number
  /** How hard it fights back to level. */
  readonly rollGain: number
  /**
   * How far to bank into a turn, as world-Y on the right wing per unit of yaw
   * demand. Zero flies flat, which works and looks like a turret.
   */
  readonly bankRatio: number
  /** Never bank past this, or a hard turn rolls inverted. */
  readonly maxBank: number
  /**
   * Throttle floor. The ship still needs airspeed to turn — chopping to zero
   * when misaligned makes it hang and wallow instead of coming round.
   */
  readonly minThrottle: number
  /**
   * Throttle CEILING. 1 is the stick fully forward, which is what the player
   * proxy and 2016's recorded pilots flew.
   *
   * Exists for the AI racers (DEV-125): `boost` doubles thrust and nothing
   * else in this tuning changes how fast an aligned ship goes, so a field of
   * five could only finish at two speeds — measured, 67 s boosted and 119 s
   * not, on `int_01`. A cap under 1 puts a racer between those two. Terminal
   * speed is linear in thrust under Unity's multiply drag (`speed-chain.ts`),
   * so 0.75 with boost is 1.5x the cruise force and lands about halfway.
   */
  readonly maxThrottle: number
  /**
   * Hold boost. True, because the 2016 ghosts did — see `autopilotActions`.
   * Exposed so a test that wants the unboosted envelope can ask for it.
   */
  readonly boost: boolean
  /**
   * Aim this far BEYOND the gate, in metres.
   *
   * Chasing the centre exactly makes the ship flatten out as it arrives and
   * clip the rim; aiming through carries it out the far side already pointed
   * onward. It is the same instinct as looking through a corner rather than at
   * it.
   */
  readonly leadMetres: number
  /**
   * Ground clearance to hold, metres.
   *
   * Not invented: measured off the 2016 ghost, whose MINIMUM clearance over the
   * whole run is **26 m** and whose 5th percentile is 55. A real pilot flew the
   * ridges with room to spare, and before this the autopilot did not — it aimed
   * straight at gate centres and, once the speed chain took it past 280 m/s, put
   * the ship through sixty-two hillsides in one lap.
   */
  readonly minClearance: number
  /** How far ahead to look, in SECONDS of travel. */
  readonly lookAheadSeconds: number
  /**
   * Retained for tuning experiments. The pull-up is an override scaled by how
   * far short of `minClearance` the path is, not a gain on a gain — see
   * `autopilotActions`.
   */
  readonly clearanceGain: number
  /** Fraction of throttle a full-urgency pull-up gives up. See `braking`. */
  readonly clearanceBrake: number
  /** Urgency at which boost is released. Lower than the throttle taper. */
  readonly boostCutUrgency: number
  /** Path samples for `pathClearance`. Six steps over a ridge at speed. */
  readonly clearanceSamples: number
  /** Inside this range of the target, the pull-up stops outranking the seek. */
  readonly gateOverrideMetres: number
  /** What the pull-up is worth on final approach, as a pitch nudge. */
  readonly gateOverrideNudge: number
  /** Within this of the authored line, the pull-up stops outranking the seek. */
  readonly routeTrustMetres: number
  /** How far ahead on the line to aim, in seconds of flight. */
  readonly routeLeadSeconds: number
  /** Floor for that lookahead, so it still works slowly. */
  readonly routeLeadMinMetres: number
  /** Arc length short of a ring at which the ring takes over the aim. */
  readonly routeFinalMetres: number
  /** Lookahead given up per radian-per-metre of curvature. */
  readonly routeCurveGain: number
  /** Aim pulled back toward the line, per metre of cross-track error. */
  readonly routeCrossGain: number
  /**
   * The nearest the line's aim may come to the ship, straight-line metres
   * (DEV-494). Read by the AI racers (`ai-racer.ts`) and, since DEV-524, by
   * the player's autopilot through `playerRouteOptions`.
   */
  readonly routeAimMinMetres: number
  /** m/s over the profile's target that counts as fully over. */
  readonly profileBand: number
  /** Throttle given up when fully over the profile's target. */
  readonly profileBrakeMax: number
  /** Over-speed fraction at which boost is released for the profile. */
  readonly profileBoostCut: number
  /** How far ahead on the line to read the profile, in seconds. */
  readonly profileLookSeconds: number
  /** Turn fraction (0 straight, 1 hairpin) below which a corner is free. */
  readonly cornerBrakeTurn: number
  /** Throttle a full hairpin gives up, at the corner. */
  readonly cornerBrakeMax: number
  /** How far out corner braking starts, in seconds of flight. */
  readonly cornerBrakeSeconds: number
  /** Weighted turn above which boost is released for the corner. */
  readonly cornerBoostCut: number
  // ── DEV-394: the ride ───────────────────────────────────────────────────
  /**
   * How much of the PATH's lag behind the nose the steering allows for, per
   * radian of it. Zero is pursuit on the nose alone, the law before DEV-394.
   * See `autopilotActions`, "the steering".
   */
  readonly slipGain: number
  /** Airspeed, m/s, under which the path's direction is not trusted for `slipGain`. */
  readonly slipMinSpeed: number
  /**
   * Seconds of the ship's own rotation the attitude holds look ahead by — the
   * bank hold and the pitch limit read the wing and the nose where they WILL
   * be. Zero is none.
   */
  readonly attitudeLeadSeconds: number
  /**
   * How far past each trust radius trust fades out, as a fraction of it.
   * Zero is a step at the radius.
   */
  readonly trustRamp: number
  /**
   * In trusted airspace, how far the ground probe is cut back to the time it
   * takes to reach the AIM, 0..1. Zero probes `lookAheadSeconds` everywhere.
   */
  readonly trustedProbeToAim: number
  /**
   * The clearance the ground rule holds in fully trusted airspace, metres.
   * Blends to `minClearance` as trust falls. At or above `minClearance` it
   * changes nothing.
   */
  readonly trustedClearance: number
  /**
   * Brake for a target the jet could not turn onto at this speed (the speed
   * law, with the jet known). False ignores the turn, as it did.
   */
  readonly turnReach: boolean
  /**
   * The steepest the nose is pushed, climbing or diving, radians. The pitch
   * that would steepen it fades out over the last quarter of this, so the
   * controller never flies a loop to reach something above or below it. Zero
   * is no limit, which is what it had.
   */
  readonly pitchLimit: number
  /**
   * The speed law's gain, when the jet is known: how many target-speeds of
   * thrust one target-speed of error is worth. Zero turns the jet-aware law
   * off and keeps the proportional band. See "the speed law".
   */
  readonly speedGain: number
  /**
   * Boost's dead band, in units of the jet's full unboosted thrust: boost lights
   * above `1 + this` and goes out below `1 - this`. Needs the jet.
   */
  readonly boostHysteresis: number
}

export const DEFAULT_AUTOPILOT: AutopilotTuning = {
  // 3.5, from 2.6 (DEV-394): with the path's lag allowed for (`slipGain`) the
  // loop takes the stiffer pursuit, and the stiffer pursuit is what damps it.
  yawGain: 3.5,
  pitchGain: 3.2,
  rollGain: 2.2,
  bankRatio: 0.55,
  maxBank: 0.72,
  minThrottle: 0.35,
  // Full stick. Anything under 1 is a racer's handicap, not the player proxy's.
  maxThrottle: 1,
  boost: true,
  leadMetres: 45,
  // A little above the ghost's minimum, because this is a controller reacting
  // rather than a human reading the ground ahead.
  minClearance: 60,
  lookAheadSeconds: 2.5,
  clearanceGain: 1,
  // How much of the throttle a full-urgency pull-up gives up. 0.6 leaves 40 %,
  // which still flies — a controller that cuts to zero stalls into the hill it
  // was avoiding.
  clearanceBrake: 0.6,
  // Boost is released as soon as the pull-up is a third of the way to full,
  // well before the throttle tapers. See `out.boost`.
  boostCutUrgency: 0.34,
  // 12, not 6. At 185 m/s a 2.5 s lookahead is 462 m, and six samples put them
  // 77 m apart — wide enough to step clean over a ridge crest and report the
  // valley on either side of it. Twelve is 38 m, against a terrain whose quads
  // are 8 m.
  clearanceSamples: 12,
  // Final approach. A shade over five gate radii (22.6 m on `int_01`), which is
  // about a second of flight at racing speed — long enough to commit, short
  // enough that the priority rule still governs everything between gates.
  gateOverrideMetres: 120,
  // What the pull-up is worth once it stops outranking the seek. Enough to
  // flatten a dive, not enough to fly over the thing you are aiming at.
  gateOverrideNudge: 0.45,
  // How close to the authored line counts as trusted airspace. A little over
  // twice a gate radius: wide enough that normal cornering stays inside it,
  // narrow enough that a ship knocked off the course gets the priority rule back.
  routeTrustMetres: 55,
  // How far ahead on the line to aim, as SECONDS of flight. A distance would
  // corner well and oversteer on a straight, or the reverse; a time scales with
  // speed the way a pilot's eye does. Floored so it still works at a standstill.
  //
  // 1.1 s, from 0.9 (DEV-394). A longer lead is a slower, better-damped loop
  // (on the linearised follower, ζ 0.10 -> 0.22 on its own), and with the
  // path's lag allowed for it no longer costs the corners it did: on `int_01`
  // the player's autopilot sat 17.1 m off the line at p95 before, 5.6 after.
  routeLeadSeconds: 1.1,
  routeLeadMinMetres: 60,
  // Arc length short of a ring at which the RING takes over from the line.
  //
  // ZERO: the follower only falls back to the ring once the ring is BEHIND it on
  // the line, which is the one case a monotonic cursor cannot recover from. A
  // non-zero value was tried, on a measurement that turned out to be wrong —
  // 90 m cost 7 s a lap and 220 m cost 9, both by replacing the lookahead with a
  // point target and flattening the approach.
  routeFinalMetres: 0,
  // How much lookahead a bend gives up, in metres per radian-per-metre.
  //
  // ZERO, because tuning it has not worked yet. 900 shortens the lead enough to
  // oscillate and cost four gates a lap — the same failure a flat 0.45 s lead
  // has. The mechanism is right (long on a straight, short in a bend) and the
  // curvature is measured and available; the gain is not found. See DEV-027.
  routeCurveGain: 0,
  // How hard the aim is pulled back toward the line, per metre of cross-track
  // error. Zero on the line, so it costs nothing on a straight — which is what
  // makes it safe where shortening the lookahead was not.
  routeCrossGain: 0.15,
  // The nearest the aim may come to the ship, in the air rather than along the
  // line (DEV-494, `routeGuidance`). Where the line folds back on itself, the
  // point `routeLeadMinMetres` along it can sit ON the ship, and the turn-reach
  // law then asks for no speed at all: a racer stopped at a hairpin for a
  // whole race. HALF the shortest lead, so it bites only on a fold: the chord of
  // a 60 m arc is under 30 m only round a radius under ~16 m, and every shipped
  // HoverJet line flies the same bits with it as without it
  // (`tests/unit/ai-racer-hairpin.test.ts`). A ship 30 m from its aim still
  // gets the turn-reach law's `rate × 30 / 2` of speed to turn round with.
  routeAimMinMetres: 30,
  // ── The velocity profile ──────────────────────────────────────────────
  //
  // How far over the profile's target counts as fully over, in m/s. A band
  // rather than a step, or the throttle chatters on the boundary.
  profileBand: 25,
  profileBrakeMax: 0.9,
  profileBoostCut: 0.15,
  // Read the profile this far AHEAD, in seconds. The whole point of a backward
  // pass is that it tells you to slow before you arrive; reading it underfoot
  // throws that away.
  //
  // 1.0, from 2.5 (DEV-394). The profile brakes as the flight model does now,
  // in tens of metres rather than kilometres (`sim/route.ts`), so what this
  // covers is only the lag before the braking bites: the engine's spool-down
  // (0.5 s from full boost) and the speed law's own 0.42 s. 2.5 s ahead of a
  // profile that drops in 50 m is braking two seconds early.
  profileLookSeconds: 1.0,
  // ── Corner braking ────────────────────────────────────────────────────
  //
  // `cornerBrakeTurn` is the turn fraction (0 straight, 1 hairpin) below which a
  // corner is free: 0.18 is about 32 degrees, which this ship carries at full
  // speed. Above it the cost ramps to `cornerBrakeMax` of the throttle.
  //
  // `cornerBrakeSeconds` is how far out braking starts, as TIME — the faster you
  // are the earlier you lift, which is the whole point and is not something a
  // distance can express.
  cornerBrakeTurn: 0.18,
  cornerBrakeMax: 0.6,
  // 1.7 s, and the larger value was measured and rejected. `int_01`'s three real
  // corners are 76, 94 and 99 degrees, so braking harder for them is the obvious
  // move — and at 3.6 s it cost TWO GATES a lap and, worse, homogenised the AI
  // racers to 6 m apart over 30 s, because they share these constants and
  // braking dominated the tuning differences that make them a race.
  cornerBrakeSeconds: 1.7,
  // Boost goes before the throttle does, for the same reason it does on a
  // terrain pull-up: it is worth about 2x the speed and costs nothing to regain.
  cornerBoostCut: 0.2,
  // ── DEV-394: the ride ───────────────────────────────────────────────────
  //
  // Each was measured on every HoverJet Ring Attack course and variant, over
  // the real ground, by the player's autopilot and the racers alike, against
  // the table in DEV-394's row: what a rider feels (rocking, weave, surging,
  // boost hunting, inversions), and that everybody still finishes.
  //
  // 0.6 of the path's lag allowed for. The linearised loop's damping goes from
  // 0.10 to about 0.5 with the pursuit gain and lead below; measured, the weave
  // (sign changes of the error across ±3 m) fell from 1.9 to 0.6 per km. 0.4
  // and 0.5 measure the same within noise; 1.0 goes back to oscillating.
  slipGain: 0.6,
  // Under this the velocity is a hover's or a launch's and says nothing.
  slipMinSpeed: 20,
  // A quarter of a second: half the airframe's own angular time constant
  // (1 / 1.95 s). Roll flips fell from 0.48 to 0.18 a second on the player's
  // autopilot. 0.3 measures the same; 0.4, tried on an earlier cut, doubled
  // the racers' ground contacts in the canyons.
  attitudeLeadSeconds: 0.25,
  // Trust fades over a quarter of each radius beyond it: 55 -> 69 m off the
  // line, 120 -> 150 m from a ring.
  trustRamp: 0.25,
  trustedProbeToAim: 1,
  // The certified line's own clearance, near enough: `int_01`'s line has a
  // minimum of 18 m and a quarter of it under 60. At 60 (off) the ride still
  // surged there — 118 thrust reversals a minute against 86 — and the laps
  // are 6 % slower for the player's autopilot and 10 % for the racers; at
  // 20-30 a speed-jet racer starts touching canyon walls.
  trustedClearance: 40,
  turnReach: true,
  // 80°: the loop guard, not a comfort limit. `adv_02`'s line itself climbs at
  // 67° and dives at 65°, and a 60° limit left racers unable to follow it —
  // they fell off the climb and looped trying to rejoin.
  pitchLimit: 1.4,
  // One target-speed of thrust per target-speed of error: the ship closes on
  // a new target with a time constant of 1 / (2 × drag), 0.42 s.
  speedGain: 1,
  // ±10 % of the unboosted engine either side of the boost switch.
  boostHysteresis: 0.1,
}

/**
 * The options the PLAYER's autopilot hands `routeGuidance` (DEV-524): the line,
 * no lane, off `tuning`. ONE place, so `boot/app.ts` and the tests that fly
 * the player's proxy (`tests/unit/player-autopilot-hairpin.test.ts`) cannot
 * disagree about them.
 *
 * It carries DEV-494's aim floor, `routeAimMinMetres`, which the literal it
 * replaced in `boot/app.ts` did not: the racers walked their aim out to 30 m
 * at a fold and the player's autopilot did not. On the line the player flies
 * the fold never parked it (it is the racers' LANE that puts the aim on the
 * ship, DEV-494), but on DEV-494's hairpin its aim came in to 11 m, where the
 * turn-reach law asks for a third of the speed it does at the floor. On every
 * shipped HoverJet line the player's aim stays 80 m+ away and the floor is
 * inert, bit for bit. See DEV-524.
 *
 * Allocates, as the literal it replaced did: one call a tick, for one ship.
 */
export const playerRouteOptions = (
  tuning: AutopilotTuning,
  speed: number,
  gateS: number,
  fallback: Vec3,
  beyond: Vec3 | null,
): RouteGuidanceOptions => ({
  speed,
  leadSeconds: tuning.routeLeadSeconds,
  leadMinMetres: tuning.routeLeadMinMetres,
  gateS,
  fallback,
  finalMetres: tuning.routeFinalMetres,
  curveGain: tuning.routeCurveGain,
  crossGain: tuning.routeCrossGain,
  beyond,
  minAimMetres: tuning.routeAimMinMetres,
})

export interface AutopilotBody {
  readonly position: Vec3
  readonly orientation: Quat
  readonly velocity: Vec3
  /**
   * World-frame angular velocity, rad/s — a `RigidBody`'s own. DEV-394's rate
   * terms read it; a body without one (a test's bare pose) is taken as not
   * rotating, which is the law as it was.
   */
  readonly angularVelocity?: Vec3
}

/** Scratch. Module-level, valid only inside one synchronous call. */
const _toTarget = v3()
const _local = v3()
const _inv: Quat = { x: 0, y: 0, z: 0, w: 1 }
const _rightBody = v3(1, 0, 0)
const _rightWorld = v3()
const _aim = v3()
const _nextLeg = v3()
const _pathBody = v3()
const _noseWorld = v3()
const _upWorld = v3()
const NO_ROTATION = v3()
const FORWARD_BODY = v3(0, 0, 1)
const UP_BODY = v3(0, 1, 0)

/**
 * The gate to fly at: the first one not yet passed.
 *
 * Returns -1 when the course is complete, which the caller reads as "hold
 * course" rather than "stop" — a finished run should coast, not fall out of the
 * sky mid-frame.
 */
export const nextGate = (gates: readonly Gate[], passed: readonly boolean[]): number => {
  for (let i = 0; i < gates.length; i++) if (!passed[i]) return i
  return -1
}

/**
 * One tick of pilot intent.
 *
 * `target` is a point in SIM (Unity) space. The caller picks it — normally the
 * next gate's sphere centre, which is exactly what `stepCourse` tests against,
 * so the autopilot and the scoring cannot disagree about where a ring is.
 */
/**
 * How far the ground is below the flight path, at its WORST over the look-ahead.
 *
 * Sampled along the current velocity rather than the nose, because what matters
 * is where the ship is actually going. Returns `Infinity` when there is no
 * terrain under any sample, which is most of this course — it is islands.
 *
 * (DEV-394 tried sampling along the NOSE as well, for a jet pitching hard at a
 * target below faster than its path follows. Braking for a target the jet
 * cannot turn onto — `turnReach` — removed the dive it was for, and the nose
 * probe then only added ground contacts on the speed jet. Measured, removed.)
 */
export const pathClearance = (
  body: AutopilotBody,
  fields: readonly HeightField[],
  lookAheadSeconds: number,
  samples = 6,
): number => {
  if (fields.length === 0) return Number.POSITIVE_INFINITY
  let worst = Number.POSITIVE_INFINITY
  for (let i = 1; i <= samples; i++) {
    const t = (i / samples) * lookAheadSeconds
    const px = body.position.x + body.velocity.x * t
    const py = body.position.y + body.velocity.y * t
    const pz = body.position.z + body.velocity.z * t
    // Pads read as solid to the ground: the autopilot flies as it always has
    // (Matt, 2026-10-05, SG-4). `py - highest` is `min(py - h)` to the bit.
    const clearance = py - highestGroundUnder(fields, px, pz, PADS_SOLID)
    if (clearance < worst) worst = clearance
  }
  return worst
}

export const autopilotActions = (
  body: AutopilotBody,
  target: Vec3,
  out: HoverJetInput,
  tuning: AutopilotTuning = DEFAULT_AUTOPILOT,
  terrain: readonly HeightField[] = [],
  /**
   * Metres from the AUTHORED RACING LINE, or Infinity when there is none.
   *
   * A trusted line is better evidence than a terrain probe: `CurvyClonePath` is
   * what 2016 designed the course around, it never enters the terrain (min AGL
   * 18 m over 421 samples), and **23 % of it sits below this controller's own
   * `minClearance` of 60 m**. So the probe and the line disagree about a quarter
   * of the course, and the line is the one that was flown.
   *
   * Near it, the pull-up therefore stops outranking the seek — the same rule the
   * gate already gets, for the same reason, applied continuously instead of only
   * within 120 m of a ring.
   */
  routeOffset = Number.POSITIVE_INFINITY,
  /**
   * The gate AFTER the one being flown at, or null for the last one.
   *
   * Used to slow down for a corner before arriving in it. See `cornerBrake`.
   */
  nextTarget: Vec3 | null = null,
  /**
   * Target speed from the racing line's VELOCITY PROFILE, or Infinity.
   *
   * The standard racing-AI answer, and structurally different from the corner
   * term below it: the profile is computed once per course by a backward braking
   * pass, so it knows to start slowing before the corner is in view. (This said
   * the jet decelerates at 5.3 m/s², so the braking began 1.6 km out. It sheds
   * 1.218 m/s every METRE with the throttle shut — `sim/route.ts`'s
   * `withSpeedProfile` — and the braking begins tens of metres out. DEV-394.)
   * Also used for other target speeds: the instructor's pace, a racer's ring
   * approach envelope and its missed-ring recovery.
   */
  targetSpeed = Number.POSITIVE_INFINITY,
  /**
   * The jet being flown, or null. DEV-394's speed law reads its thrust, its
   * chain and its boost multiplier; without it the law is the proportional
   * band it was, and boost has no dead band.
   */
  jet: HoverJet | null = null,
): HoverJetInput => {
  sub(_toTarget, target, body.position)

  // Aim THROUGH the gate: push the aim point further along the same bearing.
  // Cheap, and it is what stops the ship flattening out onto the rim.
  const distance = Math.hypot(_toTarget.x, _toTarget.y, _toTarget.z)
  if (distance > 1e-4) {
    const stretch = (distance + tuning.leadMetres) / distance
    _aim.x = _toTarget.x * stretch
    _aim.y = _toTarget.y * stretch
    _aim.z = _toTarget.z * stretch
  } else {
    _aim.x = 0
    _aim.y = 0
    _aim.z = 1
  }

  // Into the ship's own frame: +Z forward, +Y up, +X right.
  rotateVec3Inverse(_local, body.orientation, _aim)
  normalize(_local, _local)

  // Bearing and elevation, both signed, both in radians.
  const flat = Math.hypot(_local.x, _local.z)
  const bearing = Math.atan2(_local.x, _local.z)
  const elevation = Math.atan2(_local.y, flat)

  // ── DEV-394: the steering ──────────────────────────────────────────────
  //
  // The PATH's lag (`slipGain`), read off the body, so the law stays a pure
  // function of the state. This jet goes where it points only after the bleed
  // has turned the velocity round — a lag of about a quarter of a second behind
  // the nose — so pursuit on the nose alone keeps turning after the nose has
  // arrived, and the path overshoots: the ±25 m weave, a damping ratio of 0.1
  // on the linearised loop. `_pathBody` is the velocity's own bearing and
  // elevation off the nose; allowing for it asks for less turn while the path
  // is still catching up.
  //
  // (Damping on the nose's own RATE was the first thing tried, and it is
  // worse: it adds lag to a loop whose trouble is lag. Measured on the probe
  // and on the linearised loop alike.)
  rotateVec3Inverse(_pathBody, body.orientation, body.velocity)
  const pathSpeed = Math.hypot(_pathBody.x, _pathBody.y, _pathBody.z)
  const slipWeight = tuning.slipGain * clamp(pathSpeed / Math.max(1e-6, tuning.slipMinSpeed), 0, 1)
  const slipYaw = pathSpeed > 1e-6 ? Math.atan2(_pathBody.x, _pathBody.z) : 0
  const slipPitch =
    pathSpeed > 1e-6 ? Math.atan2(_pathBody.y, Math.hypot(_pathBody.x, _pathBody.z)) : 0
  // A slip past 45° is a ship going somewhere else entirely (a reset, a
  // hover); its direction says nothing about a lag.
  const eighth = Math.PI / 4
  const steerBearing = bearing + slipWeight * clamp(slipYaw, -eighth, eighth)
  const steerElevation = elevation + slipWeight * clamp(slipPitch, -eighth, eighth)

  // +yaw turns the nose RIGHT, and +x IS right, so this is not negated.
  const yaw = clamp(steerBearing * tuning.yawGain, -1, 1)
  // +pitch drops the nose, so wanting to climb (+y) means NEGATIVE pitch.
  let pitch = clamp(-steerElevation * tuning.pitchGain, -1, 1)

  // ── the ground ─────────────────────────────────────────────────────────
  //
  // Pull up when the PATH — not the nose — is heading into a hillside. Added to
  // the gate-seeking pitch and clamped, so it competes with the gate rather than
  // overriding it: a gate low on a ridge still gets flown at, just flatter.
  //
  // It only ever pulls UP. A ceiling term would be the other half of an
  // autopilot that holds an altitude, and this is not that — it is a seeker that
  // declines to fly through mountains.
  //
  // ── How far to TRUST the air, 0..1 (DEV-394) ───────────────────────────
  //
  // Trusted airspace is on final approach to a gate, or close to the authored
  // line — both places 2016 certified by flying through them (below). It was a
  // STEP at each edge, so a racer in an outer lane crossing 55 m off the line
  // switched between two laws in a tick. With `trustRamp` the trust falls away
  // over that fraction of the radius BEYOND the edge instead, and the ground
  // rule blends with it. Beyond, not inside: a ramp inside took trust away
  // from air the step had trusted, and `rookie_01`'s start — released 118 m
  // from ring 0, inside the 120 — lost it, took the full pull-up off the pad,
  // overflew the ring and chased it through an outside loop.
  const trustOf = (metres: number, within: number): number =>
    tuning.trustRamp > 0
      ? clamp((within * (1 + tuning.trustRamp) - metres) / (within * tuning.trustRamp), 0, 1)
      : metres < within
        ? 1
        : 0
  const trust = Math.max(
    trustOf(distance, tuning.gateOverrideMetres),
    trustOf(routeOffset, tuning.routeTrustMetres),
  )
  // ── And in trusted air, the probe reaches only as far as the AIM ───────
  //
  // The probe extrapolates the velocity in a straight line, and on the line
  // that is only true as far as the aim: past it the ship follows the line's
  // curve. On `int_01` the line dips into valleys whose floors a straight
  // 2.5 s extrapolation runs into, so a ship ON the certified line read its
  // own descent as a collision course and cut its boost — at 400 m of air.
  // Cut back to the aim, a real dive into the ground is still seen: at 60 m/s
  // and 45° the time to the aim still drops the path 40 m.
  //
  // Never shorter than the route's own lead, though — as far as the aim
  // normally sits. Right over a ring or a finish the aim is metres away, and a
  // probe that looked 0.1 s ahead there flew a 150 m/s dive into the ground
  // without seeing it.
  const speedAlong = Math.hypot(body.velocity.x, body.velocity.y, body.velocity.z)
  const toAim = clamp(
    distance / Math.max(1, speedAlong),
    Math.min(tuning.routeLeadSeconds, tuning.lookAheadSeconds),
    tuning.lookAheadSeconds,
  )
  const reach =
    tuning.lookAheadSeconds - (tuning.lookAheadSeconds - toAim) * trust * tuning.trustedProbeToAim
  const clearance = pathClearance(body, terrain, reach, tuning.clearanceSamples)
  // ── And holds the LINE's clearance, not its own, in trusted air ────────
  //
  // `minClearance` is 60 m and a quarter of `int_01`'s certified line flies
  // lower — its minimum is 18 m — so a ship exactly on the line read "too low"
  // for a quarter of the lap and shed its boost for it: the surge again, a
  // slower one. In trusted air the floor falls toward `trustedClearance`, the
  // line's own; a path that runs INTO the ground is still under any floor.
  const floor =
    tuning.trustedClearance < tuning.minClearance
      ? tuning.minClearance - (tuning.minClearance - tuning.trustedClearance) * trust
      : tuning.minClearance
  // Urgency ramps 0 -> 1 as the shortfall grows. Zero when there is room.
  const urgency = clearance < floor ? clamp((floor - clearance) / floor, 0, 1) : 0
  if (urgency > 0) {
    // ── Priority, EXCEPT on final approach to a gate ────────────────────
    //
    // `Math.min` means a gate-seek that wants to dive cannot cancel the pull-up.
    // That is right in open country — an additive nudge was the first attempt
    // and it only halved the strikes, because diving at a gate on the far side
    // of a ridge produces a positive pitch big enough to swallow it.
    //
    // It is WRONG within reach of the gate, and that is what cost twenty
    // seconds a lap. `int_01`'s gate 6 sits **23 to 112 m above the terrain**
    // against a `minClearance` of 60, so closing on it raises the urgency to 1
    // and pins pitch at the stop. Telemetry of one stall: pitch at -1.00 for
    // **30 of 39 samples** over ten seconds, distance to the gate oscillating
    // between 23 and 98 m and never closing. The ship orbited it.
    //
    // The comment this replaces claimed "a gate low on a ridge still gets flown
    // at, just flatter". At full urgency it gets flown OVER.
    //
    // A gate is a certified-clear waypoint: 2016 put a ring there, so the air at
    // it is flyable by construction. Inside `gateOverrideMetres` the pull-up
    // therefore goes back to being a nudge, and the seek is allowed to win.
    // Trusted airspace: on final approach to a gate, or close to the authored
    // line. Both are places 2016 certified by flying through them.
    const nudged = clamp(pitch - urgency * tuning.gateOverrideNudge, -1, 1)
    const priority = Math.min(pitch, -urgency)
    // DEV-394: trusted air is trusted as far as the AIM, which is as far as
    // the probe now looks in it (`trustedProbeToAim`). A path that runs INTO
    // the ground before it gets there is not flying the certified air, and
    // takes the priority pull-up: measured, a 300 m/s run home diving at a
    // finish sphere's centre, nudged rather than pulled, into the ground.
    const held = tuning.trustedProbeToAim > 0 && clearance < 0 ? 0 : trust
    // Exact at both ends: `a + (b - a) × 1` is not always `b` in floating point.
    pitch = held >= 1 ? nudged : held <= 0 ? priority : priority + (nudged - priority) * held
  }

  // ── DEV-394: never a loop ──────────────────────────────────────────────
  //
  // A target that ends up under the ship — overflown, or a ring low beside a
  // climb — is chased by pitching at it, and pitching at something below and
  // then behind is an outside loop through the vertical: measured off
  // `rookie_01`'s pad, 180° of bank the rider takes upside down. A pilot does
  // not push over past a dive; he turns. So the pitch that would steepen the
  // nose fades out over the last quarter of `pitchLimit`, whichever way up the
  // ship is (+pitch moves the nose AWAY from the ship's up), and the yaw is
  // left to bring the target round.
  if (tuning.pitchLimit > 0) {
    rotateVec3(_noseWorld, body.orientation, FORWARD_BODY)
    rotateVec3(_upWorld, body.orientation, UP_BODY)
    // Where the nose WILL be: the airframe's own angular drag carries a
    // rotation on for half a second after the stick lets go, and a limit read
    // off the nose as it is let a 1.4 rad/s pitch-over run from 60° on to 80°.
    // d(nose)/dt = ω × nose, whose y is how fast the nose is rising.
    const spin = body.angularVelocity ?? NO_ROTATION
    const noseRate = spin.z * _noseWorld.x - spin.x * _noseWorld.z
    const attitude = Math.asin(clamp(_noseWorld.y + tuning.attitudeLeadSeconds * noseRate, -1, 1))
    // Which way this pitch moves the nose's elevation: +pitch drives it
    // toward -up.
    const steepening = -pitch * _upWorld.y * attitude > 0
    if (steepening) {
      const room = (tuning.pitchLimit - Math.abs(attitude)) / (tuning.pitchLimit * 0.25)
      pitch *= clamp(room, 0, 1)
    }
  }

  // Roll: hold the wings level, banked into the turn. `right.y` is how far the
  // right wing is above horizontal; +roll raises it further, so correcting a
  // raised wing takes negative roll.
  conjugate(_inv, body.orientation)
  rotateVec3Inverse(_rightWorld, _inv, _rightBody)
  const wantRightY = clamp(-yaw * tuning.bankRatio, -tuning.maxBank, tuning.maxBank)
  // DEV-394: held where the wing WILL be `attitudeLeadSeconds` on, not where it
  // is. The roll had no damping but the airframe's own (a 0.5 s angular drag),
  // so every change of bank overshot and came back: the rocking a rider feels
  // most. d(right)/dt = ω × right, whose y is how fast the right wing rises.
  // (Banking by the ship's measured TURN RATE instead of the stick was tried
  // too: under the pitch limit above it fed a turn back into more bank, and
  // rolled racers through 180° on `adv_02`.)
  const w = body.angularVelocity ?? NO_ROTATION
  const rightYRate = w.z * _rightWorld.x - w.x * _rightWorld.z
  const roll = clamp(
    -(_rightWorld.y + tuning.attitudeLeadSeconds * rightYRate - wantRightY) * tuning.rollGain,
    -1,
    1,
  )

  // Throttle by alignment. `_local.z` is the cosine of the angle off the nose,
  // so this is full ahead when pointed at the gate and eased when not.
  //
  // ── Eased for the CORNER, before arriving in it ────────────────────────
  //
  // Matt: *"don't forget to adjust speed on approach to the gate if the
  // following gate exceeds a threshold where full speed makes them crash."*
  //
  // Nothing in this controller looked past the gate it was flying at, so it
  // arrived at every ring at whatever speed the straight before it allowed and
  // then discovered the turn. That is the root of the corner-cutting: a pursuit
  // follower carrying too much speed into a bend flies the chord, which is how
  // the ship ended up 25 m off the line at a gate with a 22.6 m trigger.
  //
  // The turn is the angle between "where I am going" and "where I go next",
  // which needs the gate after this one. It is weighted by PROXIMITY so a hairpin
  // two kilometres away costs nothing and the same hairpin a second out costs
  // most of the throttle — braking early is just being slow.
  let corner = 0
  if (nextTarget) {
    sub(_nextLeg, nextTarget, target)
    const legLen = Math.hypot(_nextLeg.x, _nextLeg.y, _nextLeg.z)
    if (legLen > 1e-4 && distance > 1e-4) {
      const cos =
        (_toTarget.x * _nextLeg.x + _toTarget.y * _nextLeg.y + _toTarget.z * _nextLeg.z) /
        (distance * legLen)
      // 0 for straight on, 1 for a hairpin.
      const turn = Math.acos(Math.max(-1, Math.min(1, cos))) / Math.PI
      const speed = Math.hypot(body.velocity.x, body.velocity.y, body.velocity.z)
      const brakeFrom = Math.max(1, speed * tuning.cornerBrakeSeconds)
      const proximity = clamp(1 - distance / brakeFrom, 0, 1)
      corner =
        clamp((turn - tuning.cornerBrakeTurn) / (1 - tuning.cornerBrakeTurn), 0, 1) * proximity
    }
  }

  // ── And eased AGAIN when it is about to hit something ──────────────────
  //
  // Pulling up was the whole of the ground response and it was not enough. The
  // telemetry of the gate-6 stall, half a second per row:
  //
  //     t     dist speed  clear  pitch  y
  //     18.1   125   188     92   1.00  516   diving at the gate
  //     18.6    45   185    -55  -1.00  466   clearance negative, full pull-up
  //     19.1    48   146   -202  -1.00  394   still 202 m below its own path
  //     19.6    95    11      0  -1.00  353   185 -> 11 m/s. It hit the hill.
  //
  // The pull-up was already saturated at -1 and the ship still went in, because
  // at 185 m/s a pitch rate cannot bend the path fast enough. Then the collision
  // scrubbed the speed and the run lost TWENTY SECONDS climbing back out.
  //
  // Slowing down is what buys the pull-up its time, and it compounds: the
  // lookahead is a TIME, so a slower ship also samples the ground ahead more
  // finely. Boost goes first because it is worth ~2x the speed.
  // The profile, held as a simple proportional band: at or under the target,
  // nothing; a band above it, closed. It outranks the corner term because it is
  // the same physics computed properly, and `Math.min` means whichever wants
  // less throttle wins.
  const speedNow = Math.hypot(body.velocity.x, body.velocity.y, body.velocity.z)
  // Floored at `minThrottle` so a misaligned ship keeps airspeed to turn with,
  // capped at `maxThrottle` so a handicapped racer stays handicapped even when
  // it is pointed straight at the gate.
  const aligned = clamp(_local.z, tuning.minThrottle, tuning.maxThrottle)
  const eased = (1 - urgency * tuning.clearanceBrake) * (1 - corner * tuning.cornerBrakeMax)

  // ── DEV-394: the speed law, when the jet is known ──────────────────────
  //
  // The band above is proportional with nothing to hold a speed WITH, and
  // boost is a switch: a chained jet boosted out-runs the profile's top and
  // unboosted falls under it, so the band's boost cut flipped at ~5 Hz and the
  // engine note fluttered. So: work in THRUST, one unit being this jet's full
  // unboosted thrust with its chain as it is now, whose terminal speed is
  // `cruise`. Thrust `u` holds `u × cruise` (Unity's drag is linear), so the
  // thrust that holds a target is `target / cruise`, and `speedGain` more per
  // target-speed of error closes on it. Boost then only says whether `u` needs
  // more than the unboosted engine has, and the throttle makes up the rest, so
  // the THRUST is continuous across the switch; the dead band keeps the switch
  // from chattering. Whether boost was lit last tick is read off the engine
  // itself (thrust over the unboosted ceiling), so the law keeps no memory;
  // without the jet there is no telling, and no dead band.
  const ceiling = jet ? chainedMaxSpeed(jet.chain, jet.chainSpec, jet.tuning.maxSpeed) : 0
  const wasBoosted = jet !== null && jet.currentThrust > ceiling
  const band = jet ? tuning.boostHysteresis : 0
  // Each boost cut's threshold, moved by the dead band away from the side the
  // engine was on, so a signal sitting on a threshold cannot flick it.
  const slack = wasBoosted ? 1 + band : 1 - band
  const cutsClear =
    urgency < tuning.boostCutUrgency * slack && corner < tuning.cornerBoostCut * slack
  let throttle: number
  let boostLit: boolean
  if (jet && tuning.speedGain > 0) {
    const multiplier = jet.tuning.boostMultiplier
    const cruise = cruiseSpeed(jet.sheet, ceiling)
    // Boost's EXTRA thrust fades out as the ground or the corner approaches
    // the threshold that used to switch it off, so the thrust is continuous
    // in both: a switch there, fed back through the probe's speed-scaled
    // reach, was the surge.
    const share = tuning.boost
      ? clamp(1 - urgency / tuning.boostCutUrgency, 0, 1) *
        clamp(1 - corner / tuning.cornerBoostCut, 0, 1)
      : 0
    // The stick as the band would hold it, in thrust.
    let u = aligned * eased * (1 + (multiplier - 1) * share)
    // ── Can it still MAKE the target at this speed? ──────────────────────
    //
    // A point `distance` away and θ off the flight path is reached by an arc
    // of radius `distance / (2 sin θ)`, and this jet turns its path no faster
    // than its full-stick yaw rate, so the arc is flyable at up to that rate
    // times the radius. Faster, and it flies past and comes back the long way.
    // Measured: a chained jet at 290 m/s, on the run home with no corner to
    // brake for, missed `adv_02`'s finish sideways and flew into the ground
    // turning back for it.
    let want = targetSpeed
    if (tuning.turnReach && speedNow > 1 && distance > 1e-4) {
      const along =
        (body.velocity.x * _toTarget.x +
          body.velocity.y * _toTarget.y +
          body.velocity.z * _toTarget.z) /
        (speedNow * distance)
      // Past 90° it is a U-turn: `sin` is 1.
      const sin = along < 0 ? 1 : Math.sqrt(Math.max(0, 1 - along * along))
      const rate = fullStickRate(jet.tuning.yawRate, jet.sheet.rigidbody.angularDrag)
      const reachable = (rate * distance) / (2 * Math.max(sin, 1e-6))
      if (reachable < want) want = reachable
    }
    if (Number.isFinite(want) && cruise > 0) {
      const hold = (want + tuning.speedGain * (want - speedNow)) / cruise
      if (hold < u) u = hold > 0 ? hold : 0
    }
    boostLit = share > 0 && u > (wasBoosted ? 1 - band : 1 + band)
    throttle = clamp(boostLit ? u / multiplier : u, 0, 1)
  } else {
    // The band, as it was: at or under the target, nothing; a band above it,
    // closed; `Math.min` with the corner so whichever wants less wins.
    const overSpeed = Number.isFinite(targetSpeed)
      ? clamp((speedNow - targetSpeed) / tuning.profileBand, 0, 1)
      : 0
    const braking =
      (1 - urgency * tuning.clearanceBrake) *
      Math.min(1 - corner * tuning.cornerBrakeMax, 1 - overSpeed * tuning.profileBrakeMax)
    throttle = clamp(aligned * braking, 0, 1)
    boostLit = tuning.boost && cutsClear && overSpeed < tuning.profileBoostCut
  }

  out.pitch = pitch
  out.yaw = yaw
  out.roll = roll
  out.throttle = throttle
  // Boost HELD, because that is what a 2016 player did.
  //
  // This used to be false, on the reasoning that boost is free (DEV-002) and
  // holding it would make every run a best case rather than a representative
  // one. The ghosts refute that. `int_01_leftSpawn_fast_01` spends **90 % of its
  // run above 120 m/s**, and the ship cannot exceed 89.8 m/s without boost — so
  // the recording is of someone holding it essentially the whole way. A free
  // button that is never released is not an optional extra; it is the cruise
  // setting, and an autopilot that declines it is the unrepresentative one.
  //
  // It also matters for what you SEE: `boostEffects` is gated at 120 m/s, so
  // without this the speed FX never fire and the demo shows a game that has
  // none.
  //
  // ── Except when it is about to hit a hill ──────────────────────────────
  //
  // Boost is worth roughly 2x the speed, so releasing it is the single biggest
  // thing the controller can do to buy its pull-up time. It goes at a LOWER
  // urgency than the throttle taper because it is free to get back: unlike
  // altitude, speed costs nothing to recover once the ground is behind you.
  out.boost = boostLit
  out.brake = false
  return out
}
