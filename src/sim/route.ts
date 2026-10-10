// src/sim/route.ts — the authored racing line, as something you can follow.
//
// Matt: *"is there a bezier curve controlling gate positions or did just the
// gate positions come across? i'd wonder if we could use that spline for
// autopilot helper info or something."*
//
// There is, and it came across. `levelOffset/RingAttack_objects/CurvyClonePath`
// is a Curvy Splines path — 22 control points at granularity 20 — and the
// extractor already resolves its `Approximation` arrays to **421 world-space
// points over 11.3 km**, having MEASURED that they are world space rather than
// assuming it (`route._meta.space`).
//
// ── Why it is worth following, in three numbers ───────────────────────────
//
//   the gates sit ON it        max **0.4 m** from the line, evenly spaced at
//                              513 m of arc — they were cloned along it
//   it never enters terrain    min AGL 18 m, median 107 m, zero points below
//   but 23 % of it is LOW      98 of 421 points are under 60 m AGL
//
// That last one is the finding. `minClearance` is 60, so the line the course was
// designed around spends nearly a quarter of its length inside the autopilot's
// own danger threshold. The controller was not fighting a bad course; it was
// fighting a rule more conservative than the course.
//
// So the line is a better source of truth than a terrain probe: it is certified
// clear by construction, because 2016 flew it.
//
// ── Monotonic, deliberately ───────────────────────────────────────────────
//
// `advanceRoute` only ever searches FORWARD from where it last was. A course
// that doubles back near itself — and `int_01` does, twice — would otherwise let
// a nearest-point search snap to a later leg and skip half the gates. The cost
// is that a cursor cannot be rewound, which is why a respawn makes a new one.
//
// SIM LAYER: no three, no DOM, no wall clock, no allocation in the hot path.

import { FIXED_DT } from './constants'
import type { Gate } from './course'
import { type Vec3, v3 } from './math/vec3'

/** Module-level scratch. Valid only inside one synchronous call. */
const _nearest = v3()

export interface Route {
  /** x,y,z triples, SIM space. */
  readonly points: Float32Array
  readonly count: number
  /** Arc length from the start to each point. `cumulative[0]` is 0. */
  readonly cumulative: Float32Array
  /**
   * How hard the line turns at each point: radians of heading change per metre,
   * smoothed over a few segments. See `leadFor`.
   */
  readonly curvature: Float32Array
  /**
   * Target speed at each point, m/s. Null until `withSpeedProfile` is called.
   *
   * The standard racing-AI answer, and it is not what a reactive corner term
   * does. See `withSpeedProfile`.
   */
  speedLimit: Float32Array | null
  /** Total length, metres. */
  readonly length: number
}

/**
 * Build a route from THREE-space points, mirroring z into sim space.
 *
 * The flip lives here rather than at the call site for the same reason it lives
 * in `render/unity-space.ts` for everything else: one place, done once, tested.
 */
export const createRoute = (points: readonly (readonly number[])[]): Route => {
  const count = points.length
  if (count < 2) throw new Error(`route: ${count} point(s) is not a path`)
  const out = new Float32Array(count * 3)
  const cumulative = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const p = points[i] as readonly number[]
    out[i * 3] = p[0] as number
    out[i * 3 + 1] = p[1] as number
    // THREE -> SIM: the sim is the render world mirrored in z.
    out[i * 3 + 2] = -(p[2] as number)
    if (i > 0) {
      const dx = (out[i * 3] as number) - (out[(i - 1) * 3] as number)
      const dy = (out[i * 3 + 1] as number) - (out[(i - 1) * 3 + 1] as number)
      const dz = (out[i * 3 + 2] as number) - (out[(i - 1) * 3 + 2] as number)
      cumulative[i] = (cumulative[i - 1] as number) + Math.hypot(dx, dy, dz)
    }
  }
  // ── Curvature, because one lookahead distance cannot serve both ─────────
  //
  // A pure-pursuit follower cuts corners: it steers the chord to a point ahead,
  // so the tighter the bend the further inside the line it flies. Measured on
  // `int_01`, a 0.9 s lead at 225 m/s — 200 m — put the ship **25 m** off the
  // line as it crossed a gate's arc length, against a 22.6 m trigger. It missed
  // by two metres and spent seven seconds coming back, at gate after gate.
  //
  // Shortening the lead is not the answer either: 0.45 s oscillates, and cost
  // four gates a lap. Long is stable on a straight, short is accurate in a bend,
  // and the line itself says which is which.
  const curvature = new Float32Array(count)
  for (let i = 1; i < count - 1; i++) {
    const ax = (out[i * 3] as number) - (out[(i - 1) * 3] as number)
    const ay = (out[i * 3 + 1] as number) - (out[(i - 1) * 3 + 1] as number)
    const az = (out[i * 3 + 2] as number) - (out[(i - 1) * 3 + 2] as number)
    const bx = (out[(i + 1) * 3] as number) - (out[i * 3] as number)
    const by = (out[(i + 1) * 3 + 1] as number) - (out[i * 3 + 1] as number)
    const bz = (out[(i + 1) * 3 + 2] as number) - (out[i * 3 + 2] as number)
    const la = Math.hypot(ax, ay, az)
    const lb = Math.hypot(bx, by, bz)
    if (la < 1e-6 || lb < 1e-6) continue
    const cos = Math.max(-1, Math.min(1, (ax * bx + ay * by + az * bz) / (la * lb)))
    // Radians of heading change per metre of path.
    curvature[i] = Math.acos(cos) / ((la + lb) / 2)
  }
  // Smoothed, so one noisy vertex cannot pull the lead in on a straight.
  const smooth = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    let sum = 0
    let n = 0
    for (let j = Math.max(0, i - 2); j <= Math.min(count - 1, i + 2); j++) {
      sum += curvature[j] as number
      n++
    }
    smooth[i] = sum / n
  }
  return {
    points: out,
    count,
    cumulative,
    curvature: smooth,
    speedLimit: null,
    length: cumulative[count - 1] as number,
  }
}

/**
 * The lookahead to use at a point on the line, in metres.
 *
 * `base` on a straight, tapering toward `min` as the line bends. `gain` is in
 * metres per radian-per-metre, so it has the units the curvature does.
 */
export const leadFor = (
  route: Route,
  cursor: RouteCursor,
  base: number,
  min: number,
  gain: number,
): number => {
  // Look at the curvature AHEAD, not underfoot: by the time the ship is in the
  // bend it is too late to have shortened the lead.
  const ahead = Math.min(route.count - 1, cursor.index + 4)
  const k = route.curvature[ahead] as number
  return Math.max(min, base / (1 + gain * k))
}

/** Where a follower has got to. One per ship; never rewound. */
export interface RouteCursor {
  /** Index of the segment start. Only ever increases. */
  index: number
  /** Arc length of the closest point found. */
  s: number
  /** Metres from the line at that point. */
  offset: number
}

export const createRouteCursor = (): RouteCursor => ({ index: 0, s: 0, offset: 0 })

/**
 * Project a position onto the line, searching forward only.
 *
 * `window` bounds how far ahead it will look in one call, so a ship that gets
 * lost cannot jump to the far side of the course — it has to fly back. 40
 * segments at ~27 m each is about a kilometre, which is more than a second of
 * flight at any speed this game reaches.
 */
export const advanceRoute = (
  route: Route,
  cursor: RouteCursor,
  position: Vec3,
  window = 40,
): RouteCursor => {
  const last = Math.min(cursor.index + window, route.count - 2)
  let bestIndex = cursor.index
  let bestT = 0
  let bestDistSq = Number.POSITIVE_INFINITY
  for (let i = cursor.index; i <= last; i++) {
    const ax = route.points[i * 3] as number
    const ay = route.points[i * 3 + 1] as number
    const az = route.points[i * 3 + 2] as number
    const bx = route.points[(i + 1) * 3] as number
    const by = route.points[(i + 1) * 3 + 1] as number
    const bz = route.points[(i + 1) * 3 + 2] as number
    const ex = bx - ax
    const ey = by - ay
    const ez = bz - az
    const lenSq = ex * ex + ey * ey + ez * ez
    // Clamped to the segment: a projection that runs off the end belongs to the
    // next segment, which this loop reaches on its own.
    const t =
      lenSq > 0
        ? Math.max(
            0,
            Math.min(
              1,
              ((position.x - ax) * ex + (position.y - ay) * ey + (position.z - az) * ez) / lenSq,
            ),
          )
        : 0
    const cx = ax + ex * t - position.x
    const cy = ay + ey * t - position.y
    const cz = az + ez * t - position.z
    const distSq = cx * cx + cy * cy + cz * cz
    if (distSq < bestDistSq) {
      bestDistSq = distSq
      bestIndex = i
      bestT = t
    }
  }
  cursor.index = bestIndex
  cursor.offset = Math.sqrt(bestDistSq)
  const a = route.cumulative[bestIndex] as number
  const b = route.cumulative[bestIndex + 1] as number
  cursor.s = a + (b - a) * bestT
  return cursor
}

/** The point at arc length `s`, clamped to the ends. */
export const routeAt = (route: Route, s: number, out: Vec3 = v3()): Vec3 => {
  const clamped = Math.max(0, Math.min(route.length, s))
  // Linear scan from 0 would be O(n) per call; the cursor's index is a good
  // starting guess but `s` can be ahead of it, so bisect. 421 points is 9 steps.
  let lo = 0
  let hi = route.count - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if ((route.cumulative[mid] as number) <= clamped) lo = mid
    else hi = mid
  }
  const a = route.cumulative[lo] as number
  const b = route.cumulative[hi] as number
  const t = b > a ? (clamped - a) / (b - a) : 0
  out.x =
    (route.points[lo * 3] as number) +
    ((route.points[hi * 3] as number) - (route.points[lo * 3] as number)) * t
  out.y =
    (route.points[lo * 3 + 1] as number) +
    ((route.points[hi * 3 + 1] as number) - (route.points[lo * 3 + 1] as number)) * t
  out.z =
    (route.points[lo * 3 + 2] as number) +
    ((route.points[hi * 3 + 2] as number) - (route.points[lo * 3 + 2] as number)) * t
  return out
}

/**
 * Steer a follower: advance its cursor and produce an aim point.
 *
 * Takes an OPTIONS OBJECT, and that is not style. The positional version reached
 * thirteen parameters, six of them optional numbers, and the first three tests
 * written against it all passed the cross-track gain into `curveGain` — the slot
 * next door. Every one of them failed for a reason that had nothing to do with
 * what it was testing.
 *
 * Returns **true** when the aim is on the line and false when it has fallen back
 * to the gate itself, so the caller knows whether to trust `cursor.offset`.
 *
 * ── Why a point on the LINE and not the gate ──────────────────────────────
 *
 * Aiming at a gate centre makes the ship fly straight segments between rings and
 * overshoot every corner — which is the 186 m/s overshoot that put it into a
 * hillside at gate 6. A lookahead sliding along a smooth spline turns the same
 * controller into a pursuit follower, and it corners because the target corners.
 *
 * ── And why it has to be able to GIVE UP ──────────────────────────────────
 *
 * The aim is capped at the next gate's arc length: never aim past a ring you
 * still owe. That cap has a failure mode I shipped and then caught in telemetry.
 * A ship can pass the gate's arc length WITHOUT scoring — `int_01` gate 11 gets
 * missed by about 47 m, well outside its 22.6 m trigger — and then the cap is
 * BEHIND the cursor, so the aim point sits behind the ship. It turns back,
 * overshoots, turns back again. Nine seconds of that, cursor frozen at s = 5692
 * against a gate at 5647, because a cursor is monotonic and cannot rewind.
 *
 * So when the gate is behind on the line, the line has nothing useful left to
 * say and the follower aims at the RING instead. That is also the moment the
 * terrain rule should come back, which is what the return value is for.
 */
/** Everything `routeGuidance` needs beyond where the ship is. */
export interface RouteGuidanceOptions {
  /** Metres per second, for the speed-scaled lookahead. */
  readonly speed: number
  readonly leadSeconds: number
  readonly leadMinMetres: number
  /** Arc length of the next unscored gate, or Infinity. */
  readonly gateS: number
  /** Where to aim when the line has nothing useful to say: the ring. */
  readonly fallback: Vec3
  /** Arc length short of the gate at which the ring takes over. Usually 0. */
  readonly finalMetres?: number
  /** Metres of lookahead given up per radian-per-metre of curvature. */
  readonly curveGain?: number
  /** How hard the aim is pulled back toward the line, per metre off it. */
  readonly crossGain?: number
  /** Filled with a point a further lead along the line, for corner braking. */
  readonly beyond?: Vec3 | null
  /**
   * Fly a LANE rather than the line itself — DEV-364. Absent or null: the line,
   * exactly as before, which is what the player proxy and every Classic racer
   * get.
   */
  readonly lane?: RouteLane | null
  /**
   * The nearest the aim may be to the SHIP, in straight-line metres — DEV-494.
   * Absent or 0: no floor, exactly as before. The racers and (DEV-524, through
   * `playerRouteOptions`) the player's autopilot pass one. See "A lead along
   * the line is not a lead in the air" below.
   */
  readonly minAimMetres?: number
}

/**
 * A lateral offset off the line, as a function of arc length. DEV-364.
 *
 * Metres to the line's RIGHT (`routeRightAt`), negative for left. A function of
 * `s` rather than one number because a lane is not a constant: it narrows into
 * every ring and widens between them, and the three points `routeGuidance`
 * places — the aim, the corner reference beyond it and the cross-track
 * reference under the ship — sit at three different arc lengths.
 */
export interface RouteLane {
  offsetAt(s: number): number
}

/**
 * The horizontal heading at VERTEX `k`: the two segments that meet there,
 * each unit length, summed. At the two ends there is one segment. Written into
 * `out` as (x, z); not normalised — `routeRightAt` normalises the blend.
 */
const vertexHeading = (route: Route, k: number, out: { x: number; z: number }): void => {
  let x = 0
  let z = 0
  for (const i of [k - 1, k]) {
    if (i < 0 || i >= route.count - 1) continue
    const dx = (route.points[(i + 1) * 3] as number) - (route.points[i * 3] as number)
    const dz = (route.points[(i + 1) * 3 + 2] as number) - (route.points[i * 3 + 2] as number)
    const len = Math.hypot(dx, dz)
    if (len <= Number.EPSILON) continue
    x += dx / len
    z += dz / len
  }
  out.x = x
  out.z = z
}

/** Volatile: the two vertex headings `routeRightAt` blends. */
const _headA = { x: 0, z: 0 }
const _headB = { x: 0, z: 0 }

/**
 * The line's horizontal RIGHT at arc length `s`, unit length. DEV-364.
 *
 * Horizontal because a lane is laid across the course, not tilted with a climb.
 * In sim space (Unity's, left-handed, +y up) the right of a heading (fx, fz) is
 * (fz, -fx): a ship facing +z has +x on its right, the same frame
 * `autopilot.ts` measured its control signs in.
 *
 * BLENDED between the two vertices of the segment `s` is on, not the segment's
 * own direction — and that is measured, not taste. The line is 27 m segments,
 * so a segment's direction turns in steps at every vertex, and a lane laid off
 * it JUMPS sideways there by the lane's width times the step: 2-3 m at each of
 * a corner's vertices for a 12 m lane, six times a second at racing speed, all
 * of it fed straight into the aim point. Flown alone on `int_01`, the stepped
 * lane held `fast` a third worse than the line did. Blended, the lane is a
 * continuous curve. A vertical line has no horizontal right; it falls back to
 * +x, a direction, rather than dividing by zero.
 */
export const routeRightAt = (route: Route, s: number, out: Vec3 = v3()): Vec3 => {
  let i = routeSegmentAt(route, s)
  if (i >= route.count - 1) i = route.count - 2
  const a = route.cumulative[i] as number
  const b = route.cumulative[i + 1] as number
  const t = b > a ? Math.max(0, Math.min(1, (s - a) / (b - a))) : 0
  vertexHeading(route, i, _headA)
  vertexHeading(route, i + 1, _headB)
  const hx = _headA.x + (_headB.x - _headA.x) * t
  const hz = _headA.z + (_headB.z - _headA.z) * t
  const flat = Math.hypot(hx, hz)
  if (flat <= Number.EPSILON) {
    out.x = 1
    out.y = 0
    out.z = 0
    return out
  }
  out.x = hz / flat
  out.y = 0
  out.z = -hx / flat
  return out
}

/** Volatile: the right vector for `shiftAcross`. */
const _right = v3()

/** Move `out`, a point on the line at `s`, across the line by the lane's offset there. */
const shiftAcross = (route: Route, lane: RouteLane, s: number, out: Vec3): void => {
  const metres = lane.offsetAt(s)
  if (metres === 0) return
  routeRightAt(route, s, _right)
  out.x += _right.x * metres
  out.z += _right.z * metres
}

export const routeGuidance = (
  route: Route,
  cursor: RouteCursor,
  position: Vec3,
  opts: RouteGuidanceOptions,
  out: Vec3 = v3(),
): boolean => {
  const {
    speed,
    leadSeconds,
    leadMinMetres,
    gateS,
    fallback,
    finalMetres = 0,
    curveGain = 0,
    crossGain = 0,
    beyond = null,
    lane = null,
    minAimMetres = 0,
  } = opts
  advanceRoute(route, cursor, position)
  // ── The only case the line cannot help with ─────────────────────────────
  //
  // A cursor is monotonic, so once the ship passes a ring's arc length without
  // scoring it, the line has nothing left to say about getting back: every point
  // it can offer is further on. Then — and only then — the follower aims at the
  // RING, and the caller puts the terrain rule back because the ship is now
  // somewhere the authored path says nothing about.
  //
  // `finalMetres` is 0 by default and exists so this can be tuned; it was 90 for
  // a while on a measurement that turned out to be wrong. See `gateS` below.
  if (gateS <= cursor.s + finalMetres) {
    out.x = fallback.x
    out.y = fallback.y
    out.z = fallback.z
    // DEV-364: a lane aims at ITS point in the ring, not the ring's centre.
    // This branch is not only the missed-ring recovery: gate 0 sits at arc
    // length 0 on every shipped course, so it is also how every ship leaves
    // the grid — and aiming them all at one centre is a pile-up 100 m ahead of
    // the start. The lane is capped inside the ring, so its point scores.
    if (lane && Number.isFinite(gateS)) shiftAcross(route, lane, gateS, out)
    // Off the line's help, so the caller must not keep steering by a stale
    // `beyond` from the last frame.
    if (beyond) {
      beyond.x = out.x
      beyond.y = out.y
      beyond.z = out.z
    }
    return false
  }
  // NOT capped at the gate. The rings sit on the line to within **0.4 m** and are
  // evenly spaced 513 m apart, so a lookahead of 60-200 m never reaches the next
  // one — and capping it only bites on final approach, where it replaces the
  // lead with a point target and flattens the ship onto the rim. That is the
  // thing `leadMetres` was written to avoid in the first place.
  //
  // The cap came from a bad measurement of mine: "gates sit up to 24.6 m off the
  // line", which was distance to the nearest VERTEX of a polyline with 27 m
  // spacing, not distance to the line. Measured properly it is 0.4 m.
  const base = Math.max(leadMinMetres, speed * leadSeconds)
  const lead = Math.min(base, leadFor(route, cursor, base, leadMinMetres, curveGain))
  routeAt(route, cursor.s + lead, out)
  // DEV-364: a lane moves every point this places — the aim, the corner
  // reference and the cross-track reference — across the line by the lane's
  // offset AT THAT POINT, so the follower flies the lane with the same pursuit
  // and the same pull it flies the line with. `cursor.offset` stays the
  // distance to the LINE: that is what the caller's terrain trust asks about,
  // and the line, not the lane, is what 2016 certified clear.
  if (lane) shiftAcross(route, lane, cursor.s + lead, out)

  // ── Cross-track: pull the aim back toward the line ──────────────────────
  //
  // Pure pursuit alone cuts corners. It steers the chord to a point ahead, so
  // the tighter the bend the further inside the line it flies — measured at
  // **25 m** off at a gate with a **22.6 m** trigger, which is a miss, and a
  // monotonic cursor then cannot rewind. That cost seven seconds a gate.
  //
  // Neither lookahead knob fixes it: 0.45 s oscillates, and curvature-scaling
  // the lead oscillates at the one gain tried. Both are attempts to make the
  // SAME aim point better. This adds a second term instead — the standard
  // answer — by displacing the aim toward the line in proportion to how far off
  // it the ship actually is.
  //
  // Zero when on the line, so it cannot cost anything on a straight. That
  // property is what makes it safe to leave on.
  if (beyond) {
    routeAt(route, cursor.s + lead * 2, beyond)
    if (lane) shiftAcross(route, lane, cursor.s + lead * 2, beyond)
  }
  // With a lane the pull is toward the LANE, which is somewhere a ship exactly
  // on the line is not — so a zero `offset` no longer means there is nothing to
  // pull toward.
  let pullX = 0
  let pullY = 0
  let pullZ = 0
  if (crossGain > 0 && (cursor.offset > 0 || lane)) {
    routeAt(route, cursor.s, _nearest)
    if (lane) shiftAcross(route, lane, cursor.s, _nearest)
    pullX = (_nearest.x - position.x) * crossGain
    pullY = (_nearest.y - position.y) * crossGain
    pullZ = (_nearest.z - position.z) * crossGain
    out.x += pullX
    out.y += pullY
    out.z += pullZ
  }

  // ── A lead along the line is not a lead in the air (DEV-494) ────────────
  //
  // The lead is ARC LENGTH, and where the line doubles back the point `lead`
  // metres on lies beside the ship, or on it. A player course whose start pad
  // stands behind the line makes exactly that: the run-in from the pad meets
  // the line in a hairpin (140° on DEV-478's course), and on the approach to
  // its vertex the aim came in 76, 50, 18, 7, 1.9 m from the ship — in the
  // INSIDE lane, which runs backwards through a corner sharper than its own
  // offset, all the way onto it. `autopilotActions`' turn-reach law asks for
  // the speed that can still make the aim, its distance times the turn rate,
  // so the throttle closes. Carried through on momentum the ship recovers;
  // arriving slowly it stopped where the aim sat on it, about half the lead
  // short of the vertex, and a ship that does not move does not move its
  // cursor or, therefore, its aim. DEV-478's racer 2 hung there for the race.
  //
  // So, as textbook pure pursuit has it, the aim is also a DISTANCE: walked on
  // along the line until it is at least `minAimMetres` from the ship, each
  // step by the shortfall. Bounded by the line's end and by one step per point
  // it has, so a line that circles the ship inside the floor ends the walk
  // rather than the tick. Off a fold the chord to the aim is nearly the lead,
  // and a floor well under `leadMinMetres` does not move it: every shipped
  // HoverJet line flies the same bits either way
  // (`tests/unit/ai-racer-hairpin.test.ts`).
  if (minAimMetres > 0) {
    let aimS = cursor.s + lead
    let gap = Math.hypot(out.x - position.x, out.y - position.y, out.z - position.z)
    for (let k = 0; gap < minAimMetres && aimS < route.length && k < route.count; k++) {
      aimS = Math.min(route.length, aimS + (minAimMetres - gap))
      routeAt(route, aimS, out)
      if (lane) shiftAcross(route, lane, aimS, out)
      out.x += pullX
      out.y += pullY
      out.z += pullZ
      gap = Math.hypot(out.x - position.x, out.y - position.y, out.z - position.z)
    }
    // The corner reference stays a further lead past wherever the aim went.
    if (beyond && aimS > cursor.s + lead) {
      routeAt(route, aimS + lead, beyond)
      if (lane) shiftAcross(route, lane, aimS + lead, beyond)
    }
  }
  return true
}

/**
 * Arc length of the point on the line nearest a gate.
 *
 * Precomputed once per course: the gates sit ON the spline (max 0.4 m from it,
 * measured to the line, DEV-027; the 24.6 m once quoted here was the distance to
 * the nearest VERTEX and is retracted), so this is a lookup rather than an
 * approximation, and it is what lets `routeAim` refuse to aim past a ring it
 * has not taken.
 */
export const routeArcLengthNear = (route: Route, point: Vec3): number => {
  const cursor = createRouteCursor()
  advanceRoute(route, cursor, point, route.count)
  return cursor.s
}

/**
 * Each gate's arc length along the line, in gate order.
 *
 * Precomputed once per course. The gates sit ON the spline: max 0.4 m from it
 * (DEV-027; the "24.6 m" once quoted here was the distance to the nearest
 * VERTEX, and is retracted), against a 22.6 m trigger radius, so this is a
 * lookup rather than an approximation, and it is what lets the lookahead refuse
 * to run past a ring.
 *
 * Lives here, with the line it measures; `sim/ai-racer.ts` re-exports it for
 * the importers that predate the move (and `tools/content/leg-table.mjs`,
 * which loads it from there).
 */
export const gateArcLengths = (route: Route, gates: readonly Gate[]): number[] =>
  gates.map((g) => routeArcLengthNear(route, g.centre))

/**
 * The arc length at which the line passes through a sphere — the finish
 * gate's — or NaN when it does not. DEV-394.
 *
 * The line runs on past the last ring (1 km on `int_01`), and on three of the
 * six HoverJet Ring Attack courses it passes INSIDE the finish sphere:
 * `int_01`, `rookie_01` and `rookie_02`, 22.8, 28.9 and 44.3 m from the centre
 * against a 68.6 m radius. (`int_02`'s passes 76.7 m off, `adv_01`'s 178 and
 * `adv_02`'s 307.) Where it does, the run home can be flown on the line rather
 * than straight at the finish: `rookie_02`'s finish is 49° off the last leg
 * and 496 m below it, and flying straight at it cut the line's bend by
 * 120-160 m. O(count); call it once per course.
 */
export const routeArcThrough = (route: Route, centre: Vec3, radius: number): number => {
  const cursor = createRouteCursor()
  advanceRoute(route, cursor, centre, route.count)
  return cursor.offset <= radius ? cursor.s : Number.NaN
}

/**
 * The last segment index whose START lies at or before arc length `s`.
 * Bisection over `cumulative`; 421 points is 9 steps.
 */
export const routeSegmentAt = (route: Route, s: number): number => {
  const clamped = Math.max(0, Math.min(route.length, s))
  let lo = 0
  let hi = route.count - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if ((route.cumulative[mid] as number) <= clamped) lo = mid
    else hi = mid
  }
  return lo
}

/**
 * Arc length of the point on the line nearest `point`, searching only the part
 * of the line UP TO arc length `sMax`. DEV-126's crash reset.
 *
 * `routeArcLengthNear` searches the whole line, which is right for a gate that
 * sits on it and wrong for a ship that has left it: `int_01` doubles back on
 * itself twice, so a ship that crashed on leg 4 can be nearer to leg 9's line
 * than to its own, and a whole-line search would put it back nine gates ahead
 * of where it was. Bounding the search at the next unscored gate's arc length
 * keeps the answer on the leg being flown — the same fact the follower's
 * monotonic cursor encodes, used here as a static query.
 */
export const routeArcLengthNearWithin = (route: Route, point: Vec3, sMax: number): number => {
  const cursor = createRouteCursor()
  // `advanceRoute`'s window is a segment COUNT from the cursor's index, so the
  // last segment searched is `window` — the one whose start is at `sMax`.
  advanceRoute(route, cursor, point, Math.max(1, routeSegmentAt(route, sMax)))
  return cursor.s
}

/**
 * Put a follower's cursor at arc length `s`. The ONE way a cursor moves
 * backwards: a respawn or a crash reset, never the follower itself.
 *
 * `advanceRoute` is monotonic on purpose (see the header); a racer reset
 * 120 m behind where it hit would otherwise steer at a lookahead computed
 * from a cursor still sitting past the crash. Offset is left at 0 because the
 * reset puts the ship ON the line.
 */
export const rewindCursor = (route: Route, cursor: RouteCursor, s: number): RouteCursor => {
  const clamped = Math.max(0, Math.min(route.length, s))
  cursor.index = Math.min(route.count - 2, routeSegmentAt(route, clamped))
  cursor.s = clamped
  cursor.offset = 0
  return cursor
}

/**
 * The line's unit direction at arc length `s`: the direction of the segment
 * that contains it. Undefined on a zero-length segment, which `createRoute`'s
 * cumulative arc length makes impossible to land on except at the ends —
 * there it falls back to the neighbouring segment.
 */
export const routeTangentAt = (route: Route, s: number, out: Vec3 = v3()): Vec3 => {
  let i = routeSegmentAt(route, s)
  if (i >= route.count - 1) i = route.count - 2
  const dx = (route.points[(i + 1) * 3] as number) - (route.points[i * 3] as number)
  const dy = (route.points[(i + 1) * 3 + 1] as number) - (route.points[i * 3 + 1] as number)
  const dz = (route.points[(i + 1) * 3 + 2] as number) - (route.points[i * 3 + 2] as number)
  const len = Math.hypot(dx, dy, dz)
  if (len < 1e-9) {
    out.x = 0
    out.y = 0
    out.z = 1
    return out
  }
  out.x = dx / len
  out.y = dy / len
  out.z = dz / len
  return out
}

/**
 * Metres from the LINE to a point — not to the nearest control point.
 *
 * The distinction is the whole of DEV-027. *"The gates sit up to 24.6 m off the
 * racing line"* was distance to the nearest VERTEX of a polyline whose spacing
 * is 27 m; measured to the LINE it is **0.4 m**, and a tuning constant built on
 * the first number cost seven seconds a lap. So this reuses `advanceRoute`,
 * which projects onto each SEGMENT and clamps — the same arithmetic the
 * follower steers by, rather than a second copy of it — with a window of the
 * whole route, because a static query has no cursor to be monotonic about.
 *
 * O(count) per call. Fine for a placement pass run once at load; not for a
 * per-frame one.
 */
export const routeDistance = (route: Route, point: Vec3): number => {
  const cursor = createRouteCursor()
  advanceRoute(route, cursor, point, route.count)
  return cursor.offset
}

/**
 * What a velocity profile needs to know about the jet that will fly it.
 * Built off the jet's own sheet by `sim/hoverjet.ts`'s `speedProfileModel`
 * (DEV-394), so nothing here is typed.
 */
export interface SpeedProfileModel {
  /** The lateral acceleration the ship holds in a bend, m/s². */
  readonly latAccel: number
  /** Speed lost per metre flown with no thrust, (m/s)/m: constant under Unity's drag. */
  readonly brakePerMetre: number
  /** Full boosted thrust over mass, m/s², for the forward pass. */
  readonly thrustAccel: number
  /** Unity's linear drag, per second, for the forward pass. */
  readonly drag: number
  /** The top of the profile, m/s. */
  readonly topSpeed: number
}

/**
 * Speed after flying `ds` metres on full boosted thrust from `v`, m/s: the
 * fixed-step integrator's own recurrence (`rigidbody.ts`'s `integrate`), tick by
 * tick — `v ← (v + a·dt)(1 − drag·dt)`, `s += v·dt` — so the forward pass cannot
 * disagree with the flight model it stands for. Capped at `top`.
 */
const accelerateOver = (v0: number, ds: number, model: SpeedProfileModel, top: number): number => {
  const hold = 1 - model.drag * FIXED_DT
  let v = v0
  let s = 0
  while (s < ds && v < top) {
    v = (v + model.thrustAccel * FIXED_DT) * hold
    s += v * FIXED_DT
  }
  return v < top ? v : top
}

/**
 * A VELOCITY PROFILE along the line: how fast to be at every point.
 *
 * ── This is how racing games actually do it ───────────────────────────────
 *
 * Not a reactive "there is a corner ahead, lift". The standard is a profile
 * computed once, in three passes, and then simply looked up:
 *
 *   1. **Curvature limit.** `v = sqrt(a_lat / k)` — the fastest you can hold a
 *      bend of curvature `k` with `a_lat` of grip.
 *   2. **Backward pass.** Walk from the end to the start enforcing the most
 *      speed that can still be SHED before each point. This is the one that
 *      matters: a local rule can never do it, because by the time it sees the
 *      corner the braking distance is behind it.
 *   3. **Forward pass.** The same walk forward, so the profile does not ask for
 *      speed the ship cannot have built up yet.
 *
 * Then `v_feasible = min(forward, backward)` at every point.
 *
 * ── The braking is the FLIGHT MODEL's, measured (DEV-394) ─────────────────
 *
 * The textbook pass assumes a constant deceleration, `v² = u² + 2as`, and this
 * one used to: 5.3 m/s² at 180 m/s, so shedding 180 to 100 m/s took 2.1 km and
 * the profile asked for less than top speed over most of `int_01`. The flight
 * model does not brake like that. Unity's drag multiplies the velocity by
 * `1 − drag·dt` every tick, and a tick covers `v·dt` metres, so with the thrust
 * off the ship loses the SAME speed per METRE at any speed: `drag / (1 −
 * drag·dt)`, 1.218 m/s per metre on 2016's sheet. Flown with the throttle shut
 * from 179.6 m/s it sheds to 81 m/s in 125 m, the engine's half-second spool
 * down included, not in 2.1 km — the DEV-382 follow-up's measurement — and
 * `tests/unit/route.test.ts` holds a coasting flight to the per-metre rule on
 * every variant. So the backward pass is `v[i] = min(v[i], v[i+1] + brakePerMetre·ds)`,
 * linear in distance, and the forward pass is the integrator's own recurrence
 * under full boosted thrust.
 *
 * The ship still OUT-TURNS this course — a 99-degree corner between 513 m legs
 * wants about 215 m of radius and it has 136 — so where the curvature limit
 * does not bite, the profile correctly asks for nothing.
 */
export const withSpeedProfile = (route: Route, model: SpeedProfileModel): Route => {
  const n = route.count
  const v = new Float32Array(n)
  const top = model.topSpeed
  // 1. The curvature limit.
  for (let i = 0; i < n; i++) {
    const k = route.curvature[i] as number
    v[i] = k > 1e-9 ? Math.min(top, Math.sqrt(model.latAccel / k)) : top
  }
  // 2. Backward: can I shed it in time?
  for (let i = n - 2; i >= 0; i--) {
    const ds = (route.cumulative[i + 1] as number) - (route.cumulative[i] as number)
    const reachable = (v[i + 1] as number) + model.brakePerMetre * ds
    if (reachable < (v[i] as number)) v[i] = reachable
  }
  // 3. Forward: can I have got there?
  for (let i = 1; i < n; i++) {
    const ds = (route.cumulative[i] as number) - (route.cumulative[i - 1] as number)
    const reachable = accelerateOver(v[i - 1] as number, ds, model, top)
    if (reachable < (v[i] as number)) v[i] = reachable
  }
  route.speedLimit = v
  return route
}

/** The profile's target speed at an arc length, or Infinity if there is none. */
export const speedLimitAt = (route: Route, s: number): number => {
  if (!route.speedLimit) return Number.POSITIVE_INFINITY
  const clamped = Math.max(0, Math.min(route.length, s))
  let lo = 0
  let hi = route.count - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if ((route.cumulative[mid] as number) <= clamped) lo = mid
    else hi = mid
  }
  const a = route.cumulative[lo] as number
  const b = route.cumulative[hi] as number
  const t = b > a ? (clamped - a) / (b - a) : 0
  const va = route.speedLimit[lo] as number
  const vb = route.speedLimit[hi] as number
  return va + (vb - va) * t
}
