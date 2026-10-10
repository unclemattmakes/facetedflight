// src/net/room-clock.ts — one clock for a room: the client's estimate of the room's time. DEV-387.
//
// Every `ping { t0 }` is answered `pong { t0, room }`, `room` the Durable
// Object's `Date.now()` (plan/MULTIPLAYER.md §6.3). `roomNow() = local +
// offset` is then the one clock every network timing in a room reads: the
// countdown's start, the shared tick, a remote ship's render time.
//
// ── The estimate: each direction's fastest trip, not the fastest round trip ──
//
// A sample bounds the offset θ (room − local) from both sides. With `t0` the
// local send, `t1` the local receive and `room` stamped in between:
//
//     room − t1  <=  θ  <=  room − t0          (both one-way delays are >= 0)
//
// and with a symmetric base latency b and each direction's own jitter,
// `room − t1 = θ − b − jitterDown` and `room − t0 = θ + b + jitterUp`. So the
// TIGHTEST lower bound over a window is `θ − b − min(jitterDown)` and the
// tightest upper bound `θ + b + min(jitterUp)`, and their midpoint misses θ by
// `(min jitterUp − min jitterDown) / 2`: each direction's fastest trip, taken
// from whichever samples had them. NTP's classic filter keeps the single
// fastest ROUND trip instead, which needs one sample fast BOTH ways and so
// converges far slower under independent jitter (`room-clock.test.ts` has
// the two side by side).
//
// What no two-way exchange can see is a FIXED asymmetry — a path slower up
// than down by a constant. It lands in θ as half the difference, and shows
// up as start skew: cosmetic by construction, because a result is a time
// from each player's own release (§5.2).
//
// ── Applying it: stepped until GO, slewed after ───────────────────────────
//
// Until `smooth` is set, the applied offset IS the estimate: every better
// sample is taken at once, because before GO nothing is drawn on the shared
// clock and the one thing that reads it — when to start the countdown — wants
// the best estimate, not a trailing one. (Slewing from the join burst's first
// guess cost one harness racer 27 ms of start skew: 5 ms a second cannot close
// a 27 ms error in the 5 s between `start` and GO.) The session sets `smooth`
// at its own GO. From then on the applied offset moves toward the estimate at
// most `ROOM_CLOCK_SLEW` of the local time that passed, so `now()` is monotonic
// and a remote ship never twitches back along its track when the estimate
// improves — except for a correction past `ROOM_CLOCK_STEP_MS`, which is taken
// whole (a clock that wrong is worse than a visible step).
//
// Pure: the caller reads the wall clock and passes it in (`performance.now()`
// in the game, a simulated clock in the harness race).

import { FIXED_DT } from '../sim/constants'

/** The shipped fixed step in ms (0.0121999998 s, hard rule 5). */
export const FIXED_DT_MS: number = FIXED_DT * 1000

/** How many recent samples the estimate spans: 32 s of the 1 Hz racing sync (`room-clock.test.ts` measures why). */
export const ROOM_CLOCK_WINDOW = 32
/** The fastest the applied offset follows the estimate: 5 ms of correction per second. */
export const ROOM_CLOCK_SLEW = 0.005
/** A correction larger than this is applied at once rather than slewed. */
export const ROOM_CLOCK_STEP_MS = 100
/** Pings in a burst: at join, and when `start` arrives (§6.3). */
export const ROOM_CLOCK_BURST = 8

interface Sample {
  t0: number
  t1: number
  room: number
}

export class RoomClock {
  readonly #window: number
  readonly #samples: Sample[] = []
  #next = 0
  #estimate = 0
  #applied = 0
  #lastLocal = Number.NaN
  #synced = false
  #rtt = Number.POSITIVE_INFINITY
  /** Slew rather than step: set at this player's GO (see the header). */
  smooth = false

  constructor(window = ROOM_CLOCK_WINDOW) {
    this.#window = window
  }

  /** True once one pong has arrived. */
  get synced(): boolean {
    return this.#synced
  }

  /** The current estimate of room − local, ms. */
  get offset(): number {
    return this.#estimate
  }

  /** The offset `now()` applies (slewing toward `offset`). */
  get applied(): number {
    return this.#applied
  }

  /** The fastest round trip in the window, ms: what the HUD shows as the link. */
  get rtt(): number {
    return this.#rtt
  }

  /** A pong for a ping sent at local `t0`, stamped `room`, received at local `t1`. */
  sample(t0: number, room: number, t1: number): void {
    if (!(t1 >= t0)) return
    if (this.#samples.length < this.#window) this.#samples.push({ t0, t1, room })
    else {
      const s = this.#samples[this.#next] as Sample
      s.t0 = t0
      s.t1 = t1
      s.room = room
    }
    this.#next = (this.#next + 1) % this.#window
    let lo = Number.NEGATIVE_INFINITY
    let hi = Number.POSITIVE_INFINITY
    let best: Sample | null = null
    for (let i = 0; i < this.#samples.length; i++) {
      const s = this.#samples[i] as Sample
      lo = Math.max(lo, s.room - s.t1)
      hi = Math.min(hi, s.room - s.t0)
      if (!best || s.t1 - s.t0 < best.t1 - best.t0) best = s
    }
    const fastest = best as Sample
    this.#rtt = fastest.t1 - fastest.t0
    // Bounds that cross mean the window holds a clock that moved (a drift, or
    // a suspended tab): trust the fastest round trip alone until it refills.
    this.#estimate = lo <= hi ? (lo + hi) / 2 : fastest.room - (fastest.t0 + fastest.t1) / 2
    if (
      !this.smooth ||
      !this.#synced ||
      Math.abs(this.#estimate - this.#applied) > ROOM_CLOCK_STEP_MS
    ) {
      this.#applied = this.#estimate
    }
    this.#synced = true
  }

  /** The room's time at local time `local`, ms. Monotonic between steps. */
  now(local: number): number {
    if (!this.smooth) this.#applied = this.#estimate
    else if (Number.isFinite(this.#lastLocal) && local > this.#lastLocal) {
      const room = ROOM_CLOCK_SLEW * (local - this.#lastLocal)
      const err = this.#estimate - this.#applied
      this.#applied += err > room ? room : err < -room ? -room : err
    }
    if (!(local < this.#lastLocal)) this.#lastLocal = local
    return local + this.#applied
  }
}

/** The shared tick at room time `roomMs`, fractional: 0 at `goAt` (§6.3). */
export const sharedTickAt = (roomMs: number, goAt: number): number => (roomMs - goAt) / FIXED_DT_MS

/** The room time of shared tick `tick`, ms. */
export const roomTimeOfTick = (tick: number, goAt: number): number => goAt + tick * FIXED_DT_MS
