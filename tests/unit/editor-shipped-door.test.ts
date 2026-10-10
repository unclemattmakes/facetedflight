// tests/unit/editor-shipped-door.test.ts — the shipped-mission door is DEV
// ONLY. DEV-540 (plan/SHIPPED-COURSE-EDITS.md §4.3).
//
// The release build ships the course editor (D36 / DEV-470); it must NOT ship
// the door that edits 2016's missions: a player has no repo to write an
// override into, and a list offering the thirteen as editable invites remixes
// of 2016's courses. The door is shut the one way that cannot drift: every
// path into it sits behind `import.meta.env.DEV`, which Vite writes as a
// literal `false` in a production build, so the branch — and the dynamic
// `import()` in it, and so the chunk — is dropped. DEVIATIONS DEV-540 records
// the check on `dist/` itself; this holds the SOURCE to the shape that makes
// that true, so a static import added later fails here, in CI, and not in a
// build nobody greps.
//
// Checked as text, as `editor-desk.test.ts` checks the desk's laziness.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { appFiles, appSource } from './helpers/app-source'
import { REPO } from './helpers/repo-root'
import { walkTree } from './helpers/source-tree'

const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), 'utf8')

/** Every file under `src/`, relative, forward slashes. */
const sources = (): string[] =>
  walkTree(path.join(REPO, 'src'), { match: (name) => /\.(ts|mts|js|mjs)$/.test(name) }).map((p) =>
    path.relative(REPO, p).split(path.sep).join('/'),
  )

/**
 * The text from the `if (` that opens the innermost block around `index` —
 * found by walking back to the first unmatched `{` — up to that brace.
 */
const guardOf = (text: string, index: number): string => {
  let depth = 0
  for (let i = index; i >= 0; i--) {
    const c = text[i]
    if (c === '}') depth++
    else if (c === '{') {
      if (depth === 0) {
        const head = text.slice(text.lastIndexOf('\n', i) + 1, i)
        return head
      }
      depth--
    }
  }
  return ''
}

describe('DEV-540: the shipped-mission door is behind import.meta.env.DEV', () => {
  it('nothing imports the shipped desk or its list STATICALLY but the list itself', () => {
    const statics: string[] = []
    for (const file of sources()) {
      const text = read(file)
      for (const m of text.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gms)) {
        const spec = m[1] as string
        const target = spec.startsWith('.')
          ? path.posix.join(path.posix.dirname(file), spec)
          : spec.replace('@/', 'src/')
        if (/^src\/editor\/desk\/shipped(-door)?$/.test(target) && !/^import type\b/.test(m[0])) {
          statics.push(`${file}: ${spec}`)
        }
      }
    }
    // The list opens the desk's URL helper; both are reached only dynamically.
    expect(statics).toEqual(['src/editor/desk/shipped-door.ts: ./shipped'])
  })

  it('app.ts reaches the shipped desk only by a dynamic import inside a DEV branch', () => {
    // Over every file of the boot tree (APP-SPLIT phase 0), each searched on
    // its own: `guardOf` and the 400-character look-back must not run across
    // the boundary between two files.
    const tree = appFiles()
    const imports = tree.flatMap((f) =>
      [...f.text.matchAll(/import\('@\/editor\/desk\/shipped'\)/g)].map((m) => ({
        text: f.text,
        at: m.index ?? 0,
      })),
    )
    expect(imports.length).toBe(1)
    const only = imports[0] as { text: string; at: number }
    expect(guardOf(only.text, only.at)).toMatch(/if \(import\.meta\.env\.DEV &&/)
    // And the switch itself is null outside a dev server.
    expect(appSource()).toMatch(
      /const SHIPPED_AT_BOOT: string \| null = import\.meta\.env\.DEV \? params\.get\('shipped'\) : null/,
    )
    // Every read of it is behind the same literal, so a build folds each one.
    // An import statement that NAMES it is not a read (APP-SPLIT 1b moved the
    // declaration to `boot/app/pins.ts`, and `boot/app.ts` imports it), so
    // each file's import statements are blanked first — to spaces of the same
    // length, so the 400-character look-back below still measures the file.
    const blankImports = (text: string): string =>
      text.replace(/^import\s[^;'"]*?from\s+'[^']+'/gm, (m) => m.replace(/[^\n]/g, ' '))
    for (const { text } of tree) {
      const app = blankImports(text)
      for (const m of app.matchAll(/SHIPPED_AT_BOOT/g)) {
        const line = app.slice(app.lastIndexOf('\n', m.index) + 1, app.indexOf('\n', m.index))
        const inDoc = /^\s*(\*|\/\/)/.test(line)
        if (inDoc || /const SHIPPED_AT_BOOT/.test(line)) continue
        const near = app.slice(Math.max(0, (m.index ?? 0) - 400), m.index)
        expect(near, `SHIPPED_AT_BOOT read without a DEV guard near: ${line.trim()}`).toMatch(
          /import\.meta\.env\.DEV/,
        )
      }
    }
  })

  it('the player desk reaches the list only by a dynamic import inside a DEV branch', () => {
    const desk = read('src/editor/desk/index.ts')
    const at = [...desk.matchAll(/import\('\.\/shipped-door'\)/g)].map((m) => m.index ?? 0)
    expect(at.length).toBe(1)
    expect(guardOf(desk, at[0] as number)).toMatch(/if \(import\.meta\.env\.DEV\)/)
  })
})

describe('DEV-540: a worktree’s dev server watches its own tree (DEV-255, anchored)', () => {
  it('the watch-ignore names THIS checkout’s .claude/worktrees, not every path through one', () => {
    const config = read('vite.config.ts')
    // The old pattern matched every file of a server started inside a worktree.
    expect(config).not.toMatch(/ignored:\s*\[\s*'\*\*\/\.claude\/worktrees\/\*\*'\s*\]/)
    expect(config).toMatch(/`\$\{WATCH_ROOT\}\/\.claude\/worktrees\/\*\*`/)
    expect(config).toMatch(/const WATCH_ROOT = REPO_ROOT\.replaceAll\('\\\\', '\/'\)/)
  })
})
