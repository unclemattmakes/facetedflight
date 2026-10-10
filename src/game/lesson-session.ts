// src/game/lesson-session.ts — one lesson, running: the step machine, the
// instructor and the plate, behind the four calls `boot/app.ts` makes. DEV-377.
//
// `docs/plan/FLIGHT-INSTRUCTOR.md` §9 puts the app wiring in ONE contiguous
// block of `boot/app.ts`. What a lesson needs from the running game is a
// reading per fixed step, a view per frame, a restart and a teardown, so that
// is the whole surface here and everything else stays in this file:
//
//   - `game/lesson.ts` judges the READING (pure; the step, the interrupt);
//   - the INSTRUCTOR is an `AiRacer` with DEV-376's pace, built through
//     `game/racers.ts` so it has a racer's hull, trails and interpolation — a
//     one-craft field, stepped through the same door (DEV-364's
//     `stepRacerField`), and NOT in `liveRacers`: not an opponent, not in the
//     standings, the results or the race map (§4.1 item 5);
//   - the PLATE is `render/lesson-plate.ts`, its words resolved per device by
//     `render/controls-menu.ts`.
//
// ── Where a tick's reading comes from ─────────────────────────────────────
//
// `app.ts` calls `tick` at the TOP of its fixed step, above the lift's early
// return (like DEV-146's traffic), so the lesson runs through the ride — step 0
// is the launch press, and the instructor turns to face you while you rise.
// Up there the mission, the crash and the contact are the PREVIOUS tick's:
// one fixed step (12 ms) late, and each seen exactly once — the contact flag
// and the ring event are per-tick fields that the next `flight.step` and
// `stepMission` overwrite, and the crash is read as its count moving.
//
// A RESTART of the run is a restart of the lesson. `restartRun` (the pause
// menu's Restart, fly-again, a course switch) calls `restart`; the one restart
// that does not pass through it — an out-of-bounds death, which rebuilds the
// run inside the fixed step — is read from state, the run's clock going
// backwards.

import type * as THREE from 'three'
import type { AudioEvent } from '@/audio/events'
import type { ComfortSettings } from '@/boot/settings'
import type { SpeedUnitId } from '@/content/edition-schema'
import {
  type Lesson,
  type LessonInputAction,
  type Level,
  lessonSpeedTarget,
} from '@/content/level-schema'
import type { EditionState } from '@/game/edition'
import {
  bankDegrees,
  createLessonRun,
  instructorSpec,
  type LessonReading,
  type LessonRun,
  lessonPrompt,
  pitchDegrees,
  resetLesson,
  skipStep,
  stepLesson,
  studentCapOf,
} from '@/game/lesson'
import { type RaceProgress, raceProgress } from '@/game/race-place'
import type { RacerStart } from '@/game/racer-grid'
import { type LoadedRacers, loadRacers, PADS_ONLY } from '@/game/racers'
import { type ControlsDevice, resolveLessonText } from '@/render/controls-menu'
import { formatSpeed } from '@/render/hud'
import { createLessonPlate, type LessonPlate } from '@/render/lesson-plate'
import { hexSrgb } from '@/render/racer-livery'
import { AI_RACER_TUNINGS, type AiRacer } from '@/sim/ai-racer'
import { nextGate } from '@/sim/autopilot'
import type { Gate } from '@/sim/course'
import type { CrashSpec } from '@/sim/crash'
import type { HoverJetSheet } from '@/sim/hoverjet'
import { createInstructorPace, type InstructorPaceSpec } from '@/sim/instructor'
import type { LaunchPhase } from '@/sim/launch'
import { lookAlong, type Quat, quat } from '@/sim/math/quat'
import { type Vec3, v3 } from '@/sim/math/vec3'
import type { PropColliders, PropCollisionSpec } from '@/sim/props/collision'
import type { RacerFieldRules } from '@/sim/racer-field'
import { type Route, routeAt, routeTangentAt } from '@/sim/route'
import type { HeightField } from '@/sim/terrain/height-field'

/** The line a lesson is measured along: the guide `app.ts` builds, with its speed profile. */
export interface LessonLine {
  readonly route: Route
  readonly gateArc: readonly number[]
}

export interface LessonSessionOptions {
  readonly level: Level
  /** The mission's gates — the course the player scores (`mission.course.gates`). */
  readonly gates: readonly Gate[]
  readonly line: LessonLine
  /** The live preset: the instructor's livery switch and its wing trails. */
  readonly edition: Pick<EditionState, 'current' | 'subscribe' | 'speedFx'>
  /** Where the two chirps go. */
  readonly audio: (event: AudioEvent) => void
  /**
   * The machine the instructor flies: the PLAYER's view of the HoverJet sheet
   * (DEV-382 follow-up). The instructor is a racer, and racers fly your
   * variant, so a student on the speed jet is led by a speed jet, and the
   * pace law's throttle ceiling reads that jet (`sim/instructor.ts`). Absent:
   * 2016's sheet.
   */
  readonly sheet?: HoverJetSheet | undefined
}

/** What the running game hands the lesson, once per fixed step. SIM space. */
export interface LessonTickInput {
  readonly dt: number
  readonly launchPhase: LaunchPhase
  readonly body: {
    readonly position: Vec3
    readonly velocity: Vec3
    readonly orientation: Quat
  }
  /** The stick as the flight model was last handed it (the autopilot's, while it flies). */
  readonly actions: {
    readonly throttle: number
    readonly boost: boolean
    readonly brake: boolean
    readonly airbrake: boolean
  }
  readonly passed: readonly boolean[]
  /** `mission.event.ring`: the ring taken on the last step, or -1. */
  readonly gate: number
  readonly gateClean: boolean
  /** `gameplay.gateEvents.enabled`. */
  readonly cleanGates: boolean
  /** `mission.finishCrossed`. */
  readonly finished: boolean
  /** `mission.elapsed`: the run's clock, whose going BACKWARDS is a restart. */
  readonly runSeconds: number
  /** `crash.count`: a crash is this moving. */
  readonly crashes: number
  /** The crash rule is holding the ship where it hit. */
  readonly crashHeld: boolean
  /** `flight.struck` and `flight.impactSpeed`: a contact that began, and its speed into the surface. */
  readonly struck: boolean
  readonly impactSpeed: number
  // ── the instructor's world, exactly as `liveRacers.step` is handed it ──
  readonly terrain: readonly HeightField[]
  readonly ground: readonly HeightField[]
  readonly crash: CrashSpec | null
  readonly props: {
    readonly colliders: PropColliders
    readonly spec: PropCollisionSpec
  } | null
  readonly rules: Omit<RacerFieldRules, 'student'>
}

/** What the running game hands the lesson, once per frame. */
export interface LessonFrameInput {
  /** A FRAME delta: the plate's fade is a look, not a rule. */
  readonly dt: number
  /** The wing trails' own delta — 0 while the sim is held (DEV-358). */
  readonly wingDt: number
  /** `stepFixed`'s interpolation factor, for the instructor's pose. */
  readonly alpha: number
  /** The camera's WORLD position, for the trails' ribbons. */
  readonly eye: THREE.Vector3
  readonly settings: ComfortSettings
  readonly device: ControlsDevice
  /** The preset's `hud.speedUnit`: `{speed}` is printed as the dash prints it. */
  readonly speedUnit: SpeedUnitId
  /** Whether the plate is up at all — the mission screen, not paused, no results panel. */
  readonly visible: boolean
  /** Third person: the plate goes on the lens. */
  readonly thirdPerson: boolean
  readonly camera: THREE.Camera
  /** The briefing plate, whose parent and pose the lesson plate takes in the seat. */
  readonly briefing: THREE.Object3D
}

/** What `__ff2.lesson()` reads. Plain values. */
export interface LessonProbe {
  readonly step: number
  readonly steps: number
  readonly stepId: string | null
  readonly interrupt: string | null
  readonly done: boolean
  readonly event: string
  readonly plate: { readonly key: string; readonly title: string; readonly text: string } | null
  readonly plateVisible: boolean
  readonly student: { readonly arc: number; readonly speed: number; readonly held: boolean }
  readonly instructor: {
    readonly id: string
    readonly mode: string
    readonly gap: number
    readonly target: number
    readonly settled: boolean
    readonly speed: number
    readonly position: readonly [number, number, number]
    /**
     * The instructor's jet's thrust and roll torque — two keys a HoverJet
     * variant scales — so a spec can hold the instructor to the player's
     * machine (DEV-382 follow-up) from outside the page.
     */
    readonly thrust: number
    readonly rollRate: number
  }
}

export interface LessonSession {
  readonly run: LessonRun
  readonly instructor: AiRacer
  /** The instructor's one-craft field: its hull, trails and step. */
  readonly racers: LoadedRacers
  readonly plate: LessonPlate
  tick(input: LessonTickInput): void
  /**
   * The speed ceiling the step that is up puts on the student, m/s, or null
   * (DEV-790). `boot/app.ts` holds the stick to it before the flight step.
   */
  studentCap(): number | null
  frame(view: LessonFrameInput): void
  /** Back to step 0, and the instructor to its start: the run restarted. */
  restart(): void
  /** The pause menu's *Skip step*. */
  skip(): void
  probe(): LessonProbe
  dispose(): void
}

/**
 * The instructor's start, as `racer-grid.ts` writes one: on the line at `arc`,
 * nose down the line, in THREE space (the z mirror, and its quaternion, which
 * are each their own inverse — `render/unity-space.ts`).
 */
export const startOnLine = (route: Route, arc: number, tuning: string): RacerStart => {
  const at = routeAt(route, arc, v3())
  const q = lookAlong(quat(), routeTangentAt(route, arc, v3()))
  return {
    pos: [at.x, at.y, -at.z],
    quat: [-q.x, -q.y, q.z, q.w],
    from: { kind: 'slot', index: 0 },
    tuning,
  }
}

/**
 * Held for the `input` trigger: more than half of an analogue axis. A trigger
 * resting against its dead zone is not a player holding the throttle.
 */
const HELD_AXIS = 0.5

/** Volatile: the student's foot on the line, valid inside one `tick`. */
const _foot = v3()

export const createLessonSession = async (
  options: LessonSessionOptions,
): Promise<LessonSession> => {
  const { level, gates, line } = options
  const lesson = level.lesson as Lesson | null | undefined
  if (!lesson) throw new Error(`lesson: ${level.id} carries no lesson block`)
  // DEV-375 checked the tuning's SHAPE only, and left the name to where the
  // racer is built — here, as `game/racers.ts` checks an edition's.
  const tuning = AI_RACER_TUNINGS[lesson.instructor.tuning]
  if (!tuning) {
    throw new Error(
      `lesson: ${level.id}'s instructor.tuning "${lesson.instructor.tuning}" is not one of ` +
        Object.keys(AI_RACER_TUNINGS).join(', '),
    )
  }
  // One spec per step, built once: the pace reads `spec` every tick, and a
  // step change is a pointer swap rather than an allocation.
  const specs: readonly InstructorPaceSpec[] = lesson.steps.map((_, i) => instructorSpec(lesson, i))
  const specFor = (step: number): InstructorPaceSpec =>
    specs[Math.min(step, specs.length - 1)] as InstructorPaceSpec

  const run = createLessonRun(lesson)
  const pace = createInstructorPace(specFor(0), tuning)
  const racers = await loadRacers(level, gates, true, PADS_ONLY, {
    starts: [startOnLine(line.route, lesson.instructor.startArcMetres, lesson.instructor.tuning)],
    guide: line,
    edition: options.edition,
    paces: [pace],
    palette: [hexSrgb(lesson.instructor.colour)],
    sheet: options.sheet,
  })
  racers.group.name = 'lesson-instructor'
  const instructor = racers.racers[0] as AiRacer
  const plate = createLessonPlate()

  // ── the student, and the edges the tick reads ───────────────────────────
  const progress: RaceProgress = { reached: 0, arc: 0 }
  const student = { arc: 0, speed: 0, position: v3(), held: true }
  const held: Record<LessonInputAction, boolean> = {
    throttle: false,
    boost: false,
    brake: false,
    airbrake: false,
  }
  let lastCrashes = 0
  let lastRunSeconds = 0
  let plateVisible = false
  /** The course's `passed`, as the last tick read it: the mission's own array. */
  let passedNow: readonly boolean[] = []

  const restart = (): void => {
    resetLesson(run)
    pace.spec = specFor(0)
    // `reset` puts a paced racer back where it started, holding (DEV-377's
    // fix to `game/racers.ts`, the note DEV-376 left).
    racers.reset()
    // The run this lesson is reading is a new one: its clock is back at zero,
    // so the next tick must not read that as a second restart.
    lastRunSeconds = 0
  }

  const say = (event: LessonRun['event']): void => {
    if (event === 'none') return
    // A step done is the rising pair; anything else that changes the plate is
    // the prompt chirp. The pair is the louder news, so a step that completes
    // AND puts up the next prompt chirps once, not twice.
    const done = event === 'step' || event === 'skip' || event === 'done'
    options.audio({ type: done ? 'lesson.done' : 'lesson.prompt' })
    const prompt = lessonPrompt(run)
    console.info(
      prompt
        ? `lesson: ${event} — ${prompt.number}/${lesson.steps.length} ${prompt.key}`
        : `lesson: ${event} — the lesson is done`,
    )
  }

  return {
    run,
    instructor,
    racers,
    plate,

    tick(input) {
      // ── the restart nobody called: the run's clock going backwards ──────
      // `app.ts`'s `restartRun` calls `restart` itself; an out-of-bounds death
      // rebuilds the run inside the fixed step without passing through it.
      if (input.runSeconds < lastRunSeconds) {
        restart()
        lastCrashes = input.crashes
      }
      lastRunSeconds = input.runSeconds
      passedNow = input.passed

      // ── the reading ───────────────────────────────────────────────────
      const p = input.body.position
      const v = input.body.velocity
      const speed = Math.hypot(v.x, v.y, v.z)
      raceProgress(line, input.passed, p, progress)
      routeAt(line.route, progress.arc, _foot)
      held.throttle = input.actions.throttle > HELD_AXIS
      held.boost = input.actions.boost
      held.brake = input.actions.brake
      held.airbrake = input.actions.airbrake
      const reading: LessonReading = {
        dt: input.dt,
        launched: input.launchPhase !== 'waiting',
        flying: input.launchPhase === 'flying',
        speed,
        bankDegrees: bankDegrees(input.body.orientation),
        pitchDegrees: pitchDegrees(input.body.orientation),
        held,
        crossTrack: Math.hypot(p.x - _foot.x, p.y - _foot.y, p.z - _foot.z),
        passed: input.passed,
        gate: input.gate,
        gateClean: input.gateClean,
        cleanGates: input.cleanGates,
        finished: input.finished,
        crashed: input.crashes > lastCrashes,
        contactLoss: input.struck ? input.impactSpeed : 0,
      }
      lastCrashes = input.crashes
      stepLesson(run, reading)
      say(run.event)

      // ── the instructor, paced by this step, off this student ─────────────
      pace.spec = specFor(run.step)
      student.arc = progress.arc
      student.speed = speed
      student.position.x = p.x
      student.position.y = p.y
      student.position.z = p.z
      // It waits while you cannot fly the course: the pad and the lift, a
      // crash hold, and any interrupt that is up (DEV-376 §5).
      student.held = !reading.flying || input.crashHeld || run.interrupt >= 0
      racers.step(input.terrain, input.dt, input.ground, input.crash, input.props, {
        ...input.rules,
        student,
      })
    },

    frame(view) {
      const prompt = lessonPrompt(run)
      // `{nextRing}` is 1-based, the ring a player reads; past the last, the last.
      const next = nextGate(gates, passedNow)
      // `{target}`: the speed the prompt that is up asks for, off its own
      // `until` (DEV-378), in the same unit as `{speed}`.
      const until =
        run.interrupt >= 0 ? lesson.interrupts[run.interrupt]?.until : lesson.steps[run.step]?.until
      const target = until ? lessonSpeedTarget(until) : null
      const values = {
        nextRing: next >= 0 ? next + 1 : gates.length,
        // The dash's own words for the speed, so the two agree (DEV-377).
        speed: formatSpeed(student.speed, view.speedUnit),
        target: target === null ? null : formatSpeed(target, view.speedUnit),
      }
      const resolve = (text: string): string =>
        resolveLessonText(text, view.settings, view.device, values)
      plate.update(
        prompt
          ? {
              key: prompt.key,
              title: `${prompt.number} · ${resolve(prompt.title)}`,
              text: resolve(prompt.say),
            }
          : null,
        view.dt,
      )
      plateVisible = view.visible
      plate.setVisible(view.visible)
      if (view.thirdPerson) plate.placeOnLens(view.camera)
      else plate.placeInSeat(view.briefing)
      racers.render(view.alpha, view.eye, view.dt, view.wingDt)
    },

    restart,

    studentCap() {
      return run.done ? null : studentCapOf(lesson, run.step)
    },

    skip() {
      skipStep(run)
      say(run.event)
    },

    probe() {
      const prompt = lessonPrompt(run)
      const shown = plate.shown
      const body = instructor.jet.body
      const iv = body.velocity
      return {
        step: run.step,
        steps: lesson.steps.length,
        stepId: prompt ? (lesson.steps[run.step]?.id ?? null) : null,
        interrupt: run.interrupt >= 0 ? (lesson.interrupts[run.interrupt]?.id ?? null) : null,
        done: run.done,
        event: run.event,
        plate: shown ? { key: shown.key, title: shown.title, text: shown.text } : null,
        plateVisible,
        student: { arc: student.arc, speed: student.speed, held: student.held },
        instructor: {
          id: instructor.spec.id,
          mode: pace.mode,
          gap: pace.gap,
          target: pace.target,
          settled: pace.settled,
          speed: Math.hypot(iv.x, iv.y, iv.z),
          position: [body.position.x, body.position.y, body.position.z],
          thrust: instructor.jet.tuning.maxSpeed,
          rollRate: instructor.jet.tuning.rollRate,
        },
      }
    },

    dispose() {
      plate.dispose()
      racers.group.removeFromParent()
      racers.dispose()
    },
  }
}
