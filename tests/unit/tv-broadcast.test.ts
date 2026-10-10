// tests/unit/tv-broadcast.test.ts — Faceted Flight TV, headless. DEV-479.
//
// `room-broadcast.test.ts`'s harness with TV added: the REAL room
// (`RoomServer` over `helpers/fake-room.ts`) announcing to the REAL guide
// (`TvGuide`, over its internal API with real Requests and Responses), the
// REAL broadcaster feeding one LINK viewer (the Spectators row's `?watch=`,
// which keeps the names) and fifty TV viewers (`TV_WATCH_PATH`, anonymous).
//
// The assertions that carry plan/FF-TV.md §2 (Matt: "no room code and no
// identifying names"):
//   - no byte any TV viewer receives contains a handle, a word of one, or the
//     room's id — swept over the BYTES, text and binary alike, not the fields —
//     while the link viewer still hears every handle;
//   - the room's work is identical with and without TV viewers;
//   - the guide lists the race under its TV id with no room id, drops it at the
//     lobby and when the room clears; the SAME TV id serves two races in one
//     room, and a room that cleared and filled again gets a new one;
//   - WATCH ME's request mints the id for a room in use, and 404s for a code
//     nobody is in.

import { describe, expect, it } from 'vitest'
import { PoseWriter, poseRecord } from '@/net/pose-codec'
import { type BroadcastHost, BroadcastServer } from '@/net/room-broadcast'
import { answerRoomLink, roomTvLinkOverFetch } from '@/net/room-link'
import {
  BROADCAST_DELAY_MS,
  POSE_SEND_TICKS,
  ROOM_ID_SHAPE,
  ROOM_PROTOCOL,
  type RoomSettings,
} from '@/net/room-protocol'
import { type RoomHost, RoomServer } from '@/net/room-server'
import { tvRacerName } from '@/net/tv-anon'
import { answerTvGuide, TvGuide, tvGuideOverFetch } from '@/net/tv-guide'
import { TV_ID_SHAPE } from '@/net/tv-protocol'
import { WatchSession } from '@/net/watch-session'
import { FIXED_DT } from '@/sim/constants'
import { FakeConn, FakeRoom } from './helpers/fake-room'

const SETTINGS: RoomSettings = {
  mission: 'int_01_hoverJet',
  edition: 'anniversary',
  bots: true,
  seats: 6,
  colours: 7,
  countdown: 3000,
  timeLimit: 180_000,
  rules: { standard: '1.28a93c83' },
}
const TICK_MS = FIXED_DT * 1000
/** The room's id: what the Durable Object is named, and what must never reach a TV viewer. */
const ROOM_ID = 'kq7xm2abcdefgh34'
/** Four handles from the game's lists, every word distinctive. */
const HANDLES = ['Swift Kestrel 42', 'Calm Heron 17', 'Bold Falcon 19', 'Amber Osprey 88']
/** What the sweep looks for: each handle, each word of four letters or more, and the room's id. */
const SECRETS = [
  ...HANDLES,
  ...new Set(HANDLES.flatMap((h) => h.split(' ')).filter((w) => w.length >= 4)),
  ROOM_ID,
]

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

/** A guide on its own fake storage, and the room's announce hook into it, in order. */
const guideFor = async (room: FakeRoom) => {
  const stored = new Map<string, unknown>()
  const guide = await TvGuide.load({
    now: () => room.now,
    storage: {
      get: async <T>(k: string) => structuredClone(stored.get(k)) as T | undefined,
      put: async <T>(k: string, v: T) => {
        stored.set(k, structuredClone(v))
      },
      delete: async (k: string) => stored.delete(k),
    },
    setAlarm: async () => {},
  })
  const link = tvGuideOverFetch((r) => answerTvGuide(guide, r))
  let told: Promise<unknown> = Promise.resolve()
  const announces: string[] = []
  ;(room.host as RoomHost).announce = (tv, state) => {
    announces.push(state === null ? `withdraw ${tv}` : `${tv} ${state.phase}`)
    told = told.then(async () => {
      if (state === null) await link.withdraw(tv, true)
      else await link.announce({ ...state, room: ROOM_ID })
    })
  }
  return { guide, link, announces, settled: () => told }
}

interface World {
  room: FakeRoom
  players: FakeConn[]
  broadcaster: BroadcastServer
  link: Viewer
  tv: Viewer[]
  /** Every socket the broadcaster holds: push one here to connect it. */
  all: Viewer[]
  timers: FakeTimers
  feed: () => FeedConn | null
  guide: Awaited<ReturnType<typeof guideFor>>
}

const join = (i: number) => ({
  type: 'join',
  protocol: ROOM_PROTOCOL,
  handle: HANDLES[i],
  variant: 'standard',
  colour: i,
  content: 'ab12cd34ef56ab12',
})

/**
 * Two players, then the viewers (one link, `nTv` through TV), then two more
 * players — so the viewers hear `player-joined` and `lobby` as well as the
 * keyframe, every message type that carries a name — then a released race.
 */
const world = async (nTv: number): Promise<World> => {
  const room = new FakeRoom()
  const guide = await guideFor(room)
  room.server = await RoomServer.load(room.host)
  const players: FakeConn[] = []
  const add = async (i: number) => {
    const c = await room.connect(`p${i}`)
    await room.send(c, join(i))
    players.push(c)
    if (i === 0) await room.send(c, { type: 'configure', settings: SETTINGS })
  }
  await add(0)
  await add(1)
  const timers = new FakeTimers(() => room.now)
  const all: Viewer[] = []
  let feed: FeedConn | null = null
  const host: BroadcastHost = {
    now: () => room.now,
    connections: () => all.filter((v) => !v.closed),
    openFeed: () => {
      const f = new FeedConn(`feed${room.now}`, (d) => broadcaster.onFeedMessage(d))
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
  const link = new Viewer('link', () => room.now)
  all.push(link)
  broadcaster.onConnect(link)
  broadcaster.onMessage(link, WatchSession.hello())
  const tv: Viewer[] = []
  for (let i = 0; i < nTv; i++) {
    const v = new Viewer(`tv${i}`, () => room.now)
    all.push(v)
    tv.push(v)
    broadcaster.onConnect(v, true)
    broadcaster.onMessage(v, WatchSession.hello())
  }
  await add(2)
  await add(3)
  for (const c of players) {
    await room.send(c, { type: 'ready', ready: true, rules: SETTINGS.rules.standard })
  }
  await room.send(players[0] as FakeConn, { type: 'start' })
  for (const c of players) await room.send(c, { type: 'loaded' })
  return { room, players, broadcaster, link, tv, all, timers, feed: () => feed, guide }
}

/** Race `seconds` from where the clock stands: poses each POSE_SEND_TICKS, a ring now and then. */
const race = async (w: World, seconds: number): Promise<void> => {
  const goAt = w.room.server.goAt as number
  const writers = w.players.map(() => new PoseWriter())
  const rec = [poseRecord()]
  const start = Math.max(Math.ceil(goAt), w.room.now + 1)
  for (let t = start; t < start + seconds * 1000; t++) {
    w.room.now = t
    const k = Math.floor((t - goAt) / TICK_MS)
    if (k >= 0 && k % POSE_SEND_TICKS === 0 && (t - 1 - goAt) / TICK_MS < k) {
      for (let s = 0; s < w.players.length; s++) {
        const r = rec[0] as (typeof rec)[number]
        r.px = s * 20 + k
        r.py = 100
        r.pz = -k
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
    w.timers.run()
  }
}

/** Let the delay run out, so everything the room said has reached the viewers. */
const drain = (w: World) => {
  w.room.now += BROADCAST_DELAY_MS + 1
  w.timers.run()
}

/** Every racer judged, then `again`: the room back in its lobby. */
const settleAndAgain = async (w: World) => {
  for (let slot = 0; slot < w.players.length; slot++) {
    await w.room.server.verdict({
      slot,
      verdict: 'ok',
      ticks: 4000 + slot,
      seconds: 49 + slot,
      rings: 21,
      ringsTotal: 21,
      score2016: 2100,
      tainted: false,
      variant: 'standard',
    })
  }
  await w.room.send(w.players[0] as FakeConn, { type: 'again' })
}

const bytes = (d: string | Uint8Array): string =>
  typeof d === 'string' ? d : Buffer.from(d).toString('latin1')

describe('no names and no code reach a TV viewer (§2.2, §2.3)', () => {
  it('fifty TV viewers hear no handle and no room id in any byte; the link viewer hears every handle', async () => {
    const w = await world(50)
    await race(w, 6)
    await settleAndAgain(w)
    drain(w)
    // The stream reached them: keyframe, the lobby's messages, batches, results, the lobby again.
    for (const v of [w.link, ...w.tv]) {
      const kinds = new Set(
        v.heard.map((h) =>
          typeof h.data === 'string' ? (JSON.parse(h.data) as { type: string }).type : 'batch',
        ),
      )
      for (const k of [
        'keyframe',
        'player-joined',
        'lobby',
        'loading',
        'start',
        'batch',
        'ring',
        'results',
      ]) {
        expect(kinds, `${v.id} heard ${k}`).toContain(k)
      }
    }
    // RED against a broadcaster that sends a TV viewer the room's own text.
    const leaks: string[] = []
    for (const v of w.tv) {
      for (const h of v.heard) {
        const b = bytes(h.data)
        for (const s of SECRETS) if (b.includes(s)) leaks.push(`${v.id}: ${s}`)
      }
    }
    expect(leaks).toEqual([])
    // The link viewer is a player's own choice to share, names included.
    const linkText = w.link.heard.map((h) => bytes(h.data)).join('\n')
    for (const h of HANDLES) expect(linkText).toContain(h)
    // And the same stream, item for item: only the names differ.
    for (const v of w.tv) expect(v.heard.length).toBe(w.link.heard.length)
  })

  it('names every racer Racer N, N its slot plus one, from the keyframe through the lobby', async () => {
    const w = await world(1)
    await race(w, 3)
    await settleAndAgain(w)
    drain(w)
    const v = w.tv[0] as Viewer
    const named = (type: string) =>
      v.json().filter((m) => m.type === type) as unknown as {
        players: Record<string, { handle: string }>
      }[]
    for (const type of ['keyframe', 'lobby']) {
      const last = named(type).at(-1)
      expect(last, type).toBeDefined()
      for (const [slot, p] of Object.entries(last?.players ?? {})) {
        expect(p.handle).toBe(tvRacerName(Number(slot)))
      }
    }
    const joined = v.json().filter((m) => m.type === 'player-joined') as unknown as {
      slot: number
      player: { handle: string }
    }[]
    expect(joined.length).toBeGreaterThan(0)
    for (const j of joined) expect(j.player.handle).toBe(tvRacerName(j.slot))
    // The viewer's own session reads it as it reads any race: four players, their slots.
    const watch = new WatchSession()
    for (const h of v.heard) watch.receive(h.data, h.at)
    expect(Object.keys(watch.session.players).sort()).toEqual(['0', '1', '2', '3'])
  })

  it('a late TV viewer is greeted with the anonymised keyframe too', async () => {
    const w = await world(0)
    await race(w, 4)
    const late = new Viewer('late', () => w.room.now)
    w.all.push(late)
    w.broadcaster.onConnect(late, true)
    w.broadcaster.onMessage(late, WatchSession.hello())
    const first = late.sent[0]
    expect(typeof first === 'string' && first.includes('"keyframe"')).toBe(true)
    for (const s of SECRETS) expect(bytes(first as string)).not.toContain(s)
    // The link viewer's greeting at the same moment carries the names.
    const linkLate = new Viewer('link-late', () => w.room.now)
    w.all.push(linkLate)
    w.broadcaster.onConnect(linkLate)
    w.broadcaster.onMessage(linkLate, WatchSession.hello())
    expect(bytes(linkLate.sent[0] as string)).toContain(HANDLES[0])
  })
})

describe('the room never sees a TV viewer (§3.5)', () => {
  it('does the same work for its players, its feed and the guide with 0 and 50 TV viewers', async () => {
    const runs = []
    for (const n of [0, 50]) {
      const w = await world(n)
      await race(w, 8)
      await settleAndAgain(w)
      drain(w)
      await w.guide.settled()
      runs.push({
        players: w.players.map((c) => c.sent.length),
        feed: w.feed()?.sent.length ?? 0,
        opened: w.broadcaster.counts.feedsOpened,
        announces: w.guide.announces.map((a) => a.replace(/^tv_\w+ /, '')),
        link: w.link.sent.length,
      })
    }
    const [none, fifty] = runs as [(typeof runs)[0], (typeof runs)[0]]
    expect(fifty.players).toEqual(none.players)
    expect(fifty.feed).toBe(none.feed)
    expect(fifty.opened).toBe(1)
    expect(fifty.announces).toEqual(none.announces)
    expect(fifty.link).toBe(none.link)
  })
})

describe('the guide hears the room (§2.2, §3.2)', () => {
  it('lists the race under its TV id with no room id, drops it at the lobby, keeps the id for the next race', async () => {
    const w = await world(0)
    await w.guide.settled()
    const tv = w.room.server.tv as string
    expect(tv).toMatch(TV_ID_SHAPE)
    expect(ROOM_ID_SHAPE.test(tv)).toBe(false)
    let list = await w.guide.link.list()
    expect(list.races.map((r) => [r.tv, r.mission, r.racers])).toEqual([[tv, 'int_01_hoverJet', 6]])
    expect(JSON.stringify(list)).not.toContain(ROOM_ID)
    expect(await w.guide.link.resolve(tv)).toBe(ROOM_ID)

    await race(w, 2)
    await settleAndAgain(w)
    await w.guide.settled()
    // RED against a room that never tells the guide it is back in its lobby.
    list = await w.guide.link.list()
    expect(list.races).toEqual([])
    expect(list.lobbies).toBe(1)
    // A link to the room still resolves between its races.
    expect(await w.guide.link.resolve(tv)).toBe(ROOM_ID)

    // The second race: the SAME TV id (a shared link works for every race in the room).
    for (const c of w.players) {
      await w.room.send(c, { type: 'ready', ready: true, rules: SETTINGS.rules.standard })
    }
    await w.room.send(w.players[0] as FakeConn, { type: 'start' })
    for (const c of w.players) await w.room.send(c, { type: 'loaded' })
    await w.guide.settled()
    // RED against a room that mints a TV id per race.
    expect(w.room.server.tv).toBe(tv)
    expect((await w.guide.link.list()).races.map((r) => r.tv)).toEqual([tv])
  })

  it('drops the room when it clears, and a room that fills again gets a NEW TV id', async () => {
    const w = await world(0)
    await race(w, 2)
    await settleAndAgain(w)
    await w.guide.settled()
    const tv = w.room.server.tv as string
    // Everyone leaves the lobby: the room clears, at once.
    for (const c of w.players) await w.room.disconnect(c)
    await w.guide.settled()
    // RED against a room that does not withdraw on clear.
    expect(w.guide.announces.at(-1)).toBe(`withdraw ${tv}`)
    expect(await w.guide.link.resolve(tv)).toBeNull()
    expect(await w.guide.link.list()).toEqual({ races: [], lobbies: 0 })
    expect(w.room.server.tv).toBeNull()
    // A new room under the same name: new players, a new race, a new TV id.
    const fresh: FakeConn[] = []
    for (let i = 0; i < 2; i++) {
      const c = await w.room.connect(`n${i}`)
      await w.room.send(c, join(i))
      fresh.push(c)
    }
    await w.room.send(fresh[0] as FakeConn, { type: 'configure', settings: SETTINGS })
    for (const c of fresh) {
      await w.room.send(c, { type: 'ready', ready: true, rules: SETTINGS.rules.standard })
    }
    await w.room.send(fresh[0] as FakeConn, { type: 'start' })
    await w.guide.settled()
    // RED against a room whose TV id outlives it.
    const next = w.room.server.tv as string
    expect(next).toMatch(TV_ID_SHAPE)
    expect(next).not.toBe(tv)
    expect((await w.guide.link.list()).races.map((r) => r.tv)).toEqual([next])
  })

  it('announces again with the same TV id when the room is evicted mid-race', async () => {
    const w = await world(0)
    await race(w, 2)
    await w.guide.settled()
    const tv = w.room.server.tv as string
    const before = w.guide.announces.length
    await w.room.evict()
    await w.guide.settled()
    expect(w.room.server.tv).toBe(tv)
    expect(w.guide.announces.length).toBe(before + 1)
    expect(w.guide.announces.at(-1)).toBe(`${tv} racing`)
  })
})

describe('WATCH ME: the room’s TV id over the binding (§2.6)', () => {
  it('mints the id for a room in use, returns the same one after, and 404s for a code nobody is in', async () => {
    const empty = new FakeRoom()
    const g0 = await guideFor(empty)
    empty.server = await RoomServer.load(empty.host)
    const none = roomTvLinkOverFetch((r) => answerRoomLink(empty.server, r))
    expect(await none.tv()).toBeNull()
    expect(empty.server.tv).toBeNull()
    expect(g0.announces).toEqual([])

    const room = new FakeRoom()
    const g = await guideFor(room)
    room.server = await RoomServer.load(room.host)
    const c = await room.connect('p0')
    await room.send(c, join(0))
    const link = roomTvLinkOverFetch((r) => answerRoomLink(room.server, r))
    const tv = await link.tv()
    expect(tv).toMatch(TV_ID_SHAPE)
    expect(await link.tv()).toBe(tv)
    await g.settled()
    // Made in a lobby, it resolves before the room ever races, and is not listed.
    expect(await g.link.resolve(tv as string)).toBe(ROOM_ID)
    expect((await g.link.list()).races).toEqual([])
    // And the first race keeps it.
    await room.send(c, { type: 'configure', settings: SETTINGS })
    await room.send(c, { type: 'ready', ready: true, rules: SETTINGS.rules.standard })
    await room.send(c, { type: 'start' })
    expect(room.server.tv).toBe(tv)
  })

  it('a room with no guide mints nothing until WATCH ME asks (the shuffle and seats unchanged)', async () => {
    const room = await FakeRoom.open()
    const c = await room.connect('p0')
    await room.send(c, join(0))
    await room.send(c, { type: 'configure', settings: SETTINGS })
    await room.send(c, { type: 'ready', ready: true, rules: SETTINGS.rules.standard })
    await room.send(c, { type: 'start' })
    expect(room.server.tv).toBeNull()
  })
})
