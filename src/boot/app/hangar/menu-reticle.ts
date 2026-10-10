// src/boot/app/hangar/menu-reticle.ts: the menus' reticle, out of `bootApp`.
// APP-SPLIT phase 4, slice 6 (hangar and menus; `docs/plan/APP-SPLIT.md` §5).
//
// DEV-572's block, whole. Every line below was moved verbatim from the
// closure; the plumbing is `ctx.x` where the code reads a binding the closure
// still owns (a getter, so a check narrows as the closure's `let` did), and
// the returned object, which hands the closure what it still calls.

import * as THREE from 'three'
import type { Flight } from '@/game/flight'
import type { MouseLook } from '@/input/look'
import type { Fade } from '@/render/fade'
import type { HangarArt } from '@/render/hangar'
import { headForward, readHeadPose } from '@/render/head-pose'
import type { LoadingScene } from '@/render/loading-scene'
import { createMenuReticle, REST_DISTANCE, type ReticleLayer } from '@/render/menu-reticle'
import type { Pause, PauseOption, PausePage } from '@/render/pause'
import type { Renderer } from '@/render/renderer'
import type { XrPointer } from '@/render/xr-pointer'
import { planeHitDistance } from '@/render/xr-pointer'
import type { createEditorHost } from '../editor-host'
import type { TitleOptionsPlate } from '../title/options-plate'
import type { createLetterPlate } from './letter-plate'

/** What `createMenuReticleHost` reads from the closure: getters, each read live (APP-SPLIT §3's `ctx`). */
export interface MenuReticleCtx {
  readonly codeUp: () => boolean
  readonly editorHost: ReturnType<typeof createEditorHost>
  readonly fade: Fade
  readonly flight: Flight | null
  readonly glassRay: (x: number, y: number) => THREE.Ray | null
  readonly hangar: HangarArt | null
  readonly letterPlate: ReturnType<typeof createLetterPlate>
  readonly loadingScene: LoadingScene
  readonly lobbyPlate: Pause | null
  readonly lobbyRows: readonly PauseOption[]
  readonly lobbyUp: () => boolean
  readonly mouseLook: MouseLook
  readonly pausePlate: () => PausePage
  readonly paused: boolean
  readonly render: Renderer
  readonly screen: 'title' | 'menu' | 'mission'
  readonly titleMenu: Pause | null
  readonly titleMenuUp: () => boolean
  /** DEV-882: the title's OPTIONS plate, and whether the pages are up on it. */
  readonly titleOptions: TitleOptionsPlate
  readonly optionsUp: () => boolean
  readonly titleRows: () => readonly PauseOption[]
  readonly xrPointer: XrPointer
}

export const createMenuReticleHost = (ctx: MenuReticleCtx) => {
  // ── DEV-572: the menus' reticle ──────────────────────────────────────────
  //
  // Matt, 2026-10-02: *"we could use a reticle for the menus (triangle to stick
  // with our polygonal theme?)"*. `render/menu-reticle.ts` is the triangle, and
  // says why it compiles nothing and why it never hides a table's words. This
  // is where it goes: once a frame, just before the draw, AFTER every menu has
  // aimed, so it reads what the frame decided rather than deciding it again.
  //
  // It marks the point that SELECTS:
  //   * a hand that points (DEV-321): the laser draws the triangle at its own
  //     end and this one is put away, so there is never more than one mark;
  //   * flat, the cursor FREE and over something a click would press (a row of
  //     the title or the pause plate, a key of the letter plate): the CURSOR,
  //     because that is where the press lands;
  //   * otherwise the HEAD (the screen centre flat, the gaze in a headset), on
  //     a table or a page plate in the room, a row of the title, the pause
  //     plate, the lobby or the letter plate.
  // In the room the nose picks the tables whether or not the cursor is free (a
  // free click there is the capture, `input/look.ts`), so the room's mark is
  // always the nose's. On nothing it stays up, dim, only where the nose is what
  // aims: the room, a headset, a captured pointer. A free cursor beside the
  // title's or the pause plate's rows is the cursor's own business, and a dim
  // triangle in the middle of the valley would be clutter.
  const menuReticle = createMenuReticle()
  ctx.render.rig.add(menuReticle.object)
  /** Where the FREE cursor last stood, client px; null while captured or before it moved. */
  let menuCursor: { readonly x: number; readonly y: number } | null = null
  const _reticleEye = new THREE.Vector3()
  const _reticleQuat = new THREE.Quaternion()
  const _reticleDirection = new THREE.Vector3()
  /** `reticlePlate`'s answer, refilled every call (trap 19: read it inside the frame). */
  const reticleOn = { distance: 0, row: false, cursor: false }
  /**
   * The plate that is up, and where a ray meets it: true and `reticleOn`
   * filled, or false when no plate is up. One at a time, in the order they
   * stand over each other: the letter plate over the lobby, either over the
   * room; the title's rows; the pause plate. `cursor` is whether a free
   * cursor's click on a row of it presses (`setCursorTarget`'s slots: the
   * lobby has none).
   */
  const reticlePlate = (o: THREE.Vector3, d: THREE.Vector3): boolean => {
    let object: THREE.Object3D | null = null
    let row = -1
    let cursor = true
    if (ctx.codeUp() && ctx.letterPlate.codePlate?.object.visible) {
      object = ctx.letterPlate.codePlate.object
      row = ctx.letterPlate.codePlate.pick(o, d)
    } else if (ctx.lobbyUp() && ctx.lobbyPlate?.object.visible) {
      object = ctx.lobbyPlate.object
      row = ctx.lobbyPlate.pick(o, d, ctx.lobbyRows.length)
      cursor = false
    } else if (ctx.titleMenuUp() && ctx.optionsUp() && ctx.titleOptions.object?.visible) {
      // DEV-882: the OPTIONS pages stand on their own plate while they are up.
      object = ctx.titleOptions.object
      row = ctx.titleOptions.pick(o, d)
    } else if (ctx.titleMenuUp() && ctx.titleMenu?.object.visible) {
      object = ctx.titleMenu.object
      row = ctx.titleMenu.pick(o, d, ctx.titleRows().length)
    } else if (ctx.paused && ctx.flight?.pause.object.visible) {
      object = ctx.flight.pause.object
      row = ctx.flight.pause.pick(o, d, ctx.pausePlate().rows.length)
    }
    if (object === null) return false
    reticleOn.distance = planeHitDistance(o, d, object) ?? REST_DISTANCE
    reticleOn.row = row >= 0
    reticleOn.cursor = cursor
    return true
  }
  /** Place the reticle on what selects this frame; false when nothing should show it. */
  const aimMenuReticle = (): boolean => {
    // Under a BLACK fade it is drawn, unseen, so that its program for the stage
    // behind the fade links there and never on a frame anyone sees: the
    // vignette's fade is UI too and draws last (order 10000), so nothing of it
    // shows. Measured why it is needed: in a mission the world's sweeps patch
    // every material in the scene (`point-light-scope.ts`, `far-shadow.ts`),
    // the rig's included, so the triangle's program there is its own and the
    // pause plate's cannot stand in for it; without this the first hover on
    // the plate linked one (163 to 164 programs). Not under the title's held
    // curtain: that is drawn in the world pass, and the UI pass would draw the
    // triangle over it.
    if (ctx.fade.amount >= 1) {
      readHeadPose(ctx.render.renderer.xr, ctx.render.camera, _reticleEye, _reticleQuat)
      headForward(_reticleQuat, _reticleDirection)
      menuReticle.place(_reticleEye, _reticleDirection, REST_DISTANCE, _reticleEye, false, 'over')
      return true
    }
    // The laser marks its own end; a hand that points is what selects.
    if (ctx.xrPointer.object.visible || ctx.editorHost.benchUp) return false
    const inRoom =
      ctx.screen === 'menu' &&
      ctx.hangar !== null &&
      ctx.hangar.focused === null &&
      !ctx.loadingScene.shown
    if (!inRoom && !ctx.titleMenuUp() && !(ctx.paused && ctx.flight !== null)) return false
    const presenting = ctx.render.renderer.xr.isPresenting
    readHeadPose(ctx.render.renderer.xr, ctx.render.camera, _reticleEye, _reticleQuat)
    if (!presenting && !ctx.mouseLook.locked && menuCursor !== null) {
      const ray = ctx.glassRay(menuCursor.x, menuCursor.y)
      if (ray && reticlePlate(ray.origin, ray.direction) && reticleOn.row && reticleOn.cursor) {
        menuReticle.place(ray.origin, ray.direction, reticleOn.distance, _reticleEye, true, 'over')
        return true
      }
    }
    // DEV-884: in the room a free cursor aims the tables (`frame.ts`), so its mark
    // is the cursor's when a table is under it.
    if (
      inRoom &&
      !presenting &&
      !ctx.mouseLook.locked &&
      menuCursor !== null &&
      ctx.hangar !== null &&
      ctx.hangar.aimDistance !== null
    ) {
      const ray = ctx.glassRay(menuCursor.x, menuCursor.y)
      if (ray) {
        menuReticle.place(
          ray.origin,
          ray.direction,
          ctx.hangar.aimDistance,
          _reticleEye,
          true,
          'under',
        )
        return true
      }
    }
    headForward(_reticleQuat, _reticleDirection)
    const noseAims = inRoom || presenting || ctx.mouseLook.locked
    let layer: ReticleLayer = 'over'
    if (reticlePlate(_reticleEye, _reticleDirection)) {
      if (!reticleOn.row && !noseAims) return false
    } else if (inRoom && ctx.hangar !== null) {
      // The tables' own answer from this frame's gaze: where the ray is when it
      // counts as a hit (`HangarArt.aimDistance`), and under their words.
      const at = ctx.hangar.aimDistance
      reticleOn.distance = at ?? REST_DISTANCE
      reticleOn.row = at !== null
      layer = 'under'
    } else return false
    menuReticle.place(
      _reticleEye,
      _reticleDirection,
      reticleOn.distance,
      _reticleEye,
      reticleOn.row,
      layer,
    )
    return true
  }
  const menuReticleFrame = (): void => {
    if (!aimMenuReticle()) menuReticle.hide()
  }
  return {
    menuReticleFrame,
    get menuCursor() {
      return menuCursor
    },
    set menuCursor(v: { readonly x: number; readonly y: number } | null) {
      menuCursor = v
    },
  }
}
