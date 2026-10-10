// src/sim/math/scalar.ts: the scalar kit every layer may import (code-reuse
// audit WP-1, 2026-10-05). `src/sim/math` is the one home that keeps the sim
// three-free and DOM-free while content, render, game, input and the editor
// can all reach it (crosscut.md § "Layering fact").
//
// EVERY BODY HERE IS BIT-FOR-BIT THE COPY IT REPLACED. The sim's golden
// trajectories and the render layer's CPU mirrors of GLSL both depend on the
// exact float operations in the exact order, so:
//   - `clamp` and `clamp01` are the TERNARY form. It returns -0 for -0 where
//     `Math.max(0, -0)` returns +0, and a later `atan2` can carry that sign.
//     A caller written with `Math.min(1, Math.max(0, x))` is NOT migrated here
//     without a golden run (sim-game.md SG-7).
//   - `mix` is GLSL's `x * (1 - a) + y * a`, exact at a = 0 AND a = 1;
//     `lerp` is `a + (b - a) * t`, exact only at t = 0. They round differently
//     in the last bit, so both exist and neither is an alias of the other.
//   - `wrapPi` is the while-loop form, which differs by about an ulp from the
//     `atan2(sin, cos)` form `render/turntable.ts`'s `wrapAngle` uses.

/** `v` held to `[lo, hi]`. NaN passes through; -0 stays -0. */
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/** `clamp(x, 0, 1)`, GLSL's `saturate`. */
export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)

/**
 * GLSL's `smoothstep`, spelled out so the TypeScript and the shader agree at
 * the endpoints as well as in the middle. The three copies this replaced
 * clamped three ways (ternary, `<=`, `Math.min/max`), and all three return the
 * same bits for every input because the clamped value is SQUARED, which turns
 * a -0 into +0 before anything can see its sign.
 */
export const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

/** `smoothstep(0, 1, t)` for a caller that already divided: the Hermite curve alone. */
export const smooth01 = (t: number): number => {
  const c = clamp01(t)
  return c * c * (3 - 2 * c)
}

/** GLSL's `mix`: exact at a = 0 and at a = 1 (`x + (y - x) * a` is not). */
export const mix = (x: number, y: number, a: number): number => x * (1 - a) + y * a

/** `a + (b - a) * t`: exact at t = 0 only. See `mix` for the other rounding. */
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/** Wrap to (-pi, pi]. A heading error of 350 degrees is a turn of -10. */
export const wrapPi = (a: number): number => {
  let x = a
  while (x > Math.PI) x -= 2 * Math.PI
  while (x <= -Math.PI) x += 2 * Math.PI
  return x
}

/**
 * Degrees to radians, and back. Named for their DIRECTION because a constant
 * called `DEG` meant `PI / 180` in three files and `180 / PI` in a fourth
 * (crosscut.md XC-6): a paste between them inverts an angle by a factor of 3283.
 */
export const RAD_PER_DEG = Math.PI / 180
export const DEG_PER_RAD = 180 / Math.PI

/**
 * Move `current` toward `target` by at most `maxStep`, landing exactly on the
 * target once it is within reach. Was `audio/speed-curves.ts`'s own; the
 * keyboard's key ramp is the same function (input-audio.md IU-3).
 */
export const slewToward = (current: number, target: number, maxStep: number): number => {
  const delta = target - current
  if (delta > maxStep) return current + maxStep
  if (delta < -maxStep) return current - maxStep
  return target
}

/**
 * The classic one-line GLSL hash, `fract(sin(i * 12.9898 + 78.233) * 43758.5453)`,
 * in [0, 1). Numeric literals under `src/sim` need a reason (plan risk R9):
 * these three are the hash's fixed coefficients, quoted from the shader idiom
 * every renderer uses, not tuned values. Two render files spelled it out
 * (render-core.md RC-12); the diorama maps it to [-1, 1] itself.
 */
export const facetHash01 = (i: number): number => {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453
  return x - Math.floor(x)
}
