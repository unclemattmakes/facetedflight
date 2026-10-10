/**
 * DEV-483: TV's exhibition in the browser — the five AI racers race a course
 * the clock picked, for nobody, and nothing is written down.
 *
 * plan/FF-TV.md §4.0. The door is DEV-480's, so this enters through the dev
 * handle `boot/app.ts` hangs off `__ff2` until it lands (`__ff2.exhibition`),
 * from the TITLE — the place DEV-480's TV row will start it from — after the
 * card's Start, the gesture a player gives. Nothing about the game is
 * different under test: the handle calls the same `startExhibition` the door
 * will.
 *
 *   1. Five racers fly and finish on the course, the local craft hidden on its
 *      pad, and then the NEXT course loads and races — another course. No lap
 *      is posted, and no record is written: `localStorage` is the same after a
 *      whole race as before it. A flat photograph is taken mid-race.
 *   2. A board lap's link flies that lap as one ghost beside the five, on the
 *      lap's own course (§2.6, `/tv/lap/<id>`; the lap server is `page.route`,
 *      `ghost-share.spec.ts`'s pattern, and the lap is built by the game's own
 *      recorder along the course's line).
 *   3. On a site with no rooms bound (`fixtures/rooms-off-sidecar.ts`: the real
 *      Functions with no `ROOMS`), the exhibition races just the same and asks
 *      the room server nothing. Needs `FF2_API_PROXY`; skips without it.
 *
 * Run (the GPU lease first, AGENT-NOTES §1):
 *
 *   E2E_PORT=5483 npx playwright test tv-exhibition
 *   FF2_API_PROXY=http://127.0.0.1:6483 E2E_PORT=5483 npx playwright test tv-exhibition
 *
 * The cut-in to a live race at the finish is `Exhibition.cutIn`, unit-tested
 * (`tests/unit/tv-exhibition.test.ts`); the note and the live list are DEV-480's.
 */

import fs from 'node:fs'
import path from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { FIXED_DT } from '@/sim/constants'
import { createLapRecorder, lapToBytes, recordedLap, recordPose } from '@/sim/ghost-record'
import { bootReady } from './fixtures/boot'
import type { Ff2Global } from './fixtures/ff2'
import { firstPress } from './fixtures/landing'
import { PINNED } from './fixtures/quality-pin'
import { type RoomsOffSidecar, startRoomsOffSidecar } from './fixtures/rooms-off-sidecar'
import { expect, type Page, test } from './fixtures/test'
import { titleRowsUp } from './fixtures/title'

const PROXY = process.env.FF2_API_PROXY ?? ''
/** Playwright wipes `test-results/` on every run, so the photograph goes somewhere else. */
const OUT = process.env.TV_EXHIBITION_DIR ?? path.join('test-results', 'tv-exhibition')
const PIN_TAG = PINNED.replace(/[=&]/g, '')
/** The shortest race in the pool (the last racer home in ~98 s headless): the quickest loop. */
const FIRST = 'rookie_01_hoverJet'

interface Craft {
  kind: 'racer' | 'ghost'
  name: string
  place: number
  status: string
  seconds: number | null
  at: [number, number, number]
}
interface Probe {
  phase: string
  course: string | null
  raceSeconds: number
  races: number
  held: string[]
  localCraftVisible: boolean | null
  craft: Craft[]
  results: {
    course: string
    raceSeconds: number
    lapId: string | null
    standings: { kind: string; name: string; status: string; seconds: number | null }[]
  }[]
}

type Handle = { exhibition: { start(o?: unknown): Probe; probe(): Probe; stop(): void } }

const probe = (page: Page): Promise<Probe> =>
  page.evaluate(() => (globalThis as unknown as { __ff2: Handle }).__ff2.exhibition.probe())

const startExhibition = (page: Page, options: Record<string, string> = {}): Promise<Probe> =>
  page.evaluate(
    (o) => (globalThis as unknown as { __ff2: Handle }).__ff2.exhibition.start(o),
    options,
  )

/** Every key and value in the page's `localStorage`. */
const storage = (page: Page): Promise<Record<string, string>> =>
  page.evaluate(() => {
    const out: Record<string, string> = {}
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i) as string
      out[k] = localStorage.getItem(k) as string
    }
    return out
  })

/** Boot the title the way a player does: the page, the card's Start, the rows. */
const openTitle = async (page: Page): Promise<void> => {
  await page.goto(`/?xr=off&${PINNED}`)
  await bootReady(page, 240_000)
  await firstPress(page)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await titleRowsUp(page)
}

/** Wait until the exhibition is racing on a course, and return the probe. */
const racing = async (page: Page, timeout = 240_000): Promise<Probe> => {
  await expect
    .poll(async () => (await probe(page)).phase, {
      message: 'the exhibition boards its course and reaches GO',
      timeout,
    })
    .toBe('racing')
  return probe(page)
}

test.describe('@gpu TV exhibition: AI racers when nothing is live (DEV-483)', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(720_000)

  test('five racers fly and finish, the next course loads, and nothing is recorded', async ({
    page,
  }) => {
    const posts: string[] = []
    page.on('request', (r) => {
      if (r.method() !== 'GET' && new URL(r.url()).pathname.startsWith('/api/')) {
        posts.push(`${r.method()} ${new URL(r.url()).pathname}`)
      }
    })
    await openTitle(page)
    const before = await storage(page)

    const started = await startExhibition(page, { course: FIRST })
    expect(started.held, 'the record hold is on from the start').toContain('tv exhibition')
    const go = await racing(page)
    expect(go.course).toBe(FIRST)
    const racers = go.craft.filter((c) => c.kind === 'racer')
    expect(racers, 'the preset grid: five racers').toHaveLength(5)
    expect(go.localCraftVisible, 'the local craft is hidden').toBe(false)

    // They FLY: every racer has moved off its pad.
    await expect
      .poll(async () => (await probe(page)).raceSeconds, { timeout: 60_000 })
      .toBeGreaterThan(20)
    const mid = await probe(page)
    for (const c of mid.craft) {
      const was = racers.find((r) => r.name === c.name) as Craft
      const moved = Math.hypot(c.at[0] - was.at[0], c.at[1] - was.at[1], c.at[2] - was.at[2])
      expect(moved, `${c.name} left the grid`).toBeGreaterThan(300)
    }
    expect(mid.craft.map((c) => c.place)).toEqual([1, 2, 3, 4, 5])
    // DRAWN where they fly. Every check above reads the sim, so a racer drawn
    // somewhere else (sunk, say, by a frame-time offset like DEV-553's grid
    // drop) would pass them all: compare each mesh to its body. Added while
    // looking into Matt's 2026-10-01 report, "these racers went underwater i
    // think"; DEV-553's drop is already 0 here (TV boards with the ride
    // skipped, which docks the lift), so this is a guard, not that fix.
    const sunk = await page.evaluate(() => {
      const r = (window as unknown as Ff2Global).__ff2.racers()
      if (!r) return null
      return r.ships.map(
        (s, i) => s.position.y - (r.racers[i]?.jet.body.position.y ?? s.position.y),
      )
    })
    expect(sunk, 'the racers are loaded').not.toBeNull()
    for (const dy of sunk as number[]) {
      expect(Math.abs(dy), 'a racer is drawn where its body flies').toBeLessThan(1.5)
    }
    // The flat photograph, mid-race: the stand-in chase on the leader.
    fs.mkdirSync(OUT, { recursive: true })
    await page.screenshot({ path: path.join(OUT, `exhibition-mid-race-${FIRST}-${PIN_TAG}.png`) })

    // They FINISH: every racer home, in time order.
    await expect
      .poll(async () => (await probe(page)).results.length, {
        message: 'the race reaches its finish',
        timeout: 240_000,
      })
      .toBeGreaterThanOrEqual(1)
    const done = await probe(page)
    const first = done.results[0] as Probe['results'][number]
    console.info(
      `exhibition on ${first.course}: ${first.raceSeconds.toFixed(1)} s — ` +
        first.standings.map((s) => `${s.name} ${s.seconds?.toFixed(1) ?? s.status}`).join(', '),
    )
    expect(first.course).toBe(FIRST)
    expect(first.standings).toHaveLength(5)
    for (const s of first.standings) expect(s.status, s.name).toBe('finished')
    const times = first.standings.map((s) => s.seconds as number)
    expect([...times].sort((a, b) => a - b)).toEqual(times)

    // Nothing written: not a best, a medal, a completion, a kept lap — and no post.
    expect(await storage(page), 'localStorage after a whole race').toEqual(before)
    expect(posts, 'no lap posted').toEqual([])
    expect(
      await page.evaluate(() => document.body.dataset.finished ?? null),
      'the local run never finished, because it never started',
    ).toBeNull()

    // The NEXT course loads and races, and it is another course.
    await expect
      .poll(
        async () => {
          const p = await probe(page)
          return p.phase === 'racing' && p.course !== FIRST ? p.course : null
        },
        { message: 'the next slot’s course boards and reaches GO', timeout: 300_000 },
      )
      .not.toBeNull()
    const next = await probe(page)
    expect(next.craft.filter((c) => c.kind === 'racer')).toHaveLength(5)
    expect(next.localCraftVisible).toBe(false)
    expect(next.held).toContain('tv exhibition')
    console.info(`exhibition: next course ${next.course}`)

    // Stopped, the hold is gone.
    await page.evaluate(() => (globalThis as unknown as { __ff2: Handle }).__ff2.exhibition.stop())
    await expect.poll(async () => (await probe(page)).held, { timeout: 5_000 }).toEqual([])
  })

  test('a board lap flies as one ghost beside the five, on its own course', async ({ page }) => {
    const LAP = 'TvLaPiD123'
    const lap = postedLap(FIRST)
    const seen: string[] = []
    await page.route(
      (url) => url.pathname.startsWith('/api/'),
      async (route) => {
        const url = new URL(route.request().url())
        seen.push(`${route.request().method()} ${url.pathname}${url.search}`)
        if (url.pathname === '/api/laps' && url.searchParams.get('id') === LAP) {
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              id: LAP,
              mission: FIRST,
              mode: 'ringAttack',
              edition: 'anniversary',
              variant: 'standard',
              rules: lap.doc.rules,
              vehicle: 'hoverjet',
              handle: 'BOARD ACE',
              seconds: lap.seconds,
              rings: 0,
              ringsTotal: 0,
              board: true,
              lap: lap.wire,
            }),
          })
        }
        return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' })
      },
    )
    await openTitle(page)
    // No course named: the lap's own is the one it must board.
    await startExhibition(page, { lapId: LAP })
    const go = await racing(page)
    expect(go.course, "the lap's own course").toBe(FIRST)
    await expect
      .poll(async () => (await probe(page)).raceSeconds, { timeout: 60_000 })
      .toBeGreaterThan(8)
    const a = await probe(page)
    const ghost = a.craft.filter((c) => c.kind === 'ghost')
    // TV_LAP_NAME (src/game/tv/exhibition.ts), spelled here because importing
    // that module would pull the game's graph into the spec. No names on TV,
    // ever (Matt, 2026-09-30): the board's handle is nowhere on the page.
    expect(ghost.map((g) => g.name)).toEqual(['Shared lap'])
    expect(JSON.stringify(a)).not.toContain('BOARD ACE')
    expect(a.craft.filter((c) => c.kind === 'racer')).toHaveLength(5)
    await expect
      .poll(async () => (await probe(page)).raceSeconds, { timeout: 30_000 })
      .toBeGreaterThan(14)
    const b = await probe(page)
    const g0 = ghost[0] as Craft
    const g1 = b.craft.find((c) => c.kind === 'ghost') as Craft
    expect(Math.hypot(g1.at[0] - g0.at[0], g1.at[2] - g0.at[2]), 'the ghost flies').toBeGreaterThan(
      300,
    )
    expect(seen.filter((s) => s.startsWith('GET /api/laps?id='))).toEqual([
      `GET /api/laps?id=${LAP}`,
    ])
    expect(
      seen.filter((s) => !s.startsWith('GET ')),
      'nothing posted',
    ).toEqual([])
    await page.evaluate(() => (globalThis as unknown as { __ff2: Handle }).__ff2.exhibition.stop())
  })

  test.describe('on a site with no rooms bound (DEV-470’s fixture)', () => {
    test.skip(
      !PROXY,
      'set FF2_API_PROXY=http://127.0.0.1:<port> so Vite forwards /api to the rooms-off sidecar',
    )
    let site: RoomsOffSidecar
    test.beforeAll(async () => {
      site = await startRoomsOffSidecar(Number(new URL(PROXY).port))
      const answer = await fetch(`${PROXY}/api/room-sidecar`).then((r) => r.text())
      expect(answer, 'a stale sidecar is answering on this port').toBe(site.nonce)
    })
    test.afterAll(async () => {
      await site?.close()
    })

    test('races the clock’s course and asks the room server nothing', async ({ page }) => {
      await openTitle(page)
      await startExhibition(page)
      const go = await racing(page)
      expect(go.craft.filter((c) => c.kind === 'racer')).toHaveLength(5)
      await expect
        .poll(async () => (await probe(page)).raceSeconds, { timeout: 60_000 })
        .toBeGreaterThan(10)
      const p = await probe(page)
      expect(p.phase).toBe('racing')
      expect(
        site.requests.filter((q) => q.path.startsWith('/api/room')),
        'no room asked',
      ).toEqual([])
      await page.evaluate(() =>
        (globalThis as unknown as { __ff2: Handle }).__ff2.exhibition.stop(),
      )
    })
  })
})

// ── a board lap, built by the game's own recorder (ghost-share.spec.ts's recipe) ──

interface CourseFile {
  courses: Record<
    string,
    {
      worldOffset: [number, number, number]
      release: [number, number, number]
      route: [number, number, number][] | null
      editions: Record<string, { variants: Record<string, { rules: string }> }>
    }
  >
}

/** From the course's release along its authored line at 150 m/s, as a poster's lap would fly. */
function postedLap(mission: string) {
  const courses = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'content', 'lap-courses.json'), 'utf8'),
  ) as CourseFile
  const c = courses.courses[mission]
  if (!c) throw new Error(`no lap course ${mission}`)
  const [rx, ry, rz] = c.release
  const line = [{ x: rx, y: ry, z: rz }, ...(c.route ?? []).map(([x, y, z]) => ({ x, y, z: -z }))]
  const step = 150 * FIXED_DT
  const rec = createLapRecorder(c.worldOffset, 16_384)
  let tick = 0
  let carry = 0
  for (let i = 0; i + 1 < line.length && tick < 14_000; i++) {
    const a = line[i] as { x: number; y: number; z: number }
    const b = line[i + 1] as { x: number; y: number; z: number }
    const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
    const len = Math.hypot(d.x, d.y, d.z)
    if (len === 0) continue
    const yaw = Math.atan2(d.x, d.z)
    const q = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }
    let at = carry
    for (; at < len; at += step) {
      const s = at / len
      recordPose(rec, tick++, { x: a.x + d.x * s, y: a.y + d.y * s, z: a.z + d.z * s }, q)
    }
    carry = at - len
  }
  const rules = c.editions.anniversary?.variants.standard?.rules
  if (!rules) throw new Error(`no anniversary standard board for ${mission}`)
  const doc = recordedLap(rec, {
    mission,
    mode: 'ringAttack',
    edition: 'anniversary',
    rules,
    vehicle: 'hoverjet:standard',
    build: 'e2e-fixture',
  })
  return {
    doc,
    wire: Buffer.from(deflateRawSync(lapToBytes(doc))).toString('base64url'),
    seconds: tick * FIXED_DT,
  }
}
