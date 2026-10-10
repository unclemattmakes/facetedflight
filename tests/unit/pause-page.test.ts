// tests/unit/pause-page.test.ts — which page the pause plate is turned to, as
// a value rather than as a picture of one.
//
// ── The gap this closes ──────────────────────────────────────────────────
//
// One plate draws four menus, and for the life of it "which one is up" was a
// ladder of `.open` flags inside `createApp`'s closure, written out twice —
// once to pick the rows, once to pick the title. Nothing outside the page
// could ask. `tests/e2e/controls-page.spec.ts` walked down to CONTROLS by
// pressing ArrowDown four times and could only check that *a* plate was up,
// which is true of every page of it: insert a row above CONTROLS and the spec
// opens the COMFORT page, asserts the plate is up, writes a picture of the
// wrong menu and PASSES. Its own comment conceded the dependency and nominated
// the screenshot as the safety net. A human looking at a PNG is not a gate.
//
// DEV-223 lifts the ladder to module scope in `render/pause.ts`, the way
// DEV-221 lifted `BACK_WORDS` and `backWordFor` out of `createHangar`'s.
//
// ── What is worth asserting, and what is not ─────────────────────────────
//
// `pausePage` is four lines, so a test that re-derives those four lines has
// tested nothing (trap 24). What is worth pinning is the RELATIONSHIP the four
// lines exist to hold: **the page's name is the id of the row that opens it**,
// so the name a probe reports and the row a player presses cannot come apart.
// That is asserted against the three real menus and the three real row
// constants rather than against stand-ins — `COMFORT_OPTION` is compared to
// `createComfortMenu`, not to the string `'comfort'`, because a test that
// spells the answer out again is a copy of the implementation.
//
// The menus are built for real here. All three are plain state machines with
// no DOM in them — that is what `createPause` needing a canvas and these not
// buys — so the wiring `app.ts` does is reproducible in `environment: 'node'`.

import { describe, expect, it } from 'vitest'
import { type ComfortSettings, DEFAULT_SETTINGS } from '@/boot/settings'
import type { Edition } from '@/content/edition-schema'
import { ADVANCED_OPTION, createAdvancedMenu } from '@/render/advanced-menu'
import { COMFORT_OPTION, createComfortMenu } from '@/render/comfort-menu'
import { CONTROLS_OPTION, createControlsMenu } from '@/render/controls-menu'
import { CREDITS_OPTION, createCreditsMenu } from '@/render/credits-menu'
import {
  createOptionsMenu,
  MORE_OPTION,
  MORE_TITLE,
  moreRows,
  OPTIONS_OPTION,
  optionsRows,
  REPORT_BUG_OPTION,
} from '@/render/options-menu'
import { type PauseOption, type PauseSubPage, pausePage, ROOT_PAGE, rowBand } from '@/render/pause'
import { createReportBugMenu } from '@/render/report-bug-menu'
import anniversaryJson from '../../content/editions/anniversary.json'
import { appFileWith } from './helpers/app-source'

/** Row id -> the exported constant's NAME, which is what `app.ts` writes. */
const OPTION_NAME = new Map<string, string>([
  [COMFORT_OPTION.id, 'COMFORT_OPTION'],
  [CONTROLS_OPTION.id, 'CONTROLS_OPTION'],
  [MORE_OPTION.id, 'MORE_OPTION'],
  [CREDITS_OPTION.id, 'CREDITS_OPTION'],
  [ADVANCED_OPTION.id, 'ADVANCED_OPTION'],
  [REPORT_BUG_OPTION.id, 'REPORT_BUG_OPTION'],
  [OPTIONS_OPTION.id, 'OPTIONS_OPTION'],
])

/** DEV-621: the OPTIONS page's rows, as `app.ts` builds them (dev row included). */
const OPTIONS_ROWS = optionsRows({
  settings: DEFAULT_SETTINGS,
  controls: CONTROLS_OPTION,
  comfort: COMFORT_OPTION,
})

/** DEV-859: MORE's rows, whose doors (effects, credits, report bug) are pages too. */
const MORE_ROWS = moreRows({
  settings: DEFAULT_SETTINGS,
  qualityPin: null,
  presenting: false,
  effects: ADVANCED_OPTION,
  credits: CREDITS_OPTION,
})

const memoryStore = () => {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v)
    },
  }
}

/** The root plate, near enough: a heading and some rows that open pages. */
const ROOT = {
  title: '- PAUSE -',
  rows: [
    { id: 'resume', label: 'Resume', note: 'back to the run' },
    // DEV-621: every page now opens from OPTIONS.
    OPTIONS_OPTION,
    { id: 'exit', label: 'Exit', note: 'back to the hangar' },
  ] as readonly PauseOption[],
}

/**
 * `app.ts`'s wiring, as a function so every test here walks the same one.
 *
 * The ORDER is `app.ts`'s order. It is handed in rather than fixed in
 * `pause.ts` for hard rule 6's reason — a fourth page is a fourth entry and
 * touches no render code — so the order is this file's to state.
 */
const wire = (): {
  comfort: ReturnType<typeof createComfortMenu>
  controls: ReturnType<typeof createControlsMenu>
  more: ReturnType<typeof createOptionsMenu>
  credits: ReturnType<typeof createCreditsMenu>
  advanced: ReturnType<typeof createAdvancedMenu>
  reportBug: ReturnType<typeof createReportBugMenu>
  options: ReturnType<typeof createOptionsMenu>
  pages: readonly PauseSubPage[]
} => {
  const onChange = (): void => {}
  const storage = memoryStore()
  const settings: ComfortSettings = DEFAULT_SETTINGS
  const comfort = createComfortMenu({ settings, onChange, storage })
  const controls = createControlsMenu({ settings, onChange, storage })
  // DEV-614: the credits, read-only rows and BACK.
  const credits = createCreditsMenu({ version: 'v0.0.1' })
  // DEV-269's Advanced page. It landed while DEV-223 was open, so this branch
  // never saw it and its list stopped at three — see the `app.ts` agreement
  // test below, which exists because that is precisely how a page goes missing.
  const advanced = createAdvancedMenu({
    presenting: () => false,
    settings,
    onChange,
    storage,
    live: () => anniversaryJson as unknown as Edition,
  })
  // DEV-622 and DEV-621: REPORT BUG, then OPTIONS LAST, so the deepest open
  // page wins while OPTIONS stays open beneath it.
  const reportBug = createReportBugMenu({
    snapshot: () => ({
      version: 'v0.0.1',
      channel: 'preview',
      screen: 'mission',
      mission: 'test',
      tick: 0,
      quality: 'high',
      device: 'desktop',
      errors: [],
    }),
  })
  const options = createOptionsMenu(() => OPTIONS_ROWS)
  const more = createOptionsMenu(() => MORE_ROWS, MORE_TITLE)
  return {
    comfort,
    controls,
    more,
    credits,
    advanced,
    reportBug,
    options,
    pages: [
      { row: COMFORT_OPTION, menu: comfort },
      { row: CONTROLS_OPTION, menu: controls },
      { row: CREDITS_OPTION, menu: credits },
      { row: ADVANCED_OPTION, menu: advanced },
      { row: REPORT_BUG_OPTION, menu: reportBug },
      { row: MORE_OPTION, menu: more },
      { row: OPTIONS_OPTION, menu: options },
    ],
  }
}

describe('the plate says which page it is turned to', () => {
  it('is the plate itself while no page is open', () => {
    const { pages } = wire()
    const plate = pausePage(ROOT, pages)
    expect(plate.page).toBe(ROOT_PAGE)
    expect(plate.title).toBe(ROOT.title)
    expect(plate.rows).toBe(ROOT.rows)
  })

  it('names a page by the ROW that opens it, for every page there is', () => {
    // The anti-drift claim, and the reason a `PauseOption` is passed in rather
    // than a string: a spec presses the row whose id is `x` and is told it is
    // on page `x`. Driven over every page there is, so one added with a
    // hand-typed name is the odd one out.
    for (const { row, open } of [
      { row: COMFORT_OPTION, open: (w: ReturnType<typeof wire>) => w.comfort },
      { row: CONTROLS_OPTION, open: (w: ReturnType<typeof wire>) => w.controls },
      { row: MORE_OPTION, open: (w: ReturnType<typeof wire>) => w.more },
      { row: CREDITS_OPTION, open: (w: ReturnType<typeof wire>) => w.credits },
      { row: ADVANCED_OPTION, open: (w: ReturnType<typeof wire>) => w.advanced },
      { row: REPORT_BUG_OPTION, open: (w: ReturnType<typeof wire>) => w.reportBug },
      { row: OPTIONS_OPTION, open: (w: ReturnType<typeof wire>) => w.options },
    ]) {
      const w = wire()
      const menu = open(w)
      menu.openPage()
      const plate = pausePage(ROOT, w.pages)
      expect(plate.page, row.id).toBe(row.id)
      // The heading and the rows travel WITH the name. Two ladders over the
      // same flags is how a plate could draw one page's rows under another
      // page's title, and that is what this collapses.
      expect(plate.title, row.id).toBe(menu.title)
      expect(plate.rows, row.id).toEqual(menu.rows)
      // And it is the page's own list, not the plate's.
      expect(plate.rows, row.id).not.toEqual(ROOT.rows)
    }
  })

  it('goes back to the plate when the page closes', () => {
    const w = wire()
    w.controls.openPage()
    expect(pausePage(ROOT, w.pages).page).toBe(CONTROLS_OPTION.id)
    w.controls.closePage()
    expect(pausePage(ROOT, w.pages).page).toBe(ROOT_PAGE)
  })

  it('gives ONE answer when two pages are somehow open, not one per caller', () => {
    // In the app at most one can be: a page is opened from the plate and
    // closed before you are back on it. The order is stated anyway, because
    // the value has three consumers — the picker, the painter and the probe —
    // and "undefined behaviour, but they all do the same undefined thing" is
    // not a property you get for free.
    const w = wire()
    w.controls.openPage()
    w.more.openPage()
    const plate = pausePage(ROOT, w.pages)
    expect(plate.page).toBe(CONTROLS_OPTION.id)
    expect(plate.rows).toEqual(w.controls.rows)
  })

  it('reports no page the plate has no row for', () => {
    // The loud counterpart. Every name this can return has to be reachable by
    // pressing something — a probe reporting a page a player cannot get to
    // would be an instrument describing a menu that is not there. `pausePage`
    // cannot produce one by construction, and this is the assertion that says
    // so out loud, so a future signature taking a free string fails here
    // rather than in a headset.
    const w = wire()
    const names = [ROOT_PAGE]
    for (const menu of [
      w.comfort,
      w.controls,
      w.more,
      w.credits,
      w.advanced,
      w.reportBug,
      w.options,
    ]) {
      menu.openPage()
      names.push(pausePage(ROOT, w.pages).page)
      menu.closePage()
    }
    // DEV-621: a page is reachable from the root or from OPTIONS.
    const reachable = new Set<string>([
      ROOT_PAGE,
      ...ROOT.rows.map((r) => r.id),
      ...OPTIONS_ROWS.map((r) => r.id),
      ...MORE_ROWS.map((r) => r.id),
    ])
    for (const name of names) expect(reachable.has(name), name).toBe(true)
  })
})

describe('the page decides the plate geometry, so the count has to be its own', () => {
  it('hands the picker the count of the OPEN page, not of the plate', () => {
    // `pause.ts` derives the row band, the hit test and the paint from the
    // count it is given. The comfort page is eight rows against the plate's
    // five here, and those are different bands — so a caller that picked
    // against the plate while drawing the page would have a menu whose rows
    // are not where they look. One value, three consumers, is what prevents
    // it; this pins that the two counts really do differ, because a test that
    // cannot tell them apart would pass either way.
    const w = wire()
    w.options.openPage()
    const open = pausePage(ROOT, w.pages)
    expect(open.rows.length).not.toBe(ROOT.rows.length)
    expect(rowBand(open.rows.length)).not.toBeCloseTo(rowBand(ROOT.rows.length), 6)
  })
})

// ── and the list in `app.ts` is the list this file walks ──────────────────

describe('the pages `app.ts` hands in are the pages this file tests', () => {
  it('names the same rows, in the same order', () => {
    // THE GUARD THAT WAS MISSING, and it is missing-shaped for a reason.
    //
    // `pausePage` is handed its page list by `app.ts` — hard rule 6's whole
    // point, so a new page touches no render code. The cost is that this file
    // can only test the list it BUILDS, and nothing made that the list the game
    // uses. DEV-269's Advanced page landed while DEV-223 was open and the merge
    // that brought them together had to add a fourth entry by hand; drop it and
    // every other test here stays green while the game loses a page from every
    // question the plate answers about itself.
    //
    // So: read the call out of `app.ts` and require it to name exactly what
    // `wire()` names. A source-text assertion is the blunt instrument, and it is
    // the right one here — the alternative is booting the app, and the claim is
    // about a literal list in one file.
    const app = appFileWith('const pausePlate').text
    const call = /const pausePlate\s*=[\s\S]*?pausePage\(([\s\S]*?)\n {2}\)/.exec(app)
    expect(call, '`pausePlate` still calls `pausePage` in src/boot/app.ts').toBeTruthy()
    const inApp = [...(call?.[1] ?? '').matchAll(/row:\s*([A-Z_]+_OPTION)/g)].map((m) => m[1])
    const inFixture = wire().pages.map((p) => OPTION_NAME.get(p.row.id))

    expect(inFixture, 'every fixture row has a constant name').not.toContain(undefined)
    expect(inApp, 'app.ts hands in at least the pages this file knows').toEqual(inFixture)
  })
})
