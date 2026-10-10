// src/render/fade.ts — the transition fade. 2016 has one; the port had none.
//
// ── What this is ──────────────────────────────────────────────────────────
//
// A schedule, not a surface. It produces one number in 0..1 per render frame
// and `boot/app.ts` hands that to `vignette.setFade`, which owns the only
// full-screen black quad in the game. PORT_PLAN §2.1 rejected 2016's
// head-locked quad at z = 0.11 — *"1 cm of margin, in stereo, with per-axis
// off-axis projection"* — so the pass that draws this writes clip space
// directly and is per-eye correct by construction.
//
// There is no THREE in here and no clock of its own: it is fed `dtSeconds` and
// it is testable in node, which is the point. `tests/unit/fade.test.ts`.
//
// ── The curve is 2016's, including the part that looks like a bug ─────────
//
// `Fade_Mesh.Fade()` computes `fadeValue = timer / fadeTime` and then clamps
// `if (fadeValue > 0.85) fadeValue = 1`. So a 1.0 s fade is **solid black after
// 0.85 s** and spends its last 150 ms already solid. That is not rounding — it
// is the difference between a transition that lands and one that creeps — and
// `FADE.solidAtFraction` carries it out of the 2016 source rather than out of
// anybody's memory of it. Both serialised `AnimationCurve`s are straight lines
// and the extractor CHECKS that (`FADE.curve === 'linear'`), so the ramp below
// is a port of a measurement.
//
// ── Where the durations come from, and which one is a deviation ───────────
//
// `LOAD_FADE_SECONDS` is 2016's own mission-camera `fadeTime`, off the sheet.
// It is spent where 2016 spent it: arriving in a mission, after real work.
//
// `CUT_FADE_SECONDS` is 0.35 and it is OURS (DEV-107). 2016 fades 1.5 s between
// menu screens because it was covering a Unity scene load; four of this port's
// six transitions are a variable assignment, and 1.5 s of black over an instant
// change is 1.5 s of nothing — in a headset, 1.5 s of nothing in the dark.
// `docs/DEVIATIONS.md` carries the row. It is one constant and a headset is the
// only thing that can judge it.
//
// **And one did (DEV-427).** A move between screens no longer spends it: it
// takes 2016's own per-rig fade, `screenMoveFade` below. What still spends
// `CUT_FADE_SECONDS` is the boot handover and the crash curtain's way back.

import { FADE } from '@/generated/constants.generated'
import { clamp01 } from '@/sim/math/scalar'

/** 2016's mission-camera fade. Spent where a real load is being covered. */
export const LOAD_FADE_SECONDS: number = FADE.missionSeconds

/**
 * The port's own number for a transition that is a variable assignment.
 *
 * DEV-107, and the one number in `docs/plan/LOADING.md` that is a guess rather
 * than a measurement. 2016's nearest comparable is `menuSeconds` (0.75), which
 * covers a scene load this port does not perform.
 */
export const CUT_FADE_SECONDS = 0.35

/**
 * The fraction of a leg at which the screen is already fully black or fully
 * clear. Straight out of `Fade_Mesh.Fade()`'s inline clamp — see the header.
 */
export const SOLID_AT: number = FADE.solidAtFraction

/**
 * A DEATH is a snap, not a fade — a tenth of a second, where every other
 * transition in the game is most of one.
 *
 * `Trigger_Kill.RestartLevel()` overrides the shared fader's `fadeTime` to this
 * at runtime before triggering it, so no prefab carries the number and a grep
 * for `fadeTime` in the YAML never finds it. Extracted from the method body.
 *
 * **There is deliberately no `RESPAWN_IN_SECONDS` beside it.** The way back in
 * is `LoadLevelArt.LoadLevel()` calling `fader.FadeIn()` on the RELOADED
 * scene's own fresh fader, which is `LOAD_FADE_SECONDS` again — the 0.1 died
 * with the old object. A second name for that number is a constant that will
 * one day disagree with itself, which is DEV-069's whole lesson.
 *
 * And the BLACK between them is not here either: 2016 holds it for
 * `FADE.respawnHoldSeconds` while the scene reloads, and `sim/boundary.ts` has
 * been running exactly that as its `dying` phase since before anything drew it.
 * One clock, in the sim, where it belongs — the curtain just waits to be
 * released.
 */
export const KILL_FADE_SECONDS: number = FADE.killSeconds

// ── DEV-427: a move between screens takes 2016's own fade ───────────────
//
// Matt, 2026-09-26: *"should fade in/out when making large camera moves
// (title-screen to hangar. hangar to elevator, mission to hangar, first to
// third, third to first)"*. Every one of those moves already went through
// `goToScreen`'s curtain (DEV-107), measured frame by frame in
// `tests/e2e/move-fades.spec.ts`: all five reached solid black, and every
// picture change landed on a black frame. They were not MISSING. They were
// `CUT_FADE_SECONDS` long, which is about 0.3 s to black and 0.3 s back, and
// the camera switch was a blink with one frame of black in it.
//
// DEV-107 called 0.35 *"the one number in the whole design that is a guess"*
// and said a headset would settle it. This is the settling, and it goes back
// to 2016 rather than to a second guess. `LevelLoader.cs` fades a scene out
// over the `fadeTime` of the fader IN THAT SCENE, and the next scene's own
// fader brings it in over ITS `fadeTime`: the menus' rig says 0.75 s and the
// missions' rig says 1.0 s. So each leg of a move is the rig of the screen
// the leg is drawn on, and both numbers are the sheet's.

/** 2016's menu-rig fade (`Cameras.prefab` under `legacy_root_prefabs`), per leg. */
export const MENU_FADE_SECONDS: number = FADE.menuSeconds

/** The screens a move can go between. `boot/app.ts`'s `screen`, spelled here so this stays DOM-free. */
export type FadeScreen = 'title' | 'menu' | 'mission'

/**
 * The seconds of fade a leg drawn on `screen` takes: the fader of the rig 2016
 * drew that screen with. The title and the hangar are menu scenes; a mission
 * is the mission rig.
 */
export const rigFadeSeconds = (screen: FadeScreen): number =>
  screen === 'mission' ? LOAD_FADE_SECONDS : MENU_FADE_SECONDS

/**
 * The fade for a move from one screen to another: out on the screen you
 * leave, in on the one you arrive at. What `goToScreen` spends when its
 * caller names no duration of its own.
 */
export const screenMoveFade = (
  from: FadeScreen,
  to: FadeScreen,
): { readonly outSeconds: number; readonly inSeconds: number } => ({
  outSeconds: rigFadeSeconds(from),
  inSeconds: rigFadeSeconds(to),
})

/**
 * How long the camera switch sits at SOLID black: 2016's hold, which the port
 * never spent.
 *
 * `CamChanger.ChangeCam()` triggers the fade-out over 0.12 s, then
 * `WaitForSeconds(0.2f)` FROM THE TRIGGER, then triggers the fade-in and
 * reparents the camera. The fade-out is solid at `SOLID_AT` of its 0.12 s, so
 * the screen is black for the rest of the 0.2 s: about 0.1 s. The sheet has
 * carried `cameraSwitchHoldSeconds` since DEV-128 with no reader, and the port
 * released the curtain on the first black frame: measured on the 180 Hz desk,
 * 18 frames (112 ms) going dark, TWO frames of black, 37 frames (212 ms) coming
 * back. A blink.
 */
export const CAMERA_SWITCH_BLACK_SECONDS: number =
  FADE.cameraSwitchHoldSeconds - FADE.cameraSwitchOutSeconds * SOLID_AT

/** Where a transition is. `hold` is solid black; `idle` is clear and doing nothing. */
export type FadePhase = 'idle' | 'out' | 'hold' | 'in'

export interface FadeSpec {
  /** Seconds to go black. 0 means "already black" — used by the boot handover. */
  readonly outSeconds: number
  /** Seconds to come back. */
  readonly inSeconds: number
  /**
   * How long to sit at solid black.
   *
   * A number is a fixed wait. **`'released'` waits for `release()`** and is what
   * a real load uses — the work decides, not the clock.
   *
   * `'released'` is also why nothing here returns a promise. A backgrounded tab
   * stops `setAnimationLoop` entirely (`pause.spec.ts` says so), so a caller
   * awaiting "the screen is black now" would wait for ever with the world half
   * torn down. `release()` is a flag the state machine consumes when it next
   * runs, and if it never runs, nothing has happened and nothing is stuck.
   */
  readonly holdSeconds: number | 'released'
}

export interface Fade {
  /** 0..1 black over everything. Hand this to `vignette.setFade` every frame. */
  readonly amount: number
  readonly phase: FadePhase
  /** True from `begin()` until the fade-in has finished. */
  readonly busy: boolean
  /** True once the screen is actually solid — the moment it is safe to swap what is behind it. */
  readonly black: boolean
  /**
   * Start a transition. A `begin()` during one REPLACES it from wherever the
   * screen currently is, so a double press does not stack two fades.
   */
  begin(spec: FadeSpec): void
  /** Let a `holdSeconds: 'released'` transition start coming back. */
  release(): void
  /** Jump to solid black and hold there until `release()`. The boot state. */
  blackOut(): void
  /** Advance one RENDER frame. */
  update(dtSeconds: number): void
}

/**
 * 2016's ramp: linear in `t / seconds`, reaching the end at `SOLID_AT` of the
 * way through and holding there for the rest.
 *
 * A zero or negative duration is instant rather than a division by zero — the
 * boot handover asks for exactly that.
 */
export const fadeRamp = (elapsed: number, seconds: number): number =>
  seconds <= 0 ? 1 : clamp01(elapsed / seconds / SOLID_AT)

export const createFade = (): Fade => {
  let phase: FadePhase = 'idle'
  let amount = 0
  let elapsed = 0
  let spec: FadeSpec | null = null
  let releaseRequested = false
  /** Where the fade-out started from, so an interrupted transition does not jump. */
  let fromAmount = 0

  const enter = (next: FadePhase): void => {
    phase = next
    elapsed = 0
  }

  return {
    get amount() {
      return amount
    },
    get phase() {
      return phase
    },
    get busy() {
      return phase !== 'idle'
    },
    get black() {
      return amount >= 1
    },
    begin(next) {
      spec = next
      releaseRequested = false
      fromAmount = amount
      // An `outSeconds` of 0 is not "instantly black then fade in"; it is "you
      // are already black, come back". The boot handover (L3) is that case and
      // so is every retry of a transition that is already solid.
      if (next.outSeconds <= 0 && amount >= 1) {
        enter('hold')
      } else {
        enter('out')
      }
    },
    release() {
      releaseRequested = true
    },
    blackOut() {
      spec = { outSeconds: 0, inSeconds: CUT_FADE_SECONDS, holdSeconds: 'released' }
      releaseRequested = false
      amount = 1
      fromAmount = 1
      enter('hold')
    },
    update(dtSeconds) {
      if (phase === 'idle' || !spec) return
      elapsed += dtSeconds > 0 ? dtSeconds : 0
      if (phase === 'out') {
        // From wherever we were, not from 0. Interrupting a half-finished
        // fade-in and starting again must not brighten the screen first.
        amount = fromAmount + (1 - fromAmount) * fadeRamp(elapsed, spec.outSeconds)
        if (amount >= 1) {
          amount = 1
          enter('hold')
        }
        return
      }
      if (phase === 'hold') {
        amount = 1
        if (spec.holdSeconds === 'released') {
          if (releaseRequested) enter('in')
        } else if (elapsed >= spec.holdSeconds) enter('in')
        return
      }
      // 'in'
      amount = 1 - fadeRamp(elapsed, spec.inSeconds)
      if (amount <= 0) {
        amount = 0
        phase = 'idle'
        spec = null
      }
    },
  }
}
