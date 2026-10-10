// src/content/quantise.ts: the grid arithmetic the player-course canonical form
// is built on (code-reuse audit XC-5). A LEAF on purpose: `player-course.ts`
// imports `player-course-light.ts`, so the light file could not import
// `quantise` back from `player-course.ts` without a cycle, which is why it once
// kept a private copy. Both import it from here.

/**
 * `x` on a grid of `step`. Division by the step's reciprocal count keeps the
 * result the double NEAREST the decimal, so it prints as that decimal and the
 * canonical string carries no float noise (`0.1 * 3` is `0.30000000000000004`;
 * `3 / 10` is `0.3`).
 */
export const quantise = (x: number, step: number): number => {
  const per = Math.round(1 / step)
  const q = Math.round(x * per) / per
  return Object.is(q, -0) ? 0 : q
}

/**
 * A heading in degrees on its grid, in [-180, 180): wrapped first, quantised,
 * and wrapped again, because 179.96 quantises to 180.0, which is -180.
 *
 * The second wrap is `quantise(q - 360, step)`, not `q - 360`. For an integral
 * `1 / step` the two are the same number: the only `q >= 180` the first
 * quantise can produce is exactly 180 (`wrap` is below 180 and `180 * per` is an
 * integer), and `180 - 360` is exactly -180, already on every grid. The prop's
 * yaw once skipped the re-quantise and a note suspected drift; there is none
 * (`tests/unit/content-quantise.test.ts` sweeps it). The re-quantise stays because
 * it is the form that does not depend on that argument.
 */
export const normaliseDegreesOnGrid = (deg: number, step: number): number => {
  const wrap = (y: number): number => ((((y + 180) % 360) + 360) % 360) - 180
  const q = quantise(wrap(deg), step)
  const out = q >= 180 ? quantise(q - 360, step) : q
  return Object.is(out, -0) ? 0 : out
}
