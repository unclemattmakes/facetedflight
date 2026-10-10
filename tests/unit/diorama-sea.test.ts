// tests/unit/diorama-sea.test.ts: a level table's sea is the SEA, not the
// bottom of the height map (DEV-579).
//
// `render/diorama.ts` drew everything at or under its waterline as sea, and
// took the land field's origin for the waterline. That origin is the bottom of
// the height map. On Simonet it is 198 m under the water, so the table had no
// sea at all and drew the seabed as land in the seabed's dark colours; DEV-140's
// holo lean painted those a pale teal that passed for water until DEV-579 took
// the lean away. The waterline is now the ocean's own surface over the island
// (`game/mission-shape.ts`, `seaLevelOver`), and this file measures what the
// table DRAWS with it, against the real maps where they are on disk.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { seaLevelOver } from '@/game/mission-shape'
import { createDiorama, SEA_TINT } from '@/render/diorama'
import { buildHeightField } from '@/sim/terrain/height-field'
import type { MapSampler } from '@/sim/terrain/image-sampler'
import { fieldFor, haveMaps, loadLevelJson, oceanFieldFor } from './helpers/terrain-field'

const SEA = new THREE.Color(SEA_TINT)

/** The share of the table's cells (six vertices each) drawn in the sea tint. */
const seaShare = (d: ReturnType<typeof createDiorama>): number => {
  const mesh = d.object.getObjectByName('diorama-island') as THREE.Mesh
  const col = mesh.geometry.attributes.color as THREE.BufferAttribute
  let sea = 0
  let cells = 0
  for (let i = 0; i < col.count; i += 6) {
    cells++
    if (
      Math.abs(col.getX(i) - SEA.r) < 1e-4 &&
      Math.abs(col.getY(i) - SEA.g) < 1e-4 &&
      Math.abs(col.getZ(i) - SEA.b) < 1e-4
    ) {
      sea++
    }
  }
  return sea / cells
}

const flat = (value: number): MapSampler => ({
  width: 4,
  height: 4,
  sample(_u, _v, out) {
    out.r = value
    out.g = value
    out.b = value
  },
})

/** A ramp from 0 at u = 0 to 1 at u = 1: half the map under any mid sea. */
const ramp: MapSampler = {
  width: 64,
  height: 64,
  sample(u, _v, out) {
    out.r = u
    out.g = u
    out.b = u
  },
}

const params = {
  terrainSize: 4096,
  terrainHeight: 400,
  chunkSize: 256,
  baseResolution: 16,
  randomOffset: 0,
  seed: 1,
}

describe('the waterline is the sea’s, wherever it is handed one', () => {
  it('seaLevelOver reads the water field over the land’s square', () => {
    const land = buildHeightField(ramp, params, { position: [0, 0, 0], scale: [1, 1, 1] })
    // Water at a flat 0.5 of 400 m, standing 10 m up.
    const water = buildHeightField(flat(0.5), params, { position: [0, 10, 0], scale: [1, 1, 1] })
    expect(seaLevelOver(land, water)).toBeCloseTo(210, 3)
  })

  it('a table handed a sea level draws the land under it as sea, flat at its origin', () => {
    const land = buildHeightField(ramp, params, { position: [0, 0, 0], scale: [1, 1, 1] })
    const none = createDiorama({ field: land, palette: flat(0.4), route: null, size: 0.5 })
    const sea = createDiorama({
      field: land,
      palette: flat(0.4),
      route: null,
      size: 0.5,
      seaLevel: 200,
    })
    // The ramp's own origin is its lowest point, so without a sea level only
    // the cells right at u = 0 are sea; with one at half height, about half.
    expect(seaShare(none)).toBeLessThan(0.05)
    expect(seaShare(sea)).toBeGreaterThan(0.4)
    expect(seaShare(sea)).toBeLessThan(0.6)
    expect(sea.frame.seaY).toBe(200)
    const pos = (sea.object.getObjectByName('diorama-island') as THREE.Mesh).geometry.attributes
      .position as THREE.BufferAttribute
    let lowest = Infinity
    for (let i = 0; i < pos.count; i++) lowest = Math.min(lowest, pos.getY(i))
    // The sea is the model's origin, as `peakUnder`'s note says it is.
    expect(lowest).toBeCloseTo(0, 9)
    none.dispose()
    sea.dispose()
  })
})

describe('the two islands have a sea on their tables (real maps)', () => {
  // The disk work is inside each `it`, so a tree without the maps (CI) skips
  // rather than throwing at collection.
  it.skipIf(!haveMaps)(
    'Simonet and Kauai: the sea stands near 116.6 m, over the land’s origin',
    () => {
      for (const id of ['int_01_hoverJet', 'hoverJet_kauai_beg']) {
        const level = loadLevelJson(id)
        const land = fieldFor(level)
        const water = oceanFieldFor(level)
        expect(water, id).not.toBeNull()
        const y = seaLevelOver(land, water as NonNullable<typeof water>)
        expect(y, id).toBeGreaterThan(114)
        expect(y, id).toBeLessThan(118)
        expect(y, id).toBeGreaterThan(land.originY)
      }
    },
  )

  it.skipIf(!haveMaps)(
    'Simonet’s table had NO sea on the land’s origin, and has one on the sea’s',
    () => {
      const level = loadLevelJson('int_01_hoverJet')
      const land = fieldFor(level)
      const water = oceanFieldFor(level) as NonNullable<ReturnType<typeof oceanFieldFor>>
      const before = createDiorama({ field: land, palette: flat(0.4), route: null, size: 0.5 })
      const after = createDiorama({
        field: land,
        palette: flat(0.4),
        route: null,
        size: 0.5,
        seaLevel: seaLevelOver(land, water),
      })
      expect(seaShare(before)).toBe(0)
      // An archipelago: more sea than land on the disc.
      expect(seaShare(after)).toBeGreaterThan(0.5)
      before.dispose()
      after.dispose()
    },
  )

  it.skipIf(haveMaps)('the real-map half is SKIPPED on this tree (no terrain maps on disk)', () => {
    expect(haveMaps).toBe(false)
  })
})
