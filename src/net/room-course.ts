// src/net/room-course.ts: a PLAYER'S course as a room races it. DEV-851
// (docs/plan/ROOM-PLAYER-COURSES.md).
//
// A shipped course reaches the judge as an entry of the generated
// `content/lap-courses.json`. A player's course cannot be in that file, so the
// room carries its link token (`RoomSettings.course`) and BOTH sides build the
// same entry from it, with the same code:
//
//   the room's owner   `playerRoomRules` for `configure`'s `rules` and `seats`
//   every client       the same, to `ready` with a matching rules string
//   the judge          `roomCourseFromToken`, then `validateCompressedLap`
//                      against the one-entry `LapCourses` it returns
//
// So a client and the judge cannot disagree about a course's gates or its
// rules unless they are different builds, which the rules string itself then
// says (4002 at `ready`, `room` at the judge).
//
// The donor (the shipped mission a course names as its `sky`) is the caller's:
// the game loads it with `loadLevel`, the judge reads it from `course-donors.ts`.
// The level built here is the course before its ground and water are put
// under it (`load-player-course.ts`), which change nothing a lap is judged by.
//
// SERVER-SAFE: no loader, no DOM, no three. `lap-server-bundle.test.ts` walks it.

import { type Level, validateLevel } from '@/content/level-schema'
import { expandPlayerCourse, type PlayerCourse, playerCourseId } from '@/content/player-course'
import { readCourseToken } from '@/content/player-course-wire'
import { validateModeContent } from '@/game/modes'
import { ROOM_COURSE_AIRCRAFT, ROOM_COURSE_EDITIONS } from './course-donors'
import type { LapCourse, LapCourses } from './lap-courses'
import { buildLapCourses } from './lap-courses-build'

export { ROOM_COURSE_AIRCRAFT, ROOM_COURSE_EDITIONS }

/** A course against its donor, as the game flies it before its ground: throws `PlayerCourseError`. */
export const playerCourseLevel = (course: PlayerCourse, donor: Level): Level =>
  validateModeContent(validateLevel(expandPlayerCourse(course, donor)))

/** The judge's entry for a player course's level, or null when it is not a judged course. */
export const playerLapCourse = (level: Level): LapCourse | null =>
  buildLapCourses([level], ROOM_COURSE_EDITIONS, ROOM_COURSE_AIRCRAFT).courses[level.id] ?? null

/** One course as a `LapCourses`, the shape `validateCompressedLap` takes. */
export const asLapCourses = (course: LapCourse): LapCourses => ({
  ...buildLapCourses([], ROOM_COURSE_EDITIONS, ROOM_COURSE_AIRCRAFT),
  courses: { [course.mission]: course },
})

/**
 * The rules strings a room on this course carries, by variant, for `edition`
 * (`RoomSettings.rules`): what `lapRules` gives a shipped course.
 */
export const playerRoomRules = (
  level: Level,
  edition: string,
): Readonly<Record<string, string>> | null => {
  const entry = playerLapCourse(level)?.editions[edition]
  if (!entry) return null
  return Object.fromEntries(Object.entries(entry.variants).map(([id, v]) => [id, v.rules]))
}

export type RoomCourseResult =
  | { readonly ok: true; readonly course: LapCourse }
  | { readonly ok: false; readonly reason: string }

/**
 * The judge's side: a race's token to its course, or why not. `mission` is
 * the id the room raced under, and the token must BE that course; `donorOf`
 * hands back the shipped level a course names as its sky, or null.
 */
export const roomCourseFromToken = async (
  token: string,
  mission: string,
  donorOf: (id: string) => Level | null,
): Promise<RoomCourseResult> => {
  const read = await readCourseToken(token)
  if (!read.ok) return { ok: false, reason: 'the room’s course does not read' }
  const course = read.course
  if (playerCourseId(course) !== mission) {
    return { ok: false, reason: 'the room’s course is not the course it races' }
  }
  const donor = donorOf(course.sky)
  if (!donor) return { ok: false, reason: `no shipped mission ${course.sky} to build it on` }
  let level: Level
  try {
    level = playerCourseLevel(course, donor)
  } catch {
    return { ok: false, reason: 'the room’s course does not build' }
  }
  const entry = playerLapCourse(level)
  return entry ? { ok: true, course: entry } : { ok: false, reason: 'the course is not a race' }
}
