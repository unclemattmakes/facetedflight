// src/sim/terrain/height-field.ts — the surface you actually hit.
//
// ── It is NOT the mesh you can see ────────────────────────────────────────
//
// `FacetedTerrain` builds two different surfaces from one heightmap, and the
// port only had the first:
//
//   the MESH       `originalVerts[x,y] = (u*size, grayscale*height, v*size)
//                   + Random.insideUnitSphere * RandomOffset`
//   the COLLIDER   `originalHeights[y,x] = grayscale` -> `TerrainData`,
//                   `terrainCollider.terrainData = terrainData`
//
// The jitter goes into the mesh and NOT into the collider. On Simonet's islands
// `RandomOffset` is **1.3 m**, so the faceted silhouette you fly at and the
// surface that stops you disagree by up to that much, in every direction, per
// vertex. That is 2016's behaviour, not an approximation of it — colliding
// against the rendered triangles would be the unfaithful choice, and it would
// also be slower and jumpier.
//
// ── Resolution ────────────────────────────────────────────────────────────
//
// `heightmapResolution` is the ORIGINAL grid, not the LOD the chunk happens to
// be drawing: `terrainSize / baseResolution + 1`, which on the islands is
// 4096 / 8 + 1 = **513** samples on an 8 m pitch. So collision does not change
// as chunks swap LOD, which is the other half of why this is a separate surface.
//
// ── Indexing, which is easy to transpose ─────────────────────────────────
//
// `originalHeights[y, x]` with `u = x/(N-1)` and `v = y/(N-1)`, and the mesh
// puts `u` on world X and `v` on world Z. So the array is [z][x] and there is no
// transpose — but the two indices are named the other way round in the source
// from how they are used, which is exactly how a transpose gets written.
//
// SIM LAYER: no three, no DOM, no wall clock.

import type { FacetedTerrainParams } from './faceted'
import { grayscale } from './faceted'
import type { MapSampler, Rgb } from './image-sampler'

/**
 * A surface with a closed-form height rather than a sampled grid (DEV-120).
 *
 * Every consumer of `HeightField` in the sim — the hover ray, the hull, the
 * legs, the proximity fan, both autopilots — goes through `terrainHeightAt`,
 * `outsideField` and `terrainNormalAt`, so a field that carries one of these
 * answers those three exactly and needs no grid. The JumpSeat's landing pads
 * are the first: a stepped octagon is a function of one radius, and rasterising
 * it onto a grid would turn each 1.4 m step into a ramp one cell wide and hang
 * a phantom apron of blended height around the rim.
 *
 * The grid members on a field that carries one are placeholders and are never
 * read by the three accessors. Renderers that read the grid directly
 * (`render/far-shadow.ts`, `render/diorama.ts`) take the TERRAIN fields only.
 */
export interface AnalyticSurface {
  /** Does the surface exist under this SIM-space point at all? */
  inside(x: number, z: number): boolean
  /** Surface height, SIM space. Only meaningful where `inside` is true. */
  heightAt(x: number, z: number): number
  /** Metres either side of a point the gradient is taken over, for the normal. */
  readonly normalStep: number
  /**
   * SIM y of the solid's UNDERSIDE, for a surface that is a slab in the air
   * rather than the top of the ground (DEV-383): a landing pad standing 40 to
   * 300 m above the land. A point below it is UNDER the surface, not inside
   * it — see `belowField`. Absent, the surface is the top of something solid
   * all the way down, as terrain is.
   */
  readonly underside?: number
}

/**
 * Is a point at height `y` below the field's underside — under a floating
 * slab rather than inside it? Always false for terrain, which has none.
 *
 * DEV-383: a height field has no underside, so until this a seat anywhere
 * beneath a floating pad read as buried in it by the full height of the pad
 * above the ground — 120 m under `rookie_01_jumpSeat`'s second pad — and the
 * hull was pushed out along the bowl's normal: a 120 m teleport. The seats
 * that climb never went under a pad; the jumping spider, which cannot climb,
 * glides under them. The hull, the legs and the hover ray ask this before a
 * field's height counts.
 */
export const belowField = (field: HeightField, y: number): boolean => {
  const underside = field.analytic?.underside
  return underside !== undefined && y < underside
}

export interface HeightField {
  /**
   * Present on a closed-form surface (a landing pad). The three accessors
   * dispatch to it and ignore the grid.
   */
  readonly analytic?: AnalyticSurface
  /** Samples per side. `terrainSize / baseResolution + 1`. */
  readonly vertPerSide: number
  /** Normalised 0..1 heights, `[z * vertPerSide + x]`. */
  readonly heights: Float32Array
  /** Metres per grid step. */
  readonly step: number
  readonly terrainSize: number
  readonly terrainHeight: number
  /** The terrain transform, SIM (Unity) space. Mesh space is 0..terrainSize. */
  readonly originX: number
  readonly originY: number
  readonly originZ: number
  readonly scaleX: number
  readonly scaleY: number
  readonly scaleZ: number
}

const _rgb: Rgb = { r: 0, g: 0, b: 0 }

export interface HeightFieldTransform {
  readonly position: readonly number[]
  readonly scale: readonly number[]
}

/**
 * Build the collision surface.
 *
 * Deliberately NOT sharing `buildVertexGrid`: that one adds the jitter, and the
 * whole point of this file is the surface without it. Sharing would mean
 * subtracting a random number, which is not a thing that can be done.
 */
export const buildHeightField = (
  heightMap: MapSampler,
  params: FacetedTerrainParams,
  transform: HeightFieldTransform,
): HeightField => {
  const quadPerSide = params.terrainSize / params.baseResolution
  const vertPerSide = quadPerSide + 1
  const heights = new Float32Array(vertPerSide * vertPerSide)
  for (let x = 0; x < vertPerSide; x++) {
    const u = x / (vertPerSide - 1)
    for (let z = 0; z < vertPerSide; z++) {
      const v = z / (vertPerSide - 1)
      heightMap.sample(u, v, _rgb)
      heights[z * vertPerSide + x] = grayscale(_rgb.r, _rgb.g, _rgb.b)
    }
  }
  return {
    vertPerSide,
    heights,
    step: params.baseResolution,
    terrainSize: params.terrainSize,
    terrainHeight: params.terrainHeight,
    originX: transform.position[0] as number,
    originY: transform.position[1] as number,
    originZ: transform.position[2] as number,
    scaleX: transform.scale[0] as number,
    scaleY: transform.scale[1] as number,
    scaleZ: transform.scale[2] as number,
  }
}

/** Grid sample, clamped at the edges the way a terrain collider is. */
const sampleGrid = (field: HeightField, ix: number, iz: number): number => {
  const n = field.vertPerSide
  const cx = ix < 0 ? 0 : ix > n - 1 ? n - 1 : ix
  const cz = iz < 0 ? 0 : iz > n - 1 ? n - 1 : iz
  return field.heights[cz * n + cx] as number
}

/**
 * Terrain height at a world point, SIM space. Bilinear between grid samples.
 *
 * Unity's `TerrainCollider` is a heightfield: it interpolates the stored array
 * rather than re-reading the source texture, so this interpolates the array too.
 * Sampling `islandgroup_height.png` directly here would be smoother, closer to
 * the source, and **wrong** — on an 8 m pitch the two differ by metres in steep
 * ground, and the one the game collided against is this one.
 */
export const terrainHeightAt = (field: HeightField, x: number, z: number): number => {
  if (field.analytic) return field.analytic.heightAt(x, z)
  // World -> mesh space.
  const mx = (x - field.originX) / (field.scaleX || 1)
  const mz = (z - field.originZ) / (field.scaleZ || 1)
  const gx = mx / field.step
  const gz = mz / field.step
  const ix = Math.floor(gx)
  const iz = Math.floor(gz)
  const fx = gx - ix
  const fz = gz - iz
  const h00 = sampleGrid(field, ix, iz)
  const h10 = sampleGrid(field, ix + 1, iz)
  const h01 = sampleGrid(field, ix, iz + 1)
  const h11 = sampleGrid(field, ix + 1, iz + 1)
  const a = h00 + (h10 - h00) * fx
  const b = h01 + (h11 - h01) * fx
  const normalised = a + (b - a) * fz
  return field.originY + normalised * field.terrainHeight * (field.scaleY || 1)
}

/**
 * The highest point of the surface, in world metres. Pure, O(samples), once.
 *
 * DEV-167 / W6 needs it: the sea's cheap shader variant is only equivalent to
 * the expensive one when EVERY visible piece of surface is below the eye, so
 * the test has to be against the plate's ceiling and not against the one
 * sample under the ship.
 *
 * The first version of that change used the render group's `position.y`, which
 * for Simonet's ocean is **not** the sea level — the surface height lives in
 * the height map, and the group sits near the origin. It chose the cheap
 * variant 55 m UNDER the water, and six screenshots against their own noise
 * floor are what caught it. Ask the field.
 */
export const maxFieldHeight = (field: HeightField): number => {
  if (field.analytic) return field.originY + field.terrainHeight * (field.scaleY || 1)
  let top = 0
  for (const h of field.heights) if (h > top) top = h
  return field.originY + top * field.terrainHeight * (field.scaleY || 1)
}

/** Is this point outside the terrain's footprint entirely? */
export const outsideField = (field: HeightField, x: number, z: number): boolean => {
  if (field.analytic) return !field.analytic.inside(x, z)
  const mx = (x - field.originX) / (field.scaleX || 1)
  const mz = (z - field.originZ) / (field.scaleZ || 1)
  return mx < 0 || mz < 0 || mx > field.terrainSize || mz > field.terrainSize
}

/**
 * Surface normal, SIM space, from the height gradient.
 *
 * Central difference over one grid step. A per-triangle normal would be more
 * faithful to a heightfield collider's actual facets, but it flips abruptly
 * across every edge and makes a grazing contact chatter; the gradient is the
 * same surface, read smoothly.
 */
export const terrainNormalAt = (
  field: HeightField,
  x: number,
  z: number,
  out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } => {
  // On a closed-form surface the gradient step is the surface's own; a step
  // wall reads as a horizontal normal within `normalStep` of the edge.
  const d = field.analytic ? field.analytic.normalStep : field.step * (field.scaleX || 1)
  const hl = terrainHeightAt(field, x - d, z)
  const hr = terrainHeightAt(field, x + d, z)
  const hd = terrainHeightAt(field, x, z - d)
  const hu = terrainHeightAt(field, x, z + d)
  const nx = hl - hr
  const nz = hd - hu
  const ny = 2 * d
  const len = Math.hypot(nx, ny, nz) || 1
  out.x = nx / len
  out.y = ny / len
  out.z = nz / len
  return out
}

/**
 * Pass as `standingY` to `highestGroundUnder` to read every floating pad as
 * solid all the way down to the ground, which is what a caller that never
 * asks `belowField` has always answered.
 */
export const PADS_SOLID = Number.POSITIVE_INFINITY

/**
 * The highest surface under (x, z) across `fields`, or -Infinity where no
 * field reaches. The one place the question is written (code-reuse SG-4).
 *
 * `standingY` is the height of the thing asking, and it is NOT optional,
 * because it decides whether a floating pad counts (`belowField`, DEV-383):
 * a field the point is UNDER is skipped. Pass `PADS_SOLID` to count every pad
 * as solid to the ground, or the point's own y (or `y + radius` for a sphere
 * that must be wholly under) to let a ship go beneath one. Each caller states
 * its rule at the call site instead of inheriting one by accident.
 *
 * A max over fields is order-independent and exact, and so is the
 * `y - highest` it replaces for `min(y - h)`: IEEE subtraction rounds
 * monotonically, so the two agree to the bit.
 */
export const highestGroundUnder = (
  fields: readonly HeightField[],
  x: number,
  z: number,
  standingY: number,
): number => {
  let best = Number.NEGATIVE_INFINITY
  for (const field of fields) {
    if (outsideField(field, x, z)) continue
    if (belowField(field, standingY)) continue
    const h = terrainHeightAt(field, x, z)
    if (h > best) best = h
  }
  return best
}
