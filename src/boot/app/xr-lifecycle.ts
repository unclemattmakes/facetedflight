// src/boot/app/xr-lifecycle.ts: the XR session's edges and a lost GL context,
// out of `bootApp`. APP-SPLIT phase 4 (`docs/plan/APP-SPLIT.md` §1b, "XR
// lifecycle": the listener block).
//
// `sessionstart` / `sessionend` (DEV-206's visibility, DEV-263's VR look) and `webglcontextlost` / `webglcontextrestored`.
// `paused` stays in the closure: it has ten writers and is phase 3's. Every
// line below was moved verbatim from the closure; the plumbing is `ctx.x`
// where the code reads a binding the closure still owns, and the returned
// object's accessors, which the closure reads the three states through.

import type { EditionState } from '@/game/edition'
import type { Renderer } from '@/render/renderer'

/** What `createXrLifecycle` reads from the closure: getters, each read live (APP-SPLIT §3's `ctx`). */
export interface XrLifecycleCtx {
  readonly editionState: EditionState
  readonly render: Renderer
}

export const createXrLifecycle = (ctx: XrLifecycleCtx) => {
  /**
   * The SteamVR dashboard is in front of us, or we are not being composited.
   *
   * ── What this is, measured rather than reasoned (DEV-206) ──────────────
   *
   * Matt, first Frame session: *"when I press what I think would be the
   * equivalent of a 'back' button, the entire VR app freezes."* It does not
   * freeze. Instrumented live on 2026-09-17, across a 4.01 s window while it
   * was happening, with four independent clocks:
   *
   *     setInterval heartbeat   3.99 Hz   alive
   *     window rAF            142.47 Hz   alive
   *     XRSession rAF          34.18 Hz   ALIVE
   *     gl.isContextLost()        false
   *     document.hidden           false   (never backgrounded)
   *
   * Nothing stops. `setAnimationLoop` keeps firing, XR frames keep arriving,
   * the compositor keeps being fed. What changes is one thing:
   * `XRSession.visibilityState` goes to `visible-blurred` — SteamVR's dashboard
   * is drawn in front of us and **input is withheld**. From inside a headset
   * that is indistinguishable from a freeze, which is why the report said
   * freeze and why two sessions went hunting a stopped loop for two days.
   *
   * The button itself never reaches the page at all: nineteen seconds of no
   * press events between the pilot's last real press and the transition. There
   * is no index to bind and nothing to catch — `guardedFrame` is not involved,
   * because nothing threw.
   *
   * ── Why it has to PAUSE, which is the part that is a defect ────────────
   *
   * `__ff2perf.sim()` sampled 2.5 s apart during the blur: **tick 21904 ->
   * 22109, 205 ticks, 81.967 Hz** — dead on the fixed step. The world runs at
   * full rate while the player can see nothing and press nothing. Matt's blur
   * lasted SIXTY SECONDS against `PlayerBoundary.resetDelay` of 13 s, which is
   * live in six of thirteen missions: four and a half reset windows from one
   * glance at a dashboard. On `int_01_jumpSeat` and `adv_02_jumpSeat` it is
   * worse than a lost race — those respawn 2.6 km outside a 2,047 m sphere, so
   * DEV-074's 15.5 s reset LOOP is reachable, which is the bug that made both
   * missions unplayable.
   *
   * ── Both arms, and `hidden` is the one to prove ────────────────────────
   *
   * The transition can land in either state. The same session was measured
   * going to `visible-blurred` on one press and to **`hidden`** on the next —
   * `hidden` being the stronger case where the app is not composited at all. A
   * handler written against `visible-blurred` alone passes every test anyone
   * would think to write and misses the one that was actually seen. So the
   * decision is `xrRunHeld` — *is it `visible`?* — rather than a list of the
   * states we happen to have met, and it lives in `boot/xr-visibility.ts` where
   * both arms can be asserted without a page.
   *
   * `null` is "no session", and is NOT a hold: a flat-screen player would
   * otherwise freeze on boot with nothing to set it back.
   */
  let xrVisibility: XRVisibilityState | null = null
  /** See the `webglcontextlost` listener below. Reported on the plate. */
  let contextLost = false
  {
    // `sessionstart` / `sessionend` on `renderer.xr`, which is the established
    // lifecycle hook in this repo — `render/flat-fov.ts:267` and
    // `render/quality.ts` both use it, with matching removals. The app owns
    // this one for its whole life, so there is nothing to remove.
    const xrLifecycle = ctx.render.renderer.xr as unknown as {
      addEventListener?: (type: string, fn: () => void) => void
    }
    const readXrVisibility = (): void => {
      // `xrRunHeld`, not an inline `!== 'visible'`, so the predicate the plate
      // prints and the predicate the run is held by cannot drift apart — and so
      // both arms are provable in a suite with no browser in it. See
      // `boot/xr-visibility.ts`.
      xrVisibility = ctx.render.renderer.xr.getSession()?.visibilityState ?? null
    }
    xrLifecycle.addEventListener?.('sessionstart', () => {
      // ── DEV-263: the preset's VR resolution goes live here ──────────────
      //
      // Matt, 2026-09-21, after the first worn A/B this project has taken:
      // *"switching to classic mode is the key for VR. holy shit it's a world
      // of difference."* Measured on the same mission at the same resolution
      // in the same minute: Classic held 97 % of its frames at 90 Hz and
      // Anniversary 75 %. Flat, the same build runs ~178 fps with 1.02 ms of
      // GPU — so the cheaper look is worth having in the headset and nowhere
      // else, which is what `edition.vr.disable` expresses.
      //
      // Before the visibility read below, so the first frame of the session is
      // already the VR resolution: everything with an Anniversary behaviour
      // re-reads on notify (`attachEditionHaze` and its siblings), and a frame
      // rendered between these two lines would be the flat look.
      ctx.editionState.setImmersive(true)
      const session = ctx.render.renderer.xr.getSession()
      // The EVENT as well as the read: a transition that reverts between two
      // polls is invisible to polling, and this one is driven by a human
      // opening and closing a system overlay.
      session?.addEventListener('visibilitychange', readXrVisibility)
      readXrVisibility()
    })
    xrLifecycle.addEventListener?.('sessionend', () => {
      xrVisibility = null
      // DEV-263. The flat page gets the full preset back: it has the headroom
      // for it, and a build that stayed on the VR look after the headset came
      // off would be a quality regression nobody asked for and nothing reports.
      ctx.editionState.setImmersive(false)
    })

    // ── A lost GL context, which nothing in `src/` could see (DEV-206) ────
    //
    // `grep -rn "webglcontextlost\|isContextLost\|loseContext" src/` returned
    // NOTHING before this line. A lost context stops rendering with no
    // exception, no visibility change and no thrown frame — the same shape of
    // silence as the blur above, and the same shape of absence: a state the app
    // can enter and has no listener for. Measured false during the blur, so it
    // is not what happened on 2026-09-17; it is a live possibility on a GPU at
    // 98 % of budget and it must not be diagnosed a second time from scratch.
    //
    // `preventDefault()` is what makes a restore POSSIBLE at all — without it
    // the browser will not fire `webglcontextrestored`. Actually rebuilding the
    // world on restore is not attempted here and is deliberately not claimed:
    // this says what happened, loudly, on the one surface a headset has.
    ctx.render.renderer.domElement.addEventListener('webglcontextlost', (event) => {
      event.preventDefault()
      contextLost = true
      console.error(
        'WebGL CONTEXT LOST — rendering has stopped. Nothing threw and nothing ' +
          'will: this is the silent one. Reload to recover.',
      )
    })
    ctx.render.renderer.domElement.addEventListener('webglcontextrestored', () => {
      contextLost = false
      console.warn('WebGL context restored — the scene is NOT rebuilt; reload for a clean world.')
    })
  }
  return {
    get xrVisibility() {
      return xrVisibility
    },
    get contextLost() {
      return contextLost
    },
  }
}
