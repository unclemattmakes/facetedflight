// tests/unit/stats-columns.test.ts: `pnpm stats` reads the columns the server
// writes, and counts a funnel the way docs/stats.md says. DEV-594.
//
// The premise of every table in the report: a field's column name, as
// `tools/stats/columns.mjs` derives it, is where `stats-server.ts` put that
// field's value. Checked by writing real rows through `toPoint` and reading
// each field back by name, for every field of every kind.

import { describe, expect, it } from 'vitest'
import * as schema from '@/net/stats-schema'
import { toPoint } from '@/net/stats-server'
// @ts-expect-error: a plain .mjs tool module, typed only by this test's use of it
import { columnOf, reach } from '../../tools/stats/columns.mjs'

const sample = (f: schema.StatsField, i: number): string | number => {
  if (f.kind === 'enum') return f.values[i % f.values.length] as string
  if (f.kind === 'flag') return i % 2
  if (f.kind === 'count' || f.kind === 'seconds') return Math.min(f.max, i + 1)
  if (f.name === 'build') return 'v0.20.0'
  if (f.name === 'cell') return '3:-4'
  if (f.name === 'frame') return 'assets/a.js:9'
  if (f.name === 'variant') return 'standard'
  if (f.name === 'mission') return 'int_01_hoverJet'
  // No digits: an error's words are cleaned of them on the way in.
  return `text ${f.name.replace(/[0-9]/g, '')}`
}

describe('DEV-594: the report reads each field from the column the server wrote it to', () => {
  for (const kind of Object.keys(schema.STATS_KINDS) as schema.StatsKind[]) {
    it(kind, async () => {
      const fields = schema.STATS_KINDS[kind]
      const row: Record<string, string | number> = { k: kind }
      fields.forEach((f, i) => {
        row[f.name] = sample(f, i)
      })
      const point = await toPoint(row, 'NZ')
      expect(point).not.toBeNull()
      const at = (column: string): string | number | undefined => {
        const n = Number(column.replace(/^\D+/, ''))
        return column.startsWith('blob') ? point?.blobs[n - 1] : point?.doubles[n - 1]
      }
      for (const f of fields)
        expect(at(columnOf(schema, kind, f.name)), `${kind}.${f.name}`).toBe(row[f.name])
      if (kind === 'visit') expect(at(columnOf(schema, 'visit', 'country'))).toBe('NZ')
    })
  }
})

describe('DEV-594: the funnel counts each visit once per stage it reached', () => {
  it('two sends of one visit, and a visit that left at the title', () => {
    const order = ['booted', 'title', 'hangar', 'mission', 'finished']
    const groups = [
      { stage: 'title', before: 0, n: 1 }, // visit A, first send
      { stage: 'finished', before: 2, n: 1 }, // visit A, second send
      { stage: 'title', before: 0, n: 1 }, // visit B, only send
    ]
    expect(reach(groups, order, 'stage', 'before')).toEqual([
      { step: 'booted', n: 2 },
      { step: 'title', n: 2 },
      { step: 'hangar', n: 1 },
      { step: 'mission', n: 1 },
      { step: 'finished', n: 1 },
    ])
  })
})
