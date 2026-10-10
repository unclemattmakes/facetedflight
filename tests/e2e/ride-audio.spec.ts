/**
 * DEV-423 / DEV-424 — the lift ride and GO, as a real browser plays them.
 *
 * ── Why a browser, when the unit suite already covers both ───────────────
 *
 * `tests/unit/audio-lift.test.ts` and `music-playback.test.ts` drive the pure
 * modules through a recording backend. What neither can reach is the WIRING in
 * `boot/app.ts`: that the ride branch really steps the lift's voice with the
 * platform's rise, that the preset really installs it, that `launch.start` and
 * `countdown.go` really reach the playlist on the path a press takes, and that
 * the real `webaudio.ts` voice map agrees the motor is sounding. Every one of
 * those can be broken with the unit suite green.
 *
 * ── What it asserts ──────────────────────────────────────────────────────
 *
 *  1. DEV-424: while the platform climbs, the motor is SOUNDING (the backend's
 *     own voice map, not the lift state's belief) beside AUD-1's loop; the
 *     derived speed passes 10 m/s (int_01 peaks at 16.6); the platform
 *     arrives, and the motor is gone.
 *  2. DEV-424: a SECOND press during the countdown — which players make,
 *     waiting for GO — does not bring the lift loop back. Before DEV-424 the
 *     press itself sent `launch.start`, so that press restarted the loop after
 *     `launch.topped` had stopped it, and it droned under the whole race.
 *  3. DEV-424: the island and water beds are SOUNDING in the race. This boot
 *     sends no `mission.begin` — like `switchMission`, which is how a player
 *     reaches nearly every run — so before DEV-424 they never started here.
 *  4. DEV-423: the song under the lift is decoded, and after GO a DIFFERENT
 *     one is, and the time from GO to its decode is printed — that gap is the
 *     silence a player hears at GO, and it is a number worth having.
 *
 * ── The path ─────────────────────────────────────────────────────────────
 *
 * `?mission=` and a real press, no autopilot: the ride is the first launch of a
 * world build, so it climbs (DEV-094). Nothing here changes the build; the
 * harness presses Enter, as a player presses A, and reads `__ff2`. Like the
 * hangar's switch route, it never sends `mission.begin`, which is what item 3
 * needs: the one route that does is the one route that never lacked the beds.
 *
 * Tagged `@gpu`: it builds the terrain for real.
 */

import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import { firstPress } from './fixtures/landing'
import { watchPageErrors } from './fixtures/page-errors'
import { expect, type Page, test } from './fixtures/test'

interface Sample {
  readonly t: number
  readonly phase: string
  readonly lift: {
    readonly speed: number
    readonly motor: boolean
    readonly arrived: boolean
    readonly enabled: boolean
    readonly sounding: readonly string[]
  }
  readonly music: { readonly track: string | null; readonly seconds: number | null }
}

const sample = async (page: Page): Promise<Sample> =>
  page.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2: {
        launch(): { phase: string }
        liftAudio(): Sample['lift']
        music(): Sample['music']
      }
    }
    return {
      t: performance.now() / 1000,
      phase: w.__ff2.launch().phase,
      lift: w.__ff2.liftAudio(),
      music: w.__ff2.music(),
    }
  })

/** Held for a few frames — the confirm input is a level, read once a frame. */
const confirmPress = async (page: Page): Promise<void> => {
  await page.keyboard.down('Enter')
  await page.waitForTimeout(200)
  await page.keyboard.up('Enter')
}

test.describe('@gpu the lift ride and GO, audibly', () => {
  test.setTimeout(600_000)

  test('the motor follows the platform, a countdown press leaves the loop off, and GO is a new song', async ({
    page,
  }) => {
    const problems = watchPageErrors(page)
    // `menu=0` straight onto the pad, as `race-start.spec.ts` boots; the ride
    // is still ON (no `ride=0`), and nothing sends `mission.begin` on this route.
    await page.goto('/?xr=off&mission=int_01_hoverJet&menu=0')
    await firstPress(page)
    await missionReady(page, 180_000)
    await focusCanvas(page)

    // The press: the gesture that builds the `AudioContext`, and the launch.
    await confirmPress(page)
    await expect(page.locator('body')).toHaveAttribute('data-audio', 'running', {
      timeout: 20_000,
    })

    const samples: Sample[] = []
    let pressedInCountdown = false
    let goAt: number | null = null
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      const s = await sample(page)
      samples.push(s)
      if (s.phase === 'countdown' && !pressedInCountdown) {
        pressedInCountdown = true
        await confirmPress(page)
      }
      if (s.phase === 'flying' && goAt === null) goAt = s.t
      // Enough after GO for the new song to decode and the loop to be judged.
      if (goAt !== null && s.t - goAt > 12) break
      await page.waitForTimeout(100)
    }

    const rising = samples.filter((s) => s.phase === 'rising')
    const flying = samples.filter((s) => s.phase === 'flying')
    expect(rising.length, 'the lift never rode').toBeGreaterThan(20)
    expect(pressedInCountdown, 'never reached the countdown').toBe(true)
    expect(goAt, 'never reached GO').not.toBeNull()

    // ── DEV-424: the motor ────────────────────────────────────────────────
    expect
      .soft(samples[0]?.lift.enabled, 'the Anniversary preset did not install the lift')
      .toBe(true)
    const peak = Math.max(...rising.map((s) => s.lift.speed))
    expect.soft(peak, 'the lift step never saw the platform move').toBeGreaterThan(10)
    const running = rising.filter((s) => s.lift.motor && s.lift.sounding.includes('elevator.motor'))
    expect
      .soft(running.length, 'the motor was never SOUNDING while the platform climbed')
      .toBeGreaterThan(10)
    expect.soft(running.some((s) => s.lift.sounding.includes('elevator.loop'))).toBe(true)
    const last = samples.at(-1)
    expect.soft(last?.lift.arrived, 'the platform never arrived').toBe(true)
    expect.soft(last?.lift.sounding).not.toContain('elevator.motor')

    // ── DEV-424: the countdown press leaves the lift loop OFF ────────────
    const settled = flying.filter((s) => goAt !== null && s.t - goAt > 3)
    expect(settled.length).toBeGreaterThan(5)
    const droning = settled
      .filter((s) => s.lift.sounding.includes('elevator.loop'))
      .map((s) => `${(s.t - (goAt ?? 0)).toFixed(1)} s`)
    expect.soft(droning, 'the lift loop is still going after GO, at').toEqual([])

    // ── DEV-424: the island and the water, on a route with no mission.begin ─
    const quiet = settled.filter(
      (s) =>
        !s.lift.sounding.includes('ambient.island') || !s.lift.sounding.includes('ambient.water'),
    )
    expect
      .soft(
        quiet.map((s) => `${(s.t - (goAt ?? 0)).toFixed(1)} s: ${s.lift.sounding.join(',')}`),
        'an ambience bed is not sounding after GO, at',
      )
      .toEqual([])

    // ── DEV-423: a new song at GO ─────────────────────────────────────────
    const beforeGo = samples.filter((s) => s.phase !== 'flying' && s.music.seconds !== null)
    const liftTrack = beforeGo.at(-1)?.music.track ?? null
    expect.soft(liftTrack, 'no song ever decoded under the lift').not.toBeNull()
    const arrived = flying.find((s) => s.music.track !== liftTrack && s.music.seconds !== null)
    expect
      .soft(
        arrived,
        `after GO the song never changed from ${liftTrack} and decoded (last: ${JSON.stringify(last?.music)})`,
      )
      .toBeDefined()
    // The gap a player hears at GO: the lift's song is cut on the GO tick and
    // this is how long the next one took to fetch and decode. Printed, not
    // asserted — it is a measurement of this box's network and decoder.
    console.info(
      `[ride-audio] lift song ${liftTrack} -> GO song ${arrived?.music.track}, ` +
        `decoded ${((arrived?.t ?? 0) - (goAt ?? 0)).toFixed(2)} s after GO; ` +
        `lift peak ${peak.toFixed(1)} m/s over ${rising.length} ride samples`,
    )

    expect(problems.list(), problems.list().join('\n')).toEqual([])
  })
})
