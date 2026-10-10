// tests/unit/point-light-scope.test.ts
//
// The failure this file exists to make impossible: **a cut that did not land
// reads exactly like a cut that was free.** The shader still compiles, the
// frame still renders, and the loop this row exists to remove is still in it —
// which is DEV-069's four sessions of a control scheme that described itself
// correctly in prose and was not the one the game shipped.
//
// So the two load-bearing claims are tested against something OUTSIDE the
// patch:
//
//  1. **The shipped cut is the cut DEV-191 priced.** `point-light-scope.ts`
//     rewrites the `#if` to `#if 0`; `fragment-gates.ts` appends
//     `&& ! defined( FF2_NO_POINT_LIGHTS )` and sets the define. Those are two
//     different edits and the row claims they are the same cut. Both arms go
//     through ONE preprocessor here — written against C's rules for `#if`, not
//     against either patch — and the preprocessed text must come out identical.
//     A test that re-derived each arm's expectation the way its patch does
//     would have tested neither (CLAUDE.md, trap 24).
//
//  2. **A clone loses a define and keeps the delegation.** That is the whole
//     reason this cut lives in the shader text, and it is a fact about three
//     rather than about us — so it is asserted against three, and a three
//     upgrade that changed it would fail here rather than in a headset.
import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { GATE_NO_POINT_LIGHTS, gateFragmentShader, POINT_LIGHT_IF } from '@/render/fragment-gates'
import {
  cutPointLights,
  inheritPointLightScope,
  isPointLightScoped,
  POINT_LIGHT_CUT,
  pointLightScopeOf,
  scopePointLights,
  scopeWorldPointLights,
} from '@/render/point-light-scope'

// ─────────────────────────────────────────────────────────────────────────
// One preprocessor, both arms
// ─────────────────────────────────────────────────────────────────────────

/**
 * Is this `#if` line false, given the set of defined names?
 *
 * Two rules, and they are the two the C preprocessor applies to the conditions
 * in play — nothing about FF2 and nothing about either patch:
 *
 *   - `#if 0` is false.
 *   - `A && ! defined( D )` is false when `D` is defined.
 *
 * Comments are stripped before the condition is read, because that is the
 * order a real preprocessor works in — GLSL ES strips `//` in translation
 * phase 3, before directives are evaluated. The cut carries a trailing comment
 * naming itself, and a reader dumping the GLSL should find that rather than a
 * bare `#if 0`.
 *
 * Everything else is left alone, including three's own `NUM_*_LIGHTS > 0`
 * conditions: evaluating those would be a second implementation of
 * `WebGLProgram` and wrong in its own way.
 */
const ifIsFalse = (rawCondition: string, defined: readonly string[]): boolean => {
  const condition = rawCondition.replace(/\/\/.*$/, '').trim()
  if (condition === '0') return true
  for (const name of defined) {
    if (condition.includes(`! defined( ${name} )`)) return true
  }
  return false
}

/**
 * Drop the body of every `#if` this evaluator can prove false, to its matching
 * `#endif`. Structure only: nesting is tracked by counting, so a block inside a
 * dropped block goes with it.
 */
const dropFalseBlocks = (source: string, defined: readonly string[]): string => {
  const out: string[] = []
  /** Depth inside a block we are dropping; 0 when we are keeping. */
  let dropping = 0
  /** Open `#if` depth, so the matching `#endif` can be found. */
  let depth = 0
  /** The depth at which the current drop started. */
  let dropAt = 0
  for (const line of source.split('\n')) {
    const trimmed = line.trim()
    const open = /^#if(?:\s+(.*))?$/.exec(trimmed)
    const openAny = /^#(if|ifdef|ifndef)\b/.test(trimmed)
    if (openAny) {
      depth++
      if (dropping === 0 && open && ifIsFalse(open[1] ?? '', defined)) {
        dropping = 1
        dropAt = depth
        continue
      }
      if (dropping > 0) continue
    } else if (trimmed.startsWith('#endif')) {
      if (dropping > 0 && depth === dropAt) {
        dropping = 0
        depth--
        continue
      }
      depth--
    }
    if (dropping === 0) out.push(line)
  }
  return out.join('\n')
}

/**
 * The shader a material hands `onBeforeCompile` before anything has patched.
 *
 * All three of `fragment-gates.ts`'s includes, because half these tests run
 * both patches over one input and the gate needs its own anchors — the same
 * stand-in `tests/unit/fragment-gates.test.ts` uses.
 */
const rawShader = (): string =>
  [
    'void main() {',
    '\t#include <lights_fragment_maps>',
    '\t#include <lights_fragment_begin>',
    '\t#include <opaque_fragment>',
    '}',
  ].join('\n')

/** What `far-shadow.ts` leaves behind: the chunk expanded in place. */
const farShadowedShader = (): string =>
  rawShader().replace(
    '\t#include <lights_fragment_begin>',
    () => THREE.ShaderChunk.lights_fragment_begin,
  )

describe('point-light scope — the preprocessor this file judges with', () => {
  it('drops a `#if 0` block and keeps its neighbours', () => {
    const src = ['keep-a', '#if 0', 'gone', '#endif', 'keep-b'].join('\n')
    expect(dropFalseBlocks(src, [])).toBe(['keep-a', 'keep-b'].join('\n'))
  })

  it('drops a block whose condition negates a defined name, and keeps it otherwise', () => {
    const src = ['#if A && ! defined( D )', 'body', '#endif'].join('\n')
    expect(dropFalseBlocks(src, ['D'])).toBe('')
    expect(dropFalseBlocks(src, [])).toBe(src)
  })

  it('takes a nested block with its parent', () => {
    const src = ['#if 0', '#ifdef USE_SHADOWMAP', 'inner', '#endif', 'outer', '#endif', 'after']
    expect(dropFalseBlocks(src.join('\n'), [])).toBe('after')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Claim 1: the shipped cut IS the priced cut
// ─────────────────────────────────────────────────────────────────────────

describe('point-light scope — the shipped cut is the cut DEV-191 priced', () => {
  it('removes the same lines as fragment-gates + FF2_NO_POINT_LIGHTS, byte for byte', () => {
    // Arm A: the instrument. `fragment-gates.ts` appends its clause and the
    // define is set, so three's preprocessor would close the block.
    const armA = dropFalseBlocks(gateFragmentShader(farShadowedShader()), [GATE_NO_POINT_LIGHTS])
    // Arm B: the permanent cut, on the same input.
    const armB = dropFalseBlocks(cutPointLights(farShadowedShader()).text, [GATE_NO_POINT_LIGHTS])
    // The gate also splices the IBL and UNLIT guards, which arm B never
    // touches — so compare the one block both arms are about rather than the
    // whole file. `RE_Direct` for point lights is inside it; the directional
    // and spot loops are not.
    const pointBlockGone = (text: string): boolean =>
      !text.includes('getPointLightInfo( pointLight, geometryPosition, directLight );')
    expect(pointBlockGone(armA)).toBe(true)
    expect(pointBlockGone(armB)).toBe(true)
    // And neither arm took anything else with it: the directional and spot
    // loops survive in both, identically.
    const lightLines = (text: string): string[] =>
      text
        .split('\n')
        .filter((l) => l.includes('LightInfo(') || l.includes('RE_Direct( directLight'))
    expect(lightLines(armB)).toEqual(lightLines(armA))
    expect(lightLines(armB).length).toBeGreaterThan(0)
  })

  it('leaves the directional, spot and rect-area loops alone', () => {
    const cut = cutPointLights(farShadowedShader()).text
    for (const other of ['NUM_DIR_LIGHTS', 'NUM_SPOT_LIGHTS', 'NUM_RECT_AREA_LIGHTS']) {
      const lines = cut.split('\n').filter((l) => l.includes(`${other} > 0`))
      expect(lines.length).toBeGreaterThan(0)
      for (const line of lines) expect(line).not.toContain('#if 0')
    }
    // The point-light `#if` is the ONE line that became the cut.
    expect(cut.split(POINT_LIGHT_CUT).length - 1).toBe(1)
  })

  it('shares the anchor string with fragment-gates rather than spelling it twice', () => {
    // The relationship, not the value: whatever `POINT_LIGHT_IF` is, it is the
    // line this module replaces and the line the gate rewrites.
    expect(THREE.ShaderChunk.lights_fragment_begin).toContain(POINT_LIGHT_IF)
    expect(cutPointLights(farShadowedShader()).text).not.toContain(POINT_LIGHT_IF)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// The three shapes the anchor arrives in
// ─────────────────────────────────────────────────────────────────────────

describe('point-light scope — every shape the anchor arrives in', () => {
  it('expands the include when nothing else has', () => {
    const cut = cutPointLights(rawShader())
    expect(cut.scope).toBe('cut')
    expect(cut.text).toContain(POINT_LIGHT_CUT)
    expect(cut.text).not.toContain('#include <lights_fragment_begin>')
    // Expanded ONCE, not on top of itself.
    expect(cut.text.split('IncidentLight directLight;').length - 1).toBe(1)
  })

  it('cuts a shader far-shadow has already expanded', () => {
    const cut = cutPointLights(farShadowedShader())
    expect(cut.scope).toBe('cut')
    expect(cut.text.split('IncidentLight directLight;').length - 1).toBe(1)
  })

  it('cuts a shader the gates have already rewritten, suffix and all', () => {
    const gated = gateFragmentShader(farShadowedShader())
    expect(gated).toContain(`! defined( ${GATE_NO_POINT_LIGHTS} )`)
    const cut = cutPointLights(gated)
    expect(cut.scope).toBe('cut')
    // The gate's clause went with the statement rather than being left
    // dangling after `#if 0` — which would have been a GLSL syntax error on
    // the terrain, where both patches really do run.
    const cutLine = cut.text.split('\n').find((l) => l.includes(POINT_LIGHT_CUT))
    expect(cutLine).toBeDefined()
    expect(cutLine).not.toContain('defined(')
  })

  it('is idempotent', () => {
    const once = cutPointLights(farShadowedShader()).text
    const twice = cutPointLights(once)
    expect(twice.text).toBe(once)
    expect(twice.scope).toBe('cut')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 'unlit' is a classification, not a silence
// ─────────────────────────────────────────────────────────────────────────

describe('point-light scope — nothing to cut vs the cut did not land', () => {
  it("calls three's own meshbasic shader unlit and leaves it untouched", () => {
    // three's REAL basic shader, not a stand-in: the claim is about what this
    // renderer actually hands us.
    const basic = THREE.ShaderLib.basic.fragmentShader
    const cut = cutPointLights(basic)
    expect(cut.scope).toBe('unlit')
    expect(cut.text).toBe(basic)
  })

  it("agrees with three's own ShaderLib about which shaders have lighting", () => {
    // The outside oracle for `LIT_MARKERS`: the lit shaders carry the chunks
    // and basic does not, read off three rather than off a list of material
    // types kept here by hand.
    for (const id of ['physical', 'lambert', 'phong'] as const) {
      expect(THREE.ShaderLib[id].fragmentShader).toContain('#include <lights_fragment_begin>')
      expect(cutPointLights(THREE.ShaderLib[id].fragmentShader).scope).toBe('cut')
    }
    expect(THREE.ShaderLib.basic.fragmentShader).not.toContain('#include <lights_pars_begin>')
    expect(THREE.ShaderLib.basic.fragmentShader).not.toContain('#include <lights_fragment_begin>')
  })

  it('THROWS when a shader has lighting but the loop is gone', () => {
    // The shape that must never pass quietly: somebody else has rewritten the
    // point-light block, so there is nothing to cut AND a cost still being
    // paid. Distinguishable from `meshbasic` only by the markers.
    const mangled = THREE.ShaderLib.physical.fragmentShader.replace(
      '#include <lights_fragment_begin>',
      '// somebody else had it',
    )
    expect(() => cutPointLights(mangled)).toThrow(/has lighting/)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Claim 2: why this is text and not a define
// ─────────────────────────────────────────────────────────────────────────

describe('point-light scope — a clone is why the cut is in the text', () => {
  it("three's MeshStandardMaterial.clone WIPES defines rather than carrying them", () => {
    const base = new THREE.MeshStandardMaterial()
    base.defines = { ...(base.defines ?? {}), [GATE_NO_POINT_LIGHTS]: '' }
    const clone = base.clone()
    // Not "does not carry" — actively reset to STANDARD only
    // (`MeshStandardMaterial.js` `copy()`), which is what would have put the
    // loop back into every fade clone, water band and fracture piece.
    expect(clone.defines?.[GATE_NO_POINT_LIGHTS]).toBeUndefined()
    expect(base.defines?.[GATE_NO_POINT_LIGHTS]).toBe('')
  })

  it('a clone that delegates onBeforeCompile back to the base gets the cut for free', () => {
    // The pattern `lod-fade.ts`, `water.ts` and `prop-fracture.ts` all use.
    const base = new THREE.MeshStandardMaterial()
    scopePointLights(base)
    const clone = base.clone()
    const baseHook = base.onBeforeCompile
    clone.onBeforeCompile = (shader, renderer) => baseHook.call(base, shader, renderer)
    const shader = {
      fragmentShader: farShadowedShader(),
    } as THREE.WebGLProgramParametersWithUniforms
    clone.onBeforeCompile(shader, null as unknown as THREE.WebGLRenderer)
    expect(shader.fragmentShader).toContain(POINT_LIGHT_CUT)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Installing it on materials, and the sweep
// ─────────────────────────────────────────────────────────────────────────

const litMaterial = (): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial()

const compile = (m: THREE.Material, source = farShadowedShader()): string => {
  const shader = { fragmentShader: source } as THREE.WebGLProgramParametersWithUniforms
  m.onBeforeCompile(shader, null as unknown as THREE.WebGLRenderer)
  return shader.fragmentShader
}

describe('point-light scope — installing it on a material', () => {
  it('cuts the loop, records what it did, and tags the program cache key', () => {
    const m = litMaterial()
    const keyBefore = m.customProgramCacheKey()
    scopePointLights(m)
    expect(isPointLightScoped(m)).toBe(true)
    // Nothing is recorded until the material compiles: a scope that claimed a
    // result before the shader existed would be an opinion.
    expect(pointLightScopeOf(m)).toBeUndefined()
    expect(compile(m)).toContain(POINT_LIGHT_CUT)
    expect(pointLightScopeOf(m)).toBe('cut')
    // The tag, or two materials differing only in this patch share a program
    // and whichever compiled first wins (`render/program-cache-key.ts`).
    expect(m.customProgramCacheKey()).not.toBe(keyBefore)
    expect(m.customProgramCacheKey()).toContain('point-light-scope')
  })

  it('installs once, so a second sweep does not splice the patch twice', () => {
    const m = litMaterial()
    scopePointLights(m)
    const hook = m.onBeforeCompile
    scopePointLights(m)
    expect(m.onBeforeCompile).toBe(hook)
    expect(compile(m).split(POINT_LIGHT_CUT).length - 1).toBe(1)
  })

  it('runs whatever was already on the material first', () => {
    const m = litMaterial()
    const order: string[] = []
    m.onBeforeCompile = () => order.push('first')
    scopePointLights(m)
    compile(m)
    expect(order).toEqual(['first'])
  })

  it('records unlit without touching the shader', () => {
    const m = new THREE.MeshBasicMaterial()
    scopePointLights(m)
    const out = compile(m, THREE.ShaderLib.basic.fragmentShader)
    expect(out).toBe(THREE.ShaderLib.basic.fragmentShader)
    expect(pointLightScopeOf(m)).toBe('unlit')
  })
})

describe('point-light scope — the world sweep and its one exemption', () => {
  /** A mesh with its own material, named. */
  const meshWith = (name: string, material: THREE.Material): THREE.Mesh => {
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material)
    mesh.name = name
    return mesh
  }

  it('scopes the world and leaves the exempt subtree alone', () => {
    const scene = new THREE.Group()
    const island = litMaterial()
    const cockpit = litMaterial()
    const ship = new THREE.Group()
    ship.name = 'hoverjet'
    ship.add(meshWith('cockpit', cockpit))
    scene.add(meshWith('island', island), ship)

    const report = scopeWorldPointLights(scene, [ship])
    expect(report.scoped).toBe(1)
    expect(report.exempt).toBe(1)
    expect(isPointLightScoped(island)).toBe(true)
    expect(isPointLightScoped(cockpit)).toBe(false)
  })

  it('does NOT cut a material the cabin shares with the world', () => {
    // The guard that cannot be true by luck: today nothing is shared, so a
    // subtree skip alone would pass. Share one and the cabin must still keep
    // its lamps — a material is not a place.
    const scene = new THREE.Group()
    const shared = litMaterial()
    const ship = new THREE.Group()
    ship.add(meshWith('cockpit', shared))
    scene.add(meshWith('a-prop-out-in-the-world', shared), ship)

    const report = scopeWorldPointLights(scene, [ship])
    expect(report.scoped).toBe(0)
    expect(isPointLightScoped(shared)).toBe(false)
  })

  it('is idempotent, so a course swap can simply run it again', () => {
    const scene = new THREE.Group()
    scene.add(meshWith('island', litMaterial()))
    expect(scopeWorldPointLights(scene, []).scoped).toBe(1)
    const second = scopeWorldPointLights(scene, [])
    expect(second.scoped).toBe(0)
    expect(second.already).toBe(1)
  })

  it('reaches a material through an INVISIBLE node', () => {
    // The ride hides the launch room and the reveal hides the title; a sweep
    // that skipped what is hidden would leave the loop in exactly the
    // materials that compile live, mid-ride, which is DEV-117's whole subject.
    const scene = new THREE.Group()
    const hidden = new THREE.Group()
    hidden.visible = false
    const m = litMaterial()
    hidden.add(meshWith('launch-room', m))
    scene.add(hidden)
    expect(scopeWorldPointLights(scene, []).scoped).toBe(1)
    expect(isPointLightScoped(m)).toBe(true)
  })

  it('skips a clone that inherits the cut, and answers with the base result', () => {
    const scene = new THREE.Group()
    const base = litMaterial()
    scopePointLights(base)
    compile(base)
    const clone = base.clone()
    inheritPointLightScope(clone, base)
    scene.add(meshWith('sea-band', clone))
    // Not swept again: `scopePointLights(clone)` would tag its cache key a
    // second time, and `water.ts` delegates that key on purpose so N facet
    // sizes are N materials and ONE program.
    expect(scopeWorldPointLights(scene, []).scoped).toBe(0)
    expect(isPointLightScoped(clone)).toBe(true)
    expect(pointLightScopeOf(clone)).toBe('cut')
  })

  it('cuts the base of a clone when the base itself hangs off no mesh', () => {
    // DEV-339: with the rings drawing the sea, no mesh uses the water's base
    // material, only clones derived from it. A sweep that walks meshes never
    // meets the base, so the cut never arrived and five ring materials
    // reported themselves uncut (point-light-scope.spec.ts).
    const scene = new THREE.Group()
    const base = litMaterial()
    const a = base.clone()
    const b = base.clone()
    inheritPointLightScope(a, base)
    inheritPointLightScope(b, base)
    scene.add(meshWith('ring-0', a), meshWith('ring-1', b))
    expect(isPointLightScoped(a)).toBe(false)
    const report = scopeWorldPointLights(scene, [])
    expect(report.scoped).toBe(1)
    expect(isPointLightScoped(a)).toBe(true)
    expect(isPointLightScoped(b)).toBe(true)
    expect(scopeWorldPointLights(scene, []).scoped).toBe(0)
  })

  it('does NOT claim a clone is cut when its base was never swept', () => {
    // `?pointLights=keep` is the A arm of the photograph — one load where
    // nothing is cut — and it caught this: recording the clone as scoped
    // outright is true whenever the base was swept and a lie whenever it was
    // not, so the uncut arm reported a cut material and the spec that checks
    // the arm reached the page failed. Correctly.
    const base = litMaterial()
    const clone = base.clone()
    inheritPointLightScope(clone, base)
    expect(isPointLightScoped(clone)).toBe(false)
    expect(pointLightScopeOf(clone)).toBeUndefined()
    // ...and it becomes true the moment the base really is cut, without the
    // clone being touched again.
    scopePointLights(base)
    expect(isPointLightScoped(clone)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// The guard on the NEXT clone site
// ─────────────────────────────────────────────────────────────────────────

describe('point-light scope — a delegating clone has to say so', () => {
  // Exactly `program-cache-key.test.ts`'s shape, and for the same reason: the
  // failure is silent. A new clone factory that forwards `onBeforeCompile` to a
  // base gets the cut for free and is invisible to the WeakSet, so
  // `tests/e2e/point-light-scope.spec.ts` reports it as a material the sweep
  // missed — which is what happened to the ocean's LOD bands on this row's
  // first e2e run, and the answer was to say so rather than to sweep it.
  const dirs = ['render', 'game'] as const
  /** A clone forwarding to its base: `base.onBeforeCompile.call(base, …)`. */
  const DELEGATES = /\.onBeforeCompile\.call\(/

  /**
   * Comments stripped, because a comment is not a call site.
   *
   * `point-light-scope.ts`'s own doc comment shows the delegation it is telling
   * people to register beside, and the first version of this guard reported the
   * module that defines `inheritPointLightScope` as the one file that had
   * forgotten to use it.
   */
  const code = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

  const filesUnder = (sub: string): { name: string; src: string }[] => {
    const dir = path.join(process.cwd(), 'src', sub)
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.ts'))
      .map((name) => ({ name, src: code(fs.readFileSync(path.join(dir, name), 'utf8')) }))
  }

  it('every file that delegates onBeforeCompile also inherits the point-light scope', () => {
    const offenders: string[] = []
    for (const sub of dirs) {
      for (const { name, src } of filesUnder(sub)) {
        if (!DELEGATES.test(src)) continue
        if (!src.includes('inheritPointLightScope(')) offenders.push(`${sub}/${name}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('and the guard is not vacuous — it is looking at files that really delegate', () => {
    // One today: `delegating-clone.ts`, the recipe lod-fade's fade clones,
    // water's LOD bands and prop-fracture's pieces all go through (it was three
    // hand-rolled copies until the code-reuse audit's WP-6). A pattern that
    // matched nothing would pass the test above for ever.
    let delegators = 0
    for (const sub of dirs) {
      for (const { src } of filesUnder(sub)) if (DELEGATES.test(src)) delegators++
    }
    expect(delegators).toBeGreaterThanOrEqual(1)
  })

  it('and the three clone factories use the shared recipe rather than their own copy', () => {
    const users = ['lod-fade.ts', 'water.ts', 'prop-fracture.ts']
    const render = filesUnder('render')
    for (const name of users) {
      const src = render.find((f) => f.name === name)?.src ?? ''
      expect(src, `${name} cuts its clones with delegatingClone`).toContain('delegatingClone(')
      expect(DELEGATES.test(src), `${name} hand-rolls a delegation`).toBe(false)
    }
  })
})
