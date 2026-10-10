// tests/unit/helpers/speed-curves.ts — a preset's worth of S4 curves whose
// arithmetic a person can do in their head.
//
// Shared by `audio-speed-curves.test.ts` and `audio-events.test.ts`, which is
// the whole reason it is a helper rather than a `const` in one of them.
//
// ── Why the numbers are absurd ────────────────────────────────────────────
//
// Deliberately. An `afterburnerRate` of 4 would be a chipmunk and a
// `windCutoffHz` of 5000 at terminal would be a blanket over the mix — nothing
// here is a plausible tuning, and that is the point twice over:
//
//   1. Every expectation in the tests is hand-computed from these, so the tests
//      assert what the CODE does rather than re-deriving it the way the code
//      does. CLAUDE.md trap 24: a test that recomputes its expectation with the
//      implementation's own arithmetic has tested nothing.
//   2. A fixture that looked like a shipped value would eventually be copied
//      into `content/editions/anniversary.json` by somebody reading the tests
//      for the tuning. These cannot be.
//
// The SHIPPED curves are asserted separately and only by relationship — the
// wind gets brighter with speed, the whoosh gets louder — because those are
// claims that stay true when Matt moves a number, and an exact assertion on a
// tuning table is a test that fails every time somebody tunes.

import type { EditionSpeedCurves } from '@/content/edition-schema'

/**
 * Round numbers on straight lines. Read them as: at x = 0 the first y, at the
 * second x the second y, linear between and flat outside.
 */
export const FIXTURE_CURVES: EditionSpeedCurves = {
  enabled: true,
  // 0 at 0 m/s, 1 at 100. So 0.3 at 30, and 1 at anything above 100.
  aircraftWindGain: [
    [0, 0],
    [100, 1],
  ],
  // 0 at 100 m/s, 1 at 200. So 0.8 at 180, and 0 at anything below 100.
  flightWindGain: [
    [100, 0],
    [200, 1],
  ],
  // 1000 Hz at 0, 5000 at 200. So 1600 at 30 and 4600 at 180.
  windCutoffHz: [
    [0, 1000],
    [200, 5000],
  ],
  // 0.5 at no throttle, 1.5 at full. So 1.0 at half.
  thrustRate: [
    [0, 0.5],
    [1, 1.5],
  ],
  // 2 at no throttle, 4 at full. So 3 at half.
  afterburnerRate: [
    [0, 2],
    [1, 4],
  ],
  // Doubles the THRUSTER's rate while the burner is lit. 1.5 x 2 = 3 at full.
  afterburnerStep: 2,
  // 0 at 0 m/s, 1 at 100.
  gateWhooshGain: [
    [0, 0],
    [100, 1],
  ],
  // 1 at 0 m/s, 2 at 100.
  gateWhooshPitch: [
    [0, 1],
    [100, 2],
  ],
  // DEV-425. 1 at 0 m/s, 3 at 200. So 1.3 at 30 and 2.8 at 180.
  windRate: [
    [0, 1],
    [200, 3],
  ],
}
