// Type declarations for bmp.mjs. See png.d.mts for why these are separate.

export interface DecodedBmp {
  readonly width: number
  readonly height: number
  /** Always 3: only 24-bit uncompressed BMP is supported. */
  readonly channels: number
  /** Raw 8-bit RGB samples, row-major, row 0 at the TOP. */
  readonly data: Uint8Array
}

/**
 * Decode a 24-bit uncompressed BMP. Handles bottom-up row order, 4-byte row
 * padding and BGR channel order. Throws on anything else.
 */
export declare const decodeBmp: (filePath: string) => DecodedBmp
