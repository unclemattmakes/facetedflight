/**
 * The launch pad stays where the launch pad is.
 *
 * It did not. The elevator was parented to `flight.object`, which IS the ship —
 * `flight.render()` writes the interpolated body transform onto it every frame
 * — so the platform and the shaft flew the course welded to the jet. Measured
 * at 15 s: elevator (716, 349, 1260), ship (717, 350, 1259).
 *
 * Nothing caught it because nothing could SEE it. From the cockpit the platform
 * is directly below and behind, the one live shaft segment is 96 m overhead,
 * and `?view=chase` points at the AI racers. That is trap 18 again: every
 * screenshot spec we own uses a view where the bug cannot appear.
 *
 * So the guard is a world-space MEASUREMENT rather than a picture.
 */

import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import type { Ff2GlobalMaybe } from './fixtures/ff2'
import { firstPress } from './fixtures/landing'
import { expect, test } from './fixtures/test'

interface Vec {
  x: number
  y: number
  z: number
}

const worldPositions = async (
  page: import('@playwright/test').Page,
): Promise<{ elevator: Vec | null; ship: Vec | null }> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2GlobalMaybe
    let elevator: { x: number; y: number; z: number } | null = null
    w.__ff2?.render.scene.traverse((node) => {
      const o = node as {
        name?: string
        matrixWorld?: { elements: number[] }
        updateWorldMatrix?: (a: boolean, b: boolean) => void
      }
      if (o.name !== 'launch-elevator') return
      o.updateWorldMatrix?.(true, false)
      const m = o.matrixWorld?.elements ?? []
      elevator = { x: m[12] ?? 0, y: m[13] ?? 0, z: m[14] ?? 0 }
    })
    const s = w.__ff2?.flight?.()?.jet.body.position
    // Ship in THREE space, so the two are directly comparable: z flips.
    return { elevator, ship: s ? { x: s.x, y: s.y, z: -s.z } : null }
  })

test.describe('@gpu the launch elevator', () => {
  test.setTimeout(300_000)

  test('does not fly the course with the ship', async ({ page }) => {
    await page.goto('/?autopilot=1&xr=off')
    await firstPress(page)
    await missionReady(page, 180_000)

    const before = await worldPositions(page)

    await focusCanvas(page)
    await page.keyboard.down('Enter')
    await page.waitForTimeout(200)
    await page.keyboard.up('Enter')
    // Wait for the LIFT, then for the flight. This used to be a flat 15 s and
    // that was 15 s of flying — until DEV-094 found that nothing had ridden the
    // elevator on any path since the mission switch landed, and put the 15.5 s
    // climb and its countdown back in front of the run. A wall-clock wait would
    // now spend all of it on the platform and report "the ship flew: 106.647",
    // which is the rise, not a flight.
    await expect
      .poll(
        async () =>
          page.evaluate(
            () => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.launch().phase ?? 'none',
          ),
        { timeout: 90_000, intervals: [500] },
      )
      .toBe('flying')
    // What 15 s stood for is "the ship has flown away": wait for that state (the
    // premise asserted below), so it ends the moment the ship is 500 m from where
    // it started, and fails with the distance if it never gets there.
    await expect
      .poll(
        async () => {
          const s = (await worldPositions(page)).ship
          const e = before.elevator
          return s && e ? Math.hypot(s.x - e.x, s.y - e.y, s.z - e.z) : 0
        },
        { timeout: 60_000, intervals: [250], message: 'the ship flew away from the elevator' },
      )
      .toBeGreaterThan(500)

    const after = await worldPositions(page)
    // Narrowed rather than cast: a null here means the probe found nothing,
    // which must fail loudly instead of comparing zeroes and passing.
    const ship = after.ship
    const now = after.elevator
    const was = before.elevator
    expect(ship, 'ship position').not.toBeNull()
    expect(now, 'elevator after').not.toBeNull()
    expect(was, 'elevator before').not.toBeNull()
    if (!ship || !now || !was) throw new Error('probe found nothing to measure')

    // The premise: the ship actually went somewhere. Without this the test
    // passes on a run that never launched.
    const flown = Math.hypot(ship.x - was.x, ship.y - was.y, ship.z - was.z)
    expect(flown, 'the ship flew').toBeGreaterThan(500)

    // The claim: the elevator did not. A metre of slack for the platform's own
    // rise, which is the one thing inside it that is MEANT to move.
    const drift = Math.hypot(now.x - was.x, now.y - was.y, now.z - was.z)
    expect(drift, 'the elevator stayed put').toBeLessThan(1)

    // Said the other way too, because "drift is small" would also pass if both
    // were pinned at the origin by some future refactor.
    const gap = Math.hypot(now.x - ship.x, now.y - ship.y, now.z - ship.z)
    expect(gap, 'and it is nowhere near the ship').toBeGreaterThan(500)
  })

  test('sits at the spawn MARKER on both launch paths', async ({ page }) => {
    // "It did not move" is not "it is in the right place", and the first
    // version of the anchor passed the test above while sitting at pad height
    // with the hangar 106.6 m over the player's head. It copied the ship's
    // INITIAL body position, which `flight.ts` has already put at the top of
    // the shaft — so the anchor has to be the spawn MARKER, one rise below.
    // Both paths, because they disagree about where the SHIP is and must agree
    // about where the elevator is. `?ride=0` starts the platform at the top
    // (DEV-024's cut), the default starts it in the hangar at the bottom
    // (DEV-035) — so the ship is one rise apart between them and the elevator's
    // own origin must not move at all.
    const at = async (query: string) => {
      await page.goto(query)
      await firstPress(page)
      await missionReady(page, 180_000)
      await page.waitForTimeout(1_000)
      const { elevator, ship } = await worldPositions(page)
      expect(ship, query).not.toBeNull()
      expect(elevator, query).not.toBeNull()
      if (!ship || !elevator) throw new Error(`probe found nothing at ${query}`)
      // Horizontal agreement catches a wrong FRAME; the heights catch a wrong
      // one of the two possible ones.
      expect(Math.hypot(elevator.x - ship.x, elevator.z - ship.z), `${query} column`).toBeLessThan(
        2,
      )
      return { elevator, ship }
    }

    // ── `menu=0` on both, since DEV-281 ─────────────────────────────────
    //
    // This test reads the ELEVATOR's and the SHIP's world positions at boot,
    // and a bare `/?xr=off` now stands on the title screen and builds neither:
    // the island, the rig and the ship are generated when a course is chosen.
    // `?menu=0` is the shipped switch meaning *start me in the ship* — the
    // state this test is about — and it touches nothing else: `SKIP_MENU`'s
    // only effect is which screen boot lands on, so `ride` and the launch
    // state machine are exactly as they were.
    //
    // Both URLs take it, because the pair is the point: they must disagree
    // about the ship and agree about the elevator, and changing one of them
    // would be comparing two different boots.
    const skipped = await at('/?xr=off&menu=0&ride=0')
    // Ride cut: the ship rests on a platform already at the top, one full rise
    // above the marker the elevator group is pinned to.
    const drop = skipped.ship.y - skipped.elevator.y
    expect(drop, 'ride=0 starts at the top').toBeGreaterThan(100)
    expect(drop, 'by about one rise').toBeLessThan(115)

    const ridden = await at('/?xr=off&menu=0')
    // Ride on: the ship starts in the hangar, level with the marker.
    expect(
      Math.abs(ridden.ship.y - ridden.elevator.y),
      'default starts at the bottom',
    ).toBeLessThan(6)

    // And the elevator itself did not move between the two — which is the
    // assertion that would have caught the first build, where the anchor
    // copied the ship's initial position and so followed it 106.6 m up.
    expect(Math.abs(ridden.elevator.y - skipped.elevator.y), 'same marker either way').toBeLessThan(
      0.5,
    )
  })
})
