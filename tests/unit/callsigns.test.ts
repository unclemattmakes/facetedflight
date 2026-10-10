// DEV-651: the racers' callsigns. A callsign is a function of the RACE, so a TV
// viewer, a room and a replay read the same names; no name stands twice in one
// race; and a painter shows them in capitals.

import { describe, expect, it } from 'vitest'
import {
  CALLSIGNS,
  callsignDisplay,
  callsignSeed,
  drawCallsigns,
  isCallsign,
} from '@/content/callsigns'
import {
  attemptCallsignSeed,
  courseCallsignSeed,
  roomBotCallsigns,
  roomCallsignSeed,
} from '@/game/race-callsigns'
import { racerName, racerStanding } from '@/game/results-state'
import type { RoomRace } from '@/net/room-protocol'
import { tvDrawnName } from '@/render/tv-panel-layout'

// Matt, 2026-10-05, as he wrote them.
const MATTS_THIRTEEN = [
  'stan',
  'peaches',
  'poe',
  'lil bitey',
  'mama pedro',
  'trashleigh',
  'trashica',
  'trashlynn',
  'cutie',
  'g-dub',
  'hashinka',
  'desert rose',
  'the dude',
]

const race = (over: Partial<RoomRace> = {}): RoomRace => ({
  mission: 'int_01_hoverJet',
  edition: 'anniversary',
  starts: { 0: 0, 1: 2 },
  bots: [
    { index: 0, start: 1, colour: 3 },
    { index: 1, start: 3, colour: 4 },
    { index: 2, start: 4, colour: 5 },
  ],
  colours: { 0: 0, 1: 1 },
  ...over,
})

describe('the pool', () => {
  it("is Matt's thirteen names, verbatim", () => {
    expect([...CALLSIGNS]).toEqual(MATTS_THIRTEEN)
  })
})

describe('drawCallsigns', () => {
  it('draws the same names for the same seed, always', () => {
    expect(drawCallsigns(1234, 5)).toEqual(drawCallsigns(1234, 5))
  })

  it('never names two racers alike in one race, whatever the seed', () => {
    for (let seed = 0; seed < 400; seed++) {
      const names = drawCallsigns(seed, 6)
      expect(new Set(names).size).toBe(names.length)
      for (const n of names) expect(CALLSIGNS).toContain(n)
    }
  })

  it('a bigger field extends the smaller one: racer i keeps its name when the field grows', () => {
    // Why host and clients may disagree on the bot COUNT filter and still name racer i alike.
    expect(drawCallsigns(77, 6).slice(0, 3)).toEqual(drawCallsigns(77, 3))
  })

  it('is not one fixed order: different seeds draw different first names', () => {
    const firsts = new Set<string>()
    for (let seed = 0; seed < 200; seed++) firsts.add(drawCallsigns(seed, 1)[0] as string)
    expect(firsts.size).toBeGreaterThan(8)
  })

  it('a field bigger than the pool numbers the second lap of names instead of failing', () => {
    const names = drawCallsigns(5, CALLSIGNS.length + 2)
    expect(new Set(names).size).toBe(names.length)
    expect(names[CALLSIGNS.length]).toMatch(/ 2$/)
    expect(isCallsign(names[CALLSIGNS.length] as string)).toBe(true)
  })

  it('draws nothing for an empty field', () => {
    expect(drawCallsigns(1, 0)).toEqual([])
  })
})

describe('the race seed', () => {
  it('does not run two parts together', () => {
    expect(callsignSeed('a', 'bc')).not.toBe(callsignSeed('ab', 'c'))
  })

  it('names a course the same way every time, and two courses differently', () => {
    expect(courseCallsignSeed('int_01_hoverJet')).toBe(courseCallsignSeed('int_01_hoverJet'))
    expect(courseCallsignSeed('int_01_hoverJet')).not.toBe(courseCallsignSeed('adv_02_hoverJet'))
  })

  it('draws a different field for each attempt at one course (DEV-844)', () => {
    const fields = new Set<string>()
    for (let i = 0; i < 6; i++) {
      fields.add(drawCallsigns(attemptCallsignSeed('int_01_hoverJet'), 5).join(','))
    }
    expect(fields.size).toBeGreaterThan(1)
  })

  it('names a room race the same for its host, its members and a viewer, however the record was built', () => {
    const a = race()
    // The same race with its records assembled in the other order, as a different
    // client's parse might leave them: a JS object's integer keys sort either way,
    // and the bots are an ordered list.
    const b = race({ starts: { 1: 2, 0: 0 }, colours: { 1: 1, 0: 0 } })
    expect(roomCallsignSeed(a)).toBe(roomCallsignSeed(b))
    expect(roomBotCallsigns(a)).toEqual(roomBotCallsigns(b))
  })

  it('names a different race differently (another START freezes another field)', () => {
    expect(roomCallsignSeed(race())).not.toBe(roomCallsignSeed(race({ starts: { 0: 2, 1: 0 } })))
    expect(roomCallsignSeed(race())).not.toBe(
      roomCallsignSeed(race({ mission: 'adv_02_hoverJet' })),
    )
  })

  it("a room's bots get distinct names, one per bot", () => {
    const names = roomBotCallsigns(race())
    expect(names).toHaveLength(3)
    expect(new Set(names).size).toBe(3)
  })
})

describe('how a callsign is shown', () => {
  it('is upper case', () => {
    expect(callsignDisplay('lil bitey')).toBe('LIL BITEY')
    expect(callsignDisplay('g-dub')).toBe('G-DUB')
  })

  it('is what the TV board draws for an AI racer, and a handle still never is', () => {
    const row = (name: string) =>
      ({
        key: `racer:${name}`,
        kind: 'racer',
        racer: null,
        follow: 1,
        name,
        colour: null,
        place: 2,
        status: 'flying',
        seconds: null,
        rings: 0,
      }) as const
    expect(tvDrawnName(row('mama pedro'))).toBe('MAMA PEDRO')
    // The tuning id is the fallback for a racer no race named.
    expect(tvDrawnName(row('cutter'))).toBe('cutter')
    // A name that is neither is not drawn: the rule that no handle reaches a pixel.
    expect(tvDrawnName(row('SwiftFalcon42'))).toBe('Racer 2')
  })
})

describe('what a board calls a racer', () => {
  it('is its callsign, else its tuning id', () => {
    expect(racerName({ id: 'cutter', callsign: 'trashica' })).toBe('trashica')
    expect(racerName({ id: 'cutter', callsign: null })).toBe('cutter')
    expect(racerName({ id: 'cutter' })).toBe('cutter')
  })

  it('is the name the results standings carry', () => {
    const racer = {
      spec: { id: 'wide', callsign: 'poe' },
      finished: true,
      finishedAt: 71.2,
      elapsed: 71.2,
    }
    expect(racerStanding(racer, 0).name).toBe('poe')
  })
})
