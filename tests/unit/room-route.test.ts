// The hand-off from the game's origin to a room (plan/MULTIPLAYER.md §6.2,
// DEV-386): `functions/api/room/[id].ts` over `src/net/room-route.ts`, and the
// admission both routes share. The Origin check is the whole of a WebSocket's
// cross-site protection, so it is tested against the REAL allowlists in
// `workers/rooms/wrangler.jsonc`, not against a copy of them.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  admitRoomUpgrade,
  originAdmitted,
  parseClientMessage,
  ROOM_PROTOCOL,
  roomIdFromPath,
} from '@/net/room-protocol'
import {
  PARTYKIT_ROOM_HEADER,
  type RoomNamespace,
  routeToRoom,
  routeToWatch,
} from '@/net/room-route'
import { onRequest } from '../../functions/api/room/[id]'
import { REPO as ROOT } from './helpers/repo-root'

const SITE = 'https://main.ff-10yr.pages.dev'
const ID = 'abcdefghij234567'

const upgrade = (url: string, origin: string | null = SITE): Request => {
  const headers = new Headers({ Upgrade: 'websocket', Connection: 'Upgrade' })
  if (origin !== null) headers.set('Origin', origin)
  return new Request(url, { headers })
}

/** A namespace that records what reached it and answers 101-ish with a marker. */
const fakeRooms = () => {
  const seen: { name: string | null; request: Request | null } = { name: null, request: null }
  const ns: RoomNamespace = {
    idFromName: (name) => {
      seen.name = name
      return { name }
    },
    get: () => ({
      fetch: async (request) => {
        seen.request = request
        return new Response('to the room', { status: 200 })
      },
    }),
  }
  return { ns, seen }
}

/** The Worker's two `ROOM_ORIGINS`, read out of its config as deployed. */
const workerOrigins = (): { production: string; preview: string } => {
  const text = fs.readFileSync(path.join(ROOT, 'workers/rooms/wrangler.jsonc'), 'utf8')
  const json = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')) as {
    name: string
    vars: { ROOM_ORIGINS: string }
    env: { preview: { vars: { ROOM_ORIGINS: string } } }
  }
  expect(json.name).toBe('ff10yr-rooms')
  return { production: json.vars.ROOM_ORIGINS, preview: json.env.preview.vars.ROOM_ORIGINS }
}

describe('the room path', () => {
  it('takes a base32 id of ten or more characters, and nothing else', () => {
    expect(roomIdFromPath(`/api/room/${ID}`)).toBe(ID)
    expect(roomIdFromPath(`/api/room/${ID}/`)).toBe(ID)
    expect(roomIdFromPath('/api/room/short')).toBeNull()
    expect(roomIdFromPath('/api/room/ABCDEFGHIJKL')).toBeNull()
    expect(roomIdFromPath(`/api/room/${ID}/lap`)).toBeNull()
    expect(roomIdFromPath(`/api/room/${ID}1`)).toBeNull()
  })

  // DEV-441b. Red against the shape before it (`^[a-z2-7]{10,32}$`): every
  // short code was refused 404 by the Function and 4007 by the Worker, and a
  // hosted room could never be reached at all.
  // DEV-458: seven characters, and a six-character code of DEV-441b's refused.
  it('takes a seven-character short code, canonical (capitals), and only that', () => {
    expect(roomIdFromPath('/api/room/K7QX4MN')).toBe('K7QX4MN')
    expect(roomIdFromPath('/api/room/23456BC')).toBe('23456BC')
    // Not canonical, or not the alphabet: the client normalises, the route does not.
    expect(roomIdFromPath('/api/room/k7qx4mn')).toBeNull()
    expect(roomIdFromPath('/api/room/K7QX4M')).toBeNull()
    expect(roomIdFromPath('/api/room/K7QX4MNP')).toBeNull()
    expect(roomIdFromPath('/api/room/K7QO4MN')).toBeNull()
    expect(roomIdFromPath('/api/room/K7Q14MN')).toBeNull()
    expect(roomIdFromPath('/api/room/KAQX4MN')).toBeNull()
  })
})

describe('the join message (DEV-441b)', () => {
  const base = {
    type: 'join',
    protocol: ROOM_PROTOCOL,
    handle: 'Swift Kestrel 42',
    variant: 'standard',
    colour: 0,
    content: 'ab12cd34ef56ab12',
  }
  it('carries `existing` when it is true, and drops it otherwise', () => {
    expect(parseClientMessage(JSON.stringify({ ...base, existing: true }))).toEqual({
      ...base,
      existing: true,
    })
    expect(parseClientMessage(JSON.stringify({ ...base, existing: false }))).toEqual(base)
    expect(parseClientMessage(JSON.stringify(base))).toEqual(base)
  })
  it('refuses an `existing` that is not a boolean', () => {
    expect(parseClientMessage(JSON.stringify({ ...base, existing: 'yes' }))).toBeNull()
  })
  // DEV-459. Red against a parser that drops it: a removed page would come back
  // as a stranger, and the room could not tell.
  it('carries the page token when it is a token, and refuses one that is not', () => {
    const page = 'AAAAAAAAAAAAAAAAAAAAAA'
    expect(parseClientMessage(JSON.stringify({ ...base, page }))).toEqual({ ...base, page })
    expect(parseClientMessage(JSON.stringify({ ...base, page: 'short' }))).toBeNull()
    expect(parseClientMessage(JSON.stringify({ ...base, page: 7 }))).toBeNull()
  })
})

describe('the kick message (DEV-459)', () => {
  it('names a slot, and nothing else', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'kick', slot: 2 }))).toEqual({
      type: 'kick',
      slot: 2,
    })
    for (const slot of [-1, 1.5, '2', 99, undefined]) {
      expect(parseClientMessage(JSON.stringify({ type: 'kick', slot })), String(slot)).toBeNull()
    }
  })
})

describe('routeToRoom, the Pages Function (§6.2)', () => {
  it('hands a same-origin upgrade to the room named by the path', async () => {
    const { ns, seen } = fakeRooms()
    const res = await onRequest({
      request: upgrade(`${SITE}/api/room/${ID}?_pk=chosen-by-client&x=1`),
      env: { ROOMS: ns },
      params: { id: ID },
      waitUntil: () => {},
      next: async () => new Response(null, { status: 404 }),
    })
    expect(await res.text()).toBe('to the room')
    expect(seen.name).toBe(ID)
    const fwd = seen.request as Request
    // A client may not choose its connection id (§6.10): `_pk` is stripped.
    expect(new URL(fwd.url).searchParams.has('_pk')).toBe(false)
    expect(new URL(fwd.url).searchParams.get('x')).toBe('1')
    expect(fwd.headers.get(PARTYKIT_ROOM_HEADER)).toBe(ID)
    expect(fwd.headers.get('Upgrade')).toBe('websocket')
    expect(fwd.headers.get('Origin')).toBe(SITE)
  })

  it('refuses another origin, and a missing one, with 403', async () => {
    const { ns, seen } = fakeRooms()
    const env = { ROOMS: ns }
    const url = `${SITE}/api/room/${ID}`
    expect((await routeToRoom(upgrade(url, 'https://evil.example'), env)).status).toBe(403)
    expect((await routeToRoom(upgrade(url, 'https://ff-10yr.pages.dev'), env)).status).toBe(403)
    expect((await routeToRoom(upgrade(url, null), env)).status).toBe(403)
    expect(seen.request).toBeNull()
  })

  it('refuses anything but a WebSocket upgrade with 426, so no HTTP reaches a room', async () => {
    const { ns, seen } = fakeRooms()
    const res = await routeToRoom(new Request(`${SITE}/api/room/${ID}`, { method: 'POST' }), {
      ROOMS: ns,
    })
    expect(res.status).toBe(426)
    expect(seen.request).toBeNull()
  })

  it('refuses a malformed id with 404', async () => {
    const { ns } = fakeRooms()
    expect((await routeToRoom(upgrade(`${SITE}/api/room/nope`), { ROOMS: ns })).status).toBe(404)
  })

  it('answers 503 where no ROOMS binding is configured', async () => {
    expect((await routeToRoom(upgrade(`${SITE}/api/room/${ID}`), {})).status).toBe(503)
  })

  // DEV-470: the game diagnoses a failed handshake with a plain GET of the same
  // path (`game/room-client.ts`, `diagnoseStatus`), so THAT request must read
  // 503 on an unbound site too — it read 426, "the site is fine", and a
  // release build before production's binding spun for 30 s and then said
  // "could not be reached". Every request for a room's path, then; a path that
  // is not a room's is still 404, and a bound site still refuses a GET 426.
  it('DEV-470: where no ROOMS binding is configured, answers the diagnosis GET 503 too', async () => {
    for (const path of [`/api/room/${ID}`, `/api/room/K7QX4M2`, `/api/watch/${ID}`]) {
      const route = path.startsWith('/api/watch/') ? routeToWatch : routeToRoom
      const get = await route(new Request(`${SITE}${path}`), {})
      expect(get.status, `GET ${path}`).toBe(503)
      expect(await get.text()).toBe('rooms are not configured here')
      expect((await route(upgrade(`${SITE}${path}`), {})).status, `upgrade ${path}`).toBe(503)
      // From another origin as well: there is nothing there to protect.
      expect((await route(upgrade(`${SITE}${path}`, 'https://evil.example'), {})).status).toBe(503)
    }
    expect((await routeToRoom(new Request(`${SITE}/api/room/nope`), {})).status).toBe(404)
    const { ns, seen } = fakeRooms()
    expect((await routeToRoom(new Request(`${SITE}/api/room/${ID}`), { ROOMS: ns })).status).toBe(
      426,
    )
    expect((await routeToWatch(new Request(`${SITE}/api/watch/${ID}`), { ROOMS: ns })).status).toBe(
      426,
    )
    expect(seen.request, 'no GET reaches a room').toBeNull()
  })
})

describe("the Worker's direct route: ROOM_ORIGINS as configured", () => {
  const worker = 'https://ff10yr-rooms-preview.example.workers.dev'
  const admits = (allowed: string, origin: string) =>
    admitRoomUpgrade(upgrade(`${worker}/api/room/${ID}`, origin), allowed).ok

  it('production admits production only', () => {
    const { production } = workerOrigins()
    expect(admits(production, 'https://ff-10yr.pages.dev')).toBe(true)
    expect(admits(production, SITE)).toBe(false)
    expect(admits(production, 'https://localhost:5173')).toBe(false)
  })

  it('preview admits every preview deployment and a local dev server', () => {
    const { preview } = workerOrigins()
    for (const o of [
      'https://ff-10yr.pages.dev',
      SITE,
      'https://mp-room.ff-10yr.pages.dev',
      'https://1a2b3c4d.ff-10yr.pages.dev',
      'https://localhost:5173',
      'http://127.0.0.1:8788',
    ]) {
      expect(admits(preview, o), o).toBe(true)
    }
  })

  it('neither admits a look-alike', () => {
    const { production, preview } = workerOrigins()
    for (const allowed of [production, preview]) {
      for (const o of [
        'https://evil.example',
        'https://ff-10yr.pages.dev.evil.example',
        'https://evilff-10yr.pages.dev',
        'https://a.b.ff-10yr.pages.dev',
        'http://ff-10yr.pages.dev',
        'https://localhost.evil.example',
      ]) {
        expect(admits(allowed, o), `${allowed} vs ${o}`).toBe(false)
      }
    }
  })

  it('same-origin is always admitted, and a bad allowlist admits nothing else', () => {
    expect(originAdmitted(worker, `${worker}/api/room/${ID}`, undefined)).toBe(true)
    expect(originAdmitted(SITE, `${worker}/api/room/${ID}`, '(')).toBe(false)
  })
})
