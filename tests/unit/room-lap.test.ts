// A room lap, judged (plan/MULTIPLAYER.md §6.5, DEV-390): the lap Function's
// handler over the binding's internal API into the real `RoomServer`, with a
// real autopilot lap of int_01 and forgeries of it. The link is the one the
// Function uses (`roomLinkOverFetch`) answered the way the Durable Object
// answers it (`answerRoomLink`), joined with real Requests and Responses.

import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Edition } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import { type AutopilotLap, flyAutopilotLap } from '@/game/autopilot-lap'
import { roomStarts } from '@/game/racer-grid'
import { fetchRoomGhost, lapToWire, submitRoomLap } from '@/net/lap-client'
import { LAP_COURSES, lapCourse, lapRules, lapVehicle } from '@/net/lap-courses'
import { fetchRoomLap, judgeRoomLap, ROOM_LAP_STAGE, roomSeatStart } from '@/net/room-lap'
import { answerRoomLink, roomLinkOverFetch } from '@/net/room-link'
import {
  ROOM_PROTOCOL,
  type RoomSeat,
  type RoomSettings,
  type RoomVerdict,
} from '@/net/room-protocol'
import type { LapDoc } from '@/sim/ghost'
import { createLapRecorder, type LapRecorder, recordedLap } from '@/sim/ghost-record'
import anniversaryJson from '../../content/editions/anniversary.json'
import int01 from '../../content/levels/int_01_hoverJet.json'
import { type FakeConn, FakeRoom } from './helpers/fake-room'

const LEVEL = int01 as unknown as Level
const MISSION = 'int_01_hoverJet'
const WORLD_OFFSET = (lapCourse(MISSION) as NonNullable<ReturnType<typeof lapCourse>>).worldOffset
const STANDARD = lapRules(MISSION, 'anniversary', 'standard') as string
const SPEED = lapRules(MISSION, 'anniversary', 'speed') as string

const SETTINGS: RoomSettings = {
  mission: MISSION,
  edition: 'anniversary',
  bots: false,
  seats: 6,
  colours: 6,
  countdown: 4000,
  timeLimit: 180_000,
  rules: { standard: STANDARD, speed: SPEED },
}

let flown: AutopilotLap | null = null
const lap = (): AutopilotLap => {
  flown ??= flyAutopilotLap(LEVEL, WORLD_OFFSET)
  return flown
}

const docOf = (rec: LapRecorder, edition = 'anniversary', variant = 'standard'): LapDoc =>
  recordedLap(rec, {
    mission: MISSION,
    mode: 'ringAttack',
    edition,
    rules: lapRules(MISSION, edition, variant) as string,
    vehicle: lapVehicle('hoverjet', variant),
    build: 'unit-test',
  })

/** The honest lap, played at double speed: every other pose, one tick apart. */
const doubled = (): LapRecorder => {
  const src = lap().rec
  const n = Math.floor(src.count / 2)
  const rec = createLapRecorder(WORLD_OFFSET, n)
  for (let i = 0; i < n; i++) {
    rec.ticks[i] = i
    rec.poses.set(src.poses.subarray(2 * i * 7, 2 * i * 7 + 7), i * 7)
  }
  rec.count = n
  return rec
}

/**
 * A room with two players, released, and the seat tokens — and `pad`, the
 * index of the one the room stood on start 0, the player's pad, where `lap()`
 * was flown from. DEV-477: the judge accepts a seat's lap from ITS start and
 * no other, so the pad lap is honest only for that seat; `other` is the seat
 * the room put on start 1.
 */
const raced = async () => {
  const room = await FakeRoom.open()
  const conns: FakeConn[] = []
  for (let i = 0; i < 2; i++) {
    const c = await room.connect(`c${i}`)
    await room.send(c, {
      type: 'join',
      protocol: ROOM_PROTOCOL,
      handle: 'Swift Kestrel 42',
      variant: 'standard',
      colour: i,
      content: 'ab12cd34ef56ab12',
    })
    conns.push(c)
    if (i === 0) await room.send(c, { type: 'configure', settings: SETTINGS })
  }
  for (const c of conns) await room.send(c, { type: 'ready', ready: true, rules: STANDARD })
  await room.send(conns[0] as FakeConn, { type: 'start' })
  for (const c of conns) await room.send(c, { type: 'loaded' })
  const seats = conns.map((c) => (c.last('hello') as { seat: string }).seat)
  const link = roomLinkOverFetch((req) => answerRoomLink(room.server, req))
  const starts = room.server.race?.starts ?? {}
  const pad = conns.findIndex((c) => starts[(c.last('hello') as { slot: number }).slot] === 0)
  if (pad < 0) throw new Error('nobody on the pad')
  return { room, conns, seats, link, pad, other: 1 - pad }
}

const post = (body: unknown) =>
  new Request('https://site/api/room/abcdefghij234567/lap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('judgeRoomLap (§6.5)', () => {
  it('judges an honest lap and hands the room its ticks, not the claim', async () => {
    const { room, seats, link, pad } = await raced()
    const doc = docOf(lap().rec)
    const res = await judgeRoomLap(
      post({ lap: await lapToWire(doc), seconds: lap().finishAt, seat: seats[pad], tainted: true }),
      link,
    )
    expect(res.status).toBe(200)
    const { verdict } = (await res.json()) as { verdict: RoomVerdict }
    expect(verdict).toMatchObject({
      slot: pad,
      verdict: 'ok',
      ticks: lap().finishTick,
      rings: 21,
      tainted: true,
      variant: 'standard',
    })
    expect(room.server.results).toEqual([verdict])
    // And the lap is kept, to race (§6.5's "race this lap").
    const got = await fetchRoomLap(new Request(`https://site/api/room/x/lap?slot=${pad}`), link)
    expect(((await got.json()) as { lap: string }).lap).toBe(await lapToWire(doc))
  }, 60_000)

  it('lists a lap claiming a faster time with its refusal and NO time', async () => {
    const { room, seats, link } = await raced()
    const res = await judgeRoomLap(
      post({
        lap: await lapToWire(docOf(lap().rec)),
        seconds: lap().finishAt - 10,
        seat: seats[0],
      }),
      link,
    )
    const { verdict } = (await res.json()) as { verdict: RoomVerdict }
    expect(verdict).toMatchObject({ slot: 0, verdict: 'claimed', ticks: null, seconds: null })
    expect(room.server.results[0]?.seconds).toBeNull()
  }, 60_000)

  it('refuses a forged lap — the honest one at double speed — and places it nowhere', async () => {
    const { room, seats, link } = await raced()
    const fast = doubled()
    const res = await judgeRoomLap(
      post({ lap: await lapToWire(docOf(fast)), seconds: lap().finishAt / 2, seat: seats[0] }),
      link,
    )
    const { verdict } = (await res.json()) as { verdict: RoomVerdict }
    expect(verdict.verdict).not.toBe('ok')
    expect(verdict.seconds).toBeNull()
    expect(room.server.results[0]?.ticks).toBeNull()
  }, 60_000)

  it("refuses a valid lap of OTHER rules at the room's own stage", async () => {
    const { seats, link, pad } = await raced()
    // A speed-jet lap from a seat that readied in the standard jet.
    const res = await judgeRoomLap(
      post({
        lap: await lapToWire(docOf(lap().rec, 'anniversary', 'speed')),
        seconds: lap().finishAt,
        seat: seats[pad],
      }),
      link,
    )
    const { verdict } = (await res.json()) as { verdict: RoomVerdict }
    expect(verdict.verdict).toBe(ROOM_LAP_STAGE)
  }, 60_000)

  it('takes the first verdict for a seat only, and no unknown seat at all', async () => {
    const { seats, link } = await raced()
    const wire = await lapToWire(docOf(lap().rec))
    const body = { lap: wire, seconds: lap().finishAt, seat: seats[0] }
    expect((await judgeRoomLap(post(body), link)).status).toBe(200)
    expect((await judgeRoomLap(post(body), link)).status).toBe(403) // judged: no longer a live seat
    expect((await judgeRoomLap(post({ ...body, seat: 'x'.repeat(22) }), link)).status).toBe(403)
    expect((await judgeRoomLap(post({ ...body, lap: 42 }), link)).status).toBe(400)
    expect((await judgeRoomLap(post(body), null)).status).toBe(503)
  }, 60_000)

  it('is what the GAME posts: submitRoomLap to the judge, and fetchRoomGhost back to race', async () => {
    const { room, seats, link, pad, other } = await raced()
    // The game's own client, its fetch answered by the Function's handlers.
    const site = async (input: string, init?: RequestInit): Promise<Response> => {
      const req = new Request(`https://site${input}`, init)
      return req.method === 'POST' ? judgeRoomLap(req, link) : fetchRoomLap(req, link)
    }
    const doc = docOf(lap().rec)
    const posted = await submitRoomLap(
      {
        room: 'abcdefghij234567',
        doc,
        seconds: lap().finishAt,
        seat: seats[pad] as string,
        tainted: false,
      },
      site,
    )
    expect(posted).toEqual({ ok: true, verdict: 'ok' })
    expect(room.server.results[0]).toMatchObject({ slot: pad, ticks: lap().finishTick })
    const back = await fetchRoomGhost('abcdefghij234567', pad, site)
    expect(back.ok && back.doc.mission).toBe(MISSION)
    expect(back.ok && back.doc.keyCount).toBe(doc.keyCount)
    // A seat with no judged lap has nothing to race, in the server's words.
    const none = await fetchRoomGhost('abcdefghij234567', other, site)
    expect(none).toMatchObject({ ok: false, status: 404, error: 'none' })
  }, 60_000)

  it('refuses a seat before the race is released: no verdict from the lobby', async () => {
    const room = await FakeRoom.open()
    const c = await room.connect('c0')
    await room.send(c, {
      type: 'join',
      protocol: ROOM_PROTOCOL,
      handle: 'Swift Kestrel 42',
      variant: 'standard',
      colour: 0,
      content: 'ab12cd34ef56ab12',
    })
    const seat = (c.last('hello') as { seat: string }).seat
    const link = roomLinkOverFetch((req) => answerRoomLink(room.server, req))
    expect(await link.seat(seat)).toBeNull()
  })
})

// ── DEV-477: every seat on its own start, and the judge holds it there ──────
//
// Matt, 2026-09-27: *"plz verify that our multiplayer players aren't all
// spawned at the same location. 1 player per start-point (players instead of
// the ai racers)"*. The judge is the check a PLAYER cannot get past: a room's
// lap is refused unless its first pose is on that seat's own start.
describe("a seat's own start (DEV-477, §6.3)", () => {
  const ANNIV_RACERS = (anniversaryJson as unknown as Edition).gameplay.racers
  const levelOf = (id: string) =>
    JSON.parse(fs.readFileSync(`content/levels/${id}.json`, 'utf8')) as Level
  const seatOn = (mission: string, start?: number): RoomSeat => ({
    slot: 0,
    mission,
    edition: 'anniversary',
    variant: 'standard',
    rules: '',
    ...(start === undefined ? {} : { start }),
  })

  it('puts each seat where the GAME stands it: every entry of every judged course', () => {
    // Two routes to one place: the judge's, off the generated courses artefact,
    // and the game's, off the level and the preset (`roomStarts`, THREE space,
    // mirrored here by hand).
    let checked = 0
    for (const mission of Object.keys(LAP_COURSES.courses)) {
      const game = roomStarts(levelOf(mission), ANNIV_RACERS)
      expect(game, mission).toHaveLength(6)
      game.forEach((s, k) => {
        const judge = roomSeatStart(LAP_COURSES, seatOn(mission, k)) as readonly number[]
        const sim = [s.pos[0], s.pos[1], -s.pos[2]]
        for (let a = 0; a < 3; a++)
          expect(judge[a], `${mission} ${k}`).toBeCloseTo(sim[a] as number, 9)
        checked++
      })
      // Past the list, and a seat the room gave no start: nothing.
      expect(roomSeatStart(LAP_COURSES, seatOn(mission, game.length))).toBeNull()
    }
    expect(checked).toBe(6 * 6)
    expect(roomSeatStart(LAP_COURSES, seatOn(MISSION))).toBeNull()
  })

  /** A lap flown from the start the room gave seat `i` of `raced()`. */
  const flownFrom = (room: FakeRoom, conn: FakeConn): AutopilotLap => {
    const slot = (conn.last('hello') as { slot: number }).slot
    const index = room.server.race?.starts[slot] as number
    return flyAutopilotLap(
      LEVEL,
      WORLD_OFFSET,
      undefined,
      roomStarts(LEVEL, ANNIV_RACERS)[index]?.pos,
    )
  }

  it("judges a lap flown from the seat's own start, and refuses it for the seat on the pad", async () => {
    const { room, conns, seats, link, pad, other } = await raced()
    // One lap, flown from the OTHER seat's start (one of 2016's pads on int_01,
    // 16 m off the player's shoulder and 1.1 to 1.7 m over the release).
    const flown = flownFrom(room, conns[other] as FakeConn)
    const wire = await lapToWire(docOf(flown.rec))
    // Posted for the seat on the pad, it is a lap from somebody else's start.
    const wrong = await judgeRoomLap(
      post({ lap: wire, seconds: flown.finishAt, seat: seats[pad] }),
      link,
    )
    expect(((await wrong.json()) as { verdict: RoomVerdict }).verdict.verdict).toBe('start')
    // Posted for the seat whose start it is, it is judged at its own ticks.
    const right = await judgeRoomLap(
      post({ lap: wire, seconds: flown.finishAt, seat: seats[other] }),
      link,
    )
    expect(((await right.json()) as { verdict: RoomVerdict }).verdict).toMatchObject({
      slot: other,
      verdict: 'ok',
      ticks: flown.finishTick,
    })
  }, 120_000)

  it('refuses the PAD to a seat whose start is not the pad: nobody starts from somebody else’s start', async () => {
    // Red before DEV-477, whose judge kept the release legal for every seat
    // beside its own start: a person could fly from the pad whatever the room
    // said, which is the one start everybody would share.
    const { seats, link, other } = await raced()
    const res = await judgeRoomLap(
      post({ lap: await lapToWire(docOf(lap().rec)), seconds: lap().finishAt, seat: seats[other] }),
      link,
    )
    const { verdict } = (await res.json()) as { verdict: RoomVerdict }
    expect(verdict).toMatchObject({ slot: other, verdict: 'start', ticks: null })
  }, 60_000)
})
