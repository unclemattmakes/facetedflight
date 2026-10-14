// tests/unit/water-gates.test.ts — DEV-238. The ocean's arms, and the one
// thing that must not move.
//
// ── What this file exists to make impossible ─────────────────────────────
//
// Two failures, and they look identical from the outside.
//
//  1. **A gate that does nothing reads as a cut that costs nothing.** The arm
//     comes back at 0.00 ms and the conclusion is "the sea's glint is free",
//     which is indistinguishable from a result. Three rankings were retracted
//     this month for exactly that shape (`VR-PERF-WAVE-2-WORK.md` §7), and
//     DEV-231 found that four of five `ARM DID NOT FIRE` rows were *true*
//     non-results while one was a false negative — a distinction nothing in
//     the harness could draw until it was built to.
//  2. **A gate that moves the DEFAULT.** These are instruments, not features.
//     If the shipped program changes because the gates exist, every number
//     taken before them is void and the ranking has to be retaken — §3e of the
//     protocol, *a ranking is only as good as the build it was taken on.*
//
// So the assertions are about the PREPROCESSED text, through a gate-only
// preprocessor written against C's semantics rather than against the patch
// (`support/gate-preprocessor.ts`). `water.ts` inserts directives; this file
// evaluates them the way a driver will and asks whether the named thing is
// gone. A test that re-derives its expectation the way the code does has not
// tested the code (CLAUDE.md, trap 24).
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { TERRAIN } from '@/generated/constants.generated'
import { SUN_HEIGHT_GLSL } from '@/render/far-shadow'
import {
  FRAGMENT_GATES,
  type FragmentGate,
  GATE_DEFINES,
  GATE_NO_SUN_HEIGHT,
  GATE_WATER_NO_COAST,
  GATE_WATER_NO_NORMAL,
  GATE_WATER_NO_REFLECT,
  GATE_WATER_NO_SPECULAR,
  setFragmentGates,
} from '@/render/fragment-gates'
import { applyWaterWaves } from '@/render/water'
import int01 from '../../content/levels/int_01_hoverJet.json'
import { preprocessGates, stripGateDirectives } from './support/gate-preprocessor'

const WATER_GATES = [
  GATE_WATER_NO_COAST,
  GATE_WATER_NO_NORMAL,
  GATE_WATER_NO_SPECULAR,
  GATE_WATER_NO_REFLECT,
] as const

/**
 * The statement each gate is FOR, one per gate.
 *
 * Named by what costs rather than by the gate's own name, because those are
 * two different claims and only the first one is about the frame. A gate whose
 * define lands but whose statement is somewhere else in the shader is the
 * failure mode this pairing catches.
 */
const GUARDED: Readonly<Record<(typeof WATER_GATES)[number], string>> = {
  [GATE_WATER_NO_COAST]: 'ff2Coast(diffuseColor.rgb',
  [GATE_WATER_NO_NORMAL]: 'vec3 dPdx = dFdx(vWaterWorld);',
  [GATE_WATER_NO_SPECULAR]: 'outgoingLight += uSpec.rgb',
  [GATE_WATER_NO_REFLECT]: 'outgoingLight += sky * uReflect.rgb',
}

/**
 * A stand-in for the shader three hands a water material, carrying the four
 * include hooks `water.ts` patches and nothing else.
 *
 * `applyWaterWaves` is three string replaces on three fragment hooks plus one
 * on the vertex hook; a stub is enough, and it is what `water-underside.test.ts`
 * already uses. The hooks are spelled out so that a hook this patch stops
 * needing — or starts needing — shows up here as an edit rather than as a
 * silent no-op.
 */
const stubShader = (): { uniforms: object; vertexShader: string; fragmentShader: string } => ({
  uniforms: {},
  vertexShader: '#include <begin_vertex>',
  fragmentShader: [
    'void main() {',
    '#include <color_fragment>',
    '#include <normal_fragment_begin>',
    '#include <opaque_fragment>',
    '}',
  ].join('\n'),
})

interface StubMaterial {
  side: number
  needsUpdate: boolean
  /** DEV-936: the sea frees its coast map on its material's dispose event. */
  addEventListener: () => void
  defines?: Record<string, string>
  name?: string
  customProgramCacheKey?: () => string
  onBeforeCompile?: (shader: ReturnType<typeof stubShader>) => void
  clone?: () => StubMaterial
}

/** The sea `int_01_hoverJet` draws: Simonet's ocean, with its glint and its sky. */
const patchedWaterFragment = (): string => {
  const material: StubMaterial = { side: 0, needsUpdate: false, addEventListener: () => {} }
  const ocean = TERRAIN.simonet.terrains.ocean
  applyWaterWaves(material as unknown as Parameters<typeof applyWaterWaves>[0], ocean.displace, {
    specColor: ocean.material.specular.color,
    shininess: ocean.material.specular.shininess,
    sun: {
      direction: int01.lighting.sun.direction,
      colorLinear: int01.lighting.sun.colorLinear,
      intensity: int01.lighting.sun.intensity,
    },
    color: ocean.material.reflection.color,
    fresnel: ocean.material.reflection.fresnel,
    skySh: (int01.lighting.sky as { sh: number[][] }).sh,
    facetMetres: 32,
  })
  const shader = stubShader()
  material.onBeforeCompile?.(shader)
  return shader.fragmentShader
}

describe('the ocean’s arms — each one removes the thing it names', () => {
  it('splices a gate for every term water.ts injects', () => {
    const frag = patchedWaterFragment()
    for (const gate of WATER_GATES) {
      expect(frag, `${gate} is not in the patched shader at all`).toContain(gate)
      expect(frag, `${gate} has nothing to guard`).toContain(GUARDED[gate])
    }
  })

  it('removes exactly its own statement and leaves the other three', () => {
    // The one-at-a-time sweep is the point. A gate that took two terms out
    // would price two systems as one, which is the failure DEV-230's 2x2 was
    // retracted for in a different costume — an arm that moved more than it
    // said it moved.
    const frag = patchedWaterFragment()
    for (const gate of WATER_GATES) {
      const cut = preprocessGates(frag, [gate], WATER_GATES)
      expect(cut, `${gate} did not remove ${GUARDED[gate]}`).not.toContain(GUARDED[gate])
      for (const other of WATER_GATES) {
        if (other === gate) continue
        expect(cut, `${gate} also removed ${other}'s statement`).toContain(GUARDED[other])
      }
    }
  })

  it('leaves the two discards alone, because they are the OTHER axis', () => {
    // `FF2_WATER_TWO_SIDED` and `FF2_WATER_SHAFT` are the variant switch
    // `setEyeHeight` throws every frame, and DEV-209 has already priced the
    // second at 0.06 ms. A normal-derivation arm that also deleted them would
    // be measuring three things and reporting one.
    const cut = preprocessGates(patchedWaterFragment(), [GATE_WATER_NO_NORMAL], WATER_GATES)
    expect(cut).toContain('#ifdef FF2_WATER_TWO_SIDED')
    expect(cut).toContain('#ifdef FF2_WATER_SHAFT')
    // And the shading still has a normal to work with: the gate drops the
    // derivation, not the variable, so `normal_fragment_begin`'s own answer
    // stands and the specular below still compiles.
    expect(cut).toContain('outgoingLight += uSpec.rgb')
  })

  it('keeps the under-water window, which was already gated by geometry', () => {
    // PERF-JOURNEY §4's first negative: the refraction is reached only when
    // `waterEyeSide < 0`, i.e. with the eye under the surface. Re-gating it
    // would be a second switch on one term, and the row says not to re-run it.
    const frag = patchedWaterFragment()
    expect(frag).toContain('if (waterEyeSide(vWaterWorld) < 0.0) {')
    expect(frag).toContain('outgoingLight += waterThroughSurface(viewDir, normal)')
  })
})

describe('the ocean’s arms — the default does not move', () => {
  it('keeps every gated statement when no define is set', () => {
    const plain = preprocessGates(patchedWaterFragment(), [], WATER_GATES)
    for (const gate of WATER_GATES) expect(plain).toContain(GUARDED[gate])
  })

  it('changes the shipped text by the directive lines and by NOTHING else', () => {
    // The stronger half, and the one that would catch a gate that reindented,
    // reordered or reworded a line it was only meant to bracket. With no define
    // set, the text a driver compiles must be the text with our `#ifndef`s and
    // their `#endif`s deleted — byte for byte, including the whitespace.
    const frag = patchedWaterFragment()
    expect(preprocessGates(frag, [], WATER_GATES)).toBe(stripGateDirectives(frag, WATER_GATES))
  })

  it('puts no gate define on the material by default', () => {
    // A define is what fetches a different program. The gates are `#ifndef`s
    // the preprocessor removes when their name is absent, so the compiled
    // default is the one this build has always drawn — but only while nothing
    // SETS one at construction.
    const material: StubMaterial = { side: 0, needsUpdate: false, addEventListener: () => {} }
    const ocean = TERRAIN.simonet.terrains.ocean
    applyWaterWaves(material as unknown as Parameters<typeof applyWaterWaves>[0], ocean.displace, {
      specColor: ocean.material.specular.color,
      shininess: ocean.material.specular.shininess,
      sun: {
        direction: int01.lighting.sun.direction,
        colorLinear: int01.lighting.sun.colorLinear,
        intensity: int01.lighting.sun.intensity,
      },
      color: ocean.material.reflection.color,
      fresnel: ocean.material.reflection.fresnel,
      skySh: (int01.lighting.sky as { sh: number[][] }).sh,
      facetMetres: 32,
    })
    for (const gate of FRAGMENT_GATES) {
      expect(material.defines?.[GATE_DEFINES[gate]], `${gate} is set at construction`).toBe(
        undefined,
      )
    }
    // The two the sea DOES carry by default are the variant switch's, and the
    // file's own `applyVariant(true)` is what puts the first one there.
    expect(material.defines?.FF2_WATER_TWO_SIDED).toBe('')
  })
})

describe('the sun-height lookup has an arm, and it cuts the FETCH', () => {
  it('returns before the texture read rather than after it', () => {
    // A gate placed after the sample would price a multiply. The whole cost of
    // this term on a water fragment is one `texture2D`, one `fwidth` and one
    // `smoothstep`, and only a return above them removes those.
    const guard = SUN_HEIGHT_GLSL.indexOf(`#ifdef ${GATE_NO_SUN_HEIGHT}`)
    const fetch = SUN_HEIGHT_GLSL.indexOf('texture2D( uSunTopMap, uv )')
    expect(guard).toBeGreaterThan(-1)
    expect(fetch).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(fetch)
  })

  it('spells the same name the registry does', () => {
    // The GLSL carries the name as a literal on purpose — `SUN_HEIGHT_GLSL` is
    // built at module init, and an import cycle that returned `undefined` there
    // would produce `#ifdef undefined` in a shader nobody reads. So the single
    // source is asserted here instead of imported there. Trap 24: the
    // relationship, not the value.
    expect(SUN_HEIGHT_GLSL).toContain(`#ifdef ${GATE_NO_SUN_HEIGHT}`)
    expect(GATE_DEFINES.noSunHeight).toBe(GATE_NO_SUN_HEIGHT)
  })
})

describe('setting a gate on a sea whose bands SHARE one defines object', () => {
  /**
   * The ocean, as `water.ts` builds it: a base and its per-LOD band clones,
   * every one of them pointing at the base's own `defines` object.
   *
   * Built with real `THREE.MeshStandardMaterial`s rather than stubs, because
   * the thing under test is three's rule that a material keeps its compiled
   * program until `version` moves — and `version` is three's, not ours.
   */
  const sharedFamily = (): { base: THREE.Material; bands: THREE.Material[] } => {
    const base = new THREE.MeshStandardMaterial()
    base.defines = { STANDARD: '' }
    const bands = [0, 1, 2].map(() => {
      const clone = new THREE.MeshStandardMaterial()
      // The line `materialFor` writes, and the whole reason this test exists.
      clone.defines = base.defines as Record<string, string>
      return clone as THREE.Material
    })
    return { base, bands }
  }

  it('bumps every band’s version, not just the base’s', () => {
    // ── The bug, stated as the number an arm would have printed ──────────
    //
    // `__ff2.fragmentGates([...], 'ocean')` calls `setFragmentGates` once per
    // water material. Before DEV-238 the base mutated the shared object and
    // got `needsUpdate`; every band after it saw `want === has` on that same
    // object, returned false, and kept its old program. The sea would have
    // drawn ONE band gated and the rest ungated, and the arm would have
    // reported `moved: 1` — which reads like a mechanism check passing.
    const { base, bands } = sharedFamily()
    const before = [base, ...bands].map((m) => m.version)
    const moved = [base, ...bands].map((m) => setFragmentGates(m, ['noIbl']))
    expect(moved, 'a band that did not move is a band still on the old program').toEqual([
      true,
      true,
      true,
      true,
    ])
    const after = [base, ...bands].map((m) => m.version)
    for (let i = 0; i < after.length; i++) {
      expect(after[i], `material ${i} kept its program`).toBeGreaterThan(before[i] as number)
    }
  })

  it('still charges nothing for setting the same arm twice', () => {
    // The property the original comment defends and a sweep depends on:
    // `needsUpdate` drops the program reference, so a second `set` of the same
    // arm would put a compile inside the reading after it.
    const { base, bands } = sharedFamily()
    for (const m of [base, ...bands]) setFragmentGates(m, ['noIbl'])
    const settled = [base, ...bands].map((m) => m.version)
    const moved = [base, ...bands].map((m) => setFragmentGates(m, ['noIbl']))
    expect(moved).toEqual([false, false, false, false])
    expect([base, ...bands].map((m) => m.version)).toEqual(settled)
  })

  it('puts every band back when the arm is cleared', () => {
    const { base, bands } = sharedFamily()
    for (const m of [base, ...bands]) setFragmentGates(m, ['waterNoSpecular'])
    const moved = [base, ...bands].map((m) => setFragmentGates(m, []))
    expect(moved).toEqual([true, true, true, true])
    for (const m of [base, ...bands]) {
      expect(m.defines?.[GATE_WATER_NO_SPECULAR]).toBeUndefined()
    }
  })

  it('never reads its own arm back as a band’s floor', () => {
    // A band cut WHILE an arm is live shares the object the arm is written in.
    // Reading those defines as "what this material carried before we touched
    // it" would make the arm un-clearable on that band — a page contaminated
    // for the rest of the session, by an arm that looked like it went back.
    const { base } = sharedFamily()
    setFragmentGates(base, ['noIbl'])
    const late = new THREE.MeshStandardMaterial()
    late.defines = base.defines as Record<string, string>
    expect(setFragmentGates(late, [])).toBe(true)
    expect(late.defines?.[GATE_DEFINES.noIbl]).toBeUndefined()
    expect(base.defines?.[GATE_DEFINES.noIbl]).toBeUndefined()
  })
})

describe('a multi-gate arm has ONE cache key, whatever order it was reached by', () => {
  /** three's own rule: `getProgramCacheKey` walks `defines` in insertion order. */
  const order = (m: THREE.Material): string[] => Object.keys(m.defines ?? {})

  it('reaches the same insertion order from either direction', () => {
    // DEV-194, in the form that cost a 318 ms compile in the air: `{A,B}` and
    // `{B,A}` are TWO keys for one piece of GLSL. Before DEV-238 this function
    // appended whatever was missing and left whatever was there, so an arm's
    // key was a function of the order the sweep happened to visit its arms in
    // rather than of the arm — and the warm-up can only ever build one of them.
    const viaA = new THREE.MeshStandardMaterial()
    setFragmentGates(viaA, ['noIbl'])
    setFragmentGates(viaA, ['noIbl', 'unlit'])

    const viaB = new THREE.MeshStandardMaterial()
    setFragmentGates(viaB, ['unlit'])
    setFragmentGates(viaB, ['unlit', 'noIbl'])

    expect(order(viaA)).toEqual(order(viaB))
  })

  it('orders a whole-set arm by FRAGMENT_GATES, from any starting point', () => {
    const all = [...FRAGMENT_GATES] as FragmentGate[]
    const expected = all.map((g) => GATE_DEFINES[g])
    const fresh = new THREE.MeshStandardMaterial()
    setFragmentGates(fresh, all)
    expect(order(fresh).filter((k) => expected.includes(k))).toEqual(expected)

    const roundabout = new THREE.MeshStandardMaterial()
    for (const gate of [...all].reverse()) setFragmentGates(roundabout, [gate])
    setFragmentGates(roundabout, all)
    expect(order(roundabout).filter((k) => expected.includes(k))).toEqual(expected)
  })

  it('leaves three’s own defines where they were', () => {
    // We delete and re-add OURS. `STANDARD` is three's and keeps its slot at
    // the front, which is the half of the key nothing here is entitled to move.
    const m = new THREE.MeshStandardMaterial()
    m.defines = { STANDARD: '' }
    setFragmentGates(m, ['noIbl', 'waterNoReflect'])
    setFragmentGates(m, ['waterNoReflect'])
    setFragmentGates(m, ['noIbl', 'waterNoReflect'])
    expect(order(m)[0]).toBe('STANDARD')
  })
})
