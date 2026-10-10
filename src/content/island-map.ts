// src/content/island-map.ts — a player's heightmap, read in the browser. DEV-490 (T1.5).
//
// docs/plan/EDITOR.md §5.4's T1.5: the creator brings a greyscale map from
// Gaea, World Machine, a DEM, anywhere. Two formats:
//
//   - **PNG**, greyscale, 8 or 16 bits a sample, not interlaced. A browser
//     canvas decodes a 16-bit PNG to 8 bits — 6 m terraces on a Simonet-sized
//     island (DEV-131) — so the samples are read here: `tools/terrain/png.mjs`'s
//     chunk walk and unfilter, ported, with `DecompressionStream('deflate')` in
//     place of `node:zlib`, and ALL 16 bits kept (the tool keeps the high byte).
//   - **RAW `.r16`**: unsigned 16-bit little-endian samples, square, the side
//     from the byte count. World Machine's and Unity's "Windows byte order".
//
// Out comes a `GreyDataF32`-shaped grid, 0..1, row 0 at the top (a PNG's own
// order, and the one `CustomGround` reads). **Never `importUnityTexture`**:
// that is 2016's 1025 -> 1024 import (DEV-007), and a player's map is not a
// 2016 map.
//
// ── Untrusted input ──────────────────────────────────────────────────────
//
// A map arrives in a file somebody sent. So: the FILE's size is asked before
// it is read (`heightmapTooLarge`, on `File.size`); the PNG's IHDR is read
// first and its edge capped BEFORE a byte is inflated (a decompression bomb is
// a tiny file with a huge header); the inflater is cancelled the moment it
// passes the size the header promised; every chunk length is checked against
// what is left. A message never echoes the input. `decodeHeightmap` never
// throws.
//
// Importable from a Playwright spec and from node: no DOM, no three, no
// `import.meta.glob`. `DecompressionStream` and `crypto.subtle` are in both.

import { sha256HexAsync } from '@/net/digest'
import { drainCapped } from '@/net/http'

/**
 * Every bound on an imported map, under one name. **Pinned by value in
 * `tests/unit/island-map.test.ts`**, which also holds `maxEdge` to
 * `CUSTOM_GROUND_LIMITS.maxEdge` (the generator's own cap, DEV-489).
 */
export const HEIGHTMAP_LIMITS = {
  /** EDITOR.md §5.4: *"cap the edge at 4097"*. */
  maxEdge: 4097,
  /** The smallest grid a bilinear sampler can interpolate. */
  minEdge: 2,
  /**
   * The largest map file read, bytes, asked BEFORE reading: a 4097² `.r16` is
   * 33,570,818 bytes, and a 16-bit PNG of it that deflate could not shrink
   * is a little more. 36 MiB is that and room for its chunks.
   */
  maxFileBytes: 36 * 1024 * 1024,
} as const

export type HeightmapFormat = 'png' | 'r16'

/** A decoded map: 0..1 samples, row 0 at the top, `width * height` of them. */
export interface Heightmap {
  readonly width: number
  readonly height: number
  readonly data: Float32Array
  readonly format: HeightmapFormat
  readonly bits: 8 | 16
}

export type HeightmapResult =
  | { readonly ok: true; readonly map: Heightmap }
  | { readonly ok: false; readonly error: string }

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const

/** Ask BEFORE reading: is a map file of `size` bytes past the cap? */
export const heightmapTooLarge = (size: number): boolean =>
  !(Number.isFinite(size) && size >= 0 && size <= HEIGHTMAP_LIMITS.maxFileBytes)

export const isPng = (bytes: Uint8Array): boolean =>
  bytes.length >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)

/** What a PNG's IHDR says, read from its first 33 bytes and nothing else. */
export interface PngHeader {
  readonly width: number
  readonly height: number
  readonly bitDepth: number
  readonly colorType: number
  readonly interlace: number
}

const fail = (error: string): HeightmapResult => ({ ok: false, error })

const u32 = (b: Uint8Array, at: number): number =>
  ((b[at] as number) * 0x1000000 +
    (((b[at + 1] as number) << 16) | ((b[at + 2] as number) << 8) | (b[at + 3] as number))) >>>
  0

const edgeProblem = (width: number, height: number): string | null => {
  const L = HEIGHTMAP_LIMITS
  if (width > L.maxEdge || height > L.maxEdge) {
    return `is ${width}x${height}; a side may be at most ${L.maxEdge}`
  }
  if (width < L.minEdge || height < L.minEdge)
    return `is ${width}x${height}, too small to be ground`
  return null
}

/**
 * The IHDR, or why there is none. It must be the FIRST chunk (the PNG spec
 * says so), so this reads 33 bytes and no more: the dimensions are known, and
 * capped, before anything is inflated.
 */
export const pngHeader = (bytes: Uint8Array): PngHeader | string => {
  if (!isPng(bytes)) return 'is not a PNG'
  if (bytes.length < 33) return 'is cut short'
  const length = u32(bytes, 8)
  const type = String.fromCharCode(...bytes.subarray(12, 16))
  if (type !== 'IHDR' || length !== 13) return 'is a damaged PNG: it does not start with its header'
  return {
    width: u32(bytes, 16),
    height: u32(bytes, 20),
    bitDepth: bytes[24] as number,
    colorType: bytes[25] as number,
    interlace: bytes[28] as number,
  }
}

/** Paeth predictor, straight from the PNG spec (and `png.mjs`). */
const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

const decodePng = async (bytes: Uint8Array): Promise<HeightmapResult> => {
  const head = pngHeader(bytes)
  if (typeof head === 'string') return fail(head)
  const edge = edgeProblem(head.width, head.height)
  if (edge) return fail(edge)
  if (head.colorType !== 0) {
    return fail('is a colour PNG; save the heightmap as greyscale (8 or 16 bits)')
  }
  if (head.bitDepth !== 8 && head.bitDepth !== 16) {
    return fail(`has ${head.bitDepth}-bit samples; 8 and 16 are read`)
  }
  if (head.interlace !== 0) return fail('is interlaced; save it without interlacing')

  // The chunks, every length checked against what is left.
  const idat: Uint8Array[] = []
  let at = 8
  for (;;) {
    if (at === bytes.length) break
    if (bytes.length - at < 12) return fail('is cut short')
    const length = u32(bytes, at)
    if (length > bytes.length - at - 12) return fail('is cut short')
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8))
    if (type === 'IDAT') idat.push(bytes.subarray(at + 8, at + 8 + length))
    at += 12 + length
    if (type === 'IEND') break
  }
  if (idat.length === 0) return fail('holds no image data')

  const { width, height } = head
  const bps = head.bitDepth / 8
  const stride = width * bps
  // Exactly what the header promises: a filter byte and a row, per row.
  const expected = height * (1 + stride)
  let raw: Uint8Array | null
  try {
    const source = new Blob(idat as BlobPart[]).stream()
    raw = await drainCapped(
      source.pipeThrough(
        new DecompressionStream('deflate') as unknown as TransformStream<Uint8Array, Uint8Array>,
      ),
      expected,
    )
  } catch {
    return fail('is a damaged PNG: its image data does not inflate')
  }
  if (raw === null) return fail('holds more image data than its header says')
  if (raw.length < expected) return fail('is cut short: its image data ends early')

  const data = new Float32Array(width * height)
  let prev = new Uint8Array(stride)
  let cur = new Uint8Array(stride)
  const scale = head.bitDepth === 16 ? 1 / 65535 : 1 / 255
  let src = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[src++] as number
    if (filter > 4) return fail(`is a damaged PNG: row ${y} has filter ${filter}`)
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x] as number
      const a = x >= bps ? (cur[x - bps] as number) : 0
      const b = prev[x] as number
      const c = x >= bps ? (prev[x - bps] as number) : 0
      cur[x] =
        (filter === 0
          ? v
          : filter === 1
            ? v + a
            : filter === 2
              ? v + b
              : filter === 3
                ? v + ((a + b) >> 1)
                : v + paeth(a, b, c)) & 0xff
    }
    src += stride
    const row = y * width
    if (bps === 2) {
      // Big-endian, all sixteen bits.
      for (let x = 0; x < width; x++) {
        data[row + x] = (((cur[2 * x] as number) << 8) | (cur[2 * x + 1] as number)) * scale
      }
    } else {
      for (let x = 0; x < width; x++) data[row + x] = (cur[x] as number) * scale
    }
    const t = prev
    prev = cur
    cur = t
  }
  return {
    ok: true,
    map: { width, height, data, format: 'png', bits: head.bitDepth as 8 | 16 },
  }
}

const decodeR16 = (bytes: Uint8Array): HeightmapResult => {
  const n = Math.round(Math.sqrt(bytes.length / 2))
  if (bytes.length % 2 !== 0 || n * n * 2 !== bytes.length) {
    return fail('is not a PNG, and not a square .r16 (two bytes a sample)')
  }
  const edge = edgeProblem(n, n)
  if (edge) return fail(edge)
  const data = new Float32Array(n * n)
  for (let i = 0; i < data.length; i++) {
    data[i] = ((bytes[2 * i] as number) | ((bytes[2 * i + 1] as number) << 8)) / 65535
  }
  return { ok: true, map: { width: n, height: n, data, format: 'r16', bits: 16 } }
}

/**
 * A map file's bytes to 0..1 samples: a greyscale PNG (8 or 16 bits) by its
 * signature, and otherwise a square `.r16`. Never throws.
 */
export const decodeHeightmap = async (bytes: Uint8Array): Promise<HeightmapResult> => {
  try {
    if (heightmapTooLarge(bytes.length)) {
      return fail(`is larger than ${HEIGHTMAP_LIMITS.maxFileBytes} bytes`)
    }
    return isPng(bytes) ? await decodePng(bytes) : decodeR16(bytes)
  } catch {
    return fail('could not be read')
  }
}

/** The map's identity: the SHA-256 of the file's bytes, lower-case hex. */
export const heightmapSha = (bytes: Uint8Array): Promise<string> => sha256HexAsync(bytes)

/**
 * DEV-499: a map FILE picked again for a course whose map this browser lost
 * (site data cleared). Accepted only when its SHA-256 is the one the course
 * names — the same bytes it was imported from — and it still decodes; any
 * other file is refused as a different map, whatever it looks like. Never
 * throws. `why` finishes the sentence "That file …".
 */
export const reopenMapFile = async (
  want: string,
  bytes: Uint8Array,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly why: string }> => {
  try {
    if (heightmapTooLarge(bytes.length)) {
      return { ok: false, why: `is larger than ${HEIGHTMAP_LIMITS.maxFileBytes} bytes` }
    }
    if ((await heightmapSha(bytes)) !== want) {
      return {
        ok: false,
        why: 'is a different map from the one this course was made on (its SHA-256 does not match)',
      }
    }
    const read = await decodeHeightmap(bytes)
    return read.ok ? { ok: true } : { ok: false, why: read.error }
  } catch {
    return { ok: false, why: 'could not be read' }
  }
}
