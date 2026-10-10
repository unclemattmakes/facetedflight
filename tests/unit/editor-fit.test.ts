// tests/unit/editor-fit.test.ts — fly-to-author: a flight becomes the line.
// DEV-491 (docs/plan/EDITOR-WAVE-3.md; `src/editor/core/fit.ts`).
//
// The oracle is OUTSIDE the port: 2016's own recorded flights of `int_01`
// (`content/ghosts/`), and 2016's own `int_01` rings. The fit must reproduce
// the recorded route within its tolerance — measured here by this file's own
// distance code, over the RAW recorded keys and the course's own curve, not by
// the fit's span measure — and the course fitted from the slow flight must be
// one that flight takes every ring of, and must pass through every one of the
// 21 rings 2016 hung on that route.
//
//  1. The policy, pinned by value, and the tolerance against the rings.
//  2. 2016's flights, fitted.
//  3. The fitted course, applied: one undo step, the pad, the finish.
//  4. The recording: DEV-370's recorder to world points, and the level it is flown in.
//  5. Shapes: a figure of eight, a flight too long for 64 points, too short.

import { describe, expect, it } from 'vitest'
import { type Level, liveRings, type Vec3Tuple } from '@/content/level-schema'
import {
  expandPlayerCourse,
  PLAYER_COURSE_LIMITS,
  type PlayerCourse,
  playerCourseSpline,
  validatePlayerCourse,
  yawForward,
} from '@/content/player-course'
import {
  createHistory,
  draftFromCourse,
  type EditorDraft,
  evaluateDraft,
  type Ground,
  newDraft,
  record,
  runInTurn,
  tightestTurnRadius,
  undo,
} from '@/editor/core'
import {
  applyFit,
  douglasPeucker,
  FIT_POLICY,
  fitFlight,
  fitSampleMetres,
  flightOfClip,
  recordingLevel,
  resampleFlight,
} from '@/editor/core/fit'
import { courseGates } from '@/game/mission'
import { MODES, runningMode } from '@/game/modes'
import { FIXED_DT } from '@/sim/constants'
import { decodeGhostClip, type GhostDoc, scoreGhost } from '@/sim/ghost'
import { createLapRecorder, markLapEvent, recordedLap, recordPose } from '@/sim/ghost-record'
import fastDoc from '../../content/ghosts/int_01_leftSpawn_fast_01.json'
import slowDoc from '../../content/ghosts/int_01_rightSpawn_slow_01.json'
import { shippedLevels } from './helpers/content'

type V = readonly [number, number, number]

const shipped: Level[] = shippedLevels()
const hoverjets = shipped.filter((l) => l.vehicle === 'hoverjet')
const int01 = shipped.find((l) => l.id === 'int_01_hoverJet') as Level

// ── This file's own geometry: the test's measure, not the fit's ──────────────

const segDist = (p: V, a: V, b: V): number => {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const
  const ll = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2
  let t = ll > 0 ? ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / ll : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(a[0] + ab[0] * t - p[0], a[1] + ab[1] * t - p[1], a[2] + ab[2] * t - p[2])
}
/** Nearest distance from `p` to ANY part of `line` (a global search, unlike the fit's). */
const toLine = (p: V, line: readonly V[]): number => {
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i + 1 < line.length; i++) {
    best = Math.min(best, segDist(p, line[i] as V, line[i + 1] as V))
  }
  return best
}
/** The most either of two polylines strays from the other. */
const hausdorff = (a: readonly V[], b: readonly V[]): number => {
  let d = 0
  for (const p of a) d = Math.max(d, toLine(p, b))
  for (const p of b) d = Math.max(d, toLine(p, a))
  return d
}
/** The course's curve through `points`, as the game builds it. */
const curveOf = (points: readonly Vec3Tuple[]): V[] =>
  playerCourseSpline({ path: { points, gap: 400 } } as unknown as PlayerCourse).samples.map(
    (s) => [s.x, s.y, s.z] as const,
  )

const flightOf = (doc: unknown) => {
  const clip = decodeGhostClip(doc as GhostDoc)
  // From the launch: before it, both 2016 clips sit on their pad (DEV-025).
  return flightOfClip(clip, int01.worldOffset, clip.launchAt)
}

/**
 * DEV-501: a new draft is ANCHORED; these specs are of the FREE first point a
 * course made before it keeps, so they fit onto one. The anchored fit is held
 * in `player-course-anchor.test.ts`.
 */
const newFree = (l: Level, name: readonly [string, string]): EditorDraft => {
  const d = newDraft(l, name)
  return { ...d, course: { ...d.course, path: { points: [], gap: d.course.path.gap } } }
}

// ── 1. The policy ───────────────────────────────────────────────────────────

describe('the fit’s policy', () => {
  it('is pinned by value: moving one is an edit made here on purpose', () => {
    expect(FIT_POLICY).toEqual({
      toleranceMetres: 8,
      sampleSpacingFactor: 2,
      seedFactor: 4,
      spanRatio: 3,
      widenBy: 1.25,
    })
    // Derived, not typed: twice the format's least point spacing.
    expect(fitSampleMetres()).toBe(PLAYER_COURSE_LIMITS.pointSpacingMetres.min * 2)
  })

  it('premise: the tolerance is under half the trigger radius of every HoverJet ring 2016 shipped', () => {
    const radii = hoverjets.flatMap((l) => liveRings(l).map((r) => r.trigger.radius))
    expect(radii.length).toBeGreaterThan(100)
    expect(FIT_POLICY.toleranceMetres).toBeLessThan(Math.min(...radii) / 2)
  })
})

// ── 2. 2016's flights ───────────────────────────────────────────────────────

describe('2016’s int_01 flights, fitted', () => {
  for (const [name, doc] of [
    ['the slow flight (int_01_rightSpawn_slow_01)', slowDoc],
    ['the fast flight (int_01_leftSpawn_fast_01)', fastDoc],
  ] as const) {
    it(`${name}: the line lies within the tolerance of the recorded keys, both ways, in ≤ 64 points`, () => {
      const f = flightOf(doc)
      expect(f.points.length).toBeGreaterThan(1000)
      const fit = fitFlight(f.points)
      expect(fit).not.toBeNull()
      if (!fit) return
      expect(fit.withinTolerance).toBe(true)
      expect(fit.points.length).toBeLessThanOrEqual(PLAYER_COURSE_LIMITS.points.max)
      // Measured HERE, over the raw keys (not the resampled flight the fit
      // saw) and the curve the game builds. The resampling's own chord error
      // is its sagitta, s²/8R: under 0.3 m at 10 m on a 50 m turn.
      const d = hausdorff(f.points, curveOf(fit.points))
      expect(d).toBeLessThanOrEqual(FIT_POLICY.toleranceMetres + 0.3)
      // …and it is a course the format takes.
      const course: PlayerCourse = {
        ...newFree(int01, ['Amber', 'Heron']).course,
        path: { points: fit.points, gap: 400 },
      }
      expect(validatePlayerCourse(course, int01).ok).toBe(true)
    })
  }

  it('reproduces 2016’s COURSE: every one of int_01’s rings stands within its trigger radius of the line fitted from the slow flight', () => {
    const fit = fitFlight(flightOf(slowDoc).points)
    if (!fit) throw new Error('no fit')
    const curve = curveOf(fit.points)
    const rings = liveRings(int01)
    expect(rings.length).toBe(21)
    for (const [i, r] of rings.entries()) {
      expect(toLine(r.pos as unknown as V, curve), `ring ${i}`).toBeLessThan(r.trigger.radius)
    }
  })

  it('the slow flight takes every ring of the course fitted from it, and crosses its finish', () => {
    const f = flightOf(slowDoc)
    const fit = fitFlight(f.points)
    if (!fit) throw new Error('no fit')
    const draft = applyFit(newFree(int01, ['Amber', 'Heron']), fit, int01, null, f.seconds)
    const level = expandPlayerCourse(draft.course, int01)
    const gates = courseGates(level)
    expect(gates.length).toBeGreaterThan(10)
    const fin = level.finish as NonNullable<Level['finish']>
    const r = scoreGhost(decodeGhostClip(slowDoc as unknown as GhostDoc), {
      gates,
      finish: { x: fin.pos[0], y: fin.pos[1], z: -fin.pos[2], radius: fin.radius },
      worldOffset: [int01.worldOffset[0], int01.worldOffset[1], int01.worldOffset[2]],
    })
    expect(r.gates).toBe(r.gatesTotal)
    expect(r.seconds).not.toBeNull()
  })
})

// ── 3. The fit, applied ─────────────────────────────────────────────────────

describe('applyFit', () => {
  const f = flightOf(slowDoc)
  const fitted = fitFlight(f.points)
  if (!fitted) throw new Error('no fit')
  const fit = fitted
  const flat = (h: number): Ground => ({ surfaceAt: () => h })

  it('is ONE undo step, and the undo gives back the draft as it was', () => {
    const before = newFree(int01, ['Amber', 'Heron'])
    let h = createHistory(before)
    h = record(h, applyFit(before, fit, int01, flat(0), f.seconds))
    expect(h.present.course.path.points.length).toBe(fit.points.length)
    expect(h.past.length).toBe(1)
    h = undo(h)
    expect(h.present).toBe(before)
  })

  it('stands the pad on the ground under the flight’s start, aimed along the line’s first stretch', () => {
    const d = applyFit(newFree(int01, ['Amber', 'Heron']), fit, int01, flat(12), f.seconds)
    const s = d.course.start
    const p0 = fit.points[0] as Vec3Tuple
    expect(s.pos[0]).toBe(p0[0])
    expect(s.pos[2]).toBe(p0[2])
    expect(s.pos[1]).toBe(12)
    // Geometry, not the angle: 50 m along the heading from the pad lands
    // within a couple of metres of the line 50 m on.
    const fwd = yawForward(s.yaw)
    const curve = curveOf(d.course.path.points)
    const horiz = (a: V, b: V) => Math.hypot(a[0] - b[0], a[2] - b[2])
    const onward = curve.find((q) => horiz(q, p0 as V) >= 50) as V
    const ahead: V = [p0[0] + fwd.x * 50, p0[1], p0[2] + fwd.z * 50]
    expect(horiz(ahead, onward)).toBeLessThan(3)
  })

  it('leaves the finish one gate radius before the end, clears the skips, keeps the gap, and a time limit the flight fits in', () => {
    const before = newFree(int01, ['Amber', 'Heron'])
    const withSkip = {
      ...before,
      course: { ...before.course, rings: [{ t: 0.5, skip: true as const }], timeLimit: 30 },
    }
    const d = applyFit(withSkip, fit, int01, null, f.seconds)
    const L = playerCourseSpline(d.course).length
    const fin = int01.finish as NonNullable<Level['finish']>
    expect((1 - d.course.finish.t) * L).toBeGreaterThanOrEqual(fin.radius - 0.01 * L)
    expect((1 - d.course.finish.t) * L).toBeLessThan(fin.radius + 2)
    expect(d.course.rings).toEqual([])
    expect(d.course.path.gap).toBe(before.course.path.gap)
    expect(d.course.timeLimit).toBe(Math.ceil(f.seconds))
    expect(d.selection).toBeNull()
  })

  it('without a ground, the pad’s foot is the start less the sky’s lift', () => {
    const d = applyFit(newFree(int01, ['Amber', 'Heron']), fit, int01, null, f.seconds)
    const p = int01.spawn.launch?.platform as {
      shipOffset: readonly number[]
      offset: readonly number[]
    }
    expect(d.course.start.pos[1]).toBeCloseTo(
      (fit.points[0] as Vec3Tuple)[1] - ((p.shipOffset[1] as number) - (p.offset[1] as number)),
      6,
    )
  })

  it('passes DEV-486’s run-in: the line starts over the pad, and the pad faces along it', () => {
    const d = applyFit(newFree(int01, ['Amber', 'Heron']), fit, int01, flat(0), f.seconds)
    const turn = runInTurn(d.course, int01)
    expect(turn).not.toBeNull()
    expect(turn?.overPad).toBe(true)
    expect(turn?.padTurn ?? 180).toBeLessThan(1)
    expect(turn?.radius ?? 0).toBeGreaterThanOrEqual(tightestTurnRadius())
    const kinds = evaluateDraft(d, int01, flat(0)).warnings.map((w) => w.kind)
    expect(kinds).not.toContain('run-in-turn')
  })

  it('refuses a fit of fewer than two points, returning the draft itself', () => {
    const d = newFree(int01, ['Amber', 'Heron'])
    expect(applyFit(d, { ...fit, points: [[0, 0, 0]] }, int01, null, 1)).toBe(d)
  })
})

// ── 4. The recording ────────────────────────────────────────────────────────

describe('the recording', () => {
  it('DEV-370’s recorder, read back: SIM space in, level-frame points out, cut at the first reset', () => {
    const offset = [-2048, 0, 2048] as const
    const rec = createLapRecorder(offset)
    // A sim-space path (Unity's, z mirrored): x climbs, z runs negative.
    for (let k = 0; k < 400; k++) {
      recordPose(rec, k, { x: -800 + k, y: 150, z: -2000 - k * 0.5 }, { x: 0, y: 0, z: 0, w: 1 })
    }
    markLapEvent(rec, 300, 'reset')
    const doc = recordedLap(rec, {
      mission: 'rec',
      mode: 'freeFlight',
      edition: 'anniversary',
      rules: 'local',
      vehicle: 'hoverjet',
      build: 'test',
    })
    const f = flightOfClip(decodeGhostClip(doc), offset)
    const first = f.points[0] as V
    const last = f.points[f.points.length - 1] as V
    // THREE is sim with z flipped; the level frame is THREE.
    expect(first[0]).toBeCloseTo(-800, 2)
    expect(first[2]).toBeCloseTo(2000, 2)
    // Cut before tick 300, the reset: the last pose is from before it.
    expect(last[0]).toBeLessThan(-800 + 300)
    expect(last[0]).toBeGreaterThan(-800 + 290)
    expect(f.seconds).toBeLessThan(300 * FIXED_DT)
  })

  it('is flown in Free Flight over the sky, from the draft’s pad, with no rings, no finish and no racing line', () => {
    const d = newFree(int01, ['Amber', 'Heron'])
    const level = recordingLevel(d.course, int01) as Level
    expect(level).not.toBeNull()
    expect(runningMode(level)).toBe('freeFlight')
    // Free Flight's own rules: nothing ends it, no clock, no opponents, no autopilot (DEV-435).
    const rules = MODES[runningMode(level)]
    expect(rules.endsOn).toBe('never')
    expect(rules.clock).toBe(false)
    expect(rules.opponents).toBe(false)
    expect(rules.autopilot).toBe(false)
    expect(liveRings(level)).toEqual([])
    expect(level.finish).toBeNull()
    expect(level.route).toBeUndefined()
    expect(level.orbs).toEqual([])
    // The donor's boundary and island, the pad's spawn.
    expect(level.boundary).toEqual(int01.boundary)
    expect(level.environment).toBe(int01.environment)
    expect(level.worldOffset).toEqual(int01.worldOffset)
    expect(level.spawn.pos[0]).toBe(d.course.start.pos[0])
    expect(level.spawn.pos[2]).toBe(d.course.start.pos[2])
    expect(level.spawn.launch?.rise).toBe(0)
    expect(level.id).not.toBe(int01.id)
  })
})

// ── 5. Shapes ───────────────────────────────────────────────────────────────

describe('shapes of flight', () => {
  /** `n` points along `at(t)`, `t` in [0, 1]. */
  const sampled = (n: number, at: (t: number) => V): Vec3Tuple[] =>
    Array.from({ length: n }, (_, i) => [...at(i / (n - 1))] as Vec3Tuple)

  it('a figure of eight — a flight that crosses itself — fits within the tolerance', () => {
    const R = 400
    const pts = sampled(4000, (t) => {
      const a = t * 2 * Math.PI
      return [R * Math.sin(a), 200 + 30 * Math.sin(3 * a), R * Math.sin(a) * Math.cos(a)]
    })
    const fit = fitFlight(pts)
    if (!fit) throw new Error('no fit')
    expect(fit.withinTolerance).toBe(true)
    expect(hausdorff(pts, curveOf(fit.points))).toBeLessThanOrEqual(
      FIT_POLICY.toleranceMetres + 0.3,
    )
  })

  it('a straight flight is two points', () => {
    const pts = sampled(500, (t) => [t * 2000, 100, -t * 500])
    const fit = fitFlight(pts)
    expect(fit?.points.length).toBe(2)
    expect(fit?.error).toBeLessThan(0.2)
  })

  it('a flight too twisty for 64 points is fitted WHOLE at a wider tolerance, and says so', () => {
    // A tight slalom, 30 km long: far more bends than 64 points can hold at 8 m.
    const pts = sampled(20_000, (t) => [t * 30_000, 150, 120 * Math.sin(t * 2 * Math.PI * 90)])
    const fit = fitFlight(pts)
    if (!fit) throw new Error('no fit')
    expect(fit.withinTolerance).toBe(false)
    expect(fit.tolerance).toBeGreaterThan(FIT_POLICY.toleranceMetres)
    expect(fit.points.length).toBeLessThanOrEqual(PLAYER_COURSE_LIMITS.points.max)
    // The whole flight: it ends where the flight ended.
    const end = fit.points[fit.points.length - 1] as Vec3Tuple
    expect(Math.abs(end[0] - 30_000)).toBeLessThan(1)
    expect(fit.error).toBeLessThanOrEqual(fit.tolerance)
  })

  it('a flight too short to be a line is null', () => {
    expect(fitFlight([])).toBeNull()
    expect(fitFlight([[0, 0, 0]])).toBeNull()
    expect(fitFlight(sampled(50, () => [5, 5, 5]))).toBeNull()
  })

  it('a ship held still adds no samples: resampling is by arc, not by time', () => {
    const still = sampled(200, () => [0, 100, 0])
    const moving = sampled(101, (t) => [0, 100, -t * 100])
    expect(resampleFlight([...still, ...moving], 10).length).toBe(11)
  })

  it('Douglas–Peucker keeps a corner and drops the straight', () => {
    const L: V[] = [
      [0, 0, 0],
      [50, 0, 0],
      [100, 0, 0],
      [100, 0, 50],
      [100, 0, 100],
    ]
    expect(douglasPeucker(L, 1)).toEqual([0, 2, 4])
  })

  it('keeps the draft’s sky, name and credit', () => {
    const course = newFree(int01, ['Amber', 'Heron']).course
    const fit = fitFlight(sampled(300, (t) => [-800 + t * 1500, 200, 2000 - t * 300]))
    if (!fit) throw new Error('no fit')
    const d = applyFit(draftFromCourse(course, 'pc_000000000000'), fit, int01, null, 20)
    expect(d.course.sky).toBe(int01.id)
    expect(d.course.name).toEqual(['Amber', 'Heron'])
    expect(d.remixedFrom).toBe('pc_000000000000')
  })
})
