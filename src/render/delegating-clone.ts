// src/render/delegating-clone.ts: the one recipe for a material that is a clone
// of another and compiles the BASE's program (or one program beside it).
//
// Three factories in this renderer cut such clones: `lod-fade.ts`'s pooled fade
// pairs, `water.ts`'s per-LOD ocean bands and `prop-fracture.ts`'s pieces. Each
// repeated the same steps and one of them (the fracture) had dropped one, which
// is DEV-685. The steps, and why each is here:
//
//  1. `base.clone()`. `Material.copy` carries neither `onBeforeCompile` nor
//     `customProgramCacheKey`, and it WIPES `defines` (MeshStandardMaterial's
//     `copy()` assigns `{ STANDARD: '' }`; a Lambert material has none to
//     copy), so a bare clone is a different shader under a different key.
//  2. `onBeforeCompile` delegates to the base with `call(base, ...)`: every
//     patch in the chain was written against `material`, not `this`. The base's
//     hook is read AT CALL TIME rather than captured, so a patch installed on
//     the base after the clone was cut is in the clone too. An optional
//     `override` runs after the chain, to put the clone's OWN uniform in place
//     of the one the chain installed (uLodFade, uFacet).
//  3. `inheritPointLightScope(clone, base)`. The point-light cut arrives through
//     the delegation; this records that it did. `scopePointLights(clone)` would
//     tag the key a second time and cost a program.
//  4. `customProgramCacheKey` delegates to the base's, with an optional suffix
//     for a clone that is deliberately a SECOND program (the fade's discard).
//     No `tagProgramCacheKey` here: the tag names ways the injected source can
//     differ, and the clone's injected source is the base's, character for
//     character.
//  5. The state three hashes into the key that `copy()` gets wrong or only gets
//     right at birth: `defines`, `side` and the fog flag (`syncDelegatedState`).
//     three's key walks `defines` in INSERTION order (DEV-194), `side` and the
//     fog flag are in it too, and a pooled clone is lent back long after birth.
//  6. `needsUpdate`, last.
//
// Everything else a factory does (pool, uniforms, name, opacity) stays in the
// factory, around this call. `tests/unit/delegating-clone.test.ts` pins each step.

import type * as THREE from 'three'
import { inheritPointLightScope } from './point-light-scope'
import { fogFlag, setFogFlag } from './program-cache-key'

/**
 * How a clone gets the base's defines.
 *
 *  - `copy`: a fresh object spread from the base's, which reproduces the base's
 *    INSERTION ORDER (three's cache key walks `for...in`, DEV-194) and is the
 *    clone's own, so the clone may add defines (`extraDefines`) without touching
 *    the base. Needs re-syncing when the base's defines move (`resyncClone`).
 *  - `share`: the same object by reference. For a clone whose base moves its
 *    defines in place and must carry every clone with it in the same two writes
 *    (water's `applyVariant`; `fragment-gates.ts` keys state on that object,
 *    DEV-238). No `extraDefines` here, they would land on the base.
 */
export type ClonedDefines = 'copy' | 'share'

export interface CloneStateOptions {
  readonly defines: ClonedDefines
  /** `copy` only: defines the clone has and the base does not, added last. */
  readonly extraDefines?: Readonly<Record<string, string>>
}

export interface DelegatingCloneOptions extends CloneStateOptions {
  /** Runs AFTER the base's chain: this clone's own uniforms go here. */
  readonly override?: (shader: THREE.WebGLProgramParametersWithUniforms) => void
  /** Appended to the base's key as `|suffix`; omit to share the base's program. */
  readonly keySuffix?: string
}

/** Give `clone` the base's defines, `side` and fog flag. */
export const syncDelegatedState = (
  clone: THREE.Material,
  base: THREE.Material,
  options: CloneStateOptions,
): void => {
  if (options.defines === 'share') {
    clone.defines = base.defines
  } else {
    // Spread, so the clone reproduces the base's define ORDER and not just its
    // set (DEV-194).
    clone.defines = { ...(base.defines ?? {}), ...(options.extraDefines ?? {}) }
  }
  clone.side = base.side
  setFogFlag(clone, fogFlag(base))
}

/**
 * Cut a clone of `base` that delegates its shader and its key to `base`.
 * Returns the clone, still to be given whatever the factory adds (name,
 * uniforms, opacity).
 */
export const delegatingClone = <M extends THREE.Material>(
  base: M,
  options: DelegatingCloneOptions,
): M => {
  const clone = base.clone() as M
  const { override, keySuffix } = options
  clone.onBeforeCompile = (shader, renderer) => {
    base.onBeforeCompile.call(base, shader, renderer)
    override?.(shader)
  }
  inheritPointLightScope(clone, base)
  syncDelegatedState(clone, base, options)
  clone.customProgramCacheKey =
    keySuffix === undefined
      ? () => base.customProgramCacheKey()
      : () => `${base.customProgramCacheKey()}|${keySuffix}`
  clone.needsUpdate = true
  return clone
}

/**
 * Everything three hashes into the program cache key that a delegating clone
 * has to agree with its base on: `side`, the fog flag, and the defines IN
 * INSERTION ORDER (never sorted: `{A,B}` and `{B,A}` compile separately, so a
 * sorted comparison reports "same" for two materials that are not).
 * `ignoreDefine` is a define the clone has on purpose (the fade's gate).
 */
export const cloneStateKey = (material: THREE.Material, ignoreDefine?: string): string => {
  const defines = material.defines ?? {}
  const keys = Object.keys(defines).filter((k) => k !== ignoreDefine)
  const fog = fogFlag(material)
  return `${material.side}|${String(fog)}|${keys.map((k) => `${k}=${String(defines[k])}`).join(',')}`
}

/**
 * Re-sync a pooled clone with its base, dirtying it ONLY when something moved
 * (a needless `needsUpdate` is a program re-fetch). `side` is in three's key
 * too, and `setProgram` re-resolves only when `material.version` moves, so a
 * `side` that changed without a `needsUpdate` would draw the old program's
 * faces just as silently as a define that did (DEV-189).
 */
export const resyncClone = (
  clone: THREE.Material,
  base: THREE.Material,
  options: CloneStateOptions,
  ignoreDefine?: string,
): boolean => {
  if (cloneStateKey(clone, ignoreDefine) === cloneStateKey(base, ignoreDefine)) return false
  syncDelegatedState(clone, base, options)
  clone.needsUpdate = true
  return true
}
