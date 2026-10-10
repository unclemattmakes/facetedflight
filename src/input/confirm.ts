// src/input/confirm.ts — what the A button MEANS right now, in one place.
//
// One button, five meanings, and until DEV-205 there were two hand-maintained
// lists of them: the confirm handler's `if/else if` chain in `boot/app.ts`, and
// `touchConfirmLabel`'s, whose own comment says the quiet part —
//
//   > These branches are the confirm handler's branches, IN ITS ORDER, and they
//   > have to stay that way … a label naming a different branch from the one
//   > that fires is worse than no label — it is a button you press, disbelieve,
//   > and stop trusting.
//
// It was right, and it had no guard but an e2e spec that reads the word off the
// button and then presses it.
//
// ── Why this file exists rather than a third list ─────────────────────────
//
// DEV-205's first cut armed the WebXR primary action off its own predicate:
// *title, hangar, pause plate*, a fourth condition written out a third time,
// with the launch pad and the results plate left out because the trigger is
// also the throttle and arming them looked like putting `beginLaunch()` on it.
//
// Both halves of that were wrong. The collision does not exist — while the
// prompt says "Press A to launch" the ship is HELD (`launchHoldsShip`, and
// `audio.stepFlight` is passed `released: launch.phase === 'flying'`), so the
// throttle drives nothing there. And a file that warns two lists of the same
// branches will drift does not get a third added to it. **Collapsing back to
// two is strictly better than adding a case to the third**, and it closes the
// launch pad and the results plate for free — which on a controller with no
// button 4 is the difference between picking a mission and playing the game.
//
// So: the branch list lives here, once. `confirmLabel` formats it into the word
// on the touch chip; `confirmArmed` answers "is a confirm meaningful right
// now", which is the XR primary action's arming. The handler in `app.ts` is
// still the thing that ACTS — this does not try to own the actions, only their
// identity — and `tests/unit/xr-select.test.ts` §1 reads the handler's own
// chain out of `app.ts` and fails if its order stops matching the one below.
//
// (The premise that made the pad worth leaving out was wrong twice over: the
// throttle collision does not exist, and the button-4 scarcity it was hedging
// against does not either — the Frame reports seven buttons a hand. Two guesses
// about a device, pointing the same way, and the fix was to stop guessing and
// read the list the game already had.)
//
// ── A MEANING, not a word ─────────────────────────────────────────────────
//
// `confirmMeans` returns a small union and `CONFIRM_LABEL` formats it, rather
// than the arming asking `confirmLabel() !== null`. A function whose job is to
// produce a WORD, read for a BOOLEAN, is the next drift: the day somebody wants
// the chip blank on one screen that still confirms, the label goes null and the
// XR trigger goes dead with it, silently, in a headset. Two readers, one
// decision, and neither of them is the other's side effect.

import type { LaunchPhase } from '@/sim/launch'

/** The five things A does, in the confirm handler's own order. */
export type ConfirmMeaning = 'start' | 'select' | 'hangar' | 'launch'

/** Everything the decision depends on, and nothing else. */
export interface ConfirmState {
  /**
   * `flight !== null` — i.e. a MISSION world is in the scene.
   *
   * It gates the mission's own presses and nothing else (DEV-281). It used to
   * gate all of them, which was a true reading of a build where the ship
   * existed from boot; since boot into the title screen builds no mission,
   * false is the ordinary state of the title screen and the hangar rather than
   * a moment before the world lands.
   */
  readonly worldLoaded: boolean
  readonly screen: 'title' | 'menu' | 'mission'
  readonly paused: boolean
  /** `lastResult !== null` — the run is over and A goes to the hangar (DEV-406). */
  readonly finished: boolean
  readonly launchPhase: LaunchPhase
}

/**
 * What a confirm would do, or `null` if it would do nothing.
 *
 * The branches are `boot/app.ts`'s confirm handler's branches **in its order**,
 * and the order is the whole content: `paused` is tested after `screen`
 * because a paused mission is still `screen === 'mission'`, and `finished`
 * before the launch because after a run A means "hangar", not "launch the ship
 * you are already flying".
 *
 * `null` while the ship is flying, because there A does nothing — `beginLaunch`
 * opens with `if (launch.phase !== 'waiting') return`, which is what makes
 * `'waiting'` the right condition here rather than an approximation of it.
 *
 * And `null` on the MISSION screen with no world, which is the boot window and
 * the middle of a course swap. Not on the other two: see `worldLoaded`.
 */
export const confirmMeans = (state: ConfirmState): ConfirmMeaning | null => {
  // `flight || screen !== 'mission'`, which is the handler's own gate since
  // DEV-281: the title screen and the hangar exist to get you TO a mission, so
  // gating their presses on one having already loaded made the route in depend
  // on its own destination.
  if (!state.worldLoaded && state.screen === 'mission') return null
  if (state.screen === 'title') return 'start'
  if (state.screen === 'menu') return 'select'
  if (state.paused) return 'select'
  if (state.finished) return 'hangar'
  return state.launchPhase === 'waiting' ? 'launch' : null
}

/**
 * The word on the touch overlay's one big button.
 *
 * Exported as a map so a spec can assert against the same words the game draws
 * instead of retyping them — `tests/e2e/mobile-controls.spec.ts` reads the chip
 * and compares, and a spec holding its own copy of these four strings is the
 * third list all over again.
 */
export const CONFIRM_LABEL: Record<ConfirmMeaning, string> = {
  start: 'START',
  select: 'SELECT',
  // DEV-406: after a run A goes home. Its follow-up (Matt, 2026-09-26: "2
  // buttons after the race is over - continue. fly again.") names it CONTINUE,
  // beside a FLY AGAIN chip.
  hangar: 'CONTINUE',
  launch: 'LAUNCH',
}

/** The word, or `null` to take the button away. */
export const confirmLabel = (state: ConfirmState): string | null => {
  const meaning = confirmMeans(state)
  return meaning === null ? null : CONFIRM_LABEL[meaning]
}

/**
 * Would a confirm mean anything right now?
 *
 * The WebXR primary action's arming (DEV-205). A `select` that arrives while
 * this is false is SPENT and dropped rather than held — see
 * `input/xr-select.ts`, where the reason is that a trigger pull in flight is
 * the throttle and must not be delivered the moment somebody pauses.
 */
export const confirmArmed = (state: ConfirmState): boolean => confirmMeans(state) !== null
