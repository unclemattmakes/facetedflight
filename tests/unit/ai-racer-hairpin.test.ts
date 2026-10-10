// tests/unit/ai-racer-hairpin.test.ts — a racer does not stop at a hairpin.
// DEV-494.
//
// DEV-478's editor playtest: a start pad on a hilltop behind the line makes
// the run-in from the pad meet the line's first point in a 140° hairpin, and
// racer 2 (`steady`) hung there, 404 m along and 6–9 m off the line, for the
// whole race, in three runs out of three, with no crash.
//
// The mechanism, as lines (`sim/route.ts`, "A lead along the line is not a
// lead in the air"): the aim is a point `lead` metres of ARC on, and where the
// line folds back that point lies beside the ship, and in the inside lane (an
// inside offset runs backwards through a corner sharper than itself) on it.
// `autopilotActions`' turn-reach law asks for the speed that can still make
// the aim, which scales with its distance, so the throttle closes; a ship that
// does not move does not move its cursor, so the aim never moves off it.
//
// The course is the playtest's own, dumped from the running game
// (`fixtures/dev494-hairpin-course.json`): its line, rings, finish and the
// five racers' starts. No terrain: the stall is in the air (the ground under
// the vertex is ~150 m down), and nothing here needs the gitignored maps.
//
// What is held:
//  1. The race itself. The five racers from their grid take every ring and
//     finish; under the old law (`routeAimMinMetres` 0) `steady` takes none
//     and stands at 404 m along, DEV-478's reading to the metre.
//  2. Slow arrivals in the inside lane, every tuning, round the vertex and
//     take ring 0; under the old law they all hang, half a lead short of it.
//  3. `routeGuidance` never aims nearer than the floor on the way into the
//     vertex, where without it the aim folds onto the ship.
//  4. The floor is inert on every shipped HoverJet line: five racers fly the
//     same bits with it as without it, start to finish.

import { describe, expect, it } from 'vitest'
import { type Edition, validateEdition } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import { courseGates } from '@/game/mission'
import { racerStarts } from '@/game/racer-grid'
import { assignTunings } from '@/game/racers'
import { threeQuatTupleToUnity, threeTupleToUnity } from '@/render/unity-space'
import {
  AI_RACER_TUNINGS,
  type AiRacer,
  createAiRacer,
  type FinishSphere,
  gateArcLengths,
  type RacerTraffic,
  stepAiRacer,
} from '@/sim/ai-racer'
import { type AutopilotTuning, DEFAULT_AUTOPILOT } from '@/sim/autopilot'
import { FIXED_DT } from '@/sim/constants'
import type { Gate } from '@/sim/course'
import { HOVERJET_CRAFT_VOLUME } from '@/sim/craft-contact'
import { lookAlong } from '@/sim/math/quat'
import { type Vec3, v3 } from '@/sim/math/vec3'
import { createRacerField, stepRacerField } from '@/sim/racer-field'
import {
  advanceRoute,
  createRoute,
  createRouteCursor,
  type Route,
  type RouteLane,
  routeGuidance,
} from '@/sim/route'
import anniversaryJson from '../../content/editions/anniversary.json'
import adv01 from '../../content/levels/adv_01_hoverJet.json'
import adv02 from '../../content/levels/adv_02_hoverJet.json'
import int01 from '../../content/levels/int_01_hoverJet.json'
import int02 from '../../content/levels/int_02_hoverJet.json'
import rookie01 from '../../content/levels/rookie_01_hoverJet.json'
import rookie02 from '../../content/levels/rookie_02_hoverJet.json'
import hairpin from './fixtures/dev494-hairpin-course.json'

type V = [number, number, number]
const E: Edition = validateEdition(anniversaryJson as unknown as Edition)
const SEPARATION = E.gameplay.racers.separation
const FIELD_RULES = {
  separation: SEPARATION,
  contact: E.gameplay.racers.contact,
  player: null,
  hit: null,
}

// ── The playtest's course ───────────────────────────────────────────────────

const ROUTE = createRoute(hairpin.route as V[])
const GATES: Gate[] = hairpin.gates.map((g) => ({
  centre: v3(...(g.centre as V)),
  radius: g.radius,
  points: 100,
  triggerOnce: true,
}))
const GUIDE = { route: ROUTE, gateArc: gateArcLengths(ROUTE, GATES) }
const FINISH: FinishSphere = {
  x: hairpin.finish.centre[0] as number,
  y: hairpin.finish.centre[1] as number,
  z: hairpin.finish.centre[2] as number,
  radius: hairpin.finish.radius,
}

/** Point `i` of the line, SIM space. Point 0 is the ship on the pad, point 1 the vertex. */
const at = (route: Route, i: number): Vec3 =>
  v3(
    route.points[i * 3] as number,
    route.points[i * 3 + 1] as number,
    route.points[i * 3 + 2] as number,
  )
const PAD = at(ROUTE, 0)
const VERTEX = at(ROUTE, 1)
const VERTEX_S = ROUTE.cumulative[1] as number
/** The run-in's horizontal direction, unit. */
const RUN = (() => {
  const n = Math.hypot(VERTEX.x - PAD.x, VERTEX.z - PAD.z)
  return v3((VERTEX.x - PAD.x) / n, 0, (VERTEX.z - PAD.z) / n)
})()

/** The turn at the vertex, degrees: the run-in against the line's first segment. */
const turnDegrees = (): number => {
  const a = at(ROUTE, 2)
  const ox = a.x - VERTEX.x
  const oz = a.z - VERTEX.z
  return (Math.acos((RUN.x * ox + RUN.z * oz) / Math.hypot(ox, oz)) * 180) / Math.PI
}

/**
 * The sign of the lane rank on the INSIDE of the hairpin. Right of a heading
 * (fx, fz) is (fz, -fx) in sim space (`routeRightAt`); the line turns toward
 * the side its next segment lies on.
 */
const insideSign = (): number => {
  const a = at(ROUTE, 2)
  return (a.x - VERTEX.x) * RUN.z + (a.z - VERTEX.z) * -RUN.x > 0 ? 1 : -1
}

const speedOf = (r: AiRacer): number =>
  Math.hypot(r.jet.body.velocity.x, r.jet.body.velocity.y, r.jet.body.velocity.z)

/** The playtest's five racers from their own starts, flown to the finish on aim floor `floor`. */
const race = (floor: number): AiRacer[] => {
  const racers = hairpin.racers.map((r) =>
    createAiRacer(
      {
        id: r.id,
        spawn: v3(...(r.spawn as V)),
        orientation: r.orientation,
        tuning: { ...(AI_RACER_TUNINGS[r.id] as AutopilotTuning), routeAimMinMetres: floor },
      },
      GATES,
      FINISH,
    ),
  )
  const field = createRacerField(racers, ROUTE)
  for (let t = 0; t < Math.round(150 / FIXED_DT) && !racers.every((r) => r.finished); t++) {
    stepRacerField(
      field,
      racers,
      GATES,
      [],
      FIXED_DT,
      GUIDE,
      [],
      E.gameplay.crash,
      null,
      FIELD_RULES,
    )
  }
  return racers
}

/**
 * One racer arriving at the vertex SLOWLY, in lane `rank`, as a racer does
 * that has turned round off a pad facing away from the line, or been pushed
 * wide: `back` metres short of the vertex on the run-in, heading down it at
 * `speed`. Its traffic is itself alone, so the lane is flown and nothing is
 * avoided.
 */
const arrive = (
  tuning: AutopilotTuning,
  rank: number,
  back: number,
  speed: number,
  seconds: number,
): { racer: AiRacer; took: number } => {
  const spawn = v3(VERTEX.x - RUN.x * back, VERTEX.y, VERTEX.z - RUN.z * back)
  const racer = createAiRacer({ id: 'r', spawn, orientation: [0, 0, 0, 1], tuning }, GATES)
  lookAlong(racer.jet.body.orientation, RUN)
  racer.jet.body.velocity.x = RUN.x * speed
  racer.jet.body.velocity.z = RUN.z * speed
  advanceRoute(ROUTE, racer.cursor, spawn)
  // Its lane, as `assignLanes` would give it off a grid, already eased in.
  racer.laneRank = rank
  racer.startLateral = rank * SEPARATION.laneSpacing
  const craft = [v3()]
  const traffic: RacerTraffic = {
    spec: SEPARATION,
    craft,
    ranks: [rank],
    count: 1,
    self: 0,
    widestRank: Math.abs(rank),
    hullRadius: HOVERJET_CRAFT_VOLUME.radius,
  }
  let t = 0
  for (; t < Math.round(seconds / FIXED_DT) && racer.gates < 1; t++) {
    const c = craft[0] as Vec3
    c.x = racer.jet.body.position.x
    c.y = racer.jet.body.position.y
    c.z = racer.jet.body.position.z
    stepAiRacer(racer, GATES, [], FIXED_DT, GUIDE, [], null, null, traffic)
  }
  return { racer, took: t * FIXED_DT }
}

/** Where a slow arrival starts, metres short of the vertex, and how fast. */
const ARRIVALS: [back: number, speed: number][] = [
  [30, 2],
  [40, 10],
  [50, 25],
]

describe('DEV-494 — a racer does not stop at a hairpin', () => {
  it('the course is the hairpin DEV-478 logged', () => {
    const turn = turnDegrees()
    expect(turn, `${turn.toFixed(1)}° at the first point`).toBeGreaterThan(135)
    expect(turn).toBeLessThan(150)
    // The run-in is the line's first segment, and ring 0 is a gap past the vertex.
    expect(VERTEX_S).toBeGreaterThan(400)
    expect((GUIDE.gateArc[0] as number) - VERTEX_S).toBeGreaterThan(400)
  })

  it('the five racers, from their own grid, take every ring and finish', () => {
    for (const r of race(DEFAULT_AUTOPILOT.routeAimMinMetres)) {
      expect(r.gates, `${r.spec.id} took ${r.gates} of ${GATES.length}`).toBe(GATES.length)
      expect(r.finished, `${r.spec.id} finished`).toBe(true)
    }
  })

  it("the premise: under the old law `steady` stands where DEV-478's racer 2 stood", () => {
    // The control. If this goes green for the wrong reason (the course or the
    // law moved and nothing hangs any more), the race above proves nothing.
    const racers = race(0)
    const steady = racers.find((r) => r.spec.id === 'steady') as AiRacer
    expect(steady.gates, 'steady took no ring').toBe(0)
    expect(speedOf(steady), 'steady is at a standstill').toBeLessThan(2)
    expect(
      Math.abs(steady.cursor.s - 404),
      `steady stands ${steady.cursor.s.toFixed(0)} m along`,
    ).toBeLessThan(5)
    for (const r of racers.filter((x) => x !== steady)) {
      expect(r.finished, `${r.spec.id} finished`).toBe(true)
    }
  })

  for (const [name, tuning] of Object.entries(AI_RACER_TUNINGS)) {
    it(`${name}, arriving slowly in the inside lane, rounds it and takes ring 0`, () => {
      for (const [back, speed] of ARRIVALS) {
        const { racer, took } = arrive(tuning, 2 * insideSign(), back, speed, 20)
        expect(
          racer.gates,
          `${back} m short at ${speed} m/s: ring 0 after ${took.toFixed(1)} s`,
        ).toBe(1)
        expect(took).toBeLessThan(15)
      }
    })
  }

  it('the premise: under the old law the same arrivals hang, half a lead short of the vertex', () => {
    const half = DEFAULT_AUTOPILOT.routeLeadMinMetres / 2
    for (const [name, tuning] of Object.entries(AI_RACER_TUNINGS)) {
      const { racer } = arrive({ ...tuning, routeAimMinMetres: 0 }, 2 * insideSign(), 30, 2, 20)
      const short = VERTEX_S - racer.cursor.s
      expect(racer.gates, `${name} took no ring`).toBe(0)
      expect(speedOf(racer), `${name} is at a standstill`).toBeLessThan(2)
      expect(Math.abs(short - half), `${name} stands ${short.toFixed(1)} m short`).toBeLessThan(10)
    }
  })

  it('routeGuidance never aims nearer than the floor on the way into the vertex', () => {
    const floor = DEFAULT_AUTOPILOT.routeAimMinMetres
    const aim = v3()
    // The line itself, and the inside lane (a fixed offset, as a lane is once
    // eased in and clear of a ring).
    const inside: RouteLane = { offsetAt: () => 2 * insideSign() * SEPARATION.laneSpacing }
    const nearestWithout = new Map<string, number>()
    for (const [label, lane] of [
      ['line', null],
      ['inside lane', inside],
    ] as const) {
      // Down the run-in at the slowest lead, into the vertex, and up to 16 m
      // either side of it.
      for (let back = 120; back >= 0; back--) {
        for (let across = -16; across <= 16; across += 2) {
          const p = v3(
            VERTEX.x - RUN.x * back + RUN.z * across,
            VERTEX.y,
            VERTEX.z - RUN.z * back - RUN.x * across,
          )
          for (const minAimMetres of [0, floor]) {
            routeGuidance(
              ROUTE,
              createRouteCursor(),
              p,
              {
                speed: 0,
                leadSeconds: DEFAULT_AUTOPILOT.routeLeadSeconds,
                leadMinMetres: DEFAULT_AUTOPILOT.routeLeadMinMetres,
                gateS: GUIDE.gateArc[0] as number,
                fallback: (GATES[0] as Gate).centre,
                crossGain: DEFAULT_AUTOPILOT.routeCrossGain,
                lane,
                minAimMetres,
              },
              aim,
            )
            const d = Math.hypot(aim.x - p.x, aim.y - p.y, aim.z - p.z)
            if (minAimMetres === 0) {
              nearestWithout.set(label, Math.min(nearestWithout.get(label) ?? Infinity, d))
            } else {
              expect(d, `${label}, ${back} m short, ${across} m across`).toBeGreaterThanOrEqual(
                floor - 1e-6,
              )
            }
          }
        }
      }
    }
    // The premise: the arc lead alone folds under the floor here on the line,
    // and onto the ship in the inside lane.
    expect(nearestWithout.get('line')).toBeLessThan(floor)
    expect(nearestWithout.get('inside lane')).toBeLessThan(floor / 4)
  })
})

describe('DEV-494 — the floor is inert on every shipped HoverJet line', () => {
  const MISSIONS = [adv01, adv02, int01, int02, rookie01, rookie02] as unknown as Level[]

  /**
   * The preset's grid on `level` (`racerStarts`, `assignTunings`), flown to
   * the finish through `stepRacerField` with the lanes, the contact and the
   * crash rule, every racer on aim floor `floor`. No terrain and no player.
   */
  const flyGrid = (level: Level, floor: number): AiRacer[] => {
    const gates = courseGates(level)
    const route = createRoute(level.route as V[])
    const guide = { route, gateArc: gateArcLengths(route, gates) }
    const starts = racerStarts(level, E.gameplay.racers)
    const assigned = assignTunings(starts)
    const racers = starts.map((start, i) => {
      const { id, tuning } = assigned[i] as { id: string; tuning: string }
      const spawn = threeTupleToUnity(v3(), [start.pos[0], start.pos[1], start.pos[2]])
      const q = { x: 0, y: 0, z: 0, w: 1 }
      threeQuatTupleToUnity(q, start.quat as unknown as number[])
      return createAiRacer(
        {
          id,
          spawn,
          orientation: [q.x, q.y, q.z, q.w],
          tuning: { ...(AI_RACER_TUNINGS[tuning] as AutopilotTuning), routeAimMinMetres: floor },
        },
        gates,
        level.finish
          ? {
              x: level.finish.pos[0] as number,
              y: level.finish.pos[1] as number,
              z: -(level.finish.pos[2] as number),
              radius: level.finish.radius,
            }
          : null,
      )
    })
    const field = createRacerField(racers, route)
    for (let t = 0; t < Math.round(240 / FIXED_DT) && !racers.every((r) => r.finished); t++) {
      stepRacerField(
        field,
        racers,
        gates,
        [],
        FIXED_DT,
        guide,
        [],
        E.gameplay.crash,
        null,
        FIELD_RULES,
      )
    }
    return racers
  }

  /** Where each racer ended, how many rings it took and when it finished. */
  const outcome = (racers: readonly AiRacer[]): number[] =>
    racers.flatMap((r) => [
      r.jet.body.position.x,
      r.jet.body.position.y,
      r.jet.body.position.z,
      r.gates,
      r.finishedAt,
    ])

  for (const level of MISSIONS) {
    it(`${level.id}: the same bits with the floor as without it, start to finish`, () => {
      expect(Array.isArray(level.route), 'the mission has a line').toBe(true)
      const floored = flyGrid(level, DEFAULT_AUTOPILOT.routeAimMinMetres)
      expect(
        floored.every((r) => r.finished),
        'every racer finished',
      ).toBe(true)
      expect(outcome(floored)).toEqual(outcome(flyGrid(level, 0)))
    })
  }
})
