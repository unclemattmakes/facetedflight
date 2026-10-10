// A room's race on the results panel (DEV-390, §6.5): the room's verdicts in
// the panel's own currency, placed by `withStandings` exactly as racers are.

import { describe, expect, it } from 'vitest'
import { placeNow, type RaceLine } from '@/game/race-place'
import { withStandings } from '@/game/results-state'
import {
  type RoomDrawnRacer,
  roomFinishOrder,
  roomLabel,
  roomOpponents,
  roomPassedAt,
  roomPlaceReadings,
  roomRun,
} from '@/game/room-results'
import type { RoomPlayerView, RoomRace, RoomVerdict } from '@/net/room-protocol'
import type { RunSummary } from '@/render/results'
import { FIXED_DT } from '@/sim/constants'
import { createRoute } from '@/sim/route'

const player = (handle: string, variant = 'standard'): RoomPlayerView => ({
  handle,
  variant,
  colour: 0,
  ready: true,
  joinSeq: 0,
  present: true,
})

const ok = (slot: number, ticks: number, over: Partial<RoomVerdict> = {}): RoomVerdict => ({
  slot,
  verdict: 'ok',
  ticks,
  seconds: ticks * FIXED_DT,
  rings: 21,
  ringsTotal: 21,
  score2016: 2100,
  tainted: false,
  variant: 'standard',
  ...over,
})

const RUN = {
  medal: 'gold',
  gates: 21,
  gatesTotal: 21,
  timeSeconds: 80,
  ringScore: 2100,
  timeBonus: 0,
  timeBonusForfeit: 0,
  proximityBonus: 0,
  cleanStreak: 0,
  score: 2100,
  finishedAt: 8000 * FIXED_DT,
  best: null,
  improved: false,
  again: '',
  back: '',
  countLabel: 'RINGS',
  race: '',
} as unknown as RunSummary

const room = (results: RoomVerdict[], extra: Record<number, RoomPlayerView> = {}) => ({
  slot: 0,
  players: {
    0: player('Me'),
    1: player('Swift Kestrel 42'),
    2: player('Steady Heron 17', 'speed'),
    ...extra,
  },
  race: { mission: 'm', edition: 'e', starts: { 0: 0, 1: 1, 2: 2 }, bots: [], colours: {} },
  results,
})

describe('roomOpponents', () => {
  it('lists everyone but me: finished by the JUDGED time, flying until judged', () => {
    const rows = roomOpponents(room([ok(1, 7900)]))
    expect(rows).toEqual([
      { name: 'Swift Kestrel 42', seconds: 7900 * FIXED_DT, status: 'finished' },
      { name: 'Steady Heron 17 · speed', seconds: null, status: 'flying' },
    ])
  })

  it('shows a refused lap with its stage and no time, and a DNF as a DNF', () => {
    const rows = roomOpponents(
      room([
        ok(1, 0, { verdict: 'speed', ticks: null, seconds: null }),
        ok(2, 0, { verdict: 'left', ticks: null, seconds: null, variant: 'speed' }),
      ]),
    )
    expect(rows[0]).toEqual({
      name: 'Swift Kestrel 42 · refused (speed)',
      seconds: null,
      status: 'dnf',
    })
    expect(rows[1]).toEqual({ name: 'Steady Heron 17 · speed', seconds: null, status: 'dnf' })
  })

  it('marks a tainted run assisted (§11 call 6) and a variant beside the name (§11 call 7)', () => {
    expect(roomLabel('Bright Falcon 33', 'acrobat', true)).toBe(
      'Bright Falcon 33 · acrobat · assisted',
    )
    expect(roomLabel('Bright Falcon 33', 'standard', false)).toBe('Bright Falcon 33')
  })
})

describe('placed by withStandings, by ticks', () => {
  it('orders two laps ONE TICK apart correctly', () => {
    const board = withStandings(RUN, roomOpponents(room([ok(1, 7999), ok(2, 8001)])))
    expect(board.standings.map((s) => [s.name, s.place])).toEqual([
      ['Swift Kestrel 42', 1],
      ['you', 2],
      ['Steady Heron 17', 3], // judged in the standard jet: the VERDICT's variant is shown
    ])
  })

  it('shares a place on the same tick: a dead heat (§11 call 5)', () => {
    const board = withStandings(RUN, roomOpponents(room([ok(1, 8000)])))
    const places = board.standings.filter((s) => s.status === 'finished').map((s) => s.place)
    expect(places).toEqual([1, 1])
  })

  it('takes my own refused lap off the board, whatever my live clock said', () => {
    const mine = ok(0, 0, { verdict: 'claimed', ticks: null, seconds: null })
    const board = withStandings(roomRun(RUN, room([mine])), roomOpponents(room([mine])))
    expect(board.standings.find((s) => s.you)?.status).toBe('dnf')
  })

  it('once judged, my own time is the JUDGE’S, so every panel in the room prints one number', () => {
    // The live clock said 8000 ticks; the judge's rescore of the poses says 7990.
    const judged = roomRun(RUN, room([ok(0, 7990)]))
    expect(judged.finishedAt).toBe(7990 * FIXED_DT)
    // Until the verdict lands, the live time stands.
    expect(roomRun(RUN, room([ok(1, 7000)]))).toBe(RUN)
  })
})

// ── In the air: the live place across people ─────────────────────────────

/** `race-place.test.ts`'s folded course: out along x for 1 km, back 20 m over. Gates at 500 and 1520 m. */
const folded = (): RaceLine => {
  const pts: number[][] = []
  for (let x = 0; x <= 1000; x += 25) pts.push([x, 0, 0])
  for (let x = 1000; x >= 0; x -= 25) pts.push([x, 0, 20])
  return { route: createRoute(pts), gateArc: [500, 1520] }
}

const drawnAt = (slot: number, tick: number | null, x: number): RoomDrawnRacer => ({
  slot,
  colour: slot,
  tick,
  position: { x, y: 0, z: 0 },
  drawn: tick !== null,
})

describe('roomPassedAt', () => {
  it('counts a ring only once the DRAWN ship has flown it', () => {
    const out: boolean[] = []
    // Ring 0 heard at tick 1000; the ship is drawn a render delay behind.
    expect(roomPassedAt([1000], 990, 2, out)).toEqual([false, false])
    expect(roomPassedAt([1000], 1000, 2, out)).toEqual([true, false])
    expect(roomPassedAt(undefined, 1000, 2, out)).toEqual([false, false])
    expect(roomPassedAt([1000], null, 2, out)).toEqual([false, false])
  })
})

describe('roomPlaceReadings — the others, in the live place', () => {
  const line = folded()
  const me = { passed: [false, false], position: { x: 490, y: 0, z: 0 } }
  const at = (results: RoomVerdict[], rings: Record<number, number[]>) => ({
    ...room(results),
    ringTicks: rings,
  })

  it('places a player ahead on the line ahead, and one behind behind', () => {
    const others = roomPlaceReadings(at([], {}), [drawnAt(1, 900, 480), drawnAt(2, 900, 495)], line)
    expect(placeNow(line, null, me, [], 180, others)).toEqual({ place: 2, field: 3 })
  })

  it('does not count a ring the drawn ship has not reached yet (the event leads the hull)', () => {
    // Slot 1 took gate 0 at tick 1000 and is DRAWN at tick 990, 20 m short of
    // it: behind me. Counting the ring as heard would put it a gate ahead.
    // (Slot 2 is not drawn yet, so it is at the start: behind as well.)
    const others = roomPlaceReadings(at([], { 1: [1000] }), [drawnAt(1, 990, 480)], line)
    expect(placeNow(line, null, me, [], 180, others)).toEqual({ place: 1, field: 3 })
  })

  it('a judged finisher is ahead; a player not drawn yet is at the start', () => {
    const others = roomPlaceReadings(at([ok(1, 7000)], {}), [drawnAt(2, null, 0)], line)
    expect(others.map((o) => o.standing.status)).toEqual(['finished', 'flying'])
    expect(others[1]?.progress).toEqual({ reached: 0, arc: 0 })
    expect(placeNow(line, null, me, [], 180, others)).toEqual({ place: 2, field: 3 })
  })
})

describe('roomPlaceReadings: the bots a guest draws (DEV-885)', () => {
  const line = folded()
  const me = { passed: [false, false], position: { x: 490, y: 0, z: 0 } }
  const bot = { name: 'Dart', seconds: null, status: 'flying' as const, ai: true }
  const base = { ...room([]), ringTicks: {} }
  const race: RoomRace = { ...base.race, bots: [{ index: 0, start: 3, colour: 1 }] }

  /** A bot seen every 100 m from the start to x, as frames see it. */
  const flownTo = (r: Parameters<typeof roomPlaceReadings>[0], x: number) => {
    let out = roomPlaceReadings(r, [drawnAt(-1, 0, 0)], line, [bot])
    for (let at = 100; at <= x; at += 100) {
      out = roomPlaceReadings(r, [drawnAt(-1, at, at)], line, [bot])
    }
    return out
  }

  it('counts a drawn bot in the field, ahead when it has flown past the gate', () => {
    const others = flownTo({ ...base, race }, 600)
    expect(others.filter((o) => o.standing.ai === true)).toHaveLength(1)
    expect(placeNow(line, null, me, [], 180, others)).toEqual({ place: 2, field: 4 })
  })

  it('a guest and the owner place the same field: the owner reads bots from its own racers, never the draw', () => {
    // The owner draws no bots, so its drawn list has none and nothing is counted twice.
    const others = roomPlaceReadings({ ...base, race }, [], line, [bot])
    expect(others).toHaveLength(2)
  })

  it('a bot never moves back a gate once past it', () => {
    const r = { ...base, race: { ...race } }
    flownTo(r, 600)
    const again = roomPlaceReadings(r, [drawnAt(-1, 910, 400)], line, [bot])
    expect(again.find((o) => o.standing.ai === true)?.progress.reached).toBe(1)
  })
})

describe('roomFinishOrder', () => {
  it('orders the judged laps by ticks, never by when they were judged', () => {
    // Judged (arrived) in the order 2, 0, 1; flown in the order 1, 2, 0.
    expect(roomFinishOrder([ok(2, 8100), ok(0, 8300), ok(1, 7900)])).toEqual([1, 2, 0])
  })
})
