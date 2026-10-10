// src/sim/blob.ts: the stages a lobed, crunched, flat-split blob is built from.
//
// `generateCloud` (sim/clouds.ts) and `generatePropMesh` (sim/props/
// generate-shapes.ts) are the same object with different numbers: an icosphere
// pushed out along each vertex's own direction by how much it faces each of a
// handful of lobes, roughened by a per-vertex jitter, then split so every
// triangle carries its own normal. The prop file said so and imported only
// `icosphere`; the three stages around it were typed twice. Code-reuse audit
// SG-3.
//
// What stays with each generator, because it really differs: the normalisation
// (a cloud fits its MEAN radius, a prop its widest horizontal extent), the
// prop's sink, and the prop's per-face shade.
//
// RNG DRAW ORDER IS THE OUTPUT. `blobLobes` draws, per lobe, z, then the angle,
// then the strength, and `crunchVertices` draws `insideUnitSphere` once per
// shared vertex in index order. Both generators ran exactly that sequence from
// one `makeRandom(seed)` before this file existed; a stage that drew in a
// different order or count would re-roll every cloud and every prop. The
// byte-hash proof is in docs/plan/code-reuse/progress/reuse-mesh-gen.md.
//
// The numeric literals here (0.55 and 0.45 for the strength range, 2 for the
// sphere draws) are the generators' own, moved and not invented: FF2's art, not
// an extracted number (the justification `sim/clouds.ts` and `generate-shapes`
// each carry for their shape tables).
//
// SIM LAYER: pure. No three, no DOM, no `Math.random`.

import { writeFlatTri } from '@/sim/math/flat-tri'
import { insideUnitSphere } from '@/sim/terrain/faceted'

/**
 * `count` lobe directions on the sphere, each with a strength, as 4 floats a lobe
 * (x, y, z, strength).
 *
 * Directions are drawn uniform on the sphere (z uniform in [-1, 1], angle
 * uniform), then flattened toward the horizontal by `spread` so the bulges go
 * OUT rather than up, and RENORMALISED: a lobe pushed flat must not also push
 * weakly. Strength is 0.55..1 of `strength`, so the bulges are not all one size.
 */
export const blobLobes = (
  rnd: () => number,
  count: number,
  spread: number,
  strength: number,
): Float32Array => {
  const lobes = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) {
    const z = rnd() * 2 - 1
    const a = rnd() * Math.PI * 2
    const r = Math.sqrt(Math.max(0, 1 - z * z))
    let lx = Math.cos(a) * r
    let ly = z * (1 - spread)
    let lz = Math.sin(a) * r
    const l = Math.hypot(lx, ly, lz) || 1
    lx /= l
    ly /= l
    lz /= l
    lobes[i * 4] = lx
    lobes[i * 4 + 1] = ly
    lobes[i * 4 + 2] = lz
    lobes[i * 4 + 3] = strength * (0.55 + rnd() * 0.45)
  }
  return lobes
}

/**
 * Push every vertex out along its own direction:
 * `r(dir) = 1 + sum strength_i * max(0, dir . lobe_i) ^ sharpness`, with y
 * scaled by `flatten` afterwards. `vertices` is a unit shared-vertex mesh (xyz
 * triples); the result is a new array of the same length.
 */
export const displaceByLobes = (
  vertices: Float32Array,
  lobes: Float32Array,
  sharpness: number,
  flatten: number,
): Float32Array => {
  const lobeCount = lobes.length / 4
  const count = vertices.length / 3
  const moved = new Float32Array(vertices.length)
  for (let v = 0; v < count; v++) {
    const dx = vertices[v * 3] as number
    const dy = vertices[v * 3 + 1] as number
    const dz = vertices[v * 3 + 2] as number
    let r = 1
    for (let i = 0; i < lobeCount; i++) {
      const d =
        dx * (lobes[i * 4] as number) +
        dy * (lobes[i * 4 + 1] as number) +
        dz * (lobes[i * 4 + 2] as number)
      if (d > 0) r += (lobes[i * 4 + 3] as number) * d ** sharpness
    }
    moved[v * 3] = dx * r
    moved[v * 3 + 1] = dy * r * flatten
    moved[v * 3 + 2] = dz * r
  }
  return moved
}

/**
 * THE CRUNCH. Displace every SHARED vertex inside a small ball of radius
 * `jitter` (the terrain's `insideUnitSphere * RandomOffset`, on a sphere instead
 * of a grid), in place. Shared is the whole point: the faces around a vertex all
 * follow it, so the mesh stays closed and only the facet ANGLES change.
 * Jittering after the split moves each face's copy independently and the blob
 * comes apart into confetti. A `jitter` of 0 draws nothing.
 */
export const crunchVertices = (moved: Float32Array, rnd: () => number, jitter: number): void => {
  if (!(jitter > 0)) return
  const count = moved.length / 3
  const offset = { x: 0, y: 0, z: 0 }
  for (let v = 0; v < count; v++) {
    insideUnitSphere(rnd, offset)
    moved[v * 3] = (moved[v * 3] as number) + offset.x * jitter
    moved[v * 3 + 1] = (moved[v * 3 + 1] as number) + offset.y * jitter
    moved[v * 3 + 2] = (moved[v * 3 + 2] as number) + offset.z * jitter
  }
}

/** A blob as a flat-shaded triangle soup: 9 floats a triangle, one normal a face. */
export interface FlatSplit {
  readonly positions: Float32Array
  readonly normals: Float32Array
  readonly triangleCount: number
}

/**
 * Split an indexed mesh into a triangle soup with one face normal per triangle.
 * `onFace(f)` runs after face `f` is written, in face order, for a caller's own
 * per-face extra (a prop's shade draws from its RNG there), so the stream is
 * the one the inline loop had.
 */
export const splitFlat = (
  moved: Float32Array,
  faces: Uint32Array,
  onFace?: (face: number) => void,
): FlatSplit => {
  const triangleCount = faces.length / 3
  const positions = new Float32Array(triangleCount * 9)
  const normals = new Float32Array(triangleCount * 9)
  for (let f = 0; f < triangleCount; f++) {
    const ia = (faces[f * 3] as number) * 3
    const ib = (faces[f * 3 + 1] as number) * 3
    const ic = (faces[f * 3 + 2] as number) * 3
    writeFlatTri(
      positions,
      normals,
      f * 9,
      moved[ia] as number,
      moved[ia + 1] as number,
      moved[ia + 2] as number,
      moved[ib] as number,
      moved[ib + 1] as number,
      moved[ib + 2] as number,
      moved[ic] as number,
      moved[ic + 1] as number,
      moved[ic + 2] as number,
    )
    onFace?.(f)
  }
  return { positions, normals, triangleCount }
}
