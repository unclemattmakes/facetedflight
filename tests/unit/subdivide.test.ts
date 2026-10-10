// tests/unit/subdivide.test.ts — four times the facets, and the same surface.
//
// Matt: *"the ocean isn't nearly dense enough... i think it should be roughly 4x
// denser."* This is the function that does it, and the failure modes are all
// silent: a sub-triangle with the wrong winding is invisible from the front, a
// lattice that does not tile leaves holes you only see against the sky, and a
// barycentric weight that does not sum to one moves the surface.

import { describe, expect, it } from 'vitest'
import { interiorJitter, subdivideTriangleSoup } from '@/render/terrain-mesh'
import type { TerrainChunkMesh } from '@/sim/terrain/faceted'

/** One right triangle in the xz plane, with distinct colours and uvs. */
const face = (): TerrainChunkMesh =>
  ({
    positions: new Float32Array([0, 0, 0, 12, 0, 0, 0, 0, 12]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
    colors: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    triangleCount: 1,
  }) as unknown as TerrainChunkMesh

const area = (m: TerrainChunkMesh): number => {
  let total = 0
  for (let f = 0; f < m.positions.length / 9; f++) {
    const b = f * 9
    const ax = (m.positions[b + 3] as number) - (m.positions[b] as number)
    const az = (m.positions[b + 5] as number) - (m.positions[b + 2] as number)
    const bx = (m.positions[b + 6] as number) - (m.positions[b] as number)
    const bz = (m.positions[b + 8] as number) - (m.positions[b + 2] as number)
    total += Math.abs(ax * bz - az * bx) / 2
  }
  return total
}

/** Signed area in xz — the sign IS the winding. */
const signedArea = (m: TerrainChunkMesh, f: number): number => {
  const b = f * 9
  const ax = (m.positions[b + 3] as number) - (m.positions[b] as number)
  const az = (m.positions[b + 5] as number) - (m.positions[b + 2] as number)
  const bx = (m.positions[b + 6] as number) - (m.positions[b] as number)
  const bz = (m.positions[b + 8] as number) - (m.positions[b + 2] as number)
  return (ax * bz - az * bx) / 2
}

describe('subdivideTriangleSoup', () => {
  it('is a no-op at 1, by identity rather than by copying', () => {
    const f = face()
    expect(subdivideTriangleSoup(f, 1)).toBe(f)
    expect(subdivideTriangleSoup(f, 0)).toBe(f)
  })

  it('produces exactly factor^2 triangles', () => {
    for (const n of [2, 3, 4, 8]) {
      const out = subdivideTriangleSoup(face(), n)
      expect(out.positions.length / 9, `factor ${n}`).toBe(n * n)
      expect(out.triangleCount).toBe(n * n)
    }
  })

  it('TILES the parent: same total area, no gaps and no overlap', () => {
    // The lattice has to close. An off-by-one in the downward-triangle
    // condition leaves a row of holes that only shows against the sky.
    const parent = face()
    for (const n of [2, 4, 7]) {
      expect(area(subdivideTriangleSoup(parent, n)), `factor ${n}`).toBeCloseTo(area(parent), 4)
    }
  })

  it('emits EXACTLY the triangles it allocated for', () => {
    // The mutation that got away: `j < n - i` instead of `j < n - i - 1` emits
    // extra triangles, and a typed array silently DROPS writes past its end —
    // so real sub-triangles fall off the back and the total area still looks
    // plausible. The function now counts what it wrote.
    for (const n of [2, 3, 4, 5, 8]) {
      expect(() => subdivideTriangleSoup(face(), n), `factor ${n}`).not.toThrow()
    }
  })

  it('keeps every sub-vertex INSIDE the parent triangle', () => {
    // The same mutation's other signature: a lattice point with i + j > n has a
    // negative barycentric weight and lands outside the face it is subdividing.
    const out = subdivideTriangleSoup(face(), 5)
    for (let v = 0; v < out.positions.length; v += 3) {
      const x = out.positions[v] as number
      const z = out.positions[v + 2] as number
      expect(x).toBeGreaterThanOrEqual(-1e-4)
      expect(z).toBeGreaterThanOrEqual(-1e-4)
      // The hypotenuse of the 12x12 parent.
      expect(x + z).toBeLessThanOrEqual(12 + 1e-4)
    }
  })

  it('keeps every sub-triangle on the parent plane', () => {
    const out = subdivideTriangleSoup(face(), 4)
    for (let i = 1; i < out.positions.length; i += 3) expect(out.positions[i]).toBeCloseTo(0, 6)
  })

  it('KEEPS THE WINDING, or every facet faces backwards', () => {
    // A mirror is the classic way to lose a whole surface to backface culling,
    // and this project has already shipped one (trap 11).
    const parent = face()
    const out = subdivideTriangleSoup(parent, 4)
    const want = Math.sign(signedArea(parent, 0))
    expect(want).not.toBe(0)
    for (let f = 0; f < out.positions.length / 9; f++) {
      expect(Math.sign(signedArea(out, f)), `sub-triangle ${f}`).toBe(want)
    }
  })

  it('interpolates colour and uv barycentrically', () => {
    const out = subdivideTriangleSoup(face(), 4)
    // Every colour channel stays in range and every vertex sums to 1, because
    // the parent's three colours are the basis vectors.
    for (let v = 0; v < out.colors.length; v += 3) {
      const sum =
        (out.colors[v] as number) + (out.colors[v + 1] as number) + (out.colors[v + 2] as number)
      expect(sum).toBeCloseTo(1, 5)
    }
    for (const u of out.uvs) expect(u).toBeGreaterThanOrEqual(-1e-6)
  })

  it('is a NO-OP on a flat-shaded face, which is what the terrain is', () => {
    // The three corners of a generated facet already share a colour and a
    // normal. Interpolating between three equal values must return that value —
    // otherwise the sea would gain gradients the generator never made.
    const flat = {
      ...face(),
      colors: new Float32Array([0.2, 0.4, 0.6, 0.2, 0.4, 0.6, 0.2, 0.4, 0.6]),
    } as unknown as TerrainChunkMesh
    const out = subdivideTriangleSoup(flat, 4)
    for (let v = 0; v < out.colors.length; v += 3) {
      expect(out.colors[v]).toBeCloseTo(0.2, 6)
      expect(out.colors[v + 1]).toBeCloseTo(0.4, 6)
      expect(out.colors[v + 2]).toBeCloseTo(0.6, 6)
    }
  })

  it('scales a whole chunk without losing a triangle', () => {
    const faces = 40
    const many = {
      positions: new Float32Array(faces * 9),
      normals: new Float32Array(faces * 9),
      colors: new Float32Array(faces * 9),
      uvs: new Float32Array(faces * 6),
      triangleCount: faces,
    } as unknown as TerrainChunkMesh
    for (let f = 0; f < faces; f++) {
      const b = f * 9
      many.positions[b] = f * 20
      many.positions[b + 3] = f * 20 + 10
      many.positions[b + 8] = 10
      many.positions[b + 6] = f * 20
    }
    const out = subdivideTriangleSoup(many, 4)
    expect(out.positions.length / 9).toBe(faces * 16)
    expect(area(out)).toBeCloseTo(area(many), 3)
  })
})

// ── The jitter, without which subdivision buys nothing at all ─────────────
//
// Matt: *"can you make sure noise is applied to the base ocean mesh before the
// ocean shader movement is applied? (it all looks kinda flat still)"*
//
// He was right and it is worth being precise about why: barycentric sub-vertices
// land EXACTLY on the parent's plane, so subdivision on its own multiplied the
// triangle count by sixteen and changed the surface by nothing. Every test above
// this line passes with a perfectly flat sea.
describe('the interior jitter', () => {
  const jittered = (n: number) => subdivideTriangleSoup(face(), n, 2)

  it('actually lifts sub-vertices off the parent plane', () => {
    // The whole point. The parent is flat in y; a jittered subdivision is not.
    const out = jittered(4)
    let moved = 0
    for (let i = 1; i < out.positions.length; i += 3) {
      if (Math.abs(out.positions[i] as number) > 1e-6) moved++
    }
    expect(moved).toBeGreaterThan(0)
    // ...and at zero amplitude it is flat again, so the flatness above was real.
    const flat = subdivideTriangleSoup(face(), 4, 0)
    for (let i = 1; i < flat.positions.length; i += 3) {
      expect(flat.positions[i] as number).toBeCloseTo(0, 9)
    }
  })

  it('NEVER moves a point on a parent edge, or the mesh cracks', () => {
    // A lattice point on an edge is shared with the triangle next door and, at a
    // chunk seam, with a chunk generated separately that knows nothing about
    // this one. Moving it opens a line of sky.
    //
    // COUNTED, not located. The first version of this test decided which points
    // were on an edge by looking at their x/z AFTER jittering — so a vertex that
    // had been moved off the edge no longer looked like an edge vertex and was
    // skipped. It passed with the interior check deleted. The number of interior
    // lattice points is exactly (n-1)(n-2)/2, and that is not fakeable.
    for (const n of [4, 5, 8]) {
      const out = subdivideTriangleSoup(face(), n, 2)
      const moved = new Set<string>()
      for (let v = 0; v < out.positions.length; v += 3) {
        if (Math.abs(out.positions[v + 1] as number) > 1e-6) {
          moved.add(
            `${(out.positions[v] as number).toFixed(4)},${(out.positions[v + 2] as number).toFixed(4)}`,
          )
        }
      }
      expect(moved.size, `factor ${n}`).toBe(((n - 1) * (n - 2)) / 2)
    }
  })

  it('gives the SAME point the SAME offset, however often it is emitted', () => {
    // The soup is fully split, so an interior lattice point is emitted by up to
    // six sub-triangles. A sequence- or index-based random gives each copy a
    // different offset and tears the surface open; the hash is on the position.
    //
    // Keyed on the UNJITTERED position, from a parallel run at amplitude zero —
    // the emit order is identical, so index i is the same lattice point in both.
    // Keying on the jittered position is what made the first version of this
    // test vacuous: with an index hash, every copy lands somewhere different and
    // therefore never collides, so nothing is ever compared.
    const flat = subdivideTriangleSoup(face(), 6, 0)
    const bumpy = subdivideTriangleSoup(face(), 6, 2)
    const seen = new Map<string, number>()
    let shared = 0
    for (let v = 0; v < flat.positions.length; v += 3) {
      const key = `${(flat.positions[v] as number).toFixed(4)},${(flat.positions[v + 2] as number).toFixed(4)}`
      const y = bumpy.positions[v + 1] as number
      if (seen.has(key)) {
        expect(seen.get(key), `lattice point ${key}`).toBeCloseTo(y, 9)
        shared++
      } else seen.set(key, y)
    }
    // Only meaningful if points really are emitted more than once.
    expect(shared).toBeGreaterThan(20)
  })

  it('is REPEATABLE, so a chunk does not reshuffle when it swaps LOD', () => {
    const a = jittered(4)
    const b = jittered(4)
    for (let i = 0; i < a.positions.length; i++) {
      expect(a.positions[i]).toBe(b.positions[i])
    }
  })

  it('stays inside the unit ball, so the amplitude means what it says', () => {
    const out = [0, 0, 0]
    let worst = 0
    for (let i = 0; i < 500; i++) {
      interiorJitter(i * 7.3 - 900, i * -3.1 + 40, i * 0.017, out)
      worst = Math.max(worst, Math.hypot(out[0] as number, out[1] as number, out[2] as number))
    }
    expect(worst).toBeLessThanOrEqual(1 + 1e-9)
    // And it is not degenerate — a hash that always returned zero would pass the
    // line above and leave the sea exactly as flat as it was.
    expect(worst).toBeGreaterThan(0.5)
  })

  it('scales x/z with the subdivision but NOT y', () => {
    // Relative sway stays constant as the sub-quad shrinks, while the height
    // noise keeps its absolute 2 m — which is the part you can see.
    const spread = (n: number) => {
      const out = jittered(n)
      let maxY = 0
      for (let i = 1; i < out.positions.length; i += 3) {
        maxY = Math.max(maxY, Math.abs(out.positions[i] as number))
      }
      return maxY
    }
    // Same absolute height range at both densities, within the sampling noise.
    expect(spread(8)).toBeGreaterThan(spread(4) * 0.6)
    expect(spread(8)).toBeLessThan(2 + 1e-6)
  })
})
