// src/sim/boundary.ts — the edge of the world, and the clock that runs when you
// cross it.
//
// ── What 2016 does ────────────────────────────────────────────────────────
//
// `PlayerBoundary` is a TRIGGER, and the countdown starts on `OnTriggerExit`.
// So this is a region you are INSIDE, not a wall you hit: on `int_01` a sphere
// of radius **2918.7 m** — a `SphereCollider` of radius 0.5 on a transform
// scaled 5837.42 — centred a little off the island.
//
// Leave it and `CountdownToRestart()` ticks once a second up to `resetDelay`,
// then calls `Trigger_Kill.RestartLevel()`. Come back inside and it cancels:
// `OnTriggerEnter` sets `cancelCountdown` and zeroes the counter, so a dip over
// the line costs nothing as long as you turn round.
//
// ── An EXIT is an edge, and that is the whole of this file's bug ──────────
//
// `OnTriggerExit` fires for a collider that WAS INSIDE and has left. Unity never
// fires it for one that was never in there, and `PlayerBoundary.cs` has no
// `OnTriggerStay`, no distance check and nothing in `Start` that looks at where
// the ship is — `OnTriggerExit` is the only thing in the file that calls
// `CountdownToRestart()`. So in 2016, **a ship that spawns outside the sphere is
// not out of bounds.** Nothing happens until it flies in, and then out again.
//
// This file shipped the LEVEL test instead — *are you outside right now?* — and
// the two agree everywhere except the one place it matters. Measured:
//
//     int_01_jumpSeat   spawns 581 m outside its own play area
//     adv_02_jumpSeat   spawns 556 m outside its own play area
//
// Both are Simonet, both carry a 2,047 m sphere centred 2.6 km from where they
// put the ship, and under the level test both began their countdown on frame one
// and reset at `resetDelay + fadeSeconds` = 15.5 s. For ever. Sampling the race
// clock every 2.5 s showed it climb to 15.1 and drop back to 2.1, over and over,
// while the ship snapped to its spawn — **two of the thirteen missions were
// unplayable by anybody**, and no unit test could see it, because every unit
// test in this file starts the ship in the middle of the sphere.
//
// So the state has to remember whether there has ever been an entry to exit
// FROM. `armed` is that, and `stepBoundary` sets it the first frame the ship is
// inside. (`tests/e2e/completion.spec.ts` found this, by flying all thirteen
// missions in a browser.)
//
// ── The two numbers that are not what the code says ───────────────────────
//
//  * `resetDelay` initialises to **10** in C# and every one of the thirteen
//    shipped scenes says **13**. The cardinal rule, for the third time.
//  * The component is **DISABLED in 6 of the 13 missions**, which have no
//    out-of-bounds death at all. A global fallback would quietly give those six
//    a boundary the game never had, which is why the level schema requires both
//    fields with no default to fall back to. The sixth is `rookie_01_jumpSeat`,
//    whose `trigger_playArea` is a DEACTIVATED GameObject carrying
//    `m_Enabled: 1` -- the liveness walk, not the flag (DEV-074).
//
// ── The death itself ──────────────────────────────────────────────────────
//
// `RestartLevel()` fades over 0.1 s, plays "explode2", and waits **2.5 s**
// before reloading — then the reload sets `PlayerPrefs["Respawning"] = "true"`,
// which puts the ship on the RESPAWN marker (127.86 m on `int_01`, the top of
// the shaft) and makes `LaunchElevator.StartLaunch()` bail. So you do not ride
// the lift again; you come back already flying.
//
// The 2.5 s is not padding. It is the beat that makes a reset read as a
// consequence rather than as a stutter.
//
// SIM LAYER: no three, no DOM, no wall clock.

import { distanceSq, type Vec3 } from './math/vec3'

export interface BoundarySpec {
  /** False in 6 of 13 missions, which then have no boundary at all. */
  readonly enabled: boolean
  /** SIM (Unity) space. */
  readonly centre: Vec3
  readonly radius: number
  /** 13 on every shipped mission. The C# initialiser says 10. */
  readonly resetDelaySeconds: number
  /** `Trigger_Kill`'s fade before the reload. 2.5 s. */
  readonly fadeSeconds: number
}

export type BoundaryPhase =
  /** In bounds, or the mission has no boundary. */
  | 'inside'
  /** Out of bounds, on the clock. Turning back cancels it. */
  | 'warning'
  /** The clock ran out. Fading, then the run restarts. Not cancellable. */
  | 'dying'

export interface BoundaryState {
  phase: BoundaryPhase
  /** Seconds outside. Zeroed the moment you come back. */
  outsideFor: number
  /** Seconds into the fade. Only meaningful while dying. */
  dyingFor: number
  /**
   * Has the ship ever been INSIDE? Until it has, there is no exit to fire.
   *
   * `OnTriggerExit` is an edge and Unity only fires it for a collider that was
   * in the volume. Two shipped missions spawn outside their own sphere, so this
   * is the difference between "playable" and "resets every 15.5 seconds". See
   * the header.
   *
   * False again after a death: 2016 RELOADS the scene, so the trigger and the
   * ship are both new, and the respawn marker being inside is what re-arms it.
   */
  armed: boolean
}

export const createBoundary = (): BoundaryState => ({
  phase: 'inside',
  outsideFor: 0,
  dyingFor: 0,
  armed: false,
})

/** Whole seconds left before the reset, or null when there is nothing to show. */
export const boundaryCountdown = (state: BoundaryState, spec: BoundarySpec): number | null => {
  if (state.phase !== 'warning') return null
  return Math.max(0, Math.ceil(spec.resetDelaySeconds - state.outsideFor))
}

/**
 * How far through the countdown you are, 0..1. 0 inside (or with no countdown
 * running), rising linearly across `resetDelaySeconds` while `warning`, and 1
 * for the whole of `dying` — the clock has run out and the fraction is spent.
 *
 * `boundaryCountdown` is the same clock read as whole seconds for the banner
 * and the alarm; this is the continuous reading for anything that GROWS with
 * the danger rather than ticking (DEV-127's signal-loss static). One clock,
 * two readings, both in the layer that owns it.
 */
export const boundaryProgress = (state: BoundaryState, spec: BoundarySpec): number => {
  if (state.phase === 'dying') return 1
  if (state.phase !== 'warning' || !(spec.resetDelaySeconds > 0)) return 0
  const u = state.outsideFor / spec.resetDelaySeconds
  return u < 0 ? 0 : u > 1 ? 1 : u
}

export const isOutside = (position: Vec3, spec: BoundarySpec): boolean =>
  distanceSq(position, spec.centre) > spec.radius * spec.radius

/**
 * Advance one fixed step.
 *
 * Returns true on the single tick the run should RESTART — once per death, so
 * the caller can reset the mission, the ghosts and the ship together.
 *
 * `dying` is deliberately not cancellable. 2016 sets `restarting` and starts an
 * uninterruptible coroutine, so once the fade begins, flying back inside does
 * not save you. That is the difference between a warning and a death.
 */
export const stepBoundary = (
  state: BoundaryState,
  spec: BoundarySpec,
  position: Vec3,
  dt: number,
): boolean => {
  if (!spec.enabled) {
    state.phase = 'inside'
    state.outsideFor = 0
    return false
  }

  if (state.phase === 'dying') {
    state.dyingFor += dt
    if (state.dyingFor < spec.fadeSeconds) return false
    state.phase = 'inside'
    state.outsideFor = 0
    state.dyingFor = 0
    // The scene is reloading. A fresh trigger has fired nothing yet, so the
    // respawn has to put the ship back inside to re-arm it — which is what the
    // respawn marker is for, and what makes a respawn OUTSIDE survivable rather
    // than a loop.
    state.armed = false
    return true
  }

  if (!isOutside(position, spec)) {
    // `OnTriggerEnter`. It zeroes the counter, so a dip over the line is free as
    // long as you turn round, and it does NOT bank partial credit toward the
    // next excursion. It is also the ONLY thing that arms the exit.
    state.phase = 'inside'
    state.outsideFor = 0
    state.armed = true
    return false
  }

  if (!state.armed) {
    // Outside, and never in. There is no `OnTriggerExit` to fire, so 2016's
    // countdown never starts — see the header. Reported as `inside` because that
    // is what it means to the HUD and to the caller: the boundary is not acting
    // on you. Nothing in the port reads `phase` for anything but the warning.
    state.phase = 'inside'
    state.outsideFor = 0
    return false
  }

  state.phase = 'warning'
  state.outsideFor += dt
  if (state.outsideFor >= spec.resetDelaySeconds) {
    state.phase = 'dying'
    state.dyingFor = 0
  }
  return false
}
