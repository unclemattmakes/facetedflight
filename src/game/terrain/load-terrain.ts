// src/game/terrain/load-terrain.ts — fetch the maps, generate the world.
//
// The seam between three layers, and the only file that sees all of them:
//
//   src/content/  fetches and decodes the maps        (DOM, network)
//   src/sim/      turns maps into vertex data          (pure, deterministic)
//   src/render/   turns vertex data into geometry      (three)
//
// Nothing here is clever. What it mostly does is refuse to guess: every
// parameter comes from the generated sheet, keyed by environment, and an
// unknown key throws with the list of real ones rather than falling back to
// Simonet and rendering the wrong island.
//
// ── Not yet a Worker, deliberately ────────────────────────────────────────
//
// PORT_PLAN §2.4 puts generation in a plain Worker with transferable buffers.
// The generator is already pure and the buffers are already transferable, so
// that move is mechanical. It is not done here because the first thing that has
// to be true is that the terrain is CORRECT, and a synchronous version is far
// easier to compare against the oracle. M3 ("the island holds 72 Hz") is where
// the frame budget starts mattering; the Worker lands with the LOD streaming it
// exists to serve, not before.
//
// Generating all 256 chunks at LOD 0 up front is likewise a placeholder — it is
// ~1.8 M vertices and takes a couple of seconds. It buys a correct picture of
// the whole island to compare against 2016, which is what this milestone is
// for.

import type * as THREE from 'three'
import { assetUrl } from '@/content/asset-url'
import { loadImageData } from '@/content/load-image'
import { TERRAIN } from '@/generated/constants.generated'
import {
  bandCapacity,
  type ChunkBatcher,
  type ChunkBatchReport,
  createChunkBatcher,
} from '@/render/chunk-batch'
import { setOceanLate } from '@/render/draw-order'
import {
  createLodFadePool,
  type LodFadePair,
  type LodFadeSpec,
  lodFadeSeconds,
} from '@/render/lod-fade'
import { createOceanRings, type OceanRings, type OceanRingsLadder } from '@/render/ocean-rings'
import { type ShadowRole, shadowFlagsFor } from '@/render/shadows'
import {
  chunkGeometry,
  chunkGeometryFromArrays,
  isMarmosetShader,
  type TerrainLit,
  type TerrainMaterialSpec,
  terrainMaterial,
} from '@/render/terrain-mesh'
import {
  applyWaterWaves,
  type Water,
  type WaterDisplace,
  waveAmplitudeAt,
  waveCeiling,
} from '@/render/water'
import {
  chunkTriangles,
  type DetailCandidate,
  type DetailRingSpec,
  detailBand,
  planDetailRequests,
} from '@/sim/terrain/detail'
import {
  buildVertexGrid,
  chunkPerSide,
  type FacetedTerrainParams,
  generateChunk,
} from '@/sim/terrain/faceted'
import {
  buildHeightField,
  type HeightField,
  type HeightFieldTransform,
  maxFieldHeight,
} from '@/sim/terrain/height-field'
import {
  createMapSampler,
  type ImageData8,
  importUnityTexture,
  type MapSampler,
} from '@/sim/terrain/image-sampler'
import { chunkFootprintDistance, initialLod, lodBands, selectLod } from '@/sim/terrain/lod'
import type { SurfaceGrid } from '@/sim/terrain/surface'
import {
  buildColourRamp,
  type CustomGround,
  customGroundGrid,
  customHeightSampler,
  customTerrainLocal,
  customTerrainParams,
  donorGroundGrid,
  type GroundGrid,
  paintCustomColour,
} from './custom-ground'
import type { TerrainWorkerInit, TerrainWorkerReply } from './terrain.worker'

/**
 * Bucket paths for the World Machine maps.
 *
 * These mirror `tools/assets/required-assets.json`, which is the source of
 * truth for paths — and `tools/assets/extract-terrain-maps.mjs` writes to the
 * same names. All three have to agree; the asset-presence check is what
 * notices when they stop.
 */
const MAP_PATHS: Record<string, { height: string; color: string }> = {
  'simonet.islands': {
    height: 'assets/terrain/simonet/islandgroup-height.png',
    color: 'assets/terrain/simonet/islandgroup-color.png',
  },
  'simonet.ocean': {
    height: 'assets/terrain/simonet/water-height.png',
    // A .bmp in 2016; `extract-terrain-maps.mjs` re-encodes it. 790 KB of
    // uncompressed BMP becomes 1.5 KB of PNG, because it is a single flat blue.
    color: 'assets/terrain/simonet/water-color.png',
  },
  // The alpine valley — `LevelArt_AlpineForest`, and the TITLE SCREEN, which
  // 2016 stood in the same environment. `alpine.forest` and `menu.forest` in
  // the generated sheet are the same `FacetedTerrain` field for field and map
  // for map, so there is one publish and both point at it.
  //
  // A 32-bit uncompressed Targa in 2016; `tools/terrain/tga.mjs` decodes it and
  // `extract-terrain-maps.mjs` re-encodes it, so 4.2 MB of BGRA becomes 590 KB
  // of PNG and the runtime never learns TGA exists. DEV-041.
  'alpine.forest': {
    height: 'assets/terrain/alpine/forest_02-height.png',
    color: 'assets/terrain/alpine/forest_02-color.png',
  },
  // The desert canyon — four shipped missions. ONE terrain and no ocean, so
  // `environmentTerrains` returns `ocean: null` for it and nothing draws water.
  //
  // Its colour map is a BMP that was named `.tga`; `extract-terrain-maps.mjs`
  // now sniffs magic bytes rather than trusting the extension, which is why
  // this could be published at all.
  'desert.canyon': {
    height: 'assets/terrain/desert/canyon_04-height.png',
    color: 'assets/terrain/desert/canyon_04-color.png',
  },
  // Kauai. Note the LAND key is `terrain`, not `islands` — the sheet takes the
  // key from the GameObject name and 2016 named this one differently, so
  // `environmentTerrains` finds the land as "the key that is not the ocean"
  // rather than by looking for a name it would not have found.
  'kauai.terrain': {
    height: 'assets/terrain/kauai/kauai-height.png',
    color: 'assets/terrain/kauai/kauai-color.png',
  },
  // And its ocean IS Simonet's — the same two source files in the sheet, so the
  // same published bytes rather than a second copy.
  'kauai.ocean': {
    height: 'assets/terrain/simonet/water-height.png',
    color: 'assets/terrain/simonet/water-color.png',
  },
}

/**
 * DEV-579: a terrain's published height map, by sheet key (`simonet.ocean`),
 * or null where none is published. For the menu's tables, which read the
 * ocean's height map to find the waterline (`game/mission-shape.ts`) without
 * loading a terrain.
 */
export const terrainHeightPath = (key: string): string | null => MAP_PATHS[key]?.height ?? null

/** The colour map's bucket path, the other half of the pair. DEV-955: the content-time bake reads both. */
export const terrainColorPath = (key: string): string | null => MAP_PATHS[key]?.color ?? null

/**
 * The jitter seed.
 *
 * NOT a 2016 quantity — Unity's `Random` is unseeded at generation time and not
 * portable, so the 2016 vertex displacements are unreachable by construction
 * (DEV-006). What matters is that it is FIXED: the visual mesh and the
 * collision heightfield must agree on every machine and every run, and CI
 * asserts a vertex-buffer hash. Changing it reshapes every facet in the world.
 */
export const TERRAIN_SEED = 20160101

/**
 * What a cross-fade's incoming half is called: `chunk_5_5:incoming`.
 *
 * Exported because it is a NAME OTHER CODE HAS TO MATCH, and it was matched by
 * nothing for as long as it existed. `?rideHide=bore` (DEV-249) selects the
 * chunks the launch shaft's bore passes through ONCE, when the world is built,
 * and hides them for the ride; a fade adds a second mesh to the same group
 * afterwards, which was therefore never in the selection and drew the world
 * inside a sealed shaft for the length of a transition. DEV-268.
 *
 * So the suffix is one string in one place. A copy in `boot/app.ts` would be
 * the constant-that-nobody-consults trap from the other side — two spellings
 * that agree until one of them is edited.
 */
export const LOD_FADE_SUFFIX = ':incoming'

export interface LoadedTerrain {
  readonly key: string
  /** One `THREE.Mesh` per chunk, parented to a group at the world origin. */
  readonly group: THREE.Group
  /**
   * The materials a caller must patch with the fog and the far-field shadow.
   * **Patch these, never `group.children`'s.** DEV-183.
   *
   * It used to be right to walk the chunks: *"each terrain shares one material
   * instance across its chunks, so this is two compiles, not two thousand"*.
   * It is not any more. A chunk may carry a CLONE — a water band
   * (`render/water.ts`'s `materialFor`) or a live cross-fade
   * (`render/lod-fade.ts`) — and a clone delegates its whole `onBeforeCompile`
   * chain back to the material here. Hand one to `unity-fog`'s `applyTo` as
   * well and the chain runs twice: `'vUnityFogWorldPos' : redefinition`, and
   * the ocean does not compile. `unity-fog` guards per MATERIAL and a clone is
   * a different material, so its guard cannot see it.
   *
   * The fade clones were always safe by accident, because they are cut after
   * the walk has run. The bands are not: they exist before the first frame,
   * one per LOD the ocean builds at.
   *
   * One entry per terrain today. A list rather than a single material because
   * "the materials that need the atmosphere" is the question the caller is
   * actually asking, and it has been answered wrongly once.
   */
  readonly materials: readonly THREE.Material[]
  readonly params: FacetedTerrainParams
  readonly chunkCount: number
  readonly triangleCount: number
  /** How many built chunks landed on each LOD. See `lodHistogram` below. */
  readonly lodHistogram: Record<number, number>
  /**
   * Re-select LOD for every built chunk against a camera position, and queue
   * whatever changed for regeneration in the worker.
   *
   * Cheap to call every frame: it is a distance test per chunk and, in the
   * common case, no work at all. Returns how many chunks it queued.
   *
   * `frameSeconds` advances any cross-fades in progress (DEV-130). Render
   * time, like the waves: a fade is visual and nothing in `src/sim` can see
   * it. Zero, the default, leaves every fade where it is.
   */
  updateLod(cameraX: number, cameraZ: number, frameSeconds?: number): number
  /** Chunks mid cross-fade right now — two meshes each. Zero on Classic. */
  readonly fadingChunks: number
  /** Chunks currently awaiting a worker reply. */
  readonly pending: number
  /**
   * How many chunks are drawing the detail ring right now, and how many are
   * waiting for one (DEV-085). Both zero on Classic, on the ocean and at
   * quality `low`.
   *
   * Live rather than a load-time snapshot, unlike `lodHistogram`: the ring is
   * the one level that follows the ship, so the number a reader wants is the
   * number now. `?perf=1` prints it beside the preset, because "31,000 more
   * triangles" and "the ring is holding twelve chunks" are the same fact and
   * only the second one can be compared against the budget in the ledger.
   */
  readonly detailChunks: number
  readonly detailPending: number
  /**
   * How many chunks are drawing each LOD RIGHT NOW, −1 included — the live
   * twin of `lodHistogram`. `tests/e2e/lod-pop.spec.ts` reads it before and
   * after a nudge, which is how "the swap moved N chunks" becomes a number
   * rather than a guess about what the frames contain (DEV-130).
   */
  readonly lodLive: Record<number, number>
  /**
   * Non-null only for a terrain with a live `LowPoly_Displace` — i.e. the water.
   * Call `setWaveTime` each frame; a frozen ocean is what happens if you do not.
   */
  readonly water: Water | null
  /**
   * DEV-498: the rest of a water plate, for an eye above the game's far plane —
   * built on the first call, parented under `group` and returned; the same
   * object on every later call. Null for land, and for a terrain built whole.
   *
   * The ocean is built only within `visibleRadius` of its centre (the game's
   * far plane, 6 km), which leaves a 16 km square of sea in a plate 262 km
   * across. The course editor frames the island from 3–10 km up with a far
   * plane of 14–22 km, and saw the square's edge with the sky past it. This is
   * every chunk the load skipped, at the LOD the game's own bands give it
   * from the centre, one mesh per LOD on that LOD's own water material: a few
   * draws and ~20 k triangles for the whole plate. **Only the editor asks for
   * it**; a mission never builds it. `build` false only looks: the built one,
   * or null, so hiding it never builds it.
   */
  farSea(build?: boolean): THREE.Object3D | null
  /** DEV-339: the camera-centred rings, for a water terrain handed a ladder; else null. */
  readonly rings: OceanRingsControl | null
  /**
   * DEV-501 follow-up: `group.position.y` AT REST — as built, before the
   * whole-plate bob (`setWaveTime`, ±3.459 m on Simonet) and the editor's
   * preview lift. A water plate's group moves every frame; anything that
   * measures the sea as a SURFACE (the editor's ground) reads it here, or it
   * measures whatever phase of the bob the frame it looked in had.
   */
  readonly restY: number
  /**
   * DEV-501 follow-up: the most, metres, the DRAWN sea stands over its rest
   * surface anywhere, at any moment: the whole-plate bob's amplitude plus the
   * per-vertex wave's ceiling (`waveAmplitudeAt` at the plate's origin plus
   * `waveCeiling`: 3.459 + 4 m on Simonet). 0 for land and for a frozen sea.
   * The COLLISION surface does not move: `heightField` is built once, at rest,
   * and `setWaveTime` moves only the drawn group. The editor judges water
   * against rest plus this — a pad, a racer or a ring the sea reaches at the
   * top of a wave is in the sea for part of every wave (photographed on a
   * seeded shore, 116-117 m, under a sea drawn up to 120).
   */
  readonly highWater: number
  /** Advance the waves and the whole-plate bob. `seconds` is Unity's `Time.time`. */
  setWaveTime(seconds: number, eyeY?: number): void
  /**
   * DEV-500: the editor's live preview of a course's water level — the drawn
   * plate moved by `metres` from where it was built, and nothing else. The
   * collision surface stays where it was built; a flight builds its world
   * again with the level in it (`lift`), so no flight ever flies a preview.
   */
  setPreviewLift(metres: number): void
  /**
   * Turn the Anniversary shadow map's flags on or off across every chunk.
   *
   * It lives here rather than in `render/shadows.ts` because **a chunk's LOD
   * changes at runtime** and 2016 cast from LOD 0 only
   * (`shadowCastingMode = Off` above it, `FacetedTerrain.cs:721`). The worker
   * swaps a chunk's geometry whenever the camera crosses a band, so a
   * `castShadow` written once from outside would be right at boot and wrong from
   * the first LOD change — and the symptom is a shadow that disappears as you
   * approach, which reads as fog. The rule itself is NOT written here: both this
   * and `render/shadows.ts` go through `shadowFlagsFor`, so there is one table.
   *
   * Idempotent, and a no-op on Classic, where it is called with `false` and
   * every flag is already false. DEV-086.
   */
  setShadows(on: boolean): void
  /**
   * The COLLISION surface, SIM space — not the mesh.
   *
   * 2016 put a `TerrainCollider` on each `FacetedTerrain`, fed from the
   * heightmap WITHOUT the per-vertex jitter the mesh gets, at the original grid
   * resolution rather than the LOD being drawn. See `sim/terrain/height-field.ts`.
   */
  readonly heightField: HeightField
  /**
   * The height map as the generator sampled it — already through
   * `importUnityTexture`, so the nPOT rescale is applied.
   *
   * Exposed so the PROP scatter can sample the same object rather than fetch
   * and decode a megapixel PNG a second time, and — more to the point — so it
   * cannot accidentally go through bare `createMapSampler` and skip the
   * rescale. That is DEV-007, worth up to 30 m of height inland, and the whole
   * reason `importUnityTexture` exists.
   */
  readonly heightMap: MapSampler
  /**
   * The COLOUR map, through the same importer, for the same reason.
   *
   * V9's props tint themselves toward the ground they stand on (DEV-089), which
   * means sampling this at the placement. Exposing the sampler the terrain
   * already built is the only way to be sure the prop and the hillside under it
   * are reading the same texels of the same import — a second `loadImageData`
   * would be a megapixel PNG fetched twice AND a second chance to skip
   * `importUnityTexture`, which is DEV-007 waiting to happen again.
   */
  readonly colorMap: MapSampler
  /**
   * The JITTERED vertex grid the chunks are built from — the surface you can
   * SEE, at LOD 0. The one `buildVertexGrid` call this terrain already made,
   * handed out rather than repeated: a second call is 263k samples and a
   * second chance to pass a different seed.
   *
   * Feed it to `renderSurfaceHeightAt` (with `heightMap` and `params`) for
   * anything that has to SIT on the ground rather than collide with it.
   * `heightField` is the other surface and is up to `randomOffset` away from
   * this one — 1.3 m on Simonet — which is DEV-134's floating forest and
   * DEV-148's fracture pieces.
   */
  readonly surfaceGrid: SurfaceGrid
  /**
   * DEV-489: non-null when this terrain is a PLAYER's ground rather than the
   * key's own island. `heightMap` and `colorMap` above are then the player's
   * heights (the raw float sampler, no import rescale) and the painted colour
   * map; `donorHeight` is the DONOR's height map through `importUnityTexture`,
   * kept so the prop layer can measure the donor's forest against its own
   * ground (`customEnvironmentProps`) without fetching it a second time. The
   * timings are the load's receipt, milliseconds of main-thread work.
   */
  readonly custom: {
    readonly ground: CustomGround
    readonly donorHeight: MapSampler
    /** Height and slope on each terrain's facet grid (`groundGrid`), built once. */
    readonly grids: { readonly donor: GroundGrid; readonly ground: GroundGrid }
    readonly timings: {
      readonly rampMs: number
      readonly paintMs: number
      readonly gridMs: number
      readonly chunksMs: number
    }
  } | null
  /**
   * Sub-quads per edge a chunk at `lod` is split into — `subdivideAt` over this
   * terrain's own ladder, the number the chunks are finished with. DEV-447: a
   * boat rebuilds the sea's LOD 0 triangle under it, and the split is half of
   * what that triangle is.
   */
  subdivisionAt(lod: number): number
  /**
   * Put a fade CLONE onto a live chunk so the caller's next draw compiles its
   * program. Returns the undo, or null when this terrain can never fade.
   * DEV-184.
   *
   * Since the clone carries `LOD_FADE_DEFINE` and the base does not, they are
   * two programs — and the clone's first appearance is a LOD change, in flight,
   * in the clear. That is the stall class DEV-177 is chasing and exactly what
   * `render/warm-up.ts` exists to prevent.
   *
   * **Begin/undo rather than a `warmVariants`-shaped call**, and the difference
   * is the whole point: three's program cache key carries the bound render
   * target's colour space (field `outputColorSpace`, which is
   * `LinearSRGBColorSpace` for a target and the renderer's own for the canvas —
   * DEV-117) and the scene's point-light COUNT (field #36 — DEV-152). Compiling
   * after `warmWorld` has returned gets both wrong and warms a variant nothing
   * will draw. Swapping the material BEFORE it and undoing after puts the clone
   * inside `warmWorld`'s own draw, so it inherits the target, the lights and
   * the curtain without this module knowing that any of them exist.
   *
   * Idempotent in effect: the pair is returned to the pool by the undo, so the
   * clones this warms are the clones the first real fade uses.
   */
  warmLodFade(): (() => void) | null
  /**
   * DEV-904: the chunk grid's batches. `available` is false for the sea, for a
   * load that did not ask (`LoadTerrainOptions.chunkBatch`) and for a terrain
   * with one chunk; every method is then a no-op returning null.
   */
  readonly batching: {
    readonly available: boolean
    /** Whether chunks are being placed into bands right now. */
    readonly on: boolean
    /**
     * (Re)build every band from the chunks as they are now and start placing.
     * Call after the baked light has resolved, and whenever it changes (the
     * loader does that itself through `onBakeChange`).
     */
    sync(): ChunkBatchReport | null
    /** `true` is `sync`; `false` puts every chunk back to drawing as its own mesh. */
    set(on: boolean): ChunkBatchReport | null
    /**
     * Chunks that must keep drawing as their own mesh, by name: the launch bore's
     * (DEV-249), which `frame.ts` hides and shows one at a time. Replaces the
     * previous set.
     */
    exclude(names: ReadonlySet<string>): void
    report(): ChunkBatchReport | null
    /** Which chunk is in which band slot. For specs. */
    occupants(): readonly { readonly band: string; readonly slot: number; readonly id: string }[]
  }
  dispose(): void
}

/**
 * What one terrain in the sheet looks like, structurally.
 *
 * Written out rather than derived from `typeof TERRAIN`, because the generated
 * sheet is a frozen literal: every terrain has its own singleton types
 * (`chunkSize: 256`, not `number`) and no index signature, so indexing it by a
 * runtime string is not expressible. The sheet stays the source of truth for
 * VALUES; this is the shape they arrive in.
 */
interface TerrainEntry {
  readonly lodLevels?: number
  readonly lodDistance?: number
  readonly flipFlopPercent?: number
  /** `LODTransitionTime`, seconds. 2016's authored cross-fade, never rendered (DEV-130). */
  readonly lodTransitionTime?: number
  readonly transform?: {
    readonly position: readonly number[]
    /** Ancestors between this terrain and the level offset. See `terrainPos`. */
    readonly envRoot?: readonly number[]
    readonly scale: readonly number[]
  }
  readonly terrainSize: number
  readonly terrainHeight: number
  readonly chunkSize: number
  readonly baseResolution: number
  readonly randomOffset: number
  readonly material?: {
    readonly tint?: readonly number[] | null
    readonly shader?: string | null
    readonly specular?: {
      readonly intensity?: number | null
      readonly shininess?: number | null
      readonly iblBrightness?: number | null
      readonly color?: readonly number[] | null
      /**
       * `_Fresnel`. On the Marmoset branch this steepens the falloff toward
       * normal incidence — it is one of the three numbers that set F0, not a
       * separate rim term. See `marmosetSpecularF0`.
       */
      readonly fresnel?: number | null
    } | null
    readonly reflection?: {
      readonly color?: readonly number[] | null
      readonly fresnel?: number | null
      /** `_ReflectionDistortion`. DEV-583. */
      readonly distortion?: number | null
      /** The `V_LP_REFLECTIVE_REALTIME` keyword. DEV-583. */
      readonly realtime?: boolean | null
    } | null
  } | null
}

type TerrainSheet = Record<string, { readonly terrains: Record<string, TerrainEntry> }>

/**
 * Which terrains an environment is made of, and where its ocean is centred.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * `boot/app.ts` asked for `'simonet.islands'` and `'simonet.ocean'` as STRING
 * LITERALS and never read `level.environment`. So a mission in another
 * environment did not fail — it loaded, rendered Simonet, and put 2016's own
 * briefing copy over it. `hoverJet_kauai_beg` came up captioned
 * "KAUAI - FREE FLIGHT" above a Simonet hillside; `adv_01_hoverJet`, a desert
 * mission, came up INSIDE a Simonet hillside. All thirteen shipped missions
 * reported `data-terrain-ready` and nine were the wrong world.
 *
 * That is CLAUDE.md rule 6 — content is data, adding a mission must never
 * require touching `src/` — and it is the trap the two `islandgroup_height.png`
 * files are the standing example of: **almost right is the most expensive kind
 * of wrong**, because nothing errors and the screen comes up.
 *
 * ── Everything here is DERIVED, nothing is typed ──────────────────────────
 *
 * The shape differs per environment and the sheet already knows it: simonet is
 * `islands` + `ocean`, kauai is `terrain` + `ocean` (a different name for the
 * land), and alpine, desert and menu are a single land terrain with no water at
 * all. So the land is "the key that is not the ocean" rather than a lookup
 * table somebody has to remember to extend.
 *
 * `oceanCentre` is derived too. It was `centre: [-110, 0, -181]` at the call
 * site — a literal, which rule 3 calls a smell, and it is simply the LAND's own
 * position with z negated for three's handedness. Deriving it means an
 * environment whose island sits somewhere else gets the right ocean window
 * without anyone noticing they had to change it.
 */
export interface EnvironmentTerrains {
  /** `<env>.<key>` for the land. Always present. */
  readonly land: string
  /** `<env>.ocean`, or null for an environment with no water. */
  readonly ocean: string | null
  /** Where to centre the ocean's built chunks, in THREE space. */
  readonly oceanCentre: readonly [number, number, number]
}

export const environmentTerrains = (environment: string): EnvironmentTerrains => {
  const env = (TERRAIN as unknown as TerrainSheet)[environment]
  if (!env) {
    const known = Object.keys(TERRAIN as unknown as TerrainSheet)
      .sort()
      .join(', ')
    throw new Error(
      `Unknown environment "${environment}". The generated sheet knows: ${known}. ` +
        "A level's `environment` field must name one of them.",
    )
  }
  const names = Object.keys(env.terrains)
  const landName = names.find((n) => n !== 'ocean')
  if (!landName) {
    throw new Error(`Environment "${environment}" has no land terrain, only ${names.join(', ')}.`)
  }
  const land = env.terrains[landName] as TerrainEntry
  const pos = land.transform?.position ?? [0, 0, 0]
  return {
    land: `${environment}.${landName}`,
    ocean: names.includes('ocean') ? `${environment}.ocean` : null,
    // Unity -> three is a z mirror (`render/unity-space.ts`).
    oceanCentre: [pos[0] as number, 0, -(pos[2] as number)],
  }
}

const terrainEntry = (key: string): TerrainEntry => {
  const [env, name] = key.split('.')
  const entry =
    env && name ? (TERRAIN as unknown as TerrainSheet)[env]?.terrains?.[name] : undefined
  if (!entry) {
    const available = Object.entries(TERRAIN as unknown as TerrainSheet)
      .flatMap(([e, v]) => Object.keys(v.terrains).map((t) => `${e}.${t}`))
      .sort()
    throw new Error(`Unknown terrain "${key}". Available: ${available.join(', ')}`)
  }
  return entry
}

/**
 * The terrain's own LOCAL position under the LevelArt root, Unity space —
 * `FacetedTerrain.cs`'s corner, not a centre (DEV-042). The frame the
 * environment JSON's hand-placed landmarks are composed in stops at that same
 * root, so `landmark − this` is the landmark in the terrain's mesh frame, and
 * that subtraction is the whole of what `load-props.ts` needs to hang a spire
 * under the terrain group beside the scattered palms (DEV-135).
 */
/**
 * DEV-501 follow-up: `LoadedTerrain.highWater` for a plate whose live wave is
 * `displace` (null: land, or a frozen sea) and whose whole-plate bob is
 * evaluated at `bobOrigin` (Unity space, the plate's own transform position,
 * as `setWaveTime` passes it): the bob's amplitude there plus the per-vertex
 * wave's ceiling. Exported so a test builds the number the game builds.
 */
export const highWaterOf = (
  displace: WaterDisplace | null,
  bobOrigin: readonly number[],
): number =>
  displace
    ? waveAmplitudeAt(displace, bobOrigin[0] as number, bobOrigin[2] as number) +
      waveCeiling(displace)
    : 0

export const terrainLocalPosition = (key: string): readonly number[] =>
  terrainEntry(key).transform?.position ?? [0, 0, 0]

/**
 * The terrain's own local position PLUS its environment root, Unity space.
 * Split out of `loadTerrain` (DEV-955) so the content-time terrain bake places
 * the collision field by these lines and not by a copy of them.
 */
export const donorTerrainPosition = (entry: {
  readonly transform?: {
    readonly position: readonly number[]
    readonly envRoot?: readonly number[]
  }
}): number[] => {
  const localPos = entry.transform?.position ?? [0, 0, 0]
  const envRoot = entry.transform?.envRoot ?? [0, 0, 0]
  return [
    (localPos[0] as number) + (envRoot[0] as number),
    (localPos[1] as number) + (envRoot[1] as number),
    (localPos[2] as number) + (envRoot[2] as number),
  ]
}

/** DEV-500: a course's water moves its sea plate; both surfaces read the lifted position. */
export const liftedPosition = (placed: readonly number[], lift: number): readonly number[] =>
  lift === 0 ? placed : [placed[0] as number, (placed[1] as number) + lift, placed[2] as number]

/** The collision field's transform for a terrain placed at `terrainPos`. */
export const fieldTransformAt = (
  entry: { readonly transform?: { readonly scale: readonly number[] } },
  terrainPos: readonly number[],
  worldOffset: readonly number[],
): HeightFieldTransform => ({
  // SIM (Unity) space, and it has to include the level's worldOffset.
  //
  // The RENDER group goes to `(wo.x + tp.x, wo.y + tp.y, wo.z - tp.z)` in
  // three space. The sim is that mirrored in z, so its origin is
  // `(wo.x + tp.x, wo.y + tp.y, tp.z - wo.z)`: note the z term flips which
  // of the two is subtracted. Leaving `wo` out entirely puts the collision
  // surface 2 km from the terrain you can see, and the ship sails through the
  // island without ever finding it.
  position: [
    (worldOffset[0] as number) + (terrainPos[0] as number),
    (worldOffset[1] as number) + (terrainPos[1] as number),
    (terrainPos[2] as number) - (worldOffset[2] as number),
  ],
  scale: (entry.transform?.scale ?? [1, 1, 1]) as number[],
})

/**
 * The collision field and colour sampler a SHIPPED land key gives under a
 * level's `worldOffset`, from its map images alone. `loadTerrain` does the same
 * with the same pieces; this is the form a Node tool can run (DEV-955).
 */
export const shippedLandFor = (
  key: string,
  heightImg: ImageData8,
  colorImg: ImageData8,
  worldOffset: readonly number[],
  lift = 0,
): { heightField: HeightField; colorMap: MapSampler } => {
  const entry = terrainEntry(key)
  const params = terrainParams(key)
  const height = importUnityTexture(heightImg)
  const colorMap = importUnityTexture(colorImg)
  const terrainPos = liftedPosition(donorTerrainPosition(entry), lift)
  return {
    heightField: buildHeightField(height, params, fieldTransformAt(entry, terrainPos, worldOffset)),
    colorMap,
  }
}

export const terrainParams = (key: string): FacetedTerrainParams => {
  const t = terrainEntry(key)
  return {
    terrainSize: t.terrainSize,
    terrainHeight: t.terrainHeight,
    chunkSize: t.chunkSize,
    baseResolution: t.baseResolution,
    randomOffset: t.randomOffset,
    seed: TERRAIN_SEED,
  }
}

/**
 * Bytes on the GPU per finished chunk vertex: position 12 + normal 12 +
 * colour 12 + uv 8. The unit the drain budget is really in.
 */
export const CHUNK_VERTEX_BYTES = 44

/**
 * How much swap work one frame may do, in VERTICES. DEV-242.
 *
 * ── Why vertices and not chunks ───────────────────────────────────────────
 *
 * Because a chunk is not a unit of anything. A land chunk at LOD 0 is 6,936
 * vertices; an **ocean** chunk at LOD 0 is 443,904 — sixty-four times as many,
 * because `subdivisionByLod[0]` is 8 and 8² = 64. A budget of "one chunk a
 * frame" would let through the single most expensive object in the game and
 * throttle the cheapest one for no reason. That confusion — reading a COUNT of
 * chunks as a measure of work — is the same mistake §1 of DEV-242 found in the
 * attribution, one layer down, and it is why this is not `MAX_SWAPS_PER_FRAME`.
 *
 * ── Where the number comes from, and what it is not ───────────────────────
 *
 * 32,768 vertices is **1.44 MB** at `CHUNK_VERTEX_BYTES`, which is about five
 * land chunks at LOD 0 or one detail-ring chunk with room to spare. It is
 * INSURANCE against a burst, not a measured optimum: on the traces this row was
 * opened for, the land never queues five chunks in one gap, and the one arrival
 * that matters — the ocean's — is thirteen times this on its own and lands
 * alone in its frame whatever the budget says (see `planChunkDrain`'s
 * forward-progress rule). Nothing is tuned against it, no measurement rests on
 * it, and the test is on the drain's ARITHMETIC rather than on this value —
 * which is the distinction DEV-027 paid a lap time to learn.
 */
export const DRAIN_VERTEX_BUDGET = 32_768

/**
 * How many of the queued arrivals this frame may swap in. DEV-242.
 *
 * Pure, and exported, so the rule can be tested without a worker, a renderer or
 * a clock — `tests/unit/chunk-drain.test.ts`.
 *
 * Two rules, and the second one is the one that matters:
 *
 *  1. **Spend up to `budget` vertices.** An arrival that would take the total
 *     past the budget waits for the next frame.
 *  2. **Always take at least one.** Otherwise an arrival bigger than the whole
 *     budget — which is every ocean chunk, at 443,904 against 32,768 — would
 *     never be taken, the queue would stop for ever and the sea would freeze at
 *     the LOD it happened to be on. A budget that can deadlock is not a budget.
 *     So the first arrival always goes, and the budget only ever decides
 *     whether a SECOND one joins it.
 *
 * The consequence is stated rather than hidden: **this does not make one large
 * chunk cheaper.** It spreads a burst. The large chunk is made cheap by the
 * worker finishing it (DEV-168's design, built in this row), which is a
 * different mechanism for a different half of the problem.
 */
export const planChunkDrain = (
  /** Vertex count of each queued arrival, oldest first. */
  queued: readonly number[],
  budget = DRAIN_VERTEX_BUDGET,
): number => {
  let spent = 0
  let taken = 0
  for (const vertices of queued) {
    if (taken > 0 && spent + vertices > budget) break
    spent += vertices
    taken++
  }
  return taken
}

/**
 * Sub-quads per edge at `lod`, from `meshSubdivision`. DEV-183.
 *
 * A number is one density at every distance, which is what the port drew until
 * DEV-183. A LIST is a ladder indexed by LOD, and its LAST rung covers every
 * level beyond it — so `[8]` is exactly the scalar 8, and a preset can name
 * fewer rungs than the terrain has levels without leaving a hole.
 *
 * LOD **-1** is the detail ring, which is land-only (`detailRingFor` is handed
 * `isOcean: false`) and therefore unreachable on a subdivided terrain — the
 * same unreachability `jitterFor` documents. It takes rung 0 rather than
 * throwing; a ring on a subdivided terrain would need its own rung AND its own
 * facet size, because its quads are the RING's `baseResolution` rather than the
 * terrain's.
 */
export const subdivideAt = (
  meshSubdivision: number | readonly number[] | undefined,
  lod: number,
): number => {
  const rungs = typeof meshSubdivision === 'number' ? [meshSubdivision] : (meshSubdivision ?? [])
  const raw = rungs[Math.min(Math.max(0, lod), rungs.length - 1)] ?? 1
  return Math.max(1, Math.floor(raw))
}

/**
 * One quad at `lod`, in WORLD metres — the number `render/water.ts` needs as
 * `uFacet`. DEV-183.
 *
 * TWO facts compose here and only one of them used to be read:
 *
 *  1. **Subdivision**, this port's own render-side multiplier, now per LOD.
 *  2. **The LOD stride**, 2016's — `sim/terrain/faceted.ts` takes every
 *     `1 << lod`-th vertex of one shared grid, so a chunk at LOD n has quads of
 *     `baseResolution * 2^n` in MESH units before the transform's scale.
 *
 * The whole plate used to be told the LOD 0 answer. Beyond the first band that
 * is up to eight times too small, so the shader's flatten blend engaged up to
 * eight times too early — taking the facet glint out of exactly the far water
 * `int_01`'s 4-degree sun lights — and its tilt clamp allowed up to eight times
 * more lean than the mesh can produce, which is the noise the clamp exists to
 * remove.
 *
 * `tests/unit/ocean-density.test.ts` holds this against the quad edge MEASURED
 * off the geometry the generator emits, rather than against this arithmetic
 * written out a second time.
 */
export const facetMetresAt = (
  baseResolution: number,
  scaleX: number,
  meshSubdivision: number | readonly number[] | undefined,
  lod: number,
): number => (baseResolution * 2 ** Math.max(0, lod) * scaleX) / subdivideAt(meshSubdivision, lod)

export interface LoadTerrainOptions {
  /**
   * DEV-831: split each quad along the diagonal 2016's code MEANT to choose
   * (`faithfulDiagonalBug: false`). Absent or false keeps 2016's own, bug and
   * all, which is what the oracle sweep and Classic need. Anniversary passes its
   * `terrain.diagonalFix.enabled`. Every chunk, LOD and render-surface query of
   * this terrain reads the same `params`, so props and the sea follow it; the
   * collision height field never uses a diagonal and does not change.
   */
  readonly fixDiagonal?: boolean
  /**
   * Nine SH coefficients of the mission's sky, for the water's REFLECTION.
   *
   * The sea's faceting is not its colour map — `water_color` is a single flat
   * texel — and it is not its geometry, whose 256 m quads tilt about a degree
   * under the waves. It is the reflection: at a grazing angle a degree of normal
   * swings the reflected direction across a sky that changes fast near the
   * horizon, and each facet catches a different piece of it.
   */
  readonly skySh?: readonly (readonly number[])[] | null
  /** Convert the material tint from sRGB. Default true; see `terrainMaterial`. */
  readonly tintIsSrgb?: boolean
  /**
   * `?terrainLit=` — the shading model, as a measurement (DEV-182).
   *
   * Passed through to `terrainMaterial`, which ignores it on a VacuumShaders
   * surface. So all three `loadTerrain` calls in `boot/app.ts` may be handed the
   * same value and the OCEAN is excluded by the same fact that decides its
   * roughness, exactly as `applyIllustrative` already is. Undefined is
   * `standard`, which is the shipped material byte for byte.
   */
  readonly lit?: TerrainLit
  /**
   * Override the wave's WAVELENGTH, in metres. Null (default) keeps 2016's.
   *
   * `_DisplaceFrequency` is 0.4 on world-space metres, which is an 11.1 m wave —
   * on a mesh whose vertices are **256 m** apart. A 23x undersample: the
   * geometry cannot carry the wave, so what reaches the vertices is noise, and
   * the sea's facets tilt 0.39 degrees on average. That is faithful; the Unity
   * shader, the mesh resolution and the parameters all match. It is also why the
   * sea looks flat, and this switch is how you see the alternative without
   * committing to it. See `?swell=` in `boot/app.ts`.
   */
  readonly swellWavelength?: number | null
  /**
   * Split each rendered triangle into this^2. Default 1 — untouched.
   *
   * Matt: *"the ocean isn't nearly dense enough... i think it should be roughly
   * 4x denser."* It is a RENDER-only multiplier, downstream of the generator, so
   * the oracle sweep, the collision height field and the land are all untouched.
   * See `subdivideTriangleSoup` for why the sim could not carry it.
   *
   * ── A LIST is a ladder, indexed by LOD (DEV-183) ──────────────────────
   *
   * One number is one density at every distance, which is what the port drew
   * until DEV-183. A dense facet only shows where it is more than a few pixels
   * across, so a list spends them near and stops spending them far. What that
   * saves is UNMEASURED — the only reading of the sea's vertex cost is withdrawn
   * (`docs/plan/VR-PERF-WAVE-2-WORK.md` §6b) — and on `int_01` the ladder is
   * inert over most of the route (DEV-183 §3). The LAST entry covers every
   * level beyond it, so `[8]` is exactly the scalar 8 and `[]` is refused by
   * the preset schema rather than silently becoming 1.
   *
   * Read ONCE, here, like `swellWavelength`: this decides the geometry of every
   * chunk that is built, and a live preset flip has no way to re-mesh a sea
   * that is already on screen. `?ocean=<n>` pins the whole ladder.
   */
  readonly meshSubdivision?: number | readonly number[]
  /** The mission's sun, for the water's specular. */
  readonly sun?: {
    readonly direction: readonly number[]
    readonly colorLinear: readonly number[]
    readonly intensity: number
  } | null

  /** Progress in 0..1, called per chunk. The island takes a couple of seconds. */
  onProgress?: (fraction: number) => void
  /**
   * Awaited after every chunk built at load, so the loop can hand the thread
   * back to the frame loop when its budget is spent (DEV-355). `boot/slice.ts`'s
   * `checkpoint`. Omitted, the loop runs straight through as it always did.
   */
  slice?: () => Promise<void>
  signal?: AbortSignal
  /**
   * The mission's `worldOffset`, in THREE space, straight from the level JSON.
   *
   * Terrain and mission content are placed independently in 2016 —
   * `LoadLevelArt` just calls `SceneManager.LoadSceneAsync` additively, with no
   * re-parenting and no offset — so the two have to be reconciled here.
   *
   * Which offset is right was settled by measurement rather than reading:
   * sampling the heightmap under all 21 of `int_01_hoverJet`'s rings puts
   * **20 of 21 inside the island footprint, 40 to 339 m above the ground and
   * none below it** when the terrain is placed at `worldOffset + its own
   * transform`. Placing it at the transform alone leaves 16 rings off the map;
   * placing it at the offset alone buries seven of them underground.
   * `tests/unit/terrain-placement.test.ts` holds that result.
   */
  worldOffset?: readonly [number, number, number]
  /**
   * Only generate chunks within this many metres of `centre`.
   *
   * Needed for the ocean and pointless for the island. Simonet's water plate is
   * a 32 x 32 grid of 1024 m chunks SCALED 8x — 262 km on a side, 1,024 chunks,
   * about 7.1 M vertices and a third of a gigabyte if built whole. The camera's
   * far plane is 6 km, so all but a handful of those chunks are invisible at any
   * moment and most are invisible always.
   *
   * This is a placeholder for real LOD streaming (M3), not a substitute for it:
   * it picks a fixed set once at load rather than following the camera. Good
   * enough while the ship starts and stays near the island; the first mission
   * that flies out to sea needs the streaming.
   */
  visibleRadius?: number
  /** Centre for `visibleRadius`, three-space world. Defaults to the origin. */
  centre?: readonly [number, number, number]
  /** Camera x/z at load, for picking each chunk's starting LOD. THREE world space. */
  camera?: readonly [number, number]
  /**
   * The same thing as `camera`, but given in the terrain's own MESH frame
   * (x, z, each 0..terrainSize) and converted here. Ignored when `camera` is set.
   *
   * ── Why this exists, and why it is not the caller's arithmetic ──────────
   *
   * The title valley's eye is a CONSTANT in that frame — `TITLE_2016.cameraMesh`,
   * measured out of `main_menu.unity` — and the world point it maps to depends
   * on the group placement this function composes from the sheet. So a caller
   * that wanted initial LODs around it had two bad options: load the terrain
   * first and re-mesh afterwards (the chicken and egg its old note declined,
   * *"measured it costs about a second. Cheaper than the bug."*), or keep a
   * second copy of `worldOffset + localPos + envRoot` — which is the exact
   * composition DEV-042 got wrong twice. Neither: the conversion happens where
   * the placement is known, once.
   *
   * ── And it is the UNROTATED frame, deliberately ─────────────────────────
   *
   * `chunkFootprintDistance` builds axis-aligned boxes out of `group.position`
   * and `group.scale`, so it measures in the frame this function leaves the
   * group in — before a caller puts 2016's rotation on it. Handing it a point
   * composed through `matrixWorld` AFTER that rotation would compare a rotated
   * point against unrotated boxes, which is the "wrong, not conservative"
   * failure DEV-042's note warns about. This conversion cannot make that
   * mistake, because it happens before the rotation exists.
   */
  cameraMesh?: readonly [number, number]
  /**
   * Start the regeneration worker. Default true.
   *
   * `false` for a terrain nothing will ever call `updateLod` on — the title
   * valley is one fixed camera in a valley, generated once and never moved.
   * The worker is not free for it: `init` structured-clones the height and the
   * colour `ImageData` (two 1024x1024 RGBA buffers, 8 MB, NOT transferable
   * because the main thread goes on sampling both), for replies that can never
   * be asked for.
   *
   * It does not change what is BUILT. Every chunk still lands on the LOD
   * `camera`/`cameraMesh` picks for it; what goes is the machinery for moving
   * between LODs afterwards. A `detailRing` or a `lodFade` passed alongside
   * this is a caller contradicting itself, and the worker still starts for the
   * ring — see its own note for why presence alone is enough.
   */
  lodUpdates?: boolean
  /**
   * LOD −1: the nearest chunks generated at a finer facet. DEV-085, T1.
   *
   * A GETTER, called once per `updateLod`, never cached — the preset and the
   * comfort settings both flip mid-run and a cached spec is a ring that stays on
   * after the player turned it off. Null (the default, and what `undefined`
   * resolves to) means LOD −1 is unreachable and every line of the LOD path
   * behaves exactly as it did before the ring existed. `game/terrain/detail-ring.ts`
   * is what app.ts passes, and it is where the ocean / quality / preset
   * exclusions live.
   *
   * Its mere PRESENCE starts the worker even on a single-LOD terrain, because
   * the spec it returns can go from null to non-null on a flip and a terrain
   * that never started one would then have nowhere to generate.
   */
  detailRing?: (() => DetailRingSpec | null) | null
  /**
   * The Anniversary illustrative warp, handed the terrain's material — and
   * called ONLY for a Marmoset-authored one, i.e. the LAND. V7, DEV-092.
   *
   * A callback rather than a preset, for the reason `loadDressing`'s `applyFog`
   * is one: this loader has no business knowing which edition is live. What it
   * does know, and the caller does not, is `entry.material.shader` — the fact
   * `terrainMaterial` already branches on to decide whether there is a Marmoset
   * F0 to carry. "Is this the ocean" asked any other way is a guess (the same
   * argument `shininessToRoughness` and `shadowRole` are written under), and the
   * sea must not get this: it is a VacuumShaders surface drawn by
   * `render/water.ts` with its own sun term, so a warp on three's directional
   * light would shade a light the water does not use.
   */
  applyIllustrative?: (material: THREE.Material) => void
  /**
   * DEV-132's per-class roughness, handed the LAND material under the same
   * Marmoset guard as `applyIllustrative` and for the same reason: the sea is a
   * VacuumShaders surface with its own specular in `render/water.ts`.
   */
  applySurfaceGloss?: (material: THREE.Material) => void
  /**
   * DEV-232's vertex-colour bake, handed **every chunk geometry as it is
   * built**, including the ones that stream in mid-flight and the detail ring's.
   *
   * A geometry hook and not a material one, and that is the whole shape of the
   * feature: the switch lives on the material as a `#define`, and what the
   * define reads lives in the buffer. A chunk that landed while the preset was
   * on has to arrive baked or it draws its raw albedo unlit, which is the
   * mobile-toy ditch for exactly as long as that chunk is on screen.
   *
   * Idempotent and reversible by contract — `render/baked-light.ts` keeps each
   * geometry's raw colours and always bakes from the snapshot, so calling this
   * twice is not calling it twice.
   */
  bakeGeometry?: (geometry: THREE.BufferGeometry) => void
  /**
   * DEV-904: draw the chunk grid through one `BatchedMesh` per LOD
   * (`render/chunk-batch.ts`, DEV-193's spike made a mode). Off by default and
   * on for the LAND of a mission; the sea is never batched (DEV-193 section 3d).
   * Nothing is placed until `LoadedTerrain.batching.sync()` is called, because
   * the batches hold a COPY of the vertex data and the baked light has not
   * written it yet when the chunks are built.
   */
  chunkBatch?: boolean
  /**
   * DEV-904: subscribe to "the baked light just rewrote the chunk geometries"
   * (`BakedLight.onChange`). Returns the unsubscribe, which `dispose` calls. A
   * batch holds its own copy of the colours and of `ff2Direct`, so it has to be
   * rebuilt whenever the bake's state moves.
   */
  onBakeChange?: (listener: () => void) => () => void
  /**
   * DEV-130's cross-fade. A GETTER, read at every reply, never cached — the
   * preset flips from the pause menu. Null (the default) is the swap in one
   * assignment that Classic and every existing caller get; a spec turns each
   * LOD change into a screen-door transition lasting the sheet's
   * `lodTransitionTime` times `durationScale`.
   */
  lodFade?: (() => LodFadeSpec | null) | null
  /**
   * DEV-489: generate a PLAYER's ground instead of the key's own island. The
   * key then names the DONOR land — its maps give the colour ramp, its sheet
   * entry the grain, the LOD ladder and the material — and the island is
   * centred where the donor's stands. Null (the default) is the key's island,
   * and every line of the load is the one that was there before.
   */
  ground?: CustomGround | null
  /**
   * DEV-500: metres to raise (or, negative, lower) this terrain from where the
   * sheet stands it — render group AND collision surface together, so a sea
   * plate moved to a course's water level is the same crash surface at its new
   * height (`game/terrain/course-water.ts`). 0 (the default) is every shipped
   * load, and every line of it the one that was there before.
   */
  lift?: number
  /**
   * DEV-339: the preset's `terrain.oceanRings`, for a WATER terrain. Null or
   * absent is the plate exactly as it was and no ring code runs: the rings are
   * not even built, and `LoadedTerrain.rings` is null. `enabled` false keeps
   * the plate and still allows `rings.set(true)` to build the rings later (the
   * A-B-A switch); `enabled` true builds the rings INSTEAD of the plate's chunks.
   */
  rings?: OceanRingsSpec | null
}

/** `terrain.oceanRings` in the edition preset. */
export interface OceanRingsSpec {
  readonly enabled: boolean
  readonly ladder: OceanRingsLadder
  /** DEV-340: the face normal comes from the vertex shader. */
  readonly faceNormals: boolean
}

/**
 * The loader's spec from the preset's block, with a load-time pin
 * (`?oceanRings=`) over `enabled`. The block is the same four numbers either way.
 */
export const oceanRingsSpecFor = (
  block: { readonly enabled: boolean; readonly faceNormals: boolean } & OceanRingsLadder,
  pin: boolean | null,
): OceanRingsSpec => ({
  enabled: pin ?? block.enabled,
  ladder: { cells: block.cells, innerCell: block.innerCell, levels: block.levels },
  faceNormals: block.faceNormals,
})

/** DEV-339: the rings' live switch and what it reports (a count, never a belief). */
export interface OceanRingsControl {
  /** What the preset asked for at load. */
  readonly wanted: boolean
  /** Are the rings what draws the sea right now? */
  readonly on: boolean
  /** Why the rings are not available or not on, or null. */
  readonly reason: string | null
  /** Triangles submitted per frame by the rings (holes collapsed in the vertex stage). */
  readonly submitted: number
  /** Triangles that rasterise. 0 until the rings are built. */
  live(): number
  /** Each level's cell, world metres; empty until the rings are built. */
  readonly cellMetres: readonly number[]
  /** Bytes of lattice texture and cell geometry the rings hold. */
  readonly bytes: number
  /**
   * Switch which sea draws. Builds the rings on the first `true` (and the
   * plate on the first `false` if the rings came first), so the FIRST call of
   * either kind is a build, not a measurement.
   */
  set(on: boolean): Promise<{ on: boolean; reason: string | null; triangles: number }>
  /**
   * DEV-340: where the face normal comes from. `face` is the vertex shader's,
   * `derived` the fragment's screen-space derivatives. Builds the rings if need
   * be; the first `face` compiles a second program on its first draw.
   */
  setNormals(mode: 'derived' | 'face'): boolean
  readonly normals: 'derived' | 'face'
}

/**
 * Load one terrain and build its geometry.
 *
 * The maps go through `importUnityTexture`, never the bare sampler: both are
 * 1025x1025 with `nPOTScale: 1`, so Unity rescaled them to 1024 at import and
 * the generator sampled THAT. Skipping it is worth up to 30 m of height inland
 * (DEV-007).
 */
export const loadTerrain = async (
  key: string,
  options: LoadTerrainOptions = {},
): Promise<LoadedTerrain> => {
  const THREE = await import('three')
  const entry = terrainEntry(key)
  const paths = MAP_PATHS[key]
  if (!paths) {
    throw new Error(
      `No bucket paths for terrain "${key}". Add it to MAP_PATHS and to ` +
        'tools/assets/required-assets.json together.',
    )
  }

  const [heightImg, colorImg] = await Promise.all([
    loadImageData(assetUrl(paths.height), options.signal),
    loadImageData(assetUrl(paths.color), options.signal),
  ])

  // DEV-355: each whole-map pass below is tens of milliseconds, and between
  // two of them is a place the thread can go back to the frame loop.
  const donorHeight = importUnityTexture(heightImg)
  if (options.slice) await options.slice()
  const donorColor = importUnityTexture(colorImg)
  if (options.slice) await options.slice()

  // ── DEV-489: a PLAYER's ground, through the same generator ─────────────
  //
  // With `ground`, `key` is the DONOR land: its maps were fetched above for
  // their colours (the ramp) and their forest (the density bands), and its
  // sheet entry still supplies the grain, the LOD ladder and the material.
  // The heights, the extent and the colour map the chunks are cut from are
  // the player's. Without it, every line below is the one that was here.
  const custom = options.ground ?? null
  const customTimings = { rampMs: 0, paintMs: 0, gridMs: 0, chunksMs: 0 }
  let height = donorHeight
  let color = donorColor
  let colorOwn: ImageData8 | null = null
  let params = terrainParams(key)
  let customGrids: { donor: GroundGrid; ground: GroundGrid } | null = null
  if (custom) {
    let t = performance.now()
    customGrids = {
      donor: donorGroundGrid(custom.island, donorHeight),
      ground: customGroundGrid(custom),
    }
    const ramp = buildColourRamp(customGrids.donor, donorColor, params)
    customTimings.rampMs = performance.now() - t
    if (options.slice) await options.slice()
    t = performance.now()
    // The donor's own colour pitch, so a face samples the grain it would there.
    colorOwn = paintCustomColour(
      custom,
      customGrids.ground,
      ramp,
      params.terrainSize / donorColor.width,
    )
    customTimings.paintMs = performance.now() - t
    if (options.slice) await options.slice()
    height = customHeightSampler(custom)
    color = createMapSampler(colorOwn)
    params = customTerrainParams(custom, TERRAIN_SEED)
  }

  // DEV-831: the diagonal, on every path above, set once before anything reads params.
  if (options.fixDiagonal) params = { ...params, faithfulDiagonalBug: false }
  const gridStart = performance.now()
  const grid = buildVertexGrid(height, params)
  customTimings.gridMs = performance.now() - gridStart
  if (options.slice) await options.slice()
  // The terrain's own local position PLUS its environment root.
  //
  // `transform.position` is local to the LevelArt root, and for one environment
  // that root is not where you would assume: `LevelArt_Kauai` is an unpacked
  // copy sitting at (-2218, 0, -1691) under `levelOffset`, while simonet, alpine
  // and desert all have a root that coincides with the level's `worldOffset`.
  // The sheet's note asserted the coinciding case as a general fact — checked
  // where the wrong answer and the right one agree — and kauai placed without
  // this lands **2,218 m / 1,691 m** from where 2016 has it.
  //
  // `tests/unit/terrain-env-root.test.ts` proves the sum against world positions
  // measured through a different code path entirely (the scene flattener).
  const donorPos = donorTerrainPosition(entry)
  // DEV-489: a custom island is CENTRED on the donor's land, from the sum just
  // made rather than a second copy of it (`customTerrainLocal`).
  const placed = custom ? customTerrainLocal(custom, donorPos) : donorPos
  // DEV-500: a course's water moves its sea plate; both surfaces below read `terrainPos`.
  const lift = options.lift ?? 0
  const terrainPos = liftedPosition(placed, lift)
  const worldOffset = options.worldOffset ?? [0, 0, 0]
  // The COLLISION surface: the same heightmap, at the same grid, WITHOUT the
  // jitter the mesh gets. `tp`/`ts` below are the terrain's Unity-space
  // transform, which is what puts mesh space into the world.
  const heightField = buildHeightField(
    height,
    params,
    fieldTransformAt(entry, terrainPos, worldOffset),
  )
  const perSide = chunkPerSide(params)

  const group = new THREE.Group()
  group.name = `terrain:${key}`

  // The terrain's own transform is UNITY space, like the mesh it positions.
  // `chunkGeometry` has already flipped the mesh into three space, so the
  // offset flips with it — one conversion, applied to both, or the island ends
  // up mirrored relative to its own rings.
  const tp = terrainPos
  const ts = entry.transform?.scale ?? [1, 1, 1]
  const wo = worldOffset
  group.position.set(
    (wo[0] as number) + (tp[0] as number),
    (wo[1] as number) + (tp[1] as number),
    (wo[2] as number) - (tp[2] as number),
  )
  // Not always 1: the Simonet and Kauai ocean plates are (8, 1, 8), a 32 km
  // terrain stretched to 262 km so it runs past the horizon in every direction.
  group.scale.set(ts[0] as number, ts[1] as number, ts[2] as number)
  const material = terrainMaterial({
    tint: (entry.material?.tint ?? null) as TerrainMaterialSpec['tint'],
    tintIsSrgb: options.tintIsSrgb ?? true,
    shader: entry.material?.shader ?? null,
    lit: options.lit ?? 'standard',
    specular: entry.material?.specular
      ? {
          intensity: entry.material.specular.intensity ?? null,
          shininess: entry.material.specular.shininess ?? null,
          iblBrightness: entry.material.specular.iblBrightness ?? null,
          // `_SpecColor` and `_Fresnel` — the other two thirds of the Marmoset
          // F0. See `marmosetSpecularF0`.
          color: (entry.material.specular.color ?? null) as number[] | null,
          fresnel: entry.material.specular.fresnel ?? null,
        }
      : null,
  })

  // ── the illustrative warp (V7, DEV-092) ────────────────────────────────
  //
  // LAND ONLY, and the test is the same one `terrainMaterial` just used to
  // decide whether there was a Marmoset F0 — which is a FACT the sheet carries
  // rather than a guess about which terrain this is.
  //
  // BEFORE the wave patch below, so that on the ocean — where this never runs —
  // nothing about the ordering could ever matter, and on the land the warp is
  // the innermost patch in the chain. It touches `RE_Direct`, which is upstream
  // of `outgoingLight`, so it cannot collide with the fog's hook or the water's;
  // the only shared resource is `onBeforeCompile` itself, and every patch here
  // chains.
  if (isMarmosetShader(entry.material?.shader)) {
    options.applyIllustrative?.(material)
    options.applySurfaceGloss?.(material)
  }

  // ── the cross-fade (DEV-130) ──────────────────────────────────────────
  //
  // The base material is patched on EVERY preset — the injected GLSL is one
  // uniform branch that Classic never takes, so its program is one variant and
  // the picture is bit for bit the old one — and the clones that carry a live
  // fade are cut from it lazily, after `app.ts` has finished patching fog and
  // shadow onto it, which is why nothing is cloned here.
  const fadePool = createLodFadePool()
  fadePool.applyTo(material)

  // ── the waves ──────────────────────────────────────────────────────────
  //
  // Applied to the material rather than to a mesh, because every chunk of a
  // terrain SHARES one material instance — so this is one shader patch for the
  // whole ocean, and a chunk regenerated at a new LOD inherits it for free.
  //
  // `live` is checked, not assumed: the component is the only thing that sets
  // the shader's time, so a disabled one means a frozen wave rather than a
  // missing one. Land terrains have no driver at all and get null.
  const displace = (entry as { displace?: WaterDisplace | null }).displace ?? null
  const reflection = entry.material?.reflection ?? null
  // The density ladder, and the facet size each rung actually has. DEV-183 —
  // `subdivideAt` and `facetMetresAt` above say what each is and why the second
  // is not simply the first.
  const ladder = options.meshSubdivision ?? 1
  const subdivideFor = (lod: number): number => subdivideAt(ladder, lod)
  const facetMetresFor = (lod: number): number =>
    facetMetresAt(params.baseResolution, group.scale.x, ladder, lod)
  // `?swell=<metres>` retunes the wave to a wavelength the 256 m mesh can
  // actually carry. A DEVIATION, off by default. `dot(dir, freq)` promotes the
  // scalar, so the phase advances by `(dir.x + dir.y) * freq` and one wavelength
  // is `2*pi / (freq * sqrt2)` — invert that.
  const swell = options.swellWavelength ?? null
  const tuned =
    displace && swell && swell > 0
      ? { ...displace, frequency: (2 * Math.PI) / (swell * Math.SQRT2) }
      : displace
  const water = tuned?.live
    ? applyWaterWaves(material, tuned, {
        color: (reflection?.color ?? null) as number[] | null,
        fresnel: reflection?.fresnel ?? 0,
        // DEV-583: `_ReflectionDistortion` and the `V_LP_REFLECTIVE_REALTIME`
        // keyword, both read only by the flat ultra mirror
        // (`render/sea-reflection.ts`). From the sheet, never typed here.
        distortion: reflection?.distortion ?? null,
        realtime: reflection?.realtime === true,
        skySh: options.skySh ?? null,
        // THE faceting term. `_SpecColor` is (0.5, 0.5, 0.5) — a legacy
        // Blinn-Phong specular at 50 % reflectance, where a metalness-0
        // standard material gives 0.04. Twelve times too weak is the whole
        // difference between a sea with glints on every facet and a sheet of
        // flat colour.
        specColor: (entry.material?.specular?.color ?? null) as number[] | null,
        shininess: entry.material?.specular?.shininess ?? null,
        sun: options.sun ?? null,
        // One quad in WORLD metres, which is the scale the shader's derived
        // normal stops meaning anything below — see `render/water.ts`. Not a
        // constant: `baseResolution` is 32 on both ocean plates but the 8x
        // transform scale and `?ocean=<n>` both move it, so 256 m at the
        // default and 32 m at `?ocean=8`.
        //
        // This is the LOD 0 rung, and it is the BASE material's own value —
        // every other rung arrives through `water.materialFor` below, so the
        // nearest band draws with the material that was passed in and nothing
        // is cloned on a plate whose ladder is flat at one level.
        facetMetres: facetMetresFor(0),
      })
    : null
  /**
   * The material a chunk at `lod` draws with: the sea's per-facet material
   * (DEV-183), or the one shared material on a terrain with no wave.
   *
   * Memoised inside `water`, so this is a map lookup per chunk and at most one
   * clone per LOD — and every clone shares the base's compiled program, so the
   * count of programs is the count of water VARIANTS, not of rungs.
   */
  const materialForLod = (lod: number): THREE.Material =>
    water ? water.materialFor(facetMetresFor(lod)) : material
  // The plate's own origin, in UNITY space, for the whole-object bob. `tp` is
  // already the sheet's Unity-space transform position.
  const bobOrigin: [number, number, number] = [tp[0] as number, tp[1] as number, tp[2] as number]
  const groupBaseY = group.position.y
  /** DEV-500: the editor's preview offset (`setPreviewLift`); 0 in every flight. */
  let previewLift = 0
  /**
   * The plate's ceiling in world metres, before the bob and before the wave.
   *
   * DEV-167 / W6. `group.position.y` is NOT the sea level on Simonet — the
   * surface height is in the map and the group sits near the origin — and the
   * first pass of the variant switch used it, put the cheap shader on a frame
   * taken 55 m under the water, and was caught by six screenshots against
   * their own noise floor rather than by any test. `maxFieldHeight` is the
   * number that cannot be wrong about it.
   */
  const surfaceMaxY = maxFieldHeight(heightField)

  // Which chunks are worth building. See `visibleRadius`.
  const radius = options.visibleRadius ?? Number.POSITIVE_INFINITY
  const centre = options.centre ?? [0, 0, 0]
  const inRange = (cx: number, cy: number): boolean => {
    if (!Number.isFinite(radius)) return true
    // The chunk's world AABB in x/z. `chunkGeometry` flips mesh z, so a chunk at
    // mesh z [a, b] lands at world z [pos.z - scale*b, pos.z - scale*a].
    const size = params.chunkSize
    const x0 = group.position.x + group.scale.x * cx * size
    const x1 = group.position.x + group.scale.x * (cx + 1) * size
    const z1 = group.position.z - group.scale.z * cy * size
    const z0 = group.position.z - group.scale.z * (cy + 1) * size
    // Distance from the centre to the box, zero when inside it.
    const dx = Math.max(x0 - (centre[0] as number), 0, (centre[0] as number) - x1)
    const dz = Math.max(z0 - (centre[2] as number), 0, (centre[2] as number) - z1)
    return Math.hypot(dx, dz) <= radius
  }

  // ── LOD ────────────────────────────────────────────────────────────────
  //
  // `_Distances[i] = LODDistance * 2^i`, horizontal distance, 3% hysteresis.
  // See `src/sim/terrain/lod.ts` for why each of those is not an approximation.
  const bands = lodBands(
    entry.lodDistance ?? Number.POSITIVE_INFINITY,
    entry.lodLevels ?? 1,
    entry.flipFlopPercent ?? 0,
  )
  /**
   * Horizontal distance from a point to a chunk's WORLD footprint — zero when
   * the point is over the chunk. The terrain's transform and scale are already
   * applied.
   *
   * ── Why not the chunk's CENTRE, which is what 2016 used ─────────────────
   *
   * `FacetedTerrain.Start()` takes `chunk.Center = chunk.Renderers[0].bounds
   * .center` and measures to that. For the ISLANDS that is fine: a chunk is
   * 256 m against an LOD distance of 1024, so the centre is off by at most
   * 181 m and nothing changes. For the OCEAN it is ruinous. Those chunks are
   * 1024 mesh units at a scale of 8 — **8,192 m across** — against an LOD
   * distance of 1800. The centre of the chunk you are flying over is up to
   * 5.8 km away, so the water under the ship is judged three LOD bands more
   * distant than it is.
   *
   * Measured, on `int_01` at the spawn: four ocean chunks, and **not one of
   * them at LOD0** — two at LOD2 and two at LOD3, i.e. quads of 1,024 m and
   * 2,048 m where the finest the mesh offers is 256. 544 triangles of sea
   * against 115,648 of island.
   *
   * That is a DEVIATION, because 2016 shipped the centre test and therefore
   * shipped the coarse sea. It is also exactly what Matt asked for — *"the
   * ocean isn't nearly dense enough... roughly 4x denser"* — and 4x is what
   * this is: it recovers the LOD0 the generator was already able to produce
   * rather than inventing geometry. It can only ever ADD detail.
   */
  const footprint = {
    originX: group.position.x,
    originZ: group.position.z,
    scaleX: group.scale.x,
    scaleZ: group.scale.z,
    chunkSize: params.chunkSize,
  }
  const chunkDistance = (cx: number, cy: number, px: number, pz: number): number =>
    chunkFootprintDistance(footprint, cx, cy, px, pz)

  /**
   * Where the eye is at load, THREE world space, for `initialLod` — or null for
   * "every chunk at LOD 0", which is what a caller who names no camera gets.
   *
   * `cameraMesh` goes through the group's OWN placement rather than through a
   * second copy of it, and takes the z flip `chunkGeometry` applies to the mesh
   * on its way in: a mesh point at z lands at `position.z - scale.z * z`, which
   * is the same term `inRange` and `chunkFootprintDistance` build their boxes
   * out of three lines above. One conversion, one frame.
   */
  const loadCamera: readonly [number, number] | null =
    options.camera ??
    (options.cameraMesh
      ? [
          group.position.x + group.scale.x * (options.cameraMesh[0] as number),
          group.position.z - group.scale.z * (options.cameraMesh[1] as number),
        ]
      : null)

  interface ChunkSlot {
    readonly cx: number
    readonly cy: number
    readonly mesh: THREE.Mesh
    lod: number
    /**
     * The LOD a worker reply is expected for, or **null** for none.
     *
     * It was `-1` until the detail ring arrived (DEV-085), which made −1 a real
     * level and the sentinel a live collision: a chunk waiting for its detail
     * mesh would have read as "nothing requested", been requested again every
     * frame, and its reply dropped by the `requested !== reply.lod` guard —
     * a worker generating four times the geometry forever, for a chunk that
     * never changed. `null` cannot be a level.
     */
    requested: number | null
    /**
     * A cross-fade in progress (DEV-130), or null. While it is set the chunk
     * draws twice — `mesh` with the outgoing clone, `fade.incoming` with the
     * incoming one — and `updateLod` will not ask it to move again, exactly as
     * 2016's `SlowUpdate` considered only `Idle` chunks. `lod` already says the
     * level it is going TO.
     */
    fade: {
      readonly incoming: THREE.Mesh
      readonly pair: LodFadePair
      readonly seconds: number
      t: number
    } | null
    /**
     * DEV-904: this chunk is drawn by a band of the batcher, and `mesh` is
     * hidden for that reason. Tracked here because `mesh.visible` is also
     * written by others (the launch bore hides its chunks one at a time), so
     * "put it back" may only undo what the batcher did itself.
     */
    batched: boolean
  }
  const slots = new Map<string, ChunkSlot>()

  // ── shadows (DEV-086) ──────────────────────────────────────────────────
  //
  // WHICH terrain this is, derived rather than asked: the ocean is the terrain
  // with a live `LowPoly_Displace`, which is the same fact `water` above is. A
  // `key.endsWith('ocean')` test would be a second way of knowing one thing, and
  // `environmentTerrains` has already paid for that once (kauai names its land
  // `terrain`, not `islands`).
  const shadowRole: ShadowRole = water ? 'ocean-chunk' : 'terrain-chunk'
  let shadowsOn = false
  const applySlotShadow = (slot: ChunkSlot): void => {
    const flags = shadowFlagsFor(shadowRole, shadowsOn, slot.lod)
    slot.mesh.castShadow = flags.cast
    slot.mesh.receiveShadow = flags.receive
    if (slot.fade) {
      slot.fade.incoming.castShadow = flags.cast
      slot.fade.incoming.receiveShadow = flags.receive
    }
  }

  // ── the batches (DEV-904, DEV-193 made a mode) ─────────────────────────
  //
  // The LAND's chunk grid is drawn by one `BatchedMesh` per LOD
  // (`render/chunk-batch.ts` owns the slot arithmetic). The CHUNK MESH stays
  // the truth: it keeps its geometry, material and LOD, and the band holds a
  // copy of the geometry for as long as the chunk is placed. So everything
  // below that already reads or writes `slot.mesh` (the bake, the fade, the
  // bore, `dispose`) is still right, and the only new rule is `settle`: after
  // anything that changes what a chunk IS, ask where it should be drawn.
  //
  //   plain geometry at a settled LOD  -> in its band, `mesh.visible = false`
  //   cross-fading (DEV-130)           -> OUT of the band, both halves draw
  //                                       alone with their own `uLodFade`
  //                                       clone; `finishFade` rejoins it
  //   excluded (the launch bore)       -> alone, `frame.ts` owns its `visible`
  //   its band is full                 -> alone
  //
  // Every row of that table degrades to "a few more draw calls", never a hole,
  // and the sea is never batched (DEV-193 section 3d: 57 MB repacked to save
  // two draws).
  let batcher: ChunkBatcher | null = null
  let batchSynced = false
  let batchOn = true
  let batchExcluded: ReadonlySet<string> = new Set()
  const batchCapacities = new Map<string, number>()
  /** Quads along a chunk at `lod`, or null for a level this terrain does not have. */
  const batchQuads = (lod: number): number | null => {
    if (lod >= 0) {
      if (lod > bands.distances.length - 1) return null
      const quads = (params.chunkSize / params.baseResolution) >> lod
      return quads >= 1 ? quads : null
    }
    const spec = options.detailRing?.() ?? null
    if (!spec || !detailBand(spec, params, bands.hysteresis)) return null
    return params.chunkSize / spec.baseResolution
  }
  /**
   * Slots for `lod`: the most chunks any eye position could put in it, measured.
   *
   * DEV-193 section 3d priced the choice: 35 MB at zero headroom, 76 MB for a
   * LOD 0 band that could hold every chunk. This is neither. For every eye on a
   * lattice over the terrain and as far past its edge as the band reaches, count
   * the chunks whose footprint distance puts them in the band (hysteresis
   * included, so a chunk the ladder has not yet moved is still counted), and
   * reserve the largest count plus a margin for chunks waiting on the worker.
   * The outermost band is unbounded above, so it holds the grid.
   *
   * A full band is not a failure (the chunk draws alone), so the margin is
   * about not paying draw calls, not about correctness.
   */
  const batchCapacity = (lod: number): number => {
    const list = [...slots.values()]
    const last = bands.distances.length - 1
    if (lod >= last) return list.length
    const spec = options.detailRing?.() ?? null
    const h = bands.hysteresis
    const outer =
      lod < 0 ? (spec?.radius ?? 0) * (1 + h) : (bands.distances[lod] as number) * (1 + h)
    const inner = lod <= 0 ? 0 : (bands.distances[lod - 1] as number) * (1 - h)
    const key = `${lod}:${list.length}:${outer}`
    const known = batchCapacities.get(key)
    if (known !== undefined) return known
    const step = (params.chunkSize * group.scale.x) / 2
    const x0 = group.position.x - outer
    const x1 = group.position.x + group.scale.x * perSide * params.chunkSize + outer
    const z1 = group.position.z + outer
    const z0 = group.position.z - group.scale.z * perSide * params.chunkSize - outer
    const eyes = function* (): Generator<readonly [number, number]> {
      for (let x = x0; x <= x1; x += step) for (let z = z0; z <= z1; z += step) yield [x, z]
    }
    const slotsNeeded = bandCapacity(eyes(), list, chunkDistance, (d) => d <= outer && d >= inner, {
      ratio: 1.15,
      slots: 2,
    })
    batchCapacities.set(key, slotsNeeded)
    return slotsNeeded
  }
  if (options.chunkBatch === true && !water) {
    batcher = createChunkBatcher({
      material: materialForLod(0),
      parent: group,
      vertexCount: (lod) => {
        const quads = batchQuads(lod)
        return quads === null
          ? null
          : chunkTriangles(params.chunkSize, params.chunkSize / quads) * 3
      },
      capacity: batchCapacity,
      flags: (lod) => shadowFlagsFor(shadowRole, shadowsOn, lod),
    })
  }
  const batchWanted = (slot: ChunkSlot): boolean =>
    batchOn && slot.fade === null && !batchExcluded.has(slot.mesh.name)
  /**
   * Put a chunk where it should be drawn, given what it is now. Call after any
   * change to its geometry, LOD or fade state.
   */
  const settle = (slot: ChunkSlot): void => {
    if (!batcher || !batchSynced) return
    const id = slot.mesh.name
    if (batchWanted(slot) && batcher.place(id, slot.lod, slot.mesh.geometry)) {
      slot.mesh.visible = false
      slot.batched = true
      return
    }
    batcher.release(id)
    if (slot.batched) {
      slot.mesh.visible = true
      slot.batched = false
    }
  }
  const batchSync = (): ChunkBatchReport | null => {
    if (!batcher) return null
    batchSynced = true
    batchOn = true
    const items: { id: string; lod: number; geometry: THREE.BufferGeometry }[] = []
    for (const slot of slots.values()) {
      if (batchWanted(slot)) {
        items.push({ id: slot.mesh.name, lod: slot.lod, geometry: slot.mesh.geometry })
      }
    }
    // Every band the ladder has, and the detail ring's when the preset has one,
    // so each is allocated here and drawn once under the curtain rather than
    // created in flight.
    const levels: number[] = []
    if (batchQuads(-1) !== null) levels.push(-1)
    for (let lod = 0; lod < bands.distances.length; lod++) levels.push(lod)
    const placed = batcher.sync(items, levels)
    for (const slot of slots.values()) {
      if (placed.has(slot.mesh.name)) {
        slot.mesh.visible = false
        slot.batched = true
      } else if (slot.batched) {
        slot.mesh.visible = true
        slot.batched = false
      }
    }
    return batcher.report()
  }
  const batchSet = (on: boolean): ChunkBatchReport | null => {
    if (!batcher) return null
    if (on) return batchSync()
    batchOn = false
    for (const slot of slots.values()) {
      batcher.release(slot.mesh.name)
      if (slot.batched) {
        slot.mesh.visible = true
        slot.batched = false
      }
    }
    return batcher.report()
  }
  const unsubscribeBake = batcher
    ? options.onBakeChange?.(() => {
        if (batchSynced && batchOn) batchSync()
      })
    : undefined

  /**
   * End a fade: the incoming geometry becomes the chunk's, the transient mesh
   * goes, both clones return to the pool. Also the path `dispose` takes.
   */
  const finishFade = (slot: ChunkSlot): void => {
    const fade = slot.fade
    if (!fade) return
    slot.fade = null
    slot.mesh.geometry.dispose()
    slot.mesh.geometry = fade.incoming.geometry
    // `slot.lod` is the level the fade was going TO, so this settles on the
    // material that matches the geometry just adopted. It was the one shared
    // material until DEV-183, which was right while there was only one.
    slot.mesh.material = materialForLod(slot.lod)
    group.remove(fade.incoming)
    fadePool.release(fade.pair)
    applySlotShadow(slot)
    // DEV-904: the fade is over, so the chunk is plain geometry at a settled LOD
    // again: back into the band for the level it landed on.
    settle(slot)
  }

  const advanceFades = (dt: number): void => {
    if (!(dt > 0)) return
    for (const slot of slots.values()) {
      const fade = slot.fade
      if (!fade) continue
      fade.t += dt
      if (fade.t >= fade.seconds) finishFade(slot)
      else fade.pair.setCoverage(fade.t / fade.seconds)
    }
  }

  let triangleCount = 0
  // Which LOD each built chunk landed on. Worth reporting: the ocean's chunks
  // are 8 km across, so "distance to the chunk CENTRE" can call a chunk you are
  // flying over four kilometres away. Without this the only symptom is a sea
  // that looks low-poly, which reads as art.
  const lodHistogram: Record<number, number> = {}
  let built = 0
  const total = perSide * perSide
  // DEV-489's receipt: wall time, so it includes the frames the slices let through.
  const chunksStart = performance.now()

  // ── the rings (DEV-339), and which of the two seas is built ───────────────
  //
  // `options.rings` is the preset's `terrain.oceanRings`. Built the first time
  // they are asked for (at load when the preset has them on, otherwise by
  // `rings.set(true)`, the live switch the A-B-A measurement flips) and never
  // again; the plate's chunks are built at load unless the rings are, and by
  // `rings.set(false)` if the rings were first. Exactly one of the two draws.
  const ringsSpec = water ? (options.rings ?? null) : null
  let ringsObj: OceanRings | null = null
  let ringsOn = false
  let ringsReason: string | null = null
  let plateBuilt = false
  let lastEye: readonly [number, number] = loadCamera ?? [centre[0] as number, centre[2] as number]
  /** The sea's one colour, or null when the colour map is not one colour (the rings carry one). */
  const uniformSeaColour = (): [number, number, number] | null => {
    const rgb = { r: 0, g: 0, b: 0 }
    color.sample(0.5, 0.5, rgb)
    const ref: [number, number, number] = [rgb.r, rgb.g, rgb.b]
    for (let i = 0; i < 48; i++) {
      for (let j = 0; j < 48; j++) {
        color.sample((i + 0.5) / 48, (j + 0.5) / 48, rgb)
        if (
          Math.abs(rgb.r - ref[0]) > 1e-6 ||
          Math.abs(rgb.g - ref[1]) > 1e-6 ||
          Math.abs(rgb.b - ref[2]) > 1e-6
        ) {
          return null
        }
      }
    }
    return ref
  }
  /** Build the rings if they can be. Sets `ringsReason` when they cannot. */
  const ensureRings = (): boolean => {
    if (ringsObj) return true
    if (!water || !ringsSpec) {
      ringsReason = water ? 'no ladder in the preset' : 'no sea here'
      return false
    }
    if (custom) {
      ringsReason = 'a player ground'
      return false
    }
    const colour = uniformSeaColour()
    if (!colour) {
      ringsReason = 'the sea colour map is not one colour'
      return false
    }
    try {
      ringsObj = createOceanRings({
        grid,
        heightMap: height,
        params,
        group,
        water,
        ladder: ringsSpec.ladder,
        colour,
        reach: {
          x: centre[0] as number,
          z: centre[2] as number,
          radius: Number.isFinite(radius) ? radius : 8192,
        },
      })
    } catch (e) {
      ringsReason = e instanceof Error ? e.message : String(e)
      return false
    }
    // The shipped draw order (DEV-241), by the same door as the chunks.
    setOceanLate(ringsObj.object, true)
    ringsObj.follow(lastEye[0], lastEye[1])
    if (ringsSpec.faceNormals) ringsObj.setNormals('face')
    return true
  }
  const setPlateVisible = (visible: boolean): void => {
    for (const slot of slots.values()) {
      slot.mesh.visible = visible
      if (slot.fade) slot.fade.incoming.visible = visible
    }
  }
  const ringsFirst = ringsSpec?.enabled === true && ensureRings()
  if (ringsFirst) ringsOn = true

  const buildPlate = async (eye: readonly [number, number] | null): Promise<void> => {
    plateBuilt = true
    for (let cx = 0; cx < perSide; cx++) {
      for (let cy = 0; cy < perSide; cy++) {
        if (!inRange(cx, cy)) {
          options.onProgress?.((cx * perSide + cy + 1) / total)
          continue
        }
        built++
        const lod = eye ? initialLod(bands, chunkDistance(cx, cy, eye[0], eye[1])) : 0
        const chunk = generateChunk(grid, color, height, params, cx, cy, lod)
        const subdivide = subdivideFor(lod)
        const initialGeometry = chunkGeometry(chunk, subdivide, params.randomOffset)
        options.bakeGeometry?.(initialGeometry)
        const mesh = new THREE.Mesh(initialGeometry, materialForLod(lod))
        mesh.name = `chunk_${cx}_${cy}`
        // Vertices are already in world space — the generator offsets by chunk
        // origin itself, because the 2016 bake did and the oracle compares
        // absolute coordinates.
        group.add(mesh)
        slots.set(`${cx},${cy}`, { cx, cy, mesh, lod, requested: null, fade: null, batched: false })
        triangleCount += chunk.triangleCount * subdivide * subdivide
        lodHistogram[lod] = (lodHistogram[lod] ?? 0) + 1
        options.onProgress?.((cx * perSide + cy + 1) / total)
        if (options.slice) await options.slice()
      }
    }
    // The hidden-plate case: a plate built while the rings draw stays hidden.
    if (ringsOn) setPlateVisible(false)
  }
  if (ringsFirst) {
    // The rings are the sea; the plate is built only if somebody turns them off.
    options.onProgress?.(1)
  } else {
    await buildPlate(loadCamera)
  }

  // ── the sea after the land, which is the SHIPPED order (DEV-241) ───────
  //
  // Only a water terrain, and only once the chunks exist. three sorts opaques
  // `groupOrder -> renderOrder -> material.id -> z`, so with both at 0 the sea
  // and the island were ordered by which material was CONSTRUCTED first — an
  // accident of this file, and one that put **93 % of the sea's triangles
  // before the land that hides most of them** (DEV-238 §2). Early-Z then
  // rejected nothing and every one of those fragments ran the whole water
  // stack. A positive `renderOrder` is the whole of the fix; wave 4 §3.5
  // measured -0.46 ms p50 on `adv_02_jumpSeat` and -0.19 on kauai for it, and
  // never negative on any mission.
  //
  // Through `setOceanLate` rather than by writing the number here, so that
  // `__ff2.drawOrderSwitch('ocean', false)` restores the order these meshes
  // were BUILT at instead of a second copy of it (`render/draw-order.ts`).
  customTimings.chunksMs = performance.now() - chunksStart
  if (water) setOceanLate(group, true)

  // ── the worker ─────────────────────────────────────────────────────────
  //
  // Started only if there is more than one LOD to move between. A terrain with
  // a single level never needs regeneration, and a worker that exists to do
  // nothing is a worker that can still go wrong.
  let worker: Worker | null = null
  let nextRequestId = 1
  let pending = 0
  // Detail requests are counted separately from `pending`, and the cap is on
  // this one. One counter for both would let a burst of ordinary LOD 1 -> 0
  // regenerations starve the ring, and a full ring starve them — and the second
  // of those is a regression the player CAN see, caused by an addition.
  let detailPending = 0
  const detailRing = options.detailRing ?? null
  const lodFade = options.lodFade ?? null
  /**
   * Replies that have come back and not yet been swapped in. DEV-242.
   *
   * Oldest first, and drained oldest first, because a chunk that has been
   * waiting longest is the one whose picture is furthest out of date.
   */
  const arrivals: TerrainWorkerReply[] = []
  /**
   * Swap in as many arrivals as this frame's budget allows.
   *
   * A binding rather than a function because the whole worker half is
   * conditional: a single-band terrain with no ring never starts a worker, so
   * it can never have an arrival, and a no-op is the honest shape for that
   * rather than a queue nothing can ever push to.
   */
  let drainArrivals: () => void = () => {}

  // DEV-339: a function, because with the rings first no chunk exists and the
  // worker (and the 8 MB of map it clones at `init`) has nothing to generate;
  // it starts when the plate is first built instead.
  const startWorker = (): void => {
    if (worker || !((options.lodUpdates ?? true) && (bands.distances.length > 1 || detailRing))) {
      return
    }
    worker = new Worker(new URL('./terrain.worker.ts', import.meta.url), { type: 'module' })
    // DEV-489: a player's ground sends its float grid and its painted colours,
    // and the worker reads each by its shape (`TerrainWorkerInit`).
    const init: TerrainWorkerInit =
      custom && colorOwn
        ? {
            type: 'init',
            params,
            height: { f32: custom.heights },
            color: colorOwn,
            colorIsOwn: true,
          }
        : { type: 'init', params, height: heightImg, color: colorImg }
    worker.postMessage(init)
    // ── the arrival queue, DEV-242 ────────────────────────────────────
    //
    // A reply no longer becomes a mesh in the task that receives it. It waits
    // here until `updateLod` has budget for it, so a burst of replies landing
    // in one gap between frames cannot all be swapped in before the next one.
    //
    // A queued arrival is **still PENDING and is NOT fading**: `slot.requested`
    // stays set and `slot.fade` stays null until it drains, so the chunk goes
    // on drawing the LOD it already had — which is exactly what it did while
    // the request was in flight. Nothing a player can see distinguishes the two
    // states, and the trace's two columns keep meaning what their comments in
    // `boot/perf-trace.ts` say they mean.
    worker.onmessage = (event: MessageEvent<TerrainWorkerReply>) => {
      arrivals.push(event.data)
    }

    /**
     * Turn one arrived reply into the chunk's new geometry, or drop it.
     *
     * Everything below used to run inside `onmessage`. The one thing that is
     * genuinely different is the first statement of the build: the worker has
     * already subdivided, flipped and measured the chunk (DEV-242), so this is
     * four `BufferAttribute` constructors over transferred buffers instead of
     * two full allocations and four passes.
     */
    const applyArrival = (reply: TerrainWorkerReply): void => {
      pending--
      // Unconditional, and before the drop test: a reply we no longer want is
      // still a request that has come back, and a cap that only decremented on
      // the replies it applied would close the ring permanently after the first
      // time the camera outran the worker.
      if (reply.lod < 0) detailPending--
      const slot = slots.get(`${reply.chunkX},${reply.chunkY}`)
      // A reply for a LOD we have since changed our mind about is dropped. The
      // camera can outrun the worker, and applying a stale mesh would make the
      // terrain visibly step backwards.
      if (!slot || slot.requested !== reply.lod) return
      slot.requested = null
      // The ring can be turned off — a flip to Classic, or quality dropped to
      // `low` — while a detail mesh is in flight. Applying it then would draw
      // four times the geometry on a preset that has asked for none. Dropping it
      // leaves `slot.lod` where it was, which is the LOD 0 mesh still on screen,
      // so the next `updateLod` sees nothing to do.
      if (reply.lod < 0 && !detailBand(detailRing?.() ?? null, params, bands.hysteresis)) return
      // Until this line the chunk has gone on drawing the mesh it already had —
      // so a pending detail chunk, or one waiting in the arrival queue, shows
      // its old geometry and never a hole.
      //
      // DEV-242: the worker did the subdivision, the flip and the sphere, so
      // this wraps its transferred buffers and copies nothing. It used to be
      // `chunkGeometry(reply, subdivideFor(reply.lod), jitterFor(reply.lod))`,
      // which for an ocean chunk at LOD 0 meant 443,904 vertices allocated
      // twice and walked four times, here, on the main thread.
      const geometry = chunkGeometryFromArrays(reply)
      // DEV-232: a chunk that lands while the bake is on has to ARRIVE baked.
      // Re-baking the group afterwards would leave every streamed chunk drawing
      // its raw albedo unlit for a frame or two at 180 m/s.
      options.bakeGeometry?.(geometry)
      // ── the cross-fade, or the swap (DEV-130) ─────────────────────────
      //
      // Read fresh at every reply, like the ring: a preset flip mid-flight
      // takes effect on the next chunk that lands. `lodFadeSeconds` is null on
      // Classic, on a terrain the sheet gives no `lodTransitionTime`, and at
      // `durationScale` 0 — and the pool returns null at its cap — so every one
      // of those is the swap in one assignment, exactly as before.
      const seconds = lodFadeSeconds(lodFade?.() ?? null, entry.lodTransitionTime)
      // ── which material the pair is cut from (DEV-183) ──────────────────
      //
      // The INCOMING level's, because the incoming mesh is the one that stays:
      // it settles into `slot.mesh` at `finishFade` and draws for as long as
      // the chunk is at that level, while the outgoing mesh is dithered away
      // over `lodTransitionTime`. A pair cannot straddle two materials —
      // `acquire` cuts both clones from one base — so for the second of the
      // fade the OUTGOING mesh carries the incoming band's facet, one rung out.
      // Before DEV-183 both carried the LOD 0 facet for ever.
      const fadeBase = materialForLod(reply.lod)
      if (seconds) fadePool.adopt(fadeBase)
      const pair = seconds ? fadePool.acquire(fadeBase) : null
      if (pair && seconds) {
        // A fade never lands on a fade: `updateLod` skips a fading slot, so by
        // the time a reply arrives the previous transition is finished.
        const incoming = new THREE.Mesh(geometry, pair.incoming)
        incoming.name = `${slot.mesh.name}${LOD_FADE_SUFFIX}`
        // The slot's own order, not three's default. On the SEA that is
        // DEV-241's `renderOrder` 1, and a pair whose two halves straddled the
        // land would dither one of them against a depth buffer the other had
        // not written — the cross-fade is two draws of one chunk and they have
        // to sort together. Copied rather than re-derived so this is right
        // under the A/B arm too, where the slot is back at the land's order.
        incoming.renderOrder = slot.mesh.renderOrder
        slot.mesh.material = pair.outgoing
        group.add(incoming)
        pair.setCoverage(0)
        slot.fade = { incoming, pair, seconds, t: 0 }
        slot.lod = reply.lod
        applySlotShadow(slot)
        // DEV-904: a fading chunk leaves its band. Both halves draw alone with
        // their own clone of the material until `finishFade` rejoins it.
        settle(slot)
        return
      }
      slot.mesh.geometry.dispose()
      slot.mesh.geometry = geometry
      slot.lod = reply.lod
      // The LOD just moved, so whether this chunk casts just moved with it.
      applySlotShadow(slot)
      // DEV-904: and which band it belongs in, which moved with the geometry.
      settle(slot)
    }

    drainArrivals = (): void => {
      // The early return is what keeps this free on the overwhelming majority
      // of frames: `updateLod` runs once per terrain per frame, so anything
      // unconditional here is ~180 allocations a second on a flight where
      // nothing has arrived.
      if (arrivals.length === 0) return
      const take = planChunkDrain(arrivals.map((reply) => reply.positions.length / 3))
      for (let i = 0; i < take; i++) applyArrival(arrivals.shift() as TerrainWorkerReply)
    }
  }
  if (!ringsFirst) startWorker()

  /**
   * `RandomOffset` for a reply's level, which only the SUBDIVIDE path reads.
   *
   * Unreachable in practice — subdivision is the ocean's and the ocean has no
   * ring — but a detail mesh re-jittered at the base terrain's amplitude would
   * be the exact bug `jitterScale` exists to prevent, and getting it right here
   * costs a function.
   */
  function jitterFor(lod: number): number {
    if (lod >= 0) return params.randomOffset
    const spec = detailRing?.() ?? null
    return spec ? params.randomOffset * spec.jitterScale : params.randomOffset
  }

  // ── the rest of the plate (DEV-498) ────────────────────────────────────
  //
  // See `farSea` on the interface. Every chunk `inRange` skipped, generated by
  // the same `generateChunk` the built ones came from, at `initialLod` of its
  // distance from the centre — the LOD the chunk would take from an eye there,
  // so its edge meets the built sea's far chunks at their own facet size — and
  // merged per LOD, because every chunk at one LOD shares one material (the
  // water's per-facet clone, which delegates to the base's patches and shares
  // its program). The chunk skirts close the T-junctions with the built sea,
  // as they do between any two LODs. Static: it never re-selects a LOD.
  let farSeaGroup: THREE.Group | null = null
  const farSeaMeshes: { mesh: THREE.Mesh; lod: number }[] = []
  const buildFarSea = (build = true): THREE.Group | null => {
    if (farSeaGroup || !build) return farSeaGroup
    if (!water || !Number.isFinite(radius)) return null
    const byLod = new Map<number, THREE.BufferGeometry[]>()
    for (let cx = 0; cx < perSide; cx++) {
      for (let cy = 0; cy < perSide; cy++) {
        if (slots.has(`${cx},${cy}`)) continue
        // DEV-339: the rings cover what the built chunks would have.
        if (ringsOn && inRange(cx, cy)) continue
        const lod = initialLod(
          bands,
          chunkDistance(cx, cy, centre[0] as number, centre[2] as number),
        )
        const chunk = generateChunk(grid, color, height, params, cx, cy, lod)
        const list = byLod.get(lod) ?? []
        list.push(chunkGeometry(chunk, subdivideFor(lod), params.randomOffset))
        byLod.set(lod, list)
      }
    }
    const far = new THREE.Group()
    far.name = 'far-sea'
    for (const [lod, list] of [...byLod.entries()].sort((a, b) => a[0] - b[0])) {
      const mesh = new THREE.Mesh(mergeSoup(THREE, list), materialForLod(lod))
      mesh.name = `far-sea_lod${lod}`
      for (const g of list) g.dispose()
      const flags = shadowFlagsFor(shadowRole, shadowsOn, lod)
      mesh.castShadow = flags.cast
      mesh.receiveShadow = flags.receive
      far.add(mesh)
      farSeaMeshes.push({ mesh, lod })
    }
    group.add(far)
    // The built sea's draw order, by the same door (`render/draw-order.ts`).
    setOceanLate(far, true)
    farSeaGroup = far
    return far
  }

  return {
    key,
    group,
    // The ONE material every chunk's material is cut from. See `materials`.
    materials: [material],
    params,
    // DEV-339: what DRAWS. With the rings on there are no chunks and the
    // triangles are the rings' live ones; `built` and `triangleCount` are the
    // plate's own and stay readable through `lodHistogram`.
    get chunkCount() {
      return ringsOn ? 0 : built
    },
    get triangleCount() {
      return ringsOn && ringsObj ? ringsObj.live() : triangleCount
    },
    lodHistogram,
    water,
    rings: ringsSpec
      ? {
          wanted: ringsSpec.enabled,
          get on() {
            return ringsOn
          },
          get reason() {
            return ringsReason
          },
          get submitted() {
            return ringsObj?.submitted ?? 0
          },
          live: () => ringsObj?.live() ?? 0,
          get cellMetres() {
            return ringsObj?.cellMetres ?? []
          },
          get bytes() {
            return ringsObj?.bytes ?? 0
          },
          get normals() {
            return ringsObj?.normals ?? (ringsSpec.faceNormals ? 'face' : 'derived')
          },
          setNormals(mode: 'derived' | 'face') {
            if (!ensureRings() || !ringsObj) return false
            ringsObj.setNormals(mode)
            return true
          },
          async set(on: boolean) {
            if (on) {
              if (!ensureRings() || !ringsObj) {
                return { on: ringsOn, reason: ringsReason, triangles: triangleCount }
              }
              ringsReason = null
              ringsObj.object.visible = true
              ringsObj.follow(lastEye[0], lastEye[1])
              setPlateVisible(false)
              ringsOn = true
            } else {
              if (!plateBuilt) {
                startWorker()
                await buildPlate(lastEye)
              }
              setPlateVisible(true)
              if (ringsObj) ringsObj.object.visible = false
              ringsOn = false
            }
            return {
              on: ringsOn,
              reason: ringsReason,
              triangles: ringsOn && ringsObj ? ringsObj.live() : triangleCount,
            }
          },
        }
      : null,
    heightField,
    heightMap: height,
    colorMap: color,
    surfaceGrid: grid,
    custom:
      custom && customGrids
        ? { ground: custom, donorHeight, grids: customGrids, timings: customTimings }
        : null,
    subdivisionAt: (lod: number) => subdivideFor(lod),
    restY: groupBaseY,
    highWater: highWaterOf(water ? water.displace : null, bobOrigin),

    setPreviewLift(metres: number): void {
      previewLift = Number.isFinite(metres) ? metres : 0
      group.position.y = groupBaseY + previewLift
    },

    setWaveTime(seconds: number, eyeY?: number): void {
      if (!water) return
      water.setTime(seconds)
      // `LowPoly_Displace.Update()` moves the TRANSFORM too, by the same wave
      // evaluated at the object's origin. See `render/water.ts` — it is an
      // artifact of a sample script attached to the water instead of to
      // something floating on it, and it is what shipped.
      group.position.y = groupBaseY + previewLift + water.bobAt(seconds, bobOrigin)
      // ── and the sea's shader variant, DEV-167 / W6 ──────────────────────
      //
      // HERE rather than in a setter of its own, because the sea level the
      // decision needs is the line above: `groupBaseY` plus this frame's bob.
      // A second entry point would either recompute it or take it on trust,
      // and this one already owns it.
      // The plate's CEILING plus this frame's bob — not `group.position.y`,
      // which on Simonet is near the origin while the sea is at 116 m. The bob
      // is the difference the line above just applied.
      if (eyeY !== undefined) {
        water.setEyeHeight(eyeY, surfaceMaxY + (group.position.y - groupBaseY))
      }
    },

    setShadows(on: boolean): void {
      shadowsOn = on
      for (const slot of slots.values()) applySlotShadow(slot)
      // DEV-904: a band's cast flag is the LOD's, so it follows the switch too.
      batcher?.refreshFlags()
      for (const f of farSeaMeshes) {
        const flags = shadowFlagsFor(shadowRole, on, f.lod)
        f.mesh.castShadow = flags.cast
        f.mesh.receiveShadow = flags.receive
      }
    },

    farSea: buildFarSea,

    updateLod(cameraX: number, cameraZ: number, frameSeconds = 0): number {
      lastEye = [cameraX, cameraZ]
      // DEV-339: the rings follow the eye and the plate's chunks, hidden, do not
      // stream. Nothing is queued, faded or drained while they draw.
      if (ringsOn && ringsObj) {
        ringsObj.follow(cameraX, cameraZ)
        return 0
      }
      if (!worker) return 0
      // The fades first, so a chunk whose transition ends this frame is free
      // to be re-selected below in the same call.
      advanceFades(frameSeconds)
      // Then this frame's share of whatever has arrived (DEV-242). AFTER the
      // fades, because a fade started here must not be advanced by the same
      // frame's `dt` — it would skip its first `frameSeconds` of dither and
      // `setCoverage` would open at a step rather than at zero. BEFORE the
      // selection, because a chunk that drains here has its `fade` set and is
      // then correctly skipped by the loop below, exactly as one that was
      // already fading is.
      drainArrivals()
      // Read the ring FRESH every call. The preset flips from the pause menu and
      // so does the quality setting; a spec captured at load is a ring that
      // stays on after the player turned it off.
      const spec = detailRing?.() ?? null
      const band = detailBand(spec, params, bands.hysteresis)
      let queued = 0
      // Detail requests are collected rather than posted, because the cap has to
      // see all of them before it picks. Everything at LOD 0 and above posts
      // immediately, exactly as it did.
      //
      // Allocated LAZILY, and this is a hot path: `updateLod` runs once per
      // terrain per frame, so an array built unconditionally is 180 a second on
      // a preset that will never put anything in one. Classic allocates nothing
      // here, exactly as before.
      let wanted: DetailCandidate[] | null = null
      for (const slot of slots.values()) {
        if (slot.requested !== null || slot.fade !== null) continue
        const distance = chunkDistance(slot.cx, slot.cy, cameraX, cameraZ)
        const want = selectLod(bands, distance, slot.lod, band)
        if (want === slot.lod) continue
        if (want < 0) {
          wanted ??= []
          wanted.push({ cx: slot.cx, cy: slot.cy, distance })
          continue
        }
        slot.requested = want
        pending++
        queued++
        worker.postMessage({
          type: 'chunk',
          id: nextRequestId++,
          chunkX: slot.cx,
          chunkY: slot.cy,
          lod: want,
          // DEV-242: the worker subdivides, so it has to be told by how much.
          // `subdivideFor` reads `ladder`, which is fixed at `loadTerrain`, so
          // asking at request time and asking at reply time give the same
          // answer — see `TerrainWorkerRequest.subdivide`.
          subdivide: subdivideFor(want),
          jitter: jitterFor(want),
        })
      }
      // ── the ring, nearest first and no more than `maxInFlight` ──────────
      //
      // Note what is NOT here: a chunk LEAVING the ring is a `want` of 0 and
      // goes out on the uncapped path above. Detail can be rationed; giving
      // detail back cannot, or a ship that outruns the queue leaves a trail of
      // four-times-denser chunks behind it that nothing ever collects.
      if (spec && wanted) {
        for (const c of planDetailRequests(wanted, detailPending, spec.maxInFlight)) {
          const slot = slots.get(`${c.cx},${c.cy}`)
          if (!slot) continue
          slot.requested = -1
          pending++
          detailPending++
          queued++
          worker.postMessage({
            type: 'chunk',
            id: nextRequestId++,
            chunkX: c.cx,
            chunkY: c.cy,
            lod: -1,
            detail: spec,
            // The ring is land-only and land is never subdivided, so this is 1
            // in every reachable case — sent anyway, because `subdivideFor`
            // and `jitterFor` are the two functions that know, and a `?? 1`
            // default in the worker standing in for a call site that forgot is
            // the shape of a bug that looks like flat water.
            subdivide: subdivideFor(-1),
            jitter: jitterFor(-1),
          })
        }
      }
      return queued
    },

    /**
     * Chunks requested and not yet drawing — in flight to the worker PLUS
     * arrived and waiting for a frame's budget (DEV-242).
     *
     * Both halves, because the column this feeds (`terr_pending` /
     * `sea_pending`) means *"a chunk is on its way and the picture has not
     * caught up yet"*, and a reply sitting in `arrivals` is exactly that. If
     * this returned only the in-flight half, the arrival queue would be a way
     * of making the trace's own streaming columns read zero while streaming was
     * still happening — an instrument quietly made blind by the fix for the
     * thing it was built to see.
     *
     * `pending` itself is decremented in `applyArrival`, so the sum counts each
     * request exactly once whichever half it is in.
     */
    get pending() {
      return pending + arrivals.length
    },

    get detailChunks() {
      let n = 0
      for (const slot of slots.values()) if (slot.lod < 0) n++
      return n
    },

    get detailPending() {
      return detailPending
    },

    get lodLive() {
      const counts: Record<number, number> = {}
      for (const slot of slots.values()) counts[slot.lod] = (counts[slot.lod] ?? 0) + 1
      return counts
    },

    get fadingChunks() {
      let n = 0
      for (const slot of slots.values()) if (slot.fade) n++
      return n
    },

    warmLodFade() {
      // ── DEV-904: the programs batching leaves to individual meshes ───────
      //
      // A placed chunk's mesh is hidden, so `warmWorld`'s draw would never reach
      // it, and with it the two programs a batched terrain still needs: the
      // fade's clone (below) and the BASE material drawn as a plain mesh (a
      // chunk whose band is full, a bore chunk, or a fade that has just
      // finished and not yet rejoined). Both would first compile in flight, in
      // the seat. So the warm shows one chunk with the base material and, where
      // fades exist, one with the clone, and puts them back as found.
      const shown: { mesh: THREE.Mesh; visible: boolean }[] = []
      const show = (mesh: THREE.Mesh): void => {
        shown.push({ mesh, visible: mesh.visible })
        mesh.visible = true
      }
      const all = [...slots.values()]
      // A CASTING chunk where there is one: the shadow pass's depth program for a
      // plain mesh is a third program of its own, and the first fade of a LOD 0
      // chunk would compile it in the air (found by `chunk-batch.spec.ts`: one
      // `depth` program appearing during the churn, and none with batching off,
      // where the warm drew plain casting chunks anyway).
      const baseSlot =
        batcher && batchSynced
          ? (all.find((s) => s.batched && s.mesh.castShadow) ?? all.find((s) => s.batched))
          : undefined
      if (baseSlot) show(baseSlot.mesh)
      // Nothing to warm where nothing can fade: Classic, a terrain the sheet
      // gives no `lodTransitionTime`, `durationScale` 0, or a single-band
      // terrain that never changes LOD at all. Each of those is the swap path,
      // which never cuts a clone — so a warm would compile a program the run
      // cannot reach and the log would say `+1` about nothing.
      const seconds = lodFadeSeconds(lodFade?.() ?? null, entry.lodTransitionTime)
      const cloneSlot = seconds
        ? (all.find((s) => s !== baseSlot && s.mesh.castShadow) ??
          all.find((s) => s !== baseSlot) ??
          all[0])
        : undefined
      const pair = cloneSlot ? fadePool.acquire(material) : null
      let was: THREE.Material | THREE.Material[] | null = null
      if (cloneSlot && pair) {
        was = cloneSlot.mesh.material
        cloneSlot.mesh.material = pair.incoming
        if (cloneSlot !== baseSlot) show(cloneSlot.mesh)
        // Full coverage, so the warm draw RASTERISES rather than discarding every
        // fragment — `acquire` leaves the incoming clone at coverage 0, which
        // kills the lot. The pixels go under the curtain either way; what is
        // wanted is the ordinary path through the program.
        pair.setCoverage(1)
      }
      if (shown.length === 0 && !pair) return null
      return () => {
        if (cloneSlot && pair && was) {
          cloneSlot.mesh.material = was
          fadePool.release(pair)
        }
        for (const s of shown) s.mesh.visible = s.visible
      }
    },

    batching: {
      get available() {
        return batcher !== null
      },
      get on() {
        return batcher !== null && batchSynced && batchOn
      },
      sync: batchSync,
      set: batchSet,
      exclude(names: ReadonlySet<string>) {
        batchExcluded = names
        for (const slot of slots.values()) settle(slot)
      },
      report: () => batcher?.report() ?? null,
      occupants: () => batcher?.occupants() ?? [],
    },

    dispose() {
      worker?.terminate()
      // DEV-904: first, so no `finishFade` below places a chunk into a band that
      // is about to go, and the batches are off the group before the loop that
      // frees its meshes' geometry.
      unsubscribeBake?.()
      batchSynced = false
      batcher?.dispose()
      // Anything still queued is dropped, not applied (DEV-242). Its buffers
      // are plain JS arrays that have never reached the GPU — no `dispose` to
      // call, nothing to leak — and applying them would build meshes into a
      // group that is about to be cleared.
      arrivals.length = 0
      // Fades first: each holds a transient mesh under the group and two
      // clones out of the pool, and the loop below only knows the chunks.
      for (const slot of slots.values()) finishFade(slot)
      fadePool.dispose()
      for (const child of group.children) {
        // **Only the chunks this module made.** `boot/app.ts` parents the PROP
        // group under this one, and a prop group is a `Group` with no geometry
        // on it — so the old unguarded `child.geometry.dispose()` threw
        // `Cannot read properties of undefined` the first time anything ever
        // called this. Nothing did until missions started swapping in place
        // (DEV-077); a `dispose` that has never run is a `dispose` that has
        // never been tested.
        //
        // Foreign children are left to their own owners, which is also why this
        // is a shallow loop and not a `traverse`: disposing somebody else's
        // geometry from here is how you get a black hole in a mesh that is
        // still on screen.
        const mesh = child as THREE.Mesh
        if (mesh.isMesh) mesh.geometry.dispose()
      }
      // DEV-498's far sea is this module's too, one level down.
      for (const f of farSeaMeshes) f.mesh.geometry.dispose()
      // DEV-339: and the rings, which own their geometry, textures and materials.
      ringsObj?.dispose()
      material.dispose()
      group.clear()
    },
  }
}

/**
 * Concatenate triangle-soup chunk geometries (DEV-498) — every one from
 * `chunkGeometry`, so the same non-indexed attributes at the same item sizes.
 * `three` is passed in because this module loads it dynamically.
 */
const mergeSoup = (
  three: typeof THREE,
  list: readonly THREE.BufferGeometry[],
): THREE.BufferGeometry => {
  const out = new three.BufferGeometry()
  const first = list[0]
  if (!first) return out
  for (const name of Object.keys(first.attributes)) {
    const size = (first.getAttribute(name) as THREE.BufferAttribute).itemSize
    let total = 0
    for (const g of list) total += (g.getAttribute(name) as THREE.BufferAttribute).array.length
    const array = new Float32Array(total)
    let at = 0
    for (const g of list) {
      const src = (g.getAttribute(name) as THREE.BufferAttribute).array as Float32Array
      array.set(src, at)
      at += src.length
    }
    out.setAttribute(name, new three.BufferAttribute(array, size))
  }
  out.computeBoundingSphere()
  return out
}
