/**
 * DEV-388's perf gate (plan/MULTIPLAYER.md §8): five remote ships — the
 * six-seat cap less yourself — fed by five autopilot players in node
 * (`fixtures/room-crowd.ts`) through the room sidecar, drawn by ONE browser,
 * set beside single player's five AI racers, which is the same drawing.
 *
 * Measured, per arm, pinned `adaptive=0&quality=high` (AGENT-NOTES §1: a
 * frame this app renders is only comparable if the quality tier cannot move):
 *
 *   - frame time, from the app's own recorder (`__ff2.perf.stats()`, 3 s window);
 *   - what the frame DREW for the ships, from `__ff2.census()` — the `racers`
 *     group in one arm, `remote-ships` in the other: calls and triangles;
 *   - the room arm's own cost, bracketed in `remote-ships.ts` (`stats()`): the
 *     CPU ms a frame spends placing five ships, their trails and their tags;
 *   - allocation, from Chrome's sampling heap profiler over five seconds of
 *     racing, counting what the room's modules allocate (§5.4: nothing a frame).
 *
 * Durations are "never immune" to a shared box (AGENT-NOTES §1): run under the
 * GPU lease and read them as this machine's, this run's. The counts are immune.
 *
 *   FF2_API_PROXY=http://127.0.0.1:5398 E2E_PORT=5388 npx playwright test room-ships-perf
 */

import { missionReady } from './fixtures/boot'
import { firstPress } from './fixtures/landing'
import { loadLevel, startCrowd } from './fixtures/room-crowd'
import { type RoomSidecar, startRoomSidecar } from './fixtures/room-sidecar'
import { expect, type Page, test } from './fixtures/test'

const PROXY = process.env.FF2_API_PROXY ?? ''
const PINNED = 'xr=off&adaptive=0&quality=high&autopilot=1&mission=int_01_hoverJet'
const SHIPS = 5
/** Where the two frames go (pinned high, the cockpit 1.5 s after GO), when set. Not test-results/: Playwright wipes it. */
const PHOTOS = process.env.ROOM_PHOTO_DIR ?? null

interface Sample {
  frame: { meanMs: number; p95Ms: number; fps: number }
  census: { calls: number; triangles: number; group: { calls: number; triangles: number } | null }
}

const sample = (page: Page, group: string): Promise<Sample> =>
  page.evaluate((g) => {
    const w = globalThis as unknown as {
      __ff2: {
        perf: { stats: () => { meanMs: number; p95Ms: number; fps: number } }
        census: () => {
          calls: number
          triangles: number
          rows: Array<{ group: string; calls: number; triangles: number }>
        }
      }
    }
    const s = w.__ff2.perf.stats()
    const c = w.__ff2.census()
    const row = c.rows.find((r) => r.group === g)
    return {
      frame: { meanMs: s.meanMs, p95Ms: s.p95Ms, fps: s.fps },
      census: {
        calls: c.calls,
        triangles: c.triangles,
        group: row ? { calls: row.calls, triangles: row.triangles } : null,
      },
    }
  }, group)

const released = (page: Page) =>
  expect
    .poll(
      () =>
        page.evaluate(() => {
          const w = globalThis as unknown as {
            __ff2: { laps: () => { run: { tick: number } } | null }
          }
          return w.__ff2.laps()?.run.tick ?? -1
        }),
      { timeout: 240_000, intervals: [1_000] },
    )
    .toBeGreaterThan(0)

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

test.describe('@measure @gpu five remote ships, beside five racers', () => {
  test.skip(
    !PROXY,
    'set FF2_API_PROXY=http://127.0.0.1:<port> so Vite forwards /api to the room sidecar',
  )
  test.setTimeout(600_000)

  let sidecar: RoomSidecar
  test.beforeAll(async () => {
    // Long enough to wait out another room spec holding the sidecar port
    // (`startRoomSidecar` waits for it rather than failing EADDRINUSE).
    test.setTimeout(360_000)
    sidecar = await startRoomSidecar(Number(new URL(PROXY).port))
  })
  test.afterAll(async () => {
    await sidecar?.close()
  })

  test('costs about what the racers cost, and allocates nothing a frame', async ({ page }) => {
    // ── arm 1: single player, five racers ─────────────────────────────
    await page.goto(`/?${PINNED}`)
    await firstPress(page)
    await missionReady(page, 240_000)
    await released(page)
    await page.waitForTimeout(1_500)
    if (PHOTOS) await page.screenshot({ path: PHOTOS + '/solo-5-racers-adaptive0-high.png' })
    await page.waitForTimeout(8_000)
    const solo: Sample[] = []
    for (let i = 0; i < 4; i++) {
      solo.push(await sample(page, 'racers'))
      await page.waitForTimeout(3_000)
    }

    // ── arm 2: a room, five remote ships ──────────────────────────────
    const roomId = `perf${Date.now().toString(32)}`.replace(/[^a-z2-7]/g, 'a').padEnd(16, 'a')
    const crowd = await startCrowd({
      url: `${PROXY.replace(/^http/, 'ws')}/api/room/${roomId}`,
      level: loadLevel('int_01_hoverJet'),
      count: SHIPS,
      players: SHIPS + 1,
    })
    try {
      await page.goto(`/?${PINNED}&room=${roomId}`)
      await firstPress(page)
      await missionReady(page, 240_000)
      await expect
        .poll(() =>
          page.evaluate(() => {
            const w = globalThis as unknown as {
              __ff2: { room: () => { settings: unknown } | null }
            }
            return w.__ff2.room()?.settings !== null && w.__ff2.room() !== null
          }),
        )
        .toBe(true)
      await page.evaluate(() => {
        const w = globalThis as unknown as { __ff2: { room: () => { ready: () => void } } }
        w.__ff2.room().ready()
      })
      await released(page)
      await page.waitForTimeout(1_500)
      if (PHOTOS)
        await page.screenshot({ path: PHOTOS + '/room-5-remote-ships-adaptive0-high.png' })
      await page.waitForTimeout(4_000)
      await page.evaluate(() => {
        const w = globalThis as unknown as { __ff2: { room: () => { resetStats: () => void } } }
        w.__ff2.room().resetStats()
      })

      // Phase 1: the frame, with nothing watching it.
      const room: Sample[] = []
      for (let i = 0; i < 4; i++) {
        room.push(await sample(page, 'remote-ships'))
        await page.waitForTimeout(3_000)
      }
      const probe = (await page.evaluate(() => {
        const w = globalThis as unknown as { __ff2: { room: () => Record<string, unknown> } }
        const { ready: _r, start: _s, truth: _t, resetStats: _x, ...plain } = w.__ff2.room()
        return JSON.parse(JSON.stringify(plain))
      })) as {
        stats: { frames: number; meanMs: number; maxMs: number; ships: number }
        clock: { offset: number; rtt: number }
        sharedTick: number
        tick: number
        ships: Array<{
          visible: boolean
          mode: string
          loaded: boolean
          delayMs: number
          renderTick: number
          newestTick: number
        }>
      }

      // Phase 2: allocation — every allocation, collected or not, by function,
      // over 5 s of racing. The profiler is heavy, so it is never on while the
      // frame is timed.
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('HeapProfiler.enable')
      await cdp.send('HeapProfiler.startSampling', {
        samplingInterval: 256,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      } as never)
      await page.waitForTimeout(5_000)
      const { profile } = (await cdp.send('HeapProfiler.stopSampling')) as {
        profile: { head: HeapNode }
      }
      interface HeapNode {
        callFrame: { functionName: string; url: string; lineNumber: number }
        selfSize: number
        children: HeapNode[]
      }
      const byFile = new Map<string, number>()
      const byFn = new Map<string, number>()
      let total = 0
      const walk = (n: HeapNode) => {
        total += n.selfSize
        const m =
          /\/src\/(net|game)\/(remote-track|pose-codec|room-session|room-clock|remote-ships|room-client)\.ts/.exec(
            n.callFrame.url,
          )
        if (m) {
          const file = m[2] as string
          byFile.set(file, (byFile.get(file) ?? 0) + n.selfSize)
          const fn = `${file}:${n.callFrame.functionName || '(anon)'}:${n.callFrame.lineNumber + 1}`
          byFn.set(fn, (byFn.get(fn) ?? 0) + n.selfSize)
        }
        for (const c of n.children) walk(c)
      }
      walk(profile.head)
      const top = [...byFn.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10)
      console.log(`room allocation by function (5 s): ${JSON.stringify(top)}`)
      console.log(
        `browser clock offset ${probe.clock.offset.toFixed(1)} ms, rtt ${probe.clock.rtt.toFixed(1)} ms, ` +
          `shared tick ${probe.sharedTick?.toFixed(1)}, own tick ${probe.tick?.toFixed(1)}; crowd ticks ${crowd.ticks().join(',')}`,
      )
      console.log(
        `ships: ${JSON.stringify(probe.ships.map((s) => [s.mode, s.delayMs?.toFixed(0), s.renderTick?.toFixed(1), s.newestTick]))}`,
      )

      const line = (name: string, xs: Sample[]) =>
        `${name}: frame ${mean(xs.map((s) => s.frame.meanMs)).toFixed(2)} ms mean, ` +
        `${mean(xs.map((s) => s.frame.p95Ms)).toFixed(2)} ms p95, ` +
        `${mean(xs.map((s) => s.frame.fps)).toFixed(1)} fps · all draws ${mean(xs.map((s) => s.census.calls)).toFixed(0)} · ` +
        `ships' draws ${xs.map((s) => s.census.group?.calls ?? 0).join('/')} · ` +
        `ships' triangles ${xs.map((s) => s.census.group?.triangles ?? 0).join('/')}`
      console.log(line('SOLO, 5 racers      ', solo))
      console.log(line('ROOM, 5 remote ships', room))
      console.log(
        `remote ships' own frame cost: ${probe.stats.meanMs.toFixed(4)} ms mean (${(probe.stats.meanMs / SHIPS).toFixed(4)} ms a ship), ` +
          `${probe.stats.maxMs.toFixed(3)} ms max, over ${probe.stats.frames} frames`,
      )
      const roomBytes = [...byFile.values()].reduce((a, b) => a + b, 0)
      console.log(
        `allocation over 5 s: ${(total / 1024).toFixed(0)} KiB by the page in all, ` +
          `${(roomBytes / 1024).toFixed(1)} KiB by the room modules (${((100 * roomBytes) / total).toFixed(3)} %) ` +
          `${JSON.stringify(Object.fromEntries(byFile))}`,
      )

      expect(probe.stats.ships).toBe(SHIPS)
      expect(probe.ships.filter((s) => s.loaded)).toHaveLength(SHIPS)
      // Every ship MOVING on its track: interpolated, or briefly extrapolated —
      // never parked on its oldest sample ("early") or frozen past the cap.
      for (const s of probe.ships) expect(['interp', 'extrap']).toContain(s.mode)
      expect(probe.stats.frames).toBeGreaterThan(200)
      // The drawing itself: under a quarter of a millisecond a frame for all five.
      expect(probe.stats.meanMs).toBeLessThan(0.25)
      // What the room's modules allocate is a sliver of what the page does, and
      // no structure is made per frame. Not zero: V8 boxes doubles in code it
      // has not optimised yet, and a socket hands over every message as a fresh
      // ArrayBuffer. Measured 2026-09-27: 463 KiB in 5 s, 0.11 % of the page.
      // A 64-double array per ship per frame is ~2.3 MiB more, and fails this.
      expect(roomBytes / total).toBeLessThan(0.01)
      expect(roomBytes).toBeLessThan(1024 * 1024)
    } finally {
      crowd.stop()
    }
  })
})
