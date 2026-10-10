// src/render/tv-marker.ts: who the camera is on, in the world. DEV-653 (a).
//
// CONSULTANT-REVIEW-2026-10-05 §4 item 3: "Nothing says who you are watching.
// The board's arrow marks the followed racer, but nothing in the world does."
// A marker over the jet: a name plate and a pointer, in the racer's own colour.
//
// ── Where it draws, and why ───────────────────────────────────────────────
//
// The same way the room's name tags draw (`game/remote-ships.ts`'s `nameTag`
// and `NAME_TAG_MATERIAL`): a screen-facing sprite of constant angular size,
// `toneMapped: true` so `render/bloom.ts` leaves it in the WORLD pass, and
// depth-tested, so a hill in front of the racer hides its marker as it hides
// the racer. A marker that showed through terrain would point at nothing. It is
// on layer 0 and sets no layer: 1 and 2 are the WebXR eyes (DEV-141).
//
// The NAME it carries is whatever the board would draw for that craft
// (`tvCraftName`): a live racer is `Racer N`, never a handle; an AI racer its
// callsign. TV airs no names (plan/FF-TV.md §8).

import * as THREE from 'three'
import { NAME_TAG_ANGLE, NAME_TAG_MATERIAL } from '@/game/remote-ships'
import { UI_ACCENT, UI_INK, UI_ON_ACCENT, UI_PLATE, uiFont } from '@/render/ui-tokens'

/** DEV-654: how long a gate-pass flash holds the plate in the accent, seconds. */
export const MARKER_FLASH_SECONDS = 0.35

/** Metres over the racer's centre the pointer's tip stands. */
export const TV_MARKER_RISE = 4.5

export interface TvMarkerTarget {
  readonly position: { readonly x: number; readonly y: number; readonly z: number }
  /** What the plate says, already in its drawn form. */
  readonly label: string
  /** The racer's hull colour as CSS, or null for the accent. */
  readonly colour: string | null
  /**
   * DEV-654: the winner's shot. The plate is the accent's gold (the first medal's
   * colour in the UI's own palette), whatever the racer's hull.
   */
  readonly winner?: boolean
}

export interface TvMarker {
  readonly object: THREE.Sprite
  /** One frame: stand over `target`, or null to hide. */
  update(target: TvMarkerTarget | null): void
  /** DEV-654: the followed racer took a gate: the plate flashes the accent for `MARKER_FLASH_SECONDS`. */
  flash(): void
  /** What it is saying now, or null while hidden (for specs). */
  readonly label: string | null
  dispose(): void
}

const H = 112
const PLATE_H = 72

export const createTvMarker = (): TvMarker => {
  const canvas = document.createElement('canvas')
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const material = new THREE.SpriteMaterial({ map: texture, ...NAME_TAG_MATERIAL })
  const sprite = new THREE.Sprite(material)
  sprite.name = 'tv-marker'
  // The pointer's tip is the sprite's bottom centre, so the tip stands on the position.
  sprite.center.set(0.5, 0)
  // Above the HUD and the panels' world-pass neighbours, like the room's tags.
  sprite.renderOrder = 9
  sprite.visible = false
  sprite.frustumCulled = false

  let drawn = ''
  let shown: string | null = null
  /** DEV-654: `performance.now()` the gate flash holds until. */
  let flashUntil = 0
  // TV can end without telling the marker (the exhibition stops, a link leaves):
  // nobody calls `update` then, so the marker hides itself a frame after the last
  // one. (`onBeforeRender` runs as it is drawn: one stale frame, never a stuck one.)
  let updatedAt = 0
  sprite.onBeforeRender = () => {
    if (performance.now() - updatedAt > 200) {
      sprite.visible = false
      shown = null
    }
  }

  const paint = (label: string, colour: string, lit: boolean): void => {
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const font = (px: number): string => uiFont(px, 700)
    ctx.font = font(40)
    const w = Math.max(160, Math.ceil(ctx.measureText(label).width + 84))
    // DEV-886: the canvas changes width with the label, and GL storage is immutable: a
    // wider label than the first one overflowed it (GL_INVALID_VALUE from
    // glCopySubTextureCHROMIUM, every repaint). A new size gets new storage.
    const resized = canvas.width !== w || canvas.height !== H
    canvas.width = w
    canvas.height = H
    ctx.clearRect(0, 0, w, H)
    // The plate: flat, with one hard edge in the racer's colour.
    // DEV-654: lit (a gate just taken, or the winner) the plate IS the accent.
    ctx.fillStyle = lit ? UI_ACCENT : UI_PLATE
    ctx.globalAlpha = lit ? 1 : 0.82
    ctx.fillRect(0, 0, w, PLATE_H)
    ctx.globalAlpha = 1
    ctx.fillStyle = colour
    ctx.fillRect(0, 0, 10, PLATE_H)
    ctx.fillStyle = lit ? UI_ON_ACCENT : UI_INK
    ctx.font = font(40)
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, 30, PLATE_H / 2 + 2)
    // The pointer: a faceted wedge straight down to the racer.
    ctx.fillStyle = colour
    ctx.beginPath()
    ctx.moveTo(w / 2 - 20, PLATE_H)
    ctx.lineTo(w / 2 + 20, PLATE_H)
    ctx.lineTo(w / 2, H - 2)
    ctx.closePath()
    ctx.fill()
    if (resized) texture.dispose()
    texture.needsUpdate = true
    sprite.scale.set((NAME_TAG_ANGLE * 1.7 * w) / H, NAME_TAG_ANGLE * 1.7, 1)
  }

  return {
    object: sprite,
    update(target) {
      if (!target) {
        sprite.visible = false
        shown = null
        return
      }
      const colour = target.winner ? UI_ACCENT : (target.colour ?? UI_ACCENT)
      const lit = target.winner === true || performance.now() < flashUntil
      const key = `${target.label}|${colour}|${lit}`
      if (key !== drawn) {
        drawn = key
        paint(target.label, colour, lit)
      }
      sprite.position.set(target.position.x, target.position.y + TV_MARKER_RISE, target.position.z)
      sprite.visible = true
      shown = target.label
      updatedAt = performance.now()
    },
    flash() {
      flashUntil = performance.now() + MARKER_FLASH_SECONDS * 1000
    },
    get label() {
      return shown
    },
    dispose() {
      sprite.removeFromParent()
      texture.dispose()
      material.dispose()
    },
  }
}
