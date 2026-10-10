// tests/unit/perf-recorder.test.ts — the numbers the Anniversary work will be
// argued over, against series whose answers are known by hand.
//
// **What this cannot test.** Nothing here measures a real frame. CI has no GPU
// that can be made to struggle on demand — `comfort-quality.test.ts` says the
// same thing about the adaptive controller — so every series below is scripted,
// and what is under test is the ARITHMETIC and the window, not the rendering.
//
// **What it can test**, and why each one is here: a percentile computed the
// wrong way rounds a tail into a maximum and hides exactly the frames the panel
// exists to show; a window that counts SAMPLES rather than seconds means a
// reading on a 144 Hz monitor and the same reading on a 72 Hz Quest are two
// different measurements wearing one label; and a stats() that returns NaN on an
// empty buffer puts "NaN ms" on screen for the first second of every session,
// which is the second the frames are at their worst.

import { describe, expect, it } from 'vitest'
import {
  createFrameRecorder,
  DEFAULT_CAPACITY,
  DEFAULT_WINDOW_SECONDS,
  HITCH_BUDGETS,
  KNOWN_REFRESH_HZ,
  MODAL_CANDIDATES,
  percentile,
  snapRefreshHz,
} from '@/boot/perf-recorder'

/** 72 Hz, the Quest 3 browser default and M3's target. */
const BUDGET = 1 / 72

/** Feed `n` frames of `seconds` each. Returns the recorder for chaining. */
const feed = (
  recorder: ReturnType<typeof createFrameRecorder>,
  seconds: number,
  n: number,
  budget = BUDGET,
) => {
  for (let i = 0; i < n; i++) recorder.frame(seconds, budget)
  return recorder
}

describe('the frame recorder', () => {
  it('reports zeros on an empty buffer, not NaN', () => {
    const stats = createFrameRecorder().stats()
    // Every field, because the one that gets missed is the one that reaches the
    // panel. `NaN.toFixed(1)` is the string "NaN", which renders perfectly.
    for (const [key, value] of Object.entries(stats)) {
      expect(Number.isFinite(value), `${key} = ${value}`).toBe(true)
      expect(value, key).toBe(0)
    }
  })

  it('never divides by a zero mean', () => {
    // Two frames stamped at the same millisecond. A real `setAnimationLoop` can
    // hand back the same timestamp twice, and `1 / 0` on a perf panel reads as
    // "Infinity fps" — a number that gets screenshotted and believed.
    const recorder = feed(createFrameRecorder(), 0, 5)
    expect(recorder.stats().fps).toBe(0)
    expect(Number.isFinite(recorder.stats().meanMs)).toBe(true)
  })

  it('computes p50, p95 and max over a known series', () => {
    // The window is opened wide so this test is about the ARITHMETIC only —
    // 5 s of frames would otherwise fall out of the 3 s default and the
    // percentiles would be of a different set than the one named below. The
    // window has its own tests.
    const recorder = createFrameRecorder({ windowSeconds: 1e9 })
    // 100 frames, 1 ms through 100 ms. Sorted, that IS 1..100, so the answers
    // are arithmetic rather than a re-derivation of the implementation:
    // interpolated p50 sits at index 49.5 -> 50.5 ms, p95 at index 94.05 ->
    // 95.05 ms, the max is 100 ms and the mean is 50.5 ms.
    //
    // The budget is set absurdly high so nothing here counts as a hitch — the
    // hitch rule has its own test and must not colour this one.
    for (let i = 1; i <= 100; i++) recorder.frame(i / 1000, 10)
    const stats = recorder.stats()
    expect(stats.frames).toBe(100)
    expect(stats.p50Ms).toBeCloseTo(50.5, 6)
    expect(stats.p95Ms).toBeCloseTo(95.05, 6)
    expect(stats.maxMs).toBeCloseTo(100, 6)
    expect(stats.meanMs).toBeCloseTo(50.5, 6)
    expect(stats.seconds).toBeCloseTo(5.05, 6)
    expect(stats.fps).toBeCloseTo(1000 / 50.5, 6)
  })

  it('interpolates the percentile instead of taking the nearest rank', () => {
    // Three samples: nearest-rank would report p95 as the maximum, which is a
    // panel that cannot tell a tail from a single bad frame. Sorted [1, 2, 9],
    // p95 sits at index 1.9 -> 2 + 0.9 * 7 = 8.3.
    const sorted = Float64Array.from([1, 2, 9])
    expect(percentile(sorted, 0.95)).toBeCloseTo(8.3, 10)
    expect(percentile(sorted, 0.5)).toBe(2)
    expect(percentile(sorted, 0)).toBe(1)
    expect(percentile(sorted, 1)).toBe(9)
    // Degenerate inputs, because the window can be one frame long.
    expect(percentile(new Float64Array(0), 0.5)).toBe(0)
    expect(percentile(Float64Array.from([7]), 0.95)).toBe(7)
  })

  it('counts a hitch as a frame over HITCH_BUDGETS budgets', () => {
    const recorder = createFrameRecorder()
    // Nine frames on budget and one at three budgets. The threshold is exclusive,
    // so a frame of EXACTLY two budgets is not a hitch — asserted below, because
    // an off-by-one here quietly doubles or halves every hitch number anyone
    // reads off the panel.
    feed(recorder, BUDGET, 8)
    recorder.frame(BUDGET * HITCH_BUDGETS, BUDGET)
    recorder.frame(BUDGET * (HITCH_BUDGETS + 1), BUDGET)
    const stats = recorder.stats()
    expect(stats.frames).toBe(10)
    expect(stats.hitches).toBe(1)
    expect(stats.hitchFraction).toBeCloseTo(0.1, 10)
    expect(stats.targetMs).toBeCloseTo(BUDGET * 1000, 10)
  })

  it('judges each frame against the budget that was in force for it', () => {
    // A Quest whose owner set 72 Hz and a Quest at 90 disagree about what a
    // hitch is, and `XRSession.frameRate` is live — so the threshold cannot be
    // decided once at `stats()` time. Two budgets is 27.8 ms at 72 Hz and
    // 22.2 ms at 90, so 25 ms is a hitch on one and not on the other. The same
    // frame, twice, and only one of them counts.
    const recorder = createFrameRecorder()
    recorder.frame(0.025, 1 / 72)
    recorder.frame(0.025, 1 / 90)
    expect(recorder.stats().hitches).toBe(1)
  })

  it('drops frames older than the window', () => {
    const recorder = createFrameRecorder({ windowSeconds: 3 })
    // 12.5 s of 125 ms frames. Three seconds of them is twenty-four frames, and
    // the other seventy-six are behind the horizon — still in the ring, never
    // read.
    //
    // 0.125, not 0.1, and the reason is worth a line: the window is a SUM of
    // deltas, and a hundred additions of 0.1 do not reach 3 at the frame you
    // would count on paper — 30 x 0.1 is 2.9999999999999996 in binary, so the
    // walk takes a thirty-first frame and an exact assertion goes red for a
    // reason that has nothing to do with the code. Eighths are exact.
    feed(recorder, 0.125, 100)
    const stats = recorder.stats()
    expect(stats.frames).toBe(24)
    expect(stats.seconds).toBe(3)
    expect(recorder.windowSeconds).toBe(3)
  })

  it('reads the NEWEST frames, not the oldest', () => {
    // The direction of the walk, which a count alone cannot catch: a window that
    // took the first frames would report a count too. Ten slow frames, then
    // enough fast ones to fill the window twice over — so the walk must never
    // reach the slow ones, and the max says whether it did.
    const recorder = createFrameRecorder({ windowSeconds: 0.5 })
    feed(recorder, 0.25, 10)
    feed(recorder, 1 / 64, 100)
    const stats = recorder.stats()
    // 32 sixty-fourths is half a second exactly — again, exact in binary.
    expect(stats.frames).toBe(32)
    expect(stats.maxMs).toBeCloseTo(1000 / 64, 6)
  })

  it('keeps a frame longer than the whole window rather than reporting nothing', () => {
    // A ten-second stall: a geometry upload, a GC, a tab coming back. It is the
    // single most important thing that happened, and the panel's job is to show
    // it — so the window shrinks to one frame and says so through `seconds`.
    const recorder = createFrameRecorder({ windowSeconds: 3 })
    feed(recorder, 0.01, 50)
    recorder.frame(10, BUDGET)
    const stats = recorder.stats()
    expect(stats.frames).toBe(1)
    expect(stats.maxMs).toBeCloseTo(10_000, 6)
    expect(stats.seconds).toBeCloseTo(10, 6)
  })

  it('does not clamp a stall the way the adaptive controller does', () => {
    // `render/quality.ts` caps a sample at four budgets on purpose — it is a
    // CONTROLLER and a stall is not a measurement of rendering cost. This is a
    // recorder, and the two must not be confused: 250 ms here has to read 250.
    const recorder = createFrameRecorder()
    recorder.frame(0.25, BUDGET)
    expect(recorder.stats().maxMs).toBeCloseTo(250, 6)
  })

  it('ignores a broken clock instead of poisoning the window', () => {
    const recorder = createFrameRecorder()
    feed(recorder, 0.01, 5)
    recorder.frame(Number.NaN, BUDGET)
    recorder.frame(Number.POSITIVE_INFINITY, BUDGET)
    recorder.frame(-1, BUDGET)
    const stats = recorder.stats()
    expect(stats.frames).toBe(5)
    expect(stats.maxMs).toBeCloseTo(10, 6)
  })

  describe('the engaged count', () => {
    it('differences quality.ts cumulative counter rather than deciding for itself', () => {
      const recorder = createFrameRecorder()
      // The counter as `render/quality.ts` reports it: monotonic, advancing only
      // on the frames the controller spent below full resolution. Ten frames,
      // four of them engaged.
      const cumulative = [0, 0, 0, 1, 2, 3, 4, 4, 4, 4]
      for (const n of cumulative) recorder.frame(0.01, BUDGET, n)
      const stats = recorder.stats()
      expect(stats.frames).toBe(10)
      expect(stats.engagedFrames).toBe(4)
      expect(stats.engagedFraction).toBeCloseTo(0.4, 10)
    })

    it('is zero when the counter never moves', () => {
      // Adaptive resolution off: `quality.ts` does not run the controller at all,
      // so the counter stays at 0 forever. A controller that is not running has
      // not engaged, and the panel must say 0 % rather than inventing a step.
      const stats = feed(createFrameRecorder(), 0.01, 20).stats()
      expect(stats.engagedFrames).toBe(0)
      expect(stats.engagedFraction).toBe(0)
    })

    it('treats a counter that went backwards as no engagement', () => {
      // A reload or a fresh controller restarts the count. A negative delta must
      // not subtract from the window.
      const recorder = createFrameRecorder()
      for (const n of [10, 11, 12, 0, 1]) recorder.frame(0.01, BUDGET, n)
      expect(recorder.stats().engagedFrames).toBe(3)
    })

    it('ages out with the window like everything else', () => {
      const recorder = createFrameRecorder({ windowSeconds: 0.5 })
      // Engaged for the first ten frames, clear for the next fifty. The window
      // holds thirty-two of them, so the engaged ones are all behind the horizon
      // — which is the point of a windowed reading: a bad thirty seconds is
      // invisible in `QualityReport.engaged`, the whole-session fraction.
      let n = 0
      for (let i = 0; i < 10; i++) recorder.frame(1 / 64, BUDGET, ++n)
      for (let i = 0; i < 50; i++) recorder.frame(1 / 64, BUDGET, n)
      const stats = recorder.stats()
      expect(stats.frames).toBe(32)
      expect(stats.engagedFrames).toBe(0)
    })
  })

  describe('the ring', () => {
    it('is the whole memory: feeding never grows it', () => {
      // What this asserts is BOUNDED, not a stopwatch. A timing assertion on a
      // shared CI box is a flake generator, and "feeding is O(1)" is really a
      // claim about allocation: the ring and the sort scratch are allocated once
      // at construction and `frame()` writes three slots. So the observable is
      // that two hundred thousand frames neither grow the capacity nor retain
      // more than it.
      const recorder = createFrameRecorder({ capacity: 64, windowSeconds: 1e9 })
      expect(recorder.capacity).toBe(64)
      feed(recorder, 0.001, 200_000)
      expect(recorder.capacity).toBe(64)
      expect(recorder.stats().frames).toBe(64)
    })

    it('wraps onto the newest frames rather than appending', () => {
      // The other half of the same claim, and the one a capacity check cannot
      // make: after the wrap the ring must hold the LAST `capacity` frames.
      const recorder = createFrameRecorder({ capacity: 4, windowSeconds: 1e9 })
      for (const ms of [1, 2, 3, 4, 5, 6]) recorder.frame(ms / 1000, 10)
      const stats = recorder.stats()
      expect(stats.frames).toBe(4)
      // 3, 4, 5, 6 ms — mean 4.5. If it had kept the oldest four it would be 2.5.
      expect(stats.meanMs).toBeCloseTo(4.5, 6)
      expect(stats.maxMs).toBeCloseTo(6, 6)
    })

    it('holds a full window at 240 Hz by default', () => {
      // The default capacity is sized so the oldest sample in the ring is
      // genuinely older than the window on any display anyone will plug in.
      // Below that, the window would be capped by the RING rather than by time
      // and the reading would silently become a sample count again.
      expect(DEFAULT_CAPACITY).toBeGreaterThanOrEqual(DEFAULT_WINDOW_SECONDS * 240)
    })

    it('resets to empty', () => {
      const recorder = feed(createFrameRecorder(), 0.01, 50)
      expect(recorder.stats().frames).toBe(50)
      recorder.reset()
      expect(recorder.stats().frames).toBe(0)
      expect(recorder.stats().fps).toBe(0)
    })
  })
})

// ── The measured budget (DEV-160 / VR-PERF §5.3, gap 10) ──────────────────
//
// `render/quality.ts` judged every frame against `session.frameRate ?? 72`, and
// on the target rig — desktop Chrome driving a Steam Frame over SteamVR —
// `frameRate` is not on `XRSession.prototype` at all. So the `??` was the whole
// resolver, a Frame at 90 or 120 Hz was judged against 13.9 ms, and the
// adaptive controller could not trip. The frames themselves know the answer.
//
// What is under test is the part that has to survive a STREAMED headset: a
// reading the mean would ruin, a reading a short window cannot support, and two
// neighbouring refresh rates that a sloppy snap would merge.
describe('the measured refresh (modalHz)', () => {
  /**
   * Feed `n` frames around `hz`, wobbling the interval by ±`spread` of itself.
   *
   * PROPORTIONAL, not a fixed number of milliseconds, and the difference is
   * the reason this helper is commented: a third of a millisecond is 3 % of a
   * 90 Hz frame and 4 % of a 120 Hz one, so a fixed wobble quietly makes the
   * fast case a harder test than the slow one. Expressing it as a fraction
   * means 90, 120 and 72 are the SAME test at three rates, which is what
   * "separable" has to mean.
   */
  const jitter = (
    recorder: ReturnType<typeof createFrameRecorder>,
    hz: number,
    n: number,
    spread = 0.01,
  ) => {
    for (let i = 0; i < n; i++) {
      // Deterministic, not random: a test that fails one run in fifty is worse
      // than no test (and `Math.random` has no place in a fixture either).
      const wobble = (((i % 5) - 2) / 2) * spread
      recorder.frame((1 / hz) * (1 + wobble), 1 / hz)
    }
    return recorder
  }

  it('is zero on an empty window, not NaN and not a guess', () => {
    const m = createFrameRecorder().modalHz()
    expect(m).toEqual({ hz: 0, share: 0, frames: 0, candidates: [] })
  })

  it('reports the top rates, not just the mode — a display AND its tier', () => {
    // DEV-161, scripted from the worn window: 60 % of frames at 22.2 ms
    // (SteamVR's half-rate tier of 90) and 40 % at 11.1. The mode is 45 and the
    // mode is a lie about the display; the PAIR is what a resolver needs, and
    // one number could never have carried it.
    const recorder = createFrameRecorder()
    for (let i = 0; i < 300; i++) recorder.frame(i % 5 < 3 ? 1 / 45 : 1 / 90, 1 / 90)
    const m = recorder.modalHz()
    expect(m.hz).toBe(45)
    const rates = m.candidates.map((c) => c.hz)
    expect(rates).toContain(45)
    expect(rates).toContain(90)
    // Descending by share, and `candidates[0]` is the mode said twice.
    expect(m.candidates[0]?.hz).toBe(m.hz)
    expect(m.candidates[0]?.share).toBeCloseTo(m.share, 9)
    for (let i = 1; i < m.candidates.length; i++) {
      expect(m.candidates[i]?.share).toBeLessThanOrEqual(m.candidates[i - 1]?.share ?? 1)
    }
    // The shares are fractions of the same window, so a clean two-rate window
    // sums to 1. (That is what makes DEV-161's combined-share gate meaningful.)
    expect(m.candidates.reduce((s, c) => s + c.share, 0)).toBeCloseTo(1, 6)
  })

  it('caps the candidate list rather than growing with the scatter', () => {
    // The list is walked once a frame and every entry is an allocation. A
    // window with no refresh rate must not be the expensive case as well as
    // the uninformative one.
    const recorder = createFrameRecorder()
    for (let i = 0; i < 300; i++) recorder.frame(1 / (37 + (i % 9)), 1 / 90)
    expect(recorder.modalHz().candidates.length).toBeLessThanOrEqual(MODAL_CANDIDATES)
  })

  it('leaves the bins clean, so a second read agrees with the first', () => {
    // The candidate walk IS the clearing walk. If it stopped zeroing a bin the
    // counts would accumulate across calls and the second reading of a steady
    // display would have a share above 1 — silently, and only after a while.
    const recorder = createFrameRecorder()
    for (let i = 0; i < 300; i++) recorder.frame(i % 2 === 0 ? 1 / 45 : 1 / 90, 1 / 90)
    const first = recorder.modalHz()
    const second = recorder.modalHz()
    expect(second.candidates).toEqual(first.candidates)
    expect(second.share).toBeCloseTo(first.share, 9)
    expect(second.share).toBeLessThanOrEqual(1)
  })

  it('reads 90 Hz off jittery 90 Hz frames, with a share near 1', () => {
    const m = jitter(createFrameRecorder(), 90, 300).modalHz()
    expect(m.hz).toBe(90)
    expect(m.share).toBeGreaterThan(0.9)
    expect(m.frames).toBeGreaterThan(200)
  })

  it('survives a 250 ms hitch, which is what the MEAN does not', () => {
    // The whole reason this is a mode. 250 frames at 90 Hz plus one 250 ms
    // frame has a mean interval of 12.0 ms — 83 Hz, which is not a refresh
    // rate and would set a budget 8 % too generous for the rest of the run.
    const recorder = createFrameRecorder()
    jitter(recorder, 90, 150)
    recorder.frame(0.25, 1 / 90)
    jitter(recorder, 90, 100)
    const m = recorder.modalHz()
    expect(m.hz).toBe(90)
    expect(m.share).toBeGreaterThan(0.9)
  })

  it('reports how FEW frames it saw, so a caller can refuse the reading', () => {
    // `quality.ts` wants 48 before it believes one. The recorder does not make
    // that decision — it reports what it has, and the threshold lives with the
    // thing that would act on it.
    const m = jitter(createFrameRecorder(), 90, 30).modalHz()
    expect(m.frames).toBe(30)
    expect(m.hz).toBe(90)
  })

  it('separates 72 from 75 — the closest pair anyone actually ships', () => {
    // If the snap were sloppy these two would merge, and 72 vs 75 is a 4 %
    // budget difference on the exact hardware this was written for. This is the
    // one case where "first known rate within tolerance" and "NEAREST known
    // rate within tolerance" disagree, and the first version of `snapRefreshHz`
    // was the former: 74 is inside 3 % of both, so every 75 Hz reading came
    // back 72.
    expect(jitter(createFrameRecorder(), 72, 300).modalHz().hz).toBe(72)
    expect(jitter(createFrameRecorder(), 75, 300).modalHz().hz).toBe(75)
  })

  it('reads the same at 72, 90 and 120 — a fast display is not a harder case', () => {
    // The bug this replaces: binning the RAW `round(1 / dt)` gives a bin per Hz,
    // and at 120 Hz an ordinary wobble moves the raw bin by four — so three
    // hundred frames of a healthy 120 Hz display spread over five equal bins and
    // the mode was whichever filled first (116, on the run that found it).
    for (const hz of [72, 90, 120]) {
      const m = jitter(createFrameRecorder(), hz, 400).modalHz()
      expect(m.hz, `${hz} Hz`).toBe(hz)
      expect(m.share, `${hz} Hz share`).toBeGreaterThan(0.9)
    }
  })

  it('drops its share when the jitter is wider than the snap tolerance', () => {
    // The loud counterpart to the test above, and the honest limit of the
    // method: an interval wobbling ±8 % is not a display with a refresh rate,
    // and this says so with a low share instead of naming one. `quality.ts`
    // then falls back and labels the budget `default`.
    const m = jitter(createFrameRecorder(), 90, 400, 0.16).modalHz()
    expect(m.share).toBeLessThan(0.6)
  })

  it('reports a LOW share when the window is scattered, not a confident wrong number', () => {
    // A machine hitching through a chunk band: the mode is still a real bin, but
    // most of the window disagrees with it. `quality.ts` refuses this and falls
    // back, and the fallback is labelled `default` so the reading is visible as
    // a guess.
    const recorder = createFrameRecorder({ windowSeconds: 3 })
    for (let i = 0; i < 240; i++) recorder.frame((8 + (i % 40)) / 1000, 1 / 90)
    const m = recorder.modalHz()
    expect(m.share).toBeLessThan(0.6)
  })

  it('does not accumulate across calls — the bins are cleared, not memset', () => {
    // The clear walks only the bins it touched, so the obvious failure is a
    // stale count surviving into the next call and pinning the mode for ever.
    const recorder = createFrameRecorder()
    jitter(recorder, 120, 400)
    expect(recorder.modalHz().hz).toBe(120)
    recorder.reset()
    jitter(recorder, 72, 250)
    expect(recorder.modalHz().hz).toBe(72)
    expect(recorder.modalHz().hz).toBe(72)
  })
})

describe('snapRefreshHz', () => {
  it('snaps each known rate to itself', () => {
    for (const hz of KNOWN_REFRESH_HZ) expect(snapRefreshHz(hz)).toBe(hz)
  })

  it('pulls a near miss in, and leaves a genuine oddity alone', () => {
    expect(snapRefreshHz(89.4)).toBe(90)
    expect(snapRefreshHz(71.2)).toBe(72)
    expect(snapRefreshHz(121.5)).toBe(120)
    // A machine at 48 Hz under load is TELLING THE TRUTH. Rounding it to 60
    // would hand the controller a budget it can never meet and no way to say
    // why — the same argument the recorder makes for not clamping a hitch.
    expect(snapRefreshHz(48)).toBe(48)
    expect(snapRefreshHz(33)).toBe(33)
  })

  it('is 0 for a rate that is not one', () => {
    expect(snapRefreshHz(0)).toBe(0)
    expect(snapRefreshHz(-90)).toBe(0)
    expect(snapRefreshHz(Number.NaN)).toBe(0)
  })
})

// ── A hitch is against the TIER; the tier share against the DISPLAY ───────
//
// DEV-179. Lap 4 was a 90 Hz display with SteamVR holding the app at 30, and
// the hitch column — judged, as it had always been, against the display —
// reported **73 % of 2,364 frames**. A column saying three frames in four are a
// hitch is not a hitch report: every one of those frames arrived exactly when
// the compositor had asked for it, and what was actually wrong was the tier we
// were in. Two thresholds over one delta, and they answer different questions.
describe('the tier and the hitch', () => {
  /** A 90 Hz display, and the 30 Hz tier SteamVR held lap 4 in. */
  const DISPLAY = 1 / 90
  const TIER = 1 / 30

  /**
   * Lap 4's pacing: frames at the tier, with jitter, because a sequence of one
   * number repeated tests a constant rather than a rule. ±6 % is inside what a
   * streamed headset puts on an interval.
   */
  const tierPaced = (n: number): number[] =>
    Array.from({ length: n }, (_, i) => TIER * (1 + ((i % 7) - 3) * 0.02))

  it('reads a lap held at 30 on a 90 Hz display as no hitches and all tier', () => {
    const recorder = createFrameRecorder({ windowSeconds: 60 })
    for (const dt of tierPaced(400)) recorder.frame(dt, DISPLAY, 0, TIER)
    const stats = recorder.stats()
    // Nothing missed the rate it was given...
    expect(stats.hitches).toBe(0)
    expect(stats.hitchFraction).toBe(0)
    // ...and not one frame of it was shown at the display's rate.
    expect(stats.tierFrames).toBe(400)
    expect(stats.tierFraction).toBe(1)
    // The two thresholds, printed, so a reader can tell them apart without
    // doing the division.
    expect(stats.targetMs).toBeCloseTo(DISPLAY * 1000, 9)
    expect(stats.tierMs).toBeCloseTo(TIER * 1000, 9)
  })

  it('is the SAME sequence the old column called nothing but hitches', () => {
    // THE CONTROL, and the test above says nothing without it. Fed the
    // display's interval as its own tier — which is what every caller did
    // before DEV-179 and what the three-argument call still means — the
    // identical lap reads as a broken frame loop. Neither reading is wrong
    // arithmetic; they are answers to two different questions, and only one of
    // them is the question the word "hitch" asks.
    const recorder = createFrameRecorder({ windowSeconds: 60 })
    for (const dt of tierPaced(400)) recorder.frame(dt, DISPLAY)
    expect(recorder.stats().hitchFraction).toBe(1)
  })

  it('agrees with a lap that counted its own tiered frames', () => {
    // The property, over a mixed lap rather than a single rate: SteamVR moved
    // between its 45 and 30 Hz tiers as our GPU crossed ~11 ms, and six frames
    // out of 2,364 made 90. The test scripts which frames it means to be tiered
    // and counts them ITSELF; the recorder derives the same number from the
    // deltas and a threshold. Two routes, one answer — and neither is this file
    // re-running the recorder's arithmetic (CLAUDE.md trap 24).
    const recorder = createFrameRecorder({ windowSeconds: 60 })
    let scriptedTier = 0
    for (let i = 0; i < 600; i++) {
      // Six in 600 at the display's rate, a third at half, the rest at a third.
      const rate = i % 100 === 0 ? 90 : i % 3 === 0 ? 45 : 30
      const dt = (1 / rate) * (1 + ((i % 5) - 2) * 0.02)
      if (rate < 90) scriptedTier += 1
      recorder.frame(dt, DISPLAY, 0, 1 / rate)
    }
    const stats = recorder.stats()
    expect(stats.frames).toBe(600)
    expect(stats.tierFrames).toBe(scriptedTier)
    expect(stats.tierFraction).toBeCloseTo(scriptedTier / 600, 9)
    // Every frame arrived on the rate it was given, so the hitch column is
    // quiet — which is the sentence the pair now makes: the frame COST is the
    // problem, not the frame PACING.
    expect(stats.hitches).toBe(0)
  })

  it('still finds a frame that missed even the tier', () => {
    // The hitch has to keep meaning something, or the row has traded one
    // useless column for another. A 100 ms frame inside a 30 Hz tier is three
    // tier intervals and is felt in a headset exactly as before.
    const recorder = createFrameRecorder({ windowSeconds: 60 })
    for (const dt of tierPaced(99)) recorder.frame(dt, DISPLAY, 0, TIER)
    recorder.frame(TIER * (HITCH_BUDGETS + 1), DISPLAY, 0, TIER)
    const stats = recorder.stats()
    expect(stats.hitches).toBe(1)
    expect(stats.tierFrames).toBe(100)
  })

  it('leaves a machine that is keeping up with BOTH columns at zero', () => {
    // The lap everybody is trying to produce, and the only one where the pair
    // is allowed to be quiet.
    const recorder = createFrameRecorder({ windowSeconds: 60 })
    for (let i = 0; i < 400; i++) {
      recorder.frame(DISPLAY * (1 + ((i % 7) - 3) * 0.02), DISPLAY, 0, DISPLAY)
    }
    const stats = recorder.stats()
    expect(stats.hitches).toBe(0)
    expect(stats.tierFrames).toBe(0)
    expect(stats.tierFraction).toBe(0)
  })

  it('means exactly what it always meant when the tier is left out', () => {
    // The compatibility property, as a property rather than as one example:
    // over a scripted sequence of ordinary frames, the three-argument call and
    // the four-argument call with the DISPLAY as the tier must agree on every
    // number the old callers read. `render-census.spec.ts` and every other
    // existing feed is the three-argument shape.
    const script = Array.from({ length: 300 }, (_, i) =>
      i % 37 === 0 ? 0.08 : i % 11 === 0 ? 0.03 : DISPLAY * (1 + (i % 9) * 0.01),
    )
    const three = createFrameRecorder({ windowSeconds: 60 })
    const four = createFrameRecorder({ windowSeconds: 60 })
    for (const dt of script) {
      three.frame(dt, DISPLAY)
      four.frame(dt, DISPLAY, 0, DISPLAY)
    }
    const a = three.stats()
    const b = four.stats()
    expect(a.hitches).toBe(b.hitches)
    expect(a.hitchFraction).toBe(b.hitchFraction)
    expect(a.tierFrames).toBe(b.tierFrames)
    expect(a.tierMs).toBe(b.tierMs)
  })

  it('judges each frame against the tier that was in force for THAT frame', () => {
    // The tier moves during a run — that is the whole reason it is fed per
    // frame rather than stamped once. 50 ms is a hitch inside a 45 Hz tier
    // (2 x 22.2 = 44.4) and is not one inside a 30 Hz tier (2 x 33.3 = 66.7).
    // The same frame, twice, and only one of them counts — `perf-recorder.ts`
    // already makes this argument about the budget one line up.
    const recorder = createFrameRecorder({ windowSeconds: 60 })
    recorder.frame(0.05, DISPLAY, 0, 1 / 45)
    recorder.frame(0.05, DISPLAY, 0, 1 / 30)
    expect(recorder.stats().hitches).toBe(1)
    // Both were tier frames, whatever their hitch verdict: neither was shown at
    // the display's rate.
    expect(recorder.stats().tierFrames).toBe(2)
  })
})
