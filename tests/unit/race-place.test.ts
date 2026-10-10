// tests/unit/race-place.test.ts — your place in the race, live. DEV-361.
//
// `game/race-place.ts` orders the field while nobody has a time: a racer that
// has crossed is ahead, one the race clock stopped is behind, and two runs in
// the air compare on the furthest gate reached and then on metres along the
// line. At and after the player's crossing it hands over to `withStandings`,
// the results panel's own ordering, so the two cannot disagree at the line.
//
// The three cases the brief named are the three `describe('the ordering')`
// tests at the top, and each was proved RED against a mutant of `racerAhead`
// (see the DEV-361 row): the tie against `>=` on the arc, the gate-ahead case
// against ordering on the arc alone, and the finished racer against an
// ordering that ignores the standing.

import { describe, expect, it } from 'vitest'
import {
  gatesReached,
  type LiveRacerReading,
  livePlace,
  placeNow,
  type RaceLine,
  type RaceProgress,
  type RacerPlaceReading,
  raceProgress,
  racerAhead,
} from '@/game/race-place'
import { withStandings } from '@/game/results-state'
import type { OpponentStanding, RunSummary } from '@/render/results'
import { createRoute, routeArcLengthNear } from '@/sim/route'

const flying = (name: string): OpponentStanding => ({ name, seconds: null, status: 'flying' })
const crossed = (name: string, seconds: number): OpponentStanding => ({
  name,
  seconds,
  status: 'finished',
})
const outOfTime = (name: string): OpponentStanding => ({ name, seconds: null, status: 'dnf' })
const at = (reached: number, arc: number): RaceProgress => ({ reached, arc })
const racer = (standing: OpponentStanding, progress: RaceProgress): RacerPlaceReading => ({
  standing,
  progress,
})

/** A run, as `summariseRun` would take it; only `finishedAt` decides a place. */
const run = (finishedAt: number | null): RunSummary => ({
  medal: '',
  gates: 21,
  gatesTotal: 21,
  timeSeconds: finishedAt ?? 180,
  ringScore: 2100,
  timeBonus: 0,
  proximityBonus: 0,
  cleanStreak: 0,
  score: 2100,
  finishedAt,
  best: null,
  improved: false,
  again: 'again',
  back: 'back',
  countLabel: 'GATES',
})

describe('the ordering', () => {
  it('a TIE shares a place: the same gates and the same metres are not ahead', () => {
    const player = at(3, 1200)
    const level = racer(flying('fast'), at(3, 1200))
    expect(racerAhead(level, player)).toBe(false)
    expect(livePlace(null, player, [level])).toEqual({ place: 1, field: 2 })
    // And with a third runner genuinely ahead, the tied pair share SECOND —
    // one more than the number strictly ahead, which is the results panel's
    // own dead-heat rule (`withStandings`'s `placeOf`).
    const leader = racer(flying('steady'), at(3, 1201))
    expect(livePlace(null, player, [level, leader])).toEqual({ place: 2, field: 3 })
  })

  it('a racer a GATE AHEAD is ahead, even where it is behind on the line', () => {
    // How it happens: the racer took gate 5, crashed, and the reset put it back
    // on the line behind where it hit (DEV-126 searches up to the gate still
    // owed, not from the last one taken). Its arc is now behind a player who is
    // still flying to gate 5.
    const player = at(4, 1000)
    const reset = racer(flying('cutter'), at(5, 900))
    expect(racerAhead(reset, player)).toBe(true)
    expect(livePlace(null, player, [reset])).toEqual({ place: 2, field: 2 })
    // And the converse, so the gates really are compared and not merely
    // present: the player a gate ahead and behind on the line is AHEAD.
    expect(racerAhead(racer(flying('cutter'), at(4, 1100)), at(5, 900))).toBe(false)
  })

  it('a FINISHED racer beats a flying player, however far round the player is', () => {
    // Every gate and the far end of the line, against a racer whose own
    // progress reads as nothing: the crossing is a result and progress is not.
    const player = at(21, 11_000)
    const done = racer(crossed('fast', 80), at(0, 0))
    expect(racerAhead(done, player)).toBe(true)
    expect(livePlace(null, player, [done])).toEqual({ place: 2, field: 2 })
  })

  it('a racer the race clock stopped is behind a player still flying', () => {
    const player = at(0, 0)
    const out = racer(outOfTime('wide'), at(21, 11_000))
    expect(racerAhead(out, player)).toBe(false)
    expect(livePlace(null, player, [out])).toEqual({ place: 1, field: 2 })
  })

  it('no opposition is no race: no place, and a field of nothing', () => {
    expect(livePlace(null, at(3, 1200), [])).toEqual({ place: null, field: 0 })
    expect(livePlace(run(77.3), at(21, 11_000), [])).toEqual({ place: null, field: 0 })
  })
})

describe('at the line, the place IS the results panel’s', () => {
  const standings = [crossed('fast', 70), flying('steady'), crossed('cutter', 80)]
  // Progress chosen to DISAGREE with the times: the flying racer is miles
  // ahead on the line and the fast finisher reads as nowhere. Only an answer
  // that ignores progress once there is a run can match the panel here.
  const progress = [at(0, 0), at(21, 11_000), at(0, 0)]
  const racers = standings.map((s, i) => racer(s, progress[i] as RaceProgress))

  it('is withStandings’s place and field, called on the same standings', () => {
    const r = run(77.3)
    const board = withStandings(r, standings)
    const live = livePlace(r, at(21, 11_000), racers)
    expect(live).toEqual({ place: board.place, field: board.field })
    // The number itself, so the relationship above cannot pass with both null.
    expect(live).toEqual({ place: 2, field: 4 })
  })

  it('a run the clock ended has no place — the panel says DNF, the map says nothing', () => {
    expect(livePlace(run(null), at(21, 11_000), racers)).toEqual({ place: null, field: 4 })
  })

  it('a dead heat at the line shares the place, as the panel does', () => {
    expect(livePlace(run(70), at(21, 0), racers).place).toBe(1)
  })
})

describe('gatesReached', () => {
  it('is 1 + the FURTHEST gate taken, not how many', () => {
    expect(gatesReached([])).toBe(0)
    expect(gatesReached([false, false, false])).toBe(0)
    expect(gatesReached([true, true, false])).toBe(2)
    // A skipped ring: three taken, four reached. The player who skipped gate
    // 2 is further round than a racer that took 0, 1 and 2 — DEV-289's rule,
    // and the reason the brief's "gates taken" was not used as it stood.
    expect(gatesReached([true, true, false, true])).toBe(4)
  })
})

// ── Arc length, searched on the leg being flown ──────────────────────────

/**
 * A course that FOLDS: out along x at z = 0 for 1 km, a 20 m turn, and back
 * along z = 20 (THREE space; `createRoute` mirrors z into sim space, so the
 * return leg is at sim z = −20). Gates at 500 m on the way out and at 1520 m,
 * x = 500, on the way back.
 */
const folded = (): RaceLine => {
  const pts: number[][] = []
  for (let x = 0; x <= 1000; x += 25) pts.push([x, 0, 0])
  for (let x = 1000; x >= 0; x -= 25) pts.push([x, 0, 20])
  const route = createRoute(pts)
  return { route, gateArc: [500, 1520] }
}

describe('raceProgress', () => {
  it('measures metres along the line on a straight', () => {
    const line = folded()
    const p = raceProgress(line, [false, false], { x: 300, y: 0, z: 0 })
    expect(p.reached).toBe(0)
    expect(p.arc).toBeCloseTo(300, 6)
  })

  it('stays on the leg being flown where the course folds back past it', () => {
    const line = folded()
    // On the way OUT, but nearer the return leg (8 m) than its own (12 m).
    const ship = { x: 300, y: 0, z: -12 }
    // The premise: a whole-line search DOES jump to the return leg, 1.4 km on.
    expect(routeArcLengthNear(line.route, ship)).toBeGreaterThan(1500)
    // The window stops at the first gate, which is still owed.
    const p = raceProgress(line, [false, false], ship)
    expect(p.arc).toBeCloseTo(300, 0)
  })

  it('once the first gate is taken, the return leg is the one being flown', () => {
    const line = folded()
    const p = raceProgress(line, [true, false], { x: 700, y: 0, z: -20 })
    expect(p.reached).toBe(1)
    // 1000 out, 20 across, 300 back — and NOT 700, the leg-out point 20 m away.
    expect(p.arc).toBeCloseTo(1320, 0)
  })

  it('writes into `out` and returns it, so a frame of six allocates nothing', () => {
    const line = folded()
    const out: RaceProgress = { reached: -1, arc: -1 }
    expect(raceProgress(line, [false, false], { x: 100, y: 0, z: 0 }, out)).toBe(out)
    expect(out.arc).toBeCloseTo(100, 6)
  })
})

describe('placeNow — the live objects, as app.ts holds them', () => {
  const live = (
    id: string,
    x: number,
    passed: boolean[],
    finishedAt: number | null = null,
  ): LiveRacerReading => ({
    spec: { id },
    finished: finishedAt !== null,
    finishedAt: finishedAt ?? 0,
    elapsed: 60,
    course: { passed },
    // SIM space: the return leg is at z = −20. See `folded`.
    jet: { body: { position: { x, y: 0, z: x > 1000 ? -20 : 0 } } },
  })

  it('counts the racers ahead on progress, through the results panel’s reader', () => {
    const line = folded()
    const player = { passed: [false, false], position: { x: 400, y: 0, z: 0 } }
    const racers = [
      live('fast', 450, [false, false]), // ahead on the same leg
      live('steady', 300, [false, false]), // behind on the same leg
      live('cutter', 0, [true, true], 58), // crossed
    ]
    expect(placeNow(line, null, player, racers, 180)).toEqual({ place: 3, field: 4 })
  })

  it('a racer the race clock stopped is behind, by `racerStanding`’s rule', () => {
    const line = folded()
    const player = { passed: [false, false], position: { x: 100, y: 0, z: 0 } }
    const late = { ...live('wide', 900, [false, false]), elapsed: 181 }
    expect(placeNow(line, null, player, [late], 180)).toEqual({ place: 1, field: 2 })
  })
})
