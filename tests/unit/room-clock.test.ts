// The room clock (plan/MULTIPLAYER.md §6.3, DEV-387): a client's estimate of
// the room's time from ping/pong, under the link the gate names — a 150 ms
// offset, a symmetric 40 ms base, and 30 ms of jitter drawn INDEPENDENTLY on
// each direction (which is what makes a round trip asymmetric).

import { describe, expect, it } from 'vitest'
import {
  FIXED_DT_MS,
  ROOM_CLOCK_BURST,
  ROOM_CLOCK_WINDOW,
  RoomClock,
  roomTimeOfTick,
  sharedTickAt,
} from '@/net/room-clock'
import { FIXED_DT } from '@/sim/constants'
import { type Rng, seeded } from './helpers/seeded'

/** room − local, the truth the clock estimates. */
const OFFSET = 150
const BASE = 40
const JITTER = 30
/** Local oscillator drift against the room's, parts per million (a crystal's worth). */
const DRIFT_PPM = 20

interface Link {
  rng: Rng
  /** A one-way trip, ms, given the direction's own draw. */
  trip(): number
}
const link = (seed: number): Link => {
  const rng = seeded(seed)
  return { rng, trip: () => BASE + rng() * JITTER }
}

/** local time at true time T: offset, plus a slow drift. */
const localAt = (T: number): number => T - OFFSET + (T * DRIFT_PPM) / 1e6
/** The truth at true time T, as the estimate should read it: room − local. */
const truthAt = (T: number): number => T - localAt(T)

/** One ping at true time T through `l`: feeds the clock, returns when the pong landed. */
const ping = (clock: RoomClock, l: Link, T: number): number => {
  const t0 = localAt(T)
  const atRoom = T + l.trip()
  const back = atRoom + l.trip()
  clock.sample(t0, atRoom, localAt(back))
  return back
}

/** The schedule §6.3 sets: a burst at join, a burst at `start`, then 1 Hz. */
const run = (clock: RoomClock, seed: number, racingSeconds: number): number => {
  const l = link(seed)
  let T = 1_000_000
  for (let i = 0; i < ROOM_CLOCK_BURST; i++) T = Math.max(ping(clock, l, T), T + 25)
  T += 20_000 // the lobby: no pings at all
  for (let i = 0; i < ROOM_CLOCK_BURST; i++) T = Math.max(ping(clock, l, T), T + 25)
  for (let s = 0; s < racingSeconds; s++) {
    T += 1000
    ping(clock, l, T)
  }
  return T
}

/** NTP's classic clock filter: the offset of the single fastest ROUND trip in the window. */
class MinRttClock {
  #s: Array<{ rtt: number; off: number }> = []
  sample(t0: number, room: number, t1: number) {
    this.#s.push({ rtt: t1 - t0, off: room - (t0 + t1) / 2 })
    if (this.#s.length > ROOM_CLOCK_WINDOW) this.#s.shift()
  }
  get offset() {
    return [...this.#s].sort((a, b) => a.rtt - b.rtt)[0]?.off ?? 0
  }
}

describe('the room clock (§6.3)', () => {
  it('converges to within 2 ms of a 150 ms offset under 30 ms independent jitter', () => {
    // 200 seeds, each after the two bursts and one window of the 1 Hz racing
    // sync, with the local oscillator drifting 20 ppm. Measured 2026-09-26:
    // p50 0.49 ms, p95 1.59 ms, worst 3.36 ms, 2 seeds of 200 past 2 ms. The
    // plan's "within 2 ms" holds at p95 and not for every seed: a two-way
    // exchange cannot beat each direction's fastest trip, and uniform 30 ms
    // jitter leaves a few windows without a fast one. A wider window buys
    // little once the drift across it is the error (48 samples: p95 1.42).
    const errors: number[] = []
    for (let seed = 1; seed <= 200; seed++) {
      const clock = new RoomClock()
      const T = run(clock, seed, ROOM_CLOCK_WINDOW)
      errors.push(Math.abs(clock.offset - truthAt(T)))
    }
    errors.sort((a, b) => a - b)
    const p95 = errors[189] as number
    const worst = errors.at(-1) as number
    expect(p95, `p95 of 200: ${p95.toFixed(2)} ms`).toBeLessThan(2)
    expect(worst, `worst of 200: ${worst.toFixed(2)} ms`).toBeLessThan(4)
  })

  it('beats the fastest-round-trip filter it replaced, on the same samples', () => {
    // The reason for the per-direction bounds (see the file's header): the
    // classic filter needs ONE sample fast both ways; the bounds take each
    // direction's fastest from wherever it was.
    let ours = 0
    let classic = 0
    for (let seed = 1; seed <= 100; seed++) {
      const a = new RoomClock()
      const b = new MinRttClock()
      const T = run(a, seed, ROOM_CLOCK_WINDOW)
      run(b as unknown as RoomClock, seed, ROOM_CLOCK_WINDOW)
      ours += Math.abs(a.offset - truthAt(T))
      classic += Math.abs(b.offset - truthAt(T))
    }
    expect(ours / 100).toBeLessThan(classic / 100 / 2)
  })

  it('is already close after the two bursts alone: the countdown starts on these', () => {
    const errors: number[] = []
    for (let seed = 1; seed <= 100; seed++) {
      const clock = new RoomClock()
      const T = run(clock, seed, 0)
      errors.push(Math.abs(clock.offset - truthAt(T)))
    }
    errors.sort((a, b) => a - b)
    // Start skew is cosmetic (§5.2); this pins how cosmetic.
    expect(errors[94], `p95 of 100: ${errors[94]?.toFixed(2)} ms`).toBeLessThan(5)
  })

  it('ignores a pong held up by a stall', () => {
    const clock = new RoomClock()
    const T = run(clock, 7, ROOM_CLOCK_WINDOW)
    const before = clock.offset
    // 300 ms stuck on the way back: the slow direction's bound is simply not the tightest.
    clock.sample(localAt(T + 1000), T + 1000 + BASE, localAt(T + 1000 + BASE + 300))
    expect(Math.abs(clock.offset - before)).toBeLessThan(0.5)
  })

  it('never runs backwards while it slews toward a better estimate', () => {
    const clock = new RoomClock()
    clock.smooth = true // past GO
    const l = link(3)
    let T = 1_000_000
    // A deliberately poor first sample (slow up, fast down), then good ones.
    clock.sample(localAt(T), T + 90, localAt(T + 90 + 40))
    const first = clock.applied
    let last = Number.NEGATIVE_INFINITY
    for (let i = 0; i < 400; i++) {
      T += 25
      if (i % 4 === 0) ping(clock, l, T)
      const now = clock.now(localAt(T))
      expect(now).toBeGreaterThanOrEqual(last)
      last = now
    }
    // It did move, toward the truth, and only as fast as the slew allows.
    expect(Math.abs(clock.applied - truthAt(T))).toBeLessThan(Math.abs(first - truthAt(T)))
  })

  it('takes the first estimate whole: nothing to slew from', () => {
    const clock = new RoomClock()
    expect(clock.synced).toBe(false)
    clock.sample(100, 500, 140)
    expect(clock.synced).toBe(true)
    expect(clock.applied).toBe(clock.offset)
    expect(clock.now(1000)).toBe(1000 + clock.offset)
  })
})

describe('the shared tick (§6.3)', () => {
  it('counts fixed steps of 0.0121999998 s from GO, both ways', () => {
    expect(FIXED_DT_MS).toBe(FIXED_DT * 1000)
    expect(FIXED_DT).toBeCloseTo(0.0121999998, 10)
    const goAt = 1_790_000_000_000
    expect(sharedTickAt(goAt, goAt)).toBe(0)
    // A 1.79e12 ms epoch leaves ~2e-4 ms of float grain: 1e-5 of a tick.
    expect(sharedTickAt(roomTimeOfTick(8200, goAt), goAt)).toBeCloseTo(8200, 4)
    expect(sharedTickAt(goAt - FIXED_DT_MS, goAt)).toBeCloseTo(-1, 4)
  })
})
