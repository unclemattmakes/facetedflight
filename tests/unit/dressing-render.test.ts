// tests/unit/dressing-render.test.ts — the parts of V9 a screenshot would show
// and a placement test cannot.
//
// DEV-089. Three things live here and each of them is invisible from the pure
// layer:
//
//   1. **The hook exists.** The variant swap and the fog both replace
//      `#include <begin_vertex>` in three's own standard shader. A three upgrade
//      that renamed that chunk would make both patches silently no-op — the
//      props would render as four copies of variant 0 and nothing would error.
//      So the token is asserted against `THREE.ShaderLib`, which is outside this
//      port (the agreement lesson: compare against something you did not write).
//   2. **The chain order.** Both patches replace the same token, and the one
//      applied LAST lands its line closest to the hook. The swap must end up
//      BEFORE the fog's line or the fog reads the un-swapped vertex. That is an
//      ordering fact about two strings, and it is checkable.
//   3. **The orientation.** A bird's nose has to point where it is flying.
//      Per the orientation lesson: the test transforms the NOSE and the TAIL by
//      the instance matrix and compares the vector between them against the
//      flight direction. A quaternion assertion would be the belief written
//      twice; a difference of two transformed vertices is a measurement.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { createFlockField, createPropField, MAX_VARIANTS, packVariants } from '@/render/dressing'
import type { DressingPlacements } from '@/sim/props/dressing'
import { birdAt, birdPose, type FlockPlacement, generateBird } from '@/sim/props/generate-bird'
import { generatePropVariants, type PropMesh } from '@/sim/props/generate-shapes'

const HOOK = '#include <begin_vertex>'

/** Run a material's `onBeforeCompile` over three's real standard vertex shader. */
const compileVertex = (material: THREE.Material): string => {
  const shader = {
    uniforms: {} as Record<string, { value: unknown }>,
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
  }
  material.onBeforeCompile(
    shader as unknown as THREE.WebGLProgramParametersWithUniforms,
    undefined as unknown as THREE.WebGLRenderer,
  )
  return shader.vertexShader
}

const placements = (count: number): DressingPlacements => {
  const positions = new Float32Array(count * 3)
  const yaw = new Float32Array(count)
  const tilt = new Float32Array(count)
  const tiltDir = new Float32Array(count)
  const scale = new Float32Array(count)
  const squash = new Float32Array(count)
  const variant = new Uint8Array(count)
  const color = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    positions[i * 3] = 100 + i * 10
    positions[i * 3 + 1] = 50 + i
    positions[i * 3 + 2] = 700 + i * 3
    yaw[i] = 0
    tilt[i] = 0
    tiltDir[i] = 0
    scale[i] = 1 + i * 0.25
    squash[i] = 1
    variant[i] = i % MAX_VARIANTS
    color[i * 3] = 0.2
    color[i * 3 + 1] = 0.4
    color[i * 3 + 2] = 0.6
  }
  return { kind: 'boulder', count, positions, yaw, tilt, tiltDir, scale, squash, variant, color }
}

describe("three's own shader still has the hook both patches replace", () => {
  it('finds `#include <begin_vertex>` in the standard vertex shader', () => {
    // Not "our string looks right" — the string, in three's shipped source. A
    // rename upstream makes both the variant swap and `unity-fog` no-ops with
    // no error anywhere, and this is the only place that would say so.
    expect(THREE.ShaderLib.standard.vertexShader).toContain(HOOK)
    expect(THREE.ShaderChunk.begin_vertex).toContain('vec3 transformed')
  })
})

describe('packing the variants', () => {
  it('gives every slot a buffer, repeating variant 0 past the ones it has', () => {
    const two = generatePropVariants('boulder', 2, 500)
    const geometry = packVariants(two)
    expect(geometry.getAttribute('position')).toBeDefined()
    expect(geometry.getAttribute('normal')).toBeDefined()
    // One lightness per face, expanded to rgb — three multiplies `color` into
    // the instance colour, which is how "one flat colour per face" survives.
    expect(geometry.getAttribute('color').count).toBe((two[0] as PropMesh).triangleCount * 3)
    for (let slot = 1; slot < MAX_VARIANTS; slot++) {
      expect(geometry.getAttribute(`aVar${slot}`), `aVar${slot}`).toBeDefined()
    }
    // Slot 1 is the second variant; slots 2 and 3 fall back to variant 0, so an
    // instance that lands on one of them draws a real boulder rather than
    // whatever happened to be in an unbound attribute.
    const base = Array.from((two[0] as PropMesh).positions)
    expect(Array.from(geometry.getAttribute('aVar1').array as Float32Array)).not.toEqual(base)
    expect(Array.from(geometry.getAttribute('aVar2').array as Float32Array)).toEqual(base)
    expect(Array.from(geometry.getAttribute('aVar3').array as Float32Array)).toEqual(base)
  })

  it('refuses variants that do not share a topology', () => {
    // The renderer swaps positions between buffers of the same length. A shorter
    // one would render as a truncated buffer — geometry that is silently wrong
    // rather than absent, which is the worse of the two failures.
    const boulder = generatePropVariants('boulder', 1, 1)
    const rock = generatePropVariants('rock', 1, 1)
    expect(() => packVariants([...boulder, ...rock])).toThrow(/shares a topology/)
  })
})

describe('a prop field', () => {
  const variants = generatePropVariants('boulder', 4, 10)

  it('is ONE instanced mesh, with the instance data the placements carry', () => {
    const p = placements(6)
    const field = createPropField(variants, p)
    expect(field.object.isInstancedMesh).toBe(true)
    expect(field.object.count).toBe(6)
    expect(field.instances).toBe(6)
    expect(field.triangles).toBe(6 * (variants[0] as PropMesh).triangleCount)
    const iVariant = field.object.geometry.getAttribute('iVariant')
    expect(iVariant.count).toBe(6)
    for (let i = 0; i < 6; i++) expect(iVariant.getX(i)).toBe(p.variant[i] as number)
    expect(field.object.instanceColor?.count).toBe(6)
    expect(field.object.instanceColor?.getX(0)).toBeCloseTo(0.2, 6)
    field.dispose()
  })

  it('flips z the way the terrain group under it does', () => {
    // `chunkGeometry` mirrors the terrain into three space and `load-props.ts`
    // flips the palms to match. A prop that did not would sit on the far side of
    // the island from the hill it was placed on — and on a symmetric map, look
    // fine. Asserted as a RELATIONSHIP between the placement and the matrix.
    const p = placements(3)
    const field = createPropField(variants, p)
    const m = new THREE.Matrix4()
    const pos = new THREE.Vector3()
    const quat = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    for (let i = 0; i < 3; i++) {
      field.object.getMatrixAt(i, m)
      m.decompose(pos, quat, scale)
      expect(pos.x).toBeCloseTo(p.positions[i * 3] as number, 4)
      expect(pos.y).toBeCloseTo(p.positions[i * 3 + 1] as number, 4)
      expect(pos.z).toBeCloseTo(-(p.positions[i * 3 + 2] as number), 4)
      // Uniform `scale`, `squash` on y alone. `scale` is metres across and the
      // mesh is one metre across, so this instance IS that many metres across.
      expect(scale.x).toBeCloseTo(p.scale[i] as number, 5)
      expect(scale.y).toBeCloseTo((p.scale[i] as number) * (p.squash[i] as number), 5)
    }
    field.dispose()
  })

  it('injects the swap and LEAVES THE HOOK for the fog to chain onto', () => {
    const field = createPropField(variants, placements(2))
    const src = compileVertex(field.object.material as THREE.Material)
    expect(src).toContain('attribute float iVariant;')
    expect(src).toContain('transformed = aVar3;')
    // The token survives. A patch that consumed it would silently unfog every
    // prop in the world — no error, no missing geometry, just a hillside of
    // boulders that do not fade with the rest of the island.
    expect(src).toContain(HOOK)
    field.dispose()
  })

  it('lands the swap BEFORE a fog patch applied first — the order is the point', () => {
    // A stand-in for `unity-fog.ts`: the same chaining shape, the same hook, one
    // recognisable line. What matters is where it ends up relative to the swap,
    // because the fog reads `transformed` and must read the SWAPPED one.
    const applyFog = (material: THREE.Material): void => {
      const previous = material.onBeforeCompile
      material.onBeforeCompile = (shader, renderer) => {
        previous?.call(material, shader, renderer)
        shader.vertexShader = shader.vertexShader.replace(
          HOOK,
          `${HOOK}\n  vFakeFogWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
        )
      }
    }
    const field = createPropField(variants, placements(2), applyFog)
    const src = compileVertex(field.object.material as THREE.Material)
    const swapAt = src.indexOf('transformed = aVar1;')
    const fogAt = src.indexOf('vFakeFogWorldPos')
    expect(swapAt, 'the swap was injected').toBeGreaterThan(-1)
    expect(fogAt, 'the fog was injected').toBeGreaterThan(-1)
    expect(swapAt, 'the swap runs before the fog reads `transformed`').toBeLessThan(fogAt)
    field.dispose()
  })

  it('tags the program cache key, because `onBeforeCompile` is not in it', () => {
    // `render/program-cache-key.ts`: two materials that differ only in their
    // injected GLSL hash identically and share one compiled program, and which
    // one wins is creation order. The prop material and any other white
    // vertex-coloured MeshStandardMaterial would be exactly that pair.
    const field = createPropField(variants, placements(2))
    const material = field.object.material as THREE.Material
    expect(material.customProgramCacheKey()).toContain('dressing-variants')
    field.dispose()
  })
})

describe('a flock field', () => {
  const flock: FlockPlacement = {
    centre: [1000, 300, 1500],
    radiusX: 60,
    radiusZ: 55,
    heading: 0.4,
    tilt: 0.15,
    speed: 11,
    birds: Array.from({ length: 8 }, (_, i) => ({
      phase: i / 8,
      spread: 0,
      rise: 0,
      size: 1,
      wingPhase: i * 0.7,
      color: [0.05, 0.05, 0.06] as readonly [number, number, number],
    })),
  }

  it('is ONE instanced mesh for every flock in the world', () => {
    const field = createFlockField(generateBird(), [flock, flock])
    expect(field.object.isInstancedMesh).toBe(true)
    expect(field.instances).toBe(16)
    expect(field.object.count).toBe(16)
    expect(field.object.geometry.getAttribute('iPhase').count).toBe(16)
    field.dispose()
  })

  it('puts each bird where `birdAt` says, with the terrain group`s z flip', () => {
    const field = createFlockField(generateBird(), [flock])
    field.update(2.5)
    const m = new THREE.Matrix4()
    const pos = new THREE.Vector3()
    const quat = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    const pose = birdPose()
    for (let i = 0; i < flock.birds.length; i++) {
      birdAt(flock, flock.birds[i] as (typeof flock.birds)[number], 2.5, pose)
      field.object.getMatrixAt(i, m)
      m.decompose(pos, quat, scale)
      expect(pos.x).toBeCloseTo(pose.x, 3)
      expect(pos.y).toBeCloseTo(pose.y, 3)
      expect(pos.z).toBeCloseTo(-pose.z, 3)
    }
    field.dispose()
  })

  it('points its NOSE where it is flying — measured, not asserted about a quaternion', () => {
    // The orientation lesson. Take the two vertices that define the body axis,
    // push them through the instance matrix, and compare the vector between
    // them with the flight direction. True whatever anyone believes about
    // conventions, and it is what would have caught the four orientation bugs
    // this port has already had.
    const bird = generateBird()
    let noseZ = Number.NEGATIVE_INFINITY
    let tailZ = Number.POSITIVE_INFINITY
    for (let i = 2; i < bird.positions.length; i += 3) {
      const z = bird.positions[i] as number
      if (z > noseZ) noseZ = z
      if (z < tailZ) tailZ = z
    }
    const field = createFlockField(bird, [flock])
    field.update(1.75)
    const m = new THREE.Matrix4()
    const pose = birdPose()
    const nose = new THREE.Vector3()
    const tail = new THREE.Vector3()
    for (let i = 0; i < flock.birds.length; i++) {
      birdAt(flock, flock.birds[i] as (typeof flock.birds)[number], 1.75, pose)
      field.object.getMatrixAt(i, m)
      nose.set(0, 0, noseZ).applyMatrix4(m)
      tail.set(0, 0, tailZ).applyMatrix4(m)
      const axis = nose.sub(tail).normalize()
      // The flight direction, in three space: the pure layer's tangent with the
      // same z flip the position took.
      const want = new THREE.Vector3(pose.dx, pose.dy, -pose.dz).normalize()
      expect(axis.dot(want), `bird ${i} nose along the flight path`).toBeCloseTo(1, 4)
    }
    field.dispose()
  })

  it('beats its wings out of step, and tags its own program', () => {
    const field = createFlockField(generateBird(), [flock])
    const iPhase = field.object.geometry.getAttribute('iPhase')
    const seen = new Set<number>()
    for (let i = 0; i < iPhase.count; i++) seen.add(iPhase.getX(i))
    expect(seen.size, 'every wing phase distinct').toBe(iPhase.count)
    const material = field.object.material as THREE.Material
    expect(material.customProgramCacheKey()).toContain('dressing-flock')
    const src = compileVertex(material)
    expect(src).toContain('attribute float iPhase;')
    expect(src).toContain('uWingSweep')
    expect(src).toContain(HOOK)
    field.dispose()
  })
})
