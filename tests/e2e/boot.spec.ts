/**
 * Boot smoke test — the app comes up, paints, and says nothing alarming.
 *
 * Runs HEADED by default against a dev server this suite starts itself (see
 * playwright.config.ts). Headed matters for anything that touches the GPU:
 * headless Chromium falls back to SwiftShader, which turns real shader work
 * into single-digit fps and makes GPU specs flaky (king-tide hard rule 2).
 * This particular spec is cheap enough to run either way.
 *
 * First executed 2026-09-09 — with `E2E_CHANNEL=chrome`, because the bundled
 * Chrome-for-Testing build will not start on this machine (Windows
 * side-by-side configuration error). docs/vr-testing.md §"When Playwright
 * won't start a browser".
 */
import fs from 'node:fs'
import { titleVr } from './fixtures/landing'
import { watchPageErrors } from './fixtures/page-errors'
import { expect, test } from './fixtures/test'
import { titleRowsUp } from './fixtures/title'

/**
 * `package.json`'s `version`, read off disk rather than imported from
 * `@/boot/version`.
 *
 * That module evaluates `import.meta.env.MODE` at module scope, which is Vite's
 * and not node's, and an import edge from a Playwright spec into `src/` has
 * already cost this suite a whole collection once. `fs` cannot reach either.
 *
 * Disk work at COLLECTION time is the other hazard here and this one is safe
 * for a reason, not by luck: `package.json` is tracked, so it is present in
 * every checkout — unlike the gitignored trees whose absence in CI is what
 * `describe.skipIf` exists for. `route-sweep.spec.ts` and
 * `spawn-clearing.spec.ts` read tracked files the same way.
 */
const PKG_VERSION = (JSON.parse(fs.readFileSync('package.json', 'utf8')) as { version: string })
  .version

test('boots, paints the landing page, and reports no console errors', async ({ page }) => {
  // This test waits for a WORLD (the `data-load` assertion below), and Playwright's
  // per-test default is 30 s — which the inline 180 s on that assertion cannot
  // override, because the test is killed before the expect budget is spent.
  // Measured 2026-09-17 over three runs: this test takes **27.0–28.4 s** of that
  // 30 s. It was green on 1.6 to 3.0 seconds of margin, which is not a pass, it
  // is a coin that had not landed yet. See `xr-entry.spec.ts`'s `test.setTimeout`
  // for the same line and the same reason.
  test.setTimeout(180_000)
  const problems = watchPageErrors(page)

  await page.goto('/')

  // The PUBLIC name. Matt, 2026-09-11: *"anything public facing, let's call
  // the port 'faceted flight: 10th anniversary edition'"*. The repo and the
  // internal docs still say "Faceted Flight 2"; that name belongs to the
  // sequel, which is a different project on top of this engine.
  //
  // This was an `<h1>` until DEV-278 cut the landing copy, and DEV-279's
  // addendum retired it as a duplicate — *"the 3D logo is right there"*.
  // **Half true, and the false half is this assertion's entire subject**
  // (DEV-284). The logo is 2016's `logo_polys.fbx`, so it reads FACETED
  // FLIGHT: it duplicates the GAME's name and not the EDITION's, and the
  // suffix that makes the name public was only ever in the `<h1>`.
  // `render/title.ts` does build a canvas subtitle reading "10TH ANNIVERSARY
  // EDITION" — but it is `visible = !opts.logo`, the stand-in monument's
  // text, on screen only when the GLB fails to load. Asserting it would pin
  // the failure path.
  //
  // So `<title>` was, when this was written, the ONE place the shipped build
  // stated the public name — and it is the right place to pin it either way: a
  // tab, a bookmark, a search result and a pasted link all show it, which is
  // most of what "public facing" means for something you reach by URL. It also
  // keeps the claim inside the CI-safe subset: this is one of the few specs
  // with no `@gpu` tag.
  //
  // **DEV-285 then put the edition name back on screen** (Matt, same day:
  // *"change the 'Press Start' text to '10th Anniversary Edition'"*), on the
  // PROMPT plane rather than the hidden `wordmark`. Two consequences, and
  // neither changes this line:
  //   - the "only place" half of the argument above is dead; the CI-safety
  //     half is untouched and is sufficient on its own;
  //   - the strapline renders whether or not the GLB arrives, so asserting it
  //     through `__ff2` would NOT pin the failure path any more. That is a
  //     genuinely stronger claim, available at the cost of a `@gpu` tag and
  //     this spec's place in the `E2E_SKIP_GPU=1` subset. Deliberately not
  //     taken — see the DEV-284 addendum for the trade.
  // `document.title` comes from index.html and DEV-285 touches a canvas
  // texture, so the two cannot interact.
  await expect(page).toHaveTitle('Faceted Flight: 10th Anniversary Edition')
  await expect(page.locator('#viewport')).toBeVisible()

  // The build version is written by src/boot/version.ts, not by the HTML:
  // `main.ts` states it as `body[data-build]` (DEV-614; it was the footer's
  // `#build-version` until the credit line left the title for the pause
  // plate's CREDITS page).
  await expect(page.locator('body')).toHaveAttribute('data-build', /^v\d+\.\d+\.\d+$/)

  // …and the shape alone could not say so until DEV-315: a placeholder of the
  // right shape would have passed. There is no placeholder now (the HTML has
  // no attribute until `main.ts` writes one), and the VALUE is asserted too.
  // `tests/unit/build-version.test.ts` refuses `0.0.0` for `package.json` for
  // ever, so a stale or default version fails here.
  await expect(page.locator('body')).toHaveAttribute('data-build', `v${PKG_VERSION}`)

  // The page is READY once the first world is (DEV-107): not once `bootApp()`
  // has resolved, which is 4.5 s earlier on a warm local server and 31 s
  // earlier on a throttled one. That used to be the landing card's Start
  // button going enabled; since DEV-557 there is no card, and `data-load` is
  // the same fact. The long timeout is the terrain generator's.
  await expect(page.locator('body')).toHaveAttribute('data-load', 'ready', { timeout: 180_000 })
  // And the title is usable the moment it is (Matt, 2026-10-01: "it's
  // confusing that the game can be fully functional, yet the curtain is still
  // up"): its rows are up with no press, and nothing stands over them.
  await titleRowsUp(page)
  await expect(page.locator('#boot-failure')).toBeHidden()
  // DEV-614 (Matt, 2026-10-03: "that's where credits should live (not the
  // footer of the title)"): no credit footer on the title. It is the pause
  // plate's CREDITS page, which `pause.spec.ts` opens and reads.
  await expect(page.locator('#credits')).toHaveCount(0)
  // ...and one line in its place, the version beside the copyright (Matt: "show
  // version number on the title screen, same line as copyright"), centred along
  // the bottom. Measured off a Range over the WORDS: the box spans the safe
  // width by design and is centred whatever its text does.
  const line = page.locator('#title-line')
  await expect(line).toBeVisible()
  await expect(line).toHaveText(`v${PKG_VERSION} · © 2016 and 2026, Uncle Matt Makes`)
  const words = await page.evaluate(() => {
    const range = document.createRange()
    range.selectNodeContents(document.getElementById('title-line') as HTMLElement)
    const r = range.getBoundingClientRect()
    return { left: r.left, right: r.right, bottom: r.bottom, w: innerWidth, h: innerHeight }
  })
  expect(
    Math.abs((words.left + words.right) / 2 - words.w / 2),
    `the line's words are centred (${JSON.stringify(words)})`,
  ).toBeLessThan(3)
  expect(words.h - words.bottom, 'the line sits at the bottom').toBeLessThan(40)

  // ENTER VR reads "Enter VR" only if isSessionSupported('immersive-vr')
  // actually resolved true, and "Connect VR headset" otherwise: a desktop
  // Chromium with no runtime reports false, so an ENTER VR here is the
  // capability gate failing open. (tests/e2e/xr-entry.spec.ts drives both
  // branches deliberately.) The plate is a state, not a disabled button, so
  // the old "disabled for the not-loaded reason OR the headset reason"
  // conjunction is gone: the load is asserted above and this is the headset.
  const xrSupported = await page.evaluate(async () => {
    try {
      return (await navigator.xr?.isSessionSupported('immersive-vr')) === true
    } catch {
      return false
    }
  })
  await expect
    .poll(async () => (await titleVr(page))?.state ?? null)
    .toBe(xrSupported ? 'enter' : 'connect')
  expect((await titleVr(page))?.shown, 'the ENTER VR plate is drawn on a desktop').toBe(true)

  expect(problems.list(), problems.list().join('\n')).toEqual([])
})
