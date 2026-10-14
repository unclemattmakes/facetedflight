// src/boot/app/debug-handle.ts: `__ff2`, the handle `bootApp` returns. APP-SPLIT
// phase 5 (`docs/plan/APP-SPLIT.md` §5).
//
// The `App` object, whole and in its order: every member the e2e specs reach
// (about 1,300 calls), its accessors and its heavy members, built from what
// the closure and its subsystems hold. `bootApp` ends by returning
// `createDebugHandle(ctx)`. The spec-facing names and shapes are unchanged
// (`interface App`, `boot/app/types.ts`). Every line below was moved verbatim
// from the closure; the plumbing is `ctx.x` where the code reads a binding
// the closure still owns (a getter, and a setter where a member writes one:
// the §6 rule 3 bag).

import * as THREE from 'three'
import type { AudioSystem } from '@/audio'
import { CUE_IDS } from '@/audio'
import type { EditorBootPhase, ResultsBoardReport, ShareReport } from '@/boot/app/types'
import type { World } from '@/boot/app/world/switch'
import type { Capabilities } from '@/boot/capability-gate'
import type { TitleVr } from '@/boot/enter-vr'
import type { Feel } from '@/boot/feel'
import type { GpuTimer } from '@/boot/gpu-timer'
import type { LoadProgress } from '@/boot/load-progress'
import type { PerfHud } from '@/boot/perf-hud'
import type { BakedLightRung, EditionThirdPerson } from '@/content/edition-schema'
import type { GameMode, Level } from '@/content/level-schema'
import type { EditionState } from '@/game/edition'
import type { MissionState } from '@/game/mission'
import { rulesFor } from '@/game/modes'
import { flownRoute } from '@/game/props/course-clearing'
import type { RoomProbe } from '@/game/room-client'
import { CODE_KEYS } from '@/game/room-code'
import type { LoadedTerrain } from '@/game/terrain/load-terrain'
import type { Exhibition, ExhibitionOptions, ExhibitionPhase } from '@/game/tv/exhibition'
import type { TvView } from '@/game/tv/tv-view'
import type { KeyboardSource } from '@/input/keyboard'
import type { MouseLook } from '@/input/look'
import type { TouchControls } from '@/input/touch-overlay'
import type { BakedLight, BakedLightReport } from '@/render/baked-light'
import type { Bloom } from '@/render/bloom'
import type { ControlsDevice } from '@/render/controls-menu'
import type { YourCourses } from '@/render/course-shelf'
import {
  captureDrawOrder,
  drawRuns,
  setCockpitFirst,
  setOceanLate,
  setSkyLast,
} from '@/render/draw-order'
import type { Fade } from '@/render/fade'
import {
  type FragmentGate,
  GATE_DEFINES,
  installFragmentGates,
  parseFragmentGates,
  setFragmentGates,
} from '@/render/fragment-gates'
import type { HangarArt } from '@/render/hangar'
import {
  type HudRaster,
  type HudRedraw,
  type HudUpload,
  parseHudRaster,
  parseHudRedraw,
  parseHudUpload,
} from '@/render/hud'
import { hudFontState } from '@/render/hud-font'
import { type HudGauges, parseHudGauges } from '@/render/hud-gauges'
import type { LensMask } from '@/render/lens-mask'
import type { LoadingScene } from '@/render/loading-scene'
import type { PauseOption, PausePage } from '@/render/pause'
import { panelHeight, rowBand, rowCentreLocalY, TOP_LOCAL_Y, WIDTH } from '@/render/pause'
import type { PerfPlate } from '@/render/perf-plate'
import { isPointLightScoped, pointLightScopeOf } from '@/render/point-light-scope'
import type { Renderer } from '@/render/renderer'
import type { StandingStatus } from '@/render/results'
import { codeKeyCentre } from '@/render/room-code-plate'
import type { SceneTint } from '@/render/scene-tint'
import type { SpringArm } from '@/render/spring-arm'
import type { StaticScene } from '@/render/static-scene'
import { ENTER_VR_ROW_ID, TITLE_MENU_BAND_M, TITLE_MENU_HEADING } from '@/render/title-menu'
import { titleVrText } from '@/render/title-vr'
import type { TvPanel } from '@/render/tv-panel'
import type { TvControls } from '@/render/tv-panel-controls'
import type { TvPanelFeed, TvPanelInput } from '@/render/tv-panel-layout'
import type { Vignette } from '@/render/vignette'
import type { BoundaryState } from '@/sim/boundary'
import { type BoundarySpec, boundaryProgress } from '@/sim/boundary'
import type { LaunchSpec, LaunchState } from '@/sim/launch'
import { propPenetrationAt, setPropCleared } from '@/sim/props/collision'
import { terrainHeightAt } from '@/sim/terrain/height-field'
import { HOVERJET_GROUND } from '@/sim/terrain-collision'
import type { FrameRecorder } from '../perf-recorder'
import type { PerfSurface } from '../perf-surface'
import { renderCensus, rowKey } from '../render-census'
import { BUILD_MODE, BUILD_VERSION } from '../version'
import type { createEditorHost } from './editor-host'
import type { createLessonHost } from './flight/lesson'
import type { createLetterPlate } from './hangar/letter-plate'
import type { createMenus } from './hangar/menus'
import type { OptionsPlate } from './hangar/options-plate'
import type { PauseState } from './pause-state'
import { EDITOR_RUN, SNAP_AT_PIN } from './pins'
import type { createResults } from './results'
import type { createRoomCore } from './room/core'
import type { createRoomWatch } from './room/watch'
import type { RunState } from './run-state'
import type { createScreenRouter } from './screen-router'
import type { TitleOptionsPlate } from './title/options-plate'
import type { App, LapsReport } from './types'
import { customGroundReceipt } from './world/build'
import type { createLoadingHost } from './world/loading'
import type { createWorldProps } from './world/props'
import type { WorldHandles } from './world-handles'

// A LOCAL const on purpose: the frame loop narrows it through an aliased
// condition, which TypeScript does for a module's own const and not for an
// imported binding. The read itself is `SNAP_AT_PIN` in `app/pins.ts`.
// (APP-SPLIT 5: `frame.ts` keeps its own copy for that narrowing; this one is the handle's.)
const SNAP_AT = SNAP_AT_PIN

/** What `createDebugHandle` reads from the closure: getters, each read live (APP-SPLIT §3's `ctx`). */
export interface DebugHandleCtx {
  readonly RUNNING_MODE: GameMode
  readonly audio: AudioSystem
  readonly bakedLight: BakedLight
  readonly bloom: Bloom
  readonly boundary: BoundaryState
  readonly boundarySpec: BoundarySpec | null
  readonly canvas: HTMLCanvasElement
  readonly capabilities: Capabilities
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  cardLifted: boolean
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  cockpitFirstOn: boolean
  readonly codePlateState: (device?: ControlsDevice) => {
    heading: string
    typed: string
    selected: number
    live: boolean[]
    footer: string
    footerAccent: boolean
  }
  readonly codeUp: () => boolean
  readonly editionState: EditionState
  readonly editorHost: ReturnType<typeof createEditorHost>
  readonly exhibition: {
    start: (options?: ExhibitionOptions) => Exhibition
    running: () => boolean
    tick: (dt: number) => boolean
    frame(dt: number, alpha?: number): void
    debug: {
      start: (options?: ExhibitionOptions | undefined) => {
        phase: ExhibitionPhase
        course: string | null
        raceSeconds: number
        races: number
        held: string[]
        localCraftVisible: boolean | null
        craft: {
          kind: 'racer' | 'ghost'
          name: string
          place: number
          status: StandingStatus
          seconds: number | null
          at: number[]
        }[]
        results: {
          course: string
          raceSeconds: number
          lapId: string | null
          standings: {
            kind: 'racer' | 'ghost'
            name: string
            status: StandingStatus
            seconds: number | null
          }[]
        }[]
      }
      stop: () => void
      probe: () => {
        phase: ExhibitionPhase
        course: string | null
        raceSeconds: number
        races: number
        held: string[]
        localCraftVisible: boolean | null
        craft: {
          kind: 'racer' | 'ghost'
          name: string
          place: number
          status: StandingStatus
          seconds: number | null
          at: number[]
        }[]
        results: {
          course: string
          raceSeconds: number
          lapId: string | null
          standings: {
            kind: 'racer' | 'ghost'
            name: string
            status: StandingStatus
            seconds: number | null
          }[]
        }[]
      }
    }
  }
  readonly fade: Fade
  readonly feel: Feel
  readonly gpu: GpuTimer
  readonly guardedFrame: (time: number, xrFrame?: XRFrame | undefined) => void
  readonly handles: WorldHandles
  readonly hangar: HangarArt | null
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  hudGauges: HudGauges
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  hudRaster: HudRaster
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  hudRedraw: HudRedraw
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  hudUpload: HudUpload
  readonly keyboard: KeyboardSource
  readonly lastOrbitLook: { yaw: number; pitch: number; fromDevice: boolean } | null
  readonly lastThirdPersonLive: boolean
  readonly launch: LaunchState
  readonly lessonHost: ReturnType<typeof createLessonHost>
  readonly letterPlate: ReturnType<typeof createLetterPlate>
  readonly level: Level
  readonly loading: LoadProgress
  readonly loadingHost: ReturnType<typeof createLoadingHost>
  readonly loadingScene: LoadingScene
  readonly maybeReveal: () => void
  readonly menuScene: THREE.Scene<THREE.Object3DEventMap>
  readonly menus: ReturnType<typeof createMenus>
  readonly mission: MissionState
  readonly mouseLook: MouseLook
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  oceanLateOn: boolean
  readonly onEditorBoot: (listener: (phase: EditorBootPhase) => void) => void
  readonly pause: PauseState
  readonly pausePlate: () => PausePage
  readonly perf: FrameRecorder
  readonly perfHud: PerfHud | null
  readonly perfPlate: PerfPlate | null
  readonly perfSurface: PerfSurface | null
  readonly refreshBakedLight: () => BakedLightReport
  readonly render: Renderer
  readonly staticScene: StaticScene
  readonly results: ReturnType<typeof createResults>
  readonly resultsBoardReport: () => ResultsBoardReport | null
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  revealRequested: boolean
  readonly rideSpec: LaunchSpec | null
  readonly roomCore: ReturnType<typeof createRoomCore>
  readonly roomProbe: () => RoomProbe | null
  readonly roomWatch: ReturnType<typeof createRoomWatch>
  readonly router: ReturnType<typeof createScreenRouter>
  readonly run: RunState
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  running: boolean
  readonly sceneTint: SceneTint
  readonly setChunkBatch: (on: boolean) => unknown
  readonly shareReport: () => ShareReport
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  skyLastOn: boolean
  readonly springArm: SpringArm
  readonly thirdPersonNow: () => EditionThirdPerson
  readonly thirdPersonWanted: boolean
  readonly titleAim: number
  readonly titleMenuUp: () => boolean
  readonly titleRows: () => readonly PauseOption[]
  /** DEV-882: the hangar's OPTIONS plate, for its probe. */
  readonly optionsPlate: OptionsPlate
  /** DEV-882: the title's OPTIONS plate, for the probe's row positions. */
  readonly titleOptions: TitleOptionsPlate
  readonly titleVr: TitleVr
  readonly touch: TouchControls
  readonly tvControls: TvControls
  readonly tvPanel: TvPanel
  readonly tvPanelInput: TvPanelInput
  readonly tvView: TvView
  readonly lensMask: LensMask
  readonly vignette: Vignette
  readonly world: Promise<World> | null
  readonly worldProps: ReturnType<typeof createWorldProps>
  readonly yourCourses: YourCourses
}

export const createDebugHandle = (ctx: DebugHandleCtx): App => {
  const {
    audio,
    bakedLight,
    bloom,
    canvas,
    capabilities,
    codePlateState,
    codeUp,
    editionState,
    editorHost,
    exhibition,
    fade,
    feel,
    gpu,
    guardedFrame,
    handles,
    keyboard,
    lessonHost,
    letterPlate,
    loading,
    loadingHost,
    loadingScene,
    maybeReveal,
    menuScene,
    menus,
    mission,
    mouseLook,
    onEditorBoot,
    pause,
    pausePlate,
    perf,
    perfHud,
    perfPlate,
    perfSurface,
    refreshBakedLight,
    render,
    results,
    resultsBoardReport,
    roomCore,
    roomProbe,
    roomWatch,
    router,
    run,
    sceneTint,
    setChunkBatch,
    lensMask,
    shareReport,
    springArm,
    thirdPersonNow,
    titleMenuUp,
    optionsPlate,
    titleOptions,
    titleRows,
    titleVr,
    touch,
    tvControls,
    tvPanel,
    tvPanelInput,
    tvView,
    vignette,
    worldProps,
    yourCourses,
  } = ctx
  return {
    capabilities,
    render,
    /**
     * An ACCESSOR since DEV-281, and null until a course is chosen.
     *
     * It was a captured value, which was already a half-truth — a course swap
     * reassigns `world` and the object returned here went on holding the boot
     * one for the life of the session. A getter is both the fix for that and
     * the only honest shape for "there is no mission world yet".
     */
    get world() {
      return ctx.world
    },
    mission,
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
      // `resume()`, and that is correct — a browser blocks one created without
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
      // HoverJets — because a HoverJet rides a lift up the shaft before its
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
    /** DEV-471: `?edit=1`'s arrival, for the landing card. */
    onEditorBoot,
    /** The live transition, for the specs. Accessor: `phase` changes every frame. */
    fade: () => ({
      amount: fade.amount,
      phase: fade.phase,
      busy: fade.busy,
      screenFades: router.screenFades,
    }),
    /** The live preset and the speed slider, for the dev handle and the specs. */
    edition: editionState,
    // ── for the dev handle, which `main.ts` hangs off `__ff2` ────────────
    //
    // Accessors rather than values: both are null until the level loads, and a
    // spec that captured them at boot would hold a stale null forever.
    //
    // They earn their place by making a moving target aimable. Four screenshot
    // runs went on GUESSING where the AI racers were at t = 5 s; with these a
    // spec asks the page and points the camera at the answer.
    racers: () => handles.liveRacers,
    /** DEV-483: TV's exhibition — the dev entry until DEV-480's door. */
    exhibition: exhibition.debug,
    /** DEV-482: TV's panels. `feed(f)` stands in for DEV-480's live feed (null: the exhibition's). */
    tvPanel: {
      probe: () => tvPanel.report(),
      /** DEV-628: EXIT, MENU and the hint. */
      controls: () => tvControls.report(),
      feed: (f: TvPanelFeed | null): void => {
        tvPanelInput.live = f
      },
      lobbies: (n: number | null): void => {
        tvPanelInput.lobbies = n
      },
    },
    /** DEV-388. The room, or null. */
    room: () => roomProbe(),
    watch: () =>
      roomCore.watch
        ? {
            status: roomCore.watch.status,
            notice: roomCore.watch.notice,
            keyframes: roomCore.watch.watch.keyframes,
            batches: roomCore.watch.watch.batches,
            delay: roomCore.watch.watch.delay,
            phase: roomCore.watch.watch.session.roomPhase,
            players: Object.keys(roomCore.watch.watch.session.players).length,
            following: roomWatch.watchTargetName,
            ships: roomCore.roomShips?.report() ?? [],
          }
        : null,
    tv: () => tvView.probe(),
    /** DEV-361. What the race map shows, now. */
    raceMap: () => results.raceMap?.report() ?? null,
    laps: (): LapsReport | null => {
      if (!handles.lapRun) return null
      const last = handles.lapRun.last
      const ghost = handles.lapRun.ghost
      const kept = handles.lapRun.stored(editionState.rules.id)
      const at = handles.livePlayerGhost?.object.position
      return {
        run: {
          tick: handles.lapRun.tick,
          clock: handles.lapRun.clock,
          taint: [...handles.lapRun.taint.reasons],
        },
        last: last
          ? {
              seconds: last.seconds,
              gates: last.gates,
              keys: last.doc.keyCount,
              finishTick: last.finishTick,
              rules: last.doc.rules,
              vehicle: last.doc.vehicle,
              tainted: last.tainted,
              reasons: [...last.reasons],
              improved: last.improved,
              stored: last.stored,
              keptMs: last.keptMs,
              kept: handles.lapRun.lastKept,
              savedBefore: last.savedBefore,
            }
          : null,
        ghost: ghost
          ? {
              source: ghost.source,
              handle: ghost.handle,
              seconds: ghost.result.seconds,
              gates: ghost.result.gates,
              keys: ghost.doc.keyCount,
              tainted: ghost.tainted,
              visible: handles.livePlayerGhost?.object.visible === true,
              tag: handles.livePlayerGhost?.tag
                ? {
                    text: String(handles.livePlayerGhost.tag.userData.text ?? ''),
                    visible: handles.livePlayerGhost.tag.visible,
                    opacity: handles.livePlayerGhost.tag.material.opacity,
                  }
                : null,
              at: at ? [at.x, at.y, at.z] : [0, 0, 0],
            }
          : null,
        stored: kept
          ? {
              seconds: kept.seconds,
              gates: kept.gates,
              keys: kept.doc.keyCount,
              tainted: kept.tainted,
            }
          : null,
      }
    },
    /** DEV-373: Share, the link and the cards' ghost lines. */
    share: shareReport,
    /** DEV-431: the course's board on the results panel. */
    resultsBoard: resultsBoardReport,
    hudFont: () => hudFontState(),
    /** DEV-146's other population. Separate from `racers` because it is. */
    traffic: () => handles.liveTraffic,
    /** DEV-447: the boats. */
    life: () => handles.liveLife?.probe() ?? null,
    /** DEV-377: the lesson's step, interrupt, plate text and instructor, or null. */
    lesson: () => lessonHost.liveLesson?.probe() ?? null,
    flight: () => handles.flight,
    /** The player's crash state (DEV-126): phase, count, and where it goes back to. */
    crash: () => run.crash,
    feel: () => feel,
    /**
     * The soundtrack, as an out-of-process test can see it (DEV-247).
     *
     * `seconds` is the only field here that a BROKEN soundtrack cannot
     * produce: it comes off the decoded `AudioBuffer`, so a non-null value
     * means the bytes were fetched, were audio, and this browser decoded
     * them. `track` and `running` were both true of the live site throughout
     * the months it was fetching `index.html` for every song.
     *
     * An accessor for the same reason `racers` and `crash` are: the playlist
     * is a moving target, and a spec that captured it at boot would hold a
     * null from before the first gesture.
     */
    music: () => ({
      tracks: audio.music.tracks.length,
      track: audio.music.playing?.id ?? null,
      seconds: audio.music.playingSeconds,
      running: audio.running,
    }),
    /**
     * DEV-424: the lift's voice — the platform speed it derived, whether the
     * motor is running, whether the arrival has played — and every cue the
     * backend reports SOUNDING, which is the half a broken wiring cannot fake:
     * the state can say "motor" while no voice exists. Every cue, not the
     * lift's alone, because the ambience beds are the same kind of question
     * (a bed that no route starts is silent with every unit test green).
     */
    liftAudio: () => ({
      ...audio.lift,
      sounding: CUE_IDS.filter((id) => audio.backend.isPlaying(id)),
    }),
    /**
     * The two energy tanks (DEV-143, DEV-144), and which one is live.
     *
     * An accessor for the same reason the rest are — both are rebuilt on every
     * restart and a spec that read a value at boot would hold the previous
     * run's. It exists because the question a spec has to ask about either
     * feature is *"did the number MOVE"*, and a gauge drawn on a canvas texture
     * inside a cockpit is the one surface a Playwright assertion cannot read.
     *
     * `mode` is which mechanic the running mode selected, so a spec never has
     * to name a mode to know which tank it is looking at.
     */
    energy: () => ({
      mode: rulesFor(ctx.RUNNING_MODE).energyPowered ? 'race' : 'boost',
      boost: { energy: run.energy.energy, lockout: run.energy.lockout, lit: run.energy.lit },
      race: {
        energy: run.energyRace.energy,
        powered: run.energyRace.powered,
        drained: run.energyRace.drained,
        paid: run.energyRace.paid,
      },
    }),
    heightFields: () => ({
      autopilot: handles.autopilotTerrain,
      collision: handles.collisionTerrain,
    }),
    /**
     * The fracture, for DEV-148: how many pieces are in the air and how many
     * have LANDED. An accessor for the same reason the others are — the group
     * is rebuilt on every course swap.
     *
     * It earns its place the same way `racers` did. *"Do the pieces fall
     * through the hill?"* had no answer from outside the page, and a
     * screenshot cannot settle it: a shard below the ground is hidden by the
     * ground, so the WRONG behaviour and the right one photograph the same.
     */
    fracture: () =>
      handles.liveFracture
        ? { live: handles.liveFracture.live, landed: handles.liveFracture.landed }
        : null,
    // DEV-428 / DEV-429 — accessors, because the fields are rebuilt per world.
    propStrike: () => handles.liveFx?.strike ?? null,
    // DEV-504: a count of a WORLD, not of a frame; rebuilt per world, hence an accessor.
    propColliders: () =>
      handles.livePropColliders
        ? {
            count: handles.livePropColliders.count,
            landmarks: new Set([
              ...handles.livePropColliders.hulls.keys(),
              ...handles.livePropColliders.meshes.keys(),
            ]).size,
          }
        : null,
    spray: () => handles.liveFx?.spray ?? null,
    // DEV-613: rebuilt per world, hence an accessor.
    splash: () => handles.liveFx?.splashes ?? null,
    // DEV-926 / DEV-927: the vapour cone and the boost shockwave, rebuilt per world.
    swings: () => handles.liveFx?.swings ?? null,
    staticScene: () => ctx.staticScene.report(),
    /**
     * WHICH page the plate is turned to, and the rows on it as the player
     * meets them. See the interface for the argument; the short version is
     * that a canvas texture is the one surface a Playwright assertion cannot
     * read, so before this the only instrument for *"is this the CONTROLS
     * page"* was a person looking at a PNG.
     *
     * It reads `pausePlate()` — the SAME call the painter and the A press go
     * through, not a walk of the `.open` flags beside it. A probe that
     * recomputed the answer could report the page the plate is not drawing,
     * which is DEV-221's bound-but-blind probe in another costume.
     *
     * The rows half also gates the PERF CAPTURE row being present under
     * `?perf=1` and ABSENT without it — a debug row on a player's plate is a
     * bug, not an inconvenience.
     */
    pausePlate: () => {
      const plate = pausePlate()
      return {
        page: plate.page,
        title: plate.title,
        rows: plate.rows.map((r) => ({ id: r.id, label: r.label, value: r.value ?? null })),
        /**
         * Whether the plate is actually UP — `paused` (DEV-291).
         *
         * Everything else here is true of the plate whether or not anybody can
         * see it, because `pausePlate()` describes what the plate WOULD draw.
         * That made this probe unable to tell "the tap did nothing" from "the
         * tap chose RESUME and closed the menu", which is a distinction the
         * tap-to-pick spec is entirely about — the first probe run read `page:
         * "pause"` five times over a ship that had been flying since the first
         * tap. A spec that cannot see a feature working cannot see it break.
         */
        open: pause.paused,
        /**
         * The row the press would take — `pauseAim`, the SAME value the
         * painter highlights and the confirm handler indexes.
         *
         * It is the only thing that separates "the ray hit the row I aimed at"
         * from "the ray hit SOME row", and a tap picker whose test cannot tell
         * those apart is a test that a 7-row plate passes by luck one time in
         * seven.
         */
        selected: pause.pauseAim,
        /** DEV-623: how far the credits roll has climbed, sheet-widths; null before it is built. */
        rolled: menus.creditsRoll?.scrolled ?? null,
        /**
         * DEV-796: the panel's top and bottom edges on the glass, CSS pixels,
         * the glass's own height, and where a finger taps (the panel's x and each
         * row's y), or null while the plate is down. A
         * phone's OPTIONS page ended on the bottom edge; a spec reads this.
         */
        edges: (() => {
          const f = handles.flight
          if (!pause.paused || !f) return null
          f.pause.object.updateWorldMatrix(true, false)
          const rect = canvas.getBoundingClientRect()
          const at = (y: number): number => {
            const v = f.pause.object.localToWorld(new THREE.Vector3(0, y, 0))
            v.project(render.camera)
            return rect.top + ((1 - v.y) / 2) * rect.height
          }
          const centre = f.pause.object.localToWorld(new THREE.Vector3(0, 0, 0))
          centre.project(render.camera)
          return {
            top: at(TOP_LOCAL_Y),
            bottom: at(TOP_LOCAL_Y - panelHeight(plate.rows.length)),
            glass: rect.height,
            // Where a finger taps: the panel's middle, and each row's centre.
            x: rect.left + ((centre.x + 1) / 2) * rect.width,
            rowY: plate.rows.map((_, i) => at(rowCentreLocalY(i, plate.rows.length))),
          }
        })(),
      }
    },
    /**
     * The title's two rows (DEV-353): whether they are up, the row a press
     * would take, and where each row's centre is on screen in CSS pixels — so
     * a spec clicks or taps the row it means, found by the plate's own layout
     * (`rowCentreLocalY`), rather than a coordinate somebody measured once.
     */
    /**
     * DEV-882: the hangar's OPTIONS plate: whether it is up, the row the aim is
     * on, and where each row's centre is on the glass in CSS pixels (as
     * `titleMenu().rowsAt` does for the title), so a spec clicks the row it means.
     */
    hangarOptions: () => {
      const object = optionsPlate.object
      let rowsAt: { x: number; y: number }[] | null = null
      if (optionsPlate.up() && object !== null) {
        const rect = canvas.getBoundingClientRect()
        object.updateWorldMatrix(true, false)
        rowsAt = Array.from({ length: optionsPlate.rowCount }, (_, i) => {
          const p = new THREE.Vector3(0, optionsPlate.rowLocalY(i), 0)
          object.localToWorld(p).project(render.camera)
          return {
            x: rect.left + ((p.x + 1) / 2) * rect.width,
            y: rect.top + ((1 - p.y) / 2) * rect.height,
          }
        })
      }
      return { up: optionsPlate.up(), selected: pause.pauseAim, rowsAt }
    },
    /**
     * DEV-902: every element of the title on the glass, as a css-px rectangle, and the
     * size its type is set at, so a spec can hold "nothing overlaps, everything is over
     * the phone floor" (`tests/e2e/phone-title.spec.ts`). The emblem is the box of its
     * projected vertices; the edition line is its ink, not its plane; each row is its
     * band across the plate; the version line and the mascot are their DOM boxes, null
     * while hidden. Null while the title's rows are down.
     */
    titleLayout: () => {
      const plate = handles.titleMenu
      const title = handles.title
      if (!titleMenuUp() || plate === null || title === null) return null
      const rect = canvas.getBoundingClientRect()
      type Box = { l: number; r: number; t: number; b: number }
      const v = new THREE.Vector3()
      const grow = (box: Box, p: THREE.Vector3): void => {
        p.project(render.camera)
        const x = rect.left + ((p.x + 1) / 2) * rect.width
        const y = rect.top + ((1 - p.y) / 2) * rect.height
        box.l = Math.min(box.l, x)
        box.r = Math.max(box.r, x)
        box.t = Math.min(box.t, y)
        box.b = Math.max(box.b, y)
      }
      const empty = (): Box => ({
        l: Number.POSITIVE_INFINITY,
        r: Number.NEGATIVE_INFINITY,
        t: Number.POSITIVE_INFINITY,
        b: Number.NEGATIVE_INFINITY,
      })
      title.object.updateMatrixWorld(true)
      // The emblem: 2016's logo where it loaded, else the stand-in's wordmark.
      let logo: Box | null = null
      title.object.traverseVisible((o) => {
        const mesh = o as THREE.Mesh
        if (!mesh.isMesh) return
        let inLogo = false
        for (let n: THREE.Object3D | null = mesh; n !== null; n = n.parent) {
          if (n.name === 'title-logo' || n.name === 'title-monument') inLogo = true
        }
        if (!inLogo) return
        const pos = mesh.geometry.getAttribute('position')
        if (!pos) return
        const box = logo ?? empty()
        for (let i = 0; i < pos.count; i++) {
          grow(box, v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld))
        }
        logo = box
      })
      // The edition line: its ink, as `paintPrompt` measured it.
      let edition: Box | null = null
      let editionTextPx = 0
      title.object.traverseVisible((o) => {
        const mesh = o as THREE.Mesh
        const line = mesh.userData.titleEdition as
          | { text: string; fontPx: number; maxWidthPx: number }
          | undefined
        if (!mesh.isMesh || line === undefined) return
        // Measured on the line's own canvas, which keeps the font its last paint set.
        const image = (mesh.material as THREE.MeshBasicMaterial).map?.image as
          | HTMLCanvasElement
          | undefined
        const m = image?.getContext('2d')?.measureText(line.text)
        if (!image || !m) return
        const ink = {
          w: Math.min(line.maxWidthPx, m.width) / image.width,
          h: (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) / image.height,
          fontPx: line.fontPx,
        }
        const g = mesh.geometry as THREE.PlaneGeometry
        const { width, height } = g.parameters
        const box = empty()
        for (const [sx, sy] of [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ] as const) {
          grow(
            box,
            v
              .set((sx * ink.w * width) / 2, (sy * ink.h * height) / 2, 0)
              .applyMatrix4(mesh.matrixWorld),
          )
        }
        edition = box
        // The font's size on the glass: the plane is `height` metres over the canvas's pixels.
        editionTextPx = ((box.b - box.t) / Math.max(1e-6, ink.h)) * (ink.fontPx / image.height)
      })
      // The rows: each one's band across the plate, and the plate's own card.
      plate.object.updateWorldMatrix(true, false)
      const count = titleRows().length
      const band = rowBand(count)
      const rows = titleRows().map((r, i) => {
        const c = rowCentreLocalY(i, count, TITLE_MENU_BAND_M)
        const box = empty()
        for (const [x, y] of [
          [-WIDTH / 2, c - band / 2],
          [WIDTH / 2, c - band / 2],
          [WIDTH / 2, c + band / 2],
          [-WIDTH / 2, c + band / 2],
        ] as const) {
          grow(box, plate.object.localToWorld(v.set(x, y, 0)))
        }
        return { id: r.id, ...box }
      })
      const card = empty()
      for (const [x, y] of [
        [-WIDTH / 2, TOP_LOCAL_Y],
        [WIDTH / 2, TOP_LOCAL_Y],
        [WIDTH / 2, TOP_LOCAL_Y - panelHeight(count, TITLE_MENU_BAND_M)],
        [-WIDTH / 2, TOP_LOCAL_Y - panelHeight(count, TITLE_MENU_BAND_M)],
      ] as const) {
        grow(card, plate.object.localToWorld(v.set(x, y, 0)))
      }
      const dom = (id: string, text: boolean): (Box & { fontPx: number }) | null => {
        const el = document.getElementById(id)
        if (!el || getComputedStyle(el).display === 'none') return null
        let r: DOMRect
        if (text) {
          const range = document.createRange()
          range.selectNodeContents(el)
          r = range.getBoundingClientRect()
        } else r = el.getBoundingClientRect()
        if (r.width === 0 && r.height === 0) return null
        return {
          l: r.left,
          r: r.right,
          t: r.top,
          b: r.bottom,
          fontPx: Number.parseFloat(getComputedStyle(el).fontSize),
        }
      }
      return {
        glass: { w: rect.width, h: rect.height },
        logo,
        edition: edition === null ? null : { ...(edition as Box), fontPx: editionTextPx },
        plate: card,
        rows,
        version: dom('title-line', true),
        mascot: dom('uncle-matt-link', false),
        // DEV-842's add-to-home-screen card, where a phone shows it: its chip, or the card once opened.
        guide: dom('home-screen-guide', false),
      }
    },
    titleMenu: () => {
      const up = titleMenuUp()
      const plate = handles.titleMenu
      let rowsAt: { x: number; y: number }[] | null = null
      /** DEV-895: the plate's bottom edge on the glass, css px, read off its own card mesh. */
      let plateBottom: number | null = null
      // DEV-882: while OPTIONS is up its rows are on their own plate.
      const optionsPlate = menus.options.up ? titleOptions : null
      const drawnOn = optionsPlate?.object ?? plate?.object ?? null
      if (up && plate !== null && drawnOn !== null) {
        const rect = canvas.getBoundingClientRect()
        drawnOn.updateWorldMatrix(true, false)
        const count = titleRows().length
        rowsAt = titleRows().map((_, i) => {
          const y =
            optionsPlate !== null
              ? optionsPlate.rowLocalY(i)
              : rowCentreLocalY(i, count, TITLE_MENU_BAND_M)
          const p = new THREE.Vector3(0, y, 0)
          drawnOn.localToWorld(p).project(render.camera)
          return {
            x: rect.left + ((p.x + 1) / 2) * rect.width,
            y: rect.top + ((1 - p.y) / 2) * rect.height,
          }
        })
        let lowest = Number.POSITIVE_INFINITY
        drawnOn.traverse((o) => {
          const mesh = o as THREE.Mesh
          if (!mesh.isMesh) return
          mesh.geometry.computeBoundingBox()
          const box = mesh.geometry.boundingBox
          if (box) lowest = Math.min(lowest, box.min.y)
        })
        if (Number.isFinite(lowest)) {
          const e = new THREE.Vector3(0, lowest, 0)
          drawnOn.localToWorld(e).project(render.camera)
          plateBottom = rect.top + ((1 - e.y) / 2) * rect.height
        }
      }
      const drawn = titleRows()
      // DEV-558: one page. The doors are the hangar's first step.
      const pages: Record<string, string[]> = { top: drawn.map((r) => r.id) }
      let code: ReturnType<App['titleMenu']>['code'] = null
      if (codeUp() && letterPlate.codePlate !== null) {
        const rect = canvas.getBoundingClientRect()
        const plate = letterPlate.codePlate
        plate.object.updateWorldMatrix(true, false)
        const state = codePlateState()
        code = {
          typed: letterPlate.codeTyped,
          selected: letterPlate.codeAim,
          keys: CODE_KEYS.map((k) => k.id),
          keysAt: CODE_KEYS.map((_, i) => {
            const c = codeKeyCentre(i)
            const p = new THREE.Vector3(c.x, c.y, 0)
            plate.object.localToWorld(p).project(render.camera)
            return {
              x: rect.left + ((p.x + 1) / 2) * rect.width,
              y: rect.top + ((1 - p.y) / 2) * rect.height,
            }
          }),
          footer: state.footer,
          joining: letterPlate.codeJoining,
        }
      }
      const vrAt = drawn.findIndex((r) => r.id === ENTER_VR_ROW_ID)
      return {
        up,
        selected: ctx.titleAim,
        rows: drawn.map((r) => r.id),
        rowsAt,
        plateBottom,
        notes: drawn.map((r) => r.note),
        accents: drawn.map((r) => r.accentNote === true),
        page: 'top',
        heading: TITLE_MENU_HEADING,
        pages,
        code,
        // DEV-557's ENTER VR, a row since DEV-558.
        vr: {
          shown: vrAt >= 0,
          state: titleVr.state,
          ...titleVrText(titleVr.state),
          aimed: up && vrAt >= 0 && ctx.titleAim === vrAt,
          at: vrAt >= 0 ? (rowsAt?.[vrAt] ?? null) : null,
        },
      }
    },
    /** The course being flown: its id, its aircraft and the mode it RUNS in. */
    course: () => ({ id: ctx.level.id, vehicle: ctx.level.vehicle, mode: ctx.RUNNING_MODE }),
    /**
     * What the chase arm was handed last frame — DEV-292.
     *
     * Null until the third-person camera has drawn a frame, so it doubles as
     * *"is the chase camera live"*.
     *
     * It exists because the arm's yaw CANNOT be recovered from outside by
     * looking at where the lens ended up, and that was measured rather than
     * assumed: sweeping a synthetic phone through 0-120° and reading the
     * lens's bearing in the ship's own frame gives a consistent slope of
     * **~0.75**, not 1. The missing quarter is not a bug and not noise — the
     * position lag and the rotation lag both sit between the phone and the
     * lens, so the lens is orbiting a pivot that is itself metres behind a
     * rotation that is itself degrees behind the aircraft.
     *
     * Asserting that empirical 0.75 would be pinning the tuning of two lag
     * constants inside a test about an input. So the claim is split: this
     * answers *"the phone's angles reach the camera"* exactly, and
     * `spring-arm.test.ts` answers *"the arm turns a yaw into an orbit"*
     * exactly, on a stationary ship where there is no lag to fight.
     */
    orbitLook: () => ctx.lastOrbitLook,
    terrain: () => handles.liveTerrain,
    customGround: () => customGroundReceipt,
    lineClearing: (sweepMetres = 5) => {
      const props = handles.livePropsLive
      if (!props) return null
      const mask = handles.liveLineMask
      const cols = handles.livePropColliders
      const m = new THREE.Matrix4()
      let maskedDrawn = 0
      let maskedSolid = 0
      let inLine = 0
      // The ship's reach off its own origin: its widest hull sphere's far edge.
      const hull = HOVERJET_GROUND.collision.hull
      const reach = Math.max(0, ...hull.map((h) => Math.hypot(h.x, h.y, h.z) + h.radius))
      // The world level's FLOWN line (pad, run-in, curve to the finish), SIM
      // space, when it is a player course's; empty on any other world.
      const route = (flownRoute(ctx.level) ?? []).map((p) => ({ x: p[0], y: p[1], z: -p[2] }))
      const nearRoute = (x: number, z: number): { d: number; y: number } => {
        let best = { d: Number.POSITIVE_INFINITY, y: 0 }
        for (let i = 0; i + 1 < route.length; i++) {
          const a = route[i] as { x: number; y: number; z: number }
          const b = route[i + 1] as { x: number; y: number; z: number }
          const ex = b.x - a.x
          const ez = b.z - a.z
          const len2 = ex * ex + ez * ez
          const u =
            len2 > 0 ? Math.min(1, Math.max(0, ((x - a.x) * ex + (z - a.z) * ez) / len2)) : 0
          const d = Math.hypot(x - (a.x + u * ex), z - (a.z + u * ez))
          if (d < best.d) best = { d, y: a.y + u * (b.y - a.y) }
        }
        return best
      }
      const masked = mask?.masked
      for (let id = 0; masked && id < props.scatterCount; id++) {
        if (!masked[id]) continue
        const drawn = props.drawn(id)
        if (drawn) {
          m.copy(drawn.matrix)
          if (m.elements.some((v, k) => k !== 15 && v !== 0)) maskedDrawn++
        }
        if (cols) {
          if (cols.broken[id] === 0) maskedSolid++
          const near = nearRoute(cols.x[id] as number, cols.z[id] as number)
          if (
            near.d < (cols.radius[id] as number) + reach &&
            near.y + reach >= (cols.bottom[id] as number) &&
            near.y - reach <= (cols.top[id] as number)
          ) {
            inLine++
          }
        }
      }
      let sweep: { samples: number; touching: number } | null = null
      if (cols && route.length > 1 && sweepMetres > 0) {
        let samples = 0
        let touching = 0
        const q = { x: 0, y: 0, z: 0, w: 1 }
        for (let i = 0; i + 1 < route.length; i++) {
          const a = route[i] as { x: number; y: number; z: number }
          const b = route[i + 1] as { x: number; y: number; z: number }
          const n = Math.max(
            1,
            Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / sweepMetres),
          )
          for (let k = 0; k < n; k++) {
            const f = k / n
            const p = {
              x: a.x + (b.x - a.x) * f,
              y: a.y + (b.y - a.y) * f,
              z: a.z + (b.z - a.z) * f,
            }
            samples++
            if (propPenetrationAt(p, q, hull, cols) > 0) touching++
          }
        }
        sweep = { samples, touching }
      }
      let low: {
        samples: number
        touching: number
        touchingUncleared: number
        inLine: number
      } | null = null
      const field = handles.liveTerrain?.terrain.heightField
      if (cols && field && route.length > 1 && sweepMetres > 0) {
        const hover = HOVERJET_GROUND.hover.hoverHeight
        const q = { x: 0, y: 0, z: 0, w: 1 }
        const plan: { x: number; y: number; z: number }[] = []
        for (let i = 0; i + 1 < route.length; i++) {
          const a = route[i] as { x: number; z: number }
          const b = route[i + 1] as { x: number; z: number }
          const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / sweepMetres))
          for (let k = 0; k < n; k++) {
            const x = a.x + ((b.x - a.x) * k) / n
            const z = a.z + ((b.z - a.z) * k) / n
            plan.push({ x, y: terrainHeightAt(field, x, z) + hover, z })
          }
        }
        const sweepAt = (): number =>
          plan.reduce((n, p) => n + (propPenetrationAt(p, q, hull, cols) > 0 ? 1 : 0), 0)
        const touchingLow = sweepAt()
        // The masked colliders back in for one synchronous sweep, then out
        // again: nothing renders or steps between the two writes.
        const out: number[] = []
        for (let id = 0; masked && id < props.scatterCount; id++) {
          if (masked[id] && cols.broken[id] === 1) out.push(id)
        }
        for (const id of out) setPropCleared(cols, id, false)
        const touchingUncleared = sweepAt()
        let inLow = 0
        for (const id of out) {
          const near = nearRoute(cols.x[id] as number, cols.z[id] as number)
          const g = terrainHeightAt(field, cols.x[id] as number, cols.z[id] as number) + hover
          if (
            near.d < (cols.radius[id] as number) + reach &&
            g + reach >= (cols.bottom[id] as number) &&
            g - reach <= (cols.top[id] as number)
          ) {
            inLow++
          }
        }
        for (const id of out) setPropCleared(cols, id, true)
        low = { samples: plan.length, touching: touchingLow, touchingUncleared, inLine: inLow }
      }
      return {
        receipt: worldProps.lineClearingReceipt,
        scatter: props.scatterCount,
        masked: mask?.count() ?? 0,
        maskedDrawn,
        maskedSolid,
        colliders: cols !== null,
        inLine,
        sweep,
        low,
        forest: cols
          ? Array.from({ length: props.scatterCount }, (_, id): [number, number] => [
              cols.x[id] as number,
              -(cols.z[id] as number),
            ])
          : [],
      }
    },
    /**
     * The land's chunk batching, on or off, on a LIVE page (DEV-193, DEV-904).
     * Batching is the shipped default, so `chunkBatch(false)` is the OFF arm of
     * the A/B and `chunkBatch(true)` rebuilds the bands from the chunks as they
     * are. One load, two readings, no cross-run pin (perf-protocol section 3d);
     * `tests/e2e/chunk-batch.spec.ts` is the protocol. Returns the plan: bands,
     * slots used and reserved, bytes.
     */
    chunkBatch(on = true) {
      return setChunkBatch(on)
    },
    /** DEV-930: read, size (NDC radius) or, with `0` or `null`, turn off the lens mask. */
    lensMask(radius?: number | null) {
      return radius === undefined ? lensMask.report() : lensMask.set(radius)
    },
    /**
     * DEV-238. What the GPU is actually handed, in order.
     *
     * Every row carries `render-census.ts`'s own `rowKey`, so a sequence reads
     * directly against `perf-out/census-all/` and against the group names
     * `VRTO3D_HIDE` / `VRTO3D_SOLO` take. The runs are the answer; the rows are
     * kept because an interleaving is a fact about individual calls and a
     * summary that grouped by name would hide the one thing this exists to
     * show.
     *
     * `samples` is the raw first frame, capped — enough to see the head of the
     * sequence and the sky/terrain/ocean seams without shipping several hundred
     * rows through a `page.evaluate`.
     */
    async drawOrder(frames = 1) {
      const frameList = await captureDrawOrder(
        render.renderer,
        (object) => rowKey(object, render.scene),
        Math.max(1, Math.min(8, Math.floor(frames))),
        // A frame is a render OF THIS SCENE, BY A CAMERA THAT CAN SEE IT.
        //
        // Both halves were found the hard way, one headed run each. Without the
        // scene test the bloom composer's `FullScreenQuad` passes count as
        // frames — they call `renderer.render` on a scene of their own after
        // the world's render has returned, so they are outermost and a depth
        // counter cannot see them; the run reported `1 submissions this frame`
        // and one row reading `Mesh / 1 triangle`. Without the camera test the
        // UI pass counts too — `render/bloom.ts` renders this same stage a
        // second time with `camera.layers.set(UI_LAYER)` after a `clearDepth`,
        // and that frame came back as the HUD alone.
        //
        // Layer 0 is the default layer, which everything in the world is on and
        // which a UI-only pass has masked off. Asking the camera is a question
        // with an answer; "take the biggest frame" would be right most of the
        // time and would pick the HUD on a frame where the world was culled.
        (scene, camera) =>
          scene === (render.scene as unknown as THREE.Object3D) && camera.layers.isEnabled(0),
      )
      return frameList.map((frame) => ({
        calls: frame.rows.length,
        runs: drawRuns(frame.rows),
        samples: frame.rows.slice(0, 40),
      }))
    },
    /**
     * DEV-238's ordering switches. **On by default since DEV-241**, exact
     * restore, no verdict.
     *
     * The ocean's group and the sky's dome are found the same way everything
     * else in this object finds the live world — off `liveTerrain` and
     * `liveSky` — so a call before the level lands reports `seen: 0` rather
     * than throwing, and an arm that reads `seen: 0` has not fired.
     *
     * `moved` counts what THIS CALL changed and is 0 for a `true` on a freshly
     * loaded level, because the constructors already did it. That is not an arm
     * that failed: read `on` and `seen` for what is TRUE, which is the same
     * separation `__ff2.fragmentGates` grew a `carrying` field for (DEV-238 §5).
     */
    drawOrderSwitch(which: 'ocean' | 'sky' | 'cockpit', on?: boolean) {
      if (which === 'sky') {
        // `on` omitted reads without moving: re-assert whatever is in force,
        // which is also how a sweep re-applies an arm after a level change.
        if (on !== undefined) ctx.skyLastOn = on
        return { which, ...setSkyLast(handles.liveSky?.dome ?? null, ctx.skyLastOn) }
      }
      if (which === 'cockpit') {
        // DEV-246. `flight` is the live vehicle and is null before the level
        // lands, which reports `seen: 0` rather than throwing — the same
        // contract the other two keep.
        if (on !== undefined) ctx.cockpitFirstOn = on
        return { which, ...setCockpitFirst(handles.flight?.object ?? null, ctx.cockpitFirstOn) }
      }
      if (on !== undefined) ctx.oceanLateOn = on
      return { which, ...setOceanLate(handles.liveTerrain?.ocean?.group ?? null, ctx.oceanLateOn) }
    },
    // DEV-339: the logic is `game/terrain/load-terrain.ts`'s `rings` control.
    async oceanRings(on?: boolean, normals?: 'derived' | 'face') {
      const ocean = handles.liveTerrain?.ocean
      const rings = ocean?.rings
      if (!ocean || !rings) return null
      const moved = on === undefined ? null : await rings.set(on)
      if (normals !== undefined) rings.setNormals(normals)
      return {
        wanted: rings.wanted,
        on: rings.on,
        normals: rings.normals,
        reason: moved?.reason ?? rings.reason,
        triangles: ocean.triangleCount,
        submitted: rings.submitted,
        cellMetres: rings.cellMetres,
        bytes: rings.bytes,
      }
    },
    /**
     * DEV-243. The HUD's redraw cadence, read or set, plus its counts.
     *
     * `next` omitted reads without moving, the way `drawOrderSwitch` does — and
     * for the same reason, which is that a read has to be free so a sweep can
     * take one before and after an arm without changing what it is measuring.
     *
     * The intent is stored here rather than on the panel because the panel does
     * not survive a course swap; the frame loop re-asserts it. An unparseable
     * argument warns and leaves the cadence alone rather than throwing, so a
     * typo in a `page.evaluate` costs a console line and not a 60-second run.
     */
    hud(next?: string | number) {
      if (next !== undefined) {
        const parsed = parseHudRedraw(String(next))
        if (parsed === null) {
          console.warn(`hud: ignoring ${String(next)} — expected 'freeze', 'live' or a rate in Hz`)
        } else {
          ctx.hudRedraw = parsed
          // Applied NOW as well as by the frame loop: a caller that reads the
          // report on the next line must not be told the old cadence. The loop
          // would land it within a frame and "within a frame" is not something
          // a `page.evaluate` can wait for.
          handles.flight?.hud.setRedraw(ctx.hudRedraw)
        }
      }
      if (!handles.flight) return null
      return {
        ...handles.flight.hud.report(),
        // DEV-243's CONTROL, in the same call, because the row it supports is
        // the COMPARISON and a comparison assembled from two probe calls taken
        // at two moments is a comparison of two windows. Null without
        // `?perf=1` — there is no plate in a player's session, which is also
        // the reading: its cost is the instrument's, not the game's.
        plate: perfPlate?.report() ?? null,
      }
    },
    /**
     * DEV-244. The HUD's UPLOAD mode, read or set, plus the same counts.
     *
     * `next` omitted reads without moving, exactly as `hud()` and
     * `drawOrderSwitch` do — a read has to be free so a sweep can take one
     * before and after an arm without changing what it is measuring.
     *
     * The intent lives beside the cadence's and for the same reason (the panel
     * does not survive a course swap and the intent does), and it is applied
     * NOW as well as by the frame loop so that a caller reading the report on
     * the next line is not told the old mode.
     */
    hudUpload(next?: string) {
      if (next !== undefined) {
        const parsed = parseHudUpload(next)
        if (parsed === null) {
          console.warn(`hud: ignoring ${next} — expected 'mip' or 'nomip'`)
        } else {
          ctx.hudUpload = parsed
          handles.flight?.hud.setUpload(ctx.hudUpload)
        }
      }
      if (!handles.flight) return null
      return { ...handles.flight.hud.report(), plate: perfPlate?.report() ?? null }
    },
    /**
     * DEV-256. The HUD's RASTER backend, read or set, plus the same counts.
     *
     * `next` omitted reads without moving, exactly as `hud()` and `hudUpload()`
     * do — a read has to be free so a sweep can take one before and after an
     * arm without changing what it is measuring, and here "free" is worth more
     * than usual because a SET rebuilds the canvas.
     *
     * The intent lives beside the other two's and for one extra reason: a
     * course swap CONSTRUCTS the next panel from it (`loadFlight`), since the
     * mode cannot be applied to a canvas after the fact. Applied NOW as well as
     * by the frame loop so a caller reading the report on the next line is not
     * told the old mode.
     */
    hudRaster(next?: string) {
      if (next !== undefined) {
        const parsed = parseHudRaster(next)
        if (parsed === null) {
          console.warn(`hud: ignoring ${next} — expected 'gpu' or 'cpu'`)
        } else {
          ctx.hudRaster = parsed
          handles.flight?.hud.setRaster(ctx.hudRaster)
        }
      }
      if (!handles.flight) return null
      return { ...handles.flight.hud.report(), plate: perfPlate?.report() ?? null }
    },
    /**
     * DEV-257. Read or move which continuous readings are geometry.
     *
     * `next` omitted reads without moving, exactly as `hud()` and
     * `hudUpload()` do — a read has to be free so a sweep can take one before
     * and after an arm without changing what it is measuring.
     *
     * **The report this returns is the whole argument for the row.** `rateHz`,
     * `unchanged`, `skipped` and `canvasOps` with the arm down and then up are
     * COUNTS, not durations, so they survive a box under contention — which is
     * the difference between evidence this session may take and evidence it
     * may not (`docs/testing/perf-protocol.md` §3a).
     */
    hudGauges(next?: string) {
      if (next !== undefined) {
        const parsed = parseHudGauges(next)
        if (parsed === null) {
          console.warn(
            `hud: ignoring ${next} — expected 'off', 'bar', 'needle', 'bar-only' or 'needle-only'`,
          )
        } else {
          ctx.hudGauges = parsed
          handles.flight?.hud.setGauges(ctx.hudGauges)
        }
      }
      if (!handles.flight) return null
      return { ...handles.flight.hud.report(), plate: perfPlate?.report() ?? null }
    },
    /**
     * Throw `render/fragment-gates.ts`'s cuts on the LIVE terrain materials,
     * and say how many moved.
     *
     * The instrument the whole terrain question turns on. `?terrainLit=` can
     * only be taken as two LOADS, and `docs/testing/perf-protocol.md` §3a-ter
     * says this laptop cannot compare two loads of a fill-dominated cost — the
     * GPU throttles inside the reading window, and a bracketed A-B-A of one
     * such pair came back 4.82 / 4.27 / 7.05 ms for two identical arms. A
     * define flips on a live page, so `perf-scale.spec.ts` can read arm A, arm
     * B and arm A again without reloading, which is the protocol that returns
     * R2 0.999.
     *
     * `which` is `land`, `ocean` or `both`: the island and the sea are separate
     * census rows with separate numbers, and a gate thrown on both at once
     * prices two systems as one.
     *
     * Unknown gate names warn and are dropped rather than throwing, so a typo
     * in an env var costs a row rather than a run.
     */
    /**
     * DEV-232, as an instrument: what the bake is doing right now, and a way to
     * throw it without going through the preset.
     *
     * The preset path (`terrain.bakedLight.enabled`, which `VRTO3D_FLAGS_ON`
     * drives) is the one an A/B should use, because it is the one a player can
     * reach. This exists for the other half of the protocol — reading arm A,
     * arm B and arm A again on ONE page load, which is the only comparison this
     * machine can make of a fill-dominated cost (perf-protocol §3a-ter). It
     * goes through exactly the same two calls the preset does.
     *
     * `on` omitted reports without moving anything.
     */
    bakedLight(on?: boolean, rung?: BakedLightRung) {
      if (on === undefined && rung === undefined) return bakedLight.report()
      // The SAME calls the preset route makes, in the same order, so the two
      // routes cannot drift — which is what `tests/e2e/baked-light-probe.spec.ts`
      // exists to check.
      //
      // DEV-237: the rung is OPTIONAL and omitting it leaves the rung where it
      // was, so `bakedLight(true)` still means what it has always meant and an
      // A-B-A of the flag does not silently change rungs under itself. To move
      // both, say both: `bakedLight(true, 1)`.
      if (rung !== undefined) bakedLight.setRung(rung)
      if (on !== undefined) bakedLight.setEnabled(on)
      return refreshBakedLight()
    },
    fragmentGates(gates: readonly string[], which: 'land' | 'ocean' | 'both' = 'land') {
      const wanted: FragmentGate[] = parseFragmentGates(gates.join(','), (m) => console.warn(m))
      const terrains: LoadedTerrain[] = []
      if (handles.liveTerrain && which !== 'ocean') terrains.push(handles.liveTerrain.terrain)
      if (handles.liveTerrain?.ocean && which !== 'land') terrains.push(handles.liveTerrain.ocean)
      let moved = 0
      const seen = new Set<THREE.Material>()
      const define = (m: THREE.Material): void => {
        if (seen.has(m)) return
        seen.add(m)
        if (setFragmentGates(m, wanted)) moved++
      }
      for (const t of terrains) {
        // ── the patch on the BASE, the define on everything DRAWN ─────────
        //
        // Two different sets, and conflating them makes the ocean unmeasurable
        // while looking like it worked. `LoadedTerrain.materials` is the
        // material a terrain's chunks are cut FROM, and it is the right place
        // for an `onBeforeCompile` (DEV-183: patch a clone as well and the
        // chain runs twice). But the sea does not DRAW with it — `water.ts`'s
        // `materialFor` hands each LOD band a clone, and a clone's
        // `onBeforeCompile` delegates back to the base while its `defines` are
        // its own. So the clone inherits the gated shader TEXT for free and
        // would never get the define.
        //
        // Hence: install on the base, define on the base AND on every material
        // hanging off a mesh in the group. A `#define` is idempotent state, not
        // a chain, so setting it twice is free and setting it on a clone is
        // exactly right.
        for (const m of t.materials) installFragmentGates(m)
        for (const m of t.materials) define(m)
        t.group.traverse((object) => {
          const mesh = object as THREE.Mesh
          if (!mesh.material) return
          for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) define(m)
        })
      }
      // ── WANTED and ON, separated — DEV-238, on DEV-232's bill ───────────
      //
      // `moved` is not a mechanism check and never was: it counts materials
      // this CALL changed, so re-asserting an arm reports 0 and a half-applied
      // arm reports something. What an arm needs is *how many of the materials
      // the sea actually draws with carry every define asked for*, which is a
      // property of the world rather than of the call.
      //
      // DEV-232's first A/B filed 0.025 ms against a 0.05 ms bracket for an arm
      // that never fired, and the row it produced says why: a report that does
      // not separate what was asked for from what is true cannot tell "off,
      // correctly" from "on, and it reached nothing". `carrying < materials`
      // is exactly that gap, named.
      const defines = wanted.map((g) => GATE_DEFINES[g])
      const carrying = [...seen].filter((m) => {
        const d = (m.defines ?? {}) as Record<string, unknown>
        return defines.every((name) => Object.hasOwn(d, name))
      }).length
      return { moved, defines, materials: seen.size, carrying, which }
    },
    /**
     * Every material the mission scene would DRAW this frame, and whether
     * DEV-192's point-light cut reached it.
     *
     * Raw rows, and deliberately no verdict. The guard is
     * `tests/e2e/point-light-scope.spec.ts`, and it holds its own copy of the
     * rule — which subtree is exempt and why, which material types have no
     * lighting to cut. If this accessor also decided what *acceptable* meant,
     * the spec would be asserting a conclusion the implementation reached, and
     * a drift between the two would agree with itself. Assert the
     * relationship, not the value (CLAUDE.md trap 24).
     *
     * EVERY material, not only the ones on screen, with `drawn` saying which is
     * which. Hidden is not the same as safe: the launch room and its lamp are
     * hidden in flight and visible for the whole ride up the shaft, and the
     * title valley is in this scene until teardown — so a gate that only looked
     * at what is lit right now would pass while the one subtree that compiles
     * live, mid-ride, still carried the loop (DEV-117's whole subject).
     *
     * `drawn` is three's OWN liveness rule — `projectObject` opens
     * `if ( object.visible === false ) return;`, so a mesh under an invisible
     * ancestor contributes nothing. Frustum culling is not applied: a chunk
     * off-screen on the tick the spec looks is still a material the world
     * draws, and including it makes the sweep strictly wider.
     */
    pointLightScope() {
      const rows: {
        path: string
        material: string
        name: string
        drawn: boolean
        scoped: boolean
        scope: string | null
      }[] = []
      const seen = new Set<THREE.Material>()
      const walk = (object: THREE.Object3D, path: string, visible: boolean): void => {
        const here = visible && object.visible
        const label = `${path}/${object.name || `(${object.type})`}`
        const mesh = object as THREE.Mesh
        if (mesh.material) {
          for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
            if (!m || seen.has(m)) continue
            seen.add(m)
            rows.push({
              path: label,
              material: m.type,
              name: m.name,
              drawn: here,
              scoped: isPointLightScoped(m),
              scope: pointLightScopeOf(m) ?? null,
            })
          }
        }
        for (const child of object.children) walk(child, label, here)
      }
      walk(render.scene, '', true)
      return rows
    },
    /**
     * The lift: which phase it is in, how far up it is, and whether this world
     * build still has its ride.
     *
     * An accessor for the same reason the two above are — all four of these
     * change on a mission swap, and a spec that read a value at boot would hold
     * the previous world's. It exists because *"does the lift actually ride"*
     * had no answer from outside the page, and the answer was no on every path
     * for the life of the switch (DEV-094): the body's Y alone cannot tell a
     * ride that was skipped from a ride that has not started, because both put
     * the ship somewhere a still frame cannot argue with.
     */
    launch: () => ({
      phase: ctx.launch.phase,
      rise: ctx.launch.rise,
      /** False once a launch has spent it. Null on the six with no rig. */
      ridePending: ctx.rideSpec === null ? null : !ctx.rideSpec.skipRide,
    }),
    /**
     * The level select's live aim, for a spec that needs to know WHY a press
     * did nothing.
     *
     * Accessor, like the two above, and null until the room exists. It exists
     * because two e2e specs went red on the day the picker landed and the
     * question "is the resting gaze on a table" had no answer from outside the
     * page — which made a one-line premise change look like a regression.
     */
    stage: () => (router.screen === 'menu' ? menuScene : render.scene),
    /**
     * DEV-894: how big every UI plate on the glass is set, css px (`tests/e2e/phone-plates.spec.ts`).
     * Needs `globalThis.__ff2TextLog = new Map()` set before the page boots (`ui-font.ts`
     * `logText`). Per visible canvas mesh: its name, the glass px one canvas px covers,
     * and each font size it set (canvas px, characters, css px). Only meshes in front of the
     * camera and over the glass.
     */
    uiText: () => {
      const log = (globalThis as { __ff2TextLog?: Map<unknown, Map<number, number>> }).__ff2TextLog
      if (!log) return []
      const rect = canvas.getBoundingClientRect()
      const out: {
        name: string
        cssPerPx: number
        onGlass: boolean
        /** The text's own box on the glass, css px (centred on the plane; null where not measured). */
        box: { l: number; r: number; t: number; b: number } | null
        sizes: { px: number; chars: number; css: number }[]
      }[] = []
      const a = new THREE.Vector3()
      const b = new THREE.Vector3()
      const seen = new Set<THREE.Object3D>()
      const visit = (root: THREE.Object3D): void => {
        root.traverseVisible((o) => {
          const mesh = o as THREE.Mesh
          if (!mesh.isMesh || seen.has(mesh)) return
          seen.add(mesh)
          const map = (mesh.material as THREE.MeshBasicMaterial | undefined)?.map
          const image = map?.image as HTMLCanvasElement | undefined
          const sizes = image ? log.get(image) : undefined
          if (!image || !sizes) return
          mesh.geometry.computeBoundingBox()
          const box = mesh.geometry.boundingBox
          if (!box) return
          mesh.updateWorldMatrix(true, false)
          const y = (box.min.y + box.max.y) / 2
          a.set(box.min.x, y, 0).applyMatrix4(mesh.matrixWorld)
          b.set(box.max.x, y, 0).applyMatrix4(mesh.matrixWorld)
          const mid = a.clone().add(b).multiplyScalar(0.5)
          a.project(render.camera)
          b.project(render.camera)
          mid.project(render.camera)
          const px = Math.hypot(((b.x - a.x) / 2) * rect.width, ((b.y - a.y) / 2) * rect.height)
          const cssPerPx = px / Math.max(1, image.width)
          const onGlass = mid.z > -1 && mid.z < 1 && Math.abs(mid.x) <= 1 && Math.abs(mid.y) <= 1
          const widths = (globalThis as { __ff2TextWidth?: Map<unknown, number> }).__ff2TextWidth
          const textW = widths?.get(image)
          const cx = rect.left + ((mid.x + 1) / 2) * rect.width
          const cy = rect.top + ((1 - mid.y) / 2) * rect.height
          const top = [...sizes.keys()].reduce((m, k) => Math.max(m, k), 0) * cssPerPx
          out.push({
            name: mesh.name || mesh.parent?.name || '',
            cssPerPx,
            onGlass,
            box:
              textW === undefined
                ? null
                : {
                    l: cx - (textW * cssPerPx) / 2,
                    r: cx + (textW * cssPerPx) / 2,
                    t: cy - top * 0.6,
                    b: cy + top * 0.6,
                  },
            sizes: [...sizes.entries()]
              .sort((p, q) => p[0] - q[0])
              .map(([size, chars]) => ({ px: size, chars, css: size * cssPerPx })),
          })
        })
      }
      visit(router.screen === 'menu' ? menuScene : render.scene)
      return out
    },
    loading: () => ({
      place: loadingScene.place,
      target: loadingScene.shown ? loadingHost.plateCourse : null,
      focus: ctx.hangar?.focused ?? null,
    }),
    // DEV-469.
    editor: () => ({
      editing: editorHost.editing,
      flying: EDITOR_RUN.request?.courseId ?? null,
      desk: editorHost.desk?.probe() ?? null,
      sunBake: editorHost.editorSunBake, // DEV-476
    }),
    editorDebug: () => editorHost.desk?.debug ?? null,
    // DEV-492.
    bench: () => ({
      up: editorHost.benchUp,
      door: { up: editorHost.benchDoor?.object.visible ?? false, aimed: editorHost.benchDoorAimed },
      flying: editorHost.benchFlight,
      probe: editorHost.bench?.probe() ?? null,
    }),
    // DEV-558
    courseShelf: () => yourCourses.probe(),
    hangarAim: () =>
      ctx.hangar
        ? {
            aim: ctx.hangar.aim,
            page: ctx.hangar.page,
            view: ctx.hangar.view,
            // DEV-558: the room lays its doors at boot, under the title, so a
            // view alone does not say the room is the screen a press reaches.
            screen: router.screen,
            // DEV-382: the steps this room walks, and the open aircraft's
            // variants with their records.
            views: [...ctx.hangar.views],
            variants: ctx.hangar.variants.map((t) => ({
              id: t.variant.id,
              name: t.variant.name,
              flown: t.flown,
              courses: t.courses,
              lastFlown: t.lastFlown,
            })),
            variant: ctx.hangar.variant?.id ?? null,
            vehicles: ctx.hangar.vehicles.map((v) => ({
              vehicle: v.vehicle,
              name: v.name,
              flown: v.flown,
              courses: v.missions.length,
            })),
            modes: ctx.hangar.modes.map((m) => ({
              mode: m.mode,
              name: m.name,
              flown: m.flown,
              courses: m.missions.length,
            })),
            ranks: ctx.hangar.ranks.map((r) => ({
              difficulty: r.difficulty,
              name: r.name,
              flown: r.flown,
              courses: r.missions.length,
            })),
            // DEV-558
            doors: ctx.hangar.doors.map((d) => ({
              id: d.id,
              name: d.name,
              detail: d.detail,
              note: d.note,
            })),
          }
        : null,
    perf,
    census: () => renderCensus(render.renderer, render.scene, render.camera),
    gpu,
    /**
     * Whether the snap has fired. An accessor for the same reason the two above
     * are: `frozen` changes mid-run, and a spec that read a value at boot would
     * hold `false` forever.
     */
    snap: () => ({ at: SNAP_AT, frozen: run.snapped }),
    /**
     * The out-of-bounds clock and what it is drawing (DEV-127). An accessor
     * like the rest: `boundary` is replaced on a mission swap, and the static's
     * level changes every frame. `fuzz` is the vignette's live edge alpha, so
     * a spec asserting "the warning is on screen" reads the thing that is
     * drawn rather than the thing that was asked for.
     */
    boundary: () => ({
      phase: ctx.boundary.phase,
      outsideFor: ctx.boundary.outsideFor,
      progress: ctx.boundarySpec ? boundaryProgress(ctx.boundary, ctx.boundarySpec) : 0,
      fuzz: vignette.fuzzLevel,
    }),
    /**
     * CHANGE VIEW, from outside the page (DEV-128): what the player asked for,
     * whether this frame honoured it, how long the arm is after the probe, and
     * whether the spring (Anniversary) or 2016's own chase (Classic) is live.
     * An accessor like the rest: all four change per frame.
     *
     * `armLength` is the SPRING's, and it is 0 on Classic — that camera has no
     * arm to shorten, only a damp. Measure the Classic chase the way the spec
     * does, from the camera to the ship: a distance is true on both presets and
     * an arm length is not (DEV-156).
     */
    thirdPerson: () => ({
      wanted: ctx.thirdPersonWanted,
      live: ctx.lastThirdPersonLive,
      spring: thirdPersonNow().enabled,
      armLength: springArm.armLength,
    }),
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
    stop() {
      ctx.running = false
      render.renderer.setAnimationLoop(null)
      keyboard.dispose()
      mouseLook.dispose()
      touch.dispose()
      handles.startGrid?.dispose()
      handles.liveRacers?.dispose()
      handles.liveTraffic?.dispose()
      handles.liveClouds?.dispose()
      handles.liveHorizonGeo?.dispose()
      handles.liveSky?.dispose()
      handles.liveLookdev?.dispose()
      handles.liveDressing?.dispose()
      handles.liveLife?.dispose()
      perfHud?.dispose()
      perfPlate?.dispose()
      bloom.dispose()
    },
    // DEV-446: the tint's report and its authoring door, for lookdev's twin.
    sceneTint,
  }
}
