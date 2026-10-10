/**
 * The title screen, photographed — DEV-155.
 *
 * Matt, 2026-09-16: *"i'd like you to revise the title screen to be more
 * accurate to the original. the rough idea is there, but the details are all
 * wrong."* A fidelity pass's deliverable is a picture, and this screen has
 * twice shipped a bug that every green test agreed with: the jets flew
 * backwards at four pixels across for a whole session (DEV-044), and every e2e
 * assertion on the screen was about positions and counts, all correct.
 *
 * So: fixed frames, saved where Playwright will not wipe them, two runs across
 * a change being a before/after pair.
 *
 *   TITLE_DIR=<dir> E2E_PORT=<yours> pnpm exec playwright test tests/e2e/title-frames.spec.ts
 *
 * Tagged `@gpu`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { bootReady } from './fixtures/boot'
import { firstPress } from './fixtures/landing'
import { watchPageErrors } from './fixtures/page-errors'
import { expect, test } from './fixtures/test'

const OUT_DIR = process.env.TITLE_DIR ?? 'test-results/title-frames'
const EDITIONS = (process.env.TITLE_EDITIONS ?? 'anniversary').split(',')

/**
 * Seconds after the screen settles. **The flypast lap is 23.81 s** — `1 /
 * SplineWalker.Speed`, and the 13 s this used to say was `PASS_SECONDS`, the
 * invented circuit's lap, which has not been the screen since DEV-155.
 *
 * ── Why this SWEEPS the lap instead of naming the close passes ────────────
 *
 * The first attempt at DEV-215 picked three seconds off the measured geometry —
 * the two close passes and one wide shot — and got three frames with **no jet
 * in any of them**. The paths were right and the ships were flying; the frames
 * were simply in the gaps.
 *
 * **This clock is not the flypast's clock.** Zero here is `terrain-ready` plus
 * a settle, and the title's own `clock` starts when the title is built — so the
 * phase between them is whatever that machine's load took, and it moves run to
 * run. A second chosen off the geometry is therefore a second in the LAP, and
 * nothing outside the page knows where in the lap a given wall-clock second
 * falls. Two identical PNGs (same byte count, same content) are what that looks
 * like from outside, which is a reading CLAUDE.md's trap 21 warns is weak in the
 * other direction too.
 *
 * So: eight frames across 24 s, a hair under one full lap. Measured on the
 * shipped paths, something is in frame 68.4 % of the lap and the longest gap
 * with neither ship in it is under 4 s — so a 3-second comb cannot miss, at any
 * phase. Name your own seconds with `TITLE_AT` once you know the offset.
 */
const AT = (process.env.TITLE_AT ?? '1,4,7,10,13,16,19,22').split(',').map(Number)

/**
 * Extra query, for attribution tests. `TITLE_QUERY=fog=off` separates *the fog
 * is wrong* from *something is drawn wrong at fog range* in one run — the
 * thirty-second experiment CLAUDE.md asks for before blaming a system.
 */
const QUERY = process.env.TITLE_QUERY ? `&${process.env.TITLE_QUERY}` : ''

test.describe('@measure @gpu title frames', () => {
  test.setTimeout(600_000)

  for (const edition of EDITIONS) {
    test(`photographs the title screen — ${edition}`, async ({ page }) => {
      const problems = watchPageErrors(page)
      const dir = path.join(OUT_DIR, edition)
      fs.mkdirSync(dir, { recursive: true })
      await page.goto(`/?xr=off&edition=${edition}${QUERY}`)
      await firstPress(page)
      // `bootReady`, not `data-terrain-ready`: this URL boots the TITLE screen,
      // and since DEV-281 that builds no mission world. See `fixtures/boot.ts`.
      await bootReady(page, 180_000)
      await page.waitForTimeout(2_000)
      let waited = 0
      for (const at of AT) {
        await page.waitForTimeout(Math.max(0, at * 1_000 - waited))
        waited = at * 1_000
        const shot = await page.locator('#viewport').screenshot()
        fs.writeFileSync(path.join(dir, `t${String(at).padStart(2, '0')}s.png`), shot)
      }
      expect(problems.list(), 'page errors (a shader that failed to compile lands here)').toEqual(
        [],
      )
    })
  }
})
