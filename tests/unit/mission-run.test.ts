// tests/unit/mission-run.test.ts — a whole scored run, headless.
//
// Flies a synthetic path through `int_01_hoverJet`'s 21 gates at the HoverJet's
// real top speed and asserts the mission scores it. No renderer, no browser, no
// pilot — which is the point: the scoring loop is sim-layer and deterministic,
// so a run can be verified in milliseconds instead of by flying it.
//
// This is also the harness a ghost replay will use. A recorded run has to score
// exactly what the live run scored, and the only way that is true is if scoring
// depends on nothing but the sampled positions and the fixed timestep.

import { describe, expect, it } from 'vitest'
import { type Level, liveRings } from '@/content/level-schema'
import {
  awardMedal,
  courseGates,
  medalsFor,
  missionScore,
  startMission,
  stepMission,
} from '@/game/mission'
import { FIXED_DT } from '@/sim/constants'
import { type Vec3, v3 } from '@/sim/math/vec3'
import int01 from '../../content/levels/int_01_hoverJet.json'
import rookie01 from '../../content/levels/rookie_01_hoverJet.json'

const level = int01 as unknown as Level

/** Straight-line flight from `a` to `b`, sampled at the fixed timestep. */
const flyTo = (
  state: ReturnType<typeof startMission>,
  from: Vec3,
  to: Vec3,
  speed: number,
): Vec3 => {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = to.z - from.z
  const distance = Math.hypot(dx, dy, dz)
  const steps = Math.max(1, Math.ceil(distance / (speed * FIXED_DT)))
  const at = v3()
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    at.x = from.x + dx * t
    at.y = from.y + dy * t
    at.z = from.z + dz * t
    stepMission(state, level, at, FIXED_DT)
  }
  return at
}

/**
 * The finish gate, in SIM space — where a run actually ENDS.
 *
 * These tests used to stop at the last ring and assert `finished`, because
 * `stepMission` ended the run there. Both were wrong: 2016 ends a Ring Attack
 * run at a separate non-scoring `Trigger_FinishLine` 234.6 m beyond ring 21
 * (DEV-045). A test that stops at the last ring is now testing a course the
 * game does not have.
 */
const finishAt = (): Vec3 => {
  const f = level.finish
  if (!f) throw new Error('int_01_hoverJet has no finish gate; the extractor is wrong')
  return v3(f.pos[0] as number, f.pos[1] as number, -(f.pos[2] as number))
}

/**
 * Where a run STARTS, so ring 1 is flown into rather than sat in. DEV-149.
 *
 * Every test below used to open with `at = gates[0].centre` — the ship placed
 * in the middle of the first ring's trigger sphere, which is exactly the
 * sequence DEV-074's seventeen green boundary tests were built out of and
 * exactly the one Unity cannot produce. A gate fires on the OUT-to-IN edge now
 * (`sim/course.ts`), so a run that begins inside ring 1 never enters it and
 * scores twenty of twenty-one — which is the rule working, not a regression.
 *
 * Two gate radii back down the approach line: outside the 22.62 m sphere by a
 * clear margin, and near enough that the extra second of flight cannot move a
 * medal threshold.
 */
const approachToFirstGate = (gates: readonly { centre: Vec3; radius: number }[]): Vec3 => {
  const a = gates[0] as { centre: Vec3; radius: number }
  const b = gates[1] as { centre: Vec3 } | undefined
  if (!b) return v3(a.centre.x, a.centre.y + a.radius * 2, a.centre.z)
  const dx = b.centre.x - a.centre.x
  const dy = b.centre.y - a.centre.y
  const dz = b.centre.z - a.centre.z
  const len = Math.hypot(dx, dy, dz) || 1
  const back = a.radius * 2
  return v3(
    a.centre.x - (dx / len) * back,
    a.centre.y - (dy / len) * back,
    a.centre.z - (dz / len) * back,
  )
}

describe('a complete run of int_01_hoverJet', () => {
  it('scores every gate exactly once, for exactly platinum', () => {
    const state = startMission(level)
    const gates = courseGates(level)
    expect(gates.length).toBe(21)

    // Cruise, not top boost: 200 m/s is a realistic pace and keeps the run
    // inside the 180 s limit with room to spare.
    let at = approachToFirstGate(gates)
    for (const gate of gates) at = flyTo(state, at, gate.centre, 200)

    // Twenty-one rings is NOT the end of the run any more: the gate is.
    expect(state.ringsPassed).toBe(21)
    expect(state.finished).toBe(false)
    at = flyTo(state, at, finishAt(), 200)

    expect(state.ringsPassed).toBe(21)
    // 21 rings x addScore 1 x gateMultiplier 100. And 2100 is EXACTLY the
    // platinum threshold, so `int_01` demands a perfect run — unlike
    // `rookie_01`, whose platinum is unreachable by 100 points (DEV-003).
    expect(state.score).toBe(2100)
    expect(awardMedal(state.score, level.medals)).toBe('platinum')
    expect(state.finished).toBe(true)
  })

  it('does not double-count a gate the ship lingers in', () => {
    const state = startMission(level)
    const gates = courseGates(level)
    const first = gates[0] as { centre: Vec3 }
    // Fly IN from outside — the ring has to fire once, on the edge — and then
    // sit in it for a hundred steps. Sitting there is the claim; arriving is
    // what makes the claim about a course rather than about a teleport.
    flyTo(state, approachToFirstGate(gates), first.centre, 200)
    for (let i = 0; i < 100; i++) stepMission(state, level, first.centre, FIXED_DT)
    expect(state.ringsPassed).toBe(1)
    expect(state.score).toBe(100)
  })

  it('ends the run at the time limit even with gates left', () => {
    const state = startMission(level)
    const away = v3(1e6, 1e6, 1e6)
    const steps = Math.ceil(level.timer.timeLimit / FIXED_DT) + 1
    for (let i = 0; i < steps; i++) stepMission(state, level, away, FIXED_DT)
    expect(state.finished).toBe(true)
    expect(state.ringsPassed).toBe(0)
    expect(state.elapsed).toBeGreaterThanOrEqual(level.timer.timeLimit)
  })

  it('builds gates in SIM space, mirrored from the level JSON', () => {
    // The level JSON is three space; the sim is Unity space. If this conversion
    // is dropped the gates sit on the mirror image of the island and nothing
    // ever scores — which is indistinguishable from "detection is broken".
    const rings = liveRings(level)
    const gates = courseGates(level)
    expect(gates[0]?.centre.z).toBeCloseTo(-(rings[0]?.trigger.pos[2] as number), 6)
    expect(gates[0]?.centre.x).toBeCloseTo(rings[0]?.trigger.pos[0] as number, 6)
  })
})

describe('FF2 medals: 2016 thresholds, platinum at every ring (DEV-393 follow-up)', () => {
  it('leaves bronze/silver/gold at the 2016 values, because they gate on rings', () => {
    const tuned = level.medalsFf2
    expect(tuned).not.toBeNull()
    expect(tuned?.bronze).toBe(level.medals.bronze)
    expect(tuned?.silver).toBe(level.medals.silver)
    expect(tuned?.gold).toBe(level.medals.gold)
    // Platinum is every ring (Matt, 2026-09-25: "plat = 100"). On `int_01` that
    // is 2016's own platinum: it was the ring ceiling there. DEV-004 had moved it
    // up, to every ring AND a pace; `medal-every-ring.test.ts` flies the rule on
    // every course, on both editions.
    expect(tuned?.platinum).toBe(level.medals.platinum)
  })

  it('gives an incomplete run no time bonus at all', () => {
    // The load-bearing fact behind leaving three thresholds alone: an incomplete
    // run earns no bonus, so its score is rings, exactly as in 2016. This said
    // "a run that misses a ring never ends early" — true only while a run ended
    // at the last ring. DEV-045 ended it at the finish gate instead, whatever it
    // had taken, and a run could then skip every ring for a silver. Since DEV-393
    // it is a RULE (`timeBonus`: a missed ring forfeits the bonus). This case is
    // the clock ending the run; `medal-performance.test.ts` flies the case where
    // the two readings disagree — a run that misses rings and CROSSES the finish.
    const state = startMission(level)
    const gates = courseGates(level)
    let at = approachToFirstGate(gates)
    for (const gate of gates.slice(0, 14)) at = flyTo(state, at, gate.centre, 200)
    // Then idle until the limit.
    const steps = Math.ceil(level.timer.timeLimit / FIXED_DT)
    for (let i = 0; i < steps; i++) stepMission(state, level, v3(1e6, 1e6, 1e6), FIXED_DT)

    expect(state.finished).toBe(true)
    expect(state.ringsPassed).toBe(14)
    expect(state.timeBonus).toBe(0)
    expect(missionScore(state)).toBe(1400)
    // 14 rings is exactly the 2016 silver, and it still is.
    expect(awardMedal(missionScore(state), medalsFor(level))).toBe('silver')
  })

  it('gives platinum for every ring at any pace, and time orders the clean runs', () => {
    const gates = courseGates(level)

    // A brisk run: all 21 gates at 250 m/s.
    const fast = startMission(level)
    let at = approachToFirstGate(gates)
    for (const gate of gates) at = flyTo(fast, at, gate.centre, 250)
    at = flyTo(fast, at, finishAt(), 250)
    expect(fast.ringsPassed).toBe(21)
    expect(fast.finished).toBe(true)
    expect(awardMedal(missionScore(fast), medalsFor(level))).toBe('platinum')

    // The same 21 rings, dawdling. Still platinum — Matt, 2026-09-25: "plat =
    // 100". Under DEV-004 this lap read GOLD: its platinum wanted a reference
    // pace no recorded flight reached. The clock still counts, in the SCORE:
    // the faster clean lap out-scores the slower one.
    const slow = startMission(level)
    at = approachToFirstGate(gates)
    for (const gate of gates) at = flyTo(slow, at, gate.centre, 90)
    at = flyTo(slow, at, finishAt(), 90)
    expect(slow.ringsPassed).toBe(21)
    expect(slow.finished).toBe(true)
    expect(awardMedal(missionScore(slow), medalsFor(level))).toBe('platinum')
    expect(missionScore(fast)).toBeGreaterThan(missionScore(slow))
  })
})

describe('DEV-003: rookie_01 platinum is reachable, which it was not in 2016', () => {
  it('holds platinum to the 16 rings the course has', () => {
    // 16 rings x 100 = 1600 against a shipped platinum of 1700. Mathematically
    // impossible in the first mission of the game. DEV-004 fixed it by raising
    // the score above the threshold (a time bonus); since the DEV-393 follow-up
    // FF2's platinum is every ring, so the threshold comes down to the course.
    const r = rookie01 as unknown as Level
    const ceiling = liveRings(r).length * r.scoring.gateMultiplier
    expect(ceiling).toBe(1600)
    expect(r.medals.platinum).toBe(1700)
    expect(r.medals.platinum).toBeGreaterThan(ceiling)

    const tuned = r.medalsFf2
    expect(tuned).not.toBeNull()
    // Every ring, and nothing past it: a clean run with no bonus at all (the
    // clock ran out) still scores it.
    expect(tuned?.platinum).toBeLessThanOrEqual(ceiling)
    expect(awardMedal(ceiling, tuned as NonNullable<typeof tuned>)).toBe('platinum')
    expect(awardMedal(ceiling - r.scoring.gateMultiplier, tuned as NonNullable<typeof tuned>)).toBe(
      'gold',
    )
  })
})
