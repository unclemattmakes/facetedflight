// src/boot/app/screen-router.ts: which screen you are on, and the one place it
// changes. APP-SPLIT phase 3, slice 3 (`docs/plan/APP-SPLIT.md` §5).
//
// `screen` (three values: `title`, `menu`, `mission`; §1d), `pendingScreen`,
// `goToScreen` (which only QUEUES), the fades counted for `__ff2.fade()`, and
// the frame's step 1 (§1c): the fade, then the swap at black, the act, the
// edition the arrival wears, and the release. `frame` is the ONLY writer of
// `screen`, as the swap in the frame loop was; everything else reads
// `router.screen`. Every line below was moved verbatim from the closure; the
// plumbing is `ctx.x` where the code reads a binding the closure still owns,
// the step wrapped as `frame(frameSeconds)`, and the returned object.

import { stats } from '@/boot/stats-beacon'
import { type Fade, screenMoveFade } from '@/render/fade'
import { AUTOPILOT_AT_BOOT, EDIT_AT_BOOT, SKIP_MENU, SKIP_TITLE, VIEWPOINT } from './pins'
import type { createLoadingHost } from './world/loading'

/** What `createScreenRouter` reads from the closure: getters, each read live (APP-SPLIT §3's `ctx`). */
export interface ScreenRouterCtx {
  readonly fade: Fade
  readonly loadingHost: ReturnType<typeof createLoadingHost>
  readonly wearEditionFor: (arrived: 'title' | 'menu' | 'mission', building: boolean) => void
}

export const createScreenRouter = (ctx: ScreenRouterCtx) => {
  const { fade, wearEditionFor } = ctx
  /**
   * Which screen you are on. `menu` is the hangar chair; `mission` is the ship.
   *
   * Not a `LaunchPhase`: the launch state machine is about the LIFT, and it
   * already has four phases that all mean "in the cockpit". This is the thing
   * above it, and 2016 drew the same line by making them separate scenes.
   */
  // A VIEWPOINT is a photograph of the mission's world, so it boots there too.
  // Without this the fixed camera was applied to a scene still showing the
  // title valley 30 km away and every `?view=cam` shot came back as the logo:
  // `water-underside.spec.ts` worked around it with `menu=0` and said so in a
  // comment, while `viewpoints.spec.ts` and `lookdev.spec.ts` went on
  // photographing the title for every named viewpoint, green, because the
  // only thing they asserted was the attribute this file sets (DEV-095).
  // DEV-471: `?edit=1` boots to the menu screen, where the loading scene is drawn.
  let screen: 'title' | 'menu' | 'mission' = EDIT_AT_BOOT
    ? 'menu'
    : SKIP_MENU || AUTOPILOT_AT_BOOT || VIEWPOINT
      ? 'mission'
      : SKIP_TITLE
        ? 'menu'
        : 'title'
  /**
   * A screen change queued behind the fade (DEV-107). Null when nothing is in
   * flight.
   *
   * The change happens AT BLACK, not at the press — everything a transition
   * used to do inline (`restartRun`, `hangar.refresh`, the console line) moves
   * into `act` so it happens behind the curtain too. Half a second late and
   * invisible beats instant and watched: a run resetting in plain view is the
   * cut this whole feature exists to hide.
   */
  let pendingScreen: { to: 'title' | 'menu' | 'mission'; act: (() => void) | null } | null = null

  /**
   * Leave for another screen, behind black.
   *
   * The durations default to 2016's own, per leg (DEV-427, `screenMoveFade`):
   * out over the fader of the screen you LEAVE, in over the fader of the one you
   * ARRIVE at — the menus' rig 0.75 s, a mission's 1.0 s. They used to default
   * to the port's `CUT_FADE_SECONDS` both ways, about 0.3 s to black, and Matt
   * did not see those as fades at all. Boarding a mission still passes
   * `LOAD_FADE_SECONDS` in by name, which is the same number the rule gives.
   *
   * `holdSeconds` sits at solid black for that long after the act, where the
   * default is one frame. Only the camera switch asks (2016's `CamChanger`
   * wait, `CAMERA_SWITCH_BLACK_SECONDS`): every other move either has nothing
   * to wait for or waits on real work, which releases from elsewhere.
   *
   * A second call while one is queued is IGNORED rather than replacing it. Two
   * transitions racing behind one curtain is how you arrive somewhere neither
   * press asked for, and input under load is already flaky enough here that
   * three false leads in one session were lost keypresses.
   */
  /**
   * How many screen transitions have been QUEUED — one per fade to black.
   * For `__ff2.fade()`: a fade that begins while the screen is already black
   * never shows a lighter frame, so no picture can count it, and a route that
   * should take one black taking two is only visible as this number
   * (DEV-353 follow-up).
   */
  let screenFades = 0
  const goToScreen = (
    to: 'title' | 'menu' | 'mission',
    opts: {
      readonly outSeconds?: number
      readonly inSeconds?: number
      readonly holdSeconds?: number
      readonly act?: () => void
    } = {},
  ): void => {
    if (pendingScreen) return
    pendingScreen = { to, act: opts.act ?? null }
    screenFades += 1
    const move = screenMoveFade(screen, to)
    fade.begin({
      outSeconds: opts.outSeconds ?? move.outSeconds,
      inSeconds: opts.inSeconds ?? move.inSeconds,
      // A number is a timed hold, which `fade.release()` at the swap does not
      // cut short; `'released'` comes back on the frame after the swap.
      holdSeconds: opts.holdSeconds ?? 'released',
    })
  }
  /** The frame's step 1 (APP-SPLIT §1c): the fade, then the swap at black. */
  const frame = (frameSeconds: number): void => {
    // ── the transition fade, first thing (DEV-107) ───────────────────────
    //
    // Before the input read, so a screen change queued last frame is IN EFFECT
    // for the whole of this one. `goToScreen` only queues; this is where a
    // screen actually changes, and it happens on the frame the curtain is
    // solid.
    fade.update(frameSeconds)
    if (pendingScreen && fade.black) {
      screen = pendingScreen.to
      stats.stage(screen === 'menu' ? 'hangar' : screen)
      pendingScreen.act?.()
      pendingScreen = null
      // DEV-451: the edition the screen we arrived at wears, at its black
      // (DEV-427's rule: a flip is never made in view). AFTER the act, which
      // is where a title row or the hangar names the course it is loading.
      wearEditionFor(screen, ctx.loadingHost.loadingTarget !== null)
      // One frame of black and then back. The long holds belong to the two
      // things that really wait — the boot, and a course swap's load — and both
      // of those release from somewhere else. A TIMED hold (the camera switch,
      // DEV-427) ignores this and comes back on its own clock.
      fade.release()
    }
  }
  return {
    frame,
    goToScreen,
    get pendingScreen() {
      return pendingScreen
    },
    get screenFades() {
      return screenFades
    },
    get screen() {
      return screen
    },
  }
}
