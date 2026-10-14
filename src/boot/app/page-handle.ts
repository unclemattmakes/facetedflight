// src/boot/app/page-handle.ts: the part of the `App` that ships. `main.ts`
// reaches exactly six members (`start`, `showWorld`, `reveal`, `onLoadProgress`,
// `touch`, `perfSurface`), and a production build has no use for the rest:
// `__ff2` is assigned under `import.meta.env.DEV` only. So `bootApp` returns
// THIS in a production build, and in dev it returns `createDebugHandle`
// (`debug-handle.ts`, a dynamic import under the same flag), which builds on
// this. That keeps the debug handle, and every module only it reaches, out of
// the entry chunk (DEV-960). Every line below was moved verbatim out of
// `createDebugHandle`.

import type { AudioSystem } from '@/audio'
import type { Capabilities } from '@/boot/capability-gate'
import type { LoadProgress } from '@/boot/load-progress'
import type { TouchControls } from '@/input/touch-overlay'
import type { Renderer } from '@/render/renderer'
import type { PerfSurface } from '../perf-surface'
import { BUILD_MODE, BUILD_VERSION } from '../version'
import type { App } from './types'

/** The members `main.ts` calls; a production build's whole `App`. */
export type PageApp = Pick<
  App,
  'start' | 'showWorld' | 'reveal' | 'onLoadProgress' | 'touch' | 'perfSurface'
>

/**
 * What the page handle reads from the closure (APP-SPLIT §3's `ctx`). The
 * debug handle's own bag (`DebugHandleCtx`) extends it, so the one object
 * `bootApp` builds serves both, and the import points this way only.
 */
export interface PageHandleCtx {
  readonly audio: AudioSystem
  readonly capabilities: Capabilities
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  cardLifted: boolean
  readonly guardedFrame: (time: number, xrFrame?: XRFrame | undefined) => void
  readonly loading: LoadProgress
  readonly maybeReveal: () => void
  readonly perfSurface: PerfSurface | null
  readonly render: Renderer
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  revealRequested: boolean
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  running: boolean
  readonly touch: TouchControls
}

export const createPageHandle = (ctx: PageHandleCtx): PageApp => {
  const { audio, capabilities, guardedFrame, loading, maybeReveal, perfSurface, render, touch } =
    ctx
  return {
    touch,
    perfSurface,
    /**
     * Lift the curtain (L3/L4); `main.ts` asks at boot (DEV-279).
     *
     * The canvas has been solid black since boot, so this is the visitor's
     * ARRIVAL rather than a cut: the title valley appears instead of replacing
     * a half-built one. It does not lift until the first world has settled,
     * which is the guarantee L1's button gating only makes likely.
     */
    showWorld() {
      ctx.revealRequested = true
      maybeReveal()
    },
    reveal() {
      ctx.revealRequested = true
      ctx.cardLifted = true
      maybeReveal()
      // ── Build the AudioContext HERE, under the curtain ──────────────────
      //
      // `audio/webaudio.ts` constructs no `AudioContext` until the first
      // `resume()`, and that is correct: a browser blocks one created without
      // a user gesture behind it. The gesture it waited for was the LAUNCH
      // confirm (`audio.resume()` on every confirm, and the comment there says
      // *"`resume()` is idempotent and cheap"*). True of every call except the
      // first, which builds the device:
      //
      //   rookie_01_jumpSeat   AudioContext  37.6 ms over 64 consecutive samples
      //   rookie_01_hoverJet   AudioContext  40.8 ms over 70 consecutive samples
      //
      // measured with `tests/e2e/frame-profile.spec.ts`, both ~230 ms after the
      // profiler armed, i.e. inside the frame that handles the confirm. It is
      // synchronous, so `void`ing the promise does not move it off the frame.
      //
      // **It was never a JumpSeat bug, though that is where it showed.** The
      // per-mission survey found it on six of six JumpSeats and none of seven
      // HoverJets, because a HoverJet rides a lift up the shaft before its
      // recorder arms and the JumpSeat launches straight off a pad, so the same
      // 40 ms lands before the window on one and inside it on the other.
      //
      // The player's first key, click or touch is a user gesture too, and it
      // is the FIRST one the game gets (until DEV-557 it was the landing
      // card's Start click). `reveal()` runs synchronously inside that event's
      // handler (`main.ts`'s `onGesture`), so the context builds on the title,
      // before anybody is flying. Strictly additive: the
      // confirm still resumes, because a context can be suspended again at any
      // time by a background tab or a headset coming off, and a second
      // `resume()` really is cheap.
      void audio.resume()
    },
    onLoadProgress(listener) {
      loading.subscribe(listener)
    },
    start() {
      ctx.running = true
      // setAnimationLoop, not requestAnimationFrame: in an XR session the
      // browser drives frames from the headset's own vsync and rAF is wrong.
      render.renderer.setAnimationLoop(guardedFrame)
      console.info(
        // DEV-600: the public name; "Faceted Flight 2" is the sequel's, and this is
        // the first line anyone who opens the console reads.
        `Faceted Flight: 10th Anniversary Edition ${BUILD_VERSION} (${BUILD_MODE}) · route: ${capabilities.route}`,
      )
    },
  }
}
