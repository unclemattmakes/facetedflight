/**
 * tests/e2e/energy.spec.ts — DEV-143 and DEV-144, where the wiring lives.
 *
 * ── What a unit test cannot see here ──────────────────────────────────────
 *
 * `tests/unit/energy.test.ts` and `energy-race.test.ts` prove the arithmetic
 * against the constants sheet and the two 2016 ghost recordings. Neither can
 * see the JOIN, and the join is where both features actually live:
 *
 *   · a query parameter -> `runningMode(level, requested)` -> `MODES`' fourth
 *     row -> a world that is Ring Attack with a tank under it;
 *   · the preset flag deciding whether the request is honoured AT ALL;
 *   · the tank being STEPPED from the fixed-step loop rather than merely
 *     existing, which is the DEV-069 defect in its natural habitat — a
 *     mechanism that is correct, tested, and wired to nothing.
 *
 * That last one is the point. `hoverjet.input.controlScheme` sat on the sheet
 * at `trust: verified` for four sessions while the pad did something else, and
 * 26 `hoverjet.energy.*` keys sat there unread until this session. A spec that
 * only asks "is the mode named right" would pass for a tank that never moves.
 * **Every assertion below is that a number CHANGED.**
 *
 * `?autopilot=1` flies it, which makes the numbers reproducible: the controller
 * is stepped on the fixed step (DEV-027) and holds a real throttle, so the tank
 * drains the way a pilot's would rather than the way an idle ship's would.
 *
 * Attributes and probe reads, no pixels — so no `@gpu` tag. It does build a
 * world, hence the `data-terrain-ready` wait every world spec makes.
 */

import { missionReady } from './fixtures/boot'
import type { Ff2Global } from './fixtures/ff2'
import { firstPress } from './fixtures/landing'
import { watchPageErrors } from './fixtures/page-errors'
import { expect, test } from './fixtures/test'

const OPEN = 'xr=off&title=0&menu=0&ride=0&autopilot=1'
const MISSION = 'int_01_hoverJet'

type EnergyProbe = {
  mode: 'race' | 'boost'
  boost: { energy: number; lockout: number; lit: boolean }
  race: { energy: number; powered: boolean; drained: number; paid: number }
}

const probe = (page: import('@playwright/test').Page): Promise<EnergyProbe> =>
  page.evaluate(() => (window as unknown as Ff2Global).__ff2.energy() as EnergyProbe)

const flyTo = async (page: import('@playwright/test').Page, url: string) => {
  await page.goto(url)
  await firstPress(page)
  await missionReady(page, 120_000)
}

test.describe('DEV-143 — the boost tank is wired to the stick', () => {
  test.setTimeout(180_000)

  test('drains on Anniversary and is untouched on Classic', async ({ page }) => {
    // ── Anniversary ──────────────────────────────────────────────────────
    const problems = watchPageErrors(page)
    await flyTo(page, `/?mission=${MISSION}&edition=anniversary&${OPEN}`)
    const start = await probe(page)
    expect(start.mode).toBe('boost')
    // The autopilot boosts, so the tank has to move. Give it real seconds: a
    // full tank is 6.25 s of held boost at the Anniversary rate. DEV-630 starts
    // the run EMPTY, so the first reading may be the bottom of the tank and a
    // two-point "later < start" can no longer say it drained: sample it, and
    // ask for a fall between two readings.
    const seen: number[] = [start.boost.energy]
    const fell = (): boolean => seen.some((e, i) => i > 0 && e < (seen[i - 1] as number))
    // THE ASSERTION. Not "the module exists": the number went DOWN while the
    // game was being played by something holding the same stick a person holds.
    // Polled on that state (a fall between two readings), so it ends the moment
    // the tank falls instead of sleeping 12 s for it; 12 s is only the limit.
    try {
      await expect
        .poll(
          async () => {
            seen.push((await probe(page)).boost.energy)
            return fell()
          },
          { timeout: 12_000, intervals: [250] },
        )
        .toBe(true)
    } catch (e) {
      throw new Error(`tank readings: ${seen.map((r) => r.toFixed(1)).join(' ')}\n${e}`)
    }
    expect(problems.list()).toEqual([])
  })

  test('does not move at all on Classic', async ({ page }) => {
    // The other half, and the one that protects 2016: Classic's recharge beats
    // its burn by +68/s (`derived.energy.netWhileBoosting`), so the tank sits
    // at the top of its one-tick sawtooth and boost never goes out. The gauge
    // is not drawn there either, but a canvas texture is not something a spec
    // can read — this reads the state the gauge would have drawn.
    const problems = watchPageErrors(page)
    // DEV-452 (D35): a player's Classic is a look and flies Anniversary's
    // rules, tank included; 2016's rules are `?rules=classic`, the reference.
    await flyTo(page, `/?mission=${MISSION}&edition=classic&rules=classic&${OPEN}`)
    // A negative claim ("never moves") has no state to wait FOR: the one that
    // would make it worth anything is "the autopilot held boost", and under
    // rules=classic `boost.lit` is never true (a probe of this run read '.100'
    // 56 times running), so there is nothing to poll on but time. Anniversary's
    // tank is empty after 6.25 s of boost, so the old sleep took 12 s. It is now
    // 48 readings 250 ms apart (the same 12 s), each checked, so a dip anywhere in
    // the window fails it rather than only a dip at the final instant.
    const readings: Array<{ energy: number; lockout: number }> = []
    await expect
      .poll(
        async () => {
          const r = (await probe(page)).boost
          readings.push({ energy: r.energy, lockout: r.lockout })
          return readings.length
        },
        { timeout: 40_000, intervals: [250], message: 'readings of the tank' },
      )
      .toBeGreaterThanOrEqual(48)
    // Within one tick's burn of full, for ever. `energy.ts`'s header and
    // `tests/unit/energy.test.ts` explain the sawtooth; here it is in the game.
    expect(Math.min(...readings.map((r) => r.energy))).toBeGreaterThan(99)
    expect(Math.max(...readings.map((r) => r.lockout))).toBe(0)
    expect(problems.list()).toEqual([])
  })
})

test.describe('DEV-144 — the energy race is a mode you can select', () => {
  test.setTimeout(180_000)

  test('?mode=energyRace reaches the world, and the tank is being stepped', async ({ page }) => {
    const problems = watchPageErrors(page)
    await flyTo(page, `/?mission=${MISSION}&edition=anniversary&mode=energyRace&${OPEN}`)
    // The join: a query parameter became the running mode, through
    // `runningMode(level, requested)` — a seam that had no caller until now.
    await expect(page.locator('body')).toHaveAttribute('data-mode', 'energyRace')
    // And it is still Ring Attack underneath, which is the fourth row's whole
    // claim: same course, same 21 gates, same racers. A mode that quietly
    // changed the content would be a ladder, not a row.
    await expect(page.locator('body')).toHaveAttribute('data-ring-count', '21')
    await expect(page.locator('body')).toHaveAttribute('data-rings-live', 'true')

    const start = await probe(page)
    expect(start.mode).toBe('race')
    // Waits for the two things it asserts, so it ends when the autopilot has
    // spent and paid, not after a fixed 20 s; 40 s is only the limit.
    await expect
      .poll(
        async () => {
          const r = (await probe(page)).race
          return r.drained > 0 && r.paid > 0
        },
        { timeout: 40_000, intervals: [250] },
      )
      .toBe(true)
    const later = await probe(page)
    // The tank is being SPENT — the DEV-069 assertion, in the mode that dies
    // of it.
    expect(later.race.drained).toBeGreaterThan(0)
    // ...and PAID, which is the half that proves gates are wired to it. A tank
    // that only drained would be a timer.
    expect(later.race.paid).toBeGreaterThan(0)
    expect(problems.list()).toEqual([])
  })

  test('Classic refuses the request rather than running a mode with no tank', async ({ page }) => {
    // `gameplay.energyRace.enabled` is what makes the mode SELECTABLE. Off, the
    // request falls through to the level's own mode with a console line —
    // never to a mode whose tank nothing steps, which would be Ring Attack
    // wearing a different name and the exact class of silent half-feature this
    // whole session was about.
    const problems = watchPageErrors(page)
    await flyTo(page, `/?mission=${MISSION}&edition=classic&rules=classic&mode=energyRace&${OPEN}`)
    await expect(page.locator('body')).toHaveAttribute('data-mode', 'ringAttack')
    const p = await probe(page)
    expect(p.mode).toBe('boost')
    expect(problems.list()).toEqual([])
  })

  test('an unknown ?mode= is ignored, not fatal', async ({ page }) => {
    const problems = watchPageErrors(page)
    await flyTo(page, `/?mission=${MISSION}&mode=hoverball&${OPEN}`)
    await expect(page.locator('body')).toHaveAttribute('data-mode', 'ringAttack')
    expect(problems.list()).toEqual([])
  })
})
