// tools/assets/glb-cli.mjs: the CLI tail every asset converter shares.
//
// convert-wings, convert-jumpseat-cone, convert-start-deck and
// convert-hangar-art each build bytes in memory from the READ-ONLY Unity
// project and then do the same four things: print the report, `--check` the
// bytes against the file on disk (exit 3 when they differ), refuse to
// overwrite different bytes without `--force` (exit 4), and write. Four
// copies of that tail drifted once already (DEV-680: one lost the refusal),
// so it lives here once. The exit codes are read by agents and docs:
//
//   0  written, or --check found every file byte-identical
//   3  --check found a file that differs (or is missing)
//   4  refused to overwrite a file whose bytes differ (no --force)
//
// Flags:
//   --check      build in memory and compare; writes nothing
//   --report     print the report and stop; writes nothing
//   --out <f>    write a single-output converter's file somewhere else
//   --force      overwrite a file whose bytes differ
//
// public/assets is ONE folder shared by every worktree (AGENT-NOTES section 2):
// that is what the refusal is for. Nothing here reads the Unity project; the
// converter's `build` does, and it stays read-only (hard rule 1).

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { assertOutsideLegacy } from '../legacy-root.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(HERE, '..', '..')

// `isMain` lives in tools/lib/cli.mjs (every CLI's entry guard); re-exported so the converters' imports stay.
export { isMain } from '../lib/cli.mjs'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/**
 * Run a converter's CLI. Call it only from the entry guard:
 *
 *   if (isMain(import.meta.url)) runConverter({ build, outputs })
 *
 * `build()` returns `{ files, report }`: `files` maps an output key to its
 * bytes (Buffer or Uint8Array), `report` is printed as JSON first. `outputs`
 * maps the same keys to their paths under `public/`. `--out` is accepted only
 * when there is exactly one output.
 */
export const runConverter = ({ build, outputs, argv = process.argv.slice(2) }) => {
  const keys = Object.keys(outputs)
  const outAt = argv.indexOf('--out')
  if (outAt >= 0 && keys.length !== 1) {
    console.error(`--out needs a single-output converter; this one writes ${keys.length} files`)
    process.exit(2)
  }
  const outFor = (key) =>
    outAt >= 0 ? path.resolve(argv[outAt + 1]) : path.join(REPO, 'public', outputs[key])

  const { files, report } = build()
  console.log(JSON.stringify(report, null, 2))
  if (argv.includes('--report')) process.exit(0)

  const check = argv.includes('--check')
  const force = argv.includes('--force')
  let differs = 0
  for (const key of keys) {
    const bytes = files[key]
    if (!bytes) throw new Error(`glb-cli: build() returned no bytes for output "${key}"`)
    const out = outFor(key)
    const exists = fs.existsSync(out)
    const same = exists && Buffer.compare(fs.readFileSync(out), bytes) === 0
    if (check) {
      console.log(same ? `OK ${out} is byte-identical` : `DIFFERS ${out}`)
      if (!same) differs++
      continue
    }
    if (exists && !same && !force) {
      console.error(
        `REFUSING to overwrite ${out} with different bytes; pass --force if you mean it`,
      )
      process.exit(4)
    }
    assertOutsideLegacy(out)
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, bytes)
    console.log(`wrote ${out} (${bytes.length} bytes, sha256 ${sha256(bytes)})`)
  }
  if (differs) process.exit(3)
}
