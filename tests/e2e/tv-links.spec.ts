/**
 * DEV-480's links in the browser (docs/plan/FF-TV.md §2.6). Matt, 2026-09-30:
 * *"easy to share links to view self, others, or random rooms."* Every link
 * opens TV once the landing card is lifted, as `?watch=` boards then. Pinned:
 *
 *   1. `/?tv`, with two rooms racing, boards one of them (random rooms);
 *   2. `/?tv=<tvId>&follow=2` boards that room and follows Racer 2 (others),
 *      and SHARE THIS VIEW makes that same link back, on the clipboard;
 *   3. a TV id that names no room (it closed) lands on the list's choice and
 *      says so, in one line, rather than spinning.
 *
 * The sidecar answers TV's routes in §3.3's shape (DEV-479's guide, stubbed
 * until it merges: `fixtures/room-sidecar.ts`).
 *
 *   FF2_API_PROXY=http://127.0.0.1:6480 E2E_PORT=5480 npx playwright test tv-links
 */

import { bootReady, switchSettled } from './fixtures/boot'
import { firstPress } from './fixtures/landing'
import { PINNED } from './fixtures/quality-pin'
import { type Crowd, loadLevel, startCrowd } from './fixtures/room-crowd'
import { type RoomSidecar, startRoomSidecar } from './fixtures/room-sidecar'
import { expect, type Page, test } from './fixtures/test'
import { pressPlateRow, recordApi, tvOfRoom, tvProbe, visibleTags } from './fixtures/tv'

const PROXY = process.env.FF2_API_PROXY ?? ''
/** `game/tv/tv-client.ts`'s `TV_NOTE.closed`, whole. */
const CLOSED = 'That room has closed, so here is what is on.'

const roomIdFor = (tag: string): string =>
  `${tag}${Date.now().toString(32)}abcdefghijklmnop`.slice(0, 16).replace(/[^a-z2-7]/g, 'a')

/** Open `query` the way a player opens a link: the page, the card's Start. */
const openLink = async (page: Page, query: string): Promise<void> => {
  page.on('console', (m) => {
    const t = m.text()
    if (/^(tv|watch)/.test(t)) console.log(`[viewer] ${t}`)
  })
  await page.goto(`/?${query}&xr=off&${PINNED}`)
  await bootReady(page, 240_000)
  await firstPress(page)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
}

test.describe('@gpu Faceted Flight TV links (DEV-480)', () => {
  test.skip(
    !PROXY,
    'set FF2_API_PROXY=http://127.0.0.1:<port> so Vite forwards /api to the room sidecar',
  )
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(360_000)

  let sidecar: RoomSidecar
  let crowds: Crowd[] = []
  const level = loadLevel('int_01_hoverJet')
  /** Two rooms, racing: their ids. */
  const twoRacing = async (): Promise<[string, string]> => {
    const ids: [string, string] = [roomIdFor('la'), roomIdFor('lb')]
    for (const id of ids) {
      const c = await startCrowd({
        url: `${PROXY.replace(/^http/, 'ws')}/api/room/${id}`,
        level,
        count: 2,
        players: 2,
      })
      crowds.push(c)
      await expect.poll(() => c.goAt(), { timeout: 60_000 }).not.toBeNull()
    }
    return ids
  }

  test.beforeAll(async () => {
    test.setTimeout(360_000)
    sidecar = await startRoomSidecar(Number(new URL(PROXY).port))
    const answer = await fetch(`${PROXY}/api/room-sidecar`).then((r) => r.text())
    expect(answer, 'a stale sidecar is answering on this port').toBe(sidecar.nonce)
  })
  test.afterEach(() => {
    for (const c of crowds) c.stop()
    crowds = []
  })
  test.afterAll(async () => {
    await sidecar?.close()
  })

  test('/?tv with two rooms racing boards one of them', async ({ page }) => {
    const [a, b] = await twoRacing()
    await openLink(page, 'tv')
    await expect
      .poll(async () => (await tvProbe(page))?.mode ?? null, { timeout: 30_000 })
      .toBe('live')
    expect([await tvOfRoom(PROXY, a), await tvOfRoom(PROXY, b)]).toContain(
      (await tvProbe(page))?.tv,
    )
  })

  test('/?tv=<id>&follow=2 follows Racer 2, and Share This View makes that link', async ({
    page,
    context,
    baseURL,
  }) => {
    const [a] = await twoRacing()
    const tv = await tvOfRoom(PROXY, a)
    await context.grantPermissions(
      ['clipboard-read', 'clipboard-write'],
      baseURL ? { origin: baseURL } : {},
    )
    await openLink(page, `tv=${tv}&follow=2`)
    await expect.poll(async () => (await tvProbe(page))?.tv ?? null, { timeout: 30_000 }).toBe(tv)
    await expect
      .poll(async () => await visibleTags(page), { timeout: 120_000 })
      .toEqual(['Racer 1', 'Racer 2'])
    // The ships exist before the course is built, and DEV-481's camera is built
    // only on the course's terrain (`tv-watch-camera.ts`'s `rebuild`): until
    // then `__ff2.tv()` reads no camera at all. So: aboard first, then follow.
    await switchSettled(page, 180_000)
    await expect
      .poll(
        async () => {
          const t = await tvProbe(page)
          return t ? `${t.camera} ${t.followingRacer} ${t.following}` : null
        },
        { timeout: 30_000 },
      )
      .toBe('follow 2 Racer 2')
    // ── SHARE THIS VIEW: the same link back, short form, on the clipboard ──
    await pressPlateRow(page, 'tv-share')
    const host = new URL(page.url()).host
    await expect.poll(async () => (await tvProbe(page))?.shared).toBe(`${host}/tv/${tv}?follow=2`)
    await expect
      .poll(async () => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(`https://${host}/tv/${tv}?follow=2`)
  })

  test('a stale TV id lands on the list’s choice, and says so', async ({ page }) => {
    await twoRacing()
    const stale = 'tv_aaaaaaaaaaaaaaaa'
    const api = recordApi(page)
    await openLink(page, `tv=${stale}`)
    await expect
      .poll(async () => (await tvProbe(page))?.note ?? null, { timeout: 30_000 })
      .toBe(CLOSED)
    await expect
      .poll(async () => (await tvProbe(page))?.mode ?? null, { timeout: 30_000 })
      .toBe('live')
    // A race the list offers: these two, or an earlier test's still on.
    const listed = ((await (await fetch(`${PROXY}/api/tv`)).json()) as { races: { tv: string }[] })
      .races
    expect(listed.map((r) => r.tv)).toContain((await tvProbe(page))?.tv)
    expect((await tvProbe(page))?.tv).not.toBe(stale)
    // The stale id's diagnosis GET was answered 404, before any upgrade (§2.2).
    expect(api.statuses.get(`/api/tv/${stale}`)).toBe(404)
  })
})
