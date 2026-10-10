// tests/unit/editor-lift.test.ts — a buried ring is an error, and "Lift clear
// of the ground" clears it. DEV-478.
//
// What is held, and against what:
//
//  1. The SEVERITIES Matt called (2026-09-27): a ring whose opening the ground
//     reaches is an ERROR; a line under the ground is a WARNING of its own
//     kind, a line merely near it another.
//  2. `liftClear` on 2016's own `int_01` line (the shared fixture) over
//     synthetic ground whose answer is known by construction: a hill under
//     the line clears; a narrow bump under ONE control point lifts THAT
//     point and leaves the far ones where they were (nearest first); a peak
//     the neighbours cannot rise over, because they stand at the sky's
//     boundary, gets a point of its own; a clean line is returned as itself;
//     and the lift is ONE undo step.
//  3. The PROPERTY, on each island's real render surface built the way the
//     desk builds it (`deskGround` over the LOD-0 vertex grid, never
//     `heightField`): random lines, many of them buried before, have no
//     errors and no line-in-or-near-the-ground warnings after. The maps are
//     gitignored, so that block is gated, with its loud counterpart.

import { describe, expect, it } from 'vitest'
import { type Level, liveRings } from '@/content/level-schema'
import {
  expandPlayerCourse,
  PLAYER_COURSE_LIMITS,
  type PlayerCourse,
  playerCourseArea,
  playerCourseSpline,
  ringFacing,
  validatePlayerCourse,
} from '@/content/player-course'
import {
  canUndo,
  createHistory,
  depth,
  draftFromCourse,
  EDITOR_POLICY,
  type EditorWarning,
  evaluateDraft,
  type Ground,
  groundClearance,
  groundShortfalls,
  liftClear,
  pointWeights,
  record,
  seatPadAt,
  undo,
} from '@/editor/core'
import { groundMarks } from '@/editor/desk/ground-marks'
import { refusalReadout } from '@/editor/desk/panel'
import { fittedCourse, islandGround, shippedLevels } from './helpers/editor-course'
import { seeded as rng } from './helpers/seeded'
import { haveMaps } from './helpers/terrain-field'

type V = [number, number, number]

const shipped = shippedLevels()
const int01 = shipped.find((l) => l.id === 'int_01_hoverJet') as Level
const COURSE = fittedCourse(int01)
const DRAFT = draftFromCourse(COURSE)
const ABYSS: Ground = { surfaceAt: () => -1e5 }

const GROUND_KINDS = new Set(['ring-in-ground', 'line-under-ground', 'line-near-ground'])
const groundTrouble = (w: readonly EditorWarning[]): EditorWarning[] =>
  w.filter((x) => GROUND_KINDS.has(x.kind))
const errors = (w: readonly EditorWarning[]): EditorWarning[] =>
  w.filter((x) => x.severity === 'error')

/** A round hill of `height` over `base`, centred on (cx, cz), falling off over `sigma` metres. */
const hill =
  (cx: number, cz: number, base: number, height: number, sigma: number): Ground['surfaceAt'] =>
  (x, z) =>
    base + height * Math.exp(-((x - cx) ** 2 + (z - cz) ** 2) / (2 * sigma * sigma))

/** mulberry32. */
describe('DEV-478 — what the ground makes of a course', () => {
  it('a ring the ground reaches into is an ERROR, and it refuses the course', () => {
    const level = expandPlayerCourse(COURSE, int01)
    const ring = liveRings(level)[2] as ReturnType<typeof liveRings>[number]
    const c = ring.trigger.pos
    // Ground only under ring 2, up to its centre.
    const e = evaluateDraft(DRAFT, int01, {
      surfaceAt: (x, z) => (Math.hypot(x - c[0], z - c[2]) < 60 ? c[1] : -1e5),
    })
    const buried = e.warnings.filter((w) => w.kind === 'ring-in-ground')
    expect(buried.map((w) => [w.ring, w.severity])).toEqual([[2, 'error']])
    expect(e.warnings[0]?.severity).toBe('error')
  })

  it('a line under the ground is a WARNING of its own kind, and one merely near it another', () => {
    const spline = playerCourseSpline(COURSE)
    const flown = spline.samples.filter(
      (_, i) => (spline.arc[i] as number) <= COURSE.finish.t * spline.length,
    )
    const lowest = Math.min(...flown.map((q) => q.y))
    // A plane 2 m under the flown line's lowest sample: inside the hover
    // height there, over the ground everywhere.
    const near = evaluateDraft(DRAFT, int01, { surfaceAt: () => lowest - 2 })
    const nearLine = near.warnings.filter((w) => w.kind.startsWith('line-'))
    expect(nearLine.length).toBeGreaterThan(0)
    for (const w of nearLine) expect([w.kind, w.severity]).toEqual(['line-near-ground', 'warning'])
    // A spike 50 m over point 3: the line goes under it there.
    const p3 = COURSE.path.points[3] as V
    const spike = evaluateDraft(DRAFT, int01, {
      surfaceAt: (x, z) => (Math.hypot(x - p3[0], z - p3[2]) < 10 ? p3[1] + 50 : -1e5),
    })
    const lines = spike.warnings.filter((w) => w.kind.startsWith('line-'))
    expect(lines.length).toBeGreaterThan(0)
    for (const w of lines) {
      expect([w.kind, w.severity]).toEqual(['line-under-ground', 'warning'])
      // Reported over the samples UNDER the surface.
      expect((w.metres ?? 0) - groundClearance()).toBeGreaterThan(0)
    }
    // And a line under the ground is not, by itself, an error.
    expect(errors(spike.warnings).filter((w) => w.kind !== 'ring-in-ground')).toEqual([])
  })

  it('reads the curve the way `course-spline.ts` samples it: the bracketing weights', () => {
    // At a point the curve IS the point; midway each carries 0.5625 in the interior.
    expect(pointWeights(3, 0, 10)).toEqual([1, 0])
    const [a, b] = pointWeights(3, 0.5, 10)
    expect(a).toBeCloseTo(0.5625, 12)
    expect(b).toBeCloseTo(0.5625, 12)
    // The clamped first segment: p0 is p1, so p1 carries the outer weight too.
    const [f0] = pointWeights(0, 0.5, 10)
    expect(f0).toBeCloseTo(0.5, 12)
  })
})

describe('DEV-478 — Lift clear of the ground, on 2016’s int_01 line', () => {
  const clean = (d: typeof DRAFT, ground: Ground): void => {
    const e = evaluateDraft(d, int01, ground)
    expect(
      errors(e.warnings).map((w) => w.message),
      'no errors',
    ).toEqual([])
    expect(
      groundTrouble(e.warnings).map((w) => w.message),
      'nothing in or near the ground',
    ).toEqual([])
    expect(groundShortfalls(d.course, int01, ground), 'the whole line clear').toEqual([])
  }

  it('returns a clean draft as itself: nothing to lift is no undo step', () => {
    expect(liftClear(DRAFT, int01, ABYSS)).toBe(DRAFT)
    const h = record(createHistory(DRAFT), liftClear(DRAFT, int01, ABYSS))
    expect(depth(h)).toBe(0)
  })

  it('lifts the line over a hill under it, as one undo step, and never lowers a point', () => {
    const p = COURSE.path.points
    const mid = p[Math.floor(p.length / 2)] as V
    const ground: Ground = { surfaceAt: hill(mid[0], mid[2], 0, mid[1] + 60, 400) }
    const before = evaluateDraft(DRAFT, int01, ground)
    expect(errors(before.warnings).length, 'the hill buries rings').toBeGreaterThan(0)
    const lifted = liftClear(DRAFT, int01, ground)
    clean(lifted, ground)
    lifted.course.path.points.forEach((q, i) => {
      const was = p[i] as V
      expect(q[0]).toBe(was[0])
      expect(q[2]).toBe(was[2])
      expect(q[1]).toBeGreaterThanOrEqual(was[1])
    })
    let h = record(createHistory(DRAFT), lifted)
    expect(depth(h)).toBe(1)
    h = undo(h)
    expect(h.present).toBe(DRAFT)
    expect(canUndo(h)).toBe(false)
  })

  it('lifts the NEAREST point first: a bump under one point raises it, not the far ones', () => {
    const k = 5
    const pk = COURSE.path.points[k] as V
    const ground: Ground = { surfaceAt: hill(pk[0], pk[2], -1e5, 1e5 + pk[1] + 10, 30) }
    const lifted = liftClear(DRAFT, int01, ground)
    clean(lifted, ground)
    const q = lifted.course.path.points
    expect(q.length).toBe(COURSE.path.points.length)
    const rise = q.map((p, i) => p[1] - (COURSE.path.points[i] as V)[1])
    expect(rise[k]).toBeGreaterThan(10)
    rise.forEach((r, i) => {
      if (Math.abs(i - k) >= 3) expect(r, `point ${i}`).toBe(0)
      expect(r, `point ${i} rose less than point ${k}`).toBeLessThanOrEqual(rise[k] as number)
    })
  })

  it('puts a point over a peak its neighbours cannot rise over (they stand at the boundary)', () => {
    const area = playerCourseArea(int01)
    if (area?.kind !== 'sphere') throw new Error('int_01 has a sphere boundary')
    const [cx, cy, cz] = area.centre
    const R = area.radius
    // Two points 0.3 R either side of the centre, a metre inside the sphere's
    // shell over them: a straight line (two points), 94 m under the sphere's
    // top at its middle. A narrow peak under that middle reaches 10 m over
    // the line — clear only if the line rises there, which neither point can
    // do and stay inside.
    const lineY = cy + Math.sqrt(R * R - (0.3 * R) ** 2) - 1
    const pts: V[] = [
      [cx - 0.3 * R, lineY, cz],
      [cx + 0.3 * R, lineY, cz],
    ]
    const course: PlayerCourse = {
      ...COURSE,
      path: { points: pts, gap: 200 },
      rings: [],
      start: { pos: [...(pts[0] as V)] as V, yaw: 90 },
      finish: { t: 0.9 },
    }
    expect(validatePlayerCourse(course, int01).ok).toBe(true)
    const d = draftFromCourse(course)
    const ground: Ground = { surfaceAt: hill(cx, cz, -1e5, 1e5 + lineY + 10, 25) }
    expect(groundTrouble(evaluateDraft(d, int01, ground).warnings).length).toBeGreaterThan(0)
    const lifted = liftClear(d, int01, ground)
    clean(lifted, ground)
    const q = lifted.course.path.points
    expect(q.length).toBeGreaterThan(pts.length)
    // The ends stayed where they were: raising them could not clear it.
    expect(q[0]).toEqual(pts[0])
    expect(q[q.length - 1]).toEqual(pts[1])
    // And the new point stands over the peak.
    const added = q[1] as V
    expect(Math.hypot(added[0] - cx, added[2] - cz)).toBeLessThan(10)
    // Every point of the result inside the sky's boundary.
    expect(validatePlayerCourse(lifted.course, int01).ok).toBe(true)
  })
})

// ── 3. The property, on each island's render surface ─────────────────────

/** One HoverJet sky per island: the four islands the editor can make courses on. */
const SKIES = ['int_01_hoverJet', 'hoverJet_kauai_beg', 'adv_01_hoverJet', 'int_02_hoverJet']
const LINES_PER_ISLAND = 16

/**
 * A random course over `sky`'s island: 3–7 points inside the play area, each
 * `-60 .. +220 m` from the ground under it, so many sag through a hill or
 * stand in one. Rejection-sampled until it validates (the lift works on a
 * course the validator takes; an invalid one is refused for other reasons).
 */
const randomCourse = (sky: Level, ground: Ground, r: () => number): PlayerCourse => {
  const area = playerCourseArea(sky)
  if (!area) throw new Error(`${sky.id}: no area`)
  const pad = sky.spawn.launch?.platform?.size as readonly number[]
  for (let attempt = 0; attempt < 400; attempt++) {
    const n = 3 + Math.floor(r() * 5)
    const pts: V[] = []
    // A walk, so the line is a course and not a scribble across the island.
    let x = 0
    let z = 0
    if (area.kind === 'sphere') {
      const a = r() * 2 * Math.PI
      const rr = Math.sqrt(r()) * area.radius * 0.6
      x = area.centre[0] + rr * Math.cos(a)
      z = area.centre[2] + rr * Math.sin(a)
    } else {
      x = area.min[0] + (0.2 + 0.6 * r()) * (area.max[0] - area.min[0])
      z = area.min[2] + (0.2 + 0.6 * r()) * (area.max[2] - area.min[2])
    }
    let heading = r() * 2 * Math.PI
    for (let i = 0; i < n; i++) {
      const g = ground.surfaceAt(x, z)
      const base = Number.isFinite(g) ? g : 0
      pts.push([x, base - 60 + r() * 280, z])
      heading += (r() - 0.5) * 1.6
      const step = 250 + r() * 450
      x += step * Math.cos(heading)
      z += step * Math.sin(heading)
    }
    const p0 = pts[0] as V
    const foot = seatPadAt(ground, p0[0], p0[2], pad) ?? p0[1]
    const course: PlayerCourse = {
      ...COURSE,
      island: sky.environment,
      sky: sky.id,
      path: { points: pts, gap: PLAYER_COURSE_LIMITS.gapMetres.min + Math.floor(r() * 300) },
      rings: [],
      start: { pos: [p0[0], foot, p0[2]], yaw: 0 },
      finish: { t: 0.85 },
      timeLimit: sky.timer.timeLimit,
    }
    const checked = validatePlayerCourse(course, sky)
    if (!checked.ok) continue
    // Nothing but the ground may be wrong with it before the lift.
    const e = evaluateDraft(draftFromCourse(course), sky, ground)
    if (errors(e.warnings).some((w) => w.kind !== 'ring-in-ground')) continue
    return course
  }
  throw new Error(`${sky.id}: no random course validated`)
}

describe.skipIf(!haveMaps)('DEV-478 — the lift, on every island’s render surface', () => {
  for (const id of SKIES) {
    it(`clears ${LINES_PER_ISLAND} random lines over ${id}’s island`, () => {
      const sky = shipped.find((l) => l.id === id) as Level
      expect(sky, id).toBeDefined()
      const ground = islandGround(sky)
      const r = rng(0x478 + SKIES.indexOf(id))
      let buried = 0
      let inserted = 0
      for (let i = 0; i < LINES_PER_ISLAND; i++) {
        const course = randomCourse(sky, ground, r)
        const d = draftFromCourse(course)
        const before = evaluateDraft(d, sky, ground)
        if (errors(before.warnings).length > 0) buried++
        const lifted = liftClear(d, sky, ground)
        if (lifted.course.path.points.length > course.path.points.length) inserted++
        const after = evaluateDraft(lifted, sky, ground)
        const why = `${id} line ${i}: ${after.warnings.map((w) => w.message).join(' | ')}`
        expect(errors(after.warnings), why).toEqual([])
        expect(groundTrouble(after.warnings), why).toEqual([])
        expect(groundShortfalls(lifted.course, sky, ground), why).toEqual([])
      }
      // Not vacuous: the sample buries rings, on every island.
      expect(buried, `${id}: lines that were buried before the lift`).toBeGreaterThan(
        LINES_PER_ISLAND / 4,
      )
      console.info(`${id}: ${buried}/${LINES_PER_ISLAND} buried before, ${inserted} needed a point`)
    }, 60_000)
  }
})

describe.skipIf(haveMaps)('DEV-478 — the island property is gated (loud counterpart)', () => {
  it('skips only because the gitignored height maps are absent', () => {
    expect(haveMaps).toBe(false)
  })
})

describe('DEV-478 — the red marks, against the ground they came from', () => {
  const p = COURSE.path.points
  const mid = p[Math.floor(p.length / 2)] as V
  const ground: Ground = { surfaceAt: hill(mid[0], mid[2], 0, mid[1] + 60, 400) }
  const e = evaluateDraft(DRAFT, int01, ground)
  const spline = playerCourseSpline(COURSE)
  const marks = groundMarks(e.warnings, e.level, spline)

  it('draws one loop per buried ring: its opening’s rim, round its trigger, across its facing', () => {
    const buried = e.warnings.filter((w) => w.kind === 'ring-in-ground')
    expect(buried.length).toBeGreaterThan(0)
    expect(marks.rings.map((m) => m.ring)).toEqual(buried.map((w) => w.ring))
    const live = liveRings(e.level as Level)
    for (const m of marks.rings) {
      const ring = live[m.ring] as (typeof live)[number]
      const c = ring.trigger.pos
      const f = ringFacing(ring.quat)
      expect(m.rim.length).toBe(EDITOR_POLICY.ringOpeningSamples)
      let reaches = 0
      for (const q of m.rim) {
        const d = [q[0] - c[0], q[1] - c[1], q[2] - c[2]]
        // On the trigger sphere's great circle across the facing.
        expect(Math.hypot(d[0] as number, d[1] as number, d[2] as number)).toBeCloseTo(
          ring.trigger.radius,
          6,
        )
        expect(
          Math.abs((d[0] as number) * f.x + (d[1] as number) * f.y + (d[2] as number) * f.z),
        ).toBeLessThan(1e-6)
        reaches = Math.max(reaches, ground.surfaceAt(q[0], q[2]) + groundClearance() - q[1])
      }
      // The loop drawn is where the ground reaches in, by the warning's own measure.
      expect(reaches).toBeCloseTo(buried.find((w) => w.ring === m.ring)?.metres ?? -1, 6)
    }
  })

  it('draws the line red exactly where it is under the surface, and nowhere else', () => {
    const L = spline.length
    const flown = spline.samples.filter((_, i) => (spline.arc[i] as number) <= COURSE.finish.t * L)
    const below = flown.filter((q) => q.y < ground.surfaceAt(q.x, q.z))
    expect(below.length).toBeGreaterThan(0)
    const drawn = marks.under.flat()
    for (const q of drawn)
      expect(q[1], 'a red point under the surface').toBeLessThan(ground.surfaceAt(q[0], q[2]))
    const key = (x: number, y: number, z: number): string => `${x},${y},${z}`
    const red = new Set(drawn.map((q) => key(q[0], q[1], q[2])))
    for (const q of below)
      expect(red.has(key(q.x, q.y, q.z)), 'every sample under the surface is red').toBe(true)
  })

  it('draws nothing once the line is lifted clear', () => {
    const lifted = liftClear(DRAFT, int01, ground)
    const after = evaluateDraft(lifted, int01, ground)
    expect(groundMarks(after.warnings, after.level, playerCourseSpline(lifted.course))).toEqual({
      rings: [],
      under: [],
      propRings: [], // DEV-503: no props judged here
      propLine: [],
    })
  })

  it('says why the course is refused, beside the refused buttons', () => {
    expect(refusalReadout([])).toBe('')
    const errs = e.warnings.filter((w) => w.severity === 'error').map((w) => w.message)
    const said = refusalReadout(errs)
    expect(said).toContain(errs[0] as string)
    if (errs.length > 1) expect(said).toContain(`(and ${errs.length - 1} more)`)
  })
})

describe('DEV-478 — the lift’s bound', () => {
  it('stops within EDITOR_POLICY.liftRounds rounds, whatever the ground', () => {
    // Ground that rises without end under the line: never clear, always a shortfall.
    let calls = 0
    const rising: Ground = {
      surfaceAt: () => {
        calls++
        return 1e4 + calls
      },
    }
    expect(() => liftClear(DRAFT, int01, rising)).not.toThrow()
    expect(EDITOR_POLICY.liftRounds).toBeGreaterThan(0)
  })
})
