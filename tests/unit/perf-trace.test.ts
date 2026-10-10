// tests/unit/perf-trace.test.ts — the trace's arithmetic, against series whose
// answers are known by hand.
//
// DEV-160 / VR-PERF §5.2. Same limit `perf-recorder.test.ts` states up front:
// nothing here measures a real frame, because CI has no GPU that can be made to
// struggle on demand. What IS under test is the part a worn session cannot
// re-run — the window, the percentiles, the freshness filter and the wire
// format — because a trace taken in a headset is read once, hours later, on a
// desktop, and a column that was quietly wrong is a number that gets believed.
//
// The one that earns its place most: `gpu_fresh`. The GPU column REPEATS on
// frames where no query landed, so a p50 taken over every row is a median of
// however often the driver answered rather than of the GPU's cost. That is a
// plausible number in the right units and it would never be questioned.

import { describe, expect, it, vi } from 'vitest'
import {
  HITCH_BUDGETS as RECORDER_HITCH_BUDGETS,
  TIER_FRAME_INTERVALS as RECORDER_TIER_FRAME_INTERVALS,
} from '@/boot/perf-recorder'
import {
  COLUMNS,
  capacityFor,
  createTraceRecorder,
  formatTraceSummary,
  HITCH_BUDGETS,
  MAX_TRACE_ROWS,
  MAX_TRACE_SECONDS,
  OPEN_TRACE_INITIAL_ROWS,
  PHASE_FLYING,
  PHASE_PRE_FLIGHT,
  PHASE_RUN_OVER,
  parseTraceSeconds,
  ROWS_PER_SECOND,
  STRIDE,
  TIER_FRAME_INTERVALS,
  type TraceSample,
} from '@/boot/perf-trace'

/** 90 Hz, the release target on the Steam Frame. */
const BUDGET_MS = 1000 / 90

/**
 * A fresh sample object per call — the OPPOSITE of what `app.ts` does, on
 * purpose: if the recorder ever kept a reference to the object it was handed,
 * a test that reused one would not notice and a test that does not, does.
 */
const sample = (over: Partial<TraceSample> = {}): TraceSample => ({
  dtMs: 11.1,
  ticks: 1,
  simMs: 0.8,
  renderMs: 3.2,
  frameMs: 5.0,
  gpuMs: Number.NaN,
  gpuFresh: false,
  calls: 540,
  triangles: 2_960_000,
  programs: 41,
  scale: 1,
  hz: 90,
  shipX: 100,
  shipZ: -200,
  elapsedSeconds: 0,
  // A machine keeping up: the tier IS the display. Every test that wants the
  // two to disagree says so — see the hitch tests, which is the only place it
  // matters (DEV-179).
  tierMs: BUDGET_MS,
  terrainPending: 0,
  terrainDetailPending: 0,
  terrainFading: 0,
  seaPending: 0,
  seaFading: 0,
  pieces: 0,
  // DEV-236: 2016 px, one worn eye at full size — so the default sample is a
  // frame where the ask (`scale: 1`) and the outcome agree, and a test that
  // wants them to disagree says so.
  viewportWidth: 2016,
  // DEV-243: no panel in the default sample, so the cumulative repaint count
  // sits at zero and a test that wants it to move says so.
  hudPaints: 0,
  platePaints: 0,
  // DEV-261. `PHASE_FLYING` is the default here because every trace taken
  // before that DEV could only hold flight — arming waited for the release —
  // so this keeps the existing cases measuring what they always measured. A
  // test about the ride sets it.
  phase: PHASE_FLYING,
  // DEV-335: no Advanced rows on unless a test says so.
  features: 0,
  ...over,
})

const meta = { budgetMs: BUDGET_MS, budgetSource: 'measured', mission: 'int_01_hoverJet' }

describe('parseTraceSeconds', () => {
  it('is null for absent, blank, non-numeric and non-positive', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseTraceSeconds(null)).toBeNull()
    expect(parseTraceSeconds('')).toBeNull()
    expect(parseTraceSeconds('   ')).toBeNull()
    expect(parseTraceSeconds('soon')).toBeNull()
    expect(parseTraceSeconds('0')).toBeNull()
    expect(parseTraceSeconds('-5')).toBeNull()
    expect(parseTraceSeconds('Infinity')).toBeNull()
    warn.mockRestore()
  })

  it('takes a positive number of seconds, and CLAMPS rather than silently obeying', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseTraceSeconds('20')).toBe(20)
    expect(parseTraceSeconds('0.5')).toBe(0.5)
    // A soak that records five minutes when you asked for an hour has to say so,
    // or the missing 55 minutes look like a run that ended early.
    expect(parseTraceSeconds('3600')).toBe(MAX_TRACE_SECONDS)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('the trace recorder', () => {
  it('is idle and empty before it is started, and ignores frames', () => {
    const t = createTraceRecorder()
    expect(t.status).toBe('idle')
    t.frame(sample())
    expect(t.frames).toBe(0)
    const s = t.summary()
    // Every field finite: `NaN ms` renders perfectly on a plate and in a console.
    expect(s.frames).toBe(0)
    expect(s.fps).toBe(0)
    expect(s.dt.p50).toBe(0)
    expect(s.gpuFrames).toBe(0)
    expect(s.worst).toEqual([])
  })

  it('records a window of WALL SECONDS, not of buffer rows', () => {
    // The bug this exists to prevent: `capacity = seconds x 240` with the stop
    // driven by the buffer filling means a 90 Hz headset records a `trace=2`
    // for 5.3 seconds. Asserted as a RELATIONSHIP — the recorded span is the
    // window, whatever the frame rate — so it is true at 72, 90 and 120 too.
    const t = createTraceRecorder()
    t.start(2, meta)
    // 90 Hz: 11.111 ms a frame.
    for (let i = 0; i < 1000 && t.status === 'recording'; i++) {
      t.frame(sample({ dtMs: 1000 / 90, elapsedSeconds: i / 90 }))
    }
    expect(t.status).toBe('done')
    expect(t.overflowed).toBe(false)
    // The span is the window, to within the last frame — asserted as a
    // relationship rather than as a frame count, because the count is the
    // relationship divided by whatever rate the display happened to run at.
    expect(t.seconds).toBeGreaterThanOrEqual(2)
    expect(t.seconds - 2).toBeLessThan(1 / 90)
    // And it is nowhere near the buffer, which is the bug: at 240 rows a second
    // a buffer-driven stop would have recorded 480 frames — 5.3 s of flight.
    expect(t.frames).toBeLessThan(capacityFor(2) / 2)
  })

  it('stops and flags itself when the BUFFER fills first', () => {
    // Only reachable above 240 fps, which is why it is the flag and not the
    // clock. A truncated trace that knows it is truncated beats a complete-
    // looking one that is not.
    const t = createTraceRecorder()
    t.start(1, meta)
    for (let i = 0; i < capacityFor(1) + 50 && t.status === 'recording'; i++) {
      t.frame(sample({ dtMs: 1, elapsedSeconds: i / 1000 }))
    }
    expect(t.status).toBe('done')
    expect(t.overflowed).toBe(true)
    expect(t.frames).toBe(capacityFor(1))
    expect(t.summary().overflowed).toBe(true)
  })

  it('stops accepting frames once it is done, and `stop()` is idempotent', () => {
    const t = createTraceRecorder()
    t.start(60, meta)
    t.frame(sample())
    t.stop()
    expect(t.status).toBe('done')
    t.frame(sample())
    expect(t.frames).toBe(1)
    t.stop()
    expect(t.status).toBe('done')
  })

  it('reuses the buffer for a second, shorter trace', () => {
    const t = createTraceRecorder()
    t.start(10, meta)
    expect(t.capacity).toBe(capacityFor(10))
    t.frame(sample())
    t.start(2, meta)
    // The window is the SHORT one — an allocation optimisation that left the
    // capacity at the previous run's would quietly record five times too long.
    expect(t.capacity).toBe(capacityFor(2))
    expect(t.frames).toBe(0)
    expect(t.status).toBe('recording')
  })

  it('computes p50, p95 and max over a known series, per column', () => {
    const t = createTraceRecorder()
    t.start(60, meta)
    // 100 frames, dt 1..100 ms. The interpolated p95 of 1..100 is 95.05.
    for (let i = 1; i <= 100; i++) {
      t.frame(sample({ dtMs: i, simMs: i / 2, renderMs: i / 4, frameMs: i * 0.8 }))
    }
    const s = t.summary()
    expect(s.frames).toBe(100)
    expect(s.dt.p50).toBeCloseTo(50.5, 6)
    expect(s.dt.p95).toBeCloseTo(95.05, 6)
    expect(s.dt.max).toBe(100)
    expect(s.sim.p50).toBeCloseTo(25.25, 4)
    expect(s.render.max).toBe(25)
    expect(s.frame.p50).toBeCloseTo(40.4, 4)
    // 5,050 ms of frames.
    expect(s.seconds).toBeCloseTo(5.05, 4)
    expect(s.fps).toBeCloseTo(100 / 5.05, 4)
  })

  it('counts a hitch against each frame’s own tier, and none without a budget', () => {
    const t = createTraceRecorder()
    t.start(60, meta)
    for (let i = 0; i < 20; i++) t.frame(sample({ dtMs: 11 }))
    t.frame(sample({ dtMs: 40 })) // > 2 x 11.11
    t.frame(sample({ dtMs: 22 })) // exactly under 2 x 11.11 x ... 22 < 22.22
    const s = t.summary()
    expect(s.hitches).toBe(1)
    expect(s.hitchFraction).toBeCloseTo(1 / 22, 6)

    // No budget stamped: everything would be "over" a threshold of zero, so the
    // honest answer is no hitch count at all.
    const u = createTraceRecorder()
    u.start(60)
    u.frame(sample({ dtMs: 400 }))
    expect(u.summary().hitches).toBe(0)
    expect(u.summary().budgetSource).toBe('unset')
  })

  // ── DEV-179: a hitch is against the TIER, a tier frame against the display ─
  //
  // Lap 4, in a trace: 2,364 frames of a 90 Hz display held by SteamVR at 30.
  // Every one of those frames was 33.3 ms, and judged against the header's
  // 11.1 ms budget 73 % of them read as hitches — a column saying three frames
  // in four are a hitch is not reporting hitches, it is reporting the tier.
  describe('the tier and the hitch are different questions', () => {
    /** Lap 4's shape: a 90 Hz display, SteamVR holding the app at 30. */
    const TIER_30_MS = 1000 / 30

    it('reads a steadily-paced 30 Hz tier as no hitches and all tier', () => {
      const t = createTraceRecorder()
      t.start(60, meta)
      for (let i = 0; i < 200; i++) t.frame(sample({ dtMs: TIER_30_MS, tierMs: TIER_30_MS }))
      const s = t.summary()
      // Perfectly paced AT the tier: nothing missed the rate it was given.
      expect(s.hitches).toBe(0)
      // ...and every frame of it was one the display never got to show.
      expect(s.tierFraction).toBe(1)
      expect(s.tierFrames).toBe(200)
    })

    it('still finds a frame that missed even the tier', () => {
      const t = createTraceRecorder()
      t.start(60, meta)
      for (let i = 0; i < 99; i++) t.frame(sample({ dtMs: TIER_30_MS, tierMs: TIER_30_MS }))
      t.frame(sample({ dtMs: 3 * TIER_30_MS, tierMs: TIER_30_MS }))
      const s = t.summary()
      expect(s.hitches).toBe(1)
      expect(s.tierFrames).toBe(100)
    })

    it('agrees with the live recorder about what a tier frame is', () => {
      // Two files, one definition. The plate's 3 s window and this whole-run
      // figure are the same quantity over different spans, and two constants
      // that drifted apart would be a disagreement nobody could see.
      expect(TIER_FRAME_INTERVALS).toBe(RECORDER_TIER_FRAME_INTERVALS)
      expect(HITCH_BUDGETS).toBe(RECORDER_HITCH_BUDGETS)
    })

    it('falls back to the header for a trace taken before the column existed', () => {
      // A row with no `tier_ms` reads 0, which is every CSV recorded before
      // DEV-179 and every caller that does not set the field. The threshold is
      // then the display's, which is both the old behaviour and the truth for a
      // run that never left the display's rate.
      const t = createTraceRecorder()
      t.start(60, meta)
      for (let i = 0; i < 9; i++) t.frame(sample({ dtMs: 11, tierMs: 0 }))
      t.frame(sample({ dtMs: 40, tierMs: 0 }))
      expect(t.summary().hitches).toBe(1)
    })
  })

  it('histograms ticks per frame into 0 / 1 / 2 / 3+', () => {
    const t = createTraceRecorder()
    t.start(60, meta)
    for (const ticks of [0, 1, 1, 1, 2, 2, 3, 7, 0]) t.frame(sample({ ticks }))
    expect(t.summary().ticks).toEqual({ zero: 2, one: 3, two: 2, threePlus: 2 })
  })

  it('reports the worst five frames by dt, longest first, with where they were', () => {
    const t = createTraceRecorder()
    t.start(60, meta)
    const dts = [10, 50, 11, 12, 90, 10, 30, 10, 40, 20]
    dts.forEach((dtMs, i) => {
      t.frame(sample({ dtMs, elapsedSeconds: i, shipX: i * 10, shipZ: -i * 10, programs: 40 + i }))
    })
    const worst = t.summary().worst
    expect(worst.map((w) => w.dtMs)).toEqual([90, 50, 40, 30, 20])
    // The row carries its OWN context, which is the point: a worst frame with
    // no position is a number you cannot fly back to.
    expect(worst[0]?.index).toBe(4)
    expect(worst[0]?.elapsedSeconds).toBe(4)
    expect(worst[0]?.shipX).toBe(40)
    expect(worst[0]?.shipZ).toBe(-40)
    expect(worst[0]?.programs).toBe(44)
  })

  it('keeps fewer than five worst frames when the trace is shorter than five', () => {
    const t = createTraceRecorder()
    t.start(60, meta)
    t.frame(sample({ dtMs: 5 }))
    t.frame(sample({ dtMs: 9 }))
    expect(t.summary().worst.map((w) => w.dtMs)).toEqual([9, 5])
  })

  it('computes the GPU stat over FRESH rows only, ignoring the repeats', () => {
    // The shape a real driver produces: a result lands every third frame and
    // `gpu.last` repeats in between. Over every row the median of
    // [2,2,2, 20,20,20] is 11; over the fresh rows only it is 2 and 20's weight
    // is one sample, which is the truth.
    const t = createTraceRecorder()
    t.start(60, meta)
    const landed = [2, 2, 2, 2, 2, 2, 2, 2, 2, 20]
    for (const ms of landed) {
      t.frame(sample({ gpuMs: ms, gpuFresh: true }))
      t.frame(sample({ gpuMs: ms, gpuFresh: false }))
      t.frame(sample({ gpuMs: ms, gpuFresh: false }))
    }
    const s = t.summary()
    expect(s.frames).toBe(30)
    expect(s.gpuFrames).toBe(10)
    expect(s.gpu.p50).toBe(2)
    expect(s.gpu.max).toBe(20)
  })

  it('treats a "fresh" NaN as not fresh, so an unsupported timer reads as absent', () => {
    // `gpu.last` is NaN until the first query lands. A row that claimed to be
    // fresh with NaN in it would put NaN into a percentile and every GPU number
    // in the summary would read "NaN ms".
    const t = createTraceRecorder()
    t.start(60, meta)
    for (let i = 0; i < 10; i++) t.frame(sample({ gpuMs: Number.NaN, gpuFresh: true }))
    const s = t.summary()
    expect(s.gpuFrames).toBe(0)
    expect(s.gpu.p50).toBe(0)
    expect(Number.isFinite(s.gpu.max)).toBe(true)
  })

  it('dumps a JSON header, a column line, and one CSV row per frame', () => {
    const t = createTraceRecorder()
    t.start(60, { ...meta, version: 'dev+test', mode: 'test', edition: 'anniversary' })
    // 11.25 rather than a value like 11.115: the rows are a `Float32Array`, so
    // a decimal that is not representable comes back a hair low and rounds the
    // other way. Worth knowing before anyone reads the last digit of a dump as
    // a measurement — the column is stored to ~7 significant figures, not to
    // the two the text shows.
    for (let i = 0; i < 7; i++) t.frame(sample({ dtMs: 11.25, elapsedSeconds: i / 90 }))
    const lines = t.dump().split('\n')
    const header = JSON.parse(lines[0] as string) as Record<string, unknown>
    expect(header.mission).toBe('int_01_hoverJet')
    expect(header.budgetSource).toBe('measured')
    expect(header.budgetMs).toBeCloseTo(BUDGET_MS, 6)
    expect(header.edition).toBe('anniversary')
    expect(header.frames).toBe(7)
    expect(header.columns).toEqual([...COLUMNS])
    expect(typeof header.startedAt).toBe('string')
    expect(lines[1]).toBe(COLUMNS.join(','))
    // The row count is the frame count. An off-by-one here is a trace whose
    // last frame — the interesting one, if it hitched — is missing.
    expect(lines).toHaveLength(2 + 7)
    const cells = (lines[2] as string).split(',')
    expect(cells).toHaveLength(STRIDE)
    expect(cells[0]).toBe('11.25') // ms to 2 dp
    expect(cells[COLUMNS.indexOf('calls')]).toBe('540')
  })

  it('writes NaN for a frame with no ship rather than a zero that reads as the origin', () => {
    const t = createTraceRecorder()
    t.start(60, meta)
    t.frame(sample({ shipX: Number.NaN, shipZ: Number.NaN }))
    const cells = (t.dump().split('\n')[2] as string).split(',')
    expect(cells[COLUMNS.indexOf('ship_x')]).toBe('NaN')
    expect(cells[COLUMNS.indexOf('ship_z')]).toBe('NaN')
  })

  it('reset() empties it back to idle', () => {
    const t = createTraceRecorder()
    t.start(60, meta)
    t.frame(sample())
    t.reset()
    expect(t.status).toBe('idle')
    expect(t.frames).toBe(0)
    expect(t.summary().frames).toBe(0)
  })
})

describe('the column list is a wire format', () => {
  it("is §5.2's fifteen, DEV-179's tier_ms, DEV-177(b)'s six, DEV-236's vp_w, DEV-243's two panels, DEV-335's features", () => {
    // Pinned because `dump()` writes them into its header and a reader takes
    // the order from the file. Reordering one is a silent reinterpretation of
    // every trace already taken — and that is why everything after the
    // original fifteen is APPENDED. A reader that takes its order from the header does not care
    // either way; a script that hard-coded `row[14]` for `elapsed_s` is still
    // right after this change and would not have been after an insertion.
    expect([...COLUMNS]).toEqual([
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
      'vp_w',
      'hud_paints',
      'plate_paints',
      'phase',
      // DEV-335: the Advanced rows' bitmask, appended like everything since.
      'features',
    ])
    expect(STRIDE).toBe(27)
    // The relationship, not the value: the original fifteen keep their
    // positions whatever gets added after them (trap 24).
    expect(COLUMNS.indexOf('elapsed_s')).toBe(14)
    // DEV-236's pair, and the reason both are columns rather than one.
    // `scale` is what the adaptive controller ASKED FOR; `vp_w` is what the
    // runtime GAVE. They read 0.600 against a full-size 2016 px eye for six
    // weeks and no instrument could put them side by side, because the ask was
    // per frame and the outcome was stamped once in a header. Appended, so
    // every trace taken before today still reads correctly by index.
    expect(COLUMNS.indexOf('scale')).toBeLessThan(COLUMNS.indexOf('vp_w'))
    // DEV-243, appended after `vp_w` for the reason `vp_w` was appended after
    // `pieces`. A repaint is a whole-canvas upload inside the timed render, so
    // this is the column that says how many of a row's `gpu_ms` went on moving
    // 454,720 bytes — see `render/hud.ts`'s DEV-243 block. Newest last, always.
    // DEV-261's `phase`, appended for the same reason and now the last one.
    // `plate_paints` held this assertion until today; the durable half of it
    // is that the PAIR stays adjacent, which is the line below. DEV-335's
    // `features` is newest now, so it is last and `phase` sits before it.
    expect(COLUMNS.indexOf('features')).toBe(COLUMNS.length - 1)
    expect(COLUMNS.indexOf('phase')).toBe(COLUMNS.length - 2)
    // The PAIR, and the order within it: the HUD first, its control beside it.
    // Two panels, two rates, one mechanism — the row only reads if both are in
    // the same file (DEV-243 section 2b).
    expect(COLUMNS.indexOf('plate_paints')).toBe(COLUMNS.indexOf('hud_paints') + 1)
  })

  it("carries the world's counters into the row and the worst-frame line", () => {
    // DEV-177(b). The ~15 s and ~23 s stalls carry no program change, so the
    // trace needed a column that could say what else was happening. These are
    // the mechanisms: a chunk being built from a worker reply, a detail chunk
    // landing, a cross-fade drawing two chunks at once, a prop in six pieces.
    const t = createTraceRecorder()
    t.start(60, meta)
    t.frame(sample({ dtMs: 8 }))
    t.frame(
      sample({
        dtMs: 150,
        terrainPending: 3,
        terrainDetailPending: 1,
        terrainFading: 7,
        seaPending: 2,
        seaFading: 1,
        pieces: 6,
        elapsedSeconds: 15.1,
      }),
    )
    const cells = (t.dump().split('\n')[3] as string).split(',')
    expect(cells[COLUMNS.indexOf('terr_pending')]).toBe('3')
    expect(cells[COLUMNS.indexOf('terr_detail')]).toBe('1')
    expect(cells[COLUMNS.indexOf('terr_fading')]).toBe('7')
    expect(cells[COLUMNS.indexOf('sea_pending')]).toBe('2')
    expect(cells[COLUMNS.indexOf('sea_fading')]).toBe('1')
    expect(cells[COLUMNS.indexOf('pieces')]).toBe('6')

    const worst = t.summary().worst[0]
    expect(worst?.dtMs).toBeCloseTo(150, 3)
    expect(worst?.terrainPending).toBe(3)
    expect(worst?.terrainFading).toBe(7)
    expect(worst?.seaFading).toBe(1)
    expect(worst?.pieces).toBe(6)
    expect(formatTraceSummary(t.summary())).toContain('land 3p/1d/7f · sea 2p/1f · 6 pieces')
  })

  it('records the viewport the runtime GAVE beside the scale we asked for', () => {
    // DEV-236, and the reason it is two columns rather than one.
    //
    // `scale` is the ask and `vp_w` is the outcome. For six weeks they read
    // 0.600 against a full-size 2016 px eye — `requestViewportScale` was being
    // called on the projection LAYER, which has no such method — and nothing in
    // the project could put the two side by side, because the ask was recorded
    // per frame and the outcome was stamped once in a header.
    //
    // The three rows below are the three states worth telling apart, and the
    // MIDDLE one is the bug: an ask that moved and a viewport that did not.
    const t = createTraceRecorder()
    t.start(60, meta)
    t.frame(sample({ scale: 1, viewportWidth: 2016 })) // asked full, got full
    t.frame(sample({ scale: 0.6, viewportWidth: 2016 })) // asked small, got full — the bug
    t.frame(sample({ scale: 0.6, viewportWidth: 1210 })) // asked small, got small — the fix
    const lines = t.dump().split('\n')
    const cells = (i: number) => (lines[i + 2] as string).split(',')
    const vp = COLUMNS.indexOf('vp_w')
    const sc = COLUMNS.indexOf('scale')

    expect(cells(0)[vp]).toBe('2016')
    expect(cells(1)[vp], 'the row that proves the columns can disagree').toBe('2016')
    expect(cells(2)[vp]).toBe('1210')
    // And the ask really did move across all three, so row 1's agreement with
    // row 0 is the VIEWPORT holding still rather than the controller doing so.
    expect(cells(0)[sc]).toBe('1.000')
    expect(cells(1)[sc]).toBe('0.600')
    expect(cells(2)[sc]).toBe('0.600')
  })

  it('shows the SEA even when the land is quiet, which is the case it exists for', () => {
    // The first version of these columns read the land alone, and both of the
    // stalls DEV-177(b) was opened for then printed as "nothing in the world
    // was happening" — what had happened was one sea chunk going LOD 1 -> LOD 0,
    // ~150 k triangles in a single draw. A land-only line would be blank here.
    const t = createTraceRecorder()
    t.start(60, meta)
    t.frame(sample({ dtMs: 8 }))
    t.frame(sample({ dtMs: 150, seaFading: 1, elapsedSeconds: 15.0 }))
    const text = formatTraceSummary(t.summary())
    expect(text).toContain('sea 0p/1f')
    expect(text).toContain('land 0p/0d/0f')
  })

  it('leaves the worst-frame line alone when the world was quiet', () => {
    // The counters are four columns of width on a line that is read off a
    // plate in a headset. All-zero says nothing, so it says nothing.
    const t = createTraceRecorder()
    t.start(60, meta)
    t.frame(sample({ dtMs: 40 }))
    const text = formatTraceSummary(t.summary())
    expect(text).toContain('worst frames by dt')
    expect(text).not.toContain('chunks')
    expect(text).not.toContain('pieces')
  })

  // ── DEV-239: the rise that came BEFORE the stall ───────────────────────
  //
  // `perf-protocol.md` §5a recorded the ~15 s and ~23 s stalls on `int_01` as
  // carrying **no program change**, and §5a was reading the `programs` column
  // ON the stalling row. That is true of the row and false of the event:
  // three's `programs.length` grows when the program OBJECT is created and the
  // driver defers the LINK to its first draw, so the count steps up ten frames
  // early and is flat, at its new value, on the frame that stalls.
  //
  // `VR-PERF-TAIL.md` §4.6 found it by joining two CSV columns by hand — the
  // three worst mid-flight frames in the thirteen-mission set each follow a
  // `+1` by 122–135 ms, and the three next-worst follow none for 8–25 s. This
  // is that join, on the line.
  describe('the nearest preceding programs rise', () => {
    it('finds a rise ten frames back and says how long ago it was', () => {
      const t = createTraceRecorder()
      t.start(60, meta)
      // Ten ordinary frames, the eleventh creating a program, then nine more
      // ordinary ones, then the stall. `programs` is FLAT at 42 across the
      // stall, which is exactly what made it unreadable on the row.
      for (let i = 0; i < 10; i++)
        t.frame(sample({ dtMs: 11, programs: 41, elapsedSeconds: i / 90 }))
      t.frame(sample({ dtMs: 11, programs: 42, elapsedSeconds: 14.84 }))
      for (let i = 0; i < 9; i++) t.frame(sample({ dtMs: 11, programs: 42, elapsedSeconds: 14.9 }))
      t.frame(sample({ dtMs: 133, programs: 42, elapsedSeconds: 14.97 }))

      const worst = t.summary().worst[0]
      expect(worst?.dtMs).toBeCloseTo(133, 3)
      // The old evidence: the count on the row did not move.
      expect(worst?.programs).toBe(42)
      const rise = worst?.precedingProgramRise
      expect(rise, 'the rise is reported, not inferred from a flat column').not.toBeNull()
      expect(rise?.delta).toBe(1)
      expect(rise?.elapsedSeconds).toBeCloseTo(14.84, 2)
      // Nine ordinary frames plus the stall itself: 9 x 11 + 133.
      expect(rise?.msEarlier).toBeCloseTo(9 * 11 + 133, 3)
      expect(rise?.index).toBe(10)
    })

    it('reports it on the worst-frame line, with its distance', () => {
      const t = createTraceRecorder()
      t.start(60, meta)
      t.frame(sample({ dtMs: 11, programs: 41 }))
      t.frame(sample({ dtMs: 11, programs: 43, elapsedSeconds: 20.82 }))
      t.frame(sample({ dtMs: 133, programs: 43, elapsedSeconds: 20.96 }))
      const text = formatTraceSummary(t.summary())
      expect(text).toContain('nearest preceding programs rise: +2 at 20.82 s')
      expect(text).toContain('ms earlier')
    })

    it('says so plainly when nothing before it compiled — the other kind of stall', () => {
      // §4.6's second group: ~101–111 ms on the main thread, ordinary GPU, no
      // program within 8–25 s. The line has to be able to say that, or the
      // field turns every stall into a compile.
      const t = createTraceRecorder()
      t.start(60, meta)
      for (let i = 0; i < 5; i++) t.frame(sample({ dtMs: 11, programs: 41 }))
      t.frame(sample({ dtMs: 111, programs: 41, elapsedSeconds: 22.83 }))
      const worst = t.summary().worst[0]
      expect(worst?.precedingProgramRise).toBeNull()
      expect(formatTraceSummary(t.summary())).toContain('no programs rise anywhere before it')
    })

    it('measures the distance in WALL time, so a slow tier does not shrink it', () => {
      // Ten frames is 111 ms at 90 Hz and 222 at 45, and "shortly before" is a
      // fact about the driver's queue rather than about the row count. Same
      // rise, same ten frames, double the interval, double the answer.
      const build = (dtMs: number) => {
        const t = createTraceRecorder()
        t.start(60, meta)
        t.frame(sample({ dtMs, programs: 41 }))
        t.frame(sample({ dtMs, programs: 42 }))
        for (let i = 0; i < 9; i++) t.frame(sample({ dtMs, programs: 42 }))
        t.frame(sample({ dtMs: 133, programs: 42 }))
        return t.summary().worst[0]?.precedingProgramRise?.msEarlier ?? 0
      }
      const fast = build(11.1)
      const slow = build(22.2)
      expect(slow - 133).toBeCloseTo(2 * (fast - 133), 2)
    })

    it('is null on the first frame of a trace, which has nothing before it', () => {
      const t = createTraceRecorder()
      t.start(60, meta)
      t.frame(sample({ dtMs: 200, programs: 41 }))
      expect(t.summary().worst[0]?.index).toBe(0)
      expect(t.summary().worst[0]?.precedingProgramRise).toBeNull()
    })
  })

  // ── DEV-242: the streaming CHANGE that came before the stall ───────────
  //
  // The same defect as DEV-239's, in the other family of columns, and it took
  // a year longer to see because the columns were RIGHT.
  //
  // `int_01_hoverJet`'s two mid-flight stalls carry `terr_fading` 12 and 14 and
  // `sea_fading` 1. Read as levels, the land is fourteen times the sea and the
  // stall gets blamed on a batch of land chunks — which is what
  // `VR-PERF-WAVE-4.md` §3.5 says, and what the brief for this row repeated.
  // Read as DIFFERENCES over the frames leading in, `terr_fading` moved by
  // **zero** in all twelve stalls across six traces and `sea_fading` moved
  // 0 -> 1 in all twelve.
  //
  // The fixture below is that shape: a large steady land count, a small sea
  // count that steps, and a triangle jump of one ocean chunk through two eyes.
  describe('the nearest preceding streaming change', () => {
    /** One ocean chunk at LOD 0, 147,968 triangles, drawn through both eyes. */
    const OCEAN_CHUNK_TRIS = 2 * 147_968

    const int01Stall = () => {
      const t = createTraceRecorder()
      t.start(60, meta)
      // Steady state: fourteen land chunks fading, for seconds, unchanging.
      for (let i = 0; i < 6; i++)
        t.frame(
          sample({
            dtMs: 11,
            terrainFading: 14,
            seaPending: 1,
            triangles: 2_287_836,
            programs: 42,
          }),
        )
      // The sea chunk lands. `terr_fading` does not move. `render_ms` triples
      // because this is the frame that uploads it.
      t.frame(
        sample({
          dtMs: 22,
          renderMs: 10.1,
          terrainFading: 14,
          seaPending: 0,
          seaFading: 1,
          triangles: 2_287_836 + OCEAN_CHUNK_TRIS,
          elapsedSeconds: 22.74,
          programs: 42,
        }),
      )
      // And the stall, whose own work is ordinary.
      t.frame(
        sample({
          dtMs: 110,
          renderMs: 4.1,
          frameMs: 6.2,
          terrainFading: 14,
          seaFading: 1,
          triangles: 2_287_836 + OCEAN_CHUNK_TRIS,
          elapsedSeconds: 22.85,
          programs: 42,
        }),
      )
      return t
    }

    it('names the sea, whose counter stepped, and not the land, whose level is larger', () => {
      const worst = int01Stall().summary().worst[0]
      expect(worst?.dtMs).toBeCloseTo(110, 3)
      // The old evidence, still on the row and still misleading: the land
      // count is fourteen times the sea's and neither of them moved HERE.
      expect(worst?.terrainFading).toBe(14)
      expect(worst?.seaFading).toBe(1)

      const swap = worst?.precedingStreamingChange
      expect(swap, 'the change is reported, not left in the CSV').not.toBeNull()
      // THE assertion of this whole row: the land's delta is zero and the
      // sea's is not. A field that reported levels could not distinguish them.
      expect(swap?.terrainFading).toBe(0)
      expect(swap?.seaFading).toBe(1)
      expect(swap?.seaPending).toBe(-1)
      expect(swap?.triangles).toBe(OCEAN_CHUNK_TRIS)
      expect(swap?.elapsedSeconds).toBeCloseTo(22.74, 2)
      // The other half of the event: the frame the chunk landed on is the one
      // that uploaded it, and its render time says so.
      expect(swap?.renderMs).toBeCloseTo(10.1, 3)
      // The stall's own dt, and nothing else between them.
      expect(swap?.msEarlier).toBeCloseTo(110, 3)
    })

    it('puts both differences on the worst-frame line', () => {
      const text = formatTraceSummary(int01Stall().summary())
      expect(text).toContain('nearest preceding streaming change at 22.74 s')
      // Signed, so a zero beside a large level reads as the non-event it is.
      expect(text).toContain('land +0p/+0f')
      expect(text).toContain('sea -1p/+1f')
      expect(text).toContain(`tri +${OCEAN_CHUNK_TRIS}`)
    })

    it('says so plainly when nothing streamed — a stall that is not a swap', () => {
      // Without this the field turns every stall into a chunk swap, which is
      // the mirror of the mistake it exists to fix.
      const t = createTraceRecorder()
      t.start(60, meta)
      for (let i = 0; i < 5; i++) t.frame(sample({ dtMs: 11, terrainFading: 3 }))
      t.frame(sample({ dtMs: 111, terrainFading: 3, elapsedSeconds: 41.9 }))
      const worst = t.summary().worst[0]
      expect(worst?.precedingStreamingChange).toBeNull()
      expect(formatTraceSummary(t.summary())).toContain('no streaming change before it')
    })

    it('does not reach back past the search window', () => {
      // A change 40 frames back is not an explanation, and a field that walked
      // the whole trace would always find one on a streaming mission and
      // therefore always have something to blame. The bound is what makes an
      // answer of `null` possible at all.
      const t = createTraceRecorder()
      t.start(60, meta)
      t.frame(sample({ dtMs: 11, seaFading: 0 }))
      t.frame(sample({ dtMs: 11, seaFading: 1 }))
      for (let i = 0; i < 40; i++) t.frame(sample({ dtMs: 11, seaFading: 1 }))
      t.frame(sample({ dtMs: 120, seaFading: 1 }))
      expect(t.summary().worst[0]?.precedingStreamingChange).toBeNull()
    })

    it('measures its distance in WALL time, like the program rise', () => {
      // Same reasoning as DEV-239's: ten frames is 111 ms at 90 Hz and 222 at
      // 45, and "shortly before" is a fact about the world, not a row count.
      const build = (dtMs: number) => {
        const t = createTraceRecorder()
        t.start(60, meta)
        t.frame(sample({ dtMs, seaFading: 0 }))
        t.frame(sample({ dtMs, seaFading: 1 }))
        for (let i = 0; i < 9; i++) t.frame(sample({ dtMs, seaFading: 1 }))
        t.frame(sample({ dtMs: 133, seaFading: 1 }))
        return t.summary().worst[0]?.precedingStreamingChange?.msEarlier ?? 0
      }
      expect(build(22.2) - 133).toBeCloseTo(2 * (build(11.1) - 133), 2)
    })

    it('is null on the first frame of a trace', () => {
      const t = createTraceRecorder()
      t.start(60, meta)
      t.frame(sample({ dtMs: 200, seaFading: 1 }))
      expect(t.summary().worst[0]?.precedingStreamingChange).toBeNull()
    })
  })

  it('reserves rows at 240 Hz, so nothing anyone will plug in can overflow', () => {
    expect(capacityFor(1)).toBe(ROWS_PER_SECOND)
    expect(capacityFor(0)).toBe(1)
    expect(capacityFor(MAX_TRACE_SECONDS * 10)).toBe(MAX_TRACE_SECONDS * ROWS_PER_SECOND)
  })
})

describe('formatTraceSummary', () => {
  it('names the budget source and says the GPU is absent rather than zero', () => {
    const t = createTraceRecorder()
    t.start(60, meta)
    for (let i = 0; i < 5; i++) t.frame(sample({ dtMs: 11 + i, elapsedSeconds: i }))
    const text = formatTraceSummary(t.summary())
    expect(text).toContain('5 frames')
    expect(text).toContain('measured')
    // The half of the comparison that invites the wrong reading if it is
    // missing: a p95 of 13 ms is a pass at 72 Hz and a fail at 90.
    expect(text).toContain('11.1 ms')
    expect(text).toContain('gpu    n/a')
    expect(text).toContain('worst frames by dt')
  })

  it('says OVERFLOWED out loud, because the rest of the run is not in the file', () => {
    const t = createTraceRecorder()
    t.start(1, meta)
    while (t.status === 'recording') t.frame(sample({ dtMs: 1 }))
    expect(formatTraceSummary(t.summary())).toContain('OVERFLOWED')
  })
})

// ── DEV-261: `?perf=1` records from boot until it is stopped ───────────────
//
// Matt: *"make it so once perf=1 is there, it records until i stop it."* The
// shape of the bug it exists for: the compositor drops to a 45 Hz tier at the
// race start, and arming AT the race start put that frame one before the first
// row of every capture we have. All three worn laps open at 22.20 ms with the
// lock already in force.
describe('an OPEN-ENDED trace — start(null)', () => {
  it('has no clock, so it outlives the window a timed trace would have ended on', () => {
    const t = createTraceRecorder()
    t.start(null, meta)
    // Far past `MAX_TRACE_SECONDS`: a window would be `done` many times over.
    for (let i = 0; i < 2000; i++) t.frame(sample({ dtMs: 1000, elapsedSeconds: i }))
    expect(t.status).toBe('recording')
    expect(t.frames).toBe(2000)
    expect(t.overflowed).toBe(false)
  })

  it('GROWS rather than truncating, and keeps the FIRST rows when it does', () => {
    // The header's promise, and the whole reason this is not a ring: "a ring
    // would drop the start of the soak, which is where the load hitches and
    // the first program compiles are." Under DEV-261 the start of the soak is
    // also where the tier is lost, so dropping it would delete the finding.
    const t = createTraceRecorder()
    t.start(null, meta)
    const n = OPEN_TRACE_INITIAL_ROWS * 3
    for (let i = 0; i < n; i++) t.frame(sample({ dtMs: 5, elapsedSeconds: i }))
    expect(t.status).toBe('recording')
    expect(t.frames).toBe(n)
    const rows = t.dump().trim().split('\n').slice(2)
    expect(rows).toHaveLength(n)
    // Row 0 is still frame 0 — it survived at least two reallocations.
    const elapsed = COLUMNS.indexOf('elapsed_s')
    expect(Number(rows[0]?.split(',')[elapsed])).toBe(0)
    expect(Number(rows[n - 1]?.split(',')[elapsed])).toBe(n - 1)
  })

  it('still stops at MAX_TRACE_ROWS, and says OVERFLOWED when it does', () => {
    // "Until I stop it" has to end somewhere and the honest place is the
    // buffer. What must NOT happen is ending quietly.
    const t = createTraceRecorder()
    t.start(null, meta)
    let seen = 0
    while (t.status === 'recording' && seen < MAX_TRACE_ROWS + 10) {
      t.frame(sample({ dtMs: 1 }))
      seen += 1
    }
    expect(t.frames).toBe(MAX_TRACE_ROWS)
    expect(t.overflowed).toBe(true)
    expect(formatTraceSummary(t.summary())).toContain('OVERFLOWED')
  })

  it('leaves a TIMED trace exactly as it was — the window still ends it', () => {
    // The guard against the change leaking into `?trace=<s>`, which has no
    // reason to hold a lift ride and whose window is the point of it.
    const t = createTraceRecorder()
    t.start(1, meta)
    for (let i = 0; i < 400 && t.status === 'recording'; i++) t.frame(sample({ dtMs: 10 }))
    expect(t.status).toBe('done')
    expect(t.frames).toBeLessThan(MAX_TRACE_ROWS)
  })
})

describe('the phase column', () => {
  it('round-trips the three phases into the CSV', () => {
    const t = createTraceRecorder()
    t.start(null, meta)
    t.frame(sample({ phase: PHASE_PRE_FLIGHT }))
    t.frame(sample({ phase: PHASE_FLYING }))
    t.frame(sample({ phase: PHASE_RUN_OVER }))
    const at = COLUMNS.indexOf('phase')
    const rows = t.dump().trim().split('\n').slice(2)
    expect(rows.map((r) => r.split(',')[at])).toEqual(['0', '1', '2'])
  })

  it('counts the split, so a p95 cannot hide that it spans a lift ride', () => {
    const t = createTraceRecorder()
    t.start(null, meta)
    for (let i = 0; i < 7; i++) t.frame(sample({ phase: PHASE_PRE_FLIGHT }))
    for (let i = 0; i < 2; i++) t.frame(sample({ phase: PHASE_FLYING }))
    t.frame(sample({ phase: PHASE_RUN_OVER }))
    expect(t.summary().phases).toEqual({ preFlight: 7, flying: 2, runOver: 1 })
  })

  it('DISCLOSES the mixture in the printed summary, with the flight share', () => {
    // The trap this closes: every stat on a summary is over ALL rows, and
    // before DEV-261 "all rows" and "the flight" were the same set. They are
    // not any more, and a `dt` p95 averaged over 100 s of elevator is a
    // statistic about a cutscene that reads exactly like one about the game.
    const t = createTraceRecorder()
    t.start(null, meta)
    for (let i = 0; i < 8; i++) t.frame(sample({ phase: PHASE_PRE_FLIGHT }))
    for (let i = 0; i < 2; i++) t.frame(sample({ phase: PHASE_FLYING }))
    const text = formatTraceSummary(t.summary())
    expect(text).toContain('pre-flight:8')
    expect(text).toContain('flying:2')
    expect(text).toContain('only 20 % is flight')
    expect(text).toContain('phase==1')
  })

  it('says NOTHING about phases when the trace is all flight', () => {
    // A `?trace=<s>` window, and every trace taken before today. The line is a
    // warning; a warning that prints when there is nothing to warn about is
    // one nobody reads.
    const t = createTraceRecorder()
    t.start(20, meta)
    for (let i = 0; i < 5; i++) t.frame(sample({ phase: PHASE_FLYING }))
    expect(formatTraceSummary(t.summary())).not.toContain('phases')
  })
})

describe('DEV-335: which Advanced rows were on, per frame', () => {
  it('writes the mask into the features column and names its bits in the header', () => {
    const t = createTraceRecorder()
    t.start(1, { ...meta, featureBits: ['shadows', 'props', 'bloom'] })
    t.frame(sample({ features: 0b101 }))
    t.frame(sample({ features: 0b010 }))
    t.stop()
    const lines = t.dump().split('\n')
    const header = JSON.parse(lines[0] as string)
    expect(header.featureBits).toEqual(['shadows', 'props', 'bloom'])
    const cols = (lines[1] as string).split(',')
    const at = cols.indexOf('features')
    expect(at).toBe(cols.length - 1)
    expect(Number((lines[2] as string).split(',')[at])).toBe(5)
    expect(Number((lines[3] as string).split(',')[at])).toBe(2)
  })
})
