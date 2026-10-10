// src/game/lesson.ts — the lesson's step machine. DEV-377.
//
// Matt, 2026-09-24: *"want to learn to fly - add an ai-pilot flight instructor
// course through the canyon"*. `docs/plan/FLIGHT-INSTRUCTOR.md` §5 is how it
// teaches, §6 the content it reads, §9 this row.
//
// ── What it is ────────────────────────────────────────────────────────────
//
// A per-tick READING in, the step and any interrupt out. Pure: no three, no
// DOM, no clock of its own — `dt` arrives on the reading, so a lesson flown
// headless and a lesson flown in a browser are the same lesson to the bit.
// The level's `lesson` block (DEV-375) is the whole script; nothing here names
// a step, a ring or a mission, which is hard rule 6's allowance: a second
// course is a second JSON file.
//
// ── The rules, each one a sentence of the plan ────────────────────────────
//
//   1. **A step ends on its TRIGGER and nothing else.** Never on a ring alone
//      (unless its trigger is a ring), never on a timer the author did not
//      write, never on its own: a player who flies the leg badly still
//      finishes the step once they have done the thing (§3). `skipStep` is the
//      pause menu's *Skip step* (§7), and it is the one door that is not a
//      trigger.
//   2. **An interrupt HOLDS the step and hands it back where it was** (§3).
//      While one is up the step's trigger is not read at all — its timers do
//      not run and its sequence does not advance — and when the interrupt's own
//      `until` comes true the same step, in the same state, is live again.
//   3. **Interrupts are live only while the ship is flying.** §3 says "once
//      flying" of `stopped`, and it is true of all of them: on the pad, on the
//      lift and through the countdown a ship at 0 m/s is not stopped, it is
//      waiting.
//   4. **The interrupt list is its own priority order.** While one is up, only
//      one EARLIER in the list may replace it. Without that, two whose `on`
//      stay true together (lost AND stopped, 200 m off the line at rest) take
//      the plate in turns for ever, a prompt flapping every three seconds.
//      With it, the author's order says which one a player reads.
//   5. **`sequence` is in order, and not out of it.** Only the member that is
//      up is read; one that was true before its turn counts for nothing. The
//      bank step's `levelFor` means *level AFTER banking*, and a ship that was
//      level first has not done it.
//
// ── Why a trigger carries STATE ───────────────────────────────────────────
//
// Four kinds hold a condition for a time (`speedAtLeast`, `speedAtMost`,
// `levelFor`, `input`), `seconds` counts the time it has been up, and
// `sequence` has a place. That state lives in a `TriggerState` per trigger,
// owned by the run — trap 19 — and is thrown away whenever the trigger stops
// being the one that is read, so a hold never carries across a step, an
// interrupt or a sequence member.
//
// The `passGate` of a ring the player took BEFORE its step came up is true at
// once. `course.passed` is state, not an edge, and a step about ring 3 is done
// by a player who flew ring 3 early.

import type { Lesson, LessonInputAction, LessonStep, LessonTrigger } from '@/content/level-schema'
import type { InstructorPaceSpec } from '@/sim/instructor'
import { type Quat, rotateVec3 } from '@/sim/math/quat'
import { v3 } from '@/sim/math/vec3'

/**
 * What the machine reads, once per fixed step. The caller measures it; the
 * machine judges it. Every field is a plain number or flag, so a test can hand
 * one in with no world at all.
 */
export interface LessonReading {
  /** Seconds this reading covers — the fixed step. */
  readonly dt: number
  /** The launch phase has left `waiting`: the launch was pressed. */
  readonly launched: boolean
  /** The launch phase is `flying`: the lift has let go and the stick is the player's. */
  readonly flying: boolean
  /** Airspeed, m/s. */
  readonly speed: number
  /** Degrees the wings are rolled from level, 0 to 180. {@link bankDegrees}. */
  readonly bankDegrees: number
  /** Degrees the nose is above the horizon, -90 to 90. {@link pitchDegrees}. DEV-892. */
  readonly pitchDegrees: number
  /** Which of the input actions are held. */
  readonly held: Readonly<Record<LessonInputAction, boolean>>
  /** Metres from the ship to the racing line; `Infinity` where there is no line. */
  readonly crossTrack: number
  /** The course's `passed` array: ring i taken. */
  readonly passed: readonly boolean[]
  /** The ring taken THIS tick, or -1. */
  readonly gate: number
  /** Whether that ring was a CLEAN gate (DEV-110's event). */
  readonly gateClean: boolean
  /** Whether the preset has CLEAN gate events at all (`gameplay.gateEvents.enabled`). */
  readonly cleanGates: boolean
  /** The finish gate has been crossed. */
  readonly finished: boolean
  /** The crash rule fired THIS tick (DEV-126). */
  readonly crashed: boolean
  /** m/s into the surface at a contact that began THIS tick, 0 otherwise. */
  readonly contactLoss: number
}

/**
 * One trigger's memory. Mutable, owned by the run, reset by
 * {@link resetTrigger} whenever the trigger stops being read.
 */
export interface TriggerState {
  /** Seconds its condition has held, unbroken. The four hold kinds. */
  held: number
  /** Seconds it has been the trigger being read. `seconds`. */
  elapsed: number
  /** The sequence member that is up. `sequence`. */
  index: number
  /** That member's own state. `sequence`; null until it is first read. */
  child: TriggerState | null
}

export const createTrigger = (): TriggerState => ({ held: 0, elapsed: 0, index: 0, child: null })

export const resetTrigger = (s: TriggerState): void => {
  s.held = 0
  s.elapsed = 0
  s.index = 0
  s.child = null
}

/**
 * What happened on the last {@link stepLesson}, for the chirps and the console.
 *
 * - `start`     the first tick: step 0's prompt is up
 * - `step`      a step's trigger came true and the next one is up
 * - `skip`      the pause menu's *Skip step* moved it on
 * - `interrupt` an interrupt took the plate
 * - `resume`    the interrupt's `until` came true and the step is back
 * - `done`      the last step's trigger came true
 */
export type LessonEvent = 'none' | 'start' | 'step' | 'skip' | 'interrupt' | 'resume' | 'done'

/** One run of a lesson. Per run, never shared — trap 19. */
export interface LessonRun {
  readonly lesson: Lesson
  /** The step that is up; `steps.length` once the lesson is done. */
  step: number
  /** The interrupt that is up, or -1. */
  interrupt: number
  done: boolean
  /** The live step's `until`. */
  readonly until: TriggerState
  /** The live interrupt's `until`. */
  readonly interruptUntil: TriggerState
  /** Each interrupt's `on`, in list order. */
  readonly on: TriggerState[]
  /**
   * Rings taken CLEAN, latched as the events arrive, for `passGate` with
   * `clean`. The event is an edge and the step may come up after it.
   */
  readonly clean: boolean[]
  /** Whether a tick has run since the start or the last reset. */
  started: boolean
  /** What the last tick did. */
  event: LessonEvent
  /** The step that completed on the last tick (by its trigger or a skip), or -1. */
  completed: number
}

export const createLessonRun = (lesson: Lesson): LessonRun => ({
  lesson,
  step: 0,
  interrupt: -1,
  done: false,
  until: createTrigger(),
  interruptUntil: createTrigger(),
  on: lesson.interrupts.map(() => createTrigger()),
  clean: [],
  started: false,
  event: 'none',
  completed: -1,
})

/** Back to step 0, as a fresh run: a restart of the mission is a restart of the lesson. */
export const resetLesson = (run: LessonRun): void => {
  run.step = 0
  run.interrupt = -1
  run.done = false
  resetTrigger(run.until)
  resetTrigger(run.interruptUntil)
  for (const s of run.on) resetTrigger(s)
  run.clean.length = 0
  run.started = false
  run.event = 'none'
  run.completed = -1
}

/** Held for `need` seconds, unbroken. `need` 0 is true the tick it holds. */
const holdFor = (s: TriggerState, cond: boolean, need: number, dt: number): boolean => {
  if (!cond) {
    s.held = 0
    return false
  }
  s.held += dt
  return s.held >= need
}

/**
 * Is `t` true this tick? Advances `s`. One case per kind of
 * `LESSON_TRIGGERS` — the `never` at the bottom makes a kind added to the
 * vocabulary without a case here a type error, not a step that never ends.
 */
export const stepTrigger = (
  t: LessonTrigger,
  s: TriggerState,
  r: LessonReading,
  clean: readonly boolean[] = [],
): boolean => {
  s.elapsed += r.dt
  switch (t.kind) {
    case 'launched':
      return r.launched
    case 'speedAtLeast':
      return holdFor(s, r.speed >= t.mps, t.forSeconds, r.dt)
    case 'speedAtMost':
      return holdFor(s, r.speed <= t.mps, t.forSeconds, r.dt)
    case 'passGate':
      // With `clean`, a CLEAN gate where the preset has them and a plain pass
      // where it does not (§6.2): Classic has no clean gates to ask for.
      return t.clean === true && r.cleanGates ? clean[t.ring] === true : r.passed[t.ring] === true
    case 'bankAtLeast':
      return r.bankDegrees >= t.degrees
    case 'levelFor':
      return holdFor(s, r.bankDegrees <= t.degrees, t.seconds, r.dt)
    case 'input':
      return holdFor(s, r.held[t.action], t.forSeconds, r.dt)
    case 'onLineWithin':
      return r.crossTrack <= t.metres
    case 'offLineBeyond':
      return r.crossTrack > t.metres
    case 'noseAbove':
      return r.pitchDegrees > t.degrees
    case 'noseBelow':
      return r.pitchDegrees <= t.degrees
    case 'finish':
      return r.finished
    case 'seconds':
      return s.elapsed >= t.n
    case 'sequence': {
      const member = t.of[s.index]
      if (!member) return true
      if (!s.child) s.child = createTrigger()
      if (stepTrigger(member, s.child, r, clean)) {
        // The next member starts fresh on the NEXT tick: one member per tick,
        // so a member is never judged on the tick its predecessor came true.
        s.index += 1
        s.child = null
      }
      return s.index >= t.of.length
    }
    case 'crash':
      return r.crashed
    case 'contact':
      return r.contactLoss >= t.mps
    default: {
      const never: never = t
      throw new Error(`lesson: no rule for trigger ${JSON.stringify(never)}`)
    }
  }
}

/**
 * One fixed step of the lesson. Writes `run.event` and `run.completed`, and
 * the step, the interrupt and every trigger's state.
 */
export const stepLesson = (run: LessonRun, r: LessonReading): LessonRun => {
  run.event = run.started ? 'none' : 'start'
  run.started = true
  run.completed = -1
  if (r.gate >= 0 && r.gateClean) run.clean[r.gate] = true
  if (run.done) return run
  const { steps, interrupts } = run.lesson

  // ── rule 2's one exception: a FINISH is not held (DEV-379) ─────────────
  //
  // A step that ends on the finish ends there whatever is up. The course is
  // over: nothing an interrupt could ask for afterwards can be flown, and
  // `lost`, which clears only back near the line, can never clear past its
  // end. So a student who strayed past `offLineBeyond` and then flew straight
  // into the finish crossed it under *Turn back* and never got `lesson.done`
  // (DEV-378 §6). Read before the interrupts, so none can take the plate on
  // the crossing tick either. Only a step whose OWN trigger is the finish:
  // crossing it with the bank step still up does not do the bank step (rule 1).
  const up = steps[run.step] as LessonStep
  if (r.finished && up.until.kind === 'finish') {
    run.interrupt = -1
    resetTrigger(run.interruptUntil)
    for (const o of run.on) resetTrigger(o)
    advance(run, 'step')
    return run
  }

  // ── the interrupts: rule 3 (flying only) and rule 4 (list order) ────────
  if (r.flying) {
    const above = run.interrupt >= 0 ? run.interrupt : interrupts.length
    for (let j = 0; j < interrupts.length; j++) {
      const s = run.on[j] as TriggerState
      // Not read, so not remembered: a lower interrupt starts from nothing
      // when the one above it clears.
      if (j >= above) {
        resetTrigger(s)
        continue
      }
      if (stepTrigger((interrupts[j] as (typeof interrupts)[number]).on, s, r, run.clean)) {
        run.interrupt = j
        resetTrigger(run.interruptUntil)
        for (const o of run.on) resetTrigger(o)
        run.event = 'interrupt'
        return run
      }
    }
  } else {
    for (const s of run.on) resetTrigger(s)
  }

  // ── rule 2: an interrupt holds the step ─────────────────────────────────
  if (run.interrupt >= 0) {
    const int = interrupts[run.interrupt] as (typeof interrupts)[number]
    // Its `until` is read only while flying, like its `on`: a clock that ran
    // on the pad could clear a prompt nobody had flown.
    if (r.flying && stepTrigger(int.until, run.interruptUntil, r, run.clean)) {
      run.interrupt = -1
      resetTrigger(run.interruptUntil)
      run.event = 'resume'
    }
    return run
  }

  // ── rule 1: the step ends on its trigger ────────────────────────────────
  const step = steps[run.step] as LessonStep
  if (stepTrigger(step.until, run.until, r, run.clean)) advance(run, 'step')
  return run
}

const advance = (run: LessonRun, how: 'step' | 'skip'): void => {
  run.completed = run.step
  run.step += 1
  resetTrigger(run.until)
  if (run.step >= run.lesson.steps.length) {
    run.done = true
    run.event = 'done'
  } else run.event = how
}

/**
 * The pause menu's *Skip step* (plan §7): the one way past a step that is not
 * its trigger. It clears an interrupt that is up as well — a player stuck is
 * stuck on whatever the plate says.
 */
export const skipStep = (run: LessonRun): LessonRun => {
  run.completed = -1
  if (run.done) {
    run.event = 'none'
    return run
  }
  run.interrupt = -1
  resetTrigger(run.interruptUntil)
  for (const s of run.on) resetTrigger(s)
  advance(run, 'skip')
  return run
}

/** What the plate says: the prompt that is up, or null once the lesson is done. */
export interface LessonPrompt {
  /** Identity: the step's or the interrupt's id. A change of key is a new prompt. */
  readonly key: string
  /** 1-based, for the heading. */
  readonly number: number
  /** The STEP's title, whatever is up: the interrupt is a word about that step. */
  readonly title: string
  /** The body, tokens unresolved. */
  readonly say: string
  readonly interrupt: boolean
}

export const lessonPrompt = (run: LessonRun): LessonPrompt | null => {
  if (run.done) return null
  const step = run.lesson.steps[run.step]
  if (!step) return null
  const int = run.interrupt >= 0 ? run.lesson.interrupts[run.interrupt] : undefined
  return {
    key: int ? `${step.id}/${int.id}` : step.id,
    number: run.step + 1,
    title: step.title,
    say: int ? int.say : step.say,
    interrupt: int !== undefined,
  }
}

/**
 * The instructor's pacing for step `index`: the lesson's `instructor` block
 * with that step's overrides (§6.2), as DEV-376's sim reads it. Past the last
 * step it is the last step's, so a lesson that ends before the finish keeps
 * flying the way it was.
 */
export const instructorSpec = (lesson: Lesson, index: number): InstructorPaceSpec => {
  const base = lesson.instructor
  const last = lesson.steps.length - 1
  const over = lesson.steps[Math.min(Math.max(index, 0), last)]?.instructor ?? {}
  return {
    leadMetres: over.leadMetres ?? base.leadMetres,
    gain: base.gain,
    waitBeyondMetres: base.waitBeyondMetres,
    resumeWithinMetres: base.resumeWithinMetres,
    holdAsideMetres: base.holdAsideMetres,
    maxSpeed: over.maxSpeed ?? base.maxSpeed,
    boost: over.boost ?? base.boost,
    race: over.pace === 'race',
  }
}

/**
 * The student's speed ceiling for step `index`, m/s, or null for none (DEV-790).
 * Past the last step it is the last step's, as {@link instructorSpec} is.
 */
export const studentCapOf = (lesson: Lesson, index: number): number | null => {
  const last = lesson.steps.length - 1
  return lesson.steps[Math.min(Math.max(index, 0), last)]?.student?.maxSpeed ?? null
}

/**
 * The stick, held to a step's speed ceiling (DEV-790). At or past `cap` the
 * throttle and the boost are cut, so a student holding full throttle settles at
 * the ceiling instead of climbing on to the jet's terminal speed; below it the
 * stick is the stick. Returns the SAME object when nothing is cut, so the app's
 * per-tick path allocates nothing outside a cap.
 *
 * Matt, 2026-10-07 ("go with your recs", QUESTIONS item 5): lesson 1 put the
 * mesa 5.7 s out for a student at ~93 m/s, too soon to read CLIMB and act.
 */
export const capStudentActions = <T extends { throttle: number; boost: boolean }>(
  actions: T,
  speed: number,
  cap: number | null,
): T => (cap === null || speed < cap ? actions : { ...actions, throttle: 0, boost: false })

/** Volatile: the two body axes, valid inside one `bankDegrees`. */
const _right = v3()
const _up = v3()
const X = v3(1, 0, 0)
const Z = v3(0, 0, 1)
const Y = v3(0, 1, 0)

/**
 * How far the wings are rolled from level, degrees, 0 to 180: the angle the
 * body's up axis has turned about its nose away from the world's up. A ship
 * on its side reads 90 and one upside down 180, whichever way it rolled.
 *
 * Measured off the two axes, never off Euler angles: `atan2(right.y, up.y)` is
 * the roll whatever the pitch, until the nose is straight up or down — where
 * roll has no meaning and both terms go to zero together.
 */
export const bankDegrees = (orientation: Quat): number => {
  rotateVec3(_right, orientation, X)
  rotateVec3(_up, orientation, Y)
  return Math.abs((Math.atan2(_right.y, _up.y) * 180) / Math.PI)
}

/** Volatile: the nose axis, valid inside one `pitchDegrees`. */
const _nose = v3()

/**
 * How far the nose is above the horizon, degrees, -90 (straight down) to 90
 * (straight up): the body's forward axis (+z, as `sim/autopilot.ts`'s
 * `FORWARD_BODY`) against the world's up. Roll does not change it. DEV-892.
 */
export const pitchDegrees = (orientation: Quat): number => {
  rotateVec3(_nose, orientation, Z)
  return (Math.asin(Math.max(-1, Math.min(1, _nose.y))) * 180) / Math.PI
}
