// src/boot/app/run-state.ts: one run's state, as ONE record with one owner.
// APP-SPLIT phase 3, slice 2 (`docs/plan/APP-SPLIT.md` §4b).
//
// `bootApp` held these as closure `let`s, written by `restartRun`, by the sim
// tick and by `switchMission`, each in its own place. They are one run's
// state: the mission clock, the medal in the air and the finish latch, the
// crash and its curtain, the death curtain, the stranded and head banners'
// edges, the two tanks and boost's edge, the result on the panel, and
// `?snap=`'s hold. The record holds them; the closure reads and writes
// `run.x`. The field docs below are the ones those `let`s carried, moved
// verbatim. `mission` itself was already one object (`Object.assign`ed at
// every start) and stays the closure's constant.
//
// Types only: nothing here builds anything, so it is safe to import from a
// node test.

import type { Award, FinishLatch } from '@/game/award-line'
import type { RunSummary } from '@/render/results'
import type { CrashState } from '@/sim/crash'
import type { EnergyState } from '@/sim/energy'
import type { EnergyRaceState } from '@/sim/energy-race'
// DEV-143. The boost tank: `sim/energy.ts` owns the arithmetic and takes every
// number but the preset's `rechargeScale` off the generated sheet.
// DEV-144. The energy race's tank: gates pay in, flying takes out, empty is the
// end of the run. Never live at the same time as the boost tank above.
import type { HeadPhase } from '@/sim/jumpseat-head'
import type { StrandedPhase } from '@/sim/jumpseat-stranded'
// `terrainHeightAt` is gone from this file with DEV-042's lift: the title rig's
// height is now 2016's own, composed rather than rescued, and the mission
// terrain's field is passed straight to the sim. Nothing here samples ground.
// DEV-388: the generated-content manifest, digested for a room's `join` (§6.7).
import { _headQuat } from './head-scratch'

export interface RunState {
  /**
   * Is the curtain down for a DEATH? Edge state, so `begin` fires once.
   *
   * Driven off `sim/boundary.ts`'s own `dying` phase rather than off the
   * respawn call, which means every way out of that phase lifts the curtain —
   * the respawn, a mission swap replacing the boundary, anything. A flag set by
   * one call site and cleared by another is how a screen stays black for ever.
   */
  dyingCurtain: boolean
  /**
   * The stranded rule's phase as the banner last saw it (DEV-342). Edge state,
   * so "OUT OF FUEL" is raised once per stranding and not every tick of one.
   */
  strandedShown: StrandedPhase
  /**
   * The JumpSeat head strike's phase as the banner last saw it (DEV-403). The
   * same edge state, so "CRASHED" goes up once per strike.
   */
  headShown: HeadPhase
  /**
   * The crash (DEV-126): the player's own state, and the curtain over its hold.
   *
   * Same shape as `dyingCurtain`: the sim's `crashed` phase is the clock, and
   * the curtain begins on the tick it starts and is released on the tick it
   * ends. Rebuilt with the mission — a hold cannot outlive the run it happened
   * in, and a curtain left down over a fresh run is a black screen for ever.
   */
  crash: CrashState
  crashCurtain: boolean
  /**
   * DEV-143 — the boost tank, and the lockout it latches when it empties.
   *
   * **HoverJet only.** `EnergySystem_Ship` is a component on
   * `PlayerShip_SR14_Photon.prefab` and the JumpSeat has its own, different
   * tank: an ANALOG boost against `FuelManager` at a 2.35x burn multiplier,
   * refilled by pads (`sim/jumpseat-refuel.ts`). Two tanks on one vehicle would
   * be two mechanics for one trigger.
   *
   * The spec is rebuilt from the LIVE preset every tick rather than captured,
   * so a preset flip mid-run changes the rate without a reload — everything in
   * it but `rechargeScale` is a constant off the sheet, so this is three
   * property reads and a multiply. The STATE persists across a flip: Classic
   * never steps it, so flipping Anniversary on hands over a full tank, which is
   * the only honest starting point for a mechanic that was not running.
   */
  energy: EnergyState
  /**
   * Was boost available on the previous tick? The EDGE, so the panel can say
   * something at the moment it changes.
   *
   * Matt has had G1's proximity meter on the panel since DEV-110 and reports
   * (2026-09-16) never having seen it move his score, while G2's gate bonus —
   * which announces itself on the event line at the instant it pays — is the
   * feedback he singled out as working. A gauge is a reading; a lever needs a
   * moment. This is that moment's trigger.
   */
  boostWasAvailable: boolean
  /**
   * DEV-144 — the energy race's tank. A different mechanic from the one above
   * and never live at the same time: `rulesFor(RUNNING_MODE).energyPowered`
   * picks, and the two `if`s below are mutually exclusive by that flag.
   *
   * Built from the live preset at every restart. `powered` going false is
   * terminal for the run, which is why the state is rebuilt rather than reset
   * in place — a wreck's tank must not be the next run's.
   */
  energyRace: EnergyRaceState
  /**
   * A medal crossed IN THE AIR, and when to stop showing it.
   *
   * Free Flight is the only mode that awards mid-run — `LevelEnd.cs:202-243`
   * pops `panel_medalAwarded` the instant the orb count reaches a threshold and
   * `DisableMedalUI()` hides it 2.5 s later. It is the one part of the two
   * unimplemented modes that shipped working, and it is an EVENT rather than a
   * reading, so the caller owns the clock.
   */
  award: Award | null
  /** DEV-397: what the event line held at the finish (`game/award-line.ts`). */
  awardLatch: FinishLatch | null
  /**
   * Filled the frame a run ends; read by the panel until the next run starts.
   *
   * The RUN's numbers only. The race outlives the run, so the standings are
   * joined on every frame the panel is up (`withStandings`, DEV-344).
   */
  lastResult: RunSummary | null
  /**
   * `?snap=` has fired and the sim is held. Its OWN flag, never `paused`.
   *
   * The pause plate keys off `paused`, and a snap must not put a menu in the
   * photograph — which is the whole reason these are two booleans and not one.
   * Nothing resumes a snap except `restartRun`, which re-arms it.
   */
  snapped: boolean
  elapsed: number
}
