/**
 * The course's board on the results panel — on the route a player takes. DEV-431.
 *
 * Matt: *"i don't see leaderboards in the game at all - in the past, they were
 * shown at the mission results screen."* The panel now carries the course's
 * board on a plate above it (`render/results.ts`, `game/results-board.ts`).
 *
 * The lap server is a FIXTURE here and nothing else is, exactly as in
 * `ghost-share.spec.ts`: `page.route` answers `/api/**`, and the game's code
 * path is the one it runs against the real server. The board's body comes from
 * `fixtures/board-stub.ts`, which `tests/unit/results-board.test.ts` holds to
 * the real Function's answer field for field.
 *
 *   1. Anniversary, title → hangar → int_01, flown CLEAN by the harness pad
 *      (`fixtures/harness-pad.ts`). The device already shared under a handle
 *      that is eighth on the board. The panel's plate lists the top five and
 *      that line after them, marked. Share posts the lap; the board is asked
 *      again (past the cache) and the new lap is the player's line. Taken
 *      back, it leaves the board again. The pad takes no rings, so a REAL
 *      server would board this lap nowhere: the fixture boards it anyway, to
 *      put the posted lap's line on the plate.
 *   2. Classic, the same route, the autopilot flying: the board request is
 *      HELD (the plate says it is loading), then cut off as a lost network
 *      would (the plate says OFFLINE, not a blank). Another go, and an empty
 *      board says it has no laps.
 *
 * Photographs, flat, from the seat, pinned `adaptive=0&quality=high`, and the
 * plate's own texture at full resolution:
 *
 *   RESULTS_BOARD_DIR=<dir> E2E_PORT=<yours> pnpm exec playwright test tests/e2e/results-board.spec.ts
 *
 * Tagged `@gpu`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { boardAnswer, type StubBoardLap } from './fixtures/board-stub'
import { bootReady } from './fixtures/boot'
import { dropFocus } from './fixtures/canvas'
import { board, hold, INT_01_HOVERJET } from './fixtures/hangar'
import { flyTo, installHarnessPad, padIdle, type SimPoint } from './fixtures/harness-pad'
import { firstPress } from './fixtures/landing'
import { watchPageErrors } from './fixtures/page-errors'
import { PINNED } from './fixtures/quality-pin'
import { expect, type Page, type Route, test } from './fixtures/test'
import { pressTitleRow, TITLE_ROW } from './fixtures/title'

/** Playwright wipes `test-results/` on every run, so the photographs go somewhere else. */
const OUT = process.env.RESULTS_BOARD_DIR ?? path.join('test-results', 'results-board')
const PIN_TAG = PINNED.replace(/[=&]/g, '')
const MISSION = 'int_01_hoverJet'

// ── The course, out of DEV-372's GENERATED artefact on disk ──────────────

interface CourseFile {
  courses: Record<
    string,
    {
      finish: { x: number; y: number; z: number }
      gates: unknown[]
      editions: Record<string, { variants: Record<string, { rules: string }> }>
    }
  >
}
const COURSES = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'content', 'lap-courses.json'), 'utf8'),
) as CourseFile
const course = COURSES.courses[MISSION]
if (!course) throw new Error(`no lap course ${MISSION}`)
const rulesOf = (edition: string, variant: string): string => {
  const rules = course.editions[edition]?.variants[variant]?.rules
  if (!rules) throw new Error(`no board for ${MISSION} on ${edition} in the ${variant}`)
  return rules
}
const FINISH: SimPoint = { x: course.finish.x, y: course.finish.y, z: course.finish.z }

/** Nine laps, fastest first. The device's own handle is eighth. */
const MY_HANDLE = 'Lucky Pelican 64'
const NINE: StubBoardLap[] = [
  { id: 'AAAAAAAAA1', handle: 'Swift Kestrel 42', seconds: 54.213 },
  { id: 'AAAAAAAAA2', handle: 'Brave Petrel 55', seconds: 55.9 },
  { id: 'AAAAAAAAA3', handle: 'Emerald Albatross 42', seconds: 57.03 },
  { id: 'AAAAAAAAA4', handle: 'Keen Heron 17', seconds: 58.02 },
  { id: 'AAAAAAAAA5', handle: 'Calm Tern 33', seconds: 58.4 },
  { id: 'AAAAAAAAA6', handle: 'Bold Heron 77', seconds: 59.1 },
  { id: 'AAAAAAAAA7', handle: 'Keen Swallow 21', seconds: 60.5 },
  { id: 'AAAAAAAAA8', handle: MY_HANDLE, seconds: 61.23 },
  { id: 'AAAAAAAAA9', handle: 'Steady Wren 12', seconds: 63 },
]
const POSTED_ID = 'PoStEdLaP1'

// ── The server, as a fixture ──────────────────────────────────────────────

interface BoardServer {
  /** The laps the board holds now, fastest first. The routes below change it. */
  laps: StubBoardLap[]
  /** Hold board requests until `release` answers them (the loading state). */
  hold: boolean
  readonly held: Route[]
  /** Every board request: its path, and the cache headers it carried. */
  readonly asked: { path: string; cacheControl: string | null; pragma: string | null }[]
  readonly posts: string[]
  readonly deletes: string[]
}

const json = (route: Route, status: number, body: unknown, headers: Record<string, string> = {}) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers })

const serve = async (page: Page, laps: StubBoardLap[]): Promise<BoardServer> => {
  const server: BoardServer = { laps, hold: false, held: [], asked: [], posts: [], deletes: [] }
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      const b = /^\/api\/board\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(url.pathname)
      if (b) {
        const headers = await request.allHeaders()
        server.asked.push({
          path: url.pathname + url.search,
          cacheControl: headers['cache-control'] ?? null,
          pragma: headers.pragma ?? null,
        })
        if (server.hold) {
          server.held.push(route)
          return
        }
        const key = { mission: b[1], mode: b[2], edition: b[3], variant: b[4] } as {
          mission: string
          mode: string
          edition: string
          variant: string
        }
        // The real answer's own cache header (`getBoard`), so the page is
        // told exactly what the server tells it.
        return json(
          route,
          200,
          boardAnswer(key, rulesOf(key.edition, key.variant), server.laps, course.gates.length),
          { 'cache-control': 'public, max-age=30' },
        )
      }
      if (url.pathname === '/api/laps' && request.method() === 'POST') {
        server.posts.push(request.postData() ?? '')
        const sent = JSON.parse(request.postData() ?? '{}') as { seconds?: number; handle?: string }
        const seconds = sent.seconds ?? 0
        // The server's rules, done by hand: one place per device (the old line
        // of this handle goes), and the board kept in time order.
        server.laps = [
          ...server.laps.filter((l) => l.handle !== sent.handle),
          { id: POSTED_ID, handle: sent.handle ?? '', seconds },
        ].sort((a, b) => a.seconds - b.seconds)
        return json(route, 201, {
          id: POSTED_ID,
          variant: 'standard',
          seconds,
          ticks: 0,
          rings: 0,
          ringsTotal: course.gates.length,
          score2016: 0,
          board: true,
          rank: server.laps.findIndex((l) => l.id === POSTED_ID) + 1,
          boardReason: null,
          expiresAt: null,
        })
      }
      if (url.pathname === '/api/laps' && request.method() === 'DELETE') {
        server.deletes.push(url.pathname + url.search)
        server.laps = server.laps.filter((l) => l.id !== url.searchParams.get('id'))
        return route.fulfill({ status: 204 })
      }
      return json(route, 404, { error: 'route', reason: 'not a lap-server route' })
    },
  )
  return server
}

// ── What the page says ────────────────────────────────────────────────────

interface PlateRow {
  rank: number
  gap: boolean
  time: string
  name: string
  mine: boolean
}
interface BoardReport {
  key: { mission: string; mode: string; edition: string; variant: string } | null
  status: string | null
  refreshing: boolean
  fetches: number
  drawn: {
    heading: string
    sub: string
    rows: PlateRow[]
    say: { caption: string; line: string; detail: string; tone: string } | null
  } | null
}

const report = async (page: Page): Promise<BoardReport | null> =>
  page.evaluate(
    () =>
      (
        globalThis as unknown as { __ff2: { resultsBoard: () => BoardReport | null } }
      ).__ff2.resultsBoard() ?? null,
  )
const sharePhase = async (page: Page): Promise<string> =>
  page.evaluate(
    () =>
      (globalThis as unknown as { __ff2: { share: () => { phase: string } } }).__ff2.share().phase,
  )

/**
 * DEV-571: the press on POST TO LEADERBOARD?, on the menu under the panel:
 * walked to with the arrow keys, pressed with Enter, as a player does. The
 * same row then asks to take the lap down, and the press after does.
 */
const pressPostRow = async (page: Page): Promise<void> => {
  const aim = () =>
    page.evaluate(
      () =>
        (
          globalThis as unknown as { __ff2: { share: () => { ask: { aim: string } | null } } }
        ).__ff2.share().ask?.aim ?? null,
    )
  for (let i = 0; i < 6 && (await aim()) !== 'lap-post'; i++) await hold(page, 'ArrowUp', 250)
  expect(await aim(), 'aimed at POST TO LEADERBOARD?').toBe('lap-post')
  await hold(page, 'Enter')
}

/** Wait for the plate to say `line` (or to list `rows` lines), and return what it drew. */
const plateSays = async (
  page: Page,
  want: (r: BoardReport | null) => boolean,
  message: string,
): Promise<BoardReport> => {
  await expect.poll(async () => want(await report(page)), { message, timeout: 30_000 }).toBe(true)
  return (await report(page)) as BoardReport
}

const photograph = async (page: Page, name: string): Promise<void> => {
  fs.mkdirSync(OUT, { recursive: true })
  const file = path.join(OUT, `${name}-seat-${PIN_TAG}.png`)
  fs.writeFileSync(file, await page.locator('#viewport').screenshot())
  console.info(`results-board: ${file}`)
}

/** The board plate, from its own texture: full resolution, no framing. */
const photographPlate = async (page: Page, name: string): Promise<void> => {
  const url = await page.evaluate(() => {
    type O = {
      name: string
      visible: boolean
      material?: { map?: { image?: { toDataURL?: () => string } } }
      traverse: (f: (o: O) => void) => void
    }
    const scene = (globalThis as unknown as { __ff2: { stage: () => O } }).__ff2.stage()
    let data: string | null = null
    scene.traverse((o) => {
      if (o.name === 'results-board' && o.visible && !data) {
        data = o.material?.map?.image?.toDataURL?.() ?? null
      }
    })
    return data as string | null
  })
  expect(url, 'the board plate is up, with a canvas').not.toBeNull()
  fs.mkdirSync(OUT, { recursive: true })
  const file = path.join(OUT, `${name}-plate-${PIN_TAG}.png`)
  fs.writeFileSync(file, Buffer.from((url as string).split(',')[1] as string, 'base64'))
  console.info(`results-board: ${file}`)
}

/** The title is up, its valley is in, and the card is gone. */
const toTheTitle = async (page: Page, query: string): Promise<void> => {
  await page.goto(`/?xr=off&${PINNED}${query}`)
  await firstPress(page)
  await bootReady(page, 240_000)
  await dropFocus(page)
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            (
              globalThis as unknown as { __ff2?: { titleMenu?: () => { up: boolean } | null } }
            ).__ff2?.titleMenu?.()?.up ?? false,
        ),
      { message: 'the title offers its rows', timeout: 60_000 },
    )
    .toBe(true)
}

const finished = async (page: Page, label: string): Promise<void> => {
  await page.waitForSelector('body[data-finished="true"]', { timeout: 240_000 })
  // The panel is drawn on the frame after; nothing below reads it sooner.
  await page.waitForTimeout(600)
  console.info(`results-board: ${label} finished`)
}

test.describe('@gpu the course board on the results panel (DEV-431)', () => {
  test.setTimeout(900_000)

  test('Anniversary: the top five and your line; your shared lap joins it, and leaves it', async ({
    page,
  }) => {
    const problems = watchPageErrors(page)
    await installHarnessPad(page)
    // This device shared once before, under a handle that is eighth.
    await page.addInitScript((handle) => {
      try {
        if (!sessionStorage.getItem('results-board-seeded')) {
          localStorage.setItem('ff2.handle.v1', handle)
          sessionStorage.setItem('results-board-seeded', '1')
        }
      } catch {}
    }, MY_HANDLE)
    const server = await serve(page, [...NINE])
    await toTheTitle(page, '&edition=anniversary')
    await pressTitleRow(page, TITLE_ROW.hangar) // DEV-441: Single Player, then Hangar
    await board(page, INT_01_HOVERJET, 1_000)
    expect(server.asked, 'no board is asked for before a run ends').toEqual([])

    await hold(page, 'Enter', 0)
    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              (
                globalThis as unknown as { __ff2: { laps: () => { run: { tick: number } } | null } }
              ).__ff2.laps()?.run.tick ?? -1,
          ),
        { message: 'the ship is let go', timeout: 90_000 },
      )
      .toBeGreaterThanOrEqual(0)
    await flyTo(page, FINISH)
    await finished(page, 'anniversary')
    await padIdle(page)

    // ── the board, as it stands ────────────────────────────────────────
    const ready = await plateSays(
      page,
      (r) => (r?.drawn?.rows.length ?? 0) > 0,
      'the plate lists the board',
    )
    console.info(`results-board ready: ${JSON.stringify(ready)}`)
    expect(ready.key).toEqual({
      mission: MISSION,
      mode: 'ringAttack',
      edition: 'anniversary',
      variant: 'standard',
    })
    expect(ready.status).toBe('ready')
    expect(ready.drawn?.heading).toBe('LEADERBOARD')
    expect(ready.drawn?.sub.startsWith('ANNIVERSARY')).toBe(true)
    expect(ready.drawn?.rows.map((r) => [r.rank, r.time, r.name, r.mine, r.gap])).toEqual([
      [1, '54.21s', 'SWIFT KESTREL 42', false, false],
      [2, '55.90s', 'BRAVE PETREL 55', false, false],
      [3, '57.03s', 'EMERALD ALBATROSS 42', false, false],
      [4, '58.02s', 'KEEN HERON 17', false, false],
      [5, '58.40s', 'CALM TERN 33', false, false],
      [8, '61.23s', 'LUCKY PELICAN 64', true, true],
    ])
    expect(ready.drawn?.say).toMatchObject({ caption: 'YOUR PLACE', line: '#8' })
    expect(server.asked).toHaveLength(1)
    expect(server.asked[0]?.path).toBe(`/api/board/${MISSION}/ringAttack/anniversary/standard`)
    await photograph(page, 'anniversary-ready')
    await photographPlate(page, 'anniversary-ready')

    // ── posted (DEV-571: its row, pressed): the board is asked again ────
    await pressPostRow(page)
    await expect.poll(async () => sharePhase(page), { message: 'posted' }).toBe('posted')
    expect(server.posts).toHaveLength(1)
    const posted = await plateSays(
      page,
      (r) => r?.drawn?.rows.some((row) => row.mine && row.rank === 1) === true,
      'the posted lap is the player’s line',
    )
    console.info(`results-board posted: ${JSON.stringify(posted)}`)
    console.info(`results-board asked: ${JSON.stringify(server.asked)}`)
    expect(server.asked, 'asked again once the lap was posted').toHaveLength(2)
    // The first line is the pad's lap: ~30 s, under the handle it went up as.
    const first = posted.drawn?.rows[0]
    expect(first).toMatchObject({ rank: 1, name: MY_HANDLE.toUpperCase(), mine: true })
    expect(posted.drawn?.rows).toHaveLength(5)
    expect(posted.drawn?.say).toMatchObject({ caption: 'YOUR PLACE', line: '#1' })
    await page.waitForTimeout(400)
    await photograph(page, 'anniversary-posted')
    await photographPlate(page, 'anniversary-posted')

    // ── taken back: it leaves the board, and so does your line ──────────
    await pressPostRow(page)
    await hold(page, 'Enter')
    await expect.poll(async () => sharePhase(page), { message: 'deleted' }).toBe('deleted')
    expect(server.deletes).toEqual([`/api/laps?id=${POSTED_ID}`])
    const gone = await plateSays(
      page,
      (r) => r?.drawn?.rows.every((row) => !row.mine) === true && r.refreshing === false,
      'the deleted lap is off the plate',
    )
    expect(server.asked).toHaveLength(3)
    expect(gone.drawn?.rows.map((r) => r.name)).toEqual([
      'SWIFT KESTREL 42',
      'BRAVE PETREL 55',
      'EMERALD ALBATROSS 42',
      'KEEN HERON 17',
      'CALM TERN 33',
    ])
    expect(gone.drawn?.say).toBeNull()
    expect(problems.list(), 'page errors').toEqual([])
  })

  test('Classic: the plate says loading, then OFFLINE, then an empty board — never a blank', async ({
    page,
  }) => {
    const problems = watchPageErrors(page)
    const server = await serve(page, [])
    await toTheTitle(page, '&edition=classic')
    await pressTitleRow(page, TITLE_ROW.hangar) // DEV-441: Single Player, then Hangar
    await board(page, INT_01_HOVERJET, 1_000)
    // Held: the plate is up before the board is.
    server.hold = true

    await hold(page, 'KeyP', 300)
    await finished(page, 'classic lap one')
    const loading = await plateSays(
      page,
      (r) => r?.drawn?.say?.line === 'LOADING THE LEADERBOARD',
      'the plate says it is loading',
    )
    console.info(`results-board loading: ${JSON.stringify(loading)}`)
    // DEV-452 (D35): a Classic LOOK flies Anniversary's rules, so its lap is
    // filed on Anniversary's board — one set of boards. This asked for the
    // Classic board, and said CLASSIC, until then.
    expect(loading.key).toEqual({
      mission: MISSION,
      mode: 'ringAttack',
      edition: 'anniversary',
      variant: 'standard',
    })
    expect(loading.drawn?.sub.startsWith('ANNIVERSARY')).toBe(true)
    await photograph(page, 'classic-loading')
    await photographPlate(page, 'classic-loading')

    // Cut off, as a lost network cuts it.
    expect(server.held).toHaveLength(1)
    await server.held[0]?.abort('internetdisconnected')
    server.held.length = 0
    server.hold = false
    const offline = await plateSays(
      page,
      (r) => r?.drawn?.say?.line === 'OFFLINE',
      'the plate says OFFLINE',
    )
    expect(offline.status).toBe('failed')
    expect(offline.drawn?.rows).toEqual([])
    expect(offline.drawn?.say?.detail).toBe('THE LEADERBOARD COULD NOT BE REACHED')
    await photograph(page, 'classic-offline')
    await photographPlate(page, 'classic-offline')

    // ── another go: an empty board says it is empty ─────────────────────
    await hold(page, 'Backspace', 600)
    expect((await report(page))?.drawn ?? null, 'a new run clears the plate').toBeNull()
    await finished(page, 'classic lap two')
    const empty = await plateSays(
      page,
      (r) => r?.drawn?.say?.line === 'NO LAPS POSTED YET',
      'the plate says the board is empty',
    )
    expect(empty.drawn?.rows).toEqual([])
    expect(server.asked).toHaveLength(2)
    await photograph(page, 'classic-empty')
    await photographPlate(page, 'classic-empty')
    // The cut-off request is the one failure this spec causes on purpose, and
    // it is exactly one: a network error on the board's path, no 4xx or 5xx.
    const cut = (p: string) => p.startsWith('requestfailed:') && p.includes('/api/board/')
    expect(problems.list().filter(cut)).toHaveLength(1)
    expect(
      problems.list().filter((p) => !cut(p)),
      'page errors',
    ).toEqual([])
  })
})
