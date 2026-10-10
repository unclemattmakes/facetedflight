// src/game/room-names.ts — a room's names, as a client draws them. DEV-485.
//
// The room admits any name of `HANDLE_SHAPE` and checks nothing more, so the
// handle list (`net/handles.ts`) can grow without the rooms Worker being
// redeployed: no game code in the Durable Object (MULTIPLAYER §6.5). The list
// is therefore checked HERE, by every client, at the moment it draws a name:
// a listed handle is drawn as itself, and anything else a hand-made client
// sent — any 40 characters of letters, digits and spaces — as *Racer N*, the
// seat's slot plus one (the words FF-TV's broadcaster uses, plan/FF-TV.md §2.3).
// D30: names from the generated list only, no free text.
//
// `tests/unit/room-names.test.ts` feeds every surface a name the room admits
// and the list refuses, and sweeps `src/` for a room player's `.handle` drawn
// any other way.

import { isHandle } from '@/net/handles'

/** What a seat is called when its name is not one the game generates. */
export const racerName = (slot: number): string => `Racer ${slot + 1}`

/** A room player's name as it may be drawn: the handle if the list made it, else *Racer N*. */
export const drawnHandle = (handle: unknown, slot: number): string =>
  isHandle(handle) ? handle : racerName(slot)
