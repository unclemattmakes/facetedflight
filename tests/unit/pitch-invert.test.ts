// tests/unit/pitch-invert.test.ts: invertPitch, applied in one place (IA-8, D16).
//
// `applyPitchInvert` was the one negation in the flight readers; the two look
// paths (`look.ts`, `touchLook`) negated by hand with a zero guard of their own,
// because the shared one returned `-0` for a centred stick under invert and a
// motionless frame must equal `NO_LOOK` under `Object.is`. The helper now holds
// that guard and every path calls it.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyPitchInvert } from '@/input/actions'
import { touchLook } from '@/input/touch'
import { REPO } from './helpers/repo-root'

describe('applyPitchInvert', () => {
  it('passes the value through when invert is off, including a negative zero', () => {
    expect(applyPitchInvert(0.4, false)).toBe(0.4)
    expect(applyPitchInvert(-0.4, false)).toBe(-0.4)
    // Off is off: nothing is normalised, as before.
    expect(Object.is(applyPitchInvert(-0, false), -0)).toBe(true)
  })

  it('negates when invert is on', () => {
    expect(applyPitchInvert(0.4, true)).toBe(-0.4)
    expect(applyPitchInvert(-1, true)).toBe(1)
  })

  it('never returns -0 from the inverted branch', () => {
    // The old `-pitch` gave -0 here, which `toEqual` and `Object.is` tell from 0.
    expect(Object.is(applyPitchInvert(0, true), 0)).toBe(true)
    expect(Object.is(applyPitchInvert(-0, true), 0)).toBe(true)
  })

  it('is its own inverse, which is what menuNudge relies on to undo it', () => {
    for (const v of [-1, -0.5, 0.25, 1]) {
      expect(applyPitchInvert(applyPitchInvert(v, true), true)).toBe(v)
    }
  })
})

describe('the look paths use it', () => {
  it('touchLook: a drag inverts through it, and a still drag stays +0 either way', () => {
    const on = { invertPitch: true, flightIdle: true }
    const off = { invertPitch: false, flightIdle: true }
    const a = touchLook(0, 10, on)
    const b = touchLook(0, 10, off)
    expect(a.pitch).toBe(-b.pitch)
    const still = touchLook(0, 0, on)
    expect(Object.is(still.pitch, 0)).toBe(true)
    expect(Object.is(still.yaw, 0)).toBe(true)
  })

  it('look.ts and touch.ts no longer negate pitch by hand', () => {
    for (const file of ['look.ts', 'touch.ts']) {
      const src = readFileSync(path.join(REPO, 'src/input', file), 'utf8')
      expect(src, file).toMatch(/applyPitchInvert\(/)
      expect(src, file).not.toMatch(/invertPitch \? /)
    }
  })
})
