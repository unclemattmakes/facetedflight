// tests/unit/options-menu.test.ts: the one OPTIONS page, DEV-859.
//
// The UX pass (docs/plan/UX-PASS-2026-10-08.md, decision 1) made OPTIONS one
// page, the same wherever it opens: MUTE, VOLUME, INVERT PITCH and LOOK as rows
// that show their value and change in place, then COMFORT, CONTROLS and MORE.
// Held here: the rows and where each setting moved to, that a press changes
// the setting named by the row and nothing else, that renames are labels only
// (the settings keys are the ones that shipped), and the headset's floor on the
// title plate that now hosts the page.

import { describe, expect, it } from 'vitest'
import { type ComfortSettings, DEFAULT_SETTINGS, parseSettings } from '@/boot/settings'
import { ADVANCED_OPTION } from '@/render/advanced-menu'
import {
  activateSettingRow,
  COMFORT_OPTION,
  COMFORT_ROW_IDS,
  comfortRows,
} from '@/render/comfort-menu'
import { CONTROLS_OPTION } from '@/render/controls-menu'
import { CREDITS_OPTION } from '@/render/credits-menu'
import {
  HUB_PAGE_IDS,
  invertRow,
  lookRow,
  MORE_OPTION,
  moreRows,
  OPTIONS_OPTION,
  optionsRows,
  raceStripRow,
  volumeRow,
} from '@/render/options-menu'
import { PANEL_DISTANCE, rowBand } from '@/render/pause'
import {
  OPTIONS_ROW_ID,
  optionsRow,
  START_ROW,
  TITLE_MENU_DISTANCE,
  TITLE_OPTIONS_ROW_DEG,
  titleMenuScale,
  titleRows,
} from '@/render/title-menu'

const options = (settings: ComfortSettings = DEFAULT_SETTINGS) =>
  optionsRows({ settings, comfort: COMFORT_OPTION, controls: CONTROLS_OPTION })
const more = (settings: ComfortSettings = DEFAULT_SETTINGS) =>
  moreRows({
    settings,
    qualityPin: null,
    presenting: false,
    effects: ADVANCED_OPTION,
    credits: CREDITS_OPTION,
  })

const degrees = (metres: number, distance: number) =>
  (2 * Math.atan(metres / 2 / distance) * 180) / Math.PI

describe('where each setting lives now', () => {
  it('OPTIONS: four values, three doors, BACK', () => {
    const rows = options()
    expect(rows.map((r) => r.id)).toEqual([
      'mute',
      'volume',
      'invert',
      'edition',
      'comfort',
      'controls',
      'more',
      'back',
    ])
    expect(rows.map((r) => r.label)).toEqual([
      'Mute',
      'Volume',
      'Invert pitch',
      'Look',
      'Comfort',
      'Controls',
      'More',
      'Back',
    ])
  })

  it('COMFORT gave up volume and quality, and took speed FX in', () => {
    expect([...COMFORT_ROW_IDS]).toEqual(['vignette', 'horizon', 'speedfx', 'recenter', 'back'])
    expect(comfortRows(DEFAULT_SETTINGS).map((r) => r.id)).toEqual([...COMFORT_ROW_IDS])
  })

  it('MORE: quality, race strip, effects, credits, report bug, back', () => {
    expect(more().map((r) => r.id)).toEqual([
      'quality',
      'racestrip',
      'advanced',
      'credits',
      'reportbug',
      'back',
    ])
    // ADVANCED is EFFECTS on the plate; the id (and its settings) are unchanged.
    expect(more().find((r) => r.id === 'advanced')?.label).toBe('Effects')
  })

  it('every setting is reachable from exactly one page of OPTIONS', () => {
    const ids = [
      ...options().map((r) => r.id),
      ...comfortRows(DEFAULT_SETTINGS).map((r) => r.id),
      ...more().map((r) => r.id),
    ]
    for (const id of ['mute', 'volume', 'invert', 'edition', 'speedfx', 'quality', 'racestrip']) {
      expect(
        ids.filter((x) => x === id),
        id,
      ).toHaveLength(1)
    }
  })

  it('the hub pages are the ones the app acts on by id', () => {
    expect(HUB_PAGE_IDS.has(OPTIONS_OPTION.id)).toBe(true)
    expect(HUB_PAGE_IDS.has(MORE_OPTION.id)).toBe(true)
    expect(HUB_PAGE_IDS.has('comfort')).toBe(false)
  })

  it('is no taller than the 4.00-degree floor the pause plate holds', () => {
    expect(options().length).toBe(8)
    expect(degrees(rowBand(options().length), PANEL_DISTANCE)).toBeGreaterThanOrEqual(3.99)
  })
})

describe('the rows show their value, and say what a press will do', () => {
  it('VOLUME shows the level, or muted with the way back', () => {
    expect(volumeRow({ ...DEFAULT_SETTINGS, volume: 'mid', muted: false }).value).toBe('mid')
    const muted = volumeRow({ ...DEFAULT_SETTINGS, volume: 'mid', muted: true })
    expect(muted.value).toBe('muted')
    expect(muted.note).toContain('mid')
  })

  it('INVERT PITCH says which way climbs', () => {
    expect(invertRow({ ...DEFAULT_SETTINGS, invertPitch: false })).toMatchObject({
      value: 'off',
      note: expect.stringContaining('pull'),
    })
    expect(invertRow({ ...DEFAULT_SETTINGS, invertPitch: true })).toMatchObject({
      value: 'on',
      note: expect.stringContaining('forward'),
    })
  })

  it('LOOK names the edition and says it is a look, not a rule set', () => {
    expect(lookRow({ ...DEFAULT_SETTINGS, edition: 'classic' }).value).toBe('classic')
    expect(lookRow({ ...DEFAULT_SETTINGS, edition: 'classic' }).note).toContain('2016')
    expect(lookRow({ ...DEFAULT_SETTINGS, edition: 'anniversary' }).value).toBe('anniversary')
    expect(lookRow(DEFAULT_SETTINGS).id).toBe('edition')
  })

  it('RACE STRIP says on or off', () => {
    expect(raceStripRow(DEFAULT_SETTINGS).value).toBe('on')
    expect(raceStripRow({ ...DEFAULT_SETTINGS, raceStrip: false }).value).toBe('off')
  })
})

describe('a press changes the setting the row names, and nothing else', () => {
  const only = (before: ComfortSettings, after: ComfortSettings, key: keyof ComfortSettings) => {
    for (const k of Object.keys(before) as (keyof ComfortSettings)[]) {
      if (k === key || (key === 'edition' && k === 'editionAuto')) continue
      expect(after[k], `changed ${k}`).toEqual(before[k])
    }
  }

  it.each([
    ['mute', 'muted'],
    ['invert', 'invertPitch'],
    ['edition', 'edition'],
    ['volume', 'volume'],
    ['racestrip', 'raceStrip'],
  ] as const)('%s moves %s', (id, key) => {
    const after = activateSettingRow(DEFAULT_SETTINGS, id)
    expect(after).not.toBeNull()
    expect(after?.[key]).not.toEqual(DEFAULT_SETTINGS[key])
    only(DEFAULT_SETTINGS, after as ComfortSettings, key)
  })

  it('quality steps the ladder (MORE keeps the rule it had on COMFORT)', () => {
    const after = activateSettingRow(DEFAULT_SETTINGS, 'quality', false)
    expect(after?.quality ?? after?.qualityAuto).toBeDefined()
    expect(after).not.toEqual(DEFAULT_SETTINGS)
  })

  it('a muted VOLUME press unmutes and leaves the level alone', () => {
    const muted = { ...DEFAULT_SETTINGS, volume: 'mid' as const, muted: true }
    const after = activateSettingRow(muted, 'volume')
    expect(after?.muted).toBe(false)
    expect(after?.volume).toBe('mid')
  })

  it('returns null for a door, BACK or anything else, so the caller falls through', () => {
    for (const id of ['comfort', 'controls', 'more', 'back', 'advanced', 'resume', 'nope']) {
      expect(activateSettingRow(DEFAULT_SETTINGS, id), id).toBeNull()
    }
  })
})

describe('renames are labels only', () => {
  it('the stored keys are the ones that shipped, and the defaults are unchanged', () => {
    // A save from before this change loads whole, with its LOOK, its volume and
    // its race strip where they were.
    const stored = parseSettings({
      edition: 'classic',
      volume: 'low',
      invertPitch: true,
      speedFx: 'full',
      raceStrip: false,
      quality: 'low',
      qualityAuto: false,
    })
    expect(stored).toMatchObject({
      edition: 'classic',
      volume: 'low',
      invertPitch: true,
      speedFx: 'full',
      raceStrip: false,
      quality: 'low',
      qualityAuto: false,
    })
    expect(DEFAULT_SETTINGS).toMatchObject({
      edition: 'anniversary',
      volume: 'full',
      invertPitch: false,
      speedFx: 'light',
      raceStrip: true,
      muted: false,
    })
  })
})

describe('the title opens the same page', () => {
  it('has an OPTIONS row under START, with no note', () => {
    const rows = titleRows({
      vr: null,
      link: null,
      start: null,
      options: optionsRow(),
    })
    expect(rows.map((r) => r.id)).toEqual([START_ROW.id, OPTIONS_ROW_ID])
    expect(optionsRow().note).toBe('')
    // The title's row opens the page the pause plate's row opens.
    expect(OPTIONS_ROW_ID).toBe(OPTIONS_OPTION.id)
  })

  it('keeps the 4.00-degree floor in a headset, and the flat frame as it was', () => {
    const rows = options().length
    // Headset: grown to hold the floor (the head can look down).
    const vr = titleMenuScale(rows, false, TITLE_OPTIONS_ROW_DEG)
    expect(degrees(rowBand(rows) * vr, TITLE_MENU_DISTANCE)).toBeGreaterThanOrEqual(3.99)
    // Flat: the plate's own fit, whatever the floor says.
    expect(titleMenuScale(rows, true, TITLE_OPTIONS_ROW_DEG)).toBe(titleMenuScale(rows, true))
    // And without a floor nothing changes for any row count the title had.
    for (const n of [1, 2, 3, 4]) {
      expect(titleMenuScale(n, false, null)).toBe(titleMenuScale(n, false))
    }
  })
})
