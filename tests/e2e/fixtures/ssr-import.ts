// tests/e2e/fixtures/ssr-import.ts — a game module loaded the way Vite loads it. DEV-390.
//
// Some server-side modules cannot be imported by Playwright's own loader: the
// lap judge (`src/net/room-lap.ts`) reaches `content/lap-courses.json` through
// a bare JSON import, which Node's ESM refuses without an import attribute —
// and ONE such edge anywhere in a spec's graph fails the whole collection
// (`Total: 0 tests`). Vite resolves it, as it does for the game and for the
// Pages Function's bundle, so a fixture that must run the REAL handler loads it
// through a Vite server in middleware mode (no port, no HMR, no watcher): the
// same source, not a copy of it.

// The loader itself is tools/lib/ssr.mjs (TL-12): this fixture and the Node tools that need the
// game's own code share one options object. Re-exported so every spec's import stays as it was.
export { closeSsr, ssrImport } from '../../../tools/lib/ssr.mjs'
