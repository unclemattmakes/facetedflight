/**
 * Proof that the sim runs headless — no DOM, no canvas, no GPU. This is the
 * whole payoff of the sim/render split (PORT_PLAN §2.4): a trajectory
 * assertion that runs in milliseconds in CI.
 *
 * These are scaffold-level checks against closed-form answers, not the M1
 * golden trajectories. The real ones ("full throttle for 20 s reaches
 * 89.8 m/s") land with `hoverjet.ts` and read their numbers from the
 * GENERATED constants sheet, never from a literal typed into a test.
 */
import { describe, expect, it } from 'vitest'
import { WORLD } from '@/generated/constants.generated'
import { FIXED_DT, GRAVITY, TICK_RATE } from '@/sim/constants'
import { createClock, stepFixed } from '@/sim/integrator'
import { integrateAngularVelocity, quat, rotateVec3 } from '@/sim/math/quat'
import { length, v3 } from '@/sim/math/vec3'
import { createRigidBody, integrate, unityDragFactor } from '@/sim/rigidbody'

describe('fixed timestep', () => {
  it('comes from the generated sheet, not a literal: 0.0121999998 s = 81.967 Hz', () => {
    // Prose everywhere says "0.0122". TimeManager.asset serialises the float32
    // 0.0121999998, and the sim uses the number the game actually ran on.
    expect(FIXED_DT).toBe(WORLD.fixedDeltaTime)
    expect(FIXED_DT).toBeCloseTo(0.0122, 6)
    expect(TICK_RATE).toBeCloseTo(81.967, 3)
  })

  it('gravity is (0, -32, 0), from the generated sheet', () => {
    expect(GRAVITY.y).toBe(-32)
  })

  it('runs whole ticks and reports the leftover as the render alpha', () => {
    const clock = createClock()
    const ticks: number[] = []
    const alpha = stepFixed(clock, FIXED_DT * 2.5, (_dt, tick) => ticks.push(tick))
    expect(ticks).toEqual([1, 2])
    expect(alpha).toBeCloseTo(0.5, 6)
  })

  it('clamps a huge frame delta instead of spiralling', () => {
    const clock = createClock()
    let count = 0
    stepFixed(clock, 30, () => {
      count += 1
    })
    // 0.25 s of catch-up at 0.0122 s per tick.
    expect(count).toBe(Math.floor(0.25 / FIXED_DT))
  })
})

describe('unity drag', () => {
  it('is a clamped linear multiplier, not exponential decay', () => {
    expect(unityDragFactor(1.2, FIXED_DT)).toBeCloseTo(1 - 1.2 * FIXED_DT, 12)
    // A drag high enough to overshoot zero clamps rather than reversing.
    expect(unityDragFactor(1000, FIXED_DT)).toBe(0)
    expect(unityDragFactor(0, FIXED_DT)).toBe(1)
  })

  it('settles at the 2016 HoverJet terminal speed of ~89.8 m/s', () => {
    // HoverJet shape: 4 kg, drag 1.2, 437.5 N along +Z, gravity off.
    // Discrete fixed point of v ← (v + a·dt)·(1 − drag·dt) is
    // (a/drag)·(1 − drag·dt) = 91.146 × 0.98536 = 89.81 — which is where the
    // documented 89.8 m/s comes from. The continuous limit (91.1) is NOT the
    // shipped number, and this test is why.
    const body = createRigidBody({ mass: 4, drag: 1.2, useGravity: false })
    const gravity = v3(0, 0, 0)
    for (let i = 0; i < 20000; i++) {
      body.force.z = 437.5
      integrate(body, gravity, FIXED_DT)
      body.force.z = 0
    }
    expect(length(body.velocity)).toBeCloseTo(89.8, 1)
  })
})

describe('gravity is -32, not -9.81', () => {
  it('falls 32 m/s per second of free fall', () => {
    const body = createRigidBody({ mass: 15, drag: 0, useGravity: true })
    const gravity = v3(0, -32, 0)
    for (let i = 0; i < Math.round(1 / FIXED_DT); i++) integrate(body, gravity, FIXED_DT)
    expect(body.velocity.y).toBeCloseTo(-32, 1)
  })
})

describe('quaternion math', () => {
  it('rotates +Z to +X after a quarter turn about +Y', () => {
    const q = quat()
    const omega = v3(0, 1, 0)
    // First-order integration, so take it in small steps — one π/2 jump would
    // land at 76°, which is exactly the kind of error a sim hides for weeks.
    const steps = 4000
    for (let i = 0; i < steps; i++) integrateAngularVelocity(q, q, omega, Math.PI / 2 / steps)
    const out = rotateVec3(v3(), q, v3(0, 0, 1))
    expect(out.x).toBeCloseTo(1, 6)
    expect(out.y).toBeCloseTo(0, 6)
    expect(out.z).toBeCloseTo(0, 6)
  })
})
