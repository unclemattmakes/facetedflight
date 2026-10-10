/**
 * `content/authored/anniv_01_glider.json` — DEV-145.
 *
 * ── The one test that matters ─────────────────────────────────────────────
 *
 * The brief: *"a glider that cannot complete its own mission is not a
 * prototype. Fly it in a test."* So this file flies it — nine gates and a
 * finish, headless, through the same `stepCourse` the game scores with, driven
 * by `sim/glider-autopilot.ts` and `sim/glider.ts` with the tuning read out of
 * the aircraft's own file (`content/aircraft/glider.json`, DEV-399; the level
 * JSON carried it before) rather than out of the module. If the authored line
 * is not flyable on the authored tuning, this goes red.
 *
 * ── And the one that stops the copy rotting ───────────────────────────────
 *
 * An authored level cannot be generated, so its Simonet blocks — fog, lighting,
 * boundary, worldOffset — are copied from `int_01_hoverJet`. A copy is a
 * hand-typed constant unless something checks it (hard rule 3), so the second
 * half of this file deep-equals every copied field against the generated
 * original. Re-extract Simonet and move a number, and this says so.
 */
import { describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import { liveRings } from '@/content/level-schema'
import { gliderTuning } from '@/content/load-aircraft'
import { loadLevel } from '@/content/load-level'
import { FIXED_DT } from '@/sim/constants'
import type { Gate } from '@/sim/course'
import { createCourse, stepCourse, stepDistance } from '@/sim/course'
import {
  createGlider,
  type Glider,
  type GliderTuning,
  noGliderInput,
  PROTOTYPE_GLIDER,
  stepGlider,
} from '@/sim/glider'
import { bestGlideRatio, gliderAutopilotActions } from '@/sim/glider-autopilot'
import { setQ } from '@/sim/math/quat'
import { set, type Vec3, v3 } from '@/sim/math/vec3'

const MISSION = 'anniv_01_glider'

const level = await loadLevel(MISSION)
// DEV-399: the tuning is the AIRCRAFT's, `content/aircraft/glider.json`.
const tuning: GliderTuning = gliderTuning()

// ── The game's frame, not the file's ─────────────────────────────────────
//
// The level JSON is THREE space and the sim is UNITY space: `game/flight.ts`
// converts the spawn (position z-flipped, quaternion x and y negated) and
// `game/mission.ts`'s `courseGates` z-flips every ring. This file used to fly
// the course in the FILE's frame, where a +Z nose and a -Z nose look equally
// right — and the course had been authored with the wrong one: in the game's
// frame the glider started facing AWAY from ring 0. It never flew in the game
// until DEV-399, which is when that showed; the spawn and rings were turned
// round, and this flies what the game flies. (The orientation lesson, and the
// agreement lesson: a rule tested only where two conventions agree.)
const toSim = (t: readonly number[]): Vec3 => v3(t[0], t[1], -(t[2] as number))

const gatesOf = (l: Level): Gate[] =>
  liveRings(l).map((r) => ({
    centre: toSim(r.trigger.pos),
    radius: r.trigger.radius,
    points: r.scoring.addScore * l.scoring.gateMultiplier,
    triggerOnce: r.scoring.triggerOnce,
  }))

/** The finish, as one more gate. It is what ENDS the run, so it is the real test. */
const finishGate = (l: Level): Gate => {
  const f = l.finish
  if (!f) throw new Error('the authored mission has no finish gate')
  return {
    centre: toSim(f.pos),
    radius: f.radius,
    points: 0,
    triggerOnce: true,
  }
}

const spawnGlider = (l: Level, t: GliderTuning): Glider => {
  const g = createGlider(t)
  const p = toSim(l.spawn.pos)
  set(g.body.position, p.x, p.y, p.z)
  const q = l.spawn.quat
  // THREE -> UNITY: negate x and y, as `render/unity-space.ts` does.
  setQ(g.body.orientation, -(q[0] as number), -(q[1] as number), q[2] as number, q[3] as number)
  // Launched at trim speed along the nose. `launchKind` is `direct`: this
  // course has no elevator, because a glider has nothing to ride one for.
  const cruise = Math.sqrt((t.mass * 32) / (t.aeroScale * t.liftSlope * t.trimAngleOfAttack))
  set(g.body.velocity, 0, 0, cruise)
  const world = v3()
  // Rotate (0,0,cruise) into world by the spawn quat, longhand rather than via
  // the sim's helper so the test does not fly on the same one-liner the sim
  // does (trap 24).
  const { x, y, z, w } = g.body.orientation
  world.x = 2 * (x * z + w * y) * cruise
  world.y = 2 * (y * z - w * x) * cruise
  world.z = (1 - 2 * (x * x + y * y)) * cruise
  set(g.body.velocity, world.x, world.y, world.z)
  return g
}

interface Run {
  readonly passed: number
  readonly finished: boolean
  readonly seconds: number
  readonly minAirspeed: number
  readonly maxAirspeed: number
  readonly stalledTicks: number
  readonly rocketTicks: number
  readonly lowest: number
  readonly finalPosition: Vec3
}

/** Fly the authored course with the authored tuning. Returns what happened. */
const flyMission = (limitSeconds = 180): Run => {
  const g = spawnGlider(level, tuning)
  const gates = gatesOf(level)
  const finish = finishGate(level)
  const course = createCourse(gates)
  const input = noGliderInput()

  let finished = false
  let seconds = 0
  let minAirspeed = Number.POSITIVE_INFINITY
  let maxAirspeed = 0
  let stalledTicks = 0
  let rocketTicks = 0
  let lowest = Number.POSITIVE_INFINITY

  const ticks = Math.round(limitSeconds / FIXED_DT)
  for (let i = 0; i < ticks; i++) {
    const next = course.passed.findIndex((p) => !p)
    const target = next < 0 ? finish.centre : (gates[next] as Gate).centre
    gliderAutopilotActions(g.body, target, g.airspeed, g.fuel, tuning, input)
    stepGlider(g, input)
    stepCourse(course, g.body.position)
    seconds = (i + 1) * FIXED_DT

    if (g.airspeed < minAirspeed) minAirspeed = g.airspeed
    if (g.airspeed > maxAirspeed) maxAirspeed = g.airspeed
    if (g.liftAuthority < 1) stalledTicks++
    if (g.burning) rocketTicks++
    if (g.body.position.y < lowest) lowest = g.body.position.y

    if (course.passedCount === gates.length) {
      const d = Math.hypot(
        g.body.position.x - finish.centre.x,
        g.body.position.y - finish.centre.y,
        g.body.position.z - finish.centre.z,
      )
      if (d <= finish.radius) {
        finished = true
        break
      }
    }
  }

  return {
    passed: course.passedCount,
    finished,
    seconds,
    minAirspeed,
    maxAirspeed,
    stalledTicks,
    rocketTicks,
    lowest,
    finalPosition: g.body.position,
  }
}

describe('the authored glider mission', () => {
  it('is a valid level that lives OUTSIDE the generated tree', async () => {
    expect(level.id).toBe(MISSION)
    expect(level.generated).toBeNull()
    // DEV-399: the course names its aircraft, and the aircraft owns its numbers.
    // Until G1 it said `hoverjet` and carried the tuning as `flightModel`,
    // which `loadFlight` never read — so it flew as a HoverJet.
    expect(level.vehicle).toBe('glider')
    expect((level as { flightModel?: unknown }).flightModel).toBeUndefined()
  })

  it("flies the aircraft file's tuning, matching PROTOTYPE_GLIDER", () => {
    // Two copies of one tuning is the drift `SHIP_MODEL_YAW` had. The aircraft
    // file is the shipping source (DEV-399; the level carried it before); this
    // pins the in-tree convenience copy to it.
    expect({ ...tuning }).toEqual({ ...PROTOTYPE_GLIDER })
  })

  it('demands less glide than the airframe has, and enough to cost something', () => {
    // The course asks 4.00 : 1 of an airframe that glides 7.00 : 1, and the
    // headroom is not slack — it is what the TURN costs. A bank spills lift by
    // cos(bank), so the 18 degrees this course is flown at is paid for out of
    // the margin, and the measured run comes down at about 4.2 : 1 with the
    // rocket never fired. Both ends are asserted, and both are relationships
    // rather than values: retune the airframe and this follows.
    const required = level._authored?.geometry?.requiredGlideRatio as number
    expect(required).toBeGreaterThan(0)
    expect(required).toBeLessThan(bestGlideRatio(tuning))
    // Not so much less that the course is a straight line downhill and the
    // energy trade never comes up.
    expect(required).toBeGreaterThan(bestGlideRatio(tuning) * 0.5)
  })

  it('has gates a glider cannot tunnel through', () => {
    // `course.ts`'s tunnelling note, applied to a vehicle it was not written
    // for. The glider tops out near 170 m/s, which is 2.1 m per tick — well
    // inside a 40 m gate, but asserted rather than assumed.
    const weight = tuning.mass * 32
    const terminal = Math.sqrt(weight / (tuning.aeroScale * tuning.parasiteDrag))
    const perTick = stepDistance(terminal, FIXED_DT)
    for (const gate of gatesOf(level)) expect(gate.radius).toBeGreaterThan(perTick * 4)
  })

  it('FLIES: the glider completes its own course, gates and finish', () => {
    const run = flyMission()
    expect(run.passed).toBe(liveRings(level).length)
    expect(run.finished).toBe(true)
    expect(run.seconds).toBeLessThan(level.timer.timeLimit)
  })

  it('never falls into the sea on the way round', () => {
    // The whole course is over water and terrain collision is not part of this
    // prototype, so "stayed above zero" is the honest claim: it is not a
    // terrain-clearance test and must not be read as one.
    const run = flyMission()
    expect(run.lowest).toBeGreaterThan(0)
  })

  it('is flown as a glider, not as a rocket', () => {
    const run = flyMission()
    // The rocket is a resource, and a clean line does not need it AT ALL. That
    // is the design claim the course is authored around, so it is asserted at
    // zero rather than at "not much": if a retune of either the airframe or the
    // line makes the pilot reach for it, that is a fact worth going red over.
    expect(run.rocketTicks).toBe(0)
    // And it really is a glide: it stays between the stall band and the dive
    // speed the whole way, pinned at neither end.
    expect(run.minAirspeed).toBeGreaterThan(tuning.stallSpeed + tuning.stallWidth)
    expect(run.maxAirspeed).toBeLessThan(120)
    expect(run.stalledTicks).toBe(0)
  })

  it('is deterministic — the same mission flies the same twice', () => {
    // No RNG and no clock anywhere under `src/sim/` (hard rule 4), so two runs
    // must agree exactly. This is the assertion that would catch a
    // `Math.random()` slipping into the controller.
    const a = flyMission()
    const b = flyMission()
    expect(b.finalPosition).toEqual(a.finalPosition)
    expect(b.seconds).toBe(a.seconds)
    expect(b.rocketTicks).toBe(a.rocketTicks)
  })
})

describe('the authored mission does not hand-type Simonet', () => {
  it('copies every environment block verbatim from the generated original', async () => {
    const src = await loadLevel('int_01_hoverJet')
    expect(level.worldOffset).toEqual(src.worldOffset)
    expect(level.fog).toEqual(src.fog)
    expect(level.lighting).toEqual(src.lighting)
    expect(level.boundary).toEqual(src.boundary)
    expect(level.scoring).toEqual(src.scoring)
    expect(level.ui).toEqual(src.ui)
    expect(level.timer.countdown).toEqual(src.timer.countdown)
    expect(level.environment).toBe(src.environment)
    expect(level.environmentScene).toBe(src.environmentScene)
  })

  it('says in the file itself which fields were copied and why', () => {
    const copied = level._authored?.copiedFrom
    expect(copied?.level).toBe('int_01_hoverJet')
    expect(copied?.fields).toContain('fog')
    expect(copied?.fields).toContain('lighting')
    expect(String(copied?.why)).toMatch(/hard rule 3/)
  })

  it('pays nothing into a speed chain the glider does not have', () => {
    // DEV-069: a number nothing reads is documentation, not a guard. The
    // HoverJet's rings pay 12 each into `EnergySystem_Ship`; this vehicle has
    // no thruster for it to feed.
    for (const ring of liveRings(level)) {
      expect(ring.scoring.energyBoost).toBe(false)
      expect(ring.scoring.energyBoostAmount).toBe(0)
    }
  })
})
