// src/render/options-menu.ts: the OPTIONS page, and MORE under it. DEV-621, DEV-859.
//
// Matt, 2026-10-04: *"pause - group into pages: resume, restart, options,
// exit. options should take you to a panel with mute, controls, comfort,
// edition, credits, report bug (new option), back"*.
//
// Why pages: DEV-614's CREDITS made the root plate nine rows in a headset,
// 3.55 degrees each, under the 4.00-degree floor this project accepted. Pages
// put the ceiling back at eight rows (exactly 4.00 degrees): the root holds the
// decisions about the RUN (resume, restart, exit, and the display: enter or
// exit VR), and OPTIONS holds everything that is a setting or a thing to read.
//
// ── DEV-859: one page, the same wherever it opens ───────────────────────
//
// `docs/plan/UX-PASS-2026-10-08.md`, decision 1 (Matt: yes, with CONTROLS kept
// as a list because a picture of a device is hard across the variety of
// devices). The first page now holds what a player changes, as rows that show
// their value and change in place: MUTE, VOLUME, INVERT PITCH and LOOK
// (EDITION's old name, D35: Classic is a look). Under them, three doors:
// COMFORT (vignette, horizon, speed FX, recentre), CONTROLS (the bindings) and
// MORE (quality, race strip, effects, credits, report bug). A row's note
// shows only while it is selected (`PauseState.notesOnSelect`), so the page
// reads as eight words and a value, not as sixteen lines.
//
// The page is a `PausePageSource` like comfort and controls, so `pausePage`
// turns the plate to it with no new machinery, and `app.ts` opens it with ONE
// call (`menus.options`): the pause plate today, and the title and the hangar's
// OPTIONS table call the same entry point, so there is one page and not a copy
// per place. Settings keys are untouched; only labels moved.

import { type ComfortSettings, editionInForce } from '@/boot/settings'
import { muteOption, qualityRow } from '@/render/comfort-menu'
import type { PauseOption } from '@/render/pause'

/** 2016's punctuation, as the pause title and the other pages have it. */
export const OPTIONS_TITLE = '- OPTIONS -'

/** The page under OPTIONS that holds the rarely-touched rows. */
export const MORE_TITLE = '- MORE -'

/** The row on the ROOT pause plate (and the title's) that opens OPTIONS. */
export const OPTIONS_OPTION: PauseOption = {
  id: 'options',
  label: 'Options',
  note: 'sound, pitch, look, comfort, controls',
}

/** The OPTIONS row that opens MORE (the former ADVANCED page's place). */
export const MORE_OPTION: PauseOption = {
  id: 'more',
  label: 'More',
  note: 'quality, race strip, effects, credits, report bug',
}

/** REPORT BUG, DEV-622: opens `report-bug-menu.ts`'s page. */
export const REPORT_BUG_OPTION: PauseOption = {
  id: 'reportbug',
  label: 'Report bug',
  note: 'send what the game knows, nothing typed',
}

/** BACK, a hub page's last row: one page up. */
export const OPTIONS_BACK: PauseOption = { id: 'back', label: 'Back', note: 'to the pause menu' }

/** BACK on MORE: to OPTIONS. */
export const MORE_BACK: PauseOption = { id: 'back', label: 'Back', note: 'to the options' }

/**
 * The hub pages: pages whose rows the app acts on BY ID (a setting changes in
 * place, a door opens a page, BACK goes up), as opposed to a page with its own
 * `activate`. The plate's A press asks this to decide which of the two it is.
 */
export const HUB_PAGE_IDS: ReadonlySet<string> = new Set([OPTIONS_OPTION.id, MORE_OPTION.id])

/**
 * VOLUME, DEV-859: up from COMFORT, because it is the most-changed setting.
 * The note carries the mute state as well as the value column does, because
 * this is the row somebody presses when they cannot hear anything, and
 * "muted" with no explanation of where the sound went is the same dead end as
 * no control at all.
 */
export const volumeRow = (s: ComfortSettings): PauseOption => ({
  id: 'volume',
  label: 'Volume',
  note: s.muted ? `muted: press to restore ${s.volume}` : 'all sound; mute is the row above',
  // Words, never a percentage: 0.5 is -6 dB, which is about two-thirds as
  // loud, so "50 %" would be an amplitude masquerading as a loudness. See
  // `audio/volume.ts`.
  value: s.muted ? 'muted' : s.volume,
})

/**
 * INVERT PITCH, DEV-859: promoted from CONTROLS (which keeps it too, with the
 * device's own words). The note here is device-free on purpose: this page is
 * the same on a keyboard, a pad and a headset.
 */
export const invertRow = (s: ComfortSettings): PauseOption => ({
  id: 'invert',
  label: 'Invert pitch',
  note: s.invertPitch ? 'on: push the stick forward to climb' : 'off: pull the stick back to climb',
  value: s.invertPitch ? 'on' : 'off',
})

/**
 * LOOK, DEV-859: EDITION's old row, renamed and toggling in place. The id stays
 * `edition` (the setting's name; renames are labels only). Says what the two
 * words mean, because a stranger with a headset and a link has no other way to
 * find out which one is the 2016 game, and, since DEV-452 (D35), that it is the
 * LOOK: every race is Anniversary's.
 */
export const lookRow = (s: ComfortSettings, presenting = false): PauseOption => ({
  id: 'edition',
  label: 'Look',
  note:
    editionInForce(s, presenting) === 'classic'
      ? '2016’s look in flight; same race. Press for the anniversary look'
      : 'the anniversary look in flight. Press for 2016’s; same race',
  value: editionInForce(s, presenting),
})

/**
 * RACE STRIP, DEV-649, moved to MORE by DEV-859. Says where it is AND where it
 * is not, because a player in a headset who finds this row would otherwise
 * press it and see nothing change.
 */
export const raceStripRow = (s: ComfortSettings): PauseOption => ({
  id: 'racestrip',
  label: 'Race strip',
  note: 'position, gates, time and score in the corners of a flat screen; a headset has the dash',
  value: s.raceStrip ? 'on' : 'off',
})

/** What the OPTIONS page needs to be built: the live settings and the door rows. */
export interface OptionsRowsInput {
  readonly settings: ComfortSettings
  /** Is a headset presenting (DEV-896: the look row shows the look in force)? */
  readonly presenting?: boolean
  readonly comfort: PauseOption
  readonly controls: PauseOption
  /** Rows only a developer sees (PERF CAPTURE and the like), above BACK. */
  readonly dev?: readonly PauseOption[]
  /** What BACK's note says it goes to: the pause menu (the default), the title, the hangar. */
  readonly backNote?: string | undefined
}

/**
 * The OPTIONS page, in Matt's order: the four settings that show a value and
 * change in place, then the three doors, then BACK. Eight rows, which is
 * 4.00 degrees each in a headset: the floor the tests hold.
 */
export const optionsRows = (input: OptionsRowsInput): readonly PauseOption[] => [
  muteOption(input.settings),
  volumeRow(input.settings),
  invertRow(input.settings),
  lookRow(input.settings, input.presenting ?? false),
  input.comfort,
  input.controls,
  MORE_OPTION,
  ...(input.dev ?? []),
  input.backNote === undefined ? OPTIONS_BACK : { ...OPTIONS_BACK, note: input.backNote },
]

/** What the MORE page needs: the settings, the quality pin and the door rows. */
export interface MoreRowsInput {
  readonly settings: ComfortSettings
  /** A `?quality=` pin still in force this load, or null (DEV-334). */
  readonly qualityPin: Parameters<typeof qualityRow>[1]
  /** Is a headset presenting (DEV-581)? */
  readonly presenting: boolean
  /** The Effects page's door (the former ADVANCED page). */
  readonly effects: PauseOption
  readonly credits: PauseOption
}

/**
 * MORE: quality and the race strip in place, then the four doors the old
 * OPTIONS page had at its foot (effects, credits, report bug) and BACK.
 */
export const moreRows = (input: MoreRowsInput): readonly PauseOption[] => [
  qualityRow(input.settings, input.qualityPin, input.presenting),
  raceStripRow(input.settings),
  input.effects,
  input.credits,
  REPORT_BUG_OPTION,
  MORE_BACK,
]

export interface OptionsMenu {
  readonly open: boolean
  readonly title: string
  readonly rows: readonly PauseOption[]
  openPage(): void
  closePage(): void
}

/** `rows` is a getter: the values move with the settings. `title` defaults to OPTIONS'. */
export const createOptionsMenu = (
  rows: () => readonly PauseOption[],
  title: string = OPTIONS_TITLE,
): OptionsMenu => {
  let open = false
  return {
    get open() {
      return open
    },
    get title() {
      return title
    },
    get rows() {
      return rows()
    },
    openPage() {
      open = true
    },
    closePage() {
      open = false
    },
  }
}
