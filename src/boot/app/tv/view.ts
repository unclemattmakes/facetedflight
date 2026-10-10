// src/boot/app/tv/view.ts: Faceted Flight TV's camera and view, out of
// `bootApp`. APP-SPLIT phase 4 (`docs/plan/APP-SPLIT.md` §1b; plan/FF-TV.md).
//
// DEV-481's camera on a watched race (`boot/tv-watch-camera.ts`) and DEV-480's
// view (`game/tv/tv-view.ts`): the rooms offered, the view and whether TV is
// what is on. The exhibition and the on-screen panel (DEV-483, DEV-482) are
// `boot/app/tv/panel.ts`. Every line below was moved verbatim from the closure;
// the plumbing is `ctx.x` where the code reads a binding the closure still owns
// (a getter, and a setter where this code writes one: the §6 rule 3 bag), and
// the returned object.

import * as THREE from 'three'
import type { Edition } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import type { EditionState } from '@/game/edition'
import type { MissionState } from '@/game/mission'
import { loadMissionIndex, type MissionCard } from '@/game/mission-index'
import { quickRacePool } from '@/game/quick-race'
import { roomColourCss } from '@/game/remote-ships'
import { racerName } from '@/game/results-state'
import type { Exhibition, ExhibitionOptions } from '@/game/tv/exhibition'
import type { ExhibitionReport } from '@/game/tv/exhibition-view'
import { tvLiveFeed } from '@/game/tv/tv-live-feed'
import { createTvView } from '@/game/tv/tv-view'
import { watchUrl } from '@/game/watch-client'
import type { PointerArbiter } from '@/input/pointer-hand'
import type { ControlsDevice } from '@/render/controls-menu'
import type { Fade } from '@/render/fade'
import type { HangarArt } from '@/render/hangar'
import { readHeadPose, readHeadPosition } from '@/render/head-pose'
import type { Renderer } from '@/render/renderer'
import type { SurfaceHeightAt } from '@/render/spring-arm'
import type { TvPanelInput } from '@/render/tv-panel-layout'
import type { Vignette } from '@/render/vignette'
import type { XrPointer } from '@/render/xr-pointer'
import { createTvWatchCamera, type TvWatchCamera } from '../../tv-watch-camera'
import { TV_FOLLOW_AT_BOOT } from '../pins'
import type { createRoomCore } from '../room/core'
import type { createRoomWatch } from '../room/watch'
import type { createScreenRouter } from '../screen-router'
import type { WorldHandles } from '../world-handles'

/** What `createTv` reads from the closure: getters, each read live (APP-SPLIT §3's `ctx`). */
export interface TvCtx {
  readonly WATCH_ID: string | null
  readonly aimPlate: (
    o: THREE.Object3D<THREE.Object3DEventMap>,
    pick: (a: THREE.Vector3, b: THREE.Vector3) => number,
  ) => number
  readonly cardLifted: boolean
  readonly confirmDevice: () => ControlsDevice
  readonly editionState: EditionState
  readonly exhibition: {
    start: (options?: ExhibitionOptions) => Exhibition
    running: () => boolean
    tick: (dt: number) => boolean
    frame(dt: number, alpha?: number): void
    debug: {
      start: (options?: ExhibitionOptions) => ExhibitionReport
      stop: () => void
      probe: () => ExhibitionReport
    }
  }
  readonly fade: Fade
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
  readonly handles: WorldHandles
  readonly hangar: HangarArt | null
  readonly level: Level
  readonly menuEditionLoad: Promise<Edition>
  readonly mission: MissionState
  readonly pointerArbiter: PointerArbiter
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  quickRaceCards: Promise<MissionCard[]> | null
  readonly render: Renderer
  readonly restartRun: (opts?: { respawn?: boolean; raceLap?: boolean }) => void
  readonly roomClose: () => void
  readonly roomCore: ReturnType<typeof createRoomCore>
  readonly roomOpen: (id: string, opts?: { readonly existing?: boolean }) => void
  readonly roomWatch: ReturnType<typeof createRoomWatch>
  readonly router: ReturnType<typeof createScreenRouter>
  readonly surfaceHeightAt: SurfaceHeightAt
  readonly tvPanelCourse: (id: string | null) => string
  readonly tvPanelInput: TvPanelInput
  readonly vignette: Vignette
  readonly watchStart: (url: string, label: string, probed?: (_: number) => void) => void
  readonly watchStop: () => void
  readonly xrPointer: XrPointer
}

export const createTv = (ctx: TvCtx) => {
  const {
    WATCH_ID,
    editionState,
    handles,
    menuEditionLoad,
    render,
    roomClose,
    roomCore,
    roomOpen,
    roomWatch,
    watchStart,
    watchStop,
  } = ctx
  // ── DEV-481: TV's camera (plan/FF-TV.md §5.3; `boot/tv-watch-camera.ts`) ──
  // A headset gets the flat camera at launch (Matt, 2026-10-01); the comfort
  // cuts are `gameplay.tv.headsetCuts`, off. DEV-480 drives `tvWatch`.
  let tvWatchPresses = 0
  const _tvEye = new THREE.Vector3()
  const tvWatch: TvWatchCamera = createTvWatchCamera({
    canvas: render.renderer.domElement,
    rig: render.rig,
    camera: render.camera,
    presenting: () => render.renderer.xr.isPresenting,
    session: () => render.renderer.xr.getSession(),
    level: () => ctx.level,
    terrain: () => handles.liveTerrain,
    collisionHeightAt: (x, z) => ctx.surfaceHeightAt(x, z),
    props: () => handles.livePropColliders,
    ships: () => roomCore.roomShips,
    aim: (o, d) => {
      const hand = ctx.pointerArbiter.choose(ctx.xrPointer.posed)
      return hand !== null && ctx.xrPointer.ray(hand, render.rig, o, d) ? hand : null
    },
    beam: (hand, distance) =>
      ctx.xrPointer.show(
        hand,
        distance,
        readHeadPosition(render.renderer.xr, render.camera, _tvEye),
      ),
    followAtBoot: TV_FOLLOW_AT_BOOT,
    curtain: (black) => ctx.vignette.setFade(Math.max(ctx.fade.amount, black)),
    headsetCuts: () => roomCore.menuEdition?.gameplay.tv.headsetCuts.enabled === true,
    gaze: (q) => readHeadPose(render.renderer.xr, render.camera, _tvEye, q),
    // DEV-628: a plain click or tap follows the next racer, unless it is the plate's.
    tapsFollow: () => !tvView.plateUp(),
    // DEV-653: the marker over the followed racer, and its hull colour.
    scene: render.scene,
    colourOf: (n) =>
      handles.liveRacers?.racers.find((r) => racerName(r.spec) === n)?.spec.colour ?? null,
  })

  /** After the mission's own camera code: TV's camera places the rig (DEV-481). */
  const watchCamera = (dt: number): void => {
    if (!roomCore.watch || ctx.router.screen !== 'mission') return
    if (handles.flight) handles.flight.object.visible = false
    if (!roomWatch.watchEyeSet || roomWatch.watchTarget !== tvWatchPresses) {
      roomWatch.watchEyeSet = true
      tvWatchPresses = roomWatch.watchTarget
      tvWatch.press()
    }
    tvWatch.frame(dt)
    roomWatch.watchTargetName = tvWatch.report()?.following ?? null
  }

  /**
   * DEV-441: does this build have rooms? The MENU's edition says (Anniversary,
   * as the build ships it: a release build's has them off), never the edition
   * the player chose — a room races Anniversary for everyone. At once where
   * that preset is already in hand (every title boot, and any boot that chose
   * Anniversary); otherwise when it lands.
   */
  const roomsOffered = (then: (on: boolean) => void): void => {
    if (roomCore.menuEdition) then(roomCore.menuEdition.gameplay.rooms.enabled)
    else
      void menuEditionLoad.then(
        (e) => then(e.gameplay.rooms.enabled),
        () => then(false),
      )
  }

  // A `?watch=` link: the broadcaster at boot, where the build has rooms.
  if (WATCH_ID !== null && roomCore.roomId === null) {
    roomsOffered((on) => {
      if (!on) {
        console.warn('watch: this build has no rooms; ignoring the link')
        return
      }
      watchStart(watchUrl(WATCH_ID, globalThis.location), WATCH_ID)
    })
  }

  // A `?room=` link joins at boot, where the build has rooms (a build without
  // them ignores the link and says so; since DEV-470 a release build has them).
  if (roomCore.roomId !== null) {
    const linked = roomCore.roomId
    roomsOffered((on) => {
      if (on) roomOpen(linked)
      else {
        console.warn('room: this build has no rooms; ignoring the link')
        if (roomCore.roomId === linked && !roomCore.room) roomCore.roomId = null
      }
    })
  }
  // ── end DEV-388 ──────────────────────────────────────────────────────────

  // ══ DEV-480: Faceted Flight TV, `game/tv/tv-view.ts` (plan/FF-TV.md) ══
  const tvOn = (): boolean => roomCore.menuEdition?.gameplay.tv.enabled ?? false
  const tvView = createTvView({
    on: tvOn,
    ready: () => ctx.cardLifted && roomCore.menuEdition !== null,
    screen: () => ctx.router.screen,
    startExhibition: (o) => ctx.exhibition.start(o),
    courses: async () => {
      ctx.quickRaceCards ??= loadMissionIndex()
      return quickRacePool(await ctx.quickRaceCards).map((c) => c.id)
    },
    render,
    watchStart,
    watchStop,
    watch: () => roomCore.watch,
    camera: () => tvWatch.camera,
    cameraReport: () => tvWatch.report(),
    press: () => {
      roomWatch.watchTarget++
      roomWatch.watchEyeSet = false
    },
    leaveRoom: () => roomClose(),
    hideFlight: (h) => {
      if (handles.flight) handles.flight.object.visible = !h
    },
    // DEV-558: onto the first step, where the FF-TV table stands.
    toHangar: () =>
      ctx.goToScreen('menu', {
        act: () => {
          ctx.restartRun()
          ctx.hangar?.showDoors()
        },
      }),
    aim: (o, pick) => ctx.aimPlate(o, pick),
    rayAt: (x, y) => ctx.glassRay(x, y),
    // DEV-482's panel: a live race's feed from the watch, Racer N only.
    panel: (live, lobbies) => {
      ctx.tvPanelInput.lobbies = lobbies
      const s = live && roomCore.watch ? roomCore.watch.watch.session : null
      ctx.tvPanelInput.live = s
        ? tvLiveFeed(s, roomCore.roomShips?.drawn() ?? [], {
            racers: live?.racers ?? null,
            linkFollows: live?.linkFollows ?? null,
            lobbies,
            course: ctx.tvPanelCourse(s.race?.mission ?? null),
            gates: ctx.mission.course.gates.length,
            colourOf: (i) => roomColourCss(editionState.current.render.racerLivery, i),
            report: tvWatch.report(),
          })
        : null
    },
  })
  const tvActive = (): boolean => tvView.active()
  // ══ end DEV-480 ══
  return {
    tvOn,
    tvView,
    tvActive,
    tvWatch,
    watchCamera,
  }
}
