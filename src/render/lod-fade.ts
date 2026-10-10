// src/render/lod-fade.ts — a chunk changes LOD over time, not in one frame. DEV-130.
//
// Matt: *"the terrain lod-popping is very noticeable — i'd like to smooth that
// out."*
//
// ── What 2016 did, exactly ───────────────────────────────────────────────
//
// `FacetedTerrain.cs` has the whole mechanism: a `LODTransitionTime`
// (`terrain.<env>.<terrain>.lodTransitionTime` on the sheet — 1 s on Simonet's
// islands, 0.6 s on its ocean, four times the 0.25 code default), a
// `TerrainAlphaMaterial`, and a state machine (`:209-357`) that fades the
// target LOD IN over the first half by writing `_Color.a` through a
// `MaterialPropertyBlock`, then fades the previous LOD OUT over the second
// half. It is a cross-fade, authored per environment.
//
// It never blended a pixel. On the shipped Simonet prefab
// (`LevelArt_SimonetIslands.prefab#114000011401087442`) `TerrainAlphaMaterial`
// is **the same material as `TerrainMaterial`** — guid `39267bdc…`, `Faceted
// Terrain_SimonetIslands.mat` — and its shader, `Marmoset Specular IBL`, is
// `Queue=Geometry`, `RenderType=Opaque`, no `Blend`, no `alpha` on its surface
// pragma, `MARMO_PREMULT_ALPHA` commented out. Alpine's and desert's dedicated
// `… Alpha.mat` files point at the SAME opaque shader. So `_Color.a` went into
// `OUT.Alpha` and out the other side: for one second both LODs drew opaque on
// top of each other, then the old one switched off. **Classic pops, and that is
// faithful** — the video at 0:55 and 13:20 shows the far LODs coarse and hard.
//
// ── What this does ───────────────────────────────────────────────────────
//
// The cross-fade 2016 authored, as a SCREEN-DOOR: both meshes are drawn for
// the transition, and each fragment keeps exactly one of them. The incoming
// mesh discards where an interleaved-gradient dither is ABOVE the coverage `t`,
// the outgoing mesh discards where it is BELOW, so the two are complementary —
// no blending, no sorting, no depth fight between two nearly coplanar
// surfaces, and no pixel is ever drawn twice or not at all. That is how Unity's
// own `LODGroup` cross-fades, and how every deferred renderer does it.
//
// The duration is the sheet's `lodTransitionTime` for that terrain times the
// preset's `durationScale` — so the ONE number to argue with is a ratio, and
// 1.0 is what 2016 wrote down for each environment.
//
// ── Why the fade uniform lives on a CLONE ────────────────────────────────
//
// Every chunk of a terrain shares one material, and three uploads a material's
// uniforms once per material per frame, not per draw — a per-chunk value
// cannot ride on the shared material. A material CLONE has its own uniforms
// and, with the same program cache key, the same compiled program: `clone()`
// keeps every parameter, and the two hooks `Material.copy` does NOT carry —
// `onBeforeCompile` and `customProgramCacheKey` — are delegated back to the
// base explicitly. Chained patches (fog, far shadow, the illustrative warp, the
// water) run on the clone exactly as on the base because the clone CALLS the
// base's chain; only the fade uniform is replaced afterwards with the clone's
// own. Clones are pooled and returned when a fade ends, so a lap costs a few
// dozen clones total and no compiles after the first.
//
// ── Cost, and why the BASE does not carry the discard ────────────────────
//
// During a transition a chunk is two draw calls and two chunks' triangles
// instead of one; the fragments are complementary, so shading work is the same
// and only rasterisation doubles.
//
// Everything else — Classic, a settled chunk, the ocean — used to be *"one
// uniform branch per fragment that is never taken"*, and that sentence was
// wrong about the thing that matters. A branch is nearly free. A `discard`
// **in the shader text** is not: a fragment shader that can kill a fragment
// cannot have its depth written before it runs, so the hardware drops to late
// depth write and, on some parts, gives up the early depth TEST with it. The
// text is what decides that, not whether the branch is ever entered — and
// `game/terrain/load-terrain.ts` patches every terrain, which is the 16 × 16
// chunk grid (51 % of the frame) and the 262 km ocean plate (20 %).
//
// The ocean is the sharp edge: DEV-167 W6 compiles an above-water variant with
// **no `discard` in the shader text**, for exactly this reason, and an
// unconditional splice here put one straight back underneath it.
//
// So the discard lives behind `LOD_FADE_DEFINE`, the base compiles without it
// (the GLSL preprocessor removes it before the driver's code generator sees
// it), and only the pooled clones — the two materials of a live transition —
// define it. DEV-184, and it was MEASURED before it was built; the number is in
// `docs/DEVIATIONS.md`.

import * as THREE from 'three'
import { EYE_ORIGIN_UNIFORM, EYE_PIXEL_PARS, EYE_SEED, eyeOriginUniform } from '@/render/eye-dither'
import { chainShaderPatch } from '@/render/program-cache-key'
import {
  type CloneStateOptions,
  cloneStateKey,
  delegatingClone,
  resyncClone,
} from './delegating-clone'
import { LOD_FADE_DEFINE } from './lod-fade-define'

/** `(coverage, mode)`. Mode +1 fades in, −1 fades out, 0 draws everything. */
export type LodFadeUniform = { value: THREE.Vector2 }

export const LOD_FADE_INCLUDE = '#include <clipping_planes_fragment>'

/**
 * The define that puts the `discard` into a program. On the CLONES only.
 *
 * See "Why the base does not carry the discard" in the header. `material.defines`
 * is hashed into three's program cache key by `getProgramCacheKey` — before
 * `customProgramCacheKey` is even consulted — so setting this on a clone is
 * half of what makes it a second program. The other half is explicit below.
 */
export { LOD_FADE_DEFINE } from './lod-fade-define'

/**
 * The state a clone has to reproduce, as a string. DEV-189.
 *
 * Everything on a material that decides which PROGRAM it compiles and which
 * faces reach it — `side`, `fog`, and every define except the fade's own gate,
 * which a clone carries and a base never does. The fade uniform is not in here:
 * it is a uniform, and two clones at different coverages share one program.
 *
 * It exists because those two were being kept in step separately and drifted
 * apart. `render/water.ts` sets them in one call (`applyVariant`) precisely
 * because DEV-167's cull is only correct when they agree, so the pool should
 * read them as one value too.
 *
 * Exported because the invariant the tests assert is stated in terms of it:
 * `variantKey(clone) === variantKey(base)` for every clone the pool lends, at
 * the moment it lends it.
 *
 * ── two fields DEV-194 added, and one it stopped throwing away ────────────
 *
 * `fog` is `parameters.useFog`, bit 1 of three's second `_programLayers` mask.
 * It cannot reach the shader text while `scene.fog` is null — which it always
 * is here — so a clone that disagrees with its base about it is not a wrong
 * picture, it is a second program compiling the same GLSL. That is DEV-194 on
 * the sea's bands; the fade pool is the other clone site with the same shape,
 * and `Material.copy` carries `fog` into a pooled clone exactly as it carried
 * `side` into DEV-189's.
 *
 * And the define ORDER is no longer sorted away. `getProgramCacheKey` walks
 * `for (const name in parameters.defines)`, so three's key is insertion
 * ordered and `{A,B}` is a different program from `{B,A}`. A `variantKey` that
 * sorted reported "same state" for two materials that compile separately —
 * the same failure as asserting a rotation instead of a distance: it agreed
 * with itself. `syncVariant` rebuilds the clone by spreading the base, which
 * reproduces the base's order, so this compares equal whenever it should.
 */
export const variantKey = (material: THREE.Material): string =>
  cloneStateKey(material, LOD_FADE_DEFINE)

/** A fade clone owns its defines (a spread of the base's) plus the fade's gate. */
const FADE_STATE: CloneStateOptions = {
  defines: 'copy',
  extraDefines: { [LOD_FADE_DEFINE]: '' },
}

/**
 * Jimenez's interleaved gradient noise (SIGGRAPH 2014, "Next Generation
 * Post Processing in Call of Duty"): a screen-space dither that reads as an
 * even grain rather than a Bayer grid, and the same function DEV-086's PCF
 * penumbra already uses in this renderer.
 *
 * Seeded from the EYE's pixel (`ff2EyePixel()`), not the window's
 * `gl_FragCoord.xy`: in a headset both eyes share one framebuffer, and a
 * window seed gave the right eye a different screen-door from the left for
 * the same chunk. DEV-556; `render/eye-dither.ts` has the mechanism, and why
 * a flat frame is unchanged bit for bit. The guarded declaration is spliced
 * here as well as into the shadow chunk because a fading chunk need not
 * receive a shadow (Anniversary at `low` has no map), and the guard keeps one
 * copy when it does.
 */
export const LOD_FADE_PARS = /* glsl */ `${EYE_PIXEL_PARS}
uniform vec2 uLodFade;
float ff2LodFadeDither( vec2 px ) {
	return fract( 52.9829189 * fract( dot( px, vec2( 0.06711056, 0.00583715 ) ) ) );
}
`

/**
 * Complementary: at coverage `t` the incoming mesh owns the fragments whose
 * dither is below `t` and the outgoing mesh owns the rest. Mode 0 never
 * discards, which is Classic and every settled chunk, bit for bit.
 */
export const LOD_FADE_MAIN = /* glsl */ `
#ifdef ${LOD_FADE_DEFINE}
	if ( uLodFade.y > 0.5 ) {
		if ( ff2LodFadeDither( ${EYE_SEED} ) >= uLodFade.x ) discard;
	} else if ( uLodFade.y < -0.5 ) {
		if ( ff2LodFadeDither( ${EYE_SEED} ) < uLodFade.x ) discard;
	}
#endif
`

/**
 * Splice the fade into a fragment shader: the declaration before `main`, the
 * test right after the clipping planes (the first thing `main` does after
 * `diffuseColor`), so a discarded fragment costs nothing further.
 *
 * Unchanged when the include is absent — the depth pass compiles its own
 * `MeshDepthMaterial` and never sees this, which is the right answer: a fading
 * chunk should cast a whole shadow, not a dithered one.
 */
export const lodFadePatchFragment = (fragmentShader: string): string => {
  if (!fragmentShader.includes(LOD_FADE_INCLUDE)) return fragmentShader
  const main = fragmentShader.indexOf('void main()')
  if (main < 0) return fragmentShader
  return (
    fragmentShader.slice(0, main) +
    LOD_FADE_PARS +
    fragmentShader.slice(main).replace(LOD_FADE_INCLUDE, `${LOD_FADE_INCLUDE}\n${LOD_FADE_MAIN}`)
  )
}

/** The per-clone uniform, kept off the material so `copy()` cannot alias it. */
const fadeUniforms = new WeakMap<THREE.Material, LodFadeUniform>()

/** Off: coverage 0, mode 0. Shared by every base material; never written. */
const OFF: LodFadeUniform = { value: new THREE.Vector2(0, 0) }

export const lodFadeUniformOf = (material: THREE.Material): LodFadeUniform | undefined =>
  fadeUniforms.get(material)

/**
 * A transition's two materials — the incoming clone and the outgoing clone —
 * and the one call that moves both.
 */
export interface LodFadePair {
  readonly incoming: THREE.Material
  readonly outgoing: THREE.Material
  /** Coverage 0..1 of the INCOMING mesh. */
  setCoverage(t: number): void
}

export interface LodFadePool {
  /**
   * Patch a base material so its clones can fade. Idempotent, chained, tagged.
   * Call it BEFORE the first `acquire`, and on Classic too — the injected GLSL
   * has no branch that is not a uniform, so the base draws exactly as it did.
   */
  applyTo(material: THREE.Material): void
  /**
   * Say that `derived` already CARRIES the patch because it was cloned from a
   * patched base, so `acquire(derived)` is legal. DEV-183.
   *
   * `applyTo` would be wrong here and wrong quietly: it splices
   * `lodFadePatchFragment` a second time — the `#include` hook it keys off is
   * still in the text after the first pass — which declares `uLodFade` twice
   * and fails to compile, and it tags the cache key a second time, which would
   * give the derived material a program of its own. `render/water.ts`'s
   * per-facet materials are the caller: each one delegates `onBeforeCompile`
   * back to the base it was cut from, so the fade's GLSL, its `OFF` uniform
   * and its cache-key tag all arrive through that delegation already.
   */
  adopt(derived: THREE.Material): void
  /**
   * Two clones of `base`, ready to fade, or null when the pool is at its cap —
   * in which case the caller swaps the way it always did. Never null in
   * practice: the cap is well above the chunks a band can hand over in one
   * second of flight.
   */
  acquire(base: THREE.Material): LodFadePair | null
  /** Give a pair back. Its materials go quiet (mode 0) and are reused. */
  release(pair: LodFadePair): void
  /** Clones alive, pooled or in use. For the row and the perf readout. */
  readonly cloneCount: number
  readonly inUse: number
  dispose(): void
}

/**
 * More clones than this and something upstream is wrong (a camera teleporting
 * every frame), so the fade steps aside rather than allocate without bound.
 * A 180 m/s ship crosses about ten chunks a second at the 1,024 m band and
 * three at the ring; a 1 s fade on Simonet holds at most ~26 pairs.
 */
export const LOD_FADE_POOL_CAP = 96

export const createLodFadePool = (): LodFadePool => {
  const patched = new WeakSet<THREE.Material>()
  const free = new Map<THREE.Material, THREE.Material[]>()
  let cloneCount = 0
  let inUse = 0

  const cloneOf = (base: THREE.Material): THREE.Material => {
    const uniform: LodFadeUniform = { value: new THREE.Vector2(0, 0) }
    // The recipe is `render/delegating-clone.ts`'s: the base's whole chain, then
    // THIS clone's uniform in place of the OFF one the base's own patch
    // installed; DEV-192's point-light cut arrives with that chain (recorded,
    // not installed); the base's key plus a suffix.
    //
    // ── the clone is the one that DISCARDS (DEV-184) ─────────────────────
    //
    // `Material.copy` does not carry a subclass's extra defines (every built-in
    // `copy()` resets `this.defines` to its own set), so the gate is put on
    // AFTER the clone (`FADE_STATE.extraDefines`), not inherited.
    //
    // Two things then make the clone a second program, and both are deliberate:
    // the define (three hashes `defines` into the cache key) and the key suffix.
    // Either alone would do it; the pair means the invariant a test can
    // assert, *the clone's key is not the base's*, is true of THIS file's
    // code rather than only of three's internals.
    //
    // Every clone of one base shares the suffix and the define, so it is ONE
    // extra program per terrain material however many clones the pool cuts.
    // `render/warm-up.ts` compiles it under the curtain; without that the first
    // LOD change in flight would compile it mid-air.
    const clone = delegatingClone(base, {
      ...FADE_STATE,
      keySuffix: LOD_FADE_DEFINE,
      override: (shader) => {
        shader.uniforms.uLodFade = uniform
      },
    })
    fadeUniforms.set(clone, uniform)
    cloneCount++
    return clone
  }

  // A pooled clone is re-synced on every `acquire` (DEV-186, DEV-189): the
  // base's defines, its `side` and its fog flag, because `Material.copy` only
  // runs at BIRTH and the sea's two-sided variant moves all three at once.
  // `resyncClone` dirties the clone only when `variantKey` says something moved.
  // The sea is the case that makes this a visible bug rather than a tidiness
  // one: a fading ocean chunk drew two-sided with no cull and no discard
  // (DEV-050's 35.6 % speckle regime, and the sea back across the launch tube,
  // DEV-106) when the clone carried one half of that pair and not the other.

  return {
    applyTo(material) {
      chainShaderPatch(
        material,
        {
          tag: 'lod-fade',
          fragment: lodFadePatchFragment,
          // The uniforms are assigned by name, not merged: `uLodFade` is the
          // shared OFF constant, and the eye's origin (DEV-556, the dither's
          // seed) is a fresh wrapper per compile. A lit base has it already from
          // three's ShaderLib; an unlit one would not. They run after the
          // fragment rewrite, which is a pure text map and reads neither.
          after: (shader) => {
            shader.uniforms.uLodFade = OFF
            shader.uniforms[EYE_ORIGIN_UNIFORM] = eyeOriginUniform()
          },
        },
        patched,
      )
    },

    adopt(derived) {
      patched.add(derived)
    },

    acquire(base) {
      if (!patched.has(base)) {
        throw new Error('lod-fade: acquire() before applyTo() — the base material carries no fade')
      }
      if (inUse + 2 > LOD_FADE_POOL_CAP) return null
      const pool = free.get(base) ?? []
      free.set(base, pool)
      const incoming = pool.pop() ?? cloneOf(base)
      const outgoing = pool.pop() ?? cloneOf(base)
      // A pooled clone was cut under whatever variant the base had THEN. Re-sync
      // both, and dirty them only when something actually moved — a needless
      // `needsUpdate` is a program re-fetch per fade.
      //
      // Compared through `variantKey` rather than through the defines alone,
      // because `side` is in three's program cache key too
      // (`WebGLPrograms.js:369-370`, `:569-571`) and `setProgram` re-resolves a
      // program only when `material.version` moves — so a `side` that changed
      // without a `needsUpdate` would draw the old program's faces just as
      // silently as a define that did. DEV-189.
      //
      // The sea is the case: `render/water.ts`'s `applyVariant` moves both at
      // once — FrontSide above the waterline, DoubleSide with two `discard`s
      // below it — and a pooled clone cut during the launch ride and reused on
      // the lap would otherwise go on drawing the two-sided program for every
      // fading ocean chunk, for the life of the pool. The right picture at the
      // wrong price, and invisible. (DEV-183 found this independently while
      // building the per-band materials; its version assigned `base.defines`
      // by reference, which is stale-proof but drops the clone's own fade
      // gate — so the copy stays, and the 0.6 s window it leaves is the one
      // DEV-186 and DEV-189 both argue is unreachable.)
      for (const m of [incoming, outgoing]) resyncClone(m, base, FADE_STATE, LOD_FADE_DEFINE)
      inUse += 2
      const fadeIn = fadeUniforms.get(incoming) as LodFadeUniform
      const fadeOut = fadeUniforms.get(outgoing) as LodFadeUniform
      fadeIn.value.set(0, 1)
      fadeOut.value.set(0, -1)
      const pair: LodFadePair = {
        incoming,
        outgoing,
        setCoverage(t) {
          const c = t < 0 ? 0 : t > 1 ? 1 : t
          fadeIn.value.set(c, 1)
          fadeOut.value.set(c, -1)
        },
      }
      pairBase.set(pair, base)
      return pair
    },

    release(pair) {
      const base = pairBase.get(pair)
      if (!base) return
      pairBase.delete(pair)
      for (const m of [pair.incoming, pair.outgoing]) {
        fadeUniforms.get(m)?.value.set(0, 0)
        free.get(base)?.push(m)
      }
      inUse -= 2
    },

    get cloneCount() {
      return cloneCount
    },
    get inUse() {
      return inUse
    },

    dispose() {
      for (const clones of free.values()) for (const m of clones) m.dispose()
      free.clear()
      cloneCount = 0
      inUse = 0
    },
  }
}

const pairBase = new WeakMap<LodFadePair, THREE.Material>()

/**
 * The preset's half of a fade, as `content/editions/*.json` carries it.
 * `durationScale` multiplies the sheet's authored `lodTransitionTime`.
 */
export interface LodFadeSpec {
  readonly durationScale: number
}

/**
 * Seconds a transition takes on a terrain whose sheet entry says
 * `lodTransitionTime`, or null for a hard swap: no spec (Classic), no
 * authored time, or a product that rounds to nothing.
 */
export const lodFadeSeconds = (
  spec: LodFadeSpec | null | undefined,
  lodTransitionTime: number | null | undefined,
): number | null => {
  if (!spec || lodTransitionTime == null) return null
  const seconds = lodTransitionTime * spec.durationScale
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null
}
