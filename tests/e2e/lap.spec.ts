/**
 * M4's exit gate: a scripted lap, and the score it produces.
 *
 * PORT_PLAN M4: *"Playwright completes a scripted lap and asserts the score."*
 * `?autopilot=1` is deterministic run to run, so the lap is repeatable and this
 * is the regression that protects the reward surface (the gate count, the time
 * bonus and the results panel), none of which any unit test can see end to end.
 *
 * DEV-601: a run the autopilot flew any of earns NO medal and keeps NO best, so
 * this spec now asserts that branch end to end: `none` for the medal, nothing
 * written under the best's key, and a stored best left alone. The other branch,
 * a run the player's own keys flew to a medal and a stored best, is
 * `player-course-share.spec.ts`'s first test.
 *
 * Tagged `@gpu` with the rest: it needs a real GPU to fly at a sane rate.
 */

import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import { firstPress } from './fixtures/landing'
import { expect, test } from './fixtures/test'

/** Long, because the run itself is ~70 s of flying plus the terrain build. */
const LAP_TIMEOUT = 240_000

interface Probe {
  finished: string | undefined
  medal: string | undefined
  score: string | undefined
  best: string | undefined
  rings: string | undefined
  panelVisible: boolean
}

const probe = async (page: import('@playwright/test').Page): Promise<Probe> =>
  (await page.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2?: {
        render: {
          scene: { traverse: (f: (o: { name?: string; visible?: boolean }) => void) => void }
        }
      }
    }
    let panelVisible = false
    w.__ff2?.render.scene.traverse((o) => {
      if (o.name === 'results') panelVisible = o.visible === true
    })
    const d = document.body.dataset
    return {
      finished: d.finished,
      medal: d.medal,
      score: d.finalScore,
      best: d.best,
      rings: d.rings,
      panelVisible,
    }
  })) as Probe

/** Held for a few frames — the confirm input is a level, read once a frame. */
const confirmPress = async (page: import('@playwright/test').Page): Promise<void> => {
  await page.keyboard.down('Enter')
  await page.waitForTimeout(200)
  await page.keyboard.up('Enter')
}

test.describe('@gpu a scripted lap', () => {
  test.setTimeout(600_000)

  test('flies the course, scores it, and offers another go', async ({ page }) => {
    await page.goto('/?autopilot=1&xr=off')
    await firstPress(page)
    await missionReady(page, 180_000)

    // Nothing on the board before the run.
    expect((await probe(page)).panelVisible).toBe(false)

    await focusCanvas(page)
    // ENTER, not Space. `CONFIRM_KEYS` is `['Enter', 'NumpadEnter']` and Space
    // is bound to nothing — three specs pressed Space for a week and the runs
    // started anyway, because `?autopilot=1` launches itself (app.ts:1284).
    // Held, not tapped: the input is a LEVEL read once a frame, so a press that
    // lands between two frames is a press the game never saw.
    await confirmPress(page)

    // The run ends on the last gate or on the 180 s clock, whichever comes
    // first — either is a finish, and both have to put a score on the panel.
    await expect
      .poll(async () => (await probe(page)).finished, { timeout: LAP_TIMEOUT, intervals: [2_000] })
      .toBe('true')

    const done = await probe(page)

    // ── the panel is up, and it has numbers on it ─────────────────────────
    expect(done.panelVisible).toBe(true)
    // DEV-601: the autopilot flew it, so no medal, whatever the score.
    expect(done.medal).toBe('none')
    const score = Number(done.score)
    expect(Number.isFinite(score)).toBe(true)
    // Rings, plus a time bonus only if it took all 21 (DEV-393: a missed ring
    // forfeits it) — so 1,500 at the floor below, and ~3,500 for a clean lap. The
    // band is wide because this guards the WIRING, not the autopilot's pace —
    // `sim/autopilot` has its own tests for that, and a bound tight enough to
    // catch a tuning change would fail on every tuning change.
    expect(score).toBeGreaterThan(1_000)
    expect(score).toBeLessThan(4_000)

    // The rings actually counted, rather than the run ending on the clock with
    // nothing taken — which would satisfy every assertion above.
    const [passed, total] = (done.rings ?? '0/0').split('/').map(Number)
    expect(total).toBe(21)
    expect(passed).toBeGreaterThanOrEqual(15)

    // ── and NO best was written (DEV-601) ────────────────────────────────
    //
    // The MODE is half the key since DEV-204, and `int_01_hoverJet` runs Ring
    // Attack: this is the key a run of the player's would have written. An
    // autopilot run writes nothing there, and the panel shows no best.
    expect(done.best ?? '').toBe('')
    const stored = await page.evaluate(() =>
      globalThis.localStorage.getItem('ff2.best.int_01_hoverJet.ringAttack.v1'),
    )
    expect(stored, 'an autopilot run keeps no best').toBeNull()

    // ── and confirm means "again" ────────────────────────────────────────
    await confirmPress(page)
    await expect.poll(async () => (await probe(page)).panelVisible, { timeout: 15_000 }).toBe(false)
    const restarted = await probe(page)
    expect(restarted.finished).toBeUndefined()
    expect(restarted.rings).toBe('0/21')
  })

  test('leaves a stored best alone when the autopilot flies (DEV-601)', async ({ page }) => {
    // The point of a best is that it outlives the tab. Seeded directly rather
    // than flown twice, because flying two laps is four minutes to assert one
    // comparison — and the run that matters is the one that BEATS it.
    await page.goto('/?xr=off')
    // The CURRENT key shape, mission + mode (DEV-204). Seeding the old unmoded
    // one would also work — `readBest` falls through to it so nobody loses a
    // best they already have — and that is exactly why it must not be used
    // here: this test would then be proving the migration path rather than the
    // one every new record takes. `personal-best.test.ts` owns the fallback.
    await page.evaluate(() =>
      globalThis.localStorage.setItem(
        'ff2.best.int_01_hoverJet.ringAttack.v1',
        JSON.stringify({ score: 999_999, timeSeconds: 1, gates: 21, setAt: 1 }),
      ),
    )
    await page.goto('/?autopilot=1&xr=off')
    await firstPress(page)
    await missionReady(page, 180_000)
    await focusCanvas(page)
    await confirmPress(page)
    await expect
      .poll(async () => (await probe(page)).finished, { timeout: LAP_TIMEOUT, intervals: [2_000] })
      .toBe('true')

    const done = await probe(page)
    // The stored best SURVIVES the run, byte for byte: an autopilot run is not
    // compared with it, let alone written over it (DEV-601).
    expect(Number(done.score)).toBeLessThan(999_999)
    const kept = await page.evaluate(() =>
      globalThis.localStorage.getItem('ff2.best.int_01_hoverJet.ringAttack.v1'),
    )
    expect(JSON.parse(kept ?? '{}')).toMatchObject({ score: 999_999 })
  })
})
