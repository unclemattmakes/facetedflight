// tests/unit/next-target.test.ts — what the arrow points at, per mode (DEV-124).
//
// Against the SHIPPED levels, not fixtures, because the answer depends on
// shapes the extractor produced: a course order, a finish gate 234.6 m past
// the last ring, pads that close as a group. Ring Attack follows the same
// `nextGate` the autopilot flies, so this cannot disagree with the AI about
// where the course goes; Target Practice is a distance; Free Flight is
// nothing, on purpose.

import { describe, expect, it } from 'vitest'
import { startMission } from '@/game/mission'
import { arrowTargetForPitch, nextTargetSim, STEEP_NOSE_DEGREES } from '@/game/next-target'
import { levelJson as level } from './helpers/content'

/**
 * `started`: the run is under way. Named rather than a bare `true` at ten call
 * sites, because the interesting value is the other one — see the DEV-159
 * block at the bottom.
 */
const RUNNING = true

const same = (
  a: { x: number; y: number; z: number } | null,
  b: { x: number; y: number; z: number },
) => {
  expect(a).not.toBeNull()
  expect(a?.x).toBeCloseTo(b.x, 6)
  expect(a?.y).toBeCloseTo(b.y, 6)
  expect(a?.z).toBeCloseTo(b.z, 6)
}

describe('Ring Attack — int_01_hoverJet', () => {
  const lvl = level('int_01_hoverJet')

  it('points at the first ring, then the next unpassed one, in course order', () => {
    const m = startMission(lvl)
    expect(m.mode).toBe('ringAttack')
    same(
      nextTargetSim(m, m.course.gates[5]?.centre ?? { x: 0, y: 0, z: 0 }, RUNNING),
      m.course.gates[0]!.centre,
    )
    m.course.passed[0] = true
    same(nextTargetSim(m, { x: 0, y: 0, z: 0 }, RUNNING), m.course.gates[1]!.centre)
    // Out of order is fine: the NEXT is the first unpassed, as the autopilot has it.
    m.course.passed[1] = true
    m.course.passed[2] = true
    same(nextTargetSim(m, { x: 0, y: 0, z: 0 }, RUNNING), m.course.gates[3]!.centre)
  })

  it('after the last ring points at the FINISH gate until it is crossed, then at nothing', () => {
    const m = startMission(lvl)
    for (let i = 0; i < m.course.passed.length; i++) m.course.passed[i] = true
    const f = m.finishGate
    expect(f).not.toBeNull()
    same(nextTargetSim(m, { x: 0, y: 0, z: 0 }, RUNNING), { x: f!.x, y: f!.y, z: f!.z })
    m.finishCrossed = true
    expect(nextTargetSim(m, { x: 0, y: 0, z: 0 }, RUNNING)).toBeNull()
  })

  it('points at nothing once the run is over', () => {
    const m = startMission(lvl)
    m.finished = true
    expect(nextTargetSim(m, { x: 0, y: 0, z: 0 }, RUNNING)).toBeNull()
  })
})

describe('Target Practice — int_01_jumpSeat', () => {
  const lvl = level('int_01_jumpSeat')

  it('points at the NEAREST open pad`s bullseye, and moves on when that pad closes', () => {
    const m = startMission(lvl)
    expect(m.mode).toBe('targetPractice')
    const pads = new Set(m.targets.zones.map((z) => z.pad))
    expect(pads.size).toBeGreaterThan(2)
    // Stand on top of pad 0's bullseye: it is the nearest.
    const bull = (pad: number) =>
      m.targets.zones.filter((z) => z.pad === pad).reduce((a, b) => (b.points > a.points ? b : a))
    const p0 = bull(0)
    same(nextTargetSim(m, p0.centre, RUNNING), p0.centre)
    // Close it; the answer is another pad, and it is the nearest of the rest.
    m.targets.padClosed[0] = true
    const next = nextTargetSim(m, p0.centre, RUNNING)
    expect(next).not.toBeNull()
    const d2 = (a: { x: number; y: number; z: number }) =>
      (a.x - p0.centre.x) ** 2 + (a.y - p0.centre.y) ** 2 + (a.z - p0.centre.z) ** 2
    let nearest = Number.POSITIVE_INFINITY
    for (const pad of pads) {
      if (pad === 0) continue
      nearest = Math.min(nearest, d2(bull(pad).centre))
    }
    expect(d2(next!)).toBeCloseTo(nearest, 6)
  })

  it('with every pad closed points at the finish pad`s airspace', () => {
    const m = startMission(lvl)
    for (let i = 0; i < m.targets.padClosed.length; i++) m.targets.padClosed[i] = true
    expect(m.finishAirspace).not.toBeNull()
    same(nextTargetSim(m, { x: 0, y: 0, z: 0 }, RUNNING), m.finishAirspace!.centre)
  })
})

describe('Free Flight — hoverJet_kauai_beg', () => {
  it('points at nothing: orbs are collected in any order across the island', () => {
    const m = startMission(level('hoverJet_kauai_beg'))
    expect(m.mode).toBe('freeFlight')
    expect(nextTargetSim(m, { x: 0, y: 0, z: 0 }, RUNNING)).toBeNull()
  })
})

// ── DEV-159: not until the race has started ──────────────────────────────
//
// Matt, from a VR playthrough: *"only enable the 'next gate' arrow when the
// race has started"*. Before this the arrow pointed at gate 1 through the
// briefing, the lift and the 3-2-1.
//
// `boot/app.ts` hands in `!launchHoldsShip(launch)`, and the launch state
// machine's own tests hold what that means. What is testable HERE is that the
// answer is null whatever the course would otherwise have said — including on
// a Target Practice course, where the answer depends on where the ship is and
// a "nearest pad" is always findable.

describe('before the race has started', () => {
  const NOT_STARTED = false

  it('answers nothing on a Ring Attack course that has a first gate waiting', () => {
    const m = startMission(level('int_01_hoverJet'))
    // The premise: there IS something to point at, so null is the guard and
    // not an empty course.
    expect(nextTargetSim(m, { x: 0, y: 0, z: 0 }, RUNNING)).not.toBeNull()
    expect(nextTargetSim(m, { x: 0, y: 0, z: 0 }, NOT_STARTED)).toBeNull()
  })

  it('answers nothing on a Target Practice course standing on a pad', () => {
    const m = startMission(level('int_01_jumpSeat'))
    const where = m.targets.zones[0]?.centre ?? { x: 0, y: 0, z: 0 }
    expect(nextTargetSim(m, where, RUNNING)).not.toBeNull()
    expect(nextTargetSim(m, where, NOT_STARTED)).toBeNull()
  })

  it('answers nothing after the last ring, where the FINISH gate would be', () => {
    // The one branch that outlives the course itself (DEV-045). A restart puts
    // the launch back to `waiting` with `finishCrossed` still false on the old
    // mission for a frame, so this is the shape a stale arrow would take.
    const m = startMission(level('int_01_hoverJet'))
    for (let i = 0; i < m.course.passed.length; i++) m.course.passed[i] = true
    expect(nextTargetSim(m, { x: 0, y: 0, z: 0 }, RUNNING)).not.toBeNull()
    expect(nextTargetSim(m, { x: 0, y: 0, z: 0 }, NOT_STARTED)).toBeNull()
  })
})

describe('the arrow aims along the horizon when the nose is steep (DEV-892)', () => {
  const ship = { x: 10, y: 400, z: 20 }
  const ring = { x: 110, y: 90, z: 220 }

  it('is the true bearing while the nose is within the limit, either way', () => {
    expect(arrowTargetForPitch(ring, ship, 0)).toBe(ring)
    expect(arrowTargetForPitch(ring, ship, STEEP_NOSE_DEGREES)).toBe(ring)
    expect(arrowTargetForPitch(ring, ship, -STEEP_NOSE_DEGREES)).toBe(ring)
  })

  it('drops the vertical half of the bearing past it, and never moves the other two', () => {
    for (const pitch of [60.1, 90, -75]) {
      const aimed = arrowTargetForPitch(ring, ship, pitch)
      expect(aimed).toEqual({ x: 110, y: 400, z: 220 })
      // A new point: the mission's own gate centre is untouched.
      expect(ring.y).toBe(90)
    }
  })
})
