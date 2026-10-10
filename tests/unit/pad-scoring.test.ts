// tests/unit/pad-scoring.test.ts — what a pass over a jump pad is worth.
//
// Every flight path below is built out of the ZONE'S OWN FRAME — "half a box
// along its own x axis" is inside that box whatever the box's orientation, and
// "half a box plus 0.5 m along its own y axis" is outside it. So none of these
// assertions depends on a quaternion being what anyone believed, which is
// CLAUDE.md's orientation lesson applied to a test rather than to a mesh.
//
// ── The two bugs these are here to catch ─────────────────────────────────
//
// **Tunnelling.** A 25-point plate is 0.3185 m thick and the ship covers metres
// per sim step. `stepTargets` sweeps a segment rather than testing a point, and
// "the sweep earns its place" below pins that with two samples that straddle a
// plate: the segment scores, either endpoint alone does not.
//
// **Trap 19.** 2016 shares one `ScoreKeeper_JumpPads` across every pad, so a
// port that shares a scratch result between pad sets inherits a channel between
// two runs that do not know about each other. The guard is "step a SECOND one
// and assert the first did not move", and it is invisible with one pad.

import { describe, expect, it } from 'vitest'
import { livePads, PAD_LATCH, padZones } from '@/game/targets'
import { type Vec3, v3 } from '@/sim/math/vec3'
import { createTargets, NO_STREAK, padCeiling, stepTargets, type TargetZone } from '@/sim/targets'
import { levelJson as level } from './helpers/content'

const LEVEL = level('int_01_jumpSeat')
const ZONES = padZones(LEVEL)
const PADS = livePads(LEVEL).length

/**
 * Every state here is built with `NO_STREAK`, and that is the point of the file.
 *
 * These are assertions about GEOMETRY and about the LATCH — does a 0.32 m plate
 * get hit, does a pad score twice — and they are stated in 2016's own flat
 * arithmetic so they keep saying what they say when FF2's knobs move. The
 * accuracy streak that actually ships is `tests/unit/pad-streak.test.ts`; the
 * two files meet at `padCeiling` vs `streakCeiling`.
 */
const fresh = () => createTargets(ZONES, PADS, NO_STREAK)

/** A point at `centre + u*a + v*b + w*c`, in the zone's own frame. */
const at = (zone: TargetZone, a: number, b: number, c: number): Vec3 => {
  const [u, v, w] = zone.axes
  return v3(
    zone.centre.x + u.x * a + v.x * b + w.x * c,
    zone.centre.y + u.y * a + v.y * b + w.y * c,
    zone.centre.z + u.z * a + v.z * b + w.z * c,
  )
}

const zoneWorth = (points: number, pad = 0): TargetZone => {
  const found = ZONES.find((z) => z.pad === pad && z.points === points)
  if (!found) throw new Error(`no ${points}-point zone on pad ${pad}`)
  return found
}

/** A pass straight along the plate, inside it by construction. */
const acrossPlate = (zone: TargetZone): [Vec3, Vec3] => [
  at(zone, -zone.half.x * 0.9, 0, 0),
  at(zone, zone.half.x * 0.9, 0, 0),
]

/** Straight down the pad's axis, from well above to well below. */
const downTheAxis = (pad = 0): [Vec3, Vec3] => {
  const eye = zoneWorth(100, pad)
  return [at(eye, 0, 30, 0), at(eye, 0, -30, 0)]
}

describe('what a pass over a pad is worth', () => {
  it('awards 100 for a descent down the pad axis, and nothing else', () => {
    const state = fresh()
    const [from, to] = downTheAxis()
    expect(stepTargets(state, from, to)).toBeGreaterThanOrEqual(0)
    expect(state.score).toBe(100)
    expect(state.padsHit).toBe(1)
  })

  it('awards 50 across a mid plate and 25 across an outer plate', () => {
    for (const [points, expected] of [
      [50, 50],
      [25, 25],
    ] as const) {
      const state = fresh()
      const [from, to] = acrossPlate(zoneWorth(points))
      stepTargets(state, from, to)
      expect(state.score, `tier ${points}`).toBe(expected)
    }
  })

  it('awards nothing 25 m out from the axis — the board ends at 21.22 m', () => {
    const state = fresh()
    const eye = zoneWorth(100)
    const from = v3(eye.centre.x + 25, eye.centre.y + 30, eye.centre.z)
    const to = v3(eye.centre.x + 25, eye.centre.y - 30, eye.centre.z)
    expect(stepTargets(state, from, to)).toBe(-1)
    expect(state.score).toBe(0)
  })

  // ── The vertical tolerance, which is the FEEL of the mode ─────────────
  //
  // The 25 and 50 plates are 0.3185 m thick and the bullseye is 2.6087 m: the
  // centre is worth the most AND is eight times easier to hit. Both halves are
  // asserted as an offset along the plate's own up-axis, so they are true
  // whatever the pad's orientation.
  it('misses an outer plate half a metre above it', () => {
    const state = fresh()
    const plate = zoneWorth(25)
    const from = at(plate, -plate.half.x * 0.9, plate.half.y + 0.5, 0)
    const to = at(plate, plate.half.x * 0.9, plate.half.y + 0.5, 0)
    expect(stepTargets(state, from, to)).toBe(-1)
    expect(state.score).toBe(0)
  })

  it('still catches the bullseye a whole metre above its centre', () => {
    const state = fresh()
    const eye = zoneWorth(100)
    expect(eye.half.y).toBeGreaterThan(1)
    const from = at(eye, -eye.half.x * 0.9, 1, 0)
    const to = at(eye, eye.half.x * 0.9, 1, 0)
    stepTargets(state, from, to)
    expect(state.score).toBe(100)
  })

  it('picks the innermost zone when one step crosses two tiers', () => {
    // A full descent through the axis passes the outer, mid and bullseye heights
    // in one segment. The highest value wins, which is also the innermost.
    const state = fresh()
    const [from, to] = downTheAxis()
    stepTargets(state, from, to)
    expect(state.score).toBe(100)
  })
})

describe('the latch — once per pad, and which once', () => {
  it('scores a pad once however many times you cross it', () => {
    const state = fresh()
    const [from, to] = downTheAxis()
    stepTargets(state, from, to)
    stepTargets(state, from, to)
    stepTargets(state, from, to)
    expect(state.score).toBe(100)
    expect(state.padsHit).toBe(1)
  })

  it('totals 25, not 125, when an outer plate is taken before the bullseye', () => {
    // `objectsToDisableOnTriggered`: a 25 or a 50 disables ALL THREE tiers.
    // True under either latch, which is why this one carries no `PAD_LATCH`.
    const state = fresh()
    const [a, b] = acrossPlate(zoneWorth(25))
    stepTargets(state, a, b)
    const [c, d] = downTheAxis()
    stepTargets(state, c, d)
    expect(state.score).toBe(25)
    expect(state.padsHit).toBe(1)
  })

  it('reaches exactly the pad ceiling when the bullseye is taken first', () => {
    // 2016's asymmetry: a 100 disables only the bullseye, so a mid plate can
    // still follow and the shipped ceiling is 150. `PAD_LATCH` decides whether
    // FF2 keeps that, and the expectation is DERIVED from it rather than typed,
    // so this test stays true whichever line is chosen.
    const state = fresh()
    const [a, b] = downTheAxis()
    stepTargets(state, a, b)
    const [c, d] = acrossPlate(zoneWorth(50))
    stepTargets(state, c, d)
    expect(state.score).toBe(padCeiling(ZONES, 0))
    expect(state.score).toBe(PAD_LATCH === 'group' ? 100 : 150)
    expect(state.padsHit).toBe(1)
  })

  it('counts pads, not plates — two pads flown is padsHit 2', () => {
    const state = fresh()
    for (const pad of [0, 1]) {
      const [from, to] = downTheAxis(pad)
      stepTargets(state, from, to)
    }
    expect(state.padsHit).toBe(2)
    expect(state.score).toBe(200)
  })
})

describe('the sweep earns its place', () => {
  it('catches a 0.32 m plate that a point test at the same samples misses', () => {
    const plate = zoneWorth(25)
    // Two samples 1.3 m apart, straddling a plate 0.3185 m thick — roughly one
    // sim step at a brisk descent. The ship is never AT the plate on either.
    const above = at(plate, 0, plate.half.y + 0.5, 0)
    const below = at(plate, 0, -plate.half.y - 0.5, 0)

    const swept = fresh()
    expect(stepTargets(swept, above, below)).toBeGreaterThanOrEqual(0)
    expect(swept.score).toBe(25)

    // The same two positions, tested as points: nothing, twice.
    const pointwise = fresh()
    expect(stepTargets(pointwise, above, above)).toBe(-1)
    expect(stepTargets(pointwise, below, below)).toBe(-1)
    expect(pointwise.score).toBe(0)
  })

  it('degrades to a containment test when the ship is stationary', () => {
    const state = fresh()
    const eye = zoneWorth(100)
    const inside = at(eye, 0, 0, 0)
    stepTargets(state, inside, inside)
    expect(state.score).toBe(100)
  })
})

describe('trap 19 — two pad sets do not talk to each other', () => {
  it('leaves the first state untouched when a second one is stepped', () => {
    // Both share the same readonly `ZONES` array, which is the sharing a port
    // would plausibly do and the sharing that would leak if any of the
    // per-run state lived on the zones or in a module-level scratch.
    const first = fresh()
    const second = fresh()

    const [a, b] = downTheAxis(0)
    stepTargets(first, a, b)
    const before = {
      score: first.score,
      padsHit: first.padsHit,
      taken: [...first.taken],
      padClosed: [...first.padClosed],
    }

    for (const pad of [0, 1, 2]) {
      const [from, to] = downTheAxis(pad)
      stepTargets(second, from, to)
    }
    const [c, d] = acrossPlate(zoneWorth(50, 3))
    stepTargets(second, c, d)

    expect(second.padsHit).toBe(4)
    expect(first.score).toBe(before.score)
    expect(first.padsHit).toBe(before.padsHit)
    expect(first.taken).toEqual(before.taken)
    expect(first.padClosed).toEqual(before.padClosed)
  })

  it('keeps two different missions apart as well', () => {
    const other = level('adv_02_jumpSeat')
    const otherZones = padZones(other)
    const otherState = createTargets(otherZones, livePads(other).length, NO_STREAK)
    const mine = fresh()

    const [a, b] = downTheAxis(0)
    stepTargets(mine, a, b)

    const eye = otherZones.find((z) => z.pad === 0 && z.points === 100) as TargetZone
    stepTargets(otherState, at(eye, 0, 30, 0), at(eye, 0, -30, 0))

    expect(mine.score).toBe(100)
    expect(otherState.score).toBe(100)
    expect(mine.padsHit).toBe(1)
    expect(otherState.padsHit).toBe(1)
    // Different missions, different pad counts — nothing is shared but the code.
    expect(mine.padClosed).toHaveLength(6)
    expect(otherState.padClosed).toHaveLength(12)
  })
})
