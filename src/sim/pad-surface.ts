// src/sim/pad-surface.ts — the JumpSeat lands on something. (DEV-120)
//
// Matt, 2026-09-16: *"jumpseat - the landing pads / targets have no collision!
// i just fall right through!"*
//
// ── What 2016 had ─────────────────────────────────────────────────────────
//
// One live solid collider per pad: a non-trigger, non-convex `MeshCollider` on
// `target_jumppad.prefab`'s `jumpPad_04_collider`, layer 0. The JumpSeat's
// `HoverMotor` mask has bit 0 set, so the hover ray hits it (the refuel and
// scoring triggers are on layer 2, which the mask clears — those the ray
// ignores). The seat's four `Player`-tagged leg capsules stand on it. Every
// other collider in the prefab is a trigger or hangs under an inactive object.
//
// The mesh is a stepped OCTAGONAL bowl, 40.6 m across at the shipped scale:
// three flat tiers with the CENTRE LOWEST — the bullseye floor 1.78 m below the
// pad root, the mid ring 0.35 m below, the outer ring 0.97 m above — each step
// about 1.4 m tall, plus an outer skirt. Every number here rides in on
// `level.pads[].solid` (`tools/extract/pad-solid.mjs` reads it off the FBX);
// this file has no literals of its own about the pad.
//
// ── Why a closed form and not a mesh or a grid ────────────────────────────
//
// The collider is 8-fold symmetric with a vertex on local +x (measured, not
// assumed: `pad-solid.mjs` checks a vertex ray against an edge ray). For a
// regular n-gon that makes "how far out is this point" one function —
// `ngonRadius` below — and the top surface one profile of that radius. So the
// surface is exact everywhere, a step wall is vertical, the rim is a hard edge
// with nothing hanging off it, and the sim never sees a triangle.
//
// It plugs into the existing ground rule through `HeightField.analytic`: the
// hover ray, the hull depenetration, the sprung legs and the proximity fan all
// take a `HeightField[]`, and `game/jumpseat-flight.ts` appends one of these per
// live pad. Nothing else in the sim changed to make a pad solid.
//
// ── The n-gon norm ────────────────────────────────────────────────────────
//
// A regular n-gon with circumradius R and a vertex at angle 0 has its edge
// midpoints at odd multiples of pi/n, each edge a line at distance R·cos(pi/n)
// from the centre. Reduce a point's angle into one sector, [0, 2pi/n), and its
// n-gon radius is |p| · cos(psi − pi/n) / cos(pi/n): equal to |p| on a vertex
// ray, |p| / cos(pi/n) on an edge ray, and R exactly on the boundary either way.
// Radii in `profile` are in this norm, which is what makes the profile a single
// polyline rather than one per direction.
//
// SIM LAYER: no three, no DOM, no wall clock, no allocation in the hot path.

import { type Quat, rotateVec3Inverse } from './math/quat'
import { v3 } from './math/vec3'
import type { AnalyticSurface, HeightField } from './terrain/height-field'

// Volatile module-level scratch: written and read inside ONE synchronous call
// of `localRadius`, never stored, never read across calls (trap 19).
const _offset = v3()
const _local = v3()

/** `level.pads[].solid`, already in SIM space. `game/jumpseat-flight.ts` converts. */
export interface PadSurfaceSpec {
  /** The collider node's world position, SIM space. Heights are relative to `y`. */
  readonly centre: { readonly x: number; readonly y: number; readonly z: number }
  /** The collider node's world orientation, SIM space. Yaw only on every shipped pad. */
  readonly orientation: Quat
  /** Rotational symmetry of the mesh. 8 on every shipped pad. */
  readonly symmetry: number
  /** `[radius, height]`, metres — radius in the n-gon norm, height above `centre.y`. */
  readonly profile: readonly (readonly [number, number])[]
  /** The last radius with surface under it. Beyond it there is no pad. */
  readonly outer: number
  /**
   * The mesh's lowest point, metres above `centre.y` (negative: below it).
   * `level.pads[].solid.bottom`. Below it a point is UNDER the pad, not inside
   * it (DEV-383, `belowField`). Absent, the pad is read as solid to the ground,
   * which is what every caller before DEV-383 got.
   */
  readonly bottom?: number
}

/**
 * The n-gon norm of a local (x, z) offset. See the header.
 *
 * `cosHalf` is `cos(pi / n)`, precomputed by the caller; the two-argument form
 * exists so the hot path does not call `Math.cos` on every sample.
 */
export const ngonRadius = (x: number, z: number, n: number, cosHalf: number): number => {
  const r = Math.hypot(x, z)
  if (r === 0) return 0
  const sector = (2 * Math.PI) / n
  const half = sector / 2
  let psi = Math.atan2(z, x) % sector
  if (psi < 0) psi += sector
  return (r * Math.cos(psi - half)) / cosHalf
}

/**
 * Piecewise-linear read of a radial profile. A vertical step is two points at
 * one radius, and a query landing exactly on it reads the HIGHER of the two —
 * a foot on the lip of a step stands on the step.
 *
 * Past the last point the profile is extended FLAT, and that is load-bearing:
 * whether the surface exists there is `inside`'s answer, and `terrainNormalAt`
 * takes its gradient from neighbours a few centimetres either side of a point
 * that IS inside — a neighbour just over the rim returning -Infinity made the
 * normal Infinity / Infinity, which is NaN, which put the seat at NaN, and a
 * NaN segment passes every slab test and scores every plate on the board. Found
 * on `adv_02_jumpSeat` at 45.7 s; a finite value here is the whole fix.
 */
export const profileHeight = (
  profile: readonly (readonly [number, number])[],
  r: number,
): number => {
  const first = profile[0]
  if (!first) return 0
  if (r <= first[0]) return first[1]
  for (let i = 1; i < profile.length; i++) {
    const a = profile[i - 1] as readonly [number, number]
    const b = profile[i] as readonly [number, number]
    if (r > b[0]) continue
    if (b[0] === a[0]) return Math.max(a[1], b[1])
    return a[1] + ((b[1] - a[1]) * (r - a[0])) / (b[0] - a[0])
  }
  return (profile[profile.length - 1] as readonly [number, number])[1]
}

/**
 * How far either side of a point the normal's gradient is taken, as a FRACTION
 * of the outer radius. 1/400 of a 20.3 m pad is 5 cm — small enough that a step
 * wall reads as a wall within a hand's width of its edge, large enough that
 * float noise on a flat tier does not tilt the normal. A ratio rather than a
 * length so a scaled pad (two dead ones ship at 18.6x) keeps the same behaviour
 * at its own size. Not a game constant; a numerical one, and this is why.
 */
const NORMAL_STEP_FRACTION = 1 / 400

/**
 * Build the pad as a `HeightField` the rest of the sim already understands.
 *
 * The rotation is applied INVERSELY to the query point (world -> pad local) so
 * a yawed pad's octagon turns with it; every shipped pad carries a yaw. Only the
 * y-rotation is meaningful for a heightfield — a pad tilted off horizontal is
 * not a heightfield at all — and the two `adv_02` pads with a 0.002 x-tilt are
 * read as flat, which is 0.1 degrees over 20 m: 3.5 cm at the rim.
 */
export const buildPadField = (spec: PadSurfaceSpec): HeightField => {
  const { centre, orientation, symmetry, profile, outer } = spec
  const cosHalf = Math.cos(Math.PI / symmetry)
  // World offset -> the pad's own frame, by the inverse of its orientation; the
  // local y is then dropped, which is what "read as flat" means above.
  const localRadius = (x: number, z: number): number => {
    _offset.x = x - centre.x
    _offset.y = 0
    _offset.z = z - centre.z
    rotateVec3Inverse(_local, orientation, _offset)
    return ngonRadius(_local.x, _local.z, symmetry, cosHalf)
  }
  const analytic: AnalyticSurface = {
    inside: (x, z) => localRadius(x, z) <= outer,
    heightAt: (x, z) => centre.y + profileHeight(profile, localRadius(x, z)),
    normalStep: outer * NORMAL_STEP_FRACTION,
    ...(spec.bottom !== undefined ? { underside: centre.y + spec.bottom } : {}),
  }
  return {
    analytic,
    // Placeholders: the accessors dispatch to `analytic` and never read these.
    vertPerSide: 1,
    heights: new Float32Array(1),
    step: outer,
    terrainSize: outer * 2,
    terrainHeight: 0,
    originX: centre.x - outer,
    originY: centre.y,
    originZ: centre.z - outer,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
  }
}
