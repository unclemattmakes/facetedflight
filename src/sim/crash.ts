// src/sim/crash.ts — hit the ground too hard and you are put back on the course.
//
// Matt, 2026-09-16: *"we should have player ships crash if they collide too
// hard - they get reset near their crash spot, but back on the course (like an
// arcade game)."* DEV-126. Anniversary only: `gameplay.crash` in the preset.
//
// ── What 2016 did, so this is a deviation and not a port ──────────────────
//
// `Ship_HoverShip.OnCollisionEnter` (Scripts/Ship_HoverShip.cs:365) runs
// `Flash()`: angular drag x3 for 0.3 s, `explode2`, gas and boost released,
// and nothing else. `endOnCollide` is a public field and it is **0** on the
// shipped `PlayerShip_SR14_Photon.prefab`, so the finale is never started by a
// hit; there is no crash, no reset and no death from the ground anywhere in
// the shipped game. The port's zero-bounciness contact (`terrain-collision.ts`,
// DEV-020) IS that behaviour, and it stays as the below-threshold case here —
// a graze bounces exactly as it did.
//
// ── The rule ──────────────────────────────────────────────────────────────
//
// The contact already computes the one number a crash needs: the component of
// velocity INTO the surface that the zero-restitution response removes
// (`TerrainCollisionState.impactSpeed`). At or above `minImpactSpeed` the ship
// is `crashed`: it is held where it hit for `holdSeconds` — the caller freezes
// the flight model and drops the curtain — and then placed on the course line
// `resetBackMetres` of arc length behind the crash, facing along it, at
// `resetSpeed`, lifted to `clearanceMetres` over the collision surface if the
// line is lower than that. The course line is the authored `route` when the
// level has one and the polyline through the gate centres when it does not.
//
// ── The one interaction that has to be got right ──────────────────────────
//
// The boundary (`boundary.ts`) also resets the ship, on a 13 s clock, and the
// two must never both fire on one tick or one hold. `stepCrashAndBoundary`
// is the whole of that rule, in one place, so it can be tested in node:
//
//   * a ship already `dying` cannot crash — it is being reset anyway;
//   * a `crashed` ship freezes the boundary clock along with everything else,
//     so a hold can never end in a boundary death;
//   * a tick on which the boundary restarted the run does not also detect a
//     crash — the ship is about to be somewhere else.
//
// DEV-074's lesson applies too: the crash reset lands INSIDE the sphere, so
// the boundary sees an `OnTriggerEnter` on the next tick and any running
// countdown cancels — which is what 2016's reload-to-the-respawn-marker does.
//
// ── What feeds it ─────────────────────────────────────────────────────────
//
// `impactSpeed` is a NUMBER, not a terrain event. The props branch will emit a
// `propHit { speed }` later; the caller takes the max of the two and hands it
// in, and nothing here changes. A crash is a crash whatever you hit.
//
// The props reach this file the OTHER way round as well, and that is DEV-185:
// `planCrashReset` takes the colliders so the reset can miss them. It used to
// lift over the terrain and know nothing else, and 10 m of `int_01`'s authored
// arc put the ship inside palm #840. See `planCrashReset`.
//
// SIM LAYER: no three, no DOM, no wall clock, no allocation in the hot path.

import { type BoundarySpec, type BoundaryState, stepBoundary } from './boundary'
import type { Gate } from './course'
import { type Quat, quat } from './math/quat'
import { type Vec3, v3 } from './math/vec3'
import { type PropColliders, propPenetrationAt } from './props/collision'
import type { RigidBody } from './rigidbody'
import {
  createRoute,
  gateArcLengths,
  type Route,
  routeArcLengthNearWithin,
  routeAt,
  routeTangentAt,
} from './route'
import { type HeightField, highestGroundUnder } from './terrain/height-field'
import type { HullSphere } from './terrain-collision'

/** `gameplay.crash` in the preset. See `content/editions/_schema.json` for each. */
export interface CrashSpec {
  readonly enabled: boolean
  readonly minImpactSpeed: number
  readonly resetBackMetres: number
  readonly clearanceMetres: number
  readonly resetSpeed: number
  readonly holdSeconds: number
  /**
   * Metres of arc length per step while walking BACK along the line looking for
   * a reset that is not inside a tree. Zero is the rule switched off — the
   * behaviour that shipped before DEV-185. See `planCrashReset`.
   */
  readonly resetClearStepMetres: number
}

/** The course to be put back on: a line, and how far along it the run has got. */
export interface CrashCourse {
  readonly route: Route
  /**
   * Arc length the reset may not search PAST — how far along the line the run
   * has actually GOT, which is `crashLimitS`. See `routeArcLengthNearWithin`.
   */
  readonly limitS: number
}

/**
 * The forest a reset has to miss, and the hull that has to miss it. DEV-185.
 *
 * Null is a mission with no prop colliders — every Classic run, and any
 * Anniversary run on an environment whose props did not load — and then the
 * reset is planned exactly as it was before this existed.
 */
export interface CrashProps {
  readonly colliders: PropColliders
  readonly hull: readonly HullSphere[]
}

/**
 * How far along the line the run has got: the bound the reset search may not
 * look past.
 *
 * ── Why this is not just "the first gate you have not taken" (DEV-289) ─────
 *
 * It was, and a missed ring then pinned it for the rest of the run. Every
 * shipped HoverJet course puts `gateArc[0]` at **0.0** — the authored spline
 * starts at ring 1 — so missing ring 1 made this 0, and
 * `routeArcLengthNearWithin(route, anywhere, 0)` can only answer ~0. Measured
 * at 5 m steps along the whole line of all seven courses, a crash then threw
 * the ship back over as many as **43 gates** on `adv_01`, from any crash
 * position on the course. "Reset near their crash spot" (DEV-126) became
 * "reset at the start line".
 *
 * PROGRESS is the right measure and a hole behind you is not progress: the
 * bound is the gate you are flying TO, which is the one after the furthest you
 * have actually taken. `nextGate` is left alone — the ring you still OWE is
 * the right thing to aim the HUD arrow and the autopilot at, and it is a
 * different question from how far you have flown.
 *
 * Kept monotonic with a running max, which is not defensive dressing — though
 * the course that proves it is no longer the one this was written for.
 *
 * It said `adv_01`: 44 gates, the last 22 sitting 482-2,889 m off the authored
 * line with arcs running backwards. **DEV-195 deleted that premise the day
 * after this was written** — `adv_01` had TWO courses and the port drew both
 * concatenated. It is 22 gates now and they run forwards.
 *
 * Re-measured on landing, over all eight shipped courses that have rings:
 * every HoverJet one is monotonic, and **`rookie_02_jumpSeat` has 11 backwards
 * steps, the worst -360.4 m**. It is the one JumpSeat mission that authors a
 * ring course, and it is what the max now defends. Without it the bound would
 * collapse on that course — a smaller version of the same bug.
 *
 * `crash-reset-behind.test.ts` DERIVES that course rather than naming it,
 * because naming it is what broke the last version of this claim.
 */
export const crashLimitS = (
  gateArc: readonly number[],
  passed: readonly boolean[],
  routeLength: number,
): number => {
  let reached = -1
  for (let i = 0; i < gateArc.length; i++) if (passed[i]) reached = i
  // The gate being flown to, or the whole line once the last one is taken.
  let limit = reached + 1 < gateArc.length ? (gateArc[reached + 1] as number) : routeLength
  for (let i = 0; i <= reached; i++) limit = Math.max(limit, gateArc[i] as number)
  return Math.min(limit, routeLength)
}

export type CrashPhase = 'flying' | 'crashed'

export interface CrashReset {
  readonly position: Vec3
  /** Level, facing along the line. Body forward is +z in sim space. */
  readonly orientation: Quat
  readonly velocity: Vec3
  /** Where on the line the reset is. A follower's cursor is rewound to it. */
  s: number
}

export interface CrashState {
  phase: CrashPhase
  /** Seconds held where it hit. Meaningful while `crashed`. */
  heldFor: number
  /** The hit that caused the current or last crash, m/s into the surface. */
  impactSpeed: number
  /** Crashes this run. The results panel's and the HUD's number. */
  count: number
  /**
   * True for exactly the tick the reset was applied, so a caller that
   * interpolates poses can collapse its history instead of drawing a streak
   * from the wreck to the line.
   */
  justReset: boolean
  /** Where the ship goes back to. Planned on the crash tick, applied on the reset tick. */
  readonly reset: CrashReset
}

export const createCrash = (): CrashState => ({
  phase: 'flying',
  heldFor: 0,
  impactSpeed: 0,
  count: 0,
  justReset: false,
  reset: { position: v3(), orientation: quat(), velocity: v3(), s: 0 },
})

/** The one comparison. Exported so a caller can ask without stepping. */
export const isCrash = (spec: CrashSpec, impactSpeed: number): boolean =>
  spec.enabled && impactSpeed >= spec.minImpactSpeed

/** A crashed ship is frozen: no flight model, no boundary clock. */
export const crashHoldsShip = (state: CrashState): boolean => state.phase === 'crashed'

const _tangent = v3()

/**
 * One candidate: the whole reset pose at arc length `s`, and nothing else.
 *
 * At arc length `s` on the line — which MAY BE NEGATIVE, see below — on the line, facing along it, level. Lifted
 * to `clearanceMetres` above the highest collision surface under it when the
 * line is lower than that — the authored line is certified clear of TERRAIN (min AGL
 * 18 m, `route.ts`), but the gate polyline a course without one falls back to
 * is straight between rings and can cut a hill.
 *
 * ── There is no line before arc 0, so it is EXTENDED (DEV-289) ────────────
 *
 * This used to be `max(0, hitS - resetBackMetres)`, and the clamp is the
 * difference between backing AWAY from the first ring and piling up ON it.
 * Every shipped HoverJet course's authored line starts at ring 1 — the first
 * point is **1.4 m** from its trigger centre against a **22.62 m** radius — so
 * a crash inside the first `resetBackMetres` of the run put the ship inside
 * ring 1's sphere. Gates fire on an EDGE (DEV-149), so the ship then flew out
 * of a ring it had never entered and the ring stayed unscored: a crash before
 * the first ring cost you that ring.
 *
 * So the shortfall is carried BACKWARDS along the line's own direction at arc
 * 0 instead of being thrown away. The reset is then always the full
 * `resetBackMetres` behind where the run had got to, and always approaches the
 * gate it owes from outside — which is the only place a ring can be flown
 * through. `reset.s` stays clamped at 0 because a follower's cursor has no
 * arc before the start to be rewound to.
 *
 * ── Except where there is no line to extend ───────────────────────────────
 *
 * A line SHORTER than the back-off is not a course to back down. The only one
 * is `gatePolyline`'s zero-gate stub — 1 m, pointing along sim +z because it
 * has to point somewhere — which five of the six JumpSeat missions fly because
 * they author no rings at all. Extrapolating that 1 m by 120 would put the
 * ship an arbitrary 120 m from its spawn in a direction nothing chose. Below
 * `resetBackMetres` of line the reset stays at the start, which is what those
 * five missions have always done.
 */
const planResetAt = (
  reset: CrashReset,
  spec: CrashSpec,
  route: Route,
  s: number,
  fields: readonly HeightField[],
): void => {
  // DEV-289 ported onto DEV-185's shape. The branch computed `s` in here and
  // clamped it at 0; this function now RECEIVES `s` because DEV-185 tries
  // several candidates to miss a prop. So the clamp moves here, where "put the
  // pose at arc `s`" lives, and a negative `s` means "before the start" rather
  // than "at the start".
  const onLine = Math.max(0, s)
  routeAt(route, onLine, reset.position)
  // Clamped: a follower's cursor has no arc before the start to be rewound to.
  reset.s = onLine

  // The line's direction here — the tangent at arc 0 when `s` ran off the
  // front, which is what the carry below extends along AND what the ship is
  // aimed down at the end. One lookup, used for both, so the two cannot
  // disagree about which way the course goes.
  routeTangentAt(route, onLine, _tangent)
  // A line SHORTER than the back-off is not a course to back down — see the
  // header. `gatePolyline`'s 1 m zero-gate stub is the only one, and five
  // JumpSeat missions fly it.
  if (s < 0 && route.length >= spec.resetBackMetres) {
    reset.position.x += _tangent.x * s
    reset.position.y += _tangent.y * s
    reset.position.z += _tangent.z * s
  }

  // DEV-705 (Matt, 2026-10-05): a point UNDER a floating pad is under it, not
  // in it (`belowField`, DEV-383), as the hull and the legs already read it.
  // Reading every pad as solid to the ground lifted a line point that ran
  // beneath a pad up THROUGH it, onto the pad's top.
  const ground = highestGroundUnder(fields, reset.position.x, reset.position.z, reset.position.y)
  if (Number.isFinite(ground) && reset.position.y < ground + spec.clearanceMetres) {
    reset.position.y = ground + spec.clearanceMetres
  }

  // Along the line, flattened: a reset that inherits the line's pitch through a
  // climb would come back nose-up at low speed, and it comes back level.
  // `_tangent` is the one fetched above, at `onLine`.
  const flat = Math.hypot(_tangent.x, _tangent.z)
  const ux = flat > 1e-9 ? _tangent.x / flat : 0
  const uz = flat > 1e-9 ? _tangent.z / flat : 1
  reset.velocity.x = ux * spec.resetSpeed
  reset.velocity.y = 0
  reset.velocity.z = uz * spec.resetSpeed
  // Yaw only. Body forward is +z (`hoverjet.ts` thrusts along body z), so the
  // yaw that carries (0,0,1) onto (ux, 0, uz) is atan2(ux, uz).
  const yaw = Math.atan2(ux, uz)
  reset.orientation.x = 0
  reset.orientation.y = Math.sin(yaw / 2)
  reset.orientation.z = 0
  reset.orientation.w = Math.cos(yaw / 2)
}

/**
 * Where the ship goes back to, computed from where it is now.
 *
 * Nearest point on the line up to the run's progress, backed off by
 * `resetBackMetres` of arc length (never before the start), then walked FURTHER
 * back until the hull is out of the forest.
 *
 * ── Why the forest is in here at all (DEV-185) ────────────────────────────
 *
 * `route-clearance.test.ts` certifies the authored line against the TERRAIN and
 * nothing else, and 2016's line was authored before this port scattered a tree
 * on it: `int_01`'s runs through palm #840's capsule for 16 m of its length,
 * and 10 m of that is arc a crash reset lands on. Measured, not reasoned —
 * `crash-reset-clearance.test.ts` builds the real 1,241-collider Simonet forest
 * and walks every mission.
 *
 * The reset arrives at `resetSpeed`, and `resetSpeed` is UNDER `breakSpeed` on
 * this preset — deliberately, for the reason DEV-126 gives — so a reset inside
 * a trunk is always in `stepPropCollision`'s BOUNCE branch and never its break
 * branch. That is the whole shape of the bug: the ship cannot push the tree
 * over, so the tree pushes the ship out, sideways, off the line it was just put
 * back on. (Measured on `int_01`: one tick, 1.3 m, 40.0 → 39.0 m/s. It ejects
 * rather than traps — but the frame the curtain lifts on is the inside of a
 * palm, and DEV-180's racers are the same mechanism with worse luck.)
 *
 * ── Why BACK along the line, and not UP ───────────────────────────────────
 *
 * Because the reset's one promise is *back on the course*, and further back
 * along the arc is still on it while `canopy + clearanceMetres` is 44 m above
 * it — nose level, at 40 m/s, looking at sky with the next gate underneath.
 * Backing off is also the motion the rule already makes: `resetBackMetres` is
 * the same move, and this is a little more of it. The cost is bounded by that
 * same number, so a crash can never cost more than twice the ground it already
 * costs you, and on `int_01` the clear spot is 10 m further back out of 120.
 *
 * If nothing inside the budget is clear the DEEPEST-clear candidate is kept, so
 * this is monotone: the reset is never put somewhere worse than the one
 * `resetClearStepMetres: 0` would have chosen. `props` null does exactly that
 * and is every Classic run.
 */
export const planCrashReset = (
  state: CrashState,
  spec: CrashSpec,
  body: RigidBody,
  course: CrashCourse,
  fields: readonly HeightField[],
  props: CrashProps | null = null,
): void => {
  const hitS = routeArcLengthNearWithin(course.route, body.position, course.limitS)
  // NOT `Math.max(0, ...)` any more — DEV-289. The clamp is what piled the
  // reset ONTO ring 1 instead of behind it; `planResetAt` carries a negative
  // arc backwards along the line's own direction at 0 instead.
  const s0 = hitS - spec.resetBackMetres
  const reset = state.reset
  planResetAt(reset, spec, course.route, s0, fields)
  if (!props || !(spec.resetClearStepMetres > 0)) return

  let best = propPenetrationAt(reset.position, reset.orientation, props.hull, props.colliders)
  if (best <= 0) return
  let bestS = s0
  // The floor is the FIRST candidate, not 0. DEV-185 backs further off to miss
  // a prop, and "further" must not mean "forward": with `s0` already negative
  // (a crash inside the first `resetBackMetres`) a floor of 0 would search
  // TOWARDS the ring it is backing away from. Where `s0 >= 0` this is 0 and
  // the search is exactly what it was.
  const floorS = Math.min(0, s0)
  for (let back = spec.resetClearStepMetres; back <= spec.resetBackMetres; ) {
    const s = Math.max(floorS, s0 - back)
    planResetAt(reset, spec, course.route, s, fields)
    const deep = propPenetrationAt(reset.position, reset.orientation, props.hull, props.colliders)
    if (deep <= 0) return
    if (deep < best) {
      best = deep
      bestS = s
    }
    if (s <= floorS) break
    back += spec.resetClearStepMetres
  }
  planResetAt(reset, spec, course.route, bestS, fields)
}

/** Put a body at the planned reset: pose, velocity, and nothing spinning. */
export const applyCrashReset = (state: CrashState, body: RigidBody): void => {
  const r = state.reset
  body.position.x = r.position.x
  body.position.y = r.position.y
  body.position.z = r.position.z
  body.orientation.x = r.orientation.x
  body.orientation.y = r.orientation.y
  body.orientation.z = r.orientation.z
  body.orientation.w = r.orientation.w
  body.velocity.x = r.velocity.x
  body.velocity.y = r.velocity.y
  body.velocity.z = r.velocity.z
  body.angularVelocity.x = 0
  body.angularVelocity.y = 0
  body.angularVelocity.z = 0
}

export type CrashEvent = 'none' | 'crashed' | 'reset'

/**
 * One fixed step of the crash rule for one ship. Call it AFTER the contact has
 * run, with the contact's `impactSpeed` (or the max of that and any other hit).
 *
 * Returns `crashed` on the tick the hold begins — the body's velocity is
 * zeroed then, so nothing that reads speed (G1's meter, the engine note) sees
 * a ship doing 200 m/s inside a hillside for half a second — and `reset` on
 * the tick the body is placed back on the line.
 *
 * The body is NOT integrated while `crashed`; that is the caller's contract
 * (`crashHoldsShip`), the same shape as `launchHoldsShip`.
 */
export const stepCrash = (
  state: CrashState,
  spec: CrashSpec,
  body: RigidBody,
  impactSpeed: number,
  course: CrashCourse,
  fields: readonly HeightField[],
  dt: number,
  props: CrashProps | null = null,
): CrashEvent => {
  state.justReset = false
  if (state.phase === 'crashed') {
    state.heldFor += dt
    if (state.heldFor < spec.holdSeconds) return 'none'
    applyCrashReset(state, body)
    state.phase = 'flying'
    state.heldFor = 0
    state.justReset = true
    return 'reset'
  }
  if (!isCrash(spec, impactSpeed)) return 'none'
  state.phase = 'crashed'
  state.heldFor = 0
  state.impactSpeed = impactSpeed
  state.count++
  planCrashReset(state, spec, body, course, fields, props)
  // The wreck is still. See above.
  body.velocity.x = 0
  body.velocity.y = 0
  body.velocity.z = 0
  body.angularVelocity.x = 0
  body.angularVelocity.y = 0
  body.angularVelocity.z = 0
  // A zero hold resets on the same tick: no curtain, no beat, straight back.
  if (spec.holdSeconds <= 0) {
    applyCrashReset(state, body)
    state.phase = 'flying'
    state.justReset = true
    return 'reset'
  }
  return 'crashed'
}

/**
 * The crash and the boundary, stepped together under the three rules in the
 * header. The ONE place their order is written down.
 *
 * `boundarySpec` null is a mission with no boundary (6 of 13), and then this is
 * `stepCrash` alone.
 */
export const stepCrashAndBoundary = (
  crash: CrashState,
  crashSpec: CrashSpec,
  boundary: BoundaryState,
  boundarySpec: BoundarySpec | null,
  body: RigidBody,
  impactSpeed: number,
  course: CrashCourse,
  fields: readonly HeightField[],
  dt: number,
  props: CrashProps | null = null,
): { crash: CrashEvent; restarted: boolean } => {
  // Held where it hit: the boundary clock is frozen with the rest of the ship.
  if (crash.phase === 'crashed') {
    return {
      crash: stepCrash(crash, crashSpec, body, impactSpeed, course, fields, dt, props),
      restarted: false,
    }
  }
  const restarted = boundarySpec !== null && stepBoundary(boundary, boundarySpec, body.position, dt)
  // Dying, or restarted this very tick: the ship is being put back already, and
  // a second reset on top of it is the double the header forbids.
  if (restarted || boundary.phase === 'dying') {
    crash.justReset = false
    return { crash: 'none', restarted }
  }
  return {
    crash: stepCrash(crash, crashSpec, body, impactSpeed, course, fields, dt, props),
    restarted,
  }
}

/**
 * The course line for a level with no authored `route`: straight through the
 * gate centres from the start. SIM space in, sim space out.
 *
 * `createRoute` takes THREE-space points and mirrors z, so the mirror is
 * applied here first and the two cancel — one line, in one space, rather than
 * a second `createRoute` that does not flip.
 */
export const gatePolyline = (start: Vec3, gates: readonly Gate[]): Route =>
  createRoute(
    gates.length === 0
      ? // No gates, no course: a 1 m stub from the start, along sim +z. Five of
        // the six JumpSeat missions author no rings, `createRoute` refuses a
        // single point, and the first cut of this threw on their boot. A crash
        // on this line lands at the start.
        [
          [start.x, start.y, -start.z],
          [start.x, start.y, -(start.z + 1)],
        ]
      : [[start.x, start.y, -start.z], ...gates.map((g) => [g.centre.x, g.centre.y, -g.centre.z])],
  )

/**
 * A course line: the `Route` a ship is put back on and each gate's arc along
 * it. The one shape the guide, the racers, the traffic, a crash reset and the
 * lap server all pass around (code-reuse SG-1; `ResetLine` in
 * `net/lap-validate.ts` is this type under its old name).
 */
export interface CourseLine {
  readonly route: Route
  /** Each gate's arc length along `route`, in gate order. */
  readonly gateArc: readonly number[]
}

/**
 * The line over an authored route: `createRoute` over `points` (THREE space,
 * as the level JSON spells them), then each gate's arc on it. The client's
 * guide, the racers, the ambient traffic and the lap server's reset line all
 * build it, and it is one function so they cannot drift (the server's verdict
 * is only as good as its agreement with the line the client resets onto).
 */
export const routeLineOf = (
  points: readonly (readonly number[])[],
  gates: readonly Gate[],
): CourseLine => {
  const route = createRoute(points)
  return { route, gateArc: gateArcLengths(route, gates) }
}

/**
 * The line for a course with no authored route: the polyline from `start`
 * through the gate centres. On it gate `i` is point `i + 1`, so its arc is
 * `cumulative[i + 1]` exactly, with no search. `start` is SIM space, as
 * `gatePolyline` takes it.
 */
export const gatePolylineLine = (start: Vec3, gates: readonly Gate[]): CourseLine => {
  const route = gatePolyline(start, gates)
  return { route, gateArc: gates.map((_, i) => route.cumulative[i + 1] as number) }
}

/**
 * The line a crash resets onto, where nothing else has said which: the
 * authored route when it has two points or more, else the polyline from
 * `start`. The lap server's `resetLineOf` is this. (The client's
 * `crashLineOf` asks the guide first, because `?guide=off` hides a route the
 * level has, and then falls through to `gatePolylineLine` itself.)
 */
export const resetLineFor = (
  points: readonly (readonly number[])[] | null | undefined,
  start: Vec3,
  gates: readonly Gate[],
): CourseLine =>
  points && points.length > 1 ? routeLineOf(points, gates) : gatePolylineLine(start, gates)
