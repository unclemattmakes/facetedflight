// src/content/course-spline.ts — the player course's path: an open Catmull-Rom
// curve through the author's control points, and arc-length placement along
// it. DEV-466, E0 (docs/plan/EDITOR.md §5.1).
//
// ── Lifted from king-tide, read-only, and what changed ────────────────────
//
// `$FF2_REF/king-tide/src/game/tracks/catmull-rom.ts` — `catmullRomPoint` and
// `blend` are copied as they stand (uniform Catmull-Rom in Hermite form, with
// a tension; 0.5 is the canonical basis), and so is `wrap`'s open-curve half.
// Changed:
//   - OPEN only. king-tide's tracks are closed loops; a Faceted Flight course
//     runs from a start to a finish, so the loop-closing segment and the
//     modulo wrap are gone, and the sampler EMITS THE LAST CONTROL POINT
//     (king-tide's open branch stops one sample short of it, which on a loop
//     is the first point again and on a line is the finish).
//   - Every sample carries its curve PARAMETER, so a tangent is the analytic
//     derivative of the same Hermite form (`hermiteSlope`, new) rather than a
//     chord between two samples — the ring's facing is the curve's direction,
//     not a polyline's.
//   - Vectors are the sim's `{ x, y, z }` (`sim/math/vec3.ts`), and lengths use
//     `Math.sqrt` of a sum rather than `Math.hypot`: the lap server will run
//     this file (E6), and a square root is correctly rounded by IEEE 754 in
//     every engine where `hypot` is only "an approximation".
//
// `$FF2_REF/king-tide/src/game/tracks/gate-placement.ts` — `resampleByArcLength`:
// the cumulative arc table and the segment walk that turns a distance into a
// place on the polyline are kept. Changed:
//   - 3D arc length, not xz. A HoverJet course climbs, and a gap the author set
//     in metres is metres flown.
//   - A FIXED spacing from a start distance, not a count rounded to close a
//     loop evenly: 2016 cloned rings along its Curvy path at a spacing, and an
//     open course has no seam to hide a remainder in.
//
// Pure: no three, no DOM, no clock. It sits in `src/content/` beside the
// format it serves, and the sim may import it.

import type { Vec3 } from '@/sim/math/vec3'

export interface CourseSplineOptions {
  /** Polyline samples per control-point segment. */
  readonly divisionsPerSegment: number
  /** 0.5 is the canonical uniform Catmull-Rom basis. */
  readonly tension: number
  /**
   * DEV-501: the curve's direction LEAVING its first control point, a unit
   * vector, where something outside the curve sets it (an anchored course's
   * pad heading). Absent: the open basis's own clamp, toward the second point.
   * Its size is the default's, so only the direction changes.
   */
  readonly startTangent?: Vec3
}

/**
 * The curve, sampled densely once and measured.
 *
 * `samples[i]` is at arc distance `arc[i]` from the first control point and at
 * curve parameter `param[i]`, which runs 0 .. `controls.length - 1` (segment
 * index plus the local u).
 */
export interface CourseSpline {
  readonly controls: readonly Vec3[]
  readonly tension: number
  /** DEV-501: `CourseSplineOptions.startTangent`, kept so the slope agrees with the samples. */
  readonly startTangent?: Vec3
  readonly samples: readonly Vec3[]
  readonly arc: Float64Array
  readonly param: Float64Array
  /** Total arc length, metres. */
  readonly length: number
}

// ── king-tide's Catmull-Rom, open ─────────────────────────────────────────

function wrap(i: number, n: number): number {
  return Math.max(0, Math.min(n - 1, i))
}

function blend(
  v0: number,
  v1: number,
  v2: number,
  v3: number,
  t: number,
  t2: number,
  t3: number,
  k: number,
): number {
  // Hermite form: h00*p1 + h10*m1 + h01*p2 + h11*m2 with
  // m1 = k*(p2 - p0), m2 = k*(p3 - p1).
  const h00 = 2 * t3 - 3 * t2 + 1
  const h10 = t3 - 2 * t2 + t
  const h01 = -2 * t3 + 3 * t2
  const h11 = t3 - t2
  const m1 = k * (v2 - v0)
  const m2 = k * (v3 - v1)
  return h00 * v1 + h10 * m1 + h01 * v2 + h11 * m2
}

/** d/dt of `blend`: the same Hermite basis, differentiated. New in this port. */
function hermiteSlope(
  v0: number,
  v1: number,
  v2: number,
  v3: number,
  t: number,
  k: number,
): number {
  const t2 = t * t
  const d00 = 6 * t2 - 6 * t
  const d10 = 3 * t2 - 4 * t + 1
  const d01 = -6 * t2 + 6 * t
  const d11 = 3 * t2 - 2 * t
  const m1 = k * (v2 - v0)
  const m2 = k * (v3 - v1)
  return d00 * v1 + d10 * m1 + d01 * v2 + d11 * m2
}

const neighbours = (
  controls: readonly Vec3[],
  segment: number,
  startTangent?: Vec3,
): [Vec3, Vec3, Vec3, Vec3] => {
  const n = controls.length
  const p1 = controls[wrap(segment, n)] as Vec3
  const p2 = controls[wrap(segment + 1, n)] as Vec3
  // DEV-501: the first segment's phantom neighbour, placed so that
  // m1 = k (p2 − p0) points along `startTangent` at the length the clamp gives.
  const p0 =
    segment === 0 && startTangent
      ? ((): Vec3 => {
          const d = distance(p1, p2)
          return {
            x: p2.x - d * startTangent.x,
            y: p2.y - d * startTangent.y,
            z: p2.z - d * startTangent.z,
          }
        })()
      : (controls[wrap(segment - 1, n)] as Vec3)
  return [p0, p1, p2, controls[wrap(segment + 2, n)] as Vec3]
}

function catmullRomPoint(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number, tension: number): Vec3 {
  const t2 = t * t
  const t3 = t2 * t
  const k = tension
  return {
    x: blend(p0.x, p1.x, p2.x, p3.x, t, t2, t3, k),
    y: blend(p0.y, p1.y, p2.y, p3.y, t, t2, t3, k),
    z: blend(p0.z, p1.z, p2.z, p3.z, t, t2, t3, k),
  }
}

const distance = (a: Vec3, b: Vec3): number => {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const dz = b.z - a.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

/**
 * Sample the open curve through `controls` and measure it. Two points are a
 * straight line (the basis with its end tangents clamped); one point, or none,
 * is not a path, and the format's validator refuses it before this is called.
 */
export const buildCourseSpline = (
  controls: readonly Vec3[],
  options: CourseSplineOptions,
): CourseSpline => {
  const div = options.divisionsPerSegment
  const segments = Math.max(0, controls.length - 1)
  const samples: Vec3[] = []
  const params: number[] = []
  for (let s = 0; s < segments; s++) {
    const [p0, p1, p2, p3] = neighbours(controls, s, options.startTangent)
    for (let i = 0; i < div; i++) {
      const t = i / div
      samples.push(catmullRomPoint(p0, p1, p2, p3, t, options.tension))
      params.push(s + t)
    }
  }
  // The finish of an open curve: the last control point, exactly.
  const last = controls[controls.length - 1]
  if (last) {
    samples.push({ x: last.x, y: last.y, z: last.z })
    params.push(segments)
  }
  const arc = new Float64Array(samples.length)
  for (let i = 1; i < samples.length; i++) {
    arc[i] = (arc[i - 1] as number) + distance(samples[i - 1] as Vec3, samples[i] as Vec3)
  }
  return {
    controls,
    tension: options.tension,
    ...(options.startTangent ? { startTangent: options.startTangent } : {}),
    samples,
    arc,
    param: Float64Array.from(params),
    length: samples.length > 0 ? (arc[samples.length - 1] as number) : 0,
  }
}

/**
 * Which polyline segment holds arc distance `s`, and how far along it. `s` is
 * clamped to the curve. king-tide's segment walk, by bisection (the table is
 * monotone) rather than a running cursor, so one lookup costs log n.
 */
const locate = (spline: CourseSpline, s: number): { i: number; frac: number } => {
  const n = spline.samples.length
  if (n < 2) return { i: 0, frac: 0 }
  const at = Math.max(0, Math.min(spline.length, s))
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if ((spline.arc[mid] as number) <= at) lo = mid
    else hi = mid
  }
  const a = spline.arc[lo] as number
  const len = (spline.arc[lo + 1] as number) - a
  return { i: lo, frac: len > 0 ? (at - a) / len : 0 }
}

/** The point at arc distance `s`, on the sampled polyline. */
export const splinePointAt = (spline: CourseSpline, s: number): Vec3 => {
  const n = spline.samples.length
  if (n === 0) return { x: 0, y: 0, z: 0 }
  if (n === 1) {
    const only = spline.samples[0] as Vec3
    return { x: only.x, y: only.y, z: only.z }
  }
  const { i, frac } = locate(spline, s)
  const a = spline.samples[i] as Vec3
  const b = spline.samples[i + 1] as Vec3
  return {
    x: a.x + (b.x - a.x) * frac,
    y: a.y + (b.y - a.y) * frac,
    z: a.z + (b.z - a.z) * frac,
  }
}

/**
 * The unit direction of travel at arc distance `s`: the curve's own
 * derivative at the parameter that distance maps to. Where the derivative
 * vanishes (a cusp the author made by doubling back on a point) it falls back
 * to the chord of the sample segment, so a direction always exists.
 */
export const splineTangentAt = (spline: CourseSpline, s: number): Vec3 => {
  const n = spline.samples.length
  if (n < 2) return { x: 0, y: 0, z: -1 }
  const { i, frac } = locate(spline, s)
  const g =
    (spline.param[i] as number) +
    ((spline.param[i + 1] as number) - (spline.param[i] as number)) * frac
  const segments = spline.controls.length - 1
  const segment = Math.min(Math.floor(g), segments - 1)
  const u = g - segment
  const [p0, p1, p2, p3] = neighbours(spline.controls, segment, spline.startTangent)
  const k = spline.tension
  let x = hermiteSlope(p0.x, p1.x, p2.x, p3.x, u, k)
  let y = hermiteSlope(p0.y, p1.y, p2.y, p3.y, u, k)
  let z = hermiteSlope(p0.z, p1.z, p2.z, p3.z, u, k)
  let len = Math.sqrt(x * x + y * y + z * z)
  if (!(len > 1e-9)) {
    const a = spline.samples[i] as Vec3
    const b = spline.samples[i + 1] as Vec3
    x = b.x - a.x
    y = b.y - a.y
    z = b.z - a.z
    len = Math.sqrt(x * x + y * y + z * z) || 1
  }
  return { x: x / len, y: y / len, z: z / len }
}

/**
 * king-tide's `resampleByArcLength`, open and fixed-spacing: the arc distances
 * `from + spacing`, `from + 2 * spacing`, … up to and including `to`. Empty
 * when `spacing` is not positive or the window holds no step.
 */
export const resampleByArcLength = (from: number, to: number, spacing: number): number[] => {
  if (!(spacing > 0) || !(to > from)) return []
  const out: number[] = []
  for (let k = 1; from + k * spacing <= to; k++) out.push(from + k * spacing)
  return out
}

/**
 * The arc distance of the point on the sampled polyline nearest `p`: the
 * inverse of `splinePointAt`, for anything that has a position and wants to
 * know how far along the course it is. O(samples).
 */
export const nearestArc = (spline: CourseSpline, p: Vec3): number => {
  const n = spline.samples.length
  if (n < 2) return 0
  let best = 0
  let bestD = Number.POSITIVE_INFINITY
  for (let i = 0; i + 1 < n; i++) {
    const a = spline.samples[i] as Vec3
    const b = spline.samples[i + 1] as Vec3
    const abx = b.x - a.x
    const aby = b.y - a.y
    const abz = b.z - a.z
    const ll = abx * abx + aby * aby + abz * abz
    const t =
      ll > 0
        ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / ll))
        : 0
    const qx = a.x + abx * t - p.x
    const qy = a.y + aby * t - p.y
    const qz = a.z + abz * t - p.z
    const d = qx * qx + qy * qy + qz * qz
    if (d < bestD) {
      bestD = d
      best =
        (spline.arc[i] as number) + ((spline.arc[i + 1] as number) - (spline.arc[i] as number)) * t
    }
  }
  return best
}
