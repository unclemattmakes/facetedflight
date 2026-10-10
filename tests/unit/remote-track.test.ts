// A remote ship's track (plan/MULTIPLAYER.md §6.4, DEV-387): samples keyed by
// the SENDER's tick, sampled on the shared clock. Burst arrival, reorder,
// loss, a 300 ms stall, a clock step, a crash reset, and the two promises the
// gate names: it never extrapolates past its cap, and never goes back in tick.

import { describe, expect, it } from 'vitest'
import {
  drawnPose,
  RemoteTrack,
  selectKth,
  TRACK_CAPACITY,
  TRACK_DELAY_MAX_MS,
  TRACK_DELAY_START_MS,
  TRACK_EXTRAPOLATE_MAX_S,
  TRACK_NARROW_PER_SAMPLE_MS,
  TRACK_SEND_INTERVAL_MS,
  TRACK_WIDEN_PER_SAMPLE_MS,
  type TrackInput,
} from '@/net/remote-track'
import { POSE_SEND_TICKS } from '@/net/room-protocol'
import { FIXED_DT } from '@/sim/constants'

/** A straight run along +x at `speed` m/s: position and velocity at tick `t`. */
const straight = (t: number, speed = 150): TrackInput => ({
  flags: 0,
  px: speed * t * FIXED_DT,
  py: 100,
  pz: 0,
  qx: 0,
  qy: 0,
  qz: 0,
  qw: 1,
  vx: speed,
  vy: 0,
  vz: 0,
  pitch: 0,
  roll: 0,
  yaw: 0,
  throttle: 1,
})

/** A turn: radius `r` m at `speed` m/s, the pose at tick `t` with its tangent velocity. */
const circle = (t: number, r = 300, speed = 160): TrackInput => {
  const w = speed / r
  const a = w * t * FIXED_DT
  return {
    ...straight(0),
    px: r * Math.cos(a),
    pz: r * Math.sin(a),
    vx: -speed * Math.sin(a),
    vz: speed * Math.cos(a),
  }
}

const fill = (track: RemoteTrack, from: number, to: number, f = straight, late = 80) => {
  for (let t = from; t <= to; t += POSE_SEND_TICKS) track.push(t, f(t), late)
}

describe('RemoteTrack (§6.4)', () => {
  it('starts two send intervals and a margin behind: about 100 ms', () => {
    expect(TRACK_SEND_INTERVAL_MS).toBeCloseTo(48.8, 1)
    expect(new RemoteTrack().delayMs).toBe(TRACK_DELAY_START_MS)
    expect(TRACK_DELAY_START_MS).toBeGreaterThan(95)
    expect(TRACK_DELAY_START_MS).toBeLessThan(115)
  })

  it('never goes backwards in tick: an older or repeated sample is dropped', () => {
    const t = new RemoteTrack()
    expect(t.push(40, straight(40), 80)).toBe(true)
    expect(t.push(36, straight(36), 80)).toBe(false) // reordered
    expect(t.push(40, straight(40), 80)).toBe(false) // duplicated
    expect(t.newestTick).toBe(40)
    expect(t.size).toBe(1)
  })

  it('never extrapolates past its cap, then holds and says stale', () => {
    const t = new RemoteTrack()
    fill(t, 0, 40)
    const out = drawnPose()
    // Inside the cap: on the velocity.
    const within = 40 + 0.1 / FIXED_DT
    expect(t.sample(within, out)).toBe('extrap')
    expect(out.px).toBeCloseTo(straight(40).px + 150 * 0.1, 6)
    expect(out.stale).toBe(false)
    // Far past it: no further than the cap, whatever the render tick.
    for (const ahead of [1, 5, 60]) {
      expect(t.sample(40 + ahead / FIXED_DT, out)).toBe('hold')
      expect(out.px).toBeCloseTo(straight(40).px + 150 * TRACK_EXTRAPOLATE_MAX_S, 6)
      expect(out.stale).toBe(true)
    }
  })

  it('takes a burst in one go, and draws through it on the clock', () => {
    // A retransmit stall: nothing, then ten samples at once. Keyed by tick,
    // each lands where it belongs; there is no span to collapse.
    const t = new RemoteTrack()
    fill(t, 0, 40)
    for (let k = 44; k <= 80; k += 4) expect(t.push(k, straight(k), 380)).toBe(true)
    const out = drawnPose()
    for (let r = 44; r < 80; r += 0.5) {
      expect(t.sample(r, out)).toBe('interp')
      expect(out.px).toBeCloseTo(150 * r * FIXED_DT, 6)
    }
  })

  it('holds its capacity: the oldest samples fall off, the order stays', () => {
    const t = new RemoteTrack()
    fill(t, 0, 4 * (TRACK_CAPACITY + 10))
    expect(t.size).toBe(TRACK_CAPACITY)
    const out = drawnPose()
    const oldest = 4 * 10 + 4
    expect(t.sample(oldest - 20, out)).toBe('early')
    expect(t.sample(oldest + 2, out)).toBe('interp')
  })

  it('follows a turn with Hermite where a lerp chords it', () => {
    const hermite = new RemoteTrack()
    const lerp = new RemoteTrack({ lerp: true })
    fill(hermite, 0, 80, circle)
    fill(lerp, 0, 80, circle)
    const out = drawnPose()
    let h = 0
    let l = 0
    for (let r = 22; r < 80; r += 4) {
      // the 16 held: ticks 20..80
      const want = circle(r)
      hermite.sample(r, out)
      h = Math.max(h, Math.hypot(out.px - want.px, out.pz - want.pz))
      lerp.sample(r, out)
      l = Math.max(l, Math.hypot(out.px - want.px, out.pz - want.pz))
    }
    // 8 m between samples on a 300 m turn: the chord's sagitta is ~2.7 cm.
    expect(l).toBeGreaterThan(0.02)
    expect(h).toBeLessThan(l / 50)
  })

  it('jumps across a crash reset instead of sweeping the sky (§6.7)', () => {
    const t = new RemoteTrack()
    fill(t, 0, 40)
    t.cut(42)
    // The reset put the ship 1 km away.
    t.push(44, { ...straight(44), px: -1000 }, 80)
    const out = drawnPose()
    t.sample(41, out)
    expect(out.px).toBeCloseTo(straight(41).px, 6) // before the cut: the old ship, carrying on
    t.sample(43, out)
    expect(out.px).toBe(-1000) // from it: the new one. Never anything between.
  })

  it('normalises every rotation it draws, including one held as sent', () => {
    const t = new RemoteTrack()
    const q = { ...straight(0), qx: 0.5001, qy: 0.5, qz: 0.5, qw: 0.4999 }
    t.push(0, q, 80)
    const out = drawnPose()
    t.sample(5, out)
    expect(Math.hypot(out.qx, out.qy, out.qz, out.qw)).toBeCloseTo(1, 12)
  })
})

describe('the adaptive delay (§6.4)', () => {
  it('settles at one send interval plus the p95 lateness plus the margin', () => {
    const t = new RemoteTrack()
    for (let k = 0; k < 400; k += 4) t.push(k, straight(k), 60)
    expect(t.delayMs).toBeCloseTo(TRACK_SEND_INTERVAL_MS + 60 + 10, 6)
  })

  it('widens no faster than its step through a 300 ms stall, then narrows slowly', () => {
    const t = new RemoteTrack()
    let k = 0
    for (; k < 200; k += 4) t.push(k, straight(k), 60)
    const settled = t.delayMs
    // Six samples held up by the stall (arriving 300..50 ms late), then normal.
    let prev = t.delayMs
    for (const late of [360, 310, 260, 210, 160, 110]) {
      k += 4
      t.push(k, straight(k), late)
      expect(t.delayMs - prev).toBeLessThanOrEqual(TRACK_WIDEN_PER_SAMPLE_MS + 1e-9)
      prev = t.delayMs
    }
    expect(t.delayMs).toBeGreaterThan(settled)
    // Back to normal: it gives the delay back at no more than its narrowing step.
    for (let i = 0; i < 40; i++) {
      k += 4
      t.push(k, straight(k), 60)
      expect(prev - t.delayMs).toBeLessThanOrEqual(TRACK_NARROW_PER_SAMPLE_MS + 1e-9)
      prev = t.delayMs
    }
  })

  it('absorbs a clock step on the receiver: lateness moves, the delay follows it', () => {
    const t = new RemoteTrack()
    let k = 0
    for (; k < 300; k += 4) t.push(k, straight(k), 60)
    // The receiver's room clock stepped 40 ms later: every sample now reads 40 ms later.
    for (let i = 0; i < 200; i++) {
      k += 4
      t.push(k, straight(k), 100)
    }
    expect(t.delayMs).toBeCloseTo(TRACK_SEND_INTERVAL_MS + 100 + 10, 6)
  })

  it('ignores lateness it cannot know yet (before GO)', () => {
    const t = new RemoteTrack()
    t.push(0, straight(0), Number.NaN)
    expect(t.delayMs).toBe(TRACK_DELAY_START_MS)
  })

  it('never widens past what the ring can serve, so a late stream still MOVES', () => {
    // DEV-388's perf run: a page busy enough to read every sample a second
    // late widened the delay past the ring's span, and all five ships parked
    // on their oldest sample ("early") instead of flying.
    expect(TRACK_DELAY_MAX_MS).toBeLessThan(TRACK_CAPACITY * TRACK_SEND_INTERVAL_MS)
    const t = new RemoteTrack()
    let k = 0
    for (let i = 0; i < 400; i++) {
      k += 4
      t.push(k, straight(k), 1500)
    }
    expect(t.delayMs).toBeLessThanOrEqual(TRACK_DELAY_MAX_MS)
    const out = drawnPose()
    expect(t.sample(k - t.delayTicks, out)).toBe('interp')
  })
})

describe('selectKth — the p95 without a sort', () => {
  it('agrees with a sort for every k, on duplicates and on runs', () => {
    let seed = 7
    const r = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    for (const n of [1, 2, 3, 17, 64]) {
      for (let trial = 0; trial < 20; trial++) {
        const xs = Array.from(
          { length: n },
          () => Math.floor(r() * 12) * 10 + (trial % 3 === 0 ? 0 : r()),
        )
        const sorted = [...xs].sort((x, y) => x - y)
        for (let k = 0; k < n; k++) {
          expect(selectKth(Float64Array.from(xs), n, k)).toBe(sorted[k])
        }
      }
    }
  })
})
