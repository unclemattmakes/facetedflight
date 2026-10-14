// tests/unit/census-baseline-coverage.test.ts: the census gate covers every
// mission a player reaches in Anniversary, and the baseline file holds an
// entry (with an overdraw budget) for each. DEV-909.
//
// The list is derived from content (`tests/e2e/fixtures/census-missions.ts`),
// so a new course with no entry is a red `pnpm check` and not a mission that
// shipped unmeasured. The e2e spec itself runs on a GPU; this is arithmetic
// over tracked files.
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { censusFastSubset, censusMissions, censusSelection } from '../e2e/fixtures/census-missions'

const BASELINE_PATH = 'tools/perf/census-baseline.json'

interface Entry {
  readonly mission: string
  readonly edition: string
  readonly snapAt: number
  readonly overdraw?: { shaded: number; shadedOpaque: number }
}
const baselines = (): Record<string, Entry> =>
  JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as Record<string, Entry>

describe('the census gate covers every mission', () => {
  const missions = censusMissions()

  it('derives every generated course, and more', () => {
    const generated = fs
      .readdirSync('content/levels')
      .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    for (const f of generated) {
      expect(missions.map((m) => m.id)).toContain(f.replace('.json', ''))
    }
    expect(missions.length).toBeGreaterThan(generated.length)
  })

  it('leaves out an unlisted measurement fixture and a lesson', () => {
    // The `dev230_` courses are perf arms the menus never list; lessons are
    // flown by the instructor, not by the autopilot to a mission clock.
    const ids = missions.map((m) => m.id)
    expect(ids.filter((id) => id.startsWith('dev230_') || id.includes('lesson'))).toEqual([])
  })

  it('has a baseline entry for each, keyed the way the spec keys it', () => {
    const have = baselines()
    const missing = missions
      .map((m) => `${m.id}/anniversary@20`)
      .filter((key) => have[key] === undefined)
    expect(
      missing,
      'no baseline entry: write one with CENSUS_BASELINE_WRITE=<mission id> (a comma list, or all)',
    ).toEqual([])
  })

  it('has no entry for a mission that is gone', () => {
    const ids = new Set(missions.map((m) => m.id))
    const orphans = Object.entries(baselines())
      .filter(([, e]) => !ids.has(e.mission))
      .map(([key]) => key)
    expect(orphans).toEqual([])
  })

  it('stores a shaded overdraw budget on every entry', () => {
    const lacking = Object.entries(baselines())
      .filter(([, e]) => !(e.overdraw && e.overdraw.shaded > 0 && e.overdraw.shadedOpaque > 0))
      .map(([key]) => key)
    expect(lacking).toEqual([])
  })
})

describe('the fast subset', () => {
  const missions = censusMissions()

  it('draws each environment, aircraft and mode once, and is smaller than the whole', () => {
    const subset = censusFastSubset(missions)
    expect(subset.length).toBeGreaterThan(0)
    expect(subset.length).toBeLessThan(missions.length)
    const pairs = new Set(missions.map((m) => `${m.environment}/${m.vehicle}/${m.mode}`))
    expect(subset.length).toBe(pairs.size)
  })

  it('is what an unset sweep selects; `all` and a list select as they say', () => {
    expect(censusSelection(undefined, missions)).toEqual(censusFastSubset(missions))
    expect(censusSelection('all', missions)).toEqual(missions)
    const first = missions[0]?.id as string
    expect(censusSelection(first, missions).map((m) => m.id)).toEqual([first])
  })
})
