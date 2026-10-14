import { describe, expect, it } from 'vitest'
import { FIXED_DT } from '@/sim/constants'
import { createClock, stepFixed, XR_MAX_CATCHUP_TICKS } from '@/sim/integrator'

// DEV-943: a hitched frame replays at most the cap, and the default is the old
// 0.25 s (about 20 ticks) so everything that does not pass a cap is unchanged.
describe('the integrator catch-up cap', () => {
  const ticksFor = (frameSeconds: number, cap?: number) => {
    const clock = createClock()
    let n = 0
    stepFixed(
      clock,
      frameSeconds,
      () => {
        n += 1
      },
      FIXED_DT,
      cap,
    )
    return n
  }

  it('keeps the old 0.25 s cap by default', () => {
    expect(ticksFor(5)).toBe(Math.floor(0.25 / FIXED_DT))
  })

  it('runs at most the XR cap in ticks after a long hitch', () => {
    expect(ticksFor(5, XR_MAX_CATCHUP_TICKS * FIXED_DT)).toBe(XR_MAX_CATCHUP_TICKS)
  })

  it('does not touch a normal frame', () => {
    expect(ticksFor(FIXED_DT * 1.5, XR_MAX_CATCHUP_TICKS * FIXED_DT)).toBe(1)
  })
})
