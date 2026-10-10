#!/usr/bin/env node
// e2e-baseline.mjs — the full Playwright suite at a git ref, reduced to one
// verdict per test, and a spec-by-spec comparison of two such records.
//
// APP-SPLIT §5 phase 0 step 5 and §6 rule 7: CI does not run e2e, so a
// recorded full run is the whole regression gate for the app.ts split. A
// number ("312 passed") cannot be compared to another number and say WHICH
// test moved; this keeps every test's verdict so `compare` can.
//
//   node tools/test/e2e-baseline.mjs run --ref <git-ref> --out <file.json> [--port N] [--keep] [-- <playwright args>]
//   node tools/test/e2e-baseline.mjs reduce <playwright-report.json> --out <file.json>
//   node tools/test/e2e-baseline.mjs compare <before.json> <after.json> [--md]
//
// `run` never touches the checkout it is started from. It makes a DETACHED
// worktree of the ref under the main checkout's `.claude/worktrees/` (which
// the main checkout's dev server does not watch, DEV-255/DEV-540), installs
// that ref's own dependencies, links the main checkout's `public/` into it
// (one asset tree, as `tools/agent/hydrate.ps1` does), refuses to go on unless
// `assets:check --verify-hashes` passes THERE, and runs the suite with the
// JSON reporter. The worktree is removed afterwards unless `--keep`, links
// first and without following any (`removeTreeSafely`), and a folder an
// earlier run failed to remove is cleared before the next run of that ref.
//
// Things it deliberately does NOT do — see docs/plan/APP-SPLIT-BASELINE.md:
//   * take the GPU lease (`tools/agent/gpu.sh` is bash and machine-specific;
//     the agent running this takes it around the call);
//   * change anything about the build. Every env var it sets is one
//     `playwright.config.ts` already reads (`E2E_PORT`), plus the JSON
//     reporter's output path. CLAUDE.md: the harness may do something extra,
//     the game may not be different.
//
// Exit codes: `run` 0 once a record is written, whatever the suite said (a
// red test is data, not an error), 1 when no record could be written;
// `compare` 0 when nothing regressed, 1 when something did; 2 bad invocation.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** The record's format. Bump when a field changes meaning. */
export const BASELINE_VERSION = 1

/** SGR colour codes. Built from the code point, which biome's control-character rule asks for. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const stripAnsi = (s) => s.replace(ANSI, '')

/** The first line of a Playwright error, without colour codes, capped. */
export const firstErrorLine = (result) => {
  const message = result?.error?.message ?? result?.errors?.[0]?.message
  if (typeof message !== 'string') return null
  const line = stripAnsi(message)
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  return line === undefined ? null : line.slice(0, 300)
}

/** Playwright's per-test status, in this record's words. */
const VERDICT = { expected: 'passed', unexpected: 'failed', flaky: 'flaky', skipped: 'skipped' }

/**
 * One verdict per test out of Playwright's JSON report.
 *
 * The key is project › file › describe titles › test title. The LINE is not
 * in it: a move-only slice does not touch a spec, but a merge from `main` can
 * shift a test down a file, and a key that moved would read as one test
 * removed and another added. Two tests with one title in one describe (legal
 * in Playwright) get `#2`, `#3` in file order.
 */
export const reduceReport = (report) => {
  const tests = {}
  const walk = (suite, file, describes) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const base = [test.projectName ?? '', file, ...describes, spec.title].join(' › ')
        let key = base
        for (let n = 2; key in tests; n++) key = `${base} #${n}`
        const results = test.results ?? []
        const verdict = VERDICT[test.status] ?? 'failed'
        // A failed test's last attempt carries its error; a flaky one's last
        // attempt PASSED, so its error is on the last attempt that did not.
        const failing = results.filter((r) => r.status !== 'passed' && r.status !== 'skipped')
        tests[key] = {
          verdict,
          line: spec.line ?? null,
          attempts: results.length,
          ms: Math.round(results.reduce((sum, r) => sum + (r.duration ?? 0), 0)),
          error:
            verdict === 'failed' || verdict === 'flaky'
              ? firstErrorLine(failing[failing.length - 1])
              : null,
        }
      }
    }
    for (const child of suite.suites ?? []) walk(child, file, [...describes, child.title])
  }
  for (const fileSuite of report.suites ?? []) {
    walk(fileSuite, fileSuite.file ?? fileSuite.title, [])
  }
  const sorted = Object.fromEntries(
    Object.keys(tests)
      .sort()
      .map((k) => [k, tests[k]]),
  )
  return { tests: sorted, totals: totalsOf(sorted) }
}

/** How many tests landed in each verdict. */
export const totalsOf = (tests) => {
  const totals = { tests: 0, passed: 0, failed: 0, flaky: 0, skipped: 0 }
  for (const t of Object.values(tests)) {
    totals.tests++
    totals[t.verdict]++
  }
  return totals
}

/**
 * Spec-by-spec, BEFORE against AFTER.
 *
 * What fails the gate (`regressed`), each because a move-only slice cannot
 * legitimately produce it:
 *   - passed → failed;
 *   - passed → skipped (AGENT-NOTES §2: "skipped must not move" — an
 *     unhydrated tree reads green with tests quietly skipped);
 *   - a test that passed BEFORE and is absent AFTER.
 * What is reported and does not fail it: flaky either side (a retry already
 * ran; one record cannot say more), failed → passed, failed → failed with a
 * different first line, and tests that only exist AFTER.
 */
export const compareBaselines = (before, after) => {
  const a = before.tests
  const b = after.tests
  const out = {
    regressed: [],
    flakyToFailed: [],
    becameFlaky: [],
    fixed: [],
    stillFailing: [],
    skipMoved: [],
    removed: [],
    added: [],
  }
  for (const [key, was] of Object.entries(a)) {
    const now = b[key]
    if (now === undefined) {
      out.removed.push({ key, was: was.verdict })
      if (was.verdict === 'passed')
        out.regressed.push({ key, was: 'passed', now: 'absent', error: null })
      continue
    }
    const pair = `${was.verdict}>${now.verdict}`
    if (pair === 'passed>failed' || pair === 'passed>skipped') {
      out.regressed.push({ key, was: was.verdict, now: now.verdict, error: now.error })
    } else if (pair === 'flaky>failed') {
      out.flakyToFailed.push({ key, error: now.error })
    } else if (now.verdict === 'flaky' && was.verdict !== 'flaky') {
      out.becameFlaky.push({ key, was: was.verdict, error: now.error })
    } else if (was.verdict === 'failed' && (now.verdict === 'passed' || now.verdict === 'flaky')) {
      out.fixed.push({ key, now: now.verdict })
    } else if (pair === 'failed>failed') {
      out.stillFailing.push({ key, was: was.error, now: now.error })
    }
    if ((was.verdict === 'skipped') !== (now.verdict === 'skipped') && pair !== 'passed>skipped') {
      out.skipMoved.push({ key, was: was.verdict, now: now.verdict })
    }
  }
  for (const key of Object.keys(b)) if (!(key in a)) out.added.push({ key, now: b[key].verdict })
  return out
}

/** The comparison as text, or as Markdown for the APP-SPLIT progress log. */
export const formatComparison = (before, after, diff, { md = false } = {}) => {
  const lines = []
  const head = (r) =>
    `${r.meta?.sha?.slice(0, 9) ?? '?'} (${r.meta?.ref ?? '?'}): ${r.totals.passed} passed, ${r.totals.failed} failed, ${r.totals.flaky} flaky, ${r.totals.skipped} skipped of ${r.totals.tests}`
  lines.push(md ? `**Before** ${head(before)}  ` : `before  ${head(before)}`)
  lines.push(md ? `**After** ${head(after)}` : `after   ${head(after)}`)
  lines.push('')
  const section = (title, rows, show) => {
    if (rows.length === 0) return
    lines.push(md ? `**${title} (${rows.length})**` : `${title} (${rows.length})`)
    lines.push('')
    for (const row of rows)
      lines.push(md ? `- \`${row.key}\`${show(row)}` : `  ${row.key}${show(row)}`)
    lines.push('')
  }
  const err = (e) => (e ? ` — ${e}` : '')
  section(
    'REGRESSED — fails the gate',
    diff.regressed,
    (r) => ` ${r.was} → ${r.now}${err(r.error)}`,
  )
  section('flaky before, failed after — look at it', diff.flakyToFailed, (r) => err(r.error))
  section('became flaky', diff.becameFlaky, (r) => ` (was ${r.was})${err(r.error)}`)
  section('skip moved', diff.skipMoved, (r) => ` ${r.was} → ${r.now}`)
  section('fixed', diff.fixed, (r) => ` → ${r.now}`)
  section('removed', diff.removed, (r) => ` (was ${r.was})`)
  section('added', diff.added, (r) => ` (${r.now})`)
  const same = diff.stillFailing.filter((r) => r.was === r.now).length
  const changed = diff.stillFailing.filter((r) => r.was !== r.now)
  lines.push(
    md
      ? `Failing on both sides: ${diff.stillFailing.length} (${same} with the same first error line).`
      : `failing on both sides: ${diff.stillFailing.length} (${same} with the same first error line)`,
  )
  if (changed.length > 0) {
    lines.push('')
    section(
      'failing on both sides, with a DIFFERENT first error line',
      changed,
      (r) => `\n      was: ${r.was}\n      now: ${r.now}`,
    )
  }
  lines.push('')
  lines.push(
    diff.regressed.length === 0
      ? 'GATE: PASS — nothing that passed before fails, skips or vanishes after.'
      : `GATE: FAIL — ${diff.regressed.length} regressed.`,
  )
  return lines.join('\n')
}

// ── run ─────────────────────────────────────────────────────────────────

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${r.stderr}`)
  return r.stdout.trim()
}

/** The main checkout, through git, from any worktree — as gpu.sh and hydrate.ps1 do. */
const mainCheckout = (from) =>
  path.dirname(git(from, 'rev-parse', '--path-format=absolute', '--git-common-dir'))

/** Something already answering on the port. `reuseExistingServer` would test IT, not the ref. */
const portAnswers = (port) =>
  new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
    socket.setTimeout(1500, () => {
      socket.destroy()
      resolve(false)
    })
  })

/**
 * Every link (junction, symlink, any reparse point) under `root`, found
 * WITHOUT descending into one.
 *
 * The baseline worktree holds ~191 of them: pnpm's `node_modules` links, and
 * `public/`, which is the MAIN checkout's asset tree. A walk that followed a
 * link would list, and a delete that followed one would remove, files that
 * belong to the main checkout. So a link is recorded and never pushed: on
 * Windows libuv types every FILE_ATTRIBUTE_REPARSE_POINT entry as a link, and
 * the lstat before a push is the second guard, for a dirent that says
 * "directory" about something that is not one.
 */
export const findLinks = (root) => {
  if (fs.lstatSync(root).isSymbolicLink()) return [root]
  const links = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) links.push(p)
      else if (entry.isDirectory()) {
        if (fs.lstatSync(p).isSymbolicLink()) links.push(p)
        else stack.push(p)
      }
    }
  }
  return links
}

/**
 * Remove one link and never its target. The non-recursive directory delete
 * takes a junction or a directory symlink off by itself (it cannot recurse,
 * so it cannot reach the target); a file symlink, or any symlink on POSIX,
 * refuses it with ENOTDIR and goes by unlink, which never follows either.
 */
const removeLink = (link) => {
  try {
    fs.rmdirSync(link)
  } catch {
    fs.unlinkSync(link)
  }
}

const isLink = (p) => {
  try {
    return fs.lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Delete a tree that may hold links into somewhere shared: every link first,
 * one at a time and without following it; then a fresh walk that must find
 * none; and only then the recursive delete. Throws, leaving the folder, if a
 * link survives. A recursive delete must never meet a link to `public/` or
 * to the main checkout's `node_modules`.
 */
export const removeTreeSafely = (root) => {
  if (!fs.existsSync(root) && !isLink(root)) return
  for (const link of findLinks(root)) removeLink(link)
  if (!fs.existsSync(root)) return // root was itself a link, now gone
  const left = findLinks(root)
  if (left.length > 0) {
    throw new Error(
      `${left.length} link(s) survived under ${root}, e.g. ${left[0]}. Not deleting the folder: a recursive delete could follow one.`,
    )
  }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

/**
 * What is at the baseline worktree's path, for `run`:
 *   - `absent`;
 *   - `leftover`: a folder with no `.git` of its own, which a Windows
 *     `git worktree remove` used to leave behind (it deletes `.git` first and
 *     then fails on "Directory not empty");
 *   - `ours`: a live worktree at `sha`, which `run` reuses;
 *   - `other`: a live worktree somewhere else, which `run` refuses to touch.
 * The `.git` test comes BEFORE any git question: inside a leftover, git walks
 * up and answers with the MAIN checkout's HEAD, which read as `other` and
 * made every later `run` of that ref refuse to start.
 */
export const baselineTreeState = (tree, sha) => {
  if (!fs.existsSync(tree)) return { state: 'absent' }
  if (!fs.existsSync(path.join(tree, '.git'))) return { state: 'leftover' }
  const head = git(tree, 'rev-parse', 'HEAD')
  return head === sha ? { state: 'ours' } : { state: 'other', head }
}

/**
 * Take the baseline worktree away. NOT `git worktree remove`: on Windows it
 * deletes `.git` first and then fails on "Directory not empty" (a folder of
 * pnpm junctions), leaving a folder that git reads as the MAIN checkout. So:
 * the tree goes junction-first by `removeTreeSafely`, then `git worktree
 * prune` drops the registration whose folder is gone. And the two shared
 * trees a followed link would have emptied are checked for afterwards.
 */
export const clearBaselineTree = (main, tree) => {
  removeTreeSafely(tree)
  spawnSync('git', ['worktree', 'prune'], { cwd: main, stdio: 'inherit' })
  if (fs.existsSync(tree)) throw new Error(`${tree} still exists after removal`)
  for (const shared of [
    path.join(main, 'public', 'assets'),
    path.join(main, 'node_modules', '.bin'),
  ]) {
    if (!fs.existsSync(shared))
      console.error(`e2e-baseline: WARNING ${shared} is gone after cleanup`)
  }
}

const run = async (opts) => {
  const here = process.cwd()
  const main = mainCheckout(here)
  const sha = git(main, 'rev-parse', '--verify', `${opts.ref}^{commit}`)
  const subject = git(main, 'log', '-1', '--format=%s', sha)
  const out = path.resolve(opts.out)
  const rawOut = out.replace(/\.json$/i, '') + '.raw.json'
  const port = String(opts.port)

  if (await portAnswers(Number(port))) {
    console.error(`e2e-baseline: something already answers on ${port}. Playwright would REUSE it`)
    console.error(
      '(reuseExistingServer) and test whatever it serves, not this ref. Pick another --port.',
    )
    return 1
  }
  const mainAssets = path.join(main, 'public', 'assets')
  if (!fs.existsSync(mainAssets)) {
    console.error(
      `e2e-baseline: ${mainAssets} is missing. Hydrate the main checkout first (pnpm assets:pull).`,
    )
    return 1
  }

  const tree = path.join(main, '.claude', 'worktrees', `e2e-baseline-${sha.slice(0, 12)}`)
  const found = baselineTreeState(tree, sha)
  if (found.state === 'other') {
    console.error(
      `e2e-baseline: ${tree} is a live worktree at ${found.head}, not ${sha}. Not touching it: remove it yourself and re-run.`,
    )
    return 1
  }
  if (found.state === 'leftover') {
    // The folder is named by this sha, so it is this ref's, from an earlier
    // run whose cleanup failed. It has no .git, so nothing in it is a commit.
    console.log(`e2e-baseline: clearing a leftover ${tree} (no .git of its own)`)
    try {
      clearBaselineTree(main, tree)
    } catch (error) {
      console.error(`e2e-baseline: ${error instanceof Error ? error.message : String(error)}`)
      return 1
    }
  }
  if (found.state === 'ours') console.log(`e2e-baseline: reusing ${tree}`)
  else git(main, 'worktree', 'add', '--detach', tree, sha)

  try {
    console.log(`e2e-baseline: ${sha.slice(0, 9)} ${subject}`)
    const shell = process.platform === 'win32'
    const install = spawnSync('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], {
      cwd: tree,
      stdio: 'inherit',
      shell,
    })
    if (install.status !== 0) throw new Error('pnpm install failed in the worktree')

    const link = path.join(tree, 'public')
    if (!fs.existsSync(link)) fs.symlinkSync(path.join(main, 'public'), link, 'junction')
    const assets = spawnSync(
      process.execPath,
      ['tools/assets/check-assets-present.mjs', '--verify-hashes'],
      {
        cwd: tree,
        stdio: 'inherit',
      },
    )
    if (assets.status !== 0) {
      throw new Error(
        `assets:check failed against ${sha.slice(0, 9)}'s own manifest. A record taken on the wrong bytes is not a baseline.`,
      )
    }

    const cli = path.join(tree, 'node_modules', '@playwright', 'test', 'cli.js')
    const args = [cli, 'test', '--reporter=json,list', ...opts.extra]
    const env = { ...process.env, E2E_PORT: port, PLAYWRIGHT_JSON_OUTPUT_FILE: rawOut }
    const started = Date.now()
    console.log(`e2e-baseline: playwright ${args.slice(1).join(' ')}   (E2E_PORT=${port})`)
    const suite = spawnSync(process.execPath, args, { cwd: tree, stdio: 'inherit', env })
    const wallMs = Date.now() - started
    if (!fs.existsSync(rawOut))
      throw new Error(`the suite wrote no JSON report (exit ${suite.status})`)

    const raw = JSON.parse(fs.readFileSync(rawOut, 'utf8'))
    const reduced = reduceReport(raw)
    const record = {
      version: BASELINE_VERSION,
      meta: {
        ref: opts.ref,
        sha,
        subject,
        takenAt: new Date().toISOString(),
        wallMs,
        exitCode: suite.status,
        playwright: raw.config?.version ?? null,
        workers: raw.config?.metadata?.actualWorkers ?? raw.config?.workers ?? null,
        args: opts.extra,
        env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('E2E_'))),
        host: {
          platform: process.platform,
          release: os.release(),
          cpu: os.cpus()[0]?.model ?? null,
          cpus: os.cpus().length,
          node: process.version,
        },
        reportErrors: (raw.errors ?? []).map((e) => firstErrorLine({ error: e })).filter(Boolean),
      },
      totals: reduced.totals,
      tests: reduced.tests,
    }
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`)
    const t = record.totals
    console.log(`\ne2e-baseline: wrote ${out}`)
    console.log(
      `  ${t.passed} passed, ${t.failed} failed, ${t.flaky} flaky, ${t.skipped} skipped of ${t.tests} — ${(wallMs / 60000).toFixed(1)} min`,
    )
    if (record.meta.reportErrors.length > 0) {
      console.log(
        `  ${record.meta.reportErrors.length} report-level error(s), e.g. a spec that failed to LOAD:`,
      )
      for (const e of record.meta.reportErrors.slice(0, 5)) console.log(`    ${e}`)
    }
    return 0
  } catch (error) {
    console.error(`e2e-baseline: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  } finally {
    if (!opts.keep) {
      try {
        clearBaselineTree(main, tree)
      } catch (error) {
        console.error(
          `e2e-baseline: cleanup failed, ${tree} is left behind (the next run clears it):`,
        )
        console.error(`  ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────

const USAGE = `usage:
  node tools/test/e2e-baseline.mjs run --ref <git-ref> --out <file.json> [--port N] [--keep] [-- <playwright args>]
  node tools/test/e2e-baseline.mjs reduce <playwright-report.json> --out <file.json>
  node tools/test/e2e-baseline.mjs compare <before.json> <after.json> [--md]`

const readRecord = (file) => {
  const record = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (record.version !== BASELINE_VERSION || typeof record.tests !== 'object') {
    throw new Error(`${file} is not an e2e-baseline record (version ${BASELINE_VERSION})`)
  }
  return record
}

const main = async () => {
  const [command, ...rest] = process.argv.slice(2)
  const dash = rest.indexOf('--')
  const own = dash === -1 ? rest : rest.slice(0, dash)
  const extra = dash === -1 ? [] : rest.slice(dash + 1)
  const flag = (name) => {
    const i = own.indexOf(name)
    if (i === -1) return undefined
    const value = own[i + 1]
    own.splice(i, 2)
    return value
  }
  const has = (name) => {
    const i = own.indexOf(name)
    if (i !== -1) own.splice(i, 1)
    return i !== -1
  }

  if (command === 'run') {
    const ref = flag('--ref')
    const out = flag('--out')
    const port = Number(flag('--port') ?? 5291)
    const keep = has('--keep')
    if (!ref || !out || !Number.isInteger(port) || own.length > 0) {
      console.error(USAGE)
      return 2
    }
    return run({ ref, out, port, keep, extra })
  }
  if (command === 'reduce') {
    const out = flag('--out')
    if (!out || own.length !== 1) {
      console.error(USAGE)
      return 2
    }
    const reduced = reduceReport(JSON.parse(fs.readFileSync(own[0], 'utf8')))
    const record = {
      version: BASELINE_VERSION,
      meta: { ref: null, sha: null, reducedFrom: own[0] },
      ...reduced,
    }
    fs.writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`)
    console.log(`wrote ${out}: ${JSON.stringify(reduced.totals)}`)
    return 0
  }
  if (command === 'compare') {
    const md = has('--md')
    if (own.length !== 2) {
      console.error(USAGE)
      return 2
    }
    const before = readRecord(own[0])
    const after = readRecord(own[1])
    const diff = compareBaselines(before, after)
    console.log(formatComparison(before, after, diff, { md }))
    return diff.regressed.length === 0 ? 0 : 1
  }
  console.error(USAGE)
  return 2
}

// Run as a script, importable as a module: the whole-path entry check that
// `tools/perf/png-diff.mjs` explains (a suffix match runs `main()` on import).
const isEntry = () => {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return pathToFileURL(fs.realpathSync(entry)).href === import.meta.url
  } catch {
    return false
  }
}
if (isEntry()) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error)
      process.exit(1)
    },
  )
}
