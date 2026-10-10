// src/boot/load-place.ts — where a course switch is waited out. DEV-465.
//
// Matt, 2026-09-27: *"would it be possible to stay in the hangar, but show the
// loading indicator and spinning logo? (maybe hide the holo-tables that
// weren't the last selected one)"*. So a switch pressed in the room is waited
// out IN the room — the loading plate and the turning emblem standing where the
// head is, every table but the chosen one put by — and the fade that already
// carries the player to the pad is the only fade. DEV-355's loading scene stays
// for every other switch.
//
// ── The rule, and the one condition that is not about where you are ─────
//
// The room, when ALL of these hold at the moment the switch shows its plate:
//
//   * the player is IN the room (`screen` is the menu), with nothing queued
//     behind the fade, and the room is up;
//   * the switch did not arrive already bound for the loading scene — Quick
//     Race and Learn to Fly leave the TITLE for it behind one fade (DEV-353),
//     and there is no room to stay in on that route;
//   * **the look the mission will wear is the look being worn now.**
//
// The last is DEV-451's. A mission's world is built under the edition it is
// flown in, so the chosen LOOK goes on before the build — at a black, because a
// flip in view re-lights and recompiles everything on screen (DEV-427 measured
// 782 ms, mid-fade). The room wears Anniversary always (D35). So when the look
// the player chose IS Anniversary, the flip is a no-op and the room can stay
// lit through the whole build: nothing it reads changes. When it is Classic,
// the flip is real and needs its black, and a black in the middle of the room
// is the loading scene's own entrance — so that player keeps DEV-355's route,
// flip and all. The room never wears Classic.
//
// Pure, so the table of cases is a unit test (`tests/unit/hangar-load.test.ts`)
// rather than a claim about `boot/app.ts`.

import type { LoadingPlace } from '@/render/loading-scene'

export interface LoadPlaceQuestion {
  /** The screen the switch is pressed on. */
  readonly screen: 'title' | 'menu' | 'mission'
  /** A screen change is queued behind the fade (`goToScreen`'s pending move). */
  readonly moving: boolean
  /** The room exists and is on screen. */
  readonly roomUp: boolean
  /** The switch arrives already bound for the loading scene (the title's doors). */
  readonly bound: boolean
  /** The look worn right now (`editionState.current.id`). */
  readonly worn: string
  /** The look the mission will wear (the chosen one, DEV-451). */
  readonly mission: string
}

/** Where this switch is waited out: the room (DEV-465) or the loading scene (DEV-355). */
export const loadingPlaceFor = (q: LoadPlaceQuestion): LoadingPlace =>
  q.screen === 'menu' && !q.moving && q.roomUp && !q.bound && q.worn === q.mission
    ? 'room'
    : 'scene'
