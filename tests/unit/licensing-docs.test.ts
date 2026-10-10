// tests/unit/licensing-docs.test.ts — keep the public-facing licensing story in one piece.
//
// ── Why this exists ───────────────────────────────────────────────────────
//
// Working PUBLIC-CHECKLIST.md end to end on 2026-09-12 found four things wrong, and every one
// of them was a *pair of files that had drifted apart* rather than a bug in any single file:
//
//   1. `package.json` had no `"prepare"` script, so the asset denylist hook was installed on
//      exactly one machine, by hand. A fresh clone would have had the hook sitting in the tree,
//      documented, visible, and doing nothing — which `install.mjs`'s own header calls the worst
//      state to be in, "because the repo looks protected".
//   2. `THIRD-PARTY-NOTICES.md` did not exist, while NOTICE and CONTENT-LICENSE.md both pointed at it and
//      D13 made it a *shipping condition*.
//   3. NOTICE and CONTENT-LICENSE.md described a soundtrack (the six Cozendey CC-BY tracks) that
//      D31 had superseded the same day.
//   4. `LICENSE` still does not exist and `package.json` still says UNLICENSED — and those two
//      are one decision, so they must land together or the repo tells a reader two stories.
//
// None of that is catchable by typecheck, lint, or any test about the game. It is catchable by
// asking whether the documents agree with each other and with `package.json`.
//
// ── What it deliberately does NOT do ──────────────────────────────────────
//
// It does not require a LICENSE file. That is Matt's decision (PUBLIC-CHECKLIST Gate 0) and a
// test that fails until he makes it would just get skipped. What it asserts is the *pairing*:
// whichever way he goes, the two halves must say the same thing.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MAINTAINER_CHECKOUT } from './helpers/checkout'

const read = (p: string): string => fs.readFileSync(p, 'utf8')

const pkg = JSON.parse(read('package.json')) as {
  license?: string
  dependencies?: Record<string, string>
  scripts?: Record<string, string>
}

/** Every document a stranger reads to work out what they may do with this repository. */
const PUBLIC_LICENSING_DOCS = [
  'NOTICE',
  'CONTENT-LICENSE.md',
  'THIRD-PARTY-NOTICES.md',
  // The file-by-file asset ruling stays in the private tree (Matt, 2026-10-10).
  ...(MAINTAINER_CHECKOUT ? ['ASSET-PROVENANCE.md'] : []),
  'README.md',
]

// `PUBLIC-CHECKLIST.md` was in that list until 2026-09-13 and should never have been. It is the
// GATE rather than a thing gated — no stranger reads it to work out what they may do — and under
// D33 it is CARRIED into `ff-10yr`: on disk, in `.gitignore`, never committed.
//
// So the assertion was true on every machine that has the file and false on CI, which only ever
// sees the git tree. **It failed on every single `ff-10yr` run from the first commit until it was
// found**, while `pnpm check` stayed green locally by construction — the carried file is right
// there. That is trap 21's shape again in a new costume: two copies of a repository that nothing
// compares, and the one nobody looks at is the one that is right.
//
// The replacement below asserts the thing that actually matters, and it is true in BOTH
// repositories rather than in whichever one you happen to be standing in.

describe('the licensing documents exist', () => {
  it.each(PUBLIC_LICENSING_DOCS)('%s is present and not a stub', (doc) => {
    expect(fs.existsSync(doc), `${doc} is missing`).toBe(true)
    // A file that exists but says nothing satisfies `test -f` and satisfies nobody else. The
    // shortest of these (NOTICE) is ~3 KB; 500 bytes is a floor, not a target.
    expect(read(doc).length, `${doc} is too short to be saying anything`).toBeGreaterThan(500)
  })
})

describe('nothing is tracked and ignored at the same time', () => {
  // The D33 carry — a file on disk, in `.gitignore`, deliberately absent from the history — only
  // works while git and `.gitignore` agree. A `git add -f` breaks that agreement silently: the
  // file is then in the history, `git status` stays clean because it is ignored, and the repo
  // ships something it was designed not to ship. Nothing else in the suite would notice.
  //
  // Stated as an invariant over the whole tree rather than as a list, because a list of carried
  // files is one more pair of things to drift. In `facetedflight2` PUBLIC-CHECKLIST.md is tracked
  // and not ignored; in `ff-10yr` it is ignored and not tracked. Both pass. Only the contradiction
  // fails.
  it('no tracked file is gitignored', () => {
    const out = execFileSync('git', ['ls-files', '--cached', '-i', '--exclude-standard'], {
      encoding: 'utf8',
    })
    const offenders = out.split(/\r?\n/).filter(Boolean)
    expect(
      offenders,
      `these files are committed AND gitignored, which is how a carried file gets published by ` +
        `accident: ${offenders.join(', ')}`,
    ).toEqual([])
  })
})

describe('LICENSE and package.json are one decision', () => {
  // PUBLIC-CHECKLIST Gate 0: "do not settle these two separately". Today both halves are in the
  // unchosen state, so this passes; the moment either moves without the other, it fails and says
  // which half is behind.
  const hasLicenseFile = fs.existsSync('LICENSE')
  const declared = pkg.license ?? 'UNLICENSED'

  it('a LICENSE file and a real SPDX id arrive together', () => {
    expect(
      hasLicenseFile,
      declared === 'UNLICENSED'
        ? 'LICENSE exists but package.json still says UNLICENSED — update the license field'
        : `package.json says "${declared}" but there is no LICENSE file at the repo root`,
    ).toBe(declared !== 'UNLICENSED')
  })

  it('the declared licence is an SPDX identifier, not prose', () => {
    // `"license": "MIT License"` is not valid SPDX and npm/GitHub will not resolve it.
    // Deliberately permissive on the exact id — the choice is Matt's — but not on the shape.
    expect(declared).toMatch(/^[A-Za-z0-9.+-]+$/)
  })
})

describe('THIRD-PARTY-NOTICES.md accounts for everything that ships', () => {
  // D13 makes attribution a shipping condition. A runtime dependency is the one category that
  // can be added in a single `pnpm add` and reach a player the same afternoon, so it is the one
  // worth checking mechanically. Dev dependencies never reach `dist/` and are out of scope.
  const credits = read('THIRD-PARTY-NOTICES.md')
  const runtimeDeps = Object.keys(pkg.dependencies ?? {})

  it('there is at least one runtime dependency to account for', () => {
    // Guards the guard: if `dependencies` were ever emptied or renamed, the `it.each` below
    // would silently assert nothing at all and go green.
    expect(runtimeDeps.length).toBeGreaterThan(0)
  })

  it.each(runtimeDeps)('%s is credited', (dep) => {
    expect(
      credits,
      `${dep} ships in the bundle but is not named in THIRD-PARTY-NOTICES.md`,
    ).toContain(dep)
  })

  it('names a licence for the third-party code it lists', () => {
    expect(credits).toMatch(/\bMIT\b/)
  })

  // DEV-362 follow-up. A font is the other thing that can reach a player the day
  // somebody adds one: a row in the asset manifest and a line of FontFace. It
  // carries its licence with it (CRYSTAL's is CC BY-SA 4.0, attribution kept
  // with the copy), so every font the bucket serves must be named here, by its
  // bucket path, beside a licence and version.
  const fontRows = (
    JSON.parse(read('tools/assets/required-assets.json')) as {
      assets: { kind: string; path: string }[]
    }
  ).assets.filter((a) => a.kind === 'font')

  it('there is a font row to account for', () => {
    expect(fontRows.length).toBeGreaterThan(0)
  })

  it.each(fontRows.map((r) => r.path))('%s is credited, with its licence', (p) => {
    expect(credits, `${p} is served but not named in THIRD-PARTY-NOTICES.md`).toContain(p)
    expect(credits).toMatch(/CC BY-SA 4\.0/)
  })
})

describe('the denylist mechanism cannot be silently uninstalled', () => {
  // The bug this catches actually happened: no `prepare` script existed, so `core.hooksPath` was
  // set by hand on one machine and every other clone was unprotected. ASSET-PROVENANCE §5 and
  // PUBLIC-CHECKLIST Gate 1 both require this line.
  it('package.json has a prepare script that wires the git hooks', () => {
    const prepare = pkg.scripts?.prepare ?? ''
    expect(prepare, 'package.json "prepare" must run .githooks/install.mjs').toContain(
      '.githooks/install.mjs',
    )
  })

  it.each(['.githooks/install.mjs', '.githooks/pre-commit', '.githooks/check-denylist.mjs'])(
    '%s is present',
    (p) => {
      expect(fs.existsSync(p), `${p} is missing — the hook cannot run`).toBe(true)
    },
  )

  it('CI runs the same checker over the tree AND the history', () => {
    // Layer 3 is the only layer nobody in a hurry can skip (ASSET-PROVENANCE §5). A workflow
    // that lost its `--history` job would still look like a gate and would stop being one.
    const wf = read('.github/workflows/asset-denylist.yml')
    expect(wf).toContain('check-denylist.mjs --tree')
    expect(wf).toContain('check-denylist.mjs --history')
  })
})
