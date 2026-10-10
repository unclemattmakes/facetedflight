// src/game/mission.ts — mission/run state: score, the objective, the clock, the
// medal — for whichever MODE is running.
//
// Game rules, not physics. Three-free by habit (it has to run in a headless
// scored-lap test), though the purity guard only polices `src/sim/`.
//
// ── One run, three scoring channels, and a descriptor that picks ──────────
//
// A run carries all three of 2016's collectible kinds — rings (`sim/course.ts`),
// pad plates (`sim/targets.ts`) and orbs (`sim/orbs.ts`) — and
// `game/modes.ts`'s descriptor says which of them are LIVE, which SCORE, what
// ENDS the run, and what SCALE the medal is on. There is no `if (mode === …)`
// anywhere in this file: the mode is read once, into `state.mode`, and every
// decision after that asks the descriptor a question about behaviour.
//
// That is 2016's own architecture. `Level.Start()` toggles two GameObject
// subtrees and changes no rules; the rules live in four components that each
// read one string. See `game/modes.ts`, and `docs/research/_modes-spec.md` §8.1.
//
// ── The one channel that is NOT 2016's ────────────────────────────────────
//
// Target Practice's pad channel carries an **accuracy streak** — FF2's own
// design, asked for by name this session, because 2016's flat additive scoring
// was shipped late and never satisfied anybody. `sim/targets.ts`'s header is the
// design and `game/targets.ts` holds its three knobs; what this file adds is the
// per-step RECORD of it (`MissionEvent.padPoints` / `padMultiplier` /
// `padEffect` / `padClearBonus`) and `padBanner`, which turns that record into
// the one short line the panel shows. A streak the player cannot see is a
// spreadsheet.
//
// ── Trap 19: the step's result is the STATE's, never a module scratch ─────
//
// `stepMission` returns `state.event`, an object owned by the `MissionState` it
// was called with. A module-level scratch would be a channel between two runs
// that do not know about each other — which is exactly how a finished AI racer
// ended up flying on the other racer's stick (DEV-032). Stepping a second
// mission cannot disturb the first, and `tests/unit/mode-rules.test.ts` steps a
// second one and asserts the first did not move — as does
// `tests/unit/pad-streak.test.ts`, for the multiplier, which is the single
// number in this codebase most shaped like DEV-032's bug.

import type { GameMode, Level, Medals } from '@/content/level-schema'
import { liveRings } from '@/content/level-schema'
import { clockCountsInMedal, timePoints, timeTermFor } from '@/game/medal-time'
import {
  type CollectibleKind,
  countLabel,
  countTotal,
  type ModeRules,
  medalCurve,
  rulesFor,
  runningMode,
} from '@/game/modes'
import { orbSpheres } from '@/game/orbs'
import {
  type FinishVolume,
  finishFor,
  finishGap,
  finishPadAirspace,
  livePads,
  padStreakRules,
  padZones,
} from '@/game/targets'
import { type CourseState, createCourse, type Gate, seedCourse, stepCourse } from '@/sim/course'
import {
  createGateEvents,
  type GateEventSpec,
  type GateEventState,
  gateCentredness,
  recordGate,
  stepNearMiss,
} from '@/sim/gate-quality'
import { copy, distanceSq, type Vec3, v3 } from '@/sim/math/vec3'
import { createOrbs, type OrbsState, stepOrbs } from '@/sim/orbs'
import {
  bankNearMiss,
  bankProximity,
  createProximity,
  type ProximitySpec,
  type ProximityState,
  stepProximity,
} from '@/sim/proximity'
import {
  type ContactProbe,
  createTargets,
  type StreakEffect,
  stepTargets,
  stepTargetsProbes,
  sweepHitsBox,
  type TargetsState,
} from '@/sim/targets'

export type Medal = 'none' | 'bronze' | 'silver' | 'gold' | 'platinum'

/** Best first — the order `awardMedal` and the mid-run banner both walk. */
const BANDS = ['platinum', 'gold', 'silver', 'bronze'] as const

/**
 * What `stepMission` needs from OUTSIDE itself to run the gameplay levers.
 *
 * Passed in rather than reached for, because this function is called from the
 * fixed-step loop with a position and nothing else, and the two things G1 needs
 * — how far the ground is, and how fast the ship is going — live on the flight
 * model. Handing them over keeps `mission.ts` free of the flight and free of
 * the preset loader, which is what lets the mission tests drive it with plain
 * numbers (DEV-110).
 */
export interface MissionLevers {
  /**
   * METRES to the NEAREST probed surface — `Flight.nearestSurface()`, which is
   * `sim/surface-proximity.ts`'s fan of six probes with the belly reading as
   * the probe that needs no march (DEV-112). Before DEV-112 this was the belly
   * alone, and a canyon wall off the wingtip paid nothing. ONE number for both
   * levers, so the meter and the CLOSE banner cannot disagree about how close
   * the ground is.
   */
  readonly clearance: number
  /** Forward speed, m/s. The same quantity the whoosh and the pulse are keyed on. */
  readonly speed: number
  /** True on the tick a terrain contact begins. A strike is not a near miss. */
  readonly struck: boolean
  readonly proximity: ProximitySpec
  readonly gateEvents: GateEventSpec
  /**
   * The vehicle's ground CONTACTS, swept over the step, for the pad plates
   * (DEV-120). The JumpSeat's four feet. Absent — a HoverJet, a test, a replay
   * — and the plates are swept by the body position as before, which is right
   * for a vehicle with no feet and for the seven missions with no pads.
   */
  readonly probes?: readonly ContactProbe[] | undefined
}

/**
 * The levers, switched off, and this is what a caller that says nothing gets.
 *
 * **The default is the decision.** An absent argument means a caller that has
 * not thought about the preset — a test, a tool, a replay — and the answer for
 * one of those is the 2016 game. `maxBonus: 0` cannot move the pool and
 * `cleanCentredness: 1` is the mathematical centre of a gate, which no swept
 * segment reaches, so the levers are off twice over exactly as Classic's own
 * preset has them.
 */
export const NO_LEVERS: MissionLevers = {
  clearance: Number.POSITIVE_INFINITY,
  speed: 0,
  struck: false,
  proximity: {
    nearMetres: 0,
    farMetres: 1,
    maxBonus: 0,
    minSpeed: Number.POSITIVE_INFINITY,
    attackSeconds: 1,
    releaseSeconds: 1,
    perSecond: 0,
    awardStep: 0,
  },
  gateEvents: {
    cleanCentredness: 1,
    minSpeed: Number.POSITIVE_INFINITY,
    nearMissMetres: 0,
    nearMissCooldown: Number.POSITIVE_INFINITY,
    nearMissPoints: 0,
  },
}

/**
 * What happened in ONE sim step. Owned by the `MissionState`; see trap 19 above.
 *
 * Separate channels rather than one index, because the callers are different: a
 * ring drives the HoverJet's speed chain and its gate burst, a pad plate drives
 * a score pop, an orb drives a collect cue, `awarded` drives a 2.5 s banner that
 * only Free Flight raises, and the last three are the gameplay levers' (DEV-110).
 */
export interface MissionEvent {
  /** Ring scored this step, or -1. */
  ring: number
  /** Pad plate scored this step, or -1. Index into `state.targets.zones`. */
  padZone: number
  /**
   * Points that plate actually BANKED — its `val_score` times the multiplier it
   * met — or 0. Not the same as the plate's face value, and the gap is the whole
   * design: a bullseye at x4 is 400.
   */
  padPoints: number
  /** The multiplier it was paid at. 1 when nothing scored. */
  padMultiplier: number
  /** What that plate then did to the streak, or null. `raise` / `hold` / `reset`. */
  padEffect: StreakEffect | null
  /** The perfect-clear bonus banked THIS step, or 0. Fires once, on the last pad. */
  padClearBonus: number
  /** Orb collected this step, or -1. Index into `state.orbs.orbs`. */
  orb: number
  /**
   * A medal crossed IN THE AIR this step, or null.
   *
   * `LevelEnd.cs:202-243` tests `score == <that band's min>` — equality, not
   * `>=` — so it fires once, on the object that crosses the threshold, and
   * `AwardMedal()` returns early once `endOfLevel` is set. Only modes whose
   * descriptor says `awardWhen: 'onCrossing'` ever set this.
   */
  awarded: Medal | null
  /**
   * G1's bonus banked THIS step, in points, or 0 (DEV-110).
   *
   * Zero on Classic always, and zero on Anniversary for a gate taken high. It
   * is the amount, not the multiplier: the banner says "+60" because that is
   * what a player can add up.
   */
  proximityBonus: number
  /**
   * G2: was this step's gate CLEAN — through the middle, at speed? False when
   * nothing was taken (DEV-110).
   */
  gateClean: boolean
  /**
   * How centred that gate was, 0..1, or 0 when none was taken (DEV-110).
   *
   * Recorded rather than only compared, because `cleanCentredness` is a TUNING
   * number and a boolean cannot tell you whether it is reachable. The first
   * autopilot lap with G2 on returned `bestCleanStreak: 0` over twenty-one
   * gates, and the only way to know whether that meant "the threshold is too
   * strict" or "the autopilot flies wide" was to have the number itself.
   */
  gateCentredness: number
  /** G2: a near miss fired this step. Not a strike — a strike is not a miss. */
  nearMiss: boolean
  /**
   * POINTS that near miss banked into G1's pool this step, or 0 (DEV-112).
   *
   * The amount, for the banner — "CLOSE +25" is a sentence a player can add
   * up. Zero on Classic always: its `nearMissPoints` is 0 and the banner
   * cannot fire there either.
   */
  nearMissPoints: number
  /**
   * POINTS of the LINE channel to ANNOUNCE this step, or 0 (DEV-154).
   *
   * **Not what was banked this step** — that is a fraction of a point at 82 Hz.
   * It is what the pool has accrued since the last announcement, released in
   * whole `awardStep` chunks so the event row can say it. The banking itself
   * happens every tick inside `stepProximity` whatever this reads.
   */
  lowPoints: number
}

export interface MissionState {
  levelId: string
  /** The RUNNING mode — `level.forcedMode` has already been applied. */
  mode: GameMode
  /**
   * What a medal is awarded against, before the time bonus.
   *
   * POINTS in Ring Attack and Target Practice, a raw COUNT in Free Flight
   * (`LevelEnd.cs:186`: `score = energySystem.gatesCleared`, never `x 100`).
   * `rulesFor(state.mode).medalScale` says which, and `medalInput` applies it.
   */
  score: number
  /** The objective's progress — rings, pads landed or orbs, by mode. The HUD's numerator. */
  counted: number
  /** The objective's total. The HUD's denominator. */
  countTotal: number
  /**
   * RINGS specifically, which is not the same as `counted`.
   *
   * `rookie_02_jumpSeat` authors 29 live rings alongside its 11 pads and scores
   * none of them (§7), so in Target Practice this stays 0 while `counted`
   * climbs. Kept separate because the speed chain, the gate burst and the
   * results panel's "GATES" line are all ring-shaped.
   */
  ringsPassed: number
  ringsTotal: number
  /** Seconds of sim time elapsed. Ticks, never wall clock. */
  elapsed: number
  finished: boolean
  /** Rings. Always BUILT (the autopilot and the racers read `course.gates`), stepped only if scored. */
  course: CourseState
  /** Jump pad plates. */
  targets: TargetsState
  /** Energy orbs. */
  orbs: OrbsState
  /** The volume that ends the run, or null when the data cannot supply one. */
  finish: FinishVolume | null
  /**
   * The finish reduced to a point and a radius, for AIMING.
   *
   * The autopilot and the guide spline want somewhere to fly, not a containment
   * test — `stepMission` tests `finish`, this is what points at it. For a box it
   * carries the centre and the largest radius that fits INSIDE, so anything that
   * reaches it has genuinely finished.
   */
  finishGate: { x: number; y: number; z: number; radius: number } | null
  /**
   * True once the finish volume has been crossed — as distinct from `finished`,
   * which lags it by the mode's settle window and is also set by the clock.
   */
  finishCrossed: boolean
  /**
   * The autopilot flew the ship at some tick of this run (DEV-601). Set by
   * `boot/app.ts` beside the lap's taint; a fresh run starts false because
   * every run is a fresh `startMission`. Such a run earns no medal and keeps
   * no best: they would be the autopilot's, shown and stored as the player's.
   */
  autopilotFlew: boolean
  /** `elapsed` when the finish was crossed, or null. Starts the settle window. */
  finishAt: number | null
  /**
   * The finish pad's airspace, or null. See `finishPadAirspace` — this is what
   * makes the finish pad's own points deterministic instead of a timing race.
   */
  readonly finishAirspace: {
    readonly pad: number
    readonly centre: Vec3
    readonly radius: number
  } | null
  /** `timeBonusMultiplier * (par - elapsed)`, floored at 0. See `timeBonus`. */
  timeBonus: number
  /**
   * How many of the objective this run MISSED, when missing them is what cost
   * it a time bonus it would otherwise have earned — or 0 (DEV-393).
   *
   * Set with `timeBonus`, when the run ends. Non-zero only on a run that crossed
   * the finish inside par with something left behind, so the results panel can
   * say why the time term is 0 rather than print a `+ 0 time` a player cannot
   * explain after a 26-second finish.
   */
  timeBonusForfeit: number
  /** Bands already banked, so a mid-run banner fires once each. */
  readonly awarded: Medal[]
  /** This run's own event record. NOT a module scratch — trap 19. */
  readonly event: MissionEvent
  /**
   * G1's meter and pool, and G2's streaks (DEV-110).
   *
   * They live on the MissionState rather than beside the ship because they are
   * a property of the RUN: `restartRun` rebuilds this object and they go with
   * it, where a module-level pair would survive into the next flight. Trap 19,
   * the same argument `state.event` is here for.
   *
   * Always stepped, on both presets, and on Classic they do nothing: the
   * proximity spec's `maxBonus` is 0 so the pool cannot move, and the events
   * ask for a mathematically central gate. Stepping them unconditionally is
   * what makes the meter's own arithmetic identical between presets, so a flip
   * changes what is DRAWN and not what is computed.
   */
  readonly proximity: ProximityState
  readonly gateEvents: GateEventState
  /** Previous step's position, for the swept plate and orb tests. */
  readonly previous: Vec3
  hasPrevious: boolean
}

/**
 * Build the gates the sim tests against.
 *
 * The level JSON is THREE space and the sim is UNITY space, so every trigger
 * centre flips its z on the way in — the same conversion the ship's spawn goes
 * through, for the same reason. A course built in the wrong handedness puts
 * every gate on the mirror image of its island, which is a bug that only shows
 * up as "the rings never score".
 *
 * `points` is `addScore * gateMultiplier` multiplied out here so the sim never
 * has to know what a gate multiplier is. **It is a RING multiplier and nothing
 * else** — `scoring.gateMultiplier: 100` must never reach a pad plate, whose
 * `val_score` is already a point value (`_modes-spec.md` §2.2).
 */
export const courseGates = (level: Level): Gate[] =>
  liveRings(level).map((ring) => ({
    centre: v3(ring.trigger.pos[0], ring.trigger.pos[1], -ring.trigger.pos[2]) as Vec3,
    radius: ring.trigger.radius,
    points: ring.scoring.addScore * level.scoring.gateMultiplier,
    triggerOnce: ring.scoring.triggerOnce,
  }))

/** Per-kind readouts. Adding a collectible kind is adding a row to each. */
const SCORE_OF: Record<CollectibleKind, (s: MissionState) => number> = {
  ring: (s) => s.course.score,
  padZone: (s) => s.targets.score,
  orb: (s) => s.orbs.collected,
}

const COUNT_OF: Record<CollectibleKind, (s: MissionState) => number> = {
  ring: (s) => s.course.passedCount,
  padZone: (s) => s.targets.padsHit,
  orb: (s) => s.orbs.collected,
}

const readScores = (state: MissionState, rules: ModeRules): void => {
  let score = 0
  let counted = 0
  for (const kind of rules.scores) {
    score += (SCORE_OF[kind] as (s: MissionState) => number)(state)
    counted += (COUNT_OF[kind] as (s: MissionState) => number)(state)
  }
  state.score = score
  state.counted = counted
}

/**
 * The aim point, and why a box gets its INSCRIBED radius.
 *
 * Half the smallest extent is the largest ball that fits inside the prism, so a
 * guidance system that flies to the centre and calls it done at that radius has
 * actually entered the volume. Using the circumscribed one would let the
 * autopilot declare victory 15 m outside the trigger.
 */
const aimFor = (
  finish: FinishVolume | null,
): { x: number; y: number; z: number; radius: number } | null => {
  if (!finish) return null
  const radius =
    finish.kind === 'sphere' ? finish.radius : Math.min(finish.half.x, finish.half.y, finish.half.z)
  return { x: finish.centre.x, y: finish.centre.y, z: finish.centre.z, radius }
}

/**
 * Start a run.
 *
 * `requested` is the mode the player chose; `level.forcedMode` overrides it, and
 * the level's own `mode` stands in when nothing asked. Two shipped missions
 * force Free Flight and this is the one place that is honoured.
 *
 * **The honest degrade.** A mission whose end condition the data cannot supply
 * says so on the console, once, naming the field, the 2016 mechanism and the
 * extractor limitation — and then falls back to the clock. It does NOT guess
 * which pad carries the finale from a name table (`_modes-spec.md` §4.2), and it
 * does NOT invent a medal where 2016 awards none.
 */
export const startMission = (level: Level, requested?: GameMode): MissionState => {
  const mode = runningMode(level, requested)
  const rules = rulesFor(mode)
  const rings = liveRings(level)
  const zones = rules.live.includes('padZone') ? padZones(level) : []
  const finish = rules.endsOn === 'finishGate' ? finishFor(level) : null

  if (rules.endsOn === 'finishGate' && !finish) {
    const gap = finishGap(level)
    if (gap) console.warn(`mission: ${gap}`)
  }

  // ── A mode that can score NOTHING here, said out loud (DEV-235) ────────
  //
  // Not a vehicle/mode table. "Crossed" is derived from the CONTENT — this mode
  // scores a kind, and the level has none of it live — which is the same
  // question `countTotal` already answers and keeps `modes.ts` the only file
  // that may spell a mode (hard rule 6). A vehicle→mode table would also have
  // to decide what `energyRace` may pair with, and the answer is not in the
  // data.
  //
  // It stays a WARNING rather than a refusal, on Matt's call: the run is
  // playable — since DEV-235 both autopilots make progress across a crossed
  // pairing, the ship flies the course and reaches the finish — it simply
  // banks nothing. A refusal would put a pairing rule in `src/` that the data
  // model deliberately does not have. What this buys is a breadcrumb in the log
  // for the next measurement taken across `?mode=`, the way DEV-233 wanted; the
  // runner-side refusal in `tools/perf/vehicle-mode-sweep.mjs` is the half that
  // actually stops a number being published.
  //
  // Silent on all thirteen shipped missions, which pair each vehicle with its
  // own mode — including `rookie_02_jumpSeat`, the one course that authors both
  // 29 live rings and 7 live pads.
  const scoreable = countTotal(level, mode)
  if (scoreable === 0) {
    console.warn(
      `mission: ${level.id} is running ${mode}, which scores ` +
        `${rules.scores.join('+')} — and the level has none live. ` +
        `The run is playable and will bank nothing.`,
    )
  }

  const state: MissionState = {
    levelId: level.id,
    mode,
    score: 0,
    counted: 0,
    countTotal: scoreable,
    ringsPassed: 0,
    ringsTotal: rings.length,
    elapsed: 0,
    finished: false,
    course: createCourse(courseGates(level)),
    // `livePads`, not a second copy of the liveness rule: a dead pad has no index
    // in `zones` either, so a latch can never be spent on one. The streak's shape
    // comes from `game/targets.ts` — one fresh object per run, so two missions in
    // flight at once cannot share a multiplier (trap 19).
    targets: createTargets(zones, livePads(level).length, padStreakRules()),
    orbs: createOrbs(rules.live.includes('orb') ? orbSpheres(level) : []),
    finish,
    finishGate: aimFor(finish),
    finishCrossed: false,
    autopilotFlew: false,
    finishAt: null,
    finishAirspace: rules.endsOn === 'finishGate' ? finishPadAirspace(level) : null,
    timeBonus: 0,
    timeBonusForfeit: 0,
    awarded: [],
    event: {
      ring: -1,
      padZone: -1,
      padPoints: 0,
      padMultiplier: 1,
      padEffect: null,
      padClearBonus: 0,
      orb: -1,
      awarded: null,
      proximityBonus: 0,
      gateClean: false,
      gateCentredness: 0,
      nearMiss: false,
      nearMissPoints: 0,
      lowPoints: 0,
    },
    proximity: createProximity(),
    gateEvents: createGateEvents(),
    previous: v3(),
    hasPrevious: false,
  }
  return state
}

/**
 * The ship was PUT somewhere — it did not fly there. DEV-149.
 *
 * The one door for every teleport in the game: DEV-126's crash reset, and
 * anything that follows it. Two things follow from a placement and they are
 * the same fact twice:
 *
 *   * the swept plate and orb tests must not sweep from the wreck to the line,
 *     picking up everything between (that is `hasPrevious`, and `boot/app.ts`
 *     has cleared it since DEV-126 landed);
 *   * a TRIGGER FIRES ON AN EDGE, so a ring the ship is placed inside is a
 *     ring it is already in, and it does not score until the ship leaves and
 *     flies back through it. Without this, missing ring 1 — whose trigger
 *     centre is 1.4 m from the start of the authored line on every shipped
 *     HoverJet course — made every crash for the rest of the run a free ring.
 *
 * Idempotent, and the first `stepMission` after it seeds again from wherever
 * the ship actually is, so a caller that only clears `hasPrevious` still gets
 * the edge rule. See `sim/course.ts` for the measurement.
 */
export const placeMission = (state: MissionState, position: Vec3): void => {
  state.hasPrevious = false
  seedCourse(state.course, position)
}

/**
 * Advance one FIXED sim step. Returns the RING scored this step, or -1.
 *
 * Rings only, because the ring index is what the HoverJet's speed chain and gate
 * burst are keyed on and that is a hot path with one caller. **Everything else
 * this step did is on `state.event`** — the pad plate, the orb, and any medal
 * crossed in the air. In a mode that does not score rings this always returns
 * -1, which is the correct answer rather than a stand-in for one.
 *
 * `position` is SIM space. Never call this with a frame delta — `dt` is
 * `FIXED_DT` and the clock has to tick at the rate the flight model does or a
 * ghost recorded at one rate scores differently at another.
 *
 * The pad and orb tests are SWEPT, from the previous step's position to this
 * one. They have to be: a 25-point plate is 0.3185 m thick and an orb is 4.885 m
 * across, against 2.2–5.3 m of travel per step. A point test would drop them
 * silently and it would read as a detection bug. `sim/course.ts`'s 22 m gates
 * are the one volume big enough not to need it.
 */
export const stepMission = (
  state: MissionState,
  level: Level,
  position: Vec3,
  dt: number,
  levers: MissionLevers = NO_LEVERS,
): number => {
  const event = state.event
  event.ring = -1
  event.padZone = -1
  event.padPoints = 0
  event.padMultiplier = 1
  event.padEffect = null
  event.padClearBonus = 0
  event.orb = -1
  event.awarded = null
  event.proximityBonus = 0
  event.gateClean = false
  event.gateCentredness = 0
  event.nearMiss = false
  event.nearMissPoints = 0
  event.lowPoints = 0
  if (state.finished) return -1

  const rules = rulesFor(state.mode)
  state.elapsed += dt
  // The first step has nowhere to sweep from, so it sweeps from where it is.
  //
  // And it is the one place in the game that knows the ship was PUT here
  // rather than flown here (DEV-149). Every teleport already clears
  // `hasPrevious` — `startMission` for a fresh run or a mission swap, and
  // `boot/app.ts` on a DEV-126 crash reset, both so the swept plate and orb
  // tests do not sweep through anything on the way back. A TRIGGER fires on an
  // edge, and a placement is not one, so the gates the ship is standing in are
  // noted and none of them is scored. Without this, missing ring 1 — whose
  // trigger centre is 1.4 m from the start of the authored line on every
  // shipped HoverJet course — made every crash for the rest of the run hand it
  // to you free. See `sim/course.ts`.
  if (!state.hasPrevious) {
    copy(state.previous, position)
    state.hasPrevious = true
    seedCourse(state.course, position)
  }
  const from = state.previous

  // ── G1 and G2, the gameplay levers (DEV-110) ────────────────────────
  //
  // BEFORE the gate test, so a gate crossed this step is scored against the
  // meter as it is at the crossing rather than one step stale. Stepped
  // unconditionally on both presets: Classic's spec cannot move the pool
  // (`maxBonus` 0) and cannot call a gate clean (`cleanCentredness` 1), so the
  // arithmetic is identical and only what is DRAWN differs. That is what makes
  // an EDITION flip mid-run safe here.
  // The LINE channel banks HERE, every tick, on every mission (DEV-154). The
  // return is only what to ANNOUNCE — the banking happened inside. `perSecond`
  // is 0 on Classic and 0 in `NO_LEVERS`, so the pool cannot move there and
  // this is the shipped 2016 scorer with one more number it cannot use.
  event.lowPoints = stepProximity(
    state.proximity,
    levers.clearance,
    levers.speed,
    levers.proximity,
    dt,
  )
  event.nearMiss = stepNearMiss(
    state.gateEvents,
    levers.clearance,
    levers.speed,
    levers.struck,
    levers.gateEvents,
    dt,
  )
  // A near miss PAYS, into the same pool a low gate does (DEV-112). Gate-
  // independent, which is what closes DEV-110 §6's gap for the six missions
  // that score no rings: the pool banks here on every mission, ring or not.
  // Never into `state.score`; `readScores` still sums only the 2016 scorers.
  if (event.nearMiss) {
    event.nearMissPoints = bankNearMiss(state.proximity, levers.gateEvents.nearMissPoints)
  }

  // ── `live` ADVANCES, `scores` BANKS — and 2016 draws the line here too ──
  //
  // These two branches were gated on `rules.scores`, and that collapsed a
  // distinction 2016 makes explicitly. `TriggerCheckpoint.OnTriggerEnter`
  // disables the ring's colliders, plays `CollectRing`, disables the parent
  // checkpoint, deactivates the art, fires the effect and calls
  // `EnableNextRoute()` — all unconditionally. Exactly ONE line sits behind a
  // guard:
  //
  //     if (addScore) { if (energySystem != null) ++energySystem.gatesCleared; }
  //
  // and `energySystem` is the `EnergySystem_Ship` the JumpSeat does not have.
  // So on `rookie_02_jumpSeat` — Target Practice, 29 live rings AND 7 live pads
  // authored side by side — a 2016 ring really is consumed and really does
  // advance the route. It just never increments the counter. The port's
  // `scores` gate made the ring inert instead, which is a different game.
  //
  // `startMission` had already taken the same view from the other side: the pad
  // zones and the orbs are built from `rules.live` (`:414`, `:438`), so the
  // world was constructed for one rule and stepped under another.
  //
  // **What that cost.** Both autopilots steer by a progress counter these
  // branches own — `nextGate(course.gates, course.passed)` and
  // `jumpSeatPilot.step(targets.padTaken)` (`boot/app.ts:7589`, `:7587`). Gated
  // on `scores`, a HoverJet in Target Practice never advanced `course.passed`,
  // so `nextGate` returned 0 for ever: it flew to ring 1, was not credited, and
  // flew to ring 1 again. Measured in `perf-out/vehicle-mode/` — 1538 m inside a
  // 173x133 m box over 60 s against 7873 m for the same mission in its own mode,
  // and the two JumpSeat cells never left the spawn at all. Unreachable on the
  // thirteen shipped missions, which pair each vehicle with its own mode; it is
  // `?mode=`'s (DEV-144). DEV-233 §8 found it and left it; this is DEV-235.
  //
  // The banking stays behind `scores`, and that half is load-bearing:
  // `bankProximity` pays into a pool the results panel adds to a score, so
  // moving it would invent points 2016 never awarded — `modes.ts`'s note on
  // `ModeRules.scores` prices those 29 rings at 2,900 of them.
  if (rules.live.includes('ring')) {
    event.ring = stepCourse(state.course, position)
    if (event.ring >= 0) {
      state.ringsPassed = state.course.passedCount
      const gate = state.course.gates[event.ring] as Gate | undefined
      // `course.score` accrues either way and `readScores` refuses to read it
      // in a mode that does not score rings — the same posture the pads have
      // had in Ring Attack since `startMission` started building them.
      if (gate && rules.scores.includes('ring')) {
        // The bonus rides on the gate's OWN points, so a 25-point plate course
        // and a 100-point ring course scale together without a second number.
        event.proximityBonus = bankProximity(state.proximity, gate.points, levers.proximity)
        // Centredness on the SWEPT SEGMENT — `sim/gate-quality.ts` says why the
        // tick-sampled distance would be mostly frame rate.
        event.gateCentredness = gateCentredness(from, position, gate.centre, gate.radius)
        event.gateClean = recordGate(
          state.gateEvents,
          event.gateCentredness,
          levers.speed,
          levers.gateEvents,
        )
      }
    }
  }
  if (rules.live.includes('padZone')) {
    // Read the streak's own state either side of the step rather than having
    // `stepTargets` leave a scratch record behind on the `TargetsState` for
    // someone to read later. Same trap-19 posture as `state.event` itself: the
    // per-step record belongs to the run that asked for it, not to the scorer.
    const scoreBefore = state.targets.score
    const clearBefore = state.targets.clearBonus
    const multiplierBefore = state.targets.multiplier
    // The FEET where the vehicle has them (DEV-120): the plates sit a few
    // centimetres proud of a solid floor the body never reaches. Otherwise the
    // body's own swept segment, as before.
    event.padZone = levers.probes
      ? stepTargetsProbes(state.targets, levers.probes)
      : stepTargets(state.targets, from, position)
    if (event.padZone >= 0) {
      event.padMultiplier = multiplierBefore
      event.padEffect = state.targets.zones[event.padZone]?.streak ?? null
      event.padClearBonus = state.targets.clearBonus - clearBefore
      event.padPoints = state.targets.score - scoreBefore - event.padClearBonus
    }
  }
  if (rules.scores.includes('orb')) {
    event.orb = stepOrbs(state.orbs, from, position)
  }

  const took = event.ring >= 0 || event.padZone >= 0 || event.orb >= 0
  if (took) {
    readScores(state, rules)
    if (rules.awardWhen === 'onCrossing') event.awarded = crossedBand(state, level)
  }

  // ── What ends a run ──────────────────────────────────────────────────
  //
  // The FINISH VOLUME, or the clock — and which of those exist is the mode's
  // business, not this function's. NOT the last ring, which is what this said
  // for months under a comment asserting "2016 ends a run on the timer or on
  // the last gate" that nobody had traced.
  //
  // 2016 puts a separate, non-scoring `Trigger_FinishLine` beyond a Ring Attack
  // course and ends the run in its `OnTriggerEnter` (-> `finaleLogic.StartEnd()`).
  // On `int_01` it is **234.6 m past ring 21**, so stopping at the last ring
  // stopped a quarter of a kilometre early (DEV-045).
  //
  // A Target Practice run ends the same way, at a convex slab hidden inside one
  // pad prefab — invisible to the extractor until DEV-049 went looking, and null
  // in the level JSON for the whole life of the port before that. A Free Flight
  // run does not end at all: `endsOn: 'never'`, and 2016 leaves it from the menu.
  if (state.finish && !state.finishCrossed) {
    if (state.finish.kind === 'sphere') {
      const r = state.finish.radius
      if (distanceSq(position, state.finish.centre) <= r * r) state.finishCrossed = true
    } else if (sweepHitsBox(state.finish, from, position) >= 0) {
      state.finishCrossed = true
    }
    if (state.finishCrossed) state.finishAt = state.elapsed
  }
  // The settle, and it has two halves. `rules.finishSettleSeconds` is 2016's own
  // `Delay_CalcScore` — 0 in every mode but Target Practice. `onFinishPad` is the
  // deterministic half: the finish slab sits 6.9 m above the bullseye it is about
  // to cross, so a run that committed the instant the slab was entered would
  // throw the finish pad's own 0–100 points away at any sane descent rate. The
  // run stays open while the ship is still in that pad's own airspace and the
  // pad still has something to give. See `game/targets.ts`, `finishPadAirspace`.
  const air = state.finishAirspace
  const onFinishPad =
    air !== null &&
    state.targets.padClosed[air.pad] !== true &&
    (position.x - air.centre.x) ** 2 +
      (position.y - air.centre.y) ** 2 +
      (position.z - air.centre.z) ** 2 <=
      air.radius * air.radius
  const settled =
    state.finishAt !== null &&
    state.elapsed >= state.finishAt + rules.finishSettleSeconds &&
    !onFinishPad
  // `clockEnds`, not `clock`. The clock RUNS in Target Practice and ends
  // nothing — 2016's timeout looks for a `Trigger_FinishLine` no JumpSeat scene
  // has. Enforcing it made two of the six missions unwinnable. DEV-056.
  const timeUp =
    rules.clockEnds && level.timer.timeLimit > 0 && state.elapsed >= level.timer.timeLimit
  if (settled || timeUp) {
    state.finished = true
    state.timeBonus = timeBonus(state, level)
    state.timeBonusForfeit = timeBonusForfeit(state, level)
  }

  copy(state.previous, position)
  return event.ring
}

/**
 * The band crossed EXACTLY this step, or null.
 *
 * Equality, because that is what `LevelEnd.cs:202-243` does, and the highest
 * band first, because the chain there awards the best one reached. The
 * `awarded` list makes it once-only even if a count could revisit a threshold.
 */
const crossedBand = (state: MissionState, level: Level): Medal | null => {
  const curve = medalCurve(level, state.mode)
  if (!curve) return null
  const input = medalInput(state)
  for (const band of BANDS) {
    if (curve[band] !== input) continue
    if (state.awarded.includes(band)) return null
    state.awarded.push(band)
    return band
  }
  return null
}

/**
 * The time bonus, and the two ways a mode can switch it off.
 *
 * `Scoreboard.cs:14` has `private double timeBonusMultiplier = 11.5` — a code
 * default, so shipped behaviour — and `bonusParTime` is 180 s on every mission.
 * 2016 computed a bonus and DISPLAYED it, but the medal came from rings alone
 * (DEV-004 / DEV-014). FF2 deliberately lets time count, and since DEV-846 it
 * counts a bounded, course-scaled term rather than 2016's 11.5 a second (which
 * stays in `level.scoring` and the lap server's `score2016`).
 *
 * It is zero when the mode has no clock (`RaceTimer.cs:30` disables itself in
 * Free Flight) and zero when the mode's descriptor says it earns none. Those
 * used to be one test — `medalScale !== 'points'` stood in for both — and the
 * accuracy streak is what pulled them apart: Target Practice moved onto a points
 * scale and would have started paying up to ~2,070 points for a fast run, on a
 * mode whose whole design is that time is NOT the axis. See `ModeRules.timeBonus`.
 * Target Practice therefore scores its pads and times the run without the two
 * interfering, which is also what 2016 does: `CalcScore()` computes `timeScore`
 * and throws it away (`ScoreKeeper_JumpPads.cs:54, 67`).
 *
 * ── DEV-393: and a MISSED objective forfeits it ──────────────────────────
 *
 * Matt, 2026-09-25: *"medals should be awarded based on performance"*. Before
 * this, `int_01_hoverJet` flown straight to the finish with **0 of 21 rings** in
 * about 26 s scored a SILVER (`docs/BUGS.md`), because 11.5 points a spare second
 * is worth more than any ring a detour costs.
 *
 * DEV-004 rested on a premise it wrote down — *"a run that misses a ring never
 * ends early, so it earns no time bonus and scores rings alone"* — and that was
 * true only while `stepMission` ended a run at the LAST RING. DEV-045 moved the
 * end to 2016's own `Trigger_FinishLine`, which ends a run whatever it has
 * taken, and the premise quietly became false. So the premise is now the RULE:
 * the bonus is paid only on a run that took every one of its objective
 * ({@link tookEvery}). What follows, with every ring worth the same 100:
 *
 *   · an incomplete run scores its rings alone — which is 2016's own medal
 *     number (`LevelEnd.cs` `CalcScore`, `gatesCleared * gateMultiplier`), so
 *     bronze, silver and gold are 2016's again, on both editions;
 *   · one more ring always out-scores one fewer, whatever the clock says;
 *   · among clean runs, the faster scores more, and only a clean run can reach
 *     platinum. Since the DEV-393 follow-up (Matt: *"gold medal = 90, plat =
 *     100"*) platinum was the ring ceiling itself, so EVERY clean run reached it
 *     and the bonus only ordered them. **DEV-846 (Matt, 2026-10-08: "speed was
 *     an influence") puts the clock back in the medal, bounded:** the bonus is
 *     now at most one ring's worth, scaled to the course, and platinum asks for
 *     every ring plus half of it (`game/medal-time.ts` has the numbers), so a
 *     slow clean lap is gold and a quick one platinum.
 *
 * It is also the order the lap server already ranks a board by — every ring,
 * then time (PLAYER-GHOSTS §8 call 3; `net/lap-validate.ts`).
 */
export const timeBonus = (state: MissionState, level: Level): number =>
  tookEvery(state) ? clockBonus(state, level) : 0

/**
 * What the clock alone would pay this run, before DEV-393 asks whether the run
 * earned it. Zero where the mode or the level pays none, and past par.
 */
const clockBonus = (state: MissionState, level: Level): number => {
  const rules = rulesFor(state.mode)
  if (!clockCountsInMedal(level, rules)) return 0
  // DEV-846: a bounded term scaled to the course (`game/medal-time.ts`), not
  // 2016's 11.5 a spare second against a flat 180 s par. The 2016 formula is
  // still in `level.scoring` and in the lap server's `score2016`, untouched.
  const term = timeTermFor(level) as NonNullable<ReturnType<typeof timeTermFor>>
  return timePoints(term, state.elapsed)
}

/**
 * Did this run take every one of its objective? DEV-393.
 *
 * The OBJECTIVE, not the rings, so the rule is the mode row's rather than Ring
 * Attack's: `counted` and `countTotal` are whatever the mode scores. A course
 * with nothing to take has not been taken — the rule never pays a bonus for an
 * empty course (DEV-235's crossed pairings bank nothing, and still do).
 */
export const tookEvery = (state: MissionState): boolean =>
  state.countTotal > 0 && state.counted >= state.countTotal

/**
 * How many of the objective cost this run a time bonus, or 0. DEV-393.
 *
 * Non-zero only where the clock WOULD have paid — a run that crossed inside par
 * — and something was left behind. A run the clock ended has no bonus to lose,
 * so it forfeits nothing, whatever it missed.
 */
export const timeBonusForfeit = (state: MissionState, level: Level): number =>
  !tookEvery(state) && clockBonus(state, level) > 0
    ? Math.max(0, state.countTotal - state.counted)
    : 0

/** The objective's own score, without the time bonus — the 2016 number. */
export const ringScore = (state: MissionState): number => state.score

/**
 * The score a medal is awarded against, on a POINTS scale.
 *
 * Rings plus the time bonus, and the bonus is only ever non-zero on a run that
 * took EVERY ring and crossed the finish inside par — so an incomplete run
 * scores rings alone and the 2016 bronze/silver/gold still mean what they meant
 * (DEV-004). That sentence was true by accident until DEV-045 moved the end of
 * a run to the finish gate; DEV-393 makes it true by rule (see `timeBonus`).
 */
export const missionScore = (state: MissionState): number => state.score + state.timeBonus

/**
 * The number the thresholds are compared against, on whichever scale is running.
 *
 * `'count'` modes compare a raw number of OBJECTS — Free Flight's orbs — and must
 * never see a point total. Target Practice was one of them until the accuracy
 * streak landed and gave it a points ceiling worth judging against; the scale is
 * `MEDAL_RULE_SCALE`'s answer in `game/modes.ts`, one row per rule, so the two
 * halves of that decision cannot be taken separately.
 */
export const medalInput = (state: MissionState): number =>
  rulesFor(state.mode).medalScale === 'count' ? state.counted : missionScore(state)

/**
 * The RING curve: FF2's thresholds (`medalsFf2`: 2016's, with platinum at every
 * ring), falling back to 2016's.
 *
 * **Superseded by `medalFor` / `medalCurve`, and kept only so the existing
 * `src/boot/app.ts` call sites keep compiling while the wiring is swapped.** It
 * answers for Ring Attack and is wrong for the other two modes by construction:
 * Free Flight awards against a raw orb count and Target Practice awards nothing
 * at all in 2016. Delete it once `app.ts` reads `medalFor(mission, level)`.
 */
export const medalsFor = (level: Level): Medals => level.medalsFf2 ?? level.medals

/** The thresholds this mode awards against, or null when it awards none. */
export const medalThresholds = (level: Level, mode: GameMode): Medals | null =>
  medalCurve(level, mode)

export const awardMedal = (score: number, medals: Medals): Medal => {
  if (score >= medals.platinum) return 'platinum'
  if (score >= medals.gold) return 'gold'
  if (score >= medals.silver) return 'silver'
  if (score >= medals.bronze) return 'bronze'
  return 'none'
}

/**
 * This run's medal, or **null when the mode awards none at all**.
 *
 * The null is load-bearing and it is a FACT to preserve: 2016 never awards a
 * medal in a JumpSeat mission (`_modes-spec.md` §5.1), and `rookie_01_jumpSeat`
 * has no thresholds of any kind because it has no `finale_logic` instance. A
 * caller that wants to print something should print nothing here, not "NONE".
 */
export const medalFor = (state: MissionState, level: Level): Medal | null => {
  const curve = medalCurve(level, state.mode)
  return curve ? awardMedal(medalInput(state), curve) : null
}

/**
 * 2016's own mid-run banner text, with the medal filled in.
 *
 * `level.ui.strings.medalAwarded` is **byte-exact** and reads
 * `________ medal AwarDeD!` — eight underscores where the name goes, a lower-case
 * `medal`, and a stray capital D that the port must not tidy (see `LevelUi`).
 * Every one of the thirteen missions carries it, JumpSeat set included, so the
 * fallback is for hand-authored courses only.
 */
export const medalBanner = (level: Level, medal: Medal): string => {
  const template = level.ui?.strings?.medalAwarded
  return template ? template.replace(/_{2,}/, medal) : `${medal} medal awarded!`
}

/**
 * What the HUD's TIME row should be given as its limit.
 *
 * Zero in a mode with no clock, which is what makes `hud.ts` print `--`. The
 * observable form of `RaceTimer.cs:30`.
 */
export const hudTimeLimit = (level: Level, mode: GameMode): number =>
  rulesFor(mode).clock ? level.timer.timeLimit : 0

/**
 * The streak multiplier a plate crossed right now would be paid at.
 *
 * A door, so `src/boot/app.ts` and `render/hud.ts` never reach into
 * `mission.targets` — and so that a run in a mode with no pads answers 1 rather
 * than needing the caller to know that.
 */
export const streakMultiplier = (state: MissionState): number => state.targets.multiplier

/**
 * How long a pad-hit banner stays on the panel, seconds.
 *
 * A READABILITY value, not a design knob. It has to be long enough to read at a
 * glance and short enough that it is gone before the next pad: the tightest
 * nearest-neighbour gap on any of the six missions is 288 m, which at the
 * JumpSeat's measured 34.45 m/s cruise is **8.3 s**, so anything under about
 * eight seconds cannot overlap. 1.6 s is the same order as 2016's own 2.5 s
 * medal banner (`LevelEnd.DisableMedalUI()`) and leaves the panel showing
 * instruments most of the time, which is what instruments are for.
 */
export const PAD_BANNER_SECONDS = 1.6

/** A pad-hit banner: what to print, and whether it is good news. */
export interface PadBanner {
  readonly text: string
  /** `'gain'` draws in the panel's accent; `'loss'` draws muted. See `render/hud.ts`. */
  readonly tone: 'gain' | 'loss'
  readonly seconds: number
}

/**
 * **The streak, made visible.** A pad hit as one short line, or null.
 *
 * A streak the player cannot see is a spreadsheet, and the failure mode here is
 * the one CLAUDE.md names twice: *a thing that is too small, too dark, too fast
 * or off-screen has not been reviewed, it has been rendered.* So a bullseye and
 * a graze have to differ in more than one channel — the WORD differs, the number
 * differs, and `tone` makes the colour differ, because at 0.4 m across and read
 * in peripheral vision while flying, colour is the channel that survives.
 *
 * Four readings, in the order they beat each other:
 *
 *   · the perfect clear   `ALL 6 PADS +600`    — the biggest thing that can
 *                                                happen, so it takes the line
 *                                                even on a step that also scored
 *                                                a plate
 *   · a raise (bullseye)  `BULLSEYE +400`
 *   · a hold  (mid plate) `+150`
 *   · a break (outer)     `+50  STREAK LOST`   — and only when there WAS a
 *                                                streak; breaking a x1 has cost
 *                                                nothing and must not be dressed
 *                                                up as a loss
 *
 * The words are FF2's. 2016 has no string for any of this: the JumpSeat `ui`
 * set carries a fuel gauge and nothing else, and `HUD_Gameplay.UpdateUI()` is
 * commented out end to end (`:56-83`), so the in-mission HUD showed no live
 * score at all. Recorded here rather than smuggled in as if extracted.
 */
export const padBanner = (event: MissionEvent, padCount: number): PadBanner | null => {
  if (event.padZone < 0) return null
  if (event.padClearBonus > 0) {
    return {
      text: `ALL ${padCount} PADS +${event.padClearBonus}`,
      tone: 'gain',
      seconds: PAD_BANNER_SECONDS,
    }
  }
  if (event.padEffect === 'raise') {
    return { text: `BULLSEYE +${event.padPoints}`, tone: 'gain', seconds: PAD_BANNER_SECONDS }
  }
  if (event.padEffect === 'reset' || event.padEffect === 'decay') {
    // `padMultiplier` is what it was paid at, i.e. what it is about to lose.
    const lost = event.padMultiplier > 1
    return {
      text: lost ? `+${event.padPoints}  STREAK LOST` : `+${event.padPoints}`,
      tone: lost ? 'loss' : 'gain',
      seconds: PAD_BANNER_SECONDS,
    }
  }
  return { text: `+${event.padPoints}`, tone: 'gain', seconds: PAD_BANNER_SECONDS }
}

export { countLabel, countTotal, runningMode }
