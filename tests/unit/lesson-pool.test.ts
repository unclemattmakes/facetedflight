// tests/unit/lesson-pool.test.ts — which lesson Learn to Fly boards, and when
// the title says "new here? start here". DEV-379.
//
// `docs/plan/FLIGHT-INSTRUCTOR.md` §9's red-first list for the front door:
// *"the pool is every listed course whose mode teaches, from the index, never
// an id; a storage with a best reads as not a first visit, an empty one and a
// throwing one as a first visit."*
//
// The pool is checked against the level files read straight off the disk,
// not through the loader the pool itself goes through (quick-race.test's
// shape), and the mode is never spelled: the teaching row is found by asking
// the rows.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import { LESSON_VEHICLE, lessonPool, pickLesson } from '@/game/lesson-pool'
import { loadMissionIndex, type MissionCard } from '@/game/mission-index'
import { MODES, rulesFor, runningMode } from '@/game/modes'
import {
  bestKey,
  hasAnyBest,
  hasBestFor,
  type KeyedStorage,
  legacyBestKey,
  recordRun,
} from '@/game/personal-best'
import { REPO as ROOT } from './helpers/repo-root'

/** Every level file in a tree, off the disk — not through `import.meta.glob`. */
const levelsIn = (dir: string): Level[] =>
  fs
    .readdirSync(path.join(ROOT, dir))
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(ROOT, dir, f), 'utf8')) as Level)

const TEACHING = (Object.keys(MODES) as (keyof typeof MODES)[]).find(
  (m) => rulesFor(m).teaches,
) as keyof typeof MODES

/** An in-memory store that can list its keys, as `localStorage` can. */
const memory = (keys: readonly string[] = []) => {
  const map = new Map<string, string>(keys.map((k) => [k, '{}']))
  return {
    map,
    get length() {
      return map.size
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v)
    },
  }
}

/** One that throws on everything, the way a blocked context does. */
const hostile: KeyedStorage = {
  get length(): number {
    throw new DOMException('The operation is insecure.', 'SecurityError')
  },
  key: () => {
    throw new DOMException('The operation is insecure.', 'SecurityError')
  },
}

describe('the pool is the content: every LISTED HoverJet course whose mode teaches', () => {
  it('is exactly that set, read off the disk, in id order', async () => {
    const pool = lessonPool(await loadMissionIndex())
    // The menu's list, by DEV-375's rule: every generated course, and an
    // authored one only where its file says `"listed": true`.
    const expected = [
      ...levelsIn('content/levels'),
      ...levelsIn('content/authored').filter((l) => l.listed === true),
    ]
      .filter((l) => l.vehicle === LESSON_VEHICLE && rulesFor(runningMode(l)).teaches)
      .map((l) => l.id)
      .sort()
    expect(expected.length, 'the content has lessons to board').toBeGreaterThan(0)
    expect(pool.map((c) => c.id)).toEqual(expected)
  })

  it('holds both canyon lessons, first to second, and never the unlisted fixture', async () => {
    const ids = lessonPool(await loadMissionIndex()).map((c) => c.id)
    expect(ids).toEqual(['lesson_01_canyon', 'lesson_02_canyon_run'])
    // DEV-377's fixture teaches too, and says `listed: false`.
    const fixture = levelsIn('content/authored').find((l) => l.id === 'dev377_lesson_fixture')
    expect(fixture && rulesFor(runningMode(fixture)).teaches, 'premise: the fixture teaches').toBe(
      true,
    )
    expect(ids).not.toContain('dev377_lesson_fixture')
  })

  it('picks up a lesson it has never heard of by its fields, and only a HoverJet one', () => {
    const card = (id: string, vehicle: string, mode: string) =>
      ({ id, vehicle, mode }) as unknown as MissionCard
    const pool = lessonPool([
      card('zz_lesson', 'hoverjet', TEACHING),
      card('aa_lesson', 'hoverjet', TEACHING),
      card('seat_lesson', 'jumpseat', TEACHING),
      card('race', 'hoverjet', 'ringAttack'),
    ])
    expect(pool.map((c) => c.id)).toEqual(['aa_lesson', 'zz_lesson'])
  })
})

describe('the lesson to board: the first not finished, else the first', () => {
  const pool = ['lesson_a', 'lesson_b', 'lesson_c'].map((id) => ({ id }) as unknown as MissionCard)

  it('boards the first on a browser that has finished none', () => {
    expect(pickLesson(pool, () => false)).toBe('lesson_a')
  })

  it('boards the next one not finished, skipping a gap', () => {
    const done = new Set(['lesson_a', 'lesson_b'])
    expect(pickLesson(pool, (id) => done.has(id))).toBe('lesson_c')
    const onlyB = new Set(['lesson_b'])
    expect(pickLesson(pool, (id) => onlyB.has(id))).toBe('lesson_a')
  })

  it('starts again at the first once every lesson is finished', () => {
    expect(pickLesson(pool, () => true)).toBe('lesson_a')
  })

  it('gives nothing from an empty pool', () => {
    expect(pickLesson([], () => false)).toBeNull()
  })

  it('reads "finished" off the stored bests, in any variant', () => {
    const store = memory([bestKey('lesson_a', TEACHING, 'acrobat')])
    expect(pickLesson(pool, (id) => hasBestFor(id, store))).toBe('lesson_b')
  })
})

describe('a first visit is a browser with no best at all', () => {
  it('reads a store with a best as a return', () => {
    expect(hasAnyBest(memory([bestKey('int_01_hoverJet', 'ringAttack')]))).toBe(true)
    // The legacy key counts too: it is a finished run from before DEV-204.
    expect(hasAnyBest(memory([legacyBestKey('int_01_hoverJet')]))).toBe(true)
  })

  it('reads an empty store, one with only other keys, a null one and a throwing one as a first visit', () => {
    expect(hasAnyBest(memory())).toBe(false)
    // The variant choice and the settings are not a finished run.
    expect(hasAnyBest(memory(['ff2.variant.v1', 'ff2.settings.v1', 'ff2.lap.int_01']))).toBe(false)
    expect(hasAnyBest(null)).toBe(false)
    expect(hasAnyBest(hostile)).toBe(false)
  })

  it('ends with the first run that is recorded, through the normal path', () => {
    const store = memory()
    expect(hasAnyBest(store)).toBe(false)
    recordRun('lesson_a', TEACHING, { score: 2100, timeSeconds: 140, gates: 21 }, store)
    expect(hasAnyBest(store)).toBe(true)
    expect(hasBestFor('lesson_a', store)).toBe(true)
  })
})

describe('"finished" is per COURSE, whatever the mode or variant', () => {
  it('counts the moded key, a variant’s key and the legacy key', () => {
    expect(hasBestFor('lesson_a', memory([bestKey('lesson_a', TEACHING)]))).toBe(true)
    expect(hasBestFor('lesson_a', memory([bestKey('lesson_a', TEACHING, 'speed')]))).toBe(true)
    expect(hasBestFor('lesson_a', memory([legacyBestKey('lesson_a')]))).toBe(true)
  })

  it('does not read a LONGER id that shares the prefix as this one', () => {
    expect(hasBestFor('lesson_a', memory([bestKey('lesson_ab', TEACHING)]))).toBe(false)
    expect(hasBestFor('lesson_a', hostile)).toBe(false)
  })

  it('premise: no course id carries a dot, so the prefix cannot straddle two ids', () => {
    const ids = [...levelsIn('content/levels'), ...levelsIn('content/authored')].map((l) => l.id)
    expect(ids.length).toBeGreaterThan(13)
    expect(ids.filter((id) => id.includes('.'))).toEqual([])
  })
})

describe('the Flight School card carries its instructor’s colour (DEV-379)', () => {
  it('is the lesson file’s own colour on a lesson, and null on every other course', async () => {
    const cards = await loadMissionIndex()
    const disk = new Map(levelsIn('content/authored').map((l) => [l.id, l]))
    for (const card of cards) {
      const lesson = disk.get(card.id)?.lesson ?? null
      expect(card.instructorColour ?? null, card.id).toBe(lesson?.instructor.colour ?? null)
    }
    expect(lessonPool(cards).every((c) => /^#[0-9a-f]{6}$/i.test(c.instructorColour ?? ''))).toBe(
      true,
    )
  })
})
