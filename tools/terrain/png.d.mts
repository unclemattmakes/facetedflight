// Type declarations for png.mjs.
//
// The decoder stays plain JavaScript so it runs under bare `node` with no
// build step — the extraction tools must work from a cold clone. This file
// gives the TypeScript side (tests, and any future build script) real types
// without dragging the tool into the compiler's world.

export interface DecodedPng {
  readonly width: number
  readonly height: number
  /** Samples per pixel: 1 grey, 2 grey+alpha, 3 RGB, 4 RGBA. */
  readonly channels: number
  /** Raw 8-bit samples, row-major, `channels` per pixel. */
  readonly data: Buffer
}

export declare const decodePng: (filePath: string) => DecodedPng

/** Decode from bytes already in memory (e.g. a Playwright screenshot). */
export declare const decodePngBuffer: (buf: Buffer, label?: string) => DecodedPng

/**
 * Encode 8-bit samples as a non-interlaced PNG. `channels` picks the colour
 * type: 1 grey, 2 grey+alpha, 3 RGB, 4 RGBA.
 */
export declare const encodePng: (
  img: {
    readonly width: number
    readonly height: number
    readonly channels: number
    readonly data: Uint8Array | Buffer
  },
  opts?: { readonly level?: number },
) => Buffer
