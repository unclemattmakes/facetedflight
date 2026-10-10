// The pose message (plan/MULTIPLAYER.md §7.2, DEV-387): round trips, the
// velocity range pinned against every course's fastest possible speed, and the
// reuse the frame budget depends on.

import { describe, expect, it } from 'vitest'
import { LAP_COURSES } from '@/net/lap-courses'
import {
  decodePose,
  POSE_FLAG,
  POSE_VELOCITY_MAX,
  type PoseRecord,
  PoseWriter,
  poseFrame,
  poseRecord,
} from '@/net/pose-codec'
import {
  POSE_AT,
  POSE_HEADER_BYTES,
  POSE_KIND,
  POSE_RECORD_BYTES,
  POSE_SEND_TICKS,
  POSE_TAG_V1,
} from '@/net/room-protocol'
import { terminalSpeed } from '@/sim/speed-chain'

/** A deterministic spread of records: positions km out, every quaternion sign, speeds to the edge. */
const records = (n: number, seed = 1): PoseRecord[] => {
  let s = seed
  const r = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
  return Array.from({ length: n }, (_, i) => {
    const q = [r() - 0.5, r() - 0.5, r() - 0.5, r() - 0.5]
    const qn = Math.hypot(...q)
    return {
      ...poseRecord(),
      kind: i === 0 ? POSE_KIND.own : POSE_KIND.bot,
      index: i === 0 ? 0 : i - 1,
      flags: POSE_FLAG.boost | (i % 2 ? POSE_FLAG.waiting : 0),
      px: (r() - 0.5) * 8000,
      py: r() * 1200,
      pz: (r() - 0.5) * 8000,
      qx: (q[0] as number) / qn,
      qy: (q[1] as number) / qn,
      qz: (q[2] as number) / qn,
      qw: (q[3] as number) / qn,
      vx: (r() - 0.5) * 2 * POSE_VELOCITY_MAX,
      vy: (r() - 0.5) * 400,
      vz: (r() - 0.5) * 900,
      pitch: r() * 2 - 1,
      roll: r() * 2 - 1,
      yaw: r() * 2 - 1,
      throttle: r(),
    }
  })
}

describe('the pose message layout (§7.2)', () => {
  it('is an 8-byte header and 36-byte records, tag 0x10, little-endian tick', () => {
    const bytes = new PoseWriter().encode(0x01020304, records(3), 3)
    expect(bytes.byteLength).toBe(POSE_HEADER_BYTES + 3 * POSE_RECORD_BYTES)
    expect(POSE_HEADER_BYTES).toBe(8)
    expect(POSE_RECORD_BYTES).toBe(36)
    expect(bytes[POSE_AT.tag]).toBe(POSE_TAG_V1)
    expect(bytes[POSE_AT.count]).toBe(3)
    expect([...bytes.subarray(4, 8)]).toEqual([4, 3, 2, 1])
  })

  it('sends every 4 fixed ticks: 20.49 Hz, the cost lever (§6.2)', () => {
    expect(POSE_SEND_TICKS).toBe(4)
  })
})

describe('round trip', () => {
  it('is identity on the integers: decode then encode reproduces the bytes', () => {
    const w = new PoseWriter()
    const f = poseFrame()
    for (let seed = 1; seed <= 50; seed++) {
      const n = 1 + (seed % 6)
      const bytes = new Uint8Array(w.encode(seed * 4, records(n, seed), n))
      expect(decodePose(bytes, f)).toBe(true)
      const again = new PoseWriter().encode(f.tick, f.records, f.count)
      // The room's slot byte is the only one the sender does not write.
      expect([...again]).toEqual([...bytes])
    }
  })

  it('carries every field to within its quantum', () => {
    const w = new PoseWriter()
    const f = poseFrame()
    const src = records(6, 7)
    expect(decodePose(w.encode(12345, src, 6), f)).toBe(true)
    expect(f.tick).toBe(12345)
    expect(f.count).toBe(6)
    src.forEach((s, i) => {
      const d = f.records[i] as PoseRecord
      expect([d.kind, d.index, d.flags]).toEqual([s.kind, s.index, s.flags])
      for (const k of ['px', 'py', 'pz'] as const)
        expect(Math.abs(d[k] - s[k])).toBeLessThanOrEqual(0.0005)
      for (const k of ['vx', 'vy', 'vz'] as const)
        expect(Math.abs(d[k] - s[k])).toBeLessThanOrEqual(1 / 64)
      for (const k of ['pitch', 'roll', 'yaw', 'throttle'] as const) {
        expect(Math.abs(d[k] - s[k])).toBeLessThanOrEqual(1 / 254)
      }
      // A quaternion is its orientation up to sign: compare |dot|.
      const n = Math.hypot(d.qx, d.qy, d.qz, d.qw)
      const dot = (d.qx * s.qx + d.qy * s.qy + d.qz * s.qz + d.qw * s.qw) / n
      expect(Math.abs(dot)).toBeGreaterThan(1 - 1e-7)
      // As sent: int16 rounding, not renormalised (the track normalises what it draws).
      expect(Math.abs(n - 1)).toBeLessThan(2e-4)
    })
  })

  it('decodes into the SAME records every time: nothing allocated per message', () => {
    const w = new PoseWriter()
    const f = poseFrame()
    const before = [...f.records]
    decodePose(w.encode(4, records(2, 1), 2), f)
    decodePose(w.encode(8, records(5, 2), 5), f)
    expect(f.records).toHaveLength(before.length)
    f.records.forEach((r, i) => {
      expect(r).toBe(before[i])
    })
  })

  it('encodes into the SAME buffer: one writer, no allocation per message', () => {
    const w = new PoseWriter()
    const a = w.encode(4, records(2, 1), 2)
    const b = w.encode(8, records(2, 2), 2)
    expect(b.buffer).toBe(a.buffer)
    expect(b).toBe(a) // the per-count view is made once
  })

  it('refuses another tag, a short message and a count that disagrees with the length', () => {
    const f = poseFrame()
    const ok = new Uint8Array(new PoseWriter().encode(4, records(2), 2))
    const tag = new Uint8Array(ok)
    tag[POSE_AT.tag] = 0x11
    const count = new Uint8Array(ok)
    count[POSE_AT.count] = 3
    for (const bad of [tag, count, ok.subarray(0, 7), ok.subarray(0, ok.byteLength - 1)]) {
      expect(decodePose(bad, f)).toBe(false)
    }
  })
})

describe('the velocity range holds every course at its full chain (§7.2)', () => {
  // king-tide's int16/256 carried ±128 m/s — fine at 28 m/s, and this game's
  // chained laps peak past 300. Pinned against the ceilings the lap server
  // judges by (content/lap-courses.json, every edition and aircraft variant),
  // so a retuned vehicle that would saturate the stream fails HERE, not in a
  // remote ship that silently stops at the cap.
  const fastest = () => {
    let top = { speed: 0, where: '' }
    for (const course of Object.values(LAP_COURSES.courses)) {
      const rings = course.gates.length
      for (const [edition, e] of Object.entries(course.editions)) {
        for (const [variant, v] of Object.entries(e.variants)) {
          const c = v.ceiling
          const speed = terminalSpeed(
            c.maxSpeed + c.increment * rings,
            c.boostMultiplier,
            c.mass,
            c.drag,
          )
          if (speed > top.speed) top = { speed, where: `${course.mission} ${edition} ${variant}` }
        }
      }
    }
    return top
  }

  it('carries the fastest terminal speed any course, edition and variant can reach', () => {
    const top = fastest()
    expect(top.speed).toBeGreaterThan(500) // the premise: this is not king-tide's 28 m/s
    expect(top.speed, top.where).toBeLessThan(POSE_VELOCITY_MAX)
  })

  it('round-trips that speed on any axis without saturating', () => {
    const { speed } = fastest()
    const w = new PoseWriter()
    const f = poseFrame()
    for (const axis of ['vx', 'vy', 'vz'] as const) {
      for (const sign of [1, -1]) {
        const r = { ...poseRecord(), [axis]: sign * speed }
        decodePose(w.encode(4, [r], 1), f)
        expect(Math.abs((f.records[0] as PoseRecord)[axis] - sign * speed)).toBeLessThanOrEqual(
          1 / 64,
        )
      }
    }
  })
})
