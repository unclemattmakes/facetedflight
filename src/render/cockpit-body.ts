// src/render/cockpit-body.ts — a pilot in the seat, built rather than bought.
//
// ── Why this is not the 2016 asset ────────────────────────────────────────
//
// 2016 rendered a body and a chair, and research 05's comfort inventory counts
// "a rendered pilot body" among the things that made the cockpit tolerable. The
// two objects are `pilot_scifi_rigged` (a Mixamo humanoid, ~60 bones) and
// `MM_Commander_Chair_01` (a `Materialized Mesh` bake of bought geometry).
// **Neither can ship** — CLAUDE.md rule 7: baking a texture into vertex colours
// does not launder someone else's topology, and R2 is a public CDN, not a
// vault. So this is a first-party stand-in in the game's own idiom: flat faces,
// one colour per face, four colours, and a vertex budget under a thousand.
//
// ── Where it sits, and how we know ────────────────────────────────────────
//
// Everything here is expressed **relative to the eye**, because that is how
// research 05 §3.1 measured it and because the eye is the one point the player
// occupies. In ship space (three's, so −z is forward and the z of every Unity
// number is flipped):
//
//   `CameraRoot_FirstPerson`  (0, 0.860, −1.270) Unity = the eye
//   `MM_Commander_Chair_01`   (0.020, −0.462, −1.265) Unity
//                             -> **1.322 m below the eye**, 5 mm behind it
//
// and, independently, composing the chain down to the Mixamo pilot —
// `art_pivot` -> `Art` -> `FirstPerson` (scaled 0.98 in y) -> `pilot_scifi_rigged`
// at local y 0.57941 — puts the PILOT's mesh origin at **1.323 m below the eye**.
//
// **Two assets authored separately land 1 mm apart, so that plane is the cockpit
// FLOOR** — a Mixamo rig's origin is between the feet, and a chair's is under
// it. That is the one anchor here that is measured rather than chosen, and it
// is the one the tests hold: `FLOOR_BELOW_EYE`.
//
// It also closes: 1.322 m from the floor to a seated eye is ordinary seated
// anthropometry for an adult in a 0.50 m seat, which is what the proportions
// below reconstruct. The agreement lesson says a rule checked only where two
// explanations agree has not been checked — so note that these two readings
// agree on the FLOOR and say nothing about the seat pan. The pan is chosen, and
// what makes it defensible is that the shin it implies (`FLOOR_BELOW_EYE` minus
// `PAN_BELOW_EYE` = 0.502 m) is a human shin. `cockpit-body.test.ts` asserts
// that relationship rather than the number.
//
// ── What it must never do ─────────────────────────────────────────────────
//
// Sit at or above the eye line, leave the hull, or come inside the 0.08 m near
// plane. All three are tests, and all three are measured off the geometry that
// is actually built — not off the transforms it was built from, because a
// quaternion assertion is your belief written twice (the orientation lesson).

import * as THREE from 'three'
import type { EditionCockpitBody } from '@/content/edition-schema'

/**
 * The cockpit floor, in metres below the eye. **MEASURED** — see the header.
 *
 * The chair's mesh origin is 1.322 m below the eye and the pilot's is 1.323 m
 * below it, from two independent transform chains in the same prefab. The boots
 * stand on it.
 */
export const FLOOR_BELOW_EYE = 1.322

/**
 * The seat pan, in metres below the eye. **CHOSEN**, and the shin is why.
 *
 * `FLOOR_BELOW_EYE - PAN_BELOW_EYE` is 0.502 m, which is a shin plus a boot
 * sole for an adult. Move this and the legs still close, because every joint
 * below is derived from it — but move it far and the test that says so fails.
 */
const PAN_BELOW_EYE = 0.82

/** Seated shoulder, in metres below the eye. The torso stops here. */
const SHOULDER_BELOW_EYE = 0.305

/** Half the hip width, and half the shoulder width. Metres. */
const HIP_RADIUS = 0.2
const CHEST_RADIUS = 0.225

/** Centre-to-centre separation of the two legs. Metres. */
const LEG_SPLIT = 0.135

/** Limb radii. Metres. A thigh is thicker than a shin; both are cylinders. */
const THIGH_RADIUS = 0.088
const SHIN_RADIUS = 0.068
const ARM_RADIUS = 0.052

/**
 * The joints, as POINTS in eye-local ship space (three: −z forward, +y up).
 *
 * Points rather than angles, and limbs drawn BETWEEN two of them, for the
 * reason `game/jumpseat-flight.ts` gives about its legs: a pair of endpoints is
 * the same geometry in either handedness, so the z-flip cannot swing a limb
 * backwards and a test can assert a DISTANCE. Four orientation bugs in this
 * port, three of them caught from a screenshot rather than by a green suite.
 */
const JOINTS = {
  hip: (side: number) => new THREE.Vector3(side * LEG_SPLIT, -PAN_BELOW_EYE + 0.07, -0.09),
  knee: (side: number) => new THREE.Vector3(side * (LEG_SPLIT + 0.01), -0.78, -0.52),
  ankle: (side: number) => new THREE.Vector3(side * (LEG_SPLIT + 0.01), -1.272, -0.46),
  shoulder: (side: number) => new THREE.Vector3(side * 0.215, -SHOULDER_BELOW_EYE, 0.02),
  elbow: (side: number) => new THREE.Vector3(side * 0.225, -0.56, -0.1),
} as const

/** The right hand's grip on the centre stick, and the left's on the throttle. */
const STICK_GRIP = new THREE.Vector3(0.0, -0.6, -0.3)
const THROTTLE_GRIP = new THREE.Vector3(-0.285, -0.73, -0.16)
/** The stick's heel, where it enters the console between the knees. */
const STICK_HEEL = new THREE.Vector3(0.0, -0.95, -0.3)

export interface CockpitBody {
  /**
   * The body. Its own origin is the EYE, so the caller parents it to a node
   * placed at `EYE` under the art pivot and nowhere else — `render/cockpit-
   * interior.ts` is that caller. Its `position` is the preset's trim offset.
   */
  readonly object: THREE.Object3D
  /** Show or hide, and re-colour, from the live preset. Cheap; call on a flip. */
  set(body: EditionCockpitBody): void
  dispose(): void
}

/** Linear RGB off the preset, straight onto a `THREE.Color`. */
const linear = (rgb: readonly number[]): THREE.Color =>
  new THREE.Color().setRGB(rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0, THREE.LinearSRGBColorSpace)

const _up = new THREE.Vector3(0, 1, 0)

/**
 * A limb between two points: a unit cylinder scaled to the span and aimed.
 *
 * The primitive is symmetric about its own axis, so aiming it by a direction is
 * the one case where "which way does it face" cannot be wrong in a way anyone
 * could see — trap 22 is about aiming an ASYMMETRIC imported mesh, and this is
 * neither imported nor asymmetric.
 */
const limb = (
  from: THREE.Vector3,
  to: THREE.Vector3,
  radius: number,
  taper: number,
  material: THREE.Material,
  name: string,
): THREE.Mesh => {
  const span = new THREE.Vector3().subVectors(to, from)
  const length = span.length()
  // Five sides, not thirty-two: this is a faceted game and a smooth limb would
  // be the one round thing in the frame.
  const geometry = new THREE.CylinderGeometry(radius * taper, radius, length, 5, 1)
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = name
  mesh.position.copy(from).addScaledVector(span, 0.5)
  mesh.quaternion.setFromUnitVectors(_up, span.normalize())
  return mesh
}

const box = (
  w: number,
  h: number,
  d: number,
  at: THREE.Vector3 | [number, number, number],
  material: THREE.Material,
  name: string,
): THREE.Mesh => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material)
  if (Array.isArray(at)) mesh.position.set(at[0], at[1], at[2])
  else mesh.position.copy(at)
  mesh.name = name
  return mesh
}

/**
 * Build the seat, the pilot in it, and — optionally — the hands on the controls.
 *
 * Exported and testable headlessly on purpose. The title jets flew backwards for
 * a whole session at four pixels across; "it renders" is not review, and the
 * only way to check a thing this small is to build the meshes and measure where
 * they land.
 */
export const buildCockpitBody = (): CockpitBody => {
  const object = new THREE.Group()
  object.name = 'cockpit_body'
  const disposables: { dispose(): void }[] = []

  const seatMat = new THREE.MeshStandardMaterial({ roughness: 0.85, flatShading: true })
  const trimMat = new THREE.MeshStandardMaterial({ roughness: 0.7, flatShading: true })
  const suitMat = new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true })
  const gloveMat = new THREE.MeshStandardMaterial({ roughness: 0.75, flatShading: true })
  disposables.push(seatMat, trimMat, suitMat, gloveMat)

  // ── the seat ────────────────────────────────────────────────────────────
  //
  // 2016's chair sits 5 mm behind the eye in z, which is to say directly under
  // it: this is an upright seat, not a recumbent one, and the pan is centred on
  // the eye rather than pushed forward.
  const parts: THREE.Object3D[] = [
    box(0.44, 0.07, 0.42, [0, -PAN_BELOW_EYE, 0], seatMat, 'seat_pan'),
    box(0.44, 0.56, 0.08, [0, -PAN_BELOW_EYE + 0.28, 0.25], seatMat, 'seat_back'),
    box(0.07, 0.11, 0.4, [0.235, -PAN_BELOW_EYE + 0.06, 0], trimMat, 'seat_bolster_r'),
    box(0.07, 0.11, 0.4, [-0.235, -PAN_BELOW_EYE + 0.06, 0], trimMat, 'seat_bolster_l'),
    // The pedestal carries the pan down to the floor the boots stand on, which
    // is the measured plane and the one thing in here that is not taste.
    box(
      0.26,
      FLOOR_BELOW_EYE - PAN_BELOW_EYE,
      0.34,
      [0, -(PAN_BELOW_EYE + FLOOR_BELOW_EYE) / 2, 0.02],
      seatMat,
      'seat_pedestal',
    ),
    // ── the pilot ────────────────────────────────────────────────────────
    //
    // Hip to chest as one tapered six-sided drum. There is NO head and no neck:
    // the eye is inside where a head would be, and a skull rendered around the
    // near plane is the one way this feature could make somebody ill.
    limb(
      new THREE.Vector3(0, -PAN_BELOW_EYE + 0.04, -0.04),
      new THREE.Vector3(0, -SHOULDER_BELOW_EYE, 0.0),
      HIP_RADIUS,
      CHEST_RADIUS / HIP_RADIUS,
      suitMat,
      'pilot_torso',
    ),
  ]

  for (const side of [1, -1]) {
    const tag = side > 0 ? 'r' : 'l'
    parts.push(
      limb(JOINTS.hip(side), JOINTS.knee(side), THIGH_RADIUS, 0.86, suitMat, `pilot_thigh_${tag}`),
      limb(JOINTS.knee(side), JOINTS.ankle(side), SHIN_RADIUS, 0.95, suitMat, `pilot_shin_${tag}`),
      // The boot's sole lands exactly on the measured floor.
      box(
        0.15,
        0.1,
        0.28,
        [side * (LEG_SPLIT + 0.01), -FLOOR_BELOW_EYE + 0.05, -0.5],
        gloveMat,
        `pilot_boot_${tag}`,
      ),
    )
  }

  // ── the controls, and the hands on them ─────────────────────────────────
  //
  // Optional (`cockpit.body.hands`) because arms are the part of a procedural
  // body that goes wrong first: a limb that misses its grip reads as a broken
  // puppet, and a body that is wrong is worse than none. The seat and the legs
  // stand on their own without this block.
  const armGroup = new THREE.Group()
  armGroup.name = 'cockpit_body_arms'
  armGroup.add(
    limb(STICK_HEEL, STICK_GRIP, 0.024, 1, trimMat, 'control_stick'),
    box(0.07, 0.09, 0.07, STICK_GRIP, gloveMat, 'control_stick_grip'),
    box(
      0.06,
      0.06,
      0.26,
      THROTTLE_GRIP.clone().add(new THREE.Vector3(0, -0.02, 0.02)),
      trimMat,
      'control_throttle',
    ),
  )
  for (const side of [1, -1]) {
    const tag = side > 0 ? 'r' : 'l'
    const grip = side > 0 ? STICK_GRIP : THROTTLE_GRIP
    armGroup.add(
      limb(
        JOINTS.shoulder(side),
        JOINTS.elbow(side),
        ARM_RADIUS,
        0.9,
        suitMat,
        `pilot_upperarm_${tag}`,
      ),
      limb(JOINTS.elbow(side), grip, ARM_RADIUS * 0.9, 0.92, suitMat, `pilot_forearm_${tag}`),
      box(0.08, 0.08, 0.11, grip, gloveMat, `pilot_hand_${tag}`),
    )
  }
  parts.push(armGroup)

  for (const part of parts) {
    object.add(part)
    part.traverse((node) => {
      const mesh = node as THREE.Mesh
      if (mesh.isMesh) disposables.push(mesh.geometry)
    })
  }

  return {
    object,
    set(body) {
      object.visible = body.enabled
      armGroup.visible = body.hands
      seatMat.color.copy(linear(body.palette.seat))
      trimMat.color.copy(linear(body.palette.trim))
      suitMat.color.copy(linear(body.palette.suit))
      gloveMat.color.copy(linear(body.palette.glove))
      object.position.set(body.offset[0] ?? 0, body.offset[1] ?? 0, body.offset[2] ?? 0)
    },
    dispose() {
      for (const d of disposables) d.dispose()
    },
  }
}
