/**
 * The level schema, checked against the REAL extracted levels in
 * `content/levels/` rather than a fixture invented here. A schema that only
 * ever validates its own fixture is a schema that has never been tested.
 *
 * Two non-negotiables (DECISIONS D19):
 *   1. `boundary.enabled` and `boundary.resetDelay` are REQUIRED, with no
 *      global fallback — a missing block is a loud error, not a silent
 *      10-second death timer.
 *   2. rings are counted by liveness, and medal thresholds are checked against
 *      that count.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type Level,
  LevelSchemaError,
  liveRings,
  maxRingScore,
  platinumIsReachable,
  validateLevel,
} from '@/content/level-schema'
import { REPO as ROOT } from './helpers/repo-root'

const LEVELS_DIR = path.join(ROOT, 'content', 'levels')

const levelFiles = (): string[] =>
  fs.existsSync(LEVELS_DIR)
    ? fs
        .readdirSync(LEVELS_DIR)
        .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
        .sort()
    : []

const read = (file: string): Level =>
  JSON.parse(fs.readFileSync(path.join(LEVELS_DIR, file), 'utf8')) as Level

describe('extracted levels', () => {
  const files = levelFiles()

  it('finds the 13 shipped missions', () => {
    expect(files.length).toBe(13)
  })

  for (const file of files) {
    it(`${file} validates, and carries an explicit boundary block`, () => {
      const level = read(file)
      expect(() => validateLevel(level)).not.toThrow()
      // No global fallback exists, so both fields must be present in the file
      // itself — including in the 6 of 13 missions where the boundary is off.
      expect(typeof level.boundary.enabled).toBe('boolean')
      expect(typeof level.boundary.resetDelay).toBe('number')
      // The C# initialiser says 10. Every shipped scene says 13.
      expect(level.boundary.resetDelay).toBe(13)
    })
  }
})

describe('liveness and medals, on the real data', () => {
  it('int_01_hoverJet: 21 live rings, platinum 2100, exactly attainable', () => {
    const level = read('int_01_hoverJet.json')
    expect(liveRings(level)).toHaveLength(21)
    expect(level.medals.platinum).toBe(2100)
    expect(maxRingScore(level)).toBe(2100)
    expect(platinumIsReachable(level)).toBe(true)
  })

  it('rookie_01_hoverJet: 16 live rings against platinum 1700 — UNREACHABLE', () => {
    // The 2016 arithmetic bug. FF2 fixes this one; the fix belongs in the level
    // JSON with a row in docs/DEVIATIONS.md, never in src/.
    const level = read('rookie_01_hoverJet.json')
    expect(liveRings(level)).toHaveLength(16)
    expect(maxRingScore(level)).toBe(1600)
    expect(level.medals.platinum).toBe(1700)
    expect(platinumIsReachable(level)).toBe(false)
  })

  it('hoverJet_kauai_beg is int_01 authored twice, and is forced to Free Flight', () => {
    const int01 = read('int_01_hoverJet.json')
    const kauai = read('hoverJet_kauai_beg.json')
    expect(liveRings(kauai)).toHaveLength(liveRings(int01).length)
    expect(kauai.medals).toEqual(int01.medals)
    expect(kauai.timer.timeLimit).toBe(int01.timer.timeLimit)
    expect(kauai.forcedMode).toBe('freeFlight')
  })

  it('adv_01_hoverJet is ONE 22-ring course, not the two the scene holds (DEV-210)', () => {
    // This test used to assert the opposite — "two alternate 22-ring routes, 44 rings in
    // total" — and it passed, because that is genuinely what was in the JSON. It was a
    // faithful description of the extractor's output and a wrong description of the game:
    // there is no alternate-route mechanic (`triggerNextRoute` is false on all 44 rings),
    // and `game/rings.ts` only ever drew the first 22. Writing the count down here made the
    // divergence look like a decision.
    //
    // `adv_01_hoverJet.unity` really does hold two LIVE ring groups — the liveness walk is
    // right about both — but only `CurvyClonePath` is the course. The extractor now picks
    // it by the Curvy spline the ring clones were built along. 2016's own hand-authored
    // platinum is the check that settles it: 2200 at `gateMultiplier` 100 is 22 gates.
    const level = read('adv_01_hoverJet.json')
    expect(level.routes).toHaveLength(1)
    expect(level.routes[0]?.id).toBe('CurvyClonePath')
    expect(liveRings(level)).toHaveLength(22)
    expect(maxRingScore(level)).toBe(2200)
    expect(platinumIsReachable(level)).toBe(true)
  })
})

describe('validateLevel rejects what it must', () => {
  const good = (): Level => read('int_01_hoverJet.json')

  it('rejects a level with no boundary block rather than defaulting it', () => {
    const bad = good() as unknown as { boundary?: unknown }
    delete bad.boundary
    expect(() => validateLevel(bad as Level)).toThrow(LevelSchemaError)
  })

  it('rejects a boundary with no resetDelay — the C# default 10 is NOT shipped behaviour', () => {
    const bad = good()
    delete (bad.boundary as { resetDelay?: number }).resetDelay
    expect(() => validateLevel(bad)).toThrow(/resetDelay/)
  })

  it('rejects a level with no scoring.gateMultiplier — a ring scores addScore × it', () => {
    const bad = good()
    delete (bad.scoring as { gateMultiplier?: number }).gateMultiplier
    expect(() => validateLevel(bad)).toThrow(/gateMultiplier/)
  })
})
