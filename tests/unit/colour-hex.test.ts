// The shared sRGB <-> `#rrggbb` (code-reuse audit WP-3). The reference bodies
// below are the three copies of each direction it replaced.

import { describe, expect, it } from 'vitest'
import { hexToSrgb, srgbToHex } from '@/content/colour-hex'

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)

/** render/racer-livery.ts's `srgbHex`, before. */
const livery = (c: readonly number[]): string =>
  `#${c
    .map((v) =>
      Math.round(clamp01(v) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`

/** boot/lookdev.ts's `hexToColor`, before. */
const sliced = (hex: string): [number, number, number] => [
  Number.parseInt(hex.slice(1, 3), 16) / 255,
  Number.parseInt(hex.slice(3, 5), 16) / 255,
  Number.parseInt(hex.slice(5, 7), 16) / 255,
]

describe('colour-hex', () => {
  it('writes #rrggbb, clamped, dropping any channel past the third', () => {
    expect(srgbToHex([1, 0, 0.5])).toBe('#ff0080')
    expect(srgbToHex([1.5, -1, 0.5])).toBe('#ff0080')
    expect(srgbToHex([0, 1, 0, 0.25])).toBe('#00ff00')
  })

  it('agrees with the racer-livery spelling on every triple it was given', () => {
    for (let i = 0; i < 256; i++) {
      const c = [i / 255, (255 - i) / 255, ((i * 7) % 256) / 255] as const
      expect(srgbToHex(c)).toBe(livery(c))
    }
  })

  it('reads #rrggbb exactly as the slice-per-channel parser did, and tolerates no #', () => {
    for (let i = 0; i < 256; i++) {
      const hex = srgbToHex([i / 255, (255 - i) / 255, ((i * 7) % 256) / 255])
      expect(hexToSrgb(hex)).toEqual(sliced(hex))
      expect(hexToSrgb(hex.slice(1))).toEqual(hexToSrgb(hex))
      expect(srgbToHex(hexToSrgb(hex))).toBe(hex)
    }
  })
})
