// src/net/room-route.ts — the Pages Function's half of a room: the hand-off. DEV-386.
//
// `functions/api/room/[id].ts` is a one-line shell over `routeToRoom`. The
// game connects to its OWN origin, `wss://<site>/api/room/<id>`, and this
// hands the upgrade to the room's Durable Object through the `ROOMS` binding
// (plan/MULTIPLAYER.md §6.2): no CORS, no second hostname in the build, and
// preview talks to preview because each Pages environment binds its own
// Worker (`docs/rooms.md`).
//
// SERVER-SAFE: web platform only. The binding's type is written out as the
// slice used, as `pages-function.ts` writes out `PagesFunction`, rather than
// taking `@cloudflare/workers-types` into the game's dependencies for one type.

import {
  ROOM_DIRECTORY_NAME,
  ROOM_LIST_MAX_AGE_S,
  type RoomDirectoryLink,
  roomDirectoryOverFetch,
} from './room-directory'
import {
  type RoomJudgeLink,
  type RoomTvLink,
  roomLinkOverFetch,
  roomTvLinkOverFetch,
} from './room-link'
import {
  admitRoomUpgrade,
  admitWatchUpgrade,
  originAdmitted,
  ROOM_ID_SHAPE,
  watchName,
} from './room-protocol'
import { type TvGuideLink, tvGuideOverFetch } from './tv-guide'
import {
  sameOriginGet,
  TV_GUIDE_NAME,
  TV_ID_SHAPE,
  TV_LIST_MAX_AGE_S,
  TV_WATCH_PATH,
  tvIdFromPath,
} from './tv-protocol'

/** The slice of `DurableObjectNamespace` the hand-off uses. */
export interface RoomNamespace {
  idFromName(name: string): unknown
  get(id: never): { fetch(request: Request): Promise<Response> }
}

/** The Pages project's binding for rooms, by the name `docs/rooms.md` gives it. */
export interface RoomEnv {
  readonly ROOMS?: RoomNamespace
}

/** partyserver reads the room's name from this when the id carries none. */
export const PARTYKIT_ROOM_HEADER = 'x-partykit-room'

/** What an environment with no `ROOMS` binding answers, for a room's path. */
export const ROOMS_OFF_STATUS = 503

/**
 * DEV-470: an unbound environment's answer to ANY request for a room's (or a
 * watch's) path, the upgrade or not; null where the path is not one, or the
 * environment is bound. Checked BEFORE admission, because the game's diagnosis
 * of a failed handshake is a plain GET (`game/room-client.ts`, `diagnoseStatus`)
 * and admission answers that 426, "the site is fine": production before its
 * binding (docs/rooms.md) then read as a room that missed, retried for 30 s
 * and ended "could not be reached", where it should say at once that
 * multiplayer is not set up there.
 */
const roomsOff = (env: RoomEnv, admitted: { readonly ok: boolean; readonly status?: number }) =>
  !env.ROOMS && (admitted.ok || admitted.status !== 404)
    ? new Response('rooms are not configured here', { status: ROOMS_OFF_STATUS })
    : null

/**
 * Hand a WebSocket upgrade to its room, or refuse it. Same-origin only: this
 * route serves the page's own origin, so no allowlist is needed here (the
 * Worker's direct route has one). An unbound environment answers 503 to
 * anything asked of a room's path (`roomsOff`) — rooms are off there, and the
 * game says so rather than spinning.
 */
export const routeToRoom = async (request: Request, env: RoomEnv): Promise<Response> => {
  const admitted = admitRoomUpgrade(request, undefined)
  const off = roomsOff(env, admitted)
  if (off) return off
  if (!admitted.ok) return new Response(admitted.reason, { status: admitted.status })
  const rooms = env.ROOMS
  if (!rooms) return new Response('rooms are not configured here', { status: ROOMS_OFF_STATUS })
  const forwarded = new Request(admitted.url, request)
  forwarded.headers.set(PARTYKIT_ROOM_HEADER, admitted.id)
  const stub = rooms.get(rooms.idFromName(admitted.id) as never)
  return stub.fetch(forwarded)
}

/**
 * DEV-436: a viewer's WebSocket to room `id`'s BROADCASTER — the same class
 * under `watchName(id)` (`room-broadcast.ts`), so the same binding. Same
 * origin only, as `routeToRoom`. The room itself never sees this socket.
 */
export const routeToWatch = async (request: Request, env: RoomEnv): Promise<Response> => {
  const admitted = admitWatchUpgrade(request, undefined)
  const off = roomsOff(env, admitted)
  if (off) return off
  if (!admitted.ok) return new Response(admitted.reason, { status: admitted.status })
  const rooms = env.ROOMS
  if (!rooms) return new Response('rooms are not configured here', { status: ROOMS_OFF_STATUS })
  const forwarded = new Request(admitted.url, request)
  forwarded.headers.set(PARTYKIT_ROOM_HEADER, admitted.name)
  const stub = rooms.get(rooms.idFromName(admitted.name) as never)
  return stub.fetch(forwarded)
}

/**
 * DEV-390: the judge's line to room `id`, over the binding, or null where rooms
 * are off or the id is not a room's shape. The same `stub.fetch` the hand-off
 * above uses, on the object's internal API (`room-link.ts`), with the room's
 * name carried for partyserver.
 */
export const roomLinkFor = (env: RoomEnv, id: string | undefined): RoomJudgeLink | null => {
  const rooms = env.ROOMS
  if (!rooms || id === undefined || !ROOM_ID_SHAPE.test(id)) return null
  const stub = rooms.get(rooms.idFromName(id) as never)
  return roomLinkOverFetch((request) => {
    const r = new Request(request)
    r.headers.set(PARTYKIT_ROOM_HEADER, id)
    return stub.fetch(r)
  })
}

// ── Faceted Flight TV (DEV-479, plan/FF-TV.md §2.2, §2.6, §3.3) ─────────────

/** The guide's line, over the binding, or null where rooms are off. */
export const tvGuideFor = (env: RoomEnv): TvGuideLink | null => {
  const rooms = env.ROOMS
  if (!rooms) return null
  const stub = rooms.get(rooms.idFromName(TV_GUIDE_NAME) as never)
  return tvGuideOverFetch((request) => {
    const r = new Request(request)
    r.headers.set(PARTYKIT_ROOM_HEADER, TV_GUIDE_NAME)
    return stub.fetch(r)
  })
}

/** WATCH ME's line to room `id`, over the binding, or null (rooms off, or not a room's id). */
export const roomTvLinkFor = (env: RoomEnv, id: string | undefined): RoomTvLink | null => {
  const rooms = env.ROOMS
  if (!rooms || id === undefined || !ROOM_ID_SHAPE.test(id)) return null
  const stub = rooms.get(rooms.idFromName(id) as never)
  return roomTvLinkOverFetch((request) => {
    const r = new Request(request)
    r.headers.set(PARTYKIT_ROOM_HEADER, id)
    return stub.fetch(r)
  })
}

const roomsOffResponse = () =>
  new Response('rooms are not configured here', { status: ROOMS_OFF_STATUS })

/** DEV-633: the directory of public rooms, over the binding, or null where rooms are off. */
export const roomDirectoryFor = (env: RoomEnv): RoomDirectoryLink | null => {
  const rooms = env.ROOMS
  if (!rooms) return null
  const stub = rooms.get(rooms.idFromName(ROOM_DIRECTORY_NAME) as never)
  return roomDirectoryOverFetch((request) => {
    const r = new Request(request)
    r.headers.set(PARTYKIT_ROOM_HEADER, ROOM_DIRECTORY_NAME)
    return stub.fetch(r)
  })
}

/**
 * DEV-633: `GET /api/rooms`: the PUBLIC rooms, from the directory
 * (`RoomDirectory.list`): each one's code, course id, phase, players and seats,
 * at most `ROOM_LIST_MAX`, nothing about any person. Same origin only, as TV's
 * list is not (a list of joinable rooms is for this game's pages). Cached a
 * few seconds, so a burst of pages asks the directory once. 503 where `ROOMS`
 * is unbound (DEV-470's rule).
 */
export const routeToRoomList = async (request: Request, env: RoomEnv): Promise<Response> => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('GET only', { status: 405, headers: { allow: 'GET, HEAD' } })
  }
  if (!sameOriginGet(request)) return new Response('same origin only', { status: 403 })
  const directory = roomDirectoryFor(env)
  if (!directory) return roomsOffResponse()
  const list = await directory.list()
  return new Response(request.method === 'HEAD' ? null : JSON.stringify(list), {
    headers: {
      'content-type': 'application/json',
      'cache-control': `public, max-age=${ROOM_LIST_MAX_AGE_S}`,
    },
  })
}

/**
 * `GET /api/tv`: the races that are on, from the guide (§3.3). No room id is
 * in it (`TvGuide.list`). Cached ten seconds at the edge: every viewer on the
 * exhibition reads it, and a race a few seconds late to the list costs nothing.
 * 503 where `ROOMS` is unbound (DEV-470's rule), so a client goes straight to
 * the exhibition rather than spinning.
 */
export const routeToTvList = async (request: Request, env: RoomEnv): Promise<Response> => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('GET only', { status: 405, headers: { allow: 'GET, HEAD' } })
  }
  const guide = tvGuideFor(env)
  if (!guide) return roomsOffResponse()
  const list = await guide.list()
  return new Response(request.method === 'HEAD' ? null : JSON.stringify(list), {
    headers: {
      'content-type': 'application/json',
      'cache-control': `public, max-age=${TV_LIST_MAX_AGE_S}`,
    },
  })
}

/**
 * `wss /api/tv/<tvId>`: a TV viewer's socket (§2.2). In this order, so a stale
 * link costs nothing past one lookup: the TV id's shape (404); rooms off (503);
 * the guide resolves it to a room, or 404 BEFORE any upgrade — a plain GET
 * (the client's diagnosis of a failed handshake) learns the same; a WebSocket
 * upgrade and nothing else (426); same origin only (403). Then the upgrade goes
 * to the room's broadcaster on `TV_WATCH_PATH`, which marks the socket
 * anonymous. The room's id is used here and nowhere the viewer can see: not in
 * the URL it opened, not in the `101` (the broadcaster's answer carries no
 * headers of its own), and not in any frame (`tv-anon.ts`; a keyframe carries
 * no id).
 */
export const routeToTvWatch = async (request: Request, env: RoomEnv): Promise<Response> => {
  const tv = tvIdFromPath(new URL(request.url).pathname)
  if (!tv) return new Response('no such race', { status: 404 })
  const rooms = env.ROOMS
  const guide = tvGuideFor(env)
  if (!rooms || !guide) return roomsOffResponse()
  const room = await guide.resolve(tv)
  if (room === null || !ROOM_ID_SHAPE.test(room)) {
    return new Response('no such race', { status: 404 })
  }
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('TV speaks WebSocket only', { status: 426 })
  }
  if (!originAdmitted(request.headers.get('Origin'), request.url, undefined)) {
    return new Response('origin', { status: 403 })
  }
  const name = watchName(room)
  // A fixed URL: nothing the viewer sent can name a connection id (`_pk`) or
  // another path. The upgrade's headers go on, as `routeToWatch`'s do.
  const forwarded = new Request(`https://rooms.internal${TV_WATCH_PATH}`, request)
  forwarded.headers.set(PARTYKIT_ROOM_HEADER, name)
  const stub = rooms.get(rooms.idFromName(name) as never)
  return stub.fetch(forwarded)
}

/**
 * `GET /api/room/<code>/tv`: WATCH ME (§2.6). The caller already holds the
 * room's code, so the TV id tells it nothing it could not watch by `?watch=`;
 * the room mints one if it has none and answers `{ tv }`, or 404 where no such
 * room is in use. Same origin only (`sameOriginGet`), never cached.
 */
export const routeToRoomTv = async (
  request: Request,
  env: RoomEnv,
  id: string | undefined,
): Promise<Response> => {
  const noStore = { 'cache-control': 'no-store' }
  if (request.method !== 'GET') {
    return new Response('GET only', { status: 405, headers: { allow: 'GET', ...noStore } })
  }
  if (id === undefined || !ROOM_ID_SHAPE.test(id)) {
    return new Response('no such room', { status: 404, headers: noStore })
  }
  if (!sameOriginGet(request)) return new Response('origin', { status: 403, headers: noStore })
  const link = roomTvLinkFor(env, id)
  if (!link) return roomsOffResponse()
  const tv = await link.tv()
  if (tv === null || !TV_ID_SHAPE.test(tv)) {
    return new Response('no such room', { status: 404, headers: noStore })
  }
  return new Response(JSON.stringify({ tv }), {
    headers: { 'content-type': 'application/json', ...noStore },
  })
}

/**
 * A board lap's id, as `/tv/lap/<id>` carries it: `lap-server.ts`'s `ID_SHAPE`,
 * written out because the rooms Worker bundles this file and cannot resolve
 * `lap-policy.ts`'s `@/` import. `tests/unit/tv-routes.test.ts` holds the two equal.
 */
export const TV_LAP_ID_SHAPE = /^[0-9A-Za-z]{10}$/
/** `?follow=<n>`: Racer n, from 1 (a slot plus one; a room seats at most 16). */
const FOLLOW_SHAPE = /^(?:[1-9]|1[0-6])$/

/**
 * The short links (§2.6): `/tv` -> `/?tv`, `/tv/<tvId>` -> `/?tv=<tvId>`
 * keeping a valid `?follow=`, `/tv/lap/<lapId>` -> `/?tv=lap:<lapId>`. Anything
 * else under `/tv` lands on `/?tv`, TV's own choice, so a mistyped link still
 * opens TV. Nothing else in the query is carried and nothing is looked up: a
 * link never joins, and `follow` is a camera hint only the client reads.
 */
export const routeTvShortLink = (request: Request): Response => {
  const url = new URL(request.url)
  const parts = url.pathname.split('/').filter((p) => p !== '')
  let to = '/?tv'
  if (parts[0] === 'tv') {
    const [, a, b, extra] = parts
    if (a !== undefined && b === undefined && TV_ID_SHAPE.test(a)) {
      to = `/?tv=${a}`
      const follow = url.searchParams.get('follow')
      if (follow !== null && FOLLOW_SHAPE.test(follow)) to += `&follow=${follow}`
    } else if (a === 'lap' && b !== undefined && extra === undefined && TV_LAP_ID_SHAPE.test(b)) {
      to = `/?tv=lap:${b}`
    }
  }
  return new Response(null, {
    status: 302,
    headers: { location: to, 'cache-control': 'public, max-age=3600' },
  })
}
