// tools/terrain/png.mjs — a minimal, dependency-free PNG decoder.
//
// The World Machine height and colour maps are 8-bit RGB PNGs. Node has zlib
// built in, so decoding them takes ~100 lines and no dependency — which keeps
// the extraction toolchain installable from a cold clone and auditable in one
// sitting. This is build-time only; the browser uses createImageBitmap.
//
// Supports what the 2016 assets actually are: bit depth 8, colour types
// 0 (grey), 2 (RGB), 4 (grey+alpha), 6 (RGBA), non-interlaced. Anything else
// throws loudly rather than returning quietly wrong pixels.

import fs from 'node:fs'
import zlib from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

/** Paeth predictor, straight from the PNG spec. */
const paeth = (a, b, c) => {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/**
 * Decode a PNG file to `{ width, height, channels, data }` where `data` is
 * raw 8-bit samples, row-major, `channels` per pixel.
 */
export const decodePng = (filePath) => decodePngBuffer(fs.readFileSync(filePath), filePath)

/**
 * Same, from bytes already in memory.
 *
 * Exists because a Playwright screenshot arrives as a Buffer, and analysing the
 * PNG the browser produced is far more trustworthy than reading a WebGL canvas
 * back in-page: without `preserveDrawingBuffer` the drawing buffer is cleared
 * after compositing, so an in-page `drawImage(glCanvas)` samples an empty
 * surface and reports one flat colour for a perfectly good frame.
 */
export const decodePngBuffer = (buf, label = '<buffer>') => {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error(`not a PNG: ${label}`)
  }
  const filePath = label

  let pos = 8
  let ihdr = null
  const idat = []

  while (pos < buf.length) {
    const length = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const dataStart = pos + 8

    if (type === 'IHDR') {
      ihdr = {
        width: buf.readUInt32BE(dataStart),
        height: buf.readUInt32BE(dataStart + 4),
        bitDepth: buf[dataStart + 8],
        colorType: buf[dataStart + 9],
        compression: buf[dataStart + 10],
        filter: buf[dataStart + 11],
        interlace: buf[dataStart + 12],
      }
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(dataStart, dataStart + length))
    } else if (type === 'IEND') {
      break
    }

    pos = dataStart + length + 4 // + CRC
  }

  if (!ihdr) throw new Error(`no IHDR in ${filePath}`)
  if (ihdr.bitDepth !== 8 && ihdr.bitDepth !== 16) {
    throw new Error(
      `${filePath}: bit depth ${ihdr.bitDepth} unsupported — 8 and 16 are implemented. ` +
        'Sub-byte depths (1/2/4) need bit unpacking this decoder does not do.',
    )
  }
  if (ihdr.interlace !== 0) throw new Error(`${filePath}: interlaced PNG unsupported`)
  const channels = CHANNELS[ihdr.colorType]
  if (!channels) throw new Error(`${filePath}: colour type ${ihdr.colorType} unsupported`)
  if (ihdr.colorType === 3) {
    throw new Error(`${filePath}: palette PNGs unsupported (no PLTE handling)`)
  }

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const { width, height } = ihdr

  // ── 16-bit ────────────────────────────────────────────────────────────────
  //
  // `kauai_color.png` is 16 bits per channel and this decoder refused it, which
  // is one of the two things that kept the kauai environment unpublished.
  //
  // PNG filtering is defined on BYTES whatever the sample depth — the only
  // difference is the filter distance, which is `channels * bytesPerSample`
  // rather than `channels`. So the loop below is unchanged; it just strides
  // wider. Samples are BIG-ENDIAN (PNG spec 7.1).
  const bytesPerSample = ihdr.bitDepth === 16 ? 2 : 1
  const filterDistance = channels * bytesPerSample
  const stride = width * filterDistance
  const out = Buffer.alloc(stride * height)

  let src = 0
  for (let y = 0; y < height; y++) {
    const filterType = raw[src++]
    const rowStart = y * stride
    const prevStart = rowStart - stride

    for (let x = 0; x < stride; x++) {
      const value = raw[src + x]
      const a = x >= filterDistance ? out[rowStart + x - filterDistance] : 0
      const b = y > 0 ? out[prevStart + x] : 0
      const c = x >= filterDistance && y > 0 ? out[prevStart + x - filterDistance] : 0

      let recon
      switch (filterType) {
        case 0:
          recon = value
          break
        case 1:
          recon = value + a
          break
        case 2:
          recon = value + b
          break
        case 3:
          recon = value + ((a + b) >> 1)
          break
        case 4:
          recon = value + paeth(a, b, c)
          break
        default:
          throw new Error(`${filePath}: bad filter type ${filterType} on row ${y}`)
      }
      out[rowStart + x] = recon & 0xff
    }
    src += stride
  }

  if (bytesPerSample === 1) return { width, height, channels, data: out, bitDepth: 8 }

  // Reduce 16 -> 8 by keeping the HIGH byte, which is the standard reduction
  // (the low byte is the fractional part of the same value).
  //
  // **This is lossy and it is deliberate**, so say what it costs: the rest of
  // this pipeline — `ImageData8`, `createMapSampler`, the published PNG, the
  // shader's vertex colours — is 8-bit end to end, so a 16-bit source has
  // nowhere to put the extra precision even if it were kept. That is fine for a
  // COLOUR map, which is what the only 16-bit file in the project is. It would
  // NOT be fine for a HEIGHT map: `height = grayscale * TerrainHeight` with
  // TerrainHeight 1024 means one 8-bit step is 4 m of terrain, and throwing away
  // the low byte there would quantise every slope. If a 16-bit height map ever
  // turns up, this reduction is the wrong answer and the sampler has to widen
  // first.
  const reduced = Buffer.alloc(width * height * channels)
  for (let i = 0, j = 0; j < reduced.length; i += 2, j++) reduced[j] = out[i]
  return { width, height, channels, data: reduced, bitDepth: 16 }
}

// Sampling lives in `src/sim/terrain/image-sampler.ts`, not here. This file
// decodes bytes; `createMapSampler` filters them. The split is deliberate: the
// browser gets its pixels from `createImageBitmap` rather than from this
// decoder, and a second copy of the bilinear/V-flip arithmetic is exactly how
// the shipped terrain drifts away from the terrain the oracle test checks.
//
// `decodePng`'s return value is already the `ImageData8` shape that sampler
// takes — `Buffer` is a `Uint8Array`, so it satisfies the type as-is.

// ── Encoding ──────────────────────────────────────────────────────────────
//
// Needed because the shipped terrain maps are NOT the files on disk. Unity
// rescales the 1025x1025 World Machine output to 1024x1024 at import
// (`nPOTScale: 1`), and the generator samples that. Baking the rescale into the
// published asset means the browser loads exactly what the oracle test
// verified, instead of repeating a megapixel resample at boot and hoping the
// two agree.
//
// Deliberately unsophisticated: one IDAT, filter type 0 on every row, zlib at
// max level. It is a build step run once per asset, so encode speed is worth
// nothing and a filter heuristic would only add a way to be wrong.

const crcTable = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

const crc32 = (buf) => {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const chunk = (type, payload) => {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(payload.length, 0)
  head.write(type, 4, 'ascii')
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), payload])), 0)
  return Buffer.concat([head, payload, tail])
}

const COLOUR_TYPE = { 1: 0, 2: 4, 3: 2, 4: 6 }

/**
 * Encode `{ width, height, channels, data }` as an 8-bit non-interlaced PNG.
 * `channels` picks the colour type: 1 grey, 2 grey+alpha, 3 RGB, 4 RGBA.
 *
 * `level` is zlib's compression level; the default is 9 (the maps are built once). tools/dev/app-icon.mjs
 * passes -1, zlib's own default, so its icon bytes stay what they were (TL-13).
 */
export const encodePng = (img, { level = 9 } = {}) => {
  const { width, height, channels, data } = img
  const colourType = COLOUR_TYPE[channels]
  if (colourType === undefined) throw new Error(`encodePng: bad channel count ${channels}`)
  if (data.length < width * height * channels) {
    throw new Error(`encodePng: ${data.length} bytes for ${width}x${height}x${channels}`)
  }

  const stride = width * channels
  // One extra byte per row for the filter type, which is always 0 (None).
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = colourType
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // non-interlaced

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
