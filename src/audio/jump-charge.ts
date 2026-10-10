// src/audio/jump-charge.ts — the jumping spider's charge tone. DEV-383.
//
// AIRCRAFT-VARIANTS §4.5 telegraphs the spider's launch two ways: *"a ring
// filling, with a rising tone"*. The ring is `render/hud-fuel.ts`; this is the
// tone. A loop that starts the tick a charge starts building, rises an octave
// as it fills, and stops the tick the charge ends — whether it ended in a jump
// or in a drop (stepped off, ran dry). 2016 has no jump, so there is nothing
// here to be faithful to; the cue is ours and says so in its provenance.
//
// Pure over (state, charge), no `AudioContext`, so it is unit-tested in node
// the way `engine.ts` is. It is the ONE owner of `jump.charge`: `index.ts`
// runs it inside `stepFlight` and stops the cue in its `mission.end` teardown,
// and `audio-events.test.ts` names that owner.
//
// The charge arrives as the seam's `flight.jump.charge`, which is 0 on a
// spider that is not charging and undefined on every other seat, so neither
// ever starts the loop.

import { type CueAction, gateLoop } from './engine'

/** A full charge plays the tone at this multiple of its authored pitch: an octave. */
export const JUMP_CHARGE_RISE = 2

/**
 * Seconds of fade when the charge ends. Short, because the release IS the
 * jump and a tone that trails into the air says the launch was late.
 */
export const JUMP_CHARGE_STOP_SECONDS = 0.05

/** Per audio system. Trap 19: never shared, never module-level. */
export interface JumpChargeAudioState {
  playing: boolean
}

export const createJumpChargeAudio = (): JumpChargeAudioState => ({ playing: false })

/** The tone's rate for a charge in 0..1: 1 at the start, `JUMP_CHARGE_RISE` when full. */
export const jumpChargeRate = (charge: number): number =>
  1 + (JUMP_CHARGE_RISE - 1) * Math.min(Math.max(charge, 0), 1)

/**
 * One fixed step. Appends to `out` and returns it: a `play` on the first tick
 * of a charge, a `modulate` on every tick of one (the first included, so the
 * voice never sounds a tick at the wrong pitch), and a `stop` on the first
 * tick after it.
 */
export const stepJumpChargeAudio = (
  state: JumpChargeAudioState,
  charge: number | undefined,
  out: CueAction[],
): CueAction[] => {
  // `undefined` (no jumping spider this tick) reads as no charge.
  const level = charge ?? 0
  const charging = level > 0
  state.playing = gateLoop(charging, state.playing, 'jump.charge', JUMP_CHARGE_STOP_SECONDS, out)
  if (charging) out.push({ kind: 'modulate', cue: 'jump.charge', rate: jumpChargeRate(level) })
  return out
}
