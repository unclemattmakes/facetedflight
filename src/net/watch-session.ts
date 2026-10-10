// src/net/watch-session.ts — a viewer's side of a room's broadcast. DEV-436.
//
// plan/MULTIPLAYER.md §13.3. What a viewer hears is what a player hears, two
// seconds late, from the broadcaster (`room-broadcast.ts`): a keyframe, the
// room's messages, and the players' pose frames in batches. So the viewer IS
// a `RoomSession` — the class the game ships and the headless race drives —
// that never sends: the keyframe goes in as a `hello` for a seat nobody holds
// (slot −1), a batch goes in frame by frame, and everything else goes in as it
// came. `game/remote-ships.ts` draws the result exactly as it draws a race for
// a player, bots included.
//
// The one difference is the clock. A viewer never pings (it may send `watch`
// and nothing else, §13.4), so its room time is read off the stream's own
// stamps instead: every batch carries the room's time at its flush, and the
// viewer's clock is set so the FRESHEST arrival reads as "now" — the race as
// it was when the broadcaster let it go (`StreamClock`).
//
// Pure: time comes in, and nothing here reads a wall clock.

import { decodePose, poseFrame } from './pose-codec'
import {
  BATCH_HEADER_BYTES,
  BATCH_TAG_V1,
  decodeBatch,
  type HelloMessage,
  type KeyframeMessage,
  ROOM_PROTOCOL,
} from './room-protocol'
import { RoomSession, type RoomSessionOptions, type SessionClock } from './room-session'

/** How many batch stamps the viewer's clock keeps: ~8 s at four a second. */
export const STREAM_CLOCK_WINDOW = 32

/**
 * A viewer's room clock, from one-way stamps: room time minus local arrival
 * time, the LARGEST over a window — the arrival that waited least — so the
 * freshest item reads as now. A late burst cannot pull the clock back; a fresh
 * one moves it forward to the stream it came with.
 */
export class StreamClock implements SessionClock {
  readonly #window: number[] = []
  #next = 0
  #estimate = 0
  #synced = false
  smooth = false

  get synced(): boolean {
    return this.#synced
  }
  get offset(): number {
    return this.#estimate
  }
  /** No round trip: a stamp is one way. */
  get rtt(): number {
    return 0
  }

  /** `t0` is ignored: a stamp's arrival is `t1`. */
  sample(_t0: number, room: number, t1: number): void {
    const d = room - t1
    if (this.#window.length < STREAM_CLOCK_WINDOW) this.#window.push(d)
    else this.#window[this.#next] = d
    this.#next = (this.#next + 1) % STREAM_CLOCK_WINDOW
    let best = Number.NEGATIVE_INFINITY
    for (const x of this.#window) if (x > best) best = x
    this.#estimate = best
    this.#synced = true
  }

  now(local: number): number {
    return local + this.#estimate
  }
}

/** A batch's room time without taking its frames apart, or null. */
const batchTime = (bytes: Uint8Array): number | null =>
  bytes.byteLength >= BATCH_HEADER_BYTES && bytes[0] === BATCH_TAG_V1
    ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(4, true)
    : null

export class WatchSession {
  readonly session: RoomSession
  /** The broadcaster's delay, ms, from its keyframe; null before one. */
  delay: number | null = null
  /** Keyframes and batches heard, for the log and the specs. */
  keyframes = 0
  batches = 0
  readonly #frame = poseFrame()

  constructor(options: Omit<RoomSessionOptions, 'clock'> = {}) {
    this.session = new RoomSession(
      // A viewer never speaks to the room; the session's pings go nowhere.
      { send: () => {} },
      { handle: 'viewer', variant: 'standard', colour: 0, content: '0'.repeat(16) },
      { ...options, clock: new StreamClock() },
    )
  }

  /** The `watch` a viewer sends, once, when its socket opens. */
  static hello(): string {
    return JSON.stringify({ type: 'watch', protocol: ROOM_PROTOCOL })
  }

  /** One message from the broadcaster, at local time `local`. */
  receive(data: string | ArrayBuffer | Uint8Array, local: number): void {
    if (typeof data === 'string') {
      if (data.startsWith('{"type":"keyframe"')) {
        this.#keyframe(JSON.parse(data) as KeyframeMessage, local)
        return
      }
      this.session.receive(data, local)
      return
    }
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
    const stamp = batchTime(bytes)
    if (stamp === null) {
      // A single frame: the newest a seat sent, right after a keyframe.
      if (decodePose(bytes, this.#frame)) this.session.receive(bytes, local)
      return
    }
    this.batches++
    // The stamp first: the frames' lateness is read off this clock.
    this.session.clock.sample(local, stamp, local)
    decodeBatch(bytes, (frame) => this.session.receive(frame, local))
  }

  /** The race as it stands: a `hello` for a seat nobody holds. */
  #keyframe(k: KeyframeMessage, local: number): void {
    this.keyframes++
    this.delay = k.delay
    const hello: HelloMessage = {
      type: 'hello',
      protocol: k.protocol,
      slot: -1,
      joinSeq: -1,
      seat: '',
      owner: k.owner,
      phase: k.phase,
      settings: k.settings,
      players: k.players,
      race: k.race,
      goAt: k.field,
      goAts: k.goAts,
      results: k.results,
      bots: k.bots,
    }
    this.session.clock.sample(local, k.now, local)
    this.session.receive(JSON.stringify(hello), local)
    // A viewer's "own GO" is the field's: it draws everyone from it.
    if (k.field !== null) this.session.goAt = k.field
  }
}
