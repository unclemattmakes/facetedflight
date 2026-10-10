#!/usr/bin/env node
/**
 * check-em-dash.mjs: refuse an em-dash in anything newly written. Matt, 2026-09-30:
 * "add a rule project wide - no em-dashes."
 *
 * Two modes, each called by a hook in this directory:
 *
 *     node .githooks/check-em-dash.mjs --staged          (pre-commit)
 *     node .githooks/check-em-dash.mjs --message <file>  (commit-msg)
 *
 * and a third for whole files written new (the public export's overlay):
 *
 *     node .githooks/check-em-dash.mjs --files <file>...
 *
 * --staged reads the lines a commit ADDS (`git diff --cached -U0`) and refuses any that
 * carry the character. What it lets through, on purpose:
 *
 *   - A line MOVED unchanged: the same text is removed elsewhere in the same commit. A
 *     module split relocates thousands of old lines verbatim, and the rule is about what
 *     is written, not what is carried.
 *   - A merge, cherry-pick or revert in progress: those replay commits written under their
 *     own rules (and older ones from before this rule).
 *   - The GENERATED trees (CLAUDE.md hard rule 3): their text comes from the tools that
 *     write them, so the fix belongs in the tool, which this check does see.
 *
 * The tree held ~33,000 em-dashes when the rule arrived. Those are not rewritten here: a
 * line loses its dash when somebody edits it, because an edited line is an added line.
 *
 * The character is built from its code point below, so this file passes its own check.
 * Exit 0 clean, 1 found, 2 the check itself failed.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const DASH = String.fromCharCode(0x2014)
const GENERATED = [
  /^src\/generated\//,
  /^content\/levels\//,
  /^content\/environments\//,
  /^content\/ghosts\//,
  /^content\/_generated\.sha256$/,
  /^content\/lap-courses\.json$/,
  // Machine-written test records (APP-SPLIT 0.4): keyed by test titles, many
  // of which predate the rule. A record is output, not writing.
  /^docs\/plan\/app-split-baseline\//,
]
const HOW = 'Use a colon, a comma, parentheses or a new sentence instead (Matt, 2026-09-30).'

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 30 })
}

function replaying() {
  const dir = git(['rev-parse', '--git-dir']).trim()
  return ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD'].some((f) =>
    fs.existsSync(path.join(dir, f)),
  )
}

function checkStaged() {
  if (replaying()) return 0
  const diff = git(['diff', '--cached', '-U0', '--no-color', '--no-ext-diff', '--diff-filter=ACMR'])
  const removed = new Set()
  const added = []
  let file = null
  let line = 0
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      file = raw.startsWith('+++ b/') ? raw.slice(6) : null
      continue
    }
    if (raw.startsWith('--- ')) continue
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk) {
      line = Number(hunk[1])
      continue
    }
    if (raw.startsWith('-')) {
      removed.add(raw.slice(1).trim())
      continue
    }
    if (raw.startsWith('+')) {
      const text = raw.slice(1)
      if (file && text.includes(DASH) && !GENERATED.some((g) => g.test(file))) {
        added.push({ file, line, text })
      }
      line++
    }
  }
  const fresh = added.filter((a) => !removed.has(a.text.trim()))
  if (fresh.length === 0) return 0
  process.stderr.write(`em-dash: ${fresh.length} added line(s) carry an em-dash. ${HOW}\n`)
  for (const a of fresh.slice(0, 40)) {
    process.stderr.write(`  ${a.file}:${a.line}: ${a.text.trim().slice(0, 140)}\n`)
  }
  if (fresh.length > 40) process.stderr.write(`  ... and ${fresh.length - 40} more\n`)
  return 1
}

function checkMessage(file) {
  const text = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => !l.startsWith('#'))
    .join('\n')
  if (!text.includes(DASH)) return 0
  process.stderr.write(`em-dash: the commit message carries an em-dash. ${HOW}\n`)
  return 1
}

// --files: every line of the named files, for text that is new as a whole. The public
// export (tools/release/export-public.mjs) runs it over the overlay's files, which are
// written for the public repository and have no "carried" lines to excuse.
function checkFiles(files) {
  const found = []
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(DASH)) found.push({ file: f, line: i + 1, text: lines[i] })
    }
  }
  if (found.length === 0) return 0
  process.stderr.write(`em-dash: ${found.length} line(s) carry an em-dash. ${HOW}\n`)
  for (const a of found.slice(0, 40)) {
    process.stderr.write(`  ${a.file}:${a.line}: ${a.text.trim().slice(0, 140)}\n`)
  }
  if (found.length > 40) process.stderr.write(`  ... and ${found.length - 40} more\n`)
  return 1
}

try {
  const [mode, arg, ...rest] = process.argv.slice(2)
  if (mode === '--staged') process.exit(checkStaged())
  if (mode === '--message' && arg) process.exit(checkMessage(arg))
  if (mode === '--files') process.exit(checkFiles([arg, ...rest].filter(Boolean)))
  process.stderr.write('usage: check-em-dash.mjs --staged | --message <file> | --files <file>...\n')
  process.exit(2)
} catch (err) {
  process.stderr.write(`em-dash: the check failed: ${err?.message ?? err}\n`)
  process.exit(2)
}
