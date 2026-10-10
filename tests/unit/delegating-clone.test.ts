// tests/unit/delegating-clone.test.ts: the one recipe for a clone that compiles
// its base's program (render/delegating-clone.ts). The three factories that use
// it (lod-fade, water, prop-fracture) keep their own tests; this pins the steps
// the recipe owns, so a fourth factory cannot drop one the way the fracture did
// (DEV-685).

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  cloneStateKey,
  delegatingClone,
  resyncClone,
  syncDelegatedState,
} from '@/render/delegating-clone'
import { isPointLightScoped, scopePointLights } from '@/render/point-light-scope'
import { setFogFlag, tagProgramCacheKey } from '@/render/program-cache-key'

const shaderOf = (): THREE.WebGLProgramParametersWithUniforms =>
  ({
    vertexShader: 'void main() {}',
    fragmentShader: 'void main() {}',
    uniforms: {} as Record<string, THREE.IUniform>,
  }) as unknown as THREE.WebGLProgramParametersWithUniforms

const compile = (m: THREE.Material): THREE.WebGLProgramParametersWithUniforms => {
  const s = shaderOf()
  m.onBeforeCompile(s, null as unknown as THREE.WebGLRenderer)
  return s
}

const patchedBase = (): THREE.MeshStandardMaterial => {
  const base = new THREE.MeshStandardMaterial()
  const previous = base.onBeforeCompile
  base.onBeforeCompile = (shader, renderer) => {
    previous?.call(base, shader, renderer)
    shader.uniforms.uBase = { value: 'base' }
    shader.fragmentShader = `// patched\n${shader.fragmentShader}`
  }
  tagProgramCacheKey(base, 'tag-a')
  return base
}

describe('delegatingClone: the hook', () => {
  it('runs the base chain, then the override, so the clone own uniform wins', () => {
    const base = patchedBase()
    const own = { value: 'clone' }
    const clone = delegatingClone(base, {
      defines: 'copy',
      override: (shader) => {
        shader.uniforms.uBase = own
      },
    })
    const s = compile(clone)
    expect(s.fragmentShader).toContain('// patched')
    expect(s.uniforms.uBase).toBe(own)
    // And the base alone is untouched.
    expect(compile(base).uniforms.uBase).toEqual({ value: 'base' })
  })

  it('reads the base hook AT CALL TIME, so a patch added after the clone is in it', () => {
    const base = patchedBase()
    const clone = delegatingClone(base, { defines: 'copy' })
    const previous = base.onBeforeCompile
    base.onBeforeCompile = (shader, renderer) => {
      previous.call(base, shader, renderer)
      shader.uniforms.uLate = { value: 1 }
    }
    expect(compile(clone).uniforms.uLate).toBeDefined()
  })

  it('records the point-light cut as inherited, and does not install a second one', () => {
    const base = patchedBase()
    const clone = delegatingClone(base, { defines: 'copy' })
    expect(isPointLightScoped(clone)).toBe(false)
    scopePointLights(base)
    expect(isPointLightScoped(clone)).toBe(true)
  })
})

describe('delegatingClone: the key', () => {
  it("is the base's, so the clone is the base's program", () => {
    const base = patchedBase()
    const clone = delegatingClone(base, { defines: 'copy' })
    expect(clone.customProgramCacheKey()).toBe(base.customProgramCacheKey())
    expect(clone.customProgramCacheKey()).toContain('|tag-a')
    // A bare clone does not agree: that is the bug the delegation exists for.
    expect(base.clone().customProgramCacheKey()).not.toBe(base.customProgramCacheKey())
  })

  it('takes a suffix for a clone that is deliberately a second program, read live', () => {
    const base = patchedBase()
    const clone = delegatingClone(base, { defines: 'copy', keySuffix: 'second' })
    expect(clone.customProgramCacheKey()).toBe(`${base.customProgramCacheKey()}|second`)
    tagProgramCacheKey(base, 'tag-b')
    expect(clone.customProgramCacheKey()).toBe(`${base.customProgramCacheKey()}|second`)
    expect(clone.customProgramCacheKey()).toContain('|tag-b|second')
  })
})

describe('delegatingClone: defines, side, fog', () => {
  it("'copy' reproduces the base's runtime defines in INSERTION order, in its own object", () => {
    const base = new THREE.MeshStandardMaterial()
    base.defines = { ...base.defines, B_FIRST: '', A_SECOND: '' }
    const clone = delegatingClone(base, { defines: 'copy' })
    expect(Object.keys(clone.defines ?? {})).toEqual(Object.keys(base.defines))
    expect(clone.defines).not.toBe(base.defines)
    // three's own copy() would have left only STANDARD.
    expect(Object.keys(base.clone().defines ?? {})).toEqual(['STANDARD'])
  })

  it("'copy' adds extraDefines last and leaves the base alone", () => {
    const base = new THREE.MeshStandardMaterial()
    base.defines = { ...base.defines, RUNTIME: '' }
    const clone = delegatingClone(base, { defines: 'copy', extraDefines: { GATE: '' } })
    expect(Object.keys(clone.defines ?? {})).toEqual(['STANDARD', 'RUNTIME', 'GATE'])
    expect(Object.keys(base.defines)).toEqual(['STANDARD', 'RUNTIME'])
  })

  it("'share' is the base's own object, so one in-place edit moves both", () => {
    const base = new THREE.MeshStandardMaterial()
    const clone = delegatingClone(base, { defines: 'share' })
    expect(clone.defines).toBe(base.defines)
    ;(base.defines as Record<string, string>).LATER = ''
    expect(clone.defines?.LATER).toBe('')
  })

  it("takes the base's side and fog flag, however copy() went", () => {
    const base = new THREE.MeshStandardMaterial()
    base.side = THREE.DoubleSide
    setFogFlag(base, false)
    const clone = delegatingClone(base, { defines: 'copy' })
    expect(clone.side).toBe(THREE.DoubleSide)
    expect(clone.fog).toBe(false)
  })

  it('dirties the clone once, at birth', () => {
    const base = new THREE.MeshStandardMaterial()
    const before = new THREE.MeshStandardMaterial().version
    const clone = delegatingClone(base, { defines: 'copy' })
    expect(clone.version).toBeGreaterThan(before)
  })
})

describe('resyncClone and cloneStateKey', () => {
  it('is a no-op, and does not dirty the clone, while nothing moved', () => {
    const base = new THREE.MeshStandardMaterial()
    base.defines = { ...base.defines, RUNTIME: '' }
    const clone = delegatingClone(base, { defines: 'copy' })
    const version = clone.version
    expect(resyncClone(clone, base, { defines: 'copy' })).toBe(false)
    expect(clone.version).toBe(version)
  })

  it('follows a define edited in place on the base, and dirties the clone', () => {
    const base = new THREE.MeshStandardMaterial()
    const clone = delegatingClone(base, { defines: 'copy' })
    const version = clone.version
    ;(base.defines as Record<string, string>).LATER = ''
    expect(resyncClone(clone, base, { defines: 'copy' })).toBe(true)
    expect(Object.keys(clone.defines ?? {})).toEqual(Object.keys(base.defines ?? {}))
    expect(clone.version).toBeGreaterThan(version)
  })

  it('follows side and the fog flag, which are in three key too', () => {
    const base = new THREE.MeshStandardMaterial()
    const clone = delegatingClone(base, { defines: 'copy' })
    base.side = THREE.BackSide
    expect(resyncClone(clone, base, { defines: 'copy' })).toBe(true)
    expect(clone.side).toBe(THREE.BackSide)
    setFogFlag(base, false)
    expect(resyncClone(clone, base, { defines: 'copy' })).toBe(true)
    expect(clone.fog).toBe(false)
  })

  it('compares defines IN ORDER: {A,B} and {B,A} are two keys for one shader', () => {
    const a = new THREE.MeshStandardMaterial()
    const b = new THREE.MeshStandardMaterial()
    a.defines = { A: '', B: '' }
    b.defines = { B: '', A: '' }
    expect(cloneStateKey(a)).not.toBe(cloneStateKey(b))
    a.defines = { A: '', B: '' }
    b.defines = { A: '', B: '' }
    expect(cloneStateKey(a)).toBe(cloneStateKey(b))
  })

  it("ignores the one define a clone carries on purpose (the fade's gate)", () => {
    const base = new THREE.MeshStandardMaterial()
    const state = { defines: 'copy', extraDefines: { GATE: '' } } as const
    const clone = delegatingClone(base, state)
    expect(cloneStateKey(clone)).not.toBe(cloneStateKey(base))
    expect(cloneStateKey(clone, 'GATE')).toBe(cloneStateKey(base, 'GATE'))
    expect(resyncClone(clone, base, state, 'GATE')).toBe(false)
  })

  it('syncDelegatedState alone rewrites a clone to the base without a version bump', () => {
    const base = new THREE.MeshStandardMaterial()
    const clone = delegatingClone(base, { defines: 'copy' })
    base.defines = { ...base.defines, X: '' }
    const version = clone.version
    syncDelegatedState(clone, base, { defines: 'copy' })
    expect(Object.keys(clone.defines ?? {})).toContain('X')
    expect(clone.version).toBe(version)
  })
})
