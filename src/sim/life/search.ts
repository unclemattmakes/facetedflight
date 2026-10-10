// src/sim/life/search.ts — the life pass's one search: outward in rings.
//
// Boats (DEV-447) and pods (DEV-449) all look for the same thing — the
// NEAREST point to an aim that passes their gates — and all look the same way,
// so there is one copy of how. (DEV-448's crowds did too, until DEV-463 cut
// them.)
//
// Rings from `band[0]` to `band[1]` metres out, `step` apart, each sampled
// `step` apart along its ARC (never fewer than `angles` directions), from a
// seeded start angle so two aims do not all begin due east. The arc rule is
// DEV-447's measured fix: a fixed direction count leaves 100 m gaps at 400 m,
// wider than the in-band shelf on a steep coast (Kauai placed one boat of a
// possible four).
//
// SIM LAYER: pure. No three, no DOM, no clock, no `Math.random`.

export interface RingSearch {
  /** Metres between rings, and between samples along a ring. */
  readonly step: number
  /** The fewest directions tried on a ring. */
  readonly angles: number
}

/**
 * The first point, nearest ring first, that `fits`. Null when none does.
 * `phase` is the seeded start angle, radians.
 */
export const searchRings = (
  cx: number,
  cz: number,
  band: readonly [number, number],
  search: RingSearch,
  phase: number,
  fits: (x: number, z: number) => boolean,
): { x: number; z: number } | null => {
  const lo = Math.max(0, band[0] as number)
  const hi = Math.max(lo, band[1] as number)
  const step = Math.max(1, search.step)
  const angles = Math.max(1, Math.floor(search.angles))
  for (let r = lo; r <= hi; r += step) {
    const around = Math.max(angles, Math.ceil((2 * Math.PI * r) / step))
    for (let s = 0; s < around; s++) {
      const a = phase + (s * Math.PI * 2) / around
      const x = cx + Math.cos(a) * r
      const z = cz + Math.sin(a) * r
      if (fits(x, z)) return { x, z }
    }
  }
  return null
}
