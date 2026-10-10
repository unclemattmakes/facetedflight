// src/render/room-code-plate.ts — the letter plate a room's code is typed on. DEV-441b.
//
// `game/room-code.ts` is the keys; this is where they are drawn and which one
// a ray lands on. It is a SECOND plate beside the pause plate, which the title
// menu took pains not to be (`render/title-menu.ts`), because a keypad is a
// grid and the pause plate is a list. So it keeps that file's one rule the way
// the pause plate does: the painter and the hit test read ONE layout function
// (`codeKeyRect`), so the key you look at is the key you press — the drift a
// world-space menu can have, and which renders perfectly either way.
//
// ── Where it hangs ────────────────────────────────────────────────────────
//
// Exactly where the title's rows hang, in their place (`titleMenuPose`): under
// the rig, the top edge 12.5 degrees under the eye line, so the emblem's line
// stays clear above it and a flat screen's centre ray MISSES it — the arrow
// keys and the stick keep what they chose, as on every plate here. The plate
// is sized to the room that leaves: its bottom inside a flat 70-degree frame,
// its width inside a portrait phone's (`tests/unit/room-code.test.ts`).
//
// **Since DEV-558 it stands in the HANGAR, not on the title**: Join with a Code
// is a holotable of the hangar's Multiplayer step now. Same pose relative to
// the eye, composed onto the CHAIR's home forward (`placeCodePlateInRoom`), as
// the lobby's plates are (`render/room-lobby.ts`), so it keeps still while the
// seat turns, and the room's tables are put by while it is up.
//
// The keys are small for a head: about 4 degrees across and under 3 high
// (0.151 m by 0.106 m at 2.1 to 2.3 m, looked down on), where the pause plate
// was sized for 6 (`render/pause.ts`). A laser (DEV-321), the
// stick, a finger or a keyboard are all exact; the head is the one that is
// not, and whether it is good enough is a question for WEARING it.

import * as THREE from 'three'
import { CODE_COLS, CODE_KEYS, CODE_ROWS, type CodeKey, codeKeyAt } from '@/game/room-code'
import { angleDeg, topEdgeY } from '@/render/eye-plate'
import { CODE_PLATE_PHONE_BOOST, phoneUi } from '@/render/phone-floor'
import { TITLE_MENU_DISTANCE, TITLE_MENU_SCALE, TITLE_MENU_TOP_DEG } from '@/render/title-menu'
import { drawPlate } from '@/render/ui-draw'
import { type PlaneHit, rayPlaneHit, toPanelLocal } from '@/render/ui-pick'
import { createUiPlate, UI_PIXELS_PER_METRE } from '@/render/ui-plate'
import {
  UI_ACCENT as ACCENT,
  UI_DIM as DIM,
  uiFont as font,
  UI_INK as INK,
  UI_SELECTED_FILL as SELECTED_FILL,
  UI_CYAN_WASH,
  UI_DIM_FAINT,
} from '@/render/ui-tokens'

/** The plate, in its own metres (before `TITLE_MENU_SCALE`). */
export const CODE_PLATE_WIDTH = 0.7
/** The band at the top: the heading, and the code as typed so far. */
export const CODE_BAND_M = 0.085
/** One row of keys. */
export const CODE_KEY_H_M = 0.066
/** The band under the keys: what is going on, and what to press. */
export const CODE_FOOT_M = 0.05
/** Inset of the key grid from the plate's sides. */
export const CODE_PAD_M = 0.02
/** The plate's whole height. */
export const CODE_PLATE_HEIGHT = CODE_BAND_M + CODE_ROWS * CODE_KEY_H_M + CODE_FOOT_M
/** One column of keys. */
export const CODE_KEY_W_M = (CODE_PLATE_WIDTH - 2 * CODE_PAD_M) / CODE_COLS

/**
 * Key `i`'s rectangle in plate-local metres: `x` from the plate's centre line
 * (+ right), `top` measured DOWN from the plate's top edge. THE layout: the
 * painter draws these, and `pickCodeLocal` inverts them.
 */
export const codeKeyRect = (
  i: number,
): { readonly x: number; readonly top: number; readonly w: number; readonly h: number } => {
  const k = CODE_KEYS[i] as CodeKey
  return {
    x: -CODE_PLATE_WIDTH / 2 + CODE_PAD_M + k.col * CODE_KEY_W_M,
    top: CODE_BAND_M + k.row * CODE_KEY_H_M,
    w: k.span * CODE_KEY_W_M,
    h: CODE_KEY_H_M,
  }
}

/** Key `i`'s centre, plate-local metres, +y UP from the plate's TOP EDGE (its origin). */
export const codeKeyCentre = (i: number): { readonly x: number; readonly y: number } => {
  const r = codeKeyRect(i)
  return { x: r.x + r.w / 2, y: -(r.top + r.h / 2) }
}

// Volatile, and valid only inside one `pickCodeLocal` call.
const _hit: PlaneHit = { x: 0, y: 0 }

/**
 * Which key a ray hits, in PLATE-LOCAL space (origin on the top edge's middle,
 * +y up, the face +z), or −1: a miss, a ray pointing away, the bands above and
 * below the keys, or the inset at the sides.
 */
export const pickCodeLocal = (
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
): number => {
  if (!rayPlaneHit(_hit, ox, oy, oz, dx, dy, dz)) return -1
  const x = _hit.x
  const fromTop = -_hit.y
  const across = x + CODE_PLATE_WIDTH / 2 - CODE_PAD_M
  const down = fromTop - CODE_BAND_M
  if (across < 0 || down < 0) return -1
  const col = Math.floor(across / CODE_KEY_W_M)
  const row = Math.floor(down / CODE_KEY_H_M)
  if (col >= CODE_COLS || row >= CODE_ROWS) return -1
  return codeKeyAt(col, row)
}

/** The plate's pose under the rig: its top edge where the title's rows start. */
export const codePlatePose = (): {
  readonly position: readonly [number, number, number]
  readonly scale: number
} => {
  // DEV-894: a phone's keypad is larger and centred on the eye line.
  const scale = TITLE_MENU_SCALE * (phoneUi.on ? CODE_PLATE_PHONE_BOOST : 1)
  const top = phoneUi.on
    ? (CODE_PLATE_HEIGHT * scale) / 2
    : topEdgeY(TITLE_MENU_TOP_DEG, TITLE_MENU_DISTANCE)
  return { position: [0, top, -TITLE_MENU_DISTANCE], scale }
}

/** The plate's angular extent from the eye, degrees: for the tests that hold it in frame. */
export const codePlateExtent = (): {
  readonly topDeg: number
  readonly bottomDeg: number
  readonly halfWidthDeg: number
} => {
  const { position, scale } = codePlatePose()
  const deg = (y: number) => angleDeg(y, TITLE_MENU_DISTANCE)
  return {
    topDeg: deg(position[1]),
    bottomDeg: deg(position[1] - CODE_PLATE_HEIGHT * scale),
    halfWidthDeg: deg((CODE_PLATE_WIDTH / 2) * scale),
  }
}

/**
 * DEV-558: stand the plate in the hangar, its {@link codePlatePose} composed
 * onto the chair: `seatWorld` is the eye, `seatQuaternion` the chair's home
 * forward (-z ahead). The plate's face is +z, so the chair's own turn faces it
 * back at the eye, as a plate under the rig faced it.
 */
export const placeCodePlateInRoom = (
  object: THREE.Object3D,
  seatWorld: THREE.Vector3,
  seatQuaternion: THREE.Quaternion,
): void => {
  const { position, scale } = codePlatePose()
  object.position
    .set(position[0], position[1], position[2])
    .applyQuaternion(seatQuaternion)
    .add(seatWorld)
  object.quaternion.copy(seatQuaternion)
  object.scale.setScalar(scale)
  object.name = 'room-code-plate'
}

/** Put the plate where it goes. Its face is +z, which is the eye. */
export const placeCodePlate = (object: THREE.Object3D): void => {
  const { position, scale } = codePlatePose()
  object.position.set(position[0], position[1], position[2])
  object.rotation.set(0, 0, 0)
  object.scale.setScalar(scale)
  object.name = 'room-code-plate'
}

/** What the plate shows. */
export interface CodePlateState {
  readonly heading: string
  /** The code so far, as `codeTypedText` spells it. */
  readonly typed: string
  /** Key under the aim, or −1. */
  readonly selected: number
  /** Whether each key would do anything if pressed now (a dim key would not). */
  readonly live: readonly boolean[]
  /** The line under the keys: what is happening, or what to press. */
  readonly footer: string
  /** Paint the footer in the accent: something the player must read (a refusal). */
  readonly footerAccent: boolean
}

export interface CodePlate {
  readonly object: THREE.Object3D
  setVisible(visible: boolean): void
  update(state: CodePlateState): void
  /** Which key a WORLD-space ray is on, or −1. */
  pick(origin: THREE.Vector3, direction: THREE.Vector3): number
  dispose(): void
}

// The pause plate's palette (`ui-tokens.ts`): the same instrument.
const FAINT = UI_DIM_FAINT
const KEY_FILL = UI_CYAN_WASH
const PIXELS_PER_METRE = UI_PIXELS_PER_METRE

export const createCodePlate = (): CodePlate => {
  // UI, not tone-mapped, and drawn over whatever stands in front of it, as the
  // pause plate is (`render/pause.ts`): `ui-plate.ts`'s overlay.
  const plate = createUiPlate({
    name: 'room-code-plate',
    widthM: CODE_PLATE_WIDTH,
    heightM: CODE_PLATE_HEIGHT,
    renderOrder: 12,
    pxPerM: PIXELS_PER_METRE,
    geometry: (h) => {
      const geometry = new THREE.PlaneGeometry(CODE_PLATE_WIDTH, h)
      // The top edge at the origin, so the pose places the edge, not the middle.
      geometry.translate(0, -h / 2, 0)
      return geometry
    },
  })
  const { canvas, ctx, object } = plate

  let signature = ''
  const px = (m: number) => m * PIXELS_PER_METRE

  const draw = (s: CodePlateState): void => {
    const w = canvas.width
    const h = canvas.height
    ctx.clearRect(0, 0, w, h)
    drawPlate(ctx, w, h, { bar: px(0.006), lineWidth: Math.max(2, px(0.002)) })

    // The heading, small, and the code under it, large: the thing being made.
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = ACCENT
    ctx.font = font(px(0.02))
    ctx.fillText(s.heading, w / 2, px(0.018))
    ctx.fillStyle = INK
    ctx.font = font(px(0.048))
    ctx.fillText(s.typed.split('').join(' '), w / 2, px(0.057))

    // The keys.
    const gap = px(0.004)
    CODE_KEYS.forEach((k, i) => {
      const r = codeKeyRect(i)
      const x = w / 2 + px(r.x) + gap
      const y = px(r.top) + gap
      const kw = px(r.w) - 2 * gap
      const kh = px(r.h) - 2 * gap
      const on = i === s.selected
      const live = s.live[i] ?? true
      ctx.beginPath()
      ctx.roundRect(x, y, kw, kh, px(0.006))
      ctx.fillStyle = on ? SELECTED_FILL : KEY_FILL
      ctx.fill()
      if (on) {
        ctx.lineWidth = Math.max(2, px(0.003))
        ctx.strokeStyle = ACCENT
        ctx.stroke()
      }
      ctx.fillStyle = on ? ACCENT : live ? INK : FAINT
      ctx.font = font(px(k.char !== null ? 0.036 : 0.024))
      ctx.fillText(k.label.toUpperCase(), x + kw / 2, y + kh / 2 + px(0.001))
    })

    ctx.fillStyle = s.footerAccent ? ACCENT : DIM
    ctx.font = font(px(0.019), 600)
    ctx.fillText(s.footer, w / 2, h - px(CODE_FOOT_M) / 2)
    plate.commit()
  }

  const _origin = new THREE.Vector3()
  const _direction = new THREE.Vector3()

  return {
    object,
    setVisible(visible: boolean) {
      object.visible = visible
    },
    update(s: CodePlateState) {
      const next = [
        s.heading,
        s.typed,
        s.selected,
        s.live.map((l) => (l ? 1 : 0)).join(''),
        s.footer,
        s.footerAccent,
      ].join('|')
      if (next === signature) return
      signature = next
      draw(s)
    },
    pick(origin: THREE.Vector3, direction: THREE.Vector3): number {
      // `matrixWorld` is stale inside an XR frame callback until `render()`
      // (CLAUDE.md): refreshed here, as the pause plate's `pick` does.
      toPanelLocal(object, origin, direction, _origin, _direction)
      return pickCodeLocal(
        _origin.x,
        _origin.y,
        _origin.z,
        _direction.x,
        _direction.y,
        _direction.z,
      )
    },
    dispose() {
      plate.dispose()
    },
  }
}
