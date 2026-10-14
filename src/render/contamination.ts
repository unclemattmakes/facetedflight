// src/render/contamination.ts: what makes a frame NOT evidence about the build.
// Three-free, DOM-free, clock-free, so the controller's tests script it.
//
// The lesson is `docs/testing/perf-protocol.md` section 3a-quater: on
// 2026-09-17 an agent's `pnpm check` starved a frame, `quality.ts` read it as
// the build being slow, dropped to the 45 Hz tier while Matt was wearing the
// headset, and he flew the reconfigured build. A voided flight that looked
// exactly like the game being slow. The defence was a rule plus the GPU lease;
// this is the game noticing for itself (docs/plan/PERF-WAVE-2026-10-11.md, C).
//
// A CONTAMINATED frame is one whose time is explained by something other than
// the build: the dev server pushing an update, a lease held by somebody who is
// not the wearer, the host out of CPU, or the page told it is not being shown.
// Such a frame is FLAGGED. The adaptive controller does not count it toward a
// downgrade (`stepAdaptive`'s `contaminated` argument) and the capture records
// the flag (`perf-trace.ts`'s `tainted` column), so a reading can be voided
// afterwards instead of silently believed.
//
// ── Why a bitmask of REASONS, and why they are held ─────────────────────────
//
// A source is polled (a fetch once a second, a DOM event) and a frame is
// 11 ms, so a signal is a level that outlives the poll that saw it: the host
// that was starved a second ago is still the host whose last second of frames
// is in the average. `CONTAMINATION_HOLD_SECONDS` carries each reason past the
// last observation of it, in FRAME time (the `dt` the caller hands in), not a
// wall clock: a render module reads none, and a backgrounded tab must not
// expire a flag it never rendered a frame under.

/** One bit per reason. A wire format: `perf-trace.ts` writes the mask. */
export const CONTAMINATION = {
  /** The dev server pushed an update, or reloaded the page, or lost the page. */
  HMR: 1,
  /** The GPU lease is held by somebody who is not the one measuring (dev only). */
  LEASE: 2,
  /** The host is out of CPU: another process is eating the box (dev only). */
  HOST_CPU: 4,
  /** The browser says the page is not being shown, so it throttles the frames. */
  HIDDEN: 8,
} as const

export type ContaminationReason = keyof typeof CONTAMINATION

/** The names in bit order, bit 0 first. Written into a trace header. */
export const CONTAMINATION_BITS: readonly ContaminationReason[] = [
  'HMR',
  'LEASE',
  'HOST_CPU',
  'HIDDEN',
]

const SHORT: Readonly<Record<ContaminationReason, string>> = {
  HMR: 'hmr',
  LEASE: 'lease',
  HOST_CPU: 'cpu',
  HIDDEN: 'hidden',
}

/**
 * How long a reason stays in force after it was last observed, in frame
 * seconds.
 *
 * 2 s, from the controller it protects: a step down needs `sustainSeconds`
 * (1.5) of over-budget, and the EMA that decides it has a 0.5 s time constant.
 * A hold shorter than the EMA's memory would let the tail of a starved stretch
 * back in; a hold much longer would blind the controller to a genuine
 * slowdown that starts as the box quietens.
 */
export const CONTAMINATION_HOLD_SECONDS = 2

/** `hmr+cpu`, or the empty string. For the plate and the console. */
export const contaminationLabel = (mask: number): string =>
  CONTAMINATION_BITS.filter((name) => (mask & CONTAMINATION[name]) !== 0)
    .map((name) => SHORT[name])
    .join('+')

export interface ContaminationGate {
  /**
   * Report which reasons are true RIGHT NOW. A reason present here has its hold
   * restarted; one absent keeps counting down. Safe to call at any rate, from
   * any source, between frames.
   */
  observe(mask: number): void
  /**
   * Advance by one frame and return the reasons in force for it. This is the
   * only place the hold counts down, so a source that is polled 60 times a
   * second and one polled once a minute agree about how long a reason lasts.
   */
  advance(dtSeconds: number): number
  /** The mask the last `advance` returned. 0 before the first. */
  readonly mask: number
  /** Forget everything: a session boundary is a different display (DEV-178). */
  reset(): void
}

export const createContaminationGate = (
  holdSeconds: number = CONTAMINATION_HOLD_SECONDS,
): ContaminationGate => {
  const left = new Float64Array(CONTAMINATION_BITS.length)
  let seen = 0
  let current = 0
  return {
    observe(mask) {
      seen |= mask
    },
    advance(dtSeconds) {
      // The same clamp `stepAdaptive` makes on `dt`: a tab handing back a delta
      // of minutes must not expire a hold it never rendered a frame under.
      const dt = dtSeconds < 0 ? 0 : dtSeconds > 0.25 ? 0.25 : dtSeconds
      let mask = 0
      for (let i = 0; i < CONTAMINATION_BITS.length; i++) {
        const bit = CONTAMINATION[CONTAMINATION_BITS[i] as ContaminationReason]
        if ((seen & bit) !== 0) left[i] = holdSeconds
        else if ((left[i] as number) > 0) left[i] = Math.max(0, (left[i] as number) - dt)
        if ((left[i] as number) > 0) mask |= bit
      }
      seen = 0
      current = mask
      return mask
    },
    get mask() {
      return current
    },
    reset() {
      left.fill(0)
      seen = 0
      current = 0
    },
  }
}
