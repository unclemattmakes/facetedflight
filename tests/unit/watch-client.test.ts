// tests/unit/watch-client.test.ts — a viewer's socket that never opened. DEV-470.
//
// A `?watch=` link opens `game/watch-client.ts`'s socket to the room's
// broadcaster. Until DEV-470 a handshake that failed was retried every four
// seconds for as long as the page stayed open, and said nothing: on a site
// with no rooms bound (production before its binding, where a release build
// now offers rooms, D36) a viewer sat on the title with no word of why. Now it
// is diagnosed once, as a player's socket is (`room-client.ts`), and given up
// after the rejoin window. The probe is answered by the REAL Pages Function
// (`routeToWatch`), so the status it reads is the one the site sends.
//
// A fake socket and fake timers: the lifecycle is under test, not the network.

import { describe, expect, it } from 'vitest'
import {
  ROOM_OFF,
  ROOM_RESTING,
  ROOM_RETRY_GIVE_UP_MS,
  ROOM_UNREACHABLE,
  type RoomSocket,
  roomNotice,
} from '@/game/room-client'
import { WatchClient, watchUrl } from '@/game/watch-client'
import { CLOSE } from '@/net/room-protocol'
import { type RoomEnv, type RoomNamespace, routeToWatch } from '@/net/room-route'

class FakeSocket implements RoomSocket {
  binaryType = 'blob'
  readyState = 0
  readonly sent: Array<string | ArrayBufferView | ArrayBuffer> = []
  onopen: ((e: unknown) => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: ((e: { code: number; reason: string }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  constructor(readonly url: string) {}
  send(data: string | ArrayBufferView | ArrayBuffer) {
    this.sent.push(data)
  }
  close(code = 1000, reason = '') {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }
  open() {
    this.readyState = 1
    this.onopen?.({})
  }
  drop(code: number) {
    this.readyState = 3
    this.onclose?.({ code, reason: '' })
  }
}

const URL_ = watchUrl('K7QX4M2', { protocol: 'https:', host: 'ff-10yr.pages.dev' })

const harness = (probe?: (url: string) => Promise<number>) => {
  let now = 0
  const sockets: FakeSocket[] = []
  const timers: Array<{ fn: () => void; at: number; live: boolean }> = []
  const probed: string[] = []
  const client = new WatchClient({
    url: URL_,
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
    ...(probe
      ? {
          probe: (url: string) => {
            probed.push(url)
            return probe(url)
          },
        }
      : {}),
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
  const settle = async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve()
  }
  return { client, sockets, last, advance, settle, probed }
}

/** The real Pages Function, answering the probe's own request. */
const real = (env: RoomEnv) => async (url: string) =>
  (await routeToWatch(new Request(url), env)).status

describe('DEV-470 — a watch link that never opened', () => {
  it('on a site with no rooms bound: says so at once, asking the real route once', async () => {
    const h = harness(real({}))
    h.client.connect()
    h.last().drop(1006)
    await h.settle()
    expect(h.probed).toEqual(['https://ff-10yr.pages.dev/api/watch/K7QX4M2'])
    expect(h.client.status).toBe('closed')
    expect(h.client.closeCode).toBe(ROOM_OFF)
    expect(h.client.notice).toBe(roomNotice(ROOM_OFF))
    h.advance(60_000)
    expect(h.sockets.length, 'no second handshake').toBe(1)
    // Where rooms ARE bound the same GET reads 426, and the viewer retries.
    const rooms: RoomNamespace = {
      idFromName: (name) => name,
      get: () => ({ fetch: async () => new Response('to the broadcaster') }),
    }
    const bound = harness(real({ ROOMS: rooms }))
    bound.client.connect()
    bound.last().drop(1006)
    await bound.settle()
    bound.advance(1000)
    expect(bound.sockets.length).toBe(2)
    expect(bound.client.status).toBe('retrying')
  })

  it('reads the day’s quota (429) as resting', async () => {
    const h = harness(async () => 429)
    h.client.connect()
    h.last().drop(1006)
    await h.settle()
    expect(h.client.closeCode).toBe(ROOM_RESTING)
    expect(h.client.notice).toMatch(/resting until 00:00 UTC/)
  })

  it('gives up after the rejoin window, and calls it unreachable (an opened one does not)', () => {
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

    // Unchanged beside it: a watch that HAD opened keeps retrying past the
    // window, and is never diagnosed (a broadcaster that went away mid-race
    // may come back) ...
    const was = harness(async () => 503)
    was.client.connect()
    was.last().open()
    was.last().drop(1006)
    for (let t = 0; t < ROOM_RETRY_GIVE_UP_MS + 10_000; t += 1000) {
      const s = was.last()
      if (s.readyState === 0) s.drop(1006)
      was.advance(1000)
    }
    expect(was.client.status).toBe('retrying')
    expect(was.probed, 'only a socket that never opened is diagnosed').toEqual([])
    // ... and the broadcaster's own close codes stop it with their line.
    const refused = harness(async () => 426)
    refused.client.connect()
    refused.last().drop(CLOSE.mismatch)
    expect(refused.client.status).toBe('closed')
    expect(refused.client.notice).toMatch(/reload to update/)
    expect(refused.probed).toEqual([])
  })
})
