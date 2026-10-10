// tests/unit/crash-reset-behind.test.ts — the reset backs AWAY from the gate
// you owe, and a ring you missed does not pin it. DEV-289.
//
// > DEV-149 §5, having measured it and deliberately not touched it: *"With ring
// > 1 unscored, `limitS` is 0 and every crash for the rest of the run teleports
// > you to the START of the course, not 'a little way behind' — nine gates
// > back, on `adv_01` forty-three."*
//
// ── One root, two symptoms ────────────────────────────────────────────────
//
// The authored line of every shipped HoverJet course STARTS at ring 1 —
// `gateArc[0]` is 0.0 and the first point is 1.4 m from the trigger centre,
// against a 22.62 m radius — so there is no line in front of ring 1 to back
// away onto, and `max(0, hitS - resetBackMetres)` clamped onto the ring
// instead of behind it. Bound the search at the FIRST unscored gate and a
// missed ring 1 pins that bound at 0 for the whole run, which makes every
// later crash answer arc ~0 as well. Measured at 5 m steps over the whole line
// of all seven shipped HoverJet courses, the reset was thrown back over as
// many as 43 gates on `adv_01`, 27 on `adv_02`, 20 on four others.
//
// Two changes, one each: `crashLimitS` bounds on PROGRESS, and
// `planCrashReset` carries the shortfall backwards along the line's own
// direction at arc 0.
//
// ── Everything below is FLOWN ─────────────────────────────────────────────
//
// DEV-074's lesson, third time of asking: a rule tested by teleporting the
// ship into position is a rule tested against a sequence the game cannot
// produce. So the ship flies real legs through `stepMission`, misses rings by
// flying wide of them, and crashes by diving into a real `HeightField` hard
// enough that `stepGroundContact` reports a real `impactSpeed` over the
// preset's 45. The assertions are RELATIONSHIPS — outside the sphere, behind
// it by the spec's own `resetBackMetres`, and the ring scores when flown —
// never a position written down.

import { describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import { courseGates, placeMission, startMission, stepMission } from '@/game/mission'
import { AI_RACER_TUNINGS, createAiRacer, gateArcLengths, stepAiRacer } from '@/sim/ai-racer'
import { nextGate } from '@/sim/autopilot'
import { FIXED_DT } from '@/sim/constants'
import type { Gate } from '@/sim/course'
import { type CrashSpec, crashLimitS, createCrash, planCrashReset } from '@/sim/crash'
import { type Vec3, v3 } from '@/sim/math/vec3'
import { createRoute, routeArcLengthNear, routeAt, routeTangentAt } from '@/sim/route'
import anniversary from '../../content/editions/anniversary.json'
import adv01 from '../../content/levels/adv_01_hoverJet.json'
import adv02 from '../../content/levels/adv_02_hoverJet.json'
import kauai from '../../content/levels/hoverJet_kauai_beg.json'
import int01 from '../../content/levels/int_01_hoverJet.json'
import int02 from '../../content/levels/int_02_hoverJet.json'
import rookie01 from '../../content/levels/rookie_01_hoverJet.json'
import rookie02 from '../../content/levels/rookie_02_hoverJet.json'
import rookie02js from '../../content/levels/rookie_02_jumpSeat.json'
import { diveUntilReset, flyLeg, hoverBody, plateAt } from './helpers/crash-run'

const LEVEL = int01 as unknown as Level
/** The PRESET's numbers, so the test argues with the ones the game ships. */
const SPEC = (anniversary as unknown as { gameplay: { crash: CrashSpec } }).gameplay.crash
const ROUTE = createRoute((int01 as unknown as { route: number[][] }).route)
const GATES = courseGates(LEVEL)
const ARCS = gateArcLengths(ROUTE, GATES)

/**
 * Every shipped course that HAS rings — which is the seven HoverJet ones AND
 * `rookie_02_jumpSeat`, the one JumpSeat mission that authors a ring course.
 * It is in this list because it is the course the running max now defends.
 */
const ALL_RING_LEVELS: readonly (readonly [string, unknown])[] = [
  ['rookie_01_hoverJet', rookie01],
  ['rookie_02_hoverJet', rookie02],
  ['int_01_hoverJet', int01],
  ['int_02_hoverJet', int02],
  ['adv_01_hoverJet', adv01],
  ['adv_02_hoverJet', adv02],
  ['hoverJet_kauai_beg', kauai],
  ['rookie_02_jumpSeat', rookie02js],
]

/** Every shipped HoverJet course, for the premise sweep. */
const HOVERJET_LEVELS: readonly (readonly [string, unknown])[] = [
  ['rookie_01_hoverJet', rookie01],
  ['rookie_02_hoverJet', rookie02],
  ['int_01_hoverJet', int01],
  ['int_02_hoverJet', int02],
  ['adv_01_hoverJet', adv01],
  ['adv_02_hoverJet', adv02],
  ['hoverJet_kauai_beg', kauai],
]

const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

/**
 * Distance ignoring height, which is what the sphere tests below want.
 *
 * The collision surface a test dives onto is a FLAT PLATE spanning the whole
 * map, so `clearanceMetres` can lift a reset hundreds of metres above the line
 * — real terrain is under the ship, a plate is under everything. Ground
 * clearance is a separate rule with its own tests; asserting the crash rule's
 * geometry in the horizontal plane keeps the fixture out of the answer, and it
 * is the STRONGER statement anyway: outside the sphere horizontally is outside
 * the sphere.
 */
const flatDist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z)

describe('DEV-289: the premise — every course line starts INSIDE its first ring', () => {
  it.each(HOVERJET_LEVELS)('%s', (_id, raw) => {
    // Not a claim about the fix. It is the fact that makes the clamp wrong:
    // there is no line in front of ring 1, so "back off along the line" had
    // nowhere to go and stopped on top of the ring. If an extractor change
    // ever moves an authored line off its first ring, this goes red and the
    // carry below becomes an answer to a question nobody is asking.
    const level = raw as Level
    const gates = courseGates(level)
    const route = createRoute((raw as { route: number[][] }).route)
    const first = gates[0] as Gate
    expect(routeArcLengthNear(route, first.centre)).toBeCloseTo(0, 6)
    expect(dist(routeAt(route, 0), first.centre)).toBeLessThan(first.radius)
    // And the back-off is far longer than the ring is wide, which is why the
    // clamp could never have been harmless.
    expect(SPEC.resetBackMetres).toBeGreaterThan(first.radius * 2)
  })
})

describe('DEV-289: progress only ever goes forward', () => {
  it.each(HOVERJET_LEVELS)('%s: the bound never decreases as rings are taken', (_id, raw) => {
    // The bound is how far the run has GOT, so taking another ring can move it
    // on and can never move it back. Asserted as a relationship over the whole
    // run rather than as a table of numbers: it is true of a course whoever
    // authored it, and it is the property the running max exists to keep.
    const level = raw as Level
    const gates = courseGates(level)
    const route = createRoute((raw as { route: number[][] }).route)
    const arcs = gateArcLengths(route, gates)
    let previous = Number.NEGATIVE_INFINITY
    for (let taken = -1; taken < gates.length; taken++) {
      const passed = gates.map((_, i) => i <= taken)
      const limit = crashLimitS(arcs, passed, route.length)
      expect(limit).toBeGreaterThanOrEqual(previous)
      expect(limit).toBeLessThanOrEqual(route.length)
      previous = limit
    }
  })

  it('a course whose gates run BACKWARDS along the line exists, and the bound survives it', () => {
    // The one place the running max is load-bearing — and the course it names
    // is DERIVED, not written down, because writing it down is exactly how this
    // test broke.
    //
    // It used to name `adv_01`: 44 gates, of which the authored spline covered
    // the first 22, the rest sitting 482-2,889 m off the line with arcs running
    // backwards. **DEV-195 landed the day after this branch was written and
    // deleted that premise** — `adv_01` had TWO courses and the port was
    // drawing both concatenated; the spline says which, and it is 22 gates that
    // run forwards. The mechanism was right, the example was a bug in something
    // else, and a test naming the example went red for the fix.
    //
    // Measured on landing over all eight courses with rings: every HoverJet one
    // is now monotonic, and `rookie_02_jumpSeat` has **11** backwards steps, the
    // worst -360.4 m. So the max still earns its place. Derived here so that
    // when the next content fix moves it again, this fails loudly on the
    // PREMISE line rather than quietly testing nothing.
    const withBackwards = ALL_RING_LEVELS.map(([id, raw]) => {
      const level = raw as Level
      const gates = courseGates(level)
      const route = createRoute((raw as { route: number[][] }).route)
      const arcs = gateArcLengths(route, gates)
      let back = 0
      for (let i = 1; i < arcs.length; i++) {
        if ((arcs[i] as number) < (arcs[i - 1] as number)) back++
      }
      return { id, level, gates, route, arcs, back }
    }).filter((c) => c.back > 0)

    // MUST-FIRE. With no such course the assertion below is vacuous and the
    // running max is untested — say so rather than pass.
    expect(
      withBackwards.map((c) => c.id),
      'at least one shipped course still has gates whose arcs run backwards',
    ).not.toEqual([])

    for (const c of withBackwards) {
      // Take every gate up to the first backwards step. The bound must be where
      // THEY are — the furthest arc actually reached — not where the next gate
      // happens to project to, which is behind them.
      const first = c.arcs.findIndex((a, i) => i > 0 && a < (c.arcs[i - 1] as number))
      expect(first, `${c.id}: a backwards step`).toBeGreaterThan(0)
      const passed = c.gates.map((_, i) => i < first)
      const reachedMax = Math.max(...c.arcs.slice(0, first).map((a) => a as number))
      expect(crashLimitS(c.arcs, passed, c.route.length), c.id).toBeCloseTo(
        Math.min(reachedMax, c.route.length),
        6,
      )
      // And the thing the max defends against: the NEXT gate's arc is behind.
      expect(c.arcs[first] as number, `${c.id}: the next gate projects backwards`).toBeLessThan(
        reachedMax,
      )
    }
  })
})

describe('DEV-289: a crash short of the first ring puts you behind it', () => {
  it('the reset is outside ring 1, on the approach, and the ring then counts', () => {
    const state = startMission(LEVEL)
    const ring1 = GATES[0] as Gate
    const p0 = routeAt(ROUTE, 0)
    const tangent = routeTangentAt(ROUTE, 0)

    // ── 1. the run-in, flown: 400 m back on the line, in to 150 m short ──
    const from = v3(p0.x - tangent.x * 400, p0.y - tangent.y * 400, p0.z - tangent.z * 400)
    const to = v3(p0.x - tangent.x * 150, p0.y - tangent.y * 150, p0.z - tangent.z * 150)
    const at = flyLeg(state, LEVEL, from, to, 200)
    expect(state.course.passed[0], 'it reached ring 1 — shorten the run-in').toBe(false)
    expect(state.ringsPassed).toBe(0)

    // ── 2. the bound the app would hand the crash rule ───────────────────
    //
    // Nothing scored, so the run has got nowhere: zero, and that is CORRECT.
    // The defect was never the bound here — it was the clamp underneath it.
    const limitS = crashLimitS(ARCS, state.course.passed, ROUTE.length)
    expect(limitS).toBe(0)

    // ── 3. crash: a real contact into a real height field ────────────────
    const plate = plateAt(at.y - 60)
    const body = hoverBody(at)
    const crash = createCrash()
    const { crashedAt, resetAt } = diveUntilReset(crash, SPEC, body, plate, {
      route: ROUTE,
      limitS,
    })
    expect(crash.count, 'the ship never actually crashed — the sequence is wrong').toBe(1)
    expect(crash.impactSpeed).toBeGreaterThanOrEqual(SPEC.minImpactSpeed)
    expect(crashedAt).toBeGreaterThanOrEqual(0)
    expect(resetAt).toBeGreaterThan(crashedAt)

    // ── 4. the relationship, not a position ──────────────────────────────
    //
    // OUTSIDE the sphere: DEV-149 made gates edge-triggered, so a ship put
    // inside a ring flies out of it without ever entering and the ring is
    // lost. This is the line that would have gone red before the fix — the
    // reset landed 1.4 m from the centre.
    const reset = crash.reset.position
    expect(flatDist(reset, ring1.centre)).toBeGreaterThan(ring1.radius)

    // BEHIND it by the spec's own number. The carry is straight along the
    // line's direction at arc 0, so the displacement from the line's start is
    // `resetBackMetres` of it — measured here from the ROUTE, which knows
    // nothing about `planCrashReset`. Height is exempt: `clearanceMetres` may
    // have lifted it, and on five of the seven courses it does.
    const backX = reset.x - p0.x
    const backZ = reset.z - p0.z
    expect(Math.hypot(backX, backZ)).toBeCloseTo(
      SPEC.resetBackMetres * Math.hypot(tangent.x, tangent.z),
      1,
    )
    // On the APPROACH side: the way the line runs at arc 0 points from the
    // reset toward the ring, so the ring is in front of the ship.
    expect(backX * tangent.x + backZ * tangent.z).toBeLessThan(0)
    // The follower's cursor has no arc before the start to be rewound to.
    expect(crash.reset.s).toBe(0)

    // ── 5. and the point of all of it: the ring still counts ─────────────
    //
    // What the app does on the reset tick, and then the ship flies the 120 m
    // it owes. Before the fix it started 1.4 m from the centre, left the
    // sphere without entering it, and the ring was gone for the run.
    placeMission(state, reset)
    stepMission(state, LEVEL, reset, FIXED_DT)
    expect(state.course.passed[0], 'the reset scored the ring by being put in it').toBe(false)
    flyLeg(state, LEVEL, reset, ring1.centre, 200)
    expect(state.course.passed[0], 'the ring you crashed short of is still gone').toBe(true)
    expect(state.ringsPassed).toBe(1)
  })
})

describe('DEV-289: a ring you missed does not pin every later crash', () => {
  it('the reset stays on the leg being flown, not at the start line', () => {
    const state = startMission(LEVEL)
    const ring1 = GATES[0] as Gate
    const LAST = 5

    // ── 1. past ring 1 wide enough to miss it, then take rings 2..6 ──────
    const ring2 = GATES[1] as Gate
    const dx = ring2.centre.x - ring1.centre.x
    const dz = ring2.centre.z - ring1.centre.z
    const len = Math.hypot(dx, dz) || 1
    const offset = ring1.radius * 3
    const side = { x: (-dz / len) * offset, z: (dx / len) * offset }
    let at = flyLeg(
      state,
      LEVEL,
      v3(
        ring1.centre.x - (dx / len) * 400 + side.x,
        ring1.centre.y,
        ring1.centre.z - (dz / len) * 400 + side.z,
      ),
      v3(ring1.centre.x + side.x, ring1.centre.y, ring1.centre.z + side.z),
      200,
    )
    expect(state.course.passed[0], 'ring 1 was supposed to be MISSED').toBe(false)
    for (let i = 1; i <= LAST; i++) {
      at = flyLeg(state, LEVEL, at, (GATES[i] as Gate).centre, 200)
      expect(state.course.passed[i], `ring ${i + 1} was supposed to score`).toBe(true)
    }
    // 200 m on down the line — short of ring 7, which is 513 m further.
    const crashArc = (ARCS[LAST] as number) + 200
    at = flyLeg(state, LEVEL, at, routeAt(ROUTE, crashArc), 200)
    expect(state.course.passed[LAST + 1]).toBe(false)

    // ── 2. the two bounds, side by side ──────────────────────────────────
    //
    // The ring still OWED is ring 1 and always will be — that is the right
    // answer for the HUD arrow and the autopilot, and `nextGate` still gives
    // it. It is the wrong answer for "how far has this run got", and using it
    // for both is the whole defect.
    const owed = nextGate(GATES, state.course.passed)
    expect(owed).toBe(0)
    const oldLimit = ARCS[owed] as number
    expect(oldLimit).toBe(0)
    const limitS = crashLimitS(ARCS, state.course.passed, ROUTE.length)
    expect(limitS).toBeCloseTo(ARCS[LAST + 1] as number, 6)

    // ── 3. crash, and plan the reset BOTH ways from the same wreck ───────
    const plate = plateAt(at.y - 60)
    const body = hoverBody(at)
    const crash = createCrash()
    const { resetAt, wreck } = diveUntilReset(crash, SPEC, body, plate, { route: ROUTE, limitS })
    expect(crash.count, 'the ship never actually crashed — the sequence is wrong').toBe(1)
    expect(resetAt).toBeGreaterThan(0)
    const fixed = v3(crash.reset.position.x, crash.reset.position.y, crash.reset.position.z)
    const fixedS = crash.reset.s

    // The premise, asserted: the OLD bound really does throw this wreck back
    // to the start line. Without this the test could pass by proving nothing.
    //
    // From a body at the WRECK, not from `body` — `applyCrashReset` has
    // already moved that one onto the line, and planning a second reset from
    // the first one's landing spot would be asking a different question.
    planCrashReset(crash, SPEC, hoverBody(wreck), { route: ROUTE, limitS: oldLimit }, [plate])
    expect(crash.reset.s).toBe(0)
    expect(flatDist(crash.reset.position, ring1.centre)).toBeLessThan(SPEC.resetBackMetres * 1.1)

    // ── 4. the relationship ──────────────────────────────────────────────
    //
    // `routeArcLengthNear` searches the WHOLE line and knows nothing about the
    // bound, so this is where the WRECK is on the course, measured
    // independently of everything `planCrashReset` did. (The wreck, not the
    // waypoint: the ship is 60 m lower by the time it touches, and the nearest
    // point on a climbing line to a point below it slides along the line.)
    const trueArc = routeArcLengthNear(ROUTE, wreck)
    expect(trueArc).toBeGreaterThan(ARCS[LAST] as number)
    expect(trueArc).toBeLessThan(ARCS[LAST + 1] as number)
    // THE relationship: a little way behind where the run had got to, which is
    // what DEV-126 says a crash reset is. It used to be the start line.
    expect(trueArc - fixedS).toBeCloseTo(SPEC.resetBackMetres, 1)
    // Five gates back down the line is where the start is, and the reset is
    // nowhere near it.
    expect(flatDist(fixed, ring1.centre)).toBeGreaterThan((ARCS[LAST] as number) / 2)
    // And still behind the gate it is flying to, by the spec's own number.
    const owedNext = GATES[LAST + 1] as Gate
    expect((ARCS[LAST + 1] as number) - fixedS).toBeGreaterThanOrEqual(SPEC.resetBackMetres)
    expect(flatDist(fixed, owedNext.centre)).toBeGreaterThan(owedNext.radius)
  })
})

describe('DEV-289: and the racers fly the same rule', () => {
  it('a racer crashed short of ring 1 is put behind it, and goes on to take it', () => {
    // Really flown: `createAiRacer` off the 2016 left AI pad, `stepAiRacer`
    // with the REAL `int_01` gates and the REAL authored guide, and a real
    // contact against a real height field reporting a real impact speed. The
    // one thing injected is the dive — 300 m/s straight down, inside the
    // HoverJet's boosted 437.5 — and the ridge 12 m under it.
    const ring1 = GATES[0] as Gate
    const guide = { route: ROUTE, gateArc: ARCS }
    const racer = createAiRacer(
      {
        id: 'fast',
        spawn: v3(-857.8, 126.4, -2082.4),
        orientation: [0, 0, 0, 1],
        tuning: AI_RACER_TUNINGS.fast as never,
      },
      GATES,
    )
    for (let i = 0; i < 30; i++) stepAiRacer(racer, GATES, [], FIXED_DT, guide)
    expect(racer.course.passed[0], 'it reached ring 1 too early — shorten the run-up').toBe(false)

    const plate = plateAt(racer.jet.body.position.y - 12)
    racer.jet.body.velocity.y = -300
    let resetAt = -1
    for (let i = 0; i < 400 && resetAt < 0; i++) {
      stepAiRacer(racer, GATES, [], FIXED_DT, guide, [plate], SPEC)
      if (racer.crashEvent === 'reset') resetAt = i
    }
    expect(racer.crash.count, 'the racer never crashed — the sequence is wrong').toBe(1)
    expect(racer.crash.impactSpeed).toBeGreaterThanOrEqual(SPEC.minImpactSpeed)
    expect(resetAt).toBeGreaterThan(0)

    // Behind ring 1, not in it — the same relationship the player gets.
    const p0 = routeAt(ROUTE, 0)
    const tangent = routeTangentAt(ROUTE, 0)
    const reset = racer.crash.reset.position
    expect(flatDist(reset, ring1.centre)).toBeGreaterThan(ring1.radius)
    expect(Math.hypot(reset.x - p0.x, reset.z - p0.z)).toBeCloseTo(
      SPEC.resetBackMetres * Math.hypot(tangent.x, tangent.z),
      1,
    )

    // And it flies the ring it owes, from outside, the way a racer must.
    for (let i = 0; i < 1200 && !racer.course.passed[0]; i++) {
      stepAiRacer(racer, GATES, [], FIXED_DT, guide, [plate], SPEC)
    }
    expect(racer.course.passed[0], 'the racer never took the ring it crashed short of').toBe(true)
    expect(racer.gates).toBeGreaterThanOrEqual(1)
  })
})
