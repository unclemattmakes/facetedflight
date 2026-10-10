// tests/unit/known-red-registry.test.ts: every known-red e2e test has its row
// in docs/testing/KNOWN-RED.md, and every row has its test. Neither half can
// rot alone: a fixed test whose call is removed must lose its row, and a new
// call needs a row that says why.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAINTAINER_CHECKOUT, present } from './helpers/checkout'
import { REPO as ROOT } from './helpers/repo-root'

const E2E = path.join(ROOT, 'tests', 'e2e')
const REGISTRY = path.join(ROOT, 'docs', 'testing', 'KNOWN-RED.md')
// The registry is working state and the public export leaves it out
// (plan/PUBLIC-REPO-facetedflight.md §1.6); the specs' calls stay, and say where to look.
const HAVE_REGISTRY = present('docs/testing/KNOWN-RED.md')

const specFiles = (): string[] =>
  fs
    .readdirSync(E2E)
    .filter((f) => f.endsWith('.spec.ts'))
    .map((f) => path.join(E2E, f))

const calledIds = (): string[] => {
  const ids: string[] = []
  for (const file of specFiles()) {
    const src = fs.readFileSync(file, 'utf8')
    for (const m of src.matchAll(/knownRed\(\s*'(KR-\d{2})'/g)) ids.push(m[1] as string)
  }
  return ids
}

const registryIds = (): string[] =>
  [...fs.readFileSync(REGISTRY, 'utf8').matchAll(/^\| (KR-\d{2}) \|/gm)].map((m) => m[1] as string)

describe.skipIf(HAVE_REGISTRY || !MAINTAINER_CHECKOUT)('the known-red registry is missing', () => {
  it('says so in the working repository, rather than passing quietly', () => {
    expect(HAVE_REGISTRY, `${REGISTRY} is absent; only the public export may lack it`).toBe(true)
  })
})

describe.skipIf(!HAVE_REGISTRY)('the known-red registry', () => {
  it('finds calls and rows at all (the sweep is not vacuous)', () => {
    expect(calledIds().length).toBeGreaterThan(0)
    expect(registryIds().length).toBeGreaterThan(0)
  })

  it('names each id once in the specs and once in the registry', () => {
    const calls = calledIds()
    const rows = registryIds()
    expect(new Set(calls).size, 'an id used by two tests').toBe(calls.length)
    expect(new Set(rows).size, 'an id with two rows').toBe(rows.length)
  })

  it('has a row for every call, and a call for every row', () => {
    expect([...calledIds()].sort()).toEqual([...registryIds()].sort())
  })
})
