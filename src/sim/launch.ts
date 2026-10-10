// src/sim/launch.ts — the elevator ride, which is how the mission begins.
//
// ── What this replaces ────────────────────────────────────────────────────
//
// A teleport. The port used to add `launchRise` to the spawn Y and call the ship
// launched, and it was wrong twice over: the height came from a component that
// never ran, and there was no ride at all.
//
// The spawn marker sits at the BOTTOM of the shaft — 19.79 m on `int_01`, about
// 95 m under the ocean and deep inside the 164 m fog plane, where horizontal
// visibility is under 2% at a kilometre. The elevator is what carries you out of
// that. It is not set dressing; it is the reason the first thing you see is not
// grey.
//
// ── The motion ────────────────────────────────────────────────────────────
//
// `elevator_up.anim`, six Hermite keys over 15.47 s, rising 106.647 m:
//
//   0.00 s    0.000 m   ) both zero — the platform holds for 0.6 s after you
//   0.60 s    0.000 m   )  press, which is the beat before the ride
//  11.05 s   79.278 m   slope 14.57 m/s, the fast middle
//  13.17 s  106.494 m   slope 2.03, easing in
//  13.97 s  106.647 m   slope 0.03, arrived
//  15.47 s  106.647 m   ) held, then the clip ends
//
// Evaluated as cubic Hermite, NOT lerped: the tangents are what make it ease.
// `sim/art-lean.ts` already needed the same evaluator for `Rotator_Input`'s
// curves, so this shares it rather than growing a second one.
//
// ── Why it lives in the sim ───────────────────────────────────────────────
//
// Because it is deterministic scripted motion on the fixed step, and because a
// ghost race is only fair if your clock and theirs start on the same tick. The
// ride has to replay identically, so it cannot be driven by frame time. (D4.)
//
// SIM LAYER: no three, no DOM, no wall clock.

import { type Curve, evaluateCurve } from './art-lean'

/** What the elevator is doing right now. */
export type LaunchPhase =
  /** Sitting at the bottom of the shaft, waiting for the player to press A. */
  | 'waiting'
  /** The clip is playing. The ship is attached to the platform. */
  | 'rising'
  /** At the top, counting down. Still attached. */
  | 'countdown'
  /** Let go. The flight model owns the ship from here. */
  | 'flying'

export interface LaunchSpec {
  /** The clip's Y track, seconds -> metres above the spawn marker. */
  readonly keys: Curve['keys']
  /** Seconds from the start of the clip to the top. */
  readonly releaseAtSeconds: number
  /**
   * Beats before GO, and the wall time of each.
   *
   * `Timer_Race` counts `steps` down and then fires on the NEXT beat, so a
   * 3-2-1-GO is four beats and `steps + 1` is not an off-by-one. Zero steps means
   * no countdown at all: the ship is let go the instant it reaches the top.
   */
  readonly countdownSteps: number
  readonly countdownStepSeconds: number
  /**
   * Skip the ride and start the platform AT THE TOP. Default true — **Matt's
   * call, 2026-09-10**: *"plz make it so the platform starts at the top
   * position... we cut the elevator ride for this version."*
   *
   * A cut, not a correction. `LaunchElevator` is live in the shipped
   * `int_01_hoverJet.unity` — `m_Enabled: 1`, its GameObject active, and every
   * node up the chain (`Elevator_animator` / `Elevator` /
   * `Position_adjustment` / `PlayerStart_ElevatorShaft_Photon` / `levelOffset`)
   * active too. 2016 really did ride the lift for 15.5 s before letting go.
   *
   * Everything that made the ride work stays: `?ride=1` puts it back, and the
   * curve, the phases and their tests are untouched. See DEV-012 and DEV-024.
   */
  readonly skipRide: boolean
}

export interface LaunchState {
  phase: LaunchPhase
  /** Seconds since the ride began. Zero while waiting. */
  elapsed: number
  /** Metres above the spawn marker, right now. */
  rise: number
  /** Seconds since the countdown started. Zero until it does. */
  countdownElapsed: number
}

/**
 * Where the platform ends up: the ride curve evaluated at the release.
 *
 * Read off the curve rather than off `spawn.launch.rise` so the two can never
 * drift — the rise the ship is HELD at and the rise the curve ENDS at are the
 * same number by construction.
 */
export const topRise = (spec: LaunchSpec): number =>
  evaluateCurve({ keys: spec.keys }, spec.releaseAtSeconds)

/**
 * The phase a launch RESTS at, given its spec.
 *
 * **A null spec means there is no elevator, and a mission with no elevator has
 * already started** — the six JumpSeat courses authored no rig, and nothing
 * will ever move their phase off `waiting` because `stepLaunch` is only
 * reached through `if (rideSpec && ...)`. That rule lived in `boot/app.ts` as
 * `if (!launchSpec) launch.phase = 'flying'` written out beside two of the
 * three entry points, and the third — `resetLaunch`, which every RESTART goes
 * through — did not have it. So a JumpSeat mission was "under way" on the
 * first run and "held on the pad" for ever after the first retry, which froze
 * the cockpit shake and the speed lens (both gate on `launchHoldsShip`) and
 * would have hidden DEV-159's arrow for the rest of the session.
 *
 * One rule, in the state machine, so a fourth reader cannot miss it. DEV-159.
 */
const restingPhase = (spec: LaunchSpec | null): LaunchPhase => (spec ? 'waiting' : 'flying')

/**
 * A launch that has not started.
 *
 * With `skipRide` the platform is already at the top, because the ship is
 * parented to it and held there — so "start at the top" has to be true from the
 * first frame, not from the first button press.
 */
export const createLaunch = (spec: LaunchSpec | null): LaunchState => ({
  phase: restingPhase(spec),
  elapsed: 0,
  rise: spec?.skipRide ? topRise(spec) : 0,
  countdownElapsed: 0,
})

/**
 * Put a launch back to `waiting`, ready for another run.
 *
 * Written as a mutation of the existing state rather than "assign a fresh
 * `createLaunch`" because the caller holds the object: every reference to it —
 * the elevator's render, the HUD banner, the hold that keeps the ship on the
 * platform — would otherwise be pointing at the previous run's launch.
 */
export const resetLaunch = (state: LaunchState, spec: LaunchSpec | null): void => {
  state.phase = restingPhase(spec)
  state.elapsed = 0
  state.countdownElapsed = 0
  // The same rule `createLaunch` applies: with the ride cut, the platform is
  // already at the top on the first frame rather than after the first press.
  state.rise = spec?.skipRide ? topRise(spec) : 0
}

/**
 * The number to show, or 0 for GO.
 *
 * Counts DOWN with the beats: `steps` at the first beat, 1 at the last numbered
 * one, then 0. Returns null when there is nothing to show — before the countdown
 * and after it has handed over.
 */
export const countdownNumber = (state: LaunchState, spec: LaunchSpec): number | null => {
  if (state.phase !== 'countdown') return null
  const beat = Math.floor(state.countdownElapsed / spec.countdownStepSeconds)
  return Math.max(0, spec.countdownSteps - beat)
}

/**
 * Begin the ride — or, with `skipRide`, just the countdown.
 *
 * `spec` is REQUIRED, and the `| null` is for a mission that has no elevator at
 * all rather than for convenience. It was optional for about an hour and that
 * hour cost a bug: `?autopilot=1` calls this from its own site, the default made
 * that site keep compiling untouched, and the autopilot rode a 15.5-second lift
 * that had been cut — starting every automated run 95 m underwater.
 *
 * Same shape as the ghosts' drifted constant an hour earlier. A default is a way
 * for a stale call site to stay quiet; making it required turns the compiler into
 * the thing that finds them.
 *
 * Begin the ride.
 *
 * Idempotent on purpose: `Input_Ship` guards its own call with a `gameReady`
 * flag (Input_Ship.cs:382) precisely because the button is polled every frame
 * and is held down for many of them. Restarting the clip on frame two would
 * drop the platform back to the bottom.
 */
export const startLaunch = (state: LaunchState, spec: LaunchSpec | null): void => {
  if (state.phase !== 'waiting') return
  state.elapsed = 0
  state.countdownElapsed = 0
  if (spec?.skipRide) {
    // Already at the top; the button only starts the countdown.
    state.phase = 'countdown'
    state.rise = topRise(spec)
    return
  }
  state.phase = 'rising'
  state.rise = 0
}

/**
 * Advance one fixed step.
 *
 * Returns true on the tick the ship is RELEASED — exactly once per run — so the
 * caller can start the mission clock and the ghosts on the same tick, which is
 * what makes the race comparable.
 */
export const stepLaunch = (state: LaunchState, spec: LaunchSpec, dt: number): boolean => {
  if (state.phase === 'rising') {
    state.elapsed += dt
    // Clamp before evaluating, so a long step past the end still lands the ship
    // at the top rather than reading off the end of the curve.
    const t = Math.min(state.elapsed, spec.releaseAtSeconds)
    state.rise = evaluateCurve({ keys: spec.keys }, t)
    if (state.elapsed < spec.releaseAtSeconds) return false

    // At the top. Spend whatever the step overshot by on the countdown rather
    // than dropping it, or a slow frame quietly makes the countdown longer.
    const spill = state.elapsed - spec.releaseAtSeconds
    state.phase = 'countdown'
    state.countdownElapsed = 0
    return stepCountdown(state, spec, spill)
  }
  if (state.phase === 'countdown') return stepCountdown(state, spec, dt)
  return false
}

/** The counting half, split out only so the spill above can re-enter it. */
const stepCountdown = (state: LaunchState, spec: LaunchSpec, dt: number): boolean => {
  const total = (spec.countdownSteps + 1) * spec.countdownStepSeconds
  state.countdownElapsed += dt
  if (state.countdownElapsed < total) return false
  state.phase = 'flying'
  return true
}

/**
 * Whether the flight model should be integrating.
 *
 * 2016 held the ship KINEMATIC and parented to the platform for the whole ride
 * (`LaunchElevator.StartLaunch`), and `PlayerShipInitialization` only sets
 * `isKinematic = false` at release. So the answer is: not until it is flying.
 */
export const launchHoldsShip = (state: LaunchState): boolean => state.phase !== 'flying'
