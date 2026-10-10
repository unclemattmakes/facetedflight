// tests/e2e/fixtures/known-red.ts: a test that is red on main for a recorded
// reason, held out of the ordinary run until its owner fixes it.
//
// Matt, 2026-10-03: "simplify the test process so the queue isn't so backed
// up". Ten specs had been red on main for days and four more need the VRto3D
// rig; every full run re-proved them red, and every lead re-ran them against an
// older commit to show they were not new. Each now names its row in
// docs/testing/KNOWN-RED.md, which says what it fails on and who owns it.
//
// A SKIPPED test reads like a pass in a summary line (CLAUDE.md), so this is
// deliberately loud and deliberately narrow:
// - the skip reason carries the id and the registry, so a run's output says it;
// - `tests/unit/known-red-registry.test.ts` refuses an id with no registry row
//   and a row with no test, so neither half can rot alone;
// - E2E_KNOWN_RED=1 runs every one of them, and E2E_KNOWN_RED=KR-01,KR-05 runs
//   just those: fixing one starts by running it.
// The game takes no different path: this only decides whether the test runs.

import { test } from '@playwright/test'

const selected = (id: string): boolean => {
  const want = process.env.E2E_KNOWN_RED ?? ''
  if (want === '1') return true
  return want
    .split(',')
    .map((s) => s.trim())
    .includes(id)
}

/**
 * Call first thing inside the test body. `when` narrows it to the cases of a
 * parametrised test that are red (one mission of several, one edition of two).
 */
export const knownRed = (id: string, when = true): void => {
  test.skip(
    when && !selected(id),
    `${id}: red on main, see docs/testing/KNOWN-RED.md (E2E_KNOWN_RED=${id} runs it)`,
  )
}
