/**
 * DEV-388's gate (plan/MULTIPLAYER.md §8, §9.3): two SEPARATE browsers, side by
 * side, in one room. Both reach GO within 50 ms of each other by the room's
 * clock, each draws the other, and the drawn copy is within a pinned distance
 * of the other's own pose at the same shared tick.
 *
 * Two lessons from king-tide's own two-browser spec, kept: two BROWSER
 * INSTANCES, not two tabs, in NON-OVERLAPPING windows — Chromium pauses the
 * frames of an occluded window, and a throttled page's sim crawls while its
 * socket keeps every counter green ("cost a day of flake-chasing").
 *
 * The room is `fixtures/room-sidecar.ts`: the real `RoomServer` class in this
 * worker's node process, reached through Vite's `/api` proxy, so the game
 * connects to its own origin exactly as on Cloudflare. Run with:
 *
 *   FF2_API_PROXY=http://127.0.0.1:5398 E2E_PORT=5388 npx playwright test room-two-browsers
 *
 * Without `FF2_API_PROXY` the dev server has no `/api` and this skips, saying so.
 *
 * READY and START go through `__ff2.room()` — the lobby's own READY and START
 * (DEV-389), whose plates `room-lobby.spec.ts` walks; from START on, both pages
 * run the path a player's does: no lift, the room's barrier and GO, the
 * countdown started on the room's clock.
 *
 * DEV-477 — Matt, 2026-09-27: *"plz verify that our multiplayer players aren't
 * all spawned at the same location. 1 player per start-point (players instead
 * of the ai racers)"*. Each ship stands on a start of the course's list before
 * GO and is released from it — two people, two different start points, each
 * drawn on its own by the other — against the judge's own list
 * (`content/lap-courses.json`), which the page never reads to place itself.
 */

import fs from 'node:fs'
import path from 'node:path'
import { missionReady } from './fixtures/boot'
import type { Ff2Global, Ff2GlobalMaybe } from './fixtures/ff2'
import { firstPress } from './fixtures/landing'
import { type RoomSidecar, startRoomSidecar } from './fixtures/room-sidecar'
import { E2E_BASE as BASE, E2E_CHANNEL as CHANNEL } from './fixtures/server'
import { type Browser, chromium, expect, type Page, skipSplash, test } from './fixtures/test'

const PROXY = process.env.FF2_API_PROXY ?? ''

/**
 * The drawn copy against the other's own pose at the same shared tick, metres.
 * Measured on this machine, 2026-09-27, two headed windows and a local room
 * (no added latency): p50 0.001 m, p95 0.004 m, max 0.005 m over 178 samples.
 * The headless race (DEV-387) holds 0.037 m at p99 over a far worse link; a
 * real page adds frame-timed sampling on both ends, so these carry margin, and
 * a frame bug (a lost z flip, a missing offset) is kilometres, not centimetres.
 */
const DRAWN_P95_M = 0.1
const DRAWN_MAX_M = 2
/** Both releases, room ms apart (§8 DEV-388: "within 50 ms of each other"). */
const GO_SPREAD_MS = 50
/**
 * DEV-477: metres a ship may stand from its start point, in 3D. It is placed
 * there exactly (the judge allows 1 m); the other page draws it there too.
 */
const ON_START_M = 0.5
/** The course this spec races. */
const MISSION = 'int_01_hoverJet'

/**
 * DEV-477: the course's start points, THREE space — the JUDGE's list
 * (`content/lap-courses.json`, SIM space, mirrored here), which is generated
 * from the level and the preset and read by no page to place a ship.
 */
const startPoints = (mission: string): number[][] => {
  const file = path.join(process.cwd(), 'content', 'lap-courses.json')
  const courses = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    courses: Record<string, { editions: Record<string, { rooms?: { starts: number[][] } }> }>
  }
  const sim = courses.courses[mission]?.editions.anniversary?.rooms?.starts ?? []
  return sim.map(([x, y, z]) => [x as number, y as number, -(z as number)])
}

/** The start point nearest `at`, and how far, metres. */
const nearestStart = (at: readonly number[], list: number[][]) =>
  list.reduce(
    (best, s, index) => {
      const d = Math.hypot(
        (at[0] as number) - (s[0] as number),
        (at[1] as number) - (s[1] as number),
        (at[2] as number) - (s[2] as number),
      )
      return d < best.distance ? { index, distance: d } : best
    },
    { index: -1, distance: Number.POSITIVE_INFINITY },
  )

interface Probe {
  status: string
  slot: number | null
  owner: number | null
  phase: string | null
  settings: unknown
  goAt: number | null
  goRoom: number | null
  tick: number | null
  sharedTick: number | null
  /** DEV-477: this page's own start, THREE world, and where its ship is. */
  ownStart: [number, number, number] | null
  ownAt: [number, number, number] | null
  ships: Array<{
    slot: number
    loaded: boolean
    visible: boolean
    mode: string
    position: [number, number, number] | null
    renderTick: number | null
    noseAlongTrack: number | null
  }>
}

const probe = (page: Page): Promise<Probe | null> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2GlobalMaybe
    const r = w.__ff2?.room() as Record<string, unknown> | null | undefined
    if (!r) return null
    const { ready: _r, start: _s, truth: _t, resetStats: _x, ...plain } = r
    return JSON.parse(JSON.stringify(plain)) as Probe
  })

const truthAt = (page: Page, tick: number): Promise<[number, number, number] | null> =>
  page.evaluate((t) => {
    const w = globalThis as unknown as Ff2Global
    return w.__ff2.room()?.truth(t) ?? null
  }, tick)

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
    if (/^room|opponents|lap:|countdown/.test(t)) console.log(`[${x}] ${t}`)
  })
  await page.goto(
    `${BASE}/?room=${roomId}&mission=${MISSION}&autopilot=1&xr=off&adaptive=0&quality=low`,
  )
  await firstPress(page)
  return { browser, page }
}

test.describe('@gpu two browsers, one room', () => {
  test.skip(
    !PROXY,
    'set FF2_API_PROXY=http://127.0.0.1:<port> so Vite forwards /api to the room sidecar',
  )
  test.setTimeout(420_000)

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

  test('both reach GO together, and each draws the other where it is', async () => {
    const roomId = `e2e${Date.now().toString(32)}abcdefgh`.slice(0, 16).replace(/[^a-z2-7]/g, 'a')
    const a = await open(0, roomId)
    // B joins once A is the owner, so the owner is deterministic.
    await expect.poll(async () => (await probe(a.page))?.owner, { timeout: 180_000 }).toBe(0)
    const b = await open(920, roomId)
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

      // ── DEV-477: before GO, each on its own start point, and drawn there ──
      const list = startPoints(MISSION)
      expect(list, "the judge's list of start points").toHaveLength(6)
      const standing: Record<'a' | 'b', number> = { a: -1, b: -1 }
      const drawnOn: Record<'a' | 'b', number> = { a: -1, b: -1 }
      for (let i = 0; i < 40; i++) {
        const [pa, pb] = [(await probe(a.page)) as Probe, (await probe(b.page)) as Probe]
        if (pa.goRoom !== null || pb.goRoom !== null) break
        for (const [k, own, other] of [
          ['a', pa, pb],
          ['b', pb, pa],
        ] as const) {
          if (own.ownAt && own.ownStart) {
            const at = nearestStart(own.ownAt, list)
            const start = nearestStart(own.ownStart, list)
            if (at.distance < ON_START_M && start.index === at.index) standing[k] = at.index
          }
          // The OTHER page's copy of this ship, still on its start before its GO.
          const drawn = other.ships[0]
          if (drawn?.visible && drawn.position) {
            const on = nearestStart(drawn.position, list)
            if (on.distance < ON_START_M) drawnOn[k] = on.index
          }
        }
        if (standing.a >= 0 && standing.b >= 0 && drawnOn.a >= 0 && drawnOn.b >= 0) break
        await a.page.waitForTimeout(100)
      }
      console.log(
        `starts before GO: A on ${standing.a} (drawn by B on ${drawnOn.a}) · B on ${standing.b} (drawn by A on ${drawnOn.b})`,
      )
      expect(standing.a, 'A stands on a start point').toBeGreaterThanOrEqual(0)
      expect(standing.b, 'B stands on a start point').toBeGreaterThanOrEqual(0)
      expect(standing.a, 'two people, two start points').not.toBe(standing.b)
      expect(drawnOn.a, 'B draws A on A’s start').toBe(standing.a)
      expect(drawnOn.b, 'A draws B on B’s start').toBe(standing.b)

      // ── GO, together ────────────────────────────────────────────────
      await expect
        .poll(async () => (await probe(a.page))?.goRoom ?? null, { timeout: 60_000 })
        .not.toBeNull()
      await expect
        .poll(async () => (await probe(b.page))?.goRoom ?? null, { timeout: 60_000 })
        .not.toBeNull()
      const pa = (await probe(a.page)) as Probe
      const pb = (await probe(b.page)) as Probe
      expect(pa.goAt).toBe(pb.goAt)
      const spread = Math.abs((pa.goRoom as number) - (pb.goRoom as number))
      console.log(
        `GO: field ${pa.goAt} · A released at room ${pa.goRoom?.toFixed(1)} · B at ${pb.goRoom?.toFixed(1)} · spread ${spread.toFixed(1)} ms`,
      )
      expect(spread).toBeLessThan(GO_SPREAD_MS)
      expect(Math.abs((pa.goRoom as number) - (pa.goAt as number))).toBeLessThan(GO_SPREAD_MS)
      // DEV-477: and each was RELEASED there — its own pose at the first ticks
      // of its lap, which is what the judge reads as the lap's start.
      for (const [k, page] of [
        ['a', a.page],
        ['b', b.page],
      ] as const) {
        const first = (await truthAt(page, 0)) ?? (await truthAt(page, 1))
        expect(first, `${k}: its first poses are held`).not.toBeNull()
        const on = nearestStart(first as number[], list)
        console.log(`${k} released ${on.distance.toFixed(3)} m from start ${on.index}`)
        expect(on.index, `${k} released from its own start`).toBe(standing[k])
        expect(on.distance).toBeLessThan(ON_START_M)
      }

      // ── each draws the other, where the other is ────────────────────
      const errors: number[] = []
      const noses: number[] = []
      const deadline = Date.now() + 25_000
      while (Date.now() < deadline) {
        for (const [watcher, flyer] of [
          [a.page, b.page],
          [b.page, a.page],
        ] as const) {
          const w = (await probe(watcher)) as Probe
          const ship = w.ships[0]
          if (!ship?.visible || !ship.position || ship.renderTick === null) continue
          const truth = await truthAt(flyer, ship.renderTick)
          if (!truth) continue
          errors.push(
            Math.hypot(
              ship.position[0] - truth[0],
              ship.position[1] - truth[1],
              ship.position[2] - truth[2],
            ),
          )
          if (ship.noseAlongTrack !== null) noses.push(ship.noseAlongTrack)
        }
        await a.page.waitForTimeout(250)
      }
      // Orientation, by geometry (the orientation lesson): the hull points
      // where it is going. A mirrored or unflipped quaternion reads near −1 or 0.
      noses.sort((x, y) => x - y)
      console.log(
        `nose along track over ${noses.length} samples: min ${noses[0]?.toFixed(3)} · p50 ${noses[Math.floor(noses.length / 2)]?.toFixed(3)}`,
      )
      expect(noses.length).toBeGreaterThan(40)
      expect(noses[Math.floor(noses.length * 0.05)]).toBeGreaterThan(0.9)
      errors.sort((x, y) => x - y)
      const p95 = errors[Math.floor(errors.length * 0.95)] as number
      const max = errors.at(-1) as number
      console.log(
        `drawn vs truth over ${errors.length} samples: p50 ${errors[Math.floor(errors.length / 2)]?.toFixed(3)} m · p95 ${p95.toFixed(3)} m · max ${max.toFixed(3)} m`,
      )
      expect(errors.length).toBeGreaterThan(40)
      expect(p95).toBeLessThan(DRAWN_P95_M)
      expect(max).toBeLessThan(DRAWN_MAX_M)
      const final = [(await probe(a.page)) as Probe, (await probe(b.page)) as Probe]
      for (const p of final) {
        expect(p.ships).toHaveLength(1)
        expect(p.ships[0]?.loaded).toBe(true)
      }
    } finally {
      await a.browser.close()
      await b.browser.close()
    }
  })
})
