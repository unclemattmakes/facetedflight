// tests/unit/crash-gate-score.test.ts — a crash does not buy you a ring. DEV-149.
//
// > NEXT.md, from the 2026-09-16 playthrough: *"a crash reset inside a MISSED
// > gate's sphere scores it (DEV-126)"*.
//
// ── This file exists because of DEV-074, and it is built the opposite way ──
//
// `sim/boundary.ts` shipped a LEVEL test where Unity has an EDGE, and it was
// invisible to seventeen green unit tests *"because every one of them started
// the ship in the middle of the sphere and teleported it out — a sequence Unity
// cannot produce."* `sim/course.ts` had the same bug in the other direction and
// the same blind spot would hide it, so nothing below teleports anything the
// GAME does not teleport:
//
//   1. the ship flies from before ring 1, PAST it, wide enough to miss, and on
//      into ring 2 — so ring 2 scores and ring 1 does not, the way a wide line
//      really does miss a ring;
//   2. it turns back for the ring it owes and flies into a hillside on the way,
//      hard enough that the CONTACT reports an impact over the preset's
//      threshold — `stepGroundContact` against a real `HeightField`, not a
//      number handed in;
//   3. `stepCrashAndBoundary` holds it and, `holdSeconds` later, resets it — the
//      function `boot/app.ts` calls, with the preset's own spec and the real
//      authored line;
//   4. `placeMission` is what the app does on that tick, and then the mission
//      is stepped at the reset pose.
//
// The PREMISE is asserted, not assumed: step 3's reset really does land inside
// ring 1's trigger sphere, or the test would pass by proving nothing. Take
// `seedCourse` out of `placeMission` and step 4 pays 100 points for crashing.
//
// ── Why the reset lands there at all, and why it takes a turn-back now ────
//
// Measured over all seven shipped HoverJet courses: the authored `route` starts
// AT ring 1 (`gateArc[0]` is 0.0, and the line's first point is 1.4 m from the
// trigger centre). When this file was written the crash reset was bounded at
// the FIRST UNSCORED gate, so a missed ring 1 pinned that bound at 0 for the
// whole run and EVERY crash answered arc 0 — ring 1's doorstep — from any
// position on the course.
//
// **DEV-289 fixed that**, and the sequence here had to change with it. The
// bound is PROGRESS now, and the back-off is carried behind the line's start
// rather than clamped onto it, so a crash out on the course comes back onto
// the leg it was flown on. The reset reaches ring 1's sphere by exactly one
// route today: the ship turns round for the ring it owes and crashes about
// `resetBackMetres` short of it — which is a thing a person really does, and
// the one below. Nothing about `stepCourse` changed; what changed is how hard
// it is to get into this position, which is the point of DEV-289.
//
// The racer's route to it closed altogether — a racer only flies forward, and
// no shipped course has gates closer together than `resetBackMetres` — so the
// racer case below is the seed itself, observed where it still bites.

import { describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import { courseGates, placeMission, startMission, stepMission } from '@/game/mission'
import { AI_RACER_TUNINGS, createAiRacer, gateArcLengths, stepAiRacer } from '@/sim/ai-racer'
import { nextGate } from '@/sim/autopilot'
import { FIXED_DT } from '@/sim/constants'
import type { Gate } from '@/sim/course'
import { type CrashSpec, crashLimitS, createCrash } from '@/sim/crash'
import { type Vec3, v3 } from '@/sim/math/vec3'
import { createRoute, routeArcLengthNear, routeAt } from '@/sim/route'
import anniversary from '../../content/editions/anniversary.json'
import int01 from '../../content/levels/int_01_hoverJet.json'
import { diveUntilReset, flyLeg, hoverBody, plateAt } from './helpers/crash-run'

const LEVEL = int01 as unknown as Level
/** The PRESET's numbers, so the test argues with the ones the game ships. */
const SPEC = (anniversary as unknown as { gameplay: { crash: CrashSpec } }).gameplay.crash
const ROUTE = createRoute((int01 as unknown as { route: number[][] }).route)
const GATES = courseGates(LEVEL)
const ARCS = gateArcLengths(ROUTE, GATES)

const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

describe('DEV-149: a crash does not score a ring you missed', () => {
  it('the premise: the line starts ON ring 1, so a reset can be put inside it', () => {
    // Not a claim about the fix — a claim about the COURSE, which is what makes
    // the sequence below reachable rather than contrived. If an extractor
    // change ever moves the authored line off ring 1, this goes red and the
    // test below becomes an argument about nothing.
    const first = GATES[0] as Gate
    expect(routeArcLengthNear(ROUTE, first.centre)).toBeCloseTo(0, 6)
    const start = routeAt(ROUTE, 0)
    const d = dist(start, first.centre)
    expect(d).toBeLessThan(first.radius)
    expect(d).toBeCloseTo(1.4, 1)
  })

  it('miss ring 1, take ring 2, crash turning back for it: ring 1 is STILL missed', () => {
    const state = startMission(LEVEL)
    const ring1 = GATES[0] as Gate
    const ring2 = GATES[1] as Gate

    // ── 1. past ring 1, wide enough to miss it ──────────────────────────
    //
    // Offset perpendicular to the leg, by three trigger radii. A real wide
    // line: the ship passes the ring and never enters the sphere.
    const dx = ring2.centre.x - ring1.centre.x
    const dz = ring2.centre.z - ring1.centre.z
    const len = Math.hypot(dx, dz) || 1
    const offset = ring1.radius * 3
    const side = { x: (-dz / len) * offset, z: (dx / len) * offset }
    const before = v3(
      ring1.centre.x - (dx / len) * 400 + side.x,
      ring1.centre.y,
      ring1.centre.z - (dz / len) * 400 + side.z,
    )
    const abeam = v3(ring1.centre.x + side.x, ring1.centre.y, ring1.centre.z + side.z)
    let at = flyLeg(state, LEVEL, before, abeam, 200)
    // Missed, and it is a MISS rather than a "not reached yet": the ship went
    // past the ring's own plane.
    expect(state.course.passed[0]).toBe(false)
    // ── and on into ring 2, which DOES score ─────────────────────────────
    at = flyLeg(state, LEVEL, at, ring2.centre, 200)
    expect(state.course.passed[1]).toBe(true)
    expect(state.course.passed[0]).toBe(false)
    expect(state.ringsPassed).toBe(1)
    const scoreBeforeCrash = state.score

    // ── 2. turn back for the ring you owe ────────────────────────────────
    //
    // Back down the line to a little over `resetBackMetres` short of ring 1 —
    // still outside its sphere, so nothing scores on the way — which is where
    // a reset planned from here lands ON it.
    at = flyLeg(state, LEVEL, at, routeAt(ROUTE, SPEC.resetBackMetres + 12), 200)
    expect(state.course.passed[0], 'the turn-back flew through ring 1').toBe(false)

    // ── 3. crash: a real contact, hard, into a real height field ─────────
    //
    // A plate 60 m under the ship, flown into nose-down at 200 m/s. The number
    // the crash rule consumes is the CONTACT's own, not one handed in. 60 and
    // not 6: the plate is FLAT and spans the map, so `clearanceMetres` lifts
    // the reset to 40 m over it wherever it lands — a shallow plate under a
    // ship 150 m up puts the reset 40 m above the line and outside every ring,
    // which is a fact about the fixture and not about the game.
    const plate = plateAt(at.y - 60)
    const body = hoverBody(at)
    const crash = createCrash()
    // `limitS` exactly as `boot/app.ts` computes it, through the app's own
    // function: ring 2 is taken, so the run has got as far as ring 3's arc.
    // The ring still OWED is ring 1 and `nextGate` still says so — the two
    // questions came apart in DEV-289.
    expect(nextGate(GATES, state.course.passed)).toBe(0)
    const limitS = crashLimitS(ARCS, state.course.passed, ROUTE.length)
    expect(limitS).toBeCloseTo(ARCS[2] as number, 6)

    const { crashedAt, resetAt } = diveUntilReset(crash, SPEC, body, plate, {
      route: ROUTE,
      limitS,
    })
    expect(crash.count, 'the ship never actually crashed — the sequence is wrong').toBe(1)
    expect(resetAt).toBeGreaterThan(crashedAt)
    expect(crashedAt).toBeGreaterThanOrEqual(0)

    // ── the premise, asserted ───────────────────────────────────────────
    //
    // The reset really is inside the missed ring's trigger sphere. Without
    // this line the test could pass by resetting somewhere harmless.
    expect(
      dist(crash.reset.position, ring1.centre),
      'the reset did not land in ring 1 — the bug is unreachable',
    ).toBeLessThan(ring1.radius)

    // ── 4. what the app does on the reset tick, and then one more step ───
    placeMission(state, crash.reset.position)
    stepMission(state, LEVEL, crash.reset.position, FIXED_DT)
    // Sit there a while: being inside is not entering, however long you are.
    for (let i = 0; i < 60; i++) stepMission(state, LEVEL, crash.reset.position, FIXED_DT)

    expect(state.course.passed[0], 'the crash scored the ring it was put inside').toBe(false)
    expect(state.ringsPassed).toBe(1)
    expect(state.score).toBe(scoreBeforeCrash)
  })

  it('and it is still a ring: leave the sphere, fly back through it, and it pays', () => {
    // The other half, and the one that would catch an over-correction. A gate
    // the reset put you inside is not lost — it is un-entered.
    const state = startMission(LEVEL)
    const ring1 = GATES[0] as Gate
    const ring2 = GATES[1] as Gate
    const dx = ring2.centre.x - ring1.centre.x
    const dz = ring2.centre.z - ring1.centre.z
    const len = Math.hypot(dx, dz) || 1

    // Put the ship 1.4 m from ring 1's centre, exactly where the crash reset
    // above lands, through the same door the app uses.
    const dropped = v3(ring1.centre.x + 1.4, ring1.centre.y, ring1.centre.z)
    placeMission(state, dropped)
    for (let i = 0; i < 10; i++) stepMission(state, LEVEL, dropped, FIXED_DT)
    expect(state.course.passed[0]).toBe(false)

    // Out of the sphere...
    const out = v3(
      ring1.centre.x - (dx / len) * 300,
      ring1.centre.y,
      ring1.centre.z - (dz / len) * 300,
    )
    let at = flyLeg(state, LEVEL, dropped, out, 200)
    expect(state.course.passed[0]).toBe(false)
    // ...and back through it. That is flying through a ring, and it counts.
    at = flyLeg(state, LEVEL, at, ring1.centre, 200)
    expect(state.course.passed[0]).toBe(true)
    expect(state.ringsPassed).toBe(1)
    expect(state.score).toBe(100)
    expect(at).toBeDefined()
  })
})

describe('DEV-149: and the racers fly under the same rule', () => {
  it('a racer put back inside a ring is IN it, not through it', () => {
    // `afterRacerReset`'s seed, observed in the running racer rather than
    // argued about. Really flown: `createAiRacer` off the 2016 left AI pad,
    // `stepAiRacer` with the REAL `int_01` gates and the REAL authored guide,
    // rings taken by flying through them, and a real contact against a real
    // height field reporting a real impact speed.
    //
    // A racer only ever flies FORWARD, so since DEV-289 its reset can no
    // longer land in a ring it still owes — it is always at least
    // `resetBackMetres` of arc behind the one it is flying to, and no shipped
    // course has gates closer together than that (`adv_01`'s tightest pair is
    // 360.8 m). The scoring consequence this test used to end on is therefore
    // unreachable for a racer, and the test now ends on the seed's own
    // contract instead: after a teleport, what the course thinks it is inside
    // is what it IS inside. That is what `stepCourse` reads on the next tick,
    // and it is what a folding line — the case `limitS` exists for — would
    // still turn back into a free ring.
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
    // Fly it until it is INSIDE ring 2 — flown through, not placed there — and
    // crash it while it is standing in the sphere. That is the premise: the
    // flags say "in a ring" at the moment the ship is taken somewhere else.
    for (let i = 0; i < 8000 && !racer.course.inside[1]; i++) {
      stepAiRacer(racer, GATES, [], FIXED_DT, guide)
    }
    expect(racer.course.inside[1], 'the racer never reached ring 2 — check the run-up').toBe(true)
    expect(racer.course.passed[1]).toBe(true)
    const insideAtCrash = [...racer.course.inside]
    const gatesBefore = racer.gates

    // Into the ground, hard.
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

    // Where the reset actually put it, worked out from the geometry rather
    // than asked of the course.
    const at = racer.crash.reset.position
    const containing = GATES.map((g) => dist(at, g.centre) <= g.radius)
    // The premise, asserted: the ship is somewhere ELSE now, so leaving the
    // flags alone and recomputing them are two different answers. Without this
    // the test could pass by comparing something with itself.
    expect(
      containing,
      'the reset did not move it out of ring 2 — the seed is unobservable here',
    ).not.toEqual(insideAtCrash)
    // The seed's whole contract, as a relationship: what the course thinks it
    // is inside is what it IS inside. Neuter `seedCourse` and ring 2's flag
    // comes back from the wreck, still set.
    expect(racer.course.inside).toEqual(containing)
    // And the crash paid nothing either way.
    expect(racer.gates).toBe(gatesBefore)
  })
})
