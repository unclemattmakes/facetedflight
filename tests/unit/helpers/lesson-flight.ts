// tests/unit/helpers/lesson-flight.ts — a lesson, flown headless by a scripted student. DEV-378.
//
// NOT a `.test.ts`, so vitest does not collect it. `tests/unit/lesson-canyon.test.ts`
// flies both canyon lessons through it: the GOLDEN LESSON of
// `docs/plan/FLIGHT-INSTRUCTOR.md` §9, *"a scripted student (the player
// autopilot, plus a roll-and-release for the bank step and a held boost for the
// boost step) completes every step on the real ground"*.
//
// ── What is real here, and what is a copy ─────────────────────────────────
//
// REAL, called as the game calls it: the lesson's step machine
// (`game/lesson.ts`'s `stepLesson`, `instructorSpec`, `bankDegrees`), the
// instructor (DEV-376's pace through `stepRacerField`, the SAME door
// `game/lesson-session.ts` steps it through), the flight model, the ground
// contact, the crash rule, the prop colliders, the energy tank, the speed
// chain, the lift (`sim/launch.ts`), the mission's scorer and the player
// autopilot's controller (`autopilotActions` + `routeGuidance`).
//
// A COPY, because the originals live behind a renderer and cannot run in node:
//
//   - the READING. `game/lesson-session.ts`'s `tick` builds it from the live
//     game; `createLessonSession` also builds the instructor's hull (a GLB
//     fetch) and the plate (a canvas), so this file builds the same reading
//     from the same functions (`raceProgress`, `routeAt`, `bankDegrees`, the
//     0.5 held-axis rule) at the top of the loop below. If `tick` changes what it
//     measures, this must follow; the header of `tick` is the place to look.
//   - the player AUTOPILOT's call site (`boot/app.ts`, "Follow the LINE"): the
//     same `routeGuidance` options (`playerRouteOptions` off
//     `DEFAULT_AUTOPILOT`, shared with the app since DEV-524), the profile read
//     `profileLookSeconds` ahead, and the one profile number `app.ts` takes
//     from `game/measured.ts` (`SHIP_LAT_ACCEL` 162, imported here too);
//     the rest are the jet's own, `speedProfileModel` (DEV-394).
//   - the fixed step's ORDER: the lesson (and its instructor) at the top of the
//     step, above the lift's early return; then the lift; then energy, flight,
//     ground, props, crash, mission and chain, as `boot/app.ts` runs them.
//   - the instructor's START: `game/racers.ts`'s `startPaced` (seed on the
//     line at its arc, at rest, holding), which is not exported.
//
// ── The student ───────────────────────────────────────────────────────────
//
// The player's autopilot, held to a speed per step — the throttle ceiling
// `sim/instructor.ts`'s `paceTuning` gives the instructor, for the same reason
// (the profile band alone settles over its target) — and told what to do by a
// SCRIPT keyed on step id. The script never reads a trigger's numbers: a
// student does what the plate says (roll, let go, roll back; hold boost), and
// whether that ends the step is the lesson's question. That is what lets a
// broken trigger STALL the golden run instead of the student following it.

import type { Edition } from '@/content/edition-schema'
import type { Lesson, Level } from '@/content/level-schema'
import {
  bankDegrees,
  capStudentActions,
  createLessonRun,
  instructorSpec,
  type LessonReading,
  type LessonRun,
  pitchDegrees,
  stepLesson,
  studentCapOf,
} from '@/game/lesson'
import { HOVERJET_LAT_ACCEL_MEASURED as SHIP_LAT_ACCEL } from '@/game/measured'
import { placeMission, startMission, stepMission } from '@/game/mission'
import { type RaceProgress, raceProgress } from '@/game/race-place'
import { threeQuatTupleToUnity, threeTupleToUnity } from '@/render/unity-space'
import {
  AI_RACER_TUNINGS,
  type AiRacer,
  createAiRacer,
  gateArcLengths,
  seedRacerAt,
} from '@/sim/ai-racer'
import {
  type AutopilotTuning,
  autopilotActions,
  DEFAULT_AUTOPILOT,
  nextGate,
  playerRouteOptions,
} from '@/sim/autopilot'
import { createBoundary } from '@/sim/boundary'
import { FIXED_DT } from '@/sim/constants'
import type { Gate } from '@/sim/course'
import { crashHoldsShip, crashLimitS, createCrash, stepCrashAndBoundary } from '@/sim/crash'
import { createEnergy, energySpec, stepEnergy } from '@/sim/energy'
import {
  createHoverJet,
  cruiseSpeed,
  type HoverJet,
  type HoverJetSheet,
  noInput,
  speedProfileModel,
  stepHoverJet,
} from '@/sim/hoverjet'
import { createInstructorPace, holdInstructorAt, type InstructorPace } from '@/sim/instructor'
import { createLaunch, type LaunchSpec, startLaunch, stepLaunch } from '@/sim/launch'
import { lookAlong, quat, rotateVec3 } from '@/sim/math/quat'
import { type Vec3, v3 } from '@/sim/math/vec3'
import {
  createPropCollision,
  type PropColliders,
  type PropCollisionSpec,
  stepPropCollision,
} from '@/sim/props/collision'
import { createRacerField, stepRacerField } from '@/sim/racer-field'
import {
  createRoute,
  createRouteCursor,
  type Route,
  routeArcLengthNear,
  routeArcThrough,
  routeAt,
  routeGuidance,
  routeTangentAt,
  speedLimitAt,
  withSpeedProfile,
} from '@/sim/route'
import { chainedMaxSpeed, chainGate } from '@/sim/speed-chain'
import { type HeightField, outsideField, terrainHeightAt } from '@/sim/terrain/height-field'
import {
  createGroundContact,
  createTerrainCollision,
  HOVERJET_GROUND,
  stepGroundContact,
} from '@/sim/terrain-collision'

/** `lesson-session.ts`'s `HELD_AXIS`: more than half an analogue axis is held. */
const HELD_AXIS = 0.5

const X_AXIS = v3(1, 0, 0)

/** What the student does while one step is up. */
export interface StudentStep {
  /**
   * The speed it flies at, m/s — or `'race'`: the player's autopilot exactly,
   * boost held and the stick fully forward, which is what "race me home" asks.
   */
  readonly speed: number | 'race'
  /** Hold boost (under the speed). */
  readonly boost?: boolean
  /**
   * The bank step's gesture: roll right to `rollTo` degrees, let go for
   * `releaseSeconds`, then roll back to level and hold it there.
   */
  readonly bank?: { readonly rollTo: number; readonly releaseSeconds: number }
  /**
   * DEV-790: a NEW player's hands, over everything the autopilot said: full
   * throttle, no steering, and (when `pullAfter` is given) the stick pulled
   * back for `pullFor` seconds once `pullAfter` seconds of this step have
   * gone, then let go. It is the measured playtest scenario of
   * `docs/plan/PLAYTEST-PERSONAS-2026-10-03.md` "Lesson 1, measured": the
   * throttle held from the first second, and a reaction that takes a second.
   */
  readonly novice?: { readonly pullAfter?: number; readonly pullFor?: number }
}

export interface StudentScript {
  /** Seconds on the pad before the launch press, for an elevator start. */
  readonly launchAfter: number
  /** By step id. A step with no entry is a script that has fallen behind its lesson: it throws. */
  readonly steps: Readonly<Record<string, StudentStep>>
}

export interface LessonFlightOptions {
  readonly level: Level
  readonly edition: Edition
  readonly script: StudentScript
  /** The collision surface, avoided and hit (desert has no ocean, so one list). */
  readonly ground: readonly HeightField[]
  /** The preset's forest, or null. Its `broken` flags are cleared before the run. */
  readonly props: PropColliders | null
  readonly limitSeconds: number
  /**
   * DEV-790: do NOT hold the student to a step's `student.maxSpeed`. The
   * negative control: the same flight as the game did before the cap.
   */
  readonly uncapped?: boolean
  /** Replace the lesson the level carries — a broken trigger, for the negative control. */
  readonly lesson?: Lesson
  /**
   * The aircraft variant's view of the sheet (DEV-380), flown by the student
   * AND the instructor — `lesson-session.ts` hands the player's sheet to the
   * instructor (DEV-382 follow-up). Absent: 2016's HoverJet.
   */
  readonly sheet?: HoverJetSheet
  /** Called at the top of every tick with the reading the lesson is given. For probes. */
  readonly observe?: (time: number, reading: LessonReading, body: HoverJet['body']) => void
}

export interface StepRecord {
  readonly id: string
  /** Sim seconds from boot (the pad) at which the step came up. */
  readonly startedAt: number
  /** ... and ended, or NaN if it never did. */
  endedAt: number
  /** Rings passed when it came up and when it ended. */
  readonly ringsAtStart: number
  ringsAtEnd: number
  /** The instructor's gap over the step's flying ticks, and the ticks the two hulls touched. */
  gapMin: number
  gapMax: number
  craftContactTicks: number
  holds: number
}

export interface LessonFlight {
  readonly steps: StepRecord[]
  readonly done: boolean
  /** Seconds from the release to the lesson's end (or to the limit). */
  readonly flyingSeconds: number
  /** The step up when the flight stopped, or null once done. */
  readonly stalledAt: string | null
  readonly interrupts: { readonly id: string; readonly at: number; readonly step: string }[]
  readonly crashes: number
  readonly contacts: number
  readonly rings: number
  readonly finished: boolean
  /** The instructor's gap while the student flew and the step did not race: the extremes. */
  readonly gap: { readonly max: number; readonly min: number; readonly ticks: number }
  /** How often the instructor went to HOLD while the student flew. */
  readonly holds: number
  readonly instructorCrashes: number
  /** Ticks on which the student's hull and the instructor's touched (DEV-364's contact). */
  readonly craftContactTicks: number
  /** The student's bank at the END of the let-go, degrees: the bank staying (DEV-001). */
  readonly bankAfterRelease: number | null
  /** The lowest the student flew over the ground, metres, once released. */
  readonly minAgl: number
  /** The fastest the student flew, m/s. */
  readonly topSpeed: number
}

const ticksOf = (seconds: number): number => Math.ceil(seconds / FIXED_DT)

/** The lowest clearance over any field under (x, z), or Infinity. */
const aglOf = (fields: readonly HeightField[], x: number, y: number, z: number): number => {
  let worst = Number.POSITIVE_INFINITY
  for (const f of fields) {
    if (outsideField(f, x, z)) continue
    worst = Math.min(worst, y - terrainHeightAt(f, x, z))
  }
  return worst
}

/**
 * The student's tuning for a step: the player's autopilot, with boost as the
 * script says and a throttle CEILING that makes `speed` its terminal —
 * `paceTuning`'s arithmetic, on the student's own jet (its chain and boost).
 */
const studentTuning = (jet: HoverJet, step: StudentStep, out: AutopilotTuning): AutopilotTuning => {
  const t = out as { -readonly [K in keyof AutopilotTuning]: AutopilotTuning[K] }
  Object.assign(t, DEFAULT_AUTOPILOT)
  if (step.speed === 'race') return t
  const boost = step.boost === true
  t.boost = boost
  const thrust =
    chainedMaxSpeed(jet.chain, jet.chainSpec, jet.tuning.maxSpeed) *
    (boost ? jet.tuning.boostMultiplier : 1)
  const terminal = cruiseSpeed(jet.sheet, thrust)
  const ceiling = terminal > 0 ? step.speed / terminal : 0
  if (ceiling < t.maxThrottle) t.maxThrottle = ceiling
  if (ceiling < t.minThrottle) t.minThrottle = ceiling
  return t
}

/**
 * Fly `options.level`'s lesson from the pad (or the airborne spawn) to its end
 * or `limitSeconds`. Deterministic: the same options give the same flight.
 */
export const flyLesson = (options: LessonFlightOptions): LessonFlight => {
  const { level, edition, script, ground } = options
  const lesson = options.lesson ?? (level.lesson as Lesson | null | undefined)
  if (!lesson) throw new Error(`${level.id} carries no lesson`)
  const gameplay = edition.gameplay

  // ── the course and its line, as `boot/app.ts` builds them ────────────────
  const mission = startMission(level)
  const gates: readonly Gate[] = mission.course.gates
  const points = (level as { route?: number[][] }).route
  if (!points || points.length < 2) throw new Error(`${level.id} has no racing line`)
  const student = options.sheet ? createHoverJet(options.sheet) : createHoverJet()
  const route: Route = createRoute(points)
  withSpeedProfile(route, speedProfileModel(student.sheet, SHIP_LAT_ACCEL))
  const line = { route, gateArc: gateArcLengths(route, gates) }
  const finishSphere = level.finish
    ? {
        x: level.finish.pos[0] as number,
        y: level.finish.pos[1] as number,
        z: -(level.finish.pos[2] as number),
        radius: level.finish.radius,
      }
    : null
  // Where the line runs through the finish, as `app.ts`'s guide keeps it (DEV-394).
  const homeArc = finishSphere
    ? routeArcThrough(route, finishSphere, finishSphere.radius)
    : Number.NaN

  // ── the instructor: `lesson-session.ts` + `racers.ts`'s `startPaced` ─────
  const tuning = AI_RACER_TUNINGS[lesson.instructor.tuning]
  if (!tuning) throw new Error(`no tuning ${lesson.instructor.tuning}`)
  const specs = lesson.steps.map((_, i) => instructorSpec(lesson, i))
  const specFor = (i: number) => specs[Math.min(i, specs.length - 1)] as (typeof specs)[number]
  const pace: InstructorPace = createInstructorPace(specFor(0), tuning)
  const startAt = routeAt(route, lesson.instructor.startArcMetres, v3())
  const startQ = lookAlong(quat(), routeTangentAt(route, lesson.instructor.startArcMetres, v3()))
  const instructor: AiRacer = createAiRacer(
    {
      id: 'instructor',
      spawn: startAt,
      orientation: [startQ.x, startQ.y, startQ.z, startQ.w],
      tuning,
      sheet: options.sheet,
    },
    gates,
    finishSphere,
    pace,
  )
  const startArc = routeArcLengthNear(route, instructor.spec.spawn)
  seedRacerAt(instructor, line, startArc, 0)
  holdInstructorAt(pace, instructor.jet.body.position, startArc)
  const field = createRacerField([instructor], route)

  // ── the student, on the pad or in the air ────────────────────────────────
  student.launched = true
  threeTupleToUnity(student.body.position, level.spawn.pos as number[])
  threeQuatTupleToUnity(student.body.orientation, level.spawn.quat as number[])
  const baseY = student.body.position.y
  const ride = level.spawn.launch
  const launchSpec: LaunchSpec | null = ride
    ? {
        keys: ride.keys,
        releaseAtSeconds: ride.releaseAtSeconds,
        countdownSteps: level.timer.countdown?.steps ?? 0,
        countdownStepSeconds: level.timer.countdown?.stepSeconds ?? 0,
        // The lesson keeps the ride (FLIGHT-INSTRUCTOR §11 call 3).
        skipRide: false,
      }
    : null
  const launch = createLaunch(launchSpec)
  if (launchSpec) student.body.position.y = baseY + launch.rise
  const contact = createGroundContact(student.body.angularDrag)
  const propState = createPropCollision()
  const props = gameplay.propCollision.enabled ? options.props : null
  if (props) props.broken.fill(0)
  const propSpec = gameplay.propCollision as unknown as PropCollisionSpec
  const crash = createCrash()
  const boundary = createBoundary()
  const crashCourse = { route, limitS: 0 }
  const energyOn = gameplay.energy.enabled
  const eSpec = energySpec(gameplay.energy.rechargeScale, student.sheet)
  const energy = createEnergy(eSpec)
  const crashSpec = gameplay.crash

  // ── the lesson ───────────────────────────────────────────────────────────
  const run: LessonRun = createLessonRun(lesson)
  const progress: RaceProgress = { reached: 0, arc: 0 }
  const foot = v3()
  const held = { throttle: false, boost: false, brake: false, airbrake: false }
  const input = noInput()
  const guideCursor = createRouteCursor()
  const aim = v3()
  const beyond = v3()
  const scratchTuning = { ...DEFAULT_AUTOPILOT }
  const right = v3()

  // What the tick reads that the previous tick wrote (`lesson-session.ts`'s
  // "the mission, the crash and the contact are the PREVIOUS tick's").
  let lastCrashes = 0
  let struck = false
  let impactSpeed = 0

  const steps: StepRecord[] = []
  const interrupts: { id: string; at: number; step: string }[] = []
  let time = 0
  let releasedAt = Number.NaN
  let gapMax = Number.NEGATIVE_INFINITY
  let gapMin = Number.POSITIVE_INFINITY
  let gapTicks = 0
  let holds = 0
  let lastMode = pace.mode
  let instructorCrashes = 0
  let craftContactTicks = 0
  let contacts = 0
  let minAgl = Number.POSITIVE_INFINITY
  let topSpeed = 0
  let bankAfterRelease: number | null = null
  // The bank gesture's own state: which phase, and since when.
  let bankPhase: 'roll' | 'release' | 'level' = 'roll'
  let bankSince = 0
  let bankStep = -1
  // The novice's own clock: the step it is flying and when that step came up.
  let noviceStep = -1
  let noviceSince = 0

  const openStep = (i: number): void => {
    const s = lesson.steps[i]
    if (!s) return
    steps.push({
      id: s.id,
      startedAt: time,
      endedAt: Number.NaN,
      ringsAtStart: mission.course.passedCount,
      ringsAtEnd: Number.NaN,
      gapMin: Number.POSITIVE_INFINITY,
      gapMax: Number.NEGATIVE_INFINITY,
      craftContactTicks: 0,
      holds: 0,
    })
  }
  openStep(0)

  const limit = ticksOf(options.limitSeconds)
  for (let tick = 0; tick < limit && !run.done; tick++) {
    time = tick * FIXED_DT
    const flying = launch.phase === 'flying'
    const body = student.body
    const v = body.velocity
    const speed = Math.hypot(v.x, v.y, v.z)

    // ── 1. the lesson, at the top of the step (lesson-session.ts's `tick`) ──
    raceProgress(line, mission.course.passed, body.position, progress)
    routeAt(route, progress.arc, foot)
    held.throttle = input.throttle > HELD_AXIS
    held.boost = input.boost
    held.brake = input.brake
    held.airbrake = false
    const reading: LessonReading = {
      dt: FIXED_DT,
      launched: launch.phase !== 'waiting',
      flying,
      speed,
      bankDegrees: bankDegrees(body.orientation),
      pitchDegrees: pitchDegrees(body.orientation),
      held,
      crossTrack: Math.hypot(
        body.position.x - foot.x,
        body.position.y - foot.y,
        body.position.z - foot.z,
      ),
      passed: mission.course.passed,
      gate: mission.event.ring,
      gateClean: mission.event.gateClean,
      cleanGates: gameplay.gateEvents.enabled,
      finished: mission.finishCrossed,
      crashed: crash.count > lastCrashes,
      contactLoss: struck ? impactSpeed : 0,
    }
    lastCrashes = crash.count
    const stepBefore = run.step
    options.observe?.(time, reading, body)
    stepLesson(run, reading)
    if (run.event === 'interrupt') {
      const int = lesson.interrupts[run.interrupt]
      interrupts.push({ id: int?.id ?? '?', at: time, step: lesson.steps[run.step]?.id ?? '?' })
    }
    if (run.step !== stepBefore) {
      const rec = steps[steps.length - 1] as StepRecord
      rec.endedAt = time
      rec.ringsAtEnd = mission.course.passedCount
      openStep(run.step)
    }
    // The instructor, paced by this step, off this student.
    pace.spec = specFor(run.step)
    const studentHeld = !flying || crashHoldsShip(crash) || run.interrupt >= 0
    stepRacerField(
      field,
      [instructor],
      gates,
      ground,
      FIXED_DT,
      line,
      ground,
      crashSpec,
      props ? { colliders: props, spec: propSpec } : null,
      {
        separation: gameplay.racers.separation,
        contact: gameplay.racers.contact,
        player: flying && !crashHoldsShip(crash) ? body : null,
        student: { arc: progress.arc, speed, position: body.position, held: studentHeld },
      },
    )
    if (instructor.crashEvent === 'crashed') instructorCrashes++
    const now = steps[steps.length - 1] as StepRecord
    if (field.contact.contacts > 0) {
      craftContactTicks++
      now.craftContactTicks++
    }
    const race = specFor(run.step).race
    if (flying && !studentHeld) {
      now.gapMax = Math.max(now.gapMax, pace.gap)
      now.gapMin = Math.min(now.gapMin, pace.gap)
      if (pace.mode === 'hold' && lastMode !== 'hold') now.holds++
    }
    if (flying && !studentHeld && !race) {
      gapMax = Math.max(gapMax, pace.gap)
      gapMin = Math.min(gapMin, pace.gap)
      gapTicks++
      if (pace.mode === 'hold' && lastMode !== 'hold') holds++
    }
    lastMode = pace.mode
    if (run.done) break

    const stepId = lesson.steps[run.step]?.id as string
    const plan = script.steps[stepId]
    if (!plan) throw new Error(`the student has no script for step "${stepId}"`)

    // ── 2. the lift: the press, the ride, the countdown ──────────────────────
    if (launchSpec && launch.phase !== 'flying') {
      if (launch.phase === 'waiting' && time >= script.launchAfter) startLaunch(launch, launchSpec)
      const released = stepLaunch(launch, launchSpec, FIXED_DT)
      body.position.y = baseY + launch.rise
      v.x = 0
      v.y = 0
      v.z = 0
      body.angularVelocity.x = 0
      body.angularVelocity.y = 0
      body.angularVelocity.z = 0
      if (released) {
        releasedAt = time
        placeMission(mission, body.position)
      }
      continue
    }
    if (Number.isNaN(releasedAt)) releasedAt = time

    // ── 3. the student's hands ────────────────────────────────────────────
    const target = nextGate(gates, mission.course.passed)
    const t = studentTuning(student, plan, scratchTuning)
    // DEV-394: the run home is flown on the line too where the line runs
    // through the finish, as `app.ts` flies it; gate to gate where it does not.
    const home = target < 0 && finishSphere && Number.isFinite(homeArc) ? finishSphere : null
    if (target >= 0 || home) {
      const centre = target >= 0 ? (gates[target] as Gate).centre : (home as Vec3)
      const onLine = routeGuidance(
        route,
        guideCursor,
        body.position,
        // DEV-524: the player's own options, the ones `boot/app.ts` passes.
        playerRouteOptions(
          DEFAULT_AUTOPILOT,
          speed,
          target >= 0 ? (line.gateArc[target] ?? Number.POSITIVE_INFINITY) : homeArc,
          centre,
          beyond,
        ),
        aim,
      )
      const profile = onLine
        ? speedLimitAt(route, guideCursor.s + speed * DEFAULT_AUTOPILOT.profileLookSeconds)
        : Number.POSITIVE_INFINITY
      const want = plan.speed === 'race' ? profile : Math.min(profile, plan.speed)
      autopilotActions(
        body,
        onLine ? aim : centre,
        input,
        t,
        ground,
        onLine ? guideCursor.offset : Number.POSITIVE_INFINITY,
        onLine ? beyond : target >= 0 ? (gates[target + 1]?.centre ?? finishSphere ?? null) : null,
        want,
        student,
      )
    } else if (finishSphere) {
      // The run home, gate to gate, as `app.ts` flies it past the last ring.
      autopilotActions(
        body,
        finishSphere,
        input,
        t,
        ground,
        Number.POSITIVE_INFINITY,
        null,
        Number.POSITIVE_INFINITY,
        student,
      )
    }

    // The bank step: roll, let go, roll back, over whatever the autopilot said.
    if (plan.bank) {
      if (bankStep !== run.step) {
        bankStep = run.step
        bankPhase = 'roll'
        bankSince = time
      }
      const bank = bankDegrees(body.orientation)
      if (bankPhase === 'roll') {
        input.roll = 1
        if (bank >= plan.bank.rollTo) {
          bankPhase = 'release'
          bankSince = time
        }
      } else if (bankPhase === 'release') {
        input.roll = 0
        if (time - bankSince >= plan.bank.releaseSeconds) {
          bankAfterRelease = bank
          bankPhase = 'level'
        }
      } else {
        // Back to level and held there: the autopilot's own roll law
        // (`-right.y x rollGain`) asked for no bank at all, which is what
        // `bankRatio` 0 would ask for — a student levelling the wings by eye.
        rotateVec3(right, body.orientation, X_AXIS)
        input.roll = Math.max(-1, Math.min(1, -right.y * DEFAULT_AUTOPILOT.rollGain))
      }
    }

    // DEV-790: a new player's hands, over the autopilot.
    if (plan.novice) {
      if (noviceStep !== run.step) {
        noviceStep = run.step
        noviceSince = time
      }
      const since = time - noviceSince
      const pull = plan.novice.pullAfter
      input.throttle = 1
      input.boost = false
      input.brake = false
      input.roll = 0
      input.yaw = 0
      input.pitch =
        pull !== undefined && since >= pull && since < pull + (plan.novice.pullFor ?? 0) ? -1 : 0
    }

    // ── 4. the tank, the flight, the ground, the forest, the crash ──────────
    // DEV-790: the lesson's ceiling on the student, as `boot/app.ts` holds the
    // stick to it before the flight step.
    if (!options.uncapped) {
      const capped = capStudentActions(input, speed, studentCapOf(lesson, run.step))
      if (capped !== input) Object.assign(input, capped)
    }
    if (energyOn) input.boost = stepEnergy(energy, eSpec, input.boost, FIXED_DT)
    const heldByCrash = crashHoldsShip(crash)
    if (!heldByCrash) {
      stepHoverJet(student, input)
      struck = stepGroundContact(contact, body, ground, HOVERJET_GROUND, FIXED_DT)
      impactSpeed = contact.collision.impactSpeed
      if (struck) contacts++
      if (props) stepPropCollision(propState, body, HOVERJET_GROUND.collision.hull, props, propSpec)
    } else {
      struck = false
      impactSpeed = 0
    }
    crashCourse.limitS = crashLimitS(line.gateArc, mission.course.passed, route.length)
    const hazards = stepCrashAndBoundary(
      crash,
      crashSpec,
      boundary,
      null,
      body,
      contact.collision.impactSpeed,
      crashCourse,
      ground,
      FIXED_DT,
      props ? { colliders: props, hull: HOVERJET_GROUND.collision.hull } : null,
    )
    if (hazards.crash === 'reset') {
      // `flight.placeAt`: a cold engine and a fresh contact state.
      student.currentThrust = 0
      Object.assign(contact.collision, createTerrainCollision())
      body.angularDrag = contact.baseAngularDrag
      placeMission(mission, body.position)
    }

    // ── 5. the mission and the chain ─────────────────────────────────────────
    const ring = stepMission(mission, level, body.position, FIXED_DT)
    if (ring >= 0) chainGate(student.chain)
    minAgl = Math.min(minAgl, aglOf(ground, body.position.x, body.position.y, body.position.z))
    topSpeed = Math.max(topSpeed, speed)
  }

  const last = steps[steps.length - 1] as StepRecord
  return {
    steps,
    done: run.done,
    flyingSeconds: Number.isNaN(releasedAt) ? 0 : time - releasedAt,
    stalledAt: run.done ? null : last.id,
    interrupts,
    crashes: crash.count,
    contacts,
    rings: mission.course.passedCount,
    finished: mission.finishCrossed,
    gap: { max: gapMax, min: gapMin, ticks: gapTicks },
    holds,
    instructorCrashes,
    craftContactTicks,
    bankAfterRelease,
    minAgl,
    topSpeed,
  }
}
