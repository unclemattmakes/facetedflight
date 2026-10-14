// src/render/near-shadow.ts: a second sun shadow map over the ~100 m round the eye. DEV-582.
//
// `docs/plan/ULTRA.md` has the row. The sun's map (`render/shadows.ts`) is 2048
// texels over a 1,400 m box, 0.68 m a texel with a ~1.4 m penumbra, so the hull
// in chase view, a racer beside you, a rock you skim are all blobs. This is a
// second map, hand-rolled beside the cockpit's (DEV-323) and NOT three's CSM
// addon (which patches the same `lights_fragment_begin` statement far-shadow
// rewrites): `render.nearShadow.mapSize` texels over +-`boxHalfSize`, 2048 over
// +-80 m on Anniversary, **0.078 m a texel, 8.7x finer**. Across the sun it is
// that square round the eye; ALONG the sun it reaches two box widths up-sun for
// casters and runs four on down-sun for receivers (`nearDepthBelow` says why the
// first build's cube photographed as nothing).
//
// ── A cascade, not a second opinion: the sun's map skips what this one covers ─
//
// The plan's first sketch took a MIN of the two maps. A min of a sharp and a
// soft copy of the SAME shadow is the soft one, wherever the soft one is
// darker, which is the whole penumbra: the hull's shadow would keep its 1.4 m
// blur with a crisp core inside it. So inside the near box the sun's lookup
// pulls its receiver toward the light by this map's own up-sun reach (the
// cockpit's `mainMapSkip` mechanism, DEV-323, on every receiver), and this map
// answers every occluder in that reach at 8 cm. Past the reach the sun's map
// answers as it always did. The two meet with an overlap (this map covers more
// than its reach for receivers deeper in the box) and never a gap, and the min
// that composes them is then a min of two different occluder sets, which is
// what a min is for. `nearCover` fades the near term and the skip together to
// 0 at the box's faces across `edgeFade` metres (DEV-453's pattern), so where
// this map stops the sun's map is exactly what it was.
//
// The statement far-shadow writes becomes
//
//     directLight.color *= min( min( mix( 1, near, nearCover ),
//                                    mix( 1, getShadow( ..., bias - skip * nearCover, ... ), cover ) ),
//                               ff2SunHeightTerm() )
//
// and `ff2SunHeightTerm` carries the clouds (DEV-585).
//
// ── The casters are the sun's casters ────────────────────────────────────
//
// Everything with `castShadow` set, which `render/shadows.ts`'s table already
// decides per role, preset and tier: terrain at LOD 0 and finer, the scatter
// when `props.scatterShadows` is on, the landmarks, the hull (the colourless
// first-person one included, which is how the ship's shadow lands under you),
// the racers. Not the sea and not the cockpit shell, which cast nothing in the
// sun's map either. Gathered by a layer bit (`NEAR_CASTER_LAYER`) synced from
// `castShadow` every pass, and drawn with one depth-only override material, so
// the pass is three's own `render()` over the real scene: instancing,
// visibility and frustum culling are three's, not a re-implementation.
//
// ── Receivers, and the cockpit ───────────────────────────────────────────
//
// Whatever receives the sun's map (`receiveShadow`), at index 0, the mission
// sun. NOT the cockpit shell: it carries DEV-323's own near map and skip, which
// exist because the hull's closed canopy glass would shade the whole cabin (look
// call 6's blob), and a second 8 cm map of that glass would put the blob back.
// The shell's material defines `FF2_COCKPIT_NEAR` and the GLSL opts it out.
//
// ── One program per material, as before ──────────────────────────────────
//
// The text is constant and every switch is a uniform (`uFf2NearC.y`), so
// far-shadow's single cache-key token still names its only variant, a preset
// flip or entering a headset (`vr.disable`) recompiles nothing, and
// `warm-up.ts` has no new lit variant to build. The pass's OWN two depth
// programs (plain and instanced) are compiled when the target is built, by a
// two-mesh draw (`warmPass`), which happens at world build under the curtain.
//
// ── Headset ───────────────────────────────────────────────────────────────
//
// In `anniversary.json`'s `vr.disable` until a worn `?perf=1` capture exists:
// the pass is drawn once for both eyes, but the lookup is paid per eye on a
// worn frame that is 75 % fill (ULTRA.md).

import * as THREE from 'three'
import type { ComfortSettings } from '@/boot/settings'
import type { Edition } from '@/content/edition-schema'
import type { EditionState } from '@/game/edition'
import { mainMapSkip, type NearShadowRenderer } from './cockpit-self-shadow'
import { createPcfDepthTarget, measuredRender, withOffscreenTarget } from './offscreen-pass'
import {
  fitSunShadow,
  missionShadowsEnabled,
  type ShadowFit,
  shadowBiasFor,
  shadowEdgeFadeUv,
} from './shadows'

/** `scene.userData` key: a function returning `NearShadowReport`. */
export const NEAR_REPORT_KEY = 'nearShadow'

/** The layer bit the pass gathers casters by. Not 1 or 2 (the XR eyes), not 3 (UI), not 23 (the logo). */
export const NEAR_CASTER_LAYER = 29

/** What the preset carries. `EditionNearShadow` is this plus `enabled`. */
export interface NearShadowSpec {
  readonly enabled: boolean
  /** Texels, a power of two. */
  readonly mapSize: number
  /** METRES, half the box on both lateral axes. */
  readonly boxHalfSize: number
  /** METRES inside the box's faces over which it hands back to the sun's map. */
  readonly edgeFade: number
  /** METRES of depth bias toward the light. */
  readonly bias: number
  /** METRES along the receiver's normal before the lookup. */
  readonly normalBias: number
  /** PCF tap radius, texels. */
  readonly radius: number
}

/**
 * Whether the near map runs: the preset (with `vr.disable` folded in) AND the
 * sun's map, because it skips into that map's lookup and is off wherever that
 * map is (quality `low`, Classic).
 */
export const nearShadowEnabled = (edition: Edition, settings: ComfortSettings): boolean =>
  // DEV-932: the MISSION's sun map, which a headset can drop while the menus keep theirs.
  missionShadowsEnabled(edition, settings) && edition.render.nearShadow.enabled

/**
 * METRES up-sun past the box that casters are gathered from, and therefore the
 * sun map's skip. Two box widths: past that an occluder's shadow is long and
 * soft anyway, and the sun's map draws it. Derived, not a preset number, because
 * the skip and the reach must be one number or the cascade has a gap.
 */
export const nearReach = (boxHalfSize: number): number => 2 * Math.max(boxHalfSize, 0)

/**
 * METRES the box runs on DOWN-sun past its own half-depth, for the RECEIVERS.
 *
 * The first build was a cube round the camera, and its first photographs
 * changed nothing: the box is centred on the EYE, which in chase view floats a
 * hundred metres and more over the ground, and its down-sun face stood only
 * `boxHalfSize` past the eye along the light. The ground below, and the hull's
 * own shadow (which lies `h / sin(elevation)` down-sun of the hull, 139 m at
 * 100 m up under rookie_01's 46.5-degree sun), were outside it or in its fade
 * band. Depth costs no lateral resolution in an orthographic map, so the box
 * runs on four box widths further: the hull's shadow is inside it up to ~290 m
 * of altitude at 46.5 degrees and ~28 m at int_01's 4. Derived, like the reach.
 */
export const nearDepthBelow = (boxHalfSize: number): number => 4 * Math.max(boxHalfSize, 0)

/** The near box: `fitSunShadow`'s own fit, texel-snapped, with the near reach up-sun and `nearDepthBelow` down-sun. */
export const fitNearCascade = (
  spec: Pick<NearShadowSpec, 'boxHalfSize' | 'mapSize'>,
  centre: readonly [number, number, number],
  lightPosition: readonly [number, number, number],
  lightTarget: readonly [number, number, number],
): ShadowFit => {
  const fit = fitSunShadow({
    centre,
    lightPosition,
    lightTarget,
    boxHalfSize: spec.boxHalfSize,
    mapSize: spec.mapSize,
    castDistance: nearReach(spec.boxHalfSize),
  })
  return { ...fit, far: fit.far + nearDepthBelow(spec.boxHalfSize) }
}

/**
 * The near box's edge band in its own uv: `edgeFade` over its lateral width,
 * and over its whole depth range (reach, box, and the run down-sun). Only the
 * far plane fades, `shadowEdgeFadeUv`'s rule and its reason.
 */
export const nearEdgeFadeUv = (
  spec: Pick<NearShadowSpec, 'boxHalfSize' | 'edgeFade'>,
): { readonly lateral: number; readonly depth: number } => {
  const lateral = shadowEdgeFadeUv({
    boxHalfSize: spec.boxHalfSize,
    castDistance: 0,
    edgeFade: spec.edgeFade,
  }).lateral
  const depth =
    2 * Math.max(spec.boxHalfSize, 0) +
    nearReach(spec.boxHalfSize) +
    nearDepthBelow(spec.boxHalfSize)
  return { lateral, depth: depth > 0 ? Math.max(spec.edgeFade, 0) / depth : 0 }
}

/** The sun map's skip inside the near box, in that map's normalised depth. 0 without a fit. */
export const nearMainSkip = (
  spec: Pick<NearShadowSpec, 'boxHalfSize'>,
  mainFit: Pick<ShadowFit, 'near' | 'far'> | null,
): number => mainMapSkip(nearReach(spec.boxHalfSize), mainFit)

// ── the shader ───────────────────────────────────────────────────────────
//
// Line comments only and no backticks: these strings join far-shadow's GLSL,
// whose test strips line comments before its reserved-word sweep, and they live
// inside template literals.

/** The guard every near-map line sits under. three's prefix defines all three. */
const NEAR_GUARD =
  'defined( USE_SHADOWMAP ) && ( NUM_DIR_LIGHT_SHADOWS > 0 ) && defined( SHADOWMAP_TYPE_PCF ) && !defined( FF2_NO_NEAR_CASCADE )'

/** Everything the vertex half names. Its own constant: two symbol tables (far-shadow's VERTEX_PRELUDE). */
export const NEAR_VERTEX_PRELUDE = `#if ${NEAR_GUARD}
uniform mat4 uFf2NearMatrix;
uniform float uFf2NearNormalBias;
varying vec4 vFf2Near;
#endif`

/** Inserted after `#include <shadowmap_vertex>`, where three's own coordinate is made. */
export const NEAR_VERTEX_BODY = `#if ${NEAR_GUARD}
	vFf2Near = uFf2NearMatrix * ( worldPosition + vec4( shadowWorldNormal * uFf2NearNormalBias, 0.0 ) );
#endif`

/** The vertex include the body follows. */
export const NEAR_VERTEX_ANCHOR = '#include <shadowmap_vertex>'

/** Prepended to a fragment shader whose vertex half has no anchor: the varying would be garbage. */
export const NO_NEAR_DEFINE = '#define FF2_NO_NEAR_CASCADE 1'

export const NEAR_FRAGMENT_PRELUDE = `
// DEV-582: the near cascade (render/near-shadow.ts).
#if ${NEAR_GUARD}
#define FF2_NEAR_CASCADE 1
uniform sampler2DShadow uFf2NearMap;
// (map size, map size, depth bias normalised and negative, PCF radius texels).
uniform vec4 uFf2NearB;
// (the sun map's skip normalised to its depth, on, edge band across the sun,
// edge band along it), the bands in this map's own uv.
uniform vec4 uFf2NearC;
varying vec4 vFf2Near;
// 1 deep in the near box, 0 at its faces: far-shadow's ff2ShadowCover on this
// map's coordinate and bands, times the switch. No branch, no derivative.
float ff2NearCoverOf( vec4 nearCoord ) {
  vec3 c = nearCoord.xyz / nearCoord.w;
  vec2 across = min( c.xy, 1.0 - c.xy );
  float lateral = min( across.x, across.y ) / max( uFf2NearC.z, 1e-6 );
  float deep = ( 1.0 - c.z ) / max( uFf2NearC.w, 1e-6 );
  float t = clamp( min( lateral, deep ), 0.0, 1.0 );
  return t * t * ( 3.0 - 2.0 * t ) * uFf2NearC.y;
}
#define FF2_NEAR_SKIP ( ff2NearCover * uFf2NearC.x )
#else
#define FF2_NEAR_SKIP 0.0
#endif
// Written by the directional loop for each light and read by the statement
// after it: globals, because three pastes the loop body once per light into
// one scope and a local would be declared twice.
float ff2NearCover = 0.0;
float ff2NearShade = 1.0;
`

/**
 * The lines the directional loop gains BEFORE the shadow statement. The mission
 * sun only (index 0: three sorts shadow casters first and the mission builds
 * one), never the cockpit shell. Must not name the sun map's bias token: the
 * cockpit patch finds that token exactly once and rewrites its statement.
 */
export const NEAR_LOOP_LINES = `#if defined( FF2_NEAR_CASCADE ) && ( UNROLLED_LOOP_INDEX == 0 ) && !defined( FF2_COCKPIT_NEAR )
		ff2NearCover = receiveShadow ? ff2NearCoverOf( vFf2Near ) : 0.0;
		ff2NearShade = ( ff2NearCover > 0.0 ) ? getShadow( uFf2NearMap, uFf2NearB.xy, directionalLightShadow.shadowIntensity, uFf2NearB.z, uFf2NearB.w, vFf2Near ) : 1.0;
		#else
		ff2NearCover = 0.0;
		ff2NearShade = 1.0;
		#endif`

/** The sun map's bias token, and what the statement rewrites it to inside the near box. */
export const MAIN_BIAS_TOKEN = 'directionalLightShadow.shadowBias'
export const MAIN_BIAS_SKIPPED = `( ${MAIN_BIAS_TOKEN} - FF2_NEAR_SKIP )`

/** The uniforms every patched program shares. One object, so one write reaches all. */
export interface NearCascadeUniforms {
  readonly uFf2NearMatrix: { value: THREE.Matrix4 }
  readonly uFf2NearNormalBias: { value: number }
  /** null binds three's own empty shadow texture, which is what a sampler2DShadow wants. */
  readonly uFf2NearMap: { value: THREE.Texture | null }
  readonly uFf2NearB: { value: THREE.Vector4 }
  readonly uFf2NearC: { value: THREE.Vector4 }
}

/** A block built OFF (`uFf2NearC.y` 0). */
export const createNearCascadeUniforms = (): NearCascadeUniforms => ({
  uFf2NearMatrix: { value: new THREE.Matrix4() },
  uFf2NearNormalBias: { value: 0 },
  uFf2NearMap: { value: null },
  uFf2NearB: { value: new THREE.Vector4(1, 1, 0, 1) },
  uFf2NearC: { value: new THREE.Vector4(0, 0, 0, 0) },
})

/**
 * Sync the caster layer from `castShadow`: on for every mesh that casts, off
 * for every one that does not. Returns how many cast. A mesh's other layers
 * are untouched, so no camera that does not enable this bit sees a difference.
 */
export const syncNearCasters = (root: THREE.Object3D): number => {
  let n = 0
  root.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (mesh.isMesh !== true) return
    if (mesh.castShadow) {
      mesh.layers.enable(NEAR_CASTER_LAYER)
      n++
    } else mesh.layers.disable(NEAR_CASTER_LAYER)
  })
  return n
}

// ── the live system ──────────────────────────────────────────────────────

/** What a spec can read. Counts OF A FRAME, so they survive contention. */
export interface NearShadowReport {
  readonly on: boolean
  readonly mapSize: number
  readonly texelSize: number
  readonly casters: number
  readonly calls: number
  readonly triangles: number
  readonly passes: number
  readonly skipNormalised: number
}

export interface NearShadow {
  /** Hand to `createFarShadow`, which splices the GLSL and binds these. */
  readonly uniforms: NearCascadeUniforms
  /**
   * Render the near map for this frame from `camera`'s world position, over
   * `scene`. Once a frame, before the main draw, on the mission stage only.
   */
  update(scene: THREE.Scene, camera: THREE.Object3D): void
  readonly report: NearShadowReport
  dispose(): void
}

/** Scratch, valid only inside one synchronous call (trap 19). */
const _eye = new THREE.Vector3()
const _sunPos = new THREE.Vector3()
const _sunTarget = new THREE.Vector3()

export const createNearShadow = (
  renderer: NearShadowRenderer,
  sun: THREE.DirectionalLight | null,
  editionState: EditionState,
  /** The SUN's live fit (`SunShadows.fit`), whose depth range the skip is normalised to. */
  mainFit: () => Pick<ShadowFit, 'near' | 'far'> | null,
): NearShadow => {
  const uniforms = createNearCascadeUniforms()
  let target: THREE.WebGLRenderTarget | null = null
  let sizedFor = 0
  let light: THREE.DirectionalLight | null = null
  let depth: THREE.MeshBasicMaterial | null = null
  let on = false
  let texelSize = 0
  let casters = 0
  let calls = 0
  let triangles = 0
  let passes = 0
  /** The receipt is for the first pass that DREW something: the title draws none. */
  let receipted = false
  let skipNormalised = 0

  const spec = (): NearShadowSpec => editionState.current.render.nearShadow

  /** Compile the pass's two depth programs (plain, instanced) into the new target. */
  const warmPass = (t: THREE.WebGLRenderTarget, material: THREE.Material): void => {
    const scene = new THREE.Scene()
    const box = new THREE.BoxGeometry(1, 1, 1)
    const plain = new THREE.Mesh(box, material)
    const many = new THREE.InstancedMesh(box, material, 1)
    for (const m of [plain, many]) {
      m.frustumCulled = false
      m.layers.set(NEAR_CASTER_LAYER)
      scene.add(m)
    }
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10)
    camera.position.set(0, 0, 5)
    camera.layers.set(NEAR_CASTER_LAYER)
    camera.updateMatrixWorld()
    withOffscreenTarget(renderer, t, () => renderer.render(scene, camera))
    many.dispose()
    box.dispose()
  }

  const build = (size: number): void => {
    if (target && sizedFor === size) return
    target?.depthTexture?.dispose()
    target?.dispose()
    const t = createPcfDepthTarget(size, 'nearShadow.map')
    target = t
    sizedFor = size
    depth ??= new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide, fog: false })
    light ??= new THREE.DirectionalLight()
    // Cleared to the far plane and both depth programs compiled, now, so the
    // first frame that samples it reads lit and links nothing.
    warmPass(t, depth)
    uniforms.uFf2NearMap.value = t.depthTexture
  }

  const apply = (): void => {
    on = sun !== null && nearShadowEnabled(editionState.current, editionState.settings)
    if (on) build(spec().mapSize)
    uniforms.uFf2NearC.value.y = 0
    if (!on) passes = 0
  }

  const unsubscribe = editionState.subscribe(apply)
  apply()

  const reportNow = (): NearShadowReport => ({
    on,
    mapSize: sizedFor,
    texelSize,
    casters,
    calls,
    triangles,
    passes,
    skipNormalised,
  })

  return {
    uniforms,
    update(scene, camera) {
      uniforms.uFf2NearC.value.y = 0
      if (!on || !sun || !target || !light || !depth) return
      const s = spec()
      sun.updateWorldMatrix(true, false)
      sun.target.updateWorldMatrix(true, false)
      sun.getWorldPosition(_sunPos)
      sun.target.getWorldPosition(_sunTarget)
      camera.getWorldPosition(_eye)
      const fit = fitNearCascade(
        s,
        [_eye.x, _eye.y, _eye.z],
        [_sunPos.x, _sunPos.y, _sunPos.z],
        [_sunTarget.x, _sunTarget.y, _sunTarget.z],
      )
      // The light stands where the sun does and looks where it looks, so three's
      // `updateMatrices` builds the same view basis `fitSunShadow` quantised in.
      light.position.copy(_sunPos)
      light.target.position.copy(_sunTarget)
      light.updateMatrixWorld(true)
      light.target.updateMatrixWorld(true)
      const cam = light.shadow.camera
      cam.left = fit.left
      cam.right = fit.right
      cam.bottom = fit.bottom
      cam.top = fit.top
      cam.near = fit.near
      cam.far = fit.far
      cam.updateProjectionMatrix()
      light.shadow.updateMatrices(light)
      cam.layers.set(NEAR_CASTER_LAYER)
      texelSize = fit.texelSize
      skipNormalised = nearMainSkip(s, mainFit())
      const band = nearEdgeFadeUv(s)
      uniforms.uFf2NearMatrix.value.copy(light.shadow.matrix)
      uniforms.uFf2NearNormalBias.value = s.normalBias
      uniforms.uFf2NearB.value.set(s.mapSize, s.mapSize, shadowBiasFor(s.bias, fit), s.radius)
      uniforms.uFf2NearC.value.set(skipNormalised, 1, band.lateral, band.depth)
      casters = syncNearCasters(scene)
      // Where a spec can read it without a new member of __ff2 (the cockpit's
      // own reason, REPORT_KEY): on the scene it draws. A function, so a
      // serialised scene drops it.
      scene.userData[NEAR_REPORT_KEY] ??= () => reportNow()
      // The pass is three's own render of the real scene, through the caster
      // layer, with one depth material. The background is a colour draw this
      // target does not want; both are handed back in a finally.
      const background = scene.background
      const override = scene.overrideMaterial
      const drawTarget = target
      const material = depth
      try {
        scene.background = null
        scene.overrideMaterial = material
        withOffscreenTarget(renderer, drawTarget, () => {
          const drew = measuredRender(renderer, scene, cam)
          calls = drew.calls
          triangles = drew.triangles
          passes++
        })
        if (!receipted && casters > 0) {
          receipted = true
          console.info(
            `near shadow: first pass with casters, ${casters} casters, ${calls} draws, ${triangles} triangles, ` +
              `${texelSize.toFixed(3)} m a texel, skip ${skipNormalised.toFixed(4)}`,
          )
        }
      } finally {
        scene.background = background
        scene.overrideMaterial = override
      }
    },
    get report(): NearShadowReport {
      return reportNow()
    },
    dispose() {
      unsubscribe()
      target?.depthTexture?.dispose()
      target?.dispose()
      target = null
      depth?.dispose()
      depth = null
    },
  }
}
