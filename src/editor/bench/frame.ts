// src/editor/bench/frame.ts — the bench's arithmetic: level frame ↔ bench, a
// hand's ray onto the island, and what a ray is near. DEV-492 (EDITOR.md §5.3,
// "On the bench (headset)").
//
// THREE-FREE AND DOM-FREE, so every rule here is a node test
// (`tests/unit/editor-bench.test.ts`).
//
// ── The one mapping, and whose it is ─────────────────────────────────────
//
// The bench is the hangar's diorama (`render/diorama.ts`) enlarged: the same
// island read off the same height field, at ~1:2000 on a two-metre table. So
// the mapping from the level's frame (THREE world, where a course's points
// live) to the table is the one the diorama BUILT its island in, and it hands
// that out (`Diorama.frame`). This file only applies it. It never restates the
// centre, the scale or the relief, which is what keeps a point you place over
// a hill on the table over the same hill in the world.
//
// The bench's local frame is the diorama's own: +x is the island's +x and +z
// its +z (THREE space, both), y is metres above the waterline times the scale
// and the relief. Orientation bugs are a class in this repo (CLAUDE.md), so
// the test holds the mapping against the island's GEOMETRY — an asymmetric
// peak drawn by the diorama maps back to where the field has it — not against
// a belief about signs.

import type { Vec3Tuple } from '@/content/level-schema'
import type { HeightField } from '@/sim/terrain/height-field'
import { terrainHeightAt } from '@/sim/terrain/height-field'

/** The diorama's mapping (`render/diorama.ts`'s `DioramaFrame`), structurally. */
export interface BenchFrame {
  readonly centreX: number
  readonly centreZ: number
  readonly seaY: number
  readonly scale: number
  readonly relief: number
}

/** A level-frame (THREE world) point onto the bench. */
export const toBench = (f: BenchFrame, p: readonly number[]): Vec3Tuple => [
  ((p[0] as number) - f.centreX) * f.scale,
  ((p[1] as number) - f.seaY) * f.scale * f.relief,
  ((p[2] as number) - f.centreZ) * f.scale,
]

/** A bench point back into the level frame. The inverse of {@link toBench}. */
export const toWorld = (f: BenchFrame, b: readonly number[]): Vec3Tuple => [
  (b[0] as number) / f.scale + f.centreX,
  (b[1] as number) / (f.scale * f.relief) + f.seaY,
  (b[2] as number) / f.scale + f.centreZ,
]

/**
 * The island as the bench DRAWS it, level frame: the height field (THREE z is
 * sim −z, the flip the diorama makes), clamped at the waterline as the
 * miniature is. What a hand's ray lands on; never what a point is placed
 * over, which is the render surface (`Ground`).
 */
export const drawnHeightAt = (field: HeightField, seaY: number, x: number, z: number): number =>
  Math.max(terrainHeightAt(field, x, -z), seaY)

/**
 * Where a ray (bench frame, unit direction) first meets the drawn island, or
 * null: a march of `step` metres to `reach`, then a bisection to a tenth of a
 * millimetre. Only inside the model's disc (`radius`, bench metres), which is
 * all the diorama draws.
 */
export const rayOntoIsland = (
  f: BenchFrame,
  surfaceAt: (x: number, z: number) => number,
  origin: readonly number[],
  direction: readonly number[],
  radius: number,
  reach: number,
  step: number,
): { point: Vec3Tuple; distance: number } | null => {
  const at = (t: number): Vec3Tuple => [
    (origin[0] as number) + (direction[0] as number) * t,
    (origin[1] as number) + (direction[1] as number) * t,
    (origin[2] as number) + (direction[2] as number) * t,
  ]
  /** Bench-frame height of the drawn island under a bench point, or null off the disc. */
  const groundUnder = (p: Vec3Tuple): number | null => {
    if (Math.hypot(p[0], p[2]) > radius) return null
    const w = toWorld(f, p)
    return ((surfaceAt(w[0], w[2]) - f.seaY) as number) * f.scale * f.relief
  }
  const below = (t: number): boolean => {
    const p = at(t)
    const g = groundUnder(p)
    return g !== null && p[1] <= g
  }
  let prev = 0
  for (let t = step; t <= reach + 1e-9; t += step) {
    if (below(t)) {
      let lo = prev
      let hi = t
      while (hi - lo > 1e-4) {
        const mid = (lo + hi) / 2
        if (below(mid)) hi = mid
        else lo = mid
      }
      return { point: at(hi), distance: hi }
    }
    prev = t
  }
  return null
}

/**
 * How near a ray passes `p` (bench frame): the perpendicular distance, and how
 * far along the ray the nearest approach is. `along` is negative behind the
 * origin.
 */
export const rayNear = (
  origin: readonly number[],
  direction: readonly number[],
  p: readonly number[],
): { miss: number; along: number } => {
  const dx = (p[0] as number) - (origin[0] as number)
  const dy = (p[1] as number) - (origin[1] as number)
  const dz = (p[2] as number) - (origin[2] as number)
  const along =
    dx * (direction[0] as number) + dy * (direction[1] as number) + dz * (direction[2] as number)
  const px = dx - (direction[0] as number) * along
  const py = dy - (direction[1] as number) * along
  const pz = dz - (direction[2] as number) * along
  return { miss: Math.hypot(px, py, pz), along }
}

/**
 * Which of `points` (bench frame) a hand takes: the nearest within `reach` of
 * the hand itself, or else the one the ray passes nearest, within a cone of
 * `tolerance` metres plus `perMetre` a metre along it (a far handle is as easy
 * to catch as a near one). −1 for none.
 */
export const pickPoint = (
  points: readonly (readonly number[])[],
  origin: readonly number[],
  direction: readonly number[],
  reach: number,
  tolerance: number,
  perMetre: number,
): number => {
  let best = -1
  let bestD = reach
  for (let i = 0; i < points.length; i++) {
    const p = points[i] as readonly number[]
    const d = Math.hypot(
      (p[0] as number) - (origin[0] as number),
      (p[1] as number) - (origin[1] as number),
      (p[2] as number) - (origin[2] as number),
    )
    if (d <= bestD) {
      bestD = d
      best = i
    }
  }
  if (best >= 0) return best
  let bestMiss = Number.POSITIVE_INFINITY
  for (let i = 0; i < points.length; i++) {
    const { miss, along } = rayNear(origin, direction, points[i] as readonly number[])
    if (along <= 0) continue
    if (miss <= tolerance + perMetre * along && miss < bestMiss) {
      bestMiss = miss
      best = i
    }
  }
  return best
}

/**
 * The sample of a polyline (bench frame) a ray passes nearest, within the same
 * cone as {@link pickPoint}, and in front of `before` along the ray (the
 * ground it would otherwise land on). −1 for none.
 */
export const pickLine = (
  samples: readonly (readonly number[])[],
  origin: readonly number[],
  direction: readonly number[],
  tolerance: number,
  perMetre: number,
  before: number,
): number => {
  let best = -1
  let bestMiss = Number.POSITIVE_INFINITY
  for (let i = 0; i < samples.length; i++) {
    const { miss, along } = rayNear(origin, direction, samples[i] as readonly number[])
    if (along <= 0 || along > before) continue
    if (miss <= tolerance + perMetre * along && miss < bestMiss) {
      bestMiss = miss
      best = i
    }
  }
  return best
}

/**
 * Where a grabbed point goes: where it was, plus how far the hand has moved
 * since the grab (bench frame). Horizontal and vertical at once — the hand
 * says both.
 */
export const dragTo = (
  pointAtGrab: readonly number[],
  handAtGrab: readonly number[],
  hand: readonly number[],
): Vec3Tuple => [
  (pointAtGrab[0] as number) + (hand[0] as number) - (handAtGrab[0] as number),
  (pointAtGrab[1] as number) + (hand[1] as number) - (handAtGrab[1] as number),
  (pointAtGrab[2] as number) + (hand[2] as number) - (handAtGrab[2] as number),
]
