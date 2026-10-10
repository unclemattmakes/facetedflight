// tests/unit/medal-performance.test.ts — DEV-393: a medal is awarded by PERFORMANCE.
//
// Matt, 2026-09-25: *"fix the scoring plz. medals should be awarded based on
// performance"*. The defect (`docs/BUGS.md`): `int_01_hoverJet` flown straight to
// the finish with 0 of 21 rings in ~26 s scored a SILVER, because DEV-004 put
// 2016's LEADERBOARD time bonus (`Scoreboard.cs:103`) into the medal on the
// premise that "a run that misses a ring never ends early" — and DEV-045 then
// ended every run at 2016's finish gate, whatever it had taken.
//
// The rule (`game/mission.ts`, `timeBonus`): a missed objective forfeits the time
// bonus. Everything here is asserted against RUNS through `stepMission` — never
// against a second copy of the arithmetic (trap 24) — and every course is found
// by reading `content/levels/`, so a fourteenth is covered without an edit.
//
// What each block proves, and against what:
//
//   · the exploit gets nothing — on every course whose mode pays a time bonus;
//   · rings always beat time — k+1 rings flown SLOWLY out-score k rings flown as
//     fast as the scorer will count them, for every k on every such course;
//   · a faster clean run beats a slower one, and one skipped ring costs more
//     than any pace can buy back;
//   · every threshold on all thirteen courses can be met, in the mode each runs;
//   · a missed pad caps Target Practice below gold (by arithmetic, pinned);
//   · a best stored under the OLD rule reads under the new one;
//   · the results panel says why a forfeited time term is 0.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import { bestRule } from '@/game/best-medal'
import {
  courseGates,
  type Medal,
  type MissionState,
  medalFor,
  missionScore,
  startMission,
  stepMission,
} from '@/game/mission'
import { cardFor, withVariant } from '@/game/mission-index'
import { medalCurve, rulesFor, runningMode } from '@/game/modes'
import { bestKey, type PersonalBest, readBest, recordRun } from '@/game/personal-best'
import { summariseRun, withStandings } from '@/game/results-state'
import { finishPadAirspace, padZones } from '@/game/targets'
import { scoreBreakdown } from '@/render/results'
import { FIXED_DT } from '@/sim/constants'
import { type Vec3, v3 } from '@/sim/math/vec3'
import { REPO as ROOT } from './helpers/repo-root'

const LEVELS = path.join(ROOT, 'content', 'levels')

/** Every shipped course, read off the directory — the thirteen, whatever they become. */
const SHIPPED: readonly Level[] = fs
  .readdirSync(LEVELS)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(LEVELS, f), 'utf8')) as Level)
  .filter((l) => typeof l.id === 'string' && Array.isArray(l.routes))

const byId = (id: string): Level => {
  const L = SHIPPED.find((l) => l.id === id)
  if (!L) throw new Error(`no shipped course ${id}`)
  return L
}

/** The courses where the clock can pay: the mode's ROW says so, not its name. */
const TIMED = SHIPPED.filter((L) => rulesFor(runningMode(L)).timeBonus)

const RANK: readonly Medal[] = ['none', 'bronze', 'silver', 'gold', 'platinum']
const rank = (m: Medal | null): number => RANK.indexOf(m ?? 'none')

/** Three space -> sim space: the z flip every gate centre goes through. */
const sim = (p: readonly number[]): Vec3 => v3(p[0] as number, p[1] as number, -(p[2] as number))

/** The release point: the spawn, lifted by the launch ride. */
const release = (L: Level): Vec3 => {
  const s = sim(L.spawn.pos as number[])
  s.y += L.spawn.launch?.rise ?? 0
  return s
}

const finishOf = (L: Level): Vec3 => {
  if (!L.finish) throw new Error(`${L.id} has no finish gate`)
  return sim(L.finish.pos as number[])
}

/** 1.5 km straight up: above every ring on every course, so a leg up here takes none. */
const high = (p: Vec3): Vec3 => v3(p.x, p.y + 1500, p.z)

/**
 * Fly straight legs through `points` at `speed`, sampled at the fixed step, then
 * idle at the last point until the run ends. A synthetic line, not a flight: it
 * says what the SCORER does with a path, which is this file's whole question.
 */
const flyPath = (state: MissionState, L: Level, points: readonly Vec3[], speed: number): void => {
  const at = v3()
  let from = points[0] as Vec3
  for (const to of points.slice(1)) {
    const d = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)
    const n = Math.max(1, Math.ceil(d / (speed * FIXED_DT)))
    for (let i = 1; i <= n && !state.finished; i++) {
      const t = i / n
      at.x = from.x + (to.x - from.x) * t
      at.y = from.y + (to.y - from.y) * t
      at.z = from.z + (to.z - from.z) * t
      stepMission(state, L, at, FIXED_DT)
    }
    from = to
  }
  const limit = Math.ceil(L.timer.timeLimit / FIXED_DT) + 10
  for (let i = 0; i < limit && !state.finished; i++) stepMission(state, L, from, FIXED_DT)
}

/** Take the first `k` rings in order, then leave OVER the rest and drop onto the finish. */
const firstRingsThenFinish = (L: Level, k: number, speed: number): MissionState => {
  const gates = courseGates(L).map((g) => g.centre)
  const state = startMission(L)
  const start = release(L)
  const taken = gates.slice(0, k)
  const last = taken[taken.length - 1] ?? start
  const fin = finishOf(L)
  const route =
    k === gates.length ? [start, ...taken, fin] : [start, ...taken, high(last), high(fin), fin]
  flyPath(state, L, route, speed)
  return state
}

/**
 * A pace for the clean witness: 240 m/s along the gate polyline. It was chosen
 * to sit just over DEV-004's reference pace (half of `ship.maxSpeed`, 218.75),
 * which platinum used to demand. Since the DEV-393 follow-up platinum is every
 * ring at ANY pace (`medal-every-ring.test.ts` flies a slow clean lap to it), so
 * this is now simply the fast arm of the clean pair, and still a platinum
 * witness because it is clean.
 */
const PLATINUM_PACE = 240

// ════════════════════════════════════════════════════════════════════════════

describe('DEV-393: the skip-every-ring exploit earns nothing', () => {
  it('covers every course whose mode pays a time bonus, and there are some', () => {
    expect(TIMED.length).toBeGreaterThan(0)
    expect(TIMED.map((L) => L.id)).toContain('int_01_hoverJet')
  })

  for (const L of TIMED) {
    it(`${L.id}: over every ring and onto the finish — no bonus, no medal`, () => {
      const state = startMission(L)
      const start = release(L)
      const fin = finishOf(L)
      flyPath(state, L, [start, high(start), high(fin), fin], 300)

      expect(state.ringsPassed, 'took no ring').toBe(0)
      expect(state.finishCrossed, 'crossed the finish').toBe(true)
      expect(state.finished).toBe(true)
      // The premise that made it an exploit: well inside par, so the clock WOULD pay.
      expect(state.elapsed).toBeLessThan(L.timer.bonusParTime / 2)

      expect(medalFor(state, L), 'no medal for no rings').toBe('none')
      expect(missionScore(state)).toBe(0)
      expect(state.timeBonus, 'the bonus is forfeited').toBe(0)
      expect(state.timeBonusForfeit, 'and every ring is why').toBe(state.countTotal)
    })
  }
})

describe('DEV-393: rings always beat time', () => {
  for (const L of TIMED) {
    it(`${L.id}: k+1 rings flown slowly out-score k rings flown fast, for every k`, {
      timeout: 60_000,
    }, () => {
      const n = courseGates(L).length
      for (let k = 0; k < n; k++) {
        // 800 m/s is as fast as the scorer counts a 22 m ring (9.8 m a step), and
        // not far under the boosted, chained ceiling. 200 is a slow lap.
        const fewer = firstRingsThenFinish(L, k, 800)
        const more = firstRingsThenFinish(L, k + 1, 200)
        expect(fewer.ringsPassed, `${L.id}: run A took ${k}`).toBe(k)
        expect(more.ringsPassed, `${L.id}: run B took ${k + 1}`).toBe(k + 1)
        expect(fewer.finishCrossed && more.finishCrossed, `${L.id} k=${k}: both crossed`).toBe(true)
        expect(
          missionScore(more),
          `${L.id}: ${k + 1} rings in ${more.elapsed.toFixed(1)} s vs ${k} in ${fewer.elapsed.toFixed(1)} s`,
        ).toBeGreaterThan(missionScore(fewer))
        expect(
          rank(medalFor(more, L)),
          `${L.id} k=${k}: never a worse medal`,
        ).toBeGreaterThanOrEqual(rank(medalFor(fewer, L)))
      }
    })
  }
})

describe('DEV-393: a faster clean run beats a slower one, and a skipped ring costs more than pace buys', () => {
  for (const L of TIMED) {
    it(`${L.id}`, { timeout: 30_000 }, () => {
      const n = courseGates(L).length
      const fast = firstRingsThenFinish(L, n, PLATINUM_PACE)
      const slow = firstRingsThenFinish(L, n, 120)
      expect(fast.ringsPassed).toBe(n)
      expect(slow.ringsPassed).toBe(n)
      expect(slow.finishCrossed, 'the slow lap still crossed inside the limit').toBe(true)
      expect(missionScore(fast)).toBeGreaterThan(missionScore(slow))
      expect(rank(medalFor(fast, L))).toBeGreaterThanOrEqual(rank(medalFor(slow, L)))

      // The same fast lap with ONE ring stepped over — the most tempting skip.
      const gates = courseGates(L).map((g) => g.centre)
      const skip = Math.floor(n / 2)
      const before = gates[skip - 1] as Vec3
      const after = gates[skip + 1] as Vec3
      const skipped = startMission(L)
      flyPath(
        skipped,
        L,
        [
          release(L),
          ...gates.slice(0, skip),
          high(before),
          high(after),
          ...gates.slice(skip + 1),
          finishOf(L),
        ],
        PLATINUM_PACE,
      )
      expect(skipped.ringsPassed).toBe(n - 1)
      expect(skipped.finishCrossed).toBe(true)
      expect(skipped.timeBonus).toBe(0)
      expect(skipped.timeBonusForfeit).toBe(1)
      // Below the SLOW clean lap: no pace buys back a ring.
      expect(missionScore(skipped)).toBeLessThan(missionScore(slow))
      expect(rank(medalFor(skipped, L))).toBeLessThanOrEqual(rank(medalFor(slow, L)))
      expect(medalFor(skipped, L)).not.toBe('platinum')
    })
  }
})

// ════════════════════════════════════════════════════════════════════════════

/** Straight down through a pad's bullseye, from and back to a safe height. */
const bullseyeRun = (L: Level, skip: number | null): MissionState => {
  const state = startMission(L)
  const zones = padZones(L)
  const pads = [...new Set(zones.map((z) => z.pad))]
  const finishPad = finishPadAirspace(L)?.pad ?? null
  // The finish pad LAST: its slab ends the run.
  const order = [...pads.filter((p) => p !== finishPad), ...(finishPad === null ? [] : [finishPad])]
  let at = v3(0, 3000, 0)
  for (const pad of order) {
    if (pad === skip) continue
    const eye = zones.find((z) => z.pad === pad && z.points === 100)
    if (!eye) throw new Error(`${L.id}: pad ${pad} has no bullseye`)
    const over = v3(eye.centre.x, eye.centre.y + 1000, eye.centre.z)
    const top = v3(eye.centre.x, eye.centre.y + 80, eye.centre.z)
    const bottom = v3(eye.centre.x, eye.centre.y - 40, eye.centre.z)
    flyLegs(state, L, [at, high(at), over, top], 300)
    flyLegs(state, L, [top, bottom], 40)
    at = bottom
  }
  for (let i = 0; i < 1000 && !state.finished; i++) stepMission(state, L, at, FIXED_DT)
  return state
}

/** `flyPath` without the idle: legs only. */
const flyLegs = (state: MissionState, L: Level, points: readonly Vec3[], speed: number): void => {
  const p = v3()
  let from = points[0] as Vec3
  for (const to of points.slice(1)) {
    const d = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)
    const n = Math.max(1, Math.ceil(d / (speed * FIXED_DT)))
    for (let i = 1; i <= n && !state.finished; i++) {
      const t = i / n
      p.x = from.x + (to.x - from.x) * t
      p.y = from.y + (to.y - from.y) * t
      p.z = from.z + (to.z - from.z) * t
      stepMission(state, L, p, FIXED_DT)
    }
    from = to
  }
}

/** Every orb, in order, at a walking pace. */
const everyOrb = (L: Level): MissionState => {
  const state = startMission(L)
  const orbs = state.orbs.orbs.map((o) => o.centre)
  const first = orbs[0]
  if (!first) throw new Error(`${L.id}: no orbs`)
  flyLegs(state, L, [v3(first.x, first.y + 300, first.z), ...orbs], 90)
  return state
}

describe('DEV-393: every threshold on every shipped course can be met, in the mode it runs', () => {
  it('reads thirteen courses', () => {
    // Not a count to maintain: a floor, so a directory that failed to read
    // cannot pass this file vacuously.
    expect(SHIPPED.length).toBeGreaterThanOrEqual(13)
  })

  for (const L of SHIPPED) {
    const mode = runningMode(L)
    it(`${L.id} (${mode})`, { timeout: 30_000 }, () => {
      const curve = medalCurve(L, mode)
      expect(curve, `${L.id}: awards a medal`).not.toBeNull()
      if (!curve) return
      expect(curve.bronze).toBeLessThanOrEqual(curve.silver)
      expect(curve.silver).toBeLessThanOrEqual(curve.gold)
      expect(curve.gold).toBeLessThanOrEqual(curve.platinum)

      // A witness run that earns PLATINUM. With the curve ordered, every lower
      // threshold is met on the way to it.
      const rules = rulesFor(mode)
      const witness = rules.timeBonus
        ? firstRingsThenFinish(L, courseGates(L).length, PLATINUM_PACE)
        : rules.scores.includes('orb')
          ? everyOrb(L)
          : bullseyeRun(L, null)
      expect(medalFor(witness, L), `${L.id}: ${witness.counted}/${witness.countTotal}`).toBe(
        'platinum',
      )
    })
  }
})

describe('Target Practice: a missed pad caps the medal below gold', () => {
  // By ARITHMETIC, not by a DEV-393 rule: gold is 80 % of a ceiling that
  // includes the perfect-clear bonus, and no run short of one pad reaches it on
  // any of the six. Pinned here so a retune of the streak or the fractions that
  // broke it would have to say so. Skipping a pad does not reset the streak,
  // which is why this is worth pinning: the streak alone is no guard.
  for (const L of SHIPPED.filter((l) => rulesFor(runningMode(l)).scores.includes('padZone'))) {
    it(`${L.id}`, { timeout: 30_000 }, () => {
      const finishPad = finishPadAirspace(L)?.pad ?? null
      const skip = [...new Set(padZones(L).map((z) => z.pad))].find((p) => p !== finishPad)
      if (skip === undefined) throw new Error(`${L.id}: no pad to skip`)
      const short = bullseyeRun(L, skip)
      expect(short.finished).toBe(true)
      expect(short.counted).toBe(short.countTotal - 1)
      expect(rank(medalFor(short, L)), `${L.id}: ${medalFor(short, L)}`).toBeLessThanOrEqual(
        rank('silver'),
      )
    })
  }
})

// ════════════════════════════════════════════════════════════════════════════

/** An in-memory `localStorage`. */
const memory = (initial: Record<string, string> = {}) => {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v)
    },
  }
}

const stored = (b: Partial<PersonalBest>): string =>
  JSON.stringify({ score: 0, timeSeconds: 60, gates: 0, setAt: 1, ...b })

describe('DEV-393: a best stored under the old rule reads under the new one', () => {
  const L = byId('int_01_hoverJet')
  const mode = runningMode(L)
  const key = bestKey(L.id, mode)
  const total = courseGates(L).length

  it('the exploit best: silver on the table before, nothing now', () => {
    // 0 rings in 26 s under the old rule: 11.5 x (180 - 26) = 1771.
    const card = cardFor(L, memory({ [key]: stored({ score: 1771, timeSeconds: 26, gates: 0 }) }))
    expect(card.best?.score).toBe(0)
    expect(card.medal).toBeNull()
  })

  it('a fast best one ring short keeps its rings and loses its bonus', () => {
    const card = cardFor(
      L,
      memory({ [key]: stored({ score: 3381, timeSeconds: 59.9, gates: total - 1 }) }),
    )
    expect(card.best?.score).toBe((total - 1) * 100)
    expect(card.best?.timeSeconds).toBe(59.9)
    expect(card.medal).toBe('gold')
  })

  it('a clean best, and a best the clock ended, read exactly as stored', () => {
    const clean = stored({ score: 3464, timeSeconds: 61.4, gates: total })
    expect(readBest(L.id, mode, memory({ [key]: clean }), undefined, bestRule(L, mode))).toEqual(
      JSON.parse(clean),
    )
    const clocked = stored({ score: 1400, timeSeconds: 180, gates: 14 })
    expect(readBest(L.id, mode, memory({ [key]: clocked }), undefined, bestRule(L, mode))).toEqual(
      JSON.parse(clocked),
    )
  })

  it('a mode that pays no time bonus has no rule, and its bests are untouched', () => {
    const T = byId('int_01_jumpSeat')
    expect(bestRule(T, runningMode(T))).toBeNull()
    const k = bestKey(T.id, runningMode(T))
    const card = cardFor(T, memory({ [k]: stored({ score: 2250, gates: 3 }) }))
    expect(card.best?.score).toBe(2250)
  })

  it('a clean run now beats an old best it could not beat before', () => {
    const storage = memory({ [key]: stored({ score: 3381, timeSeconds: 59.9, gates: total - 1 }) })
    const outcome = recordRun(
      L.id,
      mode,
      { score: 3000, timeSeconds: 90, gates: total },
      storage,
      undefined,
      bestRule(L, mode),
    )
    expect(outcome.previous?.score).toBe((total - 1) * 100)
    expect(outcome.improved).toBe(true)
    expect(JSON.parse(storage.getItem(key) as string).score).toBe(3000)
  })

  it('a variant record is read under the same rule (DEV-382 re-reads through the card)', () => {
    const variantKey = bestKey(L.id, mode, 'speed')
    const storage = memory({ [variantKey]: stored({ score: 1771, gates: 0 }) })
    const [card] = withVariant([cardFor(L, storage)], L.vehicle, 'speed', storage)
    expect(card?.best?.score).toBe(0)
    expect(card?.medal).toBeNull()
  })
})

describe('DEV-393: the results panel says why a time term is 0', () => {
  it('names the missed rings on a run that crossed inside par', () => {
    const L = byId('int_01_hoverJet')
    const n = courseGates(L).length
    const state = firstRingsThenFinish(L, n - 2, PLATINUM_PACE)
    expect(state.timeBonusForfeit).toBe(2)
    const run = summariseRun(state, {
      medal: medalFor(state, L) ?? 'none',
      best: null,
      improved: false,
      again: '',
      back: '',
      countLabel: 'GATES',
    })
    expect(scoreBreakdown(withStandings(run, []))).toBe(`${(n - 2) * 100} + 0 time (2 missed)`)
  })

  it('says nothing extra on a clean run, or on one the clock ended', () => {
    const L = byId('int_01_hoverJet')
    const clean = firstRingsThenFinish(L, courseGates(L).length, PLATINUM_PACE)
    expect(clean.timeBonusForfeit).toBe(0)
    const clocked = startMission(L)
    flyPath(clocked, L, [release(L), high(release(L))], 100)
    expect(clocked.finishCrossed).toBe(false)
    expect(clocked.timeBonusForfeit).toBe(0)
  })
})
