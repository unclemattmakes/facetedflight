// tests/unit/edition-vr-values.test.ts: `vr.override`, the VR-only VALUES
// beside `vr.disable`. DEV-934 (lever 5 of
// docs/plan/ANNIVERSARY-VR-FRAMERATE.md: narrower streaks and fewer motes in a
// headset) built the mechanism; DEV-935 (lever 8) is its second user.
//
// Three claims, each the one a careless version gets wrong:
//
//  1. The loader holds the layer NARROW (`EditionVrOverrides.override` says why
//     that matters): look keys only, existing fields only, never `enabled`,
//     the flat value's shape, and a mesh-LOD table that keeps its meshes.
//  2. The values reach the readers that draw them while presenting and never
//     on a monitor, through the same notify every other VR change rides.
//  3. A Classic look in a headset (the AUTO default, DEV-896) carries none of
//     Anniversary's VR values, so entering VR on it still notifies nobody.

import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@/boot/settings'
import {
  applyVrOverrides,
  type Edition,
  editionFeatures,
  validateEdition,
} from '@/content/edition-schema'
import { lookOnRules } from '@/content/edition-split'
import { moteSpecFor } from '@/game/air'
import { createEditionState, speedFxScale } from '@/game/edition'
import { speedLineOverride } from '@/game/particle-fx'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'

const ANNIVERSARY = anniversaryJson as unknown as Edition
const CLASSIC = classicJson as unknown as Edition

/** Anniversary with its `vr.override` replaced. */
const withOverride = (override: Record<string, Record<string, unknown>>): Edition =>
  ({
    ...structuredClone(ANNIVERSARY),
    vr: { ...structuredClone(ANNIVERSARY.vr), override },
  }) as Edition

const width = (e: Edition, speedFx: number): number =>
  speedLineOverride(e.fx.speedLines, speedFx)?.widthScale ?? 1
const motes = (e: Edition, speedFx: number): number => moteSpecFor(e, speedFx)?.count ?? 0

describe('vr.override: what the loader refuses', () => {
  it('accepts the shipped presets', () => {
    expect(() => validateEdition(structuredClone(ANNIVERSARY))).not.toThrow()
    expect(() => validateEdition(structuredClone(CLASSIC))).not.toThrow()
  })

  it('a path that is not a feature', () => {
    const bad = withOverride({ 'fx.noSuchThing': { widthScale: 1 } })
    expect(() => validateEdition(bad)).toThrow(/not one of editionFeatures/)
  })

  it('a RULES key: no rule may differ in a headset (D35)', () => {
    const bad = withOverride({ 'gameplay.proximity': { enabled: true } })
    expect(() => validateEdition(bad)).toThrow(/RULES key/)
  })

  it('a path vr.disable already turns off: dead text', () => {
    const path = (ANNIVERSARY.vr?.disable ?? [])[0] as string
    const bad = withOverride({ [path]: { note: 'x' } })
    expect(() => validateEdition(bad)).toThrow(/vr.disable turns off/)
  })

  it('`enabled`: on and off are the disable list, so nothing turns ON in VR', () => {
    const bad = withOverride({ 'fx.motes': { enabled: false } })
    expect(() => validateEdition(bad)).toThrow(/vr.disable's/)
  })

  it('a field the feature does not have: nothing new appears in VR', () => {
    const bad = withOverride({ 'fx.motes': { density: 2 } })
    expect(() => validateEdition(bad)).toThrow(/not a field/)
  })

  it('a value of another shape', () => {
    expect(() => validateEdition(withOverride({ 'fx.motes': { count: '350' } }))).toThrow(
      /same shape/,
    )
    expect(() =>
      validateEdition(withOverride({ 'fx.motes': { count: Number.POSITIVE_INFINITY } })),
    ).toThrow(/same shape/)
    expect(() =>
      validateEdition(withOverride({ 'props.meshLod': { rungs: [{ from: 100, keep: 0.35 }] } })),
    ).toThrow(/same shape/)
  })

  it('an entry that sets nothing', () => {
    expect(() => validateEdition(withOverride({ 'fx.motes': { note: 'only prose' } }))).toThrow(
      /sets nothing/,
    )
  })

  it('a mesh-LOD table that changes a rung KEEP: the meshes are made once (DEV-935)', () => {
    const flat = ANNIVERSARY.props.meshLod.rungs
    expect(flat.length, 'the premise: Anniversary has rungs').toBeGreaterThan(1)
    const moved = flat.map((r) => ({ from: r.from / 2, keep: r.keep }))
    expect(() => validateEdition(withOverride({ 'props.meshLod': { rungs: moved } }))).not.toThrow()
    const rekept = flat.map((r, i) => ({ from: r.from / 2, keep: i === 0 ? r.keep / 2 : r.keep }))
    expect(() => validateEdition(withOverride({ 'props.meshLod': { rungs: rekept } }))).toThrow(
      /keep must equal/,
    )
    const unordered = flat.map((r, i) => ({ from: i === 0 ? 1000 : 10, keep: r.keep }))
    expect(() => validateEdition(withOverride({ 'props.meshLod': { rungs: unordered } }))).toThrow(
      /above the rung before it/,
    )
  })
})

describe('vr.override: where the values land', () => {
  it('the headset gets narrower streaks and fewer motes; the monitor keeps its own', () => {
    const s = createEditionState(ANNIVERSARY, DEFAULT_SETTINGS)
    const k = speedFxScale(DEFAULT_SETTINGS.speedFx)
    const flatWidth = width(s.current, k)
    const flatMotes = motes(s.current, k)
    s.setImmersive(true)
    expect(width(s.current, k), 'streaks narrower in VR').toBeLessThan(flatWidth)
    expect(width(s.current, k), 'and still wider than the 2016 hairline').toBeGreaterThan(1)
    expect(motes(s.current, k), 'fewer motes in VR').toBeLessThan(flatMotes)
    expect(motes(s.current, k), 'but some').toBeGreaterThan(0)
    s.setImmersive(false)
    expect(width(s.current, k), 'the monitor gets its width back').toBe(flatWidth)
    expect(motes(s.current, k)).toBe(flatMotes)
  })

  it('arrives by NOTIFY, so the live systems re-read it (app.ts, air.ts)', () => {
    // Entering VR with ONLY the values to change, so the disable list cannot
    // be what notified.
    const valuesOnly = {
      ...structuredClone(ANNIVERSARY),
      vr: { disable: [], override: structuredClone(ANNIVERSARY.vr?.override) },
    } as Edition
    const s = createEditionState(valuesOnly, DEFAULT_SETTINGS)
    let seen: Edition | null = null
    s.subscribe((e) => {
      seen = e
    })
    s.setImmersive(true)
    expect(seen, 'notified').not.toBeNull()
    expect(width(seen as unknown as Edition, 1)).toBeLessThan(width(valuesOnly, 1))
  })

  it('the off arm leaves the named paths at their flat values (?vrFxTrim=0)', () => {
    const fxOff = (path: string) => path.startsWith('fx.')
    const s = createEditionState(ANNIVERSARY, DEFAULT_SETTINGS, ANNIVERSARY, fxOff)
    const flatWidth = width(s.current, 1)
    s.setImmersive(true)
    expect(width(s.current, 1), 'the streaks keep the flat width').toBe(flatWidth)
    expect(motes(s.current, 1)).toBe(motes(ANNIVERSARY, 1))
    // ...and the disable list still applies under the pin: its off arm is
    // `?feature=`, not this.
    const path = (ANNIVERSARY.vr?.disable ?? [])[0] as string
    const worn = new Map(editionFeatures(applyVrOverrides(ANNIVERSARY, fxOff)))
    expect(worn.get(path)?.enabled, `${path} still off in VR`).toBe(false)
  })

  it('never writes to the preset it was handed', () => {
    const base = structuredClone(ANNIVERSARY)
    const before = JSON.stringify(base)
    applyVrOverrides(base)
    expect(JSON.stringify(base)).toBe(before)
  })
})

describe('vr.override: composed by the look (D35)', () => {
  it('a Classic look over Anniversary rules carries none of it, and VR notifies nobody', () => {
    // The headset AUTO default is the Classic look (DEV-896) over the page's
    // Anniversary rules, so this is the path most headsets take.
    const composed = lookOnRules(CLASSIC, ANNIVERSARY)
    expect(composed.vr?.override, 'no Anniversary VR value on Classic').toBeUndefined()
    const s = createEditionState(CLASSIC, DEFAULT_SETTINGS, ANNIVERSARY)
    const before = s.current
    let calls = 0
    s.subscribe(() => {
      calls += 1
    })
    s.setImmersive(true)
    expect(calls, 'Classic in a headset moves nothing').toBe(0)
    expect(s.current).toBe(before)
  })

  it('an Anniversary look keeps its VR values over Classic rules (?rules=classic)', () => {
    const composed = lookOnRules(ANNIVERSARY, CLASSIC)
    expect(composed.vr?.override).toEqual(ANNIVERSARY.vr?.override)
    expect(width(applyVrOverrides(composed), 1)).toBeLessThan(width(composed, 1))
  })
})
