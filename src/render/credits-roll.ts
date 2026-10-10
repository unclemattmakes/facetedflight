// src/render/credits-roll.ts: the credits as film credits roll them. DEV-623.
//
// Matt, 2026-10-04: *"credits should scroll the text upwards, like film
// credits - these look like options to adjust"*. So nothing on it is a row:
// the text climbs on its own, centred, and loops. A held A (or a tap) speeds
// it; BACK leaves, and BACK is the caller's business, not this sheet's.
//
// ── How it is drawn: one tall canvas, a window that slides ──────────────
//
// The whole roll is painted ONCE into a canvas a whole roll tall, with a
// window's worth of empty sheet above and below so it enters from the bottom
// edge and leaves from the top. The plane shows a window of it through the
// texture's own `repeat` and `offset`, and scrolling is one number per frame:
// no repaint, no upload. A texture transform is a uniform in three's basic
// material, so a sheet that moves compiles nothing a still one did not.
//
// The same sheet, at two sizes, is what the pause plate's CREDITS page hangs
// in its body and what the hangar stands on its one CREDITS table: the text is
// `creditsRoll` (`render/credits-menu.ts`), the one source of truth.

import * as THREE from 'three'
import { createUiMaterial, createUiTexture } from '@/render/ui-plate'
import { UI_ACCENT as ACCENT, UI_DIM as DIM, UI_INK as INK, uiFont } from '@/render/ui-tokens'
import { type CreditLine, ROLL_FAST, ROLL_PACE } from './credits-menu'

/** The pause plate's palette (`ui-tokens.ts`), because the roll lives on it. */

/** Canvas pixels per sheet-width unit: the sheet is this wide in pixels. */
const SHEET_PX = 720

/** Line heights, as fractions of the sheet's pixel width. */
const LINE: Record<CreditLine['kind'], number> = {
  title: 0.085,
  heading: 0.07,
  name: 0.06,
  note: 0.05,
  gap: 0.06,
}
const SIZE: Record<CreditLine['kind'], number> = {
  title: 0.062,
  heading: 0.042,
  name: 0.046,
  note: 0.034,
  gap: 0,
}

/** The roll's total height in canvas pixels for a sheet `px` wide, gaps included. */
export const rollTextHeightPx = (lines: readonly CreditLine[], px = SHEET_PX): number =>
  lines.reduce((sum, l) => sum + LINE[l.kind] * px, 0)

/**
 * How far the window travels before the roll loops, in canvas pixels: the
 * text plus one window. At 0 the window shows only the empty lead-in (the
 * first line about to enter from the bottom); at the period the last line has
 * left from the top and the sheet is empty again.
 */
export const rollPeriod = (textPx: number, windowPx: number): number => textPx + windowPx

export interface CreditsRoll {
  readonly object: THREE.Mesh
  /** Advance by `seconds`, fast while `fast`. */
  update(seconds: number, fast: boolean): void
  /** Back to the top, so the next open starts with the first line entering. */
  reset(): void
  /** Sheet-widths scrolled since the last reset, looping. For a probe. */
  readonly scrolled: number
  dispose(): void
}

export interface CreditsRollOptions {
  readonly lines: readonly CreditLine[]
  /** The window's size in metres. */
  readonly width: number
  readonly height: number
  /** Pixel ceiling for the canvas height (a texture limit). Default 4096. */
  readonly maxPx?: number
  /**
   * A fill behind the text, CSS. Unset on the pause plate, which is its own
   * backing; the hangar's sheet stands against the room's dark rock and wants
   * one.
   */
  readonly backing?: string
}

export const createCreditsRoll = (options: CreditsRollOptions): CreditsRoll => {
  const { lines, width, height } = options
  const textPx0 = rollTextHeightPx(lines)
  const windowPx0 = (SHEET_PX * height) / width
  const fullPx0 = textPx0 + 2 * windowPx0
  // Scale the whole sheet down if it would pass the texture ceiling.
  const k = Math.min(1, (options.maxPx ?? 4096) / fullPx0)
  const px = Math.round(SHEET_PX * k)
  const windowPx = windowPx0 * k
  const textPx = textPx0 * k

  const canvas = document.createElement('canvas')
  canvas.width = px
  canvas.height = Math.ceil(textPx + 2 * windowPx)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('credits-roll: no 2d context')
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  if (options.backing) {
    ctx.fillStyle = options.backing
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  let y = windowPx
  for (const line of lines) {
    const h = LINE[line.kind] * px
    if (line.kind !== 'gap') {
      const weight = line.kind === 'note' ? 500 : 700
      ctx.font = uiFont(SIZE[line.kind] * px, weight)
      ctx.fillStyle =
        line.kind === 'title' || line.kind === 'heading' ? ACCENT : line.kind === 'name' ? INK : DIM
      const text =
        line.kind === 'heading' || line.kind === 'title' ? line.text.toUpperCase() : line.text
      ctx.fillText(text, px / 2, y + h / 2, px * 0.96)
    }
    y += h
  }

  // Not `createUiPlate`: the canvas is a tall sheet the plane is a WINDOW onto
  // (`texture.repeat` and `offset` scroll it), so its size is not metres times a
  // density. The texture and the unlit overlay material are the plates' own.
  const texture = createUiTexture(canvas)
  const view = windowPx / canvas.height
  texture.repeat.set(1, view)

  const material = createUiMaterial(texture)
  const object = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material)
  object.name = 'credits-roll'

  const period = rollPeriod(textPx, windowPx)
  let scrolled = 0
  const place = () => {
    // Canvas row 0 is the TOP; texture v runs up from the bottom. The window's
    // top starts at canvas row 0 (all lead-in) and slides down the canvas.
    const topFrac = (scrolled * px) / canvas.height
    texture.offset.set(0, 1 - view - topFrac)
  }
  place()

  return {
    object,
    update(seconds, fast) {
      scrolled = (scrolled + seconds * ROLL_PACE * (fast ? ROLL_FAST : 1)) % (period / px)
      place()
    },
    reset() {
      scrolled = 0
      place()
    },
    get scrolled() {
      return scrolled
    },
    dispose() {
      texture.dispose()
      material.dispose()
      object.geometry.dispose()
    },
  }
}
