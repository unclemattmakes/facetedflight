// src/render/comfort-menu.ts — the comfort settings as a page of the pause menu.
//
// PORT_PLAN §2.9 item 5: *"A comfort menu, reachable from pause, with all of the
// above plus the existing recenter."* The requirement behind the sentence is the
// one that decides the design: **a comfort setting you cannot change in the
// headset is not a comfort setting.** Someone who is starting to feel ill has to
// be able to turn the vignette up without taking the headset off, finding a
// keyboard, and losing the run — and the moment they are least able to do that
// is exactly the moment they need to.
//
// ── Why this is a model and not a panel ──────────────────────────────────
//
// It draws nothing. `pause.ts` already owns a world-space panel, a gaze hit test
// and the geometry that ties them together, and it grew a variable row count so
// this page could reuse all three — one plate, one pick, one place for the
// "what you look at and what you hit must not drift apart" bug to live. So this
// file's whole job is: settings in, rows out; index in, new settings out.
//
// That also makes it node-testable with no DOM and no renderer, which matters
// more here than usual. Nothing automated can test whether the vignette FEELS
// better (`docs/vr-testing.md`, "Known gaps, honestly": *"Nothing here tests
// comfort. By construction."*). What can be tested is that the menu reaches
// every setting, that pressing A moves it on rather than off, and that the
// change survives a reload — and all three of those live in this file.
//
// ── The row order is the order of the argument ───────────────────────────
//
// Vignette first because it is the one §2.9 defaults ON and the one most likely
// to be reached for mid-flight. Horizon second because it is the other
// nauseogenic-pattern mitigation. Volume third: it is a thing the player FEELS
// rather than a thing that protects the frame, so it belongs with those two and
// not with the three below it. Then the three performance rows, which matter for
// comfort only through the frame rate. Then recenter, which is an action and not
// a setting, then back.
//
// ── Volume is here; MUTE is one level up, on the pause plate ─────────────
//
// Deliberately not together. The comfort page is two presses and a page-load
// away — pause, look at Comfort, press A, look at the row, press A — and mute
// is the one audio control that has to be reachable by somebody who wants the
// sound to stop NOW. As a row on the pause plate itself it is pause, look,
// press. `muteOption()` renders it and `toggleMute()` takes the press; the
// state is one boolean on the same `ComfortSettings`, so there is still one
// owner and one save.
//
// **It costs the comfort page a degree of row height** and that is the price,
// stated rather than discovered: `pause.ts` caps the rows at `ROWS_MAX_M`, so
// eight rows are 0.06 m each instead of seven at 0.0686 — about **4.0 degrees
// instead of 4.6** at the panel's 0.86 m. That is the trade `pause.ts`'s own
// header describes being made once already, made once more, and it is why
// mute did NOT also become a row here: nine rows is 3.6 degrees, and that file
// is explicit that a head "cannot reliably hold 3". The pause plate itself goes
// from four rows to five and does not shrink at all — five rows is exactly
// where `ROWS_MAX_M` starts to bite.
//
// ── How `boot/app.ts` wires the comfort block ────────────────────────────
//
// Written here rather than in a handover note because a handover note is read
// once. Seven call sites, none of them more than a couple of lines.
//
//  1. BOOT, at `const render = createRenderer(canvas)`:
//
//       let comfort = loadSettings()                   // '@/boot/settings'
//       const render = createRenderer(canvas, comfort) // sets the XR framebuffer
//                                                      // scale for the FIRST session
//
//  2. ONCE, after the scene exists — both go in the SCENE ROOT. The horizon
//     must not be parented to the ship (that is the bug `comfort-horizon.test.ts`
//     proves the measurement catches) and the vignette must not be parented to
//     the camera (it is written straight into clip space and has no transform):
//
//       const vignette = createVignette({ setting: comfort.vignette })
//       const horizon = createHorizon()
//       render.scene.add(vignette.object, horizon.object)
//
//  3. WHERE `loadFlight` DISPATCHES ON `level.vehicle`. Full stick on the
//     JumpSeat is 25.6 °/s, which is inside the HoverJet's own deadband — share
//     one calibration and the seat never vignettes at all:
//
//       vignette.setFullRate(level.vehicle === 'jumpseat'
//         ? JUMPSEAT_FULL_ROLL_RATE : HOVERJET_FULL_ROLL_RATE)
//
//  3b. THE AUDIO, at boot, BEFORE the first `resume()` and therefore before
//     anything can make a noise — `setMasterGain` is safe with no context and
//     the backend carries the value onto the master node when one appears:
//
//       audio.setMasterGain(masterGainFor(comfort))   // '@/audio'
//       audio.setMusicGain(musicGainFor(comfort))
//
//     A volume applied after the first cue is a volume the player hears the
//     game ignore.
//
//  4. THE MENU, once. The single `onChange` is what stops a row added later
//     from forgetting one of the four consumers:
//
//       const menu = createComfortMenu({ settings: comfort, onChange: (s) => {
//         comfort = s
//         vignette.setSetting(s.vignette)
//         render.quality.apply(s)
//         audio.setMasterGain(masterGainFor(s))
//         audio.setMusicGain(musicGainFor(s))
//       }})
//
//  5. The pause rows gain `COMFORT_OPTION` and `muteOption(comfort)` (both
//     before `exit`, so RESUME stays row 0 and EXIT stays last). Five rows, and
//     nothing on the plate shrinks — five is exactly where `ROWS_MAX_M` starts
//     to bite. The mute row shows its own state, so the plate is built by a
//     FUNCTION rather than held as a const:
//
//       const pauseOptions = (): readonly PauseOption[] =>
//         [RESUME, RESTART, muteOption(comfort), COMFORT_OPTION, EXIT]
//
//     ...and its press is `else if (chosen === 'mute') menu.toggleMute()`,
//     which persists and notifies down the same one path every other row uses.
//
//  6. THE PAUSE BLOCK. One local decides which page is up, and BOTH the hit test
//     and the paint must be given the same list — `pause.ts` derives its layout
//     from the count it is handed:
//
//       const rows = menu.open ? menu.rows : PAUSE_OPTIONS
//       // ...the nudge clamp, `pause.pick(..., rows.length)` and
//       // `pause.update({ options: rows, ..., title: menu.open ? menu.title : … })`
//
//     ...and the confirm branch, where `paused` is true:
//
//       if (menu.open) {
//         const action = menu.activate(pauseAim)
//         if (action === 'recenter') recenterXr(render.renderer, xrFrame)
//         if (action === 'back') pauseAim = 0
//       } else if (chosen === 'comfort') { menu.openPage(); pauseAim = 0 }
//
//     Un-pausing calls `menu.closePage()`, so the next pause opens on RESUME.
//
//  7. EVERY FRAME, beside the other render-time updates:
//
//       render.quality.frame(frameSeconds)
//       render.camera.getWorldPosition(cameraWorld)   // WORLD, never `.position`
//       horizon.setVisible(comfort.horizon && screen === 'mission')
//       horizon.update(cameraWorld)
//       vignette.update(flight && !paused && screen === 'mission' ? flight.jet.body : null,
//                       frameSeconds)
//
//     `flight.jet.body` IS a `VignetteInput` — `angularVelocity` and
//     `orientation`, straight off the integrator. The `!paused` is load-bearing:
//     see `Vignette.update`.
//
// And in `src/main.ts`'s Enter VR handler, before `requestSession`:
// `app.render.quality.applyBeforeSession()`. Only matters for a SECOND session
// after a mid-session quality change — three reads the framebuffer scale when it
// builds the layer and refuses it afterwards — but that is the case a player who
// just turned the quality down in the menu is in.

import {
  type ComfortSettings,
  nextEditionChoice,
  nextQualityChoice,
  nextSpeedFx,
  nextVignette,
  nextVolume,
  type QualitySetting,
  qualityInForce,
} from '@/boot/settings'
import type { PauseOption } from '@/render/pause'
import { createSettingsPage, type SettingsPage } from '@/render/settings-page'

/**
 * Something the caller has to do that this module cannot: recentring needs the
 * live `XRFrame` and the renderer (`render/xr-recenter.ts`), and leaving the
 * page is the caller's own menu state.
 */
export type ComfortAction = 'none' | 'back' | 'recenter'

/** 2016's punctuation, because the pause title it sits under has it. */
export const COMFORT_TITLE = '- COMFORT -'

const onOff = (b: boolean) => (b ? 'on' : 'off')

/** The label the ROOT pause menu uses for the row that opens this page. */
export const COMFORT_OPTION: PauseOption = {
  id: 'comfort',
  label: 'Comfort',
  // DEV-859: VOLUME went up to OPTIONS and QUALITY into MORE; SPEED FX came in.
  note: 'vignette, horizon, speed effects, recentre',
}

/**
 * The MUTE row, for the ROOT pause plate. One press, from the plate itself.
 *
 * A function and not a const because it carries its own state in the value
 * column, and the reason is the same one the comfort rows have: *"a settings
 * menu that does not say what the setting currently is turns every press into
 * an experiment"*. A blind mute toggle on a plate is how somebody turns the
 * sound back ON at two in the morning.
 *
 * `value` is `on` when MUTED — "Mute: on" — which is the reading that matches
 * the label rather than the sound.
 */
export const muteOption = (s: ComfortSettings): PauseOption => ({
  id: 'mute',
  label: 'Mute',
  note: s.muted ? 'sound off; your level is remembered' : 'silence everything, in one press',
  value: onOff(s.muted),
})

/**
 * Row ids, in order. Exported so `app.ts` and the tests switch on a NAME and
 * never on an index — an index is a thing that silently means something else
 * the day a row is inserted.
 */
export const COMFORT_ROW_IDS = ['vignette', 'horizon', 'speedfx', 'recenter', 'back'] as const

export type ComfortRowId = (typeof COMFORT_ROW_IDS)[number]

/** The page, rendered against the settings that are live right now. */
export const comfortRows = (s: ComfortSettings): readonly PauseOption[] => [
  {
    id: 'vignette',
    label: 'Vignette',
    // Says what the SIGNAL is, because "vignette" alone does not tell anyone
    // whether it fires on speed or on turning, and the answer is the reason it
    // works.
    note: 'narrows the view when you turn hard',
    value: s.vignette,
  },
  {
    id: 'horizon',
    label: 'Horizon',
    note: 'a level line that does not roll with you',
    value: onOff(s.horizon),
  },
  {
    id: 'speedfx',
    label: 'Speed FX',
    // The note names the reason to turn it DOWN. This is the row somebody
    // presses while feeling ill, and "speed FX" does not say it is about that.
    // DEV-859: it came here from the old EDITION page, because it scales
    // vection (ART_DIRECTION), which makes it a comfort setting.
    note: 'how much the air moves past you; lower it if it turns your stomach',
    value: s.speedFx,
  },
  { id: 'recenter', label: 'Recentre', note: 'put your eyes back in the seat' },
  { id: 'back', label: 'Back', note: 'to the options' },
]

/**
 * The QUALITY row. DEV-859: it lives on the MORE page now (it was the comfort
 * page's fifth row), built here because the note's rules are the comfort
 * menu's and the press is `nextQualityChoice`.
 */
export const qualityRow = (
  s: ComfortSettings,
  qualityPin: QualitySetting | null = null,
  presenting = false,
): PauseOption =>
  ({
    id: 'quality',
    label: 'Quality',
    // Both halves of this tier land LATER than the press, and for different
    // reasons: the framebuffer scale is read when three builds the XR layer
    // (so it applies to the next session), and DEV-165's multisampling is a
    // WebGL context attribute (so it applies to the next LOAD). A row that
    // said "render resolution" and then appeared to do nothing is the same
    // dead end as the mute row above.
    //
    // DEV-334: the row shows the tier IN FORCE. A `?quality=` pin used to be
    // invisible here, so a URL that worked looked as if it had not and Matt
    // set the tier by hand; and AUTO is two tiers, one per surface, so it says
    // both rather than naming the monitor's.
    //
    // DEV-581: a chosen `ultra` is in force on a monitor only. In a headset the
    // value column shows `high`, the tier actually rendering, and the note
    // names both, so the row never claims a tier the headset is not getting.
    note:
      qualityPin !== null
        ? 'from the URL, this load only: press to choose'
        : s.qualityAuto === true
          ? 'high on a monitor, medium in a headset'
          : s.quality === 'ultra'
            ? presenting
              ? 'ultra is for a monitor; a headset renders high'
              : 'supersampled on a monitor; high in a headset'
            : 'resolution: the next session; edges, the next load',
    value:
      s.qualityAuto === true && qualityPin === null
        ? 'auto'
        : qualityInForce({ quality: qualityPin ?? s.quality, qualityAuto: false }, presenting),
  }) as PauseOption

export interface ComfortActivation {
  readonly settings: ComfortSettings
  readonly action: ComfortAction
  /** True when `settings` differs from what went in. */
  readonly changed: boolean
}

/**
 * Press A on row `index`. Pure: returns the new settings rather than storing
 * them, so the caller decides when a write to `localStorage` happens.
 *
 * An out-of-range index is a no-op rather than a throw — `app.ts` can be looking
 * at nothing (`selected === -1`), and a menu that crashes when you press A while
 * looking at the title is worse than one that does nothing.
 */
export const activateComfortRow = (settings: ComfortSettings, index: number): ComfortActivation => {
  const id = COMFORT_ROW_IDS[index]
  const still = { settings, action: 'none' as ComfortAction, changed: false }
  switch (id) {
    case 'vignette':
      return {
        settings: { ...settings, vignette: nextVignette(settings.vignette) },
        action: 'none',
        changed: true,
      }
    case 'horizon':
      return {
        settings: { ...settings, horizon: !settings.horizon },
        action: 'none',
        changed: true,
      }
    case 'speedfx':
      return {
        settings: { ...settings, speedFx: nextSpeedFx(settings.speedFx) },
        action: 'none',
        changed: true,
      }
    case 'recenter':
      return { ...still, action: 'recenter' }
    case 'back':
      return { ...still, action: 'back' }
    default:
      return still
  }
}

/**
 * DEV-859: the rows of OPTIONS and MORE that change a setting where they
 * stand. Pure: the new settings, or null when `id` is not one of them (the
 * caller then treats the row as a door or BACK).
 *
 * Here and not in `options-menu.ts` because that file imports this one (the
 * MUTE row), and the rules for QUALITY and the volume ladder are this file's.
 */
export const activateSettingRow = (
  settings: ComfortSettings,
  id: string,
  /** DEV-581: the quality row offers `ultra` only when this is false. */
  presenting = false,
): ComfortSettings | null => {
  switch (id) {
    case 'mute':
      return { ...settings, muted: !settings.muted }
    case 'volume':
      // **Muted, the press restores the sound and leaves the level alone.** A
      // volume row that walks the ladder while the output is zero is a control
      // with no feedback: you press it three times, hear nothing each time, and
      // conclude the game is broken. Unmuting at the level you chose is what
      // every remote control does, and it is the answer you can hear.
      return settings.muted
        ? { ...settings, muted: false }
        : { ...settings, volume: nextVolume(settings.volume) }
    case 'invert':
      return { ...settings, invertPitch: !settings.invertPitch }
    case 'edition':
      return { ...settings, ...nextEditionChoice(settings, presenting) }
    case 'quality':
      return { ...settings, ...nextQualityChoice(settings, presenting) }
    case 'racestrip':
      return { ...settings, raceStrip: !settings.raceStrip }
    default:
      return null
  }
}

// ── The little state machine `app.ts` actually holds ──────────────────────

/**
 * The page's state machine is `createSettingsPage`'s (open, rows, activate, and
 * the silent `sync` the controls and edition pages need when they move the same
 * object). `activate` returns what the caller still has to do: `'back'` means
 * the page closed, `'recenter'` means call `recenterXr`. `open` is true while the
 * comfort page is the one on the plate.
 */
export interface ComfortMenu extends SettingsPage<ComfortAction> {
  /**
   * Flip mute. The press on the PAUSE PLATE's own row — see `muteOption`.
   *
   * It lives on this object rather than on the caller so that it persists and
   * notifies down the one path every other setting uses. A mute that `app.ts`
   * flipped on its own copy would be a setting with two owners, and the one
   * that did not save is the one the player finds missing next time.
   */
  toggleMute(): void
  /**
   * DEV-859: press a row of OPTIONS or MORE that changes a setting in place
   * (mute, volume, invert pitch, look, quality, race strip), down the same one
   * path. False when `id` is no such row, so the caller can fall through.
   * The rule for each is `activateSettingRow`, above.
   */
  pressSetting(id: string): boolean
}

export interface ComfortMenuOptions {
  readonly settings: ComfortSettings
  /**
   * Called on every change, with the new settings. This is where the vignette,
   * the horizon and the quality controller get told — one callback, so a row
   * that is added later cannot forget to notify one of the three.
   */
  readonly onChange: (settings: ComfortSettings) => void
  /** Injectable so the tests can watch the write, and hand in a store that throws. */
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'> | null
  /**
   * Is a headset presenting right now? DEV-581: the quality row offers `ultra`
   * on a monitor only. Read live on every press, never cached. Absent means a
   * monitor.
   */
  readonly presenting?: () => boolean
}

export const createComfortMenu = (options: ComfortMenuOptions): ComfortMenu =>
  createSettingsPage(
    options,
    {
      title: COMFORT_TITLE,
      rows: comfortRows,
      activate: activateComfortRow,
    },
    // The mute press commits down the same path as every row (see `muteOption`).
    // `handle.settings` is a getter: read it at the press, never destructure it.
    (handle) => ({
      toggleMute() {
        handle.commit({ ...handle.settings, muted: !handle.settings.muted })
      },
      pressSetting(id: string) {
        const next = activateSettingRow(handle.settings, id, options.presenting?.() ?? false)
        if (next === null) return false
        handle.commit(next)
        return true
      },
    }),
  )
