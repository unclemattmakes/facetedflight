// tests/unit/update-rates.test.ts: the scheduler for presentation work that does
// not need to run every frame. DEV-976.
//
// The rules it lives under are in the header of `src/boot/app/update-rates.ts`:
// time is accumulated and not dropped, a cadence keeps its phase, and a
// staggered job puts one slot on each frame and never all of them on one.

import { describe, expect, it } from 'vitest'
import { createUpdateRates } from '@/boot/app/update-rates'

const HZ_72 = 1 / 72

/** Drive an Hz gate for `frames` frames of `dt`; returns the frames it ran on and what it was handed. */
const drive = (hz: number, frames: number, dt: number) => {
  const rates = createUpdateRates()
  const gate = rates.hz('job', hz)
  const ranOn: number[] = []
  const handed: number[] = []
  for (let f = 0; f < frames; f++) {
    const s = gate(dt)
    if (s !== null) {
      ranOn.push(f)
      handed.push(s)
    }
  }
  return { ranOn, handed, rates }
}

describe('hz gates', () => {
  it('runs on the first call, then at the declared rate, keeping its phase', () => {
    const { ranOn } = drive(20, 15, HZ_72)
    expect(ranOn).toEqual([0, 3, 7, 10, 14])
  })

  it('averages the declared rate over a long run, never twice in a frame', () => {
    const { ranOn } = drive(20, 720, HZ_72)
    // 10 s of frames at 20 Hz is 200 runs; the first call is the +1.
    expect(Math.abs(ranOn.length - 200)).toBeLessThanOrEqual(1)
    expect(new Set(ranOn).size).toBe(ranOn.length)
  })

  it('hands every second of frame time to a run: nothing is dropped', () => {
    const frames = 360
    const { handed } = drive(10, frames, HZ_72)
    const total = handed.reduce((a, b) => a + b, 0)
    // What is handed over plus what is still owed (under one period) is all of it.
    const elapsed = frames * HZ_72
    expect(total).toBeLessThanOrEqual(elapsed + 1e-9)
    expect(elapsed - total).toBeLessThan(0.1 + HZ_72 + 1e-9)
  })

  it('treats a hitch as one run carrying all the time, and does not owe the missed runs', () => {
    const rates = createUpdateRates()
    const gate = rates.hz('job', 10)
    expect(gate(HZ_72)).not.toBeNull() // first call
    for (let i = 0; i < 3; i++) expect(gate(HZ_72)).toBeNull()
    const hitch = gate(0.75)
    expect(hitch).not.toBeNull()
    // 3 skipped frames plus the hitch: everything since the last run, 0.75 + 3 / 72.
    expect(hitch as number).toBeCloseTo(0.75 + 3 * HZ_72, 9)
    // No catch-up burst: the frame after the hitch is not due, and the cadence goes on a period at a time.
    expect(gate(HZ_72)).toBeNull()
    let runs = 0
    for (let i = 0; i < 6; i++) if (gate(HZ_72) !== null) runs++
    expect(runs).toBe(1)
  })

  it('is due on every frame of a display slower than its rate, handing over that frame', () => {
    const { ranOn, handed } = drive(90, 30, 1 / 30)
    expect(ranOn).toHaveLength(30)
    for (const s of handed) expect(s).toBeCloseTo(1 / 30, 9)
  })

  it('holds still while no time passes (a paused sim hands it zero)', () => {
    const rates = createUpdateRates()
    const gate = rates.hz('job', 10)
    expect(gate(0)).not.toBeNull() // the first call is due whatever the delta
    for (let i = 0; i < 100; i++) expect(gate(0)).toBeNull()
    // ...and resumes when time does.
    let ran = false
    for (let i = 0; i < 20 && !ran; i++) ran = gate(HZ_72) !== null
    expect(ran).toBe(true)
  })

  it('reads an unusable rate as every frame, not as silence', () => {
    for (const bad of [0, -5, Number.NaN]) {
      const { ranOn } = drive(bad, 10, HZ_72)
      expect(ranOn, `${bad}`).toHaveLength(10)
    }
  })

  it('reports what it ran and what it skipped, under the name it was declared with', () => {
    const { rates, ranOn } = drive(20, 30, HZ_72)
    expect(rates.report().job).toEqual({
      rate: '20 Hz',
      due: ranOn.length,
      skipped: 30 - ranOn.length,
    })
  })
})

describe('staggered gates', () => {
  it('puts one slot of N on each frame, never all of them: stagger, do not batch', () => {
    for (const every of [2, 3, 4, 5, 8]) {
      const gate = createUpdateRates().staggered('job', every)
      for (let frame = 0; frame < every * 6; frame++) {
        let due = 0
        for (let slot = 0; slot < every; slot++) if (gate(frame, slot)) due++
        expect(due, `${every} slots, frame ${frame}`).toBe(1)
      }
    }
  })

  it('runs each slot once every N frames', () => {
    const gate = createUpdateRates().staggered('job', 3)
    const ranOn = (slot: number): number[] =>
      Array.from({ length: 12 }, (_, f) => f).filter((f) => gate(f, slot))
    expect(ranOn(0)).toEqual([0, 3, 6, 9])
    expect(ranOn(1)).toEqual([2, 5, 8, 11])
    expect(ranOn(2)).toEqual([1, 4, 7, 10])
  })

  it('spreads more slots than the period over the frames evenly', () => {
    // Six racers over a period of 3: two per frame, the same two every third frame.
    const gate = createUpdateRates().staggered('job', 3)
    const perFrame = Array.from(
      { length: 9 },
      (_, f) => [0, 1, 2, 3, 4, 5].filter((slot) => gate(f, slot)).length,
    )
    expect(perFrame).toEqual([2, 2, 2, 2, 2, 2, 2, 2, 2])
  })

  it('reads a period below 2 as every frame', () => {
    for (const every of [1, 0, -3, Number.NaN]) {
      const gate = createUpdateRates().staggered('job', every)
      for (let f = 0; f < 5; f++)
        for (let slot = 0; slot < 4; slot++) expect(gate(f, slot)).toBe(true)
    }
  })

  it('reports the slots it ran and skipped', () => {
    const rates = createUpdateRates()
    const gate = rates.staggered('job', 4)
    for (let f = 0; f < 8; f++) for (let slot = 0; slot < 4; slot++) gate(f, slot)
    expect(rates.report().job).toEqual({ rate: '1 slot in 4', due: 8, skipped: 24 })
  })
})
