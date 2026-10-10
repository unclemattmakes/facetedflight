// src/net/tv-guide.ts — Faceted Flight TV's guide: which races are on. DEV-479.
//
// plan/FF-TV.md §3. Pure, like `RoomServer`: an injected clock, storage and
// alarm, so the whole guide is a node test (`tests/unit/tv-guide.test.ts`) and
// the rooms Worker's Durable Object is a shell over it, under the name
// `TV_GUIDE_NAME` (`workers/rooms/src/index.ts`).
//
// What it holds: one entry per room that has a TV id — the TV id, the room's
// id (only to resolve the one into the other, and it goes with the entry),
// the course, the phase, how many race, and the room's own bound (`until`).
// Nothing about people: no handle, no address, no seat.
//
//   - ANNOUNCE (the room, on every change once it has a TV id): upsert the
//     entry. An older announce than the one held is ignored, so two that cross
//     on the way cannot rewind a room. Past `TV_MAX_ROOMS` a new room is
//     refused, and is simply not on TV.
//   - WITHDRAW (the room's `#clear`): the entry goes, and an off-air mark on
//     its TV id with it — the room is gone, and so is the id.
//   - EXPIRE (an alarm, set only while the guide holds anything): an entry past
//     its `until` is dropped. A room evicted mid-race announces again when it
//     loads, with the same TV id.
//   - RESOLVE (the TV Function, before any upgrade): TV id -> room id, or null
//     for an unknown, expired or off-air id.
//   - LIST (`GET /api/tv`): the races in a listed phase, each WITHOUT its room
//     id, and how many rooms sit in a lobby.
//   - OFF-AIR (`functions/api/admin/tv.ts`, behind ADMIN_TOKEN): one TV id kept
//     off for its room's life, or the whole list dark until a time (§3.6).
//
// A phase announced as `countdown` reads as `racing` once its GO has passed:
// a room's countdown ends on its own clock, with no event to announce it.

import { fieldOrNull, noBody, postJson, takenOr409 } from './do-link'
import type { RoomPhase } from './room-protocol'
import {
  parseTvAnnounce,
  TV_GUIDE_LINK,
  TV_ID_SHAPE,
  TV_LISTED_PHASES,
  TV_MAX_ROOMS,
  TV_OFF_AIR_MAX_MS,
  type TvAnnounce,
  type TvList,
  type TvListEntry,
} from './tv-protocol'

/** The slice of `DurableObjectStorage` the guide uses (`RoomStorage`'s). */
export interface TvGuideStorage {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<boolean | undefined>
}

export interface TvGuideHost {
  /** Wall time, ms: `Date.now()` in the object, the same clock the rooms announce on. */
  now(): number
  readonly storage: TvGuideStorage
  /** One alarm per object; `null` cancels it. */
  setAlarm(at: number | null): Promise<void>
}

interface Entry extends TvAnnounce {
  /** When the entry reached its phase (room ms). */
  since: number
}

interface StoredGuide {
  v: 1
  entries: Record<string, Entry>
  /** TV id -> until when it is kept off the list (§3.6). */
  offAir: Record<string, number>
  /** The whole list dark until then, or null. */
  darkUntil: number | null
}

const STORAGE_KEY = 'guide'

const fresh = (): StoredGuide => ({ v: 1, entries: {}, offAir: {}, darkUntil: null })

/** What the admin route sees: everything, room ids included (Matt's own token). */
export interface TvGuideState {
  readonly entries: readonly (TvListEntry & { readonly room: string; readonly until: number })[]
  readonly offAir: Readonly<Record<string, number>>
  readonly darkUntil: number | null
}

export class TvGuide {
  readonly #host: TvGuideHost
  #g: StoredGuide
  #alarmAt: number | null | undefined = undefined

  private constructor(host: TvGuideHost, g: StoredGuide) {
    this.#host = host
    this.#g = g
  }

  static async load(host: TvGuideHost): Promise<TvGuide> {
    const stored = await host.storage.get<StoredGuide>(STORAGE_KEY)
    const guide = new TvGuide(host, stored?.v === 1 ? stored : fresh())
    await guide.#expire()
    return guide
  }

  /** A room's state. False when refused: the guide is full and this room is new to it. */
  async announce(a: TvAnnounce): Promise<boolean> {
    await this.#expire()
    const g = this.#g
    const held = g.entries[a.tv]
    if (held && a.at < held.at) return true
    if (!held && Object.keys(g.entries).length >= TV_MAX_ROOMS) return false
    const now = this.#host.now()
    const phase = this.#phaseOf(a, now)
    const since =
      held && this.#phaseOf(held, now) === phase
        ? held.since
        : phase === 'racing' && a.goAt !== null
          ? a.goAt
          : a.at
    g.entries[a.tv] = { ...a, since }
    await this.#save()
    return true
  }

  /** The room cleared (`cleared`), or left the air some other way. */
  async withdraw(tv: string, cleared: boolean): Promise<void> {
    const g = this.#g
    const had = tv in g.entries || (cleared && tv in g.offAir)
    delete g.entries[tv]
    if (cleared) delete g.offAir[tv]
    if (had) await this.#save()
  }

  /** The room behind a TV id, or null: unknown, expired, off-air, or the list is dark. */
  resolve(tv: string): string | null {
    const now = this.#host.now()
    if (!TV_ID_SHAPE.test(tv) || this.#dark(now) || this.#offAir(tv, now)) return null
    const e = this.#g.entries[tv]
    return e && now < e.until ? e.room : null
  }

  /** What anyone who opens TV receives: no room id anywhere in it. */
  list(): TvList {
    const now = this.#host.now()
    if (this.#dark(now)) return { races: [], lobbies: 0 }
    const races: TvListEntry[] = []
    let lobbies = 0
    for (const e of Object.values(this.#g.entries)) {
      if (now >= e.until || this.#offAir(e.tv, now)) continue
      const phase = this.#phaseOf(e, now)
      if (phase === 'lobby') {
        lobbies++
        continue
      }
      if (!TV_LISTED_PHASES.includes(phase) || e.mission === null) continue
      const since =
        phase === 'racing' && e.phase === 'countdown' && e.goAt !== null ? e.goAt : e.since
      races.push({ tv: e.tv, mission: e.mission, phase, racers: e.racers, since })
    }
    races.sort((a, b) => a.since - b.since || (a.tv < b.tv ? -1 : 1))
    return { races, lobbies }
  }

  /** Off the air: one TV id for its room's life (bounded), or everything until `until`. */
  async offAir(what: { readonly tv: string } | { readonly until: number }): Promise<void> {
    const now = this.#host.now()
    if ('tv' in what) this.#g.offAir[what.tv] = now + TV_OFF_AIR_MAX_MS
    else this.#g.darkUntil = what.until > now ? what.until : null
    await this.#save()
  }

  /** Back on: one TV id, or the dark lifted. */
  async onAir(what: { readonly tv: string } | { readonly dark: true }): Promise<void> {
    if ('tv' in what) delete this.#g.offAir[what.tv]
    else this.#g.darkUntil = null
    await this.#save()
  }

  state(): TvGuideState {
    const now = this.#host.now()
    return {
      entries: Object.values(this.#g.entries).map((e) => ({
        tv: e.tv,
        room: e.room,
        mission: e.mission ?? '',
        phase: this.#phaseOf(e, now),
        racers: e.racers,
        since: e.since,
        until: e.until,
      })),
      offAir: { ...this.#g.offAir },
      darkUntil: this.#g.darkUntil,
    }
  }

  async onAlarm(): Promise<void> {
    this.#alarmAt = undefined
    await this.#expire(true)
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  #phaseOf(e: TvAnnounce, now: number): RoomPhase {
    return e.phase === 'countdown' && e.goAt !== null && now >= e.goAt ? 'racing' : e.phase
  }

  #dark(now: number): boolean {
    return this.#g.darkUntil !== null && now < this.#g.darkUntil
  }

  #offAir(tv: string, now: number): boolean {
    const until = this.#g.offAir[tv]
    return until !== undefined && now < until
  }

  /** Drop everything past its bound; `force` saves and re-arms even if nothing went. */
  async #expire(force = false): Promise<void> {
    const g = this.#g
    const now = this.#host.now()
    let changed = false
    for (const [tv, e] of Object.entries(g.entries)) {
      if (now >= e.until) {
        delete g.entries[tv]
        changed = true
      }
    }
    for (const [tv, until] of Object.entries(g.offAir)) {
      if (now >= until) {
        delete g.offAir[tv]
        changed = true
      }
    }
    if (g.darkUntil !== null && now >= g.darkUntil) {
      g.darkUntil = null
      changed = true
    }
    if (changed || force) await this.#save()
  }

  async #save(): Promise<void> {
    const g = this.#g
    if (
      Object.keys(g.entries).length === 0 &&
      Object.keys(g.offAir).length === 0 &&
      g.darkUntil === null
    ) {
      await this.#host.storage.delete(STORAGE_KEY)
    } else {
      await this.#host.storage.put(STORAGE_KEY, g)
    }
    await this.#syncAlarm()
  }

  /** An alarm only while anything is held: the earliest bound. */
  async #syncAlarm(): Promise<void> {
    const g = this.#g
    let at: number | null = null
    const earliest = (t: number) => {
      at = at === null ? t : Math.min(at, t)
    }
    for (const e of Object.values(g.entries)) earliest(e.until)
    for (const until of Object.values(g.offAir)) earliest(until)
    if (g.darkUntil !== null) earliest(g.darkUntil)
    if (at === this.#alarmAt) return
    this.#alarmAt = at
    await this.#host.setAlarm(at)
  }
}

// ── The internal API, over the binding ──────────────────────────────────────

/** The guide's side: answer one internal request, or 404. */
export const answerTvGuide = async (guide: TvGuide, request: Request): Promise<Response> => {
  const url = new URL(request.url)
  const path = `${url.origin}${url.pathname}`
  try {
    if (request.method === 'POST' && path === TV_GUIDE_LINK.announce) {
      const a = parseTvAnnounce(await request.json())
      if (!a) return noBody(400)
      return takenOr409(await guide.announce(a))
    }
    if (request.method === 'POST' && path === TV_GUIDE_LINK.withdraw) {
      const { tv, cleared } = (await request.json()) as { tv: unknown; cleared: unknown }
      if (typeof tv !== 'string' || !TV_ID_SHAPE.test(tv)) return noBody(400)
      await guide.withdraw(tv, cleared === true)
      return noBody(204)
    }
    if (request.method === 'GET' && path === TV_GUIDE_LINK.resolve) {
      const room = guide.resolve(url.searchParams.get('tv') ?? '')
      return room === null ? noBody(404) : Response.json({ room })
    }
    if (request.method === 'GET' && path === TV_GUIDE_LINK.list) return Response.json(guide.list())
    if (request.method === 'GET' && path === TV_GUIDE_LINK.state)
      return Response.json(guide.state())
    if (request.method === 'POST' && path === TV_GUIDE_LINK.offAir) {
      const b = (await request.json()) as { tv?: unknown; until?: unknown }
      if (typeof b.tv === 'string' && TV_ID_SHAPE.test(b.tv)) await guide.offAir({ tv: b.tv })
      else if (typeof b.until === 'number' && Number.isFinite(b.until))
        await guide.offAir({ until: b.until })
      else return noBody(400)
      return noBody(204)
    }
    if (request.method === 'POST' && path === TV_GUIDE_LINK.onAir) {
      const b = (await request.json()) as { tv?: unknown; dark?: unknown }
      if (typeof b.tv === 'string' && TV_ID_SHAPE.test(b.tv)) await guide.onAir({ tv: b.tv })
      else if (b.dark === true) await guide.onAir({ dark: true })
      else return noBody(400)
      return noBody(204)
    }
  } catch {
    return noBody(400)
  }
  return noBody(404)
}

/** The callers' side: a Function (resolve, list, off-air) or a room's shell (announce, withdraw). */
export interface TvGuideLink {
  announce(a: TvAnnounce): Promise<boolean>
  withdraw(tv: string, cleared: boolean): Promise<void>
  resolve(tv: string): Promise<string | null>
  list(): Promise<TvList>
  state(): Promise<TvGuideState>
  offAir(what: { readonly tv: string } | { readonly until: number }): Promise<boolean>
  onAir(what: { readonly tv: string } | { readonly dark: true }): Promise<boolean>
}

export const tvGuideOverFetch = (
  fetchGuide: (request: Request) => Promise<Response>,
): TvGuideLink => {
  const post = (url: string, body: unknown) => postJson(fetchGuide, url, body)
  return {
    announce: async (a) => (await post(TV_GUIDE_LINK.announce, a)).ok,
    withdraw: async (tv, cleared) => {
      await post(TV_GUIDE_LINK.withdraw, { tv, cleared })
    },
    resolve: async (tv) => {
      const r = await fetchGuide(
        new Request(`${TV_GUIDE_LINK.resolve}?tv=${encodeURIComponent(tv)}`),
      )
      return fieldOrNull<string>(r, 'room')
    },
    list: async () => (await (await fetchGuide(new Request(TV_GUIDE_LINK.list))).json()) as TvList,
    state: async () =>
      (await (await fetchGuide(new Request(TV_GUIDE_LINK.state))).json()) as TvGuideState,
    offAir: async (what) => (await post(TV_GUIDE_LINK.offAir, what)).ok,
    onAir: async (what) => (await post(TV_GUIDE_LINK.onAir, what)).ok,
  }
}
