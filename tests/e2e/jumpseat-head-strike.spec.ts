/**
 * DEV-403: 2016's JumpSeat head strike, on the player's own route.
 *
 * `JumpSeat_Photon.prefab`'s `collider_head` carries `Trigger_Reset`: the
 * pilot's head touches anything, the gameplay fader fades out, a second later
 * the scene reloads and the run starts again. Matt, 2026-09-25: exactly that,
 * on both presets. The rule is `sim/jumpseat-head.ts` and it is pinned headless
 * (`tests/unit/jumpseat-head.test.ts`); what only the real app can show is the
 * part `boot/app.ts` owns — the banner, the curtain and the restart — and that
 * it is wired to the flight the player is actually flying.
 *
 * The strike is a player's mistake, made with a player's keys: after GO, hold
 * the throttle and the stick forward. The seat pitches over and drives itself
 * head-first into the ground — about 3 s, measured headless — and nothing on
 * the harness side reaches into the sim to make it happen.
 *
 * What is pinned:
 *
 *   · the head strike starts (`flight.headStrike.phase` goes to `dying`) with
 *     the run's clock already running;
 *   · the curtain comes down over it;
 *   · a second later the run restarts — a fresh countdown, the clock at 0, the
 *     rule back to `ok` — and the curtain lifts;
 *   · the app's own receipts for both, on the console.
 *
 * `@gpu` because it drives the real renderer through the real menus; take the
 * GPU lease (`tools/agent/gpu.sh`) before running it.
 */

import { bootReady } from './fixtures/boot'
import { dropFocus } from './fixtures/canvas'
import { board, type Course } from './fixtures/hangar'
import { firstPress } from './fixtures/landing'
import { expect, type Page, test } from './fixtures/test'
import { pressTitleRow, TITLE_ROW } from './fixtures/title'

/** A beginner's course, named on all four axes as `fixtures/hangar.ts` asks. */
const ROOKIE_02_JUMPSEAT: Course = {
  vehicle: 'jumpseat',
  mode: 'targetPractice',
  rank: 'beginner',
  id: 'rookie_02_jumpSeat',
}

interface Probe {
  /** `mission.elapsed`, the run clock. */
  readonly elapsed: number
  /** `flight.countdownHolds` — true until `Trigger_EnableJumpShip` fires. */
  readonly holds: boolean | null
  /** `flight.headStrike.phase`, or null on a flight that has none. */
  readonly head: string | null
  /** The screen fade: 0 clear, 1 black. */
  readonly curtain: number
  readonly inMenu: boolean
}

const probe = (page: Page): Promise<Probe> =>
  page.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2?: {
        mission: { elapsed: number }
        flight: () => {
          countdownHolds?: boolean
          headStrike?: { phase: string }
        } | null
        fade: () => { amount: number }
        stage: () => { name: string }
      }
    }
    const f = w.__ff2?.flight() ?? null
    return {
      elapsed: w.__ff2?.mission.elapsed ?? -1,
      holds: f?.countdownHolds ?? null,
      head: f?.headStrike?.phase ?? null,
      curtain: w.__ff2?.fade().amount ?? -1,
      inMenu: w.__ff2?.stage().name === 'menu',
    }
  })

test.describe('@gpu DEV-403: the JumpSeat head strike', () => {
  test.setTimeout(600_000)

  test('a seat flown head-first into the ground restarts the run behind the curtain', async ({
    page,
  }) => {
    const logs: string[] = []
    page.on('console', (m) => logs.push(m.text()))

    await page.goto('/?xr=off')
    await firstPress(page)
    await bootReady(page, 180_000)
    await dropFocus(page)
    await page.waitForTimeout(1_500)

    // ── title → hangar → the four steps → aboard ─────────────────────────
    await pressTitleRow(page, TITLE_ROW.hangar) // DEV-441: Single Player, then Hangar
    await board(page, ROOKIE_02_JUMPSEAT)
    await expect
      .poll(async () => (await probe(page)).inMenu, { timeout: 15_000, intervals: [100] })
      .toBe(false)
    const aboard = await probe(page)
    expect(aboard.head, 'a JumpSeat flight answers headStrike').toBe('ok')

    // ── GO, and a second of the run on the clock ──────────────────────────
    await expect
      .poll(async () => (await probe(page)).holds, { timeout: 60_000, intervals: [250] })
      .toBe(false)
    await expect
      .poll(async () => (await probe(page)).elapsed, { timeout: 10_000, intervals: [100] })
      .toBeGreaterThan(1)

    // ── the mistake: throttle and stick forward, held ─────────────────────
    await page.keyboard.down('Space')
    await page.keyboard.down('KeyW')
    await expect
      .poll(async () => (await probe(page)).head, { timeout: 20_000, intervals: [50] })
      .toBe('dying')
    const struck = await probe(page)
    await page.keyboard.up('KeyW')
    await page.keyboard.up('Space')
    expect(struck.elapsed, 'the run was under way when the head went in').toBeGreaterThan(1)

    // ── Trigger_Reset's curtain, then the reload ──────────────────────────
    await expect
      .poll(async () => (await probe(page)).curtain, { timeout: 3_000, intervals: [50] })
      .toBeGreaterThan(0.5)
    await expect
      .poll(
        async () => {
          const p = await probe(page)
          return p.holds === true && p.elapsed === 0 && p.head === 'ok'
        },
        { timeout: 5_000, intervals: [50] },
      )
      .toBe(true)
    await expect
      .poll(async () => (await probe(page)).curtain, { timeout: 5_000, intervals: [100] })
      .toBeLessThan(0.05)

    // ── and the app said so ───────────────────────────────────────────────
    expect(logs.some((l) => l.includes("head strike — the pilot's head touched something"))).toBe(
      true,
    )
    expect(logs.some((l) => l.includes('head strike — run restarted at the respawn marker'))).toBe(
      true,
    )
  })
})
