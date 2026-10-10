// tests/unit/hud-speed-unit.test.ts — the number on the speed row, and the
// unit that was never on it.
//
// DEV-083, ANNIVERSARY.md §2.5 S8. `HudState.speed` is metres per second and the
// shipped panel prints `Math.round` of it with nothing after it, so `SPEED: 170`
// is 612 km/h and the panel does not say so. The Anniversary preset converts for
// display; Classic must be untouched — and "untouched" here means the same
// characters, not the same intent.
//
// The second half is the redraw signature, which is the part of this change most
// likely to go wrong quietly. `hud.ts` repaints only when a displayed value
// changes, and the entry for this row USED to be `Math.round(state.speed)` —
// exactly what was drawn, until a factor of 3.6 came between the two. A panel
// whose signature tracks the input rather than the output goes stale while every
// number it holds is correct, which is the worst kind of stale: nothing is
// wrong, and the screen is wrong.

import { describe, expect, it } from 'vitest'
import { SPEED_UNITS } from '@/content/edition-schema'
import { formatSpeed, type HudState, hudSignature } from '@/render/hud'
import anniversary from '../../content/editions/anniversary.json'
import classic from '../../content/editions/classic.json'

/** A mid-run panel. Every field present, so a test can change exactly one. */
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

describe('the presets say what the panel is measured in', () => {
  it('is metres per second on Classic and km/h on Anniversary', () => {
    expect(classic.hud.speedUnit).toBe('ms')
    expect(anniversary.hud.speedUnit).toBe('kmh')
    // Both are legal values of the enum the schema declares — the check that
    // stops the two files and `edition-schema.ts` drifting apart.
    expect(SPEED_UNITS).toContain(classic.hud.speedUnit)
    expect(SPEED_UNITS).toContain(anniversary.hud.speedUnit)
  })
})

describe('formatting', () => {
  it('turns 170 m/s into the number a person can feel', () => {
    // 170 x 3.6 = 612. Matt's own example, and the one line of §2.5 S8.
    expect(formatSpeed(170, 'kmh')).toBe('612 km/h')
  })

  it('prints exactly what 2016 printed in ms, and defaults to it', () => {
    expect(formatSpeed(170, 'ms')).toBe('170')
    // No argument at all is the shipped behaviour: every caller that has never
    // heard of editions — the tests, a screenshot harness — keeps the old panel.
    expect(formatSpeed(170)).toBe('170')
  })

  it('is character-for-character the old row across the whole envelope', () => {
    // `Math.round` is what the row did before S8 existed and it is what Classic
    // has to keep doing. Not "looks the same": the same string, at 437.5 m/s
    // (the prefab's top speed), at rest, and at the halves that round away.
    for (const v of [0, 0.4, 0.5, 24.9, 25, 119.5, 170, 240.49, 350, 437.5]) {
      expect(formatSpeed(v, 'ms')).toBe(String(Math.round(v)))
    }
  })

  it('puts the unit on the VALUE, never on the label', () => {
    // `speedLabel` is 2016's own copy out of `level.ui` (`Speed :` -> `SPEED`)
    // and it is not ours to rewrite. The row appends its own colon; the unit
    // goes on the other end of the row.
    expect(formatSpeed(170, 'kmh')).not.toContain('SPEED')
    expect(formatSpeed(170, 'kmh').startsWith('612')).toBe(true)
  })

  it('rounds the converted number, not the source one', () => {
    // 47 m/s is 169.2 km/h. Converting a rounded 47 would give 169.2 too, but
    // 47.4 rounds to 47 in m/s and is 170.6 km/h — a whole km/h apart from what
    // rounding first would print.
    expect(formatSpeed(47.4, 'kmh')).toBe('171 km/h')
    expect(formatSpeed(47.4, 'ms')).toBe('47')
  })
})

describe('the redraw signature holds what is DRAWN', () => {
  it('changes when the unit changes and nothing else does', () => {
    // A preset flip mid-run must repaint. Without this the panel would keep
    // saying `170` until the next second ticked over — and a stale unit is
    // worse than no unit, because it is a number in the wrong scale that
    // looks exactly like a number in the right one.
    const ms = hudSignature(state({ speedUnit: 'ms' }))
    const kmh = hudSignature(state({ speedUnit: 'kmh' }))
    expect(ms).not.toBe(kmh)
  })

  it('treats an absent unit as ms, so no existing caller repaints', () => {
    expect(hudSignature(state())).toBe(hudSignature(state({ speedUnit: 'ms' })))
  })

  it('tracks a change the OLD signature could not see', () => {
    // The whole reason the entry had to change. 170.0 and 170.3 m/s both round
    // to 170, so `Math.round(state.speed)` is identical for the two — and in
    // km/h they are 612 and 613, two different rows. In ms they are still one
    // row, and the signature has to agree with that too.
    const a = state({ speed: 170.0 })
    const b = state({ speed: 170.3 })
    expect(Math.round(a.speed)).toBe(Math.round(b.speed))
    expect(hudSignature({ ...a, speedUnit: 'kmh' })).not.toBe(
      hudSignature({ ...b, speedUnit: 'kmh' }),
    )
    expect(hudSignature({ ...a, speedUnit: 'ms' })).toBe(hudSignature({ ...b, speedUnit: 'ms' }))
  })

  it('still holds everything it held before', () => {
    // The guard on the guard: exporting the signature moved it, and a move is
    // where an entry goes missing. One assertion per field that is drawn.
    const base = state()
    const changed: Partial<HudState>[] = [
      { ringsPassed: 8 },
      { ringsTotal: 22 },
      { elapsed: 43.4 },
      { speed: 171 },
      { medal: 'gold' },
      { finished: true },
      { award: 'BULLSEYE' },
      { awardTone: 'loss' },
      { multiplier: 3 },
      { banner: 'GO' },
      { autopilot: true },
      { countLabel: 'ORBS' },
      { timeLabel: 'CLOCK' },
      { speedLabel: 'SPEED ' },
    ]
    for (const over of changed) {
      const key = Object.keys(over)[0] ?? '?'
      expect(hudSignature({ ...base, ...over }), key).not.toBe(hudSignature(base))
    }
  })

  it('does NOT repaint for something the panel never draws', () => {
    // `score` is not on this panel — 2016 put score on the end-of-run screen —
    // so a signature that changed with it would repaint the canvas for nothing
    // at whatever rate the score moves.
    expect(hudSignature(state({ score: 999999 }))).toBe(hudSignature(state()))
  })
})
