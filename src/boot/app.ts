// src/boot/app.ts — application boot: find the canvas, build the renderer,
// start the fixed-step loop, wire the landing-page affordances. This is the
// only file allowed to know about both `src/sim/` and `src/render/`.

import * as THREE from 'three'
import { createFeel, type Feel } from '@/boot/feel'
import {
  type BoostFeel,
  type CrashFeel,
  createBoostFeel,
  createCrashFeel,
  createFlybyFeel,
  type FlybyFeel,
} from '@/boot/feel-events'
import { createLoadProgress, type LoadProgress } from '@/boot/load-progress'
import type { QualityPins } from '@/boot/quality-pin'
import { type ComfortSettings, qualityInForce } from '@/boot/settings'
import { stats } from '@/boot/stats-beacon'
import { STANDARD_VARIANT_ID } from '@/content/aircraft-schema'
import { assetUrl } from '@/content/asset-url'
import {
  type EditionCockpit,
  type EditionHudPlacement,
  type EditionId,
  type EditionThirdPerson,
  hudPlacementFor,
  hudPlacementKey,
} from '@/content/edition-schema'
import type { GameMode, Level } from '@/content/level-schema'
import { aircraftFor } from '@/content/load-aircraft'
import { loadLevel } from '@/content/load-level'
import { uiLabel } from '@/content/ui-strings'
import { type Air, createAir } from '@/game/air'
import { createCockpitJolt, JOLTS } from '@/game/cockpit-jolt'
import type { RacingGuide } from '@/game/course-specs'
import {
  boundarySpecOf,
  crashLineOf,
  guideFor,
  launchSpecOf,
  profileGuide,
} from '@/game/course-specs'
import { createEditionState, type EditionState } from '@/game/edition'
import { EDGE_FLASH_SPEED, GO_FEEL } from '@/game/finish-feel'
import { createChainWatch, createGateLadder } from '@/game/gate-feel'
import { hudTimeLimit, type MissionState, missionScore, startMission } from '@/game/mission'
import { environmentDisplayName, type MissionCard } from '@/game/mission-index'
import { countLabel, rulesFor, runningMode } from '@/game/modes'
import { createOvertakeWatch } from '@/game/overtake'
import { speedLineLift, speedLineOverride, speedLineRamp } from '@/game/particle-fx'
import { safeStorage } from '@/game/personal-best'
import type { LineMask } from '@/game/props/course-clearing'
import type { LivePlace } from '@/game/race-place'
import { createHitJolt } from '@/game/racer-hit'
import type { RemoteShips } from '@/game/remote-ships'
import type { CraftSplashState } from '@/game/splash-crossing'
import { createSplitTracker, gapText, gapTone } from '@/game/split-times'
import { createRisingEdge } from '@/game/tank-feel'
import type { LoadedTerrain } from '@/game/terrain/load-terrain'
import type { TitleTrails } from '@/game/title-trails'
import { variantStep } from '@/game/variant-stats'
import type { WatchClient } from '@/game/watch-client'
import { noActions } from '@/input/actions'
import { attachDeviceLook, noDeviceLook } from '@/input/device-orientation'
import { createEdge } from '@/input/edge'
import { createFocusEdge } from '@/input/focus-edge'
import { firstStandardPad } from '@/input/gamepad'
import { createHapticOutput, createHaptics } from '@/input/haptics'
import { NO_HOLD } from '@/input/hold-toggle'
import { createHomeScreenGuide } from '@/input/home-screen-guide'
import { attachKeyboard } from '@/input/keyboard'
import { attachMouseLook, createFreeLook } from '@/input/look'
import { createRowStepper } from '@/input/menu-step'
import { createTitleHomeHint } from '@/input/title-home-hint'
import { attachTouchControls } from '@/input/touch-overlay'
import { attachTurnScreen, PHONE_SHORT_SIDE_PX } from '@/input/turn-phone'
import { createXrSelectLatch } from '@/input/xr-select'
import { attachEditionBakedLight, type BakedLight, createBakedLight } from '@/render/baked-light'
import { type Bloom, createBloom } from '@/render/bloom'
import { type BoundaryFuzz, createBoundaryFuzz } from '@/render/boundary-fuzz'
import {
  type CameraShakeOffset,
  createCameraShake,
  createShakeOffset,
  createShakeWear,
  type ShakeWear,
  TRAUMA,
} from '@/render/camera-shake'
import { buildChunkBatches, type ChunkBatchSet } from '@/render/chunk-batch'
import { type ClassicChase, createClassicChase } from '@/render/classic-chase'
import { REVEAL_RISE } from '@/render/elevator'
import { createFade, type Fade, type FadePhase } from '@/render/fade'
import { createFlatFov, type FlatFov } from '@/render/flat-fov'
import { createGatePulse, type GatePulse } from '@/render/gate-pulse'
import { type HangarArt, seatPitchLocal } from '@/render/hangar'
import { attachEditionHaze } from '@/render/haze'
import { createHorizon, type Horizon } from '@/render/horizon'
import { formatTime, type HudRaster, type HudRedraw, type HudUpload } from '@/render/hud'
import { HUD_FONT_ASSET, hudFontSettled, loadHudFont } from '@/render/hud-font'
import type { HudGauges } from '@/render/hud-gauges'
import {
  attachEditionIllustrative,
  createIllustrativeLighting,
  type IllustrativeLighting,
} from '@/render/illustrative'
import type { LodFadeSpec } from '@/render/lod-fade'
import type { ParticleOverride } from '@/render/particles'
import type { Pause } from '@/render/pause'
import { PLATE_SIDE } from '@/render/perf-plate'
import { phoneUi } from '@/render/phone-floor'
import { createRaceStrip } from '@/render/race-strip'
import { createRenderer } from '@/render/renderer'
import { createSceneTint, type SceneTint } from '@/render/scene-tint'
import type { Sky } from '@/render/sky'
import { useSkyshopLightingModel } from '@/render/skyshop-ibl'
import { createSpringArm, type SpringArm, type SurfaceHeightAt } from '@/render/spring-arm'
import { withSunLightRule } from '@/render/sun-light-rule'
import {
  attachEditionSurfaceGloss,
  createSurfaceGloss,
  type SurfaceGloss,
} from '@/render/terrain-surface'
import type { Title } from '@/render/title'
import type { TitleCurtain } from '@/render/title-curtain'
import { attachEditionTone } from '@/render/tone'
import type { UnityFog } from '@/render/unity-fog'
import { createVignette, type Vignette, type VignetteInput } from '@/render/vignette'
import { createSunHalo } from '@/render/vr-halo'
import type { BoundaryState } from '@/sim/boundary'
import { type BoundarySpec, createBoundary } from '@/sim/boundary'
import type { CrashState } from '@/sim/crash'
import { type CrashCourse, crashLimitS, createCrash } from '@/sim/crash'
// DEV-143. The boost tank: `sim/energy.ts` owns the arithmetic and takes every
// number but the preset's `rechargeScale` off the generated sheet.
import { boostAvailable, createEnergy, energySpec } from '@/sim/energy'
// DEV-144. The energy race's tank: gates pay in, flying takes out, empty is the
// end of the run. Never live at the same time as the boost tank above.
import { createEnergyRace, energyRaceSpec } from '@/sim/energy-race'
import type { HoverJetSheet } from '@/sim/hoverjet'
import { createClock } from '@/sim/integrator'
import type { LaunchState } from '@/sim/launch'
import { countdownNumber, createLaunch, type LaunchSpec, startLaunch } from '@/sim/launch'
import { v3 } from '@/sim/math/vec3'
import { createRouteCursor, type Route } from '@/sim/route'
// `terrainHeightAt` is gone from this file with DEV-042's lift: the title rig's
// height is now 2016's own, composed rather than rescued, and the mission
// terrain's field is passed straight to the sim. Nothing here samples ground.
import { highestGroundUnder, PADS_SOLID } from '@/sim/terrain/height-field'
// DEV-388: the generated-content manifest, digested for a room's `join` (§6.7).
import { createAtmosphere } from './app/atmosphere'
import { createAppAudio } from './app/audio'
import type { AutopilotState } from './app/autopilot-state'
import { createDebugHandle } from './app/debug-handle'
import { createEditorHost } from './app/editor-host'
import { createBriefing } from './app/flight/briefing'
import { createLessonHost } from './app/flight/lesson'
import { createFrame } from './app/frame'
import { createLetterPlate } from './app/hangar/letter-plate'
import { createMenuReticleHost } from './app/hangar/menu-reticle'
import { createMenus } from './app/hangar/menus'
import { createOptionsPlate } from './app/hangar/options-plate'
import { createHangarRoom } from './app/hangar/room'
import { _headQuat, cameraWorld } from './app/head-scratch'
import { applyLighting, applySky, createSun, missionFog } from './app/lighting'
import type { PlacementTuning } from './app/lookdev-panel'
import type { PauseState } from './app/pause-state'
import { createPerf } from './app/perf'
import {
  AMBIENT_SOURCE,
  AUTOPILOT_AT_BOOT,
  BAKED_RUNG_PIN,
  CAMERA_AT_BOOT,
  EDIT_AT_BOOT,
  EDITION_PARAM,
  FEATURE_PINS,
  FLY,
  FOG_ENABLED,
  FOG_TAKES_SKY_COLOUR,
  GUIDE_SPLINE,
  HUD_GAUGES_PIN,
  HUD_RASTER_PIN,
  HUD_REDRAW_PIN,
  HUD_UPLOAD_PIN,
  lastVariantOf,
  MENU_EDITION,
  MISSION,
  MODE_PARAM,
  PERF_HUD,
  QUALITY_PINS,
  RULES_EDITION,
  RULES_PARAM,
  SHIP_LAT_ACCEL,
  SKIP_RIDE,
  SUN_LIGHT_RULE,
  VIEWPOINT,
  view,
  WIRE_AT_BOOT,
  WIRE_STAGES,
  type WireStage,
} from './app/pins'
import { createResults } from './app/results'
import { createRoomCore } from './app/room/core'
import { createRoomLobby } from './app/room/lobby'
import { createRoomResults } from './app/room/results'
import { createRoomWatch } from './app/room/watch'
import { createRunReset } from './app/run-reset'
import type { RunState } from './app/run-state'
import { createScreenRouter } from './app/screen-router'
import { createAppSettings } from './app/settings'
import { createTitleMenu } from './app/title/menu'
import { createPlayerCourses } from './app/title/player-courses'
import { createTitleWorld } from './app/title/world'
import { createTvPanelHost } from './app/tv/panel'
import { createTv } from './app/tv/view'
import type { App, BootOptions } from './app/types'
import { createWorldBuild } from './app/world/build'
import { createLoadingHost } from './app/world/loading'
import { createWorldProps } from './app/world/props'
import { createWorldSwitch } from './app/world/switch'
import {
  disposeWorldHandles,
  emptyWorldHandles,
  resetOnly,
  type WorldHandles,
} from './app/world-handles'
import { createXrLifecycle } from './app/xr-lifecycle'
import { detectCapabilities } from './capability-gate'
import { createShakeLookdev } from './lookdev-shake'
import { createFrameRecorder, type FrameRecorder } from './perf-recorder'
import { IDLE_XR_PROBE, type PerfSurface, type XrProbe } from './perf-surface'
import { applyViewpoint } from './viewpoints'

export type {
  App,
  BootOptions,
  EditorBootPhase,
  LapsReport,
  ResultsBoardReport,
  ShareReport,
} from './app/types'

/**
 * `?snap=<seconds>` freezes the SIM once the mission clock reaches that many
 * seconds, and keeps rendering. A screenshot tool, like `?view=cam`.
 *
 * It is the PAUSE path with a different trigger — zero wall time into
 * `stepFixed`, which is how the pause menu stops the run — and not a new route
 * through the sim. The pause plate does not appear; the HUD keeps drawing.
 *
 * The pair it exists for (ANNIVERSARY.md §4.3, §7):
 *
 *     /?autopilot=1&xr=off&snap=20&edition=classic
 *     /?autopilot=1&xr=off&snap=20&edition=anniversary
 *
 * The autopilot is deterministic on the fixed step (DEV-027), so both loads
 * reach the same tick with the ship, the racers and the course in the same
 * place: one frame, two presets. `docs/vr-testing.md` has the full recipe and
 * the one caveat — wave phase and particles run on wall time. See `boot/snap.ts`.
 */
/**
 * How far out the sun's halo billboard stands, metres (DEV-336). Inside the
 * 6 km far plane, so the terrain between the eye and the horizon hides it.
 */
const SUN_HALO_METRES = 5000

export const bootApp = async (
  canvas: HTMLCanvasElement,
  options: BootOptions = {},
): Promise<App> => {
  // DEV-611: the developer splash, when one is up (`boot/dev-splash.ts`).
  const splash = options.splash ?? null
  // BEFORE anything builds a material. This says "env maps are specular only"
  // for the whole app, which is the lighting model every Marmoset shader in the
  // 2016 game used; the diffuse half arrives as a light probe in applyLighting.
  // Patching a shader chunk after a program is compiled would silently do
  // nothing to the material already on screen.
  useSkyshopLightingModel()

  // DEV-362 follow-up: the cockpit readout's face, CRYSTAL, 2016's own, from
  // the content bucket. Started here, before any world is built, so the 13 KB
  // has normally landed long before a panel paints; a panel built sooner
  // repaints when it does (`render/hud-font.ts`), and a failed load leaves
  // every panel in the stack it always had. Never awaited: a font is not a
  // reason to hold a boot.
  void loadHudFont(assetUrl(HUD_FONT_ASSET))

  // ── The player's settings and edition (APP-SPLIT 3.4, `boot/app/settings.ts`) ──
  const appSettings = createAppSettings({
    get editionState() {
      return editionState
    },
    presenting: () => render.renderer.xr.isPresenting,
  })
  const {
    pinned,
    editionLoading,
    presetFor,
    editionsLoaded,
    wearEditionFor,
    wearEdition,
    missionEdition,
  } = appSettings
  const capabilities = await detectCapabilities()
  // DEV-894: a touch device whose short side is under the phone line scales its plates up.
  phoneUi.on =
    capabilities.touch && Math.min(window.screen.width, window.screen.height) < PHONE_SHORT_SIDE_PX
  // DEV-848: CRYSTAL is the UI's face as well as the cockpit's, and a canvas
  // plate drawn before it lands keeps the fallback until something redraws it.
  // The file is 13 KB, so give it a beat (bounded: a slow bucket must not hold
  // a boot) before the menus and labels paint.
  await Promise.race([hudFontSettled(), new Promise<void>((r) => setTimeout(r, 2500))])
  // ── The frame-time record, and the panel that shows it ───────────────────
  //
  // ANNIVERSARY.md §4.3 / §7. The RECORDER always runs: a ring of 720 floats and
  // an O(1) feed, so `__ff2.perf.stats()` answers from the console in any run
  // without a switch, and a QA soak later gets its numbers for free. The PANEL
  // is behind `?perf=1`, like every other dev tool here, and costs one branch
  // per frame while it is hidden.
  //
  // BEFORE the renderer, and that is the one ordering decision here: the quality
  // controller is built inside `createRenderer` and it needs the recorder to
  // answer "what rate are the frames actually arriving at" (VR-PERF §5.3). The
  // dependency only goes this way — `render/quality.ts` never imports the
  // recorder, it is handed a function.
  const perf: FrameRecorder = createFrameRecorder()
  // ── The budget, when the runtime will not say (gap 10, DEV-160) ──────────
  //
  // `session.frameRate` is Meta's extension and is not on `XRSession.prototype`
  // in desktop Chrome at all, so on the Steam Frame rig the ONLY correct source
  // for the frame budget is the interval the frames are actually arriving at.
  // `quality.report.targetSource` says which one won, and it is printed below
  // and stamped on every trace — a budget with no provenance is a verdict, not
  // a measurement.
  const render = createRenderer(
    canvas,
    pinned(appSettings.comfort),
    {
      measuredHz: () => perf.modalHz(),
      // DEV-179. `?hz=` states the DISPLAY's rate; the tier stays measured.
      // Not part of `pinned()` for `QualityPins.msaa`'s reason — a refresh
      // rate is a fact about the hardware, not a comfort preference, and the
      // menus have no row that could move it.
      ...(QUALITY_PINS.hz === null ? {} : { displayHz: QUALITY_PINS.hz }),
    },
    // DEV-165. Not part of `pinned()` because MSAA is a context attribute and
    // never a `ComfortSettings` field — see `QualityPins.msaa`.
    appSettings.qualityPins.msaa,
  )
  // ── The perf subsystem (APP-SPLIT 4.1, `boot/app/perf.ts`) ───────────────
  //
  // The DOM panel, the GPU timer, the cockpit plate, the trace and the capture,
  // the frame-error guard and `__ff2perf`: built here, after the renderer,
  // where the panel and the timer always were. What the frame feeds it is
  // `perfSys.frame(...)`, the frame's last step.
  const perfSys = createPerf({
    render,
    perf,
    pinned,
    get comfort() {
      return appSettings.comfort
    },
    get qualityPins() {
      return appSettings.qualityPins
    },
    get editionState() {
      return editionState
    },
    get flight() {
      return handles.flight
    },
    get mission() {
      return mission
    },
    get screen() {
      return router.screen
    },
    get launch() {
      return launch
    },
    get level() {
      return level
    },
    get liveTerrain() {
      return handles.liveTerrain
    },
    get liveFracture() {
      return handles.liveFracture
    },
    get xrProbe() {
      return xrProbe
    },
    get xrVisibility() {
      return xrLifecycle.xrVisibility
    },
    get contextLost() {
      return xrLifecycle.contextLost
    },
    get clock() {
      return clock
    },
    get frameOrdinal() {
      return frameOrdinal
    },
    get snapped() {
      return run.snapped
    },
    get room() {
      return roomCore.room
    },
    get roomShips() {
      return roomCore.roomShips
    },
    get frame() {
      return frame
    },
  })
  const { perfHud, gpu, perfPlate, perfCapture, captureLiveRun, togglePerfCapture, guardedFrame } =
    perfSys

  // ── The edition: Classic or Anniversary ──────────────────────────────────
  //
  // docs/plan/ANNIVERSARY.md §0. One preset is live at a time; this object is
  // the only holder, and a feature reads `editionState.current` (and
  // `.speedFx`, the comfort slider resolved to 0 / 0.5 / 1) when it needs them.
  // `?edition=` wins for this load; the stored setting otherwise. A flip from
  // the menu loads the other file and `setLook`s it — see `onSettings`.
  // `pinned`, because `game/terrain/detail-ring.ts` reads
  // `editionState.settings.quality` and turns the ring off at `low`. A pin the
  // renderer honoured and the terrain did not would be the worst of both: a
  // measurement row taken at one preset's resolution and another's geometry.
  //
  // DEV-452 (D35): the edition is a LOOK. Every run on the page flies
  // `RULES_EDITION`'s rules (Anniversary; `?rules=classic` is the 2016
  // reference), and `content/edition-split.ts` lays the worn look over them.
  const editionState: EditionState = createEditionState(
    await editionLoading,
    pinned(appSettings.comfort),
    await presetFor(RULES_EDITION),
  )
  // DEV-263. BEFORE the line below, so the logged preset is the one that will
  // actually render — and before any system subscribes, so the pin arrives as
  // the initial state rather than as a change every subscriber has to handle.
  if (Object.keys(FEATURE_PINS).length > 0) editionState.setFeatureOverrides(FEATURE_PINS)
  console.info(
    `edition: ${editionState.current.id}${EDITION_PARAM ? ' (from ?edition=)' : ''}` +
      (editionState.current.id !== appSettings.chosenEdition
        ? ` for the menus; ${appSettings.chosenEdition} inside a mission (DEV-451)`
        : '') +
      `; ${editionState.rules.id}'s rules${RULES_PARAM ? ' (from ?rules=)' : ''} (DEV-452)`,
  )

  // ── Anniversary systems ──────────────────────────────────────────────────
  //
  // Each Phase 1 feature (ANNIVERSARY.md §5) constructs itself HERE, takes
  // `editionState`, and reads the live preset when it runs. Nothing in this
  // block may reach `src/sim/`: the presets are render, audio and cockpit art,
  // and the golden trajectories cannot see them. Per-frame updates go in the
  // block of the same name inside `frame`.

  // V1 / DEV-081. Tone mapping and exposure are renderer state and nothing
  // else, so one call at boot and one per flip is the whole feature — three
  // recompiles the affected materials itself on the next draw, and the exposure
  // is a uniform pushed every frame. See `render/tone.ts`, which also carries
  // the line on what is UI and therefore not tone-mapped.
  attachEditionTone(render.renderer, editionState)

  // V7 / DEV-092. The illustrative diffuse warp: the direct diffuse response
  // becomes a Half-Lambert ramp, so the cool/warm shift lives inside the shadow
  // term rather than over the frame. NOT per-mission, unlike the fog — the ramp
  // is a preset and the sun's own colour reaches it through `directLight.color`
  // — so one of these is built here and `applyTo` is handed to whatever loads a
  // lit LAND material. `render/illustrative.ts` owns which materials those are
  // and the identity at strength 0.
  const warp: IllustrativeLighting = createIllustrativeLighting()
  attachEditionIllustrative(warp, editionState)

  // DEV-132. Per-facet roughness from the facet's own colour class, on the
  // LAND material only — `render/terrain-surface.ts` owns the classifier and
  // the identity at mix 0, `load-terrain.ts` owns the Marmoset guard.
  const surfaceGloss: SurfaceGloss = createSurfaceGloss()
  attachEditionSurfaceGloss(surfaceGloss, editionState)

  // DEV-232. The LAND's diffuse lighting computed once into its vertex colours,
  // with three's physical chain gated out behind it. `render/baked-light.ts`
  // owns the argument, the anchor and the arithmetic; this holds the instance
  // and the edition attach is further down, where `liveTerrain` exists to
  // re-bake. Off in both shipped presets, so until somebody flips it this is a
  // patch that compiles the same program the build has always drawn.
  const bakedLight: BakedLight = createBakedLight()

  // DEV-130. The LOD cross-fade, as a getter the loader reads at every reply:
  // null on Classic, the preset's ratio on Anniversary.
  const lodFadeSpec = (): LodFadeSpec | null => {
    const f = editionState.current.terrain.lodFade
    return f.enabled ? { durationScale: f.durationScale } : null
  }
  // V2 / DEV-091. Bloom, flat build only. It OWNS the render call when it runs —
  // `bloom.render(stage, camera)` answers false in VR, on Classic and before the
  // first size is known, and the loop then takes the direct `renderer.render` it
  // always took. Nothing else here changes: no material is touched, no scene
  // graph is rebuilt, and on Classic no composer and no render target exist at
  // all. `render/bloom.ts` carries 2016's numbers, where the component actually
  // sat (the MONO camera — the headset never saw it), and why the UI exemption
  // has to be a layer split rather than `material.toneMapped`.
  const bloom: Bloom = createBloom(render.renderer, editionState)

  // S1 — the near-field air (DEV-080). A pool of faceted motes in a shell
  // around the eye, static in the world while alive and respawning ahead: the
  // roadside the game has never had. Draws nothing on Classic, nothing with the
  // speed slider off, and nothing where there is no flight.
  const air: Air = createAir(editionState)
  render.scene.add(air.object)

  // S7 — a wider lens with speed, FLAT ONLY (DEV-093). Constructed before
  // anything else has touched the camera, because `base: null` means "the fov
  // the renderer built it with" and that has to be read once, here. It reads
  // `camera.fov`, writes it, and is the ONLY thing in the app that does —
  // `renderer.ts`'s resize handler sets `aspect` and preserves the fov. In an XR
  // session it returns before it reads anything: research 05 §R7.
  const flatFov: FlatFov = createFlatFov(editionState, render.camera, render.renderer)

  // DEV-636/637: the feel layer (`boot/feel.ts`): one door for a camera shake, a
  // rumble, a lens kick and a cockpit jolt, with the flat/XR/Speed FX rules kept
  // in it. The shake is WORN by the camera around the one render call below and
  // taken off again, so the rig, the HUD's placement and every raycast never see
  // it.
  const feel: Feel = createFeel({
    cameraShake: createCameraShake(),
    haptics: createHaptics(
      createHapticOutput(firstStandardPad, () => render.renderer.xr.getSession()),
      appSettings.comfort.haptics,
    ),
    cockpitJolt: createCockpitJolt(),
    flatFov,
    nowMs: () => performance.now(),
    speedFx: () => editionState.speedFx,
    presenting: () => render.renderer.xr.isPresenting,
  })
  const boostFeel: BoostFeel = createBoostFeel(feel)
  const flybyFeel: FlybyFeel = createFlybyFeel(feel)
  const crashFeel: CrashFeel = createCrashFeel(feel)
  /** DEV-643: is the music ducked for the crash curtain? Edge state for the frame hook. */
  let crashDucked = false
  const shakeWear: ShakeWear = createShakeWear()
  const shakeOffset: CameraShakeOffset = createShakeOffset()

  // S2 — 2016's speed lines, re-authored so they read (DEV-079). The four
  // systems themselves are 2016's and always drawn; this is a width, an alpha
  // and a blend, handed to the three BOOST fields and to nothing else. Read at
  // field construction (`loadParticleFx`) and re-read on a flip.
  const speedLinesNow = (): ParticleOverride | null =>
    speedLineOverride(editionState.current.fx.speedLines, editionState.speedFx)
  // ...and the second pass of the same row: the tubes lifted to the eye, a
  // transform rather than a material. `speedLineLift` carries the measurement.
  const speedLineLiftNow = (): number =>
    speedLineLift(editionState.current.fx.speedLines, editionState.speedFx)
  // DEV-351 — the boost stages crossfade and ramp in rather than cut. Off at the
  // slider's 0, like S2 above; `game/speed-line-ramp.ts` says why it is drawn
  // whole rather than scaled above it.
  const speedRampNow = () => speedLineRamp(editionState.current.fx.speedRamp, editionState.speedFx)
  // DEV-272 — how much of the gate burst's authored cone survives. Not on the
  // speed-FX slider: this is not vection, it is whether the effect is pointed
  // at you, and a player who turned vection down did not ask to stop seeing the
  // gate they just flew through.
  const ringBurstRandomNow = (): number => {
    const flag = editionState.current.fx.ringBurst
    return flag.enabled ? flag.randomDirection : 1
  }
  editionState.subscribe(() => {
    handles.liveFx?.setSpeedLines(speedLinesNow())
    handles.liveFx?.setSpeedLineLift(speedLineLiftNow())
    handles.liveFx?.setSpeedRamp(speedRampNow())
    handles.liveFx?.setRingBurstRandomDirection(ringBurstRandomNow())
    // V8 / DEV-088 — the cabin: a dim fill, a glow under the readout and a body
    // in the seat, all on the art pivot so the lean and the buffet carry them.
    // Nothing about it changes per frame, so it lands here and at the ship's
    // construction rather than in the per-frame block.
    //
    // A flip DROPS the lookdev Placement patches first (DEV-129), the way
    // `flatFov` drops its `tune` patch: the panel must not leave one preset's
    // numbers on the other one, and its Copy JSON exists so nothing is lost.
    placementPatch = null
    cockpitPatch = null
    thirdPersonPatch = null
    handles.flight?.setInterior(cockpitNow())
    handles.flight?.placeHud(hudPlacementNow())
    if (handles.flight && perfPlate)
      perfPlate.place(hudPlacementNow(), PLATE_SIDE, handles.flight.eye)
    // The finish banner is a preset's (DEV-123): rebuilt on a flip, cleared on
    // Classic. The passed-gate fade and the arrow read the preset live per
    // frame and need nothing here.
    handles.liveRings?.setFinishBanner(editionState.current.gates.finishBanner)
    // The aim reticle is a preset's too (DEV-153), and it takes G2's own
    // `cleanCentredness` — the radius it draws IS the rule, so both have to
    // arrive together or the art could tell the player a threshold the scorer
    // does not use.
    handles.liveRings?.setBullseye(
      editionState.current.gameplay.gateBullseye,
      editionState.current.gameplay.gateEvents.cleanCentredness,
    )
  })

  // APP-SPLIT 3.1: the world's handles, ONE record (`boot/app/world-handles.ts`
  // holds each field's type and its doc). The builds write it; `teardownWorld`
  // releases it through a table typed against the record, so a handle cannot be
  // built without a line that takes it down. Created where the first of the
  // `let`s it replaces was declared, so no handle exists later than it did.
  const handles: WorldHandles = emptyWorldHandles()
  const playerGhostNear = new THREE.Vector3()

  // DEV-388 and DEV-391, a room (APP-SPLIT 4.3, `boot/app/room/core.ts`).
  const roomCore = createRoomCore({
    get applyAtmosphere() {
      return applyAtmosphere
    },
    // DEV-851: YOUR COURSES and a course's ground, read when a room asks
    // (both are made further down, by `createPlayerCourses`).
    playerCourseEntries: () => playerCourseHost.courseEntries,
    groundOfCourse: (course) => groundOfCourse(course),
    get autopilot() {
      return pilot.autopilot
    },
    set autopilot(v: boolean) {
      pilot.autopilot = v
    },
    get clock() {
      return clock
    },
    editionState,
    editionsLoaded,
    get flight() {
      return handles.flight
    },
    get fog() {
      return fog
    },
    get lapRun() {
      return handles.lapRun
    },
    get lastResult() {
      return run.lastResult
    },
    get launch() {
      return launch
    },
    get level() {
      return level
    },
    get liveRacers() {
      return handles.liveRacers
    },
    get lobbyProbe() {
      return lobbyProbe
    },
    get lobbyReady() {
      return lobbyReady
    },
    get lobbyUp() {
      return lobbyUp
    },
    get paused() {
      return pause.paused
    },
    presetFor,
    render,
    get rideSpec() {
      return rideSpec
    },
    get roomPostLap() {
      return roomPostLap
    },
    get roomResults() {
      return roomResults
    },
    get roomRingsSent() {
      return roomRingsSent
    },
    get roomStandingsNow() {
      return roomStandingsNow
    },
    get roomWatch() {
      return roomWatch
    },
    get screen() {
      return router.screen
    },
    get switchMission() {
      return switchMission
    },
    get switching() {
      return switching
    },
    get world() {
      return world
    },
  })
  const {
    roomBots,
    ROOM_COLOUR_KEY,
    roomClose,
    roomConfigure,
    roomCourseCards,
    roomCourseIds,
    roomCourseTitles,
    roomCoursesModule,
    roomPlayerCourse,
    roomRulesFor,
    roomOpen,
    roomVariant,
    titleLinkRoom,
    roomWorldBuilt,
    menuEditionLoad,
    WATCH_ID,
    roomActive,
    roomOccupiedStarts,
    roomBotHost,
    roomWorldTorn,
    roomWaitingLine,
    roomRaceLive,
    roomFrame,
    roomStepCountdown,
    roomOthersNow,
    roomStep,
    roomPlace,
    roomRender,
    roomProbe,
  } = roomCore

  // DEV-390, the race's result (APP-SPLIT 4.3, `boot/app/room/results.ts`).
  const roomResults = createRoomResults({
    editionState,
    get flight() {
      return handles.flight
    },
    get guide() {
      return guide
    },
    get lastResult() {
      return run.lastResult
    },
    get mission() {
      return mission
    },
    get room() {
      return roomCore.room
    },
    roomBots,
    get roomId() {
      return roomCore.roomId
    },
    get roomShips() {
      return roomCore.roomShips
    },
  })
  const {
    roomRingsSent,
    roomPostLap,
    roomStandingsNow,
    roomMapField,
    roomPanelRun,
    roomPanelOpponents,
    roomMapDots,
    roomPlaceOthers,
  } = roomResults
  // DEV-389, the lobby (APP-SPLIT 4.3, `boot/app/room/lobby.ts`).
  const roomLobby = createRoomLobby({
    ROOM_COLOUR_KEY,
    get _aimDirection() {
      return _aimDirection
    },
    get _aimOrigin() {
      return _aimOrigin
    },
    capabilities,
    get confirmDevice() {
      return confirmDevice
    },
    editionState,
    get goToScreen() {
      return goToScreen
    },
    get letterPlate() {
      return letterPlate
    },
    get loadingHost() {
      return loadingHost
    },
    get loadingScene() {
      return loadingScene
    },
    get menuScene() {
      return menuScene
    },
    render,
    get room() {
      return roomCore.room
    },
    roomClose,
    roomConfigure,
    roomCourseCards,
    roomCourseIds,
    roomCourseTitles,
    roomCoursesModule,
    roomPlayerCourse,
    roomRulesFor,
    get roomId() {
      return roomCore.roomId
    },
    roomOpen,
    roomVariant,
    get screen() {
      return router.screen
    },
    get seatQuaternion() {
      return seatQuaternion
    },
    get seatWorld() {
      return seatWorld
    },
    get switching() {
      return switching
    },
    titleLinkRoom,
    get tvOn() {
      return tvOn
    },
    get xrPointer() {
      return xrPointer
    },
  })
  const {
    lobbyUp,
    lobbyReady,
    lobbyProbe,
    startRoom,
    joinLinkRoom,
    OPEN_ROOMS_POLL_MS,
    lobbyPress,
    lobbySteps,
    roomInviteLink,
    lobbyFrame,
  } = roomLobby

  // DEV-436, watching a room (APP-SPLIT 4.3, `boot/app/room/watch.ts`).
  const roomWatch = createRoomWatch({
    roomRaceLevel: (settings) => roomCore.roomRaceLevel(settings),
    get beginLoadingTarget() {
      return beginLoadingTarget
    },
    get cardLifted() {
      return cardLifted
    },
    get flight() {
      return handles.flight
    },
    get goToScreen() {
      return goToScreen
    },
    get level() {
      return level
    },
    get loadingScenePending() {
      return loadingScenePending
    },
    set loadingScenePending(v: boolean) {
      loadingScenePending = v
    },
    get roomShips() {
      return roomCore.roomShips
    },
    set roomShips(v: RemoteShips | null) {
      roomCore.roomShips = v
    },
    roomWorldBuilt,
    get screen() {
      return router.screen
    },
    get switchMission() {
      return switchMission
    },
    get switching() {
      return switching
    },
    get watch() {
      return roomCore.watch
    },
    set watch(v: WatchClient | null) {
      roomCore.watch = v
    },
    get world() {
      return world
    },
  })
  const { watchStart, watchStop, watchLinkWaiting, watchFrame } = roomWatch

  // DEV-481 and DEV-480, TV's camera and view (APP-SPLIT, `boot/app/tv/view.ts`).
  const tvHost = createTv({
    WATCH_ID,
    get aimPlate() {
      return aimPlate
    },
    get cardLifted() {
      return cardLifted
    },
    get confirmDevice() {
      return confirmDevice
    },
    editionState,
    get exhibition() {
      return exhibition
    },
    get fade() {
      return fade
    },
    get glassRay() {
      return glassRay
    },
    get goToScreen() {
      return goToScreen
    },
    handles,
    get hangar() {
      return hangar
    },
    get level() {
      return level
    },
    menuEditionLoad,
    get mission() {
      return mission
    },
    get pointerArbiter() {
      return pointerArbiter
    },
    get quickRaceCards() {
      return quickRaceCards
    },
    set quickRaceCards(v: Promise<MissionCard[]> | null) {
      quickRaceCards = v
    },
    render,
    get restartRun() {
      return restartRun
    },
    roomClose,
    roomCore,
    roomOpen,
    roomWatch,
    get router() {
      return router
    },
    get surfaceHeightAt() {
      return surfaceHeightAt
    },
    get tvPanelCourse() {
      return tvPanelCourse
    },
    get tvPanelInput() {
      return tvPanelInput
    },
    get vignette() {
      return vignette
    },
    watchStart,
    watchStop,
    get xrPointer() {
      return xrPointer
    },
  })
  const { tvOn, tvView, tvActive, tvWatch, watchCamera } = tvHost

  /**
   * The comfort layer, and both go in the SCENE ROOT on purpose.
   *
   * The horizon must not be parented to the ship — a world-locked reference
   * that rolls with you is not a reference, and `comfort-horizon.test.ts` is the
   * measurement that would catch it. The vignette must not be parented to the
   * camera either: its vertex shader writes clip space directly, so it has no
   * transform and no z to clip at the 0.08 near plane, which is the second half
   * of PORT_PLAN 2.1's fade-quad fix.
   */
  const vignette: Vignette = createVignette({ setting: appSettings.comfort.vignette })
  // What the frame loop hands the vignette (DEV-383): the body's two references
  // and the seat's vertical acceleration, rewritten each frame, never kept.
  const vignetteFeed: {
    angularVelocity: VignetteInput['angularVelocity']
    orientation: VignetteInput['orientation']
    verticalAcceleration: number
  } = { angularVelocity: v3(), orientation: { x: 0, y: 0, z: 0, w: 1 }, verticalAcceleration: 0 }
  const horizon: Horizon = createHorizon()
  render.scene.add(vignette.object, horizon.object)
  // ── DEV-446: the scene tint ───────────────────────────────────────────
  //
  // In the mission scene's SHELL, beside the vignette, so no teardown takes it
  // and the warm-up compiles its one small program under the curtain whether
  // or not a tint is authored (`renderer.compile` walks hidden objects too), so
  // a tint switched on mid-flight is not a compile in the air. Hidden, and
  // therefore free, while its value is identity; the frame loop updates it
  // beside the vignette. `render/scene-tint.ts` says where it sorts and why.
  const sceneTint: SceneTint = createSceneTint()
  render.scene.add(sceneTint.object)
  /**
   * S6's gate pulse (DEV-108), drawn by the vignette's own pass for the three
   * reasons `render/gate-pulse.ts` sets out — per-eye correct for free, outside
   * the bloom and outside ACES, and composited under the black so a death
   * cannot be lit up by the gate you took on the way into the water.
   *
   * It is a driver, not a surface: it holds a level and a phase and knows
   * nothing about the quad.
   */
  const gatePulse: GatePulse = createGatePulse()
  /**
   * DEV-638/639: the clean-gate ladder and the speed chain's expiry edge. Per run,
   * reset with the pulse. Presentation only: the sim's own streak is untouched.
   */
  const gateLadder = createGateLadder()
  const chainWatch = createChainWatch()
  /**
   * DEV-640: a tank you can feel. The raw boost press's edge (for the dry click),
   * whether boost burned on the last step, the cabin lamps' eased glow, and the
   * amber flash a tank that runs dry throws on the gate pulse's own edge quad.
   */
  const boostPress = createRisingEdge()
  /**
   * DEV-641: the player's place changing, and a ship going by. Per run: both are
   * forgotten with the pulse at a restart, so a teleport cannot read as a pass.
   */
  const overtakeWatch = createOvertakeWatch()
  let boostBurning = false
  let boostGlow = 0
  /**
   * A second pulse on the same edge quad for the moments that are not a gate
   * pass: the tank running dry (amber), the line (the medal's colour). It carries
   * its own colour; the quad draws the stronger of it and the gate's, never a sum.
   */
  const accentPulse: GatePulse = createGatePulse()
  const accentFlashColor = new THREE.Color()
  /** Fire the edge flash in `r, g, b` (LINEAR) at `scale` times a plain gate's pulse. DEV-640/644. */
  const fireAccentFlash = (r: number, g: number, b: number, scale: number): void => {
    accentFlashColor.setRGB(r, g, b)
    accentPulse.fire(
      editionState.current.fx.gatePulse,
      EDGE_FLASH_SPEED,
      editionState.speedFx,
      scale,
    )
  }
  /**
   * Does the look have a lens at all (`render.flatFov.enabled`)? The Classic look
   * is exactly 2016's one 70 degree lens (`tests/e2e/flat-fov.spec.ts` holds it),
   * so the feel layer's lens effects (a kick at a gate and at GO, the boost push)
   * run only where the look's lens does. DEV-638, 640, 644.
   */
  const lensIsLive = (): boolean => editionState.current.render.flatFov.enabled
  /** Does this run judge its gates: the rules have clean gates AND a ring scores here? */
  const gatesJudged = (): boolean =>
    editionState.current.gameplay.gateEvents.enabled &&
    rulesFor(RUNNING_MODE).scores.includes('ring')
  /** Scratch, written every frame the pulse is alive. Never read across calls (trap 19). */
  const gatePulseColor = new THREE.Color()
  /** Scratch for the next-gate arrow's target, ship-local (DEV-124). Never read across calls. */
  const arrowTarget = new THREE.Vector3()
  /**
   * DEV-127's out-of-bounds static, drawn by the vignette's own pass under the
   * black and over the pulse. Like the pulse it is a driver, not a surface: it
   * holds the grain clock and builds a frame from the boundary's own progress.
   */
  const boundaryFuzz: BoundaryFuzz = createBoundaryFuzz()
  /**
   * The transition fade (DEV-107), drawn by the vignette's own pass.
   *
   * It starts SOLID and stays there until `reveal()` — which `main.ts` calls on
   * the Start click — AND the first world has landed. That pairing is L4 of
   * `docs/plan/LOADING.md`: the world can still assemble in front of you, it
   * just does it behind black. A guarantee rather than a heuristic, for
   * DEV-041's reason: prefer a placement that cannot be wrong over a score that
   * is usually right.
   */
  const fade: Fade = createFade()
  fade.blackOut()
  /** The last `phase` written to the DOM, so the attribute is set on the edge. */
  let fadePhaseShown: FadePhase | null = null
  // APP-SPLIT 3.2: one run's state, ONE record (`boot/app/run-state.ts` holds
  // each field's type and its doc). Declared where the first of the `let`s it
  // replaces was, initialised with each one's own initialiser.
  const run: RunState = {
    dyingCurtain: false,
    strandedShown: 'ok',
    headShown: 'ok',
    crash: createCrash(),
    crashCurtain: false,
    energy: createEnergy(
      energySpec(editionState.current.gameplay.energy.rechargeScale),
      editionState.current.gameplay.energy.startFill,
    ),
    boostWasAvailable: false,
    energyRace: createEnergyRace(
      energyRaceSpec(
        editionState.current.gameplay.energyRace.drainScale,
        editionState.current.gameplay.energyRace.gatePayFraction,
      ),
    ),
    award: null,
    awardLatch: null,
    lastResult: null,
    snapped: false,
    elapsed: 0,
  }
  /**
   * DEV-364 follow-up: the cockpit's jolt from a racer's hit, in render
   * seconds. The nudge is the sim's; this is only how long the cockpit rattles.
   */
  const hitJolt = createHitJolt()
  run.boostWasAvailable = boostAvailable(run.energy)
  let revealRequested = false
  let firstWorldSettled = false
  const maybeReveal = (): void => {
    if (revealRequested && firstWorldSettled) fade.release()
  }

  editionState.subscribe(() => handles.liveLaunchLook?.())
  /**
   * DEV-238's ordering switches, as state rather than as a property of the
   * objects they move. **All three are the DEFAULT since DEV-241 / DEV-246.**
   *
   * Held here because the objects do not survive a level change and the
   * INTENT does: a sweep that turns `ocean` OFF and then reloads into the next
   * mission has to be able to re-assert that against the new group, which is
   * `xr-vrto3d-trace.spec.ts`'s re-derive-every-poll rule arriving from the
   * other side.
   *
   * **All start TRUE, and nothing in this file throws any of them.** That is
   * not the same statement it used to be and the difference matters: the order
   * is applied where the objects are BUILT — `render/sky.ts` for the dome,
   * `game/terrain/load-terrain.ts` for the sea, `game/flight.ts` and
   * `game/jumpseat-flight.ts` for the vehicle — so a new level arrives in the
   * shipped order without this file saying anything, and these flags exist
   * only so that an A/B arm SURVIVES a course swap. If they had to be thrown
   * here, a mission loaded after the arm was set would quietly go back to the
   * default and the trace would be a mixture with no name.
   */
  let oceanLateOn = true
  let skyLastOn = true
  let cockpitFirstOn = true
  /**
   * DEV-243's redraw cadence, held for exactly the reason the two above are:
   * the HUD does not survive a course swap and the INTENT does. The frame loop
   * re-asserts it onto whatever panel is current, which is a no-op whenever it
   * is already in force.
   *
   * Starts at the `?hudRedraw=` pin, which since DEV-248 is the 10 Hz budget
   * unless somebody asked otherwise — so an ordinary run repaints at the rate
   * Matt enabled, and `?hudRedraw=live` is the arm that goes back.
   */
  let hudRedraw: HudRedraw = HUD_REDRAW_PIN
  /**
   * DEV-244. The HUD's UPLOAD mode, held here for exactly the cadence's reason:
   * the panel does not survive a course swap and the intent does.
   *
   * Starts at the `?hudUpload=` pin, which is `mip` unless somebody asked
   * otherwise — so an ordinary run uploads exactly as it always has.
   */
  let hudUpload: HudUpload = HUD_UPLOAD_PIN
  /**
   * DEV-256. The HUD's RASTER backend, held here for the other two's reason and
   * with one of its own: this intent is also what a course swap has to REBUILD
   * the panel with, because the mode is a construction argument and not a
   * setting. `loadFlight` takes it, and the frame loop re-asserts it so a live
   * `__ff2.hudRaster()` flip survives the next swap.
   *
   * Starts at the `?hudRaster=` pin, which is `gpu` unless somebody asked
   * otherwise — so an ordinary run rasterises exactly as it always has.
   */
  let hudRaster: HudRaster = HUD_RASTER_PIN
  /**
   * DEV-257. Which of the panel's readings are geometry, held here for the
   * other two pins' reason: the panel does not survive a course swap and the
   * intent does.
   *
   * Starts at the `?hudGauges=` pin, which is `off` unless somebody asked — so
   * an ordinary run draws exactly the panel that ships.
   */
  let hudGauges: HudGauges = HUD_GAUGES_PIN
  /** DEV-528: the panel's copy of the buffet's engine weights; the preset's until a slider moves. */
  const shakeLookdev = createShakeLookdev()

  /**
   * Wireframe. See WIRE_AT_BOOT. Materials are shared per terrain, so this sets
   * each one a handful of times rather than once per chunk — idempotent, and
   * `wireframe` is a draw mode rather than a define, so nothing recompiles.
   *
   * The stage and the key handler are per PAGE, out here, and the world is an
   * argument. They used to be declared inside `buildWorld`, which runs once per
   * `switchMission` and removed nothing: after N switches there were N
   * handlers, so L toggled the lookdev panel N times (an even N never opened
   * it) and O cycled N stale stages over N disposed worlds that the closures
   * kept reachable. `tests/unit/boot-world-listeners.test.ts` guards it.
   *
   * The world is passed in rather than read off `liveTerrain` because
   * `buildWorld` paints its new terrain before it assigns `liveTerrain`.
   */
  let wireStage: WireStage = WIRE_AT_BOOT
  const applyWireframe = (world: { terrain: LoadedTerrain; ocean: LoadedTerrain | null }): void => {
    const paint = (group: THREE.Object3D, on: boolean): void => {
      group.traverse((o) => {
        const m = (o as THREE.Mesh).material as
          | (THREE.Material & { wireframe?: boolean })
          | undefined
        if (m && 'wireframe' in m) m.wireframe = on
      })
    }
    paint(world.terrain.group, wireStage === 'islands' || wireStage === 'all')
    if (world.ocean) paint(world.ocean.group, wireStage === 'ocean' || wireStage === 'all')
    document.body.dataset.wireframe = wireStage
    console.info(`wireframe: ${wireStage} (press O to cycle)`)
  }
  globalThis.addEventListener?.('keydown', (e) => {
    if ((e as KeyboardEvent).code === 'KeyL') {
      handles.liveLookdev?.toggle()
      return
    }
    if ((e as KeyboardEvent).code !== 'KeyO') return
    // Between worlds there is nothing to paint, and before the first one this
    // handler did not exist at all — so the key does nothing rather than
    // advancing a stage nobody can see.
    if (!handles.liveTerrain) return
    wireStage = WIRE_STAGES[(WIRE_STAGES.indexOf(wireStage) + 1) % WIRE_STAGES.length] as WireStage
    applyWireframe(handles.liveTerrain)
  })

  /**
   * DEV-232. Re-resolve the sun and push both halves of the bake at whatever
   * the module has registered, then report what is actually true.
   *
   * **It does not read `liveTerrain`, and that is the bug it is the fix for.**
   * The first version gated on `liveTerrain?.terrain` and was called from a
   * line that runs **902 lines before `liveTerrain` is assigned**, so it had
   * never once done anything — which is why the A/B came back with the program
   * count identical in all three arms and no error anywhere. The module now
   * registers its own root and materials at the call site that HAS them.
   */
  const refreshBakedLight = () => bakedLight.refresh(render.scene)

  // The INTENT follows the preset; the RESOLUTION happens in `refresh`.
  // Separated because `VRTO3D_FLAGS_ON` flips as soon as `__ff2.edition`
  // exists — before the world is built — so anything resolved at flip time is
  // resolved against a scene with no terrain in it, and the first version had
  // nothing that ever tried again. (DEV-231's lesson inverted: there a state
  // was overwritten every frame; here one was computed once, too early.)
  attachEditionBakedLight(
    bakedLight,
    editionState,
    () => {
      refreshBakedLight()
    },
    // DEV-237. `?bakedRung=` overrides the preset's rung and nothing else — the
    // flag still decides whether the bake runs at all, because that is the half
    // `VRTO3D_FLAGS_ON` can reach and the half a player can reach.
    BAKED_RUNG_PIN,
  )

  /**
   * DEV-193's spike, when it is folded. One entry per terrain that was folded —
   * the island and, if it has one, the sea.
   *
   * Out here with the other live handles because it has to be dropped on a
   * course swap like every one of them: `disposeWorld` clears `liveTerrain`, and
   * a batch holding hidden meshes from a world that is gone is a leak with a
   * `BatchedMesh`'s buffer attached to it.
   */
  let liveChunkBatches: { key: string; set: ChunkBatchSet }[] = []
  const craftSplashes = new Map<string, CraftSplashState>()
  /** DEV-336: the sun's halo. One billboard for the life of the page. */
  const sunHalo = createSunHalo(SUN_HALO_METRES)
  /** Volatile scratch for the halo frame block. Never stored. */
  const _haloEye = new THREE.Vector3()
  /** DEV-532: the head, for the leapers' breach cue. Scratch, read inside one call. */
  const _lifeEye = new THREE.Vector3()
  const _towardSun = new THREE.Vector3()
  const _sunColour = new THREE.Color()
  /**
   * The rise the LAND comes on at for the loaded mission — 2016's `REVEAL_RISE`
   * on six rigs, a little later on `rookie_01_hoverJet` where the hillside
   * crosses the bore above the deck. `revealRiseFor` says why. DEV-106.
   */
  let landRevealRise = REVEAL_RISE
  let hangar: HangarArt | null = null
  /**
   * The room's variant step (DEV-382). Anniversary only: `enabled` reads the
   * LIVE edition, so a flip takes the step away at the room's next re-lay. The
   * cards are dealt once per aircraft, off `content/aircraft/<vehicle>.json`.
   */
  const hangarVariants = variantStep(() => editionState.current, aircraftFor, lastVariantOf)
  const _cameraWorld = new THREE.Vector3()
  // ══ THE MISSION CAN BE SWAPPED IN PLACE ══════════════════════════════════
  //
  // `let`, not `const`, and the same for everything computed from it below.
  // Choosing a course used to set `?mission=` and reload the document — 2016 did
  // the same (`Application.LoadLevelAsync`) but 2016 has no browser in front of
  // it, so a reload put the gesture card back up, dropped the audio context, and
  // ENDED ANY IMMERSIVE SESSION. In a headset that is the whole game gone.
  //
  // `switchMission` below tears the world down and builds the next one while the
  // player sits in the menu — which is only possible because the menu is its own
  // scene now (DEV-076) and is not part of what gets torn down.
  // DEV-454: `?sunlight=port` swaps the sun's colour here, once, for every reader.
  let level = withSunLightRule(await loadLevel(MISSION), SUN_LIGHT_RULE)
  /**
   * How far the world is (DEV-107, L1/L5 of `docs/plan/LOADING.md`).
   *
   * `LoadTerrainOptions.onProgress` has been called once per chunk since the
   * loader was written and consumed by nothing. This is the consumer, and it
   * feeds two surfaces: the landing card's button, and the hangar's header
   * during a course swap.
   */
  const loading: LoadProgress = createLoadProgress(environmentDisplayName(level.environment))
  /**
   * The mode actually running, `forcedMode` applied.
   *
   * Resolved ONCE, here, and read as a value everywhere below — never
   * recomputed and never branched on by name. `game/modes.ts` holds one row per
   * mode saying which collectibles are live, which score, what ends a run and
   * what scale the medal is on; this file asks that row questions.
   *
   * Two shipped scenes force a mode regardless of what the player picked
   * (`int_02_jumpSeat` and `hoverJet_kauai_beg`, both to Free Flight), and until
   * now `forcedMode` was in the schema and read by nothing — so kauai shipped
   * with the 21 rings and the race clock its own scene switches off. FF2 obeys
   * one of those two: `int_02_jumpSeat`'s forcing is dropped (DEV-061), because
   * all twelve of its orbs ship deactivated and nine of its pads are live, so the
   * mode it was locked into could score nothing.
   *
   * **`MODE_REQUEST()` is the day this comment used to promise** — *"there is no
   * mode SELECT yet, so `runningMode` gets no request; the day there is one, it
   * is a second argument here and nowhere else."* It is `?mode=`, and it is a
   * second argument here and nowhere else. DEV-144.
   */
  /**
   * What the player is ASKING for, or nothing. A level's own forcing still wins.
   *
   * A function rather than a constant because the answer depends on the LIVE
   * preset: DEV-144's `energyRace` is Anniversary-only, and `gameplay.
   * energyRace.enabled` is what makes it selectable at all. Refusing it here —
   * at the one seam a mode is chosen through — is why nothing downstream has to
   * check a preset before trusting `RUNNING_MODE`.
   *
   * A request the preset will not honour falls through to the level's own mode
   * with a console line, rather than silently running a mode with no tank under
   * it, which would be Ring Attack wearing a different name.
   */
  const MODE_REQUEST = (): GameMode | undefined => {
    if (!MODE_PARAM) return undefined
    if (rulesFor(MODE_PARAM).energyPowered && !editionState.current.gameplay.energyRace.enabled) {
      console.warn(
        `?mode=${MODE_PARAM} needs the Anniversary preset (gameplay.energyRace.enabled) — ignored`,
      )
      return undefined
    }
    return MODE_PARAM
  }
  let RUNNING_MODE = runningMode(level, MODE_REQUEST())
  const mission: MissionState = startMission(level, MODE_REQUEST())

  // ── DEV-649: the splits, and the flat race strip ───────────────────────
  //
  // `splits` reads what the sim already decided (the tick each entrant took a
  // gate) and writes nothing back; `raceStrip` is DOM, so only a flat screen
  // has it (`syncRaceStrip`). Both logic and look live in their own modules.
  const splits = createSplitTracker()
  const raceStrip = createRaceStrip(typeof document === 'undefined' ? null : document)

  // ── pause ───────────────────────────────────────────────────────────────
  //
  // 2016's pause does NOT stop the clock: `Time.timeScale` is touched only by
  // `TimeController.cs`, which is not in the mission scene, and
  // `Timer_Race.RaceTimer()` is a `WaitForSeconds` coroutine that keeps
  // counting. So pausing there costs you the race, which makes the pause menu
  // useless for the thing a pause menu is for. **DEV-033: FF2 stops the sim.**
  //
  // The mechanism is simply not calling `stepFixed`, which freezes the physics,
  // the clock, the racers and the scoring together because they all live under
  // it. Rendering carries on, so the world does not go black and the panel is
  // composited over a live cockpit.
  // ── Which screen you are on (APP-SPLIT 3.3, `boot/app/screen-router.ts`) ──
  const router = createScreenRouter({
    fade,
    get loadingHost() {
      return loadingHost
    },
    wearEditionFor,
  })
  const { goToScreen } = router
  /** World pose of the chair, filled when the hangar is built. */
  const seatWorld = new THREE.Vector3()
  const seatQuaternion = new THREE.Quaternion()

  /** Is the nose pointer on the holotable? Only meaningful on the menu screen. */
  // The game's sound, constructed (APP-SPLIT, `boot/app/audio.ts`).
  const appAudio = createAppAudio({
    get comfort() {
      return appSettings.comfort
    },
    editionState,
  })
  const { audio, applyVolume } = appAudio
  /**
   * Edge state for the cues that fire on a TRANSITION rather than on a call.
   *
   * `audioLaunchPhase` starts as a value no `LaunchPhase` can take, so the very
   * first `audioLaunch()` compares against "nothing yet" rather than against a
   * phase — the launch state is declared below this line and reading it here
   * would be a use-before-declare, and seeding it with `'waiting'` would
   * silently swallow the first transition on the `?ride=0` path, which starts
   * in `'flying'`.
   */
  let audioLaunchPhase: string = ''
  let audioCountdown = -1
  let audioHovered = false
  let audioPauseAim = -1
  /** DEV-646: the aim of each menu that had no hover sound, as a change detector. */
  const titleFocus = createFocusEdge()
  const lobbyFocus = createFocusEdge()
  const codeFocus = createFocusEdge()
  /**
   * How many shaft collars the lift has already whooshed past this ride.
   *
   * −1 means "not armed yet". On the first frame of a ride it is set to the
   * number of collars ALREADY below the eye rather than to zero, so a collar
   * the player starts above never fires — which is `OnTriggerEnter`'s own
   * semantics: a box you were never inside is a box you never entered. Reset by
   * `restartRun` along with the launch, because a second ride passes them all
   * again. AUD-5.
   */
  let audioCollar = -1
  let audioFinishCrossed = false
  let audioBoundaryLeft: number | null = null
  let holotableHovered = false
  /**
   * Where the seated player is looking, relative to the chair.
   *
   * The nose pointer is the head in a headset, and a headset can turn. On a
   * flat screen nothing can — the chair is bolted down and there is no ship to
   * steer — so a menu with no look control is a menu with exactly one
   * reachable target forever.
   *
   * It used to borrow the FLIGHT stick, and that was the bug Matt found on
   * 2026-09-13: `-= actions.yaw` put looking left and right on the left stick's
   * VERTICAL, and `-= actions.pitch` gave the look a flight-sim pitch. It is
   * `input/look.ts` now — the right stick and the mouse, three.js conventions,
   * no flight model anywhere near it. DEV-070.
   */
  let seatLookYaw = 0
  /**
   * Starts pitched DOWN at the table, not level.
   *
   * A table is below the eye, so a seat aimed only in yaw points over the top
   * of it and the nose pointer never touches anything. Carried in the look
   * state rather than baked into the chair's quaternion so that looking back UP
   * is just the look returning it, with no special case.
   */
  let seatLookPitch = seatPitchLocal()
  /**
   * The hangar step the seat last rested for (DEV-606), or null off the room.
   * A change sets the look back to rest; see the room's look block.
   */
  let seatRestKey: string | null = null
  /** How far down you may look from the chair. The RATE lives in `input/look.ts`. */
  const SEAT_PITCH_LIMIT = 1.1
  /**
   * The mouse, captured. Flat-screen only — `setEnabled(false)` in session,
   * where a captured pointer is a pointer nobody can see or release.
   */
  const mouseLook = attachMouseLook(canvas)
  /**
   * Two thumbs, for the visitor the landing page used to turn away.
   *
   * Built only where `capability-gate.ts` found a coarse primary pointer, so a
   * desktop gets a stand-in with no elements in its DOM and nothing over its
   * canvas. Starts hidden; `main.ts` raises it at boot (DEV-557: there is no
   * landing card left for it to wait behind).
   */
  const touch = attachTouchControls(canvas, { enabled: capabilities.touch })
  /**
   * DEV-566: a phone plays sideways (Matt, 2026-10-02: *"let's make it so it's
   * landscape only in phone mode"*). Held upright, a phone gets TURN YOUR
   * PHONE over everything; the frame loop holds the pads off and keeps a live
   * run paused while it stands (`pauseSignals.held`). Built in the game's touch
   * mode only; whether the device is a PHONE rather than a tablet is the
   * screen's short side, asked live (`input/turn-phone.ts`).
   */
  const turnScreen = attachTurnScreen(canvas.ownerDocument, globalThis.window ?? null, {
    enabled: capabilities.touch,
  })
  // DEV-795: the same Add to Home Screen line, once on the title's credit line,
  // for a player who opened the link already sideways and never met the turn screen.
  const titleHomeHint = createTitleHomeHint({
    line: canvas.ownerDocument.getElementById('title-line') ?? { textContent: null },
    doc: canvas.ownerDocument,
    win: globalThis.window ?? null,
    enabled: capabilities.touch,
  })
  // DEV-842: and the whole card for it, on any phone browser that is not already
  // running from the home screen: the sentence, iOS and Android steps, dismissable
  // and remembered. Flat only (the frame loop passes the title as down in a session).
  const homeScreenGuide = createHomeScreenGuide({
    doc: canvas.ownerDocument,
    win: globalThis.window ?? null,
    enabled: capabilities.touch,
  })
  /**
   * The phone as a neck (DEV-292). Matt: *"i'd [like] them to be able to move
   * their phone to look around … with the plane in autopilot"*.
   *
   * Gated on `capabilities.touch` and not merely on the sensors existing: a
   * laptop with a touchscreen and an accelerometer would otherwise grow a chip
   * for a control nobody can use, and the whole overlay is already the answer
   * to "is this a device held in two hands".
   *
   * The TOGGLE is a callback rather than a latch the loop reads, and that is
   * not a style choice — `DeviceLook.enable`'s doc comment has the reason, and
   * it is iOS's, not ours.
   */
  const deviceLook = capabilities.touch
    ? attachDeviceLook(globalThis.window ?? null)
    : noDeviceLook()
  touch.onGyroTap(() => {
    if (deviceLook.head() !== null || tiltWanted) {
      tiltWanted = false
      deviceLook.disable()
      // Straight ahead again. Without this the seat keeps whatever angle the
      // phone was at when it was switched off, which reads as the view having
      // stuck rather than as the control having stopped.
      freeLook.reset()
      console.info('tilt look off')
      return
    }
    tiltWanted = true
    void deviceLook.enable().then((ok) => {
      tiltWanted = ok
      console.info(`tilt look ${ok ? 'ON' : 'refused'}`)
    })
  })
  /** The player asked for the tilt look; `deviceLook.active` says whether it is live. */
  let tiltWanted = false
  /**
   * The last look the CHASE ARM was handed, and where it came from (DEV-292).
   *
   * Null until a frame has drawn the third-person camera, which is also the
   * honest answer to *"is the chase camera live"* for a spec.
   */
  let lastOrbitLook: { yaw: number; pitch: number; fromDevice: boolean } | null = null
  /**
   * The cockpit's look, which comes BACK — `input/look.ts` says why the hangar's
   * does not. Reset whenever the run does, so a restart never begins sideways.
   */
  const freeLook = createFreeLook()

  // ══ CHANGE VIEW — the third-person camera (DEV-128) and the placement
  // ══ patches the lookdev panel edits (DEV-129). ONE block on purpose: ten
  // ══ other branches touch this file and a contiguous block merges.
  //
  // `thirdPersonWanted` is the PLAYER'S choice — CHANGE VIEW pressed — and it
  // outlives a run, a pause and a menu visit, as 2016's `PlayerCameraPref` did.
  // Whether the camera is actually outside THIS FRAME is `thirdPersonLive`,
  // computed once a frame below from that choice and four refusals: no flight
  // to look at, not in a mission, paused (the pause plate is a cockpit panel
  // and is aimed from the seat), a finished run (the results plate likewise),
  // and — the one that is a rule rather than a convenience — an XR session.
  // In a headset the camera IS the head; a rig placed behind the ship is a
  // comfort feature with its own research and is not this one.
  let thirdPersonWanted = CAMERA_AT_BOOT || appSettings.comfort.cameraView === 'third'
  const cameraKey = createEdge()
  let lastThirdPersonLive = false
  /** The Anniversary arm. Classic never reads it: it draws 2016's own chase. */
  const springArm: SpringArm = createSpringArm()
  /**
   * 2016's own chase, which is what Classic draws. DEV-156. Both presets carry
   * state that has to forget itself on a restart or a view toggle, and which of
   * the two is live is decided a thousand lines below — so the reset is ONE
   * function and never four call sites that can drift apart by a preset.
   */
  const classicChase: ClassicChase = createClassicChase()
  const resetThirdPerson = (): void => {
    springArm.reset()
    classicChase.reset()
  }
  /**
   * The collision surface, THREE space, for the arm's probe — terrain OR sea,
   * whichever is higher. Built from `collisionTerrain`, the same fields the
   * hull is tested against, with the sim's z flipped on the way in.
   */
  const surfaceHeightAt: SurfaceHeightAt = (x, z) =>
    highestGroundUnder(handles.collisionTerrain, x, -z, PADS_SOLID)
  /**
   * The lookdev Placement patches. Null means "the preset's". Dropped on a
   * preset flip (see `editionState.subscribe` above), applied to the flight
   * when it lands (`loadedFlight.placeHud` below) and on every drag.
   */
  // DEV-362: the readout patch belongs to the VEHICLE it was dragged on. Each
  // vehicle reads its own block (`hudPlacementFor`), so a patch made in the
  // HoverJet's dash must not follow a course swap onto the JumpSeat's shell.
  let placementPatch: { vehicle: Level['vehicle']; p: EditionHudPlacement } | null = null
  let cockpitPatch: EditionCockpit | null = null
  let thirdPersonPatch: EditionThirdPerson | null = null
  /** The cloud whiteout level carried between frames (DEV-277). */
  let cloudWhite = 0
  const hudPlacementNow = (): EditionHudPlacement =>
    (placementPatch?.vehicle === level.vehicle ? placementPatch.p : null) ??
    hudPlacementFor(editionState.current.cockpit.placement, level.vehicle)
  const cockpitNow = (): EditionCockpit => cockpitPatch ?? editionState.current.cockpit
  const thirdPersonNow = (): EditionThirdPerson =>
    thirdPersonPatch ?? editionState.current.render.thirdPerson
  const placementTuning: PlacementTuning = {
    editionId: () => editionState.current.id,
    hudKey: () => hudPlacementKey(level.vehicle),
    hud: hudPlacementNow,
    setHud: (p) => {
      placementPatch = { vehicle: level.vehicle, p }
      handles.flight?.placeHud(p)
      if (handles.flight && perfPlate) perfPlate.place(p, PLATE_SIDE, handles.flight.eye)
    },
    cockpit: cockpitNow,
    setCockpit: (c) => {
      cockpitPatch = c
      handles.flight?.setInterior(c)
    },
    thirdPerson: thirdPersonNow,
    setThirdPerson: (t) => {
      thirdPersonPatch = t
    },
  }
  // ══ end of the CHANGE VIEW block ═══════════════════════════════════════════

  // APP-SPLIT 3.5: the pause and its aim, ONE record (`boot/app/pause-state.ts`).
  const pause: PauseState = {
    paused: false,
    pauseAim: 0,
  }
  /** The pause control's edge. Stepped once a frame, BEFORE every reader (`input/edge.ts`). */
  const pauseKey = createEdge()
  /** DEV-563: edge state for a free Escape, which pauses as Backspace does. */
  const escapeKey = createEdge()
  // The XR session's edges and a lost context (APP-SPLIT, `boot/app/xr-lifecycle.ts`).
  const xrLifecycle = createXrLifecycle({
    editionState,
    render,
  })
  // ── DEV-261: `?perf=1` starts it. Matt's ask, and one line of it ──────────
  //
  // *"make it so once perf=1 is there, it records until i stop it."* The plate
  // and the recording used to be separate — the plate on a URL parameter, the
  // recording on a button in the pause menu two menus deep, which in a headset
  // is two menus deep WHILE WEARING IT. The event worth catching is at the
  // race start, so anything that has to be armed after boot is armed after the
  // event.
  //
  // Nothing else changes: `?perf=0` is still off, the pause row still stops it
  // and writes the file, and a load without `?perf=` records nothing at all.
  if (PERF_HUD) togglePerfCapture()
  // ── Menu aim, the laser, the pause plate (APP-SPLIT 4.6, `boot/app/hangar/menus.ts`) ──
  const menus = createMenus({
    get SKIP_STEP_OPTION() {
      return SKIP_STEP_OPTION
    },
    applyVolume,
    audio,
    canvas,
    get chosenEdition() {
      return appSettings.chosenEdition
    },
    set chosenEdition(v: EditionId) {
      appSettings.chosenEdition = v
    },
    get comfort() {
      return appSettings.comfort
    },
    set comfort(v: ComfortSettings) {
      appSettings.comfort = v
    },
    get confirmDevice() {
      return confirmDevice
    },
    editionState,
    feel,
    get flight() {
      return handles.flight
    },
    get lapAskUp() {
      return lapAskUp
    },
    get lessonHost() {
      return lessonHost
    },
    get level() {
      return level
    },
    mission,
    mouseLook,
    options,
    get pauseAim() {
      return pause.pauseAim
    },
    set pauseAim(v: number) {
      pause.pauseAim = v
    },
    get paused() {
      return pause.paused
    },
    perfCapture,
    pinned,
    presetFor,
    get qualityPins() {
      return appSettings.qualityPins
    },
    set qualityPins(v: QualityPins) {
      appSettings.qualityPins = v
    },
    render,
    roomActive,
    get screen() {
      return router.screen
    },
    get titleMenuUp() {
      return titleMenuUp
    },
    get titleVr() {
      return titleVr
    },
    tvView,
    vignette,
    wearEdition,
  })
  const {
    _aimOrigin,
    _aimDirection,
    xrPointer,
    pointerArbiter,
    aimPlate,
    controlsMenu,
    pausePlate,
    pausePageBack,
    closePausePages,
    pauseSteps,
    pauseBackKey,
    pauseRowAt,
    pointerWanted,
    aimMenus,
    creditsRollFor,
    CREDITS_BODY_M,
  } = menus

  // ── After a run (APP-SPLIT 4.4, `boot/app/results.ts`) ────────────────
  //
  // The standings, Share and the ghost pick, the questions under the panel,
  // the course's board and the race map. Built here, where the block stood.
  const results = createResults({
    aimPlate,
    canvas,
    get confirmDevice() {
      return confirmDevice
    },
    get coursePanelOf() {
      return coursePanelOf
    },
    editionState,
    get flight() {
      return handles.flight
    },
    get glassRay() {
      return glassRay
    },
    get hangar() {
      return hangar
    },
    get hudRedraw() {
      return hudRedraw
    },
    get lapRun() {
      return handles.lapRun
    },
    get lastResult() {
      return run.lastResult
    },
    get launch() {
      return launch
    },
    get level() {
      return level
    },
    get liveGhosts() {
      return handles.liveGhosts
    },
    get livePlayerGhost() {
      return handles.livePlayerGhost
    },
    get liveRacers() {
      return handles.liveRacers
    },
    mission,
    mouseLook,
    get paused() {
      return pause.paused
    },
    get playerCourseNow() {
      return playerCourseNow
    },
    render,
    roomActive,
    roomMapField,
    get screen() {
      return router.screen
    },
    touch,
    tvOn,
  })
  const {
    lapAskUp,
    ghostLineFor,
    shareRoute,
    chosenGhost,
    syncRaceMap,
    boardLinkGhost,
    askNudge,
    askPointer,
    askConfirm,
    cycleGhost,
    withResultsBoard,
    withShare,
    opponentStandings,
    playerGhostStandings,
    askFrame,
    shareReport,
    resultsBoardReport,
  } = results

  // ── DEV-649: the flat screen's race strip ──────────────────────────────
  //
  // DOM, so it exists only while no XR session is presenting (the dash is a
  // headset's HUD, unchanged). On by default; the Edition page's RACE STRIP row
  // (`comfort.raceStrip`) hides it, and it follows the edition's race HUD flag
  // (`hud.raceMap`), so Classic's look in flight stays 2016's.
  /** The player's live place this frame, set where the race map reads it. */
  let stripPlace: LivePlace | null = null
  /** The one-time hint's storage key: shown on the first flat flight, never again. */
  const CAMERA_HINT_KEY = 'ff2.hint.camera.v1'
  const syncRaceStrip = (nowMs: number): void => {
    // DEV-847 (Matt, 2026-10-08: "make sure it's off in VR"): flat only. A
    // session that is starting or ending is not flat either, so the session
    // itself is asked as well as `isPresenting`, and the strip is a flat
    // screen's alone in every state a headset can be in.
    const flat = !render.renderer.xr.isPresenting && render.renderer.xr.getSession() === null
    const flying =
      flat &&
      handles.flight !== null &&
      router.screen === 'mission' &&
      !pause.paused &&
      run.lastResult === null &&
      (!launchSpec || launch.phase === 'flying') &&
      // Watching is not flying: TV, a watched room and the exhibition have their
      // own overlays, and the hint is for a player at the stick (and must write
      // nothing in a run that is only being watched: tv-exhibition holds that).
      !(tvActive() || roomCore.watch !== null || exhibition.running())
    // The hint: the first time a flat player is flying from the cockpit. Its
    // own flag, not the strip's: a player who turned the strip off still has
    // not been told the camera moves. A phone has the CAM chip on the glass.
    if (flying && !thirdPersonWanted && !touch.available && !raceStrip.hintShowing) {
      const store = safeStorage()
      if (store && store.getItem(CAMERA_HINT_KEY) === null) {
        try {
          store.setItem(CAMERA_HINT_KEY, '1')
          raceStrip.showCameraHint(nowMs)
        } catch {
          // No storage: no hint. A hint that cannot be remembered would be a
          // hint on every flight, which is a nag and not a hint.
        }
      }
    }
    const visible =
      flying && appSettings.comfort.raceStrip && editionState.current.hud.raceMap.enabled
    const split = visible && !mission.finished ? splits.current(mission.elapsed) : null
    const limit = hudTimeLimit(level, mission.mode)
    raceStrip.update(
      {
        visible,
        place: stripPlace?.place ?? null,
        field: stripPlace?.field ?? 0,
        countLabel: countLabel(level, mission.mode),
        count: `${String(mission.counted).padStart(2, '0')}/${String(mission.countTotal).padStart(2, '0')}`,
        timeLabel: uiLabel(level, 'timeLabel', 'TIME'),
        time: formatTime(mission.elapsed, limit, rulesFor(mission.mode).clockEnds),
        urgent: limit > 0 && Math.max(0, limit - mission.elapsed) < 20,
        score: missionScore(mission),
        split: split
          ? split.entries.map((e) => ({
              who: e.label,
              gap: gapText(e.gap),
              tone: gapTone(e.gap),
              ...(e.ai ? { ai: true } : {}),
            }))
          : null,
        touch: touch.available,
      },
      nowMs,
    )
  }

  // Another go (APP-SPLIT 3.2, `boot/app/run-reset.ts`).
  const runReset = createRunReset({
    MODE_REQUEST,
    accentPulse,
    audio,
    get audioCollar() {
      return audioCollar
    },
    set audioCollar(v: number) {
      audioCollar = v
    },
    get audioFinishCrossed() {
      return audioFinishCrossed
    },
    set audioFinishCrossed(v: boolean) {
      audioFinishCrossed = v
    },
    get boostBurning() {
      return boostBurning
    },
    set boostBurning(v: boolean) {
      boostBurning = v
    },
    boostPress,
    captureLiveRun,
    chainWatch,
    editionState,
    fade,
    freeLook,
    gateLadder,
    gatePulse,
    handles,
    get launch() {
      return launch
    },
    get lessonHost() {
      return lessonHost
    },
    get level() {
      return level
    },
    mission,
    overtakeWatch,
    perfSys,
    resetThirdPerson,
    results,
    get rideSpec() {
      return rideSpec
    },
    run,
    splits,
  })
  const { restartRun } = runReset
  // ══ THE MENU IS ITS OWN WORLD ════════════════════════════════════════════
  //
  // **Matt, 2026-09-14:** *"why aren't we making our menus work similar to the
  // 2016 version? (so we don't hit the environment probs)"* — and then, flatly:
  // *"the 2016 menus were completely different environments. the 'underground
  // hangar' was fictional."*
  //
  // He is right, and the port had it from a research doc that is WRONG.
  // `docs/research/_ui-flow.md` §5 says the level-select room *"is the bottom of
  // that shaft ... The menu and the launch were always the same room. That is
  // the port's entry point, and it needs no invention."* DEV-035/036 welded the
  // room into the mission world on the strength of that sentence.
  //
  // The scenes say otherwise, and they are not subtle about it:
  //
  //   setGameplayOptions      its own `Environment_Hangar.prefab` (shell + 8
  //                           shaft segments), 61 chair objects, 16 holotables,
  //                           two `hoverJet_exterior_orange`, and NO mission
  //                           terrain of any kind
  //   the mission launch rig  the same hangar prefab, **no chair**, **no
  //                           holotables** — scenery you ride out of
  //
  // Two rooms, two scenes, one of them furnished. Nothing underground.
  //
  // Everything that went wrong on 13/14 September came out of that weld: six
  // missions with no level select at all (the room was gated on the mission
  // having a launch rig), the alpine room full of hillside, alpine's sun tinting
  // the shell olive, and a mission switch that can only be done by reloading the
  // document. Each was fixed on its own; none of them could have existed.
  //
  // So: its own scene, its own origin, its own light, its own parked jet, and no
  // way for a mission's terrain, sun, fog or sky to reach it — because none of
  // them is in it. The frame picks the scene, and the XR RIG MOVES WITH IT:
  // three only walks the matrices of the scene it is rendering, so a camera
  // whose parent group sits in the other one goes stale where it stands.
  const menuScene = new THREE.Scene()
  // Named, so "which stage is on screen" is answerable from outside the page.
  // `App.stage()` already returns whichever of the two is live; without a name
  // a spec can only ask what is IN it, and the question the fade raises is
  // about the stage itself (DEV-107).
  menuScene.name = 'menu'
  // A little fill, so the shell reads as a room rather than as its own strip
  // lights hanging in the dark. The room carries a point lamp of its own
  // (`render/hangar.ts`); this is the bounce that lamp cannot fake, and it is
  // the SAME on every mission, which is the point of the whole change.
  menuScene.add(new THREE.AmbientLight(0xa8bdd2, 1.35))

  // DEV-363: the page's one sun, in the SHELL, so no teardown takes it and no
  // switch builds another. `sunShadows` and `cockpitSelfShadow` are handed
  // THIS light below and keep it for the session; `applyLighting` re-aims it.
  const pageSun = createSun(render.scene)
  /**
   * Everything in the mission scene that is NOT the mission: the XR rig, the
   * comfort vignette, the horizon line — and the sun (DEV-363), which every
   * world is lit by and re-aims rather than rebuilds.
   *
   * Captured before the first world's light is added, so `teardownWorld` can
   * remove *everything else* without a list to keep up to date. A list is what
   * rots — the next thing somebody adds to the world is the thing that survives
   * the swap and haunts the next mission.
   */
  const shellChildren = new Set(render.scene.children)

  handles.missionSun = applyLighting(render.scene, level, pageSun, AMBIENT_SOURCE)
  handles.liveSky = applySky(
    render.renderer,
    render.scene,
    level,
    editionState.current.render.smoothSky.enabled,
  )
  if (VIEWPOINT) {
    applyViewpoint(render.camera, VIEWPOINT)
    console.info(`viewpoint: ${VIEWPOINT.note}`)
    document.body.dataset.viewpoint = VIEWPOINT.note
  }
  // The hangar, built (APP-SPLIT 4.6, `boot/app/hangar/room.ts`).
  const hangarRoom = createHangarRoom({
    get RUNNING_MODE() {
      return RUNNING_MODE
    },
    get doorPress() {
      return doorPress
    },
    editionState,
    get editorOn() {
      return editorOn
    },
    ghostLineFor,
    get groundOfCourse() {
      return groundOfCourse
    },
    get hangar() {
      return hangar
    },
    set hangar(v: HangarArt | null) {
      hangar = v
    },
    hangarVariants,
    get level() {
      return level
    },
    get makeCourse() {
      return makeCourse
    },
    get menuEdition() {
      return roomCore.menuEdition
    },
    menuEditionLoad,
    menuScene,
    get openCourseFilePicker() {
      return openCourseFilePicker
    },
    get openRooms() {
      return roomLobby.openRooms
    },
    get playerCourseHost() {
      return playerCourseHost
    },
    get playerCourses() {
      return playerCourses
    },
    get room() {
      return roomCore.room
    },
    get roomId() {
      return roomCore.roomId
    },
    seatQuaternion,
    seatWorld,
    get shelfActions() {
      return shelfActions
    },
    titleLinkRoom,
    tvActive,
    tvOn,
    get watch() {
      return roomCore.watch
    },
  })
  const { titleRoomNotice, menuFlags, HANGAR_SEED, yourCourses, roomShadows } = hangarRoom

  // ── Anniversary systems: the aerial perspective ──────────────────────────
  //
  // V4 / DEV-082, and it has to be here rather than in the boot block above
  // because the fog is built from the LEVEL and the level lands later. The fog
  // owns the haze uniforms — one block, shared by every material it patches, so
  // one call reaches all of them — and the mission fog's own numbers are not
  // touched by any of it (DEV-018/018b are Matt's calls).
  //
  // DEV-552: the ONE door a mission fog comes through, and it wires the haze.
  // `createUnityFog` builds its haze uniforms at zero and only `setHaze` writes
  // them, so a fog nobody attached draws no haze. This used to be one
  // `attachEditionHaze` on the BOOT fog, and `switchMission` built a fresh fog
  // beside it: since DEV-281 made the title the boot world, every mission a
  // player reached flew without haze, while the boot fog's subscription went on
  // writing to a fog no material read. DEV-363's sun, the same shape.
  // `tests/unit/haze-follows-fog.test.ts` holds every mission fog to this door.
  let detachFogHaze: () => void = () => {}
  const wiredMissionFog = (l: Level): UnityFog => {
    detachFogHaze()
    const f = missionFog(l.fog, l, {
      fogEnabled: FOG_ENABLED,
      fogTakesSkyColour: FOG_TAKES_SKY_COLOUR,
    })
    detachFogHaze = attachEditionHaze(f, editionState)
    return f
  }
  let fog = wiredMissionFog(level)

  // The light and air every world is drawn through (APP-SPLIT, `boot/app/atmosphere.ts`).
  const atmosphere = createAtmosphere({
    air,
    editionState,
    get flight() {
      return handles.flight
    },
    get fog() {
      return fog
    },
    horizon,
    get liveSky() {
      return handles.liveSky
    },
    pageSun,
    render,
    sceneTint,
    sunHalo,
    vignette,
  })
  const {
    applyAtmosphere,
    farShadow,
    skyVisibility,
    sunShadows,
    applyGroundAtmosphere,
    applyPropAtmosphere,
    seaReflection,
    cloudShadow,
    cockpitSelfShadow,
    nearShadow,
  } = atmosphere

  // Load the world. The loop runs against an empty scene until it lands rather
  // than blocking boot behind two megapixel PNGs and 1.8 M vertices.
  const titleTrailEye = new THREE.Vector3()
  /** Which of `titleRows()` a press would take. Opens on a link's row, else START. */
  let titleAim = 0
  // The title's rows and the hangar's first step (APP-SPLIT 4.5, `boot/app/title/menu.ts`).
  const titleMenuHost = createTitleMenu({
    CREDITS_BODY_M,
    creditsRollFor,
    menus,
    OPEN_ROOMS_POLL_MS,
    canvas,
    capabilities,
    get openOptionsPlate() {
      return optionsPlate.open
    },
    get makeCourse() {
      return makeCourse
    },
    get codeOpenPlate() {
      return codeOpenPlate
    },
    get codeUp() {
      return codeUp
    },
    get courseLinkRow() {
      return courseLinkRow
    },
    get editorOn() {
      return editorOn
    },
    goToScreen,
    get hangar() {
      return hangar
    },
    joinLinkRoom,
    get letterPlate() {
      return letterPlate
    },
    menuFlags,
    mouseLook,
    options: menus.options,
    get playerCourseHost() {
      return playerCourseHost
    },
    render,
    results,
    get room() {
      return roomCore.room
    },
    roomClose,
    roomCourseCards,
    roomCourseTitles,
    get roomId() {
      return roomCore.roomId
    },
    roomLobby,
    roomOpen,
    get screen() {
      return router.screen
    },
    get startQuickRace() {
      return startQuickRace
    },
    startRoom,
    get titleAim() {
      return titleAim
    },
    set titleAim(v: number) {
      titleAim = v
    },
    titleLinkRoom,
    get titleMenu() {
      return handles.titleMenu
    },
    get titleMenuUp() {
      return titleMenuUp
    },
    titleRoomNotice,
    tvOn,
    tvView,
  })
  const {
    glassRay,
    titleVr,
    doorPress,
    titleRows,
    enterVrKey,
    goToTheHangar,
    titleRowAt,
    titleLookEuler,
    _titleLookQuat,
    openRoomsFrame,
  } = titleMenuHost
  // ── DEV-467, player courses in (APP-SPLIT 4.5, `boot/app/title/player-courses.ts`) ──
  const playerCourseHost = createPlayerCourses({
    get beginLoadingTarget() {
      return beginLoadingTarget
    },
    capabilities,
    get flight() {
      return handles.flight
    },
    goToScreen,
    get lastResult() {
      return run.lastResult
    },
    get level() {
      return level
    },
    get loadingScenePending() {
      return loadingScenePending
    },
    set loadingScenePending(v: boolean) {
      loadingScenePending = v
    },
    get menuEdition() {
      return roomCore.menuEdition
    },
    menuEditionLoad,
    get paused() {
      return pause.paused
    },
    get quickRaceAsked() {
      return quickRaceAsked
    },
    render,
    roomClose,
    get screen() {
      return router.screen
    },
    shareRoute,
    get switchMission() {
      return switchMission
    },
    get switching() {
      return switching
    },
    tvView,
  })
  const {
    coursePanelOf,
    playerCourseNow,
    editorOn,
    groundOfCourse,
    shelfActions,
    openCourseFilePicker,
    playerCourses,
    courseLinkRow,
    courseLibrary,
    keepCourse,
    keepMap,
    saveCourseFile,
    titleCoursePress,
    coursePanelPresses,
  } = playerCourseHost
  // ── DEV-441b and DEV-632, the letter plate (APP-SPLIT 4.6, `boot/app/hangar/letter-plate.ts`) ──
  const letterPlate = createLetterPlate({
    get confirmDevice() {
      return confirmDevice
    },
    get hangar() {
      return hangar
    },
    get lobbyAim() {
      return roomLobby.lobbyAim
    },
    set lobbyAim(v: number) {
      roomLobby.lobbyAim = v
    },
    lobbyPress,
    get lobbyRows() {
      return roomLobby.lobbyRows
    },
    lobbyUp,
    get room() {
      return roomCore.room
    },
    roomClose,
    roomOpen,
    get screen() {
      return router.screen
    },
  })
  const {
    codeOpenPlate,
    codeUp,
    codeNudgeEdge,
    codeKeysDown,
    codePress,
    codeClosePlate,
    codeJoinFrame,
    codePlateState,
    roomShare,
  } = letterPlate
  // ── DEV-857: the hangar's OPTIONS table opens the pause plate's OPTIONS page ──
  const optionsPlate = createOptionsPlate({
    CREDITS_BODY_M,
    creditsRollFor,
    glassRay,
    get hangar() {
      return hangar
    },
    menuScene,
    menus,
    mouseLook,
    pause,
    presenting: () => render.renderer.xr.isPresenting,
    get screen() {
      return router.screen
    },
    seatQuaternion,
    seatWorld,
    xrPointer,
  })
  /** One row per push on the title's rows (`input/menu-step.ts`). */
  const titleSteps = createRowStepper()
  /** Edge state for the title's BACK (DEV-441): B, or Backspace. */
  const titleBackKey = createEdge()
  /** Edge state for the hangar's back press (DEV-605). */
  const hangarBackKey = createEdge()
  /**
   * Is the title's menu up? On the title screen, once the valley is in — not
   * over the emblem on black, where there is nothing yet to leave.
   */
  const titleMenuUp = (): boolean =>
    router.screen === 'title' &&
    handles.titleMenu !== null &&
    (handles.titleCurtain === null || handles.titleCurtain.phase !== 'held')
  /**
   * Has the page had its first press? The NAME is the landing card's, whose
   * Start click this was until DEV-557 took the card away; the MEANING is
   * unchanged and other code reads it by this name: the page has had a
   * gesture, so the AudioContext can run, and a `?tv` or `?watch=` link may
   * board (`tvView`'s `ready`, `watchFrame`).
   *
   * Set by `reveal()`, which `main.ts` calls inside the player's first key,
   * click or touch, and by the confirm block below on a GAMEPAD's press, which
   * the browser gives no activation for (so the sound may stay off until a
   * key or a click; DEV-557's row). It no longer gates the title's rows: they
   * are up as soon as the valley is (Matt, 2026-10-01: *"it's confusing that
   * the game can be fully functional, yet the curtain is still up"*).
   */
  let cardLifted = false
  /**
   * The last click on the canvas, CSS pixels. On the title the mouse is a
   * CURSOR until it is captured (DEV-418), and a cursor click aims a ray at the
   * title's rows from where it landed, the way a finger does (DEV-353).
   * `readClick` says THAT a click happened; this says where. Never read for a
   * click under pointer lock: there is no cursor then, the event's position is
   * frozen where the capture began, and the NOSE aims instead.
   */
  let titleClickAt: { readonly x: number; readonly y: number } | null = null
  canvas.addEventListener('click', (e) => {
    titleClickAt = document.pointerLockElement === canvas ? null : { x: e.clientX, y: e.clientY }
  })
  // ── DEV-572, the menus' reticle (APP-SPLIT 4.6, `boot/app/hangar/menu-reticle.ts`) ──
  const menuReticleHost = createMenuReticleHost({
    codeUp,
    get editorHost() {
      return editorHost
    },
    fade,
    get flight() {
      return handles.flight
    },
    glassRay,
    get hangar() {
      return hangar
    },
    letterPlate,
    get loadingScene() {
      return loadingScene
    },
    get lobbyPlate() {
      return roomLobby.lobbyPlate
    },
    get lobbyRows() {
      return roomLobby.lobbyRows
    },
    lobbyUp,
    mouseLook,
    pausePlate,
    get paused() {
      return pause.paused
    },
    render,
    get screen() {
      return router.screen
    },
    get titleMenu() {
      return handles.titleMenu
    },
    titleMenuUp,
    titleOptions: titleMenuHost.titleOptions,
    optionsUp: () => menus.options.up,
    titleRows,
    xrPointer,
  })
  const { menuReticleFrame } = menuReticleHost
  /**
   * A Quick Race between the title press and the stick in hand (DEV-353): the
   * course it picked, when the press landed, and whether its countdown has been
   * started. Null otherwise — including once the ship is released, which is
   * when the press-to-stick time is written to `data-quick-race-ms`.
   */
  let quickRace: { readonly id: string; readonly pressedAt: number; launched: boolean } | null =
    null
  /**
   * The level index a Quick Race picks from, fetched once. The same index the
   * level select is built on (`game/mission-index.ts`) — the pool is read off
   * the content, never listed (hard rule 6).
   */
  let quickRaceCards: Promise<MissionCard[]> | null = null
  /** Quick Race has been pressed. The title is a one-way door, so this never resets. */
  let quickRaceAsked = false
  /**
   * Show the loading scene once the rig is in the chair (DEV-353 follow-up).
   * Set at the black of Quick Race's one fade; spent by the menu branch of the
   * frame loop in that same frame, after it has parked the rig. See
   * `startQuickRace`.
   */
  let loadingScenePending = false
  // What a world's props do in flight (APP-SPLIT 4.7, `boot/app/world/props.ts`).
  const worldProps = createWorldProps({
    audio,
    craftSplashes,
    editionState,
    feel,
    get liveFracture() {
      return handles.liveFracture
    },
    get liveFx() {
      return handles.liveFx
    },
    get liveLineMask() {
      return handles.liveLineMask
    },
    set liveLineMask(v: LineMask | null) {
      handles.liveLineMask = v
    },
    get livePropColliders() {
      return handles.livePropColliders
    },
    get livePropsLive() {
      return handles.livePropsLive
    },
    get liveSea() {
      return handles.liveSea
    },
    mission,
    render,
  })
  const {
    applyPropVisibility,
    applyCourseClearing,
    _splashEye,
    breakProps,
    splashCraft,
    _nearAt,
    _nearEye,
    _nearRight,
  } = worldProps

  // The title screen's world (APP-SPLIT 4.5, `boot/app/title/world.ts`).
  const titleWorld = createTitleWorld({
    bloom,
    capabilities,
    editionState,
    farShadow,
    get firstWorldSettled() {
      return firstWorldSettled
    },
    set firstWorldSettled(v: boolean) {
      firstWorldSettled = v
    },
    get liveTitleGlows() {
      return handles.liveTitleGlows
    },
    get liveTitleJets() {
      return handles.liveTitleJets
    },
    set liveTitleJets(v: readonly THREE.Object3D[]) {
      handles.liveTitleJets = v
    },
    get liveTitleTrails() {
      return handles.liveTitleTrails
    },
    set liveTitleTrails(v: TitleTrails | null) {
      handles.liveTitleTrails = v
    },
    get liveTitleValley() {
      return handles.liveTitleValley
    },
    set liveTitleValley(v: LoadedTerrain | null) {
      handles.liveTitleValley = v
    },
    loading,
    maybeReveal,
    get quickRaceCards() {
      return quickRaceCards
    },
    set quickRaceCards(v: Promise<MissionCard[]> | null) {
      quickRaceCards = v
    },
    render,
    skyVisibility,
    splash,
    sunShadows,
    get title() {
      return handles.title
    },
    set title(v: Title | null) {
      handles.title = v
    },
    get titleAim() {
      return titleAim
    },
    get titleCurtain() {
      return handles.titleCurtain
    },
    set titleCurtain(v: TitleCurtain | null) {
      handles.titleCurtain = v
    },
    get titleFog() {
      return handles.titleFog
    },
    set titleFog(v: UnityFog | null) {
      handles.titleFog = v
    },
    get titleMenu() {
      return handles.titleMenu
    },
    set titleMenu(v: Pause | null) {
      handles.titleMenu = v
    },
    get titleProbe() {
      return handles.titleProbe
    },
    set titleProbe(v: THREE.LightProbe | null) {
      handles.titleProbe = v
    },
    titleRows,
    get titleSky() {
      return handles.titleSky
    },
    set titleSky(v: Sky | null) {
      handles.titleSky = v
    },
    get titleValleyPropsDispose() {
      return handles.titleValleyPropsDispose
    },
    set titleValleyPropsDispose(v: (() => void) | null) {
      handles.titleValleyPropsDispose = v
    },
    warp,
  })
  const { buildTitleWorld } = titleWorld

  // The mission world, built (APP-SPLIT 4.7, `boot/app/world/build.ts`).
  const worldBuild = createWorldBuild({
    HANGAR_SEED,
    get RUNNING_MODE() {
      return RUNNING_MODE
    },
    _splashEye,
    appSettings,
    applyAtmosphere,
    applyCourseClearing,
    applyGroundAtmosphere,
    applyPropAtmosphere,
    applyPropVisibility,
    applyWireframe,
    atmosphere,
    bakedLight,
    bloom,
    get buildLesson() {
      return buildLesson
    },
    capabilities,
    chosenGhost,
    cloudShadow,
    cockpitNow,
    cockpitSelfShadow,
    craftSplashes,
    editionState,
    editionsLoaded,
    farShadow,
    flatFov,
    get fog() {
      return fog
    },
    handles,
    hudPlacementNow,
    get hudRaster() {
      return hudRaster
    },
    get landRevealRise() {
      return landRevealRise
    },
    set landRevealRise(v: number) {
      landRevealRise = v
    },
    get level() {
      return level
    },
    loading,
    lodFadeSpec,
    mission,
    perfPlate,
    placementTuning,
    refreshBakedLight,
    render,
    resetThirdPerson,
    results,
    ringBurstRandomNow,
    roomActive,
    roomBotHost,
    roomBots,
    roomCore,
    roomOccupiedStarts,
    roomWorldBuilt,
    sceneTint,
    seaReflection,
    get setChunkBatch() {
      return setChunkBatch
    },
    shakeLookdev,
    skyVisibility,
    speedLineLiftNow,
    speedLinesNow,
    speedRampNow,
    sunHalo,
    sunShadows,
    surfaceGloss,
    syncRaceMap,
    vignette,
    warp,
  })
  const { buildWorld } = worldBuild

  type World = Awaited<ReturnType<typeof buildWorld>>
  /**
   * The MISSION world — the island, the sea, the course and the ship — or
   * **null while nobody has chosen a course**. DEV-281.
   *
   * It was `Promise<World> = buildWorld()`, unconditionally, at boot. That is
   * the line Matt's *"it shouldn't be loading the islands in the first place"*
   * is about: a visitor standing on the title screen was waiting on a 4,096 m
   * Simonet they had not asked for, under a progress line naming it.
   *
   * `null` is a state this file already knew how to be in — it is what
   * `teardownWorld` leaves behind between two courses, and `flight`, `liveRings`
   * and the rest are all nullable for the same window — so what is new is only
   * that the window now opens at boot instead of at the first swap.
   */
  let world: Promise<World> | null = null
  const watchWorld = (p: Promise<unknown>) => {
    p.catch((err: unknown) => {
      const message = String((err as Error)?.message ?? err)
      document.body.dataset.terrainError = message
      // The readout has to end somewhere. A bar that counts to 43% and stops is
      // worse than no bar, and the button it gates would never enable.
      loading.failed(message)
      console.error('world failed to load', err)
    })
  }
  /**
   * WHICH world boot builds, and it is decided by the screen boot lands on.
   *
   * - `title` — the default, and what a visitor gets. The valley, the logo and
   *   the flypast, and **no island**: the first course selection builds that.
   * - `menu` (`?title=0`) and `mission` (`?menu=0`, `?view=`, `?autopilot=1`) —
   *   the mission world, exactly as before. Neither screen draws the title
   *   valley (the level select is `menuScene`, a scene of its own), so building
   *   it for them would be the same waste in the other direction.
   *
   * There is no route back to `'title'` from either of the others, which is
   * what makes this a boot-time decision rather than a thing to keep in step.
   *
   * - `none` (DEV-471, `?edit=1`): neither. The stage at boot is the loading
   *   scene, which needs no world, and the island is built behind it by the
   *   editor's block (`switchMission`, MAKE A COURSE's door). So nothing here
   *   holds the curtain: the plate is what there is to see.
   */
  const bootWorld: 'title' | 'mission' | 'none' =
    router.screen === 'title' ? 'title' : EDIT_AT_BOOT ? 'none' : 'mission'
  document.body.dataset.bootWorld = bootWorld
  if (bootWorld === 'mission') world = buildWorld()
  const booted: Promise<unknown> =
    world ?? (bootWorld === 'none' ? Promise.resolve() : buildTitleWorld())
  watchWorld(booted)
  /**
   * L4's release, and it fires on REJECTION too — deliberately.
   *
   * A world that failed to load must not leave the screen black for ever. The
   * loud-failure path is `MissingAssetBaseUrlError` reaching the landing card,
   * which is the thing that diagnosed the 2026-09-09 headset session; a fade
   * that never lifts would replace a legible error with a dark room. So this
   * settles either way and `data-terrain-error` carries the reason.
   *
   * ── It waits on the world you are LOOKING AT, and that is DEV-280's grave ──
   *
   * DEV-280 released the curtain when the title valley's TERRAIN resolved, and
   * was reverted because at that instant the mission scene was the one being
   * drawn: *"i see 2 different levels visibly load in one after the other."*
   * The premise it needed — *the world on screen at boot is the title valley* —
   * was false while boot built both. It is true now, because boot builds one:
   * the stage the curtain lifts on is the stage that was built, whichever it
   * was, and there is no second world to arrive after it.
   */
  void booted.then(
    () => {
      firstWorldSettled = true
      maybeReveal()
    },
    () => {
      firstWorldSettled = true
      maybeReveal()
    },
  )

  /**
   * DEV-193's spike: fold the live terrains' chunk grids into one
   * `THREE.BatchedMesh` per LOD band, or unfold them.
   *
   * Idempotent in both directions, and it returns the PLAN rather than a
   * verdict — bands, members, slots, reserved bytes, and how many chunks it
   * refused. A caller that wants the draw-call answer reads
   * `renderer.info.render.calls` and `__ff2.census()` around it; this function
   * has no business deciding whether the number is good.
   *
   * Both terrains, because the sea is 4 draws and the island is ~146 and a
   * function that folded only one would be answering a question nobody asked.
   * The ocean's per-LOD water materials (DEV-183) mean its bands separate by
   * material as well as by size, which the batch key already handles.
   */
  const setChunkBatch = (on: boolean): unknown => {
    if (!on) {
      for (const entry of liveChunkBatches) entry.set.restore()
      liveChunkBatches = []
      return { on: false, terrains: [] }
    }
    if (liveChunkBatches.length > 0) return chunkBatchReport()
    const targets: [string, LoadedTerrain][] = []
    if (handles.liveTerrain) targets.push(['land', handles.liveTerrain.terrain])
    if (handles.liveTerrain?.ocean) targets.push(['ocean', handles.liveTerrain.ocean])
    for (const [key, terrain] of targets) {
      // No headroom. A slot nobody can fill is a byte nobody can spend, and the
      // spike's job is to report what the CURRENT frame needs — what to reserve
      // for the churn is a budgeting decision the measurement should inform
      // rather than pre-empt.
      const set = buildChunkBatches(terrain.group)
      if (set) liveChunkBatches.push({ key, set })
    }
    return chunkBatchReport()
  }

  /** What `setChunkBatch` folded, as rows a spec can print. */
  const chunkBatchReport = (): unknown => ({
    on: liveChunkBatches.length > 0,
    terrains: liveChunkBatches.map(({ key, set }) => ({
      terrain: key,
      folded: set.folded,
      skipped: set.skipped,
      bytes: set.bytes,
      bands: set.bands.map((b) => ({
        key: b.key,
        vertexCount: b.vertexCount,
        triangles: (b.vertexCount / 3) * b.members,
        members: b.members,
        slots: b.slots,
        bytes: b.bytes,
        castShadow: b.castShadow,
        receiveShadow: b.receiveShadow,
      })),
    })),
  })

  /**
   * Take the mission world apart: every disposer we own, then everything the
   * build added to the scene.
   *
   * The removal is by SUBTRACTION — anything in `render.scene` that was not
   * there before the first light went in. A list of things to remove is a list
   * that rots, and the thing somebody adds next is exactly the thing that would
   * survive a swap and haunt the following mission.
   *
   * Disposal is by name, though, and deliberately not a blind
   * traverse-and-dispose: the menu world holds meshes of its own and a shared
   * geometry freed here is a black hole in the room you are still sitting in.
   */
  const teardownWorld = async (): Promise<void> => {
    // `world` is null until a course has been chosen (DEV-281), so this is the
    // first swap's shape as much as a failed load's: there is nothing to await
    // and nothing to dispose by handle, and everything below still runs — the
    // TITLE world is what it is taking apart in that case.
    const built = world === null ? null : await world.catch(() => null)
    world = null
    // DEV-193's spike, BEFORE the terrain's own disposer: `LoadedTerrain
    // .dispose` walks `group.children` and frees the geometry of anything
    // `isMesh`, and a `BatchedMesh` is one. Unfolding first means the batches
    // are gone before that walk reaches them, and the chunk meshes it is about
    // to dispose are the ones it made rather than ones this spike had hidden.
    for (const entry of liveChunkBatches) entry.set.restore()
    liveChunkBatches = []
    // Handles first. Each of these owns GPU memory and several own a worker.
    built?.terrain.dispose()
    built?.ocean?.dispose()
    built?.rings.dispose()
    built?.turnIndicators.dispose()
    built?.particleFx.dispose()
    built?.ghosts?.dispose()
    // APP-SPLIT 3.1: every world handle, through the disposer beside its name,
    // in the order this function used to spell them, side effects and all;
    // then every field back to empty (`boot/app/world-handles.ts`). The table is
    // typed against the record, so a handle a build adds cannot be left out.
    disposeWorldHandles(handles, {
      // DEV-371: the player's ghost and its laps are the world's, like the racers.
      livePlayerGhost: (livePlayerGhost) => {
        livePlayerGhost?.dispose()
        roomWorldTorn() // DEV-388
      },
      lapRun: resetOnly,
      liveTitleValley: (liveTitleValley) => liveTitleValley?.dispose(),
      livePropsDispose: (livePropsDispose) => livePropsDispose?.(),
      // The forest is a CHILD of the title valley, and `LoadedTerrain.dispose`
      // deliberately does not reach into children it did not make. DEV-155.
      titleValleyPropsDispose: (titleValleyPropsDispose) => titleValleyPropsDispose?.(),
      // The valley's air goes with the valley. The probe is a scene light and
      // `buildWorld` adds a fresh one, so leaving this would stack a second
      // ambient on every course swap — and `getObjectByName` would then find the
      // wrong one. DEV-155.
      titleProbe: (titleProbe) => {
        if (titleProbe) render.scene.remove(titleProbe)
      },
      titleSky: (titleSky) => {
        if (titleSky) {
          render.scene.remove(titleSky.dome)
          // `scene.environment` may still be pointing at the texture this disposes.
          // Cleared rather than handed back to `liveSky`, which is disposed a few
          // lines below: `applySky` sets it again when the world rebuilds, and a
          // null environment for those frames costs a little specular where a
          // released texture costs a GL error.
          if (render.scene.environment === titleSky.environment) render.scene.environment = null
          titleSky.dispose()
        }
      },
      titleFog: resetOnly,
      missionProbeGain: resetOnly,
      // DEV-136: the colliders and the pieces go with the props they belonged to.
      liveFracture: (liveFracture) => liveFracture?.dispose(),
      livePropColliders: resetOnly,
      livePropCollision: resetOnly,
      livePropsLive: resetOnly,
      liveLineMask: resetOnly, // DEV-502
      worldClearingInput: resetOnly,
      flight: (flight) => flight?.dispose?.(),
      liveOrbArt: (liveOrbArt) => liveOrbArt?.dispose(),
      livePadArt: (livePadArt) => livePadArt?.dispose(),
      liveClouds: (liveClouds) => {
        liveClouds?.dispose()
        cloudShadow.setClouds(null, null) // DEV-585
      },
      liveHorizonGeo: (liveHorizonGeo) => liveHorizonGeo?.dispose(),
      liveSky: (liveSky) => liveSky?.dispose(),
      liveRacers: (liveRacers) => liveRacers?.dispose(),
      liveTraffic: (liveTraffic) => {
        liveTraffic?.dispose()
        disposeLesson()
      },
      liveFx: (liveFx) => liveFx?.dispose(),
      // The Anniversary dressing (DEV-089) hangs under the terrain group, so the
      // group goes with the terrain above — but its geometries and materials are
      // its own, and a mission switch that left them behind would leak a boulder
      // field per course. Built per level in `buildWorld`, released here.
      liveDressing: (liveDressing) => liveDressing?.dispose(),
      // DEV-447: the boats are at the scene ROOT, so nothing else takes them out.
      liveLife: (liveLife) => liveLife?.dispose(),
      liveLookdev: (liveLookdev) => liveLookdev?.dispose(),
      startGrid: (startGrid) => startGrid?.dispose(),
      elevator: (elevator) => elevator?.dispose(),
      launchRoom: (launchRoom) => launchRoom?.dispose(),
      // Which frees the flypast's two ships with it: they are its children
      // (DEV-281), and `Title.dispose` traverses.
      title: (title) => title?.dispose(),
      liveTitleJets: resetOnly,
      liveTitleTrails: (liveTitleTrails) => liveTitleTrails?.dispose(),
      liveTitleGlows: (liveTitleGlows) => {
        for (const g of liveTitleGlows) g.dispose()
      },
      // A title left before its valley landed still has its curtain (DEV-352);
      // the sweep below takes it out of the scene, and this frees it.
      titleCurtain: (titleCurtain) => {
        titleCurtain?.dispose()
        delete document.body.dataset.titleCurtain
      },
      // The title's rows hang under the RIG, which survives every teardown, so
      // the sweep below would not find them (DEV-353).
      titleMenu: (titleMenu) => {
        titleMenu?.object.removeFromParent()
        titleMenu?.dispose()
      },
      liveLaunchLook: resetOnly,
      liveSea: resetOnly,
      liveRings: resetOnly,
      liveStudHalos: resetOnly,
      liveTerrain: resetOnly,
      liftSeal: resetOnly,
      // With the elevator, because it is a list of the PREVIOUS world's chunk
      // meshes and every one of them is about to be disposed. A mission with no
      // rig never refills it, so leaving it would hold the last island's meshes
      // reachable for the session — the exact leak the lines around this one
      // exist to close.
      boreChunks: resetOnly,
      boreChunkNames: resetOnly,
      liveGhosts: resetOnly,
      missionSun: resetOnly,
      autopilotTerrain: resetOnly,
      collisionTerrain: resetOnly,
    })
    // (DEV-558: the letter plate is the hangar's now, in the menu scene, and
    // outlives a world as the room does.)
    for (const child of [...render.scene.children]) {
      if (!shellChildren.has(child)) render.scene.remove(child)
    }
    craftSplashes.clear()
    seaReflection.setSea(null) // DEV-583
    // DEV-232: drop the torn-down world's root and material. The bake's own
    // `offered` set is a WeakSet and needs no clearing, but the roots and
    // materials are strong, and a mission swap would otherwise leave the
    // previous island's group and material reachable for the session.
    bakedLight.reset()
    farShadow.setWorld(null, null)
    skyVisibility.setWorld(null, null, null, null)
    delete document.body.dataset.titleReady
    delete document.body.dataset.terrainReady
    delete document.body.dataset.terrainError
  }

  // -- the launch sequence ------------------------------------------------
  //
  // The mission does not start when the world loads. It starts when the player
  // presses A: the elevator rides 106.6 m out of the shaft over 15.5 s, holds
  // for a 3-2-1-GO, and only then is the ship let go.
  //
  // The mission clock and the ghosts are both gated on that release. They have
  // to be: the ghosts are recordings that BEGIN at the moment 2016 let go, so
  // running them during the ride hands them a twenty-second lead the player
  // never sees, and running the clock during it spends an entire medal tier of
  // a 180 s limit on an animation.
  // ── the boundary ────────────────────────────────────────────────────────
  //
  // A sphere you have to stay inside — 2918.7 m on this mission — with a 13 s
  // clock that starts when you LEAVE it, having been in it, and cancels when you
  // come back. DISABLED in 6 of the 13 shipped missions, so there is no fallback
  // here: if the level says no boundary, there is no boundary.
  let boundary = createBoundary()
  // Functions rather than expressions, because a mission swap has to produce
  // them again for the next level and an initialiser cannot be called twice.
  // APP-SPLIT 2.2: each is a function of the level in `game/course-specs.ts`.
  const makeBoundarySpec = (): BoundarySpec | null => boundarySpecOf(level)
  let boundarySpec: BoundarySpec | null = makeBoundarySpec()

  const makeLaunchSpec = (): LaunchSpec | null => launchSpecOf(level, SKIP_RIDE)
  let launchSpec: LaunchSpec | null = makeLaunchSpec()
  // ── The authored racing line ────────────────────────────────────────────
  //
  // `CurvyClonePath` — the Curvy spline 2016 built the course around and cloned
  // the rings along. 421 points over 11.3 km, every gate on it (mean 8.4 m, max
  // 24.6 against a 22.6 m trigger radius), and it never enters the terrain.
  //
  // Built here rather than inside the racers so the player proxy has it too,
  // including under `?opponents=ghosts` where there are no racers to own it.
  const makeGuide = (sheet: HoverJetSheet | undefined = handles.flight?.jet.sheet) =>
    guideFor(GUIDE_SPLINE ? (level.route ?? null) : null, mission, sheet, SHIP_LAT_ACCEL)
  /** `profileGuide` (`game/course-specs.ts`) for this game's measured lateral limit. */
  const profileGuideFor = (
    guideNow: { readonly route: Route; profiledFor: HoverJetSheet | null },
    sheet: HoverJetSheet | undefined,
  ): void => profileGuide(guideNow, sheet, SHIP_LAT_ACCEL)
  let guide = makeGuide()
  // ── The course a CRASH puts you back on (DEV-126) ──────────────────────
  //
  // The authored line when the mission has one — the same `Route` the guide
  // follows, so the player and the racers are reset onto one line — and the
  // polyline through the gate centres from the release point when it does
  // not. `gateArc` bounds the reset search at the gate still owed, so a course
  // that folds back on itself (int_01 does, twice) cannot put you nine gates
  // ahead of where you hit. Every HoverJet mission ships a `route`; the
  // fallback is for a course that does not, and for `?guide=off`.
  const makeCrashLine = (): { route: Route; gateArc: readonly number[] } =>
    crashLineOf(guide, level, mission.course.gates)
  let crashLine = makeCrashLine()
  /** Volatile: the course handed to the crash rule each tick. Never kept. */
  const crashCourse: { route: Route; limitS: number } = { route: crashLine.route, limitS: 0 }
  const crashCourseNow = (): CrashCourse => {
    crashCourse.route = crashLine.route
    // PROGRESS, not the first hole. A ring you missed is not a ring you are
    // behind, and treating it as one pinned every later reset at the start
    // line (DEV-289). `crashLimitS` is the one place that rule is written.
    crashCourse.limitS = crashLimitS(
      crashLine.gateArc,
      mission.course.passed,
      crashLine.route.length,
    )
    return crashCourse
  }
  /**
   * Change course without leaving the page.
   *
   * ── Why this exists ────────────────────────────────────────────────────
   *
   * Picking a course in another world used to set `?mission=` and reload the
   * document. 2016 does the same thing — `Application.LoadLevelAsync` — but 2016
   * has no browser in front of it, and in one a reload:
   *
   *   * puts `index.html`'s gesture card back over a game that has already
   *     booted, which is what Matt hit first (DEV-075);
   *   * drops the `AudioContext`, so the next world starts silent;
   *   * **ends the immersive session**, and `requestSession` needs a user
   *     gesture in the new document — so in a headset, changing course threw you
   *     out of VR and left you looking at a web page.
   *
   * None of that is fixable from inside a reload. So there is no reload.
   *
   * ── Why it is safe to do here and was not before ───────────────────────
   *
   * Because the menu is its own scene (DEV-076). The player is sitting in a room
   * that is not part of what is being destroyed, so the swap has nothing to
   * preserve and nothing to hide behind: the room stays up, the world goes away
   * under it, and the next one arrives.
   *
   * ── The order, which matters ───────────────────────────────────────────
   *
   * The LEVEL loads first, before anything is torn down. It is a JSON fetch and
   * it can fail; failing before the teardown leaves the player where they were,
   * with the world they had. After the teardown there is no way back, which is
   * why the build's own failure is reported loudly rather than swallowed.
   */
  let switching = false
  // ══ DEV-355: WHERE YOU STAND WHILE A COURSE LOADS ═══════════════════════
  //
  // Matt: *"add a vr-comfy loading screen — the app currently freezes."* The
  // freeze was the build holding the thread (DEVIATIONS DEV-355 §1: 3.4 s in
  // one task); `boot/slice.ts` is what keeps the frames coming now. This is
  // what those frames show: `render/loading-scene.ts`, a dim faceted horizon
  // and a plate naming the course, stood up where your head is at the moment
  // the room fades out and WORLD-locked from then on.
  //
  // It lives in the menu's scene with the room hidden, so the stage, the rig,
  // the fade, the seat look and the XR pointer all carry on as they do in the
  // room — nothing in the frame loop learned a new screen. The press fades the
  // room out (`goToScreen('menu', …)` is a fade with an action and no change
  // of screen), the scene comes up behind the black, and the build runs under
  // it; the fade into the cockpit takes it down again.
  // DEV-451: the scene is a menu, and wears the MENUS' tone curve drawn into
  // its colours, because the mission's edition (and so its renderer curve) is
  // already on while it is shown: the world builds under it behind this scene.
  const menuRender = (await presetFor(MENU_EDITION)).render
  // The scene and its plate: `boot/app/world/loading.ts` (APP-SPLIT 4.7).
  const loadingHost = createLoadingHost({
    get hangar() {
      return hangar
    },
    loading,
    menuRender,
    menuScene,
    get pendingScreen() {
      return router.pendingScreen
    },
    render,
    get switching() {
      return switching
    },
  })
  const { loadingScene, beginLoadingTarget, showLoadingScene, screenSettled, hideLoadingScene } =
    loadingHost

  // Change course without leaving the page (APP-SPLIT 4.7, `boot/app/world/switch.ts`).
  const worldSwitch = createWorldSwitch({
    MODE_REQUEST,
    get RUNNING_MODE() {
      return RUNNING_MODE
    },
    set RUNNING_MODE(v: GameMode) {
      RUNNING_MODE = v
    },
    beginLoadingTarget,
    boardLinkGhost,
    get boundary() {
      return boundary
    },
    set boundary(v: BoundaryState) {
      boundary = v
    },
    get boundarySpec() {
      return boundarySpec
    },
    set boundarySpec(v: BoundarySpec | null) {
      boundarySpec = v
    },
    buildWorld,
    get crash() {
      return run.crash
    },
    set crash(v: CrashState) {
      run.crash = v
    },
    get crashCurtain() {
      return run.crashCurtain
    },
    set crashCurtain(v: boolean) {
      run.crashCurtain = v
    },
    get crashLine() {
      return crashLine
    },
    set crashLine(v: { route: Route; gateArc: readonly number[] }) {
      crashLine = v
    },
    editionState,
    get editionWorn() {
      return appSettings.editionWorn
    },
    fade,
    get fog() {
      return fog
    },
    set fog(v: UnityFog) {
      fog = v
    },
    goToScreen,
    get guide() {
      return guide
    },
    set guide(v: RacingGuide | null) {
      guide = v
    },
    get hangar() {
      return hangar
    },
    hideLoadingScene,
    get launch() {
      return launch
    },
    set launch(v: LaunchState) {
      launch = v
    },
    get launchSpec() {
      return launchSpec
    },
    set launchSpec(v: LaunchSpec | null) {
      launchSpec = v
    },
    get level() {
      return level
    },
    set level(v: Level) {
      level = v
    },
    get liveSky() {
      return handles.liveSky
    },
    set liveSky(v: Sky | null) {
      handles.liveSky = v
    },
    loadingHost,
    get loadingScenePending() {
      return loadingScenePending
    },
    set loadingScenePending(v: boolean) {
      loadingScenePending = v
    },
    makeBoundarySpec,
    makeCrashLine,
    makeGuide,
    makeLaunchSpec,
    mission,
    missionEdition,
    get missionSun() {
      return handles.missionSun
    },
    set missionSun(v: ReturnType<typeof applyLighting>) {
      handles.missionSun = v
    },
    pageSun,
    get pendingScreen() {
      return router.pendingScreen
    },
    get quickRace() {
      return quickRace
    },
    set quickRace(v: {
      readonly id: string
      readonly pressedAt: number
      launched: boolean
    } | null) {
      quickRace = v
    },
    get quickRaceAsked() {
      return quickRaceAsked
    },
    set quickRaceAsked(v: boolean) {
      quickRaceAsked = v
    },
    get quickRaceCards() {
      return quickRaceCards
    },
    set quickRaceCards(v: Promise<MissionCard[]> | null) {
      quickRaceCards = v
    },
    render,
    restartRun,
    results,
    get rideSpec() {
      return rideSpec
    },
    set rideSpec(v: LaunchSpec | null) {
      rideSpec = v
    },
    get screen() {
      return router.screen
    },
    screenSettled,
    showLoadingScene,
    get switching() {
      return switching
    },
    set switching(v: boolean) {
      switching = v
    },
    teardownWorld,
    watchWorld,
    wearEdition,
    wiredMissionFog,
    get world() {
      return world
    },
    set world(v: Promise<World> | null) {
      world = v
    },
    yourCourses,
  })
  const { switchMission, startQuickRace } = worldSwitch

  // DEV-483 and DEV-482, TV's exhibition and panel (APP-SPLIT, `boot/app/tv/panel.ts`).
  const tvPanelHost = createTvPanelHost({
    get RUNNING_MODE() {
      return RUNNING_MODE
    },
    audio,
    breakProps,
    capabilities,
    editionState,
    get fog() {
      return fog
    },
    handles,
    get level() {
      return level
    },
    get quickRaceCards() {
      return quickRaceCards
    },
    set quickRaceCards(v: Promise<MissionCard[]> | null) {
      quickRaceCards = v
    },
    render,
    router,
    switchMission,
    get switching() {
      return switching
    },
    tvActive,
    tvView,
    tvWatch,
    get world() {
      return world
    },
  })
  const {
    exhibition,
    tvPanelCourse,
    tvPanelInput,
    exhibitionTick,
    tvPanelFrame,
    tvPanel,
    tvControls,
  } = tvPanelHost

  // ── The course editor's host (APP-SPLIT 4.2, `boot/app/editor-host.ts`) ──
  //
  // DEV-469's desk host, DEV-471's `?edit=1` arrival, DEV-476's light,
  // DEV-491's recording flight, DEV-492's bench, and MAKE A COURSE. Built
  // here, where the block stood, so its boot-time statements run in order.
  const editorHost = createEditorHost({
    _aimDirection,
    _aimOrigin,
    applyCourseClearing,
    audio,
    beginLoadingTarget,
    bloom,
    canvas,
    cloudShadow,
    get comfort() {
      return appSettings.comfort
    },
    courseLibrary,
    editionState,
    editorOn,
    farShadow,
    get flight() {
      return handles.flight
    },
    get fog() {
      return fog
    },
    goToScreen,
    groundOfCourse,
    get hangar() {
      return hangar
    },
    horizon,
    keepCourse,
    keepMap,
    get keyboard() {
      return keyboard
    },
    get lastResult() {
      return run.lastResult
    },
    get level() {
      return level
    },
    get liveClouds() {
      return handles.liveClouds
    },
    get liveDressing() {
      return handles.liveDressing
    },
    get liveGhosts() {
      return handles.liveGhosts
    },
    get liveHorizonGeo() {
      return handles.liveHorizonGeo
    },
    get livePlayerGhost() {
      return handles.livePlayerGhost
    },
    get livePropColliders() {
      return handles.livePropColliders
    },
    get livePropsLive() {
      return handles.livePropsLive
    },
    get liveRacers() {
      return handles.liveRacers
    },
    get liveRings() {
      return handles.liveRings
    },
    get liveSky() {
      return handles.liveSky
    },
    get liveTerrain() {
      return handles.liveTerrain
    },
    loading,
    loadingScene,
    get loadingScenePending() {
      return loadingScenePending
    },
    set loadingScenePending(v: boolean) {
      loadingScenePending = v
    },
    lobbyUp,
    get menuEdition() {
      return roomCore.menuEdition
    },
    menuEditionLoad,
    mission,
    get missionSun() {
      return handles.missionSun
    },
    mouseLook,
    get paused() {
      return pause.paused
    },
    set paused(v: boolean) {
      pause.paused = v
    },
    get pendingScreen() {
      return router.pendingScreen
    },
    playerCourses,
    render,
    restartRun,
    roomClose,
    saveCourseFile,
    sceneTint,
    get screen() {
      return router.screen
    },
    seaReflection,
    skyVisibility,
    get startGrid() {
      return handles.startGrid
    },
    get sunBakeInputs() {
      return atmosphere.sunBakeInputs
    },
    sunShadows,
    switchMission,
    get switching() {
      return switching
    },
    touch,
    vignette,
    get world() {
      return world
    },
    get worldClearingInput() {
      return handles.worldClearingInput
    },
    xrPointer,
  })
  const {
    makeCourse,
    editorFrame,
    editorRecordInput,
    editorRecordBadge,
    benchPress,
    editorRecordReturn,
    editorReturn,
    editorRecordPlaced,
    editorRecordStep,
    benchFrame,
    benchDoorAim,
    courseTintFor,
    onEditorBoot,
  } = editorHost

  // ── DEV-604: a click or a tap on a table chooses it ───────────────────────
  //
  // The 2026-10-03 persona playtest: a web player moved the mouse over a table
  // and clicked it, and nothing happened unless it was the one under the
  // screen's centre; a phone player tapped a table and nothing happened. The
  // hangar is aimed by the head (the gaze) or a hand (the laser); this adds the
  // POINT on the glass as a third aimer, for one press: the free cursor's
  // click (`setCursorTarget`, the title's model, DEV-418) and a finger's tap
  // (`taps` in the touch context). It aims the room through the point exactly
  // as the laser aims it through a hand (`hangar.gaze`), and the press is then
  // the room's own `choose()`, as A's is. Nothing else changes: the look, the
  // A/D seat turn and the head's aim are as they were, and a click with nothing
  // under it is still the capture.
  /** The room takes a point on the glass now: flat, the steps up, nothing over them. */
  const roomTakesPoints = (): boolean =>
    router.screen === 'menu' &&
    hangar !== null &&
    hangar.focused === null &&
    !render.renderer.xr.isPresenting &&
    !pause.paused &&
    !lobbyUp() &&
    !codeUp() &&
    !editorHost.benchUp &&
    !editorHost.editing &&
    !loadingScene.shown &&
    !tvActive()
  /** Aim the room through a point on the glass, CSS pixels. True if it aims at anything. */
  const roomPointAim = (x: number, y: number): boolean => {
    if (!roomTakesPoints() || hangar === null) return false
    const ray = glassRay(x, y)
    if (ray === null) return false
    hangar.gaze(ray.origin, ray.direction)
    return hangar.aim !== null
  }
  mouseLook.setCursorTarget((x, y) => roomPointAim(x, y), 'room')

  const autoCursor = createRouteCursor()
  const autoAim = { x: 0, y: 0, z: 0 }
  // A second point further along the line: what corner braking measures against.
  const autoBeyond = { x: 0, y: 0, z: 0 }

  /**
   * Flipped to `skipRide` after the first launch, so a retry starts at the top.
   *
   * A `let` rather than a mutation because `LaunchSpec` is readonly and should
   * stay that way — `startLaunch`, `stepLaunch` and `resetLaunch` all read
   * whichever object this currently names, so one reassignment moves all three.
   */
  let rideSpec: LaunchSpec | null = launchSpec
  let launch = createLaunch(launchSpec)
  // A mission with no elevator is flying from the first tick.
  if (!launchSpec) launch.phase = 'flying'

  /**
   * Press A: start the launch, and spend the ride if this is the press that used
   * it.
   *
   * ── What this replaces, and why nothing has ridden the lift since ────────
   *
   * The spend used to be a line in `frame` with no condition on it at all:
   *
   *     if (autopilot && flight) startLaunch(launch, rideSpec)
   *     // Spent. The ride is an establishing shot, not a toll on every retry.
   *     if (rideSpec) rideSpec = { ...rideSpec, skipRide: true }
   *
   * — and a second copy after the confirm block. Both ran on EVERY frame, so
   * `rideSpec.skipRide` was true from the first one, before any press, and
   * `startLaunch` reads it at press time. So every launch on every path took the
   * skip branch: `?ride=0` and the default were the same game, and the 106 m
   * climb the spawn marker exists for had not been seen since the switch landed.
   * Measured on `rookie_01_hoverJet`: the body sat at 112.037 — spawn 5.39 plus
   * the full 106.647 rise — from the first frame to the release, never once at
   * the bottom. `tests/e2e/briefing.spec.ts` had already written it down in
   * prose: *"the elevator is skipped"*.
   *
   * Spending it HERE, and only when the launch actually left `waiting`, is what
   * the comment always claimed: the first launch of a world build rides, and
   * every retry after it starts at the top — *an establishing shot, not a toll on
   * every retry*. `switchMission` hands `rideSpec` a fresh spec, so the next
   * course rides too, once. `?ride=0` sets `skipRide` in the spec itself and is
   * untouched by any of this. DEV-094.
   *
   * The guard mirrors `startLaunch`'s own, which is idempotent for `Input_Ship`'s
   * reason (`gameReady`, `Input_Ship.cs:382`): the button is held down across
   * many frames and the clip must not restart on each of them.
   */
  const beginLaunch = (): void => {
    if (launch.phase !== 'waiting') return
    // DEV-388: in a room the ROOM starts the countdown (§6.3), not a press.
    if (roomActive()) return
    startLaunch(launch, rideSpec)
    if (rideSpec) rideSpec = { ...rideSpec, skipRide: true }
  }

  /** The confirm press's edge: held by the splash, stepped once a frame, before its handler. */
  const confirmKey = createEdge()
  /** DEV-371: "race this lap" is edge-detected like every other press. */
  const raceLapKey = createEdge()
  // APP-SPLIT 3.5: who is flying, ONE record (`boot/app/autopilot-state.ts`).
  const pilot: AutopilotState = {
    autopilot: AUTOPILOT_AT_BOOT,
    autopilotHold: NO_HOLD,
  }
  const autopilotKey = createEdge()
  const autoInput = noActions()

  /**
   * What the panel says before the run starts.
   *
   * `null` once the ship is flying, which is what puts the instrument rows back.
   */
  /**
   * 2016's own briefing copy, off `PlayerShip_SR14_Photon.prefab:9820`.
   *
   * Hand-carried from the prefab, like the launch banner's two strings below
   * and every other UI string in `src/render`. It belongs in the level JSON —
   * rule 6, content is data — and will move there once the extractor learns to
   * read `UnityEngine.UI.Text.m_Text`. See the note in `render/briefing.ts`.
   */
  // The briefing and the pad's prompts (APP-SPLIT 4.8, `boot/app/flight/briefing.ts`).
  const briefing = createBriefing({
    get RUNNING_MODE() {
      return RUNNING_MODE
    },
    get boundary() {
      return boundary
    },
    get boundarySpec() {
      return boundarySpec
    },
    get confirmDevice() {
      return confirmDevice
    },
    editionState,
    get flight() {
      return handles.flight
    },
    lapAskUp,
    get lapRun() {
      return handles.lapRun
    },
    get lastResult() {
      return run.lastResult
    },
    get launch() {
      return launch
    },
    get launchSpec() {
      return launchSpec
    },
    get level() {
      return level
    },
    get paused() {
      return pause.paused
    },
    roomActive,
    roomWaitingLine,
    get screen() {
      return router.screen
    },
    tvActive,
  })
  const {
    confirmNow,
    glassConfirms,
    raceLapOffered,
    briefingLevel,
    briefingState,
    launchBanner,
    touchConfirmLabel,
    touchRaceLabel,
  } = briefing

  /**
   * Sound the launch beats, from the STATE rather than from a call site.
   *
   * `startLaunch` is not the only thing that moves the phase — `?ride=0`, the
   * autopilot and `resetLaunch` all do — so a cue hung off the button press
   * would be right on one route and silent on three. Reading the transition
   * here means every route that reaches a phase gets its beat exactly once.
   *
   * The countdown is 2016's, not FF2's invention. `useCountdown: 0` gates only
   * `Timer_Race.OnEnable`; `Trigger_EnableShip.cs:66-68` calls the public
   * `StartCountdown()` regardless, and `int_01_hoverJet.unity:326705` wires it
   * with `delay: 2`. So `CountdownNumber` x3 and `CoundownGo` really do play in
   * the shipped game. (`docs/audio-event-map.md` §5, and independently found by
   * the modes survey as FIND-modes-18.)
   */
  const audioLaunch = (): void => {
    if (launch.phase !== audioLaunchPhase) {
      // DEV-424: the ride STARTING is a transition too, and it lives here with
      // the other three. It was sent from the press, which fires on EVERY
      // confirm on the pad: a second press during the ride replayed the servo,
      // and one during the countdown restarted the lift loop after
      // `launch.topped` had stopped it — to drone under the whole race, since
      // nothing stops it again before `mission.end`. Out of `'waiting'` happens
      // once a ride, on every route (the press, Quick Race, the autopilot).
      // `''` counts as waiting: the autopilot starts its ride on the first
      // frame there is a ship, which can be before this has seen a phase.
      const wasWaiting = audioLaunchPhase === 'waiting' || audioLaunchPhase === ''
      if (wasWaiting && (launch.phase === 'rising' || launch.phase === 'countdown')) {
        audio.event({ type: 'launch.start' })
      }
      if (launch.phase === 'countdown') audio.event({ type: 'launch.topped' })
      if (launch.phase === 'flying') {
        audio.event({ type: 'countdown.go' })
        // DEV-636/637: GO is a small shove, felt in the camera (flat), the cockpit
        // mesh and the hands.
        feel.shake(TRAUMA.go)
        feel.jolt(JOLTS.go)
        feel.haptic('go')
        // DEV-644: GO has a picture. The frame's edge flashes, and on a monitor
        // the lens kicks (the shake and the cockpit shove are `feel`'s, DEV-636).
        gatePulse.fire(
          editionState.current.fx.gatePulse,
          EDGE_FLASH_SPEED,
          editionState.speedFx,
          GO_FEEL.pulseScale,
        )
        if (lensIsLive()) feel.fovKick(GO_FEEL.fovKickDegrees, GO_FEEL.fovKickSeconds)
        stats.count('attempts')
        stats.attemptStart()
      }
      audioLaunchPhase = launch.phase
    }
    const n = launchSpec ? countdownNumber(launch, launchSpec) : null
    if (n !== null && n !== audioCountdown) {
      audioCountdown = n
      if (n > 0) {
        audio.event({ type: 'countdown.beat', n })
        feel.haptic('countdown') // DEV-637
      }
    }
    if (n === null) audioCountdown = -1
  }

  /**
   * The shaft whoosh — the one cue 2016 emits from a POINT IN THE WORLD.
   *
   * `FF_WorldTour/scripts/Trigger_PlaySound.cs:12` is
   * `PlaySound3DAtVector3("whoosh", this.transform.position)`, and
   * `PlayerStart_ElevatorShaft_Photon.prefab` carries EIGHT of those boxes, all
   * `m_Enabled: 1`, all `soundName: whoosh`, sharing one x/z and spaced exactly
   * 12 m apart in y — the same `segmentSpacing` x `segmentsAuthored` the level
   * schema carries. So the ride is a ladder of eight whooshes on the shaft axis,
   * each sweeping from overhead to underfoot as you climb past it. The port had
   * the cue missing entirely. AUD-5.
   *
   * Driven off the EYE rather than off the platform, because `OnTriggerEnter`
   * fires on the collider tagged `Player`. `cameraWorld` is the world position
   * (trap 18: `camera.position` in the cockpit is the head pose inside the XR
   * rig, and would compare a lean against a shaft).
   */
  const audioShaft = (): void => {
    const collars = handles.elevator?.collars
    if (!collars || collars.length === 0) return
    if (audioCollar < 0) {
      // Arm: skip every collar already below the eye without sounding it.
      audioCollar = collars.filter(
        (c) => c.getWorldPosition(_collarWorld).y <= cameraWorld.y,
      ).length
      return
    }
    while (audioCollar < collars.length) {
      const collar = collars[audioCollar]
      if (!collar) break
      collar.getWorldPosition(_collarWorld)
      if (cameraWorld.y < _collarWorld.y) break
      audioCollar += 1
      audio.event({ type: 'shaft.pass', at: [_collarWorld.x, _collarWorld.y, _collarWorld.z] })
    }
  }

  const keyboard = attachKeyboard()
  /**
   * The WebXR primary action, latched (DEV-205).
   *
   * Built beside the other input devices and driven from the frame like them —
   * it FOLLOWS `renderer.xr.getSession()` rather than hooking `sessionstart`,
   * so there is no second lifecycle to keep in step with the one `readXrInput`
   * already has, and a session that ends takes its latch with it.
   */
  const xrSelect = createXrSelectLatch()
  // One warning per session, not one per frame at 90 Hz — and not until the
  // runtime has had a fair chance to report controllers. Quest publishes
  // `inputSources` a beat AFTER the session starts, so warning on the first
  // frame that finds none cries wolf on every single entry. It did, the first
  // time this was worn: the warning fired 4 seconds in, while the controllers
  // were fine and the actual fault was elsewhere.
  const NO_STICKS_GRACE_SECONDS = 5
  let warnedNoSticks = false
  let presentingSince = 0
  // Recentre is EDGE triggered. Holding the button must not recentre 90 times a
  // second, which would pin the world to your head and be genuinely unpleasant.
  const recenterKey = createEdge()
  const clock = createClock()
  let lastTime = 0
  let running = false
  /**
   * Frames this loop has run. The `census()` guard's clock, and nothing else.
   *
   * Its own counter rather than `renderer.info.render.frame`, because
   * `renderCensus` draws five extra frames of its own and would advance that
   * one — so a second `census()` inside the same game frame would see a
   * different number and run the whole thing again.
   */
  let frameOrdinal = 0
  /**
   * The XR session, its layer and its views, as of the last frame that could
   * look (VR-PERF §5.4).
   *
   * Refreshed INSIDE `frame()` and nowhere else: `XRView` reads throw between
   * frames, so a getter that reached for one when the console called it would
   * throw about as often as it worked. Once a second, so the probe itself never
   * shows up in a trace.
   */
  let xrProbe: XrProbe = IDLE_XR_PROBE
  let xrProbeAt = 0

  // ── The lesson, DEV-377 (APP-SPLIT 4.8, `boot/app/flight/lesson.ts`) ──────
  const lessonHost = createLessonHost({
    get RUNNING_MODE() {
      return RUNNING_MODE
    },
    applyAtmosphere,
    audio,
    get autopilotTerrain() {
      return handles.autopilotTerrain
    },
    capabilities,
    get collisionTerrain() {
      return handles.collisionTerrain
    },
    get comfort() {
      return appSettings.comfort
    },
    controlsMenu,
    get crash() {
      return run.crash
    },
    editionState,
    get flight() {
      return handles.flight
    },
    get fog() {
      return fog
    },
    keyboard,
    get lastResult() {
      return run.lastResult
    },
    get launch() {
      return launch
    },
    get level() {
      return level
    },
    get livePropColliders() {
      return handles.livePropColliders
    },
    makeGuide,
    mission,
    get paused() {
      return pause.paused
    },
    render,
    get screen() {
      return router.screen
    },
  })
  const {
    confirmDevice,
    SKIP_STEP_OPTION,
    buildLesson,
    disposeLesson,
    trackDevice,
    tickLesson,
    frameLesson,
  } = lessonHost

  // A viewpoint wins over every camera mode: it is the one that can be aimed.
  const wantsFly = view === FLY && !VIEWPOINT

  // The frame (APP-SPLIT 4.9, `boot/app/frame.ts`).
  const frameLoop = createFrame({
    CREDITS_BODY_M,
    MODE_REQUEST,
    NO_STICKS_GRACE_SECONDS,
    get RUNNING_MODE() {
      return RUNNING_MODE
    },
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
    get audioBoundaryLeft() {
      return audioBoundaryLeft
    },
    set audioBoundaryLeft(v: number | null) {
      audioBoundaryLeft = v
    },
    get audioFinishCrossed() {
      return audioFinishCrossed
    },
    set audioFinishCrossed(v: boolean) {
      audioFinishCrossed = v
    },
    get audioHovered() {
      return audioHovered
    },
    set audioHovered(v: boolean) {
      audioHovered = v
    },
    audioLaunch,
    get audioPauseAim() {
      return audioPauseAim
    },
    set audioPauseAim(v: number) {
      audioPauseAim = v
    },
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
    get boostBurning() {
      return boostBurning
    },
    set boostBurning(v: boolean) {
      boostBurning = v
    },
    boostFeel,
    get boostGlow() {
      return boostGlow
    },
    set boostGlow(v: number) {
      boostGlow = v
    },
    boostPress,
    get boundary() {
      return boundary
    },
    set boundary(v: BoundaryState) {
      boundary = v
    },
    boundaryFuzz,
    get boundarySpec() {
      return boundarySpec
    },
    breakProps,
    briefingLevel,
    briefingState,
    cameraKey,
    canvas,
    capabilities,
    get cardLifted() {
      return cardLifted
    },
    set cardLifted(v: boolean) {
      cardLifted = v
    },
    chainWatch,
    classicChase,
    clock,
    closePausePages,
    cloudShadow,
    get cloudWhite() {
      return cloudWhite
    },
    set cloudWhite(v: number) {
      cloudWhite = v
    },
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
    get crashDucked() {
      return crashDucked
    },
    set crashDucked(v: boolean) {
      crashDucked = v
    },
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
    get fadePhaseShown() {
      return fadePhaseShown
    },
    set fadePhaseShown(v: FadePhase | null) {
      fadePhaseShown = v
    },
    feel,
    fireAccentFlash,
    flatFov,
    flybyFeel,
    get fog() {
      return fog
    },
    frameLesson,
    get frameOrdinal() {
      return frameOrdinal
    },
    set frameOrdinal(v: number) {
      frameOrdinal = v
    },
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
    get guide() {
      return guide
    },
    handles,
    get hangar() {
      return hangar
    },
    hangarBackKey,
    hitJolt,
    get holotableHovered() {
      return holotableHovered
    },
    set holotableHovered(v: boolean) {
      holotableHovered = v
    },
    horizon,
    get hudGauges() {
      return hudGauges
    },
    hudPlacementNow,
    get hudRaster() {
      return hudRaster
    },
    get hudRedraw() {
      return hudRedraw
    },
    get hudUpload() {
      return hudUpload
    },
    keyboard,
    get landRevealRise() {
      return landRevealRise
    },
    lapAskUp,
    get lastOrbitLook() {
      return lastOrbitLook
    },
    set lastOrbitLook(v: { yaw: number; pitch: number; fromDevice: boolean } | null) {
      lastOrbitLook = v
    },
    get lastThirdPersonLive() {
      return lastThirdPersonLive
    },
    set lastThirdPersonLive(v: boolean) {
      lastThirdPersonLive = v
    },
    get lastTime() {
      return lastTime
    },
    set lastTime(v: number) {
      lastTime = v
    },
    get launch() {
      return launch
    },
    launchBanner,
    get launchSpec() {
      return launchSpec
    },
    lensIsLive,
    lessonHost,
    letterPlate,
    get level() {
      return level
    },
    loadingScene,
    get loadingScenePending() {
      return loadingScenePending
    },
    set loadingScenePending(v: boolean) {
      loadingScenePending = v
    },
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
    get presentingSince() {
      return presentingSince
    },
    set presentingSince(v: number) {
      presentingSince = v
    },
    profileGuideFor,
    get quickRace() {
      return quickRace
    },
    set quickRace(v: {
      readonly id: string
      readonly pressedAt: number
      launched: boolean
    } | null) {
      quickRace = v
    },
    get quickRaceAsked() {
      return quickRaceAsked
    },
    raceLapKey,
    raceLapOffered,
    recenterKey,
    render,
    resetThirdPerson,
    restartRun,
    results,
    get rideSpec() {
      return rideSpec
    },
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
    get running() {
      return running
    },
    sceneTint,
    seaReflection,
    get seatLookPitch() {
      return seatLookPitch
    },
    set seatLookPitch(v: number) {
      seatLookPitch = v
    },
    get seatLookYaw() {
      return seatLookYaw
    },
    set seatLookYaw(v: number) {
      seatLookYaw = v
    },
    seatQuaternion,
    get seatRestKey() {
      return seatRestKey
    },
    set seatRestKey(v: string | null) {
      seatRestKey = v
    },
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
    get stripPlace() {
      return stripPlace
    },
    set stripPlace(v: LivePlace | null) {
      stripPlace = v
    },
    sunHalo,
    sunShadows,
    surfaceHeightAt,
    switchMission,
    syncRaceMap,
    syncRaceStrip,
    thirdPersonNow,
    get thirdPersonWanted() {
      return thirdPersonWanted
    },
    set thirdPersonWanted(v: boolean) {
      thirdPersonWanted = v
    },
    tickLesson,
    get titleAim() {
      return titleAim
    },
    set titleAim(v: number) {
      titleAim = v
    },
    titleBackKey,
    get titleClickAt() {
      return titleClickAt
    },
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
    get warnedNoSticks() {
      return warnedNoSticks
    },
    set warnedNoSticks(v: boolean) {
      warnedNoSticks = v
    },
    watchCamera,
    watchFrame,
    watchLinkWaiting,
    withResultsBoard,
    withShare,
    get world() {
      return world
    },
    xrLifecycle,
    xrPointer,
    get xrProbe() {
      return xrProbe
    },
    set xrProbe(v: XrProbe) {
      xrProbe = v
    },
    get xrProbeAt() {
      return xrProbeAt
    },
    set xrProbeAt(v: number) {
      xrProbeAt = v
    },
    xrSelect,
  })
  const { frame } = frameLoop

  // ── Gameplay statistics (DEV-590, `boot/stats-beacon.ts`) ─────────────────
  //
  // Getters only, read when the page is hidden or every 3 s in a mission; inert
  // where `statsAllowed` said no (a local build, a dev switch, GPC, an opt-out).
  stats.attach({
    reading: () => ({
      quality: qualityInForce(pinned(appSettings.comfort), render.renderer.xr.isPresenting),
      qualityAuto: appSettings.comfort.qualityAuto !== false,
      scale: render.quality.report.scale,
      look: appSettings.missionEdition(),
      vignette: appSettings.comfort.vignette,
      speedFx: appSettings.comfort.speedFx,
      horizon: appSettings.comfort.horizon,
    }),
    inMission: () => router.screen === 'mission',
    frames: () => perf.stats(),
    // DEV-593: a player's own course is `custom`, never its name or content.
    attempt: () => ({
      mission: playerCourses.has(level.id) ? 'custom' : level.id,
      mode: mission.mode,
      look: editionState.current.id,
      opponents: roomCore.room
        ? 'room'
        : (handles.liveRacers?.racers.length ?? 0) > 0
          ? 'ai'
          : handles.livePlayerGhost
            ? 'ghosts'
            : 'none',
      variant: handles.flight?.variant ?? STANDARD_VARIANT_ID,
      ringsTaken: mission.ringsPassed,
      ringsTotal: mission.ringsTotal,
      crashes: run.crash.count,
      elapsed: mission.elapsed,
    }),
    // DEV-622: where the player is when they press SEND on REPORT BUG.
    bug: () => ({
      screen: editorHost.editing
        ? 'editor'
        : tvActive()
          ? 'tv'
          : router.screen === 'menu'
            ? 'hangar'
            : router.screen,
      mission: playerCourses.has(level.id) ? 'custom' : level.id,
      tick: router.screen === 'mission' ? clock.tick : 0,
    }),
    immersiveVr: capabilities.immersiveVr,
    renderer: render.renderer,
  })

  // `__ff2perf` (VR-PERF §5.4): built LAST, from `boot/app/perf.ts`, which says why.
  const perfSurface: PerfSurface | null = perfSys.surface()

  // `__ff2` (APP-SPLIT phase 5, `boot/app/debug-handle.ts`).
  return createDebugHandle({
    get RUNNING_MODE() {
      return RUNNING_MODE
    },
    audio,
    bakedLight,
    bloom,
    get boundary() {
      return boundary
    },
    get boundarySpec() {
      return boundarySpec
    },
    canvas,
    capabilities,
    get cardLifted() {
      return cardLifted
    },
    set cardLifted(v: boolean) {
      cardLifted = v
    },
    get cockpitFirstOn() {
      return cockpitFirstOn
    },
    set cockpitFirstOn(v: boolean) {
      cockpitFirstOn = v
    },
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
    get hangar() {
      return hangar
    },
    get hudGauges() {
      return hudGauges
    },
    set hudGauges(v: HudGauges) {
      hudGauges = v
    },
    get hudRaster() {
      return hudRaster
    },
    set hudRaster(v: HudRaster) {
      hudRaster = v
    },
    get hudRedraw() {
      return hudRedraw
    },
    set hudRedraw(v: HudRedraw) {
      hudRedraw = v
    },
    get hudUpload() {
      return hudUpload
    },
    set hudUpload(v: HudUpload) {
      hudUpload = v
    },
    keyboard,
    get lastOrbitLook() {
      return lastOrbitLook
    },
    get lastThirdPersonLive() {
      return lastThirdPersonLive
    },
    get launch() {
      return launch
    },
    lessonHost,
    letterPlate,
    get level() {
      return level
    },
    loading,
    loadingHost,
    loadingScene,
    maybeReveal,
    menuScene,
    menus,
    mission,
    mouseLook,
    get oceanLateOn() {
      return oceanLateOn
    },
    set oceanLateOn(v: boolean) {
      oceanLateOn = v
    },
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
    get revealRequested() {
      return revealRequested
    },
    set revealRequested(v: boolean) {
      revealRequested = v
    },
    get rideSpec() {
      return rideSpec
    },
    roomCore,
    roomProbe,
    roomWatch,
    router,
    run,
    get running() {
      return running
    },
    set running(v: boolean) {
      running = v
    },
    sceneTint,
    setChunkBatch,
    shareReport,
    get skyLastOn() {
      return skyLastOn
    },
    set skyLastOn(v: boolean) {
      skyLastOn = v
    },
    springArm,
    thirdPersonNow,
    get thirdPersonWanted() {
      return thirdPersonWanted
    },
    get titleAim() {
      return titleAim
    },
    titleMenuUp,
    titleOptions: titleMenuHost.titleOptions,
    optionsPlate,
    titleRows,
    titleVr,
    touch,
    tvControls,
    tvPanel,
    tvPanelInput,
    tvView,
    vignette,
    get world() {
      return world
    },
    worldProps,
    yourCourses,
  })
}

/** Volatile. One shaft collar's world position, inside `audioShaft`. */
const _collarWorld = new THREE.Vector3()

/** Volatile. Composing the chair's yaw onto the launch anchor, once, at build. */

/**
 * Merge two action sets by taking whichever axis is being pushed harder.
 *
 * Not a device mode: both sources are read every frame and the louder one wins
 * per axis, so picking up a pad mid-flight works without a menu, and a keyboard
 * player is not locked out because a dusty pad is plugged in reporting 0.
 */
