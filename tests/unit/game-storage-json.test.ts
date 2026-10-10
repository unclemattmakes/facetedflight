import { describe, expect, it } from 'vitest'
import { loadSettings, SETTINGS_KEY, saveSettings } from '@/boot/settings'
import { readFlagKey, readJsonKey, writeJsonKey } from '@/game/storage'
import { rememberedVariant, rememberVariant, VARIANT_CHOICE_KEY } from '@/game/variant-choice'

/** A store whose every call throws: the case a jsdom mock never produces by accident. */
const throwing = {
  getItem: (): string | null => {
    throw new Error('SecurityError')
  },
  setItem: (): void => {
    throw new Error('QuotaExceededError')
  },
}

const memory = (initial: Record<string, string> = {}) => {
  const map = new Map(Object.entries(initial))
  return {
    map,
    getItem: (k: string): string | null => map.get(k) ?? null,
    setItem: (k: string, v: string): void => void map.set(k, v),
  }
}

describe('readJsonKey (BE-2: never throws, undefined is "nothing usable")', () => {
  it('reads what writeJsonKey stored, including falsy JSON values', () => {
    const s = memory()
    expect(writeJsonKey(s, 'k', { a: 1 })).toBe(true)
    expect(readJsonKey(s, 'k')).toEqual({ a: 1 })
    s.map.set('n', 'null')
    s.map.set('z', '0')
    s.map.set('f', 'false')
    expect(readJsonKey(s, 'n')).toBeNull()
    expect(readJsonKey(s, 'z')).toBe(0)
    expect(readJsonKey(s, 'f')).toBe(false)
  })

  it('is undefined for no store, no key, an empty string, non-JSON and a throwing store', () => {
    expect(readJsonKey(null, 'k')).toBeUndefined()
    expect(readJsonKey(memory(), 'k')).toBeUndefined()
    expect(readJsonKey(memory({ k: '' }), 'k')).toBeUndefined()
    expect(readJsonKey(memory({ k: '{nope' }), 'k')).toBeUndefined()
    expect(readJsonKey(throwing, 'k')).toBeUndefined()
  })
})

describe('writeJsonKey / readFlagKey', () => {
  it('writeJsonKey answers false instead of throwing', () => {
    expect(writeJsonKey(null, 'k', 1)).toBe(false)
    expect(writeJsonKey(throwing, 'k', 1)).toBe(false)
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(writeJsonKey(memory(), 'k', circular)).toBe(false)
  })

  it('readFlagKey is true only for "1"', () => {
    expect(readFlagKey(memory({ k: '1' }), 'k')).toBe(true)
    expect(readFlagKey(memory({ k: '0' }), 'k')).toBe(false)
    expect(readFlagKey(memory(), 'k')).toBe(false)
    expect(readFlagKey(null, 'k')).toBe(false)
    expect(readFlagKey(throwing, 'k')).toBe(false)
  })
})

describe('the sites that moved onto it keep their fallbacks', () => {
  it('loadSettings: DEFAULT_SETTINGS (the object) for nothing, junk or a throwing store', () => {
    const base = loadSettings(null)
    expect(loadSettings(memory())).toBe(base)
    expect(loadSettings(memory({ [SETTINGS_KEY]: '{junk' }))).toBe(base)
    expect(loadSettings(throwing)).toBe(base)
  })

  it('loadSettings: a stored JSON null is a value (parsed to defaults field by field), not "nothing"', () => {
    const s = memory({ [SETTINGS_KEY]: 'null' })
    const loaded = loadSettings(s)
    expect(loaded).not.toBe(loadSettings(null))
    expect(loaded.horizon).toBe(loadSettings(null).horizon)
  })

  it('saveSettings: true when it lands, false when the store refuses', () => {
    expect(saveSettings(loadSettings(null), memory())).toBe(true)
    expect(saveSettings(loadSettings(null), throwing)).toBe(false)
    expect(saveSettings(loadSettings(null), null)).toBe(false)
  })

  it('rememberVariant / rememberedVariant: keeps other aircraft, ignores arrays and junk', () => {
    const s = memory()
    rememberVariant('hoverjet', 'speed', s)
    rememberVariant('glider', 'light', s)
    expect(rememberedVariant('hoverjet', ['standard', 'speed'], s)).toBe('speed')
    expect(rememberedVariant('glider', ['standard', 'light'], s)).toBe('light')
    s.map.set(VARIANT_CHOICE_KEY, '["speed"]')
    expect(rememberedVariant('hoverjet', ['speed'], s)).toBeNull()
    expect(() => rememberVariant('hoverjet', 'speed', throwing)).not.toThrow()
    expect(rememberedVariant('hoverjet', ['speed'], throwing)).toBeNull()
  })
})
