// The headless race, JUDGED (plan/MULTIPLAYER.md §6.5 and §9.1, DEV-390's
// harness gate): four autopilot clients with DIFFERENT tunings fly int_01 from
// the starts the room hands them (DEV-477: the pad, 2016's two, the chevron's
// first, one each) through one real room, each lap is recorded as the game records it
// and judged by the REAL judge (`judgeRoomLap`, over the binding's internal
// API), and the room's result must be the order the laps' TICKS say — whatever
// the links did to the order anything ARRIVED in.
//
// The links are chosen so that arrival disagrees with the race, twice over:
// the winner's socket stalls across its own finish, so its `finish` message
// reaches the room LAST, and its lap reaches the judge last as well (`judgeMs`),
// so its verdict is judged last. A result ordered by either arrival is wrong
// here, and the premise test below proves the sample separates them.
//
// And DEV-477's check, with the judge as its witness: every seat stood on its
// own start (four starts, four people), and the judge — which refuses a lap
// from any start but the seat's own — took every lap.

import { beforeAll, describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import { withStandings } from '@/game/results-state'
import { roomFinishOrder, roomOpponents, roomRun } from '@/game/room-results'
import { LAP_COURSES } from '@/net/lap-courses'
import type { RoomPlayerView } from '@/net/room-protocol'
import type { RunSummary } from '@/render/results'
import { AI_RACER_TUNINGS } from '@/sim/ai-racer'
import type { AutopilotTuning } from '@/sim/autopilot'
import { FIXED_DT } from '@/sim/constants'
import int01 from '../../content/levels/int_01_hoverJet.json'
import { type ClientSpec, type LinkSpec, type RaceResult, runRace } from './helpers/room-harness'

const LEVEL = int01 as unknown as Level
const link = (over: Partial<LinkSpec> = {}): LinkSpec => ({
  baseMs: 60,
  jitterMs: 20,
  loss: 0.02,
  rtoMs: 200,
  ...over,
})
const tuning = (name: string): AutopilotTuning => AI_RACER_TUNINGS[name] as AutopilotTuning

/**
 * Measured on seed 7 from the room's starts (2026-09-27, DEV-477): `fast`, on
 * start 3 (the chevron's first slot, 12 m ahead of the pad), wins in 4,074
 * ticks; the default tuning, on start 2 (2016's right-hand pad), is TWO ticks
 * behind (4,076: 24.4 ms); `cutter` on start 1, 4,590; `steady` on the pad,
 * 9,001 (~118 s after the first join). From the pad alone (DEV-390's run,
 * 2026-09-26) the default won in 4,074 and `fast` was three behind: the
 * forward start Matt accepted is worth about five ticks to it here. So the
 * winner's socket stalls from before its finish (~57.9 s) until after
 * `steady`'s (70 s of nothing sent), and its lap reaches the judge 75 s after
 * it crosses; the others' laps take 2 s. True ms, from the first join. The
 * premise test re-checks all of it.
 *
 * DEV-554 (2026-09-30) lowered 2016's two pad starts 0.959 m, and the default
 * tuning on start 2 then crossed on 4,074, the SAME tick as `fast`: a tie, so
 * the sample no longer separated (the premise test said so). Start 2 now flies
 * `wide`, which finishes on 5,257, between `cutter` and `steady`; `fast` still
 * wins on 4,074 from start 3, and the stall and the judge's delay above are
 * still timed to it.
 */
const WINNER_STALL = [{ at: 55_000, ms: 70_000 }]

const CLIENTS: ClientSpec[] = [
  {
    handle: 'Swift Kestrel 42',
    tuning: tuning('wide'),
    clockOffsetMs: 150,
    loadMs: 800,
    up: link(),
    down: link(),
    judgeMs: 2000,
  },
  {
    handle: 'Steady Heron 17',
    tuning: tuning('fast'),
    clockOffsetMs: -3200,
    loadMs: 1500,
    up: link({ stalls: WINNER_STALL }),
    down: link(),
    judgeMs: 75_000,
  },
  {
    handle: 'Bright Falcon 33',
    tuning: tuning('steady'),
    clockOffsetMs: 40_000,
    loadMs: 2400,
    up: link(),
    down: link(),
    judgeMs: 2000,
  },
  {
    handle: 'Calm Finch 19',
    tuning: tuning('cutter'),
    clockOffsetMs: -7,
    loadMs: 500,
    up: link(),
    down: link(),
    judgeMs: 2000,
  },
]

let race: RaceResult
beforeAll(async () => {
  race = await runRace({ level: LEVEL, clients: CLIENTS, seed: 7, judge: true })
}, 180_000)

/** The client indices by the tick each crossed the line: the race as flown. */
const byTicks = (): number[] =>
  race.clients
    .map((c, i) => ({ i, t: c.finishTick as number }))
    .sort((a, b) => a.t - b.t)
    .map((x) => x.i)
const slotOf = (i: number): number => race.slots[i] as number

describe('the headless race, judged (§6.5)', () => {
  it('judges every lap ok, at the tick the live run crossed', () => {
    expect(race.results).toHaveLength(4)
    for (const [i, c] of race.clients.entries()) {
      const v = race.results.find((r) => r.slot === slotOf(i))
      expect(v?.verdict, CLIENTS[i]?.handle).toBe('ok')
      expect(v?.ticks, CLIENTS[i]?.handle).toBe(c.finishTick)
      expect(v?.seconds).toBeCloseTo((c.finishTick as number) * FIXED_DT, 6)
    }
  })

  it('PREMISE: the sample separates — neither arrival order is the race', () => {
    const flown = byTicks().map(slotOf)
    console.log(
      `results race: ${race.clients.map((c, i) => `${CLIENTS[i]?.handle} start ${c.start} finish ${c.finishTick}`).join(' | ')}`,
    )
    expect(new Set(race.clients.map((c) => c.finishTick)).size).toBe(4)
    expect(race.results.map((r) => r.slot)).not.toEqual(flown) // judged order
    expect(race.finishArrivals).not.toEqual(flown) // `finish` messages' order
    // Specifically: the winner is heard last both ways.
    expect(race.results.at(-1)?.slot).toBe(flown[0])
    expect(race.finishArrivals.at(-1)).toBe(flown[0])
  })

  it('stood every seat on its OWN start: four people, the first four starts, one each (DEV-477)', () => {
    // Matt, 2026-09-27: *"plz verify that our multiplayer players aren't all
    // spawned at the same location."* The room hands the starts; each client
    // stood its jet there (the harness does what `boot/app.ts` does); the
    // judge's own list says where that is; and every lap's first pose is on it.
    const judge = LAP_COURSES.courses[LEVEL.id]?.editions.anniversary?.rooms?.starts ?? []
    const taken = race.clients.map((c) => c.start as number)
    expect([...taken].sort()).toEqual([0, 1, 2, 3])
    for (const [i, c] of race.clients.entries()) {
      const want = judge[taken[i] as number] as readonly number[]
      const first = [c.truth[0], c.truth[1], c.truth[2]] as number[]
      for (let a = 0; a < 3; a++)
        expect(first[a], `${CLIENTS[i]?.handle}`).toBeCloseTo(want[a] as number, 9)
    }
    for (let i = 0; i < race.clients.length; i++) {
      for (let j = i + 1; j < race.clients.length; j++) {
        const a = race.clients[i]?.truth as Float64Array
        const b = race.clients[j]?.truth as Float64Array
        expect(
          Math.hypot((a[0] as number) - (b[0] as number), (a[2] as number) - (b[2] as number)),
          `${CLIENTS[i]?.handle} to ${CLIENTS[j]?.handle}`,
        ).toBeGreaterThan(10)
      }
    }
  })

  it('places them in the order their TICKS say, whatever arrived first', () => {
    expect(roomFinishOrder(race.results)).toEqual(byTicks().map(slotOf))
  })

  it('shows every player the same board: one place per player, from every seat', () => {
    const players: Record<number, RoomPlayerView> = {}
    for (const [i, s] of race.slots.entries()) {
      players[s] = {
        handle: CLIENTS[i]?.handle as string,
        variant: 'standard',
        colour: i,
        ready: true,
        joinSeq: i,
        present: true,
      }
    }
    const starts: Record<number, number> = {}
    for (const [i, s] of race.slots.entries()) starts[s] = race.clients[i]?.start as number
    const roomRace = { mission: LEVEL.id, edition: 'anniversary', starts, bots: [], colours: {} }
    const want = new Map(byTicks().map((i, place) => [CLIENTS[i]?.handle as string, place + 1]))
    for (const [i, c] of race.clients.entries()) {
      const seat = {
        slot: slotOf(i),
        players,
        race: roomRace,
        results: race.results,
      }
      // Each client's own run, with its LIVE clock: `roomRun` replaces it with the judge's.
      const run = { finishedAt: (c.finishTick as number) * FIXED_DT + 0.5 } as RunSummary
      const board = withStandings(roomRun(run, seat), roomOpponents(seat))
      const places = new Map(
        board.standings.map((s) => [s.you ? (CLIENTS[i]?.handle as string) : s.name, s.place]),
      )
      expect(places, CLIENTS[i]?.handle).toEqual(want)
    }
  })
})
