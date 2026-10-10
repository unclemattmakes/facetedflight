// tests/unit/ambient-traffic.test.ts — DEV-146.
//
// Two things are under test and only one of them is the feature.
//
//  1. The SEEDING. A ship put down two thirds of the way round a course has to
//     be flying it, not standing in it and not facing back down it. Every
//     assertion below is a distance or a direction measured against the route
//     the level JSON actually carries — never a quaternion, and never a number
//     re-derived the way the code derives it (the orientation lesson, trap 24).
//
//  2. TWO POPULATIONS IN ONE FRAME, which is the thing this feature could
//     break. `sim/ai-racer.ts` steps every racer through ONE module-level
//     `HoverJetInput`, and that shared scratch is DEV-032: a finished racer
//     flew on with another racer's frozen stick, invisibly, for a session,
//     because with one racer there is nobody to inherit from. Ambient traffic
//     puts a SECOND set of racers on a DIFFERENT course in the same tick, which
//     is the same hazard with more surface. The guard is the one CLAUDE.md
//     names: step a second one and assert the first did not move — here as an
//     exact trajectory comparison, solo against interleaved, including the
//     finished branch that the original bug lived in.

import { describe, expect, it } from 'vitest'
import {
  loadAmbientTraffic,
  RECYCLE_AT,
  recycleDue,
  trafficPhases,
  trafficStarts,
} from '@/game/ambient-traffic'
import {
  AI_RACER_TUNINGS,
  type AiRacer,
  createAiRacer,
  gateArcLengths,
  seedRacerAt,
  seedSpeed,
  stepAiRacer,
} from '@/sim/ai-racer'
import { nextGate } from '@/sim/autopilot'
import { FIXED_DT } from '@/sim/constants'
import type { Gate } from '@/sim/course'
import { rotateVec3 } from '@/sim/math/quat'
import { v3 } from '@/sim/math/vec3'
import { createRoute, routeAt, routeDistance, routeTangentAt } from '@/sim/route'
import adv02 from '../../content/levels/adv_02_hoverJet.json'
import int01 from '../../content/levels/int_01_hoverJet.json'

interface RingLike {
  pos: number[]
  trigger: { radius: number }
}

/** The real course, in sim space, the way `game/mission.ts` builds it. */
const gatesOf = (level: { routes: Record<string, { rings: RingLike[] }> }): Gate[] =>
  (level.routes['0'] as { rings: RingLike[] }).rings.map((r) => ({
    centre: v3(r.pos[0] as number, r.pos[1] as number, -(r.pos[2] as number)),
    radius: r.trigger.radius,
    points: 100,
    triggerOnce: true,
  }))

const courseOf = (level: {
  routes: Record<string, { rings: RingLike[] }>
  route: number[][] | null
}) => {
  const gates = gatesOf(level)
  const route = createRoute(level.route as number[][])
  return { gates, guide: { route, gateArc: gateArcLengths(route, gates) as readonly number[] } }
}

const INT01 = courseOf(int01 as never)
const ADV02 = courseOf(adv02 as never)

const racerOn = (
  course: typeof INT01,
  id: string,
  tuning = AI_RACER_TUNINGS.fast as (typeof AI_RACER_TUNINGS)[string],
): AiRacer =>
  createAiRacer({ id, spawn: v3(0, 0, 0), orientation: [0, 0, 0, 1], tuning }, course.gates)

/** Every number that describes where a racer is and what it is about to do. */
const snapshot = (r: AiRacer) => ({
  p: [r.jet.body.position.x, r.jet.body.position.y, r.jet.body.position.z],
  v: [r.jet.body.velocity.x, r.jet.body.velocity.y, r.jet.body.velocity.z],
  q: [
    r.jet.body.orientation.x,
    r.jet.body.orientation.y,
    r.jet.body.orientation.z,
    r.jet.body.orientation.w,
  ],
  w: [r.jet.body.angularVelocity.x, r.jet.body.angularVelocity.y, r.jet.body.angularVelocity.z],
  thrust: r.jet.currentThrust,
  cursor: [r.cursor.index, r.cursor.s, r.cursor.offset],
  gates: r.gates,
  passed: [...r.course.passed],
  finished: r.finished,
  hold: r.holdAltitude,
})

describe('trafficPhases', () => {
  it('spreads the ships evenly and puts nobody on the start line', () => {
    const length = 11300
    const p = trafficPhases(3, length)
    expect(p).toHaveLength(3)
    // Evenly spaced...
    expect((p[1] as number) - (p[0] as number)).toBeCloseTo(length / 3, 6)
    expect((p[2] as number) - (p[1] as number)).toBeCloseTo(length / 3, 6)
    // ...and the gap round the end of the lap is the same gap, not a double or
    // a zero: the wrap distance from the last back to the first.
    expect(length - (p[2] as number) + (p[0] as number)).toBeCloseTo(length / 3, 6)
    // Nobody at arc length 0, which is the donor's start deck.
    for (const s of p) {
      expect(s).toBeGreaterThan(0)
      expect(s).toBeLessThan(length)
    }
  })

  it('puts a single ship halfway round rather than at the start', () => {
    expect(trafficPhases(1, 1000)).toEqual([500])
  })
})

describe('trafficStarts', () => {
  it('round-trips through the three/sim flip back onto the line', () => {
    // The starts are THREE space because that is what `game/racers.ts` takes,
    // and it flips them back with the same helpers. This asserts the whole
    // round trip lands on the line — a DISTANCE, not a sign convention.
    const phases = trafficPhases(4, INT01.guide.route.length)
    const starts = trafficStarts(INT01.guide.route, phases)
    expect(starts).toHaveLength(4)
    let worst = 0
    starts.forEach((start, i) => {
      // `racers.ts` does exactly this: `threeTupleToUnity`, which is z -> -z.
      const sim = v3(start.pos[0], start.pos[1], -start.pos[2])
      const want = routeAt(INT01.guide.route, phases[i] as number, v3())
      worst = Math.max(worst, Math.hypot(sim.x - want.x, sim.y - want.y, sim.z - want.z))
    })
    expect(worst).toBeLessThan(1e-4)
  })

  it('numbers its slots, so two ships never share a start index', () => {
    const starts = trafficStarts(INT01.guide.route, trafficPhases(3, INT01.guide.route.length))
    expect(starts.map((s) => s.from.index)).toEqual([0, 1, 2])
    expect(new Set(starts.map((s) => s.from.kind))).toEqual(new Set(['slot']))
  })
})

describe('seedRacerAt', () => {
  const route = INT01.guide.route

  it('puts the ship ON the line, at the arc length asked for', () => {
    for (const frac of [0.05, 0.25, 0.5, 0.75, 0.95]) {
      const s = frac * route.length
      const racer = racerOn(INT01, 'seeded')
      seedRacerAt(racer, INT01.guide, s)
      // Distance to the LINE, not to the nearest control point (DEV-027).
      expect(routeDistance(route, racer.jet.body.position)).toBeLessThan(1e-3)
      expect(racer.cursor.s).toBeCloseTo(s, 3)
    }
  })

  it('points the nose along the line and flies at the sheet cruise speed', () => {
    const s = 0.4 * route.length
    const racer = racerOn(INT01, 'seeded')
    seedRacerAt(racer, INT01.guide, s)
    const tangent = routeTangentAt(route, s, v3())
    // The NOSE: the body's +Z axis rotated by its orientation. A direction,
    // measured, rather than four components compared to four components.
    const nose = rotateVec3(v3(), racer.jet.body.orientation, v3(0, 0, 1))
    const dot = nose.x * tangent.x + nose.y * tangent.y + nose.z * tangent.z
    expect(dot).toBeGreaterThan(0.999999)
    // And the velocity is the same direction at the racer's own cruise
    // terminal (its sheet's since DEV-382; this racer flies 2016's).
    const v = racer.jet.body.velocity
    const cruise = seedSpeed(racer.jet)
    expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(cruise, 6)
    expect((v.x * tangent.x + v.y * tangent.y + v.z * tangent.z) / cruise).toBeGreaterThan(0.999999)
  })

  it('marks the gates BEHIND it passed, and aims at one that is ahead', () => {
    const s = 0.6 * route.length
    const racer = racerOn(INT01, 'seeded')
    seedRacerAt(racer, INT01.guide, s)
    const arc = INT01.guide.gateArc
    // Every gate is on the right side of the seed point.
    racer.course.passed.forEach((done, i) => {
      expect(
        done,
        `gate ${i} at ${(arc[i] as number).toFixed(0)} m, seeded at ${s.toFixed(0)}`,
      ).toBe((arc[i] as number) <= s)
    })
    expect(racer.gates).toBe(racer.course.passed.filter(Boolean).length)
    // Non-trivially: some behind and some ahead, or this test proves nothing.
    expect(racer.gates).toBeGreaterThan(0)
    expect(racer.gates).toBeLessThan(racer.course.passed.length)
    // And the gate it will fly at is genuinely in front of it.
    const target = nextGate(INT01.gates, racer.course.passed)
    expect(target).toBeGreaterThanOrEqual(0)
    expect(arc[target] as number).toBeGreaterThan(s)
  })

  it('a seeded ship flies FORWARD, staying on the line', () => {
    // The failure this catches is the one that has no other symptom: a ship
    // seeded past twelve rings with a fresh course turns round and flies back
    // to ring one. So: does its arc length go UP, and does it stay near the
    // line while it does?
    const s = 0.6 * route.length
    const racer = racerOn(INT01, 'seeded')
    seedRacerAt(racer, INT01.guide, s)
    let worstOffset = 0
    const steps = Math.round(20 / FIXED_DT)
    for (let i = 0; i < steps; i++) {
      stepAiRacer(racer, INT01.gates, [], FIXED_DT, INT01.guide)
      worstOffset = Math.max(worstOffset, racer.cursor.offset)
    }
    // 20 s at ~90-180 m/s is 1.8-3.6 km of line. It must have covered real
    // ground, and it must not have wandered off the line to do it.
    expect(racer.cursor.s - s).toBeGreaterThan(1200)
    expect(worstOffset).toBeLessThan(60)
    // It is FURTHER round than it started, which a ship flying back would not be.
    expect(racer.gates).toBeGreaterThan(0)
  })
})

describe('two populations in one frame (trap 19 / DEV-032)', () => {
  /**
   * Fly one racer for `steps`, optionally stepping a SECOND racer on a
   * DIFFERENT course in between every tick. The two runs must be identical.
   */
  const run = (
    seconds: number,
    opts: { interleave: boolean; seedA: number; finishedA?: boolean },
  ) => {
    const a = racerOn(INT01, 'traffic')
    seedRacerAt(a, INT01.guide, opts.seedA)
    if (opts.finishedA) {
      // The DEV-032 branch: every gate taken, so `nextGate` returns -1 and the
      // racer is in the fly-out arm that used to hold somebody else's stick.
      seedRacerAt(a, INT01.guide, INT01.guide.route.length)
    }
    const b = racerOn(ADV02, 'scoring', AI_RACER_TUNINGS.steady as never)
    seedRacerAt(b, ADV02.guide, 0.3 * ADV02.guide.route.length)
    const steps = Math.round(seconds / FIXED_DT)
    for (let i = 0; i < steps; i++) {
      stepAiRacer(a, INT01.gates, [], FIXED_DT, INT01.guide)
      if (opts.interleave) stepAiRacer(b, ADV02.gates, [], FIXED_DT, ADV02.guide)
    }
    return { a: snapshot(a), b: snapshot(b) }
  }

  it('a traffic ship flies the SAME trajectory whether or not a racer is stepped beside it', () => {
    const solo = run(30, { interleave: false, seedA: 0.45 * INT01.guide.route.length })
    const both = run(30, { interleave: true, seedA: 0.45 * INT01.guide.route.length })
    // Exactly, to the bit. Anything a second population can leak through
    // shared scratch shows up as a difference here, however small.
    expect(both.a).toEqual(solo.a)
  })

  it('and a FINISHED traffic ship does too — the branch DEV-032 lived in', () => {
    // The original bug: the finished branch wrote two of `HoverJetInput`'s six
    // fields and inherited the other four from whichever racer stepped last.
    // With one population there is nobody to inherit from; with two there is.
    const solo = run(30, { interleave: false, seedA: 0, finishedA: true })
    const both = run(30, { interleave: true, seedA: 0, finishedA: true })
    expect(solo.a.finished).toBe(true)
    expect(both.a).toEqual(solo.a)
    // And it is genuinely flying rather than parked, or the comparison above
    // is two identical frozen ships agreeing about nothing.
    expect(Math.hypot(...(solo.a.v as [number, number, number]))).toBeGreaterThan(10)
  })

  it('the populations keep their own courses — neither counts the other’s gates', () => {
    const both = run(30, { interleave: true, seedA: 0.45 * INT01.guide.route.length })
    // Different courses have different gate counts, which is the cheapest
    // possible proof that no course state was shared.
    expect(both.a.passed.length).toBe(INT01.gates.length)
    expect(both.b.passed.length).toBe(ADV02.gates.length)
    expect(INT01.gates.length).not.toBe(ADV02.gates.length)
    // And they are in different places, flying different lines.
    const d = Math.hypot(
      (both.a.p[0] as number) - (both.b.p[0] as number),
      (both.a.p[1] as number) - (both.b.p[1] as number),
      (both.a.p[2] as number) - (both.b.p[2] as number),
    )
    expect(d).toBeGreaterThan(100)
  })
})

describe('recycleDue — when a lap may be put back', () => {
  const at = (x: number, finished: boolean): AiRacer => {
    const r = racerOn(INT01, 'ship')
    r.jet.body.position.x = x
    r.finished = finished
    return r
  }
  const player = v3(0, 0, 0)
  /** Somewhere the player is not, unless a case says otherwise. */
  const away = v3(50_000, 0, 0)

  it('never while the ship is still flying its lap', () => {
    expect(recycleDue(at(10_000, false), player, 1500, away)).toBe(false)
  })

  it('never while the player is close enough to watch it go', () => {
    // The whole point of the number: at 1499 m it keeps flying out rather than
    // vanishing. DEV-041's distinction — impossible to see, not unlikely to be.
    expect(recycleDue(at(1_499, true), player, 1500, away)).toBe(false)
    expect(recycleDue(at(1_500, true), player, 1500, away)).toBe(true)
    expect(recycleDue(at(9_000, true), player, 1500, away)).toBe(true)
  })

  it('never while the player is close enough to watch it ARRIVE', () => {
    // The half that is easy to forget: a recycle has two ends. A player parked
    // beside the donor's start deck would watch a jet pop into existence there
    // however far away it vanished from.
    const ship = at(9_000, true)
    expect(recycleDue(ship, player, 1500, v3(100, 0, 0))).toBe(false)
    expect(recycleDue(ship, player, 1500, v3(1_600, 0, 0))).toBe(true)
  })

  it('measures from the PLAYER, not from the origin', () => {
    // A ship 200 m from a player who is 8 km out is close, however large its
    // own coordinates are. The failure this catches is a rule written against
    // the world origin, which on Simonet is 2 km from everything.
    const ship = at(8_200, true)
    expect(recycleDue(ship, v3(8_000, 0, 0), 1500, away)).toBe(false)
    expect(recycleDue(ship, v3(0, 0, 0), 1500, away)).toBe(true)
  })

  it('a clearance of zero recycles the instant a lap ends', () => {
    expect(recycleDue(at(0, true), player, 0, player)).toBe(true)
  })
})

describe('RECYCLE_AT — a recycled ship flies the WHOLE circuit', () => {
  it('goes back to the start of the line, not to the arc it was seeded on', () => {
    // The measured correction. Putting a ship back at its own phase confines it
    // to the arc between that phase and the finish: seeded at 83 % of
    // int_01_hoverJet it flew 1.9 km, finished, and went back to 83 % — 14
    // recycles in 100 s in the running build, with two thirds of the island
    // never visited by any of the three.
    expect(RECYCLE_AT).toBe(0)
    const racer = racerOn(INT01, 'ship')
    seedRacerAt(racer, INT01.guide, 0.83 * INT01.guide.route.length)
    expect(racer.gates).toBeGreaterThan(15)
    // Recycled: back at the line's start with the whole course still to fly.
    seedRacerAt(racer, INT01.guide, RECYCLE_AT)
    expect(racer.gates).toBe(0)
    expect(racer.course.passed.some(Boolean)).toBe(false)
    expect(racer.cursor.s).toBeCloseTo(0, 6)
    const start = routeAt(INT01.guide.route, 0, v3())
    const p = racer.jet.body.position
    expect(Math.hypot(p.x - start.x, p.y - start.y, p.z - start.z)).toBeLessThan(1e-4)
  })
})

describe('loadAmbientTraffic refuses, quietly or loudly', () => {
  const on = { enabled: true, maxCount: 4, recycleClearMetres: 1500 }
  const level = (over: Record<string, unknown>) =>
    ({ id: 'test_level', environment: 'simonet', ambientTraffic: null, ...over }) as never

  it('is null when the preset is off', async () => {
    const got = await loadAmbientTraffic(
      level({ ambientTraffic: { mission: 'x', count: 3 } }),
      { enabled: false, maxCount: 4, recycleClearMetres: 1500 },
      async () => level({}),
    )
    expect(got).toBeNull()
  })

  it('is null when the level names no donor', async () => {
    expect(await loadAmbientTraffic(level({}), on, async () => level({}))).toBeNull()
  })

  it('is null when the edition budget is zero, whatever the level asked for', async () => {
    const got = await loadAmbientTraffic(
      level({ ambientTraffic: { mission: 'x', count: 3 } }),
      { enabled: true, maxCount: 0, recycleClearMetres: 1500 },
      async () => level({ id: 'x' }),
    )
    expect(got).toBeNull()
  })

  it('refuses a donor over a different island, and says so', async () => {
    const errors: string[] = []
    const spy = console.error
    console.error = (m: unknown) => errors.push(String(m))
    try {
      const got = await loadAmbientTraffic(
        level({ ambientTraffic: { mission: 'elsewhere', count: 2 } }),
        on,
        async () => level({ id: 'elsewhere', environment: 'alpine' }),
      )
      expect(got).toBeNull()
    } finally {
      console.error = spy
    }
    expect(errors.join(' ')).toMatch(/different island/)
  })

  it('refuses a donor with no authored racing line, and says so', async () => {
    const errors: string[] = []
    const spy = console.error
    console.error = (m: unknown) => errors.push(String(m))
    try {
      const got = await loadAmbientTraffic(
        level({ ambientTraffic: { mission: 'noRoute', count: 2 } }),
        on,
        async () => level({ id: 'noRoute', environment: 'simonet', route: null }),
      )
      expect(got).toBeNull()
    } finally {
      console.error = spy
    }
    expect(errors.join(' ')).toMatch(/no authored route/)
  })

  it('refuses a donor that will not load, and says so', async () => {
    const errors: string[] = []
    const spy = console.error
    console.error = (m: unknown) => errors.push(String(m))
    try {
      const got = await loadAmbientTraffic(
        level({ ambientTraffic: { mission: 'ghost_mission', count: 2 } }),
        on,
        async () => {
          throw new Error('no such level')
        },
      )
      expect(got).toBeNull()
    } finally {
      console.error = spy
    }
    expect(errors.join(' ')).toMatch(/will not load/)
  })
})
