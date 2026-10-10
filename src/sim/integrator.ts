// src/sim/integrator.ts — the fixed-step accumulator that drives every sim
// tick at exactly FIXED_DT, independent of display refresh (72 / 90 / 120 Hz
// in a headset, whatever the desktop gives you). Render interpolates between
// the last two sim states; the sim never sees a frame delta.

import { FIXED_DT } from './constants'

/**
 * Never let a single frame spend more than this much wall time catching up.
 * A backgrounded tab or a GC pause otherwise hands us a multi-second delta and
 * the sim spirals. 0.25 s ≈ 20 ticks — enough to ride out a hitch, short
 * enough that the game visibly pauses rather than fast-forwards.
 */
const MAX_CATCHUP_SECONDS = 0.25

export interface FixedStepClock {
  /** Unconsumed wall time, seconds. Also the source of the render alpha. */
  accumulator: number
  /** Monotonic tick counter since reset. Drives replay/ghost sample indexing. */
  tick: number
}

export const createClock = (): FixedStepClock => ({ accumulator: 0, tick: 0 })

/**
 * Advance `clock` by `frameSeconds` of wall time and invoke `onTick` once per
 * whole fixed step. Returns the interpolation alpha in [0, 1) for the render
 * layer: `renderPose = lerp(previousSimPose, currentSimPose, alpha)`.
 *
 * `onTick` receives FIXED_DT and nothing else. If a sim function ever needs
 * the frame delta, it is not a sim function.
 */
export const stepFixed = (
  clock: FixedStepClock,
  frameSeconds: number,
  onTick: (dt: number, tick: number) => void,
): number => {
  const clamped = frameSeconds > MAX_CATCHUP_SECONDS ? MAX_CATCHUP_SECONDS : frameSeconds
  clock.accumulator += clamped > 0 ? clamped : 0

  while (clock.accumulator >= FIXED_DT) {
    clock.accumulator -= FIXED_DT
    clock.tick += 1
    onTick(FIXED_DT, clock.tick)
  }

  return clock.accumulator / FIXED_DT
}
