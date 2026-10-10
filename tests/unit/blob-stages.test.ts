// tests/unit/blob-stages.test.ts: the lobe, displace, crunch and split stages the
// cloud and prop generators share (code-reuse audit SG-3).
//
// That both generators' bytes are unchanged by the move is proved by a hash of
// their output taken before and after (docs/plan/code-reuse/progress/
// reuse-mesh-gen.md). What is asserted here is the contract a THIRD user of the
// stages would rely on: how many random numbers each stage takes, and in what
// order the split visits faces.

import { describe, expect, it } from 'vitest'
import { blobLobes, crunchVertices, displaceByLobes, splitFlat } from '@/sim/blob'
import { icosphere } from '@/sim/clouds'
import { makeRandom } from '@/sim/terrain/faceted'

/** A stream that counts what is drawn from it. */
const counted = (seed: number) => {
  const inner = makeRandom(seed)
  const state = { draws: 0 }
  const rnd = (): number => {
    state.draws++
    return inner()
  }
  return { rnd, state }
}

describe('blobLobes', () => {
  it('takes exactly three draws per lobe: z, angle, strength', () => {
    const { rnd, state } = counted(5)
    blobLobes(rnd, 7, 0.4, 0.5)
    expect(state.draws).toBe(21)
  })

  it('makes unit directions and strengths between 0.55 and 1 of the nominal', () => {
    const lobes = blobLobes(makeRandom(9), 40, 0.75, 0.5)
    expect(lobes.length).toBe(160)
    for (let i = 0; i < 40; i++) {
      expect(
        Math.hypot(lobes[i * 4] as number, lobes[i * 4 + 1] as number, lobes[i * 4 + 2] as number),
      ).toBeCloseTo(1, 6)
      const s = lobes[i * 4 + 3] as number
      expect(s).toBeGreaterThanOrEqual(0.5 * 0.55 - 1e-6)
      expect(s).toBeLessThanOrEqual(0.5 + 1e-6)
    }
  })

  it('spread pushes the directions toward the horizontal', () => {
    const flat = blobLobes(makeRandom(3), 60, 1, 1)
    for (let i = 0; i < 60; i++) expect(Math.abs(flat[i * 4 + 1] as number)).toBeLessThan(1e-6)
  })
})

describe('displaceByLobes', () => {
  it('with no lobes only flattens y', () => {
    const { vertices } = icosphere(1)
    const moved = displaceByLobes(vertices, new Float32Array(0), 3, 0.5)
    for (let v = 0; v < vertices.length / 3; v++) {
      expect(moved[v * 3]).toBe(vertices[v * 3])
      expect(moved[v * 3 + 1]).toBeCloseTo((vertices[v * 3 + 1] as number) * 0.5, 6)
      expect(moved[v * 3 + 2]).toBe(vertices[v * 3 + 2])
    }
  })

  it('only ever pushes outward', () => {
    const { vertices } = icosphere(2)
    const moved = displaceByLobes(vertices, blobLobes(makeRandom(1), 9, 0.3, 0.5), 3, 1)
    for (let v = 0; v < vertices.length / 3; v++) {
      const r = Math.hypot(
        moved[v * 3] as number,
        moved[v * 3 + 1] as number,
        moved[v * 3 + 2] as number,
      )
      expect(r).toBeGreaterThanOrEqual(1 - 1e-6)
    }
  })
})

describe('crunchVertices', () => {
  it('draws nothing and moves nothing at jitter 0', () => {
    const { rnd, state } = counted(2)
    const moved = icosphere(1).vertices.slice()
    const before = moved.slice()
    crunchVertices(moved, rnd, 0)
    expect(state.draws).toBe(0)
    expect(Array.from(moved)).toEqual(Array.from(before))
  })

  it('moves each shared vertex once, by no more than the jitter radius', () => {
    const moved = icosphere(1).vertices.slice()
    const before = moved.slice()
    crunchVertices(moved, makeRandom(4), 0.2)
    for (let v = 0; v < moved.length / 3; v++) {
      const d = Math.hypot(
        (moved[v * 3] as number) - (before[v * 3] as number),
        (moved[v * 3 + 1] as number) - (before[v * 3 + 1] as number),
        (moved[v * 3 + 2] as number) - (before[v * 3 + 2] as number),
      )
      expect(d).toBeLessThanOrEqual(0.2 + 1e-6)
    }
  })
})

describe('splitFlat', () => {
  it('calls back once per face, in face order (a caller draws its own random numbers there)', () => {
    const { vertices, faces } = icosphere(1)
    const seen: number[] = []
    const split = splitFlat(vertices, faces, (f) => seen.push(f))
    expect(seen).toEqual(Array.from({ length: faces.length / 3 }, (_, i) => i))
    expect(split.triangleCount).toBe(faces.length / 3)
    expect(split.positions.length).toBe(split.triangleCount * 9)
    expect(split.normals.length).toBe(split.triangleCount * 9)
  })

  it('writes outward-pointing unit normals for an icosphere', () => {
    const { vertices, faces } = icosphere(1)
    const { positions, normals, triangleCount } = splitFlat(vertices, faces)
    for (let f = 0; f < triangleCount; f++) {
      const o = f * 9
      const nx = normals[o] as number
      const ny = normals[o + 1] as number
      const nz = normals[o + 2] as number
      expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 6)
      const mx =
        ((positions[o] as number) + (positions[o + 3] as number) + (positions[o + 6] as number)) / 3
      const my =
        ((positions[o + 1] as number) +
          (positions[o + 4] as number) +
          (positions[o + 7] as number)) /
        3
      const mz =
        ((positions[o + 2] as number) +
          (positions[o + 5] as number) +
          (positions[o + 8] as number)) /
        3
      expect(nx * mx + ny * my + nz * mz).toBeGreaterThan(0)
    }
  })
})
