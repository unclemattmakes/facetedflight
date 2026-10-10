// tests/unit/label-contrast.test.ts — the arithmetic `hangar-art.spec.ts` floors
// the room's labels with (DEV-437 addendum), held against WCAG 2's own fixed
// points rather than against itself.

import { describe, expect, it } from 'vitest'
import {
  contrastRatio,
  type Frame,
  labelContrast,
  relativeLuminance,
} from '../e2e/fixtures/label-contrast'

/** A w x h RGB frame filled by `paint(x, y)`. */
const frame = (w: number, h: number, paint: (x: number, y: number) => number[]): Frame => {
  const data = new Uint8Array(w * h * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) data.set(paint(x, y), (y * w + x) * 3)
  }
  return { w, h, ch: 3, data }
}

describe('WCAG 2, as the spec reads it', () => {
  it('runs from 1 to 21, black on white at the top', () => {
    expect(relativeLuminance(255, 255, 255)).toBeCloseTo(1, 6)
    expect(relativeLuminance(0, 0, 0)).toBe(0)
    expect(contrastRatio(1, 0)).toBeCloseTo(21, 6)
    expect(contrastRatio(0.3, 0.3)).toBe(1)
  })

  it('puts #777 on white just under 4.5, the threshold it is famous for', () => {
    const grey = relativeLuminance(0x77, 0x77, 0x77)
    expect(contrastRatio(grey, 1)).toBeCloseTo(4.48, 2)
  })
})

describe('one label, three frames', () => {
  // A 3 x 3 white letter at (8..10, 4..6) on mid grey, with a black halo two
  // pixels round it; magenta where the label is tinted.
  const W = 20
  const H = 12
  const letter = (x: number, y: number) => x >= 8 && x <= 10 && y >= 4 && y <= 6
  const halo = (x: number, y: number) => x >= 6 && x <= 12 && y >= 2 && y <= 8
  const hidden = frame(W, H, () => [128, 128, 128])
  const shown = frame(W, H, (x, y) =>
    letter(x, y) ? [255, 255, 255] : halo(x, y) ? [0, 0, 0] : [128, 128, 128],
  )
  const tinted = frame(W, H, (x, y) =>
    letter(x, y) ? [255, 0, 255] : halo(x, y) ? [0, 0, 0] : [128, 128, 128],
  )

  it('finds the letter by the green the tint takes away, and reads both ratios', () => {
    const c = labelContrast(shown, tinted, hidden, [0, 0, W, H])
    expect(c?.glyphs).toBe(9)
    // Against its halo: white on black.
    expect(c?.vsSurround).toBeCloseTo(21, 3)
    // Against the grey behind it, which is what an unbacked label gets.
    expect(c?.vsBehind).toBeCloseTo(1.05 / (relativeLuminance(128, 128, 128) + 0.05), 6)
    expect(c?.vsBehind).toBeLessThan(4.5)
  })

  it('reads the bare room as the surround when there is no halo', () => {
    const bare = frame(W, H, (x, y) => (letter(x, y) ? [255, 255, 255] : [128, 128, 128]))
    const bareTint = frame(W, H, (x, y) => (letter(x, y) ? [255, 0, 255] : [128, 128, 128]))
    const c = labelContrast(bare, bareTint, hidden, [0, 0, W, H])
    expect(c?.vsSurround).toBeCloseTo(c?.vsBehind as number, 6)
  })

  it('says nothing about a box with no ink in it, and refuses frames that differ in size', () => {
    expect(labelContrast(hidden, hidden, hidden, [0, 0, W, H])).toBe(null)
    expect(labelContrast(shown, tinted, hidden, [30, 30, 40, 40])).toBe(null)
    expect(() =>
      labelContrast(
        shown,
        frame(4, 4, () => [0, 0, 0]),
        hidden,
        [0, 0, 4, 4],
      ),
    ).toThrow(/not the same size/)
  })
})
