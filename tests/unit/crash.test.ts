// tests/unit/crash.test.ts — hit too hard and you are put back on the course.
// DEV-126, Anniversary.
//
// Matt: *"we should have player ships crash if they collide too hard - they
// get reset near their crash spot, but back on the course (like an arcade
// game)."*
//
// The claims worth a test are about WHERE the ship comes back and WHEN, and
// about the one thing that must never happen twice: a reset. The reset
// position is measured against the course line (a distance), the heading
// against the line's tangent (a dot product), and the hold against the clock —
// never against the quaternion the planner wrote. The boundary interaction is
// DEV-074's edge lesson run forwards: every sequence here is one Unity could
// produce, starting inside the sphere and leaving it.

import { describe, expect, it } from 'vitest'
import { DERIVED, HOVERJET } from '@/generated/constants.generated'
import { AI_RACER_TUNINGS, createAiRacer, stepAiRacer } from '@/sim/ai-racer'
import { type BoundarySpec, createBoundary } from '@/sim/boundary'
import { FIXED_DT } from '@/sim/constants'
import type { Gate } from '@/sim/course'
import {
  type CrashCourse,
  type CrashSpec,
  crashHoldsShip,
  createCrash,
  gatePolyline,
  isCrash,
  planCrashReset,
  stepCrash,
  stepCrashAndBoundary,
} from '@/sim/crash'
import { rotateVec3 } from '@/sim/math/quat'
import { type Vec3, v3 } from '@/sim/math/vec3'
import {
  createPropCollision,
  type PropColliders,
  type PropCollisionSpec,
  propPenetrationAt,
  stepPropCollision,
} from '@/sim/props/collision'
import { createRigidBody, type RigidBody } from '@/sim/rigidbody'
import {
  createRoute,
  routeArcLengthNear,
  routeAt,
  routeDistance,
  routeTangentAt,
} from '@/sim/route'
import type { FacetedTerrainParams } from '@/sim/terrain/faceted'
import { buildHeightField, terrainHeightAt } from '@/sim/terrain/height-field'
import type { MapSampler, Rgb } from '@/sim/terrain/image-sampler'
import {
  createTerrainCollision,
  HOVERJET_GROUND,
  stepTerrainCollision,
} from '@/sim/terrain-collision'
import anniversary from '../../content/editions/anniversary.json'
import int01 from '../../content/levels/int_01_hoverJet.json'

// ── fixtures ──────────────────────────────────────────────────────────────

/** The preset's numbers, so the test argues with the same ones the game does. */
const SPEC = (anniversary as unknown as { gameplay: { crash: CrashSpec } }).gameplay.crash
/** And the prop collision's, for DEV-185's forest at the foot of the file. */
const PROPS = (anniversary as unknown as { gameplay: { propCollision: PropCollisionSpec } })
  .gameplay.propCollision

/** The real line, in sim space, the way the loader builds it. */
const ROUTE = createRoute((int01 as unknown as { route: number[][] }).route)

/** A flat plate at a fixed height, the way `terrain-collision.test.ts` builds one. */
const flatMap = (g: number): MapSampler =>
  ({
    width: 256,
    height: 256,
    sample(_u: number, _v: number, out: Rgb): Rgb {
      out.r = g
      out.g = g
      out.b = g
      return out
    },
  }) as unknown as MapSampler
const PARAMS = {
  terrainSize: 8192,
  terrainHeight: 100,
  baseResolution: 8,
  chunkSize: 256,
  randomOffset: 0,
  seed: 1,
} as unknown as FacetedTerrainParams
/** 8 km square of ground at y = 50, covering the whole of int_01's course. */
const GROUND_Y = 50
const FLAT = buildHeightField(flatMap(GROUND_Y / 100), PARAMS, {
  position: [-4096, 0, -4096],
  scale: [1, 1, 1],
})

const body = (position: Vec3, velocity: Vec3): RigidBody => {
  const b = createRigidBody({
    mass: HOVERJET.rigidbody.mass,
    drag: HOVERJET.rigidbody.drag,
    angularDrag: HOVERJET.rigidbody.angularDrag,
    useGravity: false,
  })
  b.position.x = position.x
  b.position.y = position.y
  b.position.z = position.z
  b.velocity.x = velocity.x
  b.velocity.y = velocity.y
  b.velocity.z = velocity.z
  return b
}

/** A point on the real line, and a course that says the run has reached it. */
const onLine = (s: number): { at: Vec3; course: CrashCourse } => {
  const at = v3()
  // `routeAt` is what the planner uses; take the point off the line by hand so
  // the test's reference is the raw polyline rather than the planner's helper.
  let i = 0
  while (i < ROUTE.count - 2 && (ROUTE.cumulative[i + 1] as number) < s) i++
  const a = ROUTE.cumulative[i] as number
  const b = ROUTE.cumulative[i + 1] as number
  const t = (s - a) / (b - a)
  at.x = (ROUTE.points[i * 3] as number) * (1 - t) + (ROUTE.points[(i + 1) * 3] as number) * t
  at.y =
    (ROUTE.points[i * 3 + 1] as number) * (1 - t) + (ROUTE.points[(i + 1) * 3 + 1] as number) * t
  at.z =
    (ROUTE.points[i * 3 + 2] as number) * (1 - t) + (ROUTE.points[(i + 1) * 3 + 2] as number) * t
  return { at, course: { route: ROUTE, limitS: s + 400 } }
}

const speedOf = (b: RigidBody): number => Math.hypot(b.velocity.x, b.velocity.y, b.velocity.z)

// ── the threshold ─────────────────────────────────────────────────────────

describe('the threshold', () => {
  it('is half the unboosted terminal speed off the sheet', () => {
    // The preset's note derives 45 from `terminalSpeedCruise` (89.81): a ship at
    // unboosted terminal hitting at 30° of incidence. Held here so a retune of
    // either number has to say why they no longer agree.
    expect(SPEC.minImpactSpeed).toBeCloseTo(DERIVED.hoverjet.terminalSpeedCruise / 2, 0)
  })

  it('a low-speed kiss is NOT a crash; a hard hit is', () => {
    expect(isCrash(SPEC, 0)).toBe(false)
    expect(isCrash(SPEC, SPEC.minImpactSpeed * 0.9)).toBe(false)
    expect(isCrash(SPEC, SPEC.minImpactSpeed)).toBe(true)
    expect(isCrash(SPEC, 200)).toBe(true)
    // Classic: the same number with the flag off is never a crash.
    expect(isCrash({ ...SPEC, enabled: false }, 200)).toBe(false)
  })

  it('reads the impact speed off the CONTACT: straight down at 60 m/s is 60', () => {
    // The number the crash rule consumes is the contact's own normal component,
    // computed on the tick it is removed. A body just above a flat plate,
    // falling at 60 m/s, reports 60; the same body skimming at 1 m/s down and
    // 150 m/s along reports 1. A shallow graze at racing speed is a graze.
    const state = createTerrainCollision()
    const hull = HOVERJET_GROUND.collision
    // The contact tests POSITIONS, so the hull's lowest sphere is put 0.3 m
    // into the plate — the state a body arrives in on the tick it hits.
    const lowest = Math.min(...hull.hull.map((s) => s.y - s.radius))
    const diving = body(v3(0, GROUND_Y - lowest - 0.3, 0), v3(0, -60, 0))
    stepTerrainCollision(state, diving, [FLAT], hull, FIXED_DT)
    expect(state.impactSpeed).toBeCloseTo(60, 6)
    const grazing = body(v3(0, GROUND_Y - lowest - 0.3, 0), v3(150, -1, 0))
    const graze = createTerrainCollision()
    stepTerrainCollision(graze, grazing, [FLAT], hull, FIXED_DT)
    expect(graze.impactSpeed).toBeCloseTo(1, 6)
    expect(isCrash(SPEC, graze.impactSpeed)).toBe(false)
    // And nothing touched: zero, not stale.
    const clear = createTerrainCollision()
    stepTerrainCollision(
      clear,
      body(v3(0, GROUND_Y + 500, 0), v3(0, -60, 0)),
      [FLAT],
      hull,
      FIXED_DT,
    )
    expect(clear.impactSpeed).toBe(0)
  })
})

// ── the reset ─────────────────────────────────────────────────────────────

describe('the reset', () => {
  it('goes back on the LINE, behind the crash by the preset distance', () => {
    // Crash 3 km along the course, 60 m off the line. The reset must be ON the
    // line (distance to it, not to a vertex — DEV-027), `resetBackMetres` of
    // arc length behind where the ship left it.
    const { at, course } = onLine(3000)
    const b = body(v3(at.x + 40, at.y + 30, at.z + 30), v3(0, 0, 0))
    // Where the ship LEFT the line is its projection onto it — measured here
    // with the whole-line search, which is exact where the line does not fold
    // (the probe found no self-proximity on int_01 within 5 m of arc).
    const left = routeArcLengthNear(ROUTE, b.position)
    expect(Math.abs(left - 3000)).toBeLessThan(60)
    const state = createCrash()
    planCrashReset(state, SPEC, b, course, [])
    expect(routeDistance(ROUTE, state.reset.position)).toBeLessThan(1)
    expect(state.reset.s).toBeCloseTo(left - SPEC.resetBackMetres, 6)
    expect(routeArcLengthNear(ROUTE, state.reset.position)).toBeCloseTo(state.reset.s, 0)
  })

  it('faces ALONG the line and leaves at the reset speed', () => {
    const { at, course } = onLine(3000)
    const state = createCrash()
    planCrashReset(state, SPEC, body(at, v3()), course, [])
    const tangent = routeTangentAt(ROUTE, state.reset.s)
    const flat = Math.hypot(tangent.x, tangent.z)
    // Velocity: the flattened tangent, at `resetSpeed`.
    const v = state.reset.velocity
    expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(SPEC.resetSpeed, 9)
    expect((v.x * tangent.x + v.z * tangent.z) / (SPEC.resetSpeed * flat)).toBeCloseTo(1, 6)
    // Heading: body +z rotated by the orientation is the same direction —
    // measured as a dot product, not as a quaternion.
    const nose = rotateVec3(v3(), state.reset.orientation, v3(0, 0, 1))
    expect((nose.x * v.x + nose.z * v.z) / SPEC.resetSpeed).toBeCloseTo(1, 6)
    expect(nose.y).toBeCloseTo(0, 9)
  })

  it('never goes back before the START of the line', () => {
    const { at, course } = onLine(30)
    const state = createCrash()
    planCrashReset(state, SPEC, body(at, v3()), course, [])
    expect(state.reset.s).toBe(0)
  })

  it('is lifted to the clearance height when the line is lower than that', () => {
    // A plate at y = 600 under a line that sits at y = 465 at 3 km: the reset
    // must come back `clearanceMetres` above the plate, not inside it.
    const HIGH = buildHeightField(flatMap(1), PARAMS, {
      position: [-4096, 0, -4096],
      scale: [1, 6, 1],
    })
    const { at, course } = onLine(3000)
    const state = createCrash()
    planCrashReset(state, SPEC, body(at, v3()), course, [HIGH])
    const ground = terrainHeightAt(HIGH, state.reset.position.x, state.reset.position.z)
    expect(ground).toBeGreaterThan(at.y)
    expect(state.reset.position.y).toBeCloseTo(ground + SPEC.clearanceMetres, 6)
    // And left alone when the line is already clear of the ground.
    const low = createCrash()
    planCrashReset(low, SPEC, body(at, v3()), course, [FLAT])
    expect(low.reset.position.y).toBeGreaterThan(GROUND_Y + SPEC.clearanceMetres)
    expect(routeDistance(ROUTE, low.reset.position)).toBeLessThan(1)
  })

  it('searches only the part of the line the run has REACHED', () => {
    // A hairpin: out 1 km along +x at z = 0, back along −x at z = 40. A ship
    // 25 m off the outbound leg toward the return leg is NEARER the return leg
    // (15 m) — a whole-line search would put it back on a leg it has not flown
    // yet, half the course ahead. Bounding the search at the next gate's arc
    // length keeps it on the leg it is on. Synthetic on purpose: int_01's two
    // fold-backs are hundreds of metres apart and never this close, so the real
    // line would pass this test without exercising the bound.
    const hairpin = createRoute([
      ...Array.from({ length: 21 }, (_, i) => [i * 50, 100, 0]),
      ...Array.from({ length: 21 }, (_, i) => [1000 - i * 50, 100, -40]),
    ])
    // THREE-space z = −40 is sim z = +40 after `createRoute`'s mirror.
    const off = v3(500, 100, 25)
    expect(routeArcLengthNear(hairpin, off)).toBeGreaterThan(1000)
    const state = createCrash()
    planCrashReset(state, SPEC, body(off, v3()), { route: hairpin, limitS: 600 }, [])
    expect(state.reset.s).toBeCloseTo(500 - SPEC.resetBackMetres, 6)
    expect(state.reset.position.z).toBeCloseTo(0, 6)
  })
})

// ── the state machine ─────────────────────────────────────────────────────

describe('a crash, tick by tick', () => {
  it('holds for `holdSeconds` with the wreck STILL, then resets on the line at low speed', () => {
    const { at, course } = onLine(3000)
    const b = body(v3(at.x, at.y, at.z), v3(150, -60, 0))
    const state = createCrash()
    expect(stepCrash(state, SPEC, b, 100, course, [], FIXED_DT)).toBe('crashed')
    expect(crashHoldsShip(state)).toBe(true)
    expect(state.count).toBe(1)
    expect(state.impactSpeed).toBe(100)
    // Still: nothing reads a 150 m/s ship inside a hillside during the hold.
    expect(speedOf(b)).toBe(0)
    const where = { ...b.position }
    let ticks = 0
    let event: string = 'none'
    while (event === 'none' && ticks < 1000) {
      event = stepCrash(state, SPEC, b, 0, course, [], FIXED_DT)
      ticks++
      if (event === 'none') expect(b.position).toEqual(where)
    }
    expect(event).toBe('reset')
    expect(state.justReset).toBe(true)
    expect(ticks * FIXED_DT).toBeGreaterThanOrEqual(SPEC.holdSeconds)
    expect(ticks * FIXED_DT).toBeLessThan(SPEC.holdSeconds + 2 * FIXED_DT)
    expect(crashHoldsShip(state)).toBe(false)
    expect(speedOf(b)).toBeCloseTo(SPEC.resetSpeed, 9)
    expect(routeDistance(ROUTE, b.position)).toBeLessThan(1)
    // The flag is one tick wide.
    stepCrash(state, SPEC, b, 0, course, [], FIXED_DT)
    expect(state.justReset).toBe(false)
  })

  it('a kiss during the hold cannot start a second crash', () => {
    const { at, course } = onLine(3000)
    const b = body(at, v3())
    const state = createCrash()
    stepCrash(state, SPEC, b, 100, course, [], FIXED_DT)
    stepCrash(state, SPEC, b, 300, course, [], FIXED_DT)
    expect(state.count).toBe(1)
  })

  it('a zero hold is straight back, on the same tick', () => {
    const { at, course } = onLine(3000)
    const b = body(at, v3(0, -100, 0))
    const state = createCrash()
    expect(stepCrash(state, { ...SPEC, holdSeconds: 0 }, b, 100, course, [], FIXED_DT)).toBe(
      'reset',
    )
    expect(routeDistance(ROUTE, b.position)).toBeLessThan(1)
  })
})

// ── with the boundary ─────────────────────────────────────────────────────

describe('the crash and the boundary never both reset the ship', () => {
  const BOUNDARY: BoundarySpec = {
    enabled: true,
    centre: v3(-309, 223.35, 39),
    radius: 2918.71165,
    resetDelaySeconds: 13,
    fadeSeconds: 2.5,
  }
  const OUTSIDE = v3(-309 + 3200, 200, 39)

  /** Inside, then out, then `seconds` on the clock. A sequence Unity can produce. */
  const armedAndWarning = (b: RigidBody, seconds: number) => {
    const boundary = createBoundary()
    const inside = { ...b.position }
    b.position.x = BOUNDARY.centre.x
    b.position.z = BOUNDARY.centre.z
    stepCrashAndBoundary(
      createCrash(),
      SPEC,
      boundary,
      BOUNDARY,
      b,
      0,
      onLine(3000).course,
      [],
      FIXED_DT,
    )
    b.position.x = OUTSIDE.x
    b.position.z = OUTSIDE.z
    for (let t = 0; t < seconds; t += FIXED_DT) {
      stepCrashAndBoundary(
        createCrash(),
        SPEC,
        boundary,
        BOUNDARY,
        b,
        0,
        onLine(3000).course,
        [],
        FIXED_DT,
      )
    }
    expect(boundary.phase).toBe('warning')
    b.position.x = inside.x
    b.position.z = inside.z
    return boundary
  }

  it('a crash on the countdown freezes the clock, resets once, and the reset cancels the countdown', () => {
    const { at, course } = onLine(3000)
    const b = body(at, v3())
    // Twelve and a half seconds outside: the boundary would kill in half a
    // second. Then the ship hits a hill, outside.
    const boundary = armedAndWarning(b, 12.5)
    b.position.x = OUTSIDE.x
    b.position.z = OUTSIDE.z
    const outsideFor = boundary.outsideFor
    const crash = createCrash()
    let restarts = 0
    let resets = 0
    let first = stepCrashAndBoundary(crash, SPEC, boundary, BOUNDARY, b, 100, course, [], FIXED_DT)
    // The boundary stepped first this tick (one more dt), then the crash fired.
    expect(first.crash).toBe('crashed')
    expect(first.restarted).toBe(false)
    const frozenAt = boundary.outsideFor
    expect(frozenAt).toBeCloseTo(outsideFor + FIXED_DT, 9)
    // Hold: 0.55 s, during which the 13 s clock WOULD have run out.
    for (let t = 0; t < SPEC.holdSeconds + 5 * FIXED_DT; t += FIXED_DT) {
      first = stepCrashAndBoundary(crash, SPEC, boundary, BOUNDARY, b, 0, course, [], FIXED_DT)
      if (first.restarted) restarts++
      if (first.crash === 'reset') {
        resets++
        // The clock did not move while the ship was held.
        expect(boundary.outsideFor).toBeCloseTo(frozenAt, 9)
        expect(boundary.phase).toBe('warning')
      }
    }
    expect(resets).toBe(1)
    expect(restarts).toBe(0)
    expect(crash.count).toBe(1)
    // The reset is on the course, which is inside the sphere: the next tick is
    // an `OnTriggerEnter` and the countdown cancels — DEV-074's edge, forwards.
    expect(boundary.phase).toBe('inside')
    expect(boundary.outsideFor).toBe(0)
  })

  it('a ship already DYING cannot crash — one reset, the boundary’s', () => {
    const { at, course } = onLine(3000)
    const b = body(at, v3())
    const boundary = armedAndWarning(b, 12.99)
    // 12.99 s outside and a couple more ticks outside: past `resetDelay`, dying.
    b.position.x = OUTSIDE.x
    b.position.z = OUTSIDE.z
    const crash = createCrash()
    let r = stepCrashAndBoundary(crash, SPEC, boundary, BOUNDARY, b, 0, course, [], FIXED_DT)
    r = stepCrashAndBoundary(crash, SPEC, boundary, BOUNDARY, b, 0, course, [], FIXED_DT)
    expect(boundary.phase).toBe('dying')
    // Hits a hill hard while the curtain is down. Nothing.
    r = stepCrashAndBoundary(crash, SPEC, boundary, BOUNDARY, b, 300, course, [], FIXED_DT)
    expect(r.crash).toBe('none')
    expect(crash.count).toBe(0)
    // And exactly one restart comes out of the fade, with the wreck grinding
    // into the hill the whole way down. (After the restart the game moves the
    // ship to the respawn marker, so the hits stop; the loop stops with them.)
    let restarts = 0
    for (let t = 0; t < 3 && restarts === 0; t += FIXED_DT) {
      r = stepCrashAndBoundary(crash, SPEC, boundary, BOUNDARY, b, 300, course, [], FIXED_DT)
      if (r.restarted) restarts++
    }
    expect(restarts).toBe(1)
    expect(crash.count).toBe(0)
    // Once put back and flying, a hard hit is a crash again — the exemption was
    // the dying, not the ship.
    r = stepCrashAndBoundary(crash, SPEC, boundary, BOUNDARY, b, 300, course, [], FIXED_DT)
    expect(r.crash).toBe('crashed')
  })

  it('a mission with no boundary is the crash alone', () => {
    const { at, course } = onLine(3000)
    const b = body(at, v3())
    const boundary = createBoundary()
    const r = stepCrashAndBoundary(
      createCrash(),
      SPEC,
      boundary,
      null,
      b,
      100,
      course,
      [],
      FIXED_DT,
    )
    expect(r).toEqual({ crash: 'crashed', restarted: false })
    expect(boundary.phase).toBe('inside')
  })
})

// ── a course with no gates ────────────────────────────────────────────────

describe('a course with NO gates', () => {
  it('still has a line, so a JumpSeat mission with zero rings can BOOT', () => {
    // Five of the six JumpSeat missions author no rings. `createRoute` refuses
    // one point, and the first cut of `app.ts` handed it exactly one — the
    // start — so `rookie_01_jumpSeat` threw on load and never came up.
    // `launch-ride-on-switch.spec.ts` found it ("never rides on a mission with
    // no launch rig at all"). The line is a stub from the start, and a crash
    // on it puts the ship back at the start.
    const start = v3(10, 100, -20)
    const line = gatePolyline(start, [])
    expect(line.count).toBe(2)
    expect(line.length).toBeGreaterThan(0)
    const b = body(v3(10, 100, -20), v3(0, -100, 0))
    const state = createCrash()
    expect(stepCrash(state, SPEC, b, 100, { route: line, limitS: line.length }, [], FIXED_DT)).toBe(
      'crashed',
    )
    expect(state.reset.position.x).toBeCloseTo(start.x, 6)
    expect(state.reset.position.z).toBeCloseTo(start.z, 6)
  })
})

// ── the racers ────────────────────────────────────────────────────────────

describe('an AI racer under the same rule', () => {
  /** A ring buried under the plate, so the racer dives into the ground chasing it. */
  const buried: Gate[] = [
    { centre: v3(0, GROUND_Y - 200, 900), radius: 22, points: 100, triggerOnce: true },
    { centre: v3(0, 200, 2500), radius: 22, points: 100, triggerOnce: true },
  ]
  const spawn = v3(0, 400, 0)
  const spec = (id: string) => ({
    id,
    spawn,
    orientation: [0, 0, 0, 1] as const,
    tuning: AI_RACER_TUNINGS.fast as never,
  })

  it('crashes into the plate, is held, and comes back on its gate line at low speed', () => {
    const racer = createAiRacer(spec('a'), buried)
    let crashedAt = -1
    let resetAt = -1
    let heldStill = true
    let held = { ...racer.jet.body.position }
    for (let i = 0; i < Math.round(60 / FIXED_DT) && resetAt < 0; i++) {
      stepAiRacer(racer, buried, [], FIXED_DT, null, [FLAT], SPEC)
      if (racer.crashEvent === 'crashed') {
        crashedAt = i
        held = { ...racer.jet.body.position }
        expect(racer.crash.impactSpeed).toBeGreaterThanOrEqual(SPEC.minImpactSpeed)
      } else if (crashedAt >= 0 && resetAt < 0 && racer.crashEvent === 'none') {
        heldStill = heldStill && racer.jet.body.position.y === held.y
      }
      if (racer.crashEvent === 'reset') resetAt = i
    }
    expect(crashedAt, 'it did dive in').toBeGreaterThan(0)
    expect(resetAt, 'and came back').toBeGreaterThan(crashedAt)
    expect(heldStill).toBe(true)
    expect((resetAt - crashedAt) * FIXED_DT).toBeGreaterThanOrEqual(SPEC.holdSeconds)
    // Back on ITS course — the gate polyline from its spawn — at the reset
    // speed, above the plate by the clearance.
    const line = gatePolyline(spawn, buried)
    expect(routeDistance(line, racer.jet.body.position)).toBeLessThan(
      SPEC.clearanceMetres + GROUND_Y,
    )
    expect(racer.jet.body.position.y).toBeGreaterThanOrEqual(GROUND_Y + SPEC.clearanceMetres - 1e-6)
    expect(speedOf(racer.jet.body)).toBeCloseTo(SPEC.resetSpeed, 6)
    expect(racer.crash.count).toBe(1)
  })

  it('bounces exactly as before with the rule off — Classic is untouched', () => {
    const on = createAiRacer(spec('a'), buried)
    const off = createAiRacer(spec('a'), buried)
    const classic: CrashSpec = { ...SPEC, enabled: false }
    for (let i = 0; i < Math.round(30 / FIXED_DT); i++) {
      stepAiRacer(off, buried, [], FIXED_DT, null, [FLAT], classic)
      stepAiRacer(on, buried, [], FIXED_DT, null, [FLAT], null)
    }
    expect(off.crash.count).toBe(0)
    expect(off.jet.body.position.x).toBe(on.jet.body.position.x)
    expect(off.jet.body.position.y).toBe(on.jet.body.position.y)
    expect(off.jet.body.position.z).toBe(on.jet.body.position.z)
  })

  it('does not hand one racer the other racer’s crash — trap 19', () => {
    // A dives into the plate; B is 400 m up chasing a gate in the sky. B must
    // never crash, never be held, never move to A's reset.
    const sky: Gate[] = [{ centre: v3(1500, 900, 0), radius: 22, points: 100, triggerOnce: true }]
    const a = createAiRacer(spec('a'), buried)
    const b = createAiRacer({ ...spec('b'), spawn: v3(1500, 900, -2000) }, sky)
    let aCrashes = 0
    for (let i = 0; i < Math.round(40 / FIXED_DT); i++) {
      stepAiRacer(a, buried, [], FIXED_DT, null, [FLAT], SPEC)
      stepAiRacer(b, sky, [], FIXED_DT, null, [FLAT], SPEC)
      if (a.crashEvent === 'crashed') aCrashes++
      expect(b.crashEvent).toBe('none')
      expect(crashHoldsShip(b.crash)).toBe(false)
    }
    expect(aCrashes).toBeGreaterThan(0)
    expect(b.crash.count).toBe(0)
    expect(b.jet.body.position.y).toBeGreaterThan(GROUND_Y + 300)
  })
})

// ── DEV-185: the reset misses the forest ──────────────────────────────────
//
// `planCrashReset` lifted over the TERRAIN and knew nothing else, and the
// authored line is certified against the terrain and nothing else. Measured on
// the real 1,241-collider Simonet forest, 10 m of `int_01`'s arc resets the
// ship inside palm #840 — that half is `crash-reset-clearance.test.ts`, which
// needs the R2 assets. This half is the MECHANISM, on a hand-built forest, and
// it runs everywhere.
//
// Every one of these is an A/B against `resetClearStepMetres: 0`, which is
// exactly what shipped: a reset that ends up clear is not evidence on its own,
// because most of the line is clear anyway.

/** The rule switched OFF: what shipped before DEV-185. */
const NO_WALK: CrashSpec = { ...SPEC, resetClearStepMetres: 0 }

/** The hull the game tests, and the one `planCrashReset` is handed. */
const HULL = HOVERJET_GROUND.collision.hull

/**
 * A forest of one capsule, standing on the line at arc length `s`.
 *
 * `radius` and `span` are given directly rather than through
 * `buildPropColliders`'s dims-times-scale, because what this file is about is
 * the SEARCH and not the sizing — `prop-ground.test.ts` owns the sizing, and
 * `crash-reset-clearance.test.ts` owns the real numbers.
 */
const trunkOnLine = (s: number, radius: number, span = 200): PropColliders => {
  const at = v3()
  routeAt(ROUTE, s, at)
  return {
    count: 1,
    x: Float32Array.from([at.x]),
    z: Float32Array.from([at.z]),
    bottom: Float32Array.from([at.y - span / 2]),
    top: Float32Array.from([at.y + span / 2]),
    radius: Float32Array.from([radius]),
    kind: ['palm'],
    broken: new Uint8Array(1),
    cellMetres: PROPS.cellMetres,
    cells: new Map([
      [
        // The hash key `buildPropColliders` would have written. Derived the same
        // way rather than hard-coded, so a change to the hash lands here.
        Math.floor(at.x / PROPS.cellMetres) * 73856093 +
          Math.floor(at.z / PROPS.cellMetres) * 19349663,
        [0],
      ],
    ]),
    // These trunks are 20-40 m wide against a 64 m cell, so the hash holds
    // them and DEV-187's direct list is empty. `prop-hash-reach.test.ts` is
    // where the other side of that split is exercised.
    oversized: [],
    // A trunk is a cylinder. DEV-213's convex hulls are the seventeen
    // hand-placed LANDMARKS and nothing else, so this forest has none.
    hulls: new Map(),
    // Nor DEV-345's triangles, which ride behind those hulls.
    meshes: new Map(),
  }
}

/** Where a reset planned from a crash at arc `s` lands, with and without a forest. */
const resetFor = (
  spec: CrashSpec,
  s: number,
  props: { colliders: PropColliders; hull: typeof HULL } | null,
) => {
  const { at, course } = onLine(s)
  const state = createCrash()
  planCrashReset(state, spec, body(at, v3()), course, [], props)
  return state.reset
}

describe('DEV-185: the crash reset misses the trees', () => {
  it('a trunk ON the reset point moves the reset BACK along the line, and only back', () => {
    // The crash at 3000 backs off to 3000 − 120 = 2880. Put a 20 m trunk there.
    const s0 = 3000 - SPEC.resetBackMetres
    const forest = { colliders: trunkOnLine(s0, 20), hull: HULL }

    const without = resetFor(NO_WALK, 3000, forest)
    expect(without.s).toBeCloseTo(s0, 6)
    expect(
      propPenetrationAt(without.position, without.orientation, HULL, forest.colliders),
      'the A half must actually be inside the trunk, or the B half proves nothing',
    ).toBeGreaterThan(0)

    const with_ = resetFor(SPEC, 3000, forest)
    expect(propPenetrationAt(with_.position, with_.orientation, HULL, forest.colliders)).toBe(0)
    // BACK along the arc, never forward: forward is ground the crash did not
    // cost you, and handing it over is a design change and not a fix.
    expect(with_.s).toBeLessThan(without.s)
    expect(with_.s).toBeGreaterThanOrEqual(s0 - SPEC.resetBackMetres)
    // Still ON the line, and still facing along it.
    expect(routeDistance(ROUTE, with_.position)).toBeLessThan(1)
    const tangent = routeTangentAt(ROUTE, with_.s)
    const nose = rotateVec3(v3(), with_.orientation, v3(0, 0, 1))
    const flat = Math.hypot(tangent.x, tangent.z)
    expect((nose.x * tangent.x + nose.z * tangent.z) / flat).toBeCloseTo(1, 6)
  })

  it('and it walks no further than it has to: one step is enough for a thin trunk', () => {
    const s0 = 3000 - SPEC.resetBackMetres
    // 5 m radius against a 1.02 m hull sphere: one 10 m step clears it.
    const forest = { colliders: trunkOnLine(s0, 5), hull: HULL }
    const reset = resetFor(SPEC, 3000, forest)
    expect(s0 - reset.s).toBeCloseTo(SPEC.resetClearStepMetres, 6)
  })

  it('a clear line is left EXACTLY where it was — the walk costs nothing when it is not needed', () => {
    // Same crash, same spec, a forest 2 km away. Every field of the reset has to
    // match the one the rule computed before DEV-185 existed, bit for bit: this
    // is the regression guard for every other test in this file.
    const far = { colliders: trunkOnLine(1000, 50), hull: HULL }
    const before = resetFor(NO_WALK, 3000, null)
    const after = resetFor(SPEC, 3000, far)
    expect(after.s).toBe(before.s)
    expect(after.position.x).toBe(before.position.x)
    expect(after.position.y).toBe(before.position.y)
    expect(after.position.z).toBe(before.position.z)
    expect(after.velocity.x).toBe(before.velocity.x)
    expect(after.velocity.z).toBe(before.velocity.z)
    expect(after.orientation.y).toBe(before.orientation.y)
    expect(after.orientation.w).toBe(before.orientation.w)
  })

  it('no colliders is Classic, and Classic plans the reset the way it always did', () => {
    // The `props` argument defaults to null, and null is not "a forest of
    // nothing" — it is the argument never being passed. Both spellings, because
    // `boot/app.ts` passes null and `ai-racer.ts` may pass nothing at all.
    const withNull = resetFor(SPEC, 3000, null)
    const { at, course } = onLine(3000)
    const omitted = createCrash()
    planCrashReset(omitted, SPEC, body(at, v3()), course, [])
    expect(withNull.s).toBe(omitted.reset.s)
    expect(withNull.position.y).toBe(omitted.reset.position.y)
  })

  it('a blocked stretch longer than the budget keeps the SHALLOWEST candidate, never a worse one', () => {
    // A 400 m trunk against a 120 m budget: nothing inside the walk is clear.
    // The rule is monotone — it may not return something deeper inside a tree
    // than the point `resetClearStepMetres: 0` would have chosen.
    const s0 = 3000 - SPEC.resetBackMetres
    const forest = { colliders: trunkOnLine(s0, 400), hull: HULL }
    const without = resetFor(NO_WALK, 3000, forest)
    const deepWithout = propPenetrationAt(
      without.position,
      without.orientation,
      HULL,
      forest.colliders,
    )
    const with_ = resetFor(SPEC, 3000, forest)
    const deepWith = propPenetrationAt(with_.position, with_.orientation, HULL, forest.colliders)
    expect(deepWithout).toBeGreaterThan(0)
    expect(deepWith).toBeGreaterThan(0)
    expect(deepWith).toBeLessThanOrEqual(deepWithout)
  })

  it('a BROKEN collider is not a tree: the reset walks through where it stood', () => {
    // The racers fell it on the lap before (DEV-147/DEV-180) and the player's
    // reset must not still be avoiding it. `broken` is the only difference.
    const s0 = 3000 - SPEC.resetBackMetres
    const standing = trunkOnLine(s0, 20)
    const felled = trunkOnLine(s0, 20)
    felled.broken[0] = 1
    expect(resetFor(SPEC, 3000, { colliders: standing, hull: HULL }).s).toBeLessThan(s0)
    expect(resetFor(SPEC, 3000, { colliders: felled, hull: HULL }).s).toBeCloseTo(s0, 6)
  })

  it('the walk runs through `stepCrash`, and a crash at the START of the line still resets', () => {
    // s0 is already 0 there, so there is no arc behind it to walk into. The
    // rule has to terminate and hand back the start rather than loop or throw —
    // and this is the one case DEV-126's `limitS` clamp makes common (see the
    // row's §4).
    const { at, course } = onLine(30)
    const forest = { colliders: trunkOnLine(0, 40), hull: HULL }
    const state = createCrash()
    const b = body(at, v3())
    expect(stepCrash(state, SPEC, b, 100, course, [], FIXED_DT, forest)).toBe('crashed')
    expect(state.reset.s).toBe(0)
  })

  it('the query and the CONTACT agree — the two are never two devices of our own', () => {
    // `propPenetrationAt` exists to predict what `stepPropCollision` will do.
    // If they ever disagree the reset avoids a tree the game does not have, or
    // stops avoiding one it does. Swept over the poses the planner produces on
    // the real line rather than over a synthetic grid, because those are the
    // poses that matter.
    const forest = trunkOnLine(2880, 30)
    const state = createCrash()
    let inside = 0
    let clear = 0
    for (let s = 2600; s <= 3100; s += 5) {
      const { at, course } = onLine(s)
      planCrashReset(state, NO_WALK, body(at, v3()), course, [], null)
      const predicted = propPenetrationAt(
        state.reset.position,
        state.reset.orientation,
        HULL,
        forest,
      )
      const probe = body(state.reset.position, v3())
      probe.orientation.x = state.reset.orientation.x
      probe.orientation.y = state.reset.orientation.y
      probe.orientation.z = state.reset.orientation.z
      probe.orientation.w = state.reset.orientation.w
      const contact = createPropCollision()
      const hits = stepPropCollision(contact, probe, HULL, forest, PROPS)
      expect(predicted > 0, `s=${s}: query says ${predicted}, contact says ${hits} hit(s)`).toBe(
        hits > 0,
      )
      if (hits > 0) inside++
      else clear++
    }
    // And the sweep has to contain both answers, or it agreed about nothing.
    expect(inside).toBeGreaterThan(0)
    expect(clear).toBeGreaterThan(0)
  })
})
