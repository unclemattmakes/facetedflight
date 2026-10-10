// src/render/turntable.ts: a holotable's picture turns only while its table is
// the selected one, and rests otherwise. DEV-574.
//
// Matt, 2026-10-02, in the hangar: *"only rotate the models when we they're
// being 'hovered over'"*. Until now every aircraft, mark and medal on every
// table turned all the time, from a random start, so an arc of four read as
// four things moving at once and none of them was the one you were looking at.
//
// So a picture has two states. **Selected**: it turns at its own rate, as it
// always did, which is the "look at me" of the table under the pointer.
// **Resting**: it stands still at a REST yaw the room chooses for it (a
// pleasing three-quarter angle, never edge-on: `render/hangar.ts`'s
// `PICTURE_REST_TURN`). Let go, it goes back to rest the short way round,
// easing in, and never faster than {@link SETTLE_MAX_DEG_PER_SECOND}; so a
// glance across the arc does not leave a trail of half-turned models, and a
// model never whips round.
//
// Render time, not sim time: this is decoration, like the spin it governs.
// Pure: one function of numbers, so the rule is a unit test, not a belief.

/** Seconds: the time constant of the settle back to rest. About 95 % in 3 of them. */
export const SETTLE_SECONDS = 0.22

/** The fastest a picture turns on its way back to rest, degrees per second. */
export const SETTLE_MAX_DEG_PER_SECOND = 240

const SETTLE_MAX = (SETTLE_MAX_DEG_PER_SECOND * Math.PI) / 180

/** `a` wrapped into (-PI, PI]. */
export const wrapAngle = (a: number): number => {
  const t = Math.atan2(Math.sin(a), Math.cos(a))
  return t === -Math.PI ? Math.PI : t
}

/**
 * The picture's yaw after `seconds`: turned at `rate` (radians per second)
 * while `spinning`; otherwise moved toward `rest` the short way round. A
 * `rest` of null is a picture nobody has placed, and it holds still where it
 * is when not spinning.
 */
export const turntableYaw = (
  yaw: number,
  rest: number | null,
  seconds: number,
  spinning: boolean,
  rate: number,
): number => {
  if (spinning) return yaw + rate * seconds
  if (rest === null || seconds <= 0) return yaw
  const gap = wrapAngle(rest - yaw)
  if (Math.abs(gap) < 1e-5) return yaw + gap
  const eased = gap * (1 - Math.exp(-seconds / SETTLE_SECONDS))
  const cap = SETTLE_MAX * seconds
  return yaw + Math.max(-cap, Math.min(cap, eased))
}
