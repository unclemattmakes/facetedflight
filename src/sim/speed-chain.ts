// src/sim/speed-chain.ts — every gate makes you faster. This is the game.
//
// ── What was missing ──────────────────────────────────────────────────────
//
// The HoverJet's terminal speed is `2 x maxSpeed / (mass x drag)` — 437.5 x 2
// over 4 x 1.2 — which is **182.3 m/s**, and the port sat there. The 2016
// ghost recording of this same course spends **52 % of its run faster than
// that**, peaking at 308 m/s. Not a tuning difference: a flight the ported model
// cannot produce at all.
//
// The mechanic is `EnergySystem_Ship.IncreaseSpeed()`, and the comment above it
// says the whole thing:
//
//   "each ring increases the ships max speed. ships max speed returns to normal
//    if they don't go through another ring within a certain amount of time."
//
// `TriggerCheckpoint` calls it on every gate whose `energyBoost` is set, which
// is **every shipped gate** — the flag was extracted into
// `routes[].rings[].scoring.energyBoost` and nothing read it.
//
// So: +18 to `maxSpeed` per gate, falling back to base after 5.5 s without one.
// Terminal goes 182 -> 340 m/s over twenty-one gates. It is why the boost
// effects have stages at 120, 240 and 350 (`render/particles.ts`), and it is why
// a clean run feels different from a scrappy one.
//
// ── How we know it shipped, given the component is DISABLED ───────────────
//
// `EnergySystem_Ship` is `m_Enabled: 0` on the shipped prefab, which under this
// project's own liveness rules should end the argument. Two things overrule it:
//
//  1. A disabled MonoBehaviour still runs public methods called from OUTSIDE,
//     and `TriggerCheckpoint` calls this one directly. `enabled` gates Unity's
//     own callbacks, not the C# method table.
//  2. The ghosts. Without the chain, 52 % of `int_01_leftSpawn_fast_01` is above
//     the terminal speed the ship can reach — impossible. With it, 6 %, and that
//     residue is the resolution of the gate-crossing times. A recording of the
//     shipped game outranks a serialised flag.
//
// ── The one thing we chose ────────────────────────────────────────────────
//
// `SpeedTimer()` resets `maxSpeed` to `_startingMaxSpeed`, which `Start()`
// assigns — and `Start()` does NOT run on a disabled component, so in the
// shipped build that field is arguably **0**, and a broken chain would stop the
// ship dead. The ghosts say otherwise: the fast run has one gap over 5.5 s and
// carries on at 190 m/s afterwards rather than coasting to nothing. So the
// fallback here is the BASE max speed. See DEV-019.
//
// SIM LAYER: no three, no DOM, no wall clock.

import { FIXED_DT } from './constants'
import { fullStickRate } from './rigidbody'

/** `EnergySystem_Ship`, as far as speed is concerned. */
export interface SpeedChainSpec {
  /** Added to `maxSpeed` per gate. Code-default 18 — private, never serialised. */
  readonly increment: number
  /** Seconds without a gate before it all falls back. Prefab: 5.5. */
  readonly cooldownSeconds: number
}

export interface SpeedChainState {
  /** Gates banked. Multiplied by `increment` to raise `maxSpeed`. */
  stacks: number
  /** Seconds since the last gate. Only meaningful while `stacks > 0`. */
  sinceGate: number
}

export const createSpeedChain = (): SpeedChainState => ({ stacks: 0, sinceGate: 0 })

/**
 * Bank a gate.
 *
 * 2016 does `maxSpeed += speedIncreaseAmt` with no ceiling, so this does not cap
 * either — twenty-one gates is +378, and a course with more would give more.
 * `currentCooldownTime = 0` on every call, so the clock restarts rather than
 * continuing.
 */
export const chainGate = (state: SpeedChainState): void => {
  state.stacks += 1
  state.sinceGate = 0
}

/**
 * Advance the cooldown.
 *
 * The fall-back is all-or-nothing: 2016 assigns `maxSpeed = _startingMaxSpeed`,
 * it does not decay. Twenty gates of chain vanish in one assignment the instant
 * the timer expires, which is what makes a missed gate expensive rather than
 * merely slow.
 */
export const stepSpeedChain = (state: SpeedChainState, spec: SpeedChainSpec, dt: number): void => {
  if (state.stacks === 0) return
  state.sinceGate += dt
  if (state.sinceGate >= spec.cooldownSeconds) {
    state.stacks = 0
    state.sinceGate = 0
  }
}

/** Whole seconds left before the chain drops, or null when there is no chain. */
export const chainCountdown = (state: SpeedChainState, spec: SpeedChainSpec): number | null => {
  if (state.stacks === 0) return null
  return Math.max(0, Math.ceil(spec.cooldownSeconds - state.sinceGate))
}

/** The ship's `maxSpeed` right now: base plus the chain. */
export const chainedMaxSpeed = (
  state: SpeedChainState,
  spec: SpeedChainSpec,
  baseMaxSpeed: number,
): number => baseMaxSpeed + spec.increment * state.stacks

/**
 * Terminal speed for a given `maxSpeed`, boosted.
 *
 * Equilibrium of Unity's linear drag against the thrust force: the engine spools
 * to `boostMultiplier x maxSpeed` newtons, and drag removes `drag` of the
 * velocity per second, so `v = F / (mass x drag)`.
 *
 * Exported because it is how the chain is checked against the ghosts — a speed
 * above this is a flight the model cannot produce, and counting those is what
 * proved the mechanic.
 */
export const terminalSpeed = (
  maxSpeed: number,
  boostMultiplier: number,
  mass: number,
  drag: number,
): number => (boostMultiplier * maxSpeed) / (mass * drag)

/**
 * The speed the FIXED-STEP integrator actually settles at under a constant
 * thrust, m/s: {@link terminalSpeed}'s discrete twin. DEV-382.
 *
 * `integrate` does `v += F/m · dt` and then `v *= (1 − drag · dt)`, which is
 * the recurrence `fullStickRate` solves for the angular half; so this IS that
 * fixed point, with `F/m` in the torque's place, and there is one definition
 * of it. It is `terminalSpeed × (1 − drag · dt)`, one tick of drag under the
 * continuous answer, and it is the formula the sheet's own
 * `derived.hoverjet.terminalSpeedCruise` is computed with
 * (`a*(1-drag*dt)/drag`). The sheet ROUNDS that to four places (89.8115); this
 * is the unrounded number the ship reaches, and `tests/unit/variant-racers.test.ts`
 * holds it both to the sheet's figure and to a flight.
 *
 * Why a racer needs it off its OWN sheet rather than the sheet's derived row:
 * a variant scales `ship.maxSpeed` and `rigidbody.drag`, and a number read off
 * 2016's derived block is 2016's speed whatever the racer is flying.
 */
export const tickTerminalSpeed = (
  thrust: number,
  mass: number,
  drag: number,
  dt: number = FIXED_DT,
): number => fullStickRate(thrust / mass, drag, dt)
