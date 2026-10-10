/**
 * DEV-390's gate (plan/MULTIPLAYER.md §8): two separate browsers race one room
 * to the finish, each lap is JUDGED by the lap Function's real handler, and
 * both browsers show the same results panel — one place and one time per
 * player, the judge's, on both.
 *
 * A flies from GO (`?autopilot=1`). B boards the same way without it
 * (`?menu=0`, the switch that skips the menus, as `?autopilot=1` does), waits
 * on the pad and takes the autopilot (P, as a player does) seven seconds
 * later, so the race has a known order. While B waits it is looking up the
 * course at A: the frame from B's seat has A's hull and name tag in it — the
 * remote ship's look, which DEV-388's photos missed — and once A is well up
 * the course the live place on B's race map reads 2 of 2 and A's 1 of 2.
 *
 * Measured 2026-09-26, twice, identical: A 61.2562 s (5,021 ticks), B 68.7104 s
 * (5,632), both judged `ok` by the real judge; both panels 1st A, 2nd B, the
 * judge's times. The first photographs from the seat found two bugs the
 * assertions could not: the other player's time run under a long name, and a
 * name tag drawn over the results panel (DEV-390's row).
 *
 * The room and the judge are `fixtures/room-sidecar.ts`: the real `RoomServer`
 * and the real `judgeRoomLap`/`answerRoomLink` pair, behind Vite's `/api` proxy.
 *
 *   FF2_API_PROXY=http://127.0.0.1:5398 E2E_PORT=5388 ROOM_PHOTO_DIR=<dir> \
 *     npx playwright test room-results
 *
 * Photographs are pinned (`PINNED`) and taken from the seat. Tagged `@gpu`.
 */

import { missionReady } from './fixtures/boot'
import type { Ff2Global, Ff2GlobalMaybe } from './fixtures/ff2'
import { firstPress } from './fixtures/landing'
import { type RoomSidecar, startRoomSidecar } from './fixtures/room-sidecar'
import { E2E_BASE as BASE, E2E_CHANNEL as CHANNEL } from './fixtures/server'
import { type Browser, chromium, expect, type Page, skipSplash, test } from './fixtures/test'

const PROXY = process.env.FF2_API_PROXY ?? ''
const PHOTOS = process.env.ROOM_PHOTO_DIR ?? null
const PINNED = 'xr=off&adaptive=0&quality=high&mission=int_01_hoverJet&menu=0'

interface Row {
  name: string
  you: boolean
  status: string
  seconds: number | null
  place: number | null
}
interface Probe {
  slot: number | null
  owner: number | null
  settings: unknown
  goAt: number | null
  goRoom: number | null
  tick: number | null
  players: Record<number, { handle: string }>
  ships: Array<{
    slot: number
    visible: boolean
    position: [number, number, number] | null
    renderTick: number | null
  }>
  results: Array<{ slot: number; verdict: string; ticks: number | null; seconds: number | null }>
  posted: { verdict: string | null; status: number; error: string | null } | null
  standings: Row[] | null
}

const probe = (page: Page): Promise<Probe | null> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2GlobalMaybe
    const r = w.__ff2?.room() as Record<string, unknown> | null | undefined
    if (!r) return null
    const { ready: _r, start: _s, truth: _t, resetStats: _x, ...plain } = r
    return JSON.parse(JSON.stringify(plain)) as Probe
  })

const raceMap = (page: Page): Promise<{ place: number | null; field: number } | null> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2Global
    const r = w.__ff2.raceMap()
    return r ? { place: r.place, field: r.field } : null
  })

/** DEV-391: the owner's Bots row, off: this spec races people only (bots: `room-bots.spec.ts`). */
const botsOff = async (owner: Page, other: Page): Promise<void> => {
  await owner.evaluate(() => {
    const w = globalThis as unknown as Ff2Global
    w.__ff2.room()?.bots(false)
  })
  for (const p of [owner, other]) {
    await expect
      .poll(async () => ((await probe(p))?.settings as { bots?: boolean } | null)?.bots)
      .toBe(false)
  }
}

const call = (page: Page, verb: 'ready' | 'start') =>
  page.evaluate((v) => {
    const w = globalThis as unknown as Ff2Global
    w.__ff2.room()?.[v]()
  }, verb)

const open = async (
  x: number,
  roomId: string,
  autopilot: boolean,
  log: string[],
): Promise<{ browser: Browser; page: Page }> => {
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
    if (/^room|opponents|lap:|autopilot/.test(t)) {
      log.push(t)
      console.log(`[${x}] ${t}`)
    }
  })
  await page.goto(`${BASE}/?${PINNED}&room=${roomId}${autopilot ? '&autopilot=1' : ''}`)
  await firstPress(page)
  return { browser, page }
}

/** A panel as a player-neutral board: each player's handle, place and time. */
const board = (p: Probe): Array<{ handle: string; place: number | null; seconds: number | null }> =>
  (p.standings ?? [])
    .map((r) => ({
      // The panel names the others `handle · assisted`; "you" is this page's own handle.
      handle: r.you
        ? (p.players[p.slot as number]?.handle as string)
        : (r.name.split(' · ')[0] as string),
      place: r.place,
      seconds: r.seconds,
    }))
    .sort((x, y) => x.handle.localeCompare(y.handle))

test.describe('@gpu two browsers race one room to a judged result', () => {
  test.skip(
    !PROXY,
    'set FF2_API_PROXY=http://127.0.0.1:<port> so Vite forwards /api to the room sidecar',
  )
  test.setTimeout(480_000)

  let sidecar: RoomSidecar
  test.beforeAll(async () => {
    // Long enough to wait out another room spec holding the sidecar port
    // (`startRoomSidecar` waits for it rather than failing EADDRINUSE).
    test.setTimeout(360_000)
    sidecar = await startRoomSidecar(Number(new URL(PROXY).port))
    const answer = await fetch(`${PROXY}/api/room-sidecar`).then((r) => r.text())
    expect(answer, 'a stale sidecar is answering on this port').toBe(sidecar.nonce)
  })
  test.afterAll(async () => {
    await sidecar?.close()
  })

  test('both browsers show the same results panel, placed by the judge', async () => {
    const roomId = `r${Date.now().toString(32)}abcdefghij`.slice(0, 16).replace(/[^a-z2-7]/g, 'a')
    const logA: string[] = []
    const logB: string[] = []
    const a = await open(0, roomId, true, logA)
    await expect.poll(async () => (await probe(a.page))?.owner, { timeout: 180_000 }).toBe(0)
    const b = await open(920, roomId, false, logB)
    try {
      for (const p of [a.page, b.page]) {
        await missionReady(p, 240_000)
      }
      await expect.poll(async () => (await probe(b.page))?.slot, { timeout: 60_000 }).toBe(1)
      await expect.poll(async () => (await probe(a.page))?.settings !== null).toBe(true)
      await expect.poll(async () => (await probe(b.page))?.settings !== null).toBe(true)
      await botsOff(a.page, b.page)
      await call(a.page, 'ready')
      await call(b.page, 'ready')
      await expect
        .poll(
          async () => {
            await call(a.page, 'start')
            return (await probe(a.page))?.goAt ?? null
          },
          { timeout: 60_000, intervals: [1_000] },
        )
        .not.toBeNull()
      for (const p of [a.page, b.page]) {
        await expect
          .poll(async () => (await probe(p))?.goRoom ?? null, { timeout: 60_000 })
          .not.toBeNull()
      }

      // ── B on the pad, A away up the course: the live place, and the look ──
      await expect
        .poll(async () => (await probe(b.page))?.ships[0]?.visible ?? false, { timeout: 10_000 })
        .toBe(true)
      await expect.poll(async () => (await probe(b.page))?.tick ?? 0).toBeGreaterThan(110)
      if (PHOTOS) {
        await b.page.screenshot({ path: `${PHOTOS}/room-b-sees-a-adaptive0-high.png` })
      }
      // The live place, once A is well up the course. Not at 1.3 s: the pad is
      // short of where the racing line begins, so for the first seconds BOTH
      // measure at its start and tie (P1 each, measured 2026-09-26), as a solo
      // player and the racers do on the grid.
      await expect
        .poll(async () => (await probe(b.page))?.ships[0]?.renderTick ?? 0, { timeout: 20_000 })
        .toBeGreaterThan(500)
      const placeB = await raceMap(b.page)
      const placeA = await raceMap(a.page)
      const seen = (await probe(b.page)) as Probe
      console.log(
        `live place at B's tick ${seen.tick?.toFixed(0)}: A ${placeA?.place}/${placeA?.field} · ` +
          `B ${placeB?.place}/${placeB?.field} · B draws A at ${JSON.stringify(seen.ships[0]?.position)}`,
      )
      expect(placeB).toEqual({ place: 2, field: 2 })
      expect(placeA).toEqual({ place: 1, field: 2 })

      // B takes the autopilot, as a player does: P.
      await b.page.keyboard.down('KeyP')
      await b.page.waitForTimeout(200)
      await b.page.keyboard.up('KeyP')
      await expect.poll(() => logB.some((l) => l.startsWith('autopilot ON'))).toBe(true)

      // ── both finish; both laps judged ────────────────────────────────
      for (const p of [a.page, b.page]) {
        await expect
          .poll(async () => (await probe(p))?.results.length ?? 0, {
            timeout: 240_000,
            intervals: [1_000],
          })
          .toBe(2)
      }
      const pa = (await probe(a.page)) as Probe
      const pb = (await probe(b.page)) as Probe
      console.log(`posted: A ${JSON.stringify(pa.posted)} · B ${JSON.stringify(pb.posted)}`)
      console.log(`verdicts: ${JSON.stringify(pa.results)}`)
      expect(pa.posted?.verdict).toBe('ok')
      expect(pb.posted?.verdict).toBe('ok')
      expect(sidecar.laps.map((l) => l.status)).toEqual([200, 200])
      for (const v of pa.results) expect(v.verdict).toBe('ok')
      expect(pb.results).toEqual(pa.results)

      // ── the same panel on both ───────────────────────────────────────
      await expect.poll(async () => (await probe(a.page))?.standings?.length ?? 0).toBe(2)
      await expect.poll(async () => (await probe(b.page))?.standings?.length ?? 0).toBe(2)
      const fa = (await probe(a.page)) as Probe
      const fb = (await probe(b.page)) as Probe
      const boardA = board(fa)
      const boardB = board(fb)
      console.log(`panel A: ${JSON.stringify(fa.standings)}`)
      console.log(`panel B: ${JSON.stringify(fb.standings)}`)
      expect(boardB).toEqual(boardA)
      // The order the race says: A crossed first, and every time is the judge's.
      const handleA = fa.players[0]?.handle as string
      const handleB = fa.players[1]?.handle as string
      const verdictOf = (slot: number) => fa.results.find((r) => r.slot === slot)
      expect(boardA).toEqual(
        [
          { handle: handleA, place: 1, seconds: verdictOf(0)?.seconds },
          { handle: handleB, place: 2, seconds: verdictOf(1)?.seconds },
        ].sort((x, y) => x.handle.localeCompare(y.handle)),
      )
      if (PHOTOS) {
        await a.page.screenshot({ path: `${PHOTOS}/room-results-panel-a-adaptive0-high.png` })
        await b.page.screenshot({ path: `${PHOTOS}/room-results-panel-b-adaptive0-high.png` })
      }
    } finally {
      await a.browser.close()
      await b.browser.close()
    }
  })
})
