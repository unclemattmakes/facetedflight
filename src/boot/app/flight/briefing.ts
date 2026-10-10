// src/boot/app/flight/briefing.ts: the briefing plate and the prompts the pad
// shows, out of `bootApp`. APP-SPLIT phase 4, slice 8 (flight; `docs/plan/APP-SPLIT.md` §5).
//
// 2016's briefing text and DEV-631's plate (`briefingState`, `briefingLevel`),
// the launch banner, and the confirm prompt's state and words, with the race
// chip (`confirmNow`, `raceLapOffered`, `touchRaceLabel`). The launch's own
// audio (`audioLaunch`, `audioShaft`) sits between the two in the closure and
// stays there with the frame's audio edges. Every line below was moved
// verbatim from the closure; the plumbing is `ctx.x` where the code reads a
// binding the closure still owns, and the returned object.

import { DIFFICULTY_ORDER, type GameMode, type Level } from '@/content/level-schema'
import { uiBriefing, uiString } from '@/content/ui-strings'
import { briefingCopy } from '@/game/briefing-copy'
import type { EditionState } from '@/game/edition'
import type { Flight } from '@/game/flight'
import type { LapRun } from '@/game/lap-run'
import { environmentDisplayName } from '@/game/mission-index'
import { type ConfirmState, confirmLabel, confirmMeans } from '@/input/confirm'
import { RACE_LAP_LABEL } from '@/input/touch-overlay'
import { type BriefingState, briefingOpacity } from '@/render/briefing'
import type { ControlsDevice } from '@/render/controls-menu'
import { launchPromptFor } from '@/render/controls-menu'
import type { RunSummary } from '@/render/results'
import { skiMarkShape } from '@/render/ski-marks'
import type { BoundaryState } from '@/sim/boundary'
import { type BoundarySpec, boundaryCountdown } from '@/sim/boundary'
import type { LaunchState } from '@/sim/launch'
import { countdownNumber, type LaunchSpec, topRise } from '@/sim/launch'

/** What `createBriefing` reads from the closure: getters, each read live (APP-SPLIT §3's `ctx`). */
export interface BriefingCtx {
  readonly RUNNING_MODE: GameMode
  readonly boundary: BoundaryState
  readonly boundarySpec: BoundarySpec | null
  readonly confirmDevice: () => ControlsDevice
  readonly editionState: EditionState
  readonly flight: Flight | null
  readonly lapAskUp: () => boolean
  readonly lapRun: LapRun | null
  readonly lastResult: RunSummary | null
  readonly launch: LaunchState
  readonly launchSpec: LaunchSpec | null
  readonly level: Level
  readonly paused: boolean
  readonly roomActive: () => boolean
  readonly roomWaitingLine: () => string | null
  readonly screen: 'title' | 'menu' | 'mission'
  readonly tvActive: () => boolean
}

export const createBriefing = (ctx: BriefingCtx) => {
  /**
   * 2016's own briefing, from `level.ui.briefing`.
   *
   * The literal that stood here was wrong in two ways a careful port makes it
   * wrong: the apostrophe had been normalised from U+0027 to U+2019, and the
   * trailing newline was dropped. Both are in the shipped bytes.
   *
   * The fallback is FF2's, and it is the old literal with those two things
   * fixed — used only by a level built before the extractor read UI text, of
   * which there are none.
   */
  const BRIEFING_TEXT_2016 = (): string =>
    uiBriefing(
      ctx.level,
      "Fly through as many rings as you can before time runs out. Don't CRASH!!\n",
    )

  /**
   * DEV-631: what the plate says, read live (the level and the look can both
   * change under a running app). The Classic look keeps 2016's plate, its
   * development title and its one sentence (D35: the look is the in-mission
   * visuals). Anniversary names the PLACE, wears the course's difficulty as the
   * hangar's ski mark, and says what the mode's rules do (`game/briefing-copy.ts`,
   * which says where each claim was checked).
   */
  const briefingState = (): BriefingState => {
    if (ctx.editionState.current.id === 'classic') {
      return { title: ctx.level.title, text: BRIEFING_TEXT_2016() }
    }
    const energy = ctx.editionState.current.gameplay.energy
    const rank = DIFFICULTY_ORDER.indexOf(ctx.level.difficulty)
    return {
      title: environmentDisplayName(ctx.level.environment),
      text:
        briefingCopy(ctx.level.vehicle, ctx.RUNNING_MODE, {
          ringsPayBoost: energy.enabled && energy.ringRefill > 0,
        }) ?? BRIEFING_TEXT_2016(),
      mark: rank >= 0 ? skiMarkShape(rank) : null,
    }
  }

  /**
   * The briefing plate's opacity: up on the pad and for the first 40 % of the
   * ride, faded out by HALF WAY UP it (DEV-526). Before that it went down at the
   * launch press (DEV-395), and before that once the countdown started.
   *
   * 2016 kills `panel_mission` on a timer from spawn, which in a build that has
   * no elevator prompt is the same moment. FF2 waits for A, so a fixed timer
   * would expire while the player was still reading — the phase is the honest
   * equivalent of "while the ship is powering up".
   *
   * **The panel dies at 3.8 s. DEV-200 "corrected" that to 4.12 and was wrong;
   * DEV-217 puts it back.** `panel_mission` carries its own `disableAfterDelay`
   * — `disableDelay: 3.8`, enabled, targeting itself, on
   * `PlayerShip_SR14_Photon.prefab:10176` and `:12320` — and `disableDelay` is a
   * `public float` with NO initialiser, so the prefab's value is shipped
   * behaviour rather than a code default. `HUD_Ship.DelayedStart()`'s
   * `0.12f + 4f` (`:88-99`) is a SECOND `HideMissionUI()`, against a panel that
   * has already been inactive for 0.32 s. 2016 staged it that way: the briefing
   * clears at 3.8 and `panel_viewSwitch` arrives at 4.0 (`DelayObjectEnable`,
   * `delayTime: 4`) — at 4.12 the two prompts would overlap. Nothing here
   * depends on either figure — it is a phase, not a clock.
   *
   * And 2016 shows **no briefing at all in Free Flight**: `HUD_Ship.cs:78-82`
   * calls `HideMissionUI()` in `Start()` when the mode is Free Flight. The port
   * shows it on `hoverJet_kauai_beg`. `docs/hud-readout-2016-vs-port.md` §7.
   *
   * **Down when the ride STARTS, not at the countdown (DEV-395).** Matt, look
   * call 8: *"keep the motes, drop the briefing during the elevator ride."*
   * `render/briefing.ts` has the argument; this used to read `waiting || rising`.
   *
   * **And since DEV-526, at HALF WAY UP the ride, fading.** Matt: *"half way up
   * the ride"*. By the platform's height (`launch.rise` over the curve's top),
   * which `briefingOpacity` reads; `render/briefing.ts` says why height.
   */
  const briefingLevel = (): number => {
    if (ctx.launchSpec) return briefingOpacity(ctx.launch, topRise(ctx.launchSpec))
    // DEV-631: a JumpSeat has no pad; its plate is up through
    // `Trigger_EnableJumpShip`'s countdown (the seat not yet live), on
    // Anniversary, whose words are about the JumpSeat. 2016's sentence is about
    // rings, so the Classic look keeps the JumpSeat plate down.
    return ctx.editionState.current.id !== 'classic' && ctx.flight?.countdownHolds === true ? 1 : 0
  }
  const launchBanner = (): string | null => {
    // DEV-863: FF-TV is watched, not flown, and a viewer has no ship to launch
    // or to bring back (Matt saw "Press A to launch" over a broadcast).
    if (ctx.tvActive()) return null
    // Out of bounds outranks the launch: if both were somehow true you would
    // rather know you are about to die than that you are powering on.
    if (ctx.boundarySpec) {
      if (ctx.boundary.phase === 'dying') return 'OUT OF BOUNDS'
      const left = boundaryCountdown(ctx.boundary, ctx.boundarySpec)
      if (left !== null) return `RETURN — ${left}`
    }
    if (!ctx.launchSpec || ctx.launch.phase === 'flying') return null
    // 2016's own words, off the ship prefab's HUD panels: `panel_preLaunch`
    // carries "Press A to launch" and `panel_Startup` carries "Powering On..."
    // (with an `Audio_Elevator` child, which is the sound this still owes).
    // The wording was reasoned to almost exactly this before the prefab was
    // read; using the real strings costs nothing and is free fidelity.
    // Both 2016's, unchanged — including the three dots, which are three
    // full stops in the shipped bytes and not an ellipsis character.
    // DEV-396: worded for the device in the player's hands, 2016's string
    // unedited — a pad and a headset read it byte for byte.
    if (ctx.launch.phase === 'waiting') {
      // DEV-389: in a room A does nothing; the room starts the countdown.
      return (
        ctx.roomWaitingLine() ??
        launchPromptFor(
          uiString(ctx.level, 'launchPrompt', 'Press A to launch'),
          ctx.confirmDevice(),
        )
      )
    }
    if (ctx.launch.phase === 'rising') return uiString(ctx.level, 'launching', 'Powering On...')
    const n = countdownNumber(ctx.launch, ctx.launchSpec)
    return n === null || n === 0 ? 'GO' : String(n)
  }

  /**
   * What a confirm would mean RIGHT NOW — the live state, gathered once.
   *
   * These branches are the confirm handler's branches, IN ITS ORDER, and they
   * have to stay that way: this is one button whose meaning changes five times,
   * and a label naming a different branch from the one that fires is worse than
   * no label — it is a button you press, disbelieve, and stop trusting.
   *
   * The branch list itself used to be written out HERE, a second time, with
   * that paragraph as its only guard. It is `input/confirm.ts` now, and it has
   * two readers: `touchConfirmLabel` below, and the WebXR primary action's
   * arming at the confirm site (DEV-205). Read that file for why a third copy
   * was refused. `tests/unit/xr-select.test.ts` §1 reads the handler's own
   * `if/else if` chain out of this file and fails if the two orders part
   * company; `tests/e2e/mobile-controls.spec.ts` reads the word off the button
   * at each screen and then presses it.
   */
  const confirmNow = (): ConfirmState => ({
    // The confirm handler is gated on `flight`, so before the world loads a
    // press genuinely does nothing and there should be nothing to press.
    worldLoaded: ctx.flight !== null,
    screen: ctx.screen,
    paused: ctx.paused,
    finished: ctx.lastResult !== null,
    launchPhase: ctx.launch.phase,
  })

  /**
   * The word on the touch overlay's one big button, or null to take it away.
   *
   * `null` while the ship is flying, because there A does nothing: `startLaunch`
   * is idempotent for a launch that already happened. A button that is always
   * there and usually inert is furniture over a game played on a screen the
   * size of a hand.
   */
  const touchConfirmLabel = (): string | null => {
    // DEV-607: Matt, 2026-10-03: *"remove the big button everywhere once
    // tap-to-choose lands"*. Every press it made is a tap on the thing itself
    // now: a hangar table (DEV-604), a row of a plate, the glass on the pad and
    // on the results panel (`glassConfirms`). The title's own START is the
    // title's to remove (DEV-619), so it is the one label left here.
    const now = confirmNow()
    return confirmMeans(now) === 'start' ? confirmLabel(now) : null
  }

  /**
   * DEV-607: where a tap on the bare glass IS the press the big button was:
   * on the pad, waiting to launch; and on the results panel when no menu stands
   * under it (with one, its BACK TO THE HANGAR row is the way home).
   */
  const glassConfirms = (): boolean =>
    ctx.flight !== null &&
    ctx.screen === 'mission' &&
    !ctx.paused &&
    !ctx.tvActive() &&
    (ctx.lastResult !== null ? !ctx.lapAskUp() : ctx.launch.phase === 'waiting')

  /**
   * Whether a "race this lap" press would act RIGHT NOW (DEV-371): the results
   * panel is up, this run left a lap, nothing is paused. ONE predicate, read by
   * the race handler and by the touch chip's context, so the chip is offered
   * exactly when a press does something (DEV-371 follow-up).
   */
  const raceLapOffered = (): boolean =>
    ctx.flight !== null &&
    ctx.lastResult !== null &&
    !!ctx.lapRun?.last &&
    ctx.screen === 'mission' &&
    !ctx.paused &&
    // DEV-389: a room's race is the room's; its next one starts in the lobby.
    !ctx.roomActive()

  /**
   * The race chip's word, or null to take it away. It used to name two other
   * branches of the same press (another name, DEV-373; keep it, DEV-374);
   * DEV-571 moved both onto the results panel's menu, so the press is always
   * "race this lap".
   */
  const touchRaceLabel = (): string | null => (raceLapOffered() ? RACE_LAP_LABEL : null)
  return {
    confirmNow,
    glassConfirms,
    raceLapOffered,
    briefingLevel,
    briefingState,
    launchBanner,
    touchConfirmLabel,
    touchRaceLabel,
  }
}
