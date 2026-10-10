// tests/unit/making-of-imports.test.ts: a toy imports the game, never boots it,
// and never re-creates it. DEV-508 (docs/plan/MAKING-OF.md §2.3).
//
// The site's whole premise is that its demos run the game's own modules, so a
// sim change moves the toy in the same commit. Three ways to lose that, each a
// failure here:
//
//   1. a toy reaches a module that boots the game (`boot/app`, `main`), the
//      sim barrel (`sim/index` re-exports ~21k lines of provenance), or a
//      `content/load-*.ts` (they use `import.meta.glob` and fetch through the
//      game's boot);
//   2. anything a making-of file can reach uses `import.meta.glob`, which the
//      Playwright loader does not have (e2e-import-graph.test.ts, the same
//      lesson);
//   3. a toy declares, at top level, something the sim or render layer already
//      exports: the cheapest signal that somebody wrote a second copy.
//
// And no making-of file fetches an asset directly: the only door is
// `toy-asset.ts`, which is not built yet, so for now the answer is none.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO, rel, walkImports } from '../../tools/test/import-graph.mjs'

const ROOT = path.join(REPO, 'src', 'making-of')

const filesUnder = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? filesUnder(path.join(dir, e.name))
        : e.name.endsWith('.ts')
          ? [path.join(dir, e.name)]
          : [],
    )

/** Source lines that are not whole-line comments: enough to read code, and unable to eat a span. */
const codeCache = new Map<string, string>()
const codeLines = (file: string): string => {
  let code = codeCache.get(file)
  if (code === undefined) {
    code = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n')
    codeCache.set(file, code)
  }
  return code
}

/**
 * Every module any making-of file reaches, once, with the first chain that
 * reached it. The toys share most of their graph (the sim, the content
 * schema), so walking it per entry and reading each file per entry is what
 * made this suite time out once the lap-server toy pulled in `net/`.
 */
/** A static walk of the toys' whole graph. Milliseconds on a quiet box, seconds on a busy one. */
const WALK_TIMEOUT_MS = 60_000

let reachedCache: Map<string, string[]> | null = null
const reached = (): Map<string, string[]> => {
  if (reachedCache) return reachedCache
  const out = new Map<string, string[]>()
  for (const file of makingOf) {
    for (const node of walkImports(file)) {
      if (!out.has(node.file)) out.set(node.file, node.chain)
    }
  }
  reachedCache = out
  return out
}

const FORBIDDEN: readonly [RegExp, string][] = [
  [/^src\/boot\/app\.ts$/, 'boots the whole game'],
  [/^src\/main\.ts$/, 'boots the whole game'],
  [/^src\/sim\/index\.ts$/, 'the sim barrel re-exports the provenance table; import the module'],
  [/^src\/content\/load-[^/]+\.ts$/, 'load-*.ts use import.meta.glob and the game fetch path'],
]

const makingOf = filesUnder(ROOT)
const isToy = (f: string) => f.includes(`${path.sep}toys${path.sep}`)

describe('making-of imports', () => {
  it('there are toys to guard (the sweep is not vacuous)', () => {
    expect(makingOf.length).toBeGreaterThan(5)
    expect(makingOf.some(isToy)).toBe(true)
  })

  it(
    'nothing a making-of file reaches boots the game or the loaders',
    () => {
      const hits: string[] = []
      for (const [file, chain] of reached()) {
        const r = rel(file)
        for (const [re, why] of FORBIDDEN) {
          if (re.test(r)) hits.push(`${chain.map(rel).join(' -> ')}: ${why}`)
        }
      }
      expect(hits).toEqual([])
    },
    WALK_TIMEOUT_MS,
  )

  it(
    'nothing a making-of file reaches uses import.meta.glob',
    () => {
      const hits: string[] = []
      for (const [file, chain] of reached()) {
        if (/import\.meta\.glob/.test(codeLines(file))) hits.push(chain.map(rel).join(' -> '))
      }
      expect(hits).toEqual([])
    },
    WALK_TIMEOUT_MS,
  )

  it('a toy declares nothing the sim or render layer already exports', () => {
    const exported = new Map<string, string>()
    for (const layer of ['sim', 'render']) {
      for (const f of filesUnder(path.join(REPO, 'src', layer))) {
        for (const m of fs
          .readFileSync(f, 'utf8')
          .matchAll(/^export (?:const|function|class) (\w+)/gm)) {
          if (m[1]) exported.set(m[1], rel(f))
        }
      }
    }
    const dupes: string[] = []
    for (const f of makingOf.filter(isToy)) {
      for (const m of codeLines(f).matchAll(/^(?:export )?(?:const|function|class) (\w+)/gm)) {
        const name = m[1] ?? ''
        const real = exported.get(name)
        if (real) dupes.push(`${rel(f)} declares ${name}, which ${real} already exports: import it`)
      }
    }
    expect(dupes).toEqual([])
  })

  it('no making-of file fetches an asset itself', () => {
    const hits = makingOf.flatMap((f) =>
      /\b(assetUrl|fetch|GLTFLoader|TextureLoader)\s*\(/.test(codeLines(f))
        ? [`${rel(f)} reaches for an asset directly; the only door is toy-asset.ts (DEV-508)`]
        : [],
    )
    expect(hits).toEqual([])
  })
})

// DEV-509: the world toys light a scene with the game's own recipe, so the
// modules that hold it must stay importable without booting the game. The
// switches they obey arrive as arguments; `pins.ts` reads the URL and pulls in
// the loaders, and a toy that reached it would fail the guards above.
describe('the world-kit modules a toy may import', () => {
  for (const entry of ['src/boot/app/lighting.ts', 'src/boot/app/horizon.ts']) {
    it(
      `${entry} reaches neither pins.ts nor a loader nor import.meta.glob`,
      () => {
        const hits: string[] = []
        for (const node of walkImports(path.join(REPO, entry))) {
          const r = rel(node.file)
          if (
            r === 'src/boot/app/pins.ts' ||
            /^src\/content\/load-/.test(r) ||
            /import\.meta\.glob/.test(codeLines(node.file))
          ) {
            hits.push(node.chain.map(rel).join(' -> '))
          }
        }
        expect(hits).toEqual([])
      },
      WALK_TIMEOUT_MS,
    )
  }
})
