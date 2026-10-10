// src/boot/app/perf.ts: the perf subsystem, out of `bootApp`. APP-SPLIT phase
// 4, slice 1 (`docs/plan/APP-SPLIT.md` §5).
//
// What it holds: the `?perf=1` DOM panel and its cockpit plate (with the
// plate's 4 Hz accumulators), the GPU timer, the per-frame trace and the
// multi-run capture (arm, save, export), the frame-error guard, the trace's
// header (`traceMeta`), the frame's last step (the recorder, the adaptive
// controller's cost, the budget line, the trace feed and the plate) and the
// `__ff2perf` handle. Every line below was moved verbatim from the closure;
// the only plumbing is `ctx.x` where the code reads a binding the closure
// still owns (a getter, so `if (ctx.flight) ctx.flight.x()` narrows exactly as
// the closure's `let` did), the frame step's inputs as one argument, and
// `surface()` building `__ff2perf` where the closure used to.
//
// The frame RECORDER (`perf`) is not built here: the renderer's quality
// controller needs it, so it is built before the renderer, and handed in.

import type { QualityPins } from '@/boot/quality-pin'
import { type ComfortSettings, qualityInForce } from '@/boot/settings'
import { xrHoldLine } from '@/boot/xr-visibility'
import type { Level } from '@/content/level-schema'
import type { EditionState } from '@/game/edition'
import type { Flight } from '@/game/flight'
import type { MissionState } from '@/game/mission'
import { safeStorage } from '@/game/personal-best'
import type { RemoteShips } from '@/game/remote-ships'
import type { RoomClient } from '@/game/room-client'
import type { LoadedTerrain } from '@/game/terrain/load-terrain'
import { ADVANCED_FEATURES, advancedFeatureMask } from '@/render/advanced-menu'
import { createPerfPlate, type PerfPlate } from '@/render/perf-plate'
import type { PropFracture } from '@/render/prop-fracture'
import type { TargetSource } from '@/render/quality'
import type { Renderer } from '@/render/renderer'
import { FIXED_DT } from '@/sim/constants'
import type { FixedStepClock } from '@/sim/integrator'
import type { LaunchState } from '@/sim/launch'
import { launchHoldsShip } from '@/sim/launch'
import { createGpuTimer, type GpuTimer } from '../gpu-timer'
import { type CapturePayload, captureFileName, createPerfCapture } from '../perf-capture'
import { perfPlateLines } from '../perf-format'
import { createPerfHud, type PerfHud } from '../perf-hud'
import type { FrameRecorder } from '../perf-recorder'
import {
  createPerfSurface,
  eyeProjections,
  eyeViewportWidth,
  type PerfSurface,
  TRACE_STORAGE_KEY,
  type XrProbe,
} from '../perf-surface'
import {
  createTraceRecorder,
  formatTraceSummary,
  PHASE_FLYING,
  PHASE_PRE_FLIGHT,
  PHASE_RUN_OVER,
  type TraceMeta,
  type TraceRecorder,
  type TraceSample,
} from '../perf-trace'
import { renderCensus } from '../render-census'
import { BUILD_MODE, BUILD_VERSION } from '../version'
import { PERF_HUD, PLATE_INTERVAL_MS, TRACE_RUN_OVER_TAIL_MS, TRACE_SECONDS } from './pins'

/** What the perf subsystem reads from the closure. Getters: every one is read live. */
export interface PerfCtx {
  readonly render: Renderer
  readonly perf: FrameRecorder
  readonly pinned: (settings: ComfortSettings) => ComfortSettings
  readonly comfort: ComfortSettings
  readonly qualityPins: QualityPins
  readonly editionState: EditionState
  readonly flight: Flight | null
  readonly mission: MissionState
  readonly screen: 'title' | 'menu' | 'mission'
  readonly launch: LaunchState
  readonly level: Level
  readonly liveTerrain: { terrain: LoadedTerrain; ocean: LoadedTerrain | null } | null
  readonly liveFracture: PropFracture | null
  readonly xrProbe: XrProbe
  readonly xrVisibility: XRVisibilityState | null
  readonly contextLost: boolean
  readonly clock: FixedStepClock
  readonly frameOrdinal: number
  readonly snapped: boolean
  readonly room: RoomClient | null
  readonly roomShips: RemoteShips | null
  /** The closure's frame, which `guardedFrame` wraps. Declared after this is built. */
  readonly frame: (time: number, xrFrame?: XRFrame) => void
}

/** What the frame hands its last step: its own locals, by the names they have there. */
export interface PerfFrame {
  readonly time: number
  readonly frameT0: number
  readonly frameSeconds: number
  readonly simMs: number
  readonly renderMs: number
  readonly ticksThisFrame: number
  readonly thirdPersonLive: boolean
}

export const createPerf = (ctx: PerfCtx) => {
  const { render, perf, pinned } = ctx
  const perfHud: PerfHud | null = PERF_HUD ? createPerfHud() : null
  if (perfHud) {
    perfHud.toggle()
    console.info('perf overlay: ` to hide')
  }
  // The GPU's own time for the frame (DEV-118), off unless `?perf=1` or a spec
  // asks: the wall delta above is vsync on a monitor and cannot rank a cost.
  const gpu: GpuTimer = createGpuTimer(render.renderer.getContext() as WebGL2RenderingContext)
  if (PERF_HUD) gpu.enable()
  // ── The same numbers, in the cockpit, where a headset can read them ──────
  //
  // VR-PERF gap 4: the panel above is DOM and an immersive session has nothing
  // to show. Behind the same ?perf=1 and the same Backquote — one switch, two
  // surfaces (render/perf-plate.ts, DEV-160).
  const perfPlate: PerfPlate | null = PERF_HUD ? createPerfPlate() : null
  // The plate's own 4 Hz clock, and the frame numbers it averages between
  // updates — a single-frame sample of simMs at 4 Hz jumps for no reason a
  // reader can see. Reset every time it draws; see the feed in frame().
  let plateAt = 0
  let plateFrames = 0
  let plateSimMs = 0
  let plateRenderMs = 0
  let plateJsMs = 0
  let plateTicksMin = Number.POSITIVE_INFINITY
  let plateTicksMax = 0
  // ── The per-frame trace (VR-PERF §5.2, DEV-160) ──────────────────────────
  //
  // The recorder above keeps three seconds and answers "what is happening now";
  // this keeps a whole flight and answers "where did it dip", which is the
  // question the worn session exists to ask and the one a ring cannot answer
  // after the headset is off. Idle and free until `?trace=<s>` (or
  // `__ff2perf.trace.start()`) arms it.
  const trace: TraceRecorder = createTraceRecorder()
  /**
   * The ONE sample object the trace is fed with, mutated in place every frame.
   *
   * Volatile, like every other scratch in this file: valid inside one call of
   * `frame()` and never stored. `perf-trace.ts` copies the numbers out (there
   * are `STRIDE` of them) and keeps no reference, which is what makes the feed
   * allocation-free — gap 27 counts ~25-35 small objects a frame already, and
   * an instrument that added one per frame would be measuring itself.
   */
  const traceSample: TraceSample = {
    dtMs: 0,
    ticks: 0,
    simMs: 0,
    renderMs: 0,
    frameMs: 0,
    gpuMs: Number.NaN,
    gpuFresh: false,
    calls: 0,
    triangles: 0,
    programs: 0,
    scale: 1,
    hz: 0,
    shipX: Number.NaN,
    shipZ: Number.NaN,
    elapsedSeconds: 0,
    tierMs: 0,
    terrainPending: 0,
    terrainDetailPending: 0,
    terrainFading: 0,
    seaPending: 0,
    seaFading: 0,
    pieces: 0,
    viewportWidth: 0,
    hudPaints: 0,
    platePaints: 0,
    phase: PHASE_PRE_FLIGHT,
    features: 0,
  }
  /** `gpu.harvested` as of the previous frame — the freshness edge. See gpu-timer.ts. */
  let gpuHarvestedSeen = 0
  /**
   * DEV-335: the trace's `features` mask, recomputed only when an input to it
   * changes. The composed edition is a cached object whose identity moves on
   * every preset flip, override press and session edge; the settings and the
   * pins are replaced, never mutated. So four reference compares a frame, and
   * no allocation, which is the feed's rule (see `traceSample`).
   */
  let maskInputs: readonly unknown[] = []
  let featureMask = 0
  const liveFeatureMask = (): number => {
    const live = ctx.editionState.current
    const presenting = ctx.editionState.immersive
    if (
      maskInputs[0] !== live ||
      maskInputs[1] !== ctx.comfort ||
      maskInputs[2] !== ctx.qualityPins ||
      maskInputs[3] !== presenting
    ) {
      maskInputs = [live, ctx.comfort, ctx.qualityPins, presenting]
      // `pinned`, like the perf surface: a MEASUREMENT reports what is in force.
      featureMask = advancedFeatureMask(live, { settings: pinned(ctx.comfort), presenting })
    }
    return featureMask
  }
  /**
   * The previous frame's SERIAL COST in seconds — the longer of the main thread
   * and the GPU — which is what the adaptive controller decides on (DEV-262).
   *
   * Not `dt`. A compositor holding the app in a reprojection tier hands back a
   * constant wall delta that says nothing about what the app cost, and feeding
   * that to the controller walked it to the floor of `ADAPTIVE_STEPS` on all
   * three worn laps while the GPU sat at 5 ms in a 22 ms frame.
   */
  let lastCostSeconds = 0
  /** The budget line is edge-triggered on BOTH halves: where it came from, and what it is. */
  let budgetShown: TargetSource | null = null
  let budgetMsShown = 0
  /**
   * `?trace=`'s two flags — armed, and written out. Both cleared by
   * `restartRun`, beside `lastResult = null`, so a second go records again.
   *
   * Two rather than one because they answer different questions, and both
   * conditions stay TRUE once they are: `armed` stops a trace being restarted
   * on every frame of the flight, and `saved` stops the summary being printed
   * and the key rewritten on every frame after `mission.finished` goes true.
   *
   * Declared HERE, above `restartRun`, rather than beside the frame loop's own
   * state — nothing calls that function before the loop runs, but a `let` in a
   * temporal dead zone is a class of bug that is invisible until the one path
   * that reaches it early, and the file has paid for that shape before.
   */
  let traceArmed = false
  let traceSaved = false
  /**
   * When `mission.finished` first went true, `performance.now()`. Null until.
   *
   * DEV-177's half of the fix: the trace runs on past the run-over so the stall
   * AT the run-over is inside it. Wall time rather than the mission clock,
   * because the mission clock is the thing that has just stopped.
   */
  let traceFinishedAt: number | null = null
  /**
   * Resolved once, and only when a trace was asked for.
   *
   * `localStorage` THROWS on ACCESS where it is blocked — a private window, a
   * webview with site data off — rather than returning null, which is why this
   * goes through `game/personal-best.ts`'s `safeStorage` and not through the
   * property directly.
   */
  const traceStorage = TRACE_SECONDS === null && !PERF_HUD ? null : safeStorage()
  /**
   * A multi-run capture the player starts from the PAUSE PLATE (Matt's ask,
   * 2026-09-17: *"add a button to the VR ui … then i'll do a few runs"*).
   *
   * `?trace=<s>` cannot do this and the reason is not its duration: it arms
   * once, saves once, and overwrites one storage key, so three runs through it
   * leave one trace. And a query parameter is not reachable from inside a
   * headset — it commits to a duration before anybody knows what they will fly
   * and cannot be changed without taking the Frame off.
   *
   * Under `?perf=1` only, like every other dev surface here. See
   * `boot/perf-capture.ts` for what it holds and why the export splits.
   */
  const perfCapture = createPerfCapture()
  // A capture's runs USED to be 300 s windows armed at the release, and
  // `CAPTURE_RUN_SECONDS` was that number. DEV-261 made them open-ended and
  // armed at boot, so there is no per-run clock left to name: a run now ends
  // when Matt stops the capture, when he restarts the mission, or when the
  // buffer's row ceiling forces a new one. `MAX_TRACE_ROWS` in
  // `perf-trace.ts` is the only limit, and it is in rows because the buffer,
  // not the clock, is what runs out.
  const CAPTURE_STORAGE_KEY = 'ff2:perf-capture-digest'
  /**
   * Hand a finished capture over: one file, and the summaries to storage.
   *
   * **The download is the path that actually reaches a reader**, because the
   * Frame streams from a desktop Chrome and a download lands in that desktop's
   * Downloads folder — somewhere a person, or an agent on that machine, can
   * open. `localStorage` is per-origin inside one browser profile and reaches
   * nobody.
   *
   * ONE file at the end rather than one per run, so a headset session produces
   * a single prompt rather than one per lap; and a browser may refuse a
   * programmatic download outright, which is why the digest is written too and
   * why the console says where both went. The capture is not emptied by
   * `stop()`, so a refusal can be retried.
   */
  /**
   * Fold whatever the trace is holding RIGHT NOW into the capture, as a run.
   *
   * **Matt, 2026-09-20: *"make it write whenever i turn it off. don't make it
   * contingent on special cases."*** It was contingent on two, and between them
   * they threw away most of a headset session:
   *
   *  1. **The run had to END.** The loop's `perfCapture.add` sits behind
   *     `trace.status === 'done' || pastRunOver` — that is, the 300 s window
   *     elapsing or `mission.finished` plus the tail. Fly ninety seconds and
   *     stop the capture and NOTHING had ever been added, so the file was
   *     written with zero runs in it.
   *  2. **`restartRun()` dropped it.** That function clears `traceArmed` and
   *     `traceSaved` so the next go re-arms — correct for `?trace=`, and during
   *     a CAPTURE it silently discarded the run you just flew. A session of
   *     "fly, crash, restart, fly" collected nothing at all, which is exactly
   *     how a headset session goes.
   *
   * So: one flush, called from both the restart and the stop, and it asks the
   * RECORDER whether it has frames rather than asking the mission whether it
   * approves of how they ended. A partial run is the normal case in a headset
   * and it is the one that was being thrown away.
   *
   * Returns whether it kept anything, so the caller can say so.
   */
  const captureLiveRun = (reason: string): boolean => {
    if (!perfCapture.recording || traceSaved) return false
    // The recorder is the authority on whether there is anything to keep. Read
    // the count BEFORE `stop()`, so the number in the console is the number of
    // frames in the CSV rather than whatever the ring reports afterwards.
    const frames = trace.frames
    if (frames === 0) return false
    if (trace.status === 'recording') trace.stop()
    traceSaved = true
    perfCapture.add({
      mission: trace.meta.mission,
      edition: trace.meta.edition,
      summary: trace.summary(),
      csv: trace.dump(),
    })
    console.info(
      `perf capture: kept ${frames} frames of ${trace.meta.mission} (${reason}) — ` +
        `${perfCapture.runs} run(s) held`,
    )
    return true
  }

  const exportPerfCapture = (payload: CapturePayload): void => {
    const name = captureFileName(new Date())
    let downloaded = false
    try {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(payload)], { type: 'application/json' }),
      )
      const a = document.createElement('a')
      a.href = url
      a.download = name
      a.click()
      // Revoked on a later turn of the loop: revoking synchronously races the
      // click on some builds and the download arrives empty.
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      downloaded = true
    } catch {
      downloaded = false
    }
    let stored = false
    try {
      traceStorage?.setItem(CAPTURE_STORAGE_KEY, JSON.stringify(perfCapture.digest()))
      stored = traceStorage !== null
    } catch {
      // Quota, a private window, a webview with site data off. The payload is
      // still in memory and `__ff2perf.capture.payload()` still answers.
      stored = false
    }
    const runs = payload.runs.map((r) => `${r.index}. ${r.mission}`).join(', ')
    const report =
      `perf capture: ${payload.runs.length} run(s) — ${runs || 'none'}\n` +
      `  file:    ${downloaded ? name : 'NOT downloaded (the browser refused it)'}\n` +
      `  digest:  ${stored ? CAPTURE_STORAGE_KEY : 'NOT stored (quota or blocked storage)'}\n` +
      '  in memory either way: __ff2perf.capture.payload()'
    // An EMPTY capture is a failure wearing a success's clothes: a file still
    // downloads, the console still prints, and the reader finds out there is
    // nothing in it an hour later on another machine. Say it at `warn`, and say
    // the one thing that distinguishes the two causes — no flight at all, or
    // flights whose frames went somewhere else.
    if (payload.runs.length === 0) {
      console.warn(
        `${report}\n` +
          '  THE CAPTURE IS EMPTY. Nothing was recorded between start and stop.\n' +
          `  The trace holds ${trace.frames} frame(s) and reads '${trace.status}'. ` +
          'If that is 0, no flight was ever armed — a capture arms once the ship is\n' +
          '  FLYING, so a session spent in the hangar or on the lift records nothing.',
      )
      return
    }
    console.info(report)
  }
  /**
   * What the CONTROLLERS actually report, for the plate.
   *
   * Matt, from the first Frame session: *"i can't seem to fire up the pause
   * menu in VR using the frame controllers."* `input/xr.ts` binds pause to the
   * left hand's `xr-standard` button **5** — chosen for a Quest Touch, where
   * that is Y, and the system reserves the real menu button. The Frame's
   * controllers are a different profile and `pressed()` returns false for an
   * index that is not there, so the binding fails silently and there is no way
   * to tell from inside a headset which index IS free.
   *
   * Guessing a second index would cost another session. This prints the ground
   * truth instead: the profile each hand reports, how many buttons it has, and
   * which are down RIGHT NOW. Press the button you want and read the number.
   */
  const xrInputLine = (): string | null => {
    const session = render.renderer.xr.getSession()
    if (!session) return null
    const hands: string[] = []
    for (const src of session.inputSources) {
      const pad = src.gamepad
      if (!pad) continue
      const down = pad.buttons
        .map((b, i) => (b.pressed ? i : -1))
        .filter((i) => i >= 0)
        .join(',')
      const profile = src.profiles[0] ?? '?'
      hands.push(
        `${src.handedness[0]?.toUpperCase() ?? '?'}[${profile}] ${pad.buttons.length}b` +
          (down ? ` DOWN ${down}` : ''),
      )
    }
    return hands.length > 0 ? hands.join('  ') : 'xr: no gamepads on any input source'
  }
  /**
   * Frame errors, surfaced rather than fatal — see the guard on `frame` itself.
   */
  let frameErrors = 0
  let lastFrameError = ''
  const togglePerfCapture = (): void => {
    if (perfCapture.recording) {
      // The run in progress counts. Before this, stopping mid-flight wrote a
      // file with zero runs in it — see `captureLiveRun`.
      captureLiveRun('capture stopped')
      exportPerfCapture(perfCapture.stop())
      return
    }
    perfCapture.start()
    console.info(
      'perf capture: recording — open-ended, from this frame, through the ride, the ' +
        'run-over and any restart. Press the row again to write the file.',
    )
  }
  /**
   * What a trace is stamped with, read at the moment it is armed.
   *
   * Read rather than captured, because all five move: the preset can be flipped
   * from the menu, the mission is swapped from the holotables, and the BUDGET
   * and its source are the two that matter most — a reading filed against a
   * guessed 72 Hz while the headset ran at 90 is not a slightly-wrong number,
   * it is the wrong verdict (`render/quality.ts`'s `TargetSource`).
   */
  const traceMeta = (): TraceMeta => {
    const report = render.quality.report
    return {
      version: BUILD_VERSION,
      mode: BUILD_MODE,
      edition: ctx.editionState.current.id,
      mission: ctx.level.id,
      budgetMs: report.targetSeconds * 1000,
      budgetSource: report.targetSource,
      // DEV-335: the `features` column's bit names, from the page's own list.
      featureBits: ADVANCED_FEATURES.map((f) => f.id),
      // ── DEV-227: the per-eye frustum, so a worn reading can be REPRODUCED ──
      //
      // Read off `xrProbe`, which the frame loop refreshed above at most a
      // second ago, NOT off `renderer.xr` here. That is the whole discipline of
      // `refreshXrProbe`: an `XRView` read outside its own frame throws, and
      // `traceMeta()` is also reachable from `__ff2perf.trace.start()` on a
      // console, which is never inside a frame. One reader, one place.
      //
      // `null` on the flat path, `[]` for a session that could not be read, one
      // entry per eye otherwise — `eyeProjections` is where those three answers
      // are kept apart, and where they are tested.
      projection: eyeProjections(ctx.xrProbe),
      // DEV-331: the lens mask, into the stored summary (see `visibility-mask.ts`).
      ...(ctx.xrProbe.visibilityMask ? { visibilityMask: ctx.xrProbe.visibilityMask } : {}),
    }
  }

  const perfFrame = ({
    time,
    frameT0,
    frameSeconds,
    simMs,
    renderMs,
    ticksThisFrame,
    thirdPersonLive,
  }: PerfFrame): void => {
    // ── the frame that just happened ─────────────────────────────────────
    //
    // AFTER the render, because `renderer.info.render.calls` and `.triangles`
    // are zeroed by `render()` itself and counted up during it — read them
    // before the call and you get the previous frame's, off by one for the whole
    // session (`boot/perf-hud.ts` has the three.js line numbers).
    //
    // The budget and the engaged counter are READ from the quality controller
    // rather than recomputed: it already owns both, tuned, and two smoothers
    // disagreeing about frame time is a bug nobody can see.
    const quality = render.quality.report
    // The DISPLAY's interval and the TIER's, both (DEV-179). The hitch column
    // is judged against the second: lap 4 was a 90 Hz display with SteamVR
    // holding us at 30, and against the display every frame of it was a hitch —
    // 73 % — which says nothing a reader can act on. Against the tier the same
    // lap reads ~0 % hitch and ~100 % tier, which is the true and useful
    // sentence. `tierHz` is 0 only before the first resolution; the recorder
    // falls back to the display there.
    perf.frame(
      frameSeconds,
      quality.targetSeconds,
      quality.engagedFrames,
      quality.tierHz > 0 ? 1 / quality.tierHz : quality.targetSeconds,
    )
    // ── DEV-262: OUR serial cost, for the adaptive controller ──────────────
    //
    // The longer of the two things that can be the ceiling. They pipeline — the
    // GPU works on this frame while the main thread prepares the next — so the
    // frame rate we could sustain is set by whichever is longer, not by the sum
    // and not by either alone.
    //
    // `gpu.last` is the newest harvested query and REPEATS on frames where
    // nothing landed (gpu-timer.ts). That is right here and would be wrong in a
    // percentile: a repeat is the last known GPU cost, which is what an EMA
    // wants, whereas averaging the repeats would weight by how often the driver
    // answered. `NaN` where the timer is unsupported, and then the main thread
    // is the whole of what we can see.
    //
    // Hoisted out of the `perfPlate` guard below because the controller needs it
    // on every frame and a player never loads the plate. One extra
    // `performance.now()` on that path, and the plate now reuses this one.
    const mainThreadMs = performance.now() - frameT0
    const gpuMs = gpu.last
    lastCostSeconds = Math.max(mainThreadMs, Number.isFinite(gpuMs) ? gpuMs : 0) / 1000
    if (perfPlate) {
      plateFrames += 1
      plateSimMs += simMs
      plateRenderMs += renderMs
      plateJsMs += mainThreadMs
      if (ticksThisFrame < plateTicksMin) plateTicksMin = ticksThisFrame
      if (ticksThisFrame > plateTicksMax) plateTicksMax = ticksThisFrame
    }

    // ── the budget, printed once per ADOPTED change (§5.3, DEV-161) ──────
    //
    // ON THE EDGE, the `fadePhaseShown` pattern above: this changes when a
    // session starts, when the measured interval first has enough frames to be
    // believed, and when SteamVR's refresh is changed under a running session.
    // That is three or four lines a session; per frame it would be 90 a second
    // of the same string, which is how a console stops being read.
    //
    // It printed SIXTY times in one worn lap anyway, because the edge was real
    // every time: the resolver flipped between `measured 45` and `default 72`
    // on every 3 s window. The edge is unchanged and the flap is gone — the
    // report now carries the ADOPTED budget (`render/quality.ts`'s
    // `BUDGET_ADOPT_SECONDS`), so a value that has not been held cannot reach
    // this line at all.
    //
    // It prints the SOURCE because that is the half that decides whether the
    // number means anything: `default` is 72 Hz because nobody knows, and a
    // reading filed against it is a reading to distrust. And it prints the TIER
    // beside the display, because 90 Hz with the app at 45 is the one shape
    // where the budget and the frame rate disagree on purpose.
    if (budgetShown !== quality.targetSource || budgetMsShown !== quality.targetSeconds) {
      budgetShown = quality.targetSource
      budgetMsShown = quality.targetSeconds
      const tier = quality.tierHz !== quality.displayHz ? `, app at ${quality.tierHz} Hz tier` : ''
      const share =
        quality.measuredShare === null ? '' : `, share ${quality.measuredShare.toFixed(2)}`
      console.info(
        `perf: budget ${(quality.targetSeconds * 1000).toFixed(1)} ms — ` +
          `${Math.round(quality.displayHz)} Hz display${tier} ` +
          `(${quality.targetSource}${share})`,
      )
    }

    // ── the per-frame trace, only while one is recording (§5.2) ──────────
    //
    // Fifteen assignments into ONE object that has existed since boot, then a
    // copy into a typed array. No closure, no literal, no array — see
    // `traceSample`'s note. Out of a recording this is a single boolean test.
    if (trace.status === 'recording') {
      const info = render.renderer.info
      // The freshness EDGE. `gpu.last` is the newest harvested query and repeats
      // on frames where nothing landed; `harvested` advancing is the only way to
      // tell a new reading from a repeat of the one above (gpu-timer.ts).
      const harvested = gpu.harvested
      traceSample.dtMs = frameSeconds * 1000
      traceSample.ticks = ticksThisFrame
      traceSample.simMs = simMs
      traceSample.renderMs = renderMs
      // Last, and after the render: everything this frame spent on the main
      // thread is inside it.
      traceSample.frameMs = performance.now() - frameT0
      traceSample.gpuMs = gpu.last
      traceSample.gpuFresh = harvested > gpuHarvestedSeen
      gpuHarvestedSeen = harvested
      traceSample.calls = info.render.calls
      traceSample.triangles = info.render.triangles
      traceSample.programs = info.programs?.length ?? 0
      traceSample.scale = quality.scale
      // 0 where the runtime does not report one — which is desktop Chrome, where
      // `frameRate` is not even on `XRSession.prototype`. The same cast
      // `render/quality.ts` makes, for the same reason: it is Meta's extension
      // and the DOM lib does not carry it.
      traceSample.hz =
        (render.renderer.xr.getSession() as { frameRate?: number } | null)?.frameRate ?? 0
      // SIM space (Unity's, z unflipped), not the render object's — because the
      // question this column exists to answer is *which gate was I at when the
      // frame went long*, and `content/levels/*.json` holds gate positions in
      // sim space. Reading `flight.object.position` would put a silent z flip
      // between the trace and the thing it is correlated against.
      traceSample.shipX = ctx.flight ? ctx.flight.jet.body.position.x : Number.NaN
      traceSample.shipZ = ctx.flight ? ctx.flight.jet.body.position.z : Number.NaN
      traceSample.elapsedSeconds = ctx.mission.elapsed
      // DEV-261. The same three conditions the arming used to be gated on,
      // recorded per frame instead of consulted once — which is the whole
      // change: what used to decide WHETHER there is a row now labels the row.
      // `mission.finished` first, because a finished run is still `flying` by
      // the launch test and the run-over is the interval we most want named.
      traceSample.phase = ctx.mission.finished
        ? PHASE_RUN_OVER
        : ctx.screen === 'mission' && ctx.flight && !launchHoldsShip(ctx.launch)
          ? PHASE_FLYING
          : PHASE_PRE_FLIGHT
      // DEV-179. The rate frames are ARRIVING at, per frame, because that is
      // the half that moves: SteamVR walked lap 4 between its 45 and 30 Hz
      // tiers as our GPU crossed ~11 ms. The DISPLAY's interval is in the
      // header instead — it is a constant of the session.
      traceSample.tierMs = quality.tierHz > 0 ? 1000 / quality.tierHz : quality.targetSeconds * 1000
      // ── DEV-177(b): what the WORLD was doing ──────────────────────────
      //
      // The LAND's counters, not the ocean's: the ocean is a flat plate whose
      // chunks cost nothing to build, and the stalls being attributed are
      // inland. `fadingChunks` and `detailChunks` walk the slot map (146
      // entries on Simonet) — which is why these are read HERE, inside the
      // `status === 'recording'` branch, and not with the rest of the
      // per-frame numbers. A trace is armed by hand; a flight is not.
      const terrain = ctx.liveTerrain?.terrain
      const sea = ctx.liveTerrain?.ocean
      traceSample.terrainPending = terrain?.pending ?? 0
      traceSample.terrainDetailPending = terrain?.detailPending ?? 0
      traceSample.terrainFading = terrain?.fadingChunks ?? 0
      // The SEA's own two. It is four to six chunks against the land's 256 and
      // it was left out of the first version of these columns for exactly that
      // reason — which made both of the stalls DEV-177(b) exists for read as
      // "nothing in the world was happening". An Anniversary sea chunk at LOD 0
      // is 8x subdivided: ~150 k triangles in ONE draw, fifty times a land
      // chunk, and promoting one is the biggest thing that happens to the frame
      // short of a compile.
      traceSample.seaPending = sea?.pending ?? 0
      traceSample.seaFading = sea?.fadingChunks ?? 0
      traceSample.pieces = ctx.liveFracture?.live ?? 0
      // DEV-236. `scale` above is the ASK; this is what the runtime gave. They
      // are two different quantities and they were two different numbers for
      // six weeks — 0.600 against a full-size 2016 px eye — with no instrument
      // able to put them side by side, because the ask was per frame and the
      // outcome was stamped once in the header. Read off three's own eye
      // camera, which is where `WebXRManager` writes back what
      // `getViewport(view)` returned; 0 flat, where there is no eye.
      traceSample.viewportWidth = eyeViewportWidth(render.renderer.xr)
      // DEV-243. The HUD's repaints so far — cumulative, so the difference
      // between any two rows is the repaints between them whatever subset a
      // reader has filtered to (and every GPU reader filters on `gpu_fresh`).
      // A repaint is a whole-canvas upload inside `renderer.render`, which is
      // inside the `gpu.begin() … gpu.end()` bracket eight lines up, which is
      // `gpu_ms` on this very row.
      traceSample.hudPaints = ctx.flight?.hud.paints ?? 0
      // DEV-243's CONTROL, on the same terms. 0 without `?perf=1`, because
      // without it there is no plate — which is every player's session and no
      // trace run, and is why ~0.3 ms of p95 in every trace this programme has
      // taken is the instrument rather than the game.
      traceSample.platePaints = perfPlate?.paints ?? 0
      // DEV-335: which Advanced rows were on for this frame.
      traceSample.features = liveFeatureMask()
      trace.frame(traceSample)
    }

    // ── `?trace=<s>`: arm, stop, store (§5.6) ────────────────────────────
    //
    // STATE-DRIVEN, never event-driven, and that is the `?title=0` lesson from
    // the other end: a hook hung off the keypress that starts a run is a hook
    // that never fires for the paths nobody presses anything on — the autopilot,
    // a direct `?mission=`, a restart after a crash. Two flags and the same
    // conditions the rest of the loop already reads.
    //
    // Armed once the ship is FLYING, not at boot: the lift ride is 100 seconds
    // of a cutscene, and a 120 s trace that spent the first 100 in an elevator
    // shaft measures the elevator.
    // `?trace=<s>` arms this, and so does a capture the player started from the
    // pause plate — the same recorder, the same arming conditions, and the only
    // difference is that a capture re-arms on EVERY run and keeps each result
    // instead of overwriting one storage key.
    // ── DEV-261: `?perf=1` records from BOOT, until Matt stops it ───────────
    //
    // Matt: *"make it so once perf=1 is there, it records until i stop it."*
    //
    // The two conditions below used to be one expression and they answer
    // different questions. `traceSeconds` is HOW LONG — a number for
    // `?trace=<s>`, and now `null`, meaning open-ended, for a capture. `armNow`
    // is WHEN TO START, and for an open-ended capture the answer is "already".
    //
    // What that replaces, and why the old reasoning no longer holds. The old
    // arming waited for `!launchHoldsShip(launch)` on the argument that *"the
    // lift ride is 100 seconds of a cutscene, and a 120 s trace that spent the
    // first 100 in an elevator shaft measures the elevator."* That is right
    // about a fixed WINDOW and it is why `?trace=<s>` still waits. It is wrong
    // about an open-ended one, where the ride costs rows and nothing else —
    // and it cost us the only frames that mattered: the tier is lost at the
    // race start, so arming AT the race start put the event one frame before
    // the first row of every capture we have. All three worn laps open at
    // 22.20 ms with the lock already in force.
    //
    // The ride is now IN the trace, which is a mixture, so every frame carries
    // `phase` and the summary prints the split. See `perf-trace.ts`.
    // `null` IS the open-ended value, so this is `TRACE_SECONDS` unchanged: a
    // `?trace=<s>` load carries its window, a capture carries none.
    const traceSeconds = TRACE_SECONDS
    const capturing = TRACE_SECONDS === null && perfCapture.recording
    if (TRACE_SECONDS !== null || perfCapture.recording) {
      const armNow = capturing
        ? true
        : ctx.screen === 'mission' && ctx.flight && !launchHoldsShip(ctx.launch)
      if (!traceArmed && armNow) {
        traceArmed = true
        trace.start(traceSeconds, traceMeta())
        const meta = trace.meta
        console.info(
          `perf: recording ${traceSeconds} s — ${meta.mission} ${meta.edition}, ` +
            `budget ${meta.budgetMs.toFixed(1)} ms (${meta.budgetSource})`,
        )
      }
      // ── Keep recording PAST the run-over (DEV-177) ───────────────────────
      //
      // This used to stop on the frame `mission.finished` went true, so the
      // interval after a run-over was never in a trace — and the worst stall
      // the headset has produced is exactly that interval: **2.8 s between
      // frame callbacks at run-over**, outside `frame()` entirely (DEV-160 §3).
      // The one event we most needed a trace of was the one event that ended
      // the trace.
      //
      // `mission.finished` is an EDGE, so the wait is timed from the first
      // frame it is seen on rather than from a level clock that may have
      // stopped. Whichever comes first: the window elapsing (`status === 'done'`)
      // still stops it, so `?trace=<s>` never records longer than it was asked
      // for, and a run-over inside the last five seconds simply ends there.
      if (traceArmed && !traceSaved && ctx.mission.finished && traceFinishedAt === null) {
        traceFinishedAt = performance.now()
      }
      // DEV-261: and an open-ended capture does not end at the run-over
      // either. "Until I stop it" means the results board, the restart and the
      // next attempt are all in the same recording — the run-over tail exists
      // to stop a WINDOW cutting the 2.8 s stall in half, and there is no
      // window here to cut.
      const pastRunOver =
        !capturing &&
        traceFinishedAt !== null &&
        performance.now() - traceFinishedAt >= TRACE_RUN_OVER_TAIL_MS
      if (traceArmed && !traceSaved && (trace.status === 'done' || pastRunOver)) {
        traceSaved = true
        if (trace.status === 'recording') trace.stop()
        const text = trace.dump()
        // A capture KEEPS this run. `perf-capture.ts` ignores the call when it
        // is not recording, so the `?trace=` path is unchanged.
        perfCapture.add({
          mission: trace.meta.mission,
          edition: trace.meta.edition,
          summary: trace.summary(),
          csv: text,
        })
        let stored = false
        try {
          traceStorage?.setItem(TRACE_STORAGE_KEY, text)
          stored = traceStorage !== null
        } catch {
          // Quota, a private window, a webview with site data off. The trace is
          // still IN MEMORY and `dump()` still answers, which is the whole of
          // the recovery — so this is reported, loudly, rather than swallowed.
          stored = false
        }
        console.info(formatTraceSummary(trace.summary()))
        console.info(
          stored
            ? 'perf: trace stored — __ff2perf.trace.last() or .download()'
            : 'perf: trace NOT stored (quota or blocked storage) — call __ff2perf.trace.dump() NOW, ' +
                'it is only in memory and a reload loses it',
        )
        // ── DEV-261: the ceiling is a CHUNK BOUNDARY, not the end ──────────
        //
        // An open-ended capture only reaches here by filling `MAX_TRACE_ROWS`
        // — 89 minutes at the 45 Hz this build gets worn. Stopping there would
        // make "until I stop it" quietly false at the one point nobody is
        // watching for it. The run just saved is safely in the capture, so
        // re-arm and keep going: the session becomes N runs in the file rather
        // than one truncated one, which is the shape `perf-capture.ts` is for.
        if (capturing) {
          traceArmed = false
          traceSaved = false
          traceFinishedAt = null
          console.info(
            'perf capture: trace buffer full — run kept, recording continues in a new one',
          )
        }
      }
    }
    // `stats()` sorts a few hundred floats. Only when somebody is looking.
    if (perfHud?.isVisible()) {
      perfHud.tick(perf.stats(), render.renderer.info, {
        scale: quality.scale,
        edition: ctx.editionState.current.id,
        speedFx: ctx.editionState.speedFx,
        // T1's Measure column (DEV-085): the triangle count on the DRAW row is
        // the cost, and this is what is spending it.
        detail: ctx.liveTerrain
          ? {
              chunks: ctx.liveTerrain.terrain.detailChunks,
              pending: ctx.liveTerrain.terrain.detailPending,
              resolution: ctx.editionState.current.terrain.detailRing.baseResolution,
            }
          : null,
      })
    }

    // ── the plate, at 4 Hz ───────────────────────────────────────────────
    //
    // perfPlateLines allocates ten strings and update() compares their join,
    // so this is deliberately NOT on the per-frame path (gap 27). It redraws
    // the canvas only when a character changes, which at these quantisations
    // is far less often than four times a second.
    if (perfPlate) {
      // A cockpit instrument, so: only when the DOM panel is up (one switch,
      // two surfaces), only when the HUD itself is drawn, and never in third
      // person — the chase camera is a flat-screen view and the plate would be
      // a panel 24 m away.
      const plateVisible =
        (perfHud?.isVisible() ?? false) &&
        (ctx.flight?.hud.object.visible ?? false) &&
        !thirdPersonLive
      perfPlate.setVisible(plateVisible)
      if (plateVisible && time - plateAt >= PLATE_INTERVAL_MS) {
        plateAt = time
        const s = perf.stats()
        const info = render.renderer.info
        const g = gpu.stats()
        const n = Math.max(1, plateFrames)
        perfPlate.update(
          perfPlateLines({
            version: BUILD_VERSION,
            mode: BUILD_MODE,
            edition: ctx.editionState.current.id,
            mission: ctx.level.id,
            budgetMs: quality.targetSeconds * 1000,
            budgetHz: quality.targetSeconds > 0 ? 1 / quality.targetSeconds : 0,
            budgetSource: quality.targetSource,
            // From the REPORT, not from a second call to the recorder: the
            // budget in force has already been held for `BUDGET_ADOPT_SECONDS`
            // and carries the share it was adopted on, while `perf.modalHz()`
            // answers about this instant. Two panels reading the same quantity
            // at different moments is how they end up disagreeing on a
            // screenshot (DEV-161).
            budgetShare: quality.measuredShare,
            budgetTierHz: quality.tierHz,
            fps: s.fps,
            p50Ms: s.p50Ms,
            p95Ms: s.p95Ms,
            maxMs: s.maxMs,
            hitchFraction: s.hitchFraction,
            hitches: s.hitches,
            tierFraction: s.tierFraction,
            frames: s.frames,
            engagedFraction: s.engagedFraction,
            scale: quality.scale,
            simMs: plateSimMs / n,
            ticksMin: Number.isFinite(plateTicksMin) ? plateTicksMin : 0,
            ticksMax: plateTicksMax,
            renderMs: plateRenderMs / n,
            jsMs: plateJsMs / n,
            gpu:
              gpu.supported && g.frames > 0
                ? { p50Ms: g.medianMs, p95Ms: g.p95Ms, samples: g.frames }
                : null,
            calls: info.render.calls,
            triangles: info.render.triangles,
            programs: info.programs?.length ?? 0,
            geometries: info.memory.geometries,
            textures: info.memory.textures,
            presenting: ctx.xrProbe.presenting,
            trace: {
              status: trace.status,
              recordedSeconds: trace.seconds,
              totalSeconds: trace.limitSeconds,
              frames: trace.frames,
            },
            xr: {
              layer: ctx.xrProbe.layer ?? '',
              fixedFoveation: ctx.xrProbe.fixedFoveation,
              // DEV-236. The `vp` field is now the OUTCOME — the live per-eye
              // width — where it used to be `recommendedViewportScale`, the
              // UA's hint, which is null on every runtime measured here and was
              // being read as though it were our request having landed. The
              // hint is still on the probe: `__ff2perf.xr().views[n]`.
              //
              // Off the probe rather than a second `eyeViewportWidth` call:
              // DEV-227 already put the live per-eye rectangle on it and the
              // probe is refreshed once a frame, so this is the same reading
              // with no second chance to disagree with itself.
              viewportWidth: ctx.xrProbe.views[0]?.projection?.viewport?.w ?? 0,
              framebufferWidth: ctx.xrProbe.framebuffer?.w ?? 0,
              framebufferHeight: ctx.xrProbe.framebuffer?.h ?? 0,
              nativeScale: ctx.xrProbe.nativeScale,
            },
          }).concat(
            // Appended rather than folded into `perfPlateLines`: that function
            // is the SHAPE of the instrument and is unit-tested against it,
            // while these two are a live diagnostic that exists until the
            // Frame's mapping is known and the freeze is explained.
            [
              xrInputLine(),
              // DEV-206. Both are silent everywhere else: a blurred session
              // throws nothing and a lost context throws nothing, and the plate
              // is the only surface a headset has. `perf-plate.ts` lays out for
              // `plateRows(lines.length)` now, so an extra row APPEARS rather
              // than being painted past the bottom edge — which is how the XR
              // row above went unread through an entire Frame session.
              xrHoldLine(ctx.xrVisibility),
              ctx.contextLost ? 'WEBGL CONTEXT LOST \u2014 reload' : null,
              frameErrors > 0 ? `ERR ${frameErrors}x ${lastFrameError}` : null,
            ].filter((l): l is string => l !== null),
          ),
          // DEV-243. The plate's own cadence clock, and the same one `plateAt`
          // is kept in, so `report().rateHz` is a rate over the window this
          // branch actually runs in rather than over a second reading of the
          // wall taken a few microseconds later.
          time,
        )
        plateFrames = 0
        plateSimMs = 0
        plateRenderMs = 0
        plateJsMs = 0
        plateTicksMin = Number.POSITIVE_INFINITY
        plateTicksMax = 0
      }
    }
  }

  /**
   * `frame`, wrapped so that ONE bad frame cannot end the session.
   *
   * Matt, from the first Frame session: *"the entire VR app freezes."* This is
   * the mechanism that makes a freeze permanent rather than a stutter. three's
   * `WebXRManager` re-requests the next XR frame from INSIDE the callback, so
   * an exception that escapes `frame` never reaches the line that asks for
   * another one — the session stops being driven and never recovers. On a flat
   * screen that is an error in a console nobody had open; in a headset it is a
   * dead world with no way to see why.
   *
   * So: catch, count, remember, and keep asking for frames. The error is
   * REPORTED and not swallowed — `console.error` on every new message, the
   * count and the message on the perf plate where a wearer can read them, and
   * `__ff2perf.errors()` for afterwards. A repeat of the same message is
   * counted rather than re-logged, because a throw in a render loop is a throw
   * ninety times a second and a console that fills is a console that tells you
   * nothing.
   *
   * This is not a way to ship broken frames. It is the difference between "the
   * app froze" and "the app said `TypeError: x is undefined` in `pause.ts:214`,
   * 1,400 times, starting when I pressed that button".
   */
  const guardedFrame = (time: number, xrFrame?: XRFrame): void => {
    try {
      ctx.frame(time, xrFrame)
    } catch (error) {
      frameErrors++
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      if (message !== lastFrameError) {
        lastFrameError = message
        console.error('frame: threw — the loop is being kept alive deliberately', error)
        // ── and re-thrown ASYNCHRONOUSLY, which is not belt-and-braces ──────
        //
        // Catching here would otherwise BLIND every gate that watches for an
        // uncaught error. `terrain-look-frames.spec.ts` fails on any page
        // error and that is how a shader that does not build gets caught;
        // `window.onerror` is how anything else would ever hear about this.
        // Swallowing the throw to save the loop would trade a visible freeze
        // for a silent wrong frame, which is the worse of the two and is the
        // trade this repo keeps having to undo.
        //
        // A `setTimeout` throw is a fresh task, so it reaches `pageerror`,
        // `window.onerror` and the console exactly as an uncaught error does —
        // and it is NOT on the animation loop's stack, so it cannot stop the
        // next `requestAnimationFrame`. Only the first of each distinct
        // message: a throw in a render loop is a throw ninety times a second.
        setTimeout(() => {
          throw error
        }, 0)
      }
    }
  }

  // ── `__ff2perf`, the handle that ships (VR-PERF §5.4, gap 3) ─────────────
  //
  // Built LAST because it reads almost everything above, and built only under
  // `?perf=1`: no switch, no object, no cost. Every getter here is a snapshot —
  // `perf-surface.ts` freezes them deeply — so nothing a console can reach is a
  // reference back into the scene or the sim.
  const surface = (): PerfSurface | null =>
    PERF_HUD
      ? createPerfSurface(
          {
            version: () => ({ version: BUILD_VERSION, mode: BUILD_MODE }),
            edition: () => ({ id: ctx.editionState.current.id, speedFx: ctx.editionState.speedFx }),
            mission: () => ({ id: ctx.level.id, mode: ctx.mission.mode }),
            settings: () => ({
              // `pinned`, not `comfort`: this is a MEASUREMENT surface, and the
              // value a row should be filed against is the one in force, not the
              // one in the player's storage. `?quality=low` with `high` stored
              // must never report `high` here.
              // DEV-334: the tier IN FORCE, which on AUTO is the headset's own
              // default while presenting, not the monitor's stored `quality`.
              quality: qualityInForce(pinned(ctx.comfort), render.renderer.xr.isPresenting),
              foveation: ctx.comfort.foveation,
              adaptiveResolution: pinned(ctx.comfort).adaptiveResolution,
            }),
            stats: () => perf.stats(),
            budget: () => {
              const report = render.quality.report
              return {
                ms: report.targetSeconds * 1000,
                // `hz` IS the display rate — the budget is `1 / displayHz`. Kept
                // under its old name because it never meant anything else, and
                // `displayHz` is beside it so a reading can say which is which
                // without arithmetic (DEV-161).
                hz: Math.round(1 / report.targetSeconds),
                source: report.targetSource,
                displayHz: report.displayHz,
                tierHz: report.tierHz,
                sticky: report.displaySticky,
                dropping: report.droppingFraction,
                modal: perf.modalHz(),
              }
            },
            quality: () => render.quality.report,
            gpu: () => ({
              supported: gpu.supported,
              enabled: gpu.enabled,
              ...gpu.stats(),
              last: gpu.last,
              harvested: gpu.harvested,
            }),
            info: () => {
              const info = render.renderer.info
              return {
                frame: info.render.frame,
                calls: info.render.calls,
                triangles: info.render.triangles,
                points: info.render.points,
                lines: info.render.lines,
                programs: info.programs?.length ?? 0,
                geometries: info.memory.geometries,
                textures: info.memory.textures,
              }
            },
            sim: () => ({
              tick: ctx.clock.tick,
              elapsed: ctx.mission.elapsed,
              ticksPerSecond: 1 / FIXED_DT,
              snapped: ctx.snapped,
            }),
            session: () => ctx.xrProbe,
            census: () => renderCensus(render.renderer, render.scene, render.camera),
            frameIndex: () => ctx.frameOrdinal,
            trace: {
              start: (seconds: number) => {
                trace.start(seconds, traceMeta())
              },
              stop: () => {
                trace.stop()
              },
              status: () => trace.status,
              frames: () => trace.frames,
              summary: () => trace.summary(),
              dump: () => trace.dump(),
            },
            /**
             * The multi-run capture the pause plate drives, reachable from a
             * console too — for a flat-screen session, or to retry an export the
             * browser refused. `payload()` answers whether or not it is still
             * recording, which is the recovery when a download is blocked.
             */
            /**
             * Frames that threw, and the last message. Zero on a healthy build.
             * The recovery for a freeze somebody saw and could not read — see
             * `guardedFrame`.
             */
            errors: () => ({ count: frameErrors, last: lastFrameError }),
            // DEV-537: the two-machine test's numbers, on the deployed URL
            // (`__ff2.room()` is dev only). Built field by field: plain values.
            room: () => {
              const s = ctx.room?.session
              if (!ctx.room || !s) {
                return {
                  inRoom: false,
                  status: null,
                  phase: null,
                  slot: null,
                  synced: false,
                  rttMs: null,
                  offsetMs: null,
                  ships: [],
                }
              }
              return {
                inRoom: true,
                status: ctx.room.status,
                phase: s.roomPhase,
                slot: s.slot,
                synced: s.clock.synced,
                rttMs: s.clock.rtt,
                offsetMs: s.clock.offset,
                ships: (ctx.roomShips?.report() ?? []).map((drawn) => ({
                  slot: drawn.slot,
                  handle: drawn.handle,
                  mode: drawn.mode,
                  stale: drawn.stale,
                  delayMs: drawn.delayMs,
                  renderTick: drawn.renderTick,
                  newestTick: drawn.newestTick,
                })),
              }
            },
            capture: {
              recording: () => perfCapture.recording,
              runs: () => perfCapture.runs,
              missions: () => [...perfCapture.missions],
              toggle: () => {
                togglePerfCapture()
              },
              payload: () => perfCapture.payload(),
              digest: () => perfCapture.digest(),
            },
          },
          { storage: safeStorage() },
        )
      : null

  return {
    perfHud,
    gpu,
    perfPlate,
    trace,
    perfCapture,
    captureLiveRun,
    togglePerfCapture,
    guardedFrame,
    frame: perfFrame,
    surface,
    /** The previous frame's serial cost, for the adaptive controller (DEV-262). */
    get lastCostSeconds() {
      return lastCostSeconds
    },
    // `?trace=`'s flags: `restartRun` clears all three (APP-SPLIT: bag, owner in phase 3).
    get traceArmed() {
      return traceArmed
    },
    set traceArmed(v: boolean) {
      traceArmed = v
    },
    get traceSaved() {
      return traceSaved
    },
    set traceSaved(v: boolean) {
      traceSaved = v
    },
    get traceFinishedAt() {
      return traceFinishedAt
    },
    set traceFinishedAt(v: number | null) {
      traceFinishedAt = v
    },
  }
}
