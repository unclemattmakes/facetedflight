// One player's side of a room (DEV-387): the transport-agnostic client the
// game's socket and the harness's link both drive. What the race cannot show
// one at a time: the send cadence, the ping schedule the Free plan's budget
// depends on (§6.2: never 1 Hz in a lobby), and the clock's switch to slewing.

import { describe, expect, it } from 'vitest'
import { PoseWriter, poseRecord } from '@/net/pose-codec'
import { ROOM_CLOCK_BURST } from '@/net/room-clock'
import { POSE_SEND_TICKS, ROOM_PROTOCOL, type ServerMessage } from '@/net/room-protocol'
import { ROOM_BURST_SPACING_MS, ROOM_RACING_PING_MS, RoomSession } from '@/net/room-session'

const session = () => {
  const sent: Array<string | Uint8Array> = []
  const s = new RoomSession(
    { send: (d) => sent.push(typeof d === 'string' ? d : new Uint8Array(d)) },
    { handle: 'Swift Kestrel 42', variant: 'standard', colour: 0, content: 'ab12cd34ef56ab12' },
  )
  const pings = () => sent.filter((m) => typeof m === 'string' && m.includes('"ping"')).length
  const hear = (msg: ServerMessage, local: number) => s.receive(JSON.stringify(msg), local)
  return { s, sent, pings, hear }
}

const race = {
  mission: 'int_01_hoverJet',
  edition: 'anniversary',
  starts: { 0: 0 },
  bots: [],
  colours: { 0: 0 },
}
const hello = (goAt: number | null = null): ServerMessage => ({
  type: 'hello',
  protocol: ROOM_PROTOCOL,
  slot: 0,
  joinSeq: 0,
  seat: 'AAAAAAAAAAAAAAAAAAAAAA',
  owner: 0,
  phase: 'lobby',
  settings: null,
  players: {},
  race: null,
  goAt,
  goAts: {},
  results: [],
  bots: [],
})

describe('RoomSession', () => {
  it('joins with the protocol, its handle, variant, colour and content', () => {
    const { s, sent } = session()
    s.join()
    expect(JSON.parse(sent[0] as string)).toEqual({
      type: 'join',
      protocol: ROOM_PROTOCOL,
      handle: 'Swift Kestrel 42',
      variant: 'standard',
      colour: 0,
      content: 'ab12cd34ef56ab12',
    })
  })

  // DEV-441b. Red against a session that drops the flag: a typed code's join
  // is then a link's, and a typo is seated alone in a new room of that name.
  it('asks for an EXISTING room when its identity says so (a typed code), and only then', () => {
    const sent: string[] = []
    const typed = new RoomSession(
      { send: (d) => sent.push(d as string) },
      {
        handle: 'Swift Kestrel 42',
        variant: 'standard',
        colour: 0,
        content: 'ab12cd34ef56ab12',
        existing: true,
      },
    )
    typed.join()
    expect(JSON.parse(sent[0] as string).existing).toBe(true)
    const { s, sent: linked } = session()
    s.join()
    expect('existing' in JSON.parse(linked[0] as string)).toBe(false)
  })

  // DEV-459. Red against a session that drops them: the page could never be
  // kept out, and the owner's row would press nothing.
  it('joins with its page token, and sends the owner’s kick', () => {
    const sent: string[] = []
    const s = new RoomSession(
      { send: (d) => sent.push(d as string) },
      {
        handle: 'Swift Kestrel 42',
        variant: 'standard',
        colour: 0,
        content: 'ab12cd34ef56ab12',
        page: 'pageAAAAAAAAAAAAAAAAAA',
      },
    )
    s.join()
    expect(JSON.parse(sent[0] as string).page).toBe('pageAAAAAAAAAAAAAAAAAA')
    s.kick(3)
    expect(JSON.parse(sent[1] as string)).toEqual({ type: 'kick', slot: 3 })
  })

  it('sends a pose every POSE_SEND_TICKS fixed ticks, and only then', () => {
    const { s, sent } = session()
    const r = [poseRecord()]
    let n = 0
    for (let tick = 0; tick < 400; tick++) if (s.step(tick, r, 1)) n++
    expect(n).toBe(400 / POSE_SEND_TICKS)
    expect(sent.every((m) => m instanceof Uint8Array)).toBe(true)
  })

  it('pings a burst at hello, NOTHING in the lobby after it, a burst at start, then 1 Hz', () => {
    const { s, pings, hear } = session()
    let local = 0
    hear(hello(), local)
    for (; local < 2000; local++) s.update(local)
    expect(pings()).toBe(ROOM_CLOCK_BURST)
    // A minute in the lobby: not one ping (an idle room must stay asleep, §6.2).
    for (; local < 62_000; local++) s.update(local)
    expect(pings()).toBe(ROOM_CLOCK_BURST)
    hear({ type: 'start', goAt: 70_000, field: 70_000, goAts: {}, race }, local)
    for (let end = local + ROOM_CLOCK_BURST * ROOM_BURST_SPACING_MS; local < end; local++)
      s.update(local)
    expect(pings()).toBe(2 * ROOM_CLOCK_BURST)
    const before = pings()
    for (let end = local + 10 * ROOM_RACING_PING_MS; local < end; local++) s.update(local)
    expect(pings() - before).toBe(10)
  })

  it('draws nobody from its own poses', () => {
    const { s, hear } = session()
    hear(hello(1000), 0)
    const own = new Uint8Array(new PoseWriter().encode(40, [poseRecord()], 1)) // slot byte 0 = ours
    s.receive(own, 1500)
    expect(s.track(0)).toBeUndefined()
    const theirs = new Uint8Array(own)
    theirs[1] = 3
    s.receive(theirs, 1500)
    expect(s.track(3)?.size).toBe(1)
  })

  it('steps its clock until its own GO, then slews: nothing drawn may jump', () => {
    const { s, hear } = session()
    hear(hello(), 0)
    hear({ type: 'pong', t0: 0, room: 5000, t1: 0 } as unknown as ServerMessage, 100)
    expect(s.clock.smooth).toBe(false)
    hear({ type: 'start', goAt: 9000, field: 9000, goAts: {}, race }, 200)
    s.roomNow(3000) // room ~7950: before GO
    expect(s.clock.smooth).toBe(false)
    s.roomNow(4200) // room ~9150: past GO
    expect(s.clock.smooth).toBe(true)
  })

  it("places a late racer's ticks on its own GO", () => {
    const { s, hear } = session()
    hear(hello(), 0)
    hear({ type: 'start', goAt: 9000, field: 9000, goAts: {}, race }, 10)
    hear({ type: 'late', slot: 2, goAt: 14_000 }, 20)
    expect(s.goAtOf(1)).toBe(9000)
    expect(s.goAtOf(2)).toBe(14_000)
  })

  it("keeps the others' rings by tick, first take only, and drops them when a new race loads (DEV-390)", () => {
    const { s, hear } = session()
    hear(hello(), 0)
    hear({ type: 'loading', race, loaded: [], deadline: 30_000 }, 5)
    hear({ type: 'ring', slot: 1, gate: 0, tick: 400 }, 10)
    hear({ type: 'ring', slot: 1, gate: 2, tick: 900 }, 11)
    // A second take of gate 0 (it flew back through) is not when it was taken.
    hear({ type: 'ring', slot: 1, gate: 0, tick: 950 }, 12)
    expect(s.ringTicks[1]?.[0]).toBe(400)
    expect(s.ringTicks[1]?.[2]).toBe(900)
    expect(s.ringTicks[1]?.[1]).toBeUndefined()
    const verdict = {
      slot: 1,
      verdict: 'ok',
      ticks: 7000,
      seconds: 85.4,
      rings: 21,
      ringsTotal: 21,
      score2016: 2100,
      tainted: false,
      variant: 'standard',
    }
    hear({ type: 'results', results: [verdict], bots: [{ bot: 0, tick: 7100 }] }, 13)
    expect(s.results).toHaveLength(1)
    expect(s.bots).toEqual([{ bot: 0, tick: 7100 }])
    // Still loading: a second `loading` (another racer loaded) is the same race.
    hear({ type: 'loading', race, loaded: [1], deadline: 30_000 }, 14)
    expect(s.ringTicks[1]?.[0]).toBe(400)
    // DEV-389: who is on the grid already, for the pad's WAITING FOR PLAYERS.
    expect(s.loadedSlots).toEqual([1])
    // Back in the lobby and loading again: a new race, nothing carried over.
    hear({ ...hello(), phase: 'lobby' } as ServerMessage, 20)
    expect(s.ringTicks).toEqual({})
    expect(s.results).toEqual([])
    expect(s.loadedSlots).toEqual([])
  })

  it('hears the race end (`again`, DEV-389): own GO gone, panel state kept until the next race', () => {
    const { s, pings, hear } = session()
    hear(hello(), 0)
    hear({ type: 'loading', race, loaded: [0], deadline: 30_000 }, 5)
    hear({ type: 'start', goAt: 9000, field: 9000, goAts: { 1: 12_000 }, race }, 10)
    s.roomNow(9500)
    expect(s.clock.smooth).toBe(true)
    const verdict = {
      slot: 0,
      verdict: 'ok',
      ticks: 7000,
      seconds: 85.4,
      rings: 21,
      ringsTotal: 21,
      score2016: 2100,
      tainted: false,
      variant: 'standard',
    }
    hear({ type: 'results', results: [verdict], bots: [] }, 20)
    expect(s.settled).toBe(true)
    // The join and start bursts, spent (the racing 1 Hz runs on under them).
    for (let local = 20; local < 1000; local++) s.update(local)
    const lobbyMsg = { type: 'lobby', owner: 0, settings: null, players: {}, phase: 'lobby' }
    hear(lobbyMsg as ServerMessage, 1000)
    expect(s.roomPhase).toBe('lobby')
    expect(s.goAt).toBeNull()
    expect(s.clock.smooth).toBe(false)
    // The panel still up reads the race it was reading.
    expect(s.race).toEqual(race)
    expect(s.results).toHaveLength(1)
    // The lobby's schedule: no 1 Hz ping once the GO is gone (§6.2).
    const before = pings()
    for (let local = 1000; local < 5000; local++) s.update(local)
    expect(pings()).toBe(before)
    // The next race's loading starts clean: no GO carried from the last one,
    // so the others stand on their row starts until THEIR GO (remote-ships.ts).
    hear({ type: 'loading', race, loaded: [], deadline: 60_000 }, 6000)
    expect(s.field).toBeNull()
    expect(s.goAts).toEqual({})
    expect(s.goAtOf(1)).toBeNull()
    expect(s.results).toEqual([])
    expect(s.settled).toBe(false)
  })

  it('sends again, forfeit, and a ready carrying colour and variant', () => {
    const { s, sent } = session()
    s.ready(false, undefined, 3, 'speed')
    s.again()
    s.forfeit()
    expect(sent.map((m) => JSON.parse(m as string))).toEqual([
      { type: 'ready', ready: false, colour: 3, variant: 'speed' },
      { type: 'again' },
      { type: 'forfeit' },
    ])
  })
})
