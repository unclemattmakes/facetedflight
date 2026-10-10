// src/sim/terrain/image-sampler.ts — Unity's texture import and sampling,
// reimplemented. Shared by the Node oracle harness and the browser runtime.
//
// ── Why this is its own module, in the SIM layer ──────────────────────────
//
// This arithmetic decides the height of every vertex in the world. It used to
// live in a `tools/` script used by one test, and the browser was about to get
// a second copy, because a canvas gives you pixels and something has to filter
// them. Two implementations of the function under test is the classic way a
// port drifts: the tested one stays right, the shipped one quietly isn't, and
// the oracle test goes on passing while the game renders a different island.
//
// ── What "sample the heightmap" actually means in Unity ───────────────────
//
// `FacetedTerrain.cs` calls `SourceHeightMap.GetPixelBilinear(u, v)`. That is
// not a read of the PNG on disk. It is a read of the *imported texture*, and
// Unity's importer is not a no-op. Two transforms sit in between, and missing
// either one costs metres of terrain height:
//
//  1. **Non-power-of-two rescaling.** Both Simonet maps are 1025x1025 and
//     their `.meta` files carry `nPOTScale: 1` — `TextureImporterNPOTScale
//     .ToNearest`. Unity resamples them to **1024x1024 at import**, so the
//     1025-pixel image is never what the generator sees. See `resampleBilinear`
//     and `npotNearest`.
//
//  2. **Texel addressing is `u * width`, not `u * (width - 1)`.** Unity treats
//     the coordinate as spanning the texture rather than running from the first
//     texel centre to the last. Getting this wrong displaces the sample by `u`
//     texels — nothing at the origin, a full texel at the far edge.
//
// Both were found the same way, and the story is worth keeping. The oracle test
// verified chunk (0,0) of Simonet and agreed with the 2016 bake to 4 mm. Chunk
// (0,0) sits at u,v ≈ 0.03, where error (2) is 0.03 of a texel — and it is open
// sea, where error (1) does nothing at all. It was the one chunk in the world
// blind to both bugs. Sweeping all 256 chunks put 48% of inland grid points
// outside the jitter bound, by up to 30 m. With both transforms in place: 1.8%.
//
// The moral is already in CLAUDE.md, but this is its sharpest instance: **one
// spot-check is not a verification.** Least of all the corner one.
//
// ── Matching GetPixelBilinear ─────────────────────────────────────────────
//
//  * **V is flipped.** Unity's v = 0 is the BOTTOM row; PNG row 0 is the TOP.
//    Unity's bottom-origin texel `j` is this buffer's row `height - 1 - j`, so
//    the continuous form is `fy = (height - 1) - v * height`. Getting this
//    wrong mirrors the island group north-to-south, which on a scattered
//    archipelago looks entirely plausible.
//  * **UV is clamped, not wrapped.** The shipped materials are clamp-mode
//    (`wrapMode: 1`), the generator sets it explicitly anyway, and it samples
//    slightly outside [0,1] at the skirt ring. Wrapping would fold the far edge
//    of the map onto the near one.
//
// SIM-LAYER RULES APPLY: no `three`, no DOM, no `Math.random()`. The input is a
// plain struct precisely so this file never needs to know what decoded it —
// Node uses `tools/terrain/png.mjs`, the browser uses `createImageBitmap`.

import { clamp01 } from '../math/scalar'

/** Decoded 8-bit image samples, row-major, `channels` values per pixel. */
export interface ImageData8 {
  readonly width: number
  readonly height: number
  /** Samples per pixel: 1 grey, 2 grey+alpha, 3 RGB, 4 RGBA. */
  readonly channels: number
  /** `width * height * channels` bytes, row 0 at the TOP (PNG/canvas order). */
  readonly data: Uint8Array | Uint8ClampedArray
}

export interface Rgb {
  r: number
  g: number
  b: number
}

/** A sampler over a 2D map: normalised UV in [0,1], clamped at the edges. */
export interface MapSampler {
  readonly width: number
  readonly height: number
  /** Bilinear sample. Writes r,g,b in 0..1 into `out`. */
  sample(u: number, v: number, out: Rgb): void
}

const clampInt = (n: number, hi: number): number => (n < 0 ? 0 : n > hi ? hi : n)

/**
 * `TextureImporterNPOTScale.ToNearest` — nearest power of two. 1025 goes DOWN
 * to 1024, not up to 2048, which is the whole reason the Simonet maps lose a
 * pixel on import.
 */
export const npotNearest = (n: number): number => {
  if (n < 1) return 1
  const lo = 2 ** Math.floor(Math.log2(n))
  const hi = lo * 2
  return n - lo <= hi - n ? lo : hi
}

export const isPowerOfTwo = (n: number): boolean => n > 0 && (n & (n - 1)) === 0

/**
 * Bilinear resample to an exact size, output pixel centres mapped into input
 * space — the standard filter, and close enough to Unity's importer that 98.2%
 * of Simonet's inland grid points land inside the 1.3 m jitter bound.
 *
 * The residual (rms 1.0 m against a 0.58 m jitter floor) is this filter not
 * being byte-identical to Unity's. Closing it would mean reverse-engineering a
 * 2016 importer to recover noise an order of magnitude below the faceting, so
 * the measurement lives in docs/DEVIATIONS.md instead.
 */
export const resampleBilinear = (img: ImageData8, dw: number, dh: number): ImageData8 => {
  const { width: sw, height: sh, channels, data } = img
  if (dw === sw && dh === sh) return img
  if (dw < 1 || dh < 1) throw new Error(`resampleBilinear: degenerate target ${dw}x${dh}`)

  const out = new Uint8Array(dw * dh * channels)
  const sx = sw / dw
  const sy = sh / dh
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(Math.max((y + 0.5) * sy - 0.5, 0), sh - 1)
    const y0 = Math.floor(fy)
    const y1 = Math.min(y0 + 1, sh - 1)
    const ty = fy - y0
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(Math.max((x + 0.5) * sx - 0.5, 0), sw - 1)
      const x0 = Math.floor(fx)
      const x1 = Math.min(x0 + 1, sw - 1)
      const tx = fx - x0
      for (let c = 0; c < channels; c++) {
        const a = data[(y0 * sw + x0) * channels + c] as number
        const b = data[(y0 * sw + x1) * channels + c] as number
        const d = data[(y1 * sw + x0) * channels + c] as number
        const e = data[(y1 * sw + x1) * channels + c] as number
        out[(y * dw + x) * channels + c] = Math.round(
          (a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty,
        )
      }
    }
  }
  return { width: dw, height: dh, channels, data: out }
}

/**
 * The one copy of `GetPixelBilinear`'s ADDRESSING — `u * width`, V flipped,
 * edge-clamped — over any texel store. `createMapSampler` and
 * `createGreySampler` are this with different `at` functions, so a float grid
 * (the dequantised height field, DEV-131) and the 8-bit map it came from cannot
 * disagree about where a texel is. DEV-007 was worth 30 m of height; it is not
 * a formula to write twice.
 */
const bilinearSampler = (
  width: number,
  height: number,
  channels: number,
  at: (x: number, y: number, c: number) => number,
): MapSampler => {
  const maxX = width - 1
  const maxY = height - 1
  return {
    width,
    height,
    sample(u: number, v: number, out: Rgb): void {
      const fx = clamp01(u) * width
      const fy = maxY - clamp01(v) * height

      const x0 = Math.floor(fx)
      const y0 = Math.floor(fy)
      const tx = fx - x0
      const ty = fy - y0
      const cx0 = clampInt(x0, maxX)
      const cx1 = clampInt(x0 + 1, maxX)
      const cy0 = clampInt(y0, maxY)
      const cy1 = clampInt(y0 + 1, maxY)

      for (let c = 0; c < 3; c++) {
        const ch = c < channels ? c : 0
        const top = at(cx0, cy0, ch) * (1 - tx) + at(cx1, cy0, ch) * tx
        const bot = at(cx0, cy1, ch) * (1 - tx) + at(cx1, cy1, ch) * tx
        const value = top * (1 - ty) + bot * ty
        if (c === 0) out.r = value
        else if (c === 1) out.g = value
        else out.b = value
      }
    },
  }
}

/**
 * Wrap decoded pixels as `Texture2D.GetPixelBilinear` — bilinear, edge-clamped,
 * V-flipped, addressed as `u * width`.
 *
 * This samples the image it is GIVEN. It does not apply Unity's import-time
 * rescaling, because a sampler cannot know the importer settings. For a map out
 * of the 2016 project use `importUnityTexture`; this is the raw filter, and the
 * right thing for a map FF2 authored itself.
 *
 * Fewer than three channels replicate channel 0, so a greyscale heightmap reads
 * back as neutral rgb rather than red — which matters, because the caller takes
 * the Unity luminance of whatever comes out.
 */
export const createMapSampler = (img: ImageData8): MapSampler => {
  const { width, height, channels, data } = img
  if (width < 1 || height < 1) {
    throw new Error(`createMapSampler: degenerate image ${width}x${height}`)
  }
  if (channels < 1 || channels > 4) {
    throw new Error(`createMapSampler: unsupported channel count ${channels}`)
  }
  if (data.length < width * height * channels) {
    throw new Error(
      `createMapSampler: ${data.length} bytes is short of ` +
        `${width}x${height}x${channels} = ${width * height * channels}`,
    )
  }

  // `as number` rather than `?? 0`: the checks above already proved the buffer
  // is long enough, and x/y/c are clamped to the image, so an undefined here
  // would be a bug worth crashing on — not one to paper over with a black pixel
  // that renders as perfectly plausible terrain.
  return bilinearSampler(
    width,
    height,
    channels,
    (x, y, c) => (data[(y * width + x) * channels + c] as number) / 255,
  )
}

/** One float per texel, 0..1, row 0 at the TOP like `ImageData8`. */
export interface GreyDataF32 {
  readonly width: number
  readonly height: number
  readonly data: Float32Array
}

/**
 * The same sampler over a FLOAT grey grid — what a height field looks like
 * after `dequantiseHeightMap` has reconstructed it between the 8-bit levels.
 * Reads back as neutral rgb, the way a one-channel `ImageData8` does, so the
 * caller's `grayscale()` is the identity on it.
 */
export const createGreySampler = (img: GreyDataF32): MapSampler => {
  const { width, height, data } = img
  if (width < 1 || height < 1) {
    throw new Error(`createGreySampler: degenerate image ${width}x${height}`)
  }
  if (data.length < width * height) {
    throw new Error(`createGreySampler: ${data.length} samples is short of ${width}x${height}`)
  }
  return bilinearSampler(width, height, 1, (x, y) => data[y * width + x] as number)
}

/** `TextureImporter.npotScale`, restricted to the values FF2 needs. */
export type NpotScale = 'none' | 'toNearest'

/**
 * The whole Unity texture-import path: apply the importer's non-power-of-two
 * rescaling, then sample the result the way `GetPixelBilinear` does.
 *
 * **Use this for any map that came out of the 2016 project.** Calling
 * `createMapSampler` on the raw PNG silently skips the rescale, which is worth
 * up to 30 m of terrain height inland — and nothing at all in the corner chunk
 * the oracle test happens to check.
 */
export const importUnityTexture = (
  img: ImageData8,
  npotScale: NpotScale = 'toNearest',
): MapSampler => createMapSampler(importUnityTextureImage(img, npotScale))

/**
 * The import-time half of `importUnityTexture` on its own: the texels Unity
 * actually held, before any sampling. For a caller that needs the GRID rather
 * than a sampler over it — `dequantiseHeightMap` reconstructs between these
 * texels and must start from the same ones the generator reads, or the ring
 * would be smoothing a map the LOD 0 mesh was never built from.
 */
export const importUnityTextureImage = (
  img: ImageData8,
  npotScale: NpotScale = 'toNearest',
): ImageData8 => {
  if (npotScale === 'none' || (isPowerOfTwo(img.width) && isPowerOfTwo(img.height))) {
    return img
  }
  return resampleBilinear(img, npotNearest(img.width), npotNearest(img.height))
}
