// tools/test/import-graph.mjs — the static import walker, shared.
//
// ── Why one walker ───────────────────────────────────────────────────────
//
// `tests/unit/e2e-import-graph.test.ts` walks the import graph from every
// Playwright spec to prove none can reach a Vite-only global. The tiered test
// runner (`tools/test/tiered.mjs`) needs the same walk for a different question
// — *how many `src/` modules does this unit test reach?* — and so does the test
// that keeps the smoke list honest (`tests/unit/smoke-list.test.ts`). Three
// copies of "resolve `@/` and `./`, try the four candidate filenames" would be
// three places to disagree about what an import is, so the walk lives here,
// once, in plain Node so the runner can use it without a transpiler.
//
// ── What counts as an import ─────────────────────────────────────────────
//
// Every `from '...'` in the file, comments included. Deliberately crude: a
// walker that over-approximates fails in the direction that matters for every
// caller (a spec is flagged that would have been fine; a test is counted wider
// than it is). `import type` statements are included unless a caller asks for
// `valueOnly` (the e2e guard does: Playwright erases them). Bare specifiers are
// packages and stop the walk; `@/` is the vitest/tsconfig alias for `src/`;
// anything else relative is resolved against the importing file. JSON imports
// resolve (they are files) but are not modules under `src/`, so they never
// count toward width.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The repository root, derived from this file's location rather than the CWD. */
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const SRC = path.join(REPO, 'src')

/** Forward-slashed path relative to the repo root — for anything printed or compared. */
export const rel = (abs) => path.relative(REPO, abs).replace(/\\/g, '/')

/** Resolve an import specifier to a file on disk, or null if it is a package. */
export const resolveSpecifier = (fromFile, spec) => {
  let base
  if (spec.startsWith('@/')) base = path.join(SRC, spec.slice(2))
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec)
  else return null
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  return null
}

/**
 * Whole `import type ... from '...'` and `export type ... from '...'`
 * statements. The compiler erases these before anything runs, so a loader that
 * transpiles per file (Playwright's) never opens the module they name. Only a
 * statement that STARTS `import type` counts: `import { type X } from '...'`
 * keeps its module under `verbatimModuleSyntax`, so that edge stays a real one.
 * The body runs lazily to the first `from '...'`, which ends the statement in
 * this repo's semicolon-free style as well as in the other.
 */
const TYPE_ONLY_STATEMENT = /^(?:import|export)\s+type\s[\s\S]*?\sfrom\s+['"][^'"]+['"]/gm

/**
 * Every `from '...'` in a file. With `valueOnly`, the type-only statements are
 * left out first: what remains is the set of modules the file can LOAD.
 */
export const importsOf = (file, { valueOnly = false } = {}) => {
  let src = fs.readFileSync(file, 'utf8')
  if (valueOnly) src = src.replace(TYPE_ONLY_STATEMENT, '')
  return [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
}

/**
 * Breadth-first over the static import graph from `entry`, yielding each file
 * once with the chain of imports that first reached it (the entry included, so
 * `chain[0] === entry`). The entry itself is yielded first. `valueOnly` skips
 * the edges a compiler erases (see `importsOf`).
 */
export function* walkImports(entry, options = {}) {
  const seen = new Set()
  const queue = [{ file: entry, chain: [entry] }]
  while (queue.length > 0) {
    const next = queue.shift()
    if (seen.has(next.file)) continue
    seen.add(next.file)
    yield next
    for (const spec of importsOf(next.file, options)) {
      const target = resolveSpecifier(next.file, spec)
      if (target && !seen.has(target)) queue.push({ file: target, chain: [...next.chain, target] })
    }
  }
}

const isSrcModule = (file) =>
  file.startsWith(SRC + path.sep) && file.endsWith('.ts') && !file.endsWith('.d.ts')

/**
 * The set of `src/` modules a file can reach, as repo-relative forward-slashed
 * paths. This is the WIDTH of a test: how many modules it puts on the line.
 */
export const reachableSrc = (entry) => {
  const out = new Set()
  for (const { file } of walkImports(entry)) if (isSrcModule(file)) out.add(rel(file))
  return out
}

/** Every vitest file: `tests/unit/**\/*.test.ts` and `src/**\/*.test.ts`, matching vitest.config.ts. */
export const unitTestFiles = () => {
  const out = []
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(p)
      else if (entry.name.endsWith('.test.ts')) out.push(p)
    }
  }
  visit(path.join(REPO, 'tests', 'unit'))
  visit(SRC)
  return out.sort()
}
