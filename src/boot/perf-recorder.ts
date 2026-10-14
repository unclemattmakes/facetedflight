// @engine-layer: imports nothing from game, content, generated or boot/app (tests/unit/engine-layering-guard.test.ts)
// src/boot/perf-recorder.ts — what the last few seconds of frames actually did.
//
// ANNIVERSARY.md §4.3: *"There is adaptive resolution and an engaged-frames
// counter (DEV-058) but no way to SEE frame time, draw calls and triangles in
// the running game."* This is the seeing half's data source; `perf-hud.ts` is
// its display. The pattern is king-tide's `engine/perf-recorder.ts` — a ring of
// per-frame deltas, Three-free and DOM-free so it is a plain unit test — with
// three differences that matter here and are written down rather than inherited:
//
//  1. **The window is SECONDS, not samples.** King-tide keeps a 600-sample ring
//     and reports over whatever is in it, so its "p95" covers 10 s at 60 fps and
//     4 s at 144. A budget is a number per second, so the window has to be one
//     too, or the same reading means different things on two machines — and the
//     machines this has to compare are a 144 Hz monitor and a 72 Hz Quest.
//  2. **The engaged count is READ, never recomputed.** `render/quality.ts` owns
//     the definition of "adaptive resolution stepped down" (DEV-058's counter,
//     M3's 20 % exit criterion). This takes that CUMULATIVE counter and stores
//     the per-frame delta, so there is exactly one place that decides what
//     engaged means. Same reason this does not smooth frame time: quality.ts
//     already keeps an EMA, tuned, with an outlier clamp and a documented
//     recovery rule. Two smoothers disagreeing is a bug nobody can see.
//  3. **Nothing is clamped.** quality.ts clamps a 10-second frame to 250 ms
//     because it is a controller and a stall is not a measurement of rendering
//     cost. This is a RECORDER: a 10-second frame is the single most important
//     thing that happened, and hiding it would defeat the whole overlay. The
//     consequence is worth knowing — one frame longer than the window empties
//     the window down to that one frame, and the panel then honestly reads
//     "1 frame in the last 3 seconds".
//
// Feeding is O(1) and allocation-free: the ring and the sort scratch are
// allocated once, at construction. `stats()` sorts, so it is O(n log n) and is
// called at the panel's refresh rate (a few Hz), never per frame — `perf-hud.ts`
// answers `isVisible()` so a hidden panel costs one `frame()` call and nothing
// else.

/**
 * How far back a reading looks, seconds.
 *
 * Three is a compromise between two failure modes. Shorter and p95 is computed
 * from too few samples to mean anything at 72 Hz (3 s is ~216 frames, so the
 * 95th is the 11th-worst — a real tail, not one unlucky frame). Longer and the
 * panel stops reacting while you fly past the thing that cost the frame, which
 * is the entire use: you are looking for WHERE it gets expensive, not for an
 * average of the lap.
 */
export const DEFAULT_WINDOW_SECONDS = 3

/**
 * A frame is a hitch when it took more than this many budgets.
 *
 * Two, per ANNIVERSARY.md §4.3's brief, and the reasoning is the comfort one
 * (R12, DEV-058): a frame that misses its deadline by a whole extra frame is a
 * frame the compositor had to reproject, which in a headset during a fast roll
 * is felt rather than seen. King-tide's fixed 33.4 ms threshold is the same idea
 * pinned to 60 Hz; expressed in budgets it follows the headset's own frame rate,
 * which is 72, 90 or 120 depending on what the player set.
 *
 * DEV-179: the budget it is two OF is the TIER's, not the display's. See
 * `FrameRecorder.frame`.
 */
export const HITCH_BUDGETS = 2

/**
 * How many DISPLAY intervals a frame must take to be a tier frame. DEV-179.
 *
 * 1.5 — the midpoint between arriving on time and arriving on the half-rate
 * tier. A compositor's lowest tier is 2x the display's interval (`TIER_DIVISORS`
 * in `render/quality.ts` is half rate and third rate), so a frame past 1.5
 * intervals is nearer the tier than the display and cannot have been presented
 * at the display's rate.
 *
 * Why a midpoint and not "at least 2x, exactly": 45 Hz is not in
 * `KNOWN_REFRESH_HZ`, a streamed headset's intervals jitter either side of the
 * tier, and a threshold sitting exactly ON the boundary would count half of a
 * steady half-rate lap and miss the other half. Why not lower: a frame that ran
 * 20 % long is late, not tiered, and the hitch column already has an opinion
 * about it.
 *
 * Deliberately a LOCAL constant rather than an import from `render/quality.ts`.
 * Nothing in this file may depend on the renderer — that is the property that
 * makes it a plain node test — and 1.5 is not `TIER_DIVISORS`; it is derived
 * from them, once, here.
 */
export const TIER_FRAME_INTERVALS = 1.5

/**
 * Ring capacity, in samples.
 *
 * 240 Hz x the window, so the ring holds a full window on any display anyone
 * will plug in and the oldest sample in it is genuinely older than the window.
 * At 72 Hz it is three times larger than it needs to be, which costs 9 KB.
 */
export const DEFAULT_CAPACITY = DEFAULT_WINDOW_SECONDS * 240

export interface FrameStats {
  /** Frames inside the window. `0` before the first frame. */
  readonly frames: number
  /** Wall seconds the window actually spans — at most `windowSeconds`. */
  readonly seconds: number
  /** `frames / seconds`. `0` on an empty buffer, never `NaN` or `Infinity`. */
  readonly fps: number
  readonly meanMs: number
  readonly p50Ms: number
  readonly p95Ms: number
  readonly maxMs: number
  /**
   * Frames over `HITCH_BUDGETS` x the TIER's interval, counted in the window.
   *
   * The tier's, not the display's, since DEV-179 — and the difference is the
   * whole of what that row is about. Lap 4 was a 90 Hz display with SteamVR
   * holding the app at 30, so every frame of it was 33.3 ms against an 11.1 ms
   * display budget and **73 % of the lap read as a hitch**. A column that says
   * three frames in four is a hitch is not reporting a hitch; it is reporting
   * the tier, which `tierFraction` below now does on purpose. What is left here
   * is the thing the word means: a frame that missed even the rate the
   * compositor had already dropped us to.
   */
  readonly hitches: number
  /** Those as a fraction of the window's frames. `0` when there are none. */
  readonly hitchFraction: number
  /**
   * Frames that took at least `TIER_FRAME_INTERVALS` of the DISPLAY's interval
   * — i.e. frames the compositor could not present at the display's rate.
   *
   * The other half of DEV-179's pair, and the number that makes the first one
   * readable: `hitch 1 % · tier 73 %` says *the app is pinned in a reprojection
   * tier and is holding that tier steadily*, which is a completely different
   * report from `hitch 73 %` and is the true one. A lap where both are low is
   * the only lap that is actually fine.
   */
  readonly tierFrames: number
  /** Those as a fraction of the window's frames. `0` when the app is keeping up. */
  readonly tierFraction: number
  /**
   * Frames in the window that adaptive resolution spent below full resolution.
   *
   * Differenced from `render/quality.ts`'s own counter, never recomputed here.
   * `0` when adaptive resolution is off, which is the honest answer: a
   * controller that is not running has not engaged.
   */
  readonly engagedFrames: number
  /** Those as a fraction of the window's frames. M3's 20 % criterion, windowed. */
  readonly engagedFraction: number
  /** The budget the most recent frame was judged against, ms. `0` before it. */
  readonly targetMs: number
  /**
   * The TIER's interval the most recent frame's hitch was judged against, ms.
   *
   * Equal to `targetMs` on a machine keeping up, and on every caller that has
   * not passed a tier — see `FrameRecorder.frame`. Printed beside the hitch so
   * a reader can tell the two thresholds apart without doing the division.
   */
  readonly tierMs: number
}

/**
 * Refresh rates a display might actually be running at.
 *
 * VR-PERF §5.3 / DEV-160. A measurement constant, in `boot/` and not a sim
 * number: none of these came out of the Unity project and none of them is a
 * fact about Faceted Flight. It is the set of rates a panel or a compositor is
 * built to drive, and its only job is to turn a measured 89.7 into 90 rather
 * than into a budget of 11.15 ms that no two readings agree on.
 *
 * 72 / 80 / 90 / 120 / 144 are the Steam Frame's; 60 / 75 / 100 / 110 / 165 /
 * 240 are monitors, because the flat build is measured on this same code.
 */
export const KNOWN_REFRESH_HZ: readonly number[] = [
  60, 72, 75, 80, 90, 100, 110, 120, 144, 165, 240,
]

/**
 * Tolerance for snapping a measured rate to a known one, as a fraction.
 *
 * 3 % is the gap that separates the CLOSEST pair in the list — 72 and 75 are
 * 4.2 % apart — so a reading can never be snapped to the wrong one of those
 * two. Wide enough to absorb a streamed headset's jitter, narrow enough that
 * the neighbours stay distinguishable, which is the whole property that
 * matters: the budget it produces is the difference between a p95 of 13 ms
 * being a pass and a fail.
 */
export const REFRESH_SNAP_TOLERANCE = 0.03

/**
 * The highest per-frame rate `modalHz()` will bin. Anything faster lands here.
 *
 * 1,000 Hz is four times the fastest display anyone sells and is only reachable
 * at all by two frames stamped at the same sub-millisecond, which is a clock
 * artefact rather than a frame rate. Its only job is to bound the bin array.
 */
export const MAX_MEASURED_HZ = 1000

/**
 * How many distinct rates `modalHz()` reports besides the mode.
 *
 * DEV-161. Four, because the thing a resolver has to recognise is a display and
 * up to two of a compositor's sub-rates (90 with 45 and 30) plus one bin of
 * scatter — and because every entry costs an object on a path that runs once a
 * frame. Beyond four the tail is noise: a window whose fifth-largest bin
 * matters does not have a refresh rate, it has a problem, and `share` already
 * says so.
 */
export const MODAL_CANDIDATES = 4

/** One rate present in the window, and how much of it read that way. */
export interface HzCandidate {
  readonly hz: number
  readonly share: number
}

export interface ModalHz {
  /** The most common SNAPPED rate in the window. 0 on an empty one. See `binOf`. */
  readonly hz: number
  /** Fraction of the window's frames that read as that rate. 0 when there are none. */
  readonly share: number
  /** Frames the reading was taken over. */
  readonly frames: number
  /**
   * The top `MODAL_CANDIDATES` rates in the window, by share, descending.
   * `candidates[0]` is always the mode, so `hz` and `share` are the same
   * numbers said twice — kept because every existing caller reads them.
   *
   * DEV-161, and it comes straight out of the worn session: the mode alone
   * cannot tell a 45 Hz DISPLAY from a 90 Hz display we are hitting every
   * other frame of, and those two want opposite budgets. The first reads
   * 22.2 ms and declares us comfortable; the second reads 11.1 and declares us
   * 40 % over, which is the true statement. One number could never separate
   * them; the pair can, because SteamVR's tiers are exact halves and thirds.
   */
  readonly candidates: readonly HzCandidate[]
}

/**
 * Snap a measured rate to a known refresh, or leave it alone.
 *
 * Returns the raw rate when nothing is close, rather than the nearest entry:
 * a machine running at 48 Hz under load is telling the truth, and rounding it
 * to 60 would hand the adaptive controller a budget it can never meet and no
 * way to say why.
 *
 * NEAREST within tolerance, not the first match — and that is not a nicety.
 * The tolerance bands OVERLAP where the list is dense: 74 Hz is inside 3 % of
 * 72 (2.16) *and* inside 3 % of 75 (2.25), so a first-match loop in ascending
 * order sent every reading of a 75 Hz display to 72. Found by the test that
 * asked for the closest pair anyone ships to be separable, which is the one
 * case where first-match and nearest disagree.
 */
export const snapRefreshHz = (hz: number): number => {
  if (!Number.isFinite(hz) || hz <= 0) return 0
  let best = hz
  let bestDistance = Number.POSITIVE_INFINITY
  for (const known of KNOWN_REFRESH_HZ) {
    const distance = Math.abs(hz - known)
    if (distance <= known * REFRESH_SNAP_TOLERANCE && distance < bestDistance) {
      bestDistance = distance
      best = known
    }
  }
  return best
}

export interface FrameRecorder {
  /**
   * One RENDERED frame. Call once, after the render, with the frame's own
   * numbers.
   *
   * @param frameSeconds  that frame's wall delta — `app.ts`'s `frameSeconds`.
   * @param targetSeconds the budget in force, `1 / displayHz`. The DISPLAY's
   *   interval — what the app has to get under to leave a compositor's tier.
   *   See `render/quality.ts`; `tierFraction` is measured against this.
   * @param engagedFrames `render/quality.ts`'s CUMULATIVE engaged-frame counter
   *   (`QualityReport.engagedFrames`). The delta between calls is what is
   *   stored, so this recorder never decides what "engaged" means.
   * @param tierSeconds `1 / tierHz` — the rate frames are actually ARRIVING at
   *   (`QualityReport.tierHz`), which is what a hitch is judged against since
   *   DEV-179. **Defaults to `targetSeconds`**, so the three-argument call this
   *   shipped with keeps the behaviour it has always had: on a machine keeping
   *   up the display and the tier are the same number, and the default is that
   *   case written down.
   */
  frame(
    frameSeconds: number,
    targetSeconds: number,
    engagedFrames?: number,
    tierSeconds?: number,
  ): void
  /** Read the window. Allocates; call it at a panel's rate, not a frame's. */
  stats(): FrameStats
  /**
   * What refresh the frames are actually arriving at — the MODE of the window.
   *
   * VR-PERF §5.3, gap 10. `render/quality.ts` judges every frame against
   * `session.frameRate`, which is Meta's extension: on this desktop's Chromium
   * it is not even on `XRSession.prototype` (probed 2026-09-16), so a Frame
   * running at 90 or 120 Hz is judged against 72 and the controller never
   * trips. The frames themselves know the answer, and nothing was asking them.
   *
   * The MODE rather than the mean, because the mean is what a hitch ruins: one
   * 250 ms frame in a 3 s window pulls a 90 Hz mean down to ~83, and 83 is not
   * a refresh rate. The mode is unmoved by any number of outliers as long as
   * most frames are on time, which is the condition under which asking the
   * question is meaningful at all.
   *
   * `share` is how much of the window agrees, so a caller can refuse the
   * reading rather than act on a guess: a window that is 40 % 90 Hz and 60 %
   * scattered is a machine in trouble, not a 90 Hz machine.
   */
  modalHz(): ModalHz
  /** Throw the window away — a restart, or a new mission. */
  reset(): void
  /** Samples the ring can hold. Fixed for the recorder's life. */
  readonly capacity: number
  /** The window, seconds. Fixed for the recorder's life. */
  readonly windowSeconds: number
}

export interface FrameRecorderOptions {
  readonly windowSeconds?: number
  readonly capacity?: number
}

/** One shared empty list, so an idle `modalHz()` allocates nothing at all. */
const EMPTY_CANDIDATES: readonly HzCandidate[] = Object.freeze([])

const EMPTY: FrameStats = {
  frames: 0,
  seconds: 0,
  fps: 0,
  meanMs: 0,
  p50Ms: 0,
  p95Ms: 0,
  maxMs: 0,
  hitches: 0,
  hitchFraction: 0,
  tierFrames: 0,
  tierFraction: 0,
  engagedFrames: 0,
  engagedFraction: 0,
  targetMs: 0,
  tierMs: 0,
}

export const createFrameRecorder = (options: FrameRecorderOptions = {}): FrameRecorder => {
  const windowSeconds =
    options.windowSeconds && options.windowSeconds > 0
      ? options.windowSeconds
      : DEFAULT_WINDOW_SECONDS
  const capacity = Math.max(1, Math.floor(options.capacity ?? DEFAULT_CAPACITY))

  // Allocated once. Everything `frame()` touches is one of these.
  const deltas = new Float64Array(capacity)
  /** Was this frame a hitch? Decided at feed time, against THAT frame's TIER. */
  const hitches = new Uint8Array(capacity)
  /** Did this frame arrive in a tier? Decided against THAT frame's DISPLAY interval. */
  const tiered = new Uint8Array(capacity)
  /** Did quality.ts's engaged counter advance on this frame? */
  const engaged = new Uint8Array(capacity)
  /** Sort scratch for the percentiles. Reused; `stats()` fills the prefix. */
  const scratch = new Float64Array(capacity)
  /**
   * Bins for `modalHz()`, allocated once. 4 KB, indexed by `round(1 / dt)`.
   *
   * Cleared by `modalHz` itself, walking only the bins it touched rather than
   * all 1,001 — because `render/quality.ts` reads the budget on every frame and
   * an instrument that memsets 4 KB twice a frame is spending more than the
   * thing it measures.
   */
  const bins = new Int32Array(MAX_MEASURED_HZ + 1)

  let head = 0
  let count = 0
  let lastEngagedCumulative = -1
  let targetSeconds = 0
  let tierSeconds = 0

  return {
    capacity,
    windowSeconds,

    frame(frameSeconds, target, engagedCumulative = 0, tier) {
      // A non-finite delta is not a slow frame, it is a broken clock — and one
      // of them poisons the mean, the max and every percentile for a whole
      // window. Dropped rather than clamped, because there is no honest value
      // to clamp it TO.
      if (!Number.isFinite(frameSeconds) || frameSeconds < 0) return
      if (Number.isFinite(target) && target > 0) targetSeconds = target
      // The tier DEFAULTS to the display, which is both the three-argument
      // caller's old behaviour and the truth on a machine keeping up. An
      // unusable tier falls back the same way rather than to the last good one:
      // a stale tier is a hitch threshold from a frame that is no longer on
      // screen, and there is a correct answer available right here.
      tierSeconds = tier !== undefined && Number.isFinite(tier) && tier > 0 ? tier : targetSeconds

      // The DELTA of quality.ts's counter, floored at zero so a reset over
      // there (a new controller, a reload) reads as "no engaged frames" rather
      // than as a negative one. First call has no previous, so it contributes
      // nothing: there is no frame before the first frame.
      const previous = lastEngagedCumulative
      lastEngagedCumulative = engagedCumulative
      const stepped = previous >= 0 && engagedCumulative > previous

      deltas[head] = frameSeconds
      // Two thresholds over one delta, and they answer different questions.
      // The HITCH is against the tier: did this frame miss even the rate the
      // compositor has already dropped us to? The TIER FLAG is against the
      // display: was this frame presented at the display's rate at all? On a
      // machine keeping up they collapse into one another, which is why the
      // three-argument call still means what it always meant.
      hitches[head] = tierSeconds > 0 && frameSeconds > tierSeconds * HITCH_BUDGETS ? 1 : 0
      tiered[head] =
        targetSeconds > 0 && frameSeconds >= targetSeconds * TIER_FRAME_INTERVALS ? 1 : 0
      engaged[head] = stepped ? 1 : 0
      head = (head + 1) % capacity
      if (count < capacity) count += 1
    },

    stats() {
      if (count === 0) return EMPTY

      // Walk BACKWARDS from the newest frame, taking frames until the window is
      // full. That is what makes the window seconds rather than samples, and it
      // is why nothing has to be evicted at feed time: an old sample is still in
      // the ring, it is simply behind the horizon and never read.
      //
      // At least one frame is always taken, so a single frame longer than the
      // whole window reports itself rather than reporting nothing.
      let seconds = 0
      let taken = 0
      let hitchCount = 0
      let tierCount = 0
      let engagedCount = 0
      let maxSeconds = 0
      for (let i = 0; i < count; i++) {
        const at = (head - 1 - i + capacity * 2) % capacity
        const dt = deltas[at] as number
        scratch[taken] = dt
        taken += 1
        seconds += dt
        if (dt > maxSeconds) maxSeconds = dt
        if (hitches[at] === 1) hitchCount += 1
        if (tiered[at] === 1) tierCount += 1
        if (engaged[at] === 1) engagedCount += 1
        if (seconds >= windowSeconds) break
      }

      const view = scratch.subarray(0, taken)
      view.sort()
      const meanSeconds = seconds / taken
      return {
        frames: taken,
        seconds,
        // Guarded: two frames stamped at the same millisecond give a zero mean,
        // and `1 / 0` on a perf panel reads as "Infinity fps", which is the kind
        // of number that gets screenshotted and believed.
        fps: meanSeconds > 0 ? 1 / meanSeconds : 0,
        meanMs: meanSeconds * 1000,
        p50Ms: percentile(view, 0.5) * 1000,
        p95Ms: percentile(view, 0.95) * 1000,
        maxMs: maxSeconds * 1000,
        hitches: hitchCount,
        hitchFraction: hitchCount / taken,
        tierFrames: tierCount,
        tierFraction: tierCount / taken,
        engagedFrames: engagedCount,
        engagedFraction: engagedCount / taken,
        targetMs: targetSeconds * 1000,
        tierMs: tierSeconds * 1000,
      }
    },

    modalHz() {
      if (count === 0) return { hz: 0, share: 0, frames: 0, candidates: EMPTY_CANDIDATES }

      // The same backward walk `stats()` makes, for the same reason: the window
      // is SECONDS, so the frames it covers are however many arrived in the last
      // three of them.
      let seconds = 0
      let taken = 0
      let best = 0
      let bestBin = 0
      for (let i = 0; i < count; i++) {
        const at = (head - 1 - i + capacity * 2) % capacity
        const dt = deltas[at] as number
        taken += 1
        seconds += dt
        const bin = binOf(dt)
        if (bin > 0) {
          const n = (bins[bin] as number) + 1
          bins[bin] = n
          if (n > best) {
            best = n
            bestBin = bin
          }
        }
        if (seconds >= windowSeconds) break
      }

      // Clear only what was touched, by re-walking the same frames. A second
      // visit to a bin reads 0 and is skipped, so this is exact — and that
      // property is what lets the SAME walk collect the candidates: the first
      // visit to a bin is the only one that sees a non-zero count, so each
      // distinct rate is offered to `topRates` exactly once (DEV-161).
      const top: { hz: number; n: number }[] = []
      let cleared = 0
      let secondsAgain = 0
      for (let i = 0; i < count && cleared < taken; i++) {
        const at = (head - 1 - i + capacity * 2) % capacity
        const dt = deltas[at] as number
        cleared += 1
        secondsAgain += dt
        const bin = binOf(dt)
        const n = bins[bin] as number
        if (n > 0) {
          bins[bin] = 0
          // Insertion into a list that is at most four long: cheaper than a
          // sort, and bounded, which is the property that matters on a path
          // that runs once a frame.
          let at2 = top.length
          while (at2 > 0 && (top[at2 - 1] as { n: number }).n < n) at2 -= 1
          if (at2 < MODAL_CANDIDATES) {
            top.splice(at2, 0, { hz: bin, n })
            if (top.length > MODAL_CANDIDATES) top.pop()
          }
        }
        if (secondsAgain >= windowSeconds) break
      }

      if (bestBin === 0) return { hz: 0, share: 0, frames: taken, candidates: EMPTY_CANDIDATES }

      // `share` is the mode's OWN count over the window, which it can be because
      // the bins are snapped rates: every frame that read as this display is in
      // this bin. It falls when the intervals scatter — a machine hitching, or a
      // stream whose jitter is wider than the snap tolerance — and that is what
      // `render/quality.ts`'s threshold refuses. A refused reading is not a
      // disaster: it is labelled `default` and visible as a guess.
      return {
        hz: bestBin,
        share: best / taken,
        frames: taken,
        // The allocation this costs, stated rather than hidden: one array and
        // at most four two-field objects, once a frame. `stats()` above already
        // allocates and SORTS, and the trace's fifteen-float feed — the thing
        // VR-PERF gap 27 is actually about — still allocates nothing. A budget
        // that cannot see a compositor's half-rate tier is worth more than five
        // short-lived objects.
        candidates: top.map((t) => ({ hz: t.hz, share: t.n / taken })),
      }
    },

    reset() {
      head = 0
      count = 0
      lastEngagedCumulative = -1
      targetSeconds = 0
      tierSeconds = 0
    },
  }
}

/**
 * The bin a frame delta falls in: its rate, SNAPPED, clamped into the array.
 *
 * Snapped BEFORE binning, and this is the whole of why `modalHz` works. The
 * brief bins the raw `round(1 / dt)`, which is a bin per Hz — and a Hz is a
 * finer distinction than any real display delivers. At 120 Hz a wobble of a
 * third of a millisecond moves the raw bin by four, so three hundred frames of
 * a perfectly ordinary 120 Hz display spread across five bins with equal
 * counts and the "mode" was whichever one happened to reach its count first:
 * 116, on the run that found this. Snapping first puts all five in the 120 bin,
 * which is the answer the display would have given if it had been asked.
 *
 * A rate near nothing in the list keeps its own integer bin, so an unrecognised
 * or unstable rate fragments — and reads as a low `share`, which is the honest
 * report of a machine that does not have a steady refresh.
 */
const binOf = (dt: number): number => {
  if (!(dt > 0) || !Number.isFinite(dt)) return 0
  const hz = Math.round(snapRefreshHz(1 / dt))
  return hz < 1 ? 0 : hz > MAX_MEASURED_HZ ? MAX_MEASURED_HZ : hz
}

/**
 * Linear-interpolated percentile over a SORTED view. `q` in [0, 1].
 *
 * Interpolated rather than nearest-rank so a 3-frame window does not report its
 * p95 as its maximum — which is true of nearest-rank and reads as a panel that
 * cannot tell a tail from an outlier.
 */
export const percentile = (sorted: Float64Array, q: number): number => {
  const n = sorted.length
  if (n === 0) return 0
  if (n === 1) return sorted[0] as number
  const pos = q * (n - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  const a = sorted[lo] as number
  if (lo === hi) return a
  const b = sorted[hi] as number
  return a + (b - a) * (pos - lo)
}
