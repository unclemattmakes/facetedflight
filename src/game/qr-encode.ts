// src/game/qr-encode.ts: a QR code for a room's link, so a phone joins by camera. DEV-632.
//
// Matt, 2026-10-04: *"typing a room code on mobile is painful, same with PC."*
// The host's lobby on a flat screen shows its `?room=` link as a QR code, and a
// friend's phone camera opens it. That is the only thing this encoder is for,
// so it is the smallest one that does that job, first-party rather than a new
// dependency (no QR package is in the tree, and a link is a few dozen bytes):
//
//   - BYTE mode only (a URL is bytes), error correction level M (15 %: a code
//     photographed off a monitor, with moire and a glare, still reads);
//   - versions 1 to 6 only: 106 bytes at M, against a link of ~40
//     (`https://facetedflight.net/?room=K7QX4MN`) or ~60 on a preview branch.
//     Six is the last version with no version-information blocks and one
//     alignment pattern, which is what keeps this file short. A longer text
//     returns null and the lobby shows no code, rather than a wrong one;
//   - all eight masks scored by ISO/IEC 18004's four penalty rules, so the
//     chosen mask is the one a reader likes best.
//
// The structure follows the standard as Project Nayuki's reference encoder
// lays it out (MIT); nothing is copied from it. Pure, so `tests/unit/qr-encode.test.ts`
// checks it against values from outside this file: the Reed-Solomon bytes of
// thonky.com's worked example, and the standard's format strings.

/** A QR code: `size` modules a side, `dark[y][x]`. No quiet zone; the painter adds four. */
export interface QrCode {
  readonly version: number
  readonly size: number
  readonly mask: number
  readonly dark: readonly (readonly boolean[])[]
}

/** The highest version this encoder makes (see the header). */
export const QR_MAX_VERSION = 6

/** Level M's EC codewords per block and block count, by version (ISO/IEC 18004 table 9). */
const EC_M: readonly (readonly [ecPerBlock: number, blocks: number])[] = [
  [0, 0], // no version 0
  [10, 1],
  [16, 1],
  [26, 1],
  [18, 2],
  [24, 2],
  [16, 4],
]
/** Level M's two format bits (L 01, M 00, Q 11, H 10). */
const FORMAT_M = 0

/** Bits a version holds for data and EC together, after its function patterns. */
export const qrRawModules = (version: number): number => {
  let n = (16 * version + 128) * version + 64
  if (version >= 2) {
    const aligns = Math.floor(version / 7) + 2
    n -= (25 * aligns - 10) * aligns - 55
  }
  return n
}

/** Data codewords at level M. */
export const qrDataCodewords = (version: number): number => {
  const [ec, blocks] = EC_M[version] ?? [0, 0]
  return Math.floor(qrRawModules(version) / 8) - ec * blocks
}

// ── GF(256), polynomial 0x11D ────────────────────────────────────────────────

const gfMul = (x: number, y: number): number => {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}

/** The generator polynomial of `degree`, highest term implied, coefficients high to low. */
export const rsDivisor = (degree: number): number[] => {
  const out = new Array<number>(degree).fill(0)
  out[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      out[j] = gfMul(out[j] ?? 0, root)
      if (j + 1 < degree) out[j] = (out[j] ?? 0) ^ (out[j + 1] ?? 0)
    }
    root = gfMul(root, 0x02)
  }
  return out
}

/** The EC codewords for `data`: the remainder of data * x^n divided by the generator. */
export const rsRemainder = (data: readonly number[], divisor: readonly number[]): number[] => {
  const out = new Array<number>(divisor.length).fill(0)
  for (const b of data) {
    const factor = b ^ (out.shift() ?? 0)
    out.push(0)
    for (let i = 0; i < divisor.length; i++) out[i] = (out[i] ?? 0) ^ gfMul(divisor[i] ?? 0, factor)
  }
  return out
}

/** The 15 format bits for level M and `mask`, BCH-protected and XOR-masked (bit 14 first). */
export const qrFormatBits = (mask: number, eclBits = FORMAT_M): number => {
  const data = (eclBits << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  return ((data << 10) | rem) ^ 0x5412
}

// ── The codewords ────────────────────────────────────────────────────────────

/** The data codewords for `bytes` in byte mode at `version`: header, data, terminator, pads. */
const dataCodewords = (bytes: Uint8Array, version: number): number[] => {
  const capacity = qrDataCodewords(version) * 8
  const bits: number[] = []
  const put = (value: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  put(0b0100, 4) // byte mode
  put(bytes.length, 8) // the count is 8 bits through version 9
  for (const b of bytes) put(b, 8)
  put(0, Math.min(4, capacity - bits.length))
  put(0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8)
  const out: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0
    for (let j = 0; j < 8; j++) b = (b << 1) | (bits[i + j] ?? 0)
    out.push(b)
  }
  return out
}

/** Data split into blocks, each given its EC, interleaved as the symbol stores them. */
const interleave = (data: readonly number[], version: number): number[] => {
  const [ec, blocks] = EC_M[version] ?? [0, 1]
  const raw = Math.floor(qrRawModules(version) / 8)
  const shortBlocks = blocks - (raw % blocks)
  const shortLen = Math.floor(raw / blocks)
  const divisor = rsDivisor(ec)
  const split: { data: number[]; ec: number[] }[] = []
  for (let i = 0, k = 0; i < blocks; i++) {
    const n = shortLen - ec + (i < shortBlocks ? 0 : 1)
    const d = data.slice(k, k + n)
    k += n
    split.push({ data: d, ec: rsRemainder(d, divisor) })
  }
  const out: number[] = []
  const longest = Math.max(...split.map((s) => s.data.length))
  for (let i = 0; i < longest; i++)
    for (const s of split) if (i < s.data.length) out.push(s.data[i] ?? 0)
  for (let i = 0; i < ec; i++) for (const s of split) out.push(s.ec[i] ?? 0)
  return out
}

// ── The symbol ───────────────────────────────────────────────────────────────

const MASKS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
]

const build = (codewords: readonly number[], version: number, mask: number): boolean[][] => {
  const size = version * 4 + 17
  const dark = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const set = (x: number, y: number, on: boolean) => {
    const row = dark[y]
    const f = fixed[y]
    if (!row || !f || x < 0 || x >= size) return
    row[x] = on
    f[x] = true
  }
  // Timing.
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0)
    set(i, 6, i % 2 === 0)
  }
  // Finders, with their light separators (the off-symbol cells are dropped by `set`).
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy))
        if (cy + dy >= 0 && cy + dy < size) set(cx + dx, cy + dy, d !== 2 && d !== 4)
      }
    }
  }
  // The one alignment pattern of versions 2 to 6, at (size-7, size-7).
  if (version >= 2) {
    const c = size - 7
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++)
        set(c + dx, c + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    }
  }
  // Format bits: reserved now, written after the mask.
  const format = (bits: number) => {
    const bit = (i: number) => ((bits >>> i) & 1) === 1
    for (let i = 0; i <= 5; i++) set(8, i, bit(i))
    set(8, 7, bit(6))
    set(8, 8, bit(7))
    set(7, 8, bit(8))
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i))
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i))
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i))
    set(8, size - 8, true) // the dark module
  }
  format(0)
  // The codewords, in the two-column zigzag from the bottom right.
  let i = 0
  const total = codewords.length * 8
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let v = 0; v < size; v++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const y = ((right + 1) & 2) === 0 ? size - 1 - v : v
        const row = dark[y]
        if (!row || fixed[y]?.[x]) continue
        if (i < total) row[x] = (((codewords[i >>> 3] ?? 0) >>> (7 - (i & 7))) & 1) === 1
        i++
        if (MASKS[mask]?.(x, y)) row[x] = !row[x]
      }
    }
  }
  format(qrFormatBits(mask))
  return dark
}

/** ISO/IEC 18004 section 7.8.3's penalty: lower is easier to read. */
export const qrPenalty = (dark: readonly (readonly boolean[])[]): number => {
  const size = dark.length
  const at = (x: number, y: number) => dark[y]?.[x] === true
  let score = 0
  const finderLike = (line: readonly boolean[], k: number): boolean => {
    // 1:1:3:1:1 dark with four light on one side: 1011101 0000 or 0000 1011101.
    const p = [true, false, true, true, true, false, true]
    for (let j = 0; j < 7; j++) if (line[k + j] !== p[j]) return false
    const lightRun = (from: number) => {
      for (let j = from; j < from + 4; j++) if (line[j] === true) return false
      return true
    }
    return lightRun(k - 4) || lightRun(k + 7)
  }
  for (const vertical of [false, true]) {
    for (let a = 0; a < size; a++) {
      const line = Array.from({ length: size }, (_, b) => (vertical ? at(a, b) : at(b, a)))
      // Rule 1: runs of five or more of one colour.
      let run = 1
      for (let b = 1; b <= size; b++) {
        if (b < size && line[b] === line[b - 1]) run++
        else {
          if (run >= 5) score += 3 + (run - 5)
          run = 1
        }
      }
      // Rule 3: finder-like patterns.
      for (let b = 0; b + 7 <= size; b++) if (finderLike(line, b)) score += 40
    }
  }
  // Rule 2: 2x2 blocks of one colour.
  for (let y = 0; y + 1 < size; y++) {
    for (let x = 0; x + 1 < size; x++) {
      const c = at(x, y)
      if (c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1)) score += 3
    }
  }
  // Rule 4: the dark share's distance from half, 10 a step of 5 %.
  let darkCount = 0
  for (const row of dark) for (const c of row) if (c) darkCount++
  const percent = (darkCount * 100) / (size * size)
  score += Math.floor(Math.abs(percent - 50) / 5) * 10
  return score
}

/**
 * `text` as a QR code at level M, the smallest version that holds it, the mask
 * the penalty likes best; null when it is longer than version 6 holds.
 */
export const encodeQr = (text: string): QrCode | null => {
  const bytes = new TextEncoder().encode(text)
  for (let version = 1; version <= QR_MAX_VERSION; version++) {
    if (4 + 8 + bytes.length * 8 > qrDataCodewords(version) * 8) continue
    const codewords = interleave(dataCodewords(bytes, version), version)
    let best: QrCode | null = null
    let bestScore = Number.POSITIVE_INFINITY
    for (let mask = 0; mask < 8; mask++) {
      const dark = build(codewords, version, mask)
      const score = qrPenalty(dark)
      if (score < bestScore) {
        bestScore = score
        best = { version, size: dark.length, mask, dark }
      }
    }
    return best
  }
  return null
}

/** For the test's read-back: the codewords a version stores for `text` (data then EC, interleaved). */
export const qrCodewords = (text: string, version: number): number[] =>
  interleave(dataCodewords(new TextEncoder().encode(text), version), version)
