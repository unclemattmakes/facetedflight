// tests/unit/xr-head-pose.test.ts — the gaze is the HEAD's, not the rig's.
//
// Matt, in a headset, 2026-09-17: *"i can't pick menu options when in VR mode
// (look-based pointing not working)."*
//
// `boot/app.ts` built the nose pointer from `render.camera.getWorldPosition()`
// and `getWorldDirection()`, and ~150 lines earlier the same frame had set
// `render.camera.position.set(0, 0, 0)` / `quaternion.identity()` so that the
// XR rig could carry the eye. With the camera's local pose identity those two
// calls compose rig x identity and return **the rig**, so the pointer sat
// wherever the chair faced and never moved when Matt turned his head. Nothing
// hovered; every press did nothing. `render/head-pose.ts` has the full story.
//
// ── Why a separate file, and not more of level-select.test.ts ─────────────
//
// Same argument `xr-eye-layers.test.ts` makes for itself: the claim is not
// about the level select. It is about where a gaze ray comes from, and the
// pause plate's row picker had the identical bug through `game/flight.ts`'s
// identical zeroing. What this file DOES reuse is that file's harness — the
// hangar's own exported geometry, `pickNearestSphere`, and the arc the tables
// really sit on — rather than inventing a second set of targets.
//
// ── The three things it checks, and why each is not circular ──────────────
//
// §1 reads `node_modules/three/build/three.module.js`. *A test that compares
// two of your own devices has not tested either of them* — so the claim "three
// writes the head pose here and the world matrix there" is read out of three,
// not retyped from memory. `three` is pinned exact only until `three-mesh-bvh`'s
// ceiling is accepted, and a version bump is exactly when this must go red.
//
// §2 builds the fake a headset would be: a rig with a non-identity transform,
// an app camera whose local trs is the identity the app just wrote, and an XR
// camera carrying a head pose neither of them has. The expectation is worked by
// hand from three's documented convention (a camera looks down -z; `rotation.y`
// yaws) and from the hangar's own arc — never by running the composition the
// implementation runs. The XR camera's `matrixWorld` is deliberately POISONED,
// because reading it would be the plausible wrong answer (§1 says why).
//
// §3 greps `src/` for the next call to go round the one door.

import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  GAZE_RADIUS,
  HOLO_REACH,
  pickNearestSphere,
  SEAT_EYE_HEIGHT,
  seatEyeLocal,
  seatPitchLocal,
  TABLES_PER_PAGE,
  tableBearings,
  tableGazeLocal,
} from '@/render/hangar'
import { headForward, readHeadPose, readHeadPosition } from '@/render/head-pose'
import { type HangarSpec, hangarSpecFor } from '@/sim/hangar'
import { appSource } from './helpers/app-source'
import { REPO as ROOT } from './helpers/repo-root'
import { listTs } from './helpers/source-tree'

/** `int_01`'s real numbers, exactly as `level-select.test.ts` builds them. */
const SPEC: HangarSpec = hangarSpecFor(9.35 / 2, 12)

const BEARINGS = tableBearings(TABLES_PER_PAGE)
const CENTRES: [number, number, number][] = BEARINGS.map((b) => {
  const c = tableGazeLocal(SPEC, b)
  return [c.x, c.y, c.z]
})
const bearingOf = (i: number): number => BEARINGS[i] as number

/**
 * The unit vector from the seat's eye to table `i`'s gaze sphere, worked by
 * hand rather than subtracted from the table's position.
 *
 * three's convention, from `render/hangar.ts`'s own header: a camera looks down
 * **-z**, `rotation.y = psi` sends that forward to `(-sin psi, 0, -cos psi)`,
 * and a table at BEARING theta sits at `(+sin theta, ., -cos theta)` — so
 * aiming at it is `psi = -theta`. Adding a pitch `phi` about X under that yaw
 * (Euler order 'YXZ') gives `(-sin psi cos phi, sin phi, -cos psi cos phi)`.
 * With `psi = -theta` that is `(sin theta cos phi, sin phi, -cos theta cos phi)`.
 *
 * At `phi = seatPitchLocal()` this is ALSO, independently, the direction to the
 * sphere: the drop is `TABLE_TOP + GAZE_LIFT - SEAT_EYE_HEIGHT` over a reach of
 * `HOLO_REACH`, which is the atan2 that function returns. The two derivations
 * agreeing is the point — one is a rotation, one is a displacement.
 */
const aimAt = (i: number, phi = seatPitchLocal()): [number, number, number] => {
  const theta = bearingOf(i)
  return [Math.sin(theta) * Math.cos(phi), Math.sin(phi), -Math.cos(theta) * Math.cos(phi)]
}

/**
 * The rig, the app camera under it, and an XR camera holding a head pose.
 *
 * `camera.position`/`quaternion` are left at the identity `boot/app.ts` writes
 * every frame, because that IS the state the bug lives in. The head pose goes
 * only where a headset puts it: on `xr.getCamera().matrix`.
 */
const stage = (opts: {
  rigPosition: THREE.Vector3
  rigEuler: THREE.Euler
  headEuler?: THREE.Euler
  headPosition?: THREE.Vector3
  presenting: boolean
}) => {
  const rig = new THREE.Group()
  rig.position.copy(opts.rigPosition)
  rig.quaternion.setFromEuler(opts.rigEuler)
  const camera = new THREE.PerspectiveCamera()
  rig.add(camera)
  // What every eye-placing branch in `boot/app.ts` does, and must keep doing.
  camera.position.set(0, 0, 0)
  camera.quaternion.identity()

  const xrCamera = new THREE.PerspectiveCamera()
  xrCamera.position.copy(opts.headPosition ?? new THREE.Vector3())
  xrCamera.quaternion.setFromEuler(opts.headEuler ?? new THREE.Euler())
  xrCamera.updateMatrix()
  // POISONED on purpose. three fills `cameraXR.matrix` before the app's frame
  // callback and `cameraXR.matrixWorld` only inside `render()`, so the world
  // matrix visible here is always the PREVIOUS frame's — §1 proves that out of
  // three's source. A reader that reaches for it gets this garbage and fails.
  xrCamera.matrixWorld.makeTranslation(9999, 9999, 9999)

  return {
    rig,
    camera,
    xr: { isPresenting: opts.presenting, getCamera: () => xrCamera },
  }
}

/** What the OLD code did: the camera's own world pose. */
const legacyRay = (camera: THREE.Camera): { origin: THREE.Vector3; dir: THREE.Vector3 } => {
  const origin = new THREE.Vector3()
  const dir = new THREE.Vector3()
  camera.getWorldPosition(origin)
  camera.getWorldDirection(dir)
  return { origin, dir }
}

const pick = (origin: THREE.Vector3, dir: THREE.Vector3): number =>
  pickNearestSphere(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, CENTRES, GAZE_RADIUS)

describe('§1 three still puts the head pose where we read it', () => {
  // Inside the `it`, never in the describe body: a describe body runs during
  // COLLECTION, and disk work there throws before any guard can skip it.
  const build = (): string =>
    fs.readFileSync(path.join(ROOT, 'node_modules/three/build/three.module.js'), 'utf8')

  it('composes the head into world space as parent.matrixWorld * camera.matrix', () => {
    // `WebXRManager`'s own `updateCamera(camera, parent)`, where `parent` is the
    // APP camera's parent — our rig. This one line is the formula
    // `render/head-pose.ts` implements, and it is three's, not ours.
    expect(build()).toContain(
      'camera.matrixWorld.multiplyMatrices( parent.matrixWorld, camera.matrix );',
    )
  })

  it('refreshes cameraXR.matrix BEFORE the app frame callback, and not its matrixWorld', () => {
    // The whole reason the fix reads `.matrix` and not `.matrixWorld`. In
    // `onAnimationFrame` three writes this frame's viewer pose into
    // `cameraXR.matrix` and then hands control to us; the world matrix is
    // written later, inside `render()`. So in an app's frame callback `.matrix`
    // is CURRENT and `.matrixWorld` is one frame old.
    const src = build()
    // ANCHORED to the class, and that is not fussiness. There are TWO
    // `function onAnimationFrame( time, frame )` in this build — `WebGLAnimation`
    // declares the first (it is the one whose re-request-after-callback shape
    // let a single thrown frame kill a whole session, d9e264a) — so the naive
    // `indexOf` matched at line 16 and sliced almost the entire file. The
    // assertion below passed on that slice for the wrong reason until it
    // didn't, which is the only reason anybody looked.
    const cls = src.indexOf('class WebXRManager extends EventDispatcher {')
    expect(cls, 'class WebXRManager').toBeGreaterThan(-1)
    const start = src.indexOf('function onAnimationFrame( time, frame ) {', cls)
    expect(start, 'WebXRManager.onAnimationFrame').toBeGreaterThan(cls)
    const handoff = src.indexOf(
      'if ( onAnimationFrameCallback ) onAnimationFrameCallback( time, frame );',
      start,
    )
    expect(handoff, 'the app callback').toBeGreaterThan(start)
    // And a ceiling on the span, so a rename that makes one of those anchors
    // miss cannot quietly hand this test half the library to be right about.
    expect(handoff - start, 'the span being read').toBeLessThan(12_000)
    const before = src.slice(start, handoff)
    expect(before, "this frame's viewer pose").toContain('cameraXR.matrix.copy( camera.matrix );')
    expect(before).toContain(
      'cameraXR.matrix.decompose( cameraXR.position, cameraXR.quaternion, cameraXR.scale );',
    )
    expect(
      before.includes('cameraXR.matrixWorld'),
      'cameraXR.matrixWorld must NOT be written before the app callback',
    ).toBe(false)
  })

  it('writes the head back onto the app camera only inside render()', () => {
    // The other half of the ordering, and the half that makes the bug a bug:
    // three restores `camera.position`/`quaternion` at the END of the frame, so
    // an app that zeroes them in its own update is reading its own zeroes.
    const src = build()
    expect(src).toContain('if ( xr.cameraAutoUpdate === true ) xr.updateCamera( camera );')
    expect(src).toContain(
      'camera.matrix.decompose( camera.position, camera.quaternion, camera.scale );',
    )
  })
})

describe('§2 the pointer follows the head, not the chair — DEV-199', () => {
  const eye = seatEyeLocal(SPEC)
  const eyeVec = new THREE.Vector3(eye.x, eye.y, eye.z)

  it('is the geometry the hangar really has', () => {
    // A control on `aimAt`. The hand-worked rotation and the actual
    // eye-to-sphere displacement are two different derivations; if they ever
    // disagree, every assertion below is measuring the wrong thing.
    for (let i = 0; i < BEARINGS.length; i++) {
      const c = tableGazeLocal(SPEC, bearingOf(i))
      const d = new THREE.Vector3(c.x - eye.x, c.y - eye.y, c.z - eye.z).normalize()
      const a = aimAt(i)
      expect(d.x, `table ${i} x`).toBeCloseTo(a[0], 12)
      expect(d.y, `table ${i} y`).toBeCloseTo(a[1], 12)
      expect(d.z, `table ${i} z`).toBeCloseTo(a[2], 12)
    }
    // And the drop this whole arc is built on, stated once so a layout change
    // that breaks the pitch identity above says so here instead.
    expect(eye.y - tableGazeLocal(SPEC, 0).y).toBeCloseTo(0.6, 12)
    expect(Math.atan2(-0.6, HOLO_REACH)).toBeCloseTo(seatPitchLocal(), 12)
    expect(eye.y - SPEC.floorY).toBeCloseTo(SEAT_EYE_HEIGHT, 12)
  })

  it('picks the table the HEAD is aimed at while the CHAIR faces another', () => {
    // The bug, staged. The chair is turned to table 0 and level — a rig carries
    // the seat's yaw; looking DOWN at a table is a neck, which is the head. The
    // head then adds the depression and swings 90 degrees across to table 3.
    //
    // Yaws about a common Y compose by addition, so the world yaw is
    // `(-b0) + (b0 - b3) = -b3` and the world pitch is the head's: exactly
    // `aimAt(3)`. That is arithmetic on angles, not a re-run of the matrix
    // multiply under test.
    const s = stage({
      rigPosition: eyeVec,
      rigEuler: new THREE.Euler(0, -bearingOf(0), 0, 'YXZ'),
      headEuler: new THREE.Euler(seatPitchLocal(), bearingOf(0) - bearingOf(3), 0, 'YXZ'),
      presenting: true,
    })

    const origin = new THREE.Vector3()
    const quat = new THREE.Quaternion()
    readHeadPose(s.xr, s.camera, origin, quat)
    const dir = headForward(quat, new THREE.Vector3())

    const want = aimAt(3)
    expect(dir.x, 'x').toBeCloseTo(want[0], 12)
    expect(dir.y, 'y').toBeCloseTo(want[1], 12)
    expect(dir.z, 'z').toBeCloseTo(want[2], 12)
    expect(origin.distanceTo(eyeVec), 'the eye is still the eye').toBeLessThan(1e-12)
    expect(pick(origin, dir), 'the table the head is on').toBe(3)

    // And what the code did before. The ray is the CHAIR's: level, 22.8 degrees
    // above a ring of tables, so it hovers nothing at all however the head
    // moves — *"look-based pointing not working"*, exactly as reported.
    const old = legacyRay(s.camera)
    expect(old.dir.y, 'the old ray is level, because the rig is').toBeCloseTo(0, 12)
    expect(pick(old.origin, old.dir), 'the old ray hovers nothing').toBe(-1)
  })

  it('and when the chair IS on a table, the old ray picked the WRONG one', () => {
    // The worse half of the same defect, and the reason it cannot be waved off
    // as "it just misses": with the chair resting on a table — which is what
    // `SEAT_REST_BEARING` deliberately arranges — the stale ray is a confident
    // hover on whatever the seat faces. You look at Advanced 2, the room
    // highlights Rookie 1, and A boards Rookie 1.
    const s = stage({
      rigPosition: eyeVec,
      rigEuler: new THREE.Euler(seatPitchLocal(), -bearingOf(0), 0, 'YXZ'),
      headEuler: new THREE.Euler(0, 0, 0, 'YXZ'),
      presenting: true,
    })
    const old = legacyRay(s.camera)
    expect(pick(old.origin, old.dir), 'the chair is on table 0').toBe(0)
  })

  it('carries the head over the rig, so a LEAN moves the ray origin', () => {
    // The translation half. The ray's ORIGIN matters as much as its direction —
    // it is also the audio listener's position — and a fake that only ever
    // rotates would never notice a composition that drops the offset.
    //
    // Hand-worked: the rig is a pure yaw `psi = -b0` about Y at the eye, so a
    // head offset `(lx, ly, lz)` lands at `eye + Ry(psi) . l`, and
    // `Ry(psi) . (lx, ly, lz) = (lx cos psi + lz sin psi, ly, -lx sin psi + lz cos psi)`.
    const lean = new THREE.Vector3(0.11, 0.07, -0.05)
    const psi = -bearingOf(0)
    const s = stage({
      rigPosition: eyeVec,
      rigEuler: new THREE.Euler(0, psi, 0, 'YXZ'),
      headEuler: new THREE.Euler(seatPitchLocal(), bearingOf(0) - bearingOf(3), 0, 'YXZ'),
      headPosition: lean,
      presenting: true,
    })
    const origin = new THREE.Vector3()
    const quat = new THREE.Quaternion()
    readHeadPose(s.xr, s.camera, origin, quat)

    const c = Math.cos(psi)
    const sn = Math.sin(psi)
    expect(origin.x).toBeCloseTo(eye.x + lean.x * c + lean.z * sn, 12)
    expect(origin.y).toBeCloseTo(eye.y + lean.y, 12)
    expect(origin.z).toBeCloseTo(eye.z - lean.x * sn + lean.z * c, 12)

    // `readHeadPosition` is the same answer for the readers that want only the
    // eye point — one door, two shapes, never two implementations.
    const only = readHeadPosition(s.xr, s.camera, new THREE.Vector3())
    expect(only.distanceTo(origin)).toBeLessThan(1e-12)

    // And the old call gives the rig's origin: the lean is simply gone.
    expect(legacyRay(s.camera).origin.distanceTo(eyeVec)).toBeLessThan(1e-12)
  })

  it('is the camera itself on FLAT, where the rig IS the whole aim', () => {
    // The control, and the reason one door is safe. Out of session nothing
    // writes the camera's local pose, so rig x identity is the right answer —
    // which is why every flat test, every screenshot and `menu-screen.spec.ts`
    // stayed green through all of this. Same numbers, both ways.
    const s = stage({
      rigPosition: eyeVec,
      rigEuler: new THREE.Euler(seatPitchLocal(), -bearingOf(2), 0, 'YXZ'),
      presenting: false,
    })
    const origin = new THREE.Vector3()
    const quat = new THREE.Quaternion()
    readHeadPose(s.xr, s.camera, origin, quat)
    const dir = headForward(quat, new THREE.Vector3())

    const old = legacyRay(s.camera)
    expect(origin.distanceTo(old.origin)).toBeLessThan(1e-12)
    expect(dir.distanceTo(old.dir)).toBeLessThan(1e-12)
    expect(pick(origin, dir), 'the seat aim lands on its table').toBe(2)
    // Hand-worked too, so this is not two of our own devices agreeing.
    const want = aimAt(2)
    expect(dir.x).toBeCloseTo(want[0], 12)
    expect(dir.z).toBeCloseTo(want[2], 12)
  })

  it("reads the XR camera's matrix and never its stale matrixWorld", () => {
    // `stage()` poisons `matrixWorld` to (9999, 9999, 9999). §1 establishes that
    // in an app's frame callback that field really does hold something else —
    // last frame's — so a reader that reaches for it is wrong by a frame at best
    // and, because `cameraXR.parent` is null, wrong by the whole rig at worst.
    const s = stage({
      rigPosition: eyeVec,
      rigEuler: new THREE.Euler(0, -bearingOf(0), 0, 'YXZ'),
      headEuler: new THREE.Euler(seatPitchLocal(), bearingOf(0) - bearingOf(1), 0, 'YXZ'),
      presenting: true,
    })
    const origin = new THREE.Vector3()
    const quat = new THREE.Quaternion()
    readHeadPose(s.xr, s.camera, origin, quat)
    expect(origin.distanceTo(eyeVec)).toBeLessThan(1e-12)
    expect(pick(origin, headForward(quat, new THREE.Vector3()))).toBe(1)
  })
})

describe('§3 nothing in src/ builds an aim out of the camera again', () => {
  it('has no camera getWorldDirection / getWorldQuaternion outside the one door', () => {
    // *When you fix one instance, re-derive all of them.* A world POSITION off
    // a camera is wrong by the lean, which some readers can live with; a world
    // DIRECTION or QUATERNION off a camera whose local pose has been zeroed has
    // lost the entire head rotation, which nothing can live with. So those two
    // are banned outright, and `render.camera.getWorld*` — the frame's own
    // reads, the ones that shipped this — is banned in every shape.
    //
    // Comments are stripped first, so the paragraphs in `head-pose.ts` and
    // `app.ts` explaining the bug do not trip the guard that exists because of
    // it.
    const door = path.join(ROOT, 'src/render/head-pose.ts')
    const offenders: string[] = []
    for (const file of listTs(path.join(ROOT, 'src'))) {
      if (file === door) continue
      const code = fs
        .readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
      const patterns = [
        /\b[A-Za-z_$][\w$]*[Cc]amera[\w$]*\.getWorld(?:Direction|Quaternion)\s*\(/g,
        /\bcamera\.getWorld(?:Direction|Quaternion)\s*\(/g,
        /\brender\.camera\.getWorld\w*\s*\(/g,
      ]
      for (const re of patterns) {
        for (const hit of code.matchAll(re) as Iterable<RegExpMatchArray>) {
          offenders.push(`${path.relative(ROOT, file).replaceAll(path.sep, '/')}: ${hit[0]}`)
        }
      }
    }
    expect(offenders, 'the gaze is the HEAD — use render/head-pose.ts (DEV-199)').toEqual([])
  })

  it('still has the zeroing the fix deliberately did NOT remove', () => {
    // The other way this can regress: somebody reads DEV-199, decides the cure
    // is to stop zeroing the camera, and ships a view that fights the runtime.
    // `game/flight.ts` says why it must stay — a spectator-orbit frame during
    // loading once left a 3 km offset in the camera's local pose — and in a
    // session the runtime owns that pose outright. The fix is on the READ side
    // and this is the sentinel that says so.
    const app = appSource()
    const flight = fs.readFileSync(path.join(ROOT, 'src/game/flight.ts'), 'utf8')
    const zeroes = (s: string) =>
      [...s.matchAll(/camera\.position\.set\(\s*0,\s*0,\s*0\s*\)/g)].length
    expect(zeroes(app), 'boot/app.ts: title, menu, third person').toBeGreaterThanOrEqual(3)
    expect(zeroes(flight), 'game/flight.ts: the cockpit').toBeGreaterThanOrEqual(1)
  })
})
