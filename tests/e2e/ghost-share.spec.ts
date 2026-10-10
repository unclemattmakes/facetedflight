/**
 * Sharing a lap, and racing somebody else's — on the routes a player takes.
 * DEV-373, PLAYER-GHOSTS §5.
 *
 * The lap server is a FIXTURE here and nothing else is: `page.route` answers
 * `/api/**` the way DEV-372's handlers answer (the shapes in
 * `docs/lap-server.md`), and the game's code path is the one it runs against
 * the real server. Nothing is ever posted to a real one.
 *
 *   1. `?ghost=<id>` — a Classic player opens an Anniversary speed-jet link. The
 *      title asks RACE THIS LAP or WATCH THIS LAP (DEV-571), aimed at RACE; one
 *      press boards THAT course (not a random one) in THAT aircraft and preset,
 *      with no ride, and the run races that lap, intangible, beside the racers:
 *      a hollow dot on the race map. WATCH is TV's lap show (DEV-480/483).
 *   2. Share — title → hangar → int_01. On the course card the race button
 *      moves the ghost line on (your saved lap → leaderboard #1, fetched only
 *      then); the run races #1. The ship is flown CLEAN by a pad the harness
 *      holds (`fixtures/harness-pad.ts` says why that is a player's route and
 *      not a different build). DEV-571: the panel ASKS, on a menu under it
 *      walked with the arrow keys and pressed with Enter: POST TO LEADERBOARD?
 *      (NO, with the name it would post under), ANOTHER NAME, SAVE AS YOUR
 *      GHOST?, home. Nothing is posted until the post row is pressed; then the
 *      lap just flown goes, with its rules, vehicle and variant, and the panel
 *      prints the link. G posts nothing now.
 *   3. A TAINTED run (the autopilot touched it) is told why it cannot be
 *      posted, and no press posts it.
 *
 * Every assertion reads `__ff2.share()` / `__ff2.laps()` and the requests the
 * route saw. Photographs, flat, from the seat, pinned `adaptive=0&quality=high`:
 * the level card, and the panel as it offers, picks and shows the link.
 *
 *   GHOST_SHARE_DIR=<dir> E2E_PORT=<yours> pnpm exec playwright test tests/e2e/ghost-share.spec.ts
 *
 * Tagged `@gpu`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { FIXED_DT } from '@/sim/constants'
import {
  createLapRecorder,
  lapFromBytes,
  lapToBytes,
  recordedLap,
  recordPose,
} from '@/sim/ghost-record'
import { bootReady, switchSettled } from './fixtures/boot'
import { dropFocus } from './fixtures/canvas'
import { aimAtCourse, hangarAim, hold, lookUntilAimed, throughDoors } from './fixtures/hangar'
import {
  flyTo,
  installHarnessPad,
  padIdle,
  pilotFrames,
  type SimPoint,
} from './fixtures/harness-pad'
import { firstPress } from './fixtures/landing'
import { watchPageErrors } from './fixtures/page-errors'
import { PINNED } from './fixtures/quality-pin'
import { devices, expect, type Page, type Route, test } from './fixtures/test'
import { pressTitleRow, TITLE_ROW } from './fixtures/title'

/** Playwright wipes `test-results/` on every run, so the photographs go somewhere else. */
const OUT = process.env.GHOST_SHARE_DIR ?? path.join('test-results', 'ghost-share')
const PIN_TAG = PINNED.replace(/[=&]/g, '')

// ── The courses, out of DEV-372's GENERATED artefact on disk ─────────────

interface CourseFile {
  courses: Record<
    string,
    {
      worldOffset: [number, number, number]
      release: [number, number, number]
      route: [number, number, number][] | null
      finish: { x: number; y: number; z: number; radius: number }
      editions: Record<string, { variants: Record<string, { rules: string }> }>
    }
  >
}
const COURSES = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'content', 'lap-courses.json'), 'utf8'),
) as CourseFile

const courseOf = (mission: string) => {
  const c = COURSES.courses[mission]
  if (!c) throw new Error(`no lap course ${mission}`)
  return c
}
const boardRules = (mission: string, edition: string, variant: string): string => {
  const rules = courseOf(mission).editions[edition]?.variants[variant]?.rules
  if (!rules) throw new Error(`no board for ${mission} on ${edition} in the ${variant}`)
  return rules
}
const finishOf = (mission: string): SimPoint => {
  const f = courseOf(mission).finish
  return { x: f.x, y: f.y, z: f.z }
}

/**
 * A lap somebody posted: from the course's release point along its AUTHORED
 * ROUTE (`lap-courses.json`'s `route`, the racing line 2016 designed the
 * course round, THREE space) at 150 m/s, facing the way it flies. Built by the
 * game's own recorder (`sim/ghost-record.ts`), so it is an `ff2-ghost-2` lap in
 * every byte, and deflated RAW as the server stores it. The game rescores it
 * from its poses, as it rescores every lap; `seconds` here is only what the
 * fixture server says about it.
 */
const postedLap = (mission: string, edition: string, variant: string) => {
  const c = courseOf(mission)
  const [rx, ry, rz] = c.release
  // SIM space: the route is THREE space, z mirrored.
  const line: SimPoint[] = [
    { x: rx, y: ry, z: rz },
    ...(c.route ?? []).map(([x, y, z]) => ({ x, y, z: -z })),
  ]
  const step = 150 * FIXED_DT
  const rec = createLapRecorder(c.worldOffset, 16_384)
  let tick = 0
  let carry = 0
  for (let i = 0; i + 1 < line.length && tick < 14_000; i++) {
    const a = line[i] as SimPoint
    const b = line[i + 1] as SimPoint
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
  const doc = recordedLap(rec, {
    mission,
    mode: 'ringAttack',
    edition,
    rules: boardRules(mission, edition, variant),
    vehicle: `hoverjet:${variant}`,
    build: 'e2e-fixture',
  })
  return {
    doc,
    wire: Buffer.from(deflateRawSync(lapToBytes(doc))).toString('base64url'),
    seconds: tick * FIXED_DT,
  }
}

// ── The server, as a fixture ──────────────────────────────────────────────

interface Server {
  /** Every request the page made to `/api/`, method and path. */
  readonly seen: { method: string; path: string }[]
  /** Every POST body, as sent. */
  readonly posts: string[]
  /** DEV-374: every DELETE, its path and the owner key in its header. */
  readonly deletes: { path: string; owner: string | null }[]
}

const POSTED_ID = 'ShArEdLaP1'

const serve = async (
  page: Page,
  laps: Record<string, { mission: string; edition: string; variant: string; handle: string }>,
  board: { id: string; handle: string; seconds: number }[],
): Promise<Server> => {
  const server: Server = { seen: [], posts: [], deletes: [] }
  const json = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      server.seen.push({ method: request.method(), path: url.pathname + url.search })
      if (url.pathname === '/api/laps' && request.method() === 'POST') {
        server.posts.push(request.postData() ?? '')
        const sent = JSON.parse(request.postData() ?? '{}') as { seconds?: number }
        return json(route, 201, {
          id: POSTED_ID,
          variant: 'standard',
          seconds: sent.seconds ?? 0,
          ticks: 0,
          rings: 0,
          ringsTotal: 21,
          score2016: 0,
          board: false,
          rank: null,
          boardReason: 'a ring was missed',
          expiresAt: Date.UTC(2026, 10, 1),
        })
      }
      // DEV-374: the delete the panel sends. The real server's owner check is
      // unit-tested against its own handler (`lap-client.test.ts`); here the
      // question is what the GAME sends, and when.
      if (url.pathname === '/api/laps' && request.method() === 'DELETE') {
        server.deletes.push({
          path: url.pathname + url.search,
          owner: (await request.allHeaders())['x-ff-owner'] ?? null,
        })
        return route.fulfill({ status: 204 })
      }
      if (url.pathname === '/api/laps') {
        const id = url.searchParams.get('id') ?? ''
        const want = laps[id]
        if (!want)
          return json(route, 404, { error: 'gone', reason: 'no such lap, or it has expired' })
        const lap = postedLap(want.mission, want.edition, want.variant)
        return json(route, 200, {
          id,
          mission: want.mission,
          mode: 'ringAttack',
          edition: want.edition,
          variant: want.variant,
          rules: lap.doc.rules,
          vehicle: 'hoverjet',
          handle: want.handle,
          ticks: lap.doc.tick.at(-1),
          seconds: lap.seconds,
          rings: 0,
          ringsTotal: 21,
          score2016: 0,
          board: true,
          createdAt: Date.UTC(2026, 8, 25),
          expiresAt: null,
          lap: lap.wire,
        })
      }
      const b = /^\/api\/board\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(url.pathname)
      if (b) {
        return json(route, 200, {
          mission: b[1],
          mode: b[2],
          edition: b[3],
          variant: b[4],
          rules: boardRules(b[1] as string, b[3] as string, b[4] as string),
          entries: board.map((e, i) => ({
            rank: i + 1,
            id: e.id,
            handle: e.handle,
            seconds: e.seconds,
            ticks: Math.round(e.seconds / FIXED_DT),
            rings: 21,
            score2016: 0,
            createdAt: Date.UTC(2026, 8, 25),
          })),
        })
      }
      return json(route, 404, { error: 'route', reason: 'not a lap-server route' })
    },
  )
  return server
}

// ── What the page says ────────────────────────────────────────────────────

interface ShareReport {
  offered: boolean
  phase: string
  handle: string | null
  id: string | null
  link: string | null
  board: boolean
  rank: number | null
  reason: string | null
  posts: number
  prompts: { again: string; race: string; back: string } | null
  linkGhost: {
    id: string
    state: string
    mission: string | null
    variant: string | null
    edition: string | null
    handle: string | null
    keys: number | null
  } | null
  cards: { id: string; line: string | null }[]
  aboard: { mission: string; variant: string } | null
  ask: {
    up: boolean
    rows: { id: string; label: string; value: string | null }[]
    aim: string
    centres: { id: string; x: number; y: number }[] | null
  } | null
}
interface LapsReport {
  run: { tick: number; clock: number; taint: string[] }
  last: {
    seconds: number | null
    gates: number
    keys: number
    finishTick: number
    rules: string
    vehicle: string
    tainted: boolean
    reasons: string[]
    kept: boolean | null
  } | null
  ghost: {
    source: string
    handle: string | null
    seconds: number | null
    keys: number
    visible: boolean
  } | null
}

const share = async (page: Page): Promise<ShareReport> =>
  page.evaluate(() =>
    (globalThis as unknown as { __ff2: { share: () => ShareReport } }).__ff2.share(),
  )
const laps = async (page: Page): Promise<LapsReport | null> =>
  page.evaluate(
    () =>
      (globalThis as unknown as { __ff2: { laps: () => LapsReport | null } }).__ff2.laps() ?? null,
  )
const mapGhost = async (page: Page): Promise<{ x: number; y: number } | null> =>
  page.evaluate(
    () =>
      (
        globalThis as unknown as {
          __ff2: { raceMap: () => { ghost: { x: number; y: number } | null } | null }
        }
      ).__ff2.raceMap()?.ghost ?? null,
  )
const course = async (page: Page): Promise<{ id: string; mode: string }> =>
  page.evaluate(() =>
    (
      globalThis as unknown as { __ff2: { course: () => { id: string; mode: string } } }
    ).__ff2.course(),
  )
const edition = async (page: Page): Promise<string> =>
  page.evaluate(
    () =>
      (globalThis as unknown as { __ff2: { edition: { current: { id: string } } } }).__ff2.edition
        .current.id,
  )

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

/** Released: tick 0 of the lap is down. */
const released = async (page: Page, label: string): Promise<void> => {
  await expect
    .poll(async () => (await laps(page))?.run.tick ?? -1, {
      message: `${label}: the ship is let go`,
      timeout: 90_000,
    })
    .toBeGreaterThanOrEqual(0)
}

const photograph = async (page: Page, name: string): Promise<void> => {
  fs.mkdirSync(OUT, { recursive: true })
  const file = path.join(OUT, `${name}-${PIN_TAG}.png`)
  fs.writeFileSync(file, await page.locator('#viewport').screenshot())
  console.info(`ghost-share: ${file}`)
}

/** The results panel, from its own texture: full resolution, no framing. */
const photographPanel = async (page: Page, name: string): Promise<void> => {
  // DEV-650: the panel animates in (3.15 s at the longest, `render/results-anim.ts`),
  // so a photograph of its texture waits for the end state or it shows a headline
  // that has not stamped yet and numbers that are still counting.
  await page.waitForTimeout(3_400)
  const url = await page.evaluate(() => {
    type O = {
      name: string
      material?: { map?: { image?: { toDataURL?: () => string } } }
      traverse: (f: (o: O) => void) => void
    }
    const scene = (globalThis as unknown as { __ff2: { stage: () => O } }).__ff2.stage()
    let data: string | null = null
    scene.traverse((o) => {
      if (o.name === 'results' && !data) data = o.material?.map?.image?.toDataURL?.() ?? null
    })
    return data as string | null
  })
  expect(url, 'the results panel has a canvas').not.toBeNull()
  fs.mkdirSync(OUT, { recursive: true })
  const file = path.join(OUT, `${name}-texture-${PIN_TAG}.png`)
  fs.writeFileSync(file, Buffer.from((url as string).split(',')[1] as string, 'base64'))
  console.info(`ghost-share: ${file}`)
}

/** DEV-571: the menu under the panel, from its own texture. */
const photographAsk = async (page: Page, name: string): Promise<void> => {
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
      if (o.name === 'lap-ask' && o.visible && !data) {
        data = o.material?.map?.image?.toDataURL?.() ?? null
      }
    })
    return data as string | null
  })
  expect(url, 'the menu under the panel has a canvas').not.toBeNull()
  fs.mkdirSync(OUT, { recursive: true })
  const file = path.join(OUT, `${name}-texture-${PIN_TAG}.png`)
  fs.writeFileSync(file, Buffer.from((url as string).split(',')[1] as string, 'base64'))
  console.info(`ghost-share: ${file}`)
}

/**
 * DEV-571: walk the menu under the panel to row `id` with the arrow keys and
 * press it with Enter, reading where the aim IS between pushes: a player's keys.
 */
const pressAsk = async (page: Page, id: string): Promise<void> => {
  for (let i = 0; i < 8; i++) {
    const a = (await share(page)).ask
    expect(a?.up, 'the menu is up').toBe(true)
    if (!a || a.aim === id) break
    const want = a.rows.findIndex((r) => r.id === id)
    const now = a.rows.findIndex((r) => r.id === a.aim)
    expect(want, `${id} is a row`).toBeGreaterThanOrEqual(0)
    await hold(page, want < now ? 'ArrowUp' : 'ArrowDown', 250)
  }
  expect((await share(page)).ask?.aim, `aimed at ${id}`).toBe(id)
  await hold(page, 'Enter')
}
const askRow = async (page: Page, id: string) =>
  (await share(page)).ask?.rows.find((r) => r.id === id) ?? null

/** A course table's label, from its own canvas: full resolution, no framing. */
const photographCard = async (page: Page, mission: string, name: string): Promise<void> => {
  const url = await page.evaluate((id) => {
    type O = {
      name: string
      userData: { missionId?: string | null }
      children: O[]
      material?: { map?: { image?: { width?: number; toDataURL?: () => string } } }
      traverse: (f: (o: O) => void) => void
    }
    const scene = (globalThis as unknown as { __ff2: { stage: () => O } }).__ff2.stage()
    let data: string | null = null
    scene.traverse((o) => {
      if (data || o.name !== 'hangar-holotable' || o.userData.missionId !== id) return
      for (const c of o.children) {
        const image = c.material?.map?.image
        if (image?.width === 1024 && image.toDataURL) data = image.toDataURL()
      }
    })
    return data as string | null
  }, mission)
  expect(url, `${mission}'s card has a canvas`).not.toBeNull()
  fs.mkdirSync(OUT, { recursive: true })
  const file = path.join(OUT, `${name}-texture-${PIN_TAG}.png`)
  fs.writeFileSync(file, Buffer.from((url as string).split(',')[1] as string, 'base64'))
  console.info(`ghost-share: ${file}`)
}

/** Down the hangar to a course's card, aimed at it and NOT pressed. */
const toTheCard = async (page: Page, mission: string): Promise<void> => {
  await pressTitleRow(page, TITLE_ROW.hangar) // DEV-558: START, the hangar's doors
  await throughDoors(page) // and SINGLE PLAYER, to the aircraft
  const steps = [
    ['vehicles', 'hoverjet'],
    ['variants', 'standard'],
    ['modes', 'ringAttack'],
    ['ranks', 'intermediate'],
  ] as const
  // The room's own steps, asked before each (DEV-382's variant step; DEV-420:
  // Ring Attack walks no rank step, its place carries the difficulty).
  for (const [view, want] of steps) {
    if (!((await hangarAim(page))?.views ?? []).includes(view)) continue
    expect((await hangarAim(page))?.view, `on the ${view} step`).toBe(view)
    expect(await lookUntilAimed(page, want), `found ${want}`).toBe(true)
    await hold(page, 'Enter')
  }
  expect((await hangarAim(page))?.view).toBe('courses')
  expect(await aimAtCourse(page, mission), `found ${mission}`).toBe(true)
}

/** Fly the pad at the finish until the run ends, clean. */
const flyToTheFinish = async (page: Page, mission: string): Promise<void> => {
  await flyTo(page, finishOf(mission))
  await page.waitForSelector('body[data-finished="true"]', { timeout: 180_000 })
  await padIdle(page)
  console.info(`ghost-share: the pad flew ${await pilotFrames(page)} frames to the finish`)
  // The panel is drawn on the frame after; nothing below reads it sooner.
  await page.waitForTimeout(600)
}

test.describe('@gpu sharing and picking ghosts (DEV-373)', () => {
  test.setTimeout(600_000)

  // DEV-452 (D35): on both LOOKS, because the look is all a player's choice
  // moves now: the rules are the page's either way, and the race map is the
  // look's (`hud.raceMap`), so only the Anniversary look draws the ghost's dot.
  for (const look of ['anniversary', 'classic'] as const) {
    test(`?ghost=<id> boards its course, aircraft and preset through Quick Race, with that ghost · ${look}`, async ({
      page,
    }) => {
      const problems = watchPageErrors(page)
      // A player who chose this look: the link's lap is Anniversary, in the speed jet.
      await page.addInitScript((e: string) => {
        try {
          if (!sessionStorage.getItem('ghost-share-seeded')) {
            localStorage.setItem('ff2.comfort.v1', JSON.stringify({ edition: e }))
            sessionStorage.setItem('ghost-share-seeded', '1')
          }
        } catch {}
      }, look)
      const LINK = 'GhOsTlInK1'
      const MISSION = 'rookie_02_hoverJet'
      const server = await serve(
        page,
        {
          [LINK]: {
            mission: MISSION,
            edition: 'anniversary',
            variant: 'speed',
            handle: 'Bold Heron 77',
          },
        },
        [],
      )
      const lap = postedLap(MISSION, 'anniversary', 'speed')
      await toTheTitle(page, `&ghost=${LINK}`)
      // The TITLE wears Anniversary whatever the player chose (DEV-405, and every
      // menu since DEV-451). A mission wears the player's chosen look over the
      // page's rules (DEV-452). This line said 'classic' from before DEV-405 and
      // was red on `main` before a key was pressed.
      expect(await edition(page), 'the title wears Anniversary (DEV-451)').toBe('anniversary')

      // The title aims at the link's row: one press is the whole route (DEV-441:
      // the title opens on the Single Player page for it, past the doors).
      await expect
        .poll(
          async () =>
            page.evaluate(() => {
              const m = (
                globalThis as unknown as {
                  __ff2: { titleMenu: () => { selected: number; rows: string[] } }
                }
              ).__ff2.titleMenu()
              return m.rows[m.selected]
            }),
          { message: 'the title is aimed at the link' },
        )
        .toBe('quick-race')
      // DEV-571: and WATCH under it, where the build has TV (a preview build does).
      expect(
        await page.evaluate(
          () =>
            (
              globalThis as unknown as { __ff2: { titleMenu: () => { rows: string[] } } }
            ).__ff2.titleMenu().rows,
        ),
        'race or watch, then the way in',
      ).toEqual([
        'quick-race',
        'watch-lap',
        'hangar',
        'options',
        'enter-vr',
        'making-of',
        'newsletter',
      ])
      if (look === 'anniversary') await photograph(page, 'title-watch-or-race-seat')

      await expect
        .poll(async () => (await share(page)).linkGhost?.state, { message: 'the link fetched' })
        .toBe('ready')
      const at = await share(page)
      console.info(`ghost-share link: ${JSON.stringify(at.linkGhost)}`)
      expect(at.linkGhost).toMatchObject({
        id: LINK,
        mission: MISSION,
        variant: 'speed',
        edition: 'anniversary',
        handle: 'Bold Heron 77',
        keys: lap.doc.keyCount,
      })

      await hold(page, 'Enter', 0)
      await page.waitForSelector(`body[data-quick-race="${MISSION}"]`, { timeout: 60_000 })
      await switchSettled(page, 180_000)
      expect((await course(page)).id, 'the link’s course, not a random one').toBe(MISSION)
      expect((await share(page)).aboard).toEqual({ mission: MISSION, variant: 'speed' })
      // DEV-452 (D35): the link's lap is Anniversary's and so are the page's
      // rules, whatever the player chose; the LOOK is the player's own. This
      // read 'anniversary' for a Classic player when a link pinned its whole
      // preset (DEV-373).
      expect(await edition(page), 'the player’s look').toBe(look)
      expect(
        await page.evaluate(
          () =>
            (globalThis as unknown as { __ff2: { edition: { rules: { id: string } } } }).__ff2
              .edition.rules.id,
        ),
        'the rules the lap was flown under',
      ).toBe('anniversary')
      const racing = await laps(page)
      console.info(`ghost-share link races: ${JSON.stringify(racing?.ghost)}`)
      expect(racing?.ghost?.source).toBe('shared')
      expect(racing?.ghost?.handle).toBe('Bold Heron 77')
      expect(racing?.ghost?.keys).toBe(lap.doc.keyCount)
      expect(racing?.run.taint, 'a link taints nothing: the ghost cannot move your lap').toEqual([])
      expect(server.seen.filter((s) => s.path.startsWith('/api/laps'))).toEqual([
        { method: 'GET', path: `/api/laps?id=${LINK}` },
      ])

      // Quick Race counts down by itself; once the ship is let go the ghost is
      // on the race map as a hollow dot — where the look draws a race map.
      await released(page, 'link')
      if (look === 'anniversary') {
        await expect
          .poll(async () => mapGhost(page), {
            message: 'the ghost on the race map',
            timeout: 20_000,
          })
          .not.toBeNull()
      } else {
        await page.waitForTimeout(3_000)
        expect(await mapGhost(page), 'a Classic look draws no race map (hud.raceMap)').toBeNull()
      }
      await photograph(page, `link-race-seat-${look}`)
      expect(problems.list(), 'page errors').toEqual([])
    })
  }

  // DEV-571, Matt: *"when clicking a shared lap - ask if i want to watch or race
  // the shared lap"*. WATCH is TV's lap show (`/tv/lap/<id>`, DEV-480/483): the
  // lap flown as a ghost among the AI racers, TV's camera, no ship of yours.
  test('?ghost=<id>: WATCH THIS LAP shows that lap on TV, on its own course', async ({ page }) => {
    const problems = watchPageErrors(page)
    const LINK = 'WaTcHlInK1'
    const MISSION = 'rookie_02_hoverJet'
    const server = await serve(
      page,
      {
        [LINK]: {
          mission: MISSION,
          edition: 'anniversary',
          variant: 'standard',
          handle: 'Bold Heron 77',
        },
      },
      [],
    )
    await toTheTitle(page, `&ghost=${LINK}`)
    await expect
      .poll(async () => (await share(page)).linkGhost?.state, { message: 'the link fetched' })
      .toBe('ready')
    await pressTitleRow(page, TITLE_ROW.watchLap, 0)
    type Tv = { mode: string; lapId: string | null } | null
    await expect
      .poll(
        async () =>
          page.evaluate(
            () => (globalThis as unknown as { __ff2: { tv: () => Tv } }).__ff2.tv()?.lapId ?? null,
          ),
        { message: 'TV shows the link’s lap', timeout: 60_000 },
      )
      .toBe(LINK)
    await switchSettled(page, 180_000)
    expect((await course(page)).id, 'the lap’s own course').toBe(MISSION)
    type Ex = { craft: { kind: string }[]; raceSeconds: number } | null
    const exhibition = () =>
      page.evaluate(() =>
        (
          globalThis as unknown as { __ff2: { exhibition: { probe: () => Ex } } }
        ).__ff2.exhibition.probe(),
      )
    await expect
      .poll(async () => (await exhibition())?.raceSeconds ?? 0, {
        message: 'the race is on',
        timeout: 90_000,
      })
      .toBeGreaterThan(4)
    expect(
      (await exhibition())?.craft.filter((c) => c.kind === 'ghost'),
      'the lap flies, as one ghost',
    ).toHaveLength(1)
    expect((await laps(page))?.last ?? null, 'watching flies no lap of yours').toBeNull()
    const lapCalls = server.seen.filter((s) => s.path.startsWith('/api/laps'))
    console.info(`ghost-share watch: ${JSON.stringify(lapCalls)}`)
    expect(lapCalls.length, 'the lap, fetched').toBeGreaterThan(0)
    expect(
      lapCalls.every((s) => s.method === 'GET' && s.path === `/api/laps?id=${LINK}`),
      'only that lap, and nothing posted',
    ).toBe(true)
    await photograph(page, 'link-watch-seat')
    expect(problems.list(), 'page errors').toEqual([])
  })

  test('Share posts the lap just flown, clean, with its rules, vehicle and variant', async ({
    page,
  }) => {
    const problems = watchPageErrors(page)
    await installHarnessPad(page)
    const WORLD = 'WoRlDlApP1'
    const MISSION = 'int_01_hoverJet'
    const server = await serve(
      page,
      {
        [WORLD]: {
          mission: MISSION,
          edition: 'anniversary',
          variant: 'standard',
          handle: 'Bold Heron 77',
        },
      },
      [{ id: WORLD, handle: 'Bold Heron 77', seconds: 58.2 }],
    )
    await toTheTitle(page, '&edition=anniversary')
    await toTheCard(page, MISSION)

    // ── the level card's ghost line ────────────────────────────────────
    const line = async () => (await share(page)).cards.find((c) => c.id === MISSION)?.line ?? null
    await expect
      .poll(line, { message: 'the card has a ghost line' })
      .toBe('GHOST: NONE SAVED YET [R/Y]')
    expect(server.seen, 'nothing online until a press asks (§8 call 8)').toEqual([])
    await photograph(page, 'level-card-best-seat')
    await photographCard(page, MISSION, 'level-card-best')
    await hold(page, 'KeyR')
    await expect
      .poll(line, { message: 'world #1, fetched on the press' })
      .toBe('GHOST: #1 BOLD HERON 77 58.2s [R/Y]')
    await photograph(page, 'level-card-world-seat')
    await photographCard(page, MISSION, 'level-card-world')
    expect(server.seen.map((s) => s.path)).toEqual([
      `/api/board/${MISSION}/ringAttack/anniversary/standard`,
      `/api/laps?id=${WORLD}`,
    ])
    // Round the cycle and back to world #1, which is the ghost this run races.
    for (const want of [
      'GHOST: NEXT ONE UP · SAVE A LAP FIRST',
      'GHOST: OFF',
      'GHOST: NONE SAVED YET',
    ]) {
      await hold(page, 'KeyR')
      await expect.poll(line).toBe(`${want} [R/Y]`)
    }
    await hold(page, 'KeyR')
    await expect.poll(line).toBe('GHOST: #1 BOLD HERON 77 58.2s [R/Y]')
    await hold(page, 'Enter')
    await switchSettled(page, 180_000)
    const aboard = await laps(page)
    expect(aboard?.ghost?.source, 'the card’s pick is the ghost').toBe('shared')
    expect(aboard?.ghost?.handle).toBe('Bold Heron 77')
    expect(aboard?.run.taint, 'the harness pins taint nothing').toEqual([])

    // ── a clean lap, flown with the pad ────────────────────────────────
    await hold(page, 'Enter', 0)
    await released(page, 'share')
    await flyToTheFinish(page, MISSION)
    const flown = await laps(page)
    console.info(`ghost-share lap: ${JSON.stringify(flown?.last)}`)
    expect(flown?.last?.tainted, 'a pad is a player: the lap is clean').toBe(false)
    expect(flown?.last?.reasons).toEqual([])
    // DEV-601's other branch: a run the PLAYER flew keeps its best, written and
    // shown (the autopilot's keeps none). The pad takes no rings, so its medal
    // is the course's to award or not; the best is this run's either way.
    const scored = await page.locator('body').getAttribute('data-final-score')
    expect(scored, 'a final score').toMatch(/^\d+$/)
    await expect(page.locator('body'), 'the best is this run').toHaveAttribute(
      'data-best',
      scored as string,
    )
    expect(flown?.last?.rules).toBe(boardRules(MISSION, 'anniversary', 'standard'))
    expect(flown?.last?.vehicle).toBe('hoverjet:standard')

    // ── DEV-571: the panel ASKS, on the menu under it ──────────────────
    const offered = await share(page)
    expect(offered.offered).toBe(true)
    expect(offered.phase).toBe('idle')
    expect(offered.handle, 'the name it would post under, before any press').toMatch(
      /^[A-Z][a-z]+ [A-Z][a-z]+ [1-9][0-9]$/,
    )
    expect(offered.ask?.up).toBe(true)
    expect(offered.ask?.rows.map((r) => r.id)).toEqual([
      'lap-post',
      'lap-name',
      'lap-keep',
      'lap-home',
    ])
    // DEV-629: the served board holds one lap, so this one ranks (top 1000),
    // and once the panel's board lands the plate is aimed at POST: A is yes.
    // A lap that would not rank still opens on home (DEV-406, the unit test).
    await expect
      .poll(async () => (await share(page)).ask?.aim, {
        message: 'a lap that would rank opens on POST (DEV-629)',
      })
      .toBe('lap-post')
    expect(await askRow(page, 'lap-post')).toMatchObject({
      label: 'Post to leaderboard?',
      value: 'No',
    })
    expect(await askRow(page, 'lap-keep'), 'a first lap starts saved').toMatchObject({
      label: 'Saved as your ghost',
      value: 'Yes',
    })
    // DEV-599: in ONE device's words, the pad's: the harness pad flew the lap,
    // so it is the last device a hand used.
    expect(offered.prompts).toEqual({
      again: 'START to fly again',
      race: 'Y to race this lap',
      back: 'A on a row below',
    })
    expect(server.posts, 'nothing is posted by finishing').toEqual([])
    await page.waitForTimeout(400)
    await photograph(page, 'panel-asking-seat')
    await photographPanel(page, 'panel-asking')
    await photographAsk(page, 'ask-asking')

    // G, a pad's SELECT and the left stick click posted a lap before DEV-571.
    // They post nothing now: the question is the only door.
    await hold(page, 'KeyG')
    await hold(page, 'KeyG')
    expect(server.posts, 'G posts nothing').toEqual([])
    expect((await share(page)).phase).toBe('idle')

    // ── ANOTHER NAME: a new one, and nothing sent ──────────────────────
    await pressAsk(page, 'lap-name')
    const renamed = await share(page)
    expect(renamed.phase).toBe('idle')
    expect(renamed.handle).not.toBe(offered.handle)
    expect(server.posts, 'a name is not a post').toEqual([])

    // ── SAVE AS YOUR GHOST?: NO takes it out of the store, YES puts it back ─
    const keyOf = () =>
      page.evaluate(() =>
        Object.keys(localStorage).filter((k) => k.startsWith('ff2.ghost.int_01_hoverJet.')),
      )
    expect(await keyOf(), 'saved on the finish').toHaveLength(1)
    await pressAsk(page, 'lap-keep')
    expect((await askRow(page, 'lap-keep'))?.value).toBe('No')
    expect((await laps(page))?.last?.kept).toBe(false)
    expect(await keyOf(), 'NO: no ghost saved for this course').toEqual([])
    await hold(page, 'Enter')
    expect((await askRow(page, 'lap-keep'))?.value).toBe('Yes')
    expect(await keyOf(), 'YES: saved again').toHaveLength(1)

    // ── the press on POST TO LEADERBOARD? posts the lap just flown ──────
    await pressAsk(page, 'lap-post')
    await expect.poll(async () => (await share(page)).phase).toBe('posted')
    expect(server.posts).toHaveLength(1)
    const body = JSON.parse(server.posts[0] as string) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['handle', 'lap', 'owner', 'seconds'])
    expect(body.handle, 'under the name on screen').toBe(renamed.handle)
    expect(body.seconds).toBe(flown?.last?.seconds)
    const owner = await page.evaluate(() => localStorage.getItem('ff2.owner.v1'))
    expect(body.owner).toMatch(/^[A-Za-z0-9_-]{22,128}$/)
    expect(body.owner, 'the owner key is this device’s, kept').toBe(owner)
    const doc = lapFromBytes(
      new Uint8Array(inflateRawSync(Buffer.from(body.lap as string, 'base64url'))),
    )
    console.info(
      `ghost-share posted: ${doc.keyCount} keys, rules ${doc.rules}, ${doc.vehicle}, ` +
        `${(body.lap as string).length} characters`,
    )
    expect(doc).toMatchObject({
      mission: MISSION,
      mode: 'ringAttack',
      edition: 'anniversary',
      rules: boardRules(MISSION, 'anniversary', 'standard'),
      vehicle: 'hoverjet:standard',
    })
    expect(doc.keyCount, 'the recorded lap, not another').toBe(flown?.last?.keys)
    expect(doc.tick.at(-1)).toBe(flown?.last?.finishTick)

    const posted = await share(page)
    const host = new URL(page.url()).host
    expect(posted.link).toBe(`${host}/?ghost=${POSTED_ID}`)
    expect(posted.board).toBe(false)
    expect(
      posted.ask?.rows.map((r) => r.id),
      'the name went with the lap',
    ).toEqual(['lap-post', 'lap-keep', 'lap-home'])
    expect(await askRow(page, 'lap-post')).toMatchObject({ label: 'Posted', value: 'Not ranked' })
    await page.waitForTimeout(400)
    await photograph(page, 'panel-posted-seat')
    await photographPanel(page, 'panel-posted')
    await photographAsk(page, 'ask-posted')
    // The next press on it posts nothing more: it ASKS to take the lap down (DEV-374).
    await hold(page, 'Enter')
    expect(server.posts).toHaveLength(1)
    expect((await share(page)).phase).toBe('confirm-delete')
    expect(await askRow(page, 'lap-post')).toMatchObject({
      label: 'Take it down?',
      value: 'Confirm',
    })
    expect(server.deletes, 'nothing is deleted until the press after').toEqual([])
    await photograph(page, 'panel-confirm-delete-seat')
    await photographPanel(page, 'panel-confirm-delete')

    // Any other row keeps it: the save row, pressed, moves the save and keeps the lap.
    await pressAsk(page, 'lap-keep')
    const kept = await share(page)
    expect(kept.phase).toBe('posted')
    expect(kept.id, 'the same lap, still on the panel').toBe(POSTED_ID)
    expect(server.deletes).toEqual([])
    await hold(page, 'Enter') // and back to YES

    // Asked again and answered: one DELETE, the owner key in its header only.
    await pressAsk(page, 'lap-post')
    await hold(page, 'Enter')
    await expect.poll(async () => (await share(page)).phase).toBe('deleted')
    expect(server.deletes).toEqual([{ path: `/api/laps?id=${POSTED_ID}`, owner }])
    await page.waitForTimeout(400)
    await photograph(page, 'panel-deleted-seat')
    await photographPanel(page, 'panel-deleted')
    // And a press after that sends nothing.
    await hold(page, 'Enter')
    expect(server.deletes).toHaveLength(1)
    expect(server.posts).toHaveLength(1)

    // ── home is still A: the last row ──────────────────────────────────
    await pressAsk(page, 'lap-home')
    await expect
      .poll(async () => (await hangarAim(page))?.screen, { message: 'A went home' })
      .toBe('menu')
    expect(problems.list(), 'page errors').toEqual([])
  })

  test('a tainted run is offered no Share, and the press sends nothing', async ({ page }) => {
    const problems = watchPageErrors(page)
    await installHarnessPad(page)
    const server = await serve(page, {}, [])
    const MISSION = 'int_01_hoverJet'
    await toTheTitle(page, '&edition=anniversary')
    await toTheCard(page, MISSION)
    await hold(page, 'Enter')
    await switchSettled(page, 180_000)
    await hold(page, 'Enter', 0)
    await released(page, 'tainted')
    // The autopilot, for a second: a tick of it taints the whole run.
    await hold(page, 'KeyP', 1_000)
    await hold(page, 'KeyP', 0)
    await flyToTheFinish(page, MISSION)
    const flown = await laps(page)
    console.info(`ghost-share tainted lap: ${JSON.stringify(flown?.last)}`)
    expect(flown?.last, 'the lap is kept, to race here').not.toBeNull()
    expect(flown?.last?.tainted).toBe(true)
    expect(flown?.last?.reasons).toContain('autopilot')
    const offered = await share(page)
    expect(offered.offered).toBe(false)
    // DEV-599: the pad's word; the harness pad is the last device used here too.
    expect(offered.prompts?.race, 'race this lap, and nothing about posting').toBe(
      'Y to race this lap',
    )
    // DEV-571: the menu says WHY it cannot go on the leaderboard, and has no name to change.
    expect(offered.ask?.rows.map((r) => r.id)).toEqual(['lap-post', 'lap-keep', 'lap-home'])
    expect(await askRow(page, 'lap-post')).toMatchObject({
      label: 'Leaderboard',
      value: "Can't post",
    })
    await pressAsk(page, 'lap-post')
    await hold(page, 'Enter')
    await hold(page, 'KeyG')
    await hold(page, 'KeyG')
    await photographAsk(page, 'ask-tainted')
    const after = await share(page)
    expect(after.phase).toBe('idle')
    expect(after.posts).toBe(0)
    expect(server.posts).toEqual([])
    expect(server.seen.filter((s) => s.method === 'POST')).toEqual([])
    await photographPanel(page, 'panel-tainted')
    expect(problems.list(), 'page errors').toEqual([])
  })
})

// ── DEV-571: the two questions, photographed where a player meets them ────
//
// A phone held sideways (DEV-566: landscape only), and a square frame the shape
// of one eye of a headset. The menu under the panel is the menus' own plate and
// the title's rows are the title's, so these are photographs of placement and
// legibility, not of new behaviour; each asserts what it photographs is up.

const PHONE_LANDSCAPE = {
  viewport: { width: 915, height: 412 },
  deviceScaleFactor: devices['Pixel 7'].deviceScaleFactor,
  userAgent: devices['Pixel 7'].userAgent,
  isMobile: true,
  hasTouch: true,
}
const HEADSET_EYE = { viewport: { width: 1000, height: 1000 } }

/** A lap flown by the autopilot (tainted, so nothing can be posted), to the panel. */
const autopilotLap = async (page: Page, tap: boolean): Promise<void> => {
  await page.goto(
    `/?autopilot=1&ride=0&mission=int_01_hoverJet&edition=anniversary&xr=off&${PINNED}`,
  )
  await firstPress(page, tap ? { tap: true } : {})
  await switchSettled(page, 240_000)
  await page.waitForSelector('body[data-finished="true"]', { timeout: 300_000 })
  await expect
    .poll(async () => (await share(page)).ask?.up ?? false, { message: 'the menu is up' })
    .toBe(true)
  await page.waitForTimeout(800)
}

/** The title with a lap's link, its WATCH and RACE rows up. */
const linkTitle = async (page: Page): Promise<void> => {
  const LINK = 'PhOtOlInK1'
  await serve(
    page,
    {
      [LINK]: {
        mission: 'rookie_02_hoverJet',
        edition: 'anniversary',
        variant: 'standard',
        handle: 'Bold Heron 77',
      },
    },
    [],
  )
  await toTheTitle(page, `&ghost=${LINK}`)
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            (
              globalThis as unknown as { __ff2: { titleMenu: () => { rows: string[] } } }
            ).__ff2.titleMenu().rows,
        ),
      { message: 'race or watch is asked' },
    )
    .toContain('watch-lap')
  await page.waitForTimeout(800)
}

test.describe('@gpu @measure DEV-571 photographs: a phone held sideways', () => {
  test.use(PHONE_LANDSCAPE)
  test.setTimeout(480_000)

  test('the menu under the panel, and WATCH or RACE on the title', async ({ page }) => {
    await autopilotLap(page, true)
    await photograph(page, 'phone-landscape-panel-asking')
    await linkTitle(page)
    await photograph(page, 'phone-landscape-title-watch-or-race')
  })
})

test.describe('@gpu @measure DEV-794: the phone’s YOUR LAP menu, one size up, on a 360 px glass', () => {
  // Matt, 2026-10-07 (go with your recs, QUESTIONS item 18): the menu beside the
  // panel was a squint at 915 x 412. It is a fifth bigger (`lapAskScale`), and
  // this is the check that it still FITS the smallest landscape phone: every
  // row's centre, and the half a row's pitch above and below it, on the glass.
  test.use({ ...PHONE_LANDSCAPE, viewport: { width: 780, height: 360 } })
  test.setTimeout(480_000)

  test('every row of the menu is on a 360 px tall glass', async ({ page }) => {
    await autopilotLap(page, true)
    await photograph(page, 'phone-360-panel-asking')
    const centres = (await share(page)).ask?.centres ?? []
    expect(centres.length, 'the menu has rows to measure').toBeGreaterThan(2)
    const pitch = (centres[1] as { y: number }).y - (centres[0] as { y: number }).y
    expect(pitch, 'the rows run down the glass').toBeGreaterThan(8)
    const glass = page.viewportSize()?.height ?? 360
    expect((centres[0] as { y: number }).y - pitch / 2).toBeGreaterThanOrEqual(0)
    expect((centres.at(-1) as { y: number }).y + pitch / 2).toBeLessThanOrEqual(glass)
    for (const c of centres) expect(c.x, `${c.id} is on the glass`).toBeLessThan(780)
  })
})

test.describe('@gpu @measure DEV-571 photographs: a headset-sized frame', () => {
  test.use(HEADSET_EYE)
  test.setTimeout(480_000)

  test('the menu under the panel, and WATCH or RACE on the title', async ({ page }) => {
    await autopilotLap(page, false)
    await photograph(page, 'headset-eye-panel-asking')
    await photographAsk(page, 'headset-eye-ask')
    await linkTitle(page)
    await photograph(page, 'headset-eye-title-watch-or-race')
  })
})
