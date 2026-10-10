// tests/unit/comfort-settings.test.ts — the settings survive the reload, and
// nothing about them can take the app down.
//
// The claim this file is allowed to make is narrow and worth stating up front,
// because the surrounding feature is one nothing can test. `docs/vr-testing.md`,
// "Known gaps, honestly": *"Nothing here tests comfort. By construction."* No
// assertion below says the vignette helps. What they say is that the number the
// player chose is the number that comes back after a reload, and that a browser
// which refuses storage degrades to the defaults instead of throwing before the
// first frame — which is the failure `game/personal-best.ts` was written around
// and the one that turns a comfort feature into a black page.

import { describe, expect, it } from 'vitest'
import {
  type ComfortSettings,
  DEFAULT_SETTINGS,
  loadSettings,
  nextQuality,
  nextVignette,
  parseSettings,
  SETTINGS_KEY,
  saveSettings,
} from '@/boot/settings'

/** A `localStorage` stand-in, with the map visible so a test can corrupt it. */
const memoryStore = () => {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v)
    },
  }
}

/**
 * The case that matters and the one a jsdom mock never reproduces by accident:
 * a private window with site data blocked, where touching storage THROWS.
 */
const throwingStore = () => ({
  getItem: (): string | null => {
    throw new DOMException('blocked', 'SecurityError')
  },
  setItem: (): void => {
    throw new DOMException('blocked', 'SecurityError')
  },
})

describe('comfort settings — the defaults', () => {
  it('defaults the vignette to LIGHT, which is the only one the plan names', () => {
    // PORT_PLAN §2.9: "Three settings — off / light / strong — default light."
    // Pinned rather than assumed, because it is the one comfort default a
    // stranger with a headset and a link gets without touching a menu, and the
    // difference between `light` and `off` is the entire mitigation for R12.
    expect(DEFAULT_SETTINGS.vignette).toBe('light')
  })

  it('defaults the horizon OFF, as §2.9 asks', () => {
    // "Off by default, discoverable in the comfort menu." A level ring across
    // the middle of the view is a strong aid for the people who need it and a
    // strange floating hoop for everyone else.
    expect(DEFAULT_SETTINGS.horizon).toBe(false)
  })

  it('defaults to the frame being protected', () => {
    // R12: "a dropped frame during a fast roll is nauseogenic in a way it was
    // not on a tethered Rift." So resolution is the thing that gives.
    expect(DEFAULT_SETTINGS.adaptiveResolution).toBe(true)
    expect(DEFAULT_SETTINGS.foveation).toBe(true)
  })
})

describe('comfort settings — persistence', () => {
  it('comes back after a reload', () => {
    // The whole feature in one assertion. A setting that resets every load is
    // not a setting, it is a thing you re-find every time you put the headset
    // on — at the moment you are least able to operate a menu.
    const store = memoryStore()
    const chosen: ComfortSettings = {
      vignette: 'strong',
      horizon: true,
      quality: 'low',
      // DEV-334: a player who picked Low picked it, so AUTO is off.
      qualityAuto: false,
      adaptiveResolution: false,
      foveation: false,
      volume: 'low',
      muted: true,
      invertPitch: true,
      // DEV-637: a non-default, so the round trip proves the field is stored.
      haptics: false,
      edition: 'classic',
      // DEV-896: a player who picked Classic picked it, so AUTO is off.
      editionAuto: false,
      speedFx: 'off',
      cameraView: 'third',
      // DEV-649: the one boolean whose default is ON, so a stored OFF is a choice.
      raceStrip: false,
      // DEV-269: nothing forced either way.
      featureOverrides: {},
    }
    expect(saveSettings(chosen, store)).toBe(true)
    // A SECOND process, reading the same bytes. `loadSettings` is given the
    // store rather than sharing any state with the save above.
    expect(loadSettings(store)).toEqual(chosen)
  })

  it('writes under a namespaced, versioned key', () => {
    // Same discipline as `bestKey`: the escape hatch for a meaning change is a
    // key nobody reads, not a migration nobody writes.
    const store = memoryStore()
    saveSettings(DEFAULT_SETTINGS, store)
    expect([...store.map.keys()]).toEqual([SETTINGS_KEY])
    expect(SETTINGS_KEY).toMatch(/\.v\d+$/)
  })

  it('returns the defaults when nothing has ever been stored', () => {
    expect(loadSettings(memoryStore())).toEqual(DEFAULT_SETTINGS)
  })
})

describe('comfort settings — storage that is not there', () => {
  it('does not throw when there is no storage at all', () => {
    // `safeStorage()` returns null in a context where the property access
    // itself throws. A caller must not have to know that.
    expect(() => loadSettings(null)).not.toThrow()
    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(saveSettings(DEFAULT_SETTINGS, null)).toBe(false)
  })

  it('does not throw when storage THROWS on every call', () => {
    const store = throwingStore()
    expect(() => loadSettings(store)).not.toThrow()
    expect(loadSettings(store)).toEqual(DEFAULT_SETTINGS)
    // Reports the failure rather than pretending. The menu can say so; the
    // live setting has already changed either way.
    expect(saveSettings(DEFAULT_SETTINGS, store)).toBe(false)
  })

  it('survives a key that is not JSON at all', () => {
    const store = memoryStore()
    store.map.set(SETTINGS_KEY, 'not json {{{')
    expect(loadSettings(store)).toEqual(DEFAULT_SETTINGS)
  })
})

describe('comfort settings — a hand-edited key', () => {
  // The key is visible in devtools on a public URL and someone will edit it.

  it('keeps the GOOD fields when one field is nonsense', () => {
    // The reason validation is per-field. A whole-object check throws away a
    // deliberately chosen `vignette: strong` because `quality` got typed as
    // `extreme`, silently un-setting the one field the player cares about.
    // (It said `ultra` until DEV-581 made that a real tier.)
    const store = memoryStore()
    store.map.set(
      SETTINGS_KEY,
      JSON.stringify({ vignette: 'strong', quality: 'extreme', horizon: true }),
    )
    const loaded = loadSettings(store)
    expect(loaded.vignette).toBe('strong')
    expect(loaded.horizon).toBe(true)
    expect(loaded.quality).toBe(DEFAULT_SETTINGS.quality)
  })

  it('does not read the STRING "false" as ON', () => {
    // `Boolean('false')` is true, and this is the one wrong answer that also
    // looks like a feature: the horizon appears, the player did not ask for it,
    // and nothing in the menu explains why. `personal-best.ts` rejects
    // coercion for the same reason on `gates`.
    expect(parseSettings({ horizon: 'false' }).horizon).toBe(DEFAULT_SETTINGS.horizon)
    expect(parseSettings({ horizon: 1 }).horizon).toBe(DEFAULT_SETTINGS.horizon)
    expect(parseSettings({ horizon: true }).horizon).toBe(true)
  })

  it('survives a stored value that is not an object', () => {
    for (const raw of [null, 42, 'light', [], true]) {
      expect(parseSettings(raw)).toEqual(DEFAULT_SETTINGS)
    }
  })
})

describe('comfort settings — the cycle', () => {
  it('walks the vignette off → light → strong → off', () => {
    // Three settings, not a boolean, and A moves FORWARD through them. The
    // order matters: a player reaching for the menu mid-flight is reaching for
    // MORE vignette, and one press from `light` must get it.
    expect(nextVignette('off')).toBe('light')
    expect(nextVignette('light')).toBe('strong')
    expect(nextVignette('strong')).toBe('off')
  })

  it('walks the quality low → medium → high → ultra → low', () => {
    // The whole ladder (DEV-581). The MENU's walk is `nextQualityChoice`,
    // which also knows Auto and that a headset is not offered ultra.
    expect(nextQuality('low')).toBe('medium')
    expect(nextQuality('medium')).toBe('high')
    expect(nextQuality('high')).toBe('ultra')
    expect(nextQuality('ultra')).toBe('low')
  })

  it('reaches every value from every value in at most three presses', () => {
    // The property, rather than three examples of it: no value may be a dead
    // end, or a row stops being a control.
    for (const start of ['off', 'light', 'strong'] as const) {
      const seen = new Set<string>()
      let v = start
      for (let i = 0; i < 3; i++) {
        v = nextVignette(v)
        seen.add(v)
      }
      expect(seen).toEqual(new Set(['off', 'light', 'strong']))
    }
  })
})
