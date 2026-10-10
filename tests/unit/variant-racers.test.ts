// tests/unit/variant-racers.test.ts — the racers, and the instructor, fly the
// race's view of the sheet. DEV-382.
//
// docs/plan/AIRCRAFT-VARIANTS.md §6.4, and Matt's answer to its open call 3:
// the racers fly YOUR variant, so a race is between the same machines. The
// view is handed to each racer on its spec (`AiRacerSpec.sheet`), which
// `game/racers.ts` fills from the player's own jet; the e2e walk
// (`variant-step.spec.ts`) reads the racers' tuning back off the live page.
//
// What lives here is the sim half, and the three reads DEV-380 deferred to this
// row: `SEED_SPEED` in `sim/ai-racer.ts`, and the instructor's
// `derived.hoverjet.terminalSpeedCruise` and `thrustNewtons`. Each was a hidden
// standard: 2016's cruise, whatever the racer was flying.
//
// Every expectation is measured against a FLIGHT rather than against the
// formula the code uses (trap 24): a seeded racer is already at the speed its
// own jet settles at, and an instructor asked for 55 m/s settles at 55 m/s.
//
// The fixture view scales thrust AND drag, because the old reads were linear in
// thrust and blind to drag: a view that moved only `ship.maxSpeed` would have
// let the instructor's thrust-scaled 2016 terminal pass by accident.

import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import { aircraftFor } from '@/content/load-aircraft'
import { courseGates } from '@/game/mission'
import { DERIVED, HOVERJET } from '@/generated/constants.generated'
import {
  AI_RACER_TUNINGS,
  createAiRacer,
  gateArcLengths,
  RING_APPROACH_ENVELOPE,
  seedRacerAt,
  seedSpeed,
  stepAiRacer,
} from '@/sim/ai-racer'
import { autopilotActions } from '@/sim/autopilot'
import { FIXED_DT } from '@/sim/constants'
import {
  createHoverJet,
  cruiseSpeed,
  type HoverJet,
  type HoverJetSheet,
  hoverJetView,
  noInput,
  stepHoverJet,
} from '@/sim/hoverjet'
import { createInstructorPace, type InstructorPaceSpec, paceTuning } from '@/sim/instructor'
import { v3 } from '@/sim/math/vec3'
import { createRoute } from '@/sim/route'

/** A view that moves thrust, drag and roll together. Not a shipped variant. */
const FIXTURE: HoverJetSheet = hoverJetView({
  'ship.maxSpeed': 1.2,
  'rigidbody.drag': 0.8,
  'ship.rollRate': 1.8,
})

const STEADY = AI_RACER_TUNINGS.steady as (typeof AI_RACER_TUNINGS)[string]

const ticks = (seconds: number): number => Math.round(seconds / FIXED_DT)
const speedOf = (jet: HoverJet): number =>
  Math.hypot(jet.body.velocity.x, jet.body.velocity.y, jet.body.velocity.z)

/** Full throttle, no boost, stick centred, for `seconds`. The body flies straight. */
const flyFlat = (jet: HoverJet, seconds: number): number => {
  const input = noInput()
  input.throttle = 1
  for (let t = 0; t < ticks(seconds); t++) stepHoverJet(jet, input, FIXED_DT)
  return speedOf(jet)
}

const racerOn = (sheet: HoverJetSheet | undefined) =>
  createAiRacer(
    { id: 'r', spawn: v3(), orientation: [0, 0, 0, 1], tuning: STEADY, sheet },
    [],
    null,
  )

describe("a HoverJet's cruise is read off ITS sheet", () => {
  it('is where the jet settles, flown, on 2016 and on a view', () => {
    for (const sheet of [HOVERJET as HoverJetSheet, FIXTURE]) {
      const jet = createHoverJet(sheet)
      jet.launched = true
      const flown = flyFlat(jet, 40)
      expect(Math.abs(flown - cruiseSpeed(sheet)) / flown).toBeLessThan(1e-9)
    }
  })

  it("is the sheet's own derived row on 2016's sheet, unrounded", () => {
    // The sheet prints four places; the ship reaches the unrounded figure.
    expect(cruiseSpeed(HOVERJET)).toBeCloseTo(DERIVED.hoverjet.terminalSpeedCruise, 4)
  })

  it('moves with thrust AND drag, which a thrust-scaled 2016 terminal cannot', () => {
    const thrustOnly = DERIVED.hoverjet.terminalSpeedCruise * 1.2
    // The fixture's drag x 0.8 buys about 25 % on top of its thrust.
    expect(cruiseSpeed(FIXTURE) / thrustOnly).toBeGreaterThan(1.2)
  })
})

describe('a racer flies the view on its spec', () => {
  it('builds its jet from the view, and a reset from its spec keeps it', () => {
    const racer = racerOn(FIXTURE)
    expect(racer.jet.sheet).toBe(FIXTURE)
    expect(racer.jet.tuning.rollRate).toBeCloseTo(HOVERJET.ship.rollRate * 1.8, 12)
    expect(racer.jet.tuning.maxSpeed).toBeCloseTo(HOVERJET.ship.maxSpeed * 1.2, 12)
    expect(racer.jet.body.drag).toBeCloseTo(HOVERJET.rigidbody.drag * 0.8, 12)
    // `game/racers.ts`'s `reset` rebuilds a racer with `createAiRacer(spec, …)`.
    const reset = createAiRacer(racer.spec, [], null)
    expect(reset.jet.sheet).toBe(FIXTURE)
  })

  it('flies 2016 with no view, and one racer on a view moves no other (trap 19)', () => {
    const viewed = racerOn(FIXTURE)
    const plain = racerOn(undefined)
    expect(plain.jet.sheet).toBe(HOVERJET)
    expect(plain.jet.tuning.rollRate).toBe(HOVERJET.ship.rollRate)
    expect(viewed.jet.tuning.rollRate).not.toBe(plain.jet.tuning.rollRate)
  })

  it('is seeded at the speed its OWN jet settles at, on 2016 and on a view', () => {
    // A straight line along +z, long enough to fly 40 s down.
    const guide = {
      route: createRoute([
        [0, 500, 0],
        [0, 500, 20_000],
      ]),
      gateArc: [] as number[],
    }
    for (const sheet of [undefined, FIXTURE]) {
      const racer = racerOn(sheet)
      seedRacerAt(racer, guide, 100)
      const seeded = speedOf(racer.jet)
      expect(seeded).toBe(seedSpeed(racer.jet))
      // Flown on from the seed, it neither gains nor loses: the seed was
      // already this machine's cruise. `SEED_SPEED` (2016's cruise) put a
      // view racer 25 % under its own and spooled it up from there.
      const settled = flyFlat(racer.jet, 40)
      expect(Math.abs(settled - seeded) / settled).toBeLessThan(1e-9)
    }
  })
})

describe("the instructor's throttle ceiling follows its jet's view", () => {
  /** FLIGHT-INSTRUCTOR §6.2's block; only `boost: false` matters here. */
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

  /** `instructor.test.ts`'s settle, on a jet built from `sheet`. */
  const settle = (sheet: HoverJetSheet, target: number): number => {
    const jet = createHoverJet(sheet)
    jet.launched = true
    const pace = createInstructorPace(SPEC, STEADY)
    const input = noInput()
    const aim = v3()
    for (let t = 0; t < ticks(30); t++) {
      aim.x = jet.body.position.x
      aim.y = jet.body.position.y
      aim.z = jet.body.position.z + 1000
      const tuning = paceTuning(pace, STEADY, jet, target)
      autopilotActions(jet.body, aim, input, tuning, [], Number.POSITIVE_INFINITY, null, target)
      stepHoverJet(jet, input, FIXED_DT)
    }
    return speedOf(jet)
  }

  it('settles AT its target on a view, as it does on 2016', () => {
    for (const target of [20, 55]) {
      expect(Math.abs(settle(HOVERJET, target) - target), `2016, ${target}`).toBeLessThan(0.5)
      // Read off 2016's derived row, the ceiling is T / 107.8 on a jet whose
      // cruise is 135.1, and it settles at 1.25 T: 69 m/s asked for 55.
      expect(Math.abs(settle(FIXTURE, target) - target), `view, ${target}`).toBeLessThan(0.5)
    }
  })
})

// ── A racer on a jet faster than its controller (DEV-382 follow-up) ──────────
//
// DEV-381 found the racers could not fly the speed jet: rings missed at
// 300 m/s, and a missed LAST ring orbited for ever. `sim/ai-racer.ts` now
// recovers a missed ring at the jet's cruise, and closes on a ring no faster
// than `RING_APPROACH_ENVELOPE`, 2016's boosted terminal, when its jet can
// exceed it. `variant-fairness.test.ts` holds the outcome (every racer, every
// variant, every Ring Attack course, finishes); these hold the two rules.

describe('a racer on the speed jet', () => {
  const INT01 = JSON.parse(fs.readFileSync('content/levels/int_01_hoverJet.json', 'utf8')) as Level
  const GATES = courseGates(INT01)
  const ROUTE = createRoute((INT01 as unknown as { route: number[][] }).route)
  const GUIDE = { route: ROUTE, gateArc: gateArcLengths(ROUTE, GATES) }
  const FAST = AI_RACER_TUNINGS.fast as (typeof AI_RACER_TUNINGS)[string]
  const viewOf = (id: string): HoverJetSheet | null => {
    const v = aircraftFor('hoverjet').variants.find((x) => x.id === id)
    return v ? hoverJetView(v.scale) : null
  }
  const SPEED = viewOf('speed') as HoverJetSheet

  /** Full throttle and boost, 40 s: where a jet on `sheet` settles. */
  const top = (sheet: HoverJetSheet): number => {
    const jet = createHoverJet(sheet)
    jet.launched = true
    const input = noInput()
    input.throttle = 1
    input.boost = true
    for (let t = 0; t < ticks(40); t++) stepHoverJet(jet, input, FIXED_DT)
    return speedOf(jet)
  }

  it('is a jet that can out-run the envelope, which 2016 and the acrobat cannot', () => {
    // The premise of both rules, measured by flying rather than restated.
    expect(SPEED).not.toBeNull()
    expect(Math.abs(top(HOVERJET) - RING_APPROACH_ENVELOPE)).toBeLessThan(1e-6)
    expect(top(SPEED)).toBeGreaterThan(RING_APPROACH_ENVELOPE * 1.5)
    const acrobat = viewOf('acrobat')
    if (acrobat) expect(top(acrobat)).toBeLessThan(RING_APPROACH_ENVELOPE)
  })

  it('crosses every ring it takes near the envelope, not at its own 323 m/s', () => {
    const racer = createAiRacer(
      { id: 'fast', spawn: v3(), orientation: [0, 0, 0, 1], tuning: FAST, sheet: SPEED },
      GATES,
      null,
    )
    // Seeded ON ring 0's arc, which counts it as passed: the rest are flown.
    seedRacerAt(racer, GUIDE, 0)
    const seeded = racer.gates
    const atRing: number[] = []
    for (let t = 0; t < ticks(120) && racer.gates < GATES.length; t++) {
      const before = racer.gates
      stepAiRacer(racer, GATES, [], FIXED_DT, GUIDE)
      if (racer.gates > before) atRing.push(speedOf(racer.jet))
    }
    const worst = Math.max(...atRing)
    console.log(
      `speed jet, fast, int_01: ${atRing.length} rings, fastest at a ring ${worst.toFixed(1)} m/s`,
    )
    expect(racer.gates, 'it takes every ring').toBe(GATES.length)
    expect(atRing.length).toBe(GATES.length - seeded)
    // One proportional band over it at most: the controller's own.
    expect(worst).toBeLessThan(RING_APPROACH_ENVELOPE + FAST.profileBand)
  })

  it('recovers a missed ring at its cruise, not with boost held', () => {
    // On the line 150 m past ring 6, owing it: a miss.
    const racer = createAiRacer(
      { id: 'fast', spawn: v3(), orientation: [0, 0, 0, 1], tuning: FAST, sheet: SPEED },
      GATES,
      null,
    )
    const missed = 6
    seedRacerAt(racer, GUIDE, (GUIDE.gateArc[missed] as number) + 150)
    racer.course.passed[missed] = false
    racer.course.passedCount -= 1
    racer.gates = racer.course.passedCount
    let peak = 0
    let back = -1
    for (let t = 0; t < ticks(30); t++) {
      stepAiRacer(racer, GATES, [], FIXED_DT, GUIDE)
      peak = Math.max(peak, speedOf(racer.jet))
      if (racer.course.passed[missed]) {
        back = t * FIXED_DT
        break
      }
    }
    console.log(
      `speed jet, missed ring ${missed}: back in ${back.toFixed(1)} s, peak ${peak.toFixed(1)} m/s`,
    )
    expect(back, 'it takes the ring it missed').toBeGreaterThan(0)
    expect(peak).toBeLessThan(cruiseSpeed(SPEED) + FAST.profileBand)
  })
})
