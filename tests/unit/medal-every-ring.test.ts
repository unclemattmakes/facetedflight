// tests/unit/medal-every-ring.test.ts — platinum is every ring, gold is 2016's
// 90 % line: on both editions, in every Ring Attack course. The DEV-393
// follow-up.
//
// Matt, 2026-09-25: *"gold medal = 90, plat = 100"*.
//
// DEV-004 had put platinum ABOVE the ring ceiling — every ring AND a reference
// pace that no recorded flight reached (DEV-393 §5) — so a clean lap read gold.
// 2016's own platinum was the ring ceiling (21 x 100 on `int_01`), and DEV-393
// made a missed ring forfeit the time bonus, so with platinum back at the
// ceiling a run earned it EXACTLY when it took every ring, at any pace.
//
// DEV-846 (Matt, 2026-10-08: "speed was an influence") adds the clock back,
// bounded: platinum is every ring PLUS half of a one-ring time term, so it still
// needs every ring (no run that missed one is platinum, however fast) but a
// leisurely lap is gold. Bronze to gold are untouched. `medal-time.test.ts` holds
// the numbers and the per-course reachability.
//
// What is asserted, and against what. Every medal here comes out of RUNS flown
// through `stepMission` and awarded by `medalFor` — never out of a second copy of
// `tools/extract/level.mjs`'s arithmetic (trap 24) — and the oracles are outside
// the port's scorer:
//
//   · the course's OWN ring count, the number of gates the run is flown
//     through: the run that takes all `n` is platinum, fast or slow, and every
//     run that takes fewer is not;
//   · 90 % of that count: the fewest rings that earn gold is within one ring of
//     it, and is fewer than all of them (2016 authored 19 of 21, 20 of 22, 25
//     of 28 and 15 of 16 — the line, rounded by hand);
//   · 2016's own record (`medals`, extracted from the scenes): on a 2016 course
//     gold changes hands exactly where 2016 put it.
//
// Per EDITION because the edition is what a run is scored under: each preset's
// gameplay levers (G1's pool, G2's gate events) are stepped as `boot/app.ts`
// steps them, on the deck, where Anniversary's pool pays the most — and a course
// is included only where that edition flies its aircraft (`editionFlies`), which
// is how Classic never sees the glider.
//
// Courses are read off `content/levels/` AND `content/authored/`, and chosen by
// the mode ROW (scores rings, on a points scale, awards a medal) rather than by
// name, so a new Ring Attack course is covered without an edit.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { editionFlies } from '@/content/aircraft-schema'
import type { Edition } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import {
  courseGates,
  type Medal,
  type MissionLevers,
  type MissionState,
  medalFor,
  missionScore,
  startMission,
  stepMission,
} from '@/game/mission'
import { medalCurve, rulesFor, runningMode } from '@/game/modes'
import { FIXED_DT } from '@/sim/constants'
import { type Vec3, v3 } from '@/sim/math/vec3'
import { REPO as ROOT } from './helpers/repo-root'

const readTree = (dir: string): Level[] =>
  fs
    .readdirSync(path.join(ROOT, 'content', dir))
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'content', dir, f), 'utf8')) as Level)
    .filter((l) => typeof l.id === 'string' && Array.isArray(l.routes))

const GENERATED = readTree('levels')
const AUTHORED = readTree('authored')
const FROM_2016 = new Set(GENERATED.map((l) => l.id))

/** A Ring Attack course, by the mode row: rings score, on points, for a medal. */
const isRingAttack = (L: Level): boolean => {
  const mode = runningMode(L)
  const rules = rulesFor(mode)
  return (
    rules.scores.includes('ring') &&
    rules.medalScale === 'points' &&
    medalCurve(L, mode) !== null &&
    courseGates(L).length > 0 &&
    L.finish != null
  )
}

const COURSES = [...GENERATED, ...AUTHORED].filter(isRingAttack)

const EDITIONS: readonly Edition[] = fs
  .readdirSync(path.join(ROOT, 'content', 'editions'))
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .map(
    (f) =>
      JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'editions', f), 'utf8')) as Edition,
  )

const RANK: readonly Medal[] = ['none', 'bronze', 'silver', 'gold', 'platinum']
const rank = (m: Medal | null): number => RANK.indexOf(m ?? 'none')

/** Three space -> sim space: the z flip every gate centre goes through. */
const sim = (p: readonly number[]): Vec3 => v3(p[0] as number, p[1] as number, -(p[2] as number))

/** The release point: the spawn, lifted by the launch ride where there is one. */
const release = (L: Level): Vec3 => {
  const s = sim(L.spawn.pos as number[])
  s.y += L.spawn.launch?.rise ?? 0
  return s
}

const finishOf = (L: Level): Vec3 => sim((L.finish as NonNullable<Level['finish']>).pos as number[])

/** 1.5 km straight up: above every ring on every course, so a leg up here takes none. */
const high = (p: Vec3): Vec3 => v3(p.x, p.y + 1500, p.z)

/**
 * The edition's own levers, as `boot/app.ts` hands them to `stepMission`: on the
 * deck (clearance 0, the proximity meter full) at the leg's own speed, so
 * whatever an edition's pool can pay, it pays.
 */
const leversOf = (edition: Edition, speed: number): MissionLevers => ({
  clearance: 0,
  speed,
  struck: false,
  proximity: edition.gameplay.proximity,
  gateEvents: edition.gameplay.gateEvents,
})

/**
 * Take the first `k` gates in order, then leave OVER the rest and drop onto the
 * finish, at `speed`, sampled at the fixed step; idle there until the run ends.
 * A synthetic line: it asks what the SCORER awards a path, which is the question.
 */
const flyFirst = (L: Level, edition: Edition, k: number, speed: number): MissionState => {
  const gates = courseGates(L).map((g) => g.centre)
  const start = release(L)
  const taken = gates.slice(0, k)
  const last = taken[taken.length - 1] ?? start
  const fin = finishOf(L)
  const points =
    k === gates.length ? [start, ...taken, fin] : [start, ...taken, high(last), high(fin), fin]
  const state = startMission(L)
  const levers = leversOf(edition, speed)
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
      stepMission(state, L, at, FIXED_DT, levers)
    }
    from = to
  }
  const limit = Math.ceil(L.timer.timeLimit / FIXED_DT) + 10
  for (let i = 0; i < limit && !state.finished; i++) stepMission(state, L, from, FIXED_DT, levers)
  return state
}

/** A fast pace: inside par everywhere, so the clock WOULD pay any run that crosses. */
const FAST = 400
/** A slow pace, well under DEV-004's retired reference pace of 218.75. */
const SLOW = 120

// ════════════════════════════════════════════════════════════════════════════

describe('the courses and editions this file walks', () => {
  it('finds every Ring Attack course, 2016 and authored, and both editions', () => {
    const ids = COURSES.map((L) => L.id)
    // Floors, not counts to maintain: a tree that failed to read cannot pass vacuously.
    expect(ids).toContain('int_01_hoverJet')
    expect(ids).toContain('rookie_01_hoverJet')
    expect(ids).toContain('anniv_01_glider')
    expect(COURSES.filter((L) => FROM_2016.has(L.id)).length).toBeGreaterThanOrEqual(6)
    expect(EDITIONS.map((e) => e.id).sort()).toEqual(
      expect.arrayContaining(['anniversary', 'classic']),
    )
  })

  it('flies the glider course on Anniversary and never on Classic', () => {
    const glider = COURSES.find((L) => L.id === 'anniv_01_glider') as Level
    const byId = new Map(EDITIONS.map((e) => [e.id as string, e]))
    expect(editionFlies(byId.get('anniversary') as Edition, glider.vehicle)).toBe(true)
    expect(editionFlies(byId.get('classic') as Edition, glider.vehicle)).toBe(false)
  })
})

for (const edition of EDITIONS) {
  describe(`${edition.id}: platinum is every ring, gold is 2016's 90 % line`, () => {
    const flown = COURSES.filter((L) => editionFlies(edition, L.vehicle))

    for (const L of flown) {
      it(`${L.id}`, { timeout: 60_000 }, () => {
        const n = courseGates(L).length

        // One run per ring count, 0..n, each crossing the finish inside par.
        const runs = Array.from({ length: n + 1 }, (_, k) => flyFirst(L, edition, k, FAST))
        const medals = runs.map((run) => medalFor(run, L))
        for (const [k, run] of runs.entries()) {
          expect(run.ringsPassed, `${L.id}: run ${k} took ${k}`).toBe(k)
          expect(run.finishCrossed, `${L.id}: run ${k} crossed the finish`).toBe(true)
          expect(run.elapsed, `${L.id}: run ${k} inside par`).toBeLessThan(L.timer.bonusParTime)
        }

        // The edition's levers were live: its pool moved exactly where it can pay.
        expect(
          (runs[n] as MissionState).proximity.bonus > 0,
          `${L.id}: ${edition.id}'s pool (maxBonus ${edition.gameplay.proximity.maxBonus})`,
        ).toBe(edition.gameplay.proximity.maxBonus > 0)

        // ── platinum <=> every ring, taken quickly (DEV-846) ───────────────
        expect(medals[n], `${L.id}: all ${n} rings, fast`).toBe('platinum')
        const slow = flyFirst(L, edition, n, SLOW)
        expect(slow.ringsPassed).toBe(n)
        expect(slow.finishCrossed, `${L.id}: the slow lap crossed the finish`).toBe(true)
        // DEV-846: platinum is every ring PLUS a share of the clock's term, so a
        // lap that takes every ring at a leisurely pace is gold, not platinum.
        // Rings alone still decide bronze to gold: the slow run out-scores every
        // run that missed a ring, and sits at or above gold.
        expect(medalFor(slow, L), `${L.id}: all ${n} rings at ${SLOW} m/s`).toBe('gold')
        expect(
          missionScore(slow),
          `${L.id}: the slow lap beats every run that missed one`,
        ).toBeGreaterThan(missionScore(runs[n - 1] as MissionState))
        for (let k = 0; k < n; k++) {
          expect(medals[k], `${L.id}: ${k} of ${n} rings`).not.toBe('platinum')
        }

        // ── gold at the 90 % line ──────────────────────────────────────────
        const kGold = medals.findIndex((m) => rank(m) >= rank('gold'))
        expect(kGold, `${L.id}: some run earns gold`).toBeGreaterThan(0)
        expect(kGold, `${L.id}: gold does not need every ring`).toBeLessThan(n)
        expect(
          Math.abs(kGold - 0.9 * n),
          `${L.id}: gold at ${kGold} of ${n} rings, 90 % is ${(0.9 * n).toFixed(1)}`,
        ).toBeLessThan(1)
        // Monotone: never a worse medal for more rings.
        for (let k = 1; k <= n; k++) {
          expect(rank(medals[k] ?? null), `${L.id}: ${k} vs ${k - 1}`).toBeGreaterThanOrEqual(
            rank(medals[k - 1] ?? null),
          )
        }
        // On a 2016 course, gold changes hands exactly where 2016 put it.
        if (FROM_2016.has(L.id)) {
          expect(missionScore(runs[kGold - 1] as MissionState)).toBeLessThan(L.medals.gold)
          expect(missionScore(runs[kGold] as MissionState)).toBeGreaterThanOrEqual(L.medals.gold)
        }
      })
    }
  })
}
