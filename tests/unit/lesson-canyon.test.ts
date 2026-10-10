// tests/unit/lesson-canyon.test.ts — the two canyon lessons. DEV-378.
//
// Matt, 2026-09-24: *"want to learn to fly - add an ai-pilot flight instructor
// course through the canyon"*. `docs/plan/FLIGHT-INSTRUCTOR.md` §3 is the
// lesson, §8 the authoring, §9 DEV-378 this file:
//
//   - `content/authored/lesson_01_canyon.json` — the basics, on Mesa Canyon's
//     Beginner course (`rookie_02_hoverJet`'s rings, line and finish, copied);
//   - `content/authored/lesson_02_canyon_run.json` — the canyon proper,
//     `adv_01_hoverJet`'s second half (its rings 10 to 21 and its line from
//     just short of them, sliced), from an airborne spawn.
//
// ── Three kinds of test, and what each is measured against ────────────────
//
//  1. DRIFT GUARDS (CI-safe). A copied block is a hand-typed constant unless
//     something checks it (hard rule 3), so every field a lesson says it
//     copied deep-equals the GENERATED file, every ring and turn indicator it
//     sliced deep-equals the source's of the same name, and its line is a
//     contiguous slice of the source's. The airborne spawn is re-derived from
//     the source line. And every key of each file is accounted for, so a field
//     the extractor adds, or one a hand adds, has to be decided about.
//  2. CONTENT RULES (CI-safe). A lesson's `lost` interrupt must not fire on a
//     student flying straight at the next gate; lesson 2 uses no trigger
//     lesson 1 does not (§8: the second course is the proof a course is a
//     file); and the leg table's arithmetic reproduces the plan's measured
//     §2.1 table — a number outside this code.
//  3. THE GOLDEN LESSONS (the height maps and the forest, so not on CI). Each
//     lesson flown headless on the real desert by a scripted student
//     (`helpers/lesson-flight.ts`), on both presets and every HoverJet
//     variant: every step ends on its own trigger inside its stated bound, no
//     interrupt, no crash, the instructor within `waitBeyondMetres` whenever
//     the student flies, and the lesson over inside a stated time. And the
//     negative control: a step whose trigger the student cannot meet STALLS
//     the lesson there, so a green golden run is evidence rather than an
//     absence of failure. Disk work sits inside each `it`, with the loud
//     counterpart below it (CLAUDE.md's `skipIf` trap).
//
// **The mode is never spelled here**: the teaching row is found by asking.

import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { type Edition, validateEdition } from '@/content/edition-schema'
import type { Lesson, LessonTrigger, Level } from '@/content/level-schema'
import { aircraftFor } from '@/content/load-aircraft'
import { loadLevel } from '@/content/load-level'
import { courseGates } from '@/game/mission'
import { rulesFor } from '@/game/modes'
import { threeQuatTupleToUnity } from '@/render/unity-space'
import { gateArcLengths } from '@/sim/ai-racer'
import { hoverJetView } from '@/sim/hoverjet'
import { rotateVec3 } from '@/sim/math/quat'
import { v3 } from '@/sim/math/vec3'
import type { PropCollisionSpec } from '@/sim/props/collision'
import { createRoute, routeAt, routeDistance, routeRightAt, routeTangentAt } from '@/sim/route'
import { outsideField, terrainHeightAt } from '@/sim/terrain/height-field'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'
import { legTable } from '../../tools/content/leg-table.mjs'
import {
  flyLesson,
  type LessonFlight,
  type LessonFlightOptions,
  type StudentScript,
} from './helpers/lesson-flight'
import { forestFor, haveForest } from './helpers/prop-forest'
import { fieldFor, haveMaps } from './helpers/terrain-field'

// biome-ignore lint/suspicious/noExplicitAny: a level file is read as raw JSON, before the types
type Raw = Record<string, any>
const raw = (path: string): Raw => JSON.parse(fs.readFileSync(path, 'utf8')) as Raw
const authored = (id: string): Raw => raw(`content/authored/${id}.json`)
const generated = (id: string): Raw => raw(`content/levels/${id}.json`)

const L1 = 'lesson_01_canyon'
const L2 = 'lesson_02_canyon_run'

/** The fields a lesson authors itself (its `_authored.authored.fields`) plus the bookkeeping. */
const BOOKKEEPING = ['_authored']
/**
 * What a lesson leaves behind of its source, and why: the source's own
 * provenance (`$schema`, `_meta`) describes the EXTRACTED file, and the rest
 * are what a lesson is not (in 2016's chain, a race, medalled, raced by
 * ghosts). Every other source key must be copied, sliced or authored.
 */
const LEFT_BEHIND = [
  '$schema',
  '_meta',
  'id',
  'title',
  'mode',
  'chainIndex',
  'inChain',
  'medals',
  'medalsFf2',
  'medalsExp',
  'ghosts',
]

/** Every trigger in a lesson, `sequence` members and interrupts' `on` and `until` included. */
const triggersOf = (lesson: Lesson): LessonTrigger[] => {
  const out: LessonTrigger[] = []
  const walk = (t: LessonTrigger): void => {
    out.push(t)
    if (t.kind === 'sequence') for (const m of t.of) walk(m)
  }
  for (const s of lesson.steps) walk(s.until)
  for (const i of lesson.interrupts) {
    walk(i.on)
    walk(i.until)
  }
  return out
}

describe('both lessons load, teach, and award nothing; the front door lists them', () => {
  for (const id of [L1, L2]) {
    it(`${id}`, async () => {
      const level = await loadLevel(id)
      expect(rulesFor(level.mode).teaches).toBe(true)
      expect(level.lesson?.steps.length ?? 0).toBeGreaterThan(0)
      // LISTED since DEV-379, WITH the mark that tells the plan apart: listed
      // alone, the hangar dealt a fourth HoverJet flight plan standing Ring
      // Attack's gate, because DEV-354's mark asked `scores()` and a lesson
      // scores rings. Now a teaching plan stands the instructor's hull
      // (FLIGHT-INSTRUCTOR §7), `mode-mark.test.ts` holds every plan to a
      // different mark, and `mission-index.test.ts`'s slot order carries the
      // mode. The title's Learn to Fly row boards from the same list.
      expect(level.listed).toBe(true)
      expect(Object.values(level.medals)).toEqual([null, null, null, null])
      expect(level.medalsFf2 ?? null).toBeNull()
      // Not in 2016's campaign chain: `Button_Next.cs` never knew a lesson.
      expect(level.chainIndex).toBeNull()
      expect(level.ghosts).toEqual([])
      // A HoverJet course in the canyon, flown by the racer that teaches.
      expect(level.vehicle).toBe('hoverjet')
      expect(level.environment).toBe('desert')
    })
  }
})

describe(`${L1}: rookie_02_hoverJet's course, copied and guarded`, () => {
  const file = authored(L1)
  const copied = file._authored.copiedFrom
  const source = generated(copied.level)

  it('copies from the Beginner course in the canyon', () => {
    expect(copied.level).toBe('rookie_02_hoverJet')
    expect(source.environment).toBe('desert')
    expect(source.difficulty).toBe('beginner')
  })

  it('every copied field deep-equals the generated file', () => {
    expect(copied.fields.length).toBeGreaterThan(0)
    for (const f of copied.fields as string[]) {
      expect(f in source, `${f} is not in the source`).toBe(true)
      expect(file[f], `${f} has drifted from ${copied.level}`).toEqual(source[f])
    }
    // The ones that matter most, named so a reader sees them.
    for (const f of ['routes', 'route', 'finish', 'turnIndicators', 'respawn']) {
      expect(copied.fields).toContain(f)
    }
  })

  it("starts at the top of rookie_02's lift, not at its foot (DEV-409)", () => {
    // Authored since DEV-409, so it is guarded here against the source instead
    // of deep-equalled: the same seat, the same heading and the same start
    // grid, raised by the source's own ride.
    expect(copied.fields).not.toContain('spawn')
    const mine = file.spawn
    const theirs = source.spawn
    expect(theirs.launchKind).toBe('elevator')
    expect(mine.pos[0]).toBe(theirs.pos[0])
    expect(mine.pos[2]).toBe(theirs.pos[2])
    expect(mine.pos[1]).toBeCloseTo(theirs.pos[1] + theirs.launch.rise, 5)
    expect(mine.quat).toEqual(theirs.quat)
    expect(mine.yaw).toBe(theirs.yaw)
    expect(mine.startGrid).toEqual(theirs.startGrid)
  })

  it('accounts for every key: copied, authored, or deliberately left behind', () => {
    const mine = [...copied.fields, ...file._authored.authored.fields, ...BOOKKEEPING]
    expect(Object.keys(file).sort()).toEqual([...new Set(mine)].sort())
    const behind = Object.keys(source).filter((k) => !copied.fields.includes(k))
    // DEV-409: `spawn` is authored now (the top of the lift), guarded above.
    expect(behind.sort(), 'a new source field needs a decision').toEqual(
      [...LEFT_BEHIND.filter((k) => k in source), 'spawn'].sort(),
    )
  })
})

describe(`${L2}: adv_01_hoverJet's canyon half, sliced and guarded`, () => {
  const file = authored(L2)
  const copied = file._authored.copiedFrom
  const sliced = file._authored.slicedFrom
  const source = generated(copied.level)
  const from = sliced.rings.from as number

  it("is the Professional course's canyon half, from its ring 10", () => {
    expect(copied.level).toBe('adv_01_hoverJet')
    expect(sliced.level).toBe(copied.level)
    expect(from).toBe(10)
  })

  it('every copied field deep-equals the generated file', () => {
    for (const f of copied.fields as string[]) {
      expect(f in source, `${f} is not in the source`).toBe(true)
      expect(file[f], `${f} has drifted from ${copied.level}`).toEqual(source[f])
    }
    expect(copied.fields).toContain('finish')
  })

  it("every ring deep-equals the source ring of the same name, and they are the source's from ring 10 on", () => {
    const mine = file.routes.flatMap((r: Raw) => r.rings)
    const theirs = source.routes.flatMap((r: Raw) => r.rings)
    for (const ring of mine) {
      const same = theirs.find((r: Raw) => r.name === ring.name)
      expect(same, `${ring.name} is not in ${copied.level}`).toBeDefined()
      expect(ring).toEqual(same)
    }
    // Contiguous, in order, to the end: the canyon half, not a selection.
    expect(mine.map((r: Raw) => r.name)).toEqual(theirs.slice(from).map((r: Raw) => r.name))
    expect(file.routes.map((r: Raw) => r.id)).toEqual(source.routes.map((r: Raw) => r.id))
  })

  it("the line is a contiguous slice of the source's, to its end", () => {
    const start = sliced.line.fromVertex as number
    expect(start).toBeGreaterThan(0)
    expect(file.route).toEqual(source.route.slice(start))
  })

  it("keeps exactly the turn indicators that belong to the kept rings, each the source's own", () => {
    const rings = source.routes.flatMap((r: Raw) => r.rings)
    const nearestRing = (pos: readonly [number, number, number]): number => {
      let best = Number.POSITIVE_INFINITY
      let at = -1
      rings.forEach((r: Raw, i: number) => {
        const d = Math.hypot(r.pos[0] - pos[0], r.pos[1] - pos[1], r.pos[2] - pos[2])
        if (d < best) {
          best = d
          at = i
        }
      })
      return at
    }
    const expected = source.turnIndicators.filter((t: Raw) => nearestRing(t.pos) >= from)
    expect(expected.length).toBeGreaterThan(0)
    expect(file.turnIndicators).toEqual(expected)
  })

  it('spawns on the source line, the stated distance short of ring 10, level and nose along it', () => {
    // Re-derived from the SOURCE line, in sim space, through the sim's own
    // route functions — not read back off the file.
    const route = createRoute(source.route)
    const gates = courseGates(source as unknown as Level)
    const ringArc = gateArcLengths(route, gates)[from] as number
    const s = ringArc - (file._authored.geometry.spawnBeforeRingMetres as number)
    const want = routeAt(route, s, v3())
    const pos = file.spawn.pos as [number, number, number]
    // THREE -> sim is the z mirror.
    expect(Math.hypot(pos[0] - want.x, pos[1] - want.y, -pos[2] - want.z)).toBeLessThan(0.05)
    // The nose: level, and along the line's heading there. Measured on the
    // GEOMETRY (the body's forward axis against the line's tangent), not by
    // comparing quaternions — the orientation lesson.
    const q = threeQuatTupleToUnity({ x: 0, y: 0, z: 0, w: 1 }, file.spawn.quat as number[])
    const nose = rotateVec3(v3(), q, v3(0, 0, 1))
    const along = routeTangentAt(route, s, v3())
    const flat = Math.hypot(along.x, along.z)
    const off = Math.acos(
      Math.min(1, (nose.x * along.x + nose.z * along.z) / (flat * Math.hypot(nose.x, nose.z))),
    )
    expect((off * 180) / Math.PI).toBeLessThan(0.5)
    expect(Math.abs(nose.y)).toBeLessThan(1e-6)
    // A hover: no lift to ride, and a restart begins where the run began.
    expect(file.spawn.launchKind).toBe('direct')
    expect(file.spawn.launch).toBeUndefined()
    expect(file.respawn.pos).toEqual(file.spawn.pos)
    expect(file.respawn.quat).toEqual(file.spawn.quat)
  })

  it('accounts for every key: copied, sliced, authored, or deliberately left behind', () => {
    const slicedFields = [
      ...sliced.rings.fields,
      ...sliced.line.fields,
      ...sliced.turnIndicators.fields,
    ]
    const mine = [
      ...copied.fields,
      ...slicedFields,
      ...file._authored.authored.fields,
      ...BOOKKEEPING,
    ]
    expect(Object.keys(file).sort()).toEqual([...new Set(mine)].sort())
    const behind = Object.keys(source).filter(
      (k) => !copied.fields.includes(k) && !slicedFields.includes(k),
    )
    // The spawn and respawn are replaced by the airborne pair, not copied.
    expect(behind.sort(), 'a new source field needs a decision').toEqual(
      [...LEFT_BEHIND, 'spawn', 'respawn'].filter((k) => k in source).sort(),
    )
  })

  it('uses no trigger lesson 1 does not: the second course needs no code', async () => {
    const one = new Set(triggersOf((await loadLevel(L1)).lesson as Lesson).map((t) => t.kind))
    const two = triggersOf((await loadLevel(L2)).lesson as Lesson).map((t) => t.kind)
    for (const kind of two) expect(one.has(kind), kind).toBe(true)
  })
})

describe('a student flying straight at the next gate is never "lost"', () => {
  // FLIGHT-INSTRUCTOR §3's `lost` interrupt (`offLineBeyond`) is for a player
  // going somewhere the course does not. So no straight leg of the course — the
  // start to ring 0, ring to ring, the last ring to the finish — may stray that
  // far from the racing line. Measured, not assumed: `adv_01`'s finish sits
  // 178 m off its own line and its hairpin legs cut 124 m inside it, which is
  // why lesson 2's threshold is not lesson 1's. An interrupt that fires on the
  // run home also HOLDS the finish step (DEV-377's rule 2), and `lost` does not
  // clear until the student is back within `onLineWithin` of a line they have
  // finished flying.
  for (const id of [L1, L2]) {
    it(`${id}`, async () => {
      const level = await loadLevel(id)
      const lost = level.lesson?.interrupts.find((i) => i.on.kind === 'offLineBeyond')
      expect(lost, 'the lesson has a lost interrupt').toBeDefined()
      const beyond = lost?.on.kind === 'offLineBeyond' ? lost.on.metres : 0
      const route = createRoute((level as unknown as { route: number[][] }).route)
      const gates = courseGates(level)
      const start = v3(level.spawn.pos[0], level.spawn.pos[1], -(level.spawn.pos[2] as number))
      if (level.spawn.launchKind === 'elevator') start.y += level.spawn.launch?.rise ?? 0
      const f = level.finish?.pos as number[]
      const way = [start, ...gates.map((g) => g.centre), v3(f[0], f[1], -(f[2] as number))]
      let worst = 0
      for (let k = 0; k + 1 < way.length; k++) {
        const a = way[k] as { x: number; y: number; z: number }
        const b = way[k + 1] as { x: number; y: number; z: number }
        for (let t = 0; t <= 1; t += 1 / 40) {
          const p = v3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t)
          worst = Math.max(worst, routeDistance(route, p))
        }
      }
      expect(worst, `the straightest course reads ${worst.toFixed(0)} m off the line`).toBeLessThan(
        beyond,
      )
    })
  }
})

describe('the leg table (tools/content/leg-table.mjs) reproduces the plan', () => {
  const deps = {
    createRoute,
    gateArcLengths,
    routeRightAt,
    terrainHeightAt,
    outsideField,
  } as unknown as Parameters<typeof legTable>[1]

  it("rookie_02's legs, turns and line: FLIGHT-INSTRUCTOR §2.1, and DEV-376's ring-0 correction", () => {
    const t = legTable(generated('rookie_02_hoverJet'), deps)
    expect(t.rings.length).toBe(21)
    // §2.1: "the racing line is 10,538 m".
    expect(Math.round(t.lineMetres)).toBe(10538)
    // DEV-376 §5: ring 0 is 88.5 m from the TOP of the lift (§2.1's 149 was
    // measured from the bottom of the shaft).
    expect(t.start).toBe('lift top')
    expect(t.rings[0]?.leg).toBeGreaterThan(88)
    expect(t.rings[0]?.leg).toBeLessThan(89)
    // §2.1's two real corners, the first real corner and the hairpin.
    expect(Math.round(t.rings[10]?.turn ?? 0)).toBe(65)
    expect(Math.round(t.rings[11]?.turn ?? 0)).toBe(83)
    expect(t.turnsOver60).toBe(2)
    // "Legs are a near-constant ~470 m (sum 9,488 m ring to ring)". That sum
    // includes §2.1's ring-0 leg of 149 m from the BOTTOM of the shaft: ring
    // to ring, rings 1 to 20, it is 9,488 less that leg, to the metre or two
    // the plan rounded to.
    const legs = t.rings.slice(1).map((r) => r.leg)
    for (const leg of legs) {
      expect(leg).toBeGreaterThan(430)
      expect(leg).toBeLessThan(490)
    }
    expect(Math.abs(legs.reduce((a, b) => a + b, 0) - (9488 - 149))).toBeLessThan(3)
    // The 213 m climb to ring 4 and the 700 m climb over rings 17-19.
    expect(Math.round(t.rings[4]?.climb ?? 0)).toBe(213)
    expect(Math.round((t.rings[19]?.y ?? 0) - (t.rings[16]?.y ?? 0))).toBe(699)
  })

  it.skipIf(!haveMaps)("the walls: FLIGHT-INSTRUCTOR §2.6's table, on both canyon courses", () => {
    // Inside the `it`: the maps are gitignored (CLAUDE.md's skipIf trap).
    const r2 = legTable(
      generated('rookie_02_hoverJet'),
      deps,
      fieldFor(generated('rookie_02_hoverJet') as never),
    )
    expect([r2.bothSides, r2.oneSide, r2.measuredVertices]).toEqual([77, 234, 421])
    expect([r2.agl.p10, r2.agl.p50, r2.agl.p90].map(Math.round)).toEqual([30, 124, 280])
    const a1 = legTable(
      generated('adv_01_hoverJet'),
      deps,
      fieldFor(generated('adv_01_hoverJet') as never),
    )
    expect([a1.bothSides, a1.oneSide, a1.measuredVertices]).toEqual([244, 76, 441])
    expect([a1.agl.p10, a1.agl.p50, a1.agl.p90].map(Math.round)).toEqual([26, 83, 177])
    // And lesson 2 is the canyon: most of its line runs between walls.
    const l2 = legTable(authored(L2), deps, fieldFor(authored(L2) as never))
    expect(l2.bothSides / l2.measuredVertices).toBeGreaterThan(0.8)
  })
})

// ── The golden lessons ───────────────────────────────────────────────────────

const EDITIONS: readonly [string, Edition][] = [
  ['anniversary', validateEdition(anniversaryJson as unknown as Edition)],
  ['classic', validateEdition(classicJson as unknown as Edition)],
]

/**
 * What a step must do in the golden run: end by the time `endsBy` rings have
 * been passed (the LEG it is written for — FLIGHT-INSTRUCTOR §3, and the leg
 * table), within `within` seconds of coming up.
 */
interface StepBound {
  readonly endsBy: number
  readonly within: number
}

interface Golden {
  readonly id: string
  readonly script: StudentScript
  readonly bounds: Readonly<Record<string, StepBound>>
  /** Seconds from the release to the finish. */
  readonly flyingWithin: number
  /** A step to break, and how, for the negative control. */
  readonly breakStep: { readonly id: string; readonly until: LessonTrigger }
}

const GOLDEN: readonly Golden[] = [
  {
    id: L1,
    // The student does what each plate says. Speeds sit under the instructor's
    // cap for the step (a student following), except where the plate says
    // otherwise: HOLD the throttle (the stick fully forward), and boost.
    script: {
      // DEV-409: no lift to ride, so nothing to press before the first step.
      launchAfter: 0,
      steps: {
        throttle: { speed: 90 },
        climb: { speed: 50 },
        thread: { speed: 50 },
        bank: { speed: 40, bank: { rollTo: 40, releaseSeconds: 1 } },
        turning: { speed: 55 },
        boost: { speed: 135, boost: true },
        corner: { speed: 95 },
        canyon: { speed: 80 },
        home: { speed: 'race' },
      },
    },
    bounds: {
      // DEV-409: the lesson starts at the top of the shaft with no ride and no
      // countdown, so this is the first step; it ends on the climb's leg,
      // before ring 1.
      throttle: { endsBy: 1, within: 30 },
      climb: { endsBy: 2, within: 20 },
      thread: { endsBy: 4, within: 35 },
      // On its own leg, ring 3 to ring 4 (481 m).
      bank: { endsBy: 4, within: 12 },
      turning: { endsBy: 7, within: 35 },
      // On the straight: over before the first real corner, ring 10 (65°).
      boost: { endsBy: 10, within: 12 },
      corner: { endsBy: 12, within: 35 },
      canyon: { endsBy: 14, within: 25 },
      home: { endsBy: 21, within: 60 },
    },
    flyingWithin: 200,
    // The student rolls to 40° and lets go (it drifts on to ~72°): a bank step
    // asking for 150° cannot end.
    breakStep: {
      id: 'bank',
      until: {
        kind: 'sequence',
        of: [
          { kind: 'bankAtLeast', degrees: 150 },
          { kind: 'levelFor', degrees: 5, seconds: 1.5 },
        ],
      },
    },
  },
  {
    id: L2,
    script: {
      launchAfter: 0,
      steps: {
        in: { speed: 50 },
        corner: { speed: 45 },
        esses: { speed: 50 },
        hairpin: { speed: 40 },
        straight: { speed: 115, boost: true },
        last: { speed: 80 },
        home: { speed: 'race' },
      },
    },
    bounds: {
      in: { endsBy: 1, within: 12 },
      corner: { endsBy: 2, within: 20 },
      esses: { endsBy: 4, within: 35 },
      hairpin: { endsBy: 5, within: 20 },
      // On the straight: over before ring 7's 91° turn.
      straight: { endsBy: 7, within: 15 },
      last: { endsBy: 9, within: 30 },
      home: { endsBy: 12, within: 40 },
    },
    flyingWithin: 150,
    // A straight step asking for 400 m/s, which no HoverJet reaches unchained.
    breakStep: { id: 'straight', until: { kind: 'speedAtLeast', mps: 400, forSeconds: 1 } },
  },
]

/** Fly one golden lesson. Everything that reads the disk is in here, called from inside an `it`. */
const fly = async (
  g: Golden,
  edition: Edition,
  variant: string,
  lesson?: Lesson,
  extra: Partial<LessonFlightOptions> = {},
): Promise<{ flight: LessonFlight; level: Level }> => {
  const level = await loadLevel(g.id)
  const field = fieldFor(level as unknown as { environment: string; worldOffset: number[] })
  const props = edition.gameplay.propCollision.enabled
    ? forestFor(level.environment, field, {
        spec: edition.gameplay.propCollision as unknown as PropCollisionSpec,
        scale: edition.props.scale as unknown as Record<string, unknown>,
        unbakedPasses: edition.props.unbakedPasses.enabled,
        groundSnapSink: edition.props.groundSnap.enabled ? edition.props.groundSnap.sink : null,
        maxSlope: edition.props.maxSlope.enabled ? edition.props.maxSlope.sin : null,
        landmarks: true,
      })
    : null
  const v = aircraftFor('hoverjet').variants.find((x) => x.id === variant)
  if (!v) throw new Error(`no HoverJet variant ${variant}`)
  const flight = flyLesson({
    level,
    edition,
    script: g.script,
    ground: [field],
    props,
    limitSeconds: 600,
    sheet: hoverJetView(v.scale),
    ...(lesson ? { lesson } : {}),
    ...extra,
  })
  return { flight, level }
}

/** The flights to make: both presets on 2016's jet, and every variant on Anniversary (DEV-382). */
const RUNS: readonly [string, Edition, string][] = [
  ...EDITIONS.map(([name, e]) => [name, e, 'standard'] as [string, Edition, string]),
  ...aircraftFor('hoverjet')
    .variants.filter((v) => v.id !== 'standard')
    .map((v) => ['anniversary', EDITIONS[0]?.[1] as Edition, v.id] as [string, Edition, string]),
]

describe.skipIf(!haveForest)('the golden lessons, flown on the real desert', () => {
  for (const g of GOLDEN) {
    for (const [name, edition, variant] of RUNS) {
      it(`${g.id} · ${name} · ${variant}: every step ends on its own trigger`, async () => {
        const { flight, level } = await fly(g, edition, variant)
        const lesson = level.lesson as Lesson
        const where = `${g.id} ${name}/${variant}`
        expect(flight.stalledAt, `${where} stalled`).toBeNull()
        expect(flight.done).toBe(true)
        // Every step came up, in order, and ended.
        expect(flight.steps.map((s) => s.id)).toEqual(lesson.steps.map((s) => s.id))
        for (const s of flight.steps) {
          const bound = g.bounds[s.id]
          expect(bound, `no stated bound for ${s.id}`).toBeDefined()
          expect(Number.isFinite(s.endedAt), `${where} ${s.id} never ended`).toBe(true)
          expect(s.ringsAtEnd, `${where} ${s.id} ran past its leg`).toBeLessThanOrEqual(
            bound?.endsBy ?? -1,
          )
          expect(s.endedAt - s.startedAt, `${where} ${s.id} took too long`).toBeLessThanOrEqual(
            bound?.within ?? -1,
          )
        }
        // A clean student is never interrupted, never crashes, never scrapes.
        expect(flight.interrupts).toEqual([])
        expect(flight.crashes).toBe(0)
        expect(flight.contacts).toBe(0)
        expect(flight.instructorCrashes).toBe(0)
        // The whole course, and the finish.
        expect(flight.rings).toBe(courseGates(level).length)
        expect(flight.finished).toBe(true)
        expect(flight.flyingSeconds).toBeLessThan(g.flyingWithin)
        // The instructor is never further ahead than it waits at, while the
        // student flies (§9). The race home is excluded: it waits for nobody.
        expect(flight.gap.ticks).toBeGreaterThan(0)
        expect(flight.gap.max).toBeLessThan(lesson.instructor.waitBeyondMetres)
      })
    }
  }

  it(`${L1}: the bank stays, as the plate says (DEV-001)`, async () => {
    const g = GOLDEN[0] as Golden
    const { flight, level } = await fly(g, EDITIONS[0]?.[1] as Edition, 'standard')
    // The plate: "Roll with {roll}, then let go: it stays banked." The student
    // let go at 40°; a second later it is still past the step's own threshold.
    const bank = (level.lesson as Lesson).steps.find((s) => s.id === 'bank')?.until
    const least =
      bank?.kind === 'sequence' && bank.of[0]?.kind === 'bankAtLeast' ? bank.of[0].degrees : 0
    expect(least).toBeGreaterThan(0)
    expect(flight.bankAfterRelease ?? 0).toBeGreaterThanOrEqual(least)
  })

  describe(`${L1}: the student's speed cap on THROTTLE and CLIMB (DEV-790)`, () => {
    // Matt, 2026-10-07 ("go with your recs", QUESTIONS item 5). The measured
    // playtest (PLAYTEST-PERSONAS-2026-10-03.md, "Lesson 1, measured"): a new
    // player who holds the throttle from the first second reaches ~93 m/s, the
    // mesa 430 m past ring 1 arrives about 5.7 s in, and a one-second reaction
    // to CLIMB still hits its face. Here that player is a script (full throttle,
    // no steering, the stick pulled back for half a second a second after the
    // CLIMB prompt) flown on the real desert, with and without the cap.
    const novice = (lesson: Lesson): StudentScript => ({
      launchAfter: 0,
      steps: Object.fromEntries(
        lesson.steps.map((s) => [
          s.id,
          s.id === 'throttle'
            ? { speed: 50, novice: {} }
            : s.id === 'climb'
              ? { speed: 50, novice: { pullAfter: 1, pullFor: 0.5 } }
              : { speed: 50 },
        ]),
      ),
    })
    const flyNovice = async (uncapped: boolean) => {
      const level = await loadLevel(L1)
      const g = { id: L1, script: novice(level.lesson as Lesson) } as Golden
      const speeds: number[] = []
      const out = await fly(g, EDITIONS[0]?.[1] as Edition, 'standard', undefined, {
        limitSeconds: 25,
        uncapped,
        observe: (_t, r) => speeds.push(r.speed),
      })
      return { ...out, speeds }
    }

    it('holds the new player to the cap, and the mesa is cleared', async () => {
      const { flight } = await flyNovice(false)
      expect(flight.crashes).toBe(0)
      // The ceiling held (the engine's spool carries a couple of m/s past the cut),
      // far under the ~93 m/s the same hands reach below.
      expect(flight.topSpeed).toBeLessThan(60)
      // THROTTLE still ends on its own trigger: the cap sits over its 50 m/s.
      expect(Number.isFinite(flight.steps[0]?.endedAt ?? Number.NaN)).toBe(true)
    })

    it('control: with no cap the same player hits the mesa', async () => {
      const { flight } = await flyNovice(true)
      expect(flight.crashes).toBeGreaterThan(0)
      expect(flight.topSpeed).toBeGreaterThan(85)
    })
  })

  for (const g of GOLDEN) {
    it(`${g.id}: on 2016's jet the instructor LEADS until the race, and never touches the student`, async () => {
      for (const [, edition] of EDITIONS) {
        const { flight, level } = await fly(g, edition, 'standard')
        const lesson = level.lesson as Lesson
        for (const s of flight.steps) {
          const race = lesson.steps.find((x) => x.id === s.id)?.instructor?.pace === 'race'
          if (race || !Number.isFinite(s.gapMin)) continue
          expect(s.gapMin, `${g.id} ${s.id}: the student passed the instructor`).toBeGreaterThan(0)
          expect(s.craftContactTicks, `${g.id} ${s.id}`).toBe(0)
        }
      }
    })

    it(`${g.id}: a step whose trigger the student cannot meet STALLS the lesson there`, async () => {
      // The negative control: the golden run can go red. The same student, the
      // same course, one step's trigger moved out of reach.
      const level = await loadLevel(g.id)
      const lesson = structuredClone(level.lesson) as Lesson
      const step = lesson.steps.find((s) => s.id === g.breakStep.id) as { until: LessonTrigger }
      step.until = g.breakStep.until
      const { flight } = await fly(g, EDITIONS[0]?.[1] as Edition, 'standard', lesson)
      expect(flight.done).toBe(false)
      expect(flight.stalledAt).toBe(g.breakStep.id)
      // Everything before it still ended; nothing after it came up.
      const at = lesson.steps.findIndex((s) => s.id === g.breakStep.id)
      expect(flight.steps.length).toBe(at + 1)
      for (const s of flight.steps.slice(0, at)) expect(Number.isFinite(s.endedAt)).toBe(true)
    })

    it(`${g.id}: the same lesson flies the same twice`, async () => {
      const a = await fly(g, EDITIONS[0]?.[1] as Edition, 'standard')
      const b = await fly(g, EDITIONS[0]?.[1] as Edition, 'standard')
      expect(b.flight.steps).toEqual(a.flight.steps)
      expect(b.flight.flyingSeconds).toBe(a.flight.flyingSeconds)
    })
  }
})

describe.skipIf(haveForest)('the golden lessons need the height maps and the forest', () => {
  it('is skipped because public/assets is not hydrated (`pnpm assets:pull`)', () => {
    // The loud counterpart: on a hydrated tree this describe is the one that
    // skips, and the one above flies. If both ever skip, this line says why.
    expect(haveForest).toBe(false)
  })
})

// DEV-409. Matt, 2026-09-25: "skip the elevator in flight school - even skip
// the countdown." Asserted on the DATA, since a lesson's start is content: no
// lift to ride (`restingPhase` is then `flying` from the first tick, and
// `airframe.start()` still applies the HoverJet's launched, gravity-off state),
// and no step that waits on a launch press that can no longer happen.
describe('DEV-409 — Flight School starts flying: no lift, no countdown', () => {
  for (const id of [L1, L2]) {
    it(`${id}`, async () => {
      const level = await loadLevel(id)
      expect(level.spawn.launchKind).toBe('direct')
      expect(level.spawn.launch).toBeUndefined()
      for (const step of level.lesson?.steps ?? []) {
        expect(JSON.stringify(step.until), step.id).not.toContain('"launched"')
      }
    })
  }
})
