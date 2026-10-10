// tests/unit/edition-settings.test.ts: the preset and the speed slider survive a
// reload, fall back per field, and scale the way the features expect.
//
// This was edition-menu.test.ts until DEV-859 took the EDITION page apart: LOOK
// (the preset) went up to OPTIONS, SPEED FX into COMFORT and RACE STRIP into
// MORE. The rows and their presses are tested where they live now
// (`options-menu.test.ts`, `comfort-menu.test.ts`); what stays here is the part
// that never was about a page: the settings' defaults, cycles and parsing, the
// numbers the slider scales by, and the live edition state.

import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, nextEdition, nextSpeedFx, parseSettings } from '@/boot/settings'
import type { Edition } from '@/content/edition-schema'
import { createEditionState, SPEED_FX_SCALE, speedFxScale } from '@/game/edition'

/** A preset stub: the state machine never reads inside it. */
const preset = (id: Edition['id']): Edition => ({ id, title: id, note: '' }) as unknown as Edition

describe('the settings', () => {
  it('default to ANNIVERSARY and to LIGHT speed effects', () => {
    // Anniversary: Matt's call on 2026-09-13, having seen the A/B frames:
    // the first-time visitor gets the curated preset, and Classic is one press
    // away (DEV-078). Light: the vignette's reasoning, a real reduction for
    // the person who has not found the menu.
    expect(DEFAULT_SETTINGS.edition).toBe('anniversary')
    expect(DEFAULT_SETTINGS.speedFx).toBe('light')
  })

  it('cycle: the edition is a two-way toggle, the slider walks off, light, full, off', () => {
    expect(nextEdition('classic')).toBe('anniversary')
    expect(nextEdition('anniversary')).toBe('classic')
    expect(nextSpeedFx('off')).toBe('light')
    expect(nextSpeedFx('light')).toBe('full')
    expect(nextSpeedFx('full')).toBe('off')
  })

  it('fall back per field, so a stored v1 object without them loads whole', () => {
    // Adding a field is not a meaning change and does not bump SETTINGS_KEY:
    // a player's chosen vignette must survive the arrival of two new fields.
    const s = parseSettings({ vignette: 'strong', horizon: true })
    expect(s.vignette).toBe('strong')
    expect(s.edition).toBe('anniversary')
    expect(s.speedFx).toBe('light')
    // ...and a hand-edited nonsense value falls back on its own, not on the rest.
    const t = parseSettings({ edition: 'remaster', speedFx: 11, vignette: 'off' })
    expect(t.edition).toBe('anniversary')
    expect(t.speedFx).toBe('light')
    expect(t.vignette).toBe('off')
  })

  it('DEV-649: a stored strip choice comes back, and a nonsense one falls back to on', () => {
    expect(DEFAULT_SETTINGS.raceStrip).toBe(true)
    expect(parseSettings({ raceStrip: false }).raceStrip).toBe(false)
    expect(parseSettings({ raceStrip: 'no' }).raceStrip).toBe(true)
    expect(parseSettings({}).raceStrip).toBe(true)
  })
})

describe('the speed slider scales', () => {
  it('to 0, 0.5 and 1: light is HALF, not "a bit"', () => {
    expect(SPEED_FX_SCALE).toEqual({ off: 0, light: 0.5, full: 1 })
    expect(speedFxScale('off')).toBe(0)
    expect(speedFxScale('light')).toBe(0.5)
    expect(speedFxScale('full')).toBe(1)
  })
})

describe('the live edition state', () => {
  it('exposes the current preset, the resolved slider, and notifies on both changes', () => {
    const state = createEditionState(preset('classic'), DEFAULT_SETTINGS)
    const seen: string[] = []
    const off = state.subscribe((e, s) => seen.push(`${e.id}/${s.speedFx}`))
    expect(state.current.id).toBe('classic')
    expect(state.speedFx).toBe(0.5)
    state.setLook(preset('anniversary'))
    state.setSettings({ ...DEFAULT_SETTINGS, speedFx: 'full' })
    expect(state.current.id).toBe('anniversary')
    expect(state.speedFx).toBe(1)
    expect(seen).toEqual(['anniversary/light', 'anniversary/full'])
    // Setting the same object again is not a change and must not re-notify:
    // a feature that rebuilds a material on every notification would rebuild
    // it every frame otherwise.
    state.setLook(state.current)
    state.setSettings(state.settings)
    expect(seen).toHaveLength(2)
    off()
    state.setLook(preset('classic'))
    expect(seen).toHaveLength(2)
  })
})
