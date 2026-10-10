// tests/unit/player-autopilot-hairpin.test.ts — the PLAYER's autopilot takes
// DEV-494's aim floor too. DEV-524.
//
// DEV-494 taught the AI racers to walk their aim out to `routeAimMinMetres`
// (30 m) where the line folds back: the arc lead alone puts the aim beside the
// ship there, or (in a racer's inside LANE) on it, `autopilotActions`'
// turn-reach law then asks for no speed, and a slow arrival parked half a lead
// short of the vertex for the race. Its row left the player's autopilot out:
// `boot/app.ts` built its own `routeGuidance` options and did not pass the
// floor. Matt, 2026-09-29: "fix the player's autopilot".
//
// The player's options now come from ONE function, `playerRouteOptions`
// (`sim/autopilot.ts`), which `boot/app.ts` calls and every flight below
// flies, so this file cannot drift from the game the way a copied options
// literal can (and two helpers had copied it: `autopilot-ride.test.ts` and
// `helpers/lesson-flight.ts`, which now call it too).
//
// ── What was found, stated so nobody re-derives it ─────────────────────────
//
// The player's proxy never PARKED at the fold. It flies the line, not a lane,
// and on the line the aim at a fold is on the OTHER leg, beside the ship,
// never on it; the ship turns toward it, crosses, and the forward-only cursor
// jumps to the leg it crossed onto. Searched under the old law: DEV-494's
// hairpin from 30 arrivals and the pad, and 5,880 synthetic V folds (120° to
// 178°, arriving 10-60 m short, 20 m either side, 0-30 m/s, six headings):
// no stall. What the old law did do is let the flown aim come in to 11.3 m
// of the ship at the fold (slow arrivals 30-50 m short), where the turn-reach
// law asks for a third of the speed it would at the floor; that is what the
// floor removes, and what goes red here without it. The time to ring 0 barely
// moves (the slowest arrival, the pad nose-away, 11.53 s -> 11.43 s).
//
// On the six shipped HoverJet lines the player's flown aim never comes nearer
// than 80 m, so the floor cannot bite there, and the laps are bit-identical.
//
// The course is DEV-494's: DEV-478's editor playtest, dumped from the running
// game (`fixtures/dev494-hairpin-course.json`). No terrain (the ground under
// the vertex is ~150 m down), so nothing here needs the gitignored maps.
//
// The loop is `boot/app.ts`'s autopilot block, tick for tick, minus the
// ground: the line while a ring is owed (and home on it where the line runs
// through the finish), `playerRouteOptions` off `DEFAULT_AUTOPILOT`, the
// cursor's offset as the trust, the point beyond as the corner reference, the
// velocity profile read `profileLookSeconds` ahead, and the jet handed to the
// speed law.

import { describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import { HOVERJET_LAT_ACCEL_MEASURED as SHIP_LAT_ACCEL } from '@/game/measured'
import { courseGates } from '@/game/mission'
import { threeQuatTupleToUnity, threeTupleToUnity } from '@/render/unity-space'
import { gateArcLengths, runIsOver } from '@/sim/ai-racer'
import {
  type AutopilotTuning,
  autopilotActions,
  DEFAULT_AUTOPILOT,
  nextGate,
  playerRouteOptions,
} from '@/sim/autopilot'
import { FIXED_DT } from '@/sim/constants'
import { createCourse, type Gate, seedCourse, stepCourse } from '@/sim/course'
import { createHoverJet, noInput, speedProfileModel, stepHoverJet } from '@/sim/hoverjet'
import { lookAlong } from '@/sim/math/quat'
import { type Vec3, v3 } from '@/sim/math/vec3'
import {
  advanceRoute,
  createRoute,
  createRouteCursor,
  type Route,
  routeArcThrough,
  routeGuidance,
  speedLimitAt,
  withSpeedProfile,
} from '@/sim/route'
import { chainGate } from '@/sim/speed-chain'
import adv01 from '../../content/levels/adv_01_hoverJet.json'
import adv02 from '../../content/levels/adv_02_hoverJet.json'
import int01 from '../../content/levels/int_01_hoverJet.json'
import int02 from '../../content/levels/int_02_hoverJet.json'
import rookie01 from '../../content/levels/rookie_01_hoverJet.json'
import rookie02 from '../../content/levels/rookie_02_hoverJet.json'
import hairpin from './fixtures/dev494-hairpin-course.json'
import { appSource } from './helpers/app-source'

type V = [number, number, number]

/** The law the player flew before DEV-524: everything the same, no floor. */
const OLD_LAW: AutopilotTuning = { ...DEFAULT_AUTOPILOT, routeAimMinMetres: 0 }
const FLOOR = DEFAULT_AUTOPILOT.routeAimMinMetres

interface Flown {
  readonly rings: number
  /** Seconds to ring 0, or NaN. */
  readonly firstRing: number
  /** The nearest the aim came to the ship, metres, on any tick it was on the line. */
  readonly nearestAim: number
  readonly finished: boolean
  /** Where it ended, rings and ticks: the bits two laws are compared on. */
  readonly bits: number[]
}

interface Start {
  readonly position: Vec3
  /** Unit heading, set with the nose along it. Absent: the orientation given. */
  readonly heading?: Vec3
  readonly orientation?: readonly number[]
  readonly speed: number
}

/**
 * The player's autopilot, as `boot/app.ts` flies it, over no ground, until
 * the finish or `seconds`. `stopAfterRing0` ends it at the first ring.
 */
const fly = (
  points: readonly (readonly number[])[],
  gates: readonly Gate[],
  finish: (Vec3 & { radius: number }) | null,
  start: Start,
  seconds: number,
  tuning: AutopilotTuning,
  stopAfterRing0 = false,
): Flown => {
  const route: Route = createRoute(points)
  const jet = createHoverJet()
  jet.launched = true
  withSpeedProfile(route, speedProfileModel(jet.sheet, SHIP_LAT_ACCEL))
  const gateArc = gateArcLengths(route, gates)
  const homeArc = finish ? routeArcThrough(route, finish, finish.radius) : Number.NaN
  const body = jet.body
  body.position.x = start.position.x
  body.position.y = start.position.y
  body.position.z = start.position.z
  if (start.heading) {
    lookAlong(body.orientation, start.heading)
    body.velocity.x = start.heading.x * start.speed
    body.velocity.y = start.heading.y * start.speed
    body.velocity.z = start.heading.z * start.speed
  } else if (start.orientation) {
    const [x, y, z, w] = start.orientation as [number, number, number, number]
    body.orientation.x = x
    body.orientation.y = y
    body.orientation.z = z
    body.orientation.w = w
  }
  const course = createCourse(gates)
  seedCourse(course, body.position)
  const cursor = createRouteCursor()
  advanceRoute(route, cursor, body.position)
  const aim = v3()
  const beyond = v3()
  const input = noInput()
  let firstRing = Number.NaN
  let nearestAim = Number.POSITIVE_INFINITY
  let finished = false
  let tick = 0
  for (; tick < Math.round(seconds / FIXED_DT) && !finished; tick++) {
    const v = body.velocity
    const speed = Math.hypot(v.x, v.y, v.z)
    const target = nextGate(gates, course.passed)
    const centre = target >= 0 ? (gates[target] as Gate).centre : finish
    if (!centre) break
    let at: Vec3 = centre
    let offset = Number.POSITIVE_INFINITY
    let cornerRef: Vec3 | null = target >= 0 ? (gates[target + 1]?.centre ?? finish) : null
    let want = Number.POSITIVE_INFINITY
    if (target >= 0 || Number.isFinite(homeArc)) {
      const onLine = routeGuidance(
        route,
        cursor,
        body.position,
        playerRouteOptions(
          tuning,
          speed,
          target >= 0 ? (gateArc[target] ?? Number.POSITIVE_INFINITY) : homeArc,
          centre,
          beyond,
        ),
        aim,
      )
      at = aim
      if (onLine) {
        offset = cursor.offset
        cornerRef = beyond
        want = speedLimitAt(route, cursor.s + speed * tuning.profileLookSeconds)
        const d = Math.hypot(
          aim.x - body.position.x,
          aim.y - body.position.y,
          aim.z - body.position.z,
        )
        if (d < nearestAim) nearestAim = d
      }
    }
    autopilotActions(body, at, input, tuning, [], offset, cornerRef, want, jet)
    stepHoverJet(jet, input)
    const ring = stepCourse(course, body.position)
    if (ring >= 0) chainGate(jet.chain)
    if (ring === 0 && Number.isNaN(firstRing)) {
      firstRing = (tick + 1) * FIXED_DT
      if (stopAfterRing0) break
    }
    finished = runIsOver(finish, body.position, course.passed)
  }
  const rings = course.passed.filter(Boolean).length
  return {
    rings,
    firstRing,
    nearestAim,
    finished,
    bits: [body.position.x, body.position.y, body.position.z, rings, tick],
  }
}

// ── DEV-494's hairpin ─────────────────────────────────────────────────────

const HAIRPIN_GATES: Gate[] = hairpin.gates.map((g) => ({
  centre: v3(...(g.centre as V)),
  radius: g.radius,
  points: 100,
  triggerOnce: true,
}))
const HAIRPIN_ROUTE = createRoute(hairpin.route as V[])
const point = (i: number): Vec3 =>
  v3(
    HAIRPIN_ROUTE.points[i * 3] as number,
    HAIRPIN_ROUTE.points[i * 3 + 1] as number,
    HAIRPIN_ROUTE.points[i * 3 + 2] as number,
  )
/** Point 0 is the ship on the pad, point 1 the vertex. */
const PAD = point(0)
const VERTEX = point(1)
const RUN = (() => {
  const n = Math.hypot(VERTEX.x - PAD.x, VERTEX.z - PAD.z)
  return v3((VERTEX.x - PAD.x) / n, 0, (VERTEX.z - PAD.z) / n)
})()

/**
 * Slow arrivals down the run-in, as DEV-494's racers were seeded: `back`
 * metres short of the vertex, `across` metres to one side, at `speed`; and
 * the pad itself, at rest, nose down the run-in and nose away from it.
 */
const STARTS: [label: string, start: Start][] = []
for (const back of [30, 40, 50]) {
  for (const across of [-12, -6, 0, 6, 12]) {
    for (const speed of [2, 10]) {
      STARTS.push([
        `${back} m short, ${across} m across, ${speed} m/s`,
        {
          position: v3(
            VERTEX.x - RUN.x * back + RUN.z * across,
            VERTEX.y,
            VERTEX.z - RUN.z * back - RUN.x * across,
          ),
          heading: RUN,
          speed,
        },
      ])
    }
  }
}
STARTS.push(['the pad, nose down the run-in', { position: PAD, heading: RUN, speed: 0 }])
STARTS.push(['the pad, nose away', { position: PAD, heading: v3(-RUN.x, 0, -RUN.z), speed: 0 }])

const hairpinFlight = (start: Start, tuning: AutopilotTuning): Flown =>
  fly(hairpin.route as V[], HAIRPIN_GATES, null, start, 20, tuning, true)

describe("DEV-524 — the player's autopilot takes DEV-494's aim floor", () => {
  it('its route options carry the floor, and boot/app.ts flies those options', () => {
    const opts = playerRouteOptions(DEFAULT_AUTOPILOT, 100, 500, v3(), null)
    expect(FLOOR, 'the floor is on').toBeGreaterThan(0)
    expect(opts.minAimMetres).toBe(FLOOR)
    // The game's call site, read as text: the autopilot block hands
    // `routeGuidance` the shared options and builds no literal of its own. A
    // literal would be free to leave the floor out again.
    const app = appSource()
    expect(app).toMatch(/playerRouteOptions\(\s*DEFAULT_AUTOPILOT,/)
    expect(app, 'a second, hand-built options literal').not.toMatch(
      /leadMinMetres:\s*DEFAULT_AUTOPILOT\.routeLeadMinMetres/,
    )
  })

  it('into the hairpin, the flown aim never comes nearer than the floor, and ring 0 is taken', () => {
    for (const [label, start] of STARTS) {
      const f = hairpinFlight(start, DEFAULT_AUTOPILOT)
      expect(f.nearestAim, `${label}: nearest aim`).toBeGreaterThanOrEqual(FLOOR - 1e-6)
      expect(f.rings, `${label}: ring 0`).toBe(1)
      expect(f.firstRing, label).toBeLessThan(15)
    }
  })

  it('the premise: without the floor the flown aim comes in under half the floor', () => {
    // If this ever goes green for the wrong reason (the course or the law moved
    // and the aim no longer folds in), the test above proves nothing.
    let nearest = Number.POSITIVE_INFINITY
    for (const [, start] of STARTS) {
      nearest = Math.min(nearest, hairpinFlight(start, OLD_LAW).nearestAim)
    }
    expect(nearest).toBeLessThan(FLOOR / 2)
  })

  it('and the finding: without the floor the player never PARKED here either', () => {
    // DEV-494's stall was a racer's inside lane, which folds the aim ONTO the
    // ship; the player flies the line. Recorded so the next reader does not
    // go looking for a player stall this course cannot produce.
    for (const [label, start] of STARTS) {
      const f = hairpinFlight(start, OLD_LAW)
      expect(f.rings, `${label}: ring 0 on the old law`).toBe(1)
    }
  })
})

describe('DEV-524 — the floor is inert on every shipped HoverJet line, for the player', () => {
  const MISSIONS = [adv01, adv02, int01, int02, rookie01, rookie02] as unknown as Level[]

  const flyMission = (level: Level, tuning: AutopilotTuning): Flown => {
    const f = level.finish
    const finish = f
      ? { x: f.pos[0] as number, y: f.pos[1] as number, z: -(f.pos[2] as number), radius: f.radius }
      : null
    const position = threeTupleToUnity(v3(), level.spawn.pos as number[])
    position.y += level.spawn.launch?.rise ?? 0
    const q = { x: 0, y: 0, z: 0, w: 1 }
    threeQuatTupleToUnity(q, level.spawn.quat as number[])
    return fly(
      level.route as V[],
      courseGates(level),
      finish,
      { position, orientation: [q.x, q.y, q.z, q.w], speed: 0 },
      level.timer.timeLimit,
      tuning,
    )
  }

  for (const level of MISSIONS) {
    it(`${level.id}: the same bits with the floor as without it, start to finish`, () => {
      expect(Array.isArray(level.route), 'the mission has a line').toBe(true)
      const floored = flyMission(level, DEFAULT_AUTOPILOT)
      expect(floored.finished, 'finished').toBe(true)
      // Why it is inert: the aim is never near the floor on a shipped line.
      expect(floored.nearestAim).toBeGreaterThan(2 * FLOOR)
      expect(floored.bits).toEqual(flyMission(level, OLD_LAW).bits)
    })
  }
})
