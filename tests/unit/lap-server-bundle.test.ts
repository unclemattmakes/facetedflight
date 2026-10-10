// tests/unit/lap-server-bundle.test.ts — what `functions/` can reach. DEV-372.
//
// Cloudflare builds `functions/` with its own bundler, on its own machine, at
// deploy time — nothing in `pnpm check` or `vite build` compiles it. So the
// failure this guards against would first appear as a broken deploy, or worse
// as a Function that bundles and then throws on its first request:
//
//   - `import.meta.glob` and `import.meta.env` are VITE's. `content/load-level.ts`
//     is built on the first, `content/asset-url.ts` on the second, and one
//     import edge from the server into `game/` or `content/` pulls them in.
//   - the renderer, three, the DOM: a Worker has none of them.
//   - a bare package import is a dependency the Pages build would have to
//     install and bundle; the server needs none, and should not grow one quietly.
//
// So this walks the import graph from every file under `functions/` — relative
// and `@/` imports, the way the bundler resolves them — and asserts the whole
// closure is `functions/`, `src/net/` minus its loader-side writer, `src/sim/`,
// `src/generated/`, JSON, and (DEV-851, the room judge) the content schemas and
// game rules a player's course is built with, never a loader. A DOM or clock ban on top, for the server's own
// files (`src/sim/` has `sim-purity-guard.test.ts`).

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO as ROOT } from './helpers/repo-root'
import { listTsWithDts as listTs } from './helpers/source-tree'

const rel = (p: string): string => path.relative(ROOT, p).split(path.sep).join('/')

/**
 * Code without its comments, by a scan that knows strings from comments. Two
 * regexes in either order get this wrong on these very files: a line comment
 * that mentions `functions/api/**` opens a "block comment" that eats the
 * imports below it, and a `//` inside a URL string is not a comment.
 */
const stripComments = (src: string): string => {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i] as string
    const next = src[i + 1]
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++
    } else if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end < 0 ? src.length : end + 2
    } else if (c === "'" || c === '"' || c === '`') {
      const start = i++
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1
      out += src.slice(start, ++i)
    } else {
      out += c
      i++
    }
  }
  return out
}

// The lookbehind: a JSON key spelled "from":"scatter" in generated DATA is not
// an import (DEV-851, when the judge first reached the prop library).
const SPECIFIER = /(?:(?<!["'])\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g

const resolve = (from: string, spec: string): string | null => {
  const base = spec.startsWith('@/')
    ? path.join(ROOT, 'src', spec.slice(2))
    : spec.startsWith('.')
      ? path.join(path.dirname(from), spec)
      : null
  if (!base) return null
  for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  throw new Error(`${rel(from)}: cannot resolve ${spec}`)
}

/** Every file the Functions reach, and every bare specifier on the way. */
const closure = (): { files: Set<string>; bare: string[] } => {
  const files = new Set<string>()
  const bare: string[] = []
  const queue = listTs(path.join(ROOT, 'functions'))
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (files.has(file)) continue
    files.add(file)
    if (!file.endsWith('.ts')) continue
    const code = stripComments(fs.readFileSync(file, 'utf8'))
    for (const m of code.matchAll(SPECIFIER)) {
      const spec = m[1] as string
      const target = resolve(file, spec)
      if (target) queue.push(target)
      else bare.push(`${rel(file)} -> ${spec}`)
    }
  }
  return { files, bare }
}

const ALLOWED = [
  /^functions\//,
  // `lap-courses-text.ts` builds the courses file through the level LOADER.
  /^src\/net\/(?!lap-courses-text\.ts$)/,
  /^src\/sim\//,
  /^src\/generated\//,
  /^content\/lap-courses\.json$/,
  // DEV-851: the room judge builds a PLAYER'S course itself (`net/room-course.ts`)
  // with the game's own expansion and rules code: the content schemas and the
  // game rules it reaches, but never a loader (`load-*.ts`, `import.meta.glob`)
  // nor `asset-url.ts` (`import.meta.env`). The bans below hold for all of it.
  /^src\/content\/(?!load-|asset-url\.ts$)/,
  /^src\/game\//,
  // A leaf of four numbers `edition-schema.ts` reads (its header says why).
  /^src\/render\/aperture\.ts$/,
  // The shipped missions a course is built on, and the files rules hash over.
  /^content\/levels\/[A-Za-z0-9_]+\.json$/,
  /^content\/editions\/[a-z]+\.json$/,
  /^content\/aircraft\/[a-z]+\.json$/,
]

/** The one file in the bundle that may hold browser code, as a string (DEV-592). */
const BROWSER_TEXT = 'src/net/privacy-script.ts'
const BROWSER_TEXT_SHAPE = /^\s*export const [A-Z_]+ = `(?:[^`$\\]|\$(?!\{))*`\s*$/

describe('the Functions bundle', () => {
  it('reaches the validator, the scorer and the courses, and nothing Vite-only', () => {
    const { files } = closure()
    const names = [...files].map(rel).sort()
    // Positive first: the walk found the server, or an empty closure would pass.
    expect(names).toContain('functions/api/laps.ts')
    expect(names).toContain('src/net/lap-validate.ts')
    expect(names).toContain('src/sim/ghost.ts')
    expect(names).toContain('content/lap-courses.json')
    expect(names).toContain(BROWSER_TEXT)
    expect(names.filter((n) => !ALLOWED.some((re) => re.test(n)))).toEqual([])
  })

  it('imports no package', () => {
    expect(closure().bare).toEqual([])
  })

  it('uses no Vite-only syntax, no DOM and no clock in the server files', () => {
    const offenders: string[] = []
    const bans: [string, RegExp][] = [
      ['import.meta.glob', /import\.meta\.glob/],
      ['import.meta.env', /import\.meta\.env/],
      ['document', /\bdocument\s*\./],
      ['window', /\bwindow\s*\./],
      ['navigator', /\bnavigator\s*\./],
      ['localStorage', /\blocalStorage\b/],
    ]
    for (const file of closure().files) {
      if (!file.endsWith('.ts')) continue
      const code = stripComments(fs.readFileSync(file, 'utf8'))
      // DEV-592: the /privacy page's button script, held as TEXT. Its one
      // export is a template literal with no interpolation, so nothing in it
      // runs on the server; anything else in that file is an offender.
      if (rel(file) === BROWSER_TEXT) {
        if (!BROWSER_TEXT_SHAPE.test(code))
          offenders.push(`${rel(file)}: not one plain string export`)
        continue
      }
      for (const [label, re] of bans) if (re.test(code)) offenders.push(`${rel(file)}: ${label}`)
      // The clock is read in `functions/` and passed in; nothing under src/ reads it.
      if (!rel(file).startsWith('functions/') && /\bDate\.now\s*\(/.test(code)) {
        offenders.push(`${rel(file)}: Date.now()`)
      }
    }
    expect(offenders).toEqual([])
  })
})
