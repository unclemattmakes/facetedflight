// src/game/tv/tv-schedule.ts — which course TV's exhibition flies, by the clock.
// DEV-483 (plan/FF-TV.md §4.0, §4.1).
//
// Matt, 2026-09-30: *"if no replays exist - it should just show AI racers"*.
// When no room is racing, TV shows the five AI racers on a course the UTC clock
// picks, so a viewer who leaves and comes back inside one programme slot finds
// the same course, every viewer in a slot is on the same one, and the next race
// is on another.
//
// ── The rule, in three lines ──────────────────────────────────────────────
//
//   · UTC time is cut into slots of `TV_SLOT_SECONDS`, numbered from the epoch.
//   · Slots come in EPOCHS of `n` (one per course). Each epoch is a seeded
//     shuffle of the courses, so every course airs once an epoch and none twice
//     inside one; where an epoch would open on the course the last one closed
//     on, its first two swap. So no course is ever on twice running.
//   · The courses are SORTED here before anything else, so two callers who
//     enumerate the same set in different orders still agree.
//
// Non-recursive by construction: slot `k` reads its own epoch's shuffle and the
// LAST entry of the epoch before, and that last entry is never moved by the
// swap (it touches positions 0 and 1, and the last is position `n - 1`, which
// is neither once `n >= 3`). Two courses alternate; one airs every slot,
// because there is nothing else to show.
//
// ── A race is not a slot ─────────────────────────────────────────────────
//
// A slot is a programme length, not a race: the racers finish when they finish.
// So the exhibition asks `nextExhibitionSlot` at each turn — the slot that is
// current NOW, or the one after the slot it just flew if the clock has not
// moved on yet — and steps forward past the course it just flew. Two viewers
// with the same clock and the same last course get the same answer; a viewer
// who has just arrived (no last course) gets the slot's own.
//
// Which courses: the caller's list. `boot/app.ts` hands in Quick Race's pool
// (`game/quick-race.ts`: the HoverJet Ring Attack missions the level index
// lists, which is the release build's list too — `build-channel.ts` hides the
// glider and the variants, neither of which is in it). Pure: no clock of its
// own, no DOM, no three.

import { mulberry32 } from '@/sim/math/rng'

/**
 * One programme slot, seconds.
 *
 * SHORTER than the shortest exhibition, on purpose. A race ends when the last
 * racer is home, which on the six courses is 98–168 s (`steady`, every time;
 * the winner is home in 50–86 s), plus the 3 s countdown and the 8 s results:
 * `tests/unit/tv-exhibition.test.ts` measures every course in the pool,
 * headless with terrain off, and holds each programme longer than a slot. So
 * by the time any race ends the clock has passed the slot it began in, and
 * `nextExhibitionSlot` takes the clock's own slot — every viewer's next race
 * is the clock's, and no viewer's programme drifts ahead of anybody else's.
 * (A slot LONGER than a race would make the schedule run ahead of the wall by
 * the difference every race, without bound.) Not a tuning of anything flown.
 */
export const TV_SLOT_SECONDS = 90

/** One slot of the programme: its number, when it began (UTC ms) and its course. */
export interface TvSlot {
  readonly slot: number
  readonly startMs: number
  readonly course: string
}

/**
 * The epoch shuffle's salt. Any constant works; it is fixed so every client
 * computes the same programme, and written once so nobody re-types it.
 */
const SCHEDULE_SALT = 0x46_46_54_56 // 'FFTV'

/** The courses as every client sees them: distinct, sorted. */
const canonical = (courses: readonly string[]): string[] => [...new Set(courses)].sort()

/** Epoch `e`'s raw shuffle (Fisher–Yates off its own seed), before the seam swap. */
const rawEpoch = (e: number, list: readonly string[]): string[] => {
  const out = [...list]
  const random = mulberry32(Math.imul(e | 0, 0x9e3779b1) ^ SCHEDULE_SALT)
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const t = out[i] as string
    out[i] = out[j] as string
    out[j] = t
  }
  return out
}

/** Epoch `e`'s order, seam-fixed against the epoch before. Needs `list.length >= 3`. */
const epochOrder = (e: number, list: readonly string[]): string[] => {
  const order = rawEpoch(e, list)
  // The epoch before ends on its RAW last entry: its own swap moved only 0 and 1.
  const before = rawEpoch(e - 1, list)
  if (order[0] === before[before.length - 1]) {
    const t = order[0] as string
    order[0] = order[1] as string
    order[1] = t
  }
  return order
}

/** Slot `slot`'s course, or null with no courses. Same answer on every client. */
export const courseForSlot = (slot: number, courses: readonly string[]): string | null => {
  const list = canonical(courses)
  const n = list.length
  if (n === 0) return null
  if (n === 1) return list[0] as string
  const k = Math.floor(slot)
  // `((k % n) + n) % n`: slot numbers before the epoch are negative, and `%`
  // keeps the sign. Nobody's clock reads 1969, but a test's might.
  const at = ((k % n) + n) % n
  if (n === 2) return list[at] as string
  return epochOrder(Math.floor(k / n), list)[at] as string
}

/** The slot `nowMs` falls in. */
export const tvSlotAt = (nowMs: number, slotSeconds = TV_SLOT_SECONDS): number =>
  Math.floor(nowMs / (slotSeconds * 1000))

/**
 * `tvSchedule(nowMs, courses)` (§4.1): the slot the clock is in, when it
 * began, and its course. Null with no courses.
 */
export const tvSchedule = (
  nowMs: number,
  courses: readonly string[],
  slotSeconds = TV_SLOT_SECONDS,
): TvSlot | null => {
  const slot = tvSlotAt(nowMs, slotSeconds)
  const course = courseForSlot(slot, courses)
  return course === null ? null : { slot, startMs: slot * slotSeconds * 1000, course }
}

/**
 * The exhibition's next race: the clock's slot, or the slot after the last one
 * flown if the clock has not passed it — and never `last`'s course again where
 * there is another to fly (see the header). `last` null is a viewer who has
 * just arrived: the clock's slot, exactly.
 */
export const nextExhibitionSlot = (
  nowMs: number,
  courses: readonly string[],
  last: { readonly slot: number; readonly course: string } | null,
  slotSeconds = TV_SLOT_SECONDS,
): TvSlot | null => {
  if (canonical(courses).length === 0) return null
  const clock = tvSlotAt(nowMs, slotSeconds)
  let slot = last ? Math.max(clock, last.slot + 1) : clock
  let course = courseForSlot(slot, courses) as string
  // At most one step where there are two or more courses: neighbouring slots
  // never share one. The bound is for the single-course list, which has
  // nothing else to show.
  if (last && course === last.course && canonical(courses).length > 1) {
    slot += 1
    course = courseForSlot(slot, courses) as string
  }
  return { slot, startMs: slot * slotSeconds * 1000, course }
}
