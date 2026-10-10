// tests/unit/editor-lazy-graph.test.ts — the editor stays out of the game's
// entry chunk, as a property of the IMPORT GRAPH. APP-SPLIT phase 0.
//
// `editor-desk.test.ts` says *"the desk is LAZY: `boot/app.ts` reaches
// `src/editor/desk/` by a dynamic import only"*, and checks it by reading the
// import lines of `app.ts`. That was the whole of the claim while `app.ts` was
// the only door from the game into the editor. The app-split adds doors: any
// module under `src/boot/app/` — or any module those import — that pulls an
// editor file in STATICALLY puts the editor in the boot bundle, and a check of
// one file's text cannot see a second file.
//
// So this walks the graph instead: every module `src/main.ts` reaches by a
// static import, and none of them may be under `src/editor/`. That is a fact
// about the bundle, not about where a line happens to live, so no split can
// route around it.
//
// ── What counts as an edge ───────────────────────────────────────────────
//
// `tsconfig.json` sets `verbatimModuleSyntax`, under which only a statement
// that is WHOLLY `import type …` / `export type …` is erased. An import whose
// named specifiers are all inline types — `import { type A } from 'x'` — is
// rewritten to `import {} from 'x'`, which still LOADS `x`. So that form is an
// edge here, and only the whole-statement `type` form is not. A dynamic
// `import('…')` is not an edge: that is what lazy means.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO, rel, resolveSpecifier, walkImports } from '../../tools/test/import-graph.mjs'
import { APP_ENTRY } from './helpers/app-source'

const ENTRY = path.join(REPO, 'src', 'main.ts')

// The clause before `from` may hold no quote: this codebase writes no
// semicolons, so a clause allowed to contain one would run on from a
// side-effect `import './x'` to the next `from '…'` and swallow the edge.
const STATEMENT =
  /^[ \t]*(?:import|export)\s+([^;'"]*?)\s*from\s*['"]([^'"]+)['"]|^[ \t]*import\s+['"]([^'"]+)['"]/gm

/** The specifiers a module's text LOADS when it is evaluated: every static edge but `import type`. */
const loadedSpecifiersIn = (text: string): string[] => {
  const out: string[] = []
  for (const m of text.matchAll(STATEMENT)) {
    if (m[3]) {
      out.push(m[3])
      continue
    }
    if (/^type\b/.test((m[1] ?? '').trim())) continue
    out.push(m[2] as string)
  }
  return out
}

/** Every file the entry loads, each with the chain that first reached it. */
const loadedFrom = (entry: string): Map<string, string[]> => {
  const seen = new Map<string, string[]>()
  const queue: Array<[string, string[]]> = [[entry, [rel(entry)]]]
  while (queue.length > 0) {
    const [file, chain] = queue.shift() as [string, string[]]
    if (seen.has(file)) continue
    seen.set(file, chain)
    for (const spec of loadedSpecifiersIn(fs.readFileSync(file, 'utf8'))) {
      const target = resolveSpecifier(file, spec)
      if (target && !seen.has(target)) queue.push([target, [...chain, rel(target)]])
    }
  }
  return seen
}

describe('the editor is not in the entry chunk', () => {
  it('no module the game loads at boot is under src/editor/', () => {
    const loaded = loadedFrom(ENTRY)
    const editor = [...loaded.entries()]
      .filter(([file]) => rel(file).startsWith('src/editor/'))
      .map(([, chain]) => chain.join(' -> '))
    expect(
      editor,
      'a static import puts the editor in the boot bundle — reach it with import(), ' +
        'or use `import type` for types (an inline `{ type X }` still loads the module)',
    ).toEqual([])
  })

  it('the walk is alive: it reaches the boot tree and the game', () => {
    // A walk that resolved nothing would pass the test above for ever.
    const files = new Set([...loadedFrom(ENTRY).keys()].map(rel))
    for (const f of [APP_ENTRY, 'src/game/flight.ts', 'src/render/hangar.ts']) {
      expect(files.has(f), f).toBe(true)
    }
  })

  it('and it can see the editor: counting TYPE edges too, the editor is reached', () => {
    // The premise that makes the first test mean something. The game does
    // name editor types, so a walk that follows `import type` reaches editor
    // files; the only thing standing between those and the bundle is that they
    // are types. If this goes to zero, the first test is no longer exercised.
    const withTypes = [...walkImports(ENTRY)].map((n) => rel(n.file))
    expect(withTypes.some((f) => f.startsWith('src/editor/'))).toBe(true)
  })

  it('and an inline `{ type X }` import is an edge, as verbatimModuleSyntax makes it', () => {
    const tsconfig = fs.readFileSync(path.join(REPO, 'tsconfig.json'), 'utf8')
    expect(tsconfig, 'the reason inline type imports count').toMatch(
      /"verbatimModuleSyntax":\s*true/,
    )
    const probe = [
      "import type { A } from './erased'",
      "import { type B } from './kept'",
      "export type { C } from './erased-too'",
      "export * from './re-exported'",
      "import './side-effect'",
      '// a side-effect import FOLLOWED by an ordinary one: the no-semicolon case',
      "import { d } from './after-side-effect'",
      "const lazy = () => import('./lazy')",
    ].join('\n')
    expect(loadedSpecifiersIn(probe).sort()).toEqual([
      './after-side-effect',
      './kept',
      './re-exported',
      './side-effect',
    ])
  })
})
