// tests/unit/crash-reset-clearance.test.ts — is the crash reset inside a tree?
//
// DEV-185. `route-clearance.test.ts` is this file's parent and it asks the same
// question about the other surface: *is the course above the ground?* It
// certifies every mission's authored line against its own height map — and
// against nothing else, because when it was written nothing else was solid.
//
// DEV-136 made the props solid, DEV-147 gave them to the racers, and then the
// line ran through a thing it was never certified against. `int_01`'s min AGL
// is 31.4 m and a Simonet palm is 43.6 m tall, and those two facts do not
// contradict each other — they are about different surfaces, and only one of
// them had a test.
//
// ── What this file walks ──────────────────────────────────────────────────
//
// Every shipped mission, the crash line the game would actually use for it
// (the authored `route` where there is one, the gate polyline where there is not),
// at 1 m of arc, against the REAL Anniversary forest: the baked scatter out of
// `content/environments/*.json`, `props.scale`, the ground snap and the
// landmarks, with collider radii off the drawn glTF bounds. See
// `helpers/prop-forest.ts` for why every one of those four changes the answer.
//
// Two columns, and the difference between them is the whole row:
//
//   LINE   metres of arc where the LINE itself is inside a standing capsule.
//          A fact about the content, true of anyone who flies the guide —
//          the player on the reticle, the racers, and the autopilot.
//   RESET  metres of arc where the crash RESET lands inside one. A fact about
//          `planCrashReset`, and the thing DEV-185 fixes.
//
// ── The gate ──────────────────────────────────────────────────────────────
//
// The assertion is the A/B, not the absolute: for every mission, the reset with
// `resetClearStepMetres` at the preset's value is inside a prop for no more arc
// than it is with the rule off. That is true on a host with no forest at all,
// it is true of a mission with no props on its line, and it is FALSE for the
// bug. The absolute numbers are printed, because a number that only ever goes
// down is a number nobody reads.
//
// Gitignored assets, so it skips on CI, and it carries the loud counterpart
// `orb-floor.test.ts` established: a `skipIf(haveForest)` that asserts the
// guard is false, so the file cannot rot green for months.

import { describe, expect, it } from 'vitest'
import { type CrashSpec, createCrash, planCrashReset } from '@/sim/crash'
import { v3 } from '@/sim/math/vec3'
import {
  type PropColliders,
  type PropCollisionSpec,
  propPenetrationAt,
} from '@/sim/props/collision'
import { createRigidBody } from '@/sim/rigidbody'
import { createRoute, type Route, routeAt } from '@/sim/route'
import { HOVERJET_GROUND } from '@/sim/terrain-collision'
import anniversary from '../../content/editions/anniversary.json'
import { shippedCrashLine } from './helpers/crash-line'
import { forestFor, forestShape, haveForest } from './helpers/prop-forest'
import { fieldFor, loadLevelJson, MISSIONS } from './helpers/terrain-field'

const EDITION = anniversary as unknown as {
  gameplay: { propCollision: PropCollisionSpec; crash: CrashSpec }
  props: {
    scale: Record<string, unknown>
    unbakedPasses: { enabled: boolean }
    groundSnap: { enabled: boolean; sink: number }
    maxSlope: { enabled: boolean; sin: number }
  }
}
const CRASH = EDITION.gameplay.crash
/** The rule switched OFF: what shipped before DEV-185, for the A/B. */
const NO_WALK: CrashSpec = { ...CRASH, resetClearStepMetres: 0 }
const HULL = HOVERJET_GROUND.collision.hull

/** Anniversary's forest, because Anniversary is the only edition that crashes. */
const FOREST_OPTIONS = {
  spec: EDITION.gameplay.propCollision,
  scale: EDITION.props.scale,
  unbakedPasses: EDITION.props.unbakedPasses.enabled,
  groundSnapSink: EDITION.props.groundSnap.enabled ? EDITION.props.groundSnap.sink : null,
  maxSlope: EDITION.props.maxSlope.enabled ? EDITION.props.maxSlope.sin : null,
  landmarks: true,
}
/**
 * Walk one mission's crash line and report how much of it is inside a prop —
 * for the LINE itself, and for the reset a crash on it would plan.
 *
 * The crash is placed `resetBackMetres` FURTHER along than the arc under test,
 * so the reset it plans is the one at that arc: the sweep is over reset points,
 * not over crash points, which is what the column means.
 */
const walk = (
  route: Route,
  spec: CrashSpec,
  props: PropColliders,
  // biome-ignore lint/suspicious/noExplicitAny: the level JSON arrives untyped
  fields: any[],
): { lineMetres: number; resetMetres: number; worst: number; worstS: number; worstId: number } => {
  const state = createCrash()
  const body = createRigidBody()
  const at = v3()
  const forest = { colliders: props, hull: HULL }
  let lineMetres = 0
  let resetMetres = 0
  let worst = 0
  let worstS = -1
  let worstId = -1
  for (let s = 0; s <= route.length; s += 1) {
    routeAt(route, s, at)
    // The RAW LINE — no back-off and no lift, so this column is a fact about
    // the content and not about the crash rule. Level and along the tangent is
    // the pose a ship following the line holds, so the planner's own
    // orientation is the right one to ask with; `clearanceMetres` 0 is what
    // keeps the lift out of it.
    body.position.x = at.x
    body.position.y = at.y
    body.position.z = at.z
    planCrashReset(
      state,
      { ...spec, resetBackMetres: 0, clearanceMetres: 0, resetClearStepMetres: 0 },
      body,
      { route, limitS: route.length },
      fields,
      null,
    )
    if (propPenetrationAt(state.reset.position, state.reset.orientation, HULL, props) > 0) {
      lineMetres++
    }

    // The RESET that a crash at `s + resetBackMetres` would plan.
    routeAt(route, Math.min(route.length, s + spec.resetBackMetres), at)
    body.position.x = at.x
    body.position.y = at.y
    body.position.z = at.z
    planCrashReset(state, spec, body, { route, limitS: route.length }, fields, forest)
    const deep = propPenetrationAt(state.reset.position, state.reset.orientation, HULL, props)
    if (deep > 0) {
      resetMetres++
      if (deep > worst) {
        worst = deep
        worstS = state.reset.s
        // Which one it is, for the print. Cheap: only on a new worst.
        worstId = -1
        for (let i = 0; i < props.count; i++) {
          if (props.broken[i]) continue
          const dx = state.reset.position.x - (props.x[i] as number)
          const dz = state.reset.position.z - (props.z[i] as number)
          if (Math.hypot(dx, dz) < (props.radius[i] as number) + 2) {
            worstId = i
            break
          }
        }
      }
    }
  }
  return { lineMetres, resetMetres, worst, worstS, worstId }
}

describe.skipIf(!haveForest)('DEV-185: every mission’s crash reset against its own forest', () => {
  it('walks all thirteen and lands the reset out of the trees wherever it can', () => {
    const rows: string[] = []
    let improved = 0
    let stillInside = 0
    for (const id of MISSIONS) {
      const level = loadLevelJson(id)
      const field = fieldFor(level)
      const props = forestFor(level.environment, field, FOREST_OPTIONS)
      const shape = forestShape(props)
      const { route, kind } = shippedCrashLine(level)

      const before = walk(route, NO_WALK, props, [field])
      const after = walk(route, CRASH, props, [field])

      rows.push(
        `${id.padEnd(20)} ${String(level.environment).padEnd(8)} ${kind.padEnd(10)} ` +
          `props ${String(shape.count).padStart(6)} (r<=${shape.maxRadius.toFixed(1)} m, h<=${shape.maxHeight.toFixed(1)} m) | ` +
          `LINE inside ${String(before.lineMetres).padStart(4)} m | ` +
          `RESET inside ${String(before.resetMetres).padStart(4)} m -> ${String(after.resetMetres).padStart(4)} m` +
          (after.resetMetres > 0
            ? `  (worst ${after.worst.toFixed(1)} m into #${after.worstId} ${after.worstId >= 0 ? props.kind[after.worstId] : '?'} at s=${after.worstS.toFixed(0)})`
            : ''),
      )

      // THE GATE. Not "the reset is clear" — on a course whose line runs 300 m
      // through a collider there is no clear arc inside the budget, and
      // asserting there is would be asserting the content is different from
      // what it is. What the RULE promises is that it never makes it worse and
      // takes every metre it can, and that is false for the bug.
      expect(
        after.resetMetres,
        `${id}: the walk left MORE of the line resetting inside a prop`,
      ).toBeLessThanOrEqual(before.resetMetres)
      if (after.resetMetres < before.resetMetres) improved++
      if (after.resetMetres > 0) stillInside++
    }
    console.log(`DEV-185 crash reset vs the real forest:\n  ${rows.join('\n  ')}`)
    console.log(
      `DEV-185: ${improved} mission(s) improved; ${stillInside} still have arc with no clear reset inside the ${CRASH.resetBackMetres} m budget.`,
    )
    // And at least one mission has to move, or the sweep proved nothing about
    // the rule — the bug is `int_01`'s palm and it is in this list.
    expect(improved, 'no mission improved: the A/B has no A').toBeGreaterThan(0)
  }, 600_000)

  it('int_01_hoverJet: palm #840 specifically, the one Matt’s racer bounced off', () => {
    // The reported case, named. DEV-180 found the reset inside this palm while
    // chasing a racer that could not break it; this is the same collider, from
    // the other end.
    const level = loadLevelJson('int_01_hoverJet')
    const field = fieldFor(level)
    const props = forestFor('simonet', field, FOREST_OPTIONS)
    const route = createRoute(level.route as number[][])
    const state = createCrash()
    const body = createRigidBody()
    const at = v3()
    // The crash that plans a reset at s = 3162, the deepest point of the window.
    routeAt(route, 3162 + CRASH.resetBackMetres, at)
    body.position.x = at.x
    body.position.y = at.y
    body.position.z = at.z

    planCrashReset(state, NO_WALK, body, { route, limitS: route.length }, [field], null)
    expect(state.reset.s).toBeCloseTo(3162, 0)
    const before = propPenetrationAt(state.reset.position, state.reset.orientation, HULL, props)
    expect(before, 'the reported bug: the reset is inside a palm').toBeGreaterThan(0)

    planCrashReset(state, CRASH, body, { route, limitS: route.length }, [field], {
      colliders: props,
      hull: HULL,
    })
    const after = propPenetrationAt(state.reset.position, state.reset.orientation, HULL, props)
    // And how much AIR it has, because "clear" at 1 cm is one float from not
    // being. `propPenetrationAt` answers the boolean; this is the margin.
    let margin = Number.POSITIVE_INFINITY
    let nearest = -1
    for (let i = 0; i < props.count; i++) {
      const y = state.reset.position.y
      if (y < (props.bottom[i] as number) || y > (props.top[i] as number)) continue
      const dx = state.reset.position.x - (props.x[i] as number)
      const dz = state.reset.position.z - (props.z[i] as number)
      const gap = Math.hypot(dx, dz) - (props.radius[i] as number)
      if (gap < margin) {
        margin = gap
        nearest = i
      }
    }
    console.log(
      `DEV-185 int_01: reset was ${before.toFixed(2)} m inside a palm at s=3162; ` +
        `now ${after > 0 ? `${after.toFixed(2)} m inside` : 'clear'} at s=${state.reset.s.toFixed(0)} ` +
        `(${(3162 - state.reset.s).toFixed(0)} m further back, out of a ${CRASH.resetBackMetres} m budget); ` +
        `nearest standing collider #${nearest} ${nearest >= 0 ? props.kind[nearest] : '?'} is ${margin.toFixed(1)} m away`,
    )
    expect(after).toBe(0)
    // Not marginally clear: the reset has metres of air, not centimetres. The
    // step size is what buys this — a 1 m search would stop at the first
    // candidate outside the capsule, which is the capsule's own surface.
    expect(margin).toBeGreaterThan(1)
    // Back, not forward, and inside the budget.
    expect(state.reset.s).toBeLessThan(3162)
    expect(3162 - state.reset.s).toBeLessThanOrEqual(CRASH.resetBackMetres)
  })
})

// ── the loud counterpart ──────────────────────────────────────────────────
//
// `orb-floor.test.ts`'s rule: a guarded suite needs a test that fails when the
// guard is false, or it rots green. This one runs only where the assets ARE
// absent and says so.

describe.skipIf(haveForest)('DEV-185: the forest sweep is skipped here', () => {
  it('says so, and says why, rather than reporting a pass', () => {
    expect(haveForest).toBe(false)
    console.log(
      'DEV-185: `crash-reset-clearance` skipped — the height maps and prop GLBs are ' +
        'gitignored and come from R2. `pnpm assets:pull` hydrates them. The MECHANISM ' +
        'is covered unconditionally by `crash.test.ts`; what is skipped here is the ' +
        'certification of the shipped CONTENT.',
    )
  })
})
