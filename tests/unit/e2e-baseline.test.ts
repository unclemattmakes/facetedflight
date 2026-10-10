/**
 * `tools/test/e2e-baseline.mjs` — the pure half: reducing Playwright's JSON
 * report to one verdict per test, and the gate that compares two records.
 *
 * The report fixture is a REAL one (Playwright 1.63, `--reporter=json`,
 * retries 1), trimmed of paths and timestamps, rather than a shape written
 * from the docs: a reducer tested against what its author believed the
 * reporter writes has tested the belief. The `run` half needs a GPU and a
 * full suite, and is exercised by running it (docs/plan/APP-SPLIT-BASELINE.md).
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type BaselineRecord,
  compareBaselines,
  formatComparison,
  reduceReport,
  type TestVerdict,
  totalsOf,
} from '../../tools/test/e2e-baseline.mjs'

const report = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'playwright-report-shape.json'), 'utf8'),
)

describe('reduceReport, over a real Playwright report', () => {
  const { tests, totals } = reduceReport(report)

  it('agrees with the reporter’s own stats line', () => {
    expect(totals).toEqual({
      tests:
        report.stats.expected + report.stats.unexpected + report.stats.flaky + report.stats.skipped,
      passed: report.stats.expected,
      failed: report.stats.unexpected,
      flaky: report.stats.flaky,
      skipped: report.stats.skipped,
    })
  })

  it('keys by project › file › describes › title, nested describes included', () => {
    expect(Object.keys(tests)).toEqual(
      [
        'chromium › shape.spec.ts › passes',
        'chromium › shape.spec.ts › fails',
        'chromium › shape.spec.ts › flakes',
        'chromium › shape.spec.ts › skipped',
        'chromium › shape.spec.ts › @gpu group › same',
        'chromium › shape.spec.ts › @gpu group › inner › deep',
      ].sort(),
    )
  })

  it('keeps the error a failure and a flake actually had, without colour codes', () => {
    expect(tests['chromium › shape.spec.ts › fails']).toMatchObject({
      verdict: 'failed',
      attempts: 2,
      error: 'Error: one is two',
    })
    // The flake's LAST attempt passed; its error is on the attempt before.
    const flake = tests['chromium › shape.spec.ts › flakes']
    expect(flake?.verdict).toBe('flaky')
    expect(flake?.error).toMatch(/^Error: expect\(received\)\.toBe\(expected\)/)
    expect(flake?.error?.includes(String.fromCharCode(27))).toBe(false)
    expect(tests['chromium › shape.spec.ts › passes']?.error).toBeNull()
  })

  it('numbers a repeated title rather than letting the second overwrite the first', () => {
    const twice = {
      suites: [
        {
          title: 'a.spec.ts',
          file: 'a.spec.ts',
          specs: [
            { title: 't', line: 1, tests: [{ projectName: 'p', status: 'expected', results: [] }] },
            {
              title: 't',
              line: 2,
              tests: [{ projectName: 'p', status: 'unexpected', results: [] }],
            },
          ],
        },
      ],
    }
    expect(reduceReport(twice).tests).toMatchObject({
      'p › a.spec.ts › t': { verdict: 'passed', line: 1 },
      'p › a.spec.ts › t #2': { verdict: 'failed', line: 2 },
    })
  })
})

const v = (verdict: TestVerdict['verdict'], error: string | null = null): TestVerdict => ({
  verdict,
  line: 1,
  attempts: 1,
  ms: 0,
  error,
})
const record = (tests: Record<string, TestVerdict>): BaselineRecord => ({
  version: 1,
  meta: { ref: 'r', sha: '0123456789abcdef' },
  totals: totalsOf(tests),
  tests,
})

describe('compareBaselines — the gate', () => {
  it('passes when nothing that passed moved', () => {
    const before = record({ a: v('passed'), b: v('failed', 'x'), c: v('skipped') })
    const diff = compareBaselines(
      before,
      record({ a: v('passed'), b: v('failed', 'x'), c: v('skipped') }),
    )
    expect(diff.regressed).toEqual([])
    expect(diff.stillFailing).toEqual([{ key: 'b', was: 'x', now: 'x' }])
    expect(formatComparison(before, before, diff)).toContain('GATE: PASS')
  })

  it('fails on passed → failed, passed → skipped, and a passing test that vanished', () => {
    const diff = compareBaselines(
      record({ a: v('passed'), b: v('passed'), c: v('passed'), d: v('failed') }),
      record({ a: v('failed', 'boom'), b: v('skipped') }),
    )
    expect(diff.regressed).toEqual([
      { key: 'a', was: 'passed', now: 'failed', error: 'boom' },
      { key: 'b', was: 'passed', now: 'skipped', error: null },
      { key: 'c', was: 'passed', now: 'absent', error: null },
    ])
    // A test that was already failing and is gone is reported, not gated.
    expect(diff.removed).toEqual([
      { key: 'c', was: 'passed' },
      { key: 'd', was: 'failed' },
    ])
    expect(formatComparison(record({}), record({}), diff)).toContain('GATE: FAIL — 3 regressed')
  })

  it('reports, without gating, what one record cannot settle', () => {
    const diff = compareBaselines(
      record({
        f: v('flaky'),
        g: v('passed'),
        h: v('failed'),
        s: v('skipped'),
        k: v('failed', 'old'),
      }),
      record({
        f: v('failed', 'e'),
        g: v('flaky', 'e2'),
        h: v('passed'),
        s: v('passed'),
        k: v('failed', 'new'),
        n: v('passed'),
      }),
    )
    expect(diff.regressed).toEqual([])
    expect(diff.flakyToFailed).toEqual([{ key: 'f', error: 'e' }])
    expect(diff.becameFlaky).toEqual([{ key: 'g', was: 'passed', error: 'e2' }])
    expect(diff.fixed).toEqual([{ key: 'h', now: 'passed' }])
    expect(diff.skipMoved).toEqual([{ key: 's', was: 'skipped', now: 'passed' }])
    expect(diff.stillFailing).toEqual([{ key: 'k', was: 'old', now: 'new' }])
    expect(diff.added).toEqual([{ key: 'n', now: 'passed' }])
  })
})
