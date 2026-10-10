// src/sim/terrain/ocean-ring-lattice.ts: the sea's vertices, baked as a lattice.
//
// DEV-339 (docs/plan/OCEAN-PERF.md §3). The ocean's plate is a `FacetedTerrain`:
// a jittered grid, a per-quad diagonal, every parent triangle split n x n with a
// position-hashed interior jitter (DEV-023). The camera-centred rings of
// `render/ocean-rings.ts` draw the SAME vertices, and the only way to be exact
// about "the same" is to not re-derive them: this file runs the plate's own
// arithmetic once, over a window, and keeps the answer.
//
// ── Why a baked table and not a shader ────────────────────────────────────
//
// The plan sketched the sub-vertex rule as GLSL ("a pure function of the cell
// and the lattice, so the shader can compute it"). It is a pure function, and
// it cannot be computed there: `interiorJitter` is `sin(x * 12.9898 + ...) *
// 43758.5453` of a FLOAT32 position in the tens of thousands, so one ulp of
// input is a different offset entirely (`sea-facet.ts` says the same), and a
// GPU's `sin` of an argument near 1e6 is not float64's. A shader copy would be
// a second, different sea that merely resembled the first. So the bake runs in
// TypeScript with the plate's float32 stores (`Math.fround` exactly where
// `subdivideTriangleSoup` stores into a `Float32Array`), and the shader fetches.
//
// ── The lattice ────────────────────────────────────────────────────────────
//
// A level is a pair (stride, n): LOD is a stride of `stride = 2^lod` over the
// shared vertex grid (`generateChunk`), so its parent quad is
// `baseResolution * stride` mesh units, and every parent triangle is split
// n x n. The sub-lattice is therefore `n` steps per parent quad and its point
// (gx, gz) is owned by quad (floor(gx / n), floor(gz / n)) with local index
// (lu, lv) = (gx mod n, gz mod n). Which of the quad's two triangles holds a
// point, and the barycentric (i, j) inside it, are the inverse of
// `subdivideTriangleSoup`'s emit loop; the diagonal is
// `diagonalTopLeftToBottomRight` itself, called with the same four corners.
//
// A texel is (x, y, z, diag): the point's final position in LOCAL THREE space
// (x, y, and z NEGATED, which is what `flipChunkToThree` does to the mesh) and,
// in alpha, the plate's diagonal bit for the sub-cell whose MIN corner this
// point is (1 = `topLeftToBottomRight`, the 0-1-2 / 2-1-3 split).
//
// SIM LAYER: pure. No three, no DOM, no clock, no `Math.random`.

import { interiorJitter } from './chunk-to-three'
import { diagonalTopLeftToBottomRight, type FacetedTerrainParams, type MapSampler } from './faceted'

/** One ring level: LOD stride over the grid, and sub-quads per parent edge. */
export interface RingLevelSpec {
  /** `1 << lod`: parent quads are `baseResolution * stride` mesh units. */
  readonly stride: number
  /** Sub-quads per parent edge (the ocean ladder's rung at that LOD). */
  readonly n: number
}

/** A window of the level's lattice, in lattice indices. */
export interface RingWindow {
  readonly gx0: number
  readonly gz0: number
  readonly width: number
  readonly height: number
}

export interface RingLattice extends RingWindow {
  /** RGBA32F texels, row-major, row = lattice z index: x, y, -z, diag. */
  readonly data: Float32Array
}

/** Mesh units between two lattice steps. */
export const ringStepMesh = (params: FacetedTerrainParams, spec: RingLevelSpec): number =>
  (params.baseResolution * spec.stride) / spec.n

/** Lattice points per side, MINUS one: the last valid index. */
export const ringLatticeMax = (params: FacetedTerrainParams, spec: RingLevelSpec): number =>
  (params.terrainSize / params.baseResolution / spec.stride) * spec.n

/** Which triangle of the quad holds local (lu, lv), and its (i, j). */
interface TriChoice {
  /** Corner slots (0..3 as in the generator) of the face's A, B, C. */
  readonly a: number
  readonly b: number
  readonly c: number
  readonly i: number
  readonly j: number
}

/**
 * The inverse of `subdivideTriangleSoup`'s emit for a point at local (lu, lv)
 * of a quad split with `diag`. Corner slots: 0 = (x0, z0), 1 = (x0, z1),
 * 2 = (x1, z0), 3 = (x1, z1); face order is the generator's emission order,
 * (0,1,2) then (2,1,3) when `diag`, else (0,1,3) then (0,3,2).
 */
export const ringTriangleFor = (diag: boolean, n: number, lu: number, lv: number): TriChoice => {
  if (diag) {
    if (lu + lv <= n) return { a: 0, b: 1, c: 2, i: lv, j: lu }
    return { a: 2, b: 1, c: 3, i: n - lu, j: lu + lv - n }
  }
  if (lv >= lu) return { a: 0, b: 1, c: 3, i: lv - lu, j: lu }
  return { a: 0, b: 3, c: 2, i: lv, j: lu - lv }
}

const PENDING: [number, number, number] = [0, 0, 0]

/**
 * The plate's own vertex at sub-lattice (lu, lv) of a quad, in UNITY mesh space
 * (x, y, z), written into `out`. `corners` is the four quad corners, 12 floats
 * (slot k at 3k). Exactly `subdivideTriangleSoup`'s arithmetic, float32 stores
 * included, so it is bit for bit the soup's vertex.
 */
export const ringPoint = (
  corners: Float32Array,
  tri: TriChoice,
  n: number,
  jitter: number,
  out: Float64Array | number[],
  at = 0,
): void => {
  const u = 1 - tri.i / n - tri.j / n
  const v = tri.i / n
  const w = tri.j / n
  const A = tri.a * 3
  const B = tri.b * 3
  const C = tri.c * 3
  const p = [0, 0, 0]
  for (let k = 0; k < 3; k++) {
    p[k] = Math.fround(
      u * (corners[A + k] as number) +
        v * (corners[B + k] as number) +
        w * (corners[C + k] as number),
    )
  }
  if (jitter > 0 && tri.i > 0 && tri.j > 0 && tri.i + tri.j < n) {
    const jxz = jitter / n
    interiorJitter(p[0] as number, p[2] as number, (p[1] as number) * 0.017, PENDING)
    p[0] = Math.fround((p[0] as number) + (PENDING[0] as number) * jxz)
    p[1] = Math.fround((p[1] as number) + (PENDING[1] as number) * jitter)
    p[2] = Math.fround((p[2] as number) + (PENDING[2] as number) * jxz)
  }
  out[at] = p[0] as number
  out[at + 1] = p[1] as number
  out[at + 2] = p[2] as number
}

/** The four jittered corners of parent quad (qx, qz) at `stride`, and its diagonal. */
export const ringQuad = (
  grid: { verts: Float32Array; vertPerSide: number },
  heightMap: MapSampler,
  params: FacetedTerrainParams,
  stride: number,
  qx: number,
  qz: number,
  corners: Float32Array,
): boolean => {
  const { verts, vertPerSide } = grid
  const cx = [0, 0, 0, 0]
  const cy = [0, 0, 0, 0]
  const cz = [0, 0, 0, 0]
  const x0 = qx * stride
  const z0 = qz * stride
  const slots: readonly (readonly [number, number])[] = [
    [x0, z0],
    [x0, z0 + stride],
    [x0 + stride, z0],
    [x0 + stride, z0 + stride],
  ]
  for (let s = 0; s < 4; s++) {
    const [gx, gy] = slots[s] as readonly [number, number]
    const i = (gx * vertPerSide + gy) * 3
    cx[s] = verts[i] as number
    cy[s] = verts[i + 1] as number
    cz[s] = verts[i + 2] as number
    corners[s * 3] = verts[i] as number
    corners[s * 3 + 1] = verts[i + 1] as number
    corners[s * 3 + 2] = verts[i + 2] as number
  }
  return diagonalTopLeftToBottomRight(cx, cy, cz, heightMap, params)
}

/** Clamp a requested window into the plate's lattice. */
export const clampRingWindow = (
  params: FacetedTerrainParams,
  spec: RingLevelSpec,
  w: RingWindow,
): RingWindow => {
  const max = ringLatticeMax(params, spec)
  const gx0 = Math.max(0, Math.floor(w.gx0))
  const gz0 = Math.max(0, Math.floor(w.gz0))
  const gx1 = Math.min(max, Math.ceil(w.gx0 + w.width) - 1)
  const gz1 = Math.min(max, Math.ceil(w.gz0 + w.height) - 1)
  return { gx0, gz0, width: Math.max(0, gx1 - gx0 + 1), height: Math.max(0, gz1 - gz0 + 1) }
}

/**
 * Bake a window of one level's lattice. See the header for the texel layout.
 *
 * Cost is one `ringPoint` per texel (three hashes for an interior one) and one
 * `diagonalTopLeftToBottomRight` per parent quad touched: tens of milliseconds
 * for the innermost level over a few kilometres.
 */
export const bakeRingLattice = (
  grid: { verts: Float32Array; vertPerSide: number },
  heightMap: MapSampler,
  params: FacetedTerrainParams,
  spec: RingLevelSpec,
  request: RingWindow,
): RingLattice => {
  const win = clampRingWindow(params, spec, request)
  const { n } = spec
  const quads = params.terrainSize / params.baseResolution / spec.stride
  const data = new Float32Array(win.width * win.height * 4)
  const corners = new Float32Array(12)
  const out = new Float64Array(3)
  const qx0 = Math.floor(win.gx0 / n)
  const qz0 = Math.floor(win.gz0 / n)
  const qx1 = Math.min(quads - 1, Math.floor((win.gx0 + win.width - 1) / n))
  const qz1 = Math.min(quads - 1, Math.floor((win.gz0 + win.height - 1) / n))
  for (let qx = qx0; qx <= qx1; qx++) {
    for (let qz = qz0; qz <= qz1; qz++) {
      const diag = ringQuad(grid, heightMap, params, spec.stride, qx, qz, corners)
      // The last quad owns its far edge too (local index n), so the final
      // lattice row and column exist.
      const lastX = qx === quads - 1 ? n : n - 1
      const lastZ = qz === quads - 1 ? n : n - 1
      for (let lu = 0; lu <= lastX; lu++) {
        const gx = qx * n + lu
        const ix = gx - win.gx0
        if (ix < 0 || ix >= win.width) continue
        for (let lv = 0; lv <= lastZ; lv++) {
          const gz = qz * n + lv
          const iz = gz - win.gz0
          if (iz < 0 || iz >= win.height) continue
          ringPoint(corners, ringTriangleFor(diag, n, lu, lv), n, params.randomOffset, out)
          const o = (iz * win.width + ix) * 4
          data[o] = out[0] as number
          data[o + 1] = out[1] as number
          // The flip into three space, exactly `flipChunkToThree`'s.
          data[o + 2] = -(out[2] as number)
          data[o + 3] = diag ? 1 : 0
        }
      }
    }
  }
  return { ...win, data }
}
