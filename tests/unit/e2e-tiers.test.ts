// tests/unit/e2e-tiers.test.ts: the e2e tier table in docs/testing/TIERS.md and
// the `@measure` tags in tests/e2e agree.
//
// Matt, 2026-10-07: e2e is two tiers, BEHAVIOUR (every gate) and MEASURE (on
// demand and at the release). The tag is in the top-level describe title and the
// table is where Matt overrules a row, so a row and a tag that disagree would
// make the table a lie in one direction or silently drop a test from the default
// run in the other. Describe the marker, never spell it in prose that this
// guard reads: the check is on the spec files' own top-level titles.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAINTAINER_CHECKOUT, present } from './helpers/checkout'

const REPO = path.resolve(__dirname, '..', '..')
const E2E = path.join(REPO, 'tests', 'e2e')
const TAG = '@measure'

const tierOf = (file: string): 'BEHAVIOUR' | 'MEASURE' | 'MIXED' => {
  const src = fs.readFileSync(path.join(E2E, file), 'utf8')
  const tops = [...src.matchAll(/^test(?:\.describe)?\((['"`])(.*?)\1/gm)].map((m) => m[2] ?? '')
  const tagged = tops.filter((t) => t.includes(TAG)).length
  if (tagged === 0) return 'BEHAVIOUR'
  return tagged === tops.length ? 'MEASURE' : 'MIXED'
}

const tableRows = (): Map<string, string> => {
  const doc = fs.readFileSync(path.join(REPO, 'docs', 'testing', 'TIERS.md'), 'utf8')
  const rows = new Map<string, string>()
  for (const m of doc.matchAll(/^\| `([a-z0-9-]+)` \| (BEHAVIOUR|MEASURE|MIXED) \|/gm)) {
    rows.set(m[1] ?? '', m[2] ?? '')
  }
  return rows
}

const specs = fs.readdirSync(E2E).filter((f) => f.endsWith('.spec.ts'))

// The table stays in the private tree (Matt, 2026-10-10), so the public export skips it; the
// maintainer checkout, where its absence is a fault, says so.
const HAVE_TABLE = present('docs/testing/TIERS.md')

describe.skipIf(HAVE_TABLE || !MAINTAINER_CHECKOUT)('the e2e tier table is missing', () => {
  it('says so', () => expect(HAVE_TABLE).toBe(true))
})

describe.skipIf(!HAVE_TABLE)('the e2e tier table', () => {
  const rows = HAVE_TABLE ? tableRows() : new Map<string, string>()

  it('has a row for every spec and no row for a spec that is gone', () => {
    const names = specs.map((f) => f.replace('.spec.ts', '')).sort()
    expect([...rows.keys()].sort()).toEqual(names)
  })

  it('says what the tags say, spec by spec', () => {
    const wrong = specs
      .map((f) => [f.replace('.spec.ts', ''), tierOf(f), rows.get(f.replace('.spec.ts', ''))])
      .filter(([, tag, row]) => tag !== row)
    expect(wrong).toEqual([])
  })

  it('has a MEASURE tier at all (an empty one would mean the tags were stripped)', () => {
    expect([...rows.values()].filter((t) => t === 'MEASURE').length).toBeGreaterThan(0)
  })
})

describe('the config skips the tier by default and runs it on demand', () => {
  const cfg = fs.readFileSync(path.join(REPO, 'playwright.config.ts'), 'utf8')
  it('reads E2E_MEASURE and gives tests a default timeout', () => {
    expect(cfg).toContain('E2E_MEASURE')
    expect(cfg).toMatch(/timeout: 90_000,\n\s+fullyParallel/)
  })
})
