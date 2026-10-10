// src/boot/app/flight/lesson.ts: the lesson's game half, out of `bootApp`.
// APP-SPLIT phase 4, slice 8 (flight; `docs/plan/APP-SPLIT.md` §5).
//
// DEV-377's block, whole: the step machine's four doors (`buildLesson`,
// `disposeLesson`, `tickLesson`, `frameLesson`), the pause row that skips a
// step, and DEV-396's flat-device tracking that sat inside it (the device a
// prompt names). Every line below was moved verbatim from the closure; the
// plumbing is `ctx.x` where the code reads a binding the closure still owns (a
// getter, so a check narrows as the closure's `let` did), and the returned
// object, which hands the closure what it still calls and reads.

import type * as THREE from 'three'
import type { AudioSystem } from '@/audio'
import type { Capabilities } from '@/boot/capability-gate'
import type { ComfortSettings } from '@/boot/settings'
import { stats } from '@/boot/stats-beacon'
import type { GameMode, Level } from '@/content/level-schema'
import type { RacingGuide } from '@/game/course-specs'
import type { EditionState } from '@/game/edition'
import type { Flight } from '@/game/flight'
import { createLessonSession, type LessonSession } from '@/game/lesson-session'
import type { MissionState } from '@/game/mission'
import { rulesFor } from '@/game/modes'
import type { FlightActions } from '@/input/actions'
import { gamepadConfirm } from '@/input/gamepad'
import type { KeyboardSource } from '@/input/keyboard'
import {
  actionsActive,
  type ControlsDevice,
  type ControlsMenu,
  type FlatDevice,
  latestFlatDevice,
  startingFlatDevice,
} from '@/render/controls-menu'
import type { PauseOption } from '@/render/pause'
import type { Renderer } from '@/render/renderer'
import type { RunSummary } from '@/render/results'
import type { UnityFog } from '@/render/unity-fog'
import type { CrashState } from '@/sim/crash'
import { crashHoldsShip } from '@/sim/crash'
import type { HoverJetSheet } from '@/sim/hoverjet'
import type { LaunchState } from '@/sim/launch'
import type { PropColliders } from '@/sim/props/collision'
import type { HeightField } from '@/sim/terrain/height-field'

/** What `createLessonHost` reads from the closure: getters, each read live (APP-SPLIT §3's `ctx`). */
export interface LessonHostCtx {
  readonly RUNNING_MODE: GameMode
  readonly applyAtmosphere: (m: THREE.Material) => void
  readonly audio: AudioSystem
  readonly autopilotTerrain: readonly HeightField[]
  readonly capabilities: Capabilities
  readonly collisionTerrain: readonly HeightField[]
  readonly comfort: ComfortSettings
  readonly controlsMenu: ControlsMenu
  readonly crash: CrashState
  readonly editionState: EditionState
  readonly flight: Flight | null
  readonly fog: UnityFog
  readonly keyboard: KeyboardSource
  readonly lastResult: RunSummary | null
  readonly launch: LaunchState
  readonly level: Level
  readonly livePropColliders: PropColliders | null
  readonly makeGuide: (sheet?: HoverJetSheet | undefined) => RacingGuide | null
  readonly mission: MissionState
  readonly paused: boolean
  readonly render: Renderer
  readonly screen: 'title' | 'menu' | 'mission'
}

export const createLessonHost = (ctx: LessonHostCtx) => {
  // ══ DEV-377: the lesson — the step machine, the instructor, the plate ═══════
  //
  // `docs/plan/FLIGHT-INSTRUCTOR.md` §5 and §9. Everything a lesson does in the
  // running game is in this block and in `game/lesson-session.ts`; the rest of
  // this file calls four functions from the places their moments already are:
  // `buildLesson` from `buildWorld`, `disposeLesson` from `teardownWorld`,
  // `tickLesson` at the top of the fixed step and `frameLesson` beside the
  // briefing — plus `restart` from `restartRun`, the pause menu's *Skip step*
  // row and `__ff2.lesson()`.
  //
  // **Built only where the mode TEACHES and the level carries a lesson.** Both,
  // although since DEV-377 `runningMode` refuses a `?mode=` request that would
  // make them disagree (`requestKeepsTeaching`, DEV-375's open note): a guard
  // that can be satisfied by one half alone is a guard on one half.

  /** The lesson running on this course, or null. Rebuilt with the world. */
  let liveLesson: LessonSession | null = null

  /**
   * The last flat device that produced input (DEV-377) — what the Controls
   * page's keyboard column and a prompt's `{throttle}` both key on. A phone
   * starts as touch and a desktop as the keyboard (DEV-596; it was the pad);
   * the first key, stick or thumb moves it.
   */
  let flatDevice: FlatDevice = startingFlatDevice(ctx.capabilities.touch)

  /**
   * DEV-396. The device whose confirm a prompt names: the headset while one is
   * presenting, else the last flat device used. `trackDevice` keeps the second
   * half current on EVERY screen, because the press that picks a course in the
   * hangar is the one the pad's `Press A to launch` has to answer to.
   */
  const confirmDevice = (): ControlsDevice =>
    ctx.render.renderer.xr.isPresenting ? 'xr' : flatDevice

  /** The last flat device statistics were told about (DEV-590): a change, not a frame. */
  let statsDevice: ControlsDevice | null = null
  /** Once a frame, on every screen, straight after the reads (DEV-396). */
  const trackDevice = (pad: FlightActions, keys: FlightActions, thumbs: FlightActions): void => {
    flatDevice = latestFlatDevice(flatDevice, {
      pad: actionsActive(pad) || gamepadConfirm(),
      keyboard: actionsActive(keys) || ctx.keyboard.confirm,
      touch: actionsActive(thumbs),
    })
    if (flatDevice !== statsDevice) {
      statsDevice = flatDevice
      stats.input(flatDevice === 'pad' ? 'gamepad' : flatDevice)
    }
    ctx.controlsMenu.setKeyboard(!ctx.render.renderer.xr.isPresenting && flatDevice === 'keyboard')
  }

  /** The pause row that moves a stuck lesson on (plan §7). Only while one runs. */
  const SKIP_STEP_OPTION: PauseOption = {
    id: 'skipstep',
    label: 'Skip step',
    note: 'past this one; the lesson goes on',
  }

  const buildLesson = async (
    /** The player's jet: the instructor flies it too (DEV-382 follow-up). */
    sheet: HoverJetSheet | undefined,
  ): Promise<void> => {
    if (!rulesFor(ctx.RUNNING_MODE).teaches || !ctx.level.lesson) return
    // The lesson's own line, built HERE: during a course switch `guide` is
    // rebuilt only after `buildWorld` returns, so reading it now would pace
    // the instructor along the previous course.
    const line = ctx.makeGuide(sheet)
    if (!line) {
      console.warn(
        `lesson: ${ctx.level.id} has no racing line to lead along (?guide=off?) \u2014 no lesson`,
      )
      return
    }
    liveLesson = await createLessonSession({
      level: ctx.level,
      gates: ctx.mission.course.gates,
      line,
      edition: ctx.editionState,
      audio: (event) => ctx.audio.event(event),
      sheet,
    })
    // A thing in the world, like a racer: the world's door (DEV-350) and fog
    // on its trails (DEV-358).
    for (const m of liveLesson.racers.solidMaterials) ctx.applyAtmosphere(m)
    if (liveLesson.racers.wingTrails) ctx.fog.applyTo(liveLesson.racers.wingTrails.trails.material)
    ctx.render.scene.add(liveLesson.racers.group)
    document.body.dataset.lesson = String(ctx.level.lesson.steps.length)
    console.info(
      `lesson: ${ctx.level.lesson.steps.length} steps, instructor ${liveLesson.instructor.spec.id}`,
    )
  }

  const disposeLesson = (): void => {
    liveLesson?.dispose()
    liveLesson = null
    delete document.body.dataset.lesson
  }

  /**
   * One fixed step of the lesson. At the TOP of the step, above the lift's
   * early return, so step 0 — the launch — is read on the lift and the
   * instructor turns to face you while you ride; the mission it reads is the
   * last step's (`game/lesson-session.ts` says why that is exact).
   */
  const tickLesson = (dt: number, stick: FlightActions): void => {
    if (!liveLesson || !ctx.flight) return
    const gameplay = ctx.editionState.current.gameplay
    const held = crashHoldsShip(ctx.crash)
    liveLesson.tick({
      dt,
      launchPhase: ctx.launch.phase,
      body: ctx.flight.jet.body,
      actions: stick,
      passed: ctx.mission.course.passed,
      gate: ctx.mission.event.ring,
      gateClean: ctx.mission.event.gateClean,
      cleanGates: gameplay.gateEvents.enabled,
      finished: ctx.mission.finishCrossed,
      runSeconds: ctx.mission.elapsed,
      crashes: ctx.crash.count,
      crashHeld: held,
      struck: ctx.flight.struck,
      impactSpeed: ctx.flight.impactSpeed,
      // The instructor's world is the racers': the same ground, the same crash
      // rule and forest, and the lanes and contact of the live preset.
      terrain: ctx.autopilotTerrain,
      ground: ctx.collisionTerrain,
      crash: gameplay.crash,
      props: ctx.livePropColliders
        ? { colliders: ctx.livePropColliders, spec: gameplay.propCollision }
        : null,
      rules: {
        separation: gameplay.racers.separation,
        contact: gameplay.racers.contact,
        player: ctx.launch.phase === 'flying' && !held ? ctx.flight.jet.body : null,
      },
    })
  }

  /**
   * Once per frame, beside the briefing: the plate and the instructor's pose.
   * Which device is in the player's hands is `trackDevice`'s, since DEV-396:
   * it ran here, in the mission branch only, so the hangar's Enter never
   * reached it and the pad greeted a keyboard player with `Press A`.
   */
  const frameLesson = (f: {
    readonly alpha: number
    readonly wingDt: number
    readonly frameSeconds: number
    readonly eye: THREE.Vector3
    readonly thirdPerson: boolean
  }): void => {
    if (!liveLesson || !ctx.flight) return
    liveLesson.frame({
      dt: f.frameSeconds,
      wingDt: f.wingDt,
      alpha: f.alpha,
      eye: f.eye,
      settings: ctx.comfort,
      device: confirmDevice(),
      speedUnit: ctx.editionState.current.hud.speedUnit,
      // Down while the menu is up and once the results panel is, as the HUD is.
      visible: ctx.screen === 'mission' && !ctx.paused && ctx.lastResult === null,
      thirdPerson: f.thirdPerson,
      camera: ctx.render.camera,
      briefing: ctx.flight.briefing.object,
    })
  }
  // ══ end DEV-377 ═══════════════════════════════════════════════════════════
  return {
    confirmDevice,
    SKIP_STEP_OPTION,
    buildLesson,
    disposeLesson,
    trackDevice,
    tickLesson,
    frameLesson,
    get liveLesson() {
      return liveLesson
    },
  }
}
