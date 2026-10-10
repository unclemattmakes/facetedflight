/**
 * DEV-611: the developer splash, "Uncle Matt Makes: ___" over a load bar.
 *
 * Matt, 2026-10-03: *"the splash should be like a "loading into the app"
 * screen - so for all visitors making their first visit of the session. allow
 * them to skip if pressing A (or clicking or tapping) and the scene is
 * loaded"*. Three facts, one test each:
 *
 *  1. A fresh session gets it, it lands on Faceted Flight, its bar fills, and
 *     it goes by itself to a title whose rows are up.
 *  2. Once the scene is loaded a press skips it, and that press does NOT also
 *     press the title's START (which would board the hangar).
 *  3. A reload paints it again (DEV-872: every load, nothing remembered).
 *
 * Every other spec skips it with a press once loaded (`fixtures/test.ts`),
 * which is what a player does, not a switch the game was given; this file opts
 * out of that and meets it as a visitor does.
 */

import { splashGone } from './fixtures/boot'
import { hangarAim, hold } from './fixtures/hangar'
import { knownRed } from './fixtures/known-red'
import { watchPageErrors } from './fixtures/page-errors'
import { expect, type Page, test } from './fixtures/test'
import { titleMenu, titleRowsUp } from './fixtures/title'

/** The splash's last word, `SPLASH_WORDS.at(-1)` (a spec does not import `src/`). */
const LAST_WORD = 'Faceted Flight'

const splashPhase = (page: Page): Promise<string | null> => page.getAttribute('body', 'data-splash')

test.describe('the developer splash (DEV-611)', () => {
  // Every other spec skips the splash with a press (`fixtures/test.ts`); this
  // one is about meeting it.
  test.use({ skipsSplash: false })
  test.setTimeout(180_000)

  test('a fresh session sees it type out to Faceted Flight, fill its bar and go to the title', async ({
    page,
  }) => {
    knownRed('KR-15')
    const problems = watchPageErrors(page)
    await page.goto('/?xr=off')

    // Up from the first paint, in the page's own HTML.
    await expect(page.locator('#dev-splash')).toBeVisible()
    expect(await splashPhase(page)).toBe('up')
    await expect(page.locator('.dev-splash__mark')).toContainText('Uncle Matt Makes:')
    // In Bitter (Matt's pick), from the bundle: the face is LOADED, not merely
    // named in the stack with Georgia standing in for it.
    await expect(page.locator('#dev-splash')).toHaveClass(/is-faced/, { timeout: 5_000 })
    expect(await page.evaluate(() => document.fonts.check('700 1em Bitter'))).toBe(true)
    expect(
      await page.evaluate(() =>
        [...document.fonts].some((f) => f.family.includes('Bitter') && f.status === 'loaded'),
      ),
    ).toBe(true)

    // The round mascot, as in the site's header (Matt: "make sure to get the
    // round mascot portrait in there as well"), loaded off the bucket.
    const portrait = page.locator('.dev-splash__portrait')
    await expect(portrait).toHaveClass(/is-loaded/, { timeout: 10_000 })
    expect(await portrait.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(384)

    // DEV-624: typed, not slid. Watch the blank for two seconds from the
    // page: it only ever shows a prefix of a word, one letter more or less a
    // frame, and a word is DELETED (its letters fall) before the next is typed.
    const typed = page.locator('.dev-splash__typed')
    const words = await page.locator('.dev-splash__sizer').allTextContents()
    expect(words.at(-1)).toBe(LAST_WORD)
    const watch = await typed.evaluate(
      (el, all) =>
        new Promise<{ prefixes: boolean; deleted: boolean; typed: boolean }>((resolve) => {
          let prefixes = true
          let deleted = false
          let typedUp = false
          let prev = { word: '', n: -1 }
          const t0 = performance.now()
          const look = (): void => {
            const word = el.dataset.word ?? ''
            const text = el.textContent ?? ''
            const full = all[Number(word)] ?? ''
            if (!full.startsWith(text)) prefixes = false
            if (word === prev.word && text.length < prev.n) deleted = true
            if (word === prev.word && text.length > prev.n) typedUp = true
            prev = { word, n: text.length }
            if (performance.now() - t0 < 2000) requestAnimationFrame(look)
            else resolve({ prefixes, deleted, typed: typedUp })
          }
          look()
        }),
      words,
    )
    expect(watch).toEqual({ prefixes: true, deleted: true, typed: true })

    // It lands on the game, typed in full, and is not deleted.
    await expect(typed).toHaveAttribute('data-word', String(words.length - 1), { timeout: 20_000 })
    await expect(typed).toHaveAttribute('data-filled', 'true', { timeout: 5_000 })
    await expect(typed).toHaveText(LAST_WORD)

    // It goes by itself once the title is in, and the bar was full when it did.
    // The bar is sampled from here, not from title-ready: on a loaded box the
    // title can be ready after the hold has run out, and a poll that starts
    // then never sees the splash up at all.
    let lastBar = 0
    await expect
      .poll(
        async () => {
          const phase = await splashPhase(page)
          if (phase === 'up') {
            lastBar = Number(
              (await page.locator('.dev-splash__bar').getAttribute('aria-valuenow')) ?? 0,
            )
          }
          return phase
        },
        { timeout: 150_000, message: 'the splash leaves once loaded and held' },
      )
      .not.toBe('up')
    await page.waitForSelector('body[data-title-ready="true"]', { timeout: 150_000 })
    expect(lastBar).toBeGreaterThan(90)
    await expect(page.locator('body')).toHaveAttribute('data-splash', 'gone', { timeout: 5_000 })
    await expect(page.locator('#dev-splash')).toHaveCount(0)

    // And the title is the one it was in front of, rows up.
    const menu = await titleRowsUp(page)
    expect(menu.up).toBe(true)
    expect(problems.list(), problems.list().join('\n')).toEqual([])
  })

  test('a press once loaded skips it, and is not also a press on the title', async ({ page }) => {
    await page.goto('/?xr=off')
    await page.waitForSelector('body[data-title-ready="true"]', { timeout: 150_000 })
    // The press only has something to skip while the hold is still running.
    // A load slower than the typing and its 2.5 s hold (a cold server) has
    // already taken the splash down, and that is the other branch of the rule,
    // proven by the test above; say which happened rather than pass silently.
    test.skip(
      (await splashPhase(page)) !== 'up',
      `the title loaded after the hold, so the splash was already ${await splashPhase(page)}: nothing to skip`,
    )

    const pressedAt = Date.now()
    await hold(page, 'Enter', 0)
    await splashGone(page, 2_000)
    const tookMs = Date.now() - pressedAt
    // Well inside the hold it would otherwise have sat out.
    expect(tookMs).toBeLessThan(1_500)

    // The press did not board the hangar: the title is up with its rows, and
    // stays up after a beat long enough for a press to have travelled.
    await titleRowsUp(page)
    await page.waitForTimeout(1_500)
    expect((await titleMenu(page))?.up).toBe(true)
    expect((await hangarAim(page))?.screen ?? 'title').not.toBe('menu')
  })

  test('a reload shows it again: every load, not once a session (DEV-872)', async ({ page }) => {
    await page.goto('/?xr=off')
    await page.waitForSelector('body[data-title-ready="true"]', { timeout: 150_000 })
    await splashGone(page)

    await page.reload()
    // Painted from the page's own HTML, up, with nothing remembered.
    await expect(page.locator('#dev-splash')).toBeVisible()
    expect(await splashPhase(page)).toBe('up')
    await page.waitForSelector('body[data-title-ready="true"]', { timeout: 150_000 })
    await splashGone(page, 30_000)
    await expect(page.locator('#dev-splash')).toHaveCount(0)
  })
})
