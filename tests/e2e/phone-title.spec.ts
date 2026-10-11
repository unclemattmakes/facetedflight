/**
 * DEV-902: a phone's title, laid out so nothing on it overlaps and everything on it is
 * over the phone floor, at every phone size the sweep knows.
 *
 * Matt, 2026-10-10, after playing on his phone: *"titlescreen could use a re-work on
 * mobile, lots of overlapping and hard to read elements. it's ok if mobile has a
 * different title."* DEV-894 (the floor), DEV-895 (the edition line clears START) and
 * the plate's lift (the version line clears it) were each one pair of elements at one
 * size. This holds the whole screen at four: every element's box on the glass, from
 * `__ff2.titleLayout()` (the emblem's projected vertices, the edition line's ink, each
 * row's band, the plate's card, the version line's and the mascot's DOM boxes), and no
 * two of them may meet; and every piece of type is over the floor.
 *
 * Each size is its own page load: the game decides it is a phone once, at boot, from
 * the screen (`phoneUi`), so a resize is not a phone of that size.
 *
 * The floors are `src/render/phone-floor.ts`'s, written out as `phone-plates.spec.ts`
 * writes them (a spec imports nothing from `src/` by value), and pinned equal to those
 * by `tests/unit/phone-floor.test.ts`.
 */
import type { Page } from '@playwright/test'
import { bootReady } from './fixtures/boot'
import type { Ff2Global } from './fixtures/ff2'
import { PINNED } from './fixtures/quality-pin'
import { devices, expect, skipSplash, test } from './fixtures/test'
import { titleRowsUp } from './fixtures/title'

const MIN_BODY_TEXT_PX = 12
const MIN_SMALL_TEXT_PX = 9
const MIN_TAP_PX = 32

/** Three phones held sideways (the phone sweep's) and a small one. */
const SIZES = [
  [915, 412], // a Pixel 7
  [844, 390], // an iPhone 14
  [780, 360], // a small Android
  [667, 375], // an iPhone SE
] as const

/** Two boxes closer than this are touching, not clear of each other. */
const GAP_PX = 2

type Layout = NonNullable<Awaited<ReturnType<Ff2Global['__ff2']['titleLayout']>>>
type Box = { l: number; r: number; t: number; b: number }

const meet = (a: Box, b: Box, gap: number): boolean =>
  a.l < b.r + gap && b.l < a.r + gap && a.t < b.b + gap && b.t < a.b + gap

const round = (b: Box): Box => ({
  l: Math.round(b.l),
  r: Math.round(b.r),
  t: Math.round(b.t),
  b: Math.round(b.b),
})

const layoutOf = (page: Page): Promise<Layout | null> =>
  page.evaluate(() => (globalThis as unknown as Ff2Global).__ff2.titleLayout())

test.describe('@gpu a phone title: nothing overlaps, everything over the floor (DEV-902)', () => {
  test.setTimeout(600_000)

  for (const [width, height] of SIZES) {
    test(`${width} x ${height}`, async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width, height },
        screen: { width, height },
        deviceScaleFactor: devices['Pixel 7'].deviceScaleFactor,
        userAgent: devices['Pixel 7'].userAgent,
        isMobile: true,
        hasTouch: true,
      })
      await skipSplash(context)
      const page = await context.newPage()
      await page.addInitScript(() => {
        const g = globalThis as unknown as Record<string, Map<unknown, unknown>>
        g.__ff2TextLog = new Map()
        g.__ff2TextWidth = new Map()
      })
      await page.goto(`/?xr=off&${PINNED}`)
      await bootReady(page, 240_000)
      await titleRowsUp(page)
      await page.waitForTimeout(1_500)
      const at = `${width} x ${height}`

      const layout = await layoutOf(page)
      expect(layout, `${at}: the title reports its layout`).not.toBeNull()
      if (!layout) return
      const { logo, edition, plate, rows, version, mascot, guide } = layout
      const summary = JSON.stringify({
        logo: logo && round(logo),
        edition: edition && round(edition),
        plate: round(plate),
        version: version && round(version),
        mascot: mascot && round(mascot),
        guide: guide && round(guide),
      })
      console.log(`PHONE-TITLE ${at} ${summary}`)
      expect(logo, `${at}: the emblem is on the glass`).not.toBeNull()
      expect(edition, `${at}: the edition line is on the glass`).not.toBeNull()
      expect(version, `${at}: the version line is shown`).not.toBeNull()
      expect(mascot, `${at}: the mascot is shown`).not.toBeNull()
      // A first visit from a phone's browser: DEV-842's card is up, folded to its chip.
      expect(guide, `${at}: the add-to-home-screen chip is shown`).not.toBeNull()
      if (!logo || !edition || !version || !mascot || !guide) return

      const failures: string[] = []
      const named: [string, Box][] = [
        ['emblem', logo],
        ['edition line', edition],
        ['rows plate', plate],
        ['version line', version],
        ['mascot', mascot],
        ['add-to-home-screen chip', guide],
      ]
      // Everything on the glass.
      for (const [name, b] of named) {
        if (b.l < 0 || b.t < 0 || b.r > layout.glass.w || b.b > layout.glass.h)
          failures.push(`${name} runs off the glass ${JSON.stringify(round(b))}`)
      }
      // No two elements meet. The plate's card holds every row, so a row that met
      // another element would have met it through the card first.
      for (let i = 0; i < named.length; i++) {
        for (let j = i + 1; j < named.length; j++) {
          const [an, a] = named[i] as [string, Box]
          const [bn, b] = named[j] as [string, Box]
          if (meet(a, b, GAP_PX))
            failures.push(`${an} meets ${bn} ${JSON.stringify([round(a), round(b)])}`)
        }
      }
      // And the rows are inside their card and do not overlap each other.
      for (const [i, row] of rows.entries()) {
        if (row.t < plate.t - 0.5 || row.b > plate.b + 0.5)
          failures.push(`row ${row.id} is outside its plate`)
        const next = rows[i + 1]
        if (next && next.t < row.b - 0.5) failures.push(`rows ${row.id} and ${next.id} overlap`)
      }

      // The floor: the edition line and the version line are body text.
      if (edition.fontPx < MIN_BODY_TEXT_PX)
        failures.push(`edition line set at ${edition.fontPx.toFixed(1)} px`)
      if (guide.fontPx < MIN_BODY_TEXT_PX)
        failures.push(`add-to-home-screen chip set at ${guide.fontPx.toFixed(1)} px`)
      if (guide.b - guide.t < MIN_TAP_PX)
        failures.push(`add-to-home-screen chip ${(guide.b - guide.t).toFixed(1)} px tall`)
      if (version.fontPx < MIN_BODY_TEXT_PX)
        failures.push(`version line set at ${version.fontPx.toFixed(1)} px`)
      if (mascot.b - mascot.t < MIN_TAP_PX)
        failures.push(`mascot ${(mascot.b - mascot.t).toFixed(1)} px tall`)
      // Each row a tap target.
      for (const row of rows) {
        if (row.b - row.t < MIN_TAP_PX)
          failures.push(`row ${row.id} ${(row.b - row.t).toFixed(1)} px tall`)
      }
      // The rows' type, as the plate set it (`__ff2.uiText()`).
      const plates = await page.evaluate(() => (globalThis as unknown as Ff2Global).__ff2.uiText())
      const menu = plates.find(
        (p) => p.onGlass && (p.name === 'title-menu' || p.name === 'pause') && p.sizes.length,
      )
      expect(menu, `${at}: the rows' type was measured`).toBeDefined()
      if (menu) {
        const body = [...menu.sizes].sort((a, b) => b.chars - a.chars)[0]
        const smallest = menu.sizes[0]
        if (body && body.css < MIN_BODY_TEXT_PX)
          failures.push(`rows' body text ${body.css.toFixed(1)} px`)
        if (smallest && smallest.css < MIN_SMALL_TEXT_PX)
          failures.push(`rows' small text ${smallest.css.toFixed(1)} px`)
      }
      // The first action is START, and it is the first row a phone's eye meets.
      expect(rows[0]?.id, `${at}: START leads`).toBe('hangar')

      await context.close()
      expect(failures, `${at}: ${failures.join(' | ')}`).toEqual([])
    })
  }
})
