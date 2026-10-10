/**
 * DEV-480's gate in the browser: Faceted Flight TV, reached the way a player
 * reaches it, the hangar's FF-TV table (the title's TV row until DEV-558;
 * docs/plan/FF-TV.md §5.1, call 1), not only a `?tv` link (AGENT-NOTES §8: a
 * spec that boots straight in cannot see the
 * route a player takes).
 *
 * Two rooms in the sidecar, each two autopilot racers in node
 * (`fixtures/room-crowd.ts`); the sidecar answers TV's routes in the shape
 * §3.3 gives them (`fixtures/room-sidecar.ts`; DEV-479's guide, stubbed until
 * it merges) and anonymises what a TV viewer is sent. Pinned:
 *
 *   1. the hangar's FF-TV table boards the race that is on, and its racers are
 *      drawn tagged *Racer 1* and *Racer 2*, never their handles;
 *   2. NEXT RACE moves to the second room's race, the same course, so the
 *      ships are rebuilt without a world build (before DEV-480 only a world
 *      build made them), tagged the same way;
 *   3. when the races end, TV goes to the exhibition, not a spinner;
 *   4. LEAVE TV is the title (START and ENTER VR), and START is the hangar's first step.
 *
 *   FF2_API_PROXY=http://127.0.0.1:6480 E2E_PORT=5480 npx playwright test tv-live
 */

import { bootReady, switchSettled } from './fixtures/boot'
import type { Ff2Global } from './fixtures/ff2'
import { DOOR_TV, pressDoor } from './fixtures/hangar'
import { firstPress } from './fixtures/landing'
import { PINNED } from './fixtures/quality-pin'
import { type Crowd, loadLevel, startCrowd } from './fixtures/room-crowd'
import { type RoomSidecar, startRoomSidecar } from './fixtures/room-sidecar'
import { E2E_BASE as BASE, E2E_CHANNEL as CHANNEL } from './fixtures/server'
import { type Browser, chromium, expect, skipSplash, test } from './fixtures/test'
import { hangarDoors, titleRowsUp, toHangar } from './fixtures/title'
import { pressPlateRow, recordApi, tvOfRoom, tvProbe, visibleTags } from './fixtures/tv'

const PROXY = process.env.FF2_API_PROXY ?? ''
const PHOTOS = process.env.TV_PHOTO_DIR ?? ''

/** A room id of the long (base32) shape, unique to this run. */
const roomIdFor = (tag: string): string =>
  `${tag}${Date.now().toString(32)}abcdefghijklmnop`.slice(0, 16).replace(/[^a-z2-7]/g, 'a')

test.describe('@gpu Faceted Flight TV, live (DEV-480)', () => {
  test.skip(
    !PROXY,
    'set FF2_API_PROXY=http://127.0.0.1:<port> so Vite forwards /api to the room sidecar',
  )
  test.setTimeout(720_000)

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

  test('the hangar’s FF-TV table boards the race on; Next Race; the races end; Leave TV', async () => {
    const level = loadLevel('int_01_hoverJet')
    const roomA = roomIdFor('ta')
    const roomB = roomIdFor('tb')
    const crowds: Crowd[] = []
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
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE })
      const page = await context.newPage()
      const api = recordApi(page)
      page.on('console', (m) => {
        const t = m.text()
        if (/^(tv|watch|level select|quick race|opponents)/.test(t)) console.log(`[viewer] ${t}`)
      })
      await page.goto(`${BASE}/?xr=off&${PINNED}`)
      await bootReady(page, 240_000)
      await firstPress(page)
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      // DEV-558: TV is the hangar's FF-TV table; DEV-565 made it the fourth.
      await titleRowsUp(page)
      await toHangar(page)
      // DEV-620: CREDITS first, off the left end, so FF-TV is the fifth.
      expect(await hangarDoors(page), 'FF-TV is the first step’s last table').toEqual([
        'options',
        'course-editor',
        'quick-race',
        'single-player',
        'multiplayer',
        DOOR_TV,
      ])
      if (PHOTOS) await page.screenshot({ path: `${PHOTOS}/tv-hangar-door.png` })

      // Room A races; TV is pressed once it is on.
      const a = await startCrowd({
        url: `${PROXY.replace(/^http/, 'ws')}/api/room/${roomA}`,
        level,
        count: 2,
        players: 2,
        finish: true,
      })
      crowds.push(a)
      await expect.poll(() => a.goAt(), { timeout: 60_000 }).not.toBeNull()

      // ── 1. the hangar's FF-TV table boards it, the names stripped ───────
      await pressDoor(page, DOOR_TV, 300)
      await expect
        .poll(async () => (await tvProbe(page))?.tv ?? null, { timeout: 30_000 })
        .toBe(await tvOfRoom(PROXY, roomA))
      // Room B starts racing while A's course loads.
      const b = await startCrowd({
        url: `${PROXY.replace(/^http/, 'ws')}/api/room/${roomB}`,
        level,
        count: 2,
        players: 2,
        finish: true,
      })
      crowds.push(b)
      await expect
        .poll(async () => await visibleTags(page), {
          timeout: 120_000,
          message: 'room A’s racers, drawn under the names TV gives them',
        })
        .toEqual(['Racer 1', 'Racer 2'])
      expect((await tvProbe(page))?.mode).toBe('live')
      // The ships exist before the course is built; the camera is TV's once aboard.
      await switchSettled(page, 180_000)
      await expect
        .poll(async () => (await tvProbe(page))?.following ?? null, { timeout: 30_000 })
        .not.toBeNull()
      if (PHOTOS) await page.screenshot({ path: `${PHOTOS}/tv-live-race.png` })
      await expect.poll(() => b.goAt(), { timeout: 60_000 }).not.toBeNull()

      // ── 2. NEXT RACE: room B, the same course, ships rebuilt ─────────────
      console.log(`before NEXT RACE: ${JSON.stringify(await tvProbe(page))}`)
      await pressPlateRow(page, 'tv-next')
      console.log(`after NEXT RACE: ${JSON.stringify(await tvProbe(page))}`)
      await expect
        .poll(async () => (await tvProbe(page))?.tv ?? null, { timeout: 30_000 })
        .toBe(await tvOfRoom(PROXY, roomB))
      await expect
        .poll(async () => await visibleTags(page), {
          timeout: 60_000,
          message: 'room B’s racers, drawn on the course already built',
        })
        .toEqual(['Racer 1', 'Racer 2'])
      // The viewer never asked for either room by its code: TV ids only.
      const asked = api.urls.join(' ')
      expect(asked).toContain('/api/tv/')
      expect(asked).not.toContain(roomA)
      expect(asked).not.toContain(roomB)

      // ── 3. the races end: the exhibition, never a spinner ───────────────
      // The crowd posts no laps to judge, so a race's results come at its
      // time limit and the judge's grace (180 s + 15 s from GO), then TV's 8 s.
      const watching = setInterval(() => {
        void (async () => {
          const list = await fetch(`${PROXY}/api/tv`).then((r) => r.text(), String)
          const phase = await page
            .evaluate(() => (globalThis as unknown as Ff2Global).__ff2.watch()?.phase ?? null)
            .catch(() => 'gone')
          console.log(`[step 3] watch phase ${phase} · list ${list}`)
        })()
      }, 20_000)
      try {
        await expect
          .poll(async () => (await tvProbe(page))?.mode ?? null, {
            timeout: 300_000,
            message: 'both races over, TV shows the exhibition',
          })
          .toBe('exhibition')
      } finally {
        clearInterval(watching)
      }
      // And the exhibition RACES, after a live race: a world built under a watch
      // loaded no AI racers. (On the clock's course; when that is the live
      // race's own, DEV-483's board re-boards it rather than resetting nothing.)
      await expect
        .poll(
          async () =>
            page.evaluate(
              () => (globalThis as unknown as Ff2Global).__ff2.exhibition.probe().phase,
            ),
          { timeout: 180_000, message: 'the exhibition reaches its race' },
        )
        .toBe('racing')
      if (PHOTOS) await page.screenshot({ path: `${PHOTOS}/tv-exhibition-after-live.png` })

      // ── 4. LEAVE TV is the hangar (DEV-628; the title until then) ───────
      // In-page, on every device: the hangar's first step, where FF-TV stands
      // again (DEV-558).
      await pressPlateRow(page, 'tv-leave', 0)
      await expect.poll(() => tvProbe(page), { timeout: 30_000, message: 'TV off' }).toBeNull()
      expect(new URL(page.url()).searchParams.has('tv')).toBe(false)
      await expect
        .poll(() => hangarDoors(page), { timeout: 60_000, message: 'back in the hangar' })
        .toContain(DOOR_TV)
    } finally {
      for (const c of crowds) c.stop()
      await browser?.close()
    }
  })
})
