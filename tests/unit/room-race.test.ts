// The headless race (plan/MULTIPLAYER.md §9.1, DEV-387's gate): four autopilot
// clients on int_01 through ONE real room and four real `RoomSession`s, each
// behind a TCP-shaped link of 60 ms ± 20 ms with 2 % retransmits, one of them
// stalled for 300 ms mid-race, their clocks offset by up to 40 s and drifting.
// Deterministic, no GPU, in `pnpm test`.
//
// What it pins, measured 2026-09-26 on seed 1 (the numbers in the comments are
// that run's, from DEV-389's human row; since DEV-477 the clients start on the
// racers' own starts, and the bounds, which carry margin, still hold):
//
//   drawn vs truth at the SAME shared tick   p50 0.001 m · p99 0.037 m · max 6.48 m
//     (the max is the stall: 250 ms of extrapolation, then a hold)
//   drawn vs the sender's LIVE pose (§5.1)   p50 60 m · p95 109 m · max 154 m
//   king-tide's arrival-time interpolator,   p95 17.7 m · max 97 m
//     at the constant lag that suits it best (220 ms), on the same stream
//   straight lerp instead of Hermite         p95 0.045 m against 0.006 m
//
// §5.1 estimated 16–50 m of lag at 159 m/s. These boosted, chained autopilot
// laps average far faster (the fastest here finishes in ~50 s), and the delay
// that buys a p99 of 4 cm is ~170 ms: the lag is speed x delay, as §5.1 said.

import { beforeAll, describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import { POSE_SEND_TICKS } from '@/net/room-protocol'
import { AI_RACER_TUNINGS } from '@/sim/ai-racer'
import { type AutopilotTuning, DEFAULT_AUTOPILOT } from '@/sim/autopilot'
import { FIXED_DT } from '@/sim/constants'
import int01 from '../../content/levels/int_01_hoverJet.json'
import {
  type ClientSpec,
  type LinkSpec,
  percentile,
  type RaceResult,
  runRace,
} from './helpers/room-harness'

const LEVEL = int01 as unknown as Level
const link = (over: Partial<LinkSpec> = {}): LinkSpec => ({
  baseMs: 60,
  jitterMs: 20,
  loss: 0.02,
  rtoMs: 200,
  ...over,
})
/** 300 ms with nothing delivered either way, ~32 s into the race. */
const STALL = [{ at: 40_000, ms: 300 }]
const tuning = (name: string): AutopilotTuning => AI_RACER_TUNINGS[name] as AutopilotTuning

const CLIENTS: ClientSpec[] = [
  {
    handle: 'Swift Kestrel 42',
    tuning: DEFAULT_AUTOPILOT,
    clockOffsetMs: 150,
    driftPpm: 20,
    loadMs: 800,
    up: link(),
    down: link(),
  },
  {
    handle: 'Calm Heron 17',
    tuning: tuning('fast'),
    clockOffsetMs: -3200,
    driftPpm: -15,
    loadMs: 1500,
    up: link({ stalls: STALL }),
    down: link({ stalls: STALL }),
  },
  {
    handle: 'Bright Hawk 13',
    tuning: tuning('steady'),
    clockOffsetMs: 40_000,
    loadMs: 2400,
    up: link(),
    down: link(),
  },
  {
    handle: 'Calm Finch 19',
    tuning: tuning('cutter'),
    clockOffsetMs: -7,
    loadMs: 500,
    up: link(),
    down: link(),
  },
]

/** The bounds. See the header for what each was measured at. */
const BOUND = {
  /** Drawn vs truth at the same shared tick, p99, m. */
  errorP99: 0.1,
  /** The worst: the stall's extrapolation cap, m. */
  errorMax: 10,
  /** §5.1's figure, p95, m. Speed x delay; pinned loosely, it moves with the racers' tunings. */
  lagP95: 150,
}

let race: RaceResult
let lerp: RaceResult
beforeAll(async () => {
  race = await runRace({ level: LEVEL, clients: CLIENTS, seed: 1 })
  // The same race, straight lerp: only as long as it takes to separate them.
  lerp = await runRace({
    level: LEVEL,
    clients: CLIENTS,
    seed: 1,
    raceSeconds: 40,
    session: { track: { lerp: true } },
  })
}, 120_000)

describe('the headless race (§9.1)', () => {
  it('is a real race: four different laps, every ring, all finished', () => {
    const finishes = race.clients.map((c) => c.finishTick)
    expect(finishes.every((f) => f !== null && f > 1000)).toBe(true)
    expect(new Set(finishes).size).toBe(4)
    expect(race.clients.map((c) => c.rings)).toEqual([21, 21, 21, 21])
  })

  it('stands every client on its own start, one each, and releases it there (DEV-477)', () => {
    // Matt, 2026-09-27: *"plz verify that our multiplayer players aren't all
    // spawned at the same location. 1 player per start-point (players instead
    // of the ai racers)"*. Four people take the course's first four starts —
    // the pad, 2016's two, the chevron's first — in the room's shuffle, and
    // each lap's tick 0 is on its own. Red against DEV-389's room, which stood
    // people on a row of its own, on no start of this list.
    const taken = race.clients.map((c) => c.start as number)
    expect([...taken].sort()).toEqual([0, 1, 2, 3])
    for (const [i, c] of race.clients.entries()) {
      const want = race.starts[taken[i] as number] as readonly number[]
      for (let a = 0; a < 3; a++)
        expect(c.truth[a], CLIENTS[i]?.handle).toBeCloseTo(want[a] as number, 9)
    }
    const firsts = race.clients.map((c) => [c.truth[0], c.truth[2]] as number[])
    for (let i = 0; i < firsts.length; i++) {
      for (let j = i + 1; j < firsts.length; j++) {
        const a = firsts[i] as number[]
        const b = firsts[j] as number[]
        expect(
          Math.hypot((a[0] as number) - (b[0] as number), (a[1] as number) - (b[1] as number)),
        ).toBeGreaterThan(10)
      }
    }
  })

  it('releases everyone within a few ms of one GO, whatever their clocks said', () => {
    const releases = race.clients.map((c) => c.releaseAt)
    // Offsets of −3.2 s to +40 s, drift ±20 ppm: the room clock takes them all out.
    expect(Math.max(...releases) - Math.min(...releases)).toBeLessThanOrEqual(10)
    for (const c of race.clients) expect(Math.abs(c.clockError)).toBeLessThan(5)
  })

  it('draws every other racer within the pinned distance of the truth at the same shared tick', () => {
    const errors = race.scored.map((s) => s.error)
    expect(errors.length).toBeGreaterThan(20_000)
    expect(percentile(errors, 0.99)).toBeLessThan(BOUND.errorP99)
    expect(Math.max(...errors)).toBeLessThan(BOUND.errorMax)
  })

  it('extrapolated through the stall, and only there, and never held', () => {
    const extrap = race.scored.filter((s) => s.mode === 'extrap')
    expect(extrap.length).toBeGreaterThan(0)
    expect(race.scored.filter((s) => s.mode === 'hold' || s.mode === 'early')).toEqual([])
    // Every sample past its extrapolation is an observer of the stalled client, or
    // is the stalled client drawing the others, or is a retransmit's HOL burst:
    // none lies more than the cap in error.
    for (const s of extrap) expect(s.error).toBeLessThan(BOUND.errorMax)
  })

  it('lags the live ship by speed x delay: the figure §5.1 estimated', () => {
    const lags = race.scored.map((s) => s.lag)
    expect(percentile(lags, 0.95)).toBeLessThan(BOUND.lagP95)
    expect(percentile(lags, 0.5)).toBeGreaterThan(10) // a delay exists; the ship is drawn in the past
  })

  it("is WORSE under king-tide's arrival-time interpolator, even at its best lag", () => {
    // Same stream, same frames. Keyed by arrival, a retransmit's burst collapses
    // the span and the ship snaps; keyed by the sender's tick, it lands on time.
    expect(race.arrival.p95).toBeGreaterThan(BOUND.errorP99 * 20)
    expect(race.arrival.max).toBeGreaterThan(BOUND.errorMax)
  })

  it('keeps Hermite: straight lerp is measurably worse, by more than §6.4’s centimetre', () => {
    const cut = 40_000 // true ms: before the stall, inside both runs
    const ours = race.scored.filter((s) => s.trueMs <= cut).map((s) => s.error)
    const lerps = lerp.scored.filter((s) => s.trueMs <= cut).map((s) => s.error)
    expect(percentile(lerps, 0.95) - percentile(ours, 0.95)).toBeGreaterThan(0.01)
  })

  it('is deterministic: the lerp run flew exactly the same race', () => {
    // The interpolator only draws; the four flights must not move.
    for (const [i, c] of lerp.clients.entries()) {
      const a = race.clients[i]?.truth as Float64Array
      const n = Math.min(3 * 3000, c.truth.length)
      expect(c.truth.subarray(0, n)).toEqual(a.subarray(0, n))
    }
  })

  it('costs one pose message every POSE_SEND_TICKS ticks, and little else', () => {
    const poses = race.clients.reduce(
      (n, c) => n + Math.floor((c.finishTick as number) / POSE_SEND_TICKS) + 1,
      0,
    )
    // The rest: joins, ready, configure, start, loaded, clock-sync pings (bursts
    // and 1 Hz while racing, itself 1/20.49 = 4.9 %), rings. Measured 11.4 %.
    expect(race.messagesToRoom).toBeGreaterThan(poses)
    expect(race.messagesToRoom).toBeLessThan(poses * 1.15)
    // 20.49 Hz a player, the §6.2 budget's rate.
    expect(1 / (POSE_SEND_TICKS * FIXED_DT)).toBeCloseTo(20.49, 2)
  })
})
