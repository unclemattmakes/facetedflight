// src/render/terrain-mesh.ts — generator output to three.js geometry.
//
// The sim layer produces plain `Float32Array`s and knows nothing about three
// (rule 4). This is the only place that turns them into a `BufferGeometry`, and
// it does almost nothing: the arrays are already in the layout three wants —
// non-indexed, three vertices per triangle, positions/normals/colors/uvs
// interleaved by attribute. That is not luck; it is what the 2016 generator
// produced too, because the faceted look REQUIRES fully split vertices.
//
// ── Matching the 2016 material ────────────────────────────────────────────
//
// The shipped terrain draws with a vertex-colour variant of a LIT shader —
// `Marmoset/Shader/VertexColor/Marmoset Specular IBL.shader` — and a material
// tint that multiplies into every facet. Both come from the generated sheet
// (`TERRAIN.<env>.<terrain>.material`); neither is typed here, because a colour
// typed into `src/render/` is a hand-typed constant and rule 3 forbids it.
//
// The Marmoset shader is third-party and cannot ship, so FF2 writes its own.
// `MeshLambertMaterial` is the honest first approximation: diffuse, no specular,
// no image-based lighting. It gets the *structure* right — flat faces, one
// colour per face, a tinted albedo, a light direction — and leaves the specular
// and IBL terms for a hand-written shader matched against a 2016 screenshot.
// That gap is DEV-008, not a TODO.
//
// ── Vertex colour and colour space ────────────────────────────────────────
//
// The colours are passed through UNCONVERTED, which is not the physically
// correct thing to do and IS what 2016 did.
//
// `FacetedTerrain.cs:832` samples an sRGB texture with `GetPixelBilinear`, which
// returns the RAW stored bytes — Unity linearises in the GPU sampler, not on the
// CPU — and writes them straight into `mesh.colors`. Unity does not gamma-correct
// a vertex colour stream on upload either, so the Marmoset shader's
// `baseColor *= IN.color` multiplied an sRGB number into a linear albedo. The
// whole island is a stop brighter and flatter than a correct decode, and that is
// the look.
//
// This is not a guess. The 2016 bake stores its vertex colours, and comparing
// them against both candidates settles it: the two open-sea chunks match the raw
// values EXACTLY (0.000000) and the linearised ones by 0.105, while across ten
// chunks the raw mean error is 0.0121 against 0.2124 — 17.5x worse — with the
// residue explained by the vertex jitter's RNG. See
// `tests/unit/terrain-vertex-colour.test.ts`. (DEV-014.)

import * as THREE from 'three'
import { IBL_CALLS } from '@/render/fragment-gates'
import { chainShaderPatch } from '@/render/program-cache-key'
import { type ChunkThreeArrays, finishChunk } from '@/sim/terrain/chunk-to-three'
import type { TerrainChunkMesh } from '@/sim/terrain/faceted'
import { srgbToLinear } from './unity-space'

// `srgbToLinear` is for the material TINT only, never the vertex colours. See the
// note where it is used: those are different Unity paths and conflating them is
// how the terrain ends up a stop out in one direction or the other.

/** What `TERRAIN.<env>.<terrain>.material` looks like once it reaches here. */
export interface TerrainMaterialSpec {
  /** sRGB 0..1 rgb, as serialised. Multiplies every facet colour. */
  readonly tint: readonly [number, number, number] | null
  readonly shader: string | null
  /**
   * Treat `tint` as sRGB and convert it. Default true; `?tint=raw` turns it off
   * so the two can be put side by side.
   */
  readonly tintIsSrgb?: boolean
  /** The Marmoset shader's own numbers, off Matt's material file. */
  readonly specular?: {
    /** `_SpecInt`. 0.05 on Simonet: the terrain is very nearly matte. */
    readonly intensity: number | null
    /** `_Shininess`, on what appears to be a 0..10 gloss scale. */
    readonly shininess: number | null
    /** `_IBLBrightness`. Scales the environment contribution. */
    readonly iblBrightness: number | null
    /** `_SpecColor`, sRGB 0..1 as serialised. Tints the reflectance. */
    readonly color?: readonly number[] | null
    /** `_Fresnel`, 0..1. Steepens the falloff toward normal incidence. */
    readonly fresnel?: number | null
  } | null
  /**
   * `?terrainLit=` — which shading model. Default `standard`, i.e. today's.
   *
   * A MEASUREMENT switch (DEV-182); see `TerrainLit` for what each rung drops
   * and why the default is not up for grabs here.
   */
  readonly lit?: TerrainLit
}

/**
 * The reflectance a `Marmoset Specular IBL` surface has at NORMAL INCIDENCE —
 * the quantity three calls F0 — from the three material numbers that set it.
 *
 * ## Where it comes from
 *
 * `Marmoset Specular IBL.shader` defines neither `MARMO_SPECULAR_FILTER` nor
 * `MARMO_SPECULAR_REFRACTION`, so `MarmosetSurf.cginc:413-416` is the live
 * branch and it is three lines:
 *
 *     spec.rgb  = tex2D(_SpecTex, uv).rgb;   // unassigned -> "white" -> 1
 *     spec.rgb *= fresnel;                   // = schlickFresnel(...).y
 *     spec.rgb *= _SpecColor.rgb;
 *
 * and that one `spec.rgb` is then the reflectance of BOTH specular paths — the
 * image-based one at `:503` (`OUT.Emission += specIBL * spec.rgb * ...`) and
 * the direct one at `:421` (`OUT.SpecularRGB = spec.rgb`). So it is an F0, in
 * the sense three means, rather than a term added to one of them.
 *
 * `fresnel` is `schlickFresnel`'s `.y` (`MarmosetCore.cginc:285-302`), and in a
 * LINEAR project (`m_ActiveColorSpace: 1`, so `IS_LINEAR` is 1 and the `sqrt`
 * branch is dead) that is
 *
 *     _SpecInt * saturate(1.25 - NdotV * _Fresnel)^5
 *
 * — note the argument is `localE`, the view direction, so the dot product is
 * N.V and not N.H whatever the parameter is called.
 *
 * ## Two things that fall out of it, and both are worth stating
 *
 * **`_SpecInt` is the GRAZING reflectance, not the base one.** At N.V = 0 the
 * bracket saturates to 1 and the whole term is `_SpecInt * _SpecColor`; at
 * N.V = 1 it is `(1.25 - _Fresnel)^5` of that. So Marmoset's curve runs from
 * this function's answer UP TO `_SpecInt`, where three's Schlick runs from F0
 * up to white. Matching F0 is matching the common case; the grazing end stays
 * three's and that is the part of this port that is still an approximation.
 *
 * **`_SpecColor` is sRGB.** It is declared `Color` in the shader's Properties
 * block, exactly like `_Color`, so a Linear project converts it on upload —
 * the same argument, and the same conversion, as the material tint above.
 */
export const marmosetSpecularF0 = (
  specInt: number,
  fresnel: number,
  specColorSrgb: readonly number[],
): [number, number, number] => {
  const faceOn = Math.max(0, Math.min(1, 1.25 - fresnel)) ** 5
  const k = specInt * faceOn
  return [
    k * srgbToLinear(Math.max(0, specColorSrgb[0] ?? 1)),
    k * srgbToLinear(Math.max(0, specColorSrgb[1] ?? 1)),
    k * srgbToLinear(Math.max(0, specColorSrgb[2] ?? 1)),
  ]
}

/**
 * `interiorJitter` and `subdivideTriangleSoup` **moved to
 * `@/sim/terrain/chunk-to-three.ts`** (DEV-242) and are re-exported here.
 *
 * Both are pure arithmetic over typed arrays with no three in them, and the
 * terrain WORKER now needs them: it finishes the geometry itself rather than
 * handing the main thread four raw arrays and 19.5 MB of work to do with them.
 * A worker cannot import this file without dragging the whole renderer into its
 * bundle, so the pure half lives where a test keeps it pure.
 *
 * Re-exported rather than relocated-and-updated at the call sites, because
 * those call sites include six test files whose whole job is to hold this
 * arithmetic still. Moving a function and rewriting its tests in one commit is
 * how you find out later that you moved it wrong.
 */
export { interiorJitter, subdivideTriangleSoup } from '@/sim/terrain/chunk-to-three'

/**
 * Wrap finished chunk arrays in a `BufferGeometry`. **No copy, no loop.**
 *
 * The arrays are already in three space and already carry their sphere - see
 * `finishChunk`. This is the whole of what the main thread does per STREAMED
 * chunk now, and it is O(1) in the chunk's size: four `BufferAttribute`
 * constructors over buffers the worker transferred, and a `Sphere` built from
 * four numbers.
 *
 * `boundingSphere` is ASSIGNED rather than computed. `computeBoundingSphere`
 * walks the positions twice, which is 887,808 reads on an ocean chunk at LOD 0,
 * and the worker has already done it - to the bit, which
 * `tests/unit/chunk-drain.test.ts` holds against three's own method rather
 * than against this file's belief about it.
 */
export const chunkGeometryFromArrays = (arrays: ChunkThreeArrays): THREE.BufferGeometry => {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(arrays.positions, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(arrays.normals, 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(arrays.colors, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(arrays.uvs, 2))
  const s = arrays.sphere
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(s.x, s.y, s.z), s.radius)
  return geometry
}

/**
 * Build the geometry for one chunk, from a RAW generator chunk.
 *
 * The synchronous path: the 256-chunk initial build under the loading curtain,
 * and every test written against this signature. It is `finishChunk` followed
 * by `chunkGeometryFromArrays`, so a chunk that is LOADED and a chunk that is
 * STREAMED go through exactly the same arithmetic and cannot drift into two
 * different islands.
 *
 * The z flip, the winding reversal, the subdivision and the bounding sphere all
 * moved into `finishChunk` (DEV-242) and their reasoning moved with them, in
 * full. `colors` are still copied verbatim - see the colour-space note at the
 * top of this file; converting them would be correct and wrong.
 */
export const chunkGeometry = (
  raw: TerrainChunkMesh,
  /** Split each triangle into this^2. See `subdivideTriangleSoup`. */
  subdivide = 1,
  /** `RandomOffset` in mesh units, so the new vertices are not coplanar. */
  jitter = 0,
): THREE.BufferGeometry => chunkGeometryFromArrays(finishChunk(raw, subdivide, jitter))

/**
 * The terrain material.
 *
 * `MeshStandardMaterial`, not Lambert, because the 2016 shader is an IMAGE-BASED
 * LIGHTING shader and Lambert has nowhere to put an environment. With
 * `scene.environment` set (see `render/sky.ts`) this gets both halves of what
 * Marmoset was doing: diffuse irradiance from the sky, and a roughness-indexed
 * specular reflection of it.
 *
 * Two things fall out of the extracted numbers rather than being chosen:
 *
 *  * **`metalness: 0`.** Terrain is a dielectric, and a dielectric in this
 *    workflow reflects 4% at normal incidence. The 2016 material sets
 *    `_SpecInt: 0.05`. Those agree to within a rounding error, so the specular
 *    LEVEL is right without a fudge factor — which is a good sign that the
 *    material was authored physically in the first place.
 *  * **`envMapIntensity` from `_IBLBrightness`**, which is the same quantity
 *    under a different name.
 *
 * `roughness` is the one real approximation: Marmoset's `_Shininess` is 5.01 on
 * a scale the shader does not document, read here as 0..10 gloss. With a 5%
 * specular the visible difference across most of that range is small, but it is
 * a guess and it is in DEV-008.
 *
 * `flatShading` stays OFF: the generator already writes per-face normals and
 * splits every vertex, so faces are flat without it. Turning it on would make
 * three recompute normals it was handed — slower, and a chance to disagree with
 * the collision heightfield.
 */
/**
 * `_Shininess` -> roughness, and WHICH SHADER IT CAME FROM decides the answer.
 *
 * This was one mapping applied to two materials, and it made the ocean chalk.
 * Simonet's land and its water are authored against different third-party
 * shaders whose identically-named property is on completely different scales:
 *
 *   land   `Marmoset Specular IBL`      `_Shininess ("Specular Sharpness", Range(2.0, 8.0))`
 *   water  VacuumShaders legacy         `_Shininess ("Shininess", Range(0.01, 1))`
 *
 * Branching on `material.shader` rather than on the terrain's NAME: "is this the
 * ocean" is a guess, "which shader was this authored against" is a fact the
 * sheet already carries.
 *
 * ── Both branches now end in the SAME conversion ─────────────────────────
 *
 * Each shader is asked for the one quantity they both really have — the
 * Blinn-Phong power its specular lobe is raised to — and that single number
 * becomes a GGX roughness once, at the bottom. Two derivations, one bridge.
 * The previous Marmoset branch was `1 - shininess / 10`, which is not a
 * transcription of anything; it was a guess "of the right scale" and is what
 * the rest of DEV-008 was about.
 */
const blinnPowerToRoughness = (power: number): number =>
  Math.min(1, Math.max(0.04, Math.sqrt(2 / (power + 2))))

/**
 * Marmoset's `glossLOD`, transcribed (`MarmosetCore.cginc:231-235`):
 *
 *     glossMap = 1.0 - glossMap;
 *     glossMap = 1.0 - (glossMap * glossMap);
 *     return 7.0 + glossMap - (shininess * glossMap);
 *
 * It returns a cubemap MIP LEVEL, not a roughness — Marmoset prefilters the sky
 * into a chain and reads the blur straight out of it.
 *
 * `glossMap` is `_SpecTex`'s ALPHA. Every Faceted Flight material that uses one
 * of these shaders leaves `_SpecTex` unassigned (`m_Texture: {fileID: 0}` in
 * `Faceted Terrain_SimonetIslands.mat`, `Faceted Terrain Southwest.mat`,
 * `Faceted Terrain.mat`, `checkpoint_enabled.mat`, `checkpoint_Race.mat`,
 * `turnindicator_mat.mat`, `glowyMaterial.mat`), and the shader declares its
 * default as `_SpecTex ("Specular(RGB) Gloss(A)", 2D) = "white" {}` — Unity's
 * built-in white texture, RGBA (1,1,1,1). So gloss is 1 everywhere, and it is a
 * parameter here rather than a baked 1 because that is a property of the
 * MATERIALS, not of the function.
 */
export const marmosetGlossLod = (shininess: number, glossMap = 1): number => {
  const g = 1 - (1 - glossMap) * (1 - glossMap)
  return 7 + g - shininess * g
}

/**
 * The Blinn-Phong power a `Marmoset Specular IBL` surface is actually shaded
 * with. Three lines of the 2016 shader, composed:
 *
 *   `MarmosetSurf.cginc:422`    `OUT.Specular = glossExponent(glossLod);`
 *   `MarmosetCore.cginc:237`    `glossExponent(l) = exp2(8.0 - l)`
 *   `MarmosetSurf.cginc:425`    `OUT.Specular *= 0.00390625;  // 1/256`
 *   `MarmosetDirect.cginc:120`  `spec = 0.125 * pow(nh, s.Specular * 512.0);`
 *
 * so the power is `exp2(8 - glossLod) * 512 / 256`, i.e. **twice** the gloss
 * exponent. Marmoset says the same thing in its own words at
 * `MarmosetDirect.cginc:147`: *"x4.0 to map to Forward specular exponent
 * (Unity:128, Marmoset:512)"*.
 *
 * At gloss 1 the whole chain collapses to `2 * exp2(shininess)`, so the
 * shader's authored `Range(2.0, 8.0)` is a power of **8 to 512** — which is the
 * independent check that this reading is the right one: a slider labelled
 * "Specular Sharpness" runs from broad to mirror, in the direction it says, and
 * `glossLod` runs 6 -> 0 over the same range, which is mip 6 (blurry) to mip 0
 * (sharp). Both halves of the shader agree about which way is shinier.
 */
export const marmosetSpecularPower = (shininess: number, glossMap = 1): number =>
  2 * 2 ** (8 - marmosetGlossLod(shininess, glossMap))

/**
 * Was this material authored against the MARMOSET shader — i.e. is it land?
 *
 * The one place in the port that asks. It was asked in three separate
 * `.includes('VacuumShaders')` tests — the roughness branch below, the coloured
 * F0 in `terrainMaterial`, and (from DEV-092) whether the illustrative warp
 * applies — which is one fact written three times and therefore three chances to
 * drift. `sim/props`, `render/water.ts` and `load-terrain.ts`'s `shadowRole`
 * already make the same argument in words: "is this the ocean" asked any other
 * way is a guess, and "which shader was this authored against" is a fact the
 * generated sheet carries.
 *
 * A terrain with NO recorded shader counts as Marmoset, because every land
 * terrain in the sheet is one and the sea's entry is the one that names
 * VacuumShaders explicitly. That default is what `terrainMaterial`'s
 * `roughness` fallback of 5 already assumes.
 */
export const isMarmosetShader = (shader: string | null | undefined): boolean =>
  !shader?.includes('VacuumShaders')

export const shininessToRoughness = (shader: string | null, shininess: number): number => {
  if (!isMarmosetShader(shader)) {
    // `o.Specular = _Shininess` into Unity's legacy `BlinnPhong`, which raises
    // N.H to `Specular * 128`. The water's 0.201 is a power of 25.7.
    return blinnPowerToRoughness(Math.max(0.01, shininess) * 128)
  }
  return blinnPowerToRoughness(marmosetSpecularPower(shininess))
}

/**
 * three's dielectric F0 at the default `ior` of 1.5: `((n-1)/(n+1))^2`. The
 * number `specularIntensity` scales, and therefore the number to divide by when
 * you have a measured F0 and want the multiplier that produces it.
 */
export const THREE_DIELECTRIC_F0 = 0.04

// ─────────────────────────────────────────────────────────────────────────
// `?terrainLit=` — the terrain's SHADING MODEL, as a measurement (DEV-182)
// ─────────────────────────────────────────────────────────────────────────
//
// `perf-scale.spec.ts` puts the terrain chunks at **51 % of the worn frame and
// 2.15 ms of that in FILL** — the fragment shader over half the screen
// (`docs/plan/VR-PERF-WAVE-2-WORK.md` §3). The same session switched off all
// four Anniversary systems that ride on this material — the illustrative warp,
// the sun-height term, the haze and the detail ring — and every one of them
// measured inside the noise (§4b). So the 2.15 ms is the BASE stack, and the
// only way to price the base stack is to render the same frame without parts
// of it.
//
// This switch is that instrument. It is a LADDER, and each rung removes one
// named thing:
//
//   standard  today, byte for byte. `MeshPhysicalMaterial` where the sheet
//             carries a Marmoset F0, `MeshStandardMaterial` otherwise —
//             GGX + Smith + Fresnel, a PMREM irradiance lookup AND a PMREM
//             radiance lookup, the five-tap PCF, the fog, the warp, the gloss.
//   noibl     the same material and the same program parameters, with the two
//             IBL fetches spliced out of `lights_fragment_maps`. Isolates the
//             environment lookup and NOTHING else.
//   lambert   `MeshLambertMaterial`. Drops the specular BRDF, drops
//             `getIBLRadiance` (Lambert defines no `RE_IndirectSpecular`) and
//             KEEPS `getIBLIrradiance`, the shadow, the fog and the sun-height
//             term. The warp and the gloss fall away with it — they anchor on
//             `lights_physical_pars_fragment` and `roughnessmap_fragment`,
//             neither of which a Lambert program has, and both patches return
//             the source unchanged rather than failing.
//   basic     `MeshBasicMaterial`: vertex colours, the tint, the fog and
//             `lod-fade`'s `discard`. No lights, no shadow receive, no IBL —
//             `WebGLRenderer` hands `scene.environment` only to Standard,
//             Lambert and Phong. This is the FLOOR, not a candidate: it is what
//             the chunks would cost if shading were free.
//
// **The default is not up for grabs here.** `standard` is the look and the look
// is Matt's call (CLAUDE.md rule 9); this switch exists so the trade can be
// PHOTOGRAPHED and PRICED before anyone proposes it. Everything below `standard`
// is a deviation with no row in `docs/DEVIATIONS.md` authorising it.
//
// LAND ONLY, and by the same fact the F0 uses rather than by a second rule: a
// VacuumShaders surface is the ocean, `render/water.ts` patches its shader for
// the Blinn lobe, the coast and the waves, and none of those patches survive a
// material class that has no `roughnessmap_fragment` to anchor on. The ocean is
// its own census row with its own 1.32 ms and its own question.

/** The rungs of `?terrainLit=`, coarsest last. See the block above. */
export type TerrainLit = 'standard' | 'noibl' | 'lambert' | 'basic'

export const TERRAIN_LIT_IDS: readonly TerrainLit[] = ['standard', 'noibl', 'lambert', 'basic']

/**
 * `?terrainLit=standard|noibl|lambert|basic`. Null for absent, and null with a
 * warning for a typo — `parseQualityPin`'s rule, for its reason: a bad query
 * string must never be a black page.
 */
export const parseTerrainLit = (
  raw: string | null,
  warn: (message: string) => void = () => {},
): TerrainLit | null => {
  if (raw === null) return null
  if ((TERRAIN_LIT_IDS as readonly string[]).includes(raw)) return raw as TerrainLit
  warn(`?terrainLit=${raw} is not one of ${TERRAIN_LIT_IDS.join(', ')}; ignored`)
  return null
}

export const NO_IBL_INCLUDE = '#include <lights_fragment_maps>'

/**
 * The two calls `noibl` removes, as they appear in three 0.185.1's
 * `lights_fragment_maps`. Both must be present or the patch is a no-op wearing
 * a feature's clothes.
 *
 * **One list, shared with `render/fragment-gates.ts`'s `FF2_NO_IBL`.** That
 * gate is this rung made flippable on a live material, which is what let the
 * cut finally be PRICED (a material class is decided when the mesh is built, so
 * this rung's A/B is two loads, and perf-protocol §3a-ter says this machine
 * cannot do one for a fill-dominated cost). Two copies of the list would let
 * the priced cut and the photographed cut drift apart without a test noticing.
 */
const NO_IBL_CALLS = IBL_CALLS

/**
 * `lights_fragment_maps` with the IBL fetches taken out, and NOTHING else
 * changed.
 *
 * Deliberately surgical. `envMapIntensity: 0` does not do this — the value is a
 * uniform, the fetch still happens, and `WebGLRenderer` OVERWRITES that uniform
 * with `scene.environmentIntensity` on every material whose own `envMap` is
 * null (three.module.js:18688), so it is not even the number you set. And
 * `scene.environment = null` would take the IBL off the sky, the props, the
 * ocean and the ship at the same time, which prices four systems as one. What
 * is wanted is the terrain's own fetches gone and its program parameters
 * otherwise identical — so `USE_ENVMAP` stays defined, the uniforms stay
 * declared, and the compiler drops what nothing calls.
 *
 * **Throws** if either call has changed shape, for the reason
 * `illustrativeChunk` gives: a build that boots, renders and has silently lost
 * the thing it was measuring is the worst outcome (DEV-069).
 */
export const noIblChunk = (): string => {
  const chunk = THREE.ShaderChunk.lights_fragment_maps
  for (const call of NO_IBL_CALLS) {
    if (!chunk.includes(call)) {
      throw new Error(
        `terrain-mesh: three's lights_fragment_maps no longer contains "${call}". Re-read ` +
          'node_modules/three/src/renderers/shaders/ShaderChunk/lights_fragment_maps.glsl.js ' +
          'and update NO_IBL_CALLS.',
      )
    }
  }
  return NO_IBL_CALLS.reduce((text, call) => text.replace(call, ''), chunk)
}

/** Splice into a fragment shader; unchanged when the include is absent. */
export const noIblPatchFragment = (fragmentShader: string): string =>
  fragmentShader.includes(NO_IBL_INCLUDE)
    ? fragmentShader.replace(NO_IBL_INCLUDE, noIblChunk())
    : fragmentShader

/**
 * Patch one material so its program makes no environment fetch.
 *
 * Tagged, because `onBeforeCompile` is not in three's program cache key and an
 * untagged patch shares a program with any identically-parameterised material
 * that does not carry it — which is the whole of `render/program-cache-key.ts`.
 */
export const applyNoIbl = (material: THREE.Material): void => {
  // No once-set: the only caller passes a freshly built material.
  chainShaderPatch(material, { tag: 'terrainLit-noibl', fragment: noIblPatchFragment })
}

export const terrainMaterial = (spec: TerrainMaterialSpec): THREE.Material => {
  const shininess = spec.specular?.shininess ?? 5
  // ── The coloured dielectric specular (DEV-008's last line) ───────────────
  //
  // `MeshStandardMaterial` has one specular level and it is white;
  // `MeshPhysicalMaterial` adds `specularColor`/`specularIntensity`, which is
  // exactly F0 = 0.04 * intensity * color. So the physical material is used
  // ONLY where there is a Marmoset F0 to carry — the ocean is authored against
  // VacuumShaders, gets its specular from `render/water.ts` as an additive
  // Blinn lobe, and would double-count.
  const marmoset = isMarmosetShader(spec.shader)
  const f0 =
    marmoset && spec.specular?.color && spec.specular.intensity != null
      ? marmosetSpecularF0(spec.specular.intensity, spec.specular.fresnel ?? 0, spec.specular.color)
      : null
  // ── ALL of it in the colour, and none of it in the intensity ────────────
  //
  // The two fields look interchangeable — `specularColor * specularIntensity`
  // is the only place either appears in F0 — and they are not, because
  // `specularIntensity` is ALSO the grazing reflectance:
  //
  //   lights_physical_fragment:
  //     material.specularF90   = mix( specularIntensityFactor, 1.0, metalness )
  //     material.specularColor = min( 0.04 * specularColorFactor, 1.0 )
  //                            * specularIntensityFactor
  //
  // At metalness 0 that makes F90 exactly `specularIntensity`. Putting the
  // magnitude there gives desert `0.103 / 0.04 = 2.57`, i.e. **257 % reflectance
  // at grazing incidence** — a bright non-physical rim on every skyline ridge,
  // and the environment with the strongest specular is the one it would have
  // been worst on. Splitting it the other way — intensity 1, the whole scale in
  // the colour — lands F0 on the measured value and leaves F90 at **1.0**,
  // which is precisely what `MeshStandardMaterial` was already doing, so the
  // grazing end of the curve does not move at all.
  //
  // It is still not 2016's grazing end: Marmoset's tops out at
  // `_SpecInt * _SpecColor` (0.29 on desert) rather than at white, because its
  // Fresnel term is `_SpecInt * saturate(1.25 - NdotV * _Fresnel)^5` and the
  // `_SpecInt` is outside the whole thing. three cannot express F0 and F90
  // independently without replacing the Fresnel in a shader patch. F0 is the
  // half that most of the frame sees, and it is the half that is now right.
  const f0Max = f0 ? Math.max(f0[0], f0[1], f0[2]) : 0
  const physical =
    f0 && f0Max > 0
      ? {
          specularIntensity: 1,
          specularColor: new THREE.Color(
            f0[0] / THREE_DIELECTRIC_F0,
            f0[1] / THREE_DIELECTRIC_F0,
            f0[2] / THREE_DIELECTRIC_F0,
          ),
        }
      : {}
  // Same PROGRAM either way — `WebGLPrograms`' `shaderIDs` maps both classes to
  // `physical`, and the fragment shader opens `#define STANDARD` / `#ifdef
  // PHYSICAL -> #define IOR, #define USE_SPECULAR`. So this swap costs two
  // uniforms and three multiplies, not a different shading model; clearcoat,
  // sheen, iridescence, anisotropy and transmission all stay compiled out
  // because they gate on their own values and every one of those defaults to 0.
  // Worth knowing before judging it on a Quest.
  const Ctor = f0 && f0Max > 0 ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial
  // ── `?terrainLit=`, the measurement ladder (DEV-182) ───────────────────
  //
  // LAND ONLY, by the same fact the F0 above used rather than by a second rule:
  // a VacuumShaders surface is the ocean, and `render/water.ts` anchors its
  // Blinn lobe on `roughnessmap_fragment`, which no coarser class has. So the
  // sea keeps the shipped stack whatever the URL says, and the switch prices
  // exactly the census row it names.
  const rung: TerrainLit = marmoset ? (spec.lit ?? 'standard') : 'standard'
  const tint = spec.tint
    ? new THREE.Color(
        spec.tintIsSrgb === false ? (spec.tint[0] as number) : srgbToLinear(spec.tint[0]),
        spec.tintIsSrgb === false ? (spec.tint[1] as number) : srgbToLinear(spec.tint[1]),
        spec.tintIsSrgb === false ? (spec.tint[2] as number) : srgbToLinear(spec.tint[2]),
      )
    : new THREE.Color(1, 1, 1)
  // The two coarse rungs take only the fields their class HAS. `roughness`,
  // `metalness` and the F0 pair mean nothing on either and three warns per
  // unknown key; the tint, the vertex colours and the side are the whole of
  // what survives the drop.
  if (rung === 'lambert' || rung === 'basic') {
    const Coarse = rung === 'lambert' ? THREE.MeshLambertMaterial : THREE.MeshBasicMaterial
    return new Coarse({ vertexColors: true, color: tint, side: THREE.FrontSide })
  }
  const material = new Ctor({
    ...physical,
    vertexColors: true,
    // sRGB -> LINEAR, and this is NOT the same call the vertex colours get.
    //
    // They are two different Unity paths and they behave differently:
    //
    //   vertex colour stream   NOT gamma-corrected on upload (DEV-014)
    //   material `Color` prop  IS converted, in a Linear project
    //
    // The trigger for the second is the shader's own Properties block —
    // `_Color ("Diffuse Color", Color)` in `Marmoset Specular IBL.shader`. A
    // property declared `Color` rather than `Vector` gets Unity's sRGB->linear
    // conversion at upload, and `m_ActiveColorSpace: 1` says the project is
    // Linear. `FacetedTerrain` reads it back with `GetColor` and pushes it
    // through a MaterialPropertyBlock, which passes the already-linear value
    // straight to the shader.
    //
    // On Simonet that is (0.868, 0.760, 0.721) -> (0.725, 0.539, 0.478): a
    // noticeably deeper, warmer tint. Same shape of bug the fog had.
    // This WAS an open question and it is now settled, in favour of converting.
    //
    // `ProjectSettings.asset` has `m_ActiveColorSpace: 1` — the 2016 project
    // rendered **Linear**, so Unity converts a property declared `Color` in the
    // shader's Properties block on upload.
    //
    // The doubt was `FacetedTerrain.cs`: it reads the tint back with `GetColor`
    // and pushes it through a `MaterialPropertyBlock`, which does NOT do that
    // conversion. But look at when. The block exists only for the LOD
    // cross-fade's alpha, and the fade ends with `SetPropertyBlock(null)` —
    // a settled chunk is drawn with the plain material and no block at all. The
    // round trip never touches the steady-state render.
    //
    // It is worth a lot: 0.868 -> 0.725 on red and 0.721 -> 0.478 on blue, a
    // markedly deeper tint that turns `islandgroup_color`'s khaki land
    // (141, 142, 112 — 64 % of it in the 40-60 degree hue band) into a warm
    // brown. That is 2016's, not ours. `tintIsSrgb: false` survives as a
    // diagnostic — `?tint=raw` shows how much of the look the tint is doing —
    // and is a deviation, not a candidate reading.
    color: tint,
    roughness: shininessToRoughness(spec.shader, shininess),
    metalness: 0,
    envMapIntensity: spec.specular?.iblBrightness ?? 1,
    side: THREE.FrontSide,
  })
  // `standard` and `noibl` build the same object; only the second is patched,
  // so the two differ by two texture fetches and by nothing else.
  if (rung === 'noibl') applyNoIbl(material)
  return material
}
