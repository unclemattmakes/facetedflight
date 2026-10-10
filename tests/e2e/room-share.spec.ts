/**
 * DEV-632: joining a room without typing the code on the letter plate.
 *
 * Matt, 2026-10-04: *"so typing a room code on mobile is painful, same with
 * PC."* Three players, each doing what that device's player does:
 *
 *   1. A, a computer, hosts. The invite row is COPY LINK and copies the room's
 *      link; the lobby shows the same link as a QR code (`#room-qr`).
 *   2. B, a computer, opens JOIN WITH A CODE and presses Ctrl+V: a paste with
 *      no code in it is refused on the plate, a whole invite link fills the
 *      plate with its code, and Enter joins.
 *   3. C, a phone (a Pixel 7, landscape), opens JOIN WITH A CODE: the code
 *      field stands over the plate (`#room-code-input`), a tap focuses it, what
 *      is typed there is on the plate, Go (Enter) joins, and C's invite row is
 *      SHARE, with no QR code.
 *
 * The room is `fixtures/room-sidecar.ts`, reached through Vite's `/api` proxy:
 *
 *   FF2_API_PROXY=http://127.0.0.1:5398 E2E_PORT=5632 npx playwright test room-share --workers 1
 *
 * Without `FF2_API_PROXY` the dev server has no `/api` and this skips, saying so.
 */

import { bootReady } from './fixtures/boot'
import type { Ff2GlobalMaybe } from './fixtures/ff2'
import { DOOR_HOST, DOOR_JOIN_CODE, hangarOn, pressDoor } from './fixtures/hangar'
import { hold as keysHold } from './fixtures/keys'
import { firstPress } from './fixtures/landing'
import { PINNED } from './fixtures/quality-pin'
import { type RoomSidecar, startRoomSidecar } from './fixtures/room-sidecar'
import { E2E_BASE as BASE, E2E_CHANNEL as CHANNEL } from './fixtures/server'
import {
  type Browser,
  type BrowserContextOptions,
  chromium,
  devices,
  expect,
  type Page,
  skipSplash,
  test,
} from './fixtures/test'
import { throughMultiplayer, titleMenu, toHangar, toHangarDoor } from './fixtures/title'

const PROXY = process.env.FF2_API_PROXY ?? ''
const QUERY = `xr=off&${PINNED}`
const PHOTOS = process.env.ROOM_PHOTO_DIR ?? ''

/** A phone held sideways, as `phone-refit.spec.ts` holds one. */
const PHONE: BrowserContextOptions = {
  viewport: { width: 915, height: 412 },
  deviceScaleFactor: devices['Pixel 7'].deviceScaleFactor,
  userAgent: devices['Pixel 7'].userAgent,
  isMobile: true,
  hasTouch: true,
}

interface LobbyRow {
  id: string
  label: string
  value: string | null
  note: string
}
interface Probe {
  id: string
  players: Record<number, unknown>
  lobby: { heading: string; aim: number; rows: LobbyRow[] } | null
}

const probe = (page: Page): Promise<Probe | null> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2GlobalMaybe
    const r = w.__ff2?.room() as Record<string, unknown> | null | undefined
    if (!r) return null
    const { ready: _r, start: _s, truth: _t, resetStats: _x, ...plain } = r
    return JSON.parse(JSON.stringify(plain)) as Probe
  })

const invite = async (page: Page): Promise<LobbyRow | null> =>
  (await probe(page))?.lobby?.rows.find((r) => r.id === 'invite') ?? null

/** A key held for a frame or more, as a player presses it. */
const hold = (page: Page, key: string, ms = 200, settle = 250): Promise<void> =>
  keysHold(page, key, { down: ms, settle })

const open = async (
  x: number,
  y: number,
  options: BrowserContextOptions = { viewport: { width: 880, height: 520 } },
): Promise<{ browser: Browser; page: Page }> => {
  const browser = await chromium.launch({
    headless: false,
    ...(CHANNEL ? { channel: CHANNEL } : {}),
    args: [`--window-position=${x},${y}`, '--window-size=940,640'],
  })
  const context = await browser.newContext({ ignoreHTTPSErrors: true, ...options })
  await skipSplash(context)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE })
  const page = await context.newPage()
  page.on('console', (m) => {
    const t = m.text()
    if (/^room|^hangar: (pasted|a paste|joining|into)/.test(t)) console.log(`[${x},${y}] ${t}`)
  })
  await page.goto(`${BASE}/?${QUERY}`)
  await bootReady(page, 240_000)
  await firstPress(page)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await expect
    .poll(async () => (await titleMenu(page))?.up ?? false, { timeout: 60_000 })
    .toBe(true)
  return { browser, page }
}

/** Walk the lobby's aim to row `id` with the arrow keys and press it with a held Enter. */
const pressLobbyRow = async (page: Page, id: string): Promise<void> => {
  await expect
    .poll(async () => (await probe(page))?.lobby?.rows.some((r) => r.id === id) ?? false)
    .toBe(true)
  const want = ((await probe(page))?.lobby?.rows ?? []).findIndex((r) => r.id === id)
  for (let i = 0; i < 16; i++) {
    const at = (await probe(page))?.lobby?.aim ?? -1
    if (at === want) break
    await hold(page, at < want ? 'ArrowDown' : 'ArrowUp', 150, 150)
  }
  expect((await probe(page))?.lobby?.aim, `the arrow keys reached ${id}`).toBe(want)
  await hold(page, 'Enter', 200, 400)
}

/** The door tables on the hangar's step that is up (DEV-558), by id. */
const doorIds = (page: Page): Promise<string[]> =>
  page.evaluate(
    () =>
      (globalThis as unknown as Ff2GlobalMaybe).__ff2?.hangarAim?.()?.doors.map((d) => d.id) ?? [],
  )

/** What `GET /api/rooms` says, from the page (same origin, as the game asks). */
const listed = (page: Page): Promise<string[]> =>
  page.evaluate(async () => {
    const r = await fetch('/api/rooms')
    const body = (await r.json()) as { rooms: { room: string }[] }
    return body.rooms.map((x) => x.room)
  })

/** The friend's message, put on this browser's clipboard as their text app would. */
const clipboardHolds = (page: Page, text: string): Promise<void> =>
  page.evaluate((t) => navigator.clipboard.writeText(t), text)

test.describe('@gpu joining a room without the letter plate (DEV-632)', () => {
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

  test('a computer copies the link and shows its QR; a computer pastes it; a phone types the code on its own keyboard', async () => {
    const a = await open(0, 0)
    const browsers: Browser[] = [a.browser]
    try {
      // ── 1. A hosts: COPY LINK, and the QR code ─────────────────────────
      await toHangarDoor(a.page, DOOR_HOST, 400)
      await expect
        .poll(async () => (await probe(a.page))?.lobby?.heading ?? null, { timeout: 60_000 })
        .toBe('- ROOM -')
      const code = (await probe(a.page))?.id as string
      const link = `${BASE}/?room=${code}`
      await expect.poll(async () => (await invite(a.page))?.label).toBe('Copy Link')
      expect((await invite(a.page))?.value).toBe(`${code.slice(0, 3)} ${code.slice(3)}`)
      const qr = a.page.locator('#room-qr')
      await expect(qr).toBeVisible()
      expect(await qr.getAttribute('data-link'), 'the QR code carries the invite link').toBe(link)
      await expect(qr).toContainText(`SCAN TO JOIN ${code.slice(0, 3)} ${code.slice(3)}`)
      // The press: walk the lobby's aim to the row, a held Enter.
      const rows = (await probe(a.page))?.lobby?.rows ?? []
      const want = rows.findIndex((r) => r.id === 'invite')
      for (let i = 0; i < 16; i++) {
        const at = (await probe(a.page))?.lobby?.aim ?? -1
        if (at === want) break
        await hold(a.page, at < want ? 'ArrowDown' : 'ArrowUp', 150, 150)
      }
      await hold(a.page, 'Enter', 200, 400)
      await expect.poll(async () => (await invite(a.page))?.note ?? '').toMatch(/link copied/)
      expect(await a.page.evaluate(() => navigator.clipboard.readText())).toBe(link)
      if (PHOTOS) await a.page.screenshot({ path: `${PHOTOS}/dev632-pc-lobby-qr-copy-link.png` })

      // ── 2. B, a computer: Ctrl+V on the letter plate ───────────────────
      const b = await open(940, 0)
      browsers.push(b.browser)
      await toHangarDoor(b.page, DOOR_JOIN_CODE, 400)
      await expect.poll(async () => (await titleMenu(b.page))?.code != null).toBe(true)
      await expect(b.page.locator('#room-code-field'), 'no phone field on a computer').toBeHidden()
      await clipboardHolds(b.page, 'see you on the course!')
      await b.page.keyboard.press('Control+V')
      await expect
        .poll(async () => (await titleMenu(b.page))?.code?.footer ?? null)
        .toBe('That is not a room code.')
      expect((await titleMenu(b.page))?.code?.typed, 'and nothing typed').toBe('')
      await clipboardHolds(b.page, `race me! ${link}`)
      await b.page.keyboard.press('Control+V')
      await expect.poll(async () => (await titleMenu(b.page))?.code?.typed).toBe(code)
      if (PHOTOS) await b.page.screenshot({ path: `${PHOTOS}/dev632-pc-pasted-link.png` })
      await hold(b.page, 'Enter', 200, 400)
      await expect
        .poll(async () => (await probe(b.page))?.lobby?.heading ?? null, { timeout: 60_000 })
        .toBe('- ROOM -')
      expect((await probe(b.page))?.id, 'in the room the link names').toBe(code)

      // ── 3. C, a phone: the system keyboard, through a real field ───────
      const c = await open(0, 660, PHONE)
      browsers.push(c.browser)
      await toHangarDoor(c.page, DOOR_JOIN_CODE, 400)
      await expect.poll(async () => (await titleMenu(c.page))?.code != null).toBe(true)
      const field = c.page.locator('#room-code-input')
      await expect(field, 'the code field stands over the plate').toBeVisible()
      expect(await field.getAttribute('autocapitalize')).toBe('characters')
      expect(await field.getAttribute('autocomplete')).toBe('off')
      expect(await field.getAttribute('autocorrect')).toBe('off')
      expect(await field.getAttribute('spellcheck')).toBe('false')
      await field.tap()
      await expect(field).toBeFocused()
      // Lower case, with a space, as a thumb types it: the field keeps the code.
      await c.page.keyboard.type(`${code.slice(0, 3).toLowerCase()} ${code.slice(3)}`, {
        delay: 60,
      })
      await expect.poll(async () => (await titleMenu(c.page))?.code?.typed).toBe(code)
      expect(await field.inputValue(), 'the field shows what the plate has').toBe(code)
      if (PHOTOS) await c.page.screenshot({ path: `${PHOTOS}/dev632-phone-code-field.png` })
      await c.page.keyboard.press('Enter')
      await expect
        .poll(async () => (await probe(c.page))?.lobby?.heading ?? null, { timeout: 60_000 })
        .toBe('- ROOM -')
      expect((await probe(c.page))?.id).toBe(code)
      await expect(c.page.locator('#room-code-field'), 'the field goes with the plate').toBeHidden()
      await expect.poll(async () => (await invite(c.page))?.label).toBe('Share')
      await expect(c.page.locator('#room-qr'), 'no QR code on a phone').toBeHidden()
      await expect
        .poll(async () => Object.keys((await probe(a.page))?.players ?? {}).length)
        .toBe(3)
      if (PHOTOS) await c.page.screenshot({ path: `${PHOTOS}/dev632-phone-lobby-share.png` })
    } finally {
      for (const br of browsers) await br.close()
    }
  })

  // DEV-633: Matt, 2026-10-04: *"i like your idea of listing public rooms.
  // let's make sure that people have the option to make it public or
  // private."* A room is private until its owner says PUBLIC; then it is a
  // table on the Multiplayer step, pressed to join; PRIVATE takes it off.
  test('DEV-633: a public room is a table on the Multiplayer step; private is never listed', async () => {
    const a = await open(0, 0)
    const browsers: Browser[] = [a.browser]
    try {
      await toHangarDoor(a.page, DOOR_HOST, 400)
      await expect
        .poll(async () => (await probe(a.page))?.lobby?.heading ?? null, { timeout: 60_000 })
        .toBe('- ROOM -')
      const code = (await probe(a.page))?.id as string
      const row = async () => (await probe(a.page))?.lobby?.rows.find((r) => r.id === 'listed')
      await expect.poll(async () => (await row())?.value, 'a new room is private').toBe('private')
      if (PHOTOS) await a.page.screenshot({ path: `${PHOTOS}/dev633-lobby-private.png` })
      expect(await listed(a.page), 'private is never listed').not.toContain(code)
      await pressLobbyRow(a.page, 'listed')
      await expect.poll(async () => (await row())?.value).toBe('public')
      await expect.poll(async () => listed(a.page), { timeout: 15_000 }).toContain(code)
      if (PHOTOS) await a.page.screenshot({ path: `${PHOTOS}/dev633-lobby-public.png` })

      // B: the Multiplayer step stands the room as a table; a press joins it.
      const b = await open(940, 0)
      browsers.push(b.browser)
      await toHangar(b.page)
      await throughMultiplayer(b.page)
      await hangarOn(b.page, 'multiplayer')
      const door = `room-open:${code}`
      await expect.poll(async () => doorIds(b.page), { timeout: 20_000 }).toContain(door)
      if (PHOTOS) await b.page.screenshot({ path: `${PHOTOS}/dev633-open-rooms-step.png` })
      await pressDoor(b.page, door, 400)
      await expect
        .poll(async () => (await probe(b.page))?.lobby?.heading ?? null, { timeout: 60_000 })
        .toBe('- ROOM -')
      expect((await probe(b.page))?.id, 'in the listed room').toBe(code)
      await expect
        .poll(async () => Object.keys((await probe(a.page))?.players ?? {}).length)
        .toBe(2)
      // DEV-634's photographs on a computer: before B is ready, and after.
      if (PHOTOS) await a.page.screenshot({ path: `${PHOTOS}/dev634-before-pc.png` })
      await pressLobbyRow(b.page, 'ready')
      await expect
        .poll(async () => {
          const l = (await probe(a.page))?.lobby
          return l ? l.rows[l.aim]?.id : null
        })
        .toBe('start')
      if (PHOTOS) await a.page.screenshot({ path: `${PHOTOS}/dev634-after-pc.png` })

      // PRIVATE again: off the list.
      await pressLobbyRow(a.page, 'listed')
      await expect.poll(async () => (await row())?.value).toBe('private')
      await expect.poll(async () => listed(a.page), { timeout: 15_000 }).not.toContain(code)
    } finally {
      for (const br of browsers) await br.close()
    }
  })

  // DEV-634: Matt, 2026-10-04: *"i had a hard time finding the button to start
  // the match once everybody was ready."* A phone hosts; a computer joins by
  // code and readies: the owner's START is selected, says so, pulses, and the
  // phone stands a big START that starts the race.
  test('DEV-634: once everyone is ready, START is selected, says so, pulses, and a phone has a big START', async () => {
    const a = await open(0, 0, PHONE)
    const browsers: Browser[] = [a.browser]
    try {
      await toHangarDoor(a.page, DOOR_HOST, 400)
      await expect
        .poll(async () => (await probe(a.page))?.lobby?.heading ?? null, { timeout: 60_000 })
        .toBe('- ROOM -')
      const code = (await probe(a.page))?.id as string
      const b = await open(940, 0)
      browsers.push(b.browser)
      await toHangarDoor(b.page, DOOR_JOIN_CODE, 400)
      await expect.poll(async () => (await titleMenu(b.page))?.code != null).toBe(true)
      await b.page.keyboard.type(code.toLowerCase(), { delay: 60 })
      await hold(b.page, 'Enter', 200, 400)
      await expect
        .poll(async () => (await probe(b.page))?.lobby?.heading ?? null, { timeout: 60_000 })
        .toBe('- ROOM -')
      const start = async () => (await probe(a.page))?.lobby?.rows.find((r) => r.id === 'start')
      await expect.poll(async () => (await start())?.note).toBe('waiting for 1 to be ready')
      await expect(a.page.locator('#room-start'), 'no big START while waiting').toBeHidden()
      if (PHOTOS) await a.page.screenshot({ path: `${PHOTOS}/dev634-before-phone.png` })
      await pressLobbyRow(b.page, 'ready')
      await expect
        .poll(async () => (await start())?.note ?? '', { timeout: 30_000 })
        .toMatch(/^Everyone is ready: press START/)
      const rows = (await probe(a.page))?.lobby?.rows ?? []
      expect((await probe(a.page))?.lobby?.aim, 'START is the selected row').toBe(
        rows.findIndex((r) => r.id === 'start'),
      )
      const button = a.page.locator('#room-start')
      await expect(button, 'the phone stands a big START').toBeVisible()
      const box = await button.boundingBox()
      expect(box?.height ?? 0, 'a thumb-sized target').toBeGreaterThanOrEqual(60)
      if (PHOTOS) await a.page.screenshot({ path: `${PHOTOS}/dev634-after-phone.png` })
      await button.tap()
      await expect
        .poll(async () => (await probe(a.page))?.lobby?.heading ?? null, { timeout: 60_000 })
        .not.toBe('- ROOM -')
    } finally {
      for (const br of browsers) await br.close()
    }
  })
})
