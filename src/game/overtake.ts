// src/game/overtake.ts: a place gained or lost, and a ship going by. DEV-641.
//
// CONSULTANT-REVIEW-2026-10-05 item E: "With five racers this is the core of a
// race and there is no event for it." `race.position` fires when the player's
// place CHANGES, with the name of the racer who was passed (or who passed), and a
// whoosh goes with every close flyby, panned to the side the ship went by on
// (Matt, twice: "camera shake when ships whoosh by", the shake being DEV-636's).
//
// The place is `race-place.ts`'s own rule (`racerAhead`: crossed beats flying
// beats out of time, then gates reached, then metres along the line) read per
// racer, so this watches exactly the number the race map and the results panel
// show. Nothing here changes a place: it reads one (hard rule 4).
//
// ── Why a HOLD ────────────────────────────────────────────────────────────
//
// Two ships side by side swap `racerAhead` on a few metres of arc, and a swap
// that lasts three frames is not an overtake. A new place has to HOLD for
// `holdSeconds` before it is reported, and two reports are `cooldownSeconds`
// apart at the least. Both are render seconds (`dt` is an argument: no clock).
//
// PURE: no three, no DOM, no clock, no randomness. State per watch (trap 19).

import { type RaceProgress, type RacerPlaceReading, racerAhead } from '@/game/race-place'
import { TRAUMA } from '@/render/camera-shake'

/** FF2's own numbers: 2016 had no overtake. */
export const OVERTAKE = {
  /** A new place must hold this long before it is a change. */
  holdSeconds: 0.3,
  /** Two reports are at least this far apart. */
  cooldownSeconds: 1,
  /** How long the passed racer's name stays on the event row. */
  nameSeconds: 2,
} as const

/** A change of the player's place. */
export interface OvertakeEvent {
  /** True when the place got BETTER (a smaller number). */
  readonly gained: boolean
  readonly from: number
  readonly to: number
  /** The racer passed (a gain) or the one that passed the player (a loss), or null. */
  readonly name: string | null
}

export interface OvertakeWatch {
  /**
   * One render frame. `live` is "the race is on and the player has not finished":
   * false forgets the place, so a restart or the results panel starts clean.
   * Returns the change this frame completed, or null. The object is OWNED by the
   * watch and valid until its next call.
   */
  step(
    readings: readonly RacerPlaceReading[],
    player: RaceProgress,
    live: boolean,
    dt: number,
  ): OvertakeEvent | null
  /** The place the watch holds, or null before a live frame. For the probes. */
  readonly place: number | null
  reset(): void
}

export const createOvertakeWatch = (): OvertakeWatch => {
  let stable: number | null = null
  let ahead: string[] = []
  let pending: number | null = null
  let pendingFor = 0
  let since = Number.POSITIVE_INFINITY
  const out = { gained: false, from: 0, to: 0, name: null as string | null }

  const forget = (): void => {
    stable = null
    ahead = []
    pending = null
    pendingFor = 0
    since = Number.POSITIVE_INFINITY
  }

  return {
    get place() {
      return stable
    },
    step(readings, player, live, dt) {
      if (!live || readings.length === 0) {
        forget()
        return null
      }
      const aheadNow: string[] = []
      for (const r of readings) if (racerAhead(r, player)) aheadNow.push(r.standing.name)
      const place = 1 + aheadNow.length
      if (dt > 0) since += dt
      if (stable === null) {
        stable = place
        ahead = aheadNow
        return null
      }
      if (place === stable) {
        // Settled: remember who is ahead NOW, so a later change names the right racer.
        pending = null
        pendingFor = 0
        ahead = aheadNow
        return null
      }
      if (pending !== place) {
        pending = place
        pendingFor = 0
      } else if (dt > 0) {
        pendingFor += dt
      }
      if (pendingFor < OVERTAKE.holdSeconds || since < OVERTAKE.cooldownSeconds) return null
      const gained = place < stable
      let name: string | null = null
      if (gained) {
        for (const n of ahead) {
          if (!aheadNow.includes(n)) {
            name = n
            break
          }
        }
      } else {
        for (const n of aheadNow) {
          if (!ahead.includes(n)) {
            name = n
            break
          }
        }
      }
      out.gained = gained
      out.from = stable
      out.to = place
      out.name = name
      stable = place
      ahead = aheadNow
      pending = null
      pendingFor = 0
      since = 0
      return out
    },
    reset: forget,
  }
}

/**
 * The line the event row carries: the place, and the racer. `P2  PASSED CUTTER`
 * for a gain, `P3  CUTTER PASSES` for a loss; the name is whatever the standings
 * call the racer (a tuning id today, a callsign once DEV-651 lands), in caps.
 */
export const overtakeLabel = (event: OvertakeEvent): string => {
  const who = event.name === null ? null : event.name.toUpperCase()
  if (who === null) return `#${event.to}`
  return event.gained ? `#${event.to}  PASSED ${who}` : `#${event.to}  ${who} PASSES`
}

/**
 * A flyby's whoosh gain, 0..1: a floor so a pass at the edge of the shake's reach
 * is still heard, up to 1 at the shake's own ceiling. `trauma` is
 * `game/flyby.ts`'s `Flyby.trauma`, so the ear and the camera are one measure.
 */
export const FLYBY_WHOOSH_FLOOR = 0.3

export const flybyWhooshGain = (trauma: number): number => {
  const share = trauma > 0 ? Math.min(1, trauma / TRAUMA.flyby) : 0
  return FLYBY_WHOOSH_FLOOR + (1 - FLYBY_WHOOSH_FLOOR) * share
}
