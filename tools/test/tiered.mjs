#!/usr/bin/env node
// tools/test/tiered.mjs — run the wide tests first; hone in only when they fail.
//
// Matt, 2026-09-15: "instead of always running a ton of tests, let's run a
// suite that can test multiple things at once, but if things break, it goes to
// the individual tests to hone in."
//
//   node tools/test/tiered.mjs            smoke; stop if green
//   node tools/test/tiered.mjs --full     smoke, then the whole suite
//   node tools/test/tiered.mjs --changed [ref]
//                                         vitest's own "what did I touch" mode
//   node tools/test/tiered.mjs --list     print the smoke files and their widths
//
// ── The three steps ──────────────────────────────────────────────────────
//
// 1. SMOKE. `tests/smoke.list.json` names a handful of wide tests — each one
//    reaches dozens of `src/` modules and most of them fly the game — and
//    they run in a few seconds. Green means the game still runs; it does not
//    mean every narrow claim still holds, which is what `pnpm check` is for.
//
// 2. HONE-IN, only when smoke is red. For each failing smoke file the runner
//    walks its static import graph (`import-graph.mjs`, the same walker the
//    e2e guard uses), takes every `src/` module it can reach, and runs every
//    unit test that reaches any of those modules. Then it prints the failures
//    NARROWEST FIRST — a test that reaches six modules and is red has pinned
//    the break to six modules — and lists the modules every failing test has
//    in common, rarest first, as suspects.
//
//    vitest 4 has `vitest related <src file>`, which does this selection
//    through Vite's real module graph, and it works here (the `@/` alias
//    resolves). It is not used for the hone-in because it takes SOURCE files
//    and the runner has TEST files: it would have to hand over the whole
//    reachable set, which selects most of the suite either way, and it cannot
//    rank. It is exposed as `pnpm test:related <src file>` for the by-hand case.
//
// 3. FULL is `pnpm check` and is unchanged. CI runs it. So does anyone about to
//    land something.
//
// ── Honesty rules ────────────────────────────────────────────────────────
//
// The exit code is vitest's own from the last run that mattered, never a
// pipe's (CLAUDE.md, "read the exit code of the command you care about"). A
// smoke failure exits 1 even after the hone-in, whatever the hone-in found.
// Nothing here changes what a test does: the same files, the same config, the
// same code paths as `pnpm test` — this only chooses WHICH files, and when.
//
// Zero dependencies; plain Node. The JSON reporter output goes to the OS temp
// directory, not the repo.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { REPO, reachableSrc, rel, unitTestFiles } from './import-graph.mjs'

const VITEST = path.join(REPO, 'node_modules', 'vitest', 'vitest.mjs')
const LIST = path.join(REPO, 'tests', 'smoke.list.json')

const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const argAfter = (flag) => {
  const i = args.indexOf(flag)
  if (i < 0) return undefined
  const next = args[i + 1]
  return next && !next.startsWith('--') ? next : null
}

const say = (msg) => process.stdout.write(`${msg}\n`)
const rule = (title) => say(`\n── ${title} ${'─'.repeat(Math.max(0, 70 - title.length))}`)
const seconds = (t0) => `${((Date.now() - t0) / 1000).toFixed(1)} s`

/** The smoke list, with each entry's absolute path and width. */
const smokeList = () => {
  const list = JSON.parse(fs.readFileSync(LIST, 'utf8'))
  return list.files.map((e) => {
    const abs = path.join(REPO, e.file)
    return { ...e, abs, width: fs.existsSync(abs) ? reachableSrc(abs).size : -1 }
  })
}

/**
 * Run vitest once. `stdio: inherit` so the reporter's own output is what the
 * user sees; the JSON copy is for the runner. Returns vitest's exit status and
 * the parsed report (or null if it produced none — a crash, not a failure).
 */
const runVitest = (label, vitestArgs, reporter = 'default') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff2-tiered-'))
  const json = path.join(dir, `${label}.json`)
  const t0 = Date.now()
  const result = spawnSync(
    process.execPath,
    [
      VITEST,
      'run',
      ...vitestArgs,
      `--reporter=${reporter}`,
      '--reporter=json',
      `--outputFile.json=${json}`,
    ],
    { cwd: REPO, stdio: 'inherit' },
  )
  const status = result.status ?? 1
  let report = null
  try {
    report = JSON.parse(fs.readFileSync(json, 'utf8'))
  } catch {
    report = null
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // The temp dir is the OS's problem.
  }
  return { status, report, elapsed: seconds(t0) }
}

/** Test files the report marks failed, absolute, with their failing test names. */
const failuresOf = (report) => {
  if (!report) return []
  return report.testResults
    .filter((f) => f.status !== 'passed' && f.status !== 'pending' && f.status !== 'skipped')
    .map((f) => ({
      file: path.resolve(f.name),
      tests: f.assertionResults
        .filter((a) => a.status === 'failed')
        .map((a) => ({
          name: a.fullName,
          message: (a.failureMessages?.[0] ?? '').split('\n')[0] ?? '',
        })),
      // A file that failed with no failed assertion failed to LOAD — a syntax
      // error, a throw at import — and `message` carries vitest's reason.
      message: (f.message ?? '').split('\n')[0] ?? '',
    }))
}

// ── --list ───────────────────────────────────────────────────────────────

if (has('--list')) {
  const list = smokeList()
  const union = new Set()
  rule('smoke tier')
  for (const e of list) {
    say(`${String(e.width).padStart(4)}  ${e.file}`)
    if (e.width >= 0) for (const m of reachableSrc(e.abs)) union.add(m)
  }
  say(`\n${list.length} files; ${union.size} distinct src/ modules between them`)
  process.exit(0)
}

// ── --changed ────────────────────────────────────────────────────────────

if (has('--changed')) {
  const ref = argAfter('--changed')
  rule(`changed${ref ? ` since ${ref}` : ''}`)
  const { status, elapsed } = runVitest('changed', ref ? ['--changed', ref] : ['--changed'])
  say(`\nchanged: exit ${status} in ${elapsed}`)
  process.exit(status)
}

// ── smoke ────────────────────────────────────────────────────────────────

const smoke = smokeList()
const missing = smoke.filter((e) => e.width < 0)
if (missing.length > 0) {
  rule('smoke list is broken')
  for (const e of missing) say(`  not on disk: ${e.file}`)
  say('fix tests/smoke.list.json (tests/unit/smoke-list.test.ts holds it to this)')
  process.exit(2)
}

rule(`smoke: ${smoke.length} files`)
const smokeRun = runVitest(
  'smoke',
  smoke.map((e) => e.file),
)
say(`\nsmoke: exit ${smokeRun.status} in ${smokeRun.elapsed}`)

if (smokeRun.status === 0) {
  if (!has('--full')) {
    say('smoke is green. `pnpm check` for the full tier, or `--full` here.')
    process.exit(0)
  }
  rule('full')
  const full = runVitest('full', [])
  say(`\nfull: exit ${full.status} in ${full.elapsed}`)
  process.exit(full.status)
}

// ── hone-in ──────────────────────────────────────────────────────────────

const smokeFailures = failuresOf(smokeRun.report)
if (smokeFailures.length === 0) {
  // Red with nothing to point at: vitest itself broke (a config error, a
  // crashed worker). There is nothing to hone into; the exit code stands.
  rule('smoke failed without a report')
  say('vitest exited non-zero and produced no failing test file. Read its output above.')
  process.exit(smokeRun.status)
}

const smokeSet = new Set(smoke.map((e) => e.abs))
const widths = new Map(unitTestFiles().map((f) => [f, reachableSrc(f)]))

rule('hone-in')
const suspectsByFile = new Map()
const candidates = new Set()
for (const failure of smokeFailures) {
  const reach = widths.get(failure.file) ?? reachableSrc(failure.file)
  suspectsByFile.set(failure.file, reach)
  say(`${rel(failure.file)} is red (${reach.size} modules on the line)`)
  for (const t of failure.tests) say(`    ${t.name}\n      ${t.message}`)
  if (failure.tests.length === 0 && failure.message) say(`    ${failure.message}`)
  for (const [file, set] of widths) {
    if (smokeSet.has(file)) continue
    for (const m of set) {
      if (reach.has(m)) {
        candidates.add(file)
        break
      }
    }
  }
}

const ordered = [...candidates].sort((a, b) => widths.get(a).size - widths.get(b).size)
say(
  `\n${ordered.length} unit files share a module with the red smoke test(s); running them, narrowest first`,
)

const hone = runVitest(
  'hone',
  ordered.map((f) => rel(f)),
  'dot',
)
say(`\nhone-in: exit ${hone.status} in ${hone.elapsed}`)

const honeFailures = failuresOf(hone.report).sort(
  (a, b) => (widths.get(a.file)?.size ?? 0) - (widths.get(b.file)?.size ?? 0),
)

rule('narrowed')
if (honeFailures.length === 0) {
  say('No narrow test is red. The break is in something only the smoke test exercises —')
  say('start from its failing assertion above; the modules it reaches are the search space.')
} else {
  say('Failing files, narrowest first. The top of this list is where to look.\n')
  for (const f of honeFailures) {
    const w = widths.get(f.file)?.size ?? '?'
    say(`${String(w).padStart(4)}  ${rel(f.file)}`)
    for (const t of f.tests) say(`        ${t.name}\n          ${t.message}`)
    if (f.tests.length === 0 && f.message) say(`        ${f.message}`)
  }

  // Suspects: modules EVERY red test can reach, rarest first. A module that
  // every test in the suite imports (constants, vec3) is always in the
  // intersection and never the answer, so it sinks to the bottom.
  const redSets = [
    ...honeFailures.map((f) => widths.get(f.file)),
    ...suspectsByFile.values(),
  ].filter(Boolean)
  const first = redSets[0]
  const common = [...first].filter((m) => redSets.every((s) => s.has(m)))
  const reachCount = (m) => [...widths.values()].filter((s) => s.has(m)).length
  common.sort((a, b) => reachCount(a) - reachCount(b))
  say(`\nModules reached by EVERY red test (${common.length}), rarest first:`)
  for (const m of common.slice(0, 12))
    say(`  ${String(reachCount(m)).padStart(4)} tests reach  ${m}`)
}

process.exit(1)
