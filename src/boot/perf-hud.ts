// @engine-layer: imports nothing from game, content, generated or boot/app (tests/unit/engine-layering-guard.test.ts)
// src/boot/perf-hud.ts — the frame-time panel, behind `?perf=1`.
//
// ANNIVERSARY.md §4.3 wants *"a way to SEE frame time, draw calls and triangles
// in the running game"*, and §7 makes p95 frame time on a Quest 3 the gate on
// T1, C1, V3 and V2 — the four proposals with a budget risk. This is where that
// number is read from.
//
// The conventions are `boot/lookdev.ts`'s, deliberately, because it is the dev
// panel this project already has and two dev panels that behave differently is
// one more thing to remember:
//
//  - **Built only behind a `?` switch.** `?perf=1`, nothing else.
//  - **DOM, not scene — so it is a FLAT-SCREEN tool.** `dom-overlay` is not
//    reliably granted on Quest (CLAUDE.md), so in a headset there is nothing to
//    see. The Quest numbers come from a session run with the headset's own
//    developer overlay, or from the adaptive-resolution engagement counter this
//    panel also prints; see `docs/vr-testing.md`.
//  - **Nothing persists.** No `localStorage`, no setting. A reload is `?perf=1`
//    or it is nothing.
//  - **Three-free.** It consumes a `RenderInfoLite` value, not a renderer, which
//    is king-tide's `render/perf-hud.ts` convention and keeps this importable
//    from a `environment: 'node'` test.
//
// It differs from lookdev in one place: it binds its OWN `Backquote` listener
// rather than having `app.ts` do it, and removes it in `dispose()`. Four agents
// are editing `app.ts` in parallel this session, and a key binding that lives
// with the thing it toggles is one line of app.ts instead of three.
//
// **Cheap when hidden.** `tick()` returns before it touches a single
// `textContent`, and `isVisible()` lets the caller skip `stats()` — which sorts
// — entirely. A hidden panel costs one branch per frame.
//
// ── What `renderer.info.render.calls` actually is ────────────────────────
//
// The brief for this file said it is per-frame *"because three resets it in
// `setAnimationLoop`'s render"*. **That is the right conclusion from the wrong
// mechanism, and the difference decides whether the number can be trusted here.**
// Read in `three@0.185.1`:
//
//  - `three.module.js:17696`, inside `WebGLRenderer.render()`:
//    `if ( this.info.autoReset === true ) this.info.reset();` — so the reset is
//    done by **`render()`**, and `setAnimationLoop` has nothing to do with it.
//  - `three.module.js:4512-4518`, `WebGLInfo.reset()`, zeroes `render.calls`,
//    `.triangles`, `.points` and `.lines`. It does NOT zero `render.frame`,
//    which is incremented one line above the reset call and is the only
//    cumulative counter on the object.
//  - `three.module.js:4483`, `WebGLInfo.update()`: `render.calls ++` per draw.
//
// Two consequences. **First, it is per-frame for FF2 because FF2 calls
// `render()` exactly once a frame** (`app.ts`, one call site) and leaves
// `autoReset` alone — not because of the animation loop. An app that rendered
// into a target and then to the screen would see only the second call's draws
// here, and king-tide sees a cumulative number for precisely this reason: it
// drives its own rAF loop with `autoReset` off. **Second, `shadowMap.render()`
// runs AFTER the reset**, so shadow draws are counted in the same frame — which
// is the right behaviour for V3's budget question and worth knowing before
// anyone reads a number and blames the terrain.
//
// And king-tide's `render.drawCalls` **does not exist in WebGL.** It is a
// `WebGPURenderer` field; `WebGLInfo.render` in 0.185.1 is
// `{ frame, calls, triangles, points, lines }` and nothing else. Do not copy
// that half of its `RenderInfoLite`.
//
// Its `gpu-profiler.ts` does not come across either — it is WebGPU timestamp
// queries — but the reason written here was WRONG, and it was wrong for a
// session. ANNIVERSARY.md §4.3 says *"WebGL's timer query is disabled in
// browsers"* and this file repeated it; `EXT_disjoint_timer_query_webgl2` is
// present on desktop Chrome and DEV-118 built `boot/gpu-timer.ts` on it the
// same week. **A claim inherited from a doc is a hypothesis, not a
// measurement** — one `getExtension` call settled it. The GPU's own frame time
// is read by `gpu-timer.ts`, this panel's GPU row displays it, and the trace
// stores it per frame (`boot/perf-trace.ts`). What is still unmeasured is the
// extension INSIDE an XR session; VR-PERF.md §5.7's spike 2 is that question.
// (DEV-160.)

import type { FrameStats } from './perf-recorder'

/**
 * The subset of `THREE.WebGLRenderer['info']` this panel reads.
 *
 * Declared structurally so the module imports no Three. `renderer.info` is
 * assignable to it as-is.
 */
export interface RenderInfoLite {
  readonly render: {
    /** Draw calls of the CURRENT frame. See the note at the top of this file. */
    readonly calls: number
    /** Triangles of the current frame. Zeroed by the same `reset()`. */
    readonly triangles: number
  }
  readonly memory: {
    /** Resident GPU objects — running totals, NOT per-frame. */
    readonly geometries: number
    readonly textures: number
  }
}

/** The live state the panel prints beside the frame numbers. */
export interface PerfContext {
  /** `QualityReport.scale` — the adaptive-resolution step, 1 at full. */
  readonly scale: number
  /** `editionState.current.id` — which preset is live right now. */
  readonly edition: string
  /** `editionState.speedFx` — the comfort slider resolved to 0 / 0.5 / 1. */
  readonly speedFx: number
  /**
   * The terrain detail ring, if a mission terrain is live (DEV-085).
   *
   * ANNIVERSARY.md §5's Measure column for T1 is *"vertex count and frame time
   * on Quest"*, and the DRAW row above already carries both halves of the cost.
   * What it cannot say is what is SPENDING it: "108 k triangles" and "the ring
   * is holding fourteen chunks at 4 m" are the same fact, and only the second
   * can be read against the budget in the ledger row. Null on the title screen
   * and before the level lands.
   */
  readonly detail?: {
    /** Chunks drawing LOD −1 right now. */
    readonly chunks: number
    /** Chunks waiting on a detail mesh — capped by the preset's `maxInFlight`. */
    readonly pending: number
    /** Metres per quad inside the ring, from the live preset. */
    readonly resolution: number
  } | null
}

export interface PerfHud {
  readonly element: HTMLElement
  /** One update. Returns immediately when hidden. */
  tick(stats: FrameStats, info: RenderInfoLite, context: PerfContext): void
  /** Show or hide. Bound to `Backquote` by this module. */
  toggle(): void
  /**
   * Is anyone looking? The caller skips `stats()` when this is false — the
   * recorder's read sorts a few hundred floats and the panel is the only thing
   * that wants it.
   */
  isVisible(): boolean
  dispose(): void
}

const CSS = `
.ff2-perf {
  position: fixed; top: 12px; right: 12px; z-index: 41; box-sizing: border-box;
  min-width: 250px; padding: 8px 10px;
  background: rgba(14, 18, 26, 0.86); color: #d8e2ee;
  border: 1px solid rgba(140, 200, 255, 0.25); border-radius: 6px;
  font: 11px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: pre; pointer-events: none;
}
.ff2-perf[hidden] { display: none !important; }
.ff2-perf h2 {
  margin: 0 0 6px; font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
  color: #7fd1ff; font-weight: 600;
}
.ff2-perf .warn { color: #ffb4a2; }
`

/** How many decimals a millisecond gets. One: 12.3 ms, not 12.34 ms. */
const MS = 1

/** Compact triangle counts: 940 -> "940", 384000 -> "384k", 1.2M -> "1.2M". */
export const formatCount = (n: number): string => {
  if (!Number.isFinite(n) || n < 1000) return String(Math.round(n) || 0)
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** A fraction as a whole-number percent. `0.0139` -> `"1%"`. */
export const formatPercent = (fraction: number): string =>
  `${Number.isFinite(fraction) ? Math.round(fraction * 100) : 0}%`

/**
 * Build the panel. Hidden until `toggle()` or the caller shows it.
 *
 * Touches `document` only in here, so importing this module from a node test is
 * safe — the same lazy-DOM property king-tide's has and for the same reason.
 */
export const createPerfHud = (): PerfHud => {
  const style = document.createElement('style')
  style.textContent = CSS
  document.head.append(style)

  const root = document.createElement('aside')
  root.className = 'ff2-perf'
  // `hidden` rather than `style.display`, so nothing else has to know what the
  // panel's display mode was. lookdev.ts's convention.
  root.hidden = true

  const heading = document.createElement('h2')
  heading.textContent = 'perf — ` to hide'
  root.append(heading)

  const rows = {
    fps: document.createElement('div'),
    frame: document.createElement('div'),
    hitch: document.createElement('div'),
    draw: document.createElement('div'),
    mem: document.createElement('div'),
    res: document.createElement('div'),
    edition: document.createElement('div'),
  }
  for (const row of Object.values(rows)) root.append(row)
  document.body.append(root)

  const onKey = (event: Event): void => {
    if ((event as KeyboardEvent).code !== 'Backquote') return
    root.hidden = !root.hidden
  }
  globalThis.addEventListener?.('keydown', onKey)

  return {
    element: root,

    isVisible() {
      return !root.hidden
    },

    tick(stats, info, context) {
      // The early-out that makes a hidden panel free. Before every read of the
      // DOM and before any string is built.
      if (root.hidden) return

      const budget = stats.targetMs
      rows.fps.textContent = `FPS   ${stats.fps.toFixed(0).padStart(3)}   budget ${budget > 0 ? `${budget.toFixed(MS)} ms` : '—'}`
      rows.frame.textContent =
        `FRAME p50 ${stats.p50Ms.toFixed(MS)}  p95 ${stats.p95Ms.toFixed(MS)}  ` +
        `max ${stats.maxMs.toFixed(MS)}  mean ${stats.meanMs.toFixed(MS)} ms`
      // The window's own length, printed, because a hitch can shorten it — one
      // frame longer than the window leaves the panel reading a window of one
      // frame, and a reader who cannot see that would read a p95 of nothing.
      //
      // And the TIER share beside the hitch (DEV-179), because the two together
      // are the sentence: `hitch 1 % · tier 73 %` is a session pinned in a
      // reprojection tier and holding it, which is a different report from
      // `hitch 73 %` and is the true one. The plate prints the same pair — see
      // `boot/perf-format.ts`; two panels that show different numbers for the
      // same window is a bug report waiting to happen.
      rows.hitch.textContent =
        `HITCH ${formatPercent(stats.hitchFraction)} (${stats.hitches}/${stats.frames}) ` +
        `· tier ${formatPercent(stats.tierFraction)} over ${stats.seconds.toFixed(1)} s`
      rows.hitch.className = stats.hitches > 0 ? 'warn' : ''
      rows.draw.textContent = `DRAW  ${info.render.calls} calls · ${formatCount(info.render.triangles)} tri`
      rows.mem.textContent = `MEM   ${info.memory.geometries} geo · ${info.memory.textures} tex`
      // The two halves of M3's exit criterion in one row: what resolution the
      // controller is asking for right now, and how much of the window it spent
      // below full. The second is the 20 % number (DEV-058).
      rows.res.textContent =
        `RES   x${context.scale.toFixed(2)} · engaged ${formatPercent(stats.engagedFraction)} ` +
        `(${stats.engagedFrames}/${stats.frames})`
      // Which build you are looking at. The whole reason this panel exists is to
      // compare two presets, and a frame-time reading with no preset on it is a
      // number nobody can file. ANNIVERSARY.md §7.
      // The ring rides on this row rather than getting one of its own: it is a
      // property of the preset, it is only ever non-zero on one of them, and a
      // panel that grows a row per feature stops being readable at a glance —
      // which is the only way it is ever read.
      const d = context.detail
      const ring = d && d.chunks + d.pending > 0 ? ` · ring ${d.chunks}@${d.resolution}m` : ''
      const waiting = d && d.pending > 0 ? `+${d.pending}` : ''
      rows.edition.textContent = `ED    ${context.edition} · speedFx ${context.speedFx.toFixed(2)}${ring}${waiting}`
    },

    toggle() {
      root.hidden = !root.hidden
    },

    dispose() {
      globalThis.removeEventListener?.('keydown', onKey)
      root.remove()
      style.remove()
    },
  }
}
