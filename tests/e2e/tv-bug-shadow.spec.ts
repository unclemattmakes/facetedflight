/**
 * DEV-903: on the real frame, every shadow on the FF-TV bug falls DOWN and to the
 * RIGHT of what casts it.
 *
 * Matt, 2026-10-10: *"FFTV logo's drop shadow is 'up and left' when it should be
 * 'down and right'"*. The blob was painted down and right on its canvas and still
 * stood 5 px LEFT of the logo at 1080p, because its plane stood behind the gem and
 * the bug sits in the bottom-right corner, where depth pulls a plane up and left.
 * A canvas offset cannot see that; only the camera can. So this reads the fall as
 * the camera projects it (`tvPanel.probe().bugShadows`: the centre of each
 * shadow's ink less its caster's, CSS px, y down), on the exhibition a `?tv` link
 * boards, no sidecar needed.
 *
 *   E2E_PORT=5394 npx playwright test tv-bug-shadow
 */

import { bootReady } from './fixtures/boot'
import type { Ff2Global } from './fixtures/ff2'
import { loadSettled } from './fixtures/landing'
import { PINNED } from './fixtures/quality-pin'
import { E2E_BASE as BASE } from './fixtures/server'
import { expect, skipSplash, test } from './fixtures/test'

test.describe('@gpu the FF-TV bug shadows (DEV-903)', () => {
  test.setTimeout(400_000)
  test('the blob and the TV word shadow both fall down and right on screen', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1920, height: 1080 },
    })
    await skipSplash(context)
    const page = await context.newPage()
    try {
      await page.goto(`${BASE}/?tv&xr=off&${PINNED}`)
      await bootReady(page, 240_000)
      await loadSettled(page)
      // A `?tv` link boards on the page's first press, which the splash skip makes.
      await expect(page.locator('body')).toHaveAttribute('data-first-input', 'true', {
        timeout: 60_000,
      })
      const shadows = () =>
        page.evaluate(
          () => (globalThis as unknown as Ff2Global).__ff2.tvPanel.probe().bugShadows ?? null,
        )
      await expect
        .poll(shadows, { message: 'the bug stands with its shadows', timeout: 240_000 })
        .not.toBeNull()
      // CRYSTAL may land after the bug is built and re-cut the word: read after it settles.
      await page.waitForTimeout(1500)
      const s = await shadows()
      console.info(`DEV-903 bug shadows on screen (CSS px, y down): ${JSON.stringify(s)}`)
      expect(s?.blob.dx, 'the blob falls RIGHT of the logo').toBeGreaterThan(1)
      expect(s?.blob.dy, 'the blob falls BELOW the logo').toBeGreaterThan(1)
      expect(s?.word.dx, 'the TV shadow falls RIGHT of the word').toBeGreaterThan(0.5)
      expect(s?.word.dy, 'the TV shadow falls BELOW the word').toBeGreaterThan(0.5)
    } finally {
      await context.close()
    }
  })
})
