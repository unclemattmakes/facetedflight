// tests/unit/tv-live-feed.test.ts: a room's race as TV's panel reads it. DEV-480.
//
// Three claims, each one a thing the panel would draw wrong without a browser
// noticing: a live row never carries a name (only Racer N); places are time,
// then rings taken by the drawn tick, then the ones out; and the race is over
// on the room's own rule, though the session's phase still says racing.

import { describe, expect, it } from 'vitest'
import type { RoomDrawnRacer } from '@/game/room-results'
import { type TvLiveSession, tvLiveFeed, tvLiveOver } from '@/game/tv/tv-live-feed'
import type { RoomPlayerView, RoomRace, RoomVerdict } from '@/net/room-protocol'

const player = (handle: string, colour: number): RoomPlayerView => ({
  handle,
  variant: 'standard',
  colour,
  ready: true,
  joinSeq: colour,
  present: true,
})
const race = {
  mission: 'int_01_hoverJet',
  starts: { 0: 0, 1: 1, 2: 2 },
  colours: { 0: 0, 1: 1, 2: 2 },
} as unknown as RoomRace
const verdict = (slot: number, over: Partial<RoomVerdict> = {}): RoomVerdict =>
  ({
    slot,
    verdict: 'ok',
    ticks: 4000,
    seconds: 48.8,
    rings: 21,
    ringsTotal: 21,
    score2016: null,
    tainted: false,
    variant: 'standard',
    ...over,
  }) as RoomVerdict
const drawn = (slot: number, tick: number | null): RoomDrawnRacer => ({
  slot,
  colour: slot,
  tick,
  position: { x: 0, y: 0, z: 0 },
  drawn: tick !== null,
})
const session = (over: Partial<TvLiveSession> = {}): TvLiveSession => ({
  roomPhase: 'racing',
  players: {
    0: player('Swift Kestrel 42', 0),
    1: player('Steady Heron 17', 1),
    2: player('Bright Falcon 33', 2),
  },
  race,
  results: [],
  // Slot 0 has taken three rings by tick 300, slot 1 one, slot 2 two (one at tick 900).
  ringTicks: { 0: [100, 200, 300], 1: [150], 2: [120, 900] },
  ...over,
})
const ctx = {
  course: 'Simonet Islands · Ring Attack',
  gates: 21,
  colourOf: (i: number) => `c${i}`,
  racers: 3,
  report: null,
  linkFollows: 2,
  lobbies: 1,
}

describe('a live race on the panel', () => {
  it('names nobody: every row is Racer N, keyed by its seat', () => {
    const f = tvLiveFeed(session(), [drawn(0, 400), drawn(1, 400), drawn(2, 400)], ctx)
    expect(f.show).toBe('live')
    for (const r of f.rows) {
      expect(r.kind).toBe('live')
      expect(r.name).toBe('')
      expect(r.key).toBe(`slot:${(r.racer as number) - 1}`)
    }
    expect(JSON.stringify(f)).not.toMatch(/Kestrel|Heron|Falcon/)
    expect(f.linkFollows).toBe(2)
    expect(f.lobbies).toBe(1)
  })

  it('places by rings taken at the DRAWN tick, then the finishers by time first', () => {
    // At tick 400 slot 2's second ring (tick 900) is not flown yet: 3, 1, 1 rings.
    const flying = tvLiveFeed(session(), [drawn(0, 400), drawn(1, 400), drawn(2, 400)], ctx)
    expect(flying.rows.map((r) => [r.racer, r.rings])).toEqual([
      [1, 3],
      [2, 1],
      [3, 1],
    ])
    const one = session({ results: [verdict(1, { seconds: 50.1 })] })
    const f = tvLiveFeed(one, [drawn(0, 1000), drawn(1, 1000), drawn(2, 1000)], ctx)
    expect(f.rows.map((r) => r.racer)).toEqual([2, 1, 3])
    expect(f.rows[0]?.status).toBe('finished')
    expect(f.rows.map((r) => r.colour)).toEqual(['c1', 'c0', 'c2'])
  })

  it('puts the ones out last, and is over when every racer has a verdict, whatever the phase says', () => {
    const results = [
      verdict(2),
      verdict(0, { verdict: 'dnf', seconds: null, rings: 5 }),
      verdict(1),
    ]
    const s = session({ results, roomPhase: 'racing' })
    expect(tvLiveOver(s)).toBe(true)
    const f = tvLiveFeed(s, [drawn(0, 9000), drawn(1, 9000), drawn(2, 9000)], ctx)
    expect(f.phase).toBe('results')
    expect(f.rows.at(-1)?.racer).toBe(1)
    expect(f.rows.at(-1)?.status).toBe('dnf')
    expect(tvLiveOver(session({ results: [verdict(0)] }))).toBe(false)
  })

  it('is the ident before GO, and follows the camera’s racer', () => {
    const before = tvLiveFeed(session({ roomPhase: 'countdown' }), [], ctx)
    expect(before.phase).toBe('ident')
    expect(before.raceSeconds).toBe(0)
    const f = tvLiveFeed(session(), [drawn(1, 820)], {
      ...ctx,
      report: { following: 'Racer 2', racer: 2 },
    })
    expect(f.followed).toBe('slot:1')
    expect(f.raceSeconds).toBeGreaterThan(9.9)
  })
})
