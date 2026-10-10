// tests/unit/e2e-import-graph.test.ts — an e2e spec may not import Vite.
//
// ── The day this cost ────────────────────────────────────────────────────
//
// On 2026-09-14 one import was added to `src/render/elevator.ts` — a colour
// constant, from `src/render/hangar.ts` — and the WHOLE Playwright suite went to
// `Total: 0 tests in 0 files`:
//
//     launch-ride-on-switch.spec.ts
//       -> src/render/elevator      (for REVEAL_RISE)
//       -> src/render/hangar        (for the colour)
//       -> src/game/mission-shape
//       -> src/content/load-level   -> `import.meta.glob(...)`
//
// `import.meta.glob` is Vite's, and Playwright's transformer does not have it,
// so the import throws at COLLECTION time before a single spec runs. Four things
// then conspire to hide it:
//
//   * it prints as an ordinary TypeError with exit 1, which reads like "the
//     suite failed" and not like "the suite no longer exists";
//   * the count that would have given it away is at the TOP of the output,
//     under the error, and nobody scrolls up past a stack trace;
//   * CI does not run e2e at all (no GPU), so nothing downstream noticed;
//   * and the edge that did it was one line in a file whose own change was
//     about geometry.
//
// It reached `main` and was pushed. The unit suite was green the whole time.
//
// ── What this asserts, and why it is static ──────────────────────────────
//
// Running Playwright to find out is a GPU, a dev server and seven minutes. This
// walks the import graph from every spec instead, in milliseconds, in node —
// so the guard runs in the same suite as everything else and fails in CI, which
// is exactly where the real failure could not.
//
// It checks a PROPERTY of the graph rather than a list of known-bad files: any
// module an e2e spec can reach must not use a build-tool-only global. A new
// `import.meta.env` in a reachable file fails here too, which is the point —
// the next one of these will not be `glob`.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// The walk itself is shared with the tiered runner and the smoke-list guard:
// one answer to "what does this file import", in plain Node. See the header of
// tools/test/import-graph.mjs.
import { importsOf, REPO, rel, walkImports } from '../../tools/test/import-graph.mjs'

const E2E_DIR = path.join(REPO, 'tests', 'e2e')

/**
 * Things Vite provides and Playwright's transformer does not.
 *
 * `import.meta.glob` is the one that bit. `import.meta.env` is the same shape:
 * `boot/app.ts` guards its dev handle with it, and a spec that reached that file
 * would die the same way.
 */
const VITE_ONLY = [/import\.meta\.glob/, /import\.meta\.env/]

/**
 * DEV-504: a JSON module VALUE-imported with no import attribute. Vite takes
 * it; Playwright's loader refuses it at collection ("needs an import attribute
 * of type: json") and the whole run collects nothing — `prop-library.ts` read
 * its table that way for one commit (checked: `--list` found 0 tests, and 1
 * with the table as a module). NOT in `VITE_ONLY`: the walk follows
 * `import type` edges too, and `room-crowd.ts` reaches `lap-courses.ts`'s JSON
 * only by a type import, which is erased and loads fine. So it is asked of the
 * one module every editor spec reaches by VALUE, the player-course format, and
 * of everything that reaches.
 */
const BARE_JSON_IMPORT = /^\s*import\s(?!type\s)[^;\n]*\sfrom\s*['"][^'"]+\.json['"]\s*;?\s*$/m

describe('DEV-504 — the course format imports no bare JSON', () => {
  it('the pattern catches one with no attribute, and passes one with it', () => {
    expect(BARE_JSON_IMPORT.test("import table from '../../content/prop-library.json'")).toBe(true)
    expect(
      BARE_JSON_IMPORT.test("import t from '../../content/x.json' with { type: 'json' }"),
    ).toBe(false)
    expect(BARE_JSON_IMPORT.test("import type { T } from './t.json'")).toBe(false)
  })

  it('nothing player-course.ts reaches value-imports JSON', () => {
    const hits = [...walkImports(path.join(REPO, 'src', 'content', 'player-course.ts'))]
      // The raw source: the pattern is anchored to a line that STARTS with
      // `import`, which no `//` or ` * ` comment line does. (It also predates
      // DEV-505, when `withoutComments` could eat real import lines.)
      .filter((n) => BARE_JSON_IMPORT.test(fs.readFileSync(n.file, 'utf8')))
      .map((n) => n.chain.map(rel).join(' -> '))
    expect(hits).toEqual([])
  })
})

/** Punctuation after which a `/` begins a regex literal rather than a division. */
const REGEX_PRECEDES = new Set('(,=:[!&|?{};+-*%<>~^'.split(''))
/** …and the keywords after which it does too (`return /x/`). */
const REGEX_KEYWORD = /(?:^|[^\w$.])(?:return|typeof|case|do|else|in|of|void|yield|await)\s*$/

/**
 * Remove comments before looking, and nothing else.
 *
 * This file and `render/instrument-colour.ts` both NAME `import.meta.glob` in
 * their prose, which is the whole reason they exist — and the first run of this
 * guard failed on its own explanation.
 *
 * DEV-505: this used to be a `/\*…*\/` regex plus a filter on lines starting
 * `//` or `*`, and the regex ran FIRST — so a glob written in a line comment
 * (`content/*.json`) opened a "block comment" that ran to the next real `*\/`
 * and deleted every import and `import.meta.glob` in between. A guard that can
 * be switched off by a comment is not a guard. So this walks the source once,
 * knowing which of code, string, template, regex, line comment or block comment
 * it is in: a `/*` counts only in code, and quotes only outside comments.
 * Comments become a single space (block comments keep their newlines, so line
 * numbers and `^`-anchored patterns still line up); everything else is kept.
 */
const withoutComments = (src: string): string => {
  let out = ''
  let i = 0
  // Template nesting: each entry is the `{` depth at which a `${` opened.
  const templates: number[] = []
  let braces = 0
  // Last significant code character, for telling a regex from a division.
  let prev = ''
  const quoted = (q: string): void => {
    const start = i++
    while (i < src.length && src[i] !== q && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1
    i++
    out += src.slice(start, i)
    prev = q
  }
  // From just after a backtick (or a closing `}` of `${`) to the end of the text part.
  const templateText = (): void => {
    const start = i
    while (i < src.length && src[i] !== '`' && !(src[i] === '$' && src[i + 1] === '{'))
      i += src[i] === '\\' ? 2 : 1
    if (src[i] === '`') {
      i++
    } else if (i < src.length) {
      i += 2
      templates.push(braces++)
    }
    out += src.slice(start, i)
    prev = '`'
  }
  while (i < src.length) {
    const c = src.charAt(i)
    const d = src.charAt(i + 1)
    if (c === '/' && d === '/') {
      while (i < src.length && src[i] !== '\n') i++
      out += ' '
    } else if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end < 0 ? src.length : end + 2
      out += src.slice(i, stop).replace(/[^\n]/g, '').replace(/^$/, ' ')
      i = stop
    } else if (c === "'" || c === '"') {
      quoted(c)
    } else if (c === '`') {
      out += c
      i++
      templateText()
    } else if (c === '/' && (prev === '' || REGEX_PRECEDES.has(prev) || REGEX_KEYWORD.test(out))) {
      // A regex literal: skip to its closing `/`, respecting escapes and classes.
      const start = i++
      let inClass = false
      while (i < src.length && src[i] !== '\n' && (inClass || src[i] !== '/')) {
        if (src[i] === '\\') i++
        else if (src[i] === '[') inClass = true
        else if (src[i] === ']') inClass = false
        i++
      }
      i++
      out += src.slice(start, i)
      prev = '/'
    } else {
      if (c === '{') braces++
      else if (c === '}') {
        braces--
        if (templates.length > 0 && templates.at(-1) === braces) {
          templates.pop()
          out += c
          i++
          templateText()
          continue
        }
      }
      out += c
      i++
      if (!/\s/.test(c)) prev = c
    }
  }
  return out
}

describe('DEV-505 — comment stripping strips only comments', () => {
  it('a glob in prose does not open a block comment that eats real code', () => {
    const fixture = [
      '// the tables live in content/*.json, one per mission',
      "import { load } from './load'",
      "const all = import.meta.glob('./levels/*.json')",
      '/** a real doc comment, closed here */',
      'export const n = 1',
    ].join('\n')
    const out = withoutComments(fixture)
    expect(out).toContain("import { load } from './load'")
    expect(out).toContain('import.meta.glob')
    expect(out).toContain('export const n = 1')
    expect(out).not.toContain('one per mission')
    expect(out).not.toContain('real doc comment')
  })

  it('comment markers inside strings, templates and regexes are code, not comments', () => {
    const keep = [
      "const url = 'https://example.com/*'",
      'const a = "glob: src/**/*.ts // not a comment"',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source text
      'const t = `docs/*.md ${n /* inner */ + 1} and // still text`',
      'const re = /a\\/*b/g',
      'const f = () => { return /[/*]x/ }',
      "import.meta.glob('./*.json')",
    ]
    const out = withoutComments(keep.join('\n'))
    for (const line of keep.filter((l) => !l.includes('inner'))) expect(out).toContain(line)
    // biome-ignore lint/suspicious/noTemplateCurlyInString: expected output text
    expect(out).toContain('`docs/*.md ${n   + 1} and // still text`')
    expect(out.split('\n')).toHaveLength(keep.length)
  })

  it('block comments keep their newlines, so a line-anchored pattern still lines up', () => {
    const out = withoutComments('/* one\n two */import x from "y"\nconst z = 1 // tail')
    expect(out.split('\n')).toEqual(['', 'import x from "y"', 'const z = 1  '])
  })
})

/** Walk from `entry`, returning the first file that uses a Vite-only global, with its path. */
const findViteOnly = (entry: string): { file: string; chain: string[] } | null => {
  // The spec file itself is transformed by Playwright too, so it is checked
  // like any other node rather than skipped — `walkImports` yields it first.
  // `valueOnly`: Playwright erases `import type`, so a type edge loads nothing.
  // `fixtures/ff2.ts` is the door that relies on it (see the describe below).
  for (const node of walkImports(entry, { valueOnly: true })) {
    const src = withoutComments(fs.readFileSync(node.file, 'utf8'))
    if (VITE_ONLY.some((re) => re.test(src))) return node
  }
  return null
}

describe('the walk skips what a compiler erases, and nothing else', () => {
  const importsFrom = (source: string, valueOnly: boolean): string[] => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff2-import-walk-'))
    try {
      const file = path.join(dir, 'probe.ts')
      fs.writeFileSync(file, source)
      return importsOf(file, { valueOnly })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
  const source = [
    "import type { A } from './a'",
    'import type {',
    '  B,',
    "} from './b'",
    "export type { C } from './c'",
    "import { type D } from './d'",
    "import { e } from './e'",
    "import f from './f'",
  ].join('\n')

  it('drops whole type-only statements, one line or several, and keeps every other import', () => {
    expect(importsFrom(source, true)).toEqual(['./d', './e', './f'])
    expect(importsFrom(source, false)).toEqual(['./a', './b', './c', './d', './e', './f'])
  })

  it('fixtures/ff2.ts reaches src by type edges only, which is why the walk may skip them', () => {
    const ff2 = path.join(E2E_DIR, 'fixtures', 'ff2.ts')
    // Both halves matter. With the type edges the door reaches `src/`, so the
    // exemption is real and in use; without them it reaches nothing, so a value
    // import added to this file would put its target back in the walk.
    expect(importsOf(ff2, { valueOnly: false }).length).toBeGreaterThan(0)
    expect(importsOf(ff2, { valueOnly: true })).toEqual([])
  })
})

const specs = fs
  .readdirSync(E2E_DIR)
  .filter((f) => f.endsWith('.spec.ts'))
  .map((f) => path.join(E2E_DIR, f))

describe('no e2e spec can reach a Vite-only global', () => {
  it('found the specs at all', () => {
    // A guard whose input silently became empty is not a guard. This has caught
    // itself once already — `readdirSync` on the wrong directory returns a
    // perfectly green nothing.
    expect(specs.length).toBeGreaterThan(20)
  })

  for (const spec of specs) {
    it(`${path.basename(spec)} imports nothing that needs Vite`, () => {
      const hit = findViteOnly(spec)
      expect(
        hit,
        hit
          ? `Playwright cannot transform this, so the WHOLE suite collects 0 tests:\n  ${hit.chain
              .map(rel)
              .join('\n  -> ')}`
          : '',
      ).toBeNull()
    })
  }
})
