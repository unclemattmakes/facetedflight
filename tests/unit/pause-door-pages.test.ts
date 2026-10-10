// tests/unit/pause-door-pages.test.ts: pressing a page from the SAME list that draws it.
//
// `pausePage` made drawing one list (DEV-223) and `app.ts` kept four more: the
// A-press ladder (`else if (comfortMenu.open) ...`, six arms), the open ladder
// (`else if (chosen === 'comfort') ...`, seven), the BACK / shut list and the
// settings fan-out. This pins that the one list gives the answers the ladders
// gave, by replaying the OLD ladder (transcribed below from `app.ts` at
// 94251c7f) against the loops over every combination of open pages and every
// row the aim can be on.

import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@/boot/settings'
import { ADVANCED_OPTION, createAdvancedMenu } from '@/render/advanced-menu'
import { COMFORT_OPTION, createComfortMenu } from '@/render/comfort-menu'
import { CONTROLS_OPTION, createControlsMenu } from '@/render/controls-menu'
import { CREDITS_OPTION, createCreditsMenu } from '@/render/credits-menu'
import {
  createOptionsMenu,
  MORE_OPTION,
  OPTIONS_OPTION,
  REPORT_BUG_OPTION,
} from '@/render/options-menu'
import {
  closeOpenPausePage,
  openPausePage,
  type PauseDoorPage,
  pageOpenedBy,
  pageToPress,
  pausePage,
  ROOT_PAGE,
  shutPausePages,
  syncPausePages,
} from '@/render/pause'
import { createReportBugMenu } from '@/render/report-bug-menu'
import { appFileWith, codeOnly } from './helpers/app-source'

type Settings = typeof DEFAULT_SETTINGS

/** The plate's pages, built the way `app.ts` builds them (the source guard below holds it to that). */
const build = () => {
  const onChange = (): void => {}
  const comfort = createComfortMenu({ settings: DEFAULT_SETTINGS, onChange, storage: null })
  const controls = createControlsMenu({ settings: DEFAULT_SETTINGS, onChange, storage: null })
  const credits = createCreditsMenu({ version: 'test' })
  const advanced = createAdvancedMenu({
    settings: DEFAULT_SETTINGS,
    live: () => 'anniversary' as never,
    presenting: () => false,
    onChange,
    storage: null,
  })
  const reportBug = createReportBugMenu({ snapshot: () => ({}) as never })
  const more = createOptionsMenu(() => [])
  const options = createOptionsMenu(() => [])
  let rolled = 0
  const pages: readonly PauseDoorPage<Settings>[] = [
    { row: COMFORT_OPTION, menu: comfort },
    { row: CONTROLS_OPTION, menu: controls },

    { row: CREDITS_OPTION, menu: credits, openAim: -1, onOpen: () => rolled++ },
    { row: ADVANCED_OPTION, menu: advanced },
    { row: REPORT_BUG_OPTION, menu: reportBug },
    { row: MORE_OPTION, menu: more },
    { row: OPTIONS_OPTION, menu: options },
  ]
  return {
    pages,
    menus: { comfort, controls, credits, advanced, reportBug, more, options },
    rolled: () => rolled,
  }
}

const IDS = ['options', 'comfort', 'controls', 'more', 'credits', 'advanced', 'reportbug'] as const

describe('the ids the old ladder compared against are the rows the pages hang off', () => {
  it('are the literal strings, in the list order, OPTIONS last', () => {
    // The old open ladder said `chosen === 'comfort'` and so on. The list opens a
    // page by `row.id`, so the two only agree while these literals do.
    const { pages } = build()
    expect(pages.map((p) => p.row.id)).toEqual([
      'comfort',
      'controls',
      'credits',
      'advanced',
      'reportbug',
      'more',
      'options',
    ])
    expect(new Set(pages.map((p) => p.row.id)).size).toBe(pages.length)
    expect([...IDS].sort()).toEqual(pages.map((p) => p.row.id).sort())
  })
})

describe('which page takes the press: the old six-arm ladder against pageToPress', () => {
  /** app.ts: `else if (comfortMenu.open) ... else if (reportBugMenu.open)`, first open wins. */
  const oldPress = (open: Record<string, boolean>): string | null => {
    for (const id of ['comfort', 'controls', 'credits', 'advanced', 'reportbug']) {
      if (open[id]) return id
    }
    return null
  }

  it('agrees on every one of the 128 combinations of open pages', () => {
    let pressed = 0
    for (let mask = 0; mask < 128; mask++) {
      const { pages, menus } = build()
      const open: Record<string, boolean> = {}
      const byId = [
        ['comfort', menus.comfort],
        ['controls', menus.controls],
        ['credits', menus.credits],
        ['advanced', menus.advanced],
        ['reportbug', menus.reportBug],
        ['more', menus.more],
        ['options', menus.options],
      ] as const
      byId.forEach(([id, menu], i) => {
        open[id] = (mask & (1 << i)) !== 0
        if (open[id]) menu.openPage()
      })
      const now = pageToPress(pages)?.row.id ?? null
      expect(now, `mask ${mask}`).toBe(oldPress(open))
      if (now !== null) pressed++
    }
    // 124 of 128 masks have one of the five open; MORE and OPTIONS (id-ladder hubs) do not.
    expect(pressed).toBe(124)
  })

  it('leaves OPTIONS to the id ladder: it has no `activate`', () => {
    const { pages, menus } = build()
    menus.options.openPage()
    expect(pageToPress(pages)).toBeUndefined()
  })
})

describe('which page a row opens: the old seven-arm ladder against pageOpenedBy', () => {
  const OPENS = new Set<string>(IDS)

  it('opens exactly the pages the old arms did, and nothing else', () => {
    const { pages } = build()
    const rows = [
      ...IDS,
      'back',
      'mute',
      'perfcapture',
      'entervr',
      'exitvr',
      'resume',
      'restart',
      'exit',
    ]
    for (const id of rows) {
      expect(pageOpenedBy(pages, id)?.row.id ?? null, id).toBe(OPENS.has(id) ? id : null)
    }
    expect(pageOpenedBy(pages, null)).toBeUndefined()
    expect(pageOpenedBy(pages, undefined)).toBeUndefined()
  })

  it('opens with the aim the old arm set: 0, except the credits, which open on -1 with the roll reset', () => {
    for (const id of IDS) {
      const { pages, menus, rolled } = build()
      const page = pageOpenedBy(pages, id)
      expect(page, id).toBeDefined()
      const aim = openPausePage(page as PauseDoorPage<Settings>)
      expect(aim, id).toBe(id === 'credits' ? -1 : 0)
      expect(rolled(), id).toBe(id === 'credits' ? 1 : 0)
      const menu = Object.values(menus).find((m) => m.open)
      expect(menu, id).toBeDefined()
      // Exactly one page is open, and it is the one asked for.
      expect(Object.values(menus).filter((m) => m.open)).toHaveLength(1)
    }
  })
})

describe('BACK and the shut: the old optionsPages() against the list', () => {
  it('closeOpenPausePage shuts the first open page, a sub-page before OPTIONS, as optionsPages().find did', () => {
    for (let mask = 1; mask < 128; mask++) {
      const { pages, menus } = build()
      const all = Object.values(menus)
      const order = [
        menus.comfort,
        menus.controls,
        menus.credits,
        menus.advanced,
        menus.reportBug,
        menus.more,
        menus.options,
      ]
      order.forEach((menu, i) => {
        if ((mask & (1 << i)) !== 0) menu.openPage()
      })
      const before = all.filter((m) => m.open)
      // Old: the first open of the six; else OPTIONS.
      const expected = order.slice(0, 6).find((m) => m.open) ?? menus.options
      expect(closeOpenPausePage(pages), `mask ${mask}`).toBe(true)
      const closed = before.filter((m) => !m.open)
      expect(closed, `mask ${mask}`).toEqual([expected])
    }
  })

  it('closeOpenPausePage is false, and shuts nothing, with every page already shut', () => {
    const { pages } = build()
    expect(closeOpenPausePage(pages)).toBe(false)
  })

  it('shutPausePages shuts all seven, in the old order (the six, then OPTIONS)', () => {
    const order: string[] = []
    const fake = (id: string): PauseDoorPage<Settings> => ({
      row: { id, label: id, note: '' },
      menu: {
        open: true,
        title: id,
        rows: [],
        openPage() {},
        closePage() {
          order.push(id)
        },
      },
    })
    shutPausePages(
      ['comfort', 'controls', 'credits', 'advanced', 'reportbug', 'more', 'options'].map(fake),
    )
    expect(order).toEqual([
      'comfort',
      'controls',
      'credits',
      'advanced',
      'reportbug',
      'more',
      'options',
    ])
  })
})

describe('the settings fan-out: comfort, controls, advanced, in that order', () => {
  it('reaches exactly the pages that keep a copy of the settings', () => {
    const { pages, menus } = build()
    // The old fan-out: comfortMenu / controlsMenu / advancedMenu (the edition page went in DEV-859).
    expect(typeof menus.comfort.sync).toBe('function')
    expect(typeof menus.controls.sync).toBe('function')
    expect(typeof menus.advanced.sync).toBe('function')
    expect('sync' in menus.credits).toBe(false)
    expect('sync' in menus.reportBug).toBe(false)
    expect('sync' in menus.more).toBe(false)
    expect('sync' in menus.options).toBe(false)
    const seen: string[] = []
    const withSync = pages.map((p) => ({
      ...p,
      menu: {
        open: p.menu.open,
        title: p.row.id,
        rows: [],
        openPage: () => {},
        closePage: () => {},
        ...(p.menu.sync ? { sync: () => void seen.push(p.row.id) } : {}),
      },
    }))
    syncPausePages(withSync, DEFAULT_SETTINGS)
    expect(seen).toEqual(['comfort', 'controls', 'advanced'])
  })
})

describe('the plate draws what the list says (unchanged), and app.ts holds one list', () => {
  it('pausePage still names the first open page, which is the page that presses', () => {
    const { pages, menus } = build()
    const root = { title: 'ROOT', rows: [] }
    expect(pausePage(root, pages).page).toBe(ROOT_PAGE)
    menus.options.openPage()
    expect(pausePage(root, pages).page).toBe('options')
    menus.credits.openPage()
    expect(pausePage(root, pages).page).toBe('credits')
    expect(pageToPress(pages)?.row.id).toBe('credits')
  })

  it('app.ts builds the list in the same order, and no longer climbs a ladder of `.open`', () => {
    const src = codeOnly(appFileWith('const pauseSubPages').text)
    const list = src.slice(src.indexOf('const pauseSubPages'))
    const rows = [...list.matchAll(/row: (\w+_OPTION)/g)].map((m) => m[1])
    expect(rows.slice(0, 7)).toEqual([
      'COMFORT_OPTION',
      'CONTROLS_OPTION',
      'CREDITS_OPTION',
      'ADVANCED_OPTION',
      'REPORT_BUG_OPTION',
      'MORE_OPTION',
      'OPTIONS_OPTION',
    ])
    expect(list).toMatch(/openAim: -1/)
    // The ladders the list replaced.
    expect(src).not.toMatch(
      /else if \((comfort|controls|edition|credits|advanced|reportBug)Menu\.open\)/,
    )
    expect(src).not.toMatch(
      /else if \(chosen === '(comfort|controls|edition|credits|advanced|reportbug|options)'\)/,
    )
    expect(src).not.toMatch(/optionsPages/)
    expect(src).not.toMatch(/(comfort|controls|advanced)Menu\.sync\(/)
  })
})
