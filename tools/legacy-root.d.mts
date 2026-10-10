// Type declarations for legacy-root.mjs. See png.d.mts for why these are separate.

/** What every "FF2_LEGACY is not set" failure says. */
export declare const LEGACY_UNSET_MESSAGE: string

/** Thrown by `legacyRoot()` (and `refRoot()`) when `FF2_LEGACY` is neither set nor in `.env`. */
export declare class LegacyRootUnsetError extends Error {
  constructor(message?: string)
}

/** The read-only 2016 Unity project root, or null when `$FF2_LEGACY` is not set. Never throws. */
export declare const legacyRootOrNull: () => string | null

/** The read-only 2016 Unity project root: `$FF2_LEGACY`. Throws `LegacyRootUnsetError` when unset. */
export declare const legacyRoot: () => string

/**
 * The root, or a path that cannot exist when unset. For a test that builds a path at module scope
 * and asks `fs.existsSync` before using it; real readers use `legacyRoot()`.
 */
export declare const legacyRootOrAbsent: () => string

/** True when `$FF2_LEGACY` is set AND the read-only Unity project is mounted on this machine. */
export declare const legacyAvailable: () => boolean

/** A path inside the Unity project, forward-slashed. Throws when `$FF2_LEGACY` is unset. */
export declare const legacyPath: (...parts: readonly string[]) => string

/**
 * Strip the project root off an absolute path, for anything that gets WRITTEN
 * DOWN. Returns the path unchanged if it is not under the root (or no root is
 * set), so it can be applied indiscriminately.
 */
export declare const relativeToLegacy: (absolute: string) => string

/**
 * Throw if `target` is the Unity project or inside it (hard rule 1). `root` defaults to
 * `$FF2_LEGACY`; pass a `--unity`/`--src` override. With no root there is nothing to be inside of.
 * Returns the forward-slashed absolute target.
 */
export declare const assertOutsideLegacy: (target: string, root?: string | null) => string

/** Replace the project root in `text` with `$FF2_LEGACY`, in both slash spellings. */
export declare const portableText: (text: string, root?: string | null) => string

/** The folder holding king-tide and polyfish: `$FF2_REF`, or derived from `$FF2_LEGACY`. */
export declare const refRoot: () => string

/** A path inside a reference project, forward-slashed. */
export declare const refPath: (...parts: readonly string[]) => string
