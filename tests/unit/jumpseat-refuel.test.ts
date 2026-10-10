// tests/unit/jumpseat-refuel.test.ts — the tank had no way of being filled.
//
// `sim/jumpseat.ts` shipped `addFuel()` with a full docstring about the 10
// units/s a pad gives, `level.pads[].refuel` shipped a 19.7 m sphere on every
// live pad, and **nothing in `src/` connected them**. So every JumpSeat mission
// ran dry at 52.6 s of throttle-on time, latched the Thruster off and fell out
// of the sky with gravity on — a mode nobody could finish, invisible for as long
// as nobody flew one.
//
// These are the geometry and the arithmetic. That the missions now complete is
// `jumpseat-autopilot-missions.test.ts`.

import { describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import { refuelSpheresFor } from '@/game/jumpseat-flight'
import { livePads } from '@/game/targets'
import { FIXED_DT } from '@/sim/constants'
import { createJumpSeat, type JumpSeat, noJumpSeatInput, stepJumpSeat } from '@/sim/jumpseat'
import { createRefuel, refuelSphereAt, stepJumpSeatRefuel } from '@/sim/jumpseat-refuel'
import { v3 } from '@/sim/math/vec3'
import adv02 from '../../content/levels/adv_02_jumpSeat.json'
import int01 from '../../content/levels/int_01_jumpSeat.json'

const INT01 = int01 as unknown as Level
const ADV02 = adv02 as unknown as Level

const seatAt = (x: number, y: number, z: number): JumpSeat => {
  const seat = createJumpSeat()
  seat.legs = null
  seat.body.position.x = x
  seat.body.position.y = y
  seat.body.position.z = z
  return seat
}

describe('the spheres come out of the level, in SIM space', () => {
  it('one per live pad, and none for a dead one', () => {
    // `int_01_jumpSeat` ships seven pads and six of them are live. A refuel
    // sphere on the dead one would be a petrol station in a field.
    expect(refuelSpheresFor(INT01)).toHaveLength(livePads(INT01).length)
    expect(refuelSpheresFor(INT01).length).toBeLessThan(INT01.pads.length)
    expect(refuelSpheresFor(ADV02)).toHaveLength(12)
  })

  it('carries the shipped 19.707 m radius and 10 units/s, unchanged per pad', () => {
    // `_modes-spec.md` §1.4 diffed every `m_Modifications` block of all 57 pad
    // instances; nothing overrides the rate or the collider.
    for (const sphere of [...refuelSpheresFor(INT01), ...refuelSpheresFor(ADV02)]) {
      expect(sphere.radius).toBeCloseTo(19.707, 2)
      expect(sphere.rate).toBe(10)
    }
  })

  it('sits where the pad does — a z FLIP, not a z copy', () => {
    // The level JSON is THREE space and the sim is UNITY space. Forgetting the
    // flip puts every petrol station a mirror-image away, which on a 4 km map is
    // kilometres, and the symptom is a mission that quietly cannot be finished.
    const spheres = refuelSpheresFor(INT01)
    livePads(INT01).forEach((pad, i) => {
      const sphere = spheres[i]
      if (!sphere || !pad.refuel) throw new Error('missing pad or sphere')
      expect(sphere.centre.x).toBeCloseTo(pad.refuel.pos[0], 6)
      expect(sphere.centre.z).toBeCloseTo(-pad.refuel.pos[2], 6)
      // And the sphere really does contain the pad's own origin: the thing that
      // makes "fly through the dartboard" and "fill the tank" one manoeuvre.
      const dx = sphere.centre.x - pad.pos[0]
      const dy = sphere.centre.y - pad.pos[1]
      const dz = sphere.centre.z + pad.pos[2]
      expect(Math.hypot(dx, dy, dz)).toBeLessThan(sphere.radius)
    })
  })
})

describe('the flow', () => {
  it('pays `rate * dt` inside and nothing outside', () => {
    const spheres = refuelSpheresFor(INT01)
    const sphere = spheres[0]
    if (!sphere) throw new Error('no spheres')
    const seat = seatAt(sphere.centre.x, sphere.centre.y, sphere.centre.z)
    seat.fuel = 50
    expect(stepJumpSeatRefuel(createRefuel(spheres), seat, seat.body.position, FIXED_DT)).toBe(0)
    expect(seat.fuel).toBeCloseTo(50 + 10 * FIXED_DT, 9)

    const away = seatAt(sphere.centre.x + sphere.radius + 1, sphere.centre.y, sphere.centre.z)
    away.fuel = 50
    expect(stepJumpSeatRefuel(createRefuel(spheres), away, away.body.position, FIXED_DT)).toBe(-1)
    expect(away.fuel).toBe(50)
  })

  it('stops at maxFuel — `AddFuel()` is guarded on `currentFuel < maxFuel`', () => {
    const spheres = refuelSpheresFor(INT01)
    const sphere = spheres[0]
    if (!sphere) throw new Error('no spheres')
    const seat = seatAt(sphere.centre.x, sphere.centre.y, sphere.centre.z)
    const state = createRefuel(spheres)
    for (let i = 0; i < 2000; i++) stepJumpSeatRefuel(state, seat, seat.body.position, FIXED_DT)
    expect(seat.fuel).toBeLessThanOrEqual(seat.tuning.maxFuel + 10 * FIXED_DT)
    expect(seat.fuel).toBeGreaterThan(seat.tuning.maxFuel - 1)
  })

  it('brings a NEGATIVE tank back, and re-arms the latched Thruster', () => {
    // The tank is not clamped at the bottom (`sim/jumpseat.ts` §3), so a deficit
    // is real seconds of contact — a -50 tank costs five of them before the
    // thruster produces anything at all. Reproduced on purpose: hiding the
    // deficit would make a pad look broken.
    const spheres = refuelSpheresFor(INT01)
    const sphere = spheres[0]
    if (!sphere) throw new Error('no spheres')
    const seat = seatAt(sphere.centre.x, sphere.centre.y, sphere.centre.z)
    seat.fuel = -50
    seat.thrusterEnabled = false
    const state = createRefuel(spheres)
    let ticks = 0
    while (seat.fuel < 0 && ticks < 10000) {
      stepJumpSeatRefuel(state, seat, seat.body.position, FIXED_DT)
      ticks++
    }
    expect(ticks * FIXED_DT).toBeCloseTo(5, 1)
    expect(seat.thrusterEnabled).toBe(true)
  })

  it('the net rate over a pad is +8.1 units/s — the number the route turns on', () => {
    // Holding station costs 1.9 and the pad pays 10, so a second parked over a
    // dartboard buys 4.3 seconds of flying somewhere else. Measured by stepping
    // the flight model with the throttle open, not by subtracting two constants.
    const spheres = refuelSpheresFor(INT01)
    const sphere = spheres[0]
    if (!sphere) throw new Error('no spheres')
    const seat = seatAt(sphere.centre.x, sphere.centre.y, sphere.centre.z)
    seat.live = true
    seat.fuel = 20
    const state = createRefuel(spheres)
    const input = noJumpSeatInput()
    input.throttle = 1
    const before = seat.fuel
    const seconds = 5
    for (let i = 0; i < Math.ceil(seconds / FIXED_DT); i++) {
      stepJumpSeat(seat, input, [], FIXED_DT)
      // The ship climbs out of the sphere on full throttle; this measures the
      // RATE, so hold it where the pad is.
      seat.body.position.x = sphere.centre.x
      seat.body.position.y = sphere.centre.y
      seat.body.position.z = sphere.centre.z
      stepJumpSeatRefuel(state, seat, seat.body.position, FIXED_DT)
    }
    expect((seat.fuel - before) / seconds).toBeCloseTo(8.1, 1)
  })

  it('picks the NEAREST sphere when two overlap', () => {
    const state = createRefuel([
      { centre: v3(0, 0, 0), radius: 20, rate: 10 },
      { centre: v3(10, 0, 0), radius: 20, rate: 10 },
    ])
    expect(refuelSphereAt(state, v3(9, 0, 0))).toBe(1)
    expect(refuelSphereAt(state, v3(1, 0, 0))).toBe(0)
    expect(refuelSphereAt(state, v3(100, 0, 0))).toBe(-1)
  })
})

describe('trap 19 — two seats, two tanks', () => {
  // `ai-racer.ts` shared one `HoverJetInput` across every racer and a finished
  // racer flew on with the other racer's stick until it went into the sea.
  // Invisible to every single-object test. So: step a SECOND one, assert the
  // first did not move.
  it('filling a second seat does not fill the first', () => {
    const spheres = refuelSpheresFor(INT01)
    const sphere = spheres[0]
    if (!sphere) throw new Error('no spheres')
    const a = seatAt(sphere.centre.x, sphere.centre.y, sphere.centre.z)
    const b = seatAt(sphere.centre.x, sphere.centre.y, sphere.centre.z)
    a.fuel = 30
    b.fuel = 70
    const stateA = createRefuel(spheres)
    const stateB = createRefuel(spheres)

    for (let i = 0; i < 100; i++) stepJumpSeatRefuel(stateA, a, a.body.position, FIXED_DT)
    const fuelA = a.fuel
    const addedA = stateA.added
    for (let i = 0; i < 400; i++) stepJumpSeatRefuel(stateB, b, b.body.position, FIXED_DT)

    expect(a.fuel).toBe(fuelA)
    expect(stateA.added).toBe(addedA)
    expect(stateB.added).toBeGreaterThan(addedA)
  })

  it('two states over ONE set of spheres stay independent', () => {
    // The sharper shape: the spheres are a shared, frozen input and the STATE is
    // per run. A `last`/`added` kept on the sphere list instead would look fine
    // with one run and cross-talk with two.
    const spheres = refuelSpheresFor(INT01)
    const sphere = spheres[0]
    if (!sphere) throw new Error('no spheres')
    const stateA = createRefuel(spheres)
    const stateB = createRefuel(spheres)
    const inside = seatAt(sphere.centre.x, sphere.centre.y, sphere.centre.z)
    const outside = seatAt(sphere.centre.x + 1e5, sphere.centre.y, sphere.centre.z)
    inside.fuel = 10
    outside.fuel = 10

    stepJumpSeatRefuel(stateA, inside, inside.body.position, FIXED_DT)
    stepJumpSeatRefuel(stateB, outside, outside.body.position, FIXED_DT)
    expect(stateA.last).toBe(0)
    expect(stateB.last).toBe(-1)
    expect(stateB.added).toBe(0)
    expect(outside.fuel).toBe(10)
  })
})
