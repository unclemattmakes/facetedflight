// src/sim/jumpseat-stranded.ts — a dry seat nothing can refill ends the run. DEV-342.
//
// SIM LAYER: no three, no DOM, no clock, no randomness, and no numbers of its
// own — every threshold arrives in a `StrandedSpec` from the seam, which says
// where each one comes from. Same contract as `sim/jumpseat-refuel.ts`.
//
// ── The soft-lock this closes ─────────────────────────────────────────────
//
// `FuelManager.disableThisWhenEmpty` IS the Thruster, and it LATCHES: at zero
// fuel the thruster switches off and only `addFuel()` switches it back on
// (`sim/jumpseat.ts` §3). `addFuel()` has exactly one caller, a pad's refuel
// sphere. So a seat that runs dry anywhere a sphere cannot reach it falls, lands,
// and sits there for ever — the hover motor is still on, so on the Simonet sea it
// floats at about 1 km/h — with the clock running, no ending in Target Practice
// (DEV-056: `clockEnds` is false), no boundary to cross, and nothing on screen
// saying why. Found by the autopilot on `int_01_jumpSeat`, 2 runs of 2, and a
// human who runs dry over water reaches the same state.
//
// **2016 had it too.** Every `FacetedTerrain` carries a `TerrainCollider`
// (`FacetedTerrain.cs:622-627`), the ocean plate included, so the 2016 seat lands
// ON the sea as the port's does. The JumpSeat's only 2016 death is
// `Trigger_Reset` on `collider_head` — the pilot's head touching anything not
// tagged Player — and a seat parked on its gear holds the head about 3 m clear
// of the water. So this is a DEVIATION, and Matt's call (2026-09-24): a
// stranded run RESTARTS, as an out-of-bounds death and DEV-144's empty energy
// tank already do. DEVIATIONS.md, DEV-342.
//
// ── "Stranded" is four facts at once, and each one is load-bearing ────────
//
//   · the seat is LIVE — before `Trigger_EnableJumpShip` fires there is no
//     thruster to be out, and the tank is full anyway;
//   · it BURNS fuel — Free Flight does not (`FuelManager.cs:30`), and a tank that
//     cannot empty cannot strand anybody;
//   · the thruster is LATCHED OFF — not "the tank is low": a negative tank inside
//     a sphere is being paid off and relights, and that is a pad working;
//   · it is outside EVERY refuel sphere and SUPPORTED — a dry seat falling onto
//     a pad lands in the sphere and relights, which is the one rescue 2016
//     offers, so the rule waits for the fall to end rather than judging it
//     mid-air.
//
// All four must hold for `restSeconds` without a break; any tick that breaks one
// starts the count again.
//
// ── "Supported" is VERTICAL speed, and the horizontal is ignored on purpose ─
//
// Measured on flat ground with the seam's own collision spec (the sea is flat
// too): a dry seat that lands level creeps at a steady 0.31 m/s — the playtest's
// "about 1 km/h" — but one that lands with 0.2 rad of pitch SAILS on its hover
// motor at a steady 4.2 m/s, for ever. The hover motor is still switched on and
// its impulse is along the body's own up, so a tilted seat is pushed sideways by
// exactly what holds it up. A "slower than X" test would therefore either miss
// the tilted landing, which is still a soft-lock, or need X above 4.2 m/s.
//
// What separates "stranded" from "still falling towards a pad" is the vertical:
// with the thruster gone nothing opposes gravity but a surface, and at |g| = 32
// the vertical speed of a free fall changes by 32 m/s every second, so it can sit
// inside ±`verticalSpeed` for at most 2·verticalSpeed/32 seconds. Held there for
// `restSeconds`, something — ground, sea, a pad's bowl, or the hover cushion over
// any of them — is carrying the seat. The trade: a dry seat SAILING towards a
// pad whose sphere dips to the surface is restarted on the way. No shipped
// mission is known to allow that rescue, and the row says so.
//
// ── Then 2016's own JumpSeat death, timed off `Trigger_Reset` ─────────────
//
// Once stranded, the phase goes to `dying` for `holdSeconds` and THEN the step
// returns true, once, which is the caller's cue to restart the run. The curtain is
// the caller's; the clock it waits on is this one, the shape `sim/boundary.ts`'s
// `dying` phase already has.

import type { JumpSeat } from './jumpseat'
import { type RefuelState, refuelSphereAt } from './jumpseat-refuel'

export interface StrandedSpec {
  /** Seconds all four conditions must hold, unbroken, before the run is lost. */
  readonly restSeconds: number
  /**
   * Vertical speed, m/s, under which the seat counts as carried by a surface.
   * See "Supported is VERTICAL speed" above: free fall leaves this band within
   * 2·verticalSpeed/|g| seconds, far inside `restSeconds`.
   */
  readonly verticalSpeed: number
  /** Seconds of `dying` between being stranded and the restart. */
  readonly holdSeconds: number
}

/**
 * `ok` — flying, or dry but still able to reach a pad.
 * `stranding` — every condition holds; `restFor` is counting.
 * `dying` — the run is lost; `dyingFor` counts down to the restart.
 */
export type StrandedPhase = 'ok' | 'stranding' | 'dying'

export interface StrandedState {
  phase: StrandedPhase
  /** Seconds the conditions have held unbroken. 0 in `ok`. */
  restFor: number
  /** Seconds spent in `dying`. */
  dyingFor: number
}

export const createStranded = (): StrandedState => ({ phase: 'ok', restFor: 0, dyingFor: 0 })

/** Back to `ok` — the respawn's half. PER STATE, never shared (trap 19). */
export const resetStranded = (state: StrandedState): void => {
  state.phase = 'ok'
  state.restFor = 0
  state.dyingFor = 0
}

/**
 * Is this seat, this tick, dry, outside every pad's sphere, and carried?
 *
 * Exported for the tests, which pin each of the four conditions on its own.
 */
export const strandedNow = (seat: JumpSeat, refuel: RefuelState, spec: StrandedSpec): boolean => {
  if (!seat.live || !seat.burnsFuel || seat.thrusterEnabled) return false
  if (refuelSphereAt(refuel, seat.body.position) >= 0) return false
  return Math.abs(seat.body.velocity.y) < spec.verticalSpeed
}

/**
 * Advance one FIXED step. Returns true on the single tick the run should
 * restart, and at no other time.
 *
 * Call it AFTER the refuel has run, so a tick that brings the seat into a sphere
 * is judged inside it. `dying` does not look back: once the run is lost it is
 * lost, the way `sim/boundary.ts`'s `dying` is — the curtain is already coming
 * down and a relight half-way through it would be a restart the player watched
 * being cancelled.
 */
export const stepJumpSeatStranded = (
  state: StrandedState,
  seat: JumpSeat,
  refuel: RefuelState,
  spec: StrandedSpec,
  dt: number,
): boolean => {
  if (state.phase === 'dying') {
    // True on the CROSSING tick only, so a caller that has not reset yet cannot
    // restart the run twice.
    const before = state.dyingFor
    state.dyingFor += dt
    return before < spec.holdSeconds && state.dyingFor >= spec.holdSeconds
  }
  if (!strandedNow(seat, refuel, spec)) {
    state.phase = 'ok'
    state.restFor = 0
    return false
  }
  state.phase = 'stranding'
  state.restFor += dt
  if (state.restFor >= spec.restSeconds) {
    state.phase = 'dying'
    state.dyingFor = 0
  }
  return false
}
