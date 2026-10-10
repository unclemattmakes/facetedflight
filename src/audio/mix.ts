// src/audio/mix.ts — the gain chain, and it is MEASURED, not invented.
//
// ── Why this file exists ──────────────────────────────────────────────────
//
// Every cue in `cues.ts` carries two numbers off the 2016 prefabs — the group's
// `groupMasterVolume` and the variation `AudioSource`'s `m_Volume` — and the
// only honest way to turn those into a WebAudio gain is the product MasterAudio
// itself computes. That product is one line of vendor source:
//
//   DarkTonic/MasterAudio/Scripts/Singleton/MasterAudio.cs:1718
//     var calcVolume = varVol * groupVolume * busVolume * Instance._masterAudioVolume;
//
// `varVol` is `info.OriginalVolume` (`:1701`), which is the authored clip
// volume; `groupVolume` is the group's `groupMasterVolume`; `busVolume` is
// `GetBusVolume` (`:3588`), which returns 1 unless `busIndex >=
// HardCodedBusOptions` — and **all 54 groups across both banks are
// `busIndex: 0`**, so no bus ever attenuates anything in this game. That leaves
// three factors, and `cueGain` is exactly those three.
//
// CLAUDE.md's DEV-027 rule applies to derived numbers too: say what a number is
// the product OF. It is the product of a clip volume, a group volume and the
// singleton's master — in that order, all dimensionless, all in [0, 1].
//
// ── What is deliberately absent ───────────────────────────────────────────
//
// **Ducking.** There is none to port. `musicDuckingSounds: []` in both banks,
// and `MasterAudio.cs:1786` returns on its first line unless the group is in
// `duckingBySoundType`, a dictionary built only from that empty list (`:711`).
// D13 listed "ducking config" as fidelity to preserve; it does not exist.
// See `docs/audio-event-map.md` §1.1.

/**
 * `MasterAudio_hoverJet.prefab:4730` `_masterAudioVolume`. Also the menu bank's
 * (`MasterAudio_ship.prefab:3319`) — both 0.75, so FF2 needs one number.
 */
export const MASTER_SFX = 0.75

/**
 * `MasterAudio_hoverJet.prefab:4754` `_masterPlaylistVolume`, and
 * `MasterAudio_ship.prefab:3343`. Both 0.75.
 */
export const MASTER_MUSIC = 0.75

/**
 * The MISSION bank's `crossFadeTime` (`MasterAudio_hoverJet.prefab:4753`).
 *
 * It comes from the singleton, not the playlists: both `musicPlaylists` entries
 * carry `crossfadeMode: 0` = `UseMasterSetting` (`MasterAudio.cs:440-443`), so
 * `PlaylistController.CrossFadeTime` (`:1615-1624`) returns the singleton's
 * value and each playlist's own `crossFadeTime: 1` is inert.
 *
 * The menu bank's singleton is 1 s (`MasterAudio_ship.prefab:3342`), and
 * `persistBetweenScenes` is 0 on both (`:4585` / `:3274`) so the menu value can
 * never leak into a mission and masquerade as this one.
 */
export const MUSIC_CROSSFADE_SECONDS = 2

/**
 * The MENU bank's `crossFadeTime` (`MasterAudio_ship.prefab:3342`).
 *
 * Half the mission bank's, and it is a different singleton rather than a
 * different playlist: `persistBetweenScenes` is 0 on both (`:4585` / `:3274`),
 * so neither value can leak into the other's scene and masquerade as it.
 *
 * FF2 runs one process rather than two scenes, so the bank is chosen per
 * playlist instead of per scene — `createMusicPlaylist({ bank })`. The number
 * is here because it came off a prefab with a line, which is the property this
 * file exists to keep.
 */
export const MENU_MUSIC_CROSSFADE_SECONDS = 1

/**
 * The GO fade-in, in seconds. `E3/Scripts/Timer_Race.cs:75-77`:
 *
 * ```csharp
 * MasterAudio.StartPlaylist("Music");
 * MasterAudio.FadePlaylistToVolume(0, 0);
 * MasterAudio.FadePlaylistToVolume(userMusicMaxVolume, 1f);
 * ```
 *
 * Not a crossfade and not the bank's 2 s: the playlist VOLUME is slammed to
 * zero and walked back up over one second, which is why the song that starts
 * the race arrives out of silence rather than over the one under the lift.
 * `music.ts` implements it on the incoming voice rather than on the bus — see
 * the note there, and why the two are audibly the same thing.
 */
export const MUSIC_GO_FADE_SECONDS = 1

/**
 * `GetBusVolume` returns 1 for every group in this game.
 *
 * Kept as a named constant rather than dropped from the product so that the
 * arithmetic below is the vendor line and not a simplification of it — if a
 * later bank ever uses a bus, this is where it goes.
 */
export const BUS_VOLUME = 1

/**
 * The 2016 gain for one cue: clip volume x group volume x bus x master.
 *
 * `MasterAudio.cs:1718`. Both inputs come straight off the prefab and are
 * recorded on the `CueSpec` beside their line numbers.
 */
export const cueGain = (groupVolume: number, clipVolume: number, master = MASTER_SFX): number =>
  clipVolume * groupVolume * BUS_VOLUME * master

/**
 * Decibels to a linear gain multiplier.
 *
 * Present for the `NPC Ship.mixer` ramp, which is the only dB quantity in the
 * 2016 audio data: `Audio/Mixer/NPC Ship.mixer` holds its Master at **-30.9 dB**
 * in the `Pre-Launch` snapshot and transitions to **+0.1355 dB** over 2 s when
 * `Timer_Race.cs:70` calls `AudioDelayHack.TransitionToGameplay()` on GO. FF2's
 * opposition is DEV-026's own racers rather than the 2016 ghost recordings, so
 * nothing uses this yet — see `docs/audio-event-map.md` §6, AUD-5.
 */
export const dbToGain = (db: number): number => 10 ** (db / 20)

/**
 * The inverse. A linear gain, in decibels; 0 is `-Infinity`.
 *
 * Here rather than in `volume.ts` because it is the other half of one
 * conversion and a pair that can drift is a pair that will. Its caller is the
 * test that checks the player's volume ladder really is 6 dB a step: a ladder
 * written as amplitudes needs something that speaks dB to be checked against,
 * or the claim in its header is just a comment.
 */
export const gainToDb = (gain: number): number => (gain <= 0 ? -Infinity : 20 * Math.log10(gain))

/** `NPC Ship.mixer` `Pre-Launch` snapshot, Master volume parameter. */
export const NPC_MIXER_PRELAUNCH_DB = -30.9

/** `NPC Ship.mixer` `Gameplay` snapshot. The ramp is 2 s (`AudioDelayHack.cs:12`). */
export const NPC_MIXER_GAMEPLAY_DB = 0.13552584

/** Clamp to the range a WebAudio `GainNode` is meant to see. */
export const clampGain = (gain: number): number => (gain < 0 ? 0 : gain > 1 ? 1 : gain)
