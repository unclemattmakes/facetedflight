/**
 * The LOOK row, end to end: the preset flips from inside the game, and the
 * run survives it.
 *
 * DEV-859: this was the Edition page; its first row is the OPTIONS page's LOOK
 * row now (the row id is still `edition`), pressed in place. `options-menu.test.ts`
 * proves the rows, the press and the persistence. What it cannot see is the
 * plumbing in `app.ts`: that a press on LOOK LOADS the other preset (a lazy
 * import, so it lands a beat later), that the sim stays frozen while the page
 * is up, that BACK goes up one page at a time, and that `?edition=` pins a
 * preset without writing it back.
 *
 * Tagged `@gpu` with the rest of the flying specs: it needs a real GPU to fly
 * at a sane rate, and the row presses are edge-detected against a frame loop.
 */

import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import { hold as keysHold } from './fixtures/keys'
import { firstPress } from './fixtures/landing'
import { pausePlateState, pressPauseRow } from './fixtures/pause-menu'
import { expect, test } from './fixtures/test'

interface Probe {
  elapsed: number
  paused: boolean
  edition: string
  speedFx: number
  /** The raw settings string in storage, or null when nothing was written. */
  stored: string | null
}

const probe = async (page: import('@playwright/test').Page): Promise<Probe> =>
  (await page.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2?: {
        mission: { elapsed: number }
        edition: { current: { id: string }; speedFx: number }
        render: {
          scene: { traverse: (f: (o: { name?: string; visible?: boolean }) => void) => void }
        }
      }
    }
    let paused = false
    w.__ff2?.render.scene.traverse((o) => {
      if (o.name === 'pause') paused = o.visible === true
    })
    let stored: string | null = null
    try {
      stored = localStorage.getItem('ff2.comfort.v1')
    } catch {
      stored = null
    }
    return {
      elapsed: w.__ff2?.mission.elapsed ?? 0,
      paused,
      edition: w.__ff2?.edition.current.id ?? '',
      speedFx: w.__ff2?.edition.speedFx ?? -1,
      stored,
    }
  })) as Probe

/** Held, not tapped — `pause.spec.ts` says why, twice. */
const holdKey = (page: import('@playwright/test').Page, key: string): Promise<void> =>
  keysHold(page, key, { down: 200, settle: 200 })

/** Boot, launch, and wait for the clock to be genuinely moving. */
const flyUntilRunning = async (page: import('@playwright/test').Page, url: string) => {
  await page.goto(url)
  await firstPress(page)
  await missionReady(page, 180_000)
  await focusCanvas(page)
  await holdKey(page, 'Enter')
  await expect
    .poll(async () => (await probe(page)).elapsed, { timeout: 90_000, intervals: [500] })
    .toBeGreaterThan(2)
  const mark = (await probe(page)).elapsed
  await expect
    .poll(async () => (await probe(page)).elapsed, { timeout: 60_000, intervals: [250] })
    .toBeGreaterThan(mark)
}

test.describe('@gpu the edition page', () => {
  test.setTimeout(300_000)

  test('boots on ANNIVERSARY with the speed slider at light, and nothing in storage', async ({
    page,
  }) => {
    await flyUntilRunning(page, '/?autopilot=1&xr=off')
    const p = await probe(page)
    // Matt's call, 2026-09-13 (DEV-078): the curated preset is what a
    // first-time visitor gets, and Classic is one press away.
    expect(p.edition).toBe('anniversary')
    // 'light' resolves to a HALF, not to "a bit".
    expect(p.speedFx).toBe(0.5)
    // A first visit writes nothing: the defaults are not a choice.
    expect(p.stored).toBeNull()
  })

  test('OPTIONS then LOOK flips the preset in place, saves it, and BACK goes one page at a time', async ({
    page,
  }) => {
    await flyUntilRunning(page, '/?autopilot=1&xr=off')

    // ── pause, and go to LOOK by name (DEV-859: it is a row of OPTIONS) ───
    await holdKey(page, 'Backspace')
    expect((await probe(page)).paused).toBe(true)
    // Pressing the row IS the flip: LOOK changes in place, with no page of its own.
    const before = await probe(page)
    expect(before.edition).toBe('anniversary')
    await pressPauseRow(page, 'edition')
    expect((await pausePlateState(page)).page).toBe('options')
    const onPage = await probe(page)
    expect(onPage.paused).toBe(true)

    // ── the preset LOADS a beat later ────────────────────────────────────
    await expect
      .poll(async () => (await probe(page)).edition, { timeout: 10_000, intervals: [100] })
      .toBe('classic')
    const flipped = await probe(page)
    // Saved, under the same key as every other comfort setting.
    expect(flipped.stored).toContain('"edition":"classic"')
    // And the sim is still FROZEN under the page — a flip is not a resume.
    await page.waitForTimeout(1_000)
    expect((await probe(page)).elapsed).toBeCloseTo(flipped.elapsed, 3)

    // ── BACK: OPTIONS' own BACK row goes to the root, then RESUME ───────
    await pressPauseRow(page, 'back', 400)
    expect((await probe(page)).paused).toBe(true)
    expect((await pausePlateState(page)).page).toBe('pause')
    // RESUME, by name, and the clock moves again.
    await pressPauseRow(page, 'resume', 200)
    await expect
      .poll(async () => (await probe(page)).paused, { timeout: 5_000, intervals: [100] })
      .toBe(false)
    const resumed = await probe(page)
    await expect
      .poll(async () => (await probe(page)).elapsed, { timeout: 10_000, intervals: [250] })
      .toBeGreaterThan(resumed.elapsed)
    // Still classic after resuming: the flip outlives the menu.
    expect((await probe(page)).edition).toBe('classic')
  })

  test('?edition= pins a preset for one load and writes nothing back', async ({ page }) => {
    // Pin the NON-default, or the test would pass with the parameter ignored.
    await page.goto('/?autopilot=1&xr=off&edition=classic')
    await firstPress(page)
    await missionReady(page, 180_000)
    const p = await probe(page)
    expect(p.edition).toBe('classic')
    expect(p.stored).toBeNull()
  })
})
