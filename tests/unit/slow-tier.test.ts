// DEV-945: the slow unit tier. tests/slow.list.json names the files `pnpm test`
// leaves out and `pnpm test:slow` runs (docs/testing/TIERS.md). This holds the
// list to the tree: a name that points at nothing would silently drop a file
// from BOTH tiers, and a file in the list that never asks for a long budget
// does not belong in it.
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url))
const files: string[] = JSON.parse(readFileSync(root('tests/slow.list.json'), 'utf8')).files

describe('slow unit tier list', () => {
  it('has no duplicates and every entry is a unit test file that exists', () => {
    expect(new Set(files).size).toBe(files.length)
    for (const f of files) {
      expect(f, f).toMatch(/^(tests\/unit|src)\/.*\.test\.ts$/)
      expect(existsSync(root(f)), `${f} is in tests/slow.list.json but missing`).toBe(true)
    }
  })

  it('lists only files that carry a long per-test budget (a minute or more)', () => {
    for (const f of files) {
      const budgets = [...readFileSync(root(f), 'utf8').matchAll(/\b(\d{2,3})_000\b/g)].map((m) =>
        Number(m[1]),
      )
      expect(
        Math.max(0, ...budgets),
        `${f} has no timeout of 60_000 or more`,
      ).toBeGreaterThanOrEqual(60)
    }
  })

  it('is what package.json, the batch gate and CI actually run', () => {
    expect(readFileSync(root('package.json'), 'utf8')).toContain('"test:slow"')
    expect(readFileSync(root('tools/agent/batch-gate.sh'), 'utf8')).toContain('test:slow')
    expect(readFileSync(root('.github/workflows/asset-denylist.yml'), 'utf8')).toContain(
      'pnpm test:slow',
    )
  })
})
