// src/render/sea-reflection.ts: the sea reflects the islands again, on a monitor, under ultra. DEV-583.
//
// `docs/plan/ULTRA.md` has the row and DEV-021 the history. 2016's `Water.mat`
// carried `V_LP_REFLECTIVE_REALTIME`: a camera mirrored through the water plane
// rendered the scene into `_ReflectionTex`, and the water read it back at its
// own screen position, pushed by the facet normal. DEV-021 kept the sky alone,
// because in a headset that is two more scene renders a frame. On a monitor
// the ultra tier has the room, so this file renders the mirror and
// `render/water.ts` (`MIRROR_FRAGMENT_GLSL`) reads it.
//
// ── The gate, and why a headset can never reach it ───────────────────────
//
// Both halves, read live every frame (`seaReflectionFor`): the edition's
// `render.seaReflection` (Anniversary on, Classic off, Matt 2026-10-03 "Classic
// no") AND `ultraFor(settings, presenting)?.seaReflection`. The second is null
// while presenting, by DEV-581's one line in `qualityInForce`, so a session
// renders nothing here, allocates nothing, and frees what flat left behind.
// The flag is also in `vr.disable`; that is the preset saying the same thing.
//
// When the gate is shut the water's `FF2_WATER_MIRROR` define is ABSENT, not
// sampling a black texture: `Water.setMirror(null)`.
//
// ── The camera: a proper rotation, and an oblique near plane AT the water ──
//
// The eye reflected through the plane `y = seaY`, looking along its reflected
// forward with its reflected up, which is three's `Reflector` construction
// (the matrix math only; not its mesh, its shader or its target). A reflected
// VIEW MATRIX would be the simpler mirror and is wrong here: its determinant is
// -1, so every triangle's winding flips and three's culling turns the island
// inside out. The proper camera instead sees a point on the plane at the same
// screen y and the OPPOSITE screen x, so the water reads `1 - u`.
//
// The near plane is replaced by the sea plane (Lengyel's oblique projection,
// `obliqueNearPlane`), so nothing under the water is drawn into the mirror:
// not the island's foot, not the seabed, not the launch shaft. Three's frustum
// culling is built from the same matrix and drops those draws before they are
// submitted.
//
// ── Where the plane is ───────────────────────────────────────────────────
//
// Not a typed number. The sea's own collision field under the eye, the surface
// `load-terrain.ts` builds the plate from (115.29 to 117.63 m across Simonet's
// plate, `water.ts`'s "Sea level is a range"), plus THIS frame's whole-plate bob
// (the group's travel from `restY`, which `setWaveTime` applied this frame).
// The per-vertex wave (up to 4 m) is not in it: the mirror is a plane, as
// 2016's was, and the facet push hides the difference.
//
// ── What the mirror draws ────────────────────────────────────────────────
//
// The scene, through the frame camera's own layer mask less `UI_LAYER`, so the
// readable UI never reaches it and every LIGHT the frame collects is collected
// here too. That last part is not tidiness: a light count is in three's program
// cache key (DEV-186), and a pass that saw one light fewer would compile a
// second copy of every lit program in the world. So the things the mirror must
// not draw are hidden by MESH (`maskForMirror` zeroes each renderable's layer
// mask for the pass and hands it back), never by hiding a group a lamp hangs
// under: the sea itself, the rig (the camera, the HUD, the pointer), the
// cockpit and the cabin (everything on the flight but its exterior hull), the
// frame's own quads (vignette, horizon band, tint, motes), and the sky dome and
// the sun's halo.
//
// The sky is left out ON PURPOSE, and the target is cleared to transparent
// black, so a texel is premultiplied scene where something was drawn and alpha
// 0 where 2016's mirror would have shown sky. The water composites the mirror
// OVER its own per-facet sky reflection (DEV-021's), which is where the sea's
// faceting comes from; `water.ts` says why.
//
// With bloom on (Anniversary on a monitor) the frame is drawn into the
// composer's target, so it compiles the same linear, untone-mapped programs
// this pass does: no new program in the world. With bloom off the frame goes
// to the canvas, and this pass's first frame compiles its own set. Said here
// because it is a hitch nobody would look for.
//
// ── The frame around it ──────────────────────────────────────────────────
//
// Shadow maps are NOT redrawn for the mirror (`shadowMap.autoUpdate` off for
// the pass): it lights with the maps the frame drew last time, which a mirror
// at half resolution under a 0.3 push cannot show. The fog's CPU half is told
// where the mirror eye is (`eyeMoved`) and told back afterwards, because the
// half-space fog takes the eye's height from a uniform and the rest from three's
// `cameraPosition`, and the two must agree (CLAUDE.md trap 18).
//
// Below the plane (the launch ride, twelve seconds of every mission) there is
// no mirror to draw from: the target is cleared to transparent once, which
// composites as nothing, so the sea is exactly DEV-021's.

import * as THREE from 'three'
import type { ComfortSettings } from '@/boot/settings'
import type { Edition, EditionSeaReflection } from '@/content/edition-schema'
import type { EditionState } from '@/game/edition'
import { type HeightField, terrainHeightAt } from '@/sim/terrain/height-field'
import { UI_LAYER } from './bloom'
import { measuredRender, withOffscreenTarget } from './offscreen-pass'
import { ultraFor } from './quality'
import type { Water } from './water'

/** `scene.userData` key: a function returning `SeaReflectionReport`. */
export const SEA_REFLECTION_REPORT_KEY = 'seaReflection'

/**
 * METRES above the plane the eye must be for a mirror to be drawn. Below it the
 * target is cleared and the sea reflects the sky alone. Lengyel's projection
 * needs the camera strictly off the plane, and a camera on it would put the
 * near plane through the eye; half a metre is a fraction of one wave.
 */
export const MIRROR_MIN_HEIGHT = 0.5

/**
 * Whether the mirror runs, and with what: the edition's block when BOTH the
 * flag is on and ultra is in force on a monitor, else null. Pure, read live
 * (the `detailRingFor` pattern): the tier flips from the pause menu, the look
 * from the title, and a headset can start presenting mid-run.
 */
export const seaReflectionFor = (
  edition: Edition,
  settings: Pick<ComfortSettings, 'quality' | 'qualityAuto'>,
  presenting: boolean,
): EditionSeaReflection | null => {
  const block = edition.render.seaReflection
  if (!block?.enabled) return null
  return ultraFor(settings, presenting)?.seaReflection === true ? block : null
}

/** The mirror target's size in texels: the drawing buffer times `scale`, per axis, never under 1. */
export const mirrorTargetSize = (
  bufferWidth: number,
  bufferHeight: number,
  scale: number,
): { readonly width: number; readonly height: number } => ({
  width: Math.max(1, Math.floor(bufferWidth * scale)),
  height: Math.max(1, Math.floor(bufferHeight * scale)),
})

/** What the plane is read from: `LoadedTerrain`'s ocean, by the three fields this needs. */
export interface MirrorSea {
  readonly water: Water | null
  /** The collision surface, SIM space (z is three's negated), world metres in y. */
  readonly heightField: HeightField
  /** `group.position.y` as built, before the bob. */
  readonly restY: number
  readonly group: THREE.Object3D
}

/**
 * The sea plane's height, world metres, under THREE-space (x, z): the field
 * there plus this frame's whole-plate bob. See the header.
 */
export const seaPlaneY = (
  sea: Pick<MirrorSea, 'heightField' | 'restY' | 'group'>,
  x: number,
  z: number,
): number => terrainHeightAt(sea.heightField, x, -z) + (sea.group.position.y - sea.restY)

/**
 * Replace a perspective projection's near plane with `plane`, given in the
 * camera's VIEW space as (normal, constant) with the camera on its negative
 * side. Lengyel, "Oblique View Frustum Depth Projection and Clipping" (2005),
 * as three's `Reflector` transcribes it, with no clip bias. In place.
 */
export const obliqueNearPlane = (projection: THREE.Matrix4, plane: THREE.Vector4): void => {
  const e = projection.elements
  const q = _q.set(
    (Math.sign(plane.x) + (e[8] as number)) / (e[0] as number),
    (Math.sign(plane.y) + (e[9] as number)) / (e[5] as number),
    -1,
    (1 + (e[10] as number)) / (e[14] as number),
  )
  const c = _c.copy(plane).multiplyScalar(2 / plane.dot(q))
  e[2] = c.x
  e[6] = c.y
  e[10] = c.z + 1
  e[14] = c.w
}

/**
 * Stand `mirror` at `eye` reflected through `y = planeY`, aim it along the
 * reflected forward with the reflected up, give it the eye's projection, and
 * clip its near plane to the water. `eye.matrixWorld` must be current.
 */
export const placeMirrorCamera = (
  mirror: THREE.PerspectiveCamera,
  eye: THREE.Camera,
  planeY: number,
): void => {
  const m = eye.matrixWorld
  _eyePos.setFromMatrixPosition(m)
  _rot.extractRotation(m)
  _forward.set(0, 0, -1).applyMatrix4(_rot)
  _up.set(0, 1, 0).applyMatrix4(_rot)
  // Reflection through a horizontal plane: y about planeY for points, y negated
  // for directions.
  mirror.position.set(_eyePos.x, 2 * planeY - _eyePos.y, _eyePos.z)
  _target.copy(_eyePos).add(_forward)
  _target.y = 2 * planeY - _target.y
  mirror.up.set(_up.x, -_up.y, _up.z)
  mirror.lookAt(_target)
  const lens = eye as THREE.PerspectiveCamera
  if (typeof lens.near === 'number') mirror.near = lens.near
  if (typeof lens.far === 'number') mirror.far = lens.far
  mirror.updateMatrixWorld(true)
  mirror.projectionMatrix.copy(eye.projectionMatrix)
  // The water plane, normal up, into the mirror's view space.
  _plane.set(_planeNormal.set(0, 1, 0), -planeY).applyMatrix4(mirror.matrixWorldInverse)
  _clip.set(_plane.normal.x, _plane.normal.y, _plane.normal.z, _plane.constant)
  obliqueNearPlane(mirror.projectionMatrix, _clip)
  mirror.projectionMatrixInverse.copy(mirror.projectionMatrix).invert()
}

/** Something the mirror must not draw: an object, or a root drawn except for one subtree. */
export type MirrorExclusion =
  | THREE.Object3D
  | { readonly root: THREE.Object3D; readonly keep: THREE.Object3D | null }

/** The name `game/flight.ts` gives the exterior hull, the one part of the flight the mirror draws. */
export const SHIP_EXTERIOR_NAME = 'ship_third_person'

/**
 * The flight, less its exterior hull: the cockpit shell, the cabin and its
 * body, the dash readout, and the plates hung on the ship. The hull draws
 * by its own rules (shown in chase view, colourless in the seat, DEV-305).
 */
export const cockpitOf = (flight: THREE.Object3D): MirrorExclusion => ({
  root: flight,
  keep: flight.getObjectByName(SHIP_EXTERIOR_NAME) ?? null,
})

const isRenderable = (o: THREE.Object3D): boolean => {
  const r = o as THREE.Object3D & {
    isMesh?: boolean
    isPoints?: boolean
    isLine?: boolean
    isSprite?: boolean
  }
  return r.isMesh === true || r.isPoints === true || r.isLine === true || r.isSprite === true
}

/**
 * Zero every renderable's layer mask under the exclusions, so no camera draws
 * it, and return the call that hands every mask back. Lights, groups and the
 * kept subtree are untouched, and the walk does not stop at a masked mesh, so a
 * lamp hung under the cockpit is still collected (see the header for why that
 * matters to the program count). `into` is reused across calls.
 */
export const maskForMirror = (
  exclusions: readonly (MirrorExclusion | null | undefined)[],
  into: { objects: THREE.Object3D[]; masks: number[] } = { objects: [], masks: [] },
): (() => void) => {
  into.objects.length = 0
  into.masks.length = 0
  const walk = (o: THREE.Object3D, keep: THREE.Object3D | null): void => {
    if (o === keep) return
    if (isRenderable(o) && o.layers.mask !== 0) {
      into.objects.push(o)
      into.masks.push(o.layers.mask)
      o.layers.mask = 0
    }
    for (const child of o.children) walk(child, keep)
  }
  for (const x of exclusions) {
    if (!x) continue
    if (x instanceof THREE.Object3D) walk(x, null)
    else walk(x.root, x.keep)
  }
  return () => {
    for (let i = 0; i < into.objects.length; i++) {
      ;(into.objects[i] as THREE.Object3D).layers.mask = into.masks[i] as number
    }
    into.objects.length = 0
    into.masks.length = 0
  }
}

/** What a spec can read. Counts OF A FRAME, so they survive contention. */
export interface SeaReflectionReport {
  /** The gate is open and this sea can carry the mirror. */
  readonly on: boolean
  readonly width: number
  readonly height: number
  /** What the LAST pass drew, off `renderer.info`. */
  readonly calls: number
  readonly triangles: number
  /** Passes drawn since the gate last opened. */
  readonly passes: number
  /** The plane the last pass mirrored through, world metres. */
  readonly planeY: number
  /** Renderables the last pass masked out. */
  readonly masked: number
}

export interface SeaReflectionOptions {
  readonly renderer: THREE.WebGLRenderer
  readonly editionState: EditionState
  /**
   * What the mirror must not draw beyond the sea, which it always leaves out.
   * Read every pass, because the flight, the sky and the motes are rebuilt with
   * the world.
   */
  readonly excluded: () => readonly (MirrorExclusion | null | undefined)[]
  /**
   * Told which camera the next draw is from: the mirror's before its pass and
   * the frame's after. The fog's CPU half (`unity-fog.ts`'s `update`).
   */
  readonly eyeMoved?: (camera: THREE.Camera) => void
}

export interface SeaReflection {
  /** The ocean of the world now built, or null. Applies the gate at once, so the define is in place before the warm. */
  setSea(sea: MirrorSea | null): void
  /** Draw the mirror for this frame from `camera`. Once a frame, before the frame's draw, mission stage only. */
  update(scene: THREE.Scene, camera: THREE.Camera): void
  readonly report: SeaReflectionReport
  dispose(): void
}

/** Scratch, valid only inside one synchronous call (trap 19). */
const _eyePos = new THREE.Vector3()
const _forward = new THREE.Vector3()
const _up = new THREE.Vector3()
const _target = new THREE.Vector3()
const _rot = new THREE.Matrix4()
const _plane = new THREE.Plane()
const _planeNormal = new THREE.Vector3()
const _clip = new THREE.Vector4()
const _q = new THREE.Vector4()
const _c = new THREE.Vector4()
const _buffer = new THREE.Vector2()
const _clearColor = new THREE.Color()
/** The mirror starts from transparent black: what the sea composites over is the scene, not a backdrop. */
const MIRROR_CLEAR = { hex: 0x000000, alpha: 0 } as const

export const createSeaReflection = (options: SeaReflectionOptions): SeaReflection => {
  const { renderer, editionState } = options
  const mirror = new THREE.PerspectiveCamera()
  mirror.name = 'sea-reflection'
  const masking = { objects: [] as THREE.Object3D[], masks: [] as number[] }
  let sea: MirrorSea | null = null
  let target: THREE.WebGLRenderTarget | null = null
  let live = false
  /** The target holds a transparent clear and nothing else (the eye is under the plane). */
  let blank = false
  let calls = 0
  let triangles = 0
  let passes = 0
  let planeY = 0
  let masked = 0
  let receipted = false

  const presenting = (): boolean => renderer.xr.isPresenting || editionState.immersive

  const drop = (): void => {
    target?.dispose()
    target = null
    blank = false
  }

  const build = (spec: EditionSeaReflection): THREE.WebGLRenderTarget => {
    renderer.getDrawingBufferSize(_buffer)
    const size = mirrorTargetSize(_buffer.x, _buffer.y, spec.resolutionScale)
    if (target) {
      if (target.width !== size.width || target.height !== size.height) {
        target.setSize(size.width, size.height)
        blank = false
      }
      return target
    }
    // Half float, because the frame it is read into is linear HDR (the sun
    // side of an island is well over 1); linear filters and no mips, because
    // `_ReflectionRoughness` is 0, a hard mirror with no blur to bias toward.
    const t = new THREE.WebGLRenderTarget(size.width, size.height, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    })
    t.texture.name = 'seaReflection.mirror'
    target = t
    blank = false
    return t
  }

  /** Open or shut the gate, from the live preset, settings and session. Idempotent. */
  const apply = (): void => {
    const spec = seaReflectionFor(editionState.current, editionState.settings, presenting())
    const water = sea?.water ?? null
    live = spec !== null && water?.mirrors === true
    if (!live || !spec) {
      water?.setMirror(null)
      if (target) drop()
      // A shut gate reports a mirror of nothing, not the last pass flat drew.
      passes = 0
      calls = 0
      triangles = 0
      return
    }
    water?.setMirror(build(spec).texture)
  }

  const unsubscribe = editionState.subscribe(apply)

  /** Clear the target to transparent: composites as nothing, so the sea is DEV-021's. */
  const clearTarget = (t: THREE.WebGLRenderTarget): void => {
    const previous = renderer.getRenderTarget()
    renderer.getClearColor(_clearColor)
    const alpha = renderer.getClearAlpha()
    try {
      renderer.setRenderTarget(t)
      renderer.setClearColor(0x000000, 0)
      renderer.state.buffers.depth.setMask(true)
      renderer.clear(true, true, false)
    } finally {
      renderer.setClearColor(_clearColor, alpha)
      renderer.setRenderTarget(previous)
    }
  }

  const reportNow = (): SeaReflectionReport => ({
    on: live,
    width: target?.width ?? 0,
    height: target?.height ?? 0,
    calls,
    triangles,
    passes,
    planeY,
    masked,
  })

  return {
    setSea(next) {
      if (sea && sea !== next) sea.water?.setMirror(null)
      sea = next
      apply()
    },
    update(scene, camera) {
      // Where a spec can read it without a member of __ff2 (near-shadow's
      // reason): on the scene it draws, registered whether or not the gate is
      // open, so a headset session can be asked and answer "off".
      scene.userData[SEA_REFLECTION_REPORT_KEY] ??= () => reportNow()
      apply()
      const s = sea
      const t = target
      if (!live || !s || !t) return
      camera.updateWorldMatrix(true, false)
      _eyePos.setFromMatrixPosition(camera.matrixWorld)
      planeY = seaPlaneY(s, _eyePos.x, _eyePos.z)
      if (!(_eyePos.y > planeY + MIRROR_MIN_HEIGHT)) {
        if (!blank) clearTarget(t)
        blank = true
        return
      }
      placeMirrorCamera(mirror, camera, planeY)
      // The frame's layers, less the readable UI: every light it collects,
      // this collects (the program count; see the header).
      mirror.layers.mask = camera.layers.mask & ~(1 << UI_LAYER)

      const background = scene.background
      const unmask = maskForMirror([s.group, ...options.excluded()], masking)
      masked = masking.objects.length
      try {
        options.eyeMoved?.(mirror)
        scene.background = null
        // The mirror clears COLOUR as well, to transparent black, and the helper
        // hands the renderer's own clear colour back.
        withOffscreenTarget(
          renderer,
          t,
          () => {
            const drew = measuredRender(renderer, scene, mirror)
            calls = drew.calls
            triangles = drew.triangles
            passes++
            blank = false
          },
          MIRROR_CLEAR,
        )
      } finally {
        unmask()
        scene.background = background
        options.eyeMoved?.(camera)
      }
      if (!receipted) {
        receipted = true
        console.info(
          `sea reflection: first pass, ${t.width} x ${t.height}, ${calls} draws, ${triangles} triangles, ` +
            `plane ${planeY.toFixed(2)} m, ${masked} renderables masked (DEV-583)`,
        )
      }
    },
    get report(): SeaReflectionReport {
      return reportNow()
    },
    dispose() {
      unsubscribe()
      sea?.water?.setMirror(null)
      sea = null
      drop()
    },
  }
}
