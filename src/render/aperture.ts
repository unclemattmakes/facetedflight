// src/render/aperture.ts — the comfort aperture's radii, and nothing else.
//
// These four numbers were `render/vignette.ts`'s own until S6 (DEV-108) gave a
// SECOND feature a stake in them: the gate pulse's band must begin at or outside
// `R_CLOSED_STRONG`, so that it can only ever brighten a pixel the comfort layer
// is already willing to black out entirely (research 05 §R7, peripheral only).
//
// They live here rather than in `vignette.ts` because the validator that
// enforces that bound is `content/edition-schema.ts`, which is imported by
// `audio/engine.ts` and by fourteen node-environment unit tests — and importing
// the vignette would drag `three` into all of them. A leaf with no imports of
// its own can be read from either side of the layer line. `vignette.ts`
// re-exports the four, so nothing that already read them there had to change.
//
// The alternative was a second 0.3 in the validator, which is the shape of
// constant this repo has already been bitten by twice: one number, two homes,
// and a day when they disagree.

/**
 * Aperture radii, in UV units where the viewport centre is 0, an edge midpoint
 * is 0.5 and a corner is 0.707.
 *
 * `R_OPEN` sits OUTSIDE the corner so a fully open vignette touches no pixel —
 * "off" and "on but open" are the same image, which is what lets the mesh be
 * hidden entirely at rest.
 *
 * A circle in UV space is an ellipse on screen, matching the viewport's aspect.
 * That is deliberate: each XR eye has its own off-axis projection and its own
 * viewport, and the alternative — an aspect-corrected circle — needs a per-eye
 * aspect this shader has no honest way to know. Closing evenly from all four
 * edges cannot be wrong per eye; a circle drawn against a guessed aspect can.
 */
export const R_OPEN = 0.78
export const R_CLOSED_LIGHT = 0.45
export const R_CLOSED_STRONG = 0.3
/** Soft edge width. An iris with a hard rim is a second thing moving in frame. */
export const FEATHER = 0.14
