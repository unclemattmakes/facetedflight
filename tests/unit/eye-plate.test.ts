// tests/unit/eye-plate.test.ts: the eye-anchored pose sums (UI-11).
//
// The geometry, not the formula: a plate whose top edge is `topDeg` below the
// eye subtends exactly `topDeg` there, so `angleDeg` undoes `topEdgeY`. A test
// that restated `-tan(deg) * distance` would be the implementation twice
// (trap 24). `title-menu.test.ts`, `title-placement.test.ts` and
// `room-code.test.ts` hold the extents the three callers derive from these.

import { describe, expect, it } from 'vitest'
import { angleDeg, topEdgeY } from '@/render/eye-plate'

describe('eye-plate', () => {
  it('the top edge lands where it says, measured back from the eye', () => {
    for (const distance of [0.86, 1.05, 2.0, 5]) {
      for (const topDeg of [3, 12.5, 30]) {
        expect(angleDeg(topEdgeY(topDeg, distance), distance)).toBeCloseTo(-topDeg, 10)
      }
    }
  })

  it('below the eye is negative, level is zero, and the angle is signed', () => {
    expect(topEdgeY(0, 2)).toBeCloseTo(0, 12)
    expect(topEdgeY(12.5, 2)).toBeLessThan(0)
    expect(angleDeg(1, 1)).toBeCloseTo(45, 10)
    expect(angleDeg(-1, 1)).toBeCloseTo(-45, 10)
  })
})
