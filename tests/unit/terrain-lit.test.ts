// tests/unit/terrain-lit.test.ts — `?terrainLit=`, the measurement ladder.
//
// DEV-182. The terrain chunks are 51 % of the worn frame and 2.15 ms of that is
// FILL (`docs/plan/VR-PERF-WAVE-2-WORK.md` §3), and every Anniversary system
// riding on the material measured at zero (§4b) — so the cost is the BASE
// stack, and the only way to price a base stack is to render the frame without
// parts of it.
//
// ── What these gate, and what they refuse to gate ────────────────────────
//
// MECHANISMS, never milliseconds (`docs/testing/perf-protocol.md` §0): the
// class the ladder builds, the calls the `noibl` patch removes, the program
// cache key it adds, and the fact that the DEFAULT is untouched. A millisecond
// belongs to a machine and lives in the ledger row, not here.
//
// The last one is the point of the file. `standard` has to be today's material
// byte for byte or every number the sweep prints is against the wrong baseline —
// and "byte for byte" is checkable: same class, no injected GLSL, no cache-key
// tag, the same fields.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { TERRAIN } from '@/generated/constants.generated'
import {
  NO_IBL_INCLUDE,
  noIblChunk,
  noIblPatchFragment,
  parseTerrainLit,
  TERRAIN_LIT_IDS,
  type TerrainLit,
  terrainMaterial,
} from '@/render/terrain-mesh'

interface SpecLike {
  readonly intensity?: number | null
  readonly color?: readonly number[] | null
  readonly fresnel?: number | null
  readonly shininess?: number | null
}
interface MaterialLike {
  readonly shader?: string | null
  readonly tint?: readonly number[] | null
  readonly specular?: SpecLike | null
}

const materialOf = (env: string, leaf: string): MaterialLike =>
  (TERRAIN as unknown as Record<string, { terrains: Record<string, { material: MaterialLike }> }>)[
    env
  ]?.terrains[leaf]?.material as MaterialLike

/** The real sheet entry, so the Marmoset / VacuumShaders split is a FACT. */
const build = (
  env: string,
  leaf: string,
  lit?: TerrainLit,
  tintIsSrgb?: boolean,
): THREE.Material => {
  const m = materialOf(env, leaf)
  const s = m.specular ?? null
  return terrainMaterial({
    tint: (m.tint ?? null) as [number, number, number] | null,
    shader: m.shader ?? null,
    ...(lit === undefined ? {} : { lit }),
    ...(tintIsSrgb === undefined ? {} : { tintIsSrgb }),
    specular: s
      ? {
          intensity: s.intensity ?? null,
          shininess: s.shininess ?? null,
          iblBrightness: null,
          color: s.color ?? null,
          fresnel: s.fresnel ?? null,
        }
      : null,
  })
}

describe('parsing', () => {
  it('takes each of the four rungs and nothing else', () => {
    for (const id of TERRAIN_LIT_IDS) expect(parseTerrainLit(id)).toBe(id)
    expect(parseTerrainLit(null)).toBeNull()
  })

  it('warns and ignores a typo rather than rendering a black page', () => {
    // `parseQualityPin`'s rule, for its reason: this is typed into an address
    // bar by hand and a bad query string must never be a black page.
    const said: string[] = []
    expect(parseTerrainLit('phong', (m) => said.push(m))).toBeNull()
    expect(said).toHaveLength(1)
    expect(said[0]).toContain('standard')
  })
})

describe('the ladder builds the class it names', () => {
  it.each([
    ['standard', 'MeshPhysicalMaterial'],
    ['noibl', 'MeshPhysicalMaterial'],
    ['lambert', 'MeshLambertMaterial'],
    ['basic', 'MeshBasicMaterial'],
  ] as const)('%s -> %s', (lit, type) => {
    // Simonet's island carries a Marmoset F0, so `standard` is the PHYSICAL
    // class — see `terrainMaterial`'s own note. `noibl` must be the same class
    // and the same parameters: the whole claim is that it differs by two
    // texture fetches and by nothing else.
    expect(build('simonet', 'islands', lit).type).toBe(type)
  })

  it('leaves the coarse rungs no roughness or metalness to be wrong about', () => {
    for (const lit of ['lambert', 'basic'] as const) {
      const m = build('simonet', 'islands', lit) as unknown as Record<string, unknown>
      expect('roughness' in m, `${lit}.roughness`).toBe(false)
      expect('metalness' in m, `${lit}.metalness`).toBe(false)
      expect(m.vertexColors, `${lit}.vertexColors`).toBe(true)
      expect(m.side, `${lit}.side`).toBe(THREE.FrontSide)
    }
  })
})

describe('LAND ONLY, by the same fact the F0 uses', () => {
  it('ignores the switch on a VacuumShaders surface', () => {
    // The ocean's shader is patched by `render/water.ts` for the Blinn lobe,
    // the coast and the waves, and every one of those anchors on a chunk a
    // coarser class does not have. So the sea keeps the shipped stack whatever
    // the URL says — and it is excluded by the shader string in the sheet, not
    // by a second rule that could drift from the first.
    for (const lit of TERRAIN_LIT_IDS) {
      expect(build('simonet', 'ocean', lit).type, lit).toBe('MeshStandardMaterial')
    }
  })

  it('and the land is genuinely the other case, so that test can fail', () => {
    // The loud counterpart. Without it the assertion above is satisfied by a
    // switch that does nothing at all.
    expect(build('simonet', 'islands', 'basic').type).toBe('MeshBasicMaterial')
  })
})

describe('the default is today, byte for byte', () => {
  it('builds the same thing with no `lit` as with `standard`', () => {
    for (const [env, leaf] of [
      ['simonet', 'islands'],
      ['simonet', 'ocean'],
      ['desert', 'canyon'],
      ['alpine', 'forest'],
    ] as const) {
      const bare = build(env, leaf) as unknown as Record<string, unknown>
      const named = build(env, leaf, 'standard') as unknown as Record<string, unknown>
      expect(named.type, `${env}.${leaf} class`).toBe(bare.type)
      expect(named.roughness, `${env}.${leaf} roughness`).toBe(bare.roughness)
      expect(named.envMapIntensity, `${env}.${leaf} envMapIntensity`).toBe(bare.envMapIntensity)
    }
  })

  it('still converts the tint, and every rung carries the same one', () => {
    // The restructure that made room for the ladder lifted the tint expression
    // out of the constructor call, and nothing else in the suite looks at the
    // terrain's COLOUR at all — so this is the guard for a move that a
    // typecheck cannot see.
    //
    // Asserted as a RELATIONSHIP, not by re-deriving `srgbToLinear` the way the
    // implementation does, which would be the belief written twice (trap 24):
    // sRGB -> linear is strictly darkening strictly between 0 and 1, so the
    // converted tint must be DARKER on every channel than `?tint=raw`'s. And
    // the colour must not depend on the rung — the tint is not what the ladder
    // is about, and a rung that changed it would confound every photograph.
    for (const [env, leaf] of [
      ['simonet', 'islands'],
      ['desert', 'canyon'],
      ['alpine', 'forest'],
    ] as const) {
      const conv = build(env, leaf) as THREE.MeshStandardMaterial
      const raw = build(env, leaf, 'standard', false) as THREE.MeshStandardMaterial
      for (const ch of ['r', 'g', 'b'] as const) {
        expect(conv.color[ch], `${env}.${leaf} ${ch}`).toBeLessThan(raw.color[ch])
        expect(conv.color[ch], `${env}.${leaf} ${ch} > 0`).toBeGreaterThan(0)
      }
      for (const lit of TERRAIN_LIT_IDS) {
        const m = build(env, leaf, lit) as THREE.MeshStandardMaterial
        expect(m.color.getHex(), `${env}.${leaf} ${lit}`).toBe(conv.color.getHex())
      }
    }
  })

  it('injects no GLSL and adds no cache-key token on the default path', () => {
    // `onBeforeCompile` and `customProgramCacheKey` are three's own defaults
    // until something patches them. If either has moved here, the shipped
    // material is not the shipped material and the sweep's baseline is a
    // different build from the one in the headset.
    const stock = new THREE.MeshPhysicalMaterial()
    const m = build('simonet', 'islands')
    expect(m.onBeforeCompile).toBe(stock.onBeforeCompile)
    expect(m.customProgramCacheKey()).toBe(stock.customProgramCacheKey())
  })
})

describe('noibl removes the fetches and nothing else', () => {
  it("finds both calls in three's own chunk — the upgrade guard", () => {
    // `noIblChunk` throws if either has changed shape. Calling it here is the
    // assertion: a build that boots, renders and has silently stopped removing
    // the thing it claims to remove is the worst outcome (DEV-069).
    expect(() => noIblChunk()).not.toThrow()
    const stock = THREE.ShaderChunk.lights_fragment_maps
    expect(stock).toContain('getIBLIrradiance(')
    expect(stock).toContain('getIBLRadiance(')
  })

  it('takes out the two calls and leaves the rest of the chunk alone', () => {
    const stock = THREE.ShaderChunk.lights_fragment_maps
    const cut = noIblChunk()
    expect(cut).not.toContain('iblIrradiance += getIBLIrradiance(')
    expect(cut).not.toContain('radiance += getIBLRadiance( geometryViewDir, geometryNormal,')
    // Surgical: the lightmap branch, the clearcoat branch and the anisotropy
    // branch are all still there, because the claim is "two fetches gone", not
    // "the indirect block rewritten".
    for (const keep of ['USE_LIGHTMAP', 'lightMapIntensity', 'USE_CLEARCOAT', 'USE_ANISOTROPY']) {
      expect(cut, keep).toContain(keep)
    }
    // And it really is a cut rather than a rewrite: only the two statements
    // differ in length.
    expect(stock.length - cut.length).toBe(
      'iblIrradiance += getIBLIrradiance( geometryNormal );'.length +
        'radiance += getIBLRadiance( geometryViewDir, geometryNormal, material.roughness );'.length,
    )
  })

  it('splices into the real physical fragment shader', () => {
    const src = THREE.ShaderLib.physical.fragmentShader
    expect(src).toContain(NO_IBL_INCLUDE)
    const patched = noIblPatchFragment(src)
    expect(patched).not.toContain(NO_IBL_INCLUDE)
    expect(patched).not.toContain('iblIrradiance += getIBLIrradiance(')
  })

  it('returns the source unchanged where the include is absent', () => {
    // A `basic` program has no `lights_fragment_maps`. Unchanged rather than
    // thrown, for `illustrativePatchFragment`'s reason — and the test above is
    // what stops "unchanged" becoming the normal case unnoticed.
    const src = THREE.ShaderLib.basic.fragmentShader
    expect(src).not.toContain(NO_IBL_INCLUDE)
    expect(noIblPatchFragment(src)).toBe(src)
  })

  it('tags the program cache key, because onBeforeCompile is not in it', () => {
    // `render/program-cache-key.ts`: two materials that differ only in their
    // injected GLSL hash identically and share one compiled program, and which
    // one wins is creation order. An untagged `noibl` would render the island
    // with whichever of the two compiled first — a coin flip per run.
    const patched = build('simonet', 'islands', 'noibl')
    const plain = build('simonet', 'islands', 'standard')
    expect(patched.customProgramCacheKey()).not.toBe(plain.customProgramCacheKey())
    expect(patched.customProgramCacheKey()).toContain('terrainLit-noibl')
  })

  it('actually patches the shader source it is handed', () => {
    const patched = build('simonet', 'islands', 'noibl')
    const shader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    }
    patched.onBeforeCompile(
      shader as unknown as THREE.WebGLProgramParametersWithUniforms,
      null as unknown as THREE.WebGLRenderer,
    )
    expect(shader.fragmentShader).not.toContain('iblIrradiance += getIBLIrradiance(')
    expect(shader.fragmentShader).not.toContain(NO_IBL_INCLUDE)
  })
})
