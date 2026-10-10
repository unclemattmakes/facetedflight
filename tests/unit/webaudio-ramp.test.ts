// tests/unit/webaudio-ramp.test.ts: the gain ramp `webaudio.ts` writes four ways. IU-1.
//
// Four sites (a crossfade's fallback, `fadeOut`, an emitter's `setGain`,
// `setCueGain`) each wrote the same three AudioParam calls inline. They are one
// helper now, and nothing in node can hear it, so this pins what it SCHEDULES:
// which calls, in which order, with which numbers. A fake `AudioParam` records
// them; the literal lists below are the three lines the old sites wrote.

import { describe, expect, it } from 'vitest'
import { rampFromCurrent } from '@/audio/webaudio'

/** The floor `webaudio.ts` keeps every gain above (`SILENT`). */
const SILENT = 0.0001

type Call = readonly [string, ...number[]]

const fakeParam = (value: number) => {
  const calls: Call[] = []
  const param = {
    get value() {
      // Read AFTER the cancel, as the old sites did: record the read so an
      // order change shows up.
      calls.push(['read'])
      return value
    },
    cancelScheduledValues: (t: number) => calls.push(['cancel', t]),
    setValueAtTime: (v: number, t: number) => calls.push(['set', v, t]),
    linearRampToValueAtTime: (v: number, t: number) => calls.push(['ramp', v, t]),
  }
  return { param: param as unknown as AudioParam, calls }
}

describe('IU-1: rampFromCurrent schedules cancel, pin, ramp, in that order', () => {
  it('holds the current value and ramps linearly to the target', () => {
    const { param, calls } = fakeParam(0.5)
    rampFromCurrent(param, 0.8, 10, 0.25)
    expect(calls).toEqual([['cancel', 10], ['read'], ['set', 0.5, 10], ['ramp', 0.8, 10.25]])
  })

  it('never pins or ramps through zero: both ends are floored at SILENT', () => {
    const { param, calls } = fakeParam(0)
    rampFromCurrent(param, 0, 3, 1)
    expect(calls).toEqual([['cancel', 3], ['read'], ['set', SILENT, 3], ['ramp', SILENT, 4]])
  })

  it('a fade-out to SILENT lands on SILENT exactly, over the duration given', () => {
    const { param, calls } = fakeParam(0.3)
    rampFromCurrent(param, SILENT, 7, 0.01)
    expect(calls.at(-1)).toEqual(['ramp', SILENT, 7.01])
  })

  it('does not floor the duration: the caller owns it (setGain and fadeOut floor at 0.01 themselves)', () => {
    const { param, calls } = fakeParam(1)
    rampFromCurrent(param, 0.5, 2, 0)
    expect(calls.at(-1)).toEqual(['ramp', 0.5, 2])
  })
})
