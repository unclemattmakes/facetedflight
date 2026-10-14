/**
 * The pause menu, end to end — and the one thing a unit test cannot see.
 *
 * `pause-menu.test.ts` proves the hit test picks the right row. It says nothing
 * about whether pausing actually STOPS anything, which is the entire point of
 * the feature and lives in `app.ts`'s frame loop rather than in the panel.
 *
 * Tagged `@gpu` with the rest: it needs a real GPU to fly at a sane rate.
 */

import { missionReady } from './fixtures/boot'
import {
  captureCanvas,
  dropPointer,
  focusCanvas,
  pauseIsOpen,
  pointerIsLocked,
} from './fixtures/canvas'
import { hold as keysHold } from './fixtures/keys'
import { firstPress } from './fixtures/landing'
import { openOptions, pausePlateState, pressPauseRow } from './fixtures/pause-menu'
import { expect, test } from './fixtures/test'

interface Probe {
  elapsed: number
  rings: string | undefined
  paused: boolean
}

const probe = async (page: import('@playwright/test').Page): Promise<Probe> =>
  (await page.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2?: {
        mission: { elapsed: number }
        render: {
          scene: { traverse: (f: (o: { name?: string; visible?: boolean }) => void) => void }
        }
      }
    }
    let paused = false
    w.__ff2?.render.scene.traverse((o) => {
      if (o.name === 'pause') paused = o.visible === true
    })
    return {
      // The SIM's own clock, not a wall clock and not a dataset attribute that
      // a render pass might still be writing. This is the number the pause is
      // supposed to stop.
      elapsed: w.__ff2?.mission.elapsed ?? 0,
      rings: document.body.dataset.rings,
      paused,
    }
  })) as Probe

/**
 * Held, not tapped — and this is the second time the suite has learned it.
 *
 * The pause toggle is edge-detected against a LEVEL read once a frame, so a
 * `keyboard.press()` that lands entirely between two frames is a press the game
 * never saw. It fails intermittently rather than always, which is worse:
 * `lap.spec.ts` carries the same note about Enter.
 */
// Long enough for the release to be seen too, so the next press is an edge.
const holdKey = (page: import('@playwright/test').Page, key: string): Promise<void> =>
  keysHold(page, key, { down: 200, settle: 200 })

test.describe('@gpu the pause menu', () => {
  test.setTimeout(300_000)

  test('stops the run, and resumes it', async ({ page }) => {
    await page.goto('/?autopilot=1&xr=off')
    await firstPress(page)
    await missionReady(page, 180_000)
    await focusCanvas(page)
    await holdKey(page, 'Enter')

    // Wait for the run to be genuinely UNDER WAY, rather than for six seconds.
    //
    // DEV-024b restored the 15.5 s elevator ride, and during it `stepFixed` is
    // skipped — so a fixed wait can land mid-lift with the clock still at its
    // starting value, and the "the clock moved" assertion below then compares a
    // number to itself. It failed exactly that way once and passed on retry,
    // which is the worst kind of green.
    await expect
      .poll(async () => (await probe(page)).elapsed, { timeout: 90_000, intervals: [500] })
      .toBeGreaterThan(2)
    // And prove it is RUNNING by watching it MOVE, rather than by comparing two
    // reads later and hoping. `setAnimationLoop` stops when the tab is
    // backgrounded, so a headed run that loses focus freezes the sim — and the
    // old check ("the clock is further on after pausing than before") then
    // compared a number to itself and failed intermittently. What it meant to
    // say was "it was running", and this says that directly.
    const mark = (await probe(page)).elapsed
    await expect
      .poll(async () => (await probe(page)).elapsed, { timeout: 60_000, intervals: [250] })
      .toBeGreaterThan(mark)
    const flying = await probe(page)
    expect(flying.paused).toBe(false)

    // ── Backspace pauses ─────────────────────────────────────────────────
    await holdKey(page, 'Backspace')
    await expect.poll(async () => (await probe(page)).paused, { timeout: 5_000 }).toBe(true)
    const justPaused = await probe(page)
    expect(justPaused.paused).toBe(true)
    // That the run got somewhere is established above, by watching the clock
    // move. Comparing these two reads adds nothing and cannot be relied on:
    // between them lies only the keypress.
    expect(justPaused.elapsed).toBeGreaterThanOrEqual(flying.elapsed)

    // ── and the sim is actually FROZEN, not merely covered ───────────────
    await page.waitForTimeout(3_000)
    const stillPaused = await probe(page)
    expect(stillPaused.paused).toBe(true)
    // Three wall seconds with the clock stopped. This is the assertion the
    // whole spec exists for: 2016's pause does NOT stop its race timer, so
    // "the panel is up" and "the run is stopped" are genuinely separate claims.
    expect(stillPaused.elapsed).toBeCloseTo(justPaused.elapsed, 3)

    // ── Backspace again resumes, and the clock moves ─────────────────────
    await holdKey(page, 'Backspace')
    // Resumed AND the clock a second on: the state the two assertions below read.
    await expect
      .poll(
        async () => {
          const p = await probe(page)
          return !p.paused && p.elapsed > stillPaused.elapsed + 1
        },
        { timeout: 20_000, intervals: [100] },
      )
      .toBe(true)
    const resumed = await probe(page)
    expect(resumed.paused).toBe(false)
    expect(resumed.elapsed).toBeGreaterThan(stillPaused.elapsed + 1)
  })

  test('RESUME is selected by default, so a blind press is safe', async ({ page }) => {
    // The menu opens on the safe option. A player who pauses by accident and
    // mashes A must land back in the run, not at the start of a new one — which
    // would silently bin a good lap.
    await page.goto('/?autopilot=1&xr=off')
    await firstPress(page)
    await missionReady(page, 180_000)
    await focusCanvas(page)
    await holdKey(page, 'Enter')
    // Same reason as above: wait for the clock, not for the wall.
    await expect
      .poll(async () => (await probe(page)).elapsed, { timeout: 90_000, intervals: [500] })
      .toBeGreaterThan(2)
    const before = await probe(page)

    await holdKey(page, 'Backspace')
    expect((await probe(page)).paused).toBe(true)

    // Confirm without touching the stick: takes RESUME.
    await holdKey(page, 'Enter')
    // Resumed and the clock past where it was: both facts the assertions below read.
    await expect
      .poll(
        async () => {
          const p = await probe(page)
          return !p.paused && p.elapsed > before.elapsed
        },
        { timeout: 20_000, intervals: [100] },
      )
      .toBe(true)

    const after = await probe(page)
    expect(after.paused).toBe(false)
    // The run CONTINUED rather than restarting: the clock is past where it was,
    // not back near zero.
    expect(after.elapsed).toBeGreaterThan(before.elapsed)
  })

  test('DEV-563: Escape pauses, whether the pointer was captured or free', async ({ page }) => {
    // Captured, Chrome spends a player's Escape on letting go and the page sees
    // only the capture ending: `dropPointer` is that release, as the page sees
    // it. Free, Escape is a key. The first only ever opens; the second toggles.
    await page.goto('/?autopilot=1&xr=off')
    await firstPress(page)
    await missionReady(page, 180_000)
    await focusCanvas(page)
    expect(await pauseIsOpen(page), 'focusCanvas closes the menu its release opened').toBe(false)
    await holdKey(page, 'Enter')
    await expect
      .poll(async () => (await probe(page)).elapsed, { timeout: 90_000, intervals: [500] })
      .toBeGreaterThan(2)

    const capture = async (): Promise<void> => {
      await captureCanvas(page)
      await expect.poll(() => pointerIsLocked(page), { timeout: 5_000 }).toBe(true)
    }

    // ── captured: the release opens the menu, and the sim stops ──────────
    await capture()
    expect((await probe(page)).paused).toBe(false)
    await dropPointer(page)
    await expect.poll(() => pauseIsOpen(page), { timeout: 5_000 }).toBe(true)
    const frozen = (await probe(page)).elapsed
    await page.waitForTimeout(1_000)
    expect((await probe(page)).elapsed).toBeCloseTo(frozen, 3)

    // ── free: Escape closes it, and opens it again ───────────────────────
    await holdKey(page, 'Escape')
    expect(await pauseIsOpen(page), 'a free Escape closes').toBe(false)
    await holdKey(page, 'Escape')
    expect(await pauseIsOpen(page), 'and opens').toBe(true)

    // ── a release while the menu is up leaves it up ──────────────────────
    // The plate is aimed with the captured mouse, so a player reading it holds
    // the pointer. The click that takes it presses nothing (`readClick`).
    await capture()
    expect(await pauseIsOpen(page), 'the capturing click pressed nothing').toBe(true)
    await dropPointer(page)
    await page.waitForTimeout(300)
    expect(await pauseIsOpen(page), 'a lost capture never closes').toBe(true)

    // ── and out, with the clock moving again ─────────────────────────────
    await holdKey(page, 'Escape')
    expect(await pauseIsOpen(page)).toBe(false)
    const resumedAt = (await probe(page)).elapsed
    await expect
      .poll(async () => (await probe(page)).elapsed, { timeout: 10_000, intervals: [250] })
      .toBeGreaterThan(resumedAt)

    // ── Backspace, 2016's key, is untouched ──────────────────────────────
    await holdKey(page, 'Backspace')
    expect(await pauseIsOpen(page)).toBe(true)
    await holdKey(page, 'Backspace')
    expect(await pauseIsOpen(page)).toBe(false)
  })

  test('DEV-563 follow-up: the free cursor selects a pause row by hovering and presses it with a click', async ({
    page,
  }) => {
    // On the pad, before the launch: a live mission, so the plate is the
    // in-flight plate, and nothing has to fly for it.
    await page.goto('/?autopilot=1&xr=off')
    await firstPress(page)
    await missionReady(page, 180_000)
    await focusCanvas(page)
    await captureCanvas(page)
    await expect.poll(() => pointerIsLocked(page), { timeout: 5_000 }).toBe(true)
    await dropPointer(page)
    await expect.poll(() => pauseIsOpen(page), { timeout: 5_000 }).toBe(true)

    // Find the rows by moving the cursor down the middle of the canvas and
    // reading which row the plate selects: the game's own picker answers, so
    // nothing here computes where a row is drawn.
    const box = await page.locator('#viewport').boundingBox()
    if (!box) throw new Error('the canvas has no box')
    const x = box.x + box.width / 2
    // The plate opens on RESUME, so a row is FOUND when the selection changes
    // to it: down the canvas until row 2, then back up until row 0.
    expect((await plateNow(page)).rows, 'the plate has rows to hover').toBeGreaterThan(2)
    const seen: number[] = []
    let second: number | undefined
    for (let y = box.y + box.height * 0.3; y < box.y + box.height * 0.98; y += 8) {
      await page.mouse.move(x, y)
      await page.waitForTimeout(60)
      const selected = (await plateNow(page)).selected
      if (seen.at(-1) !== selected) seen.push(selected)
      if (selected === 2) {
        second = y
        break
      }
    }
    expect(second, `hovering reached row 2 (saw ${seen.join(', ')})`).toBeDefined()
    let resume: number | undefined
    for (let y = second as number; y > box.y; y -= 8) {
      await page.mouse.move(x, y)
      await page.waitForTimeout(60)
      if ((await plateNow(page)).selected === 0) {
        resume = y
        break
      }
    }
    expect(resume, 'and back up to row 0, RESUME').toBeDefined()

    // A hover selects, and selects only: the plate stays up, nothing pressed.
    await page.mouse.move(x, second as number)
    await expect.poll(async () => (await plateNow(page)).selected, { timeout: 2_000 }).toBe(2)
    expect(await pauseIsOpen(page)).toBe(true)

    // A click on RESUME presses it, and takes no capture.
    await page.mouse.move(x, resume as number)
    await expect.poll(async () => (await plateNow(page)).selected, { timeout: 2_000 }).toBe(0)
    await page.mouse.click(x, resume as number)
    await expect.poll(() => pauseIsOpen(page), { timeout: 5_000 }).toBe(false)
    expect(await pointerIsLocked(page), 'the click on a row captured nothing').toBe(false)

    // After Resume, the next click on the world captures, as always.
    await captureCanvas(page)
    await expect.poll(() => pointerIsLocked(page), { timeout: 5_000 }).toBe(true)
    expect(await pauseIsOpen(page), 'and presses nothing').toBe(false)
  })

  test('DEV-563 follow-up: with the lookdev panel open, Escape frees the pointer and pauses nothing', async ({
    page,
  }) => {
    await page.goto('/?autopilot=1&xr=off&lookdev=1')
    await firstPress(page)
    await missionReady(page, 180_000)
    await focusCanvas(page)
    // L shows the panel (it starts hidden).
    await holdKey(page, 'KeyL')
    await captureCanvas(page)
    await expect.poll(() => pointerIsLocked(page), { timeout: 5_000 }).toBe(true)
    await dropPointer(page)
    await page.waitForTimeout(500)
    expect(await pauseIsOpen(page), 'the release opened nothing').toBe(false)
    await holdKey(page, 'Escape')
    expect(await pauseIsOpen(page), 'nor did a free Escape').toBe(false)
    // Backspace is still the pause key.
    await holdKey(page, 'Backspace')
    expect(await pauseIsOpen(page)).toBe(true)
  })

  test('DEV-621/623: OPTIONS then CREDITS rolls, and back goes one page at a time', async ({
    page,
  }) => {
    // Matt, 2026-10-03: "add a "credits" panel to the options screen". And
    // 2026-10-04: pages, and "credits should scroll the text upwards, like
    // film credits".
    await page.goto('/?autopilot=1&xr=off')
    await firstPress(page)
    await missionReady(page, 180_000)
    await focusCanvas(page)
    await holdKey(page, 'Enter')
    await expect
      .poll(async () => (await probe(page)).elapsed, { timeout: 90_000, intervals: [500] })
      .toBeGreaterThan(2)
    await holdKey(page, 'Backspace')
    expect(await pauseIsOpen(page)).toBe(true)

    // DEV-621: the root is resume, restart, options, exit, and EXIT is last.
    const root = await pausePlateState(page)
    expect(root.rows.map((r) => r.id)).toEqual(['resume', 'restart', 'options', 'exit'])
    await openOptions(page)
    const options = await pausePlateState(page)
    expect(options.title).toBe('- OPTIONS -')
    expect(options.rows.map((r) => r.id)).toEqual([
      'mute',
      'volume',
      'invert',
      'edition',
      'comfort',
      'controls',
      'more',
      'back',
    ])

    // DEV-859: CREDITS is a door of MORE, one page in.
    await pressPauseRow(page, 'more', 400)
    const more = await pausePlateState(page)
    expect(more.title).toBe('- MORE -')
    expect(more.rows.map((r) => r.id)).toEqual([
      'quality',
      'racestrip',
      'advanced',
      'credits',
      'reportbug',
      'back',
    ])
    // DEV-623: CREDITS is a roll over one row, BACK, and nothing selected.
    await pressPauseRow(page, 'credits', 400)
    const credits = await pausePlateState(page)
    expect(credits.page).toBe('credits')
    expect(credits.title).toBe('- CREDITS -')
    expect(credits.rows.map((r) => r.id)).toEqual(['back'])
    expect(credits.selected, 'nothing selected: A speeds the roll').toBe(-1)
    const rolled = async () => (await pausePlateState(page)).rolled ?? -1
    const r0 = await rolled()
    await page.waitForTimeout(1_000)
    const r1 = await rolled()
    expect(r1, 'the roll climbs on its own').toBeGreaterThan(r0)
    // A press is not a row: it speeds the roll and the page stays up.
    await page.keyboard.down('Enter')
    await page.waitForTimeout(1_000)
    const r2 = await rolled()
    await page.keyboard.up('Enter')
    expect(r2 - r1, 'held A runs it faster than a second alone').toBeGreaterThan(r1 - r0)
    expect((await pausePlateState(page)).page).toBe('credits')

    // Backspace goes back ONE page, to MORE on CREDITS, to OPTIONS on MORE,
    // then to the root on OPTIONS, and only then resumes.
    await holdKey(page, 'Backspace')
    const up0 = await pausePlateState(page)
    expect(up0.page).toBe('more')
    expect(up0.rows[up0.selected]?.id).toBe('credits')
    await holdKey(page, 'Backspace')
    const up1 = await pausePlateState(page)
    expect(up1.page).toBe('options')
    expect(up1.rows[up1.selected]?.id).toBe('more')
    await holdKey(page, 'Backspace')
    const up2 = await pausePlateState(page)
    expect(up2.page).toBe('pause')
    expect(up2.rows[up2.selected]?.id).toBe('options')
    expect(await pauseIsOpen(page)).toBe(true)
    await holdKey(page, 'Backspace')
    expect(await pauseIsOpen(page), 'from the root, back resumes').toBe(false)
  })
})

/** The pause plate's own probe: how many rows, and which is selected. */
const plateNow = async (
  page: import('@playwright/test').Page,
): Promise<{ rows: number; selected: number }> =>
  page.evaluate(() => {
    const plate = (
      globalThis as unknown as {
        __ff2: { pausePlate: () => { rows: unknown[]; selected: number } }
      }
    ).__ff2.pausePlate()
    return { rows: plate.rows.length, selected: plate.selected }
  })
