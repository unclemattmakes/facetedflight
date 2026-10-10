// tests/unit/ui-digits.test.ts: figures in cells (DEV-848).
//
// Proportional figures (CRYSTAL's 1 is 530 units wide, its 8 is 1353) must not
// move a clock's other glyphs when a digit changes. The oracle is the OUTSIDE
// one: the advances are read from the font file on disk, not from the helper.

import fs from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  CRYSTAL_DIGIT_CELL_EM,
  type DigitDraw,
  digitCell,
  fillTextCells,
  measureCells,
  resetDigitCellsForTests,
  setCellText,
} from '@/render/ui-digits'

beforeEach(() => resetDigitCellsForTests())

/** A context whose glyph advances are `adv(ch)`, recording where each fillText lands. */
const fake = (adv: (ch: string) => number) => {
  const drawn: { ch: string; x: number }[] = []
  const ctx: DigitDraw = {
    font: '400 10px test',
    textAlign: 'left',
    measureText: (t: string) => ({ width: [...t].reduce((w, c) => w + adv(c), 0) }),
    fillText: (t: string, x: number) => {
      drawn.push({ ch: t, x })
    },
  }
  return { ctx, drawn }
}
const prop = (ch: string): number =>
  ch === '1' ? 5 : ch >= '0' && ch <= '9' ? 13 : ch === ':' ? 7 : 9

describe('digit cells', () => {
  it('the cell is the widest digit', () => {
    expect(digitCell(fake(prop).ctx)).toBe(13)
  })

  it('every digit string of one length is one width, whatever the digits', () => {
    const { ctx } = fake(prop)
    expect(measureCells(ctx, '1:11.1')).toBe(measureCells(ctx, '8:88.8'))
    expect(measureCells(ctx, '0')).toBe(measureCells(ctx, '1'))
  })

  it('a changing last digit moves nothing to its left', () => {
    const a = fake(prop)
    const b = fake(prop)
    fillTextCells(a.ctx, '1:11.9', 100, 0)
    fillTextCells(b.ctx, '1:11.1', 100, 0)
    expect(a.drawn.slice(0, 5).map((d) => d.x)).toEqual(b.drawn.slice(0, 5).map((d) => d.x))
  })

  it('centres a narrow digit in its cell and honours right alignment', () => {
    const { ctx, drawn } = fake(prop)
    ctx.textAlign = 'right'
    fillTextCells(ctx, '11', 100, 0)
    expect(ctx.textAlign).toBe('right')
    expect(drawn.map((d) => d.x)).toEqual([100 - 26 + 4, 100 - 13 + 4])
  })

  it('matches measureText exactly where there are no digits', () => {
    const { ctx } = fake(prop)
    expect(measureCells(ctx, ':.')).toBe(7 + 9)
  })
})

describe("CRYSTAL_DIGIT_CELL_EM is the font's own widest digit", () => {
  it.skipIf(!fs.existsSync('public/assets/fonts/crystal-regular.ttf'))(
    'is 1353 of 2048 (read from the file: hmtx of 0 to 9)',
    () => {
      const buf = fs.readFileSync('public/assets/fonts/crystal-regular.ttf')
      // sfnt table directory
      const n = buf.readUInt16BE(4)
      const table = (tag: string): number => {
        for (let i = 0; i < n; i++) {
          const o = 12 + i * 16
          if (buf.toString('latin1', o, o + 4) === tag) return buf.readUInt32BE(o + 8)
        }
        throw new Error(`no ${tag}`)
      }
      const upem = buf.readUInt16BE(table('head') + 18)
      const nHM = buf.readUInt16BE(table('hhea') + 34)
      // cmap format 4: find glyph ids of '0'..'9'
      const cmap = table('cmap')
      const sub = cmap + buf.readUInt32BE(cmap + 4 + 4)
      expect(buf.readUInt16BE(sub)).toBe(4)
      const segX2 = buf.readUInt16BE(sub + 6)
      const ends = sub + 14
      const starts = ends + segX2 + 2
      const deltas = starts + segX2
      const ranges = deltas + segX2
      const gid = (c: number): number => {
        for (let s = 0; s < segX2 / 2; s++) {
          if (c <= buf.readUInt16BE(ends + 2 * s)) {
            if (c < buf.readUInt16BE(starts + 2 * s)) return 0
            const ro = buf.readUInt16BE(ranges + 2 * s)
            const delta = buf.readUInt16BE(deltas + 2 * s)
            if (ro === 0) return (c + delta) & 0xffff
            return (
              (buf.readUInt16BE(ranges + 2 * s + ro + 2 * (c - buf.readUInt16BE(starts + 2 * s))) +
                delta) &
              0xffff
            )
          }
        }
        return 0
      }
      const hmtx = table('hmtx')
      const advance = (g: number): number => buf.readUInt16BE(hmtx + 4 * Math.min(g, nHM - 1))
      const widest = Math.max(...[...'0123456789'].map((d) => advance(gid(d.charCodeAt(0)))))
      expect(widest / upem).toBeCloseTo(CRYSTAL_DIGIT_CELL_EM, 6)
    },
  )
})

describe('setCellText', () => {
  it('is a no-op without a DOM-shaped node being needed: digits become cell spans', () => {
    const made: { tag: string; text: string }[] = []
    const children: unknown[] = []
    const doc = {
      createElement: (tag: string) => {
        const o = { tag, className: '', textContent: '' }
        made.push({ tag, text: '' })
        return o
      },
      createTextNode: (t: string) => ({ text: t }),
    }
    const node = {
      dataset: {} as Record<string, string>,
      ownerDocument: doc,
      textContent: 'x',
      appendChild: (c: unknown) => children.push(c),
    }
    setCellText(node as unknown as HTMLElement, '1:2')
    expect(children).toHaveLength(3)
    expect(made.filter((m) => m.tag === 'span')).toHaveLength(2)
    setCellText(node as unknown as HTMLElement, '1:2')
    expect(children).toHaveLength(3) // unchanged text: nothing written
  })
})
