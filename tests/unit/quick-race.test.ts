// tests/unit/quick-race.test.ts — which course a Quick Race boards. DEV-353.
//
// Matt: *"a random HoverJet Ring Attack course, and skip the ride."* The pool
// is read off the content (hard rule 6), so what is pinned is the RULE — every
// course that is a HoverJet flown in Ring Attack, and nothing else — checked
// against the level files read straight off the disk rather than through the
// loader the pool itself goes through. The draw is pinned by walking an
// injected source across its whole range.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import { loadMissionIndex, type MissionCard } from '@/game/mission-index'
import { rulesFor, runningMode } from '@/game/modes'
import { pickQuickRace, QUICK_RACE, quickRacePool } from '@/game/quick-race'
import { REPO as ROOT } from './helpers/repo-root'

const LEVELS = path.join(ROOT, 'content/levels')

/** Every shipped level, off the disk — not through `import.meta.glob`. */
const levelsOnDisk = (): Level[] =>
  fs
    .readdirSync(LEVELS)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(LEVELS, f), 'utf8')) as Level)

describe('the pool is the content, filtered by the promise', () => {
  it('is every HoverJet course that RUNS as Ring Attack, and nothing else', async () => {
    const pool = quickRacePool(await loadMissionIndex())
    const expected = levelsOnDisk()
      .filter((l) => l.vehicle === 'hoverjet' && runningMode(l) === 'ringAttack')
      .map((l) => l.id)
      .sort()
    expect(expected.length, 'the content has courses to race').toBeGreaterThan(0)
    expect(pool.map((c) => c.id).sort()).toEqual(expected)
  })

  it('holds the public release mission, and not the course 2016 forces to Free Flight', async () => {
    const ids = quickRacePool(await loadMissionIndex()).map((c) => c.id)
    // CLAUDE.md: the first public release IS this mission.
    expect(ids).toContain('int_01_hoverJet')
    // Authored on the same course as int_01 and forced to Free Flight: a
    // Quick Race must never land you in a mode the button did not name.
    expect(ids).not.toContain('hoverJet_kauai_beg')
  })

  it('races every course it can pick, because Ring Attack puts the racers on the grid', async () => {
    for (const card of quickRacePool(await loadMissionIndex())) {
      expect(card.vehicle).toBe(QUICK_RACE.vehicle)
      expect(rulesFor(card.mode).opponents, `${card.id} has opponents`).toBe(true)
    }
  })

  it('picks up a course it has never heard of, by its fields alone', () => {
    // Rule 6: a seventh HoverJet Ring Attack course needs no change to `src/`.
    const invented = {
      id: 'zz_new_course',
      vehicle: 'hoverjet',
      mode: 'ringAttack',
    } as unknown as MissionCard
    const jumpSeat = {
      id: 'zz_pads',
      vehicle: 'jumpseat',
      mode: 'ringAttack',
    } as unknown as MissionCard
    expect(quickRacePool([invented, jumpSeat]).map((c) => c.id)).toEqual(['zz_new_course'])
  })
})

describe('the draw', () => {
  const pool = ['a', 'b', 'c', 'd'].map((id) => ({ id }) as unknown as MissionCard)

  it('can land on every course, across the whole range of the source', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 400; i++) {
      const id = pickQuickRace(pool, () => i / 400)
      if (id !== null) seen.add(id)
    }
    expect([...seen].sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('names a real course at both ends of the range, and past them', () => {
    expect(pickQuickRace(pool, () => 0)).toBe('a')
    expect(pickQuickRace(pool, () => 0.999999)).toBe('d')
    expect(pickQuickRace(pool, () => 1)).toBe('d')
    expect(pickQuickRace(pool, () => -0.5)).toBe('a')
  })

  it('gives nothing from an empty pool, rather than a course that is not there', () => {
    expect(pickQuickRace([], () => 0.5)).toBeNull()
  })
})
