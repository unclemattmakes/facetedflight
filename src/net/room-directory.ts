// src/net/room-directory.ts: the list of PUBLIC rooms. DEV-633.
//
// Matt, 2026-10-04: *"i like your idea of listing public rooms. let's make
// sure that people have the option to make it public or private."* A room is
// private unless its owner lists it (`RoomSettings.listed`); a listed room
// tells this directory what it is doing, and the hangar's OPEN ROOMS table
// reads the list (`GET /api/rooms`) so a stranger can join without a code.
//
// Pure, like `TvGuide` (`tv-guide.ts`), and on the same plumbing: an injected
// clock, storage and alarm, so the whole directory is a node test
// (`tests/unit/room-directory.test.ts`), and the rooms Worker's Durable Object
// is a shell over it under `ROOM_DIRECTORY_NAME`. A name with a dot is never a
// room's id, so no public route reaches it.
//
// What it holds, per listed room: the room's code (the point: it is the way
// in), the course's id, whether it is in its lobby or racing, the players
// present and the seats. NOTHING ELSE: no handle, no name, no free text of
// any kind, so nothing a stranger reads off the list was typed by anyone. The
// page names the course from its own content.
//
//   - POST (the room, on every change while it is listed): upsert. An older
//     post than the one held is ignored. Past `ROOM_DIRECTORY_MAX` a new room
//     is refused, and is simply not listed.
//   - DROP (the room: unlisted, emptied, or cleared): the entry goes.
//   - EXPIRE (an alarm, set only while anything is held): an entry past its
//     `until` goes. A room re-posts once half its hold has gone, on its next
//     change; a room that died without dropping leaves the list by itself.
//   - LIST (`GET /api/rooms`): at most `ROOM_LIST_MAX` rooms, lobbies first,
//     newest first. Racing rooms are listed and say so (a join is refused
//     until the race is settled, `CLOSE.started`).

import { noBody, postJson, takenOr409 } from './do-link'
import { ROOM_CODE_SHAPE, ROOM_MAX_SEATS } from './room-protocol'

/** The Durable Object's name for the directory. The dot keeps it off every room route. */
export const ROOM_DIRECTORY_NAME = 'rooms.directory'
/** The most rooms the directory holds. */
export const ROOM_DIRECTORY_MAX = 64
/** The most rooms one list returns: the cap on what one request costs and shows. */
export const ROOM_LIST_MAX = 12
/** How long a post holds without another, ms. A quiet lobby re-posts on its next change past half of it. */
export const ROOM_LIST_HOLD_MS = 30 * 60_000
/** The list's `cache-control` max-age, seconds: a burst of pages asks the directory once. */
export const ROOM_LIST_MAX_AGE_S = 5
/** The internal API's URLs. Reachable only through the binding. */
export const ROOM_DIRECTORY_LINK = {
  post: 'https://directory.internal/post',
  drop: 'https://directory.internal/drop',
  list: 'https://directory.internal/list',
} as const

/** A listed room as anyone may read it. */
export interface RoomListing {
  /** The room's short code: what JOIN joins. */
  readonly room: string
  /** The course's content id, or null before the owner has chosen. */
  readonly mission: string | null
  readonly phase: 'lobby' | 'racing'
  readonly players: number
  readonly seats: number
}

/** What a room says about itself, before its shell adds its code. */
export interface RoomListingState {
  readonly mission: string | null
  readonly phase: 'lobby' | 'racing'
  readonly players: number
  readonly seats: number
  /** When it was said (room ms), and how long it holds. */
  readonly at: number
  readonly until: number
}

export interface RoomListingPost extends RoomListingState {
  readonly room: string
}

export interface RoomList {
  readonly rooms: readonly RoomListing[]
}

const MISSION_SHAPE = /^[a-z0-9_-]{1,64}$/i

const isInt = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi

/** A post off the wire, or null. Only a short code is ever listed. */
export const parseRoomListingPost = (v: unknown): RoomListingPost | null => {
  if (typeof v !== 'object' || v === null) return null
  const { room, mission, phase, players, seats, at, until } = v as Record<string, unknown>
  if (typeof room !== 'string' || !ROOM_CODE_SHAPE.test(room)) return null
  if (mission !== null && (typeof mission !== 'string' || !MISSION_SHAPE.test(mission))) return null
  if (phase !== 'lobby' && phase !== 'racing') return null
  if (!isInt(seats, 1, ROOM_MAX_SEATS) || !isInt(players, 0, seats)) return null
  if (!isInt(at, 0, Number.MAX_SAFE_INTEGER) || !isInt(until, at, Number.MAX_SAFE_INTEGER)) {
    return null
  }
  return { room, mission: mission as string | null, phase, players, seats, at, until }
}

/** A list off the wire, as the page reads it: anything malformed is left out, never guessed. */
export const parseRoomList = (v: unknown): RoomListing[] => {
  const rooms = (v as { rooms?: unknown } | null)?.rooms
  if (!Array.isArray(rooms)) return []
  const out: RoomListing[] = []
  for (const r of rooms.slice(0, ROOM_LIST_MAX)) {
    const p = parseRoomListingPost({ ...(r as object), at: 0, until: 0 })
    if (p) {
      out.push({
        room: p.room,
        mission: p.mission,
        phase: p.phase,
        players: p.players,
        seats: p.seats,
      })
    }
  }
  return out
}

/** The slice of `DurableObjectStorage` the directory uses. */
export interface RoomDirectoryStorage {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<boolean | undefined>
}

export interface RoomDirectoryHost {
  now(): number
  readonly storage: RoomDirectoryStorage
  setAlarm(at: number | null): Promise<void>
}

interface Stored {
  v: 1
  entries: Record<string, RoomListingPost>
}

const STORAGE_KEY = 'directory'

export class RoomDirectory {
  readonly #host: RoomDirectoryHost
  #d: Stored
  #alarmAt: number | null | undefined = undefined

  private constructor(host: RoomDirectoryHost, d: Stored) {
    this.#host = host
    this.#d = d
  }

  static async load(host: RoomDirectoryHost): Promise<RoomDirectory> {
    const stored = await host.storage.get<Stored>(STORAGE_KEY)
    const dir = new RoomDirectory(host, stored?.v === 1 ? stored : { v: 1, entries: {} })
    await dir.#expire()
    return dir
  }

  /** A listed room's state. False when refused: the directory is full and this room is new to it. */
  async post(p: RoomListingPost): Promise<boolean> {
    await this.#expire()
    const held = this.#d.entries[p.room]
    if (held && p.at < held.at) return true
    if (!held && Object.keys(this.#d.entries).length >= ROOM_DIRECTORY_MAX) return false
    this.#d.entries[p.room] = p
    await this.#save()
    return true
  }

  /** The room is no longer listed. */
  async drop(room: string): Promise<void> {
    if (!(room in this.#d.entries)) return
    delete this.#d.entries[room]
    await this.#save()
  }

  /** What anyone who opens OPEN ROOMS receives. */
  list(): RoomList {
    const now = this.#host.now()
    const rooms = Object.values(this.#d.entries)
      .filter((e) => now < e.until && e.players > 0)
      .sort(
        (a, b) =>
          (a.phase === 'lobby' ? 0 : 1) - (b.phase === 'lobby' ? 0 : 1) ||
          b.at - a.at ||
          (a.room < b.room ? -1 : 1),
      )
      .slice(0, ROOM_LIST_MAX)
      .map(({ room, mission, phase, players, seats }) => ({ room, mission, phase, players, seats }))
    return { rooms }
  }

  async onAlarm(): Promise<void> {
    this.#alarmAt = undefined
    await this.#expire(true)
  }

  async #expire(force = false): Promise<void> {
    const now = this.#host.now()
    let changed = false
    for (const [room, e] of Object.entries(this.#d.entries)) {
      if (now >= e.until) {
        delete this.#d.entries[room]
        changed = true
      }
    }
    if (changed || force) await this.#save()
  }

  async #save(): Promise<void> {
    const entries = Object.values(this.#d.entries)
    if (entries.length === 0) await this.#host.storage.delete(STORAGE_KEY)
    else await this.#host.storage.put(STORAGE_KEY, this.#d)
    const at = entries.length === 0 ? null : Math.min(...entries.map((e) => e.until))
    if (at === this.#alarmAt) return
    this.#alarmAt = at
    await this.#host.setAlarm(at)
  }
}

// ── The internal API, over the binding ──────────────────────────────────────

/** The directory's side: answer one internal request, or 404. */
export const answerRoomDirectory = async (
  dir: RoomDirectory,
  request: Request,
): Promise<Response> => {
  const url = new URL(request.url)
  const path = `${url.origin}${url.pathname}`
  try {
    if (request.method === 'POST' && path === ROOM_DIRECTORY_LINK.post) {
      const p = parseRoomListingPost(await request.json())
      if (!p) return noBody(400)
      return takenOr409(await dir.post(p))
    }
    if (request.method === 'POST' && path === ROOM_DIRECTORY_LINK.drop) {
      const { room } = (await request.json()) as { room?: unknown }
      if (typeof room !== 'string' || !ROOM_CODE_SHAPE.test(room)) {
        return noBody(400)
      }
      await dir.drop(room)
      return noBody(204)
    }
    if (request.method === 'GET' && path === ROOM_DIRECTORY_LINK.list) {
      return Response.json(dir.list())
    }
  } catch {
    return noBody(400)
  }
  return noBody(404)
}

/** The callers' side: a room's shell (post, drop) or the list Function (list). */
export interface RoomDirectoryLink {
  post(p: RoomListingPost): Promise<boolean>
  drop(room: string): Promise<void>
  list(): Promise<RoomList>
}

export const roomDirectoryOverFetch = (
  fetchDirectory: (request: Request) => Promise<Response>,
): RoomDirectoryLink => {
  const send = (url: string, body: unknown) => postJson(fetchDirectory, url, body)
  return {
    post: async (p) => (await send(ROOM_DIRECTORY_LINK.post, p)).ok,
    drop: async (room) => {
      await send(ROOM_DIRECTORY_LINK.drop, { room })
    },
    list: async () =>
      (await (await fetchDirectory(new Request(ROOM_DIRECTORY_LINK.list))).json()) as RoomList,
  }
}
