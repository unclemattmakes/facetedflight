/**
 * The preset loader. `import.meta.glob` means a typo in a preset id is a list
 * you can print, not a 404 at runtime — and that a preset is added by dropping
 * one JSON file into `content/editions/`, with no code change anywhere.
 */
import { describe, expect, it } from 'vitest'
import { editionIds, loadEdition } from '@/content/load-edition'

describe('load-edition', () => {
  it('discovers both presets and no schema', () => {
    expect(editionIds()).toEqual(['anniversary', 'classic'])
  })

  it('loads and validates each', async () => {
    const classic = await loadEdition('classic')
    expect(classic.id).toBe('classic')
    expect(classic.fx.motes.enabled).toBe(false)
    const anniversary = await loadEdition('anniversary')
    expect(anniversary.id).toBe('anniversary')
    expect(anniversary.title).toBe('Anniversary')
  })

  it('names the presets it does know when given an id it does not', async () => {
    await expect(loadEdition('remaster')).rejects.toThrow(/no such edition.*anniversary, classic/)
  })
})
