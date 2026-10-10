// tests/unit/hangar-dressing.test.ts — the girders, pipes and plinth the menu
// room grew (DEV-139) are deterministic, wound to face OUT, and in nobody's way.
//
// The winding check is generic on purpose: every piece the generator emits is
// a convex prism, and the centroid of a convex solid's vertices lies inside
// it — so every face normal must point AWAY from its own component's centroid.
// That is true of a box, a hexagonal pipe and a 12-gon slab alike, and it is
// false for exactly the mistake a hand-derived winding makes (the orientation
// lesson: measure the geometry, not the belief). Components are found by
// shared vertex coordinates, not by what the generator says it built.

import { describe, expect, it } from 'vitest'
import {
  HANGAR_VIEWS,
  HOLO_REACH,
  SEAT_EYE_HEIGHT,
  seatEyeLocal,
  stepBearings,
  TABLES_PER_PAGE,
  tableLocal,
} from '@/render/hangar'
import {
  generateHangarDressing,
  type HangarMesh,
  hangarSpecFor,
  PIPE_BAYS,
  PLINTH,
  plinthTopY,
} from '@/sim/hangar'

const spec = hangarSpecFor()
const SEED = 0x48414e47

const menu = () => generateHangarDressing(spec, SEED, { plinth: true })
const launch = () => generateHangarDressing(spec, SEED, { plinth: false })

/** Connected components of the triangle soup, by exact shared vertex position. */
const components = (m: HangarMesh): number[][] => {
  const key = (i: number) =>
    `${m.positions[i * 3]},${m.positions[i * 3 + 1]},${m.positions[i * 3 + 2]}`
  const parent: number[] = Array.from({ length: m.triangleCount }, (_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i] as number] as number
      i = parent[i] as number
    }
    return i
  }
  const union = (a: number, b: number) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }
  const seen = new Map<string, number>()
  for (let t = 0; t < m.triangleCount; t++) {
    for (let k = 0; k < 3; k++) {
      const kk = key(t * 3 + k)
      const prev = seen.get(kk)
      if (prev === undefined) seen.set(kk, t)
      else union(prev, t)
    }
  }
  const groups = new Map<number, number[]>()
  for (let t = 0; t < m.triangleCount; t++) {
    const r = find(t)
    const g = groups.get(r)
    if (g) g.push(t)
    else groups.set(r, [t])
  }
  return [...groups.values()]
}

const vertex = (m: HangarMesh, i: number): [number, number, number] => [
  m.positions[i * 3] as number,
  m.positions[i * 3 + 1] as number,
  m.positions[i * 3 + 2] as number,
]

describe('the dressing mesh', () => {
  it('is DETERMINISTIC, and a different seed is a different dressing', () => {
    const a = menu()
    const b = menu()
    expect(a.triangleCount).toBe(b.triangleCount)
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions))
    expect(Array.from(a.colors)).toEqual(Array.from(b.colors))
    const c = generateHangarDressing(spec, SEED + 1, { plinth: true })
    expect(Array.from(c.colors)).not.toEqual(Array.from(a.colors))
  })

  it('is a complete mesh: 9 floats a triangle, all finite, unit normals', () => {
    const m = menu()
    expect(m.positions.length).toBe(m.triangleCount * 9)
    expect(m.normals.length).toBe(m.triangleCount * 9)
    expect(m.colors.length).toBe(m.triangleCount * 9)
    for (let i = 0; i < m.positions.length; i++) {
      expect(Number.isFinite(m.positions[i])).toBe(true)
      expect(Number.isFinite(m.colors[i])).toBe(true)
    }
    for (let t = 0; t < m.triangleCount; t++) {
      const len = Math.hypot(
        m.normals[t * 9] as number,
        m.normals[t * 9 + 1] as number,
        m.normals[t * 9 + 2] as number,
      )
      expect(len).toBeCloseTo(1, 5)
    }
    expect(m.triangleCount).toBeGreaterThan(300)
    expect(m.triangleCount).toBeLessThan(2500)
  })

  it('winds every piece to face OUT — no face looks into its own solid', () => {
    const m = menu()
    const groups = components(m)
    // Girders (12) + ring segments (12) + 4 x (3 runs + valve + handle + elbow) + 2 tiers.
    expect(groups.length).toBeGreaterThanOrEqual(12 + 12 + 4 * 6 + 2 - 4)
    let inward = 0
    for (const tris of groups) {
      let cx = 0
      let cy = 0
      let cz = 0
      let count = 0
      for (const t of tris) {
        for (let k = 0; k < 3; k++) {
          const v = vertex(m, t * 3 + k)
          cx += v[0]
          cy += v[1]
          cz += v[2]
          count++
        }
      }
      cx /= count
      cy /= count
      cz /= count
      for (const t of tris) {
        const a = vertex(m, t * 3)
        const b = vertex(m, t * 3 + 1)
        const c = vertex(m, t * 3 + 2)
        const fx = (a[0] + b[0] + c[0]) / 3 - cx
        const fy = (a[1] + b[1] + c[1]) / 3 - cy
        const fz = (a[2] + b[2] + c[2]) / 3 - cz
        const dot =
          fx * (m.normals[t * 9] as number) +
          fy * (m.normals[t * 9 + 1] as number) +
          fz * (m.normals[t * 9 + 2] as number)
        if (dot <= 0) inward++
      }
    }
    expect(inward, 'faces whose normal points into their own solid').toBe(0)
  })
})

describe('the dressing keeps out of the way', () => {
  const bore = spec.boreRadius

  it('leaves the bore CLEAR above the plinth in the menu room', () => {
    const m = menu()
    const top = plinthTopY(spec)
    for (let i = 0; i < m.triangleCount * 3; i++) {
      const [x, y, z] = vertex(m, i)
      if (Math.hypot(x, z) < bore - 1e-6) {
        expect(
          y,
          `vertex inside the bore at (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})`,
        ).toBeLessThanOrEqual(top + 1e-6)
      }
    }
  })

  it('leaves the whole bore clear in the LAUNCH room, where the platform rises', () => {
    const m = launch()
    for (let i = 0; i < m.triangleCount * 3; i++) {
      const [x, , z] = vertex(m, i)
      expect(Math.hypot(x, z)).toBeGreaterThanOrEqual(bore - 1e-6)
    }
  })

  it('puts the plinth top where the ship is parked, and the plinth on the floor', () => {
    const m = menu()
    let top = -Infinity
    let bottom = Infinity
    for (let i = 0; i < m.triangleCount * 3; i++) {
      const [x, y, z] = vertex(m, i)
      if (Math.hypot(x, z) < bore) {
        top = Math.max(top, y)
        bottom = Math.min(bottom, y)
      }
    }
    expect(top).toBeCloseTo(plinthTopY(spec), 6)
    expect(bottom).toBeCloseTo(spec.floorY, 6)
    expect(plinthTopY(spec) - spec.floorY).toBeCloseTo(PLINTH.lowerRise + PLINTH.upperRise, 9)
  })

  it('does not touch either lamp', () => {
    const lamps: [number, number, number][] = [
      [0, spec.wallTopY * 0.6, 0],
      [spec.roomRadius * 0.7, spec.wallTopY - 1.2, 0],
    ]
    for (const m of [menu(), launch()]) {
      for (let i = 0; i < m.triangleCount * 3; i++) {
        const v = vertex(m, i)
        for (const l of lamps) {
          expect(Math.hypot(v[0] - l[0], v[1] - l[1], v[2] - l[2])).toBeGreaterThan(1.0)
        }
      }
    }
  })

  it('keeps the pipes out of the strip bars and off the seat’s bay', () => {
    const m = menu()
    const stripRadius = spec.roomRadius * 0.93
    const bars: [number, number, number][] = []
    for (const y of [spec.floorY + 1.4, spec.wallTopY - 1.2]) {
      for (let i = 0; i < spec.sides; i++) {
        const a = (i / spec.sides) * Math.PI * 2
        bars.push([Math.cos(a) * stripRadius, y, Math.sin(a) * stripRadius])
      }
    }
    // The pipes are the only dressing between 0.9 R and the wall at strip height.
    let pipeVertices = 0
    for (let i = 0; i < m.triangleCount * 3; i++) {
      const [x, y, z] = vertex(m, i)
      const r = Math.hypot(x, z)
      if (r < spec.roomRadius * 0.9 || y > spec.wallTopY - 0.5) continue
      pipeVertices++
      for (const b of bars) {
        // A bar is 2.6 m long tangentially and 0.28 m thick; 1.35 m clears its end.
        expect(Math.hypot(x - b[0], y - b[1], z - b[2])).toBeGreaterThan(1.35)
      }
    }
    expect(pipeVertices).toBeGreaterThan(100)
    // The seat is on the room's +z: bay 3 of 12. No cluster there.
    const seatBay = Math.round((Math.PI / 2 / (Math.PI * 2)) * spec.sides)
    expect(PIPE_BAYS).not.toContain(seatBay)
  })

  it('stays clear of the seat, the eye, and every table a page can lay', () => {
    const m = menu()
    const eye = seatEyeLocal(spec)
    const points: [number, number, number][] = [
      [eye.x, eye.y, eye.z],
      [eye.x, eye.y - SEAT_EYE_HEIGHT, eye.z],
    ]
    // Every STEP's layout, not one arc: since the DEV-379 follow-up the
    // flight-plan step lays its arc centred on the resting pointer
    // (`stepBearings`), which stands a table half a step further left.
    for (const view of HANGAR_VIEWS) {
      for (const count of [1, 2, 3, 4]) {
        for (const bearing of stepBearings(view, count)) {
          const t = tableLocal(spec, bearing)
          points.push([t.x, t.y, t.z], [t.x, t.y + 0.6, t.z])
        }
      }
    }
    // The premise the loop above rests on, and it is the ARC CAP rather than
    // the step count: `[1, 2, 3, 4]` covers every arc a page can lay only while
    // no step is wider than four tables. DEV-203 added a fourth step (the
    // flight plan) without widening the arc, so the number that moved is the
    // one that was never load-bearing — said as both, so a fifth ENVIRONMENT,
    // which would widen the arc, goes red here too.
    expect(TABLES_PER_PAGE).toBe(4)
    // DEV-382 added the variant step without widening the arc either: a
    // variant arc is the aircraft's variants, standard centred, at most three.
    expect(HANGAR_VIEWS.length, 'aircraft, variant, flight plan, difficulty, place').toBe(5)
    for (let i = 0; i < m.triangleCount * 3; i++) {
      const v = vertex(m, i)
      for (const p of points) {
        expect(Math.hypot(v[0] - p[0], v[1] - p[1], v[2] - p[2])).toBeGreaterThan(HOLO_REACH)
      }
    }
  })

  it('hangs the girders above head height', () => {
    const m = menu()
    // Between the bore and 0.85 R nothing stands but the girders and their ring;
    // the pipes and the valve handle reach in only to 0.89 R.
    for (let i = 0; i < m.triangleCount * 3; i++) {
      const [x, y, z] = vertex(m, i)
      const r = Math.hypot(x, z)
      if (r >= bore && r < spec.roomRadius * 0.85) {
        expect(y).toBeGreaterThan(spec.floorY + SEAT_EYE_HEIGHT + 3)
      }
    }
  })
})
