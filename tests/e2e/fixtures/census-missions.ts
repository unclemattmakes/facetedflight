/**
 * tests/e2e/fixtures/census-missions.ts: which missions the census gate covers.
 * DEV-909.
 *
 * Hard rule 12 and hard rule 6: the list is DERIVED from content, never typed.
 * A fourteenth mission appears here with no edit, and
 * `tests/unit/census-baseline-coverage.test.ts` turns "it has no baseline
 * entry yet" into a red `pnpm check`, so a new course cannot join the game
 * unmeasured.
 *
 * What a player reaches in Anniversary is what the menus list (`levelIds`,
 * `src/content/load-level.ts`): every generated course, plus every authored
 * course whose file says `"listed": true` and whose aircraft the edition
 * flies. This file reads the same facts off disk, because a Playwright spec
 * cannot import `load-level.ts` (its `import.meta.glob` kills the collection,
 * memory "e2e can collect zero tests"). Lessons (`mode: "lesson"`) are listed
 * too but are reached through Flight School's instructor, not flown by the
 * autopilot to a mission clock, so they are left out and a unit test names
 * the rule.
 */
import fs from 'node:fs'
import path from 'node:path'

const LEVELS = path.join('content', 'levels')
const AUTHORED = path.join('content', 'authored')
const EDITION = path.join('content', 'editions', 'anniversary.json')

export interface CensusMission {
  /** The level id, which is also the `?mission=` value. */
  readonly id: string
  readonly vehicle: string
  readonly environment: string
  readonly mode: string
}

interface LevelFile {
  readonly id: string
  readonly vehicle: string
  readonly environment: string
  readonly mode: string
  readonly listed?: boolean
}

const readLevels = (dir: string): LevelFile[] =>
  fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as LevelFile)

/**
 * The aircraft Anniversary's menus offer, read from the preset: the HoverJet
 * and the JumpSeat always, the glider only when `gameplay.glider.enabled`
 * (`PREVIEW_ONLY` takes it off a release build, and this gate runs the
 * preview build every harness runs).
 */
const anniversaryFleet = (): Set<string> => {
  const edition = JSON.parse(fs.readFileSync(EDITION, 'utf8')) as {
    gameplay: { glider?: { enabled?: boolean } }
  }
  const fleet = new Set(['hoverjet', 'jumpseat'])
  if (edition.gameplay.glider?.enabled === true) fleet.add('glider')
  return fleet
}

/** Whether a level is a Flight School lesson, which the autopilot does not fly. */
export const isLesson = (level: { mode: string }): boolean => level.mode === 'lesson'

/** Every mission the census gate covers, sorted by id. */
export const censusMissions = (): CensusMission[] => {
  const fleet = anniversaryFleet()
  const generated = readLevels(LEVELS)
  const authored = readLevels(AUTHORED).filter(
    (l) => l.listed === true && fleet.has(l.vehicle) && !isLesson(l),
  )
  return [...generated, ...authored]
    .filter((l) => !isLesson(l))
    .map((l) => ({ id: l.id, vehicle: l.vehicle, environment: l.environment, mode: l.mode }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * The fast subset: the first mission (by id) of every environment x vehicle x
 * mode pair, so each terrain generator, each aircraft's scene and each mode's
 * dressing is drawn once. Derived, so a new environment joins it on its own.
 */
export const censusFastSubset = (missions: readonly CensusMission[]): CensusMission[] => {
  const seen = new Set<string>()
  const out: CensusMission[] = []
  for (const m of missions) {
    const key = `${m.environment}/${m.vehicle}/${m.mode}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(m)
  }
  return out
}

/**
 * Which missions this run covers. `CENSUS_SWEEP` is `all` (the release gate
 * sets it), or a comma list of ids, or unset for the fast subset. This chooses
 * how many tests run and nothing about how the game behaves in any of them.
 */
export const censusSelection = (
  env: string | undefined,
  missions: readonly CensusMission[],
): CensusMission[] => {
  if (env === 'all') return [...missions]
  if (env && env.length > 0) {
    const want = new Set(env.split(',').map((s) => s.trim()))
    return missions.filter((m) => want.has(m.id))
  }
  return censusFastSubset(missions)
}
