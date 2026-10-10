// tests/unit/comfort-audio.test.ts — the volume the player chose is the volume
// the mix gets, it is still there tomorrow, and mute is one press.
//
// Same bargain as `comfort-settings.test.ts`: nothing here can say whether the
// game is too loud. That is a question for a person in a headset. What these can say is that the ladder is
// the ladder its own header claims — in decibels, derived rather than restated —
// that the round trip through storage survives a reload, and that `?audio=off`
// and the setting compose in exactly one direction.
//
// **The mapping is checked against dB and not against itself.** A test that
// asserted `VOLUME_GAIN.high === 0.5` would agree with any ladder anyone typed.
// `gainToDb` is the independent quantity — `20 * log10(g)`, which knows nothing
// about this feature — and the claim being checked is the one in the header: a
// step is **−6.02 dB**, so the steps are equal in LOUDNESS and not in amplitude.

import { describe, expect, it } from 'vitest'
import { createAudioSystem } from '@/audio'
import { createRecordingBackend, createSilentBackend } from '@/audio/backend'
import { gainToDb, MASTER_MUSIC } from '@/audio/mix'
import {
  masterGainFor,
  musicGainFor,
  VOLUME_GAIN,
  VOLUME_STEP_DB,
  VOLUME_STEPS,
  type VolumeSetting,
} from '@/audio/volume'
import {
  type ComfortSettings,
  DEFAULT_SETTINGS,
  loadSettings,
  nextVolume,
  parseSettings,
  SETTINGS_KEY,
  saveSettings,
} from '@/boot/settings'
import {
  activateSettingRow,
  COMFORT_ROW_IDS,
  createComfortMenu,
  muteOption,
} from '@/render/comfort-menu'
import { volumeRow } from '@/render/options-menu'

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

/** DEV-859: the volume press, which lives on OPTIONS now. */
const pressVolume = (s: ComfortSettings): ComfortSettings =>
  activateSettingRow(s, 'volume') as ComfortSettings
/** Successive differences of a ladder of linear gains, in dB. */
const stepsDb = (gains: readonly number[]): number[] => {
  const db = gains.map(gainToDb)
  const out: number[] = []
  for (let i = 1; i < db.length; i++) {
    const previous = db[i - 1]
    const current = db[i]
    if (previous === undefined || current === undefined) continue
    out.push(current - previous)
  }
  return out
}
/** How far the worst step of a ladder is from the nominal 6.02 dB. */
const worstStepError = (gains: readonly number[]): number =>
  Math.max(...stepsDb(gains).map((d) => Math.abs(d - VOLUME_STEP_DB)))
const LADDER = VOLUME_STEPS.map((v) => VOLUME_GAIN[v])
const at = (volume: VolumeSetting, muted = false): ComfortSettings => ({
  ...DEFAULT_SETTINGS,
  volume,
  muted,
})

describe('the gain ladder, in decibels', () => {
  it('puts FULL at unity, which is the 2016 authored product', () => {
    // `cueGain` already carries `_masterAudioVolume` (0.75) into every
    // `CueSpec.gain`, so the master node is the PLAYER's number and 1.0 means
    // "do not attenuate what the prefabs said". It was 0.75 here as well until
    // this landed, which applied the 2016 master twice and played the whole
    // game 2.5 dB under its own level.
    expect(VOLUME_GAIN.full).toBe(1)
    expect(gainToDb(VOLUME_GAIN.full)).toBe(0)
  })

  it('steps down by 6.02 dB, which is what equal LOUDNESS steps means', () => {
    // The header's claim, checked against the only thing that can check it: a
    // logarithm. A linear ladder would fail this and sound wrong in exactly the
    // way a linear slider sounds wrong — 0.5 is not half as loud.
    const steps = stepsDb(LADDER)
    expect(steps).toHaveLength(VOLUME_STEPS.length - 1)
    for (const [i, step] of steps.entries()) {
      expect(step, `step ${VOLUME_STEPS[i]} -> ${VOLUME_STEPS[i + 1]}`).toBeCloseTo(
        VOLUME_STEP_DB,
        2,
      )
    }
    // The absolute figures the header prints, so a re-ordering cannot quietly
    // keep the differences right while moving where the ladder sits.
    expect(gainToDb(VOLUME_GAIN.high)).toBeCloseTo(-6.02, 2)
    expect(gainToDb(VOLUME_GAIN.mid)).toBeCloseTo(-12.04, 2)
    expect(gainToDb(VOLUME_GAIN.low)).toBeCloseTo(-18.06, 2)
  })

  it('is a ladder a LINEAR one would fail', () => {
    // The discriminating case, which is the whole point of writing the test at
    // all: the obvious wrong implementation is four evenly spaced fractions.
    // Assert the two disagree, or this file is only checking that arithmetic
    // works. (CLAUDE.md: "what case makes my rule and the alternative
    // disagree?")
    expect(worstStepError(LADDER)).toBeLessThan(0.01)
    expect(worstStepError([1, 0.75, 0.5, 0.25])).toBeGreaterThan(1)
  })

  it('never reaches zero on the ladder itself — silence is the MUTE field', () => {
    // Why mute is a separate boolean at all: an `off` rung would be four
    // presses from `full` at the moment somebody most needs it to be one.
    for (const v of VOLUME_STEPS) {
      expect(VOLUME_GAIN[v], v).toBeGreaterThan(0)
      expect(VOLUME_GAIN[v], v).toBeLessThanOrEqual(1)
    }
    expect(VOLUME_STEPS).toHaveLength(4)
  })

  it('mutes to a true zero, and mute beats the level', () => {
    for (const v of VOLUME_STEPS) {
      expect(masterGainFor(at(v, true)), v).toBe(0)
      expect(masterGainFor(at(v, false)), v).toBe(VOLUME_GAIN[v])
    }
    expect(gainToDb(0)).toBe(-Infinity)
  })

  it('scales the MUSIC by the same ladder, keeping 2016’s balance', () => {
    // There are no tracks yet (D31) and that is exactly why this is pinned now:
    // "mute did not mute the music" is a bug nobody would go looking for, in
    // the one part of the mix that plays continuously.
    expect(musicGainFor(at('full'))).toBeCloseTo(MASTER_MUSIC, 12)
    expect(musicGainFor(at('mid'))).toBeCloseTo(0.25 * MASTER_MUSIC, 12)
    expect(musicGainFor(at('full', true))).toBe(0)
  })
})

describe('the volume row, pressed', () => {
  it('walks QUIETER, and reaches every step in four presses', () => {
    // Direction is a decision, not a detail: a player who opens a menu looking
    // for the volume is nearly always reaching for quieter. Same argument the
    // vignette makes for going `off -> light -> strong`.
    expect(nextVolume('full')).toBe('high')
    expect(nextVolume('high')).toBe('mid')
    expect(nextVolume('mid')).toBe('low')
    expect(nextVolume('low')).toBe('full')

    let v: VolumeSetting = 'full'
    const seen = new Set<VolumeSetting>()
    for (let i = 0; i < 4; i++) {
      v = nextVolume(v)
      seen.add(v)
    }
    expect(seen).toEqual(new Set(VOLUME_STEPS))
  })

  it('gets QUIETER on the first press, measured in dB rather than in names', () => {
    const before = masterGainFor(DEFAULT_SETTINGS)
    const after = masterGainFor(pressVolume(DEFAULT_SETTINGS))
    expect(gainToDb(after) - gainToDb(before)).toBeCloseTo(VOLUME_STEP_DB, 2)
  })

  it('UNMUTES on the press and leaves the level where it was', () => {
    // The dead-control bug: a volume row that walks the ladder while the output
    // is zero gives no feedback at all, so you press it three times, hear
    // nothing each time, and conclude the game is broken.
    const muted = at('mid', true)
    const after = pressVolume(muted)
    expect(after.muted).toBe(false)
    expect(after.volume).toBe('mid')
    expect(masterGainFor(after)).toBe(VOLUME_GAIN.mid)
  })

  it('changes nothing else', () => {
    const after = pressVolume(DEFAULT_SETTINGS)
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof ComfortSettings)[]) {
      if (key === 'volume') continue
      expect(after[key], `volume changed ${key}`).toBe(DEFAULT_SETTINGS[key])
    }
  })

  it('shows the truth, including while muted', () => {
    // A row that says `mid` while the game is silent is a row that lies, and
    // the person reading it is the person who cannot hear anything.
    const row = (s: ComfortSettings) => volumeRow(s)
    expect(row(at('high'))?.value).toBe('high')
    expect(row(at('high', true))?.value).toBe('muted')
    expect(row(at('high', true))?.note).toContain('high')
    // Never a percentage: 0.5 is −6 dB, so "50 %" is an amplitude pretending to
    // be a loudness — the exact confusion `audio/volume.ts` exists to avoid.
    for (const v of VOLUME_STEPS) expect(row(at(v))?.value).not.toMatch(/%/)
  })
})

describe('mute is one press', () => {
  it('is a row on the PAUSE PLATE and not a rung of the ladder', () => {
    // Pinned so that moving it onto the comfort page — where it would be two
    // presses and a page deeper, and would make that page nine rows at 3.6
    // degrees each — fails a test with the reason attached rather than looking
    // like tidying up.
    expect([...COMFORT_ROW_IDS]).not.toContain('mute')
    expect(muteOption(DEFAULT_SETTINGS).id).toBe('mute')
  })

  it('says which way it is set, because a blind toggle is an experiment', () => {
    expect(muteOption(at('full', false)).value).toBe('off')
    expect(muteOption(at('full', true)).value).toBe('on')
    expect(muteOption(at('full', true)).note).not.toEqual(muteOption(at('full', false)).note)
  })

  it('silences from ANY level in exactly one press, and gives the level back', () => {
    for (const v of VOLUME_STEPS) {
      const store = memoryStore()
      const menu = createComfortMenu({ settings: at(v), onChange: () => {}, storage: store })
      menu.toggleMute()
      expect(masterGainFor(menu.settings), v).toBe(0)
      // And back, at the level you were on. This is the reason mute is its own
      // field rather than an `off` at the bottom of the ladder: the ladder
      // cannot remember where you were.
      menu.toggleMute()
      expect(menu.settings.volume, v).toBe(v)
      expect(masterGainFor(menu.settings), v).toBe(VOLUME_GAIN[v])
    }
  })

  it('persists and announces down the same one path every other row uses', () => {
    const store = memoryStore()
    const seen: ComfortSettings[] = []
    const menu = createComfortMenu({
      settings: DEFAULT_SETTINGS,
      onChange: (s) => seen.push(s),
      storage: store,
    })
    menu.toggleMute()
    expect(seen).toHaveLength(1)
    expect(seen[0]?.muted).toBe(true)
    // The reload, from the same bytes, with no shared state. Someone who mutes
    // at 2 a.m. and takes the headset off has muted it, not muted it for now.
    expect(loadSettings(store).muted).toBe(true)
  })

  it('still flips when storage is blocked', () => {
    const menu = createComfortMenu({
      settings: DEFAULT_SETTINGS,
      onChange: () => {},
      storage: null,
    })
    expect(() => menu.toggleMute()).not.toThrow()
    expect(masterGainFor(menu.settings)).toBe(0)
  })
})

describe('the round trip: set, persist, reload, apply', () => {
  it('hands the mix the number the player chose, after a reload', () => {
    // The whole feature in one test. A volume that resets every load is not a
    // volume control, and the number has to reach the MIX and not just the
    // menu — so it ends at a backend call, not at a settings object.
    const store = memoryStore()
    const menu = createComfortMenu({
      settings: DEFAULT_SETTINGS,
      onChange: () => {},
      storage: store,
    })
    menu.pressSetting('volume') // full -> high
    menu.pressSetting('volume') // high -> mid

    const reloaded = loadSettings(store)
    expect(reloaded.volume).toBe('mid')

    const backend = createRecordingBackend()
    const system = createAudioSystem({ backend })
    system.setMasterGain(masterGainFor(reloaded))
    expect(backend.calls.filter((c) => c.call === 'master').map((c) => c.gain)).toEqual([0.25])
  })

  it('applies BEFORE the first sound, with no AudioContext in sight', () => {
    // The ordering `app.ts` depends on: `setMasterGain` is called the moment
    // the system is built, long before a gesture makes a context. A volume
    // applied after the first cue is a volume the player hears the game ignore
    // — and the first cue is the lift, which is now eight positional whooshes.
    const backend = createRecordingBackend()
    const system = createAudioSystem({ backend })
    system.setMasterGain(masterGainFor(at('low')))
    expect(system.running).toBe(false)
    expect(backend.calls[0]).toEqual({ call: 'master', gain: 0.125 })
    system.event({ type: 'ui.confirm' })
    expect(backend.calls.findIndex((c) => c.call === 'play')).toBeGreaterThan(0)
  })

  it('defaults a key stored before this feature existed, and keeps the rest', () => {
    // `SETTINGS_KEY` is deliberately NOT bumped for an added field: bumping
    // would throw away a deliberately chosen vignette in order to introduce a
    // volume control, which is the trade per-field validation exists to refuse.
    const store = memoryStore()
    store.map.set(
      SETTINGS_KEY,
      JSON.stringify({ vignette: 'strong', horizon: true, quality: 'low' }),
    )
    const loaded = loadSettings(store)
    expect(loaded.vignette).toBe('strong')
    expect(loaded.volume).toBe('full')
    expect(loaded.muted).toBe(false)
    expect(masterGainFor(loaded)).toBe(1)
  })

  it('refuses a hand-edited key without losing the good fields', () => {
    // The key is visible in devtools on a public URL and someone will edit it.
    // `"muted": "true"` is the one that matters: a truthy string coerced to ON
    // is a game with no sound and nothing in the menu to explain why.
    expect(parseSettings({ volume: 'ULTRA', vignette: 'strong' }).volume).toBe('full')
    expect(parseSettings({ volume: 'ULTRA', vignette: 'strong' }).vignette).toBe('strong')
    expect(parseSettings({ muted: 'true' }).muted).toBe(false)
    expect(parseSettings({ muted: 1 }).muted).toBe(false)
    expect(parseSettings({ muted: true }).muted).toBe(true)
  })

  it('round-trips a muted, quiet setting exactly', () => {
    const store = memoryStore()
    const chosen = at('low', true)
    expect(saveSettings(chosen, store)).toBe(true)
    expect(loadSettings(store)).toEqual(chosen)
  })
})

describe('?audio=off and the setting', () => {
  it('is the SWITCH that wins, and it wins at the backend', () => {
    // `app.ts` gives `?audio=off` `createSilentBackend()`, which has no
    // `AudioContext` to gain-stage — so no menu press can bring sound back, and
    // a screenshot spec that must not start an audio device really does not.
    const system = createAudioSystem({ backend: createSilentBackend() })
    system.setMasterGain(masterGainFor(at('full')))
    system.setMusicGain(musicGainFor(at('full')))
    system.event({ type: 'ui.confirm' })
    system.stepFlight({ speed: 300, throttle: 1, boost: true, released: true })
    expect(system.running).toBe(false)
  })

  it('is the same call that DOES reach a real mix, so the switch is the only difference', () => {
    // The discriminating half: the identical sequence against a backend that
    // records shows the setting is not quietly being dropped somewhere else.
    const backend = createRecordingBackend()
    const system = createAudioSystem({ backend })
    system.setMasterGain(masterGainFor(at('full')))
    system.event({ type: 'ui.confirm' })
    expect(backend.calls.some((c) => c.call === 'master' && c.gain === 1)).toBe(true)
    expect(backend.calls.some((c) => c.call === 'play')).toBe(true)
  })

  it('never writes the stored volume — the switch is per load, the setting is the player’s', () => {
    // `?audio=off` is a URL somebody else's spec put there. It must not be able
    // to leave the player muted on the next load without it, and the only way
    // to be sure is that nothing on that path touches storage.
    const store = memoryStore()
    saveSettings(at('high'), store)
    const system = createAudioSystem({ backend: createSilentBackend() })
    system.setMasterGain(0)
    system.stopAll()
    system.dispose()
    expect(loadSettings(store).volume).toBe('high')
    expect(loadSettings(store).muted).toBe(false)
  })
})
