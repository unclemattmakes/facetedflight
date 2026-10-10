// src/boot/app/frame.ts: the per-frame loop, out of `bootApp`. APP-SPLIT phase
// 4, slice 9 (`docs/plan/APP-SPLIT.md` §1c, §5).
//
// `frame(time, xrFrame)`, whole and in the §1c order: the preamble and the XR
// probe, the screen swap (`router.frame`, step 1), the editor's frame, the
// input poll, the confirm dispatch, the room and TV, the fixed step, the
// render interpolation, the camera, the cockpit block, the Anniversary
// effects, the render and the perf step (`perfSys.frame`, step 33). The
// order is load-bearing and unchanged; it is pinned by the ordering guards
// that read this file. Every line below was moved verbatim from the closure;
// the plumbing is `ctx.x` where the code reads a binding the closure still
// owns (a getter, so a check narrows as the closure's `let` did, and a setter
// where the frame writes one: the §6 rule 3 bag, owner in phase 3).

import * as THREE from 'three'
import type { AudioSystem } from '@/audio'
import type { World } from '@/boot/app/world/switch'
import type { Capabilities } from '@/boot/capability-gate'
import type { TitleVr } from '@/boot/enter-vr'
import type { Feel } from '@/boot/feel'
import { type BoostFeel, type CrashFeel, type FlybyFeel, nearMissAt } from '@/boot/feel-events'
import type { GpuTimer } from '@/boot/gpu-timer'
import type { ShakeLookdev } from '@/boot/lookdev-shake'
import type { RoomShare } from '@/boot/room-share'
import { saveSettings } from '@/boot/settings'
import { stats } from '@/boot/stats-beacon'
import { xrRunHeld } from '@/boot/xr-visibility'
import { STANDARD_VARIANT_ID } from '@/content/aircraft-schema'
import type {
  EditionHudPlacement,
  EditionThirdPerson,
  SceneTintValue,
} from '@/content/edition-schema'
import type { GameMode, Level } from '@/content/level-schema'
import { uiLabel, uiString } from '@/content/ui-strings'
import type { Air } from '@/game/air'
import { settleAward } from '@/game/award-line'
import { bestRule } from '@/game/best-medal'
import { cockpitJoltGain, JOLTS } from '@/game/cockpit-jolt'
import type { RacingGuide } from '@/game/course-specs'
import type { EditionState } from '@/game/edition'
import { FINISH_FEEL, medalTierOf } from '@/game/finish-feel'
import { EYE, hoverJetOf } from '@/game/flight'
import type { ChainWatch, GateLadder } from '@/game/gate-feel'
import { GATE_FEEL, ladderChainExpired, ladderGate } from '@/game/gate-feel'
import { gliderAutopilotOf } from '@/game/glider-flight'
import {
  contactProbesOf,
  jumpSeatAutopilotOf,
  STRANDED_BANNER_SECONDS,
  seatEffectsOf,
} from '@/game/jumpseat-flight'
import { readHandle } from '@/game/lap-identity'
import { type BodyPose, ghostName } from '@/game/lap-run'
import { capStudentActions, pitchDegrees } from '@/game/lesson'
import { lifeWanted } from '@/game/life/load-life'
import {
  hudTimeLimit,
  type MissionState,
  medalBanner,
  medalFor,
  medalInput,
  missionScore,
  padBanner,
  placeMission,
  startMission,
  stepMission,
  streakMultiplier,
} from '@/game/mission'
import type { MissionCard } from '@/game/mission-index'
import { countLabel, MODES, rulesFor, runningMode } from '@/game/modes'
import { arrowTargetForPitch, nextTargetSim } from '@/game/next-target'
import type { OvertakeWatch } from '@/game/overtake'
import { flybyWhooshGain, OVERTAKE, overtakeLabel } from '@/game/overtake'
import { recordRun, safeStorage } from '@/game/personal-best'
import type { RaceLine } from '@/game/race-place'
import { type LivePlace, placeNow, type RacerPlaceReading, raceProgress } from '@/game/race-place'
import type { HitJolt } from '@/game/racer-hit'
import { hitJoltGain, takeRacerHit } from '@/game/racer-hit'
import {
  racerStanding,
  raceTimeLimit,
  runExtras,
  summariseRun,
  withStandings,
} from '@/game/results-state'
import { createRingTakeWatch, type RingTakeWatch } from '@/game/ring-takes'
import { isRoomCode } from '@/game/room-client'
import {
  CODE_ACTION,
  CODE_KEYS,
  codeArrowStep,
  codeKeyForKeyboard,
  codeKeyIndex,
  codeKeyStep,
  codeStickStep,
} from '@/game/room-code'
import { roomCodeText } from '@/game/room-lobby'
import type { SplitTracker } from '@/game/split-times'
import { splitLine, splitTone } from '@/game/split-times'
import type { RisingEdge } from '@/game/tank-feel'
import { easeLevel, isDryPress, TANK_FEEL } from '@/game/tank-feel'
import { LOD_FADE_SUFFIX } from '@/game/terrain/load-terrain'
import type { Exhibition, ExhibitionOptions, ExhibitionPhase } from '@/game/tv/exhibition'
import type { TvView } from '@/game/tv/tv-view'
import { rememberVariant } from '@/game/variant-choice'
import { FADE, HOVERJET } from '@/generated/constants.generated'
import type { FlightActions } from '@/input/actions'
import {
  BACK_KEYS_ALL,
  BACK_KEYS_BACKSPACE,
  type BackSources,
  backPressed,
  mergeActions,
  noActions,
} from '@/input/actions'
import type { ConfirmState } from '@/input/confirm'
import { confirmArmed } from '@/input/confirm'
import type { DeviceLook } from '@/input/device-orientation'
import { quatPitch, quatYaw } from '@/input/device-orientation'
import type { Edge } from '@/input/edge'
import { nextPaused } from '@/input/escape-pause'
import type { FocusEdge } from '@/input/focus-edge'
import {
  gamepadBack,
  gamepadCameraToggle,
  gamepadConfirm,
  gamepadPause,
  gamepadRaceLap,
  gamepadShareLap,
  readGamepad,
  setPadsHeld,
} from '@/input/gamepad'
import { stepHoldToggle } from '@/input/hold-toggle'
import type { HomeScreenGuide } from '@/input/home-screen-guide'
import type { KeyboardSource } from '@/input/keyboard'
import type { FreeLook, MouseLook } from '@/input/look'
import { addLook, type LookOptions, NO_LOOK, readKeyboardLook, readStickLook } from '@/input/look'
import type { RowStepper } from '@/input/menu-step'
import { clampAim, menuStepFrom } from '@/input/menu-step'
import type { PointerArbiter, PointerHand } from '@/input/pointer-hand'
import type { TitleHomeHint } from '@/input/title-home-hint'
import type { TouchControls } from '@/input/touch-overlay'
import { AGAIN_LABEL } from '@/input/touch-overlay'
import type { TurnScreen } from '@/input/turn-phone'
import { readXrInput } from '@/input/xr'
import type { XrSelectLatch } from '@/input/xr-select'
import { NEWSLETTER_URL } from '@/net/newsletter'
import type { RoomRace } from '@/net/room-protocol'
import type { Bloom } from '@/render/bloom'
import type { BoundaryFuzz } from '@/render/boundary-fuzz'
import type { BriefingState } from '@/render/briefing'
import { type CameraShakeOffset, type ShakeWear, TRAUMA } from '@/render/camera-shake'
import type { ClassicChase } from '@/render/classic-chase'
import { whiteoutStep } from '@/render/cloud-look'
import type { CloudShadow } from '@/render/cloud-shadow'
import type { CockpitSelfShadow } from '@/render/cockpit-self-shadow'
import { type ControlsDevice, type ControlsMenu, TOUCH_PAD_HINT } from '@/render/controls-menu'
import { CREDITS_OPTION } from '@/render/credits-menu'
import type { CreditsRoll } from '@/render/credits-roll'
import { shaftSunGain, worldRevealed } from '@/render/elevator'
import {
  CAMERA_SWITCH_BLACK_SECONDS,
  CUT_FADE_SECONDS,
  type Fade,
  type FadePhase,
  KILL_FADE_SECONDS,
  LOAD_FADE_SECONDS,
} from '@/render/fade'
import type { FlatFov } from '@/render/flat-fov'
import { type GatePulse, pulseColorLinear } from '@/render/gate-pulse'
import { type HangarArt, seatPitchLocal, stepStartYaw } from '@/render/hangar'
import type { RoomShadows } from '@/render/hangar-light'
import { headForward, readHeadPose, readHeadPosition } from '@/render/head-pose'
import type { Horizon } from '@/render/horizon'
import type { HudRaster, HudRedraw, HudUpload } from '@/render/hud'
import type { HudGauges } from '@/render/hud-gauges'
import type { LoadingPlace, LoadingScene } from '@/render/loading-scene'
import { medalColour } from '@/render/medal'
import type { NearShadow } from '@/render/near-shadow'
import type { PauseOption, PausePage } from '@/render/pause'
import { PANEL_LIFT, ROOT_PAGE, TITLE_M } from '@/render/pause'
import type { PerfPlate } from '@/render/perf-plate'
import { PLATE_SIDE } from '@/render/perf-plate'
import { pausePhoneFit, phoneUi } from '@/render/phone-floor'
import type { Renderer } from '@/render/renderer'
import type { OpponentStanding, RunSummary, StandingStatus } from '@/render/results'
import { createCodePlate, placeCodePlateInRoom } from '@/render/room-code-plate'
import type { SceneTint } from '@/render/scene-tint'
import type { SeaReflection } from '@/render/sea-reflection'
import type { SunShadows } from '@/render/shadows'
import { shadowsEnabled } from '@/render/shadows'
import { marmosetSunIntensity } from '@/render/skyshop-ibl'
import { fovAddFor, type SpringArm, type SurfaceHeightAt } from '@/render/spring-arm'
import { ARRIVAL_DROP } from '@/render/start-deck'
import {
  ENTER_VR_ROW_ID,
  MAKING_OF_PATH,
  MAKING_OF_ROW_ID,
  NEWSLETTER_ROW_ID,
  OPTIONS_ROW_ID,
  QUICK_RACE_ROW_ID,
  TITLE_MENU_HEADING,
  WATCH_LAP_ROW_ID,
} from '@/render/title-menu'
import type { UnityFog } from '@/render/unity-fog'
import type { Vignette, VignetteInput } from '@/render/vignette'
import type { SunHalo } from '@/render/vr-halo'
import type { XrPointer } from '@/render/xr-pointer'
import { planeHitDistance } from '@/render/xr-pointer'
import { recenterXr } from '@/render/xr-recenter'
import { autopilotActions, DEFAULT_AUTOPILOT, nextGate, playerRouteOptions } from '@/sim/autopilot'
import type { BoundaryState } from '@/sim/boundary'
import {
  type BoundarySpec,
  boundaryCountdown,
  boundaryProgress,
  createBoundary,
} from '@/sim/boundary'
import { FIXED_DT } from '@/sim/constants'
import { type CrashCourse, crashHoldsShip, stepCrashAndBoundary } from '@/sim/crash'
import {
  boostAvailable,
  energyFraction,
  energySpec,
  fillEnergy,
  refillEnergy,
  stepEnergy,
} from '@/sim/energy'
import { energyRaceFraction, energyRaceSpec, payGate, stepEnergyRace } from '@/sim/energy-race'
import type { HoverJetSheet } from '@/sim/hoverjet'
import type { FixedStepClock } from '@/sim/integrator'
import { stepFixed } from '@/sim/integrator'
import type { HeadPhase } from '@/sim/jumpseat-head'
import type { StrandedPhase } from '@/sim/jumpseat-stranded'
import type { LaunchState } from '@/sim/launch'
import { type LaunchSpec, launchHoldsShip, stepLaunch, topRise } from '@/sim/launch'
import type { PropHit } from '@/sim/props/collision'
import { stepPropCollision } from '@/sim/props/collision'
import type { RouteCursor } from '@/sim/route'
import { type Route, routeGuidance, speedLimitAt } from '@/sim/route'
import { chainGate } from '@/sim/speed-chain'
import { HOVERJET_GROUND } from '@/sim/terrain-collision'
import { IDLE_XR_PROBE, refreshXrProbe, type XrProbe } from '../perf-surface'
import { shouldFreeze } from '../snap'
import type { AutopilotState } from './autopilot-state'
import { chaseCamera } from './chase-camera'
import type { createEditorHost } from './editor-host'
import type { createLessonHost } from './flight/lesson'
import type { createLetterPlate } from './hangar/letter-plate'
import type { createMenuReticleHost } from './hangar/menu-reticle'
import type { createMenus } from './hangar/menus'
import type { OptionsPlate } from './hangar/options-plate'
import { _headQuat, cameraWorld, gazeDirection } from './head-scratch'
import { syncSmoothSky } from './lighting'
import type { PauseState } from './pause-state'
import type { createPerf } from './perf'
import {
  boardedVariant,
  CHASE_TARGET,
  EDITOR_RECORD,
  EDITOR_RUN,
  editorPartialRun,
  NO_CRASH,
  ORBIT,
  RIDE_HIDE,
  TITLE_IBL,
  TITLE_SUN,
  VARIANT_PARAM,
  VIEWPOINT,
  variantPinned,
} from './pins'
import type { createResults } from './results'
import type { createRoomCore } from './room/core'
import type { createRoomLobby } from './room/lobby'
import type { createRoomWatch } from './room/watch'
import type { RunState } from './run-state'
import type { createScreenRouter } from './screen-router'
import type { createAppSettings } from './settings'
import type { createTitleMenu } from './title/menu'
import type { createPlayerCourses } from './title/player-courses'
import type { WorldHandles } from './world-handles'
import type { createXrLifecycle } from './xr-lifecycle'

// A LOCAL const on purpose: the frame loop narrows it through an aliased
// condition, which TypeScript does for a module's own const and not for an
// imported binding. The read itself is `SNAP_AT_PIN` in `app/pins.ts`.
const SNAP_AT = SNAP_AT_PIN

import type { Flight } from '@/game/flight'
import { rotateVec3 } from '@/sim/math/quat'
import { v3 } from '@/sim/math/vec3'
import { SNAP_AT_PIN } from './pins'

/**
 * `ForwardSpeed`, the quantity the ship's effects are keyed to.
 *
 * 2016 reads the body's velocity in its OWN frame and takes the forward
 * component, not `velocity.magnitude` — so drifting sideways at 300 m/s does not
 * light the boost, and neither does falling. Getting this wrong makes the
 * effects fire during the launch, when the ship is going straight up.
 */
const FORWARD_AXIS = Object.freeze(v3(0, 0, 1))
const _fwd = v3()
const forwardSpeedOf = (f: Flight): number => {
  const b = f.jet.body
  // The ship's local +Z in world space, dotted with velocity.
  rotateVec3(_fwd, b.orientation, FORWARD_AXIS)
  return _fwd.x * b.velocity.x + _fwd.y * b.velocity.y + _fwd.z * b.velocity.z
}

/**
 * Volatile. The head's world facing and up, for the audio listener.
 *
 * A quaternion applied to the two basis vectors rather than
 * `getWorldDirection`, because the listener needs BOTH — an up vector is what
 * tells a `PannerNode` which way roll has taken the ears, and in a headset
 * under a barrel roll that is the difference between the sea being below you
 * and the sea being on your left.
 */
const _listenerQuat = new THREE.Quaternion()
const _listenerForward = new THREE.Vector3()
const _listenerUp = new THREE.Vector3()
/**
 * And its own eye point, rather than borrowing `cameraWorld`: by the time the
 * listener is built, four other calls have been handed that vector, and a
 * volatile read after somebody else has held it is trap 19.
 */
const _listenerEye = new THREE.Vector3()

/** Volatile. One racer's world position, inside the racer-engine sync. */
const _racerWorld = new THREE.Vector3()
/** DEV-868: one watch per world (keyed by its particle field), so a rebuilt course starts fresh. */
const ringTakeWatches = new WeakMap<object, RingTakeWatch>()

/** Volatile. The seated look, composed onto the chair's facing every frame. */
const _seatLook = new THREE.Quaternion()
const _seatAim = new THREE.Quaternion()
/**
 * The tap-to-row ray (DEV-291). Module scratch, like everything else down here.
 *
 * Valid inside one synchronous call and nowhere else — trap 19, and the reason
 * this is safe where `ai-racer.ts`'s shared `HoverJetInput` was not: there is
 * exactly one pause plate, the ray is built and spent in the same three
 * statements, and nothing keeps a reference to either object afterwards.
 */
const _tapNdc = new THREE.Vector2()
const _tapRay = new THREE.Raycaster()
const _seatEuler = new THREE.Euler()

/**
 * A camera nobody renders with, for `flight.render()` when the real one is
 * somewhere else — behind the ship (DEV-128) or on a spectator orbit. The call
 * is what places the ship's art; the eye it also writes lands here and is never
 * read. Module-level and never re-posed on purpose: its pose is garbage by
 * design, and nothing may read it.
 */
const _discardCamera = new THREE.PerspectiveCamera()
// Volatile scratch for the third-person camera. Valid only inside one frame.
const _thirdPos = new THREE.Vector3()
const _thirdQuat = new THREE.Quaternion()

/** Scratch for DEV-641's flyby: the head's right-hand vector, world. Never read across calls (trap 19). */
const _flybyRight = new THREE.Vector3()

/** What `createFrame` reads from the closure: getters, each read live (APP-SPLIT §3's `ctx`). */
export interface FrameCtx {
  readonly CREDITS_BODY_M: number
  readonly MODE_REQUEST: () => GameMode | undefined
  readonly NO_STICKS_GRACE_SECONDS: number
  readonly RUNNING_MODE: GameMode
  readonly SEAT_PITCH_LIMIT: number
  readonly _aimDirection: THREE.Vector3
  readonly _aimOrigin: THREE.Vector3
  readonly _cameraWorld: THREE.Vector3
  readonly _haloEye: THREE.Vector3
  readonly _lifeEye: THREE.Vector3
  readonly _nearAt: [number, number, number]
  readonly _nearEye: THREE.Vector3
  readonly _nearRight: THREE.Vector3
  readonly _sunColour: THREE.Color
  readonly _titleLookQuat: THREE.Quaternion
  readonly _towardSun: THREE.Vector3
  readonly accentFlashColor: THREE.Color
  readonly accentPulse: GatePulse
  readonly aimMenus: () => PointerHand | null
  readonly aimPlate: (
    o: THREE.Object3D<THREE.Object3DEventMap>,
    pick: (a: THREE.Vector3, b: THREE.Vector3) => number,
  ) => number
  readonly air: Air
  readonly appSettings: ReturnType<typeof createAppSettings>
  readonly arrowTarget: THREE.Vector3
  readonly askConfirm: () => boolean
  readonly askFrame: (visible: boolean) => void
  readonly askNudge: (step: number) => void
  readonly askPointer: (
    tap: { x: number; y: number } | null,
    hover: { x: number; y: number } | null,
  ) => boolean
  readonly audio: AudioSystem
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  audioBoundaryLeft: number | null
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  audioFinishCrossed: boolean
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  audioHovered: boolean
  readonly audioLaunch: () => void
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  audioPauseAim: number
  readonly audioShaft: () => void
  readonly autoAim: { x: number; y: number; z: number }
  readonly autoBeyond: { x: number; y: number; z: number }
  readonly autoCursor: RouteCursor
  readonly autoInput: FlightActions
  readonly autopilotKey: Edge
  readonly beginLaunch: () => void
  readonly benchDoorAim: (hand: PointerHand | null, eye: THREE.Vector3) => void
  readonly benchFrame: (frameSeconds: number, eye: THREE.Vector3) => boolean
  readonly benchPress: () => boolean
  readonly bloom: Bloom
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  boostBurning: boolean
  readonly boostFeel: BoostFeel
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  boostGlow: number
  readonly boostPress: RisingEdge
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  boundary: BoundaryState
  readonly boundaryFuzz: BoundaryFuzz
  readonly boundarySpec: BoundarySpec | null
  readonly breakProps: (
    hits: readonly PropHit[],
    velocity: { readonly x: number; readonly y: number; readonly z: number },
    who: string,
  ) => void
  readonly briefingLevel: () => number
  readonly briefingState: () => BriefingState
  readonly cameraKey: Edge
  readonly canvas: HTMLCanvasElement
  readonly capabilities: Capabilities
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  cardLifted: boolean
  readonly chainWatch: ChainWatch
  readonly classicChase: ClassicChase
  readonly clock: FixedStepClock
  readonly closePausePages: () => void
  readonly cloudShadow: CloudShadow
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  cloudWhite: number
  readonly cockpitSelfShadow: CockpitSelfShadow
  readonly codeClosePlate: () => void
  readonly codeFocus: FocusEdge
  readonly codeJoinFrame: () => void
  readonly codeKeysDown: string[]
  readonly codeNudgeEdge: Edge
  readonly codePlateState: (device?: ControlsDevice) => {
    heading: string
    typed: string
    selected: number
    live: boolean[]
    footer: string
    footerAccent: boolean
  }
  readonly codePress: (index: number) => void
  readonly codeUp: () => boolean
  readonly confirmDevice: () => ControlsDevice
  readonly confirmKey: Edge
  readonly confirmNow: () => ConfirmState
  readonly controlsMenu: ControlsMenu
  readonly coursePanelPresses: (wantShare: boolean, wantRace: boolean) => boolean
  readonly courseTintFor: (id: string) => SceneTintValue | null
  readonly crashCourseNow: () => CrashCourse
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  crashDucked: boolean
  readonly crashFeel: CrashFeel
  readonly creditsRollFor: () => CreditsRoll
  readonly cycleGhost: (card: MissionCard) => void
  readonly deviceLook: DeviceLook
  readonly editionState: EditionState
  readonly editorFrame: (time: number, frameSeconds: number) => boolean
  readonly editorHost: ReturnType<typeof createEditorHost>
  readonly editorRecordBadge: () => void
  readonly editorRecordInput: () => void
  readonly editorRecordPlaced: () => void
  readonly editorRecordReturn: () => void
  readonly editorRecordStep: (body: BodyPose) => void
  readonly editorReturn: () => void
  readonly enterVrKey: Edge
  readonly escapeKey: Edge
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
  readonly exhibitionTick: (dt: number) => boolean
  readonly fade: Fade
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  fadePhaseShown: FadePhase | null
  readonly feel: Feel
  readonly fireAccentFlash: (r: number, g: number, b: number, scale: number) => void
  readonly flatFov: FlatFov
  readonly flybyFeel: FlybyFeel
  readonly fog: UnityFog
  readonly frameLesson: (f: {
    readonly alpha: number
    readonly wingDt: number
    readonly frameSeconds: number
    readonly eye: THREE.Vector3
    readonly thirdPerson: boolean
  }) => void
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  frameOrdinal: number
  readonly freeLook: FreeLook
  readonly gateLadder: GateLadder
  readonly gatePulse: GatePulse
  readonly gatePulseColor: THREE.Color
  readonly gatesJudged: () => boolean
  readonly glassConfirms: () => boolean
  readonly glassRay: (x: number, y: number) => THREE.Ray | null
  readonly goToScreen: (
    to: 'title' | 'menu' | 'mission',
    opts?: {
      readonly outSeconds?: number
      readonly inSeconds?: number
      readonly holdSeconds?: number
      readonly act?: () => void
    },
  ) => void
  readonly goToTheHangar: (log: string) => void
  readonly gpu: GpuTimer
  readonly guide: RacingGuide | null
  readonly handles: WorldHandles
  readonly hangar: HangarArt | null
  readonly hangarBackKey: Edge
  readonly hitJolt: HitJolt
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  holotableHovered: boolean
  readonly horizon: Horizon
  readonly hudGauges: HudGauges
  readonly hudPlacementNow: () => EditionHudPlacement
  readonly hudRaster: HudRaster
  readonly hudRedraw: HudRedraw
  readonly hudUpload: HudUpload
  readonly keyboard: KeyboardSource
  readonly landRevealRise: number
  readonly lapAskUp: () => boolean
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  lastOrbitLook: { yaw: number; pitch: number; fromDevice: boolean } | null
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  lastThirdPersonLive: boolean
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  lastTime: number
  readonly launch: LaunchState
  readonly launchBanner: () => string | null
  readonly launchSpec: LaunchSpec | null
  readonly lensIsLive: () => boolean
  readonly lessonHost: ReturnType<typeof createLessonHost>
  readonly letterPlate: ReturnType<typeof createLetterPlate>
  readonly level: Level
  readonly loadingScene: LoadingScene
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  loadingScenePending: boolean
  readonly lobbyFocus: FocusEdge
  readonly lobbyFrame: (pointing: PointerHand | null) => void
  readonly lobbyPress: () => void
  readonly lobbySteps: RowStepper
  readonly lobbyUp: () => boolean
  readonly menuReticleFrame: () => void
  readonly menuReticleHost: ReturnType<typeof createMenuReticleHost>
  readonly menuScene: THREE.Scene<THREE.Object3DEventMap>
  readonly menus: ReturnType<typeof createMenus>
  readonly mission: MissionState
  readonly missionEdition: () => 'classic' | 'anniversary'
  readonly mouseLook: MouseLook
  readonly nearShadow: NearShadow
  readonly openRoomsFrame: () => void
  readonly opponentStandings: () => OpponentStanding[]
  readonly optionsPlate: OptionsPlate
  readonly overtakeWatch: OvertakeWatch
  readonly pause: PauseState
  readonly pauseBackKey: Edge
  readonly pauseKey: Edge
  readonly pausePageBack: () => boolean
  readonly pausePlate: () => PausePage
  readonly pauseRowAt: (x: number, y: number) => number
  readonly pauseSteps: RowStepper
  readonly perfPlate: PerfPlate | null
  readonly perfSys: ReturnType<typeof createPerf>
  readonly pilot: AutopilotState
  readonly playerCourseHost: ReturnType<typeof createPlayerCourses>
  readonly playerGhostNear: THREE.Vector3
  readonly playerGhostStandings: () => OpponentStanding[]
  readonly pointerArbiter: PointerArbiter
  readonly pointerWanted: () => boolean
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  presentingSince: number
  readonly profileGuideFor: (
    guideNow: { readonly route: Route; profiledFor: HoverJetSheet | null },
    sheet: HoverJetSheet | undefined,
  ) => void
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  quickRace: { readonly id: string; readonly pressedAt: number; launched: boolean } | null
  readonly quickRaceAsked: boolean
  readonly raceLapKey: Edge
  readonly raceLapOffered: () => boolean
  readonly recenterKey: Edge
  readonly render: Renderer
  readonly resetThirdPerson: () => void
  readonly restartRun: (opts?: { respawn?: boolean; raceLap?: boolean }) => void
  readonly results: ReturnType<typeof createResults>
  readonly rideSpec: LaunchSpec | null
  readonly roomActive: () => boolean
  readonly roomClose: () => void
  readonly roomCore: ReturnType<typeof createRoomCore>
  readonly roomFrame: (time: number) => void
  readonly roomInviteLink: () => string
  readonly roomLobby: ReturnType<typeof createRoomLobby>
  readonly roomMapDots: (player: { x: number; z: number }) => readonly { x: number; z: number }[]
  readonly roomMapField: () => {
    readonly race: RoomRace
    readonly line: RaceLine
    readonly finish: { x: number; y: number; z: number } | null
    readonly colours: string[]
    readonly slots: number[]
  } | null
  readonly roomOthersNow: () => readonly { x: number; y: number; z: number }[]
  readonly roomPanelOpponents: () => OpponentStanding[]
  readonly roomPanelRun: (run: RunSummary) => RunSummary
  readonly roomPlace: () => void
  readonly roomPlaceOthers: (line: RaceLine) => RacerPlaceReading[]
  readonly roomPointAim: (x: number, y: number) => boolean
  readonly roomRaceLive: () => boolean
  readonly roomRender: (eye: THREE.Vector3, dt: number, wingDt: number) => void
  readonly roomShadows: RoomShadows | null
  readonly roomShare: RoomShare
  readonly roomStep: (
    body: {
      position: { x: number; y: number; z: number }
      orientation: { x: number; y: number; z: number; w: number }
      velocity: { x: number; y: number; z: number }
    },
    stick: { pitch: number; roll: number; yaw: number; throttle: number; boost: boolean },
    held: boolean,
    finished: boolean,
    passed: readonly boolean[],
  ) => void
  readonly roomStepCountdown: (dt: number) => void
  readonly roomTakesPoints: () => boolean
  readonly roomWatch: ReturnType<typeof createRoomWatch>
  readonly router: ReturnType<typeof createScreenRouter>
  readonly run: RunState
  readonly running: boolean
  readonly sceneTint: SceneTint
  readonly seaReflection: SeaReflection
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  seatLookPitch: number
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  seatLookYaw: number
  readonly seatQuaternion: THREE.Quaternion
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  seatRestKey: string | null
  readonly seatWorld: THREE.Vector3
  readonly shakeLookdev: ShakeLookdev
  readonly shakeOffset: CameraShakeOffset
  readonly shakeWear: ShakeWear
  readonly showLoadingScene: (place?: LoadingPlace) => void
  readonly splash: { covering(): boolean; readonly lifting: Promise<void> } | null
  readonly splashCraft: (
    who: string,
    body: {
      readonly position: { readonly x: number; readonly y: number; readonly z: number }
      readonly velocity: { readonly x: number; readonly y: number; readonly z: number }
    },
    struck: boolean,
    impactSpeed: number,
    dt: number,
  ) => void
  readonly splits: SplitTracker
  readonly springArm: SpringArm
  readonly startQuickRace: () => void
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  stripPlace: LivePlace | null
  readonly sunHalo: SunHalo
  readonly sunShadows: SunShadows
  readonly surfaceHeightAt: SurfaceHeightAt
  readonly switchMission: (
    id: string,
    opts?: { readonly skipRide?: boolean; readonly inLoadingScene?: Level; readonly level?: Level },
  ) => Promise<void>
  readonly syncRaceMap: (hud: THREE.Object3D<THREE.Object3DEventMap>) => void
  readonly syncRaceStrip: (nowMs: number) => void
  readonly thirdPersonNow: () => EditionThirdPerson
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  thirdPersonWanted: boolean
  readonly tickLesson: (dt: number, stick: FlightActions) => void
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  titleAim: number
  readonly titleBackKey: Edge
  readonly titleClickAt: { readonly x: number; readonly y: number } | null
  readonly titleCoursePress: (row: string | undefined) => boolean
  readonly titleFocus: FocusEdge
  readonly titleHomeHint: TitleHomeHint
  /** DEV-842: the add-to-home-screen card on a phone browser's title. */
  readonly homeScreenGuide: HomeScreenGuide
  readonly titleLookEuler: THREE.Euler
  readonly titleMenuHost: ReturnType<typeof createTitleMenu>
  readonly titleMenuUp: () => boolean
  readonly titleRowAt: (x: number, y: number) => number
  readonly titleRows: () => readonly PauseOption[]
  readonly titleSteps: RowStepper
  readonly titleTrailEye: THREE.Vector3
  readonly titleVr: TitleVr
  readonly togglePerfCapture: () => void
  readonly touch: TouchControls
  readonly touchConfirmLabel: () => string | null
  readonly touchRaceLabel: () => string | null
  readonly trackDevice: (pad: FlightActions, keys: FlightActions, thumbs: FlightActions) => void
  readonly turnScreen: TurnScreen
  readonly tvActive: () => boolean
  readonly tvPanelFrame: (dt: number) => void
  readonly tvView: TvView
  readonly vignette: Vignette
  readonly vignetteFeed: {
    angularVelocity: VignetteInput['angularVelocity']
    orientation: VignetteInput['orientation']
    verticalAcceleration: number
  }
  readonly wantsFly: boolean
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  warnedNoSticks: boolean
  readonly watchCamera: (dt: number) => void
  readonly watchFrame: () => void
  readonly watchLinkWaiting: () => boolean
  readonly withResultsBoard: (summary: RunSummary) => RunSummary
  readonly withShare: (summary: RunSummary) => RunSummary
  readonly world: Promise<World> | null
  readonly xrLifecycle: ReturnType<typeof createXrLifecycle>
  readonly xrPointer: XrPointer
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  xrProbe: XrProbe
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  xrProbeAt: number
  readonly xrSelect: XrSelectLatch
}

export const createFrame = (ctx: FrameCtx) => {
  /** DEV-859: the OPTIONS pages were opened from the title's row (so the title owns closing them). */
  let titleOptionsOpen = false
  /** DEV-882: the row the gaze was on last frame over the title's OPTIONS plate; -2 before it is read. */
  let titleOptionsLooked = -2
  const {
    CREDITS_BODY_M,
    MODE_REQUEST,
    NO_STICKS_GRACE_SECONDS,
    SEAT_PITCH_LIMIT,
    _aimDirection,
    _aimOrigin,
    _cameraWorld,
    _haloEye,
    _lifeEye,
    _nearAt,
    _nearEye,
    _nearRight,
    _sunColour,
    _titleLookQuat,
    _towardSun,
    accentFlashColor,
    accentPulse,
    aimMenus,
    aimPlate,
    air,
    appSettings,
    arrowTarget,
    askConfirm,
    askFrame,
    askNudge,
    askPointer,
    audio,
    audioLaunch,
    audioShaft,
    autoAim,
    autoBeyond,
    autoCursor,
    autoInput,
    autopilotKey,
    beginLaunch,
    benchDoorAim,
    benchFrame,
    benchPress,
    bloom,
    boostFeel,
    boostPress,
    boundaryFuzz,
    breakProps,
    briefingLevel,
    briefingState,
    cameraKey,
    canvas,
    capabilities,
    chainWatch,
    classicChase,
    clock,
    closePausePages,
    cloudShadow,
    cockpitSelfShadow,
    codeClosePlate,
    codeFocus,
    codeJoinFrame,
    codeKeysDown,
    codeNudgeEdge,
    codePlateState,
    codePress,
    codeUp,
    confirmDevice,
    confirmKey,
    confirmNow,
    controlsMenu,
    coursePanelPresses,
    courseTintFor,
    crashCourseNow,
    crashFeel,
    creditsRollFor,
    cycleGhost,
    deviceLook,
    editionState,
    editorFrame,
    editorHost,
    editorRecordBadge,
    editorRecordInput,
    editorRecordPlaced,
    editorRecordReturn,
    editorRecordStep,
    editorReturn,
    enterVrKey,
    escapeKey,
    exhibition,
    exhibitionTick,
    fade,
    feel,
    fireAccentFlash,
    flatFov,
    flybyFeel,
    frameLesson,
    freeLook,
    gateLadder,
    gatePulse,
    gatePulseColor,
    gatesJudged,
    glassConfirms,
    glassRay,
    goToScreen,
    goToTheHangar,
    gpu,
    handles,
    hangarBackKey,
    hitJolt,
    horizon,
    hudPlacementNow,
    keyboard,
    lapAskUp,
    launchBanner,
    lensIsLive,
    lessonHost,
    letterPlate,
    loadingScene,
    lobbyFocus,
    lobbyFrame,
    lobbyPress,
    lobbySteps,
    lobbyUp,
    menuReticleFrame,
    menuReticleHost,
    menuScene,
    menus,
    mission,
    missionEdition,
    mouseLook,
    nearShadow,
    openRoomsFrame,
    opponentStandings,
    optionsPlate,
    overtakeWatch,
    pause,
    pauseBackKey,
    pauseKey,
    pausePageBack,
    pausePlate,
    pauseRowAt,
    pauseSteps,
    perfPlate,
    perfSys,
    pilot,
    playerCourseHost,
    playerGhostNear,
    playerGhostStandings,
    pointerArbiter,
    pointerWanted,
    profileGuideFor,
    raceLapKey,
    raceLapOffered,
    recenterKey,
    render,
    resetThirdPerson,
    restartRun,
    results,
    roomActive,
    roomClose,
    roomCore,
    roomFrame,
    roomInviteLink,
    roomLobby,
    roomMapDots,
    roomMapField,
    roomOthersNow,
    roomPanelOpponents,
    roomPanelRun,
    roomPlace,
    roomPlaceOthers,
    roomPointAim,
    roomRaceLive,
    roomRender,
    roomShadows,
    roomShare,
    roomStep,
    roomStepCountdown,
    roomTakesPoints,
    roomWatch,
    router,
    run,
    sceneTint,
    seaReflection,
    seatQuaternion,
    seatWorld,
    shakeLookdev,
    shakeOffset,
    shakeWear,
    showLoadingScene,
    splash,
    splashCraft,
    splits,
    springArm,
    startQuickRace,
    sunHalo,
    sunShadows,
    surfaceHeightAt,
    switchMission,
    syncRaceMap,
    syncRaceStrip,
    thirdPersonNow,
    tickLesson,
    titleBackKey,
    titleCoursePress,
    titleFocus,
    titleHomeHint,
    homeScreenGuide,
    titleLookEuler,
    titleMenuHost,
    titleMenuUp,
    titleRowAt,
    titleRows,
    titleSteps,
    titleTrailEye,
    titleVr,
    togglePerfCapture,
    touch,
    touchConfirmLabel,
    touchRaceLabel,
    trackDevice,
    turnScreen,
    tvActive,
    tvPanelFrame,
    tvView,
    vignette,
    vignetteFeed,
    wantsFly,
    watchCamera,
    watchFrame,
    watchLinkWaiting,
    withResultsBoard,
    withShare,
    xrLifecycle,
    xrPointer,
    xrSelect,
  } = ctx
  const frame = (time: number, xrFrame?: XRFrame) => {
    if (!ctx.running) return
    // The main thread's own stopwatch for this frame (VR-PERF §5.2). `time` is
    // the XR display time or the rAF time, which is when the frame was HANDED
    // to us; this is when we started spending it, and the difference between
    // the two at the feed below is the JS cost of a frame — the number that
    // separates "the GPU is slow" from "we are slow" without a profiler, which
    // is the whole diagnosis in a headset. `performance.now()` is legal here:
    // the ban is on `src/sim/`, and every timer in this plan lives in boot.
    const frameT0 = performance.now()
    ctx.frameOrdinal += 1
    // ── the XR probe, inside the frame, once a second (§5.4) ─────────────
    //
    // This is the ONLY place `renderer.xr.getFrame()` and the views can be read
    // safely: three updates them per frame and an `XRView` throws outside its
    // own. One second is chosen against the thing being measured — a probe on
    // every frame would be a cost in the trace it exists to explain.
    if (render.renderer.xr.isPresenting && frameT0 - ctx.xrProbeAt >= 1000) {
      ctx.xrProbeAt = frameT0
      ctx.xrProbe = refreshXrProbe(render.renderer.xr)
    } else if (!render.renderer.xr.isPresenting && ctx.xrProbe !== IDLE_XR_PROBE) {
      ctx.xrProbe = IDLE_XR_PROBE
    }
    const frameSeconds = ctx.lastTime === 0 ? FIXED_DT : (time - ctx.lastTime) / 1000
    ctx.lastTime = time

    // Step 1 (APP-SPLIT §1c): the fade, then the screen swap at its black
    // (`boot/app/screen-router.ts`). The ONLY place `screen` changes.
    router.frame(frameSeconds)
    vignette.setFade(fade.amount)
    // The title valley's own curtain (DEV-352), on the same clock as the fade
    // and in the same breath. Out of the scene the frame it finishes, so a
    // cleared curtain costs nothing afterwards rather than a full-screen quad
    // blending zero over every title frame.
    if (handles.titleCurtain) {
      handles.titleCurtain.update(frameSeconds)
      if (document.body.dataset.titleCurtain !== handles.titleCurtain.phase) {
        document.body.dataset.titleCurtain = handles.titleCurtain.phase
      }
      if (handles.titleCurtain.phase === 'gone') {
        handles.titleCurtain.object.removeFromParent()
        handles.titleCurtain.dispose()
        handles.titleCurtain = null
      }
    }
    // S6's pulse, on the same quad and in the same breath as the fade — the two
    // things that share this surface are updated together so neither can be a
    // frame stale behind the other (DEV-108).
    //
    // It advances on EVERY screen, including paused and in the hangar, and that
    // is the decision rather than an oversight: the only thing it can do while
    // nothing is firing is decay to nothing, and a pulse frozen half-lit across
    // a pause would be a bright frame edge somebody reads a comfort menu
    // through. The same argument `vignette.update`'s `null` is there for,
    // reached from the other side.
    //
    // The ONE exception is `?snap=`, and it is the only Anniversary feature that
    // needs one. The snap freezes the sim and keeps rendering, which is exactly
    // right for every other feature — a haze, a shadow, a cloud and a lens are
    // all still there on the next frame — and useless for this one, because the
    // pulse is over in under a second and the screenshot arrives after it. So §7's
    // before/after pair could not exist for S6 at all unless the moment the snap
    // froze included it. It is the same gesture `stepSeconds` already makes for
    // the fixed step, one clock over, and it is unreachable without the switch.
    gatePulse.update(run.snapped ? 0 : frameSeconds)
    accentPulse.update(run.snapped ? 0 : frameSeconds)
    const pulseBlock = editionState.current.fx.gatePulse
    // DEV-640: the tank's amber flash shares the quad: the stronger of the two
    // is drawn, never a sum (the quad holds one pulse).
    const accentFlashing = accentPulse.level > gatePulse.level
    const shownPulse = accentFlashing ? accentPulse : gatePulse
    if (shownPulse.level > 0) {
      if (accentFlashing) {
        gatePulseColor.copy(accentFlashColor)
      } else {
        const [r, g, b] = pulseColorLinear(pulseBlock.tint)
        gatePulseColor.setRGB(r, g, b)
      }
      vignette.setPulse({
        level: shownPulse.level,
        innerRadius: pulseBlock.innerRadius,
        feather: pulseBlock.feather,
        streaks: pulseBlock.streaks,
        streakDepth: pulseBlock.streakDepth,
        phase: shownPulse.phase,
        color: gatePulseColor,
      })
    } else {
      vignette.setPulse(null)
    }
    // DEV-127: the out-of-bounds static, in the same breath as the pulse and
    // the fade for the same reason. The PROGRESS is the sim's — `boundary` is
    // stepped on the fixed step below and this only reads it — so a paused or
    // snapped run holds its level rather than growing it, and a mission swap
    // that replaces `boundary` clears it on the next frame. Only in the
    // mission: the hangar and the title have no boundary to be outside of.
    // Not scaled by the speed-FX slider (`render/boundary-fuzz.ts` says why).
    boundaryFuzz.update(frameSeconds)
    vignette.setFuzz(
      ctx.boundarySpec && router.screen === 'mission'
        ? boundaryFuzz.frame(
            editionState.current.boundary.fuzz,
            boundaryProgress(ctx.boundary, ctx.boundarySpec),
          )
        : null,
    )
    // The only handle a spec has on a transition, and the reason it exists: a
    // screenshot taken 0.2 s after a press used to be a finished frame and is
    // now a half-black one. Same `data-` convention as `terrain-ready`.
    //
    // ON THE EDGE. `dataset.x = v` sets the attribute whether or not the value
    // moved, and an attribute write per frame is a style invalidation per frame
    // for a string that changes four times a minute. The same reasoning as the
    // hover cue above: *a held gaze is one hover, not eighty a second.*
    if (ctx.fadePhaseShown !== fade.phase) {
      ctx.fadePhaseShown = fade.phase
      document.body.dataset.fade = fade.phase
    }
    // DEV-469: while the course editor is up, its frame is the whole frame.
    if (editorFrame(time, frameSeconds)) return

    // Read input ONCE per frame, not per sim step: a 30 fps machine would
    // otherwise sample the pad three times for one physical instant and a
    // 144 fps one would drop samples. The actions are held across the steps
    // that follow, which is what a fixed-step sim expects.
    //
    // `invertPitch` comes off the live settings — it was hard-coded `false` at
    // all three call sites, which made the whole option a dead field. It is one
    // switch for the whole game (D16), so all three read the same one.
    const inputOpts = { invertPitch: appSettings.comfort.invertPitch }
    // DEV-566: a phone held upright has TURN YOUR PHONE over everything, and
    // nothing behind it takes input. Fingers and keys are stopped at the
    // element and the window (`turn-phone.ts`); the pads are held off here,
    // before anything reads them this frame.
    const turned = turnScreen.up
    setPadsHeld(turned)
    const pad = readGamepad(inputOpts)
    const keys = keyboard.read(frameSeconds, inputOpts)
    // XR controllers are NOT in `navigator.getGamepads()` — not before a
    // session, not during one. They hang off `session.inputSources`, so in a
    // headset this is the only device that reports anything at all.
    const xr = readXrInput(render.renderer.xr.getSession(), inputOpts)
    // The thumbsticks, on a phone. `read()` is also this reader's FRAME
    // BOUNDARY — it spends the tap latches that `touch.confirm`, `touch.pause`
    // and `touch.toggleAutopilot` report below, so it has to happen here, with
    // the other reads, and not down where those getters are used.
    const thumbs = touch.read(inputOpts)
    // DEV-396: before anything branches on the screen, so every screen feeds it.
    trackDevice(pad, keys, thumbs)
    // Whichever device is actually being used wins, per axis, by magnitude.
    // No mode switch, no "press any key to activate" — pick up a pad mid-flight
    // and it just works.
    let actions = handles.flight ? mergeActions(pad, keys, xr.actions, thumbs) : noActions()

    // ── looking around, which is not flying ──────────────────────────────
    //
    // The mouse looks everywhere, because nothing else is bound to it. The
    // FLIGHT controls — the pad's right stick and the keyboard — look only
    // where they are free, which is the hangar: in a mission that stick's
    // horizontal is the aileron (scheme "a") and W is the elevator, and one
    // control with two meanings is a ship that rolls when you glance left.
    //
    // The keyboard half is not a nicety. Without it a visitor with no pad
    // cannot turn the chair, so cannot put the nose pointer on a holotable, so
    // cannot pick a level — on the tier the landing page calls "Playable".
    const presenting = render.renderer.xr.isPresenting
    // ── the mouse is a NECK only where there is a neck's job (DEV-301) ────
    //
    // Not in a session — you have one. And on the title only once its rows
    // are up (DEV-418): DEV-301 switched the title off entirely, because it
    // placed its own camera and threw `look` away, so a capture there hid the
    // cursor and bought nothing. It turns now — the render block adds
    // `look` to its pose — so the capture has a consumer, and a cursor click on
    // a row is still a press of that row (`setCursorTarget`, above the loop).
    // Before the rows, over the emblem on black, it is DEV-301's title still:
    // nothing to capture for, and a click presses. (DEV-557 took away the
    // landing card that used to stand here too.)
    const titleLooks = !presenting && router.screen === 'title' && titleMenuUp()
    // DEV-616, Matt: "fftv seems to capture my cursor. ... i'm going to have a
    // tab running fftv running on a monitor while i do work elsewhere - so
    // don't capture the cursor plz." A viewer (TV, or a `?watch=` link) has no
    // ship to fly: its mouse drags (`tv-camera-input.ts`), it never captures.
    const watching = tvActive() || roomCore.watch !== null || exhibition.running()
    mouseLook.setEnabled(!presenting && !watching && (router.screen !== 'title' || titleLooks))
    controlsMenu.setXr(presenting)
    // Constant for the life of the page — a device does not grow a touchscreen
    // — but set here beside `setXr` so the two halves of "which hardware does
    // this page name" are one thing to read rather than two to find.
    controlsMenu.setTouch(capabilities.touch)
    const lookOpts: LookOptions = {
      invertPitch: appSettings.comfort.invertPitch,
      flightIdle: router.screen === 'menu',
    }
    // DEV-418: on the title the right stick is free too — the LEFT stick walks
    // the rows, and there is no ship — so it looks, as it does in the hangar.
    // The keyboard does not: its W / S and arrows are the rows' (the pause
    // plate's reading), and one key with two meanings is the bug this block's
    // header is about. Nor does a drag on a phone, whose title glass is taps.
    const stickLookOpts: LookOptions = titleLooks ? { ...lookOpts, flightIdle: true } : lookOpts
    const look = addLook(
      addLook(
        addLook(
          readStickLook(frameSeconds, stickLookOpts),
          // DEV-389: nor while a room's lobby is up — its arrows walk the rows,
          // as the title's do; the mouse and the right stick still look.
          readKeyboardLook(
            keys,
            frameSeconds,
            // DEV-882: nor while the hangar's OPTIONS plate is up, for the same
            // reason: its arrows step the rows rather than tip the view.
            lobbyUp() || optionsPlate.up() ? { ...lookOpts, flightIdle: false } : lookOpts,
          ),
        ),
        mouseLook.read(lookOpts),
      ),
      // A drag on the glass, which on a phone is the ONLY way to aim the nose
      // pointer at a holotable — there is no mouse to capture and no right
      // stick sitting idle. Gated by the same `flightIdle` as the other two.
      touch.readLook(lookOpts),
    )

    // ── autopilot ────────────────────────────────────────────────────────
    //
    // P toggles, and so does the AUTO chip. Edge-detected, or holding either
    // strobes it every frame.
    //
    // The chip is the reason the autopilot is reachable at all on a phone: `P`
    // needs a keyboard, and `?autopilot=1` is a development switch that skips
    // both menus, so before this there was no way to ask a touch device to fly
    // the course. It is also the honest answer to a control scheme nobody has
    // worn yet — a visitor who cannot fly it can still watch it being flown,
    // which is what the attract route was offering them instead.
    // DEV-491: R, in the editor's recording flight, and the line that says so.
    editorRecordInput()
    editorRecordBadge()
    const wantAutopilot = keyboard.toggleAutopilot || touch.toggleAutopilot
    // DEV-435: not in a mode it cannot fly (Free Flight). A run that arrives
    // there with it on, from `?autopilot=1` or a course switch, has it off.
    const autopilotOffered = MODES[runningMode(ctx.level)].autopilot
    if (pilot.autopilot && !autopilotOffered) {
      pilot.autopilot = false
      console.info('autopilot off — not offered in this mode')
    }
    const autopilotPressed = autopilotKey.step(wantAutopilot)
    if (autopilotPressed && autopilotOffered) {
      pilot.autopilot = !pilot.autopilot
      console.info(`autopilot ${pilot.autopilot ? 'ON' : 'off'}`)
    }

    // ── and in a HEADSET, where there is no P and no chip (DEV-181) ──────
    //
    // Left X, held two seconds. Every worn lap so far has been hand-flown
    // because the autopilot armed from the URL and from a keyboard, and a
    // headset has neither — fine for a lap, wrong for the repeatable soak
    // `docs/testing/perf-protocol.md` asks for.
    //
    // A HOLD rather than a press, because the two directions are not
    // symmetrical: turning it off by accident is undone by the stick check
    // below ("you took the stick"), and turning it ON by accident takes the
    // aircraft away from somebody mid-lap with no undo they would know to
    // reach for. `src/input/hold-toggle.ts` carries the argument.
    //
    // `frameSeconds` clamped exactly as the particles clamp it: a tab that was
    // backgrounded for ten seconds must not complete a two-second hold on its
    // first frame back.
    const holdStep = stepHoldToggle(pilot.autopilotHold, xr.autopilot, Math.min(frameSeconds, 0.1))
    pilot.autopilotHold = holdStep.state
    if (holdStep.toggled && autopilotOffered) {
      pilot.autopilot = !pilot.autopilot
      console.info(`autopilot ${pilot.autopilot ? 'ON' : 'off'} \u2014 held X`)
    }

    // ── CHANGE VIEW (DEV-128) ────────────────────────────────────────────
    //
    // X on the pad (2016's own `Action3`, `Input_Ship.cs:312`), V on the
    // keyboard, the CAM chip. Edge-detected, as 2016 debounced it on release
    // (:329). The flip itself happens UNDER the curtain, in `act`, because
    // that is what `CamChanger.ChangeCam()` does: fade out in 0.12 s, reparent
    // while black, fade in over 0.25 s — all three numbers off the sheet. A
    // second press while the fade is running is ignored by `goToScreen`, which
    // is also 2016's behaviour. Refused in a session, and the row says why.
    //
    // DEV-427: and it HOLDS the black, as `CamChanger` does — its fade-in waits
    // 0.2 s from the fade-out's trigger, so the screen sits solid for about
    // 0.1 s. The port came straight back on the first black frame (measured: two
    // frames of black at 180 Hz), and a switch with no black in it reads as a
    // cut. The sheet's third number now has a reader.
    //
    // The choice is SAVED, as `PlayerPrefs["PlayerCameraPref"]` was: a player
    // who flew from behind yesterday flies from behind today.
    const wantCamera = keyboard.toggleCamera || gamepadCameraToggle() || touch.toggleCamera
    const cameraPressed = cameraKey.step(wantCamera)
    if (cameraPressed && handles.flight && router.screen === 'mission' && !presenting) {
      goToScreen(router.screen, {
        outSeconds: FADE.cameraSwitchOutSeconds,
        inSeconds: FADE.cameraSwitchInSeconds,
        holdSeconds: CAMERA_SWITCH_BLACK_SECONDS,
        act: () => {
          ctx.thirdPersonWanted = !ctx.thirdPersonWanted
          resetThirdPerson()
          freeLook.reset()
          appSettings.comfort = {
            ...appSettings.comfort,
            cameraView: ctx.thirdPersonWanted ? 'third' : 'first',
          }
          saveSettings(appSettings.comfort)
          console.info(`camera: ${ctx.thirdPersonWanted ? 'third person' : 'cockpit'}`)
        },
      })
    }

    // ── H: ENTER VR, from any flat screen (DEV-557) ─────────────────────
    //
    // The key hint on the title's ENTER VR plate, and the way in from a screen
    // that has no plate (the pause plate's ENTER VR row is the other). A
    // keydown is the transient activation `requestSession` needs. Not while the
    // letter plate is up: there H is a letter of a room's code.
    const wantVr = keyboard.enterVr
    const enterVrPressed = enterVrKey.step(wantVr)
    if (enterVrPressed && !presenting && !codeUp()) {
      // DEV-558: from the title, the session goes on to the hangar, as the row does.
      if (router.screen === 'title') titleMenuHost.titleVrToHangar = true
      titleVr.press()
    }
    // ── DEV-558: ENTER VR from the title lands in the hangar ────────────
    //
    // Matt, 2026-10-01: *"Clicking either should take us to the Hangar"*. The
    // session starts asynchronously (`boot/enter-vr.ts`); the first frame it is
    // presenting, a press made on the title goes where START goes. A refused
    // or abandoned request leaves the title up, the row saying why.
    if (titleMenuHost.titleVrToHangar && presenting) {
      titleMenuHost.titleVrToHangar = false
      if (router.screen === 'title' && router.pendingScreen === null)
        goToTheHangar('title: into VR, to the hangar')
    }
    if (titleMenuHost.titleVrToHangar && router.screen !== 'title')
      titleMenuHost.titleVrToHangar = false

    // Grabbing the stick stands it down. Checked against the MERGED human input
    // before the autopilot overwrites it, and only on the axes — a throttle
    // resting against its own dead zone would otherwise fight for control.
    if (pilot.autopilot && (Math.abs(actions.pitch) > 0.25 || Math.abs(actions.roll) > 0.25)) {
      pilot.autopilot = false
      console.info('autopilot off — you took the stick')
    }

    // Press A for us, so `?autopilot` needs no human at all. The SPEC has to go
    // with it: without it this took the ride branch and the autopilot started
    // every run at the bottom of a shaft that is 95 m underwater.
    //
    // The FLYING half is not here — it is inside the fixed step, see `autoFly`.
    //
    // `beginLaunch`, not `startLaunch`: the ride is spent by the press that uses
    // it and not by the frame that watches for one. DEV-094, and the autopilot
    // rides the lift like anybody else — a switch that made the harness skip 15 s
    // of the game would be testing a build nobody plays.
    // `main` fixed the same spent-ride line the same day (DEV-097, the swap
    // that began 107 m above its hangar); this branch's `beginLaunch` is the
    // same fix with the reveal below on top of it, so its shape is kept.
    if (pilot.autopilot && handles.flight) beginLaunch()

    // ── 2016's `trigger_enableTerrain`: no world until the lift is out ────
    //
    // `Trigger_EnableTerrain.cs` holds the mission's environment INACTIVE while
    // the player is in the shaft and switches it on when the rising platform
    // passes a trigger box 100.4 m up — see `render/elevator.ts`'s `REVEAL_RISE`
    // for the prefab, the fileIDs and the composition.
    //
    // That is DEV-075's fix one room over, and it is the one that cannot be
    // wrong: the room does not have to be somewhere the terrain happens to miss,
    // because while you are in it there is no terrain in the scene at all. The
    // launch room's base is 92–99 m inside solid ground on four of the seven
    // rigs (`rookie_01_hoverJet` −98.8, `int_02_hoverJet` −95.4,
    // `adv_01_hoverJet` −93.2, `hoverJet_kauai_beg` −92.7), so the whole 106 m
    // climb is through rock, and the shaft's eight collars are inside it too.
    //
    // **This is the RIDE, not the pad.** Censused in the browser with the
    // terrain forced back on: ZERO terrain vertices inside any of the five
    // rooms' volumes, with the lowest one 79–98 m overhead. DEV-077's *"looking
    // at the inside of a hill"* is a third thing again and it is still there —
    // see DEV-094 §"what was not fixed": `rookie_01_hoverJet`'s pad stands in a
    // copse, trees 5.4 m away and 5 m taller than the release.
    //
    // The LAND only. The sea is a second faceted terrain in this port and 2016's
    // reference is one GameObject, so there is a judgement in here rather than a
    // reading: no shipped room's volume is anywhere near a water surface (the
    // four buried rooms top out at 20.4 m on alpine, 118.4 and 682.4 inland, and
    // 216.5 inside kauai), and the underwater ascent on simonet is a shot this
    // port already keeps (`tests/e2e/water-underside.spec.ts`).
    //
    // `updateLod` goes on running against a hidden group on purpose, so the
    // chunks are at the LOD they will be wanted at when it comes back rather
    // than coarsening visibly in the first second of the flight.
    const revealed =
      router.screen !== 'mission' ||
      // DEV-475: the world waits for the ride only where there IS a ride (a
      // shaft); a player course's lift rises nothing and its world is there.
      worldRevealed(
        ctx.launch.rise,
        !!ctx.launchSpec && handles.elevator !== null,
        ctx.landRevealRise,
      )
    if (handles.liveTerrain) {
      if (RIDE_HIDE === 'bore') {
        // DEV-249. The group stays drawn for the whole ride and only the
        // chunks the bore crosses come and go, so the step at the reveal is a
        // handful of chunks instead of the world. Both halves are written
        // EVERY frame rather than on the edge: `boreChunks` is rebuilt with
        // the world and a chunk that was hidden by a previous ride must not
        // stay hidden into this one — the same reason `setReleased` is a
        // state write and not an event.
        handles.liveTerrain.terrain.group.visible = true
        for (const chunk of handles.boreChunks) chunk.visible = revealed
        // ── and the cross-fade clone, which the selection never saw ────────
        //
        // DEV-268. `boreChunks` is a snapshot of the group's children at world
        // build time; `load-terrain.ts` adds a `<name>:incoming` mesh to that
        // same group whenever a chunk changes LOD, so the bore's own chunk was
        // hidden while its incoming half drew the hillside in a sealed shaft
        // for a whole `lodTransitionTime` — 1 s on alpine, and 0 on Classic,
        // which sets `durationScale` to 0 and never fades at all.
        //
        // Every frame and in BOTH directions, which is the whole of why this
        // is not a hide-on-the-edge: a clone hidden during the ride and not
        // un-hidden at the reveal is a chunk-sized HOLE in the ground you have
        // just been handed, for the rest of its fade. Same trap as the one
        // above, one turn further on.
        if (handles.boreChunkNames.size > 0) {
          for (const child of handles.liveTerrain.terrain.group.children) {
            const name = child.name
            if (name.length <= LOD_FADE_SUFFIX.length || !name.endsWith(LOD_FADE_SUFFIX)) continue
            if (handles.boreChunkNames.has(name.slice(0, -LOD_FADE_SUFFIX.length))) {
              child.visible = revealed
            }
          }
        }
      } else {
        handles.liveTerrain.terrain.group.visible = revealed
      }
    }
    // `disableAfterTriggered`: 2016 switches `startingArea_bottomFloor` and
    // shaft segments 01–07 OFF at the same moment. The room is 100 m under the
    // ground for the rest of the run; the six missions with no rig never have a
    // ride to be inside of, and one of their rooms — `int_01_jumpSeat`'s — sits
    // with the simonet hillside running through its walls, which nobody can see
    // from the cockpit and anybody can see from the air.
    if (handles.launchRoom) handles.launchRoom.object.visible = !revealed

    // Once released, 2016 switches its seven dead segments off and leaves the
    // live one; the port does the same and keeps the walls, because the shaft
    // head is a structure you can see from the air and a tube that vanished
    // at release would vanish under the ship (DEV-106). The platform goes with
    // the dead segments: four rigs draw their own pad in the same place.
    // DEV-548 (DEV-461's `?dock=pad`, now the behaviour): the lift's car
    // becomes the grid's pad the moment it docks — lit by the island as the
    // others are — not at the release, so the dish does not stand in the
    // room's baked light, brighter than its neighbours, for the countdown. The
    // pad IS the dish, docked (`releasePadOf`), so nothing moves at the swap.
    const docked = ctx.launchSpec !== null && ctx.launch.rise >= topRise(ctx.launchSpec) - 1e-6
    if (handles.elevator) handles.elevator.setReleased(!launchHoldsShip(ctx.launch) || docked)
    // DEV-444: and the grid's player pad is that dish's stand-in, so it is off
    // while the lift holds the ship and on once it lets go.
    if (handles.elevator) handles.startGrid?.setHeld(launchHoldsShip(ctx.launch) && !docked)
    // DEV-460: the sea's hole closes when the lift's dish plugs the hatch —
    // below a closed floor, so nobody sees the switch — and stays closed: the
    // hatch and the dish (then the grid's pad) cover the shaft for the rest of
    // the run, and a sea with no bore in its shader keeps early-z (DEV-167).
    // On the edge, not every frame, so a probe that opens it again is heard.
    if (handles.liftSeal && handles.liftSeal.seal.sealRise !== null) {
      const open = ctx.launch.rise < handles.liftSeal.seal.sealRise - 1e-6
      if (open !== handles.liftSeal.live) {
        const water = handles.liveTerrain?.ocean?.water
        if (open)
          water?.setShaftBore(
            handles.liftSeal.x,
            handles.liftSeal.z,
            0,
            handles.liftSeal.topY,
            handles.liftSeal.table,
          )
        else water?.clearShaftBore()
        handles.liftSeal.live = open
      }
    }

    // Say it once, out loud, if we are in a session that cannot fly. Apple
    // Vision Pro supports `immersive-vr` and has no controllers, so this is a
    // real device state and not a defensive branch — and silence would leave
    // someone shaking a controller that was never going to work.
    // Recentre on the PRESS, then re-read input: the offset changes the head
    // pose the rest of this frame is drawn from, and a frame drawn half in the
    // old space and half in the new is a visible jolt.
    if (recenterKey.step(xr.recenter)) {
      if (recenterXr(render.renderer, xrFrame)) {
        console.info('recentred on the current head pose')
      }
    }

    if (!render.renderer.xr.isPresenting) {
      ctx.presentingSince = 0
    } else {
      if (ctx.presentingSince === 0) ctx.presentingSince = time
      const presentingFor = (time - ctx.presentingSince) / 1000
      if (xr.hasSticks) {
        // Reported late, as expected. Nothing to say.
        ctx.warnedNoSticks = true
      } else if (!ctx.warnedNoSticks && presentingFor > NO_STICKS_GRACE_SECONDS) {
        ctx.warnedNoSticks = true
        console.warn(
          `XR session still has no controller with a thumbstick after ${NO_STICKS_GRACE_SECONDS}s. ` +
            'Flight needs one — a paired standard gamepad also works. ' +
            '(Vision Pro has no controllers at all.)',
        )
      }
    }

    // ── the dashboard stops the world too (DEV-206) ────────────────────
    //
    // Forced every frame rather than latched on the transition, and the
    // difference matters: a latch can be undone by the player's own pause
    // toggle while the overlay is still up — and while it is up the toggle is
    // unreachable, so the run would resume behind a dashboard nobody can see
    // past. The player leaves the pause menu when they can press a button
    // again, which is the moment the session goes back to `visible`.
    //
    // Scoped to a live mission for the same reason `wantPause` is: pausing the
    // title valley or the hangar is meaningless, and the pause plate is a
    // cockpit instrument that does not exist outside one.
    if (xrRunHeld(xrLifecycle.xrVisibility) && handles.flight && router.screen === 'mission')
      pause.paused = true

    // Press A to launch. Edge-detected, though `startLaunch` is idempotent for
    // the same reason 2016's `gameReady` flag exists: the button is held down
    // across many frames and the elevator must not restart on each of them.
    // ── pause, and what A means while it is up ─────────────────────────
    //
    // Edge-detected because it is a TOGGLE — a held Backspace must not flip it
    // eighty times a second.
    // ── the XR D-pad OPENS the plate; it does not close it (DEV-207) ───
    //
    // Matt: *"put pause on dpad left or right (and disable that when the pause
    // menu is up)"*. So `xr.pause` is read only while the plate is DOWN.
    //
    // It is not a preference. On a Frame the two reachable D-pad directions are
    // the same two indices, so a toggle would mean the control that steps the
    // list also closes the list — press down to move a row, and the menu shuts.
    // While it is up those buttons are `xr.menuStep` instead, below.
    //
    // Every other pause control stays a TOGGLE, because on those devices the
    // button is not doing a second job: Start on a pad, Backspace on a
    // keyboard, the touch button. Closing from XR is `xr.back` — B, the Xbox
    // way — handled with the other menu buttons below.
    // DEV-406 follow-up: the touch FLY AGAIN chip is offered only on the
    // results panel, where the pause control means exactly that, so it rides
    // the same edge. Anywhere else it is hidden and reads false.
    const wantPause =
      (!pause.paused && xr.pause) || gamepadPause() || keyboard.pause || touch.pause || touch.again
    // Both latches are stepped HERE, on every frame this block runs, and the
    // branches below read the answer: they used to read the latch and write it
    // after the last of them, which made the order of those lines load-bearing
    // (`pageBack` has to see the press before `nextPaused` is told it is spent).
    const pausePressed = pauseKey.step(wantPause)
    const keyboardEscape = keyboard.escape
    const escapePressed = escapeKey.step(keyboardEscape)
    // DEV-563: spent every frame, on every screen; see the Escape branch below.
    const lostCapture = mouseLook.readLostCapture()
    // ── on the RESULTS panel, the pause control means FLY AGAIN ─────────
    //
    // DEV-406 swapped the two. Matt, 2026-09-25: *"when a race has finished,
    // take me back to the hangar when i press A (not start a new race)"*. So A
    // goes home (the confirm handler's `lastResult` branch), and this, the
    // OTHER button, is another go. The reasoning below still holds with the
    // meanings exchanged: two buttons, one meaning each, and the panel names
    // both. It is kept as the record of why there are two.
    //
    // The panel used to be a dead end. It offers one thing — `A or ENTER to fly
    // again` — and pausing was refused here on the reasoning that *"RESTART
    // would shadow the results panel's own 'press A to fly again' — the same
    // button, two meanings, one frame."* That is true of A, and it is why the
    // way out is the OTHER button rather than a fourth row on a plate.
    //
    // So the only route back to the level select was: fly the mission you just
    // finished AGAIN, pause that, and quit it. Nobody would find that, and 2016
    // does not ask anyone to — `missionResults` carries `Button_Next.cs`, which
    // walks the campaign chain and falls back to its default target,
    // `setGameplayOptions`, **which is the level select** (`_ui-flow.md` §3).
    // FF2 has no chain, so the fallback is the whole behaviour.
    //
    // The run is RESET on the way out, exactly as the pause menu's EXIT does it:
    // a mission you return to with a finished scoreboard and a stopped clock is
    // a state no other path can produce. `tests/e2e/completion.spec.ts`.
    if (pausePressed && handles.flight && run.lastResult && router.screen === 'mission') {
      // DEV-406: another go. The `else if` below cannot also open the pause
      // menu on this press, even though `restartRun` clears `lastResult` now.
      restartRun()
      console.info('results: fly again')
    }
    // Not from the chair: there is nothing running to pause, and the menu's own
    // way out is the mission in front of you.
    //
    // ── and NOT while the boundary is killing you (DEV-107) ────────────
    //
    // The death curtain draws at `renderOrder` 10,000 — above the pause plate's
    // 12, because it is the thing between you and all of it. So a pause taken
    // inside those 2.5 s opens a menu nobody can see, on a frozen sim that will
    // never finish the death and lift the curtain: press pause, get a black
    // screen, and the only way out is a blind press. 2016 makes the death
    // uninterruptible for its own reasons (`restarting` gates `RestartLevel`,
    // and flying back inside does not save you), so refusing here is the same
    // decision one layer up rather than a new rule. The run is already over.
    // DEV-480: on TV, TV's plate
    // DEV-628: not Backspace, which is TV's back (it leaves, below), as B is.
    else if (pausePressed && tvActive()) {
      if (!keyboard.pause) tvView.toggle()
    }
    // ── DEV-563: Escape pauses too, in both of the forms it arrives in ──
    //
    // Captured, the browser spends Escape on letting go and the game sees only
    // the capture ending (`readLostCapture`); free, it is a key. `nextPaused`
    // has the rule and why the first only opens. Read every frame, whatever
    // the screen, so a capture let go in the hangar is not saved up for the
    // first frame of the next mission. Flat only: in a session the mouse is
    // off, and Escape belongs to the browser's session handling as it did
    // before this row.
    //
    // Resume does not take the pointer back: Escape grants no activation to
    // ask with, and Chrome refuses a capture for about a second after the
    // player let go (measured 2026-10-01: refused at ~0.45 s, granted at 2 s).
    // The next click on the world captures, as it always has.
    else if (
      handles.flight &&
      !run.lastResult &&
      router.screen === 'mission' &&
      ctx.boundary.phase !== 'dying' &&
      !tvActive()
    ) {
      // DEV-621: on a page of the plate, Backspace and a free Escape go BACK
      // one page rather than closing it; from the root they resume, below,
      // as they always have. Start and the touch button still close it all.
      const lookdevUp = handles.liveLookdev !== null && !handles.liveLookdev.element.hidden
      const pageBack =
        pause.paused &&
        ((pausePressed && keyboard.pause) || (escapePressed && !presenting && !lookdevUp)) &&
        pausePageBack()
      const next = pageBack
        ? pause.paused
        : nextPaused(pause.paused, {
            toggle: pausePressed,
            escape: escapePressed && !presenting,
            lostCapture,
            // DEV-563 follow-up (Matt): with the `?lookdev=1` panel open, Escape
            // frees the pointer for its sliders and pauses nothing.
            escapeFreesOnly: handles.liveLookdev !== null && !handles.liveLookdev.element.hidden,
            // DEV-566: the phone is upright. Paused while it stands; still paused
            // after it turns, until RESUME.
            held: turned,
          })
      if (next !== pause.paused) {
        pause.paused = next
        menus.pauseCursorAim = false
        // Leaving the pause menu closes any sub-page too, so the NEXT pause opens
        // on RESUME rather than wherever you were reading.
        if (!pause.paused) closePausePages()
        // Opens on RESUME, every time. The safe option is the default, so a
        // player who pauses by accident and mashes A is back in the run rather
        // than at the start of a new one, and a remembered row from last time
        // never decides anything.
        pause.pauseAim = 0
        pauseSteps.reset()
      }
    }
    // DEV-566: the turn screen says the run is waiting, when one is.
    turnScreen.setPausedNote(
      turned && pause.paused && handles.flight !== null && router.screen === 'mission',
    )

    // The step every menu below takes this frame (`input/menu-step.ts`): the
    // keys read as keys (the ramp taken out), else the merged stick, else the
    // D-pad. Read once and only when a menu asks, because the merge allocates
    // and most frames have no menu up. Everything it reads is a constant of
    // this frame, so five readers get one answer, as five copies did.
    let menuStepMemo: -1 | 0 | 1 | null = null
    const menuStepNow = (): -1 | 0 | 1 =>
      (menuStepMemo ??= menuStepFrom(
        keyboard.menuPitch(inputOpts),
        mergeActions(pad, xr.actions, thumbs).pitch,
        xr.menuStep,
        appSettings.comfort.invertPitch,
      ))

    // ── moving the selection with the stick ────────────────────────────
    //
    // Edge-detected against a deadband, so holding the stick steps ONE row
    // rather than strobing the list. Pull the stick BACK — or press ArrowDown —
    // to go down the list, and forward to go up it, the way every list on a
    // controller has ever worked.
    //
    // Two corrections live in `menuNudge`, which is where the direction now
    // lives and where it can be handed a number and asked which way it goes.
    // Read its header: the sign was wrong for the pad for the life of the port,
    // and the invert has no business reaching a menu.
    if (pause.paused) {
      // ── the keyboard is read as a KEY here, not as an axis (DEV-299) ────
      //
      // Matt: *"arrow keys need several presses in the pause screen."* He is
      // right and the cause is arithmetic — `keyboard.ts`'s ramp times
      // `MENU_NUDGE_DEADBAND` is 90 ms of HELD key before the menu sees
      // anything, so a tap moved nothing. `menuPitch` is that axis with the
      // ramp taken out; its header has the working.
      //
      // **`actions` is deliberately not the stick half any more.** It merges
      // the keyboard IN, and the ramp's decay is as much of the bug as its
      // climb: a released key sits past the deadband for another 90 ms, which
      // holds the pause plate's step latch and eats the next tap. So the two
      // halves are read from disjoint devices, the keys and everything else,
      // and the keyboard's ramped axis does not reach this menu at all.
      //
      // `menuStepFrom` has the precedence, and `menuNudge` under it is still the
      // only place that knows which way a row moves. Read its header: the sign
      // was wrong for the pad for the life of the port, and it was wrong because
      // the direction was written out twice. The stick wins a tie with the
      // D-pad because it is the one every device has: `xr.menuStep` is 0 on a
      // controller whose left face buttons are face buttons rather than a
      // D-pad, so this costs a Touch user nothing at all.
      const step = pauseSteps.take(menuStepNow())
      if (step !== 0) pause.pauseAim = clampAim(pause.pauseAim, step, pausePlate().rows.length)
      // The frozen sim must not also receive this as a flight command: the
      // ship is not flying, and on unpause a held stick would be a held stick.
      actions = noActions()
    }
    // ── and the lobby's rows, the same way (DEV-389) ────────────────────
    if (lobbyUp()) {
      const step = lobbySteps.take(menuStepNow())
      if (step !== 0)
        roomLobby.lobbyAim = clampAim(roomLobby.lobbyAim, step, roomLobby.lobbyRows.length)
    }
    // ── and the hangar's OPTIONS plate, the same way (DEV-857) ──────────
    if (optionsPlate.up()) optionsPlate.nudge(menuStepNow())
    // ── and the questions after a lap, the same way (DEV-571) ───────────
    //
    // The run is over, so the stick is the menu's while the plate is up, as
    // it is the pause plate's: the ship coasts on with nothing held. Another
    // go (START) and "race this lap" (Y, R) are buttons, not the stick.
    if (lapAskUp()) {
      askNudge(menuStepNow())
      actions = noActions()
    }
    // ── and the title's two rows, the same way (DEV-353) ────────────────
    //
    // The keys as keys, the stick or the D-pad otherwise, through the one
    // `menuStepFrom` that knows which device wins and the `menuNudge` under it
    // that knows which way a row moves: the pause plate's own reading, for the
    // pause plate's own painter. There is no ship on the title for a stick to
    // command, so nothing else here has to let go of it.
    if (titleMenuUp() && !codeUp()) {
      const step = titleSteps.take(menuStepNow())
      // DEV-558: ENTER VR is a row, so the keys and the stick reach it as
      // they reach START (DEV-557's walk DOWN past the last row went with
      // its plate).
      if (step !== 0) ctx.titleAim = clampAim(ctx.titleAim, step, titleRows().length)
    }
    // BACK, from every device, as this frame's raw state (`backPressed`, which
    // says which keys each screen counts). One reading for the TV plate, the
    // title's letter plate, the hangar and the pause plate below, which each
    // wrote it out themselves. A free Escape is one the browser did not spend
    // on letting go of the pointer (DEV-563), and never in a session.
    const backSources: BackSources = {
      xrBack: xr.back,
      padB: gamepadBack(),
      backspace: keyboard.pause,
      freeEscape: keyboard.escape && !mouseLook.locked && !render.renderer.xr.isPresenting,
    }
    // DEV-480: as the title, B puts it away
    if (tvActive()) {
      // DEV-628: back is B (a pad's and a headset's), Backspace and a free
      // Escape: the plate up, it goes away; down, TV is left for the hangar.
      tvView.nudge(menuStepNow(), backPressed(backSources, BACK_KEYS_ALL))
    }
    // ── DEV-441b: the letter plate, in two axes ─────────────────────────
    //
    // The stick (and a headset's D-pad) as the rows' own edge-detected nudge,
    // across as well as down; the arrow keys and the typed keys as they came,
    // in order (the capture listener in the title block). Not the keyboard's
    // `menuPitch`: W and S are letters of the code here, not a direction.
    if (codeUp()) {
      const stick = mergeActions(pad, xr.actions, thumbs)
      const step = codeStickStep(stick.pitch, stick.roll, appSettings.comfort.invertPitch)
      const dRow = step.dRow !== 0 ? step.dRow : xr.menuStep
      const moving = step.dCol !== 0 || dRow !== 0
      if (codeNudgeEdge.step(moving))
        letterPlate.codeAim = codeKeyStep(letterPlate.codeAim, step.dCol, dRow)
      for (const k of codeKeysDown) {
        const arrow = codeArrowStep(k)
        const key = arrow ? null : codeKeyForKeyboard(k)
        if (arrow) letterPlate.codeAim = codeKeyStep(letterPlate.codeAim, arrow.dCol, arrow.dRow)
        else if (key) {
          codePress(CODE_KEYS.indexOf(key))
          // DEV-632: a keyboard that TYPES joins with Enter: a typed character
          // leaves the aim on JOIN (pressed early, a part code does nothing),
          // where it was the key the arrows left, which Enter typed again.
          if (key.char !== null && codeUp()) letterPlate.codeAim = codeKeyIndex(CODE_ACTION.join)
        }
      }
    }
    codeKeysDown.length = 0
    // ── DEV-441: B (a pad's, a headset's) or Backspace turns BACK ─────────
    //
    // A accepts, B backs out (DEV-207's convention): off the letter plate, back
    // to the hangar's Multiplayer step (DEV-558: the title has no pages to back
    // out of any more). The plate's own BACK key is the way a head, a finger or
    // a mouse goes back. Backspace reaches here only off the letter plate,
    // which types with it.
    const titleBack = backPressed(backSources, BACK_KEYS_BACKSPACE)
    // DEV-605: read before this press can close the plate, so the hangar's
    // back below does not take the same press a second time.
    const codeWasUp = codeUp()
    const titleBackPressed = titleBackKey.step(titleBack)
    if (codeUp() && titleBackPressed && letterPlate.codeJoining === null) {
      codeClosePlate()
      audio.event({ type: 'ui.back' })
    }

    // ── DEV-605: the same press goes back a STEP in the hangar ─────────
    //
    // `hangar.goBack()` has existed since the room had steps, for exactly this
    // (`render/hangar.ts`: "bind goBack() to B ... nothing yet binds"), and the
    // only way back was the small plate on the floor, aimed with the look. The
    // 2026-10-03 persona playtest could not reach it with the keyboard at all.
    // Escape too, while the mouse is free: a captured Escape is the browser's.
    // Not while anything else owns the press: the letter plate (above), the
    // room's lobby, the editor (its desk or its bench), a focused course or a load.
    const hangarBack = backPressed(backSources, BACK_KEYS_ALL)
    const hangarBackPressed = hangarBackKey.step(hangarBack)
    // DEV-857: the OPTIONS plate takes the press first: one page up, then the hangar.
    const optionsWasUp = optionsPlate.up()
    if (optionsWasUp && hangarBackPressed) optionsPlate.back()
    if (
      hangarBackPressed &&
      !optionsWasUp &&
      router.screen === 'menu' &&
      ctx.hangar !== null &&
      ctx.hangar.focused === null &&
      !pause.paused &&
      !codeWasUp &&
      !lobbyUp() &&
      !tvActive() &&
      !editorHost.benchUp &&
      !editorHost.editing &&
      !loadingScene.shown
    ) {
      const before = ctx.hangar.view
      ctx.hangar.goBack()
      if (ctx.hangar.view !== before) audio.event({ type: 'ui.back' })
    }
    // DEV-859: and one page up in the OPTIONS pages while they are on the title's plate.
    if (hangarBackPressed && router.screen === 'title' && titleMenuUp() && menus.options.up) {
      const aim = menus.options.back()
      if (aim !== null) ctx.titleAim = aim
    }

    // ── B backs out of the plate (DEV-207, landed as `d680cd3`) ────────
    //
    // Xbox convention, which Matt asked for by name: A accepts, B cancels. Read
    // ONLY while the plate is up, which is what lets it share index 5 on the
    // right hand with the brake — a paused run is handed `noActions()` above,
    // so the brake is not read in the same frame and cannot be.
    //
    // It exists because the alternative is a trap. With the D-pad opening the
    // plate and not closing it, the only way out would be to select the RESUME
    // row; a player who cannot work the rows — which is every player in a
    // headset until the gaze picker is fixed — would be stuck inside the fix
    // for being stuck. `pauseBackKey` edge-detects for the usual reason.
    //
    // **This runs BEFORE the latch below, and the order is load-bearing.** If B
    // closes the plate this frame, `confirmNow()` reports unpaused, so
    // `confirmArmed` is false and `take(false)` SPENDS the latch without
    // delivering it — a trigger pulled in the same frame as B is swallowed
    // rather than arriving at whatever is underneath. That is the safe side,
    // and it is the reason `take` clears whether or not it was armed.
    //
    // DEV-621: and B goes BACK one page first (a pad's B as well as a
    // headset's); only on the root plate does it resume.
    const pauseBack = backPressed(backSources)
    const pauseBackPressed = pauseBackKey.step(pauseBack)
    if (pause.paused && pauseBackPressed && !pausePageBack()) {
      pause.paused = false
      closePausePages()
      audio.event({ type: 'ui.confirm' })
    }

    // ── the primary action, which is the only button a session is promised ──
    //
    // DEV-205. `xr.confirm` is right-hand `xr-standard` button **4**, and only
    // `buttons[0]` is REQUIRED by the spec — indices >= 4 are not reserved at
    // all. `select` fires on every WebXR device whatever the profile, so the
    // trigger commits too. `input/xr-select.ts` has the argument.
    //
    // (The Frame's controllers DO report index 4 — SteamVR advertises them as
    // `oculus-touch`, whose profile has that slot. This is defence against the
    // profiles we have not met, not the cure for the one we have; the row says
    // so, and says that it took four retracted premises to find out.)
    //
    // Armed off `confirmArmed`, which is the SAME branch list the touch chip's
    // label reads — *"is a confirm meaningful right now"*, answered once. A
    // third copy of those branches lived here for an afternoon and was wrong
    // about two of them; `input/confirm.ts` says what that cost.
    //
    // TWO LINES, NOT ONE, and deliberately: `take()` has to run on EVERY frame
    // to spend the latch, so it cannot go inline in the `||` chain below, where
    // short-circuiting would skip it on any frame another device already said
    // yes and deliver that select one frame late.
    xrSelect.follow(render.renderer.xr.getSession())
    const xrSelected = xrSelect.take(confirmArmed(confirmNow()))
    // ── a finger is a third aimer for the plate's one picker (DEV-291) ───
    //
    // Matt: *"mobile menu should work w/ tap"*. The plate is a canvas texture
    // on a quad in the world, so there is no element to press — but there IS
    // already a ray-to-row function, `flight.pause.pick`, which the head aims
    // in a headset and the nose aims on a flat screen. A tap is a third thing
    // to aim it with, and reusing it rather than writing a hit test beside it
    // is what keeps "what you look at" and "what you hit" from drifting apart
    // (`render/pause.ts`'s `rowTopM` makes the same argument about the
    // painter).
    //
    // The tap is CONSUMED whether or not it lands on a row: a miss is a
    // decision — you tapped the sky beside the plate — and leaving it in the
    // buffer would pick a row the moment the camera drifted under it.
    //
    // **The ray comes off the camera's LAST RENDERED pose**, one frame old,
    // because the placement runs ~1,200 lines below this. That is the same
    // frame `pauseAim` has always been read on — the gaze pick writes it from
    // inside the render block and the press below reads it here on the NEXT
    // frame — and while the plate is up the sim is frozen, so the camera the
    // finger aimed at and the camera this ray leaves is the same camera. It
    // would not be true of a tap during flight, and there is none: `menu` is
    // `paused`.
    const tap = pause.paused && handles.flight ? touch.readMenuTap() : null
    let tappedRow = false
    if (tap !== null && handles.flight !== null) {
      const rect = canvas.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        _tapNdc.set(
          ((tap.x - rect.left) / rect.width) * 2 - 1,
          -((tap.y - rect.top) / rect.height) * 2 + 1,
        )
        _tapRay.setFromCamera(_tapNdc, render.camera)
        const hit = handles.flight.pause.pick(
          _tapRay.ray.origin,
          _tapRay.ray.direction,
          pausePlate().rows.length,
        )
        if (hit >= 0) {
          pause.pauseAim = hit
          tappedRow = true
        }
      }
    }
    // ── and a MOUSE is a fifth aimer, with no hit test of its own (DEV-301) ─
    //
    // Matt asked for three things — a click should proceed from the title, work
    // on the in-game menus, and pick a holotable — and they are one change, not
    // three, because the aiming already exists on every screen: the gaze picks
    // the pause row, the nose pointer picks the holotable, and the title screen
    // has one action and nothing to aim at. So a click is not a cursor the game
    // has to draw. **It is a fifth way to say "yes, that one"**, and it rides
    // the same `confirm` as A, Enter, the XR trigger and a finger — which is
    // what keeps what-you-look-at and what-you-hit from drifting apart.
    //
    // `readClick` is where the pointer-lock rule lives, and it is the whole
    // design: the click that CAPTURES the pointer is spent on the capture, so
    // clicking the canvas for focus still presses nothing, and every click
    // after it selects. Nothing here weakens the capture and there is no
    // under-test switch; the game a spec drives is the game a player plays.
    //
    // Bound to a name and spent every frame for the reason `xrSelect.take` is:
    // `||` short-circuits, and a latch that survives the frame another device
    // said yes on is delivered late, against whatever screen that yes moved to.
    // DEV-616: on TV a plain click does nothing. With no capture to spend it
    // on, it would otherwise be the confirm (the next racer, or a launch under
    // a bare exhibition), and a press on a name in the lower third (the panel's
    // own pick) would be two presses at once. A drag orbits; the keys press.
    const mouseClicked = mouseLook.readClick() && !watching
    // ── DEV-563 follow-up: a free cursor on the pause plate ─────────────
    //
    // Matt: after Escape the cursor is free over the plate, so a row under it
    // is selected by moving onto it and pressed by a click, the title's cursor
    // model (DEV-418) on the plate's own picker. The click reaches here only
    // when it landed on a row (`setCursorTarget`'s `'pause'` slot; anywhere
    // else it was the capture), and `mouseClicked` rides `confirm` below, so
    // this only decides WHICH row. A captured click has no point on the glass
    // (`titleClickAt` is null for it) and presses what the gaze picked, as
    // before. The hover is spent every frame and acts only on a move, so a
    // still mouse never fights the arrow keys.
    const hoverAt = mouseLook.readHover()
    // DEV-572: and where it stands, for the menus' reticle.
    if (hoverAt) menuReticleHost.menuCursor = hoverAt
    if (mouseLook.locked) menuReticleHost.menuCursor = null
    // DEV-884: a turn of the view (the keys, a stick) hands the room's aim back to
    // the nose: the hangar's hover follows a FREE cursor only while the cursor is
    // the thing moving, so an A or D turn is not fought by a still mouse.
    if (look.yaw !== 0 || look.pitch !== 0) menuReticleHost.menuCursor = null
    if (mouseLook.locked) menus.pauseCursorAim = false
    else if (pause.paused && handles.flight !== null && !presenting) {
      const at = mouseClicked ? (ctx.titleClickAt ?? hoverAt) : hoverAt
      const hit = at === null ? -1 : pauseRowAt(at.x, at.y)
      if (hit >= 0) {
        pause.pauseAim = hit
        menus.pauseCursorAim = true
      }
    }
    // DEV-882: the hangar's OPTIONS plate, under a free cursor: the pause plate's
    // reading. A hover aims the row it moves onto (and only a MOVE does, so a
    // still mouse never fights the arrow keys); a click on a row aims it and
    // rides `confirm` below, as the title's rows and the pause plate's do.
    if (optionsPlate.up() && !presenting) {
      if (mouseLook.locked) menus.pauseCursorAim = false
      else {
        const at = mouseClicked ? (ctx.titleClickAt ?? hoverAt) : hoverAt
        const hit = at === null ? -1 : optionsPlate.rowAt(at.x, at.y)
        if (hit >= 0) {
          optionsPlate.aimAt(hit)
          menus.pauseCursorAim = true
        }
      }
    }
    // ── a finger or a cursor on the title's rows (DEV-353) ──────────────
    //
    // Both are a point on the glass, so both become a ray through the camera
    // and ask the plate's own `pick` — DEV-291's tap, with the cursor as a
    // second thing to aim it (see `titleClickAt`). A TAP that lands on a row is
    // a press of that row, as it is on the pause plate; a tap beside the plate
    // is spent and does nothing. A CLICK is already a press — `mouseClicked`
    // rides `confirm` below — so one from the cursor only decides WHICH row.
    //
    // Since DEV-418 a cursor click reaches here only when it landed ON a row
    // (off a row it was the capture, and pressed nothing). A click from the
    // captured mouse has no point on the glass (`titleClickAt` is null for it):
    // it presses what the nose picked, or the highlighted row if the nose is on
    // none — exactly what A does.
    let titleTapped = false
    /** DEV-884: this frame's press is a finger's tap or a free cursor's click on the room. */
    let roomPointPress = false
    if ((titleMenuUp() && handles.titleMenu !== null) || codeUp()) {
      const tapped = touch.readMenuTap()
      const at = tapped ?? (mouseClicked && !presenting ? ctx.titleClickAt : null)
      const hit = at === null ? -1 : titleRowAt(at.x, at.y)
      if (hit >= 0) {
        // DEV-441b: a key of the letter plate, while it is up (in the hangar
        // since DEV-558); else a row of the title.
        if (codeUp()) letterPlate.codeAim = hit
        else ctx.titleAim = hit
        titleTapped = tapped !== null
      }
    }
    // DEV-480
    if (tvView.plateUp()) {
      const tapped = touch.readMenuTap()
      const at = tapped ?? (mouseClicked && !presenting ? ctx.titleClickAt : null)
      if (at !== null && tvView.tap(at.x, at.y)) titleTapped = tapped !== null
    }
    // DEV-604: a finger's tap on the hangar's glass aims the room through it,
    // and presses what it lands on, as a tap on the title's rows does.
    if (roomTakesPoints()) {
      const tapped = touch.readMenuTap()
      if (tapped !== null && roomPointAim(tapped.x, tapped.y)) {
        titleTapped = true
        roomPointPress = true
      }
    }
    // DEV-607: a row of the room's lobby, tapped: the press its SELECT was.
    if (lobbyUp()) {
      const tapped = touch.readMenuTap()
      const ray =
        tapped === null || !roomLobby.lobbyPlate?.object.visible
          ? null
          : glassRay(tapped.x, tapped.y)
      const hit =
        ray === null
          ? -1
          : (roomLobby.lobbyPlate?.pick(ray.origin, ray.direction, roomLobby.lobbyRows.length) ??
            -1)
      if (hit >= 0) {
        roomLobby.lobbyAim = hit
        titleTapped = true
      }
    }
    // DEV-857: a row of the OPTIONS plate, tapped: the press its SELECT was.
    if (optionsPlate.up()) {
      const tapped = touch.readMenuTap()
      const ray = tapped === null ? null : glassRay(tapped.x, tapped.y)
      const hit = ray === null ? -1 : optionsPlate.pick(ray.origin, ray.direction)
      if (hit >= 0) {
        optionsPlate.aimAt(hit)
        titleTapped = true
      }
    }
    // DEV-571: the questions after a lap. A cursor CLICK on a row rides
    // `confirm` already; this decides which row (the hover put it there).
    if (lapAskUp()) {
      const tapped = touch.readMenuTap()
      const clicked = mouseClicked && !presenting ? ctx.titleClickAt : null
      if (askPointer(tapped, tapped ? null : (clicked ?? hoverAt))) titleTapped = true
    }
    // DEV-607: on the pad and on a results panel with no menu under it, a tap
    // on the glass is the press: LAUNCH and CONTINUE, without the button.
    if (glassConfirms() && touch.readMenuTap() !== null) titleTapped = true
    // ── and the pull that MOVES the laser is spent on moving it (DEV-321) ──
    //
    // `sense` is the pointer's frame boundary: it reads both hands' poses and
    // puts the beam away, so only a menu that aims with it below shows it
    // again. `take` spends the pulls every frame, and says whether one of them
    // was the OTHER hand's trigger taking the laser — which must not also
    // confirm, or it would commit whatever the first hand was resting on.
    // Bound to names for `xrSelect.take`'s reason: an `||` would skip them.
    xrPointer.sense(render.renderer.xr)
    pointerArbiter.follow(render.renderer.xr.getSession())
    const pointerTookPull = pointerArbiter.take(pointerWanted(), xrPointer.posed)
    const xrCommitted = xrSelected && !pointerTookPull
    const confirm =
      xr.confirm ||
      xrCommitted ||
      gamepadConfirm() ||
      keyboard.confirm ||
      touch.confirm ||
      // One tap SELECTS, which is what every menu on a phone does and what
      // Matt asked for. It rides the same `confirm` the other four devices
      // ride rather than calling the activation ladder itself — that ladder is
      // twelve branches deep and a second caller of it is a second copy of the
      // decision about which page owns the press.
      tappedRow ||
      titleTapped ||
      // In a session there is no mouse to click with and no cursor to see, so
      // a stray press on the mirrored desktop window is nobody's gesture.
      (mouseClicked && !presenting)
    // DEV-611: nothing presses through the splash. While it is up every press
    // reads as one ALREADY held, so no edge fires; the `step` right after still
    // records the real down state, so the press that skipped the splash is not
    // a fresh edge when it goes either, and does not press the title row
    // underneath. The step runs on every frame, here, before the handler: the
    // handler used to record the state itself at its far end, ~400 lines on.
    if (splash?.covering()) confirmKey.hold()
    const confirmPressed = confirmKey.step(confirm)
    // ── `flight` gates the MISSION's presses, not the menu's (DEV-281) ────
    //
    // It used to gate all of them, which was a true reading of a build where
    // the ship existed from boot: the only reason to press anything before the
    // world landed was to press it twice. It is not true now — boot into the
    // title screen builds no ship — and unchanged it would have made A do
    // nothing on the two screens that exist to get you to one, which is the
    // whole route in.
    //
    // `screen !== 'mission'` rather than a null-check per branch: everything
    // below that touches the ship is inside `paused` or a mission branch, and
    // `paused` cannot be set without a flight (`wantPause && ... && flight`).
    //
    // DEV-557: and any press is the page's first one, if nothing was before.
    // A key, a click or a touch reached `reveal()` in `main.ts` already, inside
    // the event; what arrives here first is a GAMEPAD's press (or a headset
    // controller's), which the browser grants no user activation for. So a
    // pad-only player's `?tv` or `?watch=` link still boards, and the resume
    // below is asked for; the browser may keep the sound off until a key, a
    // click or a touch, which is the most a page can do about it.
    if (confirmPressed) ctx.cardLifted = true
    if (confirmPressed && (handles.flight || router.screen !== 'mission')) {
      // EVERY gesture, not just the first: a context can be suspended again by
      // the browser at any point (a background tab, a headset taken off), and
      // `resume()` is idempotent and cheap.
      void audio.resume().then(() => {
        // The only way, from outside the page, to tell "sound is wired and the
        // device started" from "sound is wired and silent". Everything else in
        // the audio layer is unit-tested in node with no `AudioContext`, so
        // this one attribute is what an e2e spec has to work with — and a
        // wiring bug is exactly the class of bug those 85 unit tests cannot
        // see. Same `data-` convention as `terrain-ready`.
        document.body.dataset.audio = audio.running ? 'running' : 'silent'
      })
      audio.event({ type: 'ui.confirm' })
      if (router.screen === 'title') {
        // Press A to start. 2016 loads `setGameplayOptions` here; FF2 walks
        // down the shaft to the same room. Before the valley is in there is no
        // menu up and the press does what it always did: the hangar.
        //
        // DEV-558: the title is START and ENTER VR (Matt, 2026-10-01: *"Clicking
        // either should take us to the Hangar"*), and a link's row above them
        // when a link brought the page here. Everything else is the hangar's
        // first step. No row flips the edition (DEV-451): the hangar wears
        // Anniversary, and a mission's LOOK goes on at the black into its
        // loading scene.
        const row = titleMenuUp() ? titleRows()[ctx.titleAim]?.id : undefined
        if (titleMenuUp() && menus.options.up) {
          // DEV-859: the OPTIONS pages are on the title's plate, and a press
          // belongs to them (`menus.options` is the pause plate's entry point).
          const took = menus.options.press(ctx.titleAim, frameT0)
          ctx.titleAim = took.aim
          if (took.recenter) recenterXr(render.renderer, xrFrame)
        } else if (
          ctx.quickRaceAsked ||
          playerCourseHost.playerCourseAsked ||
          tvView.asked() ||
          router.pendingScreen !== null
        ) {
          // Taken: that door is already open, and on its way out of the title.
        } else if (tvView.linkWaiting() || watchLinkWaiting()) {
          // DEV-557: a `?tv` or `?watch=` link waits for the page's first
          // press, and this is it. Until DEV-557 that press was the landing
          // card's Start, which reached no row; the link boards later in this
          // frame (`watchFrame`, `tvView.frame`), so the press does not ALSO
          // open a door on the title the link is about to leave.
        } else if (row === ENTER_VR_ROW_ID) {
          // DEV-557's ENTER VR (or CONNECT VR HEADSET, which asks again). The
          // session, when it starts, goes on to the hangar (`titleVrToHangar`).
          titleMenuHost.titleVrToHangar = true
          titleVr.press()
        } else if (row === OPTIONS_ROW_ID) {
          // DEV-859: OPTIONS, the same page the pause plate has, on this plate.
          ctx.titleAim = menus.options.open('to the title')
          titleOptionsOpen = true
        } else if (row === MAKING_OF_ROW_ID) {
          // DEV-802: the making-of site, in this tab (a page of this origin,
          // not a destination to come back from in a second window).
          globalThis.location.assign(MAKING_OF_PATH)
        } else if (row === NEWSLETTER_ROW_ID) {
          // DEV-658: the signup page in a new tab; the title stays where it
          // is. A press is polled here, after its event, which Chrome allows
          // (a click's activation lasts a few seconds) and a pad's press is
          // not (it grants none): then the row says to click instead.
          const tab = globalThis.open(NEWSLETTER_URL, '_blank')
          if (tab) tab.opener = null
          titleMenuHost.newsletterBlocked = tab === null
        } else if (titleCoursePress(row)) {
          // DEV-467: a shared course's row (DEV-558: on the title itself).
        } else if (row === QUICK_RACE_ROW_ID) {
          // DEV-373: a shared lap's RACE THIS LAP. Flying anything else is
          // leaving a room a link joined (DEV-389).
          roomClose()
          startQuickRace()
        } else if (row === WATCH_LAP_ROW_ID && results.linkGhost) {
          // DEV-571: WATCH THIS LAP, TV's lap show, which leaves any room too.
          tvView.boardLap(results.linkGhost.id)
          stats.count('tvWatched')
        } else {
          // START, and a press before the rows are up: the hangar's first
          // step. A room a link joined stays joined, and its lobby is there.
          goToTheHangar('title: starting')
        }
      } else if (router.screen === 'menu') {
        // ── selecting the mission ───────────────────────────────────────
        //
        // Only with the NOSE POINTER on the table. Matt: *"selection was 'nose
        // pointer' based, so where the user looked was the 'hovered over'
        // item."* A press with the pointer somewhere else does nothing — which
        // is what makes it a menu rather than a single button wearing a room,
        // and it is the behaviour a second holotable will need on the day M6
        // puts one there.
        //
        // 2016 loads a scene at this point; FF2 has one mission and one
        // environment already in memory, so "boarding" is a change of where the
        // eye is. The launch state machine has not started, and the NEXT press
        // is the one that calls the lift — two steps, as in 2016: the holotable
        // picks the mission, then `panel_Startup` waits on the pad.
        // `choose()` returns the card under the nose pointer, or null — which
        // is both "you were on a page plate" (it turned the page itself) and
        // "you were pointing at nothing", and both mean do not board. A press
        // with nothing under the gaze doing nothing is the difference between a
        // menu and a trap.
        // A plate that takes the press suppresses `choose()` rather than
        // returning early: this whole block is inline in the frame callback, so
        // a `return` here would skip `stepFixed` and the render, one dropped
        // frame per press. `picked === null` already means "do nothing" to
        // everything below.
        //
        // DEV-441b's letter plate before all of them: it takes the press while
        // it is up (in the hangar since DEV-558), and the room's tables are put
        // by under it. Inside this branch, not beside it, because a press on
        // the plate is still the hangar's select: `xr-select.test.ts` holds
        // this handler's own branches to `confirmMeans`'s, in order.
        const codeTook = codeUp()
        if (codeTook) codePress(letterPlate.codeAim)
        // DEV-389: in a room the LOBBY takes the press, and the tables are inert:
        // the room decides the course, so a press never boards a table's.
        const lobbyTook = !codeTook && lobbyUp()
        if (lobbyTook) lobbyPress()
        // DEV-857: the OPTIONS plate, the pause plate's page, takes the press while it is up.
        const optionsTook = !codeTook && !lobbyTook && optionsPlate.up()
        if (optionsTook)
          optionsPlate.press({
            recenter: () => recenterXr(render.renderer, xrFrame),
            nowMs: frameT0,
          })
        // DEV-492: the bench's door, or the bench itself, which reads its own buttons.
        const benchTook = !codeTook && !lobbyTook && !optionsTook && benchPress()
        // DEV-604: a click from the free cursor presses what is UNDER it: aimed
        // again here, so no head aim between the click and this press can move it.
        if (mouseClicked && !presenting && ctx.titleClickAt !== null && !codeTook)
          roomPointPress = roomPointAim(ctx.titleClickAt.x, ctx.titleClickAt.y) || roomPointPress
        // DEV-884: a click or a tap on a difficulty MARK picks it (aiming is picking)
        // and stops there: the route it draws is the answer, and the table's own
        // press boards. A, Enter and a laser's trigger press as they always did.
        const markOnly = roomPointPress && (ctx.hangar?.markAimed ?? false)
        const picked =
          codeTook || lobbyTook || optionsTook || benchTook || markOnly
            ? null
            : (ctx.hangar?.choose() ?? null)
        // ── DEV-382: the variant is chosen with the course ─────────────────
        //
        // The card carries whose records it showed, which is the variant the
        // room has open for that aircraft. Boarded, it is the one the flight
        // is built from, and on Anniversary it is remembered: the LAST FLOWN
        // table and Quick Race read it. Classic never writes it (§8), so its
        // stored Anniversary choice survives a round trip.
        //
        // Under a `?variant=` pin the pin flies, whatever table was pressed,
        // and nothing is written back (DEV-380; `flightVariantRequest`).
        const pickedVariant = picked?.variant ?? STANDARD_VARIANT_ID
        if (picked && editionState.current.gameplay.variants.enabled) {
          boardedVariant.set(picked.vehicle, pickedVariant)
          if (!variantPinned(picked.vehicle)) rememberVariant(picked.vehicle, pickedVariant)
        }
        // What the flight WILL be built from, which the pin may override.
        const willFly = picked
          ? variantPinned(picked.vehicle) && editionState.current.gameplay.variants.enabled
            ? (VARIANT_PARAM as string)
            : pickedVariant
          : pickedVariant
        // ── the first selection BUILDS, whichever card it lands on (DEV-281) ─
        //
        // `world === null` is the boot-into-the-title case: the island the
        // default card names has not been generated, so choosing that card is a
        // load and not a boarding, exactly as choosing any other one is. Two
        // conditions rather than one because they stay different afterwards —
        // once a world is up, re-picking the course you are already on must go
        // on being the cheap door.
        if (
          picked &&
          (ctx.world === null ||
            picked.id !== ctx.level.id ||
            // The same course in another variant is another machine: the
            // cheap door below would board the one already built.
            willFly !== (handles.flight?.variant ?? STANDARD_VARIANT_ID) ||
            // DEV-451: and one built under another edition is another world.
            appSettings.worldEdition !== missionEdition())
        ) {
          // ── A DIFFERENT MISSION IS A WHOLE-WORLD SWAP, IN PLACE ─────────
          //
          // It used to be `?mission=` and a document reload — which is what 2016
          // does, and which in a browser costs the gesture card, the audio
          // context and, in a headset, the immersive session itself. See
          // `switchMission`: the menu is its own scene, so the player stays in
          // the room while the world underneath it is replaced.
          console.info(
            ctx.world === null
              ? `level select: loading ${picked.id}`
              : `level select: ${ctx.level.id} -> ${picked.id}`,
          )
          audio.event({ type: 'ui.confirm' })
          void switchMission(picked.id)
        } else if (picked) {
          // 2016's own mission fade-in on the way in: this is the transition
          // `Cameras_gameplay.prefab`'s `fadeTime` was tuned for, and the only
          // one in the game that arrives somewhere rather than just leaving.
          audio.event({ type: 'mission.begin' })
          goToScreen('mission', {
            inSeconds: LOAD_FADE_SECONDS,
            act: () => console.info(`boarding: ${ctx.level.title}`),
          })
        }
      } else if (pause.paused) {
        // Gaze picked the row; A commits it. 2016's model exactly
        // (`Input_Look.cs:163`), and it is the same button on all three routes.
        // A SUB-PAGE owns the press while it is up, and its own BACK row is what
        // closes it — so a player who opens one by accident leaves the way they
        // came in rather than by hunting for RESUME.
        // Folded into the SAME chain rather than returning early: this is inline
        // in the frame callback, and a return here skips the sim step.
        //
        // The plate's own half of `onPage` is `pausePlate`'s answer rather than
        // a fourth copy of the ladder, and `chosen` then indexes the rows the
        // plate is DRAWING instead of a list built again beside it.
        const plate = pausePlate()
        // DEV-621, DEV-859: the OPTIONS pages are `menus.options`'s: a setting
        // that changes in place (MUTE and the rest, which persists and fans out
        // down the one path every setting uses; the plate stays up, because
        // muting is not a decision about the run), a door to a page, a page's
        // own rows and every BACK. The same entry point the title and the
        // hangar press, so there is one page and one set of rules.
        const took = menus.options.press(pause.pauseAim, frameT0)
        const chosen = took?.handled ? null : plate.rows[pause.pauseAim]?.id
        if (took?.handled) {
          pause.pauseAim = took.aim
          // Only the comfort page answers 'recenter'.
          if (took.recenter) recenterXr(render.renderer, xrFrame)
        } else if (chosen === 'perfcapture') {
          // The plate STAYS UP, like MUTE: starting or stopping a capture is
          // not a decision about the run, and a player who has just pressed it
          // wants to see the row change rather than be dropped back into a
          // flight to wonder whether it took.
          togglePerfCapture()
        } else if (chosen === 'entervr') {
          // DEV-557. Like EXIT VR: a decision about the DISPLAY, so the plate
          // stays up and the run keeps its place; the session's own
          // `sessionstart` puts the headset's look on (DEV-263).
          titleVr.press()
        } else if (chosen === 'exitvr') {
          // DEV-270. The plate stays up and the run keeps its place — this is a
          // decision about the DISPLAY, not about the flight, so it behaves like
          // MUTE rather than like EXIT. A player who takes the headset off
          // mid-run and finds the mission reset would have lost it to a button
          // that only claimed to change screens.
          //
          // `end()` is a promise and nothing awaits it deliberately: the browser
          // fires `sessionend` when it is done, and everything that has to
          // happen — `setImmersive(false)` putting the flat preset back
          // (DEV-263), the visibility read, three tearing the layer down — is
          // already hung off that event. Awaiting here would be a second path
          // to the same state, and the event is the one that also fires when
          // the player leaves through the system menu instead.
          //
          // Caught rather than floated: a session that has already ended
          // rejects, and an unhandled rejection in the pause handler would take
          // the frame down over a button that did nothing.
          void render.renderer.xr
            .getSession()
            ?.end()
            .catch((err: unknown) => {
              console.warn('exit VR: the session refused to end', err)
            })
        } else if (chosen === 'resume') pause.paused = false
        else if (chosen === 'restart') {
          pause.paused = false
          restartRun()
        } else if (chosen === 'skipstep') {
          // DEV-377. Back into the run, on the next step.
          pause.paused = false
          lessonHost.liveLesson?.skip()
        } else if (chosen === 'editor') {
          // DEV-469: Back to editor, with the lap as flown so far.
          // DEV-491: or, from a recording flight, with what it recorded.
          if (EDITOR_RECORD.level) editorRecordReturn()
          else editorReturn()
        } else if (chosen === 'exit') {
          stats.attemptEnd('quit', 'none')
          // Back to the chair. The run is RESET on the way out, not left
          // half-flown: 2016 exits by loading `main_menu`, which discards
          // everything, and a mission you return to mid-flight with a stopped
          // clock is a state no other path can produce.
          pause.paused = false
          audio.event({ type: 'ui.back' })
          // DEV-389: out of a room's race is out of it: the room hears `left`
          // now (protocol 3), and the hangar is the room's lobby again.
          if (roomCore.room && roomCore.room.session.roomPhase !== 'lobby') {
            roomCore.room.session.forfeit()
            console.info('room: exit forfeits the race')
          }
          goToScreen('menu', {
            act: () => {
              restartRun()
              // The bests on the tables were read when the index loaded, so a
              // run you have just flown is not on the table you flew it from —
              // and on the maps step that is a whole place's count, not one
              // line.
              ctx.hangar?.refresh()
              console.info('exit: back to the hangar')
            },
          })
        }
        // A press with nothing under the gaze does nothing, deliberately: it is
        // the difference between a menu and a trap.
      } else if (run.lastResult) {
        // DEV-406: after a run, A goes HOME. Matt, 2026-09-25: *"take me back
        // to the hangar when i press A (not start a new race)"*. The finished
        // check still comes first, so a press here never launches the ship you
        // are already flying. Another go is the pause button (above), and
        // "race this lap" is Y or R. The run is RESET on the way out, exactly
        // as the pause menu's EXIT does it.
        // DEV-469: and after a playtest, home is the editor, with the lap.
        // DEV-571: where the menu under the panel is up, A presses its aimed
        // row; its last row (where it opens) is home, which is this branch.
        if (lapAskUp() && askConfirm()) {
          // A question's row took the press.
        } else if (EDITOR_RUN.request) editorReturn()
        else {
          audio.event({ type: 'ui.back' })
          goToScreen('menu', {
            act: () => {
              restartRun()
              // The time you just set belongs on the table you launched from —
              // see `HangarArt.refresh`.
              ctx.hangar?.refresh()
              console.info('results: back to the hangar')
            },
          })
        }
      } else {
        // Spends the ride itself, and only if this press is what started it —
        // so the first launch of a world build climbs and every retry after it
        // starts at the top. DEV-094. Its sound is `audioLaunch`'s, off the
        // phase leaving `'waiting'` — not this press, which repeats (DEV-424).
        // DEV-436: a viewer has no ship to launch; the press follows the next
        // racer instead. Inside this branch, so the handler's chain stays the
        // one `xr-select.test.ts` mirrors (a viewer's press is a launch press's).
        // DEV-480
        if (tvActive()) tvView.confirm()
        else if (roomCore.watch) {
          roomWatch.watchTarget++
          roomWatch.watchEyeSet = false
        } else beginLaunch()
      }
    }

    // ── "race this lap" (DEV-371) ────────────────────────────────────────
    //
    // The results panel's third press: another go, with the lap you just flew
    // as the ghost, best or not (PLAYER-GHOSTS §4.2, door 1). R, a pad's Y, or
    // the right stick's click in a headset (`input/xr.ts` says why that one).
    // Only while the panel is up and only when this run left a lap, which is
    // exactly when the panel offers it; anywhere else the three do nothing.
    //
    // DEV-371 follow-up: and a fourth, the touch overlay's RACE THIS LAP chip,
    // offered on exactly `raceLapOffered()` (the context below reads it too),
    // so the chip is there when this branch would act and nowhere else.
    const wantRaceLap = keyboard.raceLap || gamepadRaceLap() || xr.raceLap || touch.raceLap
    // DEV-467: a player course's panel takes Share's button, and the race
    // button while it asks COPY LINK or SAVE FILE (`coursePanelPresses`); a
    // race press it took is not also "race this lap".
    const courseTookRace = coursePanelPresses(
      keyboard.shareLap || gamepadShareLap() || xr.shareLap,
      wantRaceLap,
    )
    const racePress = raceLapKey.step(wantRaceLap) && !courseTookRace
    if (racePress && raceLapOffered()) {
      void audio.resume()
      // DEV-571: always "race this lap". The other names this press had (another
      // name, DEV-373; keep it, DEV-374) are rows of the menu under the panel.
      restartRun({ raceLap: true })
      console.info('results: race this lap')
    }
    // DEV-373: on a course card in the hangar, the same press moves the card's
    // ghost line on: your best, world #1, the lap above yours, none.
    if (
      racePress &&
      router.screen === 'menu' &&
      !pause.paused &&
      ctx.hangar?.aim?.kind === 'mission'
    ) {
      cycleGhost(ctx.hangar.aim.mission)
    }

    // ── "share this lap" (DEV-373), retired by DEV-571 ───────────────────
    //
    // G, a pad's SELECT and the LEFT stick's click in a headset posted a lap
    // on two presses. Posting is now a question on the results panel's own
    // menu (`game/lap-ask.ts`), answered with the menus' controls, so the
    // three buttons do nothing on a lap's panel. They still share a player
    // COURSE (`coursePanelPresses`, above).

    // ── a Quick Race does not wait on the pad (DEV-353) ──────────────────
    //
    // The press on the title was the launch press, so the countdown starts by
    // itself — once the fade into the cockpit has cleared, so the 3 is on a
    // screen you can read rather than under the curtain. `beginLaunch` is the
    // pad's own call, and with the ride already spent it starts the countdown
    // and nothing else. Once the ship is let go, the press-to-stick time is
    // written down and the Quick Race is over: it is an ordinary run from here,
    // and a retry is an ordinary retry.
    if (ctx.quickRace !== null) {
      if (
        !ctx.quickRace.launched &&
        router.screen === 'mission' &&
        handles.flight !== null &&
        !fade.busy &&
        ctx.level.id === ctx.quickRace.id
      ) {
        // DEV-890: on a phone the pad WAITS for the first touch, like every
        // other mission's does (a tap on the glass is the launch, and the dash
        // says so). The auto-launch is the Quick Race's own and has no 2016
        // original; with it, a phone's clock ran from GO to the first thumb.
        // The press that launches flips `launched` below, off the phase.
        if (confirmDevice() !== 'touch') {
          ctx.quickRace.launched = true
          // The sound follows the phase, in `audioLaunch` (DEV-424).
          beginLaunch()
        } else if (ctx.launch.phase !== 'waiting') {
          ctx.quickRace.launched = true
        }
      } else if (ctx.quickRace.launched && ctx.launch.phase === 'flying') {
        const ms = performance.now() - ctx.quickRace.pressedAt
        document.body.dataset.quickRaceMs = ms.toFixed(0)
        console.info(
          `quick race: stick in hand ${(ms / 1000).toFixed(1)} s after the press ` +
            `(${ctx.quickRace.id})`,
        )
        ctx.quickRace = null
      } else if (ctx.quickRace.launched && router.screen !== 'mission') {
        // Left before the release — EXIT from the pause plate mid-countdown.
        ctx.quickRace = null
      }
    }

    // `?snap=<seconds>` arrives HERE, at the pause's own argument, because it is
    // the pause with a different trigger and must not be a second way to stop
    // the sim (`boot/snap.ts`). Tested before the step, against the sim's own
    // clock, so the frame that freezes is the first frame at or past the mark.
    if (!run.snapped && shouldFreeze(mission.elapsed, SNAP_AT)) {
      run.snapped = true
      console.info(
        `snap: sim frozen at ${mission.elapsed.toFixed(4)} s (?snap=${SNAP_AT}) — still rendering`,
      )
    }

    // Paused freezes the SIM, not the frame: zero wall time in, so nothing
    // accumulates and no tick runs. Physics, the race clock, the AI racers and
    // the scoring all live under this call, so one argument stops all four
    // together and none of them can drift apart while the menu is up.
    //
    // And while a snap is PENDING, feed the stepper no more wall time than it
    // takes to reach the mark plus one step. A hitched frame — Playwright
    // running six browsers, a tab regaining focus — otherwise runs four or five
    // fixed steps past the mark in one call, which is where a same-tick pair
    // froze at 40.0526 s against a 40.05 s tolerance (both presets, identically,
    // so the pair was still a pair — but the spec said flaky). Bounded here to
    // under two steps whatever the frame did, which is what the tolerance in
    // `anniversary-ab.spec.ts` was written against. Not a different sim: the
    // same fixed steps, one frame's budget trimmed.
    const snapPending = SNAP_AT !== null && !run.snapped
    const stepSeconds =
      (pause.paused && !roomRaceLive()) || run.snapped // DEV-389: a room cannot pause
        ? 0
        : snapPending
          ? Math.min(frameSeconds, Math.max(0, SNAP_AT - mission.elapsed) + FIXED_DT)
          : frameSeconds
    // ── The sim bracket (VR-PERF §5.2, gap 5) ────────────────────────────
    //
    // Nothing has ever measured the fixed step. It is a ~600-line closure and
    // everything under it — physics, the racers, the scoring, the launch, the
    // traffic — is what "sim" MEANS here, so the bracket goes round the whole
    // `stepFixed` call rather than round any one part of it.
    //
    // The tick delta is taken as well as the time, because a frame that ran two
    // steps cost twice a frame that ran one and a millisecond figure alone
    // cannot tell those apart. `paused` and `?snap=` hand `stepFixed` zero wall
    // time, so both record 0 ticks and ~0 ms — recorded honestly rather than
    // skipped, since a frozen frame in a trace is still a frame that was drawn.
    roomFrame(time) // DEV-388
    watchFrame() // DEV-436
    tvView.frame() // DEV-480
    const tickBefore = clock.tick
    const simT0 = performance.now()
    const alpha = stepFixed(clock, stepSeconds, (dt) => {
      run.elapsed += dt
      if (!handles.flight) return
      // DEV-371: D30's runTainted, the autopilot's half. At ANY tick of the
      // run, the ride included: a lap the autopilot touched is not a lap the
      // player flew, and nothing downstream can tell which ticks it flew.
      // DEV-601: and the run's, which every mode has (a lap run is a race's).
      if (pilot.autopilot) {
        handles.lapRun?.taintRun('autopilot')
        mission.autopilotFlew = true
      }

      // ── DEV-146: the other mission's ships ──────────────────────────
      //
      // ABOVE the lift's early return, and that is the one decision in this
      // wiring. The grid below does NOT move until GO — five racers leaving
      // their pads is the start of YOUR race and it waits for you (DEV-125) —
      // but traffic is not in your race. It is the island having something
      // else going on, and a sky that stands still until the lift lets go is a
      // diorama. So it flies through the ride and the 3-2-1, on the same fixed
      // step and the same crash rule as everything else, and the player's SIM
      // position goes with it for one purpose only: how far away a ship is
      // before its finished lap is recycled.
      //
      // (`int_01_jumpSeat`, the one mission this is authored on today, spawns
      // `direct` with no lift at all, so the return below never fires there.
      // This is placed for the pairing that does have one rather than for the
      // one that does not.)
      handles.liveTraffic?.step(
        handles.autopilotTerrain,
        dt,
        handles.collisionTerrain,
        editionState.current.gameplay.crash,
        handles.flight.jet.body.position,
      )
      // DEV-613: the traffic across the bay goes into the sea like any racer.
      if (handles.liveTraffic) {
        for (const ship of handles.liveTraffic.racers) {
          const c = ship.ground.collision
          splashCraft(`traffic ${ship.spec.id}`, ship.jet.body, c.struck, c.impactSpeed, dt)
        }
      }
      // DEV-377: the lesson, also above the lift's return — step 0 is the launch.
      tickLesson(dt, actions)

      // DEV-483: TV's exhibition owns the step — the racers on its own GO, and
      // nothing below: no lift, no flight, no mission, no lap.
      if (exhibitionTick(dt)) return

      // The ride, and the countdown after it. Both run on the fixed step so the
      // opening is identical on every machine, which is what makes the ghost
      // race comparable at all (D4).
      if (ctx.rideSpec && launchHoldsShip(ctx.launch)) {
        roomStepCountdown(dt) // DEV-389: a room's countdown starts on its step
        stepLaunch(ctx.launch, ctx.rideSpec, dt)
        audioLaunch()
        // DEV-424: the lift's motor follows the platform, off this step's rise.
        audio.stepLift({ rise: ctx.launch.rise })
        // The ship is kinematic and attached to the platform, exactly as
        // `LaunchElevator.StartLaunch()` leaves it. No flight, no scoring, no
        // clock — so nothing below this line runs.
        // DEV-477: in a room, the lift holds the ship at its start's own height.
        handles.flight.rideElevator(ctx.launch.rise + (roomCore.room ? roomCore.roomHeldLift : 0))
        handles.elevator?.setRise(ctx.launch.rise)
        return
      }

      // The lift has let go by the time we get here, so the GO beat belongs
      // on this side of the early return above.
      audioLaunch()
      // DEV-371: the release is tick 0 of the lap, BEFORE the first flight
      // step, where `mission.elapsed` reads 0. A no-op on every later tick.
      handles.lapRun?.release(handles.flight.jet.body, editionState.rules.id)

      // ── DEV-343: nothing of the run moves while you are not in it ────
      //
      // The early return above is the ONLY thing that holds a run, and it holds
      // a run with a lift. A mission with none — all six JumpSeat missions, whose
      // `spawn.launch` is null so `restingPhase` puts them at `flying` from the
      // first tick — was never held at all: in the hangar the seat ran its 7.5 s
      // `Trigger_EnableJumpShip` countdown, went live, fell onto its rig, and the
      // mission clock counted the whole time. Measured on `rookie_02_jumpSeat`:
      // 10.4 s on the clock after 10 idle seconds, and after Pause → Exit and 20 s
      // in the hangar, 24.1 s at re-boarding — the same-course door boards
      // without a `restartRun`, so the results time and the stored best carried
      // the menu. The HoverJet was immune only because its lift rests at
      // `waiting` and returns above.
      //
      // 2016 has no such state to copy: a JumpSeat scene loads with you in it,
      // and `Trigger_EnableJumpShip`'s T = 0 IS the load. The port's load is
      // boarding, so off the mission screen the run simply does not step — the
      // seat stays where the restart put it, and the countdown starts when you
      // arrive. Placed AFTER the lift's return, so a HoverJet in the hangar goes
      // through exactly the code it always did.
      if (router.screen !== 'mission') return

      // ── The autopilot decides on the FIXED STEP, like everything else ──
      //
      // It used to decide once per FRAME, and the same input was then applied to
      // however many sim steps that frame happened to contain — two on a slow
      // frame, none on a fast one. So the controller's effective rate rode the
      // frame rate, and a run was NOT reproducible: the same course produced a
      // stall at gate 6 one run and none the next, which is why three sessions
      // of screenshots could not pin it down.
      //
      // The AI racers never had this — `stepAiRacer` calls the controller
      // itself, on the fixed step — and that asymmetry is the tell: they were
      // consistent while the player proxy was not, on the same code.
      //
      // CLAUDE.md rule 5: a decision that sees a frame delta is not a sim
      // decision. This one was, and it was the player's.
      // ── two vehicles, two controllers ───────────────────────────────
      //
      // `sim/autopilot.ts` commands a vehicle that thrusts along body +Z. The
      // JumpSeat thrusts along body +Y, so pointed at it the HoverJet's
      // controller flies it into the nearest hillside — which is exactly what
      // `?autopilot=1` did on all six JumpSeat missions until now, and why
      // Target Practice had never been played. `jumpSeatAutopilotOf` returns
      // null on a HoverJet, so the branch below is untouched on seven of
      // thirteen missions.
      //
      // Both are stepped ONCE PER FIXED STEP, inside this loop. DEV-027.
      const jumpSeatPilot = pilot.autopilot ? jumpSeatAutopilotOf(handles.flight) : null
      // DEV-399: and a third. The glider's pilot spends HEIGHT, which neither
      // controller above can — pointed at a gate below it, the HoverJet's
      // arrives at 170 m/s with nothing left, and at one above, it stalls.
      // Null on every other aircraft, so the two branches are untouched.
      const gliderPilot = pilot.autopilot ? gliderAutopilotOf(handles.flight) : null
      if (jumpSeatPilot) {
        actions = jumpSeatPilot.step(mission.targets.padTaken)
      } else if (gliderPilot) {
        // The next ring, then the finish — the HoverJet branch's order, gate
        // to gate: a glider course carries no authored line to follow.
        const next = nextGate(mission.course.gates, mission.course.passed)
        const aim =
          next >= 0
            ? (mission.course.gates[next]?.centre ?? null)
            : mission.finishGate && !mission.finishCrossed
              ? mission.finishGate
              : null
        if (aim) actions = gliderPilot.step(aim)
      } else if (pilot.autopilot) {
        const target = nextGate(mission.course.gates, mission.course.passed)
        // After the last ring, aim at the FINISH GATE — the same synthetic gate
        // `stepAiRacer` flies home to, and for the same reason. `nextGate`
        // returns -1 once every ring is taken, which used to be the end of the
        // run; since DEV-045 it is not, and the autopilot was left with no
        // target for the last 234.6 m. It still got there, by flying straight
        // until it blundered into a 68 m sphere, and the lap spec's wall clock
        // went from 1.4 min to 3.2 min saying so.
        const finishGate =
          target < 0 && mission.finishGate && !mission.finishCrossed
            ? {
                centre: {
                  x: mission.finishGate.x,
                  y: mission.finishGate.y,
                  z: mission.finishGate.z,
                },
                radius: mission.finishGate.radius,
                points: 0,
                triggerOnce: true,
              }
            : null
        const gate = target >= 0 ? mission.course.gates[target] : finishGate
        // The authored line stops at the last ring, so the run home is flown
        // gate-to-gate: asking `routeGuidance` for a point past the end of its
        // own spline measures nothing.
        const onCourse = target >= 0
        if (gate) {
          // Follow the LINE where there is one. Aiming at a gate centre makes
          // the ship fly straight segments between rings and overshoot every
          // corner — which is the 186 m/s overshoot that put it into a hillside
          // at gate 6. A lookahead sliding along the spline corners because the
          // target corners, and being NEAR the line is better evidence of safe
          // air than a terrain probe: 23 % of the authored line sits below this
          // controller's own `minClearance`.
          let aim = gate.centre
          let offset = Number.POSITIVE_INFINITY
          // What corner braking compares against: the next RING when aiming
          // gate to gate, a point further along the LINE when following it.
          // The last ring's is the finish, and the run home has none: past the
          // last ring `target` is -1, and `gates[target + 1]` was RING 0, a
          // hairpin braked for in the last 1.7 s of every lap (DEV-394).
          let cornerRef: { x: number; y: number; z: number } | null =
            target >= 0
              ? (mission.course.gates[target + 1]?.centre ?? mission.finishGate ?? null)
              : null
          let profileSpeed = Number.POSITIVE_INFINITY
          // DEV-394: and the run HOME on the line too, where the line runs
          // through the finish (`routeArcThrough`) — a finish off the last
          // leg's bearing is otherwise flown at straight, across the line's bend.
          const homeArc = onCourse ? Number.NaN : (ctx.guide?.finishArc ?? Number.NaN)
          if (ctx.guide && (onCourse || Number.isFinite(homeArc))) {
            // The profile tops out at THIS jet's speed (DEV-382 follow-up).
            profileGuideFor(ctx.guide, handles.flight.jet.sheet)
            const v = handles.flight.jet.body.velocity
            // DEV-524: the options are `playerRouteOptions`', the one list the
            // tests fly the player's proxy on — and since DEV-524 they carry
            // DEV-494's aim floor, so the player's autopilot rounds a hairpin
            // the way the racers do rather than parking half a lead short of it.
            const onLine = routeGuidance(
              ctx.guide.route,
              autoCursor,
              handles.flight.jet.body.position,
              playerRouteOptions(
                DEFAULT_AUTOPILOT,
                Math.hypot(v.x, v.y, v.z),
                onCourse ? (ctx.guide.gateArc[target] ?? Number.POSITIVE_INFINITY) : homeArc,
                gate.centre,
                autoBeyond,
              ),
              autoAim,
            )
            aim = autoAim
            // Off the line's help, the ground rule comes back.
            offset = onLine ? autoCursor.offset : Number.POSITIVE_INFINITY
            // And corner braking measures the LINE's bend rather than the next
            // ring, because `aim` is a point on the line and not a ring.
            if (onLine) cornerRef = autoBeyond
            // Look the profile up a little AHEAD, not underfoot: the point of a
            // backward-pass profile is that it tells you to slow before you
            // arrive, and reading it at the ship's own position throws that away.
            if (onLine) {
              profileSpeed = speedLimitAt(
                ctx.guide.route,
                autoCursor.s + Math.hypot(v.x, v.y, v.z) * DEFAULT_AUTOPILOT.profileLookSeconds,
              )
            }
          }
          autopilotActions(
            handles.flight.jet.body,
            aim,
            autoInput,
            DEFAULT_AUTOPILOT,
            // The ground. Without it the autopilot aims straight at gate centres
            // and, once the speed chain takes it past 280 m/s, flies through the
            // island — 62 terrain strikes in one lap, where the 2016 ghost's
            // closest approach over its whole run was 26 m.
            handles.autopilotTerrain,
            offset,
            cornerRef,
            profileSpeed,
            // DEV-394: the speed law holds its target in THIS jet's thrust.
            hoverJetOf(handles.flight),
          )
          // `HoverJetInput` is `FlightActions` without `airbrake`: the sim owns
          // that type and may not import the input layer's (CLAUDE.md rule 4).
          actions = { ...autoInput, airbrake: false }
        }
      }

      // ── Held where it hit (DEV-126) ─────────────────────────────────
      //
      // A crashed ship is not integrated, exactly as a ship on the lift is not:
      // the hold is the sim's own clock, run by `stepCrashAndBoundary` below,
      // and the curtain covers it. The stick is still read — `actions` above
      // is what the engine note and the lean are fed — it just moves nothing.
      // ── DEV-143: boost costs energy ─────────────────────────────────
      //
      // BEFORE `flight.step`, and it rewrites `actions.boost` rather than
      // reaching into the flight model: `sim/hoverjet.ts` asks one question of
      // the stick — *is boost held* — and the tank's answer is what the stick
      // means now. Doing it here means the thrust, the engine note (`boost:
      // actions.boost` below), the cockpit shake and the particle stages all
      // see the SAME boolean and cannot disagree about whether this tick was
      // boosted, which is what a second flag on the jet would have risked.
      //
      // HoverJet only — the JumpSeat's boost is analog and burns its own fuel.
      // Classic does not step it at all, so a Classic run is the shipped one
      // and the tank is still full if somebody flips the preset mid-flight.
      //
      // NOT in the energy race, which has its own, bigger tank and would
      // otherwise be charging for boost twice out of two different pockets.
      // The two blocks are mutually exclusive on the mode row's own flag.
      const energyPowered = rulesFor(ctx.RUNNING_MODE).energyPowered
      if (
        !energyPowered &&
        editionState.current.gameplay.energy.enabled &&
        ctx.level.vehicle === 'hoverjet'
      ) {
        // `flight.jet.sheet`: the tank burns at THIS jet's rates (DEV-380).
        const spec = energySpec(
          editionState.current.gameplay.energy.rechargeScale,
          handles.flight.jet.sheet,
          editionState.current.gameplay.energy.lockoutScale,
          editionState.current.gameplay.energy.reengage,
        )
        // DEV-853: Free Flight's boost never runs out. Full before the step (so
        // an empty start lights at once) and full after it (so the bar reads it).
        const infiniteBoost = rulesFor(ctx.RUNNING_MODE).infiniteBoost
        if (infiniteBoost) fillEnergy(run.energy, spec)
        // DEV-410: `boostPower` is the part of this tick's boost the tank paid
        // for. It is 1 unless the tank is empty with no lockout.
        // DEV-640: a press with nothing to light is a dry click. The tank's own
        // answer BEFORE this tick's step, on the raw stick's rising edge.
        if (
          isDryPress(
            boostPress.step(actions.boost),
            boostAvailable(run.energy),
            ctx.launch.phase === 'flying' && !crashHoldsShip(run.crash),
          )
        ) {
          audio.event({ type: 'tank.dry' })
        }
        const boost = stepEnergy(run.energy, spec, actions.boost, dt)
        if (infiniteBoost) fillEnergy(run.energy, spec)
        actions = { ...actions, boost, boostPower: run.energy.power }
        // THE MOMENT, on the event line — the channel G2's gate bonus uses.
        // Two edges, and both are things the player has to be told rather than
        // left to infer: the trigger going dead under their finger, and it
        // coming back. `until` is the same 1.5 s the crash banner takes.
        const nowAvailable = boostAvailable(run.energy)
        if (nowAvailable !== run.boostWasAvailable) {
          run.award = nowAvailable
            ? {
                text: uiString(ctx.level, 'boostReady', 'BOOST READY'),
                tone: 'gain',
                until: mission.elapsed + 1.5,
              }
            : {
                text: uiString(ctx.level, 'boostOut', 'BOOST OUT'),
                tone: 'loss',
                until: mission.elapsed + 1.5,
              }
          run.boostWasAvailable = nowAvailable
          // DEV-640: the tank running dry, sputtered and flashed (amber, on the
          // gate pulse's edge quad, so a headset sees it too: edge only).
          if (!nowAvailable) {
            audio.event({ type: 'tank.empty' })
            fireAccentFlash(...TANK_FEEL.flashColor, TANK_FEEL.flashScale)
          }
        }
      }
      // DEV-636/637: the boost, felt: a hum while it burns (an empty tank has
      // already turned `actions.boost` off above) and a shove at a stage.
      boostFeel.step(Boolean(actions.boost), forwardSpeedOf(handles.flight))
      // ── DEV-144: the energy race ────────────────────────────────────
      //
      // The tank is a clock. Flying spends it, boosting spends it five times
      // faster, and only a gate puts anything back. At zero the engines go out
      // and gravity comes back on — `LaunchElevator.FinishLaunch()` reversed —
      // and from there it is a falling body that DEV-126's crash rule ends.
      //
      // `energyPowered` is a MODE ROW property and not a name comparison, which
      // is what `tests/unit/mode-rules.test.ts` makes checkable: a fourth mode
      // is a row, not a ladder.
      let raceDied = false
      if (energyPowered) {
        const raceSpec = energyRaceSpec(
          editionState.current.gameplay.energyRace.drainScale,
          editionState.current.gameplay.energyRace.gatePayFraction,
          handles.flight.jet.sheet,
        )
        const wasPowered = run.energyRace.powered
        // `enginesOn` is `Energy_System.cs`'s — the THROTTLE axis, not the
        // airspeed. Coasting costs nothing, which is 2016's structure and turns
        // out to be the mode's most interesting decision: cutting the engine on
        // a straight saves the tank and costs you a clock that is still running.
        //
        // Only while actually flying: a ship on the elevator has not launched,
        // and draining the tank through a 15.5 s ride would end the run before
        // the player had touched anything.
        if (ctx.launch.phase === 'flying' && !crashHoldsShip(run.crash)) {
          stepEnergyRace(run.energyRace, raceSpec, actions.throttle > 0, actions.boost, dt)
        }
        if (!run.energyRace.powered) {
          // Dead stick. The stick is still READ — the engine note and the lean
          // are fed from `actions` — it just commands nothing.
          actions = { ...actions, throttle: 0, boost: false }
          handles.flight.setPowered?.(false)
          if (wasPowered) {
            run.award = {
              text: uiString(ctx.level, 'energyOut', 'ENERGY OUT'),
              tone: 'loss',
              until: mission.elapsed + 3,
            }
            audio.event({ type: 'ship.struck' })
            console.info('energy race: tank empty — engines out, gravity on')
          }
        }
        // A powerless ship that has hit something has finished this run. The
        // crash rule is DEV-126's and it would otherwise put the wreck back on
        // the course with an empty tank, which is a reset into another fall.
        raceDied = !run.energyRace.powered && (crashHoldsShip(run.crash) || handles.flight.struck)
      }
      // DEV-403: the JumpSeat's head meets the forest the rest of the seat meets
      // below, under the same gate — so null on Classic and wherever the props
      // did not load. A no-op on the HoverJet, which has no such rule.
      handles.flight.setProps?.(
        handles.livePropColliders && handles.livePropCollision && handles.livePropsLive
          ? handles.livePropColliders
          : null,
      )
      // DEV-790: a lesson step may hold the student to a speed (lesson 1's
      // first two steps), by cutting the throttle and boost at the ceiling.
      if (lessonHost.liveLesson) {
        const v = handles.flight.jet.body.velocity
        actions = capStudentActions(
          actions,
          Math.hypot(v.x, v.y, v.z),
          lessonHost.liveLesson.studentCap(),
        )
      }
      if (!crashHoldsShip(run.crash)) handles.flight.step(actions)
      // DEV-640: did boost burn on this step: the lens push and the cabin glow
      // follow it (a HoverJet only: the JumpSeat's boost is its own).
      ctx.boostBurning =
        ctx.level.vehicle === 'hoverjet' && actions.boost && !crashHoldsShip(run.crash)
      // ── DEV-136: the props ─────────────────────────────────────────────
      //
      // AFTER the flight model and its own ground rule have moved the body,
      // so a tree is tested where the ship ended the tick. The hull is the
      // HoverJet's five spheres on both vehicles: the JumpSeat's own hull is
      // not exposed by its flight, and a seat and a jet are the same few
      // metres across — noted in the row. The AI racers test the SAME
      // colliders, with their own state, in `liveRacers.step` below (DEV-147).
      if (handles.livePropColliders && handles.livePropCollision && handles.livePropsLive) {
        stepPropCollision(
          handles.livePropCollision,
          handles.flight.jet.body,
          HOVERJET_GROUND.collision.hull,
          handles.livePropColliders,
          editionState.current.gameplay.propCollision,
        )
        breakProps(handles.livePropCollision.hits, handles.flight.jet.body.velocity, 'player')
      }
      // DEV-613: into the sea, or back out of it.
      splashCraft(
        'player',
        handles.flight.jet.body,
        handles.flight.struck,
        handles.flight.impactSpeed,
        dt,
      )
      // ── the continuous layer ────────────────────────────────────────
      //
      // The FIXED step, not the frame. `engine.ts` is a state machine at
      // 82 Hz, and driving it on a frame delta would make the loop swaps ride
      // the frame rate — which is DEV-027's mistake wearing a different hat.
      // `released` is what gates the idle loop: 2016's `Ship_HoverShip` ships
      // `m_Enabled: 0` and nothing runs its `Start()` until the top of the
      // shaft, which is why nothing at all sounds while you are on the lift.
      {
        const v = handles.flight.jet.body.velocity
        // DEV-383: on the jumping spider the boost gesture IS the charge, and
        // the jet is OFF while one builds (`sim/jumpseat.ts`, `thrustGas`). So
        // the ladder hears no afterburner on a spider ever, and no thrust while
        // it charges — the charge tone speaks instead.
        const jump = handles.flight.jump
        audio.stepFlight({
          speed: Math.hypot(v.x, v.y, v.z),
          throttle: jump && jump.charge > 0 ? 0 : actions.throttle,
          boost: jump ? false : actions.boost,
          released: ctx.launch.phase === 'flying',
          jumpCharge: jump?.charge,
        })
      }

      // Out of bounds. Stepped AFTER the flight model so it judges where the
      // ship actually is this tick, not where it was.
      // ── out of bounds ───────────────────────────────────────────────
      //
      // Once a SECOND, not once a tick: `boundaryCountdown` is already a
      // ceil()'d integer of seconds remaining, so a change in it is exactly one
      // beat of the alarm. 13 s on every shipped mission, and disabled outright
      // in 6 of 13 — where it is disabled, `boundarySpec` is null and this
      // never runs at all, which is the honest behaviour rather than a silent
      // fallback (see `Boundary` in the level schema).
      if (ctx.boundarySpec) {
        const left = boundaryCountdown(ctx.boundary, ctx.boundarySpec)
        if (left !== null && left !== ctx.audioBoundaryLeft) {
          audio.event({ type: 'boundary.warning', secondsLeft: left })
        }
        ctx.audioBoundaryLeft = left
      }
      // The boundary and the crash, stepped together under one rule
      // (`sim/crash.ts`): a dying ship cannot crash, a crashed ship freezes
      // the boundary clock, and no tick resets the ship twice. On Classic the
      // crash spec is off and this is `stepBoundary` alone.
      const hazards = stepCrashAndBoundary(
        run.crash,
        // The HoverJet's rule. The JumpSeat's crash is 2016's own, the head
        // strike (DEV-403), which its seam steps and the block below restarts
        // on; here it gets the spec with the flag off. The glider flies the
        // HoverJet's hull (DEV-399) and takes its rule: a wing that hits the
        // sea at speed is a wreck, and one that did not crash would slide on
        // the water until the clock ran out.
        ctx.level.vehicle !== 'jumpseat' ? editionState.current.gameplay.crash : NO_CRASH,
        ctx.boundary,
        ctx.boundarySpec,
        handles.flight.jet.body,
        handles.flight.impactSpeed,
        crashCourseNow(),
        handles.collisionTerrain,
        dt,
        // DEV-185: the forest the reset has to miss. Null on Classic, on a
        // mission whose props did not load, and with `?props=0` — and then the
        // reset is planned exactly as it was before this argument existed.
        handles.livePropColliders
          ? { colliders: handles.livePropColliders, hull: HOVERJET_GROUND.collision.hull }
          : null,
      )
      // ── DEV-342: a dry JumpSeat that no pad can reach ────────────────
      //
      // The thruster LATCHES off at an empty tank and only a pad's refuel
      // sphere relights it, so a seat that runs dry out of every sphere's reach
      // lands and sits there for ever — on the Simonet sea it floats at about
      // 1 km/h — with no clock ending in Target Practice and nothing on screen
      // saying why. 2016 had the same soft-lock (its sea is a solid
      // `TerrainCollider` and the pilot's head stays clear of it); Matt's call is
      // that it restarts the run, the way the two lines below already restart it
      // for a boundary death and an empty energy tank. The RULE is
      // `sim/jumpseat-stranded.ts` and the seam steps it; this only says it out
      // loud, drops the curtain and restarts. ABSENT on a HoverJet, so `ok`.
      const strandedPhase: StrandedPhase = handles.flight.stranded?.phase ?? 'ok'
      if (strandedPhase === 'stranding' && run.strandedShown === 'ok') {
        // Up for the whole of what follows — the wait, then the fade — so the
        // reason is on screen until the screen goes black. A stranding that is
        // broken (the seat slid off a ledge) leaves it up a little longer, and
        // the tank really is empty.
        run.award = {
          text: uiString(ctx.level, 'fuelOut', 'OUT OF FUEL'),
          tone: 'loss',
          until: mission.elapsed + STRANDED_BANNER_SECONDS,
        }
        console.info('out of fuel — dry, out of reach of every pad, and grounded')
      }
      run.strandedShown = strandedPhase
      const strandedDied = handles.flight.stranded?.restart === true
      // ── DEV-403: the JumpSeat's head touched something ───────────────
      //
      // 2016's own JumpSeat death: `Trigger_Reset` on `collider_head` fades out,
      // waits a second and reloads the scene. Matt's call (2026-09-25): exactly
      // that, on both presets. The RULE is `sim/jumpseat-head.ts` and the seam
      // steps it with the stranded one, one death at a time; this raises the
      // HoverJet crash's own banner — 2016 showed nothing but the fade, and a
      // restart with no reason on screen reads as a bug — drops the curtain and
      // restarts. ABSENT on a HoverJet, so `ok`.
      const headPhase: HeadPhase = handles.flight.headStrike?.phase ?? 'ok'
      if (headPhase === 'dying' && run.headShown === 'ok') {
        run.award = {
          text: uiString(ctx.level, 'crashed', 'CRASHED'),
          tone: 'loss',
          until: mission.elapsed + 1.5,
        }
        console.info("head strike — the pilot's head touched something (DEV-403)")
      }
      run.headShown = headPhase
      const headDied = handles.flight.headStrike?.restart === true
      // A run ended by an empty tank restarts exactly as an out-of-bounds death
      // does — score, rings and clock back to zero. That is how this port says
      // "mission failed" and it is 2016's own answer too: `PlayerBoundary`
      // reloads the scene. DEV-144. A head strike is the same reload (DEV-403).
      const restarted = hazards.restarted || raceDied || strandedDied || headDied
      if (restarted) {
        stats.crash(
          headDied ? 'head-strike' : strandedDied ? 'fuel' : raceDied ? 'crash' : 'out-of-bounds',
          handles.flight.jet.body.position,
        )
      }
      // ── the death curtain (DEV-107) ────────────────────────────────
      //
      // 2016's shape exactly, and the port already had two thirds of it without
      // drawing any: `Trigger_Kill.RestartLevel()` snaps the fader to
      // `fadeTime = 0.1` and holds black for 2.5 s while the scene reloads, and
      // `sim/boundary.ts` has run that 2.5 s as its `dying` phase since long
      // before there was a curtain to hold. So the hold is NOT a number handed
      // to the fade — it is the sim's own clock, and the curtain simply waits
      // to be released. One clock, in the layer that owns it.
      //
      // The way back in is `LOAD_FADE_SECONDS`, because 2016's reloaded scene
      // fades in on its own fresh fader at that duration
      // (`LoadLevelArt.LoadLevel()` -> `fader.FadeIn()`); the 0.1 died with the
      // object that was overridden.
      //
      // Read off the PHASE rather than off the respawn, so every exit from
      // `dying` lifts it — including a mission swap that replaces `boundary`
      // outright. And never over a screen change already in flight: two
      // transitions behind one curtain is how you arrive somewhere neither
      // asked for.
      //
      // A stranded JumpSeat (DEV-342) comes down the SAME curtain on its own
      // phase, and at its own pace: the JumpSeat's 2016 death is not
      // `Trigger_Kill`'s snap but `Trigger_Reset`'s, which fades on the gameplay
      // fader's own `fadeTime` — `LOAD_FADE_SECONDS` — so the banner above is
      // readable while it goes. A head strike (DEV-403) IS `Trigger_Reset`, so
      // it comes down the same curtain at the same pace.
      const jumpSeatDying = strandedPhase === 'dying' || headPhase === 'dying'
      if (ctx.boundary.phase === 'dying' || jumpSeatDying) {
        if (!run.dyingCurtain && !router.pendingScreen) {
          run.dyingCurtain = true
          fade.begin({
            outSeconds: jumpSeatDying ? LOAD_FADE_SECONDS : KILL_FADE_SECONDS,
            inSeconds: LOAD_FADE_SECONDS,
            holdSeconds: 'released',
          })
        }
      } else if (run.dyingCurtain) {
        run.dyingCurtain = false
        fade.release()
      }
      if (restarted) {
        // 2016 reloads the whole scene, so the run restarts: score, rings and
        // clock all go back to zero. Harsh, and it is what the game does.
        handles.flight.respawn()
        flybyFeel.reset() // DEV-636: a respawn is a teleport, not a racer passing
        crashFeel.clear()
        // And the boundary is a fresh trigger, DISARMED, whatever ended the
        // run: 2016's reload makes a new `PlayerBoundary` that has fired
        // nothing, and only the respawn marker being inside re-arms it (DEV-074).
        // `stepBoundary` disarms itself on its own death; a head strike
        // (DEV-403), a dry tank (DEV-342) or a race death left it armed, and
        // `int_01_jumpSeat` — whose marker is 2.6 km outside its sphere — took
        // an out-of-bounds restart 13 s after every head strike. Found by
        // `tests/e2e/completion.spec.ts`, twice in a row.
        ctx.boundary = createBoundary()
        audio.event({ type: 'ship.respawn' })
        ctx.audioFinishCrossed = false
        Object.assign(mission, startMission(ctx.level, MODE_REQUEST()))
        // DEV-371: the clock is back to zero with the ship on the marker, so
        // the lap begins again there, and its first pose was PLACED.
        handles.lapRun?.restart(handles.flight.jet.body, editionState.rules.id)
        editorRecordPlaced() // DEV-491: a respawn is no path anyone flew
        run.elapsed = 0
        // The course is rebuilt, so the gates come back (DEV-122).
        handles.liveRings?.reset()
        document.body.dataset.score = '0'
        document.body.dataset.rings = `0/${mission.countTotal}`
        delete document.body.dataset.finished
        run.award = null
        console.info(
          headDied
            ? 'head strike — run restarted at the respawn marker'
            : strandedDied
              ? 'out of fuel — run restarted at the respawn marker'
              : 'out of bounds — run restarted at the respawn marker',
        )
      }
      // ── the crash curtain (DEV-126) ────────────────────────────────
      //
      // Snap to black over the wreck (`KILL_FADE_SECONDS`, 2016's death snap),
      // hold for the sim's `holdSeconds`, and come back on the cut fade
      // (DEV-107's 0.35 s) — about a second all told. `'released'` so the sim
      // decides when, the same contract the death curtain has; and never over
      // a screen change or a death already in flight.
      //
      // DEV-643/797: ONE timeline, hold, splash, curtain (`boot/feel-events.ts`).
      // The crash tick shakes, jolts and rumbles and holds the last frame for
      // ~100 ms (flat only; the sim is not paused); the world then draws live
      // while the sim's hold runs, so the player sees their own wreck and its
      // splash; the curtain starts once `crash.heldFor` reaches 0.4 s.
      if (hazards.crash === 'crashed') {
        crashFeel.begin(performance.now(), render.renderer.xr.isPresenting)
        // The impact cue. A contact that BEGAN this tick fires `ship.struck`
        // below anyway; a slide that ran into a wall did not begin this tick,
        // and a crash with no bang is a cut to black for no reason.
        if (!handles.flight.struck)
          audio.event({ type: 'ship.struck', impact: run.crash.impactSpeed })
        document.body.dataset.crashes = String(run.crash.count)
        stats.crash('crash', handles.flight.jet.body.position)
        console.info(
          `crash \u2014 ${run.crash.impactSpeed.toFixed(0)} m/s into the surface; back on the line at ${run.crash.reset.s.toFixed(0)} m`,
        )
      } else if (hazards.crash === 'reset') {
        // The sim has already placed the body; this collapses the drawn pose
        // onto it and cools the engine, the way the respawn does.
        handles.flight.placeAt(
          run.crash.reset.position,
          run.crash.reset.orientation,
          run.crash.reset.velocity,
        )
        // The ship was PUT there. `placeMission` is the one door for that:
        // the mission must not sweep a segment from the wreck to the line, AND
        // a ring the reset lands inside is not a ring that was flown through
        // (DEV-149 — a trigger fires on an edge).
        placeMission(mission, run.crash.reset.position)
        // DEV-371: and the lap marks the tick, so a rescore re-seeds there too.
        handles.lapRun?.placed()
        editorRecordPlaced() // DEV-491
        if (run.crashCurtain) {
          run.crashCurtain = false
          fade.release()
        }
        // DEV-636/643: a teleport must not read as a racer passing, nor carry a
        // boost stage or a hold across the cut.
        crashFeel.clear()
        flybyFeel.reset()
        boostFeel.reset()
        audio.event({ type: 'ship.respawn' })
        run.award = {
          text: uiString(ctx.level, 'crashed', 'CRASHED'),
          tone: 'loss',
          until: mission.elapsed + 1.5,
        }
      }
      // DEV-797: the curtain comes down once the player has watched the wreck for
      // `CRASH_CURTAIN_DELAY_SECONDS` of the sim's own hold. Keyed on the PHASE
      // and `heldFor` (the sim's clock), not on the crash tick, so it is the same
      // however fast the frames come. Never over a screen change or a death
      // already in flight.
      if (
        run.crash.phase === 'crashed' &&
        !run.crashCurtain &&
        !router.pendingScreen &&
        !run.dyingCurtain &&
        crashFeel.curtainDue(run.crash.heldFor)
      ) {
        run.crashCurtain = true
        fade.begin({
          outSeconds: KILL_FADE_SECONDS,
          inSeconds: CUT_FADE_SECONDS,
          holdSeconds: 'released',
        })
      }
      // ── DEV-343: the JumpSeat's run starts at GO, like the HoverJet's ──
      //
      // The seat is stepped through its 7.5 s `Trigger_EnableJumpShip`
      // countdown — it has to fall onto its rig and settle, and that is the
      // flight model's business — but nothing below this line is: no racers,
      // no scoring, and no mission clock until the thruster exists. That is the
      // HoverJet's shape exactly (its lift's early return keeps all of this
      // from running through the ride and the 3-2-1), it is Matt's call
      // (2026-09-24, "At GO"), and it is what `tests/unit/helpers/jumpseat-run.ts`
      // had always done, so the harness that measured DEV-056's times and the
      // game now read the same clock.
      //
      // BELOW the curtain and the restart, deliberately: a death respawns the
      // seat into a fresh countdown, and a return above them would leave the
      // curtain down for all 7.5 s of it. Absent on a HoverJet.
      if (handles.flight.countdownHolds) return
      // Scored in SIM space, from the body the flight model just moved — not
      // from the rendered mesh, which is a frame behind and in three space.
      // The opposition flies the same fixed step the player does — same
      // flight model, same gates, same dt. That is the whole point of DEV-026
      // and it is also what makes a race reproducible.
      // And the same crash rule (DEV-126), from the same preset, onto their own
      // line — with no curtain, because nobody is sitting in them. And the same
      // FOREST (DEV-147): the very same collider array the player just tested,
      // so a tree either of you knocks down is down for both.
      handles.liveRacers?.step(
        handles.autopilotTerrain,
        dt,
        handles.collisionTerrain,
        editionState.current.gameplay.crash,
        handles.livePropColliders
          ? {
              colliders: handles.livePropColliders,
              spec: editionState.current.gameplay.propCollision,
            }
          : null,
        // DEV-364: their lanes, and the air they share with you. Off the live
        // preset, like the crash rule. The player's body takes part while it is
        // flying — AFTER `flight.step` moved it, so a racer is avoided and
        // pushed where the player is now — and not while a crash holds it: a
        // wreck under the curtain is not in the air.
        {
          separation: editionState.current.gameplay.racers.separation,
          // DEV-391: nothing touches in a room (§6.7): every pose is stale.
          contact: roomActive() ? null : editionState.current.gameplay.racers.contact,
          player: crashHoldsShip(run.crash) ? null : handles.flight.jet.body,
          // The DEV-364 follow-up: a hit costs the player speed and knocks
          // its nose and wings, in the sim, on the tick of it.
          hit: roomActive() ? null : editionState.current.gameplay.racers.hit,
          // DEV-391: a room's other humans, avoided where each is drawn.
          others: roomActive() ? roomOthersNow() : null,
        },
      )
      // … and is heard, and felt in the cockpit (`game/racer-hit.ts`). The
      // count on the body is the game's own receipt, as `crashes` is.
      // DEV-649: the tick each racer took each gate, stamped HERE in the fixed
      // step (not per frame), so a split is two measured times at one gate.
      if (handles.liveRacers) splits.observe(handles.liveRacers.racers)
      const hitCue = handles.liveRacers
        ? takeRacerHit(handles.liveRacers.hit, hitJolt, time / 1000)
        : null
      if (hitCue && handles.liveRacers) {
        audio.event(hitCue)
        feel.shake(TRAUMA.racerHit) // DEV-636; the cockpit jolt is `hitJolt`'s own
        feel.haptic('hit')
        document.body.dataset.racerHits = String(handles.liveRacers.hit.total)
      }
      // What they broke, drawn. Read AFTER the step, from each racer's own
      // `props` state — never from a shared one (trap 19).
      if (handles.liveRacers && handles.livePropColliders && handles.livePropsLive) {
        for (const racer of handles.liveRacers.racers) {
          breakProps(racer.props.hits, racer.jet.body.velocity, `racer ${racer.spec.id}`)
        }
      }
      // DEV-613: the racers into the sea and out of it, the player's rule.
      if (handles.liveRacers) {
        for (const racer of handles.liveRacers.racers) {
          const c = racer.ground.collision
          splashCraft(`racer ${racer.spec.id}`, racer.jet.body, c.struck, c.impactSpeed, dt)
        }
      }

      // G1 and G2's inputs (DEV-110). The two the mission cannot see for
      // itself — how far the ground is and how fast the ship is going — come off
      // the flight model, and the two specs come off the preset. On Classic both
      // specs are inert (`maxBonus` 0, `cleanCentredness` 1), so this call is
      // the shipped 2016 scorer with three numbers it cannot use.
      const gameplay = editionState.current.gameplay
      const gate = stepMission(mission, ctx.level, handles.flight.jet.body.position, dt, {
        // The NEAREST surface within the ramp's reach, not the belly alone
        // (DEV-112): a canyon wall off the wingtip pays like a ridge under the
        // hull. The JumpSeat has no probes yet and answers with its belly.
        clearance:
          handles.flight.nearestSurface?.(gameplay.proximity.farMetres) ?? handles.flight.clearance,
        speed: forwardSpeedOf(handles.flight),
        struck: handles.flight.struck,
        proximity: gameplay.proximity,
        gateEvents: gameplay.gateEvents,
        // The JumpSeat's feet, for the pad plates (DEV-120). Null on a HoverJet,
        // and `stepMission` then sweeps the body as it always has.
        probes: contactProbesOf(handles.flight) ?? undefined,
      })
      // ── DEV-371: the lap, AFTER the step ─────────────────────────────
      //
      // The pose `stepMission` just scored, at the tick `mission.elapsed` now
      // reads: after the flight model, the props, a crash reset and the
      // racers' pushes (DEV-364) have all had the body. On the finish tick the
      // lap is cut, rescored from its own poses and offered to the store.
      const flownLap = handles.lapRun?.step(
        dt,
        handles.flight.jet.body,
        { ring: gate, finishCrossed: mission.finishCrossed, finished: mission.finished },
        editionState.rules.id,
      )
      if (flownLap) {
        const kept = flownLap.stored
          ? 'kept as your best'
          : flownLap.improved
            ? 'better, and NOT stored'
            : 'not your best'
        console.info(
          `lap: ${flownLap.seconds?.toFixed(4) ?? 'DNF'} s by its own poses ` +
            `(live ${mission.finishAt?.toFixed(4) ?? '-'}), ${flownLap.gates} rings, ` +
            `${flownLap.doc.keyCount} keys of ${flownLap.finishTick + 1} ticks, ${kept}` +
            (flownLap.tainted ? ` (tainted: ${flownLap.reasons.join(', ')})` : '') +
            `, ${flownLap.keptMs.toFixed(1)} ms`,
        )
      }
      // DEV-491: and the editor's recording flight, the same pose at the same tick.
      editorRecordStep(handles.flight.jet.body)
      roomStep(
        handles.flight.jet.body,
        actions,
        crashHoldsShip(run.crash),
        mission.finishCrossed,
        mission.course.passed,
      ) // DEV-388, DEV-390
      // ── what else happened this step ────────────────────────────────
      //
      // Four channels rather than one index, because the consumers differ: a
      // ring drives the speed chain and the gate burst, a pad plate greys out,
      // an orb disappears, and a mid-air medal raises a banner. `mission.event`
      // is owned by the MissionState, never a module scratch — trap 19.
      const ev = mission.event
      if (ev.padZone >= 0) {
        handles.livePadArt?.takeZone(ev.padZone)
        // DEV-415: 2016's `jumpPad_fx`, fired beside the same `CollectRing` cue.
        const scoredPad = mission.targets.zones[ev.padZone]?.pad
        if (scoredPad !== undefined) handles.liveFx?.burstPad(scoredPad)
        // The streak, said out loud. An accuracy chain the player cannot see is
        // a spreadsheet — `padBanner` words it and says whether it is a gain or
        // a loss, and `hud.ts` inks it accordingly.
        const hit = padBanner(ev, mission.countTotal)
        if (hit)
          run.award = { text: hit.text, tone: hit.tone, until: mission.elapsed + hit.seconds }
        // `TriggerCheckpoint.cs:90` and `Trigger_JumpTarget.cs:66` play the SAME
        // MasterAudio cue, `CollectRing`, so a pad plate and a ring sound alike
        // in 2016 and do here.
        audio.event({ type: 'gate.passed', index: ev.padZone })
        document.body.dataset.score = String(mission.score)
        document.body.dataset.rings = `${mission.counted}/${mission.countTotal}`
        document.body.dataset.multiplier = String(streakMultiplier(mission))
      }
      if (ev.orb >= 0) {
        handles.liveOrbArt?.collect(ev.orb)
        audio.event({ type: 'gate.passed', index: ev.orb })
        document.body.dataset.score = String(mission.score)
        document.body.dataset.rings = `${mission.counted}/${mission.countTotal}`
      }
      if (ev.awarded) {
        // 2.5 s is `LevelEnd.DisableMedalUI()`'s own wait, not a guess.
        run.award = {
          text: medalBanner(ctx.level, ev.awarded),
          tone: 'gain',
          until: mission.elapsed + 2.5,
        }
        audio.event({ type: 'run.medal', medal: ev.awarded })
        document.body.dataset.medal = ev.awarded
      }
      // Terrain contact. Once per contact, not once per tick of a slide.
      if (handles.flight.struck) {
        audio.event({ type: 'ship.struck', impact: handles.flight.impactSpeed })
        console.info('struck terrain')
      }
      // DEV-639: the speed chain running out is a loss too. The edge is read
      // BEFORE this tick's gate re-raises the stacks, so a gate cannot hide it.
      if (
        chainWatch.step(handles.flight.jet.chain.stacks, crashHoldsShip(run.crash)) &&
        gatesJudged()
      ) {
        ladderChainExpired(gateLadder)
        audio.event({ type: 'gate.loss', loss: 'chain' })
      }
      if (gate >= 0) {
        // THE speed chain. Every gate adds 18 to `maxSpeed`, falling back after
        // 5.5 s without one — terminal goes 182 -> 340 m/s over twenty-one
        // gates. `scoring.energyBoost` is true on every shipped ring; this is
        // the thing that was extracted and never read. See `sim/speed-chain.ts`.
        // `kind: 'ring'` is what S4's gate whoosh fires on, and it is only on
        // this one of the three `gate.passed` sites: a ring is a 24 x 35 m hole
        // you fly THROUGH, where a pad plate and an orb are not. 2016 plays the
        // same `CollectRing` cue for all three, so the map itself does not
        // branch on it. DEV-084.
        // DEV-638/639: the sim's verdict on this gate, put on the ladder. Judged
        // only where the rules have clean gates and a ring scores: elsewhere the
        // gate is exactly the cue 2016 plays. A gate that is not clean is a MISS
        // (`sim/gate-quality.ts`'s `recordGate` already decided; nothing is
        // recomputed here), and a miss that broke a streak is the louder loss.
        const gateJudged = gatesJudged()
        if (gateJudged) ladderGate(gateLadder, mission.event.gateClean)
        const gateIsClean = gateJudged && mission.event.gateClean
        audio.event(
          gateJudged
            ? {
                type: 'gate.passed',
                index: gate,
                kind: 'ring',
                clean: gateIsClean,
                streak: gateLadder.streak,
              }
            : { type: 'gate.passed', index: gate, kind: 'ring' },
        )
        // DEV-845: a gate taken in time keeps the chain whether or not it was
        // clean, so it voices no loss. Only the chain running out does (above).
        // DEV-638 (d): the +18 m/s read as a shove. Flat only and slider-scaled
        // inside `feel`. The LENS is the look's (D35): the Classic look is exactly
        // 2016's one lens, so a kick runs only where the look has a lens at all.
        if (lensIsLive()) {
          feel.fovKick(GATE_FEEL.fovKickDegrees, GATE_FEEL.fovKickSeconds)
        }
        // DEV-637: the gate, felt. A clean one is the double tick.
        feel.haptic(mission.event.gateClean ? 'cleanGate' : 'gate')
        // S6's third channel (DEV-108), on exactly the same condition and for
        // exactly the same reason as the whoosh above: a ring is a 24 x 35 m
        // hole you fly THROUGH, and a pad plate and an orb are not. Scaled by
        // the speed FX comfort slider, which §2.6 names S6's pulse in — at
        // `off` the peak is zero and nothing is drawn. A CLEAN gate pulses
        // harder (DEV-638), still clamped to the full pulse.
        gatePulse.fire(
          editionState.current.fx.gatePulse,
          forwardSpeedOf(handles.flight),
          editionState.speedFx,
          gateIsClean ? GATE_FEEL.cleanPulseScale : 1,
        )
        chainGate(handles.flight.jet.chain)
        // And the gate pays the tank (DEV-144). Beside `chainGate` on purpose:
        // both are "what a ring gives you", both are 2016's own
        // `TriggerCheckpoint` branches (`IncreaseSpeed()` and `AddEnergy()`),
        // and a gate that raised the speed ceiling without refuelling you would
        // be half a ring. `payGate` clamps at the tank and refuses a dead ship,
        // so a wreck tumbling through a ring does not restart its engines.
        if (energyPowered) {
          const racePaid = run.energyRace.paid
          payGate(
            run.energyRace,
            energyRaceSpec(
              editionState.current.gameplay.energyRace.drainScale,
              editionState.current.gameplay.energyRace.gatePayFraction,
            ),
          )
          // DEV-640: a ring that put fuel back is a rising tick.
          if (run.energyRace.paid > racePaid) audio.event({ type: 'tank.fill' })
        } else if (
          editionState.current.gameplay.energy.enabled &&
          ctx.level.vehicle === 'hoverjet'
        ) {
          // DEV-410: and the boost tank takes the ring too. It is the same "what
          // a ring gives you", on the tank the energy race does not use. It is
          // Anniversary's `ringRefill`, and Classic is off by its flag.
          const tankBefore = run.energy.energy
          refillEnergy(
            run.energy,
            energySpec(
              editionState.current.gameplay.energy.rechargeScale,
              handles.flight.jet.sheet,
              editionState.current.gameplay.energy.lockoutScale,
              editionState.current.gameplay.energy.reengage,
            ),
            editionState.current.gameplay.energy.ringRefill,
          )
          // DEV-640: a ring that put fuel back is a rising tick.
          if (run.energy.energy > tankBefore) audio.event({ type: 'tank.fill' })
        }
        // The gate's one-shot burst — 0.25 s, two bursts, 100-450 m/s. The four
        // CONTINUOUS ringBurst systems are already running on every gate and are
        // not touched here.
        handles.liveFx?.burstRing(gate)
        // DEV-638/639: a clean gate's second layer, a missed gate's grey flash.
        if (gateIsClean) handles.liveFx?.burstRingSparkle(gate, 'clean')
        else if (gateJudged) handles.liveFx?.burstRingSparkle(gate, 'miss')
        // The gate goes away (DEV-122). Stamped in SIM seconds, because that
        // is the clock 2016's coroutine counted and the one the run pauses
        // with. THIS site only: it is the player's pass, and 2016's "npc"
        // branch never hid a gate — a racer through the same ring leaves it
        // standing for you.
        // DEV-869: a viewer (FF-TV, a watch link) has no gate to hide: every ring
        // stays up for them. Per view, because the state below is the renderer's.
        if (!(tvActive() || roomCore.watch !== null)) handles.liveRings?.pass(gate, mission.elapsed)
        document.body.dataset.score = String(mission.score)
        document.body.dataset.rings = `${mission.counted}/${mission.countTotal}`
        // ── G2's gate banner, and G1's bonus on it (DEV-110) ──────────
        //
        // ONE line for both, because they describe the same gate and the panel
        // has one event row — the pad streak and the mid-run medal already share
        // it, and a second row would change the panel's silhouette for a case
        // that lasts a second and a half.
        //
        // They compose rather than compete: a clean gate flown on the deck says
        // "CLEAN x3  +60", which is the sentence the two levers are jointly
        // making. Either half alone says only its own half, and neither says
        // anything on Classic, where the specs cannot produce either.
        //
        // AFTER the dataset writes, so a spec reading `data-score` is reading
        // the run and not this.
        const parts: string[] = []
        // DEV-649: the split is no longer a line on every gate's banner (it was
        // DEV-371's `GHOST +0.42` at every ring). It shows every fourth gate and
        // at the last, for two seconds, against the ghost or the racers ahead
        // and behind (`game/split-times.ts`), through the event line and the
        // flat race strip. Behind the gate banner's own flag, because the
        // Classic gate row is 2016's, which had no split.
        const ghost = handles.lapRun?.ghost ?? null
        if (editionState.current.gameplay.gateEvents.enabled) {
          splits.playerPass(
            gate,
            mission.elapsed,
            mission.countTotal,
            ghost
              ? {
                  label: ghostName(ghost),
                  ringTimes: ghost.result.ringTimes,
                }
              : null,
          )
        }
        if (mission.event.gateClean) {
          // DEV-638: the LADDER's count, which is the sim's streak until a chain
          // expiry, which the sim does not know about but a player does.
          const streak = gateJudged ? gateLadder.run : mission.gateEvents.cleanStreak
          parts.push(streak > 1 ? `CLEAN x${streak}` : 'CLEAN')
        }
        // NAMED, since DEV-154. It used to read `+60`, and on the one row the
        // gate has just written `CLEAN x3` onto that is a number a player adds
        // to the gate — which is exactly what Matt reported: he could see the
        // gate feedback and had never seen the proximity lever pay. It had been
        // paying, in the one place it would be read as something else. NEAR MISS
        // is the word on this banner and on the results panel (`+ 780 near miss`),
        // since DEV-893 (Matt: reckless flying pays, so call it that, not low).
        if (mission.event.proximityBonus > 0)
          parts.push(`NEAR MISS +${mission.event.proximityBonus}`)
        if (parts.length > 0) {
          // 1.6 s, the pad streak's own window — the same surface, so the same
          // dwell, rather than a second number for the same row. (A split takes
          // the row over for its own two seconds instead, DEV-649: see the HUD's
          // `award` below.)
          run.award = {
            text: parts.join('  '),
            tone: 'gain',
            until: mission.elapsed + 1.6,
          }
        }
        console.info(
          `ring ${mission.ringsPassed}/${mission.ringsTotal} — ` +
            `${mission.score} pts at ${mission.elapsed.toFixed(1)}s` +
            (mission.event.proximityBonus > 0 ? ` (+${mission.event.proximityBonus} prox)` : '') +
            (mission.event.gateClean ? ` clean x${mission.gateEvents.cleanStreak}` : '') +
            // The CENTREDNESS itself, not only whether it passed the threshold.
            // `cleanCentredness` is a tuning number and a boolean cannot say
            // whether it is reachable — the first autopilot lap scored zero
            // clean gates out of twenty-one and this line is what told us why.
            (editionState.current.gameplay.gateEvents.enabled
              ? ` c=${mission.event.gateCentredness.toFixed(2)}`
              : ''),
        )
      }
      // A NEAR MISS is not a gate event and does not share the gate's banner: it
      // fires between gates, on its own cooldown, and it must never overwrite a
      // CLEAN that is still up — the gate is the thing the player did on purpose.
      // Only raised when nothing else holds the row.
      //
      // Gated on the preset's flag, which DEV-110 left off: Classic's spec
      // carries the same 8 m threshold, so a Classic run under a ridge was
      // showing CLOSE — a banner for a mechanic that preset does not have, and
      // the one place its panel was not the panel that shipped. Found reading
      // the wiring for DEV-112; fixed here because the points now ride on it.
      //
      // "+25" beside it is what the near miss just banked into G1's pool (the
      // Anniversary score, never the medal), worded like the gate's "+18" so the
      // two are one vocabulary. The event line draws the text; `hud.ts` is
      // untouched, and Classic's panel stays pixel-identical because this
      // branch cannot be reached there.
      if (
        editionState.current.gameplay.gateEvents.enabled &&
        mission.event.nearMiss &&
        !(run.award && mission.elapsed < run.award.until)
      ) {
        const paid = mission.event.nearMissPoints
        // DEV-642: the half ANNIVERSARY S4 asked for and nobody built: a whoosh
        // from the side the terrain was on (`flight.surface.probe`), a small
        // cockpit jolt, a small flat shake and a sharp tick in the hands.
        audio.event({
          type: 'ship.nearMiss',
          at: nearMissAt(
            _nearAt,
            readHeadPosition(render.renderer.xr, render.camera, _nearEye),
            _nearRight.setFromMatrixColumn(render.camera.matrixWorld, 0),
            handles.flight.surface?.probe ?? -1,
          ),
        })
        feel.shake(TRAUMA.nearMiss)
        feel.jolt(JOLTS.nearMiss)
        feel.haptic('nearMiss')
        run.award = {
          text: paid > 0 ? `CLOSE  +${paid}` : 'CLOSE',
          tone: 'gain',
          until: mission.elapsed + 0.8,
        }
        console.info(
          `near miss at ${mission.elapsed.toFixed(1)}s — ` +
            `${mission.proximity.clearance.toFixed(1)} m` +
            (handles.flight.surface ? ` (probe ${handles.flight.surface.probe})` : '') +
            (paid > 0 ? ` +${paid} prox` : ''),
        )
      }
      // ── THE LOW LINE, said out loud (DEV-154) ───────────────────────
      //
      // Matt, having flown G1/G2: *"i've yet to see scoring influenced by
      // flying near objects/terrain. maybe ui would help similar to the new
      // gate score bonus ui"*.
      //
      // The meter has been paying at gates since DEV-110 — but the payout is
      // pushed onto the GATE's own banner as a bare `+60` beside `CLEAN x3`,
      // where a player reads it as what the gate was worth. The one channel
      // that is unambiguously the low line's had no voice at all. This is it,
      // and it is the LINE channel's, which banks every tick on every mission.
      //
      // LOWEST PRIORITY of the three things that reach this row, and the order
      // is deliberate: a gate is what you did on purpose, a near miss is a
      // moment, and this is a rate — the one that can afford to wait. On a
      // deck-level pass the CLOSE banners will take the row and these will fill
      // the gaps, which is the right way round.
      //
      // Behind the same flag as the meter itself: `perSecond` and `awardStep`
      // are both 0 on Classic, so `lowPoints` cannot be positive there and this
      // branch is unreachable — but the flag is checked anyway, for the reason
      // DEV-112 found the hard way one row up.
      if (
        editionState.current.gameplay.proximity.enabled &&
        mission.event.lowPoints > 0 &&
        !(run.award && mission.elapsed < run.award.until)
      ) {
        run.award = {
          text: `NEAR MISS +${mission.event.lowPoints}`,
          tone: 'gain',
          until: mission.elapsed + 0.8,
        }
        // Printed for the same reason DEV-110 prints the gate's centredness:
        // `perSecond` and `awardStep` are tuning numbers, and a banner that
        // sometimes loses the row to a gate cannot tell you whether the CADENCE
        // is right. The line carries the meter and the pool, so a lap's worth
        // of them says how often a player is actually told.
        console.info(
          `low +${mission.event.lowPoints} at ${mission.elapsed.toFixed(1)}s — ` +
            `meter ${mission.proximity.level.toFixed(2)}, ` +
            `${mission.proximity.clearance.toFixed(0)} m, pool ${mission.proximity.bonus}`,
        )
      }
      // Crossing the gate and the run ENDING are two different moments — the
      // clock running out also finishes a run, and there is nothing to
      // celebrate about that. This is the crossing.
      if (mission.finishCrossed && !ctx.audioFinishCrossed) {
        ctx.audioFinishCrossed = true
        audio.event({ type: 'run.finish' })
        stats.count('finishes')
        stats.stage('finished')
      }
      if (mission.finished && document.body.dataset.finished !== 'true') {
        document.body.dataset.finished = 'true'
        // Null where the MODE awards no medal. 2016 awards none in Target
        // Practice — three independent reasons, and one of its six missions has
        // no thresholds at all — so `'none'` would be a claim the game never
        // made. `results.ts` and the HUD both draw nothing for either.
        // DEV-469: a "fly from here" is PART of a course, and keeps the whole
        // course's medals, so it awards none and keeps no best.
        // DEV-601: nor does a run the autopilot flew any of.
        const unrecorded = editorPartialRun() || mission.autopilotFlew
        const medal = (unrecorded ? null : medalFor(mission, ctx.level)) ?? 'none'
        if (!unrecorded && medalFor(mission, ctx.level)) {
          audio.event({ type: 'run.medal', medal })
          // DEV-644: the line, in the medal's own colour (edge only: a headset sees it too).
          const tier = medalTierOf(medal)
          if (tier) {
            const c = medalColour(tier)
            fireAccentFlash(c.r, c.g, c.b, FINISH_FEEL.pulseScale)
          }
        }
        // ── the results panel ─────────────────────────────────────────
        //
        // Recorded ONCE, here, guarded by the same `dataset.finished` flag that
        // guards the console line — `stepFixed` runs this block eighty times a
        // second and a best written every tick would be a best written with the
        // clock still moving.
        // The MODE is half the key since DEV-204: a score is only comparable to
        // another score under the same rules, and `RUNNING_MODE` is the rules
        // this run was actually scored under.
        const outcome = unrecorded
          ? null
          : recordRun(
              ctx.level.id,
              ctx.RUNNING_MODE,
              {
                score: missionScore(mission),
                timeSeconds: mission.elapsed,
                // The objective's count, as the panel shows it (DEV-344). The ring
                // counters are 0 on every JumpSeat mission.
                gates: mission.counted,
              },
              undefined,
              // DEV-382: under THIS flight's variant, whose record it is.
              handles.flight?.variant ?? STANDARD_VARIANT_ID,
              // DEV-393: compared with the stored best as it reads TODAY.
              bestRule(ctx.level, ctx.RUNNING_MODE),
              // DEV-538: on an overridden course, that course's record only.
              ctx.level.courseKey ?? null,
            )
        document.body.dataset.medal = medal
        stats.attemptEnd('finished', medal)
        document.body.dataset.finalScore = String(missionScore(mission))
        document.body.dataset.best = outcome ? String(outcome.best.score) : ''
        // The run's own numbers, from the MISSION's objective counters — see
        // `summariseRun` for why not the ring ones (DEV-344). The race joins
        // them every frame the panel is up, where the panel is drawn.
        run.lastResult = summariseRun(
          mission,
          // APP-SPLIT 2.1: the panel's words and the best, decided in
          // `game/results-state.ts`'s `runExtras`, where a test reads them.
          runExtras({
            level: ctx.level,
            mode: mission.mode,
            medal,
            outcome,
            storageAvailable: () => safeStorage() !== null,
            fromEditor: EDITOR_RUN.request !== null,
            lapLeft: Boolean(handles.lapRun?.last),
            device: confirmDevice,
            autopilotFlew: mission.autopilotFlew,
            medalInput: medalInput(mission), // DEV-650: "N MORE RINGS FOR GOLD"
          }),
        )
        console.info(
          `run over: ${mission.ringsPassed}/${mission.ringsTotal} rings, ` +
            `${mission.score} pts in ${mission.elapsed.toFixed(1)}s, ` +
            `time bonus ${mission.timeBonus}, total ${missionScore(mission)}, medal ${medal}` +
            `${!outcome ? (mission.autopilotFlew ? ' (autopilot: no medal, no best)' : ' (part of a course: no best)') : outcome.improved ? ' · NEW BEST' : ` (best ${outcome.best.score})`}`,
        )
      }
    })
    const simMs = performance.now() - simT0
    const ticksThisFrame = clock.tick - tickBefore
    // DEV-445: the lift, drawn where the ship on it is drawn. The step above
    // hands it the sim's rise (`setRise`, beside `rideElevator`); this puts the
    // platform `alpha` of the way between the last two, as `flight.render`
    // puts the ship and the eye. Without it the deck stood at the CURRENT step
    // under an eye drawn a fraction of a step behind, and the eye's height over
    // the deck sawed by up to 0.2 m a frame wherever the display does not run
    // at 81.967 Hz. `render/elevator.ts`'s `render` has the measurement.
    handles.elevator?.render(alpha)
    // DEV-612: the craft a camera follows, placed for THIS frame before any
    // camera reads them, as `flight.render` places the player's ship before
    // `chaseCamera` reads it (DEV-319). TV's camera (the exhibition's racers,
    // a watched room's ships) and `?view=chase&chase=<racer>` read the drawn
    // Object3D; placed only by `liveRacers.render` and `roomRender`, which run
    // after the cameras, they read the pose the PREVIOUS frame drew, and the
    // hull led the camera by one frame's travel: Matt's "juddery" on TV.
    // `render` places again, from the same `alpha`, to the same bits.
    if (router.screen !== 'title') {
      handles.liveRacers?.place(alpha)
      roomPlace() // DEV-388's placement, moved up; the trails stay below
    }

    // Driven by the STATE, not by the keypress that changes it. Setting it in
    // the confirm handler left the monument standing under `?title=0`, which
    // never presses anything — a flag that only the happy path clears.
    // ── the title screen's own sun ─────────────────────────────────────
    //
    // Swapped rather than added: one directional light, two missions' worth of
    // lighting. Set every frame because it is three assignments and a screen
    // change is not a thing this loop otherwise tracks.
    if (handles.missionSun && ctx.level.lighting.sun) {
      const onTitle = router.screen === 'title'
      const dir = onTitle ? TITLE_SUN.direction : ctx.level.lighting.sun.direction
      handles.missionSun.position
        .set(-(dir[0] as number), -(dir[1] as number), -(dir[2] as number))
        .multiplyScalar(10_000)
      if (onTitle) {
        handles.missionSun.intensity = marmosetSunIntensity(TITLE_SUN.intensity)
        handles.missionSun.color.setRGB(
          TITLE_SUN.colorSrgb[0],
          TITLE_SUN.colorSrgb[1],
          TITLE_SUN.colorSrgb[2],
          THREE.SRGBColorSpace,
        )
      } else {
        // DEV-454: 2016's product, straight from the level, as `applyLighting` sets it.
        const c = ctx.level.lighting.sun.colorLinear
        // DEV-564: times the light blocker, the sun faded by the eye's depth in
        // the shaft (`render/elevator.ts`, `shaftSunGain`). Intensity only: the
        // light never leaves the scene. 1 on a mission with no shaft.
        handles.missionSun.intensity =
          marmosetSunIntensity(ctx.level.lighting.sun.intensity) *
          shaftSunGain(ctx.launch.rise, handles.elevator, EYE.y, dir)
        handles.missionSun.color.setRGB(
          c[0] as number,
          c[1] as number,
          c[2] as number,
          THREE.LinearSRGBColorSpace,
        )
      }
    }

    // ── the title screen's own AMBIENT and SKY ──────────────────────────
    //
    // DEV-155, and OUTSIDE the sun's guard on purpose: a level with no sun
    // would have left the valley lit and skied by the mission it booted from,
    // which is the shape of bug this row exists to close rather than to move.
    //
    // Two probes, one lit: three sums every probe in the scene, so leaving both
    // on would light the valley with Simonet's sky as well as Pisa's. The
    // mission's is found by the name `createSkyshopProbe` gives it rather than
    // threaded out of `applyLighting`, which returns the sun and would have to
    // learn about this to return a second thing.
    //
    // One of the two domes is drawn, and `scene.environment` follows it so the
    // SPECULAR comes from the same sky as the background. Assigned only when it
    // changes: a scene-wide texture swap is not a thing to do sixty times a
    // second for no reason.
    {
      const onTitle = router.screen === 'title'
      if (handles.titleProbe) {
        handles.titleProbe.intensity = onTitle ? TITLE_IBL.exposure.diffuse : 0
        // Two names, because `?ambient=sky` builds the mission's probe through
        // `probeFromSkyRadiance` and that one calls itself `sky-radiance-ibl`.
        // Miss it and the diagnostic flag quietly lights the title valley with
        // BOTH skies — which is the sort of thing that reads as "the title
        // screen is brighter under ?ambient=sky" and gets blamed on the sky.
        const missionProbe = (render.scene.getObjectByName('skyshop-ibl') ??
          render.scene.getObjectByName('sky-radiance-ibl')) as THREE.LightProbe | undefined
        if (missionProbe) {
          handles.missionProbeGain ??= missionProbe.intensity
          missionProbe.intensity = onTitle ? 0 : handles.missionProbeGain
        }
      }
      // DEV-320: the smooth sky. Each dome under its OWN guard and outside the
      // block below, because `titleSky` is null in every mission — DEV-307's
      // first draft read the flag inside `titleSky && liveSky` and was dead
      // everywhere a player flies. Before that block, so it assigns the
      // environment a re-bake just made.
      const smoothSky = editionState.current.render.smoothSky.enabled
      if (handles.titleSky) syncSmoothSky(handles.titleSky, smoothSky, render.scene)
      if (handles.liveSky) syncSmoothSky(handles.liveSky, smoothSky, render.scene)
      if (handles.titleSky && handles.liveSky) {
        handles.titleSky.dome.visible = onTitle
        handles.liveSky.dome.visible = !onTitle
        const wanted = onTitle ? handles.titleSky.environment : handles.liveSky.environment
        if (render.scene.environment !== wanted) render.scene.environment = wanted
      }
    }

    handles.title?.setVisible(router.screen === 'title')
    // Which of the ship's two meshes is on, driven by the SCREEN rather than by
    // the keypress that changed it. `setView` is idempotent, so a statement here
    // cannot fall out of step with `screen` the way a call at each transition
    // can — which is exactly how `?title=0` once booted straight into the menu
    // with the monument still standing in it.
    //
    // In the hangar the ship is parked in front of you, so you are looking at
    // its OUTSIDE and it wears the exterior hull; in a mission you are sitting
    // in it — unless CHANGE VIEW has put the camera behind it (DEV-128), which
    // is the OTHER thing 2016's `Art/FirstPerson` / `Art/ThirdPerson` toggle
    // was for: `CamChanger.shipArt[i].SetActive`.
    //
    // `thirdPersonLive` is decided HERE, once, and read by everything below:
    // the art swap, the camera branch, the readout's parent, the lens, the
    // briefing and the CAM chip. Five readers of one boolean rather than five
    // recomputations that can disagree by a frame.
    const thirdPersonLive =
      ctx.thirdPersonWanted &&
      wantsFly &&
      handles.flight !== null &&
      router.screen === 'mission' &&
      !pause.paused &&
      run.lastResult === null &&
      !presenting
    if (thirdPersonLive && !ctx.lastThirdPersonLive) resetThirdPerson()
    ctx.lastThirdPersonLive = thirdPersonLive
    handles.flight?.setView(router.screen === 'menu' || thirdPersonLive ? 'third' : 'first')
    // DEV-305, wishlist #29. Beside `setView` because the two decide one thing
    // between them: whether the exterior hull is in the scene while you are in
    // the cockpit. Read live rather than on the edition notify, for the reason
    // `setView` is here at all — this branch already runs every frame and a
    // second seam for the same object is a second thing to keep in step.
    handles.flight?.setShipShadow(
      editionState.current.render.shipShadow.enabled &&
        shadowsEnabled(editionState.current, editionState.settings),
    )

    if (router.screen === 'title' && handles.title) {
      // Standing in the world, looking at the monument. Fixed: a title screen
      // that drifts is a title screen you cannot photograph twice the same way,
      // and the racers are the thing that moves.
      //
      // DEV-418: fixed UNTIL YOU LOOK. The look is the player's, starts at zero
      // and keeps what it is given (the hangar's seat does the same), so a
      // title nobody touches is still the one photograph. It turns the CAMERA
      // under the rig, never the rig: the rows hang on the rig, and a rig that
      // turned with you would carry them out of reach of the nose that picks
      // them. The rig is level (`render/title.ts`), so a yaw about the camera's
      // own up is a yaw about the world's. Flat only — in a session the headset
      // owns the camera's local pose.
      if (titleLooks) {
        titleMenuHost.titleLookYaw += look.yaw
        titleMenuHost.titleLookPitch = Math.max(
          -SEAT_PITCH_LIMIT,
          Math.min(SEAT_PITCH_LIMIT, titleMenuHost.titleLookPitch + look.pitch),
        )
      }
      titleLookEuler.set(
        presenting ? 0 : titleMenuHost.titleLookPitch,
        presenting ? 0 : titleMenuHost.titleLookYaw,
        0,
      )
      if (render.rig) {
        render.rig.position.copy(handles.title.eye)
        render.rig.quaternion.copy(handles.title.quaternion)
        render.camera.position.set(0, 0, 0)
        render.camera.quaternion.setFromEuler(titleLookEuler)
      } else {
        render.camera.position.copy(handles.title.eye)
        render.camera.quaternion.copy(handles.title.quaternion)
        render.camera.quaternion.multiply(_titleLookQuat.setFromEuler(titleLookEuler))
      }
      // The title screen's OWN two ships, on 2016's two flypast paths.
      //
      // They were the mission racers' meshes on loan until DEV-281, with
      // `Title.setVisible` handing them back so a mission did not start an
      // opponent short. That could not survive boot no longer building a
      // mission — there is nothing to borrow from — and it was never what
      // `main_menu.unity` does anyway: its two `SplineWalker`s carry ships of
      // their own, which is what `liveTitleJets` now is.
      //
      // No fallback to `liveRacers.ships`. The first cut kept one, and it was
      // unreachable by construction — `title` exists only on a title boot and a
      // title boot builds no racers — which is a branch that can only ever
      // mislead the next reader about where these ships come from. If the GLB
      // 404s, `liveTitleJets` is empty and the flypast is empty, which is what
      // the `console.warn` beside the load says will happen.
      //
      // ── and they wait for the valley (DEV-352) ────────────────────────
      //
      // While the curtain is HELD the flypast is not stepped at all — its
      // clock stands still and no ship is placed — for two reasons. The
      // opening pass is 5.6 s long and would otherwise be spent behind black;
      // and on Classic the jets are translucent, which draws them AFTER the
      // opaque curtain — two ghost ships crossing a black screen before there
      // is a valley for them to be in. Unplaced, they sit at the world origin,
      // 30 km from the valley and past the far plane. The emblem is the only
      // thing on black, and that is decided here.
      const flypastLive = handles.titleCurtain === null || handles.titleCurtain.phase !== 'held'
      if (flypastLive) handles.title.update(frameSeconds, handles.liveTitleJets)
      // DEV-412: the trails, from the poses just placed.
      if (flypastLive) {
        handles.liveTitleTrails?.update(
          readHeadPosition(render.renderer.xr, render.camera, titleTrailEye),
          frameSeconds,
        )
      }
    }
    // ── the title's rows: shown, aimed, painted (DEV-353) ───────────────
    //
    // The pause plate's own reading, one screen over: the head, or a hand's
    // laser when one points (DEV-321), picks a row only while it is ON a row,
    // so on a flat screen — where the head is the centre of the frame and the
    // plate hangs below it — the keys and the stick keep what they chose. The
    // rig was parked at the eye just above, so the ray leaves from the pose
    // this frame will draw. DEV-558: START and ENTER VR, and a link's row.
    // DEV-859: OPTIONS opened on the title does not follow the player out of it
    // (a session starting on the title takes the page to the hangar).
    if (titleOptionsOpen && (router.screen !== 'title' || !menus.options.up)) {
      titleOptionsOpen = false
      if (router.screen !== 'title') menus.options.close()
    }
    // DEV-882: while the OPTIONS pages are up they are drawn on their own plate
    // (`title/options-plate.ts`), the pause plate's size, with the credits roll
    // in its body (DEV-881); the title's own rows plate is put away under it.
    const optionsOnTitle = titleMenuUp() && menus.options.up
    handles.titleMenu?.setVisible(titleMenuUp() && !optionsOnTitle)
    // The cursor over a row of the OPTIONS plate aims it, on a MOVE only (as the
    // pause plate does): a still mouse never fights the arrow keys.
    if (optionsOnTitle && !presenting && !mouseLook.locked && hoverAt !== null) {
      const hit = titleRowAt(hoverAt.x, hoverAt.y)
      if (hit >= 0) ctx.titleAim = hit
    }
    const titleOptions = titleMenuHost.titleOptions
    titleOptions.frame({
      on: optionsOnTitle,
      flat: !presenting,
      selected: ctx.titleAim,
      seconds: frameSeconds,
      nowMs: frameT0,
      fastHeld: confirm,
    })
    if (handles.titleMenu !== null && titleMenuUp()) {
      const m = handles.titleMenu
      const looked = aimPlate(
        optionsOnTitle && titleOptions.object !== null ? titleOptions.object : m.object,
        optionsOnTitle
          ? (o, d) => titleOptions.pick(o, d)
          : (o, d) => m.pick(o, d, titleRows().length),
      )
      if (optionsOnTitle) {
        // The OPTIONS plate is centred on the view, so the gaze is on a row at
        // once and stays there on a flat screen: it takes the aim when it MOVES
        // (a head, a laser), as the hangar's plate does, never every frame, or
        // the arrow keys could not leave the row under the screen's centre.
        if (looked >= 0 && titleOptionsLooked !== -2 && looked !== titleOptionsLooked)
          ctx.titleAim = looked
        titleOptionsLooked = looked
      } else {
        titleOptionsLooked = -2
        if (looked >= 0) ctx.titleAim = looked
      }
      if (!optionsOnTitle) {
        m.update({
          options: titleRows(),
          selected: ctx.titleAim,
          title: TITLE_MENU_HEADING,
          notesOnSelect: false,
        })
      }
    }
    // `body[data-title-up]`: the title's rows are up on a monitor. DEV-557 set
    // it for the credit line at the title's foot; the line went to the pause
    // plate's CREDITS page (DEV-614) and the attribute stays, a page fact like
    // `data-load` for anything in the DOM that has to know.
    const titleShown = titleMenuUp() && !render.renderer.xr.isPresenting
    if (titleShown !== document.body.hasAttribute('data-title-up')) {
      document.body.toggleAttribute('data-title-up', titleShown)
    }
    homeScreenGuide.frame(titleShown && !optionsOnTitle, turnScreen.up)
    titleHomeHint.frame(titleShown, turnScreen.up, frameT0)
    // DEV-480: TV's plate
    tvView.plateFrame()
    // ── DEV-441b: the letter plate: shown, aimed, painted, and its join watched ──
    //
    // In the hangar since DEV-558, in front of the chair (`placeCodePlateInRoom`,
    // the lobby's frame), built the first time it is asked for and kept for
    // the page: the room outlives every world, and so does this.
    codeJoinFrame()
    openRoomsFrame() // DEV-633
    if (codeUp() && letterPlate.codePlate === null) {
      letterPlate.codePlate = createCodePlate()
      placeCodePlateInRoom(letterPlate.codePlate.object, seatWorld, seatQuaternion)
      menuScene.add(letterPlate.codePlate.object)
    }
    letterPlate.codePlate?.setVisible(codeUp())
    if (letterPlate.codePlate !== null && codeUp()) {
      const p = letterPlate.codePlate
      const looked = aimPlate(p.object, (o, d) => p.pick(o, d))
      if (looked >= 0 && looked !== letterPlate.codeLooked) letterPlate.codeAim = looked
      letterPlate.codeLooked = looked
      letterPlate.codePlate.update(codePlateState())
    } else letterPlate.codeLooked = -1
    // DEV-632: the phone's code field over the plate, and the room's QR code
    // beside a computer's lobby (`boot/room-share.ts`). Neither in a headset.
    {
      const flat = !render.renderer.xr.isPresenting
      const touch = capabilities.touch
      const seated =
        roomCore.room?.session.slot !== null && roomCore.room?.session.slot !== undefined
      roomShare.frame({
        field:
          flat && touch && codeUp()
            ? { typed: letterPlate.codeTyped, busy: letterPlate.codeJoining !== null }
            : null,
        qr:
          flat &&
          !touch &&
          lobbyUp() &&
          seated &&
          roomCore.roomId !== null &&
          isRoomCode(roomCore.roomId)
            ? { link: roomInviteLink(), code: roomCodeText(roomCore.roomId) }
            : null,
        // DEV-634: a phone's big START, once everyone is ready.
        start: flat && touch && roomLobby.lobbyAllReadyWas && lobbyUp(),
      })
    }

    if (router.screen === 'menu') {
      // Look around the room — right stick or mouse, already in radians and
      // already carrying the pitch-invert preference. The seat KEEPS what you
      // give it: you turned to face a table and you want to still be facing it,
      // which is the one way this differs from the cockpit's `freeLook`.
      //
      // ── NOT gated on `flight` (DEV-281) ─────────────────────────────────
      //
      // It was, and with no mission built at boot that made the level select
      // unusable: the chair would not turn, so the nose pointer could not reach
      // a holotable, so no course could be chosen — and choosing one is what
      // builds the mission this gate was waiting for. `look` is read off the
      // pad, the keyboard and the mouse directly (it is not `actions`, which
      // IS null-gated), so there was never anything here that needed a ship.
      //
      // Found by walking the room in a Playwright spec, which is the only
      // instrument that presses four aimed buttons in a row.
      //
      // ── DEV-606: a new step, or a way back in, starts the look at REST ──
      //
      // A step lays its tables out around the room's resting look, not around
      // where you are looking (the 2026-10-03 persona playtest: aimed left for
      // FLIGHT SCHOOL, and DIFFICULTY's tables appeared off to the right), and
      // EXIT from a mission put the cockpit's look into the chair (staring at
      // the floor). So the seat returns to rest when the step changes and when
      // the screen comes back to the room. FLAT ONLY: in a headset the yaw is
      // the rig's, and turning the world under somebody's head is a comfort
      // fault, not a fix.
      // DEV-620's CREDITS step is laid from CREDITS' own bearing, not around
      // rest, so it starts there (`stepStartYaw`): a rest opened it with the
      // first credit 80 degrees to the left.
      const seatKey = ctx.hangar === null ? null : ctx.hangar.view
      if (!presenting && seatKey !== ctx.seatRestKey) {
        ctx.seatLookYaw = stepStartYaw(seatKey, ctx.hangar?.firstRestBearing ?? null)
        ctx.seatLookPitch = seatPitchLocal()
      }
      ctx.seatRestKey = seatKey
      ctx.seatLookYaw += look.yaw
      // PITCH is flat-only, and it is DEV-264's other half. In the room the
      // pitch belongs to the neck: integrating a stick into it would only put
      // back on the rig the tilt the placement below just took off, one notch
      // at a time. Left un-integrated rather than merely unapplied, so that
      // leaving a session does not drop you into a pitch you accumulated
      // blind — the value you flew out on is the value you come back to.
      if (!presenting) {
        ctx.seatLookPitch = Math.max(
          -SEAT_PITCH_LIMIT,
          Math.min(SEAT_PITCH_LIMIT, ctx.seatLookPitch + look.pitch),
        )
      }
    } else ctx.seatRestKey = null // DEV-606: back in the room is a change of step.

    if (wantsFly && router.screen === 'title') {
      // Already placed above. The flight controller must not touch the camera:
      // it would put the eye back in the cockpit a frame later.
    } else if (wantsFly && router.screen === 'menu') {
      // ── seated in the hangar ────────────────────────────────────────────
      //
      // The ship still renders — it is parked on the platform in front of you,
      // which is the point — but the camera is in the CHAIR. Same rig handling
      // as the cockpit and for the same reason: in an XR session the headset
      // owns the camera's local pose, so the RIG is what moves. Moving the
      // camera instead fights the runtime and makes people ill.
      handles.flight?.render(alpha, render.camera, render.rig)
      // ── the rig is LEVEL, and the PITCH is the head's (DEV-264) ─────────
      //
      // Matt, worn, 2026-09-21: *"in our menu, the rig is tilted."* It was, by
      // **22.9° measured** off a running build — because the chair's resting
      // aim looks DOWN at the holotables (`hangar.ts:seatPitchLocal()`, 22.8°,
      // and it has to: a table is below the eye, which is what makes it a
      // table) and the WHOLE aim, pitch included, went onto the rig.
      //
      // A rig is not a camera. The headset composes the head pose UNDER it, so
      // a pitched rig rotates the world away from the player's own gravity: the
      // floor slopes, the far wall leans, and it does it for as long as the
      // menu is up rather than for a moment. `render/title.ts:760` carries the
      // same finding for the title screen — *"a rig that is not level fights
      // the vestibular sense whatever the player does"* (DEV-068) — so this is
      // the second instance of one bug, in the one place that screen's fix was
      // never carried to. **A monitor cannot show it**: on flat the rig IS the
      // whole aim and a pitched rig is just a camera looking down, which is why
      // it survived every screenshot this port has taken.
      //
      // So the aim SPLITS, the same split the cockpit's free look makes 80
      // lines below and for the same reason: **YAW on the rig, PITCH on the
      // camera's local pose, and that pose flat-only** because in session the
      // runtime owns it. Composed, `rig x camera` is the quaternion this line
      // has always produced — flat is unchanged, and `menu-screen.spec.ts`
      // still boards from the resting aim. In the room the tables simply sit
      // 22.8° below the eye, which is what a neck is for.
      //
      // `render.rig` is a `THREE.Group` this renderer always builds, so the old
      // rig-less fallback was unreachable; it is gone rather than left to hold
      // a second, now-wrong, composition of the same two angles.
      _seatLook.setFromEuler(_seatEuler.set(0, ctx.seatLookYaw, 0, 'YXZ'))
      _seatAim.copy(seatQuaternion).multiply(_seatLook)
      render.rig.position.copy(seatWorld)
      render.rig.quaternion.copy(_seatAim)
      render.camera.position.set(0, 0, 0)
      if (presenting) render.camera.quaternion.identity()
      else render.camera.quaternion.setFromEuler(_seatEuler.set(ctx.seatLookPitch, 0, 0, 'YXZ'))
      // Quick Race's loading scene, stood where the head now IS — in the
      // chair — rather than where it was at the black, on the title (DEV-353
      // follow-up; `startQuickRace`). Still under that black: this frame is
      // the one the swap happened on, and the fade has not begun to lift.
      if (ctx.loadingScenePending) {
        ctx.loadingScenePending = false
        showLoadingScene()
      }
    } else if (wantsFly && thirdPersonLive && handles.flight) {
      // ── CHANGE VIEW: the camera is outside (DEV-128) ─────────────────────
      //
      // The ship is still placed by `flight.render` — that call is what puts
      // the interpolated body pose on `flight.object` — but into a camera
      // nobody draws with, so the eye it writes goes nowhere. Then one of two
      // cameras: on the Anniversary preset the spring arm (lag, probe, bank
      // follow, `render/spring-arm.ts`); on Classic 2016's OWN chase, off the
      // sheet — detached from the ship, SmoothDamped toward a target 12.5 m
      // back, aimed at the ship, horizon level (`render/classic-chase.ts`).
      //
      // Classic used to draw `CamRoot_3rdPerson`'s PARKED pose here, welded at
      // 8.89 m, because DEV-128 read `CamChanger`'s rigid `SetParent` as the
      // whole camera. It is where the rig is parked, not where it goes: DEV-150
      // found the arm and DEV-156 ported the constraint that flies it.
      //
      // The free look orbits the arm; on the Classic chase it does nothing, as
      // it did nothing in 2016 — there is no look input on that camera at all.
      //
      // The RIG takes the pose and the camera's local pose is identity, the
      // same split as the seat and the chair. Never in session (`presenting`
      // is one of `thirdPersonLive`'s refusals), so there is no head to fight.
      handles.flight.render(alpha, _discardCamera, null)
      // ── the phone orbits the arm too (DEV-292, second home) ───────────
      //
      // Matt, having flown the cockpit version on a real phone: *"can you make
      // the tilt work for the chase-cam as well?"*
      //
      // The arm takes a yaw and a pitch as SCALARS and orbits about the ship's
      // lagged rotation, so unlike the cockpit — which takes the head
      // quaternion whole, roll and all — this one has to be decomposed. Roll
      // is dropped on purpose and not lost by accident: rolling a crane shot
      // tilts the horizon of a camera that is not your head, which is the one
      // thing `classic-chase.ts` keeps level on purpose.
      //
      // `freeLook` is still advanced with NO_LOOK while the phone is driving,
      // exactly as the cockpit does it, so the drag-look decays underneath
      // instead of waiting: switch TILT off and the arm is astern again rather
      // than wherever the last drag left it.
      //
      // **Not clamped here.** The yaw is free, which is the good part — turn
      // round and the camera walks round the ship — and the pitch is an
      // `asin`, so it is already bounded to ±90°. The arm holds its own pole
      // (`clampArmPitch`), which is where that guard belongs.
      const orbitHead = deviceLook.head()
      // `recentre` off while a menu is up — DEV-300, and the same argument the
      // cockpit branch makes below: the return is for a player at 300 m/s, and
      // a paused sim has nobody at 300 m/s.
      freeLook.update(orbitHead !== null ? NO_LOOK : look, frameSeconds, {
        recentre: !pause.paused,
      })
      const orbitYaw = orbitHead !== null ? quatYaw(orbitHead) : freeLook.yaw
      const orbitPitch = orbitHead !== null ? quatPitch(orbitHead) : freeLook.pitch
      // Recorded for `__ff2.orbitLook()`, which is how a spec asks what the arm
      // was HANDED rather than trying to recover it from where the lens ended
      // up. Assigned here, from the same two constants the call below passes,
      // so it cannot report a number the arm did not get — DEV-221's
      // bound-but-blind probe is the thing being avoided. See the handle.
      ctx.lastOrbitLook = { yaw: orbitYaw, pitch: orbitPitch, fromDevice: orbitHead !== null }
      const tp = thirdPersonNow()
      if (tp.enabled) {
        springArm.update(tp, {
          shipPosition: handles.flight.object.position,
          shipQuaternion: handles.flight.object.quaternion,
          lookYaw: orbitYaw,
          lookPitch: orbitPitch,
          dt: frameSeconds,
          surfaceHeightAt: handles.collisionTerrain.length > 0 ? surfaceHeightAt : null,
        })
        _thirdPos.copy(springArm.position)
        _thirdQuat.copy(springArm.quaternion)
      } else {
        classicChase.update(handles.flight.thirdPersonChase, {
          shipPosition: handles.flight.object.position,
          shipQuaternion: handles.flight.object.quaternion,
          dt: frameSeconds,
        })
        _thirdPos.copy(classicChase.position)
        _thirdQuat.copy(classicChase.quaternion)
      }
      render.rig.position.copy(_thirdPos)
      render.rig.quaternion.copy(_thirdQuat)
      render.camera.position.set(0, 0, 0)
      render.camera.quaternion.identity()
    } else if (wantsFly) {
      // Only the flight controller may touch the camera in fly mode. Falling
      // back to the orbit while the world loads would leave a stale LOCAL
      // offset on the camera inside the rig — see flight.ts.
      handles.flight?.render(alpha, render.camera, render.rig)
      // ── free look, in the seat ──────────────────────────────────────────
      //
      // The rig is the SHIP and the camera's local pose is the head inside it,
      // which is exactly the split a free look wants: turning your head must
      // not turn the aircraft. `flight.render` has just set that local pose to
      // identity, so this is the only thing writing it.
      //
      // Flat only. In session the runtime overwrites the camera's local pose
      // from the headset every frame — there IS a neck — and a second rotation
      // composed under it would be a view that disagrees with the head, which
      // is the mismatch that makes people ill.
      // ── the phone is a third thing that can be the head (DEV-292) ──────
      //
      // Three cases, one field. In a SESSION the runtime writes the camera's
      // local pose from a real neck and nothing here may touch it. With TILT on
      // the phone writes it, absolutely, for the reasons `device-orientation.ts`
      // gives — and it is not clamped, because the phone in your hand is the
      // proprioception the clamp exists to substitute for. Otherwise the free
      // look writes it, as it always has.
      //
      // `freeLook.update` still runs on the tilt path, with NO_LOOK, so the
      // drag-look decays to centre underneath instead of waiting there: switch
      // TILT off after a glance and the view is straight ahead, not wherever
      // the last drag left it. Same argument as `presenting`, which is why it
      // is the same expression.
      // ── and it does NOT come back while the plate is up (DEV-300) ──────
      //
      // Matt: *"look auto-reset should be off while the pause plate is up."*
      // `look` is computed a thousand lines above this, upstream of the branch
      // that zeroes `actions` for the frozen sim, so it was never zeroed — and
      // a player who stops moving the mouse TO READ THE MENU is idle by
      // definition. 0.6 s later the view swung back. Nothing was broken; a
      // flight behaviour was running under a menu.
      //
      // It is also the plate's AIMER on a flat screen: the gaze picks the row,
      // so the return was dragging the selection off whatever you were reading
      // and back into the title band, which selects nothing. `FreeLookOptions`
      // has the rest of the argument.
      const tiltHead = presenting ? null : deviceLook.head()
      freeLook.update(presenting || tiltHead !== null ? NO_LOOK : look, frameSeconds, {
        recentre: !pause.paused,
      })
      if (tiltHead !== null) {
        render.camera.quaternion.set(tiltHead.x, tiltHead.y, tiltHead.z, tiltHead.w)
      } else if (!presenting) {
        _seatLook.setFromEuler(_seatEuler.set(freeLook.pitch, freeLook.yaw, 0, 'YXZ'))
        render.camera.quaternion.copy(_seatLook)
      }
    } else {
      // Spectator orbit, driven from accumulated FIXED_DT rather than the frame
      // delta, so the same wall-clock instant gives the same camera on any
      // machine — which is what makes the screenshots comparable (D4).
      //
      // The PLAYER'S ship is placed here too (DEV-114's "one line in app.ts,
      // not yet fixed", fixed in DEV-128): only the two `wantsFly` branches
      // called `flight.render`, so in every spectator view the player's art sat
      // at the ORIGIN, 850 m from where the sim had it. Into a camera nobody
      // draws with, so the eye it writes goes nowhere.
      handles.flight?.render(alpha, _discardCamera, null)
      if (CHASE_TARGET) {
        chaseCamera(render.camera, CHASE_TARGET, handles.liveRacers, handles.flight)
      } else if (VIEWPOINT) {
        // Fixed. Placed once at boot and left alone — the whole point of a
        // viewpoint is that two screenshots of it are the same screenshot.
      } else {
        const angle = ORBIT.phase + run.elapsed * ORBIT.speed
        render.camera.position.set(
          ORBIT.target.x + Math.cos(angle) * ORBIT.radius,
          ORBIT.height,
          ORBIT.target.z + Math.sin(angle) * ORBIT.radius,
        )
        render.camera.lookAt(ORBIT.target)
      }
    }

    // DEV-436: a viewer's director camera, over whatever the mission set.
    watchCamera(frameSeconds)
    exhibition.frame(frameSeconds, alpha) // DEV-483: TV's exhibition, through TV's camera (DEV-481)
    tvPanelFrame(frameSeconds) // DEV-482: the ident, the lower third, the results, the sting

    // Ghosts run on the MISSION clock — fixed steps, never frame time. One
    // that advances on frame time races a different course on a slow machine,
    // and the whole point is that its run is comparable to yours.
    handles.liveGhosts?.update(mission.elapsed)
    // DEV-371: the player's ghost, on the LAP's clock (which flies on past your
    // finish), drawn where the ship is drawn: `flight.render` shows the body
    // `1 - alpha` of a step behind the sim, and a ghost sampled at the sim's own
    // time would lead it by that and step at 82 Hz beside a ship that does not.
    if (handles.livePlayerGhost && handles.lapRun) {
      handles.livePlayerGhost.update(
        Math.max(0, handles.lapRun.clock - (1 - alpha) * FIXED_DT),
        router.screen === 'mission' && handles.lapRun.tick >= 0,
        handles.flight ? handles.flight.object.getWorldPosition(playerGhostNear) : null,
      )
    }
    // `frameSeconds`, not the fixed step: the engine trails are camera-facing
    // ribbons sampled per frame, which is where 2016 sampled its TrailRenderer.
    //
    // And the HEAD's world position, which in a session is not the camera's —
    // every branch above has just set the camera's local pose to identity so the
    // rig can carry the eye, and `camera.getWorldPosition()` therefore composes
    // rig x identity and hands back the RIG. `render/head-pose.ts` is the one
    // door to the real thing, and DEV-199 is what it cost to find out.
    // A camera-facing ribbon told the eye is at (0, 0, 0) turns to face the
    // middle of the map instead of the viewer — the same mistake as the fog's,
    // found at the same time; see `render/unity-fog.ts`.
    readHeadPosition(render.renderer.xr, render.camera, cameraWorld)
    // The sky rides with the eye. World position, not `camera.position` — in
    // the cockpit that one is the head pose inside the XR rig, and a sky pinned
    // to the origin parallaxes against a world 4 km across.
    // The tiny jets on the holotable. Frame time, not sim time: it is
    // decoration, nothing reads it, and it keeps moving while the sim is paused.
    ctx.hangar?.update(frameSeconds)
    // DEV-440: the room's lit meshes cast and receive, and the key's box follows
    // what stands in the room. Only while the room is the stage.
    if (router.screen === 'menu') roomShadows?.update()
    // Render time, not sim time: the orbs bob and spin, and that owes the fixed
    // step nothing. `Trigger_Magnet` is disabled on every shipped instance, so
    // they do not chase the ship either.
    handles.liveOrbArt?.update(time / 1000)

    // ── the comfort layer, every frame ──────────────────────────────────
    //
    // `getWorldPosition`, never `camera.position`: in the cockpit the camera is
    // a child of the XR rig, so its local position is the HEAD POSE inside the
    // rig — the origin until you lean — while the rig carries the altitude.
    // That mistake put a pink line of 100%-fog pixels across the terrain at eye
    // level once already (trap 18), and a world-locked horizon reads the same
    // quantity.
    // ── DEV-262: the PREVIOUS frame's cost, and that is not a compromise ────
    //
    // This call sits before the render, so this frame's cost does not exist
    // yet. One frame of lag into an EMA with a 0.5 s time constant is nothing —
    // and it is the same convention the trace already documents, where `dt`
    // names the frame AFTER the one that did the work (perf-protocol §5c).
    //
    // 0 on the very first frame, which reads as a free frame for one frame and
    // is then overwritten. The seed case that matters is the EMA's, and
    // `stepAdaptive` seeds from the first sample rather than easing from zero.
    render.quality.frame(frameSeconds, perfSys.lastCostSeconds)
    horizon.setVisible(appSettings.comfort.horizon && router.screen === 'mission')
    horizon.update(cameraWorld)
    // Null RELEASES the vignette rather than freezing it. Paused, in the
    // hangar, or on the title, there is no angular rate to respond to — and a
    // tunnel left closed while somebody reads the comfort menu down it is the
    // opposite of what the menu is for. A snapped sim is the same case for the
    // same reason, and a tunnel frozen half-closed over an A/B frame would be a
    // difference between the two shots that belongs to neither preset.
    // The body's angular rate, and — on a JumpSeat — its vertical acceleration
    // over the last fixed step (DEV-383), so a jump from a pad closes the
    // tunnel as a roll does. One holder, rewritten here and read inside
    // `update`, never kept.
    const feedVignette =
      handles.flight && !pause.paused && !run.snapped && router.screen === 'mission'
    if (handles.flight && feedVignette) {
      vignetteFeed.angularVelocity = handles.flight.jet.body.angularVelocity
      vignetteFeed.orientation = handles.flight.jet.body.orientation
      vignetteFeed.verticalAcceleration = handles.flight.verticalAcceleration ?? 0
    }
    vignette.update(feedVignette ? vignetteFeed : null, frameSeconds)

    // ── DEV-277: the cloud whiteout ────────────────────────────────────
    //
    // Matt: "fade to white immediately when entering and softly fade out when
    // you exit." Instant in, linear out, on the vignette's own quad.
    //
    // It replaces something the geometry was doing by ACCIDENT. An opaque
    // near-white hull enveloping the camera reads as dense fog -- that is what
    // Matt flew through and liked -- and DEV-276 culled the back faces, which
    // removed it. This is the same effect on purpose: it can be tuned, it has
    // an onset, and it is not made of visible facets.
    //
    // Gated on the MISSION screen. In the hangar you are 95 m underground, and
    // the title valley has its own camera; neither wants a cloud interior. A
    // snapped sim is excluded for the reason the vignette above is: a whiteout
    // frozen half-faded across an A/B pair belongs to neither preset.
    const wantWhite = editionState.current.render.clouds.whiteout
    if (wantWhite > 0 && handles.liveClouds && !run.snapped && router.screen === 'mission') {
      ctx.cloudWhite = whiteoutStep(
        ctx.cloudWhite,
        handles.liveClouds.insideCloud(cameraWorld),
        frameSeconds,
        editionState.current.render.clouds.whiteoutRelease,
        wantWhite,
      )
    } else if (ctx.cloudWhite !== 0) {
      // A preset flip, a pause into the menu, or a course change must not leave
      // the screen white. Release rather than hold: the same call `vignette`'s
      // own `null` makes one line above.
      ctx.cloudWhite = 0
    }
    vignette.setWhiteout(ctx.cloudWhite)
    // The nose pointer. Recomputed every frame the menu is up, from the HEAD's
    // world pose — READ AGAIN here rather than trusting the `cameraWorld` above,
    // which `horizon.update` and two other calls have been handed since: a
    // volatile read after somebody else has held it is trap 19, and the
    // original code re-read for the same reason.
    //
    // It USED to re-read `render.camera.getWorldPosition/getWorldDirection`,
    // under a comment that named trap 18 and reached for the world pose on
    // purpose. It still aimed the menu from wherever the chair faced, because
    // the menu branch zeroed the camera's local pose 150 lines earlier and
    // rig x identity is the rig. DEV-199.
    //
    // **It no longer zeroes it, and this call is why that is safe.** DEV-264
    // levelled the rig and put the seat's PITCH on the camera's local pose on
    // flat, so `rig x identity` is no longer the aim and a reader that took
    // either half alone would now miss by 22.8° — the rig by looking level
    // over the tables, the camera by looking down from the origin. The head
    // pose is the composition, which is what it was always supposed to be.
    // The hand the room's laser came from this frame, for the lobby and the
    // options plate below, which the same ray aims. Null for the head, and
    // outside the room.
    let roomPointing: PointerHand | null = null
    // DEV-492: the bench, when it is up, takes the room's aim and both hands.
    let benchTook = false
    if (router.screen === 'menu' && ctx.hangar !== null) {
      readHeadPose(render.renderer.xr, render.camera, cameraWorld, _headQuat)
      benchTook = benchFrame(frameSeconds, cameraWorld)
    }
    if (benchTook) ctx.holotableHovered = false
    else if (router.screen === 'menu' && ctx.hangar !== null) {
      readHeadPose(render.renderer.xr, render.camera, cameraWorld, _headQuat)
      headForward(_headQuat, gazeDirection)
      // DEV-321: the laser aims the tables when a hand points, the head when
      // none does. `cameraWorld` / `gazeDirection` stay the HEAD.
      roomPointing = aimMenus()
      // DEV-389: the tables are inert while a room's lobby is up; the lobby aims below.
      // DEV-558: and while the letter plate is (it aims itself, above).
      const tablesLive = !lobbyUp() && !codeUp() && !optionsPlate.up()
      // DEV-884: in the flat hangar the FREE cursor aims the tables too (the
      // 2026-10-09 playtest: "mouse hover lights nothing"; DEV-604 had left the
      // hover out and asked). The tables are aimed through the point the cursor
      // is on, exactly as a click aims them, until the view turns or the pointer
      // is captured (`menuCursor`, above). The head still aims when no cursor is
      // free, and a headset is untouched.
      if (
        tablesLive &&
        roomPointing === null &&
        !presenting &&
        !mouseLook.locked &&
        menuReticleHost.menuCursor !== null &&
        roomTakesPoints()
      ) {
        const ray = glassRay(menuReticleHost.menuCursor.x, menuReticleHost.menuCursor.y)
        if (ray !== null) {
          _aimOrigin.copy(ray.origin)
          _aimDirection.copy(ray.direction)
        }
      }
      ctx.holotableHovered =
        ctx.hangar && tablesLive ? ctx.hangar.gaze(_aimOrigin, _aimDirection) : false
      if (roomPointing !== null && tablesLive) {
        // DEV-572: the laser's triangle under the tables' words.
        xrPointer.show(roomPointing, ctx.hangar?.aimDistance ?? null, cameraWorld, 'under')
      }
      // DEV-492: the door, when the ray is on it rather than on a table.
      benchDoorAim(ctx.holotableHovered ? null : roomPointing, cameraWorld)
    } else ctx.holotableHovered = false
    // DEV-389: the room's lobby, by the chair: shown, aimed, painted.
    lobbyFrame(roomPointing)
    // DEV-857: the hangar's OPTIONS plate: shown, aimed and painted.
    readHeadPose(render.renderer.xr, render.camera, cameraWorld, _headQuat)
    headForward(_headQuat, gazeDirection)
    optionsPlate.frame({
      seconds: frameSeconds,
      nowMs: frameT0,
      pointing: roomPointing,
      aimOrigin: _aimOrigin,
      aimDirection: _aimDirection,
      eye: cameraWorld,
      gaze: gazeDirection,
      fastHeld: confirm,
      lookYaw: ctx.seatLookYaw,
      flat: !render.renderer.xr.isPresenting,
    })

    // The nose pointer arriving on the table. On the EDGE — a held gaze is one
    // hover, not eighty a second.
    if (ctx.holotableHovered !== ctx.audioHovered) {
      ctx.audioHovered = ctx.holotableHovered
      if (ctx.holotableHovered) audio.event({ type: 'ui.focus' })
    }
    if (pause.paused && pause.pauseAim !== ctx.audioPauseAim) audio.event({ type: 'ui.focus' })
    ctx.audioPauseAim = pause.paused ? pause.pauseAim : -1
    // DEV-646: the menus that were silent. The title's rows and the room's pages
    // each keep an aim that every input writes, so the click hangs off the aim
    // changing (`input/focus-edge.ts`), and the press already plays `ui.confirm`.
    if (titleFocus.step(titleMenuUp() ? ctx.titleAim : null)) audio.event({ type: 'ui.focus' })
    if (lobbyFocus.step(lobbyUp() ? roomLobby.lobbyAim : null)) audio.event({ type: 'ui.focus' })
    if (codeFocus.step(codeUp() ? letterPlate.codeAim : null)) audio.event({ type: 'ui.focus' })
    handles.liveSky?.follow(cameraWorld)
    // The title valley's dome, same contract. Cheap, and unconditional so it
    // cannot be a frame behind on the switch. DEV-155.
    handles.titleSky?.follow(cameraWorld)
    // The far shore rides with the eye in x and z only (DEV-119).
    handles.liveHorizonGeo?.update(cameraWorld)
    // Not on the title screen: `title.update` owns the racer meshes there, and
    // two writers to one transform is the last writer winning at random.
    // DEV-358: the wing-tip trails' clock. No time while the sim is held —
    // paused, or frozen at a `?snap=` mark — so the vapour holds where it is
    // and a frozen frame photographs it. The engine trails keep frame time.
    const wingDt = pause.paused || run.snapped ? 0 : frameSeconds
    if (router.screen !== 'title')
      handles.liveRacers?.render(alpha, cameraWorld, frameSeconds, wingDt)
    // ── DEV-553: the others ride up too (DEV-461's `?arrival=rise`) ──────
    //
    // Matt, 2026-09-30: *"adopt arrival=rise"*. While the lift is within
    // `ARRIVAL_DROP` of the top, every other racer and the pad under it is
    // drawn that much lower, rising with the player's lift, so the grid
    // arrives together: on a deck, up the wells DEV-549 cut under every pad.
    // Drawn only: the sim holds every racer on its start until GO, as it
    // always has. Both looks (the DEV-553 row says why). A room starts docked,
    // so its drop is 0 from the first frame. The racers' engine trails are fed
    // before this shift, from where the ship will stand; a held ship's emitter
    // never moves the trail's `minVertexDistance` (0.25 m), so it lays no
    // ribbon there to be seen over a well.
    if (router.screen === 'mission' && ctx.launchSpec && handles.liveRacers) {
      const drop = Math.max(0, Math.min(ARRIVAL_DROP, topRise(ctx.launchSpec) - ctx.launch.rise))
      for (const ship of handles.liveRacers.ships) ship.position.y -= drop
      handles.startGrid?.arrive(drop)
    }
    // DEV-408: your ghost's two trails, from the pose placed above, facing the
    // same eye with the same two clocks.
    if (router.screen !== 'title')
      handles.livePlayerGhost?.renderTrails(cameraWorld, frameSeconds, wingDt)
    if (router.screen !== 'title') roomRender(cameraWorld, frameSeconds, wingDt) // DEV-388
    // DEV-358: the player's own wing-tip trails, facing the same eye, after the
    // camera is placed. In third person, and from the SEAT when the preset says
    // so (`fx.wingTrails.fromCockpit`): Anniversary's is true since Matt's
    // 2026-09-25 call, *"i wanna see the wing tip trails from the cockpit"*.
    // From the seat the tips are beside and behind you, so they are over your
    // shoulder rather than in the forward view. `thirdPersonLive` already
    // excludes a pause and the results; the seat arm excludes the pause only.
    if (handles.flight?.wingTrails) {
      const wing = editionState.current.fx.wingTrails
      const shown =
        router.screen === 'mission' && !pause.paused && (thirdPersonLive || wing.fromCockpit)
      // DEV-864: the inboard nudge is for the view that sees the whole ribbon;
      // from the seat the head at the tip is all the sill leaves, so it stays.
      handles.flight.wingTrails.update(
        cameraWorld,
        wingDt,
        wing,
        editionState.speedFx,
        shown,
        thirdPersonLive ? 1 : 0,
      )
    }
    // DEV-146. Same guard for the same reason: `title.update` owns whatever
    // ships are on that screen, and two writers to one transform is the last
    // writer winning at random.
    if (router.screen !== 'title') handles.liveTraffic?.render(alpha, cameraWorld, frameSeconds)

    // ── positional audio, every frame ───────────────────────────────────
    //
    // AUD-5. Two cues in the whole mix carry a position, and both are 2016's:
    // the shaft whoosh (`PlaySound3DAtVector3` from eight trigger boxes) and
    // the opposition's engines (raw `AudioSource`s, Doppler 1.04, 48/800 m).
    // Everything else emits at the listener, which is what MasterAudio's
    // non-positional branch does with the bank parented to the rig.
    //
    // The listener follows the HEAD, so this is frame work, not sim work — and
    // the head is what `readHeadPose` returns, never the camera's own world
    // pose: with the camera's local trs zeroed that is the RIG, so in the
    // hangar the listener faced wherever the CHAIR faced and did not turn when
    // you did. DEV-199 found it on the gaze; it was the same quantity here.
    readHeadPose(render.renderer.xr, render.camera, _listenerEye, _listenerQuat)
    // ONE pose object, handed to both readers. Built rather than each caller
    // reading the scratch vectors, because two calls reading the same volatile
    // between which somebody later inserts a third is exactly trap 19's shape.
    const listenerPose = {
      position: [_listenerEye.x, _listenerEye.y, _listenerEye.z] as const,
      forward: _listenerForward.set(0, 0, -1).applyQuaternion(_listenerQuat).toArray(),
      up: _listenerUp.set(0, 1, 0).applyQuaternion(_listenerQuat).toArray(),
    }
    audio.setListener(listenerPose)
    // DEV-645: the soundtrack listens. One filter pair on the music bus, off the
    // game's own state (`audio/music-filter.ts` is the curve): closed through a
    // pause and a crash's black, lifted while boost burns, and a race's floor
    // opening over its last three gates. Never a volume.
    audio.setMusicListening({
      paused: router.screen === 'mission' && pause.paused,
      crashBlack: router.screen === 'mission' && crashHoldsShip(run.crash),
      boosting: ctx.boostBurning,
      racing:
        router.screen === 'mission' &&
        (!ctx.launchSpec || ctx.launch.phase === 'flying') &&
        !mission.finished,
      gatesLeft: mission.countTotal > 0 ? Math.max(0, mission.countTotal - mission.counted) : null,
    })
    // The collars, off the eye's altitude. Cheap, and a no-op with no elevator.
    if (router.screen === 'mission') audioShaft()
    // One engine per racer, moved to the INTERPOLATED pose `render()` just
    // wrote — not to the sim pose. The sim is 81.967 Hz against a 72/90/144 Hz
    // display, so on the frames with no tick the sim pose does not move: the
    // Doppler would read zero closing speed and then spike on the next tick,
    // which is a warble rather than a pass. Same beat the meshes had before
    // they were interpolated (D4), heard instead of seen.
    //
    // By NAME, not by child index: the group holds a trail object beside every
    // racer, so `children[i]` is a racer for even `i` and a ribbon for odd.
    if (handles.liveRacers && router.screen === 'mission' && !pause.paused) {
      const racers = handles.liveRacers
      audio.racerEngines.sync(
        racers.racers.map((racer) => {
          const node = racers.group.getObjectByName(`racer:${racer.spec.id}`)
          const at = node ? node.getWorldPosition(_racerWorld) : _racerWorld.set(0, 0, 0)
          // The SIM velocity, not a frame difference of the interpolated pose:
          // this feeds a pitch curve, not a Doppler, and the sim's own number
          // is the one the player's `stepFlight` is given (DEV-137).
          const v = racer.jet.body.velocity
          return {
            id: racer.spec.id,
            position: [at.x, at.y, at.z] as const,
            speed: Math.hypot(v.x, v.y, v.z),
            finished: racer.finished,
          }
        }),
        listenerPose,
        frameSeconds,
      )
    } else if (roomCore.roomShips && router.screen === 'mission' && !pause.paused) {
      // DEV-388: the others' engines, through the racers' engines (§6.4).
      audio.racerEngines.sync(roomCore.roomShips.audio(), listenerPose, frameSeconds)
    }

    // ── DEV-641: a place changing is said ──
    //
    // (The whoosh for a ship going by is driven from `flybyFeel`'s result, where
    // the shake and the tick already are: one detector, one pass.)
    if (handles.flight && router.screen === 'mission' && !pause.paused) {
      // The place: `race-place.ts`'s own rule, read per racer, so this watches
      // the number the race map and the results panel show. Only while the race
      // is on and the run has not ended; the line is the race map's when there is
      // one and the racers' own when there is not (a Classic look has no map).
      const overtakeLine =
        results.raceMapLine ??
        (roomActive()
          ? (roomMapField()?.line ?? null)
          : (handles.liveRacers?.guide ?? handles.liveRacers?.racers[0]?.fallbackCourse ?? null))
      if (overtakeLine) {
        const limit = raceTimeLimit(ctx.level, mission.mode)
        const readings: RacerPlaceReading[] = [
          ...(handles.liveRacers?.racers ?? []).map((racer) => ({
            standing: racerStanding(racer, limit),
            progress: raceProgress(overtakeLine, racer.course.passed, racer.jet.body.position),
          })),
          ...roomPlaceOthers(overtakeLine),
        ]
        const change = overtakeWatch.step(
          readings,
          raceProgress(overtakeLine, mission.course.passed, handles.flight.jet.body.position),
          (!ctx.launchSpec || ctx.launch.phase === 'flying') &&
            !mission.finished &&
            run.lastResult === null,
          frameSeconds,
        )
        if (change) {
          audio.event({ type: 'race.position', gained: change.gained })
          // The racer's name over the position for two seconds, on the event row
          // and only when nothing else holds it: a gate is what you did on purpose.
          if (!(run.award && mission.elapsed < run.award.until)) {
            run.award = {
              text: overtakeLabel(change),
              tone: change.gained ? 'gain' : 'loss',
              until: mission.elapsed + OVERTAKE.nameSeconds,
            }
          }
        }
      }
    }

    if (handles.flight) {
      const v = handles.flight.jet.body.velocity
      // The ship's effects are speed-driven, and 2016 measures FORWARD speed
      // rather than the velocity magnitude — sideways drift does not light the
      // afterburner. `Ship_HoverShip` reads `ForwardSpeed`.
      if (handles.liveFx) {
        const f = handles.flight.object.matrixWorld
        handles.liveFx.updateShip(f, forwardSpeedOf(handles.flight))
        // DEV-416: the JumpSeat's own thruster, afterburner, ground and wind.
        const seatFx = seatEffectsOf(handles.flight)
        if (seatFx) handles.liveFx.updateSeat(f, seatFx)
        // DEV-836: the exterior hull's flames, outside the cockpit only.
        handles.liveFx.updateExternal(
          f,
          thirdPersonLive,
          handles.flight.engineAsk?.thrusting ?? false,
          handles.flight.engineAsk?.boosting ?? false,
        )
        // DEV-429: the sea's spray under a HoverJet skimming it. The body's
        // own SIM numbers; `active` is the buffet's three "no"s — the hangar,
        // the pause and the lift — and the preset and the slider are read live.
        handles.liveFx.updateSpray({
          position: handles.flight.jet.body.position,
          velocity: handles.flight.jet.body.velocity,
          active: router.screen === 'mission' && !pause.paused && !launchHoldsShip(ctx.launch),
          speedFx: editionState.speedFx,
          spec: editionState.current.fx.waterSpray,
        })
      }
      // The passed gates' fade (DEV-122), on the run's own clock. Cheap when
      // nothing is mid-fade; reads the preset live so a flip mid-run takes.
      //
      // `mission.course.inside` is the third argument since DEV-195: it is the
      // sim's own record of which trigger spheres the ship is in, and handing
      // it over is what makes the Anniversary shrink start when you LEAVE a
      // gate rather than ~22 m before you reach it. Read here rather than
      // measured there, so there is one containment test in the build.
      if (tvActive() || roomCore.watch !== null) {
        // DEV-869: FF-TV and watch links show every ring at full size, always.
        // `reset` is a no-op once every gate is already whole.
        handles.liveRings?.reset()
      } else {
        handles.liveRings?.update(
          mission.elapsed,
          editionState.current.gates.passedFade,
          mission.course.inside,
        )
      }
      // The next-gate arrow (DEV-124). `nextTargetSim` answers in SIM space;
      // the ship's matrix is fresh here (the FX above read it), so the target
      // goes world -> ship-local through it and the arrow aims in the frame it
      // is mounted in. Null hides it, and so does the Classic flag.
      //
      // DEV-159, Matt: *"only enable the 'next gate' arrow when the race has
      // started"*. `!launchHoldsShip(launch)` is this build's ONE answer to
      // that — the same predicate the cockpit shake and the speed lens gate on,
      // below — rather than a second reading of the countdown that could drift
      // from it. `update(null, ...)` hides the arrow outright, so a restart
      // cannot leave a stale one pointing at the last run's gate.
      {
        const target = nextTargetSim(
          mission,
          handles.flight.jet.body.position,
          !launchHoldsShip(ctx.launch),
        )
        if (target) {
          // DEV-892: with the nose near vertical the arrow points the HORIZONTAL
          // way round, not at the sky end of the dash.
          const aimed = arrowTargetForPitch(
            target,
            handles.flight.jet.body.position,
            pitchDegrees(handles.flight.jet.body.orientation),
          )
          // Unity -> three: negate z. The same flip `flight.render` applies to
          // the ship itself, so the two cannot disagree about which side is left.
          arrowTarget.set(aimed.x, aimed.y, -aimed.z)
          handles.flight.object.worldToLocal(arrowTarget)
        }
        handles.flight.nextGateArrow.update(
          target ? arrowTarget : null,
          handles.flight.eye,
          editionState.current.hud.nextGateArrow,
        )
      }
      // Every panel below is a COCKPIT panel. From the chair they would hang in
      // mid-air eight metres away, inside a jet you are not sitting in.
      const inCockpit = router.screen === 'mission'

      // The results panel, up only while a finished run is on screen. Cleared
      // by `restartRun`, which is what makes "press A to fly again" mean
      // something rather than being a label on a dead button.
      handles.flight.results.setVisible(inCockpit && run.lastResult !== null)
      // The standings are re-read HERE, every frame the panel is up, because
      // the race is not over when the player's run is: a racer's time fills in
      // the frame it crosses (DEV-344). `update` redraws only on a change.
      if (run.lastResult) {
        handles.flight.results.update(
          withStandings(
            roomPanelRun(withResultsBoard(withShare(run.lastResult))), // DEV-431: the board
            [...opponentStandings(), ...roomPanelOpponents()], // DEV-390
            playerGhostStandings(),
            readHandle(), // DEV-855: beside YOU, where the device has one
          ),
          // DEV-650: the panel animates in on this clock. The medal's stamp has a
          // hook, `flight.results.onStamp(headline)`, left unwired: DEV-644's
          // per-tier cue already plays on the award (`run.medal`, `MEDAL_CUES`).
          frameT0,
        )
      }
      askFrame(inCockpit && !thirdPersonLive) // DEV-571: the questions, under the panel

      // ── the pause menu, and what you are looking at ──────────────────
      //
      // The aim is recomputed every frame the menu is up, from the camera's
      // WORLD pose — in the cockpit `camera.position` is the head pose inside
      // the XR rig, and a menu aimed with the local one would be selectable
      // only from wherever the rig happens to be. The same mistake cost two
      // days on the fog (trap 18).
      // The HUD comes DOWN while the menu is up. Both are world-space panels
      // roughly a metre in front of the same eye, and the pause plate is 92%
      // opaque rather than 100 — so the gate count and the clock read straight
      // through it, which looks like a rendering bug and puts a live-looking
      // clock on a stopped run. 2016 never has both up either: `Pause()` shows
      // `panel_pause` over a cockpit whose own panels sit lower in the frame.
      // A run that ends while the menu is up closes it, rather than leaving two
      // panels arguing over the confirm button.
      if (run.lastResult) pause.paused = false
      // DEV-571: and while the questions after a lap hang over the console, for
      // the same reason: the readout read straight through the 92% plate.
      handles.flight.hud.object.visible =
        inCockpit && !pause.paused && !(lapAskUp() && !thirdPersonLive)
      // ── the readout, when the camera is outside (DEV-128) ─────────────
      //
      // The same panel, RE-PARENTED to the lens as a screen-space plate along
      // the bottom of the frame — which is how 2016's own third-person
      // screenshots carry SPEED / GATES / TIME (the GearVR build's
      // `Ship_HUD 3rd Person` sits under `CamRoot_3rdPerson`, so 2016 did the
      // same thing one level down). A console readout 24 m away is unreadable
      // and a run with no clock is a different game; hiding it was the other
      // option, and this one costs nothing because the panel is already
      // `depthTest: false` at `renderOrder` 10. Head-locked, and fine: this
      // camera never exists in a headset. Back on the ship — at the preset's
      // seat, with any Placement patch (DEV-129) — the frame the camera returns.
      {
        const tp = thirdPersonNow()
        const hud = handles.flight.hud.object
        // DEV-362: the HoverJet's panel hangs on its ART PIVOT, set into the
        // dash; on the lens it is the flat plate it always was, so the chase
        // camera's readout is unchanged. `placeHud` sets it back into the dash.
        const seat = handles.flight.hudMount ?? handles.flight.object
        if (thirdPersonLive) {
          if (hud.parent !== render.camera) render.camera.add(hud)
          handles.flight.hud.setMount('lens')
          hud.position.set(tp.hudOffset[0], tp.hudOffset[1], tp.hudOffset[2])
          hud.rotation.set(0, 0, 0)
          hud.scale.setScalar(tp.hudScale)
        } else if (hud.parent !== seat) {
          seat.add(hud)
          handles.flight.placeHud(hudPlacementNow())
          // The plate does NOT follow the HUD onto the chase camera: it is a
          // cockpit instrument for a headset, and that camera never exists in
          // one. It stays on the ship and the feed below turns it off.
          if (perfPlate && perfPlate.object.parent !== handles.flight.object) {
            handles.flight.object.add(perfPlate.object)
            perfPlate.place(hudPlacementNow(), PLATE_SIDE, handles.flight.eye)
          }
        }
      }
      // Down while the menu is up, for the same reason the HUD is: two panels
      // a metre from one eye, and only one of them is being asked a question.
      // And down while the camera is outside: it is a cockpit plate, a metre
      // from a seat nobody is in, and the launch banner on the readout carries
      // the countdown to the lens anyway.
      // DEV-377: a lesson's plate REPLACES the briefing — one plate, and step
      // 0's text is what that slot says (plan §5.1).
      // DEV-526: it fades out on the way up, so the opacity is set every frame
      // (and is back at 1 on the pad of the next run).
      const briefingNow = briefingLevel()
      handles.flight.briefing.setVisible(
        inCockpit && briefingNow > 0 && !pause.paused && !thirdPersonLive && !lessonHost.liveLesson,
      )
      handles.flight.briefing.setOpacity(briefingNow)
      if (briefingNow > 0) {
        handles.flight.briefing.update(briefingState())
      }
      frameLesson({
        alpha,
        wingDt,
        frameSeconds,
        eye: cameraWorld,
        thirdPerson: thirdPersonLive,
      })
      handles.flight.pause.setVisible(inCockpit && pause.paused)
      if (pause.paused) {
        // The HEAD, not the camera. `flight.render` zeroes the camera's local
        // pose every frame for the same reason the menu branch does — the rig
        // carries the eye in a session — so the old `camera.getWorldPosition/
        // getWorldDirection` pair here picked the row the SHIP was pointing at
        // and never moved when you looked down the plate. Same root cause as
        // the holotables, same one door. DEV-199.
        readHeadPose(render.renderer.xr, render.camera, cameraWorld, _headQuat)
        headForward(_headQuat, gazeDirection)
        // DEV-321: the laser, when a hand points; the head otherwise. The beam
        // ends on a plate only when it is on a ROW — a hit on the title band
        // selects nothing, so it reads as a miss.
        const pointing = aimMenus()
        // The gaze OVERRIDES the stick, but only when it is actually on a row.
        // A miss leaves the stick's choice standing, which is what makes the
        // flat-screen case work at all — see `pauseAim`.
        //
        // One page, three consumers — the picker, the painter and the probe —
        // see `pausePlate`. The heading used to be a second ladder written out
        // here, which is how a plate could in principle draw one page's rows
        // under another page's title.
        const plate = pausePlate()
        const looked = handles.flight.pause.pick(_aimOrigin, _aimDirection, plate.rows.length)
        if (pointing !== null) {
          const hitPlate = looked >= 0 ? handles.flight.pause.object : null
          xrPointer.show(
            pointing,
            hitPlate ? planeHitDistance(_aimOrigin, _aimDirection, hitPlate) : null,
            cameraWorld,
          )
        }
        // DEV-563 follow-up: not over a row the free cursor chose.
        if (looked >= 0 && !menus.pauseCursorAim && !phoneUi.on) pause.pauseAim = looked
        // DEV-623: the CREDITS page is a roll in the plate's body over one
        // row, BACK. Hung on THIS flight's plate (a course swap builds a new
        // one), shown only while the page is up, and fast while A is held or
        // just after a press.
        const rolling = plate.page === CREDITS_OPTION.id
        if (rolling) {
          const roll = creditsRollFor()
          if (roll.object.parent !== handles.flight.pause.object)
            handles.flight.pause.object.add(roll.object)
          roll.object.visible = true
          roll.update(
            frameSeconds,
            (confirm && pause.pauseAim !== 0) || frameT0 < menus.creditsFastUntil,
          )
        } else if (menus.creditsRoll !== null) menus.creditsRoll.object.visible = false
        // DEV-796: a phone chooses by tap, so the panel rides up clear of its bottom edge.
        if (phoneUi.on) {
          // DEV-894: a phone's plate is scaled up and centred (`phone-floor.ts`).
          const fit = pausePhoneFit(plate.rows.length, TITLE_M + (rolling ? CREDITS_BODY_M : 0))
          handles.flight.pause.object.scale.setScalar(fit.scale)
          handles.flight.pause.setLift(fit.lift)
        } else handles.flight.pause.setLift(PANEL_LIFT)
        handles.flight.pause.update({
          // DEV-623: the roll's body. DEV-861: no choose footer on any plate.
          ...(rolling
            ? {
                body: CREDITS_BODY_M,
              }
            : {}),
          options: plate.rows,
          // DEV-859: the settings pages show a note for the selected row only.
          notesOnSelect: plate.page !== ROOT_PAGE,
          selected: pause.pauseAim,
          // 2016's own heading, spaces and all — `level.ui.strings.pauseTitle`.
          title: plate.title,
        })
      }

      // DEV-243. Re-asserted every frame, and a no-op whenever the cadence is
      // already in force. Here rather than at the panel's construction because
      // `flight` is rebuilt on every course swap (DEV-077 rebuilds the world
      // without a reload) and `__ff2.hud()` flips it on a live page: an
      // assignment in the loop is correct across both without a hook to find
      // and without a second place that has to remember.
      handles.flight.hud.setRedraw(ctx.hudRedraw)
      // DEV-244, and re-asserted here for the same reason and with a sharper
      // edge on the no-op: every one of the three fields this sets is in
      // three's texture CACHE KEY (`three.module.js:11533`), so a write that
      // changes one reallocates the whole `WebGLTexture`. `setUpload` returns
      // early when the mode is already in force, which is what makes calling it
      // ninety times a second correct rather than catastrophic.
      handles.flight.hud.setUpload(ctx.hudUpload)
      // DEV-256, and the no-op guard is load-bearing here in the strongest
      // sense on this object: a real change REBUILDS the canvas, the
      // `CanvasTexture` and the material's map, so calling this ninety times a
      // second without `setRaster`'s early return would rebuild them ninety
      // times a second. What this line is FOR is the course swap — the panel
      // is constructed with `hudRaster` already (see `loadFlight` above), so on
      // an ordinary frame this returns immediately and the assignment exists to
      // make a live `__ff2.hudRaster()` flip survive a rebuild it did not see.
      handles.flight.hud.setRaster(ctx.hudRaster)
      // DEV-257, re-asserted here for the other two pins' reason — the panel is
      // rebuilt on every course swap and `__ff2.hudGauges()` flips it on a live
      // page. The no-op guard carries more weight on this one than on either of
      // the others: a switch disposes and rebuilds a `BufferGeometry` and a
      // `Material`, so an unguarded call would do that ninety times a second —
      // and with the pin at `off` the guard is what makes "nothing is ever
      // constructed" true on every frame rather than only on the first.
      handles.flight.hud.setGauges(ctx.hudGauges)
      // DEV-397. The run's clock STOPS at the finish, so an award's `until` in
      // it could never pass there, and it held the medal's line for good:
      // `BOOST READY` after every lap. `game/award-line.ts` has the rule.
      const settled = settleAward(run.award, mission, run.awardLatch, frameT0)
      run.award = settled.award
      run.awardLatch = settled.latch
      // DEV-649: a split, while one is up, TAKES the event line (the dash's and
      // the lens plate's, so a headset has it): two seconds, in the gain or loss
      // ink. Never once the run is over, where the line is the medal's.
      const liveSplit = mission.finished ? null : splits.current(mission.elapsed)

      handles.flight.hud.update(
        {
          // The OBJECTIVE's progress, whatever the objective is — rings in Ring
          // Attack, pad plates in Target Practice, orbs in Free Flight. Not
          // `ringsPassed`, which stays ring-shaped: `rookie_02_jumpSeat` authors
          // 29 live rings alongside its 11 pads and scores none of them.
          ringsPassed: mission.counted,
          ringsTotal: mission.countTotal,
          score: missionScore(mission),
          elapsed: mission.elapsed,
          // Free Flight has no clock at all (`RaceTimer.cs:30` disables itself),
          // so the panel must not print one counting toward a limit that will
          // never arrive.
          timeLimit: hudTimeLimit(ctx.level, mission.mode),
          // DEV-200. 2016's TIME row is `Timer_Race.GetRemainingTime()` —
          // `(maxRaceTime - currentRaceTime)`, counting DOWN — and this port
          // printed the elapsed seconds instead for the whole life of the panel.
          //
          // `clockEnds` and not `clock` is the question, and the difference is the
          // whole of DEV-056: a countdown is a promise that running out does
          // something. It does in Ring Attack, where the timeout finds the
          // `Trigger_FinishLine` every HoverJet scene carries. It does not in
          // Target Practice, where no JumpSeat scene has one — and 2016 drew no
          // TIME row on a JumpSeat at all (DEV-201), so that row is FF2's own and
          // keeps counting up rather than sitting on `00` for the fifty seconds
          // `adv_01_jumpSeat` takes past its unenforced limit.
          //
          // The MODE decides and the panel is told, exactly as the preset decides
          // `speedUnit` and the panel is told: `render/hud.ts` never imports
          // `game/modes.ts` and never learns what a mode is.
          timeCountsDown: rulesFor(mission.mode).clockEnds,
          speed: Math.hypot(v.x, v.y, v.z),
          // Null where the MODE awards no medal, which is the honest answer for
          // Target Practice — 2016 awards none, and printing "NONE" would turn
          // "this mode has no medal" into "you failed to earn one".
          medal: medalFor(mission, ctx.level) ?? '',
          finished: mission.finished,
          award: liveSplit
            ? splitLine(liveSplit)
            : run.award && mission.elapsed < run.award.until
              ? run.award.text
              : null,
          awardTone: liveSplit ? splitTone(liveSplit) : (run.award?.tone ?? 'gain'),
          // 1 means no streak, and `hud.ts` draws nothing for it.
          multiplier: streakMultiplier(mission),
          // ── G2's instrument (DEV-110): the GATES line's bar (DEV-615) ──
          //
          // G1's proximity meter was the other instrument here until DEV-615
          // (Matt, 2026-10-03: *"just boost and gates"*). Its mechanic still
          // runs and still announces each payout on the event line (`LOW +N`);
          // the panel no longer carries the meter.
          //
          // The chain is 2016's OWN mechanic and it runs on both presets; what
          // Anniversary adds is being able to see it. `fraction` is how much of
          // the cooldown is left, off the sim's own state against the prefab's
          // `maxCooldownTime` — no number of this module's own, so the bar cannot
          // disagree with the mechanic it reports.
          // DEV-791: and only where the look draws bars (Classic draws none).
          chain:
            editionState.current.gameplay.chainMeter.enabled &&
            editionState.current.hud.bars.enabled
              ? {
                  stacks: handles.flight.jet.chain.stacks,
                  fraction:
                    HOVERJET.energy.maxCooldownTime > 0
                      ? Math.max(
                          0,
                          1 - handles.flight.jet.chain.sinceGate / HOVERJET.energy.maxCooldownTime,
                        )
                      : 0,
                }
              : undefined,
          // THE TANK GAUGE, on the TIME row. Same absent-is-not-zero rule as the
          // two above: a vehicle with no tank draws no gauge rather than a gauge
          // that is permanently full.
          //
          // ONE gauge, THREE mechanics, and no two are ever live together, so the
          // chain below is a selection and not a priority rule:
          //
          //  · the ENERGY RACE's tank (DEV-144), where it IS the run, so
          //    `available` carries `powered` and a dead ship reads as a muted
          //    empty bar rather than as a bar that vanished;
          //  · the JUMPSEAT's fuel (DEV-201) — **2016's only JumpSeat instrument**.
          //    `JumpSeat_Photon`'s `panel_jumpSeatUI` holds `Fuel :` and `100%`
          //    and they are the only live labels on that panel; the whole of
          //    `panel_shipUI` is authored inactive and nothing can switch it on.
          //    `FuelManager.cs:95-97` drives it. So this gauge is on BOTH PRESETS
          //    — it is not an Anniversary addition, it is a 2016 reading the port
          //    has simulated since DEV-057 and never once drawn. `lit` is the
          //    thruster latch, which is a different state from an empty tank:
          //    the tank goes negative and a pad has to fill it back past zero
          //    before the engine relights, and those two look identical unless
          //    the panel inks them apart;
          //  · the HOVERJET's Anniversary boost tank (DEV-143), which is flagged.
          //  · the GLIDER's rocket (DEV-399), through `flight.fuel` like the
          //    JumpSeat's: a tank that burns while the boost trigger is held
          //    and refills once it is released. `lit` is "fuel to burn".
          //
          // The JumpSeat's row comes BEFORE the HoverJet's flag for clarity only;
          // `flight.fuel` is absent on a HoverJet and `energy.enabled` already
          // guards on the vehicle.
          energy: rulesFor(ctx.RUNNING_MODE).energyPowered
            ? {
                fraction: energyRaceFraction(
                  run.energyRace,
                  energyRaceSpec(
                    editionState.current.gameplay.energyRace.drainScale,
                    editionState.current.gameplay.energyRace.gatePayFraction,
                  ),
                ),
                available: run.energyRace.powered,
              }
            : handles.flight.fuel
              ? { fraction: handles.flight.fuel.fraction, available: handles.flight.fuel.lit }
              : // DEV-791: the HoverJet's tank is a bar, and Classic draws none.
                editionState.current.gameplay.energy.enabled &&
                  editionState.current.hud.bars.enabled &&
                  ctx.level.vehicle === 'hoverjet'
                ? {
                    fraction: energyFraction(
                      run.energy,
                      energySpec(editionState.current.gameplay.energy.rechargeScale),
                    ),
                    available: boostAvailable(run.energy),
                    // DEV-567: READY or BOOST, and where a dry tank comes back.
                    burning: run.energy.lit,
                    reengage: editionState.current.gameplay.energy.reengage,
                  }
                : undefined,
          // DEV-399: the glider's stall margin, the other half of its HUD row
          // (the rocket arrives as `flight.fuel` above). Absent on every
          // aircraft whose wing cannot let go, which draws no bar.
          stall: handles.flight.stall,
          // 2016 labels the count by mode: GATES in Ring Attack, ORBS where orbs
          // are the objective. Both appear in Matt's screenshots of this level.
          countLabel: countLabel(ctx.level, mission.mode),
          // `Time:` -> `TIME`, `Speed :` -> `SPEED`. The row appends the colon.
          timeLabel: uiLabel(ctx.level, 'timeLabel', 'TIME'),
          speedLabel: uiLabel(ctx.level, 'speedLabel', 'SPEED'),
          // DEV-360. `Fuel :` -> `FUEL`, for the JumpSeat's dome; the rows never read it.
          fuelLabel: uiLabel(ctx.level, 'fuelLabel', 'FUEL'),
          // DEV-383. The spider's charge ring on the same dome; undefined on
          // every other seat, and 0 on a spider that is not charging.
          jumpCharge: handles.flight.jump?.charge,
          // S8, DEV-083. `speed` above stays METRES PER SECOND whatever this says
          // — the panel converts for display and nothing else in the game learns
          // about it. `ms` on Classic is the row exactly as it shipped.
          speedUnit: editionState.current.hud.speedUnit,
          banner: launchBanner(),
          autopilot: pilot.autopilot,
        },
        // THIS frame's clock, not a second `performance.now()`. Two calls in
        // one frame are two different numbers, and a cadence paced off one
        // while `hud_paints` recorded the other would be a rate nobody could
        // reproduce from the CSV.
        frameT0,
      )

      // DEV-361: the race map beside the readout, and the place on it — on the
      // panel's cadence, so `__ff2.hud(...)` moves both. No place before the
      // release: nobody is racing yet, and the grid's order is not a result.
      syncRaceMap(handles.flight.hud.object)
      // DEV-362: in the dash the map shares the upper screen, against its right
      // edge, and the text column narrows for it; on the lens it keeps its own
      // place beside the panel. Guarded, so every frame costs a compare.
      handles.flight.hud.setSidePlate(
        results.raceMap?.object ?? null,
        editionState.current.hud.raceMap.widthMetres,
      )
      // DEV-840: the map stays dark until the power-on sequence is done (the
      // pad's wait and the platform's rise); its slot is kept so the text
      // column does not jump when it lights.
      if (results.raceMap) {
        results.raceMap.object.visible = !(
          ctx.launchSpec &&
          (ctx.launch.phase === 'waiting' || ctx.launch.phase === 'rising')
        )
      }
      ctx.stripPlace = null
      if (results.raceMap && results.raceMapLine && (handles.liveRacers || roomActive())) {
        results.raceMap.setRedraw(ctx.hudRedraw)
        const placeNowValue =
          !ctx.launchSpec || ctx.launch.phase === 'flying'
            ? placeNow(
                results.raceMapLine,
                run.lastResult && roomPanelRun(run.lastResult),
                { passed: mission.course.passed, position: handles.flight.jet.body.position },
                handles.liveRacers?.racers ?? [],
                raceTimeLimit(ctx.level, mission.mode),
                roomPlaceOthers(results.raceMapLine), // DEV-390
              )
            : null
        ctx.stripPlace = placeNowValue
        results.raceMap.update(
          {
            player: handles.flight.jet.body.position,
            // DEV-432: the mark points along the nose. SIM space, like the position.
            playerOrientation: handles.flight.jet.body.orientation,
            // DEV-390: in a room, the other players as drawn.
            racers: handles.liveRacers
              ? handles.liveRacers.racers.map((r) => r.jet.body.position)
              : roomMapDots(handles.flight.jet.body.position),
            // DEV-373: the ghost, SIM space (its mesh is THREE space: z flips).
            ghost:
              handles.livePlayerGhost?.active === true
                ? {
                    x: handles.livePlayerGhost.object.position.x,
                    z: -handles.livePlayerGhost.object.position.z,
                  }
                : null,
            place: placeNowValue,
          },
          frameT0,
        )
      }
    }

    // DEV-649: the flat screen's race strip, from this frame's place.
    syncRaceStrip(frameT0)

    // LOD. A distance test per chunk and, in the common case, no work at all —
    // the regeneration itself happens in a worker, so a level change costs a
    // `postMessage` here and a geometry swap whenever the reply lands.
    if (handles.liveTerrain) {
      // The HEAD's world position (DEV-199), which in a session the camera's own
      // is not — every eye-placing branch zeroes the camera's local trs, so
      // `camera.getWorldPosition()` is the rig and loses the lean. It is
      // centimetres for an LOD ring and it decides a shader variant at the
      // waterline, which is exactly where centimetres are the whole question.
      const p = readHeadPosition(render.renderer.xr, render.camera, _cameraWorld)
      // The frame delta advances the cross-fades (DEV-130): render time, like
      // the waves below, and for the same reason.
      handles.liveTerrain.terrain.updateLod(p.x, p.z, frameSeconds)
      handles.liveTerrain.ocean?.updateLod(p.x, p.z, frameSeconds)
      // The waves. Render time, not sim time, and deliberately: 2016 drives
      // this from `LowPoly_Displace.Update()` against `Time.time`, and the water
      // is visual only — nothing in `src/sim` can see it, so it does not owe the
      // fixed step anything.
      // `p.y` picks the sea's shader variant (DEV-167 / W6): above the water
      // the plate draws FrontSide with no `discard` in it, which is what
      // hardware back-face culling and an early depth test need. The camera's
      // WORLD y — `camera.position` in the cockpit is the head pose inside the
      // rig and is the origin until you lean (CLAUDE.md trap 18).
      handles.liveTerrain.ocean?.setWaveTime(time / 1000, p.y)
      handles.liveTerrain.terrain.setWaveTime(time / 1000)
    }

    // Particles run on RENDER time for the same reason the waves do: 2016 steps
    // them in Update() against the frame delta, and nothing in `src/sim` can see
    // them. `frameSeconds` is clamped because a tab that was backgrounded for
    // ten seconds should not spawn ten seconds of gate spray in one frame.
    // DEV-868: the others' rings. An AI racer (single player, a room's bots,
    // FF-TV's exhibition) is read off its own course; a room player, who has
    // only a drawn position here, is stepped over the same sim trigger test.
    // Bursts only: the gate itself is hidden by the player's pass alone.
    if (
      handles.liveFx &&
      router.screen === 'mission' &&
      !pause.paused &&
      mission.course.gates.length > 0
    ) {
      let watch = ringTakeWatches.get(handles.liveFx)
      if (!watch) {
        watch = createRingTakeWatch(mission.course.gates)
        ringTakeWatches.set(handles.liveFx, watch)
      }
      watch.begin(time / 1000)
      if (handles.liveRacers) {
        for (const racer of handles.liveRacers.racers) {
          watch.watchPassed(`racer:${racer.spec.id}`, racer.course.passed)
        }
      }
      const shipsDrawn = roomCore.roomShips?.drawn()
      if (shipsDrawn) {
        for (const d of shipsDrawn) {
          const id = `room:${d.slot}`
          if (d.slot >= 0 && d.drawn) watch.watchPosition(id, d.position)
          else watch.forget(id)
        }
      }
      for (const gate of watch.takes) handles.liveFx.burstRing(gate)
    }
    handles.liveFx?.update(Math.min(frameSeconds, 0.1), render.camera)

    // ── Anniversary systems, per frame ───────────────────────────────────
    //
    // The per-frame half of the block of the same name at boot. Render time,
    // like the particles above, and for the same reason: nothing in `src/sim`
    // can see a preset. A system that draws nothing on Classic still gets its
    // call — the preset decides, not the caller — so a flip needs no rewiring.

    // S3, DEV-083: the COCKPIT buffets, the rig never does. After
    // `flight.render()` above, which is where the lean lands on the same pivot;
    // both recompose the whole pose, so the order is not load-bearing.
    //
    // `active` is three separate "no" answers, none of which a speed can give:
    // the hangar (the ship is parked and you are in a chair), the pause menu
    // (the run is frozen and so is the air — and the pause plate hangs off the
    // SHIP group, so a shaking pivot would leave it still while the cockpit
    // around it moved, which is right, but a menu you are aiming at deserves a
    // motionless frame anyway), and the elevator ride, where the body is
    // kinematic and going straight up.
    if (handles.flight) {
      handles.flight.shake(
        // DEV-528: the preset's block, or `?lookdev=1`'s weights once moved.
        shakeLookdev.shake(editionState.current.cockpit.shake),
        editionState.speedFx,
        time / 1000,
        forwardSpeedOf(handles.flight),
        router.screen === 'mission' && !pause.paused && !launchHoldsShip(ctx.launch),
        // DEV-364 follow-up: a racer's hit, on the same waveform, for a moment.
        // DEV-642/643: and the feel layer's own blows (crash, prop strike, near
        // miss, GO), through the same waveform; the stronger of the two wins.
        Math.max(
          hitJoltGain(editionState.current.gameplay.racers.hit, hitJolt, time / 1000),
          cockpitJoltGain(feel.cockpitJolt, time / 1000),
        ),
      )
    }
    // DEV-636/637: the feel layer's clock. Trauma decays on render time; the
    // haptic scheduler is held under any menu (the run is frozen, so is the
    // rumble) and stepped on the performance clock.
    feel.cameraShake.step(frameSeconds)
    feel.haptics.setHeld(pause.paused || router.screen !== 'mission')
    feel.haptics.update(performance.now())
    // DEV-636: a racer whooshing past rattles the camera and ticks the hands.
    if (handles.flight && router.screen === 'mission' && !pause.paused) {
      const pass = flybyFeel.step(
        handles.flight.jet.body.position,
        handles.flight.jet.body.orientation,
        handles.liveRacers?.racers ?? null,
        roomActive() ? (roomCore.roomShips?.drawn() ?? null) : null,
        frameSeconds,
      )
      // DEV-641: the same pass is HEARD, panned to the side it went by on: the cue
      // is emitted `distance` metres out along the head's own right (world space,
      // like the listener), signed by the pass's `side`. The detector is p1's, so
      // the ear, the camera and the hands are one moment.
      if (pass) {
        _flybyRight.set(1, 0, 0).applyQuaternion(_listenerQuat)
        const reach = pass.side * pass.distance
        audio.event({
          type: 'ship.flyby',
          at: [
            _listenerEye.x + _flybyRight.x * reach,
            _listenerEye.y + _flybyRight.y * reach,
            _listenerEye.z + _flybyRight.z * reach,
          ],
          gain: flybyWhooshGain(pass.trauma),
        })
      }
    }
    // DEV-643: the music ducks and low-passes through the crash's black and comes
    // back with the fade. An edge on the curtain flag, so every way the curtain
    // can lift (the reset, a restart, a mission swap) lifts the duck too.
    if (run.crashCurtain !== ctx.crashDucked) {
      ctx.crashDucked = run.crashCurtain
      audio.duckMusic(run.crashCurtain ? 1 : 0, run.crashCurtain ? 0.1 : 0.5)
    }

    // The near-field air (DEV-080). The ship's velocity is what the motes are
    // drawn along, and its absence is what makes the hangar, the title screen
    // and a paused run draw none of them: a frozen ship with a streaming field
    // around it is a bug you can feel. The camera goes in whole, because the
    // field needs its WORLD position and in the cockpit `camera.position` is
    // the head pose inside the rig (trap 18).
    air.update(
      render.camera,
      handles.flight && router.screen === 'mission' && !pause.paused
        ? handles.flight.jet.body.velocity
        : null,
    )

    // S7, DEV-093: the lens opens with airspeed, on the MONITOR only. Nothing
    // happens in a session — `update` returns before it reads anything while
    // `renderer.xr.isPresenting` (research 05 §R7) — and nothing happens on
    // Classic, whose curve is flat at zero behind a flag that is off.
    //
    // `active` is the shake's three "no" answers plus a fourth this feature has
    // and the shake does not: **`wantsFly`, the cockpit.** `?view=chase` and
    // `?view=cam` are photography tools, and a lens that breathes under a fixed
    // viewpoint would make two screenshots of one viewpoint different
    // screenshots — which is the one property `boot/viewpoints.ts` exists to
    // give. The chase camera is not a pilot's eye and has no business borrowing
    // a pilot's cue.
    //
    // `frameSeconds` UNCLAMPED, unlike the particles above: a tab that was
    // hidden for ten seconds should come back at the settled lens rather than a
    // tenth of the way into an ease, and a large dt is exactly how the
    // exponential says "you are there".
    //
    // With the camera OUTSIDE (DEV-128) the cockpit's lens is inactive and the
    // arm's own term is handed in as the override: `fovAddFor` is the preset
    // curve TIMES the speed-FX slider, so `off` is exactly the resting lens,
    // and on Classic — no spring — it is zero, which is 2016's rigid camera at
    // 2016's one fov. One writer of `camera.fov`, still.
    // DEV-640: the boost's lens push (flat only, slider-scaled) and the cabin
    // lamps' glow (the cabin, so a headset sees that too), both off the sim's
    // own "boost burned on the last step", live in a flight only.
    const boostLive = ctx.boostBurning && router.screen === 'mission' && !pause.paused
    flatFov.push(boostLive && lensIsLive() ? TANK_FEEL.fovPushDegrees * editionState.speedFx : 0)
    ctx.boostGlow = easeLevel(
      ctx.boostGlow,
      boostLive ? 1 : 0,
      TANK_FEEL.glowAttackSeconds,
      TANK_FEEL.glowReleaseSeconds,
      frameSeconds,
    )
    handles.flight?.setBoostGlow?.(ctx.boostGlow)
    flatFov.update(
      handles.flight ? forwardSpeedOf(handles.flight) : 0,
      handles.flight !== null &&
        wantsFly &&
        !thirdPersonLive &&
        router.screen === 'mission' &&
        !pause.paused &&
        !launchHoldsShip(ctx.launch),
      frameSeconds,
      thirdPersonLive && handles.flight
        ? fovAddFor(thirdPersonNow(), forwardSpeedOf(handles.flight), editionState.speedFx)
        : null,
    )

    // The sun's shadow box, refitted to where the eye actually is (DEV-086).
    // AFTER the sun's own direction is set above, because the fit reads the
    // light's world transform; and it takes the CAMERA rather than the ship,
    // because the thing being shadowed is the frame — which is also the only
    // reason `?view=cam` has shadows in it to photograph.
    sunShadows.update(render.camera)
    // ── DEV-336: the headset's bloom, as halos ────────────────────────────
    //
    // Only while presenting, only in a mission, only where the preset has
    // bloom: the monitor keeps `render/bloom.ts`'s real pass, and Classic has
    // none. The look is read every frame (four uniforms), so a preset flip
    // or a tuning change moves it live.
    {
      const bloomSpec = editionState.current.render.bloom
      const halo = bloomSpec.vrHalo
      const glowing =
        render.renderer.xr.isPresenting && bloomSpec.enabled && router.screen === 'mission'
      if (handles.liveStudHalos) {
        handles.liveStudHalos.object.visible =
          glowing && halo.studRadius > 0 && halo.studIntensity > 0
        handles.liveStudHalos.setLook(halo.studRadius, halo.studIntensity)
      }
      const sun = ctx.level.lighting.sun
      sunHalo.object.visible =
        glowing &&
        sun !== null &&
        sun !== undefined &&
        halo.sunAngleDeg > 0 &&
        halo.sunIntensity > 0
      if (sunHalo.object.visible && sun) {
        _sunColour.setRGB(
          sun.colorLinear[0] as number,
          sun.colorLinear[1] as number,
          sun.colorLinear[2] as number,
          THREE.LinearSRGBColorSpace,
        )
        sunHalo.setLook(halo.sunAngleDeg, halo.sunIntensity, _sunColour)
        // `direction` is the light's TRAVEL (level JSON, three space); the
        // sun is the other way.
        _towardSun
          .set(
            -(sun.direction[0] as number),
            -(sun.direction[1] as number),
            -(sun.direction[2] as number),
          )
          .normalize()
        // The HEAD's world position, through the one door (DEV-199).
        sunHalo.place(readHeadPosition(render.renderer.xr, render.camera, _haloEye), _towardSun)
      }
    }
    // 2016's per-chunk prop reveal (DEV-225). Takes the CAMERA rather than a
    // position, for the same two reasons `sunShadows.update` does: the thing
    // being drawn is the frame, and `camera.position` is the head pose inside
    // the XR rig (trap 18) — so the world position is asked for INSIDE
    // `load-props.ts`, which is also where the mesh-frame z flip lives, rather
    // than composed here. Clamped like the fracture, so a tab that was hidden
    // for a minute does not run a whole reveal in one step; the loader
    // throttles the repack itself, to 2016's own 1/30 s scan.
    handles.livePropsLive?.updateLod(render.camera, Math.min(frameSeconds, 0.1))
    // V9's flocks (DEV-089). RENDER time, like the particles and the waves: a
    // bird is ambience, it scores nothing and nothing under `src/sim/` can see
    // one. `birdAt` is a pure function of the clock rather than an integrator,
    // so a paused second costs a flock nothing and a dropped frame costs it
    // nothing either. The props themselves never move and are not touched.
    handles.liveDressing?.update(time / 1000)
    // DEV-447: the boats, on the SEA's clock — the `time / 1000` the waves were
    // handed above, so a hull rides the facet the shader displaced this frame.
    // `sync` is the preset and the comfort floor, read live (a pause-plate
    // flip or a quality change takes effect on the next frame).
    handles.liveLife?.sync(lifeWanted(editionState.current.life, editionState.settings.quality))
    // DEV-532: and the HEAD's world position, through the one door (DEV-199),
    // which cues a pod of dolphins to breach as the player comes at it.
    handles.liveLife?.update(
      time / 1000,
      handles.liveLife ? readHeadPosition(render.renderer.xr, render.camera, _lifeEye) : null,
    )
    // DEV-136: the pieces of anything broken this frame, on the render clock
    // like the birds — nothing under `src/sim/` can see them. Capped like the
    // FX so a tab that was hidden for a minute does not fling them a kilometre.
    handles.liveFracture?.update(Math.min(frameSeconds, 0.1))
    // V5's wind (DEV-090). RENDER clock, for the same reason as the flocks and
    // the waves: a cloud is ambience, it scores nothing, and nothing under
    // `src/sim/` can see one — so the AI racers cannot either, which is the
    // point. A still sky on Classic returns before it touches a matrix, and
    // `?snap=` does NOT freeze this (docs/vr-testing.md §5), so an A/B pair
    // differs by a few metres of drift and by nothing else.
    handles.liveClouds?.update(time / 1000)
    cloudShadow.update() // DEV-585: the wind, after the clouds' own

    ctx.fog.update(render.camera)
    // The title valley's own fog carries no height term, so this only refreshes
    // the camera distance — but it is the same contract and skipping it would
    // be a thing to remember rather than a thing that is true. DEV-155.
    handles.titleFog?.update(render.camera)
    // ── which world is on screen ─────────────────────────────────────────
    //
    // The menu is a different environment, the way 2016's is. Everything that
    // separates them — lighting, the sky dome, the fog the materials carry, the
    // island itself — is per-scene, so choosing the scene is the whole of it and
    // nothing has to be toggled off one handle at a time.
    //
    // The RIG moves with the choice. `renderer.render` walks the matrices of the
    // scene it is given and, for the camera, only when the camera has no parent
    // — so a camera parented to a rig in the other scene renders from wherever
    // it was standing when it left.
    // ── what the thumbs are offered, this frame ──────────────────────────
    //
    // Last, because every flag it reads is settled by now — `paused` in
    // particular is cleared by a run that finished during this frame, and a
    // button labelled for the branch that did NOT fire is the same class of bug
    // `controls-menu.ts` and `pause.ts` share one plate to avoid.
    //
    // ── the sticks go away while the plate is up, and that is DEV-291 ────
    //
    // This paragraph used to say the opposite, and the reasoning was sound for
    // the mechanism it had: *"on a flat screen the gaze is the ship's forward
    // and a frozen sim means a frozen ship, so the PITCH AXIS is the only
    // thing that can move the selection. Take the sticks away and a phone can
    // open the pause menu and never reach a row in it."* Every clause of that
    // is true, and it describes a menu you walk one row at a time with a
    // thumb-stick because the only alternative on offer was nothing.
    //
    // Matt, having found the plate: *"mobile menu should work w/ tap"*. A
    // finger can aim a ray directly — `menuTapRay` below — so the pitch axis
    // is no longer the only thing that can move the selection, and the
    // premise this paragraph rested on is gone rather than overruled. The
    // stick walk SURVIVES for the pad and the headset, which never lost it.
    touch.setContext({
      // DEV-792: TV has no ship to fly, so no BRAKE, BOOST, AUTO, CAM or pause
      // chip, and no LAUNCH either: its own controls are `tv-panel-controls`'.
      flying: router.screen === 'mission' && !tvActive(),
      lookMode: router.screen === 'menu',
      menu: pause.paused,
      // DEV-353: the title's rows are tapped, and its START chip stays.
      // DEV-571: and the questions after a lap, beside CONTINUE and FLY AGAIN.
      // DEV-604: and the hangar's tables, which a finger also drags past.
      // DEV-607: and everywhere the big button pressed: the letter plate, the
      // room's lobby, TV's plate, the pad and the results panel.
      taps:
        titleMenuUp() ||
        lapAskUp() ||
        roomTakesPoints() ||
        codeUp() ||
        lobbyUp() ||
        optionsPlate.up() ||
        tvView.plateUp() ||
        glassConfirms(),
      // DEV-619 (Matt, 2026-10-03: *"remove the extra button from mobile.
      // mobile users should be able to just tap the panel start, no need for
      // an extra button."*): no chip on the title either; a tap on a row
      // presses it (`titleTapped` below). With DEV-607 that leaves no big
      // button anywhere.
      confirmLabel:
        router.screen === 'title' || titleMenuUp() || tvActive() ? null : touchConfirmLabel(),
      // DEV-406 follow-up: FLY AGAIN beside CONTINUE, while the panel is up.
      againLabel:
        run.lastResult && router.screen === 'mission' && !pause.paused ? AGAIN_LABEL : null,
      // DEV-371 follow-up: RACE THIS LAP, on the results panel.
      raceLabel: touchRaceLabel(),
      // DEV-890: on a phone, one line of where the thumbs go while the ship
      // waits on the pad, the ride and the countdown.
      padHint:
        confirmDevice() === 'touch' &&
        router.screen === 'mission' &&
        !tvActive() &&
        ctx.launchSpec !== null &&
        ctx.launch.phase !== 'flying' &&
        !pause.paused
          ? TOUCH_PAD_HINT
          : null,
      autopilot: pilot.autopilot,
      autopilotOffered: MODES[runningMode(ctx.level)].autopilot,
      thirdPerson: thirdPersonLive,
      // DEV-292. `tiltAvailable` is only *the platform exposes the event* —
      // read its doc comment, which says plainly what it cannot promise. `tilt`
      // is whether the phone is driving the view RIGHT NOW, which is `active`
      // and deliberately not `tiltWanted`: between the tap and the first
      // reading there is nothing to show, and a chip lit for a pose that does
      // not exist yet is a control claiming to work before it does. On a device
      // with no sensors that first reading never comes, and the chip never
      // lights, which is the honest answer rather than a silent one.
      tiltAvailable: deviceLook.supported,
      tilt: deviceLook.active,
      // DEV-628: on TV with its plate down the race is the glass: a finger
      // taps (the next racer) and drags (the orbit) on the canvas itself, and
      // EXIT and MENU are `render/tv-panel-controls.ts`'s. No sticks for a
      // ship nobody flies.
      hidden: render.renderer.xr.isPresenting || (tvActive() && !tvView.plateUp()),
    })

    // DEV-572: the menus' reticle, now every menu has aimed this frame.
    menuReticleFrame()
    const stage = router.screen === 'menu' ? menuScene : render.scene
    // DEV-355: the loading scene's mark turns on render time — a live frame
    // should LOOK live. A no-op while the scene is down.
    loadingScene.tick(frameSeconds)
    if (render.rig.parent !== stage) stage.add(render.rig)
    // The curtain follows the stage, for the same reason the rig does. The
    // vignette lives in `render.scene`, the hangar draws from `menuScene`, and
    // a fade that covers the cockpit but not the room is worse than no fade at
    // all — the transition it is most needed for is the one INTO the room.
    // `docs/plan/LOADING.md` L2 names this trap; `fade-stages.spec.ts` is the
    // measurement, because a spec that only checked the mission scene would be
    // green and wrong.
    if (vignette.object.parent !== stage) stage.add(vignette.object)
    // DEV-446: the scene tint is a MISSION's, so it draws only while a
    // mission's world is on screen — not over the title's valley, which is the
    // same scene, and never in the room, which is not. The preset read live, so
    // a flip, a `vr.disable` or a `?feature=` pin lands on the next frame.
    sceneTint.update(
      editionState.current.render.sceneTint,
      ctx.level.id,
      stage === render.scene && router.screen === 'mission',
      courseTintFor(ctx.level.id), // DEV-476: a player course's own, from the course
    )
    // V2 / DEV-091: the bloom composite, or false and the direct path. It takes
    // the STAGE, so the title screen, the menu world and a mission all get the
    // same treatment from one call.
    //
    // The render bracket (VR-PERF §5.2) goes round the SAME span the GPU timer
    // brackets, deliberately: on the composer path that is `classify()` and the
    // bloom passes as well as the draw, which is the frame's real submission
    // cost and the thing `gpu.last` is the other half of. Two brackets over one
    // span means `render_ms` and `gpu_ms` are about the same work — CPU side and
    // GPU side — which is what makes "CPU-bound or GPU-bound" answerable from a
    // trace alone (protocol §4).
    const renderT0 = performance.now()
    gpu.begin()
    // DEV-323: the cockpit's near shadow map, INSIDE both brackets because it
    // is render work — one depth draw of the shell — and a pass outside them
    // would be frame time `render_ms` and `gpu_ms` could not see. Before the
    // draw that samples it; a no-op on Classic and whenever the shell is not
    // on screen.
    //
    // DEV-355: and only when the MISSION stage is the one being drawn. Its own
    // `drawnInAScene` asks whether the shell is in A scene, and since DEV-076
    // the ship stays in the mission's while the room is drawn — so it drew the
    // shell's depth every frame in the hangar, and on a course switch its
    // first draw landed mid-load and waited 240 ms on a program link.
    //
    // DEV-643: the crash's hit-stop. The LAST frame stays on screen for ~100 ms by
    // not drawing at all, the depth and reflection passes included (flat only;
    // the sim has not paused, and a held picture under a moving head would be
    // nausea). Everything above this line ran.
    if (!crashFeel.holdsFrame(performance.now(), render.renderer.xr.isPresenting)) {
      if (stage === render.scene) cockpitSelfShadow.update()
      if (stage === render.scene) nearShadow.update(render.scene, render.camera) // DEV-582
      if (stage === render.scene) seaReflection.update(render.scene, render.camera) // DEV-583
      // DEV-636: the flat camera shake, worn for this one draw. Zero in a session,
      // with Speed FX off, under a menu and on a photography viewpoint; the rig and
      // everything placed above never see it, and `restore` hands the camera back
      // bit for bit.
      feel.cameraShake.sample(
        shakeOffset,
        time / 1000,
        router.screen === 'mission' && !pause.paused && (wantsFly || tvActive())
          ? editionState.speedFx
          : 0,
        render.renderer.xr.isPresenting,
      )
      shakeWear.wear(render.camera, shakeOffset)
      if (!bloom.render(stage, render.camera)) render.renderer.render(stage, render.camera)
      shakeWear.restore(render.camera)
    }
    gpu.end()
    const renderMs = performance.now() - renderT0

    // Step 33 (APP-SPLIT §1c): the recorder, the adaptive cost, the budget line,
    // the trace and the plate, LAST, after the render (`boot/app/perf.ts`).
    perfSys.frame({ time, frameT0, frameSeconds, simMs, renderMs, ticksThisFrame, thirdPersonLive })
  }
  return {
    frame,
  }
}
