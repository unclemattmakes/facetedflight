// tests/unit/quality-auto.test.ts — a headset starts at Medium unless you
// picked a tier. DEV-334, Matt 2026-09-23.

import { describe, expect, it } from 'vitest'
import { applyQualityPins, clearMovedPins, type QualityPins } from '@/boot/quality-pin'
import {
  DEFAULT_SETTINGS,
  nextQualityChoice,
  parseSettings,
  qualityInForce,
  VR_AUTO_QUALITY,
} from '@/boot/settings'
import { qualityRow } from '@/render/comfort-menu'
import { QUALITY } from '@/render/quality'

describe('AUTO: High on a monitor, Medium in a headset', () => {
  it('is the default, and resolves per surface', () => {
    expect(DEFAULT_SETTINGS.qualityAuto).toBe(true)
    expect(qualityInForce(DEFAULT_SETTINGS, false)).toBe('high')
    expect(qualityInForce(DEFAULT_SETTINGS, true)).toBe(VR_AUTO_QUALITY)
    expect(VR_AUTO_QUALITY).toBe('medium')
  })

  it('gives a picked tier everywhere, even if the flag was left on', () => {
    // `{ ...DEFAULT_SETTINGS, quality: 'low' }` is how a partial update spells
    // "Low". AUTO only holds at the untouched default.
    for (const q of ['low', 'medium'] as const) {
      expect(qualityInForce({ ...DEFAULT_SETTINGS, quality: q }, true)).toBe(q)
    }
    expect(qualityInForce({ quality: 'high', qualityAuto: false }, true)).toBe('high')
    expect(qualityInForce({ quality: 'high' }, true)).toBe('high')
  })

  it('never lands a headset on a tier whose load-time answers differ from the monitor’s', () => {
    // MSAA is a context attribute chosen at load from the FLAT tier, and the
    // shadow map and detail ring read the flat tier too; `low` is the one tier
    // that turns all three off. An auto headset must agree with the monitor.
    expect(VR_AUTO_QUALITY).not.toBe('low')
    expect(QUALITY[VR_AUTO_QUALITY].msaa).toBe(QUALITY[DEFAULT_SETTINGS.quality].msaa)
  })
})

describe('the quality row', () => {
  it('cycles Auto → Low → Medium → High → Auto in a headset', () => {
    let s = { ...DEFAULT_SETTINGS }
    const seen: string[] = []
    for (let i = 0; i < 4; i++) {
      s = { ...s, ...nextQualityChoice(s, true) }
      seen.push(s.qualityAuto ? 'auto' : s.quality)
    }
    expect(seen).toEqual(['low', 'medium', 'high', 'auto'])
    expect(s.quality).toBe(DEFAULT_SETTINGS.quality)
  })

  it('cycles Auto → Low → Medium → High → Ultra → Auto on a monitor (DEV-581)', () => {
    let s = { ...DEFAULT_SETTINGS }
    const seen: string[] = []
    for (let i = 0; i < 5; i++) {
      s = { ...s, ...nextQualityChoice(s, false) }
      seen.push(s.qualityAuto ? 'auto' : s.quality)
    }
    expect(seen).toEqual(['low', 'medium', 'high', 'ultra', 'auto'])
    expect(s.quality).toBe(DEFAULT_SETTINGS.quality)
  })

  it('shows AUTO with both tiers, a picked tier plainly, and a URL pin as the pin', () => {
    const auto = qualityRow(DEFAULT_SETTINGS)
    expect(auto?.value).toBe('auto')
    expect(auto?.note).toMatch(/monitor.*headset/)
    const picked = qualityRow({ ...DEFAULT_SETTINGS, quality: 'low', qualityAuto: false })
    expect(picked?.value).toBe('low')
    const pinned = qualityRow(DEFAULT_SETTINGS, 'medium')
    expect(pinned?.value).toBe('medium')
    expect(pinned?.note).toMatch(/URL/)
  })
})

describe('stored settings from before the field', () => {
  it('reads a stored High as AUTO and a stored Low or Medium as a choice', () => {
    expect(parseSettings({ quality: 'high' }).qualityAuto).toBe(true)
    expect(parseSettings({ quality: 'medium' }).qualityAuto).toBe(false)
    expect(parseSettings({ quality: 'low' }).qualityAuto).toBe(false)
    expect(parseSettings({}).qualityAuto).toBe(true)
  })

  it('keeps an explicit flag', () => {
    expect(parseSettings({ quality: 'high', qualityAuto: false }).qualityAuto).toBe(false)
  })
})

describe('the ?quality= pin', () => {
  const pins: QualityPins = { quality: 'medium', adaptive: null, msaa: null, hz: null }

  it('is a choice for this load, so it holds in a headset', () => {
    const pinned = applyQualityPins(DEFAULT_SETTINGS, pins)
    expect(pinned.qualityAuto).toBe(false)
    expect(qualityInForce(pinned, true)).toBe('medium')
    const low = applyQualityPins(DEFAULT_SETTINGS, { ...pins, quality: 'low' })
    expect(qualityInForce(low, true)).toBe('low')
  })

  it('drops when the row moves, including High → Auto, which keeps `quality`', () => {
    const high = { ...DEFAULT_SETTINGS, quality: 'high' as const, qualityAuto: false }
    const auto = { ...high, qualityAuto: true }
    expect(clearMovedPins(pins, high, auto).quality).toBeNull()
    expect(clearMovedPins(pins, high, { ...high, vignette: 'off' }).quality).toBe('medium')
  })
})
