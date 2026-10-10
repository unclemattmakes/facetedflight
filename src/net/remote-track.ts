// src/net/remote-track.ts — drawing another player's ship from its pose stream. DEV-387.
//
// plan/MULTIPLAYER.md §6.4. A ring of the last samples KEYED BY THE SENDER'S
// TICK, sampled at a render tick the caller computes on the shared clock:
//
//     renderTick = sharedTickAt(roomNow, sendersGoAt) − delayMs / FIXED_DT_MS
//
// That is the whole difference from king-tide's interpolator, which keyed
// samples by when they ARRIVED: a TCP retransmit stall there froze the ship,
// then the burst arrived microseconds apart and it snapped (its evaluation
// #4). Keyed by the sender's tick, a burst is just samples that were late;
// they land where they belong on the timeline, and the ship keeps moving
// through them on the clock.
//
//   - between two samples: cubic Hermite on position using both samples'
//     velocities (the stream carries them), nlerp on rotation. At 159 m/s two
//     samples are ~8 m apart, and a straight lerp chords every turn;
//   - past the newest: extrapolate on its velocity for at most
//     `TRACK_EXTRAPOLATE_MAX_S`, then hold there and say `stale`;
//   - a sample whose tick is not newer than the newest is dropped (a
//     duplicate, or a reordered datagram if the transport ever allows one);
//   - a `reset` event cuts the track at its tick: the ship jumps across a
//     crash reset rather than sweeping across the sky (§6.7).
//
// The delay ADAPTS (§6.4). Each sample's lateness — its arrival on the room
// clock minus its tick's room time — is recorded, and the delay tracks one
// send interval plus the p95 of it: widening fast when samples arrive later
// than the delay covers, narrowing slowly when they do not.
//
// ALLOCATION-FREE after construction: typed rings, and the caller's `DrawnPose`.
// Pure: no clock is read here; the caller passes the render tick and lateness.

import { FIXED_DT } from '../sim/constants'
import { type PoseFields, restPoseFields } from './pose-codec'
import { POSE_SEND_TICKS } from './room-protocol'

/** Samples held: ~0.8 s at the pose rate, several times the widest delay. */
export const TRACK_CAPACITY = 16
/** The longest a ship is extrapolated past its newest sample, s (§6.4's ~250 ms). */
export const TRACK_EXTRAPOLATE_MAX_S = 0.25
/** One pose interval, ms: 4 fixed ticks, 48.8 ms. */
export const TRACK_SEND_INTERVAL_MS = POSE_SEND_TICKS * FIXED_DT * 1000
/** Added to the p95 lateness: headroom for the next sample's jitter. */
export const TRACK_MARGIN_MS = 10
/** The starting delay: two send intervals plus the margin (§6.4's ≈ 100 ms). */
export const TRACK_DELAY_START_MS = 2 * TRACK_SEND_INTERVAL_MS + TRACK_MARGIN_MS
/** The fastest the delay widens, per sample, ms: a transient stall is followed, not jumped. */
export const TRACK_WIDEN_PER_SAMPLE_MS = 8
/** The fastest it narrows, per sample, ms (~10 ms a second at the pose rate). */
export const TRACK_NARROW_PER_SAMPLE_MS = 0.5
/** Lateness samples the p95 is taken over: ~3 s at the pose rate. */
export const TRACK_LATENESS_WINDOW = 64
/**
 * The widest the delay may grow, ms: two samples short of what the ring holds.
 * Past it the render tick falls behind the OLDEST sample and the ship parks on
 * it ("early") instead of moving — a delay the buffer cannot serve is a frozen
 * ship, which is worse than extrapolating a little (the DEV-388 perf run
 * found all five ships parked this way).
 */
export const TRACK_DELAY_MAX_MS = (TRACK_CAPACITY - 2) * TRACK_SEND_INTERVAL_MS

/**
 * The `k`th smallest of `a[0..n)`, reordering `a` in place (Hoare's
 * quickselect, middle pivot). Allocates nothing.
 */
export const selectKth = (a: Float64Array, n: number, k: number): number => {
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1] as number
    let i = lo
    let j = hi
    while (i <= j) {
      while ((a[i] as number) < pivot) i++
      while ((a[j] as number) > pivot) j--
      if (i <= j) {
        const t = a[i] as number
        a[i] = a[j] as number
        a[j] = t
        i++
        j--
      }
    }
    if (k <= j) hi = j
    else if (k >= i) lo = i
    else return a[k] as number
  }
  return a[k] as number
}

/** The floats kept per sample. */
const STRIDE = 15
const PX = 0
const QX = 3
const VX = 7
const STICK = 10
const FLAGS = 14

/** The fields a sample carries: `PoseRecord` satisfies it. */
export type TrackInput = Readonly<PoseFields>

/** How a pose was drawn. */
export type TrackMode = 'none' | 'interp' | 'extrap' | 'hold' | 'early'

/** The caller's reused output. */
export interface DrawnPose extends PoseFields {
  mode: TrackMode
  /** Past the extrapolation cap: fade the trail and engine rather than snap (§6.4). */
  stale: boolean
}

export const drawnPose = (): DrawnPose => ({
  mode: 'none',
  stale: false,
  ...restPoseFields(),
})

export interface RemoteTrackOptions {
  /** Straight lerp instead of Hermite: the comparison §6.4 asks DEV-387's harness to make. */
  readonly lerp?: boolean
}

export class RemoteTrack {
  readonly #ticks = new Float64Array(TRACK_CAPACITY)
  readonly #data = new Float64Array(TRACK_CAPACITY * STRIDE)
  /** Samples held, oldest at `#start`, in tick order. */
  #count = 0
  #start = 0
  readonly #cuts = new Float64Array(4).fill(Number.NaN)
  #nextCut = 0
  readonly #late = new Float64Array(TRACK_LATENESS_WINDOW)
  readonly #sorted = new Float64Array(TRACK_LATENESS_WINDOW)
  #lateCount = 0
  #lateNext = 0
  #delayMs = TRACK_DELAY_START_MS
  readonly #lerp: boolean

  constructor(options: RemoteTrackOptions = {}) {
    this.#lerp = options.lerp ?? false
  }

  /** The delay the caller subtracts from the shared tick, ms. */
  get delayMs(): number {
    return this.#delayMs
  }

  /** The delay in (fractional) ticks. */
  get delayTicks(): number {
    return this.#delayMs / (FIXED_DT * 1000)
  }

  get size(): number {
    return this.#count
  }

  /** The newest tick held, or -Infinity. */
  get newestTick(): number {
    return this.#count === 0 ? Number.NEGATIVE_INFINITY : (this.#tickAt(this.#count - 1) as number)
  }

  /** Forget everything: the sender left, or a new race began. */
  clear(): void {
    this.#count = 0
    this.#start = 0
    this.#cuts.fill(Number.NaN)
    this.#lateCount = 0
    this.#delayMs = TRACK_DELAY_START_MS
  }

  /**
   * Add a sample. `lateMs` is its arrival on the room clock minus its tick's
   * room time (NaN before GO is known). False when it is not newer than the
   * newest held, which is then untouched.
   */
  push(tick: number, s: TrackInput, lateMs: number): boolean {
    if (this.#count > 0 && tick <= this.newestTick) return false
    let slot: number
    if (this.#count < TRACK_CAPACITY) {
      slot = (this.#start + this.#count) % TRACK_CAPACITY
      this.#count++
    } else {
      slot = this.#start
      this.#start = (this.#start + 1) % TRACK_CAPACITY
    }
    this.#ticks[slot] = tick
    const o = slot * STRIDE
    const d = this.#data
    d[o + PX] = s.px
    d[o + PX + 1] = s.py
    d[o + PX + 2] = s.pz
    d[o + QX] = s.qx
    d[o + QX + 1] = s.qy
    d[o + QX + 2] = s.qz
    d[o + QX + 3] = s.qw
    d[o + VX] = s.vx
    d[o + VX + 1] = s.vy
    d[o + VX + 2] = s.vz
    d[o + STICK] = s.pitch
    d[o + STICK + 1] = s.roll
    d[o + STICK + 2] = s.yaw
    d[o + STICK + 3] = s.throttle
    d[o + FLAGS] = s.flags
    if (Number.isFinite(lateMs)) this.#adapt(lateMs)
    return true
  }

  /** A crash reset or respawn at `tick`: never interpolate across it (§6.7). */
  cut(tick: number): void {
    this.#cuts[this.#nextCut] = tick
    this.#nextCut = (this.#nextCut + 1) % this.#cuts.length
  }

  /** The pose at fractional `renderTick`, into `out`. Returns `out.mode`. */
  sample(renderTick: number, out: DrawnPose): TrackMode {
    out.stale = false
    if (this.#count === 0) {
      out.mode = 'none'
      return out.mode
    }
    const oldest = this.#tickAt(0) as number
    const newest = this.newestTick
    if (renderTick <= oldest) {
      this.#copy(this.#slotOf(0), out)
      out.mode = this.#count === 1 && renderTick >= oldest ? 'hold' : 'early'
      return out.mode
    }
    if (renderTick >= newest) {
      const n = this.#slotOf(this.#count - 1)
      this.#copy(n, out)
      let dtS = (renderTick - newest) * FIXED_DT
      out.mode = 'extrap'
      if (dtS > TRACK_EXTRAPOLATE_MAX_S) {
        dtS = TRACK_EXTRAPOLATE_MAX_S
        out.mode = 'hold'
        out.stale = true
      }
      out.px += out.vx * dtS
      out.py += out.vy * dtS
      out.pz += out.vz * dtS
      return out.mode
    }
    // The pair around the render tick, searched from the newest (it is nearly always near it).
    let i = this.#count - 2
    while (i > 0 && (this.#tickAt(i) as number) > renderTick) i--
    const a = this.#slotOf(i)
    const b = this.#slotOf(i + 1)
    const ta = this.#tickAt(i) as number
    const tb = this.#tickAt(i + 1) as number
    const cut = this.#cutIn(ta, tb)
    if (cut !== null) {
      // Across a reset: before it, the old ship carried on; from it, the new one stands.
      if (renderTick < cut) {
        this.#copy(a, out)
        const dtS = (renderTick - ta) * FIXED_DT
        out.px += out.vx * dtS
        out.py += out.vy * dtS
        out.pz += out.vz * dtS
      } else this.#copy(b, out)
      out.mode = 'interp'
      return out.mode
    }
    this.#between(a, b, (renderTick - ta) / (tb - ta), (tb - ta) * FIXED_DT, out)
    out.mode = 'interp'
    return out.mode
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  #slotOf(i: number): number {
    return (this.#start + i) % TRACK_CAPACITY
  }

  #tickAt(i: number): number | undefined {
    return this.#ticks[this.#slotOf(i)]
  }

  #cutIn(ta: number, tb: number): number | null {
    // An index loop: `for…of` on a typed array makes an iterator per call.
    for (let i = 0; i < this.#cuts.length; i++) {
      const c = this.#cuts[i] as number
      if (c > ta && c <= tb) return c
    }
    return null
  }

  #copy(slot: number, out: DrawnPose): void {
    const d = this.#data
    const o = slot * STRIDE
    out.px = d[o + PX] as number
    out.py = d[o + PX + 1] as number
    out.pz = d[o + PX + 2] as number
    // The decoder leaves the int16 rotation as sent (|q| within ~1e-4 of 1):
    // every rotation drawn is normalised here or in `#between`'s nlerp.
    const qx = d[o + QX] as number
    const qy = d[o + QX + 1] as number
    const qz = d[o + QX + 2] as number
    const qw = d[o + QX + 3] as number
    const n = Math.hypot(qx, qy, qz, qw) || 1
    out.qx = qx / n
    out.qy = qy / n
    out.qz = qz / n
    out.qw = qw / n
    out.vx = d[o + VX] as number
    out.vy = d[o + VX + 1] as number
    out.vz = d[o + VX + 2] as number
    out.pitch = d[o + STICK] as number
    out.roll = d[o + STICK + 1] as number
    out.yaw = d[o + STICK + 2] as number
    out.throttle = d[o + STICK + 3] as number
    out.flags = d[o + FLAGS] as number
  }

  /** Between slots `a` and `b` at fraction `s`, over `h` seconds. */
  #between(a: number, b: number, s: number, h: number, out: DrawnPose): void {
    const d = this.#data
    const oa = a * STRIDE
    const ob = b * STRIDE
    // Cubic Hermite basis; positions use both ends' velocities (m/s x the span in s).
    const s2 = s * s
    const s3 = s2 * s
    const h00 = 2 * s3 - 3 * s2 + 1
    const h10 = s3 - 2 * s2 + s
    const h01 = -2 * s3 + 3 * s2
    const h11 = s3 - s2
    for (let k = 0; k < 3; k++) {
      const pa = d[oa + PX + k] as number
      const pb = d[ob + PX + k] as number
      const va = d[oa + VX + k] as number
      const vb = d[ob + VX + k] as number
      const p = this.#lerp ? pa + (pb - pa) * s : h00 * pa + h10 * h * va + h01 * pb + h11 * h * vb
      if (k === 0) out.px = p
      else if (k === 1) out.py = p
      else out.pz = p
      const v = va + (vb - va) * s
      if (k === 0) out.vx = v
      else if (k === 1) out.vy = v
      else out.vz = v
    }
    // nlerp, the short way round.
    const ax = d[oa + QX] as number
    const ay = d[oa + QX + 1] as number
    const az = d[oa + QX + 2] as number
    const aw = d[oa + QX + 3] as number
    let bx = d[ob + QX] as number
    let by = d[ob + QX + 1] as number
    let bz = d[ob + QX + 2] as number
    let bw = d[ob + QX + 3] as number
    if (ax * bx + ay * by + az * bz + aw * bw < 0) {
      bx = -bx
      by = -by
      bz = -bz
      bw = -bw
    }
    const qx = ax + (bx - ax) * s
    const qy = ay + (by - ay) * s
    const qz = az + (bz - az) * s
    const qw = aw + (bw - aw) * s
    const n = Math.hypot(qx, qy, qz, qw) || 1
    out.qx = qx / n
    out.qy = qy / n
    out.qz = qz / n
    out.qw = qw / n
    for (let k = 0; k < 4; k++) {
      const ka = d[oa + STICK + k] as number
      const kb = d[ob + STICK + k] as number
      const v = ka + (kb - ka) * s
      if (k === 0) out.pitch = v
      else if (k === 1) out.roll = v
      else if (k === 2) out.yaw = v
      else out.throttle = v
    }
    out.flags = d[(s < 0.5 ? oa : ob) + FLAGS] as number
  }

  #adapt(lateMs: number): void {
    this.#late[this.#lateNext] = lateMs
    this.#lateNext = (this.#lateNext + 1) % TRACK_LATENESS_WINDOW
    if (this.#lateCount < TRACK_LATENESS_WINDOW) this.#lateCount++
    const n = this.#lateCount
    // The p95 by selection on a scratch copy, in place. Not `sort()`: a typed
    // array's sort allocates inside V8, and this runs on every sample of every
    // ship (the DEV-388 heap profile found it, 0.5 MB in 16 s).
    const a = this.#sorted
    for (let i = 0; i < n; i++) a[i] = this.#late[i] as number
    const p95 = selectKth(a, n, Math.min(n - 1, Math.floor(0.95 * n)))
    const target = Math.min(
      TRACK_DELAY_MAX_MS,
      Math.max(TRACK_SEND_INTERVAL_MS + p95 + TRACK_MARGIN_MS, TRACK_SEND_INTERVAL_MS),
    )
    const step = target - this.#delayMs
    this.#delayMs +=
      step > TRACK_WIDEN_PER_SAMPLE_MS
        ? TRACK_WIDEN_PER_SAMPLE_MS
        : step < -TRACK_NARROW_PER_SAMPLE_MS
          ? -TRACK_NARROW_PER_SAMPLE_MS
          : step
  }
}
