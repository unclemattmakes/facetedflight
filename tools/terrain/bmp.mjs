// tools/terrain/bmp.mjs — just enough BMP to read one 2016 asset.
//
// `water_color.bmp` is the only BMP in the shipped content: 513x513, 24-bit,
// uncompressed. It exists because World Machine wrote it that way in 2015 and
// nobody re-saved it. `tools/assets/extract-terrain-maps.mjs` re-encodes it to
// PNG on the way out — 790 KB of BMP becomes a fraction of that — so the
// runtime never learns BMP exists.
//
// Two things about the format that are easy to get wrong and silent when you
// do:
//
//  1. **Rows run BOTTOM-UP** when the header's height is positive. Read them
//     top-down and the ocean's colour map is flipped, which on a mostly-uniform
//     sea looks like nothing at all until it meets the coast.
//  2. **Each row is padded to a 4-byte boundary.** 513 pixels x 3 bytes is
//     1539, padded to 1540. Ignore the padding and every row after the first
//     shears sideways by one byte, which reads as diagonal streaking.
//
// Pixels are stored BGR, not RGB.
//
// Deliberately narrow: 24-bit uncompressed only. Anything else throws rather
// than returning quietly wrong pixels — the same contract as `png.mjs`.

import fs from 'node:fs'

/** Decode a 24-bit uncompressed BMP to `{ width, height, channels: 3, data }`. */
export const decodeBmp = (filePath) => {
  const buf = fs.readFileSync(filePath)
  if (buf.toString('ascii', 0, 2) !== 'BM') throw new Error(`not a BMP: ${filePath}`)

  const dataOffset = buf.readUInt32LE(10)
  const width = buf.readInt32LE(18)
  const rawHeight = buf.readInt32LE(22)
  const bpp = buf.readUInt16LE(28)
  const compression = buf.readUInt32LE(30)

  if (bpp !== 24) throw new Error(`${filePath}: ${bpp}-bit BMP; only 24-bit is supported`)
  if (compression !== 0) {
    throw new Error(`${filePath}: compression ${compression}; only uncompressed is supported`)
  }

  // A NEGATIVE height means the rows are already top-down.
  const height = Math.abs(rawHeight)
  const bottomUp = rawHeight > 0
  const stride = Math.ceil((width * 3) / 4) * 4

  if (dataOffset + stride * height > buf.length) {
    throw new Error(
      `${filePath}: truncated — need ${dataOffset + stride * height} bytes, have ${buf.length}`,
    )
  }

  const out = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y++) {
    const srcRow = dataOffset + (bottomUp ? height - 1 - y : y) * stride
    for (let x = 0; x < width; x++) {
      const s = srcRow + x * 3
      const d = (y * width + x) * 3
      // BGR -> RGB.
      out[d] = buf[s + 2]
      out[d + 1] = buf[s + 1]
      out[d + 2] = buf[s]
    }
  }

  return { width, height, channels: 3, data: out }
}
