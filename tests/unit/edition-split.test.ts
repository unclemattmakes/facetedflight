// tests/unit/edition-split.test.ts — Classic is a LOOK (DEV-452, D35).
//
// Matt, 2026-09-27: the Classic/Anniversary split is *"just for the in-mission
// visuals"*. `content/edition-split.ts` is that sentence as one table and one
// composition; this file holds both to the presets as they are on disk, so a
// new key cannot ship without somebody deciding which side of D35 it is on,
// and a Classic-look run can never carry a rule of Classic's.
//
// The oracle for "one set of boards" is outside the split: the lap server
// hashes a board's rules from the preset's `gameplay` block
// (`net/lap-courses-build.ts`, `rulesVersion`), so the composed `gameplay`
// must be Anniversary's own object, not a copy that happens to agree.

import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@/boot/settings'
import { type Edition, editionFeatures } from '@/content/edition-schema'
import { EDITION_KEY_CLASS, lookOnRules } from '@/content/edition-split'
import { createEditionState } from '@/game/edition'
import { rulesVersion } from '@/net/lap-courses-build'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'

const ANNIVERSARY = anniversaryJson as unknown as Edition
const CLASSIC = classicJson as unknown as Edition

/** Every `block.key` a preset carries, two levels deep, prose left out. */
const keysOf = (e: Edition): string[] => {
  const out: string[] = []
  for (const [block, value] of Object.entries(e as unknown as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    if (block === 'vr') continue
    for (const key of Object.keys(value)) if (key !== 'note') out.push(`${block}.${key}`)
  }
  return out.sort()
}

const at = (e: Edition, path: string): unknown => {
  const [block, key] = path.split('.') as [string, string]
  return (e as unknown as Record<string, Record<string, unknown>>)[block]?.[key]
}

describe('every key is on one side of D35', () => {
  it('has a row for every key either preset carries', () => {
    const missing = [...new Set([...keysOf(ANNIVERSARY), ...keysOf(CLASSIC)])].filter(
      (path) => !(path in EDITION_KEY_CLASS),
    )
    expect(missing, 'keys with no row in EDITION_KEY_CLASS').toEqual([])
  })

  it('names no key that neither preset has', () => {
    const carried = new Set([...keysOf(ANNIVERSARY), ...keysOf(CLASSIC)])
    const stale = Object.keys(EDITION_KEY_CLASS).filter((path) => !carried.has(path))
    expect(stale, 'rows for keys that are gone').toEqual([])
  })

  it('puts the whole of gameplay on the rules side: it is what a board is hashed from', () => {
    const gameplay = Object.entries(EDITION_KEY_CLASS).filter(([p]) => p.startsWith('gameplay.'))
    expect(gameplay.length).toBeGreaterThan(0)
    for (const [path, row] of gameplay) expect(row.class, path).toBe('rules')
  })
})

describe('a Classic look over Anniversary’s rules', () => {
  const worn = lookOnRules(CLASSIC, ANNIVERSARY)

  it('is named for its look', () => {
    expect(worn.id).toBe('classic')
    expect(worn.title).toBe(CLASSIC.title)
  })

  it('flies Anniversary’s gameplay: the same object, so the same board', () => {
    expect(worn.gameplay).toBe(ANNIVERSARY.gameplay)
    const body = { mission: 'int_01_hoverJet' } as never
    const variant = { id: 'standard', scale: {}, ceiling: {} }
    expect(rulesVersion(body, variant as never, worn.gameplay)).toBe(
      rulesVersion(body, variant as never, ANNIVERSARY.gameplay),
    )
    expect(rulesVersion(body, variant as never, worn.gameplay)).not.toBe(
      rulesVersion(body, variant as never, CLASSIC.gameplay),
    )
  })

  it('takes every look key from Classic and every rules key from Anniversary', () => {
    for (const [path, row] of Object.entries(EDITION_KEY_CLASS)) {
      const from = row.class === 'look' ? CLASSIC : ANNIVERSARY
      expect(at(worn, path), `${path} (${row.class})`).toBe(at(from, path))
    }
  })

  it('draws Classic where the presets differ in LOOK, and races Anniversary where they differ in RULES', () => {
    // The adversarial sample: keys the two presets disagree on, so a
    // composition that took everything from one side fails one half.
    expect(worn.render.toneMapping).toBe(CLASSIC.render.toneMapping)
    expect(worn.render.toneMapping).not.toBe(ANNIVERSARY.render.toneMapping)
    expect(worn.hud.raceMap.enabled).toBe(false)
    expect(worn.gameplay.racers.enabled).toBe(true)
    expect(worn.gameplay.energy.enabled).toBe(true)
    // What stands is rules (it is solid), how it is drawn is look.
    expect(worn.props.enabled).toBe(true)
    expect(worn.props.birds).toBe(CLASSIC.props.birds)
  })

  it('is the preset itself when the look and the rules are one preset', () => {
    expect(lookOnRules(ANNIVERSARY, ANNIVERSARY)).toBe(ANNIVERSARY)
    expect(lookOnRules(CLASSIC, CLASSIC)).toBe(CLASSIC)
  })

  it('turns off in VR only what the look turns off for its look, and what the rules do for theirs', () => {
    // Anniversary's list is all look paths, and Classic has none: a Classic
    // look in a headset has nothing to turn off, whoever's rules it flies.
    expect(worn.vr).toBeUndefined()
    const flipped = lookOnRules(ANNIVERSARY, CLASSIC)
    expect(flipped.vr?.disable).toEqual(ANNIVERSARY.vr?.disable)
  })
})

describe('the edition state, holding two presets', () => {
  it('keys the rules to the page and the look to the flip', () => {
    const s = createEditionState(ANNIVERSARY, DEFAULT_SETTINGS, ANNIVERSARY)
    s.setLook(CLASSIC)
    expect(s.current.id, 'the look').toBe('classic')
    expect(s.rules.id, 'the rules').toBe('anniversary')
    expect(s.current.gameplay).toBe(ANNIVERSARY.gameplay)
    // The 2016 reference (`?rules=classic`): Classic's rules whatever is worn.
    const ref = createEditionState(ANNIVERSARY, DEFAULT_SETTINGS, CLASSIC)
    expect(ref.current.gameplay).toBe(CLASSIC.gameplay)
    expect(new Map(editionFeatures(ref.current)).get('render.haze')?.enabled).toBe(true)
  })

  it('does not notify on a VR edge or a look handed back that changes nothing', () => {
    const s = createEditionState(CLASSIC, DEFAULT_SETTINGS, ANNIVERSARY)
    let calls = 0
    s.subscribe(() => {
      calls += 1
    })
    s.setImmersive(true)
    s.setImmersive(false)
    s.setLook(s.current)
    expect(calls, 'nothing moved, so nothing rebuilds').toBe(0)
    s.setLook(ANNIVERSARY)
    expect(calls).toBe(1)
  })
})
