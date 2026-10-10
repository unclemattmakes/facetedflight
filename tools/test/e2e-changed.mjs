#!/usr/bin/env node
// tools/test/e2e-changed.mjs: run the BEHAVIOUR e2e specs a change can reach.
//
// Matt, 2026-10-07: "our e2e testing feels excessive to me in terms of how long
// it takes and how much it hogs my machine." This is the narrow tier of the
// two-tier plan (docs/testing/TIERS.md): not the suite, not the @measure
// tier, only the behaviour specs that a diff touches, plus the e2e smoke set.
//
//   node tools/test/e2e-changed.mjs                      vs the merge base with main (else origin/main, else HEAD~1)
//   node tools/test/e2e-changed.mjs --base <ref>         vs another ref
//   node tools/test/e2e-changed.mjs --names              the selected spec names on one line (for gate scripts)
//   node tools/test/e2e-changed.mjs --list               print the selection (and why), run nothing
//   node tools/test/e2e-changed.mjs --rooms              the room/TV specs instead (they need the sidecar)
//   node tools/test/e2e-changed.mjs -- --workers 1 ...   everything after `--` goes to Playwright
//
// ── What "reach" means ───────────────────────────────────────────────────
//
// 1. IMPORT REACH. A spec is selected when a changed file is in its static
//    import graph (`import-graph.mjs`, the walker the tiered unit runner and
//    the e2e guard share), fixtures included, type-only imports left out.
// 2. NAME AFFINITY. A spec drives the whole game in a browser, and the game is
//    NOT in the spec's import graph: `src/render/hud.ts` changes and
//    `hud-upload-pixels.spec.ts` imports none of it. So a changed file under
//    `src/` or `content/` also selects the specs that share a distinctive word
//    with its file name or its directory (`src/editor/*` -> `editor-*`,
//    `hud.ts` -> `hud-*`). Crude, printed with its reason, and over-selecting
//    on purpose.
// 3. THE SMOKE SET (`pnpm e2e:smoke`) always runs, whatever the diff. It is the
//    floor under (1) and (2): it flies a mission.
//
// This is a selection, not a proof: a change that no spec names and no word
// links passes through. `pnpm e2e` (behaviour, every spec) and `pnpm e2e:all`
// (plus @measure, the release gate) are the answer to that, and the lead's
// batch gate runs them.
//
// The exit code is Playwright's own, worst of the runs; nothing here pipes it.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { REPO, rel, walkImports } from './import-graph.mjs'

const E2E = path.join(REPO, 'tests', 'e2e')
// Resolved the way Node would from the repo, so a worktree under .claude/worktrees
// finds the main checkout's install when it has none of its own.
const PLAYWRIGHT = createRequire(path.join(REPO, 'package.json')).resolve('@playwright/test/cli')

/** Specs that need the room sidecar and one worker (batch-gate.sh runs them under its own booking). */
const ROOM_SPECS = [
  'room-lobby',
  'room-share',
  'room-two-browsers',
  'room-results',
  'room-ships-perf',
  'room-watch',
  'rooms-off',
  'tv-camera',
  'tv-exhibition',
  'tv-links',
  'tv-live',
  'tv-panel',
]

/** The e2e smoke set: the same three tests `pnpm e2e:smoke` names. */
const SMOKE_FILES = ['boot', 'menu-screen', 'completion']
const SMOKE_GREP = 'boots, paints|boards you on confirm|it is on the board'

const GENERIC = new Set([
  'index',
  'types',
  'type',
  'constants',
  'schema',
  'state',
  'util',
  'utils',
  'helpers',
  'game',
  'sim',
  'render',
  'boot',
  'input',
  'content',
  'math',
  'main',
  'core',
  'base',
  'data',
  'test',
  'spec',
  'level',
  'levels',
  'generated',
  'common',
  'shared',
  'scene',
  'world',
  'mission',
  'missions',
  'src',
  'app',
  'flight',
  'ship',
  'camera',
  'light',
  'lights',
  'view',
  'menu',
])
const tokens = (s) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !GENERIC.has(t) && !/^\d+$/.test(t))

const args = process.argv.slice(2)
const dd = args.indexOf('--')
const mine = dd < 0 ? args : args.slice(0, dd)
const passthrough = dd < 0 ? [] : args.slice(dd + 1)
const has = (f) => mine.includes(f)
const after = (f) => {
  const i = mine.indexOf(f)
  return i >= 0 ? mine[i + 1] : undefined
}

const git = (...a) => {
  const r = spawnSync('git', a, { cwd: REPO, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}

/**
 * The base: --base, else the merge base with main (a builder's branch point),
 * then origin/main (main's unpushed commits), then HEAD~1. Never release: on
 * 2026-10-08 that base was a month of unreleased work, so every builder's
 * "narrow" run selected all 413 behaviour tests and held the GPU for 45 min.
 */
const baseRef = () => {
  const given = after('--base') ?? mine.find((a) => !a.startsWith('-'))
  if (given) return git('rev-parse', given) ?? given
  const head = git('rev-parse', 'HEAD')
  for (const r of ['main', 'origin/main']) {
    const mb = git('merge-base', 'HEAD', r)
    if (mb && mb !== head) return mb
  }
  return git('rev-parse', 'HEAD~1') ?? 'HEAD'
}

const base = baseRef()
const changed = new Set()
for (const out of [
  git('diff', '--name-only', base),
  git('ls-files', '--others', '--exclude-standard'),
]) {
  for (const line of (out ?? '').split('\n')) if (line.trim()) changed.add(line.trim())
}
const changedAbs = new Map([...changed].map((c) => [path.join(REPO, c), c]))

/** A spec file whose every top-level test/describe carries @measure collects nothing by default. */
const measureOnly = (src) => {
  const tops = [...src.matchAll(/^test(?:\.describe)?\((['"`])(.*?)\1/gm)].map((m) => m[2])
  return tops.length > 0 && tops.every((t) => t.includes('@measure'))
}

const specs = fs
  .readdirSync(E2E)
  .filter((f) => f.endsWith('.spec.ts'))
  .map((f) => ({ name: f.replace('.spec.ts', ''), file: path.join(E2E, f) }))
  .filter((s) => !measureOnly(fs.readFileSync(s.file, 'utf8')))

const wantRooms = has('--rooms')
const pool = specs.filter((s) => ROOM_SPECS.includes(s.name) === wantRooms)

const picked = new Map() // name -> reason
for (const s of pool) {
  for (const { file, chain } of walkImports(s.file, { valueOnly: true })) {
    const c = changedAbs.get(file)
    if (c) {
      picked.set(s.name, `imports ${c}${chain.length > 2 ? ` (via ${rel(chain[1])})` : ''}`)
      break
    }
  }
}
const words = new Map() // token -> changed file
for (const c of changed) {
  if (!/^(src|content)\//.test(c)) continue
  for (const t of tokens(c.replace(/\.[a-z]+$/, ''))) if (!words.has(t)) words.set(t, c)
}
for (const s of pool) {
  if (picked.has(s.name)) continue
  const hit = tokens(s.name).find((t) => words.has(t))
  if (hit) picked.set(s.name, `shares "${hit}" with ${words.get(hit)}`)
}

const smoke = wantRooms ? [] : SMOKE_FILES
const specNames = [...picked.keys()].sort()
const smokeExtra = smoke.filter((n) => !picked.has(n))

if (has('--names')) {
  process.stdout.write(`${specNames.join(' ')}
`)
  process.exit(0)
}

const say = (m) => process.stdout.write(`${m}\n`)
say(`e2e:changed vs ${base.slice(0, 10)}: ${changed.size} changed files`)
if (
  changed.has('playwright.config.ts') ||
  changed.has('vite.config.ts') ||
  changed.has('package.json')
) {
  say('note: a config or package change reaches every spec; consider pnpm e2e')
}
for (const n of specNames) say(`  ${n.padEnd(28)} ${picked.get(n)}`)
if (smokeExtra.length) say(`  smoke set: ${smokeExtra.join(', ')} (always)`)
if (specNames.length === 0 && smokeExtra.length === 0) say('  nothing selected')
if (has('--list')) process.exit(0)

const pw = (files, extra) => {
  const r = spawnSync(process.execPath, [PLAYWRIGHT, 'test', ...files, ...extra, ...passthrough], {
    cwd: REPO,
    stdio: 'inherit',
  })
  return r.status ?? 1
}

// Smoke FIRST: if the game does not boot or finish a mission there is nothing to
// learn from the rest, and Playwright's .last-run.json (what `--last-failed`
// re-runs) then holds the selection's reds, not the smoke's.
let rc = 0
if (smokeExtra.length > 0) {
  rc = pw(
    smokeExtra.map((n) => `${n}.spec.ts`),
    ['--grep', SMOKE_GREP],
  )
  if (rc !== 0) process.exit(rc)
}
if (specNames.length > 0) {
  rc = pw(
    specNames.map((n) => `${n}.spec.ts`),
    wantRooms ? ['--workers', '1'] : [],
  )
}
process.exit(rc)
