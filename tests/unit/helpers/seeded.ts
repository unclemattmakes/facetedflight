// tests/unit/helpers/seeded.ts — a seeded generator for the network tiers. DEV-387.
//
// mulberry32: tiny, fast and good enough to draw link jitter and loss. Every
// network test is seeded, so a red run repeats exactly (no `Math.random`,
// the sim's own rule carried into its harness).

export type Rng = () => number

/**
 * Numerical Recipes' linear congruential generator, in [0, 1). Not mulberry32:
 * seven tests drew their samples from this exact stream before it lived here,
 * and a fuzz tuned on one stream is not the same test on another, so it stays
 * a second function rather than being folded into `seeded`.
 */
export const lcg = (seed: number): Rng => {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

export const seeded = (seed: number): Rng => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
