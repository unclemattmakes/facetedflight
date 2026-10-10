// tests/e2e/fixtures/ff2.ts: the TYPE of the `__ff2` debug handle, for specs.
//
// A spec reaches the handle inside `page.evaluate`, and that function is
// serialised into the page: nothing it closes over comes with it, so a helper
// that RETURNS the handle cannot live here. What can is the type, and the
// reach is spelled
//
//   const w = globalThis as unknown as Ff2Global
//   w.__ff2.stage()
//
// Before this file every spec re-declared the members it needed in an inline
// literal, and a literal type-checks against nothing: a member that had been
// renamed still compiled, because the cast declared the shape it wanted (that
// is what `tests/unit/e2e-debug-handle.test.ts` was written to catch, by
// reading the literals as text). Spelled with the declared `App`, `tsc` checks
// every member name and every return shape, and the guard keeps sweeping the
// sites that still carry a literal.
//
// IMPORTS HERE MUST STAY TYPE-ONLY. Playwright erases `import type`, so none of
// `src/` is loaded by a spec through this file. A value import from a spec into
// `src/` that reaches a Vite-only global collects zero tests for the whole
// suite (`tests/unit/e2e-import-graph.test.ts` explains how that happened).

import type { App } from '../../../src/boot/app/types'
import type { PerfSurface } from '../../../src/boot/perf-surface'

/** The handle `window.__ff2` holds once the game has booted. */
export type Ff2 = App

/** The handle `window.__ff2perf` holds, the perf surface. */
export type Ff2Perf = PerfSurface

/** `globalThis` in a page where the game is known to be running. */
export type Ff2Global = { __ff2: Ff2 }

/** `globalThis` in a page that may not have booted the game yet. */
export type Ff2GlobalMaybe = { __ff2?: Ff2 }

/** `globalThis` with the perf surface present. */
export type Ff2PerfGlobal = { __ff2perf: Ff2Perf }

/** `globalThis` with the perf surface possibly absent. */
export type Ff2PerfGlobalMaybe = { __ff2perf?: Ff2Perf }
