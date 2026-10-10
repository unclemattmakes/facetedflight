// tests/unit/room-starts.test.ts — one person per start-point, on every course
// a room can race, at every size a room can be. DEV-477.
//
// Matt, 2026-09-27: *"plz verify that our multiplayer players aren't all
// spawned at the same location. 1 player per start-point (players instead of
// the ai racers)"* — and of three options, the racers' own starts.
//
// The chain, end to end, with every link the real one:
//
//   the ROOM   `RoomServer` (through `FakeRoom`) hands each person a start
//              index and each bot one (`RoomRace.starts`, `RoomBot.start`);
//   the GAME   stands every ship on `roomStarts(level, racers)[index]` — the
//              list `boot/app.ts` places its own ship and draws the others from;
//   the JUDGE  accepts a seat's lap from `roomSeatStart(LAP_COURSES, seat)`
//              and no other start (`room-lap.test.ts` holds that half), off the
//              GENERATED list in `content/lap-courses.json`.
//
// Swept, not sampled: all six Ring Attack courses (every course the judge has,
// which is every course a room offers: `boot/app.ts`'s `roomCourseCards`), every
// head count from one to the course's cap, bots on and off.
//
// Red against DEV-389's room: people stood on a row of their own (13 m abreast
// of the pad, on no start of this list), and the bots took the racers' starts
// from index 0 of a list that did not hold the pad — so "every ship on a
// distinct start of the course's list" fails on the first person off the pad.

import { describe, expect, it } from 'vitest'
import type { Edition } from '@/content/edition-schema'
import { type RacerStart, roomStarts } from '@/game/racer-grid'
import { roomPalette } from '@/game/remote-ships'
import { LAP_COURSES } from '@/net/lap-courses'
import { roomSeatStart } from '@/net/room-lap'
import {
  CLOSE,
  ROOM_MAX_SEATS,
  ROOM_PROTOCOL,
  type RoomRace,
  type RoomSettings,
} from '@/net/room-protocol'
import anniversaryJson from '../../content/editions/anniversary.json'
import { levelJson as levelOf } from './helpers/content'
import { type FakeConn, FakeRoom } from './helpers/fake-room'

const ANNIV = anniversaryJson as unknown as Edition
const RACERS = ANNIV.gameplay.racers
const COURSES = Object.keys(LAP_COURSES.courses)

/** The owner's settings for a course, as `boot/app.ts`'s `roomSettingsFor` makes them. */
const settingsFor = (mission: string, seats: number, bots: boolean): RoomSettings => ({
  mission,
  edition: 'anniversary',
  bots,
  seats,
  colours: roomPalette(ANNIV.render.racerLivery).length,
  countdown: 4000,
  timeLimit: 180_000,
  rules: { standard: '1.28a93c83' },
})

/** A room of `people`, configured for `settings`, everyone ready, START pressed. */
const started = async (people: number, settings: RoomSettings) => {
  const room = await FakeRoom.open()
  const conns: FakeConn[] = []
  for (let i = 0; i < people; i++) {
    const c = await room.connect(`c${i}`)
    await room.send(c, {
      type: 'join',
      protocol: ROOM_PROTOCOL,
      handle: `Swift Kestrel ${10 + i}`,
      variant: 'standard',
      colour: i,
      content: 'ab12cd34ef56ab12',
    })
    conns.push(c)
    if (i === 0) await room.send(c, { type: 'configure', settings })
  }
  for (const c of conns) {
    await room.send(c, { type: 'ready', ready: true, rules: settings.rules.standard })
  }
  await room.send(conns[0] as FakeConn, { type: 'start' })
  return { room, conns }
}

/** Every ship the race stands on the course, person or bot, with the start it took. */
const shipsOf = (race: RoomRace): { who: string; start: number }[] => [
  ...Object.entries(race.starts).map(([slot, start]) => ({ who: `person ${slot}`, start })),
  ...race.bots.map((b) => ({ who: `bot ${b.index}`, start: b.start })),
]

describe('one person per start-point (DEV-477)', () => {
  it('sizes every room course by its starts, and every start fits the room', () => {
    // The owner configures `seats` as the list's length, so the cap is the
    // list; the room refuses a palette smaller than the seats (`parseSettings`)
    // and a seat count past its abuse ceiling, so both must hold on content.
    expect(COURSES).toHaveLength(6)
    const palette = roomPalette(ANNIV.render.racerLivery).length
    for (const mission of COURSES) {
      const list = roomStarts(levelOf(mission), RACERS)
      expect(list, mission).toHaveLength(6)
      expect(list.length, `${mission}: one colour a ship`).toBeLessThanOrEqual(palette)
      expect(list.length, mission).toBeLessThanOrEqual(ROOM_MAX_SEATS)
      // And the judge's copy is the same list, entry for entry.
      expect(
        LAP_COURSES.courses[mission]?.editions.anniversary?.rooms?.starts,
        mission,
      ).toHaveLength(list.length)
    }
  })

  it('stands every ship on a DISTINCT start of the course, at every size, bots on and off', async () => {
    let rooms = 0
    let ships = 0
    for (const mission of COURSES) {
      const level = levelOf(mission)
      const list: RacerStart[] = roomStarts(level, RACERS)
      for (const bots of [true, false]) {
        for (let people = 1; people <= list.length; people++) {
          const { room, conns } = await started(people, settingsFor(mission, list.length, bots))
          const race = room.server.race as RoomRace
          const where = `${mission}, ${people} people, bots ${bots ? 'on' : 'off'}`
          expect(race, where).not.toBeNull()
          // The people: every one of them, on the FIRST `people` starts, one each.
          const slots = conns.map((c) => (c.last('hello') as { slot: number }).slot)
          expect(Object.keys(race.starts).map(Number).sort(), where).toEqual([...slots].sort())
          expect(
            Object.values(race.starts).sort((a, b) => a - b),
            where,
          ).toEqual([...Array(people).keys()])
          // The bots: the rest, in order, or none.
          expect(
            race.bots.map((b) => b.start),
            where,
          ).toEqual(bots ? [...Array(list.length - people).keys()].map((k) => people + k) : [])
          // Every ship on its own start of THIS course's list, and no two in one place.
          const taken = shipsOf(race)
          expect(new Set(taken.map((s) => s.start)).size, where).toBe(taken.length)
          for (const s of taken) {
            expect(list[s.start], `${where}: ${s.who}`).toBeDefined()
          }
          for (let i = 0; i < taken.length; i++) {
            for (let j = i + 1; j < taken.length; j++) {
              const a = list[(taken[i] as { start: number }).start] as RacerStart
              const b = list[(taken[j] as { start: number }).start] as RacerStart
              expect(
                Math.hypot(a.pos[0] - b.pos[0], a.pos[2] - b.pos[2]),
                `${where}: ${taken[i]?.who} and ${taken[j]?.who}`,
              ).toBeGreaterThan(10)
            }
          }
          ships += taken.length
          rooms++
        }
      }
    }
    expect(rooms, 'six courses x six sizes x bots on and off').toBe(72)
    // Bots on fills every start (6 x 6 x 6); bots off stands 1 + ... + 6 people.
    expect(ships).toBe(6 * 6 * 6 + 6 * 21)
  }, 60_000)

  it('tells the judge exactly the start the game stands each person on', async () => {
    // Two routes to one place, per seat: the GAME's (`roomStarts`, THREE space,
    // mirrored here) and the JUDGE's (the room's `seatInfo` for that seat's
    // token, through `roomSeatStart`, off the generated artefact).
    let checked = 0
    for (const mission of COURSES) {
      const list = roomStarts(levelOf(mission), RACERS)
      const { room, conns } = await started(list.length, settingsFor(mission, list.length, true))
      for (const c of conns) await room.send(c, { type: 'loaded' })
      for (const c of conns) {
        const hello = c.last('hello') as { slot: number; seat: string }
        const seat = room.server.seatInfo(hello.seat)
        expect(seat, mission).not.toBeNull()
        const index = room.server.race?.starts[hello.slot] as number
        expect(seat?.start, mission).toBe(index)
        const judge = roomSeatStart(LAP_COURSES, seat as NonNullable<typeof seat>)
        const game = (list[index] as RacerStart).pos
        expect(judge, `${mission} start ${index}`).toEqual([game[0], game[1], -game[2]])
        checked++
      }
    }
    expect(checked, 'six people on each of six courses').toBe(36)
  }, 60_000)

  it('cannot hold more people than the course has starts', async () => {
    // The seventh join is closed "room full" (4000) at the door...
    const mission = COURSES[0] as string
    const cap = roomStarts(levelOf(mission), RACERS).length
    const late = await FakeRoom.open()
    const conns: FakeConn[] = []
    for (let i = 0; i <= cap; i++) {
      const c = await late.connect(`c${i}`)
      await late.send(c, {
        type: 'join',
        protocol: ROOM_PROTOCOL,
        handle: `Swift Kestrel ${10 + i}`,
        variant: 'standard',
        colour: i % cap,
        content: 'ab12cd34ef56ab12',
      })
      conns.push(c)
      if (i === 0)
        await late.send(c, { type: 'configure', settings: settingsFor(mission, cap, true) })
    }
    expect(late.closes()[`c${cap}`]).toBe(CLOSE.full)
    // ...and a full room cannot be moved to a course with fewer starts: the
    // room refuses the owner's settings and keeps the ones it had.
    const owner = conns[0] as FakeConn
    await late.send(owner, { type: 'configure', settings: settingsFor(mission, cap - 1, true) })
    expect(owner.last('error')).toMatchObject({ code: 'seats' })
    expect(late.server.settings?.seats).toBe(cap)
  })
})
