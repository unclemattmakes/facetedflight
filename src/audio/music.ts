// src/audio/music.ts — the soundtrack: the playlist, and the thing that plays it.
//
// ── Read this before adding a track ───────────────────────────────────────
//
// **There are no tracks here and adding one is a licensing act, not a commit.**
// D31: the anniversary soundtrack is NEW — commissioned or generated — and it
// does not exist yet. Whatever lands, full attribution is a SHIPPING CONDITION
// and not a nicety wherever the licence asks for one: author, title, URI and the
// licence-and-version kept **with the copy**, the credits screen, `THIRD-PARTY-NOTICES.md`
// served at the site, the container tags, plus the licence text and a dated
// capture archived in `docs/private/licences/`. CI already asserts `dist/`
// contains no audio file absent from `THIRD-PARTY-NOTICES.md` (risk F20), so the gate is
// real and a track dropped in without its line will fail the build.
//
// Everything else in `src/audio/` is synthesized and therefore first-party by
// construction. Music is the one part that is not, which is why the paperwork
// is the gate and the PLAYBACK is not: this file plays whatever it is given and
// does nothing at all when it is given nothing.
//
// ── What 2016 did, so that the shape is right ─────────────────────────────
//
// `int_01_hoverJet.unity:284174` `PlaylistController`:
//   startPlaylistOnAwake 0   isShuffle 1        isAutoAdvance 1
//   loopPlaylist 1           _playlistVolume 1  startPlaylistName "Music"
//   spatialBlendType 0       (= ForceTo2D, MasterAudio.cs:208-213)
//
// Shuffle is WITHOUT REPLACEMENT and refills on loop:
// `PlaylistController.cs:615` `PlayARandomSong` removes the chosen clip at
// `:657` and `:658-659` refills when the pool empties. `nextShuffled` below is
// that, and it is the one piece of this file worth a unit test.
//
// Crossfade is **2 s**, from the bank singleton — both playlists carry
// `crossfadeMode: 0` (`UseMasterSetting`), so their own `crossFadeTime: 1` is
// inert (`PlaylistController.cs:1615-1624`). The MENU bank's singleton is 1 s.
// See `mix.ts`; `MusicBank` below is which of the two a playlist is under.
//
// And it is started TWICE in `int_01`, which is not obvious and is not a bug:
//   1. `ScriptedAudio_elevator.cs:22` `TriggerRandomPlaylistClip()` — one random
//      clip, at t+14.3 s of the elevator coroutine.
//   2. `Timer_Race.cs:75-77` `StartPlaylist("Music")` then
//      `FadePlaylistToVolume(0, 0)` / `(userMusicMaxVolume, 1f)` on GO — which
//      `PlaylistController.cs:867-876` routes to `RestartPlaylist()`, re-seeding
//      the without-replacement pool and cutting to a DIFFERENT random song,
//      faded in from silence over 1 s.
// So: a track under the lift, then a fresh one faded in on GO. `MusicCue`
// below names both moments, and `src/audio/index.ts` routes them off the events
// the game already sends — so wiring the soundtrack in costs `setTracks()` and
// nothing else.
//
// ── GO is a NEW song, and that is FF2's (DEV-423) ─────────────────────────
//
// Matt, 2026-09-26: *"start a new song once the race starts."* 2016's GO is
// `RestartPlaylist()` (`PlaylistController.cs:867-876` -> `:926` ->
// `FinishPlaylistInit` -> `InitializePlaylist` -> `FillClips`), so the pool is
// re-seeded and the pick is uniform over EVERY track — including the one the
// lift is playing. With six tracks that is the same song, cut and started again
// from its first bar, one race in six; and because the pool is re-seeded on
// every GO it never remembers the last race either. The port reproduced that
// exactly, and under the constant `random` the system tests use it was the same
// song every time.
//
// So GO draws from the pool as it stands — without replacement, carried across
// races — and never picks the track that is already sounding. Six races are six
// different songs before any repeats, and GO is always a change you can hear.
// The cut, the 1 s swell and the timing are 2016's and unchanged; only which
// song comes up is ours. `tests/unit/music-playback.test.ts`, DEVIATIONS DEV-423.
//
// ── Three implementation calls, and why ───────────────────────────────────
//
// **1. The crossfade is EQUAL-POWER, and 2016's was linear.** DEV-066.
// `PlaylistController.cs:368-369` is
//   `_activeAudio.volume = ratioPassed * end;`
//   `_transitioningAudio.volume = start * (1 - ratioPassed);`
// — two amplitudes summing to 1 throughout. Two different songs are
// uncorrelated, so they sum in POWER and not in amplitude: at the midpoint a
// linear pair carries `0.5² + 0.5² = 0.5` of the power, a **−3.01 dB hole** in
// the middle of every track change. `crossfadeGains` below is
// `cos`/`sin(x·π/2)`, whose squares sum to 1 at every x, so the loudness is
// flat across the fade. The TIMING is 2016's — the handoff is scheduled
// `crossfadeSeconds` before the outgoing track ends (`:390-391`) — only the
// curve is ours. `tests/unit/music-playback.test.ts` asserts both halves of
// that claim, including the dip the linear one would have had.
//
// **2. Nothing waits for a track.** `start()` picks synchronously and returns;
// the fetch and `decodeAudioData` run on their own, and the voice comes up
// whenever they land. A track that has not decoded by the time the lift moves
// does not stall the lift — it starts late, or not at all. There is no
// pre-decode during the hangar and there is no cache of decoded buffers,
// because a decoded `AudioBuffer` is raw float PCM: `seconds × sampleRate ×
// channels × 4 bytes`, which for a three-minute stereo track at 48 kHz is
// **69 MB**. Six of those is 414 MB of headset memory to save a few hundred
// milliseconds once per track per session. The compressed file is what the HTTP
// cache holds, and that is the right place for it.
//
// **3. A missing track degrades to silence and then to the next track.** A
// `loadMusic` that answers `null` — 404, bad codec, network gone, `?audio=off`
// — warns once for that src and advances. Bounded by the track count, so a
// playlist where every file is missing warns, gives up and leaves the game
// playing; it does not spin. The game ships music-less today and must keep
// booting when a fetch 404s tomorrow.

import type { AudioBackend, MusicBuffer, MusicVoice } from './backend'
import {
  MASTER_MUSIC,
  MENU_MUSIC_CROSSFADE_SECONDS,
  MUSIC_CROSSFADE_SECONDS,
  MUSIC_GO_FADE_SECONDS,
} from './mix'

/**
 * One track, with the attribution that must travel with it.
 *
 * Every field is mandatory on purpose. A `MusicTrack` that cannot say who wrote
 * it and under what licence is not a track this game may play, and making that
 * a type error is cheaper than making it a review.
 */
export interface MusicTrack {
  readonly id: string
  readonly title: string
  readonly author: string
  /** SPDX-ish identifier, e.g. `CC-BY-4.0`. */
  readonly licence: string
  /** Where the licence grant can be read. Archived in `docs/private/licences/`. */
  readonly licenceUri: string
  /** Where the audio lives. Not in git — R2, behind a content hash (D12). */
  readonly src: string
}

/** The two moments 2016 starts music, kept so a later wiring does not guess. */
export type MusicCue =
  /** `ScriptedAudio_elevator.cs:22` — one random clip under the lift. */
  | 'lift'
  /**
   * `Timer_Race.cs:75` — the song cut and a NEW one faded in over 1 s, on GO.
   * 2016 re-seeds the pool here; FF2 carries it on and skips the song already
   * playing (DEV-423, see the header).
   */
  | 'go'

/**
 * Which MasterAudio singleton a playlist is under, and therefore how long its
 * crossfade is: **2 s** for the mission bank, **1 s** for the menu bank.
 *
 * A bank and not a playlist setting, because that is where the number actually
 * lives — both playlists carry `crossfadeMode: 0` (`UseMasterSetting`), so the
 * `crossFadeTime: 1` on each of them is inert (`PlaylistController.cs`
 * `:1615-1624`). Modelling it as a per-playlist field would reproduce the
 * number and lose the reason, and the reason is the part that is easy to get
 * wrong twice.
 */
export type MusicBank = 'mission' | 'menu'

/** The bank's crossfade, in seconds. `mix.ts` carries both, with their lines. */
export const bankCrossfadeSeconds = (bank: MusicBank): number =>
  bank === 'menu' ? MENU_MUSIC_CROSSFADE_SECONDS : MUSIC_CROSSFADE_SECONDS

/**
 * The bank the game's one playlist is under. `int_01_hoverJet` loads the
 * mission bank (13 references to its guid, none to the other three
 * `MasterAudio*` prefabs) — `docs/audio-event-map.md` §1.
 *
 * Named rather than defaulted twice: `exactOptionalPropertyTypes` means the
 * caller resolves the option before forwarding it, and a default written in two
 * places is a default that will one day be two different defaults.
 */
export const DEFAULT_MUSIC_BANK: MusicBank = 'mission'

export interface MusicPlaylist {
  readonly tracks: readonly MusicTrack[]
  readonly crossfadeSeconds: number
  /** The track the playlist has SELECTED — which may still be decoding. */
  readonly playing: MusicTrack | null
  /**
   * The DECODED length of the track now sounding, in seconds, or null.
   *
   * The difference between this and {@link MusicPlaylist.playing} is the
   * difference between a track that was chosen and a track that arrived:
   * `playing` is set the instant the shuffle picks, before a byte is fetched,
   * while a duration exists only on the far side of `decodeAudioData`.
   *
   * It is here because that is the one claim an out-of-process test can make
   * about the soundtrack that is not also true of a broken one — DEV-247
   * found the deployed game fetching `index.html` for every track, and every
   * assertion the suite could then write ("a track is selected", "the audio
   * device is running") was TRUE the whole time it was silent.
   */
  readonly playingSeconds: number | null
  /** Music output gain. Starts at 2016's `_masterPlaylistVolume`, 0.75. */
  readonly gain: number
  /**
   * Install the soundtrack. Empty until someone does the licensing work.
   *
   * A separate call rather than a constructor argument so the audio system can
   * be built at boot and the tracks arrive later, from wherever the manifest
   * ends up living. Stops whatever is playing: a new soundtrack is a new
   * soundtrack, not an addition to the pool.
   */
  setTracks(tracks: readonly MusicTrack[]): void
  /**
   * Start, or cut to a new song, per `cue`. A no-op with no tracks.
   *
   * `'lift'` is **idempotent while something is already playing** — 2016's
   * `retrigger: 'ignore'` rule one layer up, and the reason the wiring can hang
   * it off two different events without risking two songs at once.
   * `'go'` always cuts, and always to a track other than the one sounding
   * (while there is another to go to). DEV-423.
   */
  start(cue: MusicCue): void
  /** The auto-advance handoff: crossfade to the next shuffled track. */
  next(): void
  stop(fadeSeconds?: number): void
  setGain(gain: number): void
  /** Everything off, timers cancelled, in-flight loads abandoned. */
  dispose(): void
}

/**
 * Shuffle without replacement, refilling when the pool runs dry.
 *
 * `PlaylistController.cs:615-659`. Returns the chosen track and the pool that
 * remains; the caller keeps the pool. Pure, and `random` is injected so the
 * "every track before any repeat" property can actually be asserted rather
 * than believed.
 *
 * `remaining` empty with `loop` true refills from `tracks` FIRST and then
 * picks, which is 2016's order (`:658-659` runs before the next `:615`) and is
 * why a six-track playlist never plays five and stops.
 *
 * `avoid` is FF2's (DEV-423): a track that must not be the one chosen NOW —
 * the song already sounding, on GO. It is skipped rather than removed, so it
 * stays in the pool for a later pick, and it is ignored when it is the only
 * candidate left (a one-track soundtrack still plays). Absent, this is exactly
 * 2016's pick, which is what the auto-advance still uses.
 */
export const nextShuffled = <T>(
  tracks: readonly T[],
  remaining: readonly T[],
  random: () => number,
  loop = true,
  avoid: T | null = null,
): { readonly chosen: T | null; readonly remaining: readonly T[] } => {
  let pool = remaining
  if (pool.length === 0) {
    if (!loop || tracks.length === 0) return { chosen: null, remaining: [] }
    pool = tracks
  }
  // The positions in `pool` the pick may land on. Every one of them unless one
  // is the track to avoid and something else is left.
  const allowed: number[] = []
  for (let i = 0; i < pool.length; i++) if (pool[i] !== avoid) allowed.push(i)
  if (allowed.length === 0) for (let i = 0; i < pool.length; i++) allowed.push(i)
  const slot = Math.min(allowed.length - 1, Math.max(0, Math.floor(random() * allowed.length)))
  const index = allowed[slot] ?? 0
  const chosen = pool[index]
  if (chosen === undefined) return { chosen: null, remaining: [] }
  const rest = [...pool.slice(0, index), ...pool.slice(index + 1)]
  return { chosen, remaining: rest }
}

/**
 * The two gains of a crossfade at time `t`, on an **equal-power** curve.
 *
 * `outgoing = cos(x·π/2)`, `incoming = sin(x·π/2)`, `x = t / seconds` clamped
 * to [0, 1]. The identity `cos²+sin² = 1` is the whole point: two uncorrelated
 * signals sum in power, so a pair whose SQUARES sum to 1 holds the loudness
 * flat while a pair whose amplitudes sum to 1 — which is what 2016 did, and
 * what most people write first — drops 3.01 dB at the midpoint.
 *
 * Pure, and separate from anything that schedules it, so the geometry is
 * checkable in node against dB rather than against itself (DEV-027: say what a
 * number is the ratio OF — these are amplitudes, and their squares are powers).
 */
export const crossfadeGains = (
  t: number,
  seconds: number,
): { readonly outgoing: number; readonly incoming: number } => {
  // A zero-length crossfade is a cut: the incoming is already up.
  if (!(seconds > 0)) return { outgoing: 0, incoming: 1 }
  const x = t <= 0 ? 0 : t >= seconds ? 1 : t / seconds
  const angle = (x * Math.PI) / 2
  return { outgoing: Math.cos(angle), incoming: Math.sin(angle) }
}

/**
 * How finely the curve below is sampled. 128 points over a 1–2 s fade is a step
 * every 8–16 ms, well under the ~30 ms an ear resolves as a discrete change —
 * and `setValueCurveAtTime` interpolates between the points anyway, so this only
 * has to be fine enough that the linear interpolation of a cosine is not itself
 * a shape you can hear.
 */
export const EQUAL_POWER_CURVE_STEPS = 128

/**
 * The same curve sampled for `AudioParam.setValueCurveAtTime`.
 *
 * `steps` points INCLUSIVE of both ends, so `curve[0]` and `curve[steps-1]` are
 * exactly the endpoints and a fade really does start at silence and end at
 * unity rather than one sample short of either.
 */
export const equalPowerCurve = (
  direction: 'in' | 'out',
  steps = EQUAL_POWER_CURVE_STEPS,
): Float32Array => {
  const n = Math.max(2, Math.floor(steps))
  const curve = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const gains = crossfadeGains(i / (n - 1), 1)
    curve[i] = direction === 'in' ? gains.incoming : gains.outgoing
  }
  return curve
}

/**
 * How long a "cut" takes. Not a fade — a de-click.
 *
 * On GO, 2016 slams the playlist volume to zero (`Timer_Race.cs:76`) and only
 * then walks it back up over a second, so the song under the lift stops dead.
 * Stopping a buffer source at a non-zero sample is a step in the waveform, which
 * is a click; 10 ms of ramp removes it and is far too short to read as a fade.
 */
export const MUSIC_CUT_SECONDS = 0.01

/** Cancels a scheduled callback. */
type Cancel = () => void

/**
 * Deferred work, injectable.
 *
 * The auto-advance handoff has to happen `crossfadeSeconds` before a track
 * ends, which is a timer and nothing else. It is injected so a test can fire
 * the handoff on demand instead of waiting three minutes for it — the same
 * reason `random` is injected, and for the same value: the property being
 * asserted is *what happens at the handoff*, not *that `setTimeout` works*.
 */
export type MusicScheduler = (callback: () => void, seconds: number) => Cancel

const defaultScheduler: MusicScheduler = (callback, seconds) => {
  const id = setTimeout(callback, Math.max(0, seconds) * 1000)
  return () => clearTimeout(id)
}

export interface MusicPlaylistOptions {
  /**
   * Where the audio goes. Defaults to a backend that plays nothing, so a
   * playlist built with no arguments behaves exactly as the one that stood here
   * before playback existed.
   */
  readonly backend?: AudioBackend
  readonly random?: () => number
  /** Which MasterAudio singleton's crossfade applies. Default `'mission'` (2 s). */
  readonly bank?: MusicBank
  readonly scheduler?: MusicScheduler
  /** Where the warnings go. Injected so the failure path is assertable. */
  readonly warn?: (message: string) => void
}

/**
 * The playlist, and the thing that plays it.
 *
 * Holds 2016's shape — shuffle without replacement, auto-advance, loop, the
 * bank's crossfade, 0.75 master — and drives it through `AudioBackend`, so
 * `?audio=off` and a node test are the same code path and neither of them needs
 * an `AudioContext`. With no tracks installed every method is a no-op, which is
 * the state the game ships in today.
 */
export const createMusicPlaylist = (options: MusicPlaylistOptions = {}): MusicPlaylist => {
  const random = options.random ?? Math.random
  const backend = options.backend ?? null
  const bank = options.bank ?? DEFAULT_MUSIC_BANK
  const schedule = options.scheduler ?? defaultScheduler
  const warn = options.warn ?? ((message: string) => console.warn(message))
  const crossfadeSeconds = bankCrossfadeSeconds(bank)

  let tracks: readonly MusicTrack[] = []
  let remaining: readonly MusicTrack[] = []
  let playing: MusicTrack | null = null
  /**
   * The decoded length of the voice now sounding. Set from the BUFFER, never
   * from the track, so it is evidence that a decode happened rather than a
   * restatement of what was asked for. (DEV-247.)
   */
  let playingSeconds: number | null = null
  let gain = MASTER_MUSIC

  /** The voice that is up, or null while one is decoding or nothing is playing. */
  let voice: MusicVoice | null = null
  /** Cancels the pending auto-advance handoff. */
  let cancelHandoff: Cancel | null = null
  /**
   * Invalidates work that is already in flight.
   *
   * A `loadMusic` started for the lift can land AFTER GO has re-seeded the pool
   * and picked something else — a fetch takes as long as it takes, and GO is a
   * button press. Every async continuation checks the generation it was started
   * under, so a late arrival is dropped instead of starting a third song over
   * the top of the second. (Trap 19's shape at the module level: a value that
   * is a channel between two calls.)
   */
  let generation = 0
  /** Srcs already warned about, so a 404 is one line and not one line a minute. */
  const warned = new Set<string>()
  /** Consecutive failed loads. Bounded by the track count; reset on a success. */
  let failures = 0

  const clearHandoff = (): void => {
    cancelHandoff?.()
    cancelHandoff = null
  }

  /** `avoid`: a track this pick must not land on — GO's, DEV-423. */
  const advance = (avoid: MusicTrack | null = null): void => {
    const step = nextShuffled(tracks, remaining, random, true, avoid)
    remaining = step.remaining
    playing = step.chosen
  }

  /**
   * Bring the selected track up, fading in over `fadeInSeconds`.
   *
   * The outgoing voice is faded out **when the incoming buffer arrives**, not
   * when the handoff was scheduled. That is the difference between a crossfade
   * that is occasionally a little late and one that is occasionally a silent
   * hole: if the decode takes longer than expected the outgoing simply plays on
   * — past its own scheduled fade, under nothing — until there is something to
   * fade into. The only cost is a crossfade that runs past the outgoing track's
   * natural end, where the buffer stops on its own mid-fade and is inaudible by
   * then anyway.
   */
  const begin = (fadeInSeconds: number, cut: boolean): void => {
    const track = playing
    if (!track || !backend) return
    // ── No device yet is not a verdict on the track (DEV-247) ────────────
    //
    // `loadMusic` answers `null` for "there is no `AudioContext`" exactly as
    // it does for a 404, and the playlist used to spend the whole pool on
    // that one state and then announce that six good files are unplayable.
    // The state is temporary — the next gesture builds the device — so the
    // right move is to leave the pool alone and be asked again.
    //
    // `playing` goes back to null deliberately: `start('lift')` returns early
    // when something is already playing, and a track left standing here would
    // wedge the playlist shut for the rest of the session.
    if (!backend.hasOutput) {
      playing = null
      playingSeconds = null
      return
    }
    const mine = ++generation
    clearHandoff()

    if (cut && voice) {
      // GO. 2016 puts the playlist volume at zero on the same frame it restarts
      // (`Timer_Race.cs:76`), so the lift's song is gone before the new one
      // starts. Implemented on the outgoing VOICE rather than on the shared bus
      // because the two are audibly identical here — the restart stops the old
      // clip either way — and because the bus then keeps exactly one meaning,
      // which is the player's volume. One node, one meaning (`webaudio.ts`).
      voice.fadeOut(MUSIC_CUT_SECONDS)
      voice = null
      // Nothing is sounding now, so nothing has a decoded length: the next one
      // arrives with the next buffer. Left standing, the lift track's length
      // would answer for the GO track until it decoded — the one field that is
      // supposed to be evidence of a decode (DEV-247) vouching for a song that
      // has not been fetched yet. DEV-423's spec reads the gap through it.
      playingSeconds = null
    }

    void backend
      // ── `track.src` arrives ALREADY RESOLVED (DEV-247) ────────────────
      //
      // `asset-url.ts` says *"every asset load in the game goes through
      // here"* and music was the one that did not: a bare relative path
      // resolves against the DOCUMENT, which is right in dev by coincidence
      // (`VITE_ASSET_BASE_URL=/`, page at `/`) and wrong everywhere content
      // lives on its own origin. On the deployed site that is
      // `ff-10yr.pages.dev/assets/audio/music/*.opus`, which the Pages SPA
      // fallback answers `200 text/html` — so the shipped game fetched its
      // own index page six times and reported six unplayable files.
      //
      // The resolving is done by the caller, in `boot/app.ts`, and NOT here:
      // `assetUrl()` reads `import.meta.env`, and a build-tool global
      // anywhere under `src/audio/` would make this module unreachable from
      // any Playwright spec — which collects zero tests, silently, for the
      // whole suite. `tests/unit/e2e-import-graph.test.ts` refuses the edge
      // and caught this exact attempt. `tests/unit/soundtrack-assets.test.ts`
      // holds the wiring end up.
      .loadMusic(track.src)
      .then((buffer) => {
        if (generation !== mine) return
        if (!buffer) {
          onLoadFailed(track, fadeInSeconds)
          return
        }
        startVoice(buffer, fadeInSeconds, mine)
      })
      .catch((error: unknown) => {
        // The contract says `loadMusic` never rejects. This is here because
        // "never" is a claim about three implementations and one of them will
        // one day grow a fourth — and an unhandled rejection in the audio layer
        // would be a silent soundtrack plus a red console on a screen nobody is
        // looking at.
        if (generation !== mine) return
        warnOnce(track, `music: ${track.src} failed to load (${String(error)})`)
        onLoadFailed(track, fadeInSeconds)
      })
  }

  const startVoice = (buffer: MusicBuffer, fadeInSeconds: number, mine: number): void => {
    if (!backend) return
    failures = 0
    const outgoing = voice
    const next = backend.playMusic(buffer)
    playingSeconds = buffer.durationSeconds
    next.fadeIn(fadeInSeconds)
    // Equal in length to the incoming fade so the pair is a crossfade and not
    // two unrelated ramps. On a cut the outgoing is already gone.
    outgoing?.fadeOut(fadeInSeconds)
    voice = next

    next.onEnded(() => {
      if (generation !== mine) return
      // Only meaningful if the handoff never ran — a track shorter than the
      // crossfade, or a scheduler that was starved. Auto-advance is `isAutoAdvance:
      // 1` and the playlist loops, so reaching the end of a song is never the
      // end of the music.
      if (voice === next) {
        voice = null
        playingSeconds = null
        advanceAndPlay()
      }
    })

    // `PlaylistController.cs:390-391`: the handoff is `CrossFadeTime` before the
    // clip ends, which is what makes the fade an OVERLAP rather than a gap.
    const lead = Math.max(0, buffer.durationSeconds - crossfadeSeconds)
    cancelHandoff = schedule(() => {
      if (generation !== mine) return
      advanceAndPlay()
    }, lead)
  }

  const advanceAndPlay = (): void => {
    if (tracks.length === 0) return
    advance()
    begin(crossfadeSeconds, false)
  }

  const warnOnce = (track: MusicTrack, message: string): void => {
    if (warned.has(track.src)) return
    warned.add(track.src)
    warn(message)
  }

  /**
   * A track that will not load: warn once, then try the next one.
   *
   * Bounded by the track count so a playlist whose bucket prefix is wrong warns
   * six times and stops, rather than fetching in a loop for the rest of the
   * session. The counter resets on the first success, so one bad file among six
   * costs one warning and nothing else.
   */
  const onLoadFailed = (track: MusicTrack, fadeInSeconds: number): void => {
    warnOnce(track, `music: ${track.src} could not be played; skipping (${track.title}).`)
    failures += 1
    if (failures >= tracks.length) {
      warn(`music: no playable tracks (${tracks.length} tried). The game runs silent-of-music.`)
      playing = null
      playingSeconds = null
      failures = 0
      return
    }
    advance()
    begin(fadeInSeconds, false)
  }

  const stopMusic = (fadeSeconds: number): void => {
    generation += 1
    clearHandoff()
    voice?.fadeOut(fadeSeconds)
    voice = null
    playing = null
    playingSeconds = null
  }

  return {
    get tracks() {
      return tracks
    },
    get crossfadeSeconds() {
      return crossfadeSeconds
    },
    get playing() {
      return playing
    },
    get playingSeconds() {
      return playingSeconds
    },
    get gain() {
      return gain
    },
    setTracks(next) {
      stopMusic(MUSIC_CUT_SECONDS)
      tracks = next
      remaining = next
      warned.clear()
      failures = 0
    },
    start(cue) {
      if (tracks.length === 0) return
      if (cue === 'lift') {
        // Already playing, or already decoding. Asking a running bed to start
        // again is a no-op, not a second voice — `retrigger: 'ignore'`, and the
        // reason `index.ts` can route this cue off two different events.
        if (playing) return
        advance()
        // `fadeInFirstSong: 1` on the "Music" playlist
        // (`MasterAudio_hoverJet.prefab:4702`), which `PlaylistController.cs`
        // `:1120-1121` applies over `CrossFadeTime`. So the lift's track fades
        // up over the bank's 2 s rather than cutting in.
        begin(crossfadeSeconds, false)
        return
      }
      // `'go'` cuts the lift's song and brings a NEW one in over
      // `Timer_Race.cs:77`'s one second. 2016 re-seeded the pool here
      // (`RestartPlaylist`), which let GO pick the very song it had just cut;
      // FF2 carries the pool on and skips the one sounding. DEV-423.
      advance(playing)
      begin(MUSIC_GO_FADE_SECONDS, true)
    },
    next() {
      if (tracks.length === 0) return
      advanceAndPlay()
    },
    stop(fadeSeconds = crossfadeSeconds) {
      stopMusic(fadeSeconds)
    },
    setGain(next) {
      gain = next
      backend?.setMusicGain(next)
    },
    dispose() {
      stopMusic(0)
      tracks = []
      remaining = []
      warned.clear()
      failures = 0
    },
  }
}
