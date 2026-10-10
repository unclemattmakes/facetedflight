// tests/unit/props-scatter.test.ts — the prop scatter and its LOD reveal.
//
// Everything here is synthesised in memory. No disk, so no `describe.skipIf`
// guard and none of the rot that comes with one.
//
// The assertions are deliberately about RELATIONSHIPS — a count that responds
// to density, a position that lands on the texel grid, a permutation that
// preserves its multiset — rather than about golden numbers. A test that
// re-derives its expectation the way the code does has not tested the code
// (trap 24), and a golden here would just be this implementation written twice.

import { describe, expect, it } from 'vitest'
import { initPropLod, stepPropLod } from '@/sim/props/lod'
import { scatterProps, shuffleByChunk } from '@/sim/props/scatter'
import type { ImageData8, MapSampler, Rgb } from '@/sim/terrain/image-sampler'

/** A power-of-two grey map at a constant value, so no import rescale happens. */
const flatMap = (size: number, value: number): ImageData8 => ({
  width: size,
  height: size,
  channels: 1,
  data: new Uint8Array(size * size).fill(value),
})

/** A height map that reads a constant grey, i.e. a flat world at a known height. */
const flatHeight = (value: number): MapSampler => ({
  width: 64,
  height: 64,
  sample: (_u: number, _v: number, out: Rgb) => {
    out.r = value
    out.g = value
    out.b = value
  },
})

const TERRAIN = { terrainSize: 4096, terrainHeight: 1024, chunkSize: 512 }
const PARAMS = {
  probabilityScale: 0.5,
  heightOffset: 0,
  scaleMin: 1,
  scaleMax: 2,
  paletteSize: 4,
  seed: 12345,
}

describe('scatterProps', () => {
  it('is deterministic: the same seed gives byte-identical output', () => {
    const map = flatMap(64, 255)
    const a = scatterProps(map, flatHeight(0.5), TERRAIN, PARAMS)
    const b = scatterProps(map, flatHeight(0.5), TERRAIN, PARAMS)
    expect(a.count).toBe(b.count)
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions))
    expect(Array.from(a.yaw)).toEqual(Array.from(b.yaw))
    expect(Array.from(a.palette)).toEqual(Array.from(b.palette))
  })

  it('a different seed gives a different layout', () => {
    const map = flatMap(64, 255)
    const a = scatterProps(map, flatHeight(0.5), TERRAIN, PARAMS)
    const b = scatterProps(map, flatHeight(0.5), TERRAIN, { ...PARAMS, seed: 999 })
    expect(Array.from(a.positions)).not.toEqual(Array.from(b.positions))
  })

  it('density scales the population: a black map places nothing', () => {
    const none = scatterProps(flatMap(64, 0), flatHeight(0.5), TERRAIN, PARAMS)
    expect(none.count).toBe(0)
  })

  it('population rises with probabilityScale, monotonically', () => {
    const map = flatMap(64, 255)
    const counts = [0.05, 0.2, 0.8].map(
      (probabilityScale) =>
        scatterProps(map, flatHeight(0.5), TERRAIN, { ...PARAMS, probabilityScale }).count,
    )
    expect(counts[0]).toBeLessThan(counts[1] as number)
    expect(counts[1]).toBeLessThan(counts[2] as number)
  })

  it('places on the texel grid: every x and z is a multiple of terrainSize / width', () => {
    const size = 64
    const step = TERRAIN.terrainSize / size
    const p = scatterProps(flatMap(size, 255), flatHeight(0.5), TERRAIN, PARAMS)
    expect(p.count).toBeGreaterThan(0)
    for (let i = 0; i < p.count; i++) {
      const x = p.positions[i * 3] as number
      const z = p.positions[i * 3 + 2] as number
      expect(Math.abs(x / step - Math.round(x / step))).toBeLessThan(1e-4)
      expect(Math.abs(z / step - Math.round(z / step))).toBeLessThan(1e-4)
    }
  })

  it('SUBTRACTS heightOffset, so a negative offset raises the props', () => {
    const map = flatMap(32, 255)
    const base = scatterProps(map, flatHeight(0.5), TERRAIN, PARAMS)
    const raised = scatterProps(map, flatHeight(0.5), TERRAIN, { ...PARAMS, heightOffset: -2.6 })
    expect(raised.count).toBe(base.count)
    // Alpine's big-tree pass is -2.6 and the props must end up HIGHER.
    // 3 places, not 5: positions are Float32Array, so 2.6 stores as 2.59997558...
    expect((raised.positions[1] as number) - (base.positions[1] as number)).toBeCloseTo(2.6, 3)
  })

  it('keeps palette indices in range and scales inside [min, max]', () => {
    const p = scatterProps(flatMap(64, 255), flatHeight(0.5), TERRAIN, PARAMS)
    expect(p.count).toBeGreaterThan(0)
    for (let i = 0; i < p.count; i++) {
      expect(p.palette[i] as number).toBeGreaterThanOrEqual(0)
      expect(p.palette[i] as number).toBeLessThan(PARAMS.paletteSize)
      expect(p.scale[i] as number).toBeGreaterThanOrEqual(PARAMS.scaleMin)
      expect(p.scale[i] as number).toBeLessThanOrEqual(PARAMS.scaleMax)
    }
  })

  it('assigns each prop to the chunk its own position falls in', () => {
    const p = scatterProps(flatMap(64, 255), flatHeight(0.5), TERRAIN, PARAMS)
    for (let i = 0; i < p.count; i++) {
      const x = p.positions[i * 3] as number
      const z = p.positions[i * 3 + 2] as number
      const cx = Math.min(p.chunkPerSide - 1, Math.floor(x / TERRAIN.chunkSize))
      const cz = Math.min(p.chunkPerSide - 1, Math.floor(z / TERRAIN.chunkSize))
      expect(p.chunk[i]).toBe(cz * p.chunkPerSide + cx)
    }
  })

  it('applies the Unity import rescale: a 1025 map is sampled as 1024', () => {
    // 1025 with nPOTScale toNearest goes DOWN to 1024, so the step is
    // 4096/1024 = 4.0 m exactly — the arithmetic DEV-007 was about. If the
    // rescale were skipped the step would be 4096/1025 and nothing would land
    // on a 4 m multiple.
    const p = scatterProps(flatMap(1025, 255), flatHeight(0.5), TERRAIN, {
      ...PARAMS,
      probabilityScale: 0.02,
    })
    expect(p.count).toBeGreaterThan(0)
    for (let i = 0; i < p.count; i++) {
      const x = p.positions[i * 3] as number
      expect(Math.abs(x / 4 - Math.round(x / 4))).toBeLessThan(1e-4)
    }
  })
})

describe('shuffleByChunk', () => {
  it('is a permutation: every prop appears exactly once, in its own chunk', () => {
    const p = scatterProps(flatMap(64, 255), flatHeight(0.5), TERRAIN, PARAMS)
    const buckets = shuffleByChunk(p, 7)
    const seen = new Set<number>()
    let total = 0
    for (let c = 0; c < buckets.length; c++) {
      for (const idx of buckets[c] as Uint32Array) {
        expect(p.chunk[idx]).toBe(c)
        expect(seen.has(idx)).toBe(false)
        seen.add(idx)
        total++
      }
    }
    expect(total).toBe(p.count)
  })

  it('actually shuffles — the order is not the insertion order', () => {
    const p = scatterProps(flatMap(64, 255), flatHeight(0.5), TERRAIN, PARAMS)
    const buckets = shuffleByChunk(p, 7)
    const big = buckets.find((b) => b.length > 20)
    expect(big).toBeDefined()
    const sorted = Uint32Array.from(big as Uint32Array).sort()
    expect(Array.from(big as Uint32Array)).not.toEqual(Array.from(sorted))
  })

  it('is deterministic for a given seed', () => {
    const p = scatterProps(flatMap(64, 255), flatHeight(0.5), TERRAIN, PARAMS)
    const a = shuffleByChunk(p, 7).map((b) => Array.from(b))
    const b = shuffleByChunk(p, 7).map((x) => Array.from(x))
    expect(a).toEqual(b)
  })
})

const LOD = {
  lodDistance: 1000,
  transitionSeconds: 1,
  hysteresis: 0.03,
  scanIntervalSeconds: 1 / 30,
}

const oneChunk = (centreX: number, total = 100) => [{ total, centreX, centreZ: 0 }]

describe('prop LOD', () => {
  it('starts revealed when inside and hidden when outside', () => {
    expect(initPropLod(oneChunk(0), 0, 0, LOD).chunks[0]?.revealed).toBe(100)
    expect(initPropLod(oneChunk(5000), 0, 0, LOD).chunks[0]?.revealed).toBe(0)
  })

  it('ignores altitude — the camera Y is never an argument', () => {
    // 2016 zeroes deltaToChunk.y. Climbing must not cull the forest below, so
    // the API cannot even express an altitude. This asserts the shape.
    const rt = initPropLod(oneChunk(900), 0, 0, LOD)
    expect(rt.chunks[0]?.revealed).toBe(100)
    expect(initPropLod.length).toBe(4)
  })

  it('reveals gradually over transitionSeconds rather than popping', () => {
    const rt = initPropLod(oneChunk(5000), 0, 0, LOD)
    // Move the camera onto the chunk, then step in 1/60 slices.
    const seen: number[] = []
    for (let i = 0; i < 90; i++) {
      stepPropLod(rt, 5000, 0, LOD, 1 / 60)
      seen.push(rt.chunks[0]?.revealed as number)
    }
    expect(seen[0]).toBeLessThan(100) // did not pop in one frame
    expect(seen.at(-1)).toBe(100) // finished inside 1.5 s
    // and it climbed monotonically
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i] as number).toBeGreaterThanOrEqual(seen[i - 1] as number)
    }
  })

  it('does NOT flicker in the hysteresis dead band', () => {
    // Sit the camera between the on (970) and off (1030) edges. A chunk that
    // starts hidden must stay hidden; one that starts shown must stay shown.
    // Without FlipFlopPercent this is the case that toggles every scan.
    const hidden = initPropLod(oneChunk(5000), 0, 0, LOD)
    for (let i = 0; i < 200; i++) stepPropLod(hidden, 1000, 0, LOD, 1 / 60)
    expect(hidden.chunks[0]?.revealed).toBe(0)

    const shown = initPropLod(oneChunk(0), 0, 0, LOD)
    for (let i = 0; i < 200; i++) stepPropLod(shown, 1000, 0, LOD, 1 / 60)
    expect(shown.chunks[0]?.revealed).toBe(100)
  })

  it('hides gradually too, and reports only chunks that changed', () => {
    const rt = initPropLod(oneChunk(0), 0, 0, LOD)
    // The scan runs first and the reveal steps in the SAME call, so one frame
    // both starts the transition AND moves it. What must NOT happen is the
    // whole chunk vanishing in that frame.
    const changed = stepPropLod(rt, 5000, 0, LOD, 1 / 30)
    expect(changed).toEqual([0])
    expect(rt.chunks[0]?.revealed).toBeGreaterThan(0)
    expect(rt.chunks[0]?.revealed).toBeLessThan(100)
    let last = rt.chunks[0]?.revealed as number
    for (let i = 0; i < 90; i++) {
      stepPropLod(rt, 5000, 0, LOD, 1 / 60)
      const now = rt.chunks[0]?.revealed as number
      expect(now).toBeLessThanOrEqual(last)
      last = now
    }
    expect(last).toBe(0)
  })

  it('scans at 30 Hz, not every frame', () => {
    // Two frames at 1/60 do not reach the 1/30 interval on the first, so the
    // transition cannot have started after one.
    const rt = initPropLod(oneChunk(5000), 0, 0, LOD)
    stepPropLod(rt, 5000, 0, LOD, 1 / 120)
    expect(rt.chunks[0]?.transitioning).toBe(false)
    stepPropLod(rt, 5000, 0, LOD, 1 / 30)
    expect(rt.chunks[0]?.transitioning).toBe(true)
  })
})
