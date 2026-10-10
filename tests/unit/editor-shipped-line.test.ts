// tests/unit/editor-shipped-line.test.ts — the shipped desk's racing line.
// DEV-541 (plan/SHIPPED-COURSE-EDITS.md §4.4).
//
// "Edit the line" seeds the file's `route.points` by `fitFlight` over 2016's
// own line; the control points then move, insert and delete as entities; "Snap
// ring to line" stands a ring on the line the course flies. Held here:
//
//  1. THE SEED, on every editable mission: inside the format's 64 points and
//     the fit's own tolerance, and every trigger still within its radius of
//     the seeded line — so pressing "Edit the line" alone warns about nothing.
//  2. WHAT THE FILE HOLDS: `route` and nothing but its `points` (DEV-538's
//     closed list), validated and already the writer's canonical text, after
//     every line command. A command the validator would refuse is refused.
//  3. SNAP, as geometry (the orientation lesson): a ring 2016 put on the line
//     barely moves or turns; a ring moved 60 m off comes back onto it, facing
//     along it.
//
// Whether the racers then fly it is `override-racers.test.ts`'s proof, and the
// last block here runs it on a snapped ring. No file is written.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildCourseSpline, nearestArc, splinePointAt } from '@/content/course-spline'
import { type Edition, validateEdition } from '@/content/edition-schema'
import {
  applyOverride,
  canonicalOverrideText,
  manifestShaOf,
  OVERRIDE_FIELDS,
  OVERRIDE_SHAPE,
  ringKey,
  validateOverride,
} from '@/content/level-override'
import {
  type Level,
  liveRings,
  type Ring,
  type Vec3Tuple,
  validateLevel,
} from '@/content/level-schema'
import { generatedLevelIds, loadBaselineLevel } from '@/content/load-level'
import { PLAYER_COURSE_LIMITS, PLAYER_COURSE_SHAPE, ringFacing } from '@/content/player-course'
import {
  createHistory,
  deleteLinePoint,
  distanceToLine,
  editLine,
  entityState,
  evaluateShipped,
  FIT_POLICY,
  insertLinePointAfter,
  isShippedEditable,
  linePoints,
  moveEntity,
  moveLinePoint,
  nearestOnLine,
  openShipped,
  overrideSummary,
  overrideText,
  record,
  removeEntity,
  revertEntity,
  revertLine,
  SHIPPED_DRAFT_KIND,
  type ShippedDraft,
  sameEntity,
  seedLine,
  selectEntity,
  shippedLevel,
  shippedPose,
  snapRingToLine,
  undo,
} from '@/editor/core'
import { validateModeContent } from '@/game/modes'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'
import { proveCourse } from './helpers/override-race'
import { REPO as ROOT } from './helpers/repo-root'

const MANIFEST = fs.readFileSync(path.join(ROOT, 'content', '_generated.sha256'), 'utf8')
const ID = 'int_01_hoverJet'
/** The furthest a point on the format's 10 cm grid stands from where it was asked for. */
const ON_GRID = (OVERRIDE_SHAPE.posQuantumMetres / 2) * Math.sqrt(3) + 1e-9
const GAP = PLAYER_COURSE_LIMITS.pointSpacingMetres.min
const PRESETS = [
  validateEdition(anniversaryJson as unknown as Edition),
  validateEdition(classicJson as unknown as Edition),
]

const sha = (id: string): string => {
  const s = manifestShaOf(MANIFEST, id)
  if (!s) throw new Error(`no manifest line for ${id}`)
  return s
}
const open = async (id = ID): Promise<ShippedDraft> =>
  openShipped(await loadBaselineLevel(id), sha(id), null, null).draft
const editable = async (): Promise<Level[]> => {
  const out: Level[] = []
  for (const id of generatedLevelIds()) {
    const base = await loadBaselineLevel(id)
    if (isShippedEditable(base)) out.push(base)
  }
  return out
}
const dist = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot(
    (a[0] as number) - (b[0] as number),
    (a[1] as number) - (b[1] as number),
    (a[2] as number) - (b[2] as number),
  )
const ringAt = (level: Level, i: number): Ring => liveRings(level)[i] as Ring
/** Degrees between two directions, sign ignored (a ring's facing is a line, not an arrow). */
const angleDeg = (a: readonly number[], b: readonly number[]): number => {
  const dot = Math.abs(
    ((a[0] as number) * (b[0] as number) +
      (a[1] as number) * (b[1] as number) +
      (a[2] as number) * (b[2] as number)) /
      (Math.hypot(a[0] as number, a[1] as number, a[2] as number) *
        Math.hypot(b[0] as number, b[1] as number, b[2] as number)),
  )
  return (Math.acos(Math.min(1, dot)) * 180) / Math.PI
}
const facingOf = (r: Ring): number[] => {
  const f = ringFacing(r.quat)
  return [f.x, f.y, f.z]
}

/** What the file would say, read back the way the writer and the loader read it. */
const roundTrips = (d: ShippedDraft): void => {
  const text = overrideText(d.override)
  expect(text).not.toBeNull()
  const checked = validateOverride(JSON.parse(text as string))
  expect(checked.ok, JSON.stringify(checked)).toBe(true)
  if (checked.ok) expect(canonicalOverrideText(checked.override)).toBe(text)
  if (d.override.route) {
    expect(Object.keys(d.override.route)).toEqual([...OVERRIDE_FIELDS.route])
  }
  expect(() => shippedLevel(d)).not.toThrow()
}

// ── 1. The seed ────────────────────────────────────────────────────────────

describe('DEV-541 — “Edit the line” seeds the file’s line from 2016’s', () => {
  it('on every editable mission: inside the format’s points, the fit’s tolerance, and every ring’s trigger', async () => {
    const missions = await editable()
    expect(missions.length).toBeGreaterThan(0)
    for (const base of missions) {
      const fit = seedLine(base)
      expect(fit, base.id).not.toBeNull()
      if (!fit) continue
      expect(fit.withinTolerance, `${base.id}: fitted at ${fit.tolerance} m`).toBe(true)
      expect(fit.error).toBeLessThanOrEqual(FIT_POLICY.toleranceMetres)
      expect(fit.points.length).toBeLessThanOrEqual(PLAYER_COURSE_LIMITS.points.max)
      const d = editLine(openShipped(base, sha(base.id), null, null).draft)
      expect(linePoints(d)).toEqual(fit.points)
      roundTrips(d)
      // The loader's line is the file's curve, and it lies within the fit's
      // tolerance of 2016's line — measured on 2016's line, to the new one's segments.
      const level = shippedLevel(d)
      const worst = Math.max(...(base.route ?? []).map((p) => distanceToLine(p, level.route ?? [])))
      expect(worst, `${base.id}: 2016's line to the seeded one`).toBeLessThanOrEqual(
        FIT_POLICY.toleranceMetres,
      )
      // Pressing it warns about nothing: every trigger is still on the line.
      const warnings = evaluateShipped(d, null).warnings.map((w) => w.kind)
      expect(warnings, base.id).not.toContain('ring-off-line')
      expect(warnings).not.toContain('invalid')
    }
  })

  it('is one command, never re-seeds an edited line, and 2016’s line puts it all back', async () => {
    const d0 = await open()
    const d1 = editLine(d0)
    expect(d1).not.toBe(d0)
    expect(overrideSummary(d1.override).linePoints).toBe(linePoints(d1)?.length)
    // One history step, and an undo leaves no file.
    let h = record(createHistory(d0, SHIPPED_DRAFT_KIND), d1)
    expect(h.past).toHaveLength(1)
    h = undo(h)
    expect(overrideText(h.present.override)).toBeNull()
    // A second press is nothing: the edited line stands.
    const moved = moveLinePoint(d1, 3, [0, 500, 0])
    expect(editLine(moved)).toBe(moved)
    // "2016's line": the route goes, and with nothing else edited so does the file.
    const back = revertLine(selectEntity(moved, { kind: 'point', index: 3 }))
    expect(back.override.route).toBeUndefined()
    expect(back.selection).toBeNull()
    expect(overrideText(back.override)).toBeNull()
    expect(revertLine(back)).toBe(back)
  })
})

// ── 2. The control points ──────────────────────────────────────────────────

describe('DEV-541 — the line’s control points', () => {
  it('move on the format’s grid, and are refused where the validator would refuse the line', async () => {
    const d = editLine(await open())
    const pts = linePoints(d) as Vec3Tuple[]
    const p = pts[5] as Vec3Tuple
    const moved = moveLinePoint(d, 5, [p[0] + 12.34, p[1] - 7.07, p[2]])
    expect(
      dist((linePoints(moved) as Vec3Tuple[])[5] as Vec3Tuple, [p[0] + 12.34, p[1] - 7.07, p[2]]),
    ).toBeLessThanOrEqual(ON_GRID)
    roundTrips(moved)
    // Onto its neighbour: nearer than the least spacing, refused.
    const n = pts[6] as Vec3Tuple
    expect(moveLinePoint(d, 5, [n[0] + GAP / 2, n[1], n[2]])).toBe(d)
    // Out of the format's bounds, refused; not finite, refused; nowhere, refused.
    const far = PLAYER_COURSE_LIMITS.coordinateMetres * 2
    expect(moveLinePoint(d, 5, [far, 0, 0])).toBe(d)
    expect(moveLinePoint(d, 5, [Number.NaN, 0, 0])).toBe(d)
    expect(moveLinePoint(d, pts.length, [0, 0, 0])).toBe(d)
    // On 2016's line there are no points to move.
    const plain = await open()
    expect(moveLinePoint(plain, 0, [0, 0, 0])).toBe(plain)
  })

  it('are entities like a ring: picked, moved, removed, never “put back as 2016”', async () => {
    const d = editLine(await open())
    const e = { kind: 'point', index: 4 } as const
    expect(sameEntity(e, { kind: 'point', index: 4 })).toBe(true)
    expect(sameEntity(e, { kind: 'point', index: 5 })).toBe(false)
    const picked = selectEntity(d, e)
    expect(selectEntity(picked, { kind: 'point', index: 4 })).toBe(picked)
    const pose = shippedPose(picked, shippedLevel(picked), e)
    expect(pose?.pos).toEqual((linePoints(d) as Vec3Tuple[])[4])
    const up = moveEntity(
      picked,
      e,
      [pose?.pos[0] ?? 0, (pose?.pos[1] ?? 0) + 30, pose?.pos[2] ?? 0],
      [0, 0, 0, 1],
    )
    expect((linePoints(up) as Vec3Tuple[])[4]?.[1]).toBeCloseTo((pose?.pos[1] ?? 0) + 30, 5)
    expect(entityState(up, e)).toBe('moved')
    expect(revertEntity(up, e)).toBe(up)
    const gone = removeEntity(up, e)
    expect(linePoints(gone)).toHaveLength((linePoints(up)?.length ?? 0) - 1)
    expect(gone.selection).toBeNull()
    roundTrips(gone)
  })

  it('insert ON the curve, half way between two points, and not past the format’s 64', async () => {
    const d = editLine(await open())
    const pts = linePoints(d) as Vec3Tuple[]
    const i = 7
    const next = insertLinePointAfter(d, i)
    const after = linePoints(next) as Vec3Tuple[]
    expect(after).toHaveLength(pts.length + 1)
    expect(next.selection).toEqual({ kind: 'point', index: i + 1 })
    const added = after[i + 1] as Vec3Tuple
    // On the OLD curve (to its nearest point, not its parameter), between its neighbours.
    const spline = buildCourseSpline(
      pts.map(([x, y, z]) => ({ x, y, z })),
      {
        divisionsPerSegment: PLAYER_COURSE_SHAPE.divisionsPerSegment,
        tension: PLAYER_COURSE_SHAPE.tension,
      },
    )
    const v = { x: added[0], y: added[1], z: added[2] }
    const s = nearestArc(spline, v)
    const on = splinePointAt(spline, s)
    expect(dist([on.x, on.y, on.z], added)).toBeLessThanOrEqual(ON_GRID + 0.05)
    const sOf = (p: Vec3Tuple) => nearestArc(spline, { x: p[0], y: p[1], z: p[2] })
    expect(s).toBeGreaterThan(sOf(pts[i] as Vec3Tuple))
    expect(s).toBeLessThan(sOf(pts[i + 1] as Vec3Tuple))
    roundTrips(next)
    // After the last point: as far on again as the last stands past the one before.
    const last = pts.length - 1
    const tail = linePoints(insertLinePointAfter(d, last)) as Vec3Tuple[]
    const a = pts[last - 1] as Vec3Tuple
    const b = pts[last] as Vec3Tuple
    expect(
      dist(tail[last + 1] as Vec3Tuple, [2 * b[0] - a[0], 2 * b[1] - a[1], 2 * b[2] - a[2]]),
    ).toBeLessThanOrEqual(ON_GRID)
    // Full: refused.
    // Grown point by point, each after a different point (one segment halved
    // over and over would reach the least spacing first, and be refused for that).
    let full = d
    for (let k = 0; (linePoints(full)?.length ?? 0) < PLAYER_COURSE_LIMITS.points.max; k += 2) {
      const grown = insertLinePointAfter(full, k % ((linePoints(full)?.length ?? 1) - 1))
      expect(grown).not.toBe(full)
      full = grown
    }
    for (let k = 0; k < PLAYER_COURSE_LIMITS.points.max; k++) {
      expect(insertLinePointAfter(full, k)).toBe(full)
    }
    // Halving one segment over and over reaches the least spacing, and stops there.
    let halved = d
    for (let k = 0; k < PLAYER_COURSE_LIMITS.points.max; k++) {
      const next2 = insertLinePointAfter(halved, 0)
      if (next2 === halved) break
      halved = next2
    }
    const h = linePoints(halved) as Vec3Tuple[]
    expect(h.length).toBeLessThan(PLAYER_COURSE_LIMITS.points.max)
    expect(dist(h[0] as Vec3Tuple, h[1] as Vec3Tuple)).toBeGreaterThanOrEqual(GAP)
    roundTrips(halved)
  })

  it('delete down to the format’s two, and no further', async () => {
    let d = editLine(await open())
    while ((linePoints(d)?.length ?? 0) > PLAYER_COURSE_LIMITS.points.min) {
      const next = deleteLinePoint(d, 1)
      expect(next).not.toBe(d)
      d = next
    }
    expect(deleteLinePoint(d, 0)).toBe(d)
    roundTrips(d)
  })
})

// ── 3. Snap ────────────────────────────────────────────────────────────────

describe('DEV-541 — “Snap ring to line”', () => {
  it('a ring 2016 put on its line barely moves or turns (the facing convention is right)', async () => {
    // If the snap read a 2016 ring's facing backwards it would turn it 180°;
    // on the line it should do almost nothing. Every live ring of int_01.
    const d = await open()
    for (const [i, r] of liveRings(d.base).entries()) {
      const key = ringKey(r) as string
      const snapped = ringAt(shippedLevel(snapRingToLine(d, key)), i)
      expect(dist(snapped.pos, r.pos), `ring ${i + 1} moved`).toBeLessThan(r.trigger.radius / 4)
      expect(angleDeg(facingOf(snapped), facingOf(r)), `ring ${i + 1} turned`).toBeLessThan(15)
    }
  })

  it('a ring moved 60 m off the line comes back onto it, facing along it', async () => {
    const d0 = await open()
    const i = 10
    const r = ringAt(d0.base, i)
    const key = ringKey(r) as string
    const along = nearestOnLine(r.pos, d0.base.route ?? [])?.along as Vec3Tuple
    // Sideways, horizontally, across the line's direction.
    const side = [along[2], 0, -along[0]]
    const n = Math.hypot(side[0] as number, side[2] as number)
    const off: Vec3Tuple = [
      r.pos[0] + ((side[0] as number) / n) * 60,
      r.pos[1],
      r.pos[2] + ((side[2] as number) / n) * 60,
    ]
    const moved = moveEntity(d0, { kind: 'ring', key }, off, r.quat)
    expect(evaluateShipped(moved, null).warnings.map((w) => w.kind)).toContain('ring-off-line')
    const snapped = snapRingToLine(moved, key)
    const level = shippedLevel(snapped)
    const s = ringAt(level, i)
    expect(distanceToLine(s.pos, level.route ?? [])).toBeLessThanOrEqual(ON_GRID)
    expect(distanceToLine(s.trigger.pos, level.route ?? [])).toBeLessThan(s.trigger.radius / 4)
    const there = nearestOnLine(s.pos, level.route ?? [])?.along as Vec3Tuple
    expect(angleDeg(facingOf(s), there)).toBeLessThan(1)
    expect(evaluateShipped(snapped, null).warnings.map((w) => w.kind)).not.toContain(
      'ring-off-line',
    )
    roundTrips(snapped)
    // One command, so one undo step back to where it was moved.
    const h = undo(record(record(createHistory(d0, SHIPPED_DRAFT_KIND), moved), snapped))
    expect(h.present).toBe(moved)
  })

  it('stands a ring on an EDITED line: the one the course flies', async () => {
    const d = editLine(await open())
    const i = 10
    const key = ringKey(ringAt(d.base, i)) as string
    // Pull the nearest control point 50 m up; ring 11 is left behind, off the line.
    const pts = linePoints(d) as Vec3Tuple[]
    const at = ringAt(d.base, i).pos
    let j = 0
    pts.forEach((p, k) => {
      if (dist(p, at) < dist(pts[j] as Vec3Tuple, at)) j = k
    })
    const p = pts[j] as Vec3Tuple
    const lifted = moveLinePoint(d, j, [p[0], p[1] + 50, p[2]])
    const before = shippedLevel(lifted)
    expect(distanceToLine(ringAt(before, i).trigger.pos, before.route ?? [])).toBeGreaterThan(
      ringAt(before, i).trigger.radius,
    )
    const level = shippedLevel(snapRingToLine(lifted, key))
    expect(distanceToLine(ringAt(level, i).pos, level.route ?? [])).toBeLessThanOrEqual(ON_GRID)
  })
})

// ── 4. The proof, on the desk's own edits ──────────────────────────────────

describe('DEV-541 — the racer proof on the desk’s edits', () => {
  it('a ring moved off the line is red; snapped back onto it, green', async () => {
    const d0 = await open()
    const i = 10
    const r = ringAt(d0.base, i)
    const key = ringKey(r) as string
    const along = nearestOnLine(r.pos, d0.base.route ?? [])?.along as Vec3Tuple
    const n = Math.hypot(along[0], along[2])
    const off: Vec3Tuple = [
      r.pos[0] + (along[2] / n) * 60,
      r.pos[1],
      r.pos[2] - (along[0] / n) * 60,
    ]
    const moved = moveEntity(d0, { kind: 'ring', key }, off, r.quat)
    const level = (d: ShippedDraft) =>
      validateModeContent(validateLevel(applyOverride(d.base, d.override)))
    const red = proveCourse(level(moved), PRESETS)
    expect(
      red.some((m) => m.includes(`took ring ${i + 1} `)),
      red.join('\n'),
    ).toBe(true)
    const green = proveCourse(level(snapRingToLine(moved, key)), PRESETS)
    expect(green, green.join('\n')).toEqual([])
  }, 120_000)
})
