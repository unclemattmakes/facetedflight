// src/sim/terrain/dequantise.ts — the height between the 8-bit levels. DEV-131.
//
// Matt: *"the highest detail of terrain looks terraced to me."* It is, and the
// terraces are in the DATA, not in the drawing of it.
//
// ── The diagnosis, in numbers ────────────────────────────────────────────
//
// Every 2016 height map is an 8-bit PNG (`colorType 2, depth 8` in the file;
// there is no 16-bit source anywhere in the project), and
// `FacetedTerrain.cs:591` scales its grey by `TerrainHeight`. On Simonet that
// is 1536 m over 255 levels: **one grey level is 6.02 m**, and on the 1024 m
// worlds it is 4.02 m. Then the addressing (`u * width`, DEV-007) puts every
// 4 m grid vertex EXACTLY on a texel centre — `fx = x / 1024 * 1024 = x`, so
// `tx = 0` and bilinear never interpolates — and the 8 m grid on every second
// texel. Measured through `importUnityTexture()` on all four maps
// (`scratch/terrain-look/height-steps.mjs`): **0.0 % of adjacent grid heights
// differ by less than half a level** at either pitch. On Simonet's 4 m grid
// 70 % of neighbours are exactly level, the p90 run of level samples is 9
// (36 m), and the next-commonest step is exactly 6.02 m. A 36 m shelf and a
// 6 m riser is a terrace; at 8 m facets the riser is a 37-degree face and at
// 4 m it is 56 degrees, which is why the detail ring shows it and 2016 (whose
// facets were never finer than 8 m — video 5:50, the canyon) mostly did not.
//
// So the ring cannot be fixed by sampling better: there is nothing between the
// texels to sample. What CAN be said is that the true surface, before the
// exporter rounded it, lay within **half a level** of every stored value —
// that is what 8-bit rounding means. Any surface inside that band is a
// candidate the data cannot rule out, and a staircase is the least plausible
// candidate of all.
//
// ── The reconstruction ───────────────────────────────────────────────────
//
// Blur the level grid (two passes of a box, i.e. a triangle kernel, radius
// `radiusTexels`), then CLAMP the result back into `[level - 1/2, level + 1/2]`
// at every texel. On a staircase of shelves and single-level risers the blur
// is close to the ramp the shelves were quantised from, and a ramp through a
// staircase never leaves the half-level band, so the clamp passes it: the
// terrace becomes a slope. On a genuine cliff the blur wanders metres from the
// data and the clamp pulls it straight back: the cliff keeps its height to
// within half a level. **Nothing this produces is more than half a level from
// the stored map** — that invariant is the whole argument, and the test
// asserts it on every texel.
//
// A feature smaller than one level cannot be told from rounding noise, so
// smoothing it costs nothing that was ever known. A feature larger than a level
// survives, by the clamp. That is why the radius can be generous.
//
// ── Where it applies ─────────────────────────────────────────────────────
//
// The detail ring only (`terrain.detailRing.smoothMetres`, Anniversary). LOD 0
// and above are built from the base grid, byte for byte what 2016 baked and
// what `pnpm oracle:sweep` compares — Classic's silhouette carries the
// terraces because 2016's did. The collision field (`height-field.ts`) is also
// untouched: it already disagrees with the render mesh by the jitter (DEV-041),
// and half a level is the same order.
//
// SIM LAYER: a pure function of the map and one number. No three, no DOM, no
// clock, no random.

import { grayscale } from './faceted'
import {
  createGreySampler,
  createMapSampler,
  type GreyDataF32,
  type ImageData8,
  type MapSampler,
} from './image-sampler'

/**
 * The stored levels of an `ImageData8` texel — a property of the TYPE
 * (`Uint8`), not a tuning number: `createMapSampler` divides by the same 255.
 * Half of one level is the band the true height is known to lie in.
 */
export const UINT8_LEVELS = 255

/**
 * One separable box pass of radius `r` (texels), clamp-to-edge, over a
 * row-major grid. Running sums, so O(n) whatever the radius.
 */
const boxBlur = (src: Float32Array, width: number, height: number, r: number): Float32Array => {
  const out = new Float32Array(src.length)
  const tmp = new Float32Array(src.length)
  const span = 2 * r + 1
  // Rows.
  for (let y = 0; y < height; y++) {
    const row = y * width
    let sum = 0
    for (let k = -r; k <= r; k++) sum += src[row + Math.min(Math.max(k, 0), width - 1)] as number
    for (let x = 0; x < width; x++) {
      tmp[row + x] = sum / span
      const leave = src[row + Math.max(x - r, 0)] as number
      const enter = src[row + Math.min(x + r + 1, width - 1)] as number
      sum += enter - leave
    }
  }
  // Columns.
  for (let x = 0; x < width; x++) {
    let sum = 0
    for (let k = -r; k <= r; k++)
      sum += tmp[Math.min(Math.max(k, 0), height - 1) * width + x] as number
    for (let y = 0; y < height; y++) {
      out[y * width + x] = sum / span
      const leave = tmp[Math.max(y - r, 0) * width + x] as number
      const enter = tmp[Math.min(y + r + 1, height - 1) * width + x] as number
      sum += enter - leave
    }
  }
  return out
}

/**
 * The grey level of every texel, 0..1, exactly as `buildVertexGrid` would read
 * it through `createMapSampler` at a texel centre: Unity's luminance of the
 * stored bytes, channel 0 replicated when there are fewer than three.
 */
export const heightLevels = (img: ImageData8): GreyDataF32 => {
  const { width, height, channels, data } = img
  const out = new Float32Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const o = i * channels
    const r = (data[o] as number) / UINT8_LEVELS
    const g = channels > 1 ? (data[o + 1] as number) / UINT8_LEVELS : r
    const b = channels > 2 ? (data[o + 2] as number) / UINT8_LEVELS : r
    out[i] = grayscale(r, g, b)
  }
  return { width, height, data: out }
}

/**
 * Reconstruct a height map between its 8-bit levels. See the header.
 *
 * `radiusTexels` below 1 is the identity — and it is the identity BY
 * CONSTRUCTION, returning `createMapSampler(img)` itself rather than a float
 * copy that happens to agree, so a preset with `smoothMetres: 0` samples the
 * exact object LOD 0 does.
 *
 * The blur runs on the LUMINANCE grid and the result reads back as neutral
 * rgb, so `grayscale()` downstream is the identity on it. Luminance is linear
 * in the channels, so blurring the grey is the same as blurring the channels
 * and taking the grey afterwards; doing it once is three times cheaper.
 */
export const dequantiseHeightMap = (img: ImageData8, radiusTexels: number): MapSampler => {
  const r = Math.round(radiusTexels)
  if (!(r >= 1)) return createMapSampler(img)
  const levels = heightLevels(img)
  // Two box passes: a triangle kernel, which has no ringing and a smooth top,
  // where one box leaves a visible plateau at each shelf's centre.
  const smooth = boxBlur(boxBlur(levels.data, img.width, img.height, r), img.width, img.height, r)
  const half = 0.5 / UINT8_LEVELS
  const out = new Float32Array(levels.data.length)
  for (let i = 0; i < out.length; i++) {
    const level = levels.data[i] as number
    const s = smooth[i] as number
    out[i] = s < level - half ? level - half : s > level + half ? level + half : s
  }
  return createGreySampler({ width: img.width, height: img.height, data: out })
}

/**
 * Metres of smoothing → texels of radius, for a map that covers `terrainSize`
 * metres with `width` texels. `FacetedTerrain` maps u = 0..1 across the whole
 * terrain, so a texel is `terrainSize / width` metres: 4 m on every shipped
 * map. Rounded by `dequantiseHeightMap`.
 */
export const smoothRadiusTexels = (
  smoothMetres: number,
  terrainSize: number,
  width: number,
): number =>
  smoothMetres > 0 && terrainSize > 0 && width > 0 ? smoothMetres / (terrainSize / width) : 0
