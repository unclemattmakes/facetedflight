// The game's socket around a room (DEV-388): URL, reconnect with the seat
// token, close codes as the contract, the queue, the keep-alive, and the pose
// frame held against the lap recorder's own. A fake socket and fake timers:
// the lifecycle is the thing under test, not the network.

import { describe, expect, it } from 'vitest'
import {
  diagnoseStatus,
  fillOwnPose,
  newRoomId,
  ROOM_KEEPALIVE_MS,
  ROOM_OFF,
  ROOM_RESTING,
  ROOM_RETRY_GIVE_UP_MS,
  ROOM_UNREACHABLE,
  RoomClient,
  type RoomSocket,
  roomIdFrom,
  roomNotice,
  roomUrl,
} from '@/game/room-client'
import { poseRecord } from '@/net/pose-codec'
import { CLOSE, ROOM_ID_SHAPE, ROOM_KEEPALIVE, ROOM_PROTOCOL } from '@/net/room-protocol'
import { type RoomEnv, type RoomNamespace, routeToRoom } from '@/net/room-route'
import { createLapRecorder, recordPose } from '@/sim/ghost-record'

class FakeSocket implements RoomSocket {
  binaryType = 'blob'
  readyState = 0
  readonly sent: Array<string | Uint8Array> = []
  onopen: ((e: unknown) => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: ((e: { code: number; reason: string }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  constructor(readonly url: string) {}
  send(data: string | ArrayBufferView | ArrayBuffer) {
    this.sent.push(typeof data === 'string' ? data : new Uint8Array(data as ArrayBuffer))
  }
  close(code = 1000, reason = '') {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }
  open() {
    this.readyState = 1
    this.onopen?.({})
  }
  drop(code: number, reason = '') {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }
  hear(msg: object) {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
  json() {
    return this.sent
      .filter((m): m is string => typeof m === 'string' && m.startsWith('{'))
      .map((m) => JSON.parse(m) as { type: string; [k: string]: unknown })
  }
}

const harness = (probe?: (url: string) => Promise<number>) => {
  let now = 0
  const sockets: FakeSocket[] = []
  const timers: Array<{ fn: () => void; at: number; live: boolean }> = []
  const statuses: string[] = []
  const client = new RoomClient({
    url: 'wss://main.ff-10yr.pages.dev/api/room/abcdefghij234567',
    identity: {
      handle: 'Swift Kestrel 42',
      variant: 'standard',
      colour: 0,
      content: 'ab12cd34ef56ab12',
    },
    now: () => now,
    socket: (url) => {
      const s = new FakeSocket(url)
      sockets.push(s)
      return s
    },
    timers: {
      set: (fn, ms) => {
        const t = { fn, at: now + ms, live: true }
        timers.push(t)
        return t
      },
      clear: (h) => {
        ;(h as { live: boolean }).live = false
      },
    },
    ...(probe ? { probe } : {}),
    onStatus: (s) => statuses.push(s),
  })
  const advance = (ms: number) => {
    const end = now + ms
    for (;;) {
      const next = timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!next) break
      now = next.at
      next.live = false
      next.fn()
    }
    now = end
  }
  const last = () => sockets.at(-1) as FakeSocket
  const hello = {
    type: 'hello',
    protocol: ROOM_PROTOCOL,
    slot: 2,
    joinSeq: 5,
    seat: 'SEAT-token-0123456789ab',
    owner: 0,
    phase: 'loading',
    settings: null,
    players: {},
    race: null,
    goAt: null,
    goAts: {},
    results: [],
  }
  return { client, sockets, last, advance, statuses, hello, setNow: (t: number) => (now = t) }
}

describe('the room URL (§6.2)', () => {
  it('is the page’s own origin: wss for https, ws for http', () => {
    expect(roomUrl('abcdefghij234567', { protocol: 'https:', host: 'ff-10yr.pages.dev' })).toBe(
      'wss://ff-10yr.pages.dev/api/room/abcdefghij234567',
    )
    expect(roomUrl('abcdefghij234567', { protocol: 'http:', host: '127.0.0.1:5387' })).toBe(
      'ws://127.0.0.1:5387/api/room/abcdefghij234567',
    )
  })

  it('takes only a room id’s shape from ?room=, and makes unguessable ones', () => {
    expect(roomIdFrom('abcdefghij234567')).toBe('abcdefghij234567')
    expect(roomIdFrom('short')).toBeNull()
    expect(roomIdFrom('<script>abcdefghij')).toBeNull()
    expect(roomIdFrom(null)).toBeNull()
    const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff)
    const id = newRoomId(bytes)
    expect(id).toMatch(ROOM_ID_SHAPE)
    expect(id).toHaveLength(16)
  })
})

describe('RoomClient', () => {
  it('joins first on open, and flushes what was queued behind the join', () => {
    const h = harness()
    h.client.connect()
    h.client.session.ready(true, '1.28a93c83') // before the socket is up
    h.client.sendPose(0, [poseRecord()], 1) // a pose while down: dropped
    h.last().open()
    const types = h
      .last()
      .json()
      .map((m) => m.type)
    expect(types).toEqual(['join', 'ready'])
    expect(h.last().sent.some((m) => typeof m !== 'string')).toBe(false)
  })

  it('stops on every 4xxx and says why in one line (§7.1)', () => {
    for (const code of Object.values(CLOSE)) {
      const h = harness()
      h.client.connect()
      h.last().open()
      h.last().drop(code, 'race in progress')
      h.advance(60_000)
      expect(h.sockets).toHaveLength(1)
      expect(h.client.status).toBe('closed')
      expect(h.client.notice).toEqual(expect.any(String))
    }
  })

  // DEV-459. Red against a client with no line for it: the generic "closed the connection".
  it('says plainly that the owner removed you (4008)', () => {
    expect(CLOSE.kicked).toBe(4008)
    expect(roomNotice(CLOSE.kicked)).toBe("The room's owner removed you from this room.")
  })

  it('reconnects a dropped socket with backoff and takes its SEAT back', () => {
    const h = harness()
    h.client.connect()
    h.last().open()
    h.last().hear(h.hello)
    h.last().drop(1006)
    expect(h.client.status).toBe('retrying')
    h.advance(10_000)
    expect(h.sockets.length).toBe(2)
    h.last().open()
    const join = h.last().json()[0] as { type: string; seat?: string }
    expect(join.type).toBe('join')
    expect(join.seat).toBe(h.hello.seat)
    expect(h.client.connects).toBe(2)
  })

  it('gives up when the rejoin window has passed: the seat is gone', () => {
    const h = harness()
    h.client.connect()
    h.last().open()
    h.last().drop(1006)
    for (let t = 0; t < ROOM_RETRY_GIVE_UP_MS + 10_000; t += 1000) {
      h.advance(1000)
      const s = h.last()
      if (s.readyState === 0) s.drop(1006)
    }
    expect(h.client.status).toBe('closed')
    expect(h.client.notice).toMatch(/away too long/)
  })

  it('calls a room it never reached unreachable, not a seat it lost', () => {
    // Found by the two-browser spec's first run: a proxy that never answered
    // read "You were away too long", to a player who had never arrived.
    const h = harness()
    h.client.connect()
    for (let t = 0; t < ROOM_RETRY_GIVE_UP_MS + 10_000; t += 1000) {
      const s = h.last()
      if (s.readyState === 0) s.drop(1006)
      h.advance(1000)
    }
    expect(h.client.status).toBe('closed')
    expect(h.client.closeCode).toBe(ROOM_UNREACHABLE)
    expect(h.client.notice).toMatch(/could not be reached/)
  })

  it('does not reconnect after leaving on purpose', () => {
    const h = harness()
    h.client.connect()
    h.last().open()
    h.client.leave()
    h.advance(60_000)
    expect(h.sockets).toHaveLength(1)
  })

  it('keeps an idle lobby alive with one keep-alive per 30 s and no clock pings', () => {
    const h = harness()
    h.client.connect()
    h.last().open()
    h.last().hear(h.hello)
    // The join's clock-sync burst goes out first, a frame at a time.
    for (let t = 0; t <= 1000; t += 11) {
      h.setNow(t)
      h.client.update()
    }
    const pings = h
      .last()
      .json()
      .filter((m) => m.type === 'ping').length
    expect(pings).toBeGreaterThan(0)
    // Then the lobby is quiet: no ping at all, and one keep-alive per idle 30 s.
    for (let t = 1000; t <= 1000 + ROOM_KEEPALIVE_MS; t += 11) {
      h.setNow(t)
      h.client.update()
    }
    expect(
      h
        .last()
        .json()
        .filter((m) => m.type === 'ping'),
    ).toHaveLength(pings)
    expect(h.last().sent.filter((m) => m === ROOM_KEEPALIVE.request)).toHaveLength(1)
    h.last().hear({
      type: 'start',
      goAt: 99_999,
      field: 99_999,
      goAts: {},
      race: { mission: 'm', edition: 'e', starts: {}, bots: [], colours: {} },
    })
    h.setNow(3 * ROOM_KEEPALIVE_MS)
    h.client.update()
    expect(h.last().sent.filter((m) => m === ROOM_KEEPALIVE.request)).toHaveLength(1)
  })

  it('diagnoses a handshake that never opened: resting, not configured, or unreachable', async () => {
    expect(diagnoseStatus(429)).toBe(ROOM_RESTING)
    expect(diagnoseStatus(503)).toBe(ROOM_OFF)
    expect(diagnoseStatus(500)).toBe(ROOM_UNREACHABLE)
    expect(roomNotice(ROOM_RESTING)).toMatch(/resting until 00:00 UTC/)
    const probed: string[] = []
    const h = harness(async (url) => {
      probed.push(url)
      return 429
    })
    h.client.connect()
    h.last().drop(1006)
    await Promise.resolve()
    await Promise.resolve()
    expect(probed).toEqual(['https://main.ff-10yr.pages.dev/api/room/abcdefghij234567'])
    expect(h.client.status).toBe('closed')
    expect(h.client.notice).toMatch(/resting/)
  })

  it('retries when the diagnosis says the site is fine (426) and the room just missed', async () => {
    const h = harness(async () => 426)
    h.client.connect()
    h.last().drop(1006)
    await Promise.resolve()
    await Promise.resolve()
    h.advance(1000)
    expect(h.sockets.length).toBe(2)
  })

  // DEV-470. The two tests above hand the probe a status; the route's tests
  // hand the route an UPGRADE. Neither asked what the route answers to the
  // probe's own request — a plain GET — and it was 426, "the site is fine",
  // on a site with no rooms: production before its binding, where a release
  // build now offers rooms (D36). So the probe here is answered by the REAL
  // Pages Function, `routeToRoom`, handed the request the client makes.
  it('DEV-470: on a site with no rooms bound, says so at once — the probe asks the real route', async () => {
    const real = (env: RoomEnv) => async (url: string) =>
      (await routeToRoom(new Request(url), env)).status
    const off = harness(real({}))
    off.client.connect()
    off.last().drop(1006)
    for (let i = 0; i < 4; i++) await Promise.resolve()
    expect(off.client.status).toBe('closed')
    expect(off.client.closeCode).toBe(ROOM_OFF)
    expect(off.client.notice).toBe("Online races aren't open yet: fly solo.")
    expect(off.sockets.length, 'no second handshake at a site that cannot answer one').toBe(1)
    // Where rooms ARE bound the same GET is 426, and the client retries.
    const rooms: RoomNamespace = {
      idFromName: (name) => name,
      get: () => ({ fetch: async () => new Response('to the room') }),
    }
    const on = harness(real({ ROOMS: rooms }))
    on.client.connect()
    on.last().drop(1006)
    for (let i = 0; i < 4; i++) await Promise.resolve()
    on.advance(1000)
    expect(on.sockets.length).toBe(2)
    expect(on.client.status).not.toBe('closed')
  })
})

describe('the pose frame (§7.2): the lap recorder’s own', () => {
  it('puts a sim body where recordPose puts it, rotation to sign', () => {
    const worldOffset: [number, number, number] = [-2048, 0, 2048]
    const body = {
      position: { x: -857.8, y: 126.4, z: 2082.4 },
      orientation: { x: 0.1, y: -0.7, z: 0.2, w: 0.678 },
      velocity: { x: 12, y: -3, z: 150 },
    }
    const n = Math.hypot(0.1, 0.7, 0.2, 0.678)
    body.orientation = {
      x: body.orientation.x / n,
      y: body.orientation.y / n,
      z: body.orientation.z / n,
      w: body.orientation.w / n,
    }
    const rec = createLapRecorder(worldOffset, 4)
    recordPose(rec, 0, body.position, body.orientation)
    const r = fillOwnPose(poseRecord(), body, worldOffset, {
      pitch: 0.5,
      roll: -0.25,
      yaw: 0,
      throttle: 1,
      flags: 1,
    })
    const d = rec.poses
    expect([r.px, r.py, r.pz]).toEqual([d[0], d[1], d[2]])
    const dot =
      r.qx * (d[3] as number) +
      r.qy * (d[4] as number) +
      r.qz * (d[5] as number) +
      r.qw * (d[6] as number)
    expect(Math.abs(dot)).toBeCloseTo(1, 12)
    // Velocity is position's derivative: the same flip, measured by moving the body.
    const later = { ...body.position, z: body.position.z + body.velocity.z * 0.01 }
    recordPose(rec, 1, later, body.orientation)
    expect(((d[9] as number) - (d[2] as number)) / 0.01).toBeCloseTo(r.vz, 6)
  })
})
