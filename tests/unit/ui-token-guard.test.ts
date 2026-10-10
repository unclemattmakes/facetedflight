// tests/unit/ui-token-guard.test.ts: no UI colour or font stack outside the tokens. DEV-647.
//
// `render/ui-tokens.ts` is the one place the UI's palette and type live. Before
// it, eleven files each retyped six colours and a monospace stack, and "a palette
// change in one menu cannot silently restyle another" was the comment guarding
// the copies. This test is what makes the single source stay single:
//
//  1. NO TOKEN VALUE RETYPED. Every colour string the tokens file exports is read
//     out of it (so a retune moves the guard with it) and no UI source file may
//     spell the same colour out again. A retyped value is the drift the tokens
//     exist to end.
//  2. NO FONT STACK OUTSIDE THE TOKENS. A UI source file may not name the
//     platform's generic families, the Windows UI face, the Bahnschrift face or
//     the three monospace names (the words are assembled from pieces below, so
//     this file does not spell the markers it forbids: CLAUDE.md on substring
//     guards). The ledger names the files that keep a stack on purpose, each
//     with its reason.
//  3. NO NEW LOCAL PALETTE. A "painter" is any UI source that draws text on a
//     canvas or writes a CSS string. Each may carry a number of its own colour
//     literals no greater than the ledger says; the ledger is the list of the
//     distinct looks that are NOT drift (the loading scene, the HUD's inset plate,
//     the race map's inks, the editor's room), and a painter not on it has none.
//
// The page's `:root` (index.html) cannot import a module, so the same test
// reads its mirrored values and fails if they drift from the TypeScript source.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import * as tokens from '@/render/ui-tokens'
import { appSource } from './helpers/app-source'

const ROOTS = ['src/render', 'src/input', 'src/boot', 'src/game', 'src/editor', 'src/net']
const TOKENS_FILE = 'src/render/ui-tokens.ts'

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.posix.join(dir, e.name)
    if (e.isDirectory()) return walk(full)
    return full.endsWith('.ts') ? [full] : []
  })

/**
 * The entry file and everything the split moves out of it are ONE unit, read
 * through the helper every source-text guard on it reads through (a test that
 * named the file would go blind as the split proceeds).
 */
const APP_TREE = 'the boot/app tree'
const isAppFile = (f: string): boolean => /^src\/boot\/app(\.ts|\/)/.test(f)

/** Source with its comments removed: prose about a colour is not a colour. */
const strip = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
const code = (unit: string): string =>
  strip(unit === APP_TREE ? appSource() : fs.readFileSync(unit, 'utf8'))

const FILES = [...ROOTS.flatMap(walk).filter((f) => f !== TOKENS_FILE && !isAppFile(f)), APP_TREE]

// ── the markers, described and assembled (never spelled) ─────────────────────
const part = (...p: string[]): string => p.join('')
const FONT_STACK_MARKERS: readonly RegExp[] = [
  // the generic families a stack ends in, and the platform UI keywords
  new RegExp(`\\b${part('sans', '-', 'serif')}\\b`),
  new RegExp(`\\b${part('mono', 'space')}\\b`),
  new RegExp(part('system', '-', 'ui')),
  new RegExp(part('ui', '-', 'sans')),
  // the Windows UI face and the narrow Windows face a stack names
  new RegExp(part('Seg', 'oe UI')),
  new RegExp(part('Bahn', 'schrift')),
  // the mono names a stack lists
  new RegExp(part('SF', 'Mono')),
  new RegExp(part('Men', 'lo')),
  new RegExp(part('Con', 'solas')),
]

const COLOUR = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![\w-])|\brgba?\(\s*\d/g

// ── the ledger: every exception is a row with a reason ──────────────────────

/** Files that keep a font stack on purpose. */
const STACK_LEDGER: Readonly<Record<string, string>> = {
  'src/render/hud.ts': "the HUD's fallback until CRYSTAL loads (hud-font.ts); p2-hud owns it",
  'src/render/hud-dash.ts': "the dash's fallback until CRYSTAL loads; p2-hud owns it",
  'src/render/hud-font.ts': "CRYSTAL's own fallback list, the brand face's loader",
  'src/boot/lookdev.ts': 'developer instrument (?lookdev=1): a monospace column',
  'src/boot/perf-hud.ts': 'developer instrument (?perf=1): a monospace column',
  [APP_TREE]: 'a one-line debug banner of the developer instruments',
  'src/editor/desk/panel.ts': 'the editor desk: a form, not a game menu',
  'src/editor/desk/island-dialog.ts': 'the editor desk: a form, not a game menu',
  'src/editor/desk/leave.ts': 'the editor desk: a form, not a game menu',
  'src/editor/desk/finish-marker.ts': 'a world-space marker in the editor',
  'src/net/privacy-page.ts': 'the privacy page is a separate HTML document, not the game',
}

/** A distinct look that is NOT drift: the most colour literals the file may carry, and why. */
interface PaletteRow {
  readonly max: number
  readonly why: string
}

/** Painters with a palette of their own. A painter not listed here has none. */
const COLOUR_LEDGER: Readonly<Record<string, PaletteRow>> = {
  'src/render/hud.ts': {
    max: 5,
    why: "the cockpit HUD's inset teal plate, charge cyan and tank tracks",
  },
  'src/render/hud-dash.ts': { max: 2, why: "the dash's own teal plate pair (2016's dash)" },
  'src/render/loading-scene.ts': {
    max: 10,
    why: 'the loading scene is its own dark world before the game exists',
  },
  'src/render/title.ts': {
    max: 2,
    why: "2016's own title label ink and its hard shadow (DEV-155)",
  },
  'src/render/perf-plate.ts': { max: 4, why: 'developer instrument (?perf=1)' },
  'src/boot/perf-hud.ts': { max: 5, why: 'developer instrument (?perf=1)' },
  'src/boot/lookdev.ts': { max: 14, why: 'developer instrument (?lookdev=1)' },
  [APP_TREE]: {
    max: 4,
    why: 'the editor recording indicator (a dev tool; shared file, not restyled here)',
  },
  'src/boot/room-share.ts': {
    max: 2,
    why: "the QR code's black and white: a code is read by a camera",
  },
  'src/editor/bench/plate.ts': { max: 6, why: "the editor bench's own room greys" },
  'src/editor/desk/panel.ts': {
    max: 93,
    why: 'the editor desk: a form, not a game menu; DEV-878 added the top bar, strip, corner and sheet styles',
  },
  'src/editor/desk/island-dialog.ts': { max: 17, why: 'the editor desk: a form' },
  'src/editor/desk/leave.ts': { max: 12, why: 'the editor desk: a form' },
  'src/editor/desk/light-panel.ts': { max: 1, why: 'the editor desk: a form' },
  'src/editor/desk/prop-panel.ts': { max: 2, why: 'the editor desk: a form' },
  'src/editor/desk/shipped.ts': { max: 3, why: 'the editor desk: a form' },
  'src/editor/desk/finish-marker.ts': { max: 2, why: 'a world-space marker in the editor' },
  'src/net/privacy-page.ts': { max: 6, why: 'a separate HTML document, not the game' },
}

const isPainter = (src: string): boolean =>
  src.includes('fillText(') || src.includes('.cssText') || /\bfont:\s*[\d"'`$]/.test(src)

describe('the UI tokens are the one source (DEV-647)', () => {
  it('no source file retypes a colour the tokens export', () => {
    const values = Object.entries(tokens)
      .filter(([, v]) => typeof v === 'string' && /^(#|rgba?\()/.test(v as string))
      .map(([k, v]) => [k, (v as string).toLowerCase()] as const)
    expect(values.length).toBeGreaterThan(10)
    const bad: string[] = []
    for (const f of FILES) {
      const src = code(f).toLowerCase()
      for (const [k, v] of values) if (src.includes(v)) bad.push(`${f} retypes ${k} (${v})`)
    }
    expect(bad, 'import the token instead of typing its value').toEqual([])
  })

  it('no UI source names a font stack, except the ledger', () => {
    const bad: string[] = []
    for (const f of FILES) {
      if (f in STACK_LEDGER) continue
      const src = code(f)
      if (FONT_STACK_MARKERS.some((m) => m.test(src))) bad.push(f)
    }
    expect(bad, 'use uiFont / UI_STACK from ui-tokens, or add a ledger row with a reason').toEqual(
      [],
    )
  })

  it('every font-stack ledger row is still true', () => {
    for (const f of Object.keys(STACK_LEDGER)) {
      expect(f === APP_TREE || fs.existsSync(f), `${f} exists`).toBe(true)
      expect(
        FONT_STACK_MARKERS.some((m) => m.test(code(f))),
        `${f} still names a stack; delete its ledger row if it no longer does`,
      ).toBe(true)
    }
  })

  it('no painter grows a local palette beyond the ledger', () => {
    const over: string[] = []
    for (const f of FILES) {
      const src = code(f)
      if (!isPainter(src)) continue
      const n = (src.match(COLOUR) ?? []).length
      const allowed = COLOUR_LEDGER[f]?.max ?? 0
      if (n > allowed) over.push(`${f}: ${n} colour literals, ledger allows ${allowed}`)
    }
    expect(over).toEqual([])
  })
})

describe('the palette ledger stays honest', () => {
  it('every row names a file that still draws with that many colour literals, give or take none', () => {
    for (const [f, row] of Object.entries(COLOUR_LEDGER)) {
      expect(f === APP_TREE || fs.existsSync(f), `${f} exists`).toBe(true)
      const n = (code(f).match(COLOUR) ?? []).length
      expect(n, `${f}: ledger says ${row.max} (${row.why}); lower the row to ${n}`).toBe(row.max)
    }
  })
})

describe("the page's :root mirrors the tokens", () => {
  const html = fs.readFileSync('index.html', 'utf8')
  const root = html.slice(html.indexOf(':root {'), html.indexOf('}', html.indexOf(':root {')))
  const read = (name: string): string => {
    const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(root)
    return (m?.[1] ?? '').trim().replace(/\s+/g, ' ')
  }

  it('ink, dim, accent, plate and edge are the TypeScript values', () => {
    expect(read('ink')).toBe(tokens.UI_INK)
    expect(read('ink-dim')).toBe(tokens.UI_DIM)
    expect(read('accent')).toBe(tokens.UI_ACCENT)
    expect(read('plate')).toBe(tokens.UI_PLATE)
    expect(read('edge')).toBe(tokens.UI_PLATE_EDGE)
  })

  it('the UI font is the TypeScript stack', () => {
    expect(read('ui-font')).toBe(tokens.UI_STACK)
  })
})
