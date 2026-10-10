// Type declarations for tga.mjs. See png.d.mts for why these are separate.

export interface DecodedTga {
  readonly width: number
  readonly height: number
  /** 3 for 24-bit, 4 for 32-bit. */
  readonly channels: number
  /** Raw 8-bit RGB(A) samples, row-major, row 0 at the TOP — as `decodeBmp`. */
  readonly data: Uint8Array
}

export interface TgaHeader {
  readonly idLength: number
  readonly colourMapType: number
  readonly imageType: number
  readonly imageTypeName: string
  readonly width: number
  readonly height: number
  readonly bitsPerPixel: number
  readonly topDown: boolean
  readonly rightToLeft: boolean
  readonly bytes: number
}

/**
 * Decode an uncompressed true-colour Targa (24 or 32 bpp). Handles both
 * vertical origins and BGR(A) channel order. Throws, by name, on everything
 * else — RLE, colour-mapped, grayscale, and right-to-left pixel order.
 */
export declare const decodeTga: (filePath: string) => DecodedTga

/** The 18-byte header, without reading the pixels. */
export declare const readTgaHeader: (filePath: string) => TgaHeader
