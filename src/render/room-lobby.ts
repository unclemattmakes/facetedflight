// src/render/room-lobby.ts — where a room's lobby stands in the hangar. DEV-389.
//
// plan/MULTIPLAYER.md §6.9: *"The lobby is a hangar state, not a page."* Two
// plates, both the pause plate's own painter and hit test (`render/pause.ts`),
// for `render/title-menu.ts`'s reason: one painter, one picker, one set of
// device words, and a row you look at is the row you press.
//
//   - the ROSTER, on the left: every seat, who is in it, their colour and
//     whether they are ready. Read, never pressed; nothing aims at it.
//   - the ACTIONS, on the right: course, colour, ready, START, invite, leave.
//
// FURNITURE in the room, like the bench door (DEV-492), not a HUD: they
// stand off the chair's home forward and keep still while you turn the seat.
// At the title menu's distance and scale (2 m, x1.6), which were chosen for a
// plate read from a chair and aimed by the head; either side of straight
// ahead, so the head's resting ray (flat: the view's centre) lands in the gap
// between them and a row is taken only when you LOOK at it — the pause plate's
// rule (`PANEL_DROP`) in the lateral axis.
//
// Nothing here is in `render/hangar.ts` or the room's art: the room is being
// rebuilt under this (DEV-430/437/438), and the lobby only needs the chair's
// pose, which `app.ts` already composes for the room's plates.

import type * as THREE from 'three'
import { topEdgeY } from '@/render/eye-plate'
import { panelHeight, TOP_LOCAL_Y, WIDTH } from '@/render/pause'
import { LOBBY_PHONE_BEARING_DEG, LOBBY_PHONE_BOOST, phoneUi } from '@/render/phone-floor'

/**
 * Metres from the eye, and the plate's scale. The title menu's distance
 * (`render/title-menu.ts`), larger: the owner's plate has seven rows, and the
 * pause plate shrinks a row past five (`rowBand`). At x2.2 a row of seven is
 * 4.3 degrees, the comfort menu's 4.6 at its own seven.
 */
export const LOBBY_DISTANCE = 2.0
export const LOBBY_SCALE = 2.2
/** The plates' top edges, degrees below the eye line. */
export const LOBBY_TOP_DEG = 3
/**
 * Each plate's centre, degrees off the chair's home forward; positive is the
 * viewer's RIGHT. Wide enough that the two do not touch (`lobbyGapDeg`).
 */
export const LOBBY_BEARING_DEG = { roster: -19, actions: 19 } as const

/**
 * A plate's centre in the CHAIR's frame, metres from the eye: x right, y up,
 * z back (three's camera convention, forward is −z), before it is turned to
 * face the eye.
 */
export const lobbyPlateOffset = (bearingDeg: number): [number, number, number] => {
  // DEV-894: a phone's pair stands wider apart, larger, and centred on the eye line.
  const phone = phoneUi.on
  const scale = LOBBY_SCALE * (phone ? LOBBY_PHONE_BOOST : 1)
  const bearing = phone ? Math.sign(bearingDeg) * LOBBY_PHONE_BEARING_DEG : bearingDeg
  const b = (bearing * Math.PI) / 180
  const top = phone
    ? (panelHeight(LOBBY_PHONE_ROWS) * scale) / 2
    : topEdgeY(LOBBY_TOP_DEG, LOBBY_DISTANCE)
  return [Math.sin(b) * LOBBY_DISTANCE, top - TOP_LOCAL_Y * scale, -Math.cos(b) * LOBBY_DISTANCE]
}

/** The row count a phone's lobby plates are centred for: the owner's roster, seven. */
const LOBBY_PHONE_ROWS = 7

/**
 * The gap between the two plates' inner edges, degrees, seen from the eye:
 * where the head's resting ray lands. Positive means they do not overlap.
 */
export const lobbyGapDeg = (): number => {
  const half = (Math.atan((WIDTH * LOBBY_SCALE) / 2 / LOBBY_DISTANCE) * 180) / Math.PI
  return LOBBY_BEARING_DEG.actions - LOBBY_BEARING_DEG.roster - 2 * half
}

/**
 * Stand `object` at `bearingDeg` off the chair (`seatWorld` is the eye,
 * `seatQuaternion` the chair's forward) and turn it to face the eye. A plane's
 * face is +z and `lookAt` aims +z, so this faces the chair — right for a plane
 * that came through no converter (trap 22).
 */
export const placeLobbyPlate = (
  object: THREE.Object3D,
  bearingDeg: number,
  seatWorld: THREE.Vector3,
  seatQuaternion: THREE.Quaternion,
): void => {
  const [x, y, z] = lobbyPlateOffset(bearingDeg)
  object.position.set(x, y, z).applyQuaternion(seatQuaternion).add(seatWorld)
  object.scale.setScalar(LOBBY_SCALE * (phoneUi.on ? LOBBY_PHONE_BOOST : 1))
  object.lookAt(seatWorld)
}
