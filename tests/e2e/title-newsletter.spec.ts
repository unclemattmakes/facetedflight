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
import { splashGone } from './fixtures/boot'
import { expect, test } from './fixtures/test'
import { pressTitleRow, type TitleMenuProbe, titleMenu, titleRowsUp } from './fixtures/title'

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
  await titleRowsUp(page)
  // DEV-872: the rows come up at the splash fade's START, and a click inside
  // the fade is swallowed (a player's first click skips the splash), so this
  // spec clicked a row the game was not yet taking: red alone, and green only
  // when the fade happened to end before the click. DEV-901.
  await splashGone(page)
  const m = (await titleMenu(page)) as TitleMenuProbe
  const at = m.rowsAt?.[m.rows.indexOf(ROW)]
  expect(at, 'the title says where the row is').toBeTruthy()
  // DEV-901: the plate a spec polled from load was placed for three rows and
  // ran 20 px off a 720 px frame; the plate a player sees ends on the glass.
  expect(
    m.plateBottom ?? Number.POSITIVE_INFINITY,
    'the plate ends on the glass',
  ).toBeLessThanOrEqual(page.viewportSize()?.height ?? 0)
  const popup = page.waitForEvent('popup')
  if (at) await page.mouse.click(at.x, at.y)
  expect((await popup).url()).toBe(NEWSLETTER_URL)
})
