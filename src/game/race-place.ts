// src/game/race-place.ts — where you are in the race, WHILE it is being run.
// DEV-361.
//
// Matt, 2026-09-24: *"simplified race mini map hud to understand your position
// relative to others"*, and the playtest's game-director row: *"make the race
// legible: your place live on the HUD"*.
//
// ── Two orderings, and the line between them ──────────────────────────────
//
// `game/results-state.ts`'s `withStandings` (DEV-344) orders the race by TIME,
// and it can only do that once the player has one. Before the line nobody has
// a time, so a place in the air needs a different question: **how far round the
// course has each entrant got?**
//
//   · At and after the player's crossing, `livePlace` IS `withStandings` — the
//     same call, on the same run and the same standings — so the HUD and the
//     results panel cannot disagree about where you finished. That is the whole
//     reason this function takes the `RunSummary` rather than a place.
//   · Before it, a racer that has CROSSED is ahead of you (it has a time and you
//     do not), a racer the race clock stopped is behind you, and a racer still
//     flying is compared on PROGRESS: the furthest gate reached, then metres
//     along the racing line.
//
// ── Why the furthest gate REACHED, and not the gates TAKEN ────────────────
//
// The brief said "gates taken". It agrees with this everywhere except where the
// two can disagree, which is exactly where it matters (the agreement lesson):
// a ring is optional. `withStandings` orders finishers by time and nothing else,
// and DEV-289 made the crash reset read progress rather than the first hole
// ("a ring you missed is not a ring you are behind"). So a player who skipped
// ring 3 and is 300 m clear of a racer on leg 7 will cross first and be placed
// first — and a live place built on the COUNT would read P2 for the whole of
// that lead and jump to P1 at the line. The furthest gate reached is
// `sim/crash.ts`'s `crashLimitS` notion of how far a run has got, it equals the
// count whenever nothing is skipped, and it is always true for the AI, which
// turns back for a ring it missed (`autopilot.ts`'s `nextGate`).
//
// ── Why arc length is searched on ONE leg ─────────────────────────────────
//
// `int_01` doubles back on itself twice, so a ship on leg 4 can be nearer to
// leg 9's line than to its own. `routeArcLengthNear` searches the whole line
// and would put it nine gates ahead. The search here starts a segment before
// the furthest gate taken and stops at the gate being flown to — the window
// `crashLimitS` already defines for the reset — so the arc stays on the leg.
//
// Renderer-free: plain data in, plain data out, pinned by
// `tests/unit/race-place.test.ts`. No numeric literal carries a tuning.

import { type RacerReading, racerStanding, withStandings } from '@/game/results-state'
import type { OpponentStanding, RunSummary } from '@/render/results'
import { crashLimitS } from '@/sim/crash'
import type { Vec3 } from '@/sim/math/vec3'
import {
  advanceRoute,
  createRouteCursor,
  type Route,
  rewindCursor,
  routeSegmentAt,
} from '@/sim/route'

/** The line every entrant is measured along, and each gate's arc length on it. */
export interface RaceLine {
  readonly route: Route
  readonly gateArc: readonly number[]
}

/** How far round the course an entrant has got. */
export interface RaceProgress {
  /** 1 + the index of the furthest gate taken; 0 before the first. */
  reached: number
  /** Metres along the racing line, searched on the leg being flown. */
  arc: number
}

/**
 * 1 + the index of the furthest gate taken, or 0 before the first.
 *
 * Not `passedCount`: see the header. A run that took gates 0, 1 and 3 has
 * REACHED four and TAKEN three, and it is ahead of a run that took 0, 1 and 2.
 */
export const gatesReached = (passed: readonly boolean[]): number => {
  for (let i = passed.length - 1; i >= 0; i -= 1) if (passed[i]) return i + 1
  return 0
}

/** Volatile: the search cursor, valid only inside one `raceProgress`. */
const _cursor = createRouteCursor()

/**
 * Where an entrant is: the furthest gate reached, and its arc on that leg.
 *
 * `out` is written and returned, so a caller stepping six entrants a frame
 * allocates nothing.
 */
export const raceProgress = (
  line: RaceLine,
  passed: readonly boolean[],
  position: Vec3,
  out: RaceProgress = { reached: 0, arc: 0 },
): RaceProgress => {
  const reached = gatesReached(passed)
  const { route, gateArc } = line
  // The top of the window: the gate being flown to, or the whole line once the
  // last is taken. The same bound the crash reset searches under (DEV-289).
  const top = crashLimitS(gateArc, passed, route.length)
  // The bottom: the furthest gate taken — started ONE SEGMENT earlier, because a
  // gate scores on entering its sphere, which is before its own point on the
  // line. Without the step back, two ships that had just taken the same ring
  // would both read the ring's arc exactly and tie for a moment.
  const from = reached > 0 ? (gateArc[reached - 1] as number) : 0
  rewindCursor(route, _cursor, from)
  _cursor.index = Math.max(0, _cursor.index - 1)
  const last = routeSegmentAt(route, top)
  advanceRoute(route, _cursor, position, Math.max(1, last - _cursor.index))
  out.reached = reached
  out.arc = _cursor.s
  return out
}

/** A racer, as the live place reads it. */
export interface RacerPlaceReading {
  /** `racerStanding`'s answer: crossed, flying, or out of time. */
  readonly standing: OpponentStanding
  readonly progress: RaceProgress
}

/**
 * Is this racer ahead of the player, who is still flying?
 *
 * Crossed beats flying, flying beats out of time, and two runs still in the
 * air compare on gates reached and then on metres. **Strictly** ahead, so two
 * entrants at exactly the same progress share a place, as a dead heat does on
 * the results panel.
 */
export const racerAhead = (racer: RacerPlaceReading, player: RaceProgress): boolean => {
  if (racer.standing.status === 'finished') return true
  if (racer.standing.status === 'dnf') return false
  const r = racer.progress
  return r.reached > player.reached || (r.reached === player.reached && r.arc > player.arc)
}

/** The player's place and the field, or a null place where there is none. */
export interface LivePlace {
  readonly place: number | null
  /** How many are racing, the player included; 0 with no race. */
  readonly field: number
}

/**
 * The player's place, now.
 *
 * `run` is the player's `RunSummary` once the run has ENDED (the tick
 * `summariseRun` took it), and null while it is still being flown. With a run,
 * the answer is `withStandings`'s — literally, so the HUD and the results panel
 * are one function at the line. With none, it is one more than the racers
 * strictly ahead.
 *
 * No opposition is no race, and the place is null rather than "1st of 1",
 * which is `withStandings`'s rule too.
 */
export const livePlace = (
  run: RunSummary | null,
  player: RaceProgress,
  racers: readonly RacerPlaceReading[],
): LivePlace => {
  if (racers.length === 0) return { place: null, field: 0 }
  if (run) {
    const board = withStandings(
      run,
      racers.map((r) => r.standing),
    )
    return { place: board.place, field: board.field }
  }
  let ahead = 0
  for (const racer of racers) if (racerAhead(racer, player)) ahead += 1
  return { place: 1 + ahead, field: racers.length + 1 }
}

/** What `placeNow` reads off a live `AiRacer` — its result so far, and where it is. */
export interface LiveRacerReading extends RacerReading {
  readonly course: { readonly passed: readonly boolean[] }
  readonly jet: { readonly body: { readonly position: Vec3 } }
}

/**
 * The player's place from the live objects, as `boot/app.ts` holds them.
 *
 * Every entrant is measured along ONE line by ONE function, so two arcs are
 * always comparable; each racer's result comes from `racerStanding`, the
 * results panel's own reader, against the same race clock (`raceTimeLimit`).
 *
 * `others` are entrants already read — a room's other players (DEV-390,
 * `game/room-results.ts`'s `roomPlaceReadings`), measured along the same line
 * by the same `raceProgress`.
 */
export const placeNow = (
  line: RaceLine,
  run: RunSummary | null,
  player: { readonly passed: readonly boolean[]; readonly position: Vec3 },
  racers: readonly LiveRacerReading[],
  timeLimit: number,
  others: readonly RacerPlaceReading[] = [],
): LivePlace =>
  livePlace(run, raceProgress(line, player.passed, player.position), [
    ...racers.map((racer) => ({
      standing: racerStanding(racer, timeLimit),
      progress: raceProgress(line, racer.course.passed, racer.jet.body.position),
    })),
    ...others,
  ])
