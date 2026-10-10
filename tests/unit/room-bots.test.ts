// A room's bots (DEV-391, plan/MULTIPLAYER.md §6.6): the owner flies them and
// reports their finishes; every panel in the room lists them alike, named by
// the tuning each flies and timed by the host's own ticks. The field half
// (avoided, never pushed; single player unmoved) is in `racer-contact.test.ts`;
// the room forwarding bot records only from its owner is in `room-server.test.ts`.

import { describe, expect, it } from 'vitest'
import { roomBotStandings } from '@/game/room-results'
import type { RoomRace } from '@/net/room-protocol'
import { ROOM_PROTOCOL, type RoomSettings } from '@/net/room-protocol'
import { FIXED_DT } from '@/sim/constants'
import { type FakeConn, FakeRoom } from './helpers/fake-room'

const SETTINGS: RoomSettings = {
  mission: 'int_01_hoverJet',
  edition: 'anniversary',
  bots: true,
  seats: 6,
  colours: 7,
  countdown: 4000,
  timeLimit: 180_000,
  rules: { standard: '1.28a93c83' },
}

describe('a room’s bots on the panel (§6.6)', () => {
  const race: RoomRace = {
    mission: 'int_01_hoverJet',
    edition: 'anniversary',
    starts: { 0: 0, 1: 1 },
    bots: [
      { index: 0, start: 2, colour: 2 },
      { index: 1, start: 3, colour: 3 },
    ],
    colours: { 0: 0, 1: 1 },
  }

  it('names each by its tuning, tags it AI, and times it by the host’s ticks', () => {
    const rows = roomBotStandings(race, [{ bot: 1, tick: 7000 }], ['fast', 'steady'], FIXED_DT)
    expect(rows).toEqual([
      { name: 'fast', seconds: null, status: 'flying', ai: true },
      { name: 'steady', seconds: 7000 * FIXED_DT, status: 'finished', ai: true },
    ])
    // No race, no bots.
    expect(roomBotStandings(null, [], [], FIXED_DT)).toEqual([])
  })

  it('hears the host’s finish for a bot through the room, on every page, once', async () => {
    const room = await FakeRoom.open()
    const conns: FakeConn[] = []
    for (let i = 0; i < 2; i++) {
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
      if (i === 0) await room.send(c, { type: 'configure', settings: SETTINGS })
    }
    for (const c of conns) {
      await room.send(c, { type: 'ready', ready: true, rules: SETTINGS.rules.standard })
    }
    const [host, guest] = conns as [FakeConn, FakeConn]
    await room.send(host, { type: 'start' })
    for (const c of conns) await room.send(c, { type: 'loaded' })
    const bots = room.server.race?.bots ?? []
    // Six seats, two people: four bots, in colours neither person holds.
    expect(bots).toHaveLength(4)
    expect(bots.map((b) => b.colour).some((c) => c === 0 || c === 1)).toBe(false)
    await room.send(host, { type: 'finish', tick: 6400, bot: 2 })
    // A second report for the same bot is not a second finish.
    await room.send(host, { type: 'finish', tick: 9999, bot: 2 })
    // And only the host speaks for bots.
    await room.send(guest, { type: 'finish', tick: 1, bot: 0 })
    for (const c of conns) {
      expect(c.last('results')).toMatchObject({ bots: [{ bot: 2, tick: 6400 }] })
    }
    const names = ['fast', 'steady', 'cutter', 'wide']
    const rows = roomBotStandings(room.server.race, [{ bot: 2, tick: 6400 }], names, FIXED_DT)
    expect(rows.map((r) => r.status)).toEqual(['flying', 'flying', 'finished', 'flying'])
    expect(rows[2]?.seconds).toBeCloseTo(6400 * FIXED_DT, 9)
  })
})
