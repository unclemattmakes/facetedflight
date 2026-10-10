// biome skips a file past `files.maxSize` with a warning and still exits 0, so
// a source file that grows past it silently stops being linted or formatted
// (DEV-483 follow-up: `src/boot/app.ts` came within 2.3 KB of biome's 1 MiB
// default while four FF-TV rows were each adding a block to it). This test is
// the loud half: every file biome is meant to check must be under the limit
// `biome.json` sets, with headroom, or it goes red here instead of quietly
// leaving the lint.

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { walkTree } from './helpers/source-tree'

const ROOT = join(__dirname, '..', '..')
/** biome's own default when `files.maxSize` is absent: 1 MiB. */
const BIOME_DEFAULT_MAX = 1024 * 1024
/** Fail this far short of the limit, so the warning comes before the skip. */
const HEADROOM = 0.9

const maxSize = (): number => {
  const config = JSON.parse(readFileSync(join(ROOT, 'biome.json'), 'utf8')) as {
    files?: { maxSize?: number }
  }
  return config.files?.maxSize ?? BIOME_DEFAULT_MAX
}

describe('biome files.maxSize', () => {
  it('every linted source file is under 90 % of the limit', () => {
    const limit = maxSize()
    const files = ['src', 'tests', 'functions', 'workers/rooms/src'].flatMap((d) =>
      walkTree(join(ROOT, d), { match: (name) => /\.(ts|tsx|mjs|js)$/.test(name) }),
    )
    // src/generated is outside biome's includes.
    const linted = files.filter((f) => !f.replace(/\\/g, '/').includes('/src/generated/'))
    expect(linted.length).toBeGreaterThan(100)
    const over = linted
      .map((f) => ({ f, size: statSync(f).size }))
      .filter((x) => x.size > limit * HEADROOM)
      .map((x) => `${x.f.slice(ROOT.length + 1)}: ${x.size} B (limit ${limit} B)`)
    expect(over).toEqual([])
  })
})
