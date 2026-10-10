// src/sim/ai-racer.ts — opponents that FLY, rather than replay.
//
// Matt: *"let's simplify and deviate from 2016 by giving our ghosts the same
// autopilot logic we're using for the player proxy."*
//
// ── What this replaces, and what it costs ─────────────────────────────────
//
// The 2016 recordings. That is not a small thing — "against ghosts recorded in
// 2016" is one of the port's stated pillars — so it is DEV-026 and the replay
// path is kept behind `?opponents=ghosts` rather than deleted.
//
// What it buys is a race. A recording cannot respond to you and cannot be tuned.
// An AI racer flies the same flight model you do, from the same start, through
// the same gates.
//
// ── One line of DEV-026 does NOT survive measurement ──────────────────────
//
// *"on `int_01` it runs at roughly half the pace a boosted autopilot manages"*.
// Now that `sim/ghost.ts` can actually time a clip, that is wrong about the one
// that matters. Scored against the same gates and the same finish sphere:
//
//     int_01_leftSpawn_fast_01     57.3 s   18/21 rings   mean 185.2 m/s
//     int_01_rightSpawn_slow_01   102.4 s   21/21 rings   mean 102.9 m/s
//     AI `fast`                    68.1 s
//     AI `steady`                 121.9 s
//
// The 2016 quick run BEATS this file's quick racer by eleven seconds. It is the
// SLOW clip that is slow, and even that is 1.5x rather than 2x. The finding is
// insensitive to the one convention worth arguing about: keeping the recording's
// seven-second pad hold instead of skipping it (DEV-025) only moves the ghost to
// 64.7 s, still ahead.
//
// This does not undo the deviation — "cannot respond to you, cannot be tuned"
// was always the substance of it, and Matt's call stands — but the arithmetic
// justification for it is retired. `?opponents=ghosts` is a real race.
//
// (Not corrected in `docs/DEVIATIONS.md` from here; the ledger is Matt's.)
//
// ── Why each racer needs its OWN tuning ───────────────────────────────────
//
// Three identical controllers fly three identical lines and land on top of one
// another — a procession, not a race, and worse than what it replaced. So a
// racer carries an `AutopilotTuning` of its own and the differences are the
// whole point: a tighter lead makes a racer cut corners, a lower `minThrottle`
// and no boost makes it slower on the straights and better through the turns.
//
// SIM LAYER: no three, no DOM, no wall clock, no `Math.random()`.

import { HOVERJET } from '@/generated/constants.generated'
import { type AutopilotTuning, autopilotActions, DEFAULT_AUTOPILOT, nextGate } from './autopilot'
import { FIXED_DT } from './constants'
import { type CourseState, createCourse, type Gate, seedCourse, stepCourse } from './course'
import {
  type CrashCourse,
  type CrashEvent,
  type CrashSpec,
  type CrashState,
  crashHoldsShip,
  crashLimitS,
  createCrash,
  gatePolylineLine,
  stepCrash,
} from './crash'
import {
  boostedCruiseSpeed,
  createHoverJet,
  cruiseSpeed,
  type HoverJet,
  type HoverJetInput,
  type HoverJetSheet,
  noInput,
  stepHoverJet,
} from './hoverjet'
import {
  ARRIVED_WITHIN,
  arriveTarget,
  holdBeforeRing,
  type InstructorPace,
  latchHold,
  leadTarget,
  paceTuning,
  stepInstructorMode,
} from './instructor'
import { lookAlong } from './math/quat'
import { smooth01 } from './math/scalar'
import { distanceSq, type Vec3, v3 } from './math/vec3'
import {
  breakHeldProps,
  createPropCollision,
  type PropColliders,
  type PropCollisionSpec,
  type PropCollisionState,
  stepPropCollision,
} from './props/collision'
import {
  advanceRoute,
  createRouteCursor,
  type Route,
  type RouteCursor,
  type RouteLane,
  rewindCursor,
  routeArcLengthNear,
  routeAt,
  routeGuidance,
  routeRightAt,
  routeTangentAt,
  speedLimitAt,
} from './route'
import type { HeightField } from './terrain/height-field'
import {
  createGroundContact,
  createTerrainCollision,
  type GroundContactState,
  HOVERJET_GROUND,
  stepGroundContact,
} from './terrain-collision'

export interface AiRacerSpec {
  /** For logs and for the render layer to name its object. */
  readonly id: string
  /** Where it starts, SIM space — an AI pad. */
  readonly spawn: Vec3
  /** Starting orientation, xyzw. */
  readonly orientation: readonly number[]
  readonly tuning: AutopilotTuning
  /**
   * The racer's own colour, `#rrggbb` sRGB — DEV-350. The sim never reads it.
   * It is here for `id`'s reason: the spec is the one object every consumer of
   * a racer already holds, so the hull's livery, a minimap dot and a results
   * row can all agree on it. Null or absent: no colour was given (DEV-146's
   * traffic, and every sim test).
   */
  readonly colour?: string | null
  /**
   * What it is CALLED: a pool name drawn for the race (`content/callsigns.ts`,
   * DEV-651), as Matt wrote it (`lil bitey`); painters show it in capitals. On
   * the spec for `colour`'s reason: every board reads it from here. The sim
   * never reads it and `id` stays its identity (the engine map and the mesh's
   * name key on that). Null or absent: not named, and boards fall back to `id`.
   */
  readonly callsign?: string | null
  /**
   * The machine it flies: a view of the HoverJet sheet (DEV-382). Absent is
   * 2016's sheet itself, which is what every sim test and DEV-146's traffic
   * pass. Matt took AIRCRAFT-VARIANTS §6.4's recommendation, so in a race
   * `game/racers.ts` hands every racer the PLAYER's view: a race between the
   * same machines, and the variant a choice of style.
   *
   * On the spec rather than a fifth argument because the spec is what a reset
   * rebuilds from (`game/racers.ts`'s `reset` calls `createAiRacer(spec, …)`),
   * so a restarted racer cannot come back on 2016's sheet.
   */
  readonly sheet?: HoverJetSheet | undefined
}

export interface AiRacer {
  readonly spec: AiRacerSpec
  readonly jet: HoverJet
  readonly course: CourseState
  /** Where it is along the authored line. Never rewound; a respawn makes a new one. */
  readonly cursor: RouteCursor
  /**
   * Its own hover motor, its own contact state, its own resting angular drag.
   *
   * PER RACER, and that is trap 19 rather than tidiness: `TerrainCollisionState`
   * carries `flashFor` and `depth` across ticks, so one shared state would let
   * the racer that clipped a ridge hand its 0.3 s turn penalty — and its
   * "already touching, do not re-trigger" flag — to a racer three kilometres
   * away that never touched anything. Invisible with one racer, because there is
   * nobody to inherit from.
   */
  readonly ground: GroundContactState
  /** Seconds of racing so far. Starts when the player is released. */
  elapsed: number
  /** Gates taken. The only number a scoreboard needs. */
  gates: number
  /** True once every gate is taken. */
  finished: boolean
  finishedAt: number
  /**
   * Where this racer's run ENDS. Null falls back to "every gate passed".
   *
   * The player's run ends at the finish gate (DEV-045), and the results panel
   * puts the racers' times next to the player's — so a racer that stopped at
   * the last ring was being timed over a course 234.6 m shorter than the one
   * the player flew, and every opponent time on that panel flattered the AI.
   */
  finish: FinishSphere | null
  /**
   * The altitude it flies out at, latched the tick it finished.
   *
   * A SETPOINT, not a reading. Aiming at the racer's live `position.y` makes
   * the reference track the state, which is an integrator with nothing
   * absolute to pull against: measured in the running game it climbed 1.3 m/s
   * for as long as it was watched. Latching one number turns that back into a
   * regulator. Meaningless until `finished`.
   */
  holdAltitude: number
  /**
   * Its own crash state (DEV-126). PER RACER — trap 19 again: `heldFor` and
   * the planned reset pose persist across ticks, and a shared one would put
   * the racer that hit a ridge back where a different racer crashed.
   */
  readonly crash: CrashState
  /**
   * The course it is put back on when it has no authored line: the polyline
   * through the gate centres from its own start. Built once. When a `guide`
   * is handed to `stepAiRacer` the guide's route is used instead.
   */
  readonly fallbackCourse: { readonly route: Route; readonly gateArc: readonly number[] }
  /** What the last step's crash rule said. `none` on any tick without one. */
  crashEvent: CrashEvent
  /**
   * Its own prop contacts (DEV-147). PER RACER — trap 19 for the third time in
   * this file: `hits` is an array the renderer reads after the step and
   * `brokenCount` is a running total, so one shared state would hand a racer's
   * broken tree to the racer stepped after it and draw the pieces twice.
   *
   * The COLLIDERS are shared with the player on purpose: one forest, and a
   * tree a racer knocks down is down for everybody.
   */
  readonly props: PropCollisionState
  /**
   * Seconds of UNBROKEN contact with the forest, for DEV-180's escape.
   *
   * PER RACER, and trap 19 for the fourth time in this file: it is a running
   * total across ticks, so one shared counter would have the racer resting on
   * a palm break a tree under a racer three kilometres away — and would have
   * the busy one reset by every tick its neighbour spent in clear air, which
   * is the failure that hides, because with one racer there is nobody to be
   * reset by. Cleared by a crash reset and by `game/racers.ts`'s `reset`.
   */
  propStuckFor: number
  /**
   * Its LANE, in units of `laneSpacing` off the line: 0 is the line, negative
   * left, positive right. DEV-364. Set once, by `assignLanes`, from where the
   * grid stood it; 0 until then, which is the line every racer flew before.
   * A rank rather than metres so the preset's spacing is followed live.
   */
  laneRank: number
  /**
   * Metres off the line where it STOOD, right positive — its grid slot seen
   * from the line. DEV-364. The lane eases in from here after gate 0, so a
   * racer leaves the grid on the line its pad points it down rather than
   * swerving for its lane on the first tick.
   */
  startLateral: number
  /**
   * The avoidance offset it steered by on the last tick, metres right. A
   * READING (DEV-364): written by `stepAiRacer`, read by tests and probes,
   * never fed back. Per racer, for trap 19's reason.
   */
  avoid: number
  /**
   * The flight instructor's pace and wait (DEV-376, `sim/instructor.ts`), or
   * null for every racer that is not one — which is every racer in every race.
   * Set at creation. Null reaches none of the instructor's code: `stepAiRacer`
   * then passes the tuning and the target speed it always passed.
   *
   * A caller that RESETS a racer by copying a fresh one's fields over it
   * (`game/racers.ts`'s `reset`) must reset this too, or the new run starts
   * in the last one's HOLD.
   */
  readonly pace: InstructorPace | null
}

/**
 * `gameplay.racers.separation`, as the sim reads it. DEV-364. Every number is
 * the preset's; `sim/` types none of them.
 */
export interface RacerSeparationSpec {
  readonly enabled: boolean
  /** Metres between neighbouring lanes. */
  readonly laneSpacing: number
  /** Metres of arc after gate 0 over which a racer moves from where it stood to its lane. */
  readonly laneEaseMetres: number
  /** 0..1: how much of a ring's radius the lanes, plus a hull, may use AT the ring. */
  readonly gateFraction: number
  /** Metres of lateral room regained per metre of arc away from a ring: the funnel's slope. */
  readonly gateFunnel: number
  /** Metres along the course, ahead or behind, inside which another craft is avoided. */
  readonly avoidReach: number
  /** Metres off its own track inside which another craft is avoided. */
  readonly avoidClearance: number
  /** Metres the lane moves at full avoidance weight. */
  readonly avoidGain: number
}

/**
 * What one racer sees of the others on one tick. DEV-364.
 *
 * `craft` is every ship's position at the START of the tick — the racers in
 * racer order, then anybody else sharing the air (the player) — so each racer
 * steers off the same picture whichever order they are stepped in. A racer that
 * read its neighbours' LIVE bodies would see the ones stepped before it a tick
 * ahead of the ones stepped after it, and racer 0 and racer 4 would fly by
 * different rules.
 */
export interface RacerTraffic {
  /** The live preset's rule. */
  spec: RacerSeparationSpec
  /** Positions at the start of the tick. Only the first `count` are live. */
  readonly craft: readonly Vec3[]
  /** Each craft's `laneRank`, the same order. A craft that holds no lane (the player) is 0. */
  readonly ranks: readonly number[]
  count: number
  /** This racer's index in `craft`. Volatile: the caller writes it before each racer. */
  self: number
  /** The field's widest `|laneRank|`, for narrowing every lane together at a ring. */
  readonly widestRank: number
  /** Half a hull's beam, metres — the room a ship takes up either side of its lane. */
  readonly hullRadius: number
}

/**
 * Five opponents, deliberately unlike each other and unlike the player.
 *
 * The first two names come from the 2016 clips they replace — `leftSpawn_fast`
 * and `rightSpawn_slow` — because the pads they start on are the same two, and
 * because "one quick one, one steady one" was already the shape of the race.
 * The other three are DEV-125's (Matt: *"add 3 more racers to the hover
 * jet"*), and how many of them fly is CONTENT: `gameplay.racers` in the edition
 * preset lists the grid slots, and `game/racers.ts` hands these out in this
 * order to whatever the grid has room for. Classic's grid is 2016's two pads,
 * so Classic flies the first two and never reads the rest.
 *
 * `DEFAULT_AUTOPILOT` is the PLAYER proxy's tuning and none of these is it.
 * A racer that matched it exactly would fly the player's line to the metre.
 *
 * Measured on `int_01`, no terrain, headless (`tests/unit/ai-racer.test.ts`
 * prints the table): the five finish spread across the run rather than as a
 * bunch, which is the property the tunings exist for.
 */
export const AI_RACER_TUNINGS: Readonly<Record<string, AutopilotTuning>> = {
  // Cuts corners: aims closer to the gate so it turns later and harder.
  fast: { ...DEFAULT_AUTOPILOT, leadMetres: 34, bankRatio: 0.64, maxBank: 0.8 },
  // Runs wide and does not boost. Slower down a straight, tidier through a turn,
  // and it gives the two of them visibly different lines rather than a stagger.
  steady: {
    ...DEFAULT_AUTOPILOT,
    leadMetres: 62,
    bankRatio: 0.48,
    minThrottle: 0.5,
    boost: false,
  },
  // ── DEV-125's three ─────────────────────────────────────────────────────
  //
  // `boost` doubles thrust and nothing else here changes how fast an ALIGNED
  // ship goes, so the two above finish at 66.7 s and 119.7 s and a third could
  // only join one of them: the first three candidates for `cutter` landed
  // within 0.4 s of `fast` and 6 m of its line. `maxThrottle` is the lever that
  // puts a racer BETWEEN the two speeds — see `AutopilotTuning.maxThrottle` —
  // and the three caps below were chosen off the measured table:
  //
  //     cap 1.00  66.7 s (fast)    cap 0.85  74.6 s    cap 0.72  ~85 s
  //     cap 0.60 100.0 s           no boost 119.7 s (steady)
  //
  // Tightest line of the five and the hardest bank, a shade off full power. The
  // one the player has to catch, and the likeliest to clip a ridge doing it.
  cutter: {
    ...DEFAULT_AUTOPILOT,
    leadMetres: 26,
    bankRatio: 0.72,
    maxBank: 0.88,
    maxThrottle: 0.85,
  },
  // Wide: a long lookahead and a shallow bank, so it swings out through the
  // corners; three-quarter power. Mid-pack.
  wide: {
    ...DEFAULT_AUTOPILOT,
    leadMetres: 80,
    bankRatio: 0.42,
    maxBank: 0.6,
    minThrottle: 0.6,
    maxThrottle: 0.72,
  },
  // Boosted but well throttled back: quicker than `steady`, slower than the
  // rest. The one you pass first.
  cruiser: {
    ...DEFAULT_AUTOPILOT,
    leadMetres: 50,
    bankRatio: 0.55,
    minThrottle: 0.5,
    maxThrottle: 0.6,
  },
}

/**
 * The finish gate, in SIM space. Null for a course that has none.
 *
 * A sphere, because 2016's is three SphereColliders and the biggest one is what
 * a ship actually hits — see `content/level-schema.ts` `FinishGate`.
 */
export interface FinishSphere {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly radius: number
}

export const createAiRacer = (
  spec: AiRacerSpec,
  gates: readonly Gate[],
  finish: FinishSphere | null = null,
  /** DEV-376: an instructor's pace (`createInstructorPace`), or null for a racer. */
  pace: InstructorPace | null = null,
): AiRacer => {
  // The race's view (DEV-382), or 2016's sheet when the spec names none.
  const jet = createHoverJet(spec.sheet)
  jet.body.position.x = spec.spawn.x
  jet.body.position.y = spec.spawn.y
  jet.body.position.z = spec.spawn.z
  jet.body.orientation.x = spec.orientation[0] as number
  jet.body.orientation.y = spec.orientation[1] as number
  jet.body.orientation.z = spec.orientation[2] as number
  jet.body.orientation.w = spec.orientation[3] as number
  // Launched, exactly as `LaunchElevator.FinishLaunch()` leaves the player: an
  // unlaunched HoverJet has gravity on and drops off its pad.
  jet.launched = true
  // The gate polyline, for a crash reset on a course with no authored line. On
  // that line gate i is point i+1, so its arc length is `cumulative[i+1]`.
  const fallbackCourse = gatePolylineLine(spec.spawn, gates)
  // A racer is PLACED on its pad, which is a teleport like any other: a gate it
  // starts inside is a gate it is already in, not one it flew through (DEV-149,
  // and `stepMission` does the same on its first tick). No shipped pad is
  // inside a ring, so this changes nothing today and cannot go wrong tomorrow.
  const course = createCourse(gates)
  seedCourse(course, spec.spawn)
  return {
    spec,
    jet,
    course,
    finish,
    cursor: createRouteCursor(),
    // The resting angular drag is the sheet's, read off this racer's own fresh
    // body — not a constant, so a retuned prefab moves both ships together.
    ground: createGroundContact(jet.body.angularDrag),
    elapsed: 0,
    gates: 0,
    finished: false,
    finishedAt: 0,
    holdAltitude: 0,
    crash: createCrash(),
    fallbackCourse,
    crashEvent: 'none',
    props: createPropCollision(),
    propStuckFor: 0,
    laneRank: 0,
    startLateral: 0,
    avoid: 0,
    pace,
  }
}

// ── DEV-364: lanes, and keeping out of each other's way ─────────────────────
//
// Matt, 2026-09-24: *"right now our ai racers tend to converge on the same path
// - can you have them avoid each other."*
//
// They converge because there is ONE line. `routeGuidance` aims every racer at
// a point on the same spline and its cross-track term pulls every racer back
// onto it; the five tunings differ in lead, bank and throttle, which is pace,
// and change the path by a few metres of corner-cutting. Measured on `int_01`
// over the real Simonet ground: 4.3 m of mean lateral difference between two
// racers at the same arc length, pairs down to 0.15 m apart — through each
// other — and 2.0 m on `rookie_01`. The grid's 13-16 m spread is gone by gate 0.
//
// So each racer flies a LANE: the line moved sideways by a fixed offset. The
// lanes come from the grid — ranked by where each racer stood across the line,
// spaced evenly about it — so nobody crosses anybody to reach theirs. Every
// lane narrows into every ring, together, so the pack threads the ring rather
// than its outer racers clipping it, and widens again between rings. On top of
// the lane, a racer steers off any other craft close AHEAD on its track or
// alongside it, and comes back to its lane when the air clears. What comes up
// behind it is the other pilot's to avoid — which is what lets the player
// catch one and push it.

/**
 * The fastest a racer closes on a ring, m/s: 2016's HoverJet's boosted
 * terminal (179.6), off the sheet. DEV-382 follow-up; see `stepAiRacer`.
 *
 * 2016's on purpose, not the racer's own jet's: it is the speed every
 * `AI_RACER_TUNINGS` entry, the lane rule and the cross-track gain were
 * measured at, so it is the edge of the envelope the CONTROLLER is proven in.
 * Only a jet that can exceed it is ever held to it, which today is the speed
 * variant; `variant-sheet-reads.test.ts` carries the read's row.
 */
const ENVELOPE_SHEET = HOVERJET
export const RING_APPROACH_ENVELOPE: number = boostedCruiseSpeed(ENVELOPE_SHEET)

/** Volatile scratch for the lane arithmetic, valid inside one call. */
const _laneAt = v3()
const _laneRight = v3()
const _fwd = v3()
const _shifted = v3()

/**
 * Give every racer its lane, from where the grid stood it. DEV-364.
 *
 * Each racer's start is measured ACROSS the line at the nearest point of it
 * (`startLateral`), the racers are ranked left to right by that, and rank `k`
 * of `n` gets `k - (n - 1) / 2`: evenly spaced, centred on the line, in the
 * grid's own left-to-right order. Ties go by racer order. Without a line there
 * is nothing to be lateral OF, and every racer keeps rank 0.
 */
export const assignLanes = (racers: readonly AiRacer[], route: Route | null): void => {
  if (!route) {
    for (const r of racers) {
      r.laneRank = 0
      r.startLateral = 0
    }
    return
  }
  for (const r of racers) {
    const s = routeArcLengthNear(route, r.spec.spawn)
    routeAt(route, s, _laneAt)
    routeRightAt(route, s, _laneRight)
    r.startLateral =
      (r.spec.spawn.x - _laneAt.x) * _laneRight.x + (r.spec.spawn.z - _laneAt.z) * _laneRight.z
  }
  const order = racers.map((_, i) => i)
  order.sort((a, b) => {
    const d = (racers[a] as AiRacer).startLateral - (racers[b] as AiRacer).startLateral
    return d !== 0 ? d : a - b
  })
  const mid = (racers.length - 1) / 2
  order.forEach((index, k) => {
    ;(racers[index] as AiRacer).laneRank = k - mid
  })
}

/**
 * How much room across the line there is at arc length `s`: the tightest ring's
 * funnel. At a ring it is the ring's radius times `gateFraction`, less a hull;
 * away from it that grows by `gateFunnel` per metre. Never negative.
 */
const laneRoomAt = (
  s: number,
  gates: readonly Gate[],
  gateArc: readonly number[],
  spec: RacerSeparationSpec,
  hullRadius: number,
): number => {
  let room = Number.POSITIVE_INFINITY
  for (let i = 0; i < gates.length; i++) {
    const at = gateArc[i]
    const gate = gates[i]
    if (at === undefined || !gate) continue
    const r = gate.radius * spec.gateFraction - hullRadius + spec.gateFunnel * Math.abs(s - at)
    if (r < room) room = r
  }
  return Math.max(0, room)
}

/**
 * The racer's lane at arc length `s`, metres right of the line, avoidance
 * included. The ONE place the lane rule is written; `_lane` hands it to
 * `routeGuidance`.
 */
export const laneOffsetAt = (
  racer: AiRacer,
  s: number,
  gates: readonly Gate[],
  gateArc: readonly number[],
  traffic: RacerTraffic,
): number => {
  const spec = traffic.spec
  const lane = racer.laneRank * spec.laneSpacing
  // Eased from where it stood to its lane over the first stretch after gate 0.
  const ease = spec.laneEaseMetres > 0 ? smooth01(s / spec.laneEaseMetres) : 1
  const base = racer.startLateral + (lane - racer.startLateral) * ease
  // Every lane narrows TOGETHER into a ring, so the pack keeps its order and
  // its spacing ratio as it threads it, rather than the outer lanes being
  // clamped onto the inner ones.
  const room = laneRoomAt(s, gates, gateArc, spec, traffic.hullRadius)
  const widest = traffic.widestRank * spec.laneSpacing
  const squeeze = widest > room ? room / widest : 1
  const offset = base * squeeze + racer.avoid
  return offset < -room ? -room : offset > room ? room : offset
}

/**
 * Metres right to steer by to keep out of the other craft's way, this tick.
 *
 * A craft counts when it is within `avoidReach` AHEAD along the racer's heading
 * (or alongside, up to a beam behind), and within `avoidClearance` off its
 * track — across or above. Its weight falls linearly to zero at both edges, and
 * is full alongside, so a racer slides away from
 * a neighbour rather than jumping, and one in the next lane (`avoidClearance`
 * is a lane apart) is not avoided at all. The push is away from the side the
 * other craft is on; a craft dead ahead on the same track, which is on neither
 * side, is passed on the side of the racer's own lane, and between two racers
 * in one lane by racer order — so the answer is deterministic and the two never
 * choose the same side.
 */
const avoidance = (traffic: RacerTraffic, fx: number, fy: number, fz: number): number => {
  const spec = traffic.spec
  const self = traffic.craft[traffic.self]
  if (!self || spec.avoidReach <= 0 || spec.avoidClearance <= 0) return 0
  // (fx, fy, fz) is the heading, unit, in 3D; its RIGHT is horizontal,
  // (fz, -fx) normalised, which is square to it whatever the climb.
  const flat = Math.hypot(fx, fz)
  if (flat <= Number.EPSILON) return 0
  const rx = fz / flat
  const rz = -fx / flat
  const myRank = traffic.ranks[traffic.self] ?? 0
  let push = 0
  for (let j = 0; j < traffic.count; j++) {
    if (j === traffic.self) continue
    const other = traffic.craft[j]
    if (!other) continue
    const dx = other.x - self.x
    const dy = other.y - self.y
    const dz = other.z - self.z
    // Along the 3D heading, and off it SQUARE to it — not "across plus world
    // up". On a climbing line a ship 28 m ahead is metres higher, and measuring
    // its height in world y called it off the track while it sat dead ahead.
    const along = dx * fx + dy * fy + dz * fz
    // AHEAD and ALONGSIDE only. A craft more than a beam behind is the other
    // pilot's to avoid — the car behind owns the pass — and a racer that
    // slid away from whatever came up behind it could not be caught: the
    // first in-game cut dodged the player's every approach, and "so we can
    // push them" is half of what was asked for.
    if (along < -traffic.hullRadius * 2) continue
    const reach = Math.max(0, along)
    if (reach >= spec.avoidReach) continue
    const across = dx * rx + dz * rz
    const off = Math.hypot(dx - along * fx, dy - along * fy, dz - along * fz)
    if (off >= spec.avoidClearance) continue
    const weight = (1 - reach / spec.avoidReach) * (1 - off / spec.avoidClearance)
    let away = across > 0 ? -1 : across < 0 ? 1 : 0
    if (away === 0) {
      const theirRank = traffic.ranks[j] ?? 0
      away = myRank !== theirRank ? Math.sign(myRank - theirRank) : traffic.self < j ? -1 : 1
    }
    push += away * weight
  }
  // Bounded at one full weight either way. Summed unbounded, the start — five
  // racers and the player inside one reach — added four neighbours' weights on
  // one side and threw a racer 35 m off its lane in a tick, then 18 m back the
  // other way when the picture flipped. Being crowded from two sides is no
  // reason to move further than being crowded from one.
  const bounded = push < -1 ? -1 : push > 1 ? 1 : push
  return bounded * spec.avoidGain
}

/**
 * Volatile: the lane `routeGuidance` is handed, bound to ONE racer for ONE
 * call. A scratch rather than a closure per racer per tick; safe as one because
 * `routeGuidance` reads it and returns, and it is rebound before every use.
 */
const _lane: RouteLane & {
  racer: AiRacer | null
  gates: readonly Gate[]
  gateArc: readonly number[]
  traffic: RacerTraffic | null
} = {
  racer: null,
  gates: [],
  gateArc: [],
  traffic: null,
  offsetAt(s: number): number {
    const racer = this.racer
    const traffic = this.traffic
    return racer && traffic ? laneOffsetAt(racer, s, this.gates, this.gateArc, traffic) : 0
  },
}

/**
 * How far a finished racer climbs away, in multiples of its own `minClearance`.
 *
 * A GAME FEEL number, FF2's own, and deliberately expressed as a multiple of a
 * constant that is already here rather than as a fresh count of metres — one
 * clearance-height above where the run ended is, by the controller's own
 * definition, high enough that the terrain-avoidance term never has to fire at
 * it again. On `int_01`'s tunings that is 60 m.
 *
 * **Set it to 0 for the old behaviour**: hold exactly the altitude you finished
 * at. That is the switch, and it is the whole of the switch.
 */
export const FLY_OUT_CLIMB = 1

/**
 * Is this run over? The ONE rule, shared by every non-player runner.
 *
 * The FINISH GATE ends a run, exactly as it ends the player's (DEV-045) — a
 * separate, non-scoring `Trigger_FinishLine` **234.6 m past ring 21** on
 * `int_01`. Stopping at the last ring times a run over a course a quarter of a
 * kilometre shorter than the one the player flew, and every opponent time on the
 * results panel then flatters the opponent.
 *
 * Falling back to "all gates passed" only for a course with no finish gate keeps
 * the JumpSeat missions working without inventing an end condition 2016 does not
 * have.
 *
 * Exported because `ghost.ts` scores a recorded run against the same finish, and
 * two copies of this rule would be two different courses. (It would sit more
 * naturally in `course.ts`; it is here because this is where the rule was first
 * written down, and that file is somebody else's.)
 */
export const runIsOver = (
  finish: FinishSphere | null,
  position: Vec3,
  passed: readonly boolean[],
): boolean => {
  if (!finish) return passed.every(Boolean)
  return distanceSq(position, finish) <= finish.radius * finish.radius
}

const _input: HoverJetInput = noInput()

/**
 * Volatile: the course handed to `stepCrash`, rebuilt every tick it is used.
 * A scratch rather than an allocation, and safe as one because nothing keeps
 * it — `stepCrash` reads it and returns.
 */
const _course: { route: Route; limitS: number } = {
  route: null as unknown as Route,
  limitS: 0,
} satisfies CrashCourse

/**
 * What a racer needs after the crash rule has put its body back on the line.
 *
 * The follower's cursor is monotonic and is sitting past the crash; it is
 * rewound to the reset's arc length — the one legitimate way a cursor moves
 * backwards. The contact state is rebuilt so no `Flash()` penalty or
 * "already touching" flag comes back from the wreck, and the engine is cold.
 */
const afterRacerReset = (
  racer: AiRacer,
  guide: { route: Route; gateArc: readonly number[] } | null,
): void => {
  if (guide) rewindCursor(guide.route, racer.cursor, racer.crash.reset.s)
  // The racer was PUT on the line, not flown there (DEV-149). A trigger fires
  // on an edge and a teleport is not one, so any gate it has been placed
  // inside is noted and none of them scores — the player's own reset goes
  // through the same rule in `stepMission`. Without it a racer that missed
  // ring 1 was handed it by its next crash, because the reset is pinned to the
  // start of the line and the line starts 1.4 m from ring 1's centre.
  seedCourse(racer.course, racer.jet.body.position)
  Object.assign(racer.ground.collision, createTerrainCollision())
  racer.jet.body.angularDrag = racer.ground.baseAngularDrag
  racer.jet.currentThrust = 0
  // The reset is somewhere else, so whatever it was resting on it is not
  // resting on now. Left behind, this is a counter part-way to a break that the
  // next contact — a different prop, in a different place — would finish early.
  racer.propStuckFor = 0
}

/** Nobody to avoid: a hovering instructor does not steer off the ground. */
const NO_FIELDS: readonly HeightField[] = []

/**
 * The instructor's HOLD, past the ring it waits beside (DEV-376): fly to the
 * hover point, then stop there and turn to face the student.
 *
 * Writes every field of `_input`, as each branch of `stepAiRacer` must (the
 * DEV-032 lesson: `_input` is shared by every racer). A HoverJet with its
 * gravity off simply stops at altitude with the throttle shut, so a hover is
 * throttle 0 and the airbrake, and the controller's yaw and pitch pointed at
 * the student — torque turns the ship in place at any speed.
 */
const holdStep = (
  racer: AiRacer,
  pace: InstructorPace,
  route: Route,
  terrain: readonly HeightField[],
): void => {
  const body = racer.jet.body
  // Keep its arc honest while it is off the line: the gap is measured on it.
  advanceRoute(route, racer.cursor, body.position)
  const at = pace.holdAt
  const d = Math.hypot(at.x - body.position.x, at.y - body.position.y, at.z - body.position.z)
  if (d > ARRIVED_WITHIN) {
    // On its way: the pace law with the point as the student, so it closes on
    // it as it closes a gap. The ground rule still applies on the way.
    pace.settled = false
    pace.target = arriveTarget(pace.spec, d)
    autopilotActions(
      body,
      at,
      _input,
      paceTuning(pace, racer.spec.tuning, racer.jet, pace.target),
      terrain,
      Number.POSITIVE_INFINITY,
      null,
      pace.target,
      racer.jet,
    )
    return
  }
  // There: nose toward the student, and nothing else. No ground probe — a
  // ship that is not going anywhere has no path to clear, and the probe would
  // pitch the nose up off the student over any ground within `minClearance`.
  pace.settled = true
  pace.target = 0
  autopilotActions(
    body,
    pace.student.position,
    _input,
    paceTuning(pace, racer.spec.tuning, racer.jet, 0),
    NO_FIELDS,
    Number.POSITIVE_INFINITY,
    null,
    Number.POSITIVE_INFINITY,
    racer.jet,
  )
  _input.throttle = 0
  _input.boost = false
  _input.brake = true
}

/**
 * One fixed step of one racer.
 *
 * Same order as the player: decide, then integrate. A racer that has finished
 * keeps flying — it has nowhere to be, and freezing it mid-air in front of you
 * looks like a bug — but it flies a heading it chose. See the `else` below for
 * what happens when it does not, which is DEV-032.
 */
const _aim = v3()
const _beyond = v3()

export const stepAiRacer = (
  racer: AiRacer,
  gates: readonly Gate[],
  /**
   * What it AVOIDS — the fields the autopilot's clearance term probes.
   *
   * The islands only, in the running game. The ocean plate is flat and 262 km
   * wide, so a controller that could see it would spend the whole race pulling
   * up away from a sea level it is already 150 m above.
   */
  terrain: readonly HeightField[] = [],
  dt: number = FIXED_DT,
  /** The authored racing line, and each gate's arc length along it. */
  guide: { route: Route; gateArc: readonly number[] } | null = null,
  /**
   * What it HITS. Defaults to what it avoids, which is not the same list.
   *
   * The player's collision gets the ocean as well as the islands — 2016 builds
   * the sea as a second `FacetedTerrain` with a `TerrainCollider`, so the water
   * stops you the way a hillside does. Avoidance and contact therefore want
   * DIFFERENT field lists, and collapsing them into one either drowns the racers
   * or has them flying a permanent pull-up over open water.
   */
  ground: readonly HeightField[] = terrain,
  /**
   * The Anniversary crash rule (DEV-126), or null for 2016's bounce. The SAME
   * spec the player flies under: a racer that could survive a hit the player
   * cannot would be a racer with a different world.
   */
  crash: CrashSpec | null = null,
  /**
   * The forest (DEV-147), or null where the preset has no prop collision.
   *
   * The SAME `PropColliders` the player tests against — one forest, and a tree
   * a racer knocks down is down for everybody — with this racer's OWN
   * `PropCollisionState` to report into. See `AiRacer.props`.
   */
  props: { readonly colliders: PropColliders; readonly spec: PropCollisionSpec } | null = null,
  /**
   * The other craft, and the lane rule (DEV-364), or null for the one line
   * every racer flew before — which is what Classic gets, and what every caller
   * that predates the rule gets by passing nothing. See `stepRacerField`, which
   * builds this and is the one caller that does.
   */
  traffic: RacerTraffic | null = null,
): void => {
  racer.elapsed += dt
  racer.crashEvent = 'none'
  racer.avoid = 0
  const separation = traffic?.spec.enabled ? traffic : null
  // The renderer reads `racer.props.hits` AFTER this call, so last tick's hits
  // have to go before anything can return: a held racer that kept reporting
  // them would have the renderer fracture the same instance every tick of the
  // hold. Cleared here rather than only in `stepPropCollision`, which the two
  // early returns below never reach.
  racer.props.hits.length = 0
  // ── Held where it hit ────────────────────────────────────────────────────
  //
  // A crashed racer is frozen exactly as the player is: no controller, no
  // flight model, no contact — only the hold clock, and then the reset onto
  // its line. It has no curtain to wait for, so its beat is the sim's alone.
  if (crash && crashHoldsShip(racer.crash)) {
    racer.crashEvent = stepCrash(racer.crash, crash, racer.jet.body, 0, _course, ground, dt)
    if (racer.crashEvent === 'reset') afterRacerReset(racer, guide)
    return
  }
  // ── DEV-376: the instructor leads, or waits ─────────────────────────────
  //
  // Null for every racer, which skips all of it. An instructor needs the line:
  // both arcs, its own and the student's, are measured along it. Its own is
  // the cursor it ended last tick on, as the lane rule reads it (DEV-364).
  const pace = guide ? racer.pace : null
  if (pace && guide && stepInstructorMode(pace, racer.cursor.s)) {
    // The hover point, latched once on the way in. Its side is chosen off what
    // the ship would HIT, so a hover point is never inside a canyon wall.
    latchHold(pace, guide.route, gates, guide.gateArc, racer.cursor.s, ground)
  }
  // Past the ring it waits beside: off the line, to the hover point. Before
  // it, the line, as it leads, at an arrival speed (below).
  const hovering =
    pace !== null &&
    guide !== null &&
    pace.mode === 'hold' &&
    !racer.finished &&
    !holdBeforeRing(pace, racer.course.passed, guide.gateArc, racer.cursor.s)
  const target = nextGate(gates, racer.course.passed)
  // ── After the last ring, aim at the FINISH GATE ─────────────────────────
  //
  // `nextGate` returns -1 once every ring is taken, which used to drop the
  // racer straight into the fly-out branch below. That was right when the last
  // ring ENDED the run; it is not right now that the finish gate does
  // (DEV-045). The racer would reach the gate only by luck — it happens to lie
  // roughly ahead of ring 21, so a straight heading usually blunders into a
  // 68 m sphere eventually. "Usually" and "eventually" are not a race.
  //
  // A synthetic gate, so the whole corner-aiming controller applies to the run
  // home exactly as it does to every other leg.
  const finishGate: Gate | null =
    target < 0 && racer.finish && !racer.finished
      ? {
          centre: { x: racer.finish.x, y: racer.finish.y, z: racer.finish.z },
          radius: racer.finish.radius,
          // Never scored and never stepped through `stepCourse` — this gate
          // exists only to give the autopilot something to fly at.
          points: 0,
          triggerOnce: true,
        }
      : null
  const gate = target >= 0 ? gates[target] : finishGate
  if (hovering && pace && guide) {
    holdStep(racer, pace, guide.route, terrain)
  } else if (gate) {
    // What the controller is handed. A racer's own tuning and no target speed
    // — the default `autopilotActions` has always had — unless it is an
    // instructor, whose pace sets both below.
    let tuning = racer.spec.tuning
    let targetSpeed = Number.POSITIVE_INFINITY
    // DEV-376: whether an instructor's target was set on the line below.
    let pacedOnLine = false
    // Follow the LINE when there is one, aiming at a point that slides ahead of
    // the ship rather than at the ring itself. Aiming at a gate centre makes a
    // ship fly straight segments and overshoot corners; a lookahead on a smooth
    // spline corners because the target corners. Capped at the gate's own arc
    // length so it can never aim past a ring it still owes.
    let aim = gate.centre
    let offset = Number.POSITIVE_INFINITY
    // The next RING when aiming gate to gate; a point further along the LINE
    // when following it. Pairing a lookahead with a ring measures nothing.
    //
    // The LAST ring's successor is the FINISH GATE (DEV-382 follow-up). With
    // none, a racer that missed the last ring had no corner to brake for, held
    // boost at its throttle floor and orbited the ring at that radius for ever:
    // every speed-jet DNF DEV-381 measured owed exactly the last ring.
    //
    // And the run HOME has no successor at all (DEV-394). `target` is -1 there,
    // so `gates[target + 1]` was RING 0: every racer braked for a hairpin back
    // to the start in the last 1.7 s before the finish.
    let cornerRef: Vec3 | null =
      target >= 0 ? (gates[target + 1]?.centre ?? racer.finish ?? null) : null
    // The authored racing line stops at the last ring, so the run home is flown
    // gate-to-gate rather than on the line. Asking `routeGuidance` for a point
    // past the end of its own spline is how you get a racer aiming at nothing.
    if (guide && target >= 0) {
      const speed = Math.hypot(
        racer.jet.body.velocity.x,
        racer.jet.body.velocity.y,
        racer.jet.body.velocity.z,
      )
      // DEV-364: steer off the others across the LINE's heading where the
      // racer is — read at the cursor it ended last tick on, since this tick's
      // advance happens inside `routeGuidance` — and fly the lane.
      if (separation) {
        routeTangentAt(guide.route, racer.cursor.s, _fwd)
        racer.avoid = avoidance(separation, _fwd.x, _fwd.y, _fwd.z)
        _lane.racer = racer
        _lane.gates = gates
        _lane.gateArc = guide.gateArc
        _lane.traffic = separation
      }
      const onLine = routeGuidance(
        guide.route,
        racer.cursor,
        racer.jet.body.position,
        {
          speed,
          leadSeconds: racer.spec.tuning.routeLeadSeconds,
          leadMinMetres: racer.spec.tuning.routeLeadMinMetres,
          gateS: guide.gateArc[target] ?? Number.POSITIVE_INFINITY,
          fallback: gate.centre,
          finalMetres: racer.spec.tuning.routeFinalMetres,
          curveGain: racer.spec.tuning.routeCurveGain,
          crossGain: racer.spec.tuning.routeCrossGain,
          beyond: _beyond,
          lane: separation ? _lane : null,
          // DEV-494: never an aim on top of the ship, where the line folds back.
          minAimMetres: racer.spec.tuning.routeAimMinMetres,
        },
        _aim,
      )
      aim = _aim
      // Off the line's help, the ground rule comes back — that is exactly when
      // the ship is somewhere the authored path says nothing about.
      offset = onLine ? racer.cursor.offset : Number.POSITIVE_INFINITY
      if (onLine) cornerRef = _beyond
      // ── DEV-382 follow-up: a racer on a jet faster than its controller ────
      //
      // Racers fly the player's variant, and the speed jet's boosted terminal
      // is 323 m/s against the 179.6 every racer tuning was measured on
      // (DEV-125). Two things break there, both measured on the six HoverJet
      // Ring Attack courses with the grid, the lanes and contact on:
      //
      //  - A MISSED ring is a wide orbit. Off the line and past the ring's arc,
      //    the follower aims back at the ring with boost held; at 164 m/s and
      //    more its turning circle does not close on a 22.6 m ring. So the way
      //    back is flown at the jet's own unboosted cruise.
      //  - Rings are missed at all. Below 175 m/s racers passed 1,090 rings
      //    without a miss; at 225-325 m/s they missed 30-50 % of them, because
      //    the line follower's cross-track loop, tuned at 2016's speeds, swings
      //    about the line (±25 m at 219 m/s on the speed jet) and the ring falls
      //    where it falls. So a racer whose jet can out-run 2016's closes on a
      //    ring no faster than 2016's boosted terminal, the envelope its
      //    controller is proven in, and spends the rest of its boost between
      //    rings, which is where "insane boost" belongs (AIRCRAFT-VARIANTS §6.4:
      //    it pays only if you lift for the turns).
      //
      // Neither touches a racer on standard or acrobat: neither can reach the
      // envelope, and a ring is only recovered at cruise after it is missed.
      // An instructor paces itself (below) and is left alone.
      const ringS = guide.gateArc[target] ?? Number.POSITIVE_INFINITY
      if (!pace) {
        if (!onLine && racer.cursor.s > ringS) {
          targetSpeed = cruiseSpeed(racer.jet.sheet)
        } else if (
          boostedCruiseSpeed(racer.jet.sheet) > RING_APPROACH_ENVELOPE &&
          ringS - racer.cursor.s < speed * racer.spec.tuning.cornerBrakeSeconds
        ) {
          targetSpeed = RING_APPROACH_ENVELOPE
        }
      }
      if (pace) {
        // DEV-376: leading, the pace law; on its way to wait, an arrival at the
        // hover point, by straight-line distance (it can lie behind the ship:
        // `latchHold`). Then the line's own braking profile, read ahead exactly
        // as the player's autopilot reads it, so a slow instructor still brakes
        // for a hairpin.
        const p = racer.jet.body.position
        let want =
          pace.mode === 'hold'
            ? arriveTarget(
                pace.spec,
                Math.hypot(pace.holdAt.x - p.x, pace.holdAt.y - p.y, pace.holdAt.z - p.z),
              )
            : leadTarget(pace)
        if (onLine) {
          const profile = speedLimitAt(
            guide.route,
            racer.cursor.s + speed * racer.spec.tuning.profileLookSeconds,
          )
          if (profile < want) want = profile
        }
        targetSpeed = want
        pacedOnLine = true
      }
    } else if (separation) {
      // Off the line — the run home to the finish gate, or a course with no
      // line — there is no lane, but there is still somebody to keep off.
      // Across the racer's own ground track, and into a scratch: `aim` is the
      // gate's own centre here, and writing into it would move the ring.
      const v = racer.jet.body.velocity
      const speed = Math.hypot(v.x, v.y, v.z)
      const flat = Math.hypot(v.x, v.z)
      if (speed > Number.EPSILON && flat > Number.EPSILON) {
        racer.avoid = avoidance(separation, v.x / speed, v.y / speed, v.z / speed)
        // Across the ground track: its horizontal right, (vz, -vx) normalised.
        _shifted.x = aim.x + (v.z / flat) * racer.avoid
        _shifted.y = aim.y
        _shifted.z = aim.z - (v.x / flat) * racer.avoid
        aim = _shifted
      }
    }
    if (pace && guide) {
      // Off the line — the run home to the finish gate — the lead target. The
      // line runs on past the last ring and the student's arc is measured along
      // it, so the instructor's cursor is advanced here too, or the gap would
      // freeze at the last ring while the student's arc ran on (measured: a
      // p5 gap of -256 m on `rookie_02`, every metre of it the run home).
      // An instructor's own cursor only: a racer's is not touched here.
      if (!pacedOnLine) {
        advanceRoute(guide.route, racer.cursor, racer.jet.body.position)
        targetSpeed = leadTarget(pace)
      }
      pace.target = targetSpeed
      tuning = paceTuning(pace, racer.spec.tuning, racer.jet, targetSpeed)
    }
    autopilotActions(
      racer.jet.body,
      aim,
      _input,
      tuning,
      terrain,
      offset,
      cornerRef,
      targetSpeed,
      racer.jet,
    )
  } else {
    // ── Finished: fly out, wings level ─────────────────────────────────────
    //
    // This branch used to write two of `HoverJetInput`'s six fields and say it
    // was "holding the last input". It was holding somebody else's. `_input` is
    // a module-level scratch shared by every racer, `autopilotActions` writes
    // all six, and `racers.ts` steps the racers in a loop — so a finished racer
    // flew on with the BANK AND PITCH of whichever racer stepped after it,
    // frozen, for the rest of the session.
    //
    // Measured over 186 s on `?autopilot=1`: `fast` finished at 83.8 s and then
    // held 31 m/s porpoising between y=134 and y=493 on a fixed turn, `steady`
    // the same at 45 m/s. Left long enough they wind out to the corner of the
    // world and go under, because nothing was asking them to stay up — and
    // because `stepHoverJet` had no terrain collision, so the sea floor was not
    // a floor. That is "the AI racers crash out". Both halves are fixed now: the
    // altitude setpoint below, and `stepGroundContact` at the end of this
    // function.
    //
    // The intent above still stands — freezing a jet mid-air in front of you
    // looks like a bug — so it keeps flying. It just flies something it chose:
    // its own heading, through the same controller, which means every field of
    // `_input` is written afresh and the terrain rule still applies. It leaves
    // the course rather than spiralling into it, and it leaves it CLIMBING —
    // `holdAltitude` is latched one `minClearance` above where the run ended.
    // See `FLY_OUT_CLIMB`.
    const body = racer.jet.body
    const flat = Math.hypot(body.velocity.x, body.velocity.z)
    // The same speed-scaled lookahead it flew the course with. A short lead is
    // a high-gain pursuit controller, and high gain on a straight line is how
    // you get the oscillation this branch is here to stop.
    const lead = Math.max(
      racer.spec.tuning.routeLeadMinMetres,
      flat * racer.spec.tuning.routeLeadSeconds,
    )
    // Its own ground track — and an arbitrary but DEFINED heading for a racer
    // with no ground speed, which this flight model cannot actually produce
    // under power but which must not divide by zero if it ever does.
    const ux = flat > 1e-3 ? body.velocity.x / flat : 0
    const uz = flat > 1e-3 ? body.velocity.z / flat : 1
    // `.y` is the LATCHED altitude, not the live one. Dropping the velocity's
    // vertical component is what nulls the phugoid; using a fixed setpoint
    // rather than `body.position.y` is what stops the slow climb that replaced
    // it, because a reference that tracks the state corrects nothing.
    _aim.x = body.position.x + ux * lead
    _aim.y = racer.holdAltitude
    _aim.z = body.position.z + uz * lead
    autopilotActions(
      body,
      _aim,
      _input,
      racer.spec.tuning,
      terrain,
      Number.POSITIVE_INFINITY,
      null,
      Number.POSITIVE_INFINITY,
      racer.jet,
    )
    // Cruise, not race. Set after the controller, which would otherwise hand
    // back a racing throttle for a run that is over.
    _input.throttle = racer.spec.tuning.minThrottle
    _input.boost = false
  }
  stepHoverJet(racer.jet, _input, dt)
  // ── The ground, by the SAME rule the player gets ────────────────────────
  //
  // `stepGroundContact` is the player's four lines of `game/flight.ts`, moved
  // into the sim so there is one of them rather than two. Hover motor, then
  // depenetration, then `Flash()`'s angular-drag penalty, in that order, after
  // the flight model has moved the body.
  //
  // A contact does not end a racer's run, because it does not end the player's:
  // `endOnCollide` is 0 on the shipped prefab. It costs speed and the ability to
  // turn for a third of a second, which is exactly what it costs you.
  stepGroundContact(racer.ground, racer.jet.body, ground, HOVERJET_GROUND, dt)
  // ── The forest, by the SAME rule the player gets (DEV-147) ──────────────
  //
  // DEV-136 gave the player solid, breakable props and left the racers flying
  // through them: on an alpine course you smash a tree while the racer beside
  // you passes through it, which reads as cheating in the one moment the
  // racers matter. They test the same colliders now, with the same hull and
  // the same spec, after the flight model and the ground rule have moved the
  // body — the player's order exactly.
  //
  // BREAK rather than AVOID, and that is a measurement rather than a taste:
  // over a whole `int_01` run every one of the five tunings spends at least
  // 99.65 % of its ticks at or above the preset's 45 m/s `breakSpeed`
  // (`fast` 99.96 %, `steady` — the slowest — 99.65 %). So DEV-136's stated
  // worry, "bouncing through the forest on the lap you are racing", is the
  // branch a racer essentially cannot reach: a racer that meets a tree goes
  // through it and the tree comes apart. Avoidance would have been a
  // controller change with the blast radius of a retune.
  if (props) {
    stepPropCollision(
      racer.props,
      racer.jet.body,
      HOVERJET_GROUND.collision.hull,
      props.colliders,
      props.spec,
    )
    // ── DEV-180: and the racer that CANNOT break it gets off it anyway ────
    //
    // The paragraph above is measured over the RACE. A racer that has finished
    // cruises at `minThrottle` — 31.4 m/s on `fast` and `cutter` — and one
    // that has just been crash-reset arrives at `crash.resetSpeed` 40 with a
    // cold engine, both under the preset's 45 m/s `breakSpeed`. In either state
    // the break branch is closed to it, so a palm is a wall: the bounce pushes
    // it out, the controller flies it straight back in, and Matt watched one do
    // that for minutes off a single trunk, ~20 times at 8-15 m/s and then
    // another at 2, with a console line for every tick of it.
    //
    // Nothing above will end that — the bounce is correct, the controller is
    // correct, and the two are correct at each other for ever. So the loop is
    // cut where it starts: a racer that has been resting on the forest for
    // `racerStuckSeconds` breaks what it is resting on. The tree falls, which
    // is the one outcome a player already has a reading for.
    //
    // A RACING racer is untouched, and that is measured rather than asserted.
    // The two cases do not overlap, they are an order of magnitude apart: a
    // racer that CAN break what it touches is in contact for exactly **one
    // tick** — the collider is gone at the end of it — while a racer that
    // cannot grinds against the trunk for **46 to 51 consecutive ticks**
    // (0.56-0.62 s, four tunings, four approach speeds) as it is scrubbed from
    // 31 m/s down to 0.8. There is nothing in between, so the preset's
    // threshold is not a balance point; it only has to sit inside a very wide
    // gap. And over 900 s of the five-racer grid on the real `int_01` course
    // with the real Simonet forest, not one racer had a single bounce tick
    // before it finished.
    //
    // A contact that BROKE is not a hold — it is the rule working — so only a
    // contact the prop survived counts. Without that, a racer crossing alpine's
    // 12,000 trees at 200 m/s accumulates a second of "stuck" out of a second
    // of breaking things and starts force-breaking what it would have broken
    // anyway, which is the same number with a worse reason.
    if (racer.props.hits.some((h) => !h.broken)) {
      racer.propStuckFor += dt
      if (props.spec.racerStuckSeconds > 0 && racer.propStuckFor >= props.spec.racerStuckSeconds) {
        breakHeldProps(racer.props, props.colliders)
        racer.propStuckFor = 0
      }
    } else {
      racer.propStuckFor = 0
    }
  }
  // ── Too hard? (DEV-126) ─────────────────────────────────────────────────
  //
  // Off the contact's own reading, after the contact has run — the same order
  // the player's step uses. A FINISHED racer is exempt: it is flying out, away
  // from the course, and putting it back on a line it has left would be a
  // racer that cannot leave. The course is the guide's line when there is one
  // and the gate polyline when there is not, bounded at the gate it still owes.
  if (crash && !racer.finished) {
    const line = guide ? guide.route : racer.fallbackCourse.route
    const arcs = guide ? guide.gateArc : racer.fallbackCourse.gateArc
    _course.route = line
    // The same bound the player gets, from the same function: how far the run
    // has actually GOT, not the first ring it still owes (DEV-289).
    _course.limitS = crashLimitS(arcs, racer.course.passed, line.length)
    racer.crashEvent = stepCrash(
      racer.crash,
      crash,
      racer.jet.body,
      racer.ground.collision.impactSpeed,
      _course,
      ground,
      dt,
      // DEV-185: the racer is put back on a line that runs through palm #840,
      // at `resetSpeed` — under `breakSpeed`, so it cannot push the tree over.
      // The reset walks back to air. Same colliders, same hull, same rule the
      // player's reset takes in `boot/app.ts`.
      props ? { colliders: props.colliders, hull: HOVERJET_GROUND.collision.hull } : null,
    )
    if (racer.crashEvent === 'reset') afterRacerReset(racer, guide)
    if (racer.crashEvent !== 'none') return
  }
  // `>= 0`, not `> 0`. `stepCourse` returns the gate INDEX, and gate 0 is the
  // first gate of every course — the one every racer takes first.
  const scored = stepCourse(racer.course, racer.jet.body.position)
  if (scored >= 0) racer.gates = racer.course.passedCount
  const done = runIsOver(racer.finish, racer.jet.body.position, racer.course.passed)
  if (!racer.finished && done) {
    racer.finished = true
    racer.finishedAt = racer.elapsed
    // ── Latched here, once, and never written again ───────────────────────
    //
    // Plus the climb-away. DEV-032 stopped the racer descending; it did not give
    // it anywhere to go, so it cruised out level at whatever height the finish
    // gate sits at and after two minutes it is 4-5 km out over open sea at the
    // same altitude — which reads as a jet that forgot to land rather than one
    // that won something.
    //
    // A climb is the smallest thing that reads as LEAVING. It is four lines, it
    // is not a victory lap, and it is emphatically not a despawn system: the
    // racer is still a real body flying a real controller, it is just aiming
    // upward for the rest of its life. See `FLY_OUT_CLIMB`.
    racer.holdAltitude = racer.jet.body.position.y + FLY_OUT_CLIMB * racer.spec.tuning.minClearance
  }
}

// `gateArcLengths` lives with the line it measures (`sim/route.ts`); this
// re-export is for the importers that predate the move, and for
// `tools/content/leg-table.mjs`, which loads it from here.
export { gateArcLengths } from './route'

// ── DEV-146: putting a racer PARTWAY round a course ─────────────────────────

/** Volatile: the tangent, valid only inside one `seedRacerAt`. */
const _seedDir = v3()

/**
 * The speed a seeded racer arrives at, m/s — ITS jet's cruise, not a guess.
 *
 * Where an unboosted HoverJet ends up on a straight (89.81 on 2016's sheet),
 * so a ship dropped onto the line at that speed is a ship already doing what
 * it would be doing if it had flown there. Seeding at rest instead gives every
 * one of them a visible ten-second spool-up from a standing start in mid-air,
 * which is the one thing that would read as a spawn.
 *
 * **Off the racer's own sheet since DEV-382.** It was `SEED_SPEED`, a constant
 * read off `derived.hoverjet.terminalSpeedCruise`: 2016's cruise, whatever the
 * racer flies, so a speed-variant racer would have left its seed at the
 * standard's pace and spooled up from there (AIRCRAFT-VARIANTS §1.3). On
 * 2016's sheet it is that row unrounded (`sim/hoverjet.ts`'s `cruiseSpeed`).
 */
export const seedSpeed = (jet: HoverJet): number => cruiseSpeed(jet.sheet)

/**
 * Put a racer on a course at arc length `s`, flying, as if it had started at
 * the beginning and got this far.
 *
 * DEV-146 needs this twice: once to spread ambient traffic evenly round a
 * circuit at load, and once to put a ship that has finished back where it
 * began without the sky emptying. Nothing about it is ambient-traffic-specific
 * — it is "start this racer from there" — and it is in the sim because every
 * part of it is (a route, a course, a body).
 *
 * The three things that have to move together, and the bug in leaving any one
 * of them behind:
 *
 *   · the BODY — position and nose along the line, at {@link seedSpeed};
 *   · the CURSOR — a route cursor only ever advances (`advanceRoute`'s window
 *     is monotonic on purpose), so a racer seeded at 7 km with a cursor at 0
 *     steers by a lookahead taken from the far side of the island;
 *   · the COURSE — `nextGate` returns the first UNPASSED gate, so a racer
 *     seeded past twelve rings with a fresh course turns round and flies back
 *     to ring 1. Every gate whose arc length is behind `s` is marked passed.
 *
 * `score` is deliberately NOT credited for those gates: a seeded racer's score
 * is the gates it actually flew through. Nothing reads it for traffic, and a
 * number that means "gates I was placed past" would be a liability the first
 * time something did.
 */
export const seedRacerAt = (
  racer: AiRacer,
  course: { readonly route: Route; readonly gateArc: readonly number[] },
  s: number,
  speed: number = seedSpeed(racer.jet),
): void => {
  const body = racer.jet.body
  const clamped = Math.max(0, Math.min(course.route.length, s))
  routeAt(course.route, clamped, body.position)
  const dir = routeTangentAt(course.route, clamped, _seedDir)
  lookAlong(body.orientation, dir)
  body.velocity.x = dir.x * speed
  body.velocity.y = dir.y * speed
  body.velocity.z = dir.z * speed
  body.angularVelocity.x = 0
  body.angularVelocity.y = 0
  body.angularVelocity.z = 0
  // Gravity off, exactly as `createAiRacer` leaves it: an unlaunched HoverJet
  // drops, and a ship placed in mid-air has no elevator to ride.
  racer.jet.launched = true
  racer.jet.currentThrust = 0
  rewindCursor(course.route, racer.cursor, clamped)
  let passed = 0
  for (let i = 0; i < racer.course.passed.length; i++) {
    const behind = (course.gateArc[i] ?? Number.POSITIVE_INFINITY) <= clamped
    racer.course.passed[i] = behind
    if (behind) passed++
  }
  racer.course.passedCount = passed
  racer.gates = passed
  racer.finished = false
  racer.finishedAt = 0
  racer.holdAltitude = 0
  racer.elapsed = 0
}
