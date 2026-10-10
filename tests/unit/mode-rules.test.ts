// tests/unit/mode-rules.test.ts — the mode seam, asserted on BEHAVIOUR.
//
// `_modes-spec.md` §10 test 14: "assert on the observable, not the flag". So
// nothing below says `mode === 'freeFlight'` and then checks a boolean called
// `clock`. It flies a run and checks that the clock did not end it, that the
// label on the HUD row changed, and that the medal came off a count.
//
// The last describe block is the structural one: a mechanical guard that no file
// under `src/game/**` or `src/sim/**` compares against a mode NAME. That is what
// makes "a fourth mode is a row, not a ladder" a checkable claim rather than an
// aspiration — the same trick `tests/unit/sim-purity-guard.test.ts` plays on
// `import 'three'`.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { type GameMode, type Level, liveRings } from '@/content/level-schema'
import {
  countLabel,
  countTotal,
  hudTimeLimit,
  type MissionState,
  medalInput,
  medalThresholds,
  startMission,
  stepMission,
} from '@/game/mission'
import { isLive, MODES, rulesFor, runningMode, scores } from '@/game/modes'
import { finishGap } from '@/game/targets'
import { FIXED_DT } from '@/sim/constants'
import { type Vec3, v3 } from '@/sim/math/vec3'
import { shippedLevelIds as ids, levelJson as level } from './helpers/content'
import { REPO as ROOT } from './helpers/repo-root'
import { listTsWithDts } from './helpers/source-tree'

/** Fly a straight line at `speed`, stepping the mission at the fixed timestep. */
const flyTo = (state: MissionState, L: Level, from: Vec3, to: Vec3, speed: number): Vec3 => {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = to.z - from.z
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy, dz) / (speed * FIXED_DT)))
  const at = v3()
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    at.x = from.x + dx * t
    at.y = from.y + dy * t
    at.z = from.z + dz * t
    stepMission(state, L, at, FIXED_DT)
  }
  return at
}

/**
 * Fly towards `to` and STOP on the step that scores.
 *
 * `flyTo` runs past the scoring step — a 22.6 m gate sphere is entered several
 * steps before its centre — and `state.event` is cleared at the top of every
 * step, so a test that wants to look at a live event has to stop on one.
 */
const flyUntilScore = (
  state: MissionState,
  L: Level,
  from: Vec3,
  to: Vec3,
  speed: number,
): void => {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = to.z - from.z
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy, dz) / (speed * FIXED_DT)))
  const at = v3()
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    at.x = from.x + dx * t
    at.y = from.y + dy * t
    at.z = from.z + dz * t
    if (stepMission(state, L, at, FIXED_DT) >= 0) return
  }
}

/** Sit still for `seconds`, which is what an exploration run looks like. */
const hover = (state: MissionState, L: Level, where: Vec3, seconds: number): void => {
  for (let t = 0; t < seconds; t += FIXED_DT) stepMission(state, L, where, FIXED_DT)
}

describe('forcedMode finally has a consumer', () => {
  it('records 2016 forcing exactly two of the thirteen', () => {
    // The 2016 RECORD, untouched by DEV-061 — which is half the point of that row.
    const forced = ids().filter((id) => level(id).forcedMode !== null)
    expect(forced).toEqual(['hoverJet_kauai_beg', 'int_02_jumpSeat'])
    for (const id of forced) expect(level(id).forcedMode, id).toBe('freeFlight')
  })

  it('ignores a requested ringAttack on the one forcing FF2 honours', () => {
    // DEV-061 drops `int_02_jumpSeat`'s — see `forced-mode.test.ts` for why, and
    // for the assertion that the 2016 value is still on the record.
    expect(runningMode(level('hoverJet_kauai_beg'), 'ringAttack')).toBe('freeFlight')
  })

  it('honours the request everywhere else — the other eleven nulls are meaningful', () => {
    // Three of the eleven carry `ForcedGameMode = 1` with the flag off, and it is
    // inert. A null here means "the player chooses", not "unknown".
    for (const id of ids()) {
      const L = level(id)
      // The EFFECTIVE forcing, which is what `runningMode` obeys. Reading
      // `L.forcedMode` here would put `int_02_jumpSeat` in the wrong arm and this
      // test would then be asserting 2016's record rather than the game's rule.
      if (L.forcedModeFf2 ? L.forcedModeFf2.mode : L.forcedMode) continue
      expect(runningMode(L, 'freeFlight'), id).toBe('freeFlight')
      expect(runningMode(L, 'ringAttack'), id).toBe('ringAttack')
      expect(runningMode(L), id).toBe(L.mode)
    }
  })

  it('runs kauai in Free Flight, which is what NEXT.md claim 2 was about', () => {
    const L = level('hoverJet_kauai_beg')
    const state = startMission(L)
    expect(state.mode).toBe('freeFlight')
    // The 21 rings are still IN the level — 2016 authored them and FF2 renders
    // them — but Free Flight does not score them, and the clock is off.
    expect(L.routes[0]?.rings.length).toBe(21)
    expect(scores('freeFlight', 'ring')).toBe(false)
    expect(isLive('freeFlight', 'ring')).toBe(false)
    expect(state.countTotal).toBe(11)
  })
})

describe('what Free Flight actually switches off', () => {
  const L = level('hoverJet_kauai_beg')

  it('has no clock: the HUD reads -- and three minutes does not end the run', () => {
    // `RaceTimer.cs:30`. The observable is that `timer.timeLimit` is still 180 in
    // the data and the run survives 200 s of it.
    expect(L.timer.timeLimit).toBe(180)
    expect(hudTimeLimit(L, 'freeFlight')).toBe(0)
    const state = startMission(L)
    hover(state, L, v3(0, 1000, 0), 200)
    expect(state.elapsed).toBeGreaterThan(180)
    expect(state.finished).toBe(false)
    expect(state.timeBonus).toBe(0)
  })

  it('keeps the clock in the other two modes', () => {
    expect(hudTimeLimit(level('int_01_hoverJet'), 'ringAttack')).toBe(180)
    expect(hudTimeLimit(level('int_01_jumpSeat'), 'targetPractice')).toBe(180)
  })

  it('relabels the HUD count row from GATES to ORBS, out of the level s own strings', () => {
    expect(countLabel(L, 'ringAttack')).toBe('GATES')
    expect(countLabel(L, 'freeFlight')).toBe('ORBS')
    // The JumpSeat ui set carries neither string — `HUD_Gameplay.UpdateUI()` is
    // commented out end to end — so Target Practice falls back to FF2's word.
    expect(countLabel(level('int_01_jumpSeat'), 'targetPractice')).toBe('PADS')
  })

  it('counts orbs rather than rings', () => {
    expect(countTotal(L, 'ringAttack')).toBe(21)
    expect(countTotal(L, 'freeFlight')).toBe(11)
    expect(countTotal(level('int_01_jumpSeat'), 'targetPractice')).toBe(6)
  })

  it('scores a raw COUNT — five orbs is 5, never 500', () => {
    const state = startMission(L)
    const orbs = state.orbs.orbs
    let at = v3(orbs[0]?.centre.x, (orbs[0]?.centre.y ?? 0) + 200, orbs[0]?.centre.z)
    for (let i = 0; i < 5; i++) {
      const orb = orbs[i]
      if (!orb) throw new Error('expected 11 orbs')
      at = flyTo(state, L, at, v3(orb.centre.x, orb.centre.y, orb.centre.z), 80)
    }
    expect(state.orbs.collected).toBe(5)
    expect(state.score).toBe(5)
    expect(medalInput(state)).toBe(5)
  })
})

describe('the run ends where the data says it does', () => {
  it('gives all thirteen shipped missions a finish volume — no fallback, no warning', () => {
    // The honest-degrade path exists; this asserts it is not firing. It was
    // silently firing for six missions for the whole life of the port, because
    // `level.finish` was null and nobody printed anything.
    for (const id of ids()) expect(finishGap(level(id)), id).toBeNull()
  })

  it('reads the JumpSeat finish as a box and the HoverJet one as a sphere', () => {
    const jump = startMission(level('int_01_jumpSeat'))
    const ring = startMission(level('int_01_hoverJet'))
    expect(jump.finish?.kind).toBe('box')
    expect(ring.finish?.kind).toBe('sphere')
    // The aim point a guidance system gets is the INSCRIBED radius of the box,
    // so anything that reaches it has genuinely entered the volume.
    expect(jump.finishGate?.radius).toBeCloseTo(2.826, 2)
    expect(ring.finishGate?.radius).toBeCloseTo(68.59, 2)
  })

  it('warns loudly, once, for a course with no finish at all', () => {
    const L = { ...level('int_01_jumpSeat'), finish: null } as Level
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    startMission(L)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('no finish volume')
    expect(String(warn.mock.calls[0]?.[0])).toContain('tuned, unread')
    warn.mockRestore()
  })

  it('never ends a Free Flight run — 2016 leaves exploration from the menu', () => {
    expect(rulesFor('freeFlight').endsOn).toBe('never')
    const L = level('hoverJet_kauai_beg')
    const state = startMission(L)
    // Straight through where the finish gate is. It is still in the data; this
    // mode simply does not look at it.
    const f = L.finish
    if (!f) throw new Error('expected a finish gate')
    flyTo(state, L, v3(f.pos[0], f.pos[1] + 500, -f.pos[2]), v3(f.pos[0], f.pos[1], -f.pos[2]), 120)
    expect(state.finish).toBeNull()
    expect(state.finished).toBe(false)
  })
})

describe('trap 19 — two runs do not share an event record', () => {
  it('leaves the first mission untouched when a second one is stepped', () => {
    const L = level('int_01_hoverJet')
    const first = startMission(L)
    const second = startMission(L)
    const gate = first.course.gates[0]
    if (!gate) throw new Error('expected gates')

    flyUntilScore(first, L, v3(gate.centre.x, gate.centre.y + 400, gate.centre.z), gate.centre, 200)
    expect(first.event.ring).toBeGreaterThanOrEqual(0)
    const snapshot = { ...first.event }
    const score = first.score
    const elapsed = first.elapsed

    // Step the SECOND one hard. A module-level scratch event would be rewritten
    // under the first one's feet — which is exactly how a finished AI racer
    // ended up flying on the other racer's stick (DEV-032).
    for (let i = 0; i < 3; i++) {
      const g = second.course.gates[i]
      if (!g) break
      flyTo(second, L, v3(g.centre.x, g.centre.y + 400, g.centre.z), g.centre, 200)
    }

    expect(second.score).toBeGreaterThan(0)
    expect(first.event).toEqual(snapshot)
    expect(first.score).toBe(score)
    expect(first.elapsed).toBe(elapsed)
  })
})

describe('a mode is a row, not a ladder', () => {
  it('describes every shipped mode, and the one FF2 added', () => {
    const known = new Set(Object.keys(MODES))
    for (const id of ids()) {
      const L = level(id)
      expect(known.has(L.mode), `${id} mode`).toBe(true)
      if (L.forcedMode) expect(known.has(L.forcedMode), `${id} forcedMode`).toBe(true)
    }
    // Three of 2016's, plus DEV-144's `energyRace` and DEV-375's `lesson`. The
    // list is spelled out so a sixth row cannot arrive unannounced.
    expect([...known].sort()).toEqual([
      'energyRace',
      'freeFlight',
      'lesson',
      'ringAttack',
      'targetPractice',
    ])
  })

  it('has NO generated level that teaches — a lesson is authored content', () => {
    // The teaching row is selected by a level, unlike `energyRace`, but only by
    // a HAND-AUTHORED one in `content/authored/`: the generated tree is 2016's
    // thirteen and 2016 switched its Training rank off. Asked of the row, never
    // of the name.
    for (const id of ids()) {
      const L = level(id)
      expect(rulesFor(runningMode(L)).teaches, id).toBe(false)
      expect(L.lesson ?? null, `${id} lesson`).toBeNull()
      expect(L.listed, `${id} listed`).toBeUndefined()
    }
  })

  it('has NO shipped level naming the mode FF2 added', () => {
    // The other half of the row above, and the more useful half. `energyRace`
    // is reachable only through `runningMode(level, requested)` — there is no
    // mission that selects it and there CANNOT be one today: `content/levels/`
    // is a generated, sha256-guarded tree and its own `_schema.json`, which is
    // in that manifest, enumerates the three 2016 modes.
    //
    // So this is the assertion that goes red on the day that changes, which is
    // the day somebody should re-read the DEV-144 row rather than discover the
    // gap again. It is deliberately NOT a claim that the mode is unreachable.
    for (const id of ids()) {
      const L = level(id)
      expect(rulesFor(L.mode).energyPowered, `${id} mode`).toBe(false)
      if (L.forcedMode) expect(rulesFor(L.forcedMode).energyPowered, `${id} forced`).toBe(false)
    }
  })

  it('honours a mode REQUEST where the level does not force one', () => {
    // `?mode=` is the request's one caller (DEV-144). This is the seam, and it
    // had no consumer for the life of the port.
    for (const id of ids()) {
      const L = level(id)
      if (L.forcedModeFf2 ? L.forcedModeFf2.mode : L.forcedMode) continue
      expect(runningMode(L, 'energyRace'), id).toBe('energyRace')
    }
  })

  it('lets a level FORCE a mode over any request', () => {
    // Kauai is locked to Free Flight and stays locked, whatever `?mode=` says.
    const forced = ids()
      .map((id) => level(id))
      .filter((L) => (L.forcedModeFf2 ? L.forcedModeFf2.mode : L.forcedMode))
    expect(forced.length).toBeGreaterThan(0)
    for (const L of forced) {
      expect(runningMode(L, 'energyRace')).not.toBe('energyRace')
    }
  })

  it('answers every rules question for a mode the caller only has as a string', () => {
    for (const mode of Object.keys(MODES) as GameMode[]) {
      const rules = rulesFor(mode)
      expect(rules.scores.length).toBeGreaterThan(0)
      for (const kind of rules.scores) expect(rules.live).toContain(kind)
      expect(rules.finishSettleSeconds).toBeGreaterThanOrEqual(0)
    }
  })

  // ── The structural claim ─────────────────────────────────────────────
  //
  // If adding a fourth mode is really "one row in MODES", then no rule can live
  // anywhere else — and the way a rule leaks out is a comparison against a mode
  // NAME. `src/game/modes.ts` is the one file allowed to spell them.
  it('mentions no mode name outside src/game/modes.ts', () => {
    // ── The allowlist, and it is EMPTY ───────────────────────────────────
    //
    // It held one entry for months: `src/game/jumpseat-flight.ts` read
    // `level.mode !== 'freeFlight'` to decide whether the tank drains. The rule
    // is real (`FuelManager.cs:30`) but it belongs to the mode rather than to the
    // vehicle, and as written it asked the DEFAULT mode instead of the running
    // one. It now reads `rulesFor(runningMode(level)).burnsFuel`, which is what
    // the note here always said the fix was — taken while DEV-061 was making the
    // difference between those two questions matter on a shipped mission.
    const ALLOWED: string[] = []
    const walk = (dir: string): string[] =>
      listTsWithDts(path.join(ROOT, dir), { optional: true }).map((p) =>
        path.relative(ROOT, p).split(path.sep).join('/'),
      )
    // Comments are stripped, so prose that merely NAMES a mode is fine — this is
    // about code that branches on one.
    const strip = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    // DEV-144's fourth mode is on the list for the same reason the other three
    // are: the ratchet is only a ratchet if it covers every name. A mode added
    // to `GameMode` and left out of here would be free to leak branches back
    // into `src/game` and `src/sim`, which is exactly what this guard exists to
    // stop — and it would do it silently, because the test would still pass.
    // DEV-375's fifth is on it too: the lesson runner, the instructor and the
    // Learn to Fly pool ask `teaches`, never the row's name.
    const names = /['"](?:ringAttack|targetPractice|freeFlight|energyRace|lesson)['"]/
    const offenders = walk('src/game')
      .concat(walk('src/sim'))
      .filter((f) => f !== 'src/game/modes.ts')
      .filter((f) => names.test(strip(fs.readFileSync(path.join(ROOT, f), 'utf8'))))
    // Every offender must be on the list, and the list must not grow. A file
    // that stops offending is simply removed from it — and now that it is empty,
    // it must stay empty: a ratchet, not a budget.
    expect(offenders.filter((f) => !ALLOWED.includes(f))).toEqual([])
    expect(ALLOWED).toEqual([])
  })
})

// ── DEV-375 — the fifth row, on BEHAVIOUR ──────────────────────────────────
//
// Found by what it does (`teaches`), and then flown: the observables the plan's
// §4.3 asked for — rings live and counted, no clock, nobody on the grid, no
// medal — on `rookie_02_hoverJet`, the course the first lesson copies.
describe('the teaching row, flown', () => {
  const teaching = (Object.keys(MODES) as GameMode[]).filter((m) => rulesFor(m).teaches)
  const TEACHING = teaching[0] as GameMode
  // A lesson block, because since DEV-377 a request for a teaching mode runs
  // only on a course that carries one (`requestKeepsTeaching`). What is in it
  // does not matter to the row's rules; that it is there does.
  const L = {
    ...level('rookie_02_hoverJet'),
    lesson: {
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
      steps: [{ id: 'home', title: 'HOME', say: 'Fly home.', until: { kind: 'finish' } }],
      interrupts: [],
    },
  } as Level

  it('is exactly one row', () => {
    expect(teaching).toHaveLength(1)
  })

  it("draws and counts the course's rings, so the canyon's gates are there to fly", () => {
    const state = startMission(L, TEACHING)
    expect(state.mode).toBe(TEACHING)
    expect(state.countTotal).toBe(liveRings(L).length)
    expect(countLabel(L, TEACHING)).toBe('GATES')
    const gate = state.course.gates[0]
    if (!gate) throw new Error('expected gates')
    flyUntilScore(state, L, v3(gate.centre.x, gate.centre.y + 400, gate.centre.z), gate.centre, 120)
    expect(state.course.passedCount).toBe(1)
    expect(state.score).toBeGreaterThan(0)
  })

  it('runs no clock: the HUD reads -- and 200 s of standing still ends nothing', () => {
    // 180 s is Ring Attack's limit on this course, and a learner's lap at
    // ~50 m/s is 3.5 to 4 minutes before any waiting (plan §2.6).
    expect(L.timer.timeLimit).toBe(180)
    expect(hudTimeLimit(L, TEACHING)).toBe(0)
    const state = startMission(L, TEACHING)
    hover(state, L, v3(0, 1000, 0), 200)
    expect(state.elapsed).toBeGreaterThan(180)
    expect(state.finished).toBe(false)
    expect(state.timeBonus).toBe(0)
  })

  it('puts nobody on the grid, and a lesson course awards no medal', () => {
    // `opponents` is the one field `boot/app.ts` reads to build the racers.
    expect(rulesFor(TEACHING).opponents).toBe(false)
    const none = { bronze: null, silver: null, gold: null, platinum: null }
    const course = { ...L, medals: none, medalsFf2: null } as unknown as Level
    expect(medalThresholds(course, TEACHING)).toBeNull()
  })
})
