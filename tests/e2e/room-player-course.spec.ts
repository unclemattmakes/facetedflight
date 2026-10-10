/**
 * Two browsers race a PLAYER'S course in a room, judged (DEV-851/852,
 * docs/plan/ROOM-PLAYER-COURSES.md). Matt, 2026-10-08: *"i'd love if we could
 * race player-made courses. we should do that."*
 *
 * The owner (A) puts a course in the room by its link token through
 * `__ff2.room().course`, which builds the same settings the COURSE row does for
 * a course in YOUR COURSES. The other page (B) has never seen the course: it
 * builds it from the room's token, hashes its own rules to ready, and boards
 * it. Both fly it on the autopilot, both laps go to the room sidecar's REAL
 * judge, which rebuilds the course from the race's token, and both verdicts
 * must be `ok`.
 *
 *   FF2_API_PROXY=http://127.0.0.1:5399 E2E_PORT=5342 npx playwright test room-player-course
 *
 * Without `FF2_API_PROXY` the dev server has no `/api` and this skips, saying so.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { Level } from '../../src/content/level-schema'
import { playerCourseId } from '../../src/content/player-course'
import { courseToken } from '../../src/content/player-course-wire'
import { fittedCourse } from '../unit/helpers/fitted-course'
import { missionReady } from './fixtures/boot'
import type { Ff2Global, Ff2GlobalMaybe } from './fixtures/ff2'
import { firstPress } from './fixtures/landing'
import { type RoomSidecar, startRoomSidecar } from './fixtures/room-sidecar'
import { E2E_BASE as BASE, E2E_CHANNEL as CHANNEL } from './fixtures/server'
import { type Browser, chromium, expect, type Page, skipSplash, test } from './fixtures/test'

const PROXY = process.env.FF2_API_PROXY ?? ''
const PINNED = 'xr=off&adaptive=0&quality=low&mission=int_01_hoverJet&menu=0&autopilot=1'

interface Probe {
  slot: number | null
  owner: number | null
  settings: { mission: string; bots: boolean; course?: string } | null
  goAt: number | null
  results: Array<{ slot: number; verdict: string; ticks: number | null }>
  posted: { verdict: string | null; status: number; error: string | null } | null
}

const probe = (page: Page): Promise<Probe | null> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2GlobalMaybe
    const r = w.__ff2?.room()
    return r ? (JSON.parse(JSON.stringify(r)) as Probe) : null
  })

const open = async (
  x: number,
  roomId: string,
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
    if (/^room|lap:/.test(t)) {
      log.push(t)
      console.log(`[${x}] ${t}`)
    }
  })
  await page.goto(`${BASE}/?${PINNED}&room=${roomId}`)
  await firstPress(page)
  return { browser, page }
}

test.describe('@gpu a room races a player’s course (DEV-851/852)', () => {
  test.skip(
    !PROXY,
    'set FF2_API_PROXY=http://127.0.0.1:<port> so Vite forwards /api to the room sidecar',
  )
  test.setTimeout(480_000)

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

  test('a racer who never had the course builds it, readies, boards, and is judged ok', async () => {
    // The course: DEV-468's fixture along int_01's own line (no terrain needed).
    const donor = JSON.parse(
      fs.readFileSync(path.join('content', 'levels', 'int_01_hoverJet.json'), 'utf8'),
    ) as Level
    const course = fittedCourse(donor)
    const id = playerCourseId(course)
    const token = await courseToken(course)

    const roomId = `p${Date.now().toString(32)}abcdefghij`.slice(0, 16).replace(/[^a-z2-7]/g, 'a')
    const logA: string[] = []
    const logB: string[] = []
    const a = await open(0, roomId, logA)
    await expect.poll(async () => (await probe(a.page))?.owner, { timeout: 180_000 }).toBe(0)
    const b = await open(920, roomId, logB)
    try {
      for (const p of [a.page, b.page]) await missionReady(p, 240_000)
      await expect.poll(async () => (await probe(b.page))?.slot, { timeout: 60_000 }).toBe(1)
      await expect.poll(async () => (await probe(a.page))?.settings !== null).toBe(true)

      // ── the owner puts the player's course in the room ───────────────
      await a.page.evaluate((t) => {
        const w = globalThis as unknown as Ff2Global
        w.__ff2.room()?.course(t)
      }, token)
      for (const p of [a.page, b.page]) {
        await expect
          .poll(async () => (await probe(p))?.settings?.mission, { timeout: 60_000 })
          .toBe(id)
      }
      expect((await probe(b.page))?.settings?.course).toBe(token)
      await a.page.evaluate(() => {
        const w = globalThis as unknown as Ff2Global
        w.__ff2.room()?.bots(false)
      })
      for (const p of [a.page, b.page]) {
        await expect.poll(async () => (await probe(p))?.settings?.bots).toBe(false)
      }

      // ── both ready with THEIR OWN rules for it, then start ──────────
      for (const p of [a.page, b.page]) {
        await p.evaluate(() => {
          const w = globalThis as unknown as Ff2Global
          w.__ff2.room()?.ready()
        })
      }
      await expect
        .poll(
          async () => {
            await a.page.evaluate(() => {
              const w = globalThis as unknown as Ff2Global
              w.__ff2.room()?.start()
            })
            return (await probe(a.page))?.goAt ?? null
          },
          { timeout: 60_000, intervals: [1_000] },
        )
        .not.toBeNull()
      // Both boarded the player's course, built from the room's token.
      for (const log of [logA, logB]) {
        await expect.poll(() => log.some((l) => l.startsWith(`room: boarding ${id}`))).toBe(true)
      }

      // ── both finish on the autopilot; both laps judged by the real judge ──
      for (const p of [a.page, b.page]) {
        await expect
          .poll(async () => (await probe(p))?.results.length ?? 0, {
            timeout: 300_000,
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
    } finally {
      await a.browser.close()
      await b.browser.close()
    }
  })
})
