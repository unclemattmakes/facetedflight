// src/sim/rigidbody.ts — the one dynamic body. A deliberate reimplementation
// of Unity 5.4 / PhysX single-body semantics; there is no physics engine
// (PORT_PLAN §2.2, DECISIONS D3).

import { FIXED_DT } from './constants'
import { integrateAngularVelocity, type Quat, quat } from './math/quat'
import { scaleAdd, set, type Vec3, v3 } from './math/vec3'

export interface RigidBody {
  position: Vec3
  /** Unit quaternion, world-from-body. */
  orientation: Quat
  /** Linear velocity, world space, m/s. */
  velocity: Vec3
  /** Angular velocity, world space, rad/s. */
  angularVelocity: Vec3
  /** kg. HoverJet = 4, JumpSeat = 15 — both from the shipped prefabs. */
  mass: number
  /** Unity `Rigidbody.drag`. See `applyUnityDrag`. */
  drag: number
  /** Unity `Rigidbody.angularDrag`. */
  angularDrag: number
  /**
   * Unity `Rigidbody.useGravity`. The HoverJet flies with gravity OFF — it is
   * switched off by `LaunchElevator.FinishLaunch()`, so a HoverJet body that
   * has not launched yet still falls. Do not bake this to `false`.
   */
  useGravity: boolean
  /** Force accumulator for the current tick, world space, newtons. */
  force: Vec3
  /** Torque accumulator for the current tick, world space, N·m. */
  torque: Vec3
}

export const createRigidBody = (init: Partial<RigidBody> = {}): RigidBody => ({
  position: init.position ?? v3(),
  orientation: init.orientation ?? quat(),
  velocity: init.velocity ?? v3(),
  angularVelocity: init.angularVelocity ?? v3(),
  mass: init.mass ?? 1,
  drag: init.drag ?? 0,
  angularDrag: init.angularDrag ?? 0,
  useGravity: init.useGravity ?? true,
  force: init.force ?? v3(),
  torque: init.torque ?? v3(),
})

/**
 * Unity's per-step drag: `v *= clamp01(1 - drag * dt)`. NOT exponential decay,
 * NOT a quadratic drag force — a linear multiplier clamped at zero, which is
 * why terminal speed is `thrust / (mass * drag)` and why the 2016 HoverJet
 * tops out at 89.8 m/s (179.6 boosting). DECISIONS D5.
 */
export const unityDragFactor = (drag: number, dt: number): number => {
  const f = 1 - drag * dt
  return f < 0 ? 0 : f > 1 ? 1 : f
}

/**
 * Steady-state angular rate at full stick, rad/s: the fixed point of this
 * file's `integrate` for a constant torque `rate` against `angularDrag`.
 *
 * `integrate` does `ω += torque · dt` and then `ω *= (1 − angularDrag · dt)`,
 * with a scalar inertia of 1, and both vehicles feed `input.axis · rate` as
 * that torque. Solving the DISCRETE recurrence `ω = (ω + τ·dt)(1 − d·dt)` for
 * its fixed point gives
 *
 *     ω* = (τ / d) · (1 − d · dt)
 *
 * — the continuous answer `τ / d`, scaled down by one tick of drag.
 *
 * **That trailing factor is not pedantry and it is why this function takes a
 * `dt`.** The first version, in `render/vignette.ts`, wrote `τ / d`, which is
 * what the continuous-time algebra gives and what the comment above it claimed
 * the integrator did. It is 2.4 % high — 1.538 rad/s against the 1.5019 the
 * shipped integrator actually reaches — so the vignette would never have got
 * closer than 98 % of full closure no matter how hard you rolled. DEV-027
 * exactly. What caught it was the test in `comfort-vignette.test.ts` that does
 * not restate the algebra: it runs `stepHoverJet` with the stick pinned for
 * 1,000 ticks and measures where the body ends up.
 *
 * It lives HERE, beside the recurrence it solves, since DEV-380: it is
 * arithmetic on sim quantities, and the comfort vignette, the variant tests and
 * the hangar's HANDLING bar all read it, so there is one definition of it.
 */
export const fullStickRate = (rate: number, angularDrag: number, dt: number = FIXED_DT): number =>
  (rate / angularDrag) * (1 - angularDrag * dt)

/** Zero the force and torque accumulators. Call at the top of every tick. */
export const clearAccumulators = (body: RigidBody): void => {
  set(body.force, 0, 0, 0)
  set(body.torque, 0, 0, 0)
}

/**
 * Integrate one fixed step, semi-implicit Euler, in Unity's order:
 * force → velocity → drag → position. Anisotropic per-tick velocity edits
 * (the HoverJet's 4.5 % body-X / 6.5 % body-Y bleed — the signature feel)
 * happen in the vehicle module BETWEEN force accumulation and this call.
 * That ordering is the whole reason there is no physics engine here.
 *
 * `gravity` is world gravity: (0, -32, 0) in the 2016 project, not -9.81.
 */
export const integrate = (body: RigidBody, gravity: Readonly<Vec3>, dt: number): void => {
  const invMass = 1 / body.mass

  scaleAdd(body.velocity, body.velocity, body.force, invMass * dt)
  if (body.useGravity) scaleAdd(body.velocity, body.velocity, gravity, dt)

  const linear = unityDragFactor(body.drag, dt)
  body.velocity.x *= linear
  body.velocity.y *= linear
  body.velocity.z *= linear

  // Torque is treated as an angular acceleration source through a scalar
  // inertia of 1 for now. The real inertia tensor is one of the two things
  // the M1.5 oracle exists to measure (PORT_PLAN §3, M1.5) — it will arrive
  // as a `trust: "fitted"` constant with error bars, not as a guess here.
  scaleAdd(body.angularVelocity, body.angularVelocity, body.torque, dt)

  const angular = unityDragFactor(body.angularDrag, dt)
  body.angularVelocity.x *= angular
  body.angularVelocity.y *= angular
  body.angularVelocity.z *= angular

  scaleAdd(body.position, body.position, body.velocity, dt)
  integrateAngularVelocity(body.orientation, body.orientation, body.angularVelocity, dt)
}
