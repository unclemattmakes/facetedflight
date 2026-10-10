// tests/unit/smoke-list.test.ts — the smoke tier cannot rot.
//
// `tests/smoke.list.json` names the files `pnpm test:smoke` runs (docs/testing/
// TIERS.md). A list like that has two ways to go quietly wrong: a file gets
// renamed and the entry points at nothing — vitest then reports "no test files
// found" for THAT filter and green for the rest, which reads as a pass — or a
// narrow test gets added because it was handy, and the tier stops answering
// "did I break the game?" and starts answering "did I break this one thing?".
//
// So every entry has to exist, and every entry has to be WIDE: it has to reach
// at least `minWidth` distinct `src/` modules through its imports, measured by
// the same walker the tiered runner uses to hone in (`tools/test/import-graph.
// mjs`). Width is a floor, not the criterion — a test earns its place by what
// it EXERCISES, which the `why` field is for — but a floor is what a test can
// hold.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO, reachableSrc, unitTestFiles } from '../../tools/test/import-graph.mjs'

interface SmokeEntry {
  readonly file: string
  readonly why: string
}
interface SmokeList {
  readonly minWidth: number
  readonly files: readonly SmokeEntry[]
}

const LIST_PATH = path.join(REPO, 'tests', 'smoke.list.json')
const list = JSON.parse(fs.readFileSync(LIST_PATH, 'utf8')) as SmokeList

describe('tests/smoke.list.json', () => {
  it('has a floor and a list worth the name', () => {
    expect(list.minWidth).toBeGreaterThanOrEqual(10)
    // Fewer than five and it is a favourite, not a tier.
    expect(list.files.length).toBeGreaterThanOrEqual(5)
    const names = list.files.map((e) => e.file)
    expect(new Set(names).size, 'duplicate entry').toBe(names.length)
  })

  for (const entry of list.files) {
    describe(entry.file, () => {
      const abs = path.join(REPO, entry.file)

      it('exists, and is a vitest file the full tier also runs', () => {
        expect(fs.existsSync(abs), `${entry.file} is not on disk`).toBe(true)
        // The same include vitest.config.ts uses — a file the full suite would
        // not collect is not a subset of it.
        expect(unitTestFiles().map((f) => path.relative(REPO, f).replace(/\\/g, '/'))).toContain(
          entry.file,
        )
      })

      it(`reaches at least ${list.minWidth} src/ modules`, () => {
        const width = reachableSrc(abs).size
        expect(width, `${entry.file} is ${width} modules wide`).toBeGreaterThanOrEqual(
          list.minWidth,
        )
      })

      it('says why it is here', () => {
        expect(entry.why.trim().length).toBeGreaterThan(20)
      })
    })
  }

  it('covers, between them, a real fraction of src/', () => {
    // The union is the honest number for the tier: what a green smoke run has
    // put on the line at all. Measured 2026-09-15 at 78 of 154 modules
    // (`node tools/test/tiered.mjs --list` prints the live number); the floor
    // is set well under that so the assertion is about collapse, not drift.
    const union = new Set<string>()
    for (const entry of list.files)
      for (const m of reachableSrc(path.join(REPO, entry.file))) union.add(m)
    expect(union.size).toBeGreaterThanOrEqual(60)
  })
})
