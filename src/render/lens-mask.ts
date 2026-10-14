// src/render/lens-mask.ts: the app's own lens mask. DEV-930, lever 9 of
// `docs/plan/ANNIVERSARY-VR-FRAMERATE.md` section 3.1.
//
// ── What it is for ───────────────────────────────────────────────────────
//
// Every eye-buffer pixel the headset's lens cannot show is shaded anyway and
// then thrown away by the compositor's distortion. The runtime's own mask
// (`XR_KHR_visibility_mask`, Chrome's `visibilitymaskchange`) would say which
// pixels those are, but SteamVR sends an EMPTY one (`docs/HISTORY.md`, DEV-331's
// worn reading; `boot/visibility-mask.ts` records it). So the shape here is
// OURS: a ring in each eye's clip space, from a circle out past the corners,
// that writes near-plane depth with colour writes OFF and is drawn first in
// each eye. Everything after it that tests depth (the terrain, the props, the
// cockpit, the sea, and the sky dome, which is drawn LAST at the far plane with
// its depth test on, `render/draw-order.ts`) fails the test there and is
// rejected before its fragment shader runs. That is the saving, and it is
// capped at the masked fraction of the eye.
//
// ── The region, and why the default is so small ──────────────────────────
//
// The visible region is a circle of radius `radius` in the eye's NDC (so an
// ellipse in pixels on a non-square eye), centred where the eye's own forward
// axis lands: `-projectionMatrix[2].xy`, read in the vertex shader per eye. An
// off-axis eye (every real headset's) moves its lens centre off the middle of
// the buffer, and reading it from the projection keeps the circle on the lens
// rather than on the buffer.
//
// Nobody has calibrated it by eye. So the default (`LENS_MASK_RADIUS_DEFAULT`)
// masks only the far tips of the corners, which no lens shows: about 2.8 % of
// a symmetric eye (`hiddenFraction`). The worn sitting sizes it during FAST
// head yaw (plan section 3.4 risk (a): reprojection and the stream can pull
// edge pixels into view on a turn, which a runtime mask is sized for and a
// by-eye one is not), with `?lensMask=<radius>` at load or
// `__ff2.lensMask(<radius>)` live. `?lensMask=0` is the off arm.
//
// ── Only in a headset, and only in the two eyes ──────────────────────────
//
// Three locks, each sufficient on its own:
//
//  1. The app attaches the mesh to the XR rig on `sessionstart` and takes it
//     off on `sessionend` (`boot/app.ts`). On a monitor it is not in any scene,
//     so it draws nothing, culls nothing and compiles nothing (`renderer.compile`
//     walks hidden objects, so `visible = false` alone would not keep its program
//     out of a flat count).
//  2. It sits on layers 1 AND 2, which are the WebXR eyes. This is the
//     deliberate exception `docs/plan/XR-PERF-VS-THREE.md` section 3.11 premise
//     4 named: `src/render/CLAUDE.md` keeps ordinary content off those layers
//     because an object on ONE of them is in one eye only (DEV-141). On BOTH it
//     is in both eyes, and in no camera that is not an eye: the app camera
//     carries layer 0 and `UI_LAYER`, so a mirror, a shadow or any other pass
//     that copies its mask never collects it. `tests/unit/xr-eye-layers.test.ts`
//     section 4 holds the exception to exactly this mesh.
//  3. `onBeforeRender` empties the draw range unless the camera is one of
//     `renderer.xr.getCamera().cameras` while presenting. three reads the draw
//     range per draw (`renderBufferDirect`), so a pass that reached it anyway
//     would draw zero vertices.
//
// ── What draws over it, and why that is fine ─────────────────────────────
//
// A material with `depthTest: false` ignores the primed depth and still paints
// the masked corners: the comfort vignette (and the gate pulse, the static and
// the whiteout on that same quad), the HUD and its gauges, the race map, the
// comfort horizon, the plates, the reticle and the pointer beam. They cost
// their own fill there, exactly as before; none of it was ever visible through
// the lens, and none of it is made more expensive. The masked pixels otherwise
// keep the clear colour, since colour writes are off.

import * as THREE from 'three'

/**
 * The NDC radius of the visible region, by default. Conservative on purpose:
 * the circle passes through 88 % of the half-diagonal, so only the corner tips
 * go (2.8 % of a symmetric eye). The worn calibration replaces this.
 */
export const LENS_MASK_RADIUS_DEFAULT = 1.25

/**
 * Smallest radius the pin or the handle will take. Below the half-width the
 * mask eats the middle of the eye, which is a typo, not a calibration.
 */
export const LENS_MASK_RADIUS_MIN = 0.5

/** At or past the half-diagonal (sqrt 2) the default-centred mask is empty. */
export const LENS_MASK_RADIUS_MAX = 2

/** Both WebXR eye layers, 1 and 2, as a mask. See the header, lock 2. */
export const LENS_MASK_LAYERS = (1 << 1) | (1 << 2)

/**
 * Before everything in each eye. `painterSortStable` sorts by the parent
 * group's order first, so the mesh sits in its own group at this order as well
 * (a group anywhere else with a negative order, e.g. a medal holder at -1,
 * would otherwise sort ahead of it).
 */
export const LENS_MASK_ORDER = -1_000_000

/** Segments around the circle. The polygon circumscribes it (see `VERTEX`). */
const SEGMENTS = 64

/**
 * The ring's outer edge, in NDC from the centre: past every corner of the eye
 * for any centre within a unit of the middle. The GPU clips the excess.
 */
const OUTER = 4

/**
 * Clip-space z over w. Just inside the near plane rather than on it, so the
 * clip test is not asked to decide an equality; the window depth this writes
 * is about 5e-6, nearer than anything a 0.08 m near plane lets through.
 */
const NEAR_Z = -0.99999

const VERTEX = /* glsl */ `
uniform float uRadius;
void main() {
  // The eye's forward axis in NDC: view (0, 0, -1) through this eye's matrix.
  vec2 centre = -vec2(projectionMatrix[2][0], projectionMatrix[2][1]);
  // position.xy is the unit direction, position.z 0 inner and 1 outer. The
  // inner ring is pushed out by 1 / cos(pi / SEGMENTS) so the polygon's edges
  // lie OUTSIDE the circle: the mask covers less than the circle's outside,
  // never more.
  float r = mix(uRadius * ${(1 / Math.cos(Math.PI / SEGMENTS)).toFixed(6)}, ${OUTER.toFixed(1)}, position.z);
  gl_Position = vec4(centre + position.xy * r, ${NEAR_Z}, 1.0);
}
`

const FRAGMENT = /* glsl */ `
void main() {
  gl_FragColor = vec4(0.0);
}
`

/** The ring: SEGMENTS quads between the inner circle and the outer edge. */
const ringGeometry = (): THREE.BufferGeometry => {
  const positions: number[] = []
  const indices: number[] = []
  for (let i = 0; i < SEGMENTS; i++) {
    const a = (i / SEGMENTS) * Math.PI * 2
    const x = Math.cos(a)
    const y = Math.sin(a)
    positions.push(x, y, 0, x, y, 1)
  }
  for (let i = 0; i < SEGMENTS; i++) {
    const inner = i * 2
    const outer = inner + 1
    const nextInner = ((i + 1) % SEGMENTS) * 2
    const nextOuter = nextInner + 1
    indices.push(inner, outer, nextOuter, inner, nextOuter, nextInner)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  // The positions are not in any space a bound could describe; the mesh is
  // never culled (`frustumCulled = false`) and never picked (`raycast` below).
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Number.POSITIVE_INFINITY)
  return geometry
}

/**
 * The share of a symmetric eye's NDC square outside a circle of `radius` at
 * its middle. A grid count, for the report and the trace line, not a claim
 * about a real lens; an off-axis eye's share differs a little.
 */
export const hiddenFraction = (radius: number, cells = 256): number => {
  if (!(radius > 0)) return 0
  let hidden = 0
  const r2 = radius * radius
  for (let i = 0; i < cells; i++) {
    const x = -1 + ((i + 0.5) * 2) / cells
    for (let j = 0; j < cells; j++) {
      const y = -1 + ((j + 0.5) * 2) / cells
      if (x * x + y * y > r2) hidden++
    }
  }
  return hidden / (cells * cells)
}

/**
 * `?lensMask=`: absent or `on` is the default radius, `0` or `off` is off, a
 * number in [LENS_MASK_RADIUS_MIN, LENS_MASK_RADIUS_MAX] is that radius.
 * Anything else warns and takes the default, so a typo does not silently turn
 * the arm off. Returns the radius, or `null` for off.
 */
export const parseLensMaskPin = (
  raw: string | null,
  warn: (message: string) => void = () => {},
): number | null => {
  if (raw === null || raw === '' || raw === 'on') return LENS_MASK_RADIUS_DEFAULT
  if (raw === '0' || raw === 'off') return null
  const value = Number(raw)
  if (Number.isFinite(value) && value >= LENS_MASK_RADIUS_MIN && value <= LENS_MASK_RADIUS_MAX) {
    return value
  }
  warn(
    `?lensMask: ignoring "${raw}"; expected 0, off, on, or a radius in ` +
      `[${LENS_MASK_RADIUS_MIN}, ${LENS_MASK_RADIUS_MAX}]`,
  )
  return LENS_MASK_RADIUS_DEFAULT
}

export interface LensMaskReport {
  /** The mask draws when it is attached and presenting. */
  readonly enabled: boolean
  /** NDC radius of the visible region, or null when off. */
  readonly radius: number | null
  /** `hiddenFraction(radius)`: the share of a symmetric eye it covers. */
  readonly hiddenFraction: number
  /** In a scene, i.e. a session is running. */
  readonly attached: boolean
  /** Eye draws so far (two a frame in stereo). For the tests and a capture. */
  readonly eyeDraws: number
}

export interface LensMask {
  /** The group the app attaches to the rig. Holds the one mesh. */
  readonly object: THREE.Group
  readonly mesh: THREE.Mesh
  /** `null` or 0 turns it off; a radius outside the bounds is clamped. */
  set(radius: number | null): LensMaskReport
  attach(parent: THREE.Object3D): void
  detach(): void
  report(): LensMaskReport
  dispose(): void
}

interface XrLike {
  readonly isPresenting: boolean
  getCamera(): { readonly cameras: readonly THREE.Camera[] }
}

interface SessionEvents {
  addEventListener?: (type: string, fn: () => void) => void
  removeEventListener?: (type: string, fn: () => void) => void
}

/**
 * Lock 1 of the header: in `parent` (the XR rig, which moves between the
 * mission and menu scenes with the frame) from `sessionstart` to `sessionend`,
 * and in no scene otherwise. Returns the unsubscribe.
 */
export const followSessions = (
  mask: Pick<LensMask, 'attach' | 'detach'>,
  xr: unknown,
  parent: THREE.Object3D,
): (() => void) => {
  const events = xr as SessionEvents
  const on = (): void => mask.attach(parent)
  const off = (): void => mask.detach()
  events.addEventListener?.('sessionstart', on)
  events.addEventListener?.('sessionend', off)
  return () => {
    events.removeEventListener?.('sessionstart', on)
    events.removeEventListener?.('sessionend', off)
  }
}

export const createLensMask = (radius: number | null = LENS_MASK_RADIUS_DEFAULT): LensMask => {
  const uniforms = { uRadius: { value: LENS_MASK_RADIUS_DEFAULT } }
  const material = new THREE.ShaderMaterial({
    name: 'lens-mask',
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms,
    colorWrite: false,
    depthWrite: true,
    // ON: with the depth test off GL writes no depth at all. Drawn first after
    // the clear, LESS-EQUAL against 1.0 always passes.
    depthTest: true,
    side: THREE.DoubleSide,
    fog: false,
    // Left at the default (true) on purpose: `render/bloom.ts` moves every
    // `toneMapped: false` mesh to `UI_LAYER`, which would take it off the eyes.
    toneMapped: true,
  })
  const geometry = ringGeometry()
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'lens-mask'
  mesh.frustumCulled = false
  mesh.castShadow = false
  mesh.receiveShadow = false
  mesh.renderOrder = LENS_MASK_ORDER
  mesh.layers.mask = LENS_MASK_LAYERS
  mesh.raycast = () => {}
  const object = new THREE.Group()
  object.name = 'lens-mask-group'
  object.renderOrder = LENS_MASK_ORDER
  object.layers.mask = LENS_MASK_LAYERS
  object.add(mesh)

  let current: number | null = null
  let eyeDraws = 0

  mesh.onBeforeRender = (renderer, _scene, camera) => {
    const xr = (renderer as unknown as { xr?: XrLike }).xr
    const eye = xr?.isPresenting === true && xr.getCamera().cameras.includes(camera)
    geometry.setDrawRange(0, eye ? Number.POSITIVE_INFINITY : 0)
    if (eye) eyeDraws++
  }

  const report = (): LensMaskReport =>
    Object.freeze({
      enabled: current !== null && object.parent !== null,
      radius: current,
      hiddenFraction: current === null ? 0 : hiddenFraction(current),
      attached: object.parent !== null,
      eyeDraws,
    })

  const set = (next: number | null): LensMaskReport => {
    current =
      next === null || !(next > 0)
        ? null
        : Math.min(LENS_MASK_RADIUS_MAX, Math.max(LENS_MASK_RADIUS_MIN, next))
    if (current !== null) uniforms.uRadius.value = current
    mesh.visible = current !== null
    return report()
  }
  set(radius)

  return {
    object,
    mesh,
    set,
    attach(parent) {
      if (object.parent !== parent) parent.add(object)
    },
    detach() {
      object.removeFromParent()
    },
    report,
    dispose() {
      object.removeFromParent()
      geometry.dispose()
      material.dispose()
    },
  }
}
