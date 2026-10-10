// src/render/illustrative.ts — the illustrative diffuse warp, as an option.
//
// "Illustrative Rendering in Team Fortress 2" (Mitchell, Francke, Eng — NPAR
// 2007). Replace the direct diffuse response `saturate(N·L)` with a ramp
// indexed by Half-Lambert `N·L * 0.5 + 0.5`: cool in shadow, neutral through
// the body, warm at the terminator, a touch overbright at the top. The cool/warm
// shift then lives INSIDE the shadow term rather than sitting over the whole
// frame as a tint.
//
// ── Why a faceted world is the case this suits ────────────────────────────
//
// On smooth geometry the warp reads as a soft band at the terminator. On FF2's
// terrain there is no band: every facet is one constant normal over tens of
// square metres, so the ramp is a per-FACE colour lookup. A face edge-on to the
// 4-degree sun lands at hl = 0.5 and takes the terminator colour whole; a face
// turned away lands near 0 and takes the cool one whole. That is the mechanism
// ANNIVERSARY.md §1.4 asks for — something that separates adjacent facets by
// more than brightness — applied to the one shading term the port controls.
//
// ── What it does NOT touch, and why each one matters ─────────────────────
//
//  * **The specular.** `RE_Direct_Physical` computes `irradiance` ONCE and feeds
//    it to both `reflectedLight.directSpecular` (through
//    `BRDF_GGX_Multiscatter`) and `reflectedLight.directDiffuse` (through
//    `BRDF_Lambert`). So the patch substitutes the DIFFUSE LINE, not
//    `irradiance` — see `ILLUSTRATIVE_ANCHOR`. The Marmoset-derived coloured
//    F0 that DEV-008 spent its last section on (`terrainMaterial`'s
//    `specularColor`) is the thing this feature must be able to stand beside,
//    not the thing it replaces.
//  * **The ambient and the IBL.** `RE_IndirectDiffuse_Physical` is untouched.
//    FF2's ambient is 2016's own nine spherical-harmonic coefficients, exactly
//    (DEV-013), and the blue you want in a shadow really comes from the sky.
//    This is a DIRECT-light response curve and nothing else.
//  * **The fog and the haze.** Both act on `outgoingLight`, which is downstream
//    of the whole lighting stack, so they compose with this in the order the
//    physics happens in and neither number moves.
//
// ── Shadowed for free, which is not an accident of ours ──────────────────
//
// `lights_fragment_begin` multiplies `directLight.color` by `getShadow(...)`
// BEFORE `RE_Direct` is called, so a response built from `directLight.color` is
// already shadow-attenuated. A facet inside DEV-086's shadow map therefore gets
// no warp fill at all — the light it would have been filled from is gone — and
// the ramp's cool end lifts only the faces that are turned away from a sun that
// can still see them. king-tide's `illustrative-lighting.ts` header makes the
// same point about the WebGPU side (`AnalyticLightNode.setupShadow` folds the
// shadow into the light's colour node); it is the same fact in the other
// backend, and it is the reason this is a LIGHTING patch rather than a tint.
//
// ── The identity at zero ─────────────────────────────────────────────────
//
// Classic and Anniversary compile the SAME source — every value the warp reads
// is a uniform, so `program-cache-key.ts`'s tag names one variant and there is
// no second program per material. What Classic has to be identical in is its
// OUTPUT, and `mix(x, y, 0.0)` is `x * 1.0 + y * 0.0`, which is `x` exactly for
// any finite `y`. The ramp is bounded, so `y` is always finite. Same argument
// and same guarantee as the haze's (DEV-082); `illustrative.test.ts` asserts it
// with `toBe` on exact floats.
//
// ── The maths is here in TypeScript and the GLSL mirrors it ──────────────
//
// `illustrativeResponse` / `illustrativeIrradiance` and `ILLUSTRATIVE_GLSL` are
// the same lines twice, on purpose, for the reason `render/haze.ts` says: a
// shader cannot be unit tested without a GL context, and a light response that
// is wrong in the middle of the ramp looks exactly like an art choice.

import * as THREE from 'three'
import type { EditionState } from '@/game/edition'
import { chainShaderPatch } from '@/render/program-cache-key'
import { clamp01, mix, smoothstep } from '@/sim/math/scalar'

/**
 * The line in `lights_physical_pars_fragment` this feature replaces — the ONE
 * place `RE_Direct_Physical` turns irradiance into diffuse.
 *
 * Tab-indented, because three's GLSL chunks are. Pinned by
 * `tests/unit/illustrative.test.ts`, which reads `THREE.ShaderChunk` and asserts
 * the string is present and occurs exactly once, so a three upgrade that moves
 * the line fails LOUDLY rather than silently un-warping the world. DEV-069's
 * lesson in the other direction: a patch nothing checks is not a guard.
 *
 * Note which line it is NOT. `vec3 irradiance = dotNL * directLight.color;` is
 * four lines above and looks like the obvious hook — and `irradiance` is also
 * what `reflectedLight.directSpecular += irradiance * BRDF_GGX_Multiscatter(...)`
 * is built from, so substituting there would warp the specular lobe as well.
 */
export const ILLUSTRATIVE_ANCHOR =
  '\treflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution );'

/** The include directive the patched chunk text is spliced in place of. */
export const ILLUSTRATIVE_INCLUDE = '#include <lights_physical_pars_fragment>'

/**
 * The tuning, resolved: three ramp stops in LINEAR rgb, a flat gain, and the
 * cross-fade against the stock Lambert response.
 *
 * Linear rather than sRGB, unlike the haze's tint and unlike a level's fog
 * colour, and the difference is real: those two are COLOURS someone picked in a
 * picker, and this is a light RESPONSE CURVE — the number the sun's radiance is
 * multiplied by. `content/editions/_schema.json`'s `linearRgb` def already says
 * the same thing about `fx.motes.colorLight` and the cabin lamps.
 */
export interface IllustrativeSettings {
  /** Response at Half-Lambert 0 — a face turned fully away from the light. */
  readonly shadow: readonly [number, number, number]
  /** Response at Half-Lambert 0.5, which is `N·L = 0` exactly: the terminator. */
  readonly terminator: readonly [number, number, number]
  /** Response at Half-Lambert 1 — a face square to the light. */
  readonly lit: readonly [number, number, number]
  /** Flat gain on the whole ramp: the TF2 paper's post-lookup `×N`. */
  readonly overbright: number
  /** 0..1 cross-fade from the stock `saturate(N·L)` response. 0 is the identity. */
  readonly strength: number
}

/**
 * No warp at all — what Classic runs, and what a material gets before a preset
 * has been applied.
 *
 * The stops are the ramp that would reproduce a plain Half-Lambert if anyone
 * flipped `strength` by hand: black at 0, mid grey at the terminator, white at
 * the top, gain 1. Belt and braces in the same spirit as `classic.json` — the
 * numbers are unobservable because `strength` is 0, and they are still sane if
 * it is not.
 */
export const ILLUSTRATIVE_OFF: IllustrativeSettings = Object.freeze({
  shadow: Object.freeze([0, 0, 0]) as readonly [number, number, number],
  terminator: Object.freeze([0.5, 0.5, 0.5]) as readonly [number, number, number],
  lit: Object.freeze([1, 1, 1]) as readonly [number, number, number],
  overbright: 1,
  strength: 0,
})

/**
 * Half-Lambert: `N·L * 0.5 + 0.5`, clamped.
 *
 * The whole point of the reparameterisation, and the reason the ramp has
 * anything to say about a shadowed face: `saturate(N·L)` throws away the entire
 * back hemisphere as one value, 0, while this maps it onto 0..0.5 and leaves the
 * lit hemisphere on 0.5..1. `hl = 0.5` is `N·L = 0` — the terminator — which is
 * why the middle stop's POSITION is not a tuning number.
 */
export const halfLambert = (nl: number): number => clamp01(nl * 0.5 + 0.5)

/**
 * The ramp: the multiplier the light's own colour is scaled by at this `N·L`.
 *
 * Two smoothstep segments, written branchlessly the way the GLSL is — below the
 * terminator `upper` is 0 and the second mix is the identity; above it `lower`
 * is 1 and the first has already settled on `terminator`. Exactly
 * `ILLUSTRATIVE_GLSL`'s `ff2IllustrativeWarp`, line for line.
 */
export const illustrativeResponse = (
  nl: number,
  s: IllustrativeSettings,
): [number, number, number] => {
  const hl = halfLambert(nl)
  const lower = smoothstep(0, 0.5, hl)
  const upper = smoothstep(0.5, 1, hl)
  const out: [number, number, number] = [0, 0, 0]
  for (let i = 0; i < 3; i++) {
    const c = mix(s.shadow[i] as number, s.terminator[i] as number, lower)
    out[i] = mix(c, s.lit[i] as number, upper) * s.overbright
  }
  return out
}

/**
 * The whole substituted expression: the irradiance the DIFFUSE term is built
 * from, stock response cross-faded to the warped one.
 *
 * `lightColor` is the light's colour ALREADY multiplied by its shadow factor,
 * which is what `lights_fragment_begin` hands `RE_Direct` — so this function's
 * caller in a test is passing the same quantity the shader sees, and the
 * shadowed case is `lightColor = 0` rather than a separate code path.
 *
 * At `strength` 0 this returns `saturate(nl) * lightColor` EXACTLY, which is the
 * stock line, which is why Classic's frame does not move.
 */
export const illustrativeIrradiance = (
  nl: number,
  lightColor: readonly [number, number, number],
  s: IllustrativeSettings,
): [number, number, number] => {
  const stockResponse = clamp01(nl)
  const warp = illustrativeResponse(nl, s)
  return [
    mix(stockResponse * (lightColor[0] as number), (warp[0] as number) * lightColor[0], s.strength),
    mix(stockResponse * (lightColor[1] as number), (warp[1] as number) * lightColor[1], s.strength),
    mix(stockResponse * (lightColor[2] as number), (warp[2] as number) * lightColor[2], s.strength),
  ]
}

/**
 * The shader half: the uniform block and the ramp, prepended to the chunk being
 * substituted so both are in scope by the time `RE_Direct_Physical` is compiled.
 *
 * ONE variant. Every value read here is a uniform, so Classic and Anniversary
 * share a program and `render/program-cache-key.ts`'s token names one source.
 */
export const ILLUSTRATIVE_GLSL = `
uniform vec2 uWarp;          // (strength, overbright)
uniform vec3 uWarpShadow;    // LINEAR response at Half-Lambert 0.0
uniform vec3 uWarpTerminator; // ...at 0.5, which is N.L = 0 exactly
uniform vec3 uWarpLit;       // ...at 1.0

// The illustrative diffuse warp (Mitchell/Francke/Eng, NPAR 2007), as a ramp
// over Half-Lambert rather than a texture: three stops and two smoothsteps read
// the same in a code review as a 256-pixel DataTexture does in a hex dump, and
// there is no filtering convention to get wrong. Mirrored by
// illustrativeResponse() in render/illustrative.ts, which is what the unit tests
// can actually reach.
//
// Branchless on purpose, and it IS the piecewise ramp: below the terminator
// uWarpLit's mix has weight 0, above it uWarpShadow's has weight 1.
vec3 ff2IllustrativeWarp(float nl) {
  float hl = clamp(nl * 0.5 + 0.5, 0.0, 1.0);
  float lower = smoothstep(0.0, 0.5, hl);
  float upper = smoothstep(0.5, 1.0, hl);
  vec3 c = mix(uWarpShadow, uWarpTerminator, lower);
  return mix(c, uWarpLit, upper) * uWarp.y;
}
`

/**
 * What replaces `ILLUSTRATIVE_ANCHOR`.
 *
 * The RAW dot product, not the `dotNL` the line above it computed: that one is
 * `saturate`d, and a saturated dot's Half-Lambert only ever spans 0.5..1, which
 * would throw away the whole reason for the reparameterisation. One extra dot
 * product per direct light per fragment, and there is exactly one direct light
 * in this game.
 */
export const ILLUSTRATIVE_REPLACEMENT = `\treflectedLight.directDiffuse += mix( irradiance, ff2IllustrativeWarp( dot( geometryNormal, directLight.direction ) ) * directLight.color, uWarp.x ) * BRDF_Lambert( material.diffuseContribution );`

/**
 * `THREE.ShaderChunk.lights_physical_pars_fragment` with the warp spliced in,
 * and the declarations in front of it.
 *
 * **Throws** if the anchor is not there. That is the three-upgrade guard and it
 * is deliberately fatal: the alternative is a build that boots, renders, passes
 * every test, and has silently lost the feature — which is precisely how
 * `hoverjet.input.controlScheme` said `"a"` for four sessions while the pad flew
 * something else (DEV-069).
 */
export const illustrativeChunk = (): string => {
  const chunk = THREE.ShaderChunk.lights_physical_pars_fragment
  if (!chunk.includes(ILLUSTRATIVE_ANCHOR)) {
    throw new Error(
      "illustrative: three's lights_physical_pars_fragment no longer contains the diffuse line " +
        'this patch substitutes. Re-read RE_Direct_Physical in ' +
        'node_modules/three/src/renderers/shaders/ShaderChunk/lights_physical_pars_fragment.glsl.js ' +
        'and update ILLUSTRATIVE_ANCHOR/ILLUSTRATIVE_REPLACEMENT together.',
    )
  }
  return `${ILLUSTRATIVE_GLSL}\n${chunk.replace(ILLUSTRATIVE_ANCHOR, ILLUSTRATIVE_REPLACEMENT)}`
}

/**
 * Splice the patched chunk into a fragment shader in place of its include.
 *
 * Returns the source unchanged when the include is absent, which is not a
 * silent failure looking for somewhere to happen: the only program a material
 * carrying this patch ever compiles is `physical`, because `WebGLShadowMap`
 * builds its depth passes from its own `MeshDepthMaterial` and copies neither
 * `onBeforeCompile` nor `customProgramCacheKey` across. The unit test pins the
 * substitution against a real stock source so "unchanged" cannot become the
 * normal case unnoticed.
 */
export const illustrativePatchFragment = (fragmentShader: string): string =>
  fragmentShader.includes(ILLUSTRATIVE_INCLUDE)
    ? fragmentShader.replace(ILLUSTRATIVE_INCLUDE, illustrativeChunk())
    : fragmentShader

/**
 * The same numbers as they are carried in the preset JSON. Identical to
 * `IllustrativeSettings` plus the feature flag — the stops are already linear,
 * so unlike the haze there is no colour-space step between the file and the
 * shader and therefore no second shape to convert through.
 */
export interface IllustrativeTuning extends IllustrativeSettings {
  readonly enabled: boolean
}

/**
 * The live warp: one uniform block, shared by every material it patches, so a
 * preset flip is four uniform writes and no recompile.
 */
export interface IllustrativeLighting {
  /** Exposed for tests and for the console, the way `UnityFog.uniforms` is. */
  readonly uniforms: {
    readonly uWarp: { value: THREE.Vector2 }
    readonly uWarpShadow: { value: THREE.Color }
    readonly uWarpTerminator: { value: THREE.Color }
    readonly uWarpLit: { value: THREE.Color }
  }
  /** Patch one material. Idempotent, chained, and tagged. */
  applyTo(material: THREE.Material): void
  /** `null` is off, which is the identity. */
  set(tuning: IllustrativeTuning | null): void
  /** How many materials carry the patch. For the console and the row. */
  readonly materialCount: number
}

/**
 * Build the warp.
 *
 * Not per-mission, unlike the fog: the ramp is a preset, the sun's own colour is
 * the only per-mission thing in the term and that arrives through
 * `directLight.color` rather than through anything here. So `boot/app.ts` makes
 * one of these at the Anniversary seam and hands `applyTo` to whatever loads a
 * lit material.
 */
export const createIllustrativeLighting = (): IllustrativeLighting => {
  const uniforms = {
    // Built at the IDENTITY whatever preset is live, for the reason
    // `missionFog` builds the haze zeroed: a term that defaults to on makes the
    // order of two unrelated boot steps visible in the picture. `set` is the
    // only thing that ever writes these.
    uWarp: { value: new THREE.Vector2(ILLUSTRATIVE_OFF.strength, ILLUSTRATIVE_OFF.overbright) },
    uWarpShadow: { value: new THREE.Color(...ILLUSTRATIVE_OFF.shadow) },
    uWarpTerminator: { value: new THREE.Color(...ILLUSTRATIVE_OFF.terminator) },
    uWarpLit: { value: new THREE.Color(...ILLUSTRATIVE_OFF.lit) },
  }
  const patched = new WeakSet<THREE.Material>()
  let materialCount = 0

  return {
    uniforms,

    applyTo(material: THREE.Material) {
      // ONCE per material, and CHAINED — the same two reasons `unity-fog.ts`
      // gives. Once, because every chunk of a terrain shares one material
      // instance and a caller may hand it over per chunk; chaining 256 copies of
      // one uniform block is 256 redefinitions and does not fail quietly, it
      // fails to compile. Chained, because the fog patches these same materials
      // and whichever assigned last would otherwise silently delete the other.
      //
      // The injected GLSL has no branch that is not a uniform, so there is
      // exactly one variant of this source and one constant token is the whole
      // tag. Without it a warped material shares a compiled program with any
      // other `MeshStandardMaterial` carrying the same parameters, INCLUDING an
      // unwarped one, and which wins is creation order — see
      // `render/program-cache-key.ts` for the session that cost.
      const installed = chainShaderPatch(
        material,
        { tag: 'illustrative-warp', uniforms, fragment: illustrativePatchFragment },
        patched,
      )
      if (installed) materialCount++
    },

    set(tuning) {
      // `null` and "enabled with strength 0" have to be the same picture, and
      // they are: both go through `ILLUSTRATIVE_OFF`'s strength of 0, which is
      // the identity. One path to test rather than two.
      const s: IllustrativeSettings = tuning ?? ILLUSTRATIVE_OFF
      uniforms.uWarp.value.set(s.strength, s.overbright)
      uniforms.uWarpShadow.value.setRGB(s.shadow[0], s.shadow[1], s.shadow[2])
      uniforms.uWarpTerminator.value.setRGB(s.terminator[0], s.terminator[1], s.terminator[2])
      uniforms.uWarpLit.value.setRGB(s.lit[0], s.lit[1], s.lit[2])
    },

    get materialCount() {
      return materialCount
    },
  }
}

/**
 * Anything that can be handed a warp. The interface exists so this file does not
 * have to import `boot/app.ts`'s wiring, and so a test can watch the pushes
 * without a renderer.
 */
export interface IllustrativeTarget {
  set(tuning: IllustrativeTuning | null): void
}

/**
 * Wire a warp to the live preset: set it now, and again on every flip.
 *
 * `null` when the feature is off, rather than the preset's own numbers with the
 * flag ignored — so Classic's ramp values are unobservable and cannot become
 * load-bearing by accident. The same contract, and the same reasoning, as
 * `attachEditionHaze`. Returns the unsubscribe.
 */
export const attachEditionIllustrative = (
  target: IllustrativeTarget,
  editionState: EditionState,
): (() => void) => {
  const push = (): void => {
    const w = editionState.current.render.illustrative
    target.set(w.enabled ? w : null)
  }
  push()
  return editionState.subscribe(push)
}
