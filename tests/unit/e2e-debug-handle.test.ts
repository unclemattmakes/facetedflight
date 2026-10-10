// tests/unit/e2e-debug-handle.test.ts — an e2e spec may not reach for a member
// of `__ff2` / `__ff2perf` that no longer exists.
//
// ── The day this cost, and it was the same evening it was written ────────
//
// DEV-223 renamed `App.pauseRows()` to `App.pausePlate()`. The rename swept the
// call sites it could see and merged. **`git merge` reported no conflict and
// `pnpm check` came back green with a spec broken**: three tests in the XR
// checklist spec (since removed, DEV-900) would have died on
// `TypeError: w.__ff2.pauseRows is not a function` the next time anybody ran
// Playwright, which is not part of `pnpm check` and not part of CI (no GPU).
//
// Two things conspire, and neither is anybody's mistake:
//
//   1. **A cast is an assertion, not a check.** Every spec reaches the handle
//      through `globalThis as unknown as { __ff2: { … } }`, because a spec
//      cannot import `src/` (see `e2e-import-graph.test.ts` for what happens
//      when one tries). So a stale member name typechecks perfectly — the cast
//      *declares* the shape it wants and `tsc` obliges.
//   2. **The call site that breaks you may not exist in your tree.** The spec
//      that went stale arrived from another session's branch in the same merge
//      that did the renaming. A `grep` of your own checkout before renaming
//      would have found nothing wrong, and been right at the time.
//
// That is the DEV-number collision's shape in a different coat: a sweep of one
// checkout cannot see another session's work, and the merge that brings the two
// together is the quietest event in the sequence.
//
// ── Why a test and not a rule ────────────────────────────────────────────
//
// The rule version is *"grep the e2e specs across every ref and worktree before
// renaming an `App` member"*, which is correct, unenforceable, and needs the
// person renaming to know it. This runs in `pnpm check`, on the merged tree,
// which is the one moment both halves exist in the same place. CLAUDE.md's own
// corollary: *"the references are fixed" is a state that goes false again
// within the hour; "a wrong-case reference cannot exist" survives.* Prefer the
// invariant to the sweep.
//
// ── The typed accessor, and what it took over (TS-4) ─────────────────────
//
// `tests/e2e/fixtures/ff2.ts` exports the handle's TYPE (`Ff2Global`,
// `Ff2GlobalMaybe`, `Ff2PerfGlobal`, ...) as aliases of the declared `App` and
// `PerfSurface`, through type-only imports. A spec that casts `globalThis` to
// one of them has no literal for this guard to read, and needs none: `tsc`
// checks every member name and return shape against the interface itself, which
// is the check this file approximates with a grep. So the work is split on
// purpose, and the split is pinned below: the typed sites are `tsc`'s, the
// sites that still spell a literal are this guard's, and the last describe
// proves the aliases really are the declared types, because an alias that
// drifted to a hand-written shape would turn the typed sites back into
// assertions without anything going red.
//
// ── What it cannot see, stated rather than discovered ────────────────────
//
// It matches two things: a direct `__ff2.member` reach (or `__ff2?.member`), and the member names
// declared at the top level of a `__ff2: { … }` cast literal (which is how a
// spec that aliases the handle — `const app = w.__ff2; app.stage()` — names
// what it is about to use). It does **not** follow an alias whose members were
// never declared in a cast, and it does not understand destructuring. Both are
// possible to write and neither exists in `tests/e2e/` today; if one appears,
// this guard will be quietly weaker for that file rather than wrong for the
// rest. The honest summary: **it covers every spec in the tree, by two
// mechanisms, and it is a grep rather than a type system.**

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { appFileWith } from './helpers/app-source'
import { REPO } from './helpers/repo-root'
import { listTsWithDts } from './helpers/source-tree'

const E2E = path.join(REPO, 'tests', 'e2e')

/** Every `.ts` under `tests/e2e/`, fixtures included. */
const specFiles = (dir: string): string[] => listTsWithDts(dir)

/**
 * The member names an interface declares, one indent deep.
 *
 * Deliberately a regex over the source rather than a TypeScript AST walk: the
 * thing being guarded is a NAME, the interfaces are hand-written and flat, and
 * a parser dependency in a guard is a second thing that can break the guard.
 * If it stops matching, the assertion below that the set is non-empty fails
 * loudly instead of passing vacuously — which is the failure mode that matters
 * (trap 21: `assets:check` reporting "0/0 ready verified").
 */
const interfaceMembers = (source: string, name: string): string[] => {
  const block = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(source)
  if (block === null) return []
  return [
    ...(block[1] as string).matchAll(/^\s{2}(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[?(:]/gm),
  ].map((m) => m[1] as string)
}

/**
 * Top-level keys of the object literal that follows `<handle>:` in a cast.
 *
 * A balanced-brace scan, because the literals nest — `{ __ff2: { render: {
 * camera: { … } } } }` — and only the FIRST level names members of the handle.
 */
const castLiteralKeys = (source: string, handle: string): string[] => {
  const keys: string[] = []
  const opener = new RegExp(`\\b${handle}\\??\\s*:\\s*\\{`, 'g')
  for (const match of source.matchAll(opener)) {
    let depth = 0
    let at = (match.index ?? 0) + match[0].length - 1
    const start = at + 1
    for (; at < source.length; at += 1) {
      const ch = source[at]
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    const body = source.slice(start, at)
    // Only depth-zero keys of THIS literal.
    let level = 0
    for (let i = 0; i < body.length; i += 1) {
      const ch = body[i]
      if (ch === '{' || ch === '(' || ch === '[') level += 1
      else if (ch === '}' || ch === ')' || ch === ']') level -= 1
      else if (level === 0) {
        const rest = body.slice(i)
        const key = /^([A-Za-z_][A-Za-z0-9_]*)\s*\??\s*:/.exec(rest)
        if (key !== null && (i === 0 || /[\s{,;]/.test(body[i - 1] as string))) {
          keys.push(key[1] as string)
          i += (key[1] as string).length
        }
      }
    }
  }
  return keys
}

/** Every member of `handle` any e2e spec reaches for, with the files that do. */
const reached = (handle: string): Map<string, string[]> => {
  const out = new Map<string, string[]>()
  const direct = new RegExp(`${handle}\\??\\.([A-Za-z_][A-Za-z0-9_]*)`, 'g')
  for (const file of specFiles(E2E)) {
    const source = fs.readFileSync(file, 'utf8')
    const names = [
      ...[...source.matchAll(direct)].map((m) => m[1] as string),
      ...castLiteralKeys(source, handle),
    ]
    for (const name of names) {
      const seen = out.get(name) ?? []
      if (!seen.includes(file)) seen.push(file)
      out.set(name, seen)
    }
  }
  return out
}

const rel = (file: string): string => path.relative(REPO, file).replace(/\\/g, '/')

describe.each([
  // `App` is found wherever the app-split put it (APP-SPLIT phase 0), so this
  // oracle follows the interface rather than a file name.
  { handle: '__ff2', iface: 'App', source: () => appFileWith('export interface App {').file },
  { handle: '__ff2perf', iface: 'PerfSurface', source: () => 'src/boot/perf-surface.ts' },
])('$handle', ({ handle, iface, source: sourceOf }) => {
  const source = sourceOf()
  const declared = interfaceMembers(fs.readFileSync(path.join(REPO, source), 'utf8'), iface)
  const used = reached(handle)

  it(`can still find the ${iface} interface to compare against`, () => {
    // The guard's own liveness. If the interface is renamed or reformatted past
    // the regex, every comparison below would pass against an empty set — a
    // green gate measuring nothing, which is the one outcome worse than a red
    // one. Assert the oracle exists before trusting what it says.
    expect(declared.length, `no members parsed out of ${iface} in ${source}`).toBeGreaterThan(5)
  })

  it('finds at least one spec reaching for it, so the sweep is alive', () => {
    expect(
      used.size,
      `no e2e spec reaches ${handle}.* — has the handle been renamed?`,
    ).toBeGreaterThan(0)
  })

  it(`reaches only members ${iface} actually declares`, () => {
    const orphans = [...used.entries()]
      .filter(([name]) => !declared.includes(name))
      .map(([name, files]) => `${handle}.${name} — used by ${files.map(rel).join(', ')}`)
    // The message IS the deliverable: when this goes red somebody has renamed a
    // member, and the only useful thing to print is which specs still ask for
    // the old name. Playwright is not in `pnpm check` and not in CI, so this is
    // the only gate that will ever say so.
    expect(orphans, `e2e specs reach for ${handle} members that do not exist`).toEqual([])
  })
})

describe('the typed accessor in fixtures/ff2.ts is the declared handle type', () => {
  const ff2 = fs.readFileSync(path.join(E2E, 'fixtures', 'ff2.ts'), 'utf8')

  it('imports App and PerfSurface, type-only, from the files that declare them', () => {
    const app = /^import type \{ App \} from '([^']+)'$/m.exec(ff2)
    const perf = /^import type \{ PerfSurface \} from '([^']+)'$/m.exec(ff2)
    expect(app, 'ff2.ts no longer type-imports App').not.toBeNull()
    expect(perf, 'ff2.ts no longer type-imports PerfSurface').not.toBeNull()
    const declares = (spec: string, decl: string): boolean => {
      const file = path.resolve(path.dirname(path.join(E2E, 'fixtures', 'ff2.ts')), spec)
      return fs.readFileSync(`${file}.ts`, 'utf8').includes(decl)
    }
    expect(declares(app?.[1] as string, 'export interface App {')).toBe(true)
    expect(declares(perf?.[1] as string, 'export interface PerfSurface {')).toBe(true)
    // No value import of anything: the file may only ever carry erased edges.
    expect(ff2.match(/^import\s(?!type\s)/gm)).toBeNull()
  })

  it('binds every accessor alias to those types and to no hand-written shape', () => {
    const aliases = [...ff2.matchAll(/^export type (Ff2\w*) = (.+)$/gm)].map((m) => [m[1], m[2]])
    expect(aliases.length).toBeGreaterThanOrEqual(6)
    for (const [name, body] of aliases) {
      // Each is `App`, `PerfSurface`, or `{ __ff2(perf)(?): <one of those> }`.
      expect(body, `${name} is not defined through the declared types`).toMatch(
        /^(?:Ff2|Ff2Perf|App|PerfSurface|\{ __ff2(?:perf)?\??: (?:Ff2|Ff2Perf) \})$/,
      )
    }
  })

  it('has specs that use it, so the typed half of the split is alive', () => {
    const users = specFiles(E2E).filter(
      (f) =>
        !f.endsWith('ff2.ts') &&
        /\bFf2(?:Perf)?Global(?:Maybe)?\b/.test(fs.readFileSync(f, 'utf8')),
    )
    expect(users.length, 'no spec reaches the handle through the typed accessor').toBeGreaterThan(
      20,
    )
  })
})
