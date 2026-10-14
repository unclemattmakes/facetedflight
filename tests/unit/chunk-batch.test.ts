// tests/unit/chunk-batch.test.ts: the land's LOD batches (DEV-193's spike made a
// mode by DEV-904), proved without a GPU.
//
// Everything here is a MECHANISM, never a millisecond. The draw-call answer is
// `tests/e2e/chunk-batch.spec.ts`'s, counted on a frozen frame; what this file
// holds is the part that has to be true before any count means anything:
//
//  * a band is HOMOGENEOUS, which is what makes fixed-budget slots affordable;
//  * the batch draws with the material's own OBJECT, so the `onBeforeCompile`
//    stack (fog, far shadow, warp, gloss, lod-fade, fragment gates, point-light
//    scope, baked light) arrives intact;
//  * a LOD change is a SWAP into a reserved slot, not delete-and-add, because
//    three's `addGeometry` leaks the vertex range;
//  * every slot carries `ff2Direct` when the split bake is on, and a chunk that
//    does not match the band is REFUSED rather than thrown, so it draws alone;
//  * a band is sized from the ladder and the footprint, not from a number.
//
// The arithmetic is read out of the SIM generator rather than written down
// twice: `generateChunk` is the authority on how big a chunk at a LOD is, and a
// test that retyped `(32 + 2)^2 * 2 * 3` would pass for a build where the skirt
// had been removed (CLAUDE.md trap 24).

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { environmentTerrains, terrainParams } from '@/game/terrain/load-terrain'
import {
  bandCapacity,
  bandRenderOrder,
  type ChunkBandFlags,
  createChunkBatcher,
  geometryLayout,
} from '@/render/chunk-batch'
import { OCEAN_LATE_ORDER } from '@/render/draw-order'
import { chunkGeometry } from '@/render/terrain-mesh'
import { buildVertexGrid, generateChunk, type MapSampler } from '@/sim/terrain/faceted'

/**
 * Simonet's islands out of the GENERATED SHEET, never typed here: rule 3, and
 * the sizes this file is about are `chunkSize / baseResolution`, which is
 * exactly the pair that would go stale if somebody wrote them down.
 */
const params = terrainParams(environmentTerrains('simonet').land)

/**
 * A flat map. The geometry's SIZE is what this file is about, not its shape, and
 * a synthetic sampler keeps the suite off the gitignored Simonet PNGs: a test
 * that needs `pnpm assets:pull` is a test CI skips.
 */
const flatMap: MapSampler = {
  width: 1024,
  height: 1024,
  sample(_u, _v, out) {
    out.r = 0.5
    out.g = 0.5
    out.b = 0.5
  },
}

const grid = buildVertexGrid(flatMap, params)

const chunkAt = (cx: number, cy: number, lod: number, direct = false): THREE.BufferGeometry => {
  const geometry = chunkGeometry(generateChunk(grid, flatMap, flatMap, params, cx, cy, lod))
  if (direct) {
    // What the split bake adds (`render/baked-light.ts`, `DIRECT_ATTRIBUTE`): a
    // second vec3 per vertex. Filled with a value that names the chunk so a
    // copy into the wrong slot is visible.
    const count = (geometry.getAttribute('position') as THREE.BufferAttribute).count
    const array = new Float32Array(count * 3).fill(1 + cx * 16 + cy)
    geometry.setAttribute('ff2Direct', new THREE.BufferAttribute(array, 3))
  }
  return geometry
}

const vertsOf = (geometry: THREE.BufferGeometry): number =>
  (geometry.attributes.position as THREE.BufferAttribute).count

const terrainLike = (): THREE.Material =>
  new THREE.MeshPhysicalMaterial({ vertexColors: true, metalness: 0, side: THREE.FrontSide })

/** `render/shadows.ts`'s rule for a `terrain-chunk`, restated: LOD <= 0 casts, everything receives. */
const flagsOf = (lod: number): ChunkBandFlags => ({ cast: lod <= 0, receive: true })

const batcherFor = (material: THREE.Material, parent: THREE.Object3D, slots = 4) =>
  createChunkBatcher({
    material,
    parent,
    vertexCount: (lod) => (lod >= 0 && lod <= 2 ? vertsOf(chunkAt(0, 0, lod)) : null),
    capacity: () => slots,
    flags: flagsOf,
  })

describe('a band is homogeneous: the fact the whole design rests on', () => {
  it('every chunk at one LOD has the same vertex count, across the grid', () => {
    for (const lod of [0, 1, 2]) {
      const counts = new Set<number>()
      for (const [cx, cy] of [
        [0, 0],
        [7, 3],
        [15, 15],
        [4, 11],
      ] as const) {
        counts.add(vertsOf(chunkAt(cx, cy, lod)))
      }
      expect(counts.size, `LOD ${lod} produced ${counts.size} different vertex counts`).toBe(1)
    }
  })

  it('the LODs differ from each other, so a band per LOD separates them', () => {
    const counts = [0, 1, 2].map((lod) => vertsOf(chunkAt(0, 0, lod)))
    expect(new Set(counts).size).toBe(3)
    // Asserted as a RELATION, not as 6936/1944/600: the numbers move if
    // `baseResolution` ever does and the relation does not.
    expect(counts[0] as number).toBeGreaterThan(counts[1] as number)
    expect(counts[1] as number).toBeGreaterThan(counts[2] as number)
  })
})

describe('createChunkBatcher', () => {
  it('draws with the material OBJECT, so every onBeforeCompile patch survives', () => {
    const material = terrainLike()
    const group = new THREE.Group()
    const batcher = batcherFor(material, group)
    batcher.sync([{ id: 'chunk_0_0', lod: 1, geometry: chunkAt(0, 0, 1) }])
    const batches = group.children.filter((c) => (c as THREE.BatchedMesh).isBatchedMesh)
    expect(batches.length).toBe(1)
    // Identity, not equality: `Material.copy` carries neither `onBeforeCompile`
    // nor `customProgramCacheKey` and wipes `defines`, so a copy would lose the
    // stack silently. Identity is the one thing that cannot drift.
    expect((batches[0] as THREE.BatchedMesh).material).toBe(material)
    batcher.dispose()
  })

  it('builds one band per level asked for, placed or not, and names them plainly', () => {
    const group = new THREE.Group()
    const batcher = batcherFor(terrainLike(), group, 3)
    const placed = batcher.sync(
      [{ id: 'chunk_0_0', lod: 0, geometry: chunkAt(0, 0, 0) }],
      [0, 1, 2],
    )
    expect(placed.has('chunk_0_0')).toBe(true)
    const report = batcher.report()
    expect(report.bands.map((b) => b.lod)).toEqual([0, 1, 2])
    expect(report.bands.map((b) => b.used)).toEqual([1, 0, 0])
    expect(report.bands.every((b) => b.slots === 3)).toBe(true)
    // The census folds `chunks_batch_N` into the chunks row by this name.
    expect(report.bands.every((b) => /^chunks_batch_\d+$/.test(b.name))).toBe(true)
    batcher.dispose()
    expect(group.children.length).toBe(0)
  })

  it('every band shares one bounding sphere, so three draws them in creation order', () => {
    // three's opaque sort ends `z -> id`, and z is the clip depth of the object's
    // bounding sphere CENTRE. A sphere that moved with the slots a band holds
    // made the draw order of the bands a function of the frame (shaded overdraw
    // 1.30 unbatched against 2.39 batched on int_02_jumpSeat).
    const group = new THREE.Group()
    const batcher = batcherFor(terrainLike(), group, 3)
    const items = [
      { id: 'a', lod: 0, geometry: chunkAt(0, 0, 0) },
      { id: 'b', lod: 1, geometry: chunkAt(9, 9, 1) },
      { id: 'c', lod: 2, geometry: chunkAt(15, 3, 2) },
    ]
    batcher.sync(items, [0, 1, 2])
    const batches = group.children as THREE.BatchedMesh[]
    const first = (batches[0] as THREE.BatchedMesh).boundingSphere as THREE.Sphere
    expect(first).not.toBeNull()
    for (const b of batches) {
      expect((b.boundingSphere as THREE.Sphere).center.distanceTo(first.center)).toBe(0)
      expect((b.boundingSphere as THREE.Sphere).radius).toBe(first.radius)
    }
    // And a swap does not disturb it.
    batcher.place('a', 0, chunkAt(5, 5, 0))
    expect(((batches[0] as THREE.BatchedMesh).boundingSphere as THREE.Sphere).radius).toBe(
      first.radius,
    )
    // The sphere holds every chunk it was built from.
    for (const item of items) {
      const s = item.geometry.boundingSphere as THREE.Sphere
      expect(first.center.distanceTo(s.center) + s.radius).toBeLessThanOrEqual(first.radius + 1e-6)
    }
    // Creation order is finest first, which is the draw order of the ties.
    expect(batches.map((b) => b.name)).toEqual([
      'chunks_batch_0',
      'chunks_batch_1',
      'chunks_batch_2',
    ])
    batcher.dispose()
  })

  it('a LOD change is a SWAP into a reserved slot: no growth, no leak, slots come back', () => {
    const group = new THREE.Group()
    const batcher = batcherFor(terrainLike(), group, 3)
    batcher.sync([], [])
    const geometry = chunkAt(0, 0, 1)
    expect(batcher.place('a', 1, geometry)).toBe(true)
    const band = group.children[0] as THREE.BatchedMesh
    const reserved = vertsOf(band.geometry)
    // Many hand-overs through the same band. `deleteGeometry` + `addGeometry`
    // would walk `_nextVertexStart` off the end of the buffer after enough of
    // them (DEV-193 section 2b); a swap does not move it at all.
    for (let i = 0; i < 40; i++) {
      expect(batcher.place('a', 1, chunkAt(i % 16, 3, 1))).toBe(true)
      expect(batcher.place('b', 1, chunkAt(i % 16, 5, 1))).toBe(true)
      batcher.release('b')
    }
    expect(vertsOf(band.geometry)).toBe(reserved)
    expect(batcher.free(1)).toBe(2)
    batcher.dispose()
  })

  it('a full band refuses, counts it, and leaves the chunk to draw alone', () => {
    const group = new THREE.Group()
    const batcher = batcherFor(terrainLike(), group, 2)
    batcher.sync([], [])
    expect(batcher.place('a', 2, chunkAt(0, 0, 2))).toBe(true)
    expect(batcher.place('b', 2, chunkAt(1, 0, 2))).toBe(true)
    expect(batcher.place('c', 2, chunkAt(2, 0, 2))).toBe(false)
    expect(batcher.has('c')).toBe(false)
    expect(batcher.report().overflows).toBe(1)
    // Moving a chunk out frees the slot for the next one.
    batcher.release('a')
    expect(batcher.place('c', 2, chunkAt(2, 0, 2))).toBe(true)
    batcher.dispose()
  })

  it('refuses a level the terrain does not have', () => {
    const group = new THREE.Group()
    const batcher = batcherFor(terrainLike(), group)
    batcher.sync([], [])
    expect(batcher.place('a', 7, chunkAt(0, 0, 2))).toBe(false)
    expect(group.children.length).toBe(0)
    batcher.dispose()
  })

  it('a swapped-in chunk brings its own bounding sphere, so the cull still works', () => {
    const group = new THREE.Group()
    const batcher = batcherFor(terrainLike(), group, 2)
    batcher.sync([], [])
    const far = chunkAt(15, 15, 1)
    expect(batcher.place('far', 1, far)).toBe(true)
    const band = group.children[0] as THREE.BatchedMesh
    const sphere = new THREE.Sphere()
    band.getBoundingSphereAt(0, sphere)
    // The chunk's OWN sphere, not the batch's: `chunkGeometry` computes one and
    // `setGeometryAt` clones it. Compared against the geometry's, which is the
    // relationship rather than a coordinate typed twice.
    expect(sphere.center.distanceTo((far.boundingSphere as THREE.Sphere).center)).toBeLessThan(1e-3)
    expect(sphere.radius).toBeCloseTo((far.boundingSphere as THREE.Sphere).radius, 3)
    batcher.dispose()
  })

  it('follows the band flags: LOD 0 casts, coarser does not, and a switch moves them', () => {
    let on = true
    const group = new THREE.Group()
    const batcher = createChunkBatcher({
      material: terrainLike(),
      parent: group,
      vertexCount: (lod) => vertsOf(chunkAt(0, 0, lod)),
      capacity: () => 1,
      flags: (lod) => (on ? flagsOf(lod) : { cast: false, receive: false }),
    })
    batcher.sync([{ id: 'a', lod: 0, geometry: chunkAt(0, 0, 0) }], [0, 1])
    const [zero, one] = group.children as THREE.BatchedMesh[]
    expect([zero?.castShadow, one?.castShadow]).toEqual([true, false])
    on = false
    batcher.refreshFlags()
    expect([zero?.castShadow, zero?.receiveShadow]).toEqual([false, false])
    batcher.dispose()
  })
})

describe('the split bake: every slot carries ff2Direct', () => {
  it('copies the attribute into the slot it belongs to, and into no other', () => {
    const group = new THREE.Group()
    const batcher = batcherFor(terrainLike(), group, 3)
    const a = chunkAt(2, 1, 1, true)
    const b = chunkAt(5, 4, 1, true)
    batcher.sync(
      [
        { id: 'a', lod: 1, geometry: a },
        { id: 'b', lod: 1, geometry: b },
      ],
      [1],
    )
    const band = group.children[0] as THREE.BatchedMesh
    const direct = band.geometry.getAttribute('ff2Direct') as THREE.BufferAttribute
    expect(direct, 'the batch did not take ff2Direct').toBeDefined()
    const verts = vertsOf(a)
    // Slot 0 is `a`'s, slot 1 is `b`'s, slot 2 is empty and zero.
    expect(direct.getX(0)).toBe(1 + 2 * 16 + 1)
    expect(direct.getX(verts - 1)).toBe(1 + 2 * 16 + 1)
    expect(direct.getX(verts)).toBe(1 + 5 * 16 + 4)
    expect(direct.getX(2 * verts)).toBe(0)
    batcher.dispose()
  })

  it('refuses a chunk that lacks the attribute the band has, instead of throwing', () => {
    const group = new THREE.Group()
    const batcher = batcherFor(terrainLike(), group, 3)
    batcher.sync([{ id: 'a', lod: 1, geometry: chunkAt(0, 0, 1, true) }], [1])
    // three's `BatchedMesh._validateGeometry` throws on this; the batcher must
    // turn the throw into a `false`, because a throw inside the worker-arrival
    // path would take the frame loop with it.
    expect(() => batcher.place('b', 1, chunkAt(1, 0, 1, false))).not.toThrow()
    expect(batcher.place('b', 1, chunkAt(1, 0, 1, false))).toBe(false)
    expect(batcher.report().mismatches).toBeGreaterThan(0)
    batcher.dispose()
  })

  it('a rebuild picks up an attribute that appeared, and colours rewritten in place', () => {
    const group = new THREE.Group()
    const batcher = batcherFor(terrainLike(), group, 3)
    const geometry = chunkAt(3, 3, 1, false)
    batcher.sync([{ id: 'a', lod: 1, geometry }], [1])
    expect(
      (group.children[0] as THREE.BatchedMesh).geometry.getAttribute('ff2Direct'),
    ).toBeUndefined()

    // The bake turns on: the SAME geometry object gains an attribute and its
    // colours are rewritten in place. The batch holds a copy of both halves.
    const count = vertsOf(geometry)
    geometry.setAttribute(
      'ff2Direct',
      new THREE.BufferAttribute(new Float32Array(count * 3).fill(0.25), 3),
    )
    ;(geometry.getAttribute('color') as THREE.BufferAttribute).array.fill(0.5)

    // Before the rebuild the batch is stale, and that is the failure to prevent.
    expect(batcher.place('a', 1, geometry)).toBe(false)
    expect(batcher.report().mismatches).toBeGreaterThan(0)

    batcher.sync([{ id: 'a', lod: 1, geometry }], [1])
    const band = group.children[0] as THREE.BatchedMesh
    const direct = band.geometry.getAttribute('ff2Direct') as THREE.BufferAttribute
    expect(direct.getX(0)).toBe(0.25)
    expect((band.geometry.getAttribute('color') as THREE.BufferAttribute).getX(0)).toBeCloseTo(0.5)
    batcher.dispose()
  })

  it('geometryLayout tells the two apart', () => {
    expect(geometryLayout(chunkAt(0, 0, 1, true))).not.toBe(geometryLayout(chunkAt(0, 0, 1, false)))
    expect(geometryLayout(chunkAt(0, 0, 1, true))).toBe(geometryLayout(chunkAt(9, 9, 2, true)))
  })
})

describe('bandRenderOrder: where the bands draw among the opaques', () => {
  it('keeps the detail ring with the props and puts the rest after them, before the sea', () => {
    // Measured on five missions (DEV-904): the ring is the ground under the ship
    // and has to draw before the props it hides; LOD 0 and out gain from
    // drawing after them. The sea sits at OCEAN_LATE_ORDER and must stay later.
    expect(bandRenderOrder(-1)).toBe(0)
    for (const lod of [0, 1, 2]) {
      expect(bandRenderOrder(lod)).toBeGreaterThan(0)
      expect(bandRenderOrder(lod)).toBeLessThan(OCEAN_LATE_ORDER)
    }
  })

  it('is what a batcher gives each band unless told otherwise', () => {
    const group = new THREE.Group()
    const batcher = batcherFor(terrainLike(), group, 2)
    batcher.sync([{ id: 'a', lod: 0, geometry: chunkAt(0, 0, 0) }], [0, 1])
    expect((group.children as THREE.BatchedMesh[]).map((b) => b.renderOrder)).toEqual([
      bandRenderOrder(0),
      bandRenderOrder(1),
    ])
    batcher.dispose()
  })
})

describe('bandCapacity: sized from the ladder and the footprint', () => {
  // A row of ten chunks, 100 m each, in x.
  const chunks = Array.from({ length: 10 }, (_, cx) => ({ cx, cy: 0 }))
  const distanceTo = (cx: number, _cy: number, x: number): number =>
    Math.max(cx * 100 - x, 0, x - (cx + 1) * 100)
  const eyes = (): Array<[number, number]> => {
    const out: Array<[number, number]> = []
    for (let x = -500; x <= 1500; x += 50) out.push([x, 0])
    return out
  }

  it('is the most chunks any eye could put inside the band, times the margin', () => {
    // Within 150 m of the eye: at most the chunk it stands on and one each side
    // (a 100 m chunk 150 m away is wholly inside), measured rather than assumed.
    const need = bandCapacity(eyes(), chunks, distanceTo, (d) => d < 150, { ratio: 1, slots: 0 })
    expect(need).toBe(4)
    expect(bandCapacity(eyes(), chunks, distanceTo, (d) => d < 150, { ratio: 1.5, slots: 1 })).toBe(
      Math.ceil(4 * 1.5) + 1,
    )
  })

  it('is capped at the grid, and an unreachable band needs one slot at most', () => {
    expect(bandCapacity(eyes(), chunks, distanceTo, () => true, { ratio: 3, slots: 5 })).toBe(10)
    expect(bandCapacity(eyes(), chunks, distanceTo, () => false, { ratio: 1, slots: 0 })).toBe(0)
  })
})

describe('the bands never make three re-derive a program (DEV-921)', () => {
  const twoBands = () => {
    const group = new THREE.Group()
    const batcher = batcherFor(terrainLike(), group)
    batcher.sync(
      [
        { id: 'a', lod: 0, geometry: chunkAt(0, 0, 0) },
        { id: 'b', lod: 1, geometry: chunkAt(1, 0, 1) },
      ],
      [0, 1],
    )
    return { batcher, bands: group.children as THREE.BatchedMesh[] }
  }

  it('casts through ONE depth material of its own, a default MeshDepthMaterial like three’s', () => {
    // three's shared `_depthMaterial` flips its batching flag every time it
    // moves between a band and a plain caster, and each flip is a getProgram.
    const { batcher, bands } = twoBands()
    expect(bands).toHaveLength(2)
    const [a, b] = bands as [THREE.BatchedMesh, THREE.BatchedMesh]
    expect(a.customDepthMaterial).toBeInstanceOf(THREE.MeshDepthMaterial)
    expect(b.customDepthMaterial).toBe(a.customDepthMaterial)
    // Default in every field the depth program and its uniforms read, so the
    // same program draws the same depths (proved on the GPU in DEVIATIONS).
    const fresh = new THREE.MeshDepthMaterial()
    const depth = a.customDepthMaterial as THREE.MeshDepthMaterial
    for (const k of [
      'depthPacking',
      'opacity',
      'alphaTest',
      'displacementScale',
      'displacementBias',
    ] as const) {
      expect(depth[k], k).toBe(fresh[k])
    }
    expect(depth.map).toBeNull()
    expect(depth.alphaMap).toBeNull()
    expect(depth.displacementMap).toBeNull()
    batcher.dispose()
  })

  it('answers three’s colorTexture check with the batch’s real colours texture', () => {
    // three 0.185.1 reads `object.colorTexture`; BatchedMesh keeps
    // `_colorsTexture`. Without the getter, `undefined !== null` re-ran
    // getProgram on every draw of a band with no per-instance colour.
    const { batcher, bands } = twoBands()
    const band = bands[0] as THREE.BatchedMesh & { colorTexture: unknown; _colorsTexture: unknown }
    expect(band.colorTexture).toBeNull()
    expect(band.colorTexture).toBe(band._colorsTexture)
    band.setColorAt(0, new THREE.Color(1, 0, 0))
    expect(band.colorTexture).not.toBeNull()
    expect(band.colorTexture).toBe(band._colorsTexture)
    batcher.dispose()
  })
})
