/**
 * tests/unit/census-baseline-tick.test.ts — a stored `missionTick` that no
 * healthy frame can reach. DEV-160 H2.
 *
 * ── The bug this closes ──────────────────────────────────────────────────
 *
 * `census-baseline.spec.ts` hunts the stored `missionTick` over `MAX_ATTEMPTS`
 * loads and, failing to land on it, prints a non-result and SKIPS. That branch
 * is right — a gate going red for a tick it did not mean to gate is a gate
 * somebody deletes — but it has one bad case: if the stored tick is a value the
 * build can no longer produce, the entry skips FOR EVER and reads as a pass in
 * every summary line. **A red gate argues for itself; a skipped one does not.**
 *
 * That happened. `rookie_01_hoverJet/anniversary@20` was written at tick 1641
 * and `ceil(20 / 0.0121999998)` is **1640**, so 1641 was one step PAST the
 * mark. It was reachable while frames were slow enough, and DEV-184 (the
 * LOD-fade `discard`, 1.33 ms an eye) and DEV-192 (the cabin's point lights)
 * took that away: five loads read 1640 · 1640 · 1640 · 1640 · 1640, on five
 * different BOOT ticks, so the loads genuinely varied and the mission tick did
 * not. Every group's call count matched the stored entry exactly. Nothing about
 * the frame had changed except which step it froze on — **the entry was never
 * keyed to the scene, it was keyed to a frame time.**
 *
 * ── Why `ceil(snapAt / dt)` is the only safe key ─────────────────────────
 *
 * `boot/app.ts` feeds the stepper `min(frameSeconds, (SNAP_AT − elapsed) + dt)`
 * while a snap is pending, and `sim/fixed-step.ts` carries an accumulator
 * across frames. So the frame that crosses the mark lands with
 * `elapsed ∈ [SNAP_AT, SNAP_AT + 2·dt)` — the two adjacent values the spec's
 * header measured — and of those, only the FIRST is guaranteed: `elapsed ≥
 * SNAP_AT` always holds, and the smallest tick satisfying it is
 * `ceil(SNAP_AT / dt)`. The second needs the previous frame to have left enough
 * in the accumulator, which is a fact about frame DURATION and nothing else.
 *
 * So: the floor is reproducible on any build, and every value above it is an
 * overshoot that a faster build stops producing. This is the whole class, and
 * it is arithmetic over a tracked file — no GPU, no browser, and it runs in
 * `pnpm check` rather than in a spec nobody runs in CI, which is how the one
 * instance survived being written.
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { snapFloorTick } from '@/boot/snap'
import { FIXED_DT } from '@/sim/constants'

const BASELINE_PATH = 'tools/perf/census-baseline.json'

interface Entry {
  readonly mission: string
  readonly snapAt: number
  readonly missionTick: number
  readonly elapsed: number
}

// The file is TRACKED, so this needs no guard and must not have one: a
// `skipIf` here would hide exactly the rot it exists to catch.
const baselines = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as Record<string, Entry>

describe('the census baseline keys on a tick every build can reach', () => {
  it('has entries to check at all, so an emptied file cannot pass silently', () => {
    expect(Object.keys(baselines).length).toBeGreaterThan(0)
  })

  for (const [key, entry] of Object.entries(baselines)) {
    it(`${key} freezes on the first step at or past its mark`, () => {
      const want = snapFloorTick(entry.snapAt)
      expect(
        entry.missionTick,
        `${key} stores mission tick ${entry.missionTick}, but ceil(${entry.snapAt} / ${FIXED_DT}) ` +
          `is ${want}. A higher value is an OVERSHOOT: the recording frame carried the sim one ` +
          `step past the mark, so the entry is keyed to that frame's duration and will skip on ` +
          `any faster build — silently, because the spec skips rather than fails. Re-record it ` +
          `(CENSUS_BASELINE_WRITE=1); the writer now refuses to store an overshoot.`,
      ).toBe(want)
    })

    it(`${key}'s recorded elapsed agrees with its tick`, () => {
      // Guards the pair, not either one: `missionTickOf` derives the tick from
      // `elapsed`, so an entry whose two fields disagree was not written by it.
      expect(Math.round(entry.elapsed / FIXED_DT)).toBe(entry.missionTick)
      expect(entry.elapsed).toBeGreaterThanOrEqual(entry.snapAt)
    })
  }
})

describe('snapFloorTick is the ceiling, not a rounding', () => {
  it('takes the step AT the mark when the mark is an exact multiple', () => {
    expect(snapFloorTick(10 * FIXED_DT, FIXED_DT)).toBe(10)
  })

  it('takes the step PAST the mark when it is not', () => {
    expect(snapFloorTick(10.5 * FIXED_DT, FIXED_DT)).toBe(11)
  })

  it('is 1640 for the 20 s mark both shipped entries use', () => {
    // Written out because it is the number in the ledger row, and a reader
    // should be able to check the claim without running the arithmetic.
    expect(snapFloorTick(20)).toBe(1640)
  })
})
