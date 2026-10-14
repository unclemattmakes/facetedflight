// src/boot/contamination.ts: the page's half of "is this frame evidence?"
// DEV-914, docs/plan/perf-wave/perf-contamination.md. The rule and the
// controller's behaviour are `render/contamination.ts` and `render/quality.ts`.
//
// This file builds the GATE the quality controller asks once a frame, and feeds
// it the one signal that ships in EVERY build: the browser's own statement that
// the page is not being shown.
//
//  - `document.visibilityState === 'hidden'`: the tab is backgrounded or the
//    window minimised, and the browser throttles or stops its frames.
//  - the XR session's `visibilityState` of `hidden`: not shown at all.
//  - `visible-blurred` (the content is visible but not receiving input, and
//    the runtime may throttle the frame rate: the SteamVR dashboard, the system
//    menu) flags in DEV BUILDS ONLY. Nobody has worn a capture to see whether
//    SteamVR's Chrome reports it during normal play, and a production build
//    that did would freeze adaptive quality for a whole session. OPEN QUESTION
//    for a worn capture: the plate's `taint` row says if it ever fires.
//
// Those frames are not the build's cost by the platform's own definition, so
// the unambiguous ones are the flag a production build acts on. Everything that needs the
// dev server (a reload, the GPU lease, the host's CPU) is
// `contamination-dev.ts`, reached only through `import.meta.env.DEV`, and is
// ABSENT from a production bundle.
//
// Not a signal, and why: a long gap between animation frames. It cannot tell
// the box being starved from the app stalling itself (a program compile is a
// 300 ms gap too), and the app's own stalls are exactly the evidence the
// controller exists to read. The visibility states above name the throttling
// that really is not ours.

import {
  CONTAMINATION,
  type ContaminationGate,
  createContaminationGate,
} from '@/render/contamination'

/** What the page needs from `renderer.xr`: the live session, if any. */
export interface XrSessionHolder {
  getSession(): { visibilityState?: string } | null
}

export interface PageContamination {
  readonly gate: ContaminationGate
  /** The function `QualityOptions.contamination` takes: observe the page, then advance. */
  frame(dtSeconds: number): number
  /** Late-bound, because the quality controller is built INSIDE `createRenderer`. */
  attach(xr: XrSessionHolder): void
}

/** The reasons the page itself can see right now. Pure given its inputs. */
export const pageContaminationMask = (
  documentVisibility: string | undefined,
  xrVisibility: string | undefined,
  /**
   * Does `visible-blurred` count? DEV BUILDS ONLY (`createPageContamination`).
   * Whether SteamVR's Chrome reports it during NORMAL play has not been
   * verified worn; if it did, counting it in production would freeze adaptive
   * quality for a whole session on a platform behaviour nobody has seen. Open
   * question for a worn capture (docs/plan/perf-wave/perf-contamination.md).
   */
  blurredCounts = false,
): number => {
  if (documentVisibility === 'hidden') return CONTAMINATION.HIDDEN
  if (xrVisibility === 'hidden') return CONTAMINATION.HIDDEN
  if (blurredCounts && xrVisibility === 'visible-blurred') return CONTAMINATION.HIDDEN
  return 0
}

export const createPageContamination = (): PageContamination => {
  const gate = createContaminationGate()
  let xr: XrSessionHolder | null = null
  return {
    gate,
    attach(holder) {
      xr = holder
    },
    frame(dtSeconds) {
      gate.observe(
        pageContaminationMask(
          typeof document === 'undefined' ? undefined : document.visibilityState,
          xr?.getSession()?.visibilityState,
          import.meta.env.DEV,
        ),
      )
      return gate.advance(dtSeconds)
    },
  }
}
