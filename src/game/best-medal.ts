// src/game/best-medal.ts — the medal your stored best earns.
//
// 2016 keeps the medal itself: `LevelEnd.cs:205-237` writes
// `PlayerPrefs[levelName + gameMode + " medal"] = "Bronze" | ... | "Platinum"`
// on every bronze-or-better finish, and `Slot_Medal.cs` reads that string back
// to pick a prefab for the holotable. Two things about that record are worth
// knowing before deciding whether the port should copy it:
//
//   * It is the LAST medal, not the best. Every qualifying run overwrites the
//     key — a gold followed by a bronze leaves bronze on the table.
//   * Below bronze writes nothing. `medal = "Lead"` is assigned (line 198) and
//     never stored, so an unflown course stays unflown and a flown-badly course
//     keeps whatever it had. `medal_lead.prefab` exists and no slot ever spawns
//     it.
//
// The port stores a BEST (`personal-best.ts`), and a best carries the medal with
// it: the thresholds are a function of the level and its running mode, and the
// number they are compared against is the one the best already holds. So the
// medal is derived here rather than stored twice — a second stored value is a
// second thing that can disagree, and DEV-014 has already re-tuned one curve.
// A retune moves every table's medal with it, which is what `bestKey`'s
// version suffix promises anyway.
//
// ── Why `best.score` is the right input on ALL THREE scales ─────────────────
//
// `medalInput` (game/mission.ts) hands the curve `missionScore` on a 'points'
// mode and `counted` on a 'count' mode. The stored best is `missionScore` on
// every mode (`boot/app.ts` records it at the finish). Those agree because:
//
//   ringAttack      'points' — the score IS the input.
//   targetPractice  'points' under `padStreak`, the live rule — same.
//   freeFlight      'count'  — but Free Flight scores ONE per orb and earns no
//                   time bonus (`MODES.freeFlight.timeBonus: false`), so
//                   `missionScore === counted` for the whole run.
//
// That last one is a coincidence of the mode table, not a law, so
// `tests/unit/best-medal.test.ts` flies a real Free Flight course and checks the
// derived medal against the one the run was awarded. Add a 'count' mode whose
// score is not its count and that test is the thing that says so.
//
// ── A best set under the OLD rule (DEV-393) ────────────────────────────────
//
// Since DEV-393 a missed ring forfeits the time bonus, so a best set before it
// by a run that skipped rings and crossed the finish holds a score today's rule
// would not pay. `bestRule` says what such a best can be worth, and `readBest`
// holds it there on the way in — so the medal derived here, the table and the
// NEW BEST comparison all see the same, current, number. Nothing is rewritten.

import type { GameMode, Level, Medals } from '@/content/level-schema'
import { awardMedal, courseGates, type Medal } from '@/game/mission'
import { countTotal, medalCurve, rulesFor, runningMode } from '@/game/modes'
import type { BestRule, PersonalBest } from '@/game/personal-best'

/**
 * How a stored best on this course reads under DEV-393's rule, or null where
 * nothing about it can have changed.
 *
 * Null unless the mode pays a time bonus here — no bonus, no stored score can
 * carry one. Where it does, the objective is RINGS (the only kind a mode that
 * pays a bonus scores today), and `worth[k]` is the `k` most valuable rings:
 * exactly `k * 100` on every shipped course, and an upper bound on a
 * hand-authored one whose rings differ, so a best is never read as worth more
 * than its own count could have banked. A future mode that pays a bonus on
 * another kind gets null here until this says how that kind is worth.
 */
export const bestRule = (level: Level, mode: GameMode): BestRule | null => {
  // An unknown mode has no row, and `cardFor` must still word a mission in a
  // mode it has never heard of (`mission-index.test.ts`) — `medalCurve`'s guard.
  const rules = rulesFor(mode) as ReturnType<typeof rulesFor> | undefined
  if (!rules?.clock || !rules.timeBonus || !level.scoring?.timeAffectsMedal) return null
  if (rules.scores.length !== 1 || rules.scores[0] !== 'ring') return null
  const points = courseGates(level)
    .map((g) => g.points)
    .sort((a, b) => b - a)
  const worth = [0]
  for (const p of points) worth.push((worth[worth.length - 1] as number) + p)
  return { total: countTotal(level, mode), worth }
}

/** A medal that is actually a medal. `'none'` is a run below bronze. */
export type MedalTier = Exclude<Medal, 'none'>

/**
 * The medal a stored best earns on its level, or null.
 *
 * Null covers three cases, deliberately not distinguished here because every
 * consumer draws nothing for all three: no best at all; a mode that awards no
 * medal (`rookie_01_jumpSeat` has no thresholds of any kind); and a best below
 * bronze — 2016's "Lead", which it never put on a table either.
 */
export const bestMedal = (level: Level, best: PersonalBest | null): MedalTier | null =>
  curveMedal(medalCurve(level, runningMode(level)), best)

/**
 * {@link bestMedal} with the level's curve already read — what a hangar table
 * needs to re-derive a medal when it re-reads a best for another aircraft
 * variant (DEV-382), with no level in hand. The thresholds are the course's and
 * are SHARED by every variant (AIRCRAFT-VARIANTS §7); only the best differs.
 */
export const curveMedal = (curve: Medals | null, best: PersonalBest | null): MedalTier | null => {
  if (best === null || curve === null) return null
  const medal = awardMedal(best.score, curve)
  return medal === 'none' ? null : medal
}
