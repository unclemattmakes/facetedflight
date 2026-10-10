/**
 * The level loader. `import.meta.glob` means a typo in a level id is a list you
 * can print, not a 404 at runtime — and that a mission is added by dropping one
 * JSON file into `content/levels/`, with no code change anywhere (D19,
 * "content is data").
 */
import { describe, expect, it } from 'vitest'
import { generatedLevelIds, loadLevel } from '@/content/load-level'

describe('load-level', () => {
  it('discovers all 13 shipped missions', () => {
    expect(generatedLevelIds()).toHaveLength(13)
    expect(generatedLevelIds()).toContain('int_01_hoverJet')
  })

  it('loads and validates the slice mission', async () => {
    const level = await loadLevel('int_01_hoverJet')
    expect(level.id).toBe('int_01_hoverJet')
    expect(level.vehicle).toBe('hoverjet')
    expect(level.environment).toBe('simonet')
    expect(level.routes[0]?.rings).toHaveLength(21)
  })

  it('names the levels it does know when given an id it does not', async () => {
    await expect(loadLevel('nope')).rejects.toThrow(/no such level/)
  })
})
