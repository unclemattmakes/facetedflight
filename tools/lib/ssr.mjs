// tools/lib/ssr.mjs: a game module loaded the way Vite loads it, from a Node tool or a Playwright
// fixture. TL-12 (docs/plan/code-reuse/tools.md): four copies of one `createServer` options object
// (tests/e2e/fixtures/ssr-import.ts, tools/net/room-probe.mjs, tools/assets/bake-placements.mjs,
// tools/content/leg-table.mjs).
//
// Why Vite and not `import()`: some game modules reach `content/*.json` through a bare JSON import,
// which Node's ESM refuses without an import attribute, and ONE such edge anywhere in a Playwright
// spec's graph fails the whole collection (`Total: 0 tests`, DEV-390). Vite resolves it as it does
// for the game, so a tool that must run the REAL source loads it through a Vite server in
// middleware mode (no port, no HMR, no watcher): the same source, not a copy of it.
//
// ONE config: `configFile: false`. bake-placements and leg-table used to load vite.config.ts, which
// adds `basicSsl`, the dev-server plugins and `define: { __FF2_CHANNEL__ }`, none of which a
// `ssrLoadModule` of `src/sim/**` reaches. If a module they load ever does read `__FF2_CHANNEL__`
// it fails with a ReferenceError (loud), not a silently different result. The `@` alias is the
// one thing the project config contributed that those modules need, and it is declared here.

import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../../', import.meta.url))

/**
 * A Vite server in middleware mode rooted at the repository. The caller owns it and must `close()`.
 * `vite` is imported here, not at the top, so a tool that never loads game code never pays for it.
 */
export const createSsrServer = async ({ logLevel = 'warn' } = {}) => {
  const { createServer } = await import('vite')
  return createServer({
    configFile: false,
    root: REPO,
    resolve: { alias: { '@': `${REPO}src` } },
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: 'custom',
    logLevel,
    optimizeDeps: { noDiscovery: true, include: [] },
  })
}

let shared = null

/** `path` from the repository root (`/src/...`), loaded and evaluated by one lazily started, shared server. */
export const ssrImport = async (path) => {
  shared ??= createSsrServer()
  return (await shared).ssrLoadModule(path)
}

/** Close the shared loader, if one was started. */
export const closeSsr = async () => {
  const s = shared
  shared = null
  if (s) await (await s).close()
}
