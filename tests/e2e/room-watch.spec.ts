/**
 * DEV-436's gate in the browser (plan/MULTIPLAYER.md §13): a viewer WATCHES a
 * room through its broadcaster, two seconds behind the race.
 *
 * Two autopilot players in node (`fixtures/room-crowd.ts`, real `RoomSession`s
 * on real sockets) race one room in the sidecar; a browser opens
 * `?watch=<id>`. The sidecar hosts the REAL `BroadcastServer` for that room
 * (`fixtures/room-sidecar.ts`), fed by one link into the real `RoomServer`.
 * Pinned:
 *
 *   1. the viewer hears the broadcaster: a keyframe, then batches;
 *   2. it boards the race's course and draws both racers, flying (moving at
 *      racing speed, nose along their track);
 *   3. it draws them BEHIND the race: the tick it draws a racer at trails the
 *      racer's own by the broadcast delay, and not by much more;
 *   4. the director camera follows a racer, and a press moves it to the next;
 *   5. the viewer never counts as a player: the room seats two.
 *
 *   FF2_API_PROXY=http://127.0.0.1:5398 E2E_PORT=5388 npx playwright test room-watch
 */

import { missionReady } from './fixtures/boot'
import type { Ff2GlobalMaybe } from './fixtures/ff2'
import { firstPress } from './fixtures/landing'
import { PINNED } from './fixtures/quality-pin'
import { type Crowd, loadLevel, startCrowd } from './fixtures/room-crowd'
import { type RoomSidecar, startRoomSidecar } from './fixtures/room-sidecar'
import { E2E_BASE as BASE, E2E_CHANNEL as CHANNEL } from './fixtures/server'
import { type Browser, chromium, expect, type Page, skipSplash, test } from './fixtures/test'

const PROXY = process.env.FF2_API_PROXY ?? ''
const PHOTOS = process.env.ROOM_PHOTO_DIR ?? ''

/** The broadcaster's delay (`BROADCAST_DELAY_MS`), ms, and one fixed step, ms. */
const DELAY_MS = 2000
const STEP_MS = 12.2
/** Racing speed, m/s: an autopilot HoverJet under way. */
const FLYING_MS = 40

interface Ship {
  slot: number
  handle: string
  visible: boolean
  position: [number, number, number] | null
  renderTick: number | null
  noseAlongTrack: number | null
}
interface Watch {
  status: string
  keyframes: number
  batches: number
  delay: number | null
  phase: string | null
  players: number
  following: string | null
  ships: Ship[]
}

const watchProbe = (page: Page): Promise<Watch | null> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2GlobalMaybe
    const r = w.__ff2?.watch()
    return r ? (JSON.parse(JSON.stringify(r)) as Watch) : null
  })

test.describe('@gpu watching a room (DEV-436)', () => {
  test.skip(
    !PROXY,
    'set FF2_API_PROXY=http://127.0.0.1:<port> so Vite forwards /api to the room sidecar',
  )
  test.setTimeout(420_000)

  let sidecar: RoomSidecar
  test.beforeAll(async () => {
    test.setTimeout(360_000)
    sidecar = await startRoomSidecar(Number(new URL(PROXY).port))
    const answer = await fetch(`${PROXY}/api/room-sidecar`).then((r) => r.text())
    expect(answer, 'a stale sidecar is answering on this port').toBe(sidecar.nonce)
  })
  test.afterAll(async () => {
    await sidecar?.close()
  })

  test('a viewer draws the race, two seconds behind it, with a camera that follows', async () => {
    const roomId = `w${Date.now().toString(32)}abcdefghij`.slice(0, 16).replace(/[^a-z2-7]/g, 'a')
    const level = loadLevel('int_01_hoverJet')
    let crowd: Crowd | null = null
    let browser: Browser | null = null
    try {
      browser = await chromium.launch({
        headless: false,
        ...(CHANNEL ? { channel: CHANNEL } : {}),
        args: ['--window-position=0,0', '--window-size=900,640'],
      })
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 880, height: 520 },
      })
      await skipSplash(context)
      const page = await context.newPage()
      page.on('console', (m) => {
        const t = m.text()
        if (/^watch|opponents/.test(t)) console.log(`[viewer] ${t}`)
      })
      // On the course before the race, so its build is not in the measurement.
      await page.goto(`${BASE}/?watch=${roomId}&mission=${level.id}&menu=0&xr=off&${PINNED}`)
      await missionReady(page, 240_000)
      await firstPress(page)
      crowd = await startCrowd({
        url: `${PROXY.replace(/^http/, 'ws')}/api/room/${roomId}`,
        level,
        count: 2,
        players: 2,
      })

      // ── 1. the broadcaster's stream ───────────────────────────────────
      await expect
        .poll(async () => (await watchProbe(page))?.keyframes ?? 0, { timeout: 60_000 })
        .toBeGreaterThan(0)
      // ── 2. both racers, flying ────────────────────────────────────────
      await expect
        .poll(async () => (await watchProbe(page))?.batches ?? 0, { timeout: 180_000 })
        .toBeGreaterThan(20)

      await expect
        .poll(async () => (await watchProbe(page))?.ships.filter((s) => s.visible).length ?? 0, {
          timeout: 120_000,
        })
        .toBe(2)
      const speeds: number[] = []
      const noses: number[] = []
      const lags: number[] = []
      let last = (await watchProbe(page)) as Watch
      for (let i = 0; i < 16; i++) {
        await page.waitForTimeout(500)
        const now = (await watchProbe(page)) as Watch
        const ticks = (crowd as Crowd).ticks()
        for (const ship of now.ships) {
          if (!ship.visible || !ship.position) continue
          const was = last.ships.find((s) => s.slot === ship.slot)
          if (was?.position) {
            speeds.push(
              Math.hypot(
                ship.position[0] - was.position[0],
                ship.position[1] - was.position[1],
                ship.position[2] - was.position[2],
              ) / 0.5,
            )
          }
          if (ship.noseAlongTrack !== null) noses.push(ship.noseAlongTrack)
          // ── 3. behind the race: the racer's own tick, less the drawn one ─
          const own = ticks[ship.slot]
          if (own !== undefined && ship.renderTick !== null)
            lags.push((own - ship.renderTick) * STEP_MS)
        }
        last = now
      }
      speeds.sort((a, b) => a - b)
      noses.sort((a, b) => a - b)
      lags.sort((a, b) => a - b)
      const p50 = (xs: number[]) => xs[Math.floor(xs.length / 2)] as number
      console.log(
        `viewer: ${speeds.length} speeds, p50 ${p50(speeds).toFixed(1)} m/s · nose p05 ${noses[Math.floor(noses.length * 0.05)]?.toFixed(3)} · lag behind the race p50 ${p50(lags).toFixed(0)} ms, min ${lags[0]?.toFixed(0)}, max ${lags.at(-1)?.toFixed(0)}`,
      )
      expect(p50(speeds)).toBeGreaterThan(FLYING_MS)
      expect(noses[Math.floor(noses.length * 0.05)]).toBeGreaterThan(0.9)
      expect(lags.length).toBeGreaterThan(20)
      expect(lags[0]).toBeGreaterThan(DELAY_MS)
      expect(p50(lags)).toBeLessThan(DELAY_MS + 1500)

      // ── 4. the camera follows, and a press moves it on ────────────────
      const first = (await watchProbe(page))?.following
      expect(first, 'the director camera has a racer').not.toBeNull()
      if (PHOTOS)
        await page.screenshot({
          path: `${PHOTOS}/watch-follows-${PINNED.replace(/[=&]/g, '-')}.png`,
        })
      await page.keyboard.down('Enter')
      await page.waitForTimeout(200)
      await page.keyboard.up('Enter')
      await expect.poll(async () => (await watchProbe(page))?.following).not.toBe(first)

      // ── 5. a viewer is not a player ───────────────────────────────────
      const w = (await watchProbe(page)) as Watch
      expect(w.players).toBe(2)
      expect(w.delay).toBe(DELAY_MS)
    } finally {
      crowd?.stop()
      await browser?.close()
    }
  })
})
