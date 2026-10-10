// tests/unit/build-version.test.ts — the build version is a real version, and
// the three places that assert its SHAPE all assert the same shape. DEV-315.
//
// ── What went wrong ──────────────────────────────────────────────────────
//
// `package.json`'s `version` sat at `0.0.0` — npm's scaffold default, never
// touched — for the entire life of the port. `BUILD_VERSION` is `v${version}`,
// so every log line, every `?perf=1` capture, every checklist result and every
// row in `docs/plan/VR-PERF-TAIL.md` says `v0.0.0`, and **not one artefact this
// project has produced can be attributed to a build.** VR-PERF-TAIL §"Anything
// about a build" says so in its own limitations section: *both runs analysed
// are `"version":"v0.0.0"`*, so the two cannot be told apart.
//
// That is not a bug in a code path. It is a default that nothing reads AS A
// VALUE — the two e2e specs below assert the SHAPE, and `v0.0.0` has the right
// shape — so nothing could ever have gone red about it. This file is the one
// assertion somebody has to edit on purpose. (CLAUDE.md, *"changing a shipped
// default is a spec-touching change"*; DEV-266.)
//
// ── Why the shape lives here and not only in Playwright ──────────────────
//
// CI runs `pnpm check`, not Playwright, so a malformed version — `"0.9"`,
// `"0.9.0-rc1"`, a `v` written twice — is today visible only to whoever chooses
// to run a headed browser. It costs a millisecond to refuse it on the gate that
// actually runs.
//
// And the shape was written down THREE times: once in each of the two e2e specs
// and once here. That is a derivable thing copied into three files, which is
// the exact failure CLAUDE.md's *"do not write the count down"* rule is about
// and which has been stale in three files every single time it has happened
// here. So the third assertion below reads those two specs off disk and refuses
// a copy that has drifted from this one. It does NOT import from `src/` or from
// the specs: `src/boot/version.ts` evaluates `import.meta.env.MODE` at module
// scope, and an import edge from a Playwright spec into `src/` has already
// killed a whole e2e collection once.

import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The shape `BUILD_VERSION` must have, as it appears in the two e2e specs.
 *
 * Held as the SOURCE TEXT rather than as a `RegExp`, because the drift check
 * below compares it against what is written in those files, and a `RegExp`
 * object's `.source` would let `/^v\d+\.\d+\.\d+$/` and a differently-escaped
 * but equivalent spelling compare equal while reading differently.
 */
const SHAPE_SOURCE = String.raw`/^v\d+\.\d+\.\d+$/`

/** The specs that assert the page's build version (`body[data-build]` since DEV-614), and therefore the shape. */
const SPECS = ['tests/e2e/boot.spec.ts', 'tests/e2e/production-bundle.spec.ts']

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { version: string }

describe('the build version', () => {
  it('is a three-part semver, the shape every reader asserts', () => {
    expect(`v${pkg.version}`).toMatch(new RegExp(SHAPE_SOURCE.slice(1, -1)))
  })

  it('is not the scaffold default that npm writes', () => {
    // The whole of DEV-315. `0.0.0` is what `npm init` writes and what this
    // repo shipped for a year; a build that reports it is a build nobody can
    // identify afterwards.
    expect(
      pkg.version,
      'package.json is back at the scaffold default — every capture this build takes will be unattributable',
    ).not.toBe('0.0.0')
  })

  it('is asserted with the same shape by every spec that checks it', () => {
    for (const spec of SPECS) {
      const src = fs.readFileSync(spec, 'utf8')
      expect(src, `${spec} no longer asserts body[data-build]`).toContain("'data-build'")
      expect(src, `${spec} asserts a different shape than this file pins`).toContain(SHAPE_SOURCE)
    }
  })
})
