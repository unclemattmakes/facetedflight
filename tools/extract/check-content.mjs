#!/usr/bin/env node

// tools/extract/check-content.mjs — the generated CONTENT trees, guarded the way
// the constants sheet already was.
//
//   node tools/extract/check-content.mjs            write content/_generated.sha256
//   node tools/extract/check-content.mjs --check    exit 3 if any generated file has changed
//   node tools/extract/check-content.mjs --check --full
//                                                   + re-run level.mjs against the Unity project
//
// ── Why this exists ───────────────────────────────────────────────────────
//
// PORT_PLAN §4.1 states the rule for every extractor, not just one:
//
//   "CI re-runs the extractor and fails on any diff against the committed
//    output; when the Unity project is not mounted, it verifies the sha256
//    instead."
//
// `constants.mjs` implemented both halves and `palette.mjs` implemented the
// second. `level.mjs`, `props.mjs` and `ghost.mjs` implemented neither, so
// `pnpm extract:check` covered two of the five generated artefacts and
// CLAUDE.md's "CI fails on any diff" was true of `src/generated/` and false of
// `content/`. Twenty-one JSON files — every shipped mission, all four
// environments' prop passes, both 2016 ghost recordings — could be hand-edited
// and nothing anywhere would say so.
//
// ── Why the obvious fix is wrong, which is why this is a file ─────────────
//
// Wiring the other three extractors' own `--check` into `extract:check` does not
// work. Each fails differently, and the differences are the whole design:
//
//   ghost.mjs --all --check    Exits 0 when `tools/prototype/out` is absent:
//                              "nothing staged, skipping". A VACUOUS pass — the
//                              same shape as `assets:check` reporting "0/0 ready
//                              verified" while the HoverJet flew backwards.
//
//   props.mjs --check          Can NEVER pass against the committed tree, on any
//                              machine. `content/environments/*.json` is a
//                              TWO-STAGE output: props.mjs writes the base with
//                              `placementMapAsset`, then
//                              `tools/assets/bake-placements.mjs` adds the baked
//                              `placements` blob and DROPS that field. props.mjs
//                              knows nothing about stage two, so its `--check`
//                              reports all four environments as changed, always.
//                              Wiring it in would have made CI permanently red.
//
//   level.mjs --all --check    Genuine, but it is an EXTRACTOR-HEALTH check ("did
//                              the reader find a spawn, a boundary, a finish
//                              gate") and not a byte-drift check, it needs the
//                              Unity project, it takes ~25 s, and it WRITES its
//                              output as a side effect of running. Behind
//                              `--full`, never in the default path.
//
// So the guard that runs everywhere is the sha256 half, and it is enough for the
// thing actually at risk: a generated file edited by hand, or left behind when
// the tool that writes it moved. It cannot prove the JSON still agrees with a
// Unity project it cannot see — nothing can — but it proves the bytes are the
// ones the extractor wrote on a machine that COULD see it. That is exactly the
// posture `constants.mjs --check` and `palette.mjs --check` already take.
//
// ── A live footgun this now catches ───────────────────────────────────────
//
// `pnpm extract` runs `extract:props` and does NOT run `bake:placements`. So the
// documented "regenerate everything" command strips `placements` and
// `spawnClearing` out of all four environments — 138 lines of baked scatter and
// DEV-100's launch-deck clearings — and leaves a tree that looks freshly
// generated. Before this file, nothing downstream would have noticed.
//
// ── Scope ─────────────────────────────────────────────────────────────────
//
// `*.json` under the three generated trees. That is exactly the set
// `.gitattributes` marks `linguist-generated`, and it deliberately leaves out
// `_summary.md` and `_axis-validation.md` — those are prose for humans, and
// prose drifting is not a defect the game can trip over. `content/palettes` is
// absent on purpose: `palette.mjs --check` already verifies its own output
// against the published PNGs' recorded sha, and two guards on one tree would
// mean two things to update.
//
// Line endings are not a hazard here: `.gitattributes` line 14 is
// `* text=auto eol=lf`, which overrides this machine's `core.autocrlf=true`, so
// the bytes on disk are LF on both hosts — verified, zero 0x0d in every file
// this tool hashes. Raw bytes, no normalisation, no platform branch.
//
// SAFETY. Reads the Unity project only to decide whether it is there, and only
// via `legacyAvailable()`. Writes exactly one file, inside this repo.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { legacyAvailable, legacyRoot } from '../legacy-root.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * `--repo <dir>` points the whole tool at a copy of the content trees.
 *
 * Only `tests/unit/content-manifest.test.ts` passes it, and it exists so the
 * test that proves DETECTION — edit a byte, expect exit 3 — can run against a
 * temp copy instead of tampering with the real tree and restoring it in a
 * `finally` that a crash would skip. A tool's test hook, not a build switch:
 * nothing the game runs reads this file at all.
 */
const repoArg = process.argv.indexOf('--repo')
const REPO = repoArg > -1 ? path.resolve(process.argv[repoArg + 1]) : path.join(HERE, '..', '..')
const MANIFEST = path.join(REPO, 'content', '_generated.sha256')

/** The trees `pnpm extract` writes. See the scope note above for the omissions. */
const TREES = ['content/levels', 'content/environments', 'content/ghosts']

/** Today's count, so a broken directory walk cannot look like a clean tree. */
const FLOOR = 20

const CHECK = process.argv.includes('--check')
const FULL = process.argv.includes('--full')

function die(msg) {
  console.error(`check-content: ${msg}`)
  process.exit(1)
}

/** Forward slashes, always — the manifest is a byte comparison across two hosts. */
const toForward = (p) => String(p).split('\\').join('/')

/**
 * Every generated JSON under the three trees, as sorted `sha256  path` lines.
 *
 * Sorted by the POSIX path so the manifest does not depend on the order the
 * filesystem hands directory entries back, which differs between NTFS and ext4.
 */
function inventory() {
  const rows = []
  for (const dir of TREES) {
    const abs = path.join(REPO, dir)
    if (!fs.existsSync(abs)) die(`${dir} is missing — run \`pnpm extract\``)
    for (const name of fs.readdirSync(abs)) {
      if (!name.endsWith('.json')) continue
      const sha = createHash('sha256')
        .update(fs.readFileSync(path.join(abs, name)))
        .digest('hex')
      rows.push({ sha, file: toForward(`${dir}/${name}`) })
    }
  }
  rows.sort((a, b) => (a.file < b.file ? -1 : 1))
  return rows
}

const rows = inventory()

// A guard that verifies nothing passes. `describe.skipIf` skipped the tests and
// not the body; `assets:check` hashed the `ready` assets while everything the
// game loads is `staged`. Both were green for months. Same shape, so: fail loud.
if (rows.length < FLOOR) {
  die(
    `only ${rows.length} generated file(s) across ${TREES.length} trees (expected >= ${FLOOR}) — the walk is broken`,
  )
}

const text = `${rows.map((r) => `${r.sha}  ${r.file}`).join('\n')}\n`

if (!CHECK) {
  fs.writeFileSync(MANIFEST, text)
  console.log(
    `check-content: wrote ${toForward(path.relative(REPO, MANIFEST))} — ${rows.length} file(s)`,
  )
  process.exit(0)
}

// ── --check ───────────────────────────────────────────────────────────────

if (!fs.existsSync(MANIFEST)) {
  die('no committed manifest to verify — run `pnpm extract:manifest` and commit it')
}

const committed = fs.readFileSync(MANIFEST, 'utf8')
if (committed !== text) {
  const was = new Map(
    committed
      .trim()
      .split('\n')
      .map((l) => [l.slice(66), l.slice(0, 64)]),
  )
  const now = new Map(rows.map((r) => [r.file, r.sha]))
  console.error('check-content: the generated content trees do not match the manifest.\n')
  for (const [file, sha] of now) {
    if (!was.has(file)) console.error(`  + ${file} (not in the manifest)`)
    else if (was.get(file) !== sha) console.error(`  ~ ${file}`)
  }
  for (const file of was.keys()) if (!now.has(file)) console.error(`  - ${file} (gone)`)
  console.error(
    '\nEither a generated file was hand-edited, or a tool that writes one was run' +
      '\nwithout the tool that finishes the job — `pnpm extract` strips the baked' +
      '\n`placements` out of content/environments unless `pnpm bake:placements`' +
      '\nfollows it. Restore with `git checkout -- content/`, or regenerate and run' +
      '\n`pnpm extract:manifest` to commit the new bytes deliberately.',
  )
  process.exit(3)
}

console.log(`check-content: ${rows.length} generated file(s) match the manifest.`)

// ── --full: the other half of §4.1, when the project is actually mounted ──

if (!FULL) process.exit(0)

if (!legacyAvailable()) {
  console.log(
    `check-content: --full, but no Unity project at ${legacyRoot()}; manifest verified only.`,
  )
  process.exit(0)
}

const r = spawnSync(process.execPath, [path.join(HERE, 'level.mjs'), '--all', '--check'], {
  stdio: 'inherit',
})
if (r.status !== 0) {
  console.error(`check-content: level.mjs --all --check exited ${r.status}`)
  process.exit(3)
}
console.log('check-content: level.mjs agrees with the Unity project.')
