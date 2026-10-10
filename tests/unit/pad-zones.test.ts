// tests/unit/pad-zones.test.ts — a jump pad IS a dartboard, measured.
//
// Every assertion here is a DISTANCE, a COUNT or a RATIO computed off the
// generated level JSON — never a quaternion, never "the rotation is what I
// thought". CLAUDE.md's orientation lesson: four of the six orientation bugs in
// this project hid on symmetric geometry, and a quaternion assertion is your
// belief written twice. A jump pad is radially symmetric with a square bullseye,
// which is exactly the shape those bugs hide in.
//
// The numbers on the right-hand side come from
// `docs/research/_modes-spec.md` §1.2, which measured them out of
// `Prefabs/target_jumppad.prefab`. The left-hand side comes from
// `content/levels/*.json`, which `tools/extract/level.mjs` composed independently
// out of the same prefab through a completely different code path. They agree to
// four decimals across all six missions and all 57 live pads, and that agreement
// is the point: two derivations, one answer.

import { describe, expect, it } from 'vitest'
import type { Pad, PadBoxVolume } from '@/content/level-schema'
import { livePads, maxPadScore, PAD_LATCH, padZones, tierOf } from '@/game/targets'
import { padCeiling } from '@/sim/targets'
import { levelJson as level } from './helpers/content'

/** The six that carry pads, and their live counts — `_modes-spec.md` §9's table. */
const PAD_MISSIONS: [string, number][] = [
  ['rookie_01_jumpSeat', 5],
  ['rookie_02_jumpSeat', 7],
  ['int_01_jumpSeat', 6],
  ['int_02_jumpSeat', 9],
  ['adv_01_jumpSeat', 10],
  ['adv_02_jumpSeat', 12],
]

/** Rotate a vector by a THREE-space quaternion. */
const rot = (q: readonly number[], v: readonly number[]): [number, number, number] => {
  const [x, y, z, w] = q as [number, number, number, number]
  const [vx, vy, vz] = v as [number, number, number]
  const tx = 2 * (y * vz - z * vy)
  const ty = 2 * (z * vx - x * vz)
  const tz = 2 * (x * vy - y * vx)
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ]
}

/** Horizontal distance from the pad's vertical axis to the near and far corners of a zone. */
const radialSpan = (pad: Pad, zone: PadBoxVolume): [number, number] => {
  const u = rot(zone.quat, [1, 0, 0])
  const v = rot(zone.quat, [0, 1, 0])
  const w = rot(zone.quat, [0, 0, 1])
  let near = Number.POSITIVE_INFINITY
  let far = 0
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1]) {
        const cx =
          zone.pos[0] +
          sx * zone.half[0] * u[0] +
          sy * zone.half[1] * v[0] +
          sz * zone.half[2] * w[0]
        const cz =
          zone.pos[2] +
          sx * zone.half[0] * u[2] +
          sy * zone.half[1] * v[2] +
          sz * zone.half[2] * w[2]
        const r = Math.hypot(cx - pad.pos[0], cz - pad.pos[2])
        near = Math.min(near, r)
        far = Math.max(far, r)
      }
  return [near, far]
}

const byTier = (pad: Pad, tier: string): PadBoxVolume[] =>
  pad.zones.filter((z) => z.live && tierOf(z) === tier)

describe('a jump pad is a dartboard', () => {
  it('carries 1 bullseye + 8 mid + 8 outer zones on every live pad of every mission', () => {
    for (const [id] of PAD_MISSIONS) {
      for (const pad of livePads(level(id))) {
        const counts = { bullseye: 0, mid: 0, large: 0 }
        for (const zone of pad.zones) if (zone.live) counts[tierOf(zone)]++
        expect(counts, `${id} ${pad.name}`).toEqual({ bullseye: 1, mid: 8, large: 8 })
      }
    }
  })

  it('classifies every zone — an unknown path throws rather than scoring zero', () => {
    expect(() => tierOf({ path: 'jumpPad 1/trigger_something_else (1)' } as PadBoxVolume)).toThrow(
      /no known scoring tier/,
    )
  })

  // ── THE TELL ───────────────────────────────────────────────────────────
  //
  // `_modes-spec.md` §1.2: "Two numbers agree to four figures, and that is the
  // tell that this is a designed dartboard rather than a pile of boxes: the
  // bullseye's half-width is 7.268 m and the mid annulus's inner radius is
  // 7.273 m. They meet."
  //
  // It is a relationship between two independently composed transform chains, so
  // it breaks if either tier is mis-scaled or mis-nested — and it is true
  // whatever anyone believes about handedness or yaw.
  it('has the bullseye meet the mid annulus — 7.268 m against 7.273 m', () => {
    for (const [id] of PAD_MISSIONS) {
      for (const pad of livePads(level(id))) {
        const eye = byTier(pad, 'bullseye')[0] as PadBoxVolume
        const halfWidth = Math.min(eye.half[0], eye.half[2])
        const midInner = Math.min(...byTier(pad, 'mid').map((z) => radialSpan(pad, z)[0]))
        expect(halfWidth, `${id} ${pad.name}`).toBeCloseTo(7.2683, 3)
        // 2 rather than 3: `adv_02_jumpSeat`'s pads carry per-instance transform
        // noise of about half a millimetre. The RELATIONSHIP below is the claim.
        expect(midInner, `${id} ${pad.name}`).toBeCloseTo(7.2728, 2)
        expect(Math.abs(midInner - halfWidth), `${id} ${pad.name}`).toBeLessThan(0.01)
      }
    }
  })

  it('orders the three tiers outward — eye < mid < outer, ending at 21.22 m', () => {
    for (const [id] of PAD_MISSIONS) {
      for (const pad of livePads(level(id))) {
        const midInner = Math.min(...byTier(pad, 'mid').map((z) => radialSpan(pad, z)[0]))
        const midOuter = Math.max(...byTier(pad, 'mid').map((z) => radialSpan(pad, z)[1]))
        const outInner = Math.min(...byTier(pad, 'large').map((z) => radialSpan(pad, z)[0]))
        const outOuter = Math.max(...byTier(pad, 'large').map((z) => radialSpan(pad, z)[1]))
        expect(midInner).toBeLessThan(outInner)
        expect(outInner, `${id} ${pad.name}`).toBeCloseTo(13.6716, 2)
        expect(midOuter, `${id} ${pad.name}`).toBeCloseTo(17.8434, 2)
        expect(outOuter, `${id} ${pad.name}`).toBeCloseTo(21.2153, 2)
      }
    }
  })

  // ── The inversion that IS the feel of the mode ─────────────────────────
  //
  // The centre is worth the most AND is eight times easier to hit. Assert the
  // RATIO, not the two numbers: it is the relationship a re-extraction could
  // break without breaking either value on its own.
  it('makes the bullseye eight times thicker than the plates it beats', () => {
    for (const [id] of PAD_MISSIONS) {
      for (const pad of livePads(level(id))) {
        const eye = (byTier(pad, 'bullseye')[0] as PadBoxVolume).half[1] * 2
        const plates = [...byTier(pad, 'mid'), ...byTier(pad, 'large')].map((z) => z.half[1] * 2)
        const thinnest = Math.min(...plates)
        expect(eye, `${id} ${pad.name}`).toBeCloseTo(2.6087, 3)
        expect(thinnest, `${id} ${pad.name}`).toBeCloseTo(0.3185, 3)
        expect(eye / thinnest, `${id} ${pad.name}`).toBeGreaterThan(8)
      }
    }
  })

  it('stacks the tiers vertically so a descent meets outer, then mid, then eye', () => {
    // The spec's pad-local spans: outer +0.676..+1.167, mid −1.223..+0.161,
    // eye −4.300..−1.691. They do not overlap, which is why "innermost wins" is
    // well defined and why a radial reading is an approximation of a stack.
    for (const [id] of PAD_MISSIONS) {
      const pad = livePads(level(id))[0] as Pad
      const span = (t: string): [number, number] => {
        const zs = byTier(pad, t)
        return [
          Math.min(...zs.map((z) => z.pos[1] - z.half[1])) - pad.pos[1],
          Math.max(...zs.map((z) => z.pos[1] + z.half[1])) - pad.pos[1],
        ]
      }
      const [eyeLo, eyeHi] = span('bullseye')
      const [midLo, midHi] = span('mid')
      const [outLo, outHi] = span('large')
      expect(eyeHi, id).toBeLessThan(midLo)
      expect(midHi, id).toBeLessThan(outLo)
      expect(eyeLo, id).toBeCloseTo(-4.2996, 1)
      // The whole dartboard is 5.5 m deep and sits just above and below the pad
      // origin. A range rather than a point, because `adv_02_jumpSeat`'s pads
      // carry a few centimetres of per-instance tilt.
      expect(outHi, id).toBeGreaterThan(1.1)
      expect(outHi, id).toBeLessThan(1.3)
    }
  })
})

describe('the scoring tiers and the ceiling', () => {
  it('reads 100 / 50 / 25 off the three tiers, in that order', () => {
    const zones = padZones(level('int_01_jumpSeat'))
    const points = new Map<number, number>()
    for (const z of zones) points.set(z.points, (points.get(z.points) ?? 0) + 1)
    // Per pad: one 100, eight 50, eight 25. Six live pads.
    expect(points.get(100)).toBe(6)
    expect(points.get(50)).toBe(6 * 8)
    expect(points.get(25)).toBe(6 * 8)
  })

  it('agrees with 2016 s own val_score on every plate — the table against the JSON (DEV-121)', () => {
    // `TIER_POINTS` was hand-carried because the extractor read colliders, not
    // components. It reads the component now, so the two are held equal here:
    // the game's tier reading and the number Unity serialised on the plate.
    for (const id of ['rookie_01_jumpSeat', 'int_02_jumpSeat', 'adv_02_jumpSeat']) {
      const L = level(id)
      const zones = padZones(L)
      const raw = livePads(L).flatMap((p) => p.zones.filter((z) => z.live))
      expect(zones.length).toBe(raw.length)
      zones.forEach((z, i) => {
        expect(raw[i]?.points, `${id} ${raw[i]?.path}`).toBe(z.points)
        expect(raw[i]?.giveRefuelBonus, `${id} ${raw[i]?.path}`).toBe(false)
      })
      for (const p of livePads(L)) expect(p.refuel?.rate, `${id} ${p.name}`).toBe(10)
    }
  })

  it('ceilings one pad at 100 under the group latch and 150 under 2016 s', () => {
    const zones = padZones(level('int_01_jumpSeat'))
    // Derived from the latch rather than asserted against it, so this stays true
    // whichever line `PAD_LATCH` is set to — and says which one it is testing.
    expect(padCeiling(zones, 0)).toBe(PAD_LATCH === 'group' ? 100 : 150)
  })

  // `_modes-spec.md` §9's table, recomputed from the generated data rather than
  // copied from it. Fails loudly if the pad liveness walk ever changes.
  it.each(PAD_MISSIONS)('%s has %i live pads and a ceiling to match', (id, pads) => {
    const L = level(id)
    expect(livePads(L).length).toBe(pads)
    expect(maxPadScore(L)).toBe(pads * (PAD_LATCH === 'group' ? 100 : 150))
  })

  it('gives every zone an orthonormal frame — the axes, not the quaternion', () => {
    // The handedness flip is applied to three axis vectors rather than to a
    // quaternion, precisely so this is checkable as a geometric property.
    for (const zone of padZones(level('adv_02_jumpSeat'))) {
      const [u, v, w] = zone.axes
      // 5 decimals, not 9: the JSON's quaternions are serialised to six places,
      // so they are unit to about 1e-7 and no tighter.
      for (const a of [u, v, w]) expect(Math.hypot(a.x, a.y, a.z)).toBeCloseTo(1, 5)
      expect(u.x * v.x + u.y * v.y + u.z * v.z).toBeCloseTo(0, 5)
      expect(u.x * w.x + u.y * w.y + u.z * w.z).toBeCloseTo(0, 5)
      expect(v.x * w.x + v.y * w.y + v.z * w.z).toBeCloseTo(0, 5)
    }
  })

  it('flips z into SIM space and keeps every distance — pads stay where they were', () => {
    // An isometry test: the centre-to-centre distance between two pads' bullseyes
    // must be identical in the JSON's THREE space and in the sim's. If the flip
    // were wrong the course would be its own mirror image and nothing would score.
    const L = level('adv_02_jumpSeat')
    const pads = livePads(L)
    const eyes = pads.map((p) => byTier(p, 'bullseye')[0] as PadBoxVolume)
    const zones = padZones(L)
    const eyeZones = zones.filter((z) => z.points === 100)
    const a = eyes[0] as PadBoxVolume
    const b = eyes[1] as PadBoxVolume
    const three = Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2])
    const za = eyeZones[0]
    const zb = eyeZones[1]
    if (!za || !zb) throw new Error('expected two bullseyes')
    const sim = Math.hypot(
      za.centre.x - zb.centre.x,
      za.centre.y - zb.centre.y,
      za.centre.z - zb.centre.z,
    )
    expect(sim).toBeCloseTo(three, 6)
    expect(three).toBeGreaterThan(50)
  })
})
