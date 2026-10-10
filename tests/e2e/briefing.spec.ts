/**
 * The mission briefing is up on the pad and for the first half of the ride,
 * and gone by half way up.
 *
 * 2016 shows `panel_mission` from spawn and kills it at 3.8 s. FF2 waits for A
 * instead of a timer (a fixed one would expire while the player was reading),
 * so the claim is about the LAUNCH rather than about a clock, and that is
 * `app.ts` logic no unit test can see.
 *
 * DEV-395 dropped it when the RIDE started (Matt, look call 8: *"keep the
 * motes, drop the briefing during the elevator ride."*). DEV-526 moves the drop
 * to HALF WAY UP (Matt, 2026-09-29: *"half way up the ride"*), by the
 * platform's height, fading over the tenth of the climb before it
 * (`render/briefing.ts`'s `briefingOpacity`). So the samples are taken WHILE
 * the lift rises, each paired with the phase and the height it was taken at,
 * which is the only window in which the rules disagree: a check on the pad or
 * after the release passes under all three.
 */

import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import type { Ff2GlobalMaybe } from './fixtures/ff2'
import { board, hold, INT_01_HOVERJET } from './fixtures/hangar'
import { firstPress } from './fixtures/landing'
import { expect, test } from './fixtures/test'

/** The lift's phase, off the page's own probe (`App.launch()`). */
const launchPhase = async (page: import('@playwright/test').Page): Promise<string | null> =>
  page.evaluate(() => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.launch?.().phase ?? null)

/** The platform's height above the spawn marker, metres, off the same probe. */
const launchRise = async (page: import('@playwright/test').Page): Promise<number> =>
  page.evaluate(
    () => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.launch?.().rise ?? Number.NaN,
  )

const visible = async (page: import('@playwright/test').Page, name: string): Promise<boolean> =>
  page.evaluate((n) => {
    let seen = false
    ;(globalThis as unknown as Ff2GlobalMaybe).__ff2?.render.scene.traverse((o) => {
      if (o.name === n) seen = o.visible === true
    })
    return seen
  }, name)

test.describe('@gpu the mission briefing', () => {
  test.setTimeout(300_000)

  test('is up on the pad and for the first half of the ride, and down from half way up', async ({
    page,
  }) => {
    await page.goto('/?xr=off&title=0')
    await firstPress(page)
    await missionReady(page, 180_000)
    await focusCanvas(page)
    await page.waitForTimeout(1_000)

    // You start in the HANGAR CHAIR now, not the cockpit, and the briefing is a
    // cockpit panel — so board first. `board()` is four presses, one per step:
    // the aircraft, the flight plan, the rank, then the place (`MenuManager`
    // pages ship -> mode -> rank -> challenge, DEV-105/DEV-203). A fifth calls
    // the lift, and it stops before that — `panel_Startup` waits on the pad.
    //
    // ── Why it is a fixture now, and why this spec is the proof ──────────
    //
    // This used to press three times blind, and its own comment said why that
    // was safe: *"the resting pointer is on the aircraft the loaded mission
    // flies, then on its rank, then on the mission itself."* DEV-203 made the
    // slots FIXED — nothing rotates under the pointer, and a step's resting
    // position can legitimately be a dead plate — so a blind press is a press
    // that may do nothing. Five helpers were fixed for that the night DEV-203
    // landed; the e2e run that cleared it was FILTERED to the five specs the
    // menu change was known to touch, and this one was not among them. It
    // stayed red for a day because **CI runs `pnpm check`, not Playwright**
    // (`.github/workflows/`), so a red e2e spec is visible to whoever chooses
    // to run that file and to nobody else.
    await board(page, INT_01_HOVERJET)

    // Waiting on the pad: the briefing is the thing you read.
    expect(await launchPhase(page), 'on the pad').toBe('waiting')
    expect(await visible(page, 'briefing')).toBe(true)

    // The fifth press: call the lift and go. The first launch of a world build
    // RIDES (DEV-094): the ride is on by default and this URL does not cut it,
    // so the phase goes `rising` for ~15.5 s before the countdown.
    await hold(page, 'Enter', 0)
    await expect
      .poll(async () => launchPhase(page), { timeout: 10_000, intervals: [100] })
      .toBe('rising')

    // DEV-526: up for the first half of the climb, down by half way. Sampled
    // across the whole ride, each sample paired with the phase and the height
    // it was taken at, so a sample from the pad or the top cannot pass for one
    // from the ride.
    const during: { phase: string | null; rise: number; briefing: boolean }[] = []
    for (let i = 0; i < 80; i++) {
      const phase = await launchPhase(page)
      if (phase !== 'rising' && during.length > 0) break
      during.push({
        phase,
        rise: await launchRise(page),
        briefing: await visible(page, 'briefing'),
      })
      await page.waitForTimeout(250)
    }
    // At the top the platform stands at the curve's end: that is the ride's height.
    await expect
      .poll(async () => launchPhase(page), { timeout: 10_000, intervals: [100] })
      .not.toBe('rising')
    const top = await launchRise(page)
    console.info(`briefing during the ride (top ${top.toFixed(1)} m): ${JSON.stringify(during)}`)
    const riding = during.filter((s) => s.phase === 'rising')
    const low = riding.filter((s) => s.rise < 0.4 * top)
    const high = riding.filter((s) => s.rise >= 0.5 * top)
    expect(low.length, 'samples in the first 40 % of the climb').toBeGreaterThanOrEqual(4)
    expect(high.length, 'samples past half way').toBeGreaterThanOrEqual(4)
    expect(
      low.filter((s) => !s.briefing),
      'the briefing is up for the first 40 % of the climb',
    ).toEqual([])
    expect(
      high.filter((s) => s.briefing),
      'the briefing is down from half way up',
    ).toEqual([])

    // And it stays down through the countdown and into the run.
    await expect
      .poll(async () => launchPhase(page), { timeout: 30_000, intervals: [500] })
      .toBe('flying')
    expect(await visible(page, 'briefing')).toBe(false)
  })
})
