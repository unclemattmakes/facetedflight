// tests/unit/jumpseat.test.ts — the JumpSeat, measured.
//
// Every assertion here is a DISTANCE, a SPEED, an EQUILIBRIUM, a RATIO or a
// TICK COUNT. There is not one quaternion assertion in the file, on purpose:
// this project has shipped four orientation bugs, three of them caught by Matt
// from a screenshot with 400+ green tests behind them, and the reason is that a
// quaternion assertion is your belief written twice. See "The orientation
// lesson" in `docs/DEVIATIONS.md`.
//
// The thrust axis is tested the same way. `thrustDirection` is (0, 1, 0) on the
// shipped prefab against the C# initialiser's (0, 0, 1), so the single most
// likely port error is a JumpSeat that flies FORWARD. What catches it here is
// not "assert the vector equals (0,1,0)" — it is stepping a seat at an arbitrary
// attitude and measuring which of its own axes the accumulated force lies along.
//
// Trap 19 runs through the whole file: `ai-racer.ts` shared one module-level
// scratch input across every racer, a finished racer inherited another racer's
// stick and flew into the sea, and no single-object test could have seen it.
// So every stateful behaviour below has a two-object variant, and there is a
// master interleave test that pins A and B against lone twins bit for bit.

import { describe, expect, it } from 'vitest'
import { DERIVED, JUMPSEAT, WORLD } from '@/generated/constants.generated'
import { FIXED_DT, GRAVITY } from '@/sim/constants'
import { createHoverJet, noInput, stepHoverJet } from '@/sim/hoverjet'
import {
  addFuel,
  createJumpSeat,
  createJumpSeatStart,
  hoverEquilibriumHeight,
  type JumpSeat,
  type JumpSeatInput,
  type JumpSeatStartSpec,
  noJumpSeatInput,
  startTotalSeconds,
  stepJumpSeat,
  stepJumpSeatStart,
} from '@/sim/jumpseat'
import type { Quat } from '@/sim/math/quat'
import { rotateVec3 } from '@/sim/math/quat'
import { type Vec3, v3 } from '@/sim/math/vec3'
import { createRigidBody, integrate } from '@/sim/rigidbody'
import type { FacetedTerrainParams } from '@/sim/terrain/faceted'
import { buildHeightField, type HeightField } from '@/sim/terrain/height-field'
import type { MapSampler, Rgb } from '@/sim/terrain/image-sampler'

// ── ground ────────────────────────────────────────────────────────────────

const flatMap = (g: number): MapSampler =>
  ({
    width: 256,
    height: 256,
    sample(_u: number, _v: number, out: Rgb): Rgb {
      out.r = g
      out.g = g
      out.b = g
      return out
    },
  }) as unknown as MapSampler

const PARAMS = {
  terrainSize: 1024,
  terrainHeight: 100,
  baseResolution: 8,
  chunkSize: 256,
  randomOffset: 0,
  seed: 1,
} as unknown as FacetedTerrainParams

/** Flat ground at y = 50, over a 1 km square. */
const FLAT: HeightField = buildHeightField(flatMap(0.5), PARAMS, {
  position: [0, 0, 0],
  scale: [1, 1, 1],
})
const GROUND = 50
const NO_GROUND: readonly HeightField[] = []

/**
 * `rayToTerrain` marches 16 steps over `2 * hoverHeight` and then bisects six
 * times, so the distance it reports is the true one plus up to
 * `2 * 6.25 / 16 / 2^6` = **0.0122 m**. Every measured-height tolerance below is
 * sized off that number rather than off what would make the test pass.
 */
const RAY_RESOLUTION = (2 * JUMPSEAT.hoverMotor.hoverHeight) / 16 / 2 ** 6

// ── helpers ───────────────────────────────────────────────────────────────

const live = (seat: JumpSeat): JumpSeat => {
  seat.live = true
  return seat
}

const at = (seat: JumpSeat, x: number, y: number, z: number): JumpSeat => {
  seat.body.position.x = x
  seat.body.position.y = y
  seat.body.position.z = z
  return seat
}

const withInput = (over: Partial<JumpSeatInput> = {}): JumpSeatInput => ({
  ...noJumpSeatInput(),
  ...over,
})

/** A unit quaternion for `angle` radians about a unit axis. Never asserted on. */
const aboutAxis = (ax: number, ay: number, az: number, angle: number): Quat => {
  const s = Math.sin(angle / 2)
  return { x: ax * s, y: ay * s, z: az * s, w: Math.cos(angle / 2) }
}

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v.x, v.y, v.z)
  return v3(v.x / l, v.y / l, v.z / l)
}
const dot3 = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z

const run = (
  seat: JumpSeat,
  input: JumpSeatInput,
  ticks: number,
  fields: readonly HeightField[] = NO_GROUND,
): void => {
  for (let i = 0; i < ticks; i++) stepJumpSeat(seat, input, fields, FIXED_DT)
}

// ── the constants ─────────────────────────────────────────────────────────

describe('the constants come off the PREFAB', () => {
  it('reads every tuning value from the sheet, none of them typed in', () => {
    const seat = createJumpSeat()
    expect(seat.body.mass).toBe(JUMPSEAT.rigidbody.mass)
    expect(seat.body.drag).toBe(JUMPSEAT.rigidbody.drag)
    expect(seat.body.angularDrag).toBe(JUMPSEAT.rigidbody.angularDrag)
    expect(seat.tuning.dragFreefall).toBe(JUMPSEAT.dragHack.drag_freefall)
    expect(seat.tuning.thrustForce).toBe(JUMPSEAT.thruster.thrustForce)
    expect(seat.tuning.boostMultiplier).toBe(JUMPSEAT.thruster.boostMultiplier)
    expect(seat.tuning.accelTime).toBe(JUMPSEAT.thruster.accelTime)
    expect(seat.tuning.rollRate).toBe(JUMPSEAT.orientation.rollRate)
    expect(seat.tuning.pitchRate).toBe(JUMPSEAT.orientation.pitchRate)
    expect(seat.tuning.yawRate).toBe(JUMPSEAT.orientation.yawRate)
    expect(seat.tuning.maxFuel).toBe(JUMPSEAT.fuel.maxFuel)
    expect(seat.tuning.burnRate).toBe(JUMPSEAT.fuel.burnRate)
    expect(seat.tuning.boostBurnRateMultiplier).toBe(JUMPSEAT.fuel.boostBurnRateMultiplier)
    expect(seat.hoverSpec.hoverForce).toBe(JUMPSEAT.hoverMotor.hoverForce)
    expect(seat.hoverSpec.hoverHeight).toBe(JUMPSEAT.hoverMotor.hoverHeight)
    expect(FIXED_DT).toBe(WORLD.fixedDeltaTime)
    expect(GRAVITY.y).toBe(-32)
  })

  it('is on the far side of every C#-initialiser trap this prefab sets', () => {
    // Hard rule 2, four instances on one vehicle. In each pair the LEFT number
    // is what the shipped prefab says and the RIGHT is what the `.cs` field
    // initialiser says — copy the initialiser and you get a plausible vehicle
    // that is wrong.
    expect(JUMPSEAT.thruster.thrustDirection).toEqual({ x: 0, y: 1, z: 0 }) // cs: (0,0,1)
    expect(JUMPSEAT.dragHack.drag_freefall).toBe(0.65) // cs: 0.3
    expect(JUMPSEAT.thruster.boostMultiplier).toBe(1.65) // cs: 1.5
    expect(JUMPSEAT.landingGear.landingGearActivationHeight).toBe(2.25) // cs: 5
    // And the prefab's OWN self-modification residue, which is inert: a `1001`
    // block with `m_ParentPrefab: 0` and a null target on every entry.
    expect(
      JUMPSEAT.prefabSelfModificationResidue.some(
        (r) => r.propertyPath === 'boostMultiplier' && r.value === 1.25,
      ),
    ).toBe(true)
  })

  it('starts the tank FULL, not at the prefab’s serialised zero', () => {
    // `FuelManager.cs:29-34` — `Start()` overwrites `currentFuel` with `maxFuel`.
    expect(JUMPSEAT.fuel.currentFuel).toBe(0)
    expect(createJumpSeat().fuel).toBe(JUMPSEAT.fuel.maxFuel)
  })

  it('ships with the Thruster and the HoverMotor OFF and the steering ON', () => {
    expect(JUMPSEAT.thruster.componentEnabled).toBe(false)
    expect(JUMPSEAT.hoverMotor.componentEnabled).toBe(false)
    expect(JUMPSEAT.dragHack.componentEnabled).toBe(false)
    expect(JUMPSEAT.orientation.componentEnabled).toBe(true)
    const seat = createJumpSeat()
    expect(seat.live).toBe(false)
    expect(seat.steerable).toBe(true)
  })

  it('has no speed chain, no anisotropic bleed and no Ship_HoverShip', () => {
    // The three things that make the HoverJet the HoverJet, and the reason the
    // two vehicles cannot share a step function.
    expect(JUMPSEAT.hasShipHoverShip).toBe(false)
    expect(JUMPSEAT.hasInputShip).toBe(false)
    expect('speedChain' in JUMPSEAT).toBe(false)
  })
})

// ── gravity ───────────────────────────────────────────────────────────────

describe('gravity', () => {
  it('is ON, always — the JumpSeat is a lander', () => {
    const seat = live(createJumpSeat())
    expect(seat.body.useGravity).toBe(true)
    run(seat, noJumpSeatInput(), 200)
    // Not "useGravity is still true" — a DISTANCE. It fell.
    expect(seat.body.position.y).toBeLessThan(-5)
    expect(seat.body.useGravity).toBe(true)
  })

  it('is the one thing the HoverJet does NOT have in flight', () => {
    // Same 200 ticks, same rest start, no input. The jet hangs; the seat falls.
    const jet = createHoverJet()
    for (let i = 0; i < 200; i++) stepHoverJet(jet, noInput(), FIXED_DT)
    expect(jet.body.position.y).toBeCloseTo(0, 9)
  })
})

// ── terminal speeds: the end-to-end number ────────────────────────────────

describe('terminal speeds', () => {
  it('falls at 28.70 m/s during the countdown — drag 1.1, no DragHack', () => {
    // Before GO the HoverMotor is off, so `DragHack` cannot be on either: the
    // seat falls the whole countdown at the base drag. 32/1.1 * (1 - 1.1*dt).
    const seat = createJumpSeat() // NOT live
    run(seat, noJumpSeatInput(), 4000)
    expect(-seat.body.velocity.y).toBeCloseTo(28.7005, 3)
    expect(seat.dragHackEnabled).toBe(false)
    expect(seat.body.drag).toBe(JUMPSEAT.rigidbody.drag)
  })

  it('falls at 48.84 m/s once live and coasting — the DragHack', () => {
    // Live, throttle closed, no ground under the ray: the hack comes on and
    // takes drag to 0.65. That 41 % less drag falling than climbing IS the
    // JumpSeat's "let go and drop" feel, and it is the whole reason the two
    // numbers in this describe block differ.
    const seat = live(createJumpSeat())
    run(seat, noJumpSeatInput(), 4000)
    expect(-seat.body.velocity.y).toBeCloseTo(48.8404, 3)
    expect(seat.dragHackEnabled).toBe(true)
    expect(seat.body.drag).toBe(JUMPSEAT.dragHack.drag_freefall)
  })

  it('climbs to the sheet’s own derived terminal rate, 16.144 m/s', () => {
    // The single strongest end-to-end check in the file: it exercises thrust,
    // the curve, mass, gravity and drag at once against a number the constants
    // sheet derives independently of this code.
    const seat = live(createJumpSeat())
    seat.burnsFuel = false // 52 s of tank would empty before terminal is reached
    run(seat, withInput({ throttle: 1 }), 4000)
    expect(seat.body.velocity.y).toBeCloseTo(DERIVED.jumpseat.terminalClimbRate, 2)
    // And the drag is the BASE one while climbing: gas >= 0.03 restores it.
    expect(seat.body.drag).toBe(JUMPSEAT.rigidbody.drag)
  })

  it('climbs at 45.29 m/s on full analog boost', () => {
    const seat = live(createJumpSeat())
    seat.burnsFuel = false
    run(seat, withInput({ throttle: 1, boost: 1 }), 4000)
    expect(seat.body.velocity.y).toBeCloseTo(45.293, 2)
  })

  it('is a FORCE, not a speed ceiling — half throttle is half the force', () => {
    // `thrustForce` is newtons, not `maxSpeed`. At half throttle the terminal
    // climb is not half of 16.144: it is (0.5*50 - 32)/1.1 * (1 - 1.1*dt), which
    // is a much smaller number, because gravity is subtracted AFTER the halving.
    const seat = live(createJumpSeat())
    seat.burnsFuel = false
    run(seat, withInput({ throttle: 0.5 }), 4000)
    const expected = ((0.5 * 50 - 32) / 1.1) * (1 - 1.1 * FIXED_DT)
    expect(seat.body.velocity.y).toBeCloseTo(expected, 1)
    expect(seat.body.velocity.y).toBeLessThan(DERIVED.jumpseat.terminalClimbRate / 2)
  })
})

// ── the hover equilibrium: a measured height ──────────────────────────────

describe('the hover motor', () => {
  it('agrees with the sheet on where the seat should hang', () => {
    // Derived, and held to the DEV-027 standard: this is the distance along the
    // body's own -up from the ship-root origin to the surface at which one tick
    // of hover impulse exactly cancels one tick of gravity.
    expect(hoverEquilibriumHeight(createJumpSeat())).toBeCloseTo(
      DERIVED.jumpseat.hoverEquilibriumHeight,
      4,
    )
  })

  it('SETTLES there — 0.492 m above flat ground, and stays', () => {
    // With the GEAR OFF, which is what this number is about. A seat with its
    // legs on parks on them, a metre higher, because the feet reach 1.3 m below
    // the ship-root origin and touch long before 0.49 m — see
    // `tests/unit/jumpseat-legs.test.ts`. The hover equilibrium is still the
    // number the model has to hit with nothing else under it, and it is still
    // what discriminates mass 15 from mass 16.
    const seat = live(at(createJumpSeat(), 500, GROUND + 3, 500))
    seat.legs = null
    run(seat, noJumpSeatInput(), 1500, [FLAT])

    const settled = seat.body.position.y - GROUND
    // The tolerance is the ray marcher's own bisection resolution (1.2 cm),
    // doubled — not a number chosen to make this pass.
    expect(settled).toBeCloseTo(DERIVED.jumpseat.hoverEquilibriumHeight, 1)
    expect(Math.abs(settled - DERIVED.jumpseat.hoverEquilibriumHeight)).toBeLessThan(
      2 * RAY_RESOLUTION,
    )

    // It DISCRIMINATES. Three ports that pass a "does it hover" smoke test land
    // somewhere else entirely:
    //   ForceMode.Force instead of Impulse -> 82x too weak, sinks to the ground
    //   linear falloff instead of quadratic -> 0.945 m
    //   the landing-gear-retracted mass of 16 -> 0.3034 m   (spec OQ-1)
    expect(settled).toBeGreaterThan(0.4) // excludes mass 16 by 0.10 m
    expect(settled).toBeLessThan(0.6) // excludes linear falloff by 0.35 m

    // And it HOLDS. A model that hunts passes a single-sample height check.
    let worst = 0
    for (let i = 0; i < 500; i++) {
      stepJumpSeat(seat, noJumpSeatInput(), [FLAT], FIXED_DT)
      worst = Math.max(worst, Math.abs(seat.body.position.y - GROUND - settled))
    }
    expect(worst).toBeLessThan(2 * RAY_RESOLUTION)
  })

  it('probes along the BODY’s -up, not world down', () => {
    // Banked 30 degrees over flat ground at a known world height, the slant
    // distance to the surface is h / cos 30 — 15 % longer than h. A world-down
    // implementation reports h and passes every level-flight test in this file.
    const h = 4
    const seat = live(at(createJumpSeat(), 500, GROUND + h, 500))
    seat.body.orientation = aboutAxis(0, 0, 1, Math.PI / 6)
    stepJumpSeat(seat, noJumpSeatInput(), [FLAT], FIXED_DT)

    const slant = h / Math.cos(Math.PI / 6)
    expect(seat.hover.distance).toBeGreaterThan(h + 0.4)
    expect(seat.hover.distance).toBeCloseTo(slant, 1)

    // And the push follows the body too: banked, it has a HORIZONTAL component.
    expect(Math.abs(seat.body.velocity.x)).toBeGreaterThan(0.01)
  })

  it('reaches twice as far as it pushes', () => {
    // The ray is `2 * hoverHeight` = 12.5 m; the force only acts inside 6.25 m.
    const near = live(at(createJumpSeat(), 500, GROUND + 9, 500))
    stepJumpSeat(near, noJumpSeatInput(), [FLAT], FIXED_DT)
    expect(near.hover.active).toBe(true) // the ray found it
    expect(near.hover.distance).toBeGreaterThan(JUMPSEAT.hoverMotor.hoverHeight)
    // Falling freely: the only velocity it has is one tick of gravity.
    expect(near.body.velocity.y).toBeCloseTo(-32 * FIXED_DT * (1 - 1.1 * FIXED_DT), 6)
  })
})

// ── the thrust axis: geometry, not rotation ───────────────────────────────

describe('thrust is along body +Y', () => {
  /** The accumulated force after one thrusting tick, as a unit vector. */
  const forceDirectionAt = (orientation: Quat): Vec3 => {
    const seat = live(createJumpSeat())
    seat.body.orientation = orientation
    // Two ticks: `accelCurve.Evaluate(0)` is 0, so the first applies nothing.
    run(seat, withInput({ throttle: 1 }), 2)
    return norm(seat.body.force)
  }

  it('lies along the ship’s own +Y at an arbitrary attitude', () => {
    // Pitched 37 degrees and rolled 23 — an attitude with no symmetry left to
    // hide behind, which is the lesson from the turn indicator.
    const o = aboutAxis(0.5488, 0.2194, 0.8066, 1.1)
    const dir = forceDirectionAt(o)
    const bodyUp = rotateVec3(v3(), o, v3(0, 1, 0))
    const bodyFwd = rotateVec3(v3(), o, v3(0, 0, 1))

    expect(dot3(dir, bodyUp)).toBeCloseTo(1, 6)
    // And NOT along +Z, which is where the C# initialiser's (0, 0, 1) would put
    // it and where a HoverJet-shaped port would put it.
    expect(Math.abs(dot3(dir, bodyFwd))).toBeLessThan(1e-6)
  })

  it('is the axis the HoverJet does NOT use', () => {
    const o = aboutAxis(0.5488, 0.2194, 0.8066, 1.1)
    const jet = createHoverJet()
    jet.body.orientation = o
    for (let i = 0; i < 2; i++) stepHoverJet(jet, { ...noInput(), throttle: 1 }, FIXED_DT)
    const jetDir = norm(jet.body.force)
    const bodyFwd = rotateVec3(v3(), o, v3(0, 0, 1))
    expect(dot3(jetDir, bodyFwd)).toBeCloseTo(1, 6)
    // The two vehicles' thrust directions are 90 degrees apart at the same pose.
    expect(Math.abs(dot3(jetDir, forceDirectionAt(o)))).toBeLessThan(1e-6)
  })

  it('sends a pitched seat the way its BELLY points, not the way its nose does', () => {
    // The observable consequence, as a displacement. Pitch the seat well over,
    // burn, and measure where it went: a +Y thruster pushes it along its own up
    // and a +Z thruster pushes it along its own nose, and at 60 degrees those
    // are far apart.
    const o = aboutAxis(1, 0, 0, Math.PI / 3)
    const seat = live(createJumpSeat())
    seat.body.orientation = o
    seat.burnsFuel = false
    run(seat, withInput({ throttle: 1 }), 400)

    const bodyUp = rotateVec3(v3(), o, v3(0, 1, 0))
    const bodyFwd = rotateVec3(v3(), o, v3(0, 0, 1))
    // Subtract the fall, so what is left is the thrust's own contribution.
    const fell = live(createJumpSeat())
    fell.body.orientation = o
    run(fell, noJumpSeatInput(), 400)
    // `fell` coasts on the freefall drag and the thruster on the base drag, so
    // this is not an exact superposition — but the two candidate directions are
    // 60 degrees apart and the sign of the projection settles it outright.
    const dx = seat.body.position.x - fell.body.position.x
    const dy = seat.body.position.y - fell.body.position.y
    const dz = seat.body.position.z - fell.body.position.z
    const delta = norm(v3(dx, dy, dz))
    expect(dot3(delta, bodyUp)).toBeGreaterThan(0.9)
    expect(dot3(delta, bodyFwd)).toBeLessThan(0.4)
  })

  it('answers the pitch stick the same way the HoverJet does', () => {
    // Not "the quaternion equals X" — where the NOSE ends up. Two vehicles that
    // disagree about which way the stick goes is the bug; the sign convention of
    // `JumpSeatInput` exists to make `src/input/` work for both unchanged.
    const seat = createJumpSeat()
    run(seat, withInput({ pitch: 1 }), 82)
    const jet = createHoverJet()
    for (let i = 0; i < 82; i++) stepHoverJet(jet, { ...noInput(), pitch: 1 }, FIXED_DT)

    const seatNose = rotateVec3(v3(), seat.body.orientation, v3(0, 0, 1))
    const jetNose = rotateVec3(v3(), jet.body.orientation, v3(0, 0, 1))
    expect(Math.abs(seatNose.y)).toBeGreaterThan(0.02)
    expect(Math.abs(jetNose.y)).toBeGreaterThan(0.02)
    expect(Math.sign(seatNose.y)).toBe(Math.sign(jetNose.y))
  })

  it('steers from spawn, before the thruster exists', () => {
    // `ShipOrientationManager.m_Enabled` is 1 on the prefab while the Thruster's
    // is 0, so the seat can be turned during the countdown and cannot be flown.
    const seat = createJumpSeat() // NOT live
    run(seat, withInput({ pitch: 1, throttle: 1 }), 82)
    expect(seat.appliedThrust).toBe(0)
    expect(Math.abs(rotateVec3(v3(), seat.body.orientation, v3(0, 0, 1)).y)).toBeGreaterThan(0.02)
  })
})

// ── the accel curve ───────────────────────────────────────────────────────

describe('the accel curve', () => {
  const ticksFor = (seconds: number) => Math.round(seconds / FIXED_DT)

  it('gives 55 % of full thrust in the first 20 % of the ramp', () => {
    // The curve's own middle knot: (0.19909659, 0.54586476). A LINEAR ramp over
    // the same 1.2 s would be at 0.199, which is 2.7x lower — so this is a shape
    // assertion that a lerp cannot pass.
    const seat = live(createJumpSeat())
    const key = JUMPSEAT.thruster.accelCurve.m_Curve[1]
    if (!key) throw new Error('accelCurve lost its middle key')
    run(seat, withInput({ throttle: 1 }), ticksFor(key.time * JUMPSEAT.thruster.accelTime))
    const fraction = seat.appliedThrust / JUMPSEAT.thruster.thrustForce

    // The band is one tick wide either side of the knot — `curveTime` advances in
    // 0.0122 s steps and the knot at 0.239 s does not land on one, so the last
    // evaluation before it is at 0.1932 rather than 0.1991. That is the model
    // being right about a fixed step, not the assertion being loose.
    expect(fraction).toBeGreaterThan(0.52)
    expect(fraction).toBeLessThan(0.56)
    expect(fraction).toBeCloseTo(key.value, 1)
    // A LINEAR ramp over the same 1.2 s would be at 0.193 here. The curve is
    // 2.7x that, and no tolerance this test could reasonably carry confuses the
    // two — which is the point of measuring at the knot.
    expect(fraction / key.time).toBeGreaterThan(2.5)
  })

  it('applies NOTHING on the first tick of a burn', () => {
    // `Evaluate(0)` is 0 and `currentTime` starts at 0, so the very first tick
    // of every burn is free. Small, real, and it falls out of the structure.
    const seat = live(createJumpSeat())
    run(seat, withInput({ throttle: 1 }), 1)
    expect(seat.appliedThrust).toBe(0)
  })

  it('freezes just under 750 N once the ramp is done', () => {
    const seat = live(createJumpSeat())
    seat.burnsFuel = false
    run(seat, withInput({ throttle: 1 }), ticksFor(3))
    expect(seat.appliedThrust).toBeLessThan(JUMPSEAT.thruster.thrustForce)
    expect(seat.appliedThrust).toBeGreaterThan(JUMPSEAT.thruster.thrustForce * 0.999)
    expect(seat.curveTime).toBeGreaterThanOrEqual(JUMPSEAT.thruster.accelTime)
  })

  it('RESTARTS the whole 1.2 s ramp on every throttle release', () => {
    // `Thruster.cs:68`, in `Update()`. This is the difference between an
    // integrator and a rate limiter, and a rate-limiter port passes everything
    // above and fails right here: it would resume at 750 N, not at 0.
    const seat = live(createJumpSeat())
    seat.burnsFuel = false
    run(seat, withInput({ throttle: 1 }), ticksFor(3))
    const spooled = seat.appliedThrust
    expect(spooled).toBeGreaterThan(700)

    run(seat, noJumpSeatInput(), 1)
    expect(seat.curveTime).toBe(0)
    expect(seat.appliedThrust).toBe(0)

    run(seat, withInput({ throttle: 1 }), 1)
    expect(seat.appliedThrust).toBe(0) // curve(0)
    run(seat, withInput({ throttle: 1 }), 1)
    expect(seat.appliedThrust).toBeLessThan(spooled * 0.1)
  })

  it('multiplies the OUTPUT by the throttle, not the ramp', () => {
    // Half throttle is half the force at every point on the SAME 1.2 s curve —
    // it is not a slower spool. Compare the two at the same point on the ramp.
    const full = live(createJumpSeat())
    const half = live(createJumpSeat())
    full.burnsFuel = false
    half.burnsFuel = false
    run(full, withInput({ throttle: 1 }), 30)
    run(half, withInput({ throttle: 0.5 }), 30)
    expect(half.curveTime).toBeCloseTo(full.curveTime, 12)
    expect(half.appliedThrust).toBeCloseTo(full.appliedThrust / 2, 9)
  })

  it('cuts thrust to 8 % on the way through the boost deadzone', () => {
    // `Thruster.cs:72-95`: above 0.05 the multiplier is `1.65 * raw`, below it
    // is a hard 1. So at raw 0.0501 the multiplier is 0.0827. Shipped, and a
    // candidate deviation row rather than something to reproduce silently.
    const seat = live(createJumpSeat())
    const dipped = live(createJumpSeat())
    seat.burnsFuel = false
    dipped.burnsFuel = false
    run(seat, withInput({ throttle: 1 }), 200)
    run(dipped, withInput({ throttle: 1 }), 200)
    run(seat, withInput({ throttle: 1 }), 1)
    run(dipped, withInput({ throttle: 1, boost: 0.0501 }), 1)
    expect(dipped.appliedThrust / seat.appliedThrust).toBeCloseTo(
      JUMPSEAT.thruster.boostMultiplier * 0.0501,
      3,
    )
  })
})

// ── the DragHack, as three states ─────────────────────────────────────────

describe('the DragHack', () => {
  it('is forced OFF inside the hover band, whatever the throttle says', () => {
    for (const throttle of [0, 1]) {
      const seat = live(at(createJumpSeat(), 500, GROUND + 3, 500))
      seat.dragHackEnabled = true
      seat.body.drag = seat.tuning.dragFreefall
      run(seat, withInput({ throttle }), 1, [FLAT])
      expect(seat.dragHackEnabled).toBe(false)
      expect(seat.body.drag).toBe(JUMPSEAT.rigidbody.drag)
    }
  })

  it('is forced ON when the ray misses', () => {
    const seat = live(createJumpSeat())
    run(seat, noJumpSeatInput(), 1)
    expect(seat.hover.active).toBe(false)
    expect(seat.dragHackEnabled).toBe(true)
    run(seat, noJumpSeatInput(), 1)
    expect(seat.body.drag).toBe(JUMPSEAT.dragHack.drag_freefall)
  })

  it('leaves it UNCHANGED in the hysteresis band, in both directions', () => {
    // Between `hoverHeight` and `2 * hoverHeight` the ray still hits but the
    // force does not act, and the "turn it off" branch is nested inside the
    // force's own test. A two-state port passes the two tests above and fails
    // this one — which is the only one that can tell them apart.
    for (const startState of [true, false]) {
      const seat = live(at(createJumpSeat(), 500, GROUND + 9, 500))
      seat.dragHackEnabled = startState
      run(seat, withInput({ throttle: 1 }), 1, [FLAT])
      expect(seat.hover.distance).toBeGreaterThan(JUMPSEAT.hoverMotor.hoverHeight)
      expect(seat.hover.distance).toBeLessThan(2 * JUMPSEAT.hoverMotor.hoverHeight)
      expect(seat.dragHackEnabled).toBe(startState)
    }
  })

  it('cannot come on before GO', () => {
    // The hack is switched by the HoverMotor and by nothing else, and the motor
    // is off until T+7.5 s. So the seat falls the entire countdown at 1.1.
    const seat = createJumpSeat() // NOT live
    run(seat, noJumpSeatInput(), 600)
    expect(seat.dragHackEnabled).toBe(false)
    expect(seat.body.drag).toBe(JUMPSEAT.rigidbody.drag)
  })
})

// ── fuel ──────────────────────────────────────────────────────────────────

describe('fuel', () => {
  const emptyAfter = (input: JumpSeatInput): number => {
    const seat = live(createJumpSeat())
    for (let i = 1; i <= 6000; i++) {
      stepJumpSeat(seat, input, NO_GROUND, FIXED_DT)
      if (!seat.thrusterEnabled) return i
    }
    return -1
  }

  it('lasts 52.6 s at full throttle and 22.4 s boosting', () => {
    // 100 / 1.9 and 100 / (1.9 * 2.35). Both to within one tick.
    expect(emptyAfter(withInput({ throttle: 1 })) * FIXED_DT).toBeCloseTo(52.6316, 1)
    expect(emptyAfter(withInput({ throttle: 1, boost: 1 })) * FIXED_DT).toBeCloseTo(22.3964, 1)
  })

  it('burns BINARY in boost while thrust is analog — they disagree', () => {
    // `FuelManager` charges the full 2.35x for any `boostVal > 0`; `Thruster`
    // only boosts above 0.05. A shipped bug, and a deviation row.
    const seat = live(createJumpSeat())
    run(seat, withInput({ throttle: 1, boost: 0.01 }), 100)
    const burned = JUMPSEAT.fuel.maxFuel - seat.fuel
    expect(burned).toBeCloseTo(
      JUMPSEAT.fuel.burnRate * JUMPSEAT.fuel.boostBurnRateMultiplier * 100 * FIXED_DT,
      6,
    )
  })

  it('burns NOTHING with the throttle closed', () => {
    const seat = live(createJumpSeat())
    run(seat, withInput({ boost: 1 }), 500)
    expect(seat.fuel).toBe(JUMPSEAT.fuel.maxFuel)
  })

  it('LATCHES the thruster off, and the seat then falls', () => {
    const seat = live(createJumpSeat())
    const n = emptyAfter(withInput({ throttle: 1 }))
    expect(n).toBeGreaterThan(0)
    // Re-run to the empty point and keep the throttle pinned.
    run(seat, withInput({ throttle: 1 }), n)
    expect(seat.thrusterEnabled).toBe(false)
    const vAtEmpty = seat.body.velocity.y
    for (let i = 0; i < 500; i++) {
      stepJumpSeat(seat, withInput({ throttle: 1 }), NO_GROUND, FIXED_DT)
      expect(seat.appliedThrust).toBe(0)
    }
    // A "reduce thrust when low" port matches the timing and fails this: with
    // gravity on, an empty tank is a fall, not a soft penalty.
    expect(seat.body.velocity.y).toBeLessThan(vAtEmpty - 10)
  })

  it('keeps DIGGING below zero while the throttle is held', () => {
    // `FuelManager.UpdateFuel()` guards the burn on `gasVal > 0` and on nothing
    // else, so a dead tank keeps draining — and a refuel pad at 10 units/s has
    // to pay that back before the thruster comes on at all. Verified against
    // `FuelManager.cs:61-86`; the spec did not record it.
    const seat = live(createJumpSeat())
    run(seat, withInput({ throttle: 1 }), 5000)
    expect(seat.fuel).toBeLessThan(-10)
    expect(seat.thrusterEnabled).toBe(false)
  })

  it('comes back only through AddFuel — and one unit buys one tick', () => {
    const seat = live(createJumpSeat())
    run(seat, withInput({ throttle: 1 }), 5000)
    expect(seat.fuel).toBeLessThan(-10)

    // A single unit into a deeply negative tank: `AddFuel` re-enables the
    // Thruster unconditionally and the next tick's empty check switches it
    // straight back off. That is 2016, exactly.
    addFuel(seat, 1)
    expect(seat.thrusterEnabled).toBe(true)
    run(seat, withInput({ throttle: 1 }), 1)
    expect(seat.thrusterEnabled).toBe(false)

    // A pad's worth (10/s for long enough) gets it flying again.
    addFuel(seat, 40)
    run(seat, withInput({ throttle: 1 }), 60)
    expect(seat.thrusterEnabled).toBe(true)
    expect(seat.appliedThrust).toBeGreaterThan(0)
  })

  it('does not burn at all in Free Flight', () => {
    const seat = live(createJumpSeat())
    seat.burnsFuel = false
    run(seat, withInput({ throttle: 1, boost: 1 }), 6000)
    expect(seat.fuel).toBe(JUMPSEAT.fuel.maxFuel)
    expect(seat.thrusterEnabled).toBe(true)
  })
})

// ── the countdown ─────────────────────────────────────────────────────────

describe('Trigger_EnableJumpShip', () => {
  const SPEC: JumpSeatStartSpec = { triggerDelaySeconds: 3.5, countdownSeconds: 4 }

  it('holds the thruster for 7.5 s and then lets go, once', () => {
    expect(startTotalSeconds(SPEC)).toBeCloseTo(7.5, 9)

    const start = createJumpSeatStart()
    const seat = createJumpSeat()
    let goTick = -1
    for (let i = 1; i <= 900; i++) {
      if (stepJumpSeatStart(start, SPEC, FIXED_DT)) {
        expect(goTick).toBe(-1) // fires exactly once
        goTick = i
        seat.live = true
      }
      stepJumpSeat(seat, withInput({ throttle: 1 }), NO_GROUND, FIXED_DT)
      if (goTick < 0) expect(seat.appliedThrust).toBe(0)
    }
    expect(goTick).toBe(Math.ceil(7.5 / FIXED_DT))
    expect(seat.appliedThrust).toBeGreaterThan(0)
  })

  it('means the seat FALLS 190 m before it can do anything about it', () => {
    // 7.5 s from rest under gravity 32 and drag 1.1. Spec OQ-5 puts it at
    // 189.6 m arriving at 28.69 m/s — worth pinning, because if a respawn marker
    // is not that far above the ground the mission starts with an impact.
    const seat = createJumpSeat()
    run(seat, withInput({ throttle: 1 }), Math.ceil(7.5 / FIXED_DT))
    expect(-seat.body.position.y).toBeCloseTo(189.6, 0)
    expect(-seat.body.velocity.y).toBeCloseTo(28.69, 1)
  })
})

// ── TRAP 19 ───────────────────────────────────────────────────────────────

describe('trap 19 — step a SECOND one', () => {
  // `ai-racer.ts` shared one module-level `HoverJetInput` across every racer.
  // `autopilotActions` wrote all six fields and the finished branch wrote two,
  // so a finished racer flew on with the OTHER racer's stick, frozen, until it
  // went into the sea. Invisible to every single-object test, because with one
  // object there is nobody to inherit from.

  const snapshot = (s: JumpSeat) => ({
    p: { ...s.body.position },
    v: { ...s.body.velocity },
    q: { ...s.body.orientation },
    w: { ...s.body.angularVelocity },
    curveTime: s.curveTime,
    thrust: s.appliedThrust,
    fuel: s.fuel,
    drag: s.body.drag,
    hack: s.dragHackEnabled,
  })

  it('leaves an idle seat completely alone while another one flies', () => {
    const flying = live(createJumpSeat())
    const idle = live(createJumpSeat())
    idle.body.orientation = aboutAxis(1, 0, 0, 0.4)
    const before = snapshot(idle)

    for (let i = 0; i < 500; i++) {
      stepJumpSeat(flying, withInput({ throttle: 1, boost: 1, pitch: 1, roll: -1 }), NO_GROUND)
      // `idle` is stepped too — the bug is not "never stepped", it is
      // "stepped and inherited the other one's state".
      stepJumpSeat(idle, noJumpSeatInput(), NO_GROUND)
    }
    expect(idle.curveTime).toBe(0)
    expect(idle.appliedThrust).toBe(0)
    expect(idle.fuel).toBe(JUMPSEAT.fuel.maxFuel)
    // It fell, and it fell straight: no roll, no pitch, no sideways drift.
    expect(idle.body.position.x).toBe(before.p.x)
    expect(idle.body.position.z).toBe(before.p.z)
    expect(idle.body.angularVelocity.x).toBe(0)
    expect(idle.body.angularVelocity.y).toBe(0)
    expect(idle.body.angularVelocity.z).toBe(0)
  })

  it('gives interleaved seats the SAME trajectories as lone twins, bit for bit', () => {
    // The general form. Two seats with different inputs, stepped alternately,
    // against two identically-configured seats stepped alone. Any shared
    // module-level scratch shows up as a difference in one of the four.
    const inputA = withInput({ throttle: 1, boost: 0.7, pitch: 0.6, yaw: -0.3, roll: 0.9 })
    const inputB = withInput({ throttle: 0.25, boost: 0, pitch: -1, yaw: 0.8, roll: -0.4 })

    const a = live(at(createJumpSeat(), 500, GROUND + 8, 500))
    const b = live(at(createJumpSeat(), 500, GROUND + 2, 500))
    b.body.orientation = aboutAxis(0, 0, 1, 0.5)
    for (let i = 0; i < 800; i++) {
      stepJumpSeat(a, inputA, [FLAT])
      stepJumpSeat(b, inputB, [FLAT])
    }

    const aAlone = live(at(createJumpSeat(), 500, GROUND + 8, 500))
    for (let i = 0; i < 800; i++) stepJumpSeat(aAlone, inputA, [FLAT])
    const bAlone = live(at(createJumpSeat(), 500, GROUND + 2, 500))
    bAlone.body.orientation = aboutAxis(0, 0, 1, 0.5)
    for (let i = 0; i < 800; i++) stepJumpSeat(bAlone, inputB, [FLAT])

    expect(snapshot(a)).toEqual(snapshot(aAlone))
    expect(snapshot(b)).toEqual(snapshot(bAlone))
  })

  it('does not let a fuelled seat refill an empty one, or the reverse', () => {
    const empty = live(createJumpSeat())
    run(empty, withInput({ throttle: 1 }), 5000)
    expect(empty.thrusterEnabled).toBe(false)

    const fresh = live(createJumpSeat())
    fresh.burnsFuel = false
    for (let i = 0; i < 200; i++) {
      stepJumpSeat(fresh, withInput({ throttle: 1 }), NO_GROUND)
      stepJumpSeat(empty, withInput({ throttle: 1 }), NO_GROUND)
    }
    expect(empty.thrusterEnabled).toBe(false)
    expect(empty.appliedThrust).toBe(0)
    expect(fresh.fuel).toBe(JUMPSEAT.fuel.maxFuel)
    expect(fresh.appliedThrust).toBeGreaterThan(0)
  })

  it('keeps two countdowns independent', () => {
    const early = createJumpSeatStart()
    const late = createJumpSeatStart()
    const SPEC: JumpSeatStartSpec = { triggerDelaySeconds: 3.5, countdownSeconds: 4 }
    for (let i = 0; i < 300; i++) stepJumpSeatStart(early, SPEC, FIXED_DT)
    for (let i = 0; i < 400; i++) {
      stepJumpSeatStart(early, SPEC, FIXED_DT)
      stepJumpSeatStart(late, SPEC, FIXED_DT)
    }
    expect(early.live).toBe(true)
    expect(late.live).toBe(false)
    expect(late.elapsed).toBeCloseTo(400 * FIXED_DT, 9)
  })
})

// ── the legs ──────────────────────────────────────────────────────────────

describe('the landing gear', () => {
  it('stands on a 3.00 m beam and an ASYMMETRIC 3.04 m wheelbase', () => {
    // The turn-indicator shape of check. A mirror in x, or a wrong-handed
    // import, preserves the left/right symmetry perfectly and breaks the
    // fore/aft offset — so the asymmetry is the half that can catch it.
    const xs = JUMPSEAT.legs.map((l) => l.composedPosition.x)
    const zs = JUMPSEAT.legs.map((l) => l.composedPosition.z)
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(3.0, 6)
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(3.04, 6)
    expect(Math.min(...zs)).toBeCloseTo(-1.48, 6)
    expect(Math.max(...zs)).toBeCloseTo(1.56, 6)
    expect(Math.abs(Math.min(...zs))).not.toBeCloseTo(Math.max(...zs), 3)
  })

  it('is four HingeJoints with the limits switched OFF', () => {
    expect(JUMPSEAT.legs).toHaveLength(4)
    for (const leg of JUMPSEAT.legs) {
      expect(leg.useSpring).toBe(true)
      expect(leg.useLimits).toBe(false) // so the -35..80 / -35..150 never apply
      expect(leg.useMotor).toBe(false)
      expect(leg.rigidbody.mass).toBe(0.25)
    }
  })

  it('IS modelled, and the chassis mass is still 15 kg, not 16', () => {
    // Matt, 2026-09-12: the legs are springy, they sag in the air and they
    // cushion the landings — so they are simulated (`sim/jumpseat-legs.ts`,
    // `tests/unit/jumpseat-legs.test.ts`) and they are always deployed.
    //
    // That does NOT put 1 kg on the chassis. The four legs are separate
    // `Rigidbody`s on `HingeJoint`s and a jointed child's mass does not add to
    // its parent's in Unity; the 15/16 swap is `LandingGearManager` MOVING a
    // kilogram when it retracts, and it never retracts.
    //
    // OQ-1 underneath it: `LandingGearManager`'s world-down ray starts at the
    // ship-root origin, which is INSIDE `collider_body` `&144294` (layer 25,
    // included in `DefaultRaycastLayers`); Unity 5.4 / PhysX report distance 0
    // for that, so the `< 2.25` branch is taken, `landingGearActivated` is
    // already 1 on the prefab, and nothing ever runs.
    //
    // THE ONE CONSTANT THAT FLIPS IT: if that reading is wrong, the chassis is
    // 15 + 4 * 0.25 = 16 kg airborne, thrust accel drops 50 -> 46.875, and the
    // hover equilibrium drops 0.4922 -> 0.3034 m. See `sim/jumpseat.ts`'s header.
    const seat = createJumpSeat()
    expect(seat.legs).not.toBeNull()
    expect(seat.legs?.legs).toHaveLength(4)
    expect(seat.body.mass).toBe(15)
    // The prefab ships the gear DEPLOYED. (The sheet carries this one as the
    // serialised `1` rather than a boolean — an extractor inconsistency with
    // `componentEnabled`, noted, not this file's to fix.)
    expect(JUMPSEAT.landingGear.landingGearActivated).toBe(1)
    const retracted = 15 + 4 * 0.25
    expect(retracted).toBe(16)
    expect(seat.body.mass).not.toBe(retracted)

    // And the model is CONSISTENT with the sheet's derived numbers, all four of
    // which were derived at 15 kg.
    expect(JUMPSEAT.thruster.thrustForce / seat.body.mass).toBeCloseTo(
      DERIVED.jumpseat.accelFromThrust,
      9,
    )
    expect(JUMPSEAT.thruster.thrustForce / retracted).toBeCloseTo(46.875, 9)
  })
})

// ── the gate the whole port hangs on ──────────────────────────────────────

describe('the integrator seam', () => {
  it('never sees a frame delta', () => {
    // Two seats, same input, one stepped at the default and one at an explicit
    // FIXED_DT: identical. `stepJumpSeat` takes `dt` for testability only —
    // production passes the fixed step and nothing else (D4).
    const a = live(createJumpSeat())
    const b = live(createJumpSeat())
    for (let i = 0; i < 300; i++) {
      stepJumpSeat(a, withInput({ throttle: 1 }), NO_GROUND)
      stepJumpSeat(b, withInput({ throttle: 1 }), NO_GROUND, FIXED_DT)
    }
    expect(a.body.position).toEqual(b.body.position)
  })

  it('matches a hand-integrated free fall to the bit, pre-GO', () => {
    // The countdown path is only gravity and drag, so an independent
    // integration of the same body has to agree exactly. If it does not, the
    // gate is doing something it should not.
    const seat = createJumpSeat()
    const ref = createRigidBody({
      mass: JUMPSEAT.rigidbody.mass,
      drag: JUMPSEAT.rigidbody.drag,
      angularDrag: JUMPSEAT.rigidbody.angularDrag,
      useGravity: true,
    })
    for (let i = 0; i < 400; i++) {
      stepJumpSeat(seat, withInput({ throttle: 1, boost: 1 }), NO_GROUND)
      integrate(ref, GRAVITY, FIXED_DT)
    }
    expect(seat.body.position.y).toBe(ref.position.y)
    expect(seat.body.velocity.y).toBe(ref.velocity.y)
  })
})
