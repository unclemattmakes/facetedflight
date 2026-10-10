// src/editor/desk/recording.ts — the last recorded flight, drawn. DEV-491.
//
// Back from *Record a flight*, the fit has made the line (`core/fit.ts`), and
// the flight it was made from is drawn under it: the line the author flew, in
// the flight's own colour, with the fitted course line (white, `view.ts`) over
// it. EDITOR.md §5.3 step 4: *"back at the bench exactly where you left it,
// with your line and your last test flight drawn on the island."* It stays
// until another recording replaces it or a new draft is opened.
//
// Drawn as the rest of the overlay is: through the ground (no depth test), one
// `LineBasicMaterial`, three's own program, nothing patched.

import * as THREE from 'three'
import type { Vec3Tuple } from '@/content/level-schema'

/** The flight's colour: a sky blue, apart from the course line's white and the warnings' red. */
const FLIGHT_COLOUR = 0x4fc3ff
/** Under the course line (`view.ts` draws the overlay from 1000). */
const FLIGHT_ORDER = 999

export interface DeskRecording {
  readonly object: THREE.Line
  /** Draw `points` (level frame), or nothing. */
  set(points: readonly Vec3Tuple[] | null): void
  /** The points drawn, read back off the buffer. */
  points(): [number, number, number][]
  dispose(): void
}

export const createDeskRecording = (): DeskRecording => {
  const geometry = new THREE.BufferGeometry()
  const material = new THREE.LineBasicMaterial({
    color: FLIGHT_COLOUR,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.9,
    fog: false,
  })
  const object = new THREE.Line(geometry, material)
  object.name = 'editor-recorded-flight'
  object.renderOrder = FLIGHT_ORDER
  object.frustumCulled = false
  object.visible = false
  return {
    object,
    set(points) {
      const n = points?.length ?? 0
      const a = new Float32Array(n * 3)
      for (let i = 0; i < n; i++) {
        const p = (points as readonly Vec3Tuple[])[i] as Vec3Tuple
        a[i * 3] = p[0]
        a[i * 3 + 1] = p[1]
        a[i * 3 + 2] = p[2]
      }
      geometry.setAttribute('position', new THREE.BufferAttribute(a, 3))
      geometry.computeBoundingSphere()
      object.visible = n >= 2
    },
    points() {
      const attr = geometry.getAttribute('position') as THREE.BufferAttribute | undefined
      if (!attr) return []
      const out: [number, number, number][] = []
      for (let i = 0; i < attr.count; i++) out.push([attr.getX(i), attr.getY(i), attr.getZ(i)])
      return out
    },
    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}
