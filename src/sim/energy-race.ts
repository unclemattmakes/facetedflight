// src/sim/energy-race.ts — the tank as a clock. DEV-144.
//
// SIM LAYER: no three, no DOM, no wall clock, no randomness.
//
// ── What this is ──────────────────────────────────────────────────────────
//
// The early-prototype mode, from the playthrough triage: *"gates give energy,
// run dry and you fall."* It turns Ring Attack into a survival race — the same
// course, the same gates, the same scoring, with a tank underneath it that only
// a gate refills.
//
// It is NOT DEV-143's boost tank with a bigger appetite. DEV-143 charges for
// boost against a tank that refills by itself; this one **never refills by
// itself**, drains whenever the engine is lit, and ends the run at zero. One
// vehicle never has both: the mode row decides which, and `game/modes.ts` is
// the only file that knows the modes by name.
//
// ── The structure is 2016's, the numbers are the shipped prefab's ─────────
//
// `Energy_System.cs` — the PROTOTYPE class, and the reason the triage calls
// this "the early prototype" — is the only place in the 2016 tree where energy
// drains from flying rather than only from boosting:
//
//     if (enginesHot) {
//         if (isBoosting) Burn(engineBurnrate * BoostBurnrate * Time.deltaTime);
//         if (enginesOn)  Burn(engineBurnrate * Time.deltaTime);
//     }
//
// Note that both fire: boosting costs the engine burn AND the boost burn, so
// boost is a `1 + BoostBurnrate` = 5x surcharge on the drain, not a 4x
// replacement of it. That is the shape this file ports.
//
// **Hard rule 2 applies and is respected.** `Energy_System` is on no shipped
// prefab, so its field INITIALISERS are hypotheses and none of them is used
// here. What is taken from it is the STRUCTURE — which burn applies when — and
// every NUMBER comes off `EnergySystem_Ship` on
// `Resources/PlayerShip_SR14_Photon.prefab#11400144`, the component the shipped
// missions instantiate: `maxEnergy` 100, `engineBurnrate` 8, `BoostBurnrate` 4.
// (The two classes declare the same field names, which is why the sheet lists
// `Energy_System.cs` lines among the consumers of those keys.)
//
// ── The two preset numbers, and what measured them ───────────────────────
//
// Sizing a survival clock needs to know how long a HoverJet actually goes
// between gates, and the port has two recordings of the shipped game that
// answer it. Measured off `content/ghosts/int_01_*` against
// `content/levels/int_01_hoverJet.json`'s 21 trigger spheres — all 21 matched
// on both clips:
//
//                        gate-to-gate (s)              release   run home
//                   min   p50   p90   max   mean      -> gate 1  (last ring
//                                                                -> finish)
//     fast ghost   1.82  2.59  3.56  6.93  2.70         9.89 s     0.89 s
//     slow ghost   3.54  4.78  6.57  6.79  4.93         9.34 s     1.63 s
//
// **The run home is one second, not twenty-five.** The first pass read it as
// `ghost.duration - lastGateTime` and got 24.5 s, which is the recording
// rolling on while the ship coasts to a stop long after the finish — DEV-027's
// lesson exactly ("say what the number is the time OF"), and it would have
// sized the tank at twenty times what the mode needs. The binding stretch is
// the OTHER end: **release to gate 1, 9.9 s**, the longest gateless run either
// pilot makes.
//
// Then SWEPT, because a first pass reasoned from those numbers to `drainScale`
// 0.3 and the sweep refused it: at 0.3 everything died **at gate 0 or gate 1**,
// in the 9.9 s opening stretch, and the racing was never the difficulty at all.
// A mode whose whole challenge is the run-up is not the mode that was asked
// for. (Replaying both ghosts' real gate schedules at boost duty cycles of
// 0 / 25 / 50 / 75 / 100 % is what showed it; the arithmetic that produced 0.3
// was about the LAP and never looked at the start.)
//
// What the sweep settled on:
//
//  · `drainScale` **0.2**, and it is `1 / (1 + BoostBurnrate)` rather than a
//    round number — so **boosting costs exactly the shipped `engineBurnrate`,
//    8/s**, which is a 12.5-second tank, and cruising costs a fifth of it. The
//    boost rate is the sheet's own number; the cruise rate is that number over
//    the surcharge. One relation, no invention in the magnitude.
//  · `gatePayFraction` **0.35** — a third of a tank, 4.4 s of boost or 21.9 s
//    of cruise. This one is tuned, not derived.
//
// What that pair does to the two 2016 pilots, lowest tank over the lap:
//
//     boost duty     0%    25%    50%    75%   100%
//     fast ghost     84     68     52     26      0   (finishes on empty)
//     slow ghost     85     69     54      9   DIED   (at gate 2, 21 s)
//
// **The 2016 fast lap is exactly what a full-boost run costs.** That knife edge
// is the anchor, and it is a measurement rather than a feeling: cruise and
// half-boost are comfortable for anybody, three-quarters is a good line's
// privilege, and flat out is the fast line's alone.
//
// `scoring.energyBoostAmount` is in the level JSON already (`TriggerCheckpoint`
// sets `energyBoost` on every shipped gate and pays 12), and this file does not
// read it — deliberately. It is a `code-default` private field, identical on all
// 21 gates and on every gate of every mission, so it carries no per-course
// variation to preserve; and at 12 units a gate is 7.5 s of cruise and 1.5 s of
// boost, which the sweep shows is a mode with no middle: cruising is free and
// anything past a quarter throttle-on-boost kills the slow line before gate 3.
// The field stays available for the day a course wants a big gate and a small
// one.

import { HOVERJET } from '@/generated/constants.generated'
import type { HoverJetSheet } from './hoverjet'

/** The clock's three rates. Built by `energyRaceSpec`; nothing types a number. */
export interface EnergyRaceSpec {
  /** The tank. Prefab `maxEnergy`: 100. */
  readonly maxEnergy: number
  /** Units per second while the engine is lit. `engineBurnrate x drainScale`. */
  readonly drainPerSecond: number
  /**
   * Units per second while boosting, INCLUDING the engine burn.
   * `Energy_System.cs` fires both branches, so this is `drain x (1 +
   * BoostBurnrate)` — a 5x surcharge, not a 4x replacement.
   */
  readonly boostDrainPerSecond: number
  /** Units a gate pays. `gatePayFraction x maxEnergy`. */
  readonly gatePay: number
}

export interface EnergyRaceState {
  /** Units in the tank, 0..`maxEnergy`. */
  energy: number
  /**
   * Is the ship still flying under its own power?
   *
   * False is terminal for the run: `LaunchElevator.FinishLaunch()` switches
   * gravity OFF for a HoverJet, and this is that switch reversed. The caller
   * puts gravity back on and cuts the thrust; from there it is a falling body
   * and DEV-126's crash rule is what ends it.
   */
  powered: boolean
  /** Units taken from the tank over the run. A total, for the tests. */
  drained: number
  /** Units paid in by gates over the run. */
  paid: number
}

/**
 * The spec for a preset.
 *
 * Both arguments are the edition's; everything else is the sheet's. The boost
 * surcharge is `1 + BoostBurnrate` for the reason in the header — 2016's
 * prototype burns the engine AND the boost on a boosting tick.
 *
 * `sheet` is the jet's, as for `energySpec`: 2016's by default, an aircraft
 * variant's view when one is flying (DEV-380). Pass `jet.sheet`.
 */
export const energyRaceSpec = (
  drainScale: number,
  gatePayFraction: number,
  sheet: HoverJetSheet = HOVERJET,
): EnergyRaceSpec => {
  const drain = sheet.energy.engineBurnrate * drainScale
  return {
    maxEnergy: sheet.energy.maxEnergy,
    drainPerSecond: drain,
    boostDrainPerSecond: drain * (1 + sheet.energy.BoostBurnrate),
    gatePay: sheet.energy.maxEnergy * gatePayFraction,
  }
}

/** A full tank, under power. `Awake()` does `currentEnergy = maxEnergy`. */
export const createEnergyRace = (spec: EnergyRaceSpec): EnergyRaceState => ({
  energy: spec.maxEnergy,
  powered: true,
  drained: 0,
  paid: 0,
})

/**
 * A gate pays. Clamped at the top, exactly as `AddEnergy()` is:
 *
 *     currentEnergy = Mathf.Clamp(currentEnergy + energy, 0f, maxEnergy);
 *
 * **A dead ship is not revived by a gate it falls through.** `powered` is
 * terminal for the run; without that, a wreck tumbling through the next ring
 * would light its engines again in mid-air, which is a different game and a
 * very silly one.
 */
export const payGate = (state: EnergyRaceState, spec: EnergyRaceSpec): void => {
  if (!state.powered) return
  const before = state.energy
  state.energy = Math.min(spec.maxEnergy, state.energy + spec.gatePay)
  state.paid += state.energy - before
}

/**
 * Advance the tank by one FIXED step, and answer whether the ship still has
 * power.
 *
 * `engineOn` is `throttle > 0` — `Energy_System.cs`'s `enginesOn`, which is the
 * throttle axis and not the airspeed. **Coasting costs nothing**, which is
 * 2016's structure and turns out to be the mode's most interesting decision:
 * cutting the engine on a straight saves the tank and costs you the race
 * against a clock that is still running.
 *
 * Returns false on the tick the tank empties and on every tick after it. The
 * caller reads that as: gravity back on, throttle and boost dead.
 *
 * **Trap 19.** No module-level scratch: every intermediate is a local and the
 * whole step is fields on the state handed in, so a second racer's tank cannot
 * move the first's. `tests/unit/energy-race.test.ts` proves it.
 */
export const stepEnergyRace = (
  state: EnergyRaceState,
  spec: EnergyRaceSpec,
  engineOn: boolean,
  boostHeld: boolean,
  dt: number,
): boolean => {
  if (!state.powered) return false
  const rate = boostHeld ? spec.boostDrainPerSecond : engineOn ? spec.drainPerSecond : 0
  if (rate > 0) {
    const take = rate * dt
    const before = state.energy
    state.energy -= take
    if (state.energy <= 0) {
      state.energy = 0
      state.powered = false
    }
    state.drained += before - state.energy
  }
  return state.powered
}

/** 0..1, for the instrument. */
export const energyRaceFraction = (state: EnergyRaceState, spec: EnergyRaceSpec): number =>
  spec.maxEnergy > 0 ? Math.max(0, Math.min(1, state.energy / spec.maxEnergy)) : 0

/**
 * Seconds of flight left at the CURRENT demand, or Infinity while coasting.
 *
 * The number a survival mode is actually about, and the reason it is exported:
 * a bar says how full the tank is, and what a pilot needs to know is how long
 * that is worth at the throttle they are holding — which is four times shorter
 * with boost in. Nothing draws it yet; the row says so.
 */
export const secondsOfFlight = (
  state: EnergyRaceState,
  spec: EnergyRaceSpec,
  engineOn: boolean,
  boostHeld: boolean,
): number => {
  const rate = boostHeld ? spec.boostDrainPerSecond : engineOn ? spec.drainPerSecond : 0
  return rate > 0 ? state.energy / rate : Number.POSITIVE_INFINITY
}
