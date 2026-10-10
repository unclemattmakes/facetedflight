// src/audio/backend.ts — the seam between "what should sound" and "Web Audio".
//
// ── Why there is a seam at all ────────────────────────────────────────────
//
// The unit tests run in node with **no `AudioContext`** (`vitest.config.ts`,
// `environment: 'node'`, and that is deliberate — D7). Everything in this module
// that can be wrong is on the near side of this interface: the event map, the
// gain arithmetic, the speed-threshold state machine, the retrigger rules. The
// far side is `webaudio.ts`, which builds oscillators and is the only file here
// that no test touches.
//
// So this is the same trick the sim/render split plays one layer down, and it
// buys the same thing: an assertion like "a finished run leaves no loop
// running" is a two-line test against a recording backend instead of a headed
// browser and a spectrogram.
//
// ── The contract ──────────────────────────────────────────────────────────
//
// An implementation may be asked to do anything at any time, including before
// it is running. Nothing here throws on a call made too early: the whole point
// of the lazy-on-gesture rule is that the game starts before the audio does,
// and a game that crashes because it scored a gate 40 ms before the player
// touched the pad is worse than one that misses a ding.

import type { CueId, CueSpec } from './cues'
import { MUSIC_FILTER_OPEN, type MusicFilter } from './music-filter'
import { DEFAULT_LISTENER, type ListenerPose, type Vec3Tuple } from './spatial'

export interface PlayOptions {
  /** Frequency multiplier for this play — variation x jitter. See `resolveVariation`. */
  readonly pitch: number
  readonly detuneCents: number
  /**
   * WORLD position, metres, or null for 2D.
   *
   * Null for all but two cues, and that is fidelity rather than a shortcut:
   * 2016's non-positional path (`MasterAudio.cs`'s `sourceTrans == null`
   * branch) emits from the bank's own transform, and
   * `PlayerShipInitialization.cs:34-37` parents that bank to the camera rig at
   * local origin — so every ordinary `PlaySound` cue in the shipped game plays
   * AT THE LISTENER, unattenuated, despite all 33 groups being configured
   * `ForceTo3D` with `MinDistance 10` / `MaxDistance 500`. The head-pose offset
   * is centimetres, far inside `MinDistance`, so the gain is 1.0 and there is
   * no rolloff.
   *
   * The two that DO carry one are the shaft whoosh and the racers' engines,
   * both of which are genuinely 3D in 2016 — see `spatial.ts`'s header for the
   * prefab and scene evidence. AUD-5.
   *
   * **WORLD, not listener-relative.** This field was declared listener-relative
   * while nothing fed it; world space is what the callers actually hold, it is
   * what an emitter that MOVES has to be updated in, and it is what WebAudio's
   * own `PannerNode`/`AudioListener` pair takes. Making the caller pre-subtract
   * a head pose that changes every frame would have meant every live emitter
   * being recomputed by the game loop instead of by the mixer.
   */
  readonly position: Vec3Tuple | null
  /**
   * Multiply the cue's catalogue gain for THIS play. Absent means 1.
   *
   * One cue uses it — S4's gate whoosh, scaled by the speed you took the gate
   * at — and only on the Anniversary preset. Everything 2016 fires plays at its
   * authored level, which is the whole of `mix.ts`, so this is absent everywhere
   * else and `?? 1` is what keeps that true. DEV-084.
   */
  readonly gain?: number
}

/**
 * A continuous control on a running voice. Anniversary only.
 *
 * Every field is optional and absent means "leave it alone" — a `modulate` for a
 * wind loop carries gain and cutoff, one for the thruster carries rate, and
 * neither has an opinion about the other's parameters. The backend chases each
 * value with a short `setTargetAtTime` rather than stepping it: this arrives 82
 * times a second, and a stepped `AudioParam` at that rate is zipper noise.
 * DEV-084.
 */
export interface CueModulation {
  /** Target gain, as a multiple of the cue's catalogue gain. */
  readonly gain?: number
  /** Low-pass cutoff in Hz, on the whole voice. */
  readonly cutoffHz?: number
  /**
   * Playback rate as a frequency multiplier — the meaning `CueSpec.pitch` carries
   * (see `cues.ts`'s header). It reaches the oscillators as a detune in cents and
   * the noise layers as a scale on their filter frequency, which is where a noise
   * layer's pitch actually lives.
   */
  readonly rate?: number
}

/**
 * A positional voice you can move, bend and stop on its own.
 *
 * `play()` is fire-and-forget and cannot address one voice among several; a
 * racer engine is a loop that has to follow one specific ship and be torn down
 * when that ship's run ends. So it gets a handle.
 *
 * **One handle per emitter, and nothing module-level.** Trap 19: `ai-racer.ts`
 * shared one `HoverJetInput` across every racer and a finished racer flew on
 * with the other racer's stick, frozen, until it went into the sea — invisible
 * to every single-object test, because with one racer there is nobody to
 * inherit from. `tests/unit/audio-spatial.test.ts` runs the guard that catches
 * that shape of bug: **start a SECOND emitter and assert the first did not
 * move.**
 */
export interface EmitterHandle {
  readonly cue: CueId
  /** False once stopped. A stopped handle ignores everything below. */
  readonly live: boolean
  /** Move it. WORLD metres. */
  moveTo(at: Vec3Tuple): void
  /** Pitch offset in cents, on top of the cue's own. Doppler feeds this. */
  setDetune(cents: number): void
  /** Ramp THIS voice's gain to `to` x the cue's catalogue gain, over `seconds`. */
  setGain(to: number, seconds: number): void
  /** Stop and tear down. Idempotent. */
  stop(fadeSeconds: number): void
}

/**
 * What a backend hands back when it cannot make a sound — no context yet,
 * `?audio=off`, a node import. **Never null**, because the whole lazy-on-gesture
 * rule is that the game starts before the audio does, and a caller that has to
 * null-check a handle it got two frames early is a caller that will forget to.
 */
export const deadEmitter = (cue: CueId): EmitterHandle => ({
  cue,
  live: false,
  moveTo() {},
  setDetune() {},
  setGain() {},
  stop() {},
})

/**
 * A decoded track, ready to start. Opaque on purpose.
 *
 * The `AudioBuffer` itself never crosses this seam, because the near side is
 * tested in node where there is no such type — and because the only two things
 * the playlist needs to know about a decoded track are which src it came from
 * and how long it is (the auto-advance handoff is scheduled off the length).
 */
export interface MusicBuffer {
  /** The `MusicTrack.src` it was loaded from. The cache key, and the log line. */
  readonly src: string
  readonly durationSeconds: number
}

/**
 * One playing track. The music equivalent of {@link EmitterHandle}.
 *
 * `play()` cannot address one voice among several and a crossfade is two voices
 * at once by definition, so music gets handles for the same reason the racer
 * engines do.
 */
export interface MusicVoice {
  readonly src: string
  /** False once stopped, or once the buffer has run out. */
  readonly live: boolean
  /**
   * Ramp this voice from silence to full over `seconds`, on an **equal-power**
   * curve. `0` starts at full immediately.
   */
  fadeIn(seconds: number): void
  /** Ramp to silence over `seconds` on the same curve, then tear down. */
  fadeOut(seconds: number): void
  /**
   * Called when the buffer reaches its own end.
   *
   * The teardown path, not the advance path: the handoff is scheduled off the
   * track's length so that it can OVERLAP, which is what a crossfade is. A
   * voice that reaches this has already been faded under its successor.
   */
  onEnded(callback: () => void): void
}

/** What a backend hands back when it cannot play music. Never null. */
export const deadMusicVoice = (src: string): MusicVoice => ({
  src,
  live: false,
  fadeIn() {},
  fadeOut() {},
  onEnded() {},
})

export interface AudioBackend {
  /** Is a real output actually running? False before the first gesture. */
  readonly running: boolean
  /**
   * Is there an output DEVICE at all — somewhere a decode could go?
   *
   * Weaker than {@link AudioBackend.running} and deliberately so: a context
   * the browser has suspended (a background tab, a headset taken off) is not
   * running and can still decode perfectly well. This asks only whether the
   * device exists, which for `webaudio.ts` is *"has the first gesture built the
   * `AudioContext` yet"*.
   *
   * It exists because the playlist has to tell TWO failures apart that
   * `loadMusic` deliberately collapses into one `null`. *"This track will not
   * load"* is a fact about the track — warn, skip it, and after a full pass
   * give up. *"There is nowhere to send sound yet"* is a fact about the
   * MOMENT, true of every track equally, and giving up on it burns the whole
   * pool over a state that the next user gesture fixes.
   *
   * Before DEV-247 the playlist could not tell them apart, so a page that
   * asked for music before anything had built a device blacklisted all six
   * tracks and printed *"no playable tracks (6 tried). The game runs
   * silent-of-music."* — an accusation against six files that were fine. It is
   * how the perf harness has been logging that line since the soundtrack
   * landed, and it is what `?audio=off` printed too, on a switch whose whole
   * promise is that it costs nothing.
   */
  readonly hasOutput: boolean
  /** Start or resume the output. Must be safe to call repeatedly. */
  resume(): Promise<void>
  play(spec: CueSpec, options: PlayOptions): void
  /** Stop a cue, fading over `fadeSeconds`. A no-op if it is not playing. */
  stop(id: CueId, fadeSeconds: number): void
  /** Ramp a running loop's gain to `to` x its catalogue gain, over `seconds`. */
  setCueGain(id: CueId, to: number, seconds: number): void
  /**
   * Chase continuous targets on every voice of a cue. A no-op if none is playing.
   *
   * Distinct from {@link AudioBackend.setCueGain}, which is 2016's
   * `FadeOutAllOfSound` — a ramp with a duration, fired once, on an edge. This
   * arrives every tick and is a target, not a ramp. Nothing calls it on the
   * Classic preset. DEV-084.
   */
  modulate(id: CueId, target: CueModulation): void
  /** Is this cue currently sounding? Drives the `retrigger: 'ignore'` rule. */
  isPlaying(id: CueId): boolean
  /** The SFX output gain. 2016's `MasterAudio.MasterVolumeLevel`. */
  setMasterGain(gain: number): void
  /**
   * Where the ears are, WORLD space. Safe to call every frame and before the
   * context exists — the pose is remembered and applied when one appears.
   */
  setListener(listener: ListenerPose): void
  /**
   * Start a positional voice that can be moved and stopped on its own.
   *
   * `options.position` is where it starts. Returns a `deadEmitter` rather than
   * null when there is no output, so a caller never has to branch.
   */
  emit(spec: CueSpec, options: PlayOptions): EmitterHandle
  /**
   * Fetch and decode one track. **Never rejects and never throws.**
   *
   * `null` for every failure there is — no output yet, `?audio=off`, a 404, a
   * codec this browser will not decode, a network that went away mid-flight.
   * The caller warns and stays silent; it does not branch on why. A game that
   * ships music-less today must keep booting when a fetch 404s tomorrow, and
   * that is only true if the failure has exactly one shape.
   */
  loadMusic(src: string): Promise<MusicBuffer | null>
  /**
   * Start a decoded track at silence. Call `fadeIn` to bring it up.
   *
   * Silent-at-start rather than full-at-start because every route into this is
   * a fade — the bank's crossfade, `fadeInFirstSong`, or `Timer_Race`'s 1 s
   * swell on GO — and a voice that starts loud and is then ramped down is a
   * click before it is a fade.
   */
  playMusic(buffer: MusicBuffer): MusicVoice
  /**
   * The MUSIC output gain — `musicGainFor(settings)`, i.e. the player's volume
   * ladder times 2016's `_masterPlaylistVolume`. A separate bus from
   * {@link AudioBackend.setMasterGain}, which is the SFX one.
   *
   * Safe before `resume()`: the value is remembered and applied to the node
   * when one appears, exactly as the SFX master is.
   */
  setMusicGain(gain: number): void
  /**
   * DEV-645: the filter pair on the music bus: a low-pass and a high-shelf, the
   * target the curve in `music-filter.ts` computed. The backend SMOOTHS toward
   * it (a pause is heard as a door closing, not a step), touches no volume, and
   * remembers it for a context that is built later, as `setMusicGain` does.
   */
  setMusicFilter(filter: MusicFilter): void
  /**
   * Duck the music: `amount` 0 (open) to 1 (ducked), reached over `seconds`. At 1
   * the music is turned down (volume only; the low-pass is DEV-645's), which is what a crash's black wants
   * (DEV-643); it rides a second node after the bus, so it never fights
   * `setMusicGain`'s player volume. Safe before `resume()`: remembered and applied.
   */
  setMusicDuck(amount: number, seconds: number): void
  stopAll(fadeSeconds: number): void
  dispose(): void
}

/** One thing that happened, as the recording backend saw it. */
export type BackendCall =
  | {
      readonly call: 'play'
      readonly id: CueId
      readonly pitch: number
      readonly gain: number
      readonly at: Vec3Tuple | null
    }
  | { readonly call: 'stop'; readonly id: CueId; readonly fadeSeconds: number }
  | { readonly call: 'gain'; readonly id: CueId; readonly to: number; readonly seconds: number }
  | { readonly call: 'modulate'; readonly id: CueId; readonly target: CueModulation }
  | { readonly call: 'master'; readonly gain: number }
  | { readonly call: 'stopAll'; readonly fadeSeconds: number }
  | { readonly call: 'listener'; readonly listener: ListenerPose }
  | {
      readonly call: 'emit'
      readonly handle: number
      readonly id: CueId
      readonly at: Vec3Tuple | null
    }
  | { readonly call: 'move'; readonly handle: number; readonly to: Vec3Tuple }
  | { readonly call: 'detune'; readonly handle: number; readonly cents: number }
  | {
      readonly call: 'emitGain'
      readonly handle: number
      readonly to: number
      readonly seconds: number
    }
  | { readonly call: 'emitStop'; readonly handle: number; readonly fadeSeconds: number }
  | { readonly call: 'musicLoad'; readonly src: string; readonly ok: boolean }
  | { readonly call: 'musicStart'; readonly voice: number; readonly src: string }
  | {
      readonly call: 'musicFadeIn'
      readonly voice: number
      readonly src: string
      readonly seconds: number
    }
  | {
      readonly call: 'musicFadeOut'
      readonly voice: number
      readonly src: string
      readonly seconds: number
    }
  | { readonly call: 'musicGain'; readonly gain: number }
  | { readonly call: 'musicFilter'; readonly lowpassHz: number; readonly highShelfDb: number }
  | { readonly call: 'musicDuck'; readonly amount: number; readonly seconds: number }

/** A live positional voice, as the recording backend sees it. */
export interface RecordedEmitter {
  readonly handle: number
  readonly cue: CueId
  readonly at: Vec3Tuple
  readonly detuneCents: number
  readonly gain: number
}

/**
 * A backend that makes no sound and remembers everything.
 *
 * The test double, and also a real debug tool: wiring this in behind a query
 * switch gives a console transcript of the mix without a headset. It tracks
 * which loops are sounding, so `isPlaying` — and therefore the whole
 * `retrigger: 'ignore'` rule — is exercised for real rather than stubbed true.
 */
export interface RecordingBackend extends AudioBackend {
  readonly calls: readonly BackendCall[]
  /** Cue ids currently sounding, in start order. */
  readonly sounding: readonly CueId[]
  /** The last listener pose it was given. Starts at `DEFAULT_LISTENER`. */
  readonly listener: ListenerPose
  /**
   * Every positional voice still live, in start order.
   *
   * This is the graph shape, and it is the only way a node test can see the
   * thing that actually goes wrong with positional audio: a node nobody tore
   * down. A leaked emitter is inaudible in a unit test and permanent in a
   * headset.
   */
  readonly emitters: readonly RecordedEmitter[]
  /**
   * Every music voice still live, in start order.
   *
   * The same argument as `emitters`, and the same bug: a music voice nobody
   * tore down is inaudible in a test and is two songs at once in a headset.
   * A crossfade is legitimately two of these for `crossfadeSeconds`; three, or
   * two that never becomes one, is the bug.
   */
  readonly musicVoices: readonly RecordedMusicVoice[]
  /** The last value `setMusicGain` was given. Starts at 1 — the bus, not the mix. */
  readonly musicGain: number
  /** The last filter `setMusicFilter` was given. Starts open. DEV-645. */
  readonly musicFilter: MusicFilter
  /**
   * Make `loadMusic` answer `null` for this src — the 404 path, without a
   * network. Sticky: a track that cannot be fetched stays unfetchable, which is
   * what makes "it does not spin through the playlist forever" assertable.
   */
  failMusic(src: string): void
  /**
   * Model the window before the first gesture, when there is no device.
   *
   * A real `AudioBackend` reports `hasOutput: false` until something has been
   * through `resume()`, and the playlist treats that state completely
   * differently from a track that will not load (DEV-247). This double is
   * always ready by default — see the getter — so a test that wants the other
   * state has to ask for it.
   */
  setHasOutput(has: boolean): void
  /**
   * What `loadMusic` reports as a track's length. Drives the auto-advance
   * handoff, so a test can make a track three seconds long instead of three
   * minutes.
   */
  setMusicSeconds(seconds: number): void
  /** Run a live voice's `onEnded`, as the audio thread would at the buffer's end. */
  endMusic(voice: number): void
  clear(): void
}

/** A live music voice, as the recording backend sees it. */
export interface RecordedMusicVoice {
  readonly voice: number
  readonly src: string
  /** Where its own fade got to: 0 until `fadeIn`, back to 0 after `fadeOut`. */
  readonly gain: number
}

export const createRecordingBackend = (): RecordingBackend => {
  const calls: BackendCall[] = []
  const sounding = new Set<CueId>()
  const live = new Map<number, { cue: CueId; at: Vec3Tuple; detuneCents: number; gain: number }>()
  let listener: ListenerPose = DEFAULT_LISTENER
  let nextHandle = 1
  let running = false

  // ── the music side ────────────────────────────────────────────────────
  //
  // `fadeOut` models a COMPLETED teardown: the voice leaves `musicVoices` at
  // once. So `musicVoices` answers "what has not been told to stop", which is
  // the leak question, and the overlap itself is read off `calls` — a crossfade
  // is a `musicFadeOut` and a `musicFadeIn` at the same moment with the same
  // number of seconds. Keeping a fading voice "live" would need a clock this
  // double deliberately does not have.
  const musicLive = new Map<number, { src: string; gain: number }>()
  const musicFailed = new Set<string>()
  const musicEnded = new Map<number, () => void>()
  let musicSeconds = 180
  let musicGain = 1
  let musicFilter: MusicFilter = MUSIC_FILTER_OPEN
  let nextMusicVoice = 1
  let hasOutput = true

  return {
    get running() {
      return running
    },
    /**
     * True by default: this backend IS the device, and it answers `loadMusic`
     * whether or not anything resumed it. Modelling the pre-gesture window
     * here by default would make every music test call `resume()` to say
     * something that is not what those tests are about — so the state is
     * available through `setHasOutput` and off unless asked for.
     */
    get hasOutput() {
      return hasOutput
    },
    get calls() {
      return calls
    },
    get sounding() {
      return [...sounding]
    },
    get listener() {
      return listener
    },
    get emitters() {
      return [...live.entries()].map(([handle, e]) => ({ handle, ...e }))
    },
    async resume() {
      running = true
    },
    play(spec, options) {
      calls.push({
        call: 'play',
        id: spec.id,
        pitch: options.pitch,
        // The gain that will actually SOUND, catalogue x per-play. `?? 1` for
        // every cue but the gate whoosh, so every existing assertion on a
        // recorded gain still reads the catalogue number.
        gain: spec.gain * (options.gain ?? 1),
        at: options.position,
      })
      // Only a LOOP keeps sounding. A one-shot is finished as far as the
      // retrigger rule is concerned the moment it is fired, which is what makes
      // twenty-one ring dings in a lap possible at all.
      if (spec.loop) sounding.add(spec.id)
    },
    stop(id, fadeSeconds) {
      calls.push({ call: 'stop', id, fadeSeconds })
      sounding.delete(id)
    },
    setCueGain(id, to, seconds) {
      calls.push({ call: 'gain', id, to, seconds })
    },
    modulate(id, target) {
      // A COPY, for the same reason `emit` copies the caller's position tuple:
      // the engine hands out an object per tick and a recording that held the
      // reference would be a transcript of whatever the last tick wrote —
      // trap 19's shape, in the test double this time.
      calls.push({ call: 'modulate', id, target: { ...target } })
    },
    isPlaying(id) {
      return sounding.has(id)
    },
    setMasterGain(gain) {
      calls.push({ call: 'master', gain })
    },
    setListener(pose) {
      listener = pose
      calls.push({ call: 'listener', listener: pose })
    },
    emit(spec, options) {
      const handle = nextHandle++
      const at = options.position ?? [0, 0, 0]
      // A COPY of the caller's tuple, and it is not tidiness: the callers hand
      // out per-frame vectors, and holding a reference to one would make every
      // emitter read whatever the last caller wrote — trap 19's shape exactly.
      live.set(handle, { cue: spec.id, at: [...at], detuneCents: 0, gain: 1 })
      calls.push({ call: 'emit', handle, id: spec.id, at: options.position })
      return {
        cue: spec.id,
        get live() {
          return live.has(handle)
        },
        moveTo(to) {
          const e = live.get(handle)
          if (!e) return
          live.set(handle, { ...e, at: [...to] })
          calls.push({ call: 'move', handle, to: [...to] })
        },
        setDetune(cents) {
          const e = live.get(handle)
          if (!e) return
          live.set(handle, { ...e, detuneCents: cents })
          calls.push({ call: 'detune', handle, cents })
        },
        setGain(to, seconds) {
          const e = live.get(handle)
          if (!e) return
          live.set(handle, { ...e, gain: to })
          calls.push({ call: 'emitGain', handle, to, seconds })
        },
        stop(fadeSeconds) {
          if (!live.delete(handle)) return
          calls.push({ call: 'emitStop', handle, fadeSeconds })
        },
      }
    },
    get musicVoices() {
      return [...musicLive.entries()].map(([voice, v]) => ({ voice, ...v }))
    },
    get musicGain() {
      return musicGain
    },
    get musicFilter() {
      return musicFilter
    },
    failMusic(src) {
      musicFailed.add(src)
    },
    setHasOutput(has) {
      hasOutput = has
    },
    setMusicSeconds(seconds) {
      musicSeconds = seconds
    },
    endMusic(voice) {
      const callback = musicEnded.get(voice)
      musicLive.delete(voice)
      musicEnded.delete(voice)
      callback?.()
    },
    async loadMusic(src) {
      const ok = !musicFailed.has(src)
      calls.push({ call: 'musicLoad', src, ok })
      return ok ? { src, durationSeconds: musicSeconds } : null
    },
    playMusic(buffer) {
      const voice = nextMusicVoice++
      musicLive.set(voice, { src: buffer.src, gain: 0 })
      calls.push({ call: 'musicStart', voice, src: buffer.src })
      return {
        src: buffer.src,
        get live() {
          return musicLive.has(voice)
        },
        fadeIn(seconds) {
          const v = musicLive.get(voice)
          if (!v) return
          musicLive.set(voice, { ...v, gain: 1 })
          calls.push({ call: 'musicFadeIn', voice, src: v.src, seconds })
        },
        fadeOut(seconds) {
          const v = musicLive.get(voice)
          if (!v) return
          musicLive.delete(voice)
          musicEnded.delete(voice)
          calls.push({ call: 'musicFadeOut', voice, src: v.src, seconds })
        },
        onEnded(callback) {
          if (musicLive.has(voice)) musicEnded.set(voice, callback)
        },
      }
    },
    setMusicGain(gain) {
      musicGain = gain
      calls.push({ call: 'musicGain', gain })
    },
    setMusicFilter(filter) {
      musicFilter = filter
      calls.push({
        call: 'musicFilter',
        lowpassHz: filter.lowpassHz,
        highShelfDb: filter.highShelfDb,
      })
    },
    setMusicDuck(amount, seconds) {
      calls.push({ call: 'musicDuck', amount, seconds })
    },
    stopAll(fadeSeconds) {
      calls.push({ call: 'stopAll', fadeSeconds })
      sounding.clear()
      live.clear()
    },
    dispose() {
      sounding.clear()
      live.clear()
      musicLive.clear()
      musicEnded.clear()
      running = false
    },
    clear() {
      calls.length = 0
    },
  }
}

/**
 * A backend that does nothing at all.
 *
 * What the system falls back to where there is no `AudioContext` constructor —
 * a node import, a locked-down browser, `?audio=off`. It is not an error path:
 * silence is a valid output and the game must not care.
 */
export const createSilentBackend = (): AudioBackend => ({
  running: false,
  /**
   * There is no device and there never will be, so the playlist stays quiet
   * instead of accusing six files of being unplayable. `?audio=off` now costs
   * nothing in the log as well as nothing on the network, which is what the
   * note on {@link createSilentBackend.loadMusic} already promised.
   */
  hasOutput: false,
  async resume() {},
  play() {},
  stop() {},
  setCueGain() {},
  /**
   * Accepted and dropped, like everything else here.
   *
   * `?audio=off` and a node import both reach this, and S4 sends one of these
   * per running loop per sim tick — so "silence is a valid output and the game
   * must not care" has to include the continuous layer, or the Anniversary
   * preset would throw eighty times a second in every screenshot spec.
   */
  modulate() {},
  isPlaying() {
    return false
  },
  setMasterGain() {},
  setListener() {},
  emit(spec) {
    return deadEmitter(spec.id)
  },
  /**
   * **It does not fetch.** `?audio=off` must cost nothing, not "cost a download
   * and then throw it away": a screenshot spec that must not start an audio
   * device has no more business pulling four megabytes of Opus off R2 than it
   * has building an `AudioContext`. Resolves `null` on the spot, and the
   * playlist's failure path — warn once, stay silent — is the same one a 404
   * takes.
   */
  async loadMusic() {
    return null
  },
  playMusic(buffer) {
    return deadMusicVoice(buffer.src)
  },
  setMusicGain() {},
  setMusicFilter() {},
  setMusicDuck() {},
  stopAll() {},
  dispose() {},
})
