/**
 * tests/e2e/title-newsletter.spec.ts: the title's JOIN THE FLIGHT CLUB row
 * opens the newsletter's signup page in a new tab, and the title stays up.
 * DEV-658.
 *
 * Why a browser: the press is polled in the frame loop, AFTER the key's or the
 * click's event, so whether the browser still lets the page open a tab is a
 * question about the browser's user activation, which no unit test can ask.
 * The tab's request is answered here, so the run never reaches the real site.
 */

import { NEWSLETTER_URL } from '@/net/newsletter'
import { expect, test } from './fixtures/test'
import { pressTitleRow, titleMenu, titleRowsUp } from './fixtures/title'

const ROW = 'newsletter'

test.beforeEach(async ({ context }) => {
  await context.route('https://unclemattmakes.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>signup</title>' }),
  )
})

test('a held Enter on the row opens the signup page in a new tab', async ({ page }) => {
  await page.goto('/?xr=off')
  const popup = page.waitForEvent('popup')
  await pressTitleRow(page, ROW)
  expect((await popup).url()).toBe(NEWSLETTER_URL)
  const m = await titleRowsUp(page)
  expect(m.rows.at(-1), 'the row is last on the plate').toBe(ROW)
  expect((await titleMenu(page))?.up, 'the title is still up').toBe(true)
})

test('a click on the row opens it too', async ({ page }) => {
  await page.goto('/?xr=off')
  const m = await titleRowsUp(page)
  const at = m.rowsAt?.[m.rows.indexOf(ROW)]
  expect(at, 'the title says where the row is').toBeTruthy()
  const popup = page.waitForEvent('popup')
  if (at) await page.mouse.click(at.x, at.y)
  expect((await popup).url()).toBe(NEWSLETTER_URL)
})
