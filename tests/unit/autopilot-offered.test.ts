// tests/unit/autopilot-offered.test.ts — where the autopilot can be switched on (DEV-435).
//
// Matt, 2026-09-26: "unavailable in free flight". The flag is data on the mode
// row, read by P, the AUTO chip, a headset's held X and `?autopilot=1` in
// `boot/app.ts`. Pinned by value: offering it in a new mode is an edit made on
// purpose, here.

import { describe, expect, it } from 'vitest'
import { MODES } from '@/game/modes'

describe('the autopilot is offered where it can fly', () => {
  it('is off in Free Flight and on in every other mode', () => {
    const offered = Object.fromEntries(
      Object.entries(MODES).map(([mode, rules]) => [mode, rules.autopilot]),
    )
    expect(offered).toEqual({
      ringAttack: true,
      targetPractice: true,
      freeFlight: false,
      energyRace: true,
      lesson: true,
    })
  })

  it('is off exactly where the mode scores nothing it could fly to', () => {
    // The reason, as structure: Free Flight scores orbs only, taken in any
    // order, and the arrow points at nothing there (`game/next-target.ts`).
    for (const [mode, rules] of Object.entries(MODES)) {
      const orbsOnly = rules.scores.length > 0 && rules.scores.every((s) => s === 'orb')
      expect(rules.autopilot, mode).toBe(!orbsOnly)
    }
  })
})
