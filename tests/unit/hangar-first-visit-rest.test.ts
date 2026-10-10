// tests/unit/hangar-first-visit-rest.test.ts: DEV-884's room halves.
//
//  * A first visit rests on the FIRST table of the flight-plan and difficulty
//    steps (Flight School, Beginner), a returning player where they always did.
//    The oracle for "first" is the arc's own bearings (`stepBearings`) and the
//    resting look the seat starts a step on (`stepStartYaw`), which must turn the
//    eye from the resting pointer onto exactly that bearing.
//  * The place step's legend lists the marks the page holds, easiest first, one
//    a rank, in the ski map's shapes.

import { describe, expect, it } from 'vitest'
import {
  FIRST_VISIT_REST_STEPS,
  firstVisitRestBearing,
  markLegend,
  SEAT_REST_BEARING,
  stepBearings,
  stepStartYaw,
} from '@/render/hangar'

describe('a first visit rests on the first table (DEV-884)', () => {
  it('names the flight-plan and difficulty steps, and only them', () => {
    expect([...FIRST_VISIT_REST_STEPS].sort()).toEqual(['modes', 'ranks'])
  })

  it('a three-plan step: the first table is 30 degrees left of rest, and the seat turns onto it', () => {
    const bearings = stepBearings('modes', 3)
    const first = firstVisitRestBearing('modes', true, bearings, ['school', 'ring', 'free'])
    expect(first).toBe(bearings[0])
    // The eye looks along SEAT_REST_BEARING + yaw turned left, and a bearing left of rest is smaller.
    const yaw = stepStartYaw('modes', first)
    expect(SEAT_REST_BEARING - yaw).toBeCloseTo(bearings[0] as number, 12)
    expect(yaw).toBeGreaterThan(0)
  })

  it('a returning player rests where they always did', () => {
    const bearings = stepBearings('modes', 3)
    expect(firstVisitRestBearing('modes', false, bearings, ['a', 'b', 'c'])).toBeNull()
    expect(stepStartYaw('modes', null)).toBe(0)
    expect(stepStartYaw('ranks', null)).toBe(0)
  })

  it('other steps are not moved, first visit or not', () => {
    for (const view of ['vehicles', 'courses', 'doors', 'variants'] as const) {
      const bearings = stepBearings(view, 3)
      expect(firstVisitRestBearing(view, true, bearings, ['a', 'b', 'c']), view).toBeNull()
      // And a bearing handed to the start yaw of a step that does not take one is ignored.
      expect(stepStartYaw(view, bearings[0] as number), view).toBe(stepStartYaw(view))
    }
  })

  it('skips an empty first position: the first OCCUPIED table', () => {
    const bearings = stepBearings('ranks', 3)
    expect(firstVisitRestBearing('ranks', true, bearings, [null, 'x', 'y'])).toBe(bearings[1])
    expect(firstVisitRestBearing('ranks', true, bearings, [null, null, null])).toBeNull()
  })

  it('keeps the credits and options steps starting where they are laid', () => {
    expect(stepStartYaw('credits')).toBeGreaterThan(0)
    expect(stepStartYaw('options')).toBe(stepStartYaw('credits'))
    // A first-visit bearing does not reach them.
    expect(stepStartYaw('credits', 0.3)).toBe(stepStartYaw('credits'))
  })
})

describe('the place step legend (DEV-884)', () => {
  it('lists each rank once, easiest first, in the ski map shapes', () => {
    const legend = markLegend([
      { index: 2, name: 'Professional' },
      { index: 0, name: 'Beginner' },
      { index: 1, name: 'Intermediate' },
      { index: 0, name: 'Beginner' },
      { index: 2, name: 'Professional' },
    ])
    expect(legend.map((e) => `${e.shape}:${e.name}`)).toEqual([
      'square:Beginner',
      'circle:Intermediate',
      'diamond:Professional',
    ])
  })

  it('is empty for a page with no marks, and shows two when the page holds two', () => {
    expect(markLegend([])).toEqual([])
    expect(
      markLegend([
        { index: 0, name: 'A' },
        { index: 1, name: 'B' },
      ]),
    ).toHaveLength(2)
  })
})
