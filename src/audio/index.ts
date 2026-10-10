// src/audio/index.ts — the audio system. One object, five methods, no three.
//
// ── The whole API ─────────────────────────────────────────────────────────
//
//   const audio = createAudioSystem()        // makes no AudioContext yet
//   await audio.resume()                     // ON A USER GESTURE. see below.
//   audio.event({ type: 'gate.passed', index: 3, kind: 'ring' })
//   audio.stepFlight({ speed, throttle, boost, released })   // every sim tick
//   audio.stopAll()                          // leaving the cockpit
//
// Everything else is a setting. `src/boot/app.ts` should need exactly those
// five calls plus one `?audio=off` switch; see the note at the end of the
// session that produced this module for the exact sites.
//
// **S4 adds a sixth, and it is a setting rather than a call in the loop:**
// `audio.setSpeedCurves(curves)` at boot and on an edition flip. With null
// curves — Classic — every S4 line in `engine.ts` is skipped and this system
// produces the action list it produced before the preset existed. DEV-084.
//
// **DEV-424 adds the ride's pair:** `audio.setLiftSound(lift)` beside it, and
// `audio.stepLift({ rise })` once per fixed step while the lift holds the ship
// — the one per-tick call besides `stepFlight`, because the motor follows the
// platform and only the rise says how fast that is (`lift.ts`).
//
// ── Lazy on a gesture, and it MUST survive `suspended` ────────────────────
//
// Every browser blocks an `AudioContext` created outside a user gesture, and
// Chrome additionally suspends one that has been idle or whose tab lost focus.
// Neither is an error state, and a system that treats them as one is a system
// that goes permanently silent the first time someone tabs away mid-run. So:
// the context is built on the first `resume()`, `resume()` is safe to call on
// every gesture forever, and a `play()` before the context exists is a silent
// no-op rather than a throw. The game must not care whether it has sound.
//
// In a headset the gesture is the first controller press, which arrives long
// before anything wants to make a noise — the title screen's A is the same
// button that starts the game. On a flat screen it is the first key or click.
//
// ── This module is renderer-free, and all but two cues are 2D ─────────────
//
// Not a shortcut: it is what 2016 does. `MasterAudio.cs`'s `sourceTrans == null`
// branch emits a non-positional cue from the bank's own transform, and
// `PlayerShipInitialization.cs:34-37` parents that bank to the camera rig at
// local origin — so every ordinary `PlaySound` in the shipped game plays AT THE
// LISTENER, unattenuated, despite all 33 groups being configured `ForceTo3D`
// with `MinDistance 10` / `MaxDistance 500`. Rendering those 2D is the port.
//
// **Two cues take the other branch in 2016 and are genuinely 3D there** — the
// shaft whoosh (`PlaySound3DAtVector3` from eight trigger boxes 12 m apart) and
// the opposition's engines (raw `AudioSource`s, Doppler 1.04, 48/800 m). AUD-5,
// and `spatial.ts`'s header has the evidence. Those two carry a WORLD position;
// the geometry is `spatial.ts`, the nodes are `webaudio.ts`, and the rule that
// the sim says where things are while the audio system only READS that is
// unchanged: nothing here imports `three` or touches the DOM.
//
// The listener must be fed a head pose — `setListener()`, every frame, from
// `camera.getWorldPosition()` and NOT `camera.position`, which in the cockpit is
// the head offset inside the XR rig (CLAUDE.md trap 18).
//
// ── What is NOT here ──────────────────────────────────────────────────────
//
// Ducking (there is none in 2016 — `mix.ts`), positional audio (above), and
// anything that reads the DOM beyond the one `AudioContext` constructor that
// `webaudio.ts` probes for.
//
// **Music IS here, and it needs exactly one more call.** `music.ts` fetches,
// decodes, crossfades, shuffles without replacement and degrades to silence;
// `event()` below starts it on the two moments 2016 starts it. What it has is
// zero tracks, because the soundtrack is a licensing act and not a commit
// (D31). Installing one is `audio.music.setTracks([...])` and nothing else.

import type {
  EditionEngineSound,
  EditionLiftSound,
  EditionSpeedCurves,
} from '@/content/edition-schema'
import {
  type AudioBackend,
  createRecordingBackend,
  createSilentBackend,
  type PlayOptions,
  type RecordingBackend,
} from './backend'
import { CUES, type CueId, type CueSpec, resolveVariation } from './cues'
import {
  type CueAction,
  createEngineAudio,
  ENGINE_LOOPS,
  type EngineAudioInput,
  type EngineAudioSpec,
  type EngineAudioState,
  engineAudioWithCurves,
  engineAudioWithEngineSound,
  gateWhooshActions,
  resetEngineAudio,
  SHIPPED_ENGINE_AUDIO,
  stepEngineAudio,
} from './engine'
import { type AudioEvent, actionsForEvent, MISSION_END_FADE_SECONDS } from './events'
import {
  createJumpChargeAudio,
  type JumpChargeAudioState,
  stepJumpChargeAudio,
} from './jump-charge'
import {
  createLiftAudio,
  LIFT_LOOPS,
  type LiftAudioState,
  resetLiftAudio,
  stepLiftAudio,
} from './lift'
import { clampGain, MASTER_SFX } from './mix'
import {
  createMusicPlaylist,
  DEFAULT_MUSIC_BANK,
  type MusicBank,
  type MusicPlaylist,
} from './music'
import {
  MUSIC_FILTER_OPEN,
  type MusicFilter,
  type MusicListening,
  musicFilterChanged,
  musicFilterFor,
} from './music-filter'
import { createRacerEngines, type RacerEngines } from './racer-engines'
import type { ListenerPose, Vec3Tuple } from './spatial'
import { createWebAudioBackend } from './webaudio'

export interface AudioSystemOptions {
  /**
   * Where sound goes. Defaults to WebAudio where there is an `AudioContext`,
   * and to silence where there is not — a node import, or `?audio=off`.
   */
  readonly backend?: AudioBackend
  readonly engineSpec?: EngineAudioSpec
  /**
   * Injected so variation choice is assertable.
   *
   * `src/audio/` is not the sim layer, so `Math.random()` is allowed here and
   * is the default. But "the ring ding really does use all six variations" is
   * a property worth a test, and a test cannot assert it against a real RNG.
   */
  readonly random?: () => number
  /**
   * Which MasterAudio bank the music playlist is under — and therefore whether
   * its crossfade is 2 s or 1 s. Default `'mission'`.
   *
   * 2016 had two banks because it had two scenes; FF2 has one process, so this
   * is what would let a menu-only playlist keep the menu bank's shorter fade if
   * one is ever wanted. See `music.ts`.
   */
  readonly musicBank?: MusicBank
}

/**
 * One sim tick of the player's craft: the engine ladder's input, plus the
 * jumping spider's charge (DEV-383) — undefined on every other seat and on the
 * HoverJet, 0 on a spider that is not charging.
 */
export type FlightAudioInput = EngineAudioInput & { readonly jumpCharge?: number | undefined }

/** One fixed step of the lift ride. DEV-424. */
export interface LiftAudioInput {
  /** `launch.rise` this step: metres above the spawn marker. */
  readonly rise: number
}

/** What an out-of-process test can see of the lift's voice. DEV-424. */
export interface LiftAudioProbe {
  /** The platform's derived speed on the last step, m/s. */
  readonly speed: number
  /** `elevator.motor` is running. */
  readonly motor: boolean
  /** The platform has come to rest and the arrival has played. */
  readonly arrived: boolean
  /** Whether a preset has installed the lift's voice (false on Classic). */
  readonly enabled: boolean
}

export interface AudioSystem {
  /** True once a real output is running. False until the first gesture. */
  readonly running: boolean
  readonly backend: AudioBackend
  readonly music: MusicPlaylist
  /**
   * The AI racers' engines — the one part of the mix that follows objects.
   *
   * Owned here so its handles have exactly one owner and `stopAll()`/`dispose()`
   * cannot leave one behind.
   */
  readonly racerEngines: RacerEngines
  /** Call on every user gesture. Cheap, idempotent, and fixes a suspended context. */
  resume(): Promise<void>
  /** One discrete moment. See `AudioEvent`. */
  event(event: AudioEvent): void
  /**
   * Where the ears are, WORLD space. Call once per RENDERED frame.
   *
   * A frame, not a sim tick: this follows the head, and the head moves at
   * display rate. **`camera.getWorldPosition()`, never `camera.position`** — in
   * the cockpit the camera is a child of the XR rig, so the local one is the
   * lean offset and the rig carries the altitude (CLAUDE.md trap 18).
   */
  setListener(listener: ListenerPose): void
  /** The continuous layer. Call once per FIXED sim step, with that tick's state. */
  stepFlight(input: FlightAudioInput): void
  /**
   * Install the Anniversary preset's speed curves, or `null` for Classic.
   *
   * Call it at boot and again from `editionState.subscribe` — it is cheap,
   * idempotent, and takes effect on the next tick. **It does not touch anything
   * already sounding**, deliberately: a flip mid-run leaves the loops where they
   * are and the next `stepFlight` either starts modulating them or stops, which
   * is the only behaviour that is right in both directions. The one thing that
   * does not follow a flip back to Classic is the modulation already applied to
   * a running voice; it is corrected the moment that loop is next restarted, and
   * the flip is a menu action that leaves the cockpit anyway.
   *
   * `content/editions/<preset>.json` holds every number. DEV-084.
   */
  setSpeedCurves(curves: EditionSpeedCurves | null): void
  /**
   * Install the Anniversary preset's engine voice — the rumble and the
   * speed-tracking pitch — or `null` for Classic. DEV-137.
   *
   * Takes the whole `audio.engine` block and reads each flag itself, so the
   * caller hands over content and does not repeat the "enabled ? x : null"
   * that `setSpeedCurves` asks for. Same contract otherwise: cheap, idempotent,
   * takes effect on the next tick, and a flip mid-run is handled by the ladder
   * (a rumble whose flag went off is stopped on the next step). Reaches the AI
   * racers' engines too, through the one owner they have.
   */
  setEngineSound(sound: EditionEngineSound | null): void
  /**
   * The lift ride's motor and arrival, or `null` for Classic. DEV-424.
   *
   * The same contract as the two setters above: cheap, idempotent, takes effect
   * on the next `stepLift`, and a flip to null under a running motor stops it.
   */
  setLiftSound(sound: EditionLiftSound | null): void
  /**
   * One fixed step of the RIDE — call it from the branch that holds the ship on
   * the platform, with that step's `launch.rise`. DEV-424.
   *
   * A step and not an event because the motor follows the platform's speed, and
   * the speed is the rise's difference from one step to the next (`lift.ts`).
   */
  stepLift(input: LiftAudioInput): void
  /** The lift's voice as it stands. DEV-424. */
  readonly lift: LiftAudioProbe
  /**
   * The SFX output gain. Clamped to [0, 1].
   *
   * This is the PLAYER's volume — `masterGainFor(settings)` in `volume.ts`, off
   * the comfort settings — and not 2016's `_masterAudioVolume`, which is a
   * different number in a different place: `cueGain` already multiplies it into
   * every `CueSpec.gain`. Applying it here as well is what made the game play
   * 2.5 dB under its own authored level until DEV-065; one master factor, one
   * place.
   *
   * Safe before `resume()`, and that is the point: `app.ts` sets the stored
   * volume the moment it builds the system, long before a gesture makes an
   * `AudioContext`, and the backend carries it onto the master node when one
   * appears. A volume applied after the first cue is a volume the player hears
   * the game ignore.
   */
  setMasterGain(gain: number): void
  /** The music output gain — `musicGainFor(settings)`. 2016's `PlaylistMasterVolume` is in it. */
  setMusicGain(gain: number): void
  /**
   * DEV-645: what the game is doing, as far as the soundtrack is concerned. Call
   * it once a frame; the filter pair on the music bus follows the curve in
   * `music-filter.ts` and the backend is only told when the target moves. Never
   * touches a volume.
   */
  setMusicListening(listening: MusicListening): void
  /**
   * Duck the music (volume only): `amount` 0 (open) to 1 (ducked), over `seconds`.
   * DEV-643: through a crash's black, back with the fade. Independent of the
   * player's volume. DEV-645's music filter may extend this node.
   */
  duckMusic(amount: number, seconds: number): void
  /** Everything off. The cockpit exit, the restart, the tab going away. */
  stopAll(fadeSeconds?: number): void
  dispose(): void
}

/** 2D, and there is nothing to resolve. Shared because it is frozen. */
const NO_POSITION: PlayOptions['position'] = null

/**
 * A missing position and an explicit 2D one are the same thing.
 *
 * `CueAction.at` is optional because 15 of the 16 event branches have no
 * position to give; `PlayOptions.position` is `| null` because the backend
 * needs one answer rather than two. This is the one line that reconciles them,
 * so no branch of the map has to remember to write `at: null`.
 */
const positionOf = (at: Vec3Tuple | null | undefined): Vec3Tuple | null => at ?? NO_POSITION

/**
 * Build the system. Makes no `AudioContext` and touches no DOM.
 *
 * Safe to call at module scope, in a test, or in a worker — which is the point:
 * `app.ts` can own an `AudioSystem` from its first line and only the first
 * `resume()` needs a gesture behind it.
 */
export const createAudioSystem = (options: AudioSystemOptions = {}): AudioSystem => {
  const random = options.random ?? Math.random
  const backend = options.backend ?? createDefaultBackend()
  /**
   * The CLASSIC ladder, kept as the base that S4's curves are layered onto.
   *
   * Held separately from `spec` so `setSpeedCurves(null)` can put the system all
   * the way back — `engineAudioWithCurves` also turns `windLoopsNeverStop` off,
   * and deriving from the live spec would keep that flip after a flip back.
   */
  const baseSpec = options.engineSpec ?? SHIPPED_ENGINE_AUDIO
  let spec: EngineAudioSpec = baseSpec
  /**
   * The two preset blocks the live spec is built FROM, kept so that either
   * setter can rebuild the whole spec from `baseSpec` without losing the
   * other's contribution — and without layering a `with*` on its own output,
   * which `engineAudioWithCurves` says not to do.
   */
  let curves: EditionSpeedCurves | null = null
  let engineSound: EditionEngineSound | null = null
  const rebuildSpec = (): void => {
    spec = engineAudioWithEngineSound(engineSound, engineAudioWithCurves(curves, baseSpec))
  }
  /**
   * The forward speed the last `stepFlight` was given.
   *
   * The gate whoosh is scaled by the speed you took the gate at, and this is
   * where that speed comes from — not from a new argument on `event()`. In
   * `app.ts` both live in the same `stepFixed` and the audio step runs FIRST, so
   * by the time `stepMission` reports a ring this is that tick's speed. Taking
   * it from the event instead would have meant a second `Math.hypot` at a call
   * site four agents were editing in parallel, for the same number.
   */
  let lastSpeed = 0
  const music = createMusicPlaylist({
    backend,
    random,
    bank: options.musicBank ?? DEFAULT_MUSIC_BANK,
  })
  const engine: EngineAudioState = createEngineAudio()
  // DEV-383. Per system, like `engine` (trap 19). `jump-charge.ts` owns the cue.
  const jumpCharge: JumpChargeAudioState = createJumpChargeAudio()
  const racerEngines = createRacerEngines(backend)
  /** DEV-645: the last filter target the backend was given. Per system (trap 19). */
  let musicFilterLast: MusicFilter = MUSIC_FILTER_OPEN
  // DEV-424. Per system, like `engine` (trap 19). `lift.ts` owns the motor.
  const lift: LiftAudioState = createLiftAudio()
  let liftSound: EditionLiftSound | null = null
  /**
   * Put the lift's voice away and forget the ride. On `launch.start` as well as
   * on `mission.end`: those two bracket a ride, and a state carried across
   * either would difference one platform against another (`lift.ts`).
   */
  const endLift = (fadeSeconds: number): void => {
    for (const id of LIFT_LOOPS) if (lift.motor) backend.stop(id, fadeSeconds)
    resetLiftAudio(lift)
  }

  // ── ONE scratch array, owned by ONE system ────────────────────────────
  //
  // Trap 19: a module-level scratch object read across two calls is a channel
  // between two objects that do not know about each other, and it cost a
  // session when `ai-racer.ts` shared one `HoverJetInput` across every racer.
  // This array is per-system, never handed out, and truncated at the top of
  // every use rather than at the bottom — so a throw mid-dispatch cannot leave
  // a stale action to be replayed by the next tick.
  const pending: CueAction[] = []

  const apply = (actions: readonly CueAction[]): void => {
    for (const action of actions) {
      switch (action.kind) {
        case 'play':
          play(action.cue, action.at, action.gain, action.pitch, action.exact)
          break
        case 'stop':
          backend.stop(action.cue, action.fadeSeconds)
          break
        case 'gain':
          backend.setCueGain(action.cue, action.to, action.seconds)
          break
        // S4. Never reached on Classic — nothing emits one with null curves.
        // The action IS the modulation, minus two fields the backend ignores;
        // rebuilding it field by field would only be a place to forget one.
        case 'modulate':
          backend.modulate(action.cue, action)
          break
      }
    }
  }

  const play = (
    id: CueId,
    at?: Vec3Tuple | null,
    gainScale?: number,
    pitchScale?: number,
    exact?: boolean,
  ): void => {
    const s: CueSpec = CUES[id]
    // 2016's `retriggerPercentage: 100` — the cue cannot interrupt itself.
    // `Thrusters`, `JumpSeat_Idle` and `whoosh` carry it, and every looping cue
    // here is treated the same way: asking a running bed to start again is a
    // no-op, not a second voice. Without this, holding the throttle would stack
    // an engine loop every tick.
    if (s.retrigger === 'ignore' && backend.isPlaying(id)) return
    // DEV-638: a ladder rung skips the lottery and plays the cue as authored.
    const { pitch, detuneCents } = exact
      ? { pitch: s.pitch, detuneCents: 0 }
      : resolveVariation(s, random)
    // Both scales are absent on everything 2016 fires, and `?? 1` is what keeps
    // that true — `mix.ts` is the authored level and only S4's gate whoosh
    // departs from it. DEV-084.
    backend.play(s, {
      pitch: pitch * (pitchScale ?? 1),
      detuneCents,
      position: positionOf(at),
      gain: gainScale ?? 1,
    })
  }

  return {
    get running() {
      return backend.running
    },
    backend,
    music,
    racerEngines,
    async resume() {
      await backend.resume()
    },
    setListener(listener) {
      backend.setListener(listener)
    },
    event(event) {
      pending.length = 0
      actionsForEvent(event, pending)
      // ── S4's gate whoosh ──────────────────────────────────────────────
      //
      // Appended HERE rather than inside `actionsForEvent` because that map is
      // pure over the event alone — it has no spec, no curves and no speed, and
      // giving it three so one preset can add one cue would put the Anniversary
      // deviation into the file that IS the 2016 port. `gateWhooshActions`
      // appends nothing when the curves are null, so Classic's action list for a
      // gate is the same two cues it has always been.
      //
      // A RING only. `kind` is absent on the pad and orb callers, which 2016
      // sounds identically (`Trigger_JumpTarget.cs:66` plays the same
      // `CollectRing`), and neither is a thing you fly through.
      if (event.type === 'gate.passed' && event.kind === 'ring') {
        gateWhooshActions(lastSpeed, spec, pending)
      }
      apply(pending)
      // The engine's own state has to follow the moments that invalidate it,
      // or the first tick after a restart thinks the thruster is already
      // running and never starts it. `mission.end` is the one event that means
      // "none of what you believe is true any more".
      if (event.type === 'mission.end') {
        for (const id of ENGINE_LOOPS) backend.stop(id, MISSION_END_FADE_SECONDS)
        resetEngineAudio(engine)
        // DEV-383: a charge held through the end of a run must not hum on into
        // the hangar, and the next run's first charge must start it again.
        backend.stop('jump.charge', MISSION_END_FADE_SECONDS)
        jumpCharge.playing = false
        // Same argument: a run that ended at 300 m/s must not size the first
        // whoosh of the next one.
        lastSpeed = 0
        // The opposition's engines are handles rather than cue ids, so the
        // blanket `stop(id)` above cannot reach them — and a leaked positional
        // loop outlives the mission that started it. `mission.end` is the one
        // event that means "none of what you believe is true any more", and
        // that has to include the two nodes following objects that no longer
        // exist.
        racerEngines.stopAll(MISSION_END_FADE_SECONDS)
        // DEV-424: a retry resets the platform in one assignment, and the
        // lift's next step must seed rather than difference across it.
        endLift(MISSION_END_FADE_SECONDS)
      }
      if (event.type === 'launch.start') endLift(MISSION_END_FADE_SECONDS)
      // GO. `NPC Ship.mixer` ramps the opposition from its Pre-Launch snapshot
      // to Gameplay over 2 s — `E3/Scripts/Timer_Race.cs:70`.
      if (event.type === 'countdown.go') racerEngines.release()

      // ── the soundtrack, off events the game already sends ──────────────
      //
      // `MusicCue` names two moments and this is where they attach, so that
      // installing a soundtrack costs `audio.music.setTracks([...])` and no
      // change to the game loop at all. Routed HERE rather than from `app.ts`
      // for the same reason `racerEngines.release()` is: these are consequences
      // of an event, and a consequence hung off a call site is a consequence
      // that is right on one route and missing on three.
      //
      // **`'lift'` is hung off BOTH `mission.begin` and `launch.start`**, and
      // it is idempotent while something is playing, so whichever arrives first
      // starts the music and the other is a no-op. That is not belt-and-braces:
      // `mission.begin` is the honest anchor — `events.ts` already relocated the
      // OTHER half of `ScriptedAudio_elevator.cs`'s t+14.3 s pair
      // (`ambient_water`) to it, and one clock beats two — but it is not sent at
      // all on the `?mission=`/autopilot boot, where `screen` starts at
      // `'mission'` and nothing transitions into it. `launch.start` covers that
      // route, and covers `?ride=1`, where 2016's own clip really does start
      // under a moving lift.
      if (event.type === 'mission.begin' || event.type === 'launch.start') music.start('lift')
      // `Timer_Race.cs:75-77`: a RestartPlaylist that re-seeds the
      // without-replacement pool and brings a different song out of silence
      // over one second. Not a resume, and not the same song.
      if (event.type === 'countdown.go') music.start('go')
    },
    stepFlight(input) {
      lastSpeed = input.speed
      pending.length = 0
      stepEngineAudio(engine, input, spec, pending)
      // DEV-383: the spider's charge tone, in the same list, so it lands in the
      // same tick as the ladder it sits over.
      stepJumpChargeAudio(jumpCharge, input.jumpCharge, pending)
      apply(pending)
    },
    setSpeedCurves(next) {
      curves = next
      rebuildSpec()
    },
    setEngineSound(sound) {
      engineSound = sound
      rebuildSpec()
      // The racers read only the pitch half, and only when it is on. Through
      // the owner, so a system that never hears about a preset leaves them at
      // their Doppler — which is what Classic is.
      racerEngines.setPitchTracking(sound?.pitchTracking.enabled ? sound.pitchTracking : null)
    },
    setLiftSound(sound) {
      liftSound = sound
    },
    stepLift(input) {
      pending.length = 0
      stepLiftAudio(lift, input.rise, liftSound, pending)
      apply(pending)
    },
    get lift() {
      return {
        speed: lift.speed,
        motor: lift.motor,
        arrived: lift.arrived,
        enabled: liftSound !== null,
      }
    },
    setMasterGain(gain) {
      backend.setMasterGain(clampGain(gain))
    },
    setMusicGain(gain) {
      music.setGain(clampGain(gain))
    },
    setMusicListening(listening) {
      const next = musicFilterFor(listening)
      if (!musicFilterChanged(next, musicFilterLast)) return
      musicFilterLast = next
      backend.setMusicFilter(next)
    },
    duckMusic(amount, seconds) {
      backend.setMusicDuck(amount, seconds)
    },
    stopAll(fadeSeconds = MISSION_END_FADE_SECONDS) {
      racerEngines.stopAll(fadeSeconds)
      backend.stopAll(fadeSeconds)
      resetEngineAudio(engine)
      jumpCharge.playing = false
      // `backend.stopAll` above already took the motor's voice; this is the
      // state that believed it was running (DEV-424).
      resetLiftAudio(lift)
      // The gate whoosh reads this, and a stale 300 m/s across a return to the
      // hangar would make the first gate of the NEXT run the loudest one in it.
      lastSpeed = 0
      music.stop()
    },
    dispose() {
      racerEngines.stopAll(0)
      // Before the backend: the playlist owns a pending handoff timer and an
      // in-flight decode, and neither is reachable once the backend is gone.
      music.dispose()
      backend.dispose()
      resetEngineAudio(engine)
      jumpCharge.playing = false
      resetLiftAudio(lift)
    },
  }
}

/**
 * WebAudio where it exists, silence where it does not.
 *
 * The probe is a `typeof` on the constructor and nothing more — it does not
 * construct anything, because constructing is the thing that needs a gesture.
 */
const createDefaultBackend = (): AudioBackend =>
  typeof globalThis.AudioContext === 'function' ? createWebAudioBackend() : createSilentBackend()

export type { CueId, CueSpec } from './cues'
export { CUE_IDS, CUES } from './cues'
export type { EngineAudioInput, EngineAudioSpec, EngineAudioState } from './engine'
export {
  engineAudioWithCurves,
  engineAudioWithEngineSound,
  gateWhooshActions,
  SHIPPED_ENGINE_AUDIO,
} from './engine'
export type { AudioEvent } from './events'
export type { MusicBank, MusicCue, MusicPlaylist, MusicTrack } from './music'
export { bankCrossfadeSeconds, crossfadeGains, MUSIC_CUT_SECONDS } from './music'
export type { RacerAudioInput, RacerEngines } from './racer-engines'
export { createRacerEngines } from './racer-engines'
export type { ListenerPose, SpatialSpec, Vec3Tuple } from './spatial'
export { DEFAULT_LISTENER } from './spatial'
export type { WhooshModulation, WindModulation } from './speed-curves'
export { sampleCurve, whooshModulation, windModulation } from './speed-curves'
export type { VolumeSetting, VolumeState } from './volume'
export { masterGainFor, musicGainFor, VOLUME_GAIN, VOLUME_STEP_DB, VOLUME_STEPS } from './volume'
export type { AudioBackend, RecordingBackend }
export { createRecordingBackend, createSilentBackend, MASTER_SFX }
