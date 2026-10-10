// src/audio/cues.ts — the cue catalogue. PLAIN DATA, no Web Audio object.
//
// ── What this is a port OF ────────────────────────────────────────────────
//
// D13, resolved by Matt on 2026-09-11: **the ~12 SFX are SYNTHESIZED IN-ENGINE
// with WebAudio**, not sampled. A cue built from oscillators and noise is
// first-party by construction, no receipt, no `THIRD-PARTY-NOTICES.md` line, no R2 bytes,
// no licence review, and none of the apparatus D26 exists to run. No 2016 audio
// file ships in any form, and none was opened as data to write this file.
//
// So the samples are new BY DEFINITION and the only fidelity available is the
// **event map, the gain chain and the timing**. Everything in this file that is
// a number off the 2016 prefabs carries its `file:line`; everything that is a
// synthesis choice is ours and is marked as such.
//
// Paths below are relative to `Assets/` under the read-only 2016 project:
//   $FF2_LEGACY/   (see CLAUDE.md hard rule 1, and tools/legacy-root.mjs)
//
// The full derivation, verdict by verdict, is `docs/audio-event-map.md`.
//
// ── Why the recipes are data and not code ─────────────────────────────────
//
// Because the unit tests run in node with **no `AudioContext`**. A recipe that
// is a list of layers with numbers on it can be asserted against — gains in
// range, every cue resolvable, every loop stoppable — where a recipe that is a
// sequence of `ctx.createOscillator()` calls can only be run in a browser. The
// thin layer that turns these into nodes is `webaudio.ts`, and it is the only
// file here that is untested on purpose.
//
// ── Two conventions worth knowing before you read a spec ──────────────────
//
// 1. **`pitch` is a RATIO, not a frequency.** In 2016 a group's `m_Pitch` is a
//    sample playback rate: `Thrusters` at 0.94 means "play `Jet5Engine` 6 %
//    slow". There is no clip here, so the same number becomes a multiplier on
//    every layer's authored frequency. That is the only sane mapping, and it
//    preserves the one thing the number actually encodes — the relative pitch
//    of the three engine loops to each other (0.94 / 0.88 / 0.55).
// 2. **`gain` is the 2016 product**, `cueGain(groupVolume, clipVolume)`, and
//    both factors are recorded so the arithmetic can be re-derived from the
//    prefab without reading this file's conclusion. See `mix.ts`.

import { cueGain, dbToGain, NPC_MIXER_GAMEPLAY_DB } from './mix'
import type { SpatialSpec } from './spatial'

// ── The synthesis vocabulary ──────────────────────────────────────────────

export type Waveform = 'sine' | 'square' | 'sawtooth' | 'triangle'
export type FilterKind = 'lowpass' | 'bandpass' | 'highpass'

/**
 * ADSR, in seconds, except `sustain` which is a fraction of the layer's peak.
 *
 * A one-shot runs attack, decay to `sustain`, holds until
 * `durationSeconds - release`, then releases. A loop runs attack, holds at
 * `sustain` forever, and releases when the cue is stopped.
 */
export interface Envelope {
  readonly attack: number
  readonly decay: number
  readonly sustain: number
  readonly release: number
}

interface LayerCommon {
  /**
   * Seconds after the cue starts before this layer begins.
   *
   * Earns its place on one cue and pays for itself on three: `elevator_startup`
   * is literally "ROBOTIC Servo Medium **One Long Two Short** (mono)", and a
   * long body with two late blips is three layers at three delays.
   */
  readonly delaySeconds: number
  /** Peak linear gain of this layer, before the cue's own gain. */
  readonly gain: number
  readonly env: Envelope
}

/** An oscillator with an optional frequency sweep. */
export interface ToneLayer extends LayerCommon {
  readonly kind: 'tone'
  readonly wave: Waveform
  readonly startHz: number
  /** Sweep target. Equal to `startHz` for a steady tone. */
  readonly endHz: number
  /** Seconds over which `startHz` reaches `endHz`. Zero for a steady tone. */
  readonly sweepSeconds: number
  readonly detuneCents: number
}

/** White noise through one biquad, with an optional filter sweep. */
export interface NoiseLayer extends LayerCommon {
  readonly kind: 'noise'
  readonly filter: FilterKind
  readonly startHz: number
  readonly endHz: number
  readonly sweepSeconds: number
  readonly q: number
}

export type CueLayer = ToneLayer | NoiseLayer

/**
 * One alternative rendering of a cue.
 *
 * 2016's `CollectRing` is six clips with `curVariationSequence: 0`
 * (`Randomized` — `MasterAudioGroup.cs:85-88`) and that variation count IS the
 * feature: it is what stops the most-heard cue in the game going stale over
 * twenty-one gates. A synthesized cue gets the same treatment from a table of
 * ratios rather than six hand-written recipes, which keeps it data.
 */
export interface CueVariation {
  readonly pitch: number
  readonly detuneCents: number
}

/** How a cue behaves when it is asked to play while it is already playing. */
export type Retrigger =
  /** Start another voice. 2016's `retriggerPercentage: 50` on a pooled group. */
  | 'restart'
  /** Refuse. 2016's `retriggerPercentage: 100` — the cue cannot interrupt itself. */
  | 'ignore'

export interface CueSpec {
  readonly id: CueId
  /** The 2016 MasterAudio group this is a port of, or null for an FF2 cue. */
  readonly group: string | null
  /** Which bank the group lives in. */
  readonly bank: 'hoverJet' | 'ship' | null
  /** `groupMasterVolume` off the prefab. 1 when there is no 2016 group. */
  readonly groupVolume: number
  /** The variation `AudioSource`'s authored `m_Volume`. */
  readonly clipVolume: number
  /** `groupVolume x clipVolume x 0.75` — `MasterAudio.cs:1718`. */
  readonly gain: number
  /** 2016's `m_Pitch`, as a frequency multiplier. See the header. */
  readonly pitch: number
  /** A sustained voice that runs until stopped. */
  readonly loop: boolean
  /** One-shot total length, seconds. Meaningless for a loop. */
  readonly durationSeconds: number
  readonly retrigger: Retrigger
  /** Always at least one entry; more than one means "pick at random". */
  readonly variations: readonly CueVariation[]
  /**
   * Per-play pitch jitter, as a multiplicative `[min, max]`.
   *
   * `[1, 1]` where 2016 has `useRandomPitch: 0`. Where it has `1`, the mode
   * matters: `randomPitchMode: 0` is `AddToClipPitch` and `1` is
   * `IgnoreClipPitch` (`SoundGroupVariation.cs:124`), and both have been folded
   * into an absolute multiplier here so there is one rule at play time.
   */
  readonly pitchJitter: readonly [number, number]
  /** Seconds to fade in on play. 2016's `fadeInTime` where `useFades: 1`. */
  readonly fadeInSeconds: number
  readonly layers: readonly CueLayer[]
  /**
   * Distance model, or null for a cue that plays AT the listener.
   *
   * Null for all but two, and that is measured fidelity rather than a
   * shortcut — `spatial.ts`'s header has the whole derivation. The two that
   * carry one are the cues 2016 itself emitted from a point in the world:
   * `shaft.whoosh` (`PlaySound3DAtVector3`) and `racer.engine` (a raw
   * `AudioSource` on the opposition). AUD-5.
   */
  readonly spatial: SpatialSpec | null
  /** Where in the 2016 project every number above came from. */
  readonly provenance: string
}

export type CueId =
  | 'ui.hover'
  | 'ui.confirm'
  | 'ui.back'
  | 'elevator.start'
  | 'elevator.loop'
  | 'elevator.motor'
  | 'elevator.arrive'
  | 'shaft.whoosh'
  | 'racer.engine'
  | 'countdown.beat'
  | 'countdown.go'
  | 'ring.pass'
  | 'ring.boost'
  | 'gate.whoosh'
  | 'engine.idle'
  | 'engine.thrust'
  | 'engine.afterburner'
  | 'engine.rumble'
  | 'engine.growl'
  | 'wind.aircraft'
  | 'wind.flight'
  | 'ship.crash'
  | 'ship.crash.sub'
  | 'terrain.whoosh'
  | 'ship.hit'
  | 'ship.reboot'
  | 'boundary.warn'
  | 'run.finish'
  | 'run.medal'
  | 'ambient.water'
  | 'ambient.island'
  | 'lesson.prompt'
  | 'lesson.done'
  | 'jump.charge'
  | 'tv.ident'
  | 'gate.dud'
  | 'tank.fill'
  | 'tank.sputter'
  | 'tank.dry'
  | 'race.gain'
  | 'race.loss'
  | 'flyby.whoosh'
  | 'medal.bronze'
  | 'medal.silver'
  | 'medal.gold'
  | 'medal.platinum'

// ── Small builders, so a spec reads as its numbers ────────────────────────

const env = (attack: number, decay: number, sustain: number, release: number): Envelope => ({
  attack,
  decay,
  sustain,
  release,
})

const tone = (
  wave: Waveform,
  startHz: number,
  gain: number,
  e: Envelope,
  extra: Partial<Pick<ToneLayer, 'endHz' | 'sweepSeconds' | 'detuneCents' | 'delaySeconds'>> = {},
): ToneLayer => ({
  kind: 'tone',
  wave,
  startHz,
  endHz: extra.endHz ?? startHz,
  sweepSeconds: extra.sweepSeconds ?? 0,
  detuneCents: extra.detuneCents ?? 0,
  delaySeconds: extra.delaySeconds ?? 0,
  gain,
  env: e,
})

const noise = (
  filter: FilterKind,
  startHz: number,
  q: number,
  gain: number,
  e: Envelope,
  extra: Partial<Pick<NoiseLayer, 'endHz' | 'sweepSeconds' | 'delaySeconds'>> = {},
): NoiseLayer => ({
  kind: 'noise',
  filter,
  startHz,
  endHz: extra.endHz ?? startHz,
  sweepSeconds: extra.sweepSeconds ?? 0,
  delaySeconds: extra.delaySeconds ?? 0,
  q,
  gain,
  env: e,
})

/** The single variation every cue has unless 2016 gave it more. */
const ONE: readonly CueVariation[] = [{ pitch: 1, detuneCents: 0 }]
const NO_JITTER: readonly [number, number] = [1, 1]

// ── The two engine recipes the rumble is built FROM ──────────────────────
//
// Hoisted out of their specs so that DEV-137's `engine.rumble` and
// `engine.growl` can be DERIVED from them rather than typed beside them: the
// rumble is the Thrusters loop's own tonal layers at half the cue pitch, so its
// fundamental is an octave under the thruster's by construction and its
// harmonics land on the thruster's partials. `tests/unit/audio-engine-sound.test.ts`
// asserts that as a relationship between the two specs, not as a number.

/** `Thrusters` variation "Jet5Engine" `m_Pitch` — MasterAudio_hoverJet.prefab:8520. */
const THRUST_PITCH = 0.94
/** `AfterBurner` variation `m_Pitch` — MasterAudio_hoverJet.prefab:8279. */
const AFTERBURNER_PITCH = 0.88

/** The thruster: two sawtooths a fifth apart, a bright band of noise, a low one. */
const THRUST_LAYERS: readonly CueLayer[] = [
  tone('sawtooth', 100, 0.3, env(0.08, 0.3, 0.85, 0.12), { detuneCents: -6 }),
  tone('sawtooth', 150, 0.14, env(0.1, 0.3, 0.7, 0.12), { detuneCents: 8 }),
  noise('bandpass', 900, 1.1, 0.34, env(0.06, 0.3, 0.9, 0.14)),
  noise('lowpass', 220, 0.8, 0.2, env(0.12, 0.3, 0.85, 0.2)),
]

/** The afterburner's two tones: a square on the fundamental, a sawtooth an octave up. */
const AFTERBURNER_TONES: readonly ToneLayer[] = [
  tone('square', 66, 0.24, env(0.04, 0.25, 0.8, 0.14)),
  tone('sawtooth', 132, 0.2, env(0.05, 0.25, 0.75, 0.14), { detuneCents: -11 }),
]

/**
 * DEV-137's rumble: a sub sine on the thruster's fundamental, then the
 * thruster's own tonal layers and its LOW noise — not the bright 900 Hz band,
 * which has nothing to say an octave down and would only be filtered out
 * again. At the cue's half pitch the sine and the first sawtooth sit at
 * 47 Hz, the second sawtooth at 70.5, the noise's corner at 103.
 *
 * The sine's envelope is slow on purpose: a sub that arrives in 60 ms is a
 * thump on every throttle press, and the thruster above it already makes the
 * edge audible.
 */
const RUMBLE_LAYERS: readonly CueLayer[] = [
  tone('sine', 100, 0.5, env(0.4, 0.5, 0.9, 0.6)),
  ...THRUST_LAYERS.filter((l) => l.kind === 'tone' || l.filter === 'lowpass'),
]

/**
 * DEV-137's growl, under the burner only: the afterburner's two tones an octave
 * down, a THIRD tone a fifth above the sawtooth, and a narrow band of noise.
 *
 * The third tone is the growl. Two partials 29 Hz apart (58 and 87 at the cue's
 * half pitch) beat at 29 Hz, which is inside the band the ear reads as
 * ROUGHNESS rather than as either a pitch or a tremolo — the same mechanism as
 * a saturated bass note, without a wave-shaper the backend does not have.
 */
const GROWL_LAYERS: readonly CueLayer[] = [
  ...AFTERBURNER_TONES,
  tone('sawtooth', 198, 0.16, env(0.05, 0.25, 0.75, 0.14)),
  noise('bandpass', 520, 2, 0.3, env(0.04, 0.3, 0.95, 0.18)),
]

interface CueDraft extends Omit<CueSpec, 'gain' | 'id' | 'spatial'> {
  readonly gain?: never
  /**
   * Omitted means 2D, which is what 2016 does for 31 of its 33 mission groups.
   *
   * Optional rather than spelled out on every entry precisely because 2D is the
   * RULE here: twenty-one `spatial: null` lines would bury the two cues that
   * are the exception, and the exception is the whole of AUD-5.
   */
  readonly spatial?: SpatialSpec | null
}

const spec = (id: CueId, draft: CueDraft): CueSpec => ({
  ...draft,
  id,
  spatial: draft.spatial ?? null,
  gain: cueGain(draft.groupVolume, draft.clipVolume),
})

// ── The catalogue ─────────────────────────────────────────────────────────

/**
 * Every cue FF2 can play, keyed by id.
 *
 * The 2016 groups that are configured but have **no live caller in
 * `int_01_hoverJet`** are deliberately absent: `hit` (see `ship.hit`),
 * `CockpitAlarm2` (see `boundary.warn`), `HUD_Recharge_Frequency_14`, `Jet2EngineInt`, `whoosh_2`,
 * `Xylo_13`, `CHARGE Servo 24 Semi Up 2000ms`, `Finish` (JumpSeat),
 * `CollectOrb` (CanyonRunner), `Ambient_Desert` / `Ambient_Mountains` (other
 * environments), `Ambient` (muted, GearVR third-person only). Adding a cue 2016
 * never played is a deviation and wants a row, not a commit.
 *
 * Five entries here are exactly that and each carries its row: `boundary.warn`
 * (AUD-4 — a group 2016 configured and never called), `ship.hit` (the DEV-364
 * follow-up — the same, for a racer striking the player, Anniversary only
 * because only there can one), `gate.whoosh` (DEV-084 — a sound 2016 does
 * not have at all, reachable only on the Anniversary preset), and the lift's
 * `elevator.motor` and `elevator.arrive` (DEV-424 — the same standing, off the
 * preset's `audio.lift`).
 */
export const CUES: Readonly<Record<CueId, CueSpec>> = {
  // ── UI ──────────────────────────────────────────────────────────────────
  //
  // 2016's menu language, from the MENU bank, because that is where the game
  // put it: `FF_GearVR/Scripts/Input_Look.cs:149` plays `button_hover` when the
  // gaze crosses a button and `:168` plays `button_click` when it is taken.
  // FF2's holotable is that mechanism with a nose pointer, so these are a port
  // and not an invention. The HoverJet's own `Input_Ship.Pause()`/`Unpause()`
  // play nothing at all, so the pause PANEL is silent except for its rows —
  // `docs/audio-event-map.md` §6, AUD-6.
  'ui.hover': spec('ui.hover', {
    group: 'button_hover',
    bank: 'ship',
    // MasterAudio_ship.prefab:6301 groupMasterVolume 0.8; four variations
    // ("UI SCI-FI Tone Bright Wet 12..15"), clip volume 1, pitch 1.
    groupVolume: 0.8,
    clipVolume: 1,
    pitch: 1,
    loop: false,
    durationSeconds: 0.1,
    retrigger: 'restart',
    // Four in 2016, four here — the count is the whole point of a hover blip
    // you hear a hundred times crossing one menu.
    variations: [
      { pitch: 1, detuneCents: 0 },
      { pitch: 1.06, detuneCents: 4 },
      { pitch: 0.94, detuneCents: -5 },
      { pitch: 1.12, detuneCents: 7 },
    ],
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0,
    layers: [
      tone('sine', 1760, 0.5, env(0.004, 0.05, 0, 0.035)),
      tone('triangle', 2640, 0.16, env(0.004, 0.04, 0, 0.03)),
    ],
    provenance: 'MasterAudio_ship.prefab:6301 (group), :6396-:6478 (4 variations)',
  }),
  'ui.confirm': spec('ui.confirm', {
    group: 'button_click',
    bank: 'ship',
    // MasterAudio_ship.prefab:5176 groupMasterVolume 1; variation
    // "Selection_SciFi_Misc_05" (:6437) clip volume 1, pitch 1, and
    // useRandomPitch 1 / randomPitchMode 0 (AddToClipPitch) over -0.1..+0.4 —
    // so the multiplier is 1 + [-0.1, +0.4] = [0.9, 1.4].
    groupVolume: 1,
    clipVolume: 1,
    pitch: 1,
    loop: false,
    durationSeconds: 0.18,
    retrigger: 'restart',
    variations: ONE,
    pitchJitter: [0.9, 1.4],
    fadeInSeconds: 0,
    layers: [
      tone('square', 660, 0.3, env(0.003, 0.07, 0.15, 0.06), { endHz: 1320, sweepSeconds: 0.05 }),
      noise('highpass', 3000, 0.7, 0.12, env(0.002, 0.04, 0, 0.03)),
    ],
    provenance: 'MasterAudio_ship.prefab:5176 (group), :6437 (variation, randomPitch -0.1..+0.4)',
  }),
  'ui.back': spec('ui.back', {
    // FF2. The same group, pitched down, because 2016 had no "back" — its menu
    // is one button and a gaze. Two cues that are audibly a pair, not two
    // unrelated sounds, is the cheapest way to say "this one undoes".
    group: 'button_click',
    bank: 'ship',
    groupVolume: 1,
    clipVolume: 1,
    pitch: 0.8,
    loop: false,
    durationSeconds: 0.18,
    retrigger: 'restart',
    variations: ONE,
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0,
    layers: [
      tone('square', 660, 0.3, env(0.003, 0.07, 0.15, 0.06), { endHz: 330, sweepSeconds: 0.06 }),
      noise('highpass', 2200, 0.7, 0.1, env(0.002, 0.04, 0, 0.03)),
    ],
    provenance: 'FF2 (AUD-6): MasterAudio_ship.prefab:5176 button_click at pitch 0.8',
  }),

  // ── The launch shaft ────────────────────────────────────────────────────
  //
  // `Scripts/ScriptedAudio_elevator.cs:14-24` is the whole sequence, and its
  // clock starts when the SHIP IS INSTANTIATED, not when the lift moves — the
  // two have different origins, which is why the survey's "0.33 s after the
  // lift settles" is a DEV-027-shaped derived number with no stated reference
  // frame. FF2 anchors these to its own `LaunchState` instead: `startLaunch()`
  // fires `elevator.start`, and the `rising -> countdown` transition stops the
  // loop over 1.7 s, which is the fade `:24` actually uses.
  'elevator.start': spec('elevator.start', {
    group: 'elevator_startup',
    bank: 'hoverJet',
    // MasterAudio_hoverJet.prefab:4086 groupMasterVolume 0.7115385; variation
    // "ROBOTIC Servo Medium One Long Two Short (mono)" (:3340) clip volume
    // 0.873, pitch 0.7, useRandomPitch 1 with randomPitchMode 1
    // (IgnoreClipPitch) over 0.70..0.87 — so the jitter REPLACES the pitch.
    groupVolume: 0.7115385,
    clipVolume: 0.873,
    pitch: 1,
    loop: false,
    durationSeconds: 1.25,
    retrigger: 'restart',
    variations: ONE,
    pitchJitter: [0.7, 0.87],
    fadeInSeconds: 0,
    // One long, two short — the clip's own name, rendered as three delays.
    layers: [
      tone('sawtooth', 150, 0.34, env(0.02, 0.5, 0.45, 0.12), {
        endHz: 205,
        sweepSeconds: 0.55,
      }),
      noise('bandpass', 420, 2.4, 0.2, env(0.02, 0.45, 0.35, 0.12)),
      tone('sawtooth', 232, 0.26, env(0.01, 0.1, 0, 0.05), { delaySeconds: 0.78 }),
      tone('sawtooth', 232, 0.26, env(0.01, 0.1, 0, 0.05), { delaySeconds: 1.0 }),
    ],
    provenance:
      'MasterAudio_hoverJet.prefab:4086 (group), :3340 (variation); ScriptedAudio_elevator.cs:15',
  }),
  'elevator.loop': spec('elevator.loop', {
    group: 'elevator_moving',
    bank: 'hoverJet',
    // MasterAudio_hoverJet.prefab:4772 groupMasterVolume 0.59615386; variation
    // "MACHINE Factory Machine Heavy Slow (loop mono)" (:4234) clip volume 1,
    // pitch 1, Loop 1.
    //
    // DEVIATION AUD-1: the 2016 group is `isMuted: 1` (:4819), and
    // `MasterAudio.cs:1316` is a hard gate — a muted group plays NOTHING. So
    // the lift ride in every shipped HoverJet mission has a servo click and
    // then silence under it. Nothing unmutes it: zero `MuteGroup`/`UnmuteGroup`
    // calls in first-party code, no `propertyPath: isMuted` in any scene, no
    // soloed group in either bank. FF2 plays it anyway, because a 15 s ride in
    // a headset with nothing under it is a hole rather than a character choice,
    // and because the group is configured, tuned AND volume-ramped (`:24` fades
    // it over 1.7 s) — the mute reads as an editor accident nobody heard.
    //
    // **DECIDED, Matt, 2026-09-12: "aud-1: play it."** So this is a settled
    // deviation rather than an open question, and the lift has a sound under it
    // for the first time. Reverting is deleting one line from `events.ts`.
    groupVolume: 0.59615386,
    clipVolume: 1,
    pitch: 1,
    loop: true,
    durationSeconds: 0,
    retrigger: 'ignore',
    variations: ONE,
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0.25,
    layers: [
      tone('sawtooth', 55, 0.34, env(0.25, 0.4, 0.8, 0.4)),
      tone('square', 110, 0.1, env(0.25, 0.4, 0.7, 0.4), { detuneCents: 9 }),
      noise('lowpass', 320, 0.9, 0.3, env(0.3, 0.5, 0.85, 0.5)),
    ],
    provenance:
      'MasterAudio_hoverJet.prefab:4772 (group, isMuted 1 at :4819), :4234 (variation); ScriptedAudio_elevator.cs:17, fade :24',
  }),
  'shaft.whoosh': spec('shaft.whoosh', {
    group: 'whoosh',
    bank: 'hoverJet',
    // MasterAudio_hoverJet.prefab:5389 groupMasterVolume 0.75, busIndex 0
    // (:5384), isMuted 0 (:5420), retriggerPercentage 100 (:5390),
    // curVariationMode 0 (Normal, :5391); variation "WHOOSH Wide Deep Slow
    // (stereo)" (&108826) AudioSource &8213498 clip volume 1 (:1675), pitch 0.6
    // (:1676), Loop 0 (:1677).
    //
    // ── THE ONE CUE 2016 EMITS FROM A POINT IN THE WORLD ────────────────
    //
    // `FF_WorldTour/scripts/Trigger_PlaySound.cs:12`:
    //
    //     MasterAudio.PlaySound3DAtVector3(soundName, this.transform.position);
    //
    // and `MasterAudio.PlaySoundOnSource`'s `useVector3` branch does
    // `info.Source.transform.position = sourcePosition` — the emitter is MOVED
    // to the box. That is the OTHER branch from the one every ordinary cue
    // takes (`// "2d manner" - from Master Audio location`,
    // `localPosition = Vector3.zero`), which is why this module's
    // "everything is 2D" rule is fidelity everywhere except here.
    //
    // **Eight boxes, 12 m apart.** `PlayerStart_ElevatorShaft_Photon.prefab`
    // carries eight `Trigger_PlaySound` components (&11466066, 68, 70, 74, 76,
    // 78, 80, 82 — prefab lines 6261-6371), every one `m_Enabled: 1` on an
    // `m_IsActive: 1` GameObject named `Trigger_Sound`, every one
    // `soundName: whoosh`. Composed up the parent chain their world Y values are
    // −80.7759, −68.7759, −56.7759, −44.7759, −32.7759, −20.7759, −8.7759,
    // +3.2241: **exactly 12 m apart**, which is the level schema's own
    // `spawn.launch.shaft.segmentSpacing` (12) over its `segmentsAuthored` (8).
    // So the ride is a LADDER of eight whooshes, one per collar, each emitting
    // from the collar it belongs to and sweeping down past you as you rise —
    // and that sweep is the cue. `OnTriggerEnter` then
    // `Destroy(this.gameObject, 0.25f)`, so each box fires once per ride.
    //
    // 2016's `retriggerPercentage: 100` means the group refuses to restart
    // while a voice is still sounding. FF2 renders it `'restart'`, because in
    // this catalogue a one-shot is finished the moment it is fired (the rule
    // that makes twenty-one ring dings in a lap possible) and the eight boxes
    // are ~0.8 s apart at the lift's peak 14.57 m/s. Where 2016 would suppress
    // an overlap, FF2 overlaps. That is a difference of one voice on a cue
    // whose whole job is to sweep past, and it is written down rather than
    // hidden.
    groupVolume: 0.75,
    clipVolume: 1,
    // AudioSource `m_Pitch: 0.6` — a sample playback RATE in 2016, a frequency
    // multiplier here. See the header. It is what makes this a "wide deep slow"
    // whoosh rather than a hiss.
    pitch: 0.6,
    loop: false,
    durationSeconds: 1.4,
    retrigger: 'restart',
    variations: ONE,
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0,
    // Air moving past a hole: a broad band swept downward, with a low body
    // under it so it has somewhere to go as it passes.
    layers: [
      noise('bandpass', 900, 0.7, 0.6, env(0.18, 0.5, 0.35, 0.5), {
        endHz: 180,
        sweepSeconds: 1.1,
      }),
      noise('highpass', 2600, 0.5, 0.18, env(0.12, 0.4, 0.2, 0.4), {
        endHz: 700,
        sweepSeconds: 1,
      }),
      tone('sine', 70, 0.12, env(0.2, 0.5, 0.3, 0.5), { endHz: 44, sweepSeconds: 1 }),
    ],
    // MinDistance 10 (:1682), MaxDistance 500 (:1683), rolloffMode 0
    // (Logarithmic, :1685), DopplerLevel 1 (:1681). The boxes do not move, so
    // the Doppler on this one is whatever the LIFT's own climb produces — a few
    // cents at 14.6 m/s, which is correct and inaudible and costs nothing to
    // keep faithful.
    spatial: { refDistance: 10, maxDistance: 500, doppler: 1 },
    provenance:
      'MasterAudio_hoverJet.prefab:5389 (group), :1664 (variation AudioSource); Trigger_PlaySound.cs:12 via PlayerStart_ElevatorShaft_Photon.prefab:6261-6371 (8 boxes, 12 m apart)',
  }),

  // ── The lift's motor and its arrival, which are FF2's ───────────────────
  //
  // DEV-424, Anniversary only. Matt, 2026-09-26: *"need sound fx for the
  // elevator ride."* 2016's ride is `elevator.start` above, a loop that ships
  // MUTED (AUD-1 plays it anyway) and the eight `shaft.whoosh` collars; no 2016
  // sound follows the platform, and `LaunchElevator.cs` and the lift clip carry
  // no audio call or animation event at all. So neither of these is a port, and
  // both are started, modulated and stopped by `lift.ts` behind the preset's
  // `audio.lift`, which is off on Classic — the standing `gate.whoosh` has.
  //
  // **Why a new voice rather than more of `elevator.loop`:** AUD-1's loop is a
  // 55 Hz sawtooth, a 110 Hz square at a tenth and noise low-passed at 320 Hz —
  // nearly all of it below what a headset's own speakers reproduce, and it sits
  // at one pitch for fifteen seconds. It is the building's machinery. The motor
  // is the PLATFORM: its body and whine sit in 100 Hz .. 1.5 kHz, where small
  // drivers work, and `lift.ts` moves its pitch and level with the platform's
  // speed, so the ride is heard to spin up, cruise and brake.
  'elevator.motor': spec('elevator.motor', {
    group: null,
    bank: null,
    // 1 x 0.6 x 0.75 = 0.45 at full, level with AUD-1's loop (0.447); the
    // preset's `gainBySpeed` takes it from silence at rest.
    groupVolume: 1,
    clipVolume: 0.6,
    pitch: 1,
    loop: true,
    durationSeconds: 0,
    retrigger: 'ignore',
    variations: ONE,
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0.3,
    // At rate 1 — the platform near its peak — a triangle body on 110 Hz with a
    // sawtooth an octave up for edge, a gear whine two octaves over that, a band
    // of rail hiss and a low noise for weight. At the preset's 0.55 at rest the
    // body starts at 60 Hz and the whine at 484, so the spin-up is an octave.
    layers: [
      tone('triangle', 110, 0.34, env(0.3, 0.3, 0.9, 0.4)),
      tone('sawtooth', 220, 0.12, env(0.3, 0.3, 0.85, 0.4), { detuneCents: 6 }),
      tone('sine', 880, 0.07, env(0.4, 0.3, 0.9, 0.4)),
      noise('bandpass', 1400, 1.2, 0.2, env(0.4, 0.4, 0.85, 0.4)),
      noise('lowpass', 180, 0.7, 0.22, env(0.3, 0.4, 0.9, 0.4)),
    ],
    provenance:
      'FF2 (DEV-424): a lift motor following the platform speed; 2016 has none — the ride is elevator_startup, a muted elevator_moving (MasterAudio_hoverJet.prefab:4819) and eight whooshes',
  }),
  'elevator.arrive': spec('elevator.arrive', {
    group: null,
    bank: null,
    // 1 x 0.8 x 0.75 = 0.6: an impact, above the loops it ends.
    groupVolume: 1,
    clipVolume: 0.8,
    pitch: 1,
    loop: false,
    durationSeconds: 0.7,
    retrigger: 'restart',
    variations: ONE,
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0,
    // The platform locking home: a low thud with a falling body, a short
    // metallic clank with its ring, then two latch clicks — the same
    // "one long, two short" grammar the servo at the bottom is named for.
    layers: [
      tone('sine', 90, 0.5, env(0.003, 0.18, 0, 0.1), { endHz: 50, sweepSeconds: 0.15 }),
      noise('lowpass', 400, 0.8, 0.35, env(0.002, 0.12, 0, 0.08)),
      tone('square', 380, 0.16, env(0.002, 0.08, 0, 0.05)),
      noise('bandpass', 2600, 3, 0.2, env(0.001, 0.05, 0, 0.03)),
      tone('triangle', 1500, 0.14, env(0.002, 0.03, 0, 0.02), { delaySeconds: 0.16 }),
      tone('triangle', 1100, 0.12, env(0.002, 0.03, 0, 0.02), { delaySeconds: 0.24 }),
    ],
    provenance:
      'FF2 (DEV-424): the platform locking at the top; 2016 marks the arrival with nothing (LaunchElevator.cs and the lift clip have no audio call or event)',
  }),
  'racer.engine': spec('racer.engine', {
    // No MasterAudio group: 2016's opposition does not go through the bank at
    // all. `Scenes/environments/LevelArt_SimonetIslands.unity` carries FOUR raw
    // Unity `AudioSource`s (first `&104834125`, scene line 267; four instances
    // of `DopplerLevel: 1.04` in that file) on stripped prefab instances of
    // guid `9bd38ed1c57c4f24e91b194ed05cd986` — CLAUDE.md's stripped-instance
    // trap, which is why a name grep over the scene finds nothing.
    //
    //   m_PlayOnAwake 1, Loop 1, m_Volume 1, m_Pitch 1
    //   DopplerLevel 1.04, MinDistance 48, MaxDistance 800, rolloffMode 0
    //   panLevelCustomCurve = 1 at t=0   (fully 3D)
    //   m_audioClip  guid 200eded92532e6f4088d70566dbbdc2d
    //                = indiesfxcds019c/S019C/Stereo/Jet2EngineExt.wav
    //   OutputAudioMixerGroup guid 0e57cb5d78de44544a2000103baf08a2
    //                = Faceted Flight/Audio/Mixer/NPC Ship.mixer
    //
    // **DEVIATION DEV-063.** FF2's opposition is DEV-026's own AI racers rather
    // than the four 2016 recordings, so there is no 2016 emitter to attach this
    // to and the cue is FF2's. What is NOT a deviation is the distance model
    // and the Doppler: those are the numbers 2016 tuned for an NPC ship engine
    // heard from another NPC ship engine's cockpit, and they are ported exactly.
    group: null,
    bank: null,
    // The gain anchor is the one measured quantity in the 2016 opposition's
    // chain: `NPC Ship.mixer`'s Gameplay snapshot, +0.13552584 dB, which is
    // `dbToGain` = 1.0157. A raw AudioSource does not pass through MasterAudio's
    // `_masterAudioVolume`, but FF2 has one SFX output and one `setMasterGain`,
    // so it goes through `cueGain` like everything else and the product is
    // 1 x 1.0157 x 0.75 = 0.7618. The Pre-Launch snapshot's −30.9 dB is the
    // OTHER half of that mixer and is a RAMP rather than a level — see
    // `racer-engines.ts`.
    groupVolume: dbToGain(NPC_MIXER_GAMEPLAY_DB),
    clipVolume: 1,
    pitch: 1,
    loop: true,
    durationSeconds: 0,
    retrigger: 'ignore',
    variations: ONE,
    pitchJitter: NO_JITTER,
    // Long enough that a racer coming into range fades up rather than snapping
    // on. 2016's sources are `PlayOnAwake` in a scene that already contains
    // them, so it never had this problem; FF2 starts them when a run does.
    fadeInSeconds: 0.35,
    // A jet heard from OUTSIDE: turbine whine over a broad exhaust roar. Pitched
    // clear of the player's own `engine.thrust` (150 Hz body) so two racers and
    // your own engine are three things rather than one wall.
    layers: [
      noise('bandpass', 520, 0.9, 0.42, env(0.3, 0.5, 0.85, 0.4)),
      tone('sawtooth', 185, 0.16, env(0.3, 0.4, 0.8, 0.4), { detuneCents: 7 }),
      tone('square', 740, 0.07, env(0.35, 0.5, 0.7, 0.4), { detuneCents: -5 }),
      noise('lowpass', 190, 0.7, 0.2, env(0.35, 0.5, 0.9, 0.5)),
    ],
    spatial: { refDistance: 48, maxDistance: 800, doppler: 1.04 },
    provenance:
      'FF2 (DEV-063) on 2016 numbers: LevelArt_SimonetIslands.unity:267 AudioSource &104834125 (Doppler 1.04, Min 48, Max 800, rolloff 0); NPC Ship.mixer Gameplay +0.13552584 dB',
  }),

  // ── The countdown, and it is FAITHFUL ───────────────────────────────────
  //
  // The survey said no HoverJet mission has a countdown because `useCountdown`
  // is 0 in every scene. That is true and it is not the whole path:
  // `Timer_Race.StartCountdown()` is public (`E3/Scripts/Timer_Race.cs:47`) and
  // starts the coroutine UNCONDITIONALLY, and
  // `FF_WorldTour/scripts/Trigger_EnableShip.cs:66-68` calls it whenever its
  // `countdown` reference is assigned — which in `int_01_hoverJet.unity:326705`
  // it is, to the scene's one live `Timer_Race` (`:259941`), after `delay: 2`.
  // That `Timer_Race` serialises `countdownTime: 3` and
  // `delayBetweenCountdown: 1`: three numbered beats and a GO, a second apart,
  // which is exactly what `src/sim/launch.ts` already runs. So FF2's 3-2-1-GO
  // is a port of `Trigger_EnableShip`'s path, not the deviation DEV-015 called
  // it. `docs/audio-event-map.md` §4.2.
  'countdown.beat': spec('countdown.beat', {
    group: 'CountdownNumber',
    bank: 'hoverJet',
    // MasterAudio_hoverJet.prefab:3474 groupMasterVolume 0.6730769; variation
    // "CountdownNumber" (:5113) clip volume 1, pitch 0.85.
    groupVolume: 0.6730769,
    clipVolume: 1,
    pitch: 0.85,
    loop: false,
    durationSeconds: 0.3,
    retrigger: 'restart',
    variations: ONE,
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0,
    layers: [
      tone('sine', 880, 0.55, env(0.005, 0.14, 0.06, 0.1)),
      tone('sine', 1320, 0.12, env(0.005, 0.08, 0, 0.06)),
    ],
    provenance: 'MasterAudio_hoverJet.prefab:3474 (group), :5113 (variation); Timer_Race.cs:83',
  }),
  'countdown.go': spec('countdown.go', {
    group: 'CoundownGo',
    bank: 'hoverJet',
    // MasterAudio_hoverJet.prefab:4375 groupMasterVolume 0.7307692; variation
    // "CoundownGo" (:5299) clip volume 1, pitch 1. (The group name's spelling
    // is 2016's, and it is the string the C# passes.)
    groupVolume: 0.7307692,
    clipVolume: 1,
    pitch: 1,
    loop: false,
    durationSeconds: 0.7,
    retrigger: 'restart',
    variations: ONE,
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0,
    layers: [
      tone('sine', 1174, 0.55, env(0.005, 0.3, 0.25, 0.3)),
      tone('sine', 1761, 0.2, env(0.005, 0.25, 0.12, 0.25), { detuneCents: 3 }),
      tone('triangle', 587, 0.18, env(0.01, 0.35, 0.2, 0.3)),
    ],
    provenance: 'MasterAudio_hoverJet.prefab:4375 (group), :5299 (variation); Timer_Race.cs:72',
  }),

  // ── Gates ───────────────────────────────────────────────────────────────
  'ring.pass': spec('ring.pass', {
    group: 'CollectRing',
    bank: 'hoverJet',
    // MasterAudio_hoverJet.prefab:5019 groupMasterVolume 0.86538464,
    // retriggerPercentage 50, curVariationSequence 0 (Randomized), SIX
    // variations "SPACE WARP Complex 01..06 (stereo)", each clip volume 1,
    // pitch 1. The mission bank has NO pitch jitter on this group — the six
    // variations are the variety. (The MENU bank's CollectRing is a different
    // group with one clip and +0.57..+1.05 jitter; not this one.)
    //
    // Heard 21 times a lap in `int_01`, which is the liveness-walked gate count
    // (43 `TriggerCheckpoint` components exist; 21 are `m_Enabled: 0` and one
    // more sits under an inactive parent).
    groupVolume: 0.86538464,
    clipVolume: 1,
    pitch: 1,
    loop: false,
    durationSeconds: 0.4,
    retrigger: 'restart',
    variations: [
      { pitch: 1, detuneCents: 0 },
      { pitch: 1.06, detuneCents: 6 },
      { pitch: 0.94, detuneCents: -7 },
      { pitch: 1.12, detuneCents: 11 },
      { pitch: 0.89, detuneCents: -12 },
      { pitch: 1.03, detuneCents: 3 },
    ],
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0,
    layers: [
      tone('sine', 440, 0.42, env(0.004, 0.18, 0.1, 0.14), { endHz: 1760, sweepSeconds: 0.18 }),
      tone('triangle', 660, 0.18, env(0.004, 0.14, 0.05, 0.12), {
        endHz: 2640,
        sweepSeconds: 0.18,
      }),
      noise('bandpass', 800, 1.6, 0.16, env(0.004, 0.2, 0, 0.12), {
        endHz: 4200,
        sweepSeconds: 0.2,
      }),
    ],
    provenance:
      'MasterAudio_hoverJet.prefab:5019 (group), :8168-:9269 (6 variations); TriggerCheckpoint.cs:90',
  }),
  'ring.boost': spec('ring.boost', {
    group: 'PowerupBoost',
    bank: 'hoverJet',
    // MasterAudio_hoverJet.prefab:5514 groupMasterVolume 0.96153843; variation
    // "SPACE WARP Type 03A Charge Up 2 (stereo)" (:5762) clip volume 1, pitch 1.
    //
    // LAYERS on top of `ring.pass`, on the same gate: `TriggerCheckpoint.cs:90`
    // plays CollectRing and `EnergySystem_Ship.cs:269-275` `AddGate()` plays
    // PowerupBoost when `playerShip.orbEffects != null` — which it is on the
    // shipped prefab. Two sounds, one ring. It is also the audible half of the
    // speed chain (`src/sim/speed-chain.ts`), which is the thing that makes a
    // clean run feel different from a scrappy one.
    groupVolume: 0.96153843,
    clipVolume: 1,
    pitch: 1,
    loop: false,
    durationSeconds: 0.55,
    retrigger: 'restart',
    variations: ONE,
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0,
    layers: [
      tone('sawtooth', 220, 0.24, env(0.06, 0.3, 0.35, 0.18), { endHz: 880, sweepSeconds: 0.4 }),
      tone('sine', 110, 0.2, env(0.02, 0.3, 0.2, 0.2), { endHz: 440, sweepSeconds: 0.4 }),
      noise('bandpass', 1200, 2.2, 0.1, env(0.05, 0.35, 0.1, 0.18), {
        endHz: 5000,
        sweepSeconds: 0.4,
      }),
    ],
    provenance:
      'MasterAudio_hoverJet.prefab:5514 (group), :5762 (variation); EnergySystem_Ship.cs:274',
  }),
  'gate.whoosh': spec('gate.whoosh', {
    // ── ANNIVERSARY ONLY. DEV-084, ANNIVERSARY.md S4/S6 ──────────────────
    //
    // 2016 has no sound for the AIR of a gate. `TriggerCheckpoint.cs:90` plays
    // `CollectRing` and `EnergySystem_Ship.cs:274` plays `PowerupBoost`, and
    // both are chimes: they say "scored", not "you just went through a
    // twenty-four-metre hole at two hundred metres a second". The gate is
    // 24 x 35 m (`props.checkpointRing.frame`) and at 180 m/s you are through it
    // in 0.13 s, which is exactly the event a whoosh is for.
    //
    // It is gated on `EngineAudioSpec.curves`, so it cannot sound on Classic —
    // and `gateWhooshGain` is zero everywhere in `classic.json` besides, so even
    // a hand-flipped flag is silent.
    //
    // The group and its volume are 2016's `whoosh` (the shaft collars), for the
    // same reason `ui.back` borrows `button_click`: the game already has a word
    // for "air moving past a hole" and two cues that are audibly a family beat
    // one invented from nothing. The PITCH is the deviation — 1.1 against the
    // shaft's 0.6, because this one goes past in a tenth of the time.
    group: 'whoosh',
    bank: 'hoverJet',
    groupVolume: 0.75,
    clipVolume: 1,
    pitch: 1.1,
    loop: false,
    // Short. `speed-curves.ts` explains why the speed scaling is pitch rather
    // than length, and 0.34 s is about the floor of what reads as a pass rather
    // than as a click.
    durationSeconds: 0.34,
    // `restart`, like every other one-shot here: twenty-one gates a lap, and a
    // pair taken 0.4 s apart must give two whooshes.
    retrigger: 'restart',
    // Three, for the reason `ring.pass` has six — this is heard as often as the
    // ding and a whoosh that is identical every time stops being an event by the
    // fifth gate.
    variations: [
      { pitch: 1, detuneCents: 0 },
      { pitch: 1.07, detuneCents: 5 },
      { pitch: 0.93, detuneCents: -6 },
    ],
    // None: the speed curve IS the per-play variation, and jitter on top would
    // make a slow gate occasionally outrank a fast one, which is the one thing
    // this cue must never do.
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0,
    // The Doppler shape: a bright band collapsing downward as the gate goes
    // behind you, with a short low thump under it so the pass has a body. The
    // sweep is DOWN — the whole cue is the falling half of a pass-by, because
    // the rising half happens before you are close enough to hear it.
    layers: [
      noise('bandpass', 2600, 1.1, 0.7, env(0.012, 0.16, 0.12, 0.14), {
        endHz: 420,
        sweepSeconds: 0.26,
      }),
      noise('highpass', 5200, 0.6, 0.2, env(0.008, 0.1, 0, 0.1), {
        endHz: 1400,
        sweepSeconds: 0.22,
      }),
      tone('sine', 190, 0.1, env(0.02, 0.18, 0, 0.12), { endHz: 70, sweepSeconds: 0.26 }),
    ],
    // 2D, and deliberately. `shaft.whoosh` is positional because 2016's
    // `Trigger_PlaySound.cs:12` really does call `PlaySound3DAtVector3`; this cue
    // has no 2016 emitter to be faithful to, and at the instant it fires the gate
    // is AROUND the listener — distance zero, direction undefined — so a panner
    // would spend its first frames picking an arbitrary bearing. The synthesized
    // downward sweep already carries the pass. Making it positional later is a
    // `spatial` spec here and an `at` on the event, and nothing else.
    provenance:
      'FF2 (DEV-084): MasterAudio_hoverJet.prefab:5389 whoosh group volume 0.75, re-pitched to 1.1 — 2016 has no gate whoosh',
  }),

  // ── The engine, which has no curve ──────────────────────────────────────
  //
  // There is ZERO runtime pitch modulation in first-party 2016 code — no
  // `.pitch =` write, no pitch API, no pitch argument on any of the 53
  // `PlaySound` calls, no `.anim` curve on an audio property. The "engine
  // curve" is a myth: 2016's throttle feel is three loops at three FIXED
  // pitches, swapped on digital trigger edges. The three pitches below are the
  // only thing that number encodes, and their RATIOS to each other are the part
  // worth being faithful to.
  'engine.idle': spec('engine.idle', {
    group: 'JumpSeat_Idle',
    bank: 'hoverJet',
    // MasterAudio_hoverJet.prefab:8231 groupMasterVolume 0.65384614,
    // retriggerPercentage 100 (cannot interrupt itself); variation
    // "SyntheticFighter" (:8116) clip volume **0.1**, pitch 0.55, Loop 1.
    //
    // The 0.1 is not a typo and it is why this is a BED rather than a sound:
    // 0.65384614 x 0.1 x 0.75 = 0.049. Started once at
    // `Ship_HoverShip.cs:167` in `Start()` and never stopped — a project-wide
    // grep finds no `StopAllOfSound`/`FadeOutAllOfSound` naming it. `Start()`
    // does not run at spawn, because `Ship_HoverShip` ships `m_Enabled: 0` and
    // int_01's `Level` has `StartShipSystems: 0`; what enables it is
    // `Trigger_EnableShip.cs:53` at the top of the shaft. In FF2 that is the
    // release, i.e. GO.
    groupVolume: 0.65384614,
    clipVolume: 0.1,
    pitch: 0.55,
    loop: true,
    durationSeconds: 0,
    retrigger: 'ignore',
    variations: ONE,
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0.6,
    layers: [
      tone('sine', 100, 0.5, env(0.5, 0.6, 0.9, 0.8)),
      tone('sawtooth', 200, 0.16, env(0.6, 0.6, 0.75, 0.8), { detuneCents: 7 }),
      noise('lowpass', 320, 0.7, 0.22, env(0.8, 0.8, 0.9, 1)),
    ],
    provenance:
      'MasterAudio_hoverJet.prefab:8231 (group), :8116 (variation); Ship_HoverShip.cs:167',
  }),
  'engine.thrust': spec('engine.thrust', {
    group: 'Thrusters',
    bank: 'hoverJet',
    // MasterAudio_hoverJet.prefab:4186 groupMasterVolume 0.96153843,
    // retriggerPercentage 100, despawnFadeTime 0.5 (against 1.0 everywhere
    // else); variation "Jet5Engine" (:8520) clip volume 1, pitch 0.94, Loop 1.
    // Gated on `Input_Ship.cs:407` (`RightTrigger.Value > 0.05f`) ->
    // `GasPressed()` :570 -> `PlaySound("Thrusters")` :576; stopped by
    // `GasReleased()` :593 -> :599.
    groupVolume: 0.96153843,
    clipVolume: 1,
    pitch: THRUST_PITCH,
    loop: true,
    durationSeconds: 0,
    retrigger: 'ignore',
    variations: ONE,
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0.06,
    layers: THRUST_LAYERS,
    provenance:
      'MasterAudio_hoverJet.prefab:4186 (group), :8520 (variation); Input_Ship.cs:576/:599',
  }),
  'engine.afterburner': spec('engine.afterburner', {
    group: 'AfterBurner',
    bank: 'hoverJet',
    // MasterAudio_hoverJet.prefab:3704 groupMasterVolume 1, limitMode 2
    // (TimeBased) with minimumTimeBetween 0.1, curVariationSequence 1
    // (TopToBottom); variation "THRUSTER Afterburner Power Distorted (loop
    // mono)" (:8279) clip volume 1, pitch 0.88, Loop 1. Gated on
    // `Input_Ship.cs:426` (left AND right trigger) -> `BoostPressed()` :630 ->
    // :635; stopped on `:435` (`LeftTrigger.Value < 0.1f`) -> :644, and also by
    // any `GasReleased()` (:600).
    groupVolume: 1,
    clipVolume: 1,
    pitch: AFTERBURNER_PITCH,
    loop: true,
    durationSeconds: 0,
    retrigger: 'ignore',
    variations: ONE,
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0.04,
    layers: [
      ...AFTERBURNER_TONES,
      noise('bandpass', 520, 0.6, 0.5, env(0.04, 0.3, 0.95, 0.18)),
      noise('highpass', 2600, 0.5, 0.14, env(0.06, 0.3, 0.7, 0.2)),
    ],
    provenance:
      'MasterAudio_hoverJet.prefab:3704 (group), :8279 (variation); Input_Ship.cs:635/:644',
  }),

  // ── The rumble and the growl, which are FF2's ────────────────────────────
  //
  // DEV-137, Anniversary only. Neither is a port of anything: 2016 has no
  // sub layer and modulates no pitch. Both are started, stopped and modulated
  // by `engine.ts` behind `EngineAudioSpec.rumble`, which is null on Classic, so
  // on Classic these two entries are catalogue rows nothing ever plays — the
  // same standing `gate.whoosh` has.
  //
  // The gains are FF2 numbers with no prefab behind them, so they are stated as
  // what they are: `clipVolume` is the level at which the voice sits under the
  // loop it doubles, before the preset's own `gainByThrottle` multiplies it.
  'engine.rumble': spec('engine.rumble', {
    group: null,
    bank: null,
    // 1 x 0.6 x 0.75 = 0.45, against the thruster's 0.72. Under it, by design;
    // `content/editions/anniversary.json` `audio.engine.rumble.gainByThrottle`
    // scales from there.
    groupVolume: 1,
    clipVolume: 0.6,
    // HALF the thruster's authored rate: the whole recipe an octave down, so
    // the rumble's fundamental is the thruster's fundamental / 2 by construction
    // and every rate `modulate` the engine sends keeps the two locked.
    pitch: THRUST_PITCH / 2,
    loop: true,
    durationSeconds: 0,
    retrigger: 'ignore',
    variations: ONE,
    pitchJitter: NO_JITTER,
    // Slower than the thruster's 0.06: this is a bed rising under a sound that
    // already marks the edge.
    fadeInSeconds: 0.6,
    layers: RUMBLE_LAYERS,
    provenance:
      'FF2 (DEV-137): the Thrusters loop (MasterAudio_hoverJet.prefab:4186, variation :8520 pitch 0.94) at HALF rate — its tonal layers and low noise plus a sub sine; 2016 has no rumble layer',
  }),
  'engine.growl': spec('engine.growl', {
    group: null,
    bank: null,
    // 1 x 0.4 x 0.75 = 0.3, under the afterburner's 0.75.
    groupVolume: 1,
    clipVolume: 0.4,
    pitch: AFTERBURNER_PITCH / 2,
    loop: true,
    durationSeconds: 0,
    retrigger: 'ignore',
    variations: ONE,
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0.12,
    layers: GROWL_LAYERS,
    provenance:
      'FF2 (DEV-137): the AfterBurner loop (MasterAudio_hoverJet.prefab:3704, variation :8279 pitch 0.88) at HALF rate plus a roughness partner a fifth above; 2016 has no growl layer',
  }),

  // ── Wind, and its two shipped bugs ──────────────────────────────────────
  'wind.aircraft': spec('wind.aircraft', {
    group: 'AircraftWind',
    bank: 'hoverJet',
    // MasterAudio_hoverJet.prefab:8847 groupMasterVolume 0.9230769,
    // retriggerPercentage 50, curVariationMode 0 (Normal); variation
    // "AircraftWind" (:9158) clip volume 1, pitch 1, Loop 1.
    //
    // `Ship_HoverShip.cs:443-450`: the `if (!flightEffects.isPlaying)` guard is
    // COMMENTED OUT, so `PlaySound("AircraftWind")` fires every FixedUpdate
    // above `minEffectsSpeed`, and `MasterAudio.cs:1658` lets a retrigger
    // through once `GetAudioPlayedPercentage` passes 50 — which on a LOOPING
    // source wraps, so it restarts about every half clip-length forever.
    // AUD-2: FF2 does not reproduce that chop, because its period is a function
    // of a clip length nobody may measure without opening a licence-blocked
    // file. One continuous layer instead.
    groupVolume: 0.9230769,
    clipVolume: 1,
    pitch: 1,
    loop: true,
    durationSeconds: 0,
    retrigger: 'ignore',
    variations: ONE,
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0.2,
    layers: [
      noise('bandpass', 700, 0.8, 0.55, env(0.25, 0.4, 0.9, 0.3)),
      noise('lowpass', 260, 0.7, 0.25, env(0.3, 0.4, 0.8, 0.35)),
    ],
    provenance:
      'MasterAudio_hoverJet.prefab:8847 (group), :9158 (variation); Ship_HoverShip.cs:448',
  }),
  'wind.flight': spec('wind.flight', {
    group: 'FlightWind',
    bank: 'hoverJet',
    // MasterAudio_hoverJet.prefab:8895 groupMasterVolume 0.9423077; variation
    // "FlightWind" (:9321) clip volume 1, pitch 1, Loop 1.
    //
    // KEPT BUG: nothing ever stops it. `Ship_HoverShip.cs:497`'s
    // `FadeOutAllOfSound("FlightWind", 0.15f)` is commented out and an
    // exhaustive grep finds no other stop anywhere. So once you have been past
    // 120 m/s, this layer is under the rest of the run — including at a
    // standstill. Same class as the no-auto-level and free-boost bugs Matt
    // kept, and it is most of what high speed sounds like in 2016.
    groupVolume: 0.9423077,
    clipVolume: 1,
    pitch: 1,
    loop: true,
    durationSeconds: 0,
    retrigger: 'ignore',
    variations: ONE,
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0.3,
    layers: [
      noise('bandpass', 1800, 0.6, 0.5, env(0.35, 0.5, 0.9, 0.4)),
      noise('lowpass', 420, 0.8, 0.3, env(0.4, 0.5, 0.85, 0.45)),
      tone('sawtooth', 70, 0.06, env(0.5, 0.5, 0.6, 0.5), { detuneCents: 5 }),
    ],
    provenance:
      'MasterAudio_hoverJet.prefab:8895 (group), :9321 (variation); Ship_HoverShip.cs:469',
  }),

  // ── Damage and recovery ─────────────────────────────────────────────────
  'ship.crash': spec('ship.crash', {
    group: 'explode2',
    bank: 'hoverJet',
    // MasterAudio_hoverJet.prefab:4275 groupMasterVolume 0.30769235; variation
    // "explode2" (:4145) clip volume 1, pitch 1. `Ship_HoverShip.Flash()`
    // :397 `PlaySoundAndForget("explode2")`, and the same coroutine calls
    // `BoostReleased()` + `GasReleased()` at :408-409 — so a crash CUTS both
    // engine loops as a side effect, and re-arms itself 2.3 s later (:412 0.3 s
    // + :421 2 s -> :424 `flashOnCollide = true`).
    //
    // The menu bank's `explode2` (MasterAudio_ship.prefab:3195) has ZERO
    // variations — a configured group that can never produce a sound. The
    // mission bank's is the live one.
    groupVolume: 0.30769235,
    clipVolume: 1,
    pitch: 1,
    loop: false,
    durationSeconds: 0.8,
    retrigger: 'restart',
    variations: ONE,
    pitchJitter: [0.92, 1.08],
    fadeInSeconds: 0,
    layers: [
      noise('lowpass', 2400, 0.6, 0.7, env(0.004, 0.5, 0.06, 0.3), {
        endHz: 120,
        sweepSeconds: 0.55,
      }),
      tone('sine', 90, 0.45, env(0.004, 0.4, 0, 0.2), { endHz: 38, sweepSeconds: 0.4 }),
      noise('highpass', 4000, 0.7, 0.2, env(0.002, 0.1, 0, 0.06)),
    ],
    provenance:
      'MasterAudio_hoverJet.prefab:4275 (group), :4145 (variation); Ship_HoverShip.cs:397',
  }),
  'ship.crash.sub': spec('ship.crash.sub', {
    // DEV-643. FF2's, and a layer under `ship.crash`, not a replacement: 2016's
    // `explode2` is the cue and stays at its authored level for a graze. The
    // weight of a crash is this: the LOW END, played with a gain that scales
    // with the impact speed (`events.ts`'s `crashWeight`), so a 45 m/s scrape
    // and a 200 m/s nose-in are not the same bang. A sine falling through the
    // bottom of a small speaker's range and a lowpassed rumble under it.
    group: 'explode2',
    bank: 'hoverJet',
    groupVolume: 0.30769235,
    clipVolume: 1,
    pitch: 1,
    loop: false,
    durationSeconds: 1.2,
    retrigger: 'restart',
    variations: ONE,
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0,
    layers: [
      tone('sine', 78, 0.9, env(0.006, 0.7, 0, 0.35), { endHz: 26, sweepSeconds: 0.9 }),
      noise('lowpass', 260, 0.7, 0.55, env(0.01, 0.8, 0.05, 0.3), {
        endHz: 55,
        sweepSeconds: 0.9,
      }),
    ],
    provenance:
      'FF2 (DEV-643): MasterAudio_hoverJet.prefab:4275 explode2 group, a low-end layer under it with the gain scaled by impact speed',
  }),
  'terrain.whoosh': spec('terrain.whoosh', {
    // DEV-642. ANNIVERSARY S4 asked for a whoosh on every near miss with terrain
    // and only the gate half was built. It is `gate.whoosh`'s family (the same
    // `whoosh` group, a falling band of air) one octave rougher and lower, since
    // it is rock going by rather than a hole, and it is POSITIONAL: emitted a few
    // metres toward the terrain that was nearly hit, so a ridge on the left
    // whooshes on the left. The panner's rolloff starts at 10 m, so at the 8 m the
    // caller places it, it is at full level; no Doppler (the point is moving WITH
    // you, and it is gone in a third of a second).
    group: 'whoosh',
    bank: 'hoverJet',
    groupVolume: 0.75,
    clipVolume: 1,
    pitch: 0.85,
    loop: false,
    durationSeconds: 0.36,
    retrigger: 'restart',
    variations: [
      { pitch: 1, detuneCents: 0 },
      { pitch: 1.06, detuneCents: 6 },
      { pitch: 0.94, detuneCents: -5 },
    ],
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0,
    layers: [
      noise('bandpass', 1500, 0.9, 0.75, env(0.01, 0.18, 0.1, 0.15), {
        endHz: 300,
        sweepSeconds: 0.28,
      }),
      noise('lowpass', 700, 0.6, 0.3, env(0.01, 0.2, 0, 0.12), { endHz: 160, sweepSeconds: 0.28 }),
      tone('sine', 150, 0.12, env(0.02, 0.2, 0, 0.12), { endHz: 60, sweepSeconds: 0.26 }),
    ],
    spatial: { refDistance: 10, maxDistance: 500, doppler: 0 },
    provenance:
      'FF2 (DEV-642): MasterAudio_hoverJet.prefab:5389 whoosh group volume 0.75, re-pitched to 0.85 and emitted from the terrain side; 2016 has no near-miss sound',
  }),
  'ship.hit': spec('ship.hit', {
    group: 'hit',
    bank: 'hoverJet',
    // MasterAudio_hoverJet.prefab:3989 groupMasterVolume 0.86538464 (:4005),
    // retriggerPercentage 50; variation (:5165) useRandomPitch 0, on an
    // AudioSource (:3144) with m_Volume 1 and m_Pitch 1. The clip is
    // `WeaponSystem/Sounds/hit.wav`, read as a NAME only (D13).
    //
    // DEVIATION, the DEV-364 follow-up, and AUD-4's shape exactly: 2016
    // configured this group in the mission bank and NOTHING calls it — no
    // `"hit"` in any `.cs` in the project. A racer that strikes the player is
    // FF2's (2016's opposition was a playback nothing could touch), and Matt
    // asked for a sound on it (2026-09-25, "sound and physics cost"). So this
    // is the sound 2016 built for being hit and never wired, rather than one
    // invented.
    //
    // A hull struck, not a crash: a hard band of noise falling fast, a low
    // thump under it, and two inharmonic partials for the metal. Shorter and
    // brighter than `ship.crash`, which is the ground, and louder — the gain
    // is the group's, three times `explode2`'s.
    groupVolume: 0.86538464,
    clipVolume: 1,
    pitch: 1,
    loop: false,
    durationSeconds: 0.4,
    retrigger: 'restart',
    variations: ONE,
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0,
    layers: [
      noise('bandpass', 1800, 1.2, 0.45, env(0.002, 0.16, 0, 0.08), {
        endHz: 480,
        sweepSeconds: 0.18,
      }),
      tone('sine', 150, 0.5, env(0.003, 0.2, 0, 0.1), { endHz: 55, sweepSeconds: 0.2 }),
      tone('triangle', 930, 0.14, env(0.002, 0.26, 0, 0.1)),
      tone('triangle', 1377, 0.1, env(0.002, 0.2, 0, 0.08)),
    ],
    provenance:
      'MasterAudio_hoverJet.prefab:3989 (group), :5165 (variation); FF2 (DEV-364 follow-up) — 2016 has no caller',
  }),
  'ship.reboot': spec('ship.reboot', {
    group: 'Interactions_Robotic_StartUp_01',
    bank: 'hoverJet',
    // MasterAudio_hoverJet.prefab:3752 groupMasterVolume 0.7307692; variation
    // (:5721) clip volume 1, pitch 1, useFades 1 with fadeInTime 0.
    // `EnergySystem_Ship.PlayStartupSounds()` :264, started at :217 at the end
    // of the reboot countdown.
    //
    // Its partner is SILENT: :266 waits 2.55 s and plays
    // `Pulses_Electric_Pulses_04`, whose group (:3615) is `isMuted: 1` (:3662).
    // So the "engine reboot pair" is one sound in the shipped build, and FF2
    // ships one. FF2 has no energy-reboot countdown, so this fires on the
    // out-of-bounds respawn — the one moment where the ship is put back and
    // started again.
    groupVolume: 0.7307692,
    clipVolume: 1,
    pitch: 1,
    loop: false,
    durationSeconds: 1.1,
    retrigger: 'restart',
    variations: ONE,
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0,
    layers: [
      tone('sawtooth', 60, 0.28, env(0.15, 0.5, 0.4, 0.25), { endHz: 240, sweepSeconds: 0.7 }),
      tone('square', 120, 0.1, env(0.2, 0.4, 0.3, 0.25), { endHz: 480, sweepSeconds: 0.7 }),
      noise('bandpass', 600, 1.8, 0.16, env(0.12, 0.5, 0.3, 0.3), {
        endHz: 2400,
        sweepSeconds: 0.7,
      }),
    ],
    provenance:
      'MasterAudio_hoverJet.prefab:3752 (group), :5721 (variation); EnergySystem_Ship.cs:264',
  }),
  'boundary.warn': spec('boundary.warn', {
    group: 'CockpitAlarm2',
    bank: 'hoverJet',
    // MasterAudio_hoverJet.prefab:5651 groupMasterVolume 0.7307692; variation
    // "CockpitAlarm2" (:5814) clip volume 1, pitch 1.
    //
    // DEVIATION AUD-4. 2016 has NO out-of-bounds cue at all:
    // `Scripts/PlayerBoundary.cs` makes zero audio calls of any kind, and the
    // HUD banner is the whole warning. But FF2 gives you a 13 s `resetDelay`
    // (the shipped value in all 13 missions, against the C# initialiser's 10)
    // to get back inside, and in a headset a silent countdown to death is a
    // countdown you do not notice. `CockpitAlarm2` is a mission-bank group with
    // NO caller anywhere in the project — so this uses the sound 2016 built for
    // exactly this and never wired up, rather than inventing one.
    groupVolume: 0.7307692,
    clipVolume: 1,
    pitch: 1,
    loop: false,
    durationSeconds: 0.45,
    retrigger: 'restart',
    variations: ONE,
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0,
    layers: [
      tone('square', 740, 0.3, env(0.006, 0.16, 0, 0.05)),
      tone('square', 740, 0.3, env(0.006, 0.16, 0, 0.05), { delaySeconds: 0.22 }),
      tone('sine', 370, 0.12, env(0.006, 0.3, 0, 0.1)),
    ],
    provenance:
      'MasterAudio_hoverJet.prefab:5651 (group), :5814 (variation); FF2 (AUD-4) — 2016 has no caller',
  }),

  // ── The end of a run ────────────────────────────────────────────────────
  'run.finish': spec('run.finish', {
    group: 'notification',
    bank: 'hoverJet',
    // MasterAudio_hoverJet.prefab:5603 groupMasterVolume 0.9807692; variation
    // "Xylo_13" (:5217) clip volume 1, pitch 1.
    // `Trigger_FinishLine.TriggerFinale()` :72 `PlaySoundAndForget`, which also
    // calls `finaleLogic.StartEnd()` — so this is the sound of the gate that
    // ENDS A RUN. `FinishLine.prefab` (guid fb45707...) is instanced in
    // `int_01_hoverJet.unity` as a stripped `!u!1001`, which is why a name grep
    // over the scene finds nothing and DEV-045 took the life of the port to
    // find.
    groupVolume: 0.9807692,
    clipVolume: 1,
    pitch: 1,
    loop: false,
    durationSeconds: 0.8,
    retrigger: 'restart',
    variations: ONE,
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0,
    layers: [
      tone('sine', 1046, 0.4, env(0.003, 0.28, 0, 0.2)),
      tone('sine', 1568, 0.28, env(0.003, 0.3, 0, 0.22), { delaySeconds: 0.11 }),
      tone('triangle', 2093, 0.14, env(0.003, 0.3, 0, 0.25), { delaySeconds: 0.22 }),
    ],
    provenance:
      'MasterAudio_hoverJet.prefab:5603 (group), :5217 (variation); Trigger_FinishLine.cs:72',
  }),
  'run.medal': spec('run.medal', {
    group: 'awardMedal',
    bank: 'hoverJet',
    // MasterAudio_hoverJet.prefab:3292 groupMasterVolume 1; variation
    // "Interactions_Pickup_Retro_01" (:3422) clip volume 1, pitch 1.
    // `LevelEnd.cs:267` in `AwardMedal()` and `:254` on the end-of-level path,
    // the latter 0.1 s after `UpdateEndUI()` — i.e. as the results panel
    // appears, which is where FF2 fires it.
    groupVolume: 1,
    clipVolume: 1,
    pitch: 1,
    loop: false,
    durationSeconds: 1.1,
    retrigger: 'restart',
    variations: ONE,
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0,
    layers: [
      tone('square', 523, 0.22, env(0.004, 0.16, 0, 0.08)),
      tone('square', 659, 0.22, env(0.004, 0.16, 0, 0.08), { delaySeconds: 0.1 }),
      tone('square', 784, 0.22, env(0.004, 0.16, 0, 0.08), { delaySeconds: 0.2 }),
      tone('square', 1046, 0.26, env(0.004, 0.45, 0.1, 0.35), { delaySeconds: 0.3 }),
      tone('sine', 2093, 0.1, env(0.01, 0.5, 0.05, 0.4), { delaySeconds: 0.3 }),
    ],
    provenance: 'MasterAudio_hoverJet.prefab:3292 (group), :3422 (variation); LevelEnd.cs:254/:267',
  }),

  // ── Ambience ────────────────────────────────────────────────────────────
  'ambient.water': spec('ambient.water', {
    group: 'ambient_water',
    bank: 'hoverJet',
    // MasterAudio_hoverJet.prefab:4831 groupMasterVolume 0.48076922; variation
    // "WATERFALL Close Huge (loop stereo)" (:3563) clip volume 0.4, pitch 1,
    // Loop 1. Note `fadeInTime: 5.1` on the variation is INERT — `useFades: 0`
    // — so 2016 starts it at full. Played by `ScriptedAudio_elevator.cs:21` at
    // t+14.3 s, i.e. as the lift tops out over the sea.
    groupVolume: 0.48076922,
    clipVolume: 0.4,
    pitch: 1,
    loop: true,
    durationSeconds: 0,
    retrigger: 'ignore',
    variations: ONE,
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0,
    layers: [
      noise('bandpass', 1100, 0.5, 0.5, env(0.8, 1, 0.9, 1.2)),
      noise('lowpass', 300, 0.6, 0.35, env(1, 1, 0.85, 1.5)),
    ],
    provenance:
      'MasterAudio_hoverJet.prefab:4831 (group), :3563 (variation); ScriptedAudio_elevator.cs:21',
  }),
  'ambient.island': spec('ambient.island', {
    group: 'Ambient_Island',
    bank: 'hoverJet',
    // MasterAudio_hoverJet.prefab:9373 groupMasterVolume 0.7884615; variation
    // "beach_morning_ambience_01_30_loop" (:9058) clip volume 1, pitch 1,
    // Loop 1, useFades 1 with fadeInTime 1 / fadeOutTime 0 — and
    // `SoundGroupVariation.cs:353-362` does apply it, so the 1 s fade-in is
    // behaviour and not just a serialised field.
    //
    // Per-ENVIRONMENT, not per-mission: `Level_Audio` sits on
    // `LevelArt_SimonetIslands.prefab` (:516939, `clipName: Ambient_Island`,
    // `startDelay: 0`) and plays it at `Level_Audio.cs:17`. The siblings are
    // `Ambient_Desert` (0.7692307) and `Ambient_Mountains` (0.8076923); kauai
    // shares the island one. Wiring the other three is one lookup on
    // `level.environment` and is left to the day FF2 plays them.
    groupVolume: 0.7884615,
    clipVolume: 1,
    pitch: 1,
    loop: true,
    durationSeconds: 0,
    retrigger: 'ignore',
    variations: ONE,
    pitchJitter: NO_JITTER,
    fadeInSeconds: 1,
    layers: [
      noise('bandpass', 620, 0.4, 0.3, env(1, 1.2, 0.85, 1.5)),
      noise('highpass', 2600, 0.4, 0.1, env(1.2, 1.2, 0.7, 1.5)),
      noise('lowpass', 180, 0.7, 0.22, env(1.5, 1.5, 0.9, 2)),
    ],
    provenance:
      'MasterAudio_hoverJet.prefab:9373 (group), :9058 (variation); Level_Audio.cs:17 via LevelArt_SimonetIslands.prefab:516939',
  }),

  // ── The flight instructor (DEV-377) ─────────────────────────────────────
  //
  // FF2's, both: 2016 had no instructor and no lesson (it authored a Training
  // rank and switched it off). `docs/plan/FLIGHT-INSTRUCTOR.md` §5.2 — there is
  // no voice, by Matt's call 7: the lesson is written on a plate, and these two
  // say "look up" and "that was it". Both editions, like the lesson itself.
  //
  // Quieter than a ring (0.375 against CollectRing's 0.649) and louder than the
  // idle bed, and brief: a chirp is over before a prompt has finished fading
  // in, and a player mid-turn reads the plate when the turn is done.
  'lesson.prompt': spec('lesson.prompt', {
    group: null,
    bank: null,
    groupVolume: 1,
    clipVolume: 0.5,
    pitch: 1,
    loop: false,
    // Two blips 90 ms apart and a click of static under the first: a radio
    // keyed, not a musical phrase — the phrase is `lesson.done`'s.
    durationSeconds: 0.32,
    retrigger: 'restart',
    variations: ONE,
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0,
    layers: [
      noise('bandpass', 2400, 1.4, 0.18, env(0.002, 0.04, 0, 0.03)),
      tone('square', 1320, 0.2, env(0.003, 0.05, 0.4, 0.03)),
      tone('square', 1760, 0.2, env(0.003, 0.05, 0.4, 0.05), { delaySeconds: 0.09 }),
    ],
    provenance: 'FF2 (DEV-377): the lesson prompt chirp. 2016 has no instructor and no voice',
  }),
  'lesson.done': spec('lesson.done', {
    group: null,
    bank: null,
    groupVolume: 1,
    clipVolume: 0.5,
    pitch: 1,
    loop: false,
    // A RISING pair, a fifth apart (§5.2): the step is done. Softer-edged
    // than the prompt — sines, not squares — because it is a reward, and
    // below `run.medal`'s four-note climb, which is the reward for the run.
    durationSeconds: 0.5,
    retrigger: 'restart',
    variations: ONE,
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0,
    layers: [
      tone('sine', 880, 0.4, env(0.004, 0.12, 0.2, 0.08)),
      tone('sine', 1320, 0.4, env(0.004, 0.2, 0.15, 0.2), { delaySeconds: 0.12 }),
      tone('triangle', 2640, 0.08, env(0.01, 0.2, 0, 0.15), { delaySeconds: 0.12 }),
    ],
    provenance: 'FF2 (DEV-377): the lesson step-done chirp. 2016 has no instructor and no voice',
  }),
  'jump.charge': spec('jump.charge', {
    group: null,
    bank: null,
    groupVolume: 1,
    clipVolume: 0.4,
    pitch: 1,
    loop: true,
    durationSeconds: 0,
    retrigger: 'ignore',
    variations: ONE,
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0,
    // A wind-up, not an engine: a triangle and a quiet square an octave over
    // it, held steady here and raised by `jump-charge.ts`'s rate as the charge
    // fills. `sweepSeconds: 0` on both, as on every loop that is
    // rate-modulated (`webaudio.ts`, `filters`): the rise is the charge's, so
    // it cannot drift from it when a variant's `chargeSeconds` changes.
    layers: [
      tone('triangle', 220, 0.5, env(0.04, 0, 1, 0.05)),
      tone('square', 440, 0.12, env(0.04, 0, 1, 0.05), { detuneCents: 7 }),
    ],
    provenance:
      "FF2 (DEV-383): the jumping spider's charge tone. 2016 has no jump; AIRCRAFT-VARIANTS §4.5 asks for a rising tone under the charge ring",
  }),

  // ── FF TV (DEV-482) ─────────────────────────────────────────────────────
  //
  // FF2's: 2016 had no TV. plan/FF-TV.md §5.4, "a sting on the ident. No
  // commentary." A station ident, not a reward: two bright chords a fourth
  // apart over a soft low root, sines and a triangle (the lesson's register,
  // not the medal's squares), under a second, and quieter than `run.medal`
  // because it plays over the soundtrack's own start.
  'tv.ident': spec('tv.ident', {
    group: null,
    bank: null,
    groupVolume: 1,
    clipVolume: 0.45,
    pitch: 1,
    loop: false,
    durationSeconds: 0.95,
    retrigger: 'restart',
    variations: ONE,
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0,
    layers: [
      tone('sine', 196, 0.3, env(0.01, 0.5, 0.2, 0.3)),
      tone('sine', 784, 0.26, env(0.004, 0.18, 0.1, 0.1)),
      tone('sine', 988, 0.2, env(0.004, 0.18, 0.1, 0.1)),
      tone('sine', 1046, 0.28, env(0.004, 0.4, 0.15, 0.3), { delaySeconds: 0.16 }),
      tone('sine', 1318, 0.22, env(0.004, 0.4, 0.15, 0.3), { delaySeconds: 0.16 }),
      tone('triangle', 2093, 0.06, env(0.01, 0.4, 0, 0.3), { delaySeconds: 0.16 }),
    ],
    provenance: 'FF2 (DEV-482): the FF TV ident sting. 2016 has no TV',
  }),

  // ── The polish wave's feel cues (DEV-638 to DEV-644), all FF2's ─────────
  //
  // POLISH-WAVE-2026-10-05, the "feel" rows. 2016 has none of these: a gate is
  // a chime, a loss is silence, a tank is a bar, a pass is nothing, and every
  // medal is one cue. They are synthesised like the rest (D13), group and bank
  // null, and every level is a `clipVolume` against the 0.75 of `cueGain`.
  // Each is mapped from an event in `events.ts`, so none is an orphan.

  // DEV-639. A soft descending fall: a triangle a fifth over a sine, both
  // sliding down an octave, and a breath of low noise. The EVENT picks the
  // pitch and the level (`ladder.ts`'s three voices); this is the shape.
  'gate.dud': spec('gate.dud', {
    group: null,
    bank: null,
    groupVolume: 1,
    clipVolume: 0.6,
    pitch: 1,
    loop: false,
    durationSeconds: 0.45,
    retrigger: 'restart',
    variations: ONE,
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0,
    layers: [
      tone('triangle', 392, 0.34, env(0.005, 0.2, 0.1, 0.18), { endHz: 196, sweepSeconds: 0.3 }),
      tone('sine', 262, 0.3, env(0.005, 0.22, 0.05, 0.2), { endHz: 131, sweepSeconds: 0.3 }),
      noise('lowpass', 600, 0.5, 0.08, env(0.004, 0.12, 0, 0.1)),
    ],
    provenance:
      'FF2 (DEV-639): the descending cue for a miss, a broken streak and an expired chain',
  }),

  // DEV-640. The tank, three sounds. A rising tick when a ring refills it: two
  // quick sines a fifth apart going UP, short, so it reads as "filled" next to
  // the ring's own chime without competing with it.
  'tank.fill': spec('tank.fill', {
    group: null,
    bank: null,
    groupVolume: 1,
    clipVolume: 0.5,
    pitch: 1,
    loop: false,
    durationSeconds: 0.2,
    retrigger: 'restart',
    variations: ONE,
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0,
    layers: [
      tone('sine', 880, 0.4, env(0.003, 0.05, 0, 0.04), { endHz: 1175, sweepSeconds: 0.05 }),
      tone('triangle', 1320, 0.22, env(0.003, 0.06, 0, 0.05), {
        delaySeconds: 0.05,
        endHz: 1760,
        sweepSeconds: 0.06,
      }),
    ],
    provenance: 'FF2 (DEV-640): a rising tick when a gate refills the boost tank',
  }),
  // A sputter when it runs dry: four falling coughs of a square wave over
  // bursts of noise, each lower and further apart, an engine starved of fuel.
  'tank.sputter': spec('tank.sputter', {
    group: null,
    bank: null,
    groupVolume: 1,
    clipVolume: 0.6,
    pitch: 1,
    loop: false,
    durationSeconds: 0.7,
    retrigger: 'restart',
    variations: ONE,
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0,
    layers: [
      tone('square', 150, 0.26, env(0.002, 0.06, 0, 0.04), { endHz: 90, sweepSeconds: 0.07 }),
      noise('bandpass', 520, 1.2, 0.3, env(0.002, 0.07, 0, 0.04)),
      tone('square', 126, 0.24, env(0.002, 0.07, 0, 0.04), {
        delaySeconds: 0.12,
        endHz: 76,
        sweepSeconds: 0.08,
      }),
      noise('bandpass', 440, 1.2, 0.26, env(0.002, 0.07, 0, 0.04), { delaySeconds: 0.12 }),
      tone('square', 104, 0.22, env(0.002, 0.08, 0, 0.05), {
        delaySeconds: 0.27,
        endHz: 60,
        sweepSeconds: 0.09,
      }),
      noise('bandpass', 360, 1.2, 0.22, env(0.002, 0.08, 0, 0.05), { delaySeconds: 0.27 }),
      tone('square', 80, 0.18, env(0.002, 0.1, 0, 0.08), {
        delaySeconds: 0.47,
        endHz: 44,
        sweepSeconds: 0.12,
      }),
    ],
    provenance: 'FF2 (DEV-640): the sputter when the boost tank runs dry',
  }),
  // A dry click when boost is pressed with nothing in the tank: a tick of high
  // noise over a short low knock, the sound of a switch that connects to nothing.
  'tank.dry': spec('tank.dry', {
    group: null,
    bank: null,
    groupVolume: 1,
    clipVolume: 0.55,
    pitch: 1,
    loop: false,
    durationSeconds: 0.1,
    retrigger: 'restart',
    variations: ONE,
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0,
    layers: [
      noise('highpass', 2800, 0.7, 0.42, env(0.001, 0.014, 0, 0.012)),
      tone('square', 210, 0.2, env(0.001, 0.02, 0, 0.02), { endHz: 150, sweepSeconds: 0.02 }),
    ],
    provenance: 'FF2 (DEV-640): a dry click on a boost press with an empty tank',
  }),

  // DEV-641. An overtake. Two notes a fourth apart, UP for a place gained and
  // DOWN for a place lost, the same two pitches so they read as a pair.
  'race.gain': spec('race.gain', {
    group: null,
    bank: null,
    groupVolume: 1,
    clipVolume: 0.5,
    pitch: 1,
    loop: false,
    durationSeconds: 0.4,
    retrigger: 'restart',
    variations: ONE,
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0,
    layers: [
      tone('sine', 523, 0.4, env(0.004, 0.12, 0.05, 0.1)),
      tone('triangle', 1046, 0.1, env(0.004, 0.1, 0, 0.08)),
      tone('sine', 698, 0.42, env(0.004, 0.2, 0.08, 0.16), { delaySeconds: 0.1 }),
      tone('triangle', 1397, 0.12, env(0.004, 0.16, 0, 0.12), { delaySeconds: 0.1 }),
    ],
    provenance: 'FF2 (DEV-641): a rising cue when the player gains a place',
  }),
  'race.loss': spec('race.loss', {
    group: null,
    bank: null,
    groupVolume: 1,
    clipVolume: 0.5,
    pitch: 1,
    loop: false,
    durationSeconds: 0.4,
    retrigger: 'restart',
    variations: ONE,
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0,
    layers: [
      tone('sine', 698, 0.36, env(0.004, 0.12, 0.05, 0.1)),
      tone('sine', 523, 0.38, env(0.004, 0.2, 0.08, 0.16), { delaySeconds: 0.1 }),
      tone('triangle', 262, 0.14, env(0.006, 0.2, 0, 0.14), { delaySeconds: 0.1 }),
    ],
    provenance: 'FF2 (DEV-641): a falling cue when the player loses a place',
  }),
  // A racer going by. Shaped like the gate whoosh (a bright band falling as the
  // ship passes) and longer and lower, because the source is a jet 10 to 60 m
  // away and not a hole: it is panned by where it was, through the racer
  // engines' own distance model (48 m to 800 m, `racer.engine`), so the side it
  // went by on is the side you hear.
  'flyby.whoosh': spec('flyby.whoosh', {
    group: null,
    bank: null,
    groupVolume: 1,
    clipVolume: 0.9,
    pitch: 1,
    loop: false,
    durationSeconds: 0.9,
    retrigger: 'restart',
    variations: [
      { pitch: 1, detuneCents: 0 },
      { pitch: 0.93, detuneCents: -6 },
    ],
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0,
    layers: [
      noise('bandpass', 1800, 0.9, 0.6, env(0.09, 0.3, 0.2, 0.3), {
        endHz: 260,
        sweepSeconds: 0.7,
      }),
      noise('highpass', 3800, 0.5, 0.16, env(0.06, 0.2, 0.1, 0.25), {
        endHz: 900,
        sweepSeconds: 0.6,
      }),
      tone('sawtooth', 160, 0.12, env(0.08, 0.3, 0.1, 0.3), { endHz: 70, sweepSeconds: 0.7 }),
    ],
    spatial: { refDistance: 48, maxDistance: 800, doppler: 0 },
    provenance:
      'FF2 (DEV-641): a whoosh on every close flyby, positional; distance model is racer.engine (the 2016 NPC engine AudioSource: MinDistance 48, MaxDistance 800)',
  }),

  // DEV-644. A sound per medal tier, one phrase each, getting longer and wider.
  // 2016 plays `awardMedal` whatever the string is (LevelEnd.cs:254/267); the
  // grade is carried on the event for exactly this ("a future platinum gets its
  // own flourish"). Bronze is two notes, silver three, gold four with a ring,
  // platinum a six-note rise into a held chord with a shimmer that outlasts it.
  'medal.bronze': spec('medal.bronze', {
    group: null,
    bank: null,
    groupVolume: 1,
    clipVolume: 0.8,
    pitch: 1,
    loop: false,
    durationSeconds: 0.8,
    retrigger: 'restart',
    variations: ONE,
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0,
    layers: [
      tone('square', 392, 0.2, env(0.004, 0.14, 0, 0.08)),
      tone('square', 523, 0.22, env(0.004, 0.3, 0.1, 0.25), { delaySeconds: 0.12 }),
      tone('sine', 1046, 0.07, env(0.01, 0.3, 0.05, 0.25), { delaySeconds: 0.12 }),
    ],
    provenance: 'FF2 (DEV-644): the bronze medal, two notes',
  }),
  'medal.silver': spec('medal.silver', {
    group: null,
    bank: null,
    groupVolume: 1,
    clipVolume: 0.8,
    pitch: 1,
    loop: false,
    durationSeconds: 1,
    retrigger: 'restart',
    variations: ONE,
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0,
    layers: [
      tone('square', 440, 0.2, env(0.004, 0.14, 0, 0.08)),
      tone('square', 554, 0.2, env(0.004, 0.14, 0, 0.08), { delaySeconds: 0.1 }),
      tone('square', 659, 0.24, env(0.004, 0.4, 0.1, 0.3), { delaySeconds: 0.2 }),
      tone('sine', 1318, 0.08, env(0.01, 0.4, 0.05, 0.3), { delaySeconds: 0.2 }),
      tone('sine', 1760, 0.04, env(0.02, 0.4, 0, 0.35), { delaySeconds: 0.3 }),
    ],
    provenance: 'FF2 (DEV-644): the silver medal, three notes',
  }),
  'medal.gold': spec('medal.gold', {
    group: null,
    bank: null,
    groupVolume: 1,
    clipVolume: 0.85,
    pitch: 1,
    loop: false,
    durationSeconds: 1.4,
    retrigger: 'restart',
    variations: ONE,
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0,
    layers: [
      tone('square', 523, 0.22, env(0.004, 0.14, 0, 0.08)),
      tone('square', 659, 0.22, env(0.004, 0.14, 0, 0.08), { delaySeconds: 0.1 }),
      tone('square', 784, 0.22, env(0.004, 0.14, 0, 0.08), { delaySeconds: 0.2 }),
      tone('square', 1046, 0.28, env(0.004, 0.6, 0.15, 0.5), { delaySeconds: 0.3 }),
      tone('sine', 2093, 0.12, env(0.01, 0.7, 0.08, 0.55), { delaySeconds: 0.3 }),
      tone('triangle', 1568, 0.1, env(0.01, 0.6, 0.06, 0.5), { delaySeconds: 0.34 }),
    ],
    provenance: 'FF2 (DEV-644): the gold medal, four notes and a ring',
  }),
  'medal.platinum': spec('medal.platinum', {
    group: null,
    bank: null,
    groupVolume: 1,
    clipVolume: 0.9,
    pitch: 1,
    loop: false,
    durationSeconds: 2.2,
    retrigger: 'restart',
    variations: ONE,
    pitchJitter: NO_JITTER,
    fadeInSeconds: 0,
    layers: [
      tone('square', 523, 0.22, env(0.004, 0.14, 0, 0.08)),
      tone('square', 659, 0.22, env(0.004, 0.14, 0, 0.08), { delaySeconds: 0.09 }),
      tone('square', 784, 0.22, env(0.004, 0.14, 0, 0.08), { delaySeconds: 0.18 }),
      tone('square', 1046, 0.24, env(0.004, 0.2, 0.1, 0.12), { delaySeconds: 0.27 }),
      tone('square', 1318, 0.24, env(0.004, 0.2, 0.1, 0.12), { delaySeconds: 0.36 }),
      tone('square', 1568, 0.3, env(0.004, 0.9, 0.2, 0.8), { delaySeconds: 0.45 }),
      tone('sine', 523, 0.3, env(0.01, 1, 0.2, 0.9), { delaySeconds: 0.45 }),
      tone('sine', 784, 0.2, env(0.01, 1, 0.15, 0.9), { delaySeconds: 0.45 }),
      tone('sine', 3136, 0.1, env(0.02, 1, 0.1, 0.9), { delaySeconds: 0.45 }),
      tone('triangle', 4186, 0.05, env(0.05, 0.8, 0.05, 0.9), {
        delaySeconds: 0.7,
        detuneCents: 9,
      }),
      noise('highpass', 6000, 0.6, 0.06, env(0.1, 0.6, 0.05, 0.8), { delaySeconds: 0.55 }),
    ],
    provenance:
      'FF2 (DEV-644): the platinum medal, a six-note rise into a held chord and a shimmer',
  }),
}

/** Every cue id, in catalogue order. */
export const CUE_IDS = Object.keys(CUES) as CueId[]

/** Lookup that cannot return undefined — the catalogue is total over `CueId`. */
export const cue = (id: CueId): CueSpec => CUES[id]

/**
 * Pick a variation and a jitter multiplier for one play.
 *
 * Pure, and the randomness is INJECTED — `src/audio/` is not the sim layer so
 * `Math.random()` is allowed here, but a cue whose variety cannot be asserted
 * is a cue whose variety nobody checks. `random` returns [0, 1).
 */
export const resolveVariation = (
  s: CueSpec,
  random: () => number,
): { readonly pitch: number; readonly detuneCents: number } => {
  const n = s.variations.length
  const index = Math.min(n - 1, Math.max(0, Math.floor(random() * n)))
  const chosen = s.variations[index] ?? { pitch: 1, detuneCents: 0 }
  const [lo, hi] = s.pitchJitter
  const jitter = lo + (hi - lo) * random()
  return { pitch: s.pitch * chosen.pitch * jitter, detuneCents: chosen.detuneCents }
}

/**
 * How long a one-shot's longest layer actually runs, seconds.
 *
 * Derived rather than trusted: `durationSeconds` is the authored intent, and a
 * layer with a late `delaySeconds` plus a long release can outlive it. Used by
 * the backend to know when a voice can be torn down, and by the tests to assert
 * that no cue is truncated by its own declared length. DEV-027: it is the max
 * over layers of `delay + attack + decay + release`.
 */
export const cueTailSeconds = (s: CueSpec): number => {
  let longest = s.durationSeconds
  for (const layer of s.layers) {
    const end = layer.delaySeconds + layer.env.attack + layer.env.decay + layer.env.release
    if (end > longest) longest = end
  }
  return longest
}
