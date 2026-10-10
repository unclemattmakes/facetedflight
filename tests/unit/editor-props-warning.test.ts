/**
 * tests/unit/editor-props-warning.test.ts — DEV-503, the editor's prop
 * warnings: `line-through-prop` and `ring-in-prop`.
 *
 * Matt, 2026-09-28: *"a prop warning"* (docs/plan/EDITOR-PROPS.md). Three
 * layers, each held here against something outside itself:
 *
 *   1. **The sim's query** (`propsNearSegment`) against the step's OWN query,
 *      `propPenetrationAt`, swept densely along the segment with a sphere of
 *      the reach: a cylinder and a hull (a landmark's shape), at depths either
 *      side of zero. Two spellings of one test agreeing is the point; the
 *      dense sweep is the one the flight answers.
 *   2. **The adapter** (`desk/prop-colliders.ts`) converts the level frame the editor
 *      works in to the SIM frame the colliders live in: the z mirror, once.
 *      Held by a collider found where it is and NOT where its mirror would be.
 *   3. **The warnings** (`warnings.ts`, pure): an injected `Props` like
 *      `Ground`. A stretch of the flown line near a prop is one warning with
 *      its span (or its run-in fractions) and a marker per prop; a prop in a
 *      ring's opening is an ERROR on that ring; no props, no prop warnings.
 *      The reach asked for is the ship's collision radius plus the clearance
 *      for the line, the clearance for a ring — derived, never typed.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { splinePointAt } from '@/content/course-spline'
import { type Level, liveRings, type Vec3Tuple, validateLevel } from '@/content/level-schema'
import { expandPlayerCourse, playerCourseSpline } from '@/content/player-course'
import {
  draftFromCourse,
  evaluateDraft,
  type Ground,
  groundClearance,
  type PropContact,
  type Props,
  propReach,
  runInOf,
  shipCollisionRadius,
} from '@/editor/core'
import { groundMarks } from '@/editor/desk/ground-marks'
import { collidersAsProps } from '@/editor/desk/prop-colliders'
import {
  buildPropColliders,
  type PropCollisionSpec,
  type PropPlacementInput,
  propPenetrationAt,
  propsNearSegment,
  setPropCleared,
} from '@/sim/props/collision'
import { HOVERJET_GROUND } from '@/sim/terrain-collision'
import { fittedCourse } from './helpers/editor-course'
import { REPO } from './helpers/repo-root'

const LEVEL_DIR = path.join(REPO, 'content', 'levels')
const int01 = validateLevel(
  JSON.parse(fs.readFileSync(path.join(LEVEL_DIR, 'int_01_hoverJet.json'), 'utf8')) as Level,
)
const COURSE = fittedCourse(int01)
const DRAFT = draftFromCourse(COURSE)
const ABYSS: Ground = { surfaceAt: () => -1e5 }

const SPEC: PropCollisionSpec = {
  breakSpeed: 1e9,
  breakSlowdown: 0,
  bounceRestitution: 0,
  radiusFraction: 0.5,
  cellMetres: 64,
  racerStuckSeconds: 0,
}

/** A tree: a cylinder `width / 2` round its axis, `height` tall. */
const tree = (x: number, z: number, height = 30, width = 6): PropPlacementInput => ({
  x,
  y: 0,
  z,
  scale: 1,
  dims: { height, base: 0, width },
  kind: 'tree',
})

/** A box rock `2h` across and `top` tall at (x, z), with its hull: a landmark's shape. */
const rock = (x: number, z: number, h: number, top: number): PropPlacementInput => ({
  x,
  y: 0,
  z,
  scale: 1,
  dims: { height: top, base: 0, width: 2 * h },
  kind: 'spire',
  // Placement frame: inside where n·p <= d.
  hull: Float32Array.from([
    1,
    0,
    0,
    x + h,
    -1,
    0,
    0,
    -(x - h),
    0,
    1,
    0,
    top,
    0,
    -1,
    0,
    0,
    0,
    0,
    1,
    z + h,
    0,
    0,
    -1,
    -(z - h),
  ]),
})

/** The step's own answer, swept densely: the deepest a `reach` sphere goes along a→b. */
const denseDepth = (
  cols: ReturnType<typeof buildPropColliders>,
  a: readonly number[],
  b: readonly number[],
  reach: number,
): number => {
  const q = { x: 0, y: 0, z: 0, w: 1 }
  const hull = [{ x: 0, y: 0, z: 0, radius: reach }]
  const len = Math.hypot(
    (b[0] as number) - (a[0] as number),
    (b[1] as number) - (a[1] as number),
    (b[2] as number) - (a[2] as number),
  )
  const n = Math.max(1, Math.ceil(len / 0.05))
  let worst = 0
  for (let k = 0; k <= n; k++) {
    const f = k / n
    const p = {
      x: (a[0] as number) + ((b[0] as number) - (a[0] as number)) * f,
      y: (a[1] as number) + ((b[1] as number) - (a[1] as number)) * f,
      z: (a[2] as number) + ((b[2] as number) - (a[2] as number)) * f,
    }
    worst = Math.max(worst, propPenetrationAt(p, q, hull, cols))
  }
  return worst
}

// ── 1. the sim's query ────────────────────────────────────────────────────

describe('propsNearSegment agrees with the step’s own query, swept', () => {
  const origin = { x: 0, y: 0, z: 0 }

  it('a cylinder: found exactly when a reach sphere along the segment touches it', () => {
    const cols = buildPropColliders([tree(100, 100)], origin, SPEC)
    const reach = 5
    // The tree's collider radius is `radiusFraction` of its width: 3 m.
    for (const off of [-9, -7.9, -2, 0, 4, 7.9, 8.1, 12]) {
      const a: [number, number, number] = [100 + off, 10, 0]
      const b: [number, number, number] = [100 + off, 10, 200]
      const dense = denseDepth(cols, a, b, reach)
      const got = propsNearSegment(cols, a[0], a[1], a[2], b[0], b[1], b[2], reach)
      if (dense <= 0) {
        expect(got, `offset ${off}: nothing`).toEqual([])
        continue
      }
      expect(got, `offset ${off}: the tree`).toHaveLength(1)
      expect(got[0]?.id).toBe(0)
      expect(got[0]?.depth).toBeCloseTo(dense, 2)
    }
  })

  it('a cylinder is judged at the HEIGHT the segment passes: over its top by more than reach is clear', () => {
    const cols = buildPropColliders([tree(100, 100, 30)], origin, SPEC)
    const reach = 5
    expect(propsNearSegment(cols, 100, 34, 0, 100, 34, 200, reach)).toHaveLength(1)
    expect(propsNearSegment(cols, 100, 36, 0, 100, 36, 200, reach)).toEqual([])
    // Climbing THROUGH the band is found wherever it crosses it.
    // (At z = 100, the tree's plan, it is 10 m up.)
    const climb = propsNearSegment(cols, 100, 60, 0, 100, -40, 200, reach)
    expect(climb).toHaveLength(1)
    expect(climb[0]?.depth).toBeCloseTo(denseDepth(cols, [100, 60, 0], [100, -40, 200], reach), 1)
    // And one that crosses the band away from the tree is clear, as the sweep is.
    expect(propsNearSegment(cols, 100, 200, 0, 100, -100, 200, reach)).toEqual([])
    expect(denseDepth(cols, [100, 200, 0], [100, -100, 200], reach)).toBe(0)
  })

  it('a hull (a landmark): the depth is the hull’s, not its bounding cylinder’s', () => {
    // A 20 m box: its reject cylinder is the half-diagonal, 14.1 m, and a
    // segment past its CORNER region is inside the cylinder and outside the box.
    const cols = buildPropColliders([rock(500, 500, 10, 100)], origin, SPEC)
    const reach = 3
    for (const off of [8, 12, 12.9, 13.1, 16]) {
      const a: [number, number, number] = [500 + off, 50, 400]
      const b: [number, number, number] = [500 + off, 50, 600]
      const dense = denseDepth(cols, a, b, reach)
      const got = propsNearSegment(cols, a[0], a[1], a[2], b[0], b[1], b[2], reach)
      if (dense <= 0) {
        expect(got, `offset ${off}: clear of the box`).toEqual([])
        continue
      }
      expect(got, `offset ${off}: the box`).toHaveLength(1)
      // Sampled, so never deeper than the truth and never far short of it.
      expect(got[0]?.depth).toBeLessThanOrEqual(dense + 1e-6)
      expect(got[0]?.depth).toBeGreaterThan(dense - 0.05 * reach)
    }
  })

  it('an oversized collider (off the hash) is found, and each prop is reported once', () => {
    // A 200 m rock is wider than a cell: it lives on `oversized`, not in a cell.
    const cols = buildPropColliders(
      [rock(1000, 1000, 100, 300), tree(1000, 870), tree(1000, 1130)],
      origin,
      SPEC,
    )
    expect(cols.oversized).toContain(0)
    const got = propsNearSegment(cols, 1000, 10, 700, 1000, 10, 1300, 4)
    expect(got.map((h) => h.id).sort()).toEqual([0, 1, 2])
  })

  it('a broken or CLEARED collider is not there (DEV-502)', () => {
    const cols = buildPropColliders([tree(100, 100)], origin, SPEC)
    expect(propsNearSegment(cols, 100, 10, 0, 100, 10, 200, 5)).toHaveLength(1)
    setPropCleared(cols, 0, true)
    expect(propsNearSegment(cols, 100, 10, 0, 100, 10, 200, 5)).toEqual([])
  })
})

// ── 2. the adapter: level frame to SIM, once ──────────────────────────────

describe('desk/prop-colliders.ts: the colliders in the level frame', () => {
  it('finds a prop where it stands, not where its mirror would', () => {
    // SIM (100, 200): the level frame has it at (100, −200).
    const cols = buildPropColliders([tree(100, 200)], { x: 0, y: 0, z: 0 }, SPEC)
    const props = collidersAsProps(cols)
    const here = props.near([100, 10, -150], [100, 10, -250], 5)
    expect(here).toHaveLength(1)
    const at = here[0]?.at as Vec3Tuple
    expect(at[0]).toBeCloseTo(100, 6)
    expect(at[2]).toBeCloseTo(-200, 6)
    expect(props.near([100, 10, 150], [100, 10, 250], 5)).toEqual([])
  })
})

// ── 3. the warnings ───────────────────────────────────────────────────────

/** Props that stand at level-frame points, found by plan distance to the segment. */
const standing = (at: readonly Vec3Tuple[], reaches: number[] = [], kind = 'spire'): Props => ({
  near(a, b, reach) {
    reaches.push(reach)
    const out: PropContact[] = []
    at.forEach((p, id) => {
      const ex = b[0] - a[0]
      const ez = b[2] - a[2]
      const len2 = ex * ex + ez * ez
      const u =
        len2 > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * ex + (p[2] - a[2]) * ez) / len2)) : 0
      const d = Math.hypot(p[0] - (a[0] + u * ex), p[2] - (a[2] + u * ez))
      if (d < reach) out.push({ id, kind, at: [...p] as Vec3Tuple, depth: reach - d })
    })
    return out
  },
})

describe('evaluateDraft with an injected Props', () => {
  const level = expandPlayerCourse(COURSE, int01)
  const spline = playerCourseSpline(COURSE)
  const mid = splinePointAt(spline, 0.4 * spline.length)
  const P: Vec3Tuple = [mid.x, mid.y, mid.z]

  it('reach is the ship’s collision radius plus the clearance, derived', () => {
    const widest = Math.max(
      ...HOVERJET_GROUND.collision.hull.map((h) => Math.hypot(h.x, h.y, h.z) + h.radius),
    )
    expect(shipCollisionRadius()).toBe(widest)
    expect(propReach()).toBe(widest + groundClearance())
    expect(propReach()).toBeGreaterThan(groundClearance())
  })

  it('no Props, no prop warnings — and none from a forest nowhere near', () => {
    const kinds = (p?: Props | null) =>
      evaluateDraft(DRAFT, int01, ABYSS, [], p ?? null)
        .warnings.map((w) => w.kind)
        .filter((k) => k === 'line-through-prop' || k === 'ring-in-prop')
    expect(kinds()).toEqual([])
    expect(kinds(standing([[1e6, 0, 1e6]]))).toEqual([])
  })

  it('a prop on the line: one warning, its stretch round the prop, a marker on the prop', () => {
    const reaches: number[] = []
    const e = evaluateDraft(DRAFT, int01, ABYSS, [], standing([P], reaches))
    const line = e.warnings.filter((w) => w.kind === 'line-through-prop' && w.span)
    expect(line).toHaveLength(1)
    const w = line[0] as (typeof line)[number]
    expect(w.severity).toBe('warning')
    expect(w.span?.[0]).toBeLessThanOrEqual(0.4)
    expect(w.span?.[1]).toBeGreaterThanOrEqual(0.4)
    // A short stretch: the prop's reach either side, not the whole line.
    expect((w.span?.[1] ?? 1) - (w.span?.[0] ?? 0)).toBeLessThan(0.05)
    expect(w.props).toEqual([P])
    expect(w.metres).toBeGreaterThan(0)
    expect(w.message).toMatch(/spire/)
    // The line was judged at the line's reach.
    expect(reaches).toContain(propReach())
  })

  it('a prop in a ring’s opening is an ERROR on that ring, judged at the clearance', () => {
    const ring = liveRings(level)[2] as ReturnType<typeof liveRings>[number]
    const c = ring.trigger.pos as Vec3Tuple
    const reaches: number[] = []
    const e = evaluateDraft(DRAFT, int01, ABYSS, [], standing([c], reaches))
    const inRing = e.warnings.filter((w) => w.kind === 'ring-in-prop')
    expect(inRing).toHaveLength(1)
    expect(inRing[0]?.severity).toBe('error')
    expect(inRing[0]?.ring).toBe(2)
    expect(inRing[0]?.props).toEqual([c])
    expect(reaches).toContain(groundClearance())
    // Errors sort first.
    expect(e.warnings[0]?.severity).toBe('error')
  })

  it('a prop on the RUN-IN is reported on the run-in, by its fractions', () => {
    const r = runInOf(COURSE, int01)
    if (!r) throw new Error('the fitted course has a run-in')
    const on: Vec3Tuple = [
      (r.from.x + r.to.x) / 2,
      (r.from.y + r.to.y) / 2,
      (r.from.z + r.to.z) / 2,
    ]
    const e = evaluateDraft(DRAFT, int01, ABYSS, [], standing([on]))
    const w = e.warnings.find((x) => x.kind === 'line-through-prop' && x.runIn)
    expect(w).toBeDefined()
    expect(w?.span).toBeUndefined()
    expect(w?.runIn?.[0]).toBeLessThanOrEqual(0.5)
    expect(w?.runIn?.[1]).toBeGreaterThanOrEqual(0.5)
  })

  it('two props on one stretch: one warning with two markers', () => {
    const s2 = splinePointAt(spline, 0.4 * spline.length + 8)
    const Q: Vec3Tuple = [s2.x, s2.y, s2.z]
    const e = evaluateDraft(DRAFT, int01, ABYSS, [], standing([P, Q]))
    const line = e.warnings.filter((w) => w.kind === 'line-through-prop' && w.span)
    expect(line).toHaveLength(1)
    expect(line[0]?.props).toHaveLength(2)
    expect(line[0]?.message).toMatch(/2 props/)
  })

  it('a Props that throws costs the warnings nothing else', () => {
    const bad: Props = {
      near() {
        throw new Error('no world')
      },
    }
    const e = evaluateDraft(DRAFT, int01, ABYSS, [], bad)
    expect(e.level).not.toBeNull()
    expect(e.warnings.some((w) => w.kind === 'line-through-prop')).toBe(false)
  })
})

describe('the desk draws them where they are (ground-marks)', () => {
  it('a ring a prop reaches into gets its rim; a stretch near a prop, its samples', () => {
    const level = expandPlayerCourse(COURSE, int01)
    const spline = playerCourseSpline(COURSE)
    const ring = liveRings(level)[2] as ReturnType<typeof liveRings>[number]
    const mid = splinePointAt(spline, 0.4 * spline.length)
    const e = evaluateDraft(
      DRAFT,
      int01,
      ABYSS,
      [],
      standing([[...ring.trigger.pos] as Vec3Tuple, [mid.x, mid.y, mid.z]]),
    )
    const marks = groundMarks(e.warnings, e.level, spline)
    // Their own lists: nothing is in the ground.
    expect(marks.rings).toEqual([])
    expect(marks.under).toEqual([])
    expect(marks.propRings.map((r) => r.ring)).toEqual([2])
    expect(marks.propLine.length).toBeGreaterThan(0)
    // The drawn stretch passes the prop it is about.
    const near = marks.propLine.some((run) =>
      run.some((p) => Math.hypot(p[0] - mid.x, p[2] - mid.z) < propReach()),
    )
    expect(near).toBe(true)
  })
})
