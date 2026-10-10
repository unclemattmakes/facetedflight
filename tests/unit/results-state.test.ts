// tests/unit/results-state.test.ts — what the results panel SAYS (DEV-344).
//
// `tests/e2e/completion.spec.ts` proves every mission can be finished and that
// a Target Practice run SCORES; it never read the panel. Both defects below
// were on the panel, and both were found by an autopilot playtest on
// 2026-09-24 rather than by any test:
//
//  1. **A won race read as "everyone DNF".** The panel's opposition was read
//     once, on the tick the player crossed, so every racer still in the air
//     printed DNF for as long as the panel was up — five of them, on a run that
//     beat all five. The standings are now joined every frame (`withStandings`),
//     a racer in the air is `flying`, and DNF is kept for a runner the race
//     clock ran out on.
//  2. **A perfect Target Practice board read `0/0 PADS`.** The panel took the
//     RING counters, which Target Practice leaves at 0; the HUD had always
//     taken the objective's. And it printed `+ 0 time` for a mode whose rules
//     earn no time bonus.
//
// Case 2 is flown through the real scorer on the mission it was seen on,
// because its whole mechanism is that two counters AGREE in Ring Attack and
// disagree in Target Practice — a synthetic mission would be the agreement
// case written by hand (CLAUDE.md, "The agreement lesson").

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { GameMode, Level } from '@/content/level-schema'
import { courseGates, type MissionState, startMission, stepMission } from '@/game/mission'
import { countLabel, MODES, rulesFor } from '@/game/modes'
import {
  AUTOPILOT_BEST_NOTE,
  AUTOPILOT_HEADING,
  ghostStanding,
  LESSON_COMPLETE,
  type RacerReading,
  type ResultsDevice,
  type RunEndFacts,
  racerStanding,
  raceTimeLimit,
  resultsHeading,
  resultsWords,
  rowBelowWords,
  runExtras,
  summariseRun,
  withStandings,
} from '@/game/results-state'
import { finishPadAirspace, padZones } from '@/game/targets'
import { AGAIN_LABEL, RACE_LAP_LABEL } from '@/input/touch-overlay'
import {
  countLine,
  type OpponentStanding,
  ordinal,
  type RunSummary,
  scoreBreakdown,
  standingText,
} from '@/render/results'
import { FIXED_DT } from '@/sim/constants'
import { type Vec3, v3 } from '@/sim/math/vec3'
import type { TargetZone } from '@/sim/targets'
import { levelJson as level } from './helpers/content'
import { REPO as ROOT } from './helpers/repo-root'

/** Straight line at `speed`, through the real scorer, one fixed step at a time. */
const flyTo = (state: MissionState, L: Level, from: Vec3, to: Vec3, speed: number): Vec3 => {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = to.z - from.z
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy, dz) / (speed * FIXED_DT)))
  const at = v3(from.x, from.y, from.z)
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    at.x = from.x + dx * t
    at.y = from.y + dy * t
    at.z = from.z + dz * t
    stepMission(state, L, at, FIXED_DT)
  }
  return v3(at.x, at.y, at.z)
}

const extrasFor = (L: Level, state: MissionState) => ({
  medal: 'gold',
  best: null,
  improved: false,
  again: 'again',
  back: 'back',
  countLabel: countLabel(L, state.mode),
})

/**
 * A perfect Target Practice board: every pad's bullseye, the finish pad last.
 * Travels between pads high above everything and drops straight down, so no
 * pad is crossed on the way to another.
 */
const perfectBoard = (L: Level): MissionState => {
  const state = startMission(L)
  const air = finishPadAirspace(L)
  if (!air) throw new Error(`${L.id}: expected a finish pad`)
  const zones = padZones(L)
  const pads = [...new Set(zones.map((z) => z.pad))].filter((p) => p !== air.pad)
  let at = v3(0, 3000, 0)
  for (const pad of [...pads, air.pad]) {
    const eye = zones.find((z) => z.pad === pad && z.points === 100) as TargetZone
    at = flyTo(state, L, at, v3(at.x, 3000, at.z), 400)
    at = flyTo(state, L, at, v3(eye.centre.x, 3000, eye.centre.z), 400)
    at = flyTo(state, L, at, v3(eye.centre.x, eye.centre.y - 40, eye.centre.z), 40)
  }
  return state
}

/** int_01_hoverJet flown through all 21 rings and over the finish line. */
const ringAttackRun = (): { L: Level; state: MissionState } => {
  const L = level('int_01_hoverJet')
  const state = startMission(L)
  const gates = courseGates(L)
  const a = gates[0] as { centre: Vec3; radius: number }
  let at = v3(a.centre.x, a.centre.y + a.radius * 3, a.centre.z)
  for (const gate of gates) at = flyTo(state, L, at, gate.centre, 200)
  const f = L.finish
  if (!f) throw new Error('int_01_hoverJet: no finish')
  flyTo(state, L, at, v3(f.pos[0] as number, f.pos[1] as number, -(f.pos[2] as number)), 200)
  return { L, state }
}

describe('Target Practice: the panel counts PADS, and earns no time', () => {
  const L = level('adv_01_jumpSeat')
  const state = perfectBoard(L)
  const panel = withStandings(summariseRun(state, extrasFor(L, state)), [])

  it('flew the board the playtest saw — every pad, and the run ended', () => {
    expect(state.mode).toBe('targetPractice')
    expect(state.finished).toBe(true)
    expect(state.counted).toBe(state.countTotal)
    expect(state.countTotal).toBeGreaterThan(0)
  })

  it('is the case where the two counters DISAGREE', () => {
    // The premise of the defect, pinned: the ring counters this panel used to
    // read are zero here, while the objective's are the whole board.
    expect(state.ringsPassed).toBe(0)
    expect(state.ringsTotal).toBe(0)
  })

  it('prints the objective count, as the HUD does', () => {
    expect(panel.gates).toBe(state.counted)
    expect(panel.gatesTotal).toBe(state.countTotal)
    expect(countLine(panel).head.startsWith(`${state.countTotal}/${state.countTotal} PADS`)).toBe(
      true,
    )
  })

  it('prints no time term — the mode earns none', () => {
    expect(rulesFor('targetPractice').timeBonus).toBe(false)
    expect(panel.timeBonus).toBeNull()
    expect(scoreBreakdown(panel)).not.toContain('time')
    // The score still is the pads' score, and it is not zero.
    expect(panel.score).toBe(state.score)
    expect(panel.score).toBeGreaterThan(0)
  })

  it('is not a race: no board, no place', () => {
    expect(rulesFor('targetPractice').opponents).toBe(false)
    expect(panel.standings).toEqual([])
    expect(panel.place).toBeNull()
    expect(countLine(panel).place).toBe('')
  })
})

describe('Ring Attack: the same fields, where the counters agree', () => {
  const { L, state } = ringAttackRun()
  const run = summariseRun(state, extrasFor(L, state))

  it('counts gates and keeps the time term', () => {
    expect(state.finishCrossed).toBe(true)
    expect(run.gates).toBe(21)
    expect(run.gatesTotal).toBe(21)
    expect(run.timeBonus).toBe(state.timeBonus)
    expect(run.timeBonus).toBeGreaterThan(0)
    expect(scoreBreakdown(withStandings(run, []))).toBe(`2100 + ${state.timeBonus} time`)
  })

  it('records the crossing on the mission clock', () => {
    expect(run.finishedAt).toBe(state.finishAt)
    expect(run.finishedAt).toBe(state.elapsed)
  })
})

describe('the race outlives the run', () => {
  const { L, state } = ringAttackRun()
  const run = summariseRun(state, extrasFor(L, state))
  const mine = run.finishedAt as number
  const limit = raceTimeLimit(L, state.mode)

  /** A racer as the frame loop reads it: its clock runs on after the player's stops. */
  const racer = (id: string, at: number, crossedAt: number | null): RacerReading => ({
    spec: { id },
    finished: crossedAt !== null && crossedAt <= at,
    finishedAt: crossedAt !== null && crossedAt <= at ? crossedAt : 0,
    elapsed: at,
  })

  it('ends a race on the 180 s clock', () => {
    expect(limit).toBe(L.timer.timeLimit)
    expect(limit).toBe(180)
  })

  it('shows racers still in the air as flying, not DNF — the playtest board', () => {
    // The tick the player crossed: five racers, none of them home yet.
    const ids = ['fast', 'steady', 'cutter', 'wide', 'cruiser']
    const panel = withStandings(
      run,
      ids.map((id) => racerStanding(racer(id, mine, null), limit)),
    )
    const others = panel.standings.filter((s) => !s.you)
    expect(others.map((s) => s.status)).toEqual(['flying', 'flying', 'flying', 'flying', 'flying'])
    expect(others.map(standingText)).toEqual(Array(5).fill('still flying'))
    // Every one of them is beaten already: they cross later on the same clock.
    expect(others.every((s) => s.beaten)).toBe(true)
    expect(panel.place).toBe(1)
    expect(panel.field).toBe(6)
    expect(countLine(panel).place).toBe('1ST OF 6')
    expect(panel.standings[0]?.you).toBe(true)
  })

  it('fills a racer in when it crosses, and the place does not move', () => {
    const fastAt = mine + 5
    const read = (now: number) =>
      withStandings(run, [
        racerStanding(racer('fast', now, fastAt), limit),
        racerStanding(racer('steady', now, null), limit),
      ])
    const before = read(fastAt - FIXED_DT)
    const after = read(fastAt + FIXED_DT)
    const fast = (p: ReturnType<typeof read>) => p.standings.find((s) => s.name === 'fast')
    expect(fast(before)?.status).toBe('flying')
    expect(fast(after)?.status).toBe('finished')
    expect(fast(after)?.seconds).toBe(fastAt)
    expect(standingText(fast(after) as NonNullable<ReturnType<typeof fast>>)).toBe(
      `${fastAt.toFixed(1)}s`,
    )
    expect(fast(after)?.place).toBe(2)
    expect(fast(after)?.beaten).toBe(true)
    expect(before.place).toBe(1)
    expect(after.place).toBe(1)
  })

  it('places the player behind a racer that crossed first, and does not light it', () => {
    const panel = withStandings(run, [
      racerStanding(racer('fast', mine, mine - 3), limit),
      racerStanding(racer('steady', mine, null), limit),
    ])
    expect(panel.place).toBe(2)
    expect(countLine(panel).place).toBe('2ND OF 3')
    expect(panel.standings.map((s) => (s.you ? 'YOU' : s.name))).toEqual(['fast', 'YOU', 'steady'])
    expect(panel.standings.find((s) => s.name === 'fast')?.beaten).toBe(false)
    expect(panel.standings.find((s) => s.name === 'steady')?.beaten).toBe(true)
  })

  it('shares a place on a dead heat', () => {
    const panel = withStandings(run, [racerStanding(racer('fast', mine, mine), limit)])
    expect(panel.place).toBe(1)
    expect(panel.standings.map((s) => s.place)).toEqual([1, 1])
    // Level, so not beaten.
    expect(panel.standings.find((s) => !s.you)?.beaten).toBe(false)
  })

  it('keeps DNF for a racer the race clock ran out on', () => {
    expect(racerStanding(racer('slow', limit - FIXED_DT, null), limit).status).toBe('flying')
    expect(racerStanding(racer('slow', limit, null), limit).status).toBe('dnf')
    // Crossed, but after the clock would have ended its run.
    const late = racerStanding(racer('slow', limit + 10, limit + 5), limit)
    expect(late.status).toBe('dnf')
    expect(late.seconds).toBeNull()
    expect(standingText({ ...late, you: false, place: null, beaten: true })).toBe('DNF')
    // And on the line exactly counts, as it does for the player.
    expect(racerStanding(racer('slow', limit, limit), limit).status).toBe('finished')
  })

  it('never calls a racer DNF where no clock ends the race', () => {
    expect(racerStanding(racer('slow', 10_000, null), 0).status).toBe('flying')
  })

  it('gives a player the clock stopped no place, and beats nobody', () => {
    const timedOut: RunSummary = { ...run, finishedAt: null }
    const panel = withStandings(timedOut, [
      racerStanding(racer('fast', limit, 100), limit),
      racerStanding(racer('steady', limit, null), limit),
    ])
    expect(panel.place).toBeNull()
    expect(countLine(panel).place).toBe('DNF')
    expect(panel.standings.find((s) => s.you)?.status).toBe('dnf')
    expect(panel.standings.some((s) => s.beaten)).toBe(false)
  })

  // ── DEV-371: the player's ghost is on the board, and not in the race ────
  //
  // The oracle for "not in the race" is the race map's live place: it is
  // `livePlace`, which calls `withStandings` with the RACERS alone, so the
  // board must place the player exactly as that call does.
  it('lists your ghost in time order, and neither places it nor counts it (DEV-371)', () => {
    const racers = [
      racerStanding(racer('fast', mine, mine - 3), limit),
      racerStanding(racer('steady', mine, null), limit),
    ]
    const ghost = ghostStanding({ name: 'ghost', seconds: mine - 1 }, limit)
    const withGhost = withStandings(run, racers, [ghost])
    const racersOnly = withStandings(run, racers)
    // The place and the field are the racers' — the map's P2/3, not 3RD OF 4.
    expect(withGhost.place).toBe(racersOnly.place)
    expect(withGhost.field).toBe(racersOnly.field)
    expect(countLine(withGhost).place).toBe('2ND OF 3')
    // On the board, in time order: fast, the ghost a second ahead of you, you.
    expect(withGhost.standings.map((s) => (s.you ? 'YOU' : s.name))).toEqual([
      'fast',
      'ghost',
      'YOU',
      'steady',
    ])
    const row = withGhost.standings.find((s) => s.name === 'ghost')
    expect(row?.ghost).toBe(true)
    expect(row?.place).toBeNull()
    expect(row?.beaten).toBe(false)
    // And the racers keep the places they had without it.
    expect(withGhost.standings.filter((s) => !s.ghost).map((s) => s.place)).toEqual(
      racersOnly.standings.map((s) => s.place),
    )
  })

  it('lights a ghost you beat, and lists a dead heat with YOU first (DEV-371)', () => {
    const racers = [racerStanding(racer('steady', mine, null), limit)]
    const beaten = withStandings(run, racers, [
      ghostStanding({ name: 'ghost', seconds: mine + 0.5 }, limit),
    ])
    expect(beaten.standings.find((s) => s.ghost)?.beaten).toBe(true)
    // A lap raced against itself ties to the tick: level, not beaten, and after YOU.
    const tie = withStandings(run, racers, [ghostStanding({ name: 'ghost', seconds: mine }, limit)])
    expect(tie.standings.map((s) => (s.you ? 'YOU' : s.name))).toEqual(['YOU', 'ghost', 'steady'])
    expect(tie.standings.find((s) => s.ghost)?.beaten).toBe(false)
    expect(tie.place).toBe(1)
  })

  it('is no race with a ghost and nobody else: listed, and nothing to place among (DEV-371)', () => {
    const panel = withStandings(run, [], [ghostStanding({ name: 'ghost', seconds: mine }, limit)])
    expect(panel.field).toBe(0)
    expect(panel.place).toBeNull()
    expect(countLine(panel).place).toBe('')
    expect(panel.standings).toHaveLength(2)
  })

  it('reads a 2016 recording as finished or DNF — its result is known at load', () => {
    const ghosts: OpponentStanding[] = [
      ghostStanding({ name: 'fast', seconds: 57.32 }, limit),
      ghostStanding({ name: 'slow', seconds: null }, limit),
      ghostStanding({ name: 'late', seconds: limit + 1 }, limit),
    ]
    expect(ghosts.map((g) => g.status)).toEqual(['finished', 'dnf', 'dnf'])
  })
})

// ── DEV-379: a lesson's panel is headed LESSON COMPLETE ────────────────────
//
// FLIGHT-INSTRUCTOR §7: *"the normal panel, which the mode row already trims
// (no medal, no time bonus, no standings), headed LESSON COMPLETE where the
// mode teaches."* Flown here through the real scorer, on lesson 1's own file:
// every ring and over the finish, so the heading is read off a run that ENDED,
// the way the app reads it.
describe('a lesson is headed LESSON COMPLETE (DEV-379)', () => {
  const L = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'content', 'authored', 'lesson_01_canyon.json'), 'utf8'),
  ) as Level
  const state = startMission(L)
  const gates = courseGates(L)
  const a = gates[0] as { centre: Vec3; radius: number }
  let at = v3(a.centre.x, a.centre.y + a.radius * 3, a.centre.z)
  for (const gate of gates) at = flyTo(state, L, at, gate.centre, 60)
  const f = L.finish as NonNullable<Level['finish']>
  flyTo(state, L, at, v3(f.pos[0] as number, f.pos[1] as number, -(f.pos[2] as number)), 60)
  const run = summariseRun(state, { ...extrasFor(L, state), medal: 'none' })

  it('flew lesson 1 to its finish, in the mode that teaches', () => {
    expect(rulesFor(state.mode).teaches).toBe(true)
    expect(state.finished).toBe(true)
    expect(state.counted).toBe(gates.length)
  })

  it('heads the panel LESSON COMPLETE, over no time term', () => {
    expect(run.heading).toBe(LESSON_COMPLETE)
    expect(run.heading).toBe('LESSON COMPLETE')
    expect(run.timeBonus).toBeNull()
  })

  it('leaves every other mode headed by its medal', () => {
    const race = ringAttackRun()
    expect(summariseRun(race.state, extrasFor(race.L, race.state)).heading).toBeUndefined()
    const board = perfectBoard(level('adv_01_jumpSeat'))
    expect(summariseRun(board, extrasFor(level('adv_01_jumpSeat'), board)).heading).toBeUndefined()
  })
})

describe('ordinal', () => {
  it('handles the teens', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)).toEqual([
      '1ST',
      '2ND',
      '3RD',
      '4TH',
      '11TH',
      '12TH',
      '13TH',
      '21ST',
      '22ND',
      '23RD',
      '101ST',
      '111TH',
    ])
  })
})

describe("runExtras — the panel's words and the best at a run's end (APP-SPLIT 2.1)", () => {
  // Lifted out of the one call site in `boot/app.ts`, where these decisions
  // lived as an object literal no test could construct. Pinned as written
  // there; the strings are the ones a player reads.
  const ring = level('int_01_hoverJet')
  const facts = (over: Partial<RunEndFacts> = {}): RunEndFacts => ({
    level: ring,
    mode: ring.mode,
    medal: 'gold',
    outcome: { best: { score: 1234 }, improved: true },
    storageAvailable: () => true,
    fromEditor: false,
    lapLeft: false,
    device: () => 'keyboard',
    ...over,
  })

  it('shows the stored best, and says whether this run improved it', () => {
    const x = runExtras(facts())
    expect(x.medal).toBe('gold')
    expect(x.best).toBe(1234)
    expect(x.improved).toBe(true)
  })

  it('shows NO best where nothing could be stored, rather than this run as the best', () => {
    expect(runExtras(facts({ storageAvailable: () => false })).best).toBeNull()
  })

  it('keeps no best for a run that records none, and does not ask about storage then', () => {
    let asked = 0
    const x = runExtras(
      facts({
        outcome: null,
        storageAvailable: () => {
          asked += 1
          return true
        },
      }),
    )
    expect(x.best).toBeNull()
    expect(x.improved).toBe(false)
    expect(asked, 'storage is asked only when there is an outcome, as the call site did').toBe(0)
  })

  it('names the way home: the hangar, or the editor a playtest came from (DEV-406)', () => {
    expect(runExtras(facts()).again).toBe('ENTER for the hangar')
    expect(runExtras(facts({ fromEditor: true })).again).toBe('ENTER for the editor')
    expect(runExtras(facts()).back).toBe('BACKSPACE to fly again')
  })

  it("words every line in ONE device's controls, never a pad's and a keyboard's at once (DEV-599)", () => {
    const lines = (device: ResultsDevice) => {
      const x = runExtras(facts({ lapLeft: true, device: () => device }))
      return [x.again, x.back, x.race]
    }
    expect(lines('pad')).toEqual(['A for the hangar', 'START to fly again', 'Y to race this lap'])
    expect(lines('keyboard')).toEqual([
      'ENTER for the hangar',
      'BACKSPACE to fly again',
      'R to race this lap',
    ])
    expect(lines('xr')).toEqual([
      'A for the hangar',
      'X to fly again',
      'CLICK THE RIGHT STICK to race this lap',
    ])
    for (const device of ['pad', 'keyboard', 'xr', 'touch'] as const) {
      for (const line of lines(device)) expect(line, device).not.toMatch(/ or /)
    }
    expect(rowBelowWords('keyboard')).toBe('ENTER on a row below')
    expect(rowBelowWords('pad')).toBe('A on a row below')
    expect(rowBelowWords('xr')).toBe('A or the TRIGGER on a row below')
    expect(rowBelowWords('touch')).toBe('tap a row below')
  })

  it('says why an autopilot run has no best, where it would otherwise blame storage (DEV-601)', () => {
    const x = runExtras(facts({ outcome: null, autopilotFlew: true }))
    expect(x.best).toBeNull()
    expect(x.bestNote).toBe(AUTOPILOT_BEST_NOTE)
    expect(runExtras(facts()).bestNote).toBeUndefined()
    expect(
      runExtras(facts({ outcome: null })).bestNote,
      'a part of a course says nothing new',
    ).toBeUndefined()
  })

  it('heads an autopilot run AUTOPILOT where the medal goes, and a lesson still LESSON COMPLETE (DEV-601)', () => {
    expect(resultsHeading(ring.mode, true)).toBe(AUTOPILOT_HEADING)
    expect(resultsHeading(ring.mode, false)).toBeUndefined()
    expect(resultsHeading(ring.mode)).toBeUndefined()
    const lesson = (Object.keys(MODES) as GameMode[]).find((m) => rulesFor(m).teaches)
    expect(lesson, 'the premise: a mode that teaches').toBeDefined()
    if (lesson) expect(resultsHeading(lesson, true)).toBe(LESSON_COMPLETE)
  })

  it("names the phone's chips by their own labels (DEV-599)", () => {
    // Held to the overlay's exports, not to a copy: rename a chip and this goes red.
    const touch = resultsWords('touch')
    // DEV-607: no CONTINUE chip; the glass is the way home.
    expect(touch.home).toBe('tap the screen')
    expect(touch.again).toBe(`tap ${AGAIN_LABEL}`)
    expect(touch.race).toBe(`tap ${RACE_LAP_LABEL}`)
  })

  it('offers the lap only when the run left one, worded for the route in use (DEV-371)', () => {
    let asked = 0
    const headset = (): ResultsDevice => {
      asked += 1
      return 'xr'
    }
    expect(runExtras(facts({ lapLeft: false, device: headset })).race).toBe('')
    expect(runExtras(facts({ lapLeft: true })).race).toBe('R to race this lap')
    expect(runExtras(facts({ lapLeft: true, device: headset })).race).toBe(
      'CLICK THE RIGHT STICK to race this lap',
    )
    expect(asked, 'the device is asked for each line it words').toBeGreaterThan(0)
  })

  it("counts the MODE's objective in one word: gates on a ring course, pads on a target one", () => {
    expect(runExtras(facts()).countLabel).toBe('GATES')
    const pads = level('adv_01_jumpSeat')
    expect(rulesFor(pads.mode).scores, 'the premise: this mission scores pads').toContain('padZone')
    expect(runExtras(facts({ level: pads, mode: pads.mode })).countLabel).toBe('PADS')
  })
})
