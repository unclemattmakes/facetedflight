// tests/unit/glob-tree.test.ts: BE-6, the one filter every content loader uses
// to list the ids in an `import.meta.glob` tree.

import { describe, expect, it } from 'vitest'
import { globIds } from '@/content/glob-tree'
import { aircraftFileIds } from '@/content/load-aircraft'
import { editionIds } from '@/content/load-edition'
import { environmentIds } from '@/content/load-environment'

const tree = (...paths: string[]): Record<string, () => void> =>
  Object.fromEntries(paths.map((p) => [p, () => undefined]))

describe('globIds', () => {
  it('slices the prefix and .json, sorts, and drops underscore files', () => {
    const modules = tree('/c/b.json', '/c/a.json', '/c/_schema.json', '/c/_fixture_x.json')
    expect(globIds(modules, '/c/')).toEqual(['a', 'b'])
  })

  it('leaves out a path that is not under the prefix (a merged tree)', () => {
    const modules = tree('/c/levels/one.json', '/c/authored/two.json')
    expect(globIds(modules, '/c/levels/')).toEqual(['one'])
    expect(globIds(modules, '/c/authored/')).toEqual(['two'])
  })

  it('an empty tree has no ids', () => {
    expect(globIds({}, '/c/')).toEqual([])
  })
})

describe('the loaders that share it, over the real content folders', () => {
  it('list real ids, sorted, with no underscore file', () => {
    for (const ids of [environmentIds(), editionIds(), aircraftFileIds()]) {
      expect(ids.length).toBeGreaterThan(0)
      expect(ids).toEqual([...ids].sort())
      expect(ids.some((id) => id.startsWith('_'))).toBe(false)
      expect(ids.some((id) => id.includes('/') || id.endsWith('.json'))).toBe(false)
    }
    expect(environmentIds()).toContain('simonet')
  })
})
