// Type declarations for png-diff.mjs.
//
// The comparator stays plain JavaScript so it runs under bare `node` with no
// build step and with no dependency — `png-diff.mjs`'s own header says why it
// carries its own PNG decoder rather than adding one. This file gives the
// TypeScript side (`tests/unit/png-diff-mask.test.ts`) real types without
// dragging the tool into the compiler's world. Same convention as
// `tools/terrain/png.d.mts`.

/** A decoded 8-bit image: `ch` samples per pixel, row-major. */
export interface DecodedPng {
  readonly w: number
  readonly h: number
  /** Samples per pixel: 1 grey, 3 RGB, 4 RGBA. */
  readonly ch: number
  readonly data: Uint8Array | Buffer
}

export declare const decodePng: (buf: Buffer) => DecodedPng

/** One byte per PIXEL, and what share of the frame it kept. */
export interface PngMask {
  readonly keep: Uint8Array
  readonly share: number
}

/**
 * The pixels where `a` and the mask render differ by more than 24 levels on any
 * colour channel. Null when the two are not the same size. See `--mask=` in
 * `png-diff.mjs`'s header for what it is for and what it is a bound on.
 */
export declare const maskFrom: (a: DecodedPng, m: DecodedPng) => PngMask | null

/** The spatial shape of a mask — see `blobStats` for why a mean is not enough. */
export interface PngBlobStats {
  /** Pixels the mask keeps. */
  readonly moved: number
  readonly movedShare: number
  /** Pixels in the biggest 4-connected component. */
  readonly largest: number
  readonly largestShare: number
  /** How many components are at least `minShare` of the frame. */
  readonly components: number
}

/**
 * Largest 4-connected component of a per-pixel mask, and how many components
 * clear `minShare`. Null when `keep` is not `w * h` long.
 */
export declare const blobStats: (
  keep: Uint8Array,
  w: number,
  h: number,
  minShare?: number,
) => PngBlobStats | null

export interface PngComparison {
  /** Mean absolute per-channel difference, 0..255. */
  readonly mean: number
  readonly max: number
  /** Share of counted channels moving by more than 24 levels. */
  readonly over: number
}

/**
 * Compare two ALREADY DECODED frames, over the whole frame or over `mask`'s
 * pixels. Null on a size mismatch, or when a mask selects nothing.
 */
export declare const compareDecoded: (
  a: DecodedPng,
  b: DecodedPng,
  mask?: Uint8Array | null,
) => PngComparison | null

/**
 * Compare two encoded PNGs, over the whole frame or over `mask`'s pixels.
 * Null on a size mismatch, or when a mask selects nothing.
 */
export declare const comparePng: (
  aBuf: Buffer,
  bBuf: Buffer,
  mask?: Uint8Array | null,
) => PngComparison | null
