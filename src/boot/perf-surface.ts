// src/boot/perf-surface.ts — `globalThis.__ff2perf`: the read-only handle that
// SHIPS.
//
// VR-PERF.md §5.4 (DEV-160), gap 3. `src/main.ts` hangs the whole `App` off
// `__ff2` inside an `import.meta.env.DEV` block, so on the deployed URL — which
// is the only URL a headset ever opens, because WebXR needs a real certificate
// — there is nothing to read. Every instrument this port has is invisible
// exactly where the measurements have to be taken.
//
// So there is a second handle, built only under `?perf=1`, and it is a
// different KIND of thing from `__ff2`. `__ff2` is the app: the renderer, the
// scene, the flight model, `editionState.set`. That is a debugging handle and
// it is fine in a dev build. This one goes out to anyone who types eleven
// characters into a query string, so it is:
//
//   1. **An allow-list, not a filter.** Every key below was written out by
//      hand. Nothing is reachable because it happened not to be excluded, and
//      `tests/unit/perf-surface.test.ts` pins the key set — so adding a getter
//      is a deliberate act with a test to update, which is the only way a
//      surface like this stays small.
//   2. **Snapshots, not references.** Every getter returns a frozen plain
//      object of numbers and strings. Nothing hands out an `Object3D`, a
//      material, a renderer or anything under `src/sim`: a reference is a
//      write, one `.position.set()` away. The test walks every snapshot looking
//      for `isObject3D` / `isWebGLRenderer` for exactly that reason.
//   3. **Read-only about the GAME.** `trace.start()` and `trace.stop()` mutate
//      the RECORDER, which is an instrument; nothing here changes what is
//      drawn, what is simulated or what is stored in the player's settings.
//      `?perf=1` may ADD instrumentation and must never change the build.
//
// Named `perfSurface` on the app and `__ff2perf` on the global, NOT `perf`:
// `render-census.spec.ts` and `bloom-perf.spec.ts` already read `__ff2.perf`
// and mean the frame recorder.

import type { GpuStats } from '@/boot/gpu-timer'
import type { FrameStats } from '@/boot/perf-recorder'
import type { TraceEyeProjection, TraceStatus, TraceSummary } from '@/boot/perf-trace'
import type { Census } from '@/boot/render-census'
import { type VisibilityMaskReport, visibilityMask } from '@/boot/visibility-mask'
import type { QualityReport } from '@/render/quality'

/** Where a stored trace lands. One key; `download()` is the way to get a file. */
export const TRACE_STORAGE_KEY = 'ff2.perf.trace.last'

/**
 * What an `XRView` and the live layer looked like the last time a frame could
 * be asked — see `refreshXrProbe`.
 *
 * Every field is a plain value copied out INSIDE the frame callback. `XRView`
 * reads throw between frames, so a getter that reached for one when the console
 * called it would throw about a third of the time and work the rest, which is
 * the worst possible behaviour for a diagnostic.
 */
export interface XrProbe {
  readonly presenting: boolean
  /** Meta's extension. `null` where the runtime does not report one — desktop Chrome. */
  readonly frameRate: number | null
  readonly supportedFrameRates: readonly number[] | null
  readonly enabledFeatures: readonly string[] | null
  /**
   * The CONSTRUCTOR NAME of the layer three is rendering into —
   * `XRWebGLLayer` or `XRProjectionLayer`. Spike 0's answer: three picks the
   * projection path on `'createProjectionLayer' in XRWebGLBinding.prototype`
   * alone, and that is true on this desktop's Chromium.
   */
  readonly layer: string | null
  /**
   * `fixedFoveation` as the LIVE layer object reports it, and whether the
   * property exists on it at all.
   *
   * Both halves, because they answer different questions and the pair is the
   * finding: `'fixedFoveation' in XRWebGLLayer.prototype` is FALSE on this
   * desktop (probed 2026-09-16), so `renderer.xr.setFoveation()` writes a value
   * nothing reads and the adaptive controller's only live knob does nothing. A
   * projection layer may differ, which is why this asks the object rather than
   * the prototype.
   */
  readonly fixedFoveation: number | null
  readonly hasFixedFoveation: boolean
  /**
   * The layer three is rendering into, in device pixels — BOTH eyes wide.
   *
   * Reads `textureWidth`/`textureHeight` first and falls back to
   * `framebufferWidth`/`framebufferHeight`, because those are two different
   * layer types' names for the same quantity and this probe has met both.
   * It shipped reading only the second pair, and three built an
   * `XRProjectionLayer` on the worn rig — so the first worn session's XR row
   * read `0 x 0` and the one number the session turned out to be about was the
   * one the probe could not see (DEV-160 §4, fixed in DEV-178's branch).
   */
  readonly framebuffer: { readonly w: number; readonly h: number } | null
  /**
   * `XRWebGLLayer.getNativeFramebufferScaleFactor(session)`, or null.
   *
   * The DENOMINATOR, and without it the width above is a number with no scale.
   * 1 means `framebuffer` is the runtime's own recommended resolution, so
   * `3522 x 1761` on a 2160 panel is us asking for 0.6 of it — which is what
   * the worn session was, and what DEV-178 fixed. A static on `XRWebGLLayer`
   * even when a projection layer is in use; absent in a node test, which is
   * the null case.
   */
  readonly nativeScale: number | null
  /** One entry per eye. `recommendedViewportScale` is the UA's hint, or null. */
  readonly views: readonly {
    readonly recommendedViewportScale: number | null
    readonly requestViewportScale: boolean
    /**
     * The eye's FRUSTUM and its slice of the layer (DEV-227), or `null` when
     * the view carried no usable `projectionMatrix`.
     *
     * The shape and the reasoning live on `TraceEyeProjection` in
     * `perf-trace.ts`, which owns it because the trace HEADER is its wire
     * format — one definition, so the probe and the stamp cannot drift into two
     * conventions for the same cone.
     */
    readonly projection: TraceEyeProjection | null
  }[]
  /**
   * What the lens mask reported this session (DEV-331): whether Chrome exposes
   * the event, and each eye's raw visible-region mesh. Optional, because it is
   * a record of events rather than a read of the frame. See
   * `boot/visibility-mask.ts` for why the mesh is raw.
   */
  readonly visibilityMask?: VisibilityMaskReport
}

export const IDLE_XR_PROBE: XrProbe = Object.freeze({
  presenting: false,
  frameRate: null,
  supportedFrameRates: null,
  enabledFeatures: null,
  layer: null,
  fixedFoveation: null,
  hasFixedFoveation: false,
  framebuffer: null,
  nativeScale: null,
  views: Object.freeze([]),
})

/**
 * The runtime's recommended framebuffer scale, or null where nothing says.
 *
 * Reads the global `XRWebGLLayer` — a static, so it answers for a projection
 * layer too — behind a `typeof` guard, because the constructor does not exist
 * in `environment: 'node'` and a diagnostic that throws is worse than no
 * diagnostic. Exported so a test can stub the global and prove the read.
 */
export const nativeFramebufferScale = (session: unknown): number | null => {
  const ctor = (
    globalThis as { XRWebGLLayer?: { getNativeFramebufferScaleFactor?(s: unknown): number } }
  ).XRWebGLLayer
  if (!ctor || typeof ctor.getNativeFramebufferScaleFactor !== 'function' || !session) return null
  try {
    const value = ctor.getNativeFramebufferScaleFactor(session)
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

/**
 * One `XRView`'s frustum, out of its `projectionMatrix` (DEV-227).
 *
 * `null` for anything shorter than sixteen entries, `null` if any of the FOUR it
 * reads is not finite, and `null` for a matrix whose `m[0]` or `m[5]` is zero —
 * a degenerate frustum divides by zero, and a diagnostic that answered
 * `Infinity` there would be filed as a field of view. It does not validate the
 * twelve entries it does not use; a matrix that is nonsense only in its depth
 * range still has a real cone in it, and refusing to report that would be
 * fussiness rather than honesty.
 *
 * The convention — four SIGNED tangents, `XrFovf`/`FovPort` style — and the
 * algebra that gets them out of a column-major GL projection matrix are written
 * out on `TraceEyeProjection`. This function is the only place that algebra
 * exists, and `tests/unit/xr-eye-projection.test.ts` §2 checks it against
 * matrices built FORWARDS from known frustum edges rather than against itself
 * (CLAUDE.md, trap 24: a test that re-derives its expectation the way the code
 * does has not tested the code).
 *
 * Exported so that test can call it without a session.
 */
export const projectionFromMatrix = (
  raw: unknown,
  eye: string,
  viewport: TraceEyeProjection['viewport'],
): TraceEyeProjection | null => {
  const m = raw as ArrayLike<number> | null | undefined
  if (!m || typeof m.length !== 'number' || m.length < 16) return null
  const xScale = m[0] as number
  const yScale = m[5] as number
  const xSkew = m[8] as number
  const ySkew = m[9] as number
  if (![xScale, yScale, xSkew, ySkew].every((v) => typeof v === 'number' && Number.isFinite(v))) {
    return null
  }
  if (xScale === 0 || yScale === 0) return null
  return Object.freeze({
    eye,
    tanUp: (1 + ySkew) / yScale,
    tanDown: (ySkew - 1) / yScale,
    tanLeft: (xSkew - 1) / xScale,
    tanRight: (1 + xSkew) / xScale,
    viewport,
  })
}

/** The slice of `renderer.xr` the probe reads. Structural, so a test can fake it. */
export interface XrProbeSource {
  readonly isPresenting: boolean
  getSession(): unknown
  getFrame(): unknown
  getReferenceSpace(): unknown
  getBaseLayer(): unknown
  /**
   * three's `ArrayCamera` for this session — the per-eye VIEWPORT's source, and
   * deliberately not a second reader of the layer (DEV-227).
   *
   * An eye's viewport comes off `XRWebGLLayer.getViewport(view)` on one path
   * and `XRWebGLBinding.getViewSubImage(layer, view).viewport` on the other,
   * and this rig takes the second (`XrProbe.layer` reads `XRProjectionLayer`).
   * three has already made whichever call applies by the time our animation
   * callback runs — `WebXRManager.onAnimationFrame` fills
   * `cameras[i].projectionMatrix` and `cameras[i].viewport` and only THEN calls
   * `onAnimationFrameCallback` — so this reads a `Vector4` three already
   * populated this frame. Asking the binding ourselves would be a second reader
   * of the same thing, with a second chance to be wrong about which layer type
   * is live, for no new information.
   *
   * Optional because it is the one field a caller can be missing without the
   * probe becoming a lie: no camera means no viewport, which reports as `null`.
   */
  getCamera?(): unknown
}

/**
 * Per-eye viewports out of three's array camera, indexed by view.
 *
 * Every failure is `null` for that eye rather than a throw: a missing camera, a
 * camera list of a different length from the view list (which happens for one
 * frame when a session changes shape), or a `Vector4` with a non-finite field.
 */
const eyeViewports = (
  xr: XrProbeSource,
  views: number,
): (TraceEyeProjection['viewport'] | null)[] => {
  const out = new Array<TraceEyeProjection['viewport'] | null>(views).fill(null)
  const cameras = (xr.getCamera?.() as { cameras?: { viewport?: unknown }[] } | null)?.cameras
  if (!Array.isArray(cameras)) return out
  for (let i = 0; i < views; i++) {
    const v = cameras[i]?.viewport as { x?: number; y?: number; z?: number; w?: number } | undefined
    if (!v) continue
    // three stores it as a `Vector4` of (x, y, WIDTH, HEIGHT) — so `z` is the
    // width and `w` is the height, which is the one thing about this read that
    // is easy to get backwards and impossible to see once it is wrong.
    const [x, y, w, h] = [v.x, v.y, v.z, v.w]
    if (![x, y, w, h].every((n) => typeof n === 'number' && Number.isFinite(n))) continue
    out[i] = Object.freeze({ x: x as number, y: y as number, w: w as number, h: h as number })
  }
  return out
}

/**
 * Eye 0's live viewport WIDTH in device pixels, or 0 where there is no eye.
 *
 * The trace's `vp_w` column (DEV-236), and the ONE thing in this project that
 * can say whether a `requestViewportScale` was honoured. `scale` on the plate
 * and in the trace is what the controller asked for; this is what the runtime
 * gave, and between DEV-208 and DEV-236 those two disagreed for six weeks with
 * nothing able to notice, because the ask was recorded per frame and the
 * outcome was recorded once in a header.
 *
 * Same `Vector4`, same reasoning and the same z-is-WIDTH trap as
 * `eyeViewports` above — deliberately a second small function rather than a
 * call into that one, because that one allocates an array and a frozen object
 * per eye and this is read on EVERY frame of a recording trace. Allocation-free
 * feeds are the whole of `TraceSample`'s note.
 *
 * Eye 0 only. Both eyes carry the same width on every runtime we can reach, and
 * a column that could disagree per eye is two columns; if a runtime ever scales
 * the eyes independently, that is the day this becomes `vp_w0,vp_w1` and the
 * append rule in `COLUMNS` is what makes that cheap.
 */
export const eyeViewportWidth = (xr: Pick<XrProbeSource, 'getCamera'>): number => {
  const w = (xr.getCamera?.() as { cameras?: { viewport?: { z?: number } }[] } | null)?.cameras?.[0]
    ?.viewport?.z
  return typeof w === 'number' && Number.isFinite(w) ? w : 0
}

/**
 * Read the session, the layer and the views — INSIDE a frame callback.
 *
 * Everything it touches can be absent or can throw: `getFrame()` is null out of
 * session, `getViewerPose` returns null while tracking is lost, and an `XRView`
 * read outside its own frame throws `InvalidStateError`. So the whole thing is
 * one try/catch that falls back to the idle probe. A diagnostic that can take
 * the frame loop down is worse than no diagnostic.
 */
export const refreshXrProbe = (xr: XrProbeSource): XrProbe => {
  if (!xr.isPresenting) return IDLE_XR_PROBE
  try {
    const session = xr.getSession() as {
      frameRate?: number
      supportedFrameRates?: Float32Array | number[]
      enabledFeatures?: string[]
    } | null
    const layer = xr.getBaseLayer() as {
      fixedFoveation?: number
      // An `XRProjectionLayer`'s names...
      textureWidth?: number
      textureHeight?: number
      // ...and an `XRWebGLLayer`'s. Both live; see `XrProbe.framebuffer`.
      framebufferWidth?: number
      framebufferHeight?: number
    } | null
    const frame = xr.getFrame() as {
      getViewerPose?: (space: unknown) => { views?: unknown[] } | null
    } | null
    const space = xr.getReferenceSpace()
    const rawViews = (frame?.getViewerPose?.(space)?.views ?? []) as {
      recommendedViewportScale?: number | null
      requestViewportScale?: unknown
      // DEV-227. `XRView.projectionMatrix` is a `Float32Array(16)` the runtime
      // owns — read here, straight off the view, and NOT off three's eye
      // camera. three copies this into `camera.projectionMatrix` unchanged
      // today, but its job is to render, so a future version composing a
      // union frustum or a multiview variant would change that copy and not
      // this. The stamp has to be what the RUNTIME asked for.
      projectionMatrix?: unknown
      eye?: unknown
    }[]
    const viewports = eyeViewports(xr, rawViews.length)

    return Object.freeze({
      presenting: true,
      frameRate: typeof session?.frameRate === 'number' ? session.frameRate : null,
      supportedFrameRates: session?.supportedFrameRates
        ? Object.freeze(Array.from(session.supportedFrameRates))
        : null,
      enabledFeatures: session?.enabledFeatures
        ? Object.freeze(Array.from(session.enabledFeatures))
        : null,
      layer: layer ? layer.constructor.name : null,
      fixedFoveation: typeof layer?.fixedFoveation === 'number' ? layer.fixedFoveation : null,
      hasFixedFoveation: layer !== null && 'fixedFoveation' in layer,
      // `textureWidth` FIRST. A projection layer has only that pair, and it is
      // the layer three built on the rig this was worn on.
      framebuffer: layer
        ? Object.freeze({
            w: layer.textureWidth ?? layer.framebufferWidth ?? 0,
            h: layer.textureHeight ?? layer.framebufferHeight ?? 0,
          })
        : null,
      nativeScale: nativeFramebufferScale(session),
      visibilityMask: visibilityMask.report(),
      views: Object.freeze(
        rawViews.map((v, i) =>
          Object.freeze({
            recommendedViewportScale:
              typeof v.recommendedViewportScale === 'number' ? v.recommendedViewportScale : null,
            requestViewportScale: typeof v.requestViewportScale === 'function',
            projection: projectionFromMatrix(
              v.projectionMatrix,
              // `'none'` is the spec's own word for a monoscopic view, so it is
              // a reading rather than a placeholder. A view with no `eye` at
              // all is a runtime we have not met; say so rather than guess a
              // side, because "which eye was this" is exactly the thing a
              // reproduction needs and exactly the thing nobody can recover
              // later.
              typeof v.eye === 'string' ? v.eye : 'unknown',
              viewports[i] ?? null,
            ),
          }),
        ),
      ),
    })
  } catch {
    // Tracking lost, a view read out of frame, a runtime that answers none of
    // this. The last good probe is the caller's to keep; this call simply
    // reports that it could not look.
    return IDLE_XR_PROBE
  }
}

/**
 * What a trace header stamps for the frustum, from the last probe (DEV-227).
 *
 * THREE ANSWERS, and the distinction between them is the reason this is a named
 * function with a test rather than a ternary inside `traceMeta()`:
 *
 *   - **`null` — there was no session.** The flat path. A flat frame has no
 *     `XRView`s, so it has no per-eye projection, and the only honest stamp is
 *     the absence of one: *the only failure mode that cannot be mistaken for a
 *     pass.* A
 *     zeroed pair of eyes here would be a field of view of nothing, which is a
 *     number, and numbers get filed.
 *   - **`[]` — presenting, but nothing to read.** Tracking lost on the frame the
 *     probe looked, or a runtime whose views carry no parseable
 *     `projectionMatrix`. Different from the above: there WAS a headset, and
 *     that changes what the reading is of.
 *   - **One entry per eye.** The answer everything else exists to produce.
 */
export const eyeProjections = (probe: XrProbe): readonly TraceEyeProjection[] | null =>
  probe.presenting
    ? Object.freeze(probe.views.flatMap((v) => (v.projection === null ? [] : [v.projection])))
    : null

/**
 * DEV-537: a room as the deployed build can read it, for MULTIPLAYER §9.4's
 * two-machine test. `__ff2.room()` holds all of this and more, and does not
 * exist on the URL the test is run on (`main.ts`: dev only). Plain numbers:
 * the clock, and each other ship's track as it is drawn this frame. `inRoom`
 * false (and nulls) outside a room, so the getter always hands back an object.
 */
export interface RoomReading {
  readonly inRoom: boolean
  readonly status: string | null
  readonly phase: string | null
  readonly slot: number | null
  /** The room clock (DEV-387): synced, its round trip and its offset, ms. */
  readonly synced: boolean
  readonly rttMs: number | null
  readonly offsetMs: number | null
  /**
   * Each other ship (bots included, `slot` negative): its drawn name, the
   * track's mode (`interp` is the healthy one; `extrap`/`hold` is a ship being
   * guessed or frozen), whether it is stale, its adaptive delay (how far behind
   * its sender it is drawn, ms) and the ticks it is drawn at and holds.
   */
  readonly ships: readonly {
    readonly slot: number
    readonly handle: string
    readonly mode: string
    readonly stale: boolean
    readonly delayMs: number | null
    readonly renderTick: number | null
    readonly newestTick: number | null
  }[]
}

export interface PerfSurfaceDeps {
  version(): { version: string; mode: string }
  edition(): { id: string; speedFx: number }
  mission(): { id: string; mode: string }
  settings(): { quality: string; foveation: boolean; adaptiveResolution: boolean }
  stats(): FrameStats
  budget(): {
    ms: number
    /** `1 / targetSeconds` — the DISPLAY's rate, which is what the budget is. */
    hz: number
    source: string
    /** DEV-161: the display's rate, and the rate frames are actually arriving at. */
    displayHz: number
    tierHz: number
    /**
     * DEV-179: is `displayHz` higher than THIS window alone would have said?
     *
     * The question a reader asks the first time they see `90 Hz display` beside
     * a `modal` with no 90 in it. True means the session saw 90 earlier, or
     * `?hz=` said so; false means this window did.
     */
    sticky: boolean
    /** Fraction of the window's frames that arrived below `displayHz`. */
    dropping: number
    modal: { hz: number; share: number; frames: number }
  }
  quality(): QualityReport
  gpu(): { supported: boolean; enabled: boolean } & GpuStats & { last: number; harvested: number }
  info(): {
    frame: number
    calls: number
    triangles: number
    points: number
    lines: number
    programs: number
    geometries: number
    textures: number
  }
  sim(): { tick: number; elapsed: number; ticksPerSecond: number; snapped: boolean }
  session(): XrProbe
  census(): Census
  /** A monotonically increasing frame counter — `census()`'s once-per-frame guard. */
  frameIndex(): number
  trace: {
    start(seconds: number): void
    stop(): void
    status(): TraceStatus
    frames(): number
    summary(): TraceSummary
    dump(): string
  }
  /** Frames that threw. See `guardedFrame` — a freeze nobody could read. */
  errors(): { count: number; last: string }
  /** DEV-537: the room this page is in, for the two-machine test. */
  room(): RoomReading
  /** The multi-run capture the pause plate drives. See `boot/perf-capture.ts`. */
  capture: {
    recording(): boolean
    runs(): number
    missions(): string[]
    toggle(): void
    payload(): unknown
    digest(): unknown
  }
}

export interface PerfSurface {
  version(): unknown
  edition(): unknown
  mission(): unknown
  settings(): unknown
  stats(): unknown
  budget(): unknown
  quality(): unknown
  gpu(): unknown
  info(): unknown
  sim(): unknown
  session(): unknown
  census(): unknown
  readonly trace: {
    start(seconds: number): void
    stop(): void
    status(): TraceStatus
    frames(): number
    summary(): unknown
    dump(): string
    last(): string | null
    download(): boolean
  }
  errors(): unknown
  room(): unknown
  readonly capture: {
    recording(): boolean
    runs(): number
    missions(): unknown
    toggle(): void
    payload(): unknown
    digest(): unknown
  }
}

/**
 * The keys `__ff2perf` has, and the only ones it may ever have.
 *
 * Exported so the test asserts against THIS rather than against a copy of the
 * list — the copy is what goes stale (CLAUDE.md on derivable numbers). Adding a
 * key here without adding the getter, or the other way round, fails the test.
 */
export const PERF_SURFACE_KEYS = [
  'version',
  'edition',
  'mission',
  'settings',
  'stats',
  'budget',
  'quality',
  'gpu',
  'info',
  'sim',
  'session',
  'census',
  'trace',
  'capture',
  'errors',
  'room',
] as const

/**
 * `capture`'s keys, listed here for the same reason `TRACE_KEYS` is: the test
 * asserts against THIS rather than against a copy, so a getter added without a
 * key — or a key without a getter — goes red.
 */
export const CAPTURE_KEYS = [
  'recording',
  'runs',
  'missions',
  'toggle',
  'payload',
  'digest',
] as const

export const TRACE_KEYS = [
  'start',
  'stop',
  'status',
  'frames',
  'summary',
  'dump',
  'last',
  'download',
] as const

/** What a value that could not be safely copied is replaced by. */
export const DROPPED = '[not a plain value]'

/**
 * A deep, frozen copy containing only plain data.
 *
 * FREEZING IS NOT ENOUGH, and that is the whole reason this is a copy rather
 * than a recursive `Object.freeze`. A frozen object that holds a reference to a
 * `Mesh` still hands out the `Mesh` — and `Object.freeze` on the snapshot does
 * not freeze the mesh's `position`, so `__ff2perf.quality().renderer.something`
 * would be a live write into the running game through a "read-only" handle.
 * The unit test puts an object claiming `isWebGLRenderer` inside a snapshot for
 * exactly this, and the first version of this function passed it straight
 * through.
 *
 * So: primitives are copied, arrays and PLAIN objects are rebuilt key by key,
 * and anything else — a class instance, a function, a typed array, an
 * `Object3D` — is replaced by `DROPPED`. A marker rather than a silent omission
 * because this is a diagnostic: a field that vanished reads as a field that
 * does not exist, and the next person would go looking for why.
 *
 * The allow-list above says which GETTERS exist; this says what may come back
 * through one. Both are needed — the getters are reviewed by hand, and this is
 * what holds when somebody adds a field to `QualityReport` in a year's time.
 */
const plainFrozen = (value: unknown): unknown => {
  if (value === null) return null
  const type = typeof value
  if (type === 'number' || type === 'string' || type === 'boolean' || type === 'undefined') {
    return value
  }
  if (type !== 'object') return DROPPED
  if (Array.isArray(value)) return Object.freeze(value.map(plainFrozen))
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return DROPPED
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = plainFrozen(v)
  }
  return Object.freeze(out)
}

const snapshot = <T>(value: T): T => plainFrozen(value) as T

/** `document`/`Blob`/`URL` may all be absent (a worker, a node test). Then: no download. */
const downloadText = (name: string, text: string): boolean => {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    // Revoked on a turn of the event loop rather than immediately: Chrome reads
    // the object URL asynchronously after the click and a synchronous revoke
    // races it.
    setTimeout(() => {
      URL.revokeObjectURL(url)
    }, 10_000)
    return true
  } catch {
    return false
  }
}

export interface PerfSurfaceOptions {
  /** `localStorage`, or null where touching it throws. `game/personal-best.ts`'s. */
  readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null
}

export const createPerfSurface = (
  deps: PerfSurfaceDeps,
  options: PerfSurfaceOptions,
): PerfSurface => {
  const storage = options.storage
  /**
   * `census()` draws FIVE extra off-screen frames and stalls the one it is
   * called on (see `render-census.ts`), so a console loop — or a plate, or an
   * over-eager spec — calling it every frame would turn a diagnostic into the
   * thing being diagnosed. One per frame, and a second call in the same frame
   * gets the first one's answer back.
   */
  let censusFrame = -1
  let censusCached: Census | null = null

  return Object.freeze({
    version: () => snapshot(deps.version()),
    edition: () => snapshot(deps.edition()),
    mission: () => snapshot(deps.mission()),
    settings: () => snapshot(deps.settings()),
    stats: () => snapshot({ ...deps.stats() }),
    budget: () => snapshot(deps.budget()),
    quality: () => snapshot({ ...deps.quality() }),
    gpu: () => snapshot(deps.gpu()),
    info: () => snapshot(deps.info()),
    sim: () => snapshot(deps.sim()),
    session: () => snapshot(deps.session()),
    census: () => {
      const now = deps.frameIndex()
      if (censusFrame === now && censusCached) return censusCached
      censusFrame = now
      censusCached = snapshot(deps.census())
      return censusCached
    },
    // Frozen in its own right: `Object.freeze` is SHALLOW, so freezing the
    // surface leaves a nested object literal writable — and `__ff2perf.trace.
    // start = …` from a console is exactly the kind of reach-in this handle
    // exists to refuse.
    trace: Object.freeze({
      start: (seconds: number) => {
        deps.trace.start(seconds)
      },
      stop: () => {
        deps.trace.stop()
      },
      status: () => deps.trace.status(),
      frames: () => deps.trace.frames(),
      summary: () => snapshot(deps.trace.summary()),
      dump: () => deps.trace.dump(),
      /**
       * The last trace `?trace=` stored, as the text `dump()` produced.
       *
       * The workflow this exists for: fly it in the headset, take the headset
       * off, read it on the desktop. There is no devtools mid-flight.
       */
      last: () => {
        try {
          return storage?.getItem(TRACE_STORAGE_KEY) ?? null
        } catch {
          return null
        }
      },
      /** Save the stored trace as a file. False where there is nothing, or no DOM. */
      download: () => {
        let text: string | null = null
        try {
          text = storage?.getItem(TRACE_STORAGE_KEY) ?? null
        } catch {
          text = null
        }
        if (!text) return false
        return downloadText(`ff2-perf-trace-${Date.now()}.csv`, text)
      },
    }),
    errors: () => snapshot(deps.errors()),
    room: () => snapshot(deps.room()),
    // Frozen in its own right, like `trace`, and for the same reason: freezing
    // the surface is SHALLOW.
    capture: Object.freeze({
      recording: () => deps.capture.recording(),
      runs: () => deps.capture.runs(),
      missions: () => snapshot(deps.capture.missions()),
      toggle: () => {
        deps.capture.toggle()
      },
      /**
       * Everything the capture holds, CSVs included — the recovery when a
       * browser refuses the download the pause row tried to make. `snapshot`
       * rather than the live object, because this handle hands out plain data
       * and never a reference something could write back through.
       */
      payload: () => snapshot(deps.capture.payload()),
      digest: () => snapshot(deps.capture.digest()),
    }),
  })
}
