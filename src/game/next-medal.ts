// src/game/next-medal.ts: "what would the next medal take", for the results. DEV-650.
//
// The consultant's review (2026-10-05, design item 2) asked for *"1.4 s to
// gold"*, assuming a medal can be bought with time. It cannot, and the line
// would have been a lie: since DEV-393 the time bonus is paid only on a run
// that took EVERY ring, and FF2's platinum is the ring ceiling itself
// (`medalsFf2`, the DEV-393 follow-up: "gold medal = 90, plat = 100"). So a
// clean run is platinum whatever the clock says, and a run that is not
// platinum is short of RINGS. The honest line is therefore in the objective's
// own unit: `2 MORE RINGS FOR GOLD`, `1 MORE ORB FOR SILVER`, and for a points
// scale with no ring behind it (Target Practice) `340 MORE POINTS FOR GOLD`.
//
// Time still has its line, for the runs where time is the axis: a clean run
// is told which lap on the board is the next one to beat, in seconds
// (`game/results-board.ts`'s `nextBeat`). Those two never show together: a
// clean run has no medal left to take, and a run with a medal left to take is
// not on the board.
//
// DEV-846 (Matt, 2026-10-08: "it'd be nice if time was factored in") changed the
// premise above: platinum is every ring plus half of a bounded clock term
// (`game/medal-time.ts`), so a clean run that is not platinum is short of SPEED,
// and the line says so: `3.4 S FASTER FOR PLATINUM`, or `2 MORE RINGS AND A FAST
// LAP FOR PLATINUM` while rings are still to take. Bronze to gold stay rings.
//
// Read from `medalCurve`, the same thresholds `awardMedal` reads, so the line
// cannot disagree with the medal the panel prints.

import type { GameMode, Level } from '@/content/level-schema'
import { liveRings } from '@/content/level-schema'
import { clockCountsInMedal, pointsPerSecond, timeTermFor } from '@/game/medal-time'
import { medalCurve, rulesFor } from '@/game/modes'

/** Weakest first: the order a player climbs them in. */
const ASCENDING = ['bronze', 'silver', 'gold', 'platinum'] as const
export type MedalBand = (typeof ASCENDING)[number]

/** What the objective is called in the line, singular and plural. */
const unitOf = (mode: GameMode, count: number): string => {
  const rules = rulesFor(mode)
  if (rules.medalScale === 'count') {
    // Free Flight's orbs: the mode's own word, as the HUD's first row says it.
    const word = rules.countFallback.toUpperCase()
    return count === 1 && word.endsWith('S') ? word.slice(0, -1) : word
  }
  if (rules.scores.includes('ring')) return count === 1 ? 'RING' : 'RINGS'
  return count === 1 ? 'POINT' : 'POINTS'
}

/** How many of the unit the gap is: rings are worth the level's gate multiplier each. */
const unitsFor = (level: Level, mode: GameMode, gap: number): number => {
  const rules = rulesFor(mode)
  if (rules.medalScale === 'count') return Math.ceil(gap)
  if (rules.scores.includes('ring')) {
    const each = level.scoring.gateMultiplier
    return each > 0 ? Math.ceil(gap / each) : Math.ceil(gap)
  }
  return Math.ceil(gap)
}

export interface NextMedal {
  readonly band: MedalBand
  /** In the objective's unit: rings, orbs or points. */
  readonly units: number
  /** `RINGS`, `ORB`, `POINTS`. */
  readonly unit: string
  /**
   * DEV-846: the next medal also asks for pace (platinum, where the clock counts
   * in the medal). With `units` rings still to take that is "and a fast lap";
   * with none left (`units` 0) it is only the clock.
   */
  readonly needsTime: boolean
  /** With `needsTime` and every ring taken: seconds faster the lap must be, to a tenth, rounded up. */
  readonly seconds: number | null
}

/**
 * The next band above `input` and what it takes, or null: no medal in this
 * mode, or the run is already past the top one.
 */
export const nextMedal = (level: Level, mode: GameMode, input: number): NextMedal | null => {
  const curve = medalCurve(level, mode)
  if (!curve) return null
  for (const band of ASCENDING) {
    const need = curve[band]
    if (need > input) {
      // DEV-846: platinum is every ring PLUS a share of the clock's term. Rings
      // are counted against the course's ceiling, and what is left over is time.
      if (band === 'platinum' && clockCountsInMedal(level, rulesFor(mode))) {
        const term = timeTermFor(level)
        if (term) {
          const each = level.scoring.gateMultiplier
          const ceiling = liveRings(level).reduce((sum, r) => sum + r.scoring.addScore * each, 0)
          const ringsLeft = each > 0 ? Math.ceil(Math.max(0, ceiling - input) / each) : 0
          const seconds =
            ringsLeft === 0
              ? Math.max(0.1, Math.ceil(((need - input) / pointsPerSecond(term)) * 10) / 10)
              : null
          return {
            band,
            units: ringsLeft,
            unit: unitOf(mode, ringsLeft),
            needsTime: true,
            seconds,
          }
        }
      }
      const units = Math.max(1, unitsFor(level, mode, need - input))
      return { band, units, unit: unitOf(mode, units), needsTime: false, seconds: null }
    }
  }
  return null
}

/** `2 MORE RINGS FOR GOLD`, or null where there is nothing left to climb. */
export const nextMedalLine = (level: Level, mode: GameMode, input: number): string | null => {
  const next = nextMedal(level, mode, input)
  if (!next) return null
  const band = next.band.toUpperCase()
  // DEV-846: time can now close the gap to platinum, so the line says so.
  if (next.needsTime) {
    return next.seconds !== null
      ? `${next.seconds.toFixed(1)} S FASTER FOR ${band}`
      : `${next.units} MORE ${next.unit} AND A FAST LAP FOR ${band}`
  }
  return `${next.units} MORE ${next.unit} FOR ${band}`
}
