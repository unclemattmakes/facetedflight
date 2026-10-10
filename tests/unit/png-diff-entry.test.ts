// tests/unit/png-diff-entry.test.ts — `png-diff.mjs` runs its CLI only when it
// IS the program.
//
// The guard used to be `import.meta.url.endsWith(path.basename(process.argv[1]))`:
// a SUFFIX match on a basename. Any script that imported the module and whose
// own name is a suffix of `png-diff.mjs` — `diff.mjs`, `ff.mjs`, `ng-diff.mjs`,
// or a `png-diff.mjs` in some other folder — made it run `main()` at import
// time, which printed the usage line and exited 2 underneath the importer.
// Found 2026-09-26 by a scratch `diff.mjs` that only wanted `decodePng`. (The
// report also named `f-diff.mjs`, which is NOT a suffix — the name ends
// `g-diff.mjs` — and ran clean against the old guard, so it is not a case.)
//
// Every case spawns a real `node`, because what is under test is how node fills
// `argv[1]` and `import.meta.url` for an entry; a stub of either would be the
// belief written twice. The POSITIVE cases are here too, because a guard that
// never runs `main()` passes every "does not run" case below — and one of them
// goes through a directory link, which is where the obvious exact comparison
// (`pathToFileURL(argv[1])`) says "not the entry" and the CLI silently does
// nothing: node gives `import.meta.url` the REAL path and leaves `argv[1]` as
// typed.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const TOOL = fileURLToPath(new URL('../../tools/perf/png-diff.mjs', import.meta.url))
const REPO = fileURLToPath(new URL('../../', import.meta.url))
/** The first words of `main()`'s usage line — its receipt that it ran. */
const USAGE = 'usage: node tools/perf/png-diff.mjs'

const node = (args: string[], cwd?: string) =>
  spawnSync(process.execPath, args, { cwd, encoding: 'utf8' })

/** An importer that wants a helper and nothing else, as the w26 scratch script did. */
const importerSource = (from: string) =>
  `import { decodePng } from ${JSON.stringify(from)}\n` +
  `console.log(typeof decodePng === 'function' ? 'OK' : 'MISSING')\n`

let tmp = ''
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'png-diff-entry-'))
})
afterAll(() => {
  // The link is removed on its own first. Its target is a COPY inside `tmp`
  // (see below), so even a removal that followed it could only reach scratch.
  fs.rmSync(path.join(tmp, 'link'), { force: true })
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('png-diff.mjs imported by another program does not run main()', () => {
  it.each(['diff.mjs', 'ff.mjs', 'ng-diff.mjs', 'png-diff.mjs'])(
    'an importer named %s gets its helper and carries on',
    (name) => {
      // Its own folder, so the `png-diff.mjs` case names a DIFFERENT file with
      // the SAME basename — which any basename comparison calls the entry.
      const dir = fs.mkdtempSync(path.join(tmp, 'importer-'))
      const importer = path.join(dir, name)
      fs.writeFileSync(importer, importerSource(pathToFileURL(TOOL).href))
      const r = node([importer])
      expect(r.stderr).not.toContain(USAGE)
      expect(r.status).toBe(0)
      expect(r.stdout.trim()).toBe('OK')
    },
  )

  it('under `node --input-type=module -e`, where argv[1] is undefined', () => {
    // The case the guard's own comment names: how the water A/B first read it.
    const r = node(['--input-type=module', '-e', importerSource(pathToFileURL(TOOL).href)])
    expect(r.stderr).not.toContain(USAGE)
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('OK')
  })

  it('under `-e` with a word after the code, which lands in argv[1] and names no file', () => {
    const r = node([
      '--input-type=module',
      '-e',
      importerSource(pathToFileURL(TOOL).href),
      'no-such-folder',
    ])
    expect(r.stderr).not.toContain(USAGE)
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('OK')
  })
})

describe('png-diff.mjs run as the program DOES run main()', () => {
  // With no folders, main() prints the usage line and exits 2. That is the
  // cheapest observable proof it ran, and it needs no PNGs on disk.
  it('by its absolute path', () => {
    const r = node([TOOL])
    expect(r.stderr).toContain(USAGE)
    expect(r.status).toBe(2)
  })

  it('by the relative path its own usage line prints, from the repo root', () => {
    const r = node(['tools/perf/png-diff.mjs'], REPO)
    expect(r.stderr).toContain(USAGE)
    expect(r.status).toBe(2)
  })

  it('through a directory link, where argv[1] is the link and import.meta.url the real path', () => {
    // A COPY behind the link, not the repo's `tools/perf`: a link into the
    // tree is one careless recursive delete away from deleting the tree. The
    // module imports node builtins and `../terrain/png.mjs` (the one PNG decoder, TL-13), so
    // that file is copied to the same relative place and the copy runs as the original does.
    // `'junction'` is honoured on Windows (no privilege needed) and ignored on
    // POSIX, where this is an ordinary directory symlink.
    const real = path.join(tmp, 'real')
    fs.mkdirSync(real)
    fs.copyFileSync(TOOL, path.join(real, 'png-diff.mjs'))
    fs.mkdirSync(path.join(tmp, 'terrain'))
    fs.copyFileSync(
      fileURLToPath(new URL('../../tools/terrain/png.mjs', import.meta.url)),
      path.join(tmp, 'terrain', 'png.mjs'),
    )
    fs.symlinkSync(real, path.join(tmp, 'link'), 'junction')
    const r = node([path.join(tmp, 'link', 'png-diff.mjs')])
    expect(r.stderr).toContain(USAGE)
    expect(r.status).toBe(2)
  })
})
