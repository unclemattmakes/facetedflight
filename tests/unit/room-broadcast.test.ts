// The broadcaster (DEV-436, plan/MULTIPLAYER.md §13.5): SourceTV on a Durable
// Object, headless. The REAL room (`RoomServer` over `helpers/fake-room.ts`),
// the REAL broadcaster (`BroadcastServer`) feeding N fake viewers, and the
// REAL viewer (`WatchSession`, a `RoomSession` that never speaks) rebuilding
// the race from what one of them heard. Time is the fake room's, in whole ms;
// the broadcaster's timers run on it.
//
// The two assertions that carry the design (§13.5):
//   - the room's work with its PLAYERS is identical with 0, 1 and 50 viewers,
//     and its work for the broadcaster identical with 1 and 50;
//   - a viewer's rebuilt track is the players' own, BROADCAST_DELAY_MS late.

import { describe, expect, it } from 'vitest'
import { PoseWriter, poseRecord } from '@/net/pose-codec'
import { drawnPose } from '@/net/remote-track'
import { BROADCAST_FEED_RETRY_MS, type BroadcastHost, BroadcastServer } from '@/net/room-broadcast'
import { sharedTickAt } from '@/net/room-clock'
import {
  BROADCAST_DELAY_MS,
  BROADCAST_FLUSH_MS,
  BROADCAST_IDLE_MS,
  decodeBatch,
  encodeBatch,
  POSE_SEND_TICKS,
  ROOM_KEEPALIVE,
  ROOM_PROTOCOL,
  type RoomSettings,
} from '@/net/room-protocol'
import { WatchSession } from '@/net/watch-session'
import { FIXED_DT } from '@/sim/constants'
import { FakeConn, FakeRoom } from './helpers/fake-room'

const SETTINGS: RoomSettings = {
  mission: 'int_01_hoverJet',
  edition: 'anniversary',
  bots: false,
  seats: 6,
  colours: 7,
  countdown: 3000,
  timeLimit: 180_000,
  rules: { standard: '1.28a93c83' },
}
const TICK_MS = FIXED_DT * 1000

/** Timers on the fake room's clock: what `setTimeout` is in the object. */
class FakeTimers {
  #next = 1
  readonly #due = new Map<number, { at: number; fn: () => void }>()
  constructor(readonly now: () => number) {}
  set(fn: () => void, ms: number): unknown {
    const id = this.#next++
    this.#due.set(id, { at: this.now() + ms, fn })
    return id
  }
  clear(handle: unknown): void {
    this.#due.delete(handle as number)
  }
  /** Run every timer due by now, in time order (a timer may set another). */
  run(): void {
    for (;;) {
      let best: [number, { at: number; fn: () => void }] | null = null
      for (const e of this.#due)
        if (e[1].at <= this.now() && (!best || e[1].at < best[1].at)) best = e
      if (!best) return
      this.#due.delete(best[0])
      best[1].fn()
    }
  }
}

/** A viewer's socket: what it was sent, and when. */
class Viewer extends FakeConn {
  readonly heard: { at: number; data: string | Uint8Array }[] = []
  constructor(
    id: string,
    readonly clock: () => number,
  ) {
    super(id)
  }
  override send(message: string | ArrayBuffer | ArrayBufferView): void {
    super.send(message)
    const last = this.sent.at(-1)
    if (last !== undefined) this.heard.push({ at: this.clock(), data: last })
  }
}

/** The broadcaster's feed, as the room sees it: every send goes to the broadcaster. */
class FeedConn extends FakeConn {
  constructor(
    id: string,
    readonly deliver: (data: string | Uint8Array) => void,
  ) {
    super(id)
  }
  override send(message: string | ArrayBuffer | ArrayBufferView): void {
    super.send(message)
    const last = this.sent.at(-1)
    if (last !== undefined && !this.closed) this.deliver(last)
  }
}

/** A player's true position at a tick: a straight line, one per slot. */
const truth = (slot: number, tick: number): [number, number, number] => [
  slot * 20 + tick * 0.9,
  100 + slot,
  -tick * 0.4,
]

interface World {
  room: FakeRoom
  players: FakeConn[]
  broadcaster: BroadcastServer
  viewers: Viewer[]
  timers: FakeTimers
  feed: () => FeedConn | null
  goAt: number
}

/** Four players in a released race, a broadcaster, and `n` viewers watching from the lobby. */
/**
 * How the feed's socket hands the broadcaster what the room sent. `direct` is
 * the sidecar's and node's; `platform` is a Cloudflare Worker's since
 * `websocket_standard_binary_type` (default on from 2026-03-17; the rooms Worker is
 * dated 2026-09-01): a binary frame arrives as a `Blob`, and an exception in the
 * listener is the runtime's to log, not the room's to see — so it is caught here
 * and kept, as the platform keeps it, in `listenerErrors`.
 */
type FeedDelivery = 'direct' | 'platform'
const listenerErrors: unknown[] = []

const world = async (n: number, delivery: FeedDelivery = 'direct'): Promise<World> => {
  const room = await FakeRoom.open()
  const players: FakeConn[] = []
  for (let i = 0; i < 4; i++) {
    const c = await room.connect(`p${i}`)
    await room.send(c, {
      type: 'join',
      protocol: ROOM_PROTOCOL,
      handle: `Swift Kestrel ${10 + i}`,
      variant: 'standard',
      colour: i,
      content: 'ab12cd34ef56ab12',
    })
    players.push(c)
    if (i === 0) await room.send(c, { type: 'configure', settings: SETTINGS })
  }
  const timers = new FakeTimers(() => room.now)
  const viewers: Viewer[] = []
  let feed: FeedConn | null = null
  const host: BroadcastHost = {
    now: () => room.now,
    connections: () => viewers.filter((v) => !v.closed),
    openFeed: () => {
      const f = new FeedConn(`feed${room.now}`, (d) => {
        const data =
          delivery === 'platform' && typeof d !== 'string' ? new Blob([new Uint8Array(d)]) : d
        try {
          broadcaster.onFeedMessage(data)
        } catch (err) {
          listenerErrors.push(err)
        }
      })
      feed = f
      room.conns.push(f)
      broadcaster.onFeedOpen()
      void room.server.onFeed(f)
    },
    closeFeed: () => {
      const f = feed
      feed = null
      if (f) void room.disconnect(f)
    },
    timers,
  }
  const broadcaster = new BroadcastServer(host)
  for (let i = 0; i < n; i++) {
    const v = new Viewer(`v${i}`, () => room.now)
    viewers.push(v)
    broadcaster.onConnect(v)
    broadcaster.onMessage(v, WatchSession.hello())
  }
  for (const c of players) {
    await room.send(c, { type: 'ready', ready: true, rules: SETTINGS.rules.standard })
  }
  await room.send(players[0] as FakeConn, { type: 'start' })
  for (const c of players) await room.send(c, { type: 'loaded' })
  return {
    room,
    players,
    broadcaster,
    viewers,
    timers,
    feed: () => feed,
    goAt: room.server.goAt as number,
  }
}

/** Race `seconds`: every player's pose each POSE_SEND_TICKS, a ring now and then. */
const race = async (w: World, seconds: number): Promise<void> => {
  const writers = w.players.map(() => new PoseWriter())
  const rec = [poseRecord()]
  // From where the clock stands: a second call continues the race, never rewinds it.
  const start = Math.max(Math.ceil(w.goAt), w.room.now + 1)
  for (let t = start; t < start + seconds * 1000; t++) {
    w.room.now = t
    const tick = (t - w.goAt) / TICK_MS
    if (tick >= 0 && Number.isInteger(Math.round(tick))) {
      const k = Math.floor(tick)
      // One pose message per POSE_SEND_TICKS ticks, on the millisecond it falls in.
      if (k % POSE_SEND_TICKS === 0 && (t - 1 - w.goAt) / TICK_MS < k) {
        for (let s = 0; s < w.players.length; s++) {
          const r = rec[0] as (typeof rec)[number]
          const [x, y, z] = truth(s, k)
          r.px = x
          r.py = y
          r.pz = z
          r.vx = 0.9 / FIXED_DT
          r.vy = 0
          r.vz = -0.4 / FIXED_DT
          r.qw = 1
          await w.room.sendBinary(
            w.players[s] as FakeConn,
            (writers[s] as PoseWriter).encode(k, rec, 1),
          )
        }
        if (k > 0 && k % 400 === 0) {
          await w.room.send(w.players[k % 4] as FakeConn, { type: 'ring', gate: k / 400, tick: k })
        }
      }
    }
    w.timers.run()
  }
}

describe('the room never sees a viewer (§13.1, §13.5)', () => {
  it('does the same work for its players at 0, 1 and 50 viewers, and the same for the feed at 1 and 50', async () => {
    const runs = []
    for (const n of [0, 1, 50]) {
      const w = await world(n)
      await race(w, 12)
      runs.push({
        n,
        players: w.players.map((c) => c.sent.length),
        feed: w.feed()?.sent.length ?? 0,
        fedIn: w.broadcaster.counts.feedIn,
        opened: w.broadcaster.counts.feedsOpened,
        perViewer: w.viewers.map((v) => v.sent.length),
      })
    }
    const [none, one, fifty] = runs as [(typeof runs)[0], (typeof runs)[0], (typeof runs)[0]]
    // RED against a room that fans out to viewers itself: its sends would grow with them.
    expect(one.players).toEqual(none.players)
    expect(fifty.players).toEqual(none.players)
    expect(none.feed).toBe(0)
    expect(one.feed).toBeGreaterThan(0)
    expect(fifty.feed).toBe(one.feed)
    // One feed, however many watch; everything it sent arrived.
    expect(fifty.opened).toBe(1)
    expect(fifty.fedIn).toBe(fifty.feed)
    // Four batches a second, give or take the text between them.
    const batchesPerSecond = one.feed / 12
    expect(batchesPerSecond).toBeGreaterThan(1000 / BROADCAST_FLUSH_MS - 1)
    expect(batchesPerSecond).toBeLessThan(1000 / BROADCAST_FLUSH_MS + 2)
    // Every viewer heard the same stream.
    expect(new Set(fifty.perViewer).size).toBe(1)
    expect(fifty.perViewer[0]).toBe(one.perViewer[0])
  })
})

describe('a viewer watches the race as it was, BROADCAST_DELAY_MS ago (§13.1)', () => {
  it('holds every item the delay, in order, and a rebuilt track is the players’ own', async () => {
    const w = await world(1)
    await race(w, 12)
    const v = w.viewers[0] as Viewer
    const feed = w.feed() as FeedConn
    // Delay: the Nth thing a viewer heard after its greeting is the feed's Nth, 2 s later.
    const fed = feed.sent.filter((m) => !(typeof m === 'string' && m.includes('"keyframe"')))
    const heard = v.heard.filter(
      (h) => !(typeof h.data === 'string' && h.data.includes('"keyframe"')),
    )
    expect(heard.length).toBeGreaterThan(0)
    expect(heard.length).toBeLessThanOrEqual(fed.length)
    // Rebuild from what the viewer heard, at the times it heard it.
    const watch = new WatchSession()
    const out = drawnPose()
    const errors: number[] = []
    let lag = 0
    for (const h of v.heard) {
      watch.receive(h.data, h.at)
      const s = watch.session
      for (let slot = 0; slot < 4; slot++) {
        const local = h.at
        const roomNow = s.roomNow(local)
        const r = s.renderTick(slot, 0, 0, roomNow)
        s.draw(slot, 0, 0, roomNow, out)
        if (r === null || out.mode === 'none' || r < 50) continue
        const [x, y, z] = truth(slot, r)
        errors.push(Math.hypot(out.px - x, out.py - y, out.pz - z))
        // How far behind the room the viewer draws: the delay, and the track's own.
        lag = Math.max(lag, local - (w.goAt + r * TICK_MS))
      }
    }
    errors.sort((a, b) => a - b)
    const p95 = errors[Math.floor(errors.length * 0.95)] as number
    expect(errors.length).toBeGreaterThan(100)
    // §9.1's bar is centimetres over a bad link; a straight line through a clean one is less.
    expect(p95).toBeLessThan(0.05)
    expect(lag).toBeGreaterThanOrEqual(BROADCAST_DELAY_MS)
    expect(lag).toBeLessThan(BROADCAST_DELAY_MS + 1000)
    expect(watch.keyframes).toBeGreaterThanOrEqual(1)
    expect(watch.delay).toBe(BROADCAST_DELAY_MS)
  })

  it('draws the field for a viewer who comes late, within one batch of joining', async () => {
    const w = await world(1)
    await race(w, 6)
    const late = new Viewer('late', () => w.room.now)
    w.viewers.push(late)
    w.broadcaster.onConnect(late)
    w.broadcaster.onMessage(late, WatchSession.hello())
    // Greeted at once: the delayed keyframe, then each seat's newest frame.
    expect(typeof late.sent[0] === 'string' && late.sent[0].includes('"keyframe"')).toBe(true)
    expect(late.binary().length).toBe(4)
    const watch = new WatchSession()
    for (const h of late.heard) watch.receive(h.data, h.at)
    const s = watch.session
    expect(Object.keys(s.players)).toHaveLength(4)
    expect(s.field).toBe(w.goAt)
    for (let slot = 0; slot < 4; slot++) expect(s.track(slot)?.size ?? 0).toBeGreaterThan(0)
  })

  it('answers an idle viewer’s keep-alive, and nothing else happens (§6.2)', async () => {
    const w = await world(0)
    const idle = new Viewer('idle', () => w.room.now)
    w.viewers.push(idle)
    w.broadcaster.onConnect(idle)
    w.broadcaster.onMessage(idle, ROOM_KEEPALIVE.request)
    expect(idle.sent).toEqual([ROOM_KEEPALIVE.response])
    expect(w.broadcaster.counts.feedsOpened).toBe(0)
    expect(w.broadcaster.viewers()).toBe(0)
  })
})

describe('the feed comes and goes', () => {
  it('drops the feed a grace after the last viewer leaves, and the room stops batching', async () => {
    const w = await world(1)
    await race(w, 2)
    const v = w.viewers[0] as Viewer
    v.close(1000, 'bye')
    w.broadcaster.onClose(v)
    const before = w.feed()
    expect(before).not.toBeNull()
    w.room.now += BROADCAST_IDLE_MS
    w.timers.run()
    expect(w.feed()).toBeNull()
    expect(w.broadcaster.feedStatus).toBe('closed')
  })

  it('reopens after the room drops it mid-race, and viewers resume from a fresh keyframe', async () => {
    const w = await world(1)
    await race(w, 3)
    const v = w.viewers[0] as Viewer
    const keyframes = () =>
      v.sent.filter((m) => typeof m === 'string' && m.includes('"keyframe"')).length
    const first = keyframes()
    // The room is evicted: its end of the feed goes away.
    const old = w.feed() as FeedConn
    await w.room.disconnect(old)
    await w.room.evict()
    w.broadcaster.onFeedClose()
    // Not at once: a room that refuses must not be hammered.
    expect(w.broadcaster.counts.feedsOpened).toBe(1)
    w.room.now += BROADCAST_FEED_RETRY_MS
    w.timers.run()
    expect(w.broadcaster.counts.feedsOpened).toBe(2)
    await race(w, 4)
    expect(keyframes()).toBeGreaterThan(first)
    const watch = new WatchSession()
    for (const h of v.heard) watch.receive(h.data, h.at)
    expect(Object.keys(watch.session.players)).toHaveLength(4)
  })

  it('refuses a viewer on another protocol, 4002', async () => {
    const w = await world(0)
    const v = new Viewer('old', () => w.room.now)
    w.viewers.push(v)
    w.broadcaster.onMessage(v, JSON.stringify({ type: 'watch', protocol: ROOM_PROTOCOL - 1 }))
    expect(v.closed?.code).toBe(4002)
  })
})

// ── The Cloudflare failure (2026-09-27, 08:53 UTC) ─────────────────────────
//
// On the platform every viewer got its keyframe and no batch. The keyframe is
// TEXT; a batch is BINARY. Two explanations were on the table, and these two
// tests separate them: the object hibernating between messages (the
// coordinator's), and the feed socket handing binary over as something the
// broadcaster did not take.
describe('the feed survives what the platform does to it', () => {
  /** What the viewer heard after its greeting, as kinds: the order is the check. */
  const kinds = (v: Viewer) =>
    v.heard
      .map((h) =>
        typeof h.data === 'string' ? (JSON.parse(h.data) as { type: string }).type : 'batch',
      )
      .filter((k) => k !== 'keyframe')
  /** Let every Blob read settle: they resolve on the event loop, not in a microtask. */
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
  }

  it('takes a binary frame that arrives as a Blob, in order with the text around it', async () => {
    listenerErrors.length = 0
    const w = await world(1, 'platform')
    await race(w, 3)
    await settle()
    w.room.now += BROADCAST_DELAY_MS
    w.timers.run()
    const v = w.viewers[0] as Viewer
    const feed = w.feed() as FeedConn
    const sent = feed.sent.map((m) =>
      typeof m === 'string' ? (JSON.parse(m) as { type: string }).type : 'batch',
    )
    // RED before the fix: "Cannot read properties of undefined (reading 'slice')"
    // for every batch, the keyframe through — the platform's symptom exactly.
    expect(listenerErrors).toEqual([])
    expect(kinds(v).filter((k) => k === 'batch').length).toBeGreaterThan(8)
    expect(kinds(v)).toEqual(sent.filter((k) => k !== 'keyframe'))
  })

  it('keeps feeding when the ROOM is evicted mid-race: the feed is in its attachment', async () => {
    // The coordinator's hypothesis, tested: a fresh RoomServer from storage alone,
    // the sockets (and their attachments) kept, as hibernation keeps them.
    const w = await world(1)
    await race(w, 2)
    const before = (w.feed() as FeedConn).sent.length
    await w.room.evict()
    await race(w, 2)
    const after = (w.feed() as FeedConn).sent.length
    expect(after - before).toBeGreaterThan(5)
    expect(w.broadcaster.counts.feedsOpened).toBe(1)
  })
})

describe('the batch (§13.4: consecutive §7.2 frames behind one header)', () => {
  it('round-trips its frames and its time, and refuses a truncated one whole', () => {
    const a = new Uint8Array([0x10, 1, 1, 0, 9, 0, 0, 0])
    const b = new Uint8Array([0x10, 2, 1, 0, 10, 0, 0, 0, 7])
    const batch = encodeBatch([a, b], 1234.5)
    const got: number[][] = []
    expect(decodeBatch(batch, (f) => got.push([...f]))).toBe(1234.5)
    expect(got).toEqual([[...a], [...b]])
    const cut: number[][] = []
    expect(decodeBatch(batch.subarray(0, batch.length - 1), (f) => cut.push([...f]))).toBeNull()
    expect(cut).toEqual([])
  })
})

// The shared tick a viewer draws at, for the record (not a gate): it trails the
// room's by the delay, so a viewer never draws past what it has.
void sharedTickAt
