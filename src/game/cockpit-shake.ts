// src/game/cockpit-shake.ts — the buffet, as a pure function of speed and time.
//
// ── The Squadrons rule: the COCKPIT shakes, the camera never does ─────────
//
// docs/plan/ANNIVERSARY.md §2.4. Star Wars: Squadrons is the closest shipped
// comparison to this game — cockpit-only, VR, fast — and its developers were
// explicit about the technique: the *cockpit* vibrates around the camera rather
// than the camera shaking, so speed and damage read while the head stays
// anchored. Shaking the camera shakes the WORLD around a stationary head, which
// is the exact stimulus the comfort block exists to limit (DEV-058); shaking the
// vehicle around a stationary head is the opposite of that, and it is the same
// argument `sim/art-lean.ts` already makes for the lean (DEV-010).
//
// So this module produces a POSE, and the only thing that may ever wear it is
// the `art_pivot` node — the one the cockpit art hangs off and the camera does
// NOT inherit. `game/flight.ts` composes it after the lean, on the same pivot,
// in the same call; `render(alpha, camera, rig)` derives the eye from `object`
// and the body alone, so the rig is structurally out of reach from here.
//
// ── Why this file is THREE-free, DOM-free and has no clock ────────────────
//
// It is not sim code — it reads render time, so it could never live under
// `src/sim/` (hard rule 5) — but it is written to the same discipline for a
// smaller reason: it is a signal, and a signal you can call from a node test
// with a time and a speed is a signal you can assert bounds on. `time` and
// `forwardSpeed` are arguments, never read from a clock or a body. DEV-426's
// `readShakeEngine` reads a jet's ENGINE (its spooled thrust and its chain),
// which is sim state, and still nothing with a clock in it.
//
// ── Every number is in the preset ────────────────────────────────────────
//
// Hard rule 6 and ANNIVERSARY.md §0.2: the tuning lives in
// `content/editions/*.json` and `src/` reads it. Nothing below is a tunable
// literal. The two numbers that ARE here are not tuning:
//
//   · the boost-stage thresholds, imported from the constants sheet, because
//     they are 2016's and retyping 120/240/350 is what hard rule 3 forbids;
//   · `GOLDEN_ANGLE`, which decorrelates the five channels' phases. It is a
//     mathematical constant, not a dial — there is no value of it anyone would
//     ever want to change, and a preset key for it would be noise.

import type { EditionCockpitShake, EditionShakeThrottle } from '@/content/edition-schema'
import { HOVERJET } from '@/generated/constants.generated'
import { cruiseSpeed, type HoverJet } from '@/sim/hoverjet'
import { chainedMaxSpeed } from '@/sim/speed-chain'

/**
 * The three boost-stage floors, off the shipped prefab.
 *
 * **Imported, never retyped.** `hoverjet.ship.minBoostEffect*` are
 * `trust: verified`, `origin: shipped-prefab`, and the C# initialisers for the
 * first two are wrong by a factor of four (see `game/particle-fx.ts`). The shake
 * steps where the particles step for one reason: they are the same event. A
 * buffet that grew at 200 while the boost plume lit at 240 would read as two
 * unrelated effects. DEV-069's lesson in one line — when the sheet has a key for
 * the thing you are implementing, import the key and assert against it.
 */
export const BOOST_STAGE_SPEEDS: readonly [number, number, number] = [
  HOVERJET.ship.minBoostEffectsSpeed,
  HOVERJET.ship.minBoostEffect_stage2_speed,
  HOVERJET.ship.minBoostEffect_stage3_speed,
]

/** 0 below the first boost floor, then 1, 2, 3. Indexes `shake.stageGain`. */
export type BoostStage = 0 | 1 | 2 | 3

/**
 * Which boost stage a forward speed is in.
 *
 * The same ladder `Ship_HoverShip.Update()` walks, and the same one
 * `particle-fx.ts` derives for the plume: exactly one stage at a time, floors
 * exclusive-below (`< MIN` is the stage under it), so a ship sitting exactly on
 * 240 is in stage 2 the way the prefab's `>=` test puts it there.
 *
 * Both vehicles use this ladder. The JumpSeat's own prefab carries no boost
 * systems at all — no `minBoostEffect*`, no speed chain — so in practice it
 * never leaves stage 0; the alternative, a second ladder invented for a vehicle
 * 2016 gave none, would be a number with no provenance. See DEV-083.
 */
export const boostStage = (forwardSpeed: number): BoostStage => {
  const [one, two, three] = BOOST_STAGE_SPEEDS
  if (forwardSpeed < one) return 0
  if (forwardSpeed < two) return 1
  if (forwardSpeed < three) return 2
  return 3
}

/**
 * The pose the pivot wears, on top of the lean.
 *
 * Metres and RADIANS — the lean is in Unity degrees because `Rotator_Input` is,
 * and this is not ported from anything, so it is in the unit the renderer takes.
 * Mutable and owned by the caller: one sample per `Flight`, never a module-level
 * scratch shared between them. Trap 19 is a racer flying on the other racer's
 * stick because exactly that was shared.
 */
export interface CockpitShakeSample {
  x: number
  y: number
  z: number
  /** About the ship's forward axis. The lean's roll axis. */
  roll: number
  /** About the ship's pitch axis. The lean's pitch axis. */
  pitch: number
}

export const createShakeSample = (): CockpitShakeSample => ({
  x: 0,
  y: 0,
  z: 0,
  roll: 0,
  pitch: 0,
})

export const zeroShakeSample = (out: CockpitShakeSample): CockpitShakeSample => {
  out.x = 0
  out.y = 0
  out.z = 0
  out.roll = 0
  out.pitch = 0
  return out
}

/**
 * How hard the air is hitting, 0..1, from forward speed alone.
 *
 * Zero at and below `startSpeed` — **and flat there**, because the ramp is
 * squared: value and slope are both 0 at the threshold, so crossing it fades in
 * rather than popping on. That is the whole reason for the square; that it also
 * makes the buffet grow with the square of speed, the way dynamic pressure does,
 * is the physics agreeing with the ergonomics rather than the source of the
 * choice.
 *
 * Clamped to 1 at `fullSpeed`, above which the stage gain carries it — see
 * `cockpitShakeGain`.
 */
export const shakeSpeedRamp = (shake: EditionCockpitShake, forwardSpeed: number): number => {
  const span = shake.fullSpeed - shake.startSpeed
  if (!(span > 0)) return 0
  const t = (forwardSpeed - shake.startSpeed) / span
  if (t <= 0) return 0
  return t >= 1 ? 1 : t * t
}

/** Metres and radians: the peak excursion this speed, stage and slider allow. */
export interface CockpitShakeGain {
  /** Metres. The ceiling on |x|, |y| and |z|. */
  readonly translate: number
  /** Radians. The ceiling on |roll| and |pitch|. */
  readonly rotate: number
}

const NO_GAIN: CockpitShakeGain = { translate: 0, rotate: 0 }

/**
 * The amplitude, before the waveform.
 *
 * Four multiplicands and any one of them being zero is a hard off:
 *
 *   · `enabled` — the preset. **Classic is zero here, always** (§0: every
 *     Classic flag off), and Classic's amplitudes are zero as well, so a
 *     hand-flipped flag still draws nothing.
 *   · `scale` — the `speedFx` comfort slider resolved to 0 / 0.5 / 1. The shake
 *     is a speed effect and ANNIVERSARY.md §2.6 is categorical: the features
 *     that create a sense of speed are the features that make people ill, so
 *     they move together on ONE slider or the slider is a lie.
 *   · the speed ramp — below `startSpeed` there is no air.
 *   · the stage gain — the preset's per-stage step.
 *
 * `scale` multiplies LINEARLY and that is load-bearing: `light` has to be half,
 * not "a bit less" (see `SPEED_FX_SCALE` in `game/edition.ts`).
 */
export const cockpitShakeGain = (
  shake: EditionCockpitShake,
  scale: number,
  forwardSpeed: number,
  engineGain = 1,
): CockpitShakeGain => {
  if (!shake.enabled || !(scale > 0) || !(engineGain > 0)) return NO_GAIN
  const ramp = shakeSpeedRamp(shake, forwardSpeed)
  if (ramp <= 0) return NO_GAIN
  const stage = shake.stageGain[boostStage(forwardSpeed)] ?? 0
  const k = ramp * stage * scale * engineGain
  return { translate: shake.amplitude * k, rotate: shake.angle * k }
}

// ── DEV-426: the buffet follows the ENGINE as well as the speed ───────────
//
// Matt, 2026-09-26: *"0.6x the current jitter at full throttle and then 1x the
// jitter at boost, and then fade back to 0.8x jitter once at top speed.
// (multiplier is amplitude, not speed)"*. His three numbers are
// `cockpit.shake.throttle` in the preset, and they multiply the buffet above —
// the speed ramp and the stage gain are untouched, so "the current jitter" is
// exactly what they multiply.
//
// The words, as the engine states they mean:
//
//   · FULL THROTTLE is the engine at its full-throttle thrust, unboosted. The
//     weight holds there for any throttle below it too: the buffet is keyed on
//     speed, which already falls when the throttle does, and nothing he said
//     asks for a second fade.
//   · BOOST is the engine at `boostMultiplier` times that. The weight between
//     the two is the SPOOLED thrust, not the button — `stepHoverJet` walks the
//     thrust toward the demand at the prefab's `acceleration`, 0.25 s from full
//     throttle to a full boost at no chain — so it follows the engine both
//     ways and never pops. A partly paid boost (DEV-410's empty tank) spools to
//     part of the way, and weighs part of the way.
//   · TOP SPEED is the chain's LIVE terminal: where the jet settles boosted on
//     the gates it has banked, 180 m/s at none and ~335 at twenty-one (Matt's
//     answer 3, `sim/speed-chain.ts`). The fade runs over the speed the boost
//     ADDS — from the live unboosted terminal, where a boost from full throttle
//     starts, to that one — linear in speed, so the ship's own approach shapes
//     it in time: most of the fade in the first second, the last of it as the
//     speed settles.
//
// So, with b the boost weight and p the fade, both 0..1:
//
//     gain = fullThrottle + (boost + (topSpeed − boost)·p − fullThrottle) · b
//
// With DEV-426's numbers: 0.6 unboosted whatever the speed; 1 at the instant a
// boost spools up from cruise; 0.8 at the boosted terminal.
// `tests/unit/cockpit-shake.test.ts` holds the function to those corners and
// flies a real `stepHoverJet` through all three.
//
// DEV-528 (Matt, 2026-09-29: *"old jitter was better. (before my
// suggestion)"*) SHIPS 1 / 1 / 1, which is a weight of exactly 1 everywhere and
// the buffet as DEV-083 built it. The curve stays for him to shape: `?lookdev=1`
// has the three weights (`boot/lookdev-shake.ts`).

/**
 * What the throttle curve reads off the engine. Plain numbers, filled per frame
 * by {@link readShakeEngine} and owned by the caller: one per flight, never a
 * module-level scratch (trap 19).
 */
export interface ShakeEngine {
  /**
   * The SPOOLED thrust over the live full-throttle thrust (`maxSpeed` plus the
   * chain): 0 idle, 1 full throttle, `boostMultiplier` a full boost.
   */
  thrustRatio: number
  /** The jet's thrust multiplier on boost. 2 on the shipped prefab. */
  boostMultiplier: number
  /** M/S. Where the jet settles at full throttle, unboosted, on the live chain. */
  cruiseSpeed: number
  /** M/S. Where it settles boosted on the live chain: "top speed". */
  topSpeed: number
}

export const createShakeEngine = (): ShakeEngine => ({
  thrustRatio: 0,
  boostMultiplier: 1,
  cruiseSpeed: 0,
  topSpeed: 0,
})

/** 0..1, and 0 for a NaN — a hole must not reach the pivot as a NaN. */
const unit = (x: number): number => (x > 0 ? (x < 1 ? x : 1) : 0)

/** How far the engine is from full throttle to a full boost, 0..1. */
export const boostWeight = (engine: ShakeEngine): number =>
  engine.boostMultiplier > 1 ? unit((engine.thrustRatio - 1) / (engine.boostMultiplier - 1)) : 0

/** How far the speed is from the live unboosted terminal to the boosted one, 0..1. */
export const topSpeedWeight = (engine: ShakeEngine, forwardSpeed: number): number =>
  engine.topSpeed > engine.cruiseSpeed
    ? unit((forwardSpeed - engine.cruiseSpeed) / (engine.topSpeed - engine.cruiseSpeed))
    : 0

/**
 * The buffet's multiplier for what the engine is doing — the curve in the
 * header. 1 when there is no curve (a preset without `throttle`, which is
 * Classic) or no engine to read (the JumpSeat and the glider).
 */
export const throttleShakeGain = (
  throttle: EditionShakeThrottle | undefined,
  engine: ShakeEngine | null,
  forwardSpeed: number,
): number => {
  if (!throttle || !engine) return 1
  const b = boostWeight(engine)
  const p = topSpeedWeight(engine, forwardSpeed)
  const boosting = throttle.boost + (throttle.topSpeed - throttle.boost) * p
  return throttle.fullThrottle + (boosting - throttle.fullThrottle) * b
}

/**
 * The HoverJet's engine, as {@link throttleShakeGain} reads it, into `out`.
 *
 * Every number off the jet's OWN sheet and chain, so an aircraft variant
 * (DEV-380) buffets against its own terminals rather than 2016's; the
 * terminals are `cruiseSpeed`'s fixed-step fixed point, the speed the ship
 * actually reaches.
 */
export const readShakeEngine = (jet: HoverJet, out: ShakeEngine): ShakeEngine => {
  const full = chainedMaxSpeed(jet.chain, jet.chainSpec, jet.tuning.maxSpeed)
  const m = jet.tuning.boostMultiplier
  out.thrustRatio = full > 0 ? jet.currentThrust / full : 0
  out.boostMultiplier = m
  out.cruiseSpeed = cruiseSpeed(jet.sheet, full)
  out.topSpeed = cruiseSpeed(jet.sheet, full * m)
  return out
}

/**
 * The phase spread between channels.
 *
 * π(3 − √5), the golden angle: the irrational that spreads N points around a
 * circle more evenly than any rational could, which is exactly what is wanted
 * from a set of phases that must not line up. Five channels × three frequencies
 * is fifteen phases, and with a rational step some pair of them would land on
 * top of each other and two axes would move as one.
 *
 * A constant of the maths, not of the game. It has no business in the preset.
 */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

const TAU = Math.PI * 2

/**
 * One channel of the waveform, in -1..1.
 *
 * The mean of the preset's sines, each with its own phase. The MEAN, not the
 * sum — so the amplitude the preset asks for is a true ceiling and the bounds
 * test can be an assertion rather than an estimate. (The cost is that the peak
 * is rarely reached: three sines averaged have an RMS of about 0.41, so the
 * felt size is well under the stated maximum. That is the right way round for a
 * thing whose failure mode is "too much".)
 *
 * Deterministic in `time`, and continuous: no `Math.random()` anywhere, so two
 * frames a millisecond apart differ by a millisecond's worth of motion rather
 * than by a fresh draw. A per-frame random jitter at 72 Hz reads as a strobe,
 * not as air.
 */
const channel = (frequency: readonly number[], channelIndex: number, time: number): number => {
  const n = frequency.length
  if (n === 0) return 0
  let sum = 0
  for (let j = 0; j < n; j++) {
    const f = frequency[j] ?? 0
    sum += Math.sin(TAU * f * time + GOLDEN_ANGLE * (channelIndex * n + j))
  }
  return sum / n
}

/** The five channels, in the order their phases are assigned. */
const CH_X = 0
const CH_Y = 1
const CH_Z = 2
const CH_ROLL = 3
const CH_PITCH = 4

/**
 * Sample the buffet into `out`.
 *
 * `active` is the caller's answer to "is this ship in moving air": false in the
 * hangar, false while the pause menu is up (the run is frozen and so is the
 * air), false for the whole elevator ride. It is a separate argument rather than
 * something inferred from speed because all three of those cases can have a
 * non-zero body velocity and none of them should move the cockpit.
 *
 * `time` is RENDER seconds. This is visual only — the same argument the waves
 * and the particles make in `boot/app.ts`, and the same one DEV-011 makes in the
 * other direction for the lean: the lean is on the fixed step because a ghost
 * has to replay it, and nothing replays this.
 *
 * `jolt` is a HIT on top of the buffet (the DEV-364 follow-up: a racer struck
 * the player), in multiples of the preset's `amplitude` and `angle`, already
 * shaped over time by the caller (`game/racer-hit.ts`'s `hitJoltGain`). It runs
 * through the SAME waveform and the same two hard offs — the preset's flag and
 * the comfort slider, linearly — so a hit is the cockpit's own shake, harder
 * for a moment, and never the camera's. It is not scaled by speed: a hit at
 * 30 m/s is felt as surely as one at 300.
 *
 * `engineGain` is DEV-426's {@link throttleShakeGain}: it multiplies the
 * buffet and NOT the jolt, because a hit is not the engine. Absent is 1, which
 * is what the JumpSeat passes — it has no throttle, no boost and no chain.
 */
export const sampleCockpitShake = (
  out: CockpitShakeSample,
  shake: EditionCockpitShake,
  scale: number,
  time: number,
  forwardSpeed: number,
  active: boolean,
  jolt = 0,
  engineGain = 1,
): CockpitShakeSample => {
  if (!active) return zeroShakeSample(out)
  const gain = cockpitShakeGain(shake, scale, forwardSpeed, engineGain)
  const k = shake.enabled && scale > 0 && jolt > 0 ? jolt * scale : 0
  const translate = gain.translate + shake.amplitude * k
  const rotate = gain.rotate + shake.angle * k
  if (translate <= 0 && rotate <= 0) return zeroShakeSample(out)
  const f = shake.frequency
  out.x = translate * channel(f, CH_X, time)
  out.y = translate * channel(f, CH_Y, time)
  out.z = translate * channel(f, CH_Z, time)
  out.roll = rotate * channel(f, CH_ROLL, time)
  out.pitch = rotate * channel(f, CH_PITCH, time)
  return out
}
