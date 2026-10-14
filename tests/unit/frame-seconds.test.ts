// tests/unit/frame-seconds.test.ts: the frame delta never steps backwards or goes NaN.

import { describe, expect, it } from 'vitest'
import { frameSecondsBetween } from '@/boot/app/frame-seconds'

const FIRST = 0.0121999998

describe('frameSecondsBetween', () => {
  it('hands the first frame the fixed step', () => {
    expect(frameSecondsBetween(5000, 0, FIRST)).toBe(FIRST)
  })

  it('is the wall-clock delta in seconds', () => {
    expect(frameSecondsBetween(1011.1, 1000, FIRST)).toBeCloseTo(0.0111, 6)
  })

  // The worn session of 2026-10-13: the clock stepped back, a holotable's
  // diorama clock went negative and `line[-1]` threw inside the frame.
  it('never goes backwards when the clock does', () => {
    expect(frameSecondsBetween(900, 1000, FIRST)).toBe(0)
  })

  it('is never NaN', () => {
    expect(frameSecondsBetween(Number.NaN, 1000, FIRST)).toBe(0)
    expect(frameSecondsBetween(Number.POSITIVE_INFINITY, 1000, FIRST)).toBe(0)
  })
})
