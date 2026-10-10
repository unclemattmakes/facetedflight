/**
 * DEV-391's gate in the browser (plan/MULTIPLAYER.md §6.6, §8): a room's bots.
 *
 * Two browsers, bots ON (the owner's default). The owner, A, is the bot host:
 * it flies the four empty starts' racers on its own fixed step — single
 * player's racers, from the starts the room handed out, in the colours it gave
 * them — and streams them in its own pose message. B draws them. Pinned:
 *
 *   1. A flies four bots and B draws four, one to each of the room's bots;
 *   2. B's bots are in the air and flying the course: moving at racing speed,
 *      nose along their track (the orientation lesson: the geometry, not the
 *      rotation), each from the start the room gave it;
 *   3. the host reports each bot's finish; both pages hear the same finishes,
 *      and both panels list the same bots with the same times.
 *
 * Both players fly on the autopilot so the race ends.
 *
 * And DEV-587, on the player's route (Matt, 2026-10-03: *"can't start the
 * multiplayer room and have it fill empty seats with bots"*): one browser,
 * START, the hangar's MULTIPLAYER and HOST A RACE, the lobby, and ONE press of
 * the lobby's START with every other seat empty and READY never pressed. The
 * room starts, the host boards with no ride, and it flies an AI racer on every
 * empty start, under way. Before DEV-587 that press did nothing: the owner
 * was the one player START waited for. `FF2_CHANNEL=release` runs it on a
 * release build. `ROOM_PHOTO_DIR` photographs the lobby before the press.
 *
 * The room is `fixtures/room-sidecar.ts`. Run with:
 *
 *   FF2_API_PROXY=http://127.0.0.1:5398 E2E_PORT=5388 npx playwright test room-bots
 */

import { bootReady } from './fixtures/boot'
import type { Ff2Global, Ff2GlobalMaybe } from './fixtures/ff2'
import { DOOR_HOST } from './fixtures/hangar'
import { firstPress } from './fixtures/landing'
import { PINNED } from './fixtures/quality-pin'
import { type RoomSidecar, startRoomSidecar } from './fixtures/room-sidecar'
import { E2E_BASE as BASE, E2E_CHANNEL as CHANNEL } from './fixtures/server'
import { type Browser, chromium, expect, type Page, skipSplash, test } from './fixtures/test'
import { titleMenu, toHangarDoor } from './fixtures/title'

const PROXY = process.env.FF2_API_PROXY ?? ''
/** Where the DEV-587 test's photographs go, when set. */
const PHOTOS = process.env.ROOM_PHOTO_DIR ?? ''

/** Racing speed, m/s: a bot under way on the course (a racer cruises near 90). */
const FLYING_MS = 40

interface Ship {
  slot: number
  bot: number | null
  visible: boolean
  position: [number, number, number] | null
  noseAlongTrack: number | null
}
interface Probe {
  slot: number | null
  owner: number | null
  settings: { bots: boolean; seats: number } | null
  phase: string | null
  players: Record<number, { ready: boolean }>
  lobby: {
    heading: string
    aim: number
    rows: { id: string; label: string; value: string | null; note: string }[]
  } | null
  goAt: number | null
  goRoom: number | null
  ships: Ship[]
  botFinishes: { bot: number; tick: number }[]
  standings: { name: string; ai?: boolean; seconds: number | null; status: string }[] | null
}

const probe = (page: Page): Promise<Probe | null> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2GlobalMaybe
    const r = w.__ff2?.room() as Record<string, unknown> | null | undefined
    return r ? (JSON.parse(JSON.stringify(r)) as Probe) : null
  })

const call = (page: Page, verb: 'ready' | 'start') =>
  page.evaluate((v) => {
    const w = globalThis as unknown as Ff2Global
    w.__ff2.room()?.[v]()
  }, verb)

/** The host's own racers: how many, and each one's position (THREE world). */
const hostRacers = (page: Page) =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2Global
    return w.__ff2.racers()?.count ?? 0
  })

const open = async (x: number, roomId: string): Promise<{ browser: Browser; page: Page }> => {
  const browser = await chromium.launch({
    headless: false,
    ...(CHANNEL ? { channel: CHANNEL } : {}),
    args: [`--window-position=${x},0`, '--window-size=900,640'],
  })
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 880, height: 520 },
  })
  await skipSplash(context)
  const page = await context.newPage()
  page.on('console', (m) => {
    const t = m.text()
    if (/^room|opponents/.test(t)) console.log(`[${x}] ${t}`)
  })
  await page.goto(
    `${BASE}/?room=${roomId}&mission=int_01_hoverJet&autopilot=1&xr=off&adaptive=0&quality=low`,
  )
  await firstPress(page)
  return { browser, page }
}

test.describe('@gpu a room’s bots (DEV-391)', () => {
  test.skip(
    !PROXY,
    'set FF2_API_PROXY=http://127.0.0.1:<port> so Vite forwards /api to the room sidecar',
  )
  test.setTimeout(600_000)

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

  test('the owner flies the empty starts, the other draws them, both list their finishes', async () => {
    const roomId = `b${Date.now().toString(32)}abcdefghij`.slice(0, 16).replace(/[^a-z2-7]/g, 'a')
    const a = await open(0, roomId)
    await expect.poll(async () => (await probe(a.page))?.owner, { timeout: 180_000 }).toBe(0)
    const b = await open(920, roomId)
    try {
      await expect.poll(async () => (await probe(b.page))?.slot, { timeout: 180_000 }).toBe(1)
      for (const p of [a.page, b.page]) {
        await expect
          .poll(async () => (await probe(p))?.settings?.bots ?? null, { timeout: 60_000 })
          .toBe(true)
      }
      await call(a.page, 'ready')
      await call(b.page, 'ready')
      await expect
        .poll(
          async () => {
            await call(a.page, 'start')
            return (await probe(a.page))?.goAt ?? null
          },
          { timeout: 240_000, intervals: [1_000] },
        )
        .not.toBeNull()
      for (const p of [a.page, b.page]) {
        await expect
          .poll(async () => (await probe(p))?.goRoom ?? null, { timeout: 240_000 })
          .not.toBeNull()
      }

      // ── 1. four bots: flown by A, drawn by B ──────────────────────────
      expect(await hostRacers(a.page), 'the host flies the empty starts').toBe(4)
      await expect
        .poll(async () => (await probe(b.page))?.ships.filter((s) => s.bot !== null).length)
        .toBe(4)
      expect(
        (await probe(a.page))?.ships.some((s) => s.bot !== null),
        'the host draws none from a stream: it flies them',
      ).toBe(false)

      // ── 2. B's bots fly the course ────────────────────────────────────
      const speeds: number[] = []
      const noses: number[] = []
      let last = (await probe(b.page)) as Probe
      for (let i = 0; i < 20; i++) {
        await b.page.waitForTimeout(500)
        const now = (await probe(b.page)) as Probe
        for (const ship of now.ships) {
          if (ship.bot === null || !ship.visible || !ship.position) continue
          const was = last.ships.find((s) => s.bot === ship.bot)
          if (was?.position) {
            const d = Math.hypot(
              ship.position[0] - was.position[0],
              ship.position[1] - was.position[1],
              ship.position[2] - was.position[2],
            )
            speeds.push(d / 0.5)
          }
          if (ship.noseAlongTrack !== null) noses.push(ship.noseAlongTrack)
        }
        last = now
      }
      speeds.sort((x, y) => x - y)
      noses.sort((x, y) => x - y)
      console.log(
        `B's bots: ${speeds.length} speed samples, p50 ${speeds[Math.floor(speeds.length / 2)]?.toFixed(1)} m/s; nose p05 ${noses[Math.floor(noses.length * 0.05)]?.toFixed(3)}`,
      )
      expect(speeds.length).toBeGreaterThan(40)
      expect(speeds[Math.floor(speeds.length / 2)]).toBeGreaterThan(FLYING_MS)
      expect(noses[Math.floor(noses.length * 0.05)]).toBeGreaterThan(0.9)

      // ── 3. the finishes, heard alike, listed alike ────────────────────
      for (const p of [a.page, b.page]) {
        await expect
          .poll(async () => (await probe(p))?.botFinishes.length ?? 0, { timeout: 240_000 })
          .toBe(4)
      }
      const fa = ((await probe(a.page)) as Probe).botFinishes
      const fb = ((await probe(b.page)) as Probe).botFinishes
      console.log(`bot finishes: ${JSON.stringify(fa)}`)
      expect(fb).toEqual(fa)
      const bots = async (page: Page) => {
        await expect
          .poll(async () => (await probe(page))?.standings?.length ?? 0, { timeout: 240_000 })
          .toBe(6)
        return ((await probe(page)) as Probe).standings
          ?.filter((r) => r.ai)
          .map((r) => [r.name, r.seconds])
          .sort()
      }
      const [boardA, boardB] = [await bots(a.page), await bots(b.page)]
      console.log(`A's panel: ${JSON.stringify(boardA)}`)
      expect(boardA).toHaveLength(4)
      expect(boardB).toEqual(boardA)
    } finally {
      await a.browser.close()
      await b.browser.close()
    }
  })

  test('a host alone presses START once, and AI racers fill the empty starts (DEV-587)', async () => {
    const browser = await chromium.launch({
      headless: false,
      ...(CHANNEL ? { channel: CHANNEL } : {}),
      args: ['--window-position=0,0', '--window-size=1300,840'],
    })
    try {
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 1280, height: 720 },
      })
      await skipSplash(context)
      const page = await context.newPage()
      page.on('console', (m) => {
        const t = m.text()
        if (/^room|opponents/.test(t)) console.log(`[alone] ${t}`)
      })
      // The player's route: no `?room=`, no `?mission=`, no autopilot.
      await page.goto(`${BASE}/?xr=off&${PINNED}`)
      await bootReady(page, 240_000)
      await firstPress(page)
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await expect
        .poll(async () => (await titleMenu(page))?.up ?? false, { timeout: 60_000 })
        .toBe(true)
      await toHangarDoor(page, DOOR_HOST, 400)
      await expect
        .poll(async () => (await probe(page))?.lobby?.heading ?? null, { timeout: 60_000 })
        .toBe('- ROOM -')
      await expect
        .poll(async () => (await probe(page))?.settings?.bots ?? null, { timeout: 60_000 })
        .toBe(true)
      const before = (await probe(page)) as Probe
      const empty = (before.settings?.seats as number) - 1
      expect(empty, 'a course with starts to fill').toBeGreaterThan(0)
      expect(Object.values(before.players ?? {}), 'nobody is ready').toEqual([
        expect.objectContaining({ ready: false }),
      ])
      const startRow = () =>
        probe(page).then((p) => p?.lobby?.rows.find((r) => r.id === 'start') ?? null)
      await expect
        .poll(async () => (await startRow())?.note)
        .toBe(`press to race: AI racers fill the ${empty} empty starts`)

      // Walk to START with the arrow keys, as a player steps the plate.
      const index = (before.lobby?.rows ?? []).findIndex((r) => r.id === 'start')
      for (let i = 0; i < 16; i++) {
        const at = (await probe(page))?.lobby?.aim ?? -1
        if (at === index) break
        await page.keyboard.down(at < index ? 'ArrowDown' : 'ArrowUp')
        await page.waitForTimeout(150)
        await page.keyboard.up(at < index ? 'ArrowDown' : 'ArrowUp')
        await page.waitForTimeout(150)
      }
      expect((await probe(page))?.lobby?.aim, 'the arrow keys reached START').toBe(index)
      if (PHOTOS) await page.screenshot({ path: `${PHOTOS}/alone-lobby-start-selected.png` })
      // ONE press. Held, not tapped: a confirm is a level read once a frame.
      await page.keyboard.down('Enter')
      await page.waitForTimeout(200)
      await page.keyboard.up('Enter')

      await expect
        .poll(async () => (await probe(page))?.goRoom ?? null, { timeout: 240_000 })
        .not.toBeNull()
      expect(await hostRacers(page), 'an AI racer on every empty start').toBe(empty)
      // Under way: each racer has moved off its start at racing speed.
      const at = () =>
        page.evaluate(() => {
          const w = globalThis as unknown as Ff2Global
          return (w.__ff2.racers()?.racers ?? []).map((r) => {
            const p = r.jet.body.position
            return [p.x, p.y, p.z]
          })
        })
      await page.waitForTimeout(6_000)
      const p0 = await at()
      await page.waitForTimeout(1_000)
      const p1 = await at()
      const speeds = p0.map((a, i) => {
        const b = p1[i] as number[]
        return Math.hypot(
          (b[0] as number) - (a[0] as number),
          (b[1] as number) - (a[1] as number),
          (b[2] as number) - (a[2] as number),
        )
      })
      console.log(`[alone] the racers' speeds, m/s: ${speeds.map((s) => s.toFixed(1)).join(', ')}`)
      expect(speeds).toHaveLength(empty)
      for (const s of speeds) expect(s, 'every racer is flying').toBeGreaterThan(FLYING_MS)
      if (PHOTOS) await page.screenshot({ path: `${PHOTOS}/alone-race.png` })
    } finally {
      await browser.close()
    }
  })
})
