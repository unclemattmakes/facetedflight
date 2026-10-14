/**
 * The engine-layer guard (eval wave E, DEV-950). The workspace split waits for
 * FF2 (docs/plan/PROJECT-EVAL-2026-10-13.md section 3); this is the seam that
 * keeps the files already clean from regressing before it. Same idea as
 * `sim-purity-guard.test.ts`, for a marker instead of a directory.
 *
 * A file whose FIRST FIVE LINES carry the marker below may import nothing from
 * `src/game`, `src/content`, `src/generated` or `src/boot/app`, statically,
 * re-exported, or through a dynamic `import()`. The marker is read from the
 * file's head only, so a comment further down that merely quotes it is inert,
 * and imports come from the TypeScript parser, so a comment that quotes a
 * forbidden path is inert too. The marker is spelled once, here, as a
 * constant; docs describe it as "the engine marker".
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { REPO as ROOT } from './helpers/repo-root'
import { isTsSource, walkTree } from './helpers/source-tree'

const MARKER = '@engine-layer'
const FORBIDDEN = ['src/game', 'src/content', 'src/generated', 'src/boot/app']

/** Module specifiers a source file names, however it names them. */
function specifiersOf(src: string): string[] {
  const sf = ts.createSourceFile('x.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const out: string[] = []
  const walk = (n: ts.Node): void => {
    if (
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
      n.moduleSpecifier &&
      ts.isStringLiteral(n.moduleSpecifier)
    ) {
      out.push(n.moduleSpecifier.text)
    } else if (
      ts.isCallExpression(n) &&
      n.expression.kind === ts.SyntaxKind.ImportKeyword &&
      n.arguments[0] &&
      ts.isStringLiteralLike(n.arguments[0])
    ) {
      out.push(n.arguments[0].text)
    }
    ts.forEachChild(n, walk)
  }
  walk(sf)
  return out
}

/** Repo-relative target of a specifier from `file`, or null for a package. */
function target(file: string, spec: string): string | null {
  let abs: string
  if (spec.startsWith('@/')) abs = path.join(ROOT, 'src', spec.slice(2))
  else if (spec.startsWith('.')) abs = path.resolve(path.dirname(file), spec)
  else return null
  return path.relative(ROOT, abs).split(path.sep).join('/')
}

const offences = (file: string, src: string): string[] =>
  specifiersOf(src).filter((spec) => {
    const t = target(file, spec)
    return t !== null && FORBIDDEN.some((f) => t === f || t.startsWith(`${f}/`))
  })

const marked = (src: string): boolean => src.split('\n', 5).some((l) => l.includes(MARKER))

const files = walkTree(path.join(ROOT, 'src'), { match: isTsSource })
  .map((f) => ({ f, src: fs.readFileSync(f, 'utf8') }))
  .filter(({ src }) => marked(src))

describe('engine layering guard', () => {
  it('marks a non-trivial set of files (the guard is not vacuous)', () => {
    expect(files.length).toBeGreaterThanOrEqual(20)
  })

  it('no marked file imports game, content, generated or boot/app', () => {
    const bad = files.flatMap(({ f, src }) =>
      offences(f, src).map((s) => `${path.relative(ROOT, f)} imports ${s}`),
    )
    expect(bad).toEqual([])
  })

  it('catches each forbidden route: aliased, relative, re-exported, dynamic', () => {
    const f = path.join(ROOT, 'src/render/x.ts')
    const src = [
      "import a from '@/game/mission'",
      "export { b } from '../content/load-level'",
      "import type { C } from '@/generated/constants.generated'",
      "const d = import('@/boot/app/frame')",
      "import ok from '@/sim/math/vec3'",
      "// import z from '@/game/ignored-in-a-comment'",
    ].join('\n')
    expect(offences(f, src)).toEqual([
      '@/game/mission',
      '../content/load-level',
      '@/generated/constants.generated',
      '@/boot/app/frame',
    ])
  })

  it('reads the marker from the head only', () => {
    expect(marked(`// ${MARKER}\nx`)).toBe(true)
    expect(marked(`\n\n\n\n\n\n// ${MARKER}`)).toBe(false)
  })
})
