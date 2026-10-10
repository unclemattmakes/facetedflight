// tests/unit/editor-light.test.ts — the editor core's half of a course's light.
// DEV-476. The format's half is `player-course-light.test.ts`.

import { describe, expect, it } from 'vitest'
import { canonicalPlayerCourse, type PlayerCourse, playerCourseId } from '@/content/player-course'
import {
  type PlayerCourseLight,
  SUN_ELEVATION_FLOOR,
  skyAgreementAt,
  sunAnglesOf,
} from '@/content/player-course-light'
import {
  createHistory,
  type DraftStorage,
  draftFromCourse,
  loadDraft,
  record,
  saveDraft,
  setLight,
  undo,
} from '@/editor/core'
import { LIGHT_TIPS, tintHex, tintOfHex } from '@/editor/desk/light-panel'
import fixture from './fixtures/player-course-v2-expansions.json'
import { validLevel as level } from './helpers/content'

const int01 = level('int_01_hoverJet')
const rookie01 = level('rookie_01_hoverJet')
const courseOn = (sky: string): PlayerCourse =>
  fixture.courses.find((c) => c.donor === sky)?.course as unknown as PlayerCourse

const memory = (): DraftStorage => {
  const map = new Map<string, string>()
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

const LIGHT: PlayerCourseLight = {
  sunAzimuth: 100,
  sunElevation: 20.04,
  tint: [1, 0.5, 0.25],
  tintAmount: 0.4,
}

describe('DEV-476 — setLight', () => {
  const draft = draftFromCourse(courseOn('int_01_hoverJet'))

  it('stores the light on its grid, and the id moves with it', () => {
    const lit = setLight(draft, LIGHT, int01)
    expect(lit.course.light).toEqual({ ...LIGHT, sunElevation: 20 })
    expect(playerCourseId(lit.course)).not.toBe(playerCourseId(draft.course))
  })

  it('is a no-op (the same object) for the light it already has', () => {
    const lit = setLight(draft, LIGHT, int01)
    expect(setLight(lit, { ...LIGHT, sunElevation: 20 }, int01)).toBe(lit)
    expect(setLight(lit, { ...LIGHT, sunAzimuth: Number.NaN }, int01)).toBe(lit)
  })

  it("null takes the block away: the course's bytes and id are the unlit ones again", () => {
    const lit = setLight(draft, LIGHT, int01)
    const back = setLight(lit, null, int01)
    expect('light' in back.course).toBe(false)
    expect(canonicalPlayerCourse(back.course)).toBe(canonicalPlayerCourse(draft.course))
    expect(setLight(draft, null, int01)).toBe(draft)
  })

  it('stores a sun the sky would refuse where the sky lets it stand, so the course says what flies', () => {
    const own = sunAnglesOf(int01.lighting.sun?.direction as number[])
    const lit = setLight(draft, { ...LIGHT, sunAzimuth: own.azimuth - 110, sunElevation: 4 }, int01)
    const l = lit.course.light as PlayerCourseLight
    expect(skyAgreementAt(int01, l.sunAzimuth, l.sunElevation) as number).toBeGreaterThanOrEqual(1)
    // A gradient sky moves nothing but the floor.
    const r = setLight(
      draftFromCourse(courseOn('rookie_01_hoverJet')),
      { ...LIGHT, sunAzimuth: -170.3, sunElevation: 0 },
      rookie01,
    )
    expect(r.course.light?.sunAzimuth).toBe(-170.3)
    expect(r.course.light?.sunElevation).toBe(SUN_ELEVATION_FLOOR)
  })

  it('is one undo step', () => {
    let h = createHistory(draft)
    h = record(h, setLight(h.present, LIGHT, int01))
    expect(h.present.course.light).toBeDefined()
    h = undo(h)
    expect(h.present.course.light).toBeUndefined()
  })
})

describe('DEV-476 — a draft keeps its light', () => {
  it('round-trips through storage', () => {
    const s = memory()
    const lit = setLight(draftFromCourse(courseOn('int_01_hoverJet')), LIGHT, int01)
    expect(saveDraft(s, 'lit', lit, 1)).toBe(true)
    expect(loadDraft(s, 'lit')).toEqual(lit)
  })

  it('reads a draft with no light as one with none', () => {
    const s = memory()
    const plain = draftFromCourse(courseOn('int_01_hoverJet'))
    saveDraft(s, 'plain', plain, 1)
    expect('light' in (loadDraft(s, 'plain')?.course ?? { light: 1 })).toBe(false)
  })

  it('drops a draft whose light is not one, as it drops any corrupt entry', () => {
    const s = memory()
    const lit = setLight(draftFromCourse(courseOn('int_01_hoverJet')), LIGHT, int01)
    saveDraft(s, 'bad', lit, 1)
    const key = 'ff2.editor.draft.v1.bad'
    const raw = JSON.parse(s.getItem(key) as string) as { course: { light: unknown } }
    raw.course.light = { ...LIGHT, tint: [1, 1] }
    s.setItem(key, JSON.stringify(raw))
    expect(loadDraft(s, 'bad')).toBeNull()
  })
})

describe('DEV-476 — the LIGHT group', () => {
  it('gives every control a one-line tooltip that says something', () => {
    for (const [name, tip] of Object.entries(LIGHT_TIPS)) {
      expect(tip.trim().length, name).toBeGreaterThan(10)
      expect(tip, name).not.toMatch(/\n/)
      expect(tip.length, name).toBeLessThanOrEqual(120)
    }
  })

  it("round-trips the colour picker's hex through the course's tint grid", () => {
    for (let i = 0; i < 256; i += 5) {
      const hex = tintHex([i / 255, (255 - i) / 255, 1])
      const back = setLight(
        draftFromCourse(courseOn('int_01_hoverJet')),
        { ...LIGHT, tint: tintOfHex(hex) },
        int01,
      ).course.light?.tint as readonly number[]
      expect(tintHex(back)).toBe(hex)
    }
  })
})
