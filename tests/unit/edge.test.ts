// tests/unit/edge.test.ts: the rising-edge latch every `xxxHeld` in app.ts was.

import { describe, expect, it } from 'vitest'
import { createEdge, createEdges } from '@/input/edge'

/** The two lines `app.ts` wrote about twenty times: the oracle for `step`. */
const oldLatch = () => {
  let held = false
  return (want: boolean): boolean => {
    const press = want && !held
    held = want
    return press
  }
}

describe('createEdge', () => {
  it('is true on the frame the state goes down, and only then', () => {
    const e = createEdge()
    expect([false, true, true, true, false, false, true, false].map((d) => e.step(d))).toEqual([
      false,
      true,
      false,
      false,
      false,
      false,
      true,
      false,
    ])
  })

  it('agrees with the hand-rolled latch on a long scripted run', () => {
    // A cheap deterministic pattern: runs of down and up of varying length.
    const e = createEdge()
    const old = oldLatch()
    let presses = 0
    for (let i = 0; i < 2000; i++) {
      const down = (i * 7 + (i >> 3) * 5) % 11 < 4
      const a = old(down)
      expect(e.step(down), `frame ${i}`).toBe(a)
      if (a) presses++
    }
    expect(presses).toBeGreaterThan(50)
  })

  it('reports the last recorded state through `held`', () => {
    const e = createEdge()
    expect(e.held).toBe(false)
    e.step(true)
    expect(e.held).toBe(true)
    e.step(false)
    expect(e.held).toBe(false)
  })

  it('swallows the press in progress after `hold`, then records the real state', () => {
    // The splash covers a button already down (DEV-611): the press must not fire
    // when the splash goes, but a release and a fresh press must.
    const e = createEdge()
    e.hold()
    expect(e.step(true)).toBe(false)
    expect(e.step(true)).toBe(false)
    expect(e.step(false)).toBe(false)
    expect(e.step(true)).toBe(true)
  })

  it('makes the next down a fresh press after `reset`', () => {
    const e = createEdge()
    e.step(true)
    e.reset()
    expect(e.step(true)).toBe(true)
  })

  it('is one latch per instance', () => {
    const a = createEdge()
    const b = createEdge()
    a.step(true)
    expect(b.step(true)).toBe(true)
  })

  it('shows why the step must not sit behind a gate: a skipped step delivers the press late', () => {
    // `if (gate && e.step(want))` does not step while `gate` is false, so the
    // press made then arrives, stale, on the first frame the gate opens. This is
    // the trap the file header names; stepping into a const first is the cure.
    const gated = createEdge()
    const stepped = createEdge()
    let lateGated = false
    let lateStepped = false
    // Frame 1: the button goes down behind a closed gate.
    // Frame 2: the gate opens, the button is still down.
    const frames = [
      { gate: false, down: true },
      { gate: true, down: true },
    ]
    for (const f of frames) {
      if (f.gate && gated.step(f.down)) lateGated = true
      const pressed = stepped.step(f.down)
      if (f.gate && pressed) lateStepped = true
    }
    expect(lateGated).toBe(true)
    expect(lateStepped).toBe(false)
  })
})

describe('createEdges', () => {
  it('keeps one latch per key, so two buttons do not share a press', () => {
    const e = createEdges<string>()
    expect(e.step('left', true)).toBe(true)
    // The other hand has never been down: its press is its own.
    expect(e.step('right', true)).toBe(true)
    expect(e.step('left', true)).toBe(false)
    expect(e.step('right', false)).toBe(false)
    expect(e.step('right', true)).toBe(true)
  })

  it('agrees with the Map-of-booleans latch it replaced in tv-camera-input', () => {
    const was = new Map<number, boolean>()
    const old = (key: number, down: boolean): boolean => {
      const before = was.get(key) ?? false
      was.set(key, down)
      return down && !before
    }
    const e = createEdges<number>()
    for (let i = 0; i < 600; i++) {
      const key = i % 3
      const down = (i * 5 + (i >> 2)) % 7 < 3
      expect(e.step(key, down), `frame ${i}`).toBe(old(key, down))
    }
  })
})
