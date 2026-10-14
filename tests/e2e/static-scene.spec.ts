/**
 * tests/e2e/static-scene.spec.ts: what never moves is frozen, and nothing
 * frozen ever moved. DEV-937.
 *
 * `render/static-scene.ts` turns `matrixAutoUpdate` off for everything whose
 * local transform never changes, and checks a few frozen objects every frame:
 * one that something moved anyway is handed back to three and NAMED in
 * `__ff2.staticScene().healed`. A wrong freeze is otherwise silent (the thing
 * just stops moving), so this flies whole missions, pad to race, and fails on
 * any hand-back. A red here means a new mover: add it to
 * `MISSION_STATIC_RULES.movers` with the name the failure prints.
 *
 * It also holds the lift: the elevator's platform and the AI start pads rise
 * during the ride and the countdown, so they freeze only once the race is
 * live (`launch().phase === 'flying'`).
 */
import { bootReady } from './fixtures/boot'
import type { Ff2Global } from './fixtures/ff2'
import { expect, test } from './fixtures/test'

const MISSIONS = [
  // A launch elevator and AI start pads, Simonet's sea.
  { id: 'int_01_hoverJet', lift: true },
  // Desert, the scatter-heaviest race.
  { id: 'adv_01_hoverJet', lift: true },
  // The JumpSeat: legs that move, no racers.
  { id: 'rookie_01_jumpSeat', lift: false },
]

const read = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2Global
    let objects = 0
    ;(w.__ff2.stage() as { traverse: (f: () => void) => void }).traverse(() => objects++)
    return { ...w.__ff2.staticScene(), objects, phase: w.__ff2.launch().phase }
  })

test.describe('@gpu the static scene: DEV-937', () => {
  test.setTimeout(300_000)

  for (const mission of MISSIONS) {
    test(`${mission.id}: most of the scene is frozen, the lift once the race is live, and nothing frozen moved`, async ({
      page,
    }) => {
      await page.goto(`/?mission=${mission.id}&xr=off&autopilot=1&edition=anniversary`)
      await bootReady(page, 240_000)

      // Before the race: the lift is not frozen (it is about to ride).
      const early = await read(page)
      if (early.phase !== 'flying') expect(early.lift.frozen, 'the lift rides unfrozen').toBe(false)

      await expect
        .poll(async () => (await read(page)).phase, { timeout: 120_000, intervals: [500] })
        .toBe('flying')
      await page.waitForTimeout(1_000)
      const live = await read(page)
      expect(live.lift.frozen, 'the lift freezes once the race is live').toBe(true)
      if (mission.lift) expect(live.lift.known, 'the platform and the AI pads').toBeGreaterThan(0)

      // A long stretch of race: every frozen object is checked many times over.
      await page.waitForTimeout(45_000)
      const done = await read(page)
      console.info(
        `  ${mission.id}: ${done.frozen} frozen of ${done.objects}, lift ${done.lift.known} known, healed ${done.healed.length}`,
      )
      expect(done.healed, 'a frozen object moved: add it to MISSION_STATIC_RULES.movers').toEqual(
        [],
      )
      expect(done.frozen, `${done.frozen} frozen of ${done.objects}`).toBeGreaterThan(
        done.objects / 2,
      )
    })
  }
})
