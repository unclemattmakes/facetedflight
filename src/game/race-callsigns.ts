// src/game/race-callsigns.ts: which seed names which race's racers. DEV-651.
//
// `content/callsigns.ts` draws names from a seed; this is where the seeds come
// from, one function per kind of race, so every client that can see a race
// computes the SAME seed for it (a callsign is a function of the race, never of
// the machine: that file's header).
//
//   · Single player and TV's exhibition: the ATTEMPT (DEV-844, Matt,
//     2026-10-08: "different callsigns each time"). It was the course, five
//     fixed names to learn; it is a fresh draw at load and on every retry.
//   · A room: the race the owner froze at START: its course, which start each
//     seat took, its bots and its colours. Every client holds exactly that
//     (`RoomRace`), the host flies its bots from it, and a TV viewer's
//     anonymised copy keeps all of it (only handles are stripped), so the host,
//     the others and a watcher name a bot alike.
//
// Pure: no three, no DOM.

import { callsignSeed, drawCallsigns } from '@/content/callsigns'
import type { RoomRace } from '@/net/room-protocol'

/** The course's fixed seed. Kept for tests and tools; single player draws per attempt now. */
export const courseCallsignSeed = (courseId: string): number => callsignSeed('course', courseId)

let attempts = 0
/**
 * DEV-844: the seed of ONE ATTEMPT at a course. Single player and the
 * exhibition name their rivals afresh every attempt (Matt, 2026-10-08), so the
 * seed mixes the course with a counter and a random draw. A room does not use
 * this: its names must agree on every client (`roomCallsignSeed`).
 */
export const attemptCallsignSeed = (courseId: string): number => {
  attempts += 1
  return callsignSeed('attempt', courseId, attempts, Math.floor(Math.random() * 0x100000000))
}

/** `{k: v}` as `k=v` pairs in ascending key order, whatever order the object was built in. */
const pairs = (record: Readonly<Record<number, number>>): string =>
  Object.entries(record)
    .map(([k, v]) => [Number(k), v] as const)
    .sort((a, b) => a[0] - b[0])
    .map(([k, v]) => `${k}=${v}`)
    .join(',')

/** The seed for a room's frozen race. */
export const roomCallsignSeed = (race: RoomRace): number =>
  callsignSeed(
    'room',
    race.mission,
    pairs(race.starts),
    race.bots.map((b) => `${b.index}:${b.start}:${b.colour}`).join(','),
    pairs(race.colours),
  )

/** A room's bots' callsigns, by bot index: the same on the host and on every client. */
export const roomBotCallsigns = (race: RoomRace): string[] =>
  drawCallsigns(roomCallsignSeed(race), race.bots.length)
