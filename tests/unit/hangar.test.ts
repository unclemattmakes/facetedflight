// tests/unit/hangar.test.ts — the room you launch out of.
//
// The test that matters here is the one that already caught me. The generator
// winds every wall and ceiling triangle so its normal points INTO the room, and
// the renderer then has to pick the matching `side`. The first build set
// `THREE.BackSide` on top of inward winding, which culls exactly the faces you
// are meant to see — a hangar you could look straight through at the island.
//
// That is the orientation lesson in miniature: **test the geometry, not the
// belief.** "The normals point inward" is a dot product against a known centre
// and is true independently of what anybody thought the winding was.

import { describe, expect, it } from 'vitest'
import { generateHangar, type HangarSpec, hangarSpecFor } from '@/sim/hangar'

/** `int_01`'s real numbers: a 9.35 x 9.28 m platform, 12 m shaft segments. */
const SPEC: HangarSpec = hangarSpecFor(9.35 / 2, 12)

const build = (spec: HangarSpec = SPEC, seed = 0x48414e47) => generateHangar(spec, seed)

/** Every triangle, as its three corners plus its stored face normal. */
const triangles = (m: ReturnType<typeof build>) =>
  Array.from({ length: m.triangleCount }, (_, t) => {
    const o = t * 9
    const p = (k: number) => ({
      x: m.positions[o + k * 3] as number,
      y: m.positions[o + k * 3 + 1] as number,
      z: m.positions[o + k * 3 + 2] as number,
    })
    return {
      a: p(0),
      b: p(1),
      c: p(2),
      normal: {
        x: m.normals[o] as number,
        y: m.normals[o + 1] as number,
        z: m.normals[o + 2] as number,
      },
      centroid: {
        x: ((p(0).x + p(1).x + p(2).x) / 3) as number,
        y: ((p(0).y + p(1).y + p(2).y) / 3) as number,
        z: ((p(0).z + p(1).z + p(2).z) / 3) as number,
      },
    }
  })

describe('the hangar', () => {
  it('faces INWARD — every wall normal points back at the seat', () => {
    // THE regression, and the one bug this file was written against. The seat
    // is on the axis, so "inward" is "the horizontal normal opposes the
    // horizontal offset from the axis". Checked on the wall and ceiling bands
    // only: the floor faces up and has no horizontal normal to speak of.
    for (const tri of triangles(build())) {
      const horizontal = Math.hypot(tri.normal.x, tri.normal.z)
      if (horizontal < 0.2) continue // floor, or the flattest ceiling facets
      const outward = Math.hypot(tri.centroid.x, tri.centroid.z)
      if (outward < 1e-6) continue
      const dot = (tri.normal.x * tri.centroid.x + tri.normal.z * tri.centroid.z) / outward
      expect(
        dot,
        `facet at (${tri.centroid.x.toFixed(1)}, ${tri.centroid.z.toFixed(1)})`,
      ).toBeLessThan(0)
    }
  })

  it('points the FLOOR up, so you can see what you are standing on', () => {
    const floor = triangles(build()).filter((t) => t.centroid.y < SPEC.floorY + 1)
    expect(floor.length).toBeGreaterThan(0)
    for (const tri of floor) expect(tri.normal.y, 'floor normal').toBeGreaterThan(0.5)
  })

  it('leaves the bore CLEAR, so the platform can actually get out', () => {
    // The room narrows to `boreRadius` at the ceiling, and the elevator rings
    // its shaft pillars at the same 1.45 platform radii. Nothing the generator
    // emits may intrude on that column, or the lift rises into its own roof.
    //
    // Measured above the wall top, where the ceiling is closing in — below that
    // the wall is at room radius and the question does not arise.
    for (const tri of triangles(build())) {
      if (tri.centroid.y < SPEC.wallTopY) continue
      for (const p of [tri.a, tri.b, tri.c]) {
        if (p.y < SPEC.wallTopY) continue
        // The jitter is ±`jitter` metres, so the bore can be eaten into by at
        // most that much. Anything more is a shape error, not noise.
        expect(Math.hypot(p.x, p.z), 'bore clearance').toBeGreaterThan(
          SPEC.boreRadius - SPEC.jitter * 1.5,
        )
      }
    }
  })

  it('is a ROOM: wider than the bore, and tall enough to sit up in', () => {
    // Ratios rather than absolutes, so a platform size change carries through.
    expect(SPEC.roomRadius).toBeGreaterThan(SPEC.boreRadius * 1.5)
    expect(SPEC.ceilingY - SPEC.floorY).toBeGreaterThan(8)
    expect(SPEC.ceilingY).toBeGreaterThan(SPEC.wallTopY)
  })

  it('is DETERMINISTIC — the same seed is the same room', () => {
    // The sim layer has no clock and no `Math.random` precisely so this holds,
    // and it is what lets a player's hangar look the same on two machines.
    const a = build()
    const b = build()
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions))
    expect(Array.from(a.colors)).toEqual(Array.from(b.colors))
  })

  it('is a DIFFERENT room on a different seed', () => {
    // The guard against a determinism test that passes because the seed is
    // ignored and every room is identical.
    const a = build()
    const b = build(SPEC, 12345)
    expect(Array.from(a.positions)).not.toEqual(Array.from(b.positions))
  })

  it('crunches the facets rather than leaving a smooth revolve', () => {
    // The house style, and the thing that separates this from a programmer
    // cylinder. The clouds learned it the same way (DEV-028): lobes alone gave
    // a pillow until every shared vertex was displaced inside a small ball.
    //
    // The first version of this asserted "more than `sides` distinct radii",
    // which is nonsense: a PERFECT revolve has exactly ONE radius, and the 12
    // it measured were the jitter already working. The claim is about the
    // SPREAD, and it has to be two-sided — a crunch that is not there and a
    // crunch that has torn the wall open are both failures.
    const radii: number[] = []
    for (const tri of triangles(build())) {
      for (const p of [tri.a, tri.b, tri.c]) {
        if (p.y < SPEC.floorY + 1 || p.y > SPEC.wallTopY + 0.5) continue
        radii.push(Math.hypot(p.x, p.z))
      }
    }
    expect(radii.length).toBeGreaterThan(0)
    const spread = Math.max(...radii) - Math.min(...radii)
    expect(spread, 'there is a crunch').toBeGreaterThan(SPEC.jitter * 0.4)
    expect(spread, 'and it is jitter, not damage').toBeLessThan(SPEC.jitter * 4)
  })

  it('emits a complete mesh — 9 floats a triangle, all finite', () => {
    // A NaN here renders as nothing at all and reads as "the hangar did not
    // load", which is a long way from "one divide was by zero".
    const m = build()
    expect(m.positions.length).toBe(m.triangleCount * 9)
    expect(m.normals.length).toBe(m.triangleCount * 9)
    expect(m.colors.length).toBe(m.triangleCount * 9)
    for (const arr of [m.positions, m.normals, m.colors]) {
      expect(arr.every((v) => Number.isFinite(v))).toBe(true)
    }
    // And every normal is a unit vector, which a degenerate triangle would break.
    for (const tri of triangles(m)) {
      expect(Math.hypot(tri.normal.x, tri.normal.y, tri.normal.z)).toBeCloseTo(1, 5)
    }
  })
})
