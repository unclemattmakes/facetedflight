// tests/unit/tv-routes.test.ts — Faceted Flight TV's doors. DEV-479.
//
// The Pages Functions TV adds, called as Pages calls them, over a FAKE
// `ROOMS` namespace that routes by name to the REAL objects: the guide
// (`TvGuide` behind `answerTvGuide`), rooms (`RoomServer` behind
// `answerRoomLink`), and broadcasters, which only record what reached them.
// plan/FF-TV.md §2.2, §2.6, §3.3, §3.6:
//
//   - `GET /api/tv` carries no room id, caches ten seconds, 503s unbound;
//   - `wss /api/tv/<tvId>` 404s an unknown id BEFORE any upgrade reaches
//     anything, and forwards a known one to `watch.<room>` on `TV_WATCH_PATH`;
//   - `GET /api/room/<code>/tv` (WATCH ME) 404s for no room, refuses a foreign
//     page, and is never cached;
//   - `/tv`, `/tv/<id>`, `/tv/<id>?follow=2`, `/tv/lap/<id>` 302 to the query forms;
//   - off-air (behind ADMIN_TOKEN, logged) drops an id from the list and refuses its upgrade;
//   - `TV_WATCH_PATH` is reached by no public route but that one forward.

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { ADMIN_TOKEN_MIN_LENGTH } from '@/net/lap-policy'
import { type D1Database, type D1PreparedStatement, ID_SHAPE } from '@/net/lap-server'
import type { PagesFunction } from '@/net/pages-function'
import { answerRoomLink } from '@/net/room-link'
import { admitRoomUpgrade, admitWatchUpgrade, ROOM_PROTOCOL, watchName } from '@/net/room-protocol'
import { PARTYKIT_ROOM_HEADER, type RoomNamespace, TV_LAP_ID_SHAPE } from '@/net/room-route'
import { answerTvGuide, TvGuide } from '@/net/tv-guide'
import { mintTvId, TV_GUIDE_NAME, TV_WATCH_PATH } from '@/net/tv-protocol'
import {
  onRequestDelete as adminDelete,
  onRequestPost as adminPost,
} from '../../functions/api/admin/tv'
import { onRequest as roomRoute } from '../../functions/api/room/[id]'
import { onRequestGet as lapGet, onRequestPost as lapPost } from '../../functions/api/room/[id]/lap'
import { onRequest as roomTv } from '../../functions/api/room/[id]/tv'
import { onRequest as tvWatch } from '../../functions/api/tv/[id]'
import { onRequest as tvList } from '../../functions/api/tv/index'
import { onRequest as watchRoute } from '../../functions/api/watch/[id]'
import { onRequest as shortDeep } from '../../functions/tv/[[path]]'
import { onRequest as shortBare } from '../../functions/tv/index'
import { FakeRoom } from './helpers/fake-room'
import { REPO as ROOT } from './helpers/repo-root'

const SITE = 'https://main.ff-10yr.pages.dev'
const ROOM = 'abcdefghij234567'
const TOKEN = 't'.repeat(ADMIN_TOKEN_MIN_LENGTH)

/** What reached a broadcaster: its name, the URL and the headers it was handed. */
interface Reached {
  name: string
  url: string
  headers: Headers
  upgrade: boolean
}

/**
 * A `ROOMS` namespace over the real guide and real rooms. Broadcasters record
 * and answer with a marker; a room answers its internal API, and records any
 * upgrade. Everything any object was asked is in `reached`.
 */
const platform = async () => {
  const now = { t: 9_000_000 }
  const stored = new Map<string, unknown>()
  const guide = await TvGuide.load({
    now: () => now.t,
    storage: {
      get: async <T>(k: string) => structuredClone(stored.get(k)) as T | undefined,
      put: async <T>(k: string, v: T) => {
        stored.set(k, structuredClone(v))
      },
      delete: async (k: string) => stored.delete(k),
    },
    setAlarm: async () => {},
  })
  const rooms = new Map<string, FakeRoom>()
  const reached: Reached[] = []
  const ns: RoomNamespace = {
    idFromName: (name) => ({ name }),
    get: (id) => ({
      fetch: async (request) => {
        const name = (id as unknown as { name: string }).name
        const upgrade = request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
        reached.push({ name, url: request.url, headers: new Headers(request.headers), upgrade })
        expect(request.headers.get(PARTYKIT_ROOM_HEADER)).toBe(name)
        if (name === TV_GUIDE_NAME) return answerTvGuide(guide, request)
        if (name.startsWith(watchName('')))
          return new Response('to the broadcaster', { status: 200 })
        const room = rooms.get(name)
        if (upgrade || !room) return new Response('to the room', { status: 200 })
        return answerRoomLink(room.server, request)
      },
    }),
  }
  /** A room in use, with one player in its lobby. */
  const roomInUse = async (id = ROOM) => {
    const room = await FakeRoom.open()
    const c = await room.connect('p0')
    await room.send(c, {
      type: 'join',
      protocol: ROOM_PROTOCOL,
      handle: 'Swift Kestrel 42',
      variant: 'standard',
      colour: 0,
      content: 'ab12cd34ef56ab12',
    })
    rooms.set(id, room)
    return room
  }
  return { now, guide, rooms, reached, env: { ROOMS: ns }, roomInUse }
}

const call = async <P extends string>(
  fn: PagesFunction<never, P> | PagesFunction<never>,
  request: Request,
  env: unknown,
  params: Record<string, string> = {},
): Promise<Response> =>
  (fn as PagesFunction<unknown, string>)({
    request,
    env,
    params,
    waitUntil: () => {},
    next: async () => new Response(null, { status: 404 }),
  })

const upgrade = (url: string, origin: string | null = SITE): Request => {
  const headers = new Headers({ Upgrade: 'websocket', Connection: 'Upgrade' })
  if (origin !== null) headers.set('Origin', origin)
  return new Request(url, { headers })
}

/** Put a room on the guide, racing, under a fresh TV id; return the id. */
let minted = 0
const onAir = async (p: Awaited<ReturnType<typeof platform>>, room = ROOM): Promise<string> => {
  const tv = mintTvId((b) => {
    b.fill(7)
    b[0] = ++minted
  })
  await p.guide.announce({
    tv,
    room,
    mission: 'int_01_hoverJet',
    phase: 'racing',
    racers: 6,
    goAt: p.now.t - 1000,
    until: p.now.t + 600_000,
    at: p.now.t,
  })
  return tv
}

describe('GET /api/tv: the list (§3.3)', () => {
  it('lists the races with no room id, cached ten seconds', async () => {
    const p = await platform()
    const tv = await onAir(p)
    const r = await call(tvList, new Request(`${SITE}/api/tv`), p.env)
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('public, max-age=10')
    const text = await r.text()
    expect(text).not.toContain(ROOM)
    expect(JSON.parse(text)).toEqual({
      races: [
        { tv, mission: 'int_01_hoverJet', phase: 'racing', racers: 6, since: p.now.t - 1000 },
      ],
      lobbies: 0,
    })
  })

  it('answers 503 where ROOMS is unbound, and 405 to anything but GET', async () => {
    const p = await platform()
    expect((await call(tvList, new Request(`${SITE}/api/tv`), {})).status).toBe(503)
    const post = await call(tvList, new Request(`${SITE}/api/tv`, { method: 'POST' }), p.env)
    expect(post.status).toBe(405)
  })
})

describe('wss /api/tv/<tvId>: a TV viewer’s socket (§2.2)', () => {
  it('forwards a known id to the room’s broadcaster on TV_WATCH_PATH, and nothing in the answer names the room', async () => {
    const p = await platform()
    const tv = await onAir(p)
    const r = await call(tvWatch, upgrade(`${SITE}/api/tv/${tv}?_pk=chosen`), p.env, { id: tv })
    expect(await r.text()).toBe('to the broadcaster')
    const hit = p.reached.filter((x) => x.upgrade)
    expect(hit).toHaveLength(1)
    expect(hit[0]?.name).toBe(watchName(ROOM))
    const url = new URL(hit[0]?.url as string)
    expect(url.pathname).toBe(TV_WATCH_PATH)
    expect(url.search).toBe('')
    for (const [k, v] of r.headers) expect(`${k}: ${v}`).not.toContain(ROOM)
  })

  it('404s an unknown id BEFORE any upgrade reaches anything — and so does its diagnosis GET', async () => {
    const p = await platform()
    const unknown = 'tv_abcdefghijklmnop'
    for (const req of [
      upgrade(`${SITE}/api/tv/${unknown}`),
      new Request(`${SITE}/api/tv/${unknown}`),
    ]) {
      const r = await call(tvWatch, req, p.env, { id: unknown })
      expect(r.status).toBe(404)
    }
    // RED against a route that forwards first and asks after: the broadcaster would hear it.
    expect(p.reached.filter((x) => x.name !== TV_GUIDE_NAME)).toEqual([])
    // A malformed id never reaches the guide either.
    p.reached.length = 0
    expect((await call(tvWatch, upgrade(`${SITE}/api/tv/${ROOM}`), p.env)).status).toBe(404)
    expect(p.reached).toEqual([])
  })

  it('refuses a known id’s plain GET 426, and a foreign or missing Origin 403, forwarding nothing', async () => {
    const p = await platform()
    const tv = await onAir(p)
    expect((await call(tvWatch, new Request(`${SITE}/api/tv/${tv}`), p.env)).status).toBe(426)
    expect(
      (await call(tvWatch, upgrade(`${SITE}/api/tv/${tv}`, 'https://evil.example'), p.env)).status,
    ).toBe(403)
    expect((await call(tvWatch, upgrade(`${SITE}/api/tv/${tv}`, null), p.env)).status).toBe(403)
    expect(p.reached.filter((x) => x.upgrade)).toEqual([])
  })

  it('answers 503 where ROOMS is unbound', async () => {
    const r = await call(tvWatch, upgrade(`${SITE}/api/tv/tv_abcdefghijklmnop`), {})
    expect(r.status).toBe(503)
  })
})

describe('GET /api/room/<code>/tv: WATCH ME (§2.6)', () => {
  const get = (code: string, headers: Record<string, string> = {}) =>
    new Request(`${SITE}/api/room/${code}/tv`, { headers })

  it('answers the room’s TV id to its own page, never cached, the same id each time', async () => {
    const p = await platform()
    const room = await p.roomInUse()
    const r = await call(roomTv, get(ROOM, { 'Sec-Fetch-Site': 'same-origin' }), p.env, {
      id: ROOM,
    })
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('no-store')
    const { tv } = (await r.json()) as { tv: string }
    expect(tv).toBe(room.server.tv)
    const again = await call(roomTv, get(ROOM, { Origin: SITE }), p.env, { id: ROOM })
    expect(((await again.json()) as { tv: string }).tv).toBe(tv)
  })

  it('404s for a code nobody is in, minting nothing', async () => {
    const p = await platform()
    const empty = await FakeRoom.open()
    p.rooms.set(ROOM, empty)
    const r = await call(roomTv, get(ROOM), p.env, { id: ROOM })
    expect(r.status).toBe(404)
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(empty.server.tv).toBeNull()
    // A TV id is no room's code: 404 at the door.
    const tvShaped = await call(roomTv, get('tv_abcdefghijklmnop'), p.env, {
      id: 'tv_abcdefghijklmnop',
    })
    expect(tvShaped.status).toBe(404)
  })

  it('refuses a foreign page, by its Origin or its Sec-Fetch-Site, before the room is asked', async () => {
    const p = await platform()
    const room = await p.roomInUse()
    for (const headers of [
      { Origin: 'https://evil.example' },
      { 'Sec-Fetch-Site': 'cross-site' },
      { 'Sec-Fetch-Site': 'same-site' },
    ]) {
      const r = await call(roomTv, get(ROOM, headers), p.env, { id: ROOM })
      // RED against a route with no origin check.
      expect(r.status, JSON.stringify(headers)).toBe(403)
    }
    expect(room.server.tv).toBeNull()
    expect(p.reached).toEqual([])
  })

  it('answers 503 where ROOMS is unbound', async () => {
    const r = await call(roomTv, get(ROOM), {}, { id: ROOM })
    expect(r.status).toBe(503)
  })
})

describe('the short links (§2.6)', () => {
  const tv = 'tv_abcdefghijklmnop'
  const to = async (pathAndQuery: string) => {
    const req = new Request(`${SITE}${pathAndQuery}`)
    const fn = pathAndQuery.split('?')[0]?.replace(/\/$/, '') === '/tv' ? shortBare : shortDeep
    const r = await call(fn, req, {})
    expect(r.status).toBe(302)
    return r.headers.get('location')
  }

  it('302s /tv, /tv/<id>, /tv/<id>?follow=2 and /tv/lap/<id> to the query forms', async () => {
    expect(await to('/tv')).toBe('/?tv')
    expect(await to('/tv/')).toBe('/?tv')
    expect(await to(`/tv/${tv}`)).toBe(`/?tv=${tv}`)
    expect(await to(`/tv/${tv}?follow=2`)).toBe(`/?tv=${tv}&follow=2`)
    expect(await to('/tv/lap/LaPoNe0001')).toBe('/?tv=lap:LaPoNe0001')
  })

  it('drops a follow that is not Racer 1–16, and anything else in the query', async () => {
    for (const f of ['0', '17', '2x', '-1', '']) {
      expect(await to(`/tv/${tv}?follow=${f}`)).toBe(`/?tv=${tv}`)
    }
    expect(await to(`/tv/${tv}?follow=3&room=${ROOM}`)).toBe(`/?tv=${tv}&follow=3`)
  })

  it('lands anything else on TV’s own choice — a room’s code above all, which a TV link never carries', async () => {
    for (const p of [`/tv/${ROOM}`, '/tv/K7QX4M2', '/tv/lap/short', `/tv/${tv}/more`, '/tv/lap']) {
      expect(await to(p), p).toBe('/?tv')
    }
  })

  it('reads a lap id as the lap server writes one', () => {
    expect(TV_LAP_ID_SHAPE.source).toBe(ID_SHAPE.source)
  })
})

/** D1 over `node:sqlite` with both migrations, as `lap-admin.test.ts` binds it. */
const d1 = (db: DatabaseSync): D1Database => {
  const statement = (sql: string, params: unknown[] = []): D1PreparedStatement => ({
    bind: (...values) => statement(sql, values),
    first: async <T>() => (db.prepare(sql).get(...(params as never[])) as T | undefined) ?? null,
    all: async <T>() => ({
      results: db.prepare(sql).all(...(params as never[])) as T[],
      success: true,
    }),
    run: async () => {
      const r = db.prepare(sql).run(...(params as never[]))
      return { results: [], success: true, meta: { changes: Number(r.changes) } }
    },
  })
  return {
    prepare: (sql) => statement(sql),
    batch: async (statements) => {
      const out = []
      for (const s of statements) out.push(await s.run())
      return out
    },
  }
}

describe('off the air (§3.6): behind ADMIN_TOKEN, logged', () => {
  const migrated = () => {
    const db = new DatabaseSync(':memory:')
    for (const m of ['0001_laps.sql', '0002_moderation.sql']) {
      db.exec(fs.readFileSync(path.join(ROOT, 'migrations', m), 'utf8'))
    }
    return db
  }
  const admin = (method: string, url: string, body?: unknown, token: string | null = TOKEN) =>
    new Request(`${SITE}${url}`, {
      method,
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

  it('drops an id from the list and refuses its upgrade, logs it, and puts it back', async () => {
    const p = await platform()
    const db = migrated()
    const env = { ...p.env, LAPS_DB: d1(db), ADMIN_TOKEN: TOKEN }
    const tv = await onAir(p)
    const off = await call(adminPost, admin('POST', '/api/admin/tv', { tv, reason: 'test' }), env)
    expect(off.status).toBe(200)
    // RED against a guide that keeps no off-air set.
    const list = (await (await call(tvList, new Request(`${SITE}/api/tv`), env)).json()) as {
      races: unknown[]
    }
    expect(list.races).toEqual([])
    expect((await call(tvWatch, upgrade(`${SITE}/api/tv/${tv}`), env)).status).toBe(404)
    const log = db.prepare('SELECT action, target, reason FROM admin_log ORDER BY id').all()
    expect(log).toEqual([{ action: 'off-air', target: `tv:${tv}`, reason: 'test' }])

    const on = await call(adminDelete, admin('DELETE', `/api/admin/tv?tv=${tv}`), env)
    expect(on.status).toBe(200)
    expect((await call(tvWatch, upgrade(`${SITE}/api/tv/${tv}`), env)).status).toBe(200)
    expect(db.prepare('SELECT COUNT(*) AS n FROM admin_log').get()).toEqual({ n: 2 })
  })

  it('goes dark until a time, logged, and refuses without the token before touching the guide', async () => {
    const p = await platform()
    const db = migrated()
    const env = { ...p.env, LAPS_DB: d1(db), ADMIN_TOKEN: TOKEN }
    const tv = await onAir(p)
    const denied = await call(adminPost, admin('POST', '/api/admin/tv', { tv }, null), env)
    expect(denied.status).toBe(401)
    expect(p.guide.resolve(tv)).toBe(ROOM)
    const dark = await call(
      adminPost,
      admin('POST', '/api/admin/tv', { until: p.now.t + 60_000 }),
      env,
    )
    expect(dark.status).toBe(200)
    expect(p.guide.list().races).toEqual([])
    expect(db.prepare('SELECT action, target FROM admin_log').all()).toEqual([
      { action: 'off-air', target: 'tv:all' },
    ])
  })
})

describe('TV_WATCH_PATH: no public route reaches it but the TV forward (§2.2)', () => {
  it('the Worker’s own gates refuse it (what its `fetch` runs before forwarding anything)', () => {
    for (const url of [`${SITE}${TV_WATCH_PATH}`, `https://rooms.workers.dev${TV_WATCH_PATH}`]) {
      expect(admitRoomUpgrade(upgrade(url), '.*')).toMatchObject({ ok: false, status: 404 })
      expect(admitWatchUpgrade(upgrade(url), '.*')).toMatchObject({ ok: false, status: 404 })
    }
  })

  it('no Function forwards a request onto it, whatever path or id it is handed', async () => {
    const p = await platform()
    await p.roomInUse()
    const tv = await onAir(p)
    const tries = [
      TV_WATCH_PATH,
      `/api/watch/${ROOM}/../..${TV_WATCH_PATH}`,
      `/api/room/${ROOM}/../..${TV_WATCH_PATH}`,
      `/api/watch/${encodeURIComponent(`${ROOM}${TV_WATCH_PATH}`)}`,
      `/api/room/${encodeURIComponent(`..${TV_WATCH_PATH}`)}`,
      `/api/room/${ROOM}`,
      `/api/watch/${ROOM}`,
      `/api/room/${ROOM}/tv`,
      `/api/room/${ROOM}/lap?slot=0`,
    ]
    const handlers: [string, PagesFunction<never, string>][] = [
      ['room', roomRoute as never],
      ['watch', watchRoute as never],
      ['room tv', roomTv as never],
      ['lap GET', lapGet as never],
      ['lap POST', lapPost as never],
      ['tv list', tvList as never],
      ['short', shortDeep as never],
    ]
    for (const t of tries) {
      for (const [name, fn] of handlers) {
        for (const req of [upgrade(`${SITE}${t}`), new Request(`${SITE}${t}`)]) {
          const id = t.split('/')[3]
          await call(fn, req, p.env, id === undefined ? {} : { id: decodeURIComponent(id) })
          const onPath = p.reached.filter((x) => new URL(x.url).pathname === TV_WATCH_PATH)
          expect(onPath, `${name} ${t}`).toEqual([])
        }
      }
    }
    // The one door that does, for a resolved id, from the game's own page.
    await call(tvWatch, upgrade(`${SITE}/api/tv/${tv}`), p.env, { id: tv })
    expect(p.reached.filter((x) => new URL(x.url).pathname === TV_WATCH_PATH)).toHaveLength(1)
  })
})
