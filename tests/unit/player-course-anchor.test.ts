// tests/unit/player-course-anchor.test.ts — DEV-501: a course's first ring is
// anchored to its start pad.
//
// Matt, 2026-09-28: *"dead-center to the launch platform, at the max
// ring-distance from the launch platform … as if i constrained the first point
// in a spline to a control object."* What is held here, as GEOMETRY (CLAUDE.md,
// the orientation lesson: a quaternion assertion is a belief written twice):
//
//  1. The anchored ring's transform: turn the pad 90° and move it by an
//     asymmetric offset, and the first ring stands `gap` along the NEW heading,
//     `h` over the foot, and a metre further along the heading is further from
//     the pad.
//  2. Ids: every course made before DEV-501 keeps its bytes and id; an anchored
//     one differs, writes no first point, and a reader derives it again.
//  3. The editor: the gap slider, the pad's move and aim, "Anchor to pad" as
//     one undo step, a locked point 0, Lift leaving it, the buried-ring fix
//     naming the pad, and DEV-486's run-in turn unable to fire.
//  4. Fly-to-author on an anchored draft: the pad at the flight's start aimed
//     along it, the rest of the line still within the fit's tolerance.

import { describe, expect, it } from 'vitest'
import type { EditionRacers } from '@/content/edition-schema'
import { type Level, liveRings, type Vec3Tuple } from '@/content/level-schema'
import {
  anchorPoint,
  canonicalPlayerCourse,
  expandPlayerCourse,
  insideArea,
  type PlayerCourse,
  playerCourseArea,
  playerCourseId,
  playerCourseSpline,
  ringFacing,
  validatePlayerCourse,
  yawForward,
} from '@/content/player-course'
import {
  aimPad,
  anchorHeading,
  anchorHeightFor,
  anchorToPad,
  createHistory,
  deletePoint,
  draftFromCourse,
  type EditorDraft,
  evaluateDraft,
  type Ground,
  groundClearance,
  insertPoint,
  loadDraft,
  movePad,
  movePoint,
  newDraft,
  record,
  runInTurn,
  saveDraft,
  setGap,
  undo,
} from '@/editor/core'
import { addPoint } from '@/editor/core/commands'
import { applyFit, FIT_POLICY, fitFlight, flightOfClip } from '@/editor/core/fit'
import { liftClear } from '@/editor/core/lift'
import { padSpot } from '@/editor/desk/slots'
import { decodeGhostClip, type GhostDoc } from '@/sim/ghost'
import anniversary from '../../content/editions/anniversary.json'
import slowDoc from '../../content/ghosts/int_01_rightSpawn_slow_01.json'
import fixture from './fixtures/player-course-v2-expansions.json'
import { shippedLevels } from './helpers/content'
import { islandGround } from './helpers/editor-course'
import { haveMaps } from './helpers/terrain-field'

const ANNIV = (anniversary as unknown as { gameplay: { racers: EditionRacers } }).gameplay.racers

type V = readonly [number, number, number]

const shipped: Level[] = shippedLevels()
const byId = new Map(shipped.map((l) => [l.id, l]))
const int01 = byId.get('int_01_hoverJet') as Level

const hyp = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot(
    (a[0] as number) - (b[0] as number),
    (a[1] as number) - (b[1] as number),
    (a[2] as number) - (b[2] as number),
  )
const plan = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot((a[0] as number) - (b[0] as number), (a[2] as number) - (b[2] as number))

const GAP = 200
/**
 * An anchored course over int_01: its pad on the sky's own start, the rest of
 * the line laid out AHEAD in the pad's own frame (so it stays a sensible line
 * whichever way the pad is later turned: the test turns the pad, not the line).
 */
const anchoredDraft = (): EditorDraft => {
  let d = setGap(newDraft(int01, ['Amber', 'Heron']), GAP)
  const s = d.course.start
  const f = yawForward(s.yaw)
  const right = { x: -f.z, z: f.x }
  const y = s.pos[1] + anchorHeightFor(int01)
  const at = (ahead: number, side: number): Vec3Tuple => [
    s.pos[0] + f.x * ahead + right.x * side,
    y,
    s.pos[2] + f.z * ahead + right.z * side,
  ]
  d = addPoint(d, at(2.5 * GAP, 60))
  d = addPoint(d, at(4 * GAP, -40))
  return d
}
const firstRing = (c: PlayerCourse): V => {
  const level = expandPlayerCourse(c, int01)
  return liveRings(level)[0]?.pos as unknown as V
}

// ── 1. The transform ────────────────────────────────────────────────────────

describe('DEV-501 — the anchored ring is the pad’s, as geometry', () => {
  it('h is the new-point height: the ring’s opening plus the hover height, over the pad’s foot', () => {
    const ring = liveRings(int01)[0]?.trigger.radius as number
    expect(anchorHeightFor(int01)).toBe(Math.ceil(ring + 4))
    expect(anchorHeightFor(int01)).toBe(27)
  })

  it('turn the pad 90° and move it (37, 0, −113): the ring stands `gap` along the NEW heading, h over the foot', () => {
    const d0 = anchoredDraft()
    const before = firstRing(d0.course)
    const s0 = d0.course.start
    // An asymmetric offset, so a swapped or negated axis cannot pass.
    const moved: Vec3Tuple = [s0.pos[0] + 37, s0.pos[1], s0.pos[2] - 113]
    const d1 = aimPad(movePad(d0, moved), s0.yaw + 90)
    const s1 = d1.course.start
    const ring = firstRing(d1.course)
    const h = anchorHeightFor(int01)

    // gap along the heading, in plan, and h over the foot.
    expect(plan(ring, s1.pos)).toBeCloseTo(GAP, 0)
    expect(ring[1] - s1.pos[1]).toBeCloseTo(h, 1)
    // ALONG the heading: a metre further along it is further from the pad; a
    // metre back along it is nearer. Neither is true of a ring off to one side
    // by as much as the rotation's 90°.
    const f = yawForward(s1.yaw)
    const past = [ring[0] + f.x, ring[1], ring[2] + f.z]
    const back = [ring[0] - f.x, ring[1], ring[2] - f.z]
    expect(plan(past, s1.pos)).toBeCloseTo(GAP + 1, 0)
    expect(plan(back, s1.pos)).toBeCloseTo(GAP - 1, 0)
    // It moved by exactly the pad's offset plus the turn of a gap-long arm.
    const f0 = yawForward(s0.yaw)
    const expected = [37 + GAP * (f.x - f0.x), 0, -113 + GAP * (f.z - f0.z)]
    expect(ring[0] - before[0]).toBeCloseTo(expected[0] as number, 0)
    expect(ring[2] - before[2]).toBeCloseTo(expected[2] as number, 0)
    // And the ring faces along the heading: its opening is square to the pad.
    const level = expandPlayerCourse(d1.course, int01)
    const n = ringFacing(liveRings(level)[0]?.quat as number[])
    expect(Math.abs(n.x * f.x + n.z * f.z)).toBeGreaterThan(0.999)
  })

  it('the gap slider moves it: the ring is always one gap ahead', () => {
    const d = anchoredDraft()
    for (const g of [120, 350, 610]) {
      const c = setGap(d, g).course
      expect(plan(c.path.points[0] as V, c.start.pos)).toBeCloseTo(g, 0)
    }
  })

  it('the run-in is ONE straight: DEV-486’s run-in turn cannot fire, however the line turns after it', () => {
    let d = anchoredDraft()
    // A second point well off to the side: a free course's point 1 corner.
    d = movePoint(d, 1, [
      (d.course.path.points[1] as V)[0] + 150,
      (d.course.path.points[1] as V)[1],
      (d.course.path.points[1] as V)[2] - 150,
    ])
    const t = runInTurn(d.course, int01)
    expect(t).not.toBeNull()
    expect(t?.padTurn).toBeLessThan(0.1)
    expect(t?.pointTurn).toBeLessThan(0.1)
    expect(
      evaluateDraft(d, int01, { surfaceAt: () => -1e4 }).warnings.some(
        (w) => w.kind === 'run-in-turn',
      ),
    ).toBe(false)
  })
})

// ── 2. The format and the ids ──────────────────────────────────────────────

describe('DEV-501 — the format: anchor is optional, the first point is derived', () => {
  const courses = (fixture as unknown as { courses: { id: string; course: unknown }[] }).courses

  it('every course made before DEV-501 keeps its bytes and its id; anchoring one changes it', () => {
    expect(courses.length).toBeGreaterThan(3)
    for (const f of courses) {
      const r = validatePlayerCourse(f.course)
      expect(r.ok).toBe(true)
      if (!r.ok) continue
      expect(playerCourseId(r.course)).toBe(f.id)
      expect(canonicalPlayerCourse(r.course)).not.toContain('anchor')
      const a = anchorToPad(draftFromCourse(r.course), 27).course
      expect(playerCourseId(a)).not.toBe(f.id)
    }
  })

  it('writes `anchor` and the pad’s point; a reader derives that point again and never reads the copy', () => {
    const c = anchoredDraft().course
    const text = canonicalPlayerCourse(c)
    const wire = JSON.parse(text)
    expect(wire.path.anchor).toEqual({ h: 27 })
    expect(wire.path.points).toHaveLength(c.path.points.length)
    expect(wire.path.points[0]).toEqual(anchorPoint(wire.start, wire.path.gap, { h: 27 }))
    const r = validatePlayerCourse(wire)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(canonicalPlayerCourse(r.course)).toBe(text)
    // A copy edited by hand is not read: the pad's point comes back.
    wire.path.points[0] = [0, 0, 0]
    const again = validatePlayerCourse(wire)
    expect(again.ok && canonicalPlayerCourse(again.course)).toBe(text)
  })

  it('one source of truth: a file whose pad is moved by hand carries its first ring with it', () => {
    const c = anchoredDraft().course
    const wire = JSON.parse(canonicalPlayerCourse(c))
    wire.start.pos[0] += 50
    const r = validatePlayerCourse(wire)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const p = r.course.path.points[0] as V
    expect(p[0] - (c.path.points[0] as V)[0]).toBeCloseTo(50, 5)
    expect(playerCourseId(r.course)).not.toBe(playerCourseId(c))
  })

  it('a stale first point in memory is not what is written: the pad’s is', () => {
    const c = anchoredDraft().course
    const stale = {
      ...c,
      path: { ...c.path, points: [[0, 0, 0] as Vec3Tuple, ...c.path.points.slice(1)] },
    }
    expect(canonicalPlayerCourse(stale)).toBe(canonicalPlayerCourse(c))
  })

  it('refuses an anchor on a v1 course, and a height out of range', () => {
    const wire = JSON.parse(canonicalPlayerCourse(anchoredDraft().course))
    expect(validatePlayerCourse({ ...wire, path: { ...wire.path, anchor: { h: -1 } } }).ok).toBe(
      false,
    )
    expect(
      validatePlayerCourse({ ...wire, path: { ...wire.path, anchor: { h: 5, y: 1 } } }).ok,
    ).toBe(false)
  })

  it('a draft keeps its anchor (and DEV-500’s water) through the browser’s drafts', () => {
    const mem = new Map<string, string>()
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    }
    const d = anchoredDraft()
    const wet = { ...d, course: { ...d.course, water: { level: 12 } } }
    expect(saveDraft(storage, 'a1', wet, 1)).toBe(true)
    const back = loadDraft(storage, 'a1')
    expect(back?.course.path.anchor).toEqual({ h: 27 })
    expect(back?.course.path.points).toEqual(d.course.path.points)
    expect(back?.course.water).toEqual({ level: 12 })
  })
})

// ── 3. The editor's commands ───────────────────────────────────────────────

describe('DEV-501 — the editor keeps point 0 the pad’s', () => {
  it('no command moves it, deletes it, or puts a point before it', () => {
    const d = anchoredDraft()
    expect(movePoint(d, 0, [0, 0, 0])).toBe(d)
    expect(deletePoint(d, 0)).toBe(d)
    expect(insertPoint(d, 0, [0, 0, 0])).toBe(d)
    // Point 1 still moves.
    expect(movePoint(d, 1, [1, 2, 3])).not.toBe(d)
  })

  it('"Anchor to pad" on an old course is ONE undo step, and a real change of geometry', () => {
    const free = anchoredDraft()
    const before: EditorDraft = {
      ...free,
      course: {
        ...free.course,
        path: {
          points: free.course.path.points.map((p) => [p[0] + 30, p[1], p[2]] as Vec3Tuple),
          gap: GAP,
        },
      },
    }
    let h = createHistory(before)
    h = record(h, anchorToPad(before, 27))
    expect(h.past.length).toBe(1)
    const c = h.present.course
    expect(c.path.anchor).toEqual({ h: 27 })
    // The author's first point is REPLACED by the pad's; the rest are kept.
    expect(c.path.points).toHaveLength(before.course.path.points.length)
    expect(c.path.points[0]).toEqual(anchorPoint(c.start, GAP, { h: 27 }))
    expect(c.path.points.slice(1)).toEqual(before.course.path.points.slice(1))
    // Already anchored: nothing to do, no entry.
    expect(anchorToPad(h.present, 27)).toBe(h.present)
    h = undo(h)
    expect(h.present).toBe(before)
  })

  it('Lift raises the rest of the line and leaves the pad’s point; the buried ring’s fix is the pad', () => {
    const d = anchoredDraft()
    const foot = d.course.start.pos[1]
    // Ground that rises into everything past the pad: 20 m over the foot.
    const ground: Ground = {
      surfaceAt: (x, z) => (plan([x, 0, z], d.course.start.pos) > 30 ? foot + 20 : foot),
    }
    const errors = evaluateDraft(d, int01, ground).warnings.filter(
      (w) => w.kind === 'ring-in-ground',
    )
    expect(errors[0]?.message).toContain('turn or move the pad')
    const lifted = liftClear(d, int01, ground)
    expect(lifted.course.path.points[0]).toEqual(d.course.path.points[0])
    expect((lifted.course.path.points[1] as V)[1]).toBeGreaterThan(
      (d.course.path.points[1] as V)[1],
    )
  })
})

// ── 4. Fly-to-author on an anchored draft ─────────────────────────────────

describe('DEV-501 — fly-to-author anchors its first point', () => {
  const clip = decodeGhostClip(slowDoc as unknown as GhostDoc)
  const flight = flightOfClip(clip, int01.worldOffset, clip.launchAt)
  const fit = fitFlight(flight.points)

  it('stands the pad at the flight’s start, aimed along it, with the pad’s point over the flight', () => {
    expect(fit).not.toBeNull()
    if (!fit) return
    const d = applyFit(newDraft(int01, ['Amber', 'Heron']), fit, int01, null, flight.seconds)
    const c = d.course
    expect(c.path.anchor).toEqual({ h: 27 })
    const first = fit.flight[0] as V
    expect(plan(c.start.pos, first)).toBeLessThan(0.2)
    expect(c.path.points[0]).toEqual(anchorPoint(c.start, c.path.gap, { h: 27 }))
    // The pad's point stands over the recorded flight, in plan.
    const near = Math.min(...fit.flight.map((p) => plan(p, c.path.points[0] as V)))
    expect(near).toBeLessThan(FIT_POLICY.toleranceMetres)
    expect(validatePlayerCourse(c, int01).ok).toBe(true)
  })

  it('the rest of the line (from point 2 on) stays within the fit’s tolerance of the flight', () => {
    if (!fit) return
    const c = applyFit(newDraft(int01, ['Amber', 'Heron']), fit, int01, null, flight.seconds).course
    const spline = playerCourseSpline(c)
    // Segments from point 2 on have only fitted points for neighbours.
    const from = spline.param.findIndex((g) => g >= 2)
    const line = spline.samples.slice(from)
    const toFlight = (p: { x: number; y: number; z: number }): number =>
      Math.min(...fit.flight.map((q) => hyp(q, [p.x, p.y, p.z])))
    const worst = Math.max(...line.map(toFlight))
    // The flight is resampled every few metres: its chord adds that at most.
    expect(worst).toBeLessThanOrEqual(fit.tolerance + 5)
  })
})

// ── 5. A heading whose ring 1 stands clear ─────────────────────────────────

/** Ring 1's own buried-ring error, as the EXPANSION places it: a line past it makes a course to judge. */
const ring1Buried = (d: EditorDraft, donor: Level, ground: Ground): boolean => {
  const s = d.course.start
  const f = yawForward(s.yaw)
  const far: Vec3Tuple = [
    s.pos[0] + f.x * d.course.path.gap * 3,
    s.pos[1] + 400,
    s.pos[2] + f.z * d.course.path.gap * 3,
  ]
  return evaluateDraft(addPoint(d, far), donor, ground).warnings.some(
    (w) => w.kind === 'ring-in-ground' && w.ring === 0,
  )
}

describe('DEV-501 — the pad turns (only) until ring 1 clears', () => {
  it('keeps the heading it has where ring 1 is clear, and a free course’s always', () => {
    const d = setGap(newDraft(int01, ['Amber', 'Heron']), GAP)
    const flat: Ground = { surfaceAt: () => d.course.start.pos[1] }
    expect(anchorHeading(d.course, int01, flat)).toEqual({ yaw: d.course.start.yaw, clears: true })
    const free = { ...d.course, path: { points: d.course.path.points, gap: GAP } }
    const wall: Ground = { surfaceAt: () => 1e4 }
    expect(anchorHeading(free, int01, wall).yaw).toBe(d.course.start.yaw)
  })

  it('turns away from a mesa dead ahead to the nearest heading that clears it', () => {
    const d = setGap(newDraft(int01, ['Amber', 'Heron']), GAP)
    const s = d.course.start
    const f = yawForward(s.yaw)
    // A mesa more than 100 m out, within 60° either side of the heading.
    const mesa: Ground = {
      surfaceAt: (x, z) => {
        const dx = x - s.pos[0]
        const dz = z - s.pos[2]
        const r = Math.hypot(dx, dz)
        const ahead = dx * f.x + dz * f.z
        return r > 100 && ahead / r > Math.cos(Math.PI / 3) ? s.pos[1] + 300 : s.pos[1]
      },
    }
    expect(ring1Buried(d, int01, mesa), 'the base’s own heading buries ring 1').toBe(true)
    const { yaw, clears } = anchorHeading(d.course, int01, mesa)
    expect(clears).toBe(true)
    expect(ring1Buried(aimPad(d, yaw), int01, mesa), `turned to ${yaw}°`).toBe(false)
    const by = Math.abs(((yaw - s.yaw + 540) % 360) - 180)
    expect(by, 'past the mesa’s 60°, and the nearest step past it').toBeGreaterThan(60)
    expect(by).toBeLessThanOrEqual(90)
  })

  it('where nothing clears, keeps the least-buried heading, SAYS it does not clear, and the error stands', () => {
    const d = setGap(newDraft(int01, ['Amber', 'Heron']), GAP)
    const s = d.course.start
    const bowl: Ground = {
      surfaceAt: (x, z) => s.pos[1] + 0.3 * Math.hypot(x - s.pos[0], z - s.pos[2]),
    }
    const { yaw, clears } = anchorHeading(d.course, int01, bowl)
    expect(clears, 'the search reports that no heading cleared').toBe(false)
    expect(ring1Buried(aimPad(d, yaw), int01, bowl)).toBe(true)
  })
})

describe.skipIf(!haveMaps)('DEV-501 — the desert canyon’s new course', () => {
  it('its pad, where the desk’s search stands it, is turned until ring 1 clears the mesa', () => {
    const adv01 = byId.get('adv_01_hoverJet') as Level
    const ground = islandGround(adv01)
    const d = newDraft(adv01, ['Amber', 'Heron'])
    const area = playerCourseArea(adv01)
    const inside = (x: number, y: number, z: number): boolean =>
      area ? insideArea(area, { x, y, z }) : true
    const spot = padSpot(ground, adv01, ANNIV, d.course.start, groundClearance(), inside)
    expect(spot).not.toBeNull()
    const placed = movePad(d, (spot as { pos: Vec3Tuple }).pos)
    // The e2e found it (DEV-500's canyon): the base's own heading puts ring 1 in the mesa.
    expect(ring1Buried(placed, adv01, ground), 'the base’s heading buries ring 1').toBe(true)
    const { yaw, clears } = anchorHeading(placed.course, adv01, ground)
    expect(clears).toBe(true)
    expect(ring1Buried(aimPad(placed, yaw), adv01, ground), `turned to ${yaw}°`).toBe(false)
    // …and the straight to it is clear too (the run-in's own warnings), since
    // Lift cannot raise an anchored point to mend it.
    const aimed = aimPad(placed, yaw)
    const s = aimed.course.start
    const f = yawForward(s.yaw)
    const far: Vec3Tuple = [
      s.pos[0] + f.x * aimed.course.path.gap * 3,
      s.pos[1] + 400,
      s.pos[2] + f.z * aimed.course.path.gap * 3,
    ]
    const runIn = evaluateDraft(addPoint(aimed, far), adv01, ground).warnings.filter(
      (w) => (w as { runIn?: unknown }).runIn !== undefined,
    )
    expect(runIn.map((w) => w.message)).toEqual([])
  })
})

describe.skipIf(haveMaps)('DEV-501 — the canyon case is gated (loud counterpart)', () => {
  it('skips only because the gitignored height maps are absent', () => {
    expect(haveMaps).toBe(false)
  })
})
