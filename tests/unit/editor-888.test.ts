// DEV-888: water on a seeded island. (a) Lift clear lifts an anchored first
// point (the pad's) clear of a flood, through the anchor's height; (b) a
// seeded island's water reads 140 m in the editor's own frame, not 156.
import { describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import { PLAYER_COURSE_WATER, seededWaterLevel } from '@/content/player-course'
import {
  anchorToPad,
  draftFromCourse,
  evaluateDraft,
  type Ground,
  groundShortfalls,
  liftClear,
} from '@/editor/core'
import { waterWorldY } from '@/game/terrain/course-water'
import { fittedCourse, shippedLevels } from './helpers/editor-course'

const int01 = shippedLevels().find((l) => l.id === 'int_01_hoverJet') as Level

describe('DEV-888 (a): Lift clear lifts an anchored first point out of the water', () => {
  const anchoredDraft = anchorToPad(draftFromCourse(fittedCourse(int01)), 8)
  const first = anchoredDraft.course.path.points[0] as [number, number, number]
  const sea = first[1] + 30
  const flood: Ground = { surfaceAt: () => sea, waterAt: () => true }
  const land: Ground = { surfaceAt: () => sea }

  it('premise: the flood buries the anchored point', () => {
    expect(groundShortfalls(anchoredDraft.course, int01, flood).length).toBeGreaterThan(0)
  })

  it('over water the anchor height rises and the line clears, in one new draft', () => {
    const out = liftClear(anchoredDraft, int01, flood)
    expect(out).not.toBe(anchoredDraft)
    expect(groundShortfalls(out.course, int01, flood)).toEqual([])
    // (The pad itself, sunk 30 m, stays the pad warning's: move the pad.)
    const kinds = new Set(['ring-in-ground', 'line-under-ground', 'line-near-ground'])
    const trouble = (d: typeof out) =>
      evaluateDraft(d, int01, flood).warnings.filter((w) => kinds.has(w.kind) && !w.runIn)
    expect(trouble(anchoredDraft).length).toBeGreaterThan(0)
    expect(trouble(out)).toEqual([])
    const a = out.course.path.anchor
    expect(a?.h).toBeGreaterThan(8)
    // The first point is the pad's, plus h: still consistent.
    expect((out.course.path.points[0] as number[])[1]).toBeCloseTo(
      (out.course.start.pos[1] as number) + (a?.h as number),
      3,
    )
  })

  it('over land the anchored point stays the pad’s (DEV-501 is unchanged)', () => {
    const out = liftClear(anchoredDraft, int01, land)
    expect(out.course.path.anchor?.h).toBe(8)
    expect((out.course.path.points[0] as number[])[1]).toBe(first[1])
  })
})

describe('DEV-888 (b): a seeded island’s water reads 140 m', () => {
  it('floor plus the level is the default, not the default plus the floor', () => {
    const floor = waterWorldY(int01, { level: 0 })
    const level = seededWaterLevel('simonet', null, floor)
    expect(floor + level).toBe(PLAYER_COURSE_WATER.seededDefaultLevelMetres)
  })

  it('never goes under 0', () => {
    expect(seededWaterLevel('simonet', null, 500)).toBe(0)
  })
})
