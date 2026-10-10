// src/game/terrain/terrain.worker.ts — chunk generation, off the main thread.
//
// A PLAIN Worker with transferable `ArrayBuffer`s. Explicitly NOT
// `SharedArrayBuffer`: that needs COOP/COEP headers, which would break R2 asset
// fetches and buy nothing, since the generator produces buffers once and hands
// them over rather than sharing mutable state (PORT_PLAN §2.4 / D7).
//
// polyfish shipped a `SharedArrayBuffer` physics worker that almost certainly
// never ran — no COOP/COEP headers were ever served and its proxy degraded
// silently. That is the cautionary tale this design is avoiding, not evidence
// about workers.
//
// ── Why this is possible at all ───────────────────────────────────────────
//
// Because the generator is SIM-LAYER pure: no three, no DOM, no `Math.random`.
// It is a function from (maps, params, chunk, lod) to typed arrays. That purity
// was enforced by a test from the beginning, and this is the payoff — moving it
// to a worker took no changes to the generator whatsoever.
//
// The maps are sent ONCE at init and the grid is built ONCE from them, because
// `buildVertexGrid` walks 513x513 vertices and rebuilding it per chunk would
// cost more than the chunk does.

import { type ChunkBoundingSphere, finishChunk } from '@/sim/terrain/chunk-to-three'
import { dequantiseHeightMap, smoothRadiusTexels } from '@/sim/terrain/dequantise'
import { type DetailRingSpec, detailChunkParams } from '@/sim/terrain/detail'
import { buildVertexGrid, type FacetedTerrainParams, generateChunk } from '@/sim/terrain/faceted'
import {
  createGreySampler,
  createMapSampler,
  type GreyDataF32,
  type ImageData8,
  importUnityTexture,
  importUnityTextureImage,
  type MapSampler,
} from '@/sim/terrain/image-sampler'

export interface TerrainWorkerInit {
  type: 'init'
  params: FacetedTerrainParams
  /**
   * A 2016 map, through `importUnityTexture` here — or, for a PLAYER's ground
   * (DEV-489), a float grid through the raw sampler and no import rescale.
   * Which one is the message's own shape, never a flag beside it: a float grid
   * cannot be mistaken for a 2016 PNG, so the DEV-007 path cannot be taken by
   * a player's map, nor a 2016 map skip it.
   */
  height: ImageData8 | { readonly f32: GreyDataF32 }
  /**
   * The colour map. A 2016 one goes through `importUnityTexture`; a custom
   * island's is painted by FF2 (`paintCustomColour`) at its own size and read
   * raw, which is what `createMapSampler` is for.
   */
  color: ImageData8
  /** True when `color` was painted by FF2 rather than extracted from 2016. */
  colorIsOwn?: boolean
}

export interface TerrainWorkerRequest {
  type: 'chunk'
  /** Echoed back, so the caller can match a reply to a request it still wants. */
  id: number
  chunkX: number
  chunkY: number
  /** 0 and above is a stride over the base grid. **−1 is the detail ring.** */
  lod: number
  /**
   * Required when `lod` is below zero, ignored otherwise (DEV-085).
   *
   * Sent with every REQUEST rather than once at init, because the preset that
   * carries it can flip mid-run and a worker holding the old copy is a ring
   * that keeps generating at the resolution the player just turned off. It is
   * four numbers; the grid it implies is cached below.
   */
  detail?: DetailRingSpec
  /**
   * Split each triangle into this^2 before replying. DEV-242.
   *
   * Sent with the REQUEST rather than applied to the reply, because it is the
   * thing that makes an ocean chunk sixty-four times a land chunk and the whole
   * point is that the multiplication happens here. `subdivideAt(ladder, lod)`
   * on the caller's side; 1, and `finishChunk` skips the pass entirely.
   *
   * Reading it at request time rather than at reply time is a real difference
   * and a small one: `meshSubdivision` is fixed at `loadTerrain` and cannot
   * move mid-run, so the two are the same number. `jitter` below is the half
   * that CAN move, and its note says why that is still safe.
   */
  subdivide?: number
  /**
   * `RandomOffset` in mesh units for the subdivision's interior jitter.
   *
   * The caller's `jitterFor(lod)`, which for the detail ring reads the live
   * spec. A preset flip between the request and the reply would therefore
   * subdivide at the old amplitude — except that the reply handler already
   * DROPS a detail chunk whose ring has been turned off, so the only surviving
   * case is a ring whose `jitterScale` changed while its chunk was in flight,
   * which no preset does.
   */
  jitter?: number
}

export type TerrainWorkerMessage = TerrainWorkerInit | TerrainWorkerRequest

/**
 * A FINISHED chunk: subdivided, flipped into three space, sphere computed.
 *
 * DEV-242. It used to be the raw generator output, and the main thread did the
 * other three steps in the task that received it — which for an ocean chunk at
 * LOD 0 is 443,904 vertices allocated twice and walked four times, twice a
 * flight on `int_01_hoverJet`, each followed by a ~110 ms frame.
 *
 * `sphere` is here so the main thread never calls `computeBoundingSphere`: it
 * is two more passes over the positions and the worker has already made them.
 */
export interface TerrainWorkerReply {
  type: 'chunk'
  id: number
  chunkX: number
  chunkY: number
  lod: number
  positions: Float32Array
  normals: Float32Array
  colors: Float32Array
  uvs: Float32Array
  triangleCount: number
  /** three's `computeBoundingSphere`, reproduced in `boundingSphereOf`. */
  sphere: ChunkBoundingSphere
}

/**
 * `self` inside a worker is a `DedicatedWorkerGlobalScope`, but this project's
 * tsconfig includes the DOM lib and not `WebWorker` — they conflict, and the app
 * is overwhelmingly DOM — so TypeScript types `self` as `Window` and
 * `postMessage`'s transfer-list overload disappears.
 *
 * Declaring the one method used here beats adding a second lib just for this
 * file, and beats casting at every call site.
 */
const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<TerrainWorkerMessage>) => void) | null
  postMessage: (message: TerrainWorkerReply, transfer: Transferable[]) => void
}

let params: FacetedTerrainParams | null = null
let grid: { verts: Float32Array; vertPerSide: number } | null = null
let colorMap: MapSampler | null = null
let heightMap: MapSampler | null = null
/**
 * The height map AS IMPORTED — the texels the ring's reconstruction starts
 * from. Null for a player's float grid (DEV-489), which has no 8-bit levels to
 * reconstruct between: the ring samples the grid itself.
 */
let heightImage: ImageData8 | null = null

// ── The detail grid, built LAZILY and at most once per spec ──────────────
//
// LOD is a stride over the base grid, so every level from 0 up reuses the one
// grid built at init. LOD −1 cannot: it is a FINER pitch, and the vertices it
// needs are not in that grid at all. So the ring gets a second one.
//
// It is built on the first detail request rather than at init, and that is the
// difference between Classic paying for a feature it has turned off and Classic
// paying nothing. On Simonet the grid is 1025 squared — 1.05 M vertices, 12.6 MB
// — against the base grid's 513 squared; on Kauai (8,192 m of terrain) it is
// 2049 squared and 50 MB. That is a one-off stall in a WORKER, on the first
// frame the ship is over the island, while the main thread goes on rendering the
// LOD 0 meshes it already has.
//
// Keyed by the spec it was built from, because a preset flip changes the pitch
// and a grid at the wrong pitch is a chunk that does not reach its own edges.
let detailGrid: { verts: Float32Array; vertPerSide: number } | null = null
let detailParams: FacetedTerrainParams | null = null
let detailHeight: MapSampler | null = null
let detailKey = ''

const detailGridFor = (
  base: FacetedTerrainParams,
  height: MapSampler,
  image: ImageData8 | null,
  spec: DetailRingSpec,
): {
  grid: { verts: Float32Array; vertPerSide: number }
  params: FacetedTerrainParams
  height: MapSampler
} => {
  const key = `${spec.baseResolution}/${spec.jitterScale}/${spec.smoothMetres}`
  if (!detailGrid || !detailParams || !detailHeight || detailKey !== key) {
    // Throws, with both numbers, when the pitch does not divide the chunk.
    detailParams = detailChunkParams(base, spec)
    // The ring's height source: the base sampler itself at `smoothMetres` 0
    // (the identity, by construction — see `dequantiseHeightMap`), or the same
    // texels reconstructed between their 8-bit levels (DEV-131). Built once
    // per spec alongside the grid, because it IS what the grid is built from.
    // A float grid (DEV-489) is already continuous: the identity, as at radius 0.
    const radius = image ? smoothRadiusTexels(spec.smoothMetres, base.terrainSize, image.width) : 0
    detailHeight = image && radius >= 1 ? dequantiseHeightMap(image, radius) : height
    detailGrid = buildVertexGrid(detailHeight, detailParams)
    detailKey = key
  }
  return { grid: detailGrid, params: detailParams, height: detailHeight }
}

ctx.onmessage = (event: MessageEvent<TerrainWorkerMessage>) => {
  const message = event.data

  if (message.type === 'init') {
    params = message.params
    // `importUnityTexture`, never the bare sampler: both Simonet maps are
    // 1025x1025 with `nPOTScale: 1`, so Unity rescaled them to 1024 and the
    // generator sampled THAT. Skipping it is worth up to 30 m inland (DEV-007).
    // Held as an IMAGE and sampled from it, rather than `importUnityTexture`
    // in one step, because the ring's reconstruction (DEV-131) needs the same
    // imported texels — and `createMapSampler(importUnityTextureImage(x))` is
    // `importUnityTexture(x)` by definition.
    //
    // DEV-489: a player's float grid is not a 2016 map, and takes the raw
    // sampler with no rescale — `game/terrain/custom-ground.ts` says why.
    if ('f32' in message.height) {
      heightImage = null
      heightMap = createGreySampler(message.height.f32)
    } else {
      heightImage = importUnityTextureImage(message.height)
      heightMap = createMapSampler(heightImage)
    }
    colorMap = message.colorIsOwn
      ? createMapSampler(message.color)
      : importUnityTexture(message.color)
    grid = buildVertexGrid(heightMap, params)
    return
  }

  if (!params || !grid || !colorMap || !heightMap) {
    throw new Error('terrain worker: chunk requested before init')
  }

  // Below zero is the detail ring: the same `generateChunk`, at LOD 0 over a
  // finer grid. Same chunk boundaries, same skirts, same diagonal bug, same
  // barycentre colour — one function, not two. DEV-085.
  let useGrid = grid
  let useParams = params
  let useHeight = heightMap
  let useLod = message.lod
  if (message.lod < 0) {
    if (!message.detail) {
      throw new Error(`terrain worker: lod ${message.lod} requested with no detail ring spec`)
    }
    const d = detailGridFor(params, heightMap, heightImage, message.detail)
    useGrid = d.grid
    useParams = d.params
    useHeight = d.height
    useLod = 0
  }

  const raw = generateChunk(
    useGrid,
    colorMap,
    useHeight,
    useParams,
    message.chunkX,
    message.chunkY,
    useLod,
  )

  // ── the other three quarters of the work, DEV-242 ──────────────────────
  //
  // Subdivision, the Unity -> three flip with its winding reversal, and the
  // culling sphere. All three used to run on the MAIN thread in the task that
  // received this message, and for the sea that is the largest single piece of
  // main-thread work in the game: an ocean chunk at LOD 0 is 2,312 triangles
  // times `subdivide` 8 squared = 147,968 triangles = 443,904 vertices, so
  // `subdivideTriangleSoup` and the flip each allocated 19.5 MB and the sphere
  // walked the result twice more.
  //
  // Here it costs a worker-thread allocation and nothing else — the reply is
  // transferred, so the main thread's whole job is now four `BufferAttribute`
  // constructors (`chunkGeometryFromArrays`).
  const chunk = finishChunk(raw, message.subdivide ?? 1, message.jitter ?? 0)

  const reply: TerrainWorkerReply = {
    type: 'chunk',
    id: message.id,
    chunkX: message.chunkX,
    chunkY: message.chunkY,
    lod: message.lod,
    positions: chunk.positions,
    normals: chunk.normals,
    colors: chunk.colors,
    uvs: chunk.uvs,
    triangleCount: chunk.triangleCount,
    sphere: chunk.sphere,
  }

  // TRANSFER the buffers rather than copying them. A LOD 0 land chunk is 6,936
  // vertices across four attributes — about 300 KB — and an ocean chunk at LOD 0
  // is **19.5 MB**; structured-cloning either per chunk would put the cost
  // straight back on the main thread, which is the thing the worker exists to
  // avoid. (`finishChunk` returns fresh buffers whenever it does any work at
  // all, so these are never the caller's — and at `subdivide` 1 with no flip to
  // do they are still fresh, because `flipChunkToThree` always allocates.)
  ctx.postMessage(reply, [
    chunk.positions.buffer,
    chunk.normals.buffer,
    chunk.colors.buffer,
    chunk.uvs.buffer,
  ])
}
