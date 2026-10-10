// src/sim/props/scatter.ts — the environment prop scatter.
//
// A port of `FacetedTerrainObjectGenerator.GenerateObjects()` with ONE
// deliberate change: the PRNG is seeded.
//
// ── Why this cannot be a reproduction, and why that is fine ───────────────
//
// 2016's scatter ran in the editor (`#if UNITY_EDITOR`) on an unseeded
// `UnityEngine.Random`, and baked its output into the prefab. There is no seed
// to recover and Unity's generator is not portable anyway (DEV-006, same reason
// the terrain jitter is not reproduced). So the shipped layout is gone.
//
// It was verified that nothing was lost with it. The grid test in
// docs/private/PROP-AUDIT.md §4: desert's placements are 9,600 on the exact 4.0 m texel
// grid against 53 objects off it, and those 53 are hand-placed landmarks that
// `content/environments/*.json` carries separately. Nothing was hand-tuned
// after the bake, so a re-roll loses no authored intent — only a particular
// arbitrary draw.
//
// What IS preserved, exactly:
//
//   - the acceptance test, `rnd() < grayscale(texel) * probabilityScale`
//   - the texel-space position, `tx * terrainSize / width`
//   - the height source: the HEIGHT MAP, sampled bilinearly, NOT the generated
//     vertices (see `heightOffset` below)
//   - the draw ORDER per accepted texel: probability, yaw, palette, scale
//   - the loop order, x outer and y inner
//
// ── The height is the UNJITTERED surface, on purpose ──────────────────────
//
// `GenerateObjects` reads `terrain.SourceHeightMap`, not the mesh it generated,
// so props sit on the smooth height field and ignore `RandomOffset` (0.8 m on an
// 8 m grid). That is the same split that makes `heightField` disagree with what
// you see, and `ObjectHeightOffset` is the fudge that hides it — alpine's two
// passes use -1 and -2.6, which RAISE the props because the offset is
// SUBTRACTED. Placing props on the rendered surface instead would be more
// "correct" and would not look like Faceted Flight.
//
// ── Density is a RAW TEXEL read; height is BILINEAR ───────────────────────
//
// `ObjectPlacementMap.GetPixel(x, y)` against `SourceHeightMap
// .GetPixelBilinear(uv)`. Two different samplers on two different maps in the
// same loop, and mixing them up is silent: bilinear density blurs the forest
// edge, point-sampled height stair-steps every tree. The placement map is
// therefore rescaled here with the shared `resampleBilinear` and then read
// texel-by-texel, while the height map arrives as a `MapSampler` that
// `importUnityTexture` already built. One implementation of the importer, one
// test — same rule `extract-terrain-maps.mjs` follows.
//
// ── One thing 2016 did NOT do: leave the launch site alone ────────────────
//
// `clearings` (DEV-100) drops an accepted texel that lands on a mission's launch
// axis. It is a deliberate deviation and not a repair: 2016's own baked draw put
// a tree 8.86 m from `rookie_01_hoverJet`'s release and 3.76 m from
// `rookie_01_jumpSeat`'s spawn, measured off the 6,097 surviving clones in
// `LevelArt_AlpineForest.unity`. See `clearing.ts` and DEV-100.
//
// **The rejection happens AFTER the four draws, and that is the whole design.**
// The PRNG is consumed identically whether a clearing is passed or not, so every
// surviving placement is bit-for-bit the one it was before — the clearing SUBTRACTS
// props and moves none. Reject before the draws and the sequence shifts, and one
// tree on one pad re-rolls the other twenty thousand.
//
// SIM LAYER: pure, THREE-free, deterministic. Same seed, same bytes, forever.

import { type Clearing, insideAnyClearing } from '@/sim/props/clearing'
import { grayscale, makeRandom } from '@/sim/terrain/faceted'
import {
  type ImageData8,
  isPowerOfTwo,
  type MapSampler,
  npotNearest,
  resampleBilinear,
} from '@/sim/terrain/image-sampler'

export interface ScatterParams {
  /** `ObjectProbabilityScale`. Alpine 0.03, desert 0.018, islands 0.0064. */
  readonly probabilityScale: number
  /** `ObjectHeightOffset`, SUBTRACTED from the sampled height. */
  readonly heightOffset: number
  /** `ObjectScaleMin` / `ObjectScaleMax`, a uniform scale. */
  readonly scaleMin: number
  readonly scaleMax: number
  /** How many entries the palette has. The pick is uniform over INDICES. */
  readonly paletteSize: number
  /** Not a 2016 concept — see the header. */
  readonly seed: number
}

export interface TerrainExtent {
  /** `TerrainSize`, metres. 4096 on three environments, 8192 on kauai. */
  readonly terrainSize: number
  /** `TerrainHeight`, metres. */
  readonly terrainHeight: number
  /** `ChunkSize`, metres — used to bucket props for the LOD reveal. */
  readonly chunkSize: number
}

/**
 * One scatter pass, flat and transferable.
 *
 * Parallel arrays rather than objects: this crosses a Worker boundary and then
 * becomes `InstancedMesh` attributes, and both want contiguous memory.
 */
export interface ScatteredProps {
  readonly count: number
  /** `count * 3`, world metres, in the terrain's own mesh space. */
  readonly positions: Float32Array
  /** `count`, radians. */
  readonly yaw: Float32Array
  /** `count`, uniform. */
  readonly scale: Float32Array
  /** `count`, index into the palette. */
  readonly palette: Uint8Array
  /** `count`, index of the terrain chunk each prop stands on. */
  readonly chunk: Uint16Array
  /**
   * The accepted texel, x and y, interleaved as `[x0, y0, x1, y1, …]`.
   *
   * The scatter already knows these; exposing them is what lets the result be
   * BAKED. Everything else in this struct is a pure function of a texel plus
   * the generator's own parameters — `wx = tx * terrainSize / width` exactly,
   * and `y` from the height map that the terrain has already fetched — so a
   * texel is the whole of the irreducible information. See `placements.ts`.
   */
  readonly texel: Uint16Array
  /** Chunks per side, so a chunk index decomposes to (cx, cz). */
  readonly chunkPerSide: number
}

/**
 * Scatter one generator's props.
 *
 * `placement` is the RAW map as decoded; the Unity import rescale is applied
 * here, so callers must not pre-scale it. `heightMap` is the opposite — it must
 * already be an `importUnityTexture` sampler, because that is the form the
 * terrain generator uses and sharing it avoids a second copy of the arithmetic.
 *
 * `clearings` are in the TERRAIN's own mesh space, the frame `positions` is
 * written in — so `terrain.terrainSize` is load-bearing the moment one is passed,
 * and a caller handing over a nominal extent with a real clearing would clear the
 * wrong ground. `tools/assets/bake-placements.mjs` says so at its own extent.
 */
export const scatterProps = (
  placement: ImageData8,
  heightMap: MapSampler,
  terrain: TerrainExtent,
  params: ScatterParams,
  clearings: readonly Clearing[] = [],
): ScatteredProps => {
  // Unity's importer, same call the height map went through.
  const map =
    isPowerOfTwo(placement.width) && isPowerOfTwo(placement.height)
      ? placement
      : resampleBilinear(placement, npotNearest(placement.width), npotNearest(placement.height))

  const { width, height, channels, data } = map
  const rnd = makeRandom(params.seed)
  const rgb = { r: 0, g: 0, b: 0 }

  const chunkPerSide = Math.max(1, Math.round(terrain.terrainSize / terrain.chunkSize))
  const scaleSpan = params.scaleMax - params.scaleMin

  // Two passes would mean two PRNG walks; instead push into growable arrays and
  // compact once. The accepted fraction is ~1% so the overshoot is small.
  const pos: number[] = []
  const yaw: number[] = []
  const scl: number[] = []
  const pal: number[] = []
  const chk: number[] = []
  const tex: number[] = []

  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      // GetPixel(x, y): a RAW texel. Unity's texture origin is BOTTOM-left and
      // `ImageData8` row 0 is the TOP, so the row is flipped on read. Getting
      // this wrong mirrors the forest north-to-south — invisible on a symmetric
      // density map and very visible on a coastline.
      const row = height - 1 - y
      const o = (row * width + x) * channels
      const r = (data[o] ?? 0) / 255
      const g = channels > 1 ? (data[o + 1] ?? 0) / 255 : r
      const b = channels > 2 ? (data[o + 2] ?? 0) / 255 : r

      if (rnd() >= grayscale(r, g, b) * params.probabilityScale) continue

      const u = x / width
      const v = y / height
      heightMap.sample(u, v, rgb)
      const h = grayscale(rgb.r, rgb.g, rgb.b) * terrain.terrainHeight

      const wx = (x * terrain.terrainSize) / width
      const wz = (y * terrain.terrainSize) / height

      // Draw order is 2016's: yaw, then palette, then scale.
      const a = rnd() * Math.PI * 2
      const p = Math.min(params.paletteSize - 1, Math.floor(rnd() * params.paletteSize))
      const s = params.scaleMin + rnd() * scaleSpan

      // DEV-100, and it is deliberately DOWN HERE: the four draws above have
      // already been spent, so dropping this placement leaves every other one
      // bit-identical. See the header.
      if (insideAnyClearing(wx, wz, clearings)) continue

      const cx = Math.min(chunkPerSide - 1, Math.floor(wx / terrain.chunkSize))
      const cz = Math.min(chunkPerSide - 1, Math.floor(wz / terrain.chunkSize))

      pos.push(wx, h - params.heightOffset, wz)
      yaw.push(a)
      scl.push(s)
      pal.push(p)
      chk.push(cz * chunkPerSide + cx)
      tex.push(x, y)
    }
  }

  return {
    count: yaw.length,
    positions: Float32Array.from(pos),
    yaw: Float32Array.from(yaw),
    scale: Float32Array.from(scl),
    palette: Uint8Array.from(pal),
    chunk: Uint16Array.from(chk),
    texel: Uint16Array.from(tex),
    chunkPerSide,
  }
}

/**
 * Drop every placement standing inside an authored no-prop volume. DEV-287.
 *
 * A SUBTRACTION over an already-expanded pass, and that is the whole design:
 * `clearings` inside `scatterProps` above has to sit after the four draws so
 * the PRNG walk is untouched, and this one cannot perturb anything at all
 * because the draws happened at bake time and are in the blob. Every surviving
 * placement keeps its position, yaw, palette and scale bit-for-bit; only the
 * indices move up.
 *
 * `chunkPerSide` and the chunk ids are carried over unchanged — a placement
 * does not change which chunk it stands on by having a neighbour removed, and
 * re-deriving them here would be a second copy of `expandPlacements`'s
 * arithmetic.
 *
 * Returns the input itself when nothing matched, so the common case — every
 * environment with no authored volumes — allocates nothing.
 */
export const withoutVolumes = (
  props: ScatteredProps,
  volumes: readonly Clearing[],
): { readonly props: ScatteredProps; readonly removed: number } => {
  if (volumes.length === 0) return { props, removed: 0 }

  const keep: number[] = []
  for (let i = 0; i < props.count; i++) {
    const x = props.positions[i * 3] ?? 0
    const z = props.positions[i * 3 + 2] ?? 0
    if (!insideAnyClearing(x, z, volumes)) keep.push(i)
  }
  return keepOnly(props, keep)
}

/**
 * Drop every placement standing on ground steeper than `maxSlope`. DEV-356.
 *
 * Matt, 2026-09-24: *"don't place props on steep slopes."* 2016's
 * `GenerateObjects()` has no slope term at all — one roll per texel against the
 * density map, and nothing else — so its trees stood on cliffs as often as the
 * port's re-roll does (measured against the clones 2016 actually baked, in
 * the DEV-356 ledger row). This is therefore a deviation, not a repair, and
 * it is a SUBTRACTION for the same reason {@link withoutVolumes} is: the draws
 * are in the baked blob, so every survivor keeps its position, yaw, palette and
 * scale bit-for-bit and only the indices close up.
 *
 * `slopeAt(x, z)` answers in the unit the dressing's bands are written in —
 * `sin` of the ground's angle, 0 flat and 1 a wall — at a point in the frame
 * `positions` is in. The caller decides WHICH ground: `load-props.ts` passes
 * the rendered facet (`sim/terrain/surface.ts`'s `renderSurfaceSlopeAt`),
 * because a trunk stands on what you see and the 4 m map is not that
 * (CLAUDE.md's DEV-288 trap). A placement ON the limit stays.
 */
export const withoutSteep = (
  props: ScatteredProps,
  maxSlope: number,
  slopeAt: (x: number, z: number) => number,
): { readonly props: ScatteredProps; readonly removed: number } => {
  const keep: number[] = []
  for (let i = 0; i < props.count; i++) {
    const x = props.positions[i * 3] ?? 0
    const z = props.positions[i * 3 + 2] ?? 0
    if (!(slopeAt(x, z) > maxSlope)) keep.push(i)
  }
  return keepOnly(props, keep)
}

/**
 * Drop every placement whose BASE stands below `floorAt(x, z)`. DEV-862.
 *
 * Matt, 2026-10-08: *"we have palm trees spawning below the water-line on
 * simonet and possibly kauai. make sure no trees are spawned below the wave
 * height + ocean surface."* The bake is height-blind on purpose (it reads a
 * density map and a stub height map, `tools/assets/bake-placements.mjs`), so a
 * texel of palm density over the seabed is a palm on the seabed. Nothing else in
 * the load path asks where the sea is.
 *
 * Same family as {@link withoutSteep}: a SUBTRACTION, run once the base is
 * final (after the ground snap, so the y compared is the y drawn), so every
 * survivor keeps its position, yaw, palette and scale bit-for-bit. `floorAt`
 * is in the frame `positions` is in, and is the sea's rest surface plus the
 * most the drawn sea ever lifts it. A base exactly ON the floor stays.
 */
export const withoutDrowned = (
  props: ScatteredProps,
  floorAt: (x: number, z: number) => number,
): { readonly props: ScatteredProps; readonly removed: number } => {
  const keep: number[] = []
  for (let i = 0; i < props.count; i++) {
    const x = props.positions[i * 3] ?? 0
    const y = props.positions[i * 3 + 1] ?? 0
    const z = props.positions[i * 3 + 2] ?? 0
    if (!(y < floorAt(x, z))) keep.push(i)
  }
  return keepOnly(props, keep)
}

/**
 * The placements at `keep` (ascending indices), compacted — the shared tail of
 * every load-time subtraction. Returns the input itself when nothing went, so
 * the common case allocates nothing.
 */
const keepOnly = (
  props: ScatteredProps,
  keep: readonly number[],
): { readonly props: ScatteredProps; readonly removed: number } => {
  const removed = props.count - keep.length
  if (removed === 0) return { props, removed: 0 }

  const count = keep.length
  const positions = new Float32Array(count * 3)
  const yaw = new Float32Array(count)
  const scale = new Float32Array(count)
  const palette = new Uint8Array(count)
  const chunk = new Uint16Array(count)
  const texel = new Uint16Array(count * 2)
  for (let k = 0; k < count; k++) {
    const i = keep[k] as number
    positions[k * 3] = props.positions[i * 3] ?? 0
    positions[k * 3 + 1] = props.positions[i * 3 + 1] ?? 0
    positions[k * 3 + 2] = props.positions[i * 3 + 2] ?? 0
    yaw[k] = props.yaw[i] ?? 0
    scale[k] = props.scale[i] ?? 0
    palette[k] = props.palette[i] ?? 0
    chunk[k] = props.chunk[i] ?? 0
    texel[k * 2] = props.texel[i * 2] ?? 0
    texel[k * 2 + 1] = props.texel[i * 2 + 1] ?? 0
  }
  return {
    props: {
      count,
      positions,
      yaw,
      scale,
      palette,
      chunk,
      texel,
      chunkPerSide: props.chunkPerSide,
    },
    removed,
  }
}

/**
 * A deterministic shuffle of the indices belonging to each chunk.
 *
 * This is how 2016's reveal is reproduced for free. `Update()` flips
 * `ceil(total * percent)` objects per frame, each **picked at random from the
 * remaining pool** — a dissolve made of discrete objects rather than alpha, and
 * it is the visual signature of flying into a forest in this game.
 *
 * Picking randomly every frame needs a mutable pool per chunk. Revealing the
 * first N of a list that was shuffled ONCE is the same distribution, costs
 * nothing at runtime, and — because instances are drawn in buffer order — lets
 * the whole reveal be expressed as `InstancedMesh.count = n`. So the randomness
 * moves from the frame loop into the buffer layout, where it is free.
 *
 * Returns, per chunk, the prop indices in reveal order.
 */
export const shuffleByChunk = (props: ScatteredProps, seed: number): Uint32Array[] => {
  const chunkCount = props.chunkPerSide * props.chunkPerSide

  // Count, allocate exactly, fill, shuffle in place. Every indexed read is
  // pulled into a local first: `noUncheckedIndexedAccess` is on, and the `!`
  // or `as number` that would silence it is exactly the kind of "I know
  // better" annotation that stops being true after the next edit.
  const sizes = new Uint32Array(chunkCount)
  for (let i = 0; i < props.count; i++) {
    const c = props.chunk[i] ?? 0
    sizes[c] = (sizes[c] ?? 0) + 1
  }

  const buckets: Uint32Array[] = []
  for (let c = 0; c < chunkCount; c++) buckets.push(new Uint32Array(sizes[c] ?? 0))

  const fill = new Uint32Array(chunkCount)
  for (let i = 0; i < props.count; i++) {
    const c = props.chunk[i] ?? 0
    const bucket = buckets[c]
    if (bucket === undefined) continue
    const at = fill[c] ?? 0
    bucket[at] = i
    fill[c] = at + 1
  }

  const rnd = makeRandom(seed)
  for (const bucket of buckets) {
    // Fisher-Yates, descending, one PRNG walk across every chunk in order.
    for (let i = bucket.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1))
      const a = bucket[i] ?? 0
      const b = bucket[j] ?? 0
      bucket[i] = b
      bucket[j] = a
    }
  }
  return buckets
}
