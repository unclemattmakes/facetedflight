// src/render/cockpit-self-shadow.ts — the cockpit's own shadow on itself.
//
// DEV-323. Matt, 2026-09-23, answering NEXT.md's look call 6: *"in first
// person, i'd expect the cockpit to cast shadows on itself. like the bars
// should cast shadows on the console in the right conditions and whatnot."*
//
// ── Why the sun's map cannot do it ───────────────────────────────────────
//
// `render/shadows.ts` is one directional map, 2048 texels over a 1,400 m box:
// **0.68 m a texel** and a 1.37 m penumbra. A canopy bar is centimetres wide,
// so that map can make a blob and nothing smaller. This file is a SECOND map
// whose box is the ship: `render.cockpitSelfShadow.mapSize` texels over the
// cockpit shell's own bounding sphere — r = 3.38 m off the GLB, so **3.3 mm a
// texel** at the shipped 2048, two hundred times finer. It is cast by the shell
// and sampled by the shell and by nothing else.
//
// ── The hull is NOT a caster, and that is the finding ────────────────────
//
// NEXT.md's row says *"cast by `ship_first_person` + the hull"*. The hull's
// canopy is a CLOSED, OPAQUE shell: `hoverjet-exterior.glb` models the glass
// as near-black polygons (vertex colour 0.034) 0.33–0.43 m from the eye, and
// a ray from the eye hits it in all 720 of 720 directions 15–85° up, where the
// shell's frame stops 64 (8.9 %) — `tests/unit/cockpit-self-shadow.test.ts`
// casts them. So the hull in this
// map shades the whole cabin, which is look call 6's blob at a finer grain and
// still no bar. `ship_first_person` is the whole AIRFRAME too (same bounds to
// the millimetre: wings, nose, tail) with the canopy OPEN and its frame as
// bars. It is the whole caster set on its own.
//
// ── The blob, and why this file has to touch the SUN's map as well ───────
//
// That glass is also what look call 6 measured. With `render.shipShadow` the
// hull casts into the sun's map, with `render.cockpitShadow` the shell
// receives it, and a software ray-cast from the seat at 45 s of
// `rookie_01_hoverJet` puts **73 %** of the visible cockpit in the hull's
// shadow against **30 %** in the shell's own. A bar's shadow inside a region
// that is already fully shaded changes no pixel, so a near map that only ADDED
// its term would be on, correct, and invisible under the shipped flags.
//
// So while this map is on, the shell's lookup into the SUN's map skips every
// occluder within the near box's own depth, `2 x radius` up-sun: the near map
// answers the ship's shadow on itself, at 3.3 mm, and the sun's map answers
// everything further away — the ridge DEV-306 exists for — at 0.68 m.
// `mainMapSkip` is that one number, and it is derived from the box rather
// than tuned, because "the near map owns the depth it covers" is the only
// definition under which the two maps neither double-count nor leave a gap:
// every hull vertex is inside the shell's sphere (the test measures it), so no
// hull occluder is further than `2 x radius` from any shell fragment. A world
// occluder less than ~6.8 m up-sun of the cockpit is lost with it; at flying
// speed that is a tenth of a second under a tree. (The first half-metre was
// never the sun map's anyway: `render.shadows.bias` is 0.5 m.)
//
// ── The box follows the ship RIGIDLY, and the sun's map's snap is wrong here ─
//
// `shadows.ts` snaps its box to whole texels in the light's basis so that a
// WORLD edge lands on the same texels frame after frame as the camera flies.
// Here the caster and the receiver are the same rigid object, so the stable
// frame is the SHIP's, not the world's: centred exactly on the shell's
// bounding sphere, a pure translation of the ship moves every point of it and
// the whole box together, and the map is the same picture to float precision.
// Snap it to the world and the bars' shadows would jump by a fresh fraction
// of a texel every frame — at 100 m/s a frame is ~330 texels of travel, so
// the phase is effectively random — which is flicker on the one surface a
// metre from the eye. The radius is the sphere's, not a per-frame fit, so the
// texel size never breathes as the ship turns. What remains is ROTATION
// against the sun, which moves the shadows because the shadows really move;
// how that reads in a headset is the worn check, and it is `shadows.ts`'s
// argument against the cockpit casting (*"shimmer you cannot look away
// from"*, at 0.88 m texels) turned from a reason not to try into a question.
//
// ── How it reaches the shader ────────────────────────────────────────────
//
// One `onBeforeCompile` on the shell's material, chained after far-shadow's
// (which EXPANDS `#include <lights_fragment_begin>`), and able to find its
// anchor in either shape, like `point-light-scope.ts`. It rewrites the one
// directional shadow statement's bias and appends a multiply inside the same
// `#if` — so the term exists only where the sun's map exists, and only for the
// shadow-casting light (index 0, the mission sun: three sorts casters first).
// The cabin's two lamps are point lights and are not touched. A PRODUCT with
// the sun's term, not the min `far-shadow.ts` takes: those two are the same
// edge seen twice, while these are different occluders, and independent
// occluders multiply.
//
// `FF2_COCKPIT_NEAR` is a define with the VALUE 0 or 1, assigned in place and
// never deleted, so three's program cache key (which walks defines in
// insertion order, DEV-194) is a function of the state and not of the flip
// history. A flip recompiles the shell's program and nothing else.
//
// ── What it must never touch ──────────────────────────────────────────────
//
// Classic. Nothing is constructed — no render target, no proxy, no patch —
// until a preset asks, which is `cockpit-interior.ts`'s rule. The JumpSeat,
// which has no `ship_first_person` and gets nothing. And the renderer's state:
// the pass hands back the render target, `xr.enabled`, `autoClear`,
// `shadowMap.autoUpdate` and `info.autoReset` in a `finally`, because a throw
// on a lost context that left `xr.enabled` false would put the next frame's
// headset view through a flat camera.

import * as THREE from 'three'
import type { ComfortSettings } from '@/boot/settings'
import type { Edition, EditionCockpitSelfShadow } from '@/content/edition-schema'
import type { EditionState } from '@/game/edition'
import {
  createPcfDepthTarget,
  measuredRender,
  type OffscreenRenderer,
  withOffscreenTarget,
} from './offscreen-pass'
import { chainShaderPatch } from './program-cache-key'
import { uniqueMaterialsOf } from './scene-walk'
import { missionShadowsEnabled, type ShadowFit, type Vec3 } from './shadows'

/** The token this patch adds to three's program cache key. */
export const COCKPIT_SELF_SHADOW_TAG = 'cockpit-self-shadow'

/** The define, VALUE 0 or 1. See the header for why it is never deleted. */
export const NEAR_DEFINE = 'FF2_COCKPIT_NEAR'

/** The name `flight.ts` gives the cockpit shell. The one caster, and the one receiver. */
export const COCKPIT_ROOT_NAME = 'ship_first_person'

/** `userData` key on the shell: a function returning `CockpitSelfShadowReport`. */
export const REPORT_KEY = 'cockpitSelfShadow'

/**
 * Whether the near map runs, from the preset AND the player's quality tier.
 *
 * Composed from `shadowsEnabled` rather than beside it, for `shadowCastersFor`'s
 * reason: the sun's map is off at quality `low` and on Classic, and so is this.
 * It is also what puts the near map under the Advanced page's SHADOWS row
 * without an eighth row of its own — press it and both passes go.
 */
export const cockpitSelfShadowEnabled = (edition: Edition, settings: ComfortSettings): boolean =>
  // DEV-932: the MISSION's map, so a headset that drops it drops this too, and
  // the term (which lives inside the sun map's own `#if`) is never left pointing
  // at a map nobody draws.
  missionShadowsEnabled(edition, settings) && edition.render.cockpitSelfShadow.enabled

// ── the fit ──────────────────────────────────────────────────────────────

export interface NearShadowFitInput {
  /** The casters' bounding-sphere centre, WORLD. */
  readonly centre: Vec3
  /** Its radius, WORLD metres. */
  readonly radius: number
  /** The direction the sun's light TRAVELS, world. Need not be unit. */
  readonly lightDirection: Vec3
  /** Map edge in texels. */
  readonly mapSize: number
}

export interface NearShadowFit {
  /** Where the shadow camera stands: `2 x radius` up-sun of the centre. */
  readonly eye: Vec3
  /** What it looks at — the centre. */
  readonly target: Vec3
  /** Half the box on both lateral axes: the radius. */
  readonly halfSize: number
  /** Near and far along the light, from the eye. `far - near` is `2 x radius`. */
  readonly near: number
  readonly far: number
  /** Metres per texel. */
  readonly texelSize: number
}

/**
 * The near box: a cube of `2 x radius` round the casters' bounding sphere,
 * seen along the sun.
 *
 * NOT snapped — see the header. Pure, like `fitSunShadow`, so the invariance
 * the header claims is a test rather than a sentence.
 */
export const fitNearShadow = (input: NearShadowFitInput): NearShadowFit => {
  const len = Math.hypot(input.lightDirection[0], input.lightDirection[1], input.lightDirection[2])
  const d: Vec3 =
    len > 0
      ? [
          input.lightDirection[0] / len,
          input.lightDirection[1] / len,
          input.lightDirection[2] / len,
        ]
      : [0, -1, 0]
  const r = Math.max(input.radius, 1e-3)
  const back = 2 * r
  return {
    eye: [
      input.centre[0] - d[0] * back,
      input.centre[1] - d[1] * back,
      input.centre[2] - d[2] * back,
    ],
    target: [input.centre[0], input.centre[1], input.centre[2]],
    halfSize: r,
    near: back - r,
    far: back + r,
    texelSize: (2 * r) / Math.max(input.mapSize, 1),
  }
}

/**
 * Put a fit on a three `DirectionalLight` and let three build the matrices.
 *
 * The light is never added to a scene and lights nothing: it is the cheapest
 * way to get three's own `LightShadow.updateMatrices` — the camera placed by
 * `lookAt` with the degenerate overhead branch three already has, and
 * `shadow.matrix` = bias x projection x view, exactly as the sun's map gets
 * its own. The shader samples THIS matrix, so what the tests project through
 * is what the GPU projects through.
 */
export const applyNearFit = (light: THREE.DirectionalLight, fit: NearShadowFit): void => {
  light.position.set(fit.eye[0], fit.eye[1], fit.eye[2])
  light.target.position.set(fit.target[0], fit.target[1], fit.target[2])
  light.updateMatrixWorld(true)
  light.target.updateMatrixWorld(true)
  const cam = light.shadow.camera
  cam.left = -fit.halfSize
  cam.right = fit.halfSize
  cam.bottom = -fit.halfSize
  cam.top = fit.halfSize
  cam.near = fit.near
  cam.far = fit.far
  cam.updateProjectionMatrix()
  light.shadow.updateMatrices(light)
}

/**
 * How far the shell's lookup into the SUN's map is pulled toward the light,
 * in that map's NORMALISED depth: `reach / (far - near)`. 0 without a fit.
 *
 * `reach` is the near box's own depth, `2 x radius`: the near map answers
 * every occluder that close, so the sun's map must not answer it again. See
 * the header's second section.
 */
export const mainMapSkip = (
  reachMetres: number,
  mainFit: Pick<ShadowFit, 'near' | 'far'> | null,
): number => {
  if (!mainFit) return 0
  const range = mainFit.far - mainFit.near
  if (!(range > 0) || !(reachMetres > 0)) return 0
  return reachMetres / range
}

/**
 * The near map's casters: the cockpit shell's MESHES, and never the hull's.
 *
 * Found under `flight`'s root by name, as `boot/app.ts` finds both for the
 * sun's map. Meshes rather than the root for DEV-305's reason (three reads
 * everything off the object it draws). Empty on the JumpSeat, which has no
 * shell by this name — the honest answer rather than a fallback.
 */
export const nearShadowCastersOf = (flight: THREE.Object3D | null | undefined): THREE.Mesh[] => {
  const root = flight?.getObjectByName(COCKPIT_ROOT_NAME)
  const out: THREE.Mesh[] = []
  root?.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (mesh.isMesh === true) out.push(mesh)
  })
  return out
}

// ── the shader ───────────────────────────────────────────────────────────

/** The one directional-shadow token. Exactly once in `lights_fragment_begin`. */
const SHADOW_BIAS = 'directionalLightShadow.shadowBias'
const LIGHTS_INCLUDE = '#include <lights_fragment_begin>'
const VERTEX_ANCHOR = '#include <shadowmap_vertex>'
/** What a lit fragment shader contains when the anchor is missing for a bad reason. */
const LIT_MARKER = '#include <lights_pars_begin>'

/** The skip, as a macro, so the rewritten statement reads the same with the term off. */
const MAIN_SKIP = 'FF2_COCKPIT_MAIN_SKIP'

/**
 * Everything the vertex half names. Its own constant because the two halves
 * are two symbol tables — `far-shadow.ts`'s `VERTEX_PRELUDE` has the story
 * (`VALIDATE_STATUS false`, 1282) and the test sweeps both halves for names
 * they use and do not declare.
 */
export const NEAR_VERTEX_PRELUDE = `#ifndef ${NEAR_DEFINE}
#define ${NEAR_DEFINE} 0
#endif
#if ${NEAR_DEFINE}
uniform mat4 uFf2CockpitNearMatrix;
uniform float uFf2CockpitNearNormalBias;
varying vec4 vFf2CockpitNear;
#endif`

export const NEAR_FRAGMENT_PRELUDE = `#ifndef ${NEAR_DEFINE}
#define ${NEAR_DEFINE} 0
#endif
#if ${NEAR_DEFINE}
uniform sampler2DShadow uFf2CockpitNearMap;
// x: 1 / mapSize. y: depth bias, NORMALISED, negative. z: PCF offset in
// texels. w: the SUN's map skip, normalised to that map's depth (DEV-323).
uniform vec4 uFf2CockpitNearParams;
varying vec4 vFf2CockpitNear;
#define ${MAIN_SKIP} uFf2CockpitNearParams.w
// ndl is N.L for this fragment and the sun. At or below zero the surface faces
// away and RE_Direct adds nothing whatever this returns, so no tap is paid.
// The bias grows with the slope, capped at 5x: a facet the sun grazes has a
// depth that changes fast across the filter's footprint, which is where the
// acne lives on flat-shaded geometry (DEV-323's photographs), and a facet
// square to the sun keeps its contact shadows tight.
// Nine hardware-compared taps, a 3x3 at params.z texels: each is a bilinear
// 2x2 compare, so the kernel is a smooth tent a few texels wide and a texel's
// stair-step does not survive it. No per-pixel noise rotation (three's Vogel
// disk has one): a grain that stays put on a dashboard a metre from the eye is
// a texture, and this surface has none (ART_DIRECTION).
float ff2CockpitNearShadow( float ndl ) {
	if ( ndl <= 0.0 ) return 1.0;
	vec3 c = vFf2CockpitNear.xyz / vFf2CockpitNear.w;
	float slope = min( sqrt( max( 1.0 - ndl * ndl, 0.0 ) ) / ndl, 4.0 );
	c.z += uFf2CockpitNearParams.y * ( 1.0 + slope );
	if ( c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 || c.z > 1.0 ) return 1.0;
	float o = uFf2CockpitNearParams.z * uFf2CockpitNearParams.x;
	float s = 0.0;
	for ( int i = -1; i <= 1; i ++ ) {
		for ( int j = -1; j <= 1; j ++ ) {
			s += texture( uFf2CockpitNearMap, vec3( c.xy + vec2( float( i ), float( j ) ) * o, c.z ) );
		}
	}
	return s / 9.0;
}
#else
#define ${MAIN_SKIP} 0.0
#endif`

/** The vertex half: the near map's coordinate, beside three's own for the sun. */
export const nearShadowPatchVertex = (vertexShader: string): string => {
  if (!vertexShader.includes(VERTEX_ANCHOR)) {
    throw new Error(
      `cockpit-self-shadow: '${VERTEX_ANCHOR}' is not in this vertex shader. Re-read three's ` +
        'meshphysical vertex shader, or find the patch that took it.',
    )
  }
  // `worldPosition` and `shadowWorldNormal` are declared by three's own
  // `worldpos_vertex` / `shadowmap_vertex` under exactly this condition, so
  // the term exists where they do and nowhere else.
  return `${NEAR_VERTEX_PRELUDE}\n${vertexShader}`.replace(
    VERTEX_ANCHOR,
    () => `${VERTEX_ANCHOR}
#if ${NEAR_DEFINE} && defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	vFf2CockpitNear = uFf2CockpitNearMatrix * ( worldPosition + vec4( shadowWorldNormal * uFf2CockpitNearNormalBias, 0.0 ) );
#endif`,
  )
}

/**
 * The fragment half. Handles both shapes the anchor arrives in: the directional
 * shadow statement already in the text (far-shadow expanded the include, which
 * is the shipped order), or the include still there (expanded here, and
 * whoever comes after sees the chunk). **Throws** when a lit shader has
 * neither, for `gateFragmentShader`'s reason: a patch that silently does
 * nothing is the failure this family of files keeps paying for.
 */
export const nearShadowPatchFragment = (fragmentShader: string): string => {
  let text = fragmentShader
  if (!text.includes(SHADOW_BIAS)) {
    if (!text.includes(LIGHTS_INCLUDE)) {
      if (text.includes(LIT_MARKER)) {
        throw new Error(
          `cockpit-self-shadow: this shader is lit but has neither '${SHADOW_BIAS}' nor ` +
            `'${LIGHTS_INCLUDE}'. Another patch rewrote the directional block into a shape ` +
            'this file does not know, and the cockpit would have no near shadow.',
        )
      }
      return fragmentShader
    }
    const chunk = THREE.ShaderChunk.lights_fragment_begin
    if (chunk.split(SHADOW_BIAS).length !== 2) {
      throw new Error(
        `cockpit-self-shadow: three's lights_fragment_begin no longer has exactly one ` +
          `'${SHADOW_BIAS}'. Re-read node_modules/three/src/renderers/shaders/ShaderChunk/.`,
      )
    }
    // A FUNCTION replacement: the chunk is three's source, and `String.replace`
    // reads `$&` and friends out of a replacement string.
    text = text.replace(LIGHTS_INCLUDE, () => chunk)
  }
  const at = text.indexOf(SHADOW_BIAS)
  if (at < 0 || text.indexOf(SHADOW_BIAS, at + 1) >= 0) {
    throw new Error(`cockpit-self-shadow: expected exactly one '${SHADOW_BIAS}' in the shader.`)
  }
  // The statement ends at the first ';' after the token: its arguments are a
  // comma list, and far-shadow's `min( … , ff2SunHeightTerm() )` wrapper keeps
  // the one terminator.
  const end = text.indexOf(';', at)
  if (end < 0) throw new Error('cockpit-self-shadow: the shadow statement has no terminator.')
  const statement = text
    .slice(at, end + 1)
    .replace(SHADOW_BIAS, `( ${SHADOW_BIAS} - ${MAIN_SKIP} )`)
  const term = `
		#if ${NEAR_DEFINE}
		directLight.color *= mix( 1.0, ff2CockpitNearShadow( dot( geometryNormal, directLight.direction ) ), directionalLightShadow.shadowIntensity );
		#endif`
  text = text.slice(0, at) + statement + term + text.slice(end + 1)
  return `${NEAR_FRAGMENT_PRELUDE}\n${text}`
}

/** The uniforms every patched program shares. One object, so one write reaches all. */
export interface NearShadowUniforms {
  readonly uFf2CockpitNearMatrix: { value: THREE.Matrix4 }
  readonly uFf2CockpitNearNormalBias: { value: number }
  readonly uFf2CockpitNearMap: { value: THREE.Texture | null }
  readonly uFf2CockpitNearParams: { value: THREE.Vector4 }
}

export const createNearShadowUniforms = (): NearShadowUniforms => ({
  uFf2CockpitNearMatrix: { value: new THREE.Matrix4() },
  uFf2CockpitNearNormalBias: { value: 0 },
  uFf2CockpitNearMap: { value: null },
  uFf2CockpitNearParams: { value: new THREE.Vector4() },
})

const installed = new WeakMap<THREE.Material, NearShadowUniforms>()

/** Whether `material` carries the patch. */
export const hasNearShadow = (material: THREE.Material): boolean => installed.has(material)

/**
 * Patch one material. Idempotent. The define goes in at 0, and only its VALUE
 * ever moves afterwards (`setNearDefine`).
 *
 * **Install after `far-shadow.ts`'s `applyTo`**: an `onBeforeCompile` chain
 * runs in install order and far-shadow needs the include this can expand.
 * This copes with either order; far-shadow does not.
 */
export const installNearShadow = (material: THREE.Material, uniforms: NearShadowUniforms): void => {
  if (installed.has(material)) return
  installed.set(material, uniforms)
  // IN PLACE, not a copied object: `fragment-gates.ts` keys state on the
  // defines OBJECT (DEV-238), and a replaced object is a reference somebody
  // else is still holding. Appended once, so the key's order is fixed from
  // here on.
  if (!material.defines) material.defines = {}
  ;(material.defines as Record<string, unknown>)[NEAR_DEFINE] = 0
  // The guard is the map above (it also records the uniforms), so no once-set.
  chainShaderPatch(material, {
    tag: COCKPIT_SELF_SHADOW_TAG,
    uniforms,
    vertex: nearShadowPatchVertex,
    fragment: nearShadowPatchFragment,
  })
}

/**
 * Move the define's VALUE. Returns whether it moved — a recompile of this
 * material's program, and of nothing else.
 */
export const setNearDefine = (material: THREE.Material, on: boolean): boolean => {
  const defines = material.defines as Record<string, unknown> | undefined
  if (!defines || !Object.hasOwn(defines, NEAR_DEFINE)) return false
  const want = on ? 1 : 0
  if (defines[NEAR_DEFINE] === want) return false
  defines[NEAR_DEFINE] = want
  material.needsUpdate = true
  return true
}

// ── the live system ──────────────────────────────────────────────────────

/**
 * The parts of the renderer the pass borrows and hands back: `offscreen-pass.ts`'s
 * shape, under the name the near-shadow tests know it by.
 */
export type NearShadowRenderer = OffscreenRenderer

/** What a spec can ask of the pass. Counts OF A FRAME, so they survive contention. */
export interface CockpitSelfShadowReport {
  /** The preset, the tier, a sun and a shell all say yes. */
  readonly on: boolean
  /** Materials carrying the patch. */
  readonly patched: number
  /** Proxy draws in the pass: the shell's meshes. */
  readonly casters: number
  /** What the LAST pass drew, off `renderer.info`: draw calls and triangles. */
  readonly calls: number
  readonly triangles: number
  /** Passes rendered since the flag last went on. */
  readonly passes: number
  /** The box: radius and texel, metres. 0 before the first pass. */
  readonly radius: number
  readonly texelSize: number
  /** The sun's map skip on the shell, metres (`2 x radius`) and normalised. */
  readonly skipMetres: number
  readonly skipNormalised: number
  /** The map edge the target was built at, texels. 0 until built. */
  readonly mapSize: number
}

export interface CockpitSelfShadow {
  /**
   * Hand over the flight's root (or null). Finds the shell by name and
   * patches its materials if the preset asks for it — AFTER far-shadow has
   * patched them, see `installNearShadow`.
   */
  attach(flight: THREE.Object3D | null): void
  /** Render the near map for this frame. Once a frame, before the main draw. */
  update(): void
  readonly report: CockpitSelfShadowReport
  dispose(): void
}

/**
 * A geometry's bounding sphere from its VERTICES, in its own frame.
 *
 * Not `geometry.boundingSphere`, and the first photograph is why: GLTFLoader
 * fills that in from the accessor's min/max as the BOX's circumsphere, so on
 * the shell it read r = 4.62 m against 3.38 m for the vertices themselves —
 * 37 % more box, a coarser texel and a longer skip, for nothing. Computed here
 * rather than by `computeBoundingSphere()` so the shared geometry the real
 * cockpit is culled with is not rewritten by a shadow pass. Same method as
 * three's (the box centre, then the furthest vertex), so it is exact enough to
 * contain every vertex, which is all the fit needs.
 */
export const casterSphereOf = (geometry: THREE.BufferGeometry): THREE.Sphere | null => {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined
  if (!position || position.count === 0) return null
  const box = new THREE.Box3().setFromBufferAttribute(position)
  const centre = box.getCenter(new THREE.Vector3())
  const v = new THREE.Vector3()
  let r2 = 0
  for (let i = 0; i < position.count; i++) {
    r2 = Math.max(r2, centre.distanceToSquared(v.fromBufferAttribute(position, i)))
  }
  return new THREE.Sphere(centre, Math.sqrt(r2))
}

/** Scratch, valid only inside one synchronous call (trap 19). */
const _sphere = new THREE.Sphere()
const _union = new THREE.Sphere()
const _sunPos = new THREE.Vector3()
const _sunTarget = new THREE.Vector3()

/** Is `object` drawn in a scene right now? Visible all the way up to a `Scene`. */
export const drawnInAScene = (object: THREE.Object3D): boolean => {
  let node: THREE.Object3D | null = object
  while (node) {
    if (!node.visible) return false
    if ((node as THREE.Scene).isScene === true) return true
    node = node.parent
  }
  return false
}

export const createCockpitSelfShadow = (
  renderer: NearShadowRenderer,
  sun: THREE.DirectionalLight | null,
  editionState: EditionState,
  /** The SUN's live fit — `SunShadows.fit` — whose depth range the skip is normalised to. */
  mainFit: () => Pick<ShadowFit, 'near' | 'far'> | null,
): CockpitSelfShadow => {
  const uniforms = createNearShadowUniforms()
  let root: THREE.Object3D | null = null
  let casters: THREE.Mesh[] = []
  let materials: THREE.Material[] = []
  // ── built on the first ask and never on Classic ─────────────────────────
  let target: THREE.WebGLRenderTarget | null = null
  let scene: THREE.Scene | null = null
  let proxies: THREE.Mesh[] = []
  /** Never in a scene and lights nothing: three's shadow matrices, borrowed. */
  let light: THREE.DirectionalLight | null = null
  let on = false
  let calls = 0
  let triangles = 0
  let passes = 0
  let radius = 0
  let texelSize = 0
  let skipMetres = 0
  let skipNormalised = 0
  let sizedFor = 0

  const spec = (): EditionCockpitSelfShadow => editionState.current.render.cockpitSelfShadow

  const buildTarget = (size: number): void => {
    if (target && sizedFor === size) return
    target?.depthTexture?.dispose()
    target?.dispose()
    const t = createPcfDepthTarget(size, 'cockpitSelfShadow.map')
    target = t
    sizedFor = size
    uniforms.uFf2CockpitNearMap.value = t.depthTexture
    // Allocated NOW, cleared to the far plane, so the first program that
    // samples it — the warm-up draw under the curtain, before any pass has
    // run — reads "lit" from a real depth texture rather than an unbound
    // unit (a console warning a frame, and a sampler-type mismatch ANGLE is
    // entitled to refuse).
    withOffscreenTarget(renderer, t, () => {})
  }

  const buildProxies = (): void => {
    if (!scene) {
      scene = new THREE.Scene()
      scene.name = 'cockpit-self-shadow'
      // The proxies' world matrices are COPIED in, so nothing may recompute
      // them from a local transform they do not have.
      scene.matrixWorldAutoUpdate = false
      // One material for every proxy: depth only. DoubleSide because the
      // shell's own material is (the GLB says `doubleSided: true`), which is
      // also what three's shadow pass would pick for it (`shadowSide`).
      scene.overrideMaterial = new THREE.MeshBasicMaterial({
        colorWrite: false,
        side: THREE.DoubleSide,
      })
    }
    const s = scene
    for (const p of proxies) s.remove(p)
    // Proxies SHARE the shell's geometry — one upload, two draws — so the pass
    // renders a one-mesh scene rather than walking the world's graph (and
    // drawing its background box, DEV-320) to find one mesh.
    proxies = casters.map((mesh) => {
      const proxy = new THREE.Mesh(mesh.geometry)
      proxy.name = `${mesh.name}-near-shadow`
      proxy.matrixAutoUpdate = false
      proxy.matrixWorldAutoUpdate = false
      proxy.frustumCulled = false
      s.add(proxy)
      return proxy
    })
  }

  const apply = (): void => {
    const wanted =
      sun !== null &&
      casters.length > 0 &&
      cockpitSelfShadowEnabled(editionState.current, editionState.settings)
    on = wanted
    if (wanted) {
      buildTarget(spec().mapSize)
      const stale =
        proxies.length !== casters.length ||
        proxies.some((p, i) => p.geometry !== casters[i]?.geometry)
      if (stale) buildProxies()
      light ??= new THREE.DirectionalLight()
      for (const m of materials) installNearShadow(m, uniforms)
    } else {
      passes = 0
    }
    // Only materials that already carry the patch: an OFF preset installs
    // nothing, so Classic's shell compiles the program it always has.
    for (const m of materials) if (hasNearShadow(m)) setNearDefine(m, wanted)
  }

  const unsubscribe = editionState.subscribe(apply)

  /** Each caster's vertex sphere, in its own frame, measured once at attach. */
  let localSpheres: (THREE.Sphere | null)[] = []

  const casterSphere = (): THREE.Sphere | null => {
    let have = false
    for (let i = 0; i < casters.length; i++) {
      const local = localSpheres[i]
      const mesh = casters[i]
      if (!local || !mesh) continue
      _sphere.copy(local).applyMatrix4(mesh.matrixWorld)
      if (have) _union.union(_sphere)
      else _union.copy(_sphere)
      have = true
    }
    return have ? _union : null
  }

  const self: CockpitSelfShadow = {
    attach(flight) {
      root = flight?.getObjectByName(COCKPIT_ROOT_NAME) ?? null
      // Where a spec already looks — on the shell it shadows — rather than a
      // new member of `__ff2`, which every agent's `boot/app.ts` edit touches.
      // A function, so a serialised scene drops it rather than freezing it.
      if (root) root.userData[REPORT_KEY] = () => self.report
      casters = nearShadowCastersOf(flight)
      localSpheres = casters.map((mesh) => casterSphereOf(mesh.geometry))
      materials = uniqueMaterialsOf(casters)
      apply()
    },

    update() {
      if (!on || !sun || !target || !scene || !root || !light) return
      // The frame will not draw the shell (third person, the hangar, a torn-
      // down world): neither does this.
      if (!drawnInAScene(root)) return
      // The frame loop has placed the ship by now, but three recomputes world
      // matrices inside `render()` — which is AFTER this. Caster and receiver
      // must be the same frame's pose, or the bars' shadows slide on the dash
      // by a frame of rotation every time the ship turns.
      for (const mesh of casters) mesh.updateWorldMatrix(true, false)
      const sphere = casterSphere()
      if (!sphere) return
      // The sun's direction off the LIGHT, not re-derived: the frame loop
      // rewrites it between the title and the mission (`shadows.ts`'s reason).
      sun.updateWorldMatrix(true, false)
      sun.target.updateWorldMatrix(true, false)
      sun.getWorldPosition(_sunPos)
      sun.target.getWorldPosition(_sunTarget)
      const s = spec()
      const fit = fitNearShadow({
        centre: [sphere.center.x, sphere.center.y, sphere.center.z],
        radius: sphere.radius,
        lightDirection: [
          _sunTarget.x - _sunPos.x,
          _sunTarget.y - _sunPos.y,
          _sunTarget.z - _sunPos.z,
        ],
        mapSize: s.mapSize,
      })
      applyNearFit(light, fit)
      radius = fit.halfSize
      texelSize = fit.texelSize
      skipMetres = fit.far - fit.near
      skipNormalised = mainMapSkip(skipMetres, mainFit())
      uniforms.uFf2CockpitNearMatrix.value.copy(light.shadow.matrix)
      // The bias in METRES on the preset, normalised here against this box's
      // depth — `shadowBiasFor`'s convention and its reason.
      uniforms.uFf2CockpitNearParams.value.set(
        1 / s.mapSize,
        -Math.abs(s.bias) / (fit.far - fit.near),
        s.radius,
        skipNormalised,
      )
      uniforms.uFf2CockpitNearNormalBias.value = s.normalBias
      for (let i = 0; i < proxies.length; i++) {
        const proxy = proxies[i] as THREE.Mesh
        proxy.matrixWorld.copy((casters[i] as THREE.Mesh).matrixWorld)
      }
      const drawScene = scene
      const camera = light.shadow.camera
      withOffscreenTarget(renderer, target, () => {
        const drew = measuredRender(renderer, drawScene, camera)
        calls = drew.calls
        triangles = drew.triangles
        passes++
      })
    },

    get report(): CockpitSelfShadowReport {
      return {
        on,
        patched: materials.filter(hasNearShadow).length,
        casters: proxies.length,
        calls,
        triangles,
        passes,
        radius,
        texelSize,
        skipMetres,
        skipNormalised,
        mapSize: sizedFor,
      }
    },

    dispose() {
      unsubscribe()
      target?.depthTexture?.dispose()
      target?.dispose()
      target = null
      ;(scene?.overrideMaterial as THREE.Material | null | undefined)?.dispose()
      scene = null
      proxies = []
    },
  }
  return self
}
