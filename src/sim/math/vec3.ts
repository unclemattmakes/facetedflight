// @engine-layer: imports nothing from game, content, generated or boot/app (tests/unit/engine-layering-guard.test.ts)
// src/sim/math/vec3.ts — mutable 3-vector for the sim layer. No three.js: the
// sim must run headless in Vitest's node environment (PORT_PLAN §2.4 / D7).

export interface Vec3 {
  x: number
  y: number
  z: number
}

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z })

export const set = (out: Vec3, x: number, y: number, z: number): Vec3 => {
  out.x = x
  out.y = y
  out.z = z
  return out
}

export const copy = (out: Vec3, a: Vec3): Vec3 => set(out, a.x, a.y, a.z)

export const add = (out: Vec3, a: Vec3, b: Vec3): Vec3 => set(out, a.x + b.x, a.y + b.y, a.z + b.z)

export const sub = (out: Vec3, a: Vec3, b: Vec3): Vec3 => set(out, a.x - b.x, a.y - b.y, a.z - b.z)

export const scale = (out: Vec3, a: Vec3, s: number): Vec3 => set(out, a.x * s, a.y * s, a.z * s)

/** out = a + b * s — the integrator's inner loop, allocation-free. */
export const scaleAdd = (out: Vec3, a: Vec3, b: Vec3, s: number): Vec3 =>
  set(out, a.x + b.x * s, a.y + b.y * s, a.z + b.z * s)

export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z

export const cross = (out: Vec3, a: Vec3, b: Vec3): Vec3 =>
  set(out, a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x)

export const lengthSq = (a: Vec3): number => dot(a, a)

export const length = (a: Vec3): number => Math.sqrt(dot(a, a))

/**
 * `|a - b|^2` without the allocation: `dx * dx + dy * dy + dz * dz` in that
 * order, which is the order every inline copy summed in (code-reuse audit
 * SG-10). The sign of each difference does not reach the result, so `(a, b)`
 * and `(b, a)` are the same bits.
 */
export const distanceSq = (a: Vec3, b: Vec3): number => {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return dx * dx + dy * dy + dz * dz
}

export const distance = (a: Vec3, b: Vec3): number => Math.sqrt(distanceSq(a, b))

export const normalize = (out: Vec3, a: Vec3): Vec3 => {
  const len = length(a)
  return len > 0 ? scale(out, a, 1 / len) : set(out, 0, 0, 0)
}
