// src/render/results-anim.ts: the results panel's timeline. DEV-650.
//
// The consultant (2026-10-05, art item 12): *"animate the results in (time
// counts up, the medal stamps in with a sound, NEW BEST flashes)"*, and the
// brief: the panel animates in, the time counts up, the medal stamps, NEW BEST
// flashes. This is the clock for all of it, as a pure function of the seconds
// since the panel appeared, so a test can read any instant and the painter
// (`render/results.ts`) holds no timing of its own.
//
// ── The beats ─────────────────────────────────────────────────────────────
//
//   0.00 .. 0.30   the plate comes in: opacity and a small scale-up
//   0.20 .. 1.20   the numbers count up: gates, time, score (ease-out)
//   1.25 .. 1.55   the MEDAL STAMPS: lands big and settles, once; `stamped`
//                  goes true on the first frame of it, which is where the
//                  caller fires the medal's cue (DEV-644)
//   1.60 ..        the line under the best (next medal, or the lap to beat)
//                  fades in
//   1.55 .. 3.15   NEW BEST flashes, between the win ink and the plain ink, and
//                  settles on the win ink
//
// All of it is under 3.2 s and the plate is readable from the first frame: the
// final board and the prompts are not part of the timeline, so a player who
// wants to retry never waits on an animation (the fly-again press works the
// instant the panel is up, as it always did).
//
// Reduced motion collapses it to the end state at once: a player who asked a
// page not to move did not mean the results panel to be the exception.

export const RESULTS_TIMES = {
  enter: 0.3,
  countStart: 0.2,
  countEnd: 1.2,
  stamp: 1.25,
  stampLength: 0.3,
  nextIn: 1.6,
  nextLength: 0.3,
  flashStart: 1.55,
  flashEnd: 3.15,
  /** Flashes per second of NEW BEST. */
  flashHz: 4,
} as const

export interface ResultsFrame {
  /** The plate's own entrance, 0 to 1. */
  readonly enter: number
  /** How much of each counting number to show, 0 to 1 (eased). */
  readonly count: number
  /** The stamp's progress, 0 (not yet) to 1 (settled). */
  readonly stamp: number
  /** The stamp has begun: true from its first frame on. */
  readonly stamped: boolean
  /** The medal's scale: big at the first frame of the stamp, 1 once settled. */
  readonly stampScale: number
  /** The line under the best, 0 to 1. */
  readonly next: number
  /** NEW BEST: not yet, flashing on the win ink, flashing on the plain ink, or settled. */
  readonly best: 'hidden' | 'on' | 'off' | 'settled'
  /** Every beat is over: the painter can stop redrawing every frame. */
  readonly done: boolean
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))
const easeOut = (x: number): number => 1 - (1 - x) * (1 - x) * (1 - x)

/** The state after every beat: what reduced motion shows at once, and what the panel settles on. */
export const RESULTS_SETTLED: ResultsFrame = {
  enter: 1,
  count: 1,
  stamp: 1,
  stamped: true,
  stampScale: 1,
  next: 1,
  best: 'settled',
  done: true,
}

/**
 * A stamp lands big and settles: 1.8 down to 0.94 in the first 70 % (ease-out,
 * the thump), then back up to 1 (the rebound of a thing that hit).
 */
export const stampScaleAt = (p: number): number => {
  if (p <= 0) return 1.8
  if (p >= 1) return 1
  if (p < 0.7) return 1.8 - 0.86 * easeOut(p / 0.7)
  return 0.94 + 0.06 * ((p - 0.7) / 0.3)
}

/**
 * The frame at `seconds` since the panel appeared. `improved` decides whether
 * there is a NEW BEST to flash; `reduced` is the player's reduced-motion setting.
 */
export const resultsFrame = (
  seconds: number,
  options: { readonly improved: boolean; readonly reduced: boolean },
): ResultsFrame => {
  if (options.reduced) return RESULTS_SETTLED
  const T = RESULTS_TIMES
  const t = Math.max(0, seconds)
  const stampP = clamp01((t - T.stamp) / T.stampLength)
  let best: ResultsFrame['best'] = 'settled'
  if (options.improved) {
    if (t < T.flashStart) best = 'hidden'
    else if (t < T.flashEnd)
      best = Math.floor((t - T.flashStart) * T.flashHz * 2) % 2 === 0 ? 'on' : 'off'
  }
  const done = t >= (options.improved ? T.flashEnd : T.nextIn + T.nextLength)
  return {
    enter: easeOut(clamp01(t / T.enter)),
    count: easeOut(clamp01((t - T.countStart) / (T.countEnd - T.countStart))),
    stamp: stampP,
    stamped: t >= T.stamp,
    stampScale: t >= T.stamp ? stampScaleAt(stampP) : 1.8,
    next: clamp01((t - T.nextIn) / T.nextLength),
    best,
    done,
  }
}
