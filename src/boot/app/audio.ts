// src/boot/app/audio.ts: the game's sound, constructed, out of `bootApp`.
// APP-SPLIT phase 4 (`docs/plan/APP-SPLIT.md` §1b, "Audio": the construction).
//
// The audio system (D13), the soundtrack's tracks (D31, DEV-247), the player's
// volume (one place, at boot and on change) and S4's speed curves (DEV-084,
// DEV-137, DEV-424). The `audio*` edge latches stay in the closure: the frame
// owns them. Every line below was moved verbatim from the closure; the
// plumbing is `ctx.x` where the code reads a binding the closure still owns,
// and the returned object, which hands the closure what it still calls.

import { createAudioSystem, createSilentBackend, masterGainFor, musicGainFor } from '@/audio'
import type { ComfortSettings } from '@/boot/settings'
import { assetUrl } from '@/content/asset-url'
import type { Edition } from '@/content/edition-schema'
import { SOUNDTRACK } from '@/content/soundtrack'
import type { EditionState } from '@/game/edition'
import { AUDIO_OFF } from './pins'

/** What `createAppAudio` reads from the closure: getters, each read live (APP-SPLIT §3's `ctx`). */
export interface AppAudioCtx {
  readonly comfort: ComfortSettings
  readonly editionState: EditionState
}

export const createAppAudio = (ctx: AppAudioCtx) => {
  /**
   * Sound. D13, and `docs/audio-event-map.md` is the port.
   *
   * Constructed here rather than lazily because `createAudioSystem` makes no
   * `AudioContext` and touches no DOM — it is data and a state machine until
   * the first `resume()`, which needs a user gesture behind it. Every `play`
   * before that is a silent no-op, deliberately: the game must not care whether
   * it has sound, and must certainly not throw because it scored a gate 40 ms
   * before the player touched the pad.
   *
   * `?audio=off` gives the silent backend, for a screenshot spec that should
   * not start an audio device and for anyone debugging in a quiet room.
   *
   * **`?audio=off` beats the volume setting, and cannot be beaten by it.** It
   * replaces the BACKEND, so there is no `AudioContext` for a gain to be staged
   * on and no menu press can bring one back — which is what makes it usable as
   * a guarantee by a spec that must not start an audio device. It does not read
   * the stored volume and never writes it: a page loaded with `?audio=off` is
   * silent, and the level the player chose is still there, untouched, on the
   * next load without it.
   */
  const audio = createAudioSystem(AUDIO_OFF ? { backend: createSilentBackend() } : {})
  /**
   * The soundtrack — D31, Matt 2026-09-13, six HoliznaCC0 tracks under CC0 1.0.
   *
   * Installed here rather than inside `createAudioSystem` because the tracks are CONTENT and the
   * audio system is engine: `src/content/soundtrack.ts` says which six and why, and swapping the
   * set is a one-file change that touches no code (hard rule 6). The playlist itself needs no
   * further wiring — `audio.event()` already fires `'lift'` on `mission.begin`/`launch.start` and
   * `'go'` on `countdown.go` (DEV-066).
   *
   * With `?audio=off` this reaches the silent backend, which does not fetch: the switch costs
   * nothing rather than costing six downloads it then discards.
   */
  //
  // ── Resolved HERE, through `assetUrl` (DEV-247) ─────────────────────────
  //
  // Every other loader in the game resolves its content path at the point of
  // use (`game/flight.ts`, `game/ghosts.ts`, the mesh loads below) and music
  // was the one that never did — it handed `music.ts` a bare relative path,
  // which the browser then resolved against the DOCUMENT. That is the same
  // URL in dev and a different one on the deployed site, where content lives
  // on its own origin: `ff-10yr.pages.dev/assets/audio/music/drama.opus`
  // answers `200 text/html` from the Pages SPA fallback, so the game decoded
  // its own index page, six times, and said "no playable tracks".
  //
  // It resolves at this wiring point rather than inside `music.ts` because
  // `assetUrl()` reads `import.meta.env`, and nothing under `src/audio/` may
  // touch a build-tool global without making itself unreachable from every
  // Playwright spec at once (`tests/unit/e2e-import-graph.test.ts`). `app.ts`
  // is already on that side of the line.
  audio.music.setTracks(SOUNDTRACK.map((track) => ({ ...track, src: assetUrl(track.src) })))
  /**
   * The player's volume onto the mix. ONE place, called at boot and on change.
   *
   * Called here, immediately, and NOT after the first `resume()`: the system
   * makes no `AudioContext` until a gesture, `setMasterGain` is safe with none,
   * and the backend carries the value onto the master node the moment one
   * exists. A volume applied after the first cue is a volume the player hears
   * the game ignore — and the first cue is the lift, which is the loudest
   * fifteen seconds in the game since DEV-063 gave the shaft its eight whooshes.
   */
  const applyVolume = (s: ComfortSettings): void => {
    audio.setMasterGain(masterGainFor(s))
    audio.setMusicGain(musicGainFor(s))
  }
  applyVolume(ctx.comfort)
  /**
   * ── Anniversary systems: S4, sound that moves with airspeed ────────────
   *
   * The other half of the block of the same name above; it lives HERE and not
   * there only because it needs the `audio` system, which is constructed a few
   * lines up. ANNIVERSARY.md §2.5 S4, DEV-084.
   *
   * Wind gain and low-pass against airspeed, engine rate against throttle, a
   * whoosh on every ring. All of it is inside `src/audio/`: the per-frame inputs
   * the curves need are the ones `stepFlight` is already given, so there is no
   * new call in the game loop and no second place holding the ship's speed. The
   * preset holds every number (`content/editions/*.json`, `audio.speedCurves`);
   * null puts the mix back to Classic on the next tick.
   *
   * `subscribe` rather than a read in `onSettings`, so that a flip from anywhere
   * — the menu, `?edition=`, a future dev handle — reaches the mixer.
   *
   * **It does NOT scale by `editionState.speedFx`, and that is a decision.**
   * The slider exists to limit VECTION (§2.6, `game/edition.ts`) — visually
   * induced self-motion — and it scales the near-field air, the streak width,
   * the cockpit shake and the gate pulse, all of which are optic flow. Sound is
   * not optic flow. Turning the wind down for somebody who gets motion sick
   * gives them a quieter game rather than a more comfortable one, and it would
   * make `speedFx` mean two different things while `volume.ts` already owns the
   * one it would be duplicating. So the preset decides whether the curves run
   * and the volume ladder decides how loud they are. DEV-084's row carries the
   * counter-argument and what would change our mind.
   */
  const applySpeedCurves = (e: Edition): void => {
    audio.setSpeedCurves(e.audio.speedCurves.enabled ? e.audio.speedCurves : null)
    // DEV-137: the rumble under the loops and the pitch that tracks forward
    // speed. The same preset, the same subscription, and the same argument
    // about the `speedFx` slider: sound is not optic flow. `setEngineSound`
    // reads the two flags itself and reaches the racers' engines as well.
    audio.setEngineSound(e.audio.engine)
    // DEV-424: the lift ride's motor and its arrival. Off on Classic.
    audio.setLiftSound(e.audio.lift.enabled ? e.audio.lift : null)
  }
  applySpeedCurves(ctx.editionState.current)
  ctx.editionState.subscribe(applySpeedCurves)
  return {
    audio,
    applyVolume,
  }
}
