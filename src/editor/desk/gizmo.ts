// src/editor/desk/gizmo.ts: the desk's transform gizmo and the debug probes that
// read it. One setup for the player-course desk (`index.ts`) and the
// shipped-mission desk (`shipped.ts`), which had each written it out: the
// proxy, the controls, the helper, DEV-472's raycaster layers, `gizmoParts`,
// and the four `gizmo*` probes plus `ringGeometry` (code-reuse XC-12).
//
// The two copies had already drifted. `index.ts`'s `gizmoHandle` reads the
// SCALE handles under the R tool (DEV-570) and `shipped.ts` kept reading
// `picker.translate`. The shipped desk has no scale tool, so its gizmo is never
// in scale mode and the two answered alike; with one function they cannot part
// again.

import * as THREE from 'three'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import type { LoadedRings } from '@/game/rings'
import type { DeskDebug } from './host'
import type { ScreenPoint } from './pick'

/** The gizmo's drawn handles and its pickers, by mode (the spec's probes read them). */
type GizmoParts = Record<'gizmo' | 'picker', Partial<Record<string, THREE.Object3D>>>

export interface DeskGizmo {
  /** The object the gizmo is attached to; the host moves it to the picked thing. */
  readonly proxy: THREE.Object3D
  readonly gizmo: TransformControls
  /** three keeps the meshes on a private field; a rename in a three upgrade fails the probes loudly. */
  parts(): GizmoParts
  /** DEV-472, DEV-475, DEV-570: the probes the editor specs aim the mouse by. */
  debugHooks(
    screenOf: (x: number, y: number, z: number) => ScreenPoint | null,
  ): Pick<DeskDebug, 'gizmoHandle' | 'gizmoColour' | 'gizmoRing' | 'gizmoLayers'>
}

/** Build the gizmo and its target under `root`. The host adds its own event listeners. */
export const createDeskGizmo = (
  camera: THREE.Camera,
  canvas: HTMLElement,
  root: THREE.Object3D,
): DeskGizmo => {
  const proxy = new THREE.Object3D()
  proxy.name = 'editor-gizmo-target'
  root.add(proxy)
  const gizmo = new TransformControls(camera, canvas)
  gizmo.setMode('translate')
  const helper = gizmo.getHelper()
  helper.name = 'editor-gizmo'
  root.add(helper)
  // DEV-472: THE GIZMO'S PICKER IS NOT ON LAYER 0, SO ITS RAY MUST SEE EVERY
  // LAYER. Every one of TransformControls' materials is `toneMapped: false`
  // (three's own, for an unlit tool), and on Anniversary `render/bloom.ts`'s
  // `classify` moves every such object onto `UI_LAYER` on its first frame:
  // the arrows AND the invisible picker meshes AND the drag plane. The
  // controls' raycaster tests layer 0 only (`Raycaster.layers` defaults to it),
  // so from the first bloom frame the hover hit nothing: no highlight, no
  // `axis`, and so no drag. The arrows still DREW, because the camera enables
  // `UI_LAYER`. Classic (bloom off) never moved them, and the gizmo worked
  // there. The raycaster is the gizmo's own and it tests only the gizmo's own
  // picker and plane, so every layer is the right mask for it on either look.
  gizmo.getRaycaster().layers.enableAll()
  const parts = (): GizmoParts => (gizmo as unknown as { _gizmo: GizmoParts })._gizmo

  const debugHooks: DeskGizmo['debugHooks'] = (screenOf) => ({
    // DEV-472: the gizmo, read off its own meshes.
    gizmoHandle: (axis) => {
      if (gizmo.object === undefined) return null
      const centre = proxy.getWorldPosition(new THREE.Vector3())
      const along = new THREE.Vector3(
        axis === 'X' ? 1 : 0,
        axis === 'Y' ? 1 : 0,
        axis === 'Z' ? 1 : 0,
      )
      let best: THREE.Vector3 | null = null
      let bestAlong = Number.NEGATIVE_INFINITY
      // DEV-570: the scale tool's handles under R, the arrows otherwise.
      const mode = gizmo.mode === 'scale' ? 'scale' : 'translate'
      for (const piece of parts().picker[mode]?.children ?? []) {
        if (piece.name !== axis) continue
        const c = new THREE.Box3().setFromObject(piece).getCenter(new THREE.Vector3())
        const a = c.clone().sub(centre).dot(along)
        if (a > bestAlong) {
          bestAlong = a
          best = c
        }
      }
      return best ? screenOf(best.x, best.y, best.z) : null
    },
    gizmoColour: (axis) => {
      for (const piece of parts().gizmo.translate?.children ?? []) {
        const mesh = piece as THREE.Mesh
        if (mesh.name === axis && mesh.isMesh) {
          return (mesh.material as THREE.MeshBasicMaterial).color.getHex()
        }
      }
      return null
    },
    // DEV-475: where to put the mouse to grab the rotate gizmo's Y ring: a
    // point ON its picker torus (three bakes the ring into the XZ plane of
    // the picker's frame, radius 0.5), read off the mesh as last drawn.
    gizmoRing: () => {
      if (gizmo.object === undefined || gizmo.mode !== 'rotate') return null
      for (const piece of parts().picker.rotate?.children ?? []) {
        if (piece.name !== 'Y') continue
        piece.updateWorldMatrix(true, false)
        const at = piece.localToWorld(new THREE.Vector3(0.5, 0, 0))
        return screenOf(at.x, at.y, at.z)
      }
      return null
    },
    gizmoLayers: () => ({
      picker: [...new Set((parts().picker.translate?.children ?? []).map((p) => p.layers.mask))],
      ray: gizmo.getRaycaster().layers.mask,
    }),
  })

  return { proxy, gizmo, parts, debugHooks }
}

/**
 * The drawn rings as geometry: each instance's centre and the unit normal of
 * its thinnest extent (the opening's axis), from the INSTANCE MATRICES and the
 * mesh's own bounds, not from the level's quaternions.
 */
export const ringGeometryOf = (
  rings: LoadedRings | null,
): { centre: [number, number, number]; normal: [number, number, number] }[] => {
  if (!rings) return []
  const mesh = rings.object.getObjectByName('rings') as THREE.InstancedMesh | undefined
  if (!mesh?.isInstancedMesh) return []
  mesh.geometry.computeBoundingBox()
  const box = mesh.geometry.boundingBox as THREE.Box3
  const size = box.getSize(new THREE.Vector3())
  // The thinnest extent of the mesh itself is the frame's depth: its
  // opening's axis. Read off the geometry, not off a belief about it.
  const axis =
    size.x <= size.y && size.x <= size.z
      ? new THREE.Vector3(1, 0, 0)
      : size.y <= size.z
        ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(0, 0, 1)
  const centreLocal = box.getCenter(new THREE.Vector3())
  const out: { centre: [number, number, number]; normal: [number, number, number] }[] = []
  const m = new THREE.Matrix4()
  mesh.updateWorldMatrix(true, false)
  for (let i = 0; i < rings.count; i++) {
    mesh.getMatrixAt(i, m)
    m.premultiply(mesh.matrixWorld)
    const centre = centreLocal.clone().applyMatrix4(m)
    const tip = centreLocal.clone().add(axis).applyMatrix4(m)
    const normal = tip.sub(centre).normalize()
    out.push({ centre: centre.toArray(), normal: normal.toArray() })
  }
  return out
}
