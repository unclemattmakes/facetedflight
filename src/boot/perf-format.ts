// src/boot/perf-format.ts — the ten rows the in-headset perf plate prints.
//
// DEV-160, `docs/plan/VR-PERF.md` §5.5 D. Gap 4: *"No in-headset readout."*
// `boot/perf-hud.ts` is DOM, and `dom-overlay` is not reliably granted on Quest
// (CLAUDE.md), so in an immersive session there is nothing to see — which is a
// problem for a game whose first release is *in a headset* and whose entire
// performance question can only be answered there.
//
// ── Why the TEXT is a separate module from the PLATE ──────────────────────
//
// Because `tests/unit/` is `environment: 'node'`: there is no canvas, no
// `document`, and therefore no way to unit-test anything that lives inside
// `createPerfPlate`. `render/hud.ts` learned this the hard way and exports
// `hudSignature` for exactly the same reason — its header says the rule ("the
// signature holds what is DRAWN, not what it is drawn from") "was enforced by
// nothing" while the function was trapped inside the closure.
//
// So this file is three-free and DOM-free. It takes a plain value and returns
// ten strings; `render/perf-plate.ts` draws them and knows nothing else.
//
// ── Why the lines ARE the signature ───────────────────────────────────────
//
// The plate redraws only when its text changes, and the text is what changes —
// not the model. Every field here is quantised on the way out (ms to one
// decimal, fps and percentages to whole numbers, triangles to `formatCount`'s
// three significant figures), so a frame time wobbling between 10.91 ms and
// 10.94 ms produces the same ten strings and no canvas upload. `plateSignature`
// is the join of them, which makes the comparison exact rather than a heuristic
// over the inputs: there is no equivalent of `render/hud.ts`'s speed-unit trap
// here, because the thing compared IS the thing drawn.
//
// `app.ts` calls this at 4 Hz at most. It allocates (ten strings and the joined
// signature), which is why it is not on the per-frame path — see VR-PERF gap 27
// on per-frame allocation, and §5.5's "≤ 4 Hz, no canvas upload per frame".
//
// ── Quantisation constants ────────────────────────────────────────────────
//
// `MS` matches `boot/perf-hud.ts`'s: one decimal, because the DOM panel and the
// plate print the same numbers and two panels that round differently is a bug
// report waiting to happen.

import { formatCount, formatPercent } from './perf-hud'

/** Decimals a millisecond gets. One — `boot/perf-hud.ts`'s `MS`, deliberately. */
const MS = 1

/** Decimals the adaptive-resolution step gets. `x1.00`, as the DOM panel prints it. */
const SCALE_DP = 2

/**
 * Everything the ten rows need, already resolved.
 *
 * Deliberately flat and primitive: no renderer, no session, no recorder. The
 * caller (`boot/app.ts`) does the reading, so this module can be handed a
 * fixture in a node test and cannot reach anything that only exists in a
 * browser. The field order below is the row order.
 */
export interface PerfPlateModel {
  /** `BUILD_VERSION` — `v` followed by `package.json`'s `version` (DEV-315). */
  readonly version: string
  /** `BUILD_MODE` — `development` / `production`. Which build you are reading. */
  readonly mode: string
  /** `editionState.current.id` — `classic` or `anniversary`. */
  readonly edition: string
  /** The live mission id, or something short for "none" on the title screen. */
  readonly mission: string

  /** The frame budget in force, ms. */
  readonly budgetMs: number
  /** That budget as a rate. */
  readonly budgetHz: number
  /** `QualityReport.targetSource` — `override` / `session` / `measured` / `default` / `flat`. */
  readonly budgetSource: string
  /**
   * `modalHz().share` when the source is `measured`, else null.
   *
   * Printed ONLY for `measured`, because it is the confidence in a MEASUREMENT
   * and means nothing beside a number the runtime stated (§5.3 B). A share
   * printed next to `session` would invite the reading that the session's own
   * `frameRate` is 83 % certain.
   */
  readonly budgetShare: number | null
  /**
   * The rate frames are actually arriving at, when it is not `budgetHz`.
   *
   * DEV-161, and null is the ordinary case: on a machine keeping up, the
   * display's rate and ours are the same number and printing it twice would
   * only make the row longer. Non-null means a compositor has us in a tier —
   * worn 2026-09-17, a 90 Hz display with the app at 45 — and that is the one
   * state where the budget deliberately disagrees with the frame rate two rows
   * below, so the plate has to say so or it reads as a contradiction.
   */
  readonly budgetTierHz: number | null

  readonly fps: number
  readonly p50Ms: number
  readonly p95Ms: number
  readonly maxMs: number

  /**
   * `FrameStats.hitchFraction` — frames over 2 TIERS, as a fraction of the
   * window. The tier's, not the display's, since DEV-179.
   */
  readonly hitchFraction: number
  readonly hitches: number
  /**
   * `FrameStats.tierFraction` — frames the compositor could not present at the
   * display's rate. DEV-179.
   *
   * Printed beside the hitch rather than instead of it, because the pair is the
   * finding and either one alone is misread. Lap 4 was `hitch 73 %` against the
   * display, which reads as a broken frame loop; it was in fact a lap held
   * steadily at 30 Hz on a 90 Hz display — `hitch 1 % · tier 73 %`, which says
   * *the frame cost is the problem, not the frame pacing*, and points at a
   * different half of the backlog.
   */
  readonly tierFraction: number
  /** The window's frame count. Printed as the denominator, so a short window is visible. */
  readonly frames: number
  readonly engagedFraction: number
  /** `QualityReport.scale`. 1 at full resolution. */
  readonly scale: number

  /** The fixed-step block's own time — VR-PERF §5.2's `sim_ms`. */
  readonly simMs: number
  /** Fixed steps taken per frame over the window, low and high. Both 0 while snapped or paused. */
  readonly ticksMin: number
  readonly ticksMax: number
  /** Time inside `gpu.begin() … render … gpu.end()`, ms. */
  readonly renderMs: number
  /** The whole frame callback, ms — `render` plus everything else JavaScript did. */
  readonly jsMs: number

  /**
   * The GPU timer's percentiles over its FRESH samples, or null.
   *
   * Null is the important case and it is not an error: on the reach target and
   * in a session `EXT_disjoint_timer_query_webgl2` may be absent, and a row
   * reading `GPU p50 0.0` would be a measurement claim nobody made. See
   * `boot/gpu-timer.ts` — the column is lagged by a frame or two and must not
   * be lined up sample-for-sample with the rest of the row.
   */
  readonly gpu: {
    readonly p50Ms: number
    readonly p95Ms: number
    /** Harvested queries behind the two percentiles. */
    readonly samples: number
  } | null

  /**
   * Is an immersive session running? `xrProbe.presenting`.
   *
   * It decides ONE thing: whether the DRAW row carries the per-eye estimate.
   * Out of session there is one view, so halving `calls` reads low by two — and
   * a reader who does not carry the caveat in their head will file that number.
   * A row that says `(flat)` cannot be misread; a row that says `≈ 161/eye` off
   * a monocular frame can. See `eyeEstimate`.
   */
  readonly presenting: boolean

  /** `renderer.info.render.calls` — BOTH eyes plus the shadow pass. See `eyeEstimate`. */
  readonly calls: number
  readonly triangles: number
  /** `renderer.info.programs.length` — the compile count, which is what a hitch is made of. */
  readonly programs: number
  readonly geometries: number
  readonly textures: number

  readonly trace: {
    readonly status: 'idle' | 'recording' | 'done'
    /** Seconds recorded so far. */
    readonly recordedSeconds: number
    /** Seconds asked for (`?trace=<s>`). */
    readonly totalSeconds: number
    readonly frames: number
  }

  readonly xr: {
    /**
     * The constructor name of the layer three built — `XRWebGLLayer` or
     * `XRProjectionLayer`. VR-PERF gap 11 turns on which one it is: **fixed
     * foveation** is the layer's, and on the `XRWebGLLayer` path there is none.
     * Empty out of session.
     *
     * **This used to say `requestViewportScale` was the projection layer's
     * too, and that sentence was the bug** (DEV-236). Dynamic viewport scaling
     * is on `XRView` — no layer type has either half of it — and DEV-208 read
     * this paragraph, believed it, and called the method on the layer, where
     * the feature detection was false for six weeks in perfect silence.
     * `perf-surface.ts` was probing the VIEW correctly the whole time; the
     * prose here and the call in `render/quality.ts` were the only two places
     * that ever believed otherwise.
     */
    readonly layer: string
    /** `XRWebGLLayer.fixedFoveation`, or null where the layer has no such property. */
    readonly fixedFoveation: number | null
    /**
     * Eye 0's LIVE viewport width in device pixels — the `vp` field. 0 out of
     * session. DEV-236.
     *
     * ── This field REPLACED `XRView.recommendedViewportScale` ────────────
     *
     * There are three numbers here and the plate had been printing the least
     * useful of them under a label that got read as one of the other two:
     *
     *   · the UA's HINT, `recommendedViewportScale` — what `vp` used to be.
     *     Null on every runtime this project has measured, because desktop
     *     Chrome publishes no recommendation. Still on the probe, and still
     *     asserted there: `__ff2perf.xr().views[n].recommendedViewportScale`.
     *   · our ASK, `quality.report.viewportScale`, which is the `x0.60` already
     *     on the HITCH row.
     *   · the OUTCOME — this one. The per-eye rectangle three read back out of
     *     `getViewport(view)` and drew into.
     *
     * Only the third can say a resolution request was HONOURED, which is the
     * question the plate exists to answer in a headset and could not:
     * `framebufferWidth` below is the layer's TEXTURE, allocated once at
     * session start and unchanged by any request, so the row read the same
     * whether the request landed or was dropped on the floor — and for six
     * weeks it was being dropped.
     *
     * ── And it costs the plate no width, which is not a detail ───────────
     *
     * `render/perf-plate.ts` fits the type to the WIDEST row and XR is already
     * it (58 characters worn, against DRAW's 54). A fourth field here would
     * have been 70 and shrunk the type on all ten rows by a fifth — a
     * legibility change to an instrument read through a headset, invisible to
     * every string test, and the exact consequence that file's header tells a
     * row's author to check. Replacing rather than appending keeps the row at
     * 58 when there is no eye and 63 when there is.
     */
    readonly viewportWidth: number
    /** The XR framebuffer, device pixels. 0 × 0 out of session. */
    readonly framebufferWidth: number
    readonly framebufferHeight: number
    /**
     * `XRWebGLLayer.getNativeFramebufferScaleFactor` — the DENOMINATOR for the
     * pair above, or null where nothing reports one.
     *
     * The row prints `3522×1761 · ×1.00`, and the two halves together are the
     * whole of what the worn session turned out to be about: 1761 per eye on a
     * 2160 panel at a native scale of 1 is us asking for 0.6 of what the
     * runtime recommended (DEV-178). Either number alone says nothing — a
     * width with no scale is not a measurement of anything.
     */
    readonly nativeScale: number | null
  }
}

/** `NaN` and `Infinity` print as a dash rather than as `NaN` — a plate is read at a glance. */
const DASH = '—'

const ms = (value: number): string => (Number.isFinite(value) ? value.toFixed(MS) : DASH)

const int = (value: number): string => (Number.isFinite(value) ? String(Math.round(value)) : DASH)

/**
 * `3780` -> `3,780`. Not `toLocaleString`: that is the HOST's locale, so the
 * same build would print `3.780` on a German machine and two screenshots of the
 * same run would disagree. A plate is a measurement surface.
 */
const grouped = (value: number): string => {
  if (!Number.isFinite(value)) return DASH
  const digits = String(Math.round(Math.abs(value)))
  const sign = value < 0 ? '-' : ''
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * Draw calls per eye, ESTIMATED.
 *
 * `renderer.info.render.calls` is one number for the whole frame and three's
 * `ArrayCamera` draws the scene once per view, so in a session it holds both
 * eyes — **plus the shadow pass**, which `WebGLRenderer.render()` runs after the
 * `info.reset()` and which is drawn ONCE, not per eye (`boot/perf-hud.ts`'s
 * header has the three.js line numbers). Halving therefore under-counts the
 * eyes and over-counts the shadows, and the residual is the shadow pass's size:
 * DEV-118 measured 64 of `int_01`'s 270 monocular calls as shadow.
 *
 * It is printed anyway because M3's exit criterion is written per eye
 * (≤ 120 draw calls per eye) and a reader in a headset needs the comparison in
 * front of them rather than in their head. The row says `≈`, this note says why,
 * and the number that is EXACT is the one beside it.
 *
 * **Only while presenting.** Out of session there is one view, so halving a
 * monocular count reads low by two — and the first version of this row printed
 * it anyway, on the grounds that the plate exists for the headset. It does, and
 * a flat screenshot of it is still a screenshot somebody files. So `presenting`
 * switches the row to `(flat)` instead, which is a thing that cannot be misread
 * rather than a caveat that has to be remembered.
 */
export const eyeEstimate = (calls: number): number =>
  Number.isFinite(calls) ? Math.round(calls / 2) : 0

/**
 * The ten rows, top to bottom. Always exactly ten, whatever the model says —
 * `render/perf-plate.ts` lays out a fixed grid and a plate that grew a row
 * would silently drop one off the bottom.
 */
export const perfPlateLines = (model: PerfPlateModel): string[] => {
  const share =
    model.budgetSource === 'measured' && model.budgetShare !== null
      ? ` (${model.budgetShare.toFixed(SCALE_DP)})`
      : ''

  // `· app 45 Hz` only where it says something the row does not already. The
  // resolver reports `tierHz === displayHz` on a machine keeping up, and the
  // model nulls it there rather than making this line do the comparison —
  // whether we are in a tier is the resolver's finding, not a formatting one.
  const tier =
    model.budgetTierHz !== null && model.budgetTierHz !== model.budgetHz
      ? ` · app ${int(model.budgetTierHz)} Hz`
      : ''

  // `1–2 ticks` when the frame count varies over the window, `1 tick` when it
  // does not. The range is the whole point of the row: VR-PERF gap 23 is that
  // ONE stalled frame runs up to 20 fixed steps on the next one, so a max above
  // 2 is the hitch-causes-a-hitch signature made visible.
  const ticks =
    model.ticksMin === model.ticksMax
      ? `${int(model.ticksMin)} tick${model.ticksMin === 1 ? '' : 's'}`
      : `${int(model.ticksMin)}–${int(model.ticksMax)} ticks`

  const gpu = model.gpu
    ? `GPU p50 ${ms(model.gpu.p50Ms)} p95 ${ms(model.gpu.p95Ms)} ms (n=${grouped(model.gpu.samples)})`
    : 'GPU n/a (no timer query in session)'

  const t = model.trace
  const trace =
    t.status === 'recording'
      ? `TRACE rec ${int(t.recordedSeconds)}/${int(t.totalSeconds)} s · ${grouped(t.frames)} frames`
      : t.status === 'done'
        ? `TRACE done → __ff2perf.trace`
        : 'TRACE idle · ?trace=<s>'

  // The per-eye estimate is a SESSION reading; flat it would read low by two.
  const eyes = model.presenting ? `(2 eyes ≈ ${grouped(eyeEstimate(model.calls))}/eye)` : '(flat)'

  const xr = model.xr
  const framebuffer =
    xr.framebufferWidth > 0 && xr.framebufferHeight > 0
      ? `${int(xr.framebufferWidth)}×${int(xr.framebufferHeight)}`
      : DASH
  const foveation = xr.fixedFoveation === null ? DASH : xr.fixedFoveation.toFixed(SCALE_DP)
  // The OUTCOME, in pixels, not the UA's hint and not our ask (DEV-236). `px`
  // is on it because the unit is the whole point of the change: a bare `0.90`
  // here is what got read as "the request landed" through six weeks of frames
  // drawn at full size.
  const viewport = xr.viewportWidth > 0 ? `${int(xr.viewportWidth)}px` : DASH
  // Appended to the size rather than given its own field, because it is the
  // size's denominator and a reader who sees one without the other has been
  // given a number they cannot use. Nothing at all when there is no size.
  const native =
    framebuffer !== DASH && xr.nativeScale !== null
      ? `${framebuffer} · ×${xr.nativeScale.toFixed(SCALE_DP)}`
      : framebuffer

  return [
    `PERF ${model.version} ${model.mode} · ${model.edition} · ${model.mission}`,
    `BUDGET ${ms(model.budgetMs)} ms · ${int(model.budgetHz)} Hz ${model.budgetSource}${share}${tier}`,
    `FPS ${int(model.fps)} · p50 ${ms(model.p50Ms)} p95 ${ms(model.p95Ms)} max ${ms(model.maxMs)} ms`,
    `HITCH ${formatPercent(model.hitchFraction)} (${grouped(model.hitches)}/${grouped(model.frames)})` +
      ` · tier ${formatPercent(model.tierFraction)}` +
      ` · engaged ${formatPercent(model.engagedFraction)} · x${model.scale.toFixed(SCALE_DP)}`,
    `SIM ${ms(model.simMs)} ms (${ticks}) · RENDER ${ms(model.renderMs)} · JS ${ms(model.jsMs)}`,
    gpu,
    `DRAW ${grouped(model.calls)} calls ${eyes}` +
      ` · ${formatCount(model.triangles)} tri · ${int(model.programs)} prog`,
    `MEM ${grouped(model.geometries)} geo · ${grouped(model.textures)} tex`,
    trace,
    `XR ${xr.layer || DASH} · fov ${foveation} · vp ${viewport} · ${native}`,
  ]
}

/** The rows as one string. Equal signatures mean an identical plate — see the header. */
export const plateSignature = (lines: readonly string[]): string => lines.join('\n')
