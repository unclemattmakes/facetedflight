// tests/unit/fragment-gates.test.ts
//
// The failure this file exists to make impossible: **a gate that does nothing
// reads as a cut that costs nothing.**
//
// That is not a hypothetical. `perf-scale.spec.ts` prices an arm by rendering
// with the define set and reading the GPU; if the define never reaches the
// preprocessor, or the statement it guards is not the statement that costs, the
// arm comes back at 0.00 ms and the conclusion is "the IBL is free" — which is
// indistinguishable, from the outside, from a real result. Three rankings were
// retracted this month for exactly that shape (`VR-PERF-WAVE-2-WORK.md` §7).
//
// So the assertions here are about the PREPROCESSED text, through a gate-only
// preprocessor written against C's semantics rather than against the patch.
// That is deliberate: a test that re-derives its expectation the way the code
// does has not tested the code (CLAUDE.md, trap 24). `gateFragmentShader`
// inserts directives; this file evaluates them the way a driver will and asks
// whether the named thing is gone.
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  FRAGMENT_GATES,
  GATE_NO_IBL,
  GATE_NO_POINT_LIGHTS,
  GATE_UNLIT,
  gateFragmentShader,
  installFragmentGates,
  parseFragmentGates,
  setFragmentGates,
} from '@/render/fragment-gates'
import { preprocessGates } from './support/gate-preprocessor'

// The preprocessor moved to `support/gate-preprocessor.ts` when DEV-238's
// water gates needed the same one. It is imported above rather than copied:
// two preprocessors that are supposed to agree are two that will not, and the
// one that drifts is the one whose test still passes.

/**
 * A stand-in for the shader a terrain material hands `onBeforeCompile`, with
 * the three includes UNEXPANDED — the shape when nothing else has patched yet.
 */
const rawShader = (): string =>
  [
    'void main() {',
    '\t#include <lights_fragment_maps>',
    '\t#include <lights_fragment_begin>',
    '\t#include <opaque_fragment>',
    '}',
  ].join('\n')

/**
 * The same shader with `lights_fragment_begin` already expanded, which is what
 * `far-shadow.ts` leaves behind. The gates have to cope with both, and this is
 * the half that the include-only anchor would silently miss.
 */
const farShadowedShader = (): string =>
  rawShader().replace('\t#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin)

const material = (): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial()

describe('fragment gates — the default does not move', () => {
  it('leaves every gated statement in place when no define is set', () => {
    const gated = preprocessGates(gateFragmentShader(rawShader()), [])
    expect(gated).toContain('iblIrradiance += getIBLIrradiance( geometryNormal );')
    expect(gated).toContain('radiance += getIBLRadiance(')
    expect(gated).toContain('gl_FragColor = vec4( outgoingLight, diffuseColor.a );')
    // The point-light loop opens on a condition three controls, so the check is
    // that our clause cannot be what closes it: with the define absent,
    // `! defined( FF2_NO_POINT_LIGHTS )` is true and the line is three's again.
    expect(gated).toContain('#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )')
    expect(gated).toContain('RE_Direct( directLight,')
  })

  it('writes the unlit colour NOWHERE when the define is absent', () => {
    const gated = preprocessGates(gateFragmentShader(rawShader()), [])
    expect(gated).not.toContain('vec4( diffuseColor.rgb, 1.0 )')
  })
})

describe('fragment gates — each define removes the thing it names', () => {
  it('FF2_NO_IBL removes both PMREM fetches and nothing else', () => {
    const on = preprocessGates(gateFragmentShader(rawShader()), [GATE_NO_IBL])
    expect(on).not.toContain('iblIrradiance += getIBLIrradiance(')
    expect(on).not.toContain('radiance += getIBLRadiance( geometryViewDir, geometryNormal,')
    // The CLEARCOAT fetch stays, and must: it is behind `#ifdef USE_CLEARCOAT`,
    // which the terrain never defines, so three's own preprocessor removes it —
    // and DEV-182's `noibl`, the rung these photographs priced, cut exactly the
    // two statements above and left this one. A gate that cut more than the
    // photographed rung would be pricing a different picture.
    expect(on).toContain('clearcoatRadiance += getIBLRadiance(')
    // The lightmap branch and the direct lighting are not this gate's business.
    expect(on).toContain('#ifdef USE_LIGHTMAP')
    expect(on).toContain('RE_Direct( directLight,')
    expect(on).toContain('gl_FragColor = vec4( outgoingLight, diffuseColor.a );')
  })

  it('FF2_NO_POINT_LIGHTS closes the point-light block and leaves the others', () => {
    const src = gateFragmentShader(rawShader())
    // `#if A && B && ! defined( X )` is three's own condition, so our
    // preprocessor cannot evaluate it. Assert on the TEXT: the clause is on the
    // point-light `#if` and on no other light block's.
    const pointIf = src
      .split('\n')
      .filter((l) => l.includes('NUM_POINT_LIGHTS > 0') && l.includes('RE_Direct'))
    expect(pointIf).toHaveLength(1)
    expect(pointIf[0]).toContain(`! defined( ${GATE_NO_POINT_LIGHTS} )`)
    for (const other of ['NUM_DIR_LIGHTS', 'NUM_SPOT_LIGHTS', 'NUM_RECT_AREA_LIGHTS']) {
      const lines = src.split('\n').filter((l) => l.includes(`${other} > 0`))
      for (const line of lines) expect(line).not.toContain(GATE_NO_POINT_LIGHTS)
    }
  })

  it('FF2_UNLIT replaces the output write rather than adding a second one', () => {
    const on = preprocessGates(gateFragmentShader(rawShader()), [GATE_UNLIT])
    expect(on).toContain('gl_FragColor = vec4( diffuseColor.rgb, 1.0 );')
    expect(on).not.toContain('gl_FragColor = vec4( outgoingLight, diffuseColor.a );')
    // Exactly one write, or the driver keeps the lighting alive to feed a
    // value nothing reads and the "floor" is not a floor.
    expect(on.split('gl_FragColor =').length - 1).toBe(1)
  })
})

describe('fragment gates — the anchors survive the other patches', () => {
  it('gates a shader whose lights_fragment_begin is already expanded', () => {
    const src = gateFragmentShader(farShadowedShader())
    expect(src).toContain(`! defined( ${GATE_NO_POINT_LIGHTS} )`)
    // And it did not expand the chunk a SECOND time on top of the first.
    expect(src.split('IncidentLight directLight;').length - 1).toBe(1)
  })

  it('throws rather than silently skipping when an anchor is gone', () => {
    // A shader with neither the include nor the statement: another patch has
    // rewritten it into a shape this file does not know.
    const broken = rawShader().replace('\t#include <opaque_fragment>', '\t// somebody else had it')
    expect(() => gateFragmentShader(broken)).toThrow(/opaque_fragment/)
  })
})

describe('fragment gates — setting them on a material', () => {
  it('defines exactly the wanted set and reports whether anything moved', () => {
    const m = material()
    expect(setFragmentGates(m, ['noIbl'])).toBe(true)
    expect(m.defines?.[GATE_NO_IBL]).toBe('')
    expect(m.defines?.[GATE_UNLIT]).toBeUndefined()
    // Idempotent: a sweep that sets the same arm twice must not pay a recompile
    // for the second, or the reading after it is measuring a compile.
    expect(setFragmentGates(m, ['noIbl'])).toBe(false)
    expect(setFragmentGates(m, ['unlit'])).toBe(true)
    expect(m.defines?.[GATE_NO_IBL]).toBeUndefined()
    expect(m.defines?.[GATE_UNLIT]).toBe('')
    expect(setFragmentGates(m, [])).toBe(true)
    for (const gate of FRAGMENT_GATES) expect(m.defines?.[gate]).toBeUndefined()
  })

  it('asks three to re-fetch a program only on a real change', () => {
    const m = material()
    m.needsUpdate = false
    expect(setFragmentGates(m, [])).toBe(false)
    setFragmentGates(m, ['noIbl'])
    // `needsUpdate` is a setter that bumps `version`; read the version instead,
    // because the flag itself does not stay true.
    const after = m.version
    expect(setFragmentGates(m, ['noIbl'])).toBe(false)
    expect(m.version).toBe(after)
  })

  it('installs one patch however many times it is asked', () => {
    const m = material()
    const base = m.onBeforeCompile
    installFragmentGates(m)
    const once = m.onBeforeCompile
    installFragmentGates(m)
    expect(m.onBeforeCompile).toBe(once)
    expect(once).not.toBe(base)
  })

  it('keeps the gates out of the program cache key by NAME but in it by define', () => {
    // Three hashes `material.defines` itself, which is what makes the flip
    // fetch a different program; the custom key is for the `onBeforeCompile`,
    // which three does not hash at all (`render/program-cache-key.ts`).
    const m = material()
    const bare = m.customProgramCacheKey()
    installFragmentGates(m)
    expect(m.customProgramCacheKey()).not.toBe(bare)
    expect(m.customProgramCacheKey()).toContain('fragment-gates')
  })
})

describe('fragment gates — parsing', () => {
  it('takes the known names, drops the rest with a warning', () => {
    const warned: string[] = []
    expect(parseFragmentGates('noIbl,unlit', (m) => warned.push(m))).toEqual(['noIbl', 'unlit'])
    expect(warned).toHaveLength(0)
    expect(parseFragmentGates('noIbl,nope', (m) => warned.push(m))).toEqual(['noIbl'])
    expect(warned).toHaveLength(1)
    expect(parseFragmentGates(null)).toEqual([])
    expect(parseFragmentGates('')).toEqual([])
    expect(parseFragmentGates('noIbl,noIbl')).toEqual(['noIbl'])
  })
})

describe('fragment gates — a define this module did not set is one it may not clear', () => {
  it('never takes FF2_LOD_FADE off a live fade clone', () => {
    // The shape that would break silently: `lod-fade.ts` sets this define on the
    // pooled clones of a cross-fade, those clones hang off chunk meshes, and a
    // sweep that walks a terrain group to find everything it draws finds them.
    // Clearing an arm would then strip the define the fade needs and the fade
    // would stop discarding for the rest of the session — no error, no wrong
    // colour, just both LODs drawn solid on top of each other.
    const clone = new THREE.MeshStandardMaterial()
    clone.defines = { ...(clone.defines ?? {}), FF2_LOD_FADE: '' }
    expect(setFragmentGates(clone, ['noIbl'])).toBe(true)
    expect(clone.defines?.FF2_LOD_FADE).toBe('')
    expect(setFragmentGates(clone, [])).toBe(true)
    expect(clone.defines?.FF2_LOD_FADE).toBe('')
    expect(clone.defines?.[GATE_NO_IBL]).toBeUndefined()
  })

  it('still clears a lodFade arm it set itself', () => {
    const base = new THREE.MeshStandardMaterial()
    expect(base.defines?.FF2_LOD_FADE).toBeUndefined()
    setFragmentGates(base, ['lodFade'])
    expect(base.defines?.FF2_LOD_FADE).toBe('')
    setFragmentGates(base, [])
    expect(base.defines?.FF2_LOD_FADE).toBeUndefined()
  })
})
