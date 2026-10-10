// src/sim/steps.ts — long pure work, written so it can STOP between rows.
//
// DEV-355. A world build ran three whole-map bakes back to back on the main
// thread (the far-shadow march, the sky-visibility bake, the warm-up) and the
// longest of the tasks they made was 3.4 s. In a headset that is not a pause:
// the compositor reprojects the last frame, or SteamVR drops to its grid.
//
// The bakes are pure and live here, where `performance.now()` and every
// scheduling primitive are forbidden (hard rule 4) — which is right: a bake
// must not know about frames. So the split is the one a generator gives for
// free. The bake YIELDS its progress (0..1) at a boundary where stopping costs
// nothing, usually a row, and RETURNS its result. It never decides when to
// stop. The caller decides:
//
//   * `runSteps` drains it in one go, which is the synchronous function every
//     existing caller and test already calls (`buildSunHeight` is
//     `runSteps(sunHeightSteps(...))`), so there is ONE body and the two paths
//     cannot drift apart;
//   * `boot/slice.ts` drains it against a clock, handing the thread back to
//     the frame loop whenever a slice's budget is spent.

/** A bake that yields its progress, 0..1, and returns its result. */
export type Steps<T> = Generator<number, T, void>

/** Run a bake to the end without stopping. The synchronous form of every bake. */
export const runSteps = <T>(steps: Steps<T>): T => {
  for (;;) {
    const next = steps.next()
    if (next.done) return next.value
  }
}
