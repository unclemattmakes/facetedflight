// tests/unit/jumpseat-refuel-bonus.test.ts — the tiered refuel 2016 authored
// and switched off (DEV-121).
//
// `Trigger_JumpTarget.cs:60-63` multiplies a pad's `refuelRate` by the plate's
// `refuelMultiplier` when `giveRefuelBonus` is set; it is set on no shipped
// plate. `applyRefuelBonus` is that line as a pure function, unwired. These
// tests pin what it does so the day it is wired the arithmetic is already
// measured — and pin that the SHIPPED state is a flat 10/s.

import { describe, expect, it } from 'vitest'
import { FIXED_DT } from '@/sim/constants'
import { createJumpSeat } from '@/sim/jumpseat'
import { applyRefuelBonus, createRefuel, stepJumpSeatRefuel } from '@/sim/jumpseat-refuel'
import { v3 } from '@/sim/math/vec3'

const spheres = () => [
  { centre: v3(0, 0, 0), radius: 20, rate: 10 },
  { centre: v3(500, 0, 0), radius: 20, rate: 10 },
]

/** Units a seat parked at `at` gains in one second of contact. */
const gainPerSecond = (state: ReturnType<typeof createRefuel>, at = v3(0, 0, 0)) => {
  const seat = createJumpSeat()
  seat.fuel = 0
  const steps = Math.round(1 / FIXED_DT)
  for (let i = 0; i < steps; i++) stepJumpSeatRefuel(state, seat, at, FIXED_DT)
  return seat.fuel
}

describe('the refuel bonus 2016 never switched on', () => {
  it('pays a flat rate x 1 until told otherwise — the shipped game', () => {
    const state = createRefuel(spheres())
    expect(gainPerSecond(state)).toBeCloseTo(10, 1)
  })

  it('a bullseye bonus of x3 pays three times as fast, on THAT pad only', () => {
    const state = createRefuel(spheres())
    applyRefuelBonus(state, 0, 3)
    expect(gainPerSecond(state, v3(0, 0, 0))).toBeCloseTo(30, 1)
    expect(gainPerSecond(state, v3(500, 0, 0))).toBeCloseTo(10, 1)
  })

  it('compounds the way `refuelRate *= multiplier` did', () => {
    const state = createRefuel(spheres())
    applyRefuelBonus(state, 0, 1.5)
    applyRefuelBonus(state, 0, 3)
    expect(gainPerSecond(state)).toBeCloseTo(45, 1)
  })

  it('ignores a sphere that does not exist and a multiplier that would stop the flow', () => {
    const state = createRefuel(spheres())
    applyRefuelBonus(state, 7, 3)
    applyRefuelBonus(state, 0, 0)
    applyRefuelBonus(state, 0, Number.NaN)
    expect(gainPerSecond(state)).toBeCloseTo(10, 1)
  })

  it('does not leak between two states (trap 19)', () => {
    const a = createRefuel(spheres())
    const b = createRefuel(spheres())
    applyRefuelBonus(a, 0, 3)
    expect(gainPerSecond(b)).toBeCloseTo(10, 1)
    expect(gainPerSecond(a)).toBeCloseTo(30, 1)
  })
})
