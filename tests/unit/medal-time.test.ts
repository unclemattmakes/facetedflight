// tests/unit/medal-time.test.ts: time in the medal, and every medal reachable. DEV-846.
//
// Matt, 2026-10-08: "it'd be nice if time was factored in, so speed was an
// influence." The design is in `game/medal-time.ts`: a bounded term (one ring's
// worth at most), scaled to the course, paid only on a run that took every ring
// (DEV-393 stands), with platinum asking for every ring PLUS half of it.
//
// What is asserted, and against what:
//
//   * REACHABILITY, per mission, across all thirteen (the rookie_01 platinum
//     lesson, CLAUDE.md: a threshold above anything a run can score is a medal
//     nobody can earn). The oracle is not the curve's own arithmetic: for the
//     ring courses it is a flown run (the autopilot on the authored line, which
//     takes every ring) scored through `stepMission` and awarded by `medalFor`;
//     for the others it is the mode's own ceiling.
//   * RINGS STILL MATTER MOST: no time makes a run that missed a ring platinum,
//     and a run that took one more ring always out-scores one that took one fewer.
//   * SPEED IS AN INFLUENCE: a quicker lap on the same rings scores more, and the
//     same rings are gold slow and platinum fast.

import { describe, expect, it } from 'vitest'
import { flyAutopilotLap } from '@/game/autopilot-lap'
import {
  clockCountsInMedal,
  courseLengthMetres,
  PLATINUM_TIME_SHARE,
  timePoints,
  timeShare,
  timeTermFor,
} from '@/game/medal-time'
import {
  courseGates,
  medalFor,
  missionScore,
  startMission,
  stepMission,
  timeBonus,
} from '@/game/mission'
import { countTotal, medalCurve, rulesFor, runningMode } from '@/game/modes'
import { arcadePadCeiling } from '@/game/targets'
import { lapCourse } from '@/net/lap-courses'
import { FIXED_DT } from '@/sim/constants'
import { type Vec3, v3 } from '@/sim/math/vec3'
import { editionJson, shippedLevels, validLevel } from './helpers/content'

const LEVELS = shippedLevels()

/** Three space -> sim space: the z flip every gate centre goes through. */
const sim = (p: readonly number[]): Vec3 => v3(p[0] as number, p[1] as number, -(p[2] as number))

describe('every medal is reachable, on every mission', () => {
  it('finds all thirteen missions', () => {
    expect(LEVELS.length).toBeGreaterThanOrEqual(13)
  })

  for (const level of LEVELS) {
    it(`${level.id}: no threshold asks for more than the mode can pay`, () => {
      const mode = runningMode(level)
      const curve = medalCurve(level, mode)
      if (curve === null) return // awards no medal (rookie_01_jumpSeat has no curve at all)
      const rules = rulesFor(mode)
      // The most a run can possibly bank, from the mode's own ceiling.
      let most: number
      if (rules.medalScale === 'count') {
        most = countTotal(level, mode)
      } else if (rules.scores.includes('padZone')) {
        most = arcadePadCeiling(level)
      } else {
        const ring = courseGates(level).reduce((sum, g) => sum + g.points, 0)
        const term = clockCountsInMedal(level, rules) ? timeTermFor(level) : null
        most = ring + (term?.max ?? 0)
      }
      for (const band of ['bronze', 'silver', 'gold', 'platinum'] as const) {
        expect(
          curve[band],
          `${level.id} ${band} (${curve[band]}) vs the most ${most}`,
        ).toBeLessThanOrEqual(most)
      }
    })
  }
})

describe('the autopilot, flying the authored line, earns platinum on every ring course', () => {
  const ringCourses = LEVELS.filter((l) => {
    const rules = rulesFor(runningMode(l))
    return clockCountsInMedal(l, rules) && lapCourse(l.id) !== null
  })

  it('finds the six HoverJet ring courses', () => {
    expect(ringCourses.length).toBeGreaterThanOrEqual(6)
  })

  for (const level of ringCourses) {
    it(`${level.id}`, () => {
      const course = lapCourse(level.id) as NonNullable<ReturnType<typeof lapCourse>>
      const lap = flyAutopilotLap(level, course.worldOffset)
      expect(lap.rings, 'the lap took every ring').toBe(courseGates(level).length)
      const term = timeTermFor(level) as NonNullable<ReturnType<typeof timeTermFor>>
      // The pace has real margin over the bar, so a retune of the autopilot does
      // not flip the medal on a hair.
      expect(timeShare(term, lap.finishAt)).toBeGreaterThan(PLATINUM_TIME_SHARE + 0.15)
      // And scored by the game's own scorer: all rings, then the clock, then awarded.
      const state = startMission(level)
      state.elapsed = lap.finishAt
      state.counted = state.countTotal
      state.ringsPassed = state.ringsTotal
      state.score = courseGates(level).reduce((sum, g) => sum + g.points, 0)
      expect(timeBonus(state, level)).toBe(timePoints(term, lap.finishAt))
      state.timeBonus = timeBonus(state, level)
      expect(medalFor(state, level)).toBe('platinum')
    })
  }
})

describe('rings matter most', () => {
  const int01 = validLevel('int_01_hoverJet')
  const term = timeTermFor(int01) as NonNullable<ReturnType<typeof timeTermFor>>
  const rules = rulesFor(runningMode(int01))
  const each = int01.scoring.gateMultiplier
  const total = courseGates(int01).length

  const scored = (rings: number, seconds: number) => {
    const s = startMission(int01)
    s.elapsed = seconds
    s.counted = rings
    s.ringsPassed = rings
    s.score = rings * each
    s.timeBonus = timeBonus(s, int01)
    return s
  }

  it('the whole term is worth no more than one ring', () => {
    expect(term.max).toBeLessThanOrEqual(each)
  })

  it('a missed ring forfeits the clock, so no pace makes a run that missed one platinum', () => {
    const fastest = scored(total - 1, 1)
    expect(fastest.timeBonus).toBe(0)
    expect(medalFor(fastest, int01)).not.toBe('platinum')
    // ...and one more ring always out-scores one fewer, whatever the clock says.
    expect(missionScore(scored(total, term.slowSeconds + 50))).toBeGreaterThan(
      missionScore(scored(total - 1, 1)),
    )
  })

  it('the same rings are gold slow and platinum fast: speed is an influence', () => {
    const slow = scored(total, term.slowSeconds)
    const fast = scored(total, term.fastSeconds)
    expect(medalFor(slow, int01)).toBe('gold')
    expect(medalFor(fast, int01)).toBe('platinum')
    expect(missionScore(fast)).toBeGreaterThan(missionScore(slow))
  })

  it('the bar sits where the share says: at the mid pace, not before', () => {
    const span = term.slowSeconds - term.fastSeconds
    const at = (share: number) => term.slowSeconds - share * span
    expect(medalFor(scored(total, at(PLATINUM_TIME_SHARE + 0.02)), int01)).toBe('platinum')
    expect(medalFor(scored(total, at(PLATINUM_TIME_SHARE - 0.02)), int01)).toBe('gold')
  })

  it('bronze to gold do not move with time', () => {
    const curve = medalCurve(int01, runningMode(int01)) as NonNullable<
      ReturnType<typeof medalCurve>
    >
    expect(curve.bronze).toBe(int01.medalsFf2?.bronze)
    expect(curve.silver).toBe(int01.medalsFf2?.silver)
    expect(curve.gold).toBe(int01.medalsFf2?.gold)
  })

  it('the clock is part of the medal only on a ring mode that pays one', () => {
    expect(clockCountsInMedal(int01, rules)).toBe(true)
    expect(clockCountsInMedal(int01, rulesFor('targetPractice'))).toBe(false)
    expect(clockCountsInMedal(int01, rulesFor('freeFlight'))).toBe(false)
  })
})

describe('the term follows the course', () => {
  it('is scaled to the gates: a longer course gets a longer clock', () => {
    const short = validLevel('rookie_01_hoverJet')
    const long = validLevel('adv_02_hoverJet')
    expect(courseLengthMetres(long)).toBeGreaterThan(courseLengthMetres(short))
    const a = timeTermFor(short) as NonNullable<ReturnType<typeof timeTermFor>>
    const b = timeTermFor(long) as NonNullable<ReturnType<typeof timeTermFor>>
    expect(b.fastSeconds).toBeGreaterThan(a.fastSeconds)
    expect(b.slowSeconds).toBeGreaterThan(a.slowSeconds)
  })

  it('pays the full term at or under the fast mark and nothing at or over the slow one', () => {
    const level = validLevel('int_01_hoverJet')
    const term = timeTermFor(level) as NonNullable<ReturnType<typeof timeTermFor>>
    expect(timePoints(term, 0)).toBe(term.max)
    expect(timePoints(term, term.fastSeconds)).toBe(term.max)
    expect(timePoints(term, term.slowSeconds)).toBe(0)
    expect(timePoints(term, 1e6)).toBe(0)
  })

  it('a flown run through the real scorer pays the term on a clean finish', () => {
    // The synthetic leg: release -> every gate -> finish, stepped through
    // `stepMission` as the game steps it.
    const level = validLevel('rookie_01_hoverJet')
    const gates = courseGates(level).map((g) => g.centre)
    const fin = sim((level.finish as NonNullable<typeof level.finish>).pos as number[])
    const start = sim(level.spawn.pos as number[])
    start.y += level.spawn.launch?.rise ?? 0
    const edition = editionJson('anniversary')
    const state = startMission(level)
    const at = v3()
    let from = start
    const speed = 400
    for (const to of [...gates, fin]) {
      const d = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)
      const n = Math.max(1, Math.ceil(d / (speed * FIXED_DT)))
      for (let i = 1; i <= n && !state.finished; i++) {
        const t = i / n
        at.x = from.x + (to.x - from.x) * t
        at.y = from.y + (to.y - from.y) * t
        at.z = from.z + (to.z - from.z) * t
        stepMission(state, level, at, FIXED_DT, {
          clearance: 0,
          speed,
          struck: false,
          proximity: edition.gameplay.proximity,
          gateEvents: edition.gameplay.gateEvents,
        })
      }
      from = to
    }
    expect(state.finished).toBe(true)
    expect(state.timeBonus).toBeGreaterThan(0)
    expect(medalFor(state, level)).toBe('platinum')
  })
})
