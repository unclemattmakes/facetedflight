// src/render/program-cache-key.ts — the other half of `onBeforeCompile`.
//
// Matt, having just fired it up: *"it looks like the terrain is doing the
// animation the ocean should be."* It was. And the flat sea he complained about
// two sessions earlier was the SAME bug, with the coin landing the other way.
//
// ── What three actually caches on ─────────────────────────────────────────
//
// `WebGLPrograms.getProgramCacheKey` builds its key from the shader id, the
// defines, the boolean/numeric parameters, the output colour space, and
// `material.customProgramCacheKey()`. **`onBeforeCompile` is not in that list.**
// It is a callback three invokes once, when it decides to compile — and if the
// key already matches a compiled program, it never decides to.
//
// So two `MeshStandardMaterial`s that differ ONLY in their `onBeforeCompile`
// hash identically and share one program. Whichever compiled first wins, and
// the other silently renders with a shader meant for something else.
//
// ── Why it was intermittent, which is what made it hard ──────────────────
//
// The Simonet islands and the Simonet ocean are both
// `MeshStandardMaterial({vertexColors: true, metalness: 0, side: FrontSide})`
// with `fog = false`. Colour and roughness are UNIFORMS, not defines, so they
// do not enter the key. The two materials therefore hashed the same from the
// day the water landed.
//
// Which one won is decided by `painterSortStable`, which orders opaque draws by
// `material.id` — creation order. The two terrains load under one
// `Promise.all`, so creation order is a genuine race between two async loads.
// Some runs the island's material is made first, compiles a wave-less shader,
// and the SEA is flat. Other runs the ocean wins and the LAND ripples. Nothing
// errors either way, and a screenshot taken on one run disagrees with the same
// screenshot taken on the next.
//
// ── The rule ─────────────────────────────────────────────────────────────
//
// **Every compile hook needs a matching `tagProgramCacheKey`, and the tag must
// name every way the injected source can differ.** A flag that only changes a
// uniform does not belong in the tag; a flag that changes the GLSL text does.
// `chainShaderPatch` (below) is the one door that installs a patch and makes the
// tag impossible to forget: its type requires one. Guarded by
// `tests/unit/program-cache-key.test.ts`, which fails if any file under `src/`
// installs a hook by hand, other than the two named there.
//
// One consequence worth knowing: three's DEFAULT `customProgramCacheKey` is the
// hook's own source text, so a material's key carries the text of the last hook
// chained onto it. Since every patch goes through the one chain function, that
// text is now the same for all of them and the TAGS are the whole difference
// between two patched materials, which is what this file always said they must be.

import type * as THREE from 'three'

/**
 * Add `token` to a material's program cache key, chaining onto whatever is
 * already there.
 *
 * Chained for the same reason `onBeforeCompile` is: the fog patches every
 * terrain material and the water patches one of them, and whichever assigned
 * last would otherwise drop the other's contribution — which is the original
 * bug wearing a different hat.
 */
export const tagProgramCacheKey = (material: THREE.Material, token: string): void => {
  const previous = material.customProgramCacheKey
  material.customProgramCacheKey = function (this: THREE.Material): string {
    return `${previous.call(this)}|${token}`
  }
}

type BeforeCompile = THREE.Material['onBeforeCompile']

/**
 * Chain `hook` onto a material's compile hook: the PREVIOUS hook runs first,
 * then `hook`, and the material is marked dirty so an already-compiled one is
 * re-resolved.
 *
 * This is the one place the chain is written. It does NOT tag the cache key;
 * that is `chainShaderPatch`'s job, and this exists for the site that has to
 * tag somewhere other than beside its hook (`water.ts` computes its token
 * earlier and does work in between). `tests/unit/program-cache-key.test.ts`
 * refuses a file that uses this without also tagging.
 */
export const chainBeforeCompile = (material: THREE.Material, hook: BeforeCompile): void => {
  const previous = material.onBeforeCompile
  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer)
    hook.call(material, shader, renderer)
  }
  material.needsUpdate = true
}

/**
 * One patch to a material's compiled shader. The steps run in the order the
 * fields are listed here, after whatever was chained before: `uniforms`, then
 * `vertex`, then `fragment`, then `after`.
 */
export interface ShaderPatch {
  /**
   * The program-cache-key token, REQUIRED. It must name every way the injected
   * source can differ (see the header): a flag that only moves a uniform does
   * not belong in it, a flag that changes the GLSL text does.
   */
  readonly tag: string
  /**
   * A bag of `IUniform`s, merged into `shader.uniforms`. Read when the shader
   * compiles, not at install. Typed `object` because the callers' bags are
   * interfaces (named fields, no index signature), which a `Record` refuses.
   */
  readonly uniforms?: object
  /** Rewrites the vertex source. */
  readonly vertex?: (source: string) => string
  /** Rewrites the fragment source. */
  readonly fragment?: (source: string) => string
  /**
   * For the bodies that are not a pure text map: one that reads the shader more
   * than once, throws when its anchor moved, records a result, or returns early
   * before touching anything. Runs last, with the shader as the earlier steps
   * left it.
   */
  readonly after?: (
    shader: THREE.WebGLProgramParametersWithUniforms,
    renderer: THREE.WebGLRenderer,
  ) => void
}

/**
 * Install a patch: tag the cache key, chain the hook, mark the material dirty.
 *
 * Returns `false`, and does nothing, when `once` already holds the material.
 * Chaining is NOT idempotent (256 chained copies of one prologue redeclare a
 * varying and fail to compile: `unity-fog.ts`), so a caller whose material can
 * reach it twice passes its own `WeakSet`; one whose material is brand new
 * leaves it out and there is no guard. A material is added to `once` BEFORE
 * anything else happens.
 *
 * It never reorders: each call chains onto whatever is there NOW, so install
 * order stays the call sites' order (`point-light-scope.ts` says "install this
 * last" and means it). The token is added exactly once per install.
 */
export const chainShaderPatch = (
  material: THREE.Material,
  patch: ShaderPatch,
  once?: WeakSet<THREE.Material>,
): boolean => {
  if (once !== undefined) {
    if (once.has(material)) return false
    once.add(material)
  }
  tagProgramCacheKey(material, patch.tag)
  chainBeforeCompile(material, (shader, renderer) => {
    if (patch.uniforms !== undefined) Object.assign(shader.uniforms, patch.uniforms)
    if (patch.vertex !== undefined) shader.vertexShader = patch.vertex(shader.vertexShader)
    if (patch.fragment !== undefined) shader.fragmentShader = patch.fragment(shader.fragmentShader)
    patch.after?.(shader, renderer)
  })
  return true
}

/**
 * `material.fog` — three's own fog flag, which is `parameters.useFog` and
 * therefore **bit 1 of the second `_programLayers` mask in the cache key**.
 *
 * Read and written through here rather than off the material, for three
 * reasons that are all DEV-194:
 *
 *  1. It is a cache-key field that **cannot change a pixel in this build.**
 *     three emits `#define USE_FOG` only for `useFog && fog`, and
 *     `parameters.fog` is the SCENE's fog, which `boot/app.ts` leaves null on
 *     purpose (`unity-fog.ts` explains why at length). So two materials that
 *     differ only in this flag compile **textually identical GLSL** and exist
 *     as two programs anyway. There is no symptom to notice — no missing
 *     feature, no wrong colour — only a doubled program count and a compile
 *     deferred to the first frame that needs the second material. On
 *     `adv_02_hoverJet` that frame cost 318 ms.
 *  2. `@types/three` declares `fog?: boolean` on the base `Material`, so with
 *     `exactOptionalPropertyTypes` every call site needs the same cast twice
 *     over. Once, here, beside the explanation.
 *  3. It belongs with `tagProgramCacheKey` because it is the same subject: what
 *     three hashes, as against what the author thinks matters.
 *
 * `tests/unit/water-fog-flag.test.ts` reads three's own build for the bit
 * positions and the `useFog && fog` conjunction, rather than trusting this
 * comment.
 */
type Foggable = THREE.Material & { fog?: boolean | undefined }

/** Three's fog flag, or `undefined` on a material type that has none. */
export const fogFlag = (material: THREE.Material): boolean | undefined => (material as Foggable).fog

/** Set three's fog flag. See `fogFlag` for why this is not a plain assignment. */
export const setFogFlag = (material: THREE.Material, on: boolean | undefined): void => {
  ;(material as Foggable).fog = on
}

/**
 * Switch ONE define on or off, IN PLACE, and report whether the define SET
 * changed (a name that was added or removed; the callers own `needsUpdate`).
 *
 * The rule this keeps, in one place: three's key walks `defines` in INSERTION
 * order (DEV-194), so a name that leaves and comes back lands at the END, and
 * the object must be edited in place rather than replaced, because
 * `fragment-gates.ts` keys its state on the defines OBJECT (DEV-238) and
 * `cockpit-self-shadow.ts` says the same. Turning a name ON appends it; turning
 * it OFF deletes it, so the survivors keep their order. That is exactly the
 * order `draw-order.ts` used to rebuild into a NEW object ("everything not
 * ours, in the order it was already in, then ours"), and the order
 * `{ ...defines, NAME: '' }` gave `far-shadow.ts`, minus the replaced object.
 *
 * A name already on stays where it is (its value is set to `''`).
 */
export const setDefineInPlace = (material: THREE.Material, name: string, on: boolean): boolean => {
  const has = material.defines !== undefined && Object.hasOwn(material.defines, name)
  if (on) {
    material.defines ??= {}
    material.defines[name] = ''
    return !has
  }
  if (!has) return false
  delete (material.defines as Record<string, unknown>)[name]
  return true
}
