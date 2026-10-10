// tests/unit/editor-bench.test.ts — DEV-492, the VR bench's arithmetic.
//
// Orientation bugs are a class here (CLAUDE.md: four of them, three caught by
// Matt from a screenshot). So the mapping is held against GEOMETRY, not
// against a belief about signs: an ASYMMETRIC island — one peak, off both
// axes — is drawn by the diorama itself, and the bench's mapping must carry
// the drawn peak back to where the height field has it. A sign error in x or
// z lands kilometres away; a swapped axis lands on the other diagonal.

import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  dragTo,
  drawnHeightAt,
  pickLine,
  pickPoint,
  rayOntoIsland,
  toBench,
  toWorld,
} from '@/editor/bench/frame'
import { BENCH_CELLS, benchCellAt, benchCellCentre } from '@/editor/bench/plate'
import { BENCH_POLICY } from '@/editor/bench/policy'
import { BENCH_DOOR } from '@/render/bench-door'
import { createDiorama } from '@/render/diorama'
import { buildHeightField, terrainHeightAt } from '@/sim/terrain/height-field'
import type { MapSampler } from '@/sim/terrain/image-sampler'

/** The peak's place on the map: right of centre and toward the map's low v. */
const PEAK_U = 0.8
const PEAK_V = 0.25
const SIZE = 4096
const ORIGIN: [number, number, number] = [-2048, -40, -2048]

const oneHill: MapSampler = {
  width: 128,
  height: 128,
  sample(u, v, out) {
    const h = Math.max(0, 1 - Math.hypot(u - PEAK_U, v - PEAK_V) * 8)
    out.r = h
    out.g = h
    out.b = h
  },
}

const field = () =>
  buildHeightField(
    oneHill,
    {
      terrainSize: SIZE,
      terrainHeight: 900,
      chunkSize: 256,
      baseResolution: 16,
      randomOffset: 0,
      seed: 1,
    },
    { position: ORIGIN, scale: [1, 1, 1] },
  )

/** The bench's island: the diorama at the bench's own options. */
const benchIsland = () => {
  const f = field()
  const size = SIZE / BENCH_POLICY.worldPerBenchMetre
  const diorama = createDiorama({
    field: f,
    route: null,
    size,
    grid: BENCH_POLICY.grid,
    relief: BENCH_POLICY.relief,
  })
  return { f, size, diorama }
}

/** The peak where the FIELD has it, THREE space (z is sim −z). */
const peakWorld = (): [number, number] => [
  (ORIGIN[0] as number) + PEAK_U * SIZE,
  -((ORIGIN[2] as number) + PEAK_V * SIZE),
]

describe('DEV-492 the bench policy, pinned', () => {
  it('is the values the row shipped', () => {
    expect(BENCH_POLICY.worldPerBenchMetre).toBe(2000)
    expect(BENCH_POLICY.relief).toBe(1)
    expect(BENCH_POLICY.grid).toBe(192)
    expect(BENCH_POLICY.centreReach).toBe(1.55)
    expect(BENCH_POLICY.waterBelowEye).toBe(0.95)
    expect(BENCH_POLICY.handReach).toBe(0.08)
  })
  it('stands the door low, inside the arc, under every ray to a table', () => {
    expect(BENCH_DOOR).toEqual({ reach: 0.62, belowEye: 0.72, width: 0.4, aspect: 3.4 })
  })
  it('puts a 4096 m island on a ~2 m table', () => {
    expect(SIZE / BENCH_POLICY.worldPerBenchMetre).toBeCloseTo(2.048, 3)
  })
})

describe('DEV-492 level frame ↔ bench', () => {
  it('toWorld undoes toBench', () => {
    const { diorama } = benchIsland()
    const f = diorama.frame
    for (const p of [
      [0, 0, 0],
      [1234.5, 87.25, -999.75],
      [-1800, 400, 1500],
    ]) {
      const back = toWorld(f, toBench(f, p))
      for (const i of [0, 1, 2]) expect(back[i]).toBeCloseTo(p[i] as number, 6)
    }
  })

  it('the drawn peak maps back to the field peak (asymmetric: +x AND +z both checked)', () => {
    const { f, diorama } = benchIsland()
    const island = diorama.object.getObjectByName('diorama-island') as unknown as {
      geometry: {
        getAttribute(n: string): {
          count: number
          getX(i: number): number
          getY(i: number): number
          getZ(i: number): number
        }
      }
    }
    const pos = island.geometry.getAttribute('position')
    let top = 0
    for (let i = 1; i < pos.count; i++) if (pos.getY(i) > pos.getY(top)) top = i
    const drawn: [number, number, number] = [pos.getX(top), pos.getY(top), pos.getZ(top)]
    // On the bench: the peak is to the RIGHT (+x) and toward the SEAT (+z),
    // because on the map it is at u = 0.8 (+x) and v = 0.25 (sim −z = THREE +z).
    expect(drawn[0]).toBeGreaterThan(0.4)
    expect(drawn[2]).toBeGreaterThan(0.3)
    const world = toWorld(diorama.frame, drawn)
    const [px, pz] = peakWorld()
    const cell = SIZE / BENCH_POLICY.grid
    expect(Math.abs(world[0] - px)).toBeLessThanOrEqual(2 * cell)
    expect(Math.abs(world[2] - pz)).toBeLessThanOrEqual(2 * cell)
    // And the height: relief 1, so the drawn top is the field's, to a cell's slope.
    const peakH = terrainHeightAt(f, px, -pz)
    expect(world[1]).toBeGreaterThan(peakH - 120)
    expect(world[1]).toBeLessThanOrEqual(peakH + 1e-6)
  })

  it("a point at the bench's +x lands at the island's +x, and +z at +z", () => {
    const { diorama } = benchIsland()
    const f = diorama.frame
    const centre = toWorld(f, [0, 0, 0])
    const east = toWorld(f, [0.5, 0, 0])
    const near = toWorld(f, [0, 0, 0.5])
    expect(east[0] - centre[0]).toBeCloseTo(0.5 * BENCH_POLICY.worldPerBenchMetre, 6)
    expect(east[2]).toBeCloseTo(centre[2], 6)
    expect(near[2] - centre[2]).toBeCloseTo(0.5 * BENCH_POLICY.worldPerBenchMetre, 6)
    expect(near[0]).toBeCloseTo(centre[0], 6)
  })

  it('drawnHeightAt reads the field with THREE z (the peak is where the island draws it)', () => {
    const { f, diorama } = benchIsland()
    const [px, pz] = peakWorld()
    const seaY = diorama.frame.seaY
    expect(drawnHeightAt(f, seaY, px, pz)).toBeGreaterThan(seaY + 700)
    // The mirror image in z is open sea: a flip would read the peak there.
    expect(drawnHeightAt(f, seaY, px, -pz)).toBe(seaY)
  })
})

describe('DEV-492 a hand on the bench', () => {
  it('a ray straight down lands on the drawn island under it', () => {
    const { f, size, diorama } = benchIsland()
    const fr = diorama.frame
    const [px, pz] = peakWorld()
    const b = toBench(fr, [px, 0, pz])
    const surface = (x: number, z: number) => drawnHeightAt(f, fr.seaY, x, z)
    const hit = rayOntoIsland(fr, surface, [b[0], 1, b[2]], [0, -1, 0], size / 2, 4, 0.005)
    expect(hit).not.toBeNull()
    const w = toWorld(fr, hit?.point as number[])
    expect(w[0]).toBeCloseTo(px, 3)
    expect(w[2]).toBeCloseTo(pz, 3)
    expect(Math.abs(w[1] - surface(px, pz))).toBeLessThan(0.5)
  })

  it('misses off the disc and pointing up', () => {
    const { f, size, diorama } = benchIsland()
    const fr = diorama.frame
    const surface = (x: number, z: number) => drawnHeightAt(f, fr.seaY, x, z)
    expect(rayOntoIsland(fr, surface, [0, 0.5, 0], [0, 1, 0], size / 2, 4, 0.005)).toBeNull()
    expect(rayOntoIsland(fr, surface, [3, 0.5, 0], [0, -1, 0], size / 2, 4, 0.005)).toBeNull()
  })

  it('grip takes the handle within reach of the hand before the one on the ray', () => {
    const near = [0.05, 0, 0]
    const onRay = [0, 0, -1]
    expect(pickPoint([onRay, near], [0, 0, 0], [0, 0, -1], 0.08, 0.015, 0.02)).toBe(1)
    expect(pickPoint([onRay, [1, 1, 1]], [0, 0, 0], [0, 0, -1], 0.08, 0.015, 0.02)).toBe(0)
    // Behind the hand is never taken by the ray.
    expect(pickPoint([[0, 0, 1]], [0, 0, 0], [0, 0, -1], 0.08, 0.015, 0.02)).toBe(-1)
  })

  it('the line is picked only in front of the ground the ray would land on', () => {
    const line = [
      [-0.1, 0, -1],
      [0, 0, -1],
      [0.1, 0, -1],
    ]
    expect(pickLine(line, [0, 0, 0], [0, 0, -1], 0.015, 0.02, 2)).toBe(1)
    expect(pickLine(line, [0, 0, 0], [0, 0, -1], 0.015, 0.02, 0.5)).toBe(-1)
  })

  it('a drag moves the point by the hand, horizontally and vertically', () => {
    expect(dragTo([0.2, 0.05, -0.3], [0, 0, 0], [0.1, 0.02, -0.05])).toEqual([
      0.30000000000000004, 0.07, -0.35,
    ])
  })
})

describe('DEV-492 the plate', () => {
  it("each cell's centre is that cell, and the status rows are no cell", () => {
    for (const cell of BENCH_CELLS) {
      const c = benchCellCentre(cell)
      expect(benchCellAt(c.u, c.v)).toBe(cell)
    }
    expect(benchCellAt(0.5, 0.9)).toBeNull()
    expect(benchCellAt(0.001, 0.2)).toBeNull()
  })
  it('reads left to right as the painter paints them', () => {
    const us = BENCH_CELLS.map((c) => benchCellCentre(c).u)
    expect([...us].sort((a, b) => a - b)).toEqual(us)
    expect(BENCH_CELLS).toEqual(['undo', 'redo', 'delete', 'lift', 'fly', 'leave'])
  })
})

describe('DEV-799 the bench stands its island on the mission’s waterline', () => {
  // The island's zero is `seaLevel` when handed one and the land field's origin
  // when not, and on Simonet the origin is the SEABED. The bench is built in a
  // closure that fetches the water's map, so its wiring is read as source (as
  // `app-source.test.ts` guards what no unit test can construct);
  // `editor-bench.spec.ts` measures the frame it makes.
  it('asks the mission for its sea level and hands it to the diorama', () => {
    const src = fs
      .readFileSync('src/editor/bench/index.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .replace(/\s+/g, ' ')
    expect(src).toMatch(/const seaLevel = await missionSeaLevel\(level\)/)
    expect(src).toMatch(/createDiorama\(\{ field, seaLevel,/)
  })

  it('a table handed a sea is zeroed there, and one handed none at its field origin', () => {
    const f = field()
    const sea = 200
    const wet = createDiorama({ field: f, route: null, size: 1, seaLevel: sea })
    const dry = createDiorama({ field: f, route: null, size: 1 })
    expect(wet.frame.seaY).toBe(sea)
    expect(dry.frame.seaY).toBe(f.originY)
    expect(wet.frame.seaY).not.toBe(dry.frame.seaY)
    wet.dispose()
    dry.dispose()
  })
})
