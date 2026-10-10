// src/sim/hover-motor.ts — it is a HOVER jet.
//
// Matt: *"i want to say the old hoverjet had a 'hover force' that would push it
// off the ground a bit?"* It did, and it is the thing that makes a scrape a
// skim rather than a crash.
//
// ── What `HoverMotor.FixedUpdate` does ────────────────────────────────────
//
//   Ray ray = new Ray(transform.position, -transform.up);
//   if (Physics.Raycast(ray, out hit, hoverHeight * 2, layerMask)) {
//     if (!hit.collider.CompareTag("ShipCollider")) {
//       if (hit.distance <= hoverHeight) {
//         float p = (hoverHeight - hit.distance) / hoverHeight;
//         rb.AddForce(transform.up * (p * p) * hoverForce, ForceMode.Impulse);
//       }
//     }
//   }
//
// Four details, each of which changes the feel:
//
//  1. **The ray follows the ship's own -up**, not world down. Banked over a
//     slope it probes where the belly points, so the push comes off the surface
//     you are actually presenting to.
//  2. **`ForceMode.Impulse`**, not Force. That is a velocity change of `F/mass`
//     applied whole, every fixed step — not an acceleration. Treating it as a
//     force is a factor of `dt` out, which at 82 Hz is 82x too weak.
//  3. **Quadratic falloff.** `p*p`, so the push is gentle at the top of the
//     band and bites hard near the ground. A linear ramp feels mushy.
//  4. **The ray reaches twice as far as the force does.** Beyond `hoverHeight`
//     the raycast still hits — that is what drives `motorActivated` and the
//     ground dust — but no force is applied.
//
// ── The numbers, and the trap in them ────────────────────────────────────
//
//   C# initialisers    hoverForce 65    hoverHeight 3.5
//   SHIPPED PREFAB     hoverForce 3.5   hoverHeight 4
//
// The cardinal rule, and a nasty instance of it: the C#'s `hoverHeight` and the
// prefab's `hoverForce` are **the same number**, 3.5, in different fields. A
// misreading lands on a value that looks right in one place and is eighteen
// times too strong in the other.
//
// At the shipped 3.5 over a mass of 4, full strength is a 0.875 m/s velocity
// change per tick, which sustained at 81.967 Hz is about 72 m/s^2 — a bit over
// twice this world's gravity of 32. Enough to hold the ship off, not enough to
// fly on.
//
// ── What is NOT here ─────────────────────────────────────────────────────
//
// `ground_fx` is `{ref: null}` on the shipped prefab: no dust. And `DragHack`,
// which the motor toggles when the ray misses, is a separate component this does
// not model yet.
//
// SIM LAYER: no three, no DOM, no wall clock, no allocation in the hot path.

import { rotateVec3 } from './math/quat'
import { type Vec3, v3 } from './math/vec3'
import type { RigidBody } from './rigidbody'
import { belowField, type HeightField, outsideField, terrainHeightAt } from './terrain/height-field'

export interface HoverMotorSpec {
  /** Impulse magnitude at the ground, newton-seconds. Shipped: 3.5. */
  readonly hoverForce: number
  /** Band the force acts in, metres. Shipped: 4. The RAY reaches twice this. */
  readonly hoverHeight: number
}

const _up = v3()
const _probe = v3()
const UP_BODY: Vec3 = Object.freeze(v3(0, 1, 0)) as Vec3

/**
 * Distance from `origin` to the terrain along `-up`, or Infinity if the ray
 * misses inside `maxDistance`.
 *
 * A heightfield has no ray primitive, so this marches. `steps` at 0.5 m over the
 * shipped 8 m range, then one bisection pass — enough for a force whose falloff
 * is quadratic over four metres, and cheaper than being clever.
 */
export const rayToTerrain = (
  origin: Vec3,
  up: Vec3,
  fields: readonly HeightField[],
  maxDistance: number,
  steps = 16,
): number => {
  const groundAt = (t: number): number => {
    const px = origin.x - up.x * t
    const py = origin.y - up.y * t
    const pz = origin.z - up.z * t
    let below = false
    for (const field of fields) {
      if (outsideField(field, px, pz)) continue
      // A sample under a floating pad does not meet it (DEV-383).
      if (belowField(field, py)) continue
      if (py <= terrainHeightAt(field, px, pz)) {
        below = true
        break
      }
    }
    return below ? 1 : 0
  }
  if (groundAt(0) === 1) return 0

  let lo = 0
  let hi = -1
  const dt = maxDistance / steps
  for (let i = 1; i <= steps; i++) {
    const t = i * dt
    if (groundAt(t) === 1) {
      hi = t
      lo = t - dt
      break
    }
  }
  if (hi < 0) return Number.POSITIVE_INFINITY
  // Bisect to a few centimetres.
  for (let i = 0; i < 6; i++) {
    const mid = (lo + hi) / 2
    if (groundAt(mid) === 1) hi = mid
    else lo = mid
  }
  return hi
}

/**
 * How far off the ground this motor holds a body — "the hover engine's ride
 * height". DEV-158.
 *
 * Solve the motor for standstill. Each tick it adds `p^2 * hoverForce / mass`
 * of upward velocity at a distance `d`, where `p = (hoverHeight - d) /
 * hoverHeight`, and gravity takes `|g| * dt` back. They balance at
 *
 *   p^2 * hoverForce / mass = |g| * dt
 *   =>  d = hoverHeight * (1 - sqrt(|g| * dt * mass / hoverForce))
 *
 * `ForceMode.Impulse` is why `dt` does not divide the left-hand side and does
 * multiply the right (see the header, detail 2).
 *
 * **This is not a hypothesis.** The generated sheet already carries the same
 * arithmetic for the other vehicle — `derived.jumpseat.hoverEquilibriumHeight`,
 * 0.4922 m — and `tests/unit/hover-motor.test.ts` feeds this function the
 * JumpSeat's numbers and checks it reproduces that. The sheet is the oracle,
 * which is the only kind of check a derived number gets (DEV-027).
 *
 * The HoverJet flies with gravity OFF, so it never SETTLES here in flight; the
 * number is still the honest answer to "how high does its hover engine hold
 * it", and that is what the start grid stands at (`game/racer-grid.ts`).
 *
 * Returns 0 when the motor cannot lift the mass at all.
 */
export const hoverEquilibriumHeight = (
  spec: HoverMotorSpec,
  mass: number,
  gravityY: number,
  dt: number,
): number => {
  if (!(spec.hoverForce > 0)) return 0
  const ratio = (Math.abs(gravityY) * dt * mass) / spec.hoverForce
  return ratio >= 1 ? 0 : spec.hoverHeight * (1 - Math.sqrt(ratio))
}

export interface HoverMotorState {
  /** `motorActivated`: the ray found ground within twice `hoverHeight`. */
  active: boolean
  /** Distance to the surface along -up, or Infinity. */
  distance: number
}

export const createHoverMotor = (): HoverMotorState => ({
  active: false,
  distance: Number.POSITIVE_INFINITY,
})

/**
 * Apply one tick of hover.
 *
 * Called AFTER the flight model has moved the body and BEFORE terrain
 * collision: the whole point is to stop the ship reaching the ground, so it has
 * to act before the thing that resolves having reached it.
 */
export const stepHoverMotor = (
  state: HoverMotorState,
  body: RigidBody,
  fields: readonly HeightField[],
  spec: HoverMotorSpec,
): void => {
  // The ship's own up, which is what the ray follows.
  rotateVec3(_up, body.orientation, UP_BODY)
  _probe.x = body.position.x
  _probe.y = body.position.y
  _probe.z = body.position.z

  // The ray reaches twice as far as the force acts.
  const distance = rayToTerrain(_probe, _up, fields, spec.hoverHeight * 2)
  state.distance = distance
  state.active = Number.isFinite(distance)
  if (!state.active || distance > spec.hoverHeight) return

  const proportional = (spec.hoverHeight - distance) / spec.hoverHeight
  // Quadratic, and an IMPULSE: a velocity change of F/mass applied whole.
  const deltaV = (proportional * proportional * spec.hoverForce) / body.mass
  body.velocity.x += _up.x * deltaV
  body.velocity.y += _up.y * deltaV
  body.velocity.z += _up.z * deltaV
}
