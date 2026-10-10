// src/game/room-client.ts — the game's side of a room: one socket, and the session on it. DEV-388.
//
// plan/MULTIPLAYER.md §6.2, §6.9, §9.1. `net/room-session.ts` speaks the
// protocol over ANY transport and is what the headless race drives; this file
// is the socket around it that the game ships:
//
//   - the room's URL, from ONE function (§6.2: the game's own origin, so no
//     second hostname is ever baked into a build);
//   - reconnection, ~100 lines in place of `partysocket` (§8 DEV-386 left the
//     dependency optional; one fewer package to land alone). A dropped socket
//     comes back with backoff and rejoins with its SEAT TOKEN, so the room
//     hands back the same seat for `ROOM_REJOIN_MS`;
//   - the close codes, which are the contract (§7.1): every 4xxx stops the
//     retrying and is turned into one plain line for the player;
//   - the lobby keep-alive, which the platform answers without waking the room.
//
// Control messages written while the socket is down are queued and sent after
// the rejoin (a `finish` must not be lost to a blip); pose messages are
// dropped, because the next one is 49 ms away and supersedes it.
//
// THREE-free and DOM-free: the socket, the clock and the timers come in, so
// the whole lifecycle is a node test (`tests/unit/room-client.test.ts`).

import type { PoseRecord } from '@/net/pose-codec'
import {
  CLOSE,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_CODE_SHAPE,
  ROOM_ID_SHAPE,
  ROOM_KEEPALIVE,
  ROOM_REJOIN_MS,
  type RoomPlayerView,
  type RoomSettings,
  type RoomVerdict,
} from '@/net/room-protocol'
import { type RoomIdentity, RoomSession, type RoomSessionOptions } from '@/net/room-session'
import type { Quat } from '@/sim/math/quat'
import type { Vec3 } from '@/sim/math/vec3'

// ── Where a room is ─────────────────────────────────────────────────────────

/**
 * THE room URL (§6.2): the page's own origin, `/api/room/<id>`, over `wss`
 * where the page is `https`. The Pages Function there hands the socket to the
 * room. If that route ever has to change to the Worker's own hostname (§6.2's
 * fallback), this is the one line that changes.
 */
export const roomUrl = (
  id: string,
  location: { readonly protocol: string; readonly host: string },
): string => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/room/${id}`

/**
 * DEV-441b: a short code as a person writes it — any case, grouped with a
 * space or a dash (`k7q-x4m`) — in its canonical form, or null when it is not
 * one. Nothing is guessed: a letter outside the alphabet (an O for a zero, an
 * I for a one) is not quietly read as another, it is not a code.
 */
export const roomCodeFrom = (value: string): string | null => {
  const code = value.replace(/[\s-]+/g, '').toUpperCase()
  return ROOM_CODE_SHAPE.test(code) ? code : null
}

/**
 * A `?room=` value, or null when it is not a room's. A long id as it is (a
 * link made before DEV-441b); otherwise a short code, canonical, however it
 * was cased or grouped — so the id this returns is always the room's name.
 */
export const roomIdFrom = (value: string | null): string | null => {
  if (value === null) return null
  if (ROOM_ID_SHAPE.test(value)) return value
  return roomCodeFrom(value)
}

/**
 * This build's generated content, as one short digest: FNV-1a 64 over the
 * manifest `pnpm extract:check` verifies (`content/_generated.sha256`, which
 * holds the SHA-256 of every level, environment and ghost). Two builds whose
 * placements differ cannot share a room: a prop id (§6.7) would name two
 * different trees. The room compares it at `join` (4002). Sixteen hex chars.
 */
export const contentDigest = (manifest: string): string => {
  let h = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  // CRLF and LF checkouts of one manifest are one build.
  for (const ch of manifest.replace(/\r\n/g, '\n')) {
    h ^= BigInt(ch.codePointAt(0) as number)
    h = (h * prime) & mask
  }
  return h.toString(16).padStart(16, '0')
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

/**
 * A fresh, unguessable room id: 16 base32 characters, 80 bits (§6.9 asks for ≥ 10).
 * What every room was until DEV-441b; the title hosts with `newRoomCode` now.
 */
export const newRoomId = (randomBytes: (n: number) => Uint8Array): string =>
  Array.from(randomBytes(16), (b) => BASE32.charAt(b & 31)).join('')

/**
 * DEV-441b: a fresh room CODE — `ROOM_CODE_LENGTH` characters of
 * `ROOM_CODE_ALPHABET`, each uniform. A byte is kept only below the largest
 * multiple of the alphabet's size (252 for 28) and the rest are drawn again,
 * so no character is likelier than another: `b % 28` over all 256 bytes would
 * make the first four one-ninth likelier, which is a smaller keyspace than the
 * row claims.
 */
export const newRoomCode = (randomBytes: (n: number) => Uint8Array): string => {
  let out = ''
  while (out.length < ROOM_CODE_LENGTH) {
    for (const b of randomBytes(ROOM_CODE_LENGTH * 2)) {
      const ch = roomCodeCharOf(b)
      if (ch === null) continue
      out += ch
      if (out.length === ROOM_CODE_LENGTH) break
    }
  }
  return out
}

/** One random byte's character, or null for a byte past the alphabet's last whole multiple. */
export const roomCodeCharOf = (byte: number): string | null => {
  const n = ROOM_CODE_ALPHABET.length
  return byte < 256 - (256 % n) ? ROOM_CODE_ALPHABET.charAt(byte % n) : null
}

/** Is this room id a short code (DEV-441b), rather than a long id from an older link? */
export const isRoomCode = (id: string): boolean => ROOM_CODE_SHAPE.test(id)

/**
 * DEV-459: the `sessionStorage` key of this TAB's own token, sent on every
 * join (`join.page`) so a page the owner removed stays out on a reload
 * (`boot/app.ts` makes and keeps it). Exported for `/privacy`, which names it
 * (DEV-470, `net/privacy-page.ts`'s `PRIVACY_BROWSER_STORES`).
 */
export const ROOM_PAGE_STORE = 'ff2.room.page.v1'

// ── The socket ──────────────────────────────────────────────────────────────

/** The slice of the browser's `WebSocket` this uses. */
export interface RoomSocket {
  binaryType: string
  readonly readyState: number
  send(data: string | ArrayBufferView | ArrayBuffer): void
  close(code?: number, reason?: string): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { readonly data: unknown }) => void) | null
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null
  onerror: ((event: unknown) => void) | null
}

/** `WebSocket.OPEN`. */
const OPEN = 1

export interface RoomTimers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

/** Backoff between reconnects, ms; the last repeats. */
export const ROOM_RETRY_MS: readonly number[] = [250, 500, 1000, 2000, 4000]
/** Past this long without a socket, the seat is gone anyway (§6.9): stop. */
export const ROOM_RETRY_GIVE_UP_MS = ROOM_REJOIN_MS
/** The lobby's keep-alive, ms: well inside any idle cut-off, never a billed wake. */
export const ROOM_KEEPALIVE_MS = 30_000
/** Control messages kept while the socket is down; more than this and the oldest go. */
export const ROOM_QUEUE_MAX = 64

export type RoomStatus = 'connecting' | 'open' | 'retrying' | 'closed'

/**
 * What the player is told when a room closes on them (§7.1, §6.2). One line
 * each, plain words, and never a spinner: a closed room says it is closed.
 */
export const roomNotice = (code: number | null, reason = ''): string | null => {
  switch (code) {
    case null:
      return null
    case CLOSE.full:
      return 'That room is full.'
    case CLOSE.started:
      return reason === 'seat expired'
        ? 'You were away too long — the race went on without you.'
        : 'That race has already started.'
    case CLOSE.mismatch:
      return 'Your game is a different version from the room — reload to update it.'
    case CLOSE.abuse:
      return 'The room closed the connection.'
    case CLOSE.missing:
      return 'There is no room with that code.'
    case CLOSE.replaced:
      return 'This room was opened again in another window.'
    case CLOSE.forbidden:
      return 'Rooms can only be joined from the game itself.'
    case CLOSE.kicked:
      return "The room's owner removed you from this room."
    case ROOM_RESTING:
      return 'Multiplayer is resting until 00:00 UTC — solo play is unaffected.'
    case ROOM_OFF:
      // DEV-470: what a release player meets before production's rooms are
      // bound (docs/rooms.md). Short enough for the lobby's Leave row, whose
      // note clipped a longer line at about fifty characters in the release
      // build's photograph; the row itself is the way back to solo play.
      // DEV-542: Matt found "Multiplayer is not available on this site."
      // confusing (which site? why not?). It says what is true for the player
      // — online races are not switched on yet — and what to do instead, in
      // 40 characters: a 48-character draft fitted the Leave row with nothing
      // to spare and was squeezed on the title's Multiplayer door (photographed).
      return "Online races aren't open yet: fly solo."
    case ROOM_UNREACHABLE:
      return 'The room could not be reached.'
    default:
      return code >= 4000 && code < 5000 ? 'The room closed the connection.' : null
  }
}

/**
 * The client's own codes for a room that never answered, read off the route's
 * HTTP answer after a failed handshake (`diagnose`): outside the 4xxx the room
 * sends, so the two cannot be confused.
 */
export const ROOM_RESTING = 4901
export const ROOM_OFF = 4902
export const ROOM_UNREACHABLE = 4903

/**
 * What a failed handshake meant, from a plain GET of the same path. The route
 * answers `426` to anything but an upgrade, so `426` says the site is fine and
 * the ROOM did not answer; `503` is an environment with no `ROOMS` binding —
 * which the route says to the GET as well as to the upgrade since DEV-470
 * (`net/room-route.ts`'s `roomsOff`: before it, this read 426 there, and a site
 * with no rooms looked like a room that missed); `429` is the Free plan's day
 * spent. **Unverified** which status the platform
 * really sends at the quota (§6.2): 429 is Cloudflare's documented answer for a
 * Worker over its daily limit, and anything else is "unreachable" rather than
 * a guess.
 */
export const diagnoseStatus = (status: number): number =>
  status === 429 ? ROOM_RESTING : status === 503 ? ROOM_OFF : ROOM_UNREACHABLE

export interface RoomClientOptions {
  readonly url: string
  readonly identity: RoomIdentity
  /** The local clock, ms: `performance.now()` in the game. */
  readonly now: () => number
  readonly socket?: (url: string) => RoomSocket
  readonly timers?: RoomTimers
  /** A plain GET of `url`'s http(s) twin after a failed handshake. Absent: no diagnosis. */
  readonly probe?: (httpUrl: string) => Promise<number>
  readonly session?: RoomSessionOptions
  /** Every status change, for the log. */
  readonly onStatus?: (status: RoomStatus, notice: string | null) => void
}

const defaultTimers: RoomTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

export class RoomClient {
  readonly session: RoomSession
  status: RoomStatus = 'closed'
  /** The last close code that ENDED the room (4xxx, or the client's own 49xx), or null. */
  closeCode: number | null = null
  closeReason = ''
  /** Handshakes made, the first included: the reconnects are this less one. */
  connects = 0
  readonly #opts: RoomClientOptions
  readonly #timers: RoomTimers
  #socket: RoomSocket | null = null
  #retry: unknown = null
  #attempt = 0
  #downSince: number | null = null
  #everOpened = false
  #leaving = false
  #lastSent = 0
  readonly #queue: string[] = []

  constructor(opts: RoomClientOptions) {
    this.#opts = opts
    this.#timers = opts.timers ?? defaultTimers
    this.session = new RoomSession(
      { send: (data) => this.#send(data) },
      opts.identity,
      opts.session ?? {},
    )
  }

  /** The line to show the player, or null while the room is fine. */
  get notice(): string | null {
    return roomNotice(this.closeCode, this.closeReason)
  }

  connect(): void {
    if (this.#socket !== null) return
    this.#leaving = false
    this.#open()
  }

  /** Leave on purpose: no reconnect. */
  leave(): void {
    this.#leaving = true
    if (this.#retry !== null) this.#timers.clear(this.#retry)
    this.#retry = null
    this.#socket?.close(1000, 'left')
    this.#socket = null
    this.#setStatus('closed')
  }

  /** Every frame: the clock sync's schedule, and the lobby keep-alive. */
  update(): void {
    const now = this.#opts.now()
    if (this.status !== 'open') return
    this.session.update(now)
    if (this.session.goAt === null && now - this.#lastSent >= ROOM_KEEPALIVE_MS) {
      this.#raw(ROOM_KEEPALIVE.request)
    }
  }

  /** Every fixed step, with this player's mission tick: one pose message in four. */
  sendPose(tick: number, records: readonly PoseRecord[], count: number): boolean {
    return this.session.step(tick, records, count)
  }

  // ── Internals ───────────────────────────────────────────────────────────

  #open(): void {
    const make = this.#opts.socket ?? ((url: string) => new WebSocket(url) as unknown as RoomSocket)
    const ws = make(this.#opts.url)
    ws.binaryType = 'arraybuffer'
    this.#socket = ws
    this.connects++
    this.#setStatus(this.#everOpened ? 'retrying' : 'connecting')
    ws.onopen = () => {
      if (this.#socket !== ws) return
      this.#everOpened = true
      this.#attempt = 0
      this.#downSince = null
      this.#setStatus('open')
      // The join FIRST: nothing the room hears before it counts.
      this.session.join()
      for (const m of this.#queue.splice(0)) this.#raw(m)
    }
    ws.onmessage = (event) => {
      if (this.#socket !== ws) return
      const data = event.data
      if (typeof data === 'string' || data instanceof ArrayBuffer || data instanceof Uint8Array) {
        this.session.receive(data, this.#opts.now())
      }
    }
    ws.onerror = () => {}
    ws.onclose = (event) => {
      if (this.#socket !== ws) return
      this.#socket = null
      this.#closed(event.code, event.reason)
    }
  }

  #closed(code: number, reason: string): void {
    if (this.#leaving) return
    // The room's own codes are the contract: stop, and say why (§7.1).
    if (code >= 4000 && code < 5000) {
      this.closeCode = code
      this.closeReason = reason
      this.#setStatus('closed')
      return
    }
    const now = this.#opts.now()
    this.#downSince ??= now
    if (now - this.#downSince >= ROOM_RETRY_GIVE_UP_MS) {
      // A socket that never opened had no seat to lose: that is "unreachable".
      this.closeCode = this.#everOpened ? CLOSE.started : ROOM_UNREACHABLE
      this.closeReason = this.#everOpened ? 'seat expired' : ''
      this.#setStatus('closed')
      return
    }
    // Never opened at all: find out whether the site, the day's quota or the
    // room is what failed, once, before retrying a handshake that cannot work.
    if (!this.#everOpened && this.#attempt === 0 && this.#opts.probe) {
      const http = this.#opts.url.replace(/^ws/, 'http')
      void this.#opts.probe(http).then(
        (status) => {
          if (status === 426) this.#schedule()
          else {
            this.closeCode = diagnoseStatus(status)
            this.#setStatus('closed')
          }
        },
        () => this.#schedule(),
      )
      this.#attempt++
      return
    }
    this.#schedule()
  }

  #schedule(): void {
    if (this.#leaving || this.status === 'closed') return
    const wait = ROOM_RETRY_MS[Math.min(this.#attempt, ROOM_RETRY_MS.length - 1)] as number
    this.#attempt++
    this.#setStatus('retrying')
    this.#retry = this.#timers.set(() => {
      this.#retry = null
      if (!this.#leaving) this.#open()
    }, wait)
  }

  #send(data: string | Uint8Array): void {
    const ws = this.#socket
    if (ws && ws.readyState === OPEN && this.status === 'open') {
      ws.send(data)
      this.#lastSent = this.#opts.now()
      return
    }
    // Down: keep the control messages, drop the poses (the next supersedes them).
    if (typeof data === 'string') {
      this.#queue.push(data)
      if (this.#queue.length > ROOM_QUEUE_MAX) this.#queue.shift()
    }
  }

  #raw(data: string): void {
    const ws = this.#socket
    if (!ws || ws.readyState !== OPEN) return
    ws.send(data)
    this.#lastSent = this.#opts.now()
  }

  #setStatus(status: RoomStatus): void {
    if (this.status === status) return
    this.status = status
    this.#opts.onStatus?.(status, this.notice)
  }
}

// ── This player's pose, in the stream's frame (§7.2) ────────────────────────

/** What drives a pose record besides the body: the stick, and the flags. */
export interface OwnPoseInput {
  readonly pitch: number
  readonly roll: number
  readonly yaw: number
  readonly throttle: number
  readonly flags: number
}

/**
 * Fill `record` with the SIM body's pose in the stream's frame: THREE space
 * relative to the course's `worldOffset`, which is the lap recorder's frame
 * (`sim/ghost-record.ts`'s `recordPose`), so a remote track and a recorded lap
 * agree to the unit. Unity's z mirrors into THREE's: position z, and the
 * quaternion's x and y, change sign; velocity is a position's derivative and
 * flips as position does. `room-client.test.ts` holds this against
 * `recordPose` itself rather than against a copy of these lines.
 */
export const fillOwnPose = (
  record: PoseRecord,
  body: { readonly position: Vec3; readonly orientation: Quat; readonly velocity: Vec3 },
  worldOffset: readonly [number, number, number],
  input: OwnPoseInput,
): PoseRecord => {
  const [ox, oy, oz] = worldOffset
  record.kind = 0
  record.index = 0
  record.flags = input.flags
  record.px = body.position.x - ox
  record.py = body.position.y - oy
  record.pz = -body.position.z - oz
  record.qx = -body.orientation.x
  record.qy = -body.orientation.y
  record.qz = body.orientation.z
  record.qw = body.orientation.w
  record.vx = body.velocity.x
  record.vy = body.velocity.y
  record.vz = -body.velocity.z
  record.pitch = input.pitch
  record.roll = input.roll
  record.yaw = input.yaw
  record.throttle = input.throttle
  return record
}

// ── What `__ff2.room()` answers (the `__ff2` probe conventions) ─────────────

/**
 * One remote ship as drawn. `game/remote-ships.ts` fills it; declared here so
 * the probe's type pulls no three.js into anything that reads it (an e2e spec's
 * import graph included, `tests/unit/e2e-import-graph.test.ts`).
 */
export interface RemoteShipReport {
  /** A player's slot; for a bot, negative (`remote-ships.ts`'s `botPlaceSlot`). */
  readonly slot: number
  /** DEV-391: a bot's index in `race.bots`, drawn from its host's stream; null for a player. */
  readonly bot: number | null
  readonly handle: string
  readonly colour: number
  readonly loaded: boolean
  readonly visible: boolean
  readonly mode: string
  readonly stale: boolean
  /** THREE space, world. */
  readonly position: readonly [number, number, number] | null
  /** The shared tick it was drawn at in the last `update`, fractional, or null. */
  readonly renderTick: number | null
  /** Its track's adaptive delay, ms, and the newest tick it holds. */
  readonly delayMs: number | null
  readonly newestTick: number | null
  /** Cosine of the hull's nose against its direction of travel, or null below 20 m/s. */
  readonly noseAlongTrack: number | null
}

/** A room as the page sees it, for the specs and the console. Plain values, plus four verbs. */
export interface RoomProbe {
  readonly id: string
  readonly status: RoomStatus
  readonly notice: string | null
  readonly connects: number
  readonly slot: number | null
  readonly owner: number | null
  readonly phase: string | null
  readonly players: Readonly<Record<number, RoomPlayerView>>
  readonly settings: RoomSettings | null
  /** This client's GO, and the field's, room ms. */
  readonly goAt: number | null
  readonly field: number | null
  readonly clock: { readonly synced: boolean; readonly offset: number; readonly rtt: number }
  readonly roomNow: number | null
  /** `sharedTickAt(roomNow, goAt)`, fractional, or null before a GO is known. */
  readonly sharedTick: number | null
  /** This client's own mission tick (the lap clock), fractional, or null before release. */
  readonly tick: number | null
  /** Room ms the countdown started at, and the room time tick 0 corresponds to. */
  readonly countdownAt: number | null
  readonly goRoom: number | null
  readonly ships: readonly RemoteShipReport[]
  readonly stats: { frames: number; meanMs: number; maxMs: number; ships: number } | null
  resetStats(): void
  /** This client's own pose at a fractional tick, world THREE space, from the last ~12 s. */
  truth(tick: number): [number, number, number] | null
  /** DEV-389: this player's start on the human row, THREE world, or null outside a race. */
  readonly ownStart: readonly [number, number, number] | null
  /** DEV-389: where this player's ship stands, THREE world, or null with no flight. */
  readonly ownAt: readonly [number, number, number] | null
  /** The lobby's READY (with this page's aircraft and rules) and the owner's START. */
  ready(): void
  start(): void
  /** DEV-391: the owner's Bots row, set rather than toggled. Nothing from anyone else. */
  bots(on: boolean): void
  /**
   * DEV-851: the owner races the course a link token names, as COURSE does
   * for one in YOUR COURSES (the same settings, from the course itself).
   */
  course(token: string): void
  /**
   * DEV-389: the lobby plates as last drawn — the action rows (what a press
   * takes), the row under the aim, and the roster — or null while they are down.
   */
  readonly lobby: {
    readonly heading: string
    readonly aim: number
    readonly rows: readonly {
      readonly id: string
      readonly label: string
      readonly value: string | null
      readonly note: string
    }[]
    readonly roster: readonly {
      readonly label: string
      readonly value: string | null
      readonly note: string
    }[]
  } | null
  /** DEV-390: the room's verdicts, as it last listed them. */
  readonly results: readonly RoomVerdict[]
  /** DEV-391: the bots' finishes the host reported, as the room last listed them. */
  readonly botFinishes: readonly { readonly bot: number; readonly tick: number }[]
  /** DEV-390: this client's lap post: in flight (`status` 0), judged, or refused. */
  readonly posted: {
    readonly verdict: string | null
    readonly status: number
    readonly error: string | null
  } | null
  /** DEV-390: every other racer's rings as relayed: slot, then gate, then tick. */
  readonly rings: Readonly<Record<number, readonly number[]>>
  /** DEV-390: the results panel's rows as this page would draw them now, or null before the line. */
  readonly standings:
    | readonly {
        readonly name: string
        readonly you: boolean
        /** DEV-854: an AI racer (a room's bot), which the panel tags. */
        readonly ai?: boolean
        readonly status: string
        readonly seconds: number | null
        readonly place: number | null
      }[]
    | null
}
