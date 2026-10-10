// tests/unit/hud-energy.test.ts — DEV-143's gauge, and the redraw signature.
//
// The panel is a canvas, so a node suite cannot look at the pixels. What it CAN
// hold is the rule the canvas depends on: `hud.ts` repaints only when
// `hudSignature` changes, so anything drawn and missing from the signature is a
// gauge that goes stale while every number behind it is correct.
//
// That is not a hypothetical here. Two states this gauge draws differently —
// "empty" and "locked out" — share a `fraction` at the instant the lockout
// latches, and they are inked differently on purpose. A signature that held only
// the fraction would leave the bar in its available colour through a lockout
// that had already started, which is precisely the case the colour exists for.
//
// And the absent/zero distinction, which is the panel's own rule for all three
// bars: Classic has no tank, so the gauge must not be drawn at all rather than
// drawn empty.

import { describe, expect, it } from 'vitest'
import { type HudState, hudSignature } from '@/render/hud'
import anniversary from '../../content/editions/anniversary.json'
import classic from '../../content/editions/classic.json'

const state = (over: Partial<HudState> = {}): HudState => ({
  ringsPassed: 7,
  ringsTotal: 21,
  score: 700,
  elapsed: 42.3,
  timeLimit: 180,
  speed: 170,
  medal: '',
  finished: false,
  countLabel: 'GATES',
  timeLabel: 'TIME',
  speedLabel: 'SPEED',
  banner: null,
  autopilot: false,
  ...over,
})

describe('the presets agree about whether there is a tank', () => {
  it('is off on Classic and on for Anniversary', () => {
    expect(classic.gameplay.energy.enabled).toBe(false)
    expect(anniversary.gameplay.energy.enabled).toBe(true)
  })

  it("Classic's scale is the one that makes boost free, not the one that stops it", () => {
    // The Classic convention is "flip the flag by hand and NOTHING changes".
    // For every other block that means a zero; here a zero would be a tank that
    // never refills, which is the opposite of 2016. 1 is the shipped rate.
    expect(classic.gameplay.energy.rechargeScale).toBe(1)
    expect(anniversary.gameplay.energy.rechargeScale).toBeLessThan(
      classic.gameplay.energy.rechargeScale,
    )
  })
})

describe('the redraw signature holds what is DRAWN', () => {
  it('distinguishes no tank from an empty one', () => {
    const none = hudSignature(state({ energy: undefined }))
    const empty = hudSignature(state({ energy: { fraction: 0, available: false } }))
    expect(none).not.toBe(empty)
  })

  it('distinguishes an empty tank from a locked-out one at the SAME fraction', () => {
    // The case the colour exists for, and the one a fraction-only signature
    // would miss. Both bars are the same length; one of them will light if you
    // pull the trigger and the other will not.
    const emptyAvailable = hudSignature(state({ energy: { fraction: 0.4, available: true } }))
    const emptyLocked = hudSignature(state({ energy: { fraction: 0.4, available: false } }))
    expect(emptyAvailable).not.toBe(emptyLocked)
  })

  it('DEV-567: repaints when boost lights or goes out at the same fraction (READY and BOOST)', () => {
    // The two words share a fraction and an `available` at the tick the
    // trigger is pressed; a signature without `burning` would leave READY up
    // through the first stretch of a boost.
    const ready = hudSignature(
      state({ energy: { fraction: 0.6, available: true, burning: false } }),
    )
    const lit = hudSignature(state({ energy: { fraction: 0.6, available: true, burning: true } }))
    expect(ready).not.toBe(lit)
  })

  it('DEV-567: the quarter mark is drawn at `reengage`, so the signature holds it', () => {
    const a = hudSignature(state({ energy: { fraction: 0.1, available: false, reengage: 0.25 } }))
    const b = hudSignature(state({ energy: { fraction: 0.1, available: false, reengage: 0.4 } }))
    expect(a).not.toBe(b)
  })

  it('repaints as the tank drains', () => {
    const full = hudSignature(state({ energy: { fraction: 1, available: true } }))
    const half = hudSignature(state({ energy: { fraction: 0.5, available: true } }))
    expect(full).not.toBe(half)
  })

  it('does NOT repaint for a change too small to see', () => {
    // The whole point of a signature. The tank moves every tick — 16 % of the
    // bar a second — so a raw float would put the canvas back to 82 uploads a
    // second. Quantised to 40 steps, which is half a pixel on a bar that is
    // 504 px wide at the panel's texture resolution.
    const a = hudSignature(state({ energy: { fraction: 0.5, available: true } }))
    const b = hudSignature(state({ energy: { fraction: 0.5049, available: true } }))
    expect(a).toBe(b)
  })

  it('leaves every other row alone', () => {
    // A gauge that changed the signature of a panel with no tank on it would
    // make Classic repaint for a mechanic it does not have.
    const before = hudSignature(state())
    const after = hudSignature(state({ energy: undefined }))
    expect(before).toBe(after)
  })
})
