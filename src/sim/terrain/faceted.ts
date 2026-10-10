// src/sim/terrain/faceted.ts — the faceted terrain generator.
//
// A reimplementation of the 2016 `FacetedTerrain.cs` mesh builder. This is not
// optional work: the generator in the Unity project lives entirely inside
// `#if UNITY_EDITOR` and its output was baked to `.asset` files that are
// unshippable, so the only way to get terrain into the browser is to rebuild
// the generator. PORT_PLAN D3.
//
// The upside of being forced here is large: once we own the generator,
// procedural worlds, an endless mode and a level editor stop being rewrites
// and become parameter changes.
//
// ── What makes it look "faceted" ──────────────────────────────────────────
// Three things, in order of importance:
//
//  1. **Every triangle gets ONE colour**, sampled from the colour map at the
//     triangle's barycentre and written to all three of its vertices. No
//     interpolation across a face, so every edge is a hard crease.
//  2. **Vertices are fully split.** Triangles share no vertices, so normals
//     are per-face and nothing smooths.
//  3. **Every grid vertex is jittered** by a random offset before
//     triangulation. Without it the regular grid reads as a grid; with it the
//     same heightmap reads as hand-cut rock.
//
// Nothing is textured. The whole art style is per-vertex colour on flat faces,
// which is why the port needs almost no texture pipeline.
//
// SIM-LAYER RULES APPLY: no `three` import, no `Math.random()`. The jitter
// comes from a seeded PRNG so that a given (seed, params) pair always produces
// the same mesh — required because the visual mesh and the collision
// heightfield must agree, and because CI asserts a vertex-buffer hash.

import { type Vec3, v3 } from '../math/vec3'

// The sampler interface and its one implementation live next door, so the
// browser and the Node oracle harness filter pixels with the same code.
export type { MapSampler } from './image-sampler'

import { writeFlatTri } from '../math/flat-tri'
import { mulberry32 } from '../math/rng'
import type { MapSampler } from './image-sampler'

export interface FacetedTerrainParams {
  /** World size of one side, metres. Desert 4096; Simonet 4096. */
  readonly terrainSize: number
  /** Vertical scale applied to the greyscale height, metres. Desert 1024. */
  readonly terrainHeight: number
  /** World size of one chunk. Desert 512, Simonet 256. */
  readonly chunkSize: number
  /** Metres per quad at LOD 0. Shipped: 8. */
  readonly baseResolution: number
  /** Vertex jitter radius, metres. Shipped 0.6 default, 0.8 in Desert. */
  readonly randomOffset: number
  /** Seed for the jitter PRNG. Not a 2016 concept — see `jitter` below. */
  readonly seed: number
  /**
   * Reproduce the 2016 diagonal-choice bug (default true).
   *
   * `FacetedTerrain.cs:961` computes the mid-edge V coordinate as
   * `centerPointMidEdge0.y / TerrainSize` — the **height**, not `.z`. So the
   * "pick the diagonal that better matches the heightmap" test samples the map
   * at a meaningless V and compares two nearly arbitrary values.
   *
   * It still yields a deterministic per-quad boolean, so the terrain looked
   * fine and shipped. But the adaptive triangulation the code describes never
   * actually happened.
   *
   * Keeping the bug preserves the exact 2016 silhouette. Fixing it changes
   * every quad in the game. That is a design decision, not a cleanup — so it
   * is a flag, defaulted to faithful, and logged as a deviation candidate.
   */
  readonly faithfulDiagonalBug?: boolean
}

/** One chunk of generated geometry, ready to hand to the render layer. */
export interface TerrainChunkMesh {
  readonly chunkX: number
  readonly chunkY: number
  /** xyz triples, world space, fully split (3 unique verts per triangle). */
  readonly positions: Float32Array
  /** Per-vertex normals; flat, so all three verts of a face share one. */
  readonly normals: Float32Array
  /** rgb triples in 0..1. All three verts of a face share one colour. */
  readonly colors: Float32Array
  /** uv pairs; all three verts of a face share the barycentre uv. */
  readonly uvs: Float32Array
  readonly triangleCount: number
}

/**
 * Deterministic PRNG (mulberry32). Small, fast, good enough for jitter.
 *
 * This is NOT Unity's `Random.insideUnitSphere` — that generator is not
 * reproducible outside the engine, and chasing it would buy nothing. What
 * matters is that the jitter is (a) uniform in a ball of the right radius and
 * (b) identical on every run and every machine, so mesh and collision agree
 * and the CI hash is stable.
 */
export const makeRandom = mulberry32

/** Uniform point inside the unit ball — Unity's `Random.insideUnitSphere`. */
export const insideUnitSphere = (rnd: () => number, out: Vec3): Vec3 => {
  // Rejection sampling: simple, unbiased, and terminates fast (52% accept).
  for (;;) {
    const x = rnd() * 2 - 1
    const y = rnd() * 2 - 1
    const z = rnd() * 2 - 1
    if (x * x + y * y + z * z <= 1) {
      out.x = x
      out.y = y
      out.z = z
      return out
    }
  }
}

/** Unity's `Color.grayscale`: luminance, not a channel average. */
export const grayscale = (r: number, g: number, b: number): number =>
  0.299 * r + 0.587 * g + 0.114 * b

const _rgb = { r: 0, g: 0, b: 0 }

/**
 * Build the jittered vertex grid for the whole terrain, exactly as
 * `GenerateMeshes()` does: sample the heightmap bilinearly at the grid UV,
 * scale by `terrainHeight`, place at `u * terrainSize`, then add the jitter.
 *
 * Returned flat, row-major, indexed `[x * vertPerSide + y]` to match the
 * original's `originalVerts[x, y]`.
 */
export const buildVertexGrid = (
  heightMap: MapSampler,
  params: FacetedTerrainParams,
): { verts: Float32Array; vertPerSide: number } => {
  const quadPerSide = params.terrainSize / params.baseResolution
  const vertPerSide = quadPerSide + 1
  const verts = new Float32Array(vertPerSide * vertPerSide * 3)
  const rnd = makeRandom(params.seed)
  const jitter = v3()

  for (let x = 0; x < vertPerSide; x++) {
    const u = x / (vertPerSide - 1)
    for (let y = 0; y < vertPerSide; y++) {
      const v = y / (vertPerSide - 1)
      heightMap.sample(u, v, _rgb)
      const height = grayscale(_rgb.r, _rgb.g, _rgb.b) * params.terrainHeight

      insideUnitSphere(rnd, jitter)
      const i = (x * vertPerSide + y) * 3
      verts[i] = u * params.terrainSize + jitter.x * params.randomOffset
      verts[i + 1] = height + jitter.y * params.randomOffset
      verts[i + 2] = v * params.terrainSize + jitter.z * params.randomOffset
    }
  }

  return { verts, vertPerSide }
}

/**
 * Which way a quad is split, given its four jittered corners.
 *
 * Corners are 0 = (x0,z0), 1 = (x0,z1), 2 = (x1,z0), 3 = (x1,z1), each as
 * parallel `cx`/`cy`/`cz` slots. `true` is the 0-1-2 / 2-1-3 split; `false`
 * is 0-1-3 / 0-3-2. **THE 2016 BUG is in here, deliberately preserved**: with
 * `faithfulDiagonalBug` on (the default), V is taken from the midpoint's `.y`
 * (height) rather than `.z`, so the "pick the diagonal that better matches the
 * heightmap" test samples the map at a meaningless V. See the flag's doc.
 *
 * Exported so that anything that has to agree with the RENDERED triangles —
 * `surface.ts`, which puts a prop's roots on the mesh you can see — asks this
 * one function rather than carrying a second copy of the rule. Two copies of a
 * rule with a bug in it is how one of them gets "fixed" (DEV-134).
 */
export const diagonalTopLeftToBottomRight = (
  cx: readonly number[],
  cy: readonly number[],
  cz: readonly number[],
  heightMap: MapSampler,
  params: FacetedTerrainParams,
): boolean => {
  const faithful = params.faithfulDiagonalBug !== false
  const m0x = ((cx[1] as number) + (cx[2] as number)) * 0.5
  const m0y = ((cy[1] as number) + (cy[2] as number)) * 0.5
  const m0z = ((cz[1] as number) + (cz[2] as number)) * 0.5
  const m1x = ((cx[0] as number) + (cx[3] as number)) * 0.5
  const m1y = ((cy[0] as number) + (cy[3] as number)) * 0.5
  const m1z = ((cz[0] as number) + (cz[3] as number)) * 0.5

  const v0 = (faithful ? m0y : m0z) / params.terrainSize
  const v1 = (faithful ? m1y : m1z) / params.terrainSize

  heightMap.sample(m0x / params.terrainSize, v0, _rgb)
  const d0 = Math.abs(m0y - grayscale(_rgb.r, _rgb.g, _rgb.b) * params.terrainHeight)
  heightMap.sample(m1x / params.terrainSize, v1, _rgb)
  const d1 = Math.abs(m1y - grayscale(_rgb.r, _rgb.g, _rgb.b) * params.terrainHeight)
  return d0 < d1
}

/**
 * Generate one chunk's mesh at the given LOD.
 *
 * The quad loop runs from -1 to `quadPerSide` inclusive — one ring wider than
 * the chunk. That extra ring is the **skirt**: its outer quads are degenerate
 * in XZ with their outer corners pinned to y = 0, so they form a zero-width
 * wall dropping from the chunk edge to sea level. That hides the crack of sky
 * a neighbouring chunk at a coarser LOD would otherwise show along the seam.
 *
 * **LOD is a stride over the shared vertex grid**, not a resampling: level `i`
 * takes every 2^i-th vertex and halves the quad count per side, exactly as
 * `HeightmapInfo` builds `Sizes[i]` in the original. Every level therefore
 * lands on real grid vertices — including the same jitter — so the silhouettes
 * agree and popping between levels stays small.
 */
export const generateChunk = (
  grid: { verts: Float32Array; vertPerSide: number },
  colorMap: MapSampler,
  heightMap: MapSampler,
  params: FacetedTerrainParams,
  chunkX: number,
  chunkY: number,
  lod = 0,
): TerrainChunkMesh => {
  const quadPerChunkLod0 = params.chunkSize / params.baseResolution
  const stride = 1 << lod
  const quadPerChunk = quadPerChunkLod0 >> lod
  if (quadPerChunk < 1) {
    throw new Error(
      `LOD ${lod} is finer than the chunk allows: ${quadPerChunkLod0} quads per chunk ` +
        `cannot be halved ${lod} times. Check LODLevels against ChunkSize / BaseResolution.`,
    )
  }
  // The chunk's origin in grid vertices is fixed by the chunk, not the LOD.
  const offsetX = chunkX * quadPerChunkLod0
  const offsetY = chunkY * quadPerChunkLod0
  const { verts, vertPerSide } = grid

  // Skirt ring included: (quadPerChunk + 2)^2 quads, 2 tris each, 3 verts each.
  const quadsPerSide = quadPerChunk + 2
  const triCount = quadsPerSide * quadsPerSide * 2
  const positions = new Float32Array(triCount * 9)
  const normals = new Float32Array(triCount * 9)
  const colors = new Float32Array(triCount * 9)
  const uvs = new Float32Array(triCount * 6)

  let p = 0
  let c = 0
  let t = 0
  let tri = 0

  const cx = [0, 0, 0, 0]
  const cy = [0, 0, 0, 0]
  const cz = [0, 0, 0, 0]

  // ── The normal each skirt quad borrows ──────────────────────────────────
  //
  // A skirt quad is a vertical wall, so its own face normal is HORIZONTAL, and
  // that is not the shading anyone wants to see: the skirt only ever becomes
  // visible through a LOD seam, i.e. right beside the terrain it is patching,
  // and a wall lit as a wall reads as a bright dashed line down the join rather
  // than as more mountain. `int_01_hoverJet` makes it worse than most — its sun
  // is 4 degrees above the horizon, so a horizontal normal is close to fully
  // lit exactly where the slope beside it is in shadow.
  //
  // 2016 solves it by stamping the skirt with the normal of the INTERIOR
  // triangle that shares that boundary edge (`FacetedTerrain.cs:879-908`
  // captures, `:1031-1038` stamps). The skirt then shades as a continuation of
  // its neighbour and disappears. We shipped the skirt geometry without the
  // stamp, and the dashed line was the symptom.
  //
  // One entry per boundary quad, xyz. XM/XP are the low/high x edges, YM/YP the
  // low/high z ones.
  const edgeNormalXM = new Float32Array(quadPerChunk * 3)
  const edgeNormalXP = new Float32Array(quadPerChunk * 3)
  const edgeNormalYM = new Float32Array(quadPerChunk * 3)
  const edgeNormalYP = new Float32Array(quadPerChunk * 3)

  const readCorner = (slot: number, gx: number, gy: number, pinY: boolean): void => {
    const i = (gx * vertPerSide + gy) * 3
    cx[slot] = verts[i] as number
    cy[slot] = pinY ? 0 : (verts[i + 1] as number)
    cz[slot] = verts[i + 2] as number
  }

  const emitTriangle = (a: number, b: number, d: number): void => {
    const ax = cx[a] as number
    const ay = cy[a] as number
    const az = cz[a] as number
    const bx = cx[b] as number
    const by = cy[b] as number
    const bz = cz[b] as number
    const dx = cx[d] as number
    const dy = cy[d] as number
    const dz = cz[d] as number

    // The positions and the flat normal (e1 x e2, all three verts share it),
    // written together by the one emitter every flat-shaded generator uses.
    writeFlatTri(positions, normals, p, ax, ay, az, bx, by, bz, dx, dy, dz)

    // Barycentre UV, and the single colour every vertex of this face gets.
    const u = (ax + bx + dx) / (params.terrainSize * 3)
    const v = (az + bz + dz) / (params.terrainSize * 3)
    colorMap.sample(u, v, _rgb)
    for (let k = 0; k < 3; k++) {
      colors[c + k * 3] = _rgb.r
      colors[c + k * 3 + 1] = _rgb.g
      colors[c + k * 3 + 2] = _rgb.b
      uvs[t + k * 2] = u
      uvs[t + k * 2 + 1] = v
    }

    p += 9
    c += 9
    t += 6
    tri++
  }

  /**
   * Keep the normal of the triangle just emitted, if it is one of the four that
   * share a chunk boundary edge.
   *
   * The four conditions are `FacetedTerrain.cs:879-908` unchanged, down to the
   * `FlippedTri` / `UpperTri` algebra. They are not obvious, so: the corners are
   * 0 = (x0,z0), 1 = (x0,z1), 2 = (x1,z0), 3 = (x1,z1), and each condition picks
   * whichever of the quad's two triangles happens to contain the boundary edge
   * under the diagonal that quad chose. For the low-x edge (0-1) that is the
   * lower triangle when the diagonal is not flipped and the upper one when it
   * is, which is exactly `flipped === upper`.
   *
   * Keyed off the flags rather than emission order on purpose: 2016 emits the
   * flipped quad's lower triangle first and we emit its upper one first, which
   * is invisible in the mesh but would silently invert a positional rule.
   */
  const captureEdgeNormal = (x: number, y: number, flipped: boolean, upper: boolean): void => {
    // `emitTriangle` has already advanced `p`, so the face it just wrote starts
    // nine floats back and its first vertex carries the face normal.
    const n = p - 9
    const keep = (dst: Float32Array, i: number): void => {
      dst[i * 3] = normals[n] as number
      dst[i * 3 + 1] = normals[n + 1] as number
      dst[i * 3 + 2] = normals[n + 2] as number
    }
    const inX = x >= 0 && x < quadPerChunk
    const inY = y >= 0 && y < quadPerChunk
    if (x === 0 && inY && flipped === upper) keep(edgeNormalXM, y)
    if (x === quadPerChunk - 1 && inY && flipped !== upper) keep(edgeNormalXP, y)
    if (y === 0 && inX && !upper) keep(edgeNormalYM, x)
    if (y === quadPerChunk - 1 && inX && upper) keep(edgeNormalYP, x)
  }

  for (let x = -1; x <= quadPerChunk; x++) {
    for (let y = -1; y <= quadPerChunk; y++) {
      // Skirt indexing, exactly as FacetedTerrain.cs:929-932. The outer ring's
      // quads are DEGENERATE in XZ: at x = -1 both lowerX and upperX resolve to
      // the chunk's first column, and at x = quadPerChunk both resolve to its
      // last. With the outer corners' y pinned to 0, that makes a zero-width
      // vertical wall dropping from the edge height to sea level — not an
      // outward flange.
      //
      // Verified against the 2016 bake: chunk (0,0) of
      // terrain_simonetIslands_FacetedChunks has an AABB of x,z in
      // [-0.94, 257.12]. A flange would reach 264.
      const lowerX = x === -1 ? offsetX : x * stride + offsetX
      const upperX =
        x === quadPerChunk ? quadPerChunk * stride + offsetX : (x + 1) * stride + offsetX
      const lowerY = y === -1 ? offsetY : y * stride + offsetY
      const upperY =
        y === quadPerChunk ? quadPerChunk * stride + offsetY : (y + 1) * stride + offsetY

      // Skirt pinning, mirroring the original's per-corner y = 0 assignments.
      readCorner(0, lowerX, lowerY, x === -1 || y === -1)
      readCorner(1, lowerX, upperY, x === -1 || y === quadPerChunk)
      readCorner(2, upperX, lowerY, x === quadPerChunk || y === -1)
      readCorner(3, upperX, upperY, x === quadPerChunk || y === quadPerChunk)

      let topLeftToBottomRight = true
      if (x >= 0 && x < quadPerChunk && y >= 0 && y < quadPerChunk) {
        topLeftToBottomRight = diagonalTopLeftToBottomRight(cx, cy, cz, heightMap, params)
      }

      if (topLeftToBottomRight) {
        emitTriangle(0, 1, 2)
        captureEdgeNormal(x, y, false, false)
        emitTriangle(2, 1, 3)
        captureEdgeNormal(x, y, false, true)
      } else {
        emitTriangle(0, 1, 3)
        captureEdgeNormal(x, y, true, true)
        emitTriangle(0, 3, 2)
        captureEdgeNormal(x, y, true, false)
      }
    }
  }

  // ── Stamp the skirt ─────────────────────────────────────────────────────
  //
  // `FacetedTerrain.cs:1031-1038`. Note the bound: `i < quadPerSide`, so the
  // FOUR CORNER skirt quads are never stamped and keep their own wall normals.
  // That is the original's behaviour and it is kept — a corner quad has two
  // boundary edges and no single right answer, and it is one quad.
  const stampSkirt = (qx: number, qy: number, src: Float32Array, i: number): void => {
    // Quads were written x-major from (-1,-1), two triangles of three vertices
    // each: 18 floats per quad. Unity's index is in vertices; this one is in
    // floats, and is otherwise the same expression.
    const base = ((qx + 1) * quadsPerSide + (qy + 1)) * 18
    const nx = src[i * 3] as number
    const ny = src[i * 3 + 1] as number
    const nz = src[i * 3 + 2] as number
    for (let k = 0; k < 6; k++) {
      normals[base + k * 3] = nx
      normals[base + k * 3 + 1] = ny
      normals[base + k * 3 + 2] = nz
    }
  }
  for (let i = 0; i < quadPerChunk; i++) {
    stampSkirt(-1, i, edgeNormalXM, i)
    stampSkirt(quadPerChunk, i, edgeNormalXP, i)
    stampSkirt(i, -1, edgeNormalYM, i)
    stampSkirt(i, quadPerChunk, edgeNormalYP, i)
  }

  return {
    chunkX,
    chunkY,
    positions,
    normals,
    colors,
    uvs,
    triangleCount: tri,
  }
}

/** Chunks per side, matching the original's `ChunkPerSide`. */
export const chunkPerSide = (params: FacetedTerrainParams): number =>
  params.terrainSize / params.chunkSize
