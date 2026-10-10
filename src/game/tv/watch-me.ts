// src/game/tv/watch-me.ts, WATCH ME: a TV link that follows you. DEV-480.
//
// docs/plan/FF-TV.md §2.6, *view self*. A player in a room asks the room for
// its TV id, `GET /api/room/<code>/tv` (DEV-479's route; the player already
// holds the code, so it reveals nothing `?watch=` would not), and the link is
// `/tv/<tvId>?follow=<slot + 1>`: the room's races, the camera on Racer N,
// which is what the anonymised feed already calls them. No code and no name
// in it (call 3, Matt, 2026-09-30: no names on TV, ever, WATCH ME included).
// The TV id lives as long as the room, so the link works for every race in it.
//
// DOM-free: the fetch comes in. `boot/app.ts` presses it from the lobby's
// WATCH ME row and puts the link on the clipboard (flat) or the plate (a
// headset, where nothing pastes).

import { answerOf } from '@/net/fetch-json'
import { TV_ID_SHAPE } from '@/net/tv-protocol'
import { tvShortLink } from './tv-link'

/** WATCH ME's route, same origin. */
export const watchMePath = (code: string): string => `/api/room/${code}/tv`

/**
 * The room's TV id, or null when the room is not there (404), the site has no
 * rooms (503), or the answer is not a TV id. Never throws.
 */
export const fetchWatchMe = async (
  code: string,
  get: (path: string) => Promise<{ readonly status: number; readonly body: unknown }>,
): Promise<string | null> => {
  try {
    const r = await get(watchMePath(code))
    if (r.status !== 200 || typeof r.body !== 'object' || r.body === null) return null
    const tv = (r.body as { tv?: unknown }).tv
    return typeof tv === 'string' && TV_ID_SHAPE.test(tv) ? tv : null
  } catch {
    return null
  }
}

/** The link a player sends: the short form, following their own seat (Racer slot + 1). */
export const watchMeLink = (host: string, tv: string, slot: number): string =>
  tvShortLink(host, { kind: 'race', tv, follow: slot + 1 })

/** What a WATCH ME press made: its link (null: none could be made), and whether it is shown. */
export interface WatchMeMade {
  readonly link: string | null
  readonly at: number
  /** In a headset the row shows the link; flat, it says it was copied. */
  readonly shown: boolean
}

/**
 * What the WATCH ME row shows now: a headset keeps the link up (nothing pastes
 * there); flat, the row says "copied" for `forMs`, then is the row again.
 */
export const watchMeNow = (made: WatchMeMade | null, forMs: number): WatchMeMade | null =>
  made !== null && (made.shown || performance.now() - made.at < forMs) ? made : null

/**
 * The lobby's WATCH ME press, on this page: ask the room, make the link, and
 * put it on the clipboard (flat; the press is the gesture) or hand it back to
 * be shown (a headset). `done` hears what was made.
 */
export const pressWatchMe = (
  code: string,
  slot: number,
  presenting: boolean,
  done: (made: WatchMeMade) => void,
): void => {
  void fetchWatchMe(code, (path) => fetch(path, { cache: 'no-store' }).then(answerOf)).then(
    (tv) => {
      const link = tv === null ? null : watchMeLink(globalThis.location.host, tv, slot)
      done({ link, at: performance.now(), shown: presenting && link !== null })
      if (link === null) {
        console.warn('room: WATCH ME, no TV link from the room')
        return
      }
      console.info(`room: WATCH ME, ${link}`)
      if (!presenting) {
        void navigator.clipboard?.writeText(`${globalThis.location.protocol}//${link}`).then(
          () => {},
          (err: unknown) => console.warn(`room: could not copy the TV link (${link})`, err),
        )
      }
    },
  )
}
