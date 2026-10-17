// src/render/eye-scale.ts: the controller that moves the eye buffer's scale
// in a headset, on the signal the worn traces showed. DEV-996.
//
// ── What it reads, and why not our own timer ─────────────────────────────
//
// Six worn traces (`docs/plan/eval-wave/eval-frame-trace.md`) put the missed
// frames in Chrome's `XRCompositing`, which waits for OUR frame's GPU work to
// really finish, and that wait scales with the eye's pixels (`quality=low`
// halved it). Our in-page GPU timer cannot see the part that grows (the MSAA
// resolve and the fill after its bracket), so a controller deciding on it
// would sit still while frames drop. What the misses DO show up in is the
// period between XR animation frames: a frame that missed the display's vsync
// arrives one display frame late, 27.8 ms instead of 13.9 at 72 Hz. That is
// the presented-frame signal, and it is the only thing this file decides on:
// a frame period over `MISS_FACTOR` times the display's period is a miss.
//
// ── The rules ────────────────────────────────────────────────────────────
//
//  * DOWN fast: `DOWN_MISSES` misses inside `DOWN_WINDOW_FRAMES` steps the
//    scale one step down. A single late frame is not a burst.
//  * UP slowly: a clean stretch (at most `UP_MAX_MISSES` misses) of
//    `UP_CLEAN_FRAMES` times the back-off steps one step up.
//  * Hysteresis: a step down within `PROBATION_FRAMES` of a step up doubles the
//    clean stretch the next climb needs (up to `UP_BACKOFF_MAX`); an up that
//    survives its probation halves it again. So a scale that cannot hold is
//    not retried every few seconds.
//  * Never more than one change per `HOLD_FRAMES`, and every window is longer
//    than nothing: the burst window is shorter than the hold, so each step is
//    decided on misses taken AT the scale in force.
//  * A period past `STALL_FACTOR` display periods is not a miss: it is a
//    compile, a hidden session or a stalled tab, and fewer pixels cannot
//    shorten it. It is ignored, as are the first `GRACE_FRAMES` of a session.
//
// Pure: no three, no DOM, no clock. `render/eye-buffer.ts` feeds it one frame
// period at a time, and `tests/unit/eye-scale.test.ts` replays the worn
// traces' recorded periods through it.

/** The scales the controller walks, highest first. Coarse on purpose (`quality.ts` ADAPTIVE_STEPS). */
export const EYE_SCALE_STEPS: readonly number[] = [1, 0.9, 0.8, 0.7]

/** The layer's own size. The eye buffer never renders more pixels than three's XR target. */
export const EYE_SCALE_CEILING = 1

/**
 * The lowest the controller goes: 0.7 of the tier's eye, about 1134 px on the
 * Steam Frame at `medium` (1620). `quality=low` is 0.7 of `high`'s 2160, so
 * this is the same softness step the worn A/B already looked at, once more.
 */
export const EYE_SCALE_FLOOR = 0.7

/**
 * The lowest scale a PIN takes (`?eyeScale=`, `__ff2.eyeBuffer(s)`), below the
 * controller's floor so an A/B can look past it. Lower than this is a typo.
 */
export const EYE_SCALE_PIN_MIN = 0.5

/** A frame period over this many display periods is a missed frame. The trace's own cut. */
export const MISS_FACTOR = 1.5

/** Past this many display periods a frame is a stall, not a miss (see the header). */
export const STALL_FACTOR = 4

/** The burst: this many misses inside `DOWN_WINDOW_FRAMES` frames steps down. */
export const DOWN_MISSES = 3

/** Half a second at 72 Hz. */
export const DOWN_WINDOW_FRAMES = 36

/** No two changes closer than this: one second at 72 Hz. Longer than the burst window. */
export const HOLD_FRAMES = 72

/** The clean stretch a climb needs, before back-off: five seconds at 72 Hz. */
export const UP_CLEAN_FRAMES = 360

/** Misses a clean stretch may still hold. One stray late frame does not veto a climb. */
export const UP_MAX_MISSES = 1

/** The back-off's ceiling, as a multiple of `UP_CLEAN_FRAMES` (40 s at 72 Hz). */
export const UP_BACKOFF_MAX = 8

/** A step down this soon after a step up means the climb failed. */
export const PROBATION_FRAMES = 360

/** Frames ignored at the start of a session: the compiles land here. Two seconds at 72 Hz. */
export const GRACE_FRAMES = 144

export interface EyeScaleState {
  /** Index into `EYE_SCALE_STEPS`. */
  stepIndex: number
  /** Frames counted (not ignored) since the session began. */
  frames: number
  /** Frames counted since the last change (or the session's start). */
  sinceChange: number
  /** Frame numbers of the most recent misses, newest last. */
  readonly misses: number[]
  /** The clean stretch multiplier. */
  backoff: number
  /** The frame of the last step up, or -1; for the probation. */
  lastUpAt: number
  /** Totals, for the report. */
  missCount: number
  ignored: number
}

export const createEyeScaleState = (): EyeScaleState => ({
  stepIndex: 0,
  frames: 0,
  sinceChange: 0,
  misses: [],
  backoff: 1,
  lastUpAt: -1,
  missCount: 0,
  ignored: 0,
})

/** Back to full scale and no history: a new session. */
export const resetEyeScaleState = (state: EyeScaleState): void => {
  state.stepIndex = 0
  state.frames = 0
  state.sinceChange = 0
  state.misses.length = 0
  state.backoff = 1
  state.lastUpAt = -1
  state.missCount = 0
  state.ignored = 0
}

export const eyeScaleOf = (state: EyeScaleState): number =>
  EYE_SCALE_STEPS[state.stepIndex] ?? EYE_SCALE_CEILING

/** One change, with the evidence that made it. */
export interface EyeScaleChange {
  /** The counted frame it happened on. */
  readonly frame: number
  readonly from: number
  readonly to: number
  readonly reason: string
}

const KEEP_MISSES = Math.max(DOWN_MISSES, UP_MAX_MISSES + 1)

/** The lowest step index the floor allows. */
const FLOOR_INDEX = (() => {
  let i = 0
  while (i + 1 < EYE_SCALE_STEPS.length && (EYE_SCALE_STEPS[i + 1] as number) >= EYE_SCALE_FLOOR) {
    i++
  }
  return i
})()

/**
 * One XR frame. `periodSeconds` is the time since the previous XR animation
 * frame; `displayHz` the display's rate (`quality.report.displayHz`).
 * Returns the change it made, or null.
 */
export const stepEyeScale = (
  state: EyeScaleState,
  periodSeconds: number,
  displayHz: number,
): EyeScaleChange | null => {
  const display = displayHz > 0 && Number.isFinite(displayHz) ? 1 / displayHz : 1 / 72
  if (!(periodSeconds > 0) || periodSeconds > STALL_FACTOR * display) {
    state.ignored++
    return null
  }
  state.frames++
  if (state.frames <= GRACE_FRAMES) return null
  state.sinceChange++
  const frame = state.frames
  if (periodSeconds > MISS_FACTOR * display) {
    state.misses.push(frame)
    if (state.misses.length > KEEP_MISSES) state.misses.shift()
    state.missCount++
  }
  // A climb that held through its probation earns the back-off down again.
  if (state.lastUpAt >= 0 && frame - state.lastUpAt > PROBATION_FRAMES) {
    state.backoff = Math.max(1, state.backoff / 2)
    state.lastUpAt = -1
  }
  if (state.sinceChange < HOLD_FRAMES) return null

  const from = eyeScaleOf(state)
  // The burst: the DOWN_MISSES-th newest miss inside the window.
  const burstAt = state.misses[state.misses.length - DOWN_MISSES]
  if (
    state.stepIndex < FLOOR_INDEX &&
    burstAt !== undefined &&
    burstAt > frame - DOWN_WINDOW_FRAMES
  ) {
    const failedClimb = state.lastUpAt >= 0 && frame - state.lastUpAt <= PROBATION_FRAMES
    if (failedClimb) state.backoff = Math.min(UP_BACKOFF_MAX, state.backoff * 2)
    state.lastUpAt = -1
    state.stepIndex++
    state.sinceChange = 0
    return {
      frame,
      from,
      to: eyeScaleOf(state),
      reason:
        `${DOWN_MISSES} frames over ${MISS_FACTOR}x the display period inside ${DOWN_WINDOW_FRAMES} frames` +
        (failedClimb
          ? `; the last climb failed, next needs ${state.backoff}x the clean stretch`
          : ''),
    }
  }
  // The climb: no more than UP_MAX_MISSES misses in the stretch.
  const need = UP_CLEAN_FRAMES * state.backoff
  const vetoAt = state.misses[state.misses.length - (UP_MAX_MISSES + 1)]
  if (
    state.stepIndex > 0 &&
    state.sinceChange >= need &&
    (vetoAt === undefined || vetoAt <= frame - need)
  ) {
    state.stepIndex--
    state.sinceChange = 0
    state.lastUpAt = frame
    return {
      frame,
      from,
      to: eyeScaleOf(state),
      reason: `${need} frames with at most ${UP_MAX_MISSES} over ${MISS_FACTOR}x the display period`,
    }
  }
  return null
}

/** What a recorded sequence of frame periods would have made the controller do. */
export interface EyeScaleReplay {
  readonly frames: number
  readonly misses: number
  readonly ignored: number
  readonly changes: readonly EyeScaleChange[]
  /** Counted frames spent at each scale, keyed by the scale. */
  readonly framesAt: Readonly<Record<string, number>>
  /** The smallest gap between two changes, in counted frames (Infinity with fewer than two). */
  readonly minGap: number
  readonly lowest: number
}

/**
 * Feed `periodsMs` (one XR frame period each, milliseconds) through a fresh
 * controller. Open loop: a recording cannot show the misses a lower scale
 * would have removed, so this is how often and how far the controller WOULD
 * have stepped on that flight, not where a closed loop would settle.
 */
export const replayEyeScale = (periodsMs: readonly number[], displayHz: number): EyeScaleReplay => {
  const state = createEyeScaleState()
  const changes: EyeScaleChange[] = []
  const framesAt: Record<string, number> = {}
  let lowest = eyeScaleOf(state)
  for (const ms of periodsMs) {
    const before = state.frames
    const change = stepEyeScale(state, ms / 1000, displayHz)
    if (change) changes.push(change)
    if (state.frames > before) {
      const key = String(eyeScaleOf(state))
      framesAt[key] = (framesAt[key] ?? 0) + 1
    }
    lowest = Math.min(lowest, eyeScaleOf(state))
  }
  let minGap = Number.POSITIVE_INFINITY
  for (let i = 1; i < changes.length; i++) {
    const gap = (changes[i] as EyeScaleChange).frame - (changes[i - 1] as EyeScaleChange).frame
    minGap = Math.min(minGap, gap)
  }
  return {
    frames: state.frames,
    misses: state.missCount,
    ignored: state.ignored,
    changes,
    framesAt,
    minGap,
    lowest,
  }
}
