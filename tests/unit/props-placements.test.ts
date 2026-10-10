// tests/unit/props-placements.test.ts — the baked scatter round-trips.
//
// The bake exists so the three World Machine density maps never have to be
// served (O13 / C-6). That only holds if expanding a blob gives what running
// the scatter would have given — so the expectation here is `scatterProps`
// itself, never a recorded golden. A golden would be this implementation
// written twice (trap 24).
//
// Everything is synthesised in memory: no disk, no `describe.skipIf`, nothing
// that can rot into a silent skip.

import { describe, expect, it } from 'vitest'
import {
  decodeBase64,
  encodeBase64,
  encodePlacements,
  expandPlacements,
  PLACEMENT_STRIDE,
} from '@/sim/props/placements'
import { scatterProps } from '@/sim/props/scatter'
import type { ImageData8, MapSampler, Rgb } from '@/sim/terrain/image-sampler'

/** Power-of-two so no import rescale happens and texel indices stay comparable. */
const noiseMap = (size: number): ImageData8 => {
  const data = new Uint8Array(size * size)
  // A deterministic gradient with structure, so acceptance is not uniform and
  // a row-flip or an axis swap would show up as a different accepted set.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) data[y * size + x] = (x * 7 + y * 13) % 256
  }
  return { width: size, height: size, channels: 1, data }
}

/** A height map with relief, so `y` is a real function of (u, v) rather than a constant. */
const slopedHeight = (): MapSampler => ({
  width: 64,
  height: 64,
  sample: (u: number, v: number, out: Rgb) => {
    const h = Math.min(1, Math.max(0, 0.25 + 0.5 * u + 0.2 * v))
    out.r = h
    out.g = h
    out.b = h
  },
})

const TERRAIN = { terrainSize: 4096, terrainHeight: 1024, chunkSize: 512 }

// Alpine's two real generators. These are the numbers that make flattening
// dangerous, and they are why a blob belongs to an ENTRY and not to a level:
// the offsets are 7.6 m apart against terrain whose own jitter is 0.8 m.
const GEN0 = {
  probabilityScale: 0.03,
  heightOffset: -2.6,
  scaleMin: 6,
  scaleMax: 20,
  paletteSize: 10,
  seed: 1,
}
const GEN1 = {
  probabilityScale: 0.03,
  heightOffset: 5,
  scaleMin: 1.4,
  scaleMax: 5.5,
  paletteSize: 10,
  seed: 1 + 7919,
}

const roundTrip = (params: typeof GEN0, size = 128) => {
  const map = noiseMap(size)
  const height = slopedHeight()
  const scattered = scatterProps(map, height, TERRAIN, params)
  const blob = decodeBase64(encodeBase64(encodePlacements(scattered, params)))
  const expanded = expandPlacements(blob, { width: size, height: size }, height, TERRAIN, params)
  return { scattered, expanded, blob }
}

describe('a baked blob expands to what the scatter produced', () => {
  it.each([
    ['alpine gen0', GEN0],
    ['alpine gen1', GEN1],
  ])('%s: positions and chunks are EXACT', (_label, params) => {
    const { scattered, expanded } = roundTrip(params)

    expect(expanded.count).toBe(scattered.count)
    expect(scattered.count).toBeGreaterThan(50)

    // Not "close": a texel index is the integer the scatter looped on, so every
    // position is the same expression over the same input and must reproduce
    // bit-for-bit. A tolerance here would hide an off-by-one in the texel walk.
    expect(Array.from(expanded.positions)).toEqual(Array.from(scattered.positions))
    expect(Array.from(expanded.chunk)).toEqual(Array.from(scattered.chunk))
    expect(Array.from(expanded.palette)).toEqual(Array.from(scattered.palette))
    expect(Array.from(expanded.texel)).toEqual(Array.from(scattered.texel))
  })

  it.each([
    ['alpine gen0', GEN0],
    ['alpine gen1', GEN1],
  ])('%s: yaw and scale are within one quantisation step', (_label, params) => {
    const { scattered, expanded } = roundTrip(params)
    const yawStep = (Math.PI * 2) / 0xffff
    const scaleStep = (params.scaleMax - params.scaleMin) / 0xffff

    for (let i = 0; i < scattered.count; i++) {
      expect(Math.abs((expanded.yaw[i] ?? 0) - (scattered.yaw[i] ?? 0))).toBeLessThanOrEqual(
        yawStep,
      )
      expect(Math.abs((expanded.scale[i] ?? 0) - (scattered.scale[i] ?? 0))).toBeLessThanOrEqual(
        scaleStep,
      )
    }
  })

  it('is 9 bytes per placement and nothing else', () => {
    const { scattered, blob } = roundTrip(GEN0)
    expect(blob.length).toBe(scattered.count * PLACEMENT_STRIDE)
    expect(PLACEMENT_STRIDE).toBe(9)
  })
})

describe('the blob belongs to its generator, and using the wrong one is detectable', () => {
  // The mutation check. Without these, the round-trip above would pass just as
  // happily on a flattened format that threw the per-generator parameters away
  // — and alpine is the ONLY environment where that difference exists, so a
  // test that did not name alpine would be testing where both stories agree.

  it("gen1's heightOffset applied to gen0's blob moves every prop by 7.6 m", () => {
    const size = 128
    const height = slopedHeight()
    const scattered = scatterProps(noiseMap(size), height, TERRAIN, GEN0)
    const bytes = encodePlacements(scattered, GEN0)

    const wrong = expandPlacements(bytes, { width: size, height: size }, height, TERRAIN, {
      ...GEN0,
      heightOffset: GEN1.heightOffset,
    })

    // 4 places, not more: `positions` is a Float32Array, so a 7.6 m delta
    // carries ~6e-6 of storage error. Asking for 5 fails on the format rather
    // than on the claim.
    const delta = (wrong.positions[1] ?? 0) - (scattered.positions[1] ?? 0)
    expect(Math.abs(delta)).toBeCloseTo(Math.abs(GEN0.heightOffset - GEN1.heightOffset), 4)
    expect(Math.abs(delta)).toBeCloseTo(7.6, 4)
  })

  it("gen1's scale range applied to gen0's blob shrinks the big pass by about 4x", () => {
    const size = 128
    const height = slopedHeight()
    const scattered = scatterProps(noiseMap(size), height, TERRAIN, GEN0)
    const bytes = encodePlacements(scattered, GEN0)

    const wrong = expandPlacements(bytes, { width: size, height: size }, height, TERRAIN, {
      ...GEN0,
      scaleMin: GEN1.scaleMin,
      scaleMax: GEN1.scaleMax,
    })

    const mean = (a: Float32Array): number => a.reduce((s, v) => s + v, 0) / a.length
    expect(mean(scattered.scale) / mean(wrong.scale)).toBeGreaterThan(3)
  })

  it('a blob is not a multiple of the stride, and says so instead of guessing', () => {
    expect(() =>
      expandPlacements(
        new Uint8Array(10),
        { width: 64, height: 64 },
        slopedHeight(),
        TERRAIN,
        GEN0,
      ),
    ).toThrow(/not a multiple/)
  })
})

describe('base64 survives the sizes this actually uses', () => {
  it('round-trips a blob larger than the fromCharCode argument limit', () => {
    // 20,609 placements is 185 KB, and `String.fromCharCode(...bytes)` throws
    // somewhere north of 100k arguments. The chunking is load-bearing.
    const big = new Uint8Array(200_000)
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) % 256
    expect(Array.from(decodeBase64(encodeBase64(big)))).toEqual(Array.from(big))
  })
})
