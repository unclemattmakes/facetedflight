// src/render/eye-dither.ts: a screen-space dither is seeded from the EYE's
// pixel, not the framebuffer's. DEV-556.
//
// ── The bug ──────────────────────────────────────────────────────────────
//
// Two things in this renderer rotate or threshold by interleaved gradient
// noise (Jimenez 2014) of the window coordinate, `gl_FragCoord.xy`:
//
//   * three r185's PCF shadow, which spins its five Vogel-disk taps by
//     `interleavedGradientNoise( gl_FragCoord.xy )` (`shadowmap_pars_fragment`,
//     the directional and the point paths), and
//   * the terrain's LOD cross-fade (`render/lod-fade.ts`), whose screen-door
//     keeps a fragment where the same noise is below the coverage.
//
// In a WebXR session both eyes draw side by side into ONE framebuffer, so the
// right eye's window x is the left eye's plus one eye width. The noise is not
// periodic in that width (`0.06711056 x 800` has a fractional part), so the
// same surface point gets a different rotation, and a different screen-door,
// in each eye. With the eyes in one place (IPD 0) the two halves must match
// (`tests/e2e/stereo-parity.spec.ts` says why that is IWER's geometry and not
// our belief), and the hangar's soft penumbra put an 18,573 px patch in one
// eye only (`docs/testing/EMULATOR-PASS-2026-10-01.md` problem 2). Through
// the lens a speckle that differs per eye is binocular rivalry, which reads as
// shimmer.
//
// ── The fix ──────────────────────────────────────────────────────────────
//
// Seed from `gl_FragCoord.xy - ff2EyeOrigin`, where `ff2EyeOrigin` is the
// lower-left corner of the viewport being drawn, in framebuffer pixels: zero
// for the left eye and for every flat frame, one eye width for the right eye.
// The same surface point then has the same seed in both eyes, bit for bit,
// because the origin is an integer and subtracting it keeps the `.5` of the
// pixel centre exact.
//
// FLAT IS UNCHANGED, BIT FOR BIT, and that is a premise rather than a
// photograph: a flat frame draws into a viewport whose origin is (0, 0)
// (`WebGLRenderer.setViewport` is never called with an offset here, and a
// render target's viewport starts at 0), and `x - 0.0` is `x` in IEEE
// arithmetic. The before/after photographs in DEV-556's row agree with it.
//
// ── Where the origin comes from ──────────────────────────────────────────
//
// three keeps the viewport it is drawing into as `_currentViewport`, sets it
// per eye (`renderScene(…, camera2, camera2.viewport)`) and hands a copy out
// through `getCurrentViewport`. The uniform's VALUE is an object whose `x` and
// `y` are getters on that, so it is read at the moment three uploads the
// uniform, and three uploads a material's uniforms on the first draw after the
// CAMERA changes (`setProgram`: `_currentCamera !== camera` sets
// `refreshMaterial`), which is the first draw of each eye. No per-eye hook, no
// per-frame write.
//
// It survives `UniformsUtils.clone`, which three runs on a ShaderLib entry's
// uniforms when it compiles a material: `cloneUniforms` clones a value only
// when it is a three object (`isVector2` and friends) and copies anything else
// by REFERENCE, so every material's copy reads the same live getters.
// `tests/unit/eye-dither.test.ts` reads that out of three's build.
//
// ── Why a ShaderChunk and not one `onBeforeCompile` per material ─────────
//
// Every lit material that receives a shadow carries the PCF code, through
// three's own `#include <shadowmap_pars_fragment>`: the hangar's floor and
// table, the terrain, the ship, the props, the cockpit. A per-material patch
// would have to find each one and would miss the next one somebody adds.
// `render/skyshop-ibl.ts`'s `useSkyshopLightingModel` is the precedent: one
// chunk, replaced once, before anything compiles. Includes are resolved AFTER
// every `onBeforeCompile` has run, so no patch in the chain can consume this
// one's anchor (the trap in the canopy patch's history).
//
// It needs no `tagProgramCacheKey`, and that is the rule, not an exception to
// it: the tag exists so that two materials whose GLSL DIFFERS cannot share a
// program. This changes every program that includes the chunk in the same
// way, so no two materials differ by it, and the program count cannot move.
// The LOD fade's half rides inside the patch `lod-fade.ts` already tags.
//
// `dithering_pars_fragment` (three's `material.dithering`) is seeded the same
// way and patched the same way, though no material here sets `dithering`
// today: the sweep in the unit test asserts that no chunk is left seeding from
// the window, which is the invariant, rather than a list of today's users.
//
// ── What it cannot fix ───────────────────────────────────────────────────
//
// With the eyes APART the same surface point lands on different eye pixels,
// so its seed still differs between the eyes; that is screen-space noise in
// stereo, and it is a pattern fixed to the screen in each eye rather than one
// eye's pattern sliding against the other's. Only an object-space seed removes
// it, at the cost of aliasing the noise to the surface. Whether the residual
// reads through the lens is worn.

import * as THREE from 'three'

/** The uniform's name in GLSL and in a material's `uniforms`. */
export const EYE_ORIGIN_UNIFORM = 'ff2EyeOrigin'

/**
 * The guard macro. The chunk and the LOD fade can both land in one program
 * (a fading terrain chunk that receives a shadow), and GLSL refuses a uniform
 * declared twice, so each copy is wrapped in this and the first one wins.
 */
export const EYE_PIXEL_GUARD = 'FF2_EYE_PIXEL'

/**
 * The declaration and the helper, guarded. Spliced in by every user; the
 * preprocessor keeps exactly one.
 */
export const EYE_PIXEL_PARS = /* glsl */ `
#ifndef ${EYE_PIXEL_GUARD}
#define ${EYE_PIXEL_GUARD}
// DEV-556: this fragment's pixel within the EYE being drawn. See
// src/render/eye-dither.ts.
uniform vec2 ${EYE_ORIGIN_UNIFORM};
vec2 ff2EyePixel() { return gl_FragCoord.xy - ${EYE_ORIGIN_UNIFORM}; }
#endif
`

/** What three seeds from, and what it is replaced with. */
export const WINDOW_SEED = 'gl_FragCoord.xy'
export const EYE_SEED = 'ff2EyePixel()'

/**
 * The chunks this rewrites, each with the line its pars go in front of (the
 * noise function's own declaration, so the uniform sits inside the same
 * `#if` that already gates the noise and is absent wherever the noise is).
 */
export const EYE_DITHER_CHUNKS = {
  shadowmap_pars_fragment: 'float interleavedGradientNoise( vec2 position ) {',
  dithering_pars_fragment: 'vec3 dithering( vec3 color ) {',
} as const

type ChunkName = keyof typeof EYE_DITHER_CHUNKS

/**
 * One chunk, rewritten. Pure, so the test can compose it with the real
 * stock chunk and with `lod-fade.ts`'s patch.
 *
 * **Throws** if the anchor or the window seed is gone: a build that boots
 * with the feature silently lost is the worst outcome (`illustrativeChunk`).
 */
export const eyeDitherChunk = (name: ChunkName, source: string): string => {
  const anchor = EYE_DITHER_CHUNKS[name]
  const at = source.indexOf(anchor)
  if (at < 0 || !source.includes(WINDOW_SEED)) {
    throw new Error(
      `eye-dither: three's ${name} no longer has "${anchor}" or seeds from ${WINDOW_SEED}. ` +
        'Re-read node_modules/three/src/renderers/shaders/ShaderChunk/ and update EYE_DITHER_CHUNKS.',
    )
  }
  const head = source.slice(0, at)
  const tail = source.slice(at).replaceAll(WINDOW_SEED, EYE_SEED)
  return `${head}${EYE_PIXEL_PARS}${tail}`
}

/** The viewport three is drawing into, read at upload time. */
let source: Pick<THREE.WebGLRenderer, 'getCurrentViewport'> | null = null
const scratch = new THREE.Vector4()

const read = (): THREE.Vector4 => {
  if (source) source.getCurrentViewport(scratch)
  else scratch.set(0, 0, 0, 0)
  return scratch
}

/**
 * The uniform's value: NOT a `Vector2`, on purpose. `cloneUniforms` would copy
 * a `Vector2` into every material and freeze it; a plain object is shared by
 * reference, and three's `setValueV2f` reads `.x` and `.y` (and compares them
 * with its per-program cache) at the moment it uploads.
 */
export const eyeOrigin: { readonly x: number; readonly y: number } = {
  get x() {
    return read().x
  },
  get y() {
    return read().y
  },
}

/** The uniform object a material's `uniforms` carries. */
export const eyeOriginUniform = (): { value: typeof eyeOrigin } => ({ value: eyeOrigin })

let installed: Partial<Record<ChunkName, string>> | null = null

/**
 * Rewrite the chunks, give every ShaderLib entry that includes one the
 * uniform, and read the origin from `renderer`. Before the first compile:
 * `render/renderer.ts` calls it beside `new THREE.WebGLRenderer`, and nothing
 * compiles without a renderer. Idempotent; a second call rebinds the source.
 * A `WebGLRenderer` built anywhere else (the editor's island preview) reads
 * THIS renderer's origin, which is zero whenever this one is drawing flat,
 * and the preview is never open in a session.
 */
export const useEyeConsistentDither = (
  renderer: Pick<THREE.WebGLRenderer, 'getCurrentViewport'>,
): void => {
  source = renderer
  if (installed) return
  const originals: Partial<Record<ChunkName, string>> = {}
  for (const name of Object.keys(EYE_DITHER_CHUNKS) as ChunkName[]) {
    originals[name] = THREE.ShaderChunk[name]
    THREE.ShaderChunk[name] = eyeDitherChunk(name, THREE.ShaderChunk[name])
  }
  for (const shader of Object.values(THREE.ShaderLib)) {
    const uses = (Object.keys(EYE_DITHER_CHUNKS) as ChunkName[]).some((name) =>
      shader.fragmentShader.includes(`#include <${name}>`),
    )
    if (uses) shader.uniforms[EYE_ORIGIN_UNIFORM] = eyeOriginUniform()
  }
  installed = originals
}

/** Test seam: the install is a one-shot global, and tests need to undo it. */
export const _resetEyeDitherForTests = (): void => {
  if (installed) {
    for (const [name, text] of Object.entries(installed)) {
      THREE.ShaderChunk[name as ChunkName] = text as string
    }
    for (const shader of Object.values(THREE.ShaderLib)) {
      delete shader.uniforms[EYE_ORIGIN_UNIFORM]
    }
  }
  installed = null
  source = null
}
