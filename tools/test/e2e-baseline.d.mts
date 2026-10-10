// Type declarations for e2e-baseline.mjs. Separate for the reason
// tools/legacy-root.d.mts gives: the tool is plain Node, run without a
// transpiler, and the test that pins its pure half is TypeScript.

export declare const BASELINE_VERSION: number

export type Verdict = 'passed' | 'failed' | 'flaky' | 'skipped'

export interface TestVerdict {
  verdict: Verdict
  line: number | null
  attempts: number
  ms: number
  error: string | null
}

export interface Totals {
  tests: number
  passed: number
  failed: number
  flaky: number
  skipped: number
}

export interface BaselineRecord {
  version: number
  meta: Record<string, unknown> & { ref?: string | null; sha?: string | null }
  totals: Totals
  tests: Record<string, TestVerdict>
}

export interface Comparison {
  regressed: { key: string; was: Verdict; now: Verdict | 'absent'; error: string | null }[]
  flakyToFailed: { key: string; error: string | null }[]
  becameFlaky: { key: string; was: Verdict; error: string | null }[]
  fixed: { key: string; now: Verdict }[]
  stillFailing: { key: string; was: string | null; now: string | null }[]
  skipMoved: { key: string; was: Verdict; now: Verdict }[]
  removed: { key: string; was: Verdict }[]
  added: { key: string; now: Verdict }[]
}

/** The first line of a Playwright result's error, colour codes stripped, capped at 300 characters. */
export declare const firstErrorLine: (result: unknown) => string | null

/** One verdict per test out of Playwright's JSON report, keyed project › file › describes › title. */
export declare const reduceReport: (report: unknown) => {
  tests: Record<string, TestVerdict>
  totals: Totals
}

export declare const totalsOf: (tests: Record<string, TestVerdict>) => Totals

/** BEFORE against AFTER; `regressed` non-empty fails the gate. */
export declare const compareBaselines: (
  before: Pick<BaselineRecord, 'tests'>,
  after: Pick<BaselineRecord, 'tests'>,
) => Comparison

/** Every link under `root` (junction, symlink, any reparse point), found without descending into one. */
export declare const findLinks: (root: string) => string[]

/** Remove every link under `root` without following it, check none is left, then delete the folder. */
export declare const removeTreeSafely: (root: string) => void

/** `removeTreeSafely(tree)`, then `git worktree prune` in `main`; throws if the folder survives. */
export declare const clearBaselineTree: (main: string, tree: string) => void

/** What is at the baseline worktree's path; the `.git` test comes before any git question. */
export declare const baselineTreeState: (
  tree: string,
  sha: string,
) =>
  | { state: 'absent' }
  | { state: 'leftover' }
  | { state: 'ours' }
  | { state: 'other'; head: string }

export declare const formatComparison: (
  before: Pick<BaselineRecord, 'meta' | 'totals'>,
  after: Pick<BaselineRecord, 'meta' | 'totals'>,
  diff: Comparison,
  opts?: { md?: boolean },
) => string
