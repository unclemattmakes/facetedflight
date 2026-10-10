// tests/unit/editor-run-in.test.ts — the straight from the start pad to the
// line's first point, judged for its ground and its turns, fixed by Lift and
// by the button beside the warning. DEV-486.
//
// What is held, and against what:
//
//  1. The STRAIGHT is the expansion's own: `runInOf` begins where
//     `expandPlayerCourse` puts `Level.route[0]` (the ship on its pad) and
//     ends at `route[1]` (the line's first point). An outside check, not the
//     warning's arithmetic twice.
//  2. The TURN threshold is DEV-468's cruise radius through the fillet
//     (`warnings.ts`'s DEV-486 header), checked on geometry whose answer is
//     known by construction: a 90° corner at point 1 with a straight of 0.9 ×
//     and 1.1 × the radius, and the line's room binding at a known number.
//  3. The two cases that decide the rule: a pad past the first point (the run-in
//     doubles back: warned at point 1, fixed by MOVING the pad behind it, since
//     no aim can change that angle) and a pad on the run-up aimed away (warned
//     at the pad, fixed by AIMING it). Plus a pad under its first point.
//  4. The GROUND: a hill across the straight is `line-under-ground` with a
//     `runIn` stretch; Lift raises point 1 and leaves the pad; the takeoff is
//     not "near" the ground (the ship stands 2.2 m over its dish).
//  5. The move's search refuses a racer's pad in the ground, and the water.
//  6. On each island's real render surface (gated on the gitignored maps, with
//     its loud counterpart): a pad put past the first point of random lines is
//     moved to a spot with no run-in warning and no pad or racer error.

import { describe, expect, it } from 'vitest'
import { splineTangentAt } from '@/content/course-spline'
import type { EditionRacers } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import {
  expandPlayerCourse,
  PLAYER_COURSE_LIMITS,
  type PlayerCourse,
  type PlayerCourseStart,
  playerCourseArea,
  playerCourseSpline,
  startStandUp,
  validatePlayerCourse,
  yawForward,
} from '@/content/player-course'
import {
  createHistory,
  depth,
  draftFromCourse,
  type EditorWarning,
  evaluateDraft,
  type Ground,
  groundClearance,
  liftClear,
  record,
  runInFixOf,
  runInOf,
  runInSamples,
  runInShortfalls,
  runInTurn,
  type SlotPad,
  seatPadAt,
  straightenRunIn,
  tightestTurnRadius,
  undo,
  yawToward,
} from '@/editor/core'
import { groundMarks } from '@/editor/desk/ground-marks'
import { courseSlots } from '@/editor/desk/slots'
import anniversary from '../../content/editions/anniversary.json'
import { fittedCourse, islandGround, shippedLevels } from './helpers/editor-course'
import { seeded as rng } from './helpers/seeded'
import { haveMaps } from './helpers/terrain-field'

type V = [number, number, number]

const shipped = shippedLevels()
const int01 = shipped.find((l) => l.id === 'int_01_hoverJet') as Level
const FITTED = fittedCourse(int01)
const ANNIV = (anniversary as unknown as { gameplay: { racers: EditionRacers } }).gameplay.racers
const area = playerCourseArea(int01)
if (area?.kind !== 'sphere') throw new Error('int_01 has a sphere boundary')
const [CX, , CZ] = area.centre
/** The line's height, and the ground's: flat land 300 m under it. */
const Y = 300
const FLAT: Ground = { surfaceAt: () => 0, waterAt: () => false }
const NO_SLOTS = (): SlotPad[] => []
const LIMIT = tightestTurnRadius()

/** A straight line east (+x) from (CX, Y, CZ), 1 km long, in three points. */
const EAST: V[] = [
  [CX, Y, CZ],
  [CX + 500, Y, CZ],
  [CX + 1000, Y, CZ],
]

const course = (pad: V, yaw: number, points: V[] = EAST, gap = 400): PlayerCourse => ({
  ...FITTED,
  path: { points, gap },
  rings: [],
  start: { pos: pad, yaw },
  finish: { t: 0.9 },
})
const kinds = (w: readonly EditorWarning[]): string[] => w.map((x) => x.kind)
const runInTurns = (w: readonly EditorWarning[]): EditorWarning[] =>
  w.filter((x) => x.kind === 'run-in-turn')
const runInGround = (w: readonly EditorWarning[]): EditorWarning[] =>
  w.filter((x) => x.runIn !== undefined)
const EAST_YAW = yawToward(1, 0)
const WEST_YAW = yawToward(-1, 0)

describe('DEV-486 — the run-in is the expansion’s own straight', () => {
  it('yawToward is yawForward’s inverse, all the way round', () => {
    for (let deg = -170; deg <= 180; deg += 10) {
      const f = yawForward(deg)
      const back = yawToward(f.x, f.z)
      expect(Math.abs(((back - deg + 540) % 360) - 180), `${deg}`).toBeLessThan(1e-9)
    }
  })

  it('runs from the route’s first point (the ship on its pad) to its second (point 1)', () => {
    const c = course([CX - 600, 0, CZ + 30], EAST_YAW)
    expect(validatePlayerCourse(c, int01).ok).toBe(true)
    const level = expandPlayerCourse(c, int01)
    const route = level.route as V[]
    const r = runInOf(c, int01)
    if (!r) throw new Error('no run-in')
    expect([r.from.x, r.from.y, r.from.z]).toEqual(route[0])
    expect([r.to.x, r.to.y, r.to.z]).toEqual(route[1])
    // The ship stands the sky's lift over the pad's foot.
    expect(r.from.y).toBeCloseTo(0 + (startStandUp(int01) as number), 9)
    const s = runInSamples(r)
    expect(s[0]?.f).toBe(0)
    expect(s[s.length - 1]?.f).toBe(1)
    // Finer than the terrain's 8 m grid.
    expect(r.length / (s.length - 1)).toBeLessThanOrEqual(4 + 1e-9)
  })

  it('has none where the ship already stands on point 1 (within a point quantum)', () => {
    const standUp = startStandUp(int01) as number
    expect(runInOf(course([CX, Y - standUp, CZ], EAST_YAW), int01)).toBeNull()
  })
})

describe('DEV-486 — the run-in’s turns, at DEV-468’s cruise radius', () => {
  /** Point 1 turns the line 90° left (north, −z) after a straight run east from the pad. */
  const NORTH: V[] = [
    [CX, Y, CZ],
    [CX, Y, CZ - 500],
    [CX, Y, CZ - 1000],
  ]
  it('a 90° corner at point 1 needs a straight of one radius (tan 45° = 1)', () => {
    const short = course([CX - 0.9 * LIMIT, 0, CZ], EAST_YAW, NORTH)
    const long = course([CX - 1.1 * LIMIT, 0, CZ], EAST_YAW, NORTH)
    const a = runInTurn(short, int01)
    const b = runInTurn(long, int01)
    expect(a?.pointTurn).toBeCloseTo(90, 6)
    expect(a?.padTurn).toBeCloseTo(0, 6)
    expect(a?.radius).toBeCloseTo(0.9 * LIMIT, 6)
    expect(b?.radius).toBeCloseTo(1.1 * LIMIT, 6)
    const warned = runInTurns(evaluateDraft(draftFromCourse(short), int01, FLAT).warnings)
    expect(warned).toHaveLength(1)
    expect(warned[0]?.metres).toBeCloseTo(0.9 * LIMIT, 6)
    expect(warned[0]?.at).toEqual(NORTH[0])
    expect(runInTurns(evaluateDraft(draftFromCourse(long), int01, FLAT).warnings)).toEqual([])
  })

  it('the line’s room to the first ring binds a long straight: room / tan(θ/2)', () => {
    // A 1 km straight, 90° onto the line, first ring one gap (400 m) on.
    const t = runInTurn(course([CX - 1000, 0, CZ], EAST_YAW, NORTH), int01)
    expect(t?.radius).toBeCloseTo(400, 6)
    // 120°: the pad aimed along, the straight 1 km: min(1000, 400) / tan 60°.
    const SOUTHWEST: V[] = [
      [CX, Y, CZ],
      [CX - 250, Y, CZ + 250 * Math.sqrt(3)],
      [CX - 500, Y, CZ + 500 * Math.sqrt(3)],
    ]
    const u = runInTurn(course([CX - 1000, 0, CZ], EAST_YAW, SOUTHWEST), int01)
    expect(u?.pointTurn).toBeCloseTo(120, 6)
    expect(u?.radius).toBeCloseTo(400 / Math.tan(Math.PI / 3), 6)
  })

  it('is judged in PLAN: a steep climb off the pad onto a line running on is not a turn', () => {
    // The pad 100 m back, 300 m under point 1: a 71° climb in 3D, straight on in plan.
    const t = runInTurn(course([CX - 100, 0, CZ], EAST_YAW), int01)
    expect(t?.pointTurn).toBeCloseTo(0, 6)
    expect(t?.radius).toBe(Number.POSITIVE_INFINITY)
  })

  it('2016’s own int_01 line, its pad under point 1, raises no run-in warning', () => {
    const e = evaluateDraft(draftFromCourse(FITTED), int01, { surfaceAt: () => -1e5 })
    expect(runInTurn(FITTED, int01)?.overPad).toBe(true)
    expect(runInTurns(e.warnings)).toEqual([])
  })
})

describe('DEV-486 — the two cases, and their fixes', () => {
  it('a pad PAST point 1 doubles back: warned at point 1, and MOVED behind it', () => {
    // Under the line 400 m on, aimed at point 1: a hairpin in plan (the case
    // racer 2 stalled at in DEV-478). In 3D, with the climb, it would read as
    // a 143° half-loop and pass; the HoverJet turns, it does not loop.
    const d = draftFromCourse(course([CX + 400, 0, CZ], WEST_YAW))
    const before = evaluateDraft(d, int01, FLAT)
    const warned = runInTurns(before.warnings)
    expect(warned).toHaveLength(1)
    expect(warned[0]?.severity).toBe('warning')
    expect(warned[0]?.at).toEqual(EAST[0])
    expect(warned[0]?.message).toMatch(/turns 180° from it at point 1/)
    expect(runInFixOf(d, int01)).toBe('move')

    const { draft: fixed, fix } = straightenRunIn(d, int01, FLAT, NO_SLOTS)
    expect(fix).toBe('move')
    const pad = fixed.course.start
    // Behind point 1 on the line's run-up, on the ground, aimed along the line.
    expect(pad.pos[2]).toBeCloseTo(CZ, 6)
    expect(pad.pos[0]).toBeLessThan(CX)
    expect(pad.pos[1]).toBe(0)
    const f = yawForward(pad.yaw)
    expect(f.x).toBeGreaterThan(0.9999)
    // The line is where it was; the warning is gone; nothing else is wrong.
    expect(fixed.course.path).toBe(d.course.path)
    const after = evaluateDraft(fixed, int01, FLAT)
    expect(runInTurns(after.warnings)).toEqual([])
    expect(runInGround(after.warnings)).toEqual([])
    expect(after.warnings.filter((w) => w.severity === 'error')).toEqual([])
    // ONE undo step, and undo puts the pad back.
    const h = record(createHistory(d), fixed)
    expect(depth(h)).toBe(1)
    expect(undo(h).present.course.start).toEqual(d.course.start)
  })

  it('a pad on the run-up AIMED AWAY: warned at the pad, and AIMED at point 1', () => {
    const d = draftFromCourse(course([CX - 600, 0, CZ + 40], WEST_YAW))
    const warned = runInTurns(evaluateDraft(d, int01, FLAT).warnings)
    expect(warned).toHaveLength(1)
    expect(warned[0]?.at).toEqual([CX - 600, 0, CZ + 40])
    expect(runInFixOf(d, int01)).toBe('aim')
    const { draft: fixed, fix } = straightenRunIn(d, int01, FLAT, NO_SLOTS)
    expect(fix).toBe('aim')
    expect(fixed.course.start.pos).toEqual(d.course.start.pos)
    // Along the straight, in plan, to the format's 0.1°.
    const r = runInOf(fixed.course, int01)
    if (!r) throw new Error('no run-in')
    const want = yawToward(r.to.x - r.from.x, r.to.z - r.from.z)
    expect(Math.abs(fixed.course.start.yaw - want)).toBeLessThanOrEqual(0.05 + 1e-9)
    expect(runInTurns(evaluateDraft(fixed, int01, FLAT).warnings)).toEqual([])
  })

  it('a pad UNDER point 1 facing back along the line: warned, and aimed along the line', () => {
    const standUp = startStandUp(int01) as number
    const d = draftFromCourse(course([CX + 1, Y - 150, CZ], WEST_YAW))
    expect(runInOf(d.course, int01)?.length).toBeCloseTo(150 - standUp, 0)
    const t = runInTurn(d.course, int01)
    expect(t?.overPad).toBe(true)
    const warned = runInTurns(evaluateDraft(d, int01, FLAT).warnings)
    expect(warned[0]?.message).toMatch(/starts over the pad/)
    const { draft: fixed, fix } = straightenRunIn(d, int01, FLAT, NO_SLOTS)
    expect(fix).toBe('aim')
    const tan = splineTangentAt(playerCourseSpline(fixed.course), 0)
    const f = yawForward(fixed.course.start.yaw)
    expect(f.x * tan.x + f.z * tan.z).toBeGreaterThan(0.9999)
    expect(runInTurns(evaluateDraft(fixed, int01, FLAT).warnings)).toEqual([])
  })

  it('returns the draft itself when there is nothing to fix', () => {
    const d = draftFromCourse(course([CX - 600, 0, CZ], EAST_YAW))
    expect(runInFixOf(d, int01)).toBeNull()
    const out = straightenRunIn(d, int01, FLAT, NO_SLOTS)
    expect(out.fix).toBeNull()
    expect(out.draft).toBe(d)
  })
})

describe('DEV-486 — the move refuses what the warnings would refuse', () => {
  const past = draftFromCourse(course([CX + 400, 0, CZ], WEST_YAW))
  it('walks past places where a racer’s pad would stand in the ground', () => {
    // Every racer's pad is buried while the start is within 100 m of point 1.
    const slotsFor = (s: PlayerCourseStart): SlotPad[] => [
      { foot: [s.pos[0], CX - s.pos[0] < 100 ? -10 : s.pos[1], s.pos[2] + 20], size: [9, 1.75, 9] },
    ]
    const { draft, fix } = straightenRunIn(past, int01, FLAT, slotsFor)
    expect(fix).toBe('move')
    expect(CX - draft.course.start.pos[0]).toBeGreaterThanOrEqual(100)
  })
  it('and the water', () => {
    const shore: Ground = { surfaceAt: () => 0, waterAt: (x) => x > CX - 200 }
    const { draft, fix } = straightenRunIn(past, int01, shore, NO_SLOTS)
    expect(fix).toBe('move')
    expect(draft.course.start.pos[0]).toBeLessThanOrEqual(CX - 200)
  })
  it('an aim that would bury a racer moves instead', () => {
    const away = draftFromCourse(course([CX - 600, 0, CZ + 40], WEST_YAW))
    // Buried whenever the pad faces east.
    const slotsFor = (s: PlayerCourseStart): SlotPad[] =>
      yawForward(s.yaw).x > 0.9 && s.pos[2] !== CZ
        ? [{ foot: [s.pos[0], -10, s.pos[2]], size: [9, 1.75, 9] }]
        : []
    const { fix } = straightenRunIn(away, int01, FLAT, slotsFor)
    expect(fix).toBe('move')
  })
  it('takes the nearest FLAT place, and a slope only where there is none', () => {
    // Corrugated ground, 12 m from trough to crest every 8 m (a pad's 9.35 m
    // footprint always spans one), but for a flat bench 300–340 m back.
    const bench = (x: number): boolean => x <= CX - 300 && x >= CX - 340
    const saw = (x: number): number => 3 * Math.abs((((x % 8) + 8) % 8) - 4)
    const slope: Ground = { surfaceAt: (x) => (bench(x) ? 0 : saw(x)), waterAt: () => false }
    const steep: Ground = { surfaceAt: saw, waterAt: () => false }
    const onBench = straightenRunIn(past, int01, slope, NO_SLOTS)
    expect(onBench.fix).toBe('move')
    expect(bench(onBench.draft.course.start.pos[0])).toBe(true)
    const onSlope = straightenRunIn(past, int01, steep, NO_SLOTS)
    expect(onSlope.fix).toBe('move')
    const e = evaluateDraft(onSlope.draft, int01, steep)
    expect(kinds(e.warnings)).toContain('pad-slope')
    expect(e.warnings.filter((w) => w.severity === 'error')).toEqual([])
  })
  it('and gives up, unchanged, where nothing behind point 1 will do', () => {
    const sea: Ground = { surfaceAt: () => 0, waterAt: () => true }
    const out = straightenRunIn(past, int01, sea, NO_SLOTS)
    expect(out.fix).toBeNull()
    expect(out.draft).toBe(past)
  })
})

describe('DEV-486 — the run-in’s ground, and Lift', () => {
  it('stands the takeoff inside the hover height without calling it near the ground', () => {
    // A shallow climb: 600 m across, 300 m up, from a pad on flat ground.
    const c = course([CX - 600, 0, CZ], EAST_YAW)
    const r = runInOf(c, int01)
    if (!r) throw new Error('no run-in')
    // The premise: the ship on its pad IS inside the clearance (2.2 < 4).
    const s0 = runInSamples(r)[0]
    expect((s0?.at.y ?? 0) - 0).toBeLessThan(groundClearance())
    expect(runInGround(evaluateDraft(draftFromCourse(c), int01, FLAT).warnings)).toEqual([])
    expect(runInShortfalls(c, int01, FLAT)).toEqual([])
  })

  /** A ridge across the straight, 400 m high, 300 m back from point 1. */
  const RIDGE: Ground = {
    surfaceAt: (x) => 400 * Math.exp(-((x - (CX - 300)) ** 2) / (2 * 40 * 40)),
    waterAt: () => false,
  }
  const c = course([CX - 600, 0, CZ], EAST_YAW)
  const d = draftFromCourse(c)

  it('a ridge across it is line-under-ground, over a stretch of the run-in', () => {
    const e = evaluateDraft(d, int01, RIDGE)
    const under = e.warnings.filter((w) => w.kind === 'line-under-ground' && w.runIn)
    expect(under.length).toBeGreaterThan(0)
    for (const w of under) {
      const [f0, f1] = w.runIn as [number, number]
      expect(f0).toBeGreaterThan(0.3)
      expect(f1).toBeLessThan(0.7)
      expect(w.message).toMatch(/run-in/)
      expect(w.span).toBeUndefined()
    }
    // Drawn red where it is: the marks lie on the straight, under the ridge.
    const marks = groundMarks(e.warnings, e.level, playerCourseSpline(c))
    expect(marks.under.length).toBeGreaterThan(0)
    for (const run of marks.under) {
      for (const p of run) {
        expect(p[1]).toBeLessThan(RIDGE.surfaceAt(p[0], p[2]) + 1e-6)
      }
    }
  })

  it('is judged only with a line to lead onto: a lone point is not a course, and Lift needs two', () => {
    const lone = draftFromCourse({ ...c, path: { ...c.path, points: [EAST[0] as V] } })
    expect(runInGround(evaluateDraft(lone, int01, RIDGE).warnings)).toEqual([])
  })

  it('Lift raises POINT 1 until the straight clears, and leaves the pad', () => {
    const lifted = liftClear(d, int01, RIDGE)
    expect(lifted).not.toBe(d)
    expect(lifted.course.start).toEqual(c.start)
    const p0 = lifted.course.path.points[0] as V
    expect(p0[1]).toBeGreaterThan(Y)
    expect([p0[0], p0[2]]).toEqual([CX, CZ])
    expect(runInShortfalls(lifted.course, int01, RIDGE)).toEqual([])
    const after = evaluateDraft(lifted, int01, RIDGE)
    expect(runInGround(after.warnings), kinds(after.warnings).join()).toEqual([])
    expect(depth(record(createHistory(d), lifted))).toBe(1)
  })
})

// ── On each island's real render surface ─────────────────────────────────

const SKIES = ['int_01_hoverJet', 'hoverJet_kauai_beg', 'adv_01_hoverJet', 'int_02_hoverJet']
const PER_ISLAND = 12

/** mulberry32. */
describe.skipIf(!haveMaps)('DEV-486 — the move, on every island’s render surface', () => {
  for (const id of SKIES) {
    it(`moves a pad put past point 1 of ${PER_ISLAND} random lines over ${id}’s island`, () => {
      const sky = shipped.find((l) => l.id === id) as Level
      const ground = islandGround(sky)
      const a = playerCourseArea(sky)
      if (!a) throw new Error('no area')
      const size = sky.spawn.launch?.platform?.size as readonly number[]
      const slotsFor = (s: PlayerCourseStart) => courseSlots(s, sky, ANNIV)
      const r = rng(0x486 + SKIES.indexOf(id))
      let tried = 0
      let moved = 0
      let strict = 0
      for (let attempt = 0; tried < PER_ISLAND && attempt < PER_ISLAND * 20; attempt++) {
        // A straight line of three points, 250 m over the ground, somewhere inside.
        const [cx, cy, cz] =
          a.kind === 'sphere' ? a.centre : [(a.min[0] + a.max[0]) / 2, 0, (a.min[2] + a.max[2]) / 2]
        const reach = a.kind === 'sphere' ? a.radius * 0.5 : (a.max[0] - a.min[0]) * 0.3
        const ang = r() * 2 * Math.PI
        const rr = Math.sqrt(r()) * reach
        const x0 = cx + rr * Math.cos(ang)
        const z0 = cz + rr * Math.sin(ang)
        const head = r() * 2 * Math.PI
        const pts: V[] = [0, 400, 800].map((s) => {
          const x = x0 + s * Math.cos(head)
          const z = z0 + s * Math.sin(head)
          const g = ground.surfaceAt(x, z)
          return [x, (Number.isFinite(g) ? g : cy) + 250, z]
        })
        // The pad 300 m PAST point 1, along the line, seated: a doubling back.
        const px = x0 + 300 * Math.cos(head)
        const pz = z0 + 300 * Math.sin(head)
        const py = seatPadAt(ground, px, pz, size)
        if (py === null) continue
        const c: PlayerCourse = {
          ...FITTED,
          island: sky.environment,
          sky: sky.id,
          path: { points: pts, gap: 400 },
          rings: [],
          start: { pos: [px, py, pz], yaw: yawToward(-Math.cos(head), -Math.sin(head)) },
          finish: { t: 0.9 },
          timeLimit: sky.timer.timeLimit,
        }
        if (!validatePlayerCourse(c, sky).ok) continue
        const d = draftFromCourse(c)
        if (runInFixOf(d, sky) === null) continue
        tried++
        const out = straightenRunIn(d, sky, ground, slotsFor)
        if (out.fix === null) continue
        moved++
        const e = evaluateDraft(out.draft, sky, ground, slotsFor(out.draft.course.start))
        const why = `${id} #${tried}: ${e.warnings.map((w) => w.message).join(' | ')}`
        expect(runInTurns(e.warnings), why).toEqual([])
        // No error: the pad on land, no racer's pad in the ground. A slope,
        // or a racer over the water, is a warning the author sees (`strict`
        // counts the places that raised none).
        expect(
          e.warnings.filter((w) => /^(pad|slot)-/.test(w.kind) && w.severity === 'error'),
          why,
        ).toEqual([])
        expect(kinds(e.warnings), why).not.toContain('pad-in-water')
        if (!e.warnings.some((w) => /^(pad|slot)-/.test(w.kind))) strict++
        expect(
          e.warnings.filter((w) => w.kind === 'line-under-ground' && w.runIn),
          why,
        ).toEqual([])
      }
      expect(tried, `${id}: random lines whose run-in doubled back`).toBe(PER_ISLAND)
      // Not vacuous: the search finds a place for most of them.
      expect(moved, `${id}: pads moved`).toBeGreaterThan(PER_ISLAND / 2)
      console.info(
        `${id}: ${moved}/${tried} pads moved behind point 1, ${strict} raising no pad warning`,
      )
    }, 60_000)
  }
})

describe.skipIf(haveMaps)('DEV-486 — the island property is gated (loud counterpart)', () => {
  it('skips only because the gitignored height maps are absent', () => {
    expect(haveMaps).toBe(false)
  })
})

// The format's limits the synthetic courses above rely on.
it('DEV-486 — the synthetic courses sit inside the format', () => {
  expect(PLAYER_COURSE_LIMITS.gapMetres.min).toBeLessThanOrEqual(400)
  expect(validatePlayerCourse(course([CX - 600, 0, CZ], EAST_YAW), int01).ok).toBe(true)
})
