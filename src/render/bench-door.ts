// src/render/bench-door.ts — EDIT ON THE BENCH: the VR bench's door in the
// hangar. DEV-492 (EDITOR.md §5.3, "On the bench (headset)").
//
// A plate at the seated player's lap, in front of the chair on the seat's own
// resting bearing: exactly where the bench's island will stand when it opens,
// so the door is the bench folded away. Headset only, and only where the build
// has the editor (the MENUS' `gameplay.editor`, D35); `boot/app.ts` decides
// when it stands. The room's own flow (`hangar.ts`, the fleet lead's) is not
// touched: the plate is furniture in the room's frame, as the lobby's plates
// are, and the laser aims it the way it aims those.
//
// Why here and not on the title's COURSES hub or the YOUR COURSES shelf: a
// headset session has no way back from the room to the title, and the shelf
// stands only once the library holds a course, so a first-time maker could
// reach neither. Low, so no ray from a hand or a head to a table on the arc
// crosses it (the tables stand 1.43 m out, their tops 0.7 m under the eye; this
// stands 0.62 m out and 0.72 m under it).
//
// UI: `toneMapped: false` puts it on `UI_LAYER` (3), both eyes, never layer 1
// or 2 (DEV-141); its hit is plane arithmetic, not three's raycaster (which
// tests layer 0 only, DEV-472).

import * as THREE from 'three'
import { type PlaneHit, rayPlaneHit } from '@/render/ui-pick'
import {
  UI_ACCENT,
  UI_DIM,
  UI_INK,
  UI_PLATE,
  UI_PLATE_EDGE,
  UI_SELECTED_FILL,
  uiFont,
} from '@/render/ui-tokens'

/** Where the door stands, from the seated eye along the seat's bearing, metres. Pinned in the bench's test. */
export const BENCH_DOOR = {
  reach: 0.62,
  belowEye: 0.72,
  width: 0.4,
  aspect: 3.4,
} as const

export interface BenchDoor {
  readonly object: THREE.Mesh
  /** Light it, or not. */
  setAimed(aimed: boolean): void
  /** How far along a WORLD ray (unit direction) it is hit, world metres, or null. */
  hit(origin: THREE.Vector3, direction: THREE.Vector3): number | null
  dispose(): void
}

/** Stand the door in the room's frame, before the seat at `eye` looking along `bearing`. */
export const createBenchDoor = (
  eye: { readonly x: number; readonly y: number; readonly z: number },
  bearing: number,
): BenchDoor => {
  const width = BENCH_DOOR.width
  const height = width / BENCH_DOOR.aspect
  const canvas = document.createElement('canvas')
  canvas.width = 680
  canvas.height = 200
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    toneMapped: false,
    side: THREE.DoubleSide,
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material)
  mesh.name = 'bench-door'
  mesh.position.set(
    eye.x + Math.sin(bearing) * BENCH_DOOR.reach,
    eye.y - BENCH_DOOR.belowEye,
    eye.z - Math.cos(bearing) * BENCH_DOOR.reach,
  )
  // Face the eye: turned to the seat (`labelYaw`), then tipped back toward it.
  mesh.rotation.order = 'YXZ'
  mesh.rotation.set(-Math.atan2(BENCH_DOOR.belowEye, BENCH_DOOR.reach), -bearing, 0)

  let lit: boolean | null = null
  const paint = (aimed: boolean): void => {
    if (lit === aimed) return
    lit = aimed
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const W = canvas.width
    const H = canvas.height
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = UI_PLATE
    ctx.fillRect(0, 0, W, H)
    if (aimed) {
      ctx.fillStyle = UI_SELECTED_FILL
      ctx.fillRect(0, 0, W, H)
    }
    ctx.strokeStyle = aimed ? UI_ACCENT : UI_PLATE_EDGE
    ctx.lineWidth = aimed ? 8 : 4
    ctx.strokeRect(4, 4, W - 8, H - 8)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = aimed ? UI_ACCENT : UI_INK
    ctx.font = uiFont(54)
    ctx.fillText('EDIT ON THE BENCH', W / 2, H * 0.4, W - 40)
    ctx.fillStyle = UI_DIM
    ctx.font = uiFont(30, 500)
    ctx.fillText('shape a course on the island', W / 2, H * 0.74, W - 40)
    texture.needsUpdate = true
  }
  paint(false)

  const _inv = new THREE.Matrix4()
  const _o = new THREE.Vector3()
  const _d = new THREE.Vector3()
  const _hit = new THREE.Vector3()
  const _local: PlaneHit = { x: 0, y: 0 }

  return {
    object: mesh,
    setAimed: paint,
    hit(origin, direction) {
      if (!mesh.visible) return null
      // Stale inside the XR frame until render (CLAUDE.md): recompose first.
      mesh.updateWorldMatrix(true, false)
      _inv.copy(mesh.matrixWorld).invert()
      _o.copy(origin).applyMatrix4(_inv)
      _d.copy(origin).add(direction).applyMatrix4(_inv).sub(_o)
      // The local direction carries the door's scale, so it is not a unit vector:
      // its own epsilon (`ui-pick.ts`).
      if (!rayPlaneHit(_local, _o.x, _o.y, _o.z, _d.x, _d.y, _d.z, 1e-9)) return null
      const { x, y } = _local
      if (Math.abs(x) > width / 2 || Math.abs(y) > height / 2) return null
      _hit.set(x, y, 0).applyMatrix4(mesh.matrixWorld)
      return _hit.distanceTo(origin)
    },
    dispose() {
      texture.dispose()
      material.dispose()
      mesh.geometry.dispose()
    },
  }
}
