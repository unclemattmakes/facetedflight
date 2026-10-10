// src/sim/instructor.ts — the flight instructor: a racer that leads you, and
// waits for you. DEV-376.
//
// Matt, 2026-09-24: *"want to learn to fly - add an ai-pilot flight instructor
// course through the canyon"*. `docs/plan/FLIGHT-INSTRUCTOR.md` §4 is the design;
// §11 is Matt's calls (it HOVERS beside the next ring when it waits).
//
// ── It is an `AiRacer`, and this file is the two things no racer has ──────
//
// Same body, flight model, controller, ground contact, crash rule and prop rule
// as every racer (`ai-racer.ts`), because DEV-026's point was ONE controller.
// What it gains is a nullable `pace` on the racer, and this file is all of it:
//
//   1. THE PACE LAW. `gap` is the instructor's arc length on the racing line
//      minus the student's (the caller measures the student's, with
//      `game/race-place.ts`'s `raceProgress`; `sim/` never imports `game/`).
//
//          target = clamp(v_student − gain × (gap − lead), 0, maxSpeed)
//
//      then the line's own braking profile on top, exactly as the player's
//      autopilot reads it. Too far ahead and it slows, too close and it speeds
//      up, up to the step's cap. It is handed to `autopilotActions`'s existing
//      `targetSpeed` — AND, as a feed-forward, to the tuning's existing
//      `maxThrottle` (see `paceTuning`). The second is not in the plan, and it is
//      measured rather than chosen: the `targetSpeed` band alone is proportional
//      with no integral, so it settles well OVER its target (to 21 m/s when asked
//      for 0, 63 when asked for 55; `paceTuning` has the arithmetic).
//
//   2. HOLD. Entered when the student is held (the lift, a crash, a live
//      interrupt — the caller's word), when the gap passes `waitBeyondMetres`,
//      or when the pace law asks for no speed at all. It flies through the ring
//      its student is making for (`latchHold` says which), then comes to a
//      hover `holdAsideMetres` OFF the line beside that ring's exit, and turns
//      to face the student. Off the line, because a
//      ship stopped on the line is a wall in front of the ring you are about to
//      fly (§4.1). It leaves when the student is within `resumeWithinMetres`,
//      free, and coming on fast enough that the pace law asks for speed again.
//
// Every number is content's (`lesson.instructor` in the level, DEV-375), handed
// in as an `InstructorPaceSpec` by the runner (DEV-377). The only literals here
// are 0, 1 and -1 — starting values, the no-ring sentinel, a side's sign and
// the bounds of a clamp — and the one tolerance (`ARRIVED_WITHIN`) is a number
// off the constants sheet.
//
// Measured on the real desert ground, both canyon courses, and bit-identity of
// every ordinary racer against the commit before this one: DEV-376's row in
// `docs/DEVIATIONS.md`.
//
// SIM LAYER: no three, no DOM, no wall clock, no `Math.random()`.

import type { AutopilotTuning } from './autopilot'
import type { Gate } from './course'
import { HOVERJET_CRAFT_VOLUME } from './craft-contact'
import { cruiseSpeed, type HoverJet } from './hoverjet'
import { type Vec3, v3 } from './math/vec3'
import { type Route, routeAt, routeRightAt } from './route'
import { chainedMaxSpeed } from './speed-chain'
import { type HeightField, highestGroundUnder, PADS_SOLID } from './terrain/height-field'

/**
 * The pacing, as the sim reads it: the lesson's `instructor` block with the
 * live step's overrides applied (FLIGHT-INSTRUCTOR §6.2). The runner writes it;
 * the sim types none of these numbers.
 */
export interface InstructorPaceSpec {
  /** Metres of racing line it holds ahead of the student. */
  readonly leadMetres: number
  /** m/s of target speed per metre of gap error. */
  readonly gain: number
  /** Further ahead of the student than this, along the line, and it waits. */
  readonly waitBeyondMetres: number
  /** Closer than this, with the student coming on, and it goes again. */
  readonly resumeWithinMetres: number
  /** How far off the line it hovers while it waits, metres. */
  readonly holdAsideMetres: number
  /** The step's speed cap, m/s. */
  readonly maxSpeed: number
  /** Hold boost (still under the cap). Overrides the racer tuning's own `boost`. */
  readonly boost: boolean
  /** `pace: "race"`: no pace law and no waiting. The cap and the boost still apply. */
  readonly race: boolean
}

/** What the student is doing, this tick. The caller writes it before the step. */
export interface StudentReading {
  /** Metres along the racing line: `game/race-place.ts`'s `raceProgress(...).arc`. */
  arc: number
  /** Airspeed, m/s. */
  speed: number
  /** Where the student is, SIM space: what a waiting instructor turns to face. */
  readonly position: Vec3
  /**
   * True while the student is not free to fly the course: on the pad or the
   * lift, held by a crash, or while the lesson has an interrupt up. The
   * instructor waits.
   */
  held: boolean
}

/** What a caller hands over; copied into the instructor's own reading. */
export interface StudentInput {
  readonly arc: number
  readonly speed: number
  readonly position: Vec3
  readonly held: boolean
}

export type InstructorMode = 'lead' | 'hold'

/** `AutopilotTuning` with its fields writable — the instructor's own per-tick copy. */
type MutableTuning = { -readonly [K in keyof AutopilotTuning]: AutopilotTuning[K] }

/**
 * One instructor's pace and wait. Hangs off `AiRacer.pace`.
 *
 * EVERYTHING that persists across ticks is here, per instructor — trap 19,
 * which `ai-racer.ts` has paid for four times: the latched hover point, the
 * mode, and the tuning copy. Nothing about it is a module scratch.
 */
export interface InstructorPace {
  /** The live pacing. The runner may replace it between ticks (a new step). */
  spec: InstructorPaceSpec
  /** The student, this tick. See `StudentReading`. */
  readonly student: StudentReading
  mode: InstructorMode
  /** The ring it waits beside, or -1 for a hover point with no ring (its start). */
  holdRing: number
  /** Arc length of the hover point's foot on the line. */
  holdArc: number
  /**
   * Where it hovers, SIM space. Latched once, on entering HOLD: a SETPOINT, not
   * a reading, for `AiRacer.holdAltitude`'s reason — a reference that tracks
   * the state corrects nothing.
   */
  readonly holdAt: Vec3
  /** +1 right of the line, -1 left: the side `holdAt` was put on. A reading. */
  holdSide: number
  /** True while it is at the hover point, stopped and facing the student. A reading. */
  settled: boolean
  /** Its arc minus the student's, last tick. A reading. */
  gap: number
  /** The target speed it last flew to, m/s. A reading. */
  target: number
  /** Its own copy of the racer's tuning with this tick's ceiling and boost. See `paceTuning`. */
  readonly tuning: MutableTuning
}

/**
 * A fresh pace, waiting: an instructor starts held until the student is free
 * (step 0 is the launch). `holdAt` is unlatched until `holdInstructorAt` or the
 * first HOLD entry writes it.
 */
export const createInstructorPace = (
  spec: InstructorPaceSpec,
  tuning: AutopilotTuning,
): InstructorPace => ({
  spec,
  student: { arc: 0, speed: 0, position: v3(), held: true },
  mode: 'hold',
  holdRing: -1,
  holdArc: 0,
  holdAt: v3(),
  holdSide: 1,
  settled: false,
  gap: 0,
  target: 0,
  tuning: { ...tuning },
})

/** Copy a caller's reading of the student into the instructor's own. */
export const readStudent = (pace: InstructorPace, input: StudentInput): void => {
  const s = pace.student
  s.arc = input.arc
  s.speed = input.speed
  s.position.x = input.position.x
  s.position.y = input.position.y
  s.position.z = input.position.z
  s.held = input.held
}

/**
 * The pace law, UNCLAMPED: `v_student − gain × (gap − lead)`, m/s.
 *
 * Zero or less is the law asking the instructor to stop (or to back up), which
 * is when it goes to wait beside a ring instead. Clamped into `[0, maxSpeed]`
 * it is the target it flies to.
 */
export const paceLaw = (spec: InstructorPaceSpec, studentSpeed: number, gap: number): number =>
  studentSpeed - spec.gain * (gap - spec.leadMetres)

/**
 * Lead or wait, this tick. Returns true on the tick HOLD is ENTERED, so the
 * caller latches the hover point exactly once.
 *
 * ── Why "the law asks for nothing" is a way in ─────────────────────────────
 *
 * The plan's two triggers are a held student and a gap past `waitBeyondMetres`.
 * With the plan's own numbers the pace law reaches zero long before either: at
 * `gain` 0.5 it asks for 0 m/s at `lead + v_student / gain` — 190 m behind a
 * student doing 50, 90 m behind one who has stopped — against a `waitBeyond`
 * of 400. So a student who stops would leave the instructor stopped ON THE
 * LINE, 90 m ahead of them, which is the wall §4.1 exists to prevent. With it,
 * the gap rule is the backstop for a student going somewhere the law cannot
 * follow (faster than the cap, or off the line), which is what it is for.
 *
 * ── And why the way out needs more than the way in reversed ───────────────
 *
 * `gap < resumeWithinMetres` AND `law > 0` AND not held. The law makes
 * "the player is moving" exact: at the resume distance it wants
 * `v_student > gain × (resume − lead)`, and nearer in it wants less, so a
 * student who stopped 100 m short is not "moving" and one closing at any speed
 * inside the lead is.
 */
export const stepInstructorMode = (pace: InstructorPace, arc: number): boolean => {
  const spec = pace.spec
  const student = pace.student
  pace.gap = arc - student.arc
  if (spec.race) {
    pace.mode = 'lead'
    pace.settled = false
    return false
  }
  const law = paceLaw(spec, student.speed, pace.gap)
  if (pace.mode === 'lead') {
    if (student.held || pace.gap > spec.waitBeyondMetres || law <= 0) {
      pace.mode = 'hold'
      pace.settled = false
      return true
    }
    return false
  }
  if (!student.held && pace.gap < spec.resumeWithinMetres && law > 0) {
    pace.mode = 'lead'
    pace.settled = false
  }
  return false
}

/**
 * The speed to fly at while LEADING: the law, clamped into `[0, maxSpeed]`,
 * or the cap itself when the step says race.
 */
export const leadTarget = (pace: InstructorPace): number => {
  const spec = pace.spec
  if (spec.race) return spec.maxSpeed
  const law = paceLaw(spec, pace.student.speed, pace.gap)
  return law <= 0 ? 0 : law >= spec.maxSpeed ? spec.maxSpeed : law
}

/**
 * The speed to arrive at a point `metres` away with: the pace law with the
 * point as the student — standing still, no lead — so `gain × metres`, capped.
 * The same gain, so the instructor closes on a hover point the way it closes a
 * gap: exponentially, in `1 / gain` seconds.
 */
export const arriveTarget = (spec: InstructorPaceSpec, metres: number): number => {
  const v = spec.gain * metres
  return v <= 0 ? 0 : v >= spec.maxSpeed ? spec.maxSpeed : v
}

/**
 * Close enough to the hover point to stop and turn: within one half-beam of
 * the ship, off the constants sheet (`craft-contact.ts`'s capsule, 2.2 m).
 * Nothing finer is visible, and it is the size of the ship doing the hovering.
 */
export const ARRIVED_WITHIN: number = HOVERJET_CRAFT_VOLUME.radius

/**
 * The racer's tuning, with the boost the step asks for and a throttle CEILING
 * that makes `target` its terminal speed. Written into the instructor's own
 * copy, every field, every tick; returned.
 *
 * ── Why a ceiling, and not only `targetSpeed` ─────────────────────────────
 *
 * `autopilotActions`'s speed band is proportional: over the target by a
 * fraction of `profileBand` it gives up that fraction of `profileBrakeMax` of
 * the throttle, and nothing else. A HoverJet's terminal speed is linear in the
 * throttle (`AutopilotTuning.maxThrottle`'s note, DEV-125), so it settles where
 * the two lines cross, and on `steady` that is `(89.8 + 3.23 × T) / 4.23`:
 * 21 m/s when asked for 0, 63 when asked for 55. The band never lets it go
 * slower than 10 % throttle either. A ceiling of `T / terminal` is the same
 * lever DEV-125 uses to put a racer between two speeds, set per tick: aligned,
 * it settles AT the target, and the band is left to do what it is good at,
 * shedding speed quickly when the target drops.
 *
 * `terminal` is where this jet settles at its thrust right now — its speed
 * chain, and boost when it is held — off the jet's OWN sheet
 * (`sim/hoverjet.ts`'s `cruiseSpeed`). It was the generated sheet's
 * `derived.hoverjet.terminalSpeedCruise` scaled by thrust, which is 2016's
 * drag and mass whatever the instructor flies: routed in DEV-382, with the
 * racers' seed speed, because the instructor is a racer and racers fly the
 * player's variant.
 */
export const paceTuning = (
  pace: InstructorPace,
  base: AutopilotTuning,
  jet: HoverJet,
  target: number,
): AutopilotTuning => {
  const t = pace.tuning
  Object.assign(t, base)
  const boost = pace.spec.boost
  t.boost = boost
  const thrust =
    chainedMaxSpeed(jet.chain, jet.chainSpec, jet.tuning.maxSpeed) *
    (boost ? jet.tuning.boostMultiplier : 1)
  // Off THIS jet's sheet (DEV-382): a variant moves both the thrust and the
  // drag the terminal is made of, and the instructor flies the race's view.
  const terminal = cruiseSpeed(jet.sheet, thrust)
  const ceiling = terminal > 0 ? target / terminal : 0
  if (ceiling < t.maxThrottle) t.maxThrottle = ceiling
  // The floor too, or `clamp(x, min, max)` with min above max hands back the
  // floor whenever the ship is misaligned, and a turning instructor outruns
  // its own ceiling.
  if (ceiling < t.minThrottle) t.minThrottle = ceiling
  return t
}

/** Volatile: the line's foot and right under a candidate hover point. */
const _foot = v3()
const _right = v3()

/** Metres of air over the highest field under (x, z); Infinity where no field reaches. */
const clearanceAt = (fields: readonly HeightField[], x: number, y: number, z: number): number => {
  // Pads solid to the ground, as the instructor has always read them.
  return y - highestGroundUnder(fields, x, z, PADS_SOLID)
}

/**
 * Latch the hover point for a HOLD entered at arc length `s`. Pure: writes
 * `holdRing`, `holdArc`, `holdSide` and `holdAt`, and nothing else.
 *
 * The RING is the one the STUDENT is making for — the first whose exit the
 * student's arc has not reached — so the instructor waits where the student is
 * about to fly, in view. If that ring is more than one `leadMetres` behind the
 * instructor, it is the first ring ahead of the instructor instead: a lead is
 * how far ahead it flies, so a turn back of up to one lead is coming back for
 * the student it was leading, and anything more is a student it lost (the
 * `waitBeyondMetres` case), who is better waited for up ahead.
 *
 * Measured before this rule, on `rookie_02` with a student who stops: the
 * first cut waited at the first ring AHEAD of the instructor, and twice that
 * put it 440 m on from the ring the student had stopped short of (535 m of
 * gap to fly before it would lead again), once because it was 0.4 m past that
 * ring's exit. With no ring left anywhere ahead it waits beside the line where
 * it is.
 *
 * The POINT is beside that ring's EXIT, where its trigger sphere ends along the
 * line (`gateArc + radius`), `holdAsideMetres` across the line, at the line's
 * height there.
 *
 * The SIDE is whichever has more air under it. Measured, not taste: at 40 m on
 * `adv_01` the right side of ring 3 is 10 m inside the canyon wall and the
 * right of ring 19 is 5 m inside it; the better side is never under 13.9 m of
 * air on either canyon course. A tie (both sides off every field) goes right.
 */
export const latchHold = (
  pace: InstructorPace,
  route: Route,
  gates: readonly Gate[],
  gateArc: readonly number[],
  s: number,
  fields: readonly HeightField[],
): void => {
  const exitOf = (i: number): number => (gateArc[i] ?? s) + (gates[i]?.radius ?? 0)
  // The student's ring: the first whose exit the student has not reached.
  let ring = -1
  for (let i = 0; i < gates.length; i++) {
    if (exitOf(i) > pace.student.arc) {
      ring = i
      break
    }
  }
  // More than a lead behind the instructor: the first ring ahead of it instead.
  if (ring < 0 || exitOf(ring) < s - pace.spec.leadMetres) {
    ring = -1
    for (let i = 0; i < gates.length; i++) {
      if (exitOf(i) > s) {
        ring = i
        break
      }
    }
  }
  const aside = pace.spec.holdAsideMetres
  // No ring left ahead: wait beside the line where it is.
  const arc = ring >= 0 ? exitOf(ring) : s
  pace.holdRing = ring
  pace.holdArc = arc
  routeAt(route, arc, _foot)
  routeRightAt(route, arc, _right)
  const right = clearanceAt(fields, _foot.x + _right.x * aside, _foot.y, _foot.z + _right.z * aside)
  const left = clearanceAt(fields, _foot.x - _right.x * aside, _foot.y, _foot.z - _right.z * aside)
  const side = left > right ? -1 : 1
  pace.holdSide = side
  pace.holdAt.x = _foot.x + _right.x * aside * side
  pace.holdAt.y = _foot.y
  pace.holdAt.z = _foot.z + _right.z * aside * side
}

/**
 * Hold at a given point, with no ring: how an instructor starts, waiting where
 * the lesson put it (`startArcMetres`, step 0) for the student to launch. The
 * caller places the body there first (`seedRacerAt`).
 */
export const holdInstructorAt = (pace: InstructorPace, at: Vec3, arc: number): void => {
  pace.mode = 'hold'
  pace.settled = false
  pace.holdRing = -1
  pace.holdArc = arc
  pace.holdSide = 1
  pace.holdAt.x = at.x
  pace.holdAt.y = at.y
  pace.holdAt.z = at.z
}

/**
 * Is it still on its way THROUGH the ring it is waiting beside? Then it flies
 * the line to it, as it leads; past the ring's plane it leaves the line for
 * the hover point. A hold with no ring is past it by definition.
 */
export const holdBeforeRing = (
  pace: InstructorPace,
  passed: readonly boolean[],
  gateArc: readonly number[],
  s: number,
): boolean => {
  const ring = pace.holdRing
  if (ring < 0) return false
  return !passed[ring] || s < (gateArc[ring] ?? Number.NEGATIVE_INFINITY)
}
