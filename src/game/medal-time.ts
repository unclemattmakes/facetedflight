// src/game/medal-time.ts: time in the medal. DEV-846.
//
// Matt, 2026-10-08 (QUESTIONS, DEV-650): *"it'd be nice if time was factored in,
// so speed was an influence."* DEV-393 had taken the clock out of the medal: the
// 2016 bonus (11.5 points a spare second, up to ~2,000) was bigger than any ring,
// so it was paid only on a run that took every ring, and platinum was the ring
// ceiling itself, so every clean run was platinum and the clock moved nothing.
//
// ── The design, in one paragraph ───────────────────────────────────────────
//
// The clock pays a BOUNDED term, on a run that took EVERY ring (DEV-393's rule
// stands: a missed ring still forfeits it, so one more ring always out-scores
// one fewer). The term is worth at most ONE ring (`TIME_MAX_RINGS`) and is
// scaled to the course, not to a fixed 180 s par: full marks for an average pace
// along the gates of `TIME_FAST_SPEED`, nothing at `TIME_SLOW_SPEED`, linear
// between. PLATINUM asks for every ring PLUS half of the term
// (`PLATINUM_TIME_SHARE`), so a clean but slow lap is GOLD and a clean, quick one
// is PLATINUM. Bronze, silver and gold are untouched: they are ring counts, and
// no amount of speed buys a ring. Rings matter most; time decides the top medal
// and orders the clean runs (the faster scores more, as before).
//
// ── Where the numbers come from (derived, not tuned by feel) ──────────────
//
// Measured 2026-10-08 with `flyAutopilotLap` (the autopilot on the authored line,
// speed chain on, every ring) against the gate-to-gate path length L:
//
//     mission              L (m)    autopilot (s)   L / autopilot (m/s)
//     rookie_01_hoverJet    7,577      41.2            184
//     rookie_02_hoverJet    9,342      48.2            194
//     int_01_hoverJet       9,953      49.7            200
//     int_02_hoverJet       9,661      52.2            185
//     adv_01_hoverJet      10,292      60.1            171
//     adv_02_hoverJet      13,270      80.3            165
//
// So 200 m/s along the gates is the pace of a machine flying the line (the
// full-marks mark, `TIME_FAST_SPEED`), and 100 m/s is a leisurely lap that is
// still inside every time limit (`TIME_SLOW_SPEED`). Platinum at the half-way
// share is a pace of 133 m/s: 2016's recorded fast ghost on int_01 (about 73 s of
// flight over L = 9,953 m) flies 136 m/s, so a good lap clears it and a careful
// one does not. The autopilot's own share on the six courses is 0.79 to 1.00, so
// platinum is reachable on every course by construction
// (`tests/unit/medal-time.test.ts` flies it and asserts so).
//
// A hand-authored course gets the same treatment because L is read off its gates.
// A course with no path (fewer than two gates) pays no time term: there is no
// distance to be quick over, and platinum stays the ring ceiling.
//
// Pure: no three, no DOM.

import type { Level } from '@/content/level-schema'
import { liveRings } from '@/content/level-schema'

/** The most the clock can pay, in rings' worth of points: one gate's value. */
export const TIME_MAX_RINGS = 1

/** Average pace along the gates that earns full marks, m/s: an autopilot-class lap. */
export const TIME_FAST_SPEED = 200

/** Average pace along the gates that earns nothing, m/s: an unhurried lap. */
export const TIME_SLOW_SPEED = 100

/** The share of the term platinum asks for, on top of every ring. 0.5 is a pace of 133 m/s. */
export const PLATINUM_TIME_SHARE = 0.5

/**
 * Metres along the course: gate centre to gate centre, in order. Distances are
 * the same in Unity space and three space, so the level's own coordinates serve.
 */
export const courseLengthMetres = (level: Level): number => {
  const rings = liveRings(level)
  let length = 0
  for (let i = 1; i < rings.length; i++) {
    const a = (rings[i - 1] as (typeof rings)[number]).trigger.pos
    const b = (rings[i] as (typeof rings)[number]).trigger.pos
    length += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
  }
  return length
}

/** Everything the term needs about one course. */
export interface TimeTerm {
  /** The most the clock pays, points. */
  readonly max: number
  /** Seconds at or under which the term is full. */
  readonly fastSeconds: number
  /** Seconds at or over which the term is nothing. */
  readonly slowSeconds: number
  /** What platinum asks of the term on top of the ring ceiling, points. */
  readonly platinumPoints: number
}

const cache = new WeakMap<Level, TimeTerm | null>()

/**
 * The course's time term, or null where the clock pays none: a course with no
 * path to be quick over. The par the level carries (`timer.bonusParTime`) still
 * caps the slow end, so no bonus is paid past the time the level itself calls par.
 */
export const timeTermFor = (level: Level): TimeTerm | null => {
  if (cache.has(level)) return cache.get(level) ?? null
  const length = courseLengthMetres(level)
  let term: TimeTerm | null = null
  if (length > 0) {
    const max = level.scoring.gateMultiplier * TIME_MAX_RINGS
    const fastSeconds = length / TIME_FAST_SPEED
    const par = level.timer.bonusParTime
    const slowSeconds = Math.min(length / TIME_SLOW_SPEED, par > 0 ? par : Number.POSITIVE_INFINITY)
    if (max > 0 && slowSeconds > fastSeconds) {
      term = {
        max,
        fastSeconds,
        slowSeconds,
        platinumPoints: Math.round(max * PLATINUM_TIME_SHARE),
      }
    }
  }
  cache.set(level, term)
  return term
}

/** 0..1: how much of the term a lap of `seconds` earns. */
export const timeShare = (term: TimeTerm, seconds: number): number => {
  const span = term.slowSeconds - term.fastSeconds
  const share = (term.slowSeconds - seconds) / span
  return share <= 0 ? 0 : share >= 1 ? 1 : share
}

/** The points the clock pays a lap of `seconds`. */
export const timePoints = (term: TimeTerm, seconds: number): number =>
  Math.round(term.max * timeShare(term, seconds))

/** Points per second of pace gained across the term's span. */
export const pointsPerSecond = (term: TimeTerm): number =>
  term.max / (term.slowSeconds - term.fastSeconds)

/**
 * Whether the clock is part of the medal on this course and mode: a ring mode
 * with a clock that pays a bonus, on a level that lets time count. The one test
 * `medalCurve` (the platinum bar) and `clockBonus` (the payment) both ask, so
 * the bar and the pay cannot disagree.
 */
export const clockCountsInMedal = (
  level: Level,
  rules: {
    readonly clock: boolean
    readonly timeBonus: boolean
    readonly scores: readonly string[]
  },
): boolean =>
  rules.clock &&
  rules.timeBonus &&
  rules.scores.length === 1 &&
  rules.scores[0] === 'ring' &&
  level.scoring.timeAffectsMedal &&
  timeTermFor(level) !== null
