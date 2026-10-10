// src/audio/racer-engines.ts — one positional engine loop per AI racer.
// PURE apart from the backend it is handed. No three, no DOM, no `AudioContext`.
//
// ── What 2016 had, measured ───────────────────────────────────────────────
//
// `Scenes/environments/LevelArt_SimonetIslands.unity` carries FOUR raw Unity
// `AudioSource`s — not MasterAudio groups, which is why the audio survey found
// nothing when it looked in the banks, and why they sit on stripped `!u!1001`
// prefab instances (parent guid `9bd38ed1c57c4f24e91b194ed05cd986`) that a name
// grep over the scene cannot see. First is `&104834125` at scene line 267; the
// file holds exactly four `DopplerLevel: 1.04`.
//
//   m_PlayOnAwake 1 · Loop 1 · m_Volume 1 · m_Pitch 1
//   DopplerLevel 1.04 · MinDistance 48 · MaxDistance 800 · rolloffMode 0
//   panLevelCustomCurve = 1 at t=0                      (fully 3D)
//   clip  Jet2EngineExt.wav   mixer  Audio/Mixer/NPC Ship.mixer
//
// So the opposition's engines were **positional, Doppler-shifted and
// distance-attenuated in 2016**. FF2's opposition is DEV-026's own AI racers
// rather than those four recordings, so the cue itself is FF2's (DEV-063) — but
// the distance model and the Doppler are 2016's numbers, ported.
//
// ── The mixer ramp is real behaviour and it is worth porting ──────────────
//
// `NPC Ship.mixer` holds its Master at **−30.9 dB** in the `Pre-Launch` snapshot
// and transitions to **+0.13552584 dB** over 2 s when `E3/Scripts/Timer_Race.cs:70`
// calls `AudioDelayHack.TransitionToGameplay()` on GO. So the opposition is 31 dB
// down until the countdown ends, then swells in over two seconds. `mix.ts` has
// carried both numbers since the audio port landed with nothing using them.
//
// That matters more in FF2 than it did in 2016: FF2's racers sit on their pads
// beside you through the whole lift ride and the 3-2-1, and two jets idling at
// full volume through the countdown would bury the countdown.
//
// ── Trap 19, which is this module's whole shape ───────────────────────────
//
// `ai-racer.ts` shared ONE module-level `HoverJetInput` across every racer;
// `autopilotActions` writes all six fields and the finished branch wrote two,
// so a finished racer flew on with the OTHER racer's stick, frozen, until it
// went into the sea. Invisible to every single-object test, because with one
// racer there is nobody to inherit from.
//
// Every per-racer quantity here — the handle, the last distance, the last
// detune — lives in that racer's own `Engine` record, and there is no
// module-level mutable anything. `tests/unit/audio-spatial.test.ts` runs the
// guard that catches this shape: **start a SECOND racer and assert the first
// did not move.**

import type { EditionEnginePitchTracking } from '@/content/edition-schema'
import { slewToward } from '@/sim/math/scalar'
import type { AudioBackend, EmitterHandle } from './backend'
import { CUES } from './cues'
import { dbToGain, NPC_MIXER_GAMEPLAY_DB, NPC_MIXER_PRELAUNCH_DB } from './mix'
import {
  distanceToListener,
  dopplerRatio,
  type ListenerPose,
  ratioToCents,
  type Vec3Tuple,
} from './spatial'
import { speedRate } from './speed-curves'

/** `NPC Ship.mixer`'s ramp, in seconds. `E3/Scripts/AudioDelayHack.cs:12`. */
export const NPC_RAMP_SECONDS = 2

/**
 * The pre-GO gain, as a multiplier on the cue's own catalogue gain.
 *
 * The mixer's two snapshots are absolute dB on the same Master, so the ratio
 * between them is what survives being re-expressed as a multiplier on a cue
 * gain that already includes the Gameplay snapshot (see `cues.ts`). That is
 * `dbToGain(-30.9) / dbToGain(+0.13552584)` = **0.0282**, i.e. 31 dB down.
 *
 * Stated as the ratio OF two measured dB values rather than as "0.028", because
 * DEV-027's rule is that a number you computed needs to say what it is the
 * ratio of.
 */
export const PRELAUNCH_GAIN = dbToGain(NPC_MIXER_PRELAUNCH_DB) / dbToGain(NPC_MIXER_GAMEPLAY_DB)

/** What a racer's engine fades over when its run ends. */
export const RACER_STOP_SECONDS = 1.5

/**
 * How many racer engines may be live at once: the NEAREST ones. DEV-125.
 *
 * Two racers was two panners, and nobody had to think about it. Five is five
 * `PannerNode`s each with an HRTF or equal-power pan, a Doppler detune and a
 * gain ramp, every frame — cheap on a desktop, not free on a Quest's audio
 * thread, and past the third-nearest jet indistinguishable: 2016's own
 * `MinDistance 48 / MaxDistance 800` log rolloff puts a racer 400 m out at
 * −18 dB under one at 48 m, and on a course where the field spreads over a
 * kilometre in the first minute the fourth and fifth are under the player's
 * own engine.
 *
 * Three, then: the whole grid is audible on the pads and through the first
 * straight, where they are all within 30 m, and once the field strings out
 * the far ones drop away — which is also what a listener would expect. A
 * racer that comes back within range starts up again (no Doppler on its first
 * frame, as for any racer that appears). One slot of hysteresis stops two
 * jets trading the last engine every frame as they swap places.
 *
 * A budget, not a look, so it lives here and not in the preset; the option on
 * `createRacerEngines` exists so a test can pin it and a headset session can
 * try another.
 */
export const RACER_ENGINE_BUDGET = 3

/** One racer, as this module needs to see it. Position is WORLD metres. */
export interface RacerAudioInput {
  readonly id: string
  readonly position: Vec3Tuple
  /**
   * Its forward speed, m/s — the magnitude of its own velocity, the same
   * quantity the player's `stepFlight` is given.
   *
   * DEV-137: on the Anniversary preset a racer's engine takes the same
   * speed-tracking rate the player's does, so a racer heard passing changes
   * pitch for how fast IT is going as well as for the Doppler of the pass.
   * Ignored when the tracking is off; required anyway, because an optional
   * field is a field a caller forgets.
   */
  readonly speed: number
  /**
   * True once its run is over.
   *
   * 2016's four sources are `PlayOnAwake` and nothing ever stops them, but 2016
   * had four recordings that flew a fixed circuit forever; FF2's racers finish,
   * climb out and stop being opposition. A finished racer's engine fades over
   * `RACER_STOP_SECONDS` and its node is TORN DOWN — an emitter with nothing
   * driving it is the positional-audio version of the stale-scratch bug, and it
   * is silent in a test and permanent in a headset.
   */
  readonly finished: boolean
}

export interface RacerEngines {
  /** How many engines are live. */
  readonly count: number
  /** The ids with a live engine, in start order. For tests and for the debug HUD. */
  readonly ids: readonly string[]
  /**
   * Start, move and retire engines to match `racers`.
   *
   * Call once per rendered frame with the interpolated world positions and the
   * frame delta. An id that is absent, or present with `finished: true`, is
   * faded out and forgotten.
   */
  sync(racers: readonly RacerAudioInput[], listener: ListenerPose, dt: number): void
  /**
   * GO. Ramp every live engine from the `Pre-Launch` snapshot to `Gameplay`
   * over 2 s — `Timer_Race.cs:70`.
   */
  release(): void
  /** Everything off. The mission exit, the restart, the dispose. */
  stopAll(fadeSeconds?: number): void
  /**
   * DEV-137: install the speed-tracking pitch, or `null` to leave every racer at
   * its Doppler alone. The same block the player's ladder reads, so the two
   * cannot drift apart by being tuned in two places.
   */
  setPitchTracking(tracking: EditionEnginePitchTracking | null): void
}

interface Engine {
  readonly handle: EmitterHandle
  /**
   * DEV-137: this racer's speed-tracking rate as it currently is, after the
   * slew. Per engine, for the reason everything in this record is: a racer
   * that hits the sea must glide its own pitch down and leave the other's alone.
   */
  trackedRate: number
  /**
   * Distance to the ears last frame, for the radial velocity the Doppler wants.
   *
   * Seeded at `start()` from the position the emitter is created at, NOT left
   * empty for a frame. One sample is not a velocity — but the start frame has a
   * position and a listener, so it IS a sample, and treating it as one is the
   * difference between the Doppler arriving on frame 2 and arriving on frame 3.
   * (It was frame 3 on the first pass here, and the two-racer test is what
   * showed it: with one racer the delay is a frame nobody can hear.)
   */
  lastDistance: number
}

/**
 * Build the owner. Takes the backend rather than the whole system, because this
 * needs `emit` and nothing else.
 */
export const createRacerEngines = (
  backend: AudioBackend,
  options: { readonly maxAudible?: number } = {},
): RacerEngines => {
  const maxAudible = options.maxAudible ?? RACER_ENGINE_BUDGET
  // Per-system, never handed out, keyed by racer id. Not module-level: two
  // `RacerEngines` in one process (a test, a second scene) must not share state.
  const live = new Map<string, Engine>()
  // Latched rather than read from the caller, because `release()` is a moment
  // and `sync()` is a frame: a racer that comes into existence after GO has to
  // start at the gameplay gain, not ramp up from 31 dB down all over again.
  let released = false
  // DEV-137. Null is Classic, and null is also what a system that has never
  // been told about a preset has — so the Doppler-only path is the default.
  let tracking: EditionEnginePitchTracking | null = null

  const start = (racer: RacerAudioInput, listener: ListenerPose): Engine => {
    const spec = CUES['racer.engine']
    const at = racer.position
    const handle = backend.emit(spec, { pitch: spec.pitch, detuneCents: 0, position: at })
    // The pre-GO duck is applied at zero seconds rather than ramped: the engine
    // is being STARTED at that level, not moved to it.
    if (!released) handle.setGain(PRELAUNCH_GAIN, 0)
    return {
      handle,
      // Seeded to the speed it appears AT, like the player's — a racer that
      // comes into existence at 200 m/s must not open with a glide up from idle.
      trackedRate: tracking ? speedRate(tracking, racer.speed) : 1,
      lastDistance: distanceToListener(listener, at),
    }
  }

  const retire = (id: string, fadeSeconds: number): void => {
    const engine = live.get(id)
    if (!engine) return
    live.delete(id)
    engine.handle.stop(fadeSeconds)
  }

  return {
    get count() {
      return live.size
    },
    get ids() {
      return [...live.keys()]
    },

    sync(racers, listener, dt) {
      // ── the budget: the nearest `maxAudible` racers are the audible ones ──
      //
      // Ranked by distance to the ears this frame. Rank < budget may START an
      // engine; rank > budget RETIRES one; rank == budget keeps whatever it
      // has — the one slot of hysteresis that stops two jets a metre apart in
      // range trading the last engine every frame.
      const running = racers.filter((r) => !r.finished)
      const byDistance = running
        .map((r) => ({ id: r.id, d: distanceToListener(listener, r.position) }))
        .sort((a, b) => a.d - b.d)
      const rank = new Map(byDistance.map((r, i) => [r.id, i]))

      // Retire first, so an id that is both absent and re-added in the same
      // frame cannot end up with two emitters on one racer.
      const present = new Set(running.map((r) => r.id))
      for (const id of [...live.keys()]) {
        if (!present.has(id) || (rank.get(id) as number) > maxAudible) {
          retire(id, RACER_STOP_SECONDS)
        }
      }

      for (const racer of racers) {
        if (racer.finished) continue
        let engine = live.get(racer.id)
        if (!engine && (rank.get(racer.id) as number) >= maxAudible) continue
        if (!engine) {
          engine = start(racer, listener)
          live.set(racer.id, engine)
          // No Doppler on the frame a racer APPEARS: it has one sample and no
          // elapsed time, and a shift computed from that is a chirp on every
          // ship that comes into existence.
          continue
        }
        engine.handle.moveTo(racer.position)

        const distance = distanceToListener(listener, racer.position)
        const previous = engine.lastDistance
        engine.lastDistance = distance
        if (dt <= 0) continue
        // Positive when the gap is SHRINKING, which is when the pitch goes up.
        const closing = (previous - distance) / dt
        const spatial = CUES['racer.engine'].spatial
        const dopplerCents = ratioToCents(dopplerRatio(closing, spatial?.doppler ?? 0))
        // DEV-137: the speed-tracking rate, slewed on the FRAME delta because
        // that is the clock this runs on, and ADDED in cents — two ratios
        // multiply, and cents are their logarithm. Zero when the tracking is
        // off, so the Classic detune is the Doppler alone, as it was.
        let rateCents = 0
        if (tracking) {
          engine.trackedRate = slewToward(
            engine.trackedRate,
            speedRate(tracking, racer.speed),
            tracking.slewPerSecond * dt,
          )
          rateCents = ratioToCents(engine.trackedRate)
        }
        engine.handle.setDetune(dopplerCents + rateCents)
      }
    },

    setPitchTracking(next) {
      tracking = next
    },

    release() {
      if (released) return
      released = true
      for (const engine of live.values()) engine.handle.setGain(1, NPC_RAMP_SECONDS)
    },

    stopAll(fadeSeconds = RACER_STOP_SECONDS) {
      for (const id of [...live.keys()]) retire(id, fadeSeconds)
      released = false
    },
  }
}
