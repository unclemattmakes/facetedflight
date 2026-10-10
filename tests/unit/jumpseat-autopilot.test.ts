// tests/unit/jumpseat-autopilot.test.ts — the JumpSeat's controller, on its own.
//
// The mission-scale claims live in `jumpseat-autopilot-missions.test.ts`, which
// needs the published heightmaps and skips without them. Everything here runs
// anywhere: the control signs, the derived numbers, the route planner, and the
// trap-19 two-object guard.
//
// **Assertions are on GEOMETRY, not on quaternions.** `docs/DEVIATIONS.md`'s
// orientation lesson: a distance, a speed or a sign of `u.z` is true
// independently of what the author believed; a quaternion assertion is the
// belief written twice. So the sign tests DRIVE the axis and read where the
// thrust vector ended up, which is the same experiment the controller's header
// records, re-run in CI so it cannot rot.

import { describe, expect, it } from 'vitest'
import { autopilotFinishPad, autopilotWaypointsFor } from '@/game/jumpseat-flight'
import { livePads } from '@/game/targets'
import { FIXED_DT, GRAVITY } from '@/sim/constants'
import { createJumpSeat, type JumpSeat, noJumpSeatInput, stepJumpSeat } from '@/sim/jumpseat'
import {
  createJumpSeatPilot,
  DEFAULT_JUMPSEAT_AUTOPILOT,
  type JumpSeatWaypoint,
  jumpSeatAutopilotActions,
  jumpSeatCruiseSpeed,
  legFuelEstimate,
  planJumpSeatRoute,
  routeLength,
  stepJumpSeatPilot,
} from '@/sim/jumpseat-autopilot'
import { rotateVec3 } from '@/sim/math/quat'
import { type Vec3, v3 } from '@/sim/math/vec3'
import { levelJson as loadLevel } from './helpers/content'

/** `fileURLToPath`, not `new URL(...).pathname` — Windows prefixes a slash. */

/** A seat that is live, unfuelled and gearless — the control law with nothing else in it. */
const bareSeat = (): JumpSeat => {
  const seat = createJumpSeat()
  seat.legs = null
  seat.live = true
  seat.burnsFuel = false
  return seat
}

/** Where body +Y points, in world space. This IS the thrust direction. */
const thrustAxis = (seat: JumpSeat): Vec3 => rotateVec3(v3(), seat.body.orientation, v3(0, 1, 0))

/** Where the nose points. */
const noseAxis = (seat: JumpSeat): Vec3 => rotateVec3(v3(), seat.body.orientation, v3(0, 0, 1))

describe('the axis signs, re-measured', () => {
  // The controller's header states three measurements and derives the control
  // law from them. If the flight model's sign convention ever moves, these fail
  // before the missions do — and they fail saying WHICH axis, which a mission
  // that scores zero does not.
  const drive = (axis: 'pitch' | 'roll' | 'yaw', ticks = 40) => {
    const seat = bareSeat()
    const input = noJumpSeatInput()
    input[axis] = 1
    for (let i = 0; i < ticks; i++) stepJumpSeat(seat, input)
    return seat
  }

  it('pitch +1 tips the THRUST toward +Z', () => {
    const up = thrustAxis(drive('pitch'))
    expect(up.z).toBeGreaterThan(0.05)
    expect(Math.abs(up.x)).toBeLessThan(1e-6)
  })

  it('roll +1 tips the THRUST toward -X', () => {
    const up = thrustAxis(drive('roll'))
    expect(up.x).toBeLessThan(-0.02)
    expect(Math.abs(up.z)).toBeLessThan(1e-6)
  })

  it('yaw +1 swings the NOSE right, and leaves the thrust alone', () => {
    const seat = drive('yaw')
    expect(noseAxis(seat).x).toBeGreaterThan(0.05)
    // Yaw turns about the thrust axis, so it cannot move the ship. That is why
    // the yaw column is free for pointing the nose.
    expect(thrustAxis(seat).y).toBeCloseTo(1, 6)
  })
})

describe('the control law', () => {
  it('leans the thrust toward a target to the RIGHT, and away from one to the left', () => {
    // Geometry, not a quaternion: a target at +X must produce a roll command
    // whose measured effect (above) is a thrust leaning toward +X, which is
    // NEGATIVE roll.
    const seat = bareSeat()
    const right = jumpSeatAutopilotActions(seat, v3(500, 0, 0), noJumpSeatInput())
    expect(right.roll).toBeLessThan(0)
    const left = jumpSeatAutopilotActions(seat, v3(-500, 0, 0), noJumpSeatInput())
    expect(left.roll).toBeGreaterThan(0)
  })

  it('leans the thrust toward a target AHEAD, which is positive pitch', () => {
    const seat = bareSeat()
    const ahead = jumpSeatAutopilotActions(seat, v3(0, 0, 500), noJumpSeatInput())
    expect(ahead.pitch).toBeGreaterThan(0)
    const behind = jumpSeatAutopilotActions(seat, v3(0, 0, -500), noJumpSeatInput())
    expect(behind.pitch).toBeLessThan(0)
  })

  it('points the nose at the target', () => {
    const seat = bareSeat()
    expect(jumpSeatAutopilotActions(seat, v3(500, 0, 100), noJumpSeatInput()).yaw).toBeGreaterThan(
      0,
    )
    expect(jumpSeatAutopilotActions(seat, v3(-500, 0, 100), noJumpSeatInput()).yaw).toBeLessThan(0)
  })

  it('NEVER asks for thrust below the horizon, however far below the target is', () => {
    // The failure this prevents is not a slow descent, it is an inverted ship:
    // a desired acceleration pointing down is a request the attitude loop will
    // honour by rolling the seat over.
    const seat = bareSeat()
    for (const drop of [-50, -500, -5000]) {
      jumpSeatAutopilotActions(seat, v3(0, drop, 0), noJumpSeatInput())
      for (let i = 0; i < 400; i++) {
        const input = jumpSeatAutopilotActions(seat, v3(0, drop, 0), noJumpSeatInput())
        stepJumpSeat(seat, input)
      }
      expect(thrustAxis(seat).y, `diving to ${drop}`).toBeGreaterThan(0.2)
    }
  })

  it('keeps every command inside the range the flight model accepts', () => {
    // Torque is `input * rate`, so an unclamped command is a silent multiplier
    // on a 2016 constant.
    const seat = bareSeat()
    for (const target of [v3(1e6, 1e6, -1e6), v3(0, 0, 0), v3(-1e-9, 1e-9, -1e-9)]) {
      const a = jumpSeatAutopilotActions(seat, target, noJumpSeatInput())
      for (const [k, v] of Object.entries({ pitch: a.pitch, yaw: a.yaw, roll: a.roll })) {
        expect(Number.isFinite(v), `${k}`).toBe(true)
        expect(Math.abs(v), `${k}`).toBeLessThanOrEqual(1)
      }
      expect(a.throttle).toBeGreaterThanOrEqual(0)
      expect(a.throttle).toBeLessThanOrEqual(1)
      expect(a.boost).toBeGreaterThanOrEqual(0)
      expect(a.boost).toBeLessThanOrEqual(1)
    }
  })

  it('holds the throttle SHUT until the thruster exists', () => {
    // `FuelManager` guards the burn on `gasVal > 0` alone — not on the Thruster
    // being enabled — so a throttle held through the 7.5 s countdown spends
    // 14.25 of a 100-unit tank on a component that is switched off.
    const seat = createJumpSeat()
    seat.legs = null
    seat.live = false
    const before = seat.fuel
    for (let i = 0; i < Math.ceil(7.5 / FIXED_DT); i++) {
      stepJumpSeat(seat, jumpSeatAutopilotActions(seat, v3(0, 400, 500), noJumpSeatInput()))
    }
    expect(seat.fuel).toBe(before)
  })

  it('shuts the throttle rather than cracking it, because the burn is binary', () => {
    // Starting a descent: the ship is level and the aim is far below, so the
    // vertical demand is negative, floors at zero, and the only thing a token
    // throttle would buy is 1.9 units/s. That is the case `minUsefulThrottle`
    // exists for — on `adv_02_jumpSeat` it was a whole tank over one 520 m drop.
    const seat = bareSeat()
    const a = jumpSeatAutopilotActions(seat, v3(0, -400, 0), noJumpSeatInput())
    expect(a.throttle).toBe(0)
    // And once the descent needs HOLDING at the sink cap it opens again, because
    // the thrust is then doing something: the difference between 21 m/s and free
    // fall at 48.8.
    seat.body.velocity.y = -DEFAULT_JUMPSEAT_AUTOPILOT.maxSinkRate
    expect(
      jumpSeatAutopilotActions(seat, v3(0, -400, 0), noJumpSeatInput()).throttle,
    ).toBeGreaterThan(DEFAULT_JUMPSEAT_AUTOPILOT.minUsefulThrottle)
  })

  it('reaches and holds a hover at the aim point', () => {
    // The whole reason the controller can aim at a plate 2.6 m thick: it parks.
    const seat = bareSeat()
    const aim = v3(120, 60, -80)
    for (let i = 0; i < Math.ceil(40 / FIXED_DT); i++) {
      stepJumpSeat(seat, jumpSeatAutopilotActions(seat, aim, noJumpSeatInput()))
    }
    const miss = Math.hypot(
      seat.body.position.x - aim.x,
      seat.body.position.y - aim.y,
      seat.body.position.z - aim.z,
    )
    expect(miss, `${miss.toFixed(2)} m from the aim point`).toBeLessThan(2)
    expect(
      Math.hypot(seat.body.velocity.x, seat.body.velocity.y, seat.body.velocity.z),
    ).toBeLessThan(1)
  })
})

describe('the derived numbers describe the vehicle they claim to', () => {
  // DEV-027: nothing in D10's machine guards a number the port computes for
  // itself, and those get quoted in comments and built on as if measured.

  it('the closed-form cruise speed matches a 60-second integration', () => {
    const seat = bareSeat()
    const closed = jumpSeatCruiseSpeed(seat)
    // Balance the thrust against gravity by hand, then hold it and see where the
    // speed settles. The tilt comes from the same identity the closed form uses,
    // so what is being checked is the DISCRETE integrator against the continuous
    // algebra, which is the part that can disagree.
    const accel = seat.tuning.thrustForce / seat.body.mass
    const tilt = Math.acos(Math.abs(GRAVITY.y) / accel)
    seat.body.orientation.x = Math.sin(tilt / 2)
    seat.body.orientation.w = Math.cos(tilt / 2)
    const input = noJumpSeatInput()
    input.throttle = 1
    for (let i = 0; i < Math.ceil(60 / FIXED_DT); i++) stepJumpSeat(seat, input)
    const measured = Math.hypot(seat.body.velocity.x, seat.body.velocity.z)
    expect(measured).toBeGreaterThan(34)
    expect(measured).toBeLessThan(35)
    // Unity's per-step drag loses slightly more than the continuous form, so the
    // closed form should be a shade HIGH and within 2 %.
    expect(closed).toBeGreaterThan(measured)
    expect(closed / measured).toBeLessThan(1.02)
    // And the vertical speed is zero, which is what "level cruise" means.
    expect(Math.abs(seat.body.velocity.y)).toBeLessThan(0.05)
  })

  it('maxSinkRate is not above the sink the ship can actually hold under power', () => {
    // If it is, the vertical acceleration demand goes to zero, the tilt clamp is
    // proportional to it, and the HORIZONTAL demand collapses with it — the ship
    // stops flying and starts falling. That cost `adv_02_jumpSeat` four pads.
    const seat = bareSeat()
    const accel = seat.tuning.thrustForce / seat.body.mass
    const sustainable =
      (Math.abs(GRAVITY.y) - accel * Math.cos(DEFAULT_JUMPSEAT_AUTOPILOT.maxTilt)) /
      seat.tuning.dragBase
    expect(DEFAULT_JUMPSEAT_AUTOPILOT.maxSinkRate).toBeLessThanOrEqual(sustainable)
    // And it is not pointlessly conservative either: within 10 % of the limit.
    expect(DEFAULT_JUMPSEAT_AUTOPILOT.maxSinkRate).toBeGreaterThan(sustainable * 0.9)
  })

  it('the attitude loop is critically damped against the body it flies', () => {
    // `rateGain` is not a taste: the body already carries `angularDrag`, so the
    // closed-loop damping is `angularDrag + rateGain` and critical means that
    // equals twice the natural frequency. Written as the identity rather than as
    // the two numbers, so changing either one has to keep the relationship.
    const seat = bareSeat()
    const omegaN = Math.sqrt(DEFAULT_JUMPSEAT_AUTOPILOT.attitudeGain)
    const damping = seat.body.angularDrag + DEFAULT_JUMPSEAT_AUTOPILOT.rateGain
    expect(damping / (2 * omegaN)).toBeGreaterThan(0.9)
    expect(damping / (2 * omegaN)).toBeLessThan(1.1)
  })

  it('the leg fuel estimate is a time times a rate, in the right units', () => {
    // 1,000 m at 34.86 m/s is 28.7 s, and 28.7 s at 1.9 units/s is 54.5 units.
    const cost = legFuelEstimate(v3(), v3(1000, 0, 0), 34.86, 1.9, 1)
    expect(cost).toBeCloseTo((1000 / 34.86) * 1.9, 6)
    expect(cost).toBeGreaterThan(50)
    expect(cost).toBeLessThan(60)
    // A full tank is therefore about 1.8 km of straight line, which is the fact
    // the whole fuel policy turns on: every one of the six tours is longer.
    expect(100 / (cost / 1000)).toBeGreaterThan(1700)
    expect(100 / (cost / 1000)).toBeLessThan(1900)
  })
})

describe('the route planner', () => {
  const box = (x: number, y: number, z: number, pad: number): JumpSeatWaypoint => ({
    centre: v3(x, y, z),
    padTop: 0,
    axes: [v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1)],
    half: v3(7.27, 1.3, 7.36),
    pad,
  })

  it('pins the finish pad LAST, however near it starts', () => {
    // Crossing `Trigger_Finish_JumpSeat` ends the run, so a tour that passes the
    // finish pad in the middle scores what it had at that moment and stops.
    const stops = [box(10, 0, 0, 0), box(1000, 0, 0, 1), box(2000, 0, 0, 2)]
    const route = planJumpSeatRoute(stops, v3(0, 0, 0), 0)
    expect(route.map((r) => r.pad)).toEqual([1, 2, 0])
  })

  it('takes the near ones first when nothing is pinned', () => {
    const stops = [box(2000, 0, 0, 0), box(100, 0, 0, 1), box(1000, 0, 0, 2)]
    expect(planJumpSeatRoute(stops, v3(0, 0, 0), -1).map((r) => r.pad)).toEqual([1, 2, 0])
  })

  it('2-opt undoes the zig-zag nearest-neighbour walks into', () => {
    // The textbook NN failure, and the one the shipped missions actually show:
    // stops either side of the start. Greedy takes the nearest each time and
    // crosses the start four times — 10 + 30 + 50 + 70 = 160 m — where walking
    // to one end and back across is 100.
    const stops = [box(10, 0, 0, 0), box(-20, 0, 0, 1), box(30, 0, 0, 2), box(-40, 0, 0, 3)]
    const start = v3(0, 0, 0)
    const route = planJumpSeatRoute(stops, start, -1)
    expect(routeLength(route, start)).toBeLessThanOrEqual(110)
    // Every stop is still in the tour, exactly once. A planner that improves a
    // tour by dropping a stop is the worst possible bug here.
    expect(route.map((r) => r.pad).sort()).toEqual([0, 1, 2, 3])
  })

  it('survives the degenerate shapes', () => {
    expect(planJumpSeatRoute([], v3(), -1)).toEqual([])
    expect(planJumpSeatRoute([box(0, 0, 0, 0)], v3(), 0).map((r) => r.pad)).toEqual([0])
    expect(planJumpSeatRoute([box(0, 0, 0, 0)], v3(), -1).map((r) => r.pad)).toEqual([0])
  })
})

describe('the route the SEAM plans, on the real six', () => {
  // `game/jumpseat-flight.ts` builds this tour for `?autopilot=1` and
  // `tests/unit/helpers/jumpseat-run.ts` flies the same one — the same
  // functions, not a second opinion. These are the properties the run-level
  // measurements silently depend on, stated where a reader can find them.
  const LEVELS = [
    'rookie_01_jumpSeat',
    'rookie_02_jumpSeat',
    'int_01_jumpSeat',
    'int_02_jumpSeat',
    'adv_01_jumpSeat',
    'adv_02_jumpSeat',
  ].map((id) => loadLevel(id))

  it('one stop per live pad, and every one of them a BULLSEYE', () => {
    for (const level of LEVELS) {
      const waypoints = autopilotWaypointsFor(level)
      expect(waypoints, level.id).toHaveLength(livePads(level).length)
      for (const stop of waypoints) {
        // 100 is `Trigger_JumpTarget.val_score` on the bullseye; 50 and 25 are
        // the rings that hold and reset the multiplier.
        expect((stop as unknown as { points: number }).points, level.id).toBe(100)
        // And it is the PLATE, at the plate's own size — the thing that stops
        // the pilot declaring victory 3.9 m above a box 1.30 m thick.
        expect(stop.half.y, level.id).toBeCloseTo(1.3, 1)
        expect(stop.half.x, level.id).toBeCloseTo(7.27, 1)
      }
    }
  })

  it('puts the FINISH pad last on all six', () => {
    for (const level of LEVELS) {
      const finish = autopilotFinishPad(level)
      expect(finish, `${level.id} has no finish pad`).toBeGreaterThanOrEqual(0)
      const route = planJumpSeatRoute(
        autopilotWaypointsFor(level),
        v3(level.respawn.pos[0], level.respawn.pos[1], -level.respawn.pos[2]),
        finish,
      )
      expect(route[route.length - 1]?.pad, level.id).toBe(finish)
      expect(route, level.id).toHaveLength(livePads(level).length)
    }
  })

  it('the tours are long enough that fuel is the mission', () => {
    // A full tank flown as a straight line at the level-cruise balance is
    // `maxFuel / burnRate * cruise` = 1,835 m, and that is the optimistic
    // reading: it prices no climb, no run-in, no hold and no corner.
    //
    // The six tours run **1,773 m to 7,450 m**, so five of them are longer than
    // a whole tank outright and the shortest is 97 % of one before a single
    // metre of climbing. That is why `sim/jumpseat-refuel.ts` had to exist
    // before any of them could be finished, and why every measured run spends
    // real time on the pads. (`rookie_01_jumpSeat` took 177 units from them on
    // its 1,773 m tour — see the missions spec.)
    const seat = createJumpSeat()
    const tankRange = (seat.tuning.maxFuel / seat.tuning.burnRate) * jumpSeatCruiseSpeed(seat)
    expect(tankRange).toBeGreaterThan(1800)
    expect(tankRange).toBeLessThan(1900)
    let overATank = 0
    for (const level of LEVELS) {
      const start = v3(level.respawn.pos[0], level.respawn.pos[1], -level.respawn.pos[2])
      const route = planJumpSeatRoute(
        autopilotWaypointsFor(level),
        start,
        autopilotFinishPad(level),
      )
      const metres = routeLength(route, start)
      expect(metres, level.id).toBeGreaterThan(tankRange * 0.95)
      if (metres > tankRange) overATank++
    }
    expect(overATank).toBe(5)
  })
})

describe('trap 19 — two pilots, two ships, one module', () => {
  // `ai-racer.ts` shared ONE `HoverJetInput` across every racer and a finished
  // racer flew on with the other racer's stick until it went into the sea.
  // Invisible to every single-object test: with one object there is nobody to
  // inherit from. So every stateful claim below is made by stepping a SECOND
  // one and asserting the first did not move.
  const stops = (pad: number): JumpSeatWaypoint[] => [
    {
      centre: v3(200 * (pad + 1), 50, 0),
      padTop: 0,
      axes: [v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1)],
      half: v3(7.27, 1.3, 7.36),
      pad,
    },
  ]

  it('stepping a second pilot leaves the first pilot alone', () => {
    const a = createJumpSeatPilot(stops(0))
    const b = createJumpSeatPilot(stops(1))
    const seatA = bareSeat()
    const seatB = bareSeat()
    seatB.body.position.x = 5000

    const inputA = noJumpSeatInput()
    const inputB = noJumpSeatInput()
    for (let i = 0; i < 200; i++) {
      stepJumpSeatPilot(a, seatA, inputA)
      stepJumpSeat(seatA, inputA)
    }
    const aimA = { x: a.aim.x, y: a.aim.y, z: a.aim.z }
    const stickA = { ...inputA }
    const cursorA = a.cursor
    const phaseA = a.phase

    for (let i = 0; i < 200; i++) {
      stepJumpSeatPilot(b, seatB, inputB)
      stepJumpSeat(seatB, inputB)
    }

    expect(a.aim).toEqual(aimA)
    expect(a.cursor).toBe(cursorA)
    expect(a.phase).toBe(phaseA)
    expect(inputA).toEqual(stickA)
  })

  it('two ships flying the SAME route do not share a stick', () => {
    // The nastier shape: identical routes, so a shared scratch would be
    // invisible in the aim point and visible only in the flying.
    const route = stops(0)
    const a = createJumpSeatPilot(route)
    const b = createJumpSeatPilot(route)
    const seatA = bareSeat()
    const seatB = bareSeat()
    // Put them somewhere genuinely different, so "same command" means "bug".
    seatB.body.position.x = -600
    seatB.body.position.z = 900

    const inputA = noJumpSeatInput()
    const inputB = noJumpSeatInput()
    for (let i = 0; i < 120; i++) {
      stepJumpSeatPilot(a, seatA, inputA)
      stepJumpSeat(seatA, inputA)
      stepJumpSeatPilot(b, seatB, inputB)
      stepJumpSeat(seatB, inputB)
    }
    const apart = Math.hypot(
      seatA.body.position.x - seatB.body.position.x,
      seatA.body.position.y - seatB.body.position.y,
      seatA.body.position.z - seatB.body.position.z,
    )
    // They are converging on the same pad, so they get closer — but two ships
    // running one stick end up at exactly the same OFFSET from where they
    // started, which is what this would catch.
    expect(apart).toBeGreaterThan(1)
    expect(inputA.pitch).not.toBe(inputB.pitch)
  })

  it('a finished pilot holds its own station, not the other one’s', () => {
    // DEV-032's exact shape: the finished branch wrote only some of the fields.
    const a = createJumpSeatPilot([])
    const b = createJumpSeatPilot([])
    const seatA = bareSeat()
    const seatB = bareSeat()
    seatB.body.position.y = 400
    const inputA = noJumpSeatInput()
    const inputB = noJumpSeatInput()
    for (let i = 0; i < 300; i++) {
      stepJumpSeatPilot(a, seatA, inputA)
      stepJumpSeat(seatA, inputA)
      stepJumpSeatPilot(b, seatB, inputB)
      stepJumpSeat(seatB, inputB)
    }
    expect(a.phase).toBe('done')
    expect(b.phase).toBe('done')
    // Both are still in the air at roughly where they started, 400 m apart.
    expect(Math.abs(seatA.body.position.y - 0)).toBeLessThan(20)
    expect(Math.abs(seatB.body.position.y - 400)).toBeLessThan(20)
  })
})
