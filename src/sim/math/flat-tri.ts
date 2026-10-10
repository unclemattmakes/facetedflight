// src/sim/math/flat-tri.ts: the flat-shaded triangle emitter, written once.
//
// Seven generators in the sim (clouds, prop shapes, the bird, the terrain chunk,
// and the hangar's room, shaft and dressing) each wrote the same block: copy
// nine position floats, take `e1 = b - a`, `e2 = c - a`, cross them, divide by
// `Math.hypot(...) || 1`, and write that normal three times. Code-reuse audit
// SG-5 / XC-11.
//
// What this module is NOT: it draws no random numbers and it touches no
// per-face extra. The shade of a prop, the colour of a hangar face and the UV of
// a terrain face stay with the caller, AFTER the call, so a generator's RNG
// stream is untouched (the byte-hash proof in docs/plan/code-reuse/progress/
// reuse-mesh-gen.md is the check). The arithmetic is the copies' own, in their
// own order, on doubles, so the written bytes are the ones they wrote.
//
// `terrain/surface.ts`'s facet-slope query computes the same cross product but
// has NO `|| 1` guard (a degenerate facet is "flat" there, not a unit normal),
// so it is deliberately not a caller.

import type { Vec3 } from './vec3'

/**
 * The unit normal of triangle (a, b, c): `(b - a) x (c - a)` divided by its
 * length, where a zero length counts as 1 (a degenerate face keeps the zero
 * vector rather than turning into NaN). Scalars in and a caller-owned `out`, so
 * there is no allocation and the operations are the IEEE ones the inline copies
 * performed.
 */
export const faceNormal = (
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  out: Vec3,
): Vec3 => {
  const e1x = bx - ax
  const e1y = by - ay
  const e1z = bz - az
  const e2x = cx - ax
  const e2y = cy - ay
  const e2z = cz - az
  const nx = e1y * e2z - e1z * e2y
  const ny = e1z * e2x - e1x * e2z
  const nz = e1x * e2y - e1y * e2x
  const len = Math.hypot(nx, ny, nz) || 1
  out.x = nx / len
  out.y = ny / len
  out.z = nz / len
  return out
}

const _n: Vec3 = { x: 0, y: 0, z: 0 }

/**
 * Write one flat-shaded triangle: nine position floats at `positions[o..o+8]`
 * and the face normal three times at `normals[o..o+8]`. `o` is a float offset
 * (`face * 9`), and both arrays use the same one, as every caller's did.
 */
export const writeFlatTri = (
  positions: Float32Array,
  normals: Float32Array,
  o: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): void => {
  positions[o] = ax
  positions[o + 1] = ay
  positions[o + 2] = az
  positions[o + 3] = bx
  positions[o + 4] = by
  positions[o + 5] = bz
  positions[o + 6] = cx
  positions[o + 7] = cy
  positions[o + 8] = cz
  faceNormal(ax, ay, az, bx, by, bz, cx, cy, cz, _n)
  for (let k = 0; k < 3; k++) {
    normals[o + k * 3] = _n.x
    normals[o + k * 3 + 1] = _n.y
    normals[o + k * 3 + 2] = _n.z
  }
}
