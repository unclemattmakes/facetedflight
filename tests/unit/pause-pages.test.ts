// tests/unit/pause-pages.test.ts: the pause plate in pages, and REPORT BUG.
// DEV-621, DEV-622.
//
// Matt, 2026-10-04: *"pause - group into pages: resume, restart, options,
// exit. options should take you to a panel with mute, controls, comfort,
// edition, credits, report bug (new option), back"*. Held here: the two
// pages' rows in his order, the headset's 4.00-degree floor on both, the
// deepest-page-wins order `app.ts` hands `pausePage`, and the report panel's
// promise (what it shows is what it sends; a no-op sender is not thanked).

import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@/boot/settings'
import { ADVANCED_OPTION } from '@/render/advanced-menu'
import { COMFORT_OPTION } from '@/render/comfort-menu'
import { CONTROLS_OPTION } from '@/render/controls-menu'
import { CREDITS_OPTION } from '@/render/credits-menu'
import {
  createOptionsMenu,
  MORE_OPTION,
  moreRows,
  OPTIONS_OPTION,
  optionsRows,
} from '@/render/options-menu'
import { PANEL_DISTANCE, pausePage, ROOT_PAGE, rowBand } from '@/render/pause'
import {
  type BugReport,
  createErrorRing,
  createReportBugMenu,
  REPORT_BUG_ROW_IDS,
  REPORT_ERRORS_MAX,
} from '@/render/report-bug-menu'
import { appFileWith, codeOnly } from './helpers/app-source'

const rows = optionsRows({
  settings: DEFAULT_SETTINGS,
  controls: CONTROLS_OPTION,
  comfort: COMFORT_OPTION,
})
const more = moreRows({
  settings: DEFAULT_SETTINGS,
  qualityPin: null,
  presenting: false,
  effects: ADVANCED_OPTION,
  credits: CREDITS_OPTION,
})
const degrees = (count: number) =>
  (2 * Math.atan(rowBand(count) / 2 / PANEL_DISTANCE) * 180) / Math.PI

describe('DEV-859: OPTIONS, the one page', () => {
  it('is mute, volume, invert pitch, look, comfort, controls, more, back', () => {
    expect(rows.map((r) => r.id)).toEqual([
      'mute',
      'volume',
      'invert',
      'edition',
      'comfort',
      'controls',
      'more',
      'back',
    ])
    // LOOK is EDITION's old name; the setting and the row id keep theirs.
    expect(rows.find((r) => r.id === 'edition')?.label).toBe('Look')
  })

  it('shows a value on the four rows that change in place, and none on the doors', () => {
    const valued = rows.filter((r) => r.value !== undefined).map((r) => r.id)
    expect(valued).toEqual(['mute', 'volume', 'invert', 'edition'])
  })

  it('MORE holds quality, race strip, effects, credits, report bug and back', () => {
    expect(more.map((r) => r.id)).toEqual([
      'quality',
      'racestrip',
      'advanced',
      'credits',
      'reportbug',
      'back',
    ])
    expect(more.find((r) => r.id === 'advanced')?.label).toBe('Effects')
    expect(rows.find((r) => r.id === MORE_OPTION.id)).toBeTruthy()
  })

  it('puts a developer row above BACK', () => {
    const dev = optionsRows({
      settings: DEFAULT_SETTINGS,
      controls: CONTROLS_OPTION,
      comfort: COMFORT_OPTION,
      dev: [{ id: 'perfcapture', label: 'Perf', note: '' }],
    })
    expect(dev.at(-2)?.id).toBe('perfcapture')
    expect(dev.at(-1)?.id).toBe('back')
  })

  it('BACK says where it goes, for whoever opened the page', () => {
    expect(rows.at(-1)?.note).toBe('to the pause menu')
    const title = optionsRows({
      settings: DEFAULT_SETTINGS,
      controls: CONTROLS_OPTION,
      comfort: COMFORT_OPTION,
      backNote: 'to the title',
    })
    expect(title.at(-1)?.note).toBe('to the title')
  })

  it('a player page of eight rows is 3.99 degrees (DEV-614, DEV-838, DEV-859)', () => {
    // The floor DEV-838's note accepted (QUESTIONS-FOR-MATT): 4.00 degrees.
    expect(rows.length).toBe(8)
    expect(degrees(rows.length)).toBeGreaterThanOrEqual(3.99)
    // And no page is bigger than OPTIONS.
    expect(more.length).toBeLessThanOrEqual(rows.length)
  })
})

describe('DEV-621: the root plate in app.ts', () => {
  const app = codeOnly(appFileWith('const pauseOptions').text)
  const root = /const pauseOptions[\s\S]*?\n {2}\]\n/.exec(app)?.[0] ?? ''

  it('holds resume, restart, options and exit, and none of the options rows', () => {
    expect(root, 'found pauseOptions').toContain("id: 'resume'")
    expect(root).toContain("id: 'restart'")
    expect(root).toContain('OPTIONS_OPTION')
    expect(root).toContain("id: 'exit'")
    for (const gone of [
      'muteOption',
      'COMFORT_OPTION',
      'CONTROLS_OPTION',
      'CREDITS_OPTION',
      'ADVANCED_OPTION',
    ]) {
      expect(root, gone).not.toContain(gone)
    }
  })

  it('at its largest for a player (a lesson, in a headset) is at most seven rows', () => {
    // resume, restart, skip step, options, exit vr, exit: six. The 4.00 floor.
    expect(degrees(6)).toBeGreaterThanOrEqual(4)
  })

  it("lists OPTIONS' pages before OPTIONS, so the deepest open page wins", () => {
    const plate = /const pausePlate = [\s\S]*?\]\)\n/.exec(app)?.[0] ?? ''
    const at = (row: string) => plate.indexOf(`row: ${row}`)
    expect(at('OPTIONS_OPTION')).toBeGreaterThan(0)
    for (const page of [
      'COMFORT_OPTION',
      'CONTROLS_OPTION',
      'CREDITS_OPTION',
      'ADVANCED_OPTION',
      'REPORT_BUG_OPTION',
      'MORE_OPTION',
    ]) {
      expect(at(page), page).toBeGreaterThan(0)
      expect(at(page), `${page} before OPTIONS`).toBeLessThan(at('OPTIONS_OPTION'))
    }
  })

  it('B, Backspace and a free Escape go back a page before they resume', () => {
    // APP-SPLIT 4.6d: the plate (`pauseOptions`, `pausePlate`) moved to
    // `boot/app/hangar/menus.ts`; the BACK press is the frame's, so its claims
    // read the one file the frame's pause block is in.
    const app = codeOnly(appFileWith('const pauseBack = backPressed(').text)
    expect(app).toMatch(/const pauseBack = backPressed\(backSources\)/)
    expect(app).toMatch(/!pausePageBack\(\)/)
    // Backspace's edge, then Escape's, then the page-back itself; both edges are
    // the ones `escapeKey` / `pauseKey` stepped at the top of the pause block.
    expect(app).toMatch(
      /pausePressed && keyboard\.pause\)[\s\S]{0,120}escapePressed[\s\S]{0,120}pausePageBack\(\)/,
    )
    expect(app).toMatch(/const escapePressed = escapeKey\.step\(keyboardEscape\)/)
  })
})

describe('DEV-621: pausePage with OPTIONS open beneath a page', () => {
  const page = (open: boolean, title: string, id: string) => ({
    row: { id, label: id, note: '' },
    menu: { open, title, rows: [{ id: `${id}-row`, label: '', note: '' }] },
  })
  const root = { title: '- PAUSE -', rows: [] }

  it('shows the page, not OPTIONS, while both are open', () => {
    const options = createOptionsMenu(() => rows)
    options.openPage()
    const plate = pausePage(root, [
      page(true, '- COMFORT -', 'comfort'),
      { row: OPTIONS_OPTION, menu: options },
    ])
    expect(plate.page).toBe('comfort')
  })

  it('shows OPTIONS once the page closes, and the root once OPTIONS does', () => {
    const options = createOptionsMenu(() => rows)
    options.openPage()
    const list = [page(false, '- COMFORT -', 'comfort'), { row: OPTIONS_OPTION, menu: options }]
    expect(pausePage(root, list).page).toBe('options')
    options.closePage()
    expect(pausePage(root, list).page).toBe(ROOT_PAGE)
  })
})

describe('DEV-622: REPORT BUG', () => {
  const report: BugReport = {
    version: 'v0.21.0',
    channel: 'preview',
    screen: 'mission',
    mission: 'int_01_hoverJet',
    tick: 1234,
    quality: 'high',
    device: 'desktop',
    errors: ['TypeError: x is undefined'],
  }

  it('shows what it sends: the build, where, the machine, the errors, then SEND and BACK', () => {
    const menu = createReportBugMenu({ snapshot: () => report })
    menu.openPage()
    expect(menu.rows.map((r) => r.id)).toEqual([...REPORT_BUG_ROW_IDS])
    const text = menu.rows.map((r) => `${r.label} ${r.value ?? ''} ${r.note}`).join('\n')
    for (const fact of ['v0.21.0', 'preview', 'tick 1234', 'int_01_hoverJet', 'high', 'desktop']) {
      expect(text, fact).toContain(fact)
    }
    expect(text).toContain('TypeError: x is undefined')
    expect(menu.rows.length, 'within the seven-row ceiling').toBeLessThanOrEqual(7)
  })

  it('sends the report it showed, and says thank you with the id', () => {
    const sent: BugReport[] = []
    const menu = createReportBugMenu({
      snapshot: () => report,
      reportBug: (r) => {
        sent.push(r)
        return 'ab12'
      },
    })
    menu.openPage()
    menu.activate(REPORT_BUG_ROW_IDS.indexOf('send'))
    expect(sent).toEqual([report])
    const row = menu.rows.find((r) => r.id === 'send')
    expect(row?.label).toBe('Sent, thank you')
    expect(row?.value).toBe('ab12')
    // A second press sends nothing more.
    menu.activate(REPORT_BUG_ROW_IDS.indexOf('send'))
    expect(sent).toHaveLength(1)
  })

  it('waits on a sender that answers later', async () => {
    const menu = createReportBugMenu({
      snapshot: () => report,
      reportBug: () => Promise.resolve('cd34'),
    })
    menu.openPage()
    menu.activate(REPORT_BUG_ROW_IDS.indexOf('send'))
    expect(menu.send.kind).toBe('sending')
    await Promise.resolve()
    await Promise.resolve()
    expect(menu.send).toEqual({ kind: 'sent', id: 'cd34' })
  })

  it('does not thank anyone for nothing: the default sends nothing and says so', () => {
    const menu = createReportBugMenu({ snapshot: () => report })
    menu.openPage()
    menu.activate(REPORT_BUG_ROW_IDS.indexOf('send'))
    expect(menu.send.kind).toBe('failed')
    expect(menu.rows.find((r) => r.id === 'send')?.label).toBe('Not sent')
  })

  it('BACK closes the page', () => {
    const menu = createReportBugMenu({ snapshot: () => report })
    menu.openPage()
    expect(menu.activate(REPORT_BUG_ROW_IDS.indexOf('back'))).toBe('back')
    expect(menu.open).toBe(false)
  })

  it('keeps only the last few errors', () => {
    const ring = createErrorRing()
    for (let i = 0; i < REPORT_ERRORS_MAX + 3; i++) ring.push(`e${i}`)
    expect(ring.recent).toHaveLength(REPORT_ERRORS_MAX)
    expect(ring.recent.at(-1)).toBe(`e${REPORT_ERRORS_MAX + 2}`)
  })
})
