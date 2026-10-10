// src/render/next-gate-arrow.ts — a paper-cut arrow on the glareshield that
// points at the next gate. DEV-124, Anniversary `hud.nextGateArrow`.
//
// Matt, 2026-09-16: *"i could use a 'next gate' indicator arrow towards the
// front of the cockpit to help me understand where to fly."*
//
// ── Where it lives ────────────────────────────────────────────────────────
//
// On the SHIP's group, beside the HUD — not on the camera rig. `render/hud.ts`
// says why: a head-locked instrument follows the eyes and removes the fixed
// reference the vestibular system is trying to agree with. Bolted to the dash
// it stays where the dash is, and a moving head looks AT it. The rig is never
// moved for it and the cockpit mesh is never rescaled around it (ART_DIRECTION
// pillar 3); the arrow is one more object in the ship's frame, 0.8 m ahead of
// the eye and a hand's width below the sightline, where the glareshield is.
//
// ── What it says ──────────────────────────────────────────────────────────
//
// The BEARING to the target, in the ship's own frame: the arrow's base-to-tip
// line is parallel to the line from its mount to the target. Nothing else — no
// distance, no count. And it says it only when it is worth saying: inside
// `coneDegrees` of the nose the target is in front of you and the arrow hides,
// growing back in over `featherDegrees` so a gate drifting across the cone's
// edge never blinks it (ANNIVERSARY's rule against a second thing moving in
// the frame).
//
// ── The orientation lesson, applied before the fact ───────────────────────
//
// The aim is `setFromUnitVectors(ARROW_AXIS, direction)` — a rotation DEFINED by
// the two vectors, with no convention in it to get wrong. The test does not
// check that quaternion; it reads the `base` and `tip` markers back through the
// scene graph and measures the angle between (tip - base) and the bearing.
// A distance is true independently of what anyone believed.
//
// ── Register ──────────────────────────────────────────────────────────────
//
// A flat-shaded shaft and a four-sided pyramid head: faceted, one colour per
// face, no texture (pillar 2). Emissive, because it is an instrument lamp and
// is read in a canyon's shade as often as in sun — the same allowance as the
// dash (DEV-088). Colour and glow come from the preset; nothing here is a
// number to tune.

import * as THREE from 'three'
import type { EditionNextGateArrow } from '@/content/edition-schema'

/** The arrow points along its own +z when unrotated. Base at the origin, tip at +length. */
export const ARROW_AXIS = new THREE.Vector3(0, 0, 1)
/** The ship's nose, three space: a Unity-forward body arrives travelling along -z. */
export const SHIP_FORWARD = new THREE.Vector3(0, 0, -1)

/** Shaft length as a fraction of the whole; the pyramid head takes the rest. */
const SHAFT_FRACTION = 0.55
/** Shaft thickness, and head half-width, as fractions of the whole length. */
const SHAFT_WIDTH = 0.16
const HEAD_RADIUS = 0.3

export interface NextGateArrow {
  /** Parent this to the SHIP. `update` positions it from the preset's offset. */
  readonly object: THREE.Group
  /**
   * Aim at `target`, given in the SHIP's local frame (three space), from the
   * eye at `eye` (same frame). Null hides the arrow — no target, or the flag
   * is off. Reads the spec live, so a preset flip takes on the next frame.
   */
  update(target: THREE.Vector3 | null, eye: THREE.Vector3, spec: EditionNextGateArrow): void
  dispose(): void
}

/**
 * How much of the arrow shows for a target `angleDeg` off the nose: 0 inside
 * the cone, 1 past the feather, linear between. Exported for the test.
 */
export const arrowGrowth = (angleDeg: number, spec: EditionNextGateArrow): number => {
  const past = angleDeg - spec.coneDegrees
  if (past <= 0) return 0
  if (!(spec.featherDegrees > 0)) return 1
  return past >= spec.featherDegrees ? 1 : past / spec.featherDegrees
}

export const createNextGateArrow = (): NextGateArrow => {
  const object = new THREE.Group()
  object.name = 'next-gate-arrow'
  object.visible = false

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xffffff,
    emissiveIntensity: 0,
    roughness: 1,
    metalness: 0,
    // Flat shading: one normal per face, hard creases, a paper cut.
    flatShading: true,
  })

  // Unit length. The group's scale is the preset's `lengthMetres` times the
  // feather's growth, so both the size and the fade are one number each.
  const shaft = new THREE.Mesh(
    new THREE.BoxGeometry(SHAFT_WIDTH, SHAFT_WIDTH, SHAFT_FRACTION),
    material,
  )
  shaft.position.z = SHAFT_FRACTION / 2
  const headLength = 1 - SHAFT_FRACTION
  // A cone with FOUR radial segments is a pyramid. Its axis is +y; rotate it
  // onto +z so the apex is the tip.
  const headGeometry = new THREE.ConeGeometry(HEAD_RADIUS, headLength, 4)
  headGeometry.rotateX(Math.PI / 2)
  const head = new THREE.Mesh(headGeometry, material)
  head.position.z = SHAFT_FRACTION + headLength / 2
  object.add(shaft, head)

  // The two markers the test measures. Empty objects, drawn as nothing.
  const base = new THREE.Object3D()
  base.name = 'base'
  const tip = new THREE.Object3D()
  tip.name = 'tip'
  tip.position.z = 1
  object.add(base, tip)

  const direction = new THREE.Vector3()
  const colour = new THREE.Color()

  return {
    object,
    update(target, eye, spec) {
      if (!spec.enabled || !target) {
        object.visible = false
        return
      }
      const offset = spec.offset
      object.position.set(
        eye.x + (offset[0] as number),
        eye.y + (offset[1] as number),
        eye.z + (offset[2] as number),
      )
      // Bearing from the MOUNT, so the arrow's own line is what is parallel to
      // the sightline — not a line from some other point in the ship.
      direction.copy(target).sub(object.position)
      const distance = direction.length()
      if (!(distance > 0)) {
        object.visible = false
        return
      }
      direction.divideScalar(distance)
      const angleDeg = THREE.MathUtils.radToDeg(
        Math.acos(THREE.MathUtils.clamp(direction.dot(SHIP_FORWARD), -1, 1)),
      )
      const growth = arrowGrowth(angleDeg, spec)
      if (growth <= 0) {
        object.visible = false
        return
      }
      object.visible = true
      object.quaternion.setFromUnitVectors(ARROW_AXIS, direction)
      object.scale.setScalar(spec.lengthMetres * growth)
      colour.setRGB(spec.color[0] as number, spec.color[1] as number, spec.color[2] as number)
      material.color.copy(colour)
      material.emissive.copy(colour)
      material.emissiveIntensity = spec.emissive
    },
    dispose() {
      shaft.geometry.dispose()
      headGeometry.dispose()
      material.dispose()
    },
  }
}
