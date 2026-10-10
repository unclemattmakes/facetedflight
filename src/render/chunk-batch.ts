// src/render/chunk-batch.ts — the chunk grid as one `BatchedMesh` per LOD band.
// DEV-193, and it is a SPIKE: off by default, behind `?chunkBatch=1`, and it
// answers three questions with counts rather than shipping a rewrite.
//
// ── The question ─────────────────────────────────────────────────────────
//
// `docs/plan/VR-PERF-WAVE-2-WORK.md` §11.7 item 1. After DEV-184 took
// `lod-fade.ts`'s `discard` out of the base material and DEV-192 took the
// cabin's dead point lights out of every world shader, the chunk grid flipped
// from fill-bound to DRAW-bound: 1.16 ms fixed against 0.06 ms/Mpx of fill, and
// 201 of the frame's 263 calls. Next door, DEV-118's instanced props carry
// 900 k triangles in nine draws and measure at nothing. **Geometry was never
// the problem here; the draw count is.**
//
// §9 sketched `THREE.BatchedMesh`, one batch per LOD band. Nobody had
// established that it FITS. This module is the test of that, and every claim it
// makes is a count a spec can read back.
//
// ── Why a band is the right unit, and it is a FACT not a choice ──────────
//
// `sim/terrain/faceted.ts:221` is `quadPerChunk = (chunkSize / baseResolution)
// >> lod` and `triCount = (quadPerChunk + 2)^2 * 2` — the +2 being the skirt
// ring — and the arrays are allocated at `triCount * 9` and never truncated, so
// `chunkGeometry` always emits exactly `triCount * 3` vertices.
//
// **Every chunk at one LOD has exactly the same vertex count.** That single
// fact is what makes a batch affordable, because `BatchedMesh` reserves FIXED
// per-geometry budgets and a heterogeneous batch has to be repacked. A
// homogeneous band is a fixed-stride array: slot `k` owns
// `vertexCount` vertices for the life of the batch, and a chunk arriving in the
// band writes over a free slot with `setGeometryAt`.
//
// ── The trap in `addGeometry`, which is why the churn path is a SWAP ─────
//
// `BatchedMesh.addGeometry` (three 0.185.1, `:626`) recycles the deleted
// geometry **ID** out of `_availableGeometryIds` and then allocates fresh space
// at `_nextVertexStart`, which only ever moves forward. So
// `deleteGeometry` + `addGeometry` LEAKS the vertex range: the buffer fills up
// and throws `Reserved space request exceeds the maximum buffer size` after
// enough churn, and the only way back is `optimize()`, which repacks the whole
// buffer.
//
// A terrain hands over ~10 chunks a second at the 1,024 m band at 100 m/s, so a
// design that leaks per hand-over is a design that repacks a 24 MB buffer every
// few seconds. `setGeometryAt` on a pre-reserved slot does not move
// `_nextVertexStart` at all, writes only that slot's sub-range
// (`addUpdateRange`, `:764`), and picks up the incoming geometry's own
// `boundingSphere` for the per-instance cull. So: **reserve the slots once,
// swap geometry into them, never delete.** A band the chunk has left is a slot
// returned to a free list with its instance hidden.
//
// ── What a batch must NOT lose ───────────────────────────────────────────
//
// The terrain's base material carries a stack of `onBeforeCompile` patches whose
// INSTALL ORDER matters (`boot/app.ts` sets it): Unity fog, `far-shadow.ts`'s
// far-field sun term, the illustrative warp, the surface gloss, `lod-fade.ts`'s
// gated `discard`, DEV-191's `fragment-gates.ts` and DEV-192's
// `point-light-scope.ts`. A batch that got a FRESH material would silently lose
// all of it — and `Material.copy` does not carry `onBeforeCompile` or
// `customProgramCacheKey` and WIPES `defines`, so a clone would lose it too.
//
// So the batch draws with **the identical material object**, by reference. Not a
// copy, not a clone. three still compiles a second program for it, because
// `batching` is bit 18 of `getProgramCacheKeyBooleans`
// (`WebGLPrograms.js`) — that is correct and it is the cost: **+1 program per
// batched material**, compiled once, with the same patched source text.
// `tests/unit/chunk-batch.test.ts` asserts the identity rather than the
// behaviour, because identity is the only thing that cannot drift.
//
// ── What decides a batch, and it is deliberately not "the LOD" ───────────
//
// The key is `(material, vertexCount, castShadow, receiveShadow)` — the four
// things one `BatchedMesh` can only have one of. It is derived from the MESHES,
// not from a `lod` field this module would have to be told.
//
// That is the point. §9's claim is *"the band IS the flag"*: LOD <= 0 casts,
// LOD >= 1 does not (`render/shadows.ts`'s `shadowFlagsFor`, 2016's
// `FacetedTerrain.cs:721`, extended to the LOD -1 ring by DEV-115). If the claim
// is true, grouping on the shadow flags and the vertex count yields exactly one
// group per band and nothing else. If it is false — if one band ever holds two
// different cast flags, or two vertex counts — this grouping SAYS SO, by
// producing more groups than there are bands. A key that read `slot.lod` would
// have assumed the answer instead of measuring it. (CLAUDE.md trap 24: assert
// the relationship, not the value.)
//
// ── What this module does NOT do, and it is not an oversight ─────────────
//
// **A fading chunk is left alone.** `lod-fade.ts` gives each of a transition's
// two meshes its own pooled material CLONE carrying its own `uLodFade`, and one
// batch has one material, so a fading chunk cannot be in a batch. §9's answer is
// to draw it on its own for the 0.6-1 s of the fade — which is what already
// happens here for free, because a fade clone fails the `material` half of the
// batch key and a mesh that is not in a batch keeps drawing exactly as it does
// today. The cost is a handful of extra calls, not 146.

import * as THREE from 'three'
import { lodFadeUniformOf } from '@/render/lod-fade'

/** The four things one `BatchedMesh` can only have one of. */
export interface ChunkBatchKey {
  readonly material: THREE.Material
  readonly vertexCount: number
  readonly castShadow: boolean
  readonly receiveShadow: boolean
  /**
   * The chunks' own `renderOrder`. DEV-241.
   *
   * In the key because it is in three's opaque sort AHEAD of `material.id`, so
   * two chunks at different orders are two positions in the frame and folding
   * them into one `BatchedMesh` would pick one of the two and silently move the
   * other. Today it separates nothing — a terrain's chunks are all at 0 and the
   * SEA's are all at `OCEAN_LATE_ORDER` — and that is the point: the band it
   * builds for the sea has to carry the 1, or the spike would hand the ocean
   * back to `material.id` and undo the default it is measuring against.
   */
  readonly renderOrder: number
}

/**
 * A short, stable serial per material — so a band key is readable in a log.
 *
 * A `WeakMap` rather than `material.uuid`, which is 36 characters and turns a
 * printed band list into noise, and rather than `material.id`, which three's
 * typings do not expose. It is per session and that is all it has to be: the key
 * exists to GROUP within one fold and to be legible in the report.
 */
const materialSerial = new WeakMap<THREE.Material, number>()
let nextMaterialSerial = 1

/**
 * A chunk mesh's batch key as a string, for grouping.
 *
 * A string rather than a tuple because it is what a spec prints, and a printed
 * band list is the evidence for the paragraph above — *"three bands, and their
 * cast flags separate"* is a claim a reader can check.
 */
export const batchKeyString = (key: ChunkBatchKey): string => {
  let serial = materialSerial.get(key.material)
  if (serial === undefined) {
    serial = nextMaterialSerial++
    materialSerial.set(key.material, serial)
  }
  return `m${serial}/v${key.vertexCount}/${key.castShadow ? 'cast' : 'nocast'}/${
    key.receiveShadow ? 'recv' : 'norecv'
  }/o${key.renderOrder}`
}

/** Is this object a chunk mesh this module is willing to batch? */
export const isBatchableChunk = (object: THREE.Object3D): object is THREE.Mesh => {
  const mesh = object as THREE.Mesh
  if (!mesh.isMesh) return false
  // A batch has ONE material. An array material is a mesh with draw groups and
  // this module has no business folding one.
  if (Array.isArray(mesh.material)) return false
  const geometry = mesh.geometry
  if (!geometry?.attributes.position) return false
  // `chunkGeometry` emits non-indexed soup and `BatchedMesh` demands
  // consistency (`BatchedMesh.js:423`), not the absence of an index. Mixing is
  // what it refuses, so the filter is "no index" rather than "an index".
  if (geometry.index !== null) return false
  // Anything that is not at the identity is not a chunk of THIS grid — the
  // generator offsets its vertices by the chunk origin itself, so every chunk
  // mesh sits at its parent's origin. A mesh with its own transform would need
  // `setMatrixAt` to carry it, which is supported, but it is also the tell that
  // this is not the object we think it is.
  if (!(mesh.position.lengthSq() === 0 && mesh.scale.x === 1 && mesh.quaternion.w === 1)) {
    return false
  }
  // ── a chunk MID-FADE is not batchable, and this is the test that says so ──
  //
  // §9 called it the first of the three constraints: a fading chunk needs its
  // OWN `uLodFade`, one batch has one material, so it has to be drawn alone for
  // the 0.6-1 s of its transition. `lod-fade.ts` keeps each clone's uniform in a
  // `WeakMap` and `lodFadeUniformOf` is the lookup — so "is this material a fade
  // clone" is asked of the module that knows, rather than guessed from a name or
  // inferred from the material id.
  //
  // Without it the exclusion would still half-happen, and silently: a clone is a
  // distinct `material.id`, so each fading chunk would get a batch OF ONE, which
  // is strictly worse than the mesh it replaced and would read as a band in the
  // output. The right answer is to leave it exactly as it is drawn today.
  return lodFadeUniformOf(mesh.material as THREE.Material) === undefined
}

/** A chunk mesh of the grid, by name. `load-terrain.ts` names them. */
export const isChunkName = (name: string): boolean => /^chunk_\d+_\d+$/.test(name)

export interface ChunkBatchBand {
  readonly key: string
  readonly material: THREE.Material
  readonly vertexCount: number
  readonly castShadow: boolean
  readonly receiveShadow: boolean
  /** Chunks folded into this batch at build time. */
  readonly members: number
  /** Slots reserved — `members` plus headroom. */
  readonly slots: number
  /** `slots * vertexCount * 11 * 4`, the GPU buffer this band holds. */
  readonly bytes: number
  readonly batch: THREE.BatchedMesh
}

export interface ChunkBatchSet {
  readonly bands: readonly ChunkBatchBand[]
  /** Chunk meshes folded in, across every band. */
  readonly folded: number
  /** Chunk meshes left drawing on their own — fade clones, and anything odd. */
  readonly skipped: number
  /** Total reserved vertex bytes, all bands. */
  readonly bytes: number
  /**
   * Move a chunk into a band's free slot, the way a LOD change would.
   *
   * The churn path §9 left open, and the whole reason this is a swap rather
   * than a delete — see the header. Returns the slot, or null when the band is
   * full, which is the caller's signal to draw that chunk on its own.
   */
  take(key: string, geometry: THREE.BufferGeometry): number | null
  /** Give a slot back: the instance goes invisible and the slot is reusable. */
  give(key: string, slot: number): void
  /** Free slots in a band, for the spec and for the overflow decision. */
  free(key: string): number
  /** Put the individual chunk meshes back and drop the batches. */
  restore(): void
}

/**
 * Floats per vertex in a chunk geometry: position 3, normal 3, color 3, uv 2.
 * Used only to REPORT the buffer size a band reserves; nothing depends on it.
 */
export const CHUNK_FLOATS_PER_VERTEX = 11

/**
 * Fold a terrain group's chunk meshes into one `BatchedMesh` per band.
 *
 * Returns null when there is nothing to fold, so a caller can say "no" without
 * a special case. The individual meshes are hidden rather than removed: this is
 * a spike and `restore()` has to put the frame back exactly.
 *
 * `headroom` is extra slots per band, and it is the budget question made
 * explicit. A band sized to exactly its current members cannot accept a single
 * hand-over; a band sized for the whole grid reserves the whole grid. The
 * default of 0 is the honest floor — build it, count it, and let the spec
 * choose what to reserve.
 */
export const buildChunkBatches = (
  group: THREE.Object3D,
  options: { readonly headroom?: number } = {},
): ChunkBatchSet | null => {
  const headroom = Math.max(0, Math.floor(options.headroom ?? 0))
  const groups = new Map<string, { key: ChunkBatchKey; meshes: THREE.Mesh[] }>()
  let skipped = 0
  for (const child of group.children) {
    // Only a mesh whose name says it is a chunk. `boot/app.ts` parents the
    // PROP group under the terrain group (DEV-089) and a fade's `:incoming`
    // mesh hangs here too; folding either would be this module deciding
    // something that is not its business.
    if (!isChunkName(child.name)) continue
    if (!isBatchableChunk(child)) {
      // A chunk this module refused — mid-fade, or a shape it does not
      // recognise. Counted, because *"146 became 3"* is only true if nothing was
      // quietly left behind still drawing.
      skipped++
      continue
    }
    const mesh = child
    const material = mesh.material as THREE.Material
    const vertexCount = (mesh.geometry.attributes.position as THREE.BufferAttribute).count
    const key: ChunkBatchKey = {
      material,
      vertexCount,
      renderOrder: mesh.renderOrder,
      castShadow: mesh.castShadow,
      receiveShadow: mesh.receiveShadow,
    }
    const id = batchKeyString(key)
    const bucket = groups.get(id) ?? { key, meshes: [] }
    bucket.meshes.push(mesh)
    groups.set(id, bucket)
  }
  if (groups.size === 0) return null

  const bands: ChunkBatchBand[] = []
  const hidden: THREE.Mesh[] = []
  /** Per band: the free slot list and the slot -> instance map. */
  const state = new Map<string, { band: ChunkBatchBand; free: number[]; instance: number[] }>()

  let bandIndex = 0
  for (const [id, bucket] of groups) {
    const slots = bucket.meshes.length + headroom
    const vertexCount = bucket.key.vertexCount
    const batch = new THREE.BatchedMesh(
      slots,
      slots * vertexCount,
      // ZERO index budget. `_initializeGeometry` (`BatchedMesh.js:400`) only
      // builds an index buffer when the reference geometry has one, and these
      // never do — the faceted look requires fully split vertices. Letting the
      // default `maxVertexCount * 2` stand would reserve nothing, because the
      // branch is never taken, but 0 says so out loud.
      0,
      bucket.key.material,
    )
    // ── the NAME is read by the census, so it is plain ────────────────────
    //
    // `boot/render-census.ts`'s `rowKey` folds a `world-terrain` child's own
    // name into the row, and the band key carries `/` characters that would
    // turn one row into something that reads like a path. An index here and the
    // full key in the report: `chunks_batch_0` groups under the prefix the
    // chunks row already has, which is what makes a before/after diff legible.
    batch.name = `chunks_batch_${bandIndex++}`
    batch.castShadow = bucket.key.castShadow
    batch.receiveShadow = bucket.key.receiveShadow
    // The members' own place in the frame (DEV-241). Every member of a band
    // carries the same one — it is in the key — so there is one right answer
    // and this is it. Without it the sea's band would fold back to 0 and the
    // spike would be measuring a frame the game does not draw.
    batch.renderOrder = bucket.key.renderOrder
    // The batch's own sphere is computed from the ACTIVE instances
    // (`BatchedMesh.computeBoundingSphere`), and `Frustum.intersectsObject`
    // finds it because `BatchedMesh` declares `boundingSphere` — so the coarse
    // cull is correct without help. `perObjectFrustumCulled` is three's default
    // and is the one that matters: it culls each sub-geometry against its own
    // sphere, which is what the individual meshes get today.
    batch.perObjectFrustumCulled = true
    const freeSlots: number[] = []
    const instance: number[] = []
    for (let i = 0; i < slots; i++) {
      const mesh = bucket.meshes[i]
      // Every slot is reserved at the band's vertex count, occupied or not —
      // that is what makes the swap possible later. An empty slot is given the
      // first member's geometry and then hidden, because `addGeometry` needs a
      // reference geometry and a band is homogeneous so any member will do.
      const reference = mesh?.geometry ?? (bucket.meshes[0] as THREE.Mesh).geometry
      // `reservedVertexCount` explicit, `reservedIndexCount` left at its default:
      // `addGeometry` reads the index budget only `if (hasIndex)`
      // (`BatchedMesh.js:656`) and these geometries never have one, so any value
      // passed there is discarded. Saying 0 would look like a decision.
      const geometryId = batch.addGeometry(reference, vertexCount)
      const instanceId = batch.addInstance(geometryId)
      instance.push(instanceId)
      if (!mesh) {
        batch.setVisibleAt(instanceId, false)
        freeSlots.push(geometryId)
        continue
      }
      // The chunk's vertices are already in world space relative to the group
      // (`load-terrain.ts` adds the mesh with no transform), so the instance
      // matrix is the identity `addInstance` already set.
      hidden.push(mesh)
      mesh.visible = false
    }
    batch.computeBoundingSphere()
    group.add(batch)
    const band: ChunkBatchBand = {
      key: id,
      material: bucket.key.material,
      vertexCount,
      castShadow: bucket.key.castShadow,
      receiveShadow: bucket.key.receiveShadow,
      members: bucket.meshes.length,
      slots,
      bytes: slots * vertexCount * CHUNK_FLOATS_PER_VERTEX * 4,
      batch,
    }
    bands.push(band)
    state.set(id, { band, free: freeSlots, instance })
  }

  return {
    bands,
    folded: hidden.length,
    skipped,
    bytes: bands.reduce((n, b) => n + b.bytes, 0),

    take(key, geometry) {
      const entry = state.get(key)
      if (!entry) return null
      const slot = entry.free.pop()
      if (slot === undefined) return null
      // The band is homogeneous, so this fits by construction — and if it does
      // not, `setGeometryAt` throws rather than drawing something wrong, which
      // is the behaviour to want.
      entry.band.batch.setGeometryAt(slot, geometry)
      const instanceId = entry.instance[slot] as number
      entry.band.batch.setVisibleAt(instanceId, true)
      // The batch grew, so its coarse sphere is stale. Null asks three to
      // recompute on the next `intersectsObject`.
      entry.band.batch.boundingSphere = null
      return slot
    },

    give(key, slot) {
      const entry = state.get(key)
      if (!entry || entry.free.includes(slot)) return
      const instanceId = entry.instance[slot]
      if (instanceId === undefined) return
      entry.band.batch.setVisibleAt(instanceId, false)
      entry.free.push(slot)
      entry.band.batch.boundingSphere = null
    },

    free(key) {
      return state.get(key)?.free.length ?? 0
    },

    restore() {
      for (const band of bands) {
        band.batch.removeFromParent()
        band.batch.dispose()
      }
      for (const mesh of hidden) mesh.visible = true
    },
  }
}
