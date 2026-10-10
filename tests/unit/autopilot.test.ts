// tests/unit/autopilot.test.ts — the whole course, flown, in a unit test.
//
// This is the payoff of the sim being three-free and deterministic. The
// autopilot produces `HoverJetInput`, `stepHoverJet` consumes it, `stepCourse`
// scores against the same spheres the game uses — so a complete run of
// `int_01_hoverJet` is a few hundred milliseconds of arithmetic with no
// renderer, no DOM and no GPU anywhere near it.
//
// What that buys is a claim CI can hold: **the course is completable, and the
// flight model can complete it.** Every tuning constant in `hoverjet.ts` is a
// 2016 number nobody is allowed to nudge; this is the test that notices when one
// of them moves and the ship can suddenly no longer make the third turn.
//
// It is deliberately NOT a golden trajectory — no pinned positions. The
// autopilot is a proportional controller and pinning its exact path would make
// every legitimate tuning change a wall of diffs. What is pinned is the
// OUTCOME: all 21 gates, in order, inside the mission's own time limit.

import { describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import { courseGates, startMission } from '@/game/mission'
import { threeQuatTupleToUnity, threeTupleToUnity } from '@/render/unity-space'
import { autopilotActions, DEFAULT_AUTOPILOT, nextGate } from '@/sim/autopilot'
import { FIXED_DT } from '@/sim/constants'
import { createCourse, stepCourse } from '@/sim/course'
import { createHoverJet, noInput, stepHoverJet } from '@/sim/hoverjet'
import int01 from '../../content/levels/int_01_hoverJet.json'

const LEVEL = int01 as unknown as Level

/**
 * Fly the course.
 *
 * Starts where the elevator releases — spawn plus the lift's rise — because
 * that is where the run actually begins, and starting at the spawn marker would
 * begin 95 m underwater with the first gate a kilometre up.
 */
const fly = (
  options: { maxSeconds?: number; tuning?: typeof DEFAULT_AUTOPILOT; corners?: boolean } = {},
) => {
  const maxSeconds = options.maxSeconds ?? LEVEL.timer.timeLimit
  const jet = createHoverJet()
  jet.launched = true
  threeTupleToUnity(jet.body.position, LEVEL.spawn.pos as number[])
  threeQuatTupleToUnity(jet.body.orientation, LEVEL.spawn.quat as number[])
  jet.body.position.y += LEVEL.spawn.launch?.rise ?? 0

  const course = createCourse(courseGates(LEVEL))
  const input = noInput()
  const order: number[] = []
  let elapsed = 0
  let maxSpeed = 0
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  const steps = Math.ceil(maxSeconds / FIXED_DT)
  for (let i = 0; i < steps && course.passedCount < course.gates.length; i++) {
    const target = nextGate(course.gates, course.passed)
    if (target < 0) break
    const gate = course.gates[target]
    if (!gate) break
    // ── `nextTarget`, and the measurement that could not see it ───────────
    //
    // `autopilotActions`' seventh parameter is the gate AFTER the one being
    // flown at, and the corner-braking term is identically zero without it —
    // it is the only thing that says how sharp the next turn is. This harness
    // did not pass it, so every corner-braking number ever taken through it
    // was a measurement of a disabled feature. The ledger recorded the result
    // honestly ("neutral, 15 gates either way") and the result was an artefact
    // of the call shape, not of the tuning.
    //
    // The game passes it (`ai-racer.ts:350` as `cornerRef`, `app.ts:2457`), so
    // the feature is live where it matters and was dark only in the test. Kept
    // switchable because `corners: false` is what the older assertions were
    // written against, and one of the tests below is about the difference.
    const after = options.corners === false ? null : (course.gates[target + 1]?.centre ?? null)
    autopilotActions(
      jet.body,
      gate.centre,
      input,
      options.tuning,
      [],
      Number.POSITIVE_INFINITY,
      after,
    )
    stepHoverJet(jet, input)
    const scored = stepCourse(course, jet.body.position)
    if (scored >= 0) order.push(scored)
    elapsed += FIXED_DT
    const v = jet.body.velocity
    maxSpeed = Math.max(maxSpeed, Math.hypot(v.x, v.y, v.z))
    minY = Math.min(minY, jet.body.position.y)
    maxY = Math.max(maxY, jet.body.position.y)
  }
  return { jet, course, order, elapsed, maxSpeed, minY, maxY }
}

describe('the autopilot flies int_01_hoverJet', () => {
  it('passes every gate on the course', () => {
    const run = fly()
    expect(
      run.course.passedCount,
      `only ${run.course.passedCount} of ${run.course.gates.length}`,
    ).toBe(run.course.gates.length)
    expect(run.course.gates.length).toBe(21)
  })

  it('takes them IN ORDER, which is what makes it a course and not a cloud', () => {
    // `stepCourse` scores whichever unpassed gate contains the ship, so an
    // autopilot that wandered could legitimately collect them out of sequence.
    // Flying them in order is the evidence that it is actually following the
    // route the level author laid out.
    const run = fly()
    expect(run.order).toEqual(run.order.slice().sort((a, b) => a - b))
  })

  it('finishes inside the mission time limit, with room to spare', () => {
    // 180 s on this mission. If the autopilot only just scrapes in, it is not a
    // useful signal about the flight model — it is a signal about the
    // autopilot's own tuning.
    const run = fly()
    expect(run.elapsed).toBeLessThan(LEVEL.timer.timeLimit)
    expect(run.elapsed).toBeLessThan(LEVEL.timer.timeLimit * 0.85)
  })

  it('flies at a speed the ship can actually reach', () => {
    // `maxSpeed` is 437.5 on the shipped prefab. Exceeding it would mean the
    // integrator or the drag has come loose, and the autopilot would be
    // reporting a green run on a broken flight model.
    const run = fly()
    expect(run.maxSpeed).toBeGreaterThan(40)
    expect(run.maxSpeed).toBeLessThanOrEqual(437.5)
  })

  it('stays above the sea and below the sky', () => {
    // Sea level is around 102 m in this world and the peaks reach ~1090 m. A run
    // that dives through the ocean or climbs to orbit has passed its gates by
    // accident.
    const run = fly()
    expect(run.minY).toBeGreaterThan(60)
    expect(run.maxY).toBeLessThan(2000)
  })

  // ── Corner braking is CONNECTED, and this is what says so ──────────────
  //
  // Not an assertion about the right amount of braking — that is a tuning
  // question and it needs the racing line and the velocity profile, neither of
  // which this harness has. It is an assertion that the knob does SOMETHING,
  // because for the life of the feature it did nothing here and the resulting
  // "neutral" reading went into the ledger as a fact about the tuning.
  //
  // Measured 2026-09-12 across all six HoverJet Ring Attack courses, flying
  // gate to gate with no line and no profile: the shipped 1.7 s / 0.6 costs
  // 0.1 s (rookie_01), 0.2 (rookie_02), 0.3 (int_01), 0.7 (int_02), 1.5
  // (adv_01) and 0.6 (adv_02) against braking switched off, and gains no gates
  // anywhere — all six courses complete either way. So in THIS configuration
  // it is pure cost. It is not this configuration the racers fly, which is why
  // the shipped value is left alone: the ledger's note that 3.6 s homogenised
  // the racers to 6 m apart is a race-quality property, and nothing gate-to-
  // gate can see it.
  it('actually responds to the corner-braking knob', () => {
    const braked = fly()
    const free = fly({ tuning: { ...DEFAULT_AUTOPILOT, cornerBrakeMax: 0 } })
    expect(braked.course.passedCount).toBe(braked.course.gates.length)
    expect(free.course.passedCount).toBe(free.course.gates.length)
    // A tenth of a second is far outside the fixed step's resolution (12.2 ms)
    // and far inside any plausible re-tuning, so this catches "disconnected"
    // without pinning a lap time.
    expect(braked.elapsed - free.elapsed).toBeGreaterThan(0.05)
  })

  it('and the knob is dark when nextTarget is withheld — which is the trap', () => {
    // The regression guard for the bug above: with no `nextTarget` the two
    // tunings are bit-identical, because the corner term has no turn to
    // measure. If this ever stops being true the comment in `fly` is stale.
    const braked = fly({ corners: false })
    const free = fly({ corners: false, tuning: { ...DEFAULT_AUTOPILOT, cornerBrakeMax: 0 } })
    expect(braked.elapsed).toBe(free.elapsed)
  })
})

describe('the control laws', () => {
  const bodyAt = (position: [number, number, number]) => ({
    position: { x: position[0], y: position[1], z: position[2] },
    // Identity: +Z forward, +Y up, +X right.
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    velocity: { x: 0, y: 0, z: 0 },
  })

  it('turns toward a target on the right, and away from one on the left', () => {
    // The sign that was MEASURED: +yaw puts the nose right.
    const right = autopilotActions(bodyAt([0, 0, 0]), { x: 100, y: 0, z: 100 }, noInput())
    expect(right.yaw).toBeGreaterThan(0)
    const left = autopilotActions(bodyAt([0, 0, 0]), { x: -100, y: 0, z: 100 }, noInput())
    expect(left.yaw).toBeLessThan(0)
  })

  it('pulls the nose UP for a target above, which means NEGATIVE pitch', () => {
    // The sign most likely to be wrong, and the one that flies the ship
    // confidently into the sea if it is. +pitch drops the nose.
    const above = autopilotActions(bodyAt([0, 0, 0]), { x: 0, y: 100, z: 100 }, noInput())
    expect(above.pitch).toBeLessThan(0)
    const below = autopilotActions(bodyAt([0, 0, 0]), { x: 0, y: -100, z: 100 }, noInput())
    expect(below.pitch).toBeGreaterThan(0)
  })

  it('banks INTO the turn rather than away from it', () => {
    // Turning right should drop the right wing. +roll raises it, so a right turn
    // wants negative roll — and getting this backwards produces a ship that
    // rolls further out of every corner until it is inverted.
    const right = autopilotActions(bodyAt([0, 0, 0]), { x: 100, y: 0, z: 100 }, noInput())
    expect(right.roll).toBeLessThan(0)
    const left = autopilotActions(bodyAt([0, 0, 0]), { x: -100, y: 0, z: 100 }, noInput())
    expect(left.roll).toBeGreaterThan(0)
  })

  it('eases the throttle when badly misaligned, but never to a stall', () => {
    const ahead = autopilotActions(bodyAt([0, 0, 0]), { x: 0, y: 0, z: 100 }, noInput())
    expect(ahead.throttle).toBeCloseTo(1, 3)
    const behind = autopilotActions(bodyAt([0, 0, 0]), { x: 0, y: 0, z: -100 }, noInput())
    expect(behind.throttle).toBe(DEFAULT_AUTOPILOT.minThrottle)
    // The floor exists because the ship turns with torque and airspeed, not with
    // lift. At zero throttle it hangs and wallows instead of coming round.
    expect(behind.throttle).toBeGreaterThan(0)
  })

  it('HOLDS boost, because the 2016 ghosts did', () => {
    // This assertion used to be the opposite, on the reasoning that boost is
    // free (DEV-002) and holding it would make every lap the fastest possible
    // one. The ghosts refute it: `int_01_leftSpawn_fast_01` spends 90 % of its
    // run above 120 m/s, and the ship cannot pass 89.8 m/s without boost. The
    // recording is of someone holding it the whole way, so a free button nobody
    // releases is the cruise setting and declining it is what would be
    // unrepresentative.
    const a = autopilotActions(bodyAt([0, 0, 0]), { x: 30, y: 10, z: 100 }, noInput())
    expect(a.boost).toBe(true)
    expect(a.brake).toBe(false)
  })

  it('can still be asked for the unboosted envelope', () => {
    // The old behaviour is a tuning field rather than a deleted option, because
    // "what does this do at cruise" is still a question worth being able to ask.
    const a = autopilotActions(bodyAt([0, 0, 0]), { x: 30, y: 10, z: 100 }, noInput(), {
      ...DEFAULT_AUTOPILOT,
      boost: false,
    })
    expect(a.boost).toBe(false)
  })

  it('keeps every command inside the range the sim accepts', () => {
    // Torque is `input * rate`, so an unclamped command is a silent multiplier
    // on a 2016 constant.
    for (const target of [
      { x: 1e6, y: 1e6, z: -1e6 },
      { x: 0, y: 0, z: 0 },
      { x: -1e-9, y: 1e-9, z: -1e-9 },
    ]) {
      const a = autopilotActions(bodyAt([0, 0, 0]), target, noInput())
      for (const [k, v] of Object.entries({ pitch: a.pitch, yaw: a.yaw, roll: a.roll })) {
        expect(Number.isFinite(v), `${k} on ${JSON.stringify(target)}`).toBe(true)
        expect(Math.abs(v), `${k} on ${JSON.stringify(target)}`).toBeLessThanOrEqual(1)
      }
      expect(a.throttle).toBeGreaterThanOrEqual(0)
      expect(a.throttle).toBeLessThanOrEqual(1)
    }
  })
})

describe('gate selection', () => {
  it('takes the first unpassed gate, and reports -1 when the course is done', () => {
    const gates = courseGates(LEVEL)
    const passed = gates.map(() => false)
    expect(nextGate(gates, passed)).toBe(0)
    passed[0] = true
    expect(nextGate(gates, passed)).toBe(1)
    // Out-of-order completion still finds the earliest gap, which is what keeps
    // the autopilot on the route rather than chasing whatever is nearest.
    passed[2] = true
    expect(nextGate(gates, passed)).toBe(1)
    expect(
      nextGate(
        gates,
        gates.map(() => true),
      ),
    ).toBe(-1)
  })

  it('starts the mission with nothing passed', () => {
    const mission = startMission(LEVEL)
    expect(nextGate(mission.course.gates, mission.course.passed)).toBe(0)
    expect(mission.ringsTotal).toBe(21)
  })
})
