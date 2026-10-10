/**
 * Mechanical guard for the architectural boundary FF2 inherits from king-tide
 * (PORT_PLAN §2.4, DECISIONS D7, CLAUDE.md hard rule 4).
 *
 * Anything under `src/sim/**` must be:
 *   - Three-free          → no `import … from 'three'`
 *   - render-free         → no `import … from '@/render/…'`
 *   - DOM-free            → no `document` / `window` / `navigator`
 *   - deterministic       → no `Math.random()`, `Date.now()`, `performance.now()`
 *
 * A single stray import would sail through typecheck, lint, test and build and
 * surface much later as a headless test that cannot run, a ghost replay that
 * needs a GPU, or a terrain worker that cannot be a worker. This test fails
 * loudly at the source instead.
 *
 * It is also the single convention most likely to erode, which is why it is a
 * test and not a paragraph. Copied in shape from king-tide
 * `tests/unit/sim-purity-guard.test.ts`.
 *
 * Comments are stripped before matching, so prose that merely *mentions* a
 * banned token ("we deliberately avoid Math.random here") does not trip it.
 *
 * **The stripping is the TypeScript parser's, not a regex's (DEV-385).** Until
 * DEV-385 it was two regexes, block comments first. A LINE comment holding a
 * glob (a directory, then a star-prefixed file pattern) therefore opened a
 * "block comment" that ran to the next JSDoc's close and hid the code between.
 * In four sim files that code was the file's whole import block, the one place
 * a `three` import would sit: `glider.ts`, `jumpseat.ts`, `props/scatter.ts`,
 * and `terrain/chunk-to-three.ts`. The last one's glob was this guard's own
 * directory, written in a header explaining that the guard protects it.
 * Proved: a `Math.random()` and a `three` import planted there passed the old
 * guard 11/11.
 *
 * A bare `ts.createScanner` loop is NOT enough either. The scanner cannot tell
 * a regex literal from a division, or a template's tail from code, without the
 * parser calling it back (`reScanSlashToken`, `reScanTemplateToken`). Run
 * alone, it read the `/*` in `/[/*]/` as the start of a block comment, and the
 * `//` in a template's tail, after a `${…}`, as a line comment. So the parser
 * decides where every token is. The scanner only re-reads what lies BETWEEN
 * tokens, to confirm it is whitespace and comments, which is the one job it
 * does without help.
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { REPO as ROOT } from './helpers/repo-root'
import { isTsSource, walkTree } from './helpers/source-tree'

const GUARDED_DIRS = ['src/sim']

function listTs(dir: string): string[] {
  return walkTree(path.join(ROOT, dir), { match: isTsSource, optional: true })
}

const TRIVIA = new Set([
  ts.SyntaxKind.WhitespaceTrivia,
  ts.SyntaxKind.NewLineTrivia,
  ts.SyntaxKind.SingleLineCommentTrivia,
  ts.SyntaxKind.MultiLineCommentTrivia,
])

const lineAt = (src: string, offset: number): number => src.slice(0, offset).split('\n').length

/**
 * Every comment blanked to spaces, everything else where it was: the same
 * length and the same line breaks, so an offender is reported by line.
 *
 * Code is whatever lies inside one of the parser's leaf tokens, and a string,
 * a template piece or a regex literal is one token, whole. `getChildren` makes
 * a token of everything between two child nodes, even what error recovery
 * skipped, so the rest can only be whitespace and comments. That is re-scanned
 * and asserted rather than assumed: anything else THROWS instead of being
 * blanked, because this guard cannot vouch for text it has not read.
 */
function stripComments(src: string, fileName: string): string {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)
  const isCode = new Uint8Array(src.length)
  const walk = (node: ts.Node): void => {
    // A JSDoc is a child node here, but it is a comment: leave it to the scan.
    const kids = node.getChildren(sf).filter((k) => !ts.isJSDoc(k))
    if (kids.length > 0) for (const k of kids) walk(k)
    else isCode.fill(1, node.getStart(sf), node.end)
  }
  walk(sf)

  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false)
  let out = ''
  for (let i = 0; i < src.length; ) {
    let j = i + 1
    while (j < src.length && isCode[j] === isCode[i]) j++
    const run = src.slice(i, j)
    if (isCode[i]) out += run
    else {
      scanner.setText(run)
      for (let t = scanner.scan(); t !== ts.SyntaxKind.EndOfFileToken; t = scanner.scan()) {
        if (!TRIVIA.has(t)) {
          const line = lineAt(src, i + scanner.getTokenStart())
          throw new Error(`${fileName}:${line}: ${ts.SyntaxKind[t]} outside every parsed token`)
        }
      }
      out += run.replace(/[^\r\n]/g, ' ')
    }
    i = j
  }
  return out
}

const BANS: { label: string; re: RegExp }[] = [
  { label: "import from 'three'", re: /\bfrom\s+['"]three(?:\/[^'"]*)?['"]/ },
  { label: "require('three')", re: /\brequire\(\s*['"]three(?:\/[^'"]*)?['"]\s*\)/ },
  { label: 'import from @/render', re: /\bfrom\s+['"]@\/render(?:\/[^'"]*)?['"]/ },
  {
    label: 'relative import out of src/sim',
    re: /\bfrom\s+['"](?:\.\.\/)+(?:render|boot|input|content|game)\//,
  },
  { label: 'Math.random()', re: /\bMath\.random\s*\(/ },
  { label: 'Date.now()', re: /\bDate\.now\s*\(/ },
  { label: 'performance.now()', re: /\bperformance\.now\s*\(/ },
  { label: 'document', re: /\bdocument\s*\./ },
  { label: 'window', re: /\bwindow\s*\./ },
  { label: 'navigator', re: /\bnavigator\s*\./ },
]

/**
 * The multiplayer modules in `src/net/` (DEV-386/387) hold the same purity by
 * design: the room runs in a Durable Object with an INJECTED clock, and the
 * clock, codec and track run in the headless race (plan/MULTIPLAYER.md §9.1)
 * with the wall clock read by their callers. A `Date.now()` in one of them is
 * a room that cannot be tested, or a race that is not deterministic.
 */
const GUARDED_NET = /^(room-|pose-codec|remote-track)[a-z-]*\.ts$/
const guardedNet = (): string[] =>
  fs
    .readdirSync(path.join(ROOT, 'src/net'))
    .filter((f) => GUARDED_NET.test(f))
    .map((f) => path.join(ROOT, 'src/net', f))

describe('sim-purity guard', () => {
  const files = [...GUARDED_DIRS.flatMap(listTs), ...guardedNet()]

  it('guards the multiplayer modules in src/net too', () => {
    expect(guardedNet().map((f) => path.basename(f))).toEqual(
      expect.arrayContaining(['room-protocol.ts', 'room-server.ts', 'room-route.ts']),
    )
  })
  const stripped = new Map<string, string>()
  const codeOf = (file: string): string => {
    let code = stripped.get(file)
    if (code === undefined) {
      code = stripComments(fs.readFileSync(file, 'utf8'), path.relative(ROOT, file))
      stripped.set(file, code)
    }
    return code
  }

  it('finds the guarded source files', () => {
    // Sanity: if the walk ever breaks, fail rather than pass vacuously.
    expect(files.length).toBeGreaterThan(3)
  })

  it('reads every column-0 import line of every guarded file as code', () => {
    // An oracle from OUTSIDE the parser. A line that starts `import` at column
    // 0 is never inside a line comment, and in this tree never inside a block
    // one, so stripping must keep every such line. Red with the regexes this
    // replaced, naming the four files above: 4 of 4, 13 of 13, 3 of 3 and 1 of
    // 1 lost. (If a block comment ever holds commented-out imports at column 0,
    // indent them. Do not weaken this.)
    const importLines = (text: string): number =>
      text.split('\n').filter((l) => /^import\b/.test(l)).length
    const lost: string[] = []
    let total = 0
    for (const file of files) {
      const want = importLines(fs.readFileSync(file, 'utf8'))
      total += want
      const got = importLines(codeOf(file))
      if (got !== want) lost.push(`${path.relative(ROOT, file)}: ${want - got} of ${want}`)
    }
    expect(total).toBeGreaterThan(0)
    expect(lost, `stripping hid import lines in:\n${lost.join('\n')}`).toEqual([])
  })

  for (const ban of BANS) {
    it(`forbids ${ban.label} under ${[...GUARDED_DIRS, 'the src/net room modules'].join(' / ')}`, () => {
      const offenders: string[] = []
      for (const file of files) {
        const code = codeOf(file)
        const m = ban.re.exec(code)
        if (m) offenders.push(`${path.relative(ROOT, file)}:${lineAt(code, m.index)}`)
      }
      expect(
        offenders,
        `${ban.label} is banned in the sim layer but found in:\n${offenders.join('\n')}`,
      ).toEqual([])
    })
  }
})

describe('sim-purity guard: the stripper keeps code and only code', () => {
  // Code that holds a comment-shaped run of characters, then a random call,
  // then a JSDoc close for a false "block comment" to run to. The glob and the
  // string hid the call from the regexes. The template tail and the regex
  // class hid it from the regexes AND from a bare scanner loop.
  const CODE_SURVIVES: { label: string; src: string }[] = [
    {
      label: 'a line comment holding a glob (the four files)',
      src: '// reads content/levels/*.json\nconst x = Math.random()\n/** doc */\nexport const y = x\n',
    },
    {
      label: 'a string holding // and /*',
      src: "const u = 'http://host/*'\nconst x = Math.random()\n/** doc */\nexport const y = x\n",
    },
    {
      label: "a template's tail, after a substitution, holding //",
      src: `const a = 1\nconst t = \`\${a} // tail\`; const x = Math.random()\n/** doc */\nexport const y = [t, x]\n`,
    },
    {
      label: 'a regex literal whose class holds /*',
      src: 'const re = /[/*]/g\nconst x = Math.random()\n/** doc */\nexport const y = [re, x]\n',
    },
  ]
  for (const c of CODE_SURVIVES) {
    it(`keeps the code after ${c.label}`, () => {
      const out = stripComments(c.src, 'case.ts')
      expect(out).toMatch(/\bMath\.random\s*\(/)
      expect(out).toHaveLength(c.src.length)
      expect(out.split('\n')).toHaveLength(c.src.split('\n').length)
    })
  }

  it('blanks every banned token when it is only prose, in every kind of comment', () => {
    const src = [
      "// import { Mesh } from 'three' · require('three')",
      "/* from '@/render/bloom' · from '../render/bloom' */",
      '/**',
      ' * Math.random() · Date.now() · performance.now()',
      ' * document.body · window.x · navigator.xr',
      ' */',
      'export const y = 1',
      '',
    ].join('\n')
    const out = stripComments(src, 'prose.ts')
    for (const ban of BANS) expect(ban.re.test(out), ban.label).toBe(false)
    expect(out).toHaveLength(src.length)
    expect(out).toContain('export const y = 1')
  })
})
