// tests/unit/menu-latches.test.ts: the pause, Escape and confirm latches moved
// from hand-written `xxxHeld` booleans (read in several places, written once far
// away) to `createEdge` steps taken where the press is read (IA-3 leftovers).
//
// The OLD code is kept here as the oracle, written the way app.ts had it, and
// both are replayed over seeded scripts of frames in which every input flips and
// every gate (the flight, the results panel, a TV, a headset, the splash) opens
// and closes. The outputs compared are the exact booleans each reader used.
// Then the source is read for the premise the move rests on: each step is a
// statement at the frame body's own indentation, so no branch can skip it.

import { describe, expect, it } from 'vitest'
import { createEdge } from '@/input/edge'
import { appSourceThroughCtx } from './helpers/app-source'

const prng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 4294967296
}

interface PauseFrame {
  wantPause: boolean
  kbPause: boolean
  escape: boolean
  presenting: boolean
  lookdevUp: boolean
  flightResults: boolean
  tv: boolean
}

const pauseFrames = (seed: number, n: number): PauseFrame[] => {
  const rnd = prng(seed)
  // Held for a few frames at a time, as a real press is, with random gates.
  const out: PauseFrame[] = []
  let want = false
  let kb = false
  let esc = false
  for (let i = 0; i < n; i++) {
    if (rnd() < 0.3) want = !want
    if (rnd() < 0.3) kb = !kb
    if (rnd() < 0.3) esc = !esc
    out.push({
      wantPause: want || kb,
      kbPause: kb,
      escape: esc,
      presenting: rnd() < 0.3,
      lookdevUp: rnd() < 0.2,
      flightResults: rnd() < 0.5,
      tv: rnd() < 0.3,
    })
  }
  return out
}

/** What each reader of the pause edge saw, in app.ts's order. */
const readers = (p: boolean, e: boolean, f: PauseFrame) => ({
  resultsAgain: p && f.flightResults,
  tvToggle: !f.flightResults && p && f.tv,
  pageBackArm: (p && f.kbPause) || (e && !f.presenting && !f.lookdevUp),
  toggle: p,
  escape: e && !f.presenting,
})

describe('pause and Escape: the old latch against createEdge', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`identical reader outputs over 800 frames (seed ${seed})`, () => {
      const frames = pauseFrames(seed, 800)

      // The old code: read the latch in four places, write it after the last.
      let pauseHeld = false
      let escapeHeld = false
      const old = frames.map((f) => {
        const out = readers(f.wantPause && !pauseHeld, f.escape && !escapeHeld, f)
        pauseHeld = f.wantPause
        escapeHeld = f.escape
        return out
      })

      // The new code: step both first, read the answers.
      const pauseKey = createEdge()
      const escapeKey = createEdge()
      const next = frames.map((f) => {
        const p = pauseKey.step(f.wantPause)
        const e = escapeKey.step(f.escape)
        return readers(p, e, f)
      })

      expect(next).toEqual(old)
      // The script really does press, in every gate state (otherwise it proves nothing).
      expect(old.some((o) => o.toggle)).toBe(true)
      expect(old.some((o) => o.pageBackArm && o.escape)).toBe(true)
      expect(old.some((o) => o.tvToggle)).toBe(true)
    })
  }
})

describe('confirm: the old latch, with the splash holding it, against createEdge', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`identical presses over 800 frames (seed ${seed})`, () => {
      const rnd = prng(seed * 31)
      let confirm = false
      let covering = false
      const frames: { confirm: boolean; covering: boolean }[] = []
      for (let i = 0; i < 800; i++) {
        if (rnd() < 0.25) confirm = !confirm
        if (rnd() < 0.08) covering = !covering
        frames.push({ confirm, covering })
      }

      let confirmHeld = false
      const old = frames.map((f) => {
        if (f.covering) confirmHeld = true
        const lifted = f.confirm && !confirmHeld
        const handled = f.confirm && !confirmHeld
        confirmHeld = f.confirm
        return { lifted, handled }
      })

      const key = createEdge()
      const next = frames.map((f) => {
        if (f.covering) key.hold()
        const pressed = key.step(f.confirm)
        return { lifted: pressed, handled: pressed }
      })

      expect(next).toEqual(old)
      expect(old.some((o) => o.handled)).toBe(true)
      // A press that began under the splash is not an edge when it goes, either.
      const underSplash = frames.flatMap((f, i) =>
        f.covering && f.confirm && !(frames[i - 1]?.confirm ?? false) ? [next[i]?.handled] : [],
      )
      expect(underSplash.length, 'the script presses under the splash').toBeGreaterThan(0)
      expect(underSplash.every((h) => h === false)).toBe(true)
    })
  }
})

describe('app.ts steps each of the three latches on every frame it runs', () => {
  const app = appSourceThroughCtx()

  it('has no hand-written pause, Escape or confirm latch left', () => {
    expect(app).not.toMatch(/\b(?:pauseHeld|escapeHeld|confirmHeld)\b/)
  })

  it('steps each edge as a statement at the frame body indentation, never inside a branch', () => {
    // Four spaces: the frame body's own level. A step inside an `if` or an `||`
    // is a frame the latch did not see (`input/edge.ts`).
    expect(app).toMatch(/^ {4}const pausePressed = pauseKey\.step\(wantPause\)$/m)
    expect(app).toMatch(/^ {4}const escapePressed = escapeKey\.step\(keyboardEscape\)$/m)
    expect(app).toMatch(/^ {4}const confirmPressed = confirmKey\.step\(confirm\)$/m)
  })

  it('steps pause and Escape before the first branch that reads them', () => {
    const step = app.indexOf('const pausePressed = pauseKey.step(wantPause)')
    const firstRead = app.indexOf('if (pausePressed && flight && lastResult')
    const escapeStep = app.indexOf('const escapePressed = escapeKey.step(keyboardEscape)')
    const escapeRead = app.indexOf('(escapePressed && !presenting && !lookdevUp)')
    expect(step).toBeGreaterThan(-1)
    expect(firstRead).toBeGreaterThan(step)
    expect(escapeRead).toBeGreaterThan(escapeStep)
    expect(escapeStep).toBeGreaterThan(-1)
  })
})
