// src/sim/terrain/chunk-to-three.ts — a generated chunk, finished for three.
//
// DEV-242, building DEV-168's design (`docs/plan/VR-PERF.md`). Everything the
// main thread used to do between "the worker's arrays arrived" and "three has a
// `BufferGeometry`" lives here, THREE-FREE, so the worker can do it instead and
// transfer the finished buffers.
//
// ── Why this is worth a module ────────────────────────────────────────────
//
// `render/terrain-mesh.ts`'s `chunkGeometry` allocated the whole geometry
// TWICE — once in `subdivideTriangleSoup` and again in the flip loop — and then
// walked the positions twice more for the bounding sphere. For a land chunk
// that is 6,936 vertices and nobody notices. For an **ocean** chunk at LOD 0 it
// is 443,904 vertices: 19.5 MB allocated twice, on the main thread, in the one
// task that turns a worker reply into a mesh. Twice a flight on
// `int_01_hoverJet` that is followed by a ~110 ms frame (DEV-242 §1).
//
// Nothing here is new arithmetic. `subdivideTriangleSoup` and `interiorJitter`
// moved verbatim from `render/terrain-mesh.ts`, which still re-exports both so
// every existing import and every existing test keeps working; the flip loop is
// lifted out of `chunkGeometry` unchanged; and `boundingSphereOf` reproduces
// three's own `BufferGeometry.computeBoundingSphere`, which is checked against
// three's build rather than asserted from this file's belief about it
// (`tests/unit/chunk-drain.test.ts`, DEV-141's discipline).
//
// ── DO NOT MOVE THIS FILE INTO `src/render/`. Read this first ────────────
//
// It looks like renderer code. It is named after three, every function in it
// exists to feed a `BufferGeometry`, and `boundingSphereOf` is a transcription
// of a three method. Tidying it next to `render/terrain-mesh.ts` is the obvious
// housekeeping and it would **silently break the terrain worker**.
//
// **This file imports no three, touches no `document` / `window` / `navigator`,
// and calls no `Math.random` / `Date.now` / `performance.now`** — hard rule 4,
// enforced mechanically by `tests/unit/sim-purity-guard.test.ts`, which guards
// by DIRECTORY and guards nothing outside `src/sim/**`.
//
// That is not incidental tidiness; it is the entire reason the code can live in
// a worker. `terrain.worker.ts` imports `finishChunk` from here. A single
// `import * as THREE from 'three'` anywhere in this file's graph pulls the
// whole renderer into the worker bundle — and the symptom would not be an
// error, it would be a slower worker start and a bigger download that nobody
// attributes to a file move. In `src/render/` or `src/game/` there is no test
// that could say so. **The guard is the reason for the address**, and the
// address is load-bearing.
//
// The three-facing half — `chunkGeometry`, `chunkGeometryFromArrays`, the
// `BufferAttribute` and `Sphere` construction — stays in
// `render/terrain-mesh.ts`, which also re-exports the two functions that moved
// so nothing had to change its import.
//
// This does NOT put subdivision in front of the oracle. `pnpm oracle:sweep`
// diffs `generateChunk`, which is upstream of everything here and calls none of
// it; the argument in `subdivideTriangleSoup`'s own doc comment — that the
// density has to be added downstream of the generator — is about the CALL
// GRAPH and is untouched by the move.

import type { TerrainChunkMesh } from '@/sim/terrain/faceted'

/**
 * A chunk's four attribute arrays, in THREE space, plus the culling sphere.
 *
 * The buffers are owned by whoever built them and are meant to be TRANSFERRED,
 * not copied — `render/terrain-mesh.ts`'s `chunkGeometryFromArrays` wraps them
 * in `BufferAttribute`s without touching a byte.
 */
export interface ChunkThreeArrays {
  positions: Float32Array
  normals: Float32Array
  colors: Float32Array
  uvs: Float32Array
  triangleCount: number
  /** What three's `computeBoundingSphere` would have produced. */
  sphere: ChunkBoundingSphere
}

export interface ChunkBoundingSphere {
  x: number
  y: number
  z: number
  radius: number
}

/**
 * Per-vertex noise for a sub-vertex, hashed from its POSITION.
 *
 * Moved from `render/terrain-mesh.ts` unchanged. Matt, on the ocean's wireframe
 * next to a 2016 screenshot: *"the ocean isn't nearly dense enough … i think it
 * should be roughly 4x denser."* He was right and subdivision alone could never
 * have helped: barycentric sub-vertices land exactly on the parent's plane, so
 * `?ocean=4` bought sixteen times the triangles and not one degree of relief.
 *
 * Hashed from the position rather than drawn from a sequence, for two reasons
 * that are both load-bearing:
 *
 *  * the soup is fully split, so the same lattice point is emitted once per
 *    triangle that touches it — a sequence would give each copy a different
 *    offset and tear the surface open;
 *  * a chunk is regenerated whenever it swaps LOD, and a sequence would re-roll
 *    then, so the sea would visibly reshuffle as you flew toward it.
 *
 * Three decorrelated `fract(sin(...))` draws — the same shape the 2016 water
 * shader uses for its own noise — mapped to [-1, 1] and clamped into the unit
 * ball so the amplitude means what it means in `buildVertexGrid`. Deterministic
 * by construction, which is what lets it live under `src/sim/`.
 */
export const interiorJitter = (x: number, z: number, w: number, out: number[]): void => {
  const draw = (a: number, b: number, c: number): number => {
    const r = Math.sin(x * a + z * b + w * c) * 43758.5453
    return 2 * (r - Math.floor(r)) - 1
  }
  let ox = draw(12.9898, 78.233, 37.719)
  let oy = draw(93.9898, 67.345, 24.113)
  let oz = draw(45.164, 19.877, 83.155)
  const len = Math.hypot(ox, oy, oz)
  if (len > 1) {
    ox /= len
    oy /= len
    oz /= len
  }
  out[0] = ox
  out[1] = oy
  out[2] = oz
}

/**
 * Split every triangle into `factor`^2 sub-triangles, jittering the interior.
 *
 * Moved from `render/terrain-mesh.ts` unchanged, and still re-exported from
 * there. Its own reasoning, kept because it is the whole justification for the
 * function existing at all:
 *
 * ── Why this is DOWNSTREAM of the generator ──────────────────────────────
 *
 * The sim's `generateChunk` is diffed vertex-for-vertex against the 2016 bake
 * by `pnpm oracle:sweep`, and LOD there is a STRIDE over a shared vertex grid —
 * there is no finer level than the grid, and the grid's size is
 * `terrainSize / baseResolution` over the whole terrain. Making the ocean's grid
 * 4x finer would be 4097^2 vertices across 262 km of water, ~200 MB, to render
 * the 6 km of it we ever build. So the density is added downstream of the
 * generator, where it cannot touch the oracle, the collision field, or the land.
 * **That is a statement about the call graph, not about the directory** — the
 * oracle calls `generateChunk` and nothing here.
 *
 * ── Why coplanar sub-triangles are not pointless ─────────────────────────
 *
 * They would be, for the land. For the sea they are the whole thing: the wave
 * is a VERTEX displacement, so sub-vertices ride it independently and the
 * sub-triangles stop being coplanar the moment they are drawn. And the water's
 * normal is `cross(dFdx(vWaterWorld), dFdy(vWaterWorld))` — constant across a
 * triangle, so **a facet IS a triangle**. Four times the triangles is four times
 * the facets, and it shows in the wireframe rather than faking it in the shade.
 *
 * Barycentric, so colour and UV interpolate. On a flat-shaded soup the three
 * corners of a face already share a colour and a normal, which makes that
 * interpolation a no-op and keeps each facet's colour exactly as generated.
 */
export const subdivideTriangleSoup = (
  chunk: TerrainChunkMesh,
  factor: number,
  /**
   * `RandomOffset`, in MESH units — the generator's own jitter amplitude, 2 on
   * the Simonet ocean. Zero leaves every sub-vertex on the parent's plane.
   */
  jitter = 0,
): TerrainChunkMesh => {
  const n = Math.max(1, Math.floor(factor))
  if (n === 1) return chunk
  const faces = chunk.positions.length / 9
  const subPerFace = n * n
  const outFaces = faces * subPerFace
  const positions = new Float32Array(outFaces * 9)
  const normals = new Float32Array(outFaces * 9)
  const colors = new Float32Array(outFaces * 9)
  const uvs = new Float32Array(outFaces * 6)

  let p = 0
  let t = 0
  // Barycentric weights for the lattice point (i, j) of the face's corners.
  const wa = (i: number, j: number) => 1 - i / n - j / n
  // x/z jitter is scaled to the SUB-quad; y is not. The generator applies one
  // absolute amplitude to all three, which on the ocean's 256 m quads is 16 m of
  // sway in plan and 2 m in height. Keeping the full 16 m on a 64 m sub-quad
  // would tangle the tessellation; the 2 m of height IS the noise and stays.
  const jxz = jitter / n
  const off = [0, 0, 0]
  const emit = (f: number, i: number, j: number): void => {
    const u = wa(i, j)
    const v = i / n
    const w = j / n
    const b = f * 9
    for (let k = 0; k < 3; k++) {
      positions[p + k] =
        u * (chunk.positions[b + k] as number) +
        v * (chunk.positions[b + 3 + k] as number) +
        w * (chunk.positions[b + 6 + k] as number)
      normals[p + k] =
        u * (chunk.normals[b + k] as number) +
        v * (chunk.normals[b + 3 + k] as number) +
        w * (chunk.normals[b + 6 + k] as number)
      colors[p + k] =
        u * (chunk.colors[b + k] as number) +
        v * (chunk.colors[b + 3 + k] as number) +
        w * (chunk.colors[b + 6 + k] as number)
    }
    // INTERIOR lattice points only. A point on a parent EDGE is shared with the
    // triangle next door — and, at a chunk seam, with the chunk next door, which
    // is generated separately and would not agree. Moving one opens a crack you
    // see as a line of sky. The interior points belong to exactly one triangle.
    if (jitter > 0 && i > 0 && j > 0 && i + j < n) {
      interiorJitter(
        positions[p] as number,
        positions[p + 2] as number,
        (positions[p + 1] as number) * 0.017,
        off,
      )
      positions[p] = (positions[p] as number) + (off[0] as number) * jxz
      positions[p + 1] = (positions[p + 1] as number) + (off[1] as number) * jitter
      positions[p + 2] = (positions[p + 2] as number) + (off[2] as number) * jxz
    }
    const c = f * 6
    for (let k = 0; k < 2; k++) {
      uvs[t + k] =
        u * (chunk.uvs[c + k] as number) +
        v * (chunk.uvs[c + 2 + k] as number) +
        w * (chunk.uvs[c + 4 + k] as number)
    }
    p += 3
    t += 2
  }

  for (let f = 0; f < faces; f++) {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n - i; j++) {
        // The upward sub-triangle, in the parent's winding.
        emit(f, i, j)
        emit(f, i + 1, j)
        emit(f, i, j + 1)
        // And the downward one that fills the gap beside it, which exists for
        // every lattice cell except the ones on the hypotenuse.
        if (i + j < n - 1) {
          emit(f, i + 1, j)
          emit(f, i + 1, j + 1)
          emit(f, i, j + 1)
        }
      }
    }
  }

  if (p / 9 !== outFaces) {
    throw new Error(`subdivideTriangleSoup(${n}) emitted ${p / 9} triangles, expected ${outFaces}`)
  }

  return { ...chunk, positions, normals, colors, uvs, triangleCount: outFaces }
}

/**
 * Unity space to three space, into fresh buffers.
 *
 * Lifted out of `chunkGeometry` unchanged, comment and all, because it is the
 * half that has nothing to do with three:
 *
 * The generator emits UNITY coordinates, because that is what the 2016 bake is
 * in and the oracle sweep compares against it directly. Unity is left-handed
 * with +Z forward; three is right-handed with -Z forward. The conversion is
 * `z -> -z`, and it has a determinant of -1, so it MUST be paired with a
 * winding reversal or every triangle faces backwards.
 *
 * Doing it here, rather than in the generator, keeps the generator comparable
 * with the bake vertex for vertex. Doing it once, rather than here and again for
 * the world offset, is what stops the terrain ending up mirrored relative to the
 * rings — which are already three-space in the level JSON, and would have lined
 * up perfectly on a mirrored island right up until someone flew at one.
 *
 * The winding swap exchanges vertices 1 and 2 of every triangle. The vertices
 * are fully split (three per face, shared with nothing), so this is a local
 * shuffle and cannot disturb a neighbour.
 *
 * NO sRGB decode on the colours. Unity did not do one and the terrain's colour
 * is what that mistake looks like (DEV-014).
 */
export const flipChunkToThree = (
  chunk: TerrainChunkMesh,
): Omit<ChunkThreeArrays, 'sphere' | 'triangleCount'> => {
  const n = chunk.positions.length / 3
  const positions = new Float32Array(chunk.positions.length)
  const normals = new Float32Array(chunk.normals.length)
  const colors = new Float32Array(chunk.colors.length)
  const uvs = new Float32Array(chunk.uvs.length)

  for (let t = 0; t < n; t += 3) {
    const order = [t, t + 2, t + 1]
    for (let k = 0; k < 3; k++) {
      const src = order[k] as number
      const dst = t + k
      positions[dst * 3] = chunk.positions[src * 3] as number
      positions[dst * 3 + 1] = chunk.positions[src * 3 + 1] as number
      positions[dst * 3 + 2] = -(chunk.positions[src * 3 + 2] as number)
      normals[dst * 3] = chunk.normals[src * 3] as number
      normals[dst * 3 + 1] = chunk.normals[src * 3 + 1] as number
      normals[dst * 3 + 2] = -(chunk.normals[src * 3 + 2] as number)
      colors[dst * 3] = chunk.colors[src * 3] as number
      colors[dst * 3 + 1] = chunk.colors[src * 3 + 1] as number
      colors[dst * 3 + 2] = chunk.colors[src * 3 + 2] as number
      uvs[dst * 2] = chunk.uvs[src * 2] as number
      uvs[dst * 2 + 1] = chunk.uvs[src * 2 + 1] as number
    }
  }

  return { positions, normals, colors, uvs }
}

/**
 * three's `BufferGeometry.computeBoundingSphere`, reproduced.
 *
 * Transcribed from `three/src/core/BufferGeometry.js` (0.185.1), in the same
 * order and with the same operations, because the result has to be **identical**
 * and not merely correct: three uses this sphere for frustum culling, and a
 * sphere that is a hair smaller pops a chunk out at the screen edge.
 *
 *   center = (box.min + box.max) * 0.5     `Box3.getCenter`
 *   radius = sqrt(max over i of |center - v_i|^2)
 *
 * The morph-attribute branches are omitted — a terrain chunk has none, and a
 * branch that cannot be reached is a branch that cannot be tested. If one ever
 * appears, `chunkGeometryFromArrays` must stop trusting this.
 *
 * NOT asserted against arithmetic written out a second time: the test builds a
 * real `BufferGeometry`, calls three's own method on it, and compares
 * (`tests/unit/chunk-drain.test.ts`). That is the same discipline
 * `xr-eye-layers.test.ts` uses on three's layer masks — read the claim out of
 * three's build, do not restate it. (CLAUDE.md trap 24.)
 */
export const boundingSphereOf = (positions: Float32Array): ChunkBoundingSphere => {
  const count = positions.length / 3
  // An empty geometry gives three a centre of (0,0,0) and a radius of 0:
  // `Box3.setFromBufferAttribute` leaves the box empty and `getCenter` returns
  // the origin for an empty box.
  if (count === 0) return { x: 0, y: 0, z: 0, radius: 0 }

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3] as number
    const y = positions[i * 3 + 1] as number
    const z = positions[i * 3 + 2] as number
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (z < minZ) minZ = z
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
    if (z > maxZ) maxZ = z
  }

  // `Box3.getCenter` is `addVectors(min, max).multiplyScalar(0.5)` — the sum
  // first, then the halving, in float64. Written the same way round because
  // `(a + b) * 0.5` and `a * 0.5 + b * 0.5` are not the same float.
  const cx = (minX + maxX) * 0.5
  const cy = (minY + maxY) * 0.5
  const cz = (minZ + maxZ) * 0.5

  let maxRadiusSq = 0
  for (let i = 0; i < count; i++) {
    const dx = cx - (positions[i * 3] as number)
    const dy = cy - (positions[i * 3 + 1] as number)
    const dz = cz - (positions[i * 3 + 2] as number)
    const d = dx * dx + dy * dy + dz * dz
    if (d > maxRadiusSq) maxRadiusSq = d
  }

  return { x: cx, y: cy, z: cz, radius: Math.sqrt(maxRadiusSq) }
}

/**
 * A generated chunk, finished: subdivided, flipped into three space, and with
 * its culling sphere computed. **The whole of what the main thread used to do
 * per worker reply.**
 *
 * `terrain.worker.ts` calls this and transfers the result, so on the streaming
 * path none of it is on the main thread at all. `render/terrain-mesh.ts`'s
 * `chunkGeometry` calls it too, for the synchronous initial build under the
 * loading curtain and for every test that was written against that signature —
 * one function, two callers, so the streamed chunk and the loaded chunk cannot
 * drift into two different islands.
 */
export const finishChunk = (
  raw: TerrainChunkMesh,
  /** Split each triangle into this^2. */
  subdivide = 1,
  /** `RandomOffset` in mesh units, so the new vertices are not coplanar. */
  jitter = 0,
): ChunkThreeArrays => {
  const chunk = subdivide > 1 ? subdivideTriangleSoup(raw, subdivide, jitter) : raw
  const flipped = flipChunkToThree(chunk)
  return {
    ...flipped,
    triangleCount: chunk.triangleCount,
    sphere: boundingSphereOf(flipped.positions),
  }
}
