// @engine-layer: imports nothing from game, content, generated or boot/app (tests/unit/engine-layering-guard.test.ts)
// src/sim/math/rng.ts: the two seeded generators the project uses (code-reuse
// audit WP-2, crosscut.md XC-2, sim-game.md SG-6). Each is a PURE constructor:
// every caller gets its own stream from its own seed, so sharing the function
// shares no state and no draw order. `game/props/instance-plan.ts` is right
// that its layout must not re-roll when terrain's generator changes; that
// argument is about not sharing a STREAM, and it still holds.
//
// No `Math.random`, no clock: sim-legal.

/**
 * mulberry32: 32 bits of state, one `Math.imul` mix per draw, uniform in
 * [0, 1). The generator `sim/terrain/faceted.ts` (as `makeRandom`), the TV
 * schedule and the rooms Worker's shuffle all use. `game/tv/tv-schedule.ts`
 * says every client must compute the same programme as the Worker; one
 * function is the structural form of that promise.
 */
export const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * xorshift32 (13, 17, 5), uniform in [0, 1). A zero state is a fixed point of
 * the xorshift (it stays 0 for ever), so a seed whose unsigned form is 0 takes
 * 0x9e3779b9 instead; the guard is applied AFTER `>>> 0`.
 * `render/particles.ts`'s own `makeRandom` guards BEFORE `>>> 0` and so differs
 * for seeds that are non-zero but truncate to 0 (2^32, -0.5); it stays local.
 */
export const xorshift32 = (seed: number): (() => number) => {
  let s = seed >>> 0 || 0x9e3779b9
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s / 0x100000000
  }
}
