// tests/unit/free-flight-courses.test.ts: Free Flight over every environment
// (DEV-625). Matt, 2026-10-04: "all maps should be available in free flight".
//
// The three new courses are DERIVED from shipped missions by
// `tools/content/free-flight-courses.mjs`, so this regenerates them and
// compares bytes (the lap-courses pattern): a re-extraction that moves a source
// mission fails here until the tool is re-run. Then it asks the questions a
// player would: is every environment the game has offered under Free Flight,
// and does each course fly as Free Flight with something to collect?

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { levelIds, loadLevel } from '@/content/load-level'
import { runningMode } from '@/game/modes'
import {
  FREE_FLIGHT_SOURCES,
  freeFlightCourse,
  REPO_ROOT,
  serialise,
} from '../../tools/content/free-flight-courses.mjs'

const read = (...parts: string[]) => fs.readFileSync(path.join(REPO_ROOT, ...parts), 'utf8')

describe('DEV-625: the generated Free Flight courses', () => {
  for (const row of FREE_FLIGHT_SOURCES) {
    it(`${row.id} is ${row.source} as Free Flight, byte for byte what the tool writes`, () => {
      const source = JSON.parse(read('content', 'levels', `${row.source}.json`))
      const want = serialise(freeFlightCourse(source, row))
      expect(read('content', 'authored', `${row.id}.json`).replace(/\r\n/g, '\n')).toBe(want)
      // Rule 11 holds on a copy too: the hook refuses an added em-dash.
      expect(want.includes(String.fromCharCode(0x2014))).toBe(false)
    })
  }
})

describe('DEV-625: every environment can be flown in Free Flight', () => {
  it('lists a HoverJet Free Flight course on every environment the game has', async () => {
    const environments = fs
      .readdirSync(path.join(REPO_ROOT, 'content', 'environments'))
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      // `menu` is the hangar's own set, not a place to fly.
      .filter((e) => e !== 'menu')
    expect(environments.length).toBeGreaterThan(3)
    const levels = await Promise.all((await levelIds()).map((id) => loadLevel(id)))
    const flown = new Set(
      levels
        .filter((l) => l.vehicle === 'hoverjet' && runningMode(l) === 'freeFlight')
        .map((l) => l.environment),
    )
    expect([...flown].sort()).toEqual(environments.sort())
  })

  it('each new course runs as Free Flight from its source mission’s spawn, with live orbs to find', async () => {
    for (const row of FREE_FLIGHT_SOURCES) {
      const course = await loadLevel(row.id)
      const source = await loadLevel(row.source)
      expect(runningMode(course)).toBe('freeFlight')
      expect(course.difficulty).toBe('beginner')
      expect(course.spawn).toEqual(source.spawn)
      expect(course.environment).toBe(source.environment)
      expect(course.orbs.filter((o) => o.live).length, `${row.id}: live orbs`).toBeGreaterThan(0)
    }
  })
})
