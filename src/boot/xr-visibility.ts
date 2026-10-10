// src/boot/xr-visibility.ts — is the headset actually looking at us?
//
// One predicate, lifted out of `boot/app.ts`'s frame loop so it can be asserted
// without a page. It is three lines and it is the whole of DEV-206's decision;
// everything else in that row is a listener, and a listener cannot be unit
// tested in a suite with no browser in it.
//
// ── The measurement this exists because of ─────────────────────────────────
//
// Matt, first Frame session: *"when I press what I think would be the
// equivalent of a 'back' button, the entire VR app freezes."*
//
// It does not freeze. Instrumented live on 2026-09-17 across a 4.01 s window
// while it was happening, with four independent clocks:
//
//     setInterval heartbeat   3.99 Hz   alive
//     window rAF            142.47 Hz   alive
//     XRSession rAF          34.18 Hz   ALIVE
//     gl.isContextLost()        false
//     document.hidden           false   (the tab is never backgrounded)
//
// Nothing stops. `setAnimationLoop` keeps firing and frames keep reaching the
// compositor. One thing changes: `XRSession.visibilityState` leaves `visible`,
// because SteamVR has drawn its dashboard in front of us and **input is
// withheld**. In a headset that is indistinguishable from a freeze.
//
// And the run keeps going. `__ff2perf.sim()` sampled 2.5 s apart during the
// blur: **tick 21904 -> 22109, 205 ticks, 81.967 Hz** — dead on the fixed step.
// Sixty seconds of that against `PlayerBoundary.resetDelay` of 13 s, live in
// six of thirteen missions, is four and a half reset windows from one glance at
// a dashboard; and on `int_01_jumpSeat` / `adv_02_jumpSeat` it reaches DEV-074's
// 15.5 s reset LOOP, which is the bug that made both missions unplayable.
//
// ── Why this is a predicate and not a comparison against a list ────────────
//
// The spec has three states and the transition can land in either of the two
// that are not `visible`. The SAME session was measured going to
// `visible-blurred` on one press (21:48:40) and to **`hidden`** on the next
// (21:51:43) — `hidden` being the stronger case, where the app is not
// composited at all.
//
// So this asks whether the state IS `visible`, rather than whether it is one of
// the states we happen to have met. A handler written against `visible-blurred`
// alone passes every test anyone would think to write and misses the case that
// was actually seen, which is the failure this file exists to make impossible.

/**
 * Should the run be HELD?
 *
 * `null` is "there is no session" — a flat-screen player, or the moment before
 * one starts — and is emphatically not a hold: the flat build would freeze on
 * boot and never resume, because nothing would ever set it back.
 */
export const xrRunHeld = (visibilityState: XRVisibilityState | null | undefined): boolean =>
  visibilityState != null && visibilityState !== 'visible'

/**
 * The plate's row while the run is held, or null when it is not.
 *
 * On the plate rather than only in the console for the reason the XR input row
 * is: a headset has no console and no DOM, so an instrument row is the only
 * surface a wearer can be told anything on. It names the CAUSE — the dashboard
 * — because "held" on its own reads as a bug to the person it is happening to.
 */
export const xrHoldLine = (
  visibilityState: XRVisibilityState | null | undefined,
): string | null => {
  if (!xrRunHeld(visibilityState)) return null
  return visibilityState === 'hidden'
    ? 'HIDDEN — not being composited; the run is held'
    : 'BLUR — dashboard in front; the run is held'
}
