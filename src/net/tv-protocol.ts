// src/net/tv-protocol.ts — Faceted Flight TV's wire: the guide, the TV id, the routes. DEV-479.
//
// plan/FF-TV.md §2–§3. TV is a front end on DEV-436's broadcaster, with three
// things added on the server and nothing changed for a player:
//
//   - a GUIDE: the rooms class under the name `TV_GUIDE_NAME` (as a
//     broadcaster is the rooms class under `watch.<id>`), which the rooms tell
//     what they are doing (`TvAnnounce`) and which lists the races that are on
//     (`TvList`) — each under a TV id, never the room's id;
//   - a TV ID per room: `tv_` and 16 characters of the room's base32 alphabet,
//     minted by the room at first need and kept for the room's life, across
//     every race in it (§2.2, revised 2026-09-30). The underscore is outside
//     `ROOM_ID_SHAPE`, so a TV id can never be taken for a room's id by any
//     route: `/api/room/tv_…` is a 404, not a new room;
//   - an INTERNAL PATH into a broadcaster, `TV_WATCH_PATH`, which only the TV
//     Function's forward reaches: a socket that arrives on it is anonymous, and
//     every handle it is sent has been replaced with *Racer N* (`tv-anon.ts`).
//
// `ROOM_PROTOCOL` does not move: no message a player's client exchanges with a
// room changes. The guide's internal API and the room's `tv` request travel
// over the binding (`stub.fetch`), never over a player's socket.
//
// SERVER-SAFE and pure: web platform only, no clock, no randomness of its own.

import {
  ID_SHAPE,
  originAdmitted,
  ROOM_ID_SHAPE,
  ROOM_JUDGE_GRACE_MS,
  ROOM_LOAD_TIMEOUT_MS,
  ROOM_MAX_TIME_LIMIT_MS,
  ROOM_START_MARGIN_MS,
  type RoomPhase,
} from './room-protocol'

/** A TV id: `tv_` and 16 of the room alphabet's base32. Never a room id's shape (the underscore). */
export const TV_ID_SHAPE = /^tv_[a-z2-7]{16}$/
export const TV_ID_PREFIX = 'tv_'
export const TV_ID_LENGTH = 16
const TV_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

/** The guide: the rooms class under this name. A dot, so never a room's id (or a broadcaster's). */
export const TV_GUIDE_NAME = 'tv.guide'

/** The internal path a TV viewer's socket arrives at a broadcaster on. No public route forwards it. */
export const TV_WATCH_PATH = '/internal/tv-watch'

/** The most rooms the guide holds; an announce past it is refused, and that room is not on TV. */
export const TV_MAX_ROOMS = 64

/** The phases the list shows. A lobby is held (a link to it resolves) but never listed. */
export const TV_LISTED_PHASES: readonly RoomPhase[] = ['loading', 'countdown', 'racing', 'results']

/** `GET /api/tv`'s `Cache-Control: max-age`, seconds (§3.3). */
export const TV_LIST_MAX_AGE_S = 10

/** How long the guide holds a room in its lobby after its last announce, ms. Refreshed at half. */
export const TV_LOBBY_HOLD_MS = 60 * 60_000
/** How long the guide holds a room on its results after they settle, ms. */
export const TV_RESULTS_HOLD_MS = 10 * 60_000
/**
 * An off-air TV id is kept off for its room's life (the room's withdraw on
 * clear lifts it), and never longer than this: a crashed room that never
 * withdraws must not leave the set growing.
 */
export const TV_OFF_AIR_MAX_MS = 24 * 60 * 60_000

/** A fresh TV id from `random` (the room's `host.random`). */
export const mintTvId = (random: (bytes: Uint8Array) => void): string => {
  const bytes = new Uint8Array(TV_ID_LENGTH)
  random(bytes)
  let out = TV_ID_PREFIX
  for (const b of bytes) out += TV_ALPHABET.charAt(b & 31)
  return out
}

// ── What a room tells the guide ─────────────────────────────────────────────

/**
 * A room's state as the guide holds it, without its id: what `RoomServer`
 * hands its host. The room never learns its own id (the Durable Object's name),
 * so the SHELL adds `room` before the announce leaves it (`TvAnnounce`).
 */
export interface TvRoomState {
  readonly tv: string
  /** The course, once the owner has chosen one. */
  readonly mission: string | null
  readonly phase: RoomPhase
  /** People racing plus bots, once a race is frozen; people present in a lobby. */
  readonly racers: number
  /** The field's GO, room ms, once released. */
  readonly goAt: number | null
  /** Room ms past which the guide drops this room if it has heard nothing since. */
  readonly until: number
  /** Room ms the state was taken. The guide keeps the newest it has heard. */
  readonly at: number
}

/** Room -> guide, over the binding. */
export interface TvAnnounce extends TvRoomState {
  readonly room: string
}

/** One race on the list. No room id, no handle, no seat: what anyone who opens TV receives. */
export interface TvListEntry {
  readonly tv: string
  readonly mission: string
  readonly phase: RoomPhase
  readonly racers: number
  /** Room ms the race reached this phase (GO for `racing`). */
  readonly since: number
}

/** `GET /api/tv`'s body (§3.3). */
export interface TvList {
  readonly races: readonly TvListEntry[]
  /** Rooms in their lobby with a TV id: "2 rooms getting ready". */
  readonly lobbies: number
}

/** The guide's internal paths. Any host: the URL never leaves the binding. */
export const TV_GUIDE_LINK = {
  announce: 'https://tv.internal/announce',
  withdraw: 'https://tv.internal/withdraw',
  resolve: 'https://tv.internal/resolve',
  list: 'https://tv.internal/list',
  offAir: 'https://tv.internal/off-air',
  onAir: 'https://tv.internal/on-air',
  state: 'https://tv.internal/state',
} as const

const isInt = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const PHASES: readonly RoomPhase[] = ['lobby', 'loading', 'countdown', 'racing', 'results']

/** An announce as the guide accepts it, or null. The room is trusted; the shape is checked anyway. */
export const parseTvAnnounce = (v: unknown): TvAnnounce | null => {
  if (typeof v !== 'object' || v === null) return null
  const a = v as Record<string, unknown>
  if (typeof a.tv !== 'string' || !TV_ID_SHAPE.test(a.tv)) return null
  if (typeof a.room !== 'string' || !ROOM_ID_SHAPE.test(a.room)) return null
  if (a.mission !== null && (typeof a.mission !== 'string' || !ID_SHAPE.test(a.mission)))
    return null
  if (typeof a.phase !== 'string' || !PHASES.includes(a.phase as RoomPhase)) return null
  if (!isInt(a.racers, 0, 64)) return null
  if (a.goAt !== null && !isTime(a.goAt)) return null
  if (!isTime(a.until) || !isTime(a.at)) return null
  return {
    tv: a.tv,
    room: a.room,
    mission: a.mission as string | null,
    phase: a.phase as RoomPhase,
    racers: a.racers,
    goAt: a.goAt as number | null,
    until: a.until,
    at: a.at,
  }
}

/**
 * When a room's guide entry runs out, from what the room knows: its own bound
 * on the phase it is in (§3.2). A lobby and a settled race are held for a
 * while after their last announce; a race, until every racer's time could have
 * run out — the latest GO, the course's limit (or the longest a room takes,
 * where the course has none) and the judge's grace. Loading adds the barrier's
 * timeout and the countdown in front of that.
 */
export const tvUntil = (p: {
  readonly phase: RoomPhase
  readonly now: number
  readonly countdown: number
  readonly timeLimit: number
  readonly loadingSince: number | null
  readonly latestGo: number | null
}): number => {
  const limit = (p.timeLimit > 0 ? p.timeLimit : ROOM_MAX_TIME_LIMIT_MS) + ROOM_JUDGE_GRACE_MS
  switch (p.phase) {
    case 'lobby':
      return p.now + TV_LOBBY_HOLD_MS
    case 'results':
      return p.now + TV_RESULTS_HOLD_MS
    case 'loading':
      return (
        (p.loadingSince ?? p.now) +
        ROOM_LOAD_TIMEOUT_MS +
        p.countdown +
        ROOM_START_MARGIN_MS +
        limit
      )
    default:
      return (p.latestGo ?? p.now) + limit
  }
}

// ── The routes' admission ───────────────────────────────────────────────────

/** The TV id out of `/api/tv/<id>`, or null. */
export const tvIdFromPath = (pathname: string): string | null => {
  const m = /^\/api\/tv\/([^/]+)\/?$/.exec(pathname)
  const id = m?.[1]
  return id !== undefined && TV_ID_SHAPE.test(id) ? id : null
}

/**
 * Whether a plain GET may be answered as same-origin (WATCH ME, §2.6). A
 * same-origin `fetch` GET carries no `Origin` header in Chrome, so the check is
 * on what the browser does send: a foreign `Origin` is refused, and so is a
 * `Sec-Fetch-Site` other than `same-origin` (or `none`, a typed address). A
 * request with neither is not a browser on another site (a probe, `curl`), and
 * whoever sends one already holds the room's code — which `?watch=` would
 * show them anyway.
 */
export const sameOriginGet = (request: Request): boolean => {
  const origin = request.headers.get('Origin')
  if (origin !== null && !originAdmitted(origin, request.url, undefined)) return false
  const site = request.headers.get('Sec-Fetch-Site')
  return site === null || site === 'same-origin' || site === 'none'
}
