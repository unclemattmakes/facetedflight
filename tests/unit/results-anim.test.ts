// tests/unit/results-anim.test.ts: the results panel's timeline. DEV-650.
//
// The painter (`render/results.ts`) holds no timing: it asks `resultsFrame` for
// the instant. So the order of the beats, that the stamp fires once and is the
// only beat the medal's cue hangs on, that NEW BEST is only there for a run
// that set one, and that reduced motion is the end state at once, are all
// readable here without a canvas.

import { describe, expect, it } from 'vitest'
import {
  RESULTS_SETTLED,
  resultsFrame,
  stampScaleAt,
  RESULTS_TIMES as T,
} from '@/render/results-anim'

const at = (t: number, improved = false, reduced = false) => resultsFrame(t, { improved, reduced })

describe('the beats come in order', () => {
  it('the plate comes in first, and is fully in by 0.3 s', () => {
    expect(at(0).enter).toBe(0)
    expect(at(T.enter / 2).enter).toBeGreaterThan(0)
    expect(at(T.enter / 2).enter).toBeLessThan(1)
    expect(at(T.enter).enter).toBe(1)
  })

  it('the numbers climb after it starts and land before the stamp', () => {
    expect(at(0.1).count).toBe(0)
    const mid = at((T.countStart + T.countEnd) / 2).count
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)
    expect(at(T.countEnd).count).toBe(1)
    expect(T.countEnd).toBeLessThanOrEqual(T.stamp)
  })

  it('the count never goes backwards', () => {
    let last = -1
    for (let t = 0; t <= 2; t += 0.02) {
      const c = at(t).count
      expect(c).toBeGreaterThanOrEqual(last)
      last = c
    }
  })

  it('the medal stamps once, big first, settling to 1 and never past it by much', () => {
    expect(at(T.stamp - 0.01).stamped).toBe(false)
    expect(at(T.stamp).stamped).toBe(true)
    expect(at(T.stamp).stampScale).toBeGreaterThan(1.5)
    expect(at(T.stamp + T.stampLength).stampScale).toBe(1)
    expect(at(T.stamp + T.stampLength + 5).stampScale).toBe(1)
    for (let p = 0; p <= 1; p += 0.05) {
      expect(stampScaleAt(p)).toBeLessThanOrEqual(1.8)
      expect(stampScaleAt(p)).toBeGreaterThan(0.9)
    }
  })

  it('the line under the best fades in after the stamp has landed', () => {
    expect(at(T.stamp).next).toBe(0)
    expect(at(T.nextIn + T.nextLength).next).toBe(1)
    expect(T.nextIn).toBeGreaterThanOrEqual(T.stamp)
  })
})

describe('NEW BEST', () => {
  it('is not there for a run that set no best', () => {
    for (const t of [0, 1.6, 2.4, 9]) expect(at(t, false).best).toBe('settled')
  })

  it('is hidden until its beat, flashes between two inks, and settles', () => {
    expect(at(T.flashStart - 0.01, true).best).toBe('hidden')
    const seen = new Set<string>()
    for (let t = T.flashStart; t < T.flashEnd; t += 0.02) seen.add(at(t, true).best)
    expect(seen.has('on')).toBe(true)
    expect(seen.has('off')).toBe(true)
    expect(at(T.flashEnd, true).best).toBe('settled')
    expect(at(T.flashEnd + 10, true).best).toBe('settled')
  })

  it('starts on the lit ink, so the first thing seen is the win', () => {
    expect(at(T.flashStart, true).best).toBe('on')
  })
})

describe('done', () => {
  it('is false while a beat is moving and true after the last', () => {
    expect(at(0.5).done).toBe(false)
    expect(at(T.nextIn + T.nextLength).done).toBe(true)
    // A run with a NEW BEST is done only after its flash.
    expect(at(T.nextIn + T.nextLength, true).done).toBe(false)
    expect(at(T.flashEnd, true).done).toBe(true)
  })

  it('is within 3.2 s whatever the run: nobody waits on the panel to retry', () => {
    expect(at(3.2, true).done).toBe(true)
  })
})

describe('reduced motion', () => {
  it('is the end state at the first instant, for every kind of run', () => {
    for (const improved of [false, true]) {
      expect(at(0, improved, true)).toEqual(RESULTS_SETTLED)
    }
    expect(RESULTS_SETTLED.enter).toBe(1)
    expect(RESULTS_SETTLED.count).toBe(1)
    expect(RESULTS_SETTLED.stamped).toBe(true)
    expect(RESULTS_SETTLED.done).toBe(true)
  })
})
