/**
 * tests/e2e/pause-phone.spec.ts: the pause plate fits a phone held sideways. DEV-796.
 *
 * Matt, 2026-10-07 ("go with your recs", QUESTIONS item 23): at a Pixel 7's
 * 412 px landscape height the OPTIONS page ended on the bottom edge, its
 * footer on the glass's last pixels and the panel's lower border cut off
 * (DEV-595's photographs found it and left it).
 *
 * What is asserted is GEOMETRY, as `phone-refit.spec.ts` argues for its own
 * rule: the panel's top and bottom edges, projected through the camera the
 * frame drew with (`__ff2.pausePlate().edges`), lie inside the glass with a
 * margin, on the root page and on the longest page, OPTIONS (seven rows).
 * A screenshot needs an eye to tell "touching the edge" from "just inside".
 */

import { switchSettled } from './fixtures/boot'
import { firstPress } from './fixtures/landing'
import { pausePlateState } from './fixtures/pause-menu'
import { PINNED } from './fixtures/quality-pin'
import { devices, expect, test } from './fixtures/test'

/** A Pixel 7 held sideways, field by field for `mobile-controls.spec.ts`'s reason. */
const PHONE = {
  viewport: { width: 915, height: 412 },
  deviceScaleFactor: devices['Pixel 7'].deviceScaleFactor,
  userAgent: devices['Pixel 7'].userAgent,
  isMobile: true,
  hasTouch: true,
}

/** Css pixels of glass the panel must leave under its lower border. */
const MARGIN = 6

test.describe('the pause plate on a Pixel 7, held sideways (DEV-796) @gpu', () => {
  test.use(PHONE)
  test.setTimeout(300_000)

  test('every page is inside the glass, the longest one included', async ({ page }) => {
    await page.goto(`/?autopilot=1&ride=0&mission=int_01_hoverJet&xr=off&${PINNED}`)
    await firstPress(page, { tap: true })
    await switchSettled(page, 180_000)
    await page.waitForTimeout(2_000)
    await page.locator('#touch-controls [data-act="pause"]').tap()
    await expect
      .poll(async () => (await pausePlateState(page)).open, { timeout: 10_000 })
      .toBe(true)
    await page.waitForTimeout(500)

    const dir = process.env.PAUSE_PHONE_DIR
    const read = async (name: string) => {
      const state = await pausePlateState(page)
      const edges = state.edges
      expect(edges, `${name}: the plate reports its edges`).toBeTruthy()
      if (dir) await page.screenshot({ path: `${dir}/${name}.png` })
      return { rows: state.rows.length, ...(edges as NonNullable<typeof edges>) }
    }

    const root = await read('root')
    // By TAP, as the phone's owner does: a key press would make the last
    // device the keyboard, and the lift is the touch device's.
    const optionsRow = (await pausePlateState(page)).rows.findIndex((r) => r.id === 'options')
    expect(optionsRow, 'the root plate has an OPTIONS row').toBeGreaterThanOrEqual(0)
    await page.touchscreen.tap(root.x, root.rowY[optionsRow] as number)
    await expect
      .poll(async () => (await pausePlateState(page)).page, { timeout: 10_000 })
      .toBe('options')
    await page.waitForTimeout(500)
    const options = await read('options')
    // The premise: OPTIONS is the long page, and the glass is the phone's.
    expect(options.rows).toBeGreaterThan(root.rows)
    expect(options.glass).toBeLessThan(450)
    for (const [name, e] of [
      ['root', root],
      ['options', options],
    ] as const) {
      expect(e.top, `${name}: the top edge is on the glass`).toBeGreaterThan(0)
      expect(e.bottom, `${name}: the bottom edge clears the glass by a margin`).toBeLessThanOrEqual(
        e.glass - MARGIN,
      )
    }
  })
})
