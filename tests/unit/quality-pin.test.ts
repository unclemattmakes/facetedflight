// tests/unit/quality-pin.test.ts — `?quality=` and `?adaptive=` are pins, and
// a pin must not become a setting.
//
// DEV-161 / DEV-178, `docs/testing/perf-protocol.md` §3. The switches exist so
// a baseline row can hold the resolution still while it is taken. What they
// must never do is outlive the tab: somebody who takes one measurement row with
// `?quality=low` and then plays the game must not find their headset at 0.7
// scale for ever with no memory of having chosen it.
//
// The assertion that actually holds that is the one about `saveSettings` — the
// PROPERTY, not a claim about which call sites happen to be careful today.

import { describe, expect, it } from 'vitest'
import {
  applyQualityPins,
  clearMovedPins,
  describeQualityPins,
  hasQualityPin,
  NO_QUALITY_PINS,
  parseAdaptivePin,
  parseMsaaPin,
  parseQualityPin,
  type QualityPins,
} from '@/boot/quality-pin'
import { DEFAULT_SETTINGS, loadSettings, SETTINGS_KEY, saveSettings } from '@/boot/settings'
import { msaaFor, QUALITY } from '@/render/quality'

/** A `Storage` double that records what a save would actually write. */
const fakeStorage = () => {
  const store = new Map<string, string>()
  return {
    store,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v)
    },
  }
}

describe('parsing the pins', () => {
  it('takes every preset and refuses anything else, loudly but harmlessly', () => {
    expect(parseQualityPin('low')).toBe('low')
    expect(parseQualityPin('medium')).toBe('medium')
    expect(parseQualityPin('high')).toBe('high')
    // DEV-581: perf-scale and the same-tick A/B pin ultra by URL.
    expect(parseQualityPin('ultra')).toBe('ultra')
    expect(parseQualityPin(null)).toBeNull()

    // A typo in a URL must not be a black page — `?edition=` and `?mode=` both
    // warn and carry on, and this is the third of the same shape.
    const warnings: string[] = []
    expect(parseQualityPin('extreme', (m) => warnings.push(m))).toBeNull()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('extreme')
  })

  it('reads every spelling of adaptive somebody would type into a headset', () => {
    // The recipe in `perf-protocol.md` §3 is typed by hand, in a headset, into
    // an address bar. A switch that only answers to one spelling is a switch
    // that silently does nothing on the day the row is taken.
    for (const off of ['0', 'off', 'false']) expect(parseAdaptivePin(off)).toBe(false)
    for (const on of ['1', 'on', 'true', '']) expect(parseAdaptivePin(on)).toBe(true)
    expect(parseAdaptivePin(null)).toBeNull()

    const warnings: string[] = []
    expect(parseAdaptivePin('maybe', (m) => warnings.push(m))).toBeNull()
    expect(warnings).toHaveLength(1)
  })
})

describe('the overlay', () => {
  it('returns the SAME object when nothing is pinned', () => {
    // Not a micro-optimisation: `editionState.setSettings` skips on
    // `next === settings`, so a copy on the unpinned path would notify every
    // subscriber on every settings change for no reason.
    expect(applyQualityPins(DEFAULT_SETTINGS, NO_QUALITY_PINS)).toBe(DEFAULT_SETTINGS)
  })

  it('overlays only the fields that are pinned', () => {
    const pinned = applyQualityPins(DEFAULT_SETTINGS, {
      quality: 'low',
      adaptive: null,
      msaa: null,
      hz: null,
    })
    expect(pinned.quality).toBe('low')
    expect(pinned.adaptiveResolution).toBe(DEFAULT_SETTINGS.adaptiveResolution)
    expect(pinned.vignette).toBe(DEFAULT_SETTINGS.vignette)

    const both = applyQualityPins(DEFAULT_SETTINGS, {
      quality: 'medium',
      adaptive: false,
      msaa: null,
      hz: null,
    })
    expect(both.quality).toBe('medium')
    expect(both.adaptiveResolution).toBe(false)
  })

  it('does not mutate the settings it was handed', () => {
    const before = { ...DEFAULT_SETTINGS }
    applyQualityPins(DEFAULT_SETTINGS, { quality: 'low', adaptive: false, msaa: null, hz: null })
    expect(DEFAULT_SETTINGS).toEqual(before)
  })
})

describe('a pin is not a setting', () => {
  it('does not change what saveSettings would write', () => {
    // THE test. `boot/app.ts` keeps `comfort` pristine and overlays the pin
    // only on the way to the renderer and the edition; the menus hold and save
    // `comfort`. So the round trip through storage must be blind to the pin,
    // and that is asserted here against the real `saveSettings`/`loadSettings`
    // rather than against a claim about call sites.
    const storage = fakeStorage()
    const stored = { ...DEFAULT_SETTINGS, quality: 'high' as const, adaptiveResolution: true }
    saveSettings(stored, storage)
    const before = storage.getItem(SETTINGS_KEY)
    expect(before).not.toBeNull()

    // A whole load's worth of pinning, applied everywhere it is applied.
    const pins: QualityPins = { quality: 'low', adaptive: false, msaa: null, hz: null }
    const inForce = applyQualityPins(loadSettings(storage), pins)
    expect(inForce.quality).toBe('low')
    expect(inForce.adaptiveResolution).toBe(false)

    // ...and the player's settings are untouched, byte for byte.
    saveSettings(loadSettings(storage), storage)
    const after = storage.getItem(SETTINGS_KEY)
    expect(after).toBe(before)
    expect(loadSettings(storage).quality).toBe('high')
    expect(loadSettings(storage).adaptiveResolution).toBe(true)
  })

  it('a pinned load reloads as the player left it', () => {
    // The consequence, stated as the thing a player would notice: close the
    // tab, open it without the switch, and the headset is where they put it.
    const storage = fakeStorage()
    saveSettings({ ...DEFAULT_SETTINGS, quality: 'high' }, storage)
    applyQualityPins(loadSettings(storage), {
      quality: 'low',
      adaptive: false,
      msaa: null,
      hz: null,
    })
    expect(loadSettings(storage).quality).toBe('high')
  })
})

describe('a menu change on the pinned row wins', () => {
  it('drops the pin for the field the player moved, and only that one', () => {
    const pins: QualityPins = { quality: 'low', adaptive: false, msaa: null, hz: null }
    const shown = { ...DEFAULT_SETTINGS, quality: 'high' as const, adaptiveResolution: true }

    // The player turns adaptive resolution off in the menu: `adaptive` drops,
    // `quality` does not.
    const movedAdaptive = clearMovedPins(pins, shown, { ...shown, adaptiveResolution: false })
    expect(movedAdaptive.adaptive).toBeNull()
    expect(movedAdaptive.quality).toBe('low')

    const movedQuality = clearMovedPins(pins, shown, { ...shown, quality: 'medium' })
    expect(movedQuality.quality).toBeNull()
    expect(movedQuality.adaptive).toBe(false)
  })

  it('leaves the pins alone when some OTHER row moves', () => {
    // The difference from a literal reading of `?edition=`, and the reason for
    // it: there, ANY settings change quietly returns the pinned field to the
    // stored value. Turning the volume down mid-row must not silently switch
    // the adaptive controller back on and invalidate the measurement.
    const pins: QualityPins = { quality: 'low', adaptive: false, msaa: null, hz: null }
    const shown = { ...DEFAULT_SETTINGS, quality: 'high' as const, adaptiveResolution: true }
    const volume = clearMovedPins(pins, shown, { ...shown, muted: !shown.muted })
    expect(volume).toBe(pins)
  })

  it('is idempotent once a pin has been dropped', () => {
    const dropped: QualityPins = { quality: null, adaptive: null, msaa: null, hz: null }
    const shown = { ...DEFAULT_SETTINGS }
    expect(clearMovedPins(dropped, shown, { ...shown, quality: 'low' })).toBe(dropped)
  })
})

describe('what the console says about it', () => {
  it('says nothing at all when nothing is pinned', () => {
    expect(hasQualityPin(NO_QUALITY_PINS)).toBe(false)
    expect(describeQualityPins(NO_QUALITY_PINS)).toBe('')
  })

  it('names exactly what is pinned', () => {
    // A row filed against a pinned load has to be able to say which pins were
    // in force, and the console line is the record of it.
    expect(describeQualityPins({ quality: 'low', adaptive: false, msaa: null, hz: null })).toBe(
      'quality=low, adaptive=off',
    )
    expect(describeQualityPins({ quality: null, adaptive: true, msaa: null, hz: null })).toBe(
      'adaptive=on',
    )
    expect(hasQualityPin({ quality: null, adaptive: false, msaa: null, hz: null })).toBe(true)
  })
})

// ── DEV-165: multisampling follows the tier, and `?aa=` overrides it ───────
//
// MSAA is a WebGL CONTEXT ATTRIBUTE: read once when the context is built and
// never again. That is why it is a pin and not a setting, why it is not in
// `ComfortSettings`, and why `clearMovedPins` has no row for it — there is no
// menu control that could contradict the URL.

describe('the MSAA pin', () => {
  it('takes 0 and 1 and the spellings a headset address bar produces', () => {
    expect(parseMsaaPin('0')).toBe(false)
    expect(parseMsaaPin('off')).toBe(false)
    expect(parseMsaaPin('false')).toBe(false)
    expect(parseMsaaPin('1')).toBe(true)
    expect(parseMsaaPin('on')).toBe(true)
    // `?aa` with no value is the natural way to type "on".
    expect(parseMsaaPin('')).toBe(true)
    expect(parseMsaaPin(null)).toBe(null)
  })

  it('warns and ignores a typo rather than making the page black', () => {
    const said: string[] = []
    expect(parseMsaaPin('4x', (m) => said.push(m))).toBe(null)
    expect(said).toHaveLength(1)
  })

  it('is carried through a menu change, because no menu row can move it', () => {
    const pins: QualityPins = { quality: 'low', adaptive: false, msaa: false, hz: null }
    const shown = { ...DEFAULT_SETTINGS, quality: 'low' as const, adaptiveResolution: false }
    const next = clearMovedPins(pins, shown, { ...shown, quality: 'high' })
    expect(next.quality).toBe(null)
    expect(next.msaa).toBe(false)
  })

  it('never reaches the settings, so it cannot be saved', () => {
    const storage = fakeStorage()
    const pinned = applyQualityPins(DEFAULT_SETTINGS, {
      quality: null,
      adaptive: null,
      msaa: false,
      hz: null,
    })
    // The whole point: an MSAA pin changes NOTHING about the settings object.
    expect(pinned).toBe(DEFAULT_SETTINGS)
    saveSettings(pinned, storage)
    expect(JSON.parse(storage.store.get(SETTINGS_KEY) as string)).not.toHaveProperty('msaa')
    expect(loadSettings(storage)).toEqual(DEFAULT_SETTINGS)
  })
})

describe('msaaFor — the one place the decision is made', () => {
  it('follows the tier when nothing is pinned', () => {
    expect(msaaFor('low')).toBe(false)
    expect(msaaFor('medium')).toBe(QUALITY.medium.msaa)
    expect(msaaFor('high')).toBe(true)
  })

  it('lets the pin win either way, which is what makes the A/B two loads', () => {
    // `?aa=` exists because there is no way to flip a context attribute on a
    // live context: the two sides of the pair are two page loads.
    expect(msaaFor('high', false)).toBe(false)
    expect(msaaFor('low', true)).toBe(true)
  })

  it('keeps `high` on 4x, so nobody who never opens the menu sees a change', () => {
    // DEV-165 changes what LOW does. `high` is the default tier and its
    // behaviour is exactly what `renderer.ts` shipped before this existed.
    expect(msaaFor(DEFAULT_SETTINGS.quality)).toBe(true)
  })
})
