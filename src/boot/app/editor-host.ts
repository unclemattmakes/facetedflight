// src/boot/app/editor-host.ts: the game's side of the course editor, out of
// `bootApp`. APP-SPLIT phase 4, slice 2 (`docs/plan/APP-SPLIT.md` §5).
//
// The desktop desk's host (DEV-469: `deskHost`, `editorFrame`, `openEditor`,
// the furniture it hides), `?edit=1`'s arrival (DEV-471), the course's light
// in the editor (DEV-476), the recording flight (DEV-491), the VR bench and its
// door (DEV-492), and MAKE A COURSE. Every line below was moved verbatim from
// the closure; the plumbing is `ctx.x` where the code reads a binding the
// closure still owns (a getter, so a check narrows as the closure's `let`
// did, and a setter where this code writes one: the §6 rule 3 bag), and the
// returned object, which hands the closure what it still calls.
//
// **The editor stays a LAZY chunk.** Everything from `@/editor/` below is
// `import type` or a dynamic `import()`; `tests/unit/editor-lazy-graph.test.ts`
// walks the static graph from `src/main.ts` and fails if that ever changes.
// The DEV-604 table click (`roomTakesPoints`, `roomPointAim`) sat inside the
// bench's block in the closure and is the hangar's, so it stayed there.

import * as THREE from 'three'
import type { AudioSystem } from '@/audio'
import type { LoadProgress } from '@/boot/load-progress'
import type { ComfortSettings } from '@/boot/settings'
import { stats } from '@/boot/stats-beacon'
import type { Edition, SceneTintValue } from '@/content/edition-schema'
import type { Level, SunLight } from '@/content/level-schema'
import { loadBaselineLevel, loadLevel } from '@/content/load-level'
import { PLAYER_COURSE_LIMITS, type PlayerCourse } from '@/content/player-course'
import { type PlayerCourseLight, playerCourseSun } from '@/content/player-course-light'
import { courseLink, linkRefusal } from '@/content/player-course-wire'
// DEV-492: the VR bench, the same way: types here, the bench a dynamic import.
import type { Bench, BenchHand, BenchHost } from '@/editor/bench/host'
// DEV-469: TYPES only, erased at compile — the editor itself is a dynamic import.
import type { PlaytestResult } from '@/editor/core'
import type { Desk, DeskHost, DeskRecordedFlight } from '@/editor/desk/host'
import type { LoadedClouds } from '@/game/clouds'
import type { CourseLibrary, CourseSource } from '@/game/course-library'
import type { EditionState } from '@/game/edition'
import type { Flight } from '@/game/flight'
import { LOCAL_LAP_RULES } from '@/game/ghost-store'
import type { LoadedGhosts, PlayerGhost } from '@/game/ghosts'
import type { BodyPose } from '@/game/lap-run'
import { courseGates, type MissionState } from '@/game/mission'
import {
  type LineClearingReceipt,
  type WorldClearingInput,
  worldClearings,
} from '@/game/props/course-clearing'
import type { LoadedDressing } from '@/game/props/load-dressing'
import type { loadProps } from '@/game/props/load-props'
import type { LoadedRacers } from '@/game/racers'
import type { LoadedRings } from '@/game/rings'
import { withCourseWater } from '@/game/terrain/course-water'
import { type CustomGround, withCustomGround } from '@/game/terrain/custom-ground'
import type { LoadedTerrain } from '@/game/terrain/load-terrain'
import { createEdge } from '@/input/edge'
import type { KeyboardSource } from '@/input/keyboard'
import type { MouseLook } from '@/input/look'
import type { PointerHand } from '@/input/pointer-hand'
import type { TouchControls } from '@/input/touch-overlay'
import { controllerFor, XR_BUTTON } from '@/input/xr'
import { type BenchDoor, createBenchDoor } from '@/render/bench-door'
import type { Bloom } from '@/render/bloom'
import type { CloudShadow } from '@/render/cloud-shadow'
import type { FarShadow } from '@/render/far-shadow'
import { type HangarArt, seatEyeLocal, seatYawLocal } from '@/render/hangar'
import type { Horizon } from '@/render/horizon'
import type { HorizonGeo } from '@/render/horizon-geo'
import type { LoadingScene } from '@/render/loading-scene'
import type { Renderer } from '@/render/renderer'
import type { RunSummary } from '@/render/results'
import type { SceneTint } from '@/render/scene-tint'
import type { SeaReflection } from '@/render/sea-reflection'
import type { SunShadows } from '@/render/shadows'
import type { Sky } from '@/render/sky'
import type { SkyVisibility } from '@/render/sky-visibility'
import { marmosetSunIntensity } from '@/render/skyshop-ibl'
import type { StartGrid } from '@/render/start-grid'
import { withSunLightRule } from '@/render/sun-light-rule'
import type { UnityFog } from '@/render/unity-fog'
import type { Vignette } from '@/render/vignette'
import type { XrPointer } from '@/render/xr-pointer'
import { FIXED_DT } from '@/sim/constants'
import {
  createLapRecorder,
  type LapRecorder,
  markLapEvent,
  recordedLap,
  recordPose,
} from '@/sim/ghost-record'
import { hangarSpecFor } from '@/sim/hangar'
import type { CanopyField } from '@/sim/props/canopy'
import type { Clearing } from '@/sim/props/clearing'
import type { PropColliders } from '@/sim/props/collision'
import { BUILD_VERSION } from '../version'
import {
  EDIT_AT_BOOT,
  EDITOR_RECORD,
  EDITOR_RUN,
  MISSION,
  SHIPPED_AT_BOOT,
  SUN_LIGHT_RULE,
  withPreviewIsland,
} from './pins'
import type { EditorBootPhase } from './types'

/**
 * The mission world, as far as this module reads it: the closure's `World` is
 * `Awaited<ReturnType<typeof buildWorld>>`, which cannot be named outside the
 * closure until the world module exports it (APP-SPLIT 4.7).
 */
type World = {
  readonly turnIndicators: { readonly object: THREE.Object3D }
  readonly ocean: LoadedTerrain | null
}

/** What `createEditorHost` reads from the closure: getters, each read live (APP-SPLIT §3's `ctx`). */
export interface EditorHostCtx {
  readonly _aimDirection: THREE.Vector3
  readonly _aimOrigin: THREE.Vector3
  readonly applyCourseClearing: (
    clearings: readonly Clearing[],
    levelId: string,
  ) => LineClearingReceipt | null
  readonly audio: AudioSystem
  readonly beginLoadingTarget: (target: Level) => void
  readonly bloom: Bloom
  readonly canvas: HTMLCanvasElement
  readonly cloudShadow: CloudShadow
  readonly comfort: ComfortSettings
  readonly courseLibrary: () => Promise<CourseLibrary>
  readonly editionState: EditionState
  readonly editorOn: () => boolean
  readonly farShadow: FarShadow
  readonly flight: Flight | null
  readonly fog: UnityFog
  readonly goToScreen: (
    to: 'menu' | 'mission' | 'title',
    opts?: {
      readonly outSeconds?: number
      readonly inSeconds?: number
      readonly holdSeconds?: number
      readonly act?: () => void
    },
  ) => void
  readonly groundOfCourse: (
    course: PlayerCourse,
    map?: Uint8Array<ArrayBufferLike> | null,
  ) => Promise<CustomGround | null>
  readonly hangar: HangarArt | null
  readonly horizon: Horizon
  readonly keepCourse: (
    course: PlayerCourse,
    source: CourseSource,
    map?: Uint8Array<ArrayBufferLike> | null,
  ) => Promise<void>
  readonly keepMap: (sha: string, bytes: Uint8Array<ArrayBufferLike>) => Promise<boolean>
  readonly keyboard: KeyboardSource
  readonly lastResult: RunSummary | null
  readonly level: Level
  readonly liveClouds: LoadedClouds | null
  readonly liveDressing: LoadedDressing | null
  readonly liveGhosts: LoadedGhosts | null
  readonly liveHorizonGeo: HorizonGeo | null
  readonly livePlayerGhost: PlayerGhost | null
  readonly livePropColliders: PropColliders | null
  readonly livePropsLive: Awaited<ReturnType<typeof loadProps>>
  readonly liveRacers: LoadedRacers | null
  readonly liveRings: LoadedRings | null
  readonly liveSky: Sky | null
  readonly liveTerrain: { terrain: LoadedTerrain; ocean: LoadedTerrain | null } | null
  readonly loading: LoadProgress
  readonly loadingScene: LoadingScene
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  loadingScenePending: boolean
  readonly lobbyUp: () => boolean
  readonly menuEdition: Edition | null
  readonly menuEditionLoad: Promise<Edition>
  readonly mission: MissionState
  readonly missionSun: THREE.DirectionalLight | null
  readonly mouseLook: MouseLook
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  paused: boolean
  readonly pendingScreen: { to: 'title' | 'menu' | 'mission'; act: (() => void) | null } | null
  readonly playerCourses: Map<string, PlayerCourse>
  readonly render: Renderer
  readonly restartRun: (opts?: { respawn?: boolean; raceLap?: boolean }) => void
  readonly roomClose: () => void
  readonly saveCourseFile: (course: PlayerCourse) => Promise<void>
  readonly sceneTint: SceneTint
  readonly screen: 'title' | 'menu' | 'mission'
  readonly seaReflection: SeaReflection
  readonly skyVisibility: SkyVisibility
  readonly startGrid: StartGrid | null
  readonly sunBakeInputs: {
    readonly land: LoadedTerrain
    readonly jitterMetres: number
    readonly canopy: CanopyField | null
  } | null
  readonly sunShadows: SunShadows
  readonly switchMission: (
    id: string,
    opts?: { readonly skipRide?: boolean; readonly inLoadingScene?: Level; readonly level?: Level },
  ) => Promise<void>
  readonly switching: boolean
  readonly touch: TouchControls
  readonly vignette: Vignette
  readonly world: Promise<World> | null
  readonly worldClearingInput: WorldClearingInput | null
  readonly xrPointer: XrPointer
}

export const createEditorHost = (ctx: EditorHostCtx) => {
  // ── DEV-469: the desktop course editor ──────────────────────────────────
  //
  // docs/plan/EDITOR-DISPATCH.md, and EDITOR.md §5.3's desktop half. The editor
  // is `src/editor/desk/`, LAZILY imported below, so none of it is in this
  // chunk; what lives here is the game's side of `DeskHost` and nothing else:
  //
  //  · the WORLD is the mission's, built the ordinary way (`buildWorld`, by
  //    `switchMission` for a new sky), with the mission's own furniture — the
  //    ship, the cockpit and its HUD, the course it was built with, the grid —
  //    put out of sight while the editor is up;
  //  · the editor's FRAME replaces the mission's (`editorFrame`, called at the
  //    top of `frame`): the world's per-frame upkeep and one render from the
  //    desk's camera. No sim step, no input, no pause: the run is frozen and
  //    reset, and a key pressed in the editor is spent here, not saved up for
  //    the cockpit;
  //  · FLY is `switchMission` with the course's level, through Quick Race's
  //    door — one fade into the loading scene (DEV-353, DEV-465) — and the way
  //    back is the pause plate's Back to editor or the results panel's press,
  //    which hand the lap to the desk (DEV-468's `onReturn`);
  //  · flat only. A session starting while the editor is up leaves it.
  let desk: Desk | null = null
  let deskAsked = false
  /** The editor is up: `editorFrame` runs in place of the mission's frame. */
  let editing = false
  /** What the desk is told on its next frame: a flown lap, null (a world swap), or nothing. */
  let deskResume: PlaytestResult | null | undefined
  const _editorEye = new THREE.Vector3()
  /** The world whose turn indicators have been asked to follow the editor. */
  let furnitureWorld: Promise<World> | null = null
  /** The fog the editor cleared, and its flags as they were, to put back. */
  let fogCleared: { fog: UnityFog; flags: THREE.Vector2 } | null = null

  // ── DEV-471: `?edit=1`'s arrival, for the landing card ──────────────────
  //
  // Matt, 2026-09-27: *"the 'curtain' should go away once the level loads in
  // (if ?edit=1)"*. The curtain is `index.html`'s landing card (#overlay), not
  // `render/title-curtain.ts` — an `?edit=1` boot builds no title and has none.
  // The card holds the game until a press for two reasons, and neither is the
  // editor's: the title's rows hang where its buttons are (`cardLifted`), and
  // the press is the first user GESTURE, which builds the AudioContext
  // (`reveal`). The editor has no title rows, and its own FLY is a press: the
  // `fly` hook below resumes the audio there. So under `?edit=1` the card
  // stands over the loading scene (the loading screen: below, at the end of
  // this block), counting as it does at every boot, and it goes by itself
  // when this says `ready`: the editor has drawn a frame over a world
  // whose build is done (terrain AND props: `loading.ready()` is the last line
  // of `buildWorld`), which is when a click on the ground can land.
  //
  // DEV-557 took the card away altogether: the loading scene is what an
  // `?edit=1` boot shows until the editor draws, and nothing has to go by
  // itself. The phase is still published (`data-editor-boot`) and still
  // offered to a listener, for the specs that wait on the editor.
  let editorBootPhase: EditorBootPhase | null = EDIT_AT_BOOT ? 'loading' : null
  const editorBootListeners: ((phase: EditorBootPhase) => void)[] = []
  if (editorBootPhase) document.body.dataset.editorBoot = editorBootPhase
  /** One way only, out of `loading`. A no-op on a boot that did not ask. */
  const settleEditorBoot = (phase: 'ready' | 'off'): void => {
    if (editorBootPhase !== 'loading') return
    editorBootPhase = phase
    document.body.dataset.editorBoot = phase
    for (const listener of editorBootListeners) listener(phase)
  }
  const onEditorBoot = (listener: (phase: EditorBootPhase) => void): void => {
    if (editorBootPhase === null) return
    editorBootListeners.push(listener)
    listener(editorBootPhase)
  }
  // ── end DEV-471 ─────────────────────────────────────────────────────────

  /**
   * The mission's own furniture, which the editor does not draw. Hidden on
   * EVERY editor frame (a handful of assignments): the world may still be
   * building when the editor's first frame runs, and each part arrives when
   * it arrives. The turn indicators are the world's, asked once per world.
   */
  const setMissionFurniture = (on: boolean): void => {
    if (ctx.flight) ctx.flight.object.visible = on
    ctx.render.rig.visible = on
    if (ctx.liveRings) ctx.liveRings.object.visible = on
    if (ctx.liveRacers) ctx.liveRacers.group.visible = on
    if (ctx.liveGhosts) ctx.liveGhosts.group.visible = on
    if (ctx.livePlayerGhost) ctx.livePlayerGhost.group.visible = on
    if (ctx.startGrid) ctx.startGrid.object.visible = on
    // And the clouds: from above they are a lid over the island you are drawing on.
    if (ctx.liveClouds) ctx.liveClouds.group.visible = on
    // DEV-471: and the far shore. It is a ring of cards 5 km round a COCKPIT
    // eye at sea level (`render/horizon-geo.ts`); from an editor camera
    // kilometres up it stands between the eye and the island, a band drawn
    // over the course (Matt: "draws on top of everything"). Hidden while the
    // editor draws, and back to what the preset says for Fly: the game's own
    // rule is untouched, and a preset flip that shows it mid-edit is undone
    // on the next editor frame, since this runs on every one.
    if (ctx.liveHorizonGeo) {
      ctx.liveHorizonGeo.object.visible = on && ctx.editionState.current.render.horizonGeo.enabled
    }
    if (on || ctx.world !== furnitureWorld) {
      furnitureWorld = on ? null : ctx.world
      void ctx.world?.then(
        (w) => {
          w.turnIndicators.object.visible = !editing
          // DEV-498: and the rest of the sea. The game builds only the chunks
          // inside its own far plane; the editor's reaches 14–22 km, where
          // that sea ended in a square with the sky past it. Built the first
          // time an editor draws over this world (the call is the build),
          // hidden for Fly, and never built by a mission.
          const far = w.ocean?.farSea(!on) ?? null
          if (far) far.visible = !on
        },
        () => {},
      )
    }
    // The mission's fog is a pilot's: from the height a course is laid out at
    // it is the whole picture, one flat colour (measured: the framed island
    // drew nothing else). The distance and height terms are switched off
    // while the editor draws, and put back as they were.
    if (!on && fogCleared?.fog !== ctx.fog) {
      fogCleared = { fog: ctx.fog, flags: ctx.fog.uniforms.uFogFlags.value.clone() }
      ctx.fog.uniforms.uFogFlags.value.set(0, 0)
    } else if (on && fogCleared) {
      fogCleared.fog.uniforms.uFogFlags.value.copy(fogCleared.flags)
      fogCleared = null
    }
  }

  /** Into the loading scene behind one fade, then the switch: Quick Race's door. */
  const editorSwitch = (next: Level, act: () => void, arrived: () => void): boolean => {
    if (ctx.switching || ctx.pendingScreen) return false
    ctx.goToScreen('menu', {
      act: () => {
        desk?.suspend()
        act()
        ctx.beginLoadingTarget(next)
        ctx.loadingScenePending = true
        void ctx.switchMission(next.id, { skipRide: true, inLoadingScene: next }).then(() => {
          if (ctx.level.id !== next.id)
            console.warn(`editor: the switch to ${next.id} did not land`)
          arrived()
        })
      },
    })
    return true
  }

  // ── DEV-476: a player course's light, live in the editor ────────────────
  //
  // Matt: *"sun sliders plus a tint: sun height and direction, and a colour
  // tint reusing DEV-446's scene tint, saved in the course. Sky and ambient
  // still come from the chosen sky mission."* A course FLOWN needs nothing
  // here: its level carries its sun (`expandPlayerCourse`), and every reader
  // of `lighting.sun` builds from it with the world. The EDITOR draws the
  // sky's world, built for the donor's sun, and moves that sun under it:
  //
  //  · at once, on every slider step: the light itself (so the near shadow
  //    map, which fits itself to the light each frame), the fog's sun term,
  //    the sea's glint, and the sky's disc and glow (a dome re-bake and its
  //    prefilter);
  //  · when the slider SETTLES (its release): the far-shadow march and the
  //    sky-visibility bake over the whole island, which are per sun and cost
  //    what the row measures. Until then the terrain keeps the last settled
  //    sun's far shadows.
  //
  // The clouds and the far shore are hidden while the editor draws, so they
  // are not moved; a flight builds them from the course's own sun. Leaving
  // the editor puts the world's own sun back, maps and all.
  /** The sun the editor last lit the world by, per world, and the one its maps were baked for. */
  let editorSun: { world: LoadedTerrain; live: string; baked: string } | null = null
  /** The course's tint while the editor draws; null is the preset's. */
  let editorTint: SceneTintValue | null = null
  /** The last re-bake's cost, for `__ff2.editor()` and the row's measurement. */
  let editorSunBake: { farShadowMs: number; skyVisibilityMs: number; skyMs: number } | null = null
  /** The last live step's sky re-bake (dome and prefilter), milliseconds: the live half's cost. */
  let editorSkyMs = 0
  const sunKey = (d: readonly number[]): string => d.map((c) => c.toFixed(6)).join(',')
  /** Light the built world by `sun`: the cheap half always, the two maps when `settled`. */
  const lightWorldBy = (sun: SunLight, settled: boolean): void => {
    const world = ctx.liveTerrain?.terrain
    if (!world) return
    const own = ctx.level.lighting.sun?.direction ?? sun.direction
    if (editorSun?.world !== world) editorSun = { world, live: sunKey(own), baked: sunKey(own) }
    const key = sunKey(sun.direction)
    const [dx, dy, dz] = sun.direction as [number, number, number]
    if (key !== editorSun.live) {
      editorSun.live = key
      ctx.missionSun?.position.set(-dx, -dy, -dz).multiplyScalar(10_000)
      ctx.fog.uniforms.uFogSunDir.value.set(dx, dy, dz).normalize()
      ctx.liveTerrain?.ocean?.water?.setSunDirection(sun.direction)
      if (ctx.liveSky) {
        const t0 = performance.now()
        ctx.render.scene.environment = ctx.liveSky.resun(
          [dx, dy, dz],
          [sun.colorLinear[0], sun.colorLinear[1], sun.colorLinear[2]],
        )
        editorSkyMs = performance.now() - t0
      }
    }
    const inputs = ctx.sunBakeInputs
    if (!settled || key === editorSun.baked || !inputs || inputs.land !== world) return
    editorSun.baked = key
    const t0 = performance.now()
    const sweep = ctx.farShadow.setWorld(
      world.heightField,
      sun.direction,
      inputs.jitterMetres,
      inputs.canopy,
    )
    const t1 = performance.now()
    ctx.skyVisibility.setWorld(
      world.heightField,
      world.colorMap,
      sweep,
      new THREE.Color()
        .setRGB(
          sun.colorLinear[0],
          sun.colorLinear[1],
          sun.colorLinear[2],
          THREE.LinearSRGBColorSpace,
        )
        .multiplyScalar(marmosetSunIntensity(sun.intensity)),
    )
    const t2 = performance.now()
    editorSunBake = { farShadowMs: t1 - t0, skyVisibilityMs: t2 - t1, skyMs: editorSkyMs }
    document.body.dataset.editorSunBaked = key
    console.info(
      `editor: the sun re-baked for ${key} — far shadow ${(t1 - t0).toFixed(0)} ms, ` +
        `sky visibility ${(t2 - t1).toFixed(0)} ms (DEV-476)`,
    )
  }
  /** The desk's light over `donor`: the sun it flies under, through the one sun rule. */
  const setEditorLight = (
    light: PlayerCourseLight | null,
    donor: Level,
    settled: boolean,
  ): void => {
    editorTint = light ? { color: light.tint, strength: light.tintAmount } : null
    const sun = playerCourseSun(donor, light ?? undefined)
    if (!sun) return
    const ruled = withSunLightRule(
      { ...donor, lighting: { ...donor.lighting, sun } },
      SUN_LIGHT_RULE,
    )
    if (ruled.lighting.sun) lightWorldBy(ruled.lighting.sun, settled)
  }
  /**
   * The tint of the player course whose level is `id` — the playtest's, or
   * one flown from a link, a file or YOUR COURSES — or null (the preset's).
   * A course's tint rides on the COURSE, never on its level.
   */
  const courseTintFor = (id: string): SceneTintValue | null => {
    const run = EDITOR_RUN.request
    const course = run && run.level.id === id ? run.course : ctx.playerCourses.get(id)
    const l = course?.light
    return l ? { color: l.tint, strength: l.tintAmount } : null
  }
  /** Out of the editor: the world's own sun back, maps and all, and no course tint. */
  const restoreWorldSun = (): void => {
    editorTint = null
    if (ctx.level.lighting.sun) lightWorldBy(ctx.level.lighting.sun, true)
  }
  // ── end DEV-476 ─────────────────────────────────────────────────────────

  const deskHost: DeskHost = {
    renderer: ctx.render.renderer,
    scene: ctx.render.scene,
    canvas: ctx.canvas,
    gameCamera: ctx.render.camera,
    level: () => ctx.level,
    // DEV-475: the grid the racers stand on beside the start pad. Rules are
    // always Anniversary's (D35), and the game spawns from this same block.
    racers: () => ctx.editionState.current.gameplay.racers,
    // DEV-504: a new placed prop stands, and is sized, as the island's scatter is.
    propLook: () => {
      const p = ctx.editionState.current.props
      const scale: Record<string, number> = {}
      for (const [k, v] of Object.entries(p.scale as Record<string, unknown>)) {
        if (typeof v === 'number') scale[k] = v
      }
      return { sink: p.groundSnap.enabled ? p.groundSnap.sink : 0, scale }
    },
    terrains: () =>
      ctx.liveTerrain ? { land: ctx.liveTerrain.terrain, ocean: ctx.liveTerrain.ocean } : null,
    showWorld: (donor) => {
      const ok = editorSwitch(
        donor,
        () => {
          document.body.dataset.editor = 'switching'
        },
        () => {
          // Back into the editor at the black of the switch's own fade in.
          deskResume = null
        },
      )
      if (!ok) deskResume = null
    },
    fly: (request) => {
      const ok = editorSwitch(
        request.level,
        () => {
          editing = false
          EDITOR_RUN.request = request
          setMissionFurniture(true)
          document.body.dataset.editor = 'flying'
        },
        () => {},
      )
      // DEV-471: FLY is a press, and under `?edit=1` it may be the page's first
      // gesture (no card was pressed): build or wake the AudioContext here,
      // inside the click, as the first press does (`reveal`). Idempotent.
      if (ok) void ctx.audio.resume()
      if (ok) ctx.audio.event({ type: 'ui.confirm' })
      else deskResume = null
    },
    leave: () => editorLeave(),
    // DEV-476: the course's light on the world the editor draws.
    setLight: (light, donor, settled) => setEditorLight(light, donor, settled),
    // DEV-500: the drawn plate only; a flight builds its world at the level itself.
    previewWater: (metres) => ctx.liveTerrain?.ocean?.setPreviewLift(metres),
    // DEV-502: the draft's line, cleared on the world as it is edited — by the
    // same function, over the same input, a flight of it builds with.
    clearLine: (course) => {
      const input = ctx.worldClearingInput
      if (!input || !ctx.livePropsLive) return null
      // No line (a draft of one point): every tree the last line took, back.
      if (!course) return ctx.applyCourseClearing([], '(no line)')
      if (course.environment !== input.level.environment) return null
      const gates = courseGates(course).map((g) => ({ x: g.centre.x, z: g.centre.z }))
      return ctx.applyCourseClearing(
        worldClearings({ ...input, level: course, gates }).course,
        course.id,
      )
    },
    // DEV-503: the live collider set the prop warnings judge against.
    propColliders: () => ctx.livePropColliders,
    placedPropIds: () => ctx.livePropsLive?.placedColliderIds ?? [],
    // DEV-467's wire and library, through DEV-467's own functions: one save
    // path, one library, and a course made here is listed as made here.
    saveFile: async (course) => {
      await ctx.saveCourseFile(course)
      await ctx.keepCourse(course, 'made-here')
    },
    link: async (course) => {
      const noLink = linkRefusal(course) // DEV-490, DEV-533
      if (noLink) throw new Error(noLink.why)
      await ctx.keepCourse(course, 'made-here')
      return courseLink(course, `${location.origin}${location.pathname}`)
    },
    // DEV-490: an imported map, kept; and the ground a course stands on.
    keepMap: (sha, bytes) => ctx.keepMap(sha, bytes),
    groundOf: (course) => ctx.groundOfCourse(course),
    library: async () =>
      (await (await ctx.courseLibrary()).list()).map((e) => ({
        id: e.id,
        name: e.name,
        island: e.island,
        course: e.course,
      })),
    // DEV-491: a recording flight, through FLY's own door.
    record: (next) => {
      const ok = editorSwitch(
        next,
        () => {
          editing = false
          EDITOR_RECORD.level = next
          editorRecording.phase = 'idle'
          editorRecording.rec = null
          setMissionFurniture(true)
          document.body.dataset.editor = 'recording'
        },
        () => {},
      )
      if (ok) void ctx.audio.resume()
      if (ok) ctx.audio.event({ type: 'ui.confirm' })
      else deskRecorded = null
    },
  }

  /** Back to the editor from a playtest, with the lap as it stands. */
  const editorReturn = (): void => {
    const run = EDITOR_RUN.request
    if (!run || ctx.pendingScreen) return
    const result: PlaytestResult = {
      courseId: run.courseId,
      fromT: run.fromT,
      finished: ctx.mission.finishCrossed,
      seconds: ctx.mission.finishCrossed
        ? (ctx.lastResult?.finishedAt ?? ctx.mission.elapsed)
        : null,
      ringsTaken: ctx.mission.ringsPassed,
      ringsTotal: ctx.mission.ringsTotal,
    }
    ctx.paused = false
    ctx.audio.event({ type: 'ui.back' })
    // DEV-492: a flight from the bench goes back to the ROOM, the bench open.
    if (benchFlight) {
      benchReturn(result)
      return
    }
    ctx.goToScreen('mission', {
      act: () => {
        EDITOR_RUN.request = null
        ctx.restartRun()
        editing = true
        deskResume = result
        console.info(
          `editor: back from ${run.courseId}, ${result.ringsTaken}/${result.ringsTotal} rings` +
            (result.seconds === null ? '' : `, ${result.seconds.toFixed(2)} s`),
        )
      },
    })
  }

  /** Out of the editor, to the hangar. */
  const editorLeave = (): void => {
    if (ctx.pendingScreen) return
    ctx.goToScreen('menu', {
      act: () => {
        editing = false
        EDITOR_RUN.request = null
        desk?.suspend()
        setMissionFurniture(true)
        restoreWorldSun() // DEV-476: the world's own sun back
        ctx.restartRun()
        ctx.hangar?.refresh()
        delete document.body.dataset.editor
        console.info('editor: left for the hangar')
      },
    })
  }

  // ── DEV-491: fly-to-author — the recording flight ───────────────────────
  //
  // EDITOR.md §5.3: *"Free Flight over the island, a press to start and stop;
  // the recorder (DEV-370's pose format) captures the flight"*. The desk asks
  // (`deskHost.record`) with the core's `recordingLevel`: Free Flight from the
  // draft's pad, no rings, the sky's boundary. It is flown through the same
  // switch as a playtest. In flight, R starts the recording — before the
  // lift-off it ARMS it, and it starts on the first flying step — and R again
  // stops it and goes back to the editor with it; so does the pause plate's
  // Back to editor. The poses are DEV-370's recorder's (`sim/ghost-record.ts`),
  // one per fixed step AFTER `stepMission`, as `lap-run.ts` takes them; the
  // desk turns the lap doc into the line (`core/fit.ts`). Nothing is kept,
  // posted or raced: this is a pen, not a lap.
  //
  // R is the results panel's "race this lap" (DEV-371), and a Free Flight has
  // no results panel: it never ends. So in the one flight that records, R is
  // free, and the same key is read.
  type RecordPhase = 'idle' | 'armed' | 'recording'
  const editorRecording: {
    phase: RecordPhase
    rec: LapRecorder | null
    tick: number
    badge: HTMLElement | null
    badgeText: string
  } = { phase: 'idle', rec: null, tick: 0, badge: null, badgeText: '' }
  /** R, as a press. Born held, so an R down as the flight opens starts nothing. */
  const recordKey = createEdge()
  recordKey.hold()
  /** What the desk is told on its next frame: a recording, null (nothing recorded), or nothing. */
  let deskRecorded: DeskRecordedFlight | null | undefined
  /** The longest a recording may run: the longest time limit a course may have. */
  const RECORD_MAX_TICKS = Math.ceil(PLAYER_COURSE_LIMITS.timeLimitSeconds.max / FIXED_DT)

  const inRecordingFlight = (): boolean =>
    EDITOR_RECORD.level !== null && ctx.level.id === EDITOR_RECORD.level.id && !editing

  /** The recording so far as a lap doc, or null with under two poses. */
  const recordingSoFar = (): DeskRecordedFlight | null => {
    const rec = editorRecording.rec
    if (!rec || rec.count < 2) return null
    const doc = recordedLap(rec, {
      mission: ctx.level.id,
      mode: 'freeFlight',
      edition: ctx.editionState.rules.id,
      rules: LOCAL_LAP_RULES,
      vehicle: ctx.level.vehicle,
      build: BUILD_VERSION,
    })
    return { doc, worldOffset: [...rec.worldOffset] as [number, number, number] }
  }

  /** Back to the editor from a recording flight, with what it recorded. */
  const editorRecordReturn = (): void => {
    if (!EDITOR_RECORD.level || ctx.pendingScreen) return
    const recorded = recordingSoFar()
    ctx.paused = false
    ctx.audio.event({ type: 'ui.back' })
    ctx.goToScreen('mission', {
      act: () => {
        EDITOR_RECORD.level = null
        editorRecording.phase = 'idle'
        editorRecording.rec = null
        ctx.restartRun()
        editing = true
        deskRecorded = recorded
        editorRecordBadge() // out of the flight: the line goes
        console.info(
          `editor: back from a recording, ${recorded ? `${recorded.doc.keyCount} keys` : 'nothing recorded'}`,
        )
      },
    })
  }

  /** Per frame, in flight: R arms, starts or stops the recording. */
  const editorRecordInput = (): void => {
    const pressed = recordKey.step(ctx.keyboard.raceLap)
    if (!inRecordingFlight() || !pressed || ctx.paused) return
    if (editorRecording.phase === 'recording') {
      console.info(`editor: recording stopped at tick ${editorRecording.tick}`)
      editorRecordReturn()
    } else if (editorRecording.phase === 'armed') {
      editorRecording.phase = 'idle'
    } else {
      editorRecording.phase = 'armed'
      console.info('editor: recording armed')
    }
  }

  /**
   * One fixed step, after `stepMission`: the pose `stepMission` just scored.
   * Armed, it starts here, at tick 0; a crash reset or a boundary respawn is
   * marked (`placed`), and the fit cuts the flight there.
   */
  const editorRecordStep = (body: BodyPose): void => {
    if (!inRecordingFlight()) return
    if (editorRecording.phase === 'armed') {
      editorRecording.rec = createLapRecorder(
        [ctx.level.worldOffset[0], ctx.level.worldOffset[1], ctx.level.worldOffset[2]],
        Math.ceil(60 / FIXED_DT),
      )
      editorRecording.tick = 0
      editorRecording.phase = 'recording'
      recordPose(editorRecording.rec, 0, body.position, body.orientation)
      console.info('editor: recording started')
      return
    }
    const rec = editorRecording.rec
    if (editorRecording.phase !== 'recording' || !rec) return
    editorRecording.tick += 1
    recordPose(rec, editorRecording.tick, body.position, body.orientation)
    if (editorRecording.tick >= RECORD_MAX_TICKS) {
      console.info('editor: the recording reached the longest a course may run; stopping')
      editorRecordReturn()
    }
  }

  /** A crash reset or a respawn PUT the ship where it is: the next pose is a teleport. */
  const editorRecordPlaced = (): void => {
    const rec = editorRecording.rec
    if (!inRecordingFlight() || editorRecording.phase !== 'recording' || !rec) return
    markLapEvent(rec, editorRecording.tick + 1, 'reset')
  }

  /** The line on the screen that says what R does now. Flat only, as the editor is. */
  const editorRecordBadge = (): void => {
    const on = inRecordingFlight() && ctx.screen === 'mission'
    let text = ''
    if (on) {
      const p = editorRecording.phase
      text =
        p === 'recording'
          ? `● REC ${(editorRecording.tick * FIXED_DT).toFixed(1)} s — R to stop and make it the line`
          : p === 'armed'
            ? 'Recording starts at lift-off — R to cancel'
            : 'R to start recording — fly the line you want, then R again'
    }
    if (text === editorRecording.badgeText) return
    editorRecording.badgeText = text
    let el = editorRecording.badge
    if (!el) {
      el = document.createElement('div')
      el.id = 'editor-record'
      el.style.cssText =
        'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:6;padding:6px 14px;' +
        'border-radius:8px;background:rgba(10,16,24,.8);color:#e8f0f8;pointer-events:none;' +
        'font:600 14px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:.02em'
      document.body.appendChild(el)
      editorRecording.badge = el
    }
    el.textContent = text
    el.style.display = text ? '' : 'none'
    el.style.color = editorRecording.phase === 'recording' ? '#ff6b6b' : '#e8f0f8'
    document.body.dataset.editorRecord = on ? editorRecording.phase : ''
  }
  // ── end DEV-491 ─────────────────────────────────────────────────────────

  // ══ DEV-492: the VR bench ═══════════════════════════════════════════════
  //
  // EDITOR.md §5.3, "On the bench (headset)": the course editor's headset front
  // end, `src/editor/bench/`, LAZILY imported as the desk is. The game's side is
  // here and nothing else:
  //
  //  · THE DOOR, `render/bench-door.ts`: a plate at the seated player's lap,
  //    in a headset, where the build has the editor (the MENUS' preset, D35),
  //    on the room's first step with nothing loading. The laser aims it as it
  //    aims the tables; a press opens the bench.
  //  · THE BENCH stands in the room's frame in front of the chair, and while it
  //    is up the room's arc is lent to it (DEV-465's hide, under a sentinel no
  //    table stands for, the shelf's own device) and the room's tables are not
  //    aimed or pressed. It reads each hand's ray (`xrPointer.ray`, through the
  //    rig) and its buttons straight off the session's `xr-standard` pads.
  //  · FLY is the desk's: `editorSwitch` with the course's level, one fade
  //    into the loading scene. The way back — the pause plate's Back to editor,
  //    or the results panel's press — is `editorReturn`, which sees
  //    `benchFlight` and comes back to the ROOM with the bench open and the lap
  //    handed to it, rather than to the flat editor's frame.
  //  · A session ending puts the bench away: it is a headset thing.
  let bench: Bench | null = null
  let benchAsked = false
  /** The bench is up: the room's tables are inert and the hands are the bench's. */
  let benchUp = false
  /** The playtest in flight was flown from the bench. */
  let benchFlight = false
  /** The door, standing in the room; null where the room has none. */
  let benchDoor: BenchDoor | null = null
  let benchDoorAimed = false
  /** The sentinel the room's arc is focused on while the bench is up. */
  const BENCH_LENT = 'bench:lent'
  const _benchOrigin = new THREE.Vector3()
  const _benchDirection = new THREE.Vector3()

  const benchHost = (room: THREE.Object3D): BenchHost => ({
    room,
    seat: seatEyeLocal(hangarSpecFor()),
    seatBearing: -seatYawLocal(),
    loadLevel: (id) => loadLevel(id),
    defaultSky: MISSION,
    liveLevel: () => (ctx.liveTerrain ? ctx.level : null),
    terrains: () =>
      ctx.liveTerrain ? { land: ctx.liveTerrain.terrain, ocean: ctx.liveTerrain.ocean } : null,
    racers: () => ctx.editionState.current.gameplay.racers,
    holoLook: () => ctx.editionState.current.menu.holoTerrainColours,
    fly: (request) => {
      const ok = editorSwitch(
        request.level,
        () => {
          closeBench()
          benchFlight = true
          EDITOR_RUN.request = request
          setMissionFurniture(true)
          document.body.dataset.editor = 'flying'
        },
        () => {},
      )
      if (ok) ctx.audio.event({ type: 'ui.confirm' })
    },
    leave: () => {
      closeBench()
      ctx.audio.event({ type: 'ui.back' })
      console.info('bench: back to the room')
    },
  })

  /** Is the door offered now: a headset, the editor, the room's first step, nothing loading. */
  const benchDoorUp = (): boolean =>
    ctx.render.renderer.xr.isPresenting &&
    ctx.screen === 'menu' &&
    !benchUp &&
    !ctx.switching &&
    ctx.pendingScreen === null &&
    ctx.editorOn() &&
    ctx.hangar !== null &&
    ctx.hangar.view === 'vehicles' &&
    ctx.hangar.focused === null &&
    !ctx.lobbyUp()

  /** Open the bench in the room, with `result` when it is back from a flight. */
  const openBench = (result: PlaytestResult | null = null): void => {
    if (!ctx.hangar) return
    benchUp = true
    benchDoorAimed = false
    ctx.hangar.focus(BENCH_LENT)
    document.body.dataset.bench = 'open'
    const room = ctx.hangar.object
    const show = (b: Bench): void => {
      if (benchUp) b.open(result)
    }
    if (bench) {
      show(bench)
      return
    }
    if (benchAsked) return
    benchAsked = true
    void import('@/editor/bench').then(
      (m) => {
        bench = m.createBench(benchHost(room))
        show(bench)
      },
      (err: unknown) => {
        benchAsked = false
        benchUp = false
        ctx.hangar?.focus(null)
        delete document.body.dataset.bench
        console.error('bench: the bench did not load', err)
      },
    )
  }

  /** Put the bench away and give the room its arc back. */
  const closeBench = (): void => {
    if (!benchUp) return
    benchUp = false
    bench?.close()
    if (ctx.hangar?.focused === BENCH_LENT) ctx.hangar.focus(null)
    delete document.body.dataset.bench
  }

  /** Back from a flight flown from the bench: to the room, the bench open, the lap handed over. */
  const benchReturn = (result: PlaytestResult): void => {
    ctx.goToScreen('menu', {
      act: () => {
        EDITOR_RUN.request = null
        benchFlight = false
        ctx.restartRun()
        delete document.body.dataset.editor
        openBench(result)
      },
    })
  }

  /** The press, in the room: the bench's own when it is up, the door's when aimed. True when taken. */
  const benchPress = (): boolean => {
    if (benchUp) return true
    if (benchDoorAimed && benchDoorUp()) {
      ctx.audio.event({ type: 'ui.confirm' })
      openBench()
      return true
    }
    return false
  }

  /** Each posed hand's ray and buttons, for the bench. */
  const benchHands = (): BenchHand[] => {
    const session = ctx.render.renderer.xr.getSession()
    const out: BenchHand[] = []
    for (const hand of ['left', 'right'] as const) {
      if (!ctx.xrPointer.ray(hand, ctx.render.rig, _benchOrigin, _benchDirection)) continue
      // DEV-735: the controller flight reads (the FIRST source on the hand
      // with a gamepad), not the last one of a loop of its own.
      const pad = controllerFor(session, hand)
      const on = (i: number): boolean => pad?.buttons[i]?.pressed ?? false
      out.push({
        hand,
        origin: [_benchOrigin.x, _benchOrigin.y, _benchOrigin.z],
        direction: [_benchDirection.x, _benchDirection.y, _benchDirection.z],
        trigger: on(XR_BUTTON.trigger),
        squeeze: on(XR_BUTTON.squeeze),
        stick: on(XR_BUTTON.stick),
        lower: on(XR_BUTTON.lower),
        upper: on(XR_BUTTON.upper),
      })
    }
    return out
  }

  /**
   * The room's frame with the bench up, in place of the tables' aim; or the
   * door's aim when it stands. Returns true when the bench took the frame.
   */
  const benchFrame = (frameSeconds: number, eye: THREE.Vector3): boolean => {
    if (benchUp && !ctx.render.renderer.xr.isPresenting) closeBench()
    if (benchUp) {
      // The door is where the bench stands: put by while it is open.
      if (benchDoor) benchDoor.object.visible = false
      if (!bench) return true
      const beam = bench.frame(frameSeconds, benchHands())
      if (beam && ctx.xrPointer.ray(beam.hand, ctx.render.rig, _benchOrigin, _benchDirection)) {
        ctx.xrPointer.show(beam.hand, beam.distance, eye)
      }
      return true
    }
    // The door: stood once, into the room's frame, and shown only when offered.
    if (!benchDoor && ctx.hangar) {
      benchDoor = createBenchDoor(seatEyeLocal(hangarSpecFor()), -seatYawLocal())
      ctx.hangar.object.add(benchDoor.object)
    }
    if (benchDoor) benchDoor.object.visible = benchDoorUp()
    return false
  }

  /** After the room aimed with `hand`'s ray: does it land on the door? */
  const benchDoorAim = (hand: PointerHand | null, eye: THREE.Vector3): void => {
    const was = benchDoorAimed
    benchDoorAimed = false
    if (benchDoor?.object.visible && hand !== null) {
      const d = benchDoor.hit(ctx._aimOrigin, ctx._aimDirection)
      if (d !== null) {
        benchDoorAimed = true
        ctx.xrPointer.show(hand, d, eye)
      }
    }
    if (was !== benchDoorAimed) benchDoor?.setAimed(benchDoorAimed)
  }
  // ══ end DEV-492 ══════════════════════════════════════════════════════════

  /** Does this build have the editor? The menus' preset says (D35), as it does for rooms. */
  const editorOffered = (then: (on: boolean) => void): void => {
    if (ctx.menuEdition) then(ctx.menuEdition.gameplay.editor.enabled)
    else
      void ctx.menuEditionLoad.then(
        (e) => then(e.gameplay.editor.enabled),
        () => then(false),
      )
  }

  /** Open the editor over the world that is up. Loads the desk the first time. */
  const openEditor = (): void => {
    editing = true
    stats.count('editorOpened')
    if (deskAsked) {
      deskResume = null
      return
    }
    deskAsked = true
    editorOffered((on) => {
      if (!on) {
        editing = false
        console.warn('editor: this build has no course editor (gameplay.editor is off)')
        settleEditorBoot('off') // DEV-471: the card goes back to Start.
        return
      }
      // DEV-540: `?edit=1&shipped=<id>` under `pnpm dev` opens the shipped
      // mission's desk; a mission it cannot open falls back to the player's.
      // Folded away, import and all, in a production build (SHIPPED_AT_BOOT).
      if (import.meta.env.DEV && SHIPPED_AT_BOOT !== null && ctx.level.id === SHIPPED_AT_BOOT) {
        const shippedId = SHIPPED_AT_BOOT
        void import('@/editor/desk/shipped')
          .then((m) => m.openShippedDesk(deskHost, shippedId))
          .then(
            (opened) => {
              desk = opened
            },
            (err: unknown) => {
              console.warn(`editor: the shipped desk did not open ${shippedId} (DEV-540)`, err)
              void import('@/editor/desk').then(
                (m) => {
                  desk = m.createDesk(deskHost)
                },
                (e: unknown) => {
                  editing = false
                  console.error('editor: the editor did not load', e)
                  settleEditorBoot('off')
                },
              )
            },
          )
        return
      }
      void import('@/editor/desk').then(
        (m) => {
          desk = m.createDesk(deskHost)
        },
        (err: unknown) => {
          editing = false
          console.error('editor: the editor did not load', err)
          settleEditorBoot('off') // DEV-471
        },
      )
    })
  }

  /**
   * The editor's frame, in place of the mission's; true when it ran. Called at
   * the top of `frame`, after the fade, so a transition out of the editor
   * fades over the editor's own picture.
   */
  const editorFrame = (time: number, frameSeconds: number): boolean => {
    if (!editing || ctx.screen !== 'mission') return false
    if (ctx.render.renderer.xr.isPresenting) {
      console.info('editor: a headset session began; the editor is flat only')
      editorLeave()
      return false
    }
    if (!desk) return false
    setMissionFurniture(false)
    if (deskResume !== undefined) {
      const result = deskResume
      deskResume = undefined
      desk.resume(result)
    }
    // DEV-491: back from a recording flight.
    if (deskRecorded !== undefined) {
      const recorded = deskRecorded
      deskRecorded = undefined
      desk.recorded(recorded)
    }
    if (document.body.dataset.editor !== 'editing') document.body.dataset.editor = 'editing'
    // Nothing the mission reads may be saved up for it: spend the latches.
    ctx.keyboard.read(frameSeconds, { invertPitch: ctx.comfort.invertPitch })
    ctx.touch.read({ invertPitch: ctx.comfort.invertPitch })
    ctx.mouseLook.setEnabled(false)
    ctx.mouseLook.readClick()
    ctx.mouseLook.readLostCapture() // DEV-563
    const camera = desk.frame(frameSeconds)
    camera.updateMatrixWorld()
    const eye = camera.getWorldPosition(_editorEye)
    // The world's upkeep, as the mission's frame does it, from the desk's eye.
    if (ctx.liveTerrain) {
      ctx.liveTerrain.terrain.updateLod(eye.x, eye.z, frameSeconds)
      ctx.liveTerrain.ocean?.updateLod(eye.x, eye.z, frameSeconds)
      ctx.liveTerrain.ocean?.setWaveTime(time / 1000, eye.y)
      ctx.liveTerrain.terrain.setWaveTime(time / 1000)
    }
    ctx.livePropsLive?.updateLod(camera, Math.min(frameSeconds, 0.1))
    ctx.liveDressing?.update(time / 1000)
    ctx.liveClouds?.update(time / 1000)
    ctx.cloudShadow.update() // DEV-585: the wind, after the clouds' own
    ctx.liveSky?.follow(eye)
    ctx.liveHorizonGeo?.update(eye)
    ctx.horizon.setVisible(false)
    ctx.sunShadows.update(camera)
    ctx.fog.update(camera)
    if (ctx.vignette.object.parent !== ctx.render.scene) ctx.render.scene.add(ctx.vignette.object)
    // DEV-476: the course's tint over the editor's picture, as the course will
    // fly it (its id is in no preset row, so the preset's `default` is under it).
    ctx.sceneTint.update(ctx.editionState.current.render.sceneTint, null, true, editorTint)
    ctx.seaReflection.update(ctx.render.scene, camera) // DEV-583: the desk's eye, as the frame below
    if (!ctx.bloom.render(ctx.render.scene, camera))
      ctx.render.renderer.render(ctx.render.scene, camera)
    // DEV-471: drawn over a built world, so a click on the ground lands now.
    if (ctx.liveTerrain && ctx.loading.state.phase === 'ready') settleEditorBoot('ready')
    return true
  }

  // ── DEV-471: `?edit=1` arrives by MAKE A COURSE's door ──────────────────
  //
  // The loading scene is asked for NOW, before the first frame, so the first
  // picture is the plate (boot released the curtain on `'none'`: the plate is
  // the stage). The desk's chunk loads while it stands, and then the island is
  // built behind it by the same switch MAKE A COURSE uses; the editor opens
  // when it lands (`settleEditorBoot`; the landing card that went at that
  // point is gone since DEV-557). `level` is the boot's own `?mission=` level, already
  // under the sun rule, which is idempotent (`render/sun-light-rule.ts`).
  if (EDIT_AT_BOOT) {
    const boot = withPreviewIsland(ctx.level) // DEV-489: `?island=`, preview builds only
    ctx.beginLoadingTarget(boot)
    ctx.loadingScenePending = true
    void (async () => {
      let built = boot
      // DEV-540 (`pnpm dev` only; folded away in a build): `?shipped=<id>`
      // builds that mission's world as 2016 shipped it, and never a player
      // draft's island over it. An id that is not a mission is said, and the
      // editor opens as `?edit=1` alone would.
      const shipped =
        import.meta.env.DEV && SHIPPED_AT_BOOT !== null
          ? await loadBaselineLevel(SHIPPED_AT_BOOT).catch((err: unknown) => {
              console.warn(`editor: ?shipped=${SHIPPED_AT_BOOT} is not a mission (DEV-540)`, err)
              return null
            })
          : null
      if (shipped) built = shipped
      else {
        try {
          const desks = await import('@/editor/desk')
          // DEV-490/493: over the last draft's own island when it stands on this
          // sky, so the world is built once rather than built and then swapped.
          const last = desks.lastDraftCourse()
          const g = last?.sky === boot.id ? await ctx.groundOfCourse(last).catch(() => null) : null
          if (g) built = withCustomGround(boot, g)
          // DEV-500: and the last draft's water, so the world is built once.
          if (last?.sky === boot.id && last.water) built = withCourseWater(built, last.water)
        } catch (err: unknown) {
          // `openEditor` says so and settles `off`; the island is still built.
          console.warn('editor: the desk chunk did not load', err)
        }
      }
      await ctx.switchMission(built.id, { skipRide: true, inLoadingScene: built })
      // Read while the plate still stands: the fade into the editor is
      // queued and its black, which takes the plate down, has not come.
      document.body.dataset.editorPlate = ctx.loadingScene.place ?? 'none'
      if (ctx.level.id === (shipped ?? boot).id) openEditor()
      else settleEditorBoot('off')
    })()
  }
  // ── end DEV-471 ─────────────────────────────────────────────────────────

  /** MAKE A COURSE has been pressed: the title is on its way out. */
  let makeAsked = false
  /**
   * The title's MAKE A COURSE (COURSES hub, desktop only): the island of the
   * last draft this browser kept — or the default course's, the first time —
   * built through Learn to Fly's door (one fade into the loading scene, then
   * the switch), and the editor opened over it when the switch lands.
   */
  const makeCourse = (): void => {
    // DEV-558: from the Custom Courses shelf, in the hangar (the title's COURSES
    // hub, moved). The world is built in the room, as a course is boarded there.
    if (makeAsked || ctx.switching || ctx.screen !== 'menu') return
    makeAsked = true
    // DEV-389: making a course is leaving a room a link joined.
    ctx.roomClose()
    void (async () => {
      try {
        const desks = await import('@/editor/desk')
        // DEV-489: `?island=` puts a preview ground under it (preview builds only).
        const sky = await loadLevel(desks.lastDraftSky() ?? MISSION)
        // DEV-490: over the last draft's own island when it has one, so the
        // world is built once; the desk asks again if this could not be.
        const lastGround = await (async () => {
          const last = desks.lastDraftCourse()
          return last?.sky === sky.id ? ctx.groundOfCourse(last).catch(() => null) : null
        })()
        const grounded = lastGround ? withCustomGround(sky, lastGround) : withPreviewIsland(sky)
        // DEV-500: and the last draft's water, so the world is built once.
        const lastWater = desks.lastDraftCourse()
        const next =
          lastWater?.sky === sky.id && lastWater.water
            ? withCourseWater(grounded, lastWater.water)
            : grounded
        console.info(`editor: making a course over ${next.id}`)
        await ctx.switchMission(next.id, { skipRide: true, level: next })
        // Spent either way: the shelf is in the room to press again later.
        makeAsked = false
        if (ctx.level.id === next.id) openEditor()
      } catch (err: unknown) {
        makeAsked = false
        console.error('editor: could not open the editor', err)
      }
    })()
  }
  return {
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
    get benchUp() {
      return benchUp
    },
    get editing() {
      return editing
    },
    get desk() {
      return desk
    },
    get editorSunBake() {
      return editorSunBake
    },
    get benchDoor() {
      return benchDoor
    },
    get benchDoorAimed() {
      return benchDoorAimed
    },
    get benchFlight() {
      return benchFlight
    },
    get bench() {
      return bench
    },
  }
}
