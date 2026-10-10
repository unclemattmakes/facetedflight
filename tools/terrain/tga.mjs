// tools/terrain/tga.mjs — read a Targa, because World Machine wrote one.
//
// `forest_02_height.tga` is the height map behind 2016's TITLE SCREEN — the
// alpine valley you stand in on `main_menu.unity`, which turns out to be built
// with `FacetedTerrain`, this port's own generator (DEV-039). Every other map in
// the project is a PNG or a BMP and `extract-terrain-maps.mjs` already reads
// both; this one is a TGA and nothing here could open it.
//
// ── Deliberately the smallest decoder that reads OUR file ────────────────
//
// Targa has colour-mapped modes, RLE modes, 15/16-bit packed pixels, an
// optional footer and an optional developer area. Our file uses none of it:
//
//     idLength 0   colourMapType 0   imageType 2 (uncompressed true-colour)
//     1025 x 1025  32 bpp  descriptor 0x28 (top-left origin, 8 alpha bits)
//     18 + 1025*1025*4 = 4,202,518 bytes, which is the file size exactly
//
// So this reads uncompressed true-colour at 24 or 32 bpp and REFUSES the rest,
// by name, with the byte that says so. A decoder that silently mis-reads a
// format it half-supports is worse than one that stops: the output here becomes
// terrain, and wrong terrain is the most expensive kind of wrong in this project
// (two `islandgroup_height.png` files, CLAUDE.md).
//
// The legacy Unity project is READ-ONLY. This reads and never writes there.

import fs from 'node:fs'

const IMAGE_TYPES = {
  0: 'no image data',
  1: 'colour-mapped',
  2: 'true-colour',
  3: 'grayscale',
  9: 'RLE colour-mapped',
  10: 'RLE true-colour',
  11: 'RLE grayscale',
}

/**
 * Decode an uncompressed true-colour Targa.
 *
 * Returns `{ width, height, channels, data }` with rows TOP-DOWN and channels
 * in RGB(A) order — the same shape `decodeBmp` returns, so callers cannot tell
 * which one they got. That matters: `extract-terrain-maps.mjs` hands the result
 * straight to `encodePng`.
 *
 * @param {string} filePath
 * @returns {{ width: number, height: number, channels: number, data: Uint8Array }}
 */
export const decodeTga = (filePath) => {
  const buf = fs.readFileSync(filePath)
  if (buf.length < 18) throw new Error(`${filePath}: too short to be a TGA (${buf.length} bytes)`)

  const idLength = buf[0]
  const colourMapType = buf[1]
  const imageType = buf[2]
  const width = buf.readUInt16LE(12)
  const height = buf.readUInt16LE(14)
  const bpp = buf[16]
  const descriptor = buf[17]

  if (imageType !== 2) {
    const name = IMAGE_TYPES[imageType] ?? 'unknown'
    throw new Error(
      `${filePath}: image type ${imageType} (${name}); only 2 (uncompressed true-colour) is supported`,
    )
  }
  if (colourMapType !== 0) {
    throw new Error(`${filePath}: colour map type ${colourMapType}; only 0 is supported`)
  }
  if (bpp !== 24 && bpp !== 32) {
    throw new Error(`${filePath}: ${bpp} bits per pixel; only 24 and 32 are supported`)
  }
  if (width <= 0 || height <= 0) {
    throw new Error(`${filePath}: degenerate size ${width} x ${height}`)
  }

  const channels = bpp / 8
  const start = 18 + idLength
  const need = start + width * height * channels
  if (buf.length < need) {
    throw new Error(`${filePath}: truncated — need ${need} bytes, have ${buf.length}`)
  }

  // Bit 5 of the descriptor is the vertical origin: SET means the first row in
  // the file is the TOP row. Clear — the older convention — means bottom-up,
  // like a BMP. Ours is set; both are handled because getting this backwards
  // mirrors the terrain and a mirrored heightfield is a plausible-looking
  // island that is wrong everywhere (the mirror bug, CLAUDE.md).
  const topDown = (descriptor & 0x20) !== 0
  // Bit 4 is the horizontal origin: SET means right-to-left. Refused rather
  // than handled, because no file we have uses it and an untested branch that
  // flips an axis is exactly the kind of code that ships a mirror.
  if ((descriptor & 0x10) !== 0) {
    throw new Error(`${filePath}: right-to-left pixel order is not supported`)
  }

  const out = new Uint8Array(width * height * channels)
  for (let y = 0; y < height; y++) {
    const srcRow = start + (topDown ? y : height - 1 - y) * width * channels
    for (let x = 0; x < width; x++) {
      const s = srcRow + x * channels
      const d = (y * width + x) * channels
      // Targa stores BGR(A), like a BMP.
      out[d] = buf[s + 2]
      out[d + 1] = buf[s + 1]
      out[d + 2] = buf[s]
      if (channels === 4) out[d + 3] = buf[s + 3]
    }
  }

  return { width, height, channels, data: out }
}

/**
 * The header, without reading the pixels.
 *
 * For tools that want to report what a file is before deciding to decode it —
 * and for the test, which asserts the shape of the real file without loading
 * four megabytes into an assertion.
 *
 * @param {string} filePath
 */
export const readTgaHeader = (filePath) => {
  const fd = fs.openSync(filePath, 'r')
  try {
    const buf = Buffer.alloc(18)
    fs.readSync(fd, buf, 0, 18, 0)
    return {
      idLength: buf[0],
      colourMapType: buf[1],
      imageType: buf[2],
      imageTypeName: IMAGE_TYPES[buf[2]] ?? 'unknown',
      width: buf.readUInt16LE(12),
      height: buf.readUInt16LE(14),
      bitsPerPixel: buf[16],
      topDown: (buf[17] & 0x20) !== 0,
      rightToLeft: (buf[17] & 0x10) !== 0,
      bytes: fs.statSync(filePath).size,
    }
  } finally {
    fs.closeSync(fd)
  }
}
