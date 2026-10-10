/**
 * The controls page — the one document in this game that a person checks
 * within seconds of it being wrong.
 *
 * ── Why it needs a spec at all ───────────────────────────────────────────
 *
 * `control-scheme.test.ts` already holds the page's TEXT against the readers:
 * if the boost row says `L2`, then L2 must boost. What that cannot see is
 * whether the page is LEGIBLE — `pause.ts` right-aligns the value column
 * against a left-aligned label on one baseline, so a long label and a long
 * value on the same row collide silently, and the only symptom is two words
 * overlapping in a headset.
 *
 * This page has the longest labels in the game ("INVERT PITCH", "SLOW DOWN")
 * and the longest values ("RIGHT STICK"), and it made the pause plate six rows
 * deep for the first time. So: drive to it the way a player does, and take a
 * picture.
 *
 * Tagged `@gpu` with the other pause specs: it needs a real GPU to fly at a
 * sane rate, and a picture of software-rasterised text proves nothing.
 */

import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import type { Ff2Global, Ff2GlobalMaybe } from './fixtures/ff2'
import { hold as keysHold } from './fixtures/keys'
import { firstPress } from './fixtures/landing'
import { pressPauseRow } from './fixtures/pause-menu'
import { expect, test } from './fixtures/test'

/**
 * Held, not tapped. The pause toggle is edge-detected against a level read once
 * a frame, so a `press()` landing between two frames is a press the game never
 * saw — `pause.spec.ts` and `lap.spec.ts` both carry this note.
 */
const holdKey = (page: import('@playwright/test').Page, key: string): Promise<void> =>
  keysHold(page, key, { down: 200, settle: 200 })

/**
 * Is the pause plate on screen?
 *
 * Visibility ONLY, and it stays that way. It used to be the whole instrument,
 * and its own comment said why it could not be more — *"a probe that pretended
 * to read a title it cannot see would rot into a green assertion about
 * nothing"* — which was right about the probe and wrong as a place to stop:
 * the answer was to make the state readable, not to read less of it. That is
 * `plateState` below (DEV-223). The two answer different questions and both
 * are needed: this one is drawn-or-not, that one is what it is drawing.
 */
const plateUp = async (page: import('@playwright/test').Page): Promise<boolean> =>
  (await page.evaluate(() => {
    const w = globalThis as unknown as Ff2GlobalMaybe
    let up = false
    w.__ff2?.render.scene.traverse((o) => {
      const node = o as { name?: string; visible?: boolean }
      if (node.name === 'pause') up = node.visible === true
    })
    return up
  })) as boolean

/**
 * WHICH page the plate is turned to, and its rows — `__ff2.pausePlate()`.
 *
 * `page` is `pause` for the plate and otherwise the id of the row that opened
 * the page, so a spec names the row it wants and is told whether it arrived.
 *
 * The ids are written out as LITERALS here rather than imported from
 * `@/render/pause`, deliberately: one import edge from a Playwright file into
 * `src/` reaches `import.meta.glob` through the boot graph and takes the whole
 * e2e COLLECTION to zero, which exits looking like a clean run.
 */
const plateState = async (
  page: import('@playwright/test').Page,
): Promise<{ page: string; rows: { id: string }[] }> =>
  await page.evaluate(() => {
    const w = globalThis as unknown as Ff2Global
    return w.__ff2.pausePlate()
  })

test.describe('@gpu the controls page', () => {
  test.setTimeout(300_000)

  test('opens from the pause plate and is readable', async ({ page }) => {
    await page.goto('/?autopilot=1&xr=off')
    await firstPress(page)
    await missionReady(page, 180_000)
    await focusCanvas(page)
    await holdKey(page, 'Enter')

    // Under way, rather than six seconds in: DEV-024b's 15.5 s lift skips
    // `stepFixed`, so a fixed wait can land mid-ride with the clock unstarted.
    await expect
      .poll(
        async () =>
          (await page.evaluate(
            () => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.mission.elapsed ?? 0,
          )) as number,
        { timeout: 90_000, intervals: [500] },
      )
      .toBeGreaterThan(2)

    await holdKey(page, 'Backspace')
    await page.waitForTimeout(300)
    expect(await plateUp(page), 'the plate is up').toBe(true)

    // ── down to CONTROLS, and in ─────────────────────────────────────────
    //
    // Name the target, compute the walk. This used to be `i < 4` with a comment
    // conceding the dependency — *"if a row is inserted above CONTROLS the
    // count here is wrong, and the screenshot will say so, loudly, because it
    // will be a picture of the comfort page"* — and the loud part was a human
    // looking at a PNG. The spec itself went green: it opened the comfort page,
    // asserted the plate was up (true of every page), and wrote the picture.
    // A `4` is a row INDEX written as a number of keypresses, against a list
    // whose length has moved more than once.
    //
    // `pauseAim` opens at 0 and each press steps one row, so the index IS the
    // press count — read off the live rows, which is the same list the clamp
    // and the hit test use.
    //
    // ArrowDown is "down the list" on every device now; it was not, for the
    // pad, until DEV-071.
    // DEV-621: CONTROLS is on OPTIONS now; `pressPauseRow` goes there by name.
    const plate = await plateState(page)
    expect(plate.page, 'the plate itself, before we go anywhere').toBe('pause')
    await pressPauseRow(page, 'controls')

    // WHICH page, not just "a page". The walk landing on the wrong row is now
    // a red spec rather than a misleading screenshot nobody opens.
    expect((await plateState(page)).page, 'the CONTROLS page opened').toBe('controls')
    expect(await plateUp(page), 'still up after opening the page').toBe(true)
    await page.screenshot({ path: 'test-results/controls-page.png' })

    // ── and BACK is the way out, not RESUME ──────────────────────────────
    //
    // A player who opens this by accident has to leave the way they came in.
    // DEV-621: BACK by name, and it lands one page up, on OPTIONS.
    await pressPauseRow(page, 'back', 400)
    expect(await plateUp(page), 'back on the pause plate, not in the run').toBe(true)
    // BACK and not RESUME: the page closed and left the PLATE up, rather than
    // dropping the player into the run. "Still up" alone cannot tell those
    // apart — the plate is up on either page — and that was the whole gap.
    expect((await plateState(page)).page, 'OPTIONS, one page up').toBe('options')
    // And Backspace goes back one more, to the root, without resuming.
    await holdKey(page, 'Backspace')
    expect((await plateState(page)).page, 'the root plate').toBe('pause')
    expect(await plateUp(page), 'still paused').toBe(true)
  })
})
