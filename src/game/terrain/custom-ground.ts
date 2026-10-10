// src/game/terrain/custom-ground.ts — a PLAYER's island through the 2016
// generator. DEV-489, the custom-ground core (EDITOR.md §5.4, T1 and T1.5).
//
// The terrain generator is a pure function of a height map, a colour map and
// `FacetedTerrainParams` (EDITOR.md §3.6). Nothing about it is Simonet's. This
// file is what turns a player's height grid into the other two inputs, so an
// imported heightmap (DEV-490) and a seeded island (DEV-493) are only
// front-ends: each builds a `CustomGround` and hands it here, and there is no
// code path special to where the heights came from.
//
//   CustomGround           heights (0..1 floats), world size, maximum height,
//                          and which shipped island it WEARS (colours, props)
//   withCustomGround       carry one on a `Level`, invisibly to JSON
//   customTerrainParams    the generator's params: the donor's grain, the
//                          player's extent
//   customTerrainLocal     where it stands: centred on the donor's own land
//   groundGrid             height and slope on a terrain's own facet grid —
//                          the two keys every table below is read by
//   buildColourRamp        the donor's colour against its own height and slope
//   paintCustomColour      that ramp over the player's ground, as a colour map
//   measureDensityBands    how the donor's BAKED forest sits on its ground
//   customEnvironmentProps the donor's prop sets, scattered over the player's
//                          ground at load by `scatterProps`, landmarks dropped
//
// ── What is the donor's, and what is the player's ────────────────────────
//
// Everything that is a GRAIN is the donor's: `chunkSize`, `baseResolution`,
// `randomOffset`, the jitter seed, the LOD ladder, the material. Everything
// that is a SHAPE is the player's: the heights, the side, the maximum height.
// So a custom island is folded from the same paper as the island it wears,
// which is ART_DIRECTION's pillar 5 (one grain size everywhere) kept by
// construction rather than by a tuning pass.
//
// ── NOT `importUnityTexture` (DEV-007) ───────────────────────────────────
//
// A player's grid is not a 2016 map. Unity's 1025 -> 1024 import rescale is a
// fact about 2016's PNGs, so the heights go through `createGreySampler` — the
// raw `GetPixelBilinear` addressing over a float grid — and the 2016 path is
// untouched. The DONOR's maps, which this file reads for its colours and its
// forest, ARE 2016 maps, and they arrive already through `importUnityTexture`
// (`load-terrain.ts`); nothing here samples a raw 2016 PNG.
//
// ── The frame ────────────────────────────────────────────────────────────
//
// `heights` is a picture of the ground seen from above: row 0 at the TOP
// (`GreyDataF32`'s order, which is a PNG's), so the top row is the terrain's
// far edge in Unity +z — three's −z — exactly as the 2016 maps are read. A
// height is `heights * maxHeight` metres in the terrain's MESH frame, the same
// frame the donor's own heights are in: a custom island stands in the donor's
// world with the donor's sea at the donor's height, so its low ground is under
// that sea exactly where the donor's would be.
//
// The grid is addressed as `GetPixelBilinear` addresses a texture (`u * W`,
// the one copy in `image-sampler.ts`): W samples span the terrain as W
// TEXELS, so sample i stands at `i * size / W`, not `i * size / (W - 1)`, and
// the far row and column are clamped. A 1025-sample map over 4096 m is
// therefore stretched by 1/1024 — a 4 m shift at the far edge, under one
// facet. `custom-ground.test.ts` pins it on a cone's summit.
//
// SIM-LAYER DISCIPLINE, though this is `game/`: no three, no DOM, no clock, no
// `Math.random`. The loader (`load-terrain.ts`) fetches; this computes. So a
// node test drives every function here, and so could a worker.

import type { Level } from '@/content/level-schema'
import type { EnvironmentProps, PropScatter } from '@/content/load-environment'
import { islandWaterline } from '@/content/player-course'
import { TERRAIN } from '@/generated/constants.generated'
import type { Clearing } from '@/sim/props/clearing'
import {
  decodeBase64,
  encodeBase64,
  encodePlacements,
  PLACEMENT_STRIDE,
} from '@/sim/props/placements'
import { scatterProps } from '@/sim/props/scatter'
import { type FacetedTerrainParams, grayscale } from '@/sim/terrain/faceted'
import {
  createGreySampler,
  type GreyDataF32,
  type ImageData8,
  isPowerOfTwo,
  type MapSampler,
} from '@/sim/terrain/image-sampler'
import {
  type IslandShape,
  type IslandSynthVersion,
  synthesiseIsland,
} from '@/sim/terrain/island-synth'

// ── The value ─────────────────────────────────────────────────────────────

/**
 * A player's ground. DEV-489.
 *
 * `heights` are 0..1 (`GreyDataF32`), row 0 at the top — see the header's
 * frame. `size` is the side in metres and `maxHeight` what a 1 is in metres.
 * `island` is an ENVIRONMENT id (`simonet`, `kauai`, `desert`, `alpine`): the
 * shipped island whose colour ramp, prop sets and terrain grain it wears. It
 * need not be the course's sky's island, though every front-end so far makes
 * it so.
 */
export interface CustomGround {
  readonly heights: GreyDataF32
  readonly size: number
  readonly maxHeight: number
  readonly island: string
  /**
   * DEV-490: which course island this ground was built for
   * (`content/player-course.ts`'s `groundKey`), so the editor can tell the
   * world it has from the one its draft wants. Absent on a fixture.
   */
  readonly key?: string
}

/**
 * DEV-493: the grid a seeded island is synthesised on: one sample per facet
 * VERTEX of the island it wears (`baseResolution`), plus the closing row, so
 * the generator reads the synthesis at its own pitch and not a resample of
 * it. 513 a side at 4 km on Simonet, 1025 at 8 km on kauai.
 */
export const seedGridEdge = (size: number, island: string): number =>
  Math.min(CUSTOM_GROUND_LIMITS.maxEdge, size / donorLand(island).entry.baseResolution + 1)

/**
 * DEV-493: a seeded island as a ground. `synthesiseIsland`'s elevation (0 the
 * waterline, 1 the summit, -1 the sea floor) in the island's mesh frame: the
 * waterline at `islandWaterline(island)`, the summit `shape.height` above it,
 * and the floor at the mesh's zero (where there is no sea, the floor IS the
 * waterline, so the low ground is a flat valley floor).
 */
export const seedGround = (
  seed: number,
  shape: IslandShape,
  island: string,
  key: string | undefined,
  version: IslandSynthVersion,
): CustomGround => {
  const edge = seedGridEdge(shape.size, island)
  const e = synthesiseIsland(seed, shape, edge, version)
  const water = islandWaterline(island)
  const maxHeight = water + shape.height
  const data = new Float32Array(e.length)
  for (let i = 0; i < e.length; i++) {
    const v = e[i] as number
    const metres = v >= 0 ? water + v * shape.height : water * (1 + v)
    data[i] = Math.min(1, Math.max(0, metres / maxHeight))
  }
  return assertCustomGround({
    heights: { width: edge, height: edge, data },
    size: shape.size,
    maxHeight,
    island,
    ...(key ? { key } : {}),
  })
}

/**
 * DEV-490: an imported map's 0..1 samples as a ground, "0 is the waterline":
 * the map's `sea` grey stands at `islandWaterline(island)` in the island's mesh
 * frame and its white `height` metres above that; below the waterline the
 * ground runs on at the same scale down to the mesh's floor, where it is
 * clamped. So `maxHeight` is the waterline plus `height`, and the validator
 * has already held that under the tallest shipped island.
 */
export const mapGround = (
  map: GreyDataF32,
  island: string,
  shape: { readonly size: number; readonly height: number; readonly sea: number },
  key?: string,
): CustomGround => {
  const water = islandWaterline(island)
  const maxHeight = water + shape.height
  const perGrey = shape.height / (1 - shape.sea)
  const data = new Float32Array(map.data.length)
  for (let i = 0; i < data.length; i++) {
    const metres = water + ((map.data[i] as number) - shape.sea) * perGrey
    data[i] = Math.min(1, Math.max(0, metres / maxHeight))
  }
  return assertCustomGround({
    heights: { width: map.width, height: map.height, data },
    size: shape.size,
    maxHeight,
    island,
    ...(key ? { key } : {}),
  })
}

// ── The policy, under ONE name (the HUD_RASTER_SHIPPED pattern) ───────────

interface SheetTerrain {
  readonly terrainSize: number
  readonly terrainHeight: number
  readonly chunkSize: number
  readonly baseResolution: number
  readonly randomOffset: number
}
type Sheet = Record<string, { readonly terrains: Record<string, SheetTerrain> }>

/** Every LAND terrain in the sheet (the ocean plates are not islands). */
const landTerrains = (): SheetTerrain[] =>
  Object.values(TERRAIN as unknown as Sheet).flatMap((env) =>
    Object.entries(env.terrains)
      .filter(([name]) => name !== 'ocean')
      .map(([, t]) => t),
  )

/**
 * Every bound on a `CustomGround`. **Pinned by value in
 * `tests/unit/custom-ground.test.ts`**, so moving one is an edit made on
 * purpose.
 *
 * The two extents are DERIVED from the sheet rather than typed: a custom
 * island may be as wide as the widest island 2016 shipped (kauai's 8,192 m)
 * and as tall as the tallest (Simonet's 1,536 m), because every system
 * downstream — the LOD ladder, the far-shadow march, the sky-visibility bake,
 * the scatter's `Uint16` texels — has run at those sizes and none has run
 * past them.
 */
export const CUSTOM_GROUND_LIMITS = {
  /** The widest shipped land terrain, metres. */
  maxSize: Math.max(...landTerrains().map((t) => t.terrainSize)),
  /** The tallest shipped land terrain, metres. */
  maxHeight: Math.max(...landTerrains().map((t) => t.terrainHeight)),
  /**
   * The largest grid edge, samples. EDITOR.md §5.4: *"cap the edge at 4097"* —
   * a 4096-quad map plus its closing row, the size World Machine and Gaea
   * export for a 4 km tile at a metre a sample.
   */
  maxEdge: 4097,
  /** The smallest grid a bilinear sampler can interpolate: two samples a side. */
  minEdge: 2,
} as const

/** A `CustomGround` that does not validate, with every reason. */
export class CustomGroundError extends Error {
  readonly problems: readonly string[]
  constructor(problems: readonly string[]) {
    super(`custom ground: ${problems.join('; ')}`)
    this.name = 'CustomGroundError'
    this.problems = problems
  }
}

/** The donor's LAND terrain key, e.g. `simonet.islands`, and its sheet entry. */
export const donorLand = (
  island: string,
): { readonly key: string; readonly entry: SheetTerrain } => {
  const env = (TERRAIN as unknown as Sheet)[island]
  const name = env ? Object.keys(env.terrains).find((n) => n !== 'ocean') : undefined
  if (!env || !name) {
    throw new CustomGroundError([
      `island "${island}" is not a shipped island (have ${Object.keys(TERRAIN).sort().join(', ')})`,
    ])
  }
  return { key: `${island}.${name}`, entry: env.terrains[name] as SheetTerrain }
}

/**
 * Every reason `ground` cannot be generated, or an empty list.
 *
 * The side must be a whole number of the donor's CHUNKS, because the chunk
 * grid is what the LOD, the worker and the prop reveal are indexed by; and a
 * chunk must be a whole number of quads, which every donor already is.
 */
export const customGroundProblems = (ground: CustomGround): string[] => {
  const out: string[] = []
  const L = CUSTOM_GROUND_LIMITS
  let donor: SheetTerrain | null = null
  try {
    donor = donorLand(ground.island).entry
  } catch (e) {
    out.push(...((e as CustomGroundError).problems ?? [String(e)]))
  }
  const { width, height, data } = ground.heights
  if (!Number.isInteger(width) || !Number.isInteger(height)) out.push('the grid is not whole')
  else if (width < L.minEdge || height < L.minEdge) out.push(`the grid is ${width}x${height}`)
  else if (width > L.maxEdge || height > L.maxEdge) {
    out.push(`the grid is ${width}x${height}, over ${L.maxEdge} a side`)
  } else if (data.length !== width * height) {
    out.push(`the grid holds ${data.length} samples, not ${width * height}`)
  } else {
    for (let i = 0; i < data.length; i++) {
      const h = data[i] as number
      if (!(h >= 0 && h <= 1)) {
        out.push(`sample ${i} is ${h}, not in 0..1`)
        break
      }
    }
  }
  if (!(Number.isFinite(ground.size) && ground.size > 0 && ground.size <= L.maxSize)) {
    out.push(`size ${ground.size} is not in (0, ${L.maxSize}] m`)
  } else if (donor && ground.size % donor.chunkSize !== 0) {
    out.push(
      `size ${ground.size} is not a whole number of ${ground.island}'s ${donor.chunkSize} m chunks`,
    )
  }
  if (
    !(Number.isFinite(ground.maxHeight) && ground.maxHeight > 0 && ground.maxHeight <= L.maxHeight)
  ) {
    out.push(`maxHeight ${ground.maxHeight} is not in (0, ${L.maxHeight}] m`)
  }
  return out
}

/** Throw `CustomGroundError` unless `ground` can be generated. */
export const assertCustomGround = (ground: CustomGround): CustomGround => {
  const problems = customGroundProblems(ground)
  if (problems.length > 0) throw new CustomGroundError(problems)
  return ground
}

// ── Carrying one on a Level ───────────────────────────────────────────────

/**
 * The key a `Level` carries its ground under. A SYMBOL, on purpose:
 *
 *  - **JSON cannot see it.** A level is stringified by more than one reader
 *    (receipts, specs, the library), and a 4097² float grid in any of them
 *    would be a 16 M-entry object. `JSON.stringify` skips symbol keys.
 *  - **An object spread KEEPS it.** Every step between a player course and the
 *    world build copies the level with `{ ...level }` (`withSunLightRule` is
 *    one), and spread copies own enumerable symbol keys. A `WeakMap` keyed on
 *    the level would lose it at the first copy.
 *  - **It is not a format change.** No key is added to the level schema, the
 *    player-course format or anything the lap server hashes. DEV-490 puts the
 *    island in the course; until then a ground rides only in memory.
 *
 * What it does NOT survive is `structuredClone`, which drops symbol keys —
 * and `expandPlayerCourse` clones its DONOR, so a course expanded against a
 * donor carrying a ground must be given it again (`editor/core/playtest.ts`'s
 * `playtestLevel` does; `tests/unit/custom-ground.test.ts` holds both facts).
 */
const GROUND = Symbol('ff2.customGround')

type Grounded = Level & { [GROUND]?: CustomGround }

/** The ground `level` is flown over, or null for its island's own. */
export const customGroundOf = (level: Level | null | undefined): CustomGround | null =>
  (level as Grounded | null | undefined)?.[GROUND] ?? null

/** `level`, over `ground` — a copy; null takes a ground away. Validated. */
export const withCustomGround = (level: Level, ground: CustomGround | null): Level => {
  const out = { ...level } as Grounded
  if (ground) out[GROUND] = assertCustomGround(ground)
  else delete out[GROUND]
  return out
}

// ── The generator's inputs ────────────────────────────────────────────────

/**
 * The generator's params for `ground`: the donor's GRAIN, the player's extent.
 * `seed` is the caller's — `load-terrain.ts`'s `TERRAIN_SEED`, the one every
 * terrain is jittered with — passed in so this file has no copy of it.
 */
export const customTerrainParams = (ground: CustomGround, seed: number): FacetedTerrainParams => {
  const donor = donorLand(ground.island).entry
  return {
    terrainSize: ground.size,
    terrainHeight: ground.maxHeight,
    chunkSize: donor.chunkSize,
    baseResolution: donor.baseResolution,
    randomOffset: donor.randomOffset,
    seed,
  }
}

/**
 * Where the custom terrain's corner goes, in the frame the donor land's own
 * `localPosition + envRoot` is in (Unity space, under the level offset).
 *
 * CENTRED on the donor's land: the corner moves by half the difference in
 * sides, so the donor's boundary sphere, its fog and its sun still frame the
 * island at any size, and a custom island the donor's size stands exactly
 * where the donor's did. `donorTerrainPos` is the donor's composed position —
 * `load-terrain.ts` hands in the sum it already made, so the composition
 * DEV-042 cost a session is not written a second time.
 */
export const customTerrainLocal = (
  ground: CustomGround,
  donorTerrainPos: readonly number[],
): [number, number, number] => {
  const shift = (donorLand(ground.island).entry.terrainSize - ground.size) / 2
  return [
    (donorTerrainPos[0] as number) + shift,
    donorTerrainPos[1] as number,
    (donorTerrainPos[2] as number) + shift,
  ]
}

/** The player's heights as a sampler: `GetPixelBilinear` addressing, no import rescale. */
export const customHeightSampler = (ground: CustomGround): MapSampler =>
  createGreySampler(ground.heights)

// ── Height and slope, the two keys everything below is looked up by ───────

/**
 * A terrain's UNJITTERED surface on its own facet grid: height (mesh metres)
 * and slope (`sin` of the ground's angle, 0 flat and 1 a wall — the unit
 * DEV-356's `maxSlope` and the dressing's bands use) at every vertex, `step`
 * metres apart. `[j * n + i]`, `i` along u (mesh x) and `j` along v (mesh z),
 * the vertex order `buildHeightField` samples in.
 *
 * **Slope is measured over ONE FACET**, `step` = the donor's `baseResolution`,
 * on the donor and on the player's ground alike. A slope is only comparable
 * with a slope measured at the same pitch — a 2 m difference on a 4 m map
 * reads cliffs a facet smooths away — and the facet is the ground you SEE.
 * Height is sampled once per vertex and slope is central differences between
 * vertices, so a whole island is one sampler pass (263 k taps on a 4 km one)
 * rather than five per question asked of it.
 */
export interface GroundGrid {
  readonly n: number
  readonly step: number
  readonly size: number
  readonly h: Float32Array
  readonly s: Float32Array
}

const _rgb = { r: 0, g: 0, b: 0 }

export const groundGrid = (
  height: MapSampler,
  size: number,
  terrainHeight: number,
  step: number,
): GroundGrid => {
  const n = Math.round(size / step) + 1
  const h = new Float32Array(n * n)
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1)
    for (let j = 0; j < n; j++) {
      height.sample(u, j / (n - 1), _rgb)
      h[j * n + i] = grayscale(_rgb.r, _rgb.g, _rgb.b) * terrainHeight
    }
  }
  const s = new Float32Array(n * n)
  for (let j = 0; j < n; j++) {
    const j0 = Math.max(0, j - 1)
    const j1 = Math.min(n - 1, j + 1)
    for (let i = 0; i < n; i++) {
      const i0 = Math.max(0, i - 1)
      const i1 = Math.min(n - 1, i + 1)
      const gx = ((h[j * n + i1] as number) - (h[j * n + i0] as number)) / ((i1 - i0) * step)
      const gz = ((h[j1 * n + i] as number) - (h[j0 * n + i] as number)) / ((j1 - j0) * step)
      const g2 = gx * gx + gz * gz
      s[j * n + i] = Math.sqrt(g2 / (1 + g2))
    }
  }
  return { n, step, size, h, s }
}

/** Height and slope at (u, v), bilinear between the grid's vertices. */
export const groundAt = (
  g: GroundGrid,
  u: number,
  v: number,
  out: { h: number; s: number },
): void => {
  const m = g.n - 1
  const fx = Math.min(m, Math.max(0, u * m))
  const fz = Math.min(m, Math.max(0, v * m))
  const i0 = Math.min(m - 1, Math.floor(fx))
  const j0 = Math.min(m - 1, Math.floor(fz))
  const tx = fx - i0
  const tz = fz - j0
  const a = j0 * g.n + i0
  const b = a + g.n
  const lerp2 = (arr: Float32Array): number =>
    ((arr[a] as number) * (1 - tx) + (arr[a + 1] as number) * tx) * (1 - tz) +
    ((arr[b] as number) * (1 - tx) + (arr[b + 1] as number) * tx) * tz
  out.h = lerp2(g.h)
  out.s = lerp2(g.s)
}

// ── A table over (height, slope), filled ──────────────────────────────────

/**
 * Slope bands a ramp or a density table is cut into, over `sin` 0..1. Eight is
 * about 7 degrees a band near the flat, which separates DEV-089's own shrub
 * band (slope 0..0.4) into three and still leaves every band populated on the
 * smallest donor.
 */
export const SLOPE_BANDS = 8

/**
 * A band needs this much of the donor's ground behind it, square metres, to
 * be believed; less and it is filled from its neighbours like an empty one.
 * Sixty-four facets of 8 m — a real piece of an island, not three texels on a
 * cliff edge. In AREA rather than a count, because a colour ramp counts
 * facets and a density table counts density texels, and those are different
 * sizes on every donor.
 */
export const MIN_BAND_AREA = 4096

/**
 * A table over height (rows, `step` metres each, from 0) and slope (columns,
 * `SLOPE_BANDS` over 0..1), `channels` values a cell.
 */
export interface BandTable {
  readonly step: number
  readonly rows: number
  readonly channels: number
  readonly values: Float32Array
}

/** The row and column of (h, s), clamped into the table. */
const cellOf = (t: { step: number; rows: number }, h: number, s: number): number => {
  const r = Math.min(t.rows - 1, Math.max(0, Math.floor(h / t.step)))
  const c = Math.min(SLOPE_BANDS - 1, Math.max(0, Math.floor(s * SLOPE_BANDS)))
  return r * SLOPE_BANDS + c
}

/**
 * Fill every cell with less than `MIN_BAND_AREA` behind it from the nearest
 * believed cell: first along its own slope column (nearest height), then a
 * column with nothing believed at all takes the nearest column that has. So
 * ground higher or steeper than anything the donor has wears the donor's
 * highest or steepest, never black and never an average of nothing.
 */
const fillTable = (values: Float32Array, area: Float64Array, rows: number, ch: number): void => {
  const ok = (r: number, c: number): boolean =>
    (area[r * SLOPE_BANDS + c] as number) >= MIN_BAND_AREA
  const copy = (from: number, to: number): void => {
    for (let k = 0; k < ch; k++) values[to * ch + k] = values[from * ch + k] as number
  }
  const columnHas: boolean[] = []
  for (let c = 0; c < SLOPE_BANDS; c++) {
    let any = false
    for (let r = 0; r < rows && !any; r++) any = ok(r, c)
    columnHas.push(any)
    if (!any) continue
    for (let r = 0; r < rows; r++) {
      if (ok(r, c)) continue
      for (let d = 1; d < rows; d++) {
        if (r - d >= 0 && ok(r - d, c)) {
          copy((r - d) * SLOPE_BANDS + c, r * SLOPE_BANDS + c)
          break
        }
        if (r + d < rows && ok(r + d, c)) {
          copy((r + d) * SLOPE_BANDS + c, r * SLOPE_BANDS + c)
          break
        }
      }
    }
  }
  for (let c = 0; c < SLOPE_BANDS; c++) {
    if (columnHas[c]) continue
    for (let d = 1; d < SLOPE_BANDS; d++) {
      const from = columnHas[c - d] ? c - d : columnHas[c + d] ? c + d : -1
      if (from < 0) continue
      for (let r = 0; r < rows; r++) copy(r * SLOPE_BANDS + from, r * SLOPE_BANDS + c)
      break
    }
  }
}

/** Bilinear read of a filled table at (h, s), between cell centres. */
export const readBandTable = (t: BandTable, h: number, s: number, out: Float32Array): void => {
  const fr = Math.min(t.rows - 1, Math.max(0, h / t.step - 0.5))
  const fc = Math.min(SLOPE_BANDS - 1, Math.max(0, s * SLOPE_BANDS - 0.5))
  const r0 = Math.floor(fr)
  const c0 = Math.floor(fc)
  const r1 = Math.min(t.rows - 1, r0 + 1)
  const c1 = Math.min(SLOPE_BANDS - 1, c0 + 1)
  const tr = fr - r0
  const tc = fc - c0
  const ch = t.channels
  for (let k = 0; k < ch; k++) {
    const a = t.values[(r0 * SLOPE_BANDS + c0) * ch + k] as number
    const b = t.values[(r0 * SLOPE_BANDS + c1) * ch + k] as number
    const c = t.values[(r1 * SLOPE_BANDS + c0) * ch + k] as number
    const d = t.values[(r1 * SLOPE_BANDS + c1) * ch + k] as number
    out[k] = (a * (1 - tc) + b * tc) * (1 - tr) + (c * (1 - tc) + d * tc) * tr
  }
}

/**
 * The height step of a donor's tables: ONE GREY LEVEL of its own 8-bit map
 * (`terrainHeight / 256` — 6 m on Simonet, 4 m on the other three). Finer and
 * a band is a terrace artefact of the 8-bit map (DEV-131); coarser and a
 * beach and the grass above it share a band.
 */
export const donorHeightStep = (donorTerrainHeight: number): number => donorTerrainHeight / 256

/** An empty table for a donor, and the area behind each cell. */
const emptyTable = (
  donorTerrainHeight: number,
  channels: number,
): { step: number; rows: number; sums: Float64Array; area: Float64Array } => {
  const step = donorHeightStep(donorTerrainHeight)
  const rows = Math.ceil(donorTerrainHeight / step)
  return {
    step,
    rows,
    sums: new Float64Array(rows * SLOPE_BANDS * channels),
    area: new Float64Array(rows * SLOPE_BANDS),
  }
}

// ── Colour ────────────────────────────────────────────────────────────────

/** The donor's params these tables are measured with. */
export interface DonorGrain {
  readonly terrainSize: number
  readonly terrainHeight: number
  readonly baseResolution: number
}

/**
 * The donor island's colour as a function of its own height and slope: the
 * MEAN of its colour map over every facet in each (height, slope) band, in
 * the raw byte space the terrain draws them in (sRGB bytes used as linear
 * albedo, DEV-014 — so a mean here is a mean of what you see).
 *
 * Why a ramp and not the donor's map stretched over the player's: the colour
 * of a World Machine island is a function of where the ground IS — sand at
 * the waterline, grass on the gentle ground, rock on the steep — and a ramp
 * keeps that function while the geometry changes under it. Stretched, a beach
 * lands on a summit.
 */
export const buildColourRamp = (
  donor: GroundGrid,
  colour: MapSampler,
  grain: DonorGrain,
): BandTable => {
  const t = emptyTable(grain.terrainHeight, 3)
  const n = donor.n
  const facet = donor.step * donor.step
  const rgb = { r: 0, g: 0, b: 0 }
  for (let j = 0; j < n; j++) {
    const v = j / (n - 1)
    for (let i = 0; i < n; i++) {
      colour.sample(i / (n - 1), v, rgb)
      const cell = cellOf(t, donor.h[j * n + i] as number, donor.s[j * n + i] as number)
      t.area[cell] = (t.area[cell] as number) + facet
      t.sums[cell * 3] = (t.sums[cell * 3] as number) + rgb.r * facet
      t.sums[cell * 3 + 1] = (t.sums[cell * 3 + 1] as number) + rgb.g * facet
      t.sums[cell * 3 + 2] = (t.sums[cell * 3 + 2] as number) + rgb.b * facet
    }
  }
  const values = new Float32Array(t.rows * SLOPE_BANDS * 3)
  for (let c = 0; c < t.rows * SLOPE_BANDS; c++) {
    const a = t.area[c] as number
    if (a <= 0) continue
    for (let k = 0; k < 3; k++) values[c * 3 + k] = (t.sums[c * 3 + k] as number) / a
  }
  fillTable(values, t.area, t.rows, 3)
  return { step: t.step, rows: t.rows, channels: 3, values }
}

/**
 * The colour map a custom island is generated with: the donor's ramp, read at
 * the player's height and slope, `pitch` metres a texel (the donor's own
 * colour pitch, so a face samples the same grain of colour it would on the
 * donor). RGB, row 0 at the top — the order `createMapSampler` reads.
 */
export const paintCustomColour = (
  ground: CustomGround,
  grid: GroundGrid,
  ramp: BandTable,
  pitch: number,
): ImageData8 => {
  const w = Math.max(CUSTOM_GROUND_LIMITS.minEdge, Math.round(ground.size / pitch))
  const data = new Uint8Array(w * w * 3)
  const hs = { h: 0, s: 0 }
  const rgb = new Float32Array(3)
  for (let x = 0; x < w; x++) {
    const u = x / w
    for (let y = 0; y < w; y++) {
      groundAt(grid, u, y / w, hs)
      readBandTable(ramp, hs.h, hs.s, rgb)
      // Unity texel `y` counts from the BOTTOM; this buffer's rows from the top.
      const o = ((w - 1 - y) * w + x) * 3
      data[o] = Math.round(Math.min(1, Math.max(0, rgb[0] as number)) * 255)
      data[o + 1] = Math.round(Math.min(1, Math.max(0, rgb[1] as number)) * 255)
      data[o + 2] = Math.round(Math.min(1, Math.max(0, rgb[2] as number)) * 255)
    }
  }
  return { width: w, height: w, channels: 3, data }
}

// ── Density ───────────────────────────────────────────────────────────────

/**
 * How one of the donor's scatter passes sits on its ground: the density map's
 * mean grey in each (height, slope) band, MEASURED OFF THE BAKE.
 *
 * The density maps themselves are never published (O13 / C-6, `placements.ts`)
 * and must not be. But the bake is: `scatterProps` accepts a texel with
 * probability `grey * probabilityScale`, so over a band
 *
 *     accepted / texels = meanGrey * probabilityScale
 *
 * and the committed placements, counted per band against every texel of the
 * donor's own height map, give the mean grey back — no map, no new number,
 * and nothing that can drift from the forest the donor actually draws. The
 * DEV-100 spawn clearings took 0.08–0.4 % of each draw out of the bake before
 * it was committed; that is left in, as a bias far below a band's own noise.
 */
export const measureDensityBands = (
  pass: PropScatter,
  donor: GroundGrid,
  grain: DonorGrain,
): BandTable => {
  const t = emptyTable(grain.terrainHeight, 1)
  const w = pass.placements.mapWidth
  const h = pass.placements.mapHeight
  const texelArea = (grain.terrainSize / w) * (grain.terrainSize / h)
  const hs = { h: 0, s: 0 }
  // EVERY texel, not a strided sample: a band is a few texels wide where the
  // ground is steep, and a stride that is not a multiple of that width aliases
  // against it — a first draft counting every second texel read a uniform 0.8
  // back as 0.94. `groundAt` is a bilinear read of two arrays, so the full
  // census of Simonet's 2048² grid costs tens of milliseconds.
  const texels = new Float64Array(t.rows * SLOPE_BANDS)
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      groundAt(donor, x / w, y / h, hs)
      const cell = cellOf(t, hs.h, hs.s)
      texels[cell] = (texels[cell] as number) + 1
    }
  }
  const accepted = new Float64Array(t.rows * SLOPE_BANDS)
  const bytes = decodeBase64(pass.placements.data)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let o = 0; o + PLACEMENT_STRIDE <= bytes.length; o += PLACEMENT_STRIDE) {
    groundAt(donor, view.getUint16(o, true) / w, view.getUint16(o + 2, true) / h, hs)
    const cell = cellOf(t, hs.h, hs.s)
    accepted[cell] = (accepted[cell] as number) + 1
  }
  const values = new Float32Array(t.rows * SLOPE_BANDS)
  const scale = pass.probabilityScale
  for (let c = 0; c < t.rows * SLOPE_BANDS; c++) {
    const n = texels[c] as number
    t.area[c] = n * texelArea
    if (n <= 0 || !(scale > 0)) continue
    values[c] = Math.min(1, (accepted[c] as number) / (n * scale))
  }
  fillTable(values, t.area, t.rows, 1)
  return { step: t.step, rows: t.rows, channels: 1, values }
}

/** The nearest power of two — the grid `scatterProps` walks without rescaling. */
const nearestPow2 = (n: number): number => 2 ** Math.max(0, Math.round(Math.log2(Math.max(1, n))))

/**
 * One donor pass, re-run over the player's ground: a density map painted from
 * the donor's bands at the player's height and slope, scattered by
 * `scatterProps` with the donor's own seed rule, and packed back into the
 * shape `load-props.ts` already reads — so the forest on a custom island goes
 * through the same expansion, snap, slope limit, volumes, LOD and colliders as
 * every shipped one, and no second prop path exists.
 *
 * The map's grid is a power of two, so `scatterProps` walks it as painted; its
 * texel pitch is then as near the donor's as a power of two gets, and
 * `probabilityScale` is scaled by the ratio of texel AREAS so the props per
 * hectare match the donor's (a texel twice the area takes twice the chance).
 */
export const customScatterPass = (
  pass: PropScatter,
  bands: BandTable,
  ground: CustomGround,
  grid: GroundGrid,
  donorTerrainSize: number,
): PropScatter => {
  const donorPitch = donorTerrainSize / pass.placements.mapWidth
  const w = nearestPow2(ground.size / donorPitch)
  const pitch = ground.size / w
  const hs = { h: 0, s: 0 }
  const d = new Float32Array(1)
  const data = new Uint8Array(w * w)
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < w; y++) {
      groundAt(grid, x / w, y / w, hs)
      readBandTable(bands, hs.h, hs.s, d)
      // `scatterProps` reads texel y from row `height - 1 - y` (Unity's origin).
      data[(w - 1 - y) * w + x] = Math.round(Math.min(1, Math.max(0, d[0] as number)) * 255)
    }
  }
  if (!isPowerOfTwo(w)) throw new Error(`custom scatter: ${w} is not a power of two`)
  const density: ImageData8 = { width: w, height: w, channels: 1, data }
  const probabilityScale = pass.probabilityScale * (pitch / donorPitch) ** 2
  const params = {
    probabilityScale,
    heightOffset: pass.heightOffset,
    scaleMin: pass.scaleMin,
    scaleMax: pass.scaleMax,
    paletteSize: pass.palette.length,
    // The loader's rule, which it CHECKS against this (`buildScatterGroup`).
    seed: pass.placements.seed,
  }
  const terrain = {
    terrainSize: ground.size,
    terrainHeight: ground.maxHeight,
    chunkSize: donorLand(ground.island).entry.chunkSize,
  }
  const scattered = scatterProps(density, customHeightSampler(ground), terrain, params)
  return {
    ...pass,
    probabilityScale,
    placements: {
      count: scattered.count,
      clearedBySpawnClearing: 0,
      mapWidth: w,
      mapHeight: w,
      seed: params.seed,
      stride: PLACEMENT_STRIDE,
      data: encodeBase64(encodePlacements(scattered, params)),
    },
  }
}

/**
 * The donor environment's props, over the player's ground: every scatter pass
 * re-run by {@link customScatterPass}, and the LANDMARKS DROPPED — desert's
 * spires and Simonet's sea stack were placed for the donor's ground, and on
 * someone else's they stand in a valley or hang off a ridge.
 *
 * `spawnClearing` keeps its RADIUS (DEV-475's start pad is cleared by it) and
 * loses its mission centres, which are the donor's spawns in the donor's mesh
 * frame and mean nothing here. Each pass's `shipped2016` receipt is kept, so
 * Classic's filter (DEV-102) picks the same passes it would on the donor.
 */
export const customEnvironmentProps = (
  donorEnv: EnvironmentProps,
  donor: GroundGrid,
  ground: CustomGround,
  grid: GroundGrid,
): { readonly env: EnvironmentProps; readonly bands: readonly BandTable[] } => {
  const grain = donorLand(ground.island).entry
  const bands = donorEnv.scatter.map((pass) => measureDensityBands(pass, donor, grain))
  const scatter = donorEnv.scatter.map((pass, i) =>
    customScatterPass(pass, bands[i] as BandTable, ground, grid, grain.terrainSize),
  )
  const env: EnvironmentProps = {
    ...donorEnv,
    scatter,
    landmarks: [],
    ...(donorEnv.spawnClearing
      ? { spawnClearing: { ...donorEnv.spawnClearing, missions: [] } }
      : {}),
  }
  return { env, bands }
}

/**
 * The ground a course's LINE keeps clear on a custom island: one capsule from
 * the start to the first gate, then gate to gate, each `radius` wide — the
 * shape DEV-287's `["spawn", "gate:0"]`, `["gate:0", "gate:1"]` … volumes
 * resolve to, written out because a player course has no authored volume file
 * to name them in. `points` are SIM world space (the spawn first, then the
 * live gates in order) and `origin` is the terrain's SIM origin, so each end
 * is the one subtraction `game/props/no-prop-volumes.ts` makes.
 *
 * A custom island's forest is scattered at load over ground nobody placed a
 * course on yet, so without this a line through a wood is a line through
 * solid trunks (DEV-214's colliders). The shipped islands' volumes are
 * authored, and this does not touch them.
 */
export const courseCorridor = (
  points: readonly { readonly x: number; readonly z: number }[],
  radius: number,
  origin: readonly number[],
): Clearing[] => {
  const ox = origin[0] ?? 0
  const oz = origin[2] ?? 0
  const out: Clearing[] = []
  if (!(radius > 0)) return out
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as { x: number; z: number }
    const b = points[i + 1] as { x: number; z: number }
    out.push({ x: a.x - ox, z: a.z - oz, x2: b.x - ox, z2: b.z - oz, radius })
  }
  return out
}

/** A donor's ground grid, at its own facet: the one every table above is measured on. */
export const donorGroundGrid = (island: string, donorHeight: MapSampler): GroundGrid => {
  const t = donorLand(island).entry
  return groundGrid(donorHeight, t.terrainSize, t.terrainHeight, t.baseResolution)
}

/** A custom island's ground grid, at its donor's facet. */
export const customGroundGrid = (ground: CustomGround): GroundGrid =>
  groundGrid(
    customHeightSampler(ground),
    ground.size,
    ground.maxHeight,
    donorLand(ground.island).entry.baseResolution,
  )

// ── A synthetic island, for the tests and the preview door ────────────────

/**
 * Where the preview cone's waterline sits, 0..1 of its donor's height: where
 * Simonet's sea stands in its own land's mesh frame — the sea surface's 116.6 m
 * (`render/water.ts`, a sample near the origin) above the land group's
 * −81.69 m, over its 1,536 m — so the cone has a beach on the island every
 * test flies. A FIXTURE's number, not a policy: on the sealess islands it is
 * just low ground.
 */
export const PREVIEW_SHORE = (116.6 + 81.69) / 1536

/** The summit of the preview cone, 0..1 of its donor's height: ~500 m above that sea. */
export const PREVIEW_PEAK = 0.45

/**
 * The synthetic grounds the PREVIEW build's `?island=` door knows, by name —
 * `boot/app.ts` honours the door only off the release channel. Null for a name
 * it does not know. The grid is 4 m a sample at the donor's own size.
 */
/**
 * The `?island=` door's whole decision, pure so a test can hold it: on the
 * RELEASE channel the level is returned untouched whatever the switch says;
 * elsewhere a known name puts its ground under the level. `boot/app.ts` calls
 * it with `BUILD_CHANNEL` and the page's own parameter. (And `island` is not
 * a presentation switch, so `game/run-taint.ts` taints every lap flown with
 * it — also held by the test.)
 */
export const previewIslandDoor = (
  // `content/build-channel.ts`'s `BuildChannel`, spelled here rather than
  // imported: that module reaches `edition-schema.ts` and through it
  // `render/aperture.ts`, and the editor core, which imports this file, may
  // reach no render module (`editor-core.test.ts` walks the graph).
  channel: 'release' | 'preview',
  name: string | null,
  level: Level,
): Level => {
  if (channel === 'release' || !name) return level
  const ground = previewIsland(name, level.environment)
  return ground ? withCustomGround(level, ground) : level
}

export const previewIsland = (name: string, island: string): CustomGround | null => {
  if (name !== 'cone') return null
  const t = donorLand(island).entry
  return coneIsland({
    island,
    size: t.terrainSize,
    maxHeight: t.terrainHeight,
    edge: t.terrainSize / 4 + 1,
    shore: PREVIEW_SHORE,
    peak: PREVIEW_PEAK,
  })
}

/**
 * A cone island with ridges: the ground DEV-489's tests and its preview door
 * (`?island=cone`, `boot/app.ts`) fly over. NOT a player-facing generator —
 * that is DEV-493's `synthesiseIsland` — just a shape with every kind of
 * ground on it: open water round the edge, a beach, gentle shoulders, steep
 * ridges and a summit, so the colour ramp and the density bands are exercised
 * across their whole range.
 *
 * `shore` is where the waterline sits and `peak` the summit, both 0..1 of
 * `maxHeight`: the caller picks them against the donor's sea.
 */
export const coneIsland = (opts: {
  readonly island: string
  readonly size: number
  readonly maxHeight: number
  readonly edge: number
  readonly shore: number
  readonly peak: number
}): CustomGround => {
  const { edge, shore, peak } = opts
  const data = new Float32Array(edge * edge)
  for (let row = 0; row < edge; row++) {
    for (let col = 0; col < edge; col++) {
      const x = col / (edge - 1) - 0.5
      const z = row / (edge - 1) - 0.5
      const r = Math.hypot(x, z) * 2
      const a = Math.atan2(z, x)
      // Five ridges round the cone, and a notch of shoulder between them.
      const ridge = 1 + 0.18 * Math.cos(5 * a) + 0.06 * Math.cos(13 * a + 1.3)
      const t = Math.max(0, 1 - r / (0.8 * ridge))
      // A floor below the shore, and a concave rise to the summit.
      const h = shore * 0.5 + (peak - shore * 0.5) * t ** 1.6
      data[row * edge + col] = Math.min(1, Math.max(0, h))
    }
  }
  return assertCustomGround({
    heights: { width: edge, height: edge, data },
    size: opts.size,
    maxHeight: opts.maxHeight,
    island: opts.island,
  })
}
