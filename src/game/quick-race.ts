// src/game/quick-race.ts — which course a Quick Race boards. DEV-353.
//
// Matt, 2026-09-24: *"want to fly within 20 seconds - add a quick race
// option"*, and in chat the same day: **a random HoverJet Ring Attack course,
// and skip the ride.**
//
// ── The pool is the CONTENT's, never a list (hard rule 6) ────────────────
//
// What a Quick Race IS — a HoverJet, in Ring Attack — is a definition, and it
// is two machine keys: the vehicle here, and the mode in `game/modes.ts`,
// which is the one file allowed to spell a mode (`mode-rules.test.ts`).
// Which courses satisfy it is not written
// anywhere: it is read off the level JSON through the same index the level
// select is built from (`game/mission-index.ts`), so a seventh HoverJet Ring
// Attack course joins the pool by existing, and a course that stops being one
// leaves it the same way.
//
// And it reads the mode the course will RUN in, not the one it was authored
// in. `hoverJet_kauai_beg` is authored Ring Attack and forced to Free Flight
// by 2016 itself; `MissionCard.mode` is `runningMode`'s answer, so it is not
// in the pool, and a Quick Race can never land you in a mode the button did
// not name.
//
// ── The racers come with the mode ─────────────────────────────────────────
//
// There is no "has racers" filter because there is nothing to filter: Ring
// Attack's rules put the opponents on the grid (`game/modes.ts`), so every
// course this returns is raced against them. That was false on CLASSIC's two
// rookie courses until DEV-442 (no `ai` pad, so no racer, two times in six);
// `racer-grid.test.ts` now holds a grid on every Ring Attack course, both
// editions.

import type { GameMode, VehicleId } from '@/content/level-schema'
import type { MissionCard } from '@/game/mission-index'
import { QUICK_RACE_MODE } from '@/game/modes'

/** What the Quick Race button promises: this aircraft, under these rules. */
export const QUICK_RACE: { readonly vehicle: VehicleId; readonly mode: GameMode } = {
  vehicle: 'hoverjet',
  mode: QUICK_RACE_MODE,
}

/** Every course that keeps that promise, in the index's own order. */
export const quickRacePool = (cards: readonly MissionCard[]): readonly MissionCard[] =>
  cards.filter((card) => card.vehicle === QUICK_RACE.vehicle && card.mode === QUICK_RACE.mode)

/**
 * One course from the pool, or null when there is none to give.
 *
 * `random` is a `[0, 1)` source, injected so a test can walk every outcome —
 * the app hands in `Math.random`. Clamped at both ends, so a source that
 * returns exactly 1 (or anything out of range) still names a real course.
 */
export const pickQuickRace = (
  pool: readonly MissionCard[],
  random: () => number,
): string | null => {
  if (pool.length === 0) return null
  const i = Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)))
  return pool[i]?.id ?? null
}
