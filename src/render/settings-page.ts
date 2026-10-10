// src/render/settings-page.ts: the state machine every settings page of the
// pause plate runs, written once.
//
// COMFORT, CONTROLS, EDITION and ADVANCED each had their own copy of the same
// thirty lines: a held `ComfortSettings`, an `open` flag, getters for `rows` and
// `title`, `openPage` / `closePage`, an `activate` that commits a change and
// closes on `'back'`, and a silent `sync`. Each copy carried a comment pointing
// back at comfort's, which is the copy acknowledging itself. What differs is
// handed in here: the title, how the rows are built, and what a press does.
// Rows and press stay pure functions in each page's own file; this module holds
// no drawing and no row, so no pixel and no pick can move with it.
//
// ── The three rules that are load-bearing ───────────────────────────────────
//
// 1. A change is LIVE first, then STORED, then ANNOUNCED. Persisted on the
//    PRESS, not on leaving the menu: someone who takes the headset off because
//    they feel ill never closes the menu politely, and the setting they just
//    found is the one thing that must not be lost. `saveSettings` swallows a
//    blocked store and returns false; the page does not care, because the live
//    setting has already changed.
// 2. `sync` is SILENT: no save, no notify. The change it mirrors was saved and
//    applied by whoever made it, and re-notifying would put two pages in a loop.
//    (Several pages sit on one `ComfortSettings`; each is told when another
//    moves it, or the next press writes back a whole object carrying the
//    other's stale field.)
// 3. `activate` reads `rows` and `settings` through the SAME closures the page
//    draws with. A page whose rows depend on context (the controls page names
//    hardware) closes over that context here, so a press never maps a row index
//    to the id of a different row.

import { type ComfortSettings, saveSettings } from '@/boot/settings'
import type { PauseOption } from '@/render/pause'

/** What pressing a row of a settings page came to. */
export interface SettingsActivation<A extends string> {
  readonly settings: ComfortSettings
  readonly action: A
  readonly changed: boolean
}

/** What differs between one settings page and the next. */
export interface SettingsPageSpec<A extends string> {
  readonly title: string
  /** The rows as drawn, for these settings. Called on every read of `rows`. */
  readonly rows: (settings: ComfortSettings) => readonly PauseOption[]
  /** The press on row `index`. Pure: the page does the committing. */
  readonly activate: (settings: ComfortSettings, index: number) => SettingsActivation<A>
}

export interface SettingsPageOptions {
  readonly settings: ComfortSettings
  /** Called on every change, with the new settings. */
  readonly onChange: (settings: ComfortSettings) => void
  /** Injectable so the tests can watch the write, and hand in a store that throws. */
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'> | null
}

export interface SettingsPage<A extends string> {
  readonly open: boolean
  readonly settings: ComfortSettings
  /** Feed straight to `pause.update({ options })`, and to `pause.pick(...)`. */
  readonly rows: readonly PauseOption[]
  readonly title: string
  openPage(): void
  closePage(): void
  /** Press A on row `index`. Persists and re-applies a change; `'back'` closes the page. */
  activate(index: number): A
  /** Replace the held settings WITHOUT saving or notifying (rule 2 above). */
  sync(settings: ComfortSettings): void
}

/**
 * The handle a page's extras get: the one path a change takes, and the settings
 * as they stand now. `comfort`'s MUTE press is the one extra that commits.
 */
export interface SettingsPageHandle {
  readonly settings: ComfortSettings
  commit(next: ComfortSettings): void
}

/**
 * Build a settings page. `extras` adds the page's own members (comfort's
 * `toggleMute`, controls' `setXr`); they are assigned onto the page, so the
 * page's getters stay getters.
 */
export const createSettingsPage = <A extends string, E extends object = Record<never, never>>(
  options: SettingsPageOptions,
  spec: SettingsPageSpec<A>,
  extras?: (handle: SettingsPageHandle) => E,
): SettingsPage<A> & E => {
  let settings = options.settings
  let open = false

  /** The one path a change takes (rule 1). */
  const commit = (next: ComfortSettings): void => {
    settings = next
    saveSettings(settings, options.storage)
    options.onChange(settings)
  }

  const page: SettingsPage<A> = {
    get open() {
      return open
    },
    get settings() {
      return settings
    },
    get rows() {
      return spec.rows(settings)
    },
    get title() {
      return spec.title
    },
    openPage() {
      open = true
    },
    closePage() {
      open = false
    },
    activate(index) {
      const result = spec.activate(settings, index)
      if (result.changed) commit(result.settings)
      if (result.action === 'back') open = false
      return result.action
    },
    sync(next) {
      settings = next
    },
  }
  const handle: SettingsPageHandle = {
    get settings() {
      return settings
    },
    commit,
  }
  return Object.assign(page, extras?.(handle)) as SettingsPage<A> & E
}
