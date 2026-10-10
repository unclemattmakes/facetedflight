// tests/unit/course-water.test.ts — DEV-500: a water level per course.
//
// The water is the base's own sea plate moved to a level (or borrowed where a
// base has none): a crash surface, as the shipped sea is. Held here: no shipped
// mission changes; the block is optional and absent keeps a course's bytes; the
// level round-trips and is bounded by the island; the plate lands where the
// level says, against a reading taken from another end; and the editor's ground
// rule buries a ring under the water.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { type Level, liveRings, validateLevel } from '@/content/level-schema'
import { loadPlayerCourse } from '@/content/load-player-course'
import {
  canonicalPlayerCourse,
  expandPlayerCourse,
  islandSeaLevel,
  islandWaterline,
  PLAYER_COURSE_WATER,
  type PlayerCourse,
  playerCourseId,
  seaInLandFrame,
  validatePlayerCourse,
  waterCeiling,
} from '@/content/player-course'
import { draftFromCourse, evaluateDraft } from '@/editor/core'
import { landAndSea } from '@/editor/desk/ground'
import {
  borrowedSeaIsland,
  courseWaterOf,
  oceanFor,
  waterWorldY,
  withCourseWater,
} from '@/game/terrain/course-water'
import { environmentTerrains } from '@/game/terrain/load-terrain'
import { fittedCourse } from './helpers/editor-course'

const DIR = path.resolve(__dirname, '..', '..', 'content', 'levels')
const shipped: Level[] = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .sort()
  .map((f) => validateLevel(JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) as Level))
const byId = (id: string): Level => shipped.find((l) => l.id === id) as Level
const int01 = byId('int_01_hoverJet')
const canyon = byId('adv_01_hoverJet')

describe('DEV-500 — no shipped mission changes', () => {
  it('every shipped level draws its own sea at lift 0, and desert and alpine draw none', () => {
    expect(shipped.length).toBeGreaterThanOrEqual(13)
    for (const level of shipped) {
      expect(courseWaterOf(level), level.id).toBeNull()
      const own = environmentTerrains(level.environment).ocean
      expect(oceanFor(level), level.id).toEqual(own === null ? null : { key: own, lift: 0 })
      if (level.environment === 'desert' || level.environment === 'alpine') {
        expect(oceanFor(level), `${level.id} draws no water`).toBeNull()
      }
    }
  })
})

describe('DEV-500 — the format: `water: { level }`, optional', () => {
  const course = fittedCourse(int01)
  const sea = islandWaterline('simonet')

  it('pins its policy', () => {
    expect(PLAYER_COURSE_WATER).toEqual({
      levelQuantumMetres: 1,
      defaultDepthMetres: 20,
      firstLevelSamples: 16,
      seededDefaultLevelMetres: 140, // DEV-877
    })
  })

  it('absent: no key in the canonical bytes, the same id, and a byte-identical expansion', async () => {
    expect(Object.keys(JSON.parse(canonicalPlayerCourse(course)) as object)).not.toContain('water')
    const wet: PlayerCourse = { ...course, water: { level: 250 } }
    // The water never enters the level's JSON: it rides beside it for the world
    // build. The expansions differ only in what the id names.
    const bare = (l: Level): string => JSON.stringify({ ...l, id: '', generated: null })
    expect(bare(expandPlayerCourse(wet, int01))).toBe(bare(expandPlayerCourse(course, int01)))
    expect(courseWaterOf(await loadPlayerCourse(course))).toBeNull()
    expect(courseWaterOf(await loadPlayerCourse(wet))).toEqual({ level: 250 })
    expect(playerCourseId(wet)).not.toBe(playerCourseId(course))
  })

  it('the level round-trips on its grid, and is bounded by the island', () => {
    const wet: PlayerCourse = { ...course, water: { level: 250.4 } }
    const canonical = JSON.parse(canonicalPlayerCourse(wet)) as Record<string, unknown>
    expect(canonical.water).toEqual({ level: 250 })
    const back = validatePlayerCourse(canonical)
    expect(back.ok && back.course.water).toEqual({ level: 250 })
    expect(back.ok && playerCourseId(back.course)).toBe(playerCourseId(wet))
    const top = waterCeiling('simonet', null) as number
    for (const level of [-1, top + 1, Number.NaN]) {
      const bad = validatePlayerCourse({ ...canonical, water: { level } })
      expect(bad.ok ? [] : bad.errors.map(([p]) => p), String(level)).toContain('water.level')
    }
    const extra = validatePlayerCourse({ ...canonical, water: { level: 10, colour: 1 } })
    expect((extra.ok ? [] : extra.errors).some(([p]) => /^water\.\W?colour/.test(p))).toBe(true)
    expect(islandSeaLevel('simonet')).toBe(sea)
    expect(islandSeaLevel('desert')).toBeNull()
  })
})

describe('DEV-500 — the plate lands at the level', () => {
  it("at Simonet's own sea it does not move, and stands where the viewpoints read the sea", () => {
    const wet = withCourseWater(int01, { level: islandWaterline('simonet') })
    expect(oceanFor(wet)).toEqual({ key: 'simonet.ocean', lift: 0 })
    // `boot/viewpoints.ts`'s spot reading of the sea surface, from the other end.
    expect(waterWorldY(int01, { level: islandWaterline('simonet') })).toBeCloseTo(116.6, 6)
    // 50 m up is 50 m of lift.
    expect(
      oceanFor(withCourseWater(int01, { level: islandWaterline('simonet') + 50 }))?.lift,
    ).toBeCloseTo(50, 9)
  })

  it('a base with no sea borrows one, lifted so its surface stands at the level', () => {
    const island = borrowedSeaIsland()
    expect(environmentTerrains(island).ocean).toBe(`${island}.ocean`)
    const level = 300
    const sea = oceanFor(withCourseWater(canyon, { level }))
    expect(sea?.key).toBe(`${island}.ocean`)
    // Unlifted, the borrowed plate stands where it stands over its own island;
    // the lift closes exactly the gap to the level, in the canyon's frame.
    expect((sea?.lift ?? Number.NaN) + seaInLandFrame(island, 'desert')).toBeCloseTo(level, 9)
    // And the world height the editor stands it at is the land floor plus the level.
    expect(waterWorldY(canyon, { level }) - waterWorldY(canyon, { level: 0 })).toBeCloseTo(level, 9)
  })
})

describe('DEV-500 — the editor treats the water as the game does: a crash surface', () => {
  const course = fittedCourse(int01)
  const rings = liveRings(expandPlayerCourse(course, int01)).map((r) => r.pos[1] as number)
  const land = (): number => -1e5

  it('a water over the rings buries them and the line; under them, nothing', () => {
    const over = evaluateDraft(
      draftFromCourse(course),
      int01,
      landAndSea(land, () => Math.max(...rings) + 1),
    )
    expect(over.warnings.filter((w) => w.kind === 'ring-in-ground').length).toBeGreaterThan(0)
    // A ring in the ground is an error; the line under it the warning it always is.
    expect(over.warnings.some((w) => w.kind === 'ring-in-ground' && w.severity === 'error')).toBe(
      true,
    )
    expect(over.warnings.some((w) => w.kind === 'line-under-ground')).toBe(true)
    // The pad is under it too: buried or on the water, an error either way.
    expect(over.warnings.some((w) => w.kind.startsWith('pad-') && w.severity === 'error')).toBe(
      true,
    )
    const under = evaluateDraft(
      draftFromCourse(course),
      int01,
      landAndSea(land, () => Math.min(...rings) - 400),
    )
    expect(under.warnings.filter((w) => w.kind === 'ring-in-ground')).toEqual([])
    expect(under.warnings.some((w) => w.kind === 'line-under-ground')).toBe(false)
  })
})
