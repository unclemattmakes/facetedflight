// src/boot/settings.ts — the comfort settings, and the fact that they survive a
// reload.
//
// PORT_PLAN §2.9: *"A comfort menu, reachable from pause, with all of the above
// plus the existing recenter."* The menu is the render half; this is the half
// that makes it worth having. **A comfort setting that resets every load is not
// a comfort setting** — it is a thing you have to find and re-set every time you
// put the headset on, at the exact moment you are least able to operate a menu,
// which is after the last session made you queasy.
//
// ── Why this is in boot/ and not render/ ─────────────────────────────────
//
// Nothing here draws. `render/comfort-menu.ts` turns this object into rows and
// `render/vignette.ts` reads two fields off it; both are pure consumers. Boot
// owns it because boot is what loads it before the first frame and hands the
// same object to the renderer, the vignette and the menu — one copy, one owner.
//
// ── Every read and write is wrapped, and that is not defensive noise ─────
//
// The idiom, the reasoning and the `safeStorage` helper are all
// `game/personal-best.ts`'s; read the header there. Short version:
// `localStorage` **throws on property access** — not returns null, throws — in a
// private window with site data blocked and in some embedded webviews, so an
// unguarded read at boot takes the whole app down before the first frame. It is
// imported rather than re-typed because a guard with a subtle failure mode
// wants one implementation, not two that drift.
//
// ── Fields are validated ONE AT A TIME, on purpose ───────────────────────
//
// The key is visible in devtools on a public URL and someone will edit it. A
// whole-object "does this parse" check throws away a good `vignette` because
// `quality` got typed as `"extreme"`, which silently un-sets the one field the
// player actually cares about. Each field falls back to its own default and the
// rest stand.

import { VOLUME_STEPS, type VolumeSetting } from '@/audio/volume'
import { EDITION_IDS, type EditionId } from '@/content/edition-schema'
import { safeStorage } from '@/game/personal-best'
import { readJsonKey, writeJsonKey } from '@/game/storage'

/**
 * How much the Anniversary speed effects are allowed to move the air.
 *
 * docs/plan/ANNIVERSARY.md §2.6: a sense of speed IS vection, so the effects
 * that make it are a comfort setting first. Three settings, like the vignette,
 * because the two ends of the tolerance range do not share a number. Scaled
 * to 0 / 0.5 / 1 by `game/edition.ts`; inert on the Classic preset, whose
 * flags are all off.
 */
export type SpeedFxSetting = 'off' | 'light' | 'full'

/**
 * How hard the angular-rate vignette closes. Three settings, not a boolean.
 *
 * PORT_PLAN §2.9: *"Three settings — off / light / strong — default light"*,
 * because *"tolerance varies enormously between people"* and the two ends of
 * that range do not share a number. `off` is a real setting, not a failure
 * mode: a player who is fine tends to find the vignette itself distracting.
 */
export type VignetteSetting = 'off' | 'light' | 'strong'

/**
 * The resolution/fill trade. Coarse on purpose: this is a knob for a person in
 * a headset, not a graphics options screen.
 *
 * `ultra` is the fourth, and a FLAT-ONLY tier (DEV-581, docs/plan/ULTRA.md):
 * the menu offers it only on a monitor, and while a headset is presenting it
 * resolves to `high` in {@link qualityInForce}, so VR is unchanged by
 * construction rather than by care. A reader that takes `quality` raw instead
 * of in force (the MSAA attribute, the shadow map, the detail ring, the life
 * gate) must treat `ultra` as at least `high`; each of those does.
 */
export type QualitySetting = 'low' | 'medium' | 'high' | 'ultra'

export interface ComfortSettings {
  /** Angular-rate vignette. §2.9 item 1. */
  readonly vignette: VignetteSetting
  /**
   * The world-locked horizon band. §2.9 item 2, and *"Off by default,
   * discoverable in the comfort menu"* — it is a strong aid for the people who
   * need it and a strange floating hoop for everyone else.
   */
  readonly horizon: boolean
  /** Base render resolution. §2.9 / M3's `AdaptiveResolution` baseline. */
  readonly quality: QualitySetting
  /**
   * AUTO: the player has not picked a tier, so each surface gets its own
   * default — `quality` (High) on a monitor, {@link VR_AUTO_QUALITY} in a
   * headset. DEV-334, Matt 2026-09-23: *"VR starts at Medium"* unless you
   * have picked a tier yourself. Optional, and ABSENT means false: an object
   * that names a `quality` and says nothing else means that tier everywhere,
   * which is what every settings object written before this field did.
   */
  readonly qualityAuto?: boolean
  /**
   * Let a frame-rate dip cost resolution instead of comfort.
   *
   * On by default: the whole point is that the player never has to know it
   * exists. Off is for MEASURING — a fixed resolution is the only way to read a
   * GPU number that means anything.
   */
  readonly adaptiveResolution: boolean
  /**
   * Fixed foveated rendering — `renderer.xr.setFoveation(1)`.
   *
   * M2: *"measured with and without"*. It is a setting rather than a constant
   * precisely so that measurement is possible from inside the headset, in one
   * session, without a rebuild. See `render/quality.ts` for what the two states
   * actually do and for the surprise (three's own default is already 1).
   */
  readonly foveation: boolean
  /**
   * How loud, when not muted. Four steps 6 dB apart — `audio/volume.ts` owns
   * the ladder and says why it is steps and not a slider.
   *
   * A comfort setting, and not only in the sense that it is on the comfort
   * page: this is played in a headset, at night, with the audio strapped to
   * your head, and since DEV-063 the launch ride fires eight positional
   * whooshes and two AI racers run Doppler-shifted engines beside you. "Too
   * loud" had no remedy at all before this row except `?audio=off`, which is a
   * URL.
   */
  readonly volume: VolumeSetting
  /**
   * `editionFeatures()` paths the player has forced on or off. DEV-269.
   *
   * The Advanced page writes this; `game/edition.ts` applies it as the last
   * layer, over the preset AND over the VR list — so it can put back something
   * `vr.disable` turned off, which is how you look at what a feature costs
   * without a rebuild.
   *
   * An UNKNOWN path is kept rather than dropped on load, and ignored when
   * applied. That is deliberate and it is the opposite of the rule the edition
   * FILES are held to: stored settings outlive the build that wrote them, so a
   * feature renamed in a later version must not brick the menu, and a player
   * who rolls back should find their choice still there.
   */
  readonly featureOverrides: Readonly<Record<string, boolean>>
  /**
   * Silence, independent of the level, and it wins over it.
   *
   * Its own field rather than an `off` at the bottom of the ladder, because a
   * bottom rung is four presses from `full` at the moment somebody most needs
   * it to be one. Its row is on the PAUSE PLATE, not on the comfort page — one
   * level closer, so muting is pause, look, press, and the level you were at is
   * still there when you come back.
   */
  readonly muted: boolean
  /**
   * Pull back to climb. The global invert-Y preference, and 2016's own.
   *
   * `InputManager.InvertYAxis` — one switch for the whole game, flipped by
   * `Input_Ship.InvertPitch()` (:549-552) and persisted in
   * `PlayerPrefs["InvertPitch"]`, so this field ports a thing that already
   * survived a reload in 2016. It is NEVER a vehicle constant: the serialised
   * `invertPitch` bool on the prefabs is per-instance state and the two shipped
   * ships disagree about it (HoverJet 0, JumpSeat 1), which is exactly the trap
   * D16 was written against. Default `false` — the HoverJet prefab's, and the
   * direction that makes "invert pitch: off" mean what it says.
   *
   * ── Why a CONTROLS setting lives on the comfort object ─────────────────
   *
   * Partly this file's own argument — one owner, one save, and a second store
   * is a second thing to forget. But it earns the place on its own: a player
   * whose pitch is the wrong way round in a headset does not fly badly and
   * stop, they fly badly, over-correct, and get ill. It is REACHED from a
   * controls page rather than the comfort one, because that is where somebody
   * looking for it will look.
   */
  readonly invertPitch: boolean
  /**
   * Controller rumble (DEV-637, `input/haptics.ts`). On by default: a pad's
   * motors and a headset controller's actuator, never a phone's. It is a
   * CONTROLS setting for the reason `invertPitch` is: it is about what the
   * player's hands do, so it lives on the Controls page. Not a comfort effect:
   * a rumble creates no vection, so Speed FX does not scale it.
   */
  readonly haptics: boolean
  /**
   * Which LOOK a mission wears: `classic` (2016's) or `anniversary`
   * (docs/plan/ANNIVERSARY.md). A look and nothing else since D35 (DEV-452):
   * every run flies Anniversary's rules and every menu wears Anniversary
   * (DEV-451), so this moves what a mission draws, never who races or which
   * board a lap goes on. Stored here because it is a choice that has to
   * survive a reload for the same reason the vignette does, and because one
   * owner and one save is this file's whole argument. `?edition=<id>`
   * overrides it for ONE load without writing it back.
   */
  readonly edition: EditionId
  /**
   * AUTO: the player has not picked a look, so each surface gets its own default:
   * `edition` (Anniversary) on a monitor, {@link VR_AUTO_EDITION} in a headset. DEV-896,
   * Matt 2026-10-10: *"default to classic & medium"* in VR. Same shape and the same
   * reading of old data as {@link ComfortSettings.qualityAuto}: ABSENT means false.
   */
  readonly editionAuto?: boolean
  /** The speed-effects comfort slider. See `SpeedFxSetting`. */
  readonly speedFx: SpeedFxSetting
  /**
   * Cockpit or chase camera, on the flat build. DEV-128.
   *
   * 2016 persisted exactly this: `CamChanger.ChangeCam()` writes
   * `PlayerPrefs["PlayerCameraPref"]` on every CHANGE VIEW and reads it back
   * on the next launch, so a player who flew third person yesterday flies
   * third person today. Stored here for the reason every other field is — one
   * owner, one save. Ignored while an XR session is presenting: a rig placed
   * behind the ship is a comfort feature of its own, and the toggle refuses.
   */
  readonly cameraView: CameraViewSetting
  /**
   * The flat screen's race strip: position, gates, time and score in the top
   * corners (DEV-649, `render/race-strip.ts`). ON by default (Matt: "go with
   * your recs"); the Edition page's RACE STRIP row hides it. Flat only: a
   * headset never draws it whatever this says, because the dash is its HUD.
   */
  readonly raceStrip: boolean
}

/** `first` is the seat; `third` is CHANGE VIEW. Two values, as 2016's `camTargets` has two. */
export const CAMERA_VIEWS = ['first', 'third'] as const
export type CameraViewSetting = (typeof CAMERA_VIEWS)[number]

/**
 * What a first-time visitor gets.
 *
 * `vignette: 'light'` is PORT_PLAN §2.9's stated default and the only one of
 * these five the plan names. The rest follow from R12's framing — *"a dropped
 * frame during a fast roll is nauseogenic in a way it was not on a tethered
 * Rift"* — so the defaults are the ones that protect the frame: full base
 * resolution, allowed to fall back under load, with foveation on.
 */
export const DEFAULT_SETTINGS: ComfortSettings = {
  vignette: 'light',
  horizon: false,
  quality: 'high',
  // DEV-334: nobody has picked a tier yet, so a headset starts at Medium.
  qualityAuto: true,
  adaptiveResolution: true,
  foveation: true,
  // DEV-269: nothing forced either way until the player says so.
  featureOverrides: {},
  // `full` is 1.0, which is exactly the 2016 authored product — `cueGain`
  // already carries `_masterAudioVolume` — so a first-time visitor hears the
  // mix as it was tuned and the ladder only ever attenuates from there.
  volume: 'full',
  // Never ship muted. The first thing this game does is put you in a lift, and
  // the sound is most of what says the lift is moving.
  muted: false,
  // The shipped HoverJet prefab's value, and the arcade direction: push the
  // stick forward and dive.
  invertPitch: false,
  // DEV-637: rumble on. A player with no pad never meets it; one with a pad
  // expects a game to answer.
  haptics: true,
  // ANNIVERSARY: Matt's call, 2026-09-13, on seeing the same-tick A/B frames
  // ("plz make the default the anniversary version, not classic"). A first-time
  // visitor gets the curated preset; `classic` is one press away on the
  // Edition page, and `?edition=classic` pins it for a load. This is the ONE
  // word that decides it — DEV-078 is the row.
  edition: 'anniversary',
  // DEV-896: nobody has picked a look yet, so a headset starts on Classic.
  editionAuto: true,
  // LIGHT, the same reasoning as the vignette's default: a real reduction from
  // what a monitor gets, for the person who has not yet found the menu.
  speedFx: 'light',
  // The seat. `CamChanger.startInThirdPerson` is `= true` in C# and **0** on
  // both shipped prefabs (`hoverjet.camera.startInThirdPerson` on the sheet):
  // the initialiser is not shipped behaviour, and 2016 boots in the cockpit.
  cameraView: 'first',
  // ON: Matt's call, 2026-10-05 (DEV-649). The strip is the flat build's race
  // readout, and the row to hide it is on the Edition page.
  raceStrip: true,
}

/**
 * Namespaced and versioned, exactly as `bestKey` is.
 *
 * Bump the suffix if the MEANING of a field changes — a stored `quality: 'high'`
 * that now means something else is worse than no stored value, because the
 * player will not know to go and look.
 *
 * **Adding a field is not a meaning change and does not bump it.** `volume` and
 * `muted` arrived after this key shipped, and a stored v1 object without them
 * loads with the rest of the player's choices intact and those two at their
 * defaults — which is what the per-field validation below is for. Bumping would
 * have thrown away a deliberately chosen vignette to introduce a volume
 * control, which is the exact trade that validation exists to refuse.
 */
export const SETTINGS_KEY = 'ff2.comfort.v1'

const VIGNETTES: readonly VignetteSetting[] = ['off', 'light', 'strong']
/**
 * Every tier, in rising order. Exported because the order IS the ladder: a
 * reader asking "at least `medium`?" compares indices here rather than keeping
 * its own list that would not know `ultra` exists (DEV-581: the life gate did).
 */
export const QUALITIES: readonly QualitySetting[] = ['low', 'medium', 'high', 'ultra']
const SPEED_FX: readonly SpeedFxSetting[] = ['off', 'light', 'full']

/** The next value in a cycle, wrapping. The menu's only verb for a 3-way row. */
export const cycle = <T>(values: readonly T[], current: T): T => {
  const i = values.indexOf(current)
  // An unknown current value cycles to the FIRST entry rather than staying put:
  // a row that does nothing when you press A reads as a broken menu.
  return values[(i + 1) % values.length] ?? (values[0] as T)
}

export const nextVignette = (v: VignetteSetting): VignetteSetting => cycle(VIGNETTES, v)
export const nextQuality = (q: QualitySetting): QualitySetting => cycle(QUALITIES, q)

/**
 * The tiers the quality row offers on this surface. DEV-581: `ultra` is a flat
 * screen's tier, and a headset is never offered it (it would resolve to `high`
 * there anyway, so offering it would be a press that changes nothing).
 */
export const qualitiesOffered = (presenting: boolean): readonly QualitySetting[] =>
  presenting ? QUALITIES.filter((q) => q !== 'ultra') : QUALITIES

/**
 * The tier a headset gets for the flat-only `ultra`. DEV-581. `high`'s exact
 * spec, so a player who chose ultra on the monitor and then puts the headset
 * on flies what `high` flew before ultra existed.
 */
export const ULTRA_IN_HEADSET: QualitySetting = 'high'

/**
 * The tier a headset session gets while the player has picked none. DEV-334.
 *
 * Medium, from the worn comparison in `docs/perf-baseline.md`: at `high`'s
 * 2160 px an eye the 2016 scatter holds 90 Hz on 1–18 % of frames, at `medium`
 * (0.75, 1620 px) on 24–97 %. NEVER `low`: the multisampling context
 * attribute, the shadow map and the detail ring all read the FLAT tier
 * (`quality`), and `low` is the one tier that turns all three off, so an auto
 * headset at `low` would get the monitor's answers to those three.
 * `comfort-settings.test.ts` holds that.
 */
export const VR_AUTO_QUALITY: QualitySetting = 'medium'

/**
 * The LOOK a headset session gets while the player has picked none. DEV-896 (Matt,
 * 2026-10-10, after wearing 0.28.0: *"default to classic & medium for quality
 * settings"*). The quality half is {@link VR_AUTO_QUALITY}. A look only: every race
 * still flies Anniversary's rules (D35).
 */
export const VR_AUTO_EDITION: EditionId = 'classic'

/**
 * The look in force: the player's, or on AUTO the surface's own default. DEV-896.
 * AUTO holds only while `edition` is still the untouched default, as
 * {@link qualityInForce} does for the tier, so an object that names `classic` and says
 * nothing else gets Classic everywhere.
 */
export const editionInForce = (
  s: Pick<ComfortSettings, 'edition' | 'editionAuto'>,
  presenting: boolean,
): EditionId =>
  s.editionAuto === true && s.edition === DEFAULT_SETTINGS.edition && presenting
    ? VR_AUTO_EDITION
    : s.edition

/**
 * The look row's press: the next look from the one IN FORCE, and the choice is the
 * player's from here on (`editionAuto` false), so Anniversary pressed in a headset
 * stays Anniversary. DEV-896.
 */
export const nextEditionChoice = (
  s: Pick<ComfortSettings, 'edition' | 'editionAuto'>,
  presenting: boolean,
): { edition: EditionId; editionAuto: boolean } => ({
  edition: nextEdition(editionInForce(s, presenting)),
  editionAuto: false,
})

/**
 * The tier in force: the player's, or on AUTO the surface's own default. DEV-334.
 *
 * AUTO holds only while `quality` is still the untouched default. Any other
 * tier is a choice whatever the flag says, so code that sets `quality` and
 * forgets the flag (`{ ...DEFAULT_SETTINGS, quality: 'low' }`, which is how
 * half the tests spell "the player picked Low") gets the tier it named in a
 * headset too, instead of AUTO quietly trading it for Medium.
 */
export const qualityInForce = (
  s: Pick<ComfortSettings, 'quality' | 'qualityAuto'>,
  presenting: boolean,
): QualitySetting =>
  s.qualityAuto === true && s.quality === DEFAULT_SETTINGS.quality && presenting
    ? VR_AUTO_QUALITY
    : // DEV-581: the one place `ultra` resolves. Everything that asks for the
      // tier in force (the XR framebuffer scale, the report, the getter the
      // ultra features read) gets `high` while presenting.
      presenting && s.quality === 'ultra'
      ? ULTRA_IN_HEADSET
      : s.quality

/**
 * The quality row's press. DEV-334, and DEV-581 for the fourth tier:
 * on a monitor Auto → Low → Medium → High → Ultra → Auto, and in a headset
 * Auto → Low → Medium → High → Auto, because a headset is not offered `ultra`.
 *
 * `presenting` is REQUIRED, not defaulted: a caller that forgot it would offer
 * the headset a tier it cannot have, and the type is where that is caught.
 *
 * Auto keeps `quality` at the monitor's default, so leaving Auto starts from
 * Low and returning to it restores High for the monitor. A stored `ultra` met
 * in a headset (picked on the monitor) steps as `high` does, to Auto.
 */
export const nextQualityChoice = (
  s: Pick<ComfortSettings, 'quality' | 'qualityAuto'>,
  presenting: boolean,
): { quality: QualitySetting; qualityAuto: boolean } => {
  const offered = qualitiesOffered(presenting)
  const first = offered[0] ?? 'low'
  if (s.qualityAuto === true) return { quality: first, qualityAuto: false }
  const i = offered.indexOf(s.quality)
  const next = i < 0 ? undefined : offered[i + 1]
  if (next === undefined) return { quality: DEFAULT_SETTINGS.quality, qualityAuto: true }
  return { quality: next, qualityAuto: false }
}
/**
 * The next volume DOWN. `VOLUME_STEPS` is ordered loudest-first, so the plain
 * cycle walks it quieter — see that array's note for why that is the direction
 * a press has to move.
 */
export const nextVolume = (v: VolumeSetting): VolumeSetting => cycle(VOLUME_STEPS, v)
export const nextSpeedFx = (s: SpeedFxSetting): SpeedFxSetting => cycle(SPEED_FX, s)
export const nextEdition = (e: EditionId): EditionId => cycle(EDITION_IDS, e)

const oneOf = <T extends string>(values: readonly T[], raw: unknown, fallback: T): T =>
  typeof raw === 'string' && (values as readonly string[]).includes(raw) ? (raw as T) : fallback

// `typeof raw === 'boolean'`, not `Boolean(raw)`. Coercion accepts everything:
// a hand-edited `"horizon": "false"` is a truthy string and would come back as
// ON, which is the one wrong answer that also looks like a feature.
const bool = (raw: unknown, fallback: boolean): boolean =>
  typeof raw === 'boolean' ? raw : fallback

/**
 * Coerce anything at all into a usable settings object.
 *
 * Exported because it is the whole of the validation and it is testable without
 * a storage backend — hand it `null`, `42`, `{vignette: 'ultra'}`.
 */
/**
 * A `{path: boolean}` map out of anything at all. DEV-269.
 *
 * Keeps every string key whose value is a real boolean and drops the rest — a
 * hand-edited `"render.bloom": "false"` must not read as `true`, which is what
 * a bare cast would do to it.
 *
 * It does NOT check the paths against `editionFeatures()`, and that asymmetry
 * with `validateEdition` is the point: the edition files are ours and a typo in
 * one has to be refused, but this comes from storage that outlives the build,
 * so an unknown path is carried and ignored rather than thrown away.
 */
const featureMap = (v: unknown): Readonly<Record<string, boolean>> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return {}
  const out: Record<string, boolean> = {}
  for (const [k, value] of Object.entries(v as Record<string, unknown>)) {
    if (typeof value === 'boolean') out[k] = value
  }
  return out
}

export const parseSettings = (raw: unknown): ComfortSettings => {
  const v = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<
    Record<keyof ComfortSettings, unknown>
  >
  return {
    vignette: oneOf(VIGNETTES, v.vignette, DEFAULT_SETTINGS.vignette),
    horizon: bool(v.horizon, DEFAULT_SETTINGS.horizon),
    quality: oneOf(QUALITIES, v.quality, DEFAULT_SETTINGS.quality),
    // DEV-334. Settings stored before the field existed carry no answer, and
    // a stored `high` cannot be told from the untouched default, so it reads
    // as AUTO; a stored `low` or `medium` was somebody's choice and is kept.
    qualityAuto:
      typeof v.qualityAuto === 'boolean'
        ? v.qualityAuto
        : oneOf(QUALITIES, v.quality, DEFAULT_SETTINGS.quality) === DEFAULT_SETTINGS.quality,
    adaptiveResolution: bool(v.adaptiveResolution, DEFAULT_SETTINGS.adaptiveResolution),
    foveation: bool(v.foveation, DEFAULT_SETTINGS.foveation),
    featureOverrides: featureMap(v.featureOverrides),
    volume: oneOf(VOLUME_STEPS, v.volume, DEFAULT_SETTINGS.volume),
    // A hand-edited `"muted": "true"` must not come back as silence: a game
    // that is mute for a reason nothing in the menu explains is a game with no
    // sound, and the player has no way to find out why.
    muted: bool(v.muted, DEFAULT_SETTINGS.muted),
    invertPitch: bool(v.invertPitch, DEFAULT_SETTINGS.invertPitch),
    haptics: bool(v.haptics, DEFAULT_SETTINGS.haptics),
    edition: oneOf(EDITION_IDS, v.edition, DEFAULT_SETTINGS.edition),
    // DEV-896. As `qualityAuto`: a stored default look cannot be told from the untouched
    // one, so it reads as AUTO; a stored `classic` was somebody's choice and is kept.
    editionAuto:
      typeof v.editionAuto === 'boolean'
        ? v.editionAuto
        : oneOf(EDITION_IDS, v.edition, DEFAULT_SETTINGS.edition) === DEFAULT_SETTINGS.edition,
    speedFx: oneOf(SPEED_FX, v.speedFx, DEFAULT_SETTINGS.speedFx),
    cameraView: oneOf(CAMERA_VIEWS, v.cameraView, DEFAULT_SETTINGS.cameraView),
    raceStrip: bool(v.raceStrip, DEFAULT_SETTINGS.raceStrip),
  }
}

/**
 * The stored settings, or the defaults.
 *
 * Never throws and never returns null: a caller that has to handle "no storage"
 * separately will forget to, and the correct behaviour in that case is
 * identical to a first visit.
 *
 * `storage` is injectable for the same reason `readBest`'s is — the case that
 * matters is a store that THROWS, and no jsdom mock reproduces that by
 * accident.
 */
export const loadSettings = (
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage(),
): ComfortSettings => {
  // `undefined`: nothing stored, storage blocked, or a key edited into
  // something that is not JSON. A stored JSON `null` is still a stored value.
  const stored = readJsonKey(storage, SETTINGS_KEY)
  return stored === undefined ? DEFAULT_SETTINGS : parseSettings(stored)
}

/**
 * Write the settings back. Returns whether they actually landed.
 *
 * The return value is not decoration: the menu can say "not saved on this
 * browser" instead of silently forgetting, and the test can tell a real write
 * from a swallowed exception. A failed save must never take the menu down —
 * quota, a private window, a webview with storage off are all ordinary.
 */
export const saveSettings = (
  settings: ComfortSettings,
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage(),
): boolean => {
  return writeJsonKey(storage, SETTINGS_KEY, settings)
}
