// src/boot/app/hangar/options-plate.ts: the hangar's OPTIONS table opens THE
// OPTIONS pages (DEV-857, rewired onto DEV-859's one entry point).
//
// Matt, 2026-10-08: *"the options table should show the pause panel's OPTIONS
// page"*, not a table of its own. A door that does not descend a step but stands
// a plate, as the letter plate does (`letter-plate.ts`). The pages are NOT
// forked, and since DEV-859 there is ONE door to them, `menus.options`
// (`hangar/menus.ts`): the pause plate, the title and this plate all call its
// `open`, `plate`, `press`, `back` and `close`, so a setting changed here is the
// setting the cockpit shows and nothing about the pages is known in this file.
// Only the plate it is drawn on is its own, because the pause plate hangs in a
// cockpit that does not exist in the hangar.
//
// While it is up the room's tables are put by (`focus`), the head, a laser or
// a finger picks a row, the stick and the arrow keys step it, the confirm every
// device rides presses it, and B or Backspace or a free Escape goes back one
// page, then out to the hangar (BACK's note says so: open('to the hangar')).

import * as THREE from 'three'
import type { MouseLook } from '@/input/look'
import { clampAim, createRowStepper } from '@/input/menu-step'
import type { PointerHand } from '@/input/pointer-hand'
import { CREDITS_OPTION } from '@/render/credits-menu'
import type { CreditsRoll } from '@/render/credits-roll'
import type { HangarArt } from '@/render/hangar'
import { placeOptionsPlateInRoom } from '@/render/hangar-options-plate'
import { createPause, type Pause, type PausePage, rowCentreLocalY, TITLE_M } from '@/render/pause'
import { planeHitDistance, type XrPointer } from '@/render/xr-pointer'
import type { PauseState } from '../pause-state'

/** `menus.options`, as this plate uses it (DEV-859). */
export interface OptionsEntry {
  open(backNote?: string): number
  close(): void
  readonly up: boolean
  plate(): PausePage
  back(): number | null
  press(aim: number, now: number): { handled: boolean; aim: number; recenter: boolean }
}

/** What `createOptionsPlate` reads from the closure: getters, each read live (APP-SPLIT §3's `ctx`). */
export interface OptionsPlateCtx {
  readonly CREDITS_BODY_M: number
  readonly creditsRollFor: () => CreditsRoll
  /** The ray through a point on the glass, CSS pixels, or null (DEV-882: a cursor over a row). */
  readonly glassRay: (x: number, y: number) => THREE.Ray | null
  readonly hangar: HangarArt | null
  readonly menuScene: THREE.Scene
  readonly menus: {
    pauseCursorAim: boolean
    creditsFastUntil: number
    readonly creditsRoll: CreditsRoll | null
    readonly options: OptionsEntry
  }
  readonly mouseLook: MouseLook
  readonly pause: PauseState
  /** In a headset the mouse is nothing (the laser and the head aim). */
  readonly presenting: () => boolean
  readonly screen: 'title' | 'menu' | 'mission'
  readonly seatQuaternion: THREE.Quaternion
  readonly seatWorld: THREE.Vector3
  readonly xrPointer: XrPointer
}

/** What a frame hands `frame`: the rays, and whether the confirm is held. */
export interface OptionsPlateFrame {
  readonly seconds: number
  readonly nowMs: number
  readonly pointing: PointerHand | null
  readonly aimOrigin: THREE.Vector3
  readonly aimDirection: THREE.Vector3
  readonly eye: THREE.Vector3
  readonly gaze: THREE.Vector3
  readonly fastHeld: boolean
  /** The seat's look yaw about the chair, radians (`seatLookYaw`): where the player faces now. */
  readonly lookYaw: number
  /** A flat screen (not a headset): the plate is 1.4 times its angular size there. */
  readonly flat: boolean
}

/** The note the OPTIONS page's BACK row carries here: it leaves for the hangar, not the pause menu. */
const BACK_NOTE = 'to the hangar'

/** `looked` before the first frame has read where the gaze is. */
const UNSAMPLED = -2

export const createOptionsPlate = (ctx: OptionsPlateCtx) => {
  const options = (): OptionsEntry => ctx.menus.options
  let plate: Pause | null = null
  let open = false
  /** The row the gaze was on last frame, or -1: the gaze takes the aim when it MOVES (the letter plate's rule). */
  let looked = -1
  /** The row count and body the plate was last placed for. */
  let placedFor = ''
  /** Set by `open`: the next frame stands the plate where the player is LOOKING (pressing OPTIONS turned the seat to it). */
  let restand = false
  const _aim = new THREE.Quaternion()
  const _yaw = new THREE.Quaternion()
  const UP = new THREE.Vector3(0, 1, 0)
  const steps = createRowStepper()
  /** The sentinel the room's tables are focused on while the plate is up: no table stands for it. */
  const LENT = 'hangar-options:plate'

  const up = (): boolean => open && ctx.screen === 'menu' && ctx.hangar !== null

  const openPlate = (): void => {
    open = true
    ctx.pause.pauseAim = options().open(BACK_NOTE)
    // DEV-882: the plate stands where the player looks, centred on the view, so
    // the gaze is on a row at once; that is not the gaze MOVING, and the page
    // opens on its first row as the pause plate does. The first frame samples it.
    looked = UNSAMPLED
    ctx.menus.pauseCursorAim = false
    restand = true
    steps.reset()
    ctx.hangar?.focus(LENT)
    console.info('hangar: the options plate')
  }

  /** Put the plate away and give the room its arc back. */
  const shut = (): void => {
    open = false
    options().close()
    ctx.pause.pauseAim = 0
    if (ctx.hangar?.focused === LENT) ctx.hangar.focus(null)
    if (ctx.menus.creditsRoll !== null) ctx.menus.creditsRoll.object.visible = false
    console.info('hangar: back from the options plate')
  }

  /** B, Backspace, a free Escape: one page up (`menus.options.back` plays the sound), then out to the hangar. */
  const back = (): void => {
    const aim = options().back()
    if (aim === null) return
    if (options().up) ctx.pause.pauseAim = aim
    else shut()
  }

  /** A step of the stick, the D-pad or the arrow keys (already read by the frame). */
  const nudge = (menuStep: -1 | 0 | 1): void => {
    const step = steps.take(menuStep)
    if (step !== 0)
      ctx.pause.pauseAim = clampAim(ctx.pause.pauseAim, step, options().plate().rows.length)
  }

  /** The press on the row under the aim: `menus.options.press`, then out when BACK left OPTIONS. */
  const press = (opts: { readonly recenter: () => void; readonly nowMs: number }): void => {
    const took = options().press(ctx.pause.pauseAim, opts.nowMs)
    if (!took.handled) return
    ctx.pause.pauseAim = took.aim
    if (took.recenter) opts.recenter()
    if (!options().up) shut()
  }

  /** The row index a ray meets, or -1: for a finger's tap on the glass. */
  const pick = (origin: THREE.Vector3, direction: THREE.Vector3): number =>
    plate === null || !plate.object.visible
      ? -1
      : plate.pick(origin, direction, options().plate().rows.length)

  /**
   * DEV-882: the row under a point on the glass (a free cursor's hover or click),
   * or -1. Not while the pointer is captured (there is no cursor then) or in a
   * headset. The pause plate's own rule (`hangar/menus.ts`'s `pauseRowAt`).
   */
  const rowAt = (x: number, y: number): number => {
    if (!up() || ctx.mouseLook.locked || ctx.presenting()) return -1
    const ray = ctx.glassRay(x, y)
    return ray === null ? -1 : pick(ray.origin, ray.direction)
  }
  // A cursor click ON a row presses it and captures nothing; a click anywhere
  // else is the capture, as everywhere (`input/look.ts`'s `readClick`).
  ctx.mouseLook.setCursorTarget((x, y) => rowAt(x, y) >= 0, 'options')

  /** Panel-local y of row `i` on the page as drawn (a probe's `rowsAt`). */
  const rowLocalY = (i: number): number => {
    const shown = options().plate()
    const body = shown.page === CREDITS_OPTION.id ? ctx.CREDITS_BODY_M : 0
    return rowCentreLocalY(i, shown.rows.length, TITLE_M + body)
  }

  /** A tapped row aims; the frame then presses it as it presses any aimed row. */
  const aimAt = (index: number): void => {
    ctx.pause.pauseAim = index
  }

  /** Every hangar frame: built when asked for, shown, aimed and painted. */
  const frame = (f: OptionsPlateFrame): void => {
    if (open && (ctx.screen !== 'menu' || !options().up)) {
      // The screen left under it (a boarding, a title), or the pages shut: put away, quietly.
      shut()
    }
    const showing = up()
    if (showing && plate === null) {
      plate = createPause()
      ctx.menuScene.add(plate.object)
    }
    plate?.setVisible(showing)
    if (!showing || plate === null) {
      looked = -1
      return
    }
    const shown = options().plate()
    const rolling = shown.page === CREDITS_OPTION.id
    const body = rolling ? ctx.CREDITS_BODY_M : 0
    const key = `${shown.rows.length}|${body}|${f.flat}`
    if (restand) {
      restand = false
      placedFor = ''
      // The chair's home forward turned by where the seat looks now: in front of the eye, square to it.
      _aim.copy(ctx.seatQuaternion).multiply(_yaw.setFromAxisAngle(UP, f.lookYaw))
    }
    if (key !== placedFor) {
      placedFor = key
      placeOptionsPlateInRoom(plate.object, shown.rows.length, body, ctx.seatWorld, _aim, f.flat)
    }
    ctx.pause.pauseAim = Math.max(0, Math.min(shown.rows.length - 1, ctx.pause.pauseAim))
    // The laser when it is on the plate, else the head.
    let hit = plate.pick(f.aimOrigin, f.aimDirection, shown.rows.length)
    if (f.pointing !== null && hit >= 0) {
      ctx.xrPointer.show(
        f.pointing,
        planeHitDistance(f.aimOrigin, f.aimDirection, plate.object),
        f.eye,
      )
    } else if (f.pointing !== null) {
      hit = plate.pick(f.eye, f.gaze, shown.rows.length)
    }
    if (hit >= 0 && looked !== UNSAMPLED && hit !== looked && !ctx.menus.pauseCursorAim)
      ctx.pause.pauseAim = hit
    looked = hit
    // The credits page is a roll in the plate's body over one row, BACK.
    if (rolling) {
      const roll = ctx.creditsRollFor()
      if (roll.object.parent !== plate.object) plate.object.add(roll.object)
      roll.object.visible = true
      roll.update(
        f.seconds,
        (f.fastHeld && ctx.pause.pauseAim !== 0) || f.nowMs < ctx.menus.creditsFastUntil,
      )
    } else if (ctx.menus.creditsRoll !== null) ctx.menus.creditsRoll.object.visible = false
    plate.update({
      ...(rolling ? { body: ctx.CREDITS_BODY_M } : {}),
      options: shown.rows,
      // DEV-859: a note for the selected row only, as on every OPTIONS plate.
      notesOnSelect: true,
      selected: ctx.pause.pauseAim,
      title: shown.title,
    })
  }

  return {
    up,
    open: openPlate,
    close: shut,
    back,
    nudge,
    press,
    pick,
    rowAt,
    rowLocalY,
    aimAt,
    frame,
    /** The plate's object, or null before first use: for the reticle and the probes. */
    get object(): THREE.Object3D | null {
      return plate?.object ?? null
    },
    get rowCount(): number {
      return options().plate().rows.length
    },
  }
}

export type OptionsPlate = ReturnType<typeof createOptionsPlate>
