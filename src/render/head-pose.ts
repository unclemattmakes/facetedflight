// src/render/head-pose.ts — where the HEAD is, and which way it is looking.
//
// Matt, in a headset, second VR playthrough, 2026-09-17: *"i can't pick menu
// options when in VR mode (look-based pointing not working)."*
//
// ── The bug this file exists to make impossible ───────────────────────────
//
// The hangar's level select is a NOSE POINTER: `boot/app.ts` builds a ray from
// the eye every frame the menu is up and hands it to `hangar.gaze()`, and the
// pause plate picks its row the same way. Both read the ray off the camera:
//
//     render.camera.getWorldPosition(cameraWorld)
//     render.camera.getWorldDirection(gazeDirection)
//
// and the comment above them said, correctly, *"the camera's WORLD pose — the
// local one is the head pose inside the XR rig"*. The author knew trap 18, named
// it, and reached for the world pose on purpose. It still returned the RIG.
//
// Because ~150 lines EARLIER in the same frame, every branch that places the
// eye does this:
//
//     render.rig.position.copy(seatWorld)
//     render.rig.quaternion.copy(_seatAim)
//     render.camera.position.set(0, 0, 0)     // <- and here goes the head
//     render.camera.quaternion.identity()
//
// which is right, and must stay: in a session the runtime owns the camera's
// local pose, so the RIG is what an app moves — moving the camera instead
// fights the runtime and makes people ill. `game/flight.ts` does the same in the
// cockpit and its comment gives the other half of the reason (a spectator-orbit
// frame once left a 3 km offset in the camera's local pose).
//
// So the frame reads, in order:
//
//     three writes the head pose onto the camera   (inside renderer.render)
//     we overwrite it with identity                (placing the eye)
//     we read the overwrite and call it the gaze   (~150 lines later)
//     three writes it again                        (inside renderer.render)
//
// The pose was never missing. **We destroy it between the write and the read.**
// With the camera's local pose identity, `getWorldPosition`/`getWorldDirection`
// compose rig x identity and return the RIG's aim — so the pointer sits wherever
// the chair faces and does not move when you turn your head. Nothing is ever
// hovered; every press does nothing.
//
// Flat is unaffected, and that is why 2,900 unit tests, 90 e2e tests and every
// screenshot this port has taken were green: on flat the rig IS the whole aim,
// so rig x identity is the right answer. Exactly DEV-141's shape — a bug that
// cannot exist in the harness, because the harness has no second thing.
//
// ── What three actually does, read out of three's own build ───────────────
//
// `tests/unit/xr-head-pose.test.ts` §1 reads `node_modules/three/build/
// three.module.js` and fails if either formula below is gone, the way
// `xr-eye-layers.test.ts` does for the eye masks. `three` is pinned exact only
// until `three-mesh-bvh`'s ceiling is accepted, so a claim about three's
// internals belongs in a test that reads three, not in a comment. Transcribed
// from `WebXRManager` (0.185.1):
//
//   `onAnimationFrame`, which runs BEFORE the app's frame callback:
//       cameraXR.matrix.copy( camera.matrix );
//       cameraXR.matrix.decompose( cameraXR.position, cameraXR.quaternion, ... );
//   — this frame's head pose, in the session's REFERENCE SPACE.
//
//   `updateCamera`, called from `WebGLRenderer.render`, i.e. at the END:
//       camera.matrixWorld.multiplyMatrices( parent.matrixWorld, camera.matrix );
//   — where `parent` is the app camera's parent, our rig. That is three's own
//     definition of "the head, in world space", and it is what this file uses.
//
// **`cameraXR.matrixWorld` is NOT current.** `onAnimationFrame` writes only
// `cameraXR.matrix`; the world matrix is written in `render()`, so in the app's
// frame callback it still holds LAST frame's. And `cameraXR.parent` is null, so
// `xrCamera.getWorldPosition()` would hand back the reference-space pose with
// the rig missing entirely — a plausible-looking call that is wrong twice.
// `cameraXR.matrix` composed with the rig's live `matrixWorld` is this frame's
// pose with no staleness at all, which is why that is the formula here.
//
// ── One door, not a branch at each call site ──────────────────────────────
//
// The brief this was written to: *the gaze must be the head's world pose in an
// XR session and the camera's world pose on flat, through ONE code path that
// cannot silently do the rig in one case and the head in the other.* So the
// branch lives here once, and `tests/unit/xr-head-pose.test.ts` §3 greps `src/`
// for the next `camera.getWorldDirection()` / `camera.getWorldQuaternion()` to
// go round it.

import * as THREE from 'three'

/**
 * The part of `renderer.xr` this needs — structural on purpose.
 *
 * A `WebXRManager` satisfies it, and so does an object literal, which is the
 * whole point: there is no headless WebXR worth maintaining (CLAUDE.md), so the
 * only way to test a head pose without a headset is to be able to hand one in.
 * `tests/unit/xr-head-pose.test.ts` builds a rig with a non-identity transform
 * and a fake XR camera carrying a head pose the camera's local trs does not.
 */
export interface XrCameraSource {
  readonly isPresenting: boolean
  getCamera(): { readonly matrix: THREE.Matrix4 }
}

/** Volatile. Valid inside one synchronous call — never store a reference. */
const _matrix = new THREE.Matrix4()
/** Volatile. `decompose` insists on a scale vector; nothing reads this one. */
const _scale = new THREE.Vector3()

/**
 * The head's world matrix: `rig.matrixWorld * headInReferenceSpace` in a
 * session, the camera's own world matrix out of one.
 *
 * `updateWorldMatrix(true, false)` first, for BOTH branches — it walks the
 * parents, which is what makes `camera.parent.matrixWorld` live for the session
 * branch as well as recomposing `camera.matrixWorld` for the flat one.
 *
 * @param xr `renderer.xr`, or null where there is no renderer at all.
 * @param camera the app camera — the one handed to `renderer.render()`.
 */
export const headMatrix = (
  xr: XrCameraSource | null | undefined,
  camera: THREE.Object3D,
  out: THREE.Matrix4,
): THREE.Matrix4 => {
  camera.updateWorldMatrix(true, false)
  // Out of session the camera's own world matrix is the answer, and on flat it
  // is the ONLY answer — `xr.getCamera()` returns a camera three has never
  // filled in.
  if (!xr?.isPresenting) return out.copy(camera.matrixWorld)
  const head = xr.getCamera().matrix
  const parent = camera.parent
  return parent ? out.multiplyMatrices(parent.matrixWorld, head) : out.copy(head)
}

/**
 * Where the head is and how it is turned, in world space.
 *
 * Both outputs together, from one matrix: a caller that wanted the position
 * from one call and the orientation from another is two reads of one volatile
 * with something between them, which is trap 19's exact shape.
 */
export const readHeadPose = (
  xr: XrCameraSource | null | undefined,
  camera: THREE.Object3D,
  position: THREE.Vector3,
  quaternion: THREE.Quaternion,
): void => {
  headMatrix(xr, camera, _matrix).decompose(position, quaternion, _scale)
}

/**
 * Just where the head is — for the readers that only ever wanted the eye point.
 */
export const readHeadPosition = (
  xr: XrCameraSource | null | undefined,
  camera: THREE.Object3D,
  position: THREE.Vector3,
): THREE.Vector3 => position.setFromMatrixPosition(headMatrix(xr, camera, _matrix))

/**
 * Which way a head at `quaternion` is looking.
 *
 * three's documented convention and nothing else: a camera looks down its own
 * **-z**, which is the same sentence `render/hangar.ts` builds the seat's aim
 * from and the same one `tests/unit/level-select.test.ts` builds its rays from.
 */
export const headForward = (quaternion: THREE.Quaternion, out: THREE.Vector3): THREE.Vector3 =>
  out.set(0, 0, -1).applyQuaternion(quaternion)
