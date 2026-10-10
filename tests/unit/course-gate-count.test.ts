// tests/unit/course-gate-count.test.ts — the drawn course and the scored course
// are ONE course, on every shipped level (DEV-210).
//
// ── The bug ───────────────────────────────────────────────────────────────
//
// `adv_01_hoverJet` shipped with two live ring groups, and `src/` had two
// independent expressions for "the course":
//
//     game/rings.ts     level.routes[0]?.rings ?? []        -> 22 gates DRAWN
//     game/mission.ts   courseGates(level) = liveRings(...)  -> 44 gates SCORED
//
// The blast radius is ONE number on the HUD, and that is measured: the same
// complete run flown against both versions of the content scores 3643 and takes
// platinum either way. What differed was the DENOMINATOR — `22/44` against
// `22/22` — so `adv_01` was the one mission whose gate counter could never be
// filled, and it said so at the moment you crossed the finish having missed
// nothing.
//
// The other two effects are real and were nearly harmless, which is worth
// knowing before anyone reads this file as a severity claim. The 22 unscored,
// undrawn gates sit 2-3 km away with 18 of them outside the play-area sphere, so
// nobody flew there and nobody saw the missing art; and DEV-122's fade dropping
// indices 22..43 on `createGateVisibility.pass`'s bounds check is moot for the
// same reason — those gates are never passed. They were a latent trap, not a
// visible defect.
//
// What was NOT affected, checked rather than assumed: the DEV-004 medal curve.
// `tools/extract/level.mjs` takes `ringCeiling` as the MAX over routes and not
// the sum, so `medalsFf2` was computed over one 22-ring route and is
// byte-identical before and after this fix. `maxRingScore` in
// `content/level-schema.ts` DID return 4400, but it has no `src/` consumer —
// only tests read it.
//
// ── Why nothing caught it ─────────────────────────────────────────────────
//
// Both sides were self-consistent, and every test of either side used a
// single-route level, where the two expressions agree. CLAUDE.md: *a rule tested
// only where two explanations agree has not been tested*, and *a test that
// compares two of your own devices has not tested either of them*. Twelve of the
// thirteen shipped levels have one route; the thirteenth was the whole bug, and
// no amount of more testing on the other twelve could have found it.
//
// It also hid from the obvious guard. `tools/extract/level.mjs`'s
// `platinum-reachable` coherence check was written as
// `routes.length !== 1 || liveRings >= platRings` — it EXEMPTED the multi-route
// case, which is to say it exempted the only mission that had the bug. 2016's own
// hand-authored platinum of 2200 against `gateMultiplier` 100 said "22 gates" the
// whole time.
//
// ── What this file asserts, and why it is not circular ────────────────────
//
// `courseGates` and the renderer now call the same `liveRings`, so comparing
// those two alone would re-derive the expectation the way the code does — trap
// 24, the assertion that cannot fail. So §1 collects every DIFFERENT expression
// for "how many gates are on this course" that exists in the repo, including the
// one the renderer used to use and that several specs still use, and requires
// all of them to agree against the real shipped content. §2 fixes the structural
// property that makes them agree, so a regression names its cause rather than
// just a number. §3 tests the DEV-122 consequence directly. §4 stops `src/`
// growing a fifth derivation.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import { allRings, liveRings, maxRingScore } from '@/content/level-schema'
import { generatedLevelIds, loadBaselineLevel, loadLevel } from '@/content/load-level'
import { courseGates } from '@/game/mission'
import { countTotal } from '@/game/modes'
import { REPO as ROOT } from './helpers/repo-root'

/**
 * The expression `game/rings.ts` and `game/particle-fx.ts` used before DEV-210,
 * and still what `tests/e2e/gates-photos.spec.ts`, `gate-bullseye.test.ts` and a
 * dozen other call sites reach for. Kept here ON PURPOSE as an independent
 * derivation: the day it stops agreeing with `courseGates`, every one of those
 * call sites is quietly reading a different course, which is exactly what
 * happened.
 */
const firstRouteCount = (level: Level): number => level.routes[0]?.rings.length ?? 0

const shipped = async (): Promise<Level[]> =>
  Promise.all(generatedLevelIds().map((id) => loadLevel(id)))

describe('the course is one course (DEV-210)', () => {
  it('has all thirteen shipped missions to check', async () => {
    const levels = await shipped()
    expect(levels).toHaveLength(13)
  })

  /* ── §1 every derivation of "how many gates" agrees ───────────────────── */

  it('agrees on the gate count across every expression in the repo', async () => {
    const levels = await shipped()
    const disagreed: string[] = []

    for (const level of levels) {
      const counts = {
        // the scorer — `game/mission.ts`, what a run is graded against
        courseGates: courseGates(level).length,
        // the shared helper — what `game/rings.ts` DRAWS and `particle-fx.ts` decorates
        liveRings: liveRings(level).length,
        // the renderer's pre-DEV-210 expression, still used by many specs
        firstRoute: firstRouteCount(level),
        // the HUD denominator — `game/modes.ts`
        countTotal: countTotal(level, 'ringAttack'),
        // every ring on every route, unfiltered
        allRings: allRings(level).length,
      }
      const distinct = new Set(Object.values(counts))
      if (distinct.size !== 1) disagreed.push(`${level.id}: ${JSON.stringify(counts)}`)
    }

    // Named rather than counted: a failure should say WHICH mission and by how much.
    expect(disagreed).toEqual([])
  })

  /* ── §2 the structural property that makes them agree ─────────────────── */

  it('gives every shipped level at most one route', async () => {
    const levels = await shipped()
    // The extractor chooses THE COURSE by the Curvy spline the ring clones were built
    // along (DEV-210). More than one route here means either a scene grew a second live
    // ring group or `selectCourse` stopped running — and `routes[0]` immediately means
    // something different from `liveRings`.
    const multi = levels
      .filter((l) => l.routes.length > 1)
      .map((l) => `${l.id}: ${l.routes.length}`)
    expect(multi).toEqual([])
  })

  it('scores every ring it ships, so no filter can separate the two readings', async () => {
    const levels = await shipped()
    const nonScoring = levels
      .filter((l) => allRings(l).length !== liveRings(l).length)
      .map((l) => `${l.id}: ${allRings(l).length} placed, ${liveRings(l).length} scoring`)
    // The extractor's liveness walk drops `addScore === 0` rings before writing the JSON,
    // so a ring in `content/` always scores. If that ever stops being true, `allRings`
    // and `liveRings` diverge and §1's `allRings` row is the one that goes red.
    expect(nonScoring).toEqual([])
  })

  /* ── §3 the DEV-122 consequence, tested directly ──────────────────────── */

  it('lets the passed-gate fade reach every gate the course scores', async () => {
    const levels = await shipped()
    const unreachable: string[] = []

    for (const level of levels) {
      // `game/rings.ts` builds `createGateVisibility(rings.length)` from the gates it
      // DRAWS, and `createGateVisibility.pass` drops any `i >= count` on its bounds
      // check. So the highest course index must be inside the drawn array, or a gate the
      // player flies through can never fade. On adv_01 indices 22..43 were dropped.
      //
      // The smaller of the two derivations, not today's: measured against `liveRings`
      // alone this passes on the very content that shipped the bug, because that side
      // was never the wrong one. `firstRoute` is what `createGateVisibility` was
      // actually sized from, so the fade has to survive EITHER reading.
      const drawn = Math.min(liveRings(level).length, firstRouteCount(level))
      const highest = courseGates(level).length - 1
      if (highest >= drawn) unreachable.push(`${level.id}: gate ${highest} of ${drawn} drawn`)
    }

    expect(unreachable).toEqual([])
  })

  it('keeps 2016 platinum reachable on the one mission that proved the count', async () => {
    // Not a general medal check — `rookie_01_hoverJet` ships an unreachable platinum on
    // purpose (16 rings x 100 against 1700), which is its own deviation. This is the
    // anchor that DECIDED DEV-210: 2016 hand-authored `adv_01`'s platinum as 2200, and
    // `gateMultiplier` is 100, so the course 2016 meant is 22 gates and not 44. If the
    // extractor ever emits both groups again this is 4400 and goes red.
    // 2016's course, not a shipped override of it (DEV-538): this pins what the
    // extractor decided 2016 MEANT, which an edit to adv_01 must not move.
    const adv01 = await loadBaselineLevel('adv_01_hoverJet')
    expect(courseGates(adv01)).toHaveLength(22)
    expect(maxRingScore(adv01)).toBe(2200)
    expect(adv01.medals.platinum).toBe(2200)
    expect(adv01.routes[0]?.id).toBe('CurvyClonePath')
  })

  it('records why the second live group was dropped', async () => {
    // The drop is a judgement about 2016's intent, so it travels with the content instead
    // of having to be re-derived from the scene. `route_adv_01` is live in the scene by
    // every liveness rule there is; what disqualifies it is that it is ~2 km off the
    // spline the ring clones were built along.
    const adv01 = (await loadBaselineLevel('adv_01_hoverJet')) as Level & {
      _meta?: {
        courseSelection?: {
          by: string
          dropped: { id: string; rings: number; splineFitM: number }[]
        } | null
      }
    }
    const sel = adv01._meta?.courseSelection
    expect(sel?.by).toBe('curvy-spline-fit')
    expect(sel?.dropped).toHaveLength(1)
    expect(sel?.dropped[0]?.id).toBe('route_adv_01')
    expect(sel?.dropped[0]?.rings).toBe(22)
    expect(sel?.dropped[0]?.splineFitM).toBeGreaterThan(250)
  })

  /* ── §4 no fifth derivation ───────────────────────────────────────────── */

  it('keeps the gate-drawing modules on the shared expression', async () => {
    // The guard `xr-eye-layers.test.ts` uses: the next module to want the course will not
    // read this test first. `routes[0]` is not wrong in a spec pinned to a known level —
    // it is wrong in `src/`, where it silently means "the first group the extractor
    // happened to sort first".
    const offenders: string[] = []
    for (const rel of ['src/game/rings.ts', 'src/game/particle-fx.ts', 'src/game/modes.ts']) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
      for (const [i, line] of src.split(/\r?\n/).entries()) {
        // comments explain the history on purpose; only real reads count
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue
        if (/\.routes\s*\[/.test(line) || /\.routes\b[\s\S]*?\bflatMap\b/.test(line)) {
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
