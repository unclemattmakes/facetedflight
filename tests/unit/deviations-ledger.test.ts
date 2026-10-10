// tests/unit/deviations-ledger.test.ts — the ledger's two structural invariants.
//
// `docs/DEVIATIONS.md` is prose and nothing has ever checked it. Both of the
// claims below were broken on 2026-09-21, by different sessions, within hours of
// each other — and both were found by a human reading the file rather than by
// anything that runs.
//
// ── 1. An addendum belongs to its own row ─────────────────────────────────
//
// `### DEV-274 addendum` was appended at the TAIL of the file twice, which in a
// flat document means it lands inside whichever `##` row happens to be last:
// once under DEV-276, once under DEV-285. A reader of the strapline row scrolled
// into a paragraph about rocks.
//
// **The session that did it second had looked, and the sample it looked at could
// not tell the two rules apart.** At the tail it found DEV-276's `### Touched`,
// then the misplaced DEV-274 addendum, then DEV-276's own addendum — and read
// that as *"addenda append at the end of the file"*. Of the two addenda in that
// sample one was correctly placed and one was the anomaly, and **both are
// consistent with "append at the tail"**, so nothing there could separate the
// rules. That is CLAUDE.md's agreement lesson — *a rule tested only where two
// explanations agree has not been tested* — and the separating case was the one
// example it had in hand.
//
// So this is the test that separates them, and it is the whole reason the file
// needs one: the convention is invisible from any sample that does not already
// contain the violation.
//
// ── 2. A DEV number names exactly one row ────────────────────────────────
//
// On the same evening two live sessions were an hour from both writing a
// `## DEV-286`. It was avoided by each deriving over the refs at the point of
// use and then SAYING SO to the other — CLAUDE.md's *"announcing is the closing
// move"*. That works and it depends on both parties being awake.
//
// This does not. A duplicate `## DEV-NNN` fails `pnpm check`, which CI runs and
// Playwright is not — and it fails at the MERGE, which is the moment two
// independently-correct branches first become one wrong file. Nothing else in
// this repo notices that.
//
// Reads one file off disk. No assets, no DOM, no network.

import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MAINTAINER_CHECKOUT, present } from './helpers/checkout'

const LEDGER = 'docs/DEVIATIONS.md'
// The public export leaves the ledger out (plan/PUBLIC-REPO-facetedflight.md §1.6), so the
// ledger's half of this file skips there; the fixture half below still runs.
const HAVE_LEDGER = present(LEDGER)
const text = HAVE_LEDGER ? fs.readFileSync(LEDGER, 'utf8') : ''
const lines = text.split('\n')

/**
 * `## DEV-281 — …` → the row's number.
 *
 * `\b` matters: the ledger has a lettered-suffix convention for revisions of a
 * row — `DEV-018b`, `DEV-024b`, `DEV-024c`, `DEV-033b`, `DEV-033c` — and those
 * are separate rows that deliberately share a stem. A regex that collapsed the
 * suffix would report five duplicates that are not duplicates, which is how a
 * guard teaches people to ignore it.
 */
const ROW = /^## DEV-(\d{1,4})\b/
/**
 * A `##`-level heading that CONTINUES an existing row rather than claiming the
 * number for new work.
 *
 * There is exactly one today — `## DEV-186 follow-up — two bugs in DEV-167's
 * warm` — and it sits 800 lines below its parent. It is arguably a `###` in the
 * wrong clothes, and it is deliberately not "fixed" here: relocating prose
 * somebody wrote weeks ago on a style ground is a different act from repairing a
 * merge made this afternoon, and the invariant worth protecting is not the
 * heading level. It is that **two sessions did not both take one number**.
 */
const CONTINUATION = /^## DEV-\d{1,4}\s+(follow-up|addendum|REVERTED|revisited)\b/i
/**
 * `### DEV-274 addendum…` / `### DEV-280 REVERTED…` → the row it belongs to.
 *
 * The number must be followed by a SPACE or a COMMA, which is what keeps
 * `### DEV-280's grave, and why this row does not fall into it` out of the set:
 * that one is a sub-heading of DEV-281 that happens to name DEV-280, and it is
 * a cross-reference rather than an addendum. The apostrophe is the whole
 * discriminator, so the loud counterpart below pins that such a heading exists —
 * otherwise a future tidy-up could widen this regex and turn a legitimate
 * cross-reference into a failure.
 */
const ADDENDUM = /^### DEV-(\d{1,4})[\s,]/

interface Addendum {
  readonly line: number
  readonly of: string
  readonly under: string | null
  readonly heading: string
}

interface Scan {
  readonly rows: { number: string; line: number; heading: string }[]
  readonly addenda: Addendum[]
}

/**
 * The whole of the parsing, as a function of TEXT rather than of the file.
 *
 * NOT exported — biome refuses an export from a test file, and it is right to:
 * a helper another file imports belongs in `src/` or in a fixture, and a test
 * that exports one is a module pretending to be a suite. Nothing outside this
 * file needs it.
 *
 * Split out so the matcher itself can be tested against a ledger that is wrong
 * on purpose. A guard's only real claim is that it goes RED, and that is the one
 * thing a green run against a healthy file cannot show you — the sibling session
 * that prompted this proved it by hand, mutating the real ledger twice and
 * restoring it. Below, the same two mutants are synthetic and run every time.
 *
 * It matters because the assertions are only as good as these three regexes:
 * widen one and the guard passes on a file it should reject, silently and
 * forever. That failure is invisible to every assertion that only ever sees a
 * ledger which is already correct.
 */
const scanLedger = (source: string): Scan => {
  const addenda: Addendum[] = []
  const rows: Scan['rows'] = []
  let current: string | null = null
  for (const [i, line] of source.split('\n').entries()) {
    const row = ROW.exec(line)
    if (row) {
      current = row[1] as string
      // A continuation still sets the enclosing row — an addendum under
      // `## DEV-186 follow-up` belongs to DEV-186 — but it does not CLAIM the
      // number, so it is not counted as a second row.
      if (!CONTINUATION.test(line)) {
        rows.push({ number: current, line: i + 1, heading: line.slice(0, 80) })
      }
      continue
    }
    const sub = ADDENDUM.exec(line)
    if (sub) {
      addenda.push({
        line: i + 1,
        of: sub[1] as string,
        under: current,
        heading: line.slice(0, 80),
      })
    }
  }
  return { rows, addenda }
}

const orphansIn = (scan: Scan): string[] =>
  scan.addenda
    .filter((a) => a.of !== a.under)
    .map((a) => `${a.line} — DEV-${a.of} addendum sits under DEV-${a.under ?? '(none)'}`)

const duplicatesIn = (scan: Scan): string[] => {
  const seen = new Map<string, number[]>()
  for (const r of scan.rows) seen.set(r.number, [...(seen.get(r.number) ?? []), r.line])
  return [...seen.entries()]
    .filter(([, at]) => at.length > 1)
    .map(([n, at]) => `DEV-${n} has ${at.length} rows, at lines ${at.join(', ')}`)
}

const { rows, addenda } = scanLedger(text)

describe.skipIf(!HAVE_LEDGER)('the deviations ledger holds its shape', () => {
  it('puts every addendum under the row it is an addendum TO', () => {
    const orphans = orphansIn({ rows, addenda }).map((o) => `${LEDGER}:${o}`)
    expect(
      orphans,
      'an addendum appended at the tail of the file lands inside whichever row is last; ' +
        'move it under its own `## DEV-NNN`',
    ).toEqual([])
  })

  it('gives each DEV number exactly one row', () => {
    const duplicates = duplicatesIn({ rows, addenda })
    expect(
      duplicates,
      'two sessions took the same number — derive over the union AND announce it (CLAUDE.md). ' +
        'A row that CONTINUES another should say so in its heading (`follow-up`, `addendum`), ' +
        'or take a letter suffix like DEV-024b',
    ).toEqual([])
  })

  it('counts a `## DEV-NNN follow-up` as a continuation, not a second claim', () => {
    // The loud counterpart for `CONTINUATION`. If this reaches zero the exemption
    // is dead code and the rule above got stricter without anyone deciding to
    // make it so — which is the quiet half of a guard drifting.
    const continuations = lines.filter((l) => CONTINUATION.test(l))
    expect(
      continuations.length,
      'DEV-186 follow-up is the one heading this exemption exists for',
    ).toBeGreaterThan(0)
  })

  it('keeps the lettered-suffix rows distinct from their stem', () => {
    // `DEV-024`, `DEV-024b` and `DEV-024c` are three rows about one decision and
    // the suffix is what separates them. A regex that dropped it would fold them
    // together and report duplicates that the ledger intends.
    const suffixed = lines.filter((l) => /^## DEV-\d{1,4}[a-z]\b/.test(l))
    expect(suffixed.length, 'the ledger uses lettered revisions').toBeGreaterThan(0)
    for (const l of suffixed) expect(ROW.test(l), `${l.slice(0, 60)} is not a bare row`).toBe(false)
  })

  // ── the loud counterparts ───────────────────────────────────────────────
  //
  // A guarded suite needs one or it can rot for months while every run stays
  // green (CLAUDE.md, `describe.skipIf`). Both assertions above pass trivially
  // on an empty set, and both sets are derived by regex from prose — so a
  // heading style that drifts would silence them rather than fail them.

  it('is actually finding rows and addenda, rather than passing on an empty set', () => {
    // Lower bounds, not counts: the ledger only ever grows, and a number here
    // would be the thing this repo keeps paying for.
    expect(rows.length, 'the ledger has rows').toBeGreaterThan(200)
    expect(addenda.length, 'the ledger has addenda').toBeGreaterThanOrEqual(5)
  })

  it('still excludes the POSSESSIVE cross-reference, which is not an addendum', () => {
    // `### DEV-280's grave…` lives inside DEV-281 on purpose. If this ever goes
    // to zero, either that heading was renamed — fine — or somebody widened
    // `ADDENDUM` and is about to get a false orphan. Either way this row is
    // where they find out which.
    const possessive = lines.filter((l) => /^### DEV-\d{1,4}'/.test(l))
    expect(
      possessive.length,
      "a `### DEV-NNN's …` heading is a cross-reference inside another row, not an addendum",
    ).toBeGreaterThan(0)
  })
})

/**
 * The guard goes RED — which is the only claim a guard actually makes.
 *
 * Written after a sibling session mutation-tested the block above by hand:
 * it broke the real ledger twice in its worktree, confirmed `RC=1` and the
 * message on each, and restored byte-clean. That was the right verification and
 * it was a ONE-OFF; nothing above it re-runs when somebody widens a regex.
 *
 * These are the same two mutants as synthetic fixtures, so the matcher is under
 * test rather than only the file. `turn-indicator.test.ts` and the maps guard
 * are why the fixtures are strings and not files on disk: no `readFileSync`
 * runs at collection here, so there is nothing to throw in an environment that
 * lacks something.
 *
 * ── The must-NOT-fire cases are not decoration; each catches one widening ──
 *
 * Measured, by mutating the REGEXES rather than the ledger — the level above
 * what these fixtures were first written for, run by the same sibling session
 * after this block landed. Recorded so nobody deletes one as redundant:
 *
 *   `ADDENDUM`, delimiter class dropped
 *     /^### DEV-(\d{1,4})[\s,]/ -> /^### DEV-(\d{1,4})/
 *     caught by → "does NOT read a possessive cross-reference as an addendum"
 *     (and by the real-ledger assertion, because `### DEV-280's grave` exists)
 *
 *   `CONTINUATION`, any suffix treated as a continuation
 *     caught by → MUTANT B, because that widening silently switches OFF
 *     duplicate-row detection, which is the whole DEV-286 case
 *
 * So the guard defends its own regexes, and the two cases that look like
 * politeness are the two that make that true.
 */
describe('the guard fires on a ledger that is wrong', () => {
  const GOOD = [
    '## DEV-100 — a row',
    'body',
    '',
    '### DEV-100 addendum — about DEV-100',
    'body',
    '',
    '## DEV-101 — another row',
    'body',
  ].join('\n')

  it('is quiet on a healthy ledger, or the mutants below prove nothing', () => {
    const scan = scanLedger(GOOD)
    expect(orphansIn(scan)).toEqual([])
    expect(duplicatesIn(scan)).toEqual([])
    expect(scan.rows.map((r) => r.number)).toEqual(['100', '101'])
    expect(scan.addenda).toHaveLength(1)
  })

  it('MUTANT A — an addendum appended at the tail, which is what happened twice', () => {
    const scan = scanLedger(`${GOOD}\n\n### DEV-100 addendum — appended at the end`)
    expect(orphansIn(scan)).toEqual(['10 — DEV-100 addendum sits under DEV-101'])
  })

  it('MUTANT B — two rows on one number, the DEV-286 near-miss', () => {
    const scan = scanLedger(`${GOOD}\n\n## DEV-100 — a second session took it too`)
    expect(duplicatesIn(scan)).toEqual(['DEV-100 has 2 rows, at lines 1, 10'])
  })

  it('does NOT fire on a continuation heading', () => {
    const scan = scanLedger(`${GOOD}\n\n## DEV-100 follow-up — more about DEV-100`)
    expect(duplicatesIn(scan), 'a follow-up continues a row, it does not claim it').toEqual([])
  })

  it('does NOT fire on a lettered revision, which is a row of its own', () => {
    const scan = scanLedger(`${GOOD}\n\n## DEV-100b — the revision`)
    expect(duplicatesIn(scan), 'DEV-100b is not DEV-100').toEqual([])
  })

  it('does NOT read a possessive cross-reference as an addendum', () => {
    const scan = scanLedger(`${GOOD}\n\n### DEV-101's grave, inside DEV-100`)
    expect(scan.addenda, 'the apostrophe is the discriminator').toHaveLength(1)
    expect(orphansIn(scan)).toEqual([])
  })
})

describe.skipIf(HAVE_LEDGER || !MAINTAINER_CHECKOUT)('the ledger is missing', () => {
  it('says so in the working repository, rather than passing quietly', () => {
    expect(HAVE_LEDGER, `${LEDGER} is absent; only the public export may lack it`).toBe(true)
  })
})
