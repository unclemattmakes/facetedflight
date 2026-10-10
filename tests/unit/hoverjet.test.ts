// tests/unit/hoverjet.test.ts — does the port fly like the 2016 game?
//
// These are the fidelity gates for M1. They assert against values DERIVED from
// the shipped prefab by `tools/extract/constants.mjs`, not against numbers
// typed here — so if someone retunes the ship, these fail for the right reason
// and the expected values move with the constants sheet.
//
// The three that matter:
//   1. Terminal speed cruising      — 89.81 m/s
//   2. Terminal speed boosting      — 179.62 m/s
//   3. Anisotropy, observed         — 4.12 : 1
//
// (3) is the feel. A ship that hits the right top speed with isotropic drag is
// a completely different vehicle: it slides through corners instead of biting.

import { describe, expect, it } from 'vitest'
import { DERIVED } from '@/generated/constants.generated'
import { FIXED_DT } from '@/sim/constants'
import { createHoverJet, type HoverJetInput, noInput, stepHoverJet } from '@/sim/hoverjet'
import { length } from '@/sim/math/vec3'

const fullThrottle = (over: Partial<HoverJetInput> = {}): HoverJetInput => ({
  ...noInput(),
  throttle: 1,
  ...over,
})

/** Run to steady state and return the speed it settles at. */
const settleSpeed = (boost: boolean, seconds = 60): number => {
  const jet = createHoverJet()
  const input = fullThrottle({ boost })
  const ticks = Math.round(seconds / FIXED_DT)
  for (let i = 0; i < ticks; i++) stepHoverJet(jet, input)
  return length(jet.body.velocity)
}

describe('HoverJet — terminal speed', () => {
  it('settles at the 2016 cruise speed of ~89.81 m/s', () => {
    const expected = DERIVED.hoverjet.terminalSpeedCruise
    expect(expected).toBeCloseTo(89.81, 1) // the sheet itself is sane
    expect(settleSpeed(false)).toBeCloseTo(expected, 2)
  })

  it('settles at the 2016 boost speed of ~179.62 m/s, exactly double', () => {
    const expected = DERIVED.hoverjet.terminalSpeedBoost
    expect(settleSpeed(true)).toBeCloseTo(expected, 2)
    // Boost is a clean 2x on thrust, and terminal speed is linear in thrust,
    // so the ratio must be exactly the boost multiplier.
    expect(settleSpeed(true) / settleSpeed(false)).toBeCloseTo(2, 6)
  })

  it('reaches full thrust in 0.25 s, not instantly', () => {
    const jet = createHoverJet()
    const input = fullThrottle()
    // One tick in, the engine must NOT already be at full thrust.
    stepHoverJet(jet, input)
    expect(jet.currentThrust).toBeLessThan(jet.tuning.maxSpeed)

    const ticksToFull = Math.ceil(1 / jet.tuning.acceleration / FIXED_DT)
    for (let i = 1; i < ticksToFull; i++) stepHoverJet(jet, input)
    expect(jet.currentThrust).toBeCloseTo(jet.tuning.maxSpeed, 6)
  })
})

describe('HoverJet — the signature anisotropic bleed', () => {
  // Measure the per-axis decay rate directly: give the ship a velocity purely
  // along one body axis with the engine off, and watch how fast it dies.
  const decayRatePerSecond = (axis: 'x' | 'y' | 'z'): number => {
    const jet = createHoverJet()
    const v0 = 100
    jet.body.velocity[axis] = v0

    const ticks = 10
    for (let i = 0; i < ticks; i++) stepHoverJet(jet, noInput())

    const v1 = jet.body.velocity[axis]
    // Continuous-time rate: v1 = v0 * e^(-rate * t)
    return -Math.log(v1 / v0) / (ticks * FIXED_DT)
  }

  it('bleeds sideways velocity ~4.98 /s (drift + drag)', () => {
    expect(decayRatePerSecond('x')).toBeCloseTo(DERIVED.bleed.observedRateBodyX, 3)
  })

  it('bleeds vertical velocity ~6.72 /s (lift + drag) — the fastest axis', () => {
    expect(decayRatePerSecond('y')).toBeCloseTo(DERIVED.bleed.observedRateBodyY, 3)
  })

  it('bleeds forward velocity only ~1.21 /s (plain Unity drag)', () => {
    expect(decayRatePerSecond('z')).toBeCloseTo(DERIVED.bleed.observedRateBodyZ, 3)
  })

  it('holds the 4.12 : 1 sideways-to-forward anisotropy that IS the feel', () => {
    const ratio = decayRatePerSecond('x') / decayRatePerSecond('z')
    expect(ratio).toBeCloseTo(DERIVED.bleed.anisotropyXZ, 2)
    // Guard the point rather than just the number: sideways must die several
    // times faster than forward, or the ship drifts like a boat.
    expect(ratio).toBeGreaterThan(3.5)
  })

  it('bleeds in BODY space, not world space', () => {
    // Rolled 90° about +Z, the ship's body-X points along world -Y. A world-space
    // implementation would decay world-X fastest; a body-space one decays
    // world-Y fastest. This is the test that catches the easy wrong version.
    const jet = createHoverJet()
    const s = Math.sin(Math.PI / 4)
    jet.body.orientation = { x: 0, y: 0, z: s, w: s } // +90° roll about Z
    jet.body.velocity = { x: 60, y: 60, z: 0 }

    for (let i = 0; i < 10; i++) stepHoverJet(jet, noInput())

    // Body-X (now world -Y) bleeds at the drift rate; body-Y (now world +X)
    // bleeds at the faster lift rate. So world-X must end up SMALLER.
    expect(Math.abs(jet.body.velocity.x)).toBeLessThan(Math.abs(jet.body.velocity.y))
  })
})

describe('HoverJet — gravity is gated on launch', () => {
  it('falls before launch', () => {
    const jet = createHoverJet()
    jet.launched = false
    for (let i = 0; i < 10; i++) stepHoverJet(jet, noInput())
    expect(jet.body.velocity.y).toBeLessThan(-1)
  })

  it('does not fall once launched — the 2016 ship flies with gravity off', () => {
    const jet = createHoverJet()
    jet.launched = true
    for (let i = 0; i < 100; i++) stepHoverJet(jet, noInput())
    expect(jet.body.velocity.y).toBeCloseTo(0, 6)
  })
})

describe('HoverJet — constants come from the sheet, not from here', () => {
  it('uses the shipped prefab values', () => {
    const { tuning, body } = createHoverJet()
    expect(body.mass).toBe(4)
    expect(body.drag).toBe(1.2)
    expect(body.angularDrag).toBe(1.95)
    expect(tuning.maxSpeed).toBe(437.5)
    expect(tuning.driftMultiplier).toBe(0.045)
    expect(tuning.liftMultiplier).toBe(0.065)
    expect(tuning.boostMultiplier).toBe(2)
  })

  it('runs at the Unity tick the constants were tuned against', () => {
    // 0.0121999998, the float32 actually serialised — not a rounded 0.0122.
    expect(FIXED_DT).toBeCloseTo(0.0122, 6)
    expect(1 / FIXED_DT).toBeCloseTo(81.967, 2)
  })
})
