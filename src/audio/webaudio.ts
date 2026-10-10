// src/audio/webaudio.ts — the only file here that touches Web Audio.
//
// ── Why this file has (almost) no tests ───────────────────────────────────
//
// Deliberately; the one exception is `rampFromCurrent`, the gain-ramp helper,
// whose call order a fake `AudioParam` can record (`tests/unit/webaudio-ramp.test.ts`).
// The unit suite runs in node with no `AudioContext` (D7), and
// everything that can be WRONG about this module — the event map, the gain
// arithmetic, the speed gates, the retrigger rules, the variation choice — is
// on the other side of `backend.ts` and is tested hard. What is left here is
// node plumbing: build an oscillator, ramp a gain, stop it. If a bug lives in
// this file it is a bug you hear in one second in a headset, not one that
// survives four sessions the way a silent state-machine bug does.
//
// That is the same bargain `src/render/` makes, and it is the bargain that
// makes a headless suite worth having at all.
//
// ── The lazy-on-gesture rule, and what `suspended` means ──────────────────
//
// No `AudioContext` is constructed until `resume()`. Browsers block one created
// outside a user gesture, and Chrome suspends an existing one when the tab
// loses focus or the context idles. Neither is an error: `resume()` is
// idempotent, safe on every gesture forever, and re-resumes a suspended
// context. Everything else is a no-op until then, so the game can score a gate
// 40 ms before the player touches the pad and simply not ding.
//
// ── Two structural choices ────────────────────────────────────────────────
//
// 1. **One shared noise buffer.** Every `NoiseLayer` reads the same two seconds
//    of white noise through its own filter. Generating a buffer per voice would
//    allocate 88 KB on every ring ding — twenty-one a lap, plus the crash, the
//    countdown and the UI — for a texture nobody can tell apart from a shared
//    one behind a bandpass.
// 2. **A voice owns a `GainNode` and nothing else owns it.** `stop()` ramps
//    that one node and schedules the teardown; `setCueGain()` ramps the same
//    node. So the duck at 120 m/s and the stop at the end of a run cannot fight
//    over two different gains and leave a layer 12 dB down with nothing in the
//    state to say why.
//
//    **S4's `modulate` is the exception, and it gets its OWN node for exactly
//    that reason.** The continuous layer arrives 82 times a second and has to
//    coexist with the cue's authored `fadeInSeconds` ramp and with a `stop()`
//    that may land in the same millisecond. Ramping the same param from two
//    schedules is how a fade ends up cancelled halfway and a loop sits at a
//    gain nobody chose. So a modulated voice grows a second `GainNode` after
//    the first, the two multiply — authored level x speed curve, which is what
//    the numbers mean — and neither side ever cancels the other's automation.
//    Nothing builds these nodes on Classic: no `modulate` is ever sent, so
//    Classic's graph is the graph it has always been, node for node. DEV-084.

import {
  type AudioBackend,
  deadEmitter,
  deadMusicVoice,
  type MusicBuffer,
  type MusicVoice,
  type PlayOptions,
} from './backend'
import type { CueId, CueLayer, CueSpec, Envelope } from './cues'
import { cueTailSeconds } from './cues'
import { MASTER_MUSIC } from './mix'
import { equalPowerCurve } from './music'
import {
  MUSIC_FILTER,
  MUSIC_FILTER_OPEN,
  MUSIC_FILTER_SMOOTH,
  type MusicFilter,
} from './music-filter'
import { DEFAULT_LISTENER, type ListenerPose, type SpatialSpec, type Vec3Tuple } from './spatial'
import { VOLUME_GAIN } from './volume'

/** DEV-643: the music duck is VOLUME only (the low-pass through a crash's black is DEV-645's): 30 % at full duck. */
const DUCK_FLOOR_GAIN = 0.3

/** Seconds of white noise shared by every noise layer. */
const NOISE_SECONDS = 2

/**
 * The crossfade, sampled once. `music.ts` owns the shape and the argument for
 * it (equal-power, because two songs sum in power — DEV-066); this is the only
 * place it becomes an `AudioParam` schedule.
 *
 * Built at module load and reused: `setValueCurveAtTime` copies the array, so
 * one pair of curves serves every fade for the life of the page.
 */
const FADE_IN_CURVE = equalPowerCurve('in')
const FADE_OUT_CURVE = equalPowerCurve('out')

/** How long after a music fade the buffer source is actually stopped. */
const MUSIC_STOP_MARGIN = 0.02

/** Never ramp a gain to exactly zero: `exponentialRampToValueAtTime` refuses it. */
const SILENT = 0.0001

/**
 * Hold a param where it is now and ramp it linearly to `target` over `seconds`,
 * never through zero (both ends are floored at `SILENT`). One schedule: the
 * cancel, the pin at the current value and the ramp are the three calls every
 * gain fade here makes, in this order. IU-1.
 */
export const rampFromCurrent = (
  param: AudioParam,
  target: number,
  now: number,
  seconds: number,
): void => {
  param.cancelScheduledValues(now)
  param.setValueAtTime(Math.max(SILENT, param.value), now)
  param.linearRampToValueAtTime(Math.max(SILENT, target), now + seconds)
}

interface Voice {
  readonly id: CueId
  readonly gain: GainNode
  /** Everything that has to be `stop()`ed, oscillators and buffer sources alike. */
  readonly sources: (OscillatorNode | AudioBufferSourceNode)[]
  /**
   * The `OscillatorNode`s only, each with the detune it was AUTHORED at.
   *
   * A noise layer's pitch lives on its `BiquadFilterNode`'s frequency rather
   * than on the buffer source, and bending a filter is not bending a pitch — so
   * the Doppler shift reaches the tonal layers and leaves the roar where it is.
   * That is also what it should sound like: the whine of a jet Dopplers, the
   * broadband rush of air does not shift in any way an ear reads as pitch.
   *
   * The baseline is carried rather than read back off the node, because
   * `AudioParam.value` after a ramp is wherever the ramp has got to — so
   * `detune.value + shift` would ACCUMULATE every frame, which is a jet that
   * climbs an octave in a second and never comes back. (Trap 19's shape one
   * layer down: a value that is a channel between two calls.)
   */
  readonly oscillators: { readonly node: OscillatorNode; readonly baseDetune: number }[]
  /**
   * Every `NoiseLayer`'s `BiquadFilterNode`, with the frequency it was AUTHORED
   * at — `startHz * options.pitch`, the same product `buildLayer` writes.
   *
   * Carried for the same reason `oscillators` carries `baseDetune`: a rate that
   * scaled `node.frequency.value` would compound every tick, and at 82 Hz that
   * is an engine which climbs out of the audible range in under a second (trap
   * 19's shape — a value used as a channel between two calls). Every LOOP that
   * S4 rate-modulates has `sweepSeconds: 0` on all its layers, so nothing here
   * is fighting an authored sweep.
   */
  readonly filters: { readonly node: BiquadFilterNode; readonly baseHz: number }[]
  /**
   * The panner, for a positional voice, or null for the 2D ones — which is
   * every cue but two. See `spatial.ts`.
   */
  readonly panner: PannerNode | null
  /** Where the voice's chain ends up: the panner if there is one, else `master`. */
  readonly destination: AudioNode
  /** The cue's catalogue gain, so a `setCueGain` multiplier has something to scale. */
  readonly baseGain: number
  readonly loop: boolean
  /** Set once `stop()` has been called, so a teardown cannot run twice. */
  stopping: boolean
  /**
   * S4's nodes, built on the first `modulate` this voice receives and never on
   * Classic. `chainTail` is whatever currently feeds `destination`, so inserting
   * a second one is the same three lines as inserting the first.
   */
  modGain: GainNode | null
  modFilter: BiquadFilterNode | null
  chainTail: AudioNode
}

/**
 * Put a `PannerNode` where 2016's `AudioSource` was.
 *
 * `distanceModel: 'inverse'` with `rolloffFactor: 1` IS Unity's logarithmic
 * rolloff — `ref / d`, clamped at `maxDistance` — so `MinDistance` and
 * `MaxDistance` go across unchanged. `spatial.ts` writes the same function out
 * in pure form and `tests/unit/audio-spatial.test.ts` asserts the equivalence,
 * because "these two curves are the same" is exactly the kind of structural
 * claim that survives a year on one source (PORT_PLAN §4.7).
 *
 * `panningModel: 'HRTF'` rather than `'equalpower'`: this is a headset, the two
 * cues that reach here are an overhead sweep and an aircraft passing, and
 * elevation is the whole point of both. Two live panners is not a budget
 * question.
 */
const buildPanner = (context: AudioContext, spatial: SpatialSpec, at: Vec3Tuple): PannerNode => {
  const panner = context.createPanner()
  panner.panningModel = 'HRTF'
  panner.distanceModel = 'inverse'
  panner.refDistance = spatial.refDistance
  panner.maxDistance = spatial.maxDistance
  panner.rolloffFactor = 1
  // No cone: every 2016 source that reaches here is omnidirectional
  // (`spreadCustomCurve` = 0, no `m_SpatialBlend` cone data of any kind).
  setPosition(panner, at, context.currentTime)
  return panner
}

/**
 * Write a position onto a panner, through whichever API this browser has.
 *
 * The `AudioParam` form (`positionX.value`) is the current spec and is what
 * Chrome, Quest's browser and Safari all ship; `setPosition` is the deprecated
 * form and is still the only one in some older WebKit builds. Feature-detected
 * rather than assumed, because the failure mode of guessing is a panner stuck
 * at the origin — which sounds like working 2D audio and would survive a
 * session.
 */
const setPosition = (node: PannerNode, at: Vec3Tuple, when: number, ramp = 0): void => {
  if (node.positionX) {
    if (ramp > 0) {
      node.positionX.linearRampToValueAtTime(at[0], when + ramp)
      node.positionY.linearRampToValueAtTime(at[1], when + ramp)
      node.positionZ.linearRampToValueAtTime(at[2], when + ramp)
      return
    }
    node.positionX.setValueAtTime(at[0], when)
    node.positionY.setValueAtTime(at[1], when)
    node.positionZ.setValueAtTime(at[2], when)
    return
  }
  ;(node as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(
    at[0],
    at[1],
    at[2],
  )
}

/**
 * How far ahead a `moveTo` ramps the panner's position.
 *
 * A racer at 300 m/s moves **3.3 m between frames at 90 Hz**, and a bare
 * `setValueAtTime` makes that a step — which on a panner is a click in the
 * stereo image every frame, i.e. zipper noise, on the one cue in the mix that
 * moves fastest. three's own `PositionalAudio` ramps instead, to
 * `currentTime + <frame delta>`; the frame delta is not plumbed through this
 * seam, so this is a fixed horizon just past one frame at the slowest headset
 * rate FF2 targets (72 Hz). Too long and the emitter lags; too short and it
 * steps again. It is a smoothing constant and it is ours — there is no 2016
 * number here, because Unity did this inside the engine.
 */
const MOVE_RAMP_SECONDS = 1 / 60

/**
 * The time constant S4's continuous controls are chased with, seconds.
 *
 * `setTargetAtTime` approaches exponentially and reaches ~95 % in 3 tau, so 0.06
 * is about 180 ms to settle. A `modulate` arrives every sim tick (12.2 ms), and
 * a param stepped at that rate is zipper noise on a sustained loop — which is
 * the whole reason `setDetune` above already uses this API at 0.03. Slower than
 * that here because these are BEDS rather than a Doppler: the wind should swell,
 * not track. Too short and the wind flutters on every gust of throttle; too long
 * and it lags the boost audibly.
 *
 * It is a smoothing constant and it is OURS — there is no 2016 number for it,
 * because 2016 modulates nothing. It is deliberately not in the preset: it is
 * anti-zipper plumbing on the same footing as `MOVE_RAMP_SECONDS`, not a tuning
 * knob for the feel of the game.
 */
const MODULATE_TAU = 0.06

/** The same feature detection for the listener. */
const applyListener = (context: AudioContext, pose: ListenerPose): void => {
  const l = context.listener
  const when = context.currentTime
  if (l.positionX) {
    l.positionX.setValueAtTime(pose.position[0], when)
    l.positionY.setValueAtTime(pose.position[1], when)
    l.positionZ.setValueAtTime(pose.position[2], when)
    l.forwardX.setValueAtTime(pose.forward[0], when)
    l.forwardY.setValueAtTime(pose.forward[1], when)
    l.forwardZ.setValueAtTime(pose.forward[2], when)
    l.upX.setValueAtTime(pose.up[0], when)
    l.upY.setValueAtTime(pose.up[1], when)
    l.upZ.setValueAtTime(pose.up[2], when)
    return
  }
  const legacy = l as unknown as {
    setPosition(x: number, y: number, z: number): void
    setOrientation(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void
  }
  legacy.setPosition(pose.position[0], pose.position[1], pose.position[2])
  legacy.setOrientation(
    pose.forward[0],
    pose.forward[1],
    pose.forward[2],
    pose.up[0],
    pose.up[1],
    pose.up[2],
  )
}

const applyEnvelope = (
  param: AudioParam,
  env: Envelope,
  peak: number,
  startAt: number,
  loop: boolean,
  durationSeconds: number,
): void => {
  const sustain = Math.max(SILENT, peak * env.sustain)
  param.setValueAtTime(SILENT, startAt)
  param.linearRampToValueAtTime(Math.max(SILENT, peak), startAt + env.attack)
  param.linearRampToValueAtTime(sustain, startAt + env.attack + env.decay)
  if (loop) return
  // A one-shot releases on its own schedule. The hold is whatever is left of
  // the cue's declared length after the attack, the decay and the release —
  // clamped at zero so a layer whose envelope is longer than its cue simply
  // runs straight from decay into release rather than scheduling backwards.
  const body = env.attack + env.decay
  const hold = Math.max(0, durationSeconds - body - env.release)
  const releaseAt = startAt + body + hold
  param.setValueAtTime(sustain, releaseAt)
  param.linearRampToValueAtTime(SILENT, releaseAt + env.release)
}

/**
 * Schedule one side of a crossfade onto a gain param.
 *
 * `setValueCurveAtTime` is the only API that takes a SHAPE rather than a
 * straight line, which is the whole point — an equal-power fade written as a
 * linear ramp is a linear fade, and a linear fade is the 3 dB hole this is here
 * to avoid.
 *
 * The `catch` is not decoration. A curve that overlaps one already running is a
 * `NotSupportedError` in Chrome, and the case that produces it is real: GO
 * arriving while the lift's track is still fading in. A linear ramp is a worse
 * fade and an infinitely better outcome than an exception thrown out of the
 * audio layer into the frame.
 */
const applyFade = (param: AudioParam, direction: 'in' | 'out', seconds: number, now: number) => {
  const target = direction === 'in' ? 1 : 0
  if (!(seconds > 0)) {
    param.cancelScheduledValues(now)
    param.setValueAtTime(target, now)
    return
  }
  try {
    param.cancelScheduledValues(now)
    param.setValueCurveAtTime(direction === 'in' ? FADE_IN_CURVE : FADE_OUT_CURVE, now, seconds)
  } catch {
    rampFromCurrent(param, target, now, seconds)
  }
}

/**
 * Say WHY one track did not load — once per src, however often it is retried.
 *
 * Separate from the playlist's own warning, which says what happened rather
 * than why, and which is the one a reader sees first. Deduped here as well as
 * there because the playlist forgets its set on `setTracks` and this is the
 * line that carries the diagnosis. (DEV-247.)
 */
const musicFailuresReported = new Set<string>()
const failedMusic = (src: string, reason: string): void => {
  if (musicFailuresReported.has(src)) return
  musicFailuresReported.add(src)
  console.warn(`music: ${src} did not load — ${reason}`)
}

export const createWebAudioBackend = (): AudioBackend => {
  let ctx: AudioContext | null = null
  let master: GainNode | null = null
  let noiseBuffer: AudioBuffer | null = null
  /**
   * The MUSIC bus, and it hangs off `destination` rather than off `master`.
   *
   * `master` is the player's volume as it applies to the SFX, and
   * `musicGainFor(settings)` has ALREADY put that same ladder into this number
   * (times 2016's `_masterPlaylistVolume`). Routing music through `master` would
   * square the player's setting — `low` would be −36 dB instead of −18 — which
   * is DEV-065's bug exactly, one bus over. Two buses, one factor each.
   */
  let musicBus: GainNode | null = null
  /**
   * DEV-645: the music bus's filter pair, `musicBus -> low-pass -> high-shelf ->
   * destination`, and the target they were last told (so a context built later
   * starts where the game already is). The curve is `music-filter.ts`'s.
   */
  let musicLow: BiquadFilterNode | null = null
  let musicShelf: BiquadFilterNode | null = null
  let musicFilter: MusicFilter = MUSIC_FILTER_OPEN
  /**
   * Starts where `MusicPlaylist.gain` starts, so the two agree before anything
   * has set either. `app.ts` calls `setMusicGain(musicGainFor(s))` at boot and
   * on every change; this is only what is true in the gap.
   */
  let musicGain = MASTER_MUSIC
  /** DEV-643: the crash's duck, 0 open to 1 ducked; one gain node after `musicBus`. */
  let duckAmount = 0
  let musicDuckGain: GainNode | null = null
  const applyDuck = (seconds: number): void => {
    if (!ctx || !musicDuckGain) return
    // A time CONSTANT a third of the move, so it has landed by the end of it.
    const tau = Math.max(0.005, seconds / 3)
    musicDuckGain.gain.setTargetAtTime(1 - (1 - DUCK_FLOOR_GAIN) * duckAmount, ctx.currentTime, tau)
  }
  /**
   * The decoded PCM behind a `MusicBuffer`.
   *
   * A `WeakMap` rather than a field on the handle, so that `MusicBuffer` can
   * stay the opaque `{ src, durationSeconds }` the node-side tests construct
   * and nothing on the near side of `backend.ts` ever sees an `AudioBuffer`.
   * Weak so a track the playlist has dropped can be collected: a three-minute
   * stereo decode is 69 MB, which is not a thing to leak.
   */
  const decoded = new WeakMap<MusicBuffer, AudioBuffer>()
  /**
   * The master node is the PLAYER's volume, and it starts at the top of their
   * ladder rather than at `MASTER_SFX`.
   *
   * It was `MASTER_SFX` (0.75), which double-applied the 2016 master: `cueGain`
   * already multiplies it into every `CueSpec.gain`, so the product reaching
   * the destination was `clip x group x 0.75 x 0.75` and the whole game played
   * 2.5 dB under its own authored level. Nothing had ever called
   * `setMasterGain`, so the two halves of the chain never had to agree about
   * what this node meant. See `volume.ts`.
   */
  let masterGain = VOLUME_GAIN.full
  /**
   * Remembered even with no context, because the game feeds a head pose from
   * its first frame and the context arrives on the first gesture — which in a
   * headset is well after the player is already standing somewhere.
   */
  let listenerPose: ListenerPose = DEFAULT_LISTENER
  const voices = new Map<CueId, Voice[]>()

  const ensureNoise = (context: AudioContext): AudioBuffer => {
    if (noiseBuffer) return noiseBuffer
    const frames = Math.floor(context.sampleRate * NOISE_SECONDS)
    const buffer = context.createBuffer(1, frames, context.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1
    noiseBuffer = buffer
    return buffer
  }

  const forget = (voice: Voice): void => {
    const list = voices.get(voice.id)
    if (!list) return
    const index = list.indexOf(voice)
    if (index >= 0) list.splice(index, 1)
    if (list.length === 0) voices.delete(voice.id)
  }

  /**
   * Unhook a finished voice from the graph.
   *
   * The `GainNode` is disconnected as well as the panner, because a gain whose
   * sources have all ended is still an edge into `master` — harmless in ones and
   * twos, and the thing that accumulates across thirteen missions in a session.
   *
   * **The panner is the one that matters.** Nothing else here is left behind
   * when its sources stop, and an HRTF `PannerNode` holds convolution state for
   * the life of the context. A leaked one is inaudible in a test and permanent
   * in a headset — which is the whole reason `RecordingBackend` tracks live
   * emitters and `tests/unit/audio-spatial.test.ts` asserts on them.
   */
  const release = (voice: Voice): void => {
    try {
      voice.gain.disconnect()
    } catch {
      // Already disconnected. Not a reason to take the frame down.
    }
    try {
      voice.panner?.disconnect()
    } catch {
      // As above.
    }
    // S4's two, if this voice ever got them. Same argument as the panner one
    // line up: an edge into `master` that nothing tears down is harmless in ones
    // and twos and is what accumulates across thirteen missions — and these are
    // built on a LOOP that starts and stops every time the wind crosses 25 m/s.
    try {
      voice.modGain?.disconnect()
    } catch {
      // As above.
    }
    try {
      voice.modFilter?.disconnect()
    } catch {
      // As above.
    }
    forget(voice)
  }

  /**
   * Splice a node in at the end of a voice's chain, just before its destination.
   *
   * The tail only ever has the one outgoing edge, so a bare `disconnect()` is
   * the whole of the unhook. Called at most twice per voice and only on the
   * Anniversary preset.
   */
  const spliceIntoChain = (voice: Voice, node: AudioNode): void => {
    try {
      voice.chainTail.disconnect()
    } catch {
      // Already disconnected — the voice is on its way out. Reconnecting below
      // is harmless and the teardown will take both.
    }
    voice.chainTail.connect(node)
    node.connect(voice.destination)
    voice.chainTail = node
  }

  /** Keep a filter frequency inside what a biquad can actually be asked for. */
  const audibleHz = (context: AudioContext, hz: number): number =>
    Math.min(context.sampleRate / 2 - 1, Math.max(10, hz))

  const teardown = (voice: Voice, at: number): void => {
    for (const source of voice.sources) {
      try {
        source.stop(at)
      } catch {
        // Already stopped, or never started. Both are fine and neither is a
        // reason to take the frame down.
      }
    }
    voice.gain.gain.cancelScheduledValues(at)
    // Hung off the LAST source's own `onended` rather than a timer, so the
    // unhook happens when the audio thread says the voice is finished instead
    // of when the main thread guesses it has been. A `setTimeout` here would
    // also outlive `dispose()`, and fire against a closed context.
    const last = voice.sources[voice.sources.length - 1]
    if (last) last.onended = () => release(voice)
    else release(voice)
    // `forget` regardless: the voice must leave the lookup NOW, or `isPlaying`
    // keeps answering true for a cue that is on its way out and the retrigger
    // rule refuses to restart it.
    forget(voice)
  }

  /**
   * One layer, built. `filter` is the noise layer's biquad, or null for a tone.
   *
   * Returned rather than dropped because a noise layer's PITCH lives on that
   * filter's frequency (see `Voice.oscillators`), so S4's `rate` has nowhere
   * else to go — and reading it back off the node later is not possible: the
   * node is not reachable from the source.
   */
  interface BuiltLayer {
    readonly source: OscillatorNode | AudioBufferSourceNode
    readonly filter: BiquadFilterNode | null
  }

  const buildLayer = (
    context: AudioContext,
    destination: GainNode,
    layer: CueLayer,
    options: PlayOptions,
    spec: CueSpec,
    now: number,
  ): BuiltLayer => {
    const gain = context.createGain()
    const startAt = now + layer.delaySeconds
    applyEnvelope(gain.gain, layer.env, layer.gain, startAt, spec.loop, spec.durationSeconds)
    gain.connect(destination)

    if (layer.kind === 'tone') {
      const osc = context.createOscillator()
      osc.type = layer.wave
      osc.detune.setValueAtTime(layer.detuneCents + options.detuneCents, startAt)
      // `pitch` is 2016's `m_Pitch` — a sample playback RATE — reinterpreted as
      // a frequency multiplier, which is the only mapping that survives having
      // no clip. See the header of `cues.ts`.
      const from = layer.startHz * options.pitch
      const to = layer.endHz * options.pitch
      osc.frequency.setValueAtTime(from, startAt)
      if (layer.sweepSeconds > 0 && to !== from) {
        osc.frequency.exponentialRampToValueAtTime(
          Math.max(SILENT, to),
          startAt + layer.sweepSeconds,
        )
      }
      osc.connect(gain)
      osc.start(startAt)
      return { source: osc, filter: null }
    }

    const source = context.createBufferSource()
    source.buffer = ensureNoise(context)
    source.loop = true
    const filter = context.createBiquadFilter()
    filter.type = layer.filter
    filter.Q.setValueAtTime(layer.q, startAt)
    const from = layer.startHz * options.pitch
    const to = layer.endHz * options.pitch
    filter.frequency.setValueAtTime(from, startAt)
    if (layer.sweepSeconds > 0 && to !== from) {
      filter.frequency.exponentialRampToValueAtTime(
        Math.max(SILENT, to),
        startAt + layer.sweepSeconds,
      )
    }
    source.connect(filter)
    filter.connect(gain)
    source.start(startAt)
    return { source, filter }
  }

  /**
   * Build one voice and hang it on the graph. Shared by `play` and `emit`.
   *
   * The chain is `layers -> voice gain -> [panner] -> master`. The panner sits
   * AFTER the voice gain rather than before, so a fade-out and a distance
   * attenuation multiply instead of fighting — the same reason `stop()` and
   * `setCueGain()` were given one node to ramp between them.
   */
  const startVoice = (spec: CueSpec, options: PlayOptions): Voice | null => {
    const context = ctx
    const out = master
    if (!context || !out) return null
    const now = context.currentTime
    // Catalogue gain x this play's multiplier. `?? 1` for everything 2016 fires.
    const baseGain = spec.gain * (options.gain ?? 1)
    const gain = context.createGain()
    gain.gain.setValueAtTime(spec.fadeInSeconds > 0 ? SILENT : baseGain, now)
    if (spec.fadeInSeconds > 0) {
      // 2016's `useFades` / `fadeInTime`, which `SoundGroupVariation.cs:353-362`
      // really does apply on play — `Ambient_Island`'s 1 s is behaviour, not
      // just a serialised field.
      gain.gain.linearRampToValueAtTime(baseGain, now + spec.fadeInSeconds)
    }

    // A cue is positional only when the CATALOGUE says it is and the caller
    // actually supplied a point. Both, because a `spatial` spec with no
    // position would panner-lock the cue to the world origin, which is inaudible
    // in a test and a sound coming from the sea in a headset.
    const panner =
      spec.spatial && options.position ? buildPanner(context, spec.spatial, options.position) : null
    if (panner) {
      gain.connect(panner)
      panner.connect(out)
    } else {
      gain.connect(out)
    }

    const voice: Voice = {
      id: spec.id,
      gain,
      sources: [],
      oscillators: [],
      filters: [],
      panner,
      destination: panner ?? out,
      // The per-play multiplier, folded in HERE so that everything downstream —
      // `setCueGain`, `modulate`, `EmitterHandle.setGain` — keeps scaling the
      // one number that means "this voice at its intended level". Absent on
      // every cue but S4's gate whoosh, so `?? 1` leaves the other 22 exactly
      // as they were.
      baseGain,
      loop: spec.loop,
      stopping: false,
      modGain: null,
      modFilter: null,
      chainTail: gain,
    }
    for (const layer of spec.layers) {
      const built = buildLayer(context, gain, layer, options, spec, now)
      voice.sources.push(built.source)
      if (layer.kind === 'tone') {
        voice.oscillators.push({
          node: built.source as OscillatorNode,
          baseDetune: layer.detuneCents + options.detuneCents,
        })
      } else if (built.filter) {
        voice.filters.push({ node: built.filter, baseHz: layer.startHz * options.pitch })
      }
    }

    const list = voices.get(spec.id)
    if (list) list.push(voice)
    else voices.set(spec.id, [voice])

    if (!spec.loop) {
      // A one-shot tears itself down. `cueTailSeconds` is the max over layers
      // of `delay + attack + decay + release`, DERIVED rather than trusted,
      // because a layer with a late delay can outlive the cue's declared
      // length — and a voice stopped before its own release is a click.
      const tail = cueTailSeconds(spec) + 0.05
      for (const source of voice.sources) {
        try {
          source.stop(now + tail)
        } catch {
          // See `teardown`.
        }
      }
      // `release`, not `forget`: a one-shot that runs to completion must unhook
      // its panner too. The shaft whoosh is a one-shot WITH a panner and it
      // fires eight times a ride, so "the one-shot path forgets the voice and
      // leaves the node" would have leaked eight HRTF panners per launch.
      const last = voice.sources[voice.sources.length - 1]
      if (last) last.onended = () => release(voice)
      else release(voice)
    }
    return voice
  }

  const fadeOut = (voice: Voice, fadeSeconds: number): void => {
    const context = ctx
    if (!context || voice.stopping) return
    voice.stopping = true
    const now = context.currentTime
    const fade = Math.max(0.01, fadeSeconds)
    rampFromCurrent(voice.gain.gain, SILENT, now, fade)
    teardown(voice, now + fade + 0.02)
  }

  return {
    get running() {
      return ctx !== null && ctx.state === 'running'
    },

    /**
     * The device exists — i.e. some gesture has been through `resume()`.
     *
     * NOT `running`: a suspended context decodes fine, and a headset coming
     * off suspends one. See the interface for what the playlist does with the
     * difference (DEV-247).
     */
    get hasOutput() {
      return ctx !== null
    },

    async resume() {
      if (!ctx) {
        if (typeof globalThis.AudioContext !== 'function') return
        ctx = new globalThis.AudioContext()
        master = ctx.createGain()
        master.gain.value = masterGain
        master.connect(ctx.destination)
        musicBus = ctx.createGain()
        musicBus.gain.value = musicGain
        // DEV-643: the duck is a gain AFTER the bus, so the player's volume and a
        // crash's black are two independent controls.
        musicDuckGain = ctx.createGain()
        // DEV-645: the music's filter pair follows the duck: bus -> duck (volume)
        // -> low-pass -> high-shelf -> destination. Volume first, then tone; the
        // nodes are linear, so the order is only about which is read as "the
        // volume stage" (the duck) and which as "the tone stage" (the filters).
        musicLow = ctx.createBiquadFilter()
        musicLow.type = 'lowpass'
        musicLow.Q.value = 0.707
        musicLow.frequency.value = musicFilter.lowpassHz
        musicShelf = ctx.createBiquadFilter()
        musicShelf.type = 'highshelf'
        musicShelf.frequency.value = MUSIC_FILTER.shelfHz
        musicShelf.gain.value = musicFilter.highShelfDb
        musicBus.connect(musicDuckGain)
        musicDuckGain.connect(musicLow)
        musicLow.connect(musicShelf)
        musicShelf.connect(ctx.destination)
        applyDuck(0.01)
        // A context built mid-run starts at the default listener, which is the
        // origin looking down −z — i.e. two kilometres from the player, facing
        // the wrong way. Whatever pose the game has been feeding while there was
        // nowhere to put it goes on immediately.
        applyListener(ctx, listenerPose)
      }
      // Idempotent on purpose: this is called on every gesture, and a context
      // that is already running answers immediately.
      if (ctx.state === 'suspended') await ctx.resume()
    },

    play(spec, options) {
      startVoice(spec, options)
    },

    setListener(pose) {
      listenerPose = pose
      if (ctx) applyListener(ctx, pose)
    },

    emit(spec, options) {
      const context = ctx
      const voice = startVoice(spec, options)
      if (!context || !voice) return deadEmitter(spec.id)
      let live = true
      return {
        cue: spec.id,
        get live() {
          return live && !voice.stopping
        },
        moveTo(to) {
          if (!live || voice.stopping || !voice.panner) return
          setPosition(voice.panner, to, context.currentTime, MOVE_RAMP_SECONDS)
        },
        setDetune(cents) {
          if (!live || voice.stopping) return
          const now = context.currentTime
          for (const { node, baseDetune } of voice.oscillators) {
            // `setTargetAtTime` rather than a step: a Doppler shift arrives once
            // a frame and stepping it would be a zipper on a sustained tone.
            // 30 ms is well under a frame at 72 Hz, so it tracks without
            // stepping. Absolute, off the authored baseline — never relative to
            // where the last ramp got to.
            node.detune.setTargetAtTime(baseDetune + cents, now, 0.03)
          }
        },
        setGain(to, seconds) {
          if (!live || voice.stopping) return
          const now = context.currentTime
          rampFromCurrent(voice.gain.gain, voice.baseGain * to, now, Math.max(0.01, seconds))
        },
        stop(fadeSeconds) {
          if (!live) return
          live = false
          fadeOut(voice, fadeSeconds)
        },
      }
    },

    stop(id, fadeSeconds) {
      if (!ctx) return
      const list = voices.get(id)
      if (!list) return
      for (const voice of [...list]) fadeOut(voice, fadeSeconds)
    },

    setCueGain(id, to, seconds) {
      const context = ctx
      if (!context) return
      const list = voices.get(id)
      if (!list) return
      const now = context.currentTime
      for (const voice of list) {
        if (voice.stopping) continue
        rampFromCurrent(voice.gain.gain, voice.baseGain * to, now, Math.max(0.01, seconds))
      }
    },

    /**
     * S4's continuous layer — the only thing in this file 2016 has no analogue
     * for. Anniversary only: `engine.ts` emits no `modulate` with null curves.
     *
     * Every target is chased with `setTargetAtTime` and none of them cancels
     * anything. That is deliberate and it is the difference between this and
     * `setCueGain` above: a `modulate` arrives 82 times a second and may land in
     * the same millisecond as the cue's own fade-in or as a `stop()`, so a
     * `cancelScheduledValues` here would be a coin flip over which schedule
     * survives. The gain goes on a node of its own instead (see the header), the
     * two multiply, and a re-issued `setTargetAtTime` supersedes the previous one
     * from wherever the param has got to — which is exactly the semantics wanted.
     */
    modulate(id, target) {
      const context = ctx
      if (!context) return
      const list = voices.get(id)
      if (!list) return
      const now = context.currentTime
      for (const voice of list) {
        if (voice.stopping) continue
        if (target.gain !== undefined) {
          if (!voice.modGain) {
            const node = context.createGain()
            // At the FIRST target, not at 1. The first `modulate` for a loop
            // arrives in the same action list as its `play` (see the S4 block in
            // `engine.ts`), so a node built at unity would put one tick of the
            // authored level in front of a curve that starts at zero — an
            // audible tick at the top of every wind fade-in.
            node.gain.setValueAtTime(Math.max(SILENT, target.gain), now)
            voice.modGain = node
            spliceIntoChain(voice, node)
          } else {
            voice.modGain.gain.setTargetAtTime(Math.max(SILENT, target.gain), now, MODULATE_TAU)
          }
        }
        if (target.cutoffHz !== undefined) {
          const hz = audibleHz(context, target.cutoffHz)
          if (!voice.modFilter) {
            const node = context.createBiquadFilter()
            node.type = 'lowpass'
            // Q at the default 1 — a resonant peak is a colour nobody asked for,
            // and this filter's job is to take the top off the wind, not to
            // whistle.
            node.frequency.setValueAtTime(hz, now)
            voice.modFilter = node
            spliceIntoChain(voice, node)
          } else {
            voice.modFilter.frequency.setTargetAtTime(hz, now, MODULATE_TAU)
          }
        }
        if (target.rate !== undefined) {
          const rate = Math.max(SILENT, target.rate)
          // A frequency RATIO as cents, which is the unit `detune` takes.
          const cents = 1200 * Math.log2(rate)
          for (const { node, baseDetune } of voice.oscillators) {
            node.detune.setTargetAtTime(baseDetune + cents, now, MODULATE_TAU)
          }
          // And the noise layers through their filters, because that is where a
          // noise layer's pitch is. Absolute, off the authored baseline — never
          // relative to where the last tick got to.
          for (const { node, baseHz } of voice.filters) {
            node.frequency.setTargetAtTime(audibleHz(context, baseHz * rate), now, MODULATE_TAU)
          }
        }
      }
    },

    isPlaying(id) {
      const list = voices.get(id)
      if (!list) return false
      return list.some((voice) => !voice.stopping)
    },

    setMasterGain(gain) {
      masterGain = gain
      if (master && ctx) {
        master.gain.setTargetAtTime(gain, ctx.currentTime, 0.02)
      }
    },

    setMusicFilter(filter) {
      musicFilter = filter
      if (musicLow && musicShelf && ctx) {
        // Smoothed, never stepped: a pause is a door closing. The time constant
        // is the sound of that door, not a number of the player's.
        musicLow.frequency.setTargetAtTime(filter.lowpassHz, ctx.currentTime, MUSIC_FILTER_SMOOTH)
        musicShelf.gain.setTargetAtTime(filter.highShelfDb, ctx.currentTime, MUSIC_FILTER_SMOOTH)
      }
    },

    setMusicDuck(amount, seconds) {
      duckAmount = amount > 0 ? (amount < 1 ? amount : 1) : 0
      applyDuck(seconds)
    },

    setMusicGain(gain) {
      musicGain = gain
      if (musicBus && ctx) {
        // `setTargetAtTime`, not a step: this is on the player's mute button,
        // and a `GainNode` stepped to zero mid-waveform is a click at exactly
        // the moment somebody has asked for quiet.
        musicBus.gain.setTargetAtTime(gain, ctx.currentTime, 0.02)
      }
    },

    /**
     * Fetch and decode one track. Never rejects — every failure is `null`.
     *
     * **No context means no decode**, because `decodeAudioData` is a method ON
     * an `AudioContext` and this module does not build one outside a user
     * gesture (see the header). In practice every music cue is downstream of a
     * confirm press that called `resume()` first, and `resume()` constructs the
     * context synchronously before its own `await` — so `ctx` is already there.
     * A page that somehow asks for music without ever having had a gesture gets
     * the same legible "could not be played" warning as a 404, which is the
     * correct outcome: there is nowhere to send the audio.
     */
    async loadMusic(src) {
      const context = ctx
      if (!context) return null
      try {
        const response = await fetch(src)
        if (!response.ok) {
          failedMusic(src, `HTTP ${response.status}`)
          return null
        }
        // ── A 200 is not a file (DEV-247) ─────────────────────────────────
        //
        // An SPA host answers an unknown path with `index.html` and status
        // **200**, so `response.ok` is true and the next line hands 10 kB of
        // markup to `decodeAudioData`, which throws `EncodingError` — and the
        // caller reports the same "could not be played" it reports for a
        // codec problem. That is exactly how the live site hid a missing base
        // URL: `ff-10yr.pages.dev/assets/audio/music/drama.opus` returns
        // `200 text/html`, verified 2026-09-20.
        //
        // Checked rather than inferred from the extension, because the whole
        // point is that the URL looked right.
        const type = response.headers.get('content-type') ?? ''
        if (type !== '' && !type.startsWith('audio/') && !type.startsWith('application/octet')) {
          failedMusic(src, `the server answered ${response.status} ${type}, which is not audio`)
          return null
        }
        const bytes = await response.arrayBuffer()
        // The promise form. The callback form is the one older WebKit needs and
        // FF2's floor is a browser that ships WebXR, which is well past it.
        const data = await context.decodeAudioData(bytes)
        const buffer: MusicBuffer = { src, durationSeconds: data.duration }
        decoded.set(buffer, data)
        return buffer
      } catch (error) {
        // A 404 body, a codec this browser will not take, a network that went
        // away mid-fetch, a context closed by `dispose()` while the decode was
        // in flight. All the same thing to the caller: no track.
        //
        // The CALLER still gets one shape — that invariant is the interface's
        // and it stands. What changed in DEV-247 is that the reason is no
        // longer thrown away on the way past: the playlist can only say what
        // happened ("could not be played"), and only this frame knows why.
        failedMusic(src, String(error))
        return null
      }
    },

    playMusic(buffer) {
      const context = ctx
      const bus = musicBus
      const data = decoded.get(buffer)
      if (!context || !bus || !data) return deadMusicVoice(buffer.src)

      const source = context.createBufferSource()
      source.buffer = data
      // NOT `loop`. Auto-advance is the playlist's job and looping here would
      // make `onended` unreachable — 2016 loops the PLAYLIST (`loopPlaylist: 1`),
      // never a song.
      source.loop = false
      const gain = context.createGain()
      // Silent at start: every route in is a fade, and a voice that starts at
      // unity and is ramped down is a click before it is a fade.
      gain.gain.setValueAtTime(0, context.currentTime)
      source.connect(gain)
      gain.connect(bus)
      source.start()

      let live = true
      let ended: (() => void) | null = null
      source.onended = () => {
        const reachedItsOwnEnd = live
        live = false
        try {
          gain.disconnect()
        } catch {
          // Already disconnected. Not a reason to take the frame down.
        }
        // Only when the BUFFER ran out. A voice stopped by `fadeOut` has
        // already been handed over to its successor, and calling back there
        // would advance the playlist a second time.
        if (reachedItsOwnEnd) ended?.()
      }

      const voice: MusicVoice = {
        src: buffer.src,
        get live() {
          return live
        },
        fadeIn(seconds) {
          if (!live) return
          applyFade(gain.gain, 'in', seconds, context.currentTime)
        },
        fadeOut(seconds) {
          if (!live) return
          live = false
          const now = context.currentTime
          applyFade(gain.gain, 'out', seconds, now)
          try {
            source.stop(now + Math.max(0, seconds) + MUSIC_STOP_MARGIN)
          } catch {
            // Already stopped, or never started. See `teardown`.
          }
        },
        onEnded(callback) {
          ended = callback
        },
      }
      return voice
    },

    stopAll(fadeSeconds) {
      if (!ctx) return
      for (const list of [...voices.values()]) {
        for (const voice of [...list]) fadeOut(voice, fadeSeconds)
      }
      voices.clear()
    },

    dispose() {
      const context = ctx
      voices.clear()
      ctx = null
      master = null
      // Closing the context takes every music voice with it, which is why there
      // is no register of them here: a `BufferSourceNode` whose context is
      // closed is not a leak, it is garbage.
      musicBus = null
      musicLow = null
      musicShelf = null
      musicDuckGain = null
      noiseBuffer = null
      if (context) void context.close()
    },
  }
}
