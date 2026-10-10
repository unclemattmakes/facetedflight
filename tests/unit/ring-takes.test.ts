// tests/unit/ring-takes.test.ts: other players' ring bursts, bounded. DEV-868.

import { describe, expect, it } from 'vitest'
import {
  BURST_LIFE_SECONDS,
  createRingTakeWatch,
  MAX_BURSTS_LIVE,
  MAX_BURSTS_PER_FRAME,
} from '@/game/ring-takes'
import type { Gate } from '@/sim/course'

const gate = (x: number): Gate => ({
  centre: { x, y: 0, z: 0 },
  radius: 20,
  points: 100,
  triggerOnce: true,
})
const GATES = Array.from({ length: 12 }, (_, i) => gate(i * 100))
const upTo = (n: number): boolean[] => GATES.map((_, i) => i < n)

describe('an AI racer is read off its own course', () => {
  it('bursts the gate that went false to true, once', () => {
    const w = createRingTakeWatch(GATES)
    const passed = upTo(0)
    w.begin(0)
    w.watchPassed('a', passed)
    expect(w.takes).toEqual([])
    passed[0] = true
    w.begin(1)
    w.watchPassed('a', passed)
    expect(w.takes).toEqual([0])
    w.begin(2)
    w.watchPassed('a', passed)
    expect(w.takes).toEqual([])
  })

  it('does not burst the passes a racer already had at first sight, or a reset', () => {
    const w = createRingTakeWatch(GATES)
    w.begin(0)
    w.watchPassed('a', upTo(5))
    expect(w.takes).toEqual([])
    w.begin(1)
    w.watchPassed('a', upTo(0))
    expect(w.takes).toEqual([])
    w.begin(2)
    w.watchPassed('a', upTo(8))
    expect(w.takes).toEqual([])
  })
})

describe('a room player is read off the sim trigger test', () => {
  it('bursts on entering a gate sphere, not on being placed in one', () => {
    const w = createRingTakeWatch(GATES)
    w.begin(0)
    w.watchPosition('r', { x: 0, y: 0, z: 0 })
    w.begin(0.1)
    w.watchPosition('r', { x: 5, y: 0, z: 0 })
    expect(w.takes).toEqual([])
    w.begin(0.2)
    w.watchPosition('r', { x: 60, y: 0, z: 0 })
    w.begin(0.3)
    w.watchPosition('r', { x: 85, y: 0, z: 0 })
    expect(w.takes).toEqual([1])
  })

  it('treats a teleport as a placement', () => {
    const w = createRingTakeWatch(GATES)
    w.begin(0)
    w.watchPosition('r', { x: -900, y: 0, z: 0 })
    w.begin(0.1)
    w.watchPosition('r', { x: 300, y: 0, z: 0 })
    expect(w.takes).toEqual([])
  })
})

describe('bursts are bounded', () => {
  it('caps one frame', () => {
    const w = createRingTakeWatch(GATES)
    const names = ['a', 'b', 'c']
    w.begin(0)
    for (const n of names) w.watchPassed(n, upTo(0))
    w.begin(1)
    for (const n of names) w.watchPassed(n, upTo(3))
    expect(w.takes.length).toBe(MAX_BURSTS_PER_FRAME)
  })

  it('caps the live total inside one burst lifetime', () => {
    const w = createRingTakeWatch(GATES)
    let total = 0
    for (let f = 0; f < 10; f++) {
      w.begin(f * 0.01)
      w.watchPassed(`s${f}`, upTo(0))
    }
    for (let f = 0; f < 10; f++) {
      w.begin(0.2 + f * 0.01)
      w.watchPassed(`s${f}`, upTo(1))
      total += w.takes.length
    }
    expect(total).toBe(MAX_BURSTS_LIVE)
  })

  it('frees the live budget once bursts have finished', () => {
    const w = createRingTakeWatch(GATES)
    w.begin(0)
    w.watchPassed('a', upTo(0))
    w.begin(0.1)
    w.watchPassed('a', upTo(1))
    expect(w.takes.length).toBe(1)
    w.begin(0.1 + BURST_LIFE_SECONDS + 0.1)
    w.watchPassed('a', upTo(2))
    expect(w.takes).toEqual([1])
  })
})
