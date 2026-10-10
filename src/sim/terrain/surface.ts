// src/sim/terrain/surface.ts — the height of the surface you can SEE.
//
// ── Why a third surface ───────────────────────────────────────────────────
//
// `height-field.ts` is the surface you HIT: the source map on the 8 m grid,
// bilinear, with no jitter — 2016's `TerrainCollider`, exactly. `faceted.ts`
// builds the surface you SEE: the same grid with every vertex pushed by
// `Random.insideUnitSphere * RandomOffset` (0.8 m on alpine and desert, 1.3 m
// on Simonet) and then triangulated with the 2016 diagonal bug. The two
// disagree by up to the jitter, per vertex, and CLAUDE.md's trap says it in
// four words: *"`heightField` is NOT what you see."*
//
// Nothing that stands ON the ground can use the collider and look right. The
// alpine trees did (DEV-134): 2016's `GenerateObjects()` reads the height map,
// so a trunk placed there hangs in the air wherever the jitter pushed the
// facet under it down, and is buried wherever it pushed it up. That is what a
// forest of props "floating" looks like from the seat.
//
// So this module answers *what height does the RENDERED mesh have at (x, z)?*
// — by walking the same vertex grid `buildVertexGrid` built, choosing each
// quad's diagonal with the SAME exported function `generateChunk` calls
// (`diagonalTopLeftToBottomRight`), and interpolating the triangle the point
// lands in. It is not a second triangulation; it is the first one, queried.
//
// ── What it does NOT reproduce, and why that is fine ─────────────────────
//
// A chunk drawn at LOD 1 or 2 is a stride over the same grid — every LOD
// vertex is a LOD 0 vertex, jitter included — so the rendered surface at a
// coarser level cuts UNDER a ridge and OVER a gully. `lod` asks the question
// at that stride; the default is 0, the surface a chunk shows when you are
// close enough to see a tree's roots. The detail ring (DEV-085) is a finer
// grid with its own jitter and is not reproduced here.
//
// SIM LAYER: pure. No three, no DOM, no clock, no `Math.random`.

import { diagonalTopLeftToBottomRight, type FacetedTerrainParams, type MapSampler } from './faceted'

/** The jittered vertex grid, as `buildVertexGrid` returns it. */
export interface SurfaceGrid {
  readonly verts: Float32Array
  readonly vertPerSide: number
}

/**
 * The quads a jittered point can have landed in.
 *
 * The jitter radius is under half a cell on every shipped terrain (1.3 m on an
 * 8 m grid at most), so a point's triangle is in its own lattice cell or one of
 * the eight around it. Own cell first: it is the answer almost always.
 */
const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [0, 0],
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
]

/** Scratch. Valid only inside one synchronous call — never stored (trap 19). */
const cx = [0, 0, 0, 0]
const cy = [0, 0, 0, 0]
const cz = [0, 0, 0, 0]
/** The three corner slots of the facet `locateFacet` found. Same rule as above. */
const tri = [0, 0, 0]

/**
 * A quad's two triangles as corner SLOTS, per diagonal — the pairings
 * `generateChunk` emits (slots as `readCorners` fills them, below). Indices,
 * not tunings.
 */
type TriPair = readonly [number, number, number, number, number, number]
const PAIR_TL: TriPair = [0, 1, 2, 2, 1, 3]
const PAIR_TR: TriPair = [0, 1, 3, 0, 3, 2]

/** A hair of tolerance on the barycentric test, so a point ON a shared edge is inside. */
const EDGE_EPS = 1e-6

/**
 * Does triangle (a, b, c) cover (px, pz) in plan? Barycentric in the
 * horizontal plane, which is what "the mesh under this point" means for a
 * heightfield-shaped surface. A triangle with no area in plan covers nothing.
 */
const coversPoint = (a: number, b: number, c: number, px: number, pz: number): boolean => {
  const ax = cx[a] as number
  const az = cz[a] as number
  const bx = cx[b] as number
  const bz = cz[b] as number
  const ccx = cx[c] as number
  const ccz = cz[c] as number
  const det = (bx - ax) * (ccz - az) - (ccx - ax) * (bz - az)
  if (Math.abs(det) < 1e-12) return false
  const wb = ((px - ax) * (ccz - az) - (ccx - ax) * (pz - az)) / det
  const wc = ((bx - ax) * (pz - az) - (px - ax) * (bz - az)) / det
  const wa = 1 - wb - wc
  return !(wa < -EDGE_EPS || wb < -EDGE_EPS || wc < -EDGE_EPS)
}

const setTri = (a: number, b: number, c: number): void => {
  tri[0] = a
  tri[1] = b
  tri[2] = c
}

/**
 * Find the facet the rendered mesh draws over mesh-space (x, z) at `lod`.
 *
 * Leaves that facet's quad in `cx`/`cy`/`cz` and its three corner slots in
 * `tri`. ONE search, shared by the height and the slope below (DEV-356), so
 * "the slope under a prop" is the slope of the very facet its base was
 * snapped to and can never be a neighbour's.
 *
 * Outside the terrain, or where the jitter has folded a triangle so that no
 * face covers the point (rare, and only at a fold), it falls back to the
 * home quad's first triangle without the inside test, so a caller always
 * gets a facet rather than a hole.
 */
const locateFacet = (
  grid: SurfaceGrid,
  heightMap: MapSampler,
  params: FacetedTerrainParams,
  x: number,
  z: number,
  lod: number,
): void => {
  const { verts, vertPerSide } = grid
  const stride = 1 << lod
  const cell = params.baseResolution * stride
  const quadsPerSide = Math.floor((vertPerSide - 1) / stride)
  const qx0 = Math.min(quadsPerSide - 1, Math.max(0, Math.floor(x / cell)))
  const qz0 = Math.min(quadsPerSide - 1, Math.max(0, Math.floor(z / cell)))

  const readCorners = (qx: number, qz: number): void => {
    const gx0 = qx * stride
    const gz0 = qz * stride
    const gx1 = gx0 + stride
    const gz1 = gz0 + stride
    // The same slot layout as `generateChunk`'s `readCorner`: 0 = (x0,z0),
    // 1 = (x0,z1), 2 = (x1,z0), 3 = (x1,z1); grid index `(gx * N + gz) * 3`.
    const i0 = (gx0 * vertPerSide + gz0) * 3
    const i1 = (gx0 * vertPerSide + gz1) * 3
    const i2 = (gx1 * vertPerSide + gz0) * 3
    const i3 = (gx1 * vertPerSide + gz1) * 3
    cx[0] = verts[i0] as number
    cy[0] = verts[i0 + 1] as number
    cz[0] = verts[i0 + 2] as number
    cx[1] = verts[i1] as number
    cy[1] = verts[i1 + 1] as number
    cz[1] = verts[i1 + 2] as number
    cx[2] = verts[i2] as number
    cy[2] = verts[i2 + 1] as number
    cz[2] = verts[i2 + 2] as number
    cx[3] = verts[i3] as number
    cy[3] = verts[i3 + 1] as number
    cz[3] = verts[i3 + 2] as number
  }

  for (const [dx, dz] of NEIGHBOURS) {
    const qx = qx0 + dx
    const qz = qz0 + dz
    if (qx < 0 || qz < 0 || qx >= quadsPerSide || qz >= quadsPerSide) continue
    readCorners(qx, qz)
    // The same pairings `generateChunk` emits for each diagonal.
    const tl = diagonalTopLeftToBottomRight(cx, cy, cz, heightMap, params)
    const [a0, b0, c0, a1, b1, c1] = tl ? PAIR_TL : PAIR_TR
    if (coversPoint(a0, b0, c0, x, z)) {
      setTri(a0, b0, c0)
      return
    }
    if (coversPoint(a1, b1, c1, x, z)) {
      setTri(a1, b1, c1)
      return
    }
  }

  // A fold: no face covers the point. Use the home quad's plane through its
  // first triangle, which is what the eye reads there anyway.
  readCorners(qx0, qz0)
  const tl = diagonalTopLeftToBottomRight(cx, cy, cz, heightMap, params)
  setTri(0, 1, tl ? 2 : 3)
}

/**
 * Height of the RENDERED terrain at mesh-space (x, z), metres, at `lod`.
 *
 * Mesh space is the terrain's own frame — x and z run 0..terrainSize, the
 * frame `scatterProps` writes positions in and the terrain group is drawn in.
 * The plane of the facet `locateFacet` finds, evaluated at the point; at a
 * fold that is the home quad's first triangle extended, so a caller always
 * gets a height rather than a hole.
 */
export const renderSurfaceHeightAt = (
  grid: SurfaceGrid,
  heightMap: MapSampler,
  params: FacetedTerrainParams,
  x: number,
  z: number,
  lod = 0,
): number => {
  locateFacet(grid, heightMap, params, x, z, lod)
  const a = tri[0] as number
  const b = tri[1] as number
  const c = tri[2] as number
  const ax = cx[a] as number
  const az = cz[a] as number
  const det =
    ((cx[b] as number) - ax) * ((cz[c] as number) - az) -
    ((cx[c] as number) - ax) * ((cz[b] as number) - az)
  if (Math.abs(det) < 1e-12) return cy[a] as number
  const wb = ((x - ax) * ((cz[c] as number) - az) - ((cx[c] as number) - ax) * (z - az)) / det
  const wc = (((cx[b] as number) - ax) * (z - az) - (x - ax) * ((cz[b] as number) - az)) / det
  const wa = 1 - wb - wc
  return wa * (cy[a] as number) + wb * (cy[b] as number) + wc * (cy[c] as number)
}

/**
 * How steep the RENDERED facet under mesh-space (x, z) is, at `lod` — DEV-356.
 *
 * `sin` of the facet's angle from horizontal: 0 is flat, 0.5 is 30°, 1 is a
 * wall. The same unit `sim/props/dressing.ts`'s `slopeMin`/`slopeMax` are
 * written in, so one number means one thing in every edition JSON.
 *
 * **The facet, not the map.** The dressing's `slopeAt` differences the
 * bilinear 4 m height map over one grid step; this is the plane of the
 * triangle you can SEE, jitter and 2016's diagonal bug included — the one
 * `renderSurfaceHeightAt` snaps a base to (CLAUDE.md, DEV-288: *"heightField
 * is NOT what you see"*). On steep ground the two differ by the most, which is
 * the only ground this function is asked about.
 */
export const renderSurfaceSlopeAt = (
  grid: SurfaceGrid,
  heightMap: MapSampler,
  params: FacetedTerrainParams,
  x: number,
  z: number,
  lod = 0,
): number => {
  locateFacet(grid, heightMap, params, x, z, lod)
  const a = tri[0] as number
  const b = tri[1] as number
  const c = tri[2] as number
  const e1x = (cx[b] as number) - (cx[a] as number)
  const e1y = (cy[b] as number) - (cy[a] as number)
  const e1z = (cz[b] as number) - (cz[a] as number)
  const e2x = (cx[c] as number) - (cx[a] as number)
  const e2y = (cy[c] as number) - (cy[a] as number)
  const e2z = (cz[c] as number) - (cz[a] as number)
  // The facet normal, e1 x e2. Its horizontal share of its length IS the sine
  // of the facet's tilt, whichever way round the winding is.
  const nx = e1y * e2z - e1z * e2y
  const ny = e1z * e2x - e1x * e2z
  const nz = e1x * e2y - e1y * e2x
  const len = Math.hypot(nx, ny, nz)
  if (!(len > 0)) return 0
  return Math.hypot(nx, nz) / len
}

/**
 * Snap a set of mesh-space placements to the rendered surface, in place.
 *
 * `positions` is `count * 3` in the terrain's mesh frame — the shape
 * `ScatteredProps` and `DressingPlacements` share. Each `y` becomes the
 * rendered height at its (x, z) minus `sink[i]` (or a constant), so a trunk's
 * base is a little under the facet rather than resting on a point of it.
 * Returns how many placements MOVED DOWN by more than `reportAbove` metres —
 * the count of what was floating — so a caller can say what it fixed.
 */
export const snapToRenderSurface = (
  positions: Float32Array,
  count: number,
  grid: SurfaceGrid,
  heightMap: MapSampler,
  params: FacetedTerrainParams,
  sink: number | Float32Array,
  reportAbove = 0,
): number => {
  let floating = 0
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3] as number
    const before = positions[i * 3 + 1] as number
    const z = positions[i * 3 + 2] as number
    const ground = renderSurfaceHeightAt(grid, heightMap, params, x, z)
    const s = typeof sink === 'number' ? sink : (sink[i] as number)
    if (before - ground > reportAbove) floating++
    positions[i * 3 + 1] = ground - s
  }
  return floating
}

/**
 * The three CORNERS of the rendered facet over mesh-space (x, z) at `lod` —
 * DEV-447.
 *
 * The same search `renderSurfaceHeightAt` makes, handing out the facet itself
 * rather than a height on it, **in the order `generateChunk` emits the
 * triangle's vertices**: `out` is a.xyz, b.xyz, c.xyz. The order is not
 * cosmetic. `subdivideTriangleSoup` weights the corners by their position in
 * the face, and its interior jitter is a `sin() * 43758` hash of the
 * resulting FLOAT32 position, so a caller rebuilding the ocean's sub-facets
 * from these corners reproduces the renderer's bytes only when the corners
 * arrive in the renderer's order (`sim/life/sea-facet.ts`).
 *
 * Mesh space and the grid's own float32 values, untouched: nothing here is
 * interpolated, so a corner is bit-identical to the vertex the chunk draws.
 */
export const renderFacetAt = (
  grid: SurfaceGrid,
  heightMap: MapSampler,
  params: FacetedTerrainParams,
  x: number,
  z: number,
  lod: number,
  out: number[] | Float64Array,
): void => {
  locateFacet(grid, heightMap, params, x, z, lod)
  for (let k = 0; k < 3; k++) {
    const s = tri[k] as number
    out[k * 3] = cx[s] as number
    out[k * 3 + 1] = cy[s] as number
    out[k * 3 + 2] = cz[s] as number
  }
}
