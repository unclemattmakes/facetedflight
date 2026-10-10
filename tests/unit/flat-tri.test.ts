// tests/unit/flat-tri.test.ts: the one flat-shaded triangle emitter
// (code-reuse audit SG-5 / XC-11).
//
// The byte-for-byte proof that seven generators still write the same arrays is
// a hash of their output taken before and after the move (see
// docs/plan/code-reuse/progress/reuse-mesh-gen.md). What lives here is what
// the helper itself promises.

import { describe, expect, it } from 'vitest'
import { faceNormal, writeFlatTri } from '@/sim/math/flat-tri'
import type { Vec3 } from '@/sim/math/vec3'
import { makeRandom } from '@/sim/terrain/faceted'

const out = (): Vec3 => ({ x: 9, y: 9, z: 9 })

describe('faceNormal', () => {
  it('is +z for a counter-clockwise triangle in the xy plane', () => {
    expect(faceNormal(0, 0, 0, 1, 0, 0, 0, 1, 0, out())).toEqual({ x: 0, y: 0, z: 1 })
  })

  it('flips with the winding', () => {
    expect(faceNormal(0, 0, 0, 0, 1, 0, 1, 0, 0, out())).toEqual({ x: 0, y: 0, z: -1 })
  })

  it('keeps a degenerate face at the zero vector rather than NaN', () => {
    const n = faceNormal(1, 2, 3, 1, 2, 3, 1, 2, 3, out())
    expect(n).toEqual({ x: 0, y: 0, z: 0 })
    const collinear = faceNormal(0, 0, 0, 1, 1, 1, 2, 2, 2, out())
    expect(Object.values(collinear).every((v) => Number.isFinite(v))).toBe(true)
  })

  it('returns the caller-owned vector it was given', () => {
    const o = out()
    expect(faceNormal(0, 0, 0, 1, 0, 0, 0, 1, 0, o)).toBe(o)
  })

  it('is a unit vector perpendicular to both edges, for random triangles', () => {
    // The relationship, not the formula: a unit length and two zero dots are
    // true of any correct normal, whichever way it was computed.
    const rnd = makeRandom(7)
    for (let i = 0; i < 200; i++) {
      const p = Array.from({ length: 9 }, () => (rnd() * 2 - 1) * 50) as number[]
      const [ax, ay, az, bx, by, bz, cx, cy, cz] = p as [
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
      ]
      const n = faceNormal(ax, ay, az, bx, by, bz, cx, cy, cz, out())
      expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 12)
      expect(n.x * (bx - ax) + n.y * (by - ay) + n.z * (bz - az)).toBeCloseTo(0, 8)
      expect(n.x * (cx - ax) + n.y * (cy - ay) + n.z * (cz - az)).toBeCloseTo(0, 8)
    }
  })
})

describe('writeFlatTri', () => {
  it('writes nine positions and the one normal three times, at the offset', () => {
    const positions = new Float32Array(18)
    const normals = new Float32Array(18)
    writeFlatTri(positions, normals, 9, 0, 0, 0, 1, 0, 0, 0, 1, 0)
    expect(Array.from(positions.subarray(0, 9))).toEqual(new Array(9).fill(0))
    expect(Array.from(positions.subarray(9))).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0])
    expect(Array.from(normals.subarray(0, 9))).toEqual(new Array(9).fill(0))
    expect(Array.from(normals.subarray(9))).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1])
  })

  it('draws no random numbers and does not touch other faces', () => {
    const positions = new Float32Array(27).fill(5)
    const normals = new Float32Array(27).fill(5)
    writeFlatTri(positions, normals, 9, 0, 0, 0, 0, 0, 1, 1, 0, 0)
    expect(Array.from(positions.subarray(0, 9))).toEqual(new Array(9).fill(5))
    expect(Array.from(positions.subarray(18))).toEqual(new Array(9).fill(5))
    expect(Array.from(normals.subarray(0, 9))).toEqual(new Array(9).fill(5))
    expect(Array.from(normals.subarray(18))).toEqual(new Array(9).fill(5))
  })
})
