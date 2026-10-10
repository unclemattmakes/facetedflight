// tests/unit/edition-auto.test.ts: a headset starts on Classic and Medium unless the
// player picked. DEV-896, Matt 2026-10-10: "default to classic & medium for quality settings".

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  editionInForce,
  nextEditionChoice,
  parseSettings,
  qualityInForce,
  VR_AUTO_EDITION,
  VR_AUTO_QUALITY,
} from '@/boot/settings'
import { activateSettingRow } from '@/render/comfort-menu'
import { lookRow } from '@/render/options-menu'

describe('AUTO look: Anniversary on a monitor, Classic in a headset', () => {
  it('pins the two defaults a headset gets', () => {
    // The single place the values are written down: change one on purpose.
    expect(VR_AUTO_EDITION).toBe('classic')
    expect(VR_AUTO_QUALITY).toBe('medium')
  })

  it('resolves per surface, and flat keeps what it had', () => {
    expect(DEFAULT_SETTINGS.edition).toBe('anniversary')
    expect(DEFAULT_SETTINGS.editionAuto).toBe(true)
    expect(editionInForce(DEFAULT_SETTINGS, false)).toBe('anniversary')
    expect(editionInForce(DEFAULT_SETTINGS, true)).toBe('classic')
    expect(qualityInForce(DEFAULT_SETTINGS, false)).toBe('high')
    expect(qualityInForce(DEFAULT_SETTINGS, true)).toBe('medium')
  })

  it('lets a saved choice win in a headset', () => {
    const picked = { ...DEFAULT_SETTINGS, edition: 'anniversary' as const, editionAuto: false }
    expect(editionInForce(picked, true)).toBe('anniversary')
    expect(editionInForce({ ...DEFAULT_SETTINGS, edition: 'classic' }, false)).toBe('classic')
  })

  it('reads old storage: a stored default is AUTO, a stored classic is a choice', () => {
    expect(parseSettings({ edition: 'anniversary' }).editionAuto).toBe(true)
    expect(parseSettings({ edition: 'classic' }).editionAuto).toBe(false)
    expect(parseSettings({ edition: 'anniversary', editionAuto: false }).editionAuto).toBe(false)
  })

  it('presses the look row from the look in force, and the press is a choice', () => {
    // In a headset on AUTO the row reads classic; one press goes to anniversary and stays.
    expect(lookRow(DEFAULT_SETTINGS, true).value).toBe('classic')
    expect(lookRow(DEFAULT_SETTINGS, false).value).toBe('anniversary')
    const press = nextEditionChoice(DEFAULT_SETTINGS, true)
    expect(press).toEqual({ edition: 'anniversary', editionAuto: false })
    const after = activateSettingRow(DEFAULT_SETTINGS, 'edition', true)
    expect(editionInForce(after ?? DEFAULT_SETTINGS, true)).toBe('anniversary')
    // On a monitor the press is today's: anniversary to classic.
    expect(activateSettingRow(DEFAULT_SETTINGS, 'edition', false)?.edition).toBe('classic')
  })
})
