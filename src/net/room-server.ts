// src/net/room-server.ts — a room's logic, as a pure class. DEV-386.
//
// The Durable Object in `workers/rooms/` is a shell over this, the way
// `functions/api/**` are shells over `lap-server.ts`: everything a room does is
// testable in node against a fake connection list, fake storage and a fake
// clock (`tests/unit/room-server.test.ts`, king-tide's relay-test pattern), and
// the harness race (DEV-387) runs a whole room in memory.
//
// What a room is (`plan/MULTIPLAYER.md` §6): a relay with a lifecycle. It
// stamps every forwarded record with the sender's slot, holds the lobby
// (players, colours, the owner's settings, ready), runs the start barrier and
// schedules one GO in its own clock, and keeps results that arrive through its
// BINDING (`verdict`), never through a socket. It runs NO game code: a room
// cannot drift from the game because it knows nothing about flying.
//
// ── Liveness is one rule ──────────────────────────────────────────────────
//
// A player is PRESENT while a live connection carries their slot. Every
// handler sweeps first: a player whose connection is not live has departed —
// removed in the lobby, seat held for `ROOM_REJOIN_MS` once the race is on.
// One rule covers a clean close, a close the object slept through, and a
// deploy that dropped every socket while nothing ran: no event is required,
// so none can be missed.
//
// ── State lives in storage (§6.2, king-tide review Phase 8) ───────────────
//
// A Durable Object is evicted when idle and restarted on deploy, and with
// hibernation on it sleeps between messages. So every change is written to
// storage BEFORE it is broadcast, and a new instance over the same storage
// and the same sockets resumes where the last one stopped. The rate buckets
// and the last-pose memory are the only in-memory state, and losing them
// costs nothing. Storage is cleared when the room empties.

import { toBase64url } from './base64url'
import { ROOM_LIST_HOLD_MS, type RoomListingState } from './room-directory'
import {
  BROADCAST_FLUSH_MS,
  CLOSE,
  type ClientMessage,
  type ConfigureMessage,
  encodeBatch,
  type FinishMessage,
  type JoinMessage,
  type KeyframeMessage,
  POSE_AT,
  POSE_HEADER_BYTES,
  POSE_KIND,
  POSE_RECORD_BYTES,
  POSE_TAG_V1,
  parseClientMessage,
  poseMessageMax,
  type ReadyMessage,
  ROOM_CONFIGURE_TEXT_MAX,
  ROOM_JUDGE_GRACE_MS,
  ROOM_KEEPALIVE,
  ROOM_LOAD_TIMEOUT_MS,
  ROOM_MAX_COLOURS,
  ROOM_MAX_SEATS,
  ROOM_POSE_JUMP_MM,
  ROOM_PROTOCOL,
  ROOM_RATE_BURST,
  ROOM_RATE_PER_SECOND,
  ROOM_REJOIN_MS,
  ROOM_START_MARGIN_MS,
  ROOM_TEXT_MAX,
  type RoomBot,
  type RoomPhase,
  type RoomPlayerView,
  type RoomRace,
  type RoomSeat,
  type RoomSettings,
  type RoomVerdict,
  type ServerMessage,
} from './room-protocol'
import { mintTvId, type TvRoomState, tvUntil } from './tv-protocol'

// ── What the shell provides ─────────────────────────────────────────────────

/** A connection's attachment: survives hibernation with the socket. */
export interface RoomConnState {
  readonly slot: number
  readonly joinSeq: number
}

/**
 * DEV-436: the broadcaster's feed socket's attachment — the one connection
 * that is neither a player nor a stranger. Marked by `onFeed`, which the shell
 * calls for a socket that arrived on `ROOM_FEED_PATH` (no public route
 * forwards it), so it survives hibernation with the socket like a seat does.
 */
export interface RoomFeedState {
  readonly feed: true
}

const isFeed = (c: RoomConnection): boolean =>
  (c.state as Partial<RoomFeedState> | null)?.feed === true

/** One socket, as partyserver's `Connection` already is. */
export interface RoomConnection {
  readonly id: string
  readonly state: unknown
  setState(state: RoomConnState | RoomFeedState | null): unknown
  send(message: string | ArrayBuffer | ArrayBufferView): void
  close(code?: number, reason?: string): void
}

/** The slice of `DurableObjectStorage` a room uses. */
export interface RoomStorage {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<boolean | undefined>
}

export interface RoomHost {
  /** Room time, ms. `Date.now()` in the Durable Object. */
  now(): number
  /** Every open socket, joined or not. */
  connections(): Iterable<RoomConnection>
  readonly storage: RoomStorage
  /** One alarm per object; `null` cancels it. */
  setAlarm(at: number | null): Promise<void>
  /** Fill with cryptographically random bytes. */
  random(bytes: Uint8Array): void
  /**
   * DEV-479: tell Faceted Flight TV's guide (plan/FF-TV.md §3.2). `state` is the
   * room as the guide holds it, without the room's id — the shell knows its own
   * name and adds it; `null` withdraws the TV id because the room has cleared.
   * Fire and forget, in the order called. A host without it has no TV: the
   * room then mints a TV id only when one is asked for (`tvId`).
   */
  announce?(tv: string, state: TvRoomState | null): void
  /**
   * DEV-633: tell the directory of PUBLIC rooms (`room-directory.ts`). `state`
   * is the room as the directory lists it, without its code (the shell adds
   * its own name); `null` takes it off the list (made private, emptied, or
   * cleared). Fire and forget, in the order called. A host without it lists
   * nothing.
   */
  list?(state: RoomListingState | null): void
}

// ── What is stored ──────────────────────────────────────────────────────────

interface StoredPlayer {
  slot: number
  joinSeq: number
  seat: string
  /** DEV-459: the page this player joined from (`join.page`), for a kick to keep out. */
  page?: string
  /** The connection id carrying this seat, or null once departed. */
  conn: string | null
  handle: string
  variant: string
  colour: number
  ready: boolean
  /** Room ms the seat was left, while it is held for a reconnect. */
  left: number | null
  loaded: boolean
  /** A racer released after the field has their own GO (§6.3). */
  goAt: number | null
  finish: number | null
}

interface StoredBotFinish {
  bot: number
  tick: number
}

interface StoredRoom {
  v: 1
  /** The generated-content digest the room was made with (§6.7). */
  content: string | null
  joinCounter: number
  settings: RoomSettings | null
  players: StoredPlayer[]
  stage: 'lobby' | 'loading' | 'released'
  race: RoomRace | null
  /** Slots present at START: the barrier waits for these. */
  cohort: number[]
  loadingSince: number | null
  goAt: number | null
  results: RoomVerdict[]
  botFinishes: StoredBotFinish[]
  /** Room ms the last present player left a race, for the delayed clear. */
  emptySince: number | null
  /** Slots whose judged lap is kept under `lap:<slot>` (DEV-390), so a clear can delete them. */
  keptLaps: number[]
  /**
   * DEV-459: the seat tokens and page tokens the owner removed, kept out
   * until the room clears. Optional: a room stored before protocol 6 has none.
   */
  kicked?: string[]
  /**
   * DEV-479: the room's TV id (`tv_` + 16, `TV_ID_SHAPE`), minted at first need
   * — its first announce to the guide, or the first WATCH ME request — and
   * kept for the room's life, across all its races, so a shared link works
   * for every race in the room. Cleared with the room. Never its code.
   */
  tv?: string
}

const STORAGE_KEY = 'room'

const freshRoom = (): StoredRoom => ({
  v: 1,
  content: null,
  joinCounter: 0,
  settings: null,
  players: [],
  stage: 'lobby',
  race: null,
  cohort: [],
  loadingSince: null,
  goAt: null,
  results: [],
  botFinishes: [],
  emptySince: null,
  keptLaps: [],
  kicked: [],
})

const connSlot = (c: RoomConnection): number | null => {
  const s = c.state as Partial<RoomConnState> | null
  return s && typeof s.slot === 'number' ? s.slot : null
}

/** mulberry32: the seeded shuffle's generator. The seed is the room's randomness. */
const seeded = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Bucket {
  tokens: number
  at: number
}

interface LastPose {
  x: number
  y: number
  z: number
}

// ── The room ────────────────────────────────────────────────────────────────

export class RoomServer {
  readonly #host: RoomHost
  #room: StoredRoom
  #alarmAt: number | null | undefined = undefined
  readonly #buckets = new Map<string, Bucket>()
  readonly #lastPose = new Map<string, LastPose>()
  /** DEV-436: pose frames for the broadcaster since the last batch, and when that went. */
  readonly #feedFrames: Uint8Array[] = []
  #feedFlushedAt = Number.NEGATIVE_INFINITY
  /** DEV-479: what this instance last told the guide; null until it has (so a load re-announces). */
  #tvSaid: { key: string; at: number; until: number } | null = null
  /** DEV-633: what this instance last told the directory; null when it is not listed by it. */
  #listSaid: { key: string; at: number } | null = null

  private constructor(host: RoomHost, room: StoredRoom) {
    this.#host = host
    this.#room = room
  }

  /** A room over `host`, resumed from storage if the object ran before. */
  static async load(host: RoomHost): Promise<RoomServer> {
    const stored = await host.storage.get<StoredRoom>(STORAGE_KEY)
    const server = new RoomServer(host, stored?.v === 1 ? stored : freshRoom())
    await server.#sweep(null)
    // DEV-479: a room evicted mid-race announces again on load, with the same
    // TV id (plan/FF-TV.md §3.2) — or mints one, stored before TV existed.
    if (server.#tvDue()) await server.#save()
    else server.#tellTv()
    server.#tellDirectory()
    return server
  }

  // ── Inspection (tests, and the shell's logs) ──────────────────────────────

  phase(now = this.#host.now()): RoomPhase {
    const r = this.#room
    if (r.stage === 'lobby' || r.stage === 'loading') return r.stage
    const racers = r.cohort.length
    if (racers > 0 && r.results.length >= racers) return 'results'
    return r.goAt !== null && now < r.goAt ? 'countdown' : 'racing'
  }

  get settings(): RoomSettings | null {
    return this.#room.settings
  }

  get race(): RoomRace | null {
    return this.#room.race
  }

  get goAt(): number | null {
    return this.#room.goAt
  }

  get results(): readonly RoomVerdict[] {
    return this.#room.results
  }

  /** The owner: the present player with the lowest `joinSeq` (king-tide's tenure rule). */
  owner(): number | null {
    let best: StoredPlayer | null = null
    for (const p of this.#room.players) {
      if (p.left !== null || p.conn === null) continue
      if (!best || p.joinSeq < best.joinSeq) best = p
    }
    return best ? best.slot : null
  }

  players(): Record<number, RoomPlayerView> {
    const out: Record<number, RoomPlayerView> = {}
    for (const p of this.#room.players) out[p.slot] = this.#view(p)
    return out
  }

  // ── Entry points ──────────────────────────────────────────────────────────

  /** A socket opened. Nothing is said until it sends `join`. */
  async onConnect(_conn: RoomConnection): Promise<void> {
    await this.#sweep(null)
  }

  async onClose(conn: RoomConnection): Promise<void> {
    this.#buckets.delete(conn.id)
    if (isFeed(conn)) this.#feedFrames.length = 0
    await this.#sweep(conn.id)
  }

  /**
   * DEV-436: the broadcaster's feed arrived (`ROOM_FEED_PATH`, the shell's call —
   * never a player's). It is marked, handed the race as it stands, and from
   * now on hears everything the room tells its players, and their poses in
   * batches. One feed: a second replaces the first. It never counts as a
   * player, and nothing it sends is read.
   */
  async onFeed(conn: RoomConnection): Promise<void> {
    for (const c of this.#host.connections()) {
      if (c.id !== conn.id && isFeed(c)) c.close(CLOSE.replaced, 'replaced')
    }
    conn.setState({ feed: true })
    this.#feedFrames.length = 0
    this.#feedFlushedAt = this.#host.now()
    conn.send(JSON.stringify(this.#keyframe()))
  }

  async onAlarm(): Promise<void> {
    this.#alarmAt = undefined
    await this.#sweep(null)
    await this.#maybeRelease()
    await this.#settle()
    await this.#maybeClearEmpty()
    await this.#syncAlarm()
  }

  async onMessage(conn: RoomConnection, message: string | ArrayBuffer | ArrayBufferView) {
    // DEV-436: the feed is receive-only; nothing it could say is read.
    if (isFeed(conn)) return
    if (!this.#admitRate(conn)) {
      conn.close(CLOSE.abuse, 'rate')
      return
    }
    if (typeof message === 'string') {
      if (message.length > ROOM_CONFIGURE_TEXT_MAX) {
        conn.close(CLOSE.abuse, 'size')
        return
      }
      // The platform answers the keep-alive without waking the object; this
      // is the same answer where it is not (local dev, the test tier).
      if (message === ROOM_KEEPALIVE.request) {
        conn.send(ROOM_KEEPALIVE.response)
        return
      }
      const msg = parseClientMessage(message)
      // DEV-851: only a `configure` carrying a course token may be that long.
      if (message.length > ROOM_TEXT_MAX && msg?.type !== 'configure') {
        conn.close(CLOSE.abuse, 'size')
        return
      }
      if (!msg) return
      await this.#onText(conn, msg)
      return
    }
    await this.#onPose(conn, message)
  }

  /**
   * The judge's verdict on one lap (§6.5). Reachable ONLY through the Durable
   * Object binding — the Worker shell exposes it as an RPC method, and no
   * socket message reaches it (`parseClientMessage` knows no verdict type).
   * DEV-390 calls it from the lap Function. First verdict for a slot wins.
   */
  async verdict(v: RoomVerdict): Promise<boolean> {
    const r = this.#room
    if (r.stage !== 'released' || !r.cohort.includes(v.slot)) return false
    if (r.results.some((x) => x.slot === v.slot)) return false
    r.results.push(v)
    await this.#save()
    this.#broadcastResults()
    await this.#syncAlarm()
    return true
  }

  // ── The judge's side of the binding (DEV-390, `room-link.ts`) ─────────────

  /**
   * The seat a token holds in a RELEASED race with no result yet, and the rules
   * a lap from it must carry. Null otherwise: an unknown token, a race not yet
   * run, or a seat already judged (first verdict wins).
   */
  seatInfo(token: string): RoomSeat | null {
    const r = this.#room
    const s = r.settings
    if (r.stage !== 'released' || !s) return null
    const p = r.players.find((x) => x.seat === token)
    if (!p || !r.cohort.includes(p.slot) || r.results.some((x) => x.slot === p.slot)) return null
    const rules = s.rules[p.variant]
    if (rules === undefined) return null
    // DEV-477: the seat's start, an index into the course's start list.
    const start = r.race?.starts[p.slot]
    return {
      slot: p.slot,
      mission: s.mission,
      edition: s.edition,
      variant: p.variant,
      rules,
      ...(start === undefined ? {} : { start }),
      // DEV-851: the judge rebuilds a player's course from its token.
      ...(s.course === undefined ? {} : { course: s.course }),
    }
  }

  /** Keep a judged lap's wire text for "race this lap" (§6.5), until the room empties. */
  async keepLap(slot: number, lap: string): Promise<void> {
    const r = this.#room
    if (!r.results.some((x) => x.slot === slot && x.verdict === 'ok')) return
    await this.#host.storage.put(`lap:${slot}`, lap)
    if (!r.keptLaps.includes(slot)) {
      r.keptLaps.push(slot)
      await this.#save()
    }
  }

  async keptLap(slot: number): Promise<string | null> {
    if (!this.#room.keptLaps.includes(slot)) return null
    return (await this.#host.storage.get<string>(`lap:${slot}`)) ?? null
  }

  // ── Faceted Flight TV (DEV-479, plan/FF-TV.md §2.2, §2.6) ─────────────────

  /**
   * WATCH ME: the room's TV id, minted now if it has none, for a player who
   * already holds the room's code (`GET /api/room/<code>/tv`, over the binding:
   * `room-link.ts`). Null where there is no room — nobody in it, nor a seat
   * held for anyone — so a code nobody is using mints nothing. The guide is
   * told again, so a link made in a lobby resolves before the room ever races.
   */
  async tvId(): Promise<string | null> {
    await this.#sweep(null)
    const r = this.#room
    if (r.players.length === 0) return null
    this.#tvSaid = null
    if (r.tv === undefined) {
      r.tv = mintTvId((b) => this.#host.random(b))
      await this.#save()
    } else this.#tellTv()
    return r.tv
  }

  /** The TV id, for the tests and the shell's logs; minted by `tvId` or a race, never here. */
  get tv(): string | null {
    return this.#room.tv ?? null
  }

  /** A room with a guide to tell, out of its lobby and with no TV id yet: it needs one now. */
  #tvDue(): boolean {
    return (
      this.#host.announce !== undefined &&
      this.#room.tv === undefined &&
      this.#room.stage !== 'lobby'
    )
  }

  /** The room as the guide holds it (§3.2): no id, no handle, no seat. */
  #tvState(tv: string): TvRoomState {
    const r = this.#room
    const s = r.settings
    const now = this.#host.now()
    const phase = this.phase(now)
    const gos = Object.values(this.#goAts())
    if (r.goAt !== null) gos.push(r.goAt)
    return {
      tv,
      mission: r.race?.mission ?? s?.mission ?? null,
      phase,
      racers:
        r.stage === 'lobby' ? this.#presentCount() : r.cohort.length + (r.race?.bots.length ?? 0),
      goAt: r.goAt,
      until: tvUntil({
        phase,
        now,
        countdown: s?.countdown ?? 0,
        timeLimit: s?.timeLimit ?? 0,
        loadingSince: r.loadingSince,
        latestGo: gos.length > 0 ? Math.max(...gos) : null,
      }),
      at: now,
    }
  }

  /**
   * Tell the guide what changed, if anything did. A lobby's and a settled
   * race's bound runs from the announce, so they are compared without it and
   * re-announced once half their hold has gone; a race's bound is its own and
   * is compared with the rest.
   */
  #tellTv(): void {
    const announce = this.#host.announce
    const tv = this.#room.tv
    if (!announce || tv === undefined) return
    const state = this.#tvState(tv)
    const held = state.phase === 'lobby' || state.phase === 'results'
    const key = JSON.stringify([
      state.mission,
      state.phase,
      state.racers,
      state.goAt,
      held ? null : state.until,
    ])
    const said = this.#tvSaid
    if (said && said.key === key && state.at < (said.at + said.until) / 2) return
    this.#tvSaid = { key, at: state.at, until: state.until }
    announce(tv, state)
  }

  /**
   * DEV-633: tell the directory what changed, if this room is listed and
   * anything did; take it off when it stops being listed or empties. Re-posted
   * past half of `ROOM_LIST_HOLD_MS` on the next change, so a quiet listing
   * holds and a dead one leaves the list by itself.
   */
  #tellDirectory(): void {
    const list = this.#host.list
    if (!list) return
    const r = this.#room
    const s = r.settings
    const players = this.#presentCount()
    if (s?.listed !== true || players === 0) {
      if (this.#listSaid !== null) {
        this.#listSaid = null
        list(null)
      }
      return
    }
    const now = this.#host.now()
    const state: RoomListingState = {
      mission: s.mission,
      phase: this.phase(now) === 'lobby' ? 'lobby' : 'racing',
      players: Math.min(players, s.seats),
      seats: s.seats,
      at: now,
      until: now + ROOM_LIST_HOLD_MS,
    }
    const key = JSON.stringify([state.mission, state.phase, state.players, state.seats])
    const said = this.#listSaid
    if (said && said.key === key && now < said.at + ROOM_LIST_HOLD_MS / 2) return
    this.#listSaid = { key, at: now }
    list(state)
  }

  // ── Text ──────────────────────────────────────────────────────────────────

  async #onText(conn: RoomConnection, msg: ClientMessage): Promise<void> {
    const slot = connSlot(conn)
    if (slot === null) {
      if (msg.type === 'join') await this.#join(conn, msg)
      return
    }
    const p = this.#player(slot)
    if (!p || p.conn !== conn.id) return
    switch (msg.type) {
      case 'join':
        return
      case 'ping':
        conn.send(JSON.stringify({ type: 'pong', t0: msg.t0, room: this.#host.now() }))
        return
      case 'ready':
        return this.#ready(conn, p, msg)
      case 'configure':
        return this.#configure(conn, p, msg)
      case 'start':
        return this.#start(conn, p)
      case 'loaded':
        return this.#loaded(conn, p)
      case 'ring':
      case 'reset':
      case 'prop':
        if (this.#room.stage !== 'released') return
        this.#broadcast({ ...msg, slot }, conn.id)
        return
      case 'finish':
        return this.#finish(conn, p, msg)
      case 'again':
        return this.#again()
      case 'forfeit':
        return this.#forfeit(p)
      case 'kick':
        return this.#kick(conn, p, msg.slot)
    }
  }

  async #join(conn: RoomConnection, msg: JoinMessage): Promise<void> {
    await this.#sweep(null)
    const now = this.#host.now()
    if (msg.protocol !== ROOM_PROTOCOL) {
      this.#refuse(conn, CLOSE.mismatch, 'protocol')
      return
    }
    // A room whose race was abandoned (empty past the rejoin window) is a new room.
    if (
      this.#room.emptySince !== null &&
      now >= this.#room.emptySince + ROOM_REJOIN_MS &&
      this.#presentCount() === 0
    ) {
      await this.#clear()
    }
    const r = this.#room
    // DEV-459: a seat or a page the owner removed stays out for the life of
    // the room, whether it comes back with its seat token or as a fresh join.
    const kicked = r.kicked ?? []
    if (
      (msg.seat !== undefined && kicked.includes(msg.seat)) ||
      (msg.page !== undefined && kicked.includes(msg.page))
    ) {
      this.#refuse(conn, CLOSE.kicked, 'kicked')
      return
    }
    // DEV-441b: a code typed by hand asks for a room somebody is in. Nobody
    // is (no player, and no seat held for one): say so, rather than seat the
    // typist alone in a new room that happens to have that name.
    if (msg.existing === true && r.players.length === 0) {
      this.#refuse(conn, CLOSE.missing, 'no such room')
      return
    }
    if (r.content !== null && msg.content !== r.content) {
      this.#refuse(conn, CLOSE.mismatch, 'content')
      return
    }

    // A reconnect presenting its seat token takes its seat back (§6.9).
    if (msg.seat !== undefined) {
      const p = r.players.find((x) => x.seat === msg.seat)
      if (p) {
        if (p.left !== null && now > p.left + ROOM_REJOIN_MS) {
          this.#refuse(conn, CLOSE.started, 'seat expired')
          return
        }
        const old = p.conn !== null && p.conn !== conn.id ? this.#connection(p.conn) : null
        p.conn = conn.id
        p.left = null
        r.emptySince = null
        conn.setState({ slot: p.slot, joinSeq: p.joinSeq })
        await this.#save()
        old?.close(CLOSE.replaced, 'replaced')
        this.#hello(conn, p)
        this.#broadcast(
          { type: 'player-joined', slot: p.slot, player: this.#view(p), owner: this.owner() },
          conn.id,
        )
        await this.#syncAlarm()
        return
      }
    }

    if (r.stage !== 'lobby') {
      this.#refuse(conn, CLOSE.started, 'race in progress')
      return
    }
    const cap = r.settings?.seats ?? ROOM_MAX_SEATS
    if (r.players.length >= cap) {
      this.#refuse(conn, CLOSE.full, 'room full')
      return
    }
    let slot = 0
    while (r.players.some((x) => x.slot === slot)) slot++
    const colours = r.settings?.colours ?? ROOM_MAX_COLOURS
    const colour =
      msg.colour < colours && !this.#colourTaken(msg.colour, -1)
        ? msg.colour
        : this.#freeColour(colours)
    const seatBytes = new Uint8Array(16)
    this.#host.random(seatBytes)
    const p: StoredPlayer = {
      slot,
      joinSeq: r.joinCounter++,
      seat: toBase64url(seatBytes),
      ...(msg.page === undefined ? {} : { page: msg.page }),
      conn: conn.id,
      handle: msg.handle,
      variant: msg.variant,
      colour,
      ready: false,
      left: null,
      loaded: false,
      goAt: null,
      finish: null,
    }
    r.players.push(p)
    r.players.sort((a, b) => a.slot - b.slot)
    if (r.content === null) r.content = msg.content
    conn.setState({ slot, joinSeq: p.joinSeq })
    await this.#save()
    this.#hello(conn, p)
    this.#broadcast(
      { type: 'player-joined', slot, player: this.#view(p), owner: this.owner() },
      conn.id,
    )
  }

  async #ready(conn: RoomConnection, p: StoredPlayer, msg: ReadyMessage): Promise<void> {
    const r = this.#room
    if (r.stage !== 'lobby') return
    const colours = r.settings?.colours ?? ROOM_MAX_COLOURS
    if (msg.colour !== undefined && msg.colour !== p.colour) {
      if (msg.colour >= colours) return this.#error(conn, 'colour', 'no such colour')
      if (this.#colourTaken(msg.colour, p.slot)) {
        return this.#error(conn, 'colour-taken', 'another player has that colour')
      }
    }
    const variant = msg.variant ?? p.variant
    if (msg.ready) {
      const s = r.settings
      if (!s) return this.#error(conn, 'unconfigured', 'the owner has not chosen a course')
      const want = s.rules[variant]
      if (want === undefined) {
        return this.#error(conn, 'variant', 'that aircraft does not fly this course here')
      }
      // A build that computes other rules for this course flew other rules (§6.8).
      if (msg.rules !== want) {
        this.#refuse(conn, CLOSE.mismatch, 'rules')
        return
      }
    }
    if (msg.colour !== undefined) p.colour = msg.colour
    p.variant = variant
    p.ready = msg.ready
    await this.#save()
    this.#broadcastLobby()
  }

  async #configure(conn: RoomConnection, p: StoredPlayer, msg: ConfigureMessage) {
    const r = this.#room
    if (r.stage !== 'lobby') return
    if (p.slot !== this.owner()) return this.#error(conn, 'not-owner', 'only the owner configures')
    const s = msg.settings
    if (s.seats < r.players.length) {
      return this.#error(conn, 'seats', 'more players than seats')
    }
    const same = r.settings !== null && JSON.stringify(r.settings) === JSON.stringify(s)
    if (same) return
    // DEV-633: PUBLIC or PRIVATE changes who can find the room, not the race:
    // nobody's ready is undone by it.
    const raceOf = (x: RoomSettings | null) => (x === null ? null : { ...x, listed: undefined })
    const sameRace = JSON.stringify(raceOf(r.settings)) === JSON.stringify(raceOf(s))
    r.settings = s
    // Anything readied under the old settings is not ready for these.
    if (!sameRace) for (const x of r.players) x.ready = false
    // A shrunk palette moves anyone off a colour it no longer has.
    for (const x of r.players) {
      if (x.colour >= s.colours) {
        x.colour = -1
        x.colour = this.#freeColour(s.colours)
      }
    }
    await this.#save()
    this.#broadcastLobby()
  }

  async #start(conn: RoomConnection, p: StoredPlayer): Promise<void> {
    const r = this.#room
    if (r.stage !== 'lobby') return
    if (p.slot !== this.owner()) return this.#error(conn, 'not-owner', 'only the owner starts')
    const s = r.settings
    if (!s) return this.#error(conn, 'unconfigured', 'the owner has not chosen a course')
    const humans = r.players.filter((x) => x.left === null && x.conn !== null)
    if (humans.length === 0 || humans.some((x) => !x.ready)) {
      return this.#error(conn, 'not-ready', 'every player must be ready')
    }
    // One start each, and the course has `seats` of them: a join past the cap
    // is closed 4000 and a `configure` below the head count is refused, so this
    // cannot fire from an honest client. It keeps the rule in the one place a
    // race is made.
    if (humans.length > s.seats) {
      return this.#error(conn, 'seats', 'more players than the course has starts')
    }
    // DEV-477: the STARTS. Matt, 2026-09-27: *"1 player per start-point
    // (players instead of the ai racers)"*. The course's start list is single
    // player's — the pad first, then the racers' own (`game/racer-grid.ts`'s
    // `roomStarts`; the room knows only its length, `seats`). The people take
    // the FIRST ones, one each, and who stands on which is a shuffle seeded by
    // the room, not the order they joined in: the starts are not level (the
    // chevron stands ahead, and a room's time runs from each player's own
    // release), so which person gets a forward one is left to the draw rather
    // than to who clicked the link first.
    const seedBytes = new Uint8Array(4)
    this.#host.random(seedBytes)
    const rand = seeded(new DataView(seedBytes.buffer).getUint32(0, true))
    const order = humans.map((x) => x.slot)
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      const t = order[i] as number
      order[i] = order[j] as number
      order[j] = t
    }
    const starts: Record<number, number> = {}
    order.forEach((slot, i) => {
      starts[slot] = i
    })
    const colours: Record<number, number> = {}
    for (const x of humans) colours[x.slot] = x.colour
    // Bots take the starts nobody took — the rest of the list, in its order —
    // in the colours nobody chose (§6.4, §6.6).
    const bots: RoomBot[] = []
    if (s.bots) {
      const used = new Set(humans.map((x) => x.colour))
      let c = 0
      for (let i = 0; i < s.seats - humans.length; i++) {
        while (used.has(c)) c++
        bots.push({ index: i, start: humans.length + i, colour: c })
        used.add(c)
      }
    }
    r.race = { mission: s.mission, edition: s.edition, starts, bots, colours }
    r.stage = 'loading'
    r.cohort = humans.map((x) => x.slot)
    r.loadingSince = this.#host.now()
    for (const x of r.players) x.loaded = false
    await this.#save()
    this.#broadcastLoading()
    await this.#syncAlarm()
  }

  async #loaded(conn: RoomConnection, p: StoredPlayer): Promise<void> {
    const r = this.#room
    const s = r.settings
    if (r.stage === 'lobby' || !s || !r.race) return
    if (r.stage === 'loading') {
      if (p.loaded || !r.cohort.includes(p.slot)) return
      p.loaded = true
      await this.#save()
      this.#broadcastLoading()
      await this.#maybeRelease()
      return
    }
    // Released already. A racer who was on the grid (a reconnect re-reporting)
    // hears its GO again; one who loaded after the field went gets its own.
    if (p.loaded) {
      conn.send(JSON.stringify(this.#startFor(p)))
      return
    }
    p.loaded = true
    p.goAt = this.#host.now() + s.countdown + ROOM_START_MARGIN_MS
    await this.#save()
    conn.send(JSON.stringify(this.#startFor(p)))
    this.#broadcast({ type: 'late', slot: p.slot, goAt: p.goAt }, conn.id)
  }

  async #finish(conn: RoomConnection, p: StoredPlayer, msg: FinishMessage): Promise<void> {
    const r = this.#room
    if (r.stage !== 'released' || !r.race) return
    if (msg.bot !== undefined) {
      // Only the bot host speaks for bots (§6.6).
      if (p.slot !== this.owner() || msg.bot >= r.race.bots.length) return
      if (r.botFinishes.some((b) => b.bot === msg.bot)) return
      r.botFinishes.push({ bot: msg.bot, tick: msg.tick })
    } else {
      if (p.finish !== null) return
      p.finish = msg.tick
    }
    await this.#save()
    this.#broadcast({ ...msg, slot: p.slot }, conn.id)
    if (msg.bot !== undefined) this.#broadcastResults()
  }

  // ── After the race (DEV-389) ──────────────────────────────────────────────

  /**
   * A SETTLED race back to the lobby: every racer in the race has a verdict
   * (phase `results`). The first `again` takes the whole room, which is what
   * lets a player who is already in the hangar start the next one while the
   * others still read their panels; nobody is moved by it, because a client
   * leaves its panel on its own press. Players, settings and colours are kept;
   * nobody is ready; a player who left the race and did not come back is gone.
   */
  async #again(): Promise<void> {
    const r = this.#room
    if (r.stage !== 'released' || this.phase() !== 'results') return
    r.stage = 'lobby'
    r.race = null
    r.cohort = []
    r.loadingSince = null
    r.goAt = null
    r.results = []
    r.botFinishes = []
    r.players = r.players.filter((p) => p.left === null)
    for (const p of r.players) {
      p.ready = false
      p.loaded = false
      p.goAt = null
      p.finish = null
    }
    this.#lastPose.clear()
    await this.#save()
    this.#broadcastLobby()
    await this.#syncAlarm()
  }

  /**
   * This racer gives the race up: a `left` verdict NOW, rather than after
   * `ROOM_REJOIN_MS` of a socket that is still open. From loading too, so the
   * start barrier stops waiting for them (`#maybeRelease`). First verdict wins,
   * so a lap posted after it is refused, and one judged before it stands.
   */
  async #forfeit(p: StoredPlayer): Promise<void> {
    const r = this.#room
    if (r.stage === 'lobby' || !r.cohort.includes(p.slot)) return
    if (r.results.some((x) => x.slot === p.slot)) return
    r.results.push({
      slot: p.slot,
      verdict: 'left',
      ticks: null,
      seconds: null,
      rings: 0,
      ringsTotal: 0,
      score2016: null,
      tainted: false,
      variant: p.variant,
    })
    await this.#save()
    this.#broadcastResults()
    await this.#maybeRelease()
    await this.#syncAlarm()
  }

  /**
   * DEV-459: the owner removes the player in `slot`. The room's rule, never a
   * client's: from anyone but the owner it is an `error`, and so is a kick
   * during a race (loading onwards) — a race ends on its own clock and a
   * griefer there can hold nothing, while in the lobby one can hold START by
   * never being ready. The player is closed `CLOSE.kicked` (the courtesy
   * `error` first, as every refusal), their seat freed at once, and their seat
   * token and page kept out until the room clears.
   */
  async #kick(conn: RoomConnection, owner: StoredPlayer, slot: number): Promise<void> {
    const r = this.#room
    if (owner.slot !== this.owner()) {
      return this.#error(conn, 'not-owner', 'only the owner removes a player')
    }
    if (r.stage !== 'lobby') return this.#error(conn, 'race', 'not during a race')
    const p = this.#player(slot)
    if (!p || p.slot === owner.slot) return this.#error(conn, 'no-player', 'no such player')
    r.kicked = [...(r.kicked ?? []), p.seat, ...(p.page === undefined ? [] : [p.page])]
    r.players = r.players.filter((x) => x.slot !== slot)
    const gone = p.conn === null ? null : this.#connection(p.conn)
    // No longer a seat: nothing it sends is heard, and nothing is sent to it.
    gone?.setState(null)
    await this.#save()
    if (gone) this.#refuse(gone, CLOSE.kicked, 'kicked')
    this.#broadcast({ type: 'player-left', slot, owner: this.owner(), held: false }, null)
  }

  // ── Poses (§7.2) ──────────────────────────────────────────────────────────

  async #onPose(conn: RoomConnection, message: ArrayBuffer | ArrayBufferView): Promise<void> {
    const slot = connSlot(conn)
    if (slot === null) return
    const r = this.#room
    if (r.stage === 'lobby') return
    const src =
      message instanceof ArrayBuffer
        ? new Uint8Array(message)
        : new Uint8Array(message.buffer, message.byteOffset, message.byteLength)
    const seats = r.settings?.seats ?? ROOM_MAX_SEATS
    if (src.byteLength > poseMessageMax(seats)) {
      conn.close(CLOSE.abuse, 'size')
      return
    }
    if (src.byteLength < POSE_HEADER_BYTES || src[POSE_AT.tag] !== POSE_TAG_V1) return
    const count = src[POSE_AT.count] as number
    if (count < 1 || src.byteLength !== POSE_HEADER_BYTES + count * POSE_RECORD_BYTES) return
    const view = new DataView(src.buffer, src.byteOffset, src.byteLength)
    const isOwner = slot === this.owner()
    let own = 0
    for (let i = 0; i < count; i++) {
      const at = POSE_HEADER_BYTES + i * POSE_RECORD_BYTES
      const kind = src[at + POSE_AT.kind]
      if (kind === POSE_KIND.own) {
        if (++own > 1 || src[at + POSE_AT.index] !== 0) return
      } else if (kind === POSE_KIND.bot) {
        // Bots' records only from the bot host: the room's owner (§6.6).
        if (!isOwner) return
      } else return
      const key = `${slot}:${kind}:${src[at + POSE_AT.index]}`
      const x = view.getInt32(at + POSE_AT.position, true)
      const y = view.getInt32(at + POSE_AT.position + 4, true)
      const z = view.getInt32(at + POSE_AT.position + 8, true)
      const last = this.#lastPose.get(key)
      this.#lastPose.set(key, { x, y, z })
      if (last && Math.hypot(x - last.x, y - last.y, z - last.z) > ROOM_POSE_JUMP_MM) return
    }
    // The room writes the sender's slot: a record cannot speak for another (§6.10).
    const out = new Uint8Array(src)
    out[POSE_AT.slot] = slot
    let feed: RoomConnection | null = null
    for (const c of this.#host.connections()) {
      if (c.id !== conn.id && connSlot(c) !== null) c.send(out)
      else if (isFeed(c)) feed = c
    }
    // DEV-436: and to the broadcaster, batched: one message per
    // `BROADCAST_FLUSH_MS`, however many poses and however many watch.
    if (feed) {
      this.#feedFrames.push(out)
      const now = this.#host.now()
      if (now - this.#feedFlushedAt >= BROADCAST_FLUSH_MS) this.#flushFeed(feed, now)
    }
  }

  // ── The broadcaster's feed (DEV-436, §13) ─────────────────────────────────

  #feedConn(): RoomConnection | null {
    for (const c of this.#host.connections()) if (isFeed(c)) return c
    return null
  }

  #flushFeed(feed: RoomConnection, now: number): void {
    if (this.#feedFrames.length > 0) feed.send(encodeBatch(this.#feedFrames, now))
    this.#feedFrames.length = 0
    this.#feedFlushedAt = now
  }

  /** A text message to the feed, after any poses it holds: the order players saw. */
  #toFeed(text: string): void {
    const feed = this.#feedConn()
    if (!feed) return
    this.#flushFeed(feed, this.#host.now())
    feed.send(text)
  }

  /** The race as it stands, for a feed that has just opened. */
  #keyframe(): KeyframeMessage {
    const r = this.#room
    return {
      type: 'keyframe',
      protocol: ROOM_PROTOCOL,
      now: this.#host.now(),
      phase: this.phase(),
      owner: this.owner(),
      settings: r.settings,
      players: this.players(),
      race: r.race,
      field: r.goAt,
      goAts: this.#goAts(),
      results: r.results,
      bots: r.botFinishes,
      delay: 0,
    }
  }

  // ── The start barrier (§6.3) ──────────────────────────────────────────────

  async #maybeRelease(): Promise<void> {
    const r = this.#room
    const s = r.settings
    if (r.stage !== 'loading' || !s || !r.race || r.loadingSince === null) return
    const cohort = r.players.filter((x) => r.cohort.includes(x.slot))
    // DEV-389: a racer who forfeited is not coming, and is not waited for.
    const out = (x: StoredPlayer) => r.results.some((v) => v.slot === x.slot)
    const loaded = cohort.filter((x) => x.loaded && !out(x)).length
    const waiting = cohort.filter((x) => !x.loaded && !out(x)).length
    // Nobody on the grid: nothing to release — unless nobody is coming at all,
    // when releasing settles the race (every verdict in) and `again` can end it.
    if (loaded === 0 && waiting > 0) return
    const now = this.#host.now()
    // No release on departure (king-tide's lesson): a socket that drops while
    // a slow machine loads is indistinguishable from one that left, and the
    // timeout already bounds the wait for the one that really did.
    const everyone = waiting === 0
    const timedOut = now >= r.loadingSince + ROOM_LOAD_TIMEOUT_MS
    if (!everyone && !timedOut) return
    r.stage = 'released'
    r.goAt = now + s.countdown + ROOM_START_MARGIN_MS
    await this.#save()
    // Only to racers on the grid. One still loading hears its own GO when it
    // reports `loaded`, so it never counts down to a GO it cannot make.
    for (const c of this.#host.connections()) {
      const slot = connSlot(c)
      const p = slot === null ? undefined : this.#player(slot)
      if (p && p.conn === c.id && p.loaded) c.send(JSON.stringify(this.#startFor(p)))
    }
    // DEV-436: the broadcaster watches the field's GO.
    this.#toFeed(
      JSON.stringify({
        type: 'start',
        goAt: r.goAt,
        field: r.goAt,
        goAts: this.#goAts(),
        race: r.race as RoomRace,
      } satisfies ServerMessage),
    )
    await this.#syncAlarm()
  }

  #startFor(p: StoredPlayer): ServerMessage {
    const r = this.#room
    const field = r.goAt as number
    return {
      type: 'start',
      goAt: p.goAt ?? field,
      field,
      goAts: this.#goAts(),
      race: r.race as RoomRace,
    }
  }

  #goAts(): Record<number, number> {
    const out: Record<number, number> = {}
    for (const x of this.#room.players) if (x.goAt !== null) out[x.slot] = x.goAt
    return out
  }

  // ── Liveness (see the header) ─────────────────────────────────────────────

  async #sweep(closing: string | null): Promise<void> {
    const r = this.#room
    const live = new Set<string>()
    for (const c of this.#host.connections()) {
      if (c.id !== closing && connSlot(c) !== null) live.add(c.id)
    }
    const now = this.#host.now()
    const departed: StoredPlayer[] = []
    for (const p of r.players) {
      if (p.left === null && (p.conn === null || !live.has(p.conn))) departed.push(p)
    }
    if (departed.length === 0) return
    const inLobby = r.stage === 'lobby'
    for (const p of departed) {
      p.conn = null
      p.left = now
      this.#lastPose.delete(`${p.slot}:0:0`)
    }
    if (inLobby) r.players = r.players.filter((p) => p.left === null)
    const empty = this.#presentCount() === 0
    if (empty && inLobby) {
      await this.#clear()
      return
    }
    if (empty) r.emptySince = now
    await this.#save()
    const owner = this.owner()
    for (const p of departed) {
      this.#broadcast({ type: 'player-left', slot: p.slot, owner, held: !inLobby }, null)
    }
    await this.#syncAlarm()
  }

  async #maybeClearEmpty(): Promise<void> {
    const r = this.#room
    if (r.emptySince === null || this.#presentCount() > 0) return
    if (this.#host.now() >= r.emptySince + ROOM_REJOIN_MS) await this.#clear()
  }

  async #clear(): Promise<void> {
    const kept = this.#room.keptLaps
    const tv = this.#room.tv
    const listed = this.#room.settings?.listed === true || this.#listSaid !== null
    this.#room = freshRoom()
    this.#lastPose.clear()
    // DEV-479: the TV id goes with the room; the guide drops it, and its links die.
    this.#tvSaid = null
    if (tv !== undefined) this.#host.announce?.(tv, null)
    // DEV-633: off the directory, if it was public, whether or not THIS
    // instance listed it (an evicted room's listing would otherwise wait out its hold).
    this.#listSaid = null
    if (listed) this.#host.list?.(null)
    // Rooms keep nothing after they empty (§6.10, `/privacy`): the laps too.
    for (const slot of kept) await this.#host.storage.delete(`lap:${slot}`)
    await this.#host.storage.delete(STORAGE_KEY)
    await this.#syncAlarm()
  }

  // ── DNF (DEV-390, §6.5) ───────────────────────────────────────────────────

  /** When a cohort racer's time runs out: its own GO, the limit, and the judge's grace. */
  #deadlineOf(p: StoredPlayer): number | null {
    const r = this.#room
    const limit = r.settings?.timeLimit ?? 0
    const go = p.goAt ?? r.goAt
    return limit > 0 && go !== null ? go + limit + ROOM_JUDGE_GRACE_MS : null
  }

  /**
   * Mark as DNF every cohort racer with no result whose time ran out (`dnf`),
   * or whose seat was not reclaimed within `ROOM_REJOIN_MS` of leaving (`left`).
   */
  async #settle(): Promise<void> {
    const r = this.#room
    if (r.stage !== 'released') return
    const now = this.#host.now()
    let changed = false
    for (const p of r.players) {
      if (!r.cohort.includes(p.slot) || r.results.some((x) => x.slot === p.slot)) continue
      const deadline = this.#deadlineOf(p)
      const gone = p.left !== null && now >= p.left + ROOM_REJOIN_MS
      const out = deadline !== null && now >= deadline
      if (!gone && !out) continue
      r.results.push({
        slot: p.slot,
        verdict: gone ? 'left' : 'dnf',
        ticks: null,
        seconds: null,
        rings: 0,
        ringsTotal: 0,
        score2016: null,
        tainted: false,
        variant: p.variant,
      })
      changed = true
    }
    if (!changed) return
    await this.#save()
    this.#broadcastResults()
  }

  #broadcastResults(): void {
    const r = this.#room
    this.#broadcast({ type: 'results', results: r.results, bots: r.botFinishes }, null)
  }

  async #syncAlarm(): Promise<void> {
    const r = this.#room
    let at: number | null = null
    const earliest = (t: number) => {
      at = at === null ? t : Math.min(at, t)
    }
    // Only a deadline still ahead. Past the timeout with nobody on the grid,
    // the first `loaded` releases the field; an alarm set in the past fires at
    // once, and would fire again after every wake — a loop that bills.
    const now = this.#host.now()
    const barrier = r.loadingSince === null ? null : r.loadingSince + ROOM_LOAD_TIMEOUT_MS
    if (r.stage === 'loading' && barrier !== null && barrier > now) earliest(barrier)
    if (r.emptySince !== null && this.#presentCount() === 0) {
      earliest(r.emptySince + ROOM_REJOIN_MS)
    }
    // DEV-390: a cohort racer's time running out, or its held seat expiring.
    if (r.stage === 'released') {
      for (const p of r.players) {
        if (!r.cohort.includes(p.slot) || r.results.some((x) => x.slot === p.slot)) continue
        const deadline = this.#deadlineOf(p)
        if (deadline !== null && deadline > now) earliest(deadline)
        if (p.left !== null && p.left + ROOM_REJOIN_MS > now) earliest(p.left + ROOM_REJOIN_MS)
      }
    }
    if (at === this.#alarmAt) return
    this.#alarmAt = at
    await this.#host.setAlarm(at)
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  #admitRate(conn: RoomConnection): boolean {
    const now = this.#host.now()
    const b = this.#buckets.get(conn.id) ?? { tokens: ROOM_RATE_BURST, at: now }
    b.tokens = Math.min(ROOM_RATE_BURST, b.tokens + ((now - b.at) * ROOM_RATE_PER_SECOND) / 1000)
    b.at = now
    this.#buckets.set(conn.id, b)
    if (b.tokens < 1) return false
    b.tokens -= 1
    return true
  }

  #player(slot: number): StoredPlayer | undefined {
    return this.#room.players.find((p) => p.slot === slot)
  }

  #connection(id: string): RoomConnection | null {
    for (const c of this.#host.connections()) if (c.id === id) return c
    return null
  }

  #presentCount(): number {
    return this.#room.players.filter((p) => p.left === null && p.conn !== null).length
  }

  #colourTaken(colour: number, exceptSlot: number): boolean {
    return this.#room.players.some(
      (p) => p.slot !== exceptSlot && p.left === null && p.colour === colour,
    )
  }

  #freeColour(colours: number): number {
    for (let c = 0; c < colours; c++) if (!this.#colourTaken(c, -1)) return c
    return 0
  }

  #view(p: StoredPlayer): RoomPlayerView {
    return {
      handle: p.handle,
      variant: p.variant,
      colour: p.colour,
      ready: p.ready,
      joinSeq: p.joinSeq,
      present: p.left === null && p.conn !== null,
    }
  }

  #hello(conn: RoomConnection, p: StoredPlayer): void {
    const r = this.#room
    const goAts = this.#goAts()
    conn.send(
      JSON.stringify({
        type: 'hello',
        protocol: ROOM_PROTOCOL,
        slot: p.slot,
        joinSeq: p.joinSeq,
        seat: p.seat,
        owner: this.owner(),
        phase: this.phase(),
        settings: r.settings,
        players: this.players(),
        race: r.race,
        goAt: r.goAt,
        goAts,
        results: r.results,
        bots: r.botFinishes,
      } satisfies ServerMessage),
    )
  }

  #broadcastLobby(): void {
    this.#broadcast(
      {
        type: 'lobby',
        owner: this.owner(),
        settings: this.#room.settings,
        players: this.players(),
        phase: this.phase(),
      },
      null,
    )
  }

  #broadcastLoading(): void {
    const r = this.#room
    this.#broadcast(
      {
        type: 'loading',
        race: r.race as RoomRace,
        loaded: r.players.filter((p) => p.loaded).map((p) => p.slot),
        deadline: (r.loadingSince as number) + ROOM_LOAD_TIMEOUT_MS,
      },
      null,
    )
  }

  /** To every joined connection but `except`. */
  #broadcast(msg: ServerMessage, except: string | null): void {
    const text = JSON.stringify(msg)
    for (const c of this.#host.connections()) {
      if (c.id !== except && connSlot(c) !== null) c.send(text)
    }
    // DEV-436: everything the players hear, the broadcaster hears too.
    this.#toFeed(text)
  }

  #error(conn: RoomConnection, code: string, reason: string): void {
    conn.send(JSON.stringify({ type: 'error', code, reason } satisfies ServerMessage))
  }

  /** The courtesy error, then the close: the CODE is the contract, the text may be lost. */
  #refuse(conn: RoomConnection, code: number, reason: string): void {
    conn.send(JSON.stringify({ type: 'error', code: String(code), reason } satisfies ServerMessage))
    conn.close(code, reason)
  }

  async #save(): Promise<void> {
    // DEV-479: a race is the first need for a TV id, and the guide hears every
    // change after it — written to storage first, as everything the room says.
    if (this.#tvDue()) this.#room.tv = mintTvId((b) => this.#host.random(b))
    await this.#host.storage.put(STORAGE_KEY, this.#room)
    this.#tellTv()
    this.#tellDirectory()
  }
}
