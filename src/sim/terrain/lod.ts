// src/sim/terrain/lod.ts — which detail level a chunk should be drawn at.
//
// Ported from `FacetedTerrain.cs`, which is worth doing exactly rather than
// approximating: the LOD bands decide where the silhouette visibly coarsens,
// and getting them wrong makes the island change shape at a different distance
// from the one players remember.
//
// ── The 2016 rule ─────────────────────────────────────────────────────────
//
//   _Distances[i] = LODDistance * 2^i        (FacetedTerrain.cs:688-694)
//
// Simonet's islands: `LODDistance` 1024 over 3 levels, so 1024 / 2048 / 4096 m.
// Its ocean: 1800 over 6 levels — but the ocean's transform is scaled 8x, and
// the distances are compared in WORLD space, so those bands are effectively
// eight times narrower relative to its own chunks.
//
// Two details that are easy to miss and both matter:
//
//  1. **Distance is HORIZONTAL.** `deltaToChunk.y = 0.0f` before taking the
//     magnitude. Flying straight up over the island therefore does NOT coarsen
//     the terrain under you, which is the right call for a game where the
//     interesting altitude range is a kilometre tall.
//
//  2. **There is hysteresis, and it is asymmetric in USE, not in size.**
//     `FlipFlopPercent` is 0.03: step out at `_Distances[lod] * 1.03`, step back
//     in at `_Distances[lod - 1] * 0.97`. Without it a chunk sitting exactly on
//     a boundary swaps its mesh every frame — the flip-flop the field is named
//     after — which reads as the terrain shimmering.
//
// ── The band BELOW zero, which 2016 does not have ────────────────────────
//
// The Anniversary preset adds a detail ring: the nearest chunks generated at a
// finer facet (`sim/terrain/detail.ts`, DEV-085). That is one more rung on the
// same ladder, so it uses the same mechanism — a distance, a threshold and
// `FlipFlopPercent` — rather than a parallel one. `selectLod`'s last argument is
// the whole of it, and it is OPTIONAL: absent or null, every line below behaves
// exactly as it did, which is what keeps Classic and the oracle untouched.
//
// SIM LAYER: pure. Given the same distance and current level it always returns
// the same answer, so LOD selection can be replayed and tested headlessly.

import type { DetailBand } from './detail'

export interface LodBands {
  /** `LODDistance * 2^i`, ascending. Length is `lodLevels`. */
  readonly distances: readonly number[]
  /** `FlipFlopPercent`. 0.03 on every shipped terrain. */
  readonly hysteresis: number
}

/** Build the bands the way `FacetedTerrain` does. */
export const lodBands = (lodDistance: number, lodLevels: number, hysteresis: number): LodBands => {
  const distances: number[] = []
  let d = lodDistance
  for (let i = 0; i < lodLevels; i++) {
    distances.push(d)
    d *= 2
  }
  return { distances, hysteresis }
}

/**
 * Horizontal distance, which is what 2016 compares against.
 *
 * `deltaToChunk.y = 0.0f` — altitude is deliberately ignored.
 */
export const horizontalDistance = (ax: number, az: number, bx: number, bz: number): number =>
  Math.hypot(ax - bx, az - bz)

/** A terrain's placement in world space, as the LOD test needs it. */
export interface ChunkFootprint {
  /** World x/z of the terrain's mesh origin. */
  readonly originX: number
  readonly originZ: number
  /** The terrain group's scale. The Simonet ocean plate is 8 in both. */
  readonly scaleX: number
  readonly scaleZ: number
  /** Chunk side in MESH units, before scale. */
  readonly chunkSize: number
}

/**
 * Horizontal distance from a point to a chunk's world FOOTPRINT — zero when the
 * point is over the chunk.
 *
 * ── Why this is not `horizontalDistance` to the chunk centre ─────────────
 *
 * `FacetedTerrain.Start()` caches `chunk.Center = chunk.Renderers[0].bounds
 * .center` and measures to that. For the islands the difference is nothing: a
 * chunk is 256 m against an LOD distance of 1024, so the centre is at most
 * 181 m out. For the OCEAN it is ruinous — those chunks are 1024 mesh units at
 * a scale of 8, **8,192 m across**, against an LOD distance of 1800. The centre
 * of the chunk you are flying over is up to 5.8 km away, which is three LOD
 * bands.
 *
 * Measured on `int_01` at the spawn, with the centre test: four ocean chunks and
 * **not one at LOD0** — two at LOD2, two at LOD3, quads of 1,024 m and 2,048 m
 * where the mesh can do 256. 544 triangles of sea against 115,648 of island.
 * With the footprint: LOD0 and LOD1, 5,920 triangles.
 *
 * It is a deviation, because 2016 shipped the centre test and therefore shipped
 * the coarse sea. It can only ever ADD detail, and it adds it out of geometry
 * the generator already had rather than out of geometry we invented.
 *
 * The z flip is in here because it has to be: `chunkGeometry` mirrors mesh z
 * into world z, so a chunk at mesh z `[a, b]` lands at world z
 * `[origin - scale*b, origin - scale*a]`. Getting that backwards puts the
 * footprint on the wrong side of the origin and the sea coarsens as you
 * approach it.
 */
export const chunkFootprintDistance = (
  f: ChunkFootprint,
  chunkX: number,
  chunkY: number,
  px: number,
  pz: number,
): number => {
  const x0 = f.originX + f.scaleX * chunkX * f.chunkSize
  const x1 = f.originX + f.scaleX * (chunkX + 1) * f.chunkSize
  const z1 = f.originZ - f.scaleZ * chunkY * f.chunkSize
  const z0 = f.originZ - f.scaleZ * (chunkY + 1) * f.chunkSize
  const dx = Math.max(x0 - px, 0, px - x1)
  const dz = Math.max(z0 - pz, 0, pz - z1)
  return Math.hypot(dx, dz)
}

/**
 * The level a chunk should move to, given where it is now.
 *
 * Returns `currentLod` when nothing should change, which is the common case and
 * the one the caller should test for before touching any geometry.
 *
 * Only ever moves ONE level per call, like the original: a camera that teleports
 * across the map walks its chunks in over successive frames rather than
 * rebuilding everything in one, which keeps the worst frame bounded.
 *
 * `detail` opens the band below zero (DEV-085). Without it — Classic, the
 * ocean, and every existing caller — the floor is 0 and **−1 is unreachable**,
 * which is the invariant the whole feature hangs off: a preset cannot make the
 * shipped ladder behave differently, only add a rung under it.
 *
 * The step-in test runs BEFORE the step-out one at LOD 0, so a ring radius
 * authored larger than `distances[0]` resolves to "inside the ring" rather than
 * to a chunk oscillating between −1 and 1. That is a nonsense configuration
 * either way; this is the version of it that cannot shimmer.
 */
export const selectLod = (
  bands: LodBands,
  distance: number,
  currentLod: number,
  detail: DetailBand | null = null,
): number => {
  const last = bands.distances.length - 1
  const floor = detail ? -1 : 0
  const lod = Math.min(Math.max(currentLod, floor), last)

  if (detail) {
    // Inside the ring the only move available is OUT, and only past the ring
    // plus hysteresis — a detail chunk never coarsens two levels in one step,
    // for the same reason nothing else does.
    if (lod < 0) return distance > detail.radius * (1 + detail.hysteresis) ? lod + 1 : lod
    if (lod === 0 && distance < detail.radius * (1 - detail.hysteresis)) return -1
  }

  // Further out: cross the band plus hysteresis.
  if (lod < last) {
    const threshold = (bands.distances[lod] as number) * (1 + bands.hysteresis)
    if (distance > threshold) return lod + 1
  }
  // Closer in: cross the PREVIOUS band minus hysteresis.
  if (lod > 0) {
    const threshold = (bands.distances[lod - 1] as number) * (1 - bands.hysteresis)
    if (distance < threshold) return lod - 1
  }
  return lod
}

/**
 * The level a chunk should start at, with no history to be sticky about.
 *
 * Used on first load, where `selectLod`'s one-step-at-a-time rule would need
 * `lodLevels` passes to settle. Hysteresis is deliberately NOT applied: there is
 * no previous state to flip-flop against.
 *
 * **It never returns −1, on any preset**, and that is a decision rather than an
 * omission (DEV-085). The first build is synchronous on the MAIN thread — 256
 * chunks, a couple of seconds, and the loading bar the player is watching — and
 * the detail ring is on-demand geometry that belongs in the worker. So an
 * Anniversary load builds exactly the meshes a Classic load builds, byte for
 * byte, and the ring fills in over the first frames of flight.
 */
export const initialLod = (bands: LodBands, distance: number): number => {
  const last = bands.distances.length - 1
  for (let i = 0; i < last; i++) {
    if (distance <= (bands.distances[i] as number)) return i
  }
  return last
}
