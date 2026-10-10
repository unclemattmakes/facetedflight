// The room's own tier (plan/MULTIPLAYER.md §9.2, DEV-386's gates): the real
// `RoomServer` against a fake connection list, fake storage and a fake clock.
// Every close code, cap and barrier case. Each gate names the bug it was shown
// red against.

import { describe, expect, it } from 'vitest'
import { PRIVACY_POSES_PER_SECOND, privacyPage } from '@/net/privacy-page'
import {
  CLOSE,
  POSE_AT,
  POSE_HEADER_BYTES,
  POSE_KIND,
  POSE_RECORD_BYTES,
  POSE_TAG_V1,
  ROOM_JUDGE_GRACE_MS,
  ROOM_LOAD_TIMEOUT_MS,
  ROOM_PROTOCOL,
  ROOM_RATE_BURST,
  ROOM_REJOIN_MS,
  ROOM_START_MARGIN_MS,
  type RoomSettings,
  type RoomVerdict,
} from '@/net/room-protocol'
import { type FakeConn, FakeRoom } from './helpers/fake-room'

const CONTENT = 'ab12cd34ef56ab12'

const SETTINGS: RoomSettings = {
  mission: 'int_01_hoverJet',
  edition: 'anniversary',
  bots: true,
  seats: 6,
  colours: 6,
  countdown: 3000,
  timeLimit: 180_000,
  rules: { standard: '1.28a93c83', acrobat: '1.c871d2df', speed: '1.e6e44eda' },
}

const join = (over: Record<string, unknown> = {}) => ({
  type: 'join',
  protocol: ROOM_PROTOCOL,
  handle: 'Swift Kestrel 42',
  variant: 'standard',
  colour: 0,
  content: CONTENT,
  ...over,
})

/** A room with `n` joined players; the first is the owner and has configured it. */
const lobby = async (n: number, settings: RoomSettings = SETTINGS) => {
  const room = await FakeRoom.open()
  const conns: FakeConn[] = []
  for (let i = 0; i < n; i++) {
    const c = await room.connect(`c${i}`)
    await room.send(c, join({ colour: i }))
    conns.push(c)
    if (i === 0) await room.send(c, { type: 'configure', settings })
  }
  return { room, conns }
}

const readyAll = async (room: FakeRoom, conns: FakeConn[]) => {
  for (const c of conns) {
    await room.send(c, { type: 'ready', ready: true, rules: SETTINGS.rules.standard })
  }
}

/** Joined, configured, all ready, START pressed: the room is holding at the barrier. */
const loading = async (n: number) => {
  const { room, conns } = await lobby(n)
  await readyAll(room, conns)
  const [owner] = conns as [FakeConn]
  await room.send(owner, { type: 'start' })
  return { room, conns }
}

/** One pose message with `records` (kind, index), header slot byte forged to `slot`. */
const pose = (slot: number, tick: number, records: Array<[number, number]>): Uint8Array => {
  const out = new Uint8Array(POSE_HEADER_BYTES + POSE_RECORD_BYTES * records.length)
  const v = new DataView(out.buffer)
  out[POSE_AT.tag] = POSE_TAG_V1
  out[POSE_AT.slot] = slot
  out[POSE_AT.count] = records.length
  v.setUint32(POSE_AT.tick, tick, true)
  records.forEach(([kind, index], i) => {
    const at = POSE_HEADER_BYTES + i * POSE_RECORD_BYTES
    out[at + POSE_AT.kind] = kind
    out[at + POSE_AT.index] = index
    v.setInt32(at + POSE_AT.position, 1000 * i, true)
  })
  return out
}

describe('joining', () => {
  it('hands each player a slot, a tenure, a seat token and the owner', async () => {
    const { conns } = await lobby(3)
    const hellos = conns.map((c) => c.last('hello') as Record<string, unknown>)
    expect(hellos.map((h) => h.slot)).toEqual([0, 1, 2])
    expect(hellos.map((h) => h.joinSeq)).toEqual([0, 1, 2])
    expect(hellos.every((h) => h.owner === 0)).toBe(true)
    const seats = hellos.map((h) => h.seat as string)
    expect(new Set(seats).size).toBe(3)
    for (const s of seats) expect(s).toMatch(/^[A-Za-z0-9_-]{22,}$/)
  })

  it('closes a join with another protocol, 4002', async () => {
    const room = await FakeRoom.open()
    const c = await room.connect('c0')
    await room.send(c, join({ protocol: ROOM_PROTOCOL + 1 }))
    expect(room.closes()).toEqual({ c0: CLOSE.mismatch })
  })

  // DEV-441b: a code typed by hand. Red against the room without the check:
  // the typist is seated as the owner of a new, empty room of that name.
  it('closes a join for an EXISTING room where nobody is, 4004 — a typo is not a new room', async () => {
    const room = await FakeRoom.open()
    const c = await room.connect('typist')
    await room.send(c, join({ existing: true }))
    expect(room.closes()).toEqual({ typist: CLOSE.missing })
    expect(c.last('hello')).toBeUndefined()
  })

  it('seats a join for an EXISTING room somebody is in, as any other', async () => {
    const { room } = await lobby(1)
    const c = await room.connect('friend')
    await room.send(c, join({ colour: 1, existing: true }))
    expect(room.closes()).toEqual({})
    expect((c.last('hello') as Record<string, unknown>).slot).toBe(1)
  })

  it('makes the room for a join that does not ask for an existing one (a link, a host)', async () => {
    const room = await FakeRoom.open()
    const c = await room.connect('host')
    await room.send(c, join())
    expect(room.closes()).toEqual({})
    expect((c.last('hello') as Record<string, unknown>).owner).toBe(0)
  })

  it('closes a join for an existing room once everyone has LEFT the lobby, 4004', async () => {
    const { room, conns } = await lobby(1)
    await room.disconnect(conns[0] as FakeConn)
    const c = await room.connect('late')
    await room.send(c, join({ existing: true }))
    expect(room.closes().late).toBe(CLOSE.missing)
  })

  it('closes a join made from other generated content, 4002', async () => {
    const { room } = await lobby(1)
    const c = await room.connect('late')
    await room.send(c, join({ content: 'ffffffffffffffff' }))
    expect(room.closes()).toEqual({ late: CLOSE.mismatch })
  })

  it('closes a join past the configured seats, 4000', async () => {
    const { room } = await lobby(2, { ...SETTINGS, seats: 2, colours: 6 })
    const c = await room.connect('third')
    await room.send(c, join({ colour: 2 }))
    expect(room.closes()).toEqual({ third: CLOSE.full })
  })

  it('closes a join after START, 4001 — no mid-race joins', async () => {
    const { room } = await loading(2)
    const c = await room.connect('late')
    await room.send(c, join({ colour: 3 }))
    expect(room.closes()).toEqual({ late: CLOSE.started })
  })

  it('ignores every message before `join`', async () => {
    const room = await FakeRoom.open()
    const c = await room.connect('c0')
    await room.send(c, { type: 'ping', t0: 1 })
    await room.send(c, { type: 'configure', settings: SETTINGS })
    expect(c.sent).toEqual([])
    expect(room.server.settings).toBeNull()
  })
})

describe('colours (§6.4): one a player, first come', () => {
  it('gives a joiner whose colour is taken the lowest free one', async () => {
    const { room } = await lobby(2)
    const c = await room.connect('c2')
    await room.send(c, join({ colour: 1 }))
    expect(
      (c.last('hello') as { players: Record<number, { colour: number }> }).players[2]?.colour,
    ).toBe(2)
  })

  it('refuses a taken colour with `colour-taken`, and keeps the old one', async () => {
    const { room, conns } = await lobby(2)
    const b = conns[1] as FakeConn
    await room.send(b, { type: 'ready', ready: false, colour: 0 })
    expect(b.last('error')).toMatchObject({ code: 'colour-taken' })
    expect(room.server.players()[1]?.colour).toBe(1)
    await room.send(b, { type: 'ready', ready: false, colour: 4 })
    expect(room.server.players()[1]?.colour).toBe(4)
  })
})

describe('the owner (§7.1): lowest joinSeq, the room computes it', () => {
  it('passes by tenure when the owner leaves, and says so in player-left', async () => {
    const { room, conns } = await lobby(3)
    const [a, b, c] = conns as [FakeConn, FakeConn, FakeConn]
    await room.disconnect(a)
    expect(room.server.owner()).toBe(1)
    expect(b.last('player-left')).toMatchObject({ slot: 0, owner: 1, held: false })
    expect(c.last('player-left')).toMatchObject({ slot: 0, owner: 1 })
  })

  it('refuses configure and start from anyone else', async () => {
    const { room, conns } = await lobby(2)
    const b = conns[1] as FakeConn
    await room.send(b, { type: 'configure', settings: { ...SETTINGS, bots: false } })
    expect(b.last('error')).toMatchObject({ code: 'not-owner' })
    expect(room.server.settings?.bots).toBe(true)
  })
})

// ── DEV-459: the owner removes a player (Matt, 2026-09-27: "add a kick row") ──
//
// Each case names what it was shown red against.

const PAGE = { a: 'pageAAAAAAAAAAAAAAAAAA', b: 'pageBBBBBBBBBBBBBBBBBB' }

describe('kick (DEV-459)', () => {
  /** An owner and a guest, each from a page of its own. */
  const pair = async () => {
    const room = await FakeRoom.open()
    const a = await room.connect('a')
    await room.send(a, join({ colour: 0, page: PAGE.a }))
    await room.send(a, { type: 'configure', settings: SETTINGS })
    const b = await room.connect('b')
    await room.send(b, join({ colour: 1, page: PAGE.b }))
    return { room, a, b, seatB: (b.last('hello') as Record<string, unknown>).seat as string }
  }

  // Red against a room with no `kick` case: B stays, and nobody hears a thing.
  it('the owner removes a player: closed 4008, the seat freed, and everyone told', async () => {
    const { room, a, b } = await pair()
    await room.send(a, { type: 'kick', slot: 1 })
    expect(room.closes()).toEqual({ b: CLOSE.kicked })
    expect(b.last('error')).toMatchObject({ code: String(CLOSE.kicked) })
    expect(Object.keys(room.server.players())).toEqual(['0'])
    expect(a.last('player-left')).toMatchObject({ slot: 1, owner: 0, held: false })
    // The kicked socket is no longer a seat: its attachment is cleared, so
    // nothing it sends is heard as slot 1 (whoever takes that slot next), and
    // a room woken from hibernation does not count it. (A check on what it
    // HEARS could not fail here: a closed fake socket hears nothing anyway.)
    expect(b.state).toBeNull()
  })

  // Red against a room that takes a kick from anyone: A would be the one closed.
  it('refuses a kick from anyone but the owner, and nothing moves', async () => {
    const { room, b } = await pair()
    await room.send(b, { type: 'kick', slot: 0 })
    expect(b.last('error')).toMatchObject({ code: 'not-owner' })
    expect(room.closes()).toEqual({})
    expect(Object.keys(room.server.players())).toEqual(['0', '1'])
  })

  it('refuses a kick of nobody, and of the owner itself', async () => {
    const { room, a } = await pair()
    await room.send(a, { type: 'kick', slot: 5 })
    expect(a.last('error')).toMatchObject({ code: 'no-player' })
    await room.send(a, { type: 'kick', slot: 0 })
    expect(a.last('error')).toMatchObject({ code: 'no-player' })
    expect(room.closes()).toEqual({})
  })

  // Red against a room that kicks mid-race: B's seat, row and verdict would go.
  it('refuses a kick during a race: loading onwards is the race’s, not the lobby’s', async () => {
    const { room, conns } = await loading(2)
    const [a] = conns as [FakeConn]
    await room.send(a, { type: 'kick', slot: 1 })
    expect(a.last('error')).toMatchObject({ code: 'race' })
    expect(room.closes()).toEqual({})
    expect(Object.keys(room.server.players())).toEqual(['0', '1'])
  })

  // Red against a room that keeps no list: the token takes the seat straight back.
  it('keeps the kicked SEAT TOKEN out: a reconnect with it is closed 4008', async () => {
    const { room, a, seatB } = await pair()
    await room.send(a, { type: 'kick', slot: 1 })
    const back = await room.connect('b-again')
    await room.send(back, join({ colour: 1, seat: seatB }))
    expect(room.closes()['b-again']).toBe(CLOSE.kicked)
    expect(Object.keys(room.server.players())).toEqual(['0'])
  })

  // Red against a list of seat tokens only: a fresh join from the page walks in.
  it('keeps the kicked PAGE out: a fresh join from it, with no seat token, is closed 4008', async () => {
    const { room, a } = await pair()
    await room.send(a, { type: 'kick', slot: 1 })
    const fresh = await room.connect('b-fresh')
    await room.send(fresh, join({ colour: 1, page: PAGE.b, handle: 'Calm Wren 19' }))
    expect(room.closes()['b-fresh']).toBe(CLOSE.kicked)
    // Another page is welcome, into the freed seat.
    const c = await room.connect('c')
    await room.send(c, join({ colour: 2, page: 'pageCCCCCCCCCCCCCCCCCC' }))
    expect(room.closes().c).toBeUndefined()
    expect((c.last('hello') as Record<string, unknown>).slot).toBe(1)
  })

  // Red against a kick that only closes the socket: the full room stays full.
  it('frees the seat: a full room takes a new player once one is removed', async () => {
    const small = { ...SETTINGS, seats: 2 }
    const { room, conns } = await lobby(2, small)
    const [a] = conns as [FakeConn]
    const late = await room.connect('late')
    await room.send(late, join({ colour: 3 }))
    expect(room.closes().late).toBe(CLOSE.full)
    await room.send(a, { type: 'kick', slot: 1 })
    const next = await room.connect('next')
    await room.send(next, join({ colour: 3 }))
    expect(room.closes().next).toBeUndefined()
    expect(Object.keys(room.server.players())).toEqual(['0', '1'])
  })

  it('forgets the list when the room clears: a new room of that name starts clean', async () => {
    const { room, a, seatB } = await pair()
    await room.send(a, { type: 'kick', slot: 1 })
    await room.disconnect(a)
    const again = await room.connect('b-later')
    await room.send(again, join({ colour: 1, seat: seatB, page: PAGE.b }))
    expect(room.closes()['b-later']).toBeUndefined()
    expect((again.last('hello') as Record<string, unknown>).owner).toBe(0)
  })

  it('keeps the list through an eviction (it is stored, not in memory)', async () => {
    const { room, a } = await pair()
    await room.send(a, { type: 'kick', slot: 1 })
    await room.evict()
    const fresh = await room.connect('b-after')
    await room.send(fresh, join({ colour: 1, page: PAGE.b }))
    expect(room.closes()['b-after']).toBe(CLOSE.kicked)
  })
})

describe('rules (§6.8)', () => {
  it('closes a ready whose rules differ for its variant, 4002', async () => {
    const { room, conns } = await lobby(2)
    const b = conns[1] as FakeConn
    await room.send(b, { type: 'ready', ready: true, rules: '1.00000000' })
    expect(room.closes()).toEqual({ c1: CLOSE.mismatch })
  })

  it('checks each player against ITS OWN variant: mixed variants may race (§11 call 7)', async () => {
    const { room, conns } = await lobby(2)
    const b = conns[1] as FakeConn
    await room.send(b, {
      type: 'ready',
      ready: true,
      variant: 'speed',
      rules: SETTINGS.rules.speed,
    })
    expect(room.closes()).toEqual({})
    expect(room.server.players()[1]).toMatchObject({ variant: 'speed', ready: true })
  })

  it('un-readies everyone when the owner changes the settings', async () => {
    const { room, conns } = await lobby(2)
    await readyAll(room, conns)
    await room.send(conns[0] as FakeConn, {
      type: 'configure',
      settings: { ...SETTINGS, bots: false },
    })
    expect(Object.values(room.server.players()).map((p) => p.ready)).toEqual([false, false])
  })
})

describe('the start barrier (§6.3)', () => {
  it('holds for the whole cohort, then fires once', async () => {
    const { room, conns } = await loading(3)
    const [a, b, c] = conns as [FakeConn, FakeConn, FakeConn]
    expect(a.last('loading')).toMatchObject({ loaded: [] })
    await room.send(a, { type: 'loaded' })
    room.now += 500
    await room.send(b, { type: 'loaded' })
    expect(conns.flatMap((x) => x.ofType('start'))).toEqual([])
    expect(b.last('loading')).toMatchObject({ loaded: [0, 1] })
    room.now += 500
    await room.send(c, { type: 'loaded' })
    expect(conns.map((x) => x.ofType('start').length)).toEqual([1, 1, 1])
    // A re-report (a reconnect) is answered to itself, never re-fired for the field.
    await room.send(c, { type: 'loaded' })
    expect(conns.map((x) => x.ofType('start').length)).toEqual([1, 1, 2])
  })

  it('schedules GO in the future by the countdown plus the margin', async () => {
    const { room, conns } = await loading(2)
    for (const c of conns) await room.send(c, { type: 'loaded' })
    const released = room.now
    const start = (conns[0] as FakeConn).last('start') as { goAt: number; field: number }
    expect(start.goAt - released).toBe(SETTINGS.countdown + ROOM_START_MARGIN_MS)
    expect(start.field).toBe(start.goAt)
    expect(room.server.phase()).toBe('countdown')
    room.now = start.goAt
    expect(room.server.phase()).toBe('racing')
  })

  it('fires on the timeout with whoever made it, and not before', async () => {
    const { room, conns } = await loading(2)
    const [a, b] = conns as [FakeConn, FakeConn]
    const since = room.now
    expect(room.alarm).toBe(since + ROOM_LOAD_TIMEOUT_MS)
    await room.send(a, { type: 'loaded' })
    room.now = since + ROOM_LOAD_TIMEOUT_MS - 1
    await room.fireAlarm()
    expect(a.ofType('start')).toEqual([])
    room.now = since + ROOM_LOAD_TIMEOUT_MS
    await room.fireAlarm()
    expect(a.ofType('start')).toHaveLength(1)
    // The straggler hears no GO it cannot make; it gets its own when it arrives.
    expect(b.ofType('start')).toEqual([])
    room.now += 4000
    await room.send(b, { type: 'loaded' })
    const own = b.last('start') as { goAt: number; field: number; goAts: Record<number, number> }
    expect(own.goAt).toBe(room.now + SETTINGS.countdown + ROOM_START_MARGIN_MS)
    expect(own.field).toBe((a.last('start') as { goAt: number }).goAt)
    expect(own.goAts[1]).toBe(own.goAt)
    expect(a.last('late')).toEqual({ type: 'late', slot: 1, goAt: own.goAt })
  })

  it('does not release when a cohort member leaves before loading', async () => {
    const { room, conns } = await loading(2)
    const [a, b] = conns as [FakeConn, FakeConn]
    await room.send(a, { type: 'loaded' })
    await room.disconnect(b)
    expect(a.ofType('start')).toEqual([])
    expect(a.last('player-left')).toMatchObject({ slot: 1, held: true })
  })

  it('gives the people the first starts, one each, and fills the rest with bots in free colours', async () => {
    // DEV-477: one list of starts (the pad, then the racers' own). Two people
    // take starts 0 and 1, in the room's shuffle; the bots take 2 to 5. Red
    // against DEV-389's room, whose bots took 0 to 3 of a DIFFERENT list (the
    // racers' own, with the people on a row of their own).
    const { room, conns } = await loading(2)
    const race = (conns[0] as FakeConn).last('loading')?.race as {
      starts: Record<number, number>
      bots: Array<{ start: number; colour: number }>
      colours: Record<number, number>
    }
    expect(Object.values(race.starts).sort()).toEqual([0, 1])
    expect(race.colours).toEqual({ 0: 0, 1: 1 })
    expect(race.bots.map((b) => b.start)).toEqual([2, 3, 4, 5])
    expect(race.bots.map((b) => b.colour)).toEqual([2, 3, 4, 5])
    expect(room.server.race).toEqual(race)
  })

  it('leaves the empty starts empty with bots off', async () => {
    const { room, conns } = await lobby(2, { ...SETTINGS, bots: false })
    await readyAll(room, conns)
    await room.send(conns[0] as FakeConn, { type: 'start' })
    expect(room.server.race?.bots).toEqual([])
  })
})

describe('poses (§7.2)', () => {
  const racing = async (n: number) => {
    const { room, conns } = await loading(n)
    for (const c of conns) await room.send(c, { type: 'loaded' })
    return { room, conns }
  }

  it("overwrites the record's slot byte with the sender's", async () => {
    const { room, conns } = await racing(3)
    const [a, b, c] = conns as [FakeConn, FakeConn, FakeConn]
    // b forges slot 0 (a's). The room writes b's own, 1.
    await room.sendBinary(b, pose(0, 40, [[POSE_KIND.own, 0]]))
    const got = [a, c].map((x) => x.binary().at(-1))
    expect(got.map((m) => m?.[POSE_AT.slot])).toEqual([1, 1])
    expect(b.binary()).toEqual([]) // no self-echo
  })

  it('forwards bot records only from the owner, the bot host (§6.6)', async () => {
    const { room, conns } = await racing(2)
    const [a, b] = conns as [FakeConn, FakeConn]
    await room.sendBinary(
      b,
      pose(1, 40, [
        [POSE_KIND.own, 0],
        [POSE_KIND.bot, 0],
      ]),
    )
    expect(a.binary()).toEqual([])
    await room.sendBinary(
      a,
      pose(0, 40, [
        [POSE_KIND.own, 0],
        [POSE_KIND.bot, 0],
        [POSE_KIND.bot, 1],
      ]),
    )
    expect(b.binary()).toHaveLength(1)
  })

  it('drops a message whose count disagrees with its length, and one in the lobby', async () => {
    const { room, conns } = await racing(2)
    const [a, b] = conns as [FakeConn, FakeConn]
    const bad = pose(0, 40, [[POSE_KIND.own, 0]])
    bad[POSE_AT.count] = 2
    await room.sendBinary(a, bad)
    expect(b.binary()).toEqual([])
    const quiet = await lobby(2)
    await quiet.room.sendBinary(quiet.conns[0] as FakeConn, pose(0, 0, [[POSE_KIND.own, 0]]))
    expect((quiet.conns[1] as FakeConn).binary()).toEqual([])
  })

  it('closes a pose message larger than the seats allow, 4003', async () => {
    const { room, conns } = await racing(2)
    const seven = Array.from({ length: 7 }, (_, i): [number, number] => [POSE_KIND.bot, i])
    await room.sendBinary(conns[0] as FakeConn, pose(0, 40, seven))
    expect(room.closes()).toEqual({ c0: CLOSE.abuse })
  })
})

describe('caps (§6.10)', () => {
  it('drops then closes a sender over the rate cap, 4003', async () => {
    const { room, conns } = await lobby(2)
    const [a, b] = conns as [FakeConn, FakeConn]
    const before = b.sent.length
    for (let i = 0; i < ROOM_RATE_BURST + 5; i++) {
      await room.send(a, { type: 'ready', ready: false, colour: i % 2 === 0 ? 3 : 4 })
    }
    expect(room.closes()).toEqual({ c0: CLOSE.abuse })
    // The bucket's depth was answered; nothing past it was.
    const lobbies = b.sent.length - before
    expect(lobbies).toBeLessThanOrEqual(ROOM_RATE_BURST)
    expect(lobbies).toBeGreaterThan(ROOM_RATE_BURST - 10)
  })

  it('lets a steady 20 Hz sender through indefinitely', async () => {
    const { room, conns } = await lobby(1)
    const a = conns[0] as FakeConn
    for (let i = 0; i < 400; i++) {
      room.now += 49
      await room.send(a, { type: 'ping', t0: i })
    }
    expect(room.closes()).toEqual({})
    expect(a.ofType('pong')).toHaveLength(400)
  })

  it('closes a text message over the size cap, 4003', async () => {
    const { room, conns } = await lobby(1)
    await room.send(conns[0] as FakeConn, `{"type":"ping","t0":1,"pad":"${'x'.repeat(5000)}"}`)
    expect(room.closes()).toEqual({ c0: CLOSE.abuse })
  })
})

describe('clock (§6.3)', () => {
  it("answers a ping with the sender's t0 and the room's time", async () => {
    const { room, conns } = await lobby(1)
    room.now = 1_234_567
    await room.send(conns[0] as FakeConn, { type: 'ping', t0: 42.5 })
    expect((conns[0] as FakeConn).last('pong')).toEqual({ type: 'pong', t0: 42.5, room: 1_234_567 })
  })
})

describe('storage (§6.2): an evicted room resumes', () => {
  it('resumes mid-lobby from storage — settings, players, colours, ready, owner', async () => {
    const { room, conns } = await lobby(2)
    await readyAll(room, conns)
    const before = room.server.players()
    await room.evict()
    expect(room.server.settings).toEqual(SETTINGS)
    expect(room.server.players()).toEqual(before)
    expect(room.server.owner()).toBe(0)
    // And it still works: the owner can start the race it configured.
    await room.send(conns[0] as FakeConn, { type: 'start' })
    expect((conns[1] as FakeConn).last('loading')).toBeDefined()
  })

  it('resumes a held barrier: the timeout still fires after eviction', async () => {
    const { room, conns } = await loading(2)
    await room.send(conns[0] as FakeConn, { type: 'loaded' })
    await room.evict()
    room.now += ROOM_LOAD_TIMEOUT_MS
    await room.fireAlarm()
    expect((conns[0] as FakeConn).ofType('start')).toHaveLength(1)
  })

  it('clears its storage when the lobby empties', async () => {
    const { room, conns } = await lobby(2)
    for (const c of conns) await room.disconnect(c)
    expect(room.stored.size).toBe(0)
    expect(room.server.settings).toBeNull()
  })

  it('holds an empty race for the rejoin window, then clears it', async () => {
    const { room, conns } = await loading(2)
    for (const c of conns) await room.send(c, { type: 'loaded' })
    for (const c of conns) await room.disconnect(c)
    expect(room.stored.size).toBe(1)
    expect(room.alarm).toBe(room.now + ROOM_REJOIN_MS)
    room.now += ROOM_REJOIN_MS - 1
    await room.fireAlarm()
    expect(room.stored.size).toBe(1)
    room.now += 1
    await room.fireAlarm()
    expect(room.stored.size).toBe(0)
    expect(room.alarm).toBeNull()
  })

  it('wakes for the EARLIER of two deadlines: a held barrier in an emptied room', async () => {
    const { room, conns } = await loading(2)
    const since = room.now
    for (const c of conns) await room.disconnect(c)
    expect(room.alarm).toBe(since + ROOM_LOAD_TIMEOUT_MS)
    room.now = since + ROOM_LOAD_TIMEOUT_MS
    await room.fireAlarm()
    expect(room.alarm).toBe(since + ROOM_REJOIN_MS)
  })
})

describe('reconnect (§6.9)', () => {
  it('gives a racer its seat back for its token, inside the window', async () => {
    const { room, conns } = await loading(2)
    const [a, b] = conns as [FakeConn, FakeConn]
    const seat = (b.last('hello') as { seat: string }).seat
    await room.disconnect(b)
    room.now += ROOM_REJOIN_MS - 1
    const b2 = await room.connect('c1-again')
    await room.send(b2, join({ colour: 1, seat }))
    expect(b2.last('hello')).toMatchObject({ slot: 1, phase: 'loading' })
    expect(a.last('player-joined')).toMatchObject({ slot: 1 })
    expect(room.closes()).toEqual({ c1: 1000 })
  })

  it('takes a seat over from a half-open socket, closing the old one 4005', async () => {
    const { room, conns } = await loading(2)
    const b = conns[1] as FakeConn
    const seat = (b.last('hello') as { seat: string }).seat
    const b2 = await room.connect('c1-again')
    await room.send(b2, join({ colour: 1, seat }))
    expect(room.closes()).toEqual({ c1: CLOSE.replaced })
    // The old socket's close, delivered late, does not unseat the new one.
    await room.server.onClose(b)
    expect(room.server.players()[1]?.present).toBe(true)
  })

  it('refuses a token past the window, 4001', async () => {
    const { room, conns } = await loading(2)
    const b = conns[1] as FakeConn
    const seat = (b.last('hello') as { seat: string }).seat
    await room.disconnect(b)
    room.now += ROOM_REJOIN_MS + 1
    const b2 = await room.connect('c1-again')
    await room.send(b2, join({ colour: 1, seat }))
    expect(room.closes()['c1-again']).toBe(CLOSE.started)
  })
})

describe('events (§6.5, §6.7)', () => {
  it('stamps the slot on ring, reset, prop and finish, and echoes none', async () => {
    const { room, conns } = await loading(2)
    for (const c of conns) await room.send(c, { type: 'loaded' })
    const [a, b] = conns as [FakeConn, FakeConn]
    await room.send(b, { type: 'ring', gate: 3, tick: 900, slot: 0 })
    await room.send(b, { type: 'prop', id: '2:417', tick: 950 })
    await room.send(b, { type: 'finish', tick: 9000 })
    expect(a.last('ring')).toEqual({ type: 'ring', gate: 3, tick: 900, slot: 1 })
    expect(a.last('prop')).toEqual({ type: 'prop', id: '2:417', tick: 950, slot: 1 })
    expect(a.last('finish')).toEqual({ type: 'finish', tick: 9000, slot: 1 })
    expect(b.ofType('ring')).toEqual([])
  })

  it("takes a bot's finish only from the bot host", async () => {
    const { room, conns } = await loading(2)
    for (const c of conns) await room.send(c, { type: 'loaded' })
    const [a, b] = conns as [FakeConn, FakeConn]
    await room.send(b, { type: 'finish', tick: 9000, bot: 0 })
    expect(a.ofType('finish')).toEqual([])
    await room.send(a, { type: 'finish', tick: 9100, bot: 0 })
    expect(b.last('finish')).toEqual({ type: 'finish', tick: 9100, bot: 0, slot: 0 })
  })
})

describe('verdicts (§6.5): only through the binding', () => {
  const verdict = (slot: number): RoomVerdict => ({
    slot,
    verdict: 'ok',
    ticks: 9000,
    seconds: 109.8,
    rings: 21,
    ringsTotal: 21,
    score2016: 2100,
    tainted: false,
    variant: 'standard',
  })

  it('ignores a verdict or results arriving on a socket', async () => {
    const { room, conns } = await loading(2)
    for (const c of conns) await room.send(c, { type: 'loaded' })
    const [a, b] = conns as [FakeConn, FakeConn]
    await room.send(b, { type: 'verdict', ...verdict(1) })
    await room.send(b, { type: 'results', results: [verdict(1)] })
    expect(room.server.results).toEqual([])
    expect(a.ofType('results')).toEqual([])
  })

  it('counts one through the binding, once per slot, and broadcasts results', async () => {
    const { room, conns } = await loading(2)
    for (const c of conns) await room.send(c, { type: 'loaded' })
    expect(await room.server.verdict(verdict(1))).toBe(true)
    expect(await room.server.verdict({ ...verdict(1), ticks: 1 })).toBe(false)
    expect(room.server.results).toEqual([verdict(1)])
    expect((conns[0] as FakeConn).last('results')).toEqual({
      type: 'results',
      results: [verdict(1)],
      bots: [],
    })
  })
})

describe('results and DNF (DEV-390, §6.5)', () => {
  const judged = (slot: number): RoomVerdict => ({
    slot,
    verdict: 'ok',
    ticks: 8000,
    seconds: 97.6,
    rings: 21,
    ringsTotal: 21,
    score2016: 2100,
    tainted: false,
    variant: 'standard',
  })
  const released = async (n: number) => {
    const { room, conns } = await loading(n)
    for (const c of conns) await room.send(c, { type: 'loaded' })
    const goAt = room.server.goAt as number
    const seats = conns.map((c) => (c.last('hello') as { seat: string }).seat)
    return { room, conns, goAt, seats }
  }

  it('DNFs a racer still out when the course clock and the judge grace run out', async () => {
    const { room, conns, goAt } = await released(2)
    const deadline = goAt + SETTINGS.timeLimit + ROOM_JUDGE_GRACE_MS
    expect(room.alarm).toBe(deadline)
    room.now = deadline - 1
    await room.fireAlarm()
    expect(room.server.results).toEqual([])
    room.now = deadline
    await room.fireAlarm()
    expect(room.server.results.map((r) => [r.slot, r.verdict])).toEqual([
      [0, 'dnf'],
      [1, 'dnf'],
    ])
    expect((conns[0] as FakeConn).last('results')).toMatchObject({
      results: [{ verdict: 'dnf' }, { verdict: 'dnf' }],
    })
    expect(room.server.phase()).toBe('results')
  })

  it('marks a player who LEFT mid-race DNF once the rejoin window closes', async () => {
    const { room, conns } = await released(2)
    await room.disconnect(conns[1] as FakeConn)
    const left = room.now
    room.now = left + ROOM_REJOIN_MS - 1
    await room.fireAlarm()
    expect(room.server.results).toEqual([])
    room.now = left + ROOM_REJOIN_MS
    await room.fireAlarm()
    expect(room.server.results).toEqual([
      expect.objectContaining({ slot: 1, verdict: 'left', ticks: null }),
    ])
  })

  it('answers a seat token only in a released race, for a racer not yet judged', async () => {
    const pre = await loading(2)
    const preSeat = ((pre.conns[0] as FakeConn).last('hello') as { seat: string }).seat
    expect(pre.room.server.seatInfo(preSeat)).toBeNull()
    const { room, seats } = await released(2)
    expect(room.server.seatInfo(seats[1] as string)).toEqual({
      slot: 1,
      mission: SETTINGS.mission,
      edition: SETTINGS.edition,
      variant: 'standard',
      rules: SETTINGS.rules.standard,
      // DEV-477: its start on the course's list, as the race froze it.
      start: room.server.race?.starts[1],
    })
    await room.server.verdict(judged(1))
    expect(room.server.seatInfo(seats[1] as string)).toBeNull()
    expect(room.server.seatInfo('x'.repeat(22))).toBeNull()
  })

  it('keeps an accepted lap to race, not a refused one, and forgets it when the room empties', async () => {
    const { room, conns } = await released(2)
    await room.server.verdict(judged(0))
    await room.server.verdict({ ...judged(1), verdict: 'speed', ticks: null, seconds: null })
    await room.server.keepLap(0, 'LAP-ZERO')
    await room.server.keepLap(1, 'LAP-ONE')
    expect(await room.server.keptLap(0)).toBe('LAP-ZERO')
    expect(await room.server.keptLap(1)).toBeNull()
    for (const c of conns) await room.disconnect(c)
    room.now += ROOM_REJOIN_MS
    await room.fireAlarm()
    expect([...room.stored.keys()]).toEqual([])
  })
})

// ── After the race (DEV-389, protocol 3) ────────────────────────────────────
//
// Red against protocol 2, where nothing took a room back: a race's room stayed
// `released` until it emptied, so a second race meant a second room and a new
// link, and a player who quit mid-race held the room's results for 30 s.
describe('after the race (DEV-389): again and forfeit', () => {
  const judged = (slot: number): RoomVerdict => ({
    slot,
    verdict: 'ok',
    ticks: 8000 + slot,
    seconds: 97.6,
    rings: 21,
    ringsTotal: 21,
    score2016: 2100,
    tainted: false,
    variant: 'standard',
  })
  const released = async (n: number) => {
    const { room, conns } = await loading(n)
    for (const c of conns) await room.send(c, { type: 'loaded' })
    return { room, conns }
  }

  it('takes a SETTLED race back to the lobby on the first `again`, and not before', async () => {
    const { room, conns } = await released(3)
    const [a, b, c] = conns as [FakeConn, FakeConn, FakeConn]
    await room.server.verdict(judged(0))
    await room.server.verdict(judged(1))
    // One racer still out: the race is not settled, and `again` is ignored.
    const heard = a.ofType('lobby').length
    await room.send(a, { type: 'again' })
    expect(room.server.phase()).not.toBe('lobby')
    expect(a.ofType('lobby')).toHaveLength(heard)
    await room.server.verdict(judged(2))
    expect(room.server.phase()).toBe('results')
    await room.send(b, { type: 'again' })
    expect(room.server.phase()).toBe('lobby')
    expect(room.server.race).toBeNull()
    expect(room.server.results).toEqual([])
    // Everyone hears it, with the phase; players, settings and colours kept, nobody ready.
    for (const x of [a, b, c]) {
      const msg = x.last('lobby') as { phase: string; players: Record<number, { ready: boolean }> }
      expect(msg.phase).toBe('lobby')
      expect(Object.keys(msg.players)).toEqual(['0', '1', '2'])
      expect(Object.values(msg.players).every((p) => !p.ready)).toBe(true)
    }
    expect(room.server.settings).toEqual(SETTINGS)
    // And the room races again: ready, START, a new loading roll call.
    await readyAll(room, conns)
    await room.send(a, { type: 'start' })
    expect(room.server.phase()).toBe('loading')
    // A second `again` in the new race's loading is ignored.
    await room.send(c, { type: 'again' })
    expect(room.server.phase()).toBe('loading')
  })

  it('drops a player who left the race and did not come back, when it goes back', async () => {
    const { room, conns } = await released(2)
    await room.disconnect(conns[1] as FakeConn)
    await room.server.verdict(judged(0))
    await room.send(conns[0] as FakeConn, { type: 'forfeit' }) // already judged: nothing
    room.now += ROOM_REJOIN_MS
    await room.fireAlarm()
    expect(room.server.phase()).toBe('results')
    await room.send(conns[0] as FakeConn, { type: 'again' })
    expect(Object.keys(room.server.players())).toEqual(['0'])
    // Its seat is free: a newcomer may take it in the lobby.
    const late = await room.connect('late')
    await room.send(late, join({ colour: 4 }))
    expect((late.last('hello') as { slot: number }).slot).toBe(1)
  })

  it('records a forfeit as `left` at once, and a lap posted after it is refused', async () => {
    const { room, conns } = await released(2)
    const [a, b] = conns as [FakeConn, FakeConn]
    const seat = (b.last('hello') as { seat: string }).seat
    await room.send(b, { type: 'forfeit' })
    expect(room.server.results).toEqual([
      expect.objectContaining({ slot: 1, verdict: 'left', ticks: null }),
    ])
    expect(a.last('results')).toMatchObject({ results: [{ slot: 1, verdict: 'left' }] })
    expect(room.server.seatInfo(seat)).toBeNull()
    expect(await room.server.verdict(judged(1))).toBe(false)
    // A second forfeit, or one from outside the race, changes nothing.
    await room.send(b, { type: 'forfeit' })
    expect(room.server.results).toHaveLength(1)
  })

  it('stops the start barrier waiting for a racer who forfeited while it loaded', async () => {
    const { room, conns } = await loading(3)
    const [a, b, c] = conns as [FakeConn, FakeConn, FakeConn]
    await room.send(a, { type: 'loaded' })
    await room.send(b, { type: 'loaded' })
    expect(room.server.phase()).toBe('loading')
    await room.send(c, { type: 'forfeit' })
    expect(room.server.phase()).toBe('countdown')
    expect(c.ofType('start')).toEqual([])
    // Everyone forfeiting settles the race outright, so `again` can end it.
    const two = await loading(2)
    for (const x of two.conns) await two.room.send(x, { type: 'forfeit' })
    expect(two.room.server.phase()).toBe('results')
    await two.room.send(two.conns[0] as FakeConn, { type: 'again' })
    expect(two.room.server.phase()).toBe('lobby')
  })

  it('ignores a forfeit in the lobby', async () => {
    const { room, conns } = await lobby(2)
    await room.send(conns[1] as FakeConn, { type: 'forfeit' })
    expect(room.server.results).toEqual([])
    expect(room.server.phase()).toBe('lobby')
  })
})

// ── What /privacy promises about a room (DEV-392) ──────────────────────────
//
// The page interpolates the room's own constants; the test above is the
// premise that the room keeps them (storage empty `ROOM_REJOIN_MS` after the
// last player leaves). Pinned here as sentences, so a change to either
// constant is a change somebody makes to this file on purpose.

describe('what /privacy says a room keeps', () => {
  it('states the pose rate and how long an emptied race is kept, from the room’s constants', () => {
    // As a reader sees it: the source's line breaks are not the page's.
    const page = privacyPage().replace(/\s+/g, ' ')
    expect(PRIVACY_POSES_PER_SECOND).toBe(20) // 1 / (4 x 0.0122 s) = 20.49 Hz
    expect(page).toContain('controls about 20 times a second')
    expect(page).toContain('30 seconds after the last player leaves a race')
    expect(page).toContain('A lap from a room is never put on a leaderboard') // DEV-571's word
    expect(page).toContain('Durable Objects')
  })
})

// DEV-633: a PUBLIC room tells the directory; a private one never does.
describe('DEV-633: public rooms', () => {
  it('a private room tells the directory nothing', async () => {
    const { room } = await lobby(2)
    expect(room.listed).toEqual([])
  })

  it('a public room lists its course, phase, players and seats, and nothing about anybody', async () => {
    const { room, conns } = await lobby(1, { ...SETTINGS, listed: true })
    expect(room.listed.at(-1)).toMatchObject({
      mission: SETTINGS.mission,
      phase: 'lobby',
      players: 1,
      seats: SETTINGS.seats,
    })
    expect(Object.keys(room.listed.at(-1) ?? {}).sort()).toEqual(
      ['at', 'mission', 'phase', 'players', 'seats', 'until'].sort(),
    )
    // A second player is a change; the same state again is not re-posted.
    const c = await room.connect('c9')
    await room.send(c, join({ colour: 3 }))
    expect(room.listed.at(-1)?.players).toBe(2)
    const posts = room.listed.length
    await room.send(conns[0] as FakeConn, {
      type: 'ready',
      ready: true,
      rules: SETTINGS.rules.standard,
    })
    expect(room.listed.length, 'a ready changes nothing listed').toBe(posts)
  })

  it('PUBLIC to PRIVATE takes it off the list, and readies nobody down', async () => {
    const { room, conns } = await lobby(2, { ...SETTINGS, listed: true })
    await readyAll(room, conns)
    await room.send(conns[0] as FakeConn, {
      type: 'configure',
      settings: { ...SETTINGS, listed: false },
    })
    expect(room.listed.at(-1)).toBeNull()
    expect(
      Object.values(room.server.players()).every((p) => p.ready),
      'still ready',
    ).toBe(true)
    // A course change still readies everyone down, as before.
    await room.send(conns[0] as FakeConn, {
      type: 'configure',
      settings: { ...SETTINGS, mission: 'int_02_hoverJet' },
    })
    expect(Object.values(room.server.players()).some((p) => p.ready)).toBe(false)
  })

  it('a racing room says so, and an emptied room leaves the list', async () => {
    const { room, conns } = await lobby(2, { ...SETTINGS, listed: true })
    await readyAll(room, conns)
    await room.send(conns[0] as FakeConn, { type: 'start' })
    expect(room.listed.at(-1)?.phase).toBe('racing')
    for (const c of conns) await room.disconnect(c)
    room.now += ROOM_REJOIN_MS + 1
    await room.fireAlarm()
    expect(room.listed.at(-1)).toBeNull()
  })

  it('a `listed` that is not a boolean is not a configure', async () => {
    const { room, conns } = await lobby(1)
    await room.send(conns[0] as FakeConn, {
      type: 'configure',
      settings: { ...SETTINGS, listed: 'yes' },
    })
    expect(room.listed).toEqual([])
  })
})
