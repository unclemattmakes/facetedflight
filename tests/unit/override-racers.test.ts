// tests/unit/override-racers.test.ts — the headless racer proof over every
// shipped-course override. DEV-541 (plan/SHIPPED-COURSE-EDITS.md §6.3, §9).
//
// The AI racers fly `level.route`, not ring to ring, so an override that moves
// a ring without its line, or a line without its rings, gives racers that fly
// past a ring's place on the line and turn back for it. This file flies EVERY
// file in `content/overrides/` — Matt's, as he saves them; none is an agent's
// (§9) — through `proveCourse` (`helpers/override-race.ts`, which says what is
// measured and why): the AI racers of BOTH rule sets, each taking every ring
// from the line and finishing inside the mission's own time limit.
//
//   both rule sets   Anniversary's, which every run flies whatever LOOK was
//                    chosen (D35: Classic is a look, so both looks fly these
//                    rules and race these five), and Classic's, the 2016 rules
//                    `?rules=classic` keeps for the tests: 2016's two racers,
//                    no lanes, no contact, no crash.
//   the DEV-494 floor  the racers' tunings as shipped, whose aim floor is
//                    asserted on below rather than set here.
//   in the air       always (CI has no terrain). And over the mission's own
//                    ground where the gitignored maps are, crash and all.
//
// It iterates the DIRECTORY, so a new override is proved the run after it is
// saved, with no edit here. `_`-prefixed files are fixtures and never ship
// (`load-level.ts` leaves them out of its glob); the proof's own tests use
// fixtures, and one of them — a line that misses a ring — is held RED.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { type Edition, validateEdition } from '@/content/edition-schema'
import {
  applyOverride,
  manifestShaOf,
  OVERRIDE_FIELDS,
  validateOverride,
} from '@/content/level-override'
import { type Level, liveRings, validateLevel } from '@/content/level-schema'
import {
  generatedLevelIds,
  loadBaselineLevel,
  loadLevel,
  overriddenLevelIds,
} from '@/content/load-level'
import {
  distanceToLine,
  editLine,
  emptyOverride,
  isShippedEditable,
  linePoints,
  moveLinePoint,
  overrideText,
  type ShippedDraft,
} from '@/editor/core/shipped'
import { rulesFor, runningMode, validateModeContent } from '@/game/modes'
import { racerStarts } from '@/game/racer-grid'
import { AI_RACER_TUNINGS } from '@/sim/ai-racer'
import { DEFAULT_AUTOPILOT } from '@/sim/autopilot'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'
import { proveCourse } from './helpers/override-race'
import { REPO as ROOT } from './helpers/repo-root'
import { fieldFor, haveMaps } from './helpers/terrain-field'

const OVERRIDES = path.join(ROOT, 'content', 'overrides')
const MANIFEST = fs.readFileSync(path.join(ROOT, 'content', '_generated.sha256'), 'utf8')
const RED_FIXTURE = path.join(ROOT, 'tests', 'unit', 'fixtures', 'dev541-line-misses-a-ring.json')
const GREEN_FIXTURE = path.join(OVERRIDES, '_fixture_int_01_hoverJet.json')

const ANNIVERSARY = validateEdition(anniversaryJson as unknown as Edition)
const CLASSIC = validateEdition(classicJson as unknown as Edition)
/** Every rule set a lap can be flown under: the shipped one, and 2016's. */
const PRESETS = [ANNIVERSARY, CLASSIC] as const

/** A race is a few hundred thousand fixed steps; generous, for a loaded box. */
const RACE_MS = 120_000

/** The override files that SHIP: every `.json` in the directory but a `_` fixture or the schema. */
const shippedOverrideIds = (): string[] =>
  fs
    .readdirSync(OVERRIDES)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort()

/** The level the loader builds from `base` and an override object: `loadLevel`'s chain. */
const withOverride = (base: Level, ov: unknown): Level =>
  validateModeContent(validateLevel(applyOverride(base, ov)))

const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'))

/** The ground a mission flies over, as a race takes it. */
const groundOf = (level: Level) => [fieldFor(level as unknown as Parameters<typeof fieldFor>[0])]

/** A shipped draft of `id`, as the desk opens it with no file on disk. */
const draftOf = async (id: string): Promise<ShippedDraft> => {
  const base = await loadBaselineLevel(id)
  return {
    base,
    override: emptyOverride(base, manifestShaOf(MANIFEST, id) as string),
    selection: null,
  }
}

/** The editable missions whose mode races: where the proof flies racers. */
const racingEditable = async (): Promise<Level[]> => {
  const out: Level[] = []
  for (const id of generatedLevelIds()) {
    const base = await loadBaselineLevel(id)
    if (isShippedEditable(base) && rulesFor(runningMode(base)).opponents) out.push(base)
  }
  return out
}

// ── The proof, over every override that ships ──────────────────────────────

describe('DEV-541 — every override in content/overrides/ passes the racer proof', () => {
  it('the directory and the loader agree on which overrides ship', () => {
    // Two readings of one directory: the file system's, and the game's own
    // glob (`load-level.ts`). A file one of them missed would be a course the
    // game flies and this file never proves, or the reverse.
    expect(shippedOverrideIds()).toEqual(overriddenLevelIds())
  })

  for (const id of shippedOverrideIds()) {
    it(
      `${id}: the AI racers take every ring from the line and finish, both rule sets, in the air`,
      async () => {
        const level = await loadLevel(id)
        expect(level._override, 'the loader applied the override').toBeDefined()
        const problems = proveCourse(level, PRESETS)
        expect(problems, problems.join('\n')).toEqual([])
      },
      RACE_MS,
    )
    it.skipIf(!haveMaps)(
      `${id}: the same, over the mission's own ground`,
      async () => {
        const level = await loadLevel(id)
        const problems = proveCourse(level, PRESETS, groundOf(level))
        expect(problems, problems.join('\n')).toEqual([])
      },
      RACE_MS,
    )
  }
})

// ── The proof itself: what it flies, and that it can fail ──────────────────

describe('DEV-541 — the proof', () => {
  it('flies the racers as shipped: the DEV-494 aim floor is on for every tuning', () => {
    expect(DEFAULT_AUTOPILOT.routeAimMinMetres).toBeGreaterThan(0)
    for (const [name, tuning] of Object.entries(AI_RACER_TUNINGS)) {
      expect(tuning.routeAimMinMetres, name).toBe(DEFAULT_AUTOPILOT.routeAimMinMetres)
    }
  })

  it('flies two different grids: Anniversary’s five racers, and 2016’s two', async () => {
    // A proof that flew one preset twice would pass for both and prove one.
    const level = await loadBaselineLevel('int_01_hoverJet')
    expect(racerStarts(level, ANNIVERSARY.gameplay.racers)).toHaveLength(5)
    expect(racerStarts(level, CLASSIC.gameplay.racers)).toHaveLength(2)
    expect(CLASSIC.gameplay.racers.separation.enabled).toBe(false)
    expect(ANNIVERSARY.gameplay.racers.separation.enabled).toBe(true)
  })

  it(
    'passes on every racing course as 2016 shipped it (the premise: a red is the edit’s)',
    async () => {
      const courses = await racingEditable()
      expect(courses.length, 'the racing HoverJet courses').toBeGreaterThan(0)
      for (const base of courses) {
        const problems = proveCourse(base, PRESETS)
        expect(problems, problems.join('\n')).toEqual([])
      }
    },
    RACE_MS,
  )

  it(
    'passes on the line “Edit the line” seeds for every editable mission',
    async () => {
      for (const id of generatedLevelIds()) {
        const d = await draftOf(id)
        if (!isShippedEditable(d.base)) continue
        const edited = editLine(d)
        expect(linePoints(edited), `${id} has its own line`).not.toBeNull()
        const level = withOverride(d.base, edited.override)
        const problems = proveCourse(level, PRESETS)
        expect(problems, problems.join('\n')).toEqual([])
      }
    },
    RACE_MS,
  )

  it(
    'passes on the loader’s own fixture (rings moved, removed and added, the line refitted)',
    async () => {
      const base = await loadBaselineLevel('int_01_hoverJet')
      const problems = proveCourse(withOverride(base, readJson(GREEN_FIXTURE)), PRESETS)
      expect(problems, problems.join('\n')).toEqual([])
    },
    RACE_MS,
  )

  describe('goes RED on a line that misses a ring', () => {
    const fixture = (): Record<string, unknown> => readJson(RED_FIXTURE) as Record<string, unknown>

    it('the fixture is an override the loader takes, and holds nothing but a line', () => {
      const checked = validateOverride(fixture())
      expect(checked.ok).toBe(true)
      const keys = Object.keys(fixture()).filter(
        (k) => !['$schema', 'v', 'mission', 'base', 'notes'].includes(k),
      )
      expect(keys).toEqual(['route'])
      expect(Object.keys(fixture().route as object)).toEqual([...OVERRIDE_FIELDS.route])
    })

    it('the premise, by geometry: its line passes ring 6 further off than the ring’s trigger reaches', async () => {
      const base = await loadBaselineLevel('int_01_hoverJet')
      const level = withOverride(base, fixture())
      const ring = liveRings(level)[5]
      expect(ring).toBeDefined()
      const off = distanceToLine(ring?.trigger.pos ?? [], level.route ?? [])
      expect(off).toBeGreaterThan(ring?.trigger.radius ?? Number.POSITIVE_INFINITY)
      // And ONLY ring 6: every other trigger is on the line, so the red below
      // is about the ring the fixture moved the line off.
      liveRings(level).forEach((r, k) => {
        if (k !== 5)
          expect(distanceToLine(r.trigger.pos, level.route ?? [])).toBeLessThan(r.trigger.radius)
      })
    })

    it(
      'every racer, under both rule sets, is caught turning back for ring 6',
      async () => {
        const base = await loadBaselineLevel('int_01_hoverJet')
        const problems = proveCourse(withOverride(base, fixture()), PRESETS)
        const ring6 = problems.filter((p) => p.includes('took ring 6 ') && p.includes('PAST'))
        // Anniversary's five and 2016's two: seven racers, seven faults at ring 6.
        expect(ring6, problems.join('\n')).toHaveLength(
          racerStarts(base, ANNIVERSARY.gameplay.racers).length +
            racerStarts(base, CLASSIC.gameplay.racers).length,
        )
        expect(
          problems.filter((p) => !p.includes('ring 6 ')),
          problems.join('\n'),
        ).toEqual([])
      },
      RACE_MS,
    )

    it(
      'and taking every ring alone would have called it green: every racer took all 21 and finished',
      async () => {
        // The measurement that made the proof ask WHERE a ring is taken
        // (`helpers/override-race.ts`): the missed-ring recovery fetches it.
        const base = await loadBaselineLevel('int_01_hoverJet')
        const problems = proveCourse(withOverride(base, fixture()), PRESETS)
        expect(
          problems.filter((p) => p.includes('never took') || p.includes('did not reach')),
        ).toEqual([])
      },
      RACE_MS,
    )
  })

  describe('a mission nobody races is held to its line’s geometry', () => {
    it('hoverJet_kauai_beg is Free Flight, which races nobody', async () => {
      const base = await loadBaselineLevel('hoverJet_kauai_beg')
      expect(isShippedEditable(base)).toBe(true)
      expect(rulesFor(runningMode(base)).opponents).toBe(false)
      expect(proveCourse(base, PRESETS)).toEqual([])
    })

    it('and a line pushed off one of its rings is refused', async () => {
      let d = editLine(await draftOf('hoverJet_kauai_beg'))
      const points = linePoints(d) ?? []
      const ring = liveRings(d.base)[5]
      // The control point nearest ring 6, pushed straight up 80 m.
      let j = 0
      points.forEach((p, i) => {
        const q = points[j] ?? p
        const at = ring?.trigger.pos ?? [0, 0, 0]
        if (
          Math.hypot(p[0] - at[0], p[1] - at[1], p[2] - at[2]) <
          Math.hypot(q[0] - at[0], q[1] - at[1], q[2] - at[2])
        )
          j = i
      })
      const p = points[j] ?? [0, 0, 0]
      d = moveLinePoint(d, j, [p[0], p[1] + 80, p[2]])
      expect(overrideText(d.override)).not.toBeNull()
      const problems = proveCourse(withOverride(d.base, d.override), PRESETS)
      expect(problems.some((m) => m.includes('ring 6'))).toBe(true)
    })
  })
})

// ── Over the ground ─────────────────────────────────────────────────────────
//
// Behind the gitignored height maps, so absent on CI. The loud counterpart for
// `haveMaps` is `custom-ground.test.ts`'s (DEV-489): the same guard, and one
// counterpart per missing asset keeps a hydrated tree's skip count where it
// was (`racer-lanes-clear.test.ts` does the same for the forest).

describe.skipIf(!haveMaps)('DEV-541 — the proof over the ground', () => {
  it(
    'passes on every racing course as 2016 shipped it, over its own ground',
    async () => {
      for (const base of await racingEditable()) {
        const problems = proveCourse(base, PRESETS, groundOf(base))
        expect(problems, problems.join('\n')).toEqual([])
      }
    },
    RACE_MS,
  )

  it(
    'and is red on the line that misses ring 6, over the ground as in the air',
    async () => {
      const base = await loadBaselineLevel('int_01_hoverJet')
      const level = withOverride(base, readJson(RED_FIXTURE))
      const problems = proveCourse(level, PRESETS, groundOf(level))
      expect(problems.some((p) => p.includes('took ring 6 ') && p.includes('PAST'))).toBe(true)
    },
    RACE_MS,
  )
})
