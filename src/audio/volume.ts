// src/audio/volume.ts — the PLAYER's volume, which is the one number in this
// folder that 2016 did not give us.
//
// ── Why it is not in `mix.ts` ─────────────────────────────────────────────
//
// `mix.ts` has a property worth keeping: every number in it came off a 2016
// prefab and carries the line it came from. This ladder came off nobody's
// prefab — the shipped game has no in-game volume control at all, because in
// 2016 the volume control was the Rift's own and the machine's. FF2 needs one
// (the game is played in a headset, at night, by one person with the audio
// strapped to their head), so the numbers below are OURS and they are kept
// where that is obvious.
//
// ── One master factor, not two. This was a real bug ───────────────────────
//
// `cueGain` already multiplies `MASTER_SFX` (0.75, `_masterAudioVolume` off
// both banks) into every `CueSpec.gain` — `cues.ts`'s `spec()` calls it with
// the default — and `webaudio.ts` ALSO started its master node at
// `MASTER_SFX`. So the product reaching the destination was
// `clip x group x 0.75 x 0.75`, and the whole game has been playing **2.5 dB
// below its own authored level** since the audio port landed. Nothing caught
// it because nothing ever called `setMasterGain`: with one caller the two
// halves of the chain never had to agree about what the master node means.
//
// It means the PLAYER's volume now, `full` is 1.0, and the 2016 master lives
// in exactly one place (inside `cueGain`). The port therefore got 2.5 dB
// louder the day this landed — which is a fidelity fix and is also the kind of
// change only a person in a headset can sign off, so it is left to a worn
// pass rather than asserted to be an improvement.
//
// ── Four steps and a mute, not a slider ───────────────────────────────────
//
// The pause plate has exactly one verb — look at a row, press A (`pause.ts`,
// 2016's `Input_Look.cs:163`). A slider needs a second one: a held axis, a
// drag, a grab. Adding it would mean the plate's hit test, its paint and its
// input all grow a mode for one row, on the surface where "what you look at and
// what you hit must not drift apart" is already the standing bug. And the
// instrument is bad even if it were free: a row on this panel subtends about
// 4 degrees, so an analogue drag along it is a 4-degree-tall target held by a
// neck, in the dark, while feeling ill.
//
// Discrete also makes the mapping ASSERTABLE. "The slider sounded about right"
// is not a test; "step down is −6.02 dB" is one, and it is in
// `tests/unit/comfort-audio.test.ts`.
//
// ── The ladder, in dB, because loudness is logarithmic ────────────────────
//
// A linear fraction on a `GainNode` is an amplitude, not a loudness: 0.5 is
// **−6 dB**, which reads as roughly two-thirds as loud rather than half. So the
// steps are equal in dB and not in amplitude, and each one is exactly half the
// amplitude of the one above — one bit, exact in binary floating point, and the
// step every mixing desk has had since desks had numbers on them.
//
//   full   1.0      0 dB        the 2016 authored product, unattenuated
//   high   0.5     −6.02 dB     about 0.66 as loud
//   mid    0.25   −12.04 dB     about 0.44 as loud
//   low    0.125  −18.06 dB     about 0.29 as loud
//   muted  0      −inf          `muted`, which is a separate field
//
// (The "as loud" column is Stevens' 10 dB ≈ half-loudness rule, `2 ** (dB/10)`.
// It is here to say what the steps BUY, and nothing reads it.)
//
// **The value column shows the word, never a percentage.** "50 %" is the
// amplitude and is a lie about the loudness, and it is the exact lie this file
// exists to avoid; a player who reads "50 %" and hears two-thirds concludes the
// control is broken.
//
// ── Mute is a separate field, and it wins ─────────────────────────────────
//
// Because the alternative is an `off` at the bottom of the ladder, which is
// four presses away from `full` at the moment somebody most needs it to be one.
// So `muted` is its own boolean on its own row, one level UP — on the pause
// plate itself, beside Resume and Exit, where it costs one press and no page.
// It is independent of the level, exactly like every mute button on every
// remote control: mute, then change the volume, and the sound comes back at the
// new level. `comfort-menu.ts` holds that rule; this file just multiplies.

import { MASTER_MUSIC } from './mix'

/**
 * How loud, when not muted. Four steps, 6 dB apart. See the header for why it
 * is not a slider and why the steps are dB-even rather than linear.
 */
export type VolumeSetting = 'low' | 'mid' | 'high' | 'full'

/**
 * The cycle order, and it goes DOWN.
 *
 * The same argument `settings.ts` makes for the vignette going `off -> light ->
 * strong`: the press should move in the direction the player is reaching. A
 * player who opens a menu to look for the volume is nearly always reaching for
 * QUIETER — it is late, or the run is loud, or somebody else is asleep — so one
 * press from `full` has to be quieter and not louder. Getting back up is three
 * more presses, in a menu that is not being used in a hurry.
 */
export const VOLUME_STEPS: readonly VolumeSetting[] = ['full', 'high', 'mid', 'low']

/**
 * Linear gain per step: each one is exactly half the amplitude above it.
 *
 * Written as the amplitudes rather than derived from `dbToGain(-6)` on purpose.
 * Powers of two are exact in float, and −6 dB is 0.50118... — so deriving would
 * give a ladder that is *nearly* halving, and "nearly" is how a number stops
 * being checkable against anything. The dB figures in the header are the
 * derived quantity, and the test derives them with `gainToDb` rather than
 * restating them.
 */
export const VOLUME_GAIN: Readonly<Record<VolumeSetting, number>> = {
  full: 1,
  high: 0.5,
  mid: 0.25,
  low: 0.125,
}

/**
 * The nominal step, in dB. `20 * log10(0.5)`.
 *
 * Stated rather than computed so a test has something to check the ladder
 * AGAINST — a constant derived from the same array it is verifying would agree
 * with itself whatever the array said.
 */
export const VOLUME_STEP_DB = -6.02

/**
 * Everything the mix needs to know about what the player chose.
 *
 * Structural rather than `ComfortSettings` so that `boot/settings.ts` can
 * import the ladder from here without this file importing the settings back —
 * `VOLUME_STEPS` is a value, so that pair would be a real module cycle and not
 * just an ugly diagram.
 */
export interface VolumeState {
  readonly volume: VolumeSetting
  readonly muted: boolean
}

/**
 * The SFX output gain for a given setting. Mute wins.
 *
 * This is the whole composition rule in one line, and it is deliberately the
 * only place it exists: `app.ts` asks this question at boot and on every
 * change, and never does the arithmetic itself.
 *
 * **`?audio=off` is not in here, and that is the point.** That switch swaps the
 * BACKEND for `createSilentBackend()`, which has no `AudioContext` to gain-stage
 * at all — so it wins over anything this returns, it cannot be un-done from the
 * menu, and the stored setting is neither read nor written by it. A page loaded
 * with `?audio=off` is silent; the volume the player chose is still there,
 * untouched, on the next load without it.
 */
export const masterGainFor = (s: VolumeState): number => (s.muted ? 0 : VOLUME_GAIN[s.volume])

/**
 * The MUSIC output gain for the same setting.
 *
 * There are no tracks yet (D31), and that is exactly why this exists now: the
 * day one arrives, "mute did not mute the music" is a bug nobody would think to
 * look for, in the one part of the mix that plays continuously. 2016's own
 * playlist master (`_masterPlaylistVolume`, 0.75) stays in the product, so the
 * music/SFX balance is 2016's and the player's ladder scales both together.
 */
export const musicGainFor = (s: VolumeState): number => masterGainFor(s) * MASTER_MUSIC
