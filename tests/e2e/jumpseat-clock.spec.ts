/**
 * DEV-343: a JumpSeat run's clock starts at GO, and never runs in the hangar.
 *
 * The bug, as the 2026-09-24 playtest found it on the player's own route —
 * `/?xr=off` → title → hangar → JumpSeat → Target Practice → Beginner →
 * `rookie_02_jumpSeat`: the clock read 0.4 s at boarding and 10.4 s after ten
 * idle seconds with nothing pressed; Pause → Exit reset it to ~1.4 and it went
 * on counting in the menu, so twenty seconds in the hangar and a re-board showed
 * 24.1 s on the clock with no pads. The results time and the stored best carried
 * the menu.
 *
 * The mechanism: all six JumpSeat levels have no `spawn.launch`, so the launch
 * rests at `flying` from the first tick, and the lift's early return in
 * `boot/app.ts` — the only thing that held a run — never held one. In the hangar
 * the seat ran its whole `Trigger_EnableJumpShip` countdown, went live and fell
 * onto its rig while `stepMission` counted.
 *
 * What is pinned, on the route a player takes and with nothing switched off:
 *
 *   · at boarding the clock is 0, and it STAYS 0 through the 7.5 s countdown
 *     (Matt, 2026-09-24: the clock starts at GO, as the HoverJet's does);
 *   · the first reading after GO is small — the clock started at GO, not before;
 *   · after Pause → Exit it is 0, and ten seconds in the hangar change nothing:
 *     not the clock, not the countdown, not where the seat is;
 *   · re-boarding the SAME course — the door that boards without a restart,
 *     which is how the menu's seconds reached the results — starts at 0 again.
 *
 * `@gpu` because it drives the real renderer through the real menus; take the
 * GPU lease (`tools/agent/gpu.sh`) before running it.
 */

import { bootReady, switchSettled } from './fixtures/boot'
import { dropFocus } from './fixtures/canvas'
import { board, type Course, hangarAim, hold, lookUntilAimed } from './fixtures/hangar'
import { firstPress } from './fixtures/landing'
import { expect, type Page, test } from './fixtures/test'
import { pressTitleRow, TITLE_ROW } from './fixtures/title'

/** The playtest's course, named on all four axes as `fixtures/hangar.ts` asks. */
const ROOKIE_02_JUMPSEAT: Course = {
  vehicle: 'jumpseat',
  mode: 'targetPractice',
  rank: 'beginner',
  id: 'rookie_02_jumpSeat',
}

interface Probe {
  /** `mission.elapsed`, the run clock the HUD, the results and the best all read. */
  readonly elapsed: number
  /** `flight.countdownHolds` — true until `Trigger_EnableJumpShip` fires. */
  readonly holds: boolean | null
  /** The seat's SIM position, to prove the run did not step. */
  readonly seat: readonly [number, number, number] | null
  /** The hangar is the stage being drawn — `App.stage()`'s own answer. */
  readonly inMenu: boolean
}

const probe = (page: Page): Promise<Probe> =>
  page.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2?: {
        mission: { elapsed: number }
        flight: () => {
          countdownHolds?: boolean
          jet: { body: { position: { x: number; y: number; z: number } } }
        } | null
        stage: () => { name: string }
      }
    }
    const f = w.__ff2?.flight() ?? null
    const p = f?.jet.body.position
    return {
      elapsed: w.__ff2?.mission.elapsed ?? -1,
      holds: f?.countdownHolds ?? null,
      seat: p ? ([p.x, p.y, p.z] as [number, number, number]) : null,
      inMenu: w.__ff2?.stage().name === 'menu',
    }
  })

/**
 * Wait for the cockpit. The boarding press queues the screen change behind the
 * fade, so the world can be ready a beat before the room is gone.
 */
const inCockpit = async (page: Page): Promise<void> => {
  await expect
    .poll(async () => (await probe(page)).inMenu, { timeout: 15_000, intervals: [100] })
    .toBe(false)
}

/**
 * Board from whichever step the room is showing.
 *
 * `board()` walks all four from the aircraft, which is where a fresh room opens.
 * A room you come BACK to keeps the step you left (`hangar.refresh`, "keeping
 * the step and the place you are on"), so the second boarding starts wherever
 * that is and walks the rest, aimed, one press a step.
 */
const boardFromHere = async (page: Page, course: Course): Promise<void> => {
  const steps = [
    ['vehicles', course.vehicle],
    ['modes', course.mode],
    ['ranks', course.rank],
    ['courses', course.id],
  ] as const
  const view = (await hangarAim(page))?.view
  const from = Math.max(
    0,
    steps.findIndex(([v]) => v === view),
  )
  for (const [view, want] of steps.slice(from)) {
    expect((await hangarAim(page))?.view, `on the ${view} step`).toBe(view)
    expect(await lookUntilAimed(page, want), `found ${want} on the ${view} arc`).toBe(true)
    await hold(page, 'Enter')
  }
  await switchSettled(page, 180_000)
}

/**
 * Sample the countdown until it lets go, asserting the clock is 0 at every
 * sample on the way, and return the first reading after GO.
 */
const clockThroughCountdown = async (page: Page, label: string): Promise<Probe> => {
  const deadline = Date.now() + 60_000
  let samples = 0
  for (;;) {
    const p = await probe(page)
    if (p.holds === false) {
      expect(samples, `${label}: the countdown was observed before GO`).toBeGreaterThan(3)
      return p
    }
    expect(p.holds, `${label}: a JumpSeat flight answers countdownHolds`).toBe(true)
    expect(p.elapsed, `${label}: the clock is still during the countdown`).toBe(0)
    samples++
    if (Date.now() > deadline) throw new Error(`${label}: GO never came`)
    await page.waitForTimeout(250)
  }
}

test.describe('@gpu DEV-343: the JumpSeat run clock', () => {
  test.setTimeout(600_000)

  test('starts at GO, and the hangar is never on it', async ({ page }) => {
    await page.goto('/?xr=off')
    await firstPress(page)
    await bootReady(page, 180_000)
    // The title is a real press since DEV-301; arrive and stay there.
    await dropFocus(page)
    await page.waitForTimeout(1_500)

    // ── title → hangar → the four steps → aboard ─────────────────────────
    await pressTitleRow(page, TITLE_ROW.hangar) // DEV-441: Single Player, then Hangar
    await board(page, ROOKIE_02_JUMPSEAT)
    await inCockpit(page)

    const aboard = await probe(page)
    expect(aboard.inMenu, 'aboard: in the cockpit').toBe(false)
    expect(aboard.elapsed, 'aboard: the clock has not started').toBe(0)
    expect(aboard.holds, 'aboard: the seat is in its countdown').toBe(true)

    // ── through the countdown to GO ──────────────────────────────────────
    const go = await clockThroughCountdown(page, 'first boarding')
    // Sampled every 250 ms of wall time, so GO is at most a sample or two
    // behind — anything near the 7.5 s countdown means the clock ran through it.
    expect(go.elapsed, 'the clock started AT GO').toBeLessThan(1.5)
    await expect
      .poll(async () => (await probe(page)).elapsed, { timeout: 30_000, intervals: [500] })
      .toBeGreaterThan(2)

    // ── Pause → Exit, back to the chair ──────────────────────────────────
    //
    // Saturate down onto EXIT rather than count rows — the pause menu grows
    // (`walkthrough.spec.ts` has the history).
    await hold(page, 'Backspace')
    for (let i = 0; i < 8; i++) await hold(page, 'ArrowDown', 150)
    await hold(page, 'Enter')
    await expect
      .poll(async () => (await probe(page)).inMenu, { timeout: 15_000, intervals: [250] })
      .toBe(true)
    const back = await probe(page)
    expect(back.elapsed, 'the run was reset on the way out').toBe(0)
    expect(back.holds, 'and the seat is back in its countdown').toBe(true)

    // ── ten seconds in the hangar: nothing of the run moves ──────────────
    await page.waitForTimeout(10_000)
    const later = await probe(page)
    expect(later.inMenu, 'still in the hangar').toBe(true)
    expect(later.elapsed, 'the hangar is not on the clock').toBe(0)
    expect(later.holds, 'the countdown did not run in the hangar').toBe(true)
    expect(later.seat, 'the seat did not move in the hangar').toEqual(back.seat)

    // ── the SAME course again: the door that boards without a restart ────
    await boardFromHere(page, ROOKIE_02_JUMPSEAT)
    await inCockpit(page)
    const again = await probe(page)
    expect(again.inMenu, 're-boarded: in the cockpit').toBe(false)
    expect(again.elapsed, 're-boarded: nothing carried over').toBe(0)
    expect(again.holds, 're-boarded: a fresh countdown').toBe(true)
    const goAgain = await clockThroughCountdown(page, 're-boarding')
    expect(goAgain.elapsed, 'the clock started AT GO again').toBeLessThan(1.5)
  })
})
