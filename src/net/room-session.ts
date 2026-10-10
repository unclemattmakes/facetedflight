// src/net/room-session.ts — one player's side of a room, over any transport. DEV-387.
//
// The transport-agnostic half of the game's room client (plan/MULTIPLAYER.md
// §9.1): it speaks the protocol, keeps the room clock, encodes this player's
// poses and decodes everyone else's into remote tracks. DEV-388's
// `game/room-client.ts` wraps it with a real socket and the frame loop; the
// headless race (`tests/unit/helpers/room-harness.ts`) wraps it with a
// simulated link. Both drive THIS code, so the harness tests the client the
// game ships, not a copy of it (CLAUDE.md: never make the harness take a
// different code path).
//
// Pure: every call takes the local time (`performance.now()` in the game,
// the simulated clock in the harness), and sending goes through the injected
// transport. Nothing here allocates per pose, sent or received.

import { decodePose, type PoseFrame, type PoseRecord, PoseWriter, poseFrame } from './pose-codec'
import { type DrawnPose, RemoteTrack, type RemoteTrackOptions } from './remote-track'
import { ROOM_CLOCK_BURST, RoomClock, roomTimeOfTick, sharedTickAt } from './room-clock'
import {
  POSE_SEND_TICKS,
  ROOM_KEEPALIVE,
  ROOM_PROTOCOL,
  type RoomBotFinish,
  type RoomPhase,
  type RoomPlayerView,
  type RoomRace,
  type RoomSettings,
  type RoomVerdict,
  type ServerMessage,
} from './room-protocol'

/** What a session sends through. A socket copies on send; so must any other. */
export interface RoomTransport {
  send(data: string | Uint8Array): void
}

export interface RoomIdentity {
  readonly handle: string
  readonly variant: string
  readonly colour: number
  /** The generated-content digest this build was made from (§6.7). */
  readonly content: string
  /** A seat token from an earlier `hello`, to take the seat back (§6.9). */
  readonly seat?: string
  /** DEV-441b: join only a room somebody is in (a typed code); `join.existing`. */
  readonly existing?: boolean
  /** DEV-459: this page's own token (`join.page`), on every join. */
  readonly page?: string
}

/** Spacing of a clock-sync burst's pings, ms: independent enough samples, well under the rate cap. */
export const ROOM_BURST_SPACING_MS = 25
/** The racing clock sync, ms between pings (§6.3: 1 Hz while racing, never in the lobby). */
export const ROOM_RACING_PING_MS = 1000

/** A remote craft's key: its sender's slot, its kind, its index. */
export const trackKey = (slot: number, kind: number, index: number): number =>
  slot * 64 + kind * 32 + index

/**
 * The clock a session reads the room's time from: `RoomClock`, synced by the
 * player's pings. DEV-436's viewer, who never pings, reads the stream's own
 * stamps instead (`watch-session.ts`'s `StreamClock`), through the same slice.
 */
export interface SessionClock {
  sample(t0: number, room: number, t1: number): void
  now(local: number): number
  smooth: boolean
  readonly synced: boolean
  readonly offset: number
  readonly rtt: number
}

export interface RoomSessionOptions {
  readonly track?: RemoteTrackOptions
  /** DEV-436: another clock than the ping-synced `RoomClock` (a viewer's). */
  readonly clock?: SessionClock
  /** Every JSON message, after the session has taken what it needs from it. */
  readonly onMessage?: (msg: ServerMessage) => void
}

export class RoomSession {
  readonly clock: SessionClock
  readonly #transport: RoomTransport
  readonly #identity: RoomIdentity
  readonly #options: RoomSessionOptions
  readonly #writer = new PoseWriter()
  readonly #frame: PoseFrame = poseFrame()
  readonly #tracks = new Map<number, RemoteTrack>()

  slot: number | null = null
  seat: string | null = null
  owner: number | null = null
  roomPhase: RoomPhase | null = null
  settings: RoomSettings | null = null
  players: Record<number, RoomPlayerView> = {}
  /** Bumped whenever `players` changes, so a per-frame reader can skip an unchanged roster. */
  rosterVersion = 0
  race: RoomRace | null = null
  /** The field's GO, room ms. */
  field: number | null = null
  /** Late racers' own GOs (§6.3). */
  goAts: Record<number, number> = {}
  /** THIS player's GO, room ms. */
  goAt: number | null = null
  results: readonly RoomVerdict[] = []
  /** The bot host's reported bot finishes (§6.6), as the room last listed them. */
  bots: readonly RoomBotFinish[] = []
  /**
   * DEV-390: every other racer's rings, as the room relayed them: slot, then
   * gate, then the sender's tick. Kept by TICK so a reader can count only the
   * rings a remote ship had taken AT THE TICK IT IS DRAWN, which keeps a live
   * place's gates and its arc on the same moment (the ring event leads the
   * drawn ship by the whole render delay). Cleared when a new race loads.
   */
  ringTicks: Record<number, number[]> = {}
  /** DEV-389: the racers on the grid already, as the room's last `loading` listed them. */
  loadedSlots: readonly number[] = []
  lastError: { code: string; reason: string } | null = null

  #burstLeft = 0
  #nextPingAt = Number.NEGATIVE_INFINITY

  constructor(transport: RoomTransport, identity: RoomIdentity, options: RoomSessionOptions = {}) {
    this.#transport = transport
    this.#identity = identity
    this.#options = options
    this.clock = options.clock ?? new RoomClock()
  }

  // ── Sending ───────────────────────────────────────────────────────────────

  /** The first message on a fresh socket. */
  /**
   * The first message on a fresh socket. On a RECONNECT it carries the seat
   * token the room's `hello` gave this session (DEV-388), so the room gives
   * the same seat back rather than seating a stranger (§6.9).
   */
  join(): void {
    const i = this.#identity
    const seat = this.seat ?? i.seat
    this.#json({
      type: 'join',
      protocol: ROOM_PROTOCOL,
      handle: i.handle,
      variant: i.variant,
      colour: i.colour,
      content: i.content,
      ...(seat === undefined ? {} : { seat }),
      ...(i.existing === true ? { existing: true } : {}),
      ...(i.page === undefined ? {} : { page: i.page }),
    })
  }

  configure(settings: RoomSettings): void {
    this.#json({ type: 'configure', settings })
  }

  /**
   * Ready (or not), and the lobby's choices with it (§7.1): a colour change is
   * a `ready` with the new index, and `variant` is the aircraft this player
   * will fly, which the room checks `rules` against.
   */
  ready(ready: boolean, rules?: string, colour?: number, variant?: string): void {
    this.#json({
      type: 'ready',
      ready,
      ...(rules === undefined ? {} : { rules }),
      ...(colour === undefined ? {} : { colour }),
      ...(variant === undefined ? {} : { variant }),
    })
  }

  start(): void {
    this.#json({ type: 'start' })
  }

  /** DEV-389: a settled race back to the lobby (the room ignores it before). */
  again(): void {
    this.#json({ type: 'again' })
  }

  /** DEV-389: give up the race this player is in, at once. */
  forfeit(): void {
    this.#json({ type: 'forfeit' })
  }

  /** DEV-459: the owner removes the player in `slot` (the room refuses anyone else). */
  kick(slot: number): void {
    this.#json({ type: 'kick', slot })
  }

  /**
   * DEV-389: has every racer in the race a verdict? Then the race is settled and
   * `again` will be heard. False with no race.
   */
  get settled(): boolean {
    const race = this.race
    if (!race) return false
    const slots = Object.keys(race.starts).map(Number)
    return slots.length > 0 && slots.every((slot) => this.results.some((r) => r.slot === slot))
  }

  loaded(): void {
    this.#json({ type: 'loaded' })
  }

  ring(gate: number, tick: number): void {
    this.#json({ type: 'ring', gate, tick })
  }

  reset(tick: number, kind: string): void {
    this.#json({ type: 'reset', tick, kind })
  }

  finish(tick: number, bot?: number): void {
    this.#json(bot === undefined ? { type: 'finish', tick } : { type: 'finish', tick, bot })
  }

  /**
   * Called on EVERY fixed step with this sender's mission tick; sends one pose
   * message every `POSE_SEND_TICKS` (the cost lever, §6.2). True when it sent.
   */
  step(tick: number, records: readonly PoseRecord[], count: number): boolean {
    if (tick % POSE_SEND_TICKS !== 0) return false
    this.#transport.send(this.#writer.encode(tick, records, count))
    return true
  }

  /** The clock sync's schedule: bursts at join and `start`, 1 Hz once released. Call every frame. */
  update(local: number): void {
    if (local < this.#nextPingAt) return
    if (this.#burstLeft > 0) {
      this.#burstLeft--
      this.#ping(local)
      this.#nextPingAt = local + ROOM_BURST_SPACING_MS
    } else if (this.goAt !== null) {
      this.#ping(local)
      this.#nextPingAt = local + ROOM_RACING_PING_MS
    }
  }

  // ── Receiving ─────────────────────────────────────────────────────────────

  /** One message off the transport, at local time `local`. */
  receive(data: string | ArrayBuffer | Uint8Array, local: number): void {
    if (typeof data !== 'string') {
      this.#pose(data instanceof Uint8Array ? data : new Uint8Array(data), local)
      return
    }
    if (data === ROOM_KEEPALIVE.response) return
    let msg: ServerMessage
    try {
      msg = JSON.parse(data) as ServerMessage
    } catch {
      return
    }
    this.#control(msg, local)
    this.#options.onMessage?.(msg)
  }

  // ── Reading the room ──────────────────────────────────────────────────────

  /**
   * The room's time now. At this player's own GO the clock starts SLEWING
   * instead of stepping (`room-clock.ts`): from then on the shared clock draws
   * remote ships, and must not jump under them.
   */
  roomNow(local: number): number {
    const now = this.clock.now(local)
    if (!this.clock.smooth && this.goAt !== null && now >= this.goAt) this.clock.smooth = true
    return now
  }

  /** A sender's GO: its own if it was released late, else the field's. */
  goAtOf(slot: number): number | null {
    return this.goAts[slot] ?? this.field
  }

  track(slot: number, kind = 0, index = 0): RemoteTrack | undefined {
    return this.#tracks.get(trackKey(slot, kind, index))
  }

  /** The tick a remote craft is drawn at, at room time `roomNow`. */
  renderTick(slot: number, kind: number, index: number, roomNow: number): number | null {
    const t = this.track(slot, kind, index)
    const goAt = this.goAtOf(slot)
    if (!t || goAt === null) return null
    return sharedTickAt(roomNow, goAt) - t.delayTicks
  }

  /** Draw a remote craft at room time `roomNow` into `out`. */
  draw(slot: number, kind: number, index: number, roomNow: number, out: DrawnPose): DrawnPose {
    const t = this.track(slot, kind, index)
    const r = this.renderTick(slot, kind, index, roomNow)
    if (!t || r === null) out.mode = 'none'
    else t.sample(r, out)
    return out
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  #json(msg: object): void {
    this.#transport.send(JSON.stringify(msg))
  }

  #ping(local: number): void {
    this.#json({ type: 'ping', t0: local })
  }

  #burst(local: number): void {
    this.#burstLeft = ROOM_CLOCK_BURST
    this.#nextPingAt = local
    this.update(local)
  }

  #control(msg: ServerMessage, local: number): void {
    switch (msg.type) {
      case 'hello':
        this.slot = msg.slot
        this.seat = msg.seat
        this.owner = msg.owner
        this.roomPhase = msg.phase
        this.settings = msg.settings
        this.players = { ...msg.players }
        this.rosterVersion++
        this.race = msg.race
        this.field = msg.goAt
        this.goAts = { ...msg.goAts }
        this.results = msg.results
        this.bots = msg.bots ?? []
        if (msg.phase === 'lobby') this.#clearRace()
        this.#burst(local)
        return
      case 'pong':
        this.clock.sample(msg.t0, msg.room, local)
        return
      case 'player-joined':
        this.players[msg.slot] = msg.player
        this.rosterVersion++
        this.owner = msg.owner
        return
      case 'player-left': {
        this.owner = msg.owner
        const p = this.players[msg.slot]
        if (!msg.held) delete this.players[msg.slot]
        else if (p) this.players[msg.slot] = { ...p, present: false }
        this.rosterVersion++
        return
      }
      case 'lobby':
        this.owner = msg.owner
        this.settings = msg.settings
        this.players = { ...msg.players }
        this.rosterVersion++
        // DEV-389: back in the lobby after a race (`again`). This player's own
        // GO goes — no race is live, the lobby's quiet schedule is back (§6.2)
        // and the clock may step again before the next one. The race, its
        // results and the others' last poses stay until the next race loads,
        // so a results panel still up reads what it was reading.
        if (msg.phase === 'lobby' && this.roomPhase !== null && this.roomPhase !== 'lobby') {
          this.goAt = null
          this.loadedSlots = []
          this.clock.smooth = false
        }
        this.roomPhase = msg.phase
        return
      case 'loading':
        // The first `loading` of a race is a new race: last race's rings go.
        if (this.roomPhase !== 'loading') this.#clearRace()
        this.roomPhase = 'loading'
        this.race = msg.race
        this.loadedSlots = msg.loaded
        return
      case 'start':
        this.goAt = msg.goAt
        this.field = msg.field
        this.goAts = { ...msg.goAts }
        this.race = msg.race
        this.roomPhase = 'countdown'
        this.#burst(local)
        return
      case 'late':
        this.goAts[msg.slot] = msg.goAt
        return
      case 'reset':
        for (const [key, t] of this.#tracks) if (Math.floor(key / 64) === msg.slot) t.cut(msg.tick)
        return
      case 'results':
        this.results = msg.results
        this.bots = msg.bots ?? []
        return
      case 'ring': {
        this.ringTicks[msg.slot] ??= []
        const gates = this.ringTicks[msg.slot] as number[]
        // The first time a gate is taken is the one that counts.
        if (gates[msg.gate] === undefined) gates[msg.gate] = msg.tick
        return
      }
      case 'error':
        this.lastError = { code: msg.code, reason: msg.reason }
        return
      default:
        return
    }
  }

  #clearRace(): void {
    this.ringTicks = {}
    this.loadedSlots = []
    this.results = []
    this.bots = []
    // DEV-389: a room races more than once. Last race's GOs are not this one's:
    // a ship holds its start until its OWN GO (`remote-ships.ts`).
    this.goAt = null
    this.field = null
    this.goAts = {}
  }

  #pose(bytes: Uint8Array, local: number): void {
    const f = this.#frame
    if (!decodePose(bytes, f)) return
    if (f.slot === this.slot) return
    const goAt = this.goAtOf(f.slot)
    const late = goAt === null ? Number.NaN : this.roomNow(local) - roomTimeOfTick(f.tick, goAt)
    for (let i = 0; i < f.count; i++) {
      const r = f.records[i] as PoseRecord
      const key = trackKey(f.slot, r.kind, r.index)
      let t = this.#tracks.get(key)
      if (!t) {
        t = new RemoteTrack(this.#options.track)
        this.#tracks.set(key, t)
      }
      t.push(f.tick, r, late)
    }
  }
}
