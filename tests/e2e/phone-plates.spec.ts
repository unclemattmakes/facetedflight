/**
 * DEV-894: every plate a phone shows is over one floor, measured on the glass.
 *
 * Matt, 2026-10-09, playing on his phone: *"the UI panels are too small to read and
 * hard to tap."* A Pixel 7 held sideways (915 x 412) walks the title and its OPTIONS,
 * the hangar's steps and OPTIONS plate, and a mission's pause plate with its pages;
 * at each stop `__ff2.uiText()` reports, for every UI canvas on the glass, how many
 * characters were set at each font size and what one canvas pixel covers, so the
 * text is measured in CSS pixels as drawn, and the row plates report where their
 * rows are, so a tap target is a measured pitch.
 *
 * The floors are `src/render/phone-floor.ts`'s, written out here because a spec
 * imports nothing from `src/` by value (`tests/unit/e2e-import-graph.test.ts`);
 * `tests/unit/phone-floor.test.ts` pins that the two copies agree.
 *
 * The editor is desktop-only on a phone and is not walked. A held-upright phone
 * shows the turn screen, a DOM card the guide's own spec measures.
 */
import type { Page } from '@playwright/test'
import { bootReady, switchSettled } from './fixtures/boot'
import type { Ff2Global } from './fixtures/ff2'
import { hangarOn, hold, lookUntilAimed, pressDoor, throughVariants } from './fixtures/hangar'
import { firstPress } from './fixtures/landing'
import { pausePlateState } from './fixtures/pause-menu'
import { PINNED } from './fixtures/quality-pin'
import { devices, expect, test } from './fixtures/test'
import { aimTitleRow, pressTitleRow, titleMenu, toHangar } from './fixtures/title'

const PHONE = {
  viewport: { width: 915, height: 412 },
  deviceScaleFactor: devices['Pixel 7'].deviceScaleFactor,
  userAgent: devices['Pixel 7'].userAgent,
  isMobile: true,
  hasTouch: true,
}

const MIN_BODY_TEXT_PX = 12
const MIN_SMALL_TEXT_PX = 9
const MIN_TAP_PX = 32

type Plate = Awaited<ReturnType<Ff2Global['__ff2']['uiText']>>[number]

/** What a stop of the walk reports. */
const failures: string[] = []
const report: Record<string, unknown>[] = []

const uiText = (page: Page): Promise<Plate[]> =>
  page.evaluate(() => (globalThis as unknown as Ff2Global).__ff2.uiText())

/** Measure every plate on the glass at this stop: body text, small text. */
const measure = async (page: Page, stop: string): Promise<void> => {
  await page.waitForTimeout(1_200)
  for (const plate of await uiText(page)) {
    if (!plate.onGlass || plate.sizes.length === 0) continue
    const body = [...plate.sizes].sort((a, b) => b.chars - a.chars)[0]
    const smallest = plate.sizes[0]
    if (!body || !smallest) continue
    report.push({
      stop,
      plate: plate.name,
      bodyCss: Number(body.css.toFixed(1)),
      smallestCss: Number(smallest.css.toFixed(1)),
      chars: plate.sizes.reduce((n, s) => n + s.chars, 0),
    })
    if (body.css < MIN_BODY_TEXT_PX)
      failures.push(`${stop}: ${plate.name} body text ${body.css.toFixed(1)} px`)
    if (smallest.css < MIN_SMALL_TEXT_PX)
      failures.push(`${stop}: ${plate.name} small text ${smallest.css.toFixed(1)} px`)
  }
}

/** No two table labels' text boxes may intersect on the glass at this stop. */
const noOverlap = async (page: Page, stop: string): Promise<void> => {
  const boxes = (await uiText(page))
    .filter(
      (p) =>
        p.onGlass &&
        /^hangar-(holotable|legend|detail|caption-line|header)$/.test(p.name) &&
        p.box !== null,
    )
    .map((p) => p.box as NonNullable<Plate['box']>)
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i] as NonNullable<Plate['box']>
      const b = boxes[j] as NonNullable<Plate['box']>
      if (a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b)
        failures.push(`${stop}: two table labels overlap on the glass ${JSON.stringify([a, b])}`)
    }
  }
}

/**
 * DEV-895: the title's edition line must clear every row. Matt, 2026-10-10, on his phone:
 * the "10th Anniversary" line overlapped the START row. The line's text box (the
 * `title-screen` plate) may not reach into any row's band: the row's centre, give or
 * take half the pitch between rows.
 */
const titleNoOverlap = async (page: Page, stop: string): Promise<void> => {
  // DEV-902: as RECTANGLES. The phone's rows stand beside the emblem now, so a row's
  // height band alone meets the line it sits beside; `phone-title.spec.ts` holds every
  // other pair of the title's elements at four phone sizes.
  const layout = await page.evaluate(() => (globalThis as unknown as Ff2Global).__ff2.titleLayout())
  const line = layout?.edition
  if (!line) {
    failures.push(`${stop}: the edition line is not on the glass`)
    return
  }
  if (!layout || layout.rows.length < 2) {
    failures.push(`${stop}: the title's rows were not reported`)
    return
  }
  for (const [i, row] of layout.rows.entries()) {
    if (line.t < row.b && row.t < line.b && line.l < row.r && row.l < line.r)
      failures.push(`${stop}: the edition line overlaps row ${i} ${JSON.stringify({ line, row })}`)
  }
}

/** The tap target of a row plate, from where its rows are: the pitch between neighbours. */
const tap = (stop: string, rowsAt: readonly { y: number }[] | null | undefined): void => {
  if (!rowsAt || rowsAt.length < 2) return
  const pitch = ((rowsAt[rowsAt.length - 1]?.y ?? 0) - (rowsAt[0]?.y ?? 0)) / (rowsAt.length - 1)
  report.push({ stop, tapPitch: Number(pitch.toFixed(1)) })
  if (pitch < MIN_TAP_PX) failures.push(`${stop}: rows ${pitch.toFixed(1)} px apart`)
}

test.describe('@gpu a phone sees every plate over the floor (DEV-894)', () => {
  test.use(PHONE)
  test.setTimeout(420_000)

  test('the title, its OPTIONS, the hangar and its OPTIONS plate', async ({ page }) => {
    failures.length = 0
    await page.addInitScript(() => {
      const g = globalThis as unknown as Record<string, Map<unknown, unknown>>
      g.__ff2TextLog = new Map()
      g.__ff2TextWidth = new Map()
    })
    await page.goto(`/?xr=off&${PINNED}`)
    await bootReady(page, 240_000)
    await firstPress(page, { tap: true })
    await page.waitForTimeout(1_000)
    await measure(page, 'title')
    await titleNoOverlap(page, 'title')
    tap('title rows', (await titleMenu(page))?.rowsAt)

    // The add-to-home-screen card is DOM: its smallest text and its button, css px.
    const guide = await page.evaluate(() => {
      const root = document.querySelector('#home-screen-guide')
      if (!root) return null
      const sizes = [...root.querySelectorAll('h2, h3, p, li, button')].map((e) =>
        Number.parseFloat(getComputedStyle(e).fontSize),
      )
      const button = root.querySelector('button')?.getBoundingClientRect().height ?? 0
      return { smallest: Math.min(...sizes), button }
    })
    if (guide) {
      report.push({ stop: 'home-screen card', ...guide })
      if (guide.smallest < MIN_BODY_TEXT_PX)
        failures.push(`home-screen card text ${guide.smallest} px`)
      if (guide.button < MIN_TAP_PX) failures.push(`home-screen card button ${guide.button} px`)
    }
    await pressTitleRow(page, 'options')
    await measure(page, 'title OPTIONS')
    tap('title OPTIONS rows', (await titleMenu(page))?.rowsAt)
    await aimTitleRow(page, 'more')
    await hold(page, 'Enter')
    await measure(page, 'title MORE')
    tap('title MORE rows', (await titleMenu(page))?.rowsAt)
    for (let i = 0; i < 2; i++) await hold(page, 'Backspace')
    await page.waitForTimeout(500)

    await toHangar(page)
    await measure(page, 'hangar doors')
    await noOverlap(page, 'hangar doors')
    await pressDoor(page, 'options')
    await measure(page, 'hangar OPTIONS')
    tap(
      'hangar OPTIONS rows',
      await page.evaluate(() => (globalThis as unknown as Ff2Global).__ff2.hangarOptions().rowsAt),
    )
    await hold(page, 'Backspace')
    await page.waitForTimeout(500)
    await pressDoor(page, 'single-player')
    await hangarOn(page, 'vehicles')
    await measure(page, 'hangar aircraft')
    await noOverlap(page, 'hangar aircraft')
    expect(await lookUntilAimed(page, 'hoverjet')).toBe(true)
    await hold(page, 'Enter')
    await throughVariants(page)
    await hangarOn(page, 'modes')
    await measure(page, 'hangar plans')
    await noOverlap(page, 'hangar plans')
    expect(await lookUntilAimed(page, 'ringAttack')).toBe(true)
    await hold(page, 'Enter')
    await hangarOn(page, 'courses')
    await measure(page, 'hangar places')
    await noOverlap(page, 'hangar places')
    console.log(`PHONE-PLATES ${JSON.stringify(report)}`)
    expect(failures, failures.join(' | ')).toEqual([])
  })

  test('the pause plate and its pages', async ({ page }) => {
    failures.length = 0
    await page.addInitScript(() => {
      const g = globalThis as unknown as Record<string, Map<unknown, unknown>>
      g.__ff2TextLog = new Map()
      g.__ff2TextWidth = new Map()
    })
    await page.goto(`/?autopilot=1&ride=0&mission=int_01_hoverJet&xr=off&${PINNED}`)
    await firstPress(page, { tap: true })
    await switchSettled(page, 180_000)
    await page.waitForTimeout(2_000)
    await page.locator('#touch-controls [data-act="pause"]').tap()
    await expect
      .poll(async () => (await pausePlateState(page)).open, { timeout: 10_000 })
      .toBe(true)
    await measure(page, 'pause')
    const root = await pausePlateState(page)
    tap(
      'pause rows',
      root.edges?.rowY.map((y) => ({ y })),
    )
    const options = root.rows.findIndex((r) => r.id === 'options')
    if (root.edges) await page.touchscreen.tap(root.edges.x, root.edges.rowY[options] as number)
    await expect
      .poll(async () => (await pausePlateState(page)).page, { timeout: 10_000 })
      .toBe('options')
    await measure(page, 'pause OPTIONS')
    const page2 = await pausePlateState(page)
    tap(
      'pause OPTIONS rows',
      page2.edges?.rowY.map((y) => ({ y })),
    )
    expect(failures, failures.join('\n')).toEqual([])
  })

  test('the results panel and the lap questions', async ({ page }) => {
    failures.length = 0
    await page.addInitScript(() => {
      const g = globalThis as unknown as Record<string, Map<unknown, unknown>>
      g.__ff2TextLog = new Map()
      g.__ff2TextWidth = new Map()
    })
    await page.goto(`/?autopilot=1&ride=0&mission=int_01_hoverJet&xr=off&${PINNED}`)
    await firstPress(page, { tap: true })
    await switchSettled(page, 180_000)
    // The autopilot flies the course; the panel is up once its canvas is on the glass.
    await expect
      .poll(async () => (await uiText(page)).some((p) => p.name === 'results' && p.onGlass), {
        timeout: 300_000,
        intervals: [2_000],
      })
      .toBe(true)
    await measure(page, 'results')
    console.log(`PHONE-PLATES ${JSON.stringify(report)}`)
    expect(failures, failures.join(' | ')).toEqual([])
  })
})
