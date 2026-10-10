// tests/bench/sim-step.bench.ts — the fixed step, timed.
//
// VR-PERF §5.9 H1, the second half. **By hand, never CI, never gated.**
//
//     pnpm bench
//
// `vitest.config.ts` gives `benchmark.include` its own glob, and `test.include`
// is `tests/unit/**/*.test.ts` plus `src/**/*.test.ts`, so nothing here is ever
// collected by `pnpm test` or `pnpm check`. That separation is the point: a
// number that moves with the machine must not be able to turn a commit red.
// `tests/unit/sim-step-budget.test.ts` is the half that CAN — it asserts the
// sample count and the tick count, and prints the milliseconds.
//
// ── What each case is, and what it is the cost OF ─────────────────────────
//
// The three cases split `boot/app.ts`'s fixed-step closure where its cost
// actually divides, so a regression lands on a named line rather than on "the
// sim":
//
//   `player tick`     the whole player half — autopilot, `stepHoverJet`, the
//                     DEV-112 proximity fan over two fields, `stepMission`
//                     with the preset's levers, `stepBoundary`. One tick.
//   `grid tick`       `stepAiRacer` x the preset's grid. One tick. Anniversary
//                     is five, Classic is 2016's two pads.
//   `full tick`       both, which is what one `stepFixed` callback costs.
//
// Each case steps LIVE state, so consecutive iterations fly the course rather
// than re-running tick zero: that is deliberate (the fan's cost depends on
// what is under the ship, and tick zero is over open water where every march
// runs its full length). It also means a bench run is not reproducible to the
// float the way a test is — which is the other reason this is not a gate.
//
// **Read the cases against each other, not across runs, and remember the
// ORDER.** The first measured run on 2026-09-16 had Classic's two-racer tick
// reading 15 % dearer than Anniversary's five-racer one, which is impossible —
// it is last in the file and pays whatever V8 has by then decided to
// re-optimise. `sim-step-budget.test.ts` warms both presets before it times
// either, and its printed table is the one to compare two commits with.
//
// The harness rebuilds its state every `BATCH` ticks so a long run does not
// drift into the part of the course where the autopilot has no target left.
// The world, the grid and the tick sequence are `tests/unit/helpers/
// sim-step-harness.ts`, shared with the test so the two cannot diverge.

import { bench, describe } from 'vitest'
import type { AiRacer } from '@/sim/ai-racer'
import type { Gate } from '@/sim/course'
import {
  editionNamed,
  gates,
  gridFor,
  MISSION,
  makePlayer,
  type Player,
  stepGrid,
} from '../unit/helpers/sim-step-harness'

/** Ticks before the state is rebuilt — ~9 s of sim, well short of the last gate. */
const BATCH = 750

const course: Gate[] = gates()
const anniversary = editionNamed('anniversary')
const classic = editionNamed('classic')

/** A player that flies on across iterations and starts over every `BATCH`. */
const rolling = (edition: ReturnType<typeof editionNamed>) => {
  let player: Player = makePlayer(edition, course)
  let racers: AiRacer[] = gridFor(edition, course)
  let n = 0
  return {
    get racers(): readonly AiRacer[] {
      return racers
    },
    /** Call once per iteration, before stepping. */
    roll(): Player {
      if (n++ >= BATCH) {
        n = 0
        player = makePlayer(edition, course)
        racers = gridFor(edition, course)
      }
      return player
    },
  }
}

describe(`sim step — ${MISSION}`, () => {
  const a = rolling(anniversary)
  bench('player tick (anniversary: autopilot + hoverjet + fan + mission + boundary)', () => {
    a.roll().step()
  })

  const b = rolling(anniversary)
  bench('grid tick (anniversary: stepAiRacer x 5)', () => {
    b.roll()
    stepGrid(b.racers, course)
  })

  const c = rolling(anniversary)
  bench('full tick (anniversary: player + 5 racers)', () => {
    c.roll().step()
    stepGrid(c.racers, course)
  })

  const d = rolling(classic)
  bench('full tick (classic: player + 2016’s two pads)', () => {
    d.roll().step()
    stepGrid(d.racers, course)
  })
})
