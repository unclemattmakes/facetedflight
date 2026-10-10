/**
 * `?snap=<seconds>` — the sim stops and the renderer does not.
 *
 * `snap.test.ts` proves the trigger is a correct predicate. It says nothing
 * about whether the sim actually STOPS, which is the entire point of the switch
 * and lives in `app.ts`'s frame loop rather than in a pure function — the same
 * split, and the same sentence, as `pause.spec.ts`'s opening.
 *
 * It is the same claim as the pause's, too, because it is the same mechanism:
 * zero wall time into `stepFixed`. So this spec is deliberately `pause.spec.ts`
 * in shape, down to `holdKey` and the poll-for-the-clock rather than
 * wait-for-the-wall. What it adds is the half the pause does not have — the
 * FRAME keeps coming, which is what makes a screenshot at a chosen tick possible
 * at all (ANNIVERSARY.md §4.3, §7).
 *
 * Tagged `@gpu` with the rest: it needs a real GPU to fly at a sane rate.
 */

import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import { hold as keysHold } from './fixtures/keys'
import { firstPress } from './fixtures/landing'
import { expect, test } from './fixtures/test'

/** Seconds of MISSION time. Early enough that the run is well under way. */
const SNAP_AT = 12

/**
 * How far past the mark the clock may be.
 *
 * One fixed step is 0.0122 s (D4), so the freeze lands somewhere in
 * [12, 12.0122) and can never be exact. 0.05 is four steps of slack — wide
 * enough that this is a check on the FREEZE and not on the step size, which
 * `snap.test.ts` asserts against `FIXED_DT` directly.
 */
const TOLERANCE = 0.05

interface Probe {
  elapsed: number
  frozen: boolean
  at: number | null
  pauseVisible: boolean
}

const probe = async (page: import('@playwright/test').Page): Promise<Probe> =>
  (await page.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2?: {
        mission: { elapsed: number }
        snap: () => { at: number | null; frozen: boolean }
        render: {
          scene: { traverse: (f: (o: { name?: string; visible?: boolean }) => void) => void }
        }
      }
    }
    let pauseVisible = false
    w.__ff2?.render.scene.traverse((o) => {
      if (o.name === 'pause') pauseVisible = o.visible === true
    })
    const snap = w.__ff2?.snap()
    return {
      // The SIM's own clock, the number the freeze is supposed to stop. Same
      // probe as `pause.spec.ts` and for the same reason: a dataset attribute
      // is written by a render pass and answers a different question.
      elapsed: w.__ff2?.mission.elapsed ?? 0,
      frozen: snap?.frozen ?? false,
      at: snap?.at ?? null,
      pauseVisible,
    }
  })) as Probe

/**
 * Held, not tapped. The confirm input is a LEVEL read once a frame, so a press
 * that lands entirely between two frames is a press the game never saw. Third
 * spec to learn it; see `pause.spec.ts`.
 */
const holdKey = (page: import('@playwright/test').Page, key: string): Promise<void> =>
  keysHold(page, key, { down: 200, settle: 200 })

test.describe('@gpu ?snap', () => {
  test.setTimeout(300_000)

  test('freezes the sim at the mark, keeps rendering, and shows no menu', async ({ page }) => {
    // `?autopilot=1` because a snap is only useful if it is REPEATABLE — the
    // autopilot decides on the fixed step (DEV-027), so the same URL reaches the
    // same tick with the ship in the same place on every load, which is the
    // whole premise of an A/B pair. `xr=off` keeps the boot probe from starting
    // SteamVR on every run.
    await page.goto(`/?autopilot=1&xr=off&snap=${SNAP_AT}`)
    await firstPress(page)
    await missionReady(page, 180_000)
    await focusCanvas(page)
    await holdKey(page, 'Enter')

    // The switch arrived at all. A typo in the URL is ignored by design
    // (`parseSnap`), so a spec that only waited for `frozen` would hang for its
    // whole timeout and report a freeze that never fired as a timeout.
    expect((await probe(page)).at).toBe(SNAP_AT)

    // Wait for the FREEZE, not for the wall. The launch elevator is a 15.5 s
    // ride during which `stepFixed` is skipped entirely (DEV-024b), so the
    // mission clock does not start when the page does.
    await expect
      .poll(async () => (await probe(page)).frozen, { timeout: 180_000, intervals: [250] })
      .toBe(true)

    const frozen = await probe(page)
    // On the mark, within one fixed step.
    expect(frozen.elapsed).toBeGreaterThanOrEqual(SNAP_AT)
    expect(frozen.elapsed).toBeLessThanOrEqual(SNAP_AT + TOLERANCE)

    // ── and it STAYS there ───────────────────────────────────────────────
    //
    // Two wall seconds. This is the assertion the spec exists for: a clock that
    // merely hesitated between ticks would pass the reading above.
    await page.waitForTimeout(2_000)
    const still = await probe(page)
    expect(still.frozen).toBe(true)
    expect(still.elapsed).toBeCloseTo(frozen.elapsed, 6)

    // ── a snap is a photograph, not a pause ──────────────────────────────
    //
    // The plate must not be in the frame. `snapped` is its own flag precisely
    // so `flight.pause.setVisible` cannot see it; if the two were ever merged
    // into one boolean, every A/B frame would have a menu across it.
    expect(still.pauseVisible).toBe(false)

    // ── and the renderer is still running ────────────────────────────────
    //
    // The other half of "freezes the SIM, not the frame". A screenshot is what
    // this switch is for, so taking one is the honest test: it goes through the
    // same compositor path `viewpoints.spec.ts` uses, and a dead loop or a lost
    // context fails it.
    const shot = await page.locator('#viewport').screenshot()
    expect(shot.byteLength).toBeGreaterThan(1_000)
    // Not into `test-results/` — Playwright wipes that at the start of every
    // run, which loses the first half of any A/B taken across two runs
    // (ANNIVERSARY.md §7). The pair goes somewhere chosen by the person taking
    // it; this attachment is only evidence that a frame came out at all.
    await test.info().attach(`snap-${SNAP_AT}s.png`, { body: shot, contentType: 'image/png' })
  })

  test('an ordinary run never freezes', async ({ page }) => {
    // The `null` case, which every normal load takes on every frame. It is the
    // most-executed line in `snap.ts` and the one whose failure would look like
    // a mission that mysteriously stopped.
    await page.goto('/?autopilot=1&xr=off')
    await firstPress(page)
    await missionReady(page, 180_000)
    await focusCanvas(page)
    await holdKey(page, 'Enter')

    await expect
      .poll(async () => (await probe(page)).elapsed, { timeout: 90_000, intervals: [500] })
      .toBeGreaterThan(2)

    const running = await probe(page)
    expect(running.at).toBe(null)
    expect(running.frozen).toBe(false)
    // And it is still moving, watched rather than inferred — `pause.spec.ts`'s
    // lesson, where comparing two later reads compared a number to itself.
    await expect
      .poll(async () => (await probe(page)).elapsed, { timeout: 60_000, intervals: [250] })
      .toBeGreaterThan(running.elapsed)
  })
})
