// tests/unit/tv-vantage.test.ts: DEV-481: no headset vantage is inside the world.
//
// plan/FF-TV.md §5.3 / §9 DEV-481's gate: *"a unit sweep that no vantage is
// inside terrain on EVERY HoverJet Ring Attack course (not one: CLAUDE.md's
// spot-check rule)."* So every vantage of all six courses, against:
//
//   * the RENDERED surface and the COLLISION surface, each on its own, sampled
//     densely round the eye (a disk, not a point: an eye beside a slope is
//     inside the hill a few metres away, and the gap between the two surfaces
//     is facetisation, worst on steep ground, which a flat sample cannot see:
//     CLAUDE.md's heightField trap, DEV-288);
//   * Anniversary's forest and landmarks, the colliders the game builds.
//
// The check is DENSER and closer-in than the builder's own (`tv-vantage.ts`
// tests 25 points over 14 m and wants 8 m of air; this tests 121 points over
// 10 m and wants `TEST_AIR`), so it is not the builder's arithmetic written
// twice (trap 24): it would catch a builder whose disk stepped over a spike.
//
// Gated on the gitignored maps and GLBs (`haveForest`), with a loud
// counterpart, and every disk read inside an `it`.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { type Level, validateLevel } from '@/content/level-schema'
import {
  buildRoute,
  buildVantages,
  projectOnRoute,
  routePointAt,
  tvBoundsOf,
  tvCourseOf,
  VANTAGE_POLICY,
  type Vantage,
} from '@/game/tv/tv-vantage'
import { haveForest } from './helpers/prop-forest'
import { tvWorldFor } from './helpers/tv-world'

/** The air the sweep demands under every eye, over its own dense disk, metres. */
const TEST_AIR = 4
/** The disk the sweep samples: radii and points per ring. */
const TEST_RADII = [0, 2, 4, 6, 8, 10] as const
const TEST_POINTS = 24
/** The head the sweep asks the props about, metres. */
const TEST_HEAD = 2

const LEVEL_DIR = path.join(__dirname, '..', '..', 'content', 'levels')
/** Every HoverJet Ring Attack course that ships, read off disk, not listed by hand. */
const ringAttackCourses = (): Level[] =>
  fs
    .readdirSync(LEVEL_DIR)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .sort()
    .map((f) =>
      validateLevel(JSON.parse(fs.readFileSync(path.join(LEVEL_DIR, f), 'utf8')) as Level),
    )
    .filter((l) => l.vehicle === 'hoverjet' && l.mode === 'ringAttack')

describe('DEV-481: the vantage builder, without the world', () => {
  it('pins the policy that the sweep below measures', () => {
    expect(VANTAGE_POLICY.clearance).toBe(8)
    expect(VANTAGE_POLICY.diskRadius).toBe(14)
    expect(VANTAGE_POLICY.liftMargin).toBe(60)
  })

  it('stands beside the ring on flat ground, off the line, facing up the course', () => {
    // A straight course down −Z at y = 100 over flat ground at 0.
    const route = Array.from({ length: 101 }, (_, i) => [0, 100, -i * 20] as const)
    const v = buildVantages(
      { route, gates: [[0, 100, -1000]], start: null, finish: null },
      { heightAt: () => 0 },
    )
    expect(v).toHaveLength(1)
    const only = v[0] as Vantage
    expect(only.lifted).toBe(false)
    // Off the line sideways, and downstream of the ring (z below −1000).
    expect(Math.abs(only.eye[0])).toBeGreaterThanOrEqual(40)
    expect(only.eye[2]).toBeLessThanOrEqual(-1000)
    // Facing back UP the course: towards +Z, which is yaw ±π in three's convention.
    expect(Math.abs(Math.abs(only.yaw) - Math.PI)).toBeLessThan(0.5)
  })

  it('goes above everything when no trackside eye clears the ground', () => {
    // A wall 300 m high everywhere except a slot the route flies down.
    const route = Array.from({ length: 101 }, (_, i) => [0, 100, -i * 20] as const)
    const heightAt = (x: number): number => (Math.abs(x) < 10 ? 0 : 300)
    const [only] = buildVantages(
      { route, gates: [[0, 100, -1000]], start: null, finish: null },
      { heightAt },
    )
    expect(only?.lifted).toBe(true)
    expect(only?.eye[1]).toBeGreaterThanOrEqual(300 + VANTAGE_POLICY.liftMargin)
  })

  it('steps round a prop the first candidate would stand in', () => {
    // The real courses' 8 m of air over a 14 m disk clears every tree and spire
    // the sweep below found, so THIS is where the prop rule is shown to work:
    // a spire on the route's right, exactly where the first candidate stands.
    const route = Array.from({ length: 101 }, (_, i) => [0, 100, -i * 20] as const)
    const course = { route, gates: [[0, 100, -1000] as const], start: null, finish: null }
    const [free] = buildVantages(course, { heightAt: () => 0 })
    const first = free?.eye as readonly [number, number, number]
    const obstructed = (x: number, _y: number, z: number, r: number): boolean =>
      Math.hypot(x - first[0], z - first[2]) < 10 + r
    const [moved] = buildVantages(course, { heightAt: () => 0, obstructed })
    expect(moved?.lifted).toBe(false)
    expect(
      Math.hypot((moved?.eye[0] ?? 0) - first[0], (moved?.eye[2] ?? 0) - first[2]),
    ).toBeGreaterThan(14)
  })

  it('projects onto the route by arc, and reads it back', () => {
    const r = buildRoute([
      [0, 0, 0],
      [100, 0, 0],
      [100, 0, -100],
    ])
    expect(r.length).toBeCloseTo(200, 6)
    expect(projectOnRoute(r, 100, 5, -50).arc).toBeCloseTo(150, 6)
    expect(routePointAt(r, 150)).toEqual([100, 0, -50])
  })
})

describe.skipIf(!haveForest)('DEV-481: every vantage of every HoverJet Ring Attack course', () => {
  it('is clear of the rendered ground, the collision ground and every prop', () => {
    const courses = ringAttackCourses()
    // The premise: six courses, not one (CLAUDE.md: a spot check is a smoke test).
    expect(courses.map((l) => l.id).sort()).toEqual([
      'adv_01_hoverJet',
      'adv_02_hoverJet',
      'int_01_hoverJet',
      'int_02_hoverJet',
      'rookie_01_hoverJet',
      'rookie_02_hoverJet',
    ])
    const rows: string[] = []
    const failures: string[] = []
    for (const level of courses) {
      const world = tvWorldFor(level)
      const course = tvCourseOf(level)
      const t0 = performance.now()
      const vantages = buildVantages(course, {
        heightAt: world.heightAt,
        obstructed: world.obstructed,
        bounds: tvBoundsOf(level),
      })
      const ms = performance.now() - t0
      // Coverage: a vantage per ring, less the ones too close to the last to be a second shot.
      expect(vantages.length, `${level.id}: vantages`).toBeGreaterThanOrEqual(
        Math.ceil(course.gates.length / 2),
      )
      let worstRender = Number.POSITIVE_INFINITY
      let worstCollision = Number.POSITIVE_INFINITY
      for (const v of vantages) {
        const [x, y, z] = v.eye
        for (const r of TEST_RADII) {
          const n = r === 0 ? 1 : TEST_POINTS
          for (let k = 0; k < n; k++) {
            const a = (k / n) * Math.PI * 2
            const sx = x + Math.cos(a) * r
            const sz = z + Math.sin(a) * r
            const render = y - world.renderAt(sx, sz)
            const collision = y - world.collisionAt(sx, sz)
            if (render < worstRender) worstRender = render
            if (collision < worstCollision) worstCollision = collision
            if (render < TEST_AIR || collision < TEST_AIR) {
              failures.push(
                `${level.id} vantage@${v.anchor} (${x.toFixed(0)}, ${y.toFixed(0)}, ${z.toFixed(0)}): ` +
                  `${render.toFixed(1)} m over the render, ${collision.toFixed(1)} m over the collider, ${r} m out`,
              )
            }
          }
        }
        const depth = world.propDepth(x, y, z, TEST_HEAD)
        if (depth > 0)
          failures.push(`${level.id} vantage@${v.anchor}: ${depth.toFixed(1)} m into a prop`)
      }
      rows.push(
        `${level.id.padEnd(20)} ${level.environment.padEnd(8)} ${String(course.gates.length).padStart(3)} rings → ` +
          `${String(vantages.length).padStart(3)} vantages (${vantages.filter((v) => v.lifted).length} above everything) · ` +
          `least air: ${worstRender.toFixed(1)} m render, ${worstCollision.toFixed(1)} m collider · built in ${ms.toFixed(0)} ms`,
      )
    }
    console.info(`DEV-481 vantage sweep:\n${rows.join('\n')}`)
    expect(failures.slice(0, 20)).toEqual([])
  }, 300_000)
})

describe.skipIf(haveForest)('DEV-481: the vantage sweep is skipped here (loud counterpart)', () => {
  it('skips only because the gitignored height maps and prop GLBs are absent', () => {
    expect(haveForest).toBe(false)
  })
})
