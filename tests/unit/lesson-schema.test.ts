// tests/unit/lesson-schema.test.ts — DEV-375: the `lesson` block, `listed`, and
// the fifth mode row, as a LOAD-TIME contract.
//
// `docs/plan/FLIGHT-INSTRUCTOR.md` §6.2: the trigger vocabulary is closed, and
// the validator is what closes it — an unknown `kind`, a missing field, a
// `passGate.ring` past the course or an unknown `{token}` is a load error rather
// than a step that never ends. So most of this file is a table of malformed
// shapes, each of which must be refused, by the TypeScript validator AND (where
// a schema can say it) by `content/authored/_lesson.schema.json`.
//
// The valid fixture is the plan's own ten-step lesson (§3) on
// `rookie_02_hoverJet`'s REAL course — read off the generated tree, not
// invented — so `passGate`'s bound is that course's 21 live rings.
//
// **The mode is never spelled here.** The teaching row is found by asking the
// descriptor which row teaches, which is the question every consumer asks.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  type GameMode,
  LESSON_INPUT_ACTIONS,
  LESSON_INSTRUCTOR_KEYS,
  LESSON_PACES,
  LESSON_STEP_INSTRUCTOR_KEYS,
  LESSON_STEP_STUDENT_KEYS,
  LESSON_TOKENS,
  LESSON_TRIGGERS,
  type Lesson,
  type LessonTrigger,
  type LessonTriggerKind,
  type Level,
  LevelSchemaError,
  liveRings,
  validateLevel,
} from '@/content/level-schema'
import {
  authoredLevelIds,
  generatedLevelIds,
  type LevelModules,
  levelIds,
  listedLevelIds,
  loadLevel,
} from '@/content/load-level'
import { cardFor, facetName, loadMissionIndex } from '@/game/mission-index'
import { MODES, QUICK_RACE_MODE, rulesFor, validateModeContent } from '@/game/modes'
import { quickRacePool } from '@/game/quick-race'
import { createValidator, type SchemaNode } from './helpers/json-schema'
import { REPO as ROOT } from './helpers/repo-root'

const readJson = <T>(rel: string): T =>
  JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')) as T

/** The one row that teaches, found by asking the rows. */
const teachingModes = (Object.keys(MODES) as GameMode[]).filter((m) => rulesFor(m).teaches)
const TEACHING = teachingModes[0] as GameMode

const COURSE = readJson<Level>('content/levels/rookie_02_hoverJet.json')

/** The plan's §3 lesson, all ten steps and all four interrupts. */
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
    {
      id: 'launch',
      title: 'LAUNCH',
      say: "Press {launch} to launch. I'll be waiting at the top.",
      until: { kind: 'launched' },
    },
    {
      id: 'throttle',
      title: 'THROTTLE',
      say: 'Hold {throttle} to fly. The ship goes where the nose points. Follow me.',
      until: { kind: 'speedAtLeast', mps: 50, forSeconds: 1 },
      instructor: { maxSpeed: 50 },
    },
    {
      id: 'climb',
      title: 'CLIMB',
      say: '{pitchUp} to climb, {pitchDown} to dive.',
      until: { kind: 'passGate', ring: 1 },
    },
    {
      id: 'thread',
      title: 'THREAD A RING',
      say: 'Fly through the middle. The bullseye is where to aim.',
      until: { kind: 'passGate', ring: 3 },
    },
    {
      id: 'bank',
      title: 'THE BANK STAYS',
      say: 'Roll with {roll}, then let go. It stays banked: this ship never levels itself. Roll it back to level.',
      until: {
        kind: 'sequence',
        of: [
          { kind: 'bankAtLeast', degrees: 30 },
          { kind: 'levelFor', degrees: 5, seconds: 1.5 },
        ],
      },
      instructor: { maxSpeed: 45 },
    },
    {
      id: 'turning',
      title: 'TURNING',
      say: 'Yaw with {fly} for small corrections. For a real turn, roll onto your side and pull.',
      until: { kind: 'passGate', ring: 6 },
      instructor: { maxSpeed: 60 },
    },
    {
      id: 'boost',
      title: 'BOOST',
      say: 'Hold {boost}. Past 120 the speed lines come on. SPEED {speed}',
      until: { kind: 'speedAtLeast', mps: 120, forSeconds: 1 },
      instructor: { boost: true, maxSpeed: 150 },
    },
    {
      id: 'corner',
      title: 'A CORNER AT SPEED',
      say: 'Let off boost, {slow}, roll and pull through.',
      until: { kind: 'passGate', ring: 11 },
      instructor: { maxSpeed: 110 },
    },
    {
      id: 'canyon',
      title: 'INTO THE CANYON',
      say: 'Nose down, and watch the ground come up.',
      until: { kind: 'passGate', ring: 13 },
      instructor: { maxSpeed: 90 },
    },
    {
      id: 'home',
      title: 'ON YOUR OWN',
      say: 'You have it. Race me to the finish.',
      until: { kind: 'finish' },
      instructor: { pace: 'race', boost: true, maxSpeed: 180 },
    },
  ],
  interrupts: [
    {
      id: 'crash',
      on: { kind: 'crash' },
      say: "Too hard. You're back on the line with a cold engine. Hold {throttle} and find me.",
      until: { kind: 'speedAtLeast', mps: 40, forSeconds: 1 },
    },
    {
      id: 'contact',
      on: { kind: 'contact', mps: 30 },
      say: 'You hit the ground. The ship turns slowly for a moment. Climb away.',
      until: { kind: 'seconds', n: 3 },
    },
    {
      id: 'lost',
      on: { kind: 'offLineBeyond', metres: 150 },
      say: "Turn back to ring {nextRing}. I'll wait.",
      until: { kind: 'onLineWithin', metres: 60 },
    },
    {
      id: 'stopped',
      on: { kind: 'speedAtMost', mps: 5, forSeconds: 3 },
      say: 'Hold {throttle} to fly.',
      until: { kind: 'speedAtLeast', mps: 20, forSeconds: 1 },
    },
  ],
  _meta: { deviation: 'DEV-378', note: 'the plan §3 lesson, as a test fixture' },
}

const NO_MEDALS = {
  bronze: null,
  silver: null,
  gold: null,
  platinum: null,
} as unknown as Level['medals']

/** A lesson course: `rookie_02`'s real course, running in the teaching mode. */
const lessonLevel = (lesson: unknown = LESSON): Level =>
  ({
    ...structuredClone(COURSE),
    id: 'lesson_fixture',
    mode: TEACHING,
    listed: true,
    medals: NO_MEDALS,
    medalsFf2: null,
    lesson,
  }) as Level

/**
 * A lesson as untyped JSON, which is what a hand-authored file is until the
 * validator has read it. The edits below break its shape on purpose, so they
 * cannot be written against `Lesson`.
 */
// biome-ignore lint/suspicious/noExplicitAny: a deliberately malformed edit of raw JSON
type Draft = Record<string, any>

/** The fixture with one edit applied to a deep copy of its lesson. */
const withLesson = (edit: (l: Draft) => void): Level => {
  const copy = structuredClone(LESSON) as unknown as Draft
  edit(copy)
  return lessonLevel(copy)
}

const SCHEMA = readJson<SchemaNode>('content/authored/_lesson.schema.json')
const validateShape = createValidator(SCHEMA)
const schemaErrors = (lesson: unknown): string[] => {
  const errs: string[] = []
  validateShape(SCHEMA, lesson, 'lesson', errs)
  return errs
}

describe('the fifth row is found by what it does', () => {
  it('has exactly one row that teaches', () => {
    expect(teachingModes).toHaveLength(1)
  })

  it('names it Flight School in the hangar (Matt, call 1)', () => {
    expect(facetName('mode', TEACHING)).toBe('Flight School')
    expect(cardFor(lessonLevel(), null).modeName).toBe('Flight School')
  })
})

describe('a valid lesson parses', () => {
  it("accepts the plan's ten-step lesson on rookie_02's own course", () => {
    const level = lessonLevel()
    expect(liveRings(level)).toHaveLength(21)
    expect(() => validateLevel(level)).not.toThrow()
    expect(() => validateModeContent(level)).not.toThrow()
  })

  it('and so does the JSON Schema', () => {
    expect(schemaErrors(LESSON)).toEqual([])
  })

  /** One legal instance of every kind. Its keys must BE the vocabulary. */
  const EXAMPLES: Record<LessonTriggerKind, LessonTrigger> = {
    launched: { kind: 'launched' },
    speedAtLeast: { kind: 'speedAtLeast', mps: 50, forSeconds: 0 },
    speedAtMost: { kind: 'speedAtMost', mps: 5, forSeconds: 3 },
    passGate: { kind: 'passGate', ring: 20, clean: true },
    bankAtLeast: { kind: 'bankAtLeast', degrees: 180 },
    levelFor: { kind: 'levelFor', degrees: 5, seconds: 1.5 },
    input: { kind: 'input', action: 'airbrake', forSeconds: 0.5 },
    onLineWithin: { kind: 'onLineWithin', metres: 60 },
    offLineBeyond: { kind: 'offLineBeyond', metres: 150 },
    noseAbove: { kind: 'noseAbove', degrees: 60 },
    noseBelow: { kind: 'noseBelow', degrees: 35 },
    finish: { kind: 'finish' },
    seconds: { kind: 'seconds', n: 4 },
    sequence: { kind: 'sequence', of: [{ kind: 'launched' }, { kind: 'finish' }] },
    crash: { kind: 'crash' },
    contact: { kind: 'contact', mps: 30 },
  }

  it('accepts every trigger kind in the vocabulary, each where it is legal', () => {
    expect(Object.keys(EXAMPLES).sort()).toEqual(Object.keys(LESSON_TRIGGERS).sort())
    for (const [kind, trigger] of Object.entries(EXAMPLES)) {
      const spec = LESSON_TRIGGERS[kind as LessonTriggerKind]
      const level = withLesson((l) => {
        if (spec.interruptOnly) l.interrupts[0].on = trigger
        else l.steps[0].until = trigger
      })
      expect(() => validateLevel(level), kind).not.toThrow()
      expect(schemaErrors(level.lesson), kind).toEqual([])
    }
  })

  it('accepts a lesson with no interrupts, and one with every token', () => {
    expect(() => validateLevel(withLesson((l) => (l.interrupts = [])))).not.toThrow()
    const every = LESSON_TOKENS.map((t) => `{${t}}`).join(' ')
    // On the throttle step: `{target}` needs an `until` that asks for a speed
    // (DEV-378), and `speedAtLeast` does.
    const level = withLesson((l) => (l.steps[1].say = every))
    expect(() => validateLevel(level)).not.toThrow()
    expect(schemaErrors(level.lesson)).toEqual([])
  })

  it('accepts {target} wherever the until asks for a speed: a step, a sequence, an interrupt', () => {
    // DEV-378. The bank step's `sequence` has no speed member, so one is put
    // in first; the crash interrupt's `until` is a `speedAtLeast`.
    const level = withLesson((l) => {
      l.steps[1].title = 'PAST {target}'
      l.steps[4].until.of.unshift({ kind: 'speedAtMost', mps: 45, forSeconds: 0 })
      l.steps[4].say = 'Under {target}, then roll with {roll}.'
      l.interrupts[0].say = 'Hold {throttle} past {target}.'
    })
    expect(() => validateLevel(level)).not.toThrow()
    expect(schemaErrors(level.lesson)).toEqual([])
  })
})

/**
 * Each malformed shape, the message it must be refused with, and whether the
 * JSON Schema can see it too. The four the schema cannot see are cross-field or
 * need the course: a ring past the end, a duplicate id, resume >= wait.
 */
const MALFORMED: readonly {
  what: string
  edit: (l: Draft) => void
  message: RegExp
  schemaSees: boolean
}[] = [
  {
    what: 'an unknown trigger kind',
    edit: (l) => (l.steps[3].until = { kind: 'passRing', ring: 3 }),
    message: /unknown trigger kind "passRing"/,
    schemaSees: true,
  },
  {
    what: 'a trigger with no kind at all',
    edit: (l) => (l.steps[3].until = { ring: 3 }),
    message: /unknown trigger kind undefined/,
    schemaSees: true,
  },
  {
    what: 'a missing required field',
    edit: (l) => (l.steps[1].until = { kind: 'speedAtLeast', mps: 50 }),
    message: /steps\[1\]\.until\.forSeconds: missing/,
    schemaSees: true,
  },
  {
    what: 'a misspelt field (so an extra key AND a missing one)',
    edit: (l) => (l.steps[1].until = { kind: 'speedAtLeast', mps: 50, forsecs: 1 }),
    message: /unknown key\(s\) forsecs/,
    schemaSees: true,
  },
  {
    what: 'a field on a kind that takes none',
    edit: (l) => (l.steps[9].until = { kind: 'finish', ring: 20 }),
    message: /unknown key\(s\) ring/,
    schemaSees: true,
  },
  {
    what: 'a passGate ring past the end of the course',
    edit: (l) => (l.steps[3].until = { kind: 'passGate', ring: 21 }),
    message: /ring 21 is not on this course; it has 21 live ring/,
    schemaSees: false,
  },
  {
    what: 'a negative passGate ring',
    edit: (l) => (l.steps[3].until = { kind: 'passGate', ring: -1 }),
    message: /ring -1 is not on this course/,
    schemaSees: true,
  },
  {
    what: 'a fractional passGate ring',
    edit: (l) => (l.steps[3].until = { kind: 'passGate', ring: 2.5 }),
    message: /ring 2.5 is not on this course/,
    schemaSees: true,
  },
  {
    what: 'a passGate clean that is not a boolean',
    edit: (l) => (l.steps[3].until = { kind: 'passGate', ring: 3, clean: 'yes' }),
    message: /clean: must be true or false/,
    schemaSees: true,
  },
  {
    what: 'an unknown {token}',
    edit: (l) => (l.steps[1].say = 'Hold {throtle} to fly.'),
    message: /unknown token\(s\) \{throtle\}/,
    schemaSees: true,
  },
  {
    what: 'an unknown {token} in a title',
    edit: (l) => (l.steps[1].title = '{THROTTLE}'),
    message: /steps\[1\]\.title: unknown token/,
    schemaSees: true,
  },
  {
    // DEV-378: `{target}` prints the prompt's own `until`'s speed, and a
    // passGate has none, so it would print nothing a player could use.
    what: 'a {target} on a step whose until asks for no speed',
    edit: (l) => (l.steps[3].say = 'Through the middle at {target}.'),
    message: /steps\[3\]: \{target\} prints the speed this prompt's "until" asks for/,
    schemaSees: false,
  },
  {
    what: 'a {target} on an interrupt whose until asks for no speed',
    edit: (l) => (l.interrupts[2].say = 'Turn back at {target}.'),
    message: /interrupts\[2\]: \{target\} prints the speed/,
    schemaSees: false,
  },
  {
    what: 'an unmatched brace',
    edit: (l) => (l.interrupts[3].say = 'Hold {throttle to fly.'),
    message: /an unmatched brace/,
    schemaSees: true,
  },
  {
    what: 'a blank prompt',
    edit: (l) => (l.steps[0].say = '   '),
    message: /steps\[0\]\.say: must be a non-empty string/,
    schemaSees: true,
  },
  {
    what: 'an interrupt-only kind ending a step',
    edit: (l) => (l.steps[2].until = { kind: 'crash' }),
    message: /"crash" can only start an interrupt/,
    schemaSees: true,
  },
  {
    what: 'an interrupt-only kind ending an interrupt',
    edit: (l) => (l.interrupts[0].until = { kind: 'contact', mps: 30 }),
    message: /"contact" can only start an interrupt/,
    schemaSees: true,
  },
  {
    what: 'an interrupt-only kind inside a sequence',
    edit: (l) => (l.steps[4].until = { kind: 'sequence', of: [{ kind: 'crash' }] }),
    message: /until\.of\[0\]: "crash" can only start an interrupt/,
    schemaSees: true,
  },
  {
    what: 'an empty sequence',
    edit: (l) => (l.steps[4].until = { kind: 'sequence', of: [] }),
    message: /must be a non-empty list of triggers/,
    schemaSees: true,
  },
  {
    what: 'an unknown kind nested in a sequence',
    edit: (l) => (l.steps[4].until.of[1] = { kind: 'levelOut', degrees: 5, seconds: 1 }),
    message: /until\.of\[1\]: unknown trigger kind "levelOut"/,
    schemaSees: true,
  },
  {
    what: 'an input action nobody has',
    edit: (l) => (l.steps[6].until = { kind: 'input', action: 'fire', forSeconds: 1 }),
    message: /action: must be one of throttle \| boost \| brake \| airbrake/,
    schemaSees: true,
  },
  {
    what: 'a speed of zero',
    edit: (l) => (l.interrupts[3].on = { kind: 'speedAtMost', mps: 0, forSeconds: 3 }),
    message: /on\.mps: must be a finite number above zero/,
    schemaSees: true,
  },
  {
    what: 'a negative hold',
    edit: (l) => (l.steps[1].until = { kind: 'speedAtLeast', mps: 50, forSeconds: -1 }),
    message: /forSeconds: must be a finite number, zero or more/,
    schemaSees: true,
  },
  {
    what: 'a bank past a half turn',
    edit: (l) => (l.steps[4].until.of[0] = { kind: 'bankAtLeast', degrees: 200 }),
    message: /degrees: must be degrees above zero and at most 180/,
    schemaSees: true,
  },
  {
    what: 'a lesson with no steps',
    edit: (l) => (l.steps = []),
    message: /lesson\.steps: must be a non-empty list/,
    schemaSees: true,
  },
  {
    what: 'a lesson with no interrupts list',
    edit: (l) => delete l.interrupts,
    message: /lesson\.interrupts: must be a list/,
    schemaSees: true,
  },
  {
    what: 'an unknown key on the lesson',
    edit: (l) => (l.pacing = 'slow'),
    message: /lesson: unknown key\(s\) pacing/,
    schemaSees: true,
  },
  {
    what: 'an unknown key on a step',
    edit: (l) => (l.steps[0].hint = 'look down'),
    message: /steps\[0\]: unknown key\(s\) hint/,
    schemaSees: true,
  },
  {
    what: 'a step id used twice',
    edit: (l) => (l.steps[1].id = 'launch'),
    message: /"launch" is used twice/,
    schemaSees: false,
  },
  {
    what: 'an interrupt sharing a step id',
    edit: (l) => (l.interrupts[0].id = 'bank'),
    message: /"bank" is used twice/,
    schemaSees: false,
  },
  {
    what: 'an instructor with no gain',
    edit: (l) => delete l.instructor.gain,
    message: /instructor\.gain: missing — there is no default/,
    schemaSees: true,
  },
  {
    what: 'an instructor key the pace law does not read',
    edit: (l) => (l.instructor.speed = 55),
    message: /instructor: unknown key\(s\) speed/,
    schemaSees: true,
  },
  {
    what: 'an instructor colour that is not #rrggbb',
    edit: (l) => (l.instructor.colour = 'white'),
    message: /instructor\.colour: must be #rrggbb/,
    schemaSees: true,
  },
  {
    what: 'an instructor with no tuning',
    edit: (l) => (l.instructor.tuning = ''),
    message: /instructor\.tuning: must name a tuning/,
    schemaSees: true,
  },
  {
    what: 'a resume radius at the wait radius',
    edit: (l) => (l.instructor.resumeWithinMetres = 400),
    message: /resumeWithinMetres \(400\) must be less than waitBeyondMetres \(400\)/,
    schemaSees: false,
  },
  {
    what: 'a step pace that is not lead or race',
    edit: (l) => (l.steps[9].instructor.pace = 'sprint'),
    message: /instructor\.pace: must be one of lead \| race/,
    schemaSees: true,
  },
  {
    what: 'a step student cap that is not positive (DEV-790)',
    edit: (l) => (l.steps[1].student = { maxSpeed: 0 }),
    message: /steps\[1\]\.student\.maxSpeed/,
    schemaSees: true,
  },
  {
    what: 'a step student key nothing reads (DEV-790)',
    edit: (l) => (l.steps[1].student = { maxSpeed: 52, boost: false }),
    message: /steps\[1\]\.student: unknown key\(s\) boost/,
    schemaSees: true,
  },
  {
    what: 'a step student block with no cap (DEV-790)',
    edit: (l) => (l.steps[1].student = {}),
    message: /steps\[1\]\.student\.maxSpeed: missing/,
    schemaSees: true,
  },
  {
    what: 'a step instructor key nothing reads',
    edit: (l) => (l.steps[1].instructor.gain = 2),
    message: /steps\[1\]\.instructor: unknown key\(s\) gain/,
    schemaSees: true,
  },
]

describe('each malformed shape is refused', () => {
  for (const bad of MALFORMED) {
    it(`refuses ${bad.what}`, () => {
      const level = withLesson(bad.edit)
      expect(() => validateLevel(level)).toThrow(LevelSchemaError)
      expect(() => validateLevel(level)).toThrow(bad.message)
      // And the JSON Schema agrees wherever a schema can say it. Where it
      // cannot, it must say nothing: a schema that refused a valid-shaped
      // lesson for a reason of its own would be a third opinion.
      expect(schemaErrors(level.lesson).length > 0, 'the schema should refuse it too').toBe(
        bad.schemaSees,
      )
    })
  }

  it('refuses a listed that is not a boolean', () => {
    const level = { ...lessonLevel(), listed: 'yes' } as unknown as Level
    expect(() => validateLevel(level)).toThrow(/listed must be true or false/)
  })

  it('refuses a level whose mode teaches and carries no lesson', () => {
    expect(() => validateModeContent(lessonLevel(null))).toThrow(
      /a mode that teaches, and carries no lesson block/,
    )
    // And with the key absent altogether, which is how a generated file says it.
    const { lesson: _absent, ...noKey } = lessonLevel()
    expect(() => validateModeContent(noKey as Level)).toThrow(LevelSchemaError)
  })

  it('refuses a lesson on a level whose mode does not teach', () => {
    const racing = { ...lessonLevel(), mode: COURSE.mode } as Level
    expect(rulesFor(COURSE.mode).teaches).toBe(false)
    expect(() => validateModeContent(racing)).toThrow(/a mode that does not teach/)
  })

  it('refuses a mode that is not a row at all', () => {
    const typo = { ...COURSE, mode: 'lessons' } as unknown as Level
    expect(() => validateModeContent(typo)).toThrow(/mode "lessons" is not a row/)
    const forcedTypo = { ...COURSE, forcedModeFf2: { mode: 'ringatack' } } as unknown as Level
    expect(() => validateModeContent(forcedTypo)).toThrow(/mode "ringatack" is not a row/)
  })
})

describe('the mode row is read from the descriptor, never from a name', () => {
  it('follows teaches wherever it is set — flip two rows and the verdicts flip', () => {
    // A check that compared `level.mode` against a string would not notice
    // either flip. This one reads the ROW, so both verdicts must invert.
    const flipped = {
      ...MODES,
      [COURSE.mode]: { ...rulesFor(COURSE.mode), teaches: true },
      [TEACHING]: { ...rulesFor(TEACHING), teaches: false },
    }
    expect(() => validateModeContent(COURSE)).not.toThrow()
    expect(() => validateModeContent(COURSE, flipped)).toThrow(/teaches, and carries no lesson/)
    expect(() => validateModeContent(lessonLevel())).not.toThrow()
    expect(() => validateModeContent(lessonLevel(), flipped)).toThrow(/does not teach/)
  })

  it('never lets Quick Race board a card whose mode teaches', () => {
    // A card for rookie_02 in EVERY mode, so the pool is offered a teaching
    // card whatever the pool's rule turns out to be.
    const base = cardFor(COURSE, null)
    const cards = (Object.keys(MODES) as GameMode[]).map((mode) => ({
      ...base,
      id: `${base.id}:${mode}`,
      mode,
    }))
    expect(cards.some((c) => rulesFor(c.mode).teaches)).toBe(true)
    const pool = quickRacePool(cards)
    expect(pool.length).toBeGreaterThan(0)
    for (const card of pool) expect(rulesFor(card.mode).teaches, card.id).toBe(false)
    expect(rulesFor(QUICK_RACE_MODE).teaches).toBe(false)
  })
})

describe('listed: an authored course is on the menus only when it says so', () => {
  /** A fake tree, shaped exactly like `import.meta.glob`'s answer. */
  const tree = (prefix: string, levels: Record<string, unknown>): LevelModules =>
    Object.fromEntries(
      Object.entries(levels).map(([id, value]) => [
        `${prefix}${id}.json`,
        () =>
          value instanceof Error
            ? Promise.reject(value)
            : Promise.resolve({ default: value as Level }),
      ]),
    )

  it('lists every generated course, and an authored one only with listed: true', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ids = await listedLevelIds({
      generated: tree('/content/levels/', {
        b_generated: { listed: undefined },
        a_generated: {},
        _schema: {},
      }),
      authored: tree('/content/authored/', {
        course: { listed: true },
        fixture: {},
        hidden: { listed: false },
        broken: new Error('unreadable'),
        _lesson: { listed: true },
      }),
    })
    expect(ids).toEqual(['a_generated', 'b_generated', 'course'])
    // The broken one is dropped loudly, not silently, and costs nobody else.
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it("keeps the perf fixtures off the real menus, and the glider off 2016's", async () => {
    const unlisted = ['dev230_adv02_hoverJet', 'dev230_int01_jumpSeat']
    // The premise: they exist, in the authored tree, and say nothing about it.
    for (const id of unlisted) {
      expect(authoredLevelIds(), id).toContain(id)
      expect(readJson<Level>(`content/authored/${id}.json`).listed, id).toBeUndefined()
    }
    // DEV-399: the glider's course IS listed now, behind the edition's fleet —
    // so it is off the default list, which is 2016's two aircraft and
    // Classic's. `glider-wire.test.ts` holds the Anniversary side.
    const glider = 'anniv_01_glider'
    expect(readJson<Level>(`content/authored/${glider}.json`).listed).toBe(true)
    const ids = await levelIds()
    for (const id of [...unlisted, glider]) expect(ids, id).not.toContain(id)
    for (const id of generatedLevelIds()) expect(ids, id).toContain(id)
    const cards = await loadMissionIndex()
    for (const id of [...unlisted, glider]) expect(cards.map((c) => c.id)).not.toContain(id)
  })

  it('still loads an unlisted course by id — listing is the menu, not the loader', async () => {
    for (const id of [...generatedLevelIds(), ...authoredLevelIds()]) {
      await expect(loadLevel(id), id).resolves.toMatchObject({ id })
    }
  })
})

describe('the JSON Schema and the TypeScript vocabularies are one description', () => {
  const defs = SCHEMA.$defs as Record<string, SchemaNode>
  const kindOf = (ref: SchemaNode): string => (ref.$ref as string).replace('#/$defs/t_', '')

  it('names the same trigger kinds, with the same fields and the same required set', () => {
    const kinds = Object.keys(defs)
      .filter((k) => k.startsWith('t_'))
      .map((k) => k.slice(2))
    expect(kinds.sort()).toEqual(Object.keys(LESSON_TRIGGERS).sort())
    for (const kind of kinds) {
      const node = defs[`t_${kind}`] as SchemaNode
      const spec = LESSON_TRIGGERS[kind as LessonTriggerKind]
      const fields = Object.entries(spec.fields) as [string, { optional: boolean }][]
      const props = Object.keys(node.properties ?? {}).filter((p) => p !== 'kind')
      expect(props.sort(), kind).toEqual(fields.map(([f]) => f).sort())
      const required = (node.required ?? []).filter((r) => r !== 'kind')
      expect(required.sort(), kind).toEqual(
        fields
          .filter(([, f]) => !f.optional)
          .map(([f]) => f)
          .sort(),
      )
    }
  })

  it('puts exactly the interrupt-only kinds outside what may end a step', () => {
    const until = (defs.untilTrigger?.oneOf ?? []).map(kindOf)
    const onlyOn = (defs.onTrigger?.oneOf ?? [])
      .filter((r) => r.$ref !== '#/$defs/untilTrigger')
      .map(kindOf)
    const interruptOnly = Object.entries(LESSON_TRIGGERS)
      .filter(([, s]) => s.interruptOnly)
      .map(([k]) => k)
    expect(onlyOn.sort()).toEqual(interruptOnly.sort())
    expect([...until, ...onlyOn].sort()).toEqual(Object.keys(LESSON_TRIGGERS).sort())
  })

  it('knows the same tokens, input actions, paces and instructor keys', () => {
    const pattern = defs.prose?.pattern as string
    const tokens = /\\\{\(\?:([A-Za-z|]+)\)/.exec(pattern)?.[1]?.split('|') ?? []
    expect(tokens.sort()).toEqual([...LESSON_TOKENS].sort())
    // And the pattern BEHAVES as that list: each token alone passes, a stranger fails.
    const prose = new RegExp(pattern)
    for (const t of LESSON_TOKENS) expect(prose.test(`hold {${t}}`), t).toBe(true)
    expect(prose.test('hold {nope}')).toBe(false)

    expect(defs.t_input?.properties?.action?.enum).toEqual([...LESSON_INPUT_ACTIONS])
    expect(defs.stepInstructor?.properties?.pace?.enum).toEqual([...LESSON_PACES])
    expect([...(defs.instructor?.required ?? [])].sort()).toEqual(
      [...LESSON_INSTRUCTOR_KEYS].sort(),
    )
    expect(Object.keys(defs.stepInstructor?.properties ?? {}).sort()).toEqual(
      [...LESSON_STEP_INSTRUCTOR_KEYS].sort(),
    )
    // DEV-790: the student's cap block.
    expect(Object.keys(defs.stepStudent?.properties ?? {}).sort()).toEqual(
      [...LESSON_STEP_STUDENT_KEYS].sort(),
    )
    expect([...(defs.stepStudent?.required ?? [])]).toEqual([...LESSON_STEP_STUDENT_KEYS])
  })

  it('validates every authored lesson on disk, through both gates', () => {
    // None today: DEV-378 adds `lesson_01_canyon.json`, and this is where it is
    // held to the schema. The fixture above is what proves the gates work.
    for (const id of authoredLevelIds()) {
      const level = readJson<Level>(`content/authored/${id}.json`)
      if (level.lesson === undefined || level.lesson === null) continue
      expect(schemaErrors(level.lesson), id).toEqual([])
      expect(() => validateModeContent(validateLevel(level)), id).not.toThrow()
    }
  })
})
