/**
 * Faceted Flight TV, as a spec reads and drives it. DEV-480.
 *
 * `__ff2.tv()` says what TV is showing, which race, which racer the camera is
 * on, and the plate's rows; `__ff2.watch()` says what the watch draws (the
 * ships, their tags). The plate is driven the way a player drives it, the
 * menu button (M since DEV-628; Backspace is back and leaves TV), the arrow keys aimed while reading where the aim
 * IS, and a held Enter, never a click at a measured coordinate.
 */
import { expect, type Page } from '@playwright/test'
import type { Ff2GlobalMaybe } from './ff2'
import { hold } from './hangar'

export interface TvProbe {
  mode: 'off' | 'choosing' | 'live' | 'exhibition'
  tv: string | null
  mission: string | null
  note: string | null
  reads: number
  waiting: string | null
  lapId: string | null
  camera: string | null
  following: string | null
  followingRacer: number | null
  plate: {
    up: boolean
    selected: number
    rows: { id: string; label: string; value: string | null; note: string }[]
  }
  shared: string | null
}

export interface TvShip {
  slot: number
  handle: string
  visible: boolean
}

/**
 * Room `id`'s TV id, as WATCH ME asks for it (`GET /api/room/<code>/tv`,
 * DEV-479's route on the sidecar): minted at first need, the same for the
 * room's life. Asked from node, which sends no Origin (a holder of the code).
 */
export const tvOfRoom = async (proxy: string, id: string): Promise<string> => {
  const r = await fetch(`${proxy}/api/room/${id}/tv`)
  expect(r.status, `room ${id} has a TV id`).toBe(200)
  return ((await r.json()) as { tv: string }).tv
}

/** Every `/api/…` URL the page asks for, as it asks: the viewer's own side of the wire. */
export const recordApi = (
  page: Page,
): { readonly urls: string[]; readonly statuses: Map<string, number> } => {
  const urls: string[] = []
  const statuses = new Map<string, number>()
  page.on('request', (q) => {
    if (new URL(q.url()).pathname.startsWith('/api/')) urls.push(q.url())
  })
  page.on('response', (r) => {
    const path = new URL(r.url()).pathname
    if (path.startsWith('/api/')) statuses.set(path, r.status())
  })
  page.on('websocket', (ws) => {
    urls.push(ws.url())
  })
  return { urls, statuses }
}

export const tvProbe = (page: Page): Promise<TvProbe | null> =>
  page.evaluate(() => {
    const r = (globalThis as unknown as Ff2GlobalMaybe).__ff2?.tv?.()
    return r ? (JSON.parse(JSON.stringify(r)) as TvProbe) : null
  })

/** The watch's ships as drawn: the tags TV shows. */
export const tvShips = (page: Page): Promise<TvShip[]> =>
  page.evaluate(() => {
    const w = (globalThis as unknown as Ff2GlobalMaybe).__ff2?.watch()
    return w ? (JSON.parse(JSON.stringify(w.ships)) as TvShip[]) : []
  })

/** The handles on the ships drawn now, sorted: what a viewer reads on the tags. */
export const visibleTags = async (page: Page): Promise<string[]> =>
  (await tvShips(page))
    .filter((s) => s.visible)
    .map((s) => s.handle)
    .sort()

/** The plate up (the menu button), then row `id` aimed with the arrow keys and pressed. */
export const pressPlateRow = async (page: Page, id: string, settle = 600): Promise<void> => {
  if (!(await tvProbe(page))?.plate.up) {
    await hold(page, 'm', 300)
    await expect
      .poll(async () => (await tvProbe(page))?.plate.up, { message: 'the TV plate is up' })
      .toBe(true)
  }
  for (let i = 0; i < 8; i++) {
    const t = (await tvProbe(page)) as TvProbe
    const want = t.plate.rows.findIndex((r) => r.id === id)
    expect(want, `the TV plate offers ${id}`).toBeGreaterThanOrEqual(0)
    if (t.plate.selected === want) break
    await hold(page, t.plate.selected < want ? 'ArrowDown' : 'ArrowUp', 250)
  }
  const t = (await tvProbe(page)) as TvProbe
  expect(t.plate.rows[t.plate.selected]?.id, `the arrow keys reached ${id}`).toBe(id)
  await hold(page, 'Enter', settle)
}
