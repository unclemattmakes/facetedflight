// src/boot/app/world/loading.ts: where you stand while a course loads, out of
// `bootApp`. APP-SPLIT phase 4, slice 7 (world; `docs/plan/APP-SPLIT.md` §5).
//
// DEV-355's loading scene and its plate (the emblem, DEV-434; the primer,
// DEV-465), the plate's words and where it stands, `screenSettled`, and the
// room's busy line (L5, DEV-107). The block's header comment stays in the
// closure above the call, beside the one line that cannot move: the MENUS'
// preset is awaited there (`menuRender`), and an `await` is the closure's.
// Every line below was moved verbatim from the closure; the plumbing is
// `ctx.x` where the code reads a binding the closure still owns (a getter, so a
// check narrows as the closure's `let` did), and the returned object, which
// hands the closure what it still calls and reads.

import * as THREE from 'three'
import { busyText, type LoadProgress, type LoadState, plateText } from '@/boot/load-progress'
import { assetUrl } from '@/content/asset-url'
import type { EditionRender } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import { cardFor, environmentDisplayName } from '@/game/mission-index'
import type { HangarArt } from '@/render/hangar'
import { headForward, readHeadPose } from '@/render/head-pose'
import { loadMesh } from '@/render/load-mesh'
import {
  createLoadingScene,
  type LoadingPlace,
  type LoadingText,
  plateElevation,
  yawFacing,
} from '@/render/loading-scene'
import type { Renderer } from '@/render/renderer'

/** What `createLoadingHost` reads from the closure: getters, each read live (APP-SPLIT §3's `ctx`). */
export interface LoadingHostCtx {
  readonly hangar: HangarArt | null
  readonly loading: LoadProgress
  readonly menuRender: EditionRender
  readonly menuScene: THREE.Scene<THREE.Object3DEventMap>
  readonly pendingScreen: { to: 'title' | 'menu' | 'mission'; act: (() => void) | null } | null
  readonly render: Renderer
  readonly switching: boolean
}

export const createLoadingHost = (ctx: LoadingHostCtx) => {
  const loadingScene = createLoadingScene({
    tone:
      ctx.menuRender.toneMapping === 'aces' || ctx.menuRender.toneMapping === 'none'
        ? { curve: ctx.menuRender.toneMapping, exposure: ctx.menuRender.exposure }
        : undefined,
  })
  ctx.menuScene.add(loadingScene.object)
  // DEV-465: the plate's programs, compiled by the room's own frames (zero-area
  // triangles in its materials), so a load waited out IN the room shows the
  // plate without linking a program in view.
  ctx.menuScene.add(loadingScene.primer)
  // DEV-434: the plate's spinner is the title's emblem, small, centred over the
  // plate, the wordmark still and the emblem turning. Its own copy of the logo,
  // like the medals' (DEV-113), so the plate never waits on the title; the
  // scene copies what it draws and the load is freed. A missing logo keeps the
  // gem as the mark, which turns just the same.
  void loadMesh(assetUrl('assets/props/title-logo.glb'))
    .then((loaded) => {
      loadingScene.emblem(loaded.object)
      loaded.dispose()
    })
    .catch((error: unknown) => {
      console.warn('loading scene: no emblem, the logo mesh is unavailable —', error)
    })
  /** The course the loading scene is showing, or null when it is not up. */
  let loadingTarget: Level | null = null
  /** Its names, read once per switch: the readout ticks per chunk. */
  let loadingNames: { kicker: string; title: string; place: string } | null = null
  /** Whether THIS switch's build has restarted the readout yet. */
  let loadingLive = false
  /**
   * The course the plate names, for `__ff2.loading()` (DEV-465). Kept until the
   * plate comes DOWN, which on the way to the pad is a fade after
   * `loadingTarget` is cleared.
   */
  let plateCourse: string | null = null
  const beginLoadingTarget = (target: Level): void => {
    const card = cardFor(target)
    loadingTarget = target
    plateCourse = target.id
    loadingLive = false
    loadingNames = {
      kicker: `${card.vehicleName} · ${card.modeName} · ${card.difficultyName}`,
      title: card.title,
      place: environmentDisplayName(target.environment),
    }
  }
  /**
   * The plate's words. Until the build restarts the readout it still describes
   * the LAST world — "Ready", or another place — so until then the plate says
   * the opening line; after, it follows the readout to its own "Ready".
   */
  const loadingText = (state: LoadState): LoadingText => {
    const names = loadingNames ?? { kicker: '', title: '', place: state.place }
    if (state.place === names.place && state.phase !== 'ready') loadingLive = true
    return {
      kicker: names.kicker,
      title: names.title,
      status: loadingLive ? plateText(state) : `Loading ${names.place}…`,
      fraction: !loadingLive ? 0 : state.phase === 'terrain' ? state.fraction : null,
    }
  }
  const _loadEye = new THREE.Vector3()
  const _loadQuat = new THREE.Quaternion()
  const _loadAhead = new THREE.Vector3()
  /**
   * Stand the plate where the head is looking: in the loading scene, the room
   * hidden (DEV-355), or in the ROOM itself (DEV-465), the room left up with
   * every table but the chosen course's put by (`HangarArt.focus`).
   */
  const showLoadingScene = (place: LoadingPlace = 'scene'): void => {
    // The HEAD, not the rig: in a session they differ by wherever you are
    // leaning, and the plate belongs in front of your eyes, once.
    readHeadPose(ctx.render.renderer.xr, ctx.render.camera, _loadEye, _loadQuat)
    headForward(_loadQuat, _loadAhead)
    loadingScene.show(
      _loadEye,
      yawFacing(_loadAhead, ctx.render.rig.rotation.y),
      plateElevation(_loadAhead, place),
      loadingText(ctx.loading.state),
      place,
    )
    if (place === 'room') ctx.hangar?.focus(loadingTarget?.id ?? null)
    else if (ctx.hangar) ctx.hangar.object.visible = false
  }
  const hideLoadingScene = (): void => {
    if (loadingScene.place === 'room') ctx.hangar?.focus(null)
    loadingScene.hide()
    if (ctx.hangar) ctx.hangar.object.visible = true
  }
  /**
   * Resolve once no screen change is queued. `goToScreen` IGNORES a second
   * call while one is pending, so the fade into the cockpit must wait for the
   * fade into the loading scene to have made its swap — on a fast load it
   * otherwise vanishes and you stay in the loading scene with a world ready.
   */
  const screenSettled = async (): Promise<void> => {
    while (ctx.pendingScreen !== null) await new Promise<void>((resolve) => setTimeout(resolve, 16))
  }

  /**
   * The room says how far the swap has got (L5, DEV-107).
   *
   * Subscribed once rather than per swap — `subscribe` fires on every change,
   * which is once per terrain chunk, and a listener added and dropped per swap
   * would be a leak waiting for the first person who forgets the second half.
   * The `switching` guard is what stops it writing over the header during the
   * boot build, when nobody is in the room to read it.
   */
  ctx.loading.subscribe((state: LoadState) => {
    if (!ctx.switching) return
    ctx.hangar?.setBusy(busyText(state))
    if (loadingTarget && loadingScene.shown) {
      loadingScene.update(loadingText(state))
    }
  })
  return {
    loadingScene,
    beginLoadingTarget,
    showLoadingScene,
    screenSettled,
    hideLoadingScene,
    get loadingTarget() {
      return loadingTarget
    },
    set loadingTarget(v: Level | null) {
      loadingTarget = v
    },
    get loadingNames() {
      return loadingNames
    },
    set loadingNames(v: { kicker: string; title: string; place: string } | null) {
      loadingNames = v
    },
    get plateCourse() {
      return plateCourse
    },
  }
}
