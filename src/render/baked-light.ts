// src/render/baked-light.ts — DEV-232. The static world's diffuse lighting,
// computed once into the vertex colours, with the PBR chain gated out behind it.
//
// `docs/plan/DEV-232-BAKED-LIGHT.md` is the argument; this is the mechanism.
//
// ── THREE RUNGS, and the choice is Matt's (DEV-237, DEV-240) ─────────────
//
// DEV-232 built §4's ladder in prose and shipped only its bottom step. There
// are three steps here now, selected by `terrain.bakedLight.rung` in the
// preset:
//
//   'split'  the two halves of the diffuse are baked SEPARATELY — the light
//      probe's irradiance into the `color` attribute, the sun's `N·L` term
//      into `ff2Direct` — and the shader writes
//      `outgoingLight = diffuseColor.rgb + diffuse * vFf2Direct * ff2ShadowOnly()`.
//      That is three's own semantics for the diffuse, term for term: the
//      shadow multiplies the DIRECT light and nothing else, which is why a
//      shadowed hillside in this game is pale rather than black. Rung 1's
//      shadows at rung 3's fidelity, for 12 bytes a vertex and one varying.
//      DEV-240. UNMEASURED.
//
//   3  everything goes. `outgoingLight = diffuseColor.rgb`. The physical
//      chain, both PMREM fetches, the GGX lobe, the five-tap PCF and
//      `ff2SunHeightTerm` all sit behind a dead `totalDiffuse` and the
//      compiler removes them. MEASURED: -0.80 ms p50, -1.15 p95 on
//      `adv_02_jumpSeat`, bracket 0.01 ms. It costs the ground its shadows.
//
//   1  everything except the shadow multiply.
//      `outgoingLight = diffuseColor.rgb * ff2ShadowOnly()`, with `getShadow`
//      and `ff2SunHeightTerm` still running per fragment. The ship, the racers
//      and the landmarks go on casting onto the ground —
//      `render/shadows.ts`'s own header calls a shadow's length "a ruler laid
//      on the ground" and `ANNIVERSARY.md` §1.5 ranks it second of eight scale
//      cues. Buys less; UNMEASURED. **And it shadows the AMBIENT as well as
//      the sun, which the plan did not predict — see SHADOW_ONLY_GLSL.**
//      DEV-240's 'split' is that defect fixed; rung 1 is kept because it is
//      the rung the plan described and the frames that refuse it are about it.
//
// There is no rung 2. The plan's rung 2 is rung 1 with `ff2SunHeightTerm`
// baked as well, and `render/far-shadow.ts`'s header says why that is an
// argument rather than a knob: the field is signed "so the bilinear zero
// crossing — the shadow's edge on the ground — falls inside a texel rather
// than along the 8 m grid", and a per-vertex bake puts it back on the grid.
//
// ── Why a bake is EXACT here rather than an approximation ────────────────
//
// Three facts about this particular renderer, each checked rather than assumed:
//
//  1. **The terrain's shading inputs are already constant across a face.**
//     `sim/terrain/faceted.ts` writes ONE normal and ONE colour to all three
//     vertices of every triangle and the soup is non-indexed — `terrain-mesh.ts`
//     never calls `setIndex`. So a per-vertex store of any function of the
//     normal is not a resampling; it is a copy of a value that was already
//     uniform over the polygon. The detail ring does not break it either:
//     `subdivideTriangleSoup` interpolates the parent's normals and colours
//     barycentrically, and interpolating three identical values is the identity.
//  2. **The whole indirect diffuse is a `THREE.LightProbe`.**
//     `render/skyshop-ibl.ts`'s `useSkyshopLightingModel` appends
//     `iblIrradiance = vec3( 0.0 );` to three's `lights_fragment_maps`, because
//     Marmoset splits diffuse (spherical harmonics) from specular (cubemap) and
//     the ambient would otherwise land twice. So `scene.environment` contributes
//     SPECULAR ONLY, and the diffuse ambient is `shGetIrradianceAt(normal, sh)`
//     — a closed form in the normal alone.
//  3. **The point-light loop is already gone.** `render/point-light-scope.ts`
//     replaces its `#if` with `#if 0` on every material outside the ship
//     (DEV-192), so there is no cabin-lamp term left to lose.
//
// Put together: **every diffuse term on a terrain fragment is a function of the
// face normal**, and a per-vertex bake of the lot is lossless. What is NOT
// bakeable is the view-dependent half — `getIBLRadiance`, the GGX lobe, and
// `terrain-surface.ts`'s roughness classifier that feeds both — plus the two
// shadow terms, which vary WITHIN a face. Those are the deviation, and
// `docs/DEVIATIONS.md` carries the row.
//
// ── The anchor, and why it is one line above the obvious one ─────────────
//
// `render/fragment-gates.ts` already ships `FF2_UNLIT`, which rewrites the
// statement inside `opaque_fragment`:
//
//     gl_FragColor = vec4( outgoingLight, diffuseColor.a );   // base
//     gl_FragColor = vec4( diffuseColor.rgb, 1.0 );           // FF2_UNLIT
//
// **That gate is not this one, and reusing it would have measured the wrong
// thing.** `scene.fog` is null on purpose in this app (`boot/app.ts`: *"three's
// two fogs cannot express what the game runs"*), so `#include <fog_fragment>`
// compiles to nothing and the REAL fog is `render/unity-fog.ts` — which injects
// immediately ABOVE `#include <opaque_fragment>` and writes `outgoingLight`,
// twice: the aerial haze first, then Lengyel's half-space mix. A gate that
// ignores `outgoingLight` therefore deletes the fog and the haze along with the
// lighting, and its millisecond is a CEILING on this proposal rather than an
// estimate of it. (`FF2_UNLIT` is honest about being "the floor, not a
// candidate"; the trap is only in reading its number as this one's.)
//
// So this patch anchors one statement higher, on the material's own
//
//     vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;
//
// which is in the SHADER SOURCE rather than in a `ShaderChunk`, is patched by
// nothing else in this repo, and sits upstream of the fog. With the define set,
// `totalDiffuse` and `totalSpecular` have no consumer and the compiler
// dead-codes `lights_physical_fragment`, `lights_fragment_begin` (the
// directional loop, the five-tap PCF, `ff2SunHeightTerm`), `lights_fragment_maps`
// (both PMREM fetches) and `lights_fragment_end` behind them — while the fog,
// the haze, `lod-fade`'s `discard` and the tone mapping all still run.
//
// ── A DEFINE, not a uniform, and this is not a style choice ──────────────
//
// `render.haze`, `render.illustrative` and `render.sunHeight` each switch off by
// writing a uniform with no early-out behind it, and the floor sweep measured
// the four of them at +0.09, -0.01, -0.03 and -0.12 ms against drifts of
// 0.01-0.10 — which for three of the four means *the arm removed nothing*
// (`docs/plan/VR-PERF-WAVE-3.md` §9). three hashes `material.defines` into
// `getProgramCacheKey`, so a define flip fetches a genuinely different program:
// one compile per arm per session, then free. That is the only shape of switch
// this question can be asked with.

import * as THREE from 'three'
import { BAKED_LIGHT_RUNGS, type BakedLightRung } from '@/content/edition-schema'
import { chainShaderPatch } from './program-cache-key'

export { BAKED_LIGHT_RUNGS, type BakedLightRung }

/** The define that selects the baked path. Set on the BASE terrain material. */
export const BAKED_LIGHT_DEFINE = 'FF2_BAKED_LIGHT'

/**
 * The SECOND define, and the whole of DEV-237. Present only when the bake is
 * live AND the rung is 1; absent at rung 3, which is what makes rung 3 the
 * build DEV-232 measured rather than a build that merely resembles it.
 *
 * ── Why the emitted GLSL is a function of `material.defines` ─────────────
 *
 * Every other gate in this renderer emits both branches and lets the
 * preprocessor choose (`fragment-gates.ts`, and rung 3 above). That is the
 * right default and it is wrong here for one reason: emitting rung 1's branch
 * unconditionally would change rung 3's shader TEXT, and DEV-232's
 * −0.80 ms p50 / −1.15 p95 was measured on one exact program. A rung that
 * re-prices the arm it is being compared against is not a comparison.
 *
 * So `bakedLightPatchFragment` takes the rung and emits one shape or the other,
 * and {@link installBakedLight} reads that rung **off the material's own
 * defines at compile time**. That makes the text a pure function of the state
 * three already hashes into the program cache key — so the two cannot drift
 * apart, which is the DEV-194 hazard this arrangement would otherwise be a
 * textbook instance of. Change the rung, and the define changes, and the key
 * changes, and three compiles the text that define asked for. There is no
 * third place for the truth to live.
 *
 * `tests/unit/baked-light.test.ts` holds both halves: the rung-3 text against a
 * fixture captured on 4562893, and the two rungs against each other.
 */
export const BAKED_RUNG1_DEFINE = 'FF2_BAKED_RUNG1'

/**
 * The THIRD define, and the whole of DEV-240. Present only when the bake is
 * live AND the rung is `'split'`.
 *
 * It carries exactly the same argument as {@link BAKED_RUNG1_DEFINE}: the
 * emitted text is a function of the defines three is about to hash, so the
 * program and the source cannot drift apart, and rung 3's text is untouched by
 * a rung nobody asked for.
 */
export const BAKED_SPLIT_DEFINE = 'FF2_BAKED_SPLIT'

/**
 * The vertex attribute the split rung's DIRECT half rides in, and the varying
 * that carries it to the fragment. DEV-240.
 *
 * A second attribute rather than a second channel of the existing one: the
 * `color` attribute is three's `USE_COLOR`, and widening it to a vec4 would put
 * the direct term in `vColor.a`, which `color_fragment`'s `diffuseColor *=
 * vColor` multiplies straight into the material's OPACITY. `lod-fade.ts`
 * discards on a dither rather than on alpha today, but a term that is only
 * harmless because nothing currently reads alpha is a trap with a date on it.
 *
 * Named on `THREE.BufferGeometry` and in the GLSL from these two constants so
 * the two halves cannot be spelled differently — the attribute is bound by
 * NAME, and a mismatch is not an error anywhere: the program simply reads the
 * generic attribute and the land loses its sun.
 */
export const DIRECT_ATTRIBUTE = 'ff2Direct'
/** @see DIRECT_ATTRIBUTE */
export const DIRECT_VARYING = 'vFf2Direct'

/**
 * Every define this module writes, in the fixed order {@link setBakedLight}
 * writes them (DEV-194).
 *
 * ONE list, because the report's `defines` field is the mechanism check a
 * measurement arm is refused on, and the first version of DEV-240 added a third
 * name to `setBakedLight` and not to the report — so the photo spec printed
 * `defines=[FF2_BAKED_LIGHT]` beside `live=split` for an arm that was plainly
 * running the split shader. A name that has to be added in two places is a name
 * that will be added in one.
 */
export const BAKED_DEFINES: readonly string[] = [
  BAKED_LIGHT_DEFINE,
  BAKED_RUNG1_DEFINE,
  BAKED_SPLIT_DEFINE,
]

/**
 * The rung a material is carrying, read from its defines.
 *
 * **Anything that is not `'split'` and not rung 1 is rung 3.** That is
 * deliberate at the shader — an unrecognised rung must not invent a fourth
 * picture — and it is deliberately NOT true at the preset, where
 * `validateBakedLight` refuses a rung outside `BAKED_LIGHT_RUNGS` because there
 * an unknown value means somebody meant something.
 */
export const bakedRungOf = (material: THREE.Material): BakedLightRung => {
  const defines = material.defines ?? {}
  if (Object.hasOwn(defines, BAKED_SPLIT_DEFINE)) return 'split'
  return Object.hasOwn(defines, BAKED_RUNG1_DEFINE) ? 1 : 3
}

/**
 * The statements this patch may replace, one per lit material class, exactly as
 * three 0.185.1 writes them.
 *
 * A LIST rather than one string because `?terrainLit=lambert` (DEV-182) is a
 * different class with a different line, and a patch that silently did nothing
 * on it would be a no-op wearing a feature's clothes — the failure this whole
 * family of files keeps paying for (DEV-069). `basic` is deliberately absent:
 * it has no lighting to remove, so installing there would be meaningless rather
 * than wrong, and `installBakedLight` is simply never asked for it.
 *
 * Verified against `THREE.ShaderLib` in `tests/unit/baked-light.test.ts` rather
 * than trusted, the way `xr-eye-layers.test.ts` reads three's own build as the
 * oracle: these are three's private text and `three` is pinned exact only until
 * `three-mesh-bvh`'s ceiling is accepted.
 */
export const OUTGOING_ANCHORS = [
  'vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;',
  'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;',
] as const

/** How many times `needle` occurs in `text`. */
const count = (text: string, needle: string): number => text.split(needle).length - 1

/**
 * Where rung 1's helper is declared. three writes `void main() {` exactly once
 * in every fragment shader in `ShaderLib`, and every declaration the helper
 * needs is above it — `lights_pars_begin` (which declares `uniform bool
 * receiveShadow`) and `shadowmap_pars_fragment` (which declares `getShadow`,
 * `directionalShadowMap`, `vDirectionalShadowCoord` and the
 * `DirectionalLightShadow` array). Asserted against three's own build in
 * `tests/unit/baked-light.test.ts` rather than trusted.
 */
const MAIN_ANCHOR = 'void main() {'

/**
 * Rung 1's whole difference from rung 3: the shadow multiply, kept per
 * fragment, with nothing else of the lighting chain left alive.
 *
 * ── It is three's own statement, restated where the chain is dead ────────
 *
 * With `FF2_BAKED_LIGHT` set, `totalDiffuse` and `totalSpecular` have no
 * consumer and the compiler removes everything behind them — including the
 * directional loop, which is where three (as `render/far-shadow.ts` rewrites
 * it) does the multiply:
 *
 *     directLight.color *= min(
 *       ( directLight.visible && receiveShadow ) ? getShadow( … ) : 1.0,
 *       ff2SunHeightTerm() );
 *
 * So rung 1 cannot "keep" that line; it has to say it again somewhere the
 * compiler can still reach. This is that, term for term:
 *
 *  * `directLight.visible` is dropped because `getDirectionalLightInfo` sets it
 *    to a literal `true` for every directional light — read out of
 *    `THREE.ShaderChunk.lights_pars_begin`, not remembered. `receiveShadow`
 *    stays: it is a real per-object uniform and a chunk that does not receive
 *    must not be darkened.
 *  * index **0**, because `boot/app.ts` builds exactly one `DirectionalLight`
 *    per mission and never touches it again, and `bakedLightModelOf` bakes that
 *    same first light. The two halves of rung 1 therefore agree about which sun
 *    they are talking about by construction.
 *  * `ff2SunHeightTerm` under `#ifdef FF2_SUN_HEIGHT` — the define
 *    `render/far-shadow.ts` prepends to every shader it patches, for exactly
 *    this use ("so a material's OWN sun term can take the same shadow under
 *    #ifdef rather than guessing whether the function exists"). `min`, not a
 *    product, because that is what far-shadow writes: two shadows of one sun
 *    compose by whichever is darker, not by multiplying.
 *
 * What rung 1 still drops: the GGX lobe, both PMREM fetches,
 * `terrain-surface.ts`'s roughness classifier that feeds them, and the whole
 * `lights_fragment_*` stack. On Simonet Marmoset `_SpecInt` is 0.05 — "very
 * nearly matte" — and DEV-182 photographed the whole IBL cut at 0.9–2.2 levels
 * of 255 there.
 *
 * ── AND IT DROPS ONE MORE THING, WHICH THE PLAN DID NOT PREDICT ──────────
 *
 * DEV-232 §4 calls rung 1 *"the rung with the best fidelity-to-prize ratio"*
 * and says it **"loses only the view-dependent specular"**. Photographed, that
 * is false, and the reason is structural rather than a slip in this file:
 *
 * **three multiplies the shadow into `directLight.color` ONLY.** A shadowed
 * fragment still receives the light probe's irradiance, which is why a
 * shadowed hillside in this game is pale rather than black. The bake collapses
 * the direct and the indirect into ONE vertex colour, so there is nothing left
 * to shadow half of — `diffuseColor.rgb * shadowTerm` shadows the ambient too.
 *
 * Measured on `adv_02_jumpSeat`, the `island-lit` stand, at 1280x720 (DEV-237):
 * `off` and rung 3 agree to **2.07 mean levels of 255** — the bake really is
 * lossless for the diffuse — while rung 1 sits **33.9 levels darker**, and
 * switching `render.sunHeight` off at the uniform moves it by only **4.2**, so
 * ~88 % of that darkening is `getShadow` applied to light three never shadows.
 * At a 4-degree sun the whole far side of the massif is inside the shadow map,
 * so this is most of the island rather than a corner of it.
 *
 * It is implemented as the plan wrote it, deliberately, because the picture is
 * the evidence. The correction is a rung of its own and is NOT built here: bake
 * the indirect into a second vertex attribute and write
 * `ambient + direct * shadow`, which is exactly three's semantics for the
 * diffuse and costs one vec3 per vertex. `docs/DEVIATIONS.md` DEV-237 carries
 * the argument and the cost.
 */
export const SHADOW_ONLY_GLSL = `
// DEV-237 rung 1. The directional shadow this fragment sees, on its own, for a
// baked surface whose lighting chain the compiler has removed.
float ff2ShadowOnly() {
	float s = 1.0;
	#if defined( USE_SHADOWMAP ) && ( NUM_DIR_LIGHT_SHADOWS > 0 )
		DirectionalLightShadow ff2BakedShadow = directionalLightShadows[ 0 ];
		s = receiveShadow ? getShadow( directionalShadowMap[ 0 ], ff2BakedShadow.shadowMapSize, ff2BakedShadow.shadowIntensity, ff2BakedShadow.shadowBias, ff2BakedShadow.shadowRadius, vDirectionalShadowCoord[ 0 ] ) : 1.0;
		// DEV-453: the loop's own fade toward lit at the box's faces, restated
		// here for the reason the multiply is -- the loop is dead code on this rung.
		#ifdef FF2_SUN_HEIGHT
			s = mix( 1.0, s, ff2ShadowCover( vDirectionalShadowCoord[ 0 ] ) );
		#endif
	#endif
	#ifdef FF2_SUN_HEIGHT
		s = min( s, ff2SunHeightTerm() );
	#endif
	return s;
}
`

/** The statement rung 3 writes with the define set — DEV-232's, unchanged. */
const RUNG3_WRITE = 'vec3 outgoingLight = diffuseColor.rgb + totalEmissiveRadiance;'

/** The statement rung 1 writes with the define set. */
const RUNG1_WRITE =
  'vec3 outgoingLight = diffuseColor.rgb * ff2ShadowOnly() + totalEmissiveRadiance;'

/**
 * The split rung's declarations, DEV-240 — the fragment half of the second
 * attribute.
 *
 * `varying` and not `in`, because three's `prefixFragment` carries
 * `#define varying in` for every non-raw material and every chunk in
 * `ShaderChunk` is written this way. Read out of three's own build in
 * `tests/unit/baked-light-split.test.ts` rather than remembered.
 */
export const SPLIT_PARS_GLSL = `
// DEV-240. The DIRECT half of the baked diffuse, per vertex: albedo * N.L *
// sunColor / pi, with the ambient left in the color attribute where three's
// own color_fragment puts it.
varying vec3 ${DIRECT_VARYING};
`

/**
 * Rung split's whole difference from rung 1: the shadow multiplies the DIRECT
 * term and nothing else.
 *
 * ── Why `diffuse *` and not just the varying ─────────────────────────────
 *
 * three builds the fragment's albedo as `vec4 diffuseColor = vec4( diffuse,
 * opacity );` and then `color_fragment` does `diffuseColor *= vColor;`. So the
 * AMBIENT half arrives already multiplied by the material's linear tint — the
 * `diffuse` uniform, which on the land is `islandgroup`'s
 * (0.725, 0.539, 0.478) — and the direct half has to take the same tint or the
 * two halves are lit by two different materials. Asserted against
 * `THREE.ShaderLib` rather than assumed: the tint's uniform is named `diffuse`
 * in `physical`, `standard` and `lambert` alike.
 *
 * ── And why this is EXACTLY three's semantics rather than nearly ─────────
 *
 * `lights_fragment_begin` multiplies the shadow into `directLight.color`, and
 * `RE_Direct_Physical` turns that into `reflectedLight.directDiffuse` alone;
 * `getLightProbeIrradiance` feeds `indirectDiffuse` and never sees a shadow.
 * Writing `ambient + direct * s` reproduces that pair term for term. Rung 1
 * writes `(ambient + direct) * s`, which is the same expression only where
 * `ambient` is zero — and the whole reason shadowed ground in this game is pale
 * is that it is not.
 */
const SPLIT_WRITE =
  'vec3 outgoingLight = diffuseColor.rgb + diffuse * ' +
  `${DIRECT_VARYING} * ff2ShadowOnly() + totalEmissiveRadiance;`

/**
 * The vertex hook the split rung hangs its one assignment on.
 *
 * `color_vertex` and not `begin_vertex` because this IS the vertex-colour
 * path — the direct half is the other half of the value `color_vertex` copies
 * into `vColor`, and a reader who finds one wants to find the other beside it.
 * three writes the include exactly once in every `ShaderLib` vertex shader that
 * has a colour at all, which the test asserts against three's own build.
 */
const SPLIT_VERTEX_HOOK = '#include <color_vertex>'

/** The vertex half: one attribute, one varying, one copy. */
export const SPLIT_VERTEX_GLSL = `
	${DIRECT_VARYING} = ${DIRECT_ATTRIBUTE};`

/**
 * Give a vertex shader the split rung's attribute, varying and copy. The
 * IDENTITY at every other rung, so rungs 1 and 3 compile the vertex shader
 * 4562893 compiled.
 */
export const bakedLightPatchVertex = (source: string, rung: BakedLightRung = 3): string => {
  if (rung !== 'split') return source
  if (count(source, SPLIT_VERTEX_HOOK) !== 1) {
    throw new Error(
      `baked-light: expected exactly one "${SPLIT_VERTEX_HOOK}" in the vertex shader, found ` +
        `${count(source, SPLIT_VERTEX_HOOK)}. The split rung needs somewhere to copy ` +
        `${DIRECT_ATTRIBUTE} into ${DIRECT_VARYING} — re-read three's ShaderLib.`,
    )
  }
  return `attribute vec3 ${DIRECT_ATTRIBUTE};\nvarying vec3 ${DIRECT_VARYING};\n${source}`.replace(
    SPLIT_VERTEX_HOOK,
    `${SPLIT_VERTEX_HOOK}${SPLIT_VERTEX_GLSL}`,
  )
}

/**
 * Wrap the one `outgoingLight` assignment in the gate, at the given rung.
 *
 * **Throws** rather than returning something plausible, for `gateFragmentShader`'s
 * reason: every failure here is silent by nature — the shader still compiles,
 * the frame still renders, and the gate simply never fires.
 *
 * `rung` defaults to 3 so that **the text this emits with no rung asked for is
 * byte-for-byte the text 4562893 emitted** — `tests/unit/fixtures/
 * baked-light-rung3.json` is that tree's own output and the test diffs against
 * it. See {@link BAKED_RUNG1_DEFINE} for why the rung decides the TEXT here
 * rather than being a second `#ifdef` inside one text.
 */
export const bakedLightPatchFragment = (source: string, rung: BakedLightRung = 3): string => {
  const found = OUTGOING_ANCHORS.filter((a) => count(source, a) === 1)
  if (found.length !== 1) {
    throw new Error(
      `baked-light: expected exactly one of three's outgoingLight assignments in the shader, ` +
        `found ${found.length}. Re-read node_modules/three/build/three.module.js's ShaderLib ` +
        'and update OUTGOING_ANCHORS.',
    )
  }
  const anchor = found[0] as string
  const write = rung === 1 ? RUNG1_WRITE : rung === 'split' ? SPLIT_WRITE : RUNG3_WRITE
  let patched = source.replace(
    anchor,
    `#ifdef ${BAKED_LIGHT_DEFINE}\n\t${write}\n#else\n\t${anchor}\n#endif`,
  )
  // Both shadowed rungs need the helper, and they need it in the same place:
  // above `main`, below the pars that declare `getShadow` and `receiveShadow`.
  // `'split'` additionally declares the varying its direct half arrives in.
  if (rung === 1 || rung === 'split') {
    if (count(patched, MAIN_ANCHOR) !== 1) {
      throw new Error(
        `baked-light: expected exactly one "${MAIN_ANCHOR}" to declare ff2ShadowOnly() above, ` +
          `found ${count(patched, MAIN_ANCHOR)}. Rung ${String(rung)} needs a scope where ` +
          'getShadow and receiveShadow are already declared — see SHADOW_ONLY_GLSL.',
      )
    }
    const pars = rung === 'split' ? `${SPLIT_PARS_GLSL}${SHADOW_ONLY_GLSL}` : SHADOW_ONLY_GLSL
    patched = patched.replace(MAIN_ANCHOR, `${pars}\n${MAIN_ANCHOR}`)
  }
  if (!patched.includes(BAKED_LIGHT_DEFINE)) {
    throw new Error(`baked-light: ${BAKED_LIGHT_DEFINE} did not land in the patched shader.`)
  }
  return patched
}

/** Materials that already carry the patch, so installing twice is a no-op. */
const installed = new WeakSet<THREE.Material>()

/**
 * Install the gate on one material. Idempotent, chained, tagged.
 *
 * Tagged because `onBeforeCompile` is NOT in three's program cache key, and an
 * untagged patch shares a program with any identically-parameterised material
 * that does not carry it — the whole of `render/program-cache-key.ts`.
 *
 * **Install on the BASE material**, the one `LoadedTerrain.materials` holds.
 * `render/lod-fade.ts` cuts pooled clones from it and `Material.copy` wipes
 * `defines` — but `acquire()` re-syncs every clone it lends against the base's
 * `variantKey`, which spreads the base's defines. So a define set here reaches
 * the clones and a define set on a clone does not survive its next trip through
 * the pool.
 */
export const installBakedLight = (material: THREE.Material): void => {
  // The token goes on FIRST and the rung wrapper below goes on top of it, so the
  // key reads `...|baked-light|rungN`: that is why the whole patch is installed
  // here rather than beside the other steps at the end. The hook reads the rung
  // HERE, at compile time, from the defines three is about to hash, rather than
  // capturing it at install, so the text and the key cannot disagree about which
  // rung this program is (see BAKED_RUNG1_DEFINE).
  const fresh = chainShaderPatch(
    material,
    {
      tag: 'baked-light',
      after: (shader) => {
        const rung = bakedRungOf(material)
        shader.vertexShader = bakedLightPatchVertex(shader.vertexShader, rung)
        shader.fragmentShader = bakedLightPatchFragment(shader.fragmentShader, rung)
      },
    },
    installed,
  )
  if (!fresh) return
  // ── and the RUNG on top of it (DEV-237) ────────────────────────────────
  //
  // `program-cache-key.ts`'s rule is that the tag must name every way the
  // injected source can differ, and after DEV-237 the source differs by rung.
  // The define alone would already split the two programs — three hashes
  // `material.defines` — so this is the belt to that braces, and it is written
  // to contribute NOTHING at rung 3 so the key that arm hashes under is the one
  // DEV-232 measured under.
  //
  // Read off `material` and not `this`: `render/lod-fade.ts` gives every clone
  // `customProgramCacheKey = () => base.customProgramCacheKey() + '|…'`, so the
  // base is the object that carries the truth for the whole pool — and
  // `syncVariant` spreads the base's defines into each clone, so they agree.
  const previousKey = material.customProgramCacheKey
  material.customProgramCacheKey = function (this: THREE.Material): string {
    const base = previousKey.call(this)
    const rung = bakedRungOf(material)
    // Rung 3 contributes NOTHING, so the key that arm hashes under is the one
    // DEV-232 measured under. Every other rung names itself.
    return rung === 3 ? base : `${base}|rung${String(rung)}`
  }
  // ── the belt for the split rung's second attribute (DEV-240) ───────────
  //
  // A program that declares `attribute vec3 ff2Direct` and is handed a geometry
  // without one does not fail: WebGL reads the GENERIC vertex attribute at that
  // location, whose value is whatever the last `vertexAttrib*fv` on it left
  // there. `WebGLBindingStates` consults `material.defaultAttributeValues` for
  // exactly this case, so naming a zero here makes the miss "no sun on this
  // chunk" instead of "whatever the previous draw call happened to set".
  //
  // It is a belt and not the braces. The braces are the invariant that the
  // define and the attribute are written in the SAME call — `refresh` does both
  // for every registered material and every offered geometry, and `offer` does
  // both for a chunk that streams in — and `report().refusals` is how a
  // geometry that slipped through is counted rather than assumed away.
  //
  // `Material.copy` does not carry this field (only `ShaderMaterial.copy`
  // does), so `lod-fade.ts`'s pooled clones do not have it. That is the
  // DEV-194 class of bug and here it is harmless for a reason worth writing
  // down: **the fallback is a property of the GEOMETRY, not of the material.**
  // A clone is lent to draw the same chunk geometry its base draws, so a clone
  // can only ever meet a geometry the base could also meet.
  //
  // The cast is the honest part: three declares the field on `ShaderMaterial`
  // and READS it off `material` whatever the class, in `setupVertexAttributes`.
  // That is three's private behaviour, so `baked-light-split.test.ts` reads it
  // out of three's own build rather than trusting this comment.
  const withDefaults = material as THREE.Material & {
    defaultAttributeValues?: Record<string, number[]>
  }
  withDefaults.defaultAttributeValues = {
    ...(withDefaults.defaultAttributeValues ?? {}),
    [DIRECT_ATTRIBUTE]: [0, 0, 0],
  }
}

/** Whether `material` carries the gate. */
export const hasBakedLight = (material: THREE.Material): boolean => installed.has(material)

/**
 * Set the define, and return whether anything moved.
 *
 * `needsUpdate` only on a real change: it drops the material's program
 * reference and makes three re-fetch on the next frame, so a sweep that sets
 * the same arm twice must not pay for it twice or the second reading is
 * measuring a compile.
 *
 * The define is assigned IN PLACE and deleted rather than moved, because three
 * walks `material.defines` in INSERTION order — `{A,B}` and `{B,A}` are two
 * keys for one shader, and a delete-then-re-add makes the key a function of the
 * run's history rather than of its state (DEV-194).
 */
export const setBakedLight = (
  material: THREE.Material,
  on: boolean,
  rung: BakedLightRung = 3,
): boolean => {
  const defines = (material.defines ?? {}) as Record<string, unknown>
  const wantRung1 = on && rung === 1
  const wantSplit = on && rung === 'split'
  const hasLight = Object.hasOwn(defines, BAKED_LIGHT_DEFINE)
  const hasRung1 = Object.hasOwn(defines, BAKED_RUNG1_DEFINE)
  const hasSplit = Object.hasOwn(defines, BAKED_SPLIT_DEFINE)
  if (hasLight === on && hasRung1 === wantRung1 && hasSplit === wantSplit) return false
  // ── ORDER, and it is the whole of DEV-194 ──────────────────────────────
  //
  // three walks `material.defines` with `for ( const name in … )`, so `{A,B}`
  // and `{B,A}` are two keys for one shader and a key that moves is a function
  // of the run's HISTORY rather than of its state. All THREE of these names are
  // written at the TAIL in one fixed order — light, then rung1, then split —
  // and removed from the tail, so every route to a given (on, rung) pair
  // produces the same insertion order: off, on-at-3, on-at-1, on-at-split, back
  // to 3, off and on again all land on the same keys. (DEV-240 adds the third
  // name and changes nothing about the rule; only one rung name is ever
  // present, so the light/rung1/split order is what a rung FLIP has to be
  // unable to disturb.)
  //
  // Removed BEFORE any is added, so a rung flip that keeps the light on does
  // not leave a rung name sitting above the light name.
  if (!on) delete defines[BAKED_LIGHT_DEFINE]
  if (!wantRung1) delete defines[BAKED_RUNG1_DEFINE]
  if (!wantSplit) delete defines[BAKED_SPLIT_DEFINE]
  if (on && !Object.hasOwn(defines, BAKED_LIGHT_DEFINE)) defines[BAKED_LIGHT_DEFINE] = ''
  if (wantRung1 && !Object.hasOwn(defines, BAKED_RUNG1_DEFINE)) defines[BAKED_RUNG1_DEFINE] = ''
  if (wantSplit && !Object.hasOwn(defines, BAKED_SPLIT_DEFINE)) defines[BAKED_SPLIT_DEFINE] = ''
  material.defines = defines
  material.needsUpdate = true
  return true
}

// ─────────────────────────────────────────────────────────────────────────
// The bake itself
// ─────────────────────────────────────────────────────────────────────────

/**
 * The lighting a bake reproduces, in three's own terms rather than in ours.
 *
 * Every field is read OFF THE SCENE by {@link bakedLightModelOf} rather than
 * re-derived from the level JSON, which is the point: the bake and the renderer
 * then cannot disagree about what the sun is, because they are reading the same
 * object. (CLAUDE.md trap 24 — a test, or a bake, that re-derives its input the
 * way the code does has not checked the code.)
 */
export interface BakedLightModel {
  /**
   * `directLight.direction` — the unit vector FROM the surface TOWARD the sun,
   * three space. Note this is the NEGATION of `lighting.sun.direction`, which
   * is the direction light travels.
   */
  readonly sunToward: readonly [number, number, number]
  /** `directLight.color` — `light.color * light.intensity`, linear rgb. */
  readonly sunColor: readonly [number, number, number]
  /**
   * three's `state.probe` — every `LightProbe`'s nine coefficients summed with
   * its intensity already folded in. Linear rgb.
   */
  readonly probe: readonly (readonly [number, number, number])[]
}

/** three's `RECIPROCAL_PI`, the constant `BRDF_Lambert` multiplies by. */
const RECIPROCAL_PI = 1 / Math.PI

/**
 * `shGetIrradianceAt`, transcribed from three 0.185.1's `lights_pars_begin`.
 *
 * The coefficients are three's, not ours — `tests/unit/baked-light.test.ts`
 * reads the GLSL out of `THREE.ShaderChunk` and asserts each one appears in it,
 * so a three upgrade that retunes them fails here rather than shifting the
 * ambient by a few percent in silence.
 */
export const SH_BANDS = [
  0.886227,
  2.0 * 0.511664,
  0.743125,
  0.247708,
  2.0 * 0.429043,
  0.429043,
] as const

/**
 * The irradiance a normal receives from the probe, exactly as three's
 * `shGetIrradianceAt` computes it.
 */
export const shIrradiance = (
  x: number,
  y: number,
  z: number,
  probe: BakedLightModel['probe'],
  out: [number, number, number],
): [number, number, number] => {
  const [c0, c1, c2, c3, c4, c5] = SH_BANDS
  // The six weights, in the order the shader applies them to coefficients 0..8.
  const w = [
    c0,
    c1 * y,
    c1 * z,
    c1 * x,
    c4 * x * y,
    c4 * y * z,
    c2 * z * z - c3,
    c4 * x * z,
    c5 * (x * x - y * y),
  ]
  out[0] = 0
  out[1] = 0
  out[2] = 0
  for (let i = 0; i < 9; i++) {
    const c = probe[i]
    if (!c) continue
    const k = w[i] as number
    out[0] += (c[0] as number) * k
    out[1] += (c[1] as number) * k
    out[2] += (c[2] as number) * k
  }
  return out
}

/**
 * The scalar triple a face's albedo is multiplied by — the whole of what this
 * module bakes.
 *
 * Exactly three's arithmetic, and each half is one line of its shader:
 *
 *     irradiance = saturate( dot( geometryNormal, directLight.direction ) ) * directLight.color
 *     reflectedLight.directDiffuse += irradiance * BRDF_Lambert( albedo )
 *     irradiance = getLightProbeIrradiance( lightProbe, geometryNormal )
 *     reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( albedo )
 *
 * with `BRDF_Lambert(c) = RECIPROCAL_PI * c`. So the factor is
 * `RECIPROCAL_PI * ( dotNL * sunColor + shIrradiance )`, and nothing in it
 * depends on the view.
 *
 * **What it does NOT include**, each named in `docs/DEVIATIONS.md`: the
 * illustrative Half-Lambert ramp (bakeable — same shape, no view term — and not
 * yet done), the two shadow terms, and the whole view-dependent specular half.
 */
export const bakedFactor = (
  nx: number,
  ny: number,
  nz: number,
  model: BakedLightModel,
  out: [number, number, number],
): [number, number, number] => {
  const [lx, ly, lz] = model.sunToward
  const dotNL = Math.max(0, Math.min(1, nx * lx + ny * ly + nz * lz))
  shIrradiance(nx, ny, nz, model.probe, out)
  out[0] = (out[0] + dotNL * (model.sunColor[0] as number)) * RECIPROCAL_PI
  out[1] = (out[1] + dotNL * (model.sunColor[1] as number)) * RECIPROCAL_PI
  out[2] = (out[2] + dotNL * (model.sunColor[2] as number)) * RECIPROCAL_PI
  return out
}

/**
 * The same two terms as {@link bakedFactor}, kept APART. DEV-240.
 *
 * `ambient` is `shIrradiance(n) / pi` and `direct` is `dotNL * sunColor / pi`,
 * which is precisely the split three itself makes: `lights_fragment_begin`
 * multiplies the shadow into `directLight.color` and therefore into the second
 * of these only, while `getLightProbeIrradiance` feeds the first and never sees
 * a shadow.
 *
 * `ambient + direct` is {@link bakedFactor} to within float association — the
 * one writes `(a + b) * k` and the other `a*k + b*k` — and
 * `baked-light-split.test.ts` holds the two against each other so a change to
 * either is a change to both.
 */
export const bakedFactorSplit = (
  nx: number,
  ny: number,
  nz: number,
  model: BakedLightModel,
  ambient: [number, number, number],
  direct: [number, number, number],
): void => {
  const [lx, ly, lz] = model.sunToward
  const dotNL = Math.max(0, Math.min(1, nx * lx + ny * ly + nz * lz))
  shIrradiance(nx, ny, nz, model.probe, ambient)
  ambient[0] *= RECIPROCAL_PI
  ambient[1] *= RECIPROCAL_PI
  ambient[2] *= RECIPROCAL_PI
  direct[0] = dotNL * (model.sunColor[0] as number) * RECIPROCAL_PI
  direct[1] = dotNL * (model.sunColor[1] as number) * RECIPROCAL_PI
  direct[2] = dotNL * (model.sunColor[2] as number) * RECIPROCAL_PI
}

/**
 * `raw * bakedFactor(normal)`, vertex by vertex, into `out`.
 *
 * `normals` and `raw` are three-component and the same length; `out` may be
 * `raw` itself, which is what makes an in-place re-bake cheap.
 */
export const bakeVertexColours = (
  raw: Float32Array,
  normals: Float32Array,
  model: BakedLightModel,
  out: Float32Array,
): Float32Array => {
  if (normals.length !== raw.length || out.length !== raw.length) {
    throw new Error(
      `baked-light: colour/normal/out lengths disagree (${raw.length}, ${normals.length}, ${out.length})`,
    )
  }
  const k: [number, number, number] = [0, 0, 0]
  for (let i = 0; i < raw.length; i += 3) {
    bakedFactor(normals[i] as number, normals[i + 1] as number, normals[i + 2] as number, model, k)
    out[i] = (raw[i] as number) * k[0]
    out[i + 1] = (raw[i + 1] as number) * k[1]
    out[i + 2] = (raw[i + 2] as number) * k[2]
  }
  return out
}

/**
 * The split rung's bake: the AMBIENT half into `ambientOut`, the DIRECT half
 * into `directOut`, vertex by vertex. DEV-240.
 *
 * `ambientOut` may be the live colour buffer — the two halves are computed
 * before either is written, so aliasing `ambientOut` with `raw` is safe the way
 * {@link bakeVertexColours} is. `directOut` must be a buffer of its own.
 */
export const bakeVertexColoursSplit = (
  raw: Float32Array,
  normals: Float32Array,
  model: BakedLightModel,
  ambientOut: Float32Array,
  directOut: Float32Array,
): void => {
  if (
    normals.length !== raw.length ||
    ambientOut.length !== raw.length ||
    directOut.length !== raw.length
  ) {
    throw new Error(
      `baked-light: colour/normal/ambient/direct lengths disagree (${raw.length}, ` +
        `${normals.length}, ${ambientOut.length}, ${directOut.length})`,
    )
  }
  const a: [number, number, number] = [0, 0, 0]
  const d: [number, number, number] = [0, 0, 0]
  for (let i = 0; i < raw.length; i += 3) {
    bakedFactorSplit(
      normals[i] as number,
      normals[i + 1] as number,
      normals[i + 2] as number,
      model,
      a,
      d,
    )
    const r = raw[i] as number
    const g = raw[i + 1] as number
    const b = raw[i + 2] as number
    ambientOut[i] = r * a[0]
    ambientOut[i + 1] = g * a[1]
    ambientOut[i + 2] = b * a[2]
    directOut[i] = r * d[0]
    directOut[i + 1] = g * d[1]
    directOut[i + 2] = b * d[2]
  }
}

/**
 * Read the model off a scene, so the bake and the renderer cannot disagree.
 *
 * `null` when there is no directional light — a scene with no sun has nothing
 * to bake and the caller must leave the colours alone rather than bake a black
 * world.
 *
 * Lights are summed the way `WebGLLights` sums them: the probe accumulates
 * `sh.coefficients[j] * intensity` over every `LightProbe`, and the sun is the
 * FIRST directional light, which is what `boot/app.ts` builds and the only one
 * a mission scene has.
 */
export const bakedLightModelOf = (scene: THREE.Object3D): BakedLightModel | null => {
  let sun: THREE.DirectionalLight | null = null
  const probe: [number, number, number][] = Array.from({ length: 9 }, () => [0, 0, 0])
  scene.traverse((o) => {
    const light = o as THREE.DirectionalLight & THREE.LightProbe
    if (!sun && light.isDirectionalLight) sun = light as THREE.DirectionalLight
    if (light.isLightProbe && light.sh) {
      for (let j = 0; j < 9; j++) {
        const c = light.sh.coefficients[j]
        const row = probe[j] as [number, number, number]
        if (!c) continue
        row[0] += c.x * light.intensity
        row[1] += c.y * light.intensity
        row[2] += c.z * light.intensity
      }
    }
  })
  if (!sun) return null
  const light = sun as THREE.DirectionalLight
  // `getDirectionalLightInfo` hands the shader `light.position - target.position`
  // normalised; in world space that is exactly this.
  const toward = new THREE.Vector3().subVectors(light.position, light.target.position).normalize()
  return {
    sunToward: [toward.x, toward.y, toward.z],
    sunColor: [
      light.color.r * light.intensity,
      light.color.g * light.intensity,
      light.color.b * light.intensity,
    ],
    probe,
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Applying it, reversibly — and the two ways the first version silently failed
// ─────────────────────────────────────────────────────────────────────────
//
// Both were found by a coordinator running the A/B, and both are worth stating
// here because the shape of each is a rule this repo already has.
//
// ── 1. THE LAND GROUP IS NOT ONLY THE LAND ───────────────────────────────
//
// The first version re-applied the bake by traversing `LoadedTerrain.group` and
// touching every mesh under it. That group is also where `boot/app.ts` parents
// the SCATTER (`terrain.group.add(liveProps.group)`), the fracture pieces and
// the V9 dressing — its own comment says so: *"they are parented under the
// terrain"*. So the sweep walked glTF prop meshes, and it threw:
//
//     baked-light: colour/normal/out lengths disagree (6384, 4788, 6384)
//
// 6384/4 = 4788/3 = 1596, exactly: a `COLOR_0` of **vec4** against a vec3
// normal on one 1596-vertex prop, which is the alpha CLAUDE.md warns about in
// Unity's `Color32`. (It is not a subdivision-state mismatch — sub-face counts
// scale by n-squared and no integer pair gives 4/3.)
//
// **And the throw was the lucky outcome.** Had those props carried a vec3
// colour it would have silently BAKED THE SCATTER, which
// `docs/plan/DEV-232-BAKED-LIGHT.md` §2e proves is impossible: `scatter.ts`
// draws a uniformly random yaw per instance and one `InstancedMesh` shares one
// geometry, so a baked local sun term lights every rock in a field from its own
// private direction. A crash is a bad day; that is a wrong picture nobody would
// have traced back here.
//
// So scope is no longer a traversal predicate. `offer()` — called from
// `loadTerrain`'s chunk-build hook and from nowhere else — is the ONLY way a
// geometry enters this module's world, and the sweep intersects the live scene
// graph with that set. A `WeakSet` because chunk geometries are replaced on
// every LOD change and a strong set of them is a leak; the traversal supplies
// liveness, the `WeakSet` supplies scope, and neither can be wrong on its own.
//
// ── 2. INTENT IS NOT THE SAME THING AS THE RESOLVED STATE ────────────────
//
// The A/B came back at 0.025 ms against a 0.05 ms bracket with the program
// count IDENTICAL in all three arms — and a define is in three's program cache
// key, so an arm that set one cannot leave that untouched. It never fired.
//
// The mechanism, from line numbers rather than a theory: the refresh gated on
// `liveTerrain`, which `boot/app.ts` assigns **902 lines after** the call that
// was supposed to push the define. That call has never done anything. The
// edition subscriber's call had the same hole whenever it ran before the world
// was built, which is exactly when `VRTO3D_FLAGS_ON` flips — the spec flips as
// soon as `__ff2.edition` exists and only THEN waits for `#enter-vr`.
//
// This is DEV-231's lesson arriving from the other side. There it was *"an
// assignment is not a state"* — the game wrote `.visible` back every frame.
// Here it is the converse: a state was computed once, at a moment when its
// inputs did not exist, and nothing ever recomputed it.
//
// So `setEnabled` stores the INTENT and nothing else can destroy it, `refresh`
// re-resolves the model from the scene every single time, and the roots and
// materials are registered where they exist rather than fetched from a variable
// that might not be assigned yet.
//
// ── 3. A NO-OP MUST BE DISTINGUISHABLE FROM A CUT ────────────────────────
//
// `{ materials: 0, geometries: 0 }` meant both *"off, correctly"* and *"on, and
// it reached nothing"*. `report()` now carries `wanted`, `on` and a `reason`,
// so the caller that asks can tell them apart — and `tests/e2e/xr-vrto3d-trace.spec.ts`
// refuses to record a trace for an arm that reports `wanted` without `on`.

/**
 * The RAW colours of every geometry this module has baked.
 *
 * A `WeakMap` and not `geometry.userData`: `userData` is serialised by
 * `toJSON`, and a second copy of every terrain chunk's colour buffer in a
 * scene dump is not something to leave lying around. It is also what makes the
 * bake REVERSIBLE, which is what an A/B needs — arm B restores from here rather
 * than recomputing an inverse, so a float that saturated cannot drift.
 */
const rawColours = new WeakMap<THREE.BufferGeometry, Float32Array>()

/** Why the bake is not on, when something asked for it. */
export type BakedLightReason =
  /** Nothing asked for it. Not a failure. */
  | 'not-wanted'
  /** Asked for, and there is no directional light in the scene to bake. */
  | 'no-sun'
  /** Asked for, resolved, and no terrain has registered a material yet. */
  | 'no-terrain'

export interface BakedLightReport {
  /** The INTENT — what the preset or the console asked for. */
  readonly wanted: boolean
  /** Whether the bake is actually live: wanted AND resolved AND applied. */
  readonly on: boolean
  /** Why not, when `wanted` and not `on`. `null` when `on`. */
  readonly reason: BakedLightReason | null
  readonly define: string
  /**
   * The rung the INTENT asks for — 1 keeps the shadow multiply, 3 drops it.
   * DEV-237.
   */
  readonly rung: BakedLightRung
  /**
   * The rung the registered materials are actually carrying, read back off
   * their defines rather than from the intent.
   *
   * `null` when no material is registered. It disagrees with `rung` only
   * between `setRung` and the next `refresh`, and a measurement arm that reads
   * these two apart is reading a flag that has not been pushed — which is
   * exactly the shape DEV-232 §10b lost an A/B to.
   */
  readonly liveRung: BakedLightRung | null
  /**
   * The baked-light defines standing on the registered materials right now,
   * in three's own insertion order.
   *
   * The mechanism check, as a thing a harness can print rather than a thing a
   * document asks it to remember: an arm that did not fire has an empty list
   * here and cannot be mistaken for one that did.
   */
  readonly defines: readonly string[]
  /**
   * Chunk geometries currently holding a baked colour buffer.
   *
   * **Live, not cumulative** (DEV-240): `refresh` re-counts it from the scene
   * traversal, so a chunk whose LOD changed and whose geometry was replaced
   * stops being counted rather than staying on the books for ever. Between
   * refreshes `offer` still adds to it, which is what makes a mid-flight chunk
   * visible before the next refresh.
   */
  readonly baked: number
  /**
   * Vertices across those geometries. DEV-240, and it exists to be MEASURED
   * rather than estimated: the split rung's cost is one `vec3` per vertex and
   * the only honest way to price it is to count the vertices the game actually
   * built, which is a function of the environment, the LOD ladder and the
   * detail ring rather than of anything a document can carry.
   */
  readonly vertices: number
  /**
   * What {@link vertices} costs in the split rung — `vertices * 3 * 4`, and
   * **zero at every other rung**, because the attribute is deleted the moment
   * the rung moves off `'split'`. A number the photo spec and the trace can
   * print without doing arithmetic on a report.
   */
  readonly directBytes: number
  /** Materials registered by `applyTo`. */
  readonly materials: number
  /**
   * Geometries OFFERED by the build hook that the last refresh could not use —
   * a colour and a normal attribute that disagree about the vertex count.
   *
   * Should be zero forever. A non-zero here is the alarm that something other
   * than a terrain chunk reached `offer()`, which is the defect that produced
   * the 6384/4788 throw.
   */
  readonly refusals: number
}

export interface BakedLight {
  /** Patch one material so it carries the gate, and register it. Idempotent. */
  applyTo(material: THREE.Material): void
  /**
   * Register a root to sweep — a terrain's `group`.
   *
   * Registered at the call site that HAS it, never fetched from a shared
   * variable: the first version read `liveTerrain`, which is assigned 902 lines
   * after the place the define had to land.
   */
  addRoot(root: THREE.Object3D): void
  /**
   * Offer a freshly built chunk geometry. The ONLY door into this module's
   * scope — see note 1 above. Bakes it immediately if the bake is live, so a
   * chunk that streams in mid-flight arrives baked rather than drawing raw
   * albedo unlit until the next refresh.
   */
  offer(geometry: THREE.BufferGeometry): void
  /** The INTENT. Nothing else may change it. */
  setEnabled(on: boolean): void
  /**
   * The other half of the intent: which rung. DEV-237.
   *
   * Separate from `setEnabled` because the two are asked by different routes —
   * `VRTO3D_FLAGS_ON` flips `enabled` through the Edition page and carries the
   * rung over from the preset (`block[b] = { ...target, enabled }` spreads
   * everything else), so an A/B that wants the other rung selects it at load
   * with `?bakedRung=` or within the run through `__ff2.bakedLight(on, rung)`.
   *
   * Stores intent only, like `setEnabled`; nothing is pushed until `refresh`.
   */
  setRung(rung: BakedLightRung): void
  /**
   * Re-resolve the model from `scene` and push both halves — the define on
   * every registered material, the colours in every offered geometry still in
   * a registered root — then report what is actually true.
   */
  refresh(scene: THREE.Object3D | null): BakedLightReport
  /** What is true now, without moving anything. */
  report(): BakedLightReport
  /**
   * Called after a `refresh` that CHANGED what the geometries hold: the bake
   * went on or off, the rung moved, or the sun or the sky probe changed.
   * DEV-904. A `BatchedMesh` holds its own copy of the chunk vertices, so the
   * terrain's batches have to be rebuilt when the colours (and `ff2Direct`,
   * which comes and goes with the split rung) are rewritten in place.
   *
   * Not called for a refresh that rewrote identical values, which is most of
   * them: the edition's subscribers fire on any setting.
   * Returns the unsubscribe.
   */
  onChange(listener: () => void): () => void
  /** Drop the roots and materials of a world being torn down. */
  reset(): void
}

export const createBakedLight = (): BakedLight => {
  let wanted = false
  /** DEV-237. Intent, like `wanted`; 3 is the rung DEV-232 measured. */
  let rung: BakedLightRung = 3
  let model: BakedLightModel | null = null
  let baked = 0
  /** Vertices held across every baked geometry — the split rung's VRAM. */
  let vertices = 0
  let refusals = 0
  const roots = new Set<THREE.Object3D>()
  const materials = new Set<THREE.Material>()
  /** DEV-904: who wants to know the bake's state moved. */
  const listeners = new Set<() => void>()
  let lastChangeKey = ''
  /** Scope. Only what the chunk-build hook handed us — note 1 above. */
  const offered = new WeakSet<THREE.BufferGeometry>()

  /** Bake or un-bake one geometry. `false` when it did not move. */
  const applyToGeometry = (geometry: THREE.BufferGeometry): boolean => {
    const colour = geometry.getAttribute('color')
    if (!colour || !(colour.array instanceof Float32Array)) return false
    const normals = geometry.getAttribute('normal')
    if (!normals || !(normals.array instanceof Float32Array)) return false
    // The shape guard, and it compares COUNTS rather than array lengths —
    // which is what the first version got wrong. A vec4 colour beside a vec3
    // normal has equal counts and unequal lengths, so a length comparison
    // reads a perfectly ordinary glTF mesh as corrupt and throws on it.
    // With `offered` doing the scoping this should be unreachable; it is kept
    // because "unreachable" is a claim and `refusals` is how it is checked.
    if (colour.itemSize !== 3 || normals.itemSize !== 3 || colour.count !== normals.count) {
      refusals++
      return false
    }
    const live = colour.array
    const raw = rawColours.get(geometry)
    if (model === null || !wanted) {
      if (!raw) return false
      live.set(raw)
      rawColours.delete(geometry)
      geometry.deleteAttribute(DIRECT_ATTRIBUTE)
      baked = Math.max(0, baked - 1)
      vertices = Math.max(0, vertices - colour.count)
      colour.needsUpdate = true
      return true
    }
    let source = raw
    if (!source) {
      source = live.slice()
      rawColours.set(geometry, source)
      baked++
      vertices += colour.count
    }
    // ── the split rung's second buffer (DEV-240) ─────────────────────────
    //
    // Allocated HERE and nowhere else, and deleted the moment the rung moves
    // off `'split'`, so the 12 bytes a vertex are paid by the arm that asked
    // for them and by no other. The attribute and the define are written in
    // the same call for the reason `installBakedLight`'s note gives: a program
    // that declares the attribute and meets a geometry without one reads the
    // generic vertex attribute rather than failing.
    if (rung === 'split') {
      const existing = geometry.getAttribute(DIRECT_ATTRIBUTE)
      const directArray =
        existing && existing.array instanceof Float32Array && existing.count === colour.count
          ? existing.array
          : new Float32Array(source.length)
      bakeVertexColoursSplit(source, normals.array, model, live, directArray)
      if (existing && existing.array === directArray) {
        existing.needsUpdate = true
      } else {
        geometry.setAttribute(DIRECT_ATTRIBUTE, new THREE.BufferAttribute(directArray, 3))
      }
    } else {
      geometry.deleteAttribute(DIRECT_ATTRIBUTE)
      bakeVertexColours(source, normals.array, model, live)
    }
    colour.needsUpdate = true
    return true
  }

  const reasonNow = (): BakedLightReason | null => {
    if (!wanted) return 'not-wanted'
    if (model === null) return 'no-sun'
    if (materials.size === 0) return 'no-terrain'
    return null
  }

  /**
   * What the MATERIALS say, as against what the intent says. DEV-237.
   *
   * Read back rather than mirrored, because the only failure this module has
   * ever actually had was an intent that never reached anything (§10b) — and a
   * report that echoes the intent cannot see that by construction.
   */
  const liveState = (): { rung: BakedLightRung | null; defines: string[] } => {
    const rungs = new Set<BakedLightRung>()
    const names = new Set<string>()
    for (const m of materials) {
      rungs.add(bakedRungOf(m))
      for (const name of Object.keys(m.defines ?? {})) {
        // The list of names is a LIST and not a pair, because DEV-240 added a
        // third and the first version of it forgot this line — the photo spec
        // printed `defines=[FF2_BAKED_LIGHT]` for an arm that was demonstrably
        // running the split shader. That is the mechanism check lying in the
        // quiet direction: `liveRung` said `split` and the line a reader of the
        // trace would believe said otherwise.
        if (BAKED_DEFINES.includes(name)) names.add(name)
      }
    }
    // `null` when the registered materials do not AGREE as well as when there
    // are none — `materials` tells those apart. `refresh` writes every one of
    // them in one call, so a disagreement means something outside this module
    // has written the defines, and a report that averaged it away would be the
    // quiet failure §10 above is entirely about.
    //
    // `names` is insertion-ordered, which is the order three hashes them in
    // (DEV-194), so the list reads as the key's own tail rather than as a set.
    return {
      rung: rungs.size === 1 ? ([...rungs][0] as BakedLightRung) : null,
      defines: [...names],
    }
  }

  const report = (): BakedLightReport => {
    const reason = reasonNow()
    const live = liveState()
    return {
      wanted,
      on: wanted && reason === null && baked > 0,
      // `on` also requires a baked buffer, so a define with nothing behind it
      // reports `no-terrain` rather than success. That is the distinction the
      // A/B needed and did not have.
      reason: wanted && !(reason === null && baked > 0) ? (reason ?? 'no-terrain') : null,
      define: BAKED_LIGHT_DEFINE,
      rung,
      liveRung: live.rung,
      defines: live.defines,
      baked,
      vertices,
      directBytes: rung === 'split' ? vertices * 3 * 4 : 0,
      materials: materials.size,
      refusals,
    }
  }

  return {
    applyTo(material) {
      installBakedLight(material)
      materials.add(material)
    },

    addRoot(root) {
      roots.add(root)
    },

    offer(geometry) {
      offered.add(geometry)
      applyToGeometry(geometry)
    },

    setEnabled(on) {
      wanted = on
    },

    setRung(next) {
      rung = next
    },

    refresh(scene) {
      refusals = 0
      // Re-resolved EVERY time, never cached: a course swap rebuilds the sun,
      // and a world left baked under the previous mission's light is a bug that
      // only appears on the second level somebody loads.
      model = wanted && scene ? bakedLightModelOf(scene) : null
      const live = wanted && model !== null
      // Both halves of the intent in ONE call, so the two defines are written
      // in one fixed order however the rung got here (DEV-194, DEV-237).
      for (const m of materials) setBakedLight(m, live, rung)
      // ── COUNTED from the traversal, not accumulated (DEV-240) ──────────
      //
      // `applyToGeometry` increments when it first bakes a geometry and
      // decrements when it un-bakes one, which is right for `offer`'s path and
      // wrong over a flight: a chunk whose LOD changes has its geometry
      // REPLACED and disposed, and the replaced one is never un-baked because
      // it is no longer in the scene to be walked. Accumulated, the count then
      // only ever rises and `directBytes` quotes VRAM for buffers that were
      // freed with their geometries. Re-counted here it is what is live now,
      // which is the only reading worth printing beside a rung.
      const seen = new Set<THREE.BufferGeometry>()
      let liveBaked = 0
      let liveVertices = 0
      for (const root of roots) {
        root.traverse((object) => {
          const mesh = object as THREE.Mesh
          // `offered` is the scope. Everything else under this root — the
          // scatter, the landmarks, the fracture pieces, the dressing — is
          // somebody else's geometry and must not be touched.
          if (mesh.isMesh && mesh.geometry && offered.has(mesh.geometry)) {
            applyToGeometry(mesh.geometry)
            // A geometry can hang under two roots, and a `Set` is cheaper than
            // an argument about whether it can.
            if (!seen.has(mesh.geometry) && rawColours.has(mesh.geometry)) {
              seen.add(mesh.geometry)
              liveBaked++
              liveVertices += mesh.geometry.getAttribute('color')?.count ?? 0
            }
          }
        })
      }
      baked = liveBaked
      vertices = liveVertices
      // DEV-904: tell the batches, but only when the bake's STATE moved. The key
      // is everything `applyToGeometry` reads: whether it is live, the rung and
      // the model. A refresh that wrote the same numbers over the same numbers
      // leaves every batch's copy exactly right.
      const key = live ? `${rung}|${JSON.stringify(model)}` : 'off'
      if (key !== lastChangeKey) {
        lastChangeKey = key
        for (const listener of [...listeners]) listener()
      }
      return report()
    },

    report,

    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    reset() {
      roots.clear()
      materials.clear()
      baked = 0
      vertices = 0
      refusals = 0
      lastChangeKey = ''
    },
  }
}

export interface BakedLightEditionState {
  readonly current: {
    readonly terrain: {
      readonly bakedLight: { readonly enabled: boolean; readonly rung: BakedLightRung }
    }
  }
  subscribe(listener: () => void): () => void
}

/**
 * Wire the INTENT to the live preset, and ask for a refresh. Returns the
 * unsubscribe.
 *
 * It pushes the flag and calls `onRefresh`; it does NOT resolve the model
 * itself. That separation is note 2 above: `VRTO3D_FLAGS_ON` flips as soon as
 * `__ff2.edition` exists, which is before the world is built, so a resolution
 * taken here would be taken against a scene with no terrain in it — and the
 * first version then had nothing that ever tried again.
 */
export const attachEditionBakedLight = (
  target: Pick<BakedLight, 'setEnabled' | 'setRung'>,
  editionState: BakedLightEditionState,
  onRefresh: () => void,
  /**
   * `?bakedRung=`, DEV-237 — a PIN over the preset's rung, the shape
   * `?ocean=` already has. `null` on every ordinary load.
   *
   * It exists because `VRTO3D_FLAGS_ON` cannot reach the rung: the spec's flip
   * is `block[b] = { ...target, enabled }`, which spreads every other field of
   * the block straight through from the preset. So the flag says *bake* and
   * the pin says *which rung*, and the two arms of DEV-237's A/B are two loads
   * that differ by one query parameter rather than by a build.
   */
  rungPin: BakedLightRung | null = null,
): (() => void) => {
  const push = (): void => {
    target.setEnabled(editionState.current.terrain.bakedLight.enabled)
    target.setRung(rungPin ?? editionState.current.terrain.bakedLight.rung)
    onRefresh()
  }
  push()
  return editionState.subscribe(push)
}
