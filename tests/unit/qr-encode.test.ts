// DEV-632: the lobby's QR code (`src/game/qr-encode.ts`), checked against
// values from OUTSIDE the encoder where the standard publishes them, and by a
// read-back that walks the symbol the way a reader does.
import { describe, expect, it } from 'vitest'
import {
  encodeQr,
  QR_MAX_VERSION,
  qrCodewords,
  qrDataCodewords,
  qrFormatBits,
  rsDivisor,
  rsRemainder,
} from '@/game/qr-encode'

describe('qr-encode, against published values', () => {
  it("Reed-Solomon: thonky.com's worked HELLO WORLD 1-M gives its ten EC codewords", () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17]
    expect(rsRemainder(data, rsDivisor(10))).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23])
  })

  it("format strings: level M, masks 0 and 7, as the standard's table lists them", () => {
    expect(qrFormatBits(0).toString(2).padStart(15, '0')).toBe('101010000010010')
    expect(qrFormatBits(7).toString(2).padStart(15, '0')).toBe('100101010100000')
  })

  it('capacity at level M, bytes: 14, 26, 42, 62, 84, 106 for versions 1 to 6', () => {
    const bytes = Array.from({ length: QR_MAX_VERSION }, (_, i) =>
      Math.floor((qrDataCodewords(i + 1) * 8 - 12) / 8),
    )
    expect(bytes).toEqual([14, 26, 42, 62, 84, 106])
  })
})

/** Read the codewords back out of a symbol: unmask, walk the zigzag, skip function modules. */
const readBack = (text: string): { stored: number[]; want: number[] } => {
  const qr = encodeQr(text)
  if (!qr) throw new Error('no code')
  const { size, dark, mask, version } = qr
  const masks = [
    (x: number, y: number) => (x + y) % 2 === 0,
    (_x: number, y: number) => y % 2 === 0,
    (x: number) => x % 3 === 0,
    (x: number, y: number) => (x + y) % 3 === 0,
    (x: number, y: number) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x: number, y: number) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x: number, y: number) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x: number, y: number) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ]
  // Function modules, from the standard's geometry (independent of the encoder's drawing).
  const isFunction = (x: number, y: number): boolean => {
    if (x === 6 || y === 6) return true
    if (x <= 8 && y <= 8) return true
    if (x >= size - 8 && y <= 8) return true
    if (x <= 8 && y >= size - 8) return true
    if (version >= 2 && Math.abs(x - (size - 7)) <= 2 && Math.abs(y - (size - 7)) <= 2) return true
    return false
  }
  const bits: number[] = []
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let v = 0; v < size; v++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const y = ((right + 1) & 2) === 0 ? size - 1 - v : v
        if (isFunction(x, y)) continue
        const on = dark[y]?.[x] === true
        bits.push(on !== (masks[mask]?.(x, y) ?? false) ? 1 : 0)
      }
    }
  }
  const stored: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0
    for (let k = 0; k < 8; k++) b = (b << 1) | (bits[i + k] ?? 0)
    stored.push(b)
  }
  const want = qrCodewords(text, version)
  return { stored: stored.slice(0, want.length), want }
}

describe('qr-encode, the symbol', () => {
  const link = 'https://facetedflight.net/?room=K7QX4MN'

  it('a room link fits, at version 3 (42 bytes at M)', () => {
    expect(encodeQr(link)?.version).toBe(3)
    expect(encodeQr(link)?.size).toBe(29)
  })

  it('a preview branch link fits too, and a text past version 6 is refused, not truncated', () => {
    expect(encodeQr('https://w41-rooms.ff-10yr.pages.dev/?room=K7QX4MN')).not.toBeNull()
    expect(encodeQr('x'.repeat(107))).toBeNull()
  })

  it('the three finders are where a reader looks for them', () => {
    const qr = encodeQr(link)
    if (!qr) throw new Error('no code')
    const row = (y: number, x0: number) => qr.dark[y]?.slice(x0, x0 + 7).map((d) => (d ? 1 : 0))
    for (const [x0, y0] of [
      [0, 0],
      [qr.size - 7, 0],
      [0, qr.size - 7],
    ] as const) {
      expect(row(y0, x0)).toEqual([1, 1, 1, 1, 1, 1, 1])
      expect(row(y0 + 1, x0)).toEqual([1, 0, 0, 0, 0, 0, 1])
      expect(row(y0 + 3, x0)).toEqual([1, 0, 1, 1, 1, 0, 1])
    }
  })

  it('both copies of the format string say level M and the chosen mask', () => {
    const qr = encodeQr(link)
    if (!qr) throw new Error('no code')
    const bit = (x: number, y: number) => (qr.dark[y]?.[x] ? 1 : 0)
    // The copy beside the bottom-left finder, bit 14 at the top... read as the
    // standard places bits 8 to 14 at (8, size-7 .. size-1).
    let second = 0
    for (let i = 14; i >= 8; i--) second = (second << 1) | bit(8, qr.size - 15 + i)
    for (let i = 7; i >= 0; i--) second = (second << 1) | bit(qr.size - 1 - i, 8)
    expect(second).toBe(qrFormatBits(qr.mask))
    expect(bit(8, qr.size - 8), 'the dark module').toBe(1)
  })

  it.each([
    'https://facetedflight.net/?room=K7QX4MN',
    'K7QX4MN',
    'https://w41-rooms.ff-10yr.pages.dev/?room=23456BC',
  ])('reads back its own codewords: %s', (text) => {
    const { stored, want } = readBack(text)
    expect(stored).toEqual(want)
  })
})
