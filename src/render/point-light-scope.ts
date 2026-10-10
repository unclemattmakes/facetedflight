// src/render/point-light-scope.ts — the cabin's two lamps stop being evaluated
// on every fragment of the world. DEV-192.
//
// ── The arithmetic the whole world was doing, and its answer ──────────────
//
// `render/cockpit-interior.ts` puts two `THREE.PointLight`s in the mission
// scene to light a dashboard (DEV-088). three has **no per-object light
// scoping**: `NUM_POINT_LIGHTS` is a `#define` on every lit material in the
// frame, so the island, the sea, the props, the rings, the racers and the
// start grid each run two `RE_Direct_Physical` evaluations — GGX, Smith,
// Fresnel, a Lambert — per fragment, for a lamp inside a sealed canopy.
//
// **The contribution outside the cabin is not small. It is zero.** From three's
// own `lights_pars_begin.glsl.js:120`, `getDistanceAttenuation` multiplies by
//
//     pow2( saturate( 1.0 - pow4( lightDistance / cutoffDistance ) ) )
//
// whenever `cutoffDistance > 0`, and both lamps carry one — `distance` **3**
// (fill) and **1.8** (dash), `decay: 2`, in `content/editions/anniversary.json`.
// Past the cutoff `saturate` returns 0 and the term is the number zero. The
// next line sets `light.visible = ( light.color != vec3( 0.0 ) )` — **and
// `RE_Direct` never reads it.** `lights_fragment_begin.glsl.js:77` calls
// `RE_Direct( directLight, … )` unconditionally; `directLight.visible` is
// consulted only inside the `USE_SHADOWMAP && UNROLLED_LOOP_INDEX <
// NUM_POINT_LIGHT_SHADOWS` branch, to pick a shadow factor. There is no
// early-out. The full BRDF runs and is multiplied by nothing.
//
// Measured by DEV-191, twice, on a quiet box: **−0.38 ms at one worn eye on the
// LAND ALONE** — 60 % of the terrain's entire fragment stack, and the largest
// remaining item in it. The sea, the props, the racers, the rings and the start
// grid pay the same toll on their own fragments.
//
// ── Why this is a CUT and not a trade ─────────────────────────────────────
//
// Since DEV-186 the lamps are in the count *unconditionally*, in third person
// as well as first: that row made them stay in the scene at zero intensity
// rather than leave it, because taking `numPointLights` 2 → 0 bumps
// `WebGLLights.state.version` and recompiles every lit material — measured at
// **15 programs on one press of V**. That trade removed a compile storm and
// nobody priced the steady cost at the worn pixel count.
//
// This module takes the cost without touching the count. The lamps stay in the
// scene, `numPointLights` stays 2, no program key moves when the view flips —
// and the loop is simply not in the world's shaders.
//
// ── Where the lamps DO reach, which is the only thing to be careful about ──
//
// The exemption is **the ship**, and it is one subtree rather than a list
// because the lamps hang off `art_pivot` AT THE EYE: the cockpit shell, the
// cabin body and the exterior hull are all under that node, and the dash
// instruments (`render/next-gate-arrow.ts`, 0.82 m from the eye) are under the
// ship group beside it. `boot/app.ts` names the root it exempts and says so.
//
// Everything else in a mission is outside a sealed canopy. Where a lamp DID
// reach something out there — the pad under the skids at the start, the shaft
// wall on the ride — that is light leaking through a fuselage, so the cut is
// free where the lamps were doing nothing and a correction where they were not.
// DEV-192 §3 has the photographs of both.
//
// ── Why the TEXT and not a `#define` ──────────────────────────────────────
//
// `render/fragment-gates.ts` sets `FF2_NO_POINT_LIGHTS` in `material.defines`,
// which is right for an INSTRUMENT: it flips on a live page and three hashes
// `defines` into the program cache key, so an arm is one compile and then free.
//
// It is wrong for a PERMANENT cut, and three's own `Material.copy` is why.
// `MeshStandardMaterial.copy` (three 0.185.1, `MeshStandardMaterial.js:412`)
// does `this.defines = { 'STANDARD': '' }` and `MeshPhysicalMaterial.copy`
// (`:522`) the same — a clone does not merely fail to carry a define, it
// **wipes it**. This renderer clones lit materials in three places on purpose:
// `render/lod-fade.ts`'s pooled fade clones, `render/water.ts`'s per-LOD bands,
// and `render/prop-fracture.ts`'s pieces. Every one of them would have silently
// come back with the loop in and a program of its own — which is DEV-177's
// 200 ms break frame arriving a second time by the same door.
//
// What a clone DOES carry, because this repo makes it carry it, is the
// delegation: each of those three sites forwards `onBeforeCompile` and
// `customProgramCacheKey` back to the base material. So a cut that lives in the
// shader TEXT travels to every clone for free, and a cut that lives in a define
// does not. The rewrite below is therefore the text.
//
// The statement it rewrites is imported from `fragment-gates.ts` rather than
// spelled a second time, so **the shipped cut is the priced cut** —
// `tests/unit/point-light-scope.test.ts` proves the two produce byte-identical
// preprocessed GLSL through a preprocessor neither of them wrote.

import * as THREE from 'three'
import { POINT_LIGHT_IF } from './fragment-gates'
import { chainShaderPatch } from './program-cache-key'

/**
 * What happened to one material.
 *
 * `'unlit'` is not a failure and it is not a silence: a material with no
 * direct-lighting stack cannot pay for a point light, because three's own
 * `#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )` has already removed
 * the loop for it. The distinction that matters is between THAT and *"this
 * material has lighting and the cut did not land"*, which throws — a no-op
 * wearing a feature's clothes is the failure this family of files keeps paying
 * for (DEV-069, and `gateFragmentShader`'s own throws).
 */
export type PointLightScope = 'cut' | 'unlit'

/** What the opening `#if` becomes. The `#endif` below it is left alone. */
export const POINT_LIGHT_CUT = '#if 0 // FF2_NO_POINT_LIGHTS — DEV-192, the cabin lamps'

/**
 * Markers that say a fragment shader HAS a direct-lighting stack, checked when
 * the anchor is missing.
 *
 * `meshbasic.glsl.js` contains none of these and the three lit shaders
 * (`meshphysical`, `meshlambert`, `meshphong`) contain all of them — verified
 * against three 0.185.1's own `ShaderLib` in the unit test, rather than against
 * a list of material types kept here by hand.
 */
const LIT_MARKERS = [
  '#include <lights_pars_begin>',
  '#include <lights_fragment_begin>',
  'NUM_POINT_LIGHTS',
] as const

/**
 * Take the point-light loop out of one fragment shader. Pure, and idempotent.
 *
 * Handles the three shapes the anchor arrives in, because which one it is
 * depends on what else has patched the material first:
 *
 *  - the bare statement, when `far-shadow.ts` has expanded
 *    `#include <lights_fragment_begin>` into the text;
 *  - the statement with `fragment-gates.ts`'s ` && ! defined(
 *    FF2_NO_POINT_LIGHTS )` already appended, when the gates ran first;
 *  - the include, unexpanded, when neither has.
 *
 * The whole LINE is replaced, which is what makes the first two one case.
 */
export const cutPointLights = (source: string): { text: string; scope: PointLightScope } => {
  let text = source
  if (text.includes(POINT_LIGHT_CUT)) return { text, scope: 'cut' }

  if (!text.includes(POINT_LIGHT_IF)) {
    // Not expanded yet: expand the include here, cut, and let whoever comes
    // after us see the chunk rather than the directive.
    const include = '#include <lights_fragment_begin>'
    if (!text.includes(include)) {
      // No anchor at all. Either there is nothing to cut, or somebody has
      // rewritten the lighting into a shape this file does not know — and the
      // difference is the whole point of the markers.
      const marker = LIT_MARKERS.find((m) => text.includes(m))
      if (marker !== undefined) {
        throw new Error(
          `point-light-scope: this shader has lighting ("${marker}") but neither ` +
            `"${POINT_LIGHT_IF}" nor "${include}". Another patch has rewritten the ` +
            'point-light loop into a shape this file does not know, and the cut did not land.',
        )
      }
      return { text, scope: 'unlit' }
    }
    const chunk = THREE.ShaderChunk.lights_fragment_begin
    if (!chunk.includes(POINT_LIGHT_IF)) {
      throw new Error(
        `point-light-scope: three's lights_fragment_begin no longer contains ` +
          `"${POINT_LIGHT_IF}". Re-read node_modules/three/src/renderers/shaders/ShaderChunk/ ` +
          'and update this file (and render/fragment-gates.ts, which shares the string).',
      )
    }
    // A FUNCTION replacement, not a string one: `String.replace` reads `$&`
    // and friends out of a replacement string, and the thing being spliced in
    // here is three's source rather than ours.
    text = text.replace(include, () => chunk)
  }

  // The whole line, from the anchor to the end of it. `fragment-gates.ts` may
  // have appended its own ` && ! defined( … )`, and that suffix has to go with
  // the statement rather than be left dangling after `#if 0`.
  const start = text.indexOf(POINT_LIGHT_IF)
  const eol = text.indexOf('\n', start)
  text = text.slice(0, start) + POINT_LIGHT_CUT + (eol === -1 ? '' : text.slice(eol))

  // The assertion the throws above cannot make: the cut is in the OUTPUT, and
  // the statement it replaced is gone.
  if (!text.includes(POINT_LIGHT_CUT) || text.includes(POINT_LIGHT_IF)) {
    throw new Error('point-light-scope: the cut did not land in the patched shader.')
  }
  return { text, scope: 'cut' }
}

/** Materials this module has patched, so installing twice is a no-op. */
const installed = new WeakSet<THREE.Material>()
/** What the patch DID, once the material has compiled. */
const scopes = new WeakMap<THREE.Material, PointLightScope>()

/**
 * Cut the point-light loop out of one material, permanently.
 *
 * **Install this LAST**, after every other `onBeforeCompile` — an
 * `onBeforeCompile` chain runs in install order, and this one has to see
 * `far-shadow.ts`'s expansion of `lights_fragment_begin` and
 * `fragment-gates.ts`'s rewrite of the `#if` rather than have either of them
 * arrive afterwards and find a statement this file has already replaced.
 * `boot/app.ts` sweeps the built world for exactly that reason.
 */
export const scopePointLights = (material: THREE.Material): void => {
  chainShaderPatch(
    material,
    {
      tag: 'point-light-scope',
      // Records the scope it cut, per material, so it is not a pure text map.
      after: (shader) => {
        const cut = cutPointLights(shader.fragmentShader)
        shader.fragmentShader = cut.text
        scopes.set(material, cut.scope)
      },
    },
    installed,
  )
}

/** Clones that get the cut through somebody else's `onBeforeCompile`. */
const inherits = new WeakMap<THREE.Material, THREE.Material>()

/**
 * Record that `clone` gets its cut through `base`'s `onBeforeCompile`.
 *
 * **Call this next to the delegation, and never anywhere else.** The three
 * clone factories in this renderer — `lod-fade.ts`'s pooled fade clones,
 * `water.ts`'s per-LOD bands and `prop-fracture.ts`'s pieces — all set
 * `clone.onBeforeCompile = (shader, renderer) => base.onBeforeCompile.call(base,
 * …)`, reading the base's hook AT CALL TIME rather than capturing it, which is
 * exactly so that patches installed on the base afterwards are in the clone
 * too. So the cut really does reach them and there is nothing to install.
 *
 * What there IS to do is say so, and the reason is not bookkeeping for its own
 * sake: `scopePointLights(clone)` would **cost a program**. A band clone's
 * `customProgramCacheKey` delegates to the base's precisely so that N facet
 * sizes are N materials and ONE program (`water.ts`); tagging the clone a
 * second time would give it a key of its own and compile the sea again. The
 * first run of `tests/e2e/point-light-scope.spec.ts` reported
 * `world-ocean/chunk_1_1` as a miss for exactly this reason, and it was not
 * one — the shader was cut and the WeakSet did not know.
 *
 * `tests/unit/point-light-scope.test.ts` greps `src/render/` for the next
 * `onBeforeCompile.call(` that forgets this, the way
 * `program-cache-key.test.ts` greps for an untagged patch.
 */
export const inheritPointLightScope = (clone: THREE.Material, base: THREE.Material): void => {
  inherits.set(clone, base)
}

/**
 * Whether the cut reaches `material` — directly, or through the base a clone
 * delegates to.
 *
 * **Resolved rather than recorded**, and `?pointLights=keep` is why. The first
 * version wrote the clone into the same `WeakSet` as a patched material, which
 * is true whenever the base was swept and a lie whenever it was not — so the A
 * arm of the photograph, the one load where nothing is cut, reported one
 * material as cut. An instrument that cannot be switched off honestly is not an
 * instrument, and the same lie would have been told by any future load that
 * built a clone before the sweep reached its base.
 */
export const isPointLightScoped = (material: THREE.Material): boolean => {
  if (installed.has(material)) return true
  const base = inherits.get(material)
  return base !== undefined && installed.has(base)
}

/**
 * What the patch did to `material`, or `undefined` if it has not compiled yet.
 * Read by `__ff2.pointLightScope()` so a spec can see an `'unlit'` classification
 * rather than have it be silent.
 *
 * A clone answers with its base's result, because the base's patch is the one
 * that ran — and it HAS run by the time anyone can ask, since the clone cannot
 * have compiled without calling it.
 */
export const pointLightScopeOf = (material: THREE.Material): PointLightScope | undefined => {
  const own = scopes.get(material)
  if (own !== undefined) return own
  const base = inherits.get(material)
  return base ? scopes.get(base) : undefined
}

/** Every material hanging off a mesh under `root`, deduplicated, in order. */
const materialsUnder = (
  root: THREE.Object3D,
  skip: ReadonlySet<THREE.Object3D> = new Set(),
): Set<THREE.Material> => {
  const seen = new Set<THREE.Material>()
  const walk = (object: THREE.Object3D): void => {
    if (skip.has(object)) return
    const mesh = object as THREE.Mesh
    if (mesh.material) {
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (m) seen.add(m)
      }
    }
    for (const child of object.children) walk(child)
  }
  walk(root)
  return seen
}

/**
 * Cut the point-light loop out of every material the world draws, leaving the
 * subtrees in `exempt` alone.
 *
 * A sweep rather than a call at each material's birth, and the reason is
 * ORDER: this patch must run after `far-shadow.ts` and after
 * `fragment-gates.ts`, and those are installed from seven different places
 * across a world build. One pass at the end is the only place that is reliably
 * last. `boot/app.ts` runs it before `warmWorld` so the programs the warm draw
 * builds are the programs the flight uses (DEV-117).
 *
 * Idempotent, so a course swap can simply run it again.
 */
export const scopeWorldPointLights = (
  root: THREE.Object3D,
  exempt: readonly THREE.Object3D[],
): { scoped: number; already: number; exempt: number } => {
  // ── the exemption is a MATERIAL set, not a subtree ────────────────────
  //
  // Skipping the cabin's branch of the walk is not enough on its own: a
  // material is shared, so one that happens to be on a cabin mesh AND on
  // something out in the world would be reached by the other path and cut —
  // and the cabin would lose the lamps that are the whole reason this
  // exemption exists, silently, from a change made somewhere else entirely.
  // Nothing shares today (the cockpit shell is its own `lambert1` and the four
  // cabin-body materials are first-party), which is exactly when to write the
  // guard: it costs one `Set` and it cannot be true-by-luck later.
  const keep = new Set<THREE.Material>()
  for (const node of exempt) for (const m of materialsUnder(node)) keep.add(m)
  const materials = materialsUnder(root, new Set(exempt))
  let scoped = 0
  let already = 0
  for (const m of materials) {
    if (keep.has(m)) continue
    // A delegating clone is skipped whether or not its base has been swept
    // yet: its cut follows the base's by construction, and patching it here
    // would give it a program cache key of its own — which is the one thing
    // `water.ts` and `prop-fracture.ts` delegate that key to avoid.
    const base = inherits.get(m)
    if (base !== undefined) {
      // The cut reaches a clone through its base, so a base that hangs off
      // NO mesh (the sea's material once the rings draw it instead of the
      // plate's chunks, DEV-339) is never walked and the clone's cut would
      // never arrive. Sweep the base itself, once, through the clone.
      if (!installed.has(base) && !keep.has(base)) {
        scopePointLights(base)
        scoped++
      } else already++
      continue
    }
    if (installed.has(m)) {
      already++
      continue
    }
    scopePointLights(m)
    scoped++
  }
  return { scoped, already, exempt: keep.size }
}
