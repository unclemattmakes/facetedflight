// src/boot/app/world/switch.ts: change course without leaving the page, out of
// `bootApp`. APP-SPLIT phase 4, slice 7 (world; `docs/plan/APP-SPLIT.md` §5).
//
// `switchMission` (the level first, then the teardown, the edition's black,
// the new level's light, sky, fog, boundary and launch, the build, the run's
// reset and the fade onto the pad) and Quick Race's route into it (DEV-353,
// DEV-565). Every line below was moved verbatim from the closure; the plumbing
// is `ctx.x` where the code reads a binding the closure still owns (a getter,
// and a setter where the switch writes one: `level`, `fog`, the course specs,
// the launch, the crash and its curtain, the world promise and the Quick Race
// state. That is the §6 rule 3 bag, and it is the widest one in the split:
// these are the bindings phase 3's owners take, and they come off this list
// as they do), and the returned object.

import { loadingPlaceFor } from '@/boot/load-place'
import type { EditionId } from '@/content/edition-schema'
import type { GameMode, Level } from '@/content/level-schema'
import { loadLevel } from '@/content/load-level'
import type { RacingGuide } from '@/game/course-specs'
import type { EditionState } from '@/game/edition'
import type { Flight } from '@/game/flight'
import type { LoadedGhosts } from '@/game/ghosts'
import { type MissionState, startMission } from '@/game/mission'
import { loadMissionIndex, type MissionCard } from '@/game/mission-index'
import { runningMode } from '@/game/modes'
import type { ParticleFx } from '@/game/particle-fx'
import { pickQuickRace, quickRacePool } from '@/game/quick-race'
import type { LoadedRings } from '@/game/rings'
import type { LoadedTerrain } from '@/game/terrain/load-terrain'
import type { LoadedTurnIndicators } from '@/game/turn-indicators'
import type { SharedLap } from '@/net/lap-client'
import type { YourCourses } from '@/render/course-shelf'
import { type Fade, LOAD_FADE_SECONDS } from '@/render/fade'
import type { HangarArt } from '@/render/hangar'
import type { LoadingPlace } from '@/render/loading-scene'
import type { Renderer } from '@/render/renderer'
import type { Sky } from '@/render/sky'
import { withSunLightRule } from '@/render/sun-light-rule'
import type { UnityFog } from '@/render/unity-fog'
import type { BoundaryState } from '@/sim/boundary'
import { type BoundarySpec, createBoundary } from '@/sim/boundary'
import type { CrashState } from '@/sim/crash'
import { createCrash } from '@/sim/crash'
import type { HoverJetSheet } from '@/sim/hoverjet'
import type { LaunchState } from '@/sim/launch'
import { createLaunch, type LaunchSpec } from '@/sim/launch'
import type { Route } from '@/sim/route'
import { applyLighting, applySky, type createSun } from '../lighting'
import { AMBIENT_SOURCE, SUN_LIGHT_RULE } from '../pins'
import type { createResults } from '../results'
import type { createLoadingHost } from './loading'

/** What `createWorldSwitch` reads from the closure: getters, each read live (APP-SPLIT §3's `ctx`). */
export interface WorldSwitchCtx {
  readonly MODE_REQUEST: () => GameMode | undefined
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  RUNNING_MODE: GameMode
  readonly beginLoadingTarget: (target: Level) => void
  readonly boardLinkGhost: (lap: SharedLap) => Promise<string>
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  boundary: BoundaryState
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  boundarySpec: BoundarySpec | null
  readonly buildWorld: () => Promise<{
    terrain: LoadedTerrain
    ocean: LoadedTerrain | null
    rings: LoadedRings
    turnIndicators: LoadedTurnIndicators
    particleFx: ParticleFx
    flight: Flight
    ghosts: LoadedGhosts
  }>
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  crash: CrashState
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  crashCurtain: boolean
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  crashLine: { route: Route; gateArc: readonly number[] }
  readonly editionState: EditionState
  readonly editionWorn: Promise<void>
  readonly fade: Fade
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  fog: UnityFog
  readonly goToScreen: (
    to: 'menu' | 'mission' | 'title',
    opts?: {
      readonly outSeconds?: number
      readonly inSeconds?: number
      readonly holdSeconds?: number
      readonly act?: () => void
    },
  ) => void
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  guide: RacingGuide | null
  readonly hangar: HangarArt | null
  readonly hideLoadingScene: () => void
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  launch: LaunchState
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  launchSpec: LaunchSpec | null
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  level: Level
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  liveSky: Sky | null
  readonly loadingHost: ReturnType<typeof createLoadingHost>
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  loadingScenePending: boolean
  readonly makeBoundarySpec: () => BoundarySpec | null
  readonly makeCrashLine: () => { route: Route; gateArc: readonly number[] }
  readonly makeGuide: (sheet?: HoverJetSheet | undefined) => RacingGuide | null
  readonly makeLaunchSpec: () => LaunchSpec | null
  readonly mission: MissionState
  readonly missionEdition: () => EditionId
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  missionSun: ReturnType<typeof applyLighting>
  readonly pageSun: ReturnType<typeof createSun>
  readonly pendingScreen: { to: 'title' | 'menu' | 'mission'; act: (() => void) | null } | null
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  quickRace: { readonly id: string; readonly pressedAt: number; launched: boolean } | null
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  quickRaceAsked: boolean
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  quickRaceCards: Promise<MissionCard[]> | null
  readonly render: Renderer
  readonly restartRun: (opts?: { respawn?: boolean; raceLap?: boolean }) => void
  readonly results: ReturnType<typeof createResults>
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  rideSpec: LaunchSpec | null
  readonly screen: 'title' | 'menu' | 'mission'
  readonly screenSettled: () => Promise<void>
  readonly showLoadingScene: (place?: LoadingPlace) => void
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  switching: boolean
  readonly teardownWorld: () => Promise<void>
  readonly watchWorld: (p: Promise<unknown>) => void
  readonly wearEdition: (where: 'menus' | 'mission') => void
  readonly wiredMissionFog: (l: Level) => UnityFog
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  world: Promise<World> | null
  readonly yourCourses: YourCourses
}

/** The world `buildWorld` resolves to (the closure's `World`). */
export type World = Awaited<ReturnType<WorldSwitchCtx['buildWorld']>>

export const createWorldSwitch = (ctx: WorldSwitchCtx) => {
  const switchMission = async (
    id: string,
    opts: {
      readonly skipRide?: boolean
      /**
       * The level, already loaded, with the player already on their way into
       * the loading scene — Quick Race's route (DEV-353 follow-up), which took
       * them there itself, from the title, behind ONE fade. Skips the fetch
       * and the fade into the loading scene; everything after is the swap.
       */
      readonly inLoadingScene?: Level
      /**
       * DEV-558: the level, already loaded, boarded from the ROOM like any
       * table's course: a player course opened from a file, or the editor's
       * island, from the Custom Courses shelf. Skips the fetch (`loadLevel`
       * cannot resolve them) and nothing else.
       */
      readonly level?: Level
    } = {},
  ): Promise<void> => {
    if (ctx.switching) return
    ctx.switching = true
    // ── the swap, from outside the page (DEV-281) ───────────────────────
    //
    // `data-terrain-ready` goes away inside `teardownWorld`, which is behind a
    // `loadLevel` fetch — so between the press and that delete there is a
    // window in which the attribute still describes the world being replaced.
    // Harmless while boot built every world it would ever need; now that the
    // FIRST selection is a load, it is the difference between a spec waiting
    // for the island and a spec reading the answer from before it asked.
    //
    // Set synchronously, at the top, so the window closes at the press rather
    // than at the fetch. `tests/e2e/fixtures/hangar.ts` waits on the pair.
    document.body.dataset.switching = 'true'
    ctx.hangar?.setBusy('LOADING')
    /** True once the fade into the cockpit is queued; its black clears the attribute. */
    let boarded = false
    /**
     * DEV-465: waited out IN the room — the plate up in it, no fade until the
     * one to the pad. Decided once the level is in hand, which is the moment
     * the plate goes up (`boot/load-place.ts` has the rule and why a Classic
     * LOOK keeps the loading scene: its flip needs a black, and the room never
     * wears Classic).
     */
    let inRoom = false
    try {
      // Before the teardown, deliberately. See above.
      const next =
        opts.inLoadingScene ?? opts.level ?? ctx.yourCourses.levelOf(id) ?? (await loadLevel(id))
      // DEV-355: out of the room and into the loading scene, behind a fade.
      // Not awaited: the teardown runs under the fade, and the slices keep it
      // animating. Quick Race has already done both (`startQuickRace`).
      inRoom =
        loadingPlaceFor({
          screen: ctx.screen,
          moving: ctx.pendingScreen !== null,
          roomUp: ctx.hangar?.object.visible === true,
          bound: opts.inLoadingScene !== undefined,
          worn: ctx.editionState.current.id,
          mission: ctx.missionEdition(),
        }) === 'room'
      if (!opts.inLoadingScene) {
        ctx.beginLoadingTarget(next)
        // DEV-465: in the room, in place and at once — nothing moves but the
        // tables, so nothing needs a black. The look is already the mission's
        // (that is the rule's last clause), so the flip below is a no-op.
        if (inRoom) ctx.showLoadingScene('room')
        else ctx.goToScreen('menu', { act: ctx.showLoadingScene })
      }
      await ctx.teardownWorld()
      // DEV-451: the world is built under the edition it will be FLOWN in,
      // which the swap puts on at the black into the loading scene
      // (`wearEditionFor`). So the build waits for that black, and for the
      // flip it started. A switch that got no black of its own (a transition
      // already queued ate the fade) flips here rather than build a world
      // under the menus' edition.
      await ctx.screenSettled()
      if (ctx.editionState.current.id !== ctx.missionEdition()) ctx.wearEdition('mission')
      await ctx.editionWorn

      // DEV-454: the sun rule at the one door every reader of the sun sits behind.
      ctx.level = withSunLightRule(next, SUN_LIGHT_RULE)
      ctx.RUNNING_MODE = runningMode(ctx.level, ctx.MODE_REQUEST())
      Object.assign(ctx.mission, startMission(ctx.level, ctx.MODE_REQUEST()))
      ctx.missionSun = applyLighting(ctx.render.scene, ctx.level, ctx.pageSun, AMBIENT_SOURCE)
      ctx.liveSky = applySky(
        ctx.render.renderer,
        ctx.render.scene,
        ctx.level,
        ctx.editionState.current.render.smoothSky.enabled,
      )
      ctx.fog = ctx.wiredMissionFog(ctx.level)
      ctx.boundary = createBoundary()
      ctx.boundarySpec = ctx.makeBoundarySpec()
      ctx.launchSpec = ctx.makeLaunchSpec()
      // A Quick Race arrives with the ride already SPENT (DEV-353): the same
      // spec every retry gets (`beginLaunch`, DEV-094), handed over before the
      // first launch rather than after it. `createLaunch` then stands the
      // platform at the top from the first frame, which is where
      // `LaunchElevator.FinishLaunch()` leaves it: held on the deck until the
      // countdown lets go, then flown with gravity off. The hangar's own swap
      // passes nothing and rides.
      ctx.rideSpec =
        opts.skipRide && ctx.launchSpec ? { ...ctx.launchSpec, skipRide: true } : ctx.launchSpec
      ctx.launch = createLaunch(ctx.rideSpec)
      if (!ctx.launchSpec) ctx.launch.phase = 'flying'

      ctx.world = ctx.buildWorld()
      ctx.watchWorld(ctx.world)
      await ctx.world
      // `guide` reads `mission.course.gates`, which `buildWorld` fills.
      ctx.guide = ctx.makeGuide()
      ctx.crashLine = ctx.makeCrashLine()
      // A new course is a new run: no hold carried over, no curtain left down.
      ctx.crash = createCrash()
      if (ctx.crashCurtain) {
        ctx.crashCurtain = false
        ctx.fade.release()
      }

      // The room should open on where you now are, the next time you see it.
      // DEV-465: at the black, when you are waiting IN it: `setCurrent`
      // re-lays the step, and a re-lay rebuilds every table's island in view.
      if (!inRoom) ctx.hangar?.setCurrent(ctx.level.id)
      // `respawn: false` — the new ship is already where a boot would leave it.
      ctx.restartRun({ respawn: false })
      console.info(`level select: now flying ${ctx.level.id}`)
      // Straight onto the pad, which is 2016's shape: you choose in
      // `setGameplayOptions` and the mission scene loads with you in it.
      //
      // The fade goes HERE and not at the press, which is a deliberate reading
      // of `docs/plan/LOADING.md`: L5 wants the room lit and counting while the
      // world builds, and L2 wants the cut covered. Both, in that order — you
      // wait in a lit room, and then the room fades to the cockpit. Black over
      // a four-second load with a progress counter you cannot see behind it
      // would be worse than the hard cut it replaces.
      //
      // DEV-355 kept both halves and moved the first: the lit place you wait in
      // is the loading scene now, and it is what fades to the cockpit.
      await ctx.screenSettled()
      // `data-switching` goes when you are ABOARD — at the black of this fade,
      // when the screen becomes the mission — and not when it is queued. The
      // difference was nothing while the build froze the thread: the first
      // frame after a 3.4 s task had a 3.4 s delta, the fade-out ran in one
      // step, and the cut was immediate. With the frames flowing it takes its
      // 0.35 s, and `board()` and `completion.spec.ts` read the attribute as
      // "you are on the pad".
      ctx.goToScreen('mission', {
        inSeconds: LOAD_FADE_SECONDS,
        act: () => {
          ctx.hideLoadingScene()
          // DEV-465: the room, put back behind the black — its step re-laid on
          // the course you are now flying, and its presses taken again.
          if (inRoom) {
            ctx.hangar?.setBusy(null)
            ctx.hangar?.setCurrent(ctx.level.id)
          }
          delete document.body.dataset.switching
        },
      })
      boarded = true
    } catch (error) {
      console.error(`level select: could not switch to ${id}`, (error as Error)?.stack ?? error)
      document.body.dataset.terrainError = String((error as Error)?.message ?? error)
      // Back to the room, which is where a failed switch has always left you.
      // DEV-465: and when it was waited out in the room, you never left it.
      if (ctx.loadingHost.loadingTarget && inRoom) ctx.hideLoadingScene()
      else if (ctx.loadingHost.loadingTarget) {
        await ctx.screenSettled()
        ctx.goToScreen('menu', { act: ctx.hideLoadingScene })
      }
      // A Quick Race that never arrived has nothing left to start (DEV-353).
      if (ctx.quickRace?.id === id) ctx.quickRace = null
    } finally {
      ctx.loadingHost.loadingTarget = null
      ctx.loadingHost.loadingNames = null
      ctx.switching = false
      if (!boarded) delete document.body.dataset.switching
      // DEV-465: a room waited in stays busy until the black (the act above),
      // so no press lands on it while it fades.
      if (!(inRoom && boarded)) ctx.hangar?.setBusy(null)
    }
  }

  /**
   * Quick Race, from the title (DEV-353). Matt: *"want to fly within 20
   * seconds"*, and in chat: *"a random HoverJet Ring Attack course, and skip
   * the ride."*
   *
   * The course is drawn from the level index by its own vehicle and running
   * mode (`game/quick-race.ts`), and the route there is the hangar's own swap
   * with two differences: `skipRide`, and `inLoadingScene` — the title takes
   * the player straight into DEV-355's loading scene behind ONE fade, rather
   * than to the hangar and then on. So the player waits where every course
   * change waits, in the loading scene, counting, rather than in a black
   * screen, and the world is built by the one function that builds worlds.
   *
   * Then the countdown starts without a press, once the fade into the cockpit
   * has cleared (the frame loop, below the confirm handler): the press on the
   * title WAS the launch press. `data-quick-race-ms` is the press-to-release
   * time, which is the number the row is judged by.
   *
   * **DEV-558: Quick Race is not a row any more.** The title is START and
   * ENTER VR (Matt, 2026-10-01). The one row that still takes this route is a
   * shared lap's RACE A GHOST (DEV-373), which boards that lap's course; the
   * random draw below is what the route did for the old row, kept because the
   * route is one function.
   *
   * **DEV-565: and the hangar's QUICK RACE table takes it again** (Matt,
   * 2026-10-02: *"add quick race as a 4th table"*), from the ROOM: the draw
   * above, then the room's own board with the ride spent (`switchMission`'s
   * `skipRide`, as TV's exhibition boards), waited out where any table's
   * course is (DEV-465), and the countdown by itself as before. A link's lap
   * is the title row's; the table always draws.
   */
  const startQuickRace = (): void => {
    // Once. The draw below resolves on a promise, so a second press landing
    // before it would otherwise draw a SECOND course while the first one's
    // swap was already queued — and the countdown waits on the id it drew.
    if (ctx.quickRaceAsked || ctx.switching) return
    ctx.quickRaceAsked = true
    const fromRoom = ctx.screen === 'menu'
    const pressedAt = performance.now()
    ctx.quickRaceCards ??= loadMissionIndex()
    const theLongWay = (): void => {
      // DEV-565: from the room, the room IS the long way; the table is pressable again.
      if (fromRoom) ctx.quickRaceAsked = false
      else ctx.goToScreen('menu', { act: () => console.info('title: starting') })
    }
    void (async () => {
      try {
        const cards = await (ctx.quickRaceCards ?? loadMissionIndex())
        // DEV-373: a link's lap boards ITS course, preset and aircraft.
        const id =
          ctx.results.linkGhost && !fromRoom
            ? await ctx.boardLinkGhost(ctx.results.linkGhost)
            : pickQuickRace(quickRacePool(cards), Math.random)
        if (id === null) {
          // Nothing in the content keeps the promise. Say so and go the long way.
          console.warn('quick race: the index holds no HoverJet Ring Attack course')
          theLongWay()
          return
        }
        if (fromRoom) {
          // DEV-565: the room's own board, as a table's course is boarded.
          ctx.quickRace = { id, pressedAt, launched: false }
          document.body.dataset.quickRace = id
          console.info(`quick race: ${id}, from the hangar`)
          void switchMission(id, { skipRide: true }).finally(() => {
            ctx.quickRaceAsked = false
          })
          return
        }
        // ── ONE fade, title to loading scene (DEV-353 follow-up) ──────────
        //
        // This used to fade to the hangar and call `switchMission` at the
        // black, and since DEV-355 `switchMission` fades AGAIN, into its
        // loading scene — so the room could come up between the two. Now the
        // level is fetched here, BEFORE the fade, and at its black the loading
        // scene is asked for and the swap told it is already there.
        //
        // The scene is SHOWN a few lines later in the same frame, not in the
        // act: `showLoadingScene` stands the scene where the head is, and at
        // the act the rig is still at the title's eye, 30 km from the room.
        // The menu branch of the frame loop parks it in the chair and then
        // shows the scene (`loadingScenePending`), all before that frame
        // draws, and that frame is black.
        const next = await loadLevel(id)
        ctx.quickRace = { id, pressedAt, launched: false }
        document.body.dataset.quickRace = id
        console.info(`quick race: ${id}`)
        ctx.goToScreen('menu', {
          act: () => {
            ctx.beginLoadingTarget(next)
            ctx.loadingScenePending = true
            // DEV-565: spent once the swap is over, so the hangar's QUICK RACE
            // table is pressable when a run comes back to the room.
            void switchMission(id, { skipRide: true, inLoadingScene: next }).finally(() => {
              ctx.quickRaceAsked = false
            })
          },
        })
      } catch (err: unknown) {
        console.error('quick race: could not pick or load a course; taking the long way', err)
        theLongWay()
      }
    })()
  }
  return {
    switchMission,
    startQuickRace,
  }
}
