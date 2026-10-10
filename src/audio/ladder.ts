// src/audio/ladder.ts: the gate's pitch ladder and the loss cue's three voices.
// PURE. DEV-638 (b), DEV-639.
//
// CONSULTANT-REVIEW-2026-10-05 item B: `ring.pass` rises one semitone per
// consecutive clean gate and resets on a miss, a non-clean gate or a chain
// expiry, "the most-copied trick in arcade audio". The COUNT is the game's
// (`game/gate-feel.ts` keeps the ladder); this file is only what a count sounds
// like, so the audio layer needs no import from the game layer.
//
// Twelve-tone equal temperament, because the ear hears a semitone as a step on a
// scale and anything else as an out-of-tune bell.

/** Semitones in an octave: the top of the ladder. A name for 12, not a tuning knob. */
export const SEMITONES_PER_OCTAVE = 12

/**
 * Semitones above the floor for a streak. One rung per consecutive clean gate
 * AFTER the first (the first clean gate sounds at the floor, so a single clean
 * gate is not already a half step sharp), capped at an octave.
 */
export const ladderSemitones = (streak: number): number => {
  if (!(streak > 1)) return 0
  const rungs = Math.floor(streak) - 1
  return rungs > SEMITONES_PER_OCTAVE ? SEMITONES_PER_OCTAVE : rungs
}

/** The frequency ratio of {@link ladderSemitones}. */
export const ladderPitch = (streak: number): number =>
  2 ** (ladderSemitones(streak) / SEMITONES_PER_OCTAVE)

/** What went wrong: a gate flown off the middle, a streak broken, or the speed chain gone. */
export type GateLossKind = 'miss' | 'streak' | 'chain'

/**
 * The descending cue is ONE cue at three pitches and three levels (DEV-639).
 * A miss is quiet next to a gain: the streak breaking is the loudest, the chain
 * expiring is the lowest and longest fall, a plain off-centre gate is a whisper.
 * FF2's own; 2016 had no feedback for any of them.
 */
export const GATE_LOSS_VOICE: Readonly<
  Record<GateLossKind, { readonly gain: number; readonly pitch: number }>
> = {
  miss: { gain: 0.35, pitch: 1 },
  streak: { gain: 0.8, pitch: 0.84 },
  chain: { gain: 0.6, pitch: 0.7 },
}
