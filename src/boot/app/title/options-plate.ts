// src/boot/app/title/options-plate.ts: the title's OPTIONS pages, drawn on the
// pause plate's own kind of plate. DEV-881 and DEV-882.
//
// DEV-859 put the OPTIONS pages on the title's rows plate: the rows were
// right and the plate was wrong for them. That plate is centred, headless and
// built for three rows (`TITLE_MENU_PLATE`), so a page of eight came out at
// about half the pause plate's size (rows 19 px against 36 on a 720p window),
// and it had no heading and no body, so CREDITS, which is a roll hung in the
// plate's body over one BACK row, drew BACK and nothing else (the 2026-10-09
// playtest: "a plate that says BACK and nothing else, for 40 seconds").
//
// So while OPTIONS is up the title draws a second plate, the one the hangar's
// OPTIONS table draws (`hangar/options-plate.ts`): a `createPause()` plate with
// its heading and a body for the roll, at the pause plate's angular size
// (`render/options-plate-pose.ts`). The title's own plate is put away under it.
// The rows, the aim and the presses are the title's (`titleRows` returns the
// page's rows while OPTIONS is up, and `titleAim` steps them with the keys, the
// stick, a tap or a click), so nothing about HOW a row is chosen changes: only
// where the rows are drawn, which is what every one of the three reports said.

import type * as THREE from 'three'
import { CREDITS_OPTION } from '@/render/credits-menu'
import type { CreditsRoll } from '@/render/credits-roll'
import { optionsPlatePoseAt } from '@/render/options-plate-pose'
import { createPause, type Pause, type PausePage, rowCentreLocalY, TITLE_M } from '@/render/pause'
import { EMBLEM_ORDER } from '@/render/title-curtain'

/** What `createTitleOptionsPlate` reads from the closure: getters, each read live. */
export interface TitleOptionsPlateCtx {
  readonly CREDITS_BODY_M: number
  readonly creditsRollFor: () => CreditsRoll
  readonly menus: {
    readonly creditsFastUntil: number
    readonly creditsRoll: CreditsRoll | null
  }
  /** `menus.options`, as this plate reads it. */
  readonly options: { readonly up: boolean; plate(): PausePage }
  /** The rig the title plates hang under (`render.rig`). */
  readonly rig: THREE.Object3D
}

/** What a title frame hands `frame`. */
export interface TitleOptionsFrame {
  /** The OPTIONS pages are up on the title. */
  readonly on: boolean
  /** A flat screen (not a headset). */
  readonly flat: boolean
  /** The row aimed. */
  readonly selected: number
  readonly seconds: number
  readonly nowMs: number
  /** The confirm is held: it rolls the credits fast, but not on BACK. */
  readonly fastHeld: boolean
}

export const createTitleOptionsPlate = (ctx: TitleOptionsPlateCtx) => {
  let plate: Pause | null = null
  /** The row count, body and surface the plate was last placed for. */
  let placedFor = ''
  let rollingNow = false

  const rowsNow = (): PausePage => ctx.options.plate()

  /** Show or put away, place for the page, hang the credits roll, and paint. */
  const frame = (f: TitleOptionsFrame): void => {
    if (!f.on) {
      plate?.setVisible(false)
      if (rollingNow && ctx.menus.creditsRoll !== null) ctx.menus.creditsRoll.object.visible = false
      rollingNow = false
      placedFor = ''
      return
    }
    if (plate === null) {
      plate = createPause()
      // Over the emblem and the line under it (both sort at `EMBLEM_ORDER`): the plate
      // stands across the middle of the title, and its words must not share a draw
      // with the edition's name.
      plate.object.renderOrder = EMBLEM_ORDER + 1
      ctx.rig.add(plate.object)
    }
    plate.setVisible(true)
    const shown = rowsNow()
    const rolling = shown.page === CREDITS_OPTION.id
    const body = rolling ? ctx.CREDITS_BODY_M : 0
    const key = `${shown.rows.length}|${body}|${f.flat}`
    if (key !== placedFor) {
      placedFor = key
      const { position, scale, tilt } = optionsPlatePoseAt(shown.rows.length, body, f.flat, 0)
      plate.object.position.set(position[0], position[1], position[2])
      plate.object.rotation.set(tilt, 0, 0)
      plate.object.scale.setScalar(scale)
      plate.object.name = 'title-options-plate'
    }
    // The credits page is a roll in the plate's body over one row, BACK.
    if (rolling) {
      const roll = ctx.creditsRollFor()
      if (roll.object.parent !== plate.object) plate.object.add(roll.object)
      roll.object.visible = true
      roll.object.renderOrder = EMBLEM_ORDER + 2
      roll.update(
        f.seconds,
        (f.fastHeld && f.selected !== 0) || f.nowMs < ctx.menus.creditsFastUntil,
      )
    } else if (rollingNow && ctx.menus.creditsRoll !== null) {
      ctx.menus.creditsRoll.object.visible = false
    }
    rollingNow = rolling
    plate.update({
      ...(rolling ? { body: ctx.CREDITS_BODY_M } : {}),
      options: shown.rows,
      // DEV-859: a note for the selected row only, as on every OPTIONS plate.
      notesOnSelect: true,
      selected: f.selected,
      title: shown.title,
    })
  }

  /** The row a ray meets, or -1 (also -1 while the plate is down). */
  const pick = (origin: THREE.Vector3, direction: THREE.Vector3): number =>
    plate === null || !plate.object.visible
      ? -1
      : plate.pick(origin, direction, rowsNow().rows.length)

  /** Panel-local y of row `i` on the page as drawn (a probe's `rowsAt`). */
  const rowLocalY = (i: number): number => {
    const shown = rowsNow()
    const body = shown.page === CREDITS_OPTION.id ? ctx.CREDITS_BODY_M : 0
    return rowCentreLocalY(i, shown.rows.length, TITLE_M + body)
  }

  return {
    frame,
    pick,
    rowLocalY,
    get object(): THREE.Object3D | null {
      return plate?.object ?? null
    },
  }
}

export type TitleOptionsPlate = ReturnType<typeof createTitleOptionsPlate>
