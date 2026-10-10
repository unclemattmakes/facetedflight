/**
 * DEV-389's gate (plan/MULTIPLAYER.md §8, §6.3, §6.9): the LOBBY and the start,
 * driven the way a player drives them — the title's row, the lobby plates'
 * rows walked with the arrow keys and pressed with a HELD Enter (every confirm
 * is a level read once a frame; a tap lands between frames).
 *
 *   1. A presses the title's Host a Race (Multiplayer, DEV-441): a room, its
 *      short code (DEV-441b) in the address bar, the lobby by the chair, A the
 *      owner with a course chosen.
 *   2. B opens A's link: the title opens on Multiplayer aimed at Join Room,
 *      one press, the lobby.
 *   3. Colours: B walks the whole palette with the COLOUR row and never lands
 *      on A's (the lobby offers only free ones; the room refuses a taken one,
 *      `room-server.test.ts`).
 *   4. Both READY, A START: both board with NO ride (the launch is never
 *      `rising`), each on ITS OWN start point of the course (DEV-477: the
 *      racers' own starts, one each; two different ones, both on the judge's
 *      list), and the room holds the field while B's `loaded` is heard 5 s late (the sidecar
 *      delays it; the game is untouched) — then both release within 50 ms of
 *      the room's GO.
 *   5. A third join after START is refused with its notice (4001).
 *   6. Both EXIT from the pause plate: each forfeits (protocol 3), the race is
 *      settled, the room goes back to the lobby, and it races again.
 *   7. A room made by other content refuses a join with "reload to update" (4002).
 *
 * And two tests of their own: DEV-441b's code, typed from Classic's title; and
 * DEV-459's REMOVE A PLAYER — the owner removes a guest with two presses, the
 * guest is told so (4008) and kept out on a reload of the link.
 *
 * The room is `fixtures/room-sidecar.ts` (the real `RoomServer`), reached
 * through Vite's `/api` proxy. Run with:
 *
 *   FF2_API_PROXY=http://127.0.0.1:5398 E2E_PORT=5388 npx playwright test room-lobby
 *
 * Without `FF2_API_PROXY` the dev server has no `/api` and this skips, saying so.
 * Two BROWSERS in non-overlapping windows, for `room-two-browsers.spec.ts`'s
 * reason (an occluded window's frames are paused).
 */

import fs from 'node:fs'
import path from 'node:path'
import { ROOM_CODE_SHAPE, ROOM_PROTOCOL } from '../../src/net/room-protocol'
import { bootReady } from './fixtures/boot'
import type { Ff2Global, Ff2GlobalMaybe } from './fixtures/ff2'
import { DOOR_HOST, DOOR_JOIN_CODE, hangarAim, hangarOn, pressDoor } from './fixtures/hangar'
import { hold as keysHold } from './fixtures/keys'
import { firstPress } from './fixtures/landing'
import { PINNED } from './fixtures/quality-pin'
import { type RoomSidecar, startRoomSidecar } from './fixtures/room-sidecar'
import { E2E_BASE as BASE, E2E_CHANNEL as CHANNEL } from './fixtures/server'
import { type Browser, chromium, expect, type Page, skipSplash, test } from './fixtures/test'
import {
  hangarDoors,
  TITLE_ROW,
  throughMultiplayer,
  titleMenu,
  toHangar,
  toHangarDoor,
} from './fixtures/title'

const PROXY = process.env.FF2_API_PROXY ?? ''
/** Every page: no XR probe, and the tier pinned (the lobby is photographed). */
const QUERY = `xr=off&${PINNED}`
/** Where the lobby's photographs go, when set. */
const PHOTOS = process.env.ROOM_PHOTO_DIR ?? ''

/** Each release, room ms from the room's GO, and from each other (DEV-388's bound). */
const GO_SPREAD_MS = 50
/** How late the room hears B's `loaded` (§8 DEV-389: "made to load 5 s late"). */
const LATE_MS = 5000
/** A ship on its start, metres: it is placed there exactly. */
const ON_START_M = 0.5

/**
 * DEV-477: the course's start points, THREE space — the JUDGE's list
 * (`content/lap-courses.json`, SIM space, mirrored here), which no page reads
 * to place a ship.
 */
const startPoints = (mission: string): number[][] => {
  const file = path.join(process.cwd(), 'content', 'lap-courses.json')
  const courses = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    courses: Record<string, { editions: Record<string, { rooms?: { starts: number[][] } }> }>
  }
  const sim = courses.courses[mission]?.editions.anniversary?.rooms?.starts ?? []
  return sim.map(([x, y, z]) => [x as number, y as number, -(z as number)])
}

/** Which start point `at` stands on (within `ON_START_M`, in 3D), or -1. */
const startPointOf = (at: readonly number[], list: number[][]): number =>
  list.findIndex(
    (s) =>
      Math.hypot(
        (at[0] as number) - (s[0] as number),
        (at[1] as number) - (s[1] as number),
        (at[2] as number) - (s[2] as number),
      ) < ON_START_M,
  )

interface LobbyRow {
  id: string
  label: string
  value: string | null
  note: string
}
interface Probe {
  id: string
  status: string
  notice: string | null
  slot: number | null
  owner: number | null
  phase: string | null
  players: Record<number, { handle: string; colour: number; ready: boolean }>
  settings: { mission: string; colours: number; edition: string } | null
  goAt: number | null
  field: number | null
  goRoom: number | null
  ownStart: [number, number, number] | null
  ownAt: [number, number, number] | null
  lobby: { heading: string; aim: number; rows: LobbyRow[]; roster: LobbyRow[] } | null
}

const probe = (page: Page): Promise<Probe | null> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2GlobalMaybe
    const r = w.__ff2?.room() as Record<string, unknown> | null | undefined
    if (!r) return null
    const { ready: _r, start: _s, truth: _t, resetStats: _x, ...plain } = r
    return JSON.parse(JSON.stringify(plain)) as Probe
  })

/** The note on door table `id` of the hangar's step that is up (DEV-558), or null. */
const doorNote = (page: Page, id: string): Promise<string | null> =>
  page.evaluate(
    (want) =>
      (globalThis as unknown as Ff2GlobalMaybe).__ff2
        ?.hangarAim?.()
        ?.doors.find((d) => d.id === want)?.note ?? null,
    id,
  )

const pausePlate = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.pausePlate?.() ?? null)

const launchPhase = (page: Page): Promise<string | null> =>
  page.evaluate(() => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.launch().phase ?? null)

/** A key held for a frame or more, as a player presses it. */
const hold = (page: Page, key: string, ms = 200, settle = 250): Promise<void> =>
  keysHold(page, key, { down: ms, settle })

/** Walk a list's aim to `want` with the arrow keys, reading where it is each step. */
const walk = async (page: Page, where: () => Promise<number>, want: number): Promise<void> => {
  for (let i = 0; i < 16; i++) {
    const at = await where()
    if (at === want) return
    await hold(page, at < want ? 'ArrowDown' : 'ArrowUp', 150, 150)
  }
  expect(await where(), 'the arrow keys reached the row').toBe(want)
}

/** Press the lobby's action row `id`: named, found on the plate, walked to, held. */
const pressRow = async (page: Page, id: string): Promise<void> => {
  await expect
    .poll(async () => (await probe(page))?.lobby?.rows.some((r) => r.id === id) ?? false, {
      message: `the lobby offers ${id}`,
      timeout: 30_000,
    })
    .toBe(true)
  const index = async () => ((await probe(page))?.lobby?.rows ?? []).findIndex((r) => r.id === id)
  await walk(page, async () => (await probe(page))?.lobby?.aim ?? -1, await index())
  await hold(page, 'Enter', 200, 400)
}

const open = async (
  x: number,
  y: number,
  query: string,
): Promise<{ browser: Browser; page: Page }> => {
  const browser = await chromium.launch({
    headless: false,
    ...(CHANNEL ? { channel: CHANNEL } : {}),
    args: [`--window-position=${x},${y}`, '--window-size=900,640'],
  })
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 880, height: 520 },
  })
  await skipSplash(context)
  // The invite row copies to the clipboard; a real browser asks first.
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE })
  const page = await context.newPage()
  page.on('console', (m) => {
    const t = m.text()
    if (/^room|^title: to the room|countdown/.test(t)) console.log(`[${x},${y}] ${t}`)
  })
  await page.goto(`${BASE}/?${query}${query ? '&' : ''}${QUERY}`)
  await bootReady(page, 240_000)
  await firstPress(page)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await expect
    .poll(async () => (await titleMenu(page))?.up ?? false, { timeout: 60_000 })
    .toBe(true)
  return { browser, page }
}

/**
 * From the title's rows to the lobby: START, then the hangar's MULTIPLAYER and
 * HOST A RACE tables, pressed by name (DEV-441; holotables since DEV-558).
 */
const intoTheLobby = async (page: Page): Promise<void> => {
  await toHangarDoor(page, DOOR_HOST, 400)
  await expect
    .poll(async () => (await probe(page))?.lobby?.heading ?? null, { timeout: 60_000 })
    .toBe('- ROOM -')
}

/** The edition this page is flying under (`__ff2.edition`). */
const editionOf = (page: Page): Promise<string> =>
  page.evaluate(() => (globalThis as unknown as Ff2Global).__ff2.edition.current.id)

/**
 * DEV-441b: walk the letter plate's aim onto key `id` with the ARROW KEYS — the
 * stick's route, one step a press — steering by where the keys are drawn
 * (`keysAt`), so the walk knows no layout: up or down while the key is on
 * another row, then across.
 */
const arrowToKey = async (page: Page, id: string): Promise<void> => {
  for (let i = 0; i < 20; i++) {
    const code = (await titleMenu(page))?.code
    if (!code) throw new Error('the letter plate is down')
    const want = code.keys.indexOf(id)
    if (code.selected === want) return
    const at = code.keysAt[code.selected] as { x: number; y: number }
    const to = code.keysAt[want] as { x: number; y: number }
    const vertical = Math.abs(to.y - at.y) > 4
    const key = vertical
      ? to.y > at.y
        ? 'ArrowDown'
        : 'ArrowUp'
      : to.x > at.x
        ? 'ArrowRight'
        : 'ArrowLeft'
    await hold(page, key, 120, 150)
  }
  const code = (await titleMenu(page))?.code
  expect(code?.selected, `the arrow keys reached ${id}`).toBe(code?.keys.indexOf(id))
}

/** Pause, walk to EXIT, press it: out of the race and back to the lobby. */
const exitRace = async (page: Page): Promise<void> => {
  await hold(page, 'Backspace', 200, 400)
  await expect.poll(async () => (await pausePlate(page))?.open ?? false).toBe(true)
  const rows = (await pausePlate(page))?.rows.map((r) => r.id) ?? []
  expect(rows, 'a room’s pause plate has no RESTART').not.toContain('restart')
  await walk(page, async () => (await pausePlate(page))?.selected ?? -1, rows.indexOf('exit'))
  await hold(page, 'Enter', 200, 400)
}

test.describe('@gpu the room lobby (DEV-389)', () => {
  test.skip(
    !PROXY,
    'set FF2_API_PROXY=http://127.0.0.1:<port> so Vite forwards /api to the room sidecar',
  )
  test.setTimeout(900_000)

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

  test('make, join by link, choose, ready, start together; refuse a late join; forfeit, and race again', async () => {
    // The SECOND `loaded` the room hears (whoever sends it) arrives 5 s late.
    sidecar.loadedDelayMs = [0, LATE_MS]
    const a = await open(0, 0, '')
    const browsers: Browser[] = [a.browser]
    try {
      // ── 1. A makes a room ─────────────────────────────────────────────
      await intoTheLobby(a.page)
      const id = (await probe(a.page))?.id as string
      // DEV-441b: a room is hosted under a short code, and the code IS its id.
      expect(id).toMatch(ROOM_CODE_SHAPE)
      expect(new URL(a.page.url()).searchParams.get('room'), 'the link is the room').toBe(id)
      await expect
        .poll(async () => (await probe(a.page))?.settings?.mission ?? null, { timeout: 30_000 })
        .not.toBeNull()
      const pa0 = (await probe(a.page)) as Probe
      expect(pa0.owner).toBe(pa0.slot)
      expect(pa0.lobby?.rows.map((r) => r.id)).toContain('start')

      // ── 2. B joins by the link ────────────────────────────────────────
      const b = await open(920, 0, `room=${id}`)
      browsers.push(b.browser)
      const menu = await titleMenu(b.page)
      // DEV-558: the link's room is joined at boot and its lobby stands in the
      // hangar, so START is the one press: the title says so on it.
      expect(menu?.rows[menu.selected], 'aimed at START').toBe(TITLE_ROW.hangar)
      expect(menu?.notes[menu.selected], 'START says the link’s lobby').toContain(
        `${id.slice(0, 3)} ${id.slice(3)}`,
      )
      await hold(b.page, 'Enter', 200, 400)
      await expect
        .poll(async () => (await probe(b.page))?.lobby?.heading ?? null, { timeout: 60_000 })
        .toBe('- ROOM -')
      const pb0 = (await probe(b.page)) as Probe
      expect(pb0.lobby?.rows.map((r) => r.id)).not.toContain('start')
      await expect
        .poll(async () => (await probe(a.page))?.lobby?.roster[1]?.label ?? null)
        .toBe(pb0.players[pb0.slot as number]?.handle)

      // ── 3. colours: every free one, never A's ─────────────────────────
      const aColour = pa0.players[pa0.slot as number]?.colour as number
      const count = pb0.settings?.colours as number
      const seen = new Set<number>()
      for (let i = 0; i < count; i++) {
        const mine = (await probe(b.page)) as Probe
        const c = mine.players[mine.slot as number]?.colour as number
        seen.add(c)
        expect(c, 'B never holds A’s colour').not.toBe(aColour)
        await pressRow(b.page, 'colour')
        await expect
          .poll(async () => {
            const p = (await probe(b.page)) as Probe
            return p.players[p.slot as number]?.colour
          })
          .not.toBe(c)
      }
      expect(seen.size, 'the COLOUR row walks every free colour').toBe(count - 1)
      // The lobby from the chair, both sides of it (flat; §8 DEV-389's photographs).
      if (PHOTOS) {
        await a.page.screenshot({ path: `${PHOTOS}/lobby-owner.png` })
        await b.page.screenshot({ path: `${PHOTOS}/lobby-guest.png` })
      }

      // ── 4. ready, START, the starts, the late loader, one GO ──────────
      await pressRow(a.page, 'ready')
      await pressRow(b.page, 'ready')
      await expect
        .poll(async () => Object.values((await probe(a.page))?.players ?? {}).every((p) => p.ready))
        .toBe(true)
      await expect
        .poll(async () => (await probe(a.page))?.lobby?.rows.find((r) => r.id === 'start')?.note)
        .toMatch(/^Everyone is ready: press START/) // DEV-587: and who fills the empty starts
      await pressRow(a.page, 'start')

      const phases = { a: new Set<string>(), b: new Set<string>() }
      let heldFrom: number | null = null
      let heldTo: number | null = null
      const starts: Record<string, [number, number, number]> = {}
      const deadline = Date.now() + 240_000
      while (Date.now() < deadline) {
        const [pa, pb] = [(await probe(a.page)) as Probe, (await probe(b.page)) as Probe]
        const ready = await Promise.all(
          [a.page, b.page].map((p) => p.getAttribute('body', 'data-terrain-ready')),
        )
        for (const [k, p, page] of [
          ['a', pa, a.page],
          ['b', pb, b.page],
        ] as const) {
          if (ready[k === 'a' ? 0 : 1] !== 'true') continue
          const phase = await launchPhase(page)
          if (phase) phases[k].add(phase)
          // On its own start, before its GO: placed there, exactly, height too.
          if (p.goRoom === null && p.ownStart && p.ownAt && phase === 'waiting') {
            const off = Math.hypot(
              p.ownAt[0] - p.ownStart[0],
              p.ownAt[1] - p.ownStart[1],
              p.ownAt[2] - p.ownStart[2],
            )
            if (off < ON_START_M) starts[k] = p.ownStart
          }
        }
        // A on the grid and holding while the room waits for B.
        if (heldFrom === null && starts.a && pa.field === null) heldFrom = Date.now()
        if (heldFrom !== null && heldTo === null && pa.field !== null) heldTo = Date.now()
        if (pa.goRoom !== null && pb.goRoom !== null) break
        await a.page.waitForTimeout(100)
      }
      const [pa, pb] = [(await probe(a.page)) as Probe, (await probe(b.page)) as Probe]
      console.log(
        `phases A ${[...phases.a].join(',')} · B ${[...phases.b].join(',')} · held ${heldFrom && heldTo ? heldTo - heldFrom : '?'} ms · GO ${pa.goAt} · A ${pa.goRoom?.toFixed(1)} · B ${pb.goRoom?.toFixed(1)}`,
      )
      for (const k of ['a', 'b'] as const) {
        expect(phases[k].has('rising'), `${k}: no lift ride in a room`).toBe(false)
        expect(starts[k], `${k} stood on its own start`).toBeDefined()
      }
      // DEV-477: two people, two DIFFERENT start points of the course — the
      // racers' own, off the judge's list — and in a room of two, the first two.
      const list = startPoints(pa.settings?.mission as string)
      expect(list, "the judge's list of start points").toHaveLength(6)
      const [ia, ib] = [
        startPointOf(starts.a as number[], list),
        startPointOf(starts.b as number[], list),
      ]
      console.log(`starts: A on ${ia}, B on ${ib}`)
      expect(ia, 'A stood on a start point of the course').toBeGreaterThanOrEqual(0)
      expect(ib, 'B stood on a start point of the course').toBeGreaterThanOrEqual(0)
      expect(ia, 'two humans, two start points').not.toBe(ib)
      expect([ia, ib].sort(), 'the first two: the pad and 2016’s first').toEqual([0, 1])
      expect(heldFrom, 'A stood on the grid before the room let the field go').not.toBeNull()
      expect(
        (heldTo ?? 0) - (heldFrom ?? 0),
        'the room waited for the late loader',
      ).toBeGreaterThan(LATE_MS - 1500)
      expect(pa.goAt).toBe(pb.goAt)
      expect(Math.abs((pa.goRoom as number) - (pa.goAt as number))).toBeLessThan(GO_SPREAD_MS)
      expect(Math.abs((pb.goRoom as number) - (pb.goAt as number))).toBeLessThan(GO_SPREAD_MS)
      expect(Math.abs((pa.goRoom as number) - (pb.goRoom as number))).toBeLessThan(GO_SPREAD_MS)

      // ── 5. a third join after START: refused, and said so (4001) ─────
      const c = await open(0, 660, `room=${id}`)
      browsers.push(c.browser)
      await expect
        .poll(async () => (await probe(c.page))?.status ?? null, { timeout: 30_000 })
        .toBe('closed')
      expect((await probe(c.page))?.notice).toBe('That race has already started.')
      // DEV-558: START says why on the title, and goes to the hangar's doors,
      // where the link's room (closed before it seated this page) stands no
      // lobby: the MULTIPLAYER table says why instead, and the doors are live.
      await expect
        .poll(async () => {
          const m = await titleMenu(c.page)
          return m ? (m.notes[m.rows.indexOf(TITLE_ROW.hangar)] ?? '') : ''
        })
        .toContain('That race has already started.')
      await hold(c.page, 'Enter', 200, 400)
      await hangarOn(c.page, 'doors')
      await expect
        .poll(async () => (await doorNote(c.page, 'multiplayer')) ?? null, { timeout: 30_000 })
        .toContain('That race has already started.')
      expect((await probe(c.page))?.lobby ?? null, 'no closed lobby over the doors').toBeNull()

      // ── 6. both leave the race: forfeits, settled, the lobby, again ──
      await exitRace(a.page)
      await expect
        .poll(async () => (await probe(a.page))?.lobby?.heading ?? null, { timeout: 30_000 })
        .toBe('- RACE ON -')
      await exitRace(b.page)
      for (const page of [a.page, b.page]) {
        await expect
          .poll(async () => (await probe(page))?.lobby?.heading ?? null, { timeout: 30_000 })
          .toBe('- ROOM -')
        const p = (await probe(page)) as Probe
        expect(p.phase).toBe('lobby')
        expect(p.goAt, 'no race live in the lobby').toBeNull()
        expect(Object.values(p.players).some((x) => x.ready)).toBe(false)
      }
      // And it races again: ready, START, both boarded.
      await pressRow(a.page, 'ready')
      await pressRow(b.page, 'ready')
      await expect
        .poll(async () => (await probe(a.page))?.lobby?.rows.find((r) => r.id === 'start')?.note)
        .toMatch(/^Everyone is ready: press START/) // DEV-587: and who fills the empty starts
      await pressRow(a.page, 'start')
      for (const page of [a.page, b.page]) {
        await expect
          .poll(async () => (await probe(page))?.goRoom ?? null, { timeout: 180_000 })
          .not.toBeNull()
      }

      // ── 7. a room made by other content: "reload to update" (4002) ───
      // Another code: the last character moved on (codes are seven, DEV-458).
      const other = `${id.slice(0, -1)}${id.endsWith('Z') ? 'Y' : 'Z'}`
      const ws = new WebSocket(`${PROXY.replace(/^http/, 'ws')}/api/room/${other}`)
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
          ws.send(
            JSON.stringify({
              type: 'join',
              protocol: ROOM_PROTOCOL,
              handle: 'Swift Kestrel 11',
              variant: 'standard',
              colour: 0,
              content: 'ffffffffffffffff',
            }),
          )
          resolve()
        }
        ws.onerror = () => reject(new Error('the sidecar socket did not open'))
      })
      await c.page.goto(`${BASE}/?room=${other}&${QUERY}`)
      await expect
        .poll(async () => (await probe(c.page))?.status ?? null, { timeout: 120_000 })
        .toBe('closed')
      expect((await probe(c.page))?.notice).toMatch(/reload to update/)
      ws.close()
    } finally {
      for (const br of browsers) await br.close()
    }
  })

  // ── DEV-441 and DEV-441b: the front door, from Classic, and a code typed ──
  //
  // Matt, 2026-09-27: *"i don't really see how to start a multiplayer game."*
  // Two Classic players (the edition that showed no multiplayer): the title's
  // Multiplayer door, Host a Race, and the room's CODE on the invite row; the
  // other types the code on the letter plate — a wrong one first, which the
  // room refuses (4004) and the PLATE says, still on the title — and both are
  // in one room racing Anniversary's rules, the page's edition kept for it.
  test('DEV-441b: a Classic player hosts; another joins by the typed CODE (a typo refused on the plate); both race Anniversary', async () => {
    const a = await open(0, 0, 'edition=classic')
    const browsers: Browser[] = [a.browser]
    try {
      // ── 1. the doors, on Classic's hangar ──────────────────────────────
      // DEV-558: the title is START (and ENTER VR); the doors are the hangar's
      // first step, Anniversary's menus whatever the look (D35).
      const top = await titleMenu(a.page)
      expect(top?.rows[0], 'START, on Classic too').toBe(TITLE_ROW.hangar)
      await toHangar(a.page)
      // DEV-565: and QUICK RACE, to SINGLE PLAYER's left (Matt, 2026-10-02).
      // DEV-620: and CREDITS, first, off the left end.
      expect(
        await hangarDoors(a.page),
        'OPTIONS, QUICK RACE, SINGLE PLAYER, MULTIPLAYER, FF-TV',
      ).toEqual(['options', 'course-editor', 'quick-race', 'single-player', 'multiplayer', 'tv'])
      if (PHOTOS) await a.page.screenshot({ path: `${PHOTOS}/hangar-doors-classic.png` })
      await throughMultiplayer(a.page) // DEV-565: and the seat back to rest
      await hangarOn(a.page, 'multiplayer')
      await pressDoor(a.page, DOOR_HOST, 400)
      await expect
        .poll(async () => (await probe(a.page))?.lobby?.heading ?? null, { timeout: 60_000 })
        .toBe('- ROOM -')
      const code = (await probe(a.page))?.id as string
      expect(code).toMatch(ROOM_CODE_SHAPE)
      expect(new URL(a.page.url()).searchParams.get('room'), 'the code is the link').toBe(code)
      // The invite row says the code, large, as a friend reads it.
      await expect
        .poll(
          async () =>
            (await probe(a.page))?.lobby?.rows.find((r) => r.id === 'invite')?.value ?? null,
        )
        .toBe(`${code.slice(0, 3)} ${code.slice(3)}`)
      // DEV-441: a room keeps the title's Anniversary for the page, so the
      // owner configures Anniversary's rules whatever it chose.
      expect(await editionOf(a.page), 'the host flies Anniversary in a room').toBe('anniversary')
      await expect
        .poll(async () => (await probe(a.page))?.settings?.edition ?? null, { timeout: 30_000 })
        .toBe('anniversary')
      if (PHOTOS) await a.page.screenshot({ path: `${PHOTOS}/lobby-code-owner.png` })

      // ── 2. B, Classic, no link: Multiplayer, Join with a Code ──────────
      const b = await open(920, 0, 'edition=classic')
      browsers.push(b.browser)
      // DEV-558: the hangar's Multiplayer step, then JOIN WITH A CODE: the
      // letter plate stands in front of the chair.
      await toHangarDoor(b.page, DOOR_JOIN_CODE, 400)
      await expect.poll(async () => (await titleMenu(b.page))?.code !== null).toBe(true)
      // A code nobody is in, typed on the keyboard; the sixth character puts
      // the aim on JOIN, so Enter joins.
      const wrong = `${code.startsWith('2') ? '3' : '2'}${code.slice(1)}`
      await b.page.keyboard.type(wrong.toLowerCase(), { delay: 60 })
      await expect.poll(async () => (await titleMenu(b.page))?.code?.typed).toBe(wrong)
      if (PHOTOS) await b.page.screenshot({ path: `${PHOTOS}/title-letter-plate.png` })
      await hold(b.page, 'Enter', 200, 400)
      await expect
        .poll(async () => (await titleMenu(b.page))?.code?.footer ?? null, { timeout: 30_000 })
        .toBe('There is no room with that code.')
      const refused = await titleMenu(b.page)
      expect(
        (await hangarAim(b.page))?.view,
        'refused IN THE HANGAR, on its Multiplayer step, with the code left to correct',
      ).toBe('multiplayer')
      expect(refused?.code?.typed).toBe(wrong)
      expect(await probe(b.page), 'and in no room').toBeNull()
      if (PHOTOS) await b.page.screenshot({ path: `${PHOTOS}/title-letter-plate-refused.png` })

      // ── 3. the right code, three ways ──────────────────────────────────
      // Backspace takes the wrong one away, a character at a time.
      for (let i = 0; i < wrong.length; i++) await hold(b.page, 'Backspace', 80, 120)
      await expect.poll(async () => (await titleMenu(b.page))?.code?.typed).toBe('')
      // The first character with the ARROW KEYS and Enter (the stick's route).
      await arrowToKey(b.page, code.charAt(0))
      await hold(b.page, 'Enter', 200, 300)
      // The second with a CURSOR click on its key.
      const plate = (await titleMenu(b.page))?.code
      const second = plate?.keysAt[plate.keys.indexOf(code.charAt(1))]
      expect(second, 'the key is on screen').toBeDefined()
      await b.page.mouse.click(second?.x ?? 0, second?.y ?? 0)
      await expect.poll(async () => (await titleMenu(b.page))?.code?.typed).toBe(code.slice(0, 2))
      // The rest typed; Enter joins.
      await b.page.keyboard.type(code.slice(2).toLowerCase(), { delay: 60 })
      await expect.poll(async () => (await titleMenu(b.page))?.code?.typed).toBe(code)
      await hold(b.page, 'Enter', 200, 400)
      await expect
        .poll(async () => (await probe(b.page))?.lobby?.heading ?? null, { timeout: 60_000 })
        .toBe('- ROOM -')
      expect((await probe(b.page))?.id, 'in the room the code names').toBe(code)
      await expect
        .poll(async () => Object.keys((await probe(a.page))?.players ?? {}).length)
        .toBe(2)

      // ── 4. B races Anniversary: nothing stops it being ready ────────────
      expect(await editionOf(b.page), 'the joiner flies Anniversary in a room').toBe('anniversary')
      await expect
        .poll(async () => (await probe(b.page))?.lobby?.rows.find((r) => r.id === 'ready')?.note)
        .toBe('press when you are set to race')
      await pressRow(b.page, 'ready')
      await expect
        .poll(async () => {
          const p = await probe(a.page)
          return Object.values(p?.players ?? {}).filter((x) => x.ready).length
        })
        .toBe(1)
      if (PHOTOS) await b.page.screenshot({ path: `${PHOTOS}/lobby-code-guest.png` })
    } finally {
      for (const br of browsers) await br.close()
    }
  })

  // ── DEV-459: the owner removes a player ─────────────────────────────────
  //
  // Matt, 2026-09-27: *"add a kick row"*. Two browsers: A hosts, B joins by the
  // link. B is offered no REMOVE A PLAYER; A presses it, arms B's row with one
  // press and removes B with the second. B's lobby says why in plain words,
  // A's roster is one again, and B coming back in the same tab — a reload of
  // the link, the first thing a removed player tries — is refused the same way.
  test('DEV-459: the owner removes a guest, who is told so and kept out on a reload', async () => {
    const a = await open(0, 0, '')
    const browsers: Browser[] = [a.browser]
    try {
      await intoTheLobby(a.page)
      const id = (await probe(a.page))?.id as string
      const b = await open(920, 0, `room=${id}`)
      browsers.push(b.browser)
      await hold(b.page, 'Enter', 200, 400)
      await expect
        .poll(async () => (await probe(b.page))?.lobby?.heading ?? null, { timeout: 60_000 })
        .toBe('- ROOM -')
      const bSlot = (await probe(b.page))?.slot as number
      await expect
        .poll(async () => Object.keys((await probe(a.page))?.players ?? {}).length)
        .toBe(2)
      // A guest is offered no way to remove anyone.
      expect((await probe(b.page))?.lobby?.rows.map((r) => r.id)).not.toContain('kick')

      // ── A: REMOVE A PLAYER, B's row pressed twice ──────────────────────
      await pressRow(a.page, 'kick')
      await expect
        .poll(async () => (await probe(a.page))?.lobby?.heading ?? null)
        .toBe('- REMOVE A PLAYER -')
      const row = `kick-${bSlot}`
      await pressRow(a.page, row)
      const armed = (await probe(a.page))?.lobby?.rows.find((r) => r.id === row)
      expect(armed?.note, 'one press ARMS, and says so').toBe('press again to remove them')
      expect(Object.keys((await probe(a.page))?.players ?? {}).length, 'nobody removed yet').toBe(2)
      if (PHOTOS) await a.page.screenshot({ path: `${PHOTOS}/lobby-remove-armed.png` })
      await hold(a.page, 'Enter', 200, 400)

      // ── B is out, and told why ──────────────────────────────────────────
      await expect
        .poll(async () => (await probe(b.page))?.status ?? null, { timeout: 30_000 })
        .toBe('closed')
      expect((await probe(b.page))?.notice).toBe("The room's owner removed you from this room.")
      await expect
        .poll(async () => (await probe(b.page))?.lobby?.heading ?? null)
        .toBe('- ROOM CLOSED -')
      if (PHOTOS) await b.page.screenshot({ path: `${PHOTOS}/lobby-removed-guest.png` })
      // ── A: the seat is free, and the page goes back to the room's rows ──
      await expect
        .poll(async () => Object.keys((await probe(a.page))?.players ?? {}).length)
        .toBe(1)
      await expect.poll(async () => (await probe(a.page))?.lobby?.heading ?? null).toBe('- ROOM -')
      expect(
        (await probe(a.page))?.lobby?.rows.map((r) => r.id),
        'nobody left to remove',
      ).not.toContain('kick')

      // ── B reloads the link in the same tab: kept out (its page token) ──
      await b.page.goto(`${BASE}/?room=${id}&${QUERY}`)
      await expect
        .poll(async () => (await probe(b.page))?.status ?? null, { timeout: 120_000 })
        .toBe('closed')
      expect((await probe(b.page))?.notice).toBe("The room's owner removed you from this room.")
      expect(Object.keys((await probe(a.page))?.players ?? {}).length, 'and not seated').toBe(1)
    } finally {
      for (const br of browsers) await br.close()
    }
  })
})
