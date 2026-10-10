// tests/unit/override-rules-shared.test.ts: the override format's rules have
// ONE implementation. DEV-740 (code-reuse audit BE-11).
//
// The editor WRITES what `validateOverride` READS, and the shipped desk held
// its own copies of two of the validator's rules: the route's spacing (on RAW
// points, where the validator reads QUANTISED ones) and the pose's rotation
// (a zero quaternion became [0,0,0,0], which the file's reader then refuses).
// Held here, on the case where the two readings DISAGREE and not on one where
// they agree (the agreement lesson, docs/DEVIATIONS.md):
//
//  1. THE ROUTE. Two points 5.0004 m apart as asked and 4.85 m apart on the
//     format's 10 cm grid: a raw reading passes the line, the file's reader
//     refuses it. `routeIssues` is the reader's own reading, and the issue it
//     reports is the one `validateOverride` reports.
//  2. THE POSE. `canonicalPose` is the file's pose: `null` where the file
//     would refuse one (all-zero rotation, a coordinate out of bounds), and
//     where it does not, byte-equal to what `validateOverride` reads back.
//  3. THE EDITOR refuses a move to a pose the file would refuse, rather than
//     putting it in a draft that cannot be saved.

import { describe, expect, it } from 'vitest'
import {
  canonicalPose,
  OVERRIDE_VERSION,
  ringKey,
  routeIssues,
  validateOverride,
} from '@/content/level-override'
import { liveRings, type Ring, type Vec3Tuple } from '@/content/level-schema'
import { loadBaselineLevel } from '@/content/load-level'
import { PLAYER_COURSE_LIMITS } from '@/content/player-course'
import { moveEntity, openShipped } from '@/editor/core'

const BASE = 'a'.repeat(64)
const file = (extra: Record<string, unknown>) => ({
  v: OVERRIDE_VERSION,
  mission: 'int_01_hoverJet',
  base: BASE,
  ...extra,
})

/** Raw gap 5.0004 m, on the 10 cm grid 4.85 m: the two readings disagree here. */
const A: Vec3Tuple = [0.06, 0.06, 0.06]
const B: Vec3Tuple = [2.947, 2.947, 2.947]
const rawGap = Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2])

describe('the route rule is the file reader own (DEV-740)', () => {
  it('the case disagrees by construction: the raw gap passes, the gridded gap does not', () => {
    expect(rawGap).toBeGreaterThanOrEqual(PLAYER_COURSE_LIMITS.pointSpacingMetres.min)
    const q = (v: number): number => Math.round(v * 10) / 10
    const gridded = Math.hypot(q(B[0]) - q(A[0]), q(B[1]) - q(A[1]), q(B[2]) - q(A[2]))
    expect(gridded).toBeLessThan(PLAYER_COURSE_LIMITS.pointSpacingMetres.min)
  })

  it('refuses that line, with the issue validateOverride gives for it', () => {
    const issues = routeIssues([A, B])
    expect(issues.map((i) => i[0])).toEqual(['route.points[1]'])
    const r = validateOverride(file({ route: { points: [A, B] } }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.map((e) => e[0])).toEqual(['route.points[1]'])
  })

  it('accepts a line the file accepts, and reports count and bounds as the file does', () => {
    const ok: Vec3Tuple[] = [
      [0, 0, 0],
      [10, 0, 0],
    ]
    expect(routeIssues(ok)).toEqual([])
    expect(validateOverride(file({ route: { points: ok } })).ok).toBe(true)
    expect(routeIssues([[0, 0, 0]]).map((i) => i[0])).toEqual(['route.points'])
    const far = PLAYER_COURSE_LIMITS.coordinateMetres + 1
    expect(
      routeIssues([
        [0, 0, 0],
        [far, 0, 0],
      ]).length,
    ).toBeGreaterThan(0)
  })
})

describe('the pose rule is the file reader own (DEV-740)', () => {
  const pose = (pos: number[], quat: number[]) => {
    const r = validateOverride(file({ finish: { pos, quat } }))
    return r.ok ? (r.override.finish ?? null) : null
  }

  it('is null for a rotation the file refuses and a position out of bounds', () => {
    expect(canonicalPose([1, 2, 3], [0, 0, 0, 0])).toBeNull()
    expect(
      canonicalPose([PLAYER_COURSE_LIMITS.coordinateMetres + 1, 0, 0], [0, 0, 0, 1]),
    ).toBeNull()
    expect(canonicalPose([1, Number.NaN, 3], [0, 0, 0, 1])).toBeNull()
    expect(pose([1, 2, 3], [0, 0, 0, 0])).toBeNull()
  })

  it('is what the file reads back, for a pose it accepts (sign flipped, off-grid, unnormalised)', () => {
    for (const [p, q] of [
      [
        [12.34567, -8.76543, 100.04999],
        [0.1, -0.2, 0.3, -0.9],
      ],
      [
        [0, 0, 0],
        [0, 0, 0, 2],
      ],
    ] as const) {
      const c = canonicalPose(p, q)
      expect(c).not.toBeNull()
      expect(pose([...p], [...q])).toEqual(c)
    }
  })
})

describe('the shipped desk refuses what the file would (DEV-740)', () => {
  it('a move to an all-zero rotation leaves the draft as it was', async () => {
    const base = await loadBaselineLevel('int_01_hoverJet')
    const draft = openShipped(base, BASE, null, null).draft
    const ring = liveRings(base)[0] as Ring
    const key = ringKey(ring)
    expect(key).not.toBeNull()
    const e = { kind: 'ring', key: key as string } as const
    expect(moveEntity(draft, e, ring.pos, [0, 0, 0, 0])).toBe(draft)
  })
})
