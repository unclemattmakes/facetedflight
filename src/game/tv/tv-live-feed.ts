// src/game/tv/tv-live-feed.ts: a room's race, as TV's panel reads it. DEV-480.
//
// DEV-482's on-screen layer (`render/tv-panel.ts`) draws the ident, the lower
// third and the results card from a `TvPanelFeed`. For the exhibition it
// builds that feed itself; for a LIVE race this builds it, each frame, from
// what the watch already holds: the session (the race's seats, the verdicts,
// the rings each racer reported) and the drawn ships (the tick each is shown
// at, two seconds behind the race).
//
//   - **Names:** none. A live row is Racer N (`tvLiveRow`: slot + 1), and the
//     panel draws only that number for a live row (plan/FF-TV.md §2.3, call 3).
//   - **Places:** finished racers by time; then those flying, by rings taken by
//     the tick they are drawn at (`roomPassedAt`: a ring counts once the drawn
//     ship has flown it), ties by seat; then those out (DNF, left, refused).
//   - **Over:** the room's own rule, a verdict for every racer
//     (`RoomServer.phase`), never the session's phase, which a `results`
//     message does not move (DEV-480's finding in `tv-live.spec.ts`).
//
// A room's bots are not rows yet: their names are the host's tunings, which
// the boot holds, not the session. Pure: no DOM, no three.

import type { RoomPhase, RoomPlayerView, RoomRace, RoomVerdict } from '@/net/room-protocol'
import {
  type TvPanelFeed,
  type TvPanelPhase,
  type TvPanelRow,
  type TvRowStatus,
  tvFollowedKey,
  tvLiveRow,
} from '@/render/tv-panel-layout'
import { FIXED_DT } from '@/sim/constants'
import { type RoomDrawnRacer, roomPassedAt, roomRaceSlots, roomStandingOf } from '../room-results'

/** What the feed reads off the watched session. */
export interface TvLiveSession {
  readonly roomPhase: RoomPhase | null
  readonly players: Readonly<Record<number, RoomPlayerView>>
  readonly race: RoomRace | null
  readonly results: readonly RoomVerdict[]
  readonly ringTicks: Readonly<Record<number, readonly number[]>>
}

export interface TvLiveContext {
  /** `tvCourseLabel(place, mode)`, or empty while unknown. */
  readonly course: string
  /** The course's rings. */
  readonly gates: number
  /** A palette index as CSS (`roomColourCss`). */
  readonly colourOf: (index: number) => string | null
  /** The list entry's head count, or null. */
  readonly racers: number | null
  /** The camera's `report()`, or null. */
  readonly report: { readonly following: string | null; readonly racer: number | null } | null
  /** The racer a link's `?follow=` named, or null. */
  readonly linkFollows: number | null
  /** The list's rooms getting ready, or null. */
  readonly lobbies: number | null
}

const STATUS_ORDER: Readonly<Record<TvRowStatus, number>> = { finished: 0, flying: 1, dnf: 2 }

/** Volatile scratch for `roomPassedAt`. */
const _passed: boolean[] = []

/** Is the race over by the room's own rule: a verdict for every racer? */
export const tvLiveOver = (s: Pick<TvLiveSession, 'race' | 'results'>): boolean => {
  const racers = s.race ? Object.keys(s.race.starts).length : 0
  return racers > 0 && s.results.length >= racers
}

const phaseOf = (s: TvLiveSession): TvPanelPhase => {
  if (s.roomPhase === null || s.roomPhase === 'lobby') return 'off'
  if (s.roomPhase === 'results' || tvLiveOver(s)) return 'results'
  return s.roomPhase === 'racing' ? 'racing' : 'ident'
}

/** The live race as the panel reads it. */
export const tvLiveFeed = (
  s: TvLiveSession,
  drawn: readonly RoomDrawnRacer[],
  c: TvLiveContext,
): TvPanelFeed => {
  const standing = { slot: null, players: s.players, race: s.race, results: s.results }
  let tick = 0
  const unsorted = roomRaceSlots(standing).map((slot) => {
    const st = roomStandingOf(standing, slot)
    const verdict = s.results.find((r) => r.slot === slot)
    const ship = drawn.find((d) => d.slot === slot)
    if (ship?.tick != null && ship.tick > tick) tick = ship.tick
    const rings =
      verdict?.rings ??
      roomPassedAt(s.ringTicks[slot], ship?.drawn ? ship.tick : null, c.gates, _passed).filter(
        Boolean,
      ).length
    // The race's frozen colour, as the race map reads it; the seat's own before.
    const colour = s.race?.colours[slot] ?? s.players[slot]?.colour
    return {
      slot,
      status: st.status,
      seconds: st.seconds,
      rings,
      colour: colour === undefined ? null : c.colourOf(colour),
    }
  })
  unsorted.sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      (a.status === 'finished' ? (a.seconds ?? 0) - (b.seconds ?? 0) : b.rings - a.rings) ||
      a.slot - b.slot,
  )
  const rows: TvPanelRow[] = unsorted.map((r, i) => tvLiveRow({ ...r, place: i + 1 }))
  return {
    show: 'live',
    phase: phaseOf(s),
    course: c.course,
    racers: c.racers,
    rows,
    gates: c.gates,
    followed: tvFollowedKey(c.report, rows),
    linkFollows: c.linkFollows,
    lobbies: c.lobbies,
    raceSeconds: Math.max(0, tick) * FIXED_DT,
  }
}
