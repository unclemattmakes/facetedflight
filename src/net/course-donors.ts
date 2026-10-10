// src/net/course-donors.ts: what the room judge builds a player's course from:
// the shipped missions a course can be built on, and the files its rules are
// hashed over. DATA, like `lap-courses.ts`'s JSON; the logic is `room-course.ts`. DEV-851 (docs/plan/ROOM-PLAYER-COURSES.md).
//
// A player course names a shipped HoverJet mission as its `sky`, and
// `expandPlayerCourse` needs that level. The game loads it with `loadLevel`,
// which a Function cannot import (`import.meta.glob`), so the judge reads the
// same JSON here. Two facts keep the two the same level, both in
// `tests/unit/room-course.test.ts`: this list is every generated HoverJet
// mission, and each entry equals what `loadLevel` returns for it (so the day a
// mission gains an override, that test goes red until this file applies it).
//
// About 210 KB gzipped in the Functions bundle. Imported by the judge only; the
// game never imports this file.

import type { Aircraft } from '@/content/aircraft-schema'
import type { Edition } from '@/content/edition-schema'
import { type Level, validateLevel } from '@/content/level-schema'
import hoverjetJson from '../../content/aircraft/hoverjet.json'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'
import adv01 from '../../content/levels/adv_01_hoverJet.json'
import adv02 from '../../content/levels/adv_02_hoverJet.json'
import kauai from '../../content/levels/hoverJet_kauai_beg.json'
import int01 from '../../content/levels/int_01_hoverJet.json'
import int02 from '../../content/levels/int_02_hoverJet.json'
import rookie01 from '../../content/levels/rookie_01_hoverJet.json'
import rookie02 from '../../content/levels/rookie_02_hoverJet.json'

/**
 * The editions and the aircraft a player course's rules are hashed over: the
 * same files, read the same way, as `content/lap-courses.json`'s
 * (`tests/unit/lap-courses.test.ts`). `room-course.test.ts` holds this list to
 * the directory, so a new edition cannot be raced with no rules.
 */
export const ROOM_COURSE_EDITIONS = [anniversaryJson, classicJson] as unknown as readonly Edition[]
/** Only the HoverJet flies a player course (`PlayerCourseVehicle`). */
export const ROOM_COURSE_AIRCRAFT = [hoverjetJson] as unknown as readonly Aircraft[]

const RAW: Readonly<Record<string, unknown>> = Object.fromEntries(
  [adv01, adv02, kauai, int01, int02, rookie01, rookie02].map((l) => [(l as { id: string }).id, l]),
)

/** Validated on first use, as `loadLevel` validates: once per isolate. */
const validated = new Map<string, Level>()

/** Every donor id, sorted: the test compares it with the generated HoverJet missions. */
export const ROOM_DONOR_IDS: readonly string[] = Object.keys(RAW).sort()

/** The shipped level a course names as its sky, or null. */
export const roomDonor = (id: string): Level | null => {
  if (!Object.hasOwn(RAW, id)) return null
  let level = validated.get(id)
  if (!level) {
    level = validateLevel(RAW[id] as Level)
    validated.set(id, level)
  }
  return level
}
