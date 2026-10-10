// tests/unit/terrain-surface.test.ts — roughness by surface class (DEV-132).
//
// Three kinds of claim. The GLSL lands in the real stock shaders and only
// there. The identity at mix 0 is exact. And the ORDER Matt asked for is held
// against a number from OUTSIDE the preset — the sea's own effective roughness,
// transcribed from its VacuumShaders `_Shininess` on the sheet — rather than
// against two of the preset's own values.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { type Edition, SURFACE_GLOSS_SWATCH_MAX, validateEdition } from '@/content/edition-schema'
import { TERRAIN } from '@/generated/constants.generated'
import { shininessToRoughness } from '@/render/terrain-mesh'
import {
  attachEditionSurfaceGloss,
  classifySurface,
  createSurfaceGloss,
  flattenSwatches,
  SURFACE_SWATCH_MAX,
  type SurfaceGlossTuning,
  surfacePatchFragment,
  surfacePatchVertex,
  surfaceRoughnessChunk,
} from '@/render/terrain-surface'
import anniversary from '../../content/editions/anniversary.json'
import classic from '../../content/editions/classic.json'

const ANNIV = (anniversary as unknown as Edition).terrain.surfaceGloss
const CLASSIC = (classic as unknown as Edition).terrain.surfaceGloss

const terrainLike = () =>
  new THREE.MeshPhysicalMaterial({ vertexColors: true, metalness: 0, side: THREE.FrontSide })

describe('the GLSL', () => {
  it('replaces the BASE of the stock roughness chunk and keeps the map branch', () => {
    const out = surfaceRoughnessChunk()
    expect(out).toContain('float roughnessFactor = mix( roughness, vFf2Rough, uSurfaceGloss.x );')
    expect(out).not.toContain('float roughnessFactor = roughness;')
    expect(out).toContain('#ifdef USE_ROUGHNESSMAP')
    expect(out).toContain('roughnessFactor *= texelRoughness.g;')
  })

  it('splices into the real stock physical shaders, once each', () => {
    const v = surfacePatchVertex(THREE.ShaderLib.physical.vertexShader)
    const f = surfacePatchFragment(THREE.ShaderLib.physical.fragmentShader)
    expect(v.split('varying float vFf2Rough;')).toHaveLength(2)
    expect(f.split('varying float vFf2Rough;')).toHaveLength(2)
    expect(v.split('vFf2Rough = ff2SurfaceRoughness( vColor.rgb );')).toHaveLength(2)
    expect(f).not.toContain('#include <roughnessmap_fragment>')
    // The classifier runs AFTER the vertex colour exists.
    expect(v.indexOf('#include <color_vertex>')).toBeLessThan(
      v.indexOf('ff2SurfaceRoughness( vColor.rgb )'),
    )
    // The table is the size the content validator enforces.
    expect(v).toContain(`uniform vec4 uSurfaceSwatch[ ${SURFACE_SWATCH_MAX} ];`)
  })

  it('leaves the depth pass alone', () => {
    const depth = THREE.ShaderLib.depth
    expect(surfacePatchVertex(depth.vertexShader)).toBe(depth.vertexShader)
    expect(surfacePatchFragment(depth.fragmentShader)).toBe(depth.fragmentShader)
  })

  it('uses no GLSL ES reserved word as an identifier', () => {
    const reserved = ['half', 'fixed', 'input', 'output', 'filter', 'sizeof', 'cast', 'namespace']
    const src =
      surfacePatchVertex('void main() {\n#include <color_vertex>\n}') + surfaceRoughnessChunk()
    const words = new Set(src.match(/[A-Za-z_]\w*/g))
    for (const r of reserved) expect(words.has(r), r).toBe(false)
  })

  it('the content table and the shader table are the same size', () => {
    expect(SURFACE_GLOSS_SWATCH_MAX).toBe(SURFACE_SWATCH_MAX)
  })
})

describe('the material patch', () => {
  it('tags the key and is one variant across tunings', () => {
    const gloss = createSurfaceGloss()
    const a = terrainLike()
    const b = terrainLike()
    gloss.applyTo(a)
    gloss.applyTo(b)
    expect(a.customProgramCacheKey()).toContain('surface-gloss')
    expect(a.customProgramCacheKey()).toBe(b.customProgramCacheKey())
    expect(a.customProgramCacheKey()).not.toBe(terrainLike().customProgramCacheKey())
  })

  it('is idempotent', () => {
    const gloss = createSurfaceGloss()
    const m = terrainLike()
    gloss.applyTo(m)
    gloss.applyTo(m)
    expect(gloss.materialCount).toBe(1)
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    }
    m.onBeforeCompile(shader as never, {} as THREE.WebGLRenderer)
    expect(shader.vertexShader.split('float ff2SurfaceRoughness(')).toHaveLength(2)
    expect(shader.uniforms.uSurfaceGloss).toBe(gloss.uniforms.uSurfaceGloss)
  })

  it('starts at the identity and `set(null)` returns to it', () => {
    const gloss = createSurfaceGloss()
    expect(gloss.uniforms.uSurfaceGloss.value.toArray()).toEqual([0, 0])
    gloss.set(ANNIV)
    expect(gloss.uniforms.uSurfaceGloss.value.x).toBe(1)
    expect(gloss.uniforms.uSurfaceGloss.value.y).toBe(flattenSwatches(ANNIV.classes).length)
    gloss.set(null)
    expect(gloss.uniforms.uSurfaceGloss.value.toArray()).toEqual([0, 0])
    // An enabled tuning with NO classes is the identity too.
    gloss.set({ enabled: true, classes: [] })
    expect(gloss.uniforms.uSurfaceGloss.value.toArray()).toEqual([0, 0])
  })

  it('fills the table in class order with the roughness in .w, and pads the rest', () => {
    const gloss = createSurfaceGloss()
    gloss.set(ANNIV)
    const flat = flattenSwatches(ANNIV.classes)
    const table = gloss.uniforms.uSurfaceSwatch.value
    for (let i = 0; i < flat.length; i++) {
      expect(table[i]?.toArray()).toEqual(flat[i]?.toArray())
    }
    for (let i = flat.length; i < SURFACE_SWATCH_MAX; i++) {
      expect(table[i]?.toArray()).toEqual([0, 0, 0, 1])
    }
  })

  it('follows the live preset and flips back to null on Classic', () => {
    const pushes: (SurfaceGlossTuning | null)[] = []
    let current = anniversary as unknown as Edition
    const listeners: (() => void)[] = []
    attachEditionSurfaceGloss(
      { set: (t) => pushes.push(t) },
      {
        get current() {
          return current
        },
        subscribe: (l) => {
          listeners.push(l)
          return () => {}
        },
      },
    )
    expect(pushes[0]).toBe(ANNIV)
    current = classic as unknown as Edition
    for (const l of listeners) l()
    expect(pushes[1]).toBeNull()
  })
})

describe('the classifier, in TypeScript and therefore testable', () => {
  it('lands each measured Simonet swatch in the class the palette sweep gave it', () => {
    // scratch/terrain-look/palette.mjs on the imported Simonet colour map.
    const cases: [string, number[]][] = [
      ['rock', [0.832, 0.8, 0.678]],
      ['rock', [0.679, 0.665, 0.539]],
      ['scrub', [0.551, 0.548, 0.427]],
      ['grass', [0.444, 0.471, 0.309]],
      ['forest', [0.261, 0.316, 0.247]],
      ['seabed', [0.095, 0.127, 0.138]],
    ]
    for (const [id, rgb] of cases) {
      expect(classifySurface(ANNIV.classes, rgb)?.id, rgb.join(',')).toBe(id)
    }
  })

  it("lands the desert's red rock and pale sand where they were put", () => {
    expect(classifySurface(ANNIV.classes, [0.716, 0.41, 0.262])?.id).toBe('rock')
    expect(classifySurface(ANNIV.classes, [0.835, 0.656, 0.532])?.id).toBe('sand')
  })

  it('returns null with no classes, which is Classic', () => {
    expect(classifySurface(CLASSIC.classes, [0.5, 0.5, 0.5])).toBeNull()
  })
})

describe("Matt's order, held against the sheet", () => {
  const roughnessOf = (id: string): number => {
    const c = ANNIV.classes.find((k) => k.id === id)
    if (!c) throw new Error(`no class ${id}`)
    return c.roughness
  }

  it('rock is rougher than the water, and grass sits between them', () => {
    // The sea's own number, transcribed from its VacuumShaders _Shininess —
    // not a value in the preset.
    const ocean = TERRAIN.simonet.terrains.ocean
    const water = shininessToRoughness(ocean.material.shader, ocean.material.specular.shininess)
    expect(water).toBeCloseTo(0.269, 2)
    expect(roughnessOf('grass')).toBeGreaterThan(water)
    expect(roughnessOf('rock')).toBeGreaterThan(roughnessOf('grass'))
  })

  it('grass is shinier than every rock-like class, and every class is rougher than the 2016 single value', () => {
    const islands = TERRAIN.simonet.terrains.islands
    const single = shininessToRoughness(
      islands.material.shader,
      islands.material.specular.shininess,
    )
    expect(single).toBeCloseTo(0.1735, 3)
    for (const c of ANNIV.classes) {
      expect(c.roughness, c.id).toBeGreaterThan(single)
      if (c.id !== 'grass') expect(c.roughness, c.id).toBeGreaterThan(roughnessOf('grass'))
    }
  })

  it('Classic has no classes and is off', () => {
    expect(CLASSIC.enabled).toBe(false)
    expect(CLASSIC.classes).toEqual([])
  })
})

describe('the content validator', () => {
  const withGloss = (patch: Partial<Edition['terrain']['surfaceGloss']>): Edition => {
    const e = JSON.parse(JSON.stringify(anniversary)) as unknown as Edition
    return {
      ...e,
      terrain: { ...e.terrain, surfaceGloss: { ...e.terrain.surfaceGloss, ...patch } },
    }
  }

  it('accepts both shipped presets', () => {
    expect(validateEdition(anniversary as unknown as Edition).id).toBe('anniversary')
    expect(validateEdition(classic as unknown as Edition).id).toBe('classic')
  })

  it('refuses a swatch with two numbers — its third would read as 0', () => {
    expect(() =>
      validateEdition(
        withGloss({ classes: [{ id: 'x', roughness: 0.5, swatches: [[0.1, 0.2]] }] }),
      ),
    ).toThrow(/three colour-map values/)
  })

  it('refuses a roughness outside 0..1 and a class with no swatches', () => {
    expect(() =>
      validateEdition(
        withGloss({ classes: [{ id: 'x', roughness: 1.5, swatches: [[0.1, 0.2, 0.3]] }] }),
      ),
    ).toThrow(/roughness must be in 0..1/)
    expect(() =>
      validateEdition(withGloss({ classes: [{ id: 'x', roughness: 0.5, swatches: [] }] })),
    ).toThrow(/at least one swatch/)
  })

  it('refuses more swatches than the shader table holds', () => {
    const swatches = Array.from({ length: SURFACE_GLOSS_SWATCH_MAX + 1 }, (_, i) => [i / 20, 0, 0])
    expect(() =>
      validateEdition(withGloss({ classes: [{ id: 'x', roughness: 0.5, swatches }] })),
    ).toThrow(/table is 16/)
  })

  it('refuses a negative fade ratio', () => {
    const e = JSON.parse(JSON.stringify(anniversary)) as unknown as Edition
    const bad = {
      ...e,
      terrain: { ...e.terrain, lodFade: { ...e.terrain.lodFade, durationScale: -1 } },
    }
    expect(() => validateEdition(bad)).toThrow(/durationScale must be zero or above/)
  })
})
