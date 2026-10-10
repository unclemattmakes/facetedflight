/**
 * tests/e2e/fixtures/quality-pin.ts — pin the quality tier for a photo run, and
 * PROVE it held.
 *
 * ── The hole this closes ─────────────────────────────────────────────────
 *
 * DEV-245. None of this project's screenshot specs pinned the tier:
 * `baked-rung-photos.spec.ts`, `hud-upload-pixels.spec.ts` and
 * `draw-order-pixels.spec.ts` all loaded without `quality=` or `adaptive=`.
 * `render/quality.ts` measures the frame and **drops a tier when the box is
 * starved**, and CLAUDE.md's §3a-quater case is exactly that: *an unquiet box
 * does not mismeasure the build, it CHANGES it.* A tier drop moves MSAA, the
 * framebuffer scale, the shadow map and the prop LOD — **every one of which is
 * in a screenshot.**
 *
 * So an unpinned photo run can put arm A on one tier and arm B on another, and
 * the pictures are the deliverable somebody decides from. It is not only about
 * a second agent on the box: **one run alone can drift mid-flight between its
 * own arms**, which is the version nothing would ever notice.
 *
 * ── Two halves, and the second is the one that cannot be forgotten ───────
 *
 * `PINNED` is the query fragment. `?adaptive=0` stops the controller walking
 * the pixel count and `?quality=high` names the tier, which is
 * `boot/quality-pin.ts`'s whole job — *"a GPU number read while the adaptive
 * controller is walking the pixel count up and down is a number about the
 * controller"*, and a PICTURE taken across a tier change is a picture of two
 * builds.
 *
 * `drawState` is the half that makes the pin a fact rather than an intention.
 * A pin can fail to reach the runtime — that is not hypothetical here, queue A
 * row 01 of VR-PERF-WAVE-4 asked for a viewport scale of 0.600 and got 2016 px
 * every frame, and the refusal worked while the fix did not. So every shot
 * reads what is actually in force and the spec asserts the readings are
 * identical; a tier that moved must FAIL the run rather than quietly produce a
 * nicer picture.
 *
 * ── Read through `__ff2`, not `__ff2perf`, and why ───────────────────────
 *
 * `__ff2perf` is built only under `?perf=1` (`boot/app.ts`: `PERF_HUD ?
 * createPerfSurface(...) : null`), and `?perf=1` puts the perf PLATE in the
 * world beside the HUD — a panel no player has on screen, inside the frame
 * being judged. A spec whose output is a millisecond should take `?perf=1`;
 * a spec whose output is a picture must not. `__ff2.render.quality.report` is
 * the same `QualityReport` object one level down, with no instrument in the
 * shot.
 *
 * And the MSAA half is read off the CONTEXT rather than off the setting:
 * `gl.getParameter(gl.SAMPLES)` and the context's own `antialias` attribute
 * are what the hardware is doing, where `settings.quality` is what was asked
 * for. Those are the two ends of the chain queue A row 01 found disagreeing.
 */
import type { Page } from '@playwright/test'

/**
 * The query fragment every photo load carries. No leading `&`, so a call site
 * reads `?xr=off&...&${PINNED}` and the pin is visibly part of the URL rather
 * than appended by a helper somebody can forget to call.
 */
export const PINNED = 'adaptive=0&quality=high'

/**
 * Everything a tier drop would move that a screenshot can see.
 *
 * Deliberately not "the tier" alone. `quality.ts` changes several things at
 * once and a reader of a failure wants to know WHICH moved: a framebuffer
 * scale and an MSAA sample count are different bugs with different causes.
 */
export interface DrawState {
  /** `QualityReport.quality` — the tier in force. */
  readonly tier: string
  /** `QualityReport.scale` — the adaptive step. 1 when adaptive is off. */
  readonly adaptiveStep: number
  /** The tier's own base framebuffer scale, with no adaptive step in it. */
  readonly framebufferScale: number
  /** Flat pixel ratio actually set, or null while presenting. */
  readonly pixelRatio: number | null
  /** `setFoveation`'s current argument. */
  readonly foveation: number
  /** `gl.SAMPLES` — what the hardware is doing, not what was asked for. */
  readonly samples: number
  /** The context's own `antialias` attribute, read back. */
  readonly antialias: boolean
  /** The drawing buffer, `WxH`: the pixels the frame is actually rendered at. */
  readonly drawingBuffer: string
}

/**
 * Which fields of two readings disagree, as `field a -> b` lines.
 *
 * A pure function on purpose, and unit-tested
 * (`tests/unit/e2e-quality-pin.test.ts`): a guard whose failure mode is a pass
 * is not a guard (DEV-241), and the failure mode of a deep-equality check
 * written inline in a spec is that it compares two references, or two objects
 * that have both come back `null`, and reports agreement. Empty means held.
 */
export const drawStateDiff = (a: DrawState, b: DrawState): string[] => {
  const out: string[] = []
  const keys = Object.keys(a) as (keyof DrawState)[]
  for (const k of keys) {
    if (Object.is(a[k], b[k])) continue
    out.push(`${k} ${String(a[k])} -> ${String(b[k])}`)
  }
  return out
}

/** One reading as a line, for the log that runs beside every shot. */
export const drawStateLine = (s: DrawState): string =>
  `tier ${s.tier} · step ${s.adaptiveStep} · fb ${s.framebufferScale} · ` +
  `dpr ${s.pixelRatio ?? 'xr'} · foveation ${s.foveation} · ` +
  `${s.samples}x MSAA (antialias ${s.antialias}) · buffer ${s.drawingBuffer}`

/**
 * Read what is in force, from the live renderer.
 *
 * Throws rather than returning null on a missing handle: a guard that returns
 * "nothing to compare" on a page it could not read is a guard that passes
 * whenever it breaks.
 */
export const drawState = (page: Page): Promise<DrawState> =>
  page.evaluate(() => {
    interface Report {
      quality: string
      scale: number
      framebufferScale: number
      pixelRatio: number | null
      foveation: number
    }
    interface Gl {
      SAMPLES: number
      /**
       * The CONTEXT's own size, not `renderer.getDrawingBufferSize(target)` —
       * that one writes into its argument by calling `target.set(w, h)`, so a
       * plain object handed to it throws. The same shape as
       * `draw-order-pixels.spec.ts`'s note about `getWorldPosition()`: three's
       * accessors that take a target want a real three object, and the page
       * side of an `evaluate` has none.
       */
      drawingBufferWidth: number
      drawingBufferHeight: number
      getParameter: (p: number) => number
      getContextAttributes: () => { antialias?: boolean } | null
    }
    interface Three {
      getContext: () => Gl
    }
    const w = globalThis as unknown as {
      __ff2?: { render: { renderer: Three; quality: { report: Report } } }
    }
    const render = w.__ff2?.render
    if (!render) throw new Error('quality-pin: no __ff2.render — the page never booted')
    const report = render.quality.report
    const gl = render.renderer.getContext()
    return {
      tier: report.quality,
      adaptiveStep: report.scale,
      framebufferScale: report.framebufferScale,
      pixelRatio: report.pixelRatio,
      foveation: report.foveation,
      samples: gl.getParameter(gl.SAMPLES),
      antialias: gl.getContextAttributes()?.antialias === true,
      drawingBuffer: `${gl.drawingBufferWidth}x${gl.drawingBufferHeight}`,
    }
  })
