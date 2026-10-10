// src/content/glob-tree.ts: the ids of a `import.meta.glob` tree. Code-reuse audit BE-6.
//
// Every content loader globs a folder of `<id>.json` files and then needs the
// ids it holds, sorted, without the underscore files (`_schema.json`, the
// tests' `_fixture_` files). That filter was written five times.
//
// What is SHARED is the filter, not the glob: `import.meta.glob` must stay a
// literal at each call site, because Vite reads it statically at build time,
// so each loader keeps its own and hands the result here.
//
// This file imports nothing on purpose. A src/ import edge that reaches
// `import.meta.glob` kills Playwright's test collection
// (`tests/unit/e2e-import-graph.test.ts`), and a helper that imported a loader
// would be that edge.

/**
 * The ids in a glob tree: the part of each path between `prefix` and `.json`,
 * sorted, leaving out anything that does not sit under `prefix` and every id
 * that starts with `_`.
 */
export const globIds = (modules: Readonly<Record<string, unknown>>, prefix: string): string[] =>
  Object.keys(modules)
    .filter((p) => p.startsWith(prefix))
    .map((p) => p.slice(prefix.length, -'.json'.length))
    .filter((id) => !id.startsWith('_'))
    .sort()
