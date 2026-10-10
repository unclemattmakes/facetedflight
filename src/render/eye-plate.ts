// src/render/eye-plate.ts: the two sums every eye-anchored plate pose is made of.
//
// "Top edge N degrees below the eye, D metres out" was worked out three times
// (`title-menu.ts`, `room-code-plate.ts`, `room-lobby.ts`) and its inverse, "how
// many degrees is this height at that distance", twice more for the extent
// tests. Two functions, written once, with the expressions exactly as they were
// so no pose moves by a bit.

/** Height of a plate's top edge relative to the eye (negative: below), `topDeg` down at `distance`. */
export const topEdgeY = (topDeg: number, distance: number): number =>
  -Math.tan((topDeg * Math.PI) / 180) * distance

/** The angle, degrees, a height `y` from the eye line subtends at `distance`. */
export const angleDeg = (y: number, distance: number): number =>
  (Math.atan2(y, distance) * 180) / Math.PI
