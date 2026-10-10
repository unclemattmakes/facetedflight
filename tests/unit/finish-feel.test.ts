// tests/unit/finish-feel.test.ts: GO and the finish, felt (DEV-644).

import { describe, expect, it } from 'vitest'
import { MEDAL_CUES } from '@/audio/events'
import { sampleCurve } from '@/audio/speed-curves'
import type { Edition } from '@/content/edition-schema'
import { EDGE_FLASH_SPEED, FINISH_FEEL, GO_FEEL, medalTierOf } from '@/game/finish-feel'
import { medalColour } from '@/render/medal'
import anniversaryJson from '../../content/editions/anniversary.json'

const anniversary = anniversaryJson as unknown as Edition

describe('the medal tiers the finish knows', () => {
  const tiers = ['bronze', 'silver', 'gold', 'platinum'] as const

  it('every tier has a colour for the flash and a phrase for the ear, and they agree on the set', () => {
    // The colour and the cue are keyed by two different tables; the relationship
    // worth asserting is that they cover the same four tiers.
    for (const tier of tiers) {
      expect(medalTierOf(tier), tier).toBe(tier)
      expect(MEDAL_CUES[tier], tier).toBeDefined()
      expect(medalColour(tier)).toBeDefined()
    }
    expect(Object.keys(MEDAL_CUES).sort()).toEqual([...tiers].sort())
  })

  it('a grade that is no tier has no colour (none, a future grade, nothing)', () => {
    for (const medal of ['none', 'diamond', '', 'GOLD']) expect(medalTierOf(medal)).toBeNull()
  })

  it('the four flashes are four different colours', () => {
    const hex = tiers.map((t) => medalColour(t).getHex())
    expect(new Set(hex).size).toBe(4)
  })
})

describe('the numbers GO and the finish read', () => {
  it('an edge flash is fired inside the gate pulse speed curve, where it has strength', () => {
    const block = anniversary.fx.gatePulse
    expect(sampleCurve(block.gainBySpeed, EDGE_FLASH_SPEED)).toBeGreaterThan(0)
  })

  it('GO kicks the lens a little and briefly, and the finish pulses harder than a plain gate', () => {
    expect(GO_FEEL.fovKickDegrees).toBeGreaterThan(0)
    expect(GO_FEEL.fovKickDegrees).toBeLessThan(5)
    expect(GO_FEEL.fovKickSeconds).toBeLessThan(1)
    expect(FINISH_FEEL.pulseScale).toBeGreaterThan(1)
  })
})
