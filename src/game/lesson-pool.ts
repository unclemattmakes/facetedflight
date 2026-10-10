// src/game/lesson-pool.ts — which lesson Learn to Fly boards. DEV-379.
//
// Matt, 2026-09-24: *"want to learn to fly - add an ai-pilot flight instructor
// course through the canyon"*. `docs/plan/FLIGHT-INSTRUCTOR.md` §7 is where it
// lives: a third title row, **Learn to Fly** (call 2), that boards *"the first
// lesson in the pool … that this browser has not finished, else the first"*.
// This file is that sentence; `game/quick-race.ts` is its sibling for the row
// above it.
//
// ── The pool is the CONTENT's, never a list (hard rule 6) ────────────────
//
// A lesson is a course whose running mode TEACHES — the one question
// `game/modes.ts` answers for everything else that treats a lesson differently
// (`teaches`; nothing outside that file spells the mode) — flown in the
// HoverJet, the aircraft the lessons teach. Which courses those are is read off
// the level index the hangar is built from (`game/mission-index.ts`), which
// holds the generated tree and every authored file that says `"listed": true`
// (DEV-375). So a third lesson joins the row by existing, an unlisted one (the
// DEV-377 fixture) never does, and no id is written here.
//
// ── In id order ───────────────────────────────────────────────────────────
//
// The lessons are outside 2016's campaign chain (`chainIndex` null), so the
// index's own ordering cannot rank them, and the plan's rule is "by id": the
// file names carry the order (`lesson_01_…`, `lesson_02_…`), which is where an
// author puts it.
//
// ── "Finished" is a best on this browser ─────────────────────────────────
//
// A finished lesson writes its best through the normal path (`recordRun`, under
// the mode it ran in and the variant it was flown in), so a lesson is finished
// when ANY best is stored for its id (`hasBestFor`) — flown on the acrobat
// counts as flown. The finder is injected so a test can hand in any history.

import type { VehicleId } from '@/content/level-schema'
import type { MissionCard } from '@/game/mission-index'
import { rulesFor } from '@/game/modes'

/** The aircraft the lessons teach: the flight instructor is a HoverJet racer (DEV-376). */
export const LESSON_VEHICLE: VehicleId = 'hoverjet'

/** Every listed lesson in the index, in id order. */
export const lessonPool = (cards: readonly MissionCard[]): readonly MissionCard[] =>
  cards
    .filter((card) => card.vehicle === LESSON_VEHICLE && rulesFor(card.mode).teaches)
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

/**
 * The lesson to board: the first in the pool this browser has not finished,
 * else the first — a player who has flown them all starts again at the
 * beginning. Null when the pool is empty.
 */
export const pickLesson = (
  pool: readonly MissionCard[],
  finished: (id: string) => boolean,
): string | null => (pool.find((card) => !finished(card.id)) ?? pool[0])?.id ?? null
