// tests/unit/split-times.test.ts: the gap at a gate. DEV-649.
//
// The claim is that a split is MEASURED: two times at one gate, each the tick
// the entrant crossed it. So the tests build crossings with known times and ask
// for the gap, and one of them checks the thing an estimate could not do: the
// racer BEHIND you has no number until it reaches the gate.

import { describe, expect, it } from 'vitest'
import {
  createSplitTracker,
  gapText,
  gapTone,
  isSplitGate,
  SPLIT_EVERY_GATES,
  SPLIT_LATE_CAP_SECONDS,
  SPLIT_SECONDS,
  type SplitRacer,
  splitLine,
  splitTone,
} from '@/game/split-times'

const GATES = 21

/** A racer whose passed gates and clock the test sets by hand. */
const racer = (id: string): SplitRacer & { elapsed: number; passed: boolean[] } => {
  const passed = new Array<boolean>(GATES).fill(false)
  return { spec: { id }, elapsed: 0, passed, course: { passed } }
}

/** Advance one racer to `t` having just taken `gate`. */
const takes = (r: ReturnType<typeof racer>, gate: number, t: number): void => {
  r.elapsed = t
  r.passed[gate] = true
}

describe('which gates show a split', () => {
  it('is every fourth gate and always the last', () => {
    const shown = Array.from({ length: GATES }, (_, i) => i).filter((i) => isSplitGate(i, GATES))
    expect(SPLIT_EVERY_GATES).toBe(4)
    expect(shown).toEqual([3, 7, 11, 15, 19, 20])
  })

  it('shows the last gate of a course whose count is not a multiple of four', () => {
    expect(isSplitGate(5, 6)).toBe(true)
    expect(isSplitGate(4, 6)).toBe(false)
  })

  it('never shows for an index below zero', () => {
    expect(isSplitGate(-1, 3)).toBe(false)
  })
})

describe('how a gap reads', () => {
  it('is signed to one decimal, plus behind and minus ahead', () => {
    expect(gapText(1.44)).toBe('+1.4')
    expect(gapText(-0.8)).toBe('-0.8')
    expect(gapText(0.04)).toBe('0.0')
    expect(gapText(-0.04)).toBe('0.0')
  })

  it('inks behind as a loss and level or ahead as a gain', () => {
    expect(gapTone(1.4)).toBe('loss')
    expect(gapTone(-0.8)).toBe('gain')
    expect(gapTone(0)).toBe('gain')
    expect(gapTone(0.04)).toBe('gain')
  })
})

describe('against the ghost', () => {
  it('is the player time at the gate minus the ghost time at that gate', () => {
    const tracker = createSplitTracker()
    const ringTimes = Array.from({ length: GATES }, (_, i) => 10 + i * 3)
    const split = tracker.playerPass(3, 22.4, GATES, { label: 'GHOST', ringTimes })
    expect(split?.source).toBe('ghost')
    // The ghost took ring 3 at 19 s; the player at 22.4 s: 3.4 s behind.
    expect(split?.entries).toEqual([{ label: 'GHOST', gap: expect.closeTo(3.4, 9) }])
    expect(split && splitLine(split)).toBe('GHOST +3.4')
    expect(split && splitTone(split)).toBe('loss')
  })

  it('beats the field: with a ghost, the racers are not asked', () => {
    const tracker = createSplitTracker()
    const a = racer('fast')
    takes(a, 3, 20)
    tracker.observe([a])
    const split = tracker.playerPass(3, 22, GATES, {
      label: 'GHOST',
      ringTimes: [0, 0, 0, 21.5],
    })
    expect(split?.entries.map((e) => e.label)).toEqual(['GHOST'])
  })

  it('falls back to the field at a ring the ghost missed', () => {
    const tracker = createSplitTracker()
    const a = racer('fast')
    takes(a, 3, 20)
    tracker.observe([a])
    const split = tracker.playerPass(3, 22, GATES, { label: 'GHOST', ringTimes: [0, 0, 0, null] })
    expect(split?.source).toBe('field')
  })

  it('shows nothing at a gate that is not a split gate', () => {
    const tracker = createSplitTracker()
    expect(tracker.playerPass(2, 9, GATES, { label: 'GHOST', ringTimes: [1, 2, 3] })).toBeNull()
    expect(tracker.current(9.1)).toBeNull()
  })
})

describe('against the field', () => {
  it('names the nearest racer ahead at the same gate, immediately, from the tick it crossed', () => {
    const tracker = createSplitTracker()
    const a = racer('cutter')
    const b = racer('wide')
    takes(a, 3, 20.0)
    takes(b, 3, 21.0)
    tracker.observe([a, b])
    tracker.playerPass(3, 22.4, GATES, null)
    const now = tracker.current(22.4)
    expect(now?.entries).toEqual([{ label: 'WIDE', gap: expect.closeTo(1.4, 9), ai: true }])
  })

  it('waits for the racer behind, because an estimate is not a measurement', () => {
    const tracker = createSplitTracker()
    const a = racer('cutter')
    const b = racer('steady')
    takes(a, 3, 20.0)
    tracker.observe([a, b])
    tracker.playerPass(3, 22.0, GATES, null)
    // Nobody behind has crossed yet: only the racer ahead is on the split.
    expect(tracker.current(22.1)?.entries.map((e) => e.label)).toEqual(['CUTTER'])
    // Steady takes the gate 0.8 s after the player.
    takes(b, 3, 22.8)
    tracker.observe([a, b])
    const full = tracker.current(22.8)
    expect(full?.entries.map((e) => e.label)).toEqual(['CUTTER', 'STEADY'])
    expect(full?.entries[1]?.gap).toBeCloseTo(-0.8, 9)
    expect(full && splitLine(full)).toBe('CUTTER AI +2.0  STEADY AI -0.8')
  })

  it('is led by the player: no racer ahead, only the one behind once it arrives', () => {
    const tracker = createSplitTracker()
    const a = racer('cutter')
    tracker.observe([a])
    tracker.playerPass(3, 22.0, GATES, null)
    // Nothing to say while nobody has crossed.
    expect(tracker.current(22.1)).toBeNull()
    takes(a, 3, 23.1)
    tracker.observe([a])
    const now = tracker.current(23.1)
    expect(now?.entries).toEqual([{ label: 'CUTTER', gap: expect.closeTo(-1.1, 9), ai: true }])
    expect(now && splitTone(now)).toBe('gain')
  })

  it('stretches the window for a late racer behind, to a cap, and no further', () => {
    const tracker = createSplitTracker()
    const a = racer('cutter')
    const b = racer('steady')
    takes(a, 3, 20)
    tracker.observe([a, b])
    tracker.playerPass(3, 22, GATES, null)
    takes(b, 3, 22 + SPLIT_SECONDS - 0.1) // arrives with 0.1 s of the window left
    tracker.observe([a, b])
    const now = tracker.current(22 + SPLIT_SECONDS)
    expect(now?.entries).toHaveLength(2)
    expect(now?.until).toBeGreaterThan(22 + SPLIT_SECONDS)
    expect(now?.until).toBeLessThanOrEqual(22 + SPLIT_LATE_CAP_SECONDS)
  })

  it('does not show a racer that arrives after the cap', () => {
    const tracker = createSplitTracker()
    const a = racer('cutter')
    const b = racer('steady')
    takes(a, 3, 20)
    tracker.observe([a, b])
    tracker.playerPass(3, 22, GATES, null)
    takes(b, 3, 22 + SPLIT_LATE_CAP_SECONDS + 1)
    tracker.observe([a, b])
    expect(tracker.current(22 + 1)?.entries.map((e) => e.label)).toEqual(['CUTTER'])
  })

  it('takes the first racer behind to arrive, not a later one', () => {
    const tracker = createSplitTracker()
    const a = racer('cutter')
    const b = racer('steady')
    tracker.observe([a, b])
    tracker.playerPass(3, 22, GATES, null)
    takes(a, 3, 22.6)
    tracker.observe([a, b])
    takes(b, 3, 23.4)
    tracker.observe([a, b])
    expect(tracker.current(23.5)?.entries.map((e) => e.label)).toEqual(['CUTTER'])
  })

  it('goes down when its time is up', () => {
    const tracker = createSplitTracker()
    const a = racer('cutter')
    takes(a, 3, 20)
    tracker.observe([a])
    tracker.playerPass(3, 22, GATES, null)
    expect(tracker.current(22 + SPLIT_SECONDS - 0.01)).not.toBeNull()
    expect(tracker.current(22 + SPLIT_SECONDS)).toBeNull()
  })

  it('says nothing when nobody races', () => {
    const tracker = createSplitTracker()
    expect(tracker.playerPass(3, 22, GATES, null)).toBeNull()
    expect(tracker.current(22)).toBeNull()
  })

  it('stamps a gate once: the first tick it is seen passed', () => {
    const tracker = createSplitTracker()
    const a = racer('cutter')
    takes(a, 3, 20)
    tracker.observe([a])
    a.elapsed = 20.1
    tracker.observe([a])
    expect(tracker.stamps(0)[3]).toBe(20)
    expect(tracker.stamps(0)[4]).toBeNaN()
  })

  it('forgets the last run when a clock goes back', () => {
    const tracker = createSplitTracker()
    const a = racer('cutter')
    takes(a, 3, 20)
    tracker.observe([a])
    // A restart: the racer is rebuilt on zero and has taken nothing.
    const again = racer('cutter')
    tracker.observe([again])
    expect(tracker.stamps(0)[3]).toBeNaN()
    expect(tracker.playerPass(3, 22, GATES, null)?.entries).toEqual([])
  })
})
