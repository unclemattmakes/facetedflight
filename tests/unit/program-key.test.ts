/**
 * tests/unit/program-key.test.ts — the cache-key decoder, against three's own
 * build (DEV-239).
 *
 * ── Why the oracle is three and not this repo ────────────────────────────
 *
 * `tests/e2e/fixtures/program-key.ts` reads a `WebGLProgram.cacheKey` back into
 * its fields so that DEV-194's gate can NAME the variant that compiled in the
 * air instead of printing three hundred commas. Every one of those field
 * positions is three's PRIVATE ordering — `getProgramCacheKeyParameters` is not
 * API, the bit numbers in `_programLayers` are not API, and `three` is pinned
 * exact only until somebody moves the pin.
 *
 * CLAUDE.md: *a test that compares two of your own devices has not tested
 * either of them.* So §1 extracts the three lists out of
 * `node_modules/three/build/three.module.js` and fails when the decoder's copy
 * has drifted — the arrangement `xr-eye-layers.test.ts` and
 * `water-fog-flag.test.ts` already use. A `three` upgrade that reorders a
 * parameter turns this red, which is the measured result an upgrade is supposed
 * to land with.
 *
 * §2 then exercises the parse on keys built to three's own rule, including the
 * two that DEV-194 cost a session each: a pair that differs only in define
 * ORDER, and a pair that differs only in the fog flag.
 *
 * ── The disk work is inside the `it` ─────────────────────────────────────
 *
 * `describe.skipIf` skips the tests and not the body, and a `readFileSync` in a
 * describe body runs during COLLECTION (CLAUDE.md). There is no guard here —
 * `node_modules/three` is a dependency and is present everywhere — but the
 * placement is the habit, not the exception.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  decodeProgramCacheKey,
  describeProgramKey,
  diffProgramKeys,
  MASK_A_BITS,
  MASK_B_BITS,
  nearestWarmKey,
  PARAMETER_FIELDS,
  SHADER_IDS,
  TRAILING_FIELDS,
} from '../e2e/fixtures/program-key'
import { REPO as ROOT } from './helpers/repo-root'

const THREE_BUILD = path.join(ROOT, 'node_modules/three/build/three.module.js')

/** The body of a named function in three's bundle, up to its closing brace. */
const functionBody = (build: string, name: string): string => {
  const m = build.match(new RegExp(`function ${name}\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\t\\}`))
  expect(m, `three no longer has a top-level \`${name}\` — read the new code`).not.toBeNull()
  return (m as RegExpMatchArray)[1] as string
}

describe('§1 three still builds the key the way the decoder reads it', () => {
  it('pushes the same 48 parameters, in the same order', () => {
    const body = functionBody(fs.readFileSync(THREE_BUILD, 'utf8'), 'getProgramCacheKeyParameters')
    const names = [...body.matchAll(/array\.push\(\s*parameters\.(\w+)\s*\)/g)].map((m) => m[1])
    expect(names).toEqual([...PARAMETER_FIELDS])
  })

  it('assigns the same bits to the same booleans, in both masks', () => {
    const body = functionBody(fs.readFileSync(THREE_BUILD, 'utf8'), 'getProgramCacheKeyBooleans')
    // The two masks are separated by the first `array.push( _programLayers.mask )`.
    // Splitting on it is the same rule three's own code states, rather than a
    // line count that a reformat would break.
    const parts = body.split('array.push( _programLayers.mask );')
    expect(parts.length, 'three no longer pushes exactly two masks').toBe(3)
    const bitsOf = (chunk: string): string[] => {
      const out: string[] = []
      for (const m of chunk.matchAll(
        /if\s*\(\s*parameters\.(\w+)[^)]*\)\s*\n?\s*_programLayers\.enable\(\s*(\d+)\s*\)/g,
      ))
        out[Number(m[2])] = m[1] as string
      return out
    }
    expect(bitsOf(parts[0] as string)).toEqual([...MASK_A_BITS])
    expect(bitsOf(parts[1] as string)).toEqual([...MASK_B_BITS])
  })

  it('names its built-in shaders the same way', () => {
    const build = fs.readFileSync(THREE_BUILD, 'utf8')
    const m = build.match(/const shaderIDs = \{([\s\S]*?)\};/)
    expect(m, 'three no longer has a `shaderIDs` table').not.toBeNull()
    const ids = [...((m as RegExpMatchArray)[1] as string).matchAll(/:\s*'([\w-]+)'/g)].map(
      (x) => x[1] as string,
    )
    expect([...new Set(ids)].sort()).toEqual([...SHADER_IDS].sort())
  })

  it('still ends the key with two masks, the renderer colour space and the tag', () => {
    const body = functionBody(fs.readFileSync(THREE_BUILD, 'utf8'), 'getProgramCacheKey')
    // The order of the last three pushes is the whole of the decoder's
    // right-hand anchor. Asserting the RELATIONSHIP — colour space before the
    // custom key, both after the booleans — rather than a line number.
    const iBooleans = body.indexOf('getProgramCacheKeyBooleans( array, parameters )')
    const iColorSpace = body.indexOf('array.push( renderer.outputColorSpace )')
    const iCustom = body.indexOf('array.push( parameters.customProgramCacheKey )')
    expect(iBooleans).toBeGreaterThan(-1)
    expect(iColorSpace).toBeGreaterThan(iBooleans)
    expect(iCustom).toBeGreaterThan(iColorSpace)
    // And the defines are still walked with a `for…in`, i.e. in INSERTION
    // order — the fact DEV-194 turns on and the reason `diffProgramKeys`
    // compares them as a sequence.
    expect(body).toContain('for ( const name in parameters.defines )')
    // 48 parameters + 2 masks + 1 renderer colour space + 1 custom key.
    expect(TRAILING_FIELDS).toBe(52)
  })
})

/**
 * Build a key exactly the way `getProgramCacheKey` does, so §2 tests the parse
 * rather than a hand-typed string that happens to agree with it.
 */
const buildKey = (o: {
  shaderId?: string
  customShaderIds?: [string, string]
  defines?: [string, string][]
  parameters?: Record<string, string | number>
  maskA?: number
  maskB?: number
  rendererColorSpace?: string
  tag?: string
}): string => {
  const array: string[] = []
  if (o.shaderId !== undefined) array.push(o.shaderId)
  else array.push(...(o.customShaderIds ?? ['vert', 'frag']))
  for (const [name, value] of o.defines ?? []) array.push(name, value)
  for (const name of PARAMETER_FIELDS) array.push(String(o.parameters?.[name] ?? ''))
  array[array.length - PARAMETER_FIELDS.length] = String(o.parameters?.precision ?? 'highp')
  array.push(String(o.maskA ?? 0), String(o.maskB ?? 0))
  array.push(o.rendererColorSpace ?? 'srgb-linear')
  array.push(o.tag ?? '')
  return array.join()
}

/** The shape `int_01`'s land material actually produces, as a starting point. */
const LAND = {
  shaderId: 'physical',
  defines: [
    ['STANDARD', ''],
    ['FF2_LOD_FADE', ''],
  ] as [string, string][],
  parameters: {
    precision: 'highp',
    outputColorSpace: '',
    numDirLights: 1,
    numPointLights: 2,
    numDirLightShadows: 1,
    shadowMapType: 1,
    toneMapping: 0,
    depthPacking: 0,
  },
  // vertexColors (10) | vertexNormals (23)
  maskA: (1 << 10) | (1 << 23),
  // shadowMapEnabled (10) | opaque (17)
  maskB: (1 << 10) | (1 << 17),
  rendererColorSpace: 'srgb-linear',
  tag: '|unity-fog|lod-fade',
}

describe('§2 the decoder reads a key back into the fields three put in it', () => {
  it('finds the anchor and splits shader id, defines, parameters, flags and tag', () => {
    const d = decodeProgramCacheKey(buildKey(LAND))
    expect(d.ok).toBe(true)
    expect(d.ambiguous).toBe(false)
    expect(d.shaderId).toBe('physical')
    expect(d.customShaderIds).toBeNull()
    expect(d.defines.map((x) => x.name)).toEqual(['STANDARD', 'FF2_LOD_FADE'])
    expect(d.parameters.numPointLights).toBe('2')
    expect(d.parameters.numDirLights).toBe('1')
    expect(d.parameters.depthPacking).toBe('0')
    expect(d.flags).toEqual(['vertexColors', 'vertexNormals', 'shadowMapEnabled', 'opaque'])
    expect(d.rendererColorSpace).toBe('srgb-linear')
    expect(d.tag).toBe('|unity-fog|lod-fade')
  })

  it('reads a ShaderMaterial key, whose lead is TWO fields', () => {
    const d = decodeProgramCacheKey(
      buildKey({ customShaderIds: ['17', '42'], defines: [['USE_UV', '']] }),
    )
    expect(d.ok).toBe(true)
    expect(d.shaderId).toBeNull()
    expect(d.customShaderIds).toEqual(['17', '42'])
    expect(d.defines.map((x) => x.name)).toEqual(['USE_UV'])
  })

  it('reads a key with no defines at all', () => {
    const d = decodeProgramCacheKey(buildKey({ shaderId: 'depth', defines: [] }))
    expect(d.ok).toBe(true)
    expect(d.shaderId).toBe('depth')
    expect(d.defines).toEqual([])
  })

  it('never throws on a string that is not a cache key', () => {
    for (const junk of ['', 'physical', 'a,b,c', ',,,,,,,,']) {
      const d = decodeProgramCacheKey(junk)
      expect(d.ok).toBe(false)
      expect(d.key).toBe(junk)
    }
  })

  it('reads a RawShaderMaterial, whose key has no parameters and no masks', () => {
    // Verbatim off the live renderer in a VRto3D session on `int_01_hoverJet` —
    // three's own output pass, one key in 148. `getProgramCacheKey` guards the
    // whole parameter block with `isRawShaderMaterial === false`, so there is no
    // `precision` to anchor on and the first version of this decoder reported it
    // `UNPARSED`. Seven fields: two shader ids, two defines, one tag.
    const d = decodeProgramCacheKey(
      '10,11,SRGB_TRANSFER,,ACES_FILMIC_TONE_MAPPING,,onBeforeCompile() {}',
    )
    expect(d.ok).toBe(true)
    expect(d.raw).toBe(true)
    expect(d.customShaderIds).toEqual(['10', '11'])
    expect(d.defines.map((x) => x.name)).toEqual(['SRGB_TRANSFER', 'ACES_FILMIC_TONE_MAPPING'])
    expect(d.tag).toBe('onBeforeCompile() {}')
    // And nothing is invented for the fields three did not write.
    expect(d.parameters).toEqual({})
    expect(d.flags).toEqual([])
    // The one-line name says RAW rather than printing a row of `?`.
    const line = describeProgramKey(d)
    expect(line).toContain('RAW shader(10+11)')
    expect(line).toContain('SRGB_TRANSFER+ACES_FILMIC_TONE_MAPPING')
    expect(line).not.toContain('?')
  })

  it('keeps a tag containing commas whole', () => {
    // Not a case `src/` produces — every `tagProgramCacheKey` token is a bare
    // identifier — but the parse anchors on the LEFT of the trailing block, so
    // the whole remainder is the tag by construction rather than by luck.
    const d = decodeProgramCacheKey(buildKey({ shaderId: 'basic', tag: '|a,b|c' }))
    expect(d.tag).toBe('|a,b|c')
  })
})

describe('§3 the two DEV-194 pairs, which is what the decoder exists for', () => {
  it('reports a define ORDER difference — a set comparison would not', () => {
    const forward = decodeProgramCacheKey(
      buildKey({
        shaderId: 'physical',
        defines: [
          ['FF2_WATER_TWO_SIDED', ''],
          ['FF2_WATER_SHAFT', ''],
        ],
        tag: '|water:sr',
      }),
    )
    const reversed = decodeProgramCacheKey(
      buildKey({
        shaderId: 'physical',
        defines: [
          ['FF2_WATER_SHAFT', ''],
          ['FF2_WATER_TWO_SIDED', ''],
        ],
        tag: '|water:sr',
      }),
    )
    // The keys really are different strings — three would compile both.
    expect(forward.key).not.toBe(reversed.key)
    const diff = diffProgramKeys(forward, reversed)
    expect(diff.map((d) => d.field)).toEqual(['defines'])
    expect(diff[0]?.mine).toBe('FF2_WATER_TWO_SIDED+FF2_WATER_SHAFT')
    expect(diff[0]?.theirs).toBe('FF2_WATER_SHAFT+FF2_WATER_TWO_SIDED')
    // And the same defines as a SET are equal, which is the assertion that
    // would have passed while the bug was live.
    expect(new Set(forward.defines.map((x) => x.name))).toEqual(
      new Set(reversed.defines.map((x) => x.name)),
    )
  })

  it('names the fog flag as `useFog`, bit 1 of the second mask', () => {
    const withFog = decodeProgramCacheKey(buildKey({ shaderId: 'physical', maskB: 1 << 1 }))
    const without = decodeProgramCacheKey(buildKey({ shaderId: 'physical', maskB: 0 }))
    expect(withFog.flags).toContain('useFog')
    expect(without.flags).not.toContain('useFog')
    expect(diffProgramKeys(withFog, without).map((d) => d.field)).toEqual(['useFog'])
  })

  it('a light COUNT is one field, and the nearest warm key says which', () => {
    // DEV-186 / DEV-117: the warm-up drawn under the room's lamp builds every
    // lit program at `numPointLights` 3 while the flight wants 2.
    const warm = buildKey({ ...LAND, parameters: { ...LAND.parameters, numPointLights: 3 } })
    const flight = buildKey(LAND)
    const near = nearestWarmKey(decodeProgramCacheKey(flight), [
      warm,
      buildKey({ shaderId: 'basic' }),
    ])
    expect(near).not.toBeNull()
    expect(near?.differences.map((d) => d.field)).toEqual(['numPointLights'])
    expect(near?.differences[0]?.mine).toBe('2')
    expect(near?.differences[0]?.theirs).toBe('3')
    expect(near?.sameMaterial).toBe(true)
  })

  // ── the two-tier search, which is the int_01_jumpSeat case ──────────────
  //
  // At 8.2 s that mission compiles a `ShaderMaterial` whose own twin was in the
  // warm set two fields away — the render-target pair — while a DIFFERENT
  // ShaderMaterial sharing its tag and flags sat one field away. Fewest-fields
  // alone therefore reported `shaderId 14+15 -> 19+20`, which names a shader
  // nobody was asking about, in place of "you warmed this exact material
  // against the wrong target".
  it('prefers the SAME material two fields away to another one field away', () => {
    const material = {
      customShaderIds: ['19', '20'] as [string, string],
      tag: '|point-light-scope',
    }
    // The flight's: the session's binding.
    const flight = decodeProgramCacheKey(
      buildKey({ ...material, parameters: { outputColorSpace: 'srgb', toneMapping: 4 } }),
    )
    // Its own twin, warmed against the composer's target — two fields away.
    const ownTwin = buildKey({
      ...material,
      parameters: { outputColorSpace: 'srgb-linear', toneMapping: 0 },
    })
    // A different ShaderMaterial at the session's binding — ONE field away.
    const impostor = buildKey({
      customShaderIds: ['14', '15'],
      tag: '|point-light-scope',
      parameters: { outputColorSpace: 'srgb', toneMapping: 4 },
    })

    // The impostor really is nearer by field count, which is why this needs a
    // rule and not a tighter threshold.
    expect(diffProgramKeys(flight, decodeProgramCacheKey(impostor)).length).toBe(1)
    expect(diffProgramKeys(flight, decodeProgramCacheKey(ownTwin)).length).toBe(2)

    const near = nearestWarmKey(flight, [impostor, ownTwin])
    expect(near?.sameMaterial).toBe(true)
    expect(near?.nearest.customShaderIds).toEqual(['19', '20'])
    expect(near?.differences.map((d) => d.field)).toEqual(['outputColorSpace', 'toneMapping'])
  })

  it('falls back to the whole set when no warm key is the same material, and says so', () => {
    const flight = decodeProgramCacheKey(buildKey({ shaderId: 'physical', tag: '|brand-new' }))
    const near = nearestWarmKey(flight, [
      buildKey({ shaderId: 'physical', tag: '|something-else' }),
    ])
    expect(near?.sameMaterial).toBe(false)
    expect(near?.differences.map((d) => d.field)).toEqual(['tag'])
  })
})

describe('§4 the one-line name', () => {
  it('names the module to open, not a hash', () => {
    const line = describeProgramKey(decodeProgramCacheKey(buildKey(LAND)))
    expect(line).toContain('physical')
    expect(line).toContain('unity-fog|lod-fade')
    expect(line).toContain('FF2_LOD_FADE')
    expect(line).toContain('pt 2')
    expect(line).toContain('srgb-linear')
    expect(line).toContain('shadowMapEnabled')
    expect(line).not.toContain('ANCHOR AMBIGUOUS')
  })

  it('says so rather than guessing when it could not parse', () => {
    expect(describeProgramKey(decodeProgramCacheKey('nonsense'))).toContain('UNPARSED')
  })
})
