// tests/unit/tv-schedule.test.ts — TV's exhibition picks its course by the
// clock. DEV-483 (plan/FF-TV.md §4.0, §4.1).
//
// What is worth asserting, each against something outside the schedule:
//  1. The same slot is the same course for every caller — however the caller
//     happened to enumerate the courses — and the same instant is one slot.
//  2. No course twice running, over a span that crosses many epoch seams (the
//     one place the shuffle could repeat), at every list size that can avoid
//     it — and for the exhibition's own turn (`nextExhibitionSlot`), from any
//     clock and any last course.
//  3. The list it schedules over is exactly the release build's HoverJet Ring
//     Attack courses: read off the level JSON on disk and the release preset,
//     not off the function `boot/app.ts` hands in.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { editionFlies, fleetOf } from '@/content/aircraft-schema'
import { forChannel } from '@/content/build-channel'
import { type Edition, validateEdition } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import { loadMissionIndex } from '@/game/mission-index'
import { rulesFor, runningMode } from '@/game/modes'
import { QUICK_RACE, quickRacePool } from '@/game/quick-race'
import {
  courseForSlot,
  nextExhibitionSlot,
  TV_SLOT_SECONDS,
  tvSchedule,
  tvSlotAt,
} from '@/game/tv/tv-schedule'
import anniversaryJson from '../../content/editions/anniversary.json'
import { REPO as ROOT } from './helpers/repo-root'

const SLOT_MS = TV_SLOT_SECONDS * 1000
const RELEASE = forChannel(validateEdition(anniversaryJson as unknown as Edition), 'release')

/** Six made-up ids: the schedule must not care what a course is called. */
const SIX = ['f', 'b', 'd', 'a', 'e', 'c']
const shuffled = (list: readonly string[], by: number): string[] =>
  [...list].sort((a, b) => ((a.charCodeAt(0) * by) % 7) - ((b.charCodeAt(0) * by) % 7))

describe('the same slot, the same course, everywhere', () => {
  it('names one course per slot whatever order the courses arrive in', () => {
    for (let slot = -50; slot < 500; slot++) {
      const course = courseForSlot(slot, SIX)
      expect(courseForSlot(slot, shuffled(SIX, 3)), `slot ${slot}`).toBe(course)
      expect(courseForSlot(slot, [...SIX].reverse()), `slot ${slot}`).toBe(course)
      // A duplicate in the list is the same list.
      expect(courseForSlot(slot, [...SIX, 'a']), `slot ${slot}`).toBe(course)
    }
  })

  it('cuts UTC time into slots, and every instant of a slot reads the same', () => {
    const t0 = Date.UTC(2026, 9, 6, 12, 0, 0)
    const slot = tvSlotAt(t0)
    const start = slot * SLOT_MS
    const first = tvSchedule(start, SIX)
    const last = tvSchedule(start + SLOT_MS - 1, SIX)
    expect(first).toEqual({ slot, startMs: start, course: courseForSlot(slot, SIX) })
    expect(last).toEqual(first)
    expect(tvSchedule(start + SLOT_MS, SIX)?.slot).toBe(slot + 1)
    expect(tvSchedule(start, [])).toBeNull()
  })
})

describe('never the same course twice running', () => {
  it('holds across 6,000 slots, through every epoch seam, at every list size from two up', () => {
    const ids = 'abcdefghij'.split('')
    for (let n = 2; n <= ids.length; n++) {
      const list = ids.slice(0, n)
      let previous = courseForSlot(-1000, list)
      for (let slot = -999; slot < 5000; slot++) {
        const course = courseForSlot(slot, list)
        expect(course, `n=${n} slot ${slot}`).not.toBe(previous)
        previous = course
      }
    }
  })

  it('airs every course once an epoch, so none is starved', () => {
    for (let epoch = -20; epoch < 200; epoch++) {
      const aired = Array.from({ length: SIX.length }, (_, i) =>
        courseForSlot(epoch * SIX.length + i, SIX),
      )
      expect(new Set(aired).size, `epoch ${epoch}`).toBe(SIX.length)
    }
  })

  it('has one course to show where there is one, and none where there are none', () => {
    expect(courseForSlot(7, ['only'])).toBe('only')
    expect(courseForSlot(7, [])).toBeNull()
  })

  it('never hands the exhibition the course it just flew, from any clock and any last course', () => {
    const t0 = Date.UTC(2026, 9, 6)
    for (let i = 0; i < 400; i++) {
      const now = t0 + i * 37_000 // a race that ends anywhere in a slot
      for (const course of SIX) {
        for (const lastSlot of [tvSlotAt(now) - 3, tvSlotAt(now), tvSlotAt(now) + 2]) {
          const next = nextExhibitionSlot(now, SIX, { slot: lastSlot, course })
          expect(next?.course, `${course} at ${i}`).not.toBe(course)
          // Never behind the clock, and never behind the slot it flew.
          expect(next?.slot).toBeGreaterThanOrEqual(Math.max(tvSlotAt(now), lastSlot + 1))
        }
      }
      // A viewer who has just arrived gets the clock's slot, exactly.
      expect(nextExhibitionSlot(now, SIX, null)).toEqual(tvSchedule(now, SIX))
    }
  })
})

describe("over the release build's HoverJet Ring Attack courses, and nothing else", () => {
  /** Every level on disk, generated and authored, with the release preset's say on listing. */
  const onDisk = (): Level[] =>
    ['levels', 'authored'].flatMap((dir) =>
      fs
        .readdirSync(path.join(ROOT, 'content', dir))
        .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
        .map(
          (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'content', dir, f), 'utf8')) as Level,
        ),
    )

  it('is the pool boot/app.ts hands in, read independently off the disk', async () => {
    // What a RELEASE build lists: every generated course, and an authored one
    // only when it says `listed` and the release preset flies its aircraft.
    const generated = new Set(
      fs
        .readdirSync(path.join(ROOT, 'content', 'levels'))
        .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
        .map((f) => f.slice(0, -'.json'.length)),
    )
    const releaseListed = onDisk().filter(
      (l) => generated.has(l.id) || (l.listed === true && editionFlies(RELEASE, l.vehicle)),
    )
    const expected = releaseListed
      .filter((l) => l.vehicle === 'hoverjet' && runningMode(l) === QUICK_RACE.mode)
      .map((l) => l.id)
      .sort()
    // The pool the app hands the schedule, built with the RELEASE fleet.
    const pool = quickRacePool(
      await loadMissionIndex(
        undefined,
        fleetOf(() => RELEASE),
      ),
    )
      .map((c) => c.id)
      .sort()
    expect(pool).toEqual(expected)
    expect(pool.length, 'a schedule needs courses').toBeGreaterThanOrEqual(3)
    // Ring Attack races: every course in it has the racers (`modes.ts`).
    expect(rulesFor(QUICK_RACE.mode).opponents).toBe(true)
    // And the preview build's pool is the same set: the glider, the one
    // aircraft a release hides, never flies Ring Attack as a HoverJet.
    const preview = quickRacePool(
      await loadMissionIndex(
        undefined,
        fleetOf(() => anniversaryJson as never),
      ),
    )
      .map((c) => c.id)
      .sort()
    expect(preview).toEqual(expected)
  })

  it('only ever schedules a course from that pool', async () => {
    const pool = quickRacePool(
      await loadMissionIndex(
        undefined,
        fleetOf(() => RELEASE),
      ),
    ).map((c) => c.id)
    const t0 = Date.UTC(2026, 9, 6)
    const seen = new Set<string>()
    for (let i = 0; i < 2000; i++) {
      const slot = tvSchedule(t0 + i * SLOT_MS, pool)
      expect(pool).toContain(slot?.course)
      seen.add(slot?.course as string)
    }
    expect([...seen].sort()).toEqual([...pool].sort())
  })
})
