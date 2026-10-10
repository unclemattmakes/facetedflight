// src/render/instrument-colour.ts — the one accent the instrument family shares.
//
// ── Why a whole file for one number ──────────────────────────────────────
//
// It used to live in `render/hangar.ts`, and on 2026-09-14 `render/elevator.ts`
// imported it from there for the shaft's lit bars (DEV-106). That single edge
// took the WHOLE Playwright suite down to `Total: 0 tests in 0 files`:
//
//     launch-ride-on-switch.spec.ts
//       -> src/render/elevator      (for REVEAL_RISE)
//       -> src/render/hangar        (for this colour)
//       -> src/game/mission-shape
//       -> src/content/load-level   -> `import.meta.glob(...)`
//
// `import.meta.glob` is Vite's, and Playwright's own transformer does not have
// it — so the import throws at COLLECTION time, before a single spec runs. The
// failure prints as an ordinary error with exit 1, which reads like "the suite
// failed" rather than "the suite no longer exists", and CI does not run e2e at
// all (no GPU). It went out on `main` and nothing caught it.
//
// So this is a LEAF: no imports, nothing to reach. Anything a spec might want to
// import a constant from should look like this, and
// `tests/unit/e2e-import-graph.test.ts` is the guard that says so.

/**
 * The HUD's accent, so the launch room, the shaft's bars and the instruments all
 * belong to the same family. Also `diorama.ts`'s orb and the hangar's
 * already-flown holotable rim, which is why it is worth having one name.
 */
export const INSTRUMENT_ACCENT = 0x8ad8e0
