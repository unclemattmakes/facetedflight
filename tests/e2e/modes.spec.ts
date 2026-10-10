/**
 * tests/e2e/modes.spec.ts — does the RUNNING mode reach the world?
 *
 * ── The bug this exists for ───────────────────────────────────────────────
 *
 * `forcedMode` was in the level schema from the first extraction and **read by
 * nothing** for the whole life of the port. Two shipped scenes set it —
 * `int_02_jumpSeat` and `hoverJet_kauai_beg`, both to Free Flight — and 2016
 * implements it by toggling two GameObject subtrees in `Level.Start()`: the
 * rings off, the orbs on. So kauai shipped in FF2 with all 21 of its gates
 * drawn and a race clock its own scene switches off.
 *
 * Every part of that is invisible to a unit test that is handed a mode. What
 * makes it a bug is the JOIN — level JSON, `runningMode`, and whether
 * `render.scene` ends up with the ring group in it — and the join only exists
 * in `boot/app.ts`. Hence a spec here.
 *
 * ── Why these two missions ────────────────────────────────────────────────
 *
 * `int_01_hoverJet` and `hoverJet_kauai_beg` are **the same course authored
 * twice**, in two environments, with the second forced to Free Flight. Ring 0
 * is at the same coordinates in both level JSONs. So they differ in exactly the
 * thing under test and in almost nothing else, which is what makes the pair an
 * experiment rather than two assertions.
 *
 * It asserts ATTRIBUTES, not pixels, so it needs no `@gpu` tag — but it does
 * generate terrain, which is why it waits on `data-terrain-ready` like every
 * other spec that loads a world.
 */

import { missionReady } from './fixtures/boot'
import { firstPress } from './fixtures/landing'
import { watchPageErrors } from './fixtures/page-errors'
import { expect, test } from './fixtures/test'

const OPEN = 'xr=off&title=0&menu=0&ride=0'

test.describe('the running mode reaches the world', () => {
  test.setTimeout(150_000)

  test('Ring Attack draws its rings', async ({ page }) => {
    const problems = watchPageErrors(page)
    await page.goto(`/?mission=int_01_hoverJet&${OPEN}`)
    await firstPress(page)
    await missionReady(page, 120_000)
    await expect(page.locator('body')).toHaveAttribute('data-mode', 'ringAttack')
    await expect(page.locator('body')).toHaveAttribute('data-rings-live', 'true')
    // 21, and the count is what was LOADED — see the next test for why the two
    // numbers have to be separate.
    await expect(page.locator('body')).toHaveAttribute('data-ring-count', '21')
    // The only mode that races. FIVE under the default (Anniversary) preset —
    // the two 2016 AI pads plus `gameplay.racers.slots`' three ahead of the
    // player (DEV-125); Classic's grid is the two pads alone.
    await expect(page.locator('body')).toHaveAttribute('data-opponents', '5')
    expect(problems.list()).toEqual([])
  })

  test('a forced Free Flight mission loads its rings and draws none of them', async ({ page }) => {
    const problems = watchPageErrors(page)
    await page.goto(`/?mission=hoverJet_kauai_beg&${OPEN}`)
    await firstPress(page)
    await missionReady(page, 120_000)
    // `forcedMode`, applied. The level's own `mode` is `freeFlight` too, so this
    // alone would not prove the override works — the assertion that does is
    // that the twenty-one rings below are loaded and not drawn.
    await expect(page.locator('body')).toHaveAttribute('data-mode', 'freeFlight')
    await expect(page.locator('body')).toHaveAttribute('data-ring-count', '21')
    await expect(page.locator('body')).toHaveAttribute('data-rings-live', 'false')
    expect(problems.list()).toEqual([])
  })

  test('a Target Practice mission has nobody racing it', async ({ page }) => {
    // Six of the thirteen missions had two HoverJets racing a ring course the
    // mode does not score, for the whole life of the port — because nobody had
    // loaded a JumpSeat mission and looked. `tests/unit/opponents.test.ts` holds
    // the argument for WHY the three JumpSeat scenes that carry a `GhostRacer`
    // are not evidence against this; this holds that the gate reaches the scene.
    const problems = watchPageErrors(page)
    await page.goto(`/?mission=int_01_jumpSeat&${OPEN}`)
    await firstPress(page)
    await missionReady(page, 120_000)
    await expect(page.locator('body')).toHaveAttribute('data-mode', 'targetPractice')
    await expect(page.locator('body')).toHaveAttribute('data-opponents', '0')
    expect(problems.list()).toEqual([])
  })
})
