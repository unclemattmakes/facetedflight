// tests/unit/lesson.test.ts — the lesson's step machine, and the mode guard. DEV-377.
//
// `docs/plan/FLIGHT-INSTRUCTOR.md` §9: every trigger kind true AND false;
// `sequence` in order and not out of it; an interrupt holds the step and hands
// it back; a step never skips on its own. And the three corrections DEV-375
// left: a `?mode=` request cannot cross a lesson, "no medal" is a rule of the
// row, and a lesson file that carries thresholds is refused.
//
// The machine is fed READINGS, never a world: a reading is the whole of what it
// judges, so a table of them is the whole of what it can do. The readings are
// built from a neutral one — a ship parked on the line, level, doing nothing —
// with one field moved, so each case says which field it is about.
//
// **The mode is never spelled here**: the teaching row is found by asking the
// rows, as every consumer does.

import { describe, expect, it } from 'vitest'
import {
  type GameMode,
  LESSON_TRIGGERS,
  type Lesson,
  type LessonTrigger,
  type LessonTriggerKind,
  type Level,
  LevelSchemaError,
} from '@/content/level-schema'
import {
  bankDegrees,
  capStudentActions,
  createLessonRun,
  createTrigger,
  instructorSpec,
  type LessonReading,
  lessonPrompt,
  pitchDegrees,
  resetLesson,
  skipStep,
  stepLesson,
  stepTrigger,
  studentCapOf,
} from '@/game/lesson'
import {
  MODES,
  medalCurve,
  requestKeepsTeaching,
  rulesFor,
  runningMode,
  validateModeContent,
} from '@/game/modes'
import { FIXED_DT } from '@/sim/constants'
import { quat, setQ } from '@/sim/math/quat'
import lesson01 from '../../content/authored/lesson_01_canyon.json'
import int01 from '../../content/levels/int_01_hoverJet.json'

const TEACHING = (Object.keys(MODES) as GameMode[]).find((m) => rulesFor(m).teaches) as GameMode
const RACING = (Object.keys(MODES) as GameMode[]).find(
  (m) => !rulesFor(m).teaches && rulesFor(m).opponents,
) as GameMode

/** Ticks in `s` seconds of the fixed step. */
const ticks = (s: number): number => Math.ceil(s / FIXED_DT)

/** A ship parked on the line: flying, level, still, nothing held, nothing happening. */
const NEUTRAL: LessonReading = {
  dt: FIXED_DT,
  launched: true,
  flying: true,
  speed: 30,
  bankDegrees: 0,
  pitchDegrees: 0,
  held: { throttle: false, boost: false, brake: false, airbrake: false },
  crossTrack: 0,
  passed: [false, false, false, false],
  gate: -1,
  gateClean: false,
  cleanGates: true,
  finished: false,
  crashed: false,
  contactLoss: 0,
}
const at = (over: Partial<LessonReading>): LessonReading => ({ ...NEUTRAL, ...over })

/** Feed `r` to a fresh trigger `n` times; was it true on the last? */
const judge = (t: LessonTrigger, r: LessonReading, n = 1, clean: boolean[] = []): boolean => {
  const s = createTrigger()
  let v = false
  for (let i = 0; i < n; i++) v = stepTrigger(t, s, r, clean)
  return v
}

describe('every trigger, true and false (plan §6.2)', () => {
  // One case per kind, each a pair: the reading that makes it true, and the
  // nearest one that does not. The table is typed over the vocabulary, so a
  // kind added to `LESSON_TRIGGERS` without a row here does not compile.
  const CASES: {
    readonly [K in LessonTriggerKind]: {
      readonly t: Extract<LessonTrigger, { kind: K }>
      readonly yes: () => boolean
      readonly no: () => boolean
    }
  } = {
    launched: {
      t: { kind: 'launched' },
      yes: () => judge({ kind: 'launched' }, at({ launched: true })),
      no: () => judge({ kind: 'launched' }, at({ launched: false, flying: false })),
    },
    speedAtLeast: {
      t: { kind: 'speedAtLeast', mps: 50, forSeconds: 1 },
      // Held for the full second: true. Held for all but the last tick: not yet.
      yes: () =>
        judge({ kind: 'speedAtLeast', mps: 50, forSeconds: 1 }, at({ speed: 50 }), ticks(1)),
      no: () =>
        judge({ kind: 'speedAtLeast', mps: 50, forSeconds: 1 }, at({ speed: 50 }), ticks(1) - 1) ||
        judge({ kind: 'speedAtLeast', mps: 50, forSeconds: 1 }, at({ speed: 49.9 }), ticks(2)),
    },
    speedAtMost: {
      t: { kind: 'speedAtMost', mps: 5, forSeconds: 3 },
      yes: () => judge({ kind: 'speedAtMost', mps: 5, forSeconds: 3 }, at({ speed: 5 }), ticks(3)),
      no: () =>
        judge({ kind: 'speedAtMost', mps: 5, forSeconds: 3 }, at({ speed: 5 }), ticks(3) - 1) ||
        judge({ kind: 'speedAtMost', mps: 5, forSeconds: 3 }, at({ speed: 5.1 }), ticks(4)),
    },
    passGate: {
      t: { kind: 'passGate', ring: 2 },
      yes: () => judge({ kind: 'passGate', ring: 2 }, at({ passed: [false, false, true, false] })),
      // Ring 3 taken is not ring 2.
      no: () => judge({ kind: 'passGate', ring: 2 }, at({ passed: [true, true, false, true] })),
    },
    bankAtLeast: {
      t: { kind: 'bankAtLeast', degrees: 30 },
      yes: () => judge({ kind: 'bankAtLeast', degrees: 30 }, at({ bankDegrees: 30 })),
      no: () => judge({ kind: 'bankAtLeast', degrees: 30 }, at({ bankDegrees: 29.9 })),
    },
    levelFor: {
      t: { kind: 'levelFor', degrees: 5, seconds: 1.5 },
      yes: () =>
        judge({ kind: 'levelFor', degrees: 5, seconds: 1.5 }, at({ bankDegrees: 4 }), ticks(1.5)),
      no: () =>
        judge(
          { kind: 'levelFor', degrees: 5, seconds: 1.5 },
          at({ bankDegrees: 4 }),
          ticks(1.5) - 1,
        ) ||
        judge({ kind: 'levelFor', degrees: 5, seconds: 1.5 }, at({ bankDegrees: 6 }), ticks(3)),
    },
    input: {
      t: { kind: 'input', action: 'boost', forSeconds: 0.5 },
      yes: () =>
        judge(
          { kind: 'input', action: 'boost', forSeconds: 0.5 },
          at({ held: { ...NEUTRAL.held, boost: true } }),
          ticks(0.5),
        ),
      // The throttle held is not the boost.
      no: () =>
        judge(
          { kind: 'input', action: 'boost', forSeconds: 0.5 },
          at({ held: { ...NEUTRAL.held, throttle: true } }),
          ticks(1),
        ),
    },
    onLineWithin: {
      t: { kind: 'onLineWithin', metres: 60 },
      yes: () => judge({ kind: 'onLineWithin', metres: 60 }, at({ crossTrack: 60 })),
      no: () => judge({ kind: 'onLineWithin', metres: 60 }, at({ crossTrack: 60.1 })),
    },
    offLineBeyond: {
      t: { kind: 'offLineBeyond', metres: 150 },
      yes: () => judge({ kind: 'offLineBeyond', metres: 150 }, at({ crossTrack: 150.1 })),
      no: () => judge({ kind: 'offLineBeyond', metres: 150 }, at({ crossTrack: 150 })),
    },
    noseAbove: {
      t: { kind: 'noseAbove', degrees: 60 },
      yes: () => judge({ kind: 'noseAbove', degrees: 60 }, at({ pitchDegrees: 60.1 })),
      // A dive is not a climb, and exactly at the limit is not beyond it.
      no: () =>
        judge({ kind: 'noseAbove', degrees: 60 }, at({ pitchDegrees: 60 })) ||
        judge({ kind: 'noseAbove', degrees: 60 }, at({ pitchDegrees: -80 })),
    },
    noseBelow: {
      t: { kind: 'noseBelow', degrees: 35 },
      yes: () => judge({ kind: 'noseBelow', degrees: 35 }, at({ pitchDegrees: 35 })),
      no: () => judge({ kind: 'noseBelow', degrees: 35 }, at({ pitchDegrees: 35.1 })),
    },
    finish: {
      t: { kind: 'finish' },
      yes: () => judge({ kind: 'finish' }, at({ finished: true })),
      no: () => judge({ kind: 'finish' }, at({ passed: [true, true, true, true] })),
    },
    seconds: {
      t: { kind: 'seconds', n: 3 },
      yes: () => judge({ kind: 'seconds', n: 3 }, NEUTRAL, ticks(3)),
      no: () => judge({ kind: 'seconds', n: 3 }, NEUTRAL, ticks(3) - 1),
    },
    sequence: {
      t: {
        kind: 'sequence',
        of: [
          { kind: 'bankAtLeast', degrees: 30 },
          { kind: 'passGate', ring: 0 },
        ],
      },
      // Both, in turn — one member per tick — is true on the second tick.
      yes: () =>
        judge(
          {
            kind: 'sequence',
            of: [
              { kind: 'bankAtLeast', degrees: 30 },
              { kind: 'passGate', ring: 0 },
            ],
          },
          at({ bankDegrees: 40, passed: [true, false, false, false] }),
          2,
        ),
      no: () =>
        judge(
          {
            kind: 'sequence',
            of: [
              { kind: 'bankAtLeast', degrees: 30 },
              { kind: 'passGate', ring: 0 },
            ],
          },
          at({ bankDegrees: 40 }),
          ticks(2),
        ),
    },
    crash: {
      t: { kind: 'crash' },
      yes: () => judge({ kind: 'crash' }, at({ crashed: true })),
      // A contact is not a crash.
      no: () => judge({ kind: 'crash' }, at({ contactLoss: 80 })),
    },
    contact: {
      t: { kind: 'contact', mps: 30 },
      yes: () => judge({ kind: 'contact', mps: 30 }, at({ contactLoss: 30 })),
      no: () => judge({ kind: 'contact', mps: 30 }, at({ contactLoss: 29.9 })),
    },
  }

  for (const kind of Object.keys(LESSON_TRIGGERS) as LessonTriggerKind[]) {
    it(`${kind}: true when it should be, false when it should not`, () => {
      const c = CASES[kind]
      expect(c.yes(), `${kind} true`).toBe(true)
      expect(c.no(), `${kind} false`).toBe(false)
    })
  }

  it('a hold is UNBROKEN: one tick off starts it again', () => {
    const t: LessonTrigger = { kind: 'speedAtLeast', mps: 50, forSeconds: 1 }
    const s = createTrigger()
    for (let i = 0; i < ticks(1) - 1; i++) stepTrigger(t, s, at({ speed: 60 }))
    expect(stepTrigger(t, s, at({ speed: 40 }))).toBe(false)
    for (let i = 0; i < ticks(1) - 1; i++) expect(stepTrigger(t, s, at({ speed: 60 }))).toBe(false)
    expect(stepTrigger(t, s, at({ speed: 60 }))).toBe(true)
  })

  it('passGate with clean asks for a CLEAN pass where the preset has them, a pass where not', () => {
    const t: LessonTrigger = { kind: 'passGate', ring: 1, clean: true }
    const taken = at({ passed: [true, true, false, false] })
    // Anniversary: taken, but not clean — not yet.
    expect(judge(t, taken, 1, [])).toBe(false)
    expect(judge(t, taken, 1, [false, true])).toBe(true)
    // Classic has no clean gates to ask for: a pass is the thing.
    expect(judge(t, { ...taken, cleanGates: false }, 1, [])).toBe(true)
  })
})

describe('sequence is in order, and not out of it', () => {
  // The bank step: roll past 30, THEN hold level for 1.5 s.
  const BANK: LessonTrigger = {
    kind: 'sequence',
    of: [
      { kind: 'bankAtLeast', degrees: 30 },
      { kind: 'levelFor', degrees: 5, seconds: 1.5 },
    ],
  }

  it('level first and banked after has done neither in order', () => {
    const s = createTrigger()
    // Level for three seconds: the second member is true, but it is not up.
    for (let i = 0; i < ticks(3); i++)
      expect(stepTrigger(BANK, s, at({ bankDegrees: 0 }))).toBe(false)
    // Banked: the first member is done; the level hold starts only NOW.
    expect(stepTrigger(BANK, s, at({ bankDegrees: 45 }))).toBe(false)
    for (let i = 0; i < ticks(1.5) - 1; i++) {
      expect(stepTrigger(BANK, s, at({ bankDegrees: 2 }))).toBe(false)
    }
    expect(stepTrigger(BANK, s, at({ bankDegrees: 2 }))).toBe(true)
  })

  it('a banked ship that never comes level never finishes it', () => {
    const s = createTrigger()
    for (let i = 0; i < ticks(10); i++)
      expect(stepTrigger(BANK, s, at({ bankDegrees: 40 }))).toBe(false)
  })
})

// ── the run: steps, interrupts, skips ──────────────────────────────────────

const LESSON: Lesson = {
  instructor: {
    tuning: 'steady',
    colour: '#e9f3f5',
    startArcMetres: 60,
    leadMetres: 90,
    gain: 0.5,
    waitBeyondMetres: 400,
    resumeWithinMetres: 150,
    holdAsideMetres: 40,
    maxSpeed: 55,
    boost: false,
  },
  steps: [
    { id: 'launch', title: 'LAUNCH', say: 'Press {launch}.', until: { kind: 'launched' } },
    {
      id: 'throttle',
      title: 'THROTTLE',
      say: 'Hold {throttle}.',
      until: { kind: 'speedAtLeast', mps: 50, forSeconds: 1 },
      instructor: { maxSpeed: 50 },
    },
    {
      id: 'thread',
      title: 'THREAD',
      say: 'Ring {nextRing}.',
      until: { kind: 'passGate', ring: 2 },
    },
    {
      id: 'home',
      title: 'HOME',
      say: 'Race me.',
      until: { kind: 'finish' },
      instructor: { pace: 'race', boost: true, maxSpeed: 180, leadMetres: 30 },
    },
  ],
  interrupts: [
    {
      id: 'crash',
      on: { kind: 'crash' },
      say: 'Too hard.',
      until: { kind: 'speedAtLeast', mps: 40, forSeconds: 1 },
    },
    {
      id: 'lost',
      on: { kind: 'offLineBeyond', metres: 150 },
      say: 'Turn back.',
      until: { kind: 'onLineWithin', metres: 60 },
    },
    {
      id: 'stopped',
      on: { kind: 'speedAtMost', mps: 5, forSeconds: 3 },
      say: 'Hold {throttle}.',
      until: { kind: 'speedAtLeast', mps: 20, forSeconds: 1 },
    },
  ],
}

/** A run on step `step`, fed nothing yet. */
const runAt = (step = 0) => {
  const run = createLessonRun(LESSON)
  stepLesson(run, at({ launched: false, flying: false }))
  for (let i = 0; i < step; i++) skipStep(run)
  return run
}
const feed = (run: ReturnType<typeof runAt>, r: LessonReading, n: number) => {
  for (let i = 0; i < n; i++) stepLesson(run, r)
  return run
}

describe('a step ends on its trigger, and on nothing else', () => {
  it('announces its first prompt, then waits for the launch press', () => {
    const run = createLessonRun(LESSON)
    stepLesson(run, at({ launched: false, flying: false }))
    expect(run.event).toBe('start')
    expect(lessonPrompt(run)?.key).toBe('launch')
    feed(run, at({ launched: false, flying: false }), ticks(30))
    expect(run.step).toBe(0)
    stepLesson(run, at({ launched: true, flying: false }))
    expect(run.step).toBe(1)
    expect(run.event).toBe('step')
    expect(run.completed).toBe(0)
  })

  it('never skips on its own: ten minutes of a ship doing everything but the thing', () => {
    // Step 2 is ring 2. Fly fast, bank, take rings 0, 1 and 3, cross the finish
    // line even — ring 2 is not taken, and the step does not move.
    const run = runAt(2)
    const busy = at({
      speed: 150,
      bankDegrees: 60,
      held: { throttle: true, boost: true, brake: false, airbrake: false },
      passed: [true, true, false, true],
      finished: true,
    })
    feed(run, busy, ticks(600))
    expect(run.step).toBe(2)
    expect(run.done).toBe(false)
    stepLesson(run, at({ passed: [true, true, true, true] }))
    expect(run.step).toBe(3)
  })

  it('takes a ring flown BEFORE its step came up, at once', () => {
    const run = runAt(2)
    stepLesson(run, at({ passed: [true, true, true, false] }))
    expect(run.step).toBe(3)
  })

  it('is done after the last step, and the plate has nothing to say', () => {
    const run = runAt(3)
    stepLesson(run, at({ finished: true }))
    expect(run.done).toBe(true)
    expect(run.event).toBe('done')
    expect(lessonPrompt(run)).toBeNull()
  })

  it('skips on the pause menu, clearing an interrupt that is up', () => {
    const run = runAt(1)
    stepLesson(run, at({ crashed: true }))
    expect(lessonPrompt(run)?.interrupt).toBe(true)
    skipStep(run)
    expect(run.step).toBe(2)
    expect(run.interrupt).toBe(-1)
    expect(run.event).toBe('skip')
    expect(lessonPrompt(run)?.key).toBe('thread')
  })

  it('restarts from step 0', () => {
    const run = runAt(3)
    resetLesson(run)
    expect(run.step).toBe(0)
    stepLesson(run, at({ launched: false, flying: false }))
    expect(run.event).toBe('start')
  })
})

describe('an interrupt holds the step and hands it back', () => {
  it('holds a half-done step where it was, and hands it back to finish from there', () => {
    // Step 1: 50 m/s for a second. Two thirds of it, then a crash.
    const run = runAt(1)
    feed(run, at({ speed: 60 }), Math.floor(ticks(1) * (2 / 3)))
    stepLesson(run, at({ speed: 60, crashed: true }))
    expect(run.interrupt).toBe(0)
    expect(run.event).toBe('interrupt')
    expect(lessonPrompt(run)).toMatchObject({ key: 'throttle/crash', say: 'Too hard.' })
    // Held: fast for five seconds is the interrupt's `until`, not the step's.
    feed(run, at({ speed: 60 }), ticks(1))
    expect(run.interrupt).toBe(-1)
    expect(run.event).toBe('resume')
    expect(run.step).toBe(1)
    // Handed back WHERE IT WAS: the remaining third, not a whole second.
    const left = ticks(1) - Math.floor(ticks(1) * (2 / 3))
    feed(run, at({ speed: 60 }), left - 1)
    expect(run.step).toBe(1)
    stepLesson(run, at({ speed: 60 }))
    expect(run.step).toBe(2)
  })

  it('does not let the step finish underneath it', () => {
    const run = runAt(2)
    stepLesson(run, at({ crossTrack: 200 }))
    expect(lessonPrompt(run)?.key).toBe('thread/lost')
    // Ring 2 taken while lost: the step does not end under the interrupt…
    feed(run, at({ crossTrack: 200, passed: [true, true, true, false] }), 10)
    expect(run.step).toBe(2)
    // …and ends the tick after the student is back on the line.
    stepLesson(run, at({ crossTrack: 10, passed: [true, true, true, false] }))
    expect(run.event).toBe('resume')
    stepLesson(run, at({ crossTrack: 10, passed: [true, true, true, false] }))
    expect(run.step).toBe(3)
  })

  it('fires only once the ship is FLYING: a ship on the pad is waiting, not stopped', () => {
    const run = createLessonRun(LESSON)
    feed(run, at({ launched: false, flying: false, speed: 0 }), ticks(30))
    expect(run.interrupt).toBe(-1)
    // On the lift and through the countdown, too.
    feed(run, at({ launched: true, flying: false, speed: 0 }), ticks(30))
    expect(run.interrupt).toBe(-1)
    // Let go, and still at rest for three seconds: now it is stopped.
    feed(run, at({ speed: 0 }), ticks(3))
    expect(lessonPrompt(run)?.say).toBe('Hold {throttle}.')
    expect(lessonPrompt(run)?.interrupt).toBe(true)
  })

  it('lets only an interrupt EARLIER in the list replace one that is up', () => {
    // Stopped AND off the line: `lost` is first, and it holds the plate —
    // `stopped` never takes it in turns, however long the ship sits there.
    const run = runAt(2)
    stepLesson(run, at({ crossTrack: 200, speed: 0 }))
    expect(lessonPrompt(run)?.key).toBe('thread/lost')
    // 100 m off: no longer past `lost`'s 150, not yet inside its 60 — so it is
    // up and not re-firing, and `stopped` is true underneath it the whole time.
    feed(run, at({ crossTrack: 100, speed: 0 }), ticks(20))
    expect(lessonPrompt(run)?.key).toBe('thread/lost')
    // A crash is first of all, and takes it.
    stepLesson(run, at({ crossTrack: 200, speed: 0, crashed: true }))
    expect(lessonPrompt(run)?.key).toBe('thread/crash')
  })

  it('starts a lower interrupt from nothing once the one above clears', () => {
    // Stopped while lost: the three seconds of `stopped` count only from the
    // moment `lost` clears, not from when the ship stopped.
    const run = runAt(2)
    feed(run, at({ crossTrack: 200, speed: 0 }), ticks(5))
    stepLesson(run, at({ crossTrack: 10, speed: 0 }))
    expect(run.interrupt).toBe(-1)
    feed(run, at({ crossTrack: 10, speed: 0 }), ticks(3) - 1)
    expect(run.interrupt).toBe(-1)
    stepLesson(run, at({ crossTrack: 10, speed: 0 }))
    expect(lessonPrompt(run)?.key).toBe('thread/stopped')
  })

  it('fires a contact on its speed, not on a touch', () => {
    const lesson: Lesson = {
      ...LESSON,
      interrupts: [
        {
          id: 'contact',
          on: { kind: 'contact', mps: 30 },
          say: 'Climb away.',
          until: { kind: 'seconds', n: 3 },
        },
      ],
    }
    const run = createLessonRun(lesson)
    stepLesson(run, at({ contactLoss: 12 }))
    expect(run.interrupt).toBe(-1)
    stepLesson(run, at({ contactLoss: 31 }))
    expect(run.interrupt).toBe(0)
    // `seconds` counts from the interrupt going up.
    feed(run, NEUTRAL, ticks(3) - 1)
    expect(run.interrupt).toBe(0)
    stepLesson(run, NEUTRAL)
    expect(run.interrupt).toBe(-1)
  })
})

describe("the instructor's pace for a step (plan §6.2)", () => {
  it('is the lesson block with the step overrides, and race only where the step says', () => {
    expect(instructorSpec(LESSON, 0)).toEqual({
      leadMetres: 90,
      gain: 0.5,
      waitBeyondMetres: 400,
      resumeWithinMetres: 150,
      holdAsideMetres: 40,
      maxSpeed: 55,
      boost: false,
      race: false,
    })
    expect(instructorSpec(LESSON, 1)).toMatchObject({ maxSpeed: 50, boost: false, race: false })
    expect(instructorSpec(LESSON, 3)).toMatchObject({
      maxSpeed: 180,
      boost: true,
      race: true,
      leadMetres: 30,
    })
    // Past the end, the last step's: the lesson goes on flying the way it was.
    expect(instructorSpec(LESSON, 99)).toEqual(instructorSpec(LESSON, 3))
  })
})

describe("the student's speed cap for a step (DEV-790)", () => {
  const LESSON1 = (lesson01 as unknown as { lesson: Lesson }).lesson
  const STICK = { throttle: 1, boost: true, roll: 0.25 }

  it('is the step the lesson names, none elsewhere, and the last step past the end', () => {
    expect(studentCapOf(LESSON, 0)).toBeNull()
    const capped: Lesson = {
      ...LESSON,
      steps: LESSON.steps.map((s, i) => (i === 0 ? { ...s, student: { maxSpeed: 52 } } : s)),
    }
    expect(studentCapOf(capped, 0)).toBe(52)
    expect(studentCapOf(capped, 1)).toBeNull()
    expect(studentCapOf(capped, -4)).toBe(52)
    expect(studentCapOf(capped, 99)).toBe(studentCapOf(capped, capped.steps.length - 1))
  })

  it('cuts the throttle and the boost at the ceiling and leaves every other axis alone', () => {
    expect(capStudentActions(STICK, 51.9, 52)).toBe(STICK)
    expect(capStudentActions(STICK, 52, 52)).toEqual({ throttle: 0, boost: false, roll: 0.25 })
    expect(capStudentActions(STICK, 90, 52).roll).toBe(0.25)
    // No cap, no change: the SAME object, so the app's tick allocates nothing.
    expect(capStudentActions(STICK, 400, null)).toBe(STICK)
    // And it never mutates the stick it was handed.
    expect(STICK).toEqual({ throttle: 1, boost: true, roll: 0.25 })
  })

  it('lesson 1 caps THROTTLE and CLIMB over the speed THROTTLE asks for, and nothing else', () => {
    const caps = Object.fromEntries(LESSON1.steps.map((s, i) => [s.id, studentCapOf(LESSON1, i)]))
    const throttle = LESSON1.steps.find((s) => s.id === 'throttle')
    expect(throttle?.until.kind).toBe('speedAtLeast')
    const asked = throttle?.until.kind === 'speedAtLeast' ? throttle.until.mps : Number.NaN
    // Over the ask, or a ship cutting out at the ceiling straddles it and the
    // step's hold never completes. Under a boosted cruise, or it is no cap.
    expect(caps.throttle).toBeGreaterThan(asked)
    expect(caps.throttle).toBeLessThan(asked * 1.1)
    expect(caps.climb).toBe(caps.throttle)
    for (const [id, cap] of Object.entries(caps)) {
      if (id !== 'throttle' && id !== 'climb') expect(cap, id).toBeNull()
    }
  })
})

describe('the bank is the roll about the nose, whatever the pitch', () => {
  const q = quat()
  /** Roll `r` degrees about +Z after pitching `p` about +X: q = qPitch * qRoll. */
  const pose = (pitchDeg: number, rollDeg: number) => {
    const p = (pitchDeg * Math.PI) / 360
    const r = (rollDeg * Math.PI) / 360
    // (sin p, 0, 0, cos p) * (0, 0, sin r, cos r)
    return setQ(
      q,
      Math.sin(p) * Math.cos(r),
      -Math.sin(p) * Math.sin(r),
      Math.cos(p) * Math.sin(r),
      Math.cos(p) * Math.cos(r),
    )
  }

  it('reads level, on its side and upside down, both ways round', () => {
    expect(bankDegrees(pose(0, 0))).toBeCloseTo(0, 6)
    expect(bankDegrees(pose(0, 30))).toBeCloseTo(30, 6)
    expect(bankDegrees(pose(0, -30))).toBeCloseTo(30, 6)
    expect(bankDegrees(pose(0, 90))).toBeCloseTo(90, 6)
    expect(bankDegrees(pose(0, 180))).toBeCloseTo(180, 6)
  })

  it('is not fooled by a climb or a dive', () => {
    for (const pitch of [-60, -20, 20, 60]) {
      expect(bankDegrees(pose(pitch, 0)), `pitch ${pitch}`).toBeCloseTo(0, 6)
      expect(bankDegrees(pose(pitch, 45)), `pitch ${pitch}`).toBeCloseTo(45, 6)
    }
  })
})

// ── the mode guard: DEV-375's three corrections ────────────────────────────

describe('a ?mode= request cannot cross a lesson (DEV-375 §4)', () => {
  const COURSE = int01 as unknown as Level
  const LESSON_COURSE = {
    ...COURSE,
    mode: TEACHING,
    medals: { bronze: null, silver: null, gold: null, platinum: null },
    medalsFf2: null,
    lesson: LESSON,
  } as unknown as Level

  it('runs a lesson course as a lesson whatever is requested', () => {
    for (const requested of Object.keys(MODES) as GameMode[]) {
      expect(rulesFor(runningMode(LESSON_COURSE, requested)).teaches, requested).toBe(true)
    }
    expect(runningMode(LESSON_COURSE, RACING)).toBe(TEACHING)
  })

  it('never runs a teaching mode on a course with no lesson', () => {
    expect(runningMode(COURSE, TEACHING)).toBe(COURSE.mode)
    expect(requestKeepsTeaching(COURSE, TEACHING)).toBe(false)
  })

  it('still honours every request that keeps the teaching the same', () => {
    for (const requested of Object.keys(MODES) as GameMode[]) {
      if (rulesFor(requested).teaches) continue
      expect(runningMode(COURSE, requested), requested).toBe(requested)
    }
  })

  it('awards no medal where the mode teaches, whatever the file carries', () => {
    // The file's thresholds, left in: the rule is the row's, not the data's.
    const withMedals = { ...LESSON_COURSE, medals: COURSE.medals, medalsFf2: COURSE.medalsFf2 }
    expect(medalCurve(withMedals as Level, TEACHING)).toBeNull()
    // And the same course under a mode that does not teach awards as before.
    expect(medalCurve(COURSE, COURSE.mode)).not.toBeNull()
  })

  it('refuses a lesson file that carries medal thresholds', () => {
    expect(() => validateModeContent(LESSON_COURSE)).not.toThrow()
    const numbered = { ...LESSON_COURSE, medals: COURSE.medals } as Level
    expect(() => validateModeContent(numbered)).toThrow(LevelSchemaError)
    expect(() => validateModeContent(numbered)).toThrow(/medals carries thresholds/)
    const ff2 = { ...LESSON_COURSE, medalsFf2: COURSE.medalsFf2 } as Level
    expect(() => validateModeContent(ff2)).toThrow(/medalsFf2 carries thresholds/)
  })
})

// ── DEV-379: the finish is not held (DEV-378 §6's first open item) ─────────
//
// A student who strayed past `lost` and then flew straight into the finish
// crossed it under *Turn back*: rule 2 held the step, `lost` clears only back
// near a line the student has finished flying, and `lesson.done` never came.
// Read over lesson 1's OWN block, because the case is its content: the last
// step ends on the finish, and `lost` is its off-line interrupt.
describe('a finish crossed under an interrupt ends the lesson (DEV-379)', () => {
  const L1 = (lesson01 as unknown as Level).lesson as Lesson
  const LOST = L1.interrupts.findIndex((i) => i.on.kind === 'offLineBeyond')
  const far =
    ((L1.interrupts[LOST] as Lesson['interrupts'][number]).on as { metres: number }).metres + 50
  const onLastStep = () => {
    const run = createLessonRun(L1)
    stepLesson(run, at({ launched: false, flying: false }))
    for (let i = 0; i < L1.steps.length - 1; i++) skipStep(run)
    return run
  }

  it('premise: lesson 1 ends on the finish, and has a lost interrupt', () => {
    expect(L1.steps.at(-1)?.until.kind).toBe('finish')
    expect(LOST).toBeGreaterThanOrEqual(0)
  })

  it('ends at the finish with lost up, and says so with the done chirp', () => {
    const run = onLastStep()
    stepLesson(run, at({ crossTrack: far }))
    expect(run.interrupt, 'lost is up').toBe(LOST)
    // Still off the line — lost's `until` is not true — and across the finish.
    stepLesson(run, at({ crossTrack: far, finished: true }))
    expect(run.done).toBe(true)
    expect(run.event).toBe('done')
    expect(run.interrupt).toBe(-1)
    expect(lessonPrompt(run)).toBeNull()
  })

  it('lets no interrupt take the plate on the crossing tick', () => {
    const run = onLastStep()
    stepLesson(run, at({ crossTrack: far, finished: true }))
    expect(run.done).toBe(true)
    expect(run.event).toBe('done')
  })

  it('does not end an EARLIER step at the finish: rule 1 stands', () => {
    // The bank step is not done by crossing the line with it still up.
    const run = createLessonRun(L1)
    stepLesson(run, at({ launched: false, flying: false }))
    const bank = L1.steps.findIndex((s) => s.until.kind === 'sequence')
    for (let i = 0; i < bank; i++) skipStep(run)
    stepLesson(run, at({ crossTrack: far, finished: true }))
    expect(run.step).toBe(bank)
    expect(run.done).toBe(false)
  })
})

// ── DEV-892: a near-vertical nose gets a "level out" line, before "lost" ────
describe('a steep nose is told to level out (DEV-892)', () => {
  const L1 = (lesson01 as unknown as Level).lesson as Lesson
  const STEEP = L1.interrupts.findIndex((i) => i.id === 'steep')
  const LOST = L1.interrupts.findIndex((i) => i.id === 'lost')

  // Rotating about x by -a lifts the +z nose a degrees above the horizon.
  const noseAt = (deg: number) => {
    const half = (-deg * Math.PI) / 360
    return quat(Math.sin(half), 0, 0, Math.cos(half))
  }

  it('reads the nose against the horizon, signed', () => {
    expect(pitchDegrees(noseAt(0))).toBeCloseTo(0, 6)
    expect(pitchDegrees(noseAt(90))).toBeCloseTo(90, 6)
    expect(pitchDegrees(noseAt(-45))).toBeCloseTo(-45, 6)
    expect(pitchDegrees(noseAt(30))).toBeCloseTo(30, 6)
  })

  it('lesson 1 has the line, ABOVE lost, with its own words', () => {
    expect(STEEP).toBeGreaterThanOrEqual(0)
    expect(STEEP).toBeLessThan(LOST)
    expect((L1.interrupts[STEEP] as Lesson['interrupts'][number]).say).toMatch(/\{pitchDown\}/)
  })

  it('takes the plate from "lost" while the nose is up, and gives it back below', () => {
    const run = createLessonRun(L1)
    stepLesson(run, at({}))
    // Off the line AND vertical: the nose is the news.
    stepLesson(run, at({ crossTrack: 500, pitchDegrees: 85 }))
    expect(run.interrupt).toBe(STEEP)
    // Still held at 45 (it clears below 30, not at the 60 that raised it).
    stepLesson(run, at({ crossTrack: 500, pitchDegrees: 45 }))
    expect(run.interrupt).toBe(STEEP)
    stepLesson(run, at({ crossTrack: 500, pitchDegrees: 20 }))
    stepLesson(run, at({ crossTrack: 500, pitchDegrees: 20 }))
    expect(run.interrupt).toBe(LOST)
  })
})
