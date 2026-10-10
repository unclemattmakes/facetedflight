// src/sim/energy.ts — the boost tank. DEV-143.
//
// SIM LAYER: no three, no DOM, no clock, no randomness. Same contract as
// `sim/speed-chain.ts`, which is the other half of `EnergySystem_Ship`.
//
// ── What Matt said ────────────────────────────────────────────────────────
//
// 2026-09-16, flying the build: *"hold gas + boost as much as you can"* feels
// one-dimensional. It is, and it was in 2016 too — DEV-002 measured it: boost
// is effectively free, at **+68 energy/s net**, so there has never been a
// reason to let go of it.
//
// ── What 2016 shipped, traced ─────────────────────────────────────────────
//
// `EnergySystem_Ship` on `Resources/PlayerShip_SR14_Photon.prefab#11400144` —
// the prefab all seven shipped HoverJet missions instantiate, not the `_unet`
// decoy. Every number below is on the generated sheet at `trust: "verified"`,
// `origin: "shipped-prefab"`, and this file types none of them:
//
//     maxEnergy      100      the tank
//     engineBurnrate   8  ×   BoostBurnrate 4  =  32/s while boosting
//     rechargeRate   100      /s, and it recharges WHILE boosting
//     RebootTime       3      s, 2016's penalty for reaching zero
//
// `EnergySystem_Ship.cs:143-145`:
//
//     if (isBoosting) Burn(engineBurnrate * BoostBurnrate * Time.deltaTime);
//
// and `Recharge()` runs unconditionally above it whenever `currentEnergy <
// maxEnergy`. So the two are SIMULTANEOUS and the net while boosting is
// `rechargeRate - engineBurnrate * BoostBurnrate` = **+68/s**. The tank fills
// while you hold boost. `derived.energy.secondsOfBoostFromFull` on the sheet is
// `null` and its note says why: *"boost never runs out"*. The whole reboot
// subsystem below `currentEnergy <= 0` is unreachable in the shipped game.
//
// Two further 2016 facts, because both are easy to get wrong:
//
//  · `UpdateEnergy()` runs from a 0.06 s coroutine and multiplies by
//    `Time.deltaTime`, which is the FRAME delta — so 2016's absolute rates rode
//    the frame rate and are not a number anyone can port. The RATIO
//    recharge : burn = 100 : 32 is frame-rate free, and it is what "boost is
//    free" actually means. This file is per-second on the fixed step.
//  · `enableGravityOnReboot` is on the prefab and the branch that reads it is
//    **commented out** (`EnergySystem_Ship.cs:218-227`). It is a dead field.
//    Do not cite it as shipped behaviour.
//
// ── What the Anniversary preset changes, and it is ONE number ─────────────
//
// The tank and the burn stay exactly 2016's. `rechargeScale` multiplies the
// shipped recharge, so **1 is the shipped game** — free boost, `+68/s`, the tank
// never moves — and anything below `burn / maxRecharge` = 0.32 makes boost cost
// something. Anniversary runs **0.16**, which is 16/s, and that is not a round
// number chosen for looking tidy:
//
//     recharge = burn / 2          16 = 32 / 2
//     net while boosting           −16/s  →  6.25 s of boost from a full tank
//     refill from empty            100 / 16  =  6.25 s
//     sustainable duty cycle       16 / 32  =  **half the lap on boost**
//
// One design sentence — *you may boost half the time* — and the other three
// numbers fall out of it. That is the second dimension: spend it on the
// straight, bank it through the turn.
//
// ── Empty is a LOCKOUT, not a fall ────────────────────────────────────────
//
// DEV-143 stops at "no boost until it recharges". The fall is DEV-144's
// `energyRace`, which is a mode and needs the crash (DEV-126) under it.
//
// The lockout is `RebootTime` — **the sheet's own answer to "the tank hit
// zero"**, 3 s, with 2016's blackout taken off it. 2016 disables the ship's
// controls, shows reboot screens and hands the tank back at `0.4` units; this
// takes the thrust multiplier away and nothing else.
//
// **The tank recharges THROUGH the lockout, and that is a deliberate
// divergence.** `Reboot()` sets `currentRechargeRate = 0` for the duration and
// then assigns `currentEnergy = 0.4f` — 0.4 units out of 100, which at any
// recharge rate that makes boost cost something is a tank that empties again on
// the next tick, forever. That is a stutter, not a mechanic. Recharging through
// it means a lockout ends with 3 s × 16/s = **48 units**, three seconds of boost
// — enough that coming back is worth something. A hysteresis threshold would be
// the other way to avoid the stutter; the lockout is better because it is a
// number the sheet already carries and a penalty the player can feel and plan
// around.
//
// ── DEV-410: Anniversary has no lockout, and a ring refills the tank ──────
//
// Matt, 2026-09-25, flying v0.11.0 with gas and boost held: *"sometimes going
// super fast, other times it feels like the brakes got hit even though i just
// passed through a ring. i'd expect each ring to build up my boost bar a bit,
// and if i'm boosting through a chain, it should be able to continuously
// refill the boost."* Asked at filing, he chose no lockout.
//
// The brakes were very likely the lockout above. That is read off the
// arithmetic, not measured on his lap. A held boost empties a full tank in
// 6.25 s, then gives 3 s of NO boost, then 3 s of boost off the 48 units the
// lockout recharged, then 3 s out again, for ever. Each lockout drops the
// thrust from 2x to 1x at once, and a ring taken inside one gave nothing back,
// because nothing in this tank read a ring. So there are two new edition
// numbers, and both keep 2016 at their identity value:
//
//  · `lockoutScale` multiplies `RebootTime`. 1 is 2016's 3 s; Anniversary
//    runs 0.
//  · `ringRefill` is the fraction of the tank a ring the player takes puts
//    back (`refillEnergy`, called beside `chainGate` in `boot/app.ts`).
//    Anniversary's 0.5 is derived from the release mission. `int_01`'s
//    longest leg is 513 m ring to ring (a chord, which is a lower bound on
//    the flown path). At the sheet's boosted terminal of 179.6 m/s that is
//    2.86 s of held boost at the net −16/s, or 45.7 units. Half a tank is the
//    smallest round fraction that covers it, so a chain of rings taken at
//    full boost never runs dry. The chain's own speed (18 N a gate) shortens
//    the legs further. `tests/unit/energy.test.ts` computes all of this from
//    the level JSON.
//
// **Follow-up, Matt 2026-09-26: an empty tank is NOTHING.** Asked whether an
// empty tank should give half-power boost, he said *"nothing - i think part of
// the problem is not realizing the boost bar is filling / emptying"*. So a
// preset can now say `reengage`: once the tank runs dry, boost stays out until
// it holds that fraction again, and a ring's refill clears it at once.
// Anniversary runs 0.25, a quarter tank: about 1.6 s of recharge, or one
// ring. That is not the 3 s lockout come back. The wait is measured in the
// TANK the player can see, not on a hidden clock, and a ring ends it. The HUD
// labels the tank and says EMPTY while it lasts. At `reengage` 0 the paragraph
// below is still exactly what happens.
//
// **With no lockout, an empty tank boosts on what the recharge pays.** That is
// `power`, the fraction of one tick's burn the tank could cover. At empty it
// is recharge / burn: 0.5 on Anniversary. So the boost fades to half, and the
// speed eases down to where half a boost holds it, rather than cutting out.
// `lit` stays true while the stick is held, so the engine note and the
// particles do not flicker. Without `power`, "no lockout" would be FREE
// boost: the recharge puts a sliver in the tank at the top of every tick, and
// a boolean boost lit on that sliver burns a whole tick's thrust out of it.

import { HOVERJET } from '@/generated/constants.generated'
import type { HoverJetSheet } from './hoverjet'

/**
 * `EnergySystem_Ship`, as far as BOOST is concerned. Its other half — the
 * per-gate `maxSpeed` chain — is `sim/speed-chain.ts`.
 *
 * Built by `energySpec()` from the sheet and one preset number. Nothing
 * constructs one by hand except the tests, and they say why when they do.
 */
export interface EnergySpec {
  /** The tank. Prefab: 100. */
  readonly maxEnergy: number
  /** Units per second while boost is lit. Prefab: `engineBurnrate × BoostBurnrate` = 32. */
  readonly burnPerSecond: number
  /**
   * Units per second, ALWAYS — 2016 recharges while you boost, so this fights
   * the burn rather than waiting for it to stop. At or above `burnPerSecond`
   * the tank can never empty, which is exactly the shipped game.
   */
  readonly rechargePerSecond: number
  /** Seconds boost stays out after the tank empties. Prefab `RebootTime`: 3. */
  readonly lockoutSeconds: number
  /**
   * DEV-410 follow-up: units the tank must hold again, after running dry,
   * before boost can light. 0 is no wait (2016, and the half-power fade).
   */
  readonly reengageEnergy: number
}

export interface EnergyState {
  /** Units in the tank, 0..`maxEnergy`. */
  energy: number
  /** Seconds of lockout left, or 0. Above 0, boost cannot light however full the tank. */
  lockout: number
  /**
   * Did the last step LIGHT the boost? A reading for the HUD and the audio, so
   * neither has to re-derive the rule. Written every step.
   */
  lit: boolean
  /**
   * DEV-410: the fraction of the last step's burn the tank paid, 0..1. It is 1
   * whenever the tank holds a tick, and recharge / burn at an empty tank with
   * no lockout. The flight model's `boostPower`.
   */
  power: number
  /**
   * DEV-410 follow-up: the tank ran dry and has not yet refilled to
   * `reengageEnergy`. While true, boost cannot light, and the HUD says EMPTY.
   */
  drained: boolean
}

/**
 * The spec for a given preset.
 *
 * `rechargeScale` is the ONE number the edition supplies and it is a multiplier
 * on the shipped recharge rate, never a rate of its own — so `1` is 2016
 * exactly, and a reader can tell at a glance how far a preset has moved. Hard
 * rule 3: everything else comes off the sheet and nothing here is typed.
 *
 * `hoverjet.energy.engineBurnrate` and `hoverjet.energy.BoostBurnrate` MULTIPLY
 * — neither alone is the burn rate, and the sheet's own
 * `derived.energy.boostBurnPerSecond` note says so because it is the shape of
 * mistake that has already been published once.
 *
 * `sheet` is the jet's: 2016's by default, or the aircraft variant's view
 * (DEV-380), so a variant whose boost burns harder (`energy.BoostBurnrate`)
 * empties the tank faster. Pass `jet.sheet`.
 *
 * `lockoutScale` multiplies `RebootTime` (DEV-410). The default of 1 is 2016;
 * the edition passes its own. `reengage` is a fraction of the tank (DEV-410's
 * follow-up), and its default of 0 is no wait.
 */
export const energySpec = (
  rechargeScale: number,
  sheet: HoverJetSheet = HOVERJET,
  lockoutScale = 1,
  reengage = 0,
): EnergySpec => ({
  maxEnergy: sheet.energy.maxEnergy,
  burnPerSecond: sheet.energy.engineBurnrate * sheet.energy.BoostBurnrate,
  rechargePerSecond: sheet.energy.rechargeRate * rechargeScale,
  lockoutSeconds: sheet.energy.RebootTime * lockoutScale,
  reengageEnergy: sheet.energy.maxEnergy * reengage,
})

/**
 * A fresh tank, no lockout. `Awake()` does `currentEnergy = maxEnergy`, which is
 * `startFill` 1, the default (an identity value, not a tuning number: R9).
 *
 * DEV-630: the edition's `gameplay.energy.startFill` is the fraction it starts
 * with, and Anniversary's is 0. An empty start is a DRY tank, exactly as one
 * that just ran out: it waits for the spec's `reengageEnergy` (or a ring)
 * before boost lights, and the HUD says EMPTY until then. `stepEnergy` clears
 * the flag against the live spec, so a preset with no wait lights next tick.
 */
export const createEnergy = (spec: EnergySpec, startFill = 1): EnergyState => {
  const energy = spec.maxEnergy * Math.max(0, Math.min(1, startFill))
  return { energy, lockout: 0, lit: false, power: 0, drained: !(energy > 0) }
}

/**
 * Advance the tank by one FIXED step, and answer whether boost is actually lit.
 *
 * `boostHeld` is the stick. The return is what the flight model should be given
 * — call it BEFORE `stepHoverJet` and pass the answer through, so the thrust
 * and the tank can never disagree about whether this tick was boosted.
 *
 * Order mirrors `UpdateEnergy()`: recharge, then burn. It matters by one tick's
 * worth of energy at the boundary and it costs nothing to get right.
 *
 * **Trap 19.** No module-level scratch and no shared state: the whole step is
 * fields on the `EnergyState` handed in, so stepping a second tank cannot leave
 * anything behind in the first. `tests/unit/energy.test.ts` steps a SECOND one
 * and asserts the first did not move.
 */
export const stepEnergy = (
  state: EnergyState,
  spec: EnergySpec,
  boostHeld: boolean,
  dt: number,
): boolean => {
  if (state.lockout > 0) {
    state.lockout -= dt
    if (state.lockout < 0) state.lockout = 0
  }

  // `if (currentEnergy < maxEnergy) Recharge()`, and Recharge() clamps at the
  // top. Runs whether or not boost is held — see the header.
  if (state.energy < spec.maxEnergy) {
    state.energy += spec.rechargePerSecond * dt
    if (state.energy > spec.maxEnergy) state.energy = spec.maxEnergy
  }

  // DEV-410 follow-up: a dry tank waits until it holds `reengageEnergy` again.
  // At 0 this clears on the very next step, which is no wait at all.
  if (state.drained && state.energy >= spec.reengageEnergy) state.drained = false

  // DEV-410: burn what the tank can pay, up to one tick's worth, and report the
  // fraction as `power`. Above a tick's worth this is 2016 exactly. At the last
  // partial tick before a lockout it is a sliver of one tick, which nobody can
  // feel. At an empty tank with no lockout it is what the recharge paid (see
  // the header).
  let power = 0
  if (boostHeld && state.lockout <= 0 && !state.drained && state.energy > 0) {
    const burn = spec.burnPerSecond * dt
    const paid = state.energy < burn ? state.energy : burn
    state.energy -= paid
    power = burn > 0 ? paid / burn : 1
    // 2016 clamps at 0 (`currentEnergy = 0; hasEnergy = false;`) and never lets
    // the tank go negative, unlike the JumpSeat's, which does. Keep that: a
    // negative tank would make the lockout longer the harder you leaned on it,
    // which is a second penalty nobody asked for.
    if (state.energy <= 0) {
      state.energy = 0
      state.lockout = spec.lockoutSeconds
      state.drained = true
    }
  }
  const lit = power > 0
  state.power = power
  state.lit = lit
  return lit
}

/**
 * DEV-410: a ring the player takes puts `fraction` of the tank back, clamped at
 * the top. It leaves a running lockout alone, so where a preset keeps 2016's
 * lockout, a ring cannot shorten it. Anniversary has none.
 */
export const refillEnergy = (state: EnergyState, spec: EnergySpec, fraction: number): void => {
  if (!(fraction > 0)) return
  state.energy = Math.min(spec.maxEnergy, state.energy + fraction * spec.maxEnergy)
  // A ring ends a dry tank's wait at once, if it paid enough.
  if (state.drained && state.energy >= spec.reengageEnergy) state.drained = false
}

/**
 * DEV-853: hold the tank full, with no lockout and no dry wait. A mode whose
 * boost never runs out (`ModeRules.infiniteBoost`) calls this around the step,
 * so the tank starts full (whatever `startFill` says) and ends each tick full.
 */
export const fillEnergy = (state: EnergyState, spec: EnergySpec): void => {
  state.energy = spec.maxEnergy
  state.lockout = 0
  state.drained = false
}

/** 0..1, for the instrument. The tank as a fraction, never the lockout. */
export const energyFraction = (state: EnergyState, spec: EnergySpec): number =>
  spec.maxEnergy > 0 ? Math.max(0, Math.min(1, state.energy / spec.maxEnergy)) : 0

/**
 * Is boost available AT ALL right now — tank in it and no lockout?
 *
 * Separate from `lit`, which is "you are holding it and it is burning". The HUD
 * needs this one: an empty bar and a locked-out bar look the same and are not,
 * because one of them comes back the instant you let go of something.
 */
export const boostAvailable = (state: EnergyState): boolean =>
  state.lockout <= 0 && !state.drained && state.energy > 0
