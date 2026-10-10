// tests/unit/advanced-menu.test.ts — the per-feature toggles, and the one thing
// that makes the page worth having: it shows what the RENDERER is doing.
//
// DEV-269. Matt: *"instead of a URL toggle - add these as toggles to pause menu
// under advanced quality settings."* The page exists to bisect the 22 points
// between Anniversary (75.0 % of frames at 90 Hz) and Classic (96.9 %) in ONE
// headset session instead of nine rebuilds.
//
// ── The bug this suite is mostly about ───────────────────────────────────
//
// A row could plausibly show `settings.featureOverrides` — the thing the player
// last pressed. That is wrong in exactly one place and it is the only place
// that matters: inside a headset, where `vr.disable` has already turned five
// features off. A row reading the override map would say "on" for something the
// renderer is not drawing, and the page would lie in the one state it was built
// for. So it reads the RESOLVED edition, and the crossed cases below hold that.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@/boot/settings'
import { type Edition, editionFeatures, withFeatureOverrides } from '@/content/edition-schema'
import { createEditionState } from '@/game/edition'
import {
  ADVANCED_FEATURES,
  ADVANCED_ROW_IDS,
  type AdvancedContext,
  activateAdvancedRow,
  advancedFeatureMask,
  advancedRows,
  createAdvancedMenu,
  effectiveState,
  featureIsOn,
  propScatterVisible,
} from '@/render/advanced-menu'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'
import { appSource } from './helpers/app-source'

const ANNIVERSARY = anniversaryJson as unknown as Edition
const classic = classicJson as unknown as Edition
const rowIndex = (id: string): number => ADVANCED_ROW_IDS.indexOf(id)
const rowValue = (rows: readonly PauseRow[], id: string): unknown =>
  rows.find((r) => r.id === id)?.value
interface PauseRow {
  readonly id: string
  readonly value?: unknown
}

/**
 * The renderer state a row is read against. DEV-302.
 *
 * `quality: 'high'` and not presenting is the arrangement in which the flag IS
 * the whole story for every row — so a test that does not care about the second
 * gate reads exactly what it read before this argument existed.
 */
const FLAT_HIGH: AdvancedContext = { settings: DEFAULT_SETTINGS, presenting: false }

/** The first VR-disabled path that also has a row. `null` when the sets miss. */
const vrRow = (): { path: string; id: string } | null => {
  for (const path of ANNIVERSARY.vr?.disable ?? []) {
    const f = ADVANCED_FEATURES.find((x) => x.path === path)
    if (f !== undefined) return { path, id: f.id }
  }
  return null
}

describe('the feature list', () => {
  it('names only paths the registry knows, with no duplicates', () => {
    // A path that is not in the registry renders a row that toggles NOTHING —
    // and the row still says "on" or "off" convincingly. Checked against the
    // registry itself, which is the same one `vr.disable` is validated against.
    const known = new Set(editionFeatures(ANNIVERSARY).map(([p]) => p))
    for (const f of ADVANCED_FEATURES) {
      expect(known.has(f.path), `${f.path} is a real feature`).toBe(true)
    }
    expect(new Set(ADVANCED_FEATURES.map((f) => f.path)).size).toBe(ADVANCED_FEATURES.length)
    expect(new Set(ADVANCED_FEATURES.map((f) => f.id)).size).toBe(ADVANCED_FEATURES.length)
  })

  it('fits the plate: ten rows, which is 3.2° and not tighter', () => {
    // `ROWS_MAX_M` is fixed, so rows do not make a page taller, they make each
    // other shorter. Eight rows were 4.00° at the panel's distance; DEV-838
    // moved Auto quality and Foveation here from the comfort page, which makes
    // ten (3.20°, flagged to Matt in QUESTIONS-FOR-MATT.md). This is the
    // assertion that stops the list growing quietly past that.
    expect(ADVANCED_ROW_IDS).toHaveLength(10)
    expect(ADVANCED_ROW_IDS.slice(0, 2)).toEqual(['adaptive', 'foveation'])
    expect(ADVANCED_ROW_IDS.at(-1)).toBe('back')
  })

  it('every row carries a note that says what it COSTS', () => {
    // The reason to open this page is to find frames, so "Bloom" alone is not a
    // row anybody can act on.
    for (const f of ADVANCED_FEATURES) {
      expect(f.note.length, `${f.id} has a note`).toBeGreaterThan(10)
    }
  })
})

describe('a row shows what the RENDERER is doing, not what was asked for', () => {
  it('reads the resolved edition, so the VR layer shows through', () => {
    const hit = vrRow()
    expect(hit, 'the page covers at least one VR-disabled feature').not.toBeNull()
    if (hit === null) return
    const state = createEditionState(ANNIVERSARY, DEFAULT_SETTINGS)
    expect(rowValue(advancedRows(state.current, FLAT_HIGH), hit.id), 'on, flat').toBe('on')
    state.setImmersive(true)
    expect(rowValue(advancedRows(state.current, FLAT_HIGH), hit.id), 'off, in VR').toBe('off')
  })

  it('does NOT read the override map — the crossed case', () => {
    // The distinguishing case, and the whole argument for taking an Edition.
    // An override sitting in the SETTINGS that has not reached the edition state
    // must not move the row: a page reading `featureOverrides` would say "on".
    const hit = vrRow()
    if (hit === null) return
    const state = createEditionState(ANNIVERSARY, {
      ...DEFAULT_SETTINGS,
      featureOverrides: { [hit.path]: true },
    })
    state.setImmersive(true)
    expect(rowValue(advancedRows(state.current, FLAT_HIGH), hit.id)).toBe('off')
    state.setFeatureOverrides({ [hit.path]: true })
    expect(rowValue(advancedRows(state.current, FLAT_HIGH), hit.id), 'and now it is on').toBe('on')
  })
})

describe('pressing a row', () => {
  it('toggles against the LIVE state, so it can put a VR-disabled feature back', () => {
    const hit = vrRow()
    if (hit === null) return
    const state = createEditionState(ANNIVERSARY, DEFAULT_SETTINGS)
    state.setImmersive(true)
    const out = activateAdvancedRow(DEFAULT_SETTINGS, state.current, rowIndex(hit.id))
    expect(out.changed).toBe(true)
    // `true`, not "the opposite of the stored override" — the stored map is
    // empty here, so a toggle keyed on it would have written `false` and asked
    // for the state the renderer is already in.
    expect(out.settings.featureOverrides[hit.path]).toBe(true)
  })

  it('turns something OFF that the preset has on', () => {
    const on = ADVANCED_FEATURES.find((f) => featureIsOn(ANNIVERSARY, f.path))
    expect(on, 'the fixture has at least one live feature').toBeDefined()
    if (on === undefined) return
    const out = activateAdvancedRow(DEFAULT_SETTINGS, ANNIVERSARY, rowIndex(on.id))
    expect(out.settings.featureOverrides[on.path]).toBe(false)
  })

  it('leaves the other overrides alone', () => {
    const a = ADVANCED_FEATURES[0]
    const b = ADVANCED_FEATURES[1]
    if (a === undefined || b === undefined) return
    const seeded = { ...DEFAULT_SETTINGS, featureOverrides: { [b.path]: false } }
    const out = activateAdvancedRow(seeded, ANNIVERSARY, rowIndex(a.id))
    expect(out.settings.featureOverrides[b.path], 'the untouched row survives').toBe(false)
  })

  it('BACK leaves, and an out-of-range index is a no-op rather than a throw', () => {
    const back = activateAdvancedRow(DEFAULT_SETTINGS, ANNIVERSARY, rowIndex('back'))
    expect(back.action).toBe('back')
    expect(back.changed).toBe(false)
    const off = activateAdvancedRow(DEFAULT_SETTINGS, ANNIVERSARY, 99)
    expect(off.action).toBe('none')
    expect(off.changed).toBe(false)
    expect(off.settings).toBe(DEFAULT_SETTINGS)
  })
})

describe('the menu object', () => {
  it('re-reads the preset on every access, so entering VR moves the rows', () => {
    // The reason `live` is a getter. A page that captured the edition when it
    // opened would show the flat look while the player is in a headset — the
    // same shape as the bug this page was built to let you find.
    const hit = vrRow()
    if (hit === null) return
    const state = createEditionState(ANNIVERSARY, DEFAULT_SETTINGS)
    const menu = createAdvancedMenu({
      settings: DEFAULT_SETTINGS,
      live: () => state.current,
      presenting: () => false,
      onChange: () => {},
      storage: null,
    })
    expect(rowValue(menu.rows, hit.id)).toBe('on')
    state.setImmersive(true)
    expect(rowValue(menu.rows, hit.id), 'the SAME menu object, after the flip').toBe('off')
  })

  it('announces a change and closes on BACK', () => {
    const seen: Record<string, boolean>[] = []
    const menu = createAdvancedMenu({
      settings: DEFAULT_SETTINGS,
      live: () => ANNIVERSARY,
      presenting: () => false,
      onChange: (s) => seen.push({ ...s.featureOverrides }),
      storage: null,
    })
    menu.openPage()
    expect(menu.open).toBe(true)
    const on = ADVANCED_FEATURES.find((f) => featureIsOn(ANNIVERSARY, f.path))
    if (on !== undefined) {
      menu.activate(rowIndex(on.id))
      expect(seen).toHaveLength(1)
      expect(seen[0]?.[on.path]).toBe(false)
    }
    expect(menu.activate(rowIndex('back'))).toBe('back')
    expect(menu.open).toBe(false)
  })
})

describe('the override reaches the renderer', () => {
  it('composes over the VR layer, both directions', () => {
    // End to end without app.ts: preset → VR layer → override, which is the
    // order `game/edition.ts` applies them in and the order that lets a row put
    // back something the headset turned off.
    const hit = vrRow()
    if (hit === null) return
    const inVr = withFeatureOverrides(ANNIVERSARY, { [hit.path]: false })
    expect(featureIsOn(inVr, hit.path)).toBe(false)
    expect(featureIsOn(withFeatureOverrides(inVr, { [hit.path]: true }), hit.path)).toBe(true)
  })
})

// ── DEV-302 / DEV-303: the page did not keep its own promise ─────────────
//
// Every claim below is about a SECOND gate, downstream of the edition, that
// the composed preset cannot see. The describe above holds *"the row reads the
// resolved edition"*; these hold *"and the resolved edition was not enough"*.
//
// The shape they share is worth more than the three fixes, so the last test
// here is the GENERAL one: it refuses a row whose path is gated by something
// the edition cannot see and which does not declare it. That is the fourth
// instance, caught before anybody writes it.

describe('a forced row shows the renderer, and says what is forcing it (DEV-302)', () => {
  const AT_LOW: AdvancedContext = {
    settings: { ...DEFAULT_SETTINGS, quality: 'low' },
    presenting: false,
  }
  const IN_VR: AdvancedContext = { settings: DEFAULT_SETTINGS, presenting: true }

  const row = (id: string, ctx: AdvancedContext): { value?: unknown; note?: string } =>
    advancedRows(ANNIVERSARY, ctx).find((r) => r.id === id) ?? {}

  it('shadows read OFF at quality low, where shadowsEnabled has already refused', () => {
    // `render/shadows.ts`: `edition.render.shadows.enabled && quality !==
    // 'low'`. The row is composed from that FUNCTION rather than from a copy
    // of the rule, so a change to the tier policy moves both together.
    expect(featureIsOn(ANNIVERSARY, 'render.shadows'), 'the preset says on').toBe(true)
    expect(row('shadows', FLAT_HIGH).value).toBe('on')
    expect(row('shadows', AT_LOW).value).toBe('off')
    expect(row('shadows', AT_LOW).note, 'the row must say what forced it').toMatch(/LOW/)
  })

  it('the detail ring reads OFF at quality low, where detailRingFor returns null', () => {
    expect(featureIsOn(ANNIVERSARY, 'terrain.detailRing'), 'the preset says on').toBe(true)
    expect(row('detailring', FLAT_HIGH).value).toBe('on')
    expect(row('detailring', AT_LOW).value).toBe('off')
    expect(row('detailring', AT_LOW).note).toMatch(/LOW/)
  })

  it('bloom reads its FLAG while presenting: the halos carry it in a headset (DEV-336)', () => {
    // It read OFF here until DEV-336, because the post pass has never
    // composited in a headset. Now the flag has an answer on both surfaces:
    // the pass on a monitor, halos on the studs and the sun in a headset. So
    // the row says ON in both, and its note names both, which is the note
    // Matt read as a promise when it only said "both eyes".
    expect(featureIsOn(ANNIVERSARY, 'render.bloom'), 'the preset says on').toBe(true)
    expect(row('bloom', FLAT_HIGH).value).toBe('on')
    expect(row('bloom', IN_VR).value).toBe('on')
    expect(row('bloom', IN_VR).note).toMatch(/headset/)
    expect(row('bloom', FLAT_HIGH).note).toMatch(/monitor/)
    // And Classic, whose bloom is off, has neither.
    expect(advancedRows(classic, IN_VR).find((r) => r.id === 'bloom')?.value).toBe('off')
  })

  it('and the post pass still refuses in a headset, which is why the halos exist', () => {
    // The one `effective` arm with no function to borrow: `willComposite` is a
    // method on a live instance that needs a renderer. So the rule is
    // transcribed, and a transcription needs its source pinned or it rots —
    // CLAUDE.md's *compare against something outside the port*.
    const source = fs.readFileSync(path.join(process.cwd(), 'src/render/bloom.ts'), 'utf8')
    expect(source, "bloom no longer refuses on isPresenting — re-read the row's arm").toContain(
      'return !renderer.xr.isPresenting && editionState.current.render.bloom.enabled',
    )
  })

  it('an UNFORCED row keeps its cost note, which is what the page is for', () => {
    for (const id of ['shadows', 'detailring', 'bloom']) {
      const f = ADVANCED_FEATURES.find((x) => x.id === id)
      expect(row(id, FLAT_HIGH).note, `${id} lost its cost note`).toBe(f?.note)
    }
  })

  it('reports forcing as a DISAGREEMENT, not as a state', () => {
    // `effectiveState`'s `forced` is `on !== flag` — so a flag that is ALREADY
    // off at quality low is not forced and keeps its ordinary note. A row that
    // showed the forcing note whenever the gate was shut would tell a player
    // their own press had been overruled when it had not.
    const off = withFeatureOverrides(ANNIVERSARY, { 'render.shadows': false })
    const f = ADVANCED_FEATURES.find((x) => x.id === 'shadows')
    if (f === undefined) throw new Error('no shadows row')
    expect(effectiveState(f, ANNIVERSARY, AT_LOW)).toEqual({ on: false, forced: true })
    expect(effectiveState(f, off, AT_LOW)).toEqual({ on: false, forced: false })
    expect(effectiveState(f, ANNIVERSARY, FLAT_HIGH)).toEqual({ on: true, forced: false })
  })

  it('every row a QUALITY TIER or a HEADSET can override declares it', () => {
    // The general form, and the guard against the fourth instance. The gates
    // are read as TEXT out of the files that own them, so a row whose owner
    // starts refusing at `low` — or while presenting — and which has no
    // `effective` arm goes red here rather than in a headset.
    const gated: Record<string, string> = {
      'render.shadows': 'src/render/shadows.ts',
      'terrain.detailRing': 'src/game/terrain/detail-ring.ts',
      'render.bloom': 'src/render/bloom.ts',
    }
    let found = 0
    const missing: string[] = []
    for (const f of ADVANCED_FEATURES) {
      const file = gated[f.path]
      if (file === undefined) continue
      const source = fs.readFileSync(path.join(process.cwd(), file), 'utf8')
      const gates =
        source.includes("quality === 'low'") ||
        source.includes("quality !== 'low'") ||
        source.includes('xr.isPresenting')
      if (gates) found++
      if (gates && f.effective === undefined) missing.push(`${f.id} (${file})`)
    }
    expect(
      missing,
      'these rows have a gate downstream of the edition and do not declare it — ' +
        'add an `effective` arm composed from the gate rather than copied from it',
    ).toEqual([])
    // The loud counterpart. Without it the sweep passes for ever against three
    // files that have stopped saying any of this, which is the exact way a
    // substring guard rots.
    expect(found, 'the sweep found no gate at all — the three files moved').toBe(3)
  })
})

describe('the 2016 forest is drawn unless the Props row says otherwise (DEV-332)', () => {
  it('is drawn with no override, and on CLASSIC, whose preset leaves the dressing off', () => {
    expect(classic.props.enabled, 'Classic has no generated dressing, by design').toBe(false)
    expect(propScatterVisible({}), 'and still draws 2016’s own scatter').toBe(true)
  })
  it('is hidden by an explicit OFF and only by that', () => {
    expect(propScatterVisible({ props: false })).toBe(false)
    expect(propScatterVisible({ props: true })).toBe(true)
    expect(propScatterVisible({ 'render.bloom': false })).toBe(true)
  })
})

describe('the PROPS row reaches the forest (DEV-303)', () => {
  it('no longer advertises a triangle count it cannot move', () => {
    // The note read *"trees, rocks and birds — 1.2 M triangles of them"* while
    // the row reached `load-dressing.ts` alone: 3 draw calls and 87,448
    // triangles of rocks and shrubs, with no tree kind in it at all. The 2016
    // baked scatter is 7.42 M triangles and 88–93 % of desert's and alpine's
    // world pass.
    const props = ADVANCED_FEATURES.find((f) => f.id === 'props')
    expect(props?.note).not.toMatch(/1\.2 M|1,200,000/)
    // And it says what it does NOT reach, because a hidden tree is still solid.
    expect(props?.note).toMatch(/collider/i)
  })

  it('the Props row reaches the 2016 scatter, live, through visibility — via the OVERRIDE (DEV-332)', () => {
    // A source read, because `loadProps` needs a terrain, a height map and a
    // worker. The claim is the MECHANISM: `app.ts` drives the loaded group's
    // visibility from the row's override, on the edition notify AND at world
    // build. DEV-303 wired it to the preset's `props.enabled`, which on Classic
    // is false (it means the DRESSING there) and hid the whole 2016 forest.
    const source = appSource()
    expect(source).toContain(
      'livePropsLive.group.visible = propScatterVisible(editionState.featureOverrides)',
    )
    expect(source).not.toContain('livePropsLive.group.visible = editionState.current.props.enabled')
    expect(source, 'a notify seam, or a flip mid-run does nothing').toContain(
      'editionState.subscribe(applyPropVisibility)',
    )
    // And `loadProps` still reads its CONTENT inputs at world build: hiding a
    // group is not restacking the trees under the player, which is the reason
    // that was deliberate (DEV-102 / DEV-134).
    expect(source).toContain('unbakedPasses: editionState.current.props.unbakedPasses.enabled')
  })
})

describe('DEV-335: the trace mask is the page, as bits', () => {
  const bit = (id: string) => 1 << ADVANCED_FEATURES.findIndex((f) => f.id === id)
  const flat = { settings: DEFAULT_SETTINGS, presenting: false }

  it('sets exactly the rows the page shows ON', () => {
    const mask = advancedFeatureMask(ANNIVERSARY, flat)
    const rows = advancedRows(ANNIVERSARY, flat)
    for (const f of ADVANCED_FEATURES) {
      const on = rows.find((r) => r.id === f.id)?.value === 'on'
      expect(Boolean(mask & bit(f.id)), f.id).toBe(on)
    }
  })

  it('moves a row’s own bit when that row is pressed, and no other', () => {
    const before = advancedFeatureMask(ANNIVERSARY, flat)
    const pressed = withFeatureOverrides(ANNIVERSARY, { 'terrain.detailRing': false })
    const after = advancedFeatureMask(pressed, flat)
    expect(before ^ after).toBe(bit('detailring'))
  })

  it('reports bloom ON in a headset too, where the halos carry it (DEV-336)', () => {
    expect(advancedFeatureMask(ANNIVERSARY, flat) & bit('bloom')).toBe(bit('bloom'))
    expect(advancedFeatureMask(ANNIVERSARY, { ...flat, presenting: true }) & bit('bloom')).toBe(
      bit('bloom'),
    )
  })
})
