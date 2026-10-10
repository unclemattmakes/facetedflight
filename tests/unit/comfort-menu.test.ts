// tests/unit/comfort-menu.test.ts — every comfort setting is reachable from
// inside the headset, and the change survives the reload.
//
// This is the file that stands behind the sentence in `render/comfort-menu.ts`:
// **a comfort setting you cannot change in the headset is not a comfort
// setting.** Nothing here can show the vignette helps (`docs/vr-testing.md`:
// *"Nothing here tests comfort. By construction."*) — what it can show is that
// the person who needs it can get to it with a head and one button, and that
// what they chose is still there next time.

import { describe, expect, it } from 'vitest'
import { type ComfortSettings, DEFAULT_SETTINGS, loadSettings, SETTINGS_KEY } from '@/boot/settings'
import {
  activateComfortRow,
  activateSettingRow,
  COMFORT_OPTION,
  COMFORT_ROW_IDS,
  COMFORT_TITLE,
  comfortRows,
  createComfortMenu,
} from '@/render/comfort-menu'
import { pickLocal, rowCentreLocalY } from '@/render/pause'

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

const indexOf = (id: (typeof COMFORT_ROW_IDS)[number]) => COMFORT_ROW_IDS.indexOf(id)

describe('the comfort page', () => {
  it('offers a row for every setting, plus recentre and back', () => {
    // PORT_PLAN §2.9 item 5: "a comfort menu, reachable from pause, with all of
    // the above plus the existing recenter." "All of the above" is items 1-4,
    // and this is the assertion that none of them quietly failed to get a row.
    const rows = comfortRows(DEFAULT_SETTINGS)
    expect(rows.map((r) => r.id)).toEqual([...COMFORT_ROW_IDS])
    // Eight since the volume row landed; six since DEV-838 moved Auto quality
    // and Foveation to the Advanced page; five since DEV-859 moved VOLUME up to
    // OPTIONS and QUALITY into MORE and brought SPEED FX in from EDITION.
    expect(rows).toHaveLength(5)
  })

  it('shows the CURRENT value of every setting row', () => {
    // A settings menu that does not say what the setting currently is turns
    // every press into an experiment. In a headset, with the run frozen, that
    // is how someone ends up cycling a setting three times to find out where
    // they started.
    const rows = comfortRows({
      vignette: 'strong',
      horizon: true,
      quality: 'low',
      adaptiveResolution: false,
      foveation: false,
      volume: 'mid',
      invertPitch: false,
      haptics: true,
      muted: false,
      edition: 'classic',
      speedFx: 'light',
      cameraView: 'first',
      raceStrip: true,
      // DEV-269: nothing forced either way.
      featureOverrides: {},
    })
    const value = (id: string) => rows.find((r) => r.id === id)?.value
    expect(value('vignette')).toBe('strong')
    expect(value('horizon')).toBe('on')
    expect(value('speedfx')).toBe('light')
    // DEV-859: volume and quality live on OPTIONS and MORE now.
    expect(value('volume')).toBeUndefined()
    expect(value('quality')).toBeUndefined()
    // DEV-838: these two live on the Advanced page now.
    expect(value('adaptive')).toBeUndefined()
    expect(value('foveation')).toBeUndefined()
    // Actions have no value, and must not render an empty column.
    expect(value('recenter')).toBeUndefined()
    expect(value('back')).toBeUndefined()
  })

  it('is announced on the pause menu by a row of its own', () => {
    expect(COMFORT_OPTION.id).toBe('comfort')
    expect(COMFORT_TITLE).toContain('COMFORT')
  })
})

describe('pressing A on a row', () => {
  it('reaches every value of every setting', () => {
    // The property the whole feature rests on. Three vignette settings exist
    // because "tolerance varies enormously between people" — and a third
    // setting you cannot reach is two settings.
    let s = DEFAULT_SETTINGS
    const seen = new Set<string>([s.vignette])
    for (let i = 0; i < 3; i++) {
      s = activateComfortRow(s, indexOf('vignette')).settings
      seen.add(s.vignette)
    }
    expect(seen).toEqual(new Set(['off', 'light', 'strong']))

    // DEV-859: SPEED FX came in from the old EDITION page.
    let f = DEFAULT_SETTINGS
    const fx = new Set<string>([f.speedFx])
    for (let i = 0; i < 4; i++) {
      f = activateComfortRow(f, indexOf('speedfx')).settings
      fx.add(f.speedFx)
    }
    expect(fx).toEqual(new Set(['off', 'light', 'full']))

    // And the quality ladder is MORE's row now, pressed through `pressSetting`.
    let q = DEFAULT_SETTINGS
    const quals = new Set<string>([q.quality])
    for (let i = 0; i < 3; i++) {
      q = activateSettingRow(q, 'quality') ?? q
      quals.add(q.quality)
    }
    expect(quals).toEqual(new Set(['low', 'medium', 'high']))
  })

  it('toggles each boolean and leaves the others alone', () => {
    // The bug this catches is a copy-pasted case arm writing the wrong field —
    // pressing FOVEATION and watching HORIZON come on. Invisible to a test that
    // only checks the field it pressed.
    for (const [id, key] of [['horizon', 'horizon']] as const) {
      const after = activateComfortRow(DEFAULT_SETTINGS, indexOf(id)).settings
      expect(after[key]).toBe(!DEFAULT_SETTINGS[key])
      for (const other of Object.keys(DEFAULT_SETTINGS) as (keyof ComfortSettings)[]) {
        if (other === key) continue
        expect(after[other], `${id} changed ${other}`).toBe(DEFAULT_SETTINGS[other])
      }
    }
  })

  it('hands the two ACTIONS back to the caller instead of pretending', () => {
    // Recentring needs the live `XRFrame` (`render/xr-recenter.ts` must be
    // called from inside the frame callback), and leaving the page is the
    // caller's own menu state. Neither belongs in a pure model.
    expect(activateComfortRow(DEFAULT_SETTINGS, indexOf('recenter')).action).toBe('recenter')
    expect(activateComfortRow(DEFAULT_SETTINGS, indexOf('back')).action).toBe('back')
    expect(activateComfortRow(DEFAULT_SETTINGS, indexOf('recenter')).changed).toBe(false)
  })

  it('does nothing at all when you are looking at nothing', () => {
    // `pause.pick` returns −1 for the title band, and `app.ts` can be holding a
    // selection of −1. A menu that throws when you press A while looking at its
    // own heading is worse than one that does nothing.
    for (const i of [-1, COMFORT_ROW_IDS.length, 99]) {
      const result = activateComfortRow(DEFAULT_SETTINGS, i)
      expect(result.settings).toEqual(DEFAULT_SETTINGS)
      expect(result.action).toBe('none')
      expect(result.changed).toBe(false)
    }
  })
})

describe('the menu as the caller holds it', () => {
  it('persists on the PRESS, not on leaving the page', () => {
    // Someone who takes the headset off because they feel ill never closes the
    // menu politely. The setting they just found is the one thing that must not
    // be lost — so the write happens on the button, and a reload sees it.
    const store = memoryStore()
    const seen: ComfortSettings[] = []
    const menu = createComfortMenu({
      settings: DEFAULT_SETTINGS,
      onChange: (s) => seen.push(s),
      storage: store,
    })
    menu.openPage()
    menu.activate(indexOf('vignette')) // light -> strong
    expect(menu.settings.vignette).toBe('strong')
    expect(seen.at(-1)?.vignette).toBe('strong')
    expect(store.map.has(SETTINGS_KEY)).toBe(true)
    // The reload, from the same bytes, with no shared state.
    expect(loadSettings(store).vignette).toBe('strong')
  })

  it('tells the renderer ONCE per real change, and not on an action row', () => {
    // One callback for all five settings, so a row added later cannot forget to
    // notify one of the three consumers (vignette, horizon, quality).
    const changes: ComfortSettings[] = []
    const menu = createComfortMenu({
      settings: DEFAULT_SETTINGS,
      onChange: (s) => changes.push(s),
      storage: memoryStore(),
    })
    menu.activate(indexOf('horizon'))
    menu.activate(indexOf('recenter'))
    menu.activate(indexOf('back'))
    expect(changes).toHaveLength(1)
  })

  it('closes on BACK and stays open on everything else', () => {
    const menu = createComfortMenu({
      settings: DEFAULT_SETTINGS,
      onChange: () => {},
      storage: memoryStore(),
    })
    menu.openPage()
    expect(menu.open).toBe(true)
    expect(menu.activate(indexOf('vignette'))).toBe('none')
    expect(menu.open).toBe(true)
    expect(menu.activate(indexOf('recenter'))).toBe('recenter')
    expect(menu.open).toBe(true)
    expect(menu.activate(indexOf('back'))).toBe('back')
    expect(menu.open).toBe(false)
  })

  it('keeps working when storage is blocked', () => {
    // A private window. The live setting still changes — the player still gets
    // their vignette for this session — and only the memory is lost.
    const menu = createComfortMenu({
      settings: DEFAULT_SETTINGS,
      onChange: () => {},
      storage: null,
    })
    expect(() => menu.activate(indexOf('vignette'))).not.toThrow()
    expect(menu.settings.vignette).toBe('strong')
  })
})

describe('the comfort page fits on the panel it is drawn on', () => {
  it('every row is hittable by the gaze, top to bottom', () => {
    // The end-to-end statement, and the one that would break silently: the page
    // is eight rows on a plate that shipped cut for three. `pause.ts` grows the
    // plate downward and shrinks the band; if the two halves of that ever
    // disagree, the row you see highlighted and the row you hit drift apart —
    // and it is invisible in a screenshot, because the panel renders perfectly
    // either way.
    const count = comfortRows(DEFAULT_SETTINGS).length
    for (let i = 0; i < count; i++) {
      expect(pickLocal(0, rowCentreLocalY(i, count), 1, 0, 0, -1, count), `row ${i}`).toBe(i)
    }
  })

  it('still selects NOTHING along the eye line, at eight rows', () => {
    // `PANEL_DROP`'s whole job, and the property that could quietly stop holding
    // the day the panel changed size. A row on the eye line is re-selected every
    // frame on a flat screen and the stick can never move off it.
    const count = comfortRows(DEFAULT_SETTINGS).length
    expect(pickLocal(0, 0.18, 1, 0, 0, -1, count)).toBe(-1)
  })
})
