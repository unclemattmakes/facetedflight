// Type declarations for import-graph.mjs. See tools/legacy-root.d.mts for why
// these are a separate file: the walker is plain Node so the tiered runner can
// use it without a transpiler, and the tests that share it are TypeScript.

/** The repository root, derived from the file's own location. */
export declare const REPO: string

/** Forward-slashed path relative to the repo root. */
export declare const rel: (abs: string) => string

/** Resolve an import specifier to a file on disk, or null if it is a package. */
export declare const resolveSpecifier: (fromFile: string, spec: string) => string | null

/** `valueOnly` leaves out whole `import type` / `export type` statements, which a compiler erases. */
export interface WalkOptions {
  valueOnly?: boolean
}

/** Every `from '...'` in a file. */
export declare const importsOf: (file: string, options?: WalkOptions) => string[]

/** One node of the walk: the file, and the import chain that first reached it. */
export interface ImportNode {
  file: string
  chain: string[]
}

/** Breadth-first over the static import graph from `entry`; the entry is yielded first. */
export declare function walkImports(
  entry: string,
  options?: WalkOptions,
): Generator<ImportNode, void, undefined>

/** The `src/` modules a file can reach, repo-relative and forward-slashed. */
export declare const reachableSrc: (entry: string) => Set<string>

/** Every vitest file, absolute, sorted. */
export declare const unitTestFiles: () => string[]
