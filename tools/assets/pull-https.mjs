#!/usr/bin/env node
// tools/assets/pull-https.mjs: hydrate public/assets/ over plain HTTPS, with no R2 credentials.
//
// `pnpm assets:pull` is rclone against the bucket, which needs the `r2-ff2` remote and an
// access key on the machine. A second box that only RUNS the game and its gates (the release
// gate on olVR, docs/RELEASE-MACHINE.md) needs the bytes, not the keys: this reads
// tools/assets/required-assets.json, fetches every row that has a sha256 from the public
// content host, verifies each hash, and writes it under public/. Read-only by construction.
//
// A file already on disk with the right hash is skipped, so a re-run only fetches what
// changed. Anything that fails to fetch or to verify is reported and the exit code is 1.
//
//   node tools/assets/pull-https.mjs [--base https://ff2-content.mattscott.dev] [--dest public]

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const base = arg('--base', 'https://ff2-content.mattscott.dev').replace(/\/+$/, '')
const dest = path.resolve(REPO, arg('--dest', 'public'))

const manifest = JSON.parse(
  fs.readFileSync(path.join(REPO, 'tools', 'assets', 'required-assets.json'), 'utf8'),
)
const rows = manifest.assets.filter((r) => r.sha256 && r.state !== 'retired')
const sha = (buf) => createHash('sha256').update(buf).digest('hex')

let fetched = 0
let skipped = 0
const failed = []
const queue = [...rows]
const worker = async () => {
  for (let row = queue.shift(); row; row = queue.shift()) {
    const file = path.join(dest, row.path)
    if (fs.existsSync(file) && sha(fs.readFileSync(file)) === row.sha256) {
      skipped++
      continue
    }
    try {
      const res = await fetch(`${base}/${row.path}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      const got = sha(buf)
      if (got !== row.sha256)
        throw new Error(`sha256 ${got.slice(0, 12)}, manifest ${row.sha256.slice(0, 12)}`)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, buf)
      fetched++
    } catch (e) {
      failed.push(`${row.path}: ${e.message}`)
    }
  }
}
await Promise.all(Array.from({ length: 8 }, worker))

console.log(
  `assets:pull:https: ${fetched} fetched, ${skipped} already right, ${failed.length} failed (of ${rows.length})`,
)
for (const f of failed) console.log(`  FAILED ${f}`)
process.exitCode = failed.length > 0 ? 1 : 0
