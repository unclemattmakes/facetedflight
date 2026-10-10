// tests/unit/terrain-lod.test.ts — LOD band selection, and the flip-flop it
// exists to prevent.

import { describe, expect, it } from 'vitest'
import { TERRAIN } from '@/generated/constants.generated'
import {
  type ChunkFootprint,
  chunkFootprintDistance,
  horizontalDistance,
  initialLod,
  lodBands,
  selectLod,
} from '@/sim/terrain/lod'

const ISLANDS = TERRAIN.simonet.terrains.islands
const bands = lodBands(ISLANDS.lodDistance, ISLANDS.lodLevels, ISLANDS.flipFlopPercent)

describe('the bands come from the sheet', () => {
  it('doubles per level, starting at LODDistance', () => {
    expect(ISLANDS.lodDistance).toBe(1024)
    expect(ISLANDS.lodLevels).toBe(3)
    expect(bands.distances).toEqual([1024, 2048, 4096])
    expect(bands.hysteresis).toBeCloseTo(0.03, 6)
  })

  it('gives the ocean six levels from a wider base', () => {
    const ocean = TERRAIN.simonet.terrains.ocean
    const oceanBands = lodBands(ocean.lodDistance, ocean.lodLevels, ocean.flipFlopPercent)
    expect(oceanBands.distances.length).toBe(6)
    expect(oceanBands.distances[0]).toBe(1800)
    expect(oceanBands.distances[5]).toBe(1800 * 2 ** 5)
  })
})

describe('distance is horizontal', () => {
  it('ignores altitude entirely', () => {
    // `deltaToChunk.y = 0.0f`. Climbing straight up over the island must not
    // coarsen the ground beneath you.
    expect(horizontalDistance(0, 0, 300, 400)).toBeCloseTo(500, 6)
    // y is not a parameter at all, which is the point — there is no way to
    // accidentally pass it.
    expect(horizontalDistance(0, 0, 0, 1024)).toBeCloseTo(1024, 6)
  })
})

describe('initial selection', () => {
  it('picks the band the distance falls in', () => {
    expect(initialLod(bands, 0)).toBe(0)
    expect(initialLod(bands, 1024)).toBe(0)
    expect(initialLod(bands, 1025)).toBe(1)
    expect(initialLod(bands, 2048)).toBe(1)
    expect(initialLod(bands, 2049)).toBe(2)
    expect(initialLod(bands, 99999)).toBe(2)
  })
})

describe('hysteresis — the flip-flop the field is named after', () => {
  it('steps out only past the band plus 3%', () => {
    // 1024 * 1.03 = 1054.72
    expect(selectLod(bands, 1054, 0)).toBe(0)
    expect(selectLod(bands, 1055, 0)).toBe(1)
  })

  it('steps back in only below the previous band minus 3%', () => {
    // 1024 * 0.97 = 993.28
    expect(selectLod(bands, 994, 1)).toBe(1)
    expect(selectLod(bands, 993, 1)).toBe(0)
  })

  it('holds a chunk sitting exactly on a boundary', () => {
    // This is the whole reason hysteresis exists: without it, a chunk parked at
    // 1024 m swaps its mesh every frame and the terrain shimmers.
    let lod = 0
    for (let i = 0; i < 50; i++) lod = selectLod(bands, 1024, lod)
    expect(lod).toBe(0)

    lod = 1
    for (let i = 0; i < 50; i++) lod = selectLod(bands, 1024, lod)
    expect(lod).toBe(1)
  })

  it('leaves a dead band that neither direction crosses', () => {
    // Between 993.28 and 1054.72 nothing moves, whichever level you are on.
    for (const d of [1000, 1024, 1050]) {
      expect(selectLod(bands, d, 0)).toBe(0)
      expect(selectLod(bands, d, 1)).toBe(1)
    }
  })
})

describe('stepping', () => {
  it('moves one level at a time, however far the camera jumped', () => {
    // A teleport across the map walks its chunks in over successive frames
    // instead of rebuilding everything in one, which bounds the worst frame.
    expect(selectLod(bands, 1e6, 0)).toBe(1)
    expect(selectLod(bands, 1e6, 1)).toBe(2)
    expect(selectLod(bands, 1e6, 2)).toBe(2)
    expect(selectLod(bands, 0, 2)).toBe(1)
    expect(selectLod(bands, 0, 1)).toBe(0)
    expect(selectLod(bands, 0, 0)).toBe(0)
  })

  it('settles from any start within lodLevels calls', () => {
    for (const distance of [0, 500, 1500, 3000, 99999]) {
      let lod = 2
      for (let i = 0; i < bands.distances.length; i++) lod = selectLod(bands, distance, lod)
      // Whatever it settles on, another pass must not move it.
      expect(selectLod(bands, distance, lod)).toBe(lod)
    }
  })

  it('clamps a nonsense current level rather than indexing off the end', () => {
    expect(selectLod(bands, 0, 99)).toBe(1)
    expect(selectLod(bands, 1e6, -5)).toBe(1)
  })
})

// ── The ocean was never drawing at LOD0, and the chunk CENTRE is why ──────
//
// Matt: *"the ocean isn't nearly dense enough, especially compared to the
// screenshots and the terrain."* The mesh was not the problem. The distance
// test was: 2016 measures to `chunk.Renderers[0].bounds.center`, and an ocean
// chunk is 8,192 m across.
describe('chunkFootprintDistance', () => {
  /** The shipped Simonet ocean: 1024 mesh units at a scale of 8. */
  const OCEAN: ChunkFootprint = {
    originX: 0,
    originZ: 0,
    scaleX: 8,
    scaleZ: 8,
    chunkSize: 1024,
  }
  const SIDE = 8192

  it('is ZERO when the point is over the chunk', () => {
    // The whole bug in one assertion. Standing in the middle of chunk (0,0),
    // the centre test reports 0 — but stand at a CORNER and it reports 5.8 km.
    expect(chunkFootprintDistance(OCEAN, 0, 0, SIDE / 2, -SIDE / 2)).toBe(0)
    expect(chunkFootprintDistance(OCEAN, 0, 0, 10, -10)).toBe(0)
    expect(chunkFootprintDistance(OCEAN, 0, 0, SIDE - 10, -10)).toBe(0)
  })

  it('costs the ocean three LOD bands where the centre test is used', () => {
    // At a corner of the chunk you are standing on: the footprint says 0, the
    // centre says the half-diagonal. Against `lodDistance` 1800 that is the
    // difference between LOD0 and LOD2.
    const centre = horizontalDistance(SIDE / 2, -SIDE / 2, 0, 0)
    expect(centre).toBeCloseTo((SIDE / 2) * Math.SQRT2, 3)
    const bands = lodBands(1800, 6, 0.03)
    expect(initialLod(bands, chunkFootprintDistance(OCEAN, 0, 0, 0, 0))).toBe(0)
    expect(initialLod(bands, centre)).toBeGreaterThanOrEqual(2)
  })

  it('changes almost nothing for the ISLANDS, which is why it is safe', () => {
    // 256 m chunks against an LOD distance of 1024: the centre is at most 181 m
    // out, well inside one band. The fix is aimed at the ocean and the land
    // barely notices.
    const land: ChunkFootprint = {
      originX: 0,
      originZ: 0,
      scaleX: 1,
      scaleZ: 1,
      chunkSize: 256,
    }
    const bands = lodBands(1024, 3, 0.03)
    for (const d of [0, 300, 900, 1500, 2500]) {
      const foot = initialLod(bands, chunkFootprintDistance(land, 0, 0, d + 128, -128))
      const cent = initialLod(bands, horizontalDistance(128, -128, d + 128, -128))
      expect(Math.abs(foot - cent), `at ${d} m`).toBeLessThanOrEqual(1)
    }
  })

  it('mirrors z the way chunkGeometry does, or the sea coarsens as you approach', () => {
    // `chunkGeometry` flips mesh z into world z, so chunk (0,1) lives at
    // NEGATIVE world z. Getting the sign wrong puts the footprint on the far
    // side of the origin, and the LOD then improves as you fly AWAY.
    expect(chunkFootprintDistance(OCEAN, 0, 1, 100, -SIDE - 100)).toBe(0)
    expect(chunkFootprintDistance(OCEAN, 0, 1, 100, SIDE + 100)).toBeGreaterThan(SIDE)
  })

  it('applies the SCALE to a chunk that is not the first one', () => {
    // Found by mutation: every other case here sits at chunk x = 0, where
    // `scaleX * 0 * chunkSize` is zero however wrong the scale is. Chunk (3, 2)
    // spans x 24,576..32,768 and z -16,384..-24,576 on an 8x plate.
    expect(chunkFootprintDistance(OCEAN, 3, 2, 3 * SIDE + 10, -2 * SIDE - 10)).toBe(0)
    expect(chunkFootprintDistance(OCEAN, 3, 2, 4 * SIDE - 10, -3 * SIDE + 10)).toBe(0)
    // Just outside on each side, by a round number.
    expect(chunkFootprintDistance(OCEAN, 3, 2, 3 * SIDE - 500, -2 * SIDE - 10)).toBeCloseTo(500, 6)
    expect(chunkFootprintDistance(OCEAN, 3, 2, 4 * SIDE + 500, -2 * SIDE - 10)).toBeCloseTo(500, 6)
    // And a point at chunk 0 is a whole three chunks away, not adjacent.
    expect(chunkFootprintDistance(OCEAN, 3, 2, 0, -2 * SIDE - 10)).toBeCloseTo(3 * SIDE, 6)
  })

  it('grows linearly once you are clear of the footprint', () => {
    expect(chunkFootprintDistance(OCEAN, 0, 0, -500, -100)).toBeCloseTo(500, 6)
    expect(chunkFootprintDistance(OCEAN, 0, 0, SIDE + 500, -100)).toBeCloseTo(500, 6)
    // Diagonal, off a corner.
    expect(chunkFootprintDistance(OCEAN, 0, 0, -300, 400)).toBeCloseTo(Math.hypot(300, 400), 6)
  })
})
