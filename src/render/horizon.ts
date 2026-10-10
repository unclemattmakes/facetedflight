// src/render/horizon.ts — a line the inner ear can trust.
//
// PORT_PLAN §2.9 item 2: *"An optional world-locked reference. A faint horizon
// ring or star layer that does not rotate with the ship. The highest-value
// mitigation available for exactly this locomotion pattern, and one draw call.
// Off by default, discoverable in the comfort menu."*
//
// ── Why it works, in one paragraph ───────────────────────────────────────
//
// The nauseogenic pattern here is that the entire visual field rotates while the
// vestibular system reports a head that is sitting still. A reference that stays
// level while the world rolls gives the eye something that AGREES with the inner
// ear, and the conflict has somewhere to resolve. It is the same trick as a
// static cockpit frame (§2.9 item 3) except that it survives a barrel roll,
// which the cockpit does not — the cockpit rolls with you.
//
// ── The geometry is the whole implementation ─────────────────────────────
//
// A horizontal band, centred on the EYE's world position, at the eye's own
// height. A horizontal circle centred on the eye and level with it projects to
// the horizon line from any distance and any altitude — so the radius is free,
// and the band always renders as a level line across the middle of the view
// however the ship is oriented.
//
// It lives in the SCENE ROOT and `update()` takes a POSITION and nothing else.
// That is not a style choice: it is how the module makes the one property it
// exists for — *"does not rotate with the ship"* — true by construction rather
// than by a quaternion somebody has to keep correct. See "the orientation
// lesson" in `docs/DEVIATIONS.md`: **test the geometry, not the rotation**.
// `comfort-horizon.test.ts` measures the world-space bounding box, and it also
// hangs the band under a rolled parent to show that the measurement would
// actually catch the mistake of parenting this to the ship.

import * as THREE from 'three'

/**
 * Band radius, metres. Free, so it is chosen for float precision rather than
 * for looks: near enough that `position` stays well-conditioned 4 km from the
 * origin, far enough that it never reads as an object in the cockpit.
 */
export const RADIUS = 60

/**
 * How thick the band is, in DEGREES of arc — which is the number that matters,
 * because metres at 60 m mean nothing to the eye.
 *
 * A mathematical line is one pixel and disappears under any reprojection.
 * DEV-044's lesson is that a thing too small to see has not been reviewed, it
 * has been rendered — the title jets flew backwards for a whole session at four
 * pixels across. 0.6° is about 8 px at a Quest 3's angular resolution: a
 * definite line, not a hairline, and still a twentieth of the width of your
 * thumb at arm's length.
 */
export const BAND_DEGREES = 0.6

/** Radial segments. 96 is smooth at 0.6° thickness and still one draw call. */
export const SEGMENTS = 96

/** The band's height in metres for a given radius and angular thickness. */
export const bandHeight = (radius: number, degrees: number): number =>
  2 * radius * Math.tan(((degrees / 2) * Math.PI) / 180)

/**
 * Faint. It is a reference, not an instrument, and the failure mode of a
 * too-bright one is that people turn it off — at which point the comfort
 * mitigation is not deployed and you do not find out why.
 */
const COLOUR = 0x9fb4c4
const OPACITY = 0.22

export interface Horizon {
  readonly object: THREE.Object3D
  setVisible(visible: boolean): void
  /**
   * Centre the band on the eye. WORLD position — `camera.getWorldPosition()`,
   * never `camera.position`, which in the cockpit is the head pose inside the
   * XR rig and is the origin until you lean (trap 18).
   *
   * Takes no orientation, and must not grow one.
   */
  update(eyeWorld: Readonly<THREE.Vector3>): void
  dispose(): void
}

export const createHorizon = (): Horizon => {
  const height = bandHeight(RADIUS, BAND_DEGREES)
  // Open-ended: a band, not a drum. `openEnded` is the third boolean and
  // getting it wrong puts a disc over the whole world.
  const geometry = new THREE.CylinderGeometry(RADIUS, RADIUS, height, SEGMENTS, 1, true)

  const material = new THREE.MeshBasicMaterial({
    color: COLOUR,
    transparent: true,
    opacity: OPACITY,
    // Seen from INSIDE, so the outward-facing normals point away. Both sides.
    side: THREE.DoubleSide,
    // The point of the thing is that it is always there to look at. A horizon
    // reference occluded by the ridge you are about to hit is a reference that
    // vanishes during the manoeuvre it exists for. `depthWrite` stays off so it
    // never occludes anything itself.
    depthTest: false,
    depthWrite: false,
    // Not tone-mapped (DEV-081), for the same reason as the vignette: this is a
    // comfort overlay the player switched on, at an authored colour and opacity
    // that were chosen against a frame rather than lit by one. A tone curve
    // moving it on a preset flip would be a comfort setting changing itself.
    toneMapped: false,
    // Never lit. It is an overlay, and a directional light 4° above the horizon
    // (`int_01`'s sun) would make one side of the ring brighter than the other
    // for no reason anybody could read.
    fog: false,
  })

  const object = new THREE.Mesh(geometry, material)
  object.name = 'comfort-horizon'
  // Below the cockpit panels (HUD 11, pause 12) and far below the vignette
  // (10,000): a menu you are reading must not have a line drawn through it.
  object.renderOrder = 5
  // The band is 120 m across and follows the eye, so its bounding sphere is
  // always around the camera — but it is written every frame and three would
  // otherwise recompute the world bounds against a stale matrix on the frame it
  // moves. Cheap, and it removes a class of one-frame pop.
  object.matrixAutoUpdate = true
  object.visible = false

  return {
    object,
    setVisible(visible) {
      object.visible = visible
    },
    update(eyeWorld) {
      object.position.set(eyeWorld.x, eyeWorld.y, eyeWorld.z)
    },
    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}
