// src/audio/engine.ts — the continuous layer. PURE. No Web Audio, no DOM.
//
// ── What this is ──────────────────────────────────────────────────────────
//
// Five loops and the rules that decide which are running: the idle bed, the
// thruster, the afterburner, and the two wind layers — plus, on the Anniversary
// preset only, DEV-137's rumble bed and growl (seven in `ENGINE_LOOPS`). It is
// the only stateful part of the audio port, it is the part with a bug in it if
// anything has one, and it is therefore the part that is pure and unit-tested
// rather than living inside a `webaudio.ts` that node cannot run.
//
// It takes the flight state and an array to write into, and returns a list of
// `CueAction`s. It holds no module-level scratch — see the note at the bottom
// of this header — and it never touches an `AudioContext`.
//
// ── 2016's rules, which are all EDGES and no curves ───────────────────────
//
// There is **zero runtime pitch modulation** in first-party 2016 code, so the
// engine "curve" everyone remembers is discrete loop swaps at fixed pitch.
// The gates, every one traced to a line:
//
//   Thrusters     Input_Ship.cs:407  `device.RightTrigger.Value > 0.05f` (rising)
//                   -> GasPressed() :570 -> PlaySound("Thrusters") :576
//                 Input_Ship.cs:417  `< 0.05f` (falling)
//                   -> GasReleased() :593 -> StopAllOfSound("Thrusters") :599
//                                          + StopAllOfSound("AfterBurner") :600
//   AfterBurner   Input_Ship.cs:426  left AND right trigger, `boostVal < 1`
//                   -> BoostPressed() :630 -> PlaySound("AfterBurner") :635
//                 Input_Ship.cs:435  `LeftTrigger.Value < 0.1f`, `boostVal > 0`
//                   -> BoostReleased() :642 -> StopAllOfSound("AfterBurner") :644
//   AircraftWind  Ship_HoverShip.cs:443 `ForwardSpeed > minEffectsSpeed` (25)
//   FlightWind    Ship_HoverShip.cs:463 the STAGE 1 band only — see below
//   idle          Ship_HoverShip.cs:167 in Start(), once, never stopped
//
// The 0.05 and 0.1 are literals inside METHOD BODIES, not field initialisers,
// so CLAUDE.md's cardinal rule does not apply to them: they are shipped
// behaviour. The four speeds are `public` fields and therefore ARE hypotheses
// in the `.cs` — 5 / 32 / 150 / 190 there — so they come off the shipped
// prefab, through `src/generated/constants.generated.ts`. **No threshold is
// hand-typed in this file.**
//
// ── 240 and 350 ARE audio-relevant, and the survey said they were not ─────
//
// The scoping caveat everyone (this file included, on its first pass) repeats
// is "only 25 and 120 gate audio; 240 and 350 start ParticleSystems and make no
// MasterAudio call". The second half is true and the conclusion drawn from it
// is not. `Ship_HoverShip.cs:461-487` is three branches over ONE particle
// system each, and the only audio call in all three sits inside the first —
// behind `ForwardSpeed < minBoostEffect_stage2_speed && !boostEffects.isPlaying`:
//
//   :463  stage 1   >= 120 and < 240, and boostEffects not already playing
//           -> boostEffects.Play(); stage2.Stop(); stage3.Stop();
//              PlaySound("FlightWind"); FadeOutAllOfSound("AircraftWind", 0.15f)
//   :473  stage 2   >= 240 and < 350   -> stage2.Play(); boostEffects.Stop(); stage3.Stop()
//   :481  stage 3   >  350             -> stage3.Play(); stage2.Stop()   [NOT boostEffects]
//   :489  below 120                    -> all three .Stop()
//
// So 240 is the UPPER BOUND of the branch that makes the sound, and crossing it
// downward clears `boostEffects` — which means every drop from above 240 back
// into the band re-fires `FlightWind` and re-ducks `AircraftWind`. On `int_01`
// the speed chain takes terminal from 182 to 340 m/s over twenty-one gates
// (`src/sim/speed-chain.ts`), so that boundary is crossed repeatedly in a good
// run and the re-duck is part of what fast feels like. It is not a rung with no
// audio on it; it is a guard on the rung that has all of it.
//
// The 350 branch keeps a real asymmetry: it stops stage 2 and does NOT stop
// `boostEffects`. So a ship that reaches stage 1 and then jumps straight to
// stage 3 comes back down to stage 1 with the guard still false and does NOT
// re-duck. That path needs a >110 m/s change in one 12 ms tick and so is
// unreachable in flight — it is transcribed below anyway, because transcribing
// four `.Play()`/`.Stop()` pairs cannot be wrong and deriving them can.
//
// ── The two shipped bugs, and what FF2 does with them ─────────────────────
//
// 1. `AircraftWind` retriggers about every half clip-length, forever, because
//    the `if (!flightEffects.isPlaying)` guard at `Ship_HoverShip.cs:444-445`
//    is commented out. **Not reproduced** — the period is a function of a clip
//    length that cannot be measured without opening a licence-blocked file, and
//    a synthesized loop has no clip. (AUD-2.)
// 2. **Neither wind loop is ever stopped.** `:457`'s and `:497`'s
//    `FadeOutAllOfSound` calls are both commented out and nothing else in the
//    project stops either group. So once you have been fast, the wind is under
//    the rest of the run. **Kept** — same class as the no-auto-level and
//    free-boost bugs Matt kept, and it is most of what high speed sounds like
//    in 2016. `windLoopsNeverStop: false` in the spec turns it off in one edit.
//
// The one thing that IS a stop in the ladder is the duck: `:470`
// `FadeOutAllOfSound("AircraftWind", 0.15f)` fires on the 120 m/s crossing, and
// `:448` puts the layer straight back the next FixedUpdate. That is a dip, not
// a stop, and it is modelled below as two actions on consecutive steps — which
// is literally the 2016 sequence.
//
// ── S4 is an ADDITION, and it is behind one nullable field ────────────────
//
// `EngineAudioSpec.curves` is null on Classic and every line that could emit a
// `modulate` — plus `gateWhooshActions` below — is behind a check on it. So the
// action list this file produces on Classic is the one it produced before the
// Anniversary preset existed, and that is a property of the type rather than of
// a careful reading. On Anniversary the same ladder runs unchanged and the
// curves ride on top of it: the loops still start and stop on 2016's edges, they
// just no longer sit at one gain and one pitch between them. The two exceptions
// are named where they happen — the 120 m/s duck (replaced by the crossfade) and
// `windLoopsNeverStop` (turned off, because a gain curve that reaches silence
// has to be allowed to stop). DEV-084, docs/plan/ANNIVERSARY.md §2.5.
//
// ── DEV-137 is two more additions, behind two more nullable fields ────────
//
// Matt, 2026-09-16: *"i'd love if the engine sfx was more of a deep rumble, and
// changed pitch as we went faster."* `EngineAudioSpec.rumble` starts two loops
// 2016 does not have — `engine.rumble`, the thruster's own recipe an octave
// down and low-passed, under the idle bed for the run; and `engine.growl`, the
// afterburner's an octave down, under the burner only. `EngineAudioSpec.
// pitchTracking` multiplies a rate keyed on FORWARD SPEED into every engine
// voice, slewed in the state so a crash glides rather than chirps. Both null on
// Classic; both read from `content/editions/<preset>.json`, `audio.engine`; and
// unlike S4 neither turns a 2016 behaviour off — the 2016 loops are still on top
// at their authored levels. `tests/unit/audio-engine-sound.test.ts`.
//
// ── Hysteresis is OURS ────────────────────────────────────────────────────
//
// 2016 has none: `:443` is a bare `if (ForwardSpeed > minEffectsSpeed)` on
// every FixedUpdate, and what stops that chattering at 25.0 m/s is the sampled
// clip's own retrigger gate. A synthesized loop has nothing to mask it, so a
// ship holding exactly 25 m/s would strobe the layer at 82 Hz. The band below
// is FF2's, it is small, and it is deviation candidate AUD-3.
//
// ── Trap 19 ───────────────────────────────────────────────────────────────
//
// `ai-racer.ts` shared one module-level scratch object across every racer and a
// finished racer flew on with the other racer's stick. **Nothing in this file
// is module-level and mutable.** The caller owns both the state and the output
// array, and `tests/unit/audio-engine.test.ts` steps a SECOND state and asserts
// the first did not move.

import type {
  EditionEnginePitchTracking,
  EditionEngineRumble,
  EditionEngineSound,
  EditionSpeedCurves,
} from '@/content/edition-schema'
import { HOVERJET, WORLD } from '@/generated/constants.generated'
import { slewToward } from '@/sim/math/scalar'
import type { CueId } from './cues'
import type { Vec3Tuple } from './spatial'
import {
  afterburnerRate,
  rumbleModulation,
  speedRate,
  thrustRate,
  whooshModulation,
  windModulation,
} from './speed-curves'

/** What the system is asked to do with one cue. */
export type CueAction =
  | {
      readonly kind: 'play'
      readonly cue: CueId
      /**
       * WORLD position to emit from, for the one cue 2016 emits from a point.
       *
       * Absent on everything the engine ladder produces — those are the
       * rig-locked cues and they are 2D by measurement, not by omission. See
       * `spatial.ts`. AUD-5.
       */
      readonly at?: Vec3Tuple | null
      /**
       * Multiplies the cue's catalogue gain for THIS play. Absent means 1.
       *
       * Only S4's gate whoosh uses it, and only on Anniversary: everything 2016
       * fires is at its authored level, which is the whole of `mix.ts`. DEV-084.
       */
      readonly gain?: number
      /** Multiplies the resolved pitch for THIS play. Absent means 1. DEV-084. */
      readonly pitch?: number
      /**
       * Play the cue's FIRST variation only, skipping the random pick and the
       * jitter. A pitch ladder is a scale, and a scale needs every rung where it
       * says it is: `ring.pass` has six variations a few semitones apart, which
       * would blur a one-semitone step into noise. DEV-638.
       */
      readonly exact?: boolean
    }
  | { readonly kind: 'stop'; readonly cue: CueId; readonly fadeSeconds: number }
  /** A gain ramp on an already-running loop. 2016's `FadeOutAllOfSound` on a bed. */
  | { readonly kind: 'gain'; readonly cue: CueId; readonly to: number; readonly seconds: number }
  /**
   * A continuous control on a loop that is ALREADY RUNNING. Anniversary only.
   *
   * The one action here that is not an edge, and it exists because S4 is not an
   * edge: `gain` above is a 2016 `FadeOutAllOfSound` with a duration, fired
   * once, where this is a target the backend chases with `setTargetAtTime` on
   * every tick. Nothing emits it when `EngineAudioSpec.curves` is null, which is
   * what makes "Classic sounds exactly as it did" a property of the type rather
   * than of a careful reading. DEV-084.
   */
  | {
      readonly kind: 'modulate'
      readonly cue: CueId
      /** Target gain as a multiple of the cue's catalogue gain. */
      readonly gain?: number
      /** Low-pass cutoff, Hz, on the whole voice. */
      readonly cutoffHz?: number
      /** Playback rate as a frequency multiplier — `CueSpec.pitch`'s meaning. */
      readonly rate?: number
    }

/**
 * A loop that follows one boolean: `play` on the rising edge of `want`, `stop`
 * (with `fadeSeconds`) on the falling one, nothing while it holds. Appends to
 * `out` and returns the loop's new `playing` state for the caller to store.
 *
 * ONLY for loops whose on and off are the same condition read twice. The
 * asymmetric ones are 2016 on purpose and stay inline: thrust's stop also
 * stops the afterburner (`Input_Ship.cs:599-600`), the aircraft and flight
 * winds start and stop on different thresholds and can be told never to stop,
 * and the lift motor latches `arrived`. IU-2.
 */
export const gateLoop = (
  want: boolean,
  playing: boolean,
  cue: CueId,
  fadeSeconds: number,
  out: CueAction[],
): boolean => {
  if (want && !playing) {
    out.push({ kind: 'play', cue })
    return true
  }
  if (!want && playing) {
    out.push({ kind: 'stop', cue, fadeSeconds })
    return false
  }
  return playing
}

export interface EngineAudioSpec {
  /** `minEffectsSpeed`. Above it, `AircraftWind`. Shipped prefab: 25. */
  readonly windSpeed: number
  /** `minBoostEffectsSpeed`. The stage-1 band's floor. Shipped prefab: 120. */
  readonly flightWindSpeed: number
  /**
   * `minBoostEffect_stage2_speed`. The stage-1 band's CEILING — and therefore a
   * guard on the only audio call in the ladder. Shipped prefab: 240.
   */
  readonly stage2Speed: number
  /**
   * `minBoostEffect_stage3_speed`. Shipped prefab: 350.
   *
   * Carried only because `:481` stops stage 2 and pointedly does not stop
   * stage 1, which is the one thing about this rung that reaches audio.
   */
  readonly stage3Speed: number
  /** `RightTrigger.Value > 0.05f` — `Input_Ship.cs:407`. */
  readonly gasThreshold: number
  /** `LeftTrigger.Value < 0.1f` — `Input_Ship.cs:435`. */
  readonly boostReleaseThreshold: number
  /**
   * Fractional band around each speed gate. FF2's, not 2016's. AUD-3.
   *
   * A gate at `t` turns ON above `t * (1 + h)` and OFF below `t * (1 - h)`.
   */
  readonly hysteresis: number
  /** `FadeOutAllOfSound("AircraftWind", 0.15f)` — `Ship_HoverShip.cs:470`. */
  readonly aircraftWindDuckSeconds: number
  /** Where that fade gets to before `:448` replays the layer. */
  readonly aircraftWindDuckGain: number
  /**
   * Keep the 2016 bug: once a wind layer is on it stays on for the run.
   *
   * True is fidelity. False makes both layers follow the speed down through the
   * lower edge of the hysteresis band, which is the game 2016 meant to ship.
   */
  readonly windLoopsNeverStop: boolean
  /** Seconds to fade a loop out when it IS stopped. `Thrusters` despawnFadeTime 0.5. */
  readonly loopStopSeconds: number
  /**
   * The Anniversary preset's continuous controls, or NULL for Classic.
   *
   * Null is the whole of "Classic sounds exactly as it did": every line below
   * that could emit a `modulate` is behind a check on this field, so the action
   * list with it null is the one this file produced before S4 existed — and
   * `tests/unit/audio-engine.test.ts` flies a recorded profile through and
   * asserts exactly that, rather than asserting it by reading.
   *
   * The numbers live in `content/editions/<preset>.json` (hard rule 6). This
   * file holds no curve and no threshold of its own. DEV-084.
   */
  readonly curves: EditionSpeedCurves | null
  /**
   * The rumble bed and the growl under the burner, or NULL for Classic.
   *
   * Two more loops — `engine.rumble`, `engine.growl` — that 2016 does not have,
   * started, stopped and modulated below behind a check on this field and
   * nowhere else. `content/editions/<preset>.json`, `audio.engine.rumble`.
   * DEV-137.
   */
  readonly rumble: EditionEngineRumble | null
  /**
   * Engine pitch that follows FORWARD SPEED, or NULL for Classic.
   *
   * Multiplies S4's throttle rate on the thruster and the burner, and reaches
   * the idle bed and the two rumble loops on its own. Slewed in the state, so a
   * crash walks the pitch down rather than snapping it. `audio.engine.pitchTracking`.
   * DEV-137.
   */
  readonly pitchTracking: EditionEnginePitchTracking | null
}

/**
 * The 2016 ladder, with every threshold read from the generated sheet.
 *
 * `HOVERJET.ship.*` resolves to `PlayerShip_SR14_Photon.prefab#11400174`, the
 * prefab `int_01`'s `Level.ShipPrefab` actually instantiates — not the `_unet`
 * decoy and not the `.cs` initialisers.
 */
export const SHIPPED_ENGINE_AUDIO: EngineAudioSpec = {
  windSpeed: HOVERJET.ship.minEffectsSpeed,
  flightWindSpeed: HOVERJET.ship.minBoostEffectsSpeed,
  stage2Speed: HOVERJET.ship.minBoostEffect_stage2_speed,
  stage3Speed: HOVERJET.ship.minBoostEffect_stage3_speed,
  gasThreshold: 0.05,
  boostReleaseThreshold: 0.1,
  hysteresis: 0.02,
  aircraftWindDuckSeconds: 0.15,
  aircraftWindDuckGain: 0.25,
  windLoopsNeverStop: true,
  loopStopSeconds: 0.5,
  curves: null,
  rumble: null,
  pitchTracking: null,
}

/**
 * The same ladder with S4's curves installed. `null` gives back Classic.
 *
 * **`windLoopsNeverStop` goes off, and that is DERIVED rather than a taste.**
 * The 2016 bug is that `:457` and `:497`'s `FadeOutAllOfSound` calls are
 * commented out, so once a wind layer is on it is on for the run. That is
 * harmless when the layer has one fixed gain and it is a hole when the layer has
 * a gain CURVE: `aircraftWindGain` reaches zero at the 25 m/s threshold, so a
 * loop that may never stop would sit at zero gain forever, holding a voice,
 * inaudible, and never fade back in cleanly. A curve that reaches silence has to
 * be allowed to stop. It is the one behaviour here that is not a number in the
 * preset, which is why it is spelled out. DEV-084.
 *
 * `base` is the CLASSIC spec — the one the system was built with. Call this
 * fresh on every flip; do not layer it on its own output, or a flip back to
 * Classic would keep the `windLoopsNeverStop` this function turned off.
 */
export const engineAudioWithCurves = (
  curves: EditionSpeedCurves | null,
  base: EngineAudioSpec = SHIPPED_ENGINE_AUDIO,
): EngineAudioSpec => (curves ? { ...base, curves, windLoopsNeverStop: false } : base)

/**
 * The same ladder with DEV-137's engine voice installed. `null` — or a block
 * with both flags off — gives back `base` untouched.
 *
 * Each flag is read on its own, because they are two sounds: Matt may want the
 * rumble without the pitch, or the pitch without the rumble, and a preset that
 * says so has to be honoured field by field. Layers on top of whatever `base`
 * is, which in `index.ts` is the curves-installed spec — the two features are
 * orthogonal and neither turns any 2016 behaviour off, so unlike
 * `engineAudioWithCurves` there is nothing here that has to be undone on a flip
 * back.
 */
export const engineAudioWithEngineSound = (
  sound: EditionEngineSound | null,
  base: EngineAudioSpec = SHIPPED_ENGINE_AUDIO,
): EngineAudioSpec => {
  const rumble = sound?.rumble.enabled ? sound.rumble : null
  const pitchTracking = sound?.pitchTracking.enabled ? sound.pitchTracking : null
  if (rumble === base.rumble && pitchTracking === base.pitchTracking) return base
  return { ...base, rumble, pitchTracking }
}

/** Pilot and ship state for one audio step. */
export interface EngineAudioInput {
  /** `Ship_HoverShip.ForwardSpeed` — `localVel.magnitude` at `:410`. m/s. */
  readonly speed: number
  /** Right trigger, [0, 1]. */
  readonly throttle: number
  /** Left trigger held with the right one down. */
  readonly boost: boolean
  /**
   * Has the ship been released?
   *
   * 2016's `Ship_HoverShip.Start()` — and therefore the idle bed — does not run
   * until `Trigger_EnableShip.cs:53` enables the component at the top of the
   * shaft. In FF2 that is `launch.phase === 'flying'`.
   */
  readonly released: boolean
}

export interface EngineAudioState {
  idle: boolean
  thrust: boolean
  afterburner: boolean
  aircraftWind: boolean
  flightWind: boolean
  /**
   * `boostEffects.isPlaying` — the stage-1 particle system.
   *
   * Not decoration: it is the `!boostEffects.isPlaying` half of `:463`, and so
   * it is what decides whether re-entering the 120..240 band re-fires
   * `FlightWind` and re-ducks `AircraftWind`. Named for the 2016 field rather
   * than for what it gates, because that is what makes the transcription
   * checkable against the source.
   */
  stage1: boolean
  /** `boostEffects_stage2.isPlaying`. Stopping it is what re-arms stage 1. */
  stage2: boolean
  /** `boostEffects_stage3.isPlaying`. */
  stage3: boolean
  /**
   * The duck is a two-step sequence, exactly as in 2016: tick N fades
   * `AircraftWind` down (`:470`), tick N+1 replays it at full (`:448`). This
   * flag is the "N+1".
   */
  duckRecoveryPending: boolean
  /** DEV-137: `engine.rumble` is running. Anniversary only. */
  rumble: boolean
  /** DEV-137: `engine.growl` is running — with the burner, and only with it. */
  growl: boolean
  /**
   * DEV-137: the speed-tracking rate as it currently IS, after the slew.
   *
   * The state rather than a derivation from the input, because the whole point
   * of it is to lag the input: a crash puts `speed` to zero in one tick and this
   * takes the second the preset asks for to follow. Seeded to the first tick's
   * target rather than to 1, so a run that begins already moving does not open
   * with a glide from a pitch it was never at.
   */
  trackedRate: number
  /** Whether `trackedRate` has been seeded yet. */
  rateSeeded: boolean
}

export const createEngineAudio = (): EngineAudioState => ({
  idle: false,
  thrust: false,
  afterburner: false,
  aircraftWind: false,
  flightWind: false,
  stage1: false,
  stage2: false,
  stage3: false,
  duckRecoveryPending: false,
  rumble: false,
  growl: false,
  trackedRate: 1,
  rateSeeded: false,
})

/** Put a state back where a fresh one starts. Used on respawn and on exit. */
export const resetEngineAudio = (state: EngineAudioState): void => {
  state.idle = false
  state.thrust = false
  state.afterburner = false
  state.aircraftWind = false
  state.flightWind = false
  state.stage1 = false
  state.stage2 = false
  state.stage3 = false
  state.duckRecoveryPending = false
  state.rumble = false
  state.growl = false
  state.trackedRate = 1
  state.rateSeeded = false
}

/** Above this, a gate that is off turns on. */
export const gateOn = (threshold: number, hysteresis: number): number =>
  threshold * (1 + hysteresis)

/** Below this, a gate that is on turns off — when anything ever turns it off. */
export const gateOff = (threshold: number, hysteresis: number): number =>
  threshold * (1 - hysteresis)

/**
 * Decide which loops should be running, and emit only the CHANGES.
 *
 * `out` is the caller's array and is appended to, never replaced — so this
 * function allocates nothing per tick at 82 Hz and, more to the point, holds no
 * buffer of its own that a second caller could inherit (trap 19).
 *
 * Returns `out` for convenience.
 */
export const stepEngineAudio = (
  state: EngineAudioState,
  input: EngineAudioInput,
  spec: EngineAudioSpec,
  out: CueAction[],
): CueAction[] => {
  // ── the idle bed ──────────────────────────────────────────────────────
  //
  // Once, at release, and never stopped — `Ship_HoverShip.cs:167` is in
  // `Start()` and a project-wide grep finds no stop naming `JumpSeat_Idle`.
  if (input.released && !state.idle) {
    state.idle = true
    out.push({ kind: 'play', cue: 'engine.idle' })
  }

  // ── thrusters ─────────────────────────────────────────────────────────
  //
  // Nothing flies before release, and 2016 agrees by accident: `Input_Ship` is
  // live from spawn but the ship is bolted to the lift, so the trigger does
  // nothing audible. Making it explicit stops a player revving in the hangar.
  const gas = input.released && input.throttle > spec.gasThreshold
  if (gas && !state.thrust) {
    state.thrust = true
    out.push({ kind: 'play', cue: 'engine.thrust' })
  } else if (!gas && state.thrust) {
    state.thrust = false
    out.push({ kind: 'stop', cue: 'engine.thrust', fadeSeconds: spec.loopStopSeconds })
    // `GasReleased()` stops BOTH — `Input_Ship.cs:599-600`. Releasing the
    // throttle kills the afterburner even with the boost still held, and that
    // asymmetry is real: only `GasReleased` stops both, `BoostReleased` stops
    // one.
    if (state.afterburner) {
      state.afterburner = false
      out.push({ kind: 'stop', cue: 'engine.afterburner', fadeSeconds: spec.loopStopSeconds })
    }
  }

  // ── afterburner ───────────────────────────────────────────────────────
  //
  // `Input_Ship.cs:426` needs BOTH triggers, so boost without throttle is
  // silent — and `:435`'s release threshold is 0.1, not 0.05. The caller
  // resolves the analogue left trigger into `boost`; the threshold is carried
  // in the spec so the asymmetry stays visible and testable.
  const burn = gas && input.boost
  state.afterburner = gateLoop(
    burn,
    state.afterburner,
    'engine.afterburner',
    spec.loopStopSeconds,
    out,
  )

  // ── wind ──────────────────────────────────────────────────────────────
  //
  // Gated on `released` like everything else, and that is faithful rather than
  // defensive: `Ship_HoverShip` ships `m_Enabled: 0` and int_01's `Level` has
  // `StartShipSystems: 0`, so `CalculateForwardSpeed()` does not run at all
  // until `Trigger_EnableShip.cs:53` enables the component at the top of the
  // shaft. A ship on the lift has no wind because it has no `Update`.
  const on = (threshold: number): boolean => input.speed > gateOn(threshold, spec.hysteresis)
  const off = (threshold: number): boolean => input.speed < gateOff(threshold, spec.hysteresis)

  if (input.released && !state.aircraftWind && on(spec.windSpeed)) {
    state.aircraftWind = true
    out.push({ kind: 'play', cue: 'wind.aircraft' })
  } else if (state.aircraftWind && !spec.windLoopsNeverStop && off(spec.windSpeed)) {
    state.aircraftWind = false
    out.push({ kind: 'stop', cue: 'wind.aircraft', fadeSeconds: spec.loopStopSeconds })
  }

  // The three boost stages, transcribed from `Ship_HoverShip.cs:461-499`. Only
  // the first makes a sound; the other two exist because stopping stage 1 is
  // what re-arms it. Hysteresis is applied to every boundary, because without
  // it a ship sitting on 240 would toggle stage 1 and stage 2 at 82 Hz and
  // re-duck the wind on every other tick.
  const duckedThisTick = state.duckRecoveryPending
  if (input.released && on(spec.flightWindSpeed)) {
    // :463 — stage 1. The band's floor AND its ceiling gate the audio.
    if (!state.stage1 && input.speed < gateOff(spec.stage2Speed, spec.hysteresis)) {
      state.stage1 = true
      state.stage2 = false
      state.stage3 = false
      // :469. `PlaySound` on a loop that is already running is a retrigger in
      // 2016 and a no-op here; either way the state does not change.
      if (!state.flightWind) {
        state.flightWind = true
        out.push({ kind: 'play', cue: 'wind.flight' })
      }
      // :470. Fires once per entry into the band, not every tick. The recovery
      // is `:448` replaying the layer on the next FixedUpdate.
      //
      // **Suppressed when curves are installed, and that is the point of them.**
      // The duck exists to make room for `FlightWind` arriving at 120. On
      // Anniversary `aircraftWindGain` already rolls off through that band while
      // `flightWindGain` rises — the same gesture, continuous, and audible over
      // 50 m/s rather than over 0.15 s. Leaving the edge in would have it
      // overwritten by the next tick's `modulate`, which is a behaviour that is
      // silently dead rather than deliberately replaced. DEV-084.
      if (state.aircraftWind && !spec.curves) {
        out.push({
          kind: 'gain',
          cue: 'wind.aircraft',
          to: spec.aircraftWindDuckGain,
          seconds: spec.aircraftWindDuckSeconds,
        })
        state.duckRecoveryPending = true
      }
    }
    // :473 — stage 2 stops stage 1, which is what re-arms the duck on the way
    // back down. This is the whole reason 240 belongs in an audio spec.
    if (
      !state.stage2 &&
      on(spec.stage2Speed) &&
      input.speed < gateOff(spec.stage3Speed, spec.hysteresis)
    ) {
      state.stage2 = true
      state.stage1 = false
      state.stage3 = false
    }
    // :481 — and note what is NOT here: stage 3 stops stage 2 and leaves stage
    // 1 alone. 2016's asymmetry, transcribed rather than tidied.
    if (!state.stage3 && on(spec.stage3Speed)) {
      state.stage3 = true
      state.stage2 = false
    }
  } else if (off(spec.flightWindSpeed) && (state.stage1 || state.stage2 || state.stage3)) {
    // :489-499 — all three stopped, and `:497`'s
    // `FadeOutAllOfSound("FlightWind", 0.15f)` is COMMENTED OUT, which is the
    // second of the two kept bugs: the layer stays under the rest of the run.
    state.stage1 = false
    state.stage2 = false
    state.stage3 = false
    if (!spec.windLoopsNeverStop && state.flightWind) {
      state.flightWind = false
      out.push({ kind: 'stop', cue: 'wind.flight', fadeSeconds: spec.loopStopSeconds })
    }
  }

  // The duck's other half. Cleared unconditionally so the flag cannot survive a
  // stop, a respawn or a gate that went the other way: a pending recovery that
  // never fires would leave the wind 12 dB down for the rest of the run with
  // nothing in the state to say why, which is the shape of bug this whole file
  // is arranged to prevent. `duckedThisTick` keeps a duck raised on THIS tick
  // from being cancelled on the same tick.
  if (duckedThisTick) {
    state.duckRecoveryPending = false
    if (state.aircraftWind) {
      out.push({
        kind: 'gain',
        cue: 'wind.aircraft',
        to: 1,
        seconds: spec.aircraftWindDuckSeconds,
      })
    }
  }

  // ── S4: the continuous layer, which 2016 does not have ────────────────
  //
  // Below this line is DEVIATION DEV-084 and nothing above it is. One `modulate`
  // per loop that is running, every tick, and the backend chases each target
  // with `setTargetAtTime` — so the curve is heard as a movement rather than as
  // a staircase at 82 Hz.
  //
  // It runs AFTER the ladder on purpose: `state` is this tick's answer, so a
  // loop that started this tick is modulated in the SAME action list, while its
  // voice gain is still at the bottom of its fade-in. That is what lets
  // `aircraftWindGain` start at zero and have the layer rise out of nothing
  // instead of snapping to the authored level and being pulled back.
  if (spec.curves) {
    // `rate` is DEV-425's: the air rises in PITCH as well as swelling and
    // brightening. Unslewed, unlike the engine's — the wind has no mass to
    // spin down, so a crash that stops the air may stop its pitch too, and the
    // backend's `MODULATE_TAU` already turns the 82 Hz steps into a glide.
    const wind = windModulation(spec.curves, input.speed)
    if (state.aircraftWind) {
      out.push({
        kind: 'modulate',
        cue: 'wind.aircraft',
        gain: wind.aircraftGain,
        cutoffHz: wind.cutoffHz,
        rate: wind.rate,
      })
    }
    if (state.flightWind) {
      out.push({
        kind: 'modulate',
        cue: 'wind.flight',
        gain: wind.flightGain,
        cutoffHz: wind.cutoffHz,
        rate: wind.rate,
      })
    }
  }

  // ── DEV-137: the rate that tracks the AIR, slewed ─────────────────────
  //
  // S4 keyed the engine on the throttle and said why: the engine answers the
  // stick, the wind answers the air, and conflating them makes a jet sound like
  // a car. This does not conflate them — it MULTIPLIES them. The throttle rate
  // is still the fast, direct answer to the stick; this is a slower, smaller
  // term for how hard the engine is working against the air, and it is the
  // term that lets a pilot hear 300 m/s as different from 90 with the same
  // trigger held. Speed in m/s, the same `ForwardSpeed` the wind reads.
  //
  // Slewed HERE, in the state, not in the backend: `MODULATE_TAU` smooths a
  // 82 Hz staircase into a ramp over ~180 ms, which is anti-zipper plumbing.
  // This is a rate LIMIT over a second, which is a design choice about what a
  // stall sounds like, and it belongs beside the number that sets it.
  let speedMul = 1
  if (spec.pitchTracking) {
    const target = speedRate(spec.pitchTracking, input.speed)
    if (!state.rateSeeded) {
      state.trackedRate = target
      state.rateSeeded = true
    } else {
      // `slewToward` keeps a stall from chirping: a crash puts the speed to zero in
      // one fixed step, and a rate that followed it would drop four semitones in
      // 12 ms. Called once a tick with `slewPerSecond * dt`, so the rate walks down
      // over the second the preset asks for.
      state.trackedRate = slewToward(
        state.trackedRate,
        target,
        spec.pitchTracking.slewPerSecond * WORLD.fixedDeltaTime,
      )
    }
    speedMul = state.trackedRate
  }

  // The throttle half, S4's, or 1 where the curves are not installed — so a
  // preset with the pitch tracking on and the curves off (a legitimate thing to
  // author by hand) still gets a rate on every engine voice.
  const throttleThrust = spec.curves
    ? thrustRate(spec.curves, input.throttle, state.afterburner)
    : 1
  const throttleBurner = spec.curves ? afterburnerRate(spec.curves, input.throttle) : 1

  // Throttle, not speed, on the S4 half. See the note above: the two terms are
  // kept apart in the arithmetic and multiplied once, here.
  if (spec.curves || spec.pitchTracking) {
    if (state.thrust) {
      out.push({ kind: 'modulate', cue: 'engine.thrust', rate: throttleThrust * speedMul })
    }
    if (state.afterburner) {
      out.push({ kind: 'modulate', cue: 'engine.afterburner', rate: throttleBurner * speedMul })
    }
  }
  // The idle bed has no throttle term — 2016 authored it at one fixed 0.55 and
  // S4 left it there — so it moves with the air alone, and only when asked.
  if (spec.pitchTracking && state.idle) {
    out.push({ kind: 'modulate', cue: 'engine.idle', rate: speedMul })
  }

  // ── DEV-137: the rumble bed, and the growl under the burner ───────────
  //
  // Two loops 2016 does not have. The rumble starts with the idle bed and runs
  // for the run, like the bed it sits under; the growl is tied to the
  // afterburner's own edges, which the ladder above has already decided this
  // tick. Both are modulated every tick, and both ride the SAME rate as the
  // loop they double, so the sub stays an octave under the thruster whatever
  // the throttle and the air are doing — "locked to the fundamental" is a
  // property of the arithmetic, not of a tuning.
  if (spec.rumble) {
    if (input.released && !state.rumble) {
      state.rumble = true
      out.push({ kind: 'play', cue: 'engine.rumble' })
    }
    state.growl = gateLoop(
      state.afterburner,
      state.growl,
      'engine.growl',
      spec.loopStopSeconds,
      out,
    )
    if (state.rumble) {
      const m = rumbleModulation(spec.rumble, input.throttle, state.afterburner)
      out.push({
        kind: 'modulate',
        cue: 'engine.rumble',
        gain: m.gain,
        cutoffHz: m.cutoffHz,
        rate: throttleThrust * speedMul,
      })
    }
    if (state.growl) {
      out.push({
        kind: 'modulate',
        cue: 'engine.growl',
        gain: spec.rumble.growlGain,
        cutoffHz: spec.rumble.boostCutoffHz,
        rate: throttleBurner * speedMul,
      })
    }
  } else {
    // The flag went off under a running voice — a preset flip mid-run. Put
    // both away, or the rumble outlives the setting that asked for it.
    if (state.rumble) {
      state.rumble = false
      out.push({ kind: 'stop', cue: 'engine.rumble', fadeSeconds: spec.loopStopSeconds })
    }
    if (state.growl) {
      state.growl = false
      out.push({ kind: 'stop', cue: 'engine.growl', fadeSeconds: spec.loopStopSeconds })
    }
  }

  return out
}

/**
 * The gate whoosh, as an action, or nothing at all on Classic.
 *
 * Separate from `stepEngineAudio` because a gate is an EVENT and the ladder is a
 * per-tick state machine — but it lives in this file because it is the other
 * half of the same deviation and it reads the same `curves`. `index.ts` calls it
 * with the speed the last `stepFlight` was given, which in `app.ts` is the same
 * fixed step the gate was scored in: the ring test and the audio step are both
 * inside `stepFixed`, and the audio step runs first.
 *
 * Returns `out` for convenience, appending nothing when curves are null.
 * DEV-084.
 */
export const gateWhooshActions = (
  speed: number,
  spec: EngineAudioSpec,
  out: CueAction[],
): CueAction[] => {
  if (!spec.curves) return out
  const { gain, pitch } = whooshModulation(spec.curves, speed)
  out.push({ kind: 'play', cue: 'gate.whoosh', gain, pitch })
  return out
}

/**
 * Every loop this machine can leave running, for a clean teardown.
 *
 * Written as a list rather than derived from the state so that "stop everything"
 * is correct even when the state is lying — which, after a `windLoopsNeverStop`
 * run followed by an exit to the hangar, it structurally is.
 */
export const ENGINE_LOOPS: readonly CueId[] = [
  'engine.idle',
  'engine.thrust',
  'engine.afterburner',
  'engine.rumble',
  'engine.growl',
  'wind.aircraft',
  'wind.flight',
]
