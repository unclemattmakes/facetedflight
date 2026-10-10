// src/sim/gate-quality.ts — G2, how WELL was that gate taken?
//
// ANNIVERSARY.md §4.1, second lever: *"Near-miss and clean-gate feedback (S6).
// The accuracy streak in Target Practice (DEV-053) shows the panel can carry an
// event; do the same for a gate taken through its centre at speed."*
//
// A gameplay-tagged module (§0.2): pure, deterministic, and read only through
// `edition.gameplay`. Classic never calls it.
//
// ── The measurement, and why it is not "distance at the crossing tick" ────
//
// The obvious reading is `|position − gate.centre|` on the tick `stepCourse`
// returned the ring. **That number is mostly frame rate.** The sim tests once per
// fixed step and the ship covers `speed · dt` between tests — 3.7 m per tick at
// 300 m/s against a gate whose trigger radius is single-digit metres — so a
// perfectly centred line can be sampled well off centre, and the same line
// scores differently depending on where the tick boundaries happened to fall.
// That is DEV-027's trap with a stopwatch in it: a number that looks like
// accuracy and is really phase.
//
// So this measures the closest approach of the ship's **line of travel** to the
// gate centre. That is exact for the tick, independent of the step, and it is
// the quantity a player means by *"through the middle"*: how close did the LINE
// pass, not where were you when somebody looked.
//
// ── The FORWARD RAY, and not the segment — measured, the hard way ─────────
//
// The first version clamped that closest approach to the swept SEGMENT, `from →
// to`, which is the obvious safe choice and is wrong here by about a factor of
// twenty. An autopilot lap of `int_01` scored **zero clean gates out of
// twenty-one** and the centredness it recorded ran **0.01 to 0.09** the whole
// way round — never within sight of the 0.6 threshold, on a controller that
// flies the authored racing line.
//
// The cause is not the threshold and not the flying. `sim/course.ts` fires on a
// point test against a sphere of the gate's trigger radius — about 22 m — so the
// tick it returns on is **the tick the ship ENTERS that sphere**, which is at
// the rim by construction. Closest approach happens several ticks later, and
// clamping to the segment reports the entry point: `1 − 21.5/22`, forever, for
// every gate, however well it was flown.
//
// So the segment is extended forward into a RAY: `t` is clamped below at 0 and
// not above. At the moment the gate triggers it is AHEAD of the ship, and the
// question *"will this pass through the middle"* is answered by the closest
// approach of the continuing straight line. The lower clamp is what still stops
// a gate BEHIND the ship reading as a near one — which was the whole reason the
// upper clamp looked necessary, and it never was.
//
// **The number that found this was one the code did not need.** `gateClean` is a
// boolean, and a boolean cannot tell you whether a threshold is reachable;
// `MissionEvent.gateCentredness` exists because the only way to tell "the
// threshold is too strict" from "the autopilot flies wide" was to have the
// measurement itself, printed, on a real lap.
//
// `mission.ts` already holds `state.previous` for exactly this kind of sweep,
// which is why this costs nothing to ask.

import type { Vec3 } from './math/vec3'

/**
 * Closest approach to `centre` of the FORWARD RAY from `from` through `to`, in
 * METRES.
 *
 * `t` is clamped below at 0 and **not above** — the header says why at length,
 * and the short version is that a gate triggers on ENTRY to its 22 m sphere, so
 * the swept segment ends at the rim and clamping to it measures the rim. The
 * lower clamp is what keeps a gate behind the ship from reporting the distance
 * to a line it is travelling away from.
 *
 * A degenerate segment — the ship at rest, which happens on the pad — answers
 * the distance from the point, rather than dividing by zero.
 */
export const rayDistance = (from: Vec3, to: Vec3, centre: Vec3): number => {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = to.z - from.z
  const lengthSq = dx * dx + dy * dy + dz * dz
  let t = 0
  if (lengthSq > 0) {
    t = ((centre.x - from.x) * dx + (centre.y - from.y) * dy + (centre.z - from.z) * dz) / lengthSq
    if (t < 0) t = 0
  }
  const cx = from.x + dx * t - centre.x
  const cy = from.y + dy * t - centre.y
  const cz = from.z + dz * t - centre.z
  return Math.sqrt(cx * cx + cy * cy + cz * cz)
}

/**
 * How centred, 0..1. **1 is dead centre and 0 is the rim**, which is the way
 * round a player would guess — the raw distance runs the other way, and a meter
 * that fills as you get worse is the kind of thing that survives for months.
 *
 * Normalised by the gate's own TRIGGER radius rather than by a number of our
 * own, so a course with tighter rings asks for more without anything being
 * re-tuned. A non-positive radius answers 0: unmeasurable is not perfect.
 */
export const gateCentredness = (from: Vec3, to: Vec3, centre: Vec3, radius: number): number => {
  if (!(radius > 0)) return 0
  const d = rayDistance(from, to, centre)
  if (!Number.isFinite(d)) return 0
  const fraction = 1 - d / radius
  return fraction > 0 ? (fraction > 1 ? 1 : fraction) : 0
}

/** What G2 is tuned by. Content — `edition.gameplay.gateEvents`. */
export interface GateEventSpec {
  /**
   * 0..1. At or above this centredness, and at or above `minSpeed`, a gate is
   * CLEAN. 1 would mean the swept line passed exactly through the centre, which
   * no human does; the number is the width of the band that counts as "through
   * the middle".
   */
  readonly cleanCentredness: number
  /** METRES PER SECOND. "At speed" is half the claim and this is the half that is a number. */
  readonly minSpeed: number
  /**
   * METRES to the nearest surface below which a tick counts as a NEAR MISS.
   *
   * Reuses G1's reading rather than measuring anything of its own, so the two
   * levers cannot disagree about how close the ground is — and since DEV-112
   * that reading is `sim/surface-proximity.ts`'s `nearest`, so a canyon wall
   * off the wingtip is a near miss the way a ridge under the belly is. A near
   * miss is by definition a miss: it is only reported on a tick that did NOT
   * strike.
   */
  readonly nearMissMetres: number
  /** Seconds a near miss must stay clear of the last one before it fires again. */
  readonly nearMissCooldown: number
  /**
   * POINTS a near miss banks into G1's bonus pool (DEV-112). Never into
   * `state.score` — the medal invariant DEV-110 §2 pins holds for this channel
   * exactly as it does for the gate bonus. 0 is Classic: the banner cannot
   * fire there either, but a preset is a hand-editable file and one flipped
   * number must not be able to change what a score means.
   */
  readonly nearMissPoints: number
}

export interface GateEventState {
  /** Consecutive clean gates. Resets on a gate that is not clean. */
  cleanStreak: number
  /** The best streak this run, for the results panel. */
  bestCleanStreak: number
  /** Near misses this run. */
  nearMisses: number
  /** Seconds since the last near miss fired. */
  sinceNearMiss: number
}

export const createGateEvents = (): GateEventState => ({
  cleanStreak: 0,
  bestCleanStreak: 0,
  nearMisses: 0,
  sinceNearMiss: Number.POSITIVE_INFINITY,
})

/**
 * Record a gate. Returns true if it was CLEAN.
 *
 * The streak resets on a scrappy gate rather than decaying, which is the same
 * shape as 2016's own speed chain (`maxSpeed = _startingMaxSpeed`, one
 * assignment, no decay) and as DEV-053's accuracy streak. A chain you can half
 * lose is a chain nobody counts.
 */
export const recordGate = (
  state: GateEventState,
  centredness: number,
  speed: number,
  spec: GateEventSpec,
): boolean => {
  const clean = centredness >= spec.cleanCentredness && speed >= spec.minSpeed
  state.cleanStreak = clean ? state.cleanStreak + 1 : 0
  if (state.cleanStreak > state.bestCleanStreak) state.bestCleanStreak = state.cleanStreak
  return clean
}

/**
 * Advance the near-miss clock and decide whether this tick is one.
 *
 * `dt` is the FIXED step. Returns true on the tick a near miss fires — once,
 * then not again until `nearMissCooldown` has passed, because a long low pass
 * down a valley is one piece of flying and not four hundred events.
 *
 * `speed` is forward speed, m/s, and a near miss needs `minSpeed` of it — the
 * same "at speed" a CLEAN gate needs, and the same anti-hover clause G1 has.
 * Before DEV-112 put points on this event the omission was harmless; with
 * points on it, a ship parked a metre off a cliff would bank once per cooldown
 * for as long as the clock ran, which is the exact play §4.1 exists to make
 * worthless. One definition of "at speed" for both G2 events rather than a
 * third number.
 */
export const stepNearMiss = (
  state: GateEventState,
  clearance: number,
  speed: number,
  struck: boolean,
  spec: GateEventSpec,
  dt: number,
): boolean => {
  state.sinceNearMiss += dt
  if (struck) {
    // A strike is not a near miss, and it also RE-ARMS: the tick after you
    // scrape a ridge is allowed to be its own event, because you are somewhere
    // else by then.
    state.sinceNearMiss = Number.POSITIVE_INFINITY
    return false
  }
  if (!Number.isFinite(clearance) || clearance > spec.nearMissMetres) return false
  if (!(speed >= spec.minSpeed)) return false
  if (state.sinceNearMiss < spec.nearMissCooldown) return false
  state.sinceNearMiss = 0
  state.nearMisses += 1
  return true
}
