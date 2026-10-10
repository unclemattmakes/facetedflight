// tests/unit/route.test.ts — the authored racing line.
//
// Matt: *"i'd wonder if we could use that spline for autopilot helper info."*
//
// `CurvyClonePath` is a Curvy Splines path — 22 control points at granularity
// 20 — and the extractor resolves its `Approximation` arrays to 421 world-space
// points over 11.3 km. These tests are about the three facts that make it worth
// following, measured against the shipped data rather than asserted.

import { describe, expect, it } from 'vitest'
import { aircraftFor } from '@/content/load-aircraft'
import {
  boostedCruiseSpeed,
  createHoverJet,
  hoverJetView,
  noInput,
  speedProfileModel,
  stepHoverJet,
} from '@/sim/hoverjet'
import { v3 } from '@/sim/math/vec3'
import {
  advanceRoute,
  createRoute,
  createRouteCursor,
  routeArcLengthNear,
  routeAt,
  routeGuidance,
  speedLimitAt,
  withSpeedProfile,
} from '@/sim/route'
import int01 from '../../content/levels/int_01_hoverJet.json'

const ROUTE = createRoute(int01.route as number[][])
const RINGS = (int01.routes['0'] as { rings: { pos: number[]; trigger: { radius: number } }[] })
  .rings

describe('the shipped spline', () => {
  it('is 421 points over 11.3 km, and the gates sit ON it', () => {
    expect(ROUTE.count).toBe(421)
    expect(ROUTE.length).toBeGreaterThan(11_000)
    expect(ROUTE.length).toBeLessThan(11_500)
    // The number that makes it a racing line rather than a decoration. Measured
    // properly this is sub-metre; an earlier version of this file said 24.6 m,
    // which was distance to the nearest VERTEX of a 27 m-spaced polyline rather
    // than to the line, and a tuning constant got built on it.
    let worst = 0
    for (const r of RINGS) {
      const cursor = createRouteCursor()
      advanceRoute(
        ROUTE,
        cursor,
        v3(r.pos[0] as number, r.pos[1] as number, -(r.pos[2] as number)),
        ROUTE.count,
      )
      worst = Math.max(worst, cursor.offset)
    }
    expect(worst, `worst gate is ${worst.toFixed(1)} m off the line`).toBeLessThan(1)
  })

  it('mirrors z, because the sim is the render world flipped', () => {
    const first = int01.route[0] as number[]
    expect(ROUTE.points[0]).toBeCloseTo(first[0] as number, 3)
    expect(ROUTE.points[2]).toBeCloseTo(-(first[2] as number), 3)
  })

  it('reaches the gates IN ORDER along its arc length', () => {
    // If they did not, a lookahead capped at "the next gate" would cap at a
    // point behind the ship and the follower would stop dead.
    const arc = RINGS.map((r) =>
      routeArcLengthNear(ROUTE, v3(r.pos[0] as number, r.pos[1] as number, -(r.pos[2] as number))),
    )
    for (let i = 1; i < arc.length; i++) {
      expect(arc[i], `gate ${i} at ${arc[i]} vs gate ${i - 1} at ${arc[i - 1]}`).toBeGreaterThan(
        arc[i - 1] as number,
      )
    }
  })
})

describe('following it', () => {
  /** Walk a cursor up to an arc length the way a flying ship would. */
  const seek = (s: number) => {
    const cursor = createRouteCursor()
    for (let step = 0; step <= s; step += 200) advanceRoute(ROUTE, cursor, routeAt(ROUTE, step))
    advanceRoute(ROUTE, cursor, routeAt(ROUTE, s))
    return cursor
  }

  it('projects a point onto the line and reports how far off it is', () => {
    const cursor = seek(3000)
    expect(cursor.offset).toBeLessThan(0.5)
    expect(cursor.s).toBeCloseTo(3000, 0)
    // And off it. Measured from a cursor that is already there: a COLD cursor
    // searching the whole course finds a different leg only 66 m away, because
    // `int_01` doubles back on itself — which is the reason the search is
    // windowed and forward-only in the first place.
    //
    // The offset is a PERPENDICULAR distance, so lifting the ship 80 m straight
    // up off a climbing segment reads as `80 * cos(slope)` — 72 m here, on a
    // stretch pitched about 25 degrees. Asserting exactly 80 was an assumption
    // about the course, not a property of the code; this is the property.
    const on = routeAt(ROUTE, 3000)
    const near = createRouteCursor()
    const far = createRouteCursor()
    Object.assign(near, cursor)
    Object.assign(far, cursor)
    advanceRoute(ROUTE, near, v3(on.x, on.y + 80, on.z))
    advanceRoute(ROUTE, far, v3(on.x, on.y + 160, on.z))
    expect(near.offset).toBeGreaterThan(50)
    expect(near.offset).toBeLessThanOrEqual(80.001)
    // Twice the displacement is twice the offset, because it is a projection.
    expect(far.offset / near.offset).toBeGreaterThan(1.8)
    expect(far.offset / near.offset).toBeLessThan(2.2)
  })

  it('advances at most a WINDOW per call, which is the anti-teleport rule', () => {
    // A ship that gets lost must fly back rather than have its cursor jump to
    // the far side of the course. 40 segments at ~27 m is about a kilometre.
    const cold = createRouteCursor()
    advanceRoute(ROUTE, cold, routeAt(ROUTE, 6000))
    expect(cold.s).toBeLessThan(1500)
    expect(cold.offset, 'and it knows it is a long way off the line').toBeGreaterThan(100)
  })

  it('only ever moves FORWARD, or a doubled-back course skips half itself', () => {
    const cursor = seek(6000)
    const ahead = cursor.index
    expect(cursor.s).toBeCloseTo(6000, 0)
    // Now ask about a point near the START. It must not go back.
    advanceRoute(ROUTE, cursor, routeAt(ROUTE, 100), ROUTE.count)
    expect(cursor.index).toBeGreaterThanOrEqual(ahead)
  })

  it('aims AHEAD on the line, and further the faster you go', () => {
    const here = routeAt(ROUTE, 2000)
    const slow = seek(2000)
    const fast = seek(2000)
    const a = v3()
    const b = v3()
    routeGuidance(
      ROUTE,
      slow,
      here,
      {
        speed: 40,
        leadSeconds: 0.9,
        leadMinMetres: 60,
        gateS: Number.POSITIVE_INFINITY,
        fallback: here,
      },
      a,
    )
    routeGuidance(
      ROUTE,
      fast,
      here,
      {
        speed: 200,
        leadSeconds: 0.9,
        leadMinMetres: 60,
        gateS: Number.POSITIVE_INFINITY,
        fallback: here,
      },
      b,
    )
    expect(slow.s).toBeCloseTo(2000, 0)
    // Both ahead of the ship, the fast one further.
    const da = Math.hypot(a.x - here.x, a.y - here.y, a.z - here.z)
    const db = Math.hypot(b.x - here.x, b.y - here.y, b.z - here.z)
    expect(da).toBeGreaterThan(30)
    expect(db).toBeGreaterThan(da)
  })

  it('aims a LEAD ahead and does not cap at the gate', () => {
    // The cap is gone, and its removal is the point. The rings sit on the line
    // to within 0.4 m and are 513 m apart, so a 60-200 m lookahead never reaches
    // the next one — capping only bit on final approach, where it swapped the
    // lookahead for a point target and flattened the ship onto the rim. That is
    // exactly what `leadMetres` exists to prevent.
    const here = routeAt(ROUTE, 2000)
    const cursor = seek(2000)
    const aim = v3()
    const gateS = cursor.s + 30
    const onLine = routeGuidance(
      ROUTE,
      cursor,
      here,
      { speed: 200, leadSeconds: 0.9, leadMinMetres: 60, gateS: gateS, fallback: here },
      aim,
    )
    expect(onLine).toBe(true)
    const uncapped = routeAt(ROUTE, cursor.s + 200 * 0.9)
    expect(aim.x).toBeCloseTo(uncapped.x, 3)
    expect(aim.z).toBeCloseTo(uncapped.z, 3)
  })

  it('clamps at both ends rather than reading off the array', () => {
    const start = routeAt(ROUTE, -500)
    const end = routeAt(ROUTE, ROUTE.length + 5000)
    expect(start.x).toBeCloseTo(ROUTE.points[0] as number, 3)
    expect(end.x).toBeCloseTo(ROUTE.points[(ROUTE.count - 1) * 3] as number, 3)
  })

  it('refuses a path that is not one', () => {
    expect(() => createRoute([[0, 0, 0]])).toThrow(/not a path/)
  })
})

// ── The cap that stalled the run for nine seconds ─────────────────────────
//
// Capping the aim at the next gate's arc length is right until the ship passes
// that arc length WITHOUT scoring the ring — `int_01` gate 11 gets missed by
// about 47 m, well outside its 22.6 m trigger. Then the cap is BEHIND the
// cursor, the aim point sits behind the ship, and it turns back, overshoots and
// turns back again. Telemetry: cursor frozen at s = 5692 against a gate at
// 5647, for nine seconds, because a cursor cannot rewind.
describe('when the gate is behind on the line', () => {
  it('gives up on the line and aims at the RING', () => {
    const cursor = createRouteCursor()
    for (let step = 0; step <= 3000; step += 200) advanceRoute(ROUTE, cursor, routeAt(ROUTE, step))
    const here = routeAt(ROUTE, 3000)
    const ring = v3(here.x + 40, here.y - 30, here.z + 10)
    const aim = v3()
    // A gate whose arc length is BEHIND the cursor.
    const onLine = routeGuidance(
      ROUTE,
      cursor,
      here,
      { speed: 180, leadSeconds: 0.9, leadMinMetres: 60, gateS: cursor.s - 200, fallback: ring },
      aim,
    )
    expect(onLine).toBe(false)
    expect(aim.x).toBeCloseTo(ring.x, 6)
    expect(aim.y).toBeCloseTo(ring.y, 6)
    expect(aim.z).toBeCloseTo(ring.z, 6)
  })

  it('still follows the line when the gate is only just ahead', () => {
    const cursor = createRouteCursor()
    for (let step = 0; step <= 3000; step += 200) advanceRoute(ROUTE, cursor, routeAt(ROUTE, step))
    const here = routeAt(ROUTE, 3000)
    const aim = v3()
    const onLine = routeGuidance(
      ROUTE,
      cursor,
      here,
      { speed: 180, leadSeconds: 0.9, leadMinMetres: 60, gateS: cursor.s + 30, fallback: here },
      aim,
    )
    expect(onLine).toBe(true)
    // Ahead of the ship, not pulled back to the gate.
    expect(Math.hypot(aim.x - here.x, aim.y - here.y, aim.z - here.z)).toBeGreaterThan(100)
  })
})

// ── Cross-track: the term that took it from 12 gates to 17 ────────────────
//
// Pure pursuit alone cuts corners — it steers the chord to a point ahead, so the
// tighter the bend the further inside the line it flies. Measured at 25 m off at
// a gate with a 22.6 m trigger, which is a miss, and a monotonic cursor cannot
// rewind. Neither lookahead knob fixed it (0.45 s oscillates, so does
// curvature-scaling): both try to make the SAME aim point better.
//
// This adds a second term — displace the aim toward the line in proportion to
// how far off it the ship is. Zero on the line, which is what makes it safe.
describe('the cross-track term', () => {
  const at3000 = () => {
    const c = createRouteCursor()
    for (let step = 0; step <= 3000; step += 200) advanceRoute(ROUTE, c, routeAt(ROUTE, step))
    return c
  }

  it('does NOTHING when the ship is on the line', () => {
    // The property that makes it safe to leave on: it cannot cost anything on a
    // straight, because there is no error to correct.
    const on = routeAt(ROUTE, 3000)
    const a = v3()
    const b = v3()
    routeGuidance(
      ROUTE,
      at3000(),
      on,
      {
        speed: 180,
        leadSeconds: 0.9,
        leadMinMetres: 60,
        gateS: Number.POSITIVE_INFINITY,
        fallback: on,
        crossGain: 0,
      },
      a,
    )
    routeGuidance(
      ROUTE,
      at3000(),
      on,
      {
        speed: 180,
        leadSeconds: 0.9,
        leadMinMetres: 60,
        gateS: Number.POSITIVE_INFINITY,
        fallback: on,
        crossGain: 1,
      },
      b,
    )
    expect(b.x).toBeCloseTo(a.x, 4)
    expect(b.y).toBeCloseTo(a.y, 4)
    expect(b.z).toBeCloseTo(a.z, 4)
  })

  it('pulls the aim TOWARD the line when the ship is off it', () => {
    const on = routeAt(ROUTE, 3000)
    const off = v3(on.x, on.y + 60, on.z)
    const plain = v3()
    const corrected = v3()
    routeGuidance(
      ROUTE,
      at3000(),
      off,
      {
        speed: 180,
        leadSeconds: 0.9,
        leadMinMetres: 60,
        gateS: Number.POSITIVE_INFINITY,
        fallback: off,
        crossGain: 0,
      },
      plain,
    )
    routeGuidance(
      ROUTE,
      at3000(),
      off,
      {
        speed: 180,
        leadSeconds: 0.9,
        leadMinMetres: 60,
        gateS: Number.POSITIVE_INFINITY,
        fallback: off,
        crossGain: 0.5,
      },
      corrected,
    )
    // The ship is 60 m ABOVE the line, so the corrected aim must be lower.
    expect(corrected.y).toBeLessThan(plain.y)
  })

  it('scales with the error, so a big drift gets a big correction', () => {
    const on = routeAt(ROUTE, 3000)
    const near = v3(on.x, on.y + 20, on.z)
    const far = v3(on.x, on.y + 80, on.z)
    const a = v3()
    const b = v3()
    routeGuidance(
      ROUTE,
      at3000(),
      near,
      {
        speed: 180,
        leadSeconds: 0.9,
        leadMinMetres: 60,
        gateS: Number.POSITIVE_INFINITY,
        fallback: near,
        crossGain: 0.5,
      },
      a,
    )
    routeGuidance(
      ROUTE,
      at3000(),
      far,
      {
        speed: 180,
        leadSeconds: 0.9,
        leadMinMetres: 60,
        gateS: Number.POSITIVE_INFINITY,
        fallback: far,
        crossGain: 0.5,
      },
      b,
    )
    const nearPull = routeAt(ROUTE, 3000 + 162).y - a.y
    const farPull = routeAt(ROUTE, 3000 + 162).y - b.y
    expect(Math.abs(farPull)).toBeGreaterThan(Math.abs(nearPull))
  })
})

// ── `beyond`, and why corner braking needed it ────────────────────────────
//
// Corner braking measures the turn between "where I am going" and "where I go
// next". Under gate-to-gate aiming those are two rings. Under line-following the
// first is a LOOKAHEAD POINT, so pairing it with the next ring measures nothing
// — combining the two features silently stopped the controller slowing for the
// hairpin. A second point further along the line makes the pair consistent.
describe('the corner reference point', () => {
  it('is further along the line than the aim', () => {
    const cursor = createRouteCursor()
    for (let step = 0; step <= 2000; step += 200) advanceRoute(ROUTE, cursor, routeAt(ROUTE, step))
    const here = routeAt(ROUTE, 2000)
    const aim = v3()
    const beyond = v3()
    routeGuidance(
      ROUTE,
      cursor,
      here,
      {
        speed: 180,
        leadSeconds: 0.9,
        leadMinMetres: 60,
        gateS: Number.POSITIVE_INFINITY,
        fallback: here,
        beyond: beyond,
      },
      aim,
    )
    const dAim = Math.hypot(aim.x - here.x, aim.y - here.y, aim.z - here.z)
    const dBeyond = Math.hypot(beyond.x - here.x, beyond.y - here.y, beyond.z - here.z)
    expect(dBeyond).toBeGreaterThan(dAim)
  })

  it('is filled even when the follower GIVES UP, or it goes stale', () => {
    // The bail-out path returns the ring. If `beyond` kept last frame's value
    // the controller would brake for a corner it is no longer approaching.
    const cursor = createRouteCursor()
    for (let step = 0; step <= 2000; step += 200) advanceRoute(ROUTE, cursor, routeAt(ROUTE, step))
    const here = routeAt(ROUTE, 2000)
    const ring = v3(here.x + 40, here.y, here.z)
    const aim = v3()
    const beyond = v3(1e9, 1e9, 1e9)
    const onLine = routeGuidance(
      ROUTE,
      cursor,
      here,
      {
        speed: 180,
        leadSeconds: 0.9,
        leadMinMetres: 60,
        gateS: cursor.s - 200,
        fallback: ring,
        beyond: beyond,
      },
      aim,
    )
    expect(onLine).toBe(false)
    expect(beyond.x).toBeCloseTo(ring.x, 6)
  })
})

// ── The velocity profile: how racing games actually do this ───────────────
//
// Not a reactive "there is a corner, lift". A profile computed once in three
// passes and then looked up — curvature limit, BACKWARD braking pass, forward
// acceleration pass, take the min. The backward pass is the one that matters.
//
// DEV-394: its braking and acceleration are the JET's, off its sheet
// (`speedProfileModel`), and the tests below fly the jet to hold the model to
// the flight rather than restating its arithmetic. It used to assume 5.3 m/s^2
// of constant deceleration, which put the braking 1.6 km out; the flight model
// sheds 1.218 m/s every METRE with the throttle shut.
describe('the velocity profile', () => {
  const LAT = 162
  const SHEETS = aircraftFor('hoverjet').variants.map((v) => ({
    id: v.id,
    sheet: hoverJetView(v.scale),
  }))
  const STANDARD = hoverJetView({})
  const MODEL = speedProfileModel(STANDARD, LAT)
  const TOP = boostedCruiseSpeed(STANDARD)
  const profiled = () => withSpeedProfile(createRoute(int01.route as number[][]), MODEL)

  it('coasting sheds the same speed every METRE, and the model says how much', () => {
    // The measurement. A jet at its boosted terminal, flying straight down its
    // own nose, engine cold: Unity's drag multiplies the velocity every tick,
    // so the loss is linear in distance, not in time. Every variant.
    for (const { id, sheet } of SHEETS) {
      const jet = createHoverJet(sheet)
      jet.launched = true
      const v0 = boostedCruiseSpeed(sheet)
      jet.body.velocity.z = v0
      const input = noInput()
      const slopes: number[] = []
      let last = v0
      let lastZ = 0
      for (let tick = 1; tick <= 120; tick++) {
        stepHoverJet(jet, input)
        if (tick % 20 === 0) {
          slopes.push((last - jet.body.velocity.z) / (jet.body.position.z - lastZ))
          last = jet.body.velocity.z
          lastZ = jet.body.position.z
        }
      }
      const model = speedProfileModel(sheet, LAT)
      // The same slope at every speed, from the terminal down — and it is the
      // model's.
      for (const slope of slopes) expect(slope, id).toBeCloseTo(model.brakePerMetre, 9)
      // And it is nothing like the constant deceleration it replaced: 5.3 m/s^2
      // at 180 m/s is 0.03 m/s per metre, forty times too gentle.
      expect(model.brakePerMetre, id).toBeGreaterThan(1)
    }
  })

  it('never asks for more than the ship can do', () => {
    const r = profiled()
    for (const v of r.speedLimit as Float32Array) {
      expect(v).toBeGreaterThan(0)
      // 1e-3, not 1e-6: the profile is a Float32Array and 179.6 stores as
      // 179.60000610. A float32 tolerance is the honest one here.
      expect(v).toBeLessThanOrEqual(TOP + 1e-3)
    }
  })

  it('obeys the curvature limit at the tightest point', () => {
    // `v = sqrt(a_lat / k)` is the whole first pass.
    const r = profiled()
    let worstK = 0
    let at = 0
    for (let i = 0; i < r.count; i++) {
      if ((r.curvature[i] as number) > worstK) {
        worstK = r.curvature[i] as number
        at = i
      }
    }
    expect(worstK).toBeGreaterThan(0)
    expect((r.speedLimit as Float32Array)[at]).toBeLessThanOrEqual(Math.sqrt(LAT / worstK) + 1e-3)
  })

  it('BRAKES IN TIME — every point can be shed to the next by coasting', () => {
    // The property no local rule has. At each point the profile must be
    // reachable from the next one by the braking the flight model does.
    const r = profiled()
    const v = r.speedLimit as Float32Array
    for (let i = 0; i < r.count - 1; i++) {
      const ds = (r.cumulative[i + 1] as number) - (r.cumulative[i] as number)
      const canReach = (v[i + 1] as number) + MODEL.brakePerMetre * ds
      expect(v[i] as number, `point ${i} cannot slow to the next one`).toBeLessThanOrEqual(
        canReach + 1e-3,
      )
    }
  })

  it('and the braking starts at the corner, not a kilometre before it', () => {
    // Find the slowest point, then walk back to where the profile was still at
    // full speed. With 5.3 m/s^2 this was over 600 m; the jet sheds that speed
    // in a few dozen metres, and a profile that lifts a kilometre early is
    // just slow.
    const r = profiled()
    const v = r.speedLimit as Float32Array
    let slowest = 0
    for (let i = 1; i < r.count; i++) if ((v[i] as number) < (v[slowest] as number)) slowest = i
    expect(v[slowest] as number).toBeLessThan(TOP - 1)
    let i = slowest
    while (i > 0 && (v[i] as number) < TOP - 1) i--
    const runUp = (r.cumulative[slowest] as number) - (r.cumulative[i] as number)
    expect(runUp, `braking starts ${runUp.toFixed(0)} m out`).toBeLessThan(200)
  })

  it('does not ask for speed the ship cannot have BUILT UP — flown, not restated', () => {
    // The forward pass, held to a FLIGHT: from each point's profile speed, a
    // jet on full boosted thrust flown the next segment's length reaches at
    // least what the profile asks for there.
    const r = profiled()
    const v = r.speedLimit as Float32Array
    const input = { ...noInput(), throttle: 1, boost: true }
    for (let i = 1; i < r.count; i++) {
      const ds = (r.cumulative[i] as number) - (r.cumulative[i - 1] as number)
      const jet = createHoverJet(STANDARD)
      jet.launched = true
      jet.currentThrust = jet.tuning.maxSpeed * jet.tuning.boostMultiplier
      jet.body.velocity.z = v[i - 1] as number
      while (jet.body.position.z < ds) stepHoverJet(jet, input)
      expect(v[i] as number, `point ${i}`).toBeLessThanOrEqual(jet.body.velocity.z + 1e-2)
    }
  })

  it('asks for nothing at all where the ship out-turns the course', () => {
    // The other half of being principled: this course is mostly gentle, the ship
    // pulls 5 g, and a profile that slowed for straights would just be slow.
    const r = profiled()
    const full = [...(r.speedLimit as Float32Array)].filter((x) => x > TOP - 1).length
    expect(full / r.count, 'fraction of the line at full speed').toBeGreaterThan(0.8)
  })

  it('is Infinity when no profile has been built', () => {
    expect(speedLimitAt(createRoute(int01.route as number[][]), 3000)).toBe(
      Number.POSITIVE_INFINITY,
    )
  })
})
