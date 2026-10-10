// tests/unit/ui-glyph-coverage.test.ts: DEV-883, no UI string drops a character.
//
// Playtest 2026-10-09: "NEW HERE?" rendered "NEW HEREP". CRYSTAL holds a "?"
// glyph and draws it as a P at the note size. The fix is in two halves, and
// this file holds both against something OUTSIDE the code (the font file's own
// cmap, not a list the code keeps about itself):
//
//  1. A character CRYSTAL has a glyph for but draws badly is cut out of the
//     registered FontFace by `unicode-range`, so the browser draws it from the
//     fallback face. The range is read back here and tested on the characters.
//  2. A character CRYSTAL has NO glyph for is drawn by the fallback stack, and
//     every one the player-facing strings use is named in `UI_FALLBACK_CHARS`.
//     The sweep reads the string literals of the files that draw plates
//     (through the TypeScript parser, so a comment never counts) and the
//     authored level JSON, and fails on a character that is in neither CRYSTAL
//     nor that list: a new one is a decision, made here, not a screenshot.
//
// The font is a gitignored asset (`pnpm assets:pull`): the disk reads sit inside
// the `it`s, behind a guard, with a loud counterpart.

import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { creditsRoll } from '@/render/credits-menu'
import { HUD_FONT_BAD_GLYPHS, hudFontUnicodeRange } from '@/render/hud-font'
import { UI_FALLBACK_CHARS } from '@/render/ui-font'
import { REPO } from './helpers/repo-root'

const FONT = path.join(REPO, 'public/assets/fonts/crystal-regular.ttf')
const haveFont = fs.existsSync(FONT)

/** The code points a TrueType file's format 4 (Unicode BMP) cmap subtable maps to a glyph. */
const cmapOf = (file: string): Set<number> => {
  const b = fs.readFileSync(file)
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  let cmap = -1
  for (let i = 0; i < dv.getUint16(4); i++) {
    const o = 12 + i * 16
    if (b.toString('latin1', o, o + 4) === 'cmap') cmap = dv.getUint32(o + 8)
  }
  const out = new Set<number>()
  for (let t = 0; t < dv.getUint16(cmap + 2); t++) {
    const sub = cmap + dv.getUint32(cmap + 8 + t * 8)
    if (dv.getUint16(sub) !== 4) continue
    const segs = dv.getUint16(sub + 6) / 2
    const ends = sub + 14
    const starts = ends + segs * 2 + 2
    const deltas = starts + segs * 2
    const offsets = deltas + segs * 2
    for (let k = 0; k < segs; k++) {
      const end = dv.getUint16(ends + k * 2)
      const start = dv.getUint16(starts + k * 2)
      const delta = dv.getInt16(deltas + k * 2)
      const ro = dv.getUint16(offsets + k * 2)
      for (let c = start; c <= end && c < 0xffff; c++) {
        let g = (c + delta) & 0xffff
        if (ro !== 0) {
          g = dv.getUint16(offsets + k * 2 + ro + (c - start) * 2)
          if (g !== 0) g = (g + delta) & 0xffff
        }
        if (g !== 0) out.add(c)
      }
    }
  }
  return out
}

/** Does a `unicode-range` descriptor cover `ch`? */
const inRange = (range: string, ch: string): boolean => {
  const cp = ch.codePointAt(0) ?? 0
  return range.split(',').some((part) => {
    const [lo, hi] = part.trim().replace(/U\+/g, '').split('-')
    const a = Number.parseInt(lo ?? '', 16)
    const z = hi === undefined ? a : Number.parseInt(hi, 16)
    return cp >= a && cp <= z
  })
}

/** Every string literal in the TypeScript files under `dirs`, comments excluded. */
const literalsUnder = (dirs: readonly string[]): { file: string; text: string }[] => {
  const out: { file: string; text: string }[] = []
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (p.endsWith('.ts')) {
        const sf = ts.createSourceFile(p, fs.readFileSync(p, 'utf8'), ts.ScriptTarget.Latest, true)
        const visit = (n: ts.Node): void => {
          if (
            ts.isStringLiteral(n) ||
            ts.isNoSubstitutionTemplateLiteral(n) ||
            ts.isTemplateHead(n) ||
            ts.isTemplateMiddle(n) ||
            ts.isTemplateTail(n)
          )
            out.push({ file: p, text: n.text })
          ts.forEachChild(n, visit)
        }
        visit(sf)
      }
    }
  }
  for (const d of dirs) walk(path.join(REPO, d))
  return out
}

/** Every string value in a JSON tree. */
const jsonStrings = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) jsonStrings(x, out)
  else if (v !== null && typeof v === 'object')
    for (const x of Object.values(v)) jsonStrings(x, out)
  return out
}

describe('DEV-883: the FontFace leaves out the characters CRYSTAL draws badly', () => {
  it('cuts the question mark and nothing else', () => {
    const range = hudFontUnicodeRange()
    expect(HUD_FONT_BAD_GLYPHS).toBe('?')
    expect(inRange(range, '?')).toBe(false)
    for (const ch of 'ABCZ09 !>@\u00a9\u2014')
      expect(inRange(range, ch), `${JSON.stringify(ch)} stays in CRYSTAL's range`).toBe(true)
    expect(inRange(range, '\u{10ffff}')).toBe(true)
  })

  it('builds a valid range for several cut characters, adjacent ones included', () => {
    const range = hudFontUnicodeRange('?>A')
    for (const ch of '?>A') expect(inRange(range, ch)).toBe(false)
    for (const ch of '=@B') expect(inRange(range, ch)).toBe(true)
    expect(range).toBe('U+0000-003D, U+0040, U+0042-10FFFF')
  })
})

describe.skipIf(!haveFont)('DEV-883: every UI string is drawn, by CRYSTAL or its fallback', () => {
  it('the cut character is one CRYSTAL really holds (so the cut is what draws it elsewhere)', () => {
    expect(cmapOf(FONT).has('?'.codePointAt(0) ?? 0)).toBe(true)
  })

  it('every character the credits roll sets is in CRYSTAL, or named as a fallback', () => {
    const cmap = cmapOf(FONT)
    const lines = creditsRoll('v0.0.0').map((l) => l.text.toUpperCase())
    const lacking = new Set<string>()
    for (const text of lines)
      for (const ch of text) if (!cmap.has(ch.codePointAt(0) ?? 0)) lacking.add(ch)
    for (const ch of lacking)
      expect(UI_FALLBACK_CHARS, `credits use ${JSON.stringify(ch)}`).toContain(ch)
  })

  it('every non-ASCII character in the plate-drawing string literals is in CRYSTAL or named', () => {
    const cmap = cmapOf(FONT)
    const stray = new Map<string, string>()
    for (const { file, text } of literalsUnder([
      'src/render',
      'src/game',
      'src/content',
      'src/input',
    ])) {
      if (file.includes('generated')) continue
      for (const ch of text.toUpperCase()) {
        const cp = ch.codePointAt(0) ?? 0
        if (cp < 0x80 || cmap.has(cp) || UI_FALLBACK_CHARS.includes(ch)) continue
        stray.set(ch, path.relative(REPO, file))
      }
    }
    expect(
      [...stray].map(
        ([ch, f]) => `${JSON.stringify(ch)} U+${ch.codePointAt(0)?.toString(16)} in ${f}`,
      ),
      'a character CRYSTAL lacks: add it to UI_FALLBACK_CHARS (render/ui-font.ts), deliberately',
    ).toEqual([])
  })

  it('every ASCII character CRYSTAL lacks is none: printable ASCII is all in the file', () => {
    const cmap = cmapOf(FONT)
    const missing: string[] = []
    for (let cp = 0x21; cp < 0x7f; cp++) {
      const ch = String.fromCodePoint(cp)
      // The UI sets capitals only (`installUiCaps`), so the lowercase half is never asked for.
      if (ch >= 'a' && ch <= 'z') continue
      if (!cmap.has(cp)) missing.push(ch)
    }
    expect(missing).toEqual([])
  })

  it('the authored level JSON uses nothing CRYSTAL lacks outside the named fallback', () => {
    const cmap = cmapOf(FONT)
    const dir = path.join(REPO, 'content')
    const stray = new Set<string>()
    for (const sub of ['levels', 'authored']) {
      const d = path.join(dir, sub)
      if (!fs.existsSync(d)) continue
      for (const f of fs.readdirSync(d).filter((n) => n.endsWith('.json'))) {
        for (const s of jsonStrings(JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'))))
          for (const ch of s.toUpperCase()) {
            const cp = ch.codePointAt(0) ?? 0
            if (cp >= 0x20 && !cmap.has(cp) && !UI_FALLBACK_CHARS.includes(ch)) stray.add(ch)
          }
      }
    }
    expect([...stray]).toEqual([])
  })
})

describe.skipIf(haveFont)('DEV-883: the font asset is absent here', () => {
  it('says so loudly: the cmap sweeps above did not run', () => {
    expect(haveFont, 'run `pnpm assets:pull` to run the glyph sweeps').toBe(false)
  })
})
