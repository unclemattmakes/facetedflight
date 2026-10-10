// src/render/xr-pointer.ts — the motion controller's laser. DEV-321.
//
// Matt, 2026-09-23: *"laser pointer from motion controller plz"* (NEXT.md #40).
// `input/pointer-hand.ts` decides WHICH hand points; this file is where that
// hand's ray comes from, and what the player sees of it.
//
// ── Where the ray comes from ──────────────────────────────────────────────
//
// The pose is read straight off the frame — `frame.getPose(targetRaySpace,
// referenceSpace)` — in the SAME reference space three hands the head pose in
// (`renderer.xr.getReferenceSpace()`, which is `customReferenceSpace ||
// referenceSpace`, exactly what `WebXRManager.onAnimationFrame` asks for). Two
// consequences, both deliberate:
//
//   * **It is in REFERENCE space, not world space.** CLAUDE.md: *"throw/impulse
//     velocities are in XR reference space"*, and a pose is the same kind of
//     thing. The rig is what carries that space into the world — the camera is
//     already its child for exactly this reason — so the world ray is
//     `rig.matrixWorld x pose`, the formula `render/head-pose.ts` uses for the
//     head (DEV-199). A laser that skipped the rig would aim from the room's
//     origin while you sat in the chair 1.5 m away.
//   * **`rig.matrixWorld` is recomposed first.** It is stale inside the XR
//     frame callback until `render()` runs (CLAUDE.md), and the rig has just
//     been MOVED this frame — the menu branch puts it on the seat, the cockpit
//     puts it on the ship's eye. `updateWorldMatrix(true, false)` walks the
//     parents too, because the rig is re-parented between the menu stage and
//     the mission stage.
//
// Not three's `getController(i)` groups. Those are keyed by SLOT, and three
// refills slots from `inputsourceschange` in arrival order — so after the
// Frame's `+2 -2` swap (`input/xr-select.ts`) slot 0 is whichever hand arrived
// first, not the left one. This file asks the source for its handedness.
//
// ── What is drawn, and why it is the same ray ─────────────────────────────
//
// The beam is parented to the RIG with the pose as its local matrix, so three
// composes `rig x pose` at render time — the same product the hit test takes.
// That is the property worth having and `tests/unit/xr-pointer.test.ts` pins
// it as geometry: the beam's far end lands where the ray says it hit. What you
// see and what you hit cannot drift apart, which is the argument
// `render/pause.ts`'s `rowTopM` makes for the painter.
//
// ── The look (docs/ART_DIRECTION.md) ──────────────────────────────────────
//
// It is UI, so it is on the UI side of tone mapping's line: `toneMapped: false`,
// which is also what `render/bloom.ts` classifies onto `UI_LAYER` (3) — never
// layer 1 or 2, the WebXR EYES, where a one-eyed laser would read as a depth cue
// that is not there (DEV-141). No texture, one colour a face. The beam is a
// thin SIX-SIDED prism: faceted, in register with a world folded from paper,
// and the hexagon is the gate's own shape. The reticle at its end is the menus'
// TRIANGLE since DEV-572 (`render/menu-reticle.ts`, which says why it shares
// the canvas plates' program): it was a six-sided ring, and the head's reticle
// and the laser's are now one mark. In the room it draws UNDER the tables'
// words (`show`'s `layer`), over a plate it draws over.
// Colours are the HUD's: the accent while the beam is ON something you can
// press, the dim ink while it is not. `depthTest: false` and drawn after the
// plates, because the pause plate itself is `depthTest: false` — a depth-tested
// beam would vanish into the one thing it is pointing at.
//
// **Only while a menu is up.** `sense()` begins every frame by putting the beam
// away, and only a menu that aims with it shows it again — so a frame with no
// menu has no beam without anybody having to remember to hide it. That is
// `hangar.gaze`'s `gazedSinceUpdate` rule, for the same reason.

import * as THREE from 'three'
import type { PointerHand } from '@/input/pointer-hand'
import {
  createReticleMesh,
  OVER_ORDER,
  RETICLE_OFF,
  RETICLE_ON,
  type ReticleLayer,
  UNDER_ORDER,
} from './menu-reticle'

/** An `XRPose`, narrowed to the one field this reads. */
export interface XrPoseLike {
  readonly transform: { readonly matrix: ArrayLike<number> }
}

/** An `XRFrame`, narrowed. Method syntax on purpose: the spaces are opaque here. */
export interface XrFrameLike {
  getPose(space: unknown, baseSpace: unknown): XrPoseLike | null | undefined
}

/** An `XRInputSource`, narrowed. */
export interface XrPointerInputSource {
  readonly handedness: string
  readonly targetRayMode: string
  readonly targetRaySpace: unknown
}

/**
 * The part of `renderer.xr` this needs — structural, so a test can hand in a
 * headset made of object literals (`render/head-pose.ts` makes the same
 * argument for `XrCameraSource`).
 */
export interface XrPoseSource {
  readonly isPresenting: boolean
  getFrame(): XrFrameLike | null | undefined
  getReferenceSpace(): unknown
  getSession(): { readonly inputSources: Iterable<XrPointerInputSource> } | null | undefined
}

/**
 * How far the beam reaches when it is on nothing, metres.
 *
 * Past the pause plate (`PANEL_DISTANCE`, 0.86 m) and short of the holotables
 * (~1.55 m), so a miss in the cockpit visibly overshoots the plate and a miss in
 * the room visibly falls short of the tables — either way the beam's END says
 * "not on it". Not longer: it is drawn over everything, and in a cockpit a long
 * miss would lie across the canopy frame.
 */
export const MISS_LENGTH = 1.2

/**
 * The reticle's outer radius as an ANGLE AT THE EYE, radians.
 *
 * A fixed angle rather than a fixed size, so it reads the same on the plate at
 * 0.86 m and on a table at 1.5 m. 0.5° of radius is a 1° ring: a sixth of a
 * pause row (`pause.ts` sizes rows at about 6°) and a twentieth of a table's
 * 19.3° gaze window — visible, and never bigger than the thing it is on.
 *
 * At the EYE, not at the hand, and the first cut had it at the hand: the hand
 * is 0.4 m nearer the plate than the eye, so a ring sized from it came out at
 * about half the angle it was meant to subtend — a speck in the pinned photo.
 */
export const RETICLE_ANGLE = (0.5 * Math.PI) / 180

/** Beam radius at the hand and at the tip, metres. A ~0.1° line at 1.5 m. */
const BEAM_RADIUS_HAND = 0.004
const BEAM_RADIUS_TIP = 0.0015
/** Six faces: faceted, like everything else, and the gate's own hexagon. */
const FACETS = 6

/** The beam is the reticle's colour: on something you can press, or not (`menu-reticle.ts`). */
const BEAM_OPACITY = 0.6

/** Above the pause plate (12). The reticle's order is `menu-reticle.ts`'s. */
const BEAM_ORDER = 15

/**
 * The world ray of a target-ray pose, carried through the rig.
 *
 * Writes the origin and a UNIT direction (the pose's −z, which is where an
 * `xr-standard` target ray points), and returns how many world metres one unit
 * along the pose's −z is — 1 for the rig this game has, which is never scaled,
 * but a beam drawn in the rig's space needs it to land where the hit is if one
 * ever is.
 *
 * `rig.updateWorldMatrix(true, false)` FIRST: see the header.
 */
export const composeRay = (
  rig: THREE.Object3D,
  pose: THREE.Matrix4,
  origin: THREE.Vector3,
  direction: THREE.Vector3,
): number => {
  rig.updateWorldMatrix(true, false)
  _world.multiplyMatrices(rig.matrixWorld, pose)
  origin.setFromMatrixPosition(_world)
  // The pose's local −z, as a vector: column 2 negated. Its LENGTH is the
  // world scale along the ray; its direction is the ray.
  direction.setFromMatrixColumn(_world, 2).negate()
  const metresPerUnit = direction.length()
  direction.divideScalar(metresPerUnit)
  return metresPerUnit
}

/**
 * How far along a unit ray it meets the plane of `plane`'s local z = 0, or
 * null if it never does in front of the origin.
 *
 * The pause plate is a `PlaneGeometry` in its own z = 0, which is what
 * `pause.pick` hit-tests in; this is the same plane, asked for a distance
 * instead of a row. `updateWorldMatrix` first, for the staleness trap.
 */
export const planeHitDistance = (
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  plane: THREE.Object3D,
): number | null => {
  plane.updateWorldMatrix(true, false)
  _point.setFromMatrixPosition(plane.matrixWorld)
  _normal.setFromMatrixColumn(plane.matrixWorld, 2).normalize()
  const facing = direction.dot(_normal)
  if (Math.abs(facing) < 1e-9) return null
  const t = _point.sub(origin).dot(_normal) / facing
  return t > 0 ? t : null
}

// ── Smoothing: a One Euro filter on the pose (Matt, worn, 2026-09-23) ───────
//
// *"laser works - feels jittery since it's 1:1 with my hand motion. can you
// smooth it a lil bit"*. A hand held still trembles a fraction of a degree,
// and a ray 2 m long turns that into centimetres of dancing reticle. A plain
// low-pass fixes the tremor and makes every deliberate sweep lag. The One Euro
// filter (Casiez, Roussel and Vogel, CHI 2012) is the standard answer: its
// cutoff RISES with speed, so it smooths hard at rest and gets out of the way
// in a sweep. Applied to the POSE, before anything reads it, so the beam you
// see and the ray `ray()` picks with stay one ray.

/** Cutoff at rest, Hz. Lower is smoother and laggier while still. A taste number. */
export const POINTER_MIN_CUTOFF_HZ = 1.5
/** How fast the cutoff rises with speed, Hz per (rad/s of turn or m/s of travel). */
export const POINTER_BETA = 1.2
/** The speed estimate's own cutoff, Hz: the paper's default. */
export const POINTER_DERIVATIVE_CUTOFF_HZ = 1
/** A gap longer than this (a lost pose, a paused tab) starts the filter afresh. */
export const POINTER_RESET_SECONDS = 0.25

const oneEuroAlpha = (cutoffHz: number, dt: number): number => {
  const tau = 1 / (2 * Math.PI * cutoffHz)
  return 1 / (1 + tau / dt)
}

interface HandFilter {
  readonly position: THREE.Vector3
  readonly rotation: THREE.Quaternion
  /** Filtered speeds: m/s and rad/s. */
  speed: number
  turn: number
  lastSeconds: number
}

/**
 * One Euro, per hand, on a rigid pose. Position is filtered as a point and
 * rotation by slerp, each with the cutoff its own speed earns. The first
 * sample after a reset passes through exactly.
 */
export const createPoseSmoother = () => {
  const state = new Map<PointerHand, HandFilter>()
  const _p = new THREE.Vector3()
  const _q = new THREE.Quaternion()
  const _s = new THREE.Vector3()
  return {
    /** Filter `raw` in place (a rigid pose matrix) for `hand` at time `seconds`. */
    filter(hand: PointerHand, raw: THREE.Matrix4, seconds: number): void {
      raw.decompose(_p, _q, _s)
      const f = state.get(hand)
      const dt = f ? seconds - f.lastSeconds : 0
      if (!f || !(dt > 0) || dt > POINTER_RESET_SECONDS) {
        state.set(hand, {
          position: _p.clone(),
          rotation: _q.clone(),
          speed: 0,
          turn: 0,
          lastSeconds: seconds,
        })
        return
      }
      const aD = oneEuroAlpha(POINTER_DERIVATIVE_CUTOFF_HZ, dt)
      f.speed += aD * (_p.distanceTo(f.position) / dt - f.speed)
      f.turn += aD * (f.rotation.angleTo(_q) / dt - f.turn)
      f.position.lerp(_p, oneEuroAlpha(POINTER_MIN_CUTOFF_HZ + POINTER_BETA * f.speed, dt))
      f.rotation.slerp(_q, oneEuroAlpha(POINTER_MIN_CUTOFF_HZ + POINTER_BETA * f.turn, dt))
      f.lastSeconds = seconds
      raw.compose(f.position, f.rotation, _s)
    },
    /** Forget a hand, so its next pose passes through exactly. */
    reset(hand: PointerHand): void {
      state.delete(hand)
    },
  }
}

export interface XrPointer {
  /** Parent this to `render.rig`, once. Its local matrix is the pose. */
  readonly object: THREE.Group
  /**
   * Start of frame: read each hand's target-ray pose, and put the beam away.
   *
   * Returns the hands that have a pose — only `tracked-pointer` sources, see
   * `input/pointer-hand.ts` — and nothing out of a session or before the first
   * frame. The returned set is reused; read it this frame.
   *
   * Each pose is SMOOTHED on the way in (`createPoseSmoother`), keyed on
   * `nowMs`, the frame's time; it defaults to `performance.now()`.
   */
  sense(xr: XrPoseSource | null | undefined, nowMs?: number): ReadonlySet<PointerHand>
  /** What the last `sense` found. The same set `sense` returned. */
  readonly posed: ReadonlySet<PointerHand>
  /**
   * The world ray from `hand`'s pose, through `rig`. False, and the outputs
   * untouched, if that hand had no pose this frame.
   */
  ray(
    hand: PointerHand,
    rig: THREE.Object3D,
    origin: THREE.Vector3,
    direction: THREE.Vector3,
  ): boolean
  /**
   * Draw `hand`'s beam, ending `distance` world metres out on something you
   * can press, or at {@link MISS_LENGTH} and dimmed when `distance` is null.
   * `eye` is the head's world position, which sizes the reticle
   * ({@link RETICLE_ANGLE}). Call {@link ray} for the same hand first this
   * frame: it is what measures the rig's scale and where the hit is.
   *
   * `layer` (DEV-572): `'under'` in the room, so the reticle never hides a
   * table's words; `'over'`, the default, on a plate.
   */
  show(hand: PointerHand, distance: number | null, eye: THREE.Vector3, layer?: ReticleLayer): void
  /** Put it away. `sense` does this at the start of every frame. */
  hide(): void
  dispose(): void
}

// Volatile, valid only inside one synchronous call (trap 19).
const _world = new THREE.Matrix4()
const _point = new THREE.Vector3()
const _normal = new THREE.Vector3()

export const createXrPointer = (): XrPointer => {
  const object = new THREE.Group()
  object.name = 'xr-pointer'
  // The pose IS the local matrix. Nothing may recompose it from a position and
  // a quaternion the pose never wrote.
  object.matrixAutoUpdate = false
  object.visible = false

  // Unit length along −z, from the hand (z = 0) to the tip (z = −1), so a
  // z-scale of `d` is a beam `d` long. Open-ended: the ends are never seen.
  const beamGeometry = new THREE.CylinderGeometry(
    BEAM_RADIUS_TIP,
    BEAM_RADIUS_HAND,
    1,
    FACETS,
    1,
    true,
  )
  // Cylinder axis +y → −z, top (the tip radius) to the far end.
  beamGeometry.rotateX(-Math.PI / 2)
  beamGeometry.translate(0, 0, -0.5)
  const beamMaterial = new THREE.MeshBasicMaterial({
    color: RETICLE_OFF,
    transparent: true,
    opacity: BEAM_OPACITY,
    toneMapped: false,
    depthTest: false,
    depthWrite: false,
  })
  const beam = new THREE.Mesh(beamGeometry, beamMaterial)
  beam.name = 'xr-pointer-beam'
  beam.renderOrder = BEAM_ORDER
  beam.frustumCulled = false
  object.add(beam)

  // The menus' triangle (DEV-572, `render/menu-reticle.ts`): one local unit is
  // its circumradius, in the z = 0 plane, facing +z, back up the beam toward
  // the hand it came from, which is the side the eye is on too. Its material is
  // TRANSPARENT, at full opacity, and that is not decoration: three draws the
  // opaque list, then the transparent list, and `renderOrder` sorts only WITHIN
  // a list. The pause plate is transparent and depth-test-off, so an opaque mark
  // was drawn first and painted over: the first pinned photo showed the beam
  // reaching the COMFORT row and no ring at its end, while in the room, over
  // opaque tables, the ring showed.
  const reticle = createReticleMesh('xr-pointer-reticle')
  object.add(reticle)

  const poses: Record<PointerHand, THREE.Matrix4> = {
    left: new THREE.Matrix4(),
    right: new THREE.Matrix4(),
  }
  const posed = new Set<PointerHand>()
  /** World metres per pose unit, per hand, from the last `ray`. */
  const scale: Record<PointerHand, number> = { left: 1, right: 1 }
  /** The world ray, per hand, from the last `ray` — owned here, never lent out. */
  const rayOrigin: Record<PointerHand, THREE.Vector3> = {
    left: new THREE.Vector3(),
    right: new THREE.Vector3(),
  }
  const rayDirection: Record<PointerHand, THREE.Vector3> = {
    left: new THREE.Vector3(0, 0, -1),
    right: new THREE.Vector3(0, 0, -1),
  }
  const _hit = new THREE.Vector3()
  const smoother = createPoseSmoother()

  // Read by the e2e spec through `__ff2.stage().getObjectByName('xr-pointer')`:
  // which hand, whether it is on something, and how far. A spec that asserted
  // only `visible` would pass on a beam pointing at the floor.
  const report = (hand: PointerHand | null, distance: number | null): void => {
    object.userData.hand = hand
    object.userData.hit = distance !== null
    object.userData.distance = distance
  }
  report(null, null)

  const hide = (): void => {
    object.visible = false
    report(null, null)
  }

  return {
    object,

    sense(xr, nowMs = performance.now()) {
      hide()
      const was = new Set(posed)
      posed.clear()
      if (!xr?.isPresenting) {
        smoother.reset('left')
        smoother.reset('right')
        return posed
      }
      const frame = xr.getFrame()
      const space = xr.getReferenceSpace()
      const session = xr.getSession()
      if (!frame || !space || !session) return posed
      for (const source of session.inputSources) {
        if (source.targetRayMode !== 'tracked-pointer') continue
        const hand = source.handedness
        if (hand !== 'left' && hand !== 'right') continue
        const pose = frame.getPose(source.targetRaySpace, space)
        if (!pose) continue
        poses[hand].fromArray(pose.transform.matrix)
        smoother.filter(hand, poses[hand], nowMs / 1000)
        posed.add(hand)
      }
      // A hand that lost its pose starts afresh when it comes back, rather than
      // gliding in from wherever it was last seen.
      for (const hand of was) if (!posed.has(hand)) smoother.reset(hand)
      return posed
    },

    get posed() {
      return posed
    },

    ray(hand, rig, origin, direction) {
      if (!posed.has(hand)) return false
      scale[hand] = composeRay(rig, poses[hand], origin, direction)
      rayOrigin[hand].copy(origin)
      rayDirection[hand].copy(direction)
      return true
    },

    show(hand, distance, eye, layer = 'over') {
      if (!posed.has(hand)) {
        hide()
        return
      }
      object.matrix.copy(poses[hand])
      object.matrixWorldNeedsUpdate = true
      object.visible = true
      const perUnit = scale[hand]
      const on = distance !== null
      const reach = (distance ?? MISS_LENGTH) / perUnit
      beam.scale.set(1, 1, reach)
      beamMaterial.color.setHex(on ? RETICLE_ON : RETICLE_OFF)
      reticle.visible = on
      if (on) {
        reticle.position.set(0, 0, -reach)
        // A fixed angle at the EYE: its world radius is the eye's distance to
        // the hit times tan(angle), and the rig's units are that over `perUnit`.
        _hit.copy(rayOrigin[hand]).addScaledVector(rayDirection[hand], distance)
        reticle.scale.setScalar((Math.tan(RETICLE_ANGLE) * _hit.distanceTo(eye)) / perUnit)
        // DEV-572: under the room's words, over a plate. Not in the program key.
        reticle.renderOrder = layer === 'under' ? UNDER_ORDER : OVER_ORDER
        // The shared material's colour: the head's reticle may have left it dim.
        reticle.material.color.setHex(RETICLE_ON)
      }
      report(hand, distance)
    },

    hide,

    dispose() {
      object.removeFromParent()
      beamGeometry.dispose()
      beamMaterial.dispose()
      // Its material is every reticle's (`reticleMaterial`), never disposed here.
      reticle.geometry.dispose()
    },
  }
}
