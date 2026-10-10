// tests/unit/settings-page.test.ts: the one state machine under the comfort,
// controls and advanced pages (UI-8; the edition page went in DEV-859).
//
// Each page had its own copy of it. The oracle below IS the old copy (edition's, now run over comfort's rows,
// verbatim, kept here so the claim "the factory changed nothing" is a replay and
// not a belief), and the new page is replayed against it over seeded scripts of
// open / close / press / sync. The contract tests then pin the three rules the
// header of `render/settings-page.ts` calls load-bearing, on all three real pages.

import { describe, expect, it } from 'vitest'
import { type ComfortSettings, DEFAULT_SETTINGS, saveSettings } from '@/boot/settings'
import type { Edition } from '@/content/edition-schema'
import { createAdvancedMenu } from '@/render/advanced-menu'
import {
  activateComfortRow,
  COMFORT_TITLE,
  comfortRows,
  createComfortMenu,
} from '@/render/comfort-menu'
import { createControlsMenu } from '@/render/controls-menu'
import { createSettingsPage, type SettingsPage } from '@/render/settings-page'
import anniversaryJson from '../../content/editions/anniversary.json'

type Store = Pick<Storage, 'getItem' | 'setItem'>

const recordingStore = (log: string[], throws = false): Store => ({
  getItem: () => null,
  setItem: (k, v) => {
    if (throws) throw new Error('blocked')
    log.push(`${k}=${v}`)
  },
})

/** The old per-page state machine as it stood before the factory, verbatim (comfort's rows). */
const oldPageMenu = (options: {
  settings: ComfortSettings
  onChange: (s: ComfortSettings) => void
  storage?: Store | null
}) => {
  let settings = options.settings
  let open = false
  const commit = (next: ComfortSettings): void => {
    settings = next
    saveSettings(settings, options.storage)
    options.onChange(settings)
  }
  return {
    get open() {
      return open
    },
    get settings() {
      return settings
    },
    get rows() {
      return comfortRows(settings)
    },
    get title() {
      return COMFORT_TITLE
    },
    openPage() {
      open = true
    },
    closePage() {
      open = false
    },
    activate(index: number) {
      const result = activateComfortRow(settings, index)
      if (result.changed) commit(result.settings)
      if (result.action === 'back') open = false
      return result.action
    },
    sync(next: ComfortSettings) {
      settings = next
    },
  }
}

const prng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 4294967296
}

describe('createSettingsPage against the copy it replaced', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`replays 300 scripted frames identically (seed ${seed}, ${seed % 3 === 0 ? 'blocked' : 'working'} store)`, () => {
      const run = (make: typeof oldPageMenu) => {
        const rnd = prng(seed)
        const trace: unknown[] = []
        const writes: string[] = []
        const menu = make({
          settings: DEFAULT_SETTINGS,
          onChange: (s) => trace.push(['change', JSON.stringify(s), writes.length]),
          storage: recordingStore(writes, seed % 3 === 0),
        })
        for (let i = 0; i < 300; i++) {
          const r = rnd()
          let ret: unknown = null
          if (r < 0.15) menu.openPage()
          else if (r < 0.25) menu.closePage()
          else if (r < 0.75) ret = menu.activate(Math.floor(rnd() * (menu.rows.length + 2)) - 1)
          else if (r < 0.85)
            menu.sync({ ...menu.settings, invertPitch: !menu.settings.invertPitch })
          trace.push([
            ret,
            menu.open,
            menu.title,
            JSON.stringify(menu.rows),
            JSON.stringify(menu.settings),
          ])
        }
        return { trace, writes }
      }
      expect(run(createComfortMenu)).toEqual(run(oldPageMenu))
    })
  }
})

describe('the three rules, on every page that uses it', () => {
  const anniversary = anniversaryJson as unknown as Edition
  const NAMES = ['comfort', 'controls', 'advanced'] as const
  /** Row 0 of every page changes a setting. */
  const change = 0
  const pages = (
    name: (typeof NAMES)[number],
    onChange: (s: ComfortSettings) => void,
    storage: Store,
  ): SettingsPage<string> => {
    const base = { settings: DEFAULT_SETTINGS, onChange, storage }
    switch (name) {
      case 'comfort':
        return createComfortMenu(base)
      case 'controls':
        return createControlsMenu(base)
      case 'advanced':
        return createAdvancedMenu({
          ...base,
          live: () => anniversary,
          presenting: () => false,
        })
    }
  }

  for (const name of NAMES) {
    it(`${name}: a change is live, then stored, then announced; BACK closes without either`, () => {
      const order: string[] = []
      const writes: string[] = []
      const store: Store = {
        getItem: () => null,
        setItem: (k, v) => {
          order.push('stored')
          writes.push(`${k}=${v}`)
        },
      }
      const menu = pages(name, (s) => order.push(`announced:${menu.settings === s}`), store)
      menu.openPage()
      expect(menu.open).toBe(true)
      expect(menu.activate(change)).not.toBe('back')
      // `menu.settings` was already the new object when the announcement ran.
      expect(order).toEqual(['stored', 'announced:true'])
      // The last row of every page is BACK.
      const last = menu.rows.length - 1
      order.length = 0
      expect(menu.activate(last)).toBe('back')
      expect(menu.open).toBe(false)
      expect(order, 'BACK changes nothing, so it writes and announces nothing').toEqual([])
    })

    it(`${name}: sync is silent and the next press builds on the synced object`, () => {
      const seen: ComfortSettings[] = []
      const writes: string[] = []
      const menu = pages(name, (s) => seen.push(s), recordingStore(writes))
      menu.sync({ ...DEFAULT_SETTINGS, muted: !DEFAULT_SETTINGS.muted })
      expect(seen).toEqual([])
      expect(writes).toEqual([])
      menu.activate(change)
      expect(seen[0]?.muted, 'the press wrote back the synced field, not a stale one').toBe(
        !DEFAULT_SETTINGS.muted,
      )
    })

    it(`${name}: a store that throws does not stop the change`, () => {
      const seen: ComfortSettings[] = []
      const menu = pages(name, (s) => seen.push(s), recordingStore([], true))
      expect(() => menu.activate(change)).not.toThrow()
      expect(seen.length).toBe(1)
    })
  }

  it('extras are assigned onto the page without turning its getters into values', () => {
    const page = createSettingsPage(
      { settings: DEFAULT_SETTINGS, onChange: () => {}, storage: null },
      {
        title: 't',
        rows: () => [],
        activate: (settings) => ({
          settings: { ...settings, muted: !settings.muted },
          action: 'none',
          changed: true,
        }),
      },
      (handle) => ({
        flip: () => handle.commit({ ...handle.settings, muted: !handle.settings.muted }),
      }),
    )
    expect(page.settings.muted).toBe(DEFAULT_SETTINGS.muted)
    page.flip()
    page.flip()
    page.flip()
    expect(page.settings.muted, 'three flips read the CURRENT settings each time').toBe(
      !DEFAULT_SETTINGS.muted,
    )
    expect(page.activate(0)).toBe('none')
    expect(page.settings.muted).toBe(DEFAULT_SETTINGS.muted)
  })

  it('comfort mute persists and announces down the same path as a row', () => {
    const seen: boolean[] = []
    const writes: string[] = []
    const menu = createComfortMenu({
      settings: DEFAULT_SETTINGS,
      onChange: (s) => seen.push(s.muted),
      storage: recordingStore(writes),
    })
    menu.toggleMute()
    menu.toggleMute()
    expect(seen).toEqual([!DEFAULT_SETTINGS.muted, DEFAULT_SETTINGS.muted])
    expect(writes.length).toBe(2)
  })
})
