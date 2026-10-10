// src/boot/perf-trace.ts — every frame of a run, kept, so "where does it dip?"
// has an answer.
//
// VR-PERF.md §5.2 (DEV-160). `boot/perf-recorder.ts` keeps a THREE-SECOND RING
// and reports percentiles over it; that is the right shape for a live overlay
// and the wrong one for the thing Part 1 exists to produce. A worn soak asks
// questions a window cannot answer:
//
//   - *Where* did the frame go long? A ring has thrown the frame away by the
//     time you take the headset off, and in a headset there is no devtools to
//     catch it in. So this keeps the WHOLE run, with the ship's position and
//     the draw counts on every row, and `summary().worst` is the five worst
//     frames with the coordinates to fly back to.
//   - Was that the sim or the render? The recorder sees one number per frame,
//     the wall delta, and a wall delta at vsync is the compositor's opinion
//     rather than a cost (gpu-timer.ts's header makes the same point). This
//     stores the brackets `app.ts` puts round `stepFixed` and round the render
//     as separate columns, so the three add up — or visibly do not, which is
//     itself the finding (a `dt` at budget with everything under it is the
//     compositor or, on a streamed headset, the encoder).
//
// A WINDOW FROM `start()`, NOT A RING. The recorder's ring answers "what is
// happening now"; this answers "what happened during that flight", and a ring
// would quietly drop the first half of a two-minute soak. When the buffer fills
// it STOPS rather than wrapping, and `summary().overflowed` says so out loud —
// a truncated trace that knows it is truncated beats a complete-looking one
// that is not.
//
// Three-free and DOM-free, like `perf-recorder.ts`, so it is a plain node test.
// `performance.now()` is not used here either: the timings arrive as numbers
// from `app.ts`, which owns every clock (`src/boot/` may call the platform
// clock; `src/sim/` may not — CLAUDE.md rule 4).
//
// ── Feeding it costs one object, forever ─────────────────────────────────
//
// `frame(sample)` writes 15 floats into a typed array and does nothing else —
// no closure, no object, no array. That only holds if the CALLER does not
// allocate either, which is why `TraceSample` is a mutable interface rather
// than a readonly one: `app.ts` creates exactly one, assigns its fields each
// frame and hands it by reference. Gap 27 in the brief counts ~25–35 small
// objects a frame already; an instrument that adds one per frame would be
// measuring itself.
//
// ── The GPU column is LAGGED, and must not be read sample-for-sample ──────
//
// `EXT_disjoint_timer_query_webgl2` answers a frame or two late and skips a
// frame here and there (gpu-timer.ts says why). So `gpu_ms` on row N is the
// newest result that had LANDED by frame N — usually frame N-1 or N-2's, and on
// a frame where nothing landed it is a repeat of the row above. `gpu_fresh` is
// 1 only on the frames where a new result actually arrived, and every reader in
// here filters on it. Lining `gpu_ms` up against `render_ms` on the same row is
// the mistake this column exists to make possible to avoid, not to make.

import { percentile } from '@/boot/perf-recorder'
import type { VisibilityMaskReport } from '@/boot/visibility-mask'
import { DEG_PER_RAD } from '@/sim/math/scalar'

/**
 * The columns, in the order they are stored and dumped.
 *
 * Exported because `dump()` writes them into its header line, so anything that
 * reads a trace back — a spreadsheet, a notebook, a future spec — takes the
 * order from the file rather than from a copy of this list. A name here is a
 * wire format.
 */
export const COLUMNS = [
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
  // DEV-179, and it is PER FRAME rather than a field in the header for the one
  // reason the row exists: the tier is the thing that MOVES. SteamVR walked lap
  // 4 between 45 and 30 as our GPU crossed ~11 ms, and a single number stamped
  // at `start()` would be wrong for most of the run and silently right at the
  // beginning of it — the most expensive kind of wrong. The display's interval
  // stays in the header, because that one really is a constant of the session.
  'tier_ms',
  // ── DEV-177(b): what the WORLD was doing on that frame ────────────────────
  //
  // The ~15 s and ~23 s stalls on `int_01` are position-locked, 100–150 ms, and
  // carry NO program change — so they are not compiles, and the trace had no
  // column that could say what else they might be. `programs` names one hitch
  // source; these name the others: a chunk reply being turned into a geometry
  // on the main thread, a detail chunk landing, a cross-fade drawing two
  // chunks' triangles at once, and a prop coming apart into six meshes.
  //
  // APPENDED, never inserted. The column list is a wire format
  // (`perf-trace.spec.ts` checks the JSON header and the CSV header against
  // each other) and the offsets below are read in four places in this file; a
  // new column in the middle renumbers every one of them and reads as a
  // plausible number in the wrong column, which is the kind of wrong that gets
  // believed. A reader that takes its order from the header is unaffected
  // either way; a reader that hard-coded `row[12]` is not, and appending is
  // what keeps that reader right.
  'terr_pending',
  'terr_detail',
  'terr_fading',
  // The OCEAN's two, and they are not symmetry for its own sake. The sea is
  // four to six chunks against the land's 256, but `subdivisionByLod` gives an
  // Anniversary sea chunk 8× subdivision at LOD 0 — **~150 k triangles in one
  // draw call**, fifty times a land chunk and the largest single draw in the
  // frame. The first version of these columns read the land alone and showed
  // all zeros at both of the stalls this row was opened for; what had actually
  // happened was one sea chunk going LOD 1 → LOD 0. A counter that cannot see
  // the biggest object in the frame is a counter that will be believed anyway.
  'sea_pending',
  'sea_fading',
  'pieces',
  // ── DEV-236: the pixels the frame was actually drawn into ────────────────
  //
  // `scale` (column 11) is what the adaptive controller ASKED FOR. This is what
  // the runtime GAVE — eye 0's viewport width in device pixels, straight off
  // three's own eye camera, which is where `WebXRManager` writes the value it
  // read back from `getViewport(view)` / `getViewSubImage(...).viewport`.
  //
  // The two were never the same column and for six weeks they were never the
  // same NUMBER: `scale` read 0.600 through whole traces while DEV-227's
  // recorded header viewport read the full 2016 x 2016, because
  // `requestViewportScale` was being called on the projection LAYER, which has
  // no such method. Nothing could see that, because the ask and the outcome
  // lived in different files and only one of them was in the trace.
  //
  // **An instrument that records only what it requested cannot notice that the
  // request was refused.** Both halves, one row, and the e2e summary refuses
  // when they disagree.
  'vp_w',
  // ── DEV-243: the cockpit HUD's repaints, CUMULATIVE ──────────────────────
  //
  // The panel is a 560 × 203 `CanvasTexture` and every repaint re-uploads the
  // whole canvas from inside `renderer.render` — inside `app.ts`'s
  // `gpu.begin() … gpu.end()` bracket, therefore inside `gpu_ms` on this very
  // row. `render/hud.ts`'s DEV-243 block carries three's own line numbers.
  // `VR-PERF-WAVE-4.md` §3.5 queue H reads this one object as the whole of the
  // vehicle group's ±1.7 ms per-frame residual, so the repaint rate belongs
  // beside the milliseconds it is suspected of moving.
  //
  // **A LEVEL, not a 0/1 flag, and the reason is `gpu_fresh`.** Every GPU
  // reader in this repo filters to fresh rows — `gpu_ms` lags, so it must. A
  // per-frame 0/1 column averaged over that subset would report the repaint
  // rate of the fresh frames and call it the run's, which is wrong by whatever
  // the harvest cadence happens to be. A cumulative count differenced between
  // any two rows is still exactly the repaints between them, on any subset.
  //
  // float32 holds an integer exactly to 2^24, and the cap is 300 s at one
  // repaint a frame, so this column cannot lose a count to the storage.
  'hud_paints',
  // ── DEV-243: and the CONTROL's repaints, on the same terms ───────────────
  //
  // `render/perf-plate.ts` is the same kind of object as the HUD — a
  // `CanvasTexture` on the flight object at the same pixel density, same
  // `toneMapped: false`, same `UI_LAYER`, one transparent quad — and it is 49 %
  // MORE canvas (504 × 336 against 560 × 203) repainting at 4 Hz at most
  // against the HUD's ~frame rate. Queue H priced the pair at −0.30 p95
  // against −2.35.
  //
  // **Two panels, two rates, one mechanism is a much stronger row than one
  // panel**, and it is only a row if both rates are in the same file. This
  // column is what makes the pair readable out of one trace instead of
  // reconstructed from two probe lines and a memory of which run was which.
  //
  // Cumulative, for `hud_paints`' reason exactly: every GPU reader filters to
  // `gpu_fresh` rows. 0 without `?perf=1`, which is also the honest reading —
  // **there is no plate in a player's session**, so ~0.3 ms of p95 in every
  // trace this programme has ever taken is the instrument and nobody playing
  // the game pays it.
  'plate_paints',
  // ── DEV-261: which PART of the session this frame is ─────────────────────
  //
  // 0 pre-flight (menus, the hangar, the lift ride), 1 flying, 2 past the
  // run-over. Added when `?perf=1` started recording from BOOT rather than
  // from the release, which is the whole reason this column has to exist: an
  // open-ended trace contains 100 s of elevator, and a p95 taken over the
  // whole of one is a statistic about a cutscene. Every reader that wants
  // "the flight" filters on `phase == 1`.
  //
  // It is also the instrument the 45 Hz report needs. The tier is lost at the
  // race start and the old arming began there, so no capture has ever held
  // the frames either side of it; `phase` 0 -> 1 is that edge, named, so the
  // transition can be found without inferring it from `ship_x`.
  'phase',
  // ── DEV-335: which Advanced-page rows were ON, per frame ─────────────────
  //
  // A bitmask, bit i = the i-th row, as the page SHOWS it (the renderer's
  // answer, DEV-302). The names travel in the header's `featureBits`, so a
  // reader takes the order from the file. Matt, after the second worn
  // flight: the detail ring *"seemed to be the biggest win"*, and the capture
  // could not say: every press left only a program-count step behind it.
  // Appended, like every column since DEV-177(b).
  'features',
] as const

export const STRIDE = COLUMNS.length

// Column offsets. Named rather than inlined because a trace row is read in
// four places in this file and an off-by-one in any of them is a plausible
// number in the wrong column, which is the kind of wrong that gets believed.
const C_DT = 0
const C_TICKS = 1
const C_SIM = 2
const C_RENDER = 3
const C_FRAME = 4
const C_GPU = 5
const C_GPU_FRESH = 6
const C_CALLS = 7
const C_TRIS = 8
const C_PROGRAMS = 9
const C_SCALE = 10
const C_HZ = 11
const C_SHIP_X = 12
const C_SHIP_Z = 13
const C_ELAPSED = 14
const C_TIER = 15
const C_TERR_PENDING = 16
const C_TERR_DETAIL = 17
const C_TERR_FADING = 18
const C_SEA_PENDING = 19
const C_SEA_FADING = 20
const C_PIECES = 21
const C_VP_W = 22
const C_HUD_PAINTS = 23
const C_PLATE_PAINTS = 24
const C_PHASE = 25
const C_FEATURES = 26

/** `TraceSample.phase`, and the `phase` column's three values. */
export const PHASE_PRE_FLIGHT = 0
export const PHASE_FLYING = 1
export const PHASE_RUN_OVER = 2

/**
 * The longest trace `?trace=` will take, seconds.
 *
 * Five minutes is longer than any mission (the longest 2016 course is under
 * three) and it is the number the storage decision rests on: at 240 rows a
 * second the buffer is 72,000 × 15 float32 = **4.3 MB**, and its `dump()` is
 * roughly the same again as text — inside `localStorage`'s usual 5 MB per
 * origin for a single key only because nothing else in this game stores
 * anything like it. Beyond this the honest answer is a file, not a key, and
 * `?trace=` would be the wrong tool.
 *
 * (VR-PERF §5.2 estimates 2.6 MB at the cap. That figure is for the floats at
 * 144 Hz, not at the 240 Hz capacity the same paragraph specifies; the number
 * above is 72,000 × 15 × 4 measured, not estimated.)
 */
export const MAX_TRACE_SECONDS = 300

/**
 * Rows reserved per second of trace.
 *
 * 240, the same reasoning as `perf-recorder.ts`'s capacity: high enough that a
 * 144 Hz monitor or a 120 Hz headset cannot overflow a trace early, and the
 * cost of being generous is bytes rather than accuracy.
 */
export const ROWS_PER_SECOND = 240

/**
 * The ceiling on an OPEN-ENDED trace, in rows. DEV-261.
 *
 * `start(null)` records until somebody stops it, which is Matt's ask and the
 * only shape that catches an event nobody can predict the time of. "Until
 * stopped" still has to end somewhere, and the honest place is a row count
 * rather than a clock: the buffer is what runs out, and a frame is what fills
 * it, so the limit belongs in the same units.
 *
 * 240,000 rows is **25 MB** of float32 at `STRIDE` 26, plus a 1.9 MB sort
 * scratch. At the 45 Hz this build actually gets in a headset that is **89
 * minutes**; at a full 90 Hz it is 44. Both are longer than anyone wears this.
 *
 * The ceiling is set by `dump()` rather than by the buffer, and that is worth
 * saying because the buffer is the smaller half. A dump is ~120 chars a row,
 * so 240,000 rows is a **29 MB string**, and the capture then JSON-encodes it
 * into a payload — two more copies of it live at once, at the exact moment the
 * session is being saved. An out-of-memory THERE loses the whole flight, which
 * is the one failure this file exists to prevent. A bigger buffer would buy
 * minutes nobody needs and put that moment at risk.
 *
 * Hitting it is `overflowed`, exactly as a filled window is, and it stops
 * rather than wrapping for the reason the header gives: a ring drops the start
 * of the soak, which is where the load hitches and the first compiles are.
 */
export const MAX_TRACE_ROWS = 240_000

/**
 * Rows an open-ended trace allocates first, and the unit it grows by.
 *
 * 30 s at `ROWS_PER_SECOND`. Small enough that arming at BOOT — which every
 * `?perf=1` load now does — costs 750 KB rather than 25 MB on a page that may
 * never fly, and large enough that the doubling below runs a handful of times
 * across a long session rather than every few seconds.
 */
export const OPEN_TRACE_INITIAL_ROWS = 30 * ROWS_PER_SECOND

/**
 * A frame is a hitch when it took more than this many TIER intervals. Matches
 * `perf-recorder.ts`, including which interval it is this many of (DEV-179).
 */
export const HITCH_BUDGETS = 2

/**
 * How many DISPLAY intervals a frame must take to be a tier frame. DEV-179.
 *
 * `perf-recorder.ts`'s `TIER_FRAME_INTERVALS`, and the two must agree — the
 * plate's live window and this trace's whole-run figure are the same quantity
 * over different spans, and two definitions of it would be a disagreement
 * nobody could see. Not imported for the reason `HITCH_BUDGETS` above is not:
 * these are the two files' shared wire vocabulary, `tests/unit/perf-trace.test.ts`
 * asserts the pair are equal, and a value import would make the trace depend on
 * the live recorder for a constant.
 */
export const TIER_FRAME_INTERVALS = 1.5

/** Worst frames `summary()` reports. Five: enough to see a pattern, few enough to read. */
export const WORST_FRAMES = 5

export type TraceStatus = 'idle' | 'recording' | 'done'

/**
 * One frame's numbers.
 *
 * **Mutable on purpose, and owned by the caller.** `app.ts` creates one of
 * these at boot and assigns its fields every frame; nothing in here keeps a
 * reference to it past the call, so the same object is valid for the life of
 * the app. Treated like the volatile scratch vectors in `app.ts` — see
 * CLAUDE.md on module-level scratch: never store one, never read one a
 * previous call left behind.
 */
export interface TraceSample {
  /** Wall delta for the frame, ms. `app.ts`'s `frameSeconds × 1000`. */
  dtMs: number
  /** Fixed steps that ran inside this frame. 0 while paused or snapped. */
  ticks: number
  /** Wall time inside `stepFixed`, ms — physics, racers, scoring, launch. */
  simMs: number
  /** Wall time round the render, ms: `gpu.begin()` … `gpu.end()`. */
  renderMs: number
  /** Wall time from the top of `frame()` to the feed, ms — the whole main thread. */
  frameMs: number
  /** `gpu.last`, ms. The newest HARVESTED query, which lags. NaN before the first. */
  gpuMs: number
  /** True only on frames where a new GPU result landed. Every gpu reader filters on it. */
  gpuFresh: boolean
  /** `renderer.info.render.calls` — both eyes plus the shadow pass, in session. */
  calls: number
  /** `renderer.info.render.triangles`. */
  triangles: number
  /** `renderer.info.programs.length`. A rise mid-flight is a compile, i.e. a hitch source. */
  programs: number
  /** `quality.report.scale` — adaptive resolution's multiplier, 1 when idle. */
  scale: number
  /** The session's own reported rate, or 0 where the runtime does not report one. */
  hz: number
  /**
   * The ship's x in SIM space, or NaN before there is a ship.
   *
   * Sim space — Unity's, z NOT flipped — because the only thing this column is
   * for is correlating a long frame with a place, and the places are in
   * `content/levels/*.json`, which is sim space. The render object's position
   * is the same point with z negated, and a silent flip between a trace and the
   * file it is read against is the sort of almost-right that gets believed.
   * (VR-PERF §5.2 names `flight.object.position`; this is the same quantity in
   * the frame the comparison happens in.)
   */
  shipX: number
  /** The ship's z in SIM space, or NaN before there is a ship. See `shipX`. */
  shipZ: number
  /** `mission.elapsed`, seconds — sim time, so it stops when the sim does. */
  elapsedSeconds: number
  /**
   * `1 / quality.report.tierHz` in MILLISECONDS — the rate frames were actually
   * arriving at on this frame, which is what its hitch is judged against.
   *
   * Equal to the header's `budgetMs` on a machine keeping up. On the worn rig
   * it is 22.2 or 33.3 against a display's 11.1, and it moves during the run;
   * see `COLUMNS`.
   */
  tierMs: number
  /**
   * Chunk requests in flight to the terrain worker, LAND only (DEV-177).
   *
   * `LoadedTerrain.pending`. A reply arrives on the main thread as typed
   * arrays and is turned into a `BufferGeometry` there, so a fall in this
   * column on a long frame is a chunk being BUILT, not requested — which is
   * the shape DEV-168 would fix by finishing the geometry in the worker.
   */
  terrainPending: number
  /** `LoadedTerrain.detailPending` — the detail-chunk half of `terrainPending`. */
  terrainDetailPending: number
  /**
   * `LoadedTerrain.fadingChunks` — chunks mid cross-fade (DEV-130).
   *
   * A fading chunk is drawn TWICE, so this column is also the extra draw calls
   * and triangles a LOD hand-over is costing on that frame.
   */
  terrainFading: number
  /**
   * The OCEAN's `pending`, and the OCEAN's `fadingChunks` (DEV-177(b)).
   *
   * Its own columns rather than added to the land's, because the two are
   * nothing like each other. The sea is four to six chunks; the land is 256.
   * But an Anniversary sea chunk at LOD 0 is 8× subdivided — ~150 k triangles
   * in ONE draw call, against about 2 k for a land chunk — so a single sea
   * chunk promoted to LOD 0 is the biggest thing that happens to the frame
   * short of a compile, and a `+1` of it disappears inside a land fade count
   * that sits at 12–19 all lap.
   */
  seaPending: number
  seaFading: number
  /**
   * Fracture pieces in the air, `PropFracture.live` (DEV-136/148).
   *
   * The prop-break marker: it steps 0 -> 6 on the frame a prop comes apart and
   * falls back to 0 as they fade. Six new meshes, six draw calls and — until
   * DEV-177(a) — one GLSL compile.
   */
  pieces: number
  /**
   * Eye 0's live viewport WIDTH in device pixels, or 0 flat (DEV-236).
   *
   * The OUTCOME half of `scale`. `eyeViewportWidth()` in `boot/perf-surface.ts`
   * reads it, off `renderer.xr.getCamera().cameras[0].viewport` — the same
   * `Vector4` DEV-227's header stamp is taken from, so the per-frame column and
   * the header provenance are one quantity read by one function and cannot
   * drift into two conventions for the same rectangle.
   *
   * Flat it is 0 rather than the canvas width, deliberately: there is no eye
   * and no per-eye viewport, and a canvas width in this column would compare
   * against a header stamp that is `null` on the flat path.
   */
  viewportWidth: number
  /**
   * The cockpit HUD's repaints so far, cumulative (DEV-243).
   *
   * A repaint is a canvas upload inside the timed render, so this is the one
   * column that says how many of THIS row's `gpu_ms` were spent moving 454,720
   * bytes and regenerating a mip chain. 0 before there is a panel.
   *
   * Cumulative rather than per-frame because every GPU reader filters on
   * `gpu_fresh`; see the column list for the whole of that argument.
   */
  hudPaints: number
  /**
   * The perf plate's repaints so far, cumulative (DEV-243). 0 without ?perf=1.
   *
   * The CONTROL for the column above: the same kind of object, 49 % more
   * canvas, a twentieth of the rate. See the column list for the pair, and for
   * why a zero here in a player's session is the honest reading rather than a
   * missing number.
   */
  platePaints: number
  /**
   * Which part of the session this frame is: `PHASE_PRE_FLIGHT`,
   * `PHASE_FLYING` or `PHASE_RUN_OVER` (DEV-261).
   *
   * Only meaningful because `?perf=1` now arms at BOOT. Before that every
   * trace began at the release and the column would have read 1 throughout —
   * which is exactly why the tier transition has never been in a capture.
   */
  phase: number
  /**
   * The Advanced page's rows as the renderer runs them, one bit each, in
   * `TraceMeta.featureBits` order. DEV-335.
   */
  features: number
}

/**
 * ONE EYE'S FRUSTUM, as the runtime handed it to us (DEV-227).
 *
 * ── Why this is in the header at all ─────────────────────────────────────
 *
 * Because without it a worn reading cannot be REPRODUCED. The VRto3D rig
 * (VR-PERF-WAVE-3 §1) is the only instrument this project has that repeats —
 * 0.01–0.02 ms of bracket drift where a frozen-frame ablation drifts 2.2× — and
 * its absolute numbers were still unfilable, because it drew **46 % more
 * triangles than the worn capture of the same mission** (14.14M against 9.69M
 * on `rookie_01_hoverJet`) off a `fov: 90` square eye that is simply a wider
 * frustum than the Frame's. That made the rig-vs-worn offset a sum of two
 * effects pointing opposite ways — the rig is cheaper with no video encoder on
 * the GPU, and dearer by half the world again — and neither could be separated
 * from the other. The fix is not to measure harder. It is to write down the one
 * parameter that has to match, and nothing in this header had ever written it
 * down.
 *
 * ── The convention, said out loud ────────────────────────────────────────
 *
 * **Four signed tangents — the OpenXR `XrFovf` / Oculus `FovPort` convention,
 * as tangents rather than angles.** NOT a single `fovy`: a real headset's
 * per-eye frustum is ASYMMETRIC (the two eyes each see further outboard than
 * inboard, and often further down than up), so one half-angle is not a
 * description of it — it is a description of the symmetric frustum somebody
 * wished it were, which is the mistake that produced the 46 %.
 *
 * Taken from `XRView.projectionMatrix`, which is column-major, GL clip space,
 * eye looking down its own −z. With `m[0] = 2n/(r−l)`, `m[5] = 2n/(t−b)`,
 * `m[8] = (r+l)/(r−l)` and `m[9] = (t+b)/(t−b)`:
 *
 *     tanRight = (1 + m[8]) / m[0]      tanLeft = (m[8] − 1) / m[0]
 *     tanUp    = (1 + m[9]) / m[5]      tanDown = (m[9] − 1) / m[5]
 *
 * so `tanUp` and `tanRight` are POSITIVE and `tanDown` and `tanLeft` are
 * NEGATIVE, each being that edge of the near plane divided by the near
 * distance. The near and far planes are deliberately absent: they are OUR
 * camera's, not the runtime's, they are already a build constant, and putting
 * them here would invite somebody to read this block as a whole projection
 * matrix rather than as the shape of the cone the runtime asked for.
 *
 * The horizontal and vertical FIELDS OF VIEW in degrees, for a rig config that
 * wants them, are `atan(tanRight) − atan(tanLeft)` and
 * `atan(tanUp) − atan(tanDown)` — a difference of two arctangents, never
 * `2 × atan` of one of them.
 */
export interface TraceEyeProjection {
  /** `XRView.eye` — `'left'`, `'right'`, or `'none'` on a monoscopic view. */
  readonly eye: string
  /** Tangent of the half-angle to each edge of the frustum. Signed; see above. */
  readonly tanUp: number
  readonly tanDown: number
  readonly tanLeft: number
  readonly tanRight: number
  /**
   * This eye's slice of the layer, in device pixels, or `null`.
   *
   * The frustum says what SHAPE is drawn; this says how many pixels it is drawn
   * into, and the rig has to match both or the fill term moves instead of the
   * geometry one. `w / h` here against `(tanRight − tanLeft) / (tanUp −
   * tanDown)` above is also the only check that catches a rig configured with a
   * square eye and a non-square frustum, or the reverse.
   */
  readonly viewport: {
    readonly x: number
    readonly y: number
    readonly w: number
    readonly h: number
  } | null
}

/** What `app.ts` stamps on a trace at `start()`, for `dump()`'s header. */
export interface TraceMeta {
  readonly version: string
  readonly mode: string
  readonly edition: string
  readonly mission: string
  /** The frame budget in force, ms. */
  readonly budgetMs: number
  /** Where that budget came from — `quality.report.targetSource`. */
  readonly budgetSource: string
  /**
   * One entry per `XRView`, or **`null` where there was no session to ask**
   * (DEV-227).
   *
   * `null`, not `[]` and not a zeroed pair of eyes, and the distinction is the
   * whole point: a flat trace has no projection because there are no XR views
   * in a flat frame, and a header that answered `0` there would be a number
   * somebody files: *nothing we saw, reported honestly rather than as a pass.*
   * An empty ARRAY
   * is a third and different answer: presenting, but the viewer pose gave no
   * views (tracking lost on the frame the probe looked).
   *
   * It is the LAST READING the once-a-second XR probe took, not a read of its
   * own — `refreshXrProbe` is the only place in this app that may touch an
   * `XRView`, because a view read outside its own frame throws. So a trace
   * armed inside the first second of a session can honestly carry `null`; both
   * arming paths wait for the ship to be flying, which is many seconds after
   * `requestSession` resolves.
   */
  /**
   * The `features` column's bit names, bit 0 first (DEV-335). Optional so a
   * caller with no Advanced page (a unit test, a console) can leave it out;
   * the header then says null rather than inventing an order.
   */
  readonly featureBits?: readonly string[]
  readonly projection: readonly TraceEyeProjection[] | null
  /**
   * The lens mask, as `boot/visibility-mask.ts` recorded it (DEV-331). Optional:
   * a meta written before DEV-331, or by a test, has none. Carried to the
   * summary so the stored capture JSON has it, because a headset has no
   * console to read `__ff2perf` from.
   */
  readonly visibilityMask?: VisibilityMaskReport
}

export interface TraceStat {
  readonly p50: number
  readonly p95: number
  readonly max: number
}

/**
 * A frame on which `renderer.info.programs` grew, seen from a LATER frame.
 * DEV-239.
 */
export interface TraceProgramRise {
  /** Row index of the frame whose program count was higher than the one before. */
  readonly index: number
  /** How many programs appeared on it. */
  readonly delta: number
  /** That frame's mission seconds. */
  readonly elapsedSeconds: number
  /** Wall milliseconds from the top of that frame to the top of the one reporting it. */
  readonly msEarlier: number
}

/**
 * The nearest frame before a worst frame on which the WORLD's streaming
 * counters moved, and by how much. DEV-242.
 *
 * ── Why a difference and not a level ─────────────────────────────────────
 *
 * DEV-177(b) put `terr_*` and `sea_*` on the worst-frame line so a stall with
 * no compile in it had something to say for itself. They did their job and the
 * line was still read wrong, because the numbers on it are LEVELS. On
 * `int_01_hoverJet`'s two stalls `terr_fading` reads 12 and 14 — large, steady,
 * unchanged for seconds either side — while `sea_fading` reads 1. A reader
 * ranking them by size attributes the stall to fourteen land chunks. The
 * counter that actually MOVED is the sea's, 0 -> 1, twelve times out of twelve
 * across six traces, and `terr_fading`'s delta is zero in every one
 * (DEV-242 §1).
 *
 * `perf-trace.ts:108`'s own comment named the mechanism — *"one sea chunk going
 * LOD 1 -> LOD 0"* — when those columns were added, for these exact frames. So
 * this is not a missing instrument; it is a level being read where a difference
 * was meant. **A counter is not an instrument until something reads it as a
 * difference**, and reading it is what this field does instead of leaving it to
 * whoever opens the CSV.
 *
 * `renderMs` comes along because it is the other half of the same event: the
 * frame a big chunk lands on uploads it, and on those twelve it reads 8.1–17.5
 * against a 2.0–3.3 baseline. A change with an ordinary `renderMs` beside it is
 * a chunk swap that cost nothing, which is most of them.
 *
 * `null` when nothing moved within the search window, which is the honest
 * answer for a stall that has nothing to do with streaming.
 */
export interface TraceStreamingChange {
  /** Row index of the frame whose counters differed from the one before it. */
  readonly index: number
  /** That frame's mission seconds. */
  readonly elapsedSeconds: number
  /** Wall milliseconds from the top of that frame to the top of the one reporting it. */
  readonly msEarlier: number
  /** That frame's own render time — the upload, when the change was a big chunk landing. */
  readonly renderMs: number
  /** Signed deltas across that frame. Zero is a real answer and is reported. */
  readonly terrainPending: number
  readonly terrainFading: number
  readonly seaPending: number
  readonly seaFading: number
  readonly triangles: number
}

export interface TraceWorstFrame {
  /** Row index into the trace, 0-based. */
  readonly index: number
  readonly dtMs: number
  readonly elapsedSeconds: number
  readonly shipX: number
  readonly shipZ: number
  readonly calls: number
  readonly triangles: number
  readonly programs: number
  /**
   * DEV-177(b). The worst frames are where attribution happens, and until now
   * the only mechanism on this row was `programs` — so a stall with no compile
   * in it had nothing to say for itself. These are the other candidates, on
   * the same row, so a reader does not have to go back to the CSV to find out
   * whether the world was loading a chunk or taking a tree apart.
   */
  readonly terrainPending: number
  readonly terrainDetailPending: number
  readonly terrainFading: number
  readonly seaPending: number
  readonly seaFading: number
  readonly pieces: number
  /**
   * The nearest `programs` rise BEFORE this frame, or null if the trace has
   * none. DEV-239.
   *
   * ── Why the count on the row could never have found it ───────────────
   *
   * `programs` above is this frame's own count, and `docs/testing/perf-protocol.md`
   * §5a recorded the ~15 s and ~23 s stalls on `int_01` as carrying **no
   * program change** on the strength of it. That is true of the ROW and false
   * of the EVENT: three's `programs.length` grows when the program OBJECT is
   * created, and the driver defers the link until the first draw — so the count
   * steps up ten frames early and is flat, at its new value, on the frame that
   * stalls.
   *
   * `VR-PERF-TAIL.md` §4.6 found the gap by joining two columns of a CSV by
   * hand: the three worst mid-flight frames in the thirteen-mission set each
   * follow a `+1` by 122–135 ms and each carries a 19–21 ms GPU excursion,
   * while the three next-worst follow none for 8–25 s and carry an ordinary
   * GPU. Two kinds of stall, told apart by a column that was in the trace and
   * not on the line. This field puts it on the line.
   *
   * A long `msEarlier` is not a link — 8 s earlier means unrelated — so the
   * reader is given the number rather than a verdict.
   */
  readonly precedingProgramRise: TraceProgramRise | null
  /**
   * The nearest streaming CHANGE before this frame. DEV-242.
   *
   * The same shape as `precedingProgramRise` and for the same reason: the
   * event that explains a stall is a step, and a step is invisible on a line
   * that prints levels. See {@link TraceStreamingChange}.
   */
  readonly precedingStreamingChange: TraceStreamingChange | null
}

export interface TraceTicks {
  readonly zero: number
  readonly one: number
  readonly two: number
  readonly threePlus: number
}

export interface TraceSummary {
  readonly status: TraceStatus
  readonly frames: number
  /** Wall seconds the trace spans — the sum of its `dt`. */
  readonly seconds: number
  /** `frames / seconds`, 0 on an empty trace. Never `Infinity`. */
  readonly fps: number
  readonly budgetMs: number
  readonly budgetSource: string
  /**
   * `TraceMeta.projection`, carried through (DEV-227).
   *
   * It is on the SUMMARY as well as on `dump()`'s header because those two are
   * read by different people in different places: `perf-capture.ts` stores the
   * summary as JSON beside the CSV, the console line and the in-headset plate
   * are built from the summary, and a stamp that only exists in a text blob's
   * first line is a stamp nobody reads until the day they need it and find it
   * missing. Same quantity, one source.
   */
  readonly projection: readonly TraceEyeProjection[] | null
  /** `TraceMeta.visibilityMask`, carried through (DEV-331). */
  readonly visibilityMask?: VisibilityMaskReport
  /** The trace filled its buffer and stopped early. The run is longer than this. */
  readonly overflowed: boolean
  readonly dt: TraceStat
  readonly sim: TraceStat
  readonly render: TraceStat
  readonly frame: TraceStat
  /** Over `gpu_fresh === 1` rows ONLY. All zero when the timer never landed one. */
  readonly gpu: TraceStat
  /** How many rows the `gpu` stat was computed from. 0 means "no timer query". */
  readonly gpuFrames: number
  /**
   * Frames over `HITCH_BUDGETS` x that frame's own TIER interval (DEV-179).
   *
   * A frame that missed even the rate the compositor had already dropped us to.
   * Judged against the display, lap 4 read 73 % — which is not a hitch report,
   * it is `tierFraction` below wearing the wrong name.
   */
  readonly hitches: number
  readonly hitchFraction: number
  /**
   * Frames at `TIER_FRAME_INTERVALS` or more of the DISPLAY's interval — the
   * ones the compositor could not present at the display's rate. DEV-179.
   *
   * 0 when the run never left the display's rate, which is the run everybody is
   * trying to produce. `hitch 1 % · tier 73 %` is a lap pinned in a reprojection
   * tier and pacing it steadily; `hitch 73 %` was the same lap said uselessly.
   */
  readonly tierFrames: number
  readonly tierFraction: number
  readonly ticks: TraceTicks
  /**
   * How the recorded frames split across the session (DEV-261).
   *
   * Every stat above is over ALL of them. Before `?perf=1` armed at boot that
   * was the same thing as "the flight", because a trace could not begin until
   * the ship was released; an open-ended trace makes it a mixture, and a `dt`
   * p95 read through 100 s of lift ride is a statistic about a cutscene. These
   * counts are the disclosure, and the CSV's `phase` column is the remedy.
   */
  readonly phases: TracePhases
  /** Worst by `dt`, longest first. At most `WORST_FRAMES`. */
  readonly worst: readonly TraceWorstFrame[]
}

/** Frames per phase in a summary. DEV-261. */
export interface TracePhases {
  readonly preFlight: number
  readonly flying: number
  readonly runOver: number
}

export interface TraceRecorder {
  /**
   * Begin a window of `seconds`. Allocates ONLY if the buffer must grow, so a
   * second run of the same length costs nothing.
   *
   * Clamped to `MAX_TRACE_SECONDS`. Calling it while recording restarts.
   */
  /**
   * Begin a window. `seconds` is clamped to `MAX_TRACE_SECONDS`.
   *
   * **`null` is OPEN-ENDED** (DEV-261): no clock, no window, grow the buffer
   * as it fills and record until `stop()` — or until `MAX_TRACE_ROWS`, which
   * reports as `overflowed` exactly as a filled window does.
   */
  start(seconds: number | null, meta?: Partial<TraceMeta>): void
  /** End the window. Idempotent; a trace that already stopped stays `'done'`. */
  stop(): void
  /** One frame. Allocation-free; ignored unless `status === 'recording'`. */
  frame(sample: TraceSample): void
  /** Allocates and sorts. Call at a panel's rate or once at the end, never per frame. */
  summary(): TraceSummary
  /** One JSON header line, then CSV. The whole trace as text. Allocates a lot. */
  dump(): string
  /** Throw the trace away and go back to `'idle'`. Keeps the buffer. */
  reset(): void
  readonly status: TraceStatus
  readonly frames: number
  /** Rows this window may hold. `capacityFor(seconds)`. */
  readonly capacity: number
  /**
   * Wall seconds recorded so far, and the window asked for.
   *
   * Cheap — accumulated at feed time — so the in-headset plate's
   * `TRACE rec 42/90 s` row costs nothing, where reading it off `summary()`
   * would sort the whole trace four times a second. `app.ts` owns the recorder
   * and passes these into the plate's model; the frozen `?perf=1` surface does
   * not expose them (its `trace` key set is an allow-list, §5.4).
   */
  readonly seconds: number
  readonly limitSeconds: number
  readonly overflowed: boolean
  readonly meta: TraceMeta
}

const EMPTY_STAT: TraceStat = { p50: 0, p95: 0, max: 0 }

const EMPTY_META: TraceMeta = {
  version: 'unknown',
  mode: 'unknown',
  edition: 'unknown',
  mission: 'unknown',
  budgetMs: 0,
  budgetSource: 'unset',
  // Not `'unknown'` and not `[]`: the other five default to a string that reads
  // as "nobody stamped this", and the honest default for a frustum is that
  // there was no session to have one (DEV-227).
  projection: null,
}

/**
 * Parse `?trace=<seconds>`, shaped like `boot/snap.ts`'s `parseSnap`.
 *
 * `null` for absent, for anything that is not a finite number, and for zero or
 * negative — a trace of no seconds is a switch somebody mistyped, and an
 * unparseable switch is ignored rather than fatal, the way `?edition=` and
 * `?snap=` are. Over the cap it CLAMPS and says so, because the alternative is
 * a soak that silently records five minutes when you asked for an hour.
 */
export const parseTraceSeconds = (raw: string | null): number | null => {
  if (raw === null || raw.trim() === '') return null
  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds <= 0) {
    console.warn(`?trace=${raw} is not a positive number of seconds; ignored`)
    return null
  }
  if (seconds > MAX_TRACE_SECONDS) {
    console.warn(
      `?trace=${raw} is over the ${MAX_TRACE_SECONDS} s cap; recording ${MAX_TRACE_SECONDS} s`,
    )
    return MAX_TRACE_SECONDS
  }
  return seconds
}

/** Rows a trace of this many seconds reserves. */
export const capacityFor = (seconds: number): number =>
  Math.max(1, Math.ceil(Math.min(seconds, MAX_TRACE_SECONDS) * ROWS_PER_SECOND))

export const createTraceRecorder = (): TraceRecorder => {
  let rows = new Float32Array(0)
  /** Rows the BUFFER holds. Only ever grows, so a second trace reallocates nothing. */
  let allocated = 0
  /** Rows THIS window may use. `capacityFor(seconds)`, so a short trace is short. */
  let capacity = 0
  let limitSeconds = 0
  /** DEV-261: `start(null)` — no clock, grow on fill, stop only when told to. */
  let openEnded = false
  let recorded = 0
  let count = 0
  let status: TraceStatus = 'idle'
  let overflowed = false
  let meta: TraceMeta = EMPTY_META
  let startedAt = 0
  /** Sort scratch for the percentiles. Grown with the buffer, reused by `summary()`. */
  let scratch = new Float64Array(0)

  return {
    get status() {
      return status
    },
    get frames() {
      return count
    },
    get capacity() {
      return capacity
    },
    get seconds() {
      return recorded
    },
    get limitSeconds() {
      return limitSeconds
    },
    get overflowed() {
      return overflowed
    },
    get meta() {
      return meta
    },

    start(seconds, next) {
      openEnded = seconds === null
      // The null check rather than `openEnded`, so the narrowing is the
      // compiler's rather than a claim about a boolean two lines up.
      limitSeconds = seconds === null ? 0 : Math.min(Math.max(seconds, 0), MAX_TRACE_SECONDS)
      // An open-ended trace reserves 30 s and grows; a window reserves the
      // whole of itself up front, which is what makes `?trace=20` allocation-
      // free after the first frame.
      capacity = openEnded
        ? Math.min(OPEN_TRACE_INITIAL_ROWS, MAX_TRACE_ROWS)
        : capacityFor(limitSeconds)
      if (capacity > allocated) {
        rows = new Float32Array(capacity * STRIDE)
        scratch = new Float64Array(capacity)
        allocated = capacity
      }
      count = 0
      recorded = 0
      overflowed = false
      status = 'recording'
      startedAt = Date.now()
      meta = { ...EMPTY_META, ...next }
    },

    stop() {
      if (status === 'recording') status = 'done'
    },

    frame(sample) {
      if (status !== 'recording') return
      const at = count * STRIDE
      rows[at + C_DT] = sample.dtMs
      rows[at + C_TICKS] = sample.ticks
      rows[at + C_SIM] = sample.simMs
      rows[at + C_RENDER] = sample.renderMs
      rows[at + C_FRAME] = sample.frameMs
      rows[at + C_GPU] = sample.gpuMs
      // A "fresh" reading that is not a number is not fresh. The guard is here
      // rather than at the call site because every reader in this file trusts
      // this column to mean "row `C_GPU` is a real measurement".
      rows[at + C_GPU_FRESH] = sample.gpuFresh && Number.isFinite(sample.gpuMs) ? 1 : 0
      rows[at + C_CALLS] = sample.calls
      rows[at + C_TRIS] = sample.triangles
      rows[at + C_PROGRAMS] = sample.programs
      rows[at + C_SCALE] = sample.scale
      rows[at + C_HZ] = sample.hz
      rows[at + C_SHIP_X] = sample.shipX
      rows[at + C_SHIP_Z] = sample.shipZ
      rows[at + C_ELAPSED] = sample.elapsedSeconds
      rows[at + C_TIER] = sample.tierMs
      rows[at + C_TERR_PENDING] = sample.terrainPending
      rows[at + C_TERR_DETAIL] = sample.terrainDetailPending
      rows[at + C_TERR_FADING] = sample.terrainFading
      rows[at + C_SEA_PENDING] = sample.seaPending
      rows[at + C_SEA_FADING] = sample.seaFading
      rows[at + C_PIECES] = sample.pieces
      rows[at + C_VP_W] = sample.viewportWidth
      rows[at + C_HUD_PAINTS] = sample.hudPaints
      rows[at + C_PLATE_PAINTS] = sample.platePaints
      rows[at + C_PHASE] = sample.phase
      rows[at + C_FEATURES] = sample.features
      count += 1
      if (Number.isFinite(sample.dtMs)) recorded += sample.dtMs / 1000
      // ── Two ways to end, and they mean different things ─────────────────
      //
      // The ORDINARY one is wall seconds: `?trace=20` means twenty seconds of
      // flight. VR-PERF §5.2 specifies `capacity = ceil(seconds × 240)` and
      // stopping when the buffer fills, which would be the same thing only on a
      // 240 Hz display — at 90 Hz a `trace=120` would run for 320 s and end
      // somewhere over the sea. The capacity is the SAFETY margin, not the
      // clock (a finding against the brief; see the DEV-160 row).
      //
      // The other is the buffer filling first, which can only happen above
      // 240 fps. That is a truncated trace and it says so: STOP rather than
      // wrap, because a ring would drop the start of the soak, which is where
      // the load hitches and the first program compiles are.
      //
      // ── DEV-261: and a THIRD, which is the open-ended trace GROWING ──────
      //
      // `start(null)` has no clock to end on, so filling the buffer is not a
      // truncation — it is the ordinary case, and the answer is a bigger
      // buffer. Doubling, capped at `MAX_TRACE_ROWS`, so a two-hour page costs
      // a handful of reallocations rather than one a second.
      //
      // The copy is what keeps the header's promise: a ring would drop the
      // start of the soak, and the start is where the load hitches, the first
      // compiles and — the reason this mode exists — the frame the compositor
      // dropped a tier on are. Growing preserves all of it; only the ceiling
      // truncates, and it says so.
      if (count >= capacity) {
        const grown = openEnded ? Math.min(capacity * 2, MAX_TRACE_ROWS) : capacity
        if (grown > capacity) {
          if (grown > allocated) {
            const wider = new Float32Array(grown * STRIDE)
            wider.set(rows.subarray(0, count * STRIDE))
            rows = wider
            scratch = new Float64Array(grown)
            allocated = grown
          }
          capacity = grown
        } else {
          overflowed = true
          status = 'done'
        }
      } else if (limitSeconds > 0 && recorded >= limitSeconds) {
        status = 'done'
      }
    },

    summary() {
      return summarise(rows, count, status, overflowed, meta, scratch)
    },

    dump() {
      return dumpTrace(rows, count, meta, startedAt)
    },

    reset() {
      count = 0
      recorded = 0
      status = 'idle'
      overflowed = false
      meta = EMPTY_META
    },
  }
}

/**
 * p50/p95/max of one column, over the rows a predicate accepts.
 *
 * `percentile` is `perf-recorder.ts`'s, interpolated, taking a SORTED
 * `Float64Array` — imported rather than reimplemented so a trace's p95 and the
 * live panel's p95 are the same statistic. Two percentile functions that
 * disagree by a rank is a bug nobody can see, which is the same argument the
 * recorder's header makes about two smoothers.
 */
const statOf = (
  rows: Float32Array,
  count: number,
  column: number,
  scratch: Float64Array,
  freshOnly: boolean,
): { stat: TraceStat; n: number } => {
  let n = 0
  let max = 0
  for (let i = 0; i < count; i++) {
    const at = i * STRIDE
    if (freshOnly && rows[at + C_GPU_FRESH] !== 1) continue
    const v = rows[at + column] as number
    if (!Number.isFinite(v)) continue
    scratch[n] = v
    n += 1
    if (v > max) max = v
  }
  if (n === 0) return { stat: EMPTY_STAT, n: 0 }
  const view = scratch.subarray(0, n)
  view.sort()
  return { stat: { p50: percentile(view, 0.5), p95: percentile(view, 0.95), max }, n }
}

/**
 * Walk back from row `at` to the last frame on which `programs` grew. DEV-239.
 *
 * ── Why backwards, and why the wall clock ────────────────────────────────
 *
 * Because the question is *"did a program appear shortly before this stall?"*,
 * and "shortly" is wall time, not rows: at 90 Hz ten frames is 111 ms and at
 * 45 Hz it is 222. `msEarlier` accumulates `dt` — the interval sampled at the
 * top of each frame — from the row AFTER the rise up to and including `at`, so
 * it is the time from the top of the rise frame to the top of this one. That
 * is the quantity `VR-PERF-TAIL.md` §4.6's 122–135 ms are.
 *
 * `null` when nothing before it rose, which is the honest answer for every
 * frame of the eleven missions that never compile after their first.
 */
const riseBefore = (rows: Float32Array, at: number): TraceProgramRise | null => {
  let msEarlier = 0
  for (let i = at; i > 0; i--) {
    const here = rows[i * STRIDE + C_PROGRAMS] as number
    const previous = rows[(i - 1) * STRIDE + C_PROGRAMS] as number
    if (here > previous)
      return {
        index: i,
        delta: here - previous,
        elapsedSeconds: rows[i * STRIDE + C_ELAPSED] as number,
        msEarlier,
      }
    // AFTER the check, not before it: `dt` on row `i` is the interval that
    // ENDS at the top of row `i`, so the rise frame's own `dt` belongs to the
    // gap before the rise and not to the gap after it. Accumulating first put
    // one extra frame in every answer.
    msEarlier += rows[i * STRIDE + C_DT] as number
  }
  return null
}

/**
 * How far back {@link changeBefore} looks, in FRAMES.
 *
 * 24 is ~290 ms at 81.97 Hz and ~265 ms at 90 — comfortably past DEV-239's
 * 122–135 ms deferred link, which is the longest gap between a cause and a
 * stall this project has measured. Frames rather than milliseconds because the
 * bound's job is to keep the walk short, and an unrelated change 280 ms back is
 * reported with its `msEarlier` so the reader can dismiss it, exactly as
 * `precedingProgramRise` hands over an 8-second-old rise rather than a verdict.
 */
const CHANGE_SEARCH_FRAMES = 24

/**
 * Walk back from row `at` to the last frame on which any streaming counter
 * moved. DEV-242, and deliberately the same shape as {@link riseBefore}.
 *
 * `msEarlier` accumulates `dt` after the check, for the reason spelled out in
 * `riseBefore`: `dt` on row `i` is the interval that ENDS at the top of row
 * `i`, so the change frame's own `dt` belongs to the gap before it.
 */
const changeBefore = (rows: Float32Array, at: number): TraceStreamingChange | null => {
  let msEarlier = 0
  const stop = Math.max(1, at - CHANGE_SEARCH_FRAMES)
  for (let i = at; i >= stop; i--) {
    const here = i * STRIDE
    const back = (i - 1) * STRIDE
    const terrainPending =
      (rows[here + C_TERR_PENDING] as number) - (rows[back + C_TERR_PENDING] as number)
    const terrainFading =
      (rows[here + C_TERR_FADING] as number) - (rows[back + C_TERR_FADING] as number)
    const seaPending =
      (rows[here + C_SEA_PENDING] as number) - (rows[back + C_SEA_PENDING] as number)
    const seaFading = (rows[here + C_SEA_FADING] as number) - (rows[back + C_SEA_FADING] as number)
    if (terrainPending !== 0 || terrainFading !== 0 || seaPending !== 0 || seaFading !== 0) {
      return {
        index: i,
        elapsedSeconds: rows[here + C_ELAPSED] as number,
        msEarlier,
        renderMs: rows[here + C_RENDER] as number,
        terrainPending,
        terrainFading,
        seaPending,
        seaFading,
        // Triangles across the same frame. On the twelve stalls DEV-242 swept
        // this reads +292,004 to +304,924 — one ocean chunk at LOD 0, drawn
        // through both eyes — which is the number that makes the attribution
        // unambiguous where the counter deltas alone say only "the sea moved".
        triangles: (rows[here + C_TRIS] as number) - (rows[back + C_TRIS] as number),
      }
    }
    msEarlier += rows[here + C_DT] as number
  }
  return null
}

const summarise = (
  rows: Float32Array,
  count: number,
  status: TraceStatus,
  overflowed: boolean,
  meta: TraceMeta,
  scratch: Float64Array,
): TraceSummary => {
  const base = {
    status,
    frames: count,
    budgetMs: meta.budgetMs,
    budgetSource: meta.budgetSource,
    projection: meta.projection,
    ...(meta.visibilityMask ? { visibilityMask: meta.visibilityMask } : {}),
    overflowed,
  }
  if (count === 0) {
    return {
      ...base,
      seconds: 0,
      fps: 0,
      dt: EMPTY_STAT,
      sim: EMPTY_STAT,
      render: EMPTY_STAT,
      frame: EMPTY_STAT,
      gpu: EMPTY_STAT,
      gpuFrames: 0,
      hitches: 0,
      hitchFraction: 0,
      tierFrames: 0,
      tierFraction: 0,
      ticks: { zero: 0, one: 0, two: 0, threePlus: 0 },
      phases: { preFlight: 0, flying: 0, runOver: 0 },
      worst: [],
    }
  }

  // The DISPLAY's interval is the header's — one number for the session, which
  // is what a display rate is since DEV-179. The TIER's is per row, because
  // that is the half that moves. A trace recorded before this column existed
  // has 0 there and falls back to the display, which is both the old behaviour
  // and the truth for any run that never left the display's rate.
  const tierFloorMs = meta.budgetMs * TIER_FRAME_INTERVALS
  let seconds = 0
  let hitches = 0
  let tierFrames = 0
  let zero = 0
  let one = 0
  let two = 0
  let threePlus = 0
  // DEV-261. An open-ended trace spans the menus, the lift ride and the
  // flight, so every stat below is over a MIXTURE — and the ride is ~100 s of
  // cutscene that no `dt` percentile should be read through without knowing it
  // is there. These three counts are what make that visible at the point the
  // summary is read; `phase` in the CSV is what lets a reader split it.
  let preFlightFrames = 0
  let flyingFrames = 0
  let runOverFrames = 0
  // The worst five, kept by insertion into a five-slot list rather than by
  // sorting 72,000 rows: one pass, no second array the size of the trace.
  const worst: TraceWorstFrame[] = []

  for (let i = 0; i < count; i++) {
    const at = i * STRIDE
    const dt = rows[at + C_DT] as number
    seconds += dt / 1000
    // A budget of 0 means nobody stamped one, and a hitch count taken off a
    // trace with no stated budget is a number with no provenance — so no
    // budget means no hitch count and no tier share, stated rather than fudged.
    // That the ROWS might still carry a tier does not rescue it: the summary
    // would print `budget unset` beside a percentage, which is the shape of a
    // number that gets believed.
    //
    // With a budget: the threshold is this frame's OWN tier (DEV-179), falling
    // back to the header's budget for a row that has none — every CSV recorded
    // before the column existed, and every caller that does not set the field.
    if (meta.budgetMs > 0) {
      const rowTierMs = rows[at + C_TIER] as number
      if (dt > (rowTierMs > 0 ? rowTierMs : meta.budgetMs) * HITCH_BUDGETS) hitches += 1
      if (dt >= tierFloorMs) tierFrames += 1
    }

    const phase = rows[at + C_PHASE] as number
    if (phase >= PHASE_RUN_OVER) runOverFrames += 1
    else if (phase >= PHASE_FLYING) flyingFrames += 1
    else preFlightFrames += 1

    const ticks = rows[at + C_TICKS] as number
    if (ticks <= 0) zero += 1
    else if (ticks === 1) one += 1
    else if (ticks === 2) two += 1
    else threePlus += 1

    if (worst.length < WORST_FRAMES || dt > (worst[worst.length - 1] as TraceWorstFrame).dtMs) {
      const row: TraceWorstFrame = {
        index: i,
        dtMs: dt,
        elapsedSeconds: rows[at + C_ELAPSED] as number,
        shipX: rows[at + C_SHIP_X] as number,
        shipZ: rows[at + C_SHIP_Z] as number,
        calls: rows[at + C_CALLS] as number,
        triangles: rows[at + C_TRIS] as number,
        programs: rows[at + C_PROGRAMS] as number,
        terrainPending: rows[at + C_TERR_PENDING] as number,
        terrainDetailPending: rows[at + C_TERR_DETAIL] as number,
        terrainFading: rows[at + C_TERR_FADING] as number,
        seaPending: rows[at + C_SEA_PENDING] as number,
        seaFading: rows[at + C_SEA_FADING] as number,
        pieces: rows[at + C_PIECES] as number,
        // Filled after the pass: a backward walk per worst frame is at most
        // five walks, and doing it here would be one per candidate — a
        // long trace offers thousands before the five settle.
        precedingProgramRise: null,
        precedingStreamingChange: null,
      }
      let slot = worst.length
      while (slot > 0 && (worst[slot - 1] as TraceWorstFrame).dtMs < dt) slot -= 1
      worst.splice(slot, 0, row)
      if (worst.length > WORST_FRAMES) worst.length = WORST_FRAMES
    }
  }

  // ── what came BEFORE each worst frame (DEV-239, DEV-242) ───────────────
  //
  // Second pass, over the five survivors only. Both fields are differences
  // over the frames leading in, and both exist because the corresponding
  // number ON the row is a level that could not say what happened: `programs`
  // is flat at its new value by the time the driver links (DEV-239), and the
  // streaming counters are large and steady while the one that stepped is
  // small (DEV-242). See each field's own note.
  for (let k = 0; k < worst.length; k++) {
    const w = worst[k] as TraceWorstFrame
    worst[k] = {
      ...w,
      precedingProgramRise: riseBefore(rows, w.index),
      precedingStreamingChange: changeBefore(rows, w.index),
    }
  }

  const gpu = statOf(rows, count, C_GPU, scratch, true)
  return {
    ...base,
    seconds,
    fps: seconds > 0 ? count / seconds : 0,
    dt: statOf(rows, count, C_DT, scratch, false).stat,
    sim: statOf(rows, count, C_SIM, scratch, false).stat,
    render: statOf(rows, count, C_RENDER, scratch, false).stat,
    frame: statOf(rows, count, C_FRAME, scratch, false).stat,
    gpu: gpu.stat,
    gpuFrames: gpu.n,
    hitches,
    hitchFraction: hitches / count,
    tierFrames,
    tierFraction: tierFrames / count,
    ticks: { zero, one, two, threePlus },
    phases: { preFlight: preFlightFrames, flying: flyingFrames, runOver: runOverFrames },
    worst,
  }
}

/** Decimal places per column. A scale of `0.90` is not a scale of `0.9` rounded to 0. */
const PLACES: readonly number[] = [
  2, // dt_ms
  0, // ticks
  2, // sim_ms
  2, // render_ms
  2, // frame_ms
  2, // gpu_ms
  0, // gpu_fresh
  0, // calls
  0, // tris
  0, // programs
  3, // scale
  0, // hz
  2, // ship_x
  2, // ship_z
  3, // elapsed_s
  2, // tier_ms
  0, // terr_pending
  0, // terr_detail
  0, // terr_fading
  0, // sea_pending
  0, // sea_fading
  0, // pieces
  0, // vp_w — device pixels, always integral
  0, // hud_paints — a count
  0, // plate_paints — a count
  0, // phase — an enum: 0 pre-flight, 1 flying, 2 past the run-over
  0, // features — a bitmask, see the header's featureBits
]

/**
 * The trace as text: one JSON object on line 1, then a CSV header, then rows.
 *
 * A header line that is JSON rather than a comment because the consumer is a
 * human pasting it into a notebook or a spreadsheet, and both of those want the
 * provenance — *which build, which preset, which mission, judged against what
 * budget from what source* — attached to the numbers rather than remembered.
 * Every reading in `docs/perf-baseline.md` has to carry that stamp anyway
 * (protocol §3), so the file carries it.
 *
 * `NaN` is written literally: a ship position before there is a ship is not
 * zero, and an empty cell would read back as one.
 */
const dumpTrace = (
  rows: Float32Array,
  count: number,
  meta: TraceMeta,
  startedAt: number,
): string => {
  const header = JSON.stringify({
    version: meta.version,
    mode: meta.mode,
    edition: meta.edition,
    mission: meta.mission,
    startedAt: startedAt > 0 ? new Date(startedAt).toISOString() : null,
    budgetMs: meta.budgetMs,
    budgetSource: meta.budgetSource,
    // DEV-227. Before `columns`, because it is provenance like everything above
    // it and `columns` is the row format — the reader's eye stops there.
    // `null` on the flat path, and a reader must not turn that into zeros.
    projection: meta.projection,
    // DEV-335: what each bit of the `features` column is, in bit order.
    featureBits: meta.featureBits ?? null,
    frames: count,
    columns: COLUMNS,
  })
  const out: string[] = [header, COLUMNS.join(',')]
  const cell = new Array<string>(STRIDE)
  for (let i = 0; i < count; i++) {
    const at = i * STRIDE
    for (let c = 0; c < STRIDE; c++) {
      const v = rows[at + c] as number
      cell[c] = Number.isFinite(v) ? v.toFixed(PLACES[c] as number) : 'NaN'
    }
    out.push(cell.join(','))
  }
  return out.join('\n')
}

const ms = (v: number): string => v.toFixed(1)
const pct = (v: number): string => `${Math.round(v * 100)}%`

/**
 * One eye's frustum restated the way a RIG CONFIG states it (DEV-227).
 *
 * The tangents in `TraceEyeProjection` are the storage form — exact, signed,
 * and what the maths wants. These four are the comparison form: VRto3D's
 * `fov` and `aspect_ratio`, and the Frame's own spec sheet, are all angles and
 * ratios, and a header a human has to run arctangents over by hand is a header
 * that gets eyeballed instead of read.
 *
 * **`horizontalDeg` is the FULL angle, a DIFFERENCE of two arctangents** —
 * `atan(tanRight) − atan(tanLeft)`, with `tanLeft` negative so the two add up.
 * It is emphatically not `2 × atan(tanRight)`, which is only true of a
 * symmetric frustum and is the exact shortcut that makes an asymmetric one look
 * like something a square eye can reproduce.
 */
export interface EyeFov {
  /** `atan(tanRight) − atan(tanLeft)`, degrees. Both halves, summed. */
  readonly horizontalDeg: number
  /** `atan(tanUp) − atan(tanDown)`, degrees. */
  readonly verticalDeg: number
  /**
   * `(tanRight − tanLeft) / (tanUp − tanDown)` — the frustum's own width/height
   * ratio in TANGENT space, not the ratio of the two angles above (`tan` is not
   * linear, so those are different numbers and only one of them is this one).
   *
   * This is the number VRto3D's `aspect_ratio` takes, because the driver
   * divides a tangent by it (`perf-protocol.md` §1a has its `GetProjectionRaw`).
   * It is **not** a claim about what the triangle count scales with: on this
   * renderer the scatter is ~18–20 `InstancedMesh` batches that culling can
   * only reject whole (VR-PERF-WAVE-3 §4), so how much narrowing a cone buys is
   * a measurement nobody has taken.
   */
  readonly aspect: number
  /**
   * How far off-centre the frustum is, −1..1, in each axis: `(r+l)/(r−l)` and
   * `(t+b)/(t−b)` — which are `m[8]` and `m[9]` of the projection matrix
   * itself, so this is a reading rather than a derivation.
   *
   * **Zero means symmetric, and only a zero here can be reproduced by a rig
   * that offers one `fov` number.** A non-zero skew is the finding that says
   * the rig can match the frustum's SIZE but not its shear, and that the
   * residual has to be carried as a known bias rather than tuned away.
   */
  readonly skewX: number
  readonly skewY: number
}

/** `EyeFov` from the stored tangents. Pure arithmetic; no clamping, no guessing. */
export const eyeFov = (v: TraceEyeProjection): EyeFov => {
  const width = v.tanRight - v.tanLeft
  const height = v.tanUp - v.tanDown
  return {
    horizontalDeg: (Math.atan(v.tanRight) - Math.atan(v.tanLeft)) * DEG_PER_RAD,
    verticalDeg: (Math.atan(v.tanUp) - Math.atan(v.tanDown)) * DEG_PER_RAD,
    // A degenerate frustum divides by zero rather than pretending to a value.
    // `Infinity`/`NaN` in a diagnostic is a reading; 0 or 1 would be a lie.
    aspect: width / height,
    skewX: (v.tanRight + v.tanLeft) / width,
    skewY: (v.tanUp + v.tanDown) / height,
  }
}

/** One eye as a console line. The tangents stay in the header for machines. */
export const formatEyeProjection = (v: TraceEyeProjection): string => {
  const f = eyeFov(v)
  const px = v.viewport ? `${v.viewport.w}x${v.viewport.h} px` : 'viewport n/a'
  return (
    `${v.eye.padEnd(5)} h ${f.horizontalDeg.toFixed(1)}° v ${f.verticalDeg.toFixed(1)}°` +
    ` · aspect ${f.aspect.toFixed(3)} · skew ${f.skewX.toFixed(3)}/${f.skewY.toFixed(3)}` +
    ` · tan u${v.tanUp.toFixed(4)} d${v.tanDown.toFixed(4)}` +
    ` l${v.tanLeft.toFixed(4)} r${v.tanRight.toFixed(4)} · ${px}`
  )
}

/**
 * The summary as a block of text, for the console line AND the in-headset
 * plate (§5.5) — one formatter so the two cannot drift.
 *
 * Three-free by construction, so the plate imports it rather than the other way
 * round. Split on `\n` for a line list.
 */
export const formatTraceSummary = (s: TraceSummary): string => {
  const lines: string[] = []
  const budget = s.budgetMs > 0 ? `${ms(s.budgetMs)} ms (${s.budgetSource})` : `unset`
  lines.push(
    `TRACE ${s.frames} frames · ${s.seconds.toFixed(1)} s · ${s.fps.toFixed(1)} fps · budget ${budget}${
      s.overflowed ? ' · OVERFLOWED (the run is longer than this trace)' : ''
    }`,
  )
  lines.push(
    `  dt     p50 ${ms(s.dt.p50)}  p95 ${ms(s.dt.p95)}  max ${ms(s.dt.max)} ms · hitch ${pct(
      s.hitchFraction,
    )} (${s.hitches}, vs the tier) · tier ${pct(s.tierFraction)} (${s.tierFrames})`,
  )
  lines.push(`  sim    p50 ${ms(s.sim.p50)}  p95 ${ms(s.sim.p95)}  max ${ms(s.sim.max)} ms`)
  lines.push(
    `  render p50 ${ms(s.render.p50)}  p95 ${ms(s.render.p95)}  max ${ms(s.render.max)} ms`,
  )
  lines.push(`  frame  p50 ${ms(s.frame.p50)}  p95 ${ms(s.frame.p95)}  max ${ms(s.frame.max)} ms`)
  lines.push(
    s.gpuFrames > 0
      ? `  gpu    p50 ${ms(s.gpu.p50)}  p95 ${ms(s.gpu.p95)}  max ${ms(s.gpu.max)} ms (n=${s.gpuFrames}, lagged)`
      : `  gpu    n/a — no timer query result landed`,
  )
  lines.push(
    `  ticks/frame  0:${s.ticks.zero}  1:${s.ticks.one}  2:${s.ticks.two}  3+:${s.ticks.threePlus}`,
  )
  // DEV-261. Printed ONLY when the trace holds something other than flight,
  // which is exactly when the stats above stop meaning what every previous
  // trace's meant. On a `?trace=<s>` window this line never appears and the
  // output is unchanged; on an open-ended `?perf=1` capture it is the warning
  // that a percentile up there is averaged over a lift ride.
  if (s.phases.preFlight > 0 || s.phases.runOver > 0) {
    const share = s.frames > 0 ? ((100 * s.phases.flying) / s.frames).toFixed(0) : '0'
    lines.push(
      `  phases       pre-flight:${s.phases.preFlight}  flying:${s.phases.flying}  ` +
        `run-over:${s.phases.runOver} — the stats above span ALL of them; ` +
        `only ${share} % is flight. Filter the CSV on phase==1.`,
    )
  }
  // DEV-227: the frustum, in degrees, because that is the unit a rig config is
  // written in — VRto3D's `fov` and the Frame's spec sheet are both degrees, and
  // a reader comparing this line to either of them should not have to do the
  // arctangents in their head. The tangents themselves stay in the header,
  // where a machine reads them; this is the line a human copies onto a page.
  //
  // Absent rather than zeroed on a flat run, matching the field.
  if (s.projection !== null) {
    for (const v of s.projection) lines.push(`  eye ${formatEyeProjection(v)}`)
  }
  // DEV-331. The lens mask's verdict in one line; the meshes are in the JSON.
  if (s.visibilityMask) {
    const m = s.visibilityMask
    const eyes = m.eyes.map(
      (e) => `${e.eye} ${e.triangles} tri, own-space area ${e.ownArea.toFixed(4)}`,
    )
    lines.push(
      `  lens mask: event ${m.supported ? 'exposed' : 'NOT exposed'} · ${m.watched} session(s) watched · ` +
        (eyes.length > 0 ? eyes.join(' · ') : 'no mask received'),
    )
  }
  lines.push('  worst frames by dt:')
  if (s.worst.length === 0) lines.push('    (none)')
  for (const w of s.worst) {
    const where = Number.isFinite(w.shipX)
      ? `x ${w.shipX.toFixed(0)} z ${w.shipZ.toFixed(0)}`
      : 'no ship'
    // DEV-177(b): the four world counters, and only when they are not zero.
    // A worst-frame line is read in a headset off a plate, so a row of `0 0 0
    // 0` on every frame would cost four columns of width to say nothing — the
    // interesting case is the one frame in a hundred where one of them moved.
    const world =
      w.terrainPending > 0 ||
      w.terrainDetailPending > 0 ||
      w.terrainFading > 0 ||
      w.seaPending > 0 ||
      w.seaFading > 0 ||
      w.pieces > 0
        ? ` · land ${w.terrainPending}p/${w.terrainDetailPending}d/${w.terrainFading}f` +
          ` · sea ${w.seaPending}p/${w.seaFading}f · ${w.pieces} pieces`
        : ''
    // DEV-239: and the nearest program rise BEFORE it. `programs` above is this
    // frame's own count and is flat across a deferred link — three counts the
    // program when it is CREATED and the driver links it on its first draw, ten
    // frames later. Printed unconditionally, with its distance, because a rise
    // 8 s back is a real answer (*not* this) and an absent line is not.
    const rise = w.precedingProgramRise
    const before =
      rise === null
        ? ' · no programs rise anywhere before it'
        : ` · nearest preceding programs rise: +${rise.delta} at ${rise.elapsedSeconds.toFixed(
            2,
          )} s, ${ms(rise.msEarlier)} ms earlier`
    // DEV-242: and the nearest streaming CHANGE before it, for the same reason
    // one line up. `world` above prints LEVELS, and on this mission's two
    // stalls those levels are `terr_fading` 12 and 14 against `sea_fading` 1 —
    // so a reader ranking them by size blames fourteen land chunks, and the
    // counter that actually stepped is the sea's. Signed, so a zero delta
    // beside a large level is visible as the non-event it is.
    const swap = w.precedingStreamingChange
    const sign = (n: number): string => (n >= 0 ? `+${n}` : `${n}`)
    const streaming =
      swap === null
        ? ' · no streaming change before it'
        : ` · nearest preceding streaming change at ${swap.elapsedSeconds.toFixed(2)} s,` +
          ` ${ms(swap.msEarlier)} ms earlier: land ${sign(swap.terrainPending)}p/${sign(
            swap.terrainFading,
          )}f · sea ${sign(swap.seaPending)}p/${sign(swap.seaFading)}f · tri ${sign(
            swap.triangles,
          )} · its render ${ms(swap.renderMs)} ms`
    lines.push(
      `    ${ms(w.dtMs)} ms at t=${w.elapsedSeconds.toFixed(2)} s · ${where} · ${w.calls} calls · ${(
        w.triangles / 1e6
      ).toFixed(2)}M tri · ${w.programs} prog${world}${before}${streaming}`,
    )
  }
  return lines.join('\n')
}
