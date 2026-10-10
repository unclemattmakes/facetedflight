// src/audio/lift.ts — the lift ride's motor and its arrival. PURE. No Web Audio.
//
// ── What this is for (DEV-424) ────────────────────────────────────────────
//
// Matt, 2026-09-26: *"need sound fx for the elevator ride."* The ride already
// had sound: 2016's servo at the press (`elevator.start`), AUD-1's loop under
// it — a group 2016 shipped MUTED and the port plays anyway — and the eight
// positional `shaft.whoosh` collars. What none of them does is follow the
// PLATFORM. The loop is one pitch for fifteen seconds and nearly all of it sits
// below what a headset's own speakers reproduce; the whooshes mark collars, not
// motion. 2016 has nothing more to port: `LaunchElevator.cs` makes no audio
// call and the lift clip carries no animation event.
//
// So this is FF2's, Anniversary only, and it is two things: a motor voice whose
// pitch and level follow the platform's speed, and a clunk when the platform
// comes to rest at the top. Every number is in `content/editions/<preset>.json`,
// `audio.lift`; this file holds none of the tuning.
//
// ── The speed is DERIVED, from the one thing that moves the platform ──────
//
// `launch.rise` is metres above the spawn marker, evaluated off the level's own
// ride curve once per fixed step (`sim/launch.ts`). Its difference over one
// step is the platform's speed in m/s, which is the physical quantity a motor
// follows — so the voice spins up, cruises and brakes with WHATEVER curve a
// level carries, rather than with a fifteen-second envelope that is right for
// `int_01` and wrong for anything re-timed. Measured on `int_01`'s curve: moving
// from 0.77 s, 16.6 m/s at 11.6 s, under 0.25 m/s again at 13.43 s — and then a
// brief settle BACKWARDS (−0.43 m/s) before it rests, which is why the arrival
// is latched and fires once.
//
// Seeded on the first step after a reset rather than differenced against a
// stale value: a retry resets the platform to the top in one assignment
// (`resetLaunch`), and a difference across that would be a 9,000 m/s motor and
// a clunk nobody earned. `index.ts` resets on `launch.start` and `mission.end`,
// the two events that bracket a ride.
//
// ── Trap 19 ───────────────────────────────────────────────────────────────
//
// Nothing here is module-level and mutable. The caller owns the state and the
// output array, as `engine.ts` does.

import type { EditionLiftSound } from '@/content/edition-schema'
import { WORLD } from '@/generated/constants.generated'
import type { CueId } from './cues'
import type { CueAction } from './engine'
import { sampleCurve } from './speed-curves'

/**
 * How long the motor takes to go once the platform has stopped. Plumbing, not
 * tuning: by then `gainBySpeed` has already brought the voice to its rest level,
 * so this only has to be long enough not to click — the same kind of number as
 * `music.ts`'s `MUSIC_CUT_SECONDS`.
 */
export const LIFT_MOTOR_STOP_SECONDS = 0.4

/** The one loop this module starts, for the teardown and the owner test. */
export const LIFT_LOOPS: readonly CueId[] = ['elevator.motor']

export interface LiftAudioState {
  /** Whether `lastRise` holds a real previous step yet. */
  seeded: boolean
  /** `launch.rise` on the previous step, metres. */
  lastRise: number
  /** The platform's speed on the last step, m/s, signed (up is positive). */
  speed: number
  /** `elevator.motor` is running. */
  motor: boolean
  /**
   * The platform has come to rest and the clunk has played. Latched until the
   * next reset, so the settle after the stop cannot start the motor again or
   * play a second clunk.
   */
  arrived: boolean
}

export const createLiftAudio = (): LiftAudioState => ({
  seeded: false,
  lastRise: 0,
  speed: 0,
  motor: false,
  arrived: false,
})

/** Back to a fresh state. The next step seeds rather than differences. */
export const resetLiftAudio = (state: LiftAudioState): void => {
  state.seeded = false
  state.lastRise = 0
  state.speed = 0
  state.motor = false
  state.arrived = false
}

/**
 * One fixed step of the ride. Appends to `out`, returns it.
 *
 * `rise` is `launch.rise` for THIS step. `spec` null is Classic, and then
 * nothing is ever emitted — the speed is still tracked, because it is free and
 * because a flip mid-ride should find the state honest.
 */
export const stepLiftAudio = (
  state: LiftAudioState,
  rise: number,
  spec: EditionLiftSound | null,
  out: CueAction[],
): CueAction[] => {
  if (!state.seeded) {
    state.seeded = true
    state.lastRise = rise
    state.speed = 0
    return out
  }
  state.speed = (rise - state.lastRise) / WORLD.fixedDeltaTime
  state.lastRise = rise
  if (!spec) {
    // A preset flip to Classic under a running motor: put it away.
    if (state.motor) {
      state.motor = false
      out.push({ kind: 'stop', cue: 'elevator.motor', fadeSeconds: LIFT_MOTOR_STOP_SECONDS })
    }
    return out
  }

  const moving = state.speed > spec.stoppedBelow
  if (moving && !state.motor && !state.arrived) {
    state.motor = true
    out.push({ kind: 'play', cue: 'elevator.motor' })
  }
  if (!state.motor) return out

  if (!moving) {
    // At rest: the motor goes and the platform locks home.
    state.motor = false
    state.arrived = true
    out.push({ kind: 'stop', cue: 'elevator.motor', fadeSeconds: LIFT_MOTOR_STOP_SECONDS })
    if (spec.arriveGain > 0) {
      out.push({ kind: 'play', cue: 'elevator.arrive', gain: spec.arriveGain })
    }
    return out
  }

  // Modulated in the same list as its `play` on the first moving step, so the
  // voice's gain node is built AT the curve's value — near silence — rather
  // than at the authored level and pulled down a tick later (`webaudio.ts`).
  out.push({
    kind: 'modulate',
    cue: 'elevator.motor',
    rate: sampleCurve(spec.rateBySpeed, state.speed),
    gain: sampleCurve(spec.gainBySpeed, state.speed),
  })
  return out
}
