// src/net/room-broadcast.ts — a room's broadcaster: SourceTV on a Durable Object. DEV-436.
//
// plan/MULTIPLAYER.md §13. The room never sees a viewer: this object holds
// them. When the first asks to `watch`, it opens ONE socket to the room (the
// shell's `openFeed`, on `ROOM_FEED_PATH`), and the room sends down it a
// `keyframe`, every message it tells its players, and their poses batched
// every `BROADCAST_FLUSH_MS` (`room-server.ts`). Everything that arrives here
// waits `BROADCAST_DELAY_MS`, then goes to every viewer, in order — so the
// room's work does not depend on how many watch, and a viewer sees the race
// as it was two seconds ago, smoothly (`watch-session.ts` draws it).
//
// A viewer who comes late gets the race as of the last item let go: a
// keyframe built HERE (the room's, advanced by every message since), then the
// newest pose frame each seat sent, then the stream. Viewers are receive-only:
// `watch` is the one message one ever sends.
//
// Pure, like `RoomServer`: an injected clock, connection list and timers, so
// the whole broadcaster is a node test (`tests/unit/room-broadcast.test.ts`).
// The timers are in memory on purpose: the object holds an outbound socket
// while it feeds, which keeps it awake, and an alarm per release would bill a
// request four times a second (§13.2).
//
// DEV-479 (plan/FF-TV.md §2.3): an ANONYMOUS audience. A socket that reached
// this object on `TV_WATCH_PATH` — the internal path only the TV Function's
// forward can put a request on — is marked when it connects, and from its
// `watch` on it is sent every text item with each handle replaced by
// *Racer N* (`tv-anon.ts`), the copy made once per item, not per viewer. Pose
// batches carry no names and go to everyone unchanged. A link viewer — the
// Spectators row's `?watch=` link, which a player chose to send — still hears
// the names, as before. The stripping is HERE, before a byte leaves for a TV
// viewer: never a client hiding a name it was sent.

import {
  BROADCAST_DELAY_MS,
  BROADCAST_IDLE_MS,
  BROADCAST_MAX_VIEWERS,
  CLOSE,
  decodeBatch,
  type KeyframeMessage,
  POSE_AT,
  POSE_TAG_V1,
  parseWatchMessage,
  ROOM_KEEPALIVE,
  ROOM_PROTOCOL,
  ROOM_TEXT_MAX,
  type ServerMessage,
} from './room-protocol'
import type { RoomConnection } from './room-server'
import { anonymiseText } from './tv-anon'

/** A viewer's socket: a room connection whose attachment is a viewer's. */
export type BroadcastConnection = Omit<RoomConnection, 'setState'> & {
  setState(state: ViewerState | null): unknown
}

export interface BroadcastTimers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export interface BroadcastHost {
  /** Wall time, ms: `Date.now()` in the object. Only differences are read. */
  now(): number
  /** Every viewer socket, watching or not yet. */
  connections(): Iterable<BroadcastConnection>
  /** Open the feed to the room. The shell answers with `onFeedOpen`, `onFeedMessage`, `onFeedClose`. */
  openFeed(): void
  closeFeed(): void
  readonly timers: BroadcastTimers
}

/**
 * A viewer's attachment: it has asked to watch. `anonymous` (DEV-479) for a
 * socket that came through TV, set at connect and kept when it watches; it
 * survives hibernation with the socket, as the rest does.
 */
interface ViewerState {
  readonly viewer?: true
  readonly anonymous?: true
}

const isViewer = (c: BroadcastConnection): boolean =>
  (c.state as ViewerState | null)?.viewer === true

const isAnonymous = (c: BroadcastConnection): boolean =>
  (c.state as ViewerState | null)?.anonymous === true

/** One item in the two forms a viewer may be sent, the anonymised one made at most once. */
class Forms {
  #anon: string | null = null
  constructor(readonly text: string) {}
  for(conn: BroadcastConnection): string {
    if (!isAnonymous(conn)) return this.text
    this.#anon ??= anonymiseText(this.text)
    return this.#anon
  }
}

/** A `Blob`, by what it can do: the platform's is not always this realm's class. */
const isBlob = (d: unknown): d is Blob =>
  typeof d === 'object' &&
  d !== null &&
  !(d instanceof ArrayBuffer) &&
  !ArrayBuffer.isView(d) &&
  typeof (d as Blob).arrayBuffer === 'function'

/** A feed frame as the queue keeps it: text as text, bytes as a copy of their own. */
const bytesOf = (d: string | ArrayBuffer | ArrayBufferView): string | Uint8Array =>
  typeof d === 'string'
    ? d
    : d instanceof ArrayBuffer
      ? new Uint8Array(d.slice(0))
      : new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength))

/** One item from the room, waiting out the delay. */
interface Held {
  readonly at: number
  readonly data: string | Uint8Array
}

/** Counters, for the gates and the log. */
export interface BroadcastCounts {
  /** Items the feed brought: text messages and pose batches. */
  feedIn: number
  /** Messages sent to viewers, keyframes and the latest frames included. */
  viewersOut: number
  /** Feeds opened: one per watched stretch, plus a reopen after a drop. */
  feedsOpened: number
}

type FeedStatus = 'closed' | 'opening' | 'open'

/** A dropped feed is asked for again after this long, so a room that refuses is not hammered. */
export const BROADCAST_FEED_RETRY_MS = 1000

export class BroadcastServer {
  readonly #host: BroadcastHost
  readonly #queue: Held[] = []
  #head = 0
  /** The race as of the last item let go; null until the room's keyframe has been. */
  #keyframe:
    | {
        -readonly [K in keyof KeyframeMessage]: KeyframeMessage[K]
      }
    | null = null
  /** Each seat's newest let-go pose frame, for a viewer who joins now. */
  readonly #latest = new Map<number, Uint8Array>()
  #feed: FeedStatus = 'closed'
  /** Feed items still being read (a `Blob`), and the chain that keeps them in order. */
  #reading = 0
  #inbox: Promise<void> = Promise.resolve()
  #release: unknown = null
  #idle: unknown = null
  readonly counts: BroadcastCounts = { feedIn: 0, viewersOut: 0, feedsOpened: 0 }

  constructor(host: BroadcastHost) {
    this.#host = host
  }

  get feedStatus(): FeedStatus {
    return this.#feed
  }

  /** Viewers watching now. */
  viewers(): number {
    let n = 0
    for (const c of this.#host.connections()) if (isViewer(c)) n++
    return n
  }

  /**
   * The object woke (from hibernation, or after an eviction) with viewers still
   * connected: its feed did not survive it, so ask the room for a new one, and
   * with it a fresh keyframe for everyone.
   */
  start(): void {
    if (this.viewers() > 0 && this.#feed === 'closed') this.#openFeed()
  }

  // ── Viewers ─────────────────────────────────────────────────────────────

  /**
   * A socket opened. `anonymous` when it arrived on `TV_WATCH_PATH` (the shell
   * decides, by the path no public route forwards): marked now, so the mark is
   * the server's and nothing the socket says can lift it.
   */
  onConnect(conn: BroadcastConnection, anonymous = false): void {
    if (anonymous) conn.setState({ anonymous: true })
  }

  onMessage(conn: BroadcastConnection, message: string | ArrayBuffer | ArrayBufferView): void {
    if (typeof message !== 'string' || message.length > ROOM_TEXT_MAX) return
    if (message === ROOM_KEEPALIVE.request) {
      conn.send(ROOM_KEEPALIVE.response)
      return
    }
    if (isViewer(conn)) return
    const watch = parseWatchMessage(message)
    if (!watch) return
    if (watch.protocol !== ROOM_PROTOCOL) {
      conn.send(JSON.stringify({ type: 'error', code: String(CLOSE.mismatch), reason: 'protocol' }))
      conn.close(CLOSE.mismatch, 'protocol')
      return
    }
    if (this.viewers() >= BROADCAST_MAX_VIEWERS) {
      conn.close(CLOSE.full, 'too many watching')
      return
    }
    conn.setState(isAnonymous(conn) ? { viewer: true, anonymous: true } : { viewer: true })
    if (this.#idle !== null) {
      this.#host.timers.clear(this.#idle)
      this.#idle = null
    }
    this.#greet(conn, this.#greeting())
    if (this.#feed === 'closed') this.#openFeed()
  }

  onClose(_conn: BroadcastConnection): void {
    this.#idleCheck()
  }

  // ── The feed ────────────────────────────────────────────────────────────

  onFeedOpen(): void {
    this.#feed = 'open'
  }

  /**
   * One item from the room. It waits `BROADCAST_DELAY_MS`, then goes to every viewer.
   *
   * A binary frame may arrive as a `Blob`: a Cloudflare Worker's WebSocket
   * defaults to `binaryType: 'blob'` from `websocket_standard_binary_type`
   * (on from 2026-03-17; the rooms Worker is dated after it), and the shell's
   * feed is a plain outbound WebSocket, not the hibernation API's. That was
   * the platform failure of 2026-09-27: the keyframe (text) through, every
   * batch (binary) thrown away in the listener. The shell now asks for
   * `arraybuffer`; a Blob is still taken, read asynchronously, and everything
   * after it waits its turn, so the viewers' order is the room's.
   */
  onFeedMessage(data: string | ArrayBuffer | ArrayBufferView | Blob): void {
    const at = this.#host.now()
    this.counts.feedIn++
    if (!isBlob(data) && this.#reading === 0) {
      this.#take(at, bytesOf(data))
      return
    }
    this.#reading++
    const read: Promise<string | ArrayBuffer | ArrayBufferView> = isBlob(data)
      ? data.arrayBuffer()
      : Promise.resolve(data)
    this.#inbox = this.#inbox
      .then(() => read)
      .then(
        (d) => this.#take(at, bytesOf(d)),
        (err: unknown) => console.warn('watch: a feed frame could not be read', err),
      )
      .finally(() => {
        this.#reading--
      })
  }

  /** Into the delay queue, stamped with when it ARRIVED. */
  #take(at: number, item: string | Uint8Array): void {
    this.#queue.push({ at, data: item })
    this.#schedule()
  }

  /**
   * The room dropped the feed — it was evicted, or restarted. The race so far
   * still goes out on time; with anyone still watching, a new feed (and with it
   * a fresh keyframe from the room) is asked for at once.
   */
  onFeedClose(): void {
    this.#feed = 'closed'
    if (this.viewers() === 0) return
    this.#host.timers.set(() => {
      if (this.#feed === 'closed' && this.viewers() > 0) this.#openFeed()
    }, BROADCAST_FEED_RETRY_MS)
  }

  // ── Internals ───────────────────────────────────────────────────────────

  #openFeed(): void {
    this.#feed = 'opening'
    this.counts.feedsOpened++
    this.#host.openFeed()
  }

  /** Let go of everything that has waited long enough, then wake for the next. */
  #schedule(): void {
    if (this.#release !== null) return
    const next = this.#queue[this.#head]
    if (!next) return
    const wait = Math.max(0, next.at + BROADCAST_DELAY_MS - this.#host.now())
    this.#release = this.#host.timers.set(() => {
      this.#release = null
      this.#letGo()
      this.#schedule()
    }, wait)
  }

  #letGo(): void {
    const now = this.#host.now()
    while (this.#head < this.#queue.length) {
      const held = this.#queue[this.#head] as Held
      if (held.at + BROADCAST_DELAY_MS > now) break
      this.#head++
      this.#apply(held.data)
      this.#fanOut(held.data)
    }
    // Compact now and then, so the queue does not grow for a whole race.
    if (this.#head > 256) {
      this.#queue.splice(0, this.#head)
      this.#head = 0
    }
  }

  #fanOut(data: string | Uint8Array): void {
    // The room's own keyframe is for this object; viewers get theirs from `#greet`.
    if (typeof data === 'string' && data.startsWith('{"type":"keyframe"')) {
      const greeting = this.#greeting()
      for (const c of this.#host.connections()) if (isViewer(c)) this.#greet(c, greeting)
      return
    }
    // DEV-479: text in its two forms, the anonymised one made once for every TV viewer.
    const forms = typeof data === 'string' ? new Forms(data) : null
    for (const c of this.#host.connections()) {
      if (!isViewer(c)) continue
      c.send(forms ? forms.for(c) : data)
      this.counts.viewersOut++
    }
  }

  /** The keyframe a viewer is greeted with now, in both forms; null before the room's has gone. */
  #greeting(): Forms | null {
    const k = this.#keyframe
    return k ? new Forms(JSON.stringify({ ...k, delay: BROADCAST_DELAY_MS })) : null
  }

  /** The keyframe as of what has been let go, then each seat's newest frame. */
  #greet(conn: BroadcastConnection, greeting: Forms | null): void {
    if (!greeting) return
    conn.send(greeting.for(conn))
    this.counts.viewersOut++
    for (const frame of this.#latest.values()) {
      conn.send(frame)
      this.counts.viewersOut++
    }
  }

  /** Advance the delayed race by one item the viewers are about to see. */
  #apply(data: string | Uint8Array): void {
    if (typeof data !== 'string') {
      const roomTime = decodeBatch(data, (frame) => {
        if (frame[POSE_AT.tag] === POSE_TAG_V1) {
          this.#latest.set(frame[POSE_AT.slot] as number, frame.slice())
        }
      })
      if (roomTime !== null && this.#keyframe) this.#keyframe.now = roomTime
      return
    }
    let msg: (ServerMessage | KeyframeMessage) & { type: string }
    try {
      msg = JSON.parse(data)
    } catch {
      return
    }
    if (msg.type === 'keyframe') {
      this.#keyframe = { ...(msg as KeyframeMessage) }
      this.#latest.clear()
      return
    }
    const k = this.#keyframe
    if (!k) return
    const m = msg as ServerMessage
    switch (m.type) {
      case 'player-joined':
        k.players = { ...k.players, [m.slot]: m.player }
        k.owner = m.owner
        return
      case 'player-left': {
        const players = { ...k.players }
        const p = players[m.slot]
        if (!m.held) delete players[m.slot]
        else if (p) players[m.slot] = { ...p, present: false }
        k.players = players
        k.owner = m.owner
        if (!m.held) this.#latest.delete(m.slot)
        return
      }
      case 'lobby':
        k.owner = m.owner
        k.settings = m.settings
        k.players = m.players
        k.phase = m.phase
        return
      case 'loading':
        if (k.phase !== 'loading') {
          k.results = []
          k.bots = []
          k.field = null
          k.goAts = {}
          this.#latest.clear()
        }
        k.phase = 'loading'
        k.race = m.race
        return
      case 'start':
        k.phase = 'countdown'
        k.field = m.field
        k.goAts = m.goAts
        k.race = m.race
        return
      case 'late':
        k.goAts = { ...k.goAts, [m.slot]: m.goAt }
        return
      case 'results':
        k.results = m.results
        k.bots = m.bots
        return
      default:
        return
    }
  }

  /** Nobody watching: drop the feed after a grace, so a race nobody watches costs nothing. */
  #idleCheck(): void {
    if (this.viewers() > 0 || this.#idle !== null || this.#feed === 'closed') return
    this.#idle = this.#host.timers.set(() => {
      this.#idle = null
      if (this.viewers() > 0) return
      this.#feed = 'closed'
      this.#host.closeFeed()
    }, BROADCAST_IDLE_MS)
  }
}
