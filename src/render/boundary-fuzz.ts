// src/render/boundary-fuzz.ts — the signal breaking up as you leave the world.
//
// ── What this is ──────────────────────────────────────────────────────────
//
// Matt, 2026-09-16: *"let's do a 'fuzzy screen' visual if players go out of
// bounds."* A driver in `gate-pulse.ts`'s shape: it produces a few numbers per
// render frame and `boot/app.ts` hands them to `vignette.setFuzz`, which owns
// the only full-screen quad in the game and draws the static as one more term
// on it — under the black, so a death curtain covers it, and over the gate
// pulse, because a warning outranks a flourish. It draws nothing itself, holds
// no GPU resource, imports no `three`, and is tested in node
// (`tests/unit/boundary-fuzz.test.ts`).
//
// ── What 2016 did ─────────────────────────────────────────────────────────
//
// `PlayerBoundary.OnTriggerExit` calls `HUD_Ship.ShowOutOfBounds()`, which
// `SetActive(true)`s a `panel_outOfBounds` on each camera's HUD, and
// `OnTriggerEnter` hides it again. A panel, and a `Debug.Log` a second. No
// screen effect of any kind — so this is Anniversary-only, `boundary.fuzz` in
// the edition JSON, and Classic keeps the banner and the alarm 2016 had.
//
// ── The shape, and what is derived rather than chosen ─────────────────────
//
// The one input is `boundaryProgress` (`sim/boundary.ts`): 0..1 across the
// 13 s countdown, the same clock the banner and the alarm read. From it:
//
//   level        = strength × progress          the static's alpha at the edge
//   clearRadius  = R_CORNER × (1 − progress²)   inside this UV radius, nothing
//
// So the static comes in from the CORNERS — `R_CORNER` is the UV distance from
// the centre to a corner of the quad, the farthest pixel there is — and closes
// on the centre as the clock runs, reaching the centre pixel only when the
// clock reaches zero. The alpha is LINEAR so the static reads as a clock; the
// disc closes on the SQUARE of the progress, slowly at first and all at once
// at the end, because the thing that has to stay readable is not at the
// centre: the "RETURN — 4" banner sits on the dashboard at r ≈ 0.22–0.35, and
// a disc closing linearly had it in the noise with four seconds left
// (photographed; DEV-127 §3). On the shipped 13 s, measured off the formula:
//
//   first legible          ≈ 40 %  (5 s in)      corners only
//   banner text (r 0.28)   clear until ≈ 77 %  (3 s left), gone by 2 s left
//   centre pixel           clear until 100 %   (the final tick)
//
// `FEATHER` is the comfort layer's own soft edge, imported rather than
// restated.
//
// `strength` is the one number and the one to argue with: the overlay alpha of
// the static at the outermost pixel at the moment the clock hits zero. 1 would
// be total signal loss; the preset ships below it so the last frame before the
// curtain still has a world behind the noise.
//
// ── NOT on the speed-FX comfort slider, and that is a decision ────────────
//
// The slider exists to limit VECTION (ANNIVERSARY.md §2.6): the near-field
// air, the streak width, the cockpit shake and the gate pulse are all optic
// flow, all self-motion cues, and all scale with it. Static is not optic flow.
// It is screen-fixed, it does not move with the world, and it carries no
// self-motion cue at all — it is FEEDBACK, the same channel as the banner and
// the alarm, which are not on the slider either. A player who turned vection
// off did not ask to lose the warning that their run is about to end; the
// same reasoning DEV-084 gives for the wind not going quiet on the slider.
//
// The comfort question static DOES raise is flicker, and that is answered
// here rather than by the slider: the grain refreshes at `FUZZ_HZ`, not at the
// display rate, so a 72 Hz headset never sees a full-rate strobe; and the
// centre of the frame — where the eyes rest — is the last place it reaches.
//
// ── DEV-027: what each number is the ... OF ───────────────────────────────
//
// `level` is an OVERLAY ALPHA at the outermost pixel, 0..1. `clearRadius` and
// `feather` are UV radii on the quad (centre 0, edge midpoint 0.5, corner
// `R_OPEN`). `grain` is a UV cell size — cells per unit of the quad's height.
// `seed` is a frame counter at `FUZZ_HZ`, wrapped so the shader's hash never
// sees a number large enough to lose its fraction.

import type { EditionBoundaryFuzz } from '@/content/edition-schema'
import { FEATHER } from '@/render/aperture'

/**
 * The UV radius of the quad's corner — √(0.5² + 0.5²). The farthest pixel from
 * the centre, so a clear disc of this radius touches nothing. A geometric fact
 * of a unit square, not a tuning number.
 */
export const R_CORNER = Math.SQRT1_2

/**
 * Static cells per unit of the quad's height. 1/120 is a cell of 6 px at
 * 720p and ~15 px per eye on a Quest 3 — coarse enough to read as static
 * rather than as film grain, fine enough that the centre-clear disc has a
 * smooth edge. A UV cell is `aspect` times wider than it is tall on a 16:9
 * frame, which reads as a scanline texture and is left alone.
 */
export const FUZZ_GRAIN = 1 / 120

/**
 * How often the grain changes, Hz. 24 is film rate: the static crawls rather
 * than strobes, which is the comfort answer a screen-fixed effect owes a
 * headset. At 72 or 90 Hz refresh a fresh pattern every frame reads as a
 * flicker over the whole periphery.
 */
export const FUZZ_HZ = 24

/** Frames the seed counts to before wrapping. Keeps the hash input small. */
export const FUZZ_SEED_WRAP = 1024

/** One frame of the static, as the vignette's shader wants it. */
export interface FuzzFrame {
  /** 0..1 overlay alpha at the outermost pixel. */
  readonly level: number
  /** UV radius inside which nothing is drawn. 0 only when the clock is out. */
  readonly clearRadius: number
  /** UV width of the ramp from clear to full. */
  readonly feather: number
  /** UV cell size of the grain. */
  readonly grain: number
  /** Whole frames at `FUZZ_HZ`, wrapped. Changes the pattern. */
  readonly seed: number
}

/**
 * The level and the clear radius for a countdown `progress` (0..1), or `null`
 * when there is nothing to draw — the flag off, or the ship in bounds. Pure.
 */
export const fuzzFor = (
  block: EditionBoundaryFuzz,
  progress: number,
  seed: number,
): FuzzFrame | null => {
  if (!block.enabled) return null
  const u = progress < 0 ? 0 : progress > 1 ? 1 : progress
  const level = block.strength * u
  if (!(level > 0)) return null
  return {
    level: level > 1 ? 1 : level,
    clearRadius: R_CORNER * (1 - u * u),
    feather: FEATHER,
    grain: FUZZ_GRAIN,
    seed,
  }
}

/** What `boot/app.ts` holds: a clock for the grain, and the frame builder. */
export interface BoundaryFuzz {
  /** Advance the grain clock. `dtSeconds` is a FRAME delta, never the fixed step. */
  update(dtSeconds: number): void
  /** The current seed, for the tests. */
  readonly seed: number
  /** `fuzzFor` at this clock's seed. */
  frame(block: EditionBoundaryFuzz, progress: number): FuzzFrame | null
}

export const createBoundaryFuzz = (): BoundaryFuzz => {
  let seconds = 0
  return {
    update(dtSeconds) {
      // A backgrounded tab hands back a delta of minutes; the wrap below makes
      // that harmless, but a negative delta is a bug upstream and is ignored.
      if (dtSeconds > 0) seconds += dtSeconds
    },
    get seed() {
      return Math.floor(seconds * FUZZ_HZ) % FUZZ_SEED_WRAP
    },
    frame(block, progress) {
      return fuzzFor(block, progress, this.seed)
    },
  }
}
