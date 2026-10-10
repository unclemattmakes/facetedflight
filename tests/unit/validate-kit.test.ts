// tests/unit/validate-kit.test.ts: the validators' shared scaffolding
// (code-reuse audit BE-13 / XC-25, DEV-677).
//
// `shownValue` renders a hostile value for an error message and must never
// throw: `content/level-override.ts` called `JSON.stringify` bare, so a cyclic
// or BigInt `mission` made `checkOverride` ("Never throws", its own header)
// throw. The two callers' truncation is pinned as it was.

import { describe, expect, it } from 'vitest'
import { checkOverride, type LevelOverride } from '@/content/level-override'
import type { Level } from '@/content/level-schema'
import { validatePlayerCourse } from '@/content/player-course'
import { IssueList, isRecord, shownValue } from '@/net/validate-kit'

describe('shownValue', () => {
  it('writes ordinary values as JSON, and a missing one as "undefined"', () => {
    expect(shownValue('hi', 64, '…')).toBe('"hi"')
    expect(shownValue(12.5, 64, '…')).toBe('12.5')
    expect(shownValue({ a: [1, null] }, 64, '…')).toBe('{"a":[1,null]}')
    expect(shownValue(undefined, 64, '…')).toBe('undefined')
  })

  it('does not throw on a cycle or a BigInt: it names the type', () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(shownValue(cycle, 64, '…')).toBe('object')
    expect(shownValue(10n, 64, '…')).toBe('bigint')
  })

  it('cuts past max to keep characters and appends the ellipsis', () => {
    expect(shownValue('x'.repeat(10), 12, '…')).toBe(`"${'x'.repeat(10)}"`)
    expect(shownValue('x'.repeat(11), 12, '…')).toBe('"xxxxxxxxxxx…')
    // The player course's own shape: cut past 24, keep 21.
    expect(shownValue('x'.repeat(30), 24, '...', 21)).toBe(`"${'x'.repeat(20)}...`)
    expect(shownValue('x'.repeat(22), 24, '...', 21)).toBe(`"${'x'.repeat(22)}"`)
  })
})

describe('isRecord', () => {
  it('is an object that is neither null nor an array', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord(null)).toBe(false)
    expect(isRecord([])).toBe(false)
    expect(isRecord('x')).toBe(false)
  })
})

describe('DEV-677: a validator refuses a hostile value, it does not throw on it', () => {
  it('checkOverride names a cyclic or BigInt mission instead of throwing', () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    for (const mission of [cycle, 10n]) {
      const issues = checkOverride(
        { id: 'int_01_hoverJet' } as Level,
        {
          mission,
        } as unknown as LevelOverride,
      )
      expect(issues).toHaveLength(1)
      expect(issues[0]?.[0]).toBe('mission')
      expect(issues[0]?.[1]).toContain('but the baseline is "int_01_hoverJet"')
    }
  })

  it('the player course keeps its own truncation: cut past 24, keep 21', () => {
    const issues = (key: string): string[] => {
      const r = validatePlayerCourse({ [key]: 1 })
      return r.ok ? [] : r.errors.map(([p]) => p)
    }
    expect(issues('k'.repeat(22))).toContain(`"${'k'.repeat(22)}"`)
    expect(issues('k'.repeat(30))).toContain(`"${'k'.repeat(20)}...`)
  })
})

describe('IssueList', () => {
  it('keeps the first `cap` issues, in order, and says whether there are any', () => {
    const list = new IssueList<readonly [string, string]>(2)
    expect(list.any).toBe(false)
    list.add('a', '1')
    list.add('b', '2')
    list.add('c', '3')
    expect(list.list).toEqual([
      ['a', '1'],
      ['b', '2'],
    ])
    expect(list.any).toBe(true)
  })
})
