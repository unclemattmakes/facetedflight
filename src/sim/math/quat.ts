// src/sim/math/quat.ts — mutable unit quaternion for the sim layer. No
// three.js (PORT_PLAN §2.4 / D7). Same component order and handedness as
// three.js `Quaternion` so `render/` can copy one into the other field by
// field with no conversion.

import { set as setV3, type Vec3 } from './vec3'

export interface Quat {
  x: number
  y: number
  z: number
  w: number
}

export const quat = (x = 0, y = 0, z = 0, w = 1): Quat => ({ x, y, z, w })

export const setQ = (out: Quat, x: number, y: number, z: number, w: number): Quat => {
  out.x = x
  out.y = y
  out.z = z
  out.w = w
  return out
}

export const copyQ = (out: Quat, a: Quat): Quat => setQ(out, a.x, a.y, a.z, a.w)

/** out = a * b (apply b first, then a — three.js `multiplyQuaternions` order). */
export const mul = (out: Quat, a: Quat, b: Quat): Quat =>
  setQ(
    out,
    a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  )

export const normalizeQ = (out: Quat, a: Quat): Quat => {
  const len = Math.hypot(a.x, a.y, a.z, a.w)
  return len > 0 ? setQ(out, a.x / len, a.y / len, a.z / len, a.w / len) : setQ(out, 0, 0, 0, 1)
}

export const conjugate = (out: Quat, a: Quat): Quat => setQ(out, -a.x, -a.y, -a.z, a.w)

/** Rotate `v` by `q` (world = q * local). */
export const rotateVec3 = (out: Vec3, q: Quat, v: Vec3): Vec3 => {
  // t = 2 * (q.xyz × v); out = v + q.w * t + q.xyz × t
  const tx = 2 * (q.y * v.z - q.z * v.y)
  const ty = 2 * (q.z * v.x - q.x * v.z)
  const tz = 2 * (q.x * v.y - q.y * v.x)
  return setV3(
    out,
    v.x + q.w * tx + q.y * tz - q.z * ty,
    v.y + q.w * ty + q.z * tx - q.x * tz,
    v.z + q.w * tz + q.x * ty - q.y * tx,
  )
}

/** Rotate `v` by the inverse of `q` (local = q⁻¹ * world). */
export const rotateVec3Inverse = (out: Vec3, q: Quat, v: Vec3): Vec3 => {
  const tx = -2 * (q.y * v.z - q.z * v.y)
  const ty = -2 * (q.z * v.x - q.x * v.z)
  const tz = -2 * (q.x * v.y - q.y * v.x)
  return setV3(
    out,
    v.x + q.w * tx - q.y * tz + q.z * ty,
    v.y + q.w * ty - q.z * tx + q.x * tz,
    v.z + q.w * tz - q.x * ty + q.y * tx,
  )
}

/**
 * Integrate an angular velocity (rad/s, world space) over `dt` onto `q`.
 * This is PhysX's / Unity's first-order update followed by a renormalise —
 * the same shape as `Rigidbody.angularVelocity` integration.
 */
export const integrateAngularVelocity = (out: Quat, q: Quat, omega: Vec3, dt: number): Quat => {
  const hx = omega.x * dt * 0.5
  const hy = omega.y * dt * 0.5
  const hz = omega.z * dt * 0.5
  const nx = q.x + (hx * q.w + hy * q.z - hz * q.y)
  const ny = q.y + (hy * q.w + hz * q.x - hx * q.z)
  const nz = q.z + (hz * q.w + hx * q.y - hy * q.x)
  const nw = q.w - (hx * q.x + hy * q.y + hz * q.z)
  return normalizeQ(out, setQ(out, nx, ny, nz, nw))
}

/**
 * The orientation that points a body's NOSE along `dir`, wings level.
 *
 * The sim's body frame is **+Z forward, +Y up, +X right** — `autopilot.ts`
 * says so where it rotates an aim point into it. So this is yaw about +Y to
 * the flat bearing, then pitch about the ship's own +X to the elevation, and
 * no roll: the composition `qYaw * qPitch`.
 *
 * ── Test the GEOMETRY, not the rotation ───────────────────────────────────
 *
 * Orientation bugs are a class in this port and every one of them was written
 * twice — once in the code and once in a quaternion assertion that agreed with
 * it. The property this function has to have is a DISTANCE: rotating (0,0,1)
 * by the result must land on `dir`, for any `dir`, and `tests/unit/quat-look.test.ts`
 * sweeps it rather than spelling out components. The sign of the pitch term
 * below is therefore not an argument, it is a measurement.
 *
 * `dir` need not be normalised; a zero-length one returns identity, because
 * "which way is nowhere" has no answer and a NaN quaternion takes a body out
 * of the frustum for the rest of the session.
 */
export const lookAlong = (out: Quat, dir: Vec3): Quat => {
  const len = Math.hypot(dir.x, dir.y, dir.z)
  if (len < 1e-9) return setQ(out, 0, 0, 0, 1)
  const x = dir.x / len
  const y = dir.y / len
  const z = dir.z / len
  // Yaw about +Y: right-handed, so it carries +Z to (sin a, 0, cos a).
  const a = Math.atan2(x, z)
  // Elevation, and the pitch that produces it is its NEGATIVE: a right-handed
  // rotation about +X carries +Z to (0, -sin b, cos b), so b = -asin(y).
  const b = -Math.asin(Math.max(-1, Math.min(1, y)))
  const sa = Math.sin(a * 0.5)
  const ca = Math.cos(a * 0.5)
  const sb = Math.sin(b * 0.5)
  const cb = Math.cos(b * 0.5)
  // qYaw * qPitch, written out: qYaw is (0, sa, 0, ca) and qPitch is (sb, 0, 0, cb).
  return setQ(out, ca * sb, sa * cb, -sa * sb, ca * cb)
}
