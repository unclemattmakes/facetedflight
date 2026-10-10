// tools/legacy-root.mjs — where the 2016 Unity project is, asked once.
//
// ── Why this exists ──────────────────────────────────────────────────────
//
// A drive-lettered absolute path to the Unity backup
// was written out in **66 tracked files**. That is 66 places to change when a
// drive letter moves, 66 chances for the repo to disagree with itself about
// where the game is, and a username in the clear throughout. The docs were
// normalised to `$FF2_LEGACY` first; this is the half that runs.
//
// **It also makes the repo work on a second machine**, which is the part worth
// more than the tidiness: every tool and test that reads the Unity project
// hard-coded one person's home directory, so on any other machine they did not
// fail usefully — they reported the project as ABSENT, which in this codebase
// is indistinguishable from a scene that contains nothing (CLAUDE.md's YAML
// dialect trap, one level up).
//
// ── The contract ─────────────────────────────────────────────────────────
//
//   FF2_LEGACY   the Unity project root. NO DEFAULT (public-repo plan step 3):
//                a path with a username in it does not belong in a tree
//                strangers clone, and a tool that cannot find the project
//                should say so rather than look somewhere that only exists on
//                one machine. It is read from the process environment, or
//                failing that from the gitignored `.env` beside package.json
//                (documented in .env.example). Unset, `legacyRoot()` throws
//                `LegacyRootUnsetError`; `legacyRootOrNull()` and
//                `legacyAvailable()` are the forms that do not throw, for
//                code that must run (and skip) on a host with no Unity project.
//   FF2_REF      the folder holding the two read-only reference projects.
//                Same rules; if unset it is derived from FF2_LEGACY.
//
// **STRICTLY READ-ONLY.** CI asserts no file under this root has an mtime newer
// than the run. Nothing in this repository may write there — not a temp file,
// not a `.meta`, not a Blender autosave.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** What every "not set" message says, so the fix is the same wherever it surfaces. */
export const LEGACY_UNSET_MESSAGE =
  'FF2_LEGACY is not set. Set it to the 2016 Unity project (the folder that contains Assets/); ' +
  "extraction needs the original game's project, which is not distributed. Put FF2_LEGACY=<path> " +
  'in the gitignored .env beside package.json (see .env.example) or export it in your shell.'

export class LegacyRootUnsetError extends Error {
  constructor(message = LEGACY_UNSET_MESSAGE) {
    super(message)
    this.name = 'LegacyRootUnsetError'
  }
}

/**
 * One variable from the process environment, else from `.env` at the repo root.
 *
 * Parsed here, for just the name asked for, rather than with `process.loadEnvFile`: that
 * would copy every line (the `VITE_` ones included) into `process.env` for whatever imported
 * this module. Plain `KEY=value`, optional quotes, `#` comments, a BOM tolerated; the shell
 * wins over the file.
 */
const envValue = (name) => {
  const fromShell = process.env[name]?.trim()
  if (fromShell) return fromShell
  let text
  try {
    // FF2_ENV_FILE exists so a unit test can point this at a file of its own (or at nothing)
    // and stay hermetic whatever the developer's real .env says. Nothing else sets it.
    text = fs.readFileSync(process.env.FF2_ENV_FILE?.trim() || path.join(REPO, '.env'), 'utf8')
  } catch {
    return null
  }
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!m || m[1] !== name) continue
    const value = m[2].replace(/^(["'])(.*)\1$/, '$2').trim()
    if (value) return value
  }
  return null
}

/**
 * Windows separators out, forward slashes in — in ONE place.
 *
 * Every path this module hands out goes through here, because a provenance
 * string is a byte comparison: `path.join` gives you `\` on Windows and `/`
 * everywhere else, and `pnpm extract:check` would then fail on data that is
 * identical. The literal backslash appears exactly once in this file.
 */
const BACKSLASH = '\\'
const toForward = (p) => String(p).split(BACKSLASH).join('/')

/** The Unity project root, or null when `FF2_LEGACY` is not set. Never throws. */
export const legacyRootOrNull = () => envValue('FF2_LEGACY')

/** The Unity project root: `$FF2_LEGACY`. Throws `LegacyRootUnsetError` when it is not set. */
export const legacyRoot = () => {
  const root = legacyRootOrNull()
  if (!root) throw new LegacyRootUnsetError()
  return root
}

/** True when the read-only Unity project is set AND actually mounted on this machine. */
export const legacyAvailable = () => {
  const root = legacyRootOrNull()
  return root !== null && fs.existsSync(root)
}

/**
 * A path inside the Unity project.
 *
 * Forward slashes on the way out, because every provenance string in the
 * generated trees uses them and a Windows backslash would make
 * `pnpm extract:check` fail on a machine that produced identical DATA.
 */
export const legacyPath = (...parts) => toForward(path.join(legacyRoot(), ...parts))

/**
 * Strip the project root off an absolute path, for anything that gets WRITTEN
 * DOWN — provenance in the generated trees, above all.
 *
 * A generated file that records `C:/Users/<somebody>/...` is a file whose bytes
 * depend on whose machine ran the extractor, which breaks `extract:check` for
 * everyone else and leaks a home directory into a release. Returns the path
 * unchanged if it is not under the root, so it can be applied indiscriminately.
 */
export const relativeToLegacy = (absolute) => {
  const configured = legacyRootOrNull()
  // No root configured means nothing to strip: hand the path back whole.
  if (!configured) return toForward(absolute)
  const root = toForward(configured).replace(/\/+$/, '')
  const normalised = toForward(absolute)
  return normalised.startsWith(`${root}/`) ? normalised.slice(root.length + 1) : normalised
}

/**
 * Refuse (throw) when `target` is the Unity project or anywhere inside it. TL-19, hard rule 1.
 *
 * Two tools carried their own copy of this check (constants.mjs, level.mjs) and the rest of
 * the writers that read the project had none. Call it on every path a tool is about to write.
 * `root` defaults to `legacyRoot()`; a tool with a `--unity`/`--src` override passes that.
 *
 * Compared as lower-cased, forward-slashed STRINGS and never through `path.resolve` on the
 * root: to POSIX `node:path` a `C:/...` root is a relative path (CLAUDE.md, trap 25), so
 * resolving it would prepend the working directory. `target` IS a host path, so it is
 * resolved (against the working directory) before the comparison. The test is a whole-segment
 * prefix, so a sibling folder that merely starts with the root's name is not caught.
 * Returns the forward-slashed absolute target so a caller can write to what it checked.
 */
export const assertOutsideLegacy = (target, root = legacyRootOrNull()) => {
  const abs = toForward(path.resolve(String(target)))
  // No root configured: there is no project to be inside of.
  if (!root) return abs
  const base = toForward(root).replace(/\/+$/, '').toLowerCase()
  const lower = abs.toLowerCase()
  if (lower === base || lower.startsWith(`${base}/`)) {
    throw new Error(`REFUSING to write inside the read-only legacy project: ${abs}`)
  }
  return abs
}

/**
 * Replace the project root in `text` with the variable that names it, in both spellings
 * (forward slashes, and the doubled backslashes of a JSON string): `$FF2_LEGACY`.
 *
 * Every generated file leaves through here, so a provenance string never carries a home
 * directory (the tracked `content/levels/` bytes are compared by `pnpm extract:check`, and a
 * username in them fails that check on every machine but one). Fixing emitters one at a time
 * is a convention; fixing it at the boundary covers the next emitter too. Moved verbatim from
 * level.mjs's `portable`.
 */
export const portableText = (text, root = legacyRootOrNull()) => {
  if (!root) return text
  const fwd = toForward(root).replace(/\/+$/, '')
  const back = fwd.split('/').join(BACKSLASH + BACKSLASH)
  return text.split(fwd).join('$FF2_LEGACY').split(back).join('$FF2_LEGACY')
}

/**
 * The folder the two read-only REFERENCE projects sit in — `$FF2_REF`.
 *
 * If unset, derived from FF2_LEGACY: the legacy project's grandparent's parent, i.e. the `projects/`
 * directory the Unity backup lives three levels under, because on the only
 * machine that has ever run this they are siblings. Derived rather than written
 * out a second time: two absolute paths in one file is two things to update.
 *
 * **Sliced as a string, not resolved as a path**, and this cost a red CI run.
 * `path.resolve` is platform-dependent: to POSIX `node:path`, `C:/Users/...` is
 * a RELATIVE path — `C:` is just a directory name — so on the Linux runner it
 * prepended the working directory and produced
 * `/home/runner/work/.../C:/<home>/projects`. The value here is a Windows
 * path held on any host, so the only correct operation on it is the one that
 * does not consult the host. The irony is exact: the change this module exists
 * for is *"make the repo work on a second machine"*, and it shipped a bug that
 * only a second machine could see, because `pnpm check` was only ever run on
 * the first one.
 *
 * `king-tide` and `polyfish` are Matt's own, and nothing that ships reads them —
 * they are cited by the plan and by the historical `tools/wf-*.js` launchers.
 */
export const refRoot = () => {
  const explicit = envValue('FF2_REF')
  if (explicit) return explicit
  const legacy = legacyRootOrNull()
  if (!legacy) {
    throw new LegacyRootUnsetError(
      'FF2_REF is not set, and it is derived from FF2_LEGACY, which is not set either. ' +
        LEGACY_UNSET_MESSAGE,
    )
  }
  return toForward(legacy).replace(/\/+$/, '').split('/').slice(0, -3).join('/')
}

/** A path inside a reference project, e.g. `refPath('king-tide', 'CLAUDE.md')`. */
export const refPath = (...parts) => toForward(path.join(refRoot(), ...parts))

/**
 * The Unity project root, or a path that cannot exist when `FF2_LEGACY` is not set.
 *
 * For tests that build a file path at module scope and then ask `fs.existsSync` before
 * touching it: on a host with no Unity project they must COLLECT and skip, not throw. Nothing
 * that reads the project for real should use this; use `legacyRoot()` and let it fail loudly.
 */
export const legacyRootOrAbsent = () => legacyRootOrNull() ?? '/ff2-legacy-is-not-set'
