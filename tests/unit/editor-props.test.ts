// tests/unit/editor-props.test.ts — how the desk seats a placed prop. DEV-504.
//
// A prop stands at the LOWEST ground under its BASE (the bottom tenth of its
// drawn vertices), less the preset's sink: a spire's 290 m base never stands
// on air, and a plant's base is its trunk, so it stands as the island's own
// scatter does, at its pivot. `editor-props.spec.ts` holds the same rule on
// the real island through the page's own ground probe.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { propYawFor } from '@/editor/desk/policy'
import { baseRadius, footprintSeat } from '@/editor/desk/props'

/** A box's eight corners, as a position array. */
const box = (w: number, h: number, d: number): number[] => {
  const out: number[] = []
  for (const x of [-w / 2, w / 2])
    for (const y of [0, h]) for (const z of [-d / 2, d / 2]) out.push(x, y, z)
  return out
}

describe('DEV-504 — a prop is seated by its base', () => {
  it('the base is the bottom tenth of the drawn mesh, measured from the pivot in plan', () => {
    // A 10 x 100 x 10 rod standing up: its base reaches the corner, 5√2 m.
    const r = baseRadius(box(10, 100, 10), new THREE.Matrix4(), { x: 0, z: 0 })
    expect(r).toBeCloseTo(5 * Math.SQRT2, 9)
    // Scaled and moved: the reach scales, and is measured from the pivot given.
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(30, 7, -4),
      new THREE.Quaternion(),
      new THREE.Vector3(3, 3, 3),
    )
    expect(baseRadius(box(10, 100, 10), m, { x: 30, z: -4 })).toBeCloseTo(15 * Math.SQRT2, 9)
    // A cone narrowing up: only the bottom band counts, not the crown.
    const cone = [-10, 0, 0, 10, 0, 0, 0, 0, 10, -1, 100, 0, 1, 100, 0]
    expect(baseRadius(cone, new THREE.Matrix4(), { x: 0, z: 0 })).toBeCloseTo(10, 9)
    // Laid on its side (a rod along x), its base is the whole of it.
    const side = new THREE.Matrix4().makeRotationZ(Math.PI / 2)
    expect(baseRadius(box(10, 100, 10), side, { x: 0, z: 0 })).toBeGreaterThan(99)
  })

  it('the seat is the lowest ground under the base, less the sink', () => {
    // A cliff: 100 m for x < 20, sea (0 m) past it.
    const cliff = (x: number): number => (x < 20 ? 100 : 0)
    // A narrow base 10 m from the edge stands on the top…
    expect(footprintSeat(cliff, 0, 0, 5, 0.6)).toBeCloseTo(100 - 0.6, 9)
    // …a wide one reaching past it goes down to the sea: never on air.
    expect(footprintSeat(cliff, 0, 0, 40, 0.6)).toBeCloseTo(0 - 0.6, 9)
    // No base at all is the pivot alone, as the scatter stands a plant.
    expect(footprintSeat(cliff, 19, 0, 0, 0)).toBe(100)
    // No ground at all, no seat.
    expect(footprintSeat(() => Number.NaN, 0, 0, 5, 0)).toBeNull()
  })

  it('a garden is turned by the golden angle: no two of the first twenty face within 5°', () => {
    const yaws = Array.from({ length: 20 }, (_, n) => propYawFor(n))
    for (let i = 0; i < yaws.length; i++) {
      for (let j = 0; j < i; j++) {
        const d = Math.abs((((yaws[i] as number) - (yaws[j] as number) + 540) % 360) - 180)
        expect(d, `${i} and ${j}`).toBeGreaterThan(5)
      }
    }
  })
})
