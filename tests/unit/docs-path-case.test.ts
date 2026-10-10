// tests/unit/docs-path-case.test.ts — a documentation path is a path, and paths have a case.
//
// ── Why this exists ───────────────────────────────────────────────────────
//
// The fidelity ledger is tracked as `docs/DEVIATIONS.md`. CLAUDE.md's hard rule 9 and nine source
// comments spelled it in LOWER CASE, and in months nothing noticed, because the only machine
// anybody reads them on has a case-insensitive filesystem: on Windows the two spellings open the
// same file. On Linux — CI, and any second machine — they are two different paths, and an agent
// told to add a row to the lower-case one would create a SECOND, EMPTY ledger beside the real
// one and disagree with it from then on.
//
// No spelling but the tracked one appears in this file, and that is not tidiness. The first run
// of this gate failed on its own header, which had written the bad path out twice to describe
// it — the same thing that happened to `legacy-root.test.ts`, and the gate working rather than
// the gate being wrong. Allowlisting this file was the other way out and is the weaker one: it
// would buy a legible comment by making the gate blind to the one file whose job is to hold it.
//
// That is CLAUDE.md's `path.resolve` trap (trap 25) with a different mechanism and the same
// shape: a claim that is true on Windows, false on POSIX, invisible until the host changes. It
// earns a gate for the same reasons that one did — the failure is silent, it lands in comments
// nobody re-reads, and the host that would notice is not the host anybody works on.
//
// ── What it deliberately does NOT do ──────────────────────────────────────
//
// It says nothing about DEAD links. A reference to a document that exists at no case at all is a
// broken cross-reference — a real problem, a different one, and there are several today: planned
// documents, and the whole `docs/private/` tree, which is gitignored precisely so that CI cannot
// see it. Folding those in would make this gate red the day it landed and therefore ignored.
//
// The distinction is the entire point. This file catches the reference that resolves to a file
// **spelled differently**, because that is the one that silently behaves differently per
// platform. A reference that resolves to nothing behaves the same way everywhere.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MAINTAINER_CHECKOUT, present } from './helpers/checkout'

/** The fidelity ledger, at the one spelling git tracks. */
const LEDGER = 'DEVIATIONS.md'

/**
 * The public export leaves the ledger out (plan/PUBLIC-REPO-facetedflight.md §1.6). There the
 * ledger's own describe skips, and the case sweep below probes with a document the export
 * keeps, which is upper case for the same reason the ledger is: so the two spellings differ.
 */
const HAVE_LEDGER = present(`docs/${LEDGER}`)
const PROBE = HAVE_LEDGER ? `docs/${LEDGER}` : 'docs/testing/TIERS.md'

/** Every path-shaped reference to a markdown document under `docs/`. */
const REFERENCE_PATTERN = 'docs/[A-Za-z0-9._/-]+\\.md'

/**
 * `git grep`, with the one behaviour that matters here: exit 1 means "matched nothing", which
 * `execFileSync` raises as a throw. Anything else — git missing, not a repository — must still
 * fail loudly rather than read as "all clear".
 *
 * `--untracked` is deliberate, for the reason `legacy-root.test.ts` gives: without it a
 * brand-new file is invisible until it is committed, so the gate would only ever fire in CI,
 * after the thing it guards had already landed.
 */
const filesMatching = (pattern: string, ...flags: string[]): string[] => {
  try {
    return execFileSync(
      'git',
      ['grep', '-I', '-l', '--untracked', ...flags, '-e', pattern, '--', '.'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    )
      .split(/\r?\n/)
      .filter(Boolean)
  } catch (e) {
    const err = e as { status?: number }
    if (err.status === 1) return []
    throw e
  }
}

const listings = new Map<string, string[]>()

/** `fs.readdirSync`, memoised, and never throwing for a directory that is not there. */
const listing = (dir: string): string[] => {
  let entries = listings.get(dir)
  if (entries === undefined) {
    try {
      entries = fs.readdirSync(dir)
    } catch {
      entries = []
    }
    listings.set(dir, entries)
  }
  return entries
}

/**
 * The REAL spelling of `rel` on disk, resolved case-insensitively — or null if nothing matches it
 * at any case.
 *
 * `fs.existsSync` cannot do this job and neither can `fs.statSync`: on Windows both answer yes to
 * the lower-case spelling, which is exactly the blindness under test. Reading the directory and
 * comparing names is the only check that gives the SAME answer on both platforms, because
 * `readdir` reports what is actually written down rather than what the filesystem is willing to
 * match.
 */
const onDisk = (rel: string): string | null => {
  const real: string[] = []
  for (const part of rel.split('/')) {
    const hit = listing(real.length === 0 ? '.' : real.join('/')).find(
      (entry) => entry.toLowerCase() === part.toLowerCase(),
    )
    if (hit === undefined) return null
    real.push(hit)
  }
  return real.join('/')
}

/** Every distinct `docs/…*.md` reference in the repo, and the files each one appears in. */
const references = (): Map<string, Set<string>> => {
  const found = new Map<string, Set<string>>()
  for (const file of filesMatching(REFERENCE_PATTERN, '-E')) {
    let text: string
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const match of text.matchAll(new RegExp(REFERENCE_PATTERN, 'g'))) {
      const seen = found.get(match[0]) ?? new Set<string>()
      seen.add(file)
      found.set(match[0], seen)
    }
  }
  return found
}

describe.skipIf(!HAVE_LEDGER)('the fidelity ledger has exactly one spelling', () => {
  it('is on disk as docs/DEVIATIONS.md, in that case exactly', () => {
    expect(listing('docs')).toContain(LEDGER)
  })

  it('is the only entry in docs/ that spells it, so a second ledger cannot hide beside it', () => {
    // The assertion that fires on the actual accident. On Linux the two spellings are two
    // directory entries and this list becomes two long; on Windows the write lands in the file
    // that is already there and it stays one. So this is a CI assertion by nature — which is
    // right, because CI is the host where the two paths differ.
    const spellings = listing('docs').filter((e) => e.toLowerCase() === LEDGER.toLowerCase())
    expect(spellings, 'a second, empty ledger has appeared beside the real one').toEqual([LEDGER])
  })

  it('is referenced at that spelling everywhere, and at no other', () => {
    // The gate that would have caught the original bug, one commit before it landed rather than
    // months after. Note what is NOT here: a written-out lower-case spelling to compare against.
    // A literal one would make this file its own first offender — which is what happened to
    // `legacy-root.test.ts`, and is the gate working rather than the gate being wrong. The
    // pattern is built from `LEDGER` and made case-blind by the `i` flag instead.
    const anyCase = LEDGER.replace('.', '\\.')
    const wrong: string[] = []
    for (const file of filesMatching(anyCase, '-i')) {
      const text = fs.readFileSync(file, 'utf8')
      for (const match of text.matchAll(new RegExp(anyCase, 'gi'))) {
        if (match[0] !== LEDGER) wrong.push(`${file}: ${match[0]}`)
      }
    }
    expect(wrong, `the ledger is tracked as docs/${LEDGER} — spell it that way`).toEqual([])
  })
})

describe('no document is referenced at the wrong case', () => {
  it('every reference that names a real file names it at the real case', () => {
    const wrong: string[] = []
    for (const [ref, where] of references()) {
      const real = onDisk(ref)
      // null is a reference to a file that exists at NO case: a dead link, not a case trap, and
      // deliberately out of scope — see the header.
      if (real !== null && real !== ref) {
        wrong.push(`${ref} is really ${real}, referenced in ${[...where].sort().join(', ')}`)
      }
    }
    expect(
      wrong,
      'these open the right file on Windows and a different, missing one on Linux',
    ).toEqual([])
  })

  it('the sweep can see references at all', () => {
    // A gate that quietly stops finding anything passes for ever, so both halves are checked.
    //
    // The floor is a floor, not a count — CLAUDE.md's rule against writing down a derivable
    // number. It exists to fail if the pattern or `git grep` ever stops matching, not to track
    // how many cross-references the corpus has.
    expect(references().size).toBeGreaterThan(20)
  })

  // The public export keeps no upper-case document under docs/ (TIERS.md stays private, Matt,
  // 2026-10-10), so there is nothing with two spellings to probe; the maintainer tree has both.
  it.skipIf(!present(PROBE))('the sweep can tell two cases apart', () => {
    expect([...references().keys()]).toContain(PROBE)

    // And the half that decides whether a reference is WRONG. Without this, every assertion
    // above would pass in silence if `onDisk` were ever reduced to an `fs.existsSync` check,
    // because on Windows that answers yes to both spellings. Handed the wrong case, it must
    // report the right one.
    expect(PROBE.toLowerCase(), 'the probe must have two spellings').not.toBe(PROBE)
    expect(onDisk(PROBE)).toBe(PROBE)
    expect(onDisk(PROBE.toLowerCase())).toBe(PROBE)
    expect(onDisk(`${PROBE}.nothing-is-here`)).toBeNull()
  })
})

describe.skipIf(HAVE_LEDGER || !MAINTAINER_CHECKOUT)('the ledger is missing', () => {
  it('says so in the working repository, rather than passing quietly', () => {
    expect(HAVE_LEDGER, `docs/${LEDGER} is absent; only the public export may lack it`).toBe(true)
  })
})
