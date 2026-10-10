// tests/unit/far-shadow.test.ts — the render half of DEV-116.
//
// The GLSL is pinned against three's REAL chunk, the way illustrative.test.ts
// pins the warp: the substitution has to be visible in the stock source, or a
// three upgrade can drop the feature with every test green.

import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@/boot/settings'
import { type Edition, validateEdition } from '@/content/edition-schema'
import { createEditionState, type EditionState } from '@/game/edition'
import {
  createFarShadow,
  encodeSunField,
  halfFloatStep,
  SUN_HEIGHT_GLSL,
  SUN_HEIGHT_INCLUDE,
  sunHeightChunk,
  sunHeightPatchFragment,
  sunHeightPatchVertex,
  sunLiftMetres,
  sunTravelInFieldFrame,
  towardSunSim,
  worldToFieldMatrix,
} from '@/render/far-shadow'
import { shadowEdgeFadeUv } from '@/render/shadows'
import type { HeightField } from '@/sim/terrain/height-field'
import { sunDepthAt } from '@/sim/terrain/sun-height'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'

const classic = validateEdition(classicJson as unknown as Edition)
const anniversary = validateEdition(anniversaryJson as unknown as Edition)
const stateOf = (edition: Edition): EditionState => createEditionState(edition, DEFAULT_SETTINGS)

const field = (): HeightField => {
  const n = 9
  const heights = new Float32Array(n * n)
  heights[4 * n + 4] = 0.1
  return {
    vertPerSide: n,
    heights,
    step: 8,
    terrainSize: 64,
    terrainHeight: 1000,
    originX: -32,
    originY: 0,
    originZ: -32,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
  }
}

describe('the chunk patch', () => {
  it('wraps the directional shadow statement in a min, and only that block', () => {
    const stock = THREE.ShaderChunk.lights_fragment_begin
    const patched = sunHeightChunk()
    expect(patched).not.toBe(stock)
    // DEV-582: the near cascade's term sits in an inner min beside the map's.
    expect(patched).toContain(
      'min( min( mix( 1.0, ff2NearShade, ff2NearCover ), mix( 1.0, ( directLight.visible && receiveShadow ) ? getShadow(',
    )
    expect(patched).toContain('ff2SunHeightTerm()')
    // The no-map branch exists exactly once, and it is in the directional loop.
    const noMap = patched.split('#if !( defined( USE_SHADOWMAP )').length - 1
    expect(noMap).toBe(1)
    // Point and spot loops are untouched: their RE_Direct calls are still bare.
    const pointStart = patched.indexOf('#if ( NUM_POINT_LIGHTS > 0 )')
    const spotStart = patched.indexOf('#if ( NUM_SPOT_LIGHTS > 0 )')
    for (const at of [pointStart, spotStart]) {
      expect(at).toBeGreaterThan(-1)
      expect(patched.slice(at, at + 900)).not.toContain('ff2SunHeightTerm')
    }
    // Still exactly as many RE_Direct calls as stock.
    expect(patched.split('RE_Direct( directLight,').length).toBe(
      stock.split('RE_Direct( directLight,').length,
    )
  })

  it('splices into a fragment shader that carries the include and leaves one without alone', () => {
    const withInclude = `void main() {\n${SUN_HEIGHT_INCLUDE}\n}`
    const out = sunHeightPatchFragment(withInclude)
    expect(out.startsWith(SUN_HEIGHT_GLSL)).toBe(true)
    expect(out).not.toContain(SUN_HEIGHT_INCLUDE)
    const bare = 'void main() { gl_FragColor = vec4(1.0); }'
    expect(sunHeightPatchFragment(bare)).toBe(bare)
  })

  it('the vertex side is instance-aware and declares the varying once', () => {
    const v = sunHeightPatchVertex('void main() {\n#include <begin_vertex>\n}')
    expect(v.split('varying vec3 vFf2SunWorld;').length).toBe(2)
    expect(v).toContain('instanceMatrix * ff2SunLocal')
    expect(v).toContain('#include <begin_vertex>')
  })

  it('negates z once, in the GLSL, and nowhere else', () => {
    expect(SUN_HEIGHT_GLSL.split('-vFf2SunWorld.z').length).toBe(2)
  })

  it('judges the ground by its texel depth and everything else by height, under one define (DEV-133)', () => {
    const code = SUN_HEIGHT_GLSL.replace(/\/\/[^\n]*/g, '')
    // The flag a material's own sun term (the water's glint) keys off.
    expect(code).toContain('#define FF2_SUN_HEIGHT 1')
    // Two paths, both present, both selected by the same define.
    expect(code.split('#ifdef FF2_SUN_GROUND').length).toBe(4)
    expect(code).toContain('swept.g')
    // DEV-497: the object path's top is the one read at the ray's entry point,
    // less the ray's fall between there and here (zero on the field).
    expect(code).toContain('swept.r - ff2Fall - uSunTopC.z')
    // Ground: 1 at depth 0, fading with depth. Object: 1 at the edge, fading below.
    expect(code).toContain('1.0 - smoothstep( 0.0, w, d )')
    expect(code).toContain('smoothstep( -w, 0.0, d )')
    // Never a zero-width smoothstep, whatever the preset says.
    expect(code).toContain('w = max( w, 1e-4 )')
  })

  it('takes its derivatives BEFORE any branch — fwidth is undefined in non-uniform control flow', () => {
    const all = SUN_HEIGHT_GLSL.replace(/\/\/[^\n]*/g, '')
    // Per FUNCTION since DEV-585 put the clouds' term (its own fetch, its own two
    // derivatives, its own uniform switch) above this one in the same prelude: the
    // property is that inside each body the derivatives precede the branches.
    const bodyOf = (name: string): string => {
      const at = all.indexOf(`float ${name}()`)
      const next = all.indexOf('\nfloat ', at + 1)
      return all.slice(at, next < 0 ? undefined : next)
    }
    for (const name of ['ff2SunHeightTerm', 'ff2CloudShadowTerm']) {
      const code = bodyOf(name)
      const firstBranch = code.indexOf('if (')
      const sample = code.indexOf('texture2D(')
      const derivatives = [...code.matchAll(/fwidth\(/g)].map((m) => m.index ?? -1)
      expect(firstBranch, name).toBeGreaterThan(-1)
      expect(sample, name).toBeGreaterThan(-1)
      expect(sample, name).toBeLessThan(firstBranch)
      expect(derivatives.length, name).toBe(2)
      for (const at of derivatives) expect(at, name).toBeLessThan(firstBranch)
    }
    expect([...all.matchAll(/fwidth\(/g)].length, 'no derivative outside the two').toBe(4)
  })

  it('uses no GLSL ES reserved word as an identifier', () => {
    // `half` was one, and the compiler only says so in a browser, once per
    // material, after every unit test has passed. The list is GLSL ES 3.00
    // §3.7's reserved-for-future-use words that read like sensible names.
    const reserved = [
      'half',
      'fixed',
      'double',
      'input',
      'output',
      'goto',
      'union',
      'enum',
      'typedef',
      'template',
      'this',
      'namespace',
      'using',
      'asm',
      'class',
      'extern',
      'external',
      'interface',
      'long',
      'short',
      'sizeof',
      'cast',
      'volatile',
      'static',
      'inline',
      'noinline',
      'public',
      'partition',
      'active',
      'filter',
      'superp',
      'unsigned',
    ]
    const code = SUN_HEIGHT_GLSL.replace(/\/\/[^\n]*/g, '')
    for (const word of reserved) {
      expect(new RegExp(`\\b${word}\\b`).test(code), word).toBe(false)
    }
  })
})

describe("the water's glint takes the same term (DEV-133)", () => {
  it('render/water.ts keys its sun specular off the define this patch emits, by that exact name', () => {
    // A source-text guard, because the glint is injected at <opaque_fragment>
    // outside WATER_SURFACE_GLSL and there is no smaller handle on it. What it
    // protects is the coupling: rename the define here and the sea keeps its
    // full glint inside every mountain's shadow with no test going red.
    const define = /#define (FF2_SUN_HEIGHT) 1/.exec(SUN_HEIGHT_GLSL)?.[1]
    expect(define).toBe('FF2_SUN_HEIGHT')
    const water = fs.readFileSync(path.resolve(__dirname, '../../src/render/water.ts'), 'utf8')
    const at = water.indexOf(`#ifdef ${define}`)
    expect(at).toBeGreaterThan(-1)
    const block = water.slice(at, at + 200)
    expect(block).toContain('ff2SunHeightTerm()')
    expect(water).toContain('uSunColor * sunSeen')
  })
})

describe('towardSunSim', () => {
  it('negates the travel direction and flips z', () => {
    // int_01's sun travels (0.96, -0.07, 0.26) in three space.
    expect(towardSunSim([0.96, -0.07, 0.26])).toEqual([-0.96, 0.07, 0.26])
  })
})

describe('encodeSunField', () => {
  it('round-trips (top, depth, canopy) within half-float precision across the shipped range', () => {
    const tops = new Float32Array([0, 3.25, 127.5, 640, 1536, -12.5])
    const depths = new Float32Array([0, 0, 27.5, 0, 949.6, 0])
    const canopy = new Float32Array([0, 0.125, 0.5, 0, 0.55, 1])
    const half = encodeSunField(tops, depths, canopy)
    expect(half.length).toBe(tops.length * 4)
    for (let i = 0; i < tops.length; i++) {
      const top = THREE.DataUtils.fromHalfFloat(half[4 * i] as number)
      const depth = THREE.DataUtils.fromHalfFloat(half[4 * i + 1] as number)
      // DEV-295's third channel. The tolerance is DERIVED rather than dialled
      // in: half-float carries 11 bits of mantissa, so the worst error in
      // 0..1 is about 2^-12 = 0.00024, and what it has to beat is one step of
      // the 8-bit colour it ends up multiplying — 1/255 = 0.0039. Being inside
      // a quarter of that is the claim, and it is a claim about the FORMAT
      // being good enough rather than about these six numbers.
      expect(
        Math.abs(THREE.DataUtils.fromHalfFloat(half[4 * i + 2] as number) - (canopy[i] as number)),
      ).toBeLessThan(1 / 255 / 4)
      expect(Math.abs(top - (tops[i] as number))).toBeLessThanOrEqual(
        Math.max(0.01, Math.abs(tops[i] as number) / 1024),
      )
      expect(Math.abs(depth - (depths[i] as number))).toBeLessThanOrEqual(
        Math.max(0.01, Math.abs(depths[i] as number) / 1024),
      )
    }
    // Zero depth — lit ground — survives the encoding EXACTLY. The ground path
    // returns 1 only if it does.
    for (const i of [0, 1, 3, 5])
      expect(THREE.DataUtils.fromHalfFloat(half[4 * i + 1] as number)).toBe(0)
    // And an ABSENT canopy is an exact zero everywhere, which is what lets the
    // ground path return exactly 1 on a preset with the feature off.
    const noCanopy = encodeSunField(tops, depths)
    for (let i = 0; i < tops.length; i++)
      expect(THREE.DataUtils.fromHalfFloat(noCanopy[4 * i + 2] as number)).toBe(0)
  })

  it('halfFloatStep is the spacing of representable values, and the lift is jitter plus one of them', () => {
    expect(halfFloatStep(600)).toBe(0.5)
    expect(halfFloatStep(1536)).toBe(1)
    expect(halfFloatStep(100)).toBe(0.0625)
    expect(halfFloatStep(0)).toBeLessThan(1e-6)
    // Simonet: randomOffset 1.3, tops to ~1,650 m.
    expect(sunLiftMetres(1.3, 1650)).toBeCloseTo(2.3, 9)
    expect(sunLiftMetres(-1, 600)).toBe(0.5)
  })
})

describe('createFarShadow', () => {
  it('is off on Classic and stays off with a world attached', () => {
    const state = stateOf(classic)
    const fs = createFarShadow(state)
    expect(fs.on).toBe(false)
    fs.setWorld(field(), [1, -0.07, 0])
    expect(fs.field).not.toBeNull()
    expect(fs.on).toBe(false)
    fs.dispose()
  })

  it('is on under Anniversary only once a world is attached, and off again when it goes', () => {
    const state = stateOf(anniversary)
    const fs = createFarShadow(state)
    expect(fs.on).toBe(false)
    const sh = fs.setWorld(field(), [1, -0.07, 0])
    expect(sh?.maxDepth).toBeGreaterThan(0)
    expect(fs.on).toBe(true)
    fs.setWorld(null, null)
    expect(fs.on).toBe(false)
    expect(fs.field).toBeNull()
    fs.dispose()
  })

  it('a preset flip is a uniform write, not a rebuild', () => {
    const state = stateOf(anniversary)
    const fs = createFarShadow(state)
    const sh = fs.setWorld(field(), [1, -0.07, 0])
    state.setLook(classic)
    expect(fs.on).toBe(false)
    expect(fs.field).toBe(sh)
    state.setLook(anniversary)
    expect(fs.on).toBe(true)
    fs.dispose()
  })

  it('patches a lit material once and leaves an unlit one alone', () => {
    const state = stateOf(anniversary)
    const fs = createFarShadow(state)
    const lit = new THREE.MeshStandardMaterial()
    fs.applyTo(lit)
    fs.applyTo(lit)
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: 'void main() {\n#include <begin_vertex>\n}',
      fragmentShader: `void main() {\n${SUN_HEIGHT_INCLUDE}\n}`,
    }
    lit.onBeforeCompile?.(shader as never, {} as never)
    expect(shader.fragmentShader).toContain('ff2SunHeightTerm')
    expect(shader.fragmentShader.split('uniform sampler2D uSunTopMap;').length).toBe(2)
    expect(shader.uniforms.uSunTopMap).toBeDefined()
    const unlit = new THREE.MeshBasicMaterial()
    fs.applyTo(unlit)
    const plain = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: 'void main() {}',
      fragmentShader: 'void main() {}',
    }
    unlit.onBeforeCompile?.(plain as never, {} as never)
    expect(plain.fragmentShader).toBe('void main() {}')
    expect(plain.uniforms.uSunTopMap).toBeUndefined()
    fs.dispose()
  })

  it('the ground role is a define on the material, set even after an object patch; objects get none', () => {
    const state = stateOf(anniversary)
    const fs = createFarShadow(state)
    const land = new THREE.MeshStandardMaterial()
    // Seen first as an object — the order `app.ts` cannot promise — then as ground.
    fs.applyTo(land)
    expect(land.defines?.FF2_SUN_GROUND).toBeUndefined()
    fs.applyTo(land, 'ground')
    expect(land.defines?.FF2_SUN_GROUND).toBe('')
    // three's own define survives beside it.
    expect(land.defines?.STANDARD).toBe('')
    const sea = new THREE.MeshStandardMaterial()
    fs.applyTo(sea)
    expect(sea.defines?.FF2_SUN_GROUND).toBeUndefined()
    fs.dispose()
  })

  it('uploads (top, depth, canopy) as one RGBA16F texture and derives the object lift from the jitter', () => {
    const state = stateOf(anniversary)
    const fs = createFarShadow(state)
    expect(fs.liftMetres).toBe(0)
    const sh = fs.setWorld(field(), [1, -0.07, 0], 1.3)
    expect(sh).not.toBeNull()
    expect(fs.liftMetres).toBeCloseTo(sunLiftMetres(1.3, sh?.maxTop ?? 0), 12)
    expect(fs.liftMetres).toBeGreaterThan(1.3)
    // The uniform the shader reads carries (enabled, soft, lift).
    const mat = new THREE.MeshStandardMaterial()
    fs.applyTo(mat)
    const shader = {
      uniforms: {} as Record<string, { value: THREE.Vector4 | THREE.Texture }>,
      vertexShader: 'void main() {\n#include <begin_vertex>\n}',
      fragmentShader: `void main() {\n${SUN_HEIGHT_INCLUDE}\n}`,
    }
    mat.onBeforeCompile?.(shader as never, {} as never)
    const c = shader.uniforms.uSunTopC?.value as THREE.Vector4
    expect(c.x).toBe(1)
    expect(c.y).toBe(anniversary.render.sunHeight.softMetres)
    expect(c.z).toBe(fs.liftMetres)
    const tex = shader.uniforms.uSunTopMap?.value as THREE.DataTexture
    expect(tex.format).toBe(THREE.RGBAFormat)
    expect(tex.type).toBe(THREE.HalfFloatType)
    expect((tex.image.data as Uint16Array).length).toBe(4 * (sh?.vertPerSide ?? 0) ** 2)
    // Four channels since DEV-295, not two: .b carries the canopy term so it
    // costs no second fetch. `.w` of the uniform is the canopy's own switch and
    // is OFF here, because no canopy field was handed in — the two terms share
    // a texture and not a switch.
    expect(c.w).toBe(0)
    expect(fs.canopyOn).toBe(false)
    fs.setWorld(null, null)
    expect(fs.liftMetres).toBe(0)
    fs.dispose()
  })
})

// ── DEV-298: the world -> field matrix, and why a mission never needs it ──
//
// The far-field term was never wired to the TITLE screen, and the reason was
// not an oversight: the title valley's group carries an 87-degree rotation and
// `(world - origin) / scale` cannot express one. `worldToFieldMatrix` is the
// general mapping, and the claim that makes it safe to put in the shipped
// vertex shader is that a MISSION resolves it to the identity by arithmetic
// rather than by a flag.

describe('worldToFieldMatrix (DEV-298)', () => {
  const fieldAt = (x: number, y: number, z: number) => ({ originX: x, originY: y, originZ: z })

  it('is exactly the identity for a mission-shaped group', () => {
    // Measured on `rookie_01`: the group sits at (-2157.92, 15.88, 1867.14) and
    // the field's origin is (-2157.92, 15.88, -1867.14) — the same translation
    // with z negated, which is the sim/three flip. So the composition cancels,
    // and the shipped path is unchanged by this feature rather than
    // approximately unchanged.
    const field = fieldAt(-2157.92, 15.88, -1867.14)
    const group = new THREE.Matrix4().makeTranslation(-2157.92, 15.88, 1867.14)
    const m = worldToFieldMatrix(field, group)
    for (let i = 0; i < 16; i++) {
      expect(m.elements[i], `element ${i}`).toBeCloseTo(
        new THREE.Matrix4().elements[i] as number,
        9,
      )
    }
  })

  it('is the identity when no group is given at all', () => {
    expect(worldToFieldMatrix(fieldAt(1, 2, 3), null).equals(new THREE.Matrix4())).toBe(true)
  })

  it('undoes a ROTATED placement, which is the case it exists for', () => {
    // The title valley's own quaternion. The claim is a ROUND TRIP: a point
    // placed into the world by the group comes back to where the field's
    // origin-and-scale mapping expects it, for an arbitrary local point.
    // Asserted as a relationship rather than against a matrix written twice.
    const field = fieldAt(-2048, 15.88, -2048)
    const group = new THREE.Matrix4().compose(
      new THREE.Vector3(29890.08, 15.88, -180.86),
      new THREE.Quaternion(0.024637007, 0.685958194, -0.052707015, 0.725311205),
      new THREE.Vector3(1, 1, 1),
    )
    const m = worldToFieldMatrix(field, group)
    for (const local of [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(1024, 37, -2048),
      new THREE.Vector3(-777.5, 412.25, 63),
    ]) {
      const world = local.clone().applyMatrix4(group)
      const back = world.clone().applyMatrix4(m)
      // The field's mapping subtracts its own origin; what must come back is
      // the local point PLUS that origin, in three space.
      expect(back.x).toBeCloseTo(local.x + field.originX, 4)
      expect(back.y).toBeCloseTo(local.y + field.originY, 4)
      expect(back.z).toBeCloseTo(local.z - field.originZ, 4)
    }
  })

  it('the shipped vertex patch applies it, or the title screen is still dark', () => {
    const v = sunHeightPatchVertex('void main() {\n#include <begin_vertex>\n}')
    expect(v).toContain('uSunTopXf * modelMatrix * ff2SunLocal')
  })

  it('every name the VERTEX patch uses is declared in the VERTEX shader', () => {
    // The first draft of the test above asserted the multiply was in the vertex
    // shader and the declaration was in SUN_HEIGHT_GLSL -- which is the
    // FRAGMENT prelude. Two shaders, two symbol tables, and the vertex one had
    // never heard of `uSunTopXf`: the title screen compiled to
    // `VALIDATE_STATUS false` and `1282` with that test green, because it named
    // the bug and then looked for the declaration in the other half.
    //
    // So this asks the question the compiler asks, of three's own shader rather
    // than of a stub -- the stub has no `#include <common>` and would let a
    // missing built-in through as well.
    const patched = sunHeightPatchVertex(THREE.ShaderLib.physical.vertexShader)
    const used = new Set(patched.match(/\buSunTop[A-Za-z0-9_]*\b/g) ?? [])
    expect(used.size, 'the patch stopped using any uniform at all').toBeGreaterThan(0)
    for (const name of used) {
      expect(patched, `${name} is used in the vertex shader and never declared there`).toMatch(
        new RegExp(`uniform\\s+\\w+\\s+${name}\\s*;`),
      )
    }
    // The varying is the pair's other half: declared here, declared there, and
    // spelled the same in both or the link fails the same way.
    expect(patched).toMatch(/varying\s+vec3\s+vFf2SunWorld\s*;/)
    expect(SUN_HEIGHT_GLSL).toMatch(/varying\s+vec3\s+vFf2SunWorld\s*;/)
  })

  it('declares each of its own names exactly once, whatever three already had', () => {
    // A prelude PREPENDED to a shader that already declares the same name is a
    // redefinition error, not a no-op. three's vertex shader has no `uSunTop*`
    // and no `vFf2SunWorld` today; if a future three (or a material's own
    // patch) brought one, this is where it surfaces.
    const patched = sunHeightPatchVertex(THREE.ShaderLib.physical.vertexShader)
    for (const name of ['uSunTopXf', 'vFf2SunWorld']) {
      const declarations = patched.match(
        new RegExp(`^\\s*(uniform|varying)\\s+\\w+\\s+${name}\\s*;`, 'gm'),
      )
      expect(declarations?.length, `${name} is declared ${declarations?.length ?? 0} times`).toBe(1)
    }
  })
})

// ── DEV-359: the MARCH, in the field's frame ──────────────────────────────
//
// DEV-298 gave the shader a world -> field matrix and left the march alone, so
// the title valley's field was swept with the WORLD sun across a map that is
// rotated 87 degrees under it. The first test is the mission's half (nothing
// moves), the second is arithmetic done a different way from the code, and the
// third is the one that matters: it asks where the SHADOW lands, in the world,
// which is true whatever anybody believes about the rotation.

describe('sunTravelInFieldFrame (DEV-359)', () => {
  it("hands a mission's vector back untouched — the same array, not a copy", () => {
    const sun = [0.0261, -0.6338, 0.7731]
    expect(sunTravelInFieldFrame(sun, null)).toBe(sun)
    expect(sunTravelInFieldFrame(sun, undefined)).toBe(sun)
  })

  it("is the sun's coordinates along the rotated valley's own axes", () => {
    // A direction's coordinates in a frame are its dot products with that
    // frame's axes, which is a different route from inverting a matrix.
    const q = new THREE.Quaternion(0.024637007, 0.685958194, -0.052707015, 0.725311205)
    const group = new THREE.Matrix4().compose(
      new THREE.Vector3(29890.08, 15.88, -180.86),
      q,
      new THREE.Vector3(1, 1, 1),
    )
    const sun = new THREE.Vector3(0.0261, -0.6338, 0.7731).normalize()
    const f = sunTravelInFieldFrame(sun.toArray(), group)
    const axis = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyQuaternion(q)
    expect(f[0]).toBeCloseTo(sun.dot(axis(1, 0, 0)), 9)
    expect(f[1]).toBeCloseTo(sun.dot(axis(0, 1, 0)), 9)
    expect(f[2]).toBeCloseTo(sun.dot(axis(0, 0, 1)), 9)
    // And it is the 59.8 degrees the row quotes, not a rounding.
    const deg = (sun.angleTo(new THREE.Vector3().fromArray(f as number[])) * 180) / Math.PI
    expect(deg).toBeGreaterThan(59)
    expect(deg).toBeLessThan(61)
  })

  it('a pillar on a ROTATED field shadows the ground down-sun of it in the WORLD', () => {
    // A flat 256 m field with one 50 m pillar in the middle, hung on a group
    // yawed 60 degrees, under a sun travelling along world +x at 30 degrees.
    // The shadow must lie along world +x from the pillar's foot. Swept with the
    // world vector in the field's frame, it lies along FIELD +x — which this
    // yaw turns 60 degrees off world +x — and the down-sun ground is lit.
    //
    // Not 90: a sun that lands exactly on a field axis comes out of the matrix
    // with a 1e-16 component on the other, and the march spends two seconds
    // on it and truncates the streak. No shipped sun is axis-aligned; the
    // geometry question does not need one to be.
    const n = 33
    const heights = new Float32Array(n * n)
    heights[16 * n + 16] = 0.05
    const land: HeightField = {
      vertPerSide: n,
      heights,
      step: 8,
      terrainSize: 256,
      terrainHeight: 1000,
      originX: 0,
      originY: 0,
      originZ: 0,
      scaleX: 1,
      scaleY: 1,
      scaleZ: 1,
    }
    const group = new THREE.Matrix4().compose(
      new THREE.Vector3(1000, 0, 500),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 3),
      new THREE.Vector3(1, 1, 1),
    )
    const toField = worldToFieldMatrix(land, group)
    // The pillar's foot in the world: sim (128, 0, 128) is field-three
    // (128, 0, -128), and the group places field-three into the world.
    const foot = new THREE.Vector3(128, 0, -128).applyMatrix4(group)
    const depthAtWorld = (sh: Parameters<typeof sunDepthAt>[0], w: THREE.Vector3) => {
      const f = w.clone().applyMatrix4(toField)
      return sunDepthAt(sh, f.x, -f.z)
    }
    const sun = [1, -Math.tan(Math.PI / 6), 0]
    const fs = createFarShadow(stateOf(anniversary))
    const sh = fs.setWorld(land, sun, 0, null, group)
    expect(sh).not.toBeNull()
    if (!sh) return
    const downSun = foot.clone().add(new THREE.Vector3(40, 0, 0))
    const upSun = foot.clone().add(new THREE.Vector3(-40, 0, 0))
    const aside = foot.clone().add(new THREE.Vector3(0, 0, -40))
    expect(depthAtWorld(sh, downSun), 'the ground down-sun of the pillar').toBeGreaterThan(0)
    expect(depthAtWorld(sh, upSun), 'the ground up-sun of it').toBeLessThanOrEqual(0)
    expect(depthAtWorld(sh, aside), 'the ground beside it').toBeLessThanOrEqual(0)
    fs.dispose()
  })
})

// ── DEV-453: the map hands over to the far field across a band, not a line ─
//
// Matt, on alpine: *"from it to the player, shadows exist, beyond it - no
// shadows"*. The pixels are `tests/e2e/shadow-edge.spec.ts`'s; these are the
// structural halves a pixel test cannot name, each the shape a plausible
// wrong fix would take.

describe('the shadow map fades out at its box (DEV-453)', () => {
  const dirLoop = (text: string): string => {
    const start = text.indexOf('#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )')
    return text.slice(start, text.indexOf('#pragma unroll_loop_end', start))
  }

  it("mixes each light's map term toward lit by the cover of ITS OWN coordinate", () => {
    const loop = dirLoop(sunHeightChunk())
    expect(loop).toContain(
      'ff2LightCover = receiveShadow ? ff2ShadowCover( vDirectionalShadowCoord[ i ] ) : 0.0;',
    )
    expect(loop).toContain('? getShadow( directionalShadowMap[ i ]')
    expect(loop).toMatch(
      /mix\( 1\.0, [^;]*getShadow\([^;]*\) : 1\.0, ff2LightCover \) \), ff2SunHeightTerm\(\) \);/,
    )
    // DEV-582: inside the near box the map's bias carries the near reach's skip.
    expect(loop).toContain('( directionalLightShadow.shadowBias - FF2_NEAR_SKIP )')
    // The canopy's reader: the MOST any map covers the fragment.
    expect(loop).toContain('ff2MapCover = max( ff2MapCover, ff2LightCover );')
    // The cover is taken BEFORE the statement that uses it.
    expect(loop.indexOf('ff2LightCover = ')).toBeLessThan(loop.indexOf('directLight.color *= min('))
  })

  it("survives three's own unroll with two directional lights: nothing declared in the body", () => {
    // three pastes the loop body once per light into ONE scope, and its pattern
    // ends the body at the first closing brace. So a local declared in the body
    // is a redeclaration with a second light, and a brace truncates the body.
    // The pattern is read out of three's build, not remembered.
    const build = fs.readFileSync(
      path.join(process.cwd(), 'node_modules/three/build/three.module.js'),
      'utf8',
    )
    const line = build.match(/const unrollLoopPattern = \/(.+)\/g;/)
    expect(line, "three's unrollLoopPattern moved — re-read WebGLProgram").not.toBeNull()
    const pattern = new RegExp((line as RegExpMatchArray)[1] as string, 'g')
    const chunk = sunHeightChunk().replace(/NUM_DIR_LIGHTS/g, '2')
    const bodies = [...chunk.matchAll(pattern)].map((m) => m[3] as string)
    const dir = bodies.find((b) => b.includes('directionalLights[ i ]'))
    expect(dir, 'the directional loop no longer unrolls').toBeDefined()
    // The whole body made it: RE_Direct is its last statement.
    expect(dir).toContain('ff2LightCover = ')
    expect(dir).toContain('RE_Direct( directLight,')
    expect(dir, 'a declaration in an unrolled body').not.toMatch(/^\s*(float|vec[234]|bool)\s+\w+/m)
  })

  it('declares the globals and the band uniform once, in the FRAGMENT prelude only', () => {
    const code = SUN_HEIGHT_GLSL.replace(/\/\/[^\n]*/g, '')
    expect(code.match(/^\s*uniform vec4 uSunTopE;/gm)?.length).toBe(1)
    expect(code.match(/^\s*float ff2MapCover = 0\.0;/gm)?.length).toBe(1)
    expect(code.match(/^\s*float ff2LightCover = 0\.0;/gm)?.length).toBe(1)
    // The vertex half never reads the band, so it must not need declaring there.
    const v = sunHeightPatchVertex(THREE.ShaderLib.physical.vertexShader)
    expect(v).not.toContain('uSunTopE')
  })

  it('fades on the far depth plane and the four lateral faces, and not on the near plane', () => {
    const code = SUN_HEIGHT_GLSL.replace(/\/\/[^\n]*/g, '')
    const fn = code.slice(code.indexOf('float ff2ShadowCover('), code.indexOf('float ff2MapCover'))
    expect(fn).toContain('min( c.xy, 1.0 - c.xy )')
    expect(fn).toContain('( 1.0 - c.z )')
    // `c.z` alone would be a fade at the NEAR plane, 3.5 km up-sun, where the
    // map has nothing in front of a receiver to cut.
    expect(fn).not.toMatch(/[^-] c\.z \//)
    // Never a zero-width band in a division.
    expect(fn).toContain('max( uSunTopE.x, 1e-6 )')
    expect(fn).toContain('max( uSunTopE.y, 1e-6 )')
    expect(fn, 'a branch in the cover').not.toMatch(/\bif\s*\(/)
  })

  it('writes the live preset band into the uniform every patched program shares', () => {
    const state = stateOf(anniversary)
    const fs = createFarShadow(state)
    const mat = new THREE.MeshStandardMaterial()
    fs.applyTo(mat, 'ground')
    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: 'void main() {\n#include <begin_vertex>\n}',
      fragmentShader: `void main() {\n${SUN_HEIGHT_INCLUDE}\n#include <aomap_fragment>\n}`,
    }
    mat.onBeforeCompile?.(shader as never, {} as never)
    const e = shader.uniforms.uSunTopE?.value as THREE.Vector4
    expect(e, 'uSunTopE never reached the shader').toBeInstanceOf(THREE.Vector4)
    const band = shadowEdgeFadeUv(anniversary.render.shadows)
    expect(e.x).toBe(band.lateral)
    expect(e.y).toBe(band.depth)
    expect(e.x).toBeGreaterThan(0)
    // A preset whose band moves moves the SAME object, with no recompile.
    const wider = structuredClone(anniversary) as Edition
    ;(wider.render.shadows as { edgeFade: number }).edgeFade = 300
    state.setLook(wider)
    expect(e.x).toBeCloseTo(300 / (2 * anniversary.render.shadows.boxHalfSize), 12)
    fs.dispose()
  })
})
