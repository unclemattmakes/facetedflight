// tests/unit/hover-motor.test.ts — it is a HOVER jet.
//
// Matt, from memory: *"i want to say the old hoverjet had a 'hover force' that
// would push it off the ground a bit?"* It did, and it is the difference
// between a scrape and a skim.
//
// The four details that each change the feel, and each get a test: the ray
// follows the SHIP'S up rather than world down, the force is an IMPULSE rather
// than a force, the falloff is QUADRATIC, and the ray reaches TWICE as far as
// the force acts.
//
// Plus the numbers, which are the cardinal rule's nastiest instance yet.

import { describe, expect, it } from 'vitest'
import { DERIVED, HOVERJET, JUMPSEAT, WORLD } from '@/generated/constants.generated'
import {
  createHoverMotor,
  type HoverMotorSpec,
  hoverEquilibriumHeight,
  rayToTerrain,
  stepHoverMotor,
} from '@/sim/hover-motor'
import { v3 } from '@/sim/math/vec3'
import { createRigidBody } from '@/sim/rigidbody'
import type { FacetedTerrainParams } from '@/sim/terrain/faceted'
import { buildHeightField } from '@/sim/terrain/height-field'
import type { MapSampler, Rgb } from '@/sim/terrain/image-sampler'

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

/** Flat ground at y = 50. */
const FLAT = buildHeightField(flatMap(0.5), PARAMS, { position: [0, 0, 0], scale: [1, 1, 1] })
const GROUND = 50

const SPEC: HoverMotorSpec = { hoverForce: 3.5, hoverHeight: 4 }

const shipAt = (y: number) => {
  const b = createRigidBody({ mass: 4, drag: 1.2, angularDrag: 1.95, useGravity: false })
  b.position.x = 500
  b.position.z = 500
  b.position.y = y
  return b
}

describe('the numbers', () => {
  it('come off the PREFAB, and the trap is that they look swapped', () => {
    // `HoverMotor.cs` initialises `hoverForce = 65f` and `hoverHeight = 3.5f`.
    // The shipped prefab says force **3.5** and height **4** — and the C#'s
    // HEIGHT is the same number as the prefab's FORCE. A misreading lands on a
    // value that looks right in one field and is eighteen times too strong in
    // the other, which is about as booby-trapped as the cardinal rule gets.
    expect(HOVERJET.hoverMotor.hoverForce).toBe(3.5)
    expect(HOVERJET.hoverMotor.hoverHeight).toBe(4)
    expect(HOVERJET.hoverMotor.hoverForce).not.toBe(65)
    expect(HOVERJET.hoverMotor.componentEnabled).toBe(true)
  })

  it('is worth about twice gravity at full strength', () => {
    // 3.5 over a mass of 4 is a 0.875 m/s velocity change per tick; at 81.967 Hz
    // that is ~72 m/s^2 against this world's gravity of 32. Enough to hold the
    // ship off the ground, not enough to fly on — which is the point.
    const b = shipAt(GROUND)
    stepHoverMotor(createHoverMotor(), b, [FLAT], SPEC)
    expect(b.velocity.y).toBeCloseTo(3.5 / 4, 9)
  })
})

describe('the ray', () => {
  it('finds the ground straight down', () => {
    const d = rayToTerrain(v3(500, GROUND + 6, 500), v3(0, 1, 0), [FLAT], 8)
    expect(d).toBeCloseTo(6, 1)
  })

  it('returns Infinity when nothing is inside range', () => {
    const d = rayToTerrain(v3(500, GROUND + 100, 500), v3(0, 1, 0), [FLAT], 8)
    expect(d).toBe(Number.POSITIVE_INFINITY)
  })

  it("follows the SHIP'S up, not world down", () => {
    // Banked over, the ray probes where the belly points. A ray fixed to world
    // down would report the same distance at every attitude, and the push would
    // come off a surface the ship is not presenting to.
    const straight = rayToTerrain(v3(500, GROUND + 4, 500), v3(0, 1, 0), [FLAT], 20)
    // 45 degrees over: the same 4 m of altitude is 5.66 m along the tilted ray.
    const tilted = rayToTerrain(
      v3(500, GROUND + 4, 500),
      v3(Math.SQRT1_2, Math.SQRT1_2, 0),
      [FLAT],
      20,
    )
    expect(straight).toBeCloseTo(4, 1)
    expect(tilted).toBeCloseTo(4 * Math.SQRT2, 1)
  })

  it('reaches TWICE as far as the force acts', () => {
    // `Physics.Raycast(..., hoverHeight * 2, ...)` but `if (hit.distance <=
    // hoverHeight)`. The outer band is what drives `motorActivated` and the
    // ground dust; no force is applied there.
    const state = createHoverMotor()
    const b = shipAt(GROUND + 6) // inside 8, outside 4
    stepHoverMotor(state, b, [FLAT], SPEC)
    expect(state.active).toBe(true)
    expect(state.distance).toBeCloseTo(6, 1)
    expect(b.velocity.y).toBe(0)
  })
})

describe('the push', () => {
  const push = (height: number): number => {
    const b = shipAt(GROUND + height)
    stepHoverMotor(createHoverMotor(), b, [FLAT], SPEC)
    return b.velocity.y
  }

  it('does nothing above the band and everything at the ground', () => {
    expect(push(4.5)).toBe(0)
    expect(push(0)).toBeCloseTo(3.5 / 4, 9)
  })

  it('falls off QUADRATICALLY, not linearly', () => {
    // `p*p`, so the push is gentle at the top of the band and bites near the
    // ground. At the half-way point a linear ramp gives half; this gives a
    // quarter — and that difference is the whole feel of it.
    const full = push(0)
    const half = push(2)
    expect(half / full).toBeCloseTo(0.25, 2)
    expect(half / full).not.toBeCloseTo(0.5, 1)
  })

  it('is an IMPULSE — the same change every tick, not scaled by dt', () => {
    // `ForceMode.Impulse` is a velocity change of F/mass applied whole. Treating
    // it as a force would be a factor of dt out, which at 82 Hz is 82x too weak.
    // `stepHoverMotor` takes no dt at all, which is the point.
    const b = shipAt(GROUND)
    const state = createHoverMotor()
    stepHoverMotor(state, b, [FLAT], SPEC)
    const first = b.velocity.y
    stepHoverMotor(state, b, [FLAT], SPEC)
    expect(b.velocity.y - first).toBeCloseTo(first, 9)
  })

  it("pushes along the SHIP'S up, so a banked ship is shoved sideways", () => {
    // The force is `transform.up * ...`, not `Vector3.up * ...`. Rolled over a
    // slope, the motor shoves you off it laterally as well as vertically —
    // which is what lets a bank skim a hillside instead of digging in.
    const b = shipAt(GROUND)
    // Roll 45 degrees about Z: up tilts toward +X.
    const s = Math.sin(Math.PI / 8)
    const c = Math.cos(Math.PI / 8)
    b.orientation.x = 0
    b.orientation.y = 0
    b.orientation.z = s
    b.orientation.w = c
    stepHoverMotor(createHoverMotor(), b, [FLAT], SPEC)
    expect(Math.abs(b.velocity.x)).toBeGreaterThan(0.1)
    expect(b.velocity.y).toBeGreaterThan(0)
  })

  it('does nothing at all with no terrain loaded', () => {
    // The fields arrive after the ship does, so the first frames have none.
    const b = shipAt(GROUND)
    const state = createHoverMotor()
    stepHoverMotor(state, b, [], SPEC)
    expect(state.active).toBe(false)
    expect(b.velocity.y).toBe(0)
  })
})

// ── the ride height, and the sheet as its oracle (DEV-158) ───────────────

describe('the hover engine’s ride height', () => {
  // A DERIVED number needs the same provenance discipline as an extracted one
  // (DEV-027), and this one has an oracle the port did not write: the generated
  // sheet already carries the same solve for the OTHER vehicle. If
  // `hoverEquilibriumHeight` and `tools/extract` ever disagree about what
  // `HoverMotor` does, this is where it shows.
  it('reproduces the sheet’s own derived JumpSeat figure', () => {
    const ours = hoverEquilibriumHeight(
      {
        hoverForce: JUMPSEAT.hoverMotor.hoverForce,
        hoverHeight: JUMPSEAT.hoverMotor.hoverHeight,
      },
      JUMPSEAT.rigidbody.mass,
      WORLD.gravity.y,
      WORLD.fixedDeltaTime,
    )
    expect(ours).toBeCloseTo(DERIVED.jumpseat.hoverEquilibriumHeight, 4)
  })

  it('is the height at which the motor exactly cancels this world’s gravity', () => {
    // The definition, asserted as BEHAVIOUR rather than as arithmetic: take the
    // answer, run the motor's own quadratic on it, and the velocity it gains
    // must be the velocity gravity takes in one tick. True independently of how
    // either side computes it.
    const spec: HoverMotorSpec = {
      hoverForce: HOVERJET.hoverMotor.hoverForce,
      hoverHeight: HOVERJET.hoverMotor.hoverHeight,
    }
    const mass = HOVERJET.rigidbody.mass
    const d = hoverEquilibriumHeight(spec, mass, WORLD.gravity.y, WORLD.fixedDeltaTime)
    const p = (spec.hoverHeight - d) / spec.hoverHeight
    const gained = (p * p * spec.hoverForce) / mass
    expect(gained).toBeCloseTo(Math.abs(WORLD.gravity.y) * WORLD.fixedDeltaTime, 9)
    // And it is inside the band the force acts in, or it is not a ride height.
    expect(d).toBeGreaterThan(0)
    expect(d).toBeLessThan(spec.hoverHeight)
  })

  it('is zero when the motor cannot lift the mass at all', () => {
    expect(hoverEquilibriumHeight({ hoverForce: 0, hoverHeight: 4 }, 4, -32, 0.0122)).toBe(0)
    expect(hoverEquilibriumHeight({ hoverForce: 0.0001, hoverHeight: 4 }, 4, -32, 0.0122)).toBe(0)
  })
})
