/**
 * tests/unit/floor-sweep.test.ts — the parts of DEV-226's sweep that decide what
 * a row MEANS, proved without a GPU in the room.
 *
 * ── Why this exists at all ───────────────────────────────────────────────
 *
 * `tools/perf/floor-sweep.mjs` is run by hand, once, on a quiet box with a
 * SteamVR compositor up — which is the most expensive test conditions this
 * project has. Everything in it that is ARITHMETIC rather than I/O can be wrong
 * in a way that only shows up in the report, an hour after the machine was
 * quiet, and the header's own argument about which arms are real would rot
 * silently the moment somebody added one back.
 *
 * So the three things that would cost a whole sweep are gated here:
 *
 *  1. the CSV reader, which must survive a column being APPENDED to the trace's
 *     wire format (perf-protocol §5a says it will be);
 *  2. the empty-reading rule — `n/a`, never `0.00`, because a zero reads as
 *     *free* and a null reads as *not measured* (`gpu-timer.ts`'s own lesson);
 *  3. the arm list, which must keep its empty-stage control and must NOT grow a
 *     uniform-write arm back.
 *
 * None of it needs a headset, a browser or a millisecond.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Arm, ArmReading, ArmRow } from '../../tools/perf/floor-sweep.mjs'
import { DEFAULT_ARMS, median, readTrace, report, verdict } from '../../tools/perf/floor-sweep.mjs'

/** The trace's real column list, as `xr-vrto3d-trace.spec.ts` writes it today. */
const COLUMNS = [
  'dt_ms',
  'ticks',
  'sim_ms',
  'render_ms',
  'frame_ms',
  'gpu_ms',
  'gpu_fresh',
  'calls',
  'tris',
  'programs',
  'scale',
  'hz',
  'ship_x',
  'ship_z',
  'elapsed_s',
  'tier_ms',
  'terr_pending',
  'terr_detail',
  'terr_fading',
  'sea_pending',
  'sea_fading',
  'pieces',
]

const scratch: string[] = []

const writeTrace = (columns: readonly string[], rows: readonly number[][]): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff2-floor-'))
  scratch.push(dir)
  const file = path.join(dir, 'trace.csv')
  const header = JSON.stringify({ mission: 'adv_02_jumpSeat', columns })
  fs.writeFileSync(
    file,
    `${header}\n${columns.join(',')}\n${rows.map((r) => r.join(',')).join('\n')}\n`,
  )
  return file
}

/** One row of the real shape, with `calls` and `tris` set and the rest zero. */
const row = (columns: readonly string[], calls: number, tris: number): number[] =>
  columns.map((c) => (c === 'calls' ? calls : c === 'tris' ? tris : 0))

afterEach(() => {
  while (scratch.length > 0) {
    const dir = scratch.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('readTrace', () => {
  it('reads calls and tris by NAME, so an appended column cannot move them', () => {
    // The assertion that matters is the RELATIONSHIP — the same rows read the
    // same way after the wire format grows — not the literal 153/2_645_054.
    // Trap 24: a test that re-derives its expectation the way the code does has
    // not tested the code. An index-based reader passes the first half of this
    // and fails the second.
    const rows: [number, number][] = [
      [140, 2_000_000],
      [153, 2_645_054],
      [160, 3_100_000],
    ]
    const before = readTrace(
      writeTrace(
        COLUMNS,
        rows.map(([c, t]) => row(COLUMNS, c, t)),
      ),
    )
    const grown = [...COLUMNS, 'a_column_added_next_year']
    const after = readTrace(
      writeTrace(
        grown,
        rows.map(([c, t]) => row(grown, c, t)),
      ),
    )

    expect(before).not.toBeNull()
    expect(after).toEqual(before)
    expect(before?.calls).toBe(153)
    expect(before?.triangles).toBe(2_645_054)
    expect(before?.rows).toBe(3)
  })

  it('is null for a file that is not there, rather than a zero', () => {
    expect(readTrace(path.join(os.tmpdir(), 'ff2-floor-nothing-here.csv'))).toBeNull()
  })

  it('is null when the columns it needs are absent', () => {
    const columns = ['dt_ms', 'gpu_ms']
    expect(readTrace(writeTrace(columns, [[1, 2]]))).toBeNull()
  })
})

describe('median', () => {
  it('is null for no samples — a zero would read as FREE', () => {
    // `boot/gpu-timer.ts` drops every query in flight on a `GPU_DISJOINT_EXT`,
    // so an empty window is ordinary and has to print `n/a`. The uncapped-loop
    // run of `perf-scale` read `0.00` at its largest sizes and it looked like
    // the cheapest row in the table.
    expect(median([])).toBeNull()
  })

  it('takes the middle of an odd sample and the mean of an even one', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })
})

describe('verdict', () => {
  const fixed = 3.13

  it('calls a large empty-stage reading FIXED OVERHEAD', () => {
    expect(verdict(2.9, fixed)).toMatch(/FIXED PER-FRAME OVERHEAD/)
  })

  it('calls a small one FILL', () => {
    expect(verdict(0.4, fixed)).toMatch(/^FILL\./)
  })

  it('calls the middle SPLIT rather than rounding to one story', () => {
    expect(verdict(1.8, fixed)).toMatch(/^SPLIT\./)
  })

  it('says the question is unanswered when the control did not run', () => {
    expect(verdict(null, fixed)).toMatch(/unanswered/)
  })
})

describe('report — the bracket refusal', () => {
  const OPTS = { mission: 'adv_02_jumpSeat', edition: 'anniversary', seconds: 60 }
  const quiet = (): void => {}

  const arm = (name: string, mechanism: Arm['mechanism'], hide?: string[]): Arm => ({
    name,
    mechanism,
    why: 'a test arm',
    ...(hide ? { hide } : {}),
  })

  const reading = (p50: number, calls: number, triangles = 4_600_000): ArmReading => ({
    gpu: { p50, p95: p50 + 2 },
    dt: null,
    render: null,
    frames: 4800,
    gpuFrames: 4790,
    hitches: 0,
    tierFraction: 0,
    trace: { calls, triangles, rows: 4800 },
    residue: [],
    relit: {},
  })

  /**
   * A sweep: baseline, three arms, baseline — the two baselines `driftMs`
   * apart, and each arm exactly `effects[i]` below their MEAN, which is what
   * the report compares against.
   *
   * Call counts RISE down the list — 100 for the control, then 103, 106 —
   * because the control hides a superset of every other arm and so must draw a
   * subset. It read `100 - i` until DEV-231, which made the control the most
   * expensive row in its own table: an impossible sweep that every test here
   * was written against.
   */
  const rows = (driftMs: number, effects: readonly number[]): ArmRow[] => {
    const first = 3.73
    const mean = first + driftMs / 2
    // The first row is the CONTROL, and what makes it one is `hide: ['*']` —
    // never its name. See `isEmptyStage`.
    const names = ['empty-stage', 'no-sky', 'no-ocean']
    const hides = ['*', 'sky-dome', 'world-ocean']
    return [
      { arm: arm('baseline', 'none'), dir: 'd', status: 0, read: reading(first, 153) },
      ...effects.map((e, i) => ({
        arm: arm(names[i] ?? `arm-${i}`, 'draws', [hides[i] ?? 'x']),
        dir: 'd',
        status: 0,
        read: reading(mean - e, 100 + i * 3),
      })),
      {
        arm: arm('baseline', 'none'),
        dir: 'd',
        status: 0,
        read: reading(first + driftMs, 153),
      },
    ]
  }

  it('refuses an effect at or below the bracket drift', () => {
    // 0.40 ms of drift and a 0.30 ms arm. The arm may be real; this run cannot
    // say so, and a table that printed `0.30 ms` would be read as though it
    // could. `perf-scale.spec.ts` stamps its own rows `NOT A FIT` for exactly
    // this and DEV-191's run 2 is the reason.
    const text = report(rows(0.4, [2.9, 0.3, 1.2]), OPTS, quiet)
    expect(text).toMatch(/no-sky\s+draws.*NOT attributable/)
    // ...while an effect comfortably past the drift still gets its number.
    expect(text).toMatch(/no-ocean\s+draws.*\s1\.20 ms/)
  })

  it('prints the bracket before anything it is used to judge', () => {
    const text = report(rows(0.05, [2.9, 0.3, 1.2]), OPTS, quiet)
    const bracketAt = text.indexOf('BRACKET')
    const tableAt = text.indexOf('no-sky')
    expect(bracketAt).toBeGreaterThan(-1)
    expect(bracketAt).toBeLessThan(tableAt)
    expect(text).toMatch(/DRIFT\s+0\.05 ms/)
  })

  it('shouts when the drift is large enough to have eaten the sweep', () => {
    // Wave 3's two bracketed A/Bs on this route came back 0.01 and 0.02 ms. A
    // drift of 0.8 means something moved under the run, and the rows are about
    // the room rather than the frame.
    expect(report(rows(0.8, [2.9, 0.3, 1.2]), OPTS, quiet)).toMatch(/DRIFT 0\.80 ms is large/)
    expect(report(rows(0.05, [2.9, 0.3, 1.2]), OPTS, quiet)).not.toMatch(/is large/)
  })

  it('refuses the whole table when there is no bracket', () => {
    const one: ArmRow[] = [
      { arm: arm('baseline', 'none'), dir: 'd', status: 0, read: reading(3.73, 153) },
      { arm: arm('no-sky', 'draws', ['sky-dome']), dir: 'd', status: 0, read: reading(3.4, 100) },
    ]
    const text = report(one, OPTS, quiet)
    expect(text).toMatch(/NO BRACKET/)
    expect(text).not.toMatch(/VERDICT/)
  })

  it('flags a draws arm that drew no less than the baseline as never having fired', () => {
    // §3d rule 1: an arm that did not reach the renderer reports a free cut,
    // and a free cut is indistinguishable from a result.
    const dead: ArmRow[] = [
      { arm: arm('baseline', 'none'), dir: 'd', status: 0, read: reading(3.73, 153) },
      { arm: arm('no-sky', 'draws', ['sky-dome']), dir: 'd', status: 0, read: reading(3.2, 153) },
      { arm: arm('baseline', 'none'), dir: 'd', status: 0, read: reading(3.74, 153) },
    ]
    expect(report(dead, OPTS, quiet)).toMatch(/ARM DID NOT FIRE/)
  })

  it('shouts when the arms over-sum, because occlusion can only make them short', () => {
    // Every hide pays back its own fill MINUS the fill of whatever it was
    // covering, so the arms are expected to fall short of the attributable
    // total. Summing PAST it has no benign reading and must not be filed.
    const over: ArmRow[] = [
      { arm: arm('baseline', 'none'), dir: 'd', status: 0, read: reading(3.73, 274) },
      { arm: arm('empty-stage', 'draws', ['*']), dir: 'd', status: 0, read: reading(3.2, 4) },
      {
        arm: arm('no-ocean', 'draws', ['world-ocean']),
        dir: 'd',
        status: 0,
        read: reading(2.5, 271),
      },
      {
        arm: arm('no-land', 'draws', ['world-terrain']),
        dir: 'd',
        status: 0,
        read: reading(2.6, 215),
      },
      { arm: arm('baseline', 'none'), dir: 'd', status: 0, read: reading(3.74, 274) },
    ]
    expect(report(over, OPTS, quiet)).toMatch(/THE SUBTRACTIVE ARMS OVER-SUM/)
    // ...and the control is never counted as one of the arms it bounds.
    expect(report(rows(0.02, [2.9, 0.3, 1.2]), OPTS, quiet)).not.toMatch(/OVER-SUM/)
  })

  it('marks the empty stage as the CONTROL, not as an arm with an effect', () => {
    expect(report(rows(0.02, [2.9, 0.3, 1.2]), OPTS, quiet)).toMatch(
      /empty-stage\s+draws.*THE CONTROL/,
    )
  })

  it('finds the control by hide:["*"], not by the name somebody gave the row', () => {
    // A renamed control that is found by NAME silently becomes an ordinary arm:
    // counted into the sum it exists to bound, and the verdict goes quiet. The
    // same rows, with the control called something else, must read identically.
    const renamed = rows(0.02, [2.9, 0.3, 1.2]).map((r) =>
      r.arm.hide?.includes('*') ? { ...r, arm: { ...r.arm, name: 'nothing-drawn' } } : r,
    )
    const text = report(renamed, OPTS, quiet)
    expect(text).toMatch(/nothing-drawn\s+draws.*THE CONTROL/)
    expect(text).toMatch(/EMPTY STAGE\s+0\.84 ms/)
    expect(text).not.toMatch(/unanswered/)
  })

  it('marks the shadows arm CONFOUNDED however big its effect is', () => {
    const confounded: ArmRow[] = [
      { arm: arm('baseline', 'none'), dir: 'd', status: 0, read: reading(3.73, 153) },
      {
        arm: { name: 'shadows-off', mechanism: 'pass+define', why: 'both at once' },
        dir: 'd',
        status: 0,
        read: reading(1.03, 100),
      },
      { arm: arm('baseline', 'none'), dir: 'd', status: 0, read: reading(3.74, 153) },
    ]
    expect(report(confounded, OPTS, quiet)).toMatch(/CONFOUNDED \(pass \+ fragment\)/)
  })
})

describe('report — the additive half', () => {
  const OPTS = { mission: 'adv_02_jumpSeat', edition: 'anniversary', seconds: 60 }
  const quiet = (): void => {}

  const reading = (p50: number, calls: number, triangles = 4_600_000): ArmReading => ({
    gpu: { p50, p95: p50 + 2 },
    dt: null,
    render: null,
    frames: 4800,
    gpuFrames: 4790,
    hitches: 0,
    tierFraction: 0,
    trace: { calls, triangles, rows: 4800 },
    residue: [],
    relit: {},
  })

  const row = (a: Arm, p50: number, calls: number): ArmRow => ({
    arm: a,
    dir: `d/${a.name}`,
    status: 0,
    read: reading(p50, calls),
  })

  const BASE: Arm = { name: 'baseline', mechanism: 'none', why: 'bracket' }
  const EMPTY: Arm = { name: 'empty-stage', mechanism: 'draws', why: 'control', hide: ['*'] }

  /** baseline 3.73 · empty 2.60 · hide/solo of `world-ocean` · baseline 3.75. */
  const sweep = (hideP50: number, soloP50: number, soloCalls = 7): ArmRow[] => [
    row(BASE, 3.73, 274),
    row(EMPTY, 2.6, 4),
    row({ name: 'no-ocean', mechanism: 'draws', why: '', hide: ['world-ocean'] }, hideP50, 271),
    row(
      { name: 'only-ocean', mechanism: 'draws', why: '', solo: ['world-ocean'] },
      soloP50,
      soloCalls,
    ),
    row(BASE, 3.75, 274),
  ]

  it('scores a solo against the EMPTY STAGE, not against the baseline', () => {
    // `only-ocean` at 3.10 against an empty stage of 2.60 is 0.50 ms of ocean.
    // Scored the subtractive way it would read 0.64, and the two tables would
    // then differ by a convention rather than by occlusion — which is the one
    // thing the gap column must not be measuring.
    const text = report(sweep(3.29, 3.1), OPTS, quiet)
    expect(text).toMatch(/only-ocean\s+draws\s+3\.10\s+0\.50/)
  })

  it('pairs the two directions by the GROUP, not by the arm names', () => {
    // `no-ocean` and `only-ocean` share nothing but `world-ocean`, and that is
    // what makes them two readings of one thing. Pairing by a name convention
    // would break the first time somebody called an arm something else.
    const text = report(sweep(3.29, 3.1), OPTS, quiet)
    expect(text).toMatch(/world-ocean\s+0\.45\s+0\.50\s+0\.05/)
  })

  it('calls a gap inside the bracket AGREEMENT, and says what that means', () => {
    const text = report(sweep(3.29, 3.05), OPTS, quiet)
    expect(text).toMatch(/world-ocean.*the two AGREE/)
  })

  it('does not read two SILENCES as agreement', () => {
    // Both directions below the bracket is not "they agree that it is cheap".
    // It is two runs that said nothing, and a gap of 0.00 between them would
    // otherwise print as the strongest possible agreement.
    const text = report(sweep(3.74, 2.61), OPTS, quiet)
    expect(text).toMatch(/world-ocean.*neither side clears the bracket/)
    expect(text).not.toMatch(/world-ocean.*AGREE/)
  })

  it('reads a wide gap as occlusion, and brackets the truth between them', () => {
    const text = report(sweep(3.29, 3.6), OPTS, quiet)
    expect(text).toMatch(/world-ocean.*truth is between 0\.45 and 1\.00 ms/)
  })

  it('refuses a solo whose call count did not RISE above the empty stage', () => {
    // A solo that showed nothing is the empty stage wearing a group's name. Its
    // millisecond would be the control's, and it would read as a free group.
    const text = report(sweep(3.29, 2.62, 4), OPTS, quiet)
    expect(text).toMatch(/only-ocean.*ARM DID NOT FIRE/)
    // ...and a row that did not fire cannot then be half of a gap.
    expect(text).toMatch(/world-ocean.*only ONE side clears the bracket/)
  })

  it('names the arms run in one direction only, so a gap is not missed by accident', () => {
    const lonely: ArmRow[] = [
      row(BASE, 3.73, 274),
      row(EMPTY, 2.6, 4),
      row({ name: 'no-ocean', mechanism: 'draws', why: '', hide: ['world-ocean'] }, 3.29, 271),
      row(
        { name: 'only-chunks', mechanism: 'draws', why: '', solo: ['world-terrain/chunks'] },
        2.9,
        51,
      ),
      row(BASE, 3.75, 274),
    ]
    const text = report(lonely, OPTS, quiet)
    expect(text).toMatch(/Run in ONE direction only.*no-ocean/)
    expect(text).toMatch(/Run in ONE direction only.*only-chunks/)
  })

  it('still refuses everything when there is no bracket, additive or not', () => {
    const text = report(sweep(3.29, 3.1).slice(0, 4), OPTS, quiet)
    expect(text).toMatch(/NO BRACKET/)
  })
})

describe('DEFAULT_ARMS', () => {
  it('carries the empty-stage control, because nothing else can bound the floor', () => {
    const empty = DEFAULT_ARMS.find((a) => a.hide?.includes('*'))
    expect(
      empty,
      'the sweep has no empty-stage arm — then it can rank what is drawn and\n' +
        'cannot say what the frame costs with nothing in it, which is the one\n' +
        'reading that separates fill from fixed overhead.',
    ).toBeDefined()
  })

  it('does not grow a UNIFORM-WRITE arm back', () => {
    // haze, illustrative and sunHeight all switch off by writing a uniform with
    // no early-out behind it, so they remove no work and would each report a
    // free cut — *"indistinguishable from a result"* (perf-protocol §3d.1).
    // `floor-sweep.mjs`'s header has the file:line for each. This is the guard
    // that keeps that paragraph from being prose nobody reads.
    const rejected = ['render.haze', 'render.illustrative', 'render.sunHeight']
    const flags = DEFAULT_ARMS.flatMap((a) => [...(a.flagsOff ?? [])])
    for (const flag of rejected) {
      expect(
        flags,
        `${flag} is a UNIFORM write with no early-out — the arm removes no work\n` +
          'and its row would read 0.00 ms, which is not a measurement of anything.\n' +
          "Read floor-sweep.mjs's header before adding it back.",
      ).not.toContain(flag)
    }
  })

  it('names a mechanism on every arm, because that is what the row means', () => {
    for (const arm of DEFAULT_ARMS) {
      expect(['draws', 'pass+define', 'uniform-branch'], arm.name).toContain(arm.mechanism)
      expect(arm.why.length, `${arm.name} has no justification`).toBeGreaterThan(0)
      // An arm is one thing or the other. An arm that hid a group AND flipped a
      // flag would change two systems at once and attribute neither — the exact
      // confound wave 3 §3 names in the thirteen-mission regression.
      const both = (arm.hide?.length ?? 0) > 0 && (arm.flagsOff?.length ?? 0) > 0
      expect(both, `${arm.name} both hides and flips — it can attribute neither`).toBe(false)
    }
  })
})

/**
 * DEV-231 — the control has to BE a control, and the two numbers that say so
 * were on disk in the 2026-09-19 sweep while the report printed a verdict.
 *
 * Every row here is that run's, to the digit. They are not illustrative: the
 * whole argument for both changes is that this data already separated a good
 * sweep from a ruined one and nothing was reading it.
 */
describe('report — the control, and what fired (DEV-231)', () => {
  const OPTS = { mission: 'adv_02_jumpSeat', edition: 'anniversary', seconds: 60 }
  const quiet = (): void => {}

  /** 2026-09-19, `adv_02_jumpSeat`, 60 s per arm, medians over the trace. */
  const RAN = {
    baselineFirst: { gpu: 4.69, calls: 264, tris: 2_552_736 },
    baselineLast: { gpu: 4.69, calls: 264, tris: 2_552_736 },
    /** What the control ACTUALLY drew: the whole land plus the sky. */
    emptyBroken: { gpu: 3.22, calls: 203, tris: 1_442_876 },
    /** +1 call and −1.09 M triangles. Read on calls alone: "did not fire". */
    noOcean: { gpu: 3.43, calls: 265, tris: 1_463_996 },
    /** −8 calls and ZERO triangles — the clouds draw none. */
    noClouds: { gpu: 4.61, calls: 256, tris: 2_552_736 },
    /** Bit-identical to the baseline in both: the hide really did nothing. */
    noSky: { gpu: 4.67, calls: 264, tris: 2_552_736 },
    noLand: { gpu: 4.71, calls: 264, tris: 2_552_736 },
    /** LESS than the control, which is arithmetically impossible for a solo. */
    onlyChunks: { gpu: 2.63, calls: 179, tris: 491_348 },
  } as const

  type Shot = { gpu: number; calls: number; tris: number }

  const read = (
    s: Shot,
    residue: ArmReading['residue'] = [],
    relit: ArmReading['relit'] = {},
  ): ArmReading => ({
    gpu: { p50: s.gpu, p95: s.gpu + 3 },
    dt: null,
    render: null,
    frames: 4800,
    gpuFrames: 4790,
    hitches: 0,
    tierFraction: 0,
    trace: { calls: s.calls, triangles: s.tris, rows: 4800 },
    residue,
    relit,
  })

  const arm = (name: string, over: Partial<Arm> = {}): Arm => ({
    name,
    mechanism: 'draws',
    why: 'a real arm from the 2026-09-19 sweep',
    ...over,
  })

  const BASE = arm('baseline', { mechanism: 'none' })
  const EMPTY = arm('empty-stage', { hide: ['*'] })

  /** A control that really is empty: fewer calls and fewer triangles than any arm. */
  const emptyFixed: Shot = { gpu: 1.9, calls: 12, tris: 0 }

  const sweep = (control: ArmReading, ...arms: [Arm, ArmReading][]): ArmRow[] => [
    { arm: BASE, dir: 'd', status: 0, read: read(RAN.baselineFirst) },
    { arm: EMPTY, dir: 'd/02', status: 0, read: control },
    ...arms.map(([a, r]) => ({ arm: a, dir: `d/${a.name}`, status: 0, read: r })),
    { arm: BASE, dir: 'd', status: 0, read: read(RAN.baselineLast) },
  ]

  describe('the control must draw the least — it hides a superset of every arm', () => {
    it('refuses the whole table when an arm drew fewer CALLS than the control', () => {
      // The run that made this necessary: `only-chunks` 179 calls against a
      // control of 203. A solo hides a SUBSET of what the empty stage hides,
      // so it cannot draw less — and the sweep printed both rows, a gap table
      // and a FILL-or-FIXED verdict on top of them.
      const text = report(
        sweep(read(RAN.emptyBroken), [
          arm('only-chunks', { solo: ['world-terrain/chunks'] }),
          read(RAN.onlyChunks),
        ]),
        OPTS,
        quiet,
      )
      expect(text).toMatch(/THE CONTROL IS NOT A CONTROL/)
      expect(text).toMatch(/only-chunks drew FEWER CALLS than the control — 179 against 203/)
      // Refused, not annotated: no table, no pair column, no verdict.
      expect(text).not.toMatch(/VERDICT/)
      expect(text).not.toMatch(/SUBTRACTIVE — baseline MINUS/)
    })

    it('refuses on TRIANGLES too, so a group with no calls of its own cannot hide', () => {
      const text = report(
        sweep(read({ gpu: 2.0, calls: 10, tris: 900_000 }, null), [
          arm('only-clouds', { solo: ['clouds'] }),
          read({ gpu: 2.1, calls: 17, tris: 400_000 }),
        ]),
        OPTS,
        quiet,
      )
      expect(text).toMatch(/only-clouds drew FEWER TRIANGLES than the control/)
    })

    it('prints WHOLE triangle counts, so a real shortfall cannot read as rounding', () => {
      // `1.44M against 1.44M` was the first version of this message on the
      // 2026-09-19 tree's real 268-triangle shortfall. It looks like a bug in
      // the formatter and it is the finding.
      const text = report(
        sweep(read({ gpu: 3.22, calls: 203, tris: 1_442_876 }, null), [
          arm('only-land', { solo: ['world-terrain'] }),
          read({ gpu: 3.32, calls: 203, tris: 1_442_608 }),
        ]),
        OPTS,
        quiet,
      )
      expect(text).toMatch(/1442608 against 1442876/)
    })

    it('refuses even when the residue walk says the control drew nothing', () => {
      // The tempting softening: a residue of `[]` is a direct read of the scene
      // graph, so a small shortfall under it "can only be cross-run jitter".
      // But a control that provably drew nothing, under an arm that drew less
      // than it, is two instruments contradicting each other about one frame —
      // which is not a smaller problem than either failing alone, and an
      // exemption sized to the jitter you happen to have seen is a threshold
      // with no argument behind it. It refuses, and it says which two.
      const text = report(
        sweep(read({ gpu: 1.9, calls: 12, tris: 0 }, []), [
          arm('only-land', { solo: ['world-terrain'] }),
          read({ gpu: 3.32, calls: 11, tris: 0 }),
        ]),
        OPTS,
        quiet,
      )
      expect(text).toMatch(/THE CONTROL IS NOT A CONTROL/)
      expect(text).toMatch(/residue walk says it drew NOTHING — the two disagree/)
      expect(text).not.toMatch(/VERDICT/)
    })

    it('refuses when the control reported a RESIDUE, and names the groups', () => {
      // The inequality proves something was left; the residue says what. It is
      // checked first for that reason — a reader who has the group names does
      // not have to guess, and the fix is a grep away.
      const text = report(
        sweep(
          read(RAN.emptyBroken, [
            { group: 'world-terrain/chunks', objects: 26, triangles: 491_348 },
            { group: 'sky-dome', objects: 1, triangles: 4260 },
          ]),
        ),
        OPTS,
        quiet,
      )
      expect(text).toMatch(/THE CONTROL IS NOT A CONTROL/)
      expect(text).toMatch(/world-terrain\/chunks \(26 obj/)
      expect(text).toMatch(/sky-dome \(1 obj/)
    })

    it('prints the bracket BEFORE the refusal — a drifted run is the other story', () => {
      const text = report(sweep(read(RAN.emptyBroken, null)), OPTS, quiet)
      expect(text.indexOf('BRACKET')).toBeGreaterThan(-1)
      expect(text.indexOf('BRACKET')).toBeLessThan(text.length)
    })

    it('says out loud that a clean control drew nothing, rather than staying silent', () => {
      const text = report(
        sweep(read(emptyFixed, [], { 'world-terrain': 4854, 'sky-dome': 4854 }), [
          arm('no-ocean', { hide: ['world-ocean'] }),
          read(RAN.noOcean),
        ]),
        OPTS,
        quiet,
      )
      expect(text).toMatch(/CONTROL\s+the empty stage drew NOTHING/)
      expect(text).toMatch(/tried to re-show 2 of them mid-flight/)
      expect(text).not.toMatch(/THE CONTROL IS NOT A CONTROL/)
    })

    it('says so when a run recorded no residue at all, rather than reading it as clean', () => {
      // `null` is "this run did not say", `[]` is "nothing was left". Reading
      // the first as the second is how a guard rots into a formality.
      const text = report(sweep(read(emptyFixed, null)), OPTS, quiet)
      expect(text).toMatch(/residue NOT RECORDED/)
      expect(text).not.toMatch(/THE CONTROL IS NOT A CONTROL/)
    })
  })

  describe('did it fire — CALLS or TRIANGLES, each against the bracket', () => {
    const withArms = (...arms: [Arm, ArmReading][]): string =>
      report(sweep(read(emptyFixed), ...arms), OPTS, quiet)

    it('fires on TRIANGLES when the call count went the wrong way', () => {
      // `no-ocean`: +1 call, −1 088 740 triangles. The sea's three meshes are
      // worth fewer calls than the land's streaming moves between two runs, so
      // a calls-only test refused a million triangles. It is the row the old
      // detector got wrong and the reason the OR exists.
      const text = withArms([arm('no-ocean', { hide: ['world-ocean'] }), read(RAN.noOcean)])
      expect(text).toMatch(/no-ocean\s+draws.*\[tris\]/)
      expect(text).not.toMatch(/no-ocean.*ARM DID NOT FIRE/)
    })

    it('fires on CALLS when the arm removed no triangles at all', () => {
      // `no-clouds`: −8 calls, 0 triangles. The clouds draw none — baseline and
      // no-clouds share a modal frame of 2 557 760 — so a triangles-only test
      // would have refused this one instead. Neither half is sufficient.
      const text = withArms([arm('no-clouds', { hide: ['clouds'] }), read(RAN.noClouds)])
      expect(text).toMatch(/no-clouds\s+draws.*\[calls\]/)
    })

    it('STILL refuses the two arms that genuinely did not fire (DEV-222 §6)', () => {
      // The re-proof. `no-sky` and `no-land` were each undone by a per-frame
      // `.visible =` write and came back bit-identical to the baseline in BOTH
      // quantities at every quantile. An OR does not rescue them, and if a
      // future widening does, it has gone past what the detector is for.
      const text = withArms(
        [arm('no-sky', { hide: ['sky-dome'] }), read(RAN.noSky)],
        [arm('no-land', { hide: ['world-terrain'] }), read(RAN.noLand)],
      )
      expect(text).toMatch(/no-sky\s+draws.*ARM DID NOT FIRE/)
      expect(text).toMatch(/no-land\s+draws.*ARM DID NOT FIRE/)
    })

    it('refuses a movement the BRACKET cannot tell from the room', () => {
      // The two baselines eight calls apart: an arm eight calls below them has
      // moved by exactly the amount the empty room moved, and that is not an
      // effect. Same §3d.2 rule the milliseconds obey, on the mechanism check.
      const drifted: ArmRow[] = [
        { arm: BASE, dir: 'd', status: 0, read: read({ gpu: 4.69, calls: 264, tris: 2_552_736 }) },
        { arm: EMPTY, dir: 'd', status: 0, read: read(emptyFixed) },
        {
          arm: arm('no-clouds', { hide: ['clouds'] }),
          dir: 'd',
          status: 0,
          read: read({ gpu: 4.61, calls: 252, tris: 2_552_736 }),
        },
        { arm: BASE, dir: 'd', status: 0, read: read({ gpu: 4.7, calls: 256, tris: 2_552_736 }) },
      ]
      // Baselines 264 and 256 — a drift of 8. The arm's 252 is 8 below their
      // mean of 260, so it clears nothing.
      expect(report(drifted, OPTS, quiet)).toMatch(/no-clouds.*ARM DID NOT FIRE/)
    })
  })
})
