// tests/unit/editor-bases.test.ts — DEV-499: a course's BASE, named by its
// place and a word derived from the bases' own data, never typed per mission.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { type Level, validateLevel } from '@/content/level-schema'
import { BASE_LABEL, baseLabels, compassPoint } from '@/editor/desk/bases'
import { environmentDisplayName } from '@/game/mission-index'

const DIR = path.resolve(__dirname, '..', '..', 'content', 'levels')
const hoverjets: Level[] = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .sort()
  .map((f) => validateLevel(JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) as Level))
  .filter((l) => l.vehicle === 'hoverjet')

describe('DEV-499 — the Base picker names places', () => {
  it('pins its one policy number', () => {
    expect(BASE_LABEL).toEqual({ lowSunDeg: 20 })
  })

  it('the compass: +x east, -z north', () => {
    expect(compassPoint(0, -1)).toBe('north')
    expect(compassPoint(1, 0)).toBe('east')
    expect(compassPoint(0, 1)).toBe('south')
    expect(compassPoint(-1, 1)).toBe('south-west')
  })

  it('every HoverJet base has a distinct label that starts with its place', () => {
    const labels = baseLabels(hoverjets)
    expect(hoverjets.length).toBeGreaterThanOrEqual(7)
    const all = hoverjets.map((l) => labels.get(l.id) as string)
    expect(new Set(all).size, all.join(' | ')).toBe(hoverjets.length)
    for (const l of hoverjets) {
      expect(labels.get(l.id)).toMatch(new RegExp(`^${environmentDisplayName(l.environment)} · `))
      // No mission id and no mission title in a label: the place and derived words only.
      expect(labels.get(l.id)).not.toContain(l.id)
      expect(labels.get(l.id)).not.toContain(l.title)
    }
    // What they read today, so a change to a level or the rule is seen.
    expect(
      Object.fromEntries(hoverjets.map((l) => [l.id, labels.get(l.id)])),
    ).toMatchInlineSnapshot(`
      {
        "adv_01_hoverJet": "Mesa Canyon · high sun · 43°",
        "adv_02_hoverJet": "Simonet Islands · low sun · east lift",
        "hoverJet_kauai_beg": "Kauai · low sun",
        "int_01_hoverJet": "Simonet Islands · low sun · south lift",
        "int_02_hoverJet": "Alpine Forest · low sun",
        "rookie_01_hoverJet": "Alpine Forest · high sun",
        "rookie_02_hoverJet": "Mesa Canyon · high sun · 53°",
      }
    `)
  })
})
