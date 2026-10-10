// tests/unit/chunk-batch.test.ts — DEV-193's spike, proved without a GPU.
//
// Everything here is a MECHANISM, never a millisecond: perf-protocol §3a says a
// fan-out and a GPU measurement cannot share this box, and the draw-call half of
// DEV-193's question is answered by `tests/e2e/chunk-batch.spec.ts` counting a
// frozen frame. What this file holds is the part that has to be true before any
// count means anything —
//
//  * a band is HOMOGENEOUS, which is what makes fixed-budget slots affordable;
//  * the batch draws with the material's own OBJECT, so the `onBeforeCompile`
//    stack (fog, far shadow, warp, gloss, lod-fade, fragment gates, point-light
//    scope) arrives intact;
//  * a chunk mid-fade is refused, because one batch has one material;
//  * a LOD change is a SWAP into a reserved slot, not delete-and-add, because
//    three's `addGeometry` leaks the vertex range.
//
// The arithmetic is read out of the SIM generator rather than written down
// twice — `generateChunk` is the authority on how big a chunk at a LOD is, and a
// test that retyped `(32 + 2)^2 * 2 * 3` would pass for a build where the skirt
// had been removed (CLAUDE.md trap 24).

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { environmentTerrains, terrainParams } from '@/game/terrain/load-terrain'
import {
  batchKeyString,
  buildChunkBatches,
  CHUNK_FLOATS_PER_VERTEX,
  isBatchableChunk,
} from '@/render/chunk-batch'
import { OCEAN_LATE_ORDER } from '@/render/draw-order'
import { createLodFadePool } from '@/render/lod-fade'
import { chunkGeometry } from '@/render/terrain-mesh'
import { buildVertexGrid, generateChunk, type MapSampler } from '@/sim/terrain/faceted'

/**
 * Simonet's islands out of the GENERATED SHEET, never typed here — rule 3, and
 * the sizes this file is about are `chunkSize / baseResolution`, which is
 * exactly the pair that would go stale if somebody wrote them down.
 */
const params = terrainParams(environmentTerrains('simonet').land)

/**
 * A flat map. The geometry's SIZE is what this file is about, not its shape, and
 * a synthetic sampler keeps the suite off the gitignored Simonet PNGs — a test
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

const chunkAt = (cx: number, cy: number, lod: number): THREE.BufferGeometry =>
  chunkGeometry(generateChunk(grid, flatMap, flatMap, params, cx, cy, lod))

/** How many vertices a chunk geometry carries. */
const vertsOf = (geometry: THREE.BufferGeometry): number =>
  (geometry.attributes.position as THREE.BufferAttribute).count

const chunkMesh = (cx: number, cy: number, lod: number, material: THREE.Material): THREE.Mesh => {
  const mesh = new THREE.Mesh(chunkAt(cx, cy, lod), material)
  mesh.name = `chunk_${cx}_${cy}`
  // `render/shadows.ts`'s rule for a `terrain-chunk`, restated by the caller the
  // way `load-terrain.ts` does: LOD <= 0 casts, everything receives.
  mesh.castShadow = lod <= 0
  mesh.receiveShadow = true
  return mesh
}

const terrainLike = (): THREE.Material =>
  new THREE.MeshPhysicalMaterial({ vertexColors: true, metalness: 0, side: THREE.FrontSide })

describe('a band is homogeneous — the fact the whole design rests on', () => {
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

  it('the LODs differ from each other, so grouping on the count separates them', () => {
    const counts = [0, 1, 2].map((lod) => vertsOf(chunkAt(0, 0, lod)))
    expect(new Set(counts).size).toBe(3)
    // Coarser is smaller, and by a factor near four — the LOD stride halves the
    // quads per side. Asserted as a RELATION, not as 6936/1944/600: the numbers
    // move if `baseResolution` ever does and the relation does not.
    expect(counts[0] as number).toBeGreaterThan(counts[1] as number)
    expect(counts[1] as number).toBeGreaterThan(counts[2] as number)
  })
})

describe('buildChunkBatches', () => {
  it('folds a mixed grid into one batch per band and hides the meshes', () => {
    const material = terrainLike()
    const group = new THREE.Group()
    // 12 chunks over three bands, the shape §11's census reports: a few near, a
    // ring of middle, a lot of far.
    const plan: [number, number, number][] = [
      [0, 0, 0],
      [0, 1, 0],
      [1, 0, 0],
      [2, 2, 1],
      [2, 3, 1],
      [3, 2, 1],
      [3, 3, 1],
      [8, 8, 2],
      [8, 9, 2],
      [9, 8, 2],
      [9, 9, 2],
      [10, 10, 2],
    ]
    for (const [cx, cy, lod] of plan) group.add(chunkMesh(cx, cy, lod, material))

    const set = buildChunkBatches(group)
    expect(set).not.toBeNull()
    const batches = set as NonNullable<typeof set>

    expect(batches.bands).toHaveLength(3)
    expect(batches.folded).toBe(12)
    expect(batches.skipped).toBe(0)
    // Twelve draws became three OBJECTS. The draw-call claim itself belongs to
    // the e2e spec — this is the object count, which is what a unit test can
    // honestly see.
    expect(group.children.filter((c) => c.visible).length).toBe(3)
    for (const band of batches.bands) expect(band.batch.isBatchedMesh).toBe(true)

    // §9's second constraint: `castShadow` is per chunk and a batch has one.
    // The bands separate cleanly into casters and non-casters, so the flag can
    // live on the batch — which is the claim, tested where it could fail rather
    // than assumed.
    const casting = batches.bands.filter((b) => b.castShadow)
    expect(casting).toHaveLength(1)
    expect(casting[0]?.members).toBe(3)
    expect(casting[0]?.batch.castShadow).toBe(true)
    for (const band of batches.bands) {
      expect(band.batch.castShadow).toBe(band.castShadow)
      expect(band.batch.receiveShadow).toBe(band.receiveShadow)
    }

    // §9's third constraint: per-sub-geometry frustum culling, which is the one
    // thing a plain merged `BufferGeometry` cannot do.
    for (const band of batches.bands) expect(band.batch.perObjectFrustumCulled).toBe(true)

    batches.restore()
    expect(group.children.filter((c) => c.visible).length).toBe(12)
    expect(group.children.some((c) => (c as THREE.BatchedMesh).isBatchedMesh)).toBe(false)
  })

  it('draws with the material OBJECT, so every onBeforeCompile patch survives', () => {
    const material = terrainLike()
    // A stand-in for the whole stack `boot/app.ts` installs. What matters is
    // that the batch does not COPY: `Material.copy` carries neither
    // `onBeforeCompile` nor `customProgramCacheKey`, and `MeshStandardMaterial
    // .copy` resets `defines` to `{ STANDARD: '' }`.
    material.onBeforeCompile = () => {}
    material.defines = { ...(material.defines ?? {}), FF2_SENTINEL: '' }
    const group = new THREE.Group()
    group.add(chunkMesh(0, 0, 1, material))
    group.add(chunkMesh(0, 1, 1, material))

    const set = buildChunkBatches(group) as NonNullable<ReturnType<typeof buildChunkBatches>>
    const band = set.bands[0] as NonNullable<(typeof set.bands)[number]>
    // IDENTITY, not equality. A clone would pass a deep comparison of the
    // parameters and lose the two hooks and the defines in silence.
    expect(band.batch.material).toBe(material)
    expect(band.material).toBe(material)
    set.restore()
  })

  it('refuses a chunk mid-fade — one batch has one material (§9 constraint 1)', () => {
    const material = terrainLike()
    const pool = createLodFadePool()
    pool.applyTo(material)
    const pair = pool.acquire(material)
    expect(pair).not.toBeNull()

    const group = new THREE.Group()
    group.add(chunkMesh(0, 0, 1, material))
    group.add(chunkMesh(0, 1, 1, material))
    // The OUTGOING mesh of a live transition: still named `chunk_x_y`, now
    // carrying a pooled clone with its own `uLodFade`.
    const fading = chunkMesh(1, 1, 1, (pair as NonNullable<typeof pair>).outgoing)
    group.add(fading)

    expect(isBatchableChunk(fading)).toBe(false)
    const set = buildChunkBatches(group) as NonNullable<ReturnType<typeof buildChunkBatches>>
    expect(set.folded).toBe(2)
    expect(set.skipped).toBe(1)
    expect(set.bands).toHaveLength(1)
    // It goes on drawing exactly as it does today, which is §9's answer.
    expect(fading.visible).toBe(true)
    set.restore()
  })

  it('names bands by material, vertex count and both shadow flags', () => {
    const a = terrainLike()
    const b = terrainLike()
    const geometry = chunkAt(0, 0, 1)
    const count = vertsOf(geometry)
    const key = (material: THREE.Material, castShadow: boolean) =>
      batchKeyString({
        material,
        vertexCount: count,
        renderOrder: 0,
        castShadow,
        receiveShadow: true,
      })
    expect(key(a, true)).not.toBe(key(b, true))
    expect(key(a, true)).not.toBe(key(a, false))
  })
})

describe('the churn — a LOD change is a SWAP, never a delete', () => {
  it('reserves headroom slots and hands them out, then takes them back', () => {
    const material = terrainLike()
    const group = new THREE.Group()
    group.add(chunkMesh(0, 0, 1, material))
    group.add(chunkMesh(0, 1, 1, material))

    const set = buildChunkBatches(group, { headroom: 4 }) as NonNullable<
      ReturnType<typeof buildChunkBatches>
    >
    const band = set.bands[0] as NonNullable<(typeof set.bands)[number]>
    expect(band.members).toBe(2)
    expect(band.slots).toBe(6)
    expect(set.free(band.key)).toBe(4)
    expect(band.bytes).toBe(6 * band.vertexCount * CHUNK_FLOATS_PER_VERTEX * 4)

    // A chunk arrives in the band. The whole point: no allocation, no
    // `optimize()`, no growth in the reserved buffer.
    const before = vertsOf(band.batch.geometry)
    const slots: number[] = []
    for (let i = 0; i < 4; i++) {
      const slot = set.take(band.key, chunkAt(4 + i, 4, 1))
      expect(slot, `slot ${i} refused`).not.toBeNull()
      slots.push(slot as number)
    }
    expect(vertsOf(band.batch.geometry)).toBe(before)
    expect(set.free(band.key)).toBe(0)
    // Full. The overflow signal is `null`, which is the caller's cue to draw
    // that chunk on its own rather than to grow a buffer mid-flight.
    expect(set.take(band.key, chunkAt(5, 5, 1))).toBeNull()

    for (const slot of slots) set.give(band.key, slot)
    expect(set.free(band.key)).toBe(4)
    // And a returned slot is usable again — the steady state this design needs,
    // because `addGeometry` would have leaked the range every time.
    expect(set.take(band.key, chunkAt(6, 6, 1))).not.toBeNull()
    set.restore()
  })

  it('a swapped-in chunk brings its own bounding sphere, so the cull still works', () => {
    const material = terrainLike()
    const group = new THREE.Group()
    group.add(chunkMesh(0, 0, 1, material))
    const set = buildChunkBatches(group, { headroom: 1 }) as NonNullable<
      ReturnType<typeof buildChunkBatches>
    >
    const band = set.bands[0] as NonNullable<(typeof set.bands)[number]>
    const far = chunkAt(15, 15, 1)
    const slot = set.take(band.key, far) as number
    const sphere = new THREE.Sphere()
    band.batch.getBoundingSphereAt(slot, sphere)
    // The chunk's OWN sphere, not the batch's: `chunkGeometry` computes one and
    // `setGeometryAt` clones it. Compared against the geometry's, which is the
    // relationship rather than a coordinate typed twice.
    expect(sphere.center.distanceTo((far.boundingSphere as THREE.Sphere).center)).toBeLessThan(1e-3)
    expect(sphere.radius).toBeCloseTo((far.boundingSphere as THREE.Sphere).radius, 3)
    set.restore()
  })
})

// ─────────────────────────────────────────────────────────────────────────
// The regression that would look like a BETTER number
// ─────────────────────────────────────────────────────────────────────────
//
// Raised by the session that owns DEV-183, from a fact it had measured four
// ways that morning and this one had not: `int_01`'s sea at the frozen tick is
// **3 chunks at LOD 0 and 1 at LOD 1**, so folding by band gives exactly 2
// draws — which is what the spike reports.
//
// The trap is what a DIFFERENT number would have meant. `ocean 1` would be the
// two LOD bands merged into one draw and therefore **one `uFacet`** — precisely
// the bug DEV-183 exists to fix, re-introduced by a batching pass. `uFacet` is
// "one water quad in WORLD metres" and `render/water.ts` blends the derived
// normal toward vertical over `footprint / uFacet`; at LOD 0's value a 256 m far
// chunk flattens everywhere and loses its facet glint, which on `int_01`'s 4°
// sun is exactly where the glint band is.
//
// **And it would have read as a better result on every count-based check in
// this file** — fewer draws is the thing the fold is for. A metric moving the
// right way for the wrong reason is the hardest kind of regression to see, so
// the separation gets an assertion rather than being left as a property that
// happens to hold today.
//
// Unit, not e2e, deliberately: `pnpm e2e` never runs in CI, and this month's
// census defect survived for exactly that reason — its only guard lived in a
// spec nothing runs unattended.
describe('a batch key never merges two materials', () => {
  it('separates per-band water clones, which is what keeps uFacet per band', () => {
    // `water.ts`'s `materialFor` hands each LOD band its own clone so that
    // `uFacet` and `uTiltCos` can differ; the clones share a program by
    // delegating `customProgramCacheKey`, so they are DISTINCT OBJECTS that
    // hash alike. Only object identity separates them here.
    const lod0 = new THREE.MeshStandardMaterial({ name: 'water:facet32' })
    const lod1 = new THREE.MeshStandardMaterial({ name: 'water:facet64' })
    lod1.customProgramCacheKey = () => lod0.customProgramCacheKey()

    const band = (material: THREE.Material, vertexCount: number): string =>
      batchKeyString({
        material,
        vertexCount,
        renderOrder: 0,
        castShadow: false,
        receiveShadow: true,
      })

    // Same vertex count, same flags, same program key: only the material
    // differs, and that must be enough.
    expect(band(lod0, 2312)).not.toBe(band(lod1, 2312))
    // And the key is stable, or a band would split every frame.
    expect(band(lod0, 2312)).toBe(band(lod0, 2312))
  })

  it('separates two bands that sit at different places in the FRAME', () => {
    // DEV-241. `renderOrder` outranks `material.id` in three's opaque sort, so
    // two chunks at different orders are two positions in the frame — and a
    // `BatchedMesh` has ONE `renderOrder` for the whole batch, so folding
    // across it would pick one of the two and move the other without saying so.
    // The sea ships at `OCEAN_LATE_ORDER` and the land at three's 0; this is
    // what keeps the spike drawing the frame the game draws.
    const material = new THREE.MeshStandardMaterial()
    const key = (renderOrder: number): string =>
      batchKeyString({
        material,
        vertexCount: 6936,
        renderOrder,
        castShadow: false,
        receiveShadow: true,
      })
    expect(key(0)).not.toBe(key(OCEAN_LATE_ORDER))
    expect(key(OCEAN_LATE_ORDER)).toBe(key(OCEAN_LATE_ORDER))
  })

  it('separates a caster band from a non-caster band of the same material', () => {
    // 2016 casts from LOD 0 only (`FacetedTerrain.cs:721`) and DEV-115 extends
    // it to the LOD -1 ring, so "the band IS the flag" only holds while the
    // flag is IN the key. `BatchedMesh` has one `castShadow` for the whole
    // batch, so a merge across it would silently start or stop casting.
    const material = new THREE.MeshStandardMaterial()
    const key = (castShadow: boolean): string =>
      batchKeyString({
        material,
        vertexCount: 6936,
        renderOrder: 0,
        castShadow,
        receiveShadow: true,
      })
    expect(key(true)).not.toBe(key(false))
  })
})
