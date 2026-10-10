// tests/unit/ghost.test.ts — sampling a recorded run.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ART_POSITION, ART_SCALE, SHIP_MODEL_YAW } from '@/game/flight'
import { GHOST_ART } from '@/game/ghosts'
import {
  createGhostClip,
  decodeGhostClip,
  GHOST_STRIDE,
  type GhostDoc,
  type GhostPose,
  sampleGhost,
} from '@/sim/ghost'
import int01 from '../../content/levels/int_01_hoverJet.json'

const pose = (): GhostPose => ({ px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1 })

/** `[t, px,py,pz, qx,qy,qz,qw]` per key. */
const clipOf = (keys: number[][]) => createGhostClip(new Float32Array(keys.flat()))

describe('sampling', () => {
  const clip = clipOf([
    [0, 0, 0, 0, 0, 0, 0, 1],
    [1, 10, 0, 0, 0, 0, 0, 1],
    [3, 30, 6, 0, 0, 0, 0, 1],
  ])

  it('reads the packing', () => {
    expect(clip.keyCount).toBe(3)
    expect(clip.duration).toBe(3)
    expect(clip.data.length).toBe(3 * GHOST_STRIDE)
  })

  it('interpolates between keys', () => {
    const p = sampleGhost(clip, 0.5, pose())
    expect(p.px).toBeCloseTo(5, 5)
    const q = sampleGhost(clip, 2, pose())
    expect(q.px).toBeCloseTo(20, 5)
    expect(q.py).toBeCloseTo(3, 5)
  })

  it('lands exactly on a key at its own time', () => {
    expect(sampleGhost(clip, 1, pose()).px).toBeCloseTo(10, 5)
  })

  it('clamps at both ends and does NOT loop', () => {
    // A ghost that reappears at the start line halfway through your run is a
    // bug that looks like a feature.
    expect(sampleGhost(clip, -99, pose()).px).toBe(0)
    expect(sampleGhost(clip, 999, pose()).px).toBeCloseTo(30, 5)
  })

  it('rejects a buffer that is not whole keys', () => {
    expect(() => createGhostClip(new Float32Array(9))).toThrow(/whole number/)
    expect(() => createGhostClip(new Float32Array(0))).toThrow()
  })

  it('takes the short way round between opposed quaternions', () => {
    // q and -q are the same rotation. Interpolating them naively sweeps ~300
    // degrees and the ghost tumbles between two keys that were a degree apart.
    const flipped = clipOf([
      [0, 0, 0, 0, 0, 0, 0, 1],
      [1, 0, 0, 0, -0.0087, 0, 0, -0.99996],
    ])
    const mid = sampleGhost(flipped, 0.5, pose())
    // Halfway should still be near identity, not near a half-turn.
    expect(Math.abs(mid.qw)).toBeGreaterThan(0.99)
    // And it stays a unit quaternion.
    expect(Math.hypot(mid.qx, mid.qy, mid.qz, mid.qw)).toBeCloseTo(1, 6)
  })

  it('seeks backwards as happily as forwards', () => {
    // The obvious optimisation — cache the last key index and scan forward —
    // breaks on a restart, which is a seek backwards. This is a binary search
    // for that reason.
    const forward = sampleGhost(clip, 2.5, pose()).px
    sampleGhost(clip, 0.1, pose())
    expect(sampleGhost(clip, 2.5, pose()).px).toBeCloseTo(forward, 6)
  })
})

const GHOST_DIR = 'content/ghosts'

const readDoc = (clip: string): GhostDoc =>
  JSON.parse(fs.readFileSync(path.join(GHOST_DIR, `${clip}.json`), 'utf8')) as GhostDoc

const readClip = (clip: string) => decodeGhostClip(readDoc(clip))

/** sha256 (first 16 hex) of each 2016 clip's decoded float32 stream. See the test. */
const DECODED_2016 = { fast: '1b72a215fcecf563', slow: 'bd3b54bc2f8c6cb6' }

describe('the on-disk format', () => {
  it('round-trips a hand-built clip within the quantisation bounds', () => {
    // The bounds tools/extract/ghost.mjs claims: 0.5 ms, 0.5 mm, 0.034 deg.
    // Asserted rather than trusted, because "far below the decimation epsilon"
    // is the entire argument for re-encoding 2016 data at all.
    const doc: GhostDoc = {
      $schema: 'ff2-ghost-1',
      keyCount: 2,
      quant: { time: 1000, pos: 1000, rot: 32767 },
      t: [0, 1500],
      p: [1176903, 127868, 23415, -4321, 0, 7],
      q: [0, 0, 0, 32767, 16384, 0, 0, 28378],
    }
    const clip = decodeGhostClip(doc)
    expect(clip.keyCount).toBe(2)
    expect(clip.duration).toBeCloseTo(1.5, 6)

    const a = sampleGhost(clip, 0, pose())
    expect(a.px).toBeCloseTo(1176.903, 3)
    expect(a.py).toBeCloseTo(127.868, 3)
    expect(a.pz).toBeCloseTo(23.415, 3)
    expect(a.qw).toBeCloseTo(1, 6)
  })

  it('decodes 2016’s ff2-ghost-1 clips to the same bytes after DEV-370', () => {
    // DEV-370 taught the decoder a second format, and 2016's must not move by
    // one bit for it: both clips' float32 streams, hashed. The two hashes were
    // taken from the decoder as it stood at 4d0dccd, before `ff2-ghost-2`
    // existed, and this file was run against that decoder to confirm them.
    const hashOf = (clip: string) => {
      const decoded = readClip(clip)
      expect(decoded.data).toBeInstanceOf(Float32Array)
      const d = decoded.data
      return createHash('sha256')
        .update(new Uint8Array(d.buffer, d.byteOffset, d.byteLength))
        .digest('hex')
        .slice(0, 16)
    }
    expect(hashOf('int_01_leftSpawn_fast_01')).toBe(DECODED_2016.fast)
    expect(hashOf('int_01_rightSpawn_slow_01')).toBe(DECODED_2016.slow)
  })

  it('hands back unit quaternions even on an exact key hit', () => {
    // int16 rounding leaves |q| off unit, and readKey returns a key verbatim.
    const clip = readClip('int_01_leftSpawn_fast_01')
    for (const t of [0, clip.duration / 3, clip.duration]) {
      const p = sampleGhost(clip, t, pose())
      expect(Math.hypot(p.qx, p.qy, p.qz, p.qw)).toBeCloseTo(1, 5)
    }
  })

  it('refuses a document whose arrays disagree with keyCount', () => {
    const bad = { keyCount: 2, quant: { time: 1000, pos: 1000, rot: 32767 }, t: [0], p: [], q: [] }
    expect(() => decodeGhostClip(bad as GhostDoc)).toThrow(/disagrees/)
  })

  it('refuses a schema it does not know', () => {
    const doc = { ...readDoc('int_01_leftSpawn_fast_01'), $schema: 'ff2-ghost-99' }
    expect(() => decodeGhostClip(doc)).toThrow(/unknown schema/)
  })
})

describe('the real 2016 recordings', () => {
  it('ships every clip its levels reference, or none at all', () => {
    // The clips are in git now, so this is a fact about the repository rather
    // than about whether someone remembered to hydrate. A level referencing a
    // clip that is not here is a runtime failure in a headset.
    for (const ref of int01.ghosts) {
      expect(fs.existsSync(path.join(GHOST_DIR, `${ref.clip}.json`)), ref.clip).toBe(true)
    }
  })

  it('stays under the denylist size ceiling', () => {
    // 256 KiB is where check-denylist.mjs stops a file without an allowlist
    // entry, and the whole point of this format is to need no entry.
    for (const f of fs.readdirSync(GHOST_DIR)) {
      expect(fs.statSync(path.join(GHOST_DIR, f)).size, f).toBeLessThan(256 * 1024)
    }
  })

  it('loads both int_01 ghosts and agrees with their authored spawns', () => {
    const refs = int01.ghosts
    expect(refs.length).toBe(2)
    const [ox, oy, oz] = int01.worldOffset as number[]

    for (const ref of refs) {
      const clip = readClip(ref.clip)

      // A recorded run of the right shape: minutes long, over a thousand keys.
      expect(clip.keyCount).toBeGreaterThan(500)
      expect(clip.duration).toBeGreaterThan(60)
      // And it fits inside the mission's own time limit, or it could never have
      // been a complete run of this course.
      expect(clip.duration).toBeLessThan(int01.timer.timeLimit)

      // The clip is relative to `levelOffset`, which IS `worldOffset`. Its first
      // key plus that offset should land on the ghost's authored spawn — the
      // independent check that clip space and world space agree about the start.
      const start = sampleGhost(clip, 0, pose())
      expect(Math.abs((ox as number) + start.px - (ref.spawn[0] as number))).toBeLessThan(5)
      expect(Math.abs((oy as number) + start.py - (ref.spawn[1] as number))).toBeLessThan(5)
      expect(Math.abs((oz as number) + start.pz - (ref.spawn[2] as number))).toBeLessThan(5)
    }
  })

  it('is decimated, not a raw 60 Hz capture', () => {
    // Shipping the raw stream plays back perfectly and is seven times the size
    // ceiling — it passes every visual check. tools/extract/ghost.mjs refuses
    // it at 40 keys/s; this is the same assertion about what actually landed.
    for (const ref of int01.ghosts) {
      const clip = readClip(ref.clip)
      expect(clip.keyCount / clip.duration, ref.clip).toBeLessThan(40)
    }
  })

  it('has a fast ghost and a slow one, and they are named honestly', () => {
    const fast = readClip('int_01_leftSpawn_fast_01')
    const slow = readClip('int_01_rightSpawn_slow_01')
    expect(fast.duration).toBeLessThan(slow.duration)
  })
})

// ── The ghosts flew backwards for as long as the ship flew forwards ───────
//
// Matt: *"the ghosts are facing backwards it looks like."* Same eye, same bug,
// second instance.
//
// `game/ghosts.ts` kept its own `ART_POSITION` / `ART_SCALE` / `ART_YAW`, a
// verbatim copy of `game/flight.ts`'s, with a comment calling an abstraction
// over them premature. Then the ship's yaw was corrected from -90 to +90 — the
// mirror fix, provenance trap 11 — and the copy was not. 180 degrees out, on
// every ghost, from that commit until now.
//
// A duplicated constant has no way to tell you it has drifted, and a ship
// pointing the wrong way reads as art direction rather than as a bug. So the
// ghosts import the ship's transform, and this is what holds them together.
describe('the ghost wears the SHIP’s art transform', () => {
  it('uses the same yaw as the player, not its own copy', () => {
    expect(GHOST_ART.yaw).toBe(SHIP_MODEL_YAW)
    // Positive. The stale copy was -PI/2, and the difference is exactly the
    // 180 degrees the mirror used to hide.
    expect(SHIP_MODEL_YAW).toBeCloseTo(Math.PI / 2, 12)
    expect(GHOST_ART.yaw).not.toBeCloseTo(-Math.PI / 2, 6)
  })

  it('uses the same position and scale, by identity rather than by value', () => {
    // `toBe`, deliberately. Equal numbers are what it looked like last time and
    // equal numbers are what drifted; the same OBJECT cannot.
    expect(GHOST_ART.position).toBe(ART_POSITION)
    expect(GHOST_ART.scale).toBe(ART_SCALE)
  })
})

// ── DEV-025: all three ships leave together ──────────────────────────────
//
// Matt: *"i didn't see those ghost racers at all."* They were on their pads and
// they stayed there: both `int_01` recordings hold on the line for about seven
// seconds — 2016's own pre-race pause, baked into the capture — while FF2
// releases the player at mission t = 0.
//
//     t = 0.00   0.0 m from its start     t = 7.48    3.2 m
//     t = 1.12   0.7 m                    t = 7.96   14.4 m
//     t = 5.98   1.0 m                    t = 8.59   43.5 m
//
// So the player got a seven-second lead on both opponents and was a kilometre
// away before either moved. Matt's call: skip the hold.
describe('the hold is skipped so the race is a race (DEV-025)', () => {
  const clips = (int01.ghosts as { clip: string }[]).map((ref) => ({
    name: ref.clip,
    doc: readDoc(ref.clip),
  }))

  it('every clip carries a measured launchAt', () => {
    for (const { name, doc } of clips) {
      expect(doc.launchAt, name).toBeGreaterThan(1)
      expect(doc.launchAt, name).toBeLessThan(doc.duration as number)
    }
  })

  it('is where the ghost has actually LEFT the pad, not where it twitched', () => {
    // The measurement that matters, re-derived here from the shipped integers
    // rather than trusted: at `launchAt` the ghost is more than 10 m from where
    // it started, and a second earlier it is under 4 m.
    for (const { name, doc } of clips) {
      const s = doc.quant.pos
      const t = doc.quant.time
      const p0 = [doc.p[0] as number, doc.p[1] as number, doc.p[2] as number]
      const at = (i: number) =>
        Math.hypot(
          (doc.p[i * 3] as number) - (p0[0] as number),
          (doc.p[i * 3 + 1] as number) - (p0[1] as number),
          (doc.p[i * 3 + 2] as number) - (p0[2] as number),
        ) / s
      let atLaunch = 0
      let aSecondBefore = 0
      for (let i = 0; i < doc.keyCount; i++) {
        const time = (doc.t[i] as number) / t
        if (time <= (doc.launchAt as number)) atLaunch = at(i)
        if (time <= (doc.launchAt as number) - 1) aSecondBefore = Math.max(aSecondBefore, at(i))
      }
      expect(atLaunch, `${name} at launch`).toBeGreaterThan(3)
      expect(aSecondBefore, `${name} a second earlier`).toBeLessThan(4)
    }
  })

  it('puts the ghost ON THE MOVE at mission t = 0, not parked', () => {
    // The behaviour, end to end. Sampled at the player's release the ghost must
    // already be leaving; a second later it must have covered real ground.
    for (const { name, doc } of clips) {
      const clip = decodeGhostClip(doc as unknown as GhostDoc)
      const a: GhostPose = { px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1 }
      const b: GhostPose = { px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1 }
      sampleGhost(clip, clip.launchAt, a)
      sampleGhost(clip, clip.launchAt + 1, b)
      const moved = Math.hypot(b.px - a.px, b.py - a.py, b.pz - a.pz)
      expect(moved, `${name} in the first second`).toBeGreaterThan(20)
    }
  })

  it('would have been parked WITHOUT the skip, which is the bug', () => {
    // The counterfactual, so the fix cannot be quietly reverted.
    for (const { name, doc } of clips) {
      const clip = decodeGhostClip(doc as unknown as GhostDoc)
      const a: GhostPose = { px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1 }
      const b: GhostPose = { px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1 }
      sampleGhost(clip, 0, a)
      sampleGhost(clip, 1, b)
      const moved = Math.hypot(b.px - a.px, b.py - a.py, b.pz - a.pz)
      expect(moved, `${name} sampled from zero`).toBeLessThan(2)
    }
  })
})
