// tests/unit/sim-step-budget.test.ts — what one fixed step COSTS, counted.
//
// VR-PERF §5.9 H1. Gap 5 of that brief: *"Nothing measures the sim step."*
// `boot/app.ts`'s `stepFixed(clock, stepSeconds, (dt) => { … })` wraps a
// ~600-line closure — the player's flight model, the proximity fan, the
// scorer, the boundary, and one `stepAiRacer` per racer on the grid — and not
// one timer brackets any of it. Part 1's trace recorder will bracket it in the
// running game; this file is the headless half, and it is the one that runs in
// `pnpm test`.
//
// The tick itself, the synthetic world it flies over and why that world is not
// the real height maps are all in `helpers/sim-step-harness.ts`, which
// `tests/bench/sim-step.bench.ts` shares so the counted run and the timed one
// cannot drift into measuring different things.
//
// ── Print, don't gate; if you gate, gate a MECHANISM ──────────────────────
//
// The house rule (CLAUDE.md, and `tests/unit/surface-proximity.test.ts`'s
// `samples` vs `sampleBudget()` is the pattern). A millisecond belongs to a
// machine: this box, CI's runner and Matt's laptop on battery are three
// different answers and none of them is the Steam Frame. So every `expect`
// here is a COUNT or a finiteness check, and every duration is a
// `console.info`. Nothing in this file can go red because a machine was busy.
//
// What is asserted:
//
//   * the tick count is exactly `Math.round(30 / FIXED_DT)` — the loop ran the
//     number of steps thirty seconds of sim time IS, not "about that";
//   * `SurfaceProximity.samples <= sampleBudget(spheres, fields, reach)` on
//     EVERY tick the fan runs, under both presets, and the fan reached
//     something on at least one of them (a budget satisfied by doing nothing is
//     not a budget);
//   * no NaN and no Infinity in the player's position, velocity, clock or
//     score on any tick, and none in any racer's position at the end;
//   * the Anniversary grid is five and Classic's is 2016's two — `racer-grid.
//     ts` resolving each preset's own `gameplay.racers`, not a number typed
//     here;
//   * **the player flies the same line whether or not the racers are stepped
//     beside it.** Trap 19 at the level of the whole tick: the two phases below
//     are one flight run twice, and the second one has the whole grid writing
//     `ai-racer.ts`'s module-level input scratch in between the player's steps.
//     Float-exact, because the sim has no wall clock and no RNG.
//
// What is printed: steps per second and microseconds per step, for the player
// alone and for the player with the preset's whole grid beside it.
//
// ── Two phases, and why the timing is not taken inside one loop ───────────
//
// Phase A steps the player only; phase B steps the player and every racer.
// Both run the same number of ticks from the same start, so the racer cost is
// `(B - A) / (ticks x racers)`. Bracketing the two halves INSIDE one loop was
// the first shape, and it puts four `performance.now()` calls on a hot path
// that is being timed — ten thousand of them over a run, measuring the clock.
// Two whole-loop timings need four calls in total, and they buy the trap-19
// assertion above for nothing.

import { describe, expect, it } from 'vitest'
import type { Edition } from '@/content/edition-schema'
import { FIXED_DT } from '@/sim/constants'
import type { Gate } from '@/sim/course'
import { sampleBudget } from '@/sim/surface-proximity'
import {
  EDITIONS,
  FIELDS,
  gates,
  gridFor,
  HULL,
  LAND,
  MISSION,
  makePlayer,
  OCEAN,
  stepGrid,
  TICKS,
  WINDOW_SECONDS,
} from './helpers/sim-step-harness'

interface Run {
  readonly edition: string
  readonly ticks: number
  /** Racers on the grid, from the preset's own `gameplay.racers`. */
  readonly racers: number
  readonly racerIds: readonly string[]
  /** Reach the preset asks the fan for, metres. */
  readonly reach: number
  readonly budget: number
  readonly maxSamples: number
  /** Ticks on which the fan reached nothing at all and took no sample. */
  readonly idleFanTicks: number
  /** Milliseconds for `ticks` steps of the player alone. */
  readonly playerMs: number
  /** Milliseconds for `ticks` steps of the player plus the whole grid. */
  readonly gridMs: number
  readonly faults: readonly string[]
  readonly finalPlayer: { x: number; y: number; z: number }
  readonly finalPlayerWithGrid: { x: number; y: number; z: number }
  readonly racerPositions: readonly { id: string; x: number; y: number; z: number }[]
  readonly ringsPassed: number
  readonly score: number
}

/**
 * Throwaway flights under BOTH presets, once, before anything is timed.
 *
 * Not tidiness — measured. Without it the preset that ran FIRST paid V8's whole
 * tier-up and read **2.2x dearer** than the one that ran second (43.6 against
 * 19.6 us a step), which would have printed Classic's step as more than twice
 * the cost of Anniversary's when the two do the same work. A table whose only
 * job is to be compared against later cannot carry that. One warm-up covering
 * both, so neither preset is the one that pays.
 */
let warmed = false
const warmAll = (course: readonly Gate[]): void => {
  if (warmed) return
  warmed = true
  for (const edition of EDITIONS) {
    const p = makePlayer(edition, course)
    const rs = gridFor(edition, course)
    for (let i = 0; i < 1500; i++) {
      p.step()
      stepGrid(rs, course)
    }
  }
}

const runFor = (edition: Edition): Run => {
  const course = gates()
  warmAll(course)

  // ── phase A: the player alone, timed ──────────────────────────────────
  //
  // The two integer compares that count the fan are inside the timed loop on
  // purpose: they are nanoseconds against a step measured in microseconds, and
  // a third un-timed replay of the same flight to collect them would cost a
  // third of this file's runtime to avoid 0.01 %.
  const alone = makePlayer(edition, course)
  let maxSamples = 0
  let idleFanTicks = 0
  const a0 = performance.now()
  for (let i = 0; i < TICKS; i++) {
    alone.step()
    if (alone.surface.samples > maxSamples) maxSamples = alone.surface.samples
    if (alone.surface.samples === 0) idleFanTicks++
  }
  const playerMs = performance.now() - a0

  // ── phase B: the player with the grid beside it, timed ────────────────
  const withGrid = makePlayer(edition, course)
  const racers = gridFor(edition, course)
  let ticks = 0
  const b0 = performance.now()
  for (let i = 0; i < TICKS; i++) {
    withGrid.step()
    stepGrid(racers, course)
    ticks++
  }
  const gridMs = performance.now() - b0

  return {
    edition: edition.id,
    ticks,
    racers: racers.length,
    racerIds: racers.map((r) => r.spec.id),
    reach: edition.gameplay.proximity.farMetres,
    budget: sampleBudget(HULL.length, FIELDS, edition.gameplay.proximity.farMetres),
    maxSamples,
    idleFanTicks,
    playerMs,
    gridMs,
    faults: [...alone.faults, ...withGrid.faults],
    finalPlayer: { ...alone.jet.body.position },
    finalPlayerWithGrid: { ...withGrid.jet.body.position },
    racerPositions: racers.map((r) => ({ id: r.spec.id, ...r.jet.body.position })),
    ringsPassed: alone.state.ringsPassed,
    score: alone.state.score,
  }
}

/** Each preset run once; the printout reads the same runs the assertions did. */
const runs = new Map<string, Run>()
const runOnce = (edition: Edition): Run => {
  const hit = runs.get(edition.id)
  if (hit) return hit
  const run = runFor(edition)
  runs.set(edition.id, run)
  return run
}

// ── the assertions ────────────────────────────────────────────────────────

describe('the sim step, counted (VR-PERF H1)', () => {
  it('the world under it is the real geometry, and the budget is the real budget', () => {
    // Guards the premise: a field the ship is never inside would make every
    // assertion below true of nothing (trap 23 — a sample that cannot separate).
    expect(LAND.step).toBe(8)
    expect(LAND.vertPerSide).toBe(513)
    expect(OCEAN.step * OCEAN.scaleX).toBe(256)
    expect(HULL.length).toBe(5)
    // The number `sim/surface-proximity.ts`'s header quotes for the REAL
    // island, reached here from the same formula over the same two pitches —
    // which is what makes the harness's fan the game's fan and not a cheaper one.
    expect(sampleBudget(HULL.length, FIELDS, 90)).toBe(400)
  })

  for (const edition of EDITIONS) {
    it(`${edition.id}: ${WINDOW_SECONDS} s of ${MISSION} runs clean, and the fan stays inside its budget`, () => {
      const run = runOnce(edition)

      // The loop ran the number of steps thirty seconds IS — not "about".
      expect(run.ticks).toBe(TICKS)
      expect(run.ticks).toBe(Math.round(WINDOW_SECONDS / FIXED_DT))

      // Nothing came apart, on any tick of either phase.
      expect(run.faults, `${edition.id}: ${run.faults.join('; ')}`).toEqual([])

      // THE MECHANISM. Never a millisecond: the fan's cost is its sample count,
      // and the count is bounded by the formula in the module's own header.
      expect(run.maxSamples).toBeLessThanOrEqual(run.budget)
      // And the fan is genuinely LIVE — a run in which it never reached
      // anything would satisfy that bound by doing nothing at all.
      expect(run.maxSamples).toBeGreaterThan(0)
      expect(run.idleFanTicks).toBeLessThan(run.ticks)

      // Every racer is somewhere real at the end.
      for (const r of run.racerPositions) {
        expect(
          Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z),
          `${edition.id}/${r.id}: ${r.x},${r.y},${r.z}`,
        ).toBe(true)
      }

      // Trap 19, at the level of the whole tick: the grid stepped in between
      // the player's steps, writing `ai-racer.ts`'s shared input scratch, and
      // the player must not have felt one of them. Float-exact.
      expect(run.finalPlayerWithGrid.x).toBe(run.finalPlayer.x)
      expect(run.finalPlayerWithGrid.y).toBe(run.finalPlayer.y)
      expect(run.finalPlayerWithGrid.z).toBe(run.finalPlayer.z)
    })
  }

  it('the grid is the preset, resolved — five on Anniversary, 2016’s two on Classic', () => {
    // `game/racer-grid.ts` reading `gameplay.racers`, not a number typed here:
    // the timing rows below are labelled with the count the preset produced.
    const classic = runOnce(EDITIONS[0] as Edition)
    const anniversary = runOnce(EDITIONS[1] as Edition)
    expect(classic.edition).toBe('classic')
    expect(anniversary.edition).toBe('anniversary')
    expect(classic.racers).toBe(2)
    expect(anniversary.racers).toBe(5)
    expect(new Set(anniversary.racerIds).size).toBe(anniversary.racers)
  })

  it('prints the cost', () => {
    // NOT an assertion. This box is not the Steam Frame and CI is neither; the
    // number that decides anything is the worn trace's `sim_ms` column
    // (VR-PERF §5.2). What this is for is a floor under "the sim is cheap" — so
    // that a change making a step ten times dearer is visible to whoever runs
    // `pnpm test`, in the same breath as the run that proved it still flies.
    const us = (ms: number, ticks: number): number => (ms * 1000) / ticks
    const stepBudgetMs = FIXED_DT * 1000
    const lines: string[] = [
      `VR-PERF H1 — ${MISSION}, ${WINDOW_SECONDS} s = ${TICKS} ticks at ${FIXED_DT} s (${(1 / FIXED_DT).toFixed(3)} Hz, ${stepBudgetMs.toFixed(2)} ms per step)`,
      `  fan: ${FIELDS.length} fields (land pitch ${LAND.step} m, ocean pitch ${OCEAN.step * OCEAN.scaleX} m), ${HULL.length} hull spheres`,
    ]
    for (const edition of EDITIONS) {
      const r = runOnce(edition)
      const playerUs = us(r.playerMs, r.ticks)
      const gridUs = us(r.gridMs, r.ticks)
      const racerUs = r.racers > 0 ? (gridUs - playerUs) / r.racers : 0
      const pct = (u: number): string => ((u / 1000 / stepBudgetMs) * 100).toFixed(2)
      lines.push(
        `  ${r.edition.padEnd(12)} reach ${String(r.reach).padStart(3)} m · samples/tick max ${String(r.maxSamples).padStart(3)} of ${r.budget} · rings ${r.ringsPassed} · score ${r.score}`,
        `    player alone       ${playerUs.toFixed(1).padStart(7)} us/step  ${Math.round(
          1e6 / playerUs,
        )
          .toLocaleString('en-US')
          .padStart(9)} steps/s  ${pct(playerUs).padStart(5)} % of the step budget`,
        `    player + ${r.racers} racers  ${gridUs.toFixed(1).padStart(7)} us/step  ${Math.round(
          1e6 / gridUs,
        )
          .toLocaleString('en-US')
          .padStart(
            9,
          )} steps/s  ${pct(gridUs).padStart(5)} %   (~${racerUs.toFixed(1)} us per racer per step)`,
      )
    }
    lines.push(
      '  the racers fly ai-racer.test.ts’s configuration — no terrain, no guide route, no crash',
      '  spec, no props — so the racer figure is a LOWER bound on the game’s. The end-to-end',
      '  number is the worn trace’s sim_ms column (VR-PERF §5.2); `pnpm bench` times the parts.',
    )
    console.info(`\n${lines.join('\n')}\n`)
    expect(lines.length).toBeGreaterThan(4)
  })
})
