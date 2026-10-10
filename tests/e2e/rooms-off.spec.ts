/**
 * DEV-470's gate in the browser: a site with no rooms bound.
 *
 * A release build offers rooms since D36, and production answers every room
 * path `503 rooms are not configured here` until its rooms Worker and `ROOMS`
 * binding exist (docs/rooms.md § Releasing rooms). Every door into a room,
 * driven the way a player drives it, must then say so in plain words, quickly,
 * and leave the player somewhere they can go on from:
 *
 *   1. HOST A RACE: the lobby by the chair says ROOM CLOSED, and its one row,
 *      Leave, says why; Leave is the hangar, on your own.
 *   2. JOIN WITH A CODE: the letter plate's footer says why, in the hangar
 *      (DEV-558: Multiplayer's step), the code left there.
 *   3. A ROOM LINK (`?room=`): the title's START says why (DEV-558; Join Room
 *      until then), and so do the hangar's MULTIPLAYER and JOIN ROOM tables.
 *   4. A WATCH LINK (`?watch=`): the title's START says why, and so does the
 *      hangar's MULTIPLAYER table; the viewer's socket is closed, not retrying.
 *
 * Each within `SAID_MS` of the press or the load. Before DEV-470 the game's
 * diagnosis of a failed handshake — a plain GET of the same path — read 426
 * ("the site is fine") there, so 1–3 retried for 30 s and ended "The room
 * could not be reached.", and 4 retried every four seconds for ever, silently.
 *
 * The site is `fixtures/rooms-off-sidecar.ts`: the REAL Pages Function
 * handlers with no `ROOMS`, reached through Vite's `/api` proxy. Run with:
 *
 *   FF2_API_PROXY=http://127.0.0.1:5399 E2E_PORT=5470 npx playwright test rooms-off
 *
 * Without `FF2_API_PROXY` the dev server has no `/api` and this skips, saying so.
 */

import { ROOM_PAGE_STORE } from '@/game/room-client'
import { bootReady } from './fixtures/boot'
import type { Ff2GlobalMaybe } from './fixtures/ff2'
import {
  DOOR_HOST,
  DOOR_JOIN_CODE,
  hangarAim,
  hold,
  lookUntilAimed,
  pressDoor,
} from './fixtures/hangar'
import { firstPress } from './fixtures/landing'
import { PINNED } from './fixtures/quality-pin'
import { type RoomsOffSidecar, startRoomsOffSidecar } from './fixtures/rooms-off-sidecar'
import { expect, type Page, test } from './fixtures/test'
import {
  TITLE_ROW,
  throughMultiplayer,
  titleMenu,
  titleRowsUp,
  toHangar,
  toHangarDoor,
} from './fixtures/title'

const PROXY = process.env.FF2_API_PROXY ?? ''
/** What the player is told (`game/room-client.ts`'s `ROOM_OFF`; the unit tests pin it whole). */
const OFF = /^Online races aren't open yet: fly solo\.$/
/** Plain and QUICK: a diagnosis is one GET, well inside the 30 s the old path spun. */
const SAID_MS = 8000
/** A code nobody will ever have hosted on this site: there is no site to host it on. */
const CODE = 'K7QX4M2'

interface Room {
  status: string
  notice: string | null
  lobby: { heading: string; rows: { id: string; note: string }[] } | null
}
interface Watch {
  status: string
  notice: string | null
}

const room = (page: Page): Promise<Room | null> =>
  page.evaluate(() => {
    const r = (globalThis as unknown as Ff2GlobalMaybe).__ff2?.room() as
      | Record<string, unknown>
      | null
      | undefined
    if (!r) return null
    return { status: r.status, notice: r.notice, lobby: r.lobby } as Room
  })

const watch = (page: Page): Promise<Watch | null> =>
  page.evaluate(() => {
    const w = (globalThis as unknown as Ff2GlobalMaybe).__ff2?.watch() as
      | Record<string, unknown>
      | null
      | undefined
    return w ? ({ status: w.status, notice: w.notice } as Watch) : null
  })

/** Boot the title the way a player does: the page, the card's Start, the rows. */
const openTitle = async (page: Page, query = ''): Promise<void> => {
  await page.goto(`/?${query}${query ? '&' : ''}xr=off&${PINNED}`)
  await bootReady(page, 240_000)
  await firstPress(page)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await titleRowsUp(page)
}

test.describe('@gpu a site with no rooms bound (DEV-470)', () => {
  test.skip(
    !PROXY,
    'set FF2_API_PROXY=http://127.0.0.1:<port> so Vite forwards /api to the rooms-off sidecar',
  )
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(300_000)

  let site: RoomsOffSidecar
  test.beforeAll(async () => {
    site = await startRoomsOffSidecar(Number(new URL(PROXY).port))
    const answer = await fetch(`${PROXY}/api/room-sidecar`).then((r) => r.text())
    expect(answer, 'a stale sidecar is answering on this port').toBe(site.nonce)
  })
  test.afterAll(async () => {
    await site?.close()
  })

  test('HOST A RACE: the lobby says why at once, and Leave is the hangar', async ({ page }) => {
    await openTitle(page)
    // DEV-542: the tab's code is made at the first JOIN, not at the load — a
    // player on the title has none; HOST A RACE is a join, and makes it.
    const tabCode = () =>
      page.evaluate((key) => globalThis.sessionStorage.getItem(key), ROOM_PAGE_STORE)
    expect(await tabCode(), 'no tab code before any join').toBeNull()
    // The walk to the door is the hangar's, not the room's: aim as a player does, then time
    // from the confirm press itself.
    await toHangar(page)
    await throughMultiplayer(page)
    expect(await lookUntilAimed(page, DOOR_HOST), 'found the HOST A RACE table').toBe(true)
    const pressed = Date.now()
    await hold(page, 'Enter', 300)
    await expect
      .poll(async () => (await room(page))?.lobby?.heading ?? null, { timeout: SAID_MS })
      .toBe('- ROOM CLOSED -')
    const r = (await room(page)) as Room
    expect(Date.now() - pressed, 'said within the bound').toBeLessThan(SAID_MS + 1000)
    expect(r.status).toBe('closed')
    expect(r.notice).toMatch(OFF)
    expect(r.lobby?.rows.map((x) => x.id)).toEqual(['leave'])
    expect(r.lobby?.rows[0]?.note).toMatch(OFF)
    expect(await tabCode(), 'the join made the tab code').toMatch(/^[A-Za-z0-9_-]{22}$/)
    // The site was asked twice, and said the same thing both times: the
    // handshake, and the diagnosis GET.
    const asked = site.requests.filter((q) => q.path.startsWith('/api/room/'))
    expect(asked.some((q) => q.upgrade && q.status === 503)).toBe(true)
    expect(asked.some((q) => !q.upgrade && q.method === 'GET' && q.status === 503)).toBe(true)
    // Recoverable: Leave, and the hangar is yours.
    await hold(page, 'Enter', 600)
    await expect.poll(async () => await room(page)).toBeNull()
    expect(await page.evaluate(() => document.body.dataset.room)).toBe('left')
  })

  test('JOIN WITH A CODE: the letter plate says why, in the hangar', async ({ page }) => {
    await openTitle(page)
    await toHangarDoor(page, DOOR_JOIN_CODE, 400)
    await expect.poll(async () => (await titleMenu(page))?.code !== null).toBe(true)
    await page.keyboard.type(CODE.toLowerCase(), { delay: 60 })
    await expect.poll(async () => (await titleMenu(page))?.code?.typed).toBe(CODE)
    const pressed = Date.now()
    await hold(page, 'Enter', 200)
    await expect
      .poll(async () => (await titleMenu(page))?.code?.footer ?? '', { timeout: SAID_MS })
      .toMatch(OFF)
    expect(Date.now() - pressed).toBeLessThan(SAID_MS + 1000)
    const m = await titleMenu(page)
    expect((await hangarAim(page))?.view, 'still on the Multiplayer step').toBe('multiplayer')
    expect(m?.code?.typed, 'the code left to correct').toBe(CODE)
    expect(await room(page), 'and in no room').toBeNull()
  })

  /** The door tables on the hangar's step that is up, with their notes (DEV-558). */
  const doorNotes = (page: Page): Promise<Record<string, string>> =>
    page.evaluate(() => {
      const doors = (globalThis as unknown as Ff2GlobalMaybe).__ff2?.hangarAim?.()?.doors ?? []
      return Object.fromEntries(doors.map((d) => [d.id, d.note]))
    })

  test('A ROOM LINK: START, and the Multiplayer and Join Room tables, say why', async ({
    page,
  }) => {
    const loaded = Date.now()
    await openTitle(page, `room=${CODE}`)
    // DEV-558: the title is START and ENTER VR; START's note is the reason
    // (the link's room was joined at boot, and closed).
    await expect
      .poll(
        async () => {
          const m = await titleMenu(page)
          return m ? (m.notes[m.rows.indexOf(TITLE_ROW.hangar)] ?? '') : ''
        },
        { timeout: SAID_MS },
      )
      .toMatch(OFF)
    expect((await room(page))?.status).toBe('closed')
    // In the hangar, the Multiplayer table says it too, and so does Join Room.
    await toHangar(page)
    expect((await doorNotes(page)).multiplayer).toMatch(OFF)
    await pressDoor(page, 'multiplayer')
    await expect.poll(async () => (await hangarAim(page))?.view).toBe('multiplayer')
    expect((await doorNotes(page))['room-join']).toMatch(OFF)
    console.log(`room link: said ${Date.now() - loaded} ms after the load began`)
  })

  test('A WATCH LINK: START says why, and so does the Multiplayer table', async ({ page }) => {
    await openTitle(page, `watch=${CODE}`)
    await expect
      .poll(async () => (await watch(page))?.status ?? null, { timeout: SAID_MS })
      .toBe('closed')
    expect((await watch(page))?.notice).toMatch(OFF)
    await expect
      .poll(async () => {
        const m = await titleMenu(page)
        return m ? (m.notes[m.rows.indexOf(TITLE_ROW.hangar)] ?? '') : ''
      })
      .toMatch(OFF)
    // Closed, not retrying: no handshake after the one the diagnosis ended.
    const handshakes = () =>
      site.requests.filter((q) => q.upgrade && q.path.startsWith(`/api/watch/${CODE}`)).length
    const before = handshakes()
    await page.waitForTimeout(6000)
    expect(handshakes(), 'no retry after the site said it has no rooms').toBe(before)
    await toHangar(page)
    expect((await doorNotes(page)).multiplayer).toMatch(OFF)
  })

  // DEV-480: Faceted Flight TV on a site with no rooms. Its list route
  // answers 503 there (DEV-479's `routeToTvList`, served by this fixture), and
  // TV shows the exhibition, the AI racers, at once, and asks no more.
  test('A TV LINK: /?tv is the exhibition within seconds', async ({ page }) => {
    const loaded = Date.now()
    // Not `openTitle`: TV boards as the card lifts, so the rows may never be up.
    await page.goto(`/?tv&xr=off&${PINNED}`)
    await bootReady(page, 240_000)
    // DEV-872: the splash skip IS the link's first press, so no title is offered; wait for
    // the gesture as `tv-camera.spec.ts`'s `boardedByLink` does.
    await expect(page.locator('body')).toHaveAttribute('data-first-input', 'true', {
      timeout: 60_000,
    })
    await expect
      .poll(
        async () =>
          page.evaluate(
            () => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.tv?.()?.mode ?? null,
          ),
        { timeout: SAID_MS },
      )
      .toBe('exhibition')
    console.log(`tv link: the exhibition ${Date.now() - loaded} ms after the load began`)
    const asked = () => site.requests.filter((q) => q.path.startsWith('/api/tv'))
    expect(asked().map((q) => q.status)).toEqual([503])
    await page.waitForTimeout(6000)
    expect(asked().length, 'a site with no rooms is asked once, never again').toBe(1)
  })
})
