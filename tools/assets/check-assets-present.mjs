#!/usr/bin/env node
// check-assets-present.mjs — the floor check between "the build ran" and "the
// build works".
//
// FF2 ships no binary content in git (PORT_PLAN §2.5, D12/D26). Compiled
// content lives in a Cloudflare R2 bucket, so a build from a bare checkout —
// one that never ran `pnpm assets:pull`, or ran it against the wrong remote —
// produces a bundle that looks perfectly healthy to Vite and is a black screen
// in a headset. This script fails that build loudly instead.
//
// It does three separate jobs, in this order:
//
//   1. LINT the manifest itself (always). Duplicate ids or paths, bad states,
//      absolute or `..` paths, backslashes. Catches the typo that would
//      otherwise make job 2 silently check nothing.
//   2. VERIFY every `ready` asset is present under the local content tree, at
//      a plausible size, and — with --verify-hashes — byte-identical to the
//      recorded sha256.
//   3. REPORT what is still staged or planned, so the number of unpublished
//      assets is visible in CI output rather than in someone's memory.
//
// Nothing here talks to the network or needs credentials: it checks a hydrated
// local tree. Publishing is plain rclone in package.json.
//
// Usage:
//   node tools/assets/check-assets-present.mjs              # lint + verify ready
//   node tools/assets/check-assets-present.mjs --staged     # also check staged bytes exist
//   node tools/assets/check-assets-present.mjs --verify-hashes
//   node tools/assets/check-assets-present.mjs --json
//
// Env:
//   ASSET_DIR            root of the hydrated content tree   (default: public)
//   FF2_STAGE_DIR        where un-published extractor output lives
//                        (default: first of tools/prototype/out, ../ff2-scratch/out)
//   FF2_ASSET_MANIFEST   alternate manifest (default: tools/assets/required-assets.json).
//                        Exists so CI can prove the guard still fails on a
//                        deliberately broken fixture — a guard nobody has seen
//                        fail is not a guard.
//
// Exit 0 = OK, 1 = something is missing or malformed, 2 = bad invocation.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sharedAssets, shareProblems } from './content-pack-lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')
const MANIFEST = process.env.FF2_ASSET_MANIFEST
  ? resolve(process.env.FF2_ASSET_MANIFEST)
  : join(HERE, 'required-assets.json')

const argv = new Set(process.argv.slice(2))
const CHECK_STAGED = argv.has('--staged')
const VERIFY_HASHES = argv.has('--verify-hashes')
const AS_JSON = argv.has('--json')
// --pack: the tree came from `pnpm content:pull`. Only the shareable rows
// (`share` names a licence) are required, and every one is hashed; the bought
// assets a pack never carries may be absent, and absence is not a problem.
const PACK_MODE = argv.has('--pack')

for (const arg of argv) {
  if (!['--staged', '--verify-hashes', '--json', '--pack', '--'].includes(arg)) {
    console.error(`check-assets-present: unknown argument ${arg}`)
    console.error('usage: check-assets-present.mjs [--staged] [--verify-hashes] [--json] [--pack]')
    process.exit(2)
  }
}

/** Root of the hydrated content tree. Paths in the manifest are relative to it. */
const ASSET_DIR = process.env.ASSET_DIR ? resolve(process.env.ASSET_DIR) : join(REPO_ROOT, 'public')

/** Where extractor output waits before it is published. D26 moves this out of the repo. */
function resolveStageDir() {
  if (process.env.FF2_STAGE_DIR) return resolve(process.env.FF2_STAGE_DIR)
  const candidates = [
    join(REPO_ROOT, 'tools', 'prototype', 'out'),
    resolve(REPO_ROOT, '..', 'ff2-scratch', 'out'),
  ]
  return candidates.find((c) => existsSync(c)) ?? candidates[0]
}
const STAGE_DIR = resolveStageDir()

const VALID_STATES = new Set(['ready', 'staged', 'planned', 'retired'])
const VALID_LICENCES = new Set(['KEEP', 'CONFIRM', 'LICENSED', 'REPLACE'])

const problems = []
const warnings = []

// ── Load ──────────────────────────────────────────────────────────────────
let manifest
try {
  manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
} catch (err) {
  console.error(`check-assets-present: cannot read ${MANIFEST}\n  ${err.message}`)
  process.exit(1)
}

const assets = Array.isArray(manifest.assets) ? manifest.assets : null
if (!assets) {
  console.error('check-assets-present: manifest has no `assets` array.')
  process.exit(1)
}

// ── 1. Lint the manifest ──────────────────────────────────────────────────
for (const p of shareProblems(assets)) problems.push(`share: ${p}`)

if (PACK_MODE) {
  // A pack-only tree: every shareable asset present and byte-exact, nothing else required.
  const shared = sharedAssets(assets)
  let ok = 0
  for (const a of shared) {
    const full = join(ASSET_DIR, a.path)
    if (!existsSync(full)) {
      problems.push(`shared asset missing: ${full} (run \`pnpm content:pull\`)`)
      continue
    }
    const actual = createHash('sha256').update(readFileSync(full)).digest('hex')
    if (actual !== a.sha256) {
      problems.push(
        `hash mismatch: ${a.path}\n      manifest ${a.sha256}\n      on disk  ${actual}`,
      )
      continue
    }
    ok += 1
  }
  const absent = assets.filter(
    (a) => a.share === 'none' && a.state === 'ready' && !existsSync(join(ASSET_DIR, a.path)),
  ).length
  if (problems.length > 0) {
    console.error('check-assets-present: FAIL (--pack): the pack tree is not intact.')
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }
  console.log(
    `check-assets-present: OK (--pack): ${ok}/${shared.length} shared assets present and byte-exact under ${ASSET_DIR}; ` +
      `${absent} bought or unshared ready assets absent, which is expected`,
  )
  process.exit(0)
}

const seenIds = new Set()
const seenPaths = new Set()

for (const [i, a] of assets.entries()) {
  const where = `assets[${i}] (${a.id ?? 'no id'})`
  if (typeof a.id !== 'string' || a.id === '') problems.push(`${where}: missing id`)
  else if (seenIds.has(a.id)) problems.push(`${where}: duplicate id`)
  else seenIds.add(a.id)

  if (typeof a.path !== 'string' || a.path === '') {
    problems.push(`${where}: missing path`)
  } else {
    if (seenPaths.has(a.path)) problems.push(`${where}: duplicate path ${a.path}`)
    seenPaths.add(a.path)
    if (isAbsolute(a.path)) problems.push(`${where}: path must be bucket-relative, got ${a.path}`)
    if (a.path.includes('\\')) problems.push(`${where}: use forward slashes, got ${a.path}`)
    if (a.path.split('/').includes('..')) problems.push(`${where}: path escapes the tree`)
    if (a.path !== a.path.toLowerCase()) {
      // R2 keys are case-sensitive and Windows filesystems are not; a
      // capitalised key is a file that works locally and 404s in production.
      problems.push(`${where}: bucket keys are lower-case by convention, got ${a.path}`)
    }
  }

  if (!VALID_STATES.has(a.state)) {
    problems.push(`${where}: state must be one of ${[...VALID_STATES].join('|')}, got ${a.state}`)
  }
  if (!VALID_LICENCES.has(a.licence)) {
    problems.push(
      `${where}: licence must be one of ${[...VALID_LICENCES].join('|')}, got ${a.licence}`,
    )
  }
  if (a.state === 'ready' && a.licence === 'REPLACE') {
    // The whole point of the exercise. A REPLACE asset in the bucket is a
    // third-party or derivative work one public deploy away from shipping.
    problems.push(`${where}: licence REPLACE must never be state ready — it cannot ship.`)
  }
  if (a.state === 'staged' && typeof a.stagedFrom !== 'string') {
    problems.push(`${where}: state staged needs a stagedFrom filename`)
  }
}

// ── 2. Verify assets that are on disk ─────────────────────────────────────
//
// `ready` means published to the bucket and REQUIRED, so a missing one is an
// error; the block below checks those.
//
// `--verify-hashes` is wider on purpose: it covers **anything with a recorded
// sha that is actually on disk**, `ready` or not. That widening is the whole
// point, and the bug it exists for is worth stating. A file of EXACTLY the same
// byte count and different content replaced
// `public/assets/ships/hoverjet-cockpit.glb`; the HoverJet rendered pointing
// backwards; and this tool said "0/0 ready verified" and passed — because every
// asset the game loads today is `staged`, and the hash check only walked
// `ready`.
//
// A size check could not catch it (119,072 bytes either way) and neither could
// a presence check. Only the bytes can.
const ready = assets.filter((a) => a.state === 'ready')
const hashable = assets.filter(
  (a) => typeof a.sha256 === 'string' && existsSync(join(ASSET_DIR, a.path)),
)
let verified = 0
let hashed = 0

if (VERIFY_HASHES) {
  for (const a of hashable) {
    const full = join(ASSET_DIR, a.path)
    const actual = createHash('sha256').update(readFileSync(full)).digest('hex')
    if (actual !== a.sha256) {
      problems.push(
        `hash mismatch: ${a.path}
      manifest ${a.sha256}
      on disk  ${actual}`,
      )
      continue
    }
    hashed += 1
  }
}

if (ready.length > 0) {
  if (!existsSync(ASSET_DIR)) {
    problems.push(`content dir missing: ${ASSET_DIR} (did you run \`pnpm assets:pull\`?)`)
  } else {
    for (const a of ready) {
      const full = join(ASSET_DIR, a.path)
      if (!existsSync(full)) {
        problems.push(`required asset missing: ${full} (run \`pnpm assets:pull\`)`)
        continue
      }
      const size = statSync(full).size
      if (size === 0) {
        problems.push(`required asset is empty: ${full}`)
        continue
      }
      if (typeof a.bytes === 'number' && a.bytes > 0) {
        const drift = Math.abs(size - a.bytes) / a.bytes
        if (drift > 0.5) {
          warnings.push(
            `${a.id}: ${size} B on disk vs ${a.bytes} B in the manifest (${Math.round(drift * 100)}% drift) — stale manifest, or the wrong file.`,
          )
        }
      }
      // Hashing happens above, for every asset on disk rather than only these.
      if (VERIFY_HASHES && typeof a.sha256 !== 'string') {
        warnings.push(`${a.id}: --verify-hashes asked for, but no sha256 recorded`)
      }
      verified += 1
    }
  }
}

// ── 3. Staged / planned report ────────────────────────────────────────────
const staged = assets.filter((a) => a.state === 'staged')
const planned = assets.filter((a) => a.state === 'planned')
const stagedFound = []
const stagedMissing = []

if (CHECK_STAGED) {
  for (const a of staged) {
    if (typeof a.stagedFrom !== 'string') continue
    const full = join(STAGE_DIR, a.stagedFrom)
    if (existsSync(full) && statSync(full).size > 0) stagedFound.push(a)
    else stagedMissing.push({ asset: a, full })
  }
  for (const m of stagedMissing) {
    problems.push(`staged asset not found: ${m.full} (asset ${m.asset.id}); set FF2_STAGE_DIR`)
  }
}

const blocking = assets.filter((a) => a.licence === 'REPLACE')
const unresolved = assets.filter((a) => a.licence === 'CONFIRM')

// ── Report ────────────────────────────────────────────────────────────────
if (AS_JSON) {
  console.log(
    JSON.stringify(
      {
        ok: problems.length === 0,
        assetDir: ASSET_DIR,
        stageDir: STAGE_DIR,
        counts: {
          total: assets.length,
          ready: ready.length,
          verified,
          staged: staged.length,
          stagedFound: stagedFound.length,
          planned: planned.length,
          licenceReplace: blocking.length,
          licenceConfirm: unresolved.length,
        },
        problems,
        warnings,
      },
      null,
      2,
    ),
  )
  process.exit(problems.length === 0 ? 0 : 1)
}

for (const w of warnings) console.warn(`check-assets-present: WARN  ${w}`)

if (problems.length > 0) {
  console.error('check-assets-present: FAIL — the content tree or its manifest is not shippable.')
  console.error('See docs/asset-storage.md and content/MANIFEST.md.')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}

console.log(
  `check-assets-present: OK — ${assets.length} assets in the manifest; ` +
    `${verified}/${ready.length} ready verified under ${ASSET_DIR}` +
    (VERIFY_HASHES ? `, ${hashed}/${hashable.length} hashes matched` : ''),
)
if (CHECK_STAGED) {
  console.log(
    `  staged: ${stagedFound.length}/${staged.length} found under ${STAGE_DIR} (not yet published)`,
  )
} else if (staged.length > 0) {
  console.log(
    `  staged: ${staged.length} extracted but unpublished (re-run with --staged to check)`,
  )
}
if (planned.length > 0) console.log(`  planned: ${planned.length} not produced yet`)
if (blocking.length > 0) {
  console.log(
    `  licence REPLACE: ${blocking.length} (${blocking.map((a) => a.id).join(', ')}) — ` +
      'cannot be published; see content/MANIFEST.md',
  )
}
if (unresolved.length > 0) {
  console.log(
    `  licence CONFIRM: ${unresolved.length} awaiting provenance (${unresolved.map((a) => a.id).join(', ')})`,
  )
}
