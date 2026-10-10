// tests/unit/race-strip.test.ts: the flat race strip's pure half. DEV-649.
//
// The strip itself is DOM and is photographed (docs/DEVIATIONS.md, DEV-649).
// What a unit test can hold is the score's roll, which is the one number on
// it that moves by a rule, and that a host with no DOM gets an inert strip.

import { describe, expect, it } from 'vitest'
import {
  createRaceStrip,
  createScoreRoll,
  SCORE_ROLL_SECONDS,
  scoreText,
} from '@/render/race-strip'
import { appFileWith } from './helpers/app-source'

describe('the score roll', () => {
  it('rolls a new score up over about 0.3 s, and lands exactly on it', () => {
    expect(SCORE_ROLL_SECONDS).toBe(0.3)
    const roll = createScoreRoll()
    roll.set(0, 0)
    roll.set(100, 1000)
    expect(roll.value(1000)).toBe(0)
    const mid = roll.value(1150)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(100)
    expect(roll.rolling(1150)).toBe(true)
    expect(roll.value(1300)).toBe(100)
    expect(roll.rolling(1300)).toBe(false)
    expect(roll.value(5000)).toBe(100)
  })

  it('never goes backwards while rolling up, and never overshoots', () => {
    const roll = createScoreRoll()
    roll.set(0, 0)
    roll.set(250, 0)
    let last = -1
    for (let t = 0; t <= 400; t += 10) {
      const v = roll.value(t)
      expect(v).toBeGreaterThanOrEqual(last)
      expect(v).toBeLessThanOrEqual(250)
      last = v
    }
  })

  it('starts a second roll from where the number is, not from the old target', () => {
    const roll = createScoreRoll()
    roll.set(0, 0)
    roll.set(100, 0)
    const part = roll.value(100)
    roll.set(200, 100)
    // No jump back to 0 and no jump on to 100: the next frame is at or just past `part`.
    expect(Math.abs(roll.value(100) - part)).toBeLessThanOrEqual(1)
    expect(roll.value(500)).toBe(200)
  })

  it('takes its first reading as where it starts, not a roll up from nothing', () => {
    const roll = createScoreRoll()
    roll.set(1800, 50)
    expect(roll.value(50)).toBe(1800)
    expect(roll.rolling(50)).toBe(false)
  })

  it('snaps down: a new run starts from its own number', () => {
    const roll = createScoreRoll()
    roll.set(0, 0)
    roll.set(2100, 0)
    roll.set(0, 1000)
    expect(roll.value(1000)).toBe(0)
  })
})

describe('the strip as a host without a DOM gets it', () => {
  it('is inert: nothing to mount, nothing to throw', () => {
    const strip = createRaceStrip(null)
    expect(strip.element).toBeNull()
    expect(strip.hintShowing).toBe(false)
    strip.showCameraHint(0)
    expect(strip.hintShowing).toBe(false)
    expect(() =>
      strip.update(
        {
          visible: true,
          place: 2,
          field: 6,
          countLabel: 'GATES',
          count: '07/21',
          timeLabel: 'TIME',
          time: '71',
          urgent: false,
          score: 700,
          split: null,
          touch: false,
        },
        0,
      ),
    ).not.toThrow()
    strip.dispose()
  })

  it('prints a score as digits only', () => {
    expect(scoreText(2100)).toBe('2100')
    expect(scoreText(-5)).toBe('0')
    expect(scoreText(99.6)).toBe('100')
  })
})

describe('the strip belongs to a flat screen alone (DEV-847)', () => {
  it('syncRaceStrip is gated on the XR session being absent, not only on presenting', () => {
    const file = appFileWith('const syncRaceStrip =')
    const body = file.text.slice(file.text.indexOf('const syncRaceStrip ='))
    const head = body.slice(0, body.indexOf('const visible ='))
    expect(head).toContain('xr.isPresenting')
    expect(head).toContain('xr.getSession() === null')
    // and `flying`, which feeds `visible`, is built from `flat`.
    expect(head).toMatch(/const flying =\s*flat &&/)
  })
})
