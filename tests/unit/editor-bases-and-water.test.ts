// DEV-875 / DEV-876 / DEV-877: Matt's editor round. What the unit layer can pin
// of three desk behaviours that live in a browser closure; the behaviours
// themselves are held by tests/e2e/editor-bases.spec.ts.
import { describe, expect, it } from 'vitest'
import { generatedLevelIds, loadLevel } from '@/content/load-level'
import { islandSeaLevel, PLAYER_COURSE_WATER } from '@/content/player-course'
import { baseLabels } from '@/editor/desk/bases'

describe('DEV-877: a seeded island starts its water at 140 m', () => {
  it('pins the value', () => {
    expect(PLAYER_COURSE_WATER.seededDefaultLevelMetres).toBe(140)
  })
})

describe('DEV-876: which bases already have water', () => {
  it('the sea islands report a sea level and the sealess ones none', () => {
    // The desk shows the water switch ON (and fixed) for exactly these.
    expect(islandSeaLevel('simonet')).not.toBeNull()
    expect(islandSeaLevel('kauai')).not.toBeNull()
    expect(islandSeaLevel('desert')).toBeNull()
    expect(islandSeaLevel('alpine')).toBeNull()
  })
})

describe('DEV-875: every island has a base the picker can offer', () => {
  it('lists HoverJet bases on all four islands, each with a distinct label', async () => {
    const levels = []
    for (const id of generatedLevelIds()) {
      const level = await loadLevel(id)
      if (level.vehicle === 'hoverjet') levels.push(level)
    }
    expect(new Set(levels.map((l) => l.environment))).toEqual(
      new Set(['simonet', 'kauai', 'desert', 'alpine']),
    )
    const labels = baseLabels(levels)
    expect(new Set(labels.values()).size).toBe(levels.length)
  })
})
