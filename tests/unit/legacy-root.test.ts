// tests/unit/legacy-root.test.ts: the 2016 Unity project's location has NO default.
//
// ── Why this exists ───────────────────────────────────────────────────────
//
// A drive-lettered home-directory path to the Unity backup was once written out in **66 tracked
// files**. That was three problems wearing one coat:
//
//   1. **It does not work on a second machine**, and it does not fail usefully there either. A
//      tool that cannot find the Unity project reports it as ABSENT, and in this codebase absence
//      is indistinguishable from a scene that contains nothing (CLAUDE.md's two-YAML-dialects
//      trap, one level up). The first symptom would be a confidently wrong extraction.
//   2. **It was 66 places to edit** when a drive letter moved.
//   3. **It names a home directory**, which a repository strangers clone must not carry
//      (PUBLIC-CHECKLIST Gate 4; public-repo plan step 3).
//
// The first fix was `$FF2_LEGACY` with a default kept in CLAUDE.md, `tools/legacy-root.mjs` and
// `tools/legacy_root.py`, with this test holding the three copies together. The second (this
// one) removes the default altogether: the variable is read from the process environment or from
// the gitignored `.env` (documented in `.env.example`), and a tool that needs the project and has
// none says so, naming the variable, instead of looking somewhere only one machine has.
//
// ── What it deliberately does NOT do ──────────────────────────────────────
//
// It does not require the Unity project to be present. Almost nothing in `tests/unit/` does, and
// CI has no copy of it. Every assertion below sets `FF2_LEGACY` and `FF2_ENV_FILE` itself, so the
// result does not depend on whose `.env` is on disk. (`FF2_ENV_FILE` is the module's one test
// seam: it points the `.env` read somewhere else.)

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LEGACY_UNSET_MESSAGE,
  LegacyRootUnsetError,
  legacyAvailable,
  legacyPath,
  legacyRoot,
  legacyRootOrNull,
  refPath,
  refRoot,
  relativeToLegacy,
} from '../../tools/legacy-root.mjs'
import { MAINTAINER_CHECKOUT, present } from './helpers/checkout'

const read = (p: string): string => fs.readFileSync(p, 'utf8')

/** Every absolute path under a Windows home directory, however it is spelled. */
const HOME_DIR_PATTERN = /[A-Za-z]:[/\\]Users[/\\](?!<user>)[A-Za-z0-9._-]+[/\\]/

const NO_ENV_FILE = path.join(os.tmpdir(), 'ff2-legacy-root-test-no-such-env-file')

/** Run `fn` with the three variables set (or deleted, when undefined), then put them back. */
function withEnv(
  vars: { FF2_LEGACY?: string; FF2_REF?: string; FF2_ENV_FILE?: string },
  fn: () => void,
): void {
  const names = ['FF2_LEGACY', 'FF2_REF', 'FF2_ENV_FILE'] as const
  const before = Object.fromEntries(names.map((n) => [n, process.env[n]]))
  try {
    for (const n of names) {
      const v = vars[n]
      if (v === undefined) delete process.env[n]
      else process.env[n] = v
    }
    fn()
  } finally {
    for (const n of names) {
      const v = before[n]
      if (v === undefined) delete process.env[n]
      else process.env[n] = v
    }
  }
}

/** A throwaway `.env` file; returns its path. */
function tempEnvFile(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff2-env-'))
  const file = path.join(dir, '.env')
  fs.writeFileSync(file, contents)
  return file
}

// CLAUDE.md is agent instructions and the public export leaves it out
// (plan/PUBLIC-REPO-facetedflight.md section 1.6), so its row skips there and says so here.
const HAVE_CLAUDE_MD = present('CLAUDE.md')

describe.skipIf(HAVE_CLAUDE_MD || !MAINTAINER_CHECKOUT)('CLAUDE.md is missing', () => {
  it('says so in the working repository, rather than passing quietly', () => {
    expect(HAVE_CLAUDE_MD, 'CLAUDE.md is absent; only the public export may lack it').toBe(true)
  })
})

describe('the legacy project root has no default and is documented, not written down', () => {
  it.skipIf(!HAVE_CLAUDE_MD)('CLAUDE.md says where the path lives and does not state it', () => {
    const claude = read('CLAUDE.md')
    expect(claude).toContain('$FF2_LEGACY')
    expect(claude).toContain('.env.example')
    expect(claude, 'CLAUDE.md names a home directory').not.toMatch(HOME_DIR_PATTERN)
  })

  it('.env.example documents both variables', () => {
    const example = read('.env.example')
    expect(example).toMatch(/^#?\s*FF2_LEGACY=/m)
    expect(example).toMatch(/^#?\s*FF2_REF=/m)
    expect(example, '.env.example names a home directory').not.toMatch(HOME_DIR_PATTERN)
  })

  it('neither module carries a default path', () => {
    for (const f of ['tools/legacy-root.mjs', 'tools/legacy_root.py']) {
      const s = read(f)
      expect(s, `${f} names a home directory`).not.toMatch(HOME_DIR_PATTERN)
      expect(s, `${f} still declares a default`).not.toMatch(/DEFAULT_LEGACY_ROOT\s*=/)
    }
  })

  it('both modules describe the same contract, so neither can be read alone and be wrong', () => {
    for (const f of ['tools/legacy-root.mjs', 'tools/legacy_root.py']) {
      const s = read(f)
      expect(s, `${f} must name the environment variable`).toContain('FF2_LEGACY')
      expect(s, `${f} must name .env`).toContain('.env')
      expect(s, `${f} must carry the read-only rule`).toMatch(/READ-ONLY/)
      expect(s, `${f} must carry the unset message`).toContain('FF2_LEGACY is not set')
      expect(s, `${f} must say the project is not distributed`).toContain('not distributed')
    }
  })
})

describe('legacyRoot() and friends', () => {
  it('fails with a message that names the variable when it is unset', () => {
    withEnv({ FF2_ENV_FILE: NO_ENV_FILE }, () => {
      expect(() => legacyRoot()).toThrow(LegacyRootUnsetError)
      expect(() => legacyRoot()).toThrow(/FF2_LEGACY/)
      expect(() => legacyRoot()).toThrow(LEGACY_UNSET_MESSAGE)
      expect(legacyRootOrNull()).toBeNull()
      expect(legacyAvailable()).toBe(false)
      expect(() => legacyPath('Assets')).toThrow(LegacyRootUnsetError)
    })
  })

  it('whitespace-only is not a setting', () => {
    // A shell that exports an empty variable must get the message, not an empty root that
    // silently resolves every path to the working directory.
    withEnv({ FF2_LEGACY: '   ', FF2_ENV_FILE: NO_ENV_FILE }, () => {
      expect(legacyRootOrNull()).toBeNull()
      expect(() => legacyRoot()).toThrow(LegacyRootUnsetError)
    })
  })

  it('reads $FF2_LEGACY from the environment', () => {
    withEnv({ FF2_LEGACY: 'D:/somewhere/else', FF2_ENV_FILE: NO_ENV_FILE }, () => {
      expect(legacyRoot()).toBe('D:/somewhere/else')
    })
  })

  it('falls back to the .env file, tolerating quotes, comments, export and a BOM', () => {
    const quoted = tempEnvFile(
      '\uFEFF# a comment\r\nVITE_ASSET_BASE_URL=/\r\nFF2_LEGACY="D:/my games/FF"\r\n',
    )
    const bare = tempEnvFile('export FF2_LEGACY=E:/plain\n')
    const empty = tempEnvFile('FF2_LEGACY=\nOTHER=1\n')
    withEnv({ FF2_ENV_FILE: quoted }, () => expect(legacyRoot()).toBe('D:/my games/FF'))
    withEnv({ FF2_ENV_FILE: bare }, () => expect(legacyRoot()).toBe('E:/plain'))
    withEnv({ FF2_ENV_FILE: empty }, () => expect(legacyRootOrNull()).toBeNull())
  })

  it('the shell wins over the .env file', () => {
    const file = tempEnvFile('FF2_LEGACY=D:/from-the-file\n')
    withEnv({ FF2_LEGACY: 'D:/from-the-shell', FF2_ENV_FILE: file }, () => {
      expect(legacyRoot()).toBe('D:/from-the-shell')
    })
  })

  it('does not copy the .env file into process.env', () => {
    const file = tempEnvFile('FF2_LEGACY=D:/x\nFF2_PROBE_LEAK=1\n')
    withEnv({ FF2_ENV_FILE: file }, () => {
      legacyRoot()
      expect(process.env.FF2_PROBE_LEAK).toBeUndefined()
      expect(process.env.FF2_LEGACY).toBeUndefined()
    })
  })

  it('hands out forward slashes, because provenance strings are compared as bytes', () => {
    // `pnpm extract:check` fails on any diff. If `path.join` leaked a backslash here, the check
    // would fail on a machine that had produced identical DATA.
    withEnv({ FF2_LEGACY: 'D:/unity/Project', FF2_ENV_FILE: NO_ENV_FILE }, () => {
      expect(legacyPath('Assets', 'Faceted Flight')).not.toContain('\\')
      expect(refPath('king-tide', 'CLAUDE.md')).not.toContain('\\')
    })
  })

  it('relativeToLegacy strips the root, and leaves anything else alone', () => {
    withEnv({ FF2_LEGACY: 'D:/unity/Project', FF2_ENV_FILE: NO_ENV_FILE }, () => {
      expect(relativeToLegacy(legacyPath('Assets', 'x.unity'))).toBe('Assets/x.unity')
      // Applied indiscriminately on purpose: a path that is not under the root comes back whole
      // rather than mangled, so callers need no conditional.
      expect(relativeToLegacy('D:/elsewhere/y.unity')).toBe('D:/elsewhere/y.unity')
      // A prefix that merely *starts* the same is not inside it.
      expect(relativeToLegacy('D:/unity/Project-other/z')).toBe('D:/unity/Project-other/z')
    })
    // Nothing configured, nothing to strip, nothing thrown.
    withEnv({ FF2_ENV_FILE: NO_ENV_FILE }, () => {
      expect(relativeToLegacy('D:/elsewhere/y.unity')).toBe('D:/elsewhere/y.unity')
    })
  })

  it('refRoot() is FF2_REF, else derived from FF2_LEGACY, else a clear failure', () => {
    // Assert the RELATIONSHIP, not the value. Re-deriving it the way the implementation does
    // would agree with it even when both were wrong (CLAUDE.md: test the geometry, not the
    // rotation).
    const legacy = 'D:/projects/unity/FacetedFlight/Backup'
    withEnv({ FF2_LEGACY: legacy, FF2_ENV_FILE: NO_ENV_FILE }, () => {
      expect(legacyRoot().startsWith(`${refRoot()}/`)).toBe(true)
      expect(refRoot().endsWith('/projects')).toBe(true)
    })
    withEnv({ FF2_LEGACY: legacy, FF2_REF: 'E:/refs', FF2_ENV_FILE: NO_ENV_FILE }, () => {
      expect(refPath('polyfish')).toBe('E:/refs/polyfish')
    })
    withEnv({ FF2_ENV_FILE: NO_ENV_FILE }, () => {
      expect(() => refRoot()).toThrow(/FF2_REF/)
      expect(() => refRoot()).toThrow(/FF2_LEGACY/)
    })
  })

  it('refRoot() does not consult the host: it slices a string, it does not resolve a path', () => {
    // The regression this exists for. `path.resolve` is PLATFORM-DEPENDENT: to POSIX `node:path`,
    // a `C:/…` path is RELATIVE (`C:` is just a directory name), so on the Linux CI runner it
    // prepended the working directory. Green on Windows, red in CI.
    //
    // Changing directory and asking again is the assertion that cannot be satisfied by a
    // platform-dependent implementation on any platform.
    const cwd = process.cwd()
    // `process.chdir` does not exist inside a worker thread, and which pool vitest uses is not
    // this test's business; the prefix assertion in the test above catches the same bug.
    const canChdir = typeof process.chdir === 'function'
    withEnv({ FF2_LEGACY: 'C:/a/b/c/d/e', FF2_ENV_FILE: NO_ENV_FILE }, () => {
      try {
        const here = refRoot()
        expect(here).toBe('C:/a/b')
        expect(here).not.toContain(cwd.replaceAll('\\', '/'))
        if (canChdir) {
          process.chdir(os.tmpdir())
          expect(refRoot()).toBe(here)
          expect(refRoot()).not.toContain(os.tmpdir().replaceAll('\\', '/'))
        }
      } finally {
        if (canChdir) process.chdir(cwd)
      }
    })
  })
})

describe('legacy_root.py follows the same contract', () => {
  // Blender and UnityPy cannot import the Node module, so the Python half is a copy. Run it for
  // real where a Python is on the PATH; there is a loud counterpart for the host without one.
  const python = (() => {
    for (const exe of ['python3', 'python']) {
      try {
        execFileSync(exe, ['-I', '-c', 'import sys; assert sys.version_info >= (3, 8)'], {
          stdio: 'ignore',
        })
        return exe
      } catch {
        // try the next name
      }
    }
    return null
  })()

  const run = (env: Record<string, string>, code: string): string =>
    execFileSync(python as string, ['-I', '-c', code], {
      cwd: path.resolve('tools'),
      encoding: 'utf8',
      env: { ...process.env, FF2_LEGACY: '', FF2_ENV_FILE: '', ...env },
    })

  it.skipIf(python === null)('raises a message naming the variable when it is unset', () => {
    // -I ignores PYTHON* variables and the script dir, so put tools/ on the path explicitly.
    const code = [
      'import sys; sys.path.insert(0, ".")',
      'import legacy_root as L',
      'L._env_value = lambda name: None',
      'try:',
      '    L.legacy_root()',
      'except L.LegacyRootUnsetError as e:',
      '    print("RAISED", "FF2_LEGACY is not set" in str(e))',
      'print("AVAILABLE", L.legacy_available())',
    ].join('\n')
    const out = run({}, code)
    expect(out).toContain('RAISED True')
    expect(out).toContain('AVAILABLE False')
  })

  it.skipIf(python === null)('reads the environment first', () => {
    const code = [
      'import sys; sys.path.insert(0, ".")',
      'import legacy_root as L',
      'print("ROOT", L.legacy_root())',
    ].join('\n')
    expect(run({ FF2_LEGACY: 'D:/py/root' }, code)).toContain('ROOT D:/py/root')
  })

  it.runIf(python === null)(
    'LOUD: no python on this host, so the Python half is unexercised',
    () => {
      expect(python).toBeNull()
    },
  )
})

// ── The gate ──────────────────────────────────────────────────────────────
//
// The two modules above are only worth having if nothing ELSE hardcodes the path. That is what
// went wrong the first time: the convention existed and 66 files ignored it.
//
// The allowlist below is the remaining work made visible. Every entry has an owner and a reason,
// and the list may only ever get shorter. A file that is not on it and names a home directory
// fails this test the moment it is added, which is the point.

/** Files that may still name a home directory, each for a stated reason. */
const ALLOWED: ReadonlyArray<readonly [pattern: RegExp, why: string]> = [
  // CLAUDE.md and the two legacy-root modules were on this list while they held the default
  // path. They no longer do (the path lives in each developer's gitignored .env), so they are
  // held to the same rule as everything else.
  [
    /^PUBLIC-CHECKLIST\.md$/,
    'it describes the leak itself; the literal string is its subject, not an instance. It is the ' +
      'gate rather than the thing gated, so D33 leaves it out of the curated first commit. ' +
      'D33 in DECISIONS.md said the same thing and was SCRUBBED instead, because DECISIONS.md ' +
      'does ship — `C:/Users/<user>/` reads identically there.',
  ],
  // The list is down to one, and it is the path being DESCRIBED rather than used. The 21 entries
  // that were here (14 generated levels, 2 extractors, 5 oracle tests) are gone, and they went in
  // one change each rather than 21 edits:
  //
  //   * `tools/extract/level.mjs` now sanitises at `writeOut()`, the single boundary every
  //     generated file passes through, so all four of its absolute-path emitters are covered and
  //     so is the next one anybody adds. Two of the four were not the obvious ones.
  //   * The oracle tests call `legacyRoot()` / `legacyPath()` like everything else.
]

const reasonFor = (file: string): string | null =>
  ALLOWED.find(([pattern]) => pattern.test(file))?.[1] ?? null

/**
 * Every file in the repo that names a home directory, from git so that `node_modules`, `public/`
 * and everything else gitignored stays out of it.
 *
 * `--untracked` is deliberate: without it a brand-new file is invisible until it is committed, so
 * the gate would only ever fire in CI, after the thing it is guarding had already landed. That is
 * precisely how `turn-indicator.test.ts` went red on five consecutive pushes while every local run
 * was green.
 */
/**
 * Exactly the set `offenders()` searches: tracked files, plus untracked ones git is not ignoring.
 *
 * This is what makes an allowlist entry APPLICABLE. In `ff-10yr` (D33) `PUBLIC-CHECKLIST.md` is
 * CARRIED — on disk, gitignored, never committed — so it is not in this set, its entry permits
 * nothing there, and "dead" would be the wrong word for it.
 */
const scanned = (): string[] =>
  execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8',
  })
    .split(/\r?\n/)
    .filter(Boolean)

const offenders = (): string[] => {
  let out: string
  try {
    out = execFileSync(
      'git',
      ['grep', '-l', '--untracked', '-E', 'C:[/\\\\]Users[/\\\\][A-Za-z0-9._-]+[/\\\\]', '--', '.'],
      { encoding: 'utf8' },
    )
  } catch (e) {
    // `git grep` exits 1 when it matches NOTHING, which `execFileSync` turns into a throw. Today
    // there are four matches so this branch is unreachable — and the day the allowlist finally
    // empties is exactly the day it would start throwing instead of passing. Anything else
    // (git missing, not a repo) must still fail loudly rather than read as "all clear".
    const err = e as { status?: number; stderr?: string }
    if (err.status !== 1) throw e
    out = ''
  }
  return out.split('\n').filter(Boolean)
}

describe('no file hardcodes a home directory without a stated reason', () => {
  it('every tracked file that names one is on the allowlist', () => {
    const unexplained = offenders().filter((f) => reasonFor(f) === null)
    expect(
      unexplained,
      'add the path to tools/legacy-root.mjs (or legacy_root.py) instead of hardcoding it — ' +
        'or, if it genuinely belongs, add it to ALLOWED with a reason',
    ).toEqual([])
  })

  it('the allowlist has no dead entries, so it can only shrink', () => {
    // An allowlist that outlives its offenders stops being a to-do list and starts being
    // permission.
    //
    // DEAD is not the same as NOT APPLICABLE, and this file now runs in two repositories. In
    // `ff-10yr` (D33) `PUBLIC-CHECKLIST.md` is CARRIED — present on disk, in `.gitignore`, never
    // committed — so `git grep` cannot see it and the entry would read as dead when the file it
    // names simply is not part of that repo. An entry whose file is absent is not an entry that
    // outlived its purpose; it is one that has no purpose HERE.
    //
    // The distinction is the point: this test fired on exactly this case the first time the new
    // repo ran its own `pnpm check`, which is the gate working rather than the gate being wrong.
    const live = offenders()
    const visible = scanned()
    const dead = ALLOWED.filter(
      ([pattern]) =>
        // APPLICABLE: the gate can see a file this entry covers …
        visible.some((f) => pattern.test(f)) &&
        // … and none of them needs the permission any more.
        !live.some((f) => pattern.test(f)),
    ).map(([pattern]) => String(pattern))
    expect(dead, 'these allowlist entries no longer match any file — delete them').toEqual([])
  })

  it('nothing under src/ names one at all, ever', () => {
    // The shipped tree is the one place with no excuse: nothing under `src/` reads the Unity
    // project at runtime, so a path there can only be a comment that leaked.
    const inSrc = offenders().filter((f) => f.startsWith('src/'))
    expect(inSrc).toEqual([])
  })

  it('HOME_DIR_PATTERN recognises the shape it is looking for', () => {
    // The gate is only as good as its regex, and a regex that matched nothing would pass every
    // assertion above in silence.
    //
    // The positive examples are ASSEMBLED rather than written out, because a literal one here
    // trips the gate — this file was its own first offender, which is the gate working. What is
    // being caught is the SHAPE `<drive>:/Users/<anyone>/`, not one developer, so the examples
    // use names nobody has.
    const home = (user: string, sep = '/'): string => ['C:', 'Users', user, 'projects'].join(sep)

    expect(HOME_DIR_PATTERN.test(home('someone'))).toBe(true)
    expect(HOME_DIR_PATTERN.test(home('someone.else', '\\'))).toBe(true)
    expect(HOME_DIR_PATTERN.test(home('<user>'))).toBe(false)
    expect(HOME_DIR_PATTERN.test('$FF2_LEGACY/Assets')).toBe(false)
  })
})
