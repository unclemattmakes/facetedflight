// tests/unit/variant-spider.test.ts — the jumping spider finishes every
// JumpSeat course. DEV-383.
//
// AIRCRAFT-VARIANTS §11 open call 14, answered: *"Must the spider finish every
// JumpSeat course? Yes: tune it until the hop planner finishes all of them"* —
// a variant that can open a course it cannot finish is a trap in the menu. The
// hop planner is `sim/jumpseat-autopilot.ts`'s spider block (`stepSpiderPilot`),
// flown here by `helpers/jumpseat-run.ts` through the game's own loop, with the
// SEA under the hull as the seam gives it (a spider that falls short over
// water lands on it).
//
// The mechanic's own behaviour is `jumpseat-jump.test.ts`'s; this file is the
// feasibility the plan put first (§4.2: "the feasibility question comes before
// the feel question").
//
// Proved red: the plan's tabled `impulseMax` 75 with `fuel.burnRate` x0.6 in
// the content finishes NONE of the six (10 pads of 49, every run dry); and the
// shipped numbers with `impulseMax` 190 drop courses too. DEVIATIONS DEV-383
// has the sweep. Skips, loudly, without `public/assets`.

import { describe, expect, it } from 'vitest'
import { resolveVariant } from '@/content/load-aircraft'
import {
  flyJumpSeatMission,
  JUMPSEAT_MISSIONS,
  type JumpSeatRunResult,
  jumpSeatTerrainAvailable,
  loadJumpSeatLevel,
} from './helpers/jumpseat-run'
import { SPIDER_READY } from './helpers/spider-ready'

const ANNIVERSARY = { gameplay: { variants: { enabled: true } } }

const LEVELS = JUMPSEAT_MISSIONS.map((id) => loadJumpSeatLevel(id))
const available = LEVELS.every((level) => jumpSeatTerrainAvailable(level))

/**
 * Longer than the harness's 600 s default: a spider hops a course a seat that
 * climbs flies, and `adv_02_jumpSeat`'s twelve pads take it about 720 s of sim.
 * Still only a safety cap — `mission.finished` is what ends a run.
 */
const MAX_SECONDS = 1200

const runs = new Map<string, JumpSeatRunResult>()
const flySpider = (id: string): JumpSeatRunResult => {
  const hit = runs.get(id)
  if (hit) return hit
  const variant = resolveVariant('jumpseat', 'spider', ANNIVERSARY)
  expect(variant.id).toBe('spider')
  const result = flyJumpSeatMission(loadJumpSeatLevel(id), {
    variant,
    ocean: true,
    maxSeconds: MAX_SECONDS,
  })
  runs.set(id, result)
  return result
}

// NOT READY TO SHIP (Matt, 2026-09-25, DEV-403): the spider is `listed: false`
// and its tests skip on `SPIDER_READY` until it is ready again.
// `variant-listed.test.ts` pins the flag.
describe.skipIf(!available || !SPIDER_READY)(
  'the jumping spider finishes every JumpSeat course',
  () => {
    it('SKIP NOTICE', () => {
      // Reached only when the assets are present; vitest prints the whole
      // describe as skipped without them — `variant-overclocked.test.ts`'s
      // arrangement, for the same runs.
      expect(available).toBe(true)
    })

    for (const id of JUMPSEAT_MISSIONS) {
      it(`${id}: to the finish, with every pad`, () => {
        const run = flySpider(id)
        console.info(
          [
            id.padEnd(20),
            `${run.padsHit}/${run.pads}`.padStart(6),
            `bulls ${run.bullseyes}`,
            `score ${String(run.score).padStart(5)}`,
            `clock ${run.elapsed.toFixed(1).padStart(6)}s`,
            `burnt ${run.fuelBurnt.toFixed(0).padStart(4)}`,
            `min tank ${run.minFuel.toFixed(1)}`,
            `jumps ${run.jumps}`,
          ].join('  '),
        )
        expect(run.stranded, `${id}: never ran dry away from a pad`).toBe(false)
        expect(run.finished, `${id}: ${run.padsHit}/${run.pads} at ${run.elapsed}s`).toBe(true)
        expect(run.finishCrossed, id).toBe(true)
        expect(run.padsHit, `${id}: every pad`).toBe(run.pads)
        expect(run.jumps, `${id}: it hopped`).toBeGreaterThan(0)
      }, 120_000)
    }
  },
)
