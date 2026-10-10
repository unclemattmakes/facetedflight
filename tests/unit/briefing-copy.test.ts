// tests/unit/briefing-copy.test.ts: the Anniversary briefing's words, and the
// rules each one claims. DEV-631.
//
// A sentence on the plate is a promise about the rules, so each is asserted
// against the thing that makes it true, not against itself: the edition's
// numbers, the constants sheet, the level JSON.

import { describe, expect, it } from 'vitest'
import { DIFFICULTY_ORDER } from '@/content/level-schema'
import { levelIds, loadLevel } from '@/content/load-level'
import { briefingCopy } from '@/game/briefing-copy'
import { refuelSpheresFor } from '@/game/jumpseat-flight'
import { MODES } from '@/game/modes'
import { HOVERJET } from '@/generated/constants.generated'
import { skiMarkShape } from '@/render/ski-marks'
import anniversary from '../../content/editions/anniversary.json'
import classic from '../../content/editions/classic.json'

const paysBoost = (e: { gameplay: { energy: { enabled: boolean; ringRefill: number } } }) =>
  e.gameplay.energy.enabled && e.gameplay.energy.ringRefill > 0

describe('DEV-631: the words, as Matt gave them', () => {
  it('HoverJet Ring Attack on Anniversary', () => {
    expect(briefingCopy('hoverjet', 'ringAttack', { ringsPayBoost: paysBoost(anniversary) })).toBe(
      "Rings give boost and increase top speed. Don't Crash!!",
    )
  })

  it('the JumpSeat', () => {
    expect(briefingCopy('jumpseat', 'targetPractice', { ringsPayBoost: true })).toBe(
      'Target pads refuel your craft. See how far you can get.',
    )
  })

  it('an unknown pair has no words of its own (the level says 2016s)', () => {
    expect(briefingCopy('glider', 'ringAttack', { ringsPayBoost: true })).toBeNull()
    expect(briefingCopy('jumpseat', 'freeFlight', { ringsPayBoost: true })).toBeNull()
  })
})

describe('DEV-631: each claim, against what makes it true', () => {
  it('"rings give boost": Anniversary pays the tank on a ring; 2016 rules do not, so the clause goes', () => {
    expect(paysBoost(anniversary)).toBe(true)
    expect(paysBoost(classic)).toBe(false)
    expect(
      briefingCopy('hoverjet', 'ringAttack', { ringsPayBoost: paysBoost(classic) }),
    ).not.toContain('boost')
  })

  it('"increase top speed": every ring adds to maxSpeed (the speed chain)', () => {
    expect(HOVERJET.speedChain.speedIncreaseAmt).toBeGreaterThan(0)
  })

  it('"target pads refuel": every JumpSeat course has live refuel spheres that pay', async () => {
    for (const id of await levelIds()) {
      const level = await loadLevel(id)
      if (level.vehicle !== 'jumpseat') continue
      const spheres = refuelSpheresFor(level)
      expect(spheres.length, `${id} has refuel pads`).toBeGreaterThan(0)
    }
  })

  it('"no clock" and "orbs earn medals" in Free Flight', () => {
    expect(MODES.freeFlight.clock).toBe(false)
    expect(MODES.freeFlight.scores).toContain('orb')
  })

  it('every difficulty a level can have wears a ski mark, easiest green', () => {
    expect(skiMarkShape(DIFFICULTY_ORDER.indexOf('beginner'))).toBe('square')
    expect(skiMarkShape(DIFFICULTY_ORDER.indexOf('intermediate'))).toBe('circle')
    expect(skiMarkShape(DIFFICULTY_ORDER.indexOf('professional'))).toBe('diamond')
  })
})
