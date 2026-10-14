/**
 * The frame's wall-clock delta, in seconds, never negative and never NaN.
 *
 * `time` is whatever the animation loop hands the frame: the window's rAF
 * timestamp flat, the `XRFrame`'s time in a session. The two are not promised
 * to be one clock, so the frame that crosses between them can step BACKWARDS.
 * A negative delta is never meaningful, and it was not harmless: the
 * holotable diorama's clock went negative on a worn session (2026-10-13),
 * `% 1` kept it negative, and `line[-1]` threw inside the frame.
 *
 * The first frame (no previous time) gets the fixed step, as before.
 */
export function frameSecondsBetween(time: number, lastTime: number, firstFrame: number): number {
  if (lastTime === 0) return firstFrame
  const seconds = (time - lastTime) / 1000
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0
}
