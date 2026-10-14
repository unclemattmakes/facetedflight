// src/render/chunk-batch.ts : the land's chunk grid as one `BatchedMesh` per LOD.
// DEV-193 built it as a spike behind `?chunkBatch=1`; DEV-904 makes it the path
// the land is drawn by.
//
// ── Why ──────────────────────────────────────────────────────────────────
//
// After DEV-184 took `lod-fade.ts`'s `discard` out of the base material and
// DEV-192 took the cabin's dead point lights out of every world shader, the
// chunk grid flipped from fill-bound to DRAW-bound: ~1.16 ms fixed against
// 0.06 ms/Mpx of fill, and 201 of the frame's 263 calls (DEV-193 section 3).
// Next door DEV-118's instanced props carry 900 k triangles in nine draws and
// cost nothing. Geometry was never the problem; the draw count was.
//
// ── Why a band is the right unit, and it is a FACT not a choice ──────────
//
// `sim/terrain/faceted.ts` is `quadPerChunk = (chunkSize / baseResolution) >>
// lod` and `triCount = (quadPerChunk + 2)^2 * 2` (the +2 is the skirt ring), and
// the arrays are never truncated, so `chunkGeometry` emits exactly `triCount *
// 3` vertices. **Every chunk at one LOD is exactly the same size**, which is
// what makes `BatchedMesh`'s fixed per-geometry budgets affordable: a band is a
// fixed-stride array, slot `k` owns `vertexCount` vertices for the life of the
// batch, and a chunk arriving in the band is written over a free slot.
//
// ── The trap in `addGeometry`, which is why the churn path is a SWAP ─────
//
// three 0.185.1's `addGeometry` recycles a deleted geometry's ID and then
// allocates fresh space at `_nextVertexStart`, which only ever moves forward. So
// `deleteGeometry` + `addGeometry` LEAKS the vertex range, the buffer fills, it
// throws `Reserved space request exceeds the maximum buffer size`, and the only
// way back is `optimize()`. Simonet hands over ~10 chunks a second at 100 m/s.
// `setGeometryAt` into a pre-reserved slot does not move `_nextVertexStart`,
// uploads only that slot's sub-range and picks up the incoming geometry's own
// bounding sphere. So: reserve the slots once, swap geometry into them, never
// delete. `place` and `release` are that swap.
//
// ── What the batch draws with ────────────────────────────────────────────
//
// **The identical material object**, by reference. The terrain's base material
// carries a stack of `onBeforeCompile` patches whose install order matters
// (fog, far shadow, warp, gloss, lod-fade, fragment gates, point-light scope,
// baked light), and `Material.copy` carries neither the hook nor the cache key
// and WIPES `defines`, so a clone would lose all of it silently. three still
// compiles a second program for the batch because `batching` is bit 18 of the
// cache key; every band of one material shares that one program, so the cost is
// +1 program (plus the depth material's batched variant), not +1 per band.
//
// ── Who owns what ────────────────────────────────────────────────────────
//
// This module owns the batches and the slot arithmetic and knows nothing about
// LODs, fades or the worker. `game/terrain/load-terrain.ts` owns the chunks and
// decides when one is placed: a chunk is in a band while it is plain geometry
// at a settled LOD, and OUT of it while it cross-fades (DEV-130 gives each half
// of a fade its own pooled material clone carrying its own `uLodFade`, and one
// batch has one material), while it is excluded (the launch bore hides its
// chunks one by one, DEV-249) and while its band is full.
//
// A chunk that is not placed keeps drawing as its own mesh, exactly as before,
// so the failure mode of every limit here is "a few more draws", never "a hole".

import * as THREE from 'three'

/**
 * Where a land band sits among the opaques: `renderOrder` 0, interleaved with
 * the props by material id as the chunks always were, or {@link AFTER_PROPS},
 * after every object at 0 and before the sea's 1.
 *
 * Measured, not argued (DEV-904). three sorts `renderOrder -> material.id`, so
 * where the ground draws against the props decides how much of it they shade
 * over. Every subset of four bands was tried on five missions, shaded overdraw
 * of the same frozen frame:
 *
 *   hoverJet_kauai_beg    all at 0 1.327 · finest alone at 0, rest after 1.211
 *                         (unbatched 1.242)
 *   rookie_02_jumpSeat    all at 0 1.247 · detail ring after 2.011
 *   int_01_jumpSeat       all at 0 1.169 · detail ring after 1.894
 *
 * The detail ring (LOD -1) is the ground under the ship: it has to draw BEFORE
 * the props, or the props behind it are shaded and then covered. The bands
 * from LOD 0 out gain on Kauai and cost nothing on the jumpSeat missions when
 * they draw after the props. So the ring stays at 0 and the rest follow it.
 */
export const AFTER_PROPS = 0.001

/** The default place of a band, by LOD. */
export const bandRenderOrder = (lod: number): number => (lod < 0 ? 0 : AFTER_PROPS)

/** What a band casts and receives. `load-terrain.ts` derives it from `shadowFlagsFor`. */
export interface ChunkBandFlags {
  readonly cast: boolean
  readonly receive: boolean
}

export interface ChunkBatcherOptions {
  /** The terrain's base material, by reference. See the header. */
  readonly material: THREE.Material
  /** Where the batches hang: the terrain group. */
  readonly parent: THREE.Object3D
  /**
   * Vertices in one chunk at `lod`, or null for a level this terrain does not
   * have. Asked of the sim's own arithmetic by the caller, so this module never
   * restates the skirt.
   */
  readonly vertexCount: (lod: number) => number | null
  /** Slots to reserve for `lod`. The sizing is the caller's, from a measurement. */
  readonly capacity: (lod: number) => number
  /** Cast and receive flags for a band, read fresh by `refreshFlags`. */
  readonly flags: (lod: number) => ChunkBandFlags
  /** The band for `lod`'s place in the frame. Defaults to {@link bandRenderOrder}. */
  readonly renderOrder?: (lod: number) => number
}

/** A chunk offered to `sync`. */
export interface ChunkBatchItem {
  readonly id: string
  readonly lod: number
  readonly geometry: THREE.BufferGeometry
}

export interface ChunkBandReport {
  readonly lod: number
  readonly name: string
  readonly vertexCount: number
  /** Slots reserved. */
  readonly slots: number
  /** Slots holding a chunk right now. */
  readonly used: number
  /** `slots * vertexCount * floatsPerVertex * 4`, the GPU buffer this band holds. */
  readonly bytes: number
  readonly castShadow: boolean
  readonly receiveShadow: boolean
}

export interface ChunkBatchReport {
  readonly bands: readonly ChunkBandReport[]
  /** Chunks currently drawn through a band. */
  readonly placed: number
  /** Total reserved vertex bytes, all bands. */
  readonly bytes: number
  /** `place` calls refused because the band was full. Should stay 0 for ever. */
  readonly overflows: number
  /** `place` calls refused because the geometry did not fit the band's layout. */
  readonly mismatches: number
}

export interface ChunkBatcher {
  /**
   * Put a chunk's geometry in the band for `lod`. True when it is now drawn by
   * the band; false when it is not, in which case the caller keeps drawing the
   * chunk as its own mesh. Replaces any earlier placement of `id`.
   */
  place(id: string, lod: number, geometry: THREE.BufferGeometry): boolean
  /** Take a chunk out of its band. A no-op for one that is not in one. */
  release(id: string): void
  has(id: string): boolean
  /**
   * Who is in which slot: band name, slot (equal to the batch's instance and
   * geometry id, which are allocated in step) and the chunk's id. For a spec to
   * name the chunk behind an instance; nothing in the game reads it.
   */
  occupants(): readonly { readonly band: string; readonly slot: number; readonly id: string }[]
  /**
   * Rebuild every band from `items` and return the ids that are placed.
   *
   * The first build, and the answer to anything that rewrites the chunk
   * geometries in place: the baked light adds, rewrites and deletes the
   * `ff2Direct` attribute and recolours every vertex, and a batch holds its own
   * COPY of the data. A batch that kept its old copy would draw yesterday's
   * lighting, or no `ff2Direct` at all and a ground that reads zero sun.
   *
   * `levels` are the LODs to have a band for whether or not a chunk is in one
   * yet, so every band exists (and has been drawn once) under the curtain
   * rather than being allocated in flight.
   */
  sync(items: Iterable<ChunkBatchItem>, levels?: readonly number[]): ReadonlySet<string>
  /** Re-read each band's cast and receive flags. */
  refreshFlags(): void
  /** Free slots in a band, for the spec and the overflow decision. */
  free(lod: number): number
  report(): ChunkBatchReport
  /** Remove every batch and free its buffers. */
  dispose(): void
}

/** Floats per vertex in a chunk geometry, REPORTED only: nothing depends on it. */
const REPORT_FLOATS_PER_VERTEX = 11

interface Band {
  readonly lod: number
  readonly batch: THREE.BatchedMesh
  readonly vertexCount: number
  readonly layout: string
  readonly geometryIds: number[]
  readonly instanceIds: number[]
  readonly free: number[]
  used: number
}

/**
 * The attribute set a batch was built from, as a string.
 *
 * `BatchedMesh` throws on a geometry missing an attribute the batch has
 * (`_validateGeometry`), and the split bake's `ff2Direct` comes and goes with
 * the rung. Comparing layouts BEFORE `setGeometryAt` turns that throw into a
 * `false`, which the caller answers by drawing the chunk alone.
 */
export const geometryLayout = (geometry: THREE.BufferGeometry): string => {
  const names = Object.keys(geometry.attributes).sort()
  return names
    .map((name) => {
      const a = geometry.getAttribute(name)
      return `${name}:${a.itemSize}${a.normalized ? 'n' : ''}:${a.array.constructor.name}`
    })
    .join(',')
}

/** A zeroed geometry with `source`'s attribute layout and `vertexCount` vertices. */
const blankLike = (source: THREE.BufferGeometry, vertexCount: number): THREE.BufferGeometry => {
  const blank = new THREE.BufferGeometry()
  for (const name of Object.keys(source.attributes)) {
    const a = source.getAttribute(name)
    const Ctor = a.array.constructor as new (n: number) => Float32Array
    blank.setAttribute(
      name,
      new THREE.BufferAttribute(new Ctor(vertexCount * a.itemSize), a.itemSize, a.normalized),
    )
  }
  return blank
}

export const createChunkBatcher = (options: ChunkBatcherOptions): ChunkBatcher => {
  const bands = new Map<number, Band>()
  const placements = new Map<string, { band: Band; slot: number }>()
  let overflows = 0
  let mismatches = 0
  let serial = 0
  /**
   * One sphere over the whole grid, shared by every band (see `sync`). null until
   * the first `sync`, when each band computes its own from what it holds.
   */
  let footprint: THREE.Sphere | null = null

  /**
   * DEV-921: the bands' own shadow depth material, a default one exactly like
   * three's. Without it every caster shares three's single `_depthMaterial`, and
   * a material drawn for a `BatchedMesh` and then for a plain mesh fails
   * `setProgram`'s batching check each time it changes hands: twice a frame
   * (the bands, then the ship and landmarks, then the bands), each a full
   * `getProgram` of about 85 us measured on `int_02_hoverJet`. One that only
   * ever draws batched never changes hands. Same program key, so nothing new
   * compiles; three's per-draw copying (side, maps, clipping) applies to a
   * `customDepthMaterial` the same way.
   */
  const depthMaterial = new THREE.MeshDepthMaterial()

  const applyFlags = (band: Band): void => {
    const flags = options.flags(band.lod)
    band.batch.castShadow = flags.cast
    band.batch.receiveShadow = flags.receive
  }

  /** Build the band for `lod` with `sample`'s layout, or null for a level that does not exist. */
  const createBand = (lod: number, sample: THREE.BufferGeometry): Band | null => {
    const vertexCount = options.vertexCount(lod)
    if (vertexCount === null || vertexCount <= 0) return null
    const slots = Math.max(1, Math.floor(options.capacity(lod)))
    // ZERO index budget: these are non-indexed soup (the faceted look needs
    // fully split vertices) and `_initializeGeometry` only builds an index when
    // the reference has one.
    const batch = new THREE.BatchedMesh(slots, slots * vertexCount, 0, options.material)
    // The name is plain on purpose: `boot/render-census.ts` folds a
    // `world-terrain` child's name into its row key.
    batch.name = `chunks_batch_${serial++}`
    batch.renderOrder = (options.renderOrder ?? bandRenderOrder)(lod)
    batch.customDepthMaterial = depthMaterial
    // DEV-921: three 0.185.1's `setProgram` asks `object.colorTexture`, which
    // `BatchedMesh` never defines (it keeps `_colorsTexture`), so for a program
    // built without batch colours `undefined !== null` fails the check and
    // every draw re-runs `getProgram`. Answering with the real field makes the
    // check mean what it says; the value is the one three's own
    // `getParameters` reads, so no program changes.
    Object.defineProperty(batch, 'colorTexture', {
      configurable: true,
      get(this: { _colorsTexture: THREE.DataTexture | null }) {
        return this._colorsTexture
      },
    })
    // Culls each sub-geometry against its own sphere, which is what the
    // individual meshes got. The default, said out loud.
    batch.perObjectFrustumCulled = true
    // ── the bands' draw ORDER is decided here, and by nothing else ──────
    //
    // three sorts opaques `renderOrder -> material.id -> z -> id`, and an
    // object's z is the clip depth of its BOUNDING SPHERE'S CENTRE. A band's own
    // sphere is the union of the slots it holds (plus the zeroed free ones), so it
    // moved with every swap and the bands drew in whatever order their centres
    // happened to fall: measured on `int_02_jumpSeat`, shaded overdraw 1.30
    // unbatched against 2.39 batched, and 1.88 against 1.66 on two
    // consecutive folds of the same frame. One shared sphere makes z a tie, and
    // the tie goes to `id`: creation order, which `sync` makes finest first
    // (the detail ring, then LOD 0, 1, 2), the nearest ground drawn first.
    if (footprint) batch.boundingSphere = footprint.clone()
    const reference = blankLike(sample, vertexCount)
    const geometryIds: number[] = []
    const instanceIds: number[] = []
    const free: number[] = []
    for (let i = 0; i < slots; i++) {
      const geometryId = batch.addGeometry(reference, vertexCount)
      const instanceId = batch.addInstance(geometryId)
      batch.setVisibleAt(instanceId, false)
      geometryIds.push(geometryId)
      instanceIds.push(instanceId)
    }
    // Lowest slot out first, so a band fills from the front and a report reads
    // as a prefix.
    for (let i = slots - 1; i >= 0; i--) free.push(i)
    reference.dispose()
    const band: Band = {
      lod,
      batch,
      vertexCount,
      layout: geometryLayout(sample),
      geometryIds,
      instanceIds,
      free,
      used: 0,
    }
    applyFlags(band)
    options.parent.add(batch)
    bands.set(lod, band)
    return band
  }

  const release = (id: string): void => {
    const placed = placements.get(id)
    if (!placed) return
    placements.delete(id)
    const { band, slot } = placed
    band.batch.setVisibleAt(band.instanceIds[slot] as number, false)
    band.free.push(slot)
    band.used--
    if (!footprint) band.batch.boundingSphere = null
  }

  const place = (id: string, lod: number, geometry: THREE.BufferGeometry): boolean => {
    release(id)
    const band = bands.get(lod) ?? createBand(lod, geometry)
    if (!band) return false
    const position = geometry.getAttribute('position')
    if (
      !position ||
      position.count !== band.vertexCount ||
      geometryLayout(geometry) !== band.layout
    ) {
      mismatches++
      return false
    }
    const slot = band.free.pop()
    if (slot === undefined) {
      overflows++
      return false
    }
    // The worker measures the sphere (DEV-242); computing it here when it did not
    // keeps `setGeometryAt` from deriving one from the batch's own buffer.
    if (geometry.boundingSphere === null) geometry.computeBoundingSphere()
    band.batch.setGeometryAt(band.geometryIds[slot] as number, geometry)
    band.batch.setVisibleAt(band.instanceIds[slot] as number, true)
    if (!footprint) band.batch.boundingSphere = null
    band.used++
    placements.set(id, { band, slot })
    return true
  }

  const dropAll = (): void => {
    for (const band of bands.values()) {
      band.batch.removeFromParent()
      band.batch.dispose()
    }
    bands.clear()
    placements.clear()
  }

  return {
    place,
    release,
    has: (id) => placements.has(id),
    occupants: () =>
      [...placements].map(([id, p]) => ({ band: p.band.batch.name, slot: p.slot, id })),

    sync(items, levels = []) {
      const list = [...items]
      dropAll()
      // The grid's sphere, with a tenth to spare for a finer LOD's skirt. Used
      // for the batch-level cull too, where being larger only means "not culled
      // as a whole"; the per-instance cull still runs against each chunk's own.
      footprint = null
      for (const item of list) {
        if (item.geometry.boundingSphere === null) item.geometry.computeBoundingSphere()
        const sphere = item.geometry.boundingSphere as THREE.Sphere
        if (footprint === null) footprint = sphere.clone()
        else footprint.union(sphere)
      }
      if (footprint) footprint.radius *= 1.1
      const first = list[0]
      if (first) {
        // A band for every level asked for, before any chunk is placed, so the
        // layout comes from a real geometry and the allocation is done now.
        for (const lod of levels) if (!bands.has(lod)) createBand(lod, first.geometry)
      }
      const placed = new Set<string>()
      for (const item of list) if (place(item.id, item.lod, item.geometry)) placed.add(item.id)
      return placed
    },

    refreshFlags() {
      for (const band of bands.values()) applyFlags(band)
    },

    free: (lod) => bands.get(lod)?.free.length ?? 0,

    report() {
      const rows = [...bands.values()]
        .sort((a, b) => a.lod - b.lod)
        .map((band) => ({
          lod: band.lod,
          name: band.batch.name,
          vertexCount: band.vertexCount,
          slots: band.geometryIds.length,
          used: band.used,
          bytes: band.geometryIds.length * band.vertexCount * REPORT_FLOATS_PER_VERTEX * 4,
          castShadow: band.batch.castShadow,
          receiveShadow: band.batch.receiveShadow,
        }))
      return {
        bands: rows,
        placed: placements.size,
        bytes: rows.reduce((n, r) => n + r.bytes, 0),
        overflows,
        mismatches,
      }
    },

    dispose: () => {
      dropAll()
      depthMaterial.dispose()
    },
  }
}

/**
 * Slots a band needs so that no eye position can overflow it. DEV-904.
 *
 * `eyes` are sample points over (and around) the terrain, `chunks` the chunks'
 * distances to a point come from `distanceTo`. For every eye the chunks that
 * COULD be at `lod` are counted, hysteresis included, and the answer is the
 * largest count plus a margin for the frames a chunk spends waiting on the
 * worker. Derived from the ladder and the footprint, never typed: a ladder that
 * changes in the sheet changes this with it.
 */
export const bandCapacity = (
  eyes: Iterable<readonly [number, number]>,
  chunks: ReadonlyArray<{ readonly cx: number; readonly cy: number }>,
  distanceTo: (cx: number, cy: number, x: number, z: number) => number,
  inBand: (distance: number) => boolean,
  margin: { readonly ratio: number; readonly slots: number },
): number => {
  let most = 0
  for (const [x, z] of eyes) {
    let n = 0
    for (const c of chunks) if (inBand(distanceTo(c.cx, c.cy, x, z))) n++
    if (n > most) most = n
  }
  return Math.min(chunks.length, Math.ceil(most * margin.ratio) + margin.slots)
}
