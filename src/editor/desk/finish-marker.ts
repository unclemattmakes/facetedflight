// src/editor/desk/finish-marker.ts — the finish, drawn where the slider puts it. DEV-473.
//
// Matt, 2026-09-27: *"i don't know what the start/finish sliders do"*. The
// finish slider moved a small white diamond along the line (DEV-469's
// `editor-finish` in view.ts) and the game's own finish gate followed it once
// the rings were rebuilt, 200 ms after the slider stopped: nothing on screen
// said which of the things over the island was the finish, or that the slider
// was moving it.
//
// So this draws the finish the way a creator reads it, and moves it LIVE with
// the slider:
//
//  · a hoop of the donor finish's own trigger radius (the sphere the run ends
//    in, 68.6 m on every HoverJet sky; read off the level, never typed), stood
//    across the line at the finish, in the finish frame's orange;
//  · a FINISH label over it, a constant size on screen.
//
// The game's gate (`loadRings`, the orange frame and its banner) still arrives
// with the rebuilt rings and stands inside the hoop: this is the editor's
// overlay, not a second finish renderer. Drawn through the ground like every
// other desk overlay (view.ts's header says why), with three's own
// `LineBasicMaterial` and `SpriteMaterial`: no `onBeforeCompile`, nothing
// patched.

import * as THREE from 'three'
import { type CourseSpline, splinePointAt, splineTangentAt } from '@/content/course-spline'
import type { Level } from '@/content/level-schema'
import { PROPS } from '@/generated/constants.generated'

/** Feel, not physics. Pinned by value in `tests/unit/editor-panel.test.ts`. */
export const FINISH_MARKER_POLICY = {
  /** Straight segments in the hoop: round at any zoom the desk frames. */
  hoopSegments: 64,
  /**
   * The label's height in an unattenuated sprite's units: the viewport's
   * height times cot(fov / 2) / 2, so about 1.07x this at the desk's 50° lens.
   * Readable, never a banner.
   */
  labelScreenHeight: 0.035,
  /** The label's canvas, CSS-pixel font size; the texture is drawn at this and scaled on screen. */
  labelFontPixels: 48,
  /** How far above the hoop's top the label sits, as a fraction of the hoop's radius. */
  labelLift: 0.35,
} as const

/** Draw order: over the desk's other overlays (view.ts's OVERLAY_ORDER is 1000). */
const ORDER = 1010

/**
 * The finish's radius, metres: the donor's own finish trigger (the sphere the
 * run ends in). Null where the sky has no finish gate.
 */
export const finishRadiusOf = (donor: Level): number | null =>
  donor.finish?.shape === 'sphereUnion' ? donor.finish.radius : null

export interface FinishMarker {
  readonly object: THREE.Group
  /** Put the finish at path fraction `t` of `spline`, sized by the donor's finish. Null hides it. */
  set(spline: CourseSpline | null, t: number, radius: number | null): void
  /** The drawn centre, level frame, or null when hidden. For the probe: what is ON screen. */
  position(): [number, number, number] | null
  dispose(): void
}

const labelTexture = (text: string): { texture: THREE.CanvasTexture; aspect: number } => {
  const px = FINISH_MARKER_POLICY.labelFontPixels
  const font = `700 ${px}px system-ui, -apple-system, "Segoe UI", sans-serif`
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
  ctx.font = font
  const pad = Math.round(px * 0.4)
  canvas.width = Math.ceil(ctx.measureText(text).width) + pad * 2
  canvas.height = Math.ceil(px * 1.5)
  // The canvas is reset by the resize: set the font again.
  ctx.font = font
  ctx.fillStyle = 'rgba(10,16,24,0.8)'
  ctx.beginPath()
  ctx.roundRect(0, 0, canvas.width, canvas.height, px * 0.3)
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, canvas.width / 2, canvas.height / 2)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return { texture, aspect: canvas.width / canvas.height }
}

export const createFinishMarker = (): FinishMarker => {
  const object = new THREE.Group()
  object.name = 'editor-finish-marker'
  object.visible = false

  const [r, g, b] = PROPS.finishGate.frameColor as readonly number[]
  const colour = new THREE.Color().setRGB(
    r as number,
    g as number,
    b as number,
    THREE.SRGBColorSpace,
  )

  // A unit hoop in its own XY plane; the group turns its +Z along the line.
  const n = FINISH_MARKER_POLICY.hoopSegments
  const ring = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    ring[i * 3] = Math.cos(a)
    ring[i * 3 + 1] = Math.sin(a)
  }
  const hoopGeometry = new THREE.BufferGeometry()
  hoopGeometry.setAttribute('position', new THREE.BufferAttribute(ring, 3))
  const hoopMaterial = new THREE.LineBasicMaterial({
    color: colour,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.95,
    fog: false,
  })
  const hoop = new THREE.LineLoop(hoopGeometry, hoopMaterial)
  hoop.name = 'editor-finish-hoop'
  hoop.renderOrder = ORDER
  hoop.frustumCulled = false
  object.add(hoop)

  const { texture, aspect } = labelTexture('FINISH')
  const labelMaterial = new THREE.SpriteMaterial({
    map: texture,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    fog: false,
    // A constant size on screen, whatever the zoom.
    sizeAttenuation: false,
  })
  const label = new THREE.Sprite(labelMaterial)
  label.name = 'editor-finish-label'
  label.renderOrder = ORDER + 1
  label.frustumCulled = false
  const h = FINISH_MARKER_POLICY.labelScreenHeight
  label.scale.set(h * aspect, h, 1)
  // Its own anchor at the bottom centre, so it stands ON the hoop.
  label.center.set(0.5, 0)
  object.add(label)

  const _pos = new THREE.Vector3()
  const _dir = new THREE.Vector3()
  const _up = new THREE.Vector3(0, 1, 0)
  const _m = new THREE.Matrix4()

  return {
    object,
    set(spline, t, radius) {
      if (!spline || !(spline.length > 0)) {
        object.visible = false
        return
      }
      const s = Math.min(1, Math.max(0, t)) * spline.length
      const p = splinePointAt(spline, s)
      const d = splineTangentAt(spline, s)
      _pos.set(p.x, p.y, p.z)
      _dir.set(d.x, d.y, d.z)
      if (_dir.lengthSq() < 1e-12) _dir.set(0, 0, -1)
      _dir.normalize()
      object.position.copy(_pos)
      // +Z along the line: the hoop (in XY) stands across it, as the gate does.
      // A vertical line has no "up" to keep; any roll reads the same for a circle.
      const up = Math.abs(_dir.y) > 0.999 ? new THREE.Vector3(1, 0, 0) : _up
      _m.lookAt(new THREE.Vector3(0, 0, 0), _dir.clone().negate(), up)
      object.quaternion.setFromRotationMatrix(_m)
      const rad = radius ?? 0
      hoop.visible = rad > 0
      hoop.scale.setScalar(rad > 0 ? rad : 1)
      // The label stands over the hoop's top in the group's own frame, so it
      // rides with the gate; a sprite faces the camera whatever the group does.
      label.position.set(0, (rad > 0 ? rad : 0) * (1 + FINISH_MARKER_POLICY.labelLift), 0)
      object.visible = true
    },
    position() {
      return object.visible ? [object.position.x, object.position.y, object.position.z] : null
    },
    dispose() {
      object.removeFromParent()
      hoopGeometry.dispose()
      hoopMaterial.dispose()
      labelMaterial.dispose()
      texture.dispose()
    },
  }
}
