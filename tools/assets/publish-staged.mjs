// tools/assets/publish-staged.mjs — staged extractor output into the local
// content tree, under the names the game asks for.
//
//   node tools/assets/publish-staged.mjs           # everything marked `staged`
//   node tools/assets/publish-staged.mjs --check   # verify, write nothing
//
// The extractors drop meshes into a scratch directory with their Unity names
// (`hoverJet_w_cockpit.glb`). The game asks for bucket paths
// (`assets/ships/hoverjet-cockpit.glb`). `tools/assets/required-assets.json`
// is the mapping and the only place it lives; this walks it.
//
// Writes to `public/assets/`, which is gitignored. Publishing to the BUCKET is
// `pnpm assets:push`, a separate and deliberate step — and one that must not
// run for anything still marked `REPLACE` or `CONFIRM` (D26). This tool refuses
// to copy a `REPLACE` asset at all, because the difference between "on my disk"
// and "on a CDN" is one command and a bad afternoon.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const MANIFEST = path.join(REPO, 'tools', 'assets', 'required-assets.json')
const OUT_ROOT = path.join(REPO, 'public')

/** Where the extractors leave things. First hit wins. */
const STAGE_DIRS = [
  process.env.FF2_STAGE_DIR,
  path.join(REPO, 'tools', 'prototype', 'out'),
  path.resolve(REPO, '..', 'ff2-scratch', 'out'),
].filter(Boolean)

const checkOnly = process.argv.includes('--check')
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))

const findStaged = (name) => {
  for (const dir of STAGE_DIRS) {
    const p = path.join(dir, name)
    if (fs.existsSync(p)) return p
  }
  return null
}

let failed = 0
const rows = []

for (const asset of manifest.assets) {
  if (asset.state !== 'staged') continue

  if (asset.licence === 'REPLACE') {
    // Should be unreachable — a REPLACE asset has nothing to stage — but the
    // check is cheap and the failure mode is publishing bought geometry.
    console.error(`  REFUSED  ${asset.path} is licence REPLACE and must be re-made, not copied`)
    failed++
    continue
  }

  const src = asset.stagedFrom ? findStaged(asset.stagedFrom) : null
  if (!src) {
    console.error(
      `  MISSING  ${asset.stagedFrom ?? '(no stagedFrom)'} for ${asset.path}\n` +
        `           looked in: ${STAGE_DIRS.join(', ')}`,
    )
    failed++
    continue
  }

  const bytes = fs.readFileSync(src)
  if (asset.bytes && bytes.length !== asset.bytes) {
    // The manifest records a size. A mismatch means the staged file changed
    // under us, which is worth saying out loud rather than silently shipping.
    console.warn(`  ! ${asset.path}: ${bytes.length} bytes, manifest says ${asset.bytes}`)
  }

  const dest = path.join(OUT_ROOT, asset.path)
  const already = fs.existsSync(dest) && Buffer.compare(fs.readFileSync(dest), bytes) === 0
  if (!checkOnly && !already) {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, bytes)
  }
  if (checkOnly && !already) failed++

  rows.push({
    path: asset.path,
    bytes: bytes.length,
    licence: asset.licence,
    sha: crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12),
    state: checkOnly ? (already ? 'present' : 'MISSING') : already ? 'unchanged' : 'written',
  })
}

const pad = (s, n) => String(s).padEnd(n)
console.log(
  `\n${pad('bucket path', 40)}${pad('bytes', 10)}${pad('licence', 9)}${pad('sha', 14)}state`,
)
for (const r of rows) {
  console.log(
    `${pad(r.path, 40)}${pad(r.bytes.toLocaleString(), 10)}${pad(r.licence, 9)}${pad(r.sha, 14)}${r.state}`,
  )
}
const confirm = rows.filter((r) => r.licence === 'CONFIRM').length
if (confirm) {
  console.log(`\n  ${confirm} asset(s) are CONFIRM: fine locally, NOT cleared for the bucket.`)
}
if (failed) {
  console.error(`\n${failed} asset(s) failed.`)
  process.exit(1)
}
