// A room races a PLAYER'S course (DEV-851, docs/plan/ROOM-PLAYER-COURSES.md).
//
// The room carries the course's link token; the owner, every client and the
// judge build its lap entry with the same code (`net/room-course.ts`). These
// tests hold the three things that keeps true, then race one: a real autopilot
// lap of a player course, through the real `RoomServer`, judged by the real
// lap Function's handler with the course rebuilt from the token.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Edition } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import { generatedLevelIds, loadLevel } from '@/content/load-level'
import { type PlayerCourse, playerCourseId } from '@/content/player-course'
import { courseToken } from '@/content/player-course-wire'
import { flyAutopilotLap } from '@/game/autopilot-lap'
import { roomStarts } from '@/game/racer-grid'
import { ROOM_DONOR_IDS, roomDonor } from '@/net/course-donors'
import { lapToWire } from '@/net/lap-client'
import { LAP_COURSES, lapVehicle } from '@/net/lap-courses'
import {
  playerCourseLevel,
  playerLapCourse,
  playerRoomRules,
  ROOM_COURSE_AIRCRAFT,
  ROOM_COURSE_EDITIONS,
  roomCourseFromToken,
} from '@/net/room-course'
import { judgeRoomLap } from '@/net/room-lap'
import { answerRoomLink, roomLinkOverFetch } from '@/net/room-link'
import {
  CLOSE,
  parseClientMessage,
  ROOM_PROTOCOL,
  ROOM_TEXT_MAX,
  type RoomSettings,
  type RoomVerdict,
} from '@/net/room-protocol'
import { recordedLap } from '@/sim/ghost-record'
import { fittedCourse } from './helpers/editor-course'
import { type FakeConn, FakeRoom } from './helpers/fake-room'
import { REPO } from './helpers/repo-root'

const SKY = 'int_01_hoverJet'

let made: { course: PlayerCourse; level: Level; token: string } | null = null
const player = async () => {
  if (!made) {
    const donor = await loadLevel(SKY)
    const course = fittedCourse(donor)
    made = { course, level: playerCourseLevel(course, donor), token: await courseToken(course) }
  }
  return made
}

describe('the judge builds a player course from the same parts as the game', () => {
  it('its donors are every shipped HoverJet mission, each the level loadLevel gives', async () => {
    const hoverjet: string[] = []
    for (const id of generatedLevelIds()) {
      const level = await loadLevel(id)
      if (level.vehicle === 'hoverjet') {
        hoverjet.push(id)
        expect(roomDonor(id), id).toEqual(level)
      }
    }
    expect([...ROOM_DONOR_IDS]).toEqual(hoverjet.sort())
    expect(roomDonor('nonsense')).toBeNull()
  })

  it('its editions are every edition file, and its aircraft the HoverJet', () => {
    const files = fs
      .readdirSync(path.join(REPO, 'content', 'editions'))
      .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort()
    expect(ROOM_COURSE_EDITIONS.map((e) => e.id).sort()).toEqual(files)
    expect(ROOM_COURSE_AIRCRAFT.map((a) => a.vehicle)).toEqual(['hoverjet'])
  })

  it('a SHIPPED course through it is exactly its entry in lap-courses.json', async () => {
    const entry = playerLapCourse(await loadLevel(SKY))
    expect(entry).toEqual(LAP_COURSES.courses[SKY])
  })

  it('a token builds the course it names, and no other', async () => {
    const { course, level, token } = await player()
    const id = playerCourseId(course)
    expect(level.id).toBe(id)
    const built = await roomCourseFromToken(token, id, roomDonor)
    expect(built.ok && built.course).toEqual(playerLapCourse(level))
    expect((await roomCourseFromToken(token, 'pc_000000000000', roomDonor)).ok).toBe(false)
    expect((await roomCourseFromToken('ffc1.AAAA', id, roomDonor)).ok).toBe(false)
    expect((await roomCourseFromToken(token, id, () => null)).ok).toBe(false)
  })
})

describe('the wire carries a player course (protocol 10)', () => {
  const base = {
    edition: 'anniversary',
    bots: false,
    seats: 6,
    colours: 6,
    countdown: 4000,
    timeLimit: 180_000,
    rules: { standard: '1.abc' },
  }
  const configure = (settings: object) => JSON.stringify({ type: 'configure', settings })

  it('a pc_ mission needs its token, and only a pc_ mission takes one', async () => {
    const { token } = await player()
    const pc = 'pc_0123456789ab'
    const ok = parseClientMessage(configure({ ...base, mission: pc, course: token }))
    expect(ok?.type === 'configure' && ok.settings.course).toBe(token)
    expect(parseClientMessage(configure({ ...base, mission: pc }))).toBeNull()
    expect(parseClientMessage(configure({ ...base, mission: SKY, course: token }))).toBeNull()
    expect(
      parseClientMessage(configure({ ...base, mission: pc, course: 'not a token' })),
    ).toBeNull()
    const plain = parseClientMessage(configure({ ...base, mission: SKY }))
    expect(plain?.type === 'configure' && 'course' in plain.settings).toBe(false)
  })

  it('only a configure may run past ROOM_TEXT_MAX', async () => {
    const room = await FakeRoom.open()
    const owner = await room.connect('a')
    await room.send(owner, {
      type: 'join',
      protocol: ROOM_PROTOCOL,
      handle: 'Bold Falcon 42',
      variant: 'standard',
      colour: 0,
      content: 'ab12cd34ef56ab12',
    })
    const long = `ffc1.${'A'.repeat(ROOM_TEXT_MAX + 100)}`
    await room.send(owner, {
      type: 'configure',
      settings: { ...base, mission: 'pc_0123456789ab', course: long },
    })
    expect(owner.closed).toBeNull()
    expect(room.server.settings?.course).toBe(long)
    const other = await room.connect('b')
    await room.send(other, { type: 'ping', t0: 1, pad: 'x'.repeat(ROOM_TEXT_MAX + 10) })
    expect(other.closed?.code).toBe(CLOSE.abuse)
  })
})

describe('a race on a player course, judged (DEV-851)', () => {
  it('an honest autopilot lap is judged ok; the same lap claimed on a shipped course is not this race', async () => {
    const { course, level, token } = await player()
    const id = playerCourseId(course)
    const rules = playerRoomRules(level, 'anniversary')
    if (!rules?.standard) throw new Error('no rules for the player course')
    const entry = playerLapCourse(level)
    if (!entry) throw new Error('not a judged course')
    const settings: RoomSettings = {
      mission: id,
      edition: 'anniversary',
      bots: false,
      seats: roomStarts(level, (ROOM_COURSE_EDITIONS[0] as Edition).gameplay.racers).length,
      colours: 6,
      countdown: 4000,
      timeLimit: level.timer.timeLimit * 1000,
      rules,
      course: token,
    }
    const room = await FakeRoom.open()
    const conns: FakeConn[] = []
    const handles = ['Bold Falcon 42', 'Azure Condor 17']
    for (let i = 0; i < 2; i++) {
      const c = await room.connect(`c${i}`)
      await room.send(c, {
        type: 'join',
        protocol: ROOM_PROTOCOL,
        handle: handles[i],
        variant: 'standard',
        colour: i,
        content: 'ab12cd34ef56ab12',
      })
      conns.push(c)
      if (i === 0) await room.send(c, { type: 'configure', settings })
    }
    for (const c of conns) await room.send(c, { type: 'ready', ready: true, rules: rules.standard })
    await room.send(conns[0] as FakeConn, { type: 'start' })
    for (const c of conns) await room.send(c, { type: 'loaded' })
    const starts = room.server.race?.starts ?? {}
    const pad = conns.findIndex((c) => starts[(c.last('hello') as { slot: number }).slot] === 0)
    expect(pad).toBeGreaterThanOrEqual(0)
    const seat = ((conns[pad] as FakeConn).last('hello') as { seat: string }).seat
    const link = roomLinkOverFetch((req) => answerRoomLink(room.server, req))

    const flown = flyAutopilotLap(level, entry.worldOffset)
    const doc = recordedLap(flown.rec, {
      mission: id,
      mode: 'ringAttack',
      edition: 'anniversary',
      rules: rules.standard,
      vehicle: lapVehicle('hoverjet', 'standard'),
      build: 'unit-test',
    })
    const res = await judgeRoomLap(
      new Request('https://site/api/room/abcdefghij234567/lap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lap: await lapToWire(doc), seconds: flown.finishAt, seat }),
      }),
      link,
    )
    expect(res.status).toBe(200)
    const { verdict } = (await res.json()) as { verdict: RoomVerdict }
    expect(verdict.verdict).toBe('ok')
    expect(verdict.ticks).toBe(flown.finishTick)
    expect(verdict.rings).toBe(entry.gates.length)
  })
})
