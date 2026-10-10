// tests/unit/instructor.test.ts — the flight instructor in the sim. DEV-376.
//
// Matt, 2026-09-24: *"want to learn to fly - add an ai-pilot flight instructor
// course through the canyon"*. `docs/plan/FLIGHT-INSTRUCTOR.md` §4 and §9.
//
// Every property is measured against something OUTSIDE the rule: the racing
// line (the gap, the distance off it), the student's own position (which way
// the nose points), a second run (determinism), a racer flown without the
// instructor in the air (trap 19), and a plain racer (the pace that asks for
// nothing). None compares the pace law with a re-derivation of itself.
//
// Headless on `rookie_02_hoverJet`'s real course and racing line, the lesson's
// course, with no terrain: the terrain changes where a ship can fly, not
// whether the instructor keeps its lead or waits. The real desert field is in
// the DEV-376 ledger row as a measurement (both canyon courses, zero crashes,
// every ring), because a unit test that needs the gitignored maps would skip on
// CI. The one rule that reads the ground — which side of the line to hover on
// — is tested here against a wall of its own.
//
// The student is flown KINEMATICALLY: an arc length that advances at a stated
// speed, and a body put on the line there. That is the one input the pace law
// reads (DEV-377's runner measures a real player's arc with `raceProgress`),
// and it is exact, so a band stated here is the instructor's error alone.
//
// The spec is the plan's §6.2 block, its first guesses. Every assertion is made
// relative to the spec's own numbers, so a playtest that retunes them does not
// turn this file red.

import { describe, expect, it } from 'vitest'
import { type Edition, validateEdition } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import { courseGates } from '@/game/mission'
import {
  AI_RACER_TUNINGS,
  type AiRacer,
  createAiRacer,
  gateArcLengths,
  seedRacerAt,
  stepAiRacer,
} from '@/sim/ai-racer'
import { autopilotActions } from '@/sim/autopilot'
import { FIXED_DT } from '@/sim/constants'
import { createHoverJet, type HoverJet, noInput, stepHoverJet } from '@/sim/hoverjet'
import {
  createInstructorPace,
  type InstructorPace,
  type InstructorPaceSpec,
  latchHold,
  paceTuning,
  stepInstructorMode,
} from '@/sim/instructor'
import { rotateVec3 } from '@/sim/math/quat'
import { v3 } from '@/sim/math/vec3'
import { createRacerField, type RacerFieldRules, stepRacerField } from '@/sim/racer-field'
import {
  createRoute,
  routeArcLengthNear,
  routeAt,
  routeDistance,
  routeRightAt,
  routeTangentAt,
} from '@/sim/route'
import { type HeightField, outsideField, terrainHeightAt } from '@/sim/terrain/height-field'
import anniversaryJson from '../../content/editions/anniversary.json'
import rookie02 from '../../content/levels/rookie_02_hoverJet.json'

const ANNIVERSARY: Edition = validateEdition(anniversaryJson as unknown as Edition)
const LEVEL = rookie02 as unknown as Level
const GATES = courseGates(LEVEL)
const ROUTE = createRoute((rookie02 as unknown as { route: number[][] }).route)
const GUIDE = { route: ROUTE, gateArc: gateArcLengths(ROUTE, GATES) }
const STEADY = AI_RACER_TUNINGS.steady as (typeof AI_RACER_TUNINGS)[string]
/** A copy taken before any instructor has flown, for trap 19's last check. */
const STEADY_AT_LOAD = { ...STEADY }

/** FLIGHT-INSTRUCTOR §6.2's `lesson.instructor` block, the plan's first guesses. */
const SPEC: InstructorPaceSpec = {
  leadMetres: 90,
  gain: 0.5,
  waitBeyondMetres: 400,
  resumeWithinMetres: 150,
  holdAsideMetres: 40,
  maxSpeed: 55,
  boost: false,
  race: false,
}

const ticks = (seconds: number): number => Math.round(seconds / FIXED_DT)

/** An instructor on the line at arc `s`, flying down it at `speed`. */
const instructorAt = (
  s: number,
  speed: number,
  spec: InstructorPaceSpec = SPEC,
): { racer: AiRacer; pace: InstructorPace } => {
  const pace = createInstructorPace(spec, STEADY)
  const racer = createAiRacer(
    { id: 'instructor', spawn: v3(), orientation: [0, 0, 0, 1], tuning: STEADY },
    GATES,
    null,
    pace,
  )
  seedRacerAt(racer, GUIDE, s, speed)
  return { racer, pace }
}

/** The student: an arc on the line, and a body put there, flying along it. */
const studentAt = (arc: number) => {
  const jet = createHoverJet()
  jet.launched = true
  const st = { arc, speed: 0, held: false, jet }
  place(st)
  return st
}
type Student = ReturnType<typeof studentAt>
const _dir = v3()
const place = (st: Student): void => {
  routeAt(ROUTE, st.arc, st.jet.body.position)
  routeTangentAt(ROUTE, st.arc, _dir)
  st.jet.body.velocity.x = _dir.x * st.speed
  st.jet.body.velocity.y = _dir.y * st.speed
  st.jet.body.velocity.z = _dir.z * st.speed
}
const moveStudent = (st: Student, speed: number): void => {
  st.speed = speed
  st.arc += speed * FIXED_DT
  place(st)
}

/** No DEV-364 rule: the pace law alone. */
const NO_RULES = { separation: null, contact: null, player: null } as const

/** One tick of the instructor's field, with the student read in. */
const stepField = (
  field: ReturnType<typeof createRacerField>,
  racer: AiRacer,
  st: Student,
  rules: Omit<RacerFieldRules, 'student'> = NO_RULES,
  crash: Edition['gameplay']['crash'] | null = null,
): void =>
  stepRacerField(field, [racer], GATES, [], FIXED_DT, GUIDE, [], crash, null, {
    ...rules,
    student: { arc: st.arc, speed: st.speed, position: st.jet.body.position, held: st.held },
  })

const speedOf = (jet: HoverJet): number =>
  Math.hypot(jet.body.velocity.x, jet.body.velocity.y, jet.body.velocity.z)

/** Degrees between the ship's nose and the direction to `to`. */
const noseOff = (jet: HoverJet, to: { x: number; y: number; z: number }): number => {
  const fwd = rotateVec3(v3(), jet.body.orientation, v3(0, 0, 1))
  const p = jet.body.position
  const dx = to.x - p.x
  const dy = to.y - p.y
  const dz = to.z - p.z
  const cos = (fwd.x * dx + fwd.y * dy + fwd.z * dz) / Math.hypot(dx, dy, dz)
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI
}

describe('the pace law: it leads by leadMetres', () => {
  it('holds the lead within 5 m of a student flying at 20, 35 and 50 m/s', () => {
    for (const v of [20, 35, 50]) {
      const s0 = (GUIDE.gateArc[1] as number) + 100
      const { racer, pace } = instructorAt(s0 + SPEC.leadMetres, v)
      const st = studentAt(s0)
      const field = createRacerField([racer], ROUTE)
      let lo = Number.POSITIVE_INFINITY
      let hi = Number.NEGATIVE_INFINITY
      let held = 0
      for (let t = 0; t < ticks(60); t++) {
        moveStudent(st, v)
        stepField(field, racer, st)
        if (pace.mode === 'hold') held++
        // After the first ten seconds: the start is a seed, not a lead.
        if (t < ticks(10)) continue
        lo = Math.min(lo, pace.gap)
        hi = Math.max(hi, pace.gap)
      }
      expect(held, `${v} m/s: never waits for a student who keeps coming`).toBe(0)
      expect(lo, `${v} m/s: closest ${lo.toFixed(2)} m`).toBeGreaterThan(SPEC.leadMetres - 5)
      expect(hi, `${v} m/s: furthest ${hi.toFixed(2)} m`).toBeLessThan(SPEC.leadMetres + 5)
      // And it got somewhere: it is a lead, not a hover that the student
      // happens to be 90 m from.
      expect(racer.gates).toBeGreaterThan(0)
    }
  })

  it('the throttle ceiling makes the target the terminal speed; the band alone does not', () => {
    // A HoverJet flown straight at a target speed, 30 s. With the ceiling it
    // settles AT the target. Handed only `targetSpeed`, the proportional band
    // settles well over it — 21 m/s when asked for 0 — which is why the pace
    // law needs both (`paceTuning`'s header has the arithmetic).
    const settle = (target: number, ceiling: boolean): number => {
      const jet = createHoverJet()
      jet.launched = true
      const pace = createInstructorPace(SPEC, STEADY)
      const input = noInput()
      const aim = v3()
      for (let t = 0; t < ticks(30); t++) {
        aim.x = jet.body.position.x
        aim.y = jet.body.position.y
        aim.z = jet.body.position.z + 1000
        const tuning = ceiling ? paceTuning(pace, STEADY, jet, target) : STEADY
        autopilotActions(jet.body, aim, input, tuning, [], Number.POSITIVE_INFINITY, null, target)
        stepHoverJet(jet, input, FIXED_DT)
      }
      return speedOf(jet)
    }
    for (const target of [0, 20, 55]) {
      expect(Math.abs(settle(target, true) - target), `ceiling, ${target}`).toBeLessThan(0.5)
    }
    // The control: without the ceiling it cannot even stop.
    expect(settle(0, false)).toBeGreaterThan(15)
    expect(settle(55, false) - 55).toBeGreaterThan(5)
  })
})

describe('HOLD: it waits for a student who stops, and goes again', () => {
  /**
   * The student flies 8 s at 40 m/s, stops dead for 35 s, and flies on at 40.
   * It stops 30 m past ring 3, so the ring it is making for is ring 4, ~470 m
   * on — and it restarts well outside the resume distance, which is the case
   * that separates "resume when close" from "resume when moving".
   * Returns what the instructor did, sampled where each property is asserted.
   */
  const stopAndGo = (
    rules: Omit<RacerFieldRules, 'student'> = NO_RULES,
    crash: Edition['gameplay']['crash'] | null = null,
    record: number[][] | null = null,
  ) => {
    const s0 = (GUIDE.gateArc[3] as number) + 30 - 40 * 8
    const { racer, pace } = instructorAt(s0 + SPEC.leadMetres, 40)
    const st = studentAt(s0)
    const field = createRacerField([racer], ROUTE)
    const out = {
      holdFrom: -1,
      holdLeftAt: -1,
      holdLeftGap: 0,
      gapAtRestart: 0,
      holdRing: -1,
      studentRing: -1,
      atRest: { speed: 0, offLine: 0, arc: 0, nose: 0, settled: false },
      stillHeldAtRestart: false,
      gapAfter: [] as number[],
      holdTicks: 0,
      leadTicks: 0,
    }
    for (let t = 0; t < ticks(80); t++) {
      const time = t * FIXED_DT
      const moving = time < 8 || time >= 43
      moveStudent(st, moving ? 40 : 0)
      stepField(field, racer, st, { ...rules, player: rules.player ? st.jet.body : null }, crash)
      if (pace.mode === 'hold') out.holdTicks++
      else out.leadTicks++
      if (out.holdFrom < 0 && pace.mode === 'hold') {
        out.holdFrom = time
        out.holdRing = pace.holdRing
        // The ring the student is making for: the first whose far side its
        // arc has not reached, read off the course, not off the instructor.
        out.studentRing = GATES.findIndex(
          (g, i) => (GUIDE.gateArc[i] as number) + g.radius > st.arc,
        )
      }
      // At rest: the last tick of the stop.
      if (t === ticks(43) - 1) {
        const b = racer.jet.body
        out.atRest = {
          speed: speedOf(racer.jet),
          offLine: routeDistance(ROUTE, b.position),
          arc: routeArcLengthNear(ROUTE, b.position),
          nose: noseOff(racer.jet, st.jet.body.position),
          settled: pace.settled,
        }
        out.stillHeldAtRestart = pace.mode === 'hold'
        out.gapAtRestart = pace.gap
      }
      if (out.holdFrom >= 0 && out.holdLeftAt < 0 && pace.mode === 'lead') {
        out.holdLeftAt = time
        out.holdLeftGap = pace.gap
      }
      if (out.holdLeftAt >= 0) out.gapAfter.push(pace.gap)
      if (record) {
        const b = racer.jet.body
        record.push([
          b.position.x,
          b.position.y,
          b.position.z,
          b.velocity.x,
          b.velocity.y,
          b.velocity.z,
          b.orientation.x,
          b.orientation.y,
          b.orientation.z,
          b.orientation.w,
          pace.mode === 'hold' ? 1 : 0,
          pace.holdAt.x,
          pace.holdAt.z,
        ])
      }
    }
    return { out, racer }
  }

  it('comes to rest holdAsideMetres off the line, past the ring, nose toward the student', () => {
    const { out } = stopAndGo()
    // It waits as soon as the student stops: the pace law asks for nothing.
    expect(out.holdFrom).toBeGreaterThanOrEqual(8)
    expect(out.holdFrom).toBeLessThan(9)
    // Beside the ring the STUDENT is making for.
    expect(out.holdRing).toBe(out.studentRing)
    // At rest, and it stayed waiting the whole stop.
    expect(out.stillHeldAtRestart).toBe(true)
    expect(out.atRest.settled).toBe(true)
    expect(out.atRest.speed).toBeLessThan(0.5)
    // OFF the line by its hover offset — a hull either way — not on it.
    expect(Math.abs(out.atRest.offLine - SPEC.holdAsideMetres)).toBeLessThan(4)
    // PAST the ring it waits beside, measured from where the ship IS.
    expect(out.atRest.arc).toBeGreaterThan(GUIDE.gateArc[out.holdRing] as number)
    // And facing the student.
    expect(out.atRest.nose, `nose ${out.atRest.nose.toFixed(1)} deg off`).toBeLessThan(10)
  })

  it('goes again only once the student is inside resumeWithinMetres, and leads from ahead', () => {
    const { out } = stopAndGo()
    // The premise: the student restarts (43 s) from OUTSIDE the resume
    // distance, so moving is not enough on its own.
    expect(out.gapAtRestart).toBeGreaterThan(SPEC.resumeWithinMetres)
    // Not while the student sat still, and not the moment it moved …
    expect(out.holdLeftAt).toBeGreaterThan(43 + 1)
    // … but once it was inside the resume distance.
    expect(out.holdLeftGap).toBeLessThan(SPEC.resumeWithinMetres)
    expect(out.holdLeftGap).toBeGreaterThan(0)
    // It moves off AHEAD — never lets the student past — and is back on its
    // lead within fifteen seconds.
    expect(Math.min(...out.gapAfter)).toBeGreaterThan(0)
    const settled = out.gapAfter.slice(ticks(15))
    expect(Math.abs((settled[settled.length - 1] as number) - SPEC.leadMetres)).toBeLessThan(5)
  })

  it('the three ways in, and the one way out', () => {
    const pace = createInstructorPace(SPEC, STEADY)
    const read = (arc: number, speed: number, held: boolean) => {
      pace.student.arc = arc
      pace.student.speed = speed
      pace.student.held = held
    }
    const lead = () => {
      pace.mode = 'lead'
    }
    // Leading a student at 40, on the lead: it leads.
    lead()
    read(1000, 40, false)
    expect(stepInstructorMode(pace, 1000 + SPEC.leadMetres)).toBe(false)
    expect(pace.mode).toBe('lead')
    // 1. The lesson holds the student (a crash, the lift, an interrupt): it
    //    waits, however close.
    read(1000, 40, true)
    expect(stepInstructorMode(pace, 1000 + SPEC.leadMetres)).toBe(true)
    // 2. Further than `waitBeyondMetres` — a student going somewhere the line
    //    does not: fast, but its arc is left behind.
    lead()
    read(1000, 200, false)
    expect(stepInstructorMode(pace, 1000 + SPEC.waitBeyondMetres + 1)).toBe(true)
    // 3. The pace law asks for nothing: a stopped student, at the lead.
    lead()
    read(1000, 0, false)
    expect(stepInstructorMode(pace, 1000 + SPEC.leadMetres)).toBe(true)
    // Out: inside the resume distance, free, and coming on — not before.
    read(1000, 0, false)
    stepInstructorMode(pace, 1000 + SPEC.resumeWithinMetres - 1)
    expect(pace.mode, 'inside the distance but stopped').toBe('hold')
    read(1000, 40, true)
    stepInstructorMode(pace, 1000 + SPEC.resumeWithinMetres - 1)
    expect(pace.mode, 'coming on but held').toBe('hold')
    read(1000, 200, false)
    stepInstructorMode(pace, 1000 + SPEC.resumeWithinMetres + 1)
    expect(pace.mode, 'coming on fast, but further than the resume distance').toBe('hold')
    read(1000, 40, false)
    stepInstructorMode(pace, 1000 + SPEC.resumeWithinMetres - 1)
    expect(pace.mode).toBe('lead')
    // And `race` waits for nobody.
    pace.spec = { ...SPEC, race: true }
    read(1000, 0, true)
    expect(stepInstructorMode(pace, 1000 + SPEC.waitBeyondMetres * 2)).toBe(false)
    expect(pace.mode).toBe('lead')
  })

  it('the same inputs give the same flight, to the bit, twice — Anniversary rules on', () => {
    const run = () => {
      const record: number[][] = []
      const rules = {
        separation: ANNIVERSARY.gameplay.racers.separation,
        contact: ANNIVERSARY.gameplay.racers.contact,
        // Filled with the student's body by `stopAndGo`.
        player: createHoverJet().body,
      }
      const { out } = stopAndGo(rules, ANNIVERSARY.gameplay.crash, record)
      return { out, record }
    }
    const one = run()
    const two = run()
    // Both halves were flown, or this proves nothing about either.
    expect(one.out.holdTicks).toBeGreaterThan(ticks(10))
    expect(one.out.leadTicks).toBeGreaterThan(ticks(10))
    expect(two.record).toEqual(one.record)
  })
})

describe('it hovers BESIDE the ring, on the side with air under it', () => {
  // A mesa, 30 m proud of the line, filling the ground to one side of ring 6's
  // exit. Closed-form, the way `pad-surface.ts` builds a landing pad, so the
  // test owns every metre of it.
  const RING = 6
  const exitArc = (GUIDE.gateArc[RING] as number) + (GATES[RING]?.radius as number)
  const foot = routeAt(ROUTE, exitArc, v3())
  const right = routeRightAt(ROUTE, exitArc, v3())
  const mesa = (side: number): HeightField => {
    const cx = foot.x + right.x * SPEC.holdAsideMetres * side
    const cz = foot.z + right.z * SPEC.holdAsideMetres * side
    const r = SPEC.holdAsideMetres / 2
    return {
      analytic: {
        inside: (x, z) => Math.hypot(x - cx, z - cz) <= r,
        heightAt: () => foot.y + 30,
        normalStep: 1,
      },
      vertPerSide: 1,
      heights: new Float32Array(1),
      step: r,
      terrainSize: r * 2,
      terrainHeight: 0,
      originX: cx - r,
      originY: foot.y,
      originZ: cz - r,
      scaleX: 1,
      scaleY: 1,
      scaleZ: 1,
    }
  }
  /** Latch a hold for a student short of ring 6, instructor just past its exit. */
  const latch = (fields: readonly HeightField[]) => {
    const pace = createInstructorPace(SPEC, STEADY)
    pace.student.arc = (GUIDE.gateArc[RING] as number) - 60
    latchHold(pace, ROUTE, GATES, GUIDE.gateArc, exitArc + 10, fields)
    return pace
  }
  const buried = (pace: InstructorPace, field: HeightField): boolean =>
    !outsideField(field, pace.holdAt.x, pace.holdAt.z) &&
    pace.holdAt.y < terrainHeightAt(field, pace.holdAt.x, pace.holdAt.z)

  it('a wall on the right puts it on the left, and the reverse; never inside either', () => {
    for (const side of [1, -1]) {
      const wall = mesa(side)
      const pace = latch([wall])
      expect(pace.holdRing).toBe(RING)
      expect(pace.holdSide).toBe(-side)
      expect(buried(pace, wall)).toBe(false)
      // Beside the ring's exit and off the line by exactly the offset: the
      // geometry, not the latched numbers.
      expect(Math.hypot(pace.holdAt.x - foot.x, pace.holdAt.z - foot.z)).toBeCloseTo(
        SPEC.holdAsideMetres,
        6,
      )
      expect(routeDistance(ROUTE, pace.holdAt)).toBeGreaterThan(SPEC.holdAsideMetres - 1)
    }
    // The control: each wall really does bury the side it stands on.
    for (const side of [1, -1]) {
      const wall = mesa(side)
      const p = v3(
        foot.x + right.x * SPEC.holdAsideMetres * side,
        foot.y,
        foot.z + right.z * SPEC.holdAsideMetres * side,
      )
      expect(p.y).toBeLessThan(terrainHeightAt(wall, p.x, p.z))
    }
  })
})

describe('trap 19: an instructor and a racer share nothing', () => {
  it('stepping an instructor between a racer’s steps moves neither, both on `steady`', () => {
    // The instructor's tuning is a COPY with a ceiling written into it every
    // tick; the racer flies the SAME `steady` object. A ceiling written into the
    // shared tuning, or a field of `_input` the hold branch left set, would
    // reach the racer stepped after it.
    const s0 = (GUIDE.gateArc[3] as number) + 20
    const racerAlone = () => {
      const r = createAiRacer(
        { id: 'steady', spawn: v3(), orientation: [0, 0, 0, 1], tuning: STEADY },
        GATES,
      )
      seedRacerAt(r, GUIDE, s0, 60)
      return r
    }
    const flyInstructor = (withRacer: AiRacer | null) => {
      const { racer, pace } = instructorAt(s0 + 300, 40)
      const st = studentAt(s0 + 300 - SPEC.leadMetres)
      const field = createRacerField([racer], ROUTE)
      for (let t = 0; t < ticks(30); t++) {
        // The student stops at 5 s, so the instructor spends most of this in
        // HOLD — the branch that writes the airbrake.
        moveStudent(st, t * FIXED_DT < 5 ? 40 : 0)
        stepField(field, racer, st)
        if (withRacer) stepAiRacer(withRacer, GATES, [], FIXED_DT, GUIDE)
      }
      return { racer, pace }
    }
    const state = (r: AiRacer) => [
      r.jet.body.position,
      r.jet.body.velocity,
      r.jet.body.orientation,
      r.jet.body.angularVelocity,
    ]
    // The racer, alone and with the instructor stepped before each of its steps.
    const alone = racerAlone()
    for (let t = 0; t < ticks(30); t++) stepAiRacer(alone, GATES, [], FIXED_DT, GUIDE)
    const accompanied = racerAlone()
    const withIt = flyInstructor(accompanied)
    expect(state(accompanied)).toEqual(state(alone))
    // The instructor, alone and with the racer stepped after each of its steps.
    expect(state(withIt.racer)).toEqual(state(flyInstructor(null).racer))
    // The hold branch ran, or this proves nothing about it.
    expect(withIt.pace.settled).toBe(true)
    // And the shared tuning is the table's own numbers, as this file found them.
    expect(STEADY).toEqual(STEADY_AT_LOAD)
  })
})

describe('a racer is a racer', () => {
  it('an instructor told to race with no cap and its own boost flies exactly as a racer', () => {
    // A pace that asks for nothing — race, an infinite cap, the tuning's own
    // boost — hands `autopilotActions` the values a racer hands it. So the two
    // must fly one path to the bit. Red if the paced path adds anything a
    // racer does not have, or if the racer's path stops being the default.
    const spec: InstructorPaceSpec = {
      ...SPEC,
      race: true,
      maxSpeed: Number.POSITIVE_INFINITY,
      boost: STEADY.boost,
    }
    const s0 = (GUIDE.gateArc[4] as number) + 30
    const { racer: paced } = instructorAt(s0, 60, spec)
    const plain = createAiRacer(
      { id: 'steady', spawn: v3(), orientation: [0, 0, 0, 1], tuning: STEADY },
      GATES,
    )
    seedRacerAt(plain, GUIDE, s0, 60)
    const st = studentAt(0)
    const pacedField = createRacerField([paced], ROUTE)
    const plainField = createRacerField([plain], ROUTE)
    for (let t = 0; t < ticks(60); t++) {
      stepField(pacedField, paced, st)
      stepRacerField(plainField, [plain], GATES, [], FIXED_DT, GUIDE, [], null, null, NO_RULES)
    }
    expect(plain.gates).toBeGreaterThan(3)
    expect([paced.jet.body.position, paced.jet.body.velocity, paced.gates]).toEqual([
      plain.jet.body.position,
      plain.jet.body.velocity,
      plain.gates,
    ])
  })
})
