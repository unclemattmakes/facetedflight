// src/sim/life/sea-facet.ts — which triangle of the SEA a floating thing sits on.
//
// DEV-447, the boats. Matt: *"would like the "life" pass to come online sometime
// soon."* A moored boat is the first of it, and a boat has one job before any
// other: sit ON the water you can see.
//
// ── Why the obvious surface is the wrong one ──────────────────────────────
//
// The sea has THREE surfaces in this port, and only one of them is drawn:
//
//   the collider   `HeightField` — the height map, bilinear, no jitter. What
//                  DEV-429's spray reads. Up to `randomOffset` (2 m on both
//                  ocean plates) off the drawn mesh before a wave moves at all.
//   the wave       `render/water.ts`'s `waterDisplacement` evaluated at a
//                  point: an 11.1 m wave (DEV-023).
//   the MESH       2016's 32 m ocean grid, jittered, triangulated with the
//                  diagonal bug, split 8x8 by `subdivideTriangleSoup` with its
//                  own interior jitter, and then EACH VERTEX displaced by that
//                  wave. What you see is the wave sampled every 32 m and
//                  interpolated flat across each triangle.
//
// An 11 m wave sampled at 32 m is not the wave (water.ts: *"CHOP: pseudo-random
// heights"*), so a hull that reads the wave at its own position heaves ±4 m out
// of phase with the facet it is drawn on, and a hull that reads the collider is
// up to 2 m out before the chop starts. The only surface a boat can sit on is
// the triangle the renderer drew under it. This file finds that triangle.
//
// ── Bit for bit, because the jitter is a hash ─────────────────────────────
//
// The parent triangle's corners come straight out of the vertex grid
// (`renderFacetAt`, in emission order). The sub-triangle is rebuilt the way
// `subdivideTriangleSoup` builds it — the SAME barycentric expression in the
// same operand order, stored through `Math.fround` exactly where the soup
// stores into a `Float32Array`, and the interior points pushed by the SAME
// exported `interiorJitter`. That hash is `sin(...) * 43758.5453`: one float32
// ulp of difference in its input is a different offset entirely. So this is not
// "close to" the renderer's triangle; `tests/unit/sea-facet.test.ts` asserts it
// IS one of the soup's triangles, byte for byte, by building the soup with the
// real functions and looking it up.
//
// ── What it does NOT reproduce ────────────────────────────────────────────
//
//  * The WAVE. That is added per frame by the render layer, from the corners
//    this returns (`render/life-boats.ts`), because the wave is a function of
//    the render clock and this file has no clock (hard rule 4).
//  * LOD above 0. A chunk further than the ocean's LOD band is drawn at a
//    stride with a coarser split, and its triangle under a boat is a different
//    one. The ocean's chunks are 8 km across and a boat is placed within a few
//    hundred metres of the route, so the chunk under every boat the player can
//    make out is the one the player is over — LOD 0 (the Anniversary ladder's
//    own note: *"at most stands every built chunk is at LOD 0"*). A boat
//    further than the band is a few pixels and a few metres off, which is the
//    trade `surface.ts` makes for props at LOD 1 too.
//
// SIM LAYER: pure. No three, no DOM, no clock, no `Math.random`.

import { interiorJitter } from '@/sim/terrain/chunk-to-three'
import type { FacetedTerrainParams } from '@/sim/terrain/faceted'
import type { MapSampler } from '@/sim/terrain/image-sampler'
import { renderFacetAt, type SurfaceGrid } from '@/sim/terrain/surface'

/** A hair of tolerance, so a point ON a shared edge is inside. The value `surface.ts` uses. */
const EDGE_EPS = 1e-6

/**
 * Does the plan projection of (a, b, c) cover (px, pz)? Corners are read out
 * of `pts` at the three given offsets (xyz triples).
 */
const covers = (
  pts: Float64Array,
  a: number,
  b: number,
  c: number,
  px: number,
  pz: number,
): boolean => {
  const ax = pts[a] as number
  const az = pts[a + 2] as number
  const bx = pts[b] as number
  const bz = pts[b + 2] as number
  const cx = pts[c] as number
  const cz = pts[c + 2] as number
  const det = (bx - ax) * (cz - az) - (cx - ax) * (bz - az)
  if (Math.abs(det) < 1e-12) return false
  const wb = ((px - ax) * (cz - az) - (cx - ax) * (pz - az)) / det
  const wc = ((bx - ax) * (pz - az) - (px - ax) * (bz - az)) / det
  const wa = 1 - wb - wc
  return !(wa < -EDGE_EPS || wb < -EDGE_EPS || wc < -EDGE_EPS)
}

/**
 * The drawn sea triangle over mesh-space (x, z), at LOD 0, split `subdivide`
 * times with `jitter` of interior jitter — the two numbers the ocean's LOD 0
 * chunks are finished with (`subdivideAt(ladder, 0)` and `randomOffset`).
 *
 * Writes the triangle's three corners into `out` (a.xyz, b.xyz, c.xyz), MESH
 * space, float32 values held in float64. Returns false only at a fold, where
 * no sub-triangle covers the point and the nearest one by centroid is written
 * instead — the same "a caller always gets a facet rather than a hole" rule
 * `surface.ts` keeps.
 */
export const seaFacetAt = (
  grid: SurfaceGrid,
  heightMap: MapSampler,
  params: FacetedTerrainParams,
  subdivide: number,
  jitter: number,
  x: number,
  z: number,
  out: Float64Array,
): boolean => {
  const parent = new Float64Array(9)
  renderFacetAt(grid, heightMap, params, x, z, 0, parent)
  const n = Math.max(1, Math.floor(subdivide))
  if (n === 1) {
    out.set(parent)
    return true
  }

  // Every lattice point of the face, built as `subdivideTriangleSoup`'s `emit`
  // builds it. Index (i, j) with 0 <= i, j and i + j <= n.
  const row = n + 1
  const lattice = new Float64Array(row * row * 3)
  const at = (i: number, j: number): number => (i * row + j) * 3
  const off = [0, 0, 0]
  const jxz = jitter / n
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n - i; j++) {
      // `wa(i, j)`, `i / n`, `j / n` — written exactly as the soup writes them.
      const u = 1 - i / n - j / n
      const v = i / n
      const w = j / n
      const p = at(i, j)
      for (let k = 0; k < 3; k++) {
        // The soup assigns this sum into a Float32Array: `fround` is that store.
        lattice[p + k] = Math.fround(
          u * (parent[k] as number) + v * (parent[3 + k] as number) + w * (parent[6 + k] as number),
        )
      }
      if (jitter > 0 && i > 0 && j > 0 && i + j < n) {
        interiorJitter(
          lattice[p] as number,
          lattice[p + 2] as number,
          (lattice[p + 1] as number) * 0.017,
          off,
        )
        lattice[p] = Math.fround((lattice[p] as number) + (off[0] as number) * jxz)
        lattice[p + 1] = Math.fround((lattice[p + 1] as number) + (off[1] as number) * jitter)
        lattice[p + 2] = Math.fround((lattice[p + 2] as number) + (off[2] as number) * jxz)
      }
    }
  }

  // The soup's two sub-triangles per lattice cell, in its emission order.
  let bestD = Number.POSITIVE_INFINITY
  let best: readonly [number, number, number] = [at(0, 0), at(1, 0), at(0, 1)]
  const consider = (a: number, b: number, c: number): boolean => {
    if (covers(lattice, a, b, c, x, z)) {
      best = [a, b, c]
      return true
    }
    const mx = ((lattice[a] as number) + (lattice[b] as number) + (lattice[c] as number)) / 3
    const mz =
      ((lattice[a + 2] as number) + (lattice[b + 2] as number) + (lattice[c + 2] as number)) / 3
    const d = (mx - x) ** 2 + (mz - z) ** 2
    if (d < bestD) {
      bestD = d
      best = [a, b, c]
    }
    return false
  }
  let found = false
  for (let i = 0; i < n && !found; i++) {
    for (let j = 0; j < n - i && !found; j++) {
      if (consider(at(i, j), at(i + 1, j), at(i, j + 1))) found = true
      else if (i + j < n - 1 && consider(at(i + 1, j), at(i + 1, j + 1), at(i, j + 1))) found = true
    }
  }
  for (let k = 0; k < 3; k++) {
    const src = best[k] as number
    out[k * 3] = lattice[src] as number
    out[k * 3 + 1] = lattice[src + 1] as number
    out[k * 3 + 2] = lattice[src + 2] as number
  }
  return found
}

/**
 * Barycentric weights of plan point (px, pz) in triangle `t` (a.xyz, b.xyz,
 * c.xyz). Into `w`. Outside the triangle the weights go negative and the plane
 * extends — which is what a hull point overhanging a facet edge by a metre
 * should read.
 */
export const planWeights = (t: Float64Array, px: number, pz: number, w: number[]): void => {
  const ax = t[0] as number
  const az = t[2] as number
  const bx = t[3] as number
  const bz = t[5] as number
  const cx = t[6] as number
  const cz = t[8] as number
  const det = (bx - ax) * (cz - az) - (cx - ax) * (bz - az)
  if (Math.abs(det) < 1e-12) {
    w[0] = 1
    w[1] = 0
    w[2] = 0
    return
  }
  const wb = ((px - ax) * (cz - az) - (cx - ax) * (pz - az)) / det
  const wc = ((bx - ax) * (pz - az) - (px - ax) * (bz - az)) / det
  w[0] = 1 - wb - wc
  w[1] = wb
  w[2] = wc
}
