// src/sim/jumpseat-refuel.ts — every jump pad is a petrol station.
//
// SIM LAYER: no three, no DOM, no clock, no randomness. Same contract as
// `sim/orbs.ts` and `sim/targets.ts`, and for the same reason: a Target Practice
// run has to burn and refuel identically headless, on replay, and in a headset.
//
// ── Why this file exists at all ───────────────────────────────────────────
//
// `sim/jumpseat.ts` shipped `addFuel()` with a full docstring about the 10
// units/s a pad gives and **no caller anywhere in `src/`**. `level.pads[].refuel`
// has been in the level JSON since the extractor learned pads, and nothing read
// it. So the JumpSeat burned 1.9 units/s from a 100-unit tank with no way back:
// **every JumpSeat mission ran dry at 52.6 s of throttle-on time**, latched the
// thruster off (`disableThisWhenEmpty` IS the Thruster, `jumpseat.ts` §3), and
// fell out of the sky with gravity on. That is not a hard mission; it is a
// mission nobody can finish, and it was invisible because nothing had ever flown
// one — the six JumpSeat missions were flying a HoverJet until DEV-048.
//
// The autopilot is what made it visible, which is exactly what the autopilot is
// for.
//
// ── What 2016 does, line for line ─────────────────────────────────────────
//
// `Trigger_Refuel.cs`, whole:
//
//   · `OnTriggerEnter` with tag Player and a `FuelManager` in the parents sets
//     `refueling = true` — and latches `fuelManager`, so the SAME trigger never
//     re-acquires a different ship.
//   · `Update()` then calls `AddFuel()` every frame while `refueling`.
//   · `AddFuel()` adds `refuelRate * Time.deltaTime` **only while
//     `currentFuel < maxFuel`**, and clears `refueling` once it is over — so a
//     full tank stops the flow without leaving the volume.
//   · `OnTriggerExit` clears `refueling` **for any collider**, not just the
//     Player's. Reproduced as "outside the sphere, no flow", which is the same
//     thing for a one-ship game and does not model a stray trigger exit.
//
// `refuelRate` is 10 on `target_jumppad.prefab` and `_modes-spec.md` §1.4 diffed
// every `m_Modifications` block of all 57 pad instances without finding an
// override, so 10 is the shipped number on every pad of every mission. It rides
// in on the volume rather than being typed here (hard rule 3).
//
// ── Point test, not swept, and that is not the usual shortcut ─────────────
//
// `sim/targets.ts` and `sim/orbs.ts` are both SWEPT because their volumes are
// thin (0.3185 m plates, 4.885 m orbs) against 2.2–5.3 m of travel per step. The
// refuel sphere is **19.707 m in radius** — 39.4 m across — and the JumpSeat's
// fastest measured cruise is 69.5 m/s, which is 0.85 m per step. A refuel volume
// is also not a one-shot award: it pays per tick of contact, so a step that
// clipped a corner of it would be worth 0.12 fuel. There is nothing for a sweep
// to save here.
//
// The number that matters is the opposite one: **how long is a pass worth?** A
// straight line through the centre at the 34.45 m/s level cruise is 39.4 / 34.45
// = 1.14 s = 11.4 units, against the 1.9 units/s the same second costs. So a
// flythrough nets about 9 units and a mission of twelve pads nets ~110 — enough
// to roughly double the tank over a run, and nowhere near enough to fly one. The
// refuel that matters is the one you HOLD for, at +8.1 units/s net, and that is
// a decision `jumpseat-autopilot.ts` makes rather than a property of this file.

import { addFuel, type JumpSeat } from './jumpseat'
import { distanceSq, type Vec3 } from './math/vec3'

/**
 * One pad's refuel volume.
 *
 * `Trigger_Refuel` is authored as a capsule and Unity collapses it to a sphere —
 * `refuel.degenerateToSphere` is true on all 57 shipped instances, so the radius
 * is the whole of the shape. Carried per volume; nothing here invents one.
 */
export interface RefuelSphere {
  /** Centre, SIM space. */
  readonly centre: Vec3
  /** World radius, metres. 19.707 on every shipped pad. */
  readonly radius: number
  /** `Trigger_Refuel.refuelRate`, units per second. 10 on every shipped pad. */
  readonly rate: number
}

export interface RefuelState {
  readonly spheres: readonly RefuelSphere[]
  /** Units added over the whole run. A total, for the tests and the telemetry. */
  added: number
  /** Which sphere paid on the last step, or -1. Read it, do not accumulate it. */
  last: number
  /**
   * Per-sphere multiplier on `rate`, 1 until `applyRefuelBonus` raises it. The
   * shipped game never does — see that function. PER STATE, never shared.
   */
  readonly rateScale: number[]
}

export const createRefuel = (spheres: readonly RefuelSphere[]): RefuelState => ({
  spheres,
  added: 0,
  last: -1,
  rateScale: spheres.map(() => 1),
})

/**
 * `Trigger_JumpTarget.cs:60-63`, the branch 2016 authored and switched off:
 *
 *     if (giveRefuelBonus) refuelTrigger.refuelRate *= refuelMultiplier;
 *
 * Every plate on `target_jumppad.prefab` carries a multiplier — 3 on the
 * bullseye, 1.5 on the mid ring, 1 on the outer — and `giveRefuelBonus: 0`, on
 * all 17 plates, unmodified by any of the 57 shipped instances. So the shipped
 * game refuels at a flat 10/s wherever you touched down, and Matt's memory of
 * fuel depending on where you landed is of this mechanic before the flag was
 * cleared (DEV-121).
 *
 * This is that line, as a pure function: the pad's sphere pays `rate x scale`
 * from now on, and the multiplication COMPOUNDS the way 2016's `*=` did — a
 * second plate on the same pad multiplies again. Nothing in `src/game/` calls
 * it yet; wiring it to a `gameplay.padRefuelBonus` edition flag is Matt's call
 * and DEV-121's row says what it would cost. Classic can never reach it.
 */
export const applyRefuelBonus = (state: RefuelState, sphere: number, multiplier: number): void => {
  if (sphere < 0 || sphere >= state.spheres.length) return
  if (!(multiplier > 0)) return
  state.rateScale[sphere] = (state.rateScale[sphere] ?? 1) * multiplier
}

/**
 * The index of the refuel sphere containing `position`, or -1.
 *
 * Nearest first, so a run that ever ships overlapping pads pays from one of them
 * deterministically rather than from whichever came first in the array.
 */
export const refuelSphereAt = (state: RefuelState, position: Vec3): number => {
  let best = -1
  let bestDistanceSq = Number.POSITIVE_INFINITY
  for (let i = 0; i < state.spheres.length; i++) {
    const sphere = state.spheres[i] as RefuelSphere
    const d = distanceSq(position, sphere.centre)
    if (d > sphere.radius * sphere.radius) continue
    if (d < bestDistanceSq) {
      bestDistanceSq = d
      best = i
    }
  }
  return best
}

/**
 * Advance the refuel by one FIXED step. Returns the sphere that paid, or -1.
 *
 * Call it AFTER the flight model has moved the body, with the body's new
 * position, so a tick that flies into a sphere is paid on that tick.
 *
 * Two behaviours are 2016's and both matter:
 *
 *  - **The flow stops at `maxFuel`.** `AddFuel()` is guarded on `currentFuel <
 *    maxFuel`, so the tank cannot be overfilled by sitting on a pad. There is no
 *    symmetric guard at the bottom — `sim/jumpseat.ts` documents the tank going
 *    NEGATIVE without limit — which is why a deep deficit costs real seconds of
 *    contact before the thruster comes back.
 *  - **`addFuel()` re-enables the Thruster unconditionally**, including on a tank
 *    that is still negative, in which case the next tick's empty check switches
 *    it straight back off. That is in `sim/jumpseat.ts` and this file just calls
 *    it; the one-tick flicker is shipped behaviour and hiding it would make a
 *    pad look broken.
 *
 * **Trap 19.** No module-level scratch: every intermediate is a local, so
 * stepping a second `RefuelState` cannot leave anything behind in the first, and
 * `tests/unit/jumpseat-refuel.test.ts` steps a SECOND seat over a SECOND state to
 * prove it.
 */
export const stepJumpSeatRefuel = (
  state: RefuelState,
  seat: JumpSeat,
  position: Vec3,
  dt: number,
): number => {
  state.last = -1
  if (seat.fuel >= seat.tuning.maxFuel) return -1
  const index = refuelSphereAt(state, position)
  if (index < 0) return -1
  const sphere = state.spheres[index] as RefuelSphere
  const before = seat.fuel
  addFuel(seat, sphere.rate * (state.rateScale[index] ?? 1) * dt)
  state.added += seat.fuel - before
  state.last = index
  return index
}
