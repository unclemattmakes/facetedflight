// tests/unit/prop-fracture.test.ts — a prop splits into its own faces and
// nothing is lost or invented. DEV-136.
//
// `splitIntoChunks` is the pre-split: every triangle of the source lands in
// exactly one chunk, with its position, normal and colour intact, and the
// chunks' directions point away from the prop's own middle. Then the runtime:
// pieces fly, fall under (0, -32, 0), fade, and are gone after `seconds`.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { tagProgramCacheKey } from '@/render/program-cache-key'
import { createPropFracture, FRACTURE_CHUNKS, splitIntoChunks } from '@/render/prop-fracture'

/** A faceted cone: 24 side faces, split per triangle, one colour per face. */
const cone = (): THREE.BufferGeometry => {
  const g = new THREE.ConeGeometry(1, 3, 24).toNonIndexed()
  const n = g.getAttribute('position').count
  const color = new Float32Array(n * 3)
  for (let i = 0; i < n; i += 3) {
    const shade = 0.3 + (0.7 * ((i / 3) % 5)) / 5
    for (let k = 0; k < 3; k++) {
      color[(i + k) * 3] = shade
      color[(i + k) * 3 + 1] = shade * 0.8
      color[(i + k) * 3 + 2] = shade * 0.5
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(color, 3))
  g.computeVertexNormals()
  return g
}

describe('DEV-136: the fracture', () => {
  it('splits every triangle into exactly one of up to six chunks, carrying colour and normal', () => {
    const src = cone()
    const chunks = splitIntoChunks(src)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.length).toBeLessThanOrEqual(FRACTURE_CHUNKS)
    const total = chunks.reduce((a, c) => a + c.geometry.getAttribute('position').count, 0)
    expect(total).toBe(src.getAttribute('position').count)
    for (const c of chunks) {
      expect(c.geometry.getAttribute('normal')).toBeDefined()
      expect(c.geometry.getAttribute('color')).toBeDefined()
      expect(c.geometry.getAttribute('color').count).toBe(c.geometry.getAttribute('position').count)
      // The direction is a unit vector pointing away from the middle.
      expect(c.direction.length()).toBeCloseTo(1, 5)
    }
    // Faces are shared by NO two chunks: the set of colours per chunk is a
    // partition of the source's colour triples in order, so the sum of face
    // counts matched above and no face's colour changed.
    const srcColor = src.getAttribute('color') as THREE.BufferAttribute
    let seen = 0
    for (const c of chunks) {
      const cc = c.geometry.getAttribute('color') as THREE.BufferAttribute
      for (let i = 0; i < cc.count; i++) {
        // Every chunk vertex colour exists somewhere in the source palette.
        const r = cc.getX(i)
        let found = false
        for (let j = 0; j < srcColor.count && !found; j += 3)
          found = Math.abs(srcColor.getX(j) - r) < 1e-6
        expect(found).toBe(true)
        seen++
      }
    }
    expect(seen).toBe(srcColor.count)
  })

  it('flies the pieces apart, drops them under the world gravity, fades them, and removes them after `seconds`', () => {
    const fx = createPropFracture(1.5)
    const src = cone()
    const material = new THREE.MeshStandardMaterial({ vertexColors: true })
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(100, 50, -200),
      new THREE.Quaternion(),
      new THREE.Vector3(5, 5, 5),
    )
    fx.break(src, material, matrix, new THREE.Vector3(0, 0, -90))
    const n = fx.live
    expect(n).toBeGreaterThan(1)
    const first = fx.group.children[0] as THREE.Mesh
    const start = first.position.clone()
    const startY = start.y

    fx.update(0.5)
    expect(fx.live).toBe(n)
    // Moved outward AND down: the group's centre drifts from the start, and
    // after half a second under -32 every piece has lost height net of its
    // outward push (which is horizontal-ish, 8 m/s).
    expect(first.position.distanceTo(start)).toBeGreaterThan(2)
    expect(first.position.y).toBeLessThan(startY)
    const m = first.material as THREE.Material & { opacity: number }
    expect(m.opacity).toBeCloseTo(1 - 0.5 / 1.5, 3)
    expect(m.transparent).toBe(true)

    fx.update(1.1)
    expect(fx.live).toBe(0)
    expect(fx.group.children).toHaveLength(0)
    fx.dispose()
  })

  it('shares the split across breaks of the same geometry', () => {
    const fx = createPropFracture(1)
    const src = cone()
    const material = new THREE.MeshStandardMaterial()
    const m = new THREE.Matrix4()
    fx.break(src, material, m, new THREE.Vector3())
    const geomA = (fx.group.children[0] as THREE.Mesh).geometry
    fx.break(src, material, m, new THREE.Vector3())
    const perBreak = fx.live / 2
    const geomB = (fx.group.children[perBreak] as THREE.Mesh).geometry
    expect(geomB).toBe(geomA)
    fx.dispose()
  })
})

// ── DEV-177(a): the piece draws with the PROP's shader, and once ────────────
//
// Measured before the fix, flat `int_01` under the autopilot with
// `renderer.info.programs` polled every 100 ms: at the frame the fracture went
// live 0 -> 6 the renderer gained a program, and it lost it again 1.4 s later
// when the last piece faded and the clone was disposed. Every assertion below
// is on a MECHANISM three's program cache actually reads — the two hooks
// `Material.copy` does not carry, and whether a material is made at all — and
// not on a millisecond.
describe('DEV-177(a): a fracture piece does not compile its own shader', () => {
  /** A prop material as `applyAtmosphere` leaves it: chained patch, tagged key. */
  const patched = (): { material: THREE.MeshStandardMaterial; calls: () => number } => {
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true })
    let calls = 0
    const previous = material.onBeforeCompile
    material.onBeforeCompile = (shader, renderer) => {
      previous?.call(material, shader, renderer)
      calls++
      shader.fragmentShader = `// fog\n${shader.fragmentShader}`
    }
    tagProgramCacheKey(material, 'unity-fog')
    tagProgramCacheKey(material, 'sun-height')
    return { material, calls: () => calls }
  }

  const shader = (): THREE.WebGLProgramParametersWithUniforms =>
    ({
      vertexShader: 'void main() {}',
      fragmentShader: 'void main() {}',
      uniforms: {},
    }) as unknown as THREE.WebGLProgramParametersWithUniforms

  it('carries the prop chain that `Material.copy` drops, so the piece is fogged', () => {
    // The bug, stated as the thing a player could see: a bare `clone()` gets
    // three's EMPTY prototype callback, so every chained patch the prop
    // carries — Unity fog, the far-field sun term — is silently absent from
    // the pieces. `calls` is the base's own patch counting its invocations.
    const fx = createPropFracture(1)
    const { material, calls } = patched()
    fx.break(cone(), material, new THREE.Matrix4(), new THREE.Vector3())
    const piece = (fx.group.children[0] as THREE.Mesh).material as THREE.Material
    const s = shader()
    piece.onBeforeCompile(s, null as unknown as THREE.WebGLRenderer)
    expect(calls(), "the base's chain ran for the piece").toBe(1)
    expect(s.fragmentShader, 'and it really injected its GLSL').toContain('// fog')
    fx.dispose()
  })

  it('and takes the prop cache key, not the empty prototype callback one', () => {
    // three's default `customProgramCacheKey()` is
    // `this.onBeforeCompile.toString()`. On a bare clone that is the prototype
    // no-op's source — a key with none of the prop's tags in it, which is what
    // the flat probe read off the added program.
    const fx = createPropFracture(1)
    const { material } = patched()
    fx.break(cone(), material, new THREE.Matrix4(), new THREE.Vector3())
    const piece = (fx.group.children[0] as THREE.Mesh).material as THREE.Material
    expect(piece.customProgramCacheKey()).toBe(material.customProgramCacheKey())
    expect(piece.customProgramCacheKey()).toContain('|unity-fog|sun-height')
    // And the shape of the bug, so this test fails for the right reason if the
    // delegation is ever dropped: a plain clone does NOT agree.
    const bare = material.clone()
    expect(bare.customProgramCacheKey()).not.toBe(material.customProgramCacheKey())
    fx.dispose()
  })

  it('pools its materials, so a LATER break makes none and releases none', () => {
    // The pool. A disposed material hands its program back, so a second break
    // would compile again — the stall arriving once per break instead of once
    // per run. A break takes one material per CHUNK, because each piece fades
    // on its own mesh; every one of them is the same PROGRAM (below). What
    // must not move is the count across a second break with a full fade
    // between.
    const fx = createPropFracture(1)
    const { material } = patched()
    const src = cone()
    fx.break(src, material, new THREE.Matrix4(), new THREE.Vector3())
    const after1 = fx.materialCount
    expect(after1).toBe(fx.live)
    fx.update(1.1)
    expect(fx.live).toBe(0)
    fx.break(src, material, new THREE.Matrix4(), new THREE.Vector3())
    expect(fx.materialCount, 'the second break reused the pool').toBe(after1)
    fx.dispose()
  })

  it('and every piece of a break shares ONE program key — the prop one', () => {
    // The count above is materials, not programs. This is the program: three
    // keys on `customProgramCacheKey` plus its own parameters, and the chunks
    // of one geometry carry the same attributes, so six materials are one
    // compile. Asserted as a RELATIONSHIP to the prop's key rather than as a
    // literal, which is true whatever the chain happens to be that day.
    const fx = createPropFracture(1)
    const { material } = patched()
    fx.break(cone(), material, new THREE.Matrix4(), new THREE.Vector3())
    const keys = new Set(
      fx.group.children.map((c) =>
        ((c as THREE.Mesh).material as THREE.Material).customProgramCacheKey(),
      ),
    )
    expect(keys.size, 'one key across every piece of the break').toBe(1)
    expect([...keys][0]).toBe(material.customProgramCacheKey())
    fx.dispose()
  })

  it('primes one piece material per prop material, on an invisible mesh', () => {
    // What `warmWorld`'s `compile(scene, camera)` will find: a mesh under the
    // group, never drawn, carrying the material whose program is being paid
    // for. Two entries sharing one material prime once — a cell split (DEV-118)
    // gives several `InstancedMesh`es per palette entry and they share it.
    const fx = createPropFracture(1)
    const a = patched().material
    const b = patched().material
    const geometry = cone()
    const primed = fx.prime([
      { geometry, material: a },
      { geometry, material: a },
      { geometry, material: b },
    ])
    expect(primed.materials, 'one per DISTINCT prop material').toBe(2)
    expect(fx.materialCount).toBe(2)
    expect(fx.group.children).toHaveLength(2)
    for (const child of fx.group.children) {
      expect(child.visible, 'never drawn').toBe(false)
      const m = (child as THREE.Mesh).material as THREE.Material
      expect(m.transparent, 'the variant being warmed is the fading one').toBe(true)
    }
    // And a break afterwards takes the primed material for its FIRST piece
    // rather than making a seventh: the program is already there, and the
    // materials the break adds beside it share its key (the test above).
    primed.done()
    expect(fx.group.children).toHaveLength(0)
    fx.break(geometry, a, new THREE.Matrix4(), new THREE.Vector3())
    expect(fx.materialCount, "prime's two, plus one per further chunk of this break").toBe(
      2 + fx.live - 1,
    )
    fx.dispose()
  })

  it('primes nothing twice, so a re-prime cannot inflate the count', () => {
    const fx = createPropFracture(1)
    const a = patched().material
    const geometry = cone()
    fx.prime([{ geometry, material: a }]).done()
    const primed = fx.prime([{ geometry, material: a }])
    expect(primed.materials).toBe(0)
    expect(fx.materialCount).toBe(1)
    fx.dispose()
  })
})

// DEV-685: the piece is compiled with the PROP's defines.
//
// `Material.copy` resets `defines` (MeshStandardMaterial's `copy()` assigns
// `{ STANDARD: '' }`, and a Lambert material has none to copy at all), so a bare
// `clone()` is born without whatever the prop was given at runtime. DEV-177(a)
// delegated the two HOOKS and the key and left the defines to `copy()`. The
// hooks read `base.defines` (far-shadow's canopy splice does, at compile time)
// while three compiles the PIECE's program from the PIECE's defines, so
// `#ifdef FF2_CANOPY_OBJECT` blocks went the other way: a breaking tree's pieces
// lost the canopy darkening the standing tree had, and any fragment gate or
// baked-light define with it.
describe('DEV-685: a fracture piece carries its prop material runtime defines', () => {
  const runtimeDefines = (m: THREE.Material): void => {
    // The shape far-shadow.ts and baked-light.ts leave: spread into a new
    // object, one name at a time, in an order three hashes.
    m.defines = { ...(m.defines ?? {}), FF2_CANOPY_OBJECT: '' }
    m.defines = { ...m.defines, FF2_BAKED_RUNG1: '' }
  }
  const entries = (m: THREE.Material): [string, unknown][] => Object.entries(m.defines ?? {})

  const pieceOf = (fx: ReturnType<typeof createPropFracture>, i = 0): THREE.Material =>
    (fx.group.children[i] as THREE.Mesh).material as THREE.Material

  const bases: [string, () => THREE.Material][] = [
    ['MeshStandardMaterial', () => new THREE.MeshStandardMaterial({ vertexColors: true })],
    ['MeshLambertMaterial', () => new THREE.MeshLambertMaterial({ vertexColors: true })],
  ]

  for (const [name, make] of bases) {
    it(`${name}: every piece has the base's defines, in the base's insertion order`, () => {
      const fx = createPropFracture(1)
      const base = make()
      runtimeDefines(base)
      fx.break(cone(), base, new THREE.Matrix4(), new THREE.Vector3())
      expect(fx.live).toBeGreaterThan(1)
      for (let i = 0; i < fx.live; i++) {
        expect(entries(pieceOf(fx, i)), `piece ${i}`).toEqual(entries(base))
      }
      expect(pieceOf(fx).defines?.FF2_CANOPY_OBJECT).toBe('')
      fx.dispose()
    })

    it(`${name}: a primed piece material is cut with them too`, () => {
      const fx = createPropFracture(1)
      const base = make()
      runtimeDefines(base)
      const primed = fx.prime([{ geometry: cone(), material: base }])
      expect(entries(pieceOf(fx))).toEqual(entries(base))
      primed.done()
      fx.dispose()
    })
  }

  it('a pooled piece follows the base when its defines moved since it was cut', () => {
    // The pool lends a piece back long after birth, and `copy()` only ran at
    // birth. The base's defines are edited in place at runtime (fragment gates,
    // baked light), so a piece cut under one state and lent under another would
    // otherwise compile the first state's program.
    const fx = createPropFracture(1)
    const base = new THREE.MeshStandardMaterial({ vertexColors: true })
    runtimeDefines(base)
    fx.break(cone(), base, new THREE.Matrix4(), new THREE.Vector3())
    fx.update(1.1)
    expect(fx.live).toBe(0)
    // In place, as fragment-gates.ts does it.
    const defines = base.defines as Record<string, unknown>
    delete defines.FF2_BAKED_RUNG1
    defines.FF2_FRAGMENT_GATE_X = ''
    fx.break(cone(), base, new THREE.Matrix4(), new THREE.Vector3())
    expect(fx.live).toBeGreaterThan(1)
    for (let i = 0; i < fx.live; i++) {
      expect(entries(pieceOf(fx, i)), `piece ${i} after the base moved`).toEqual(entries(base))
    }
    fx.dispose()
  })

  it('leaves the base own defines untouched and does not alias them', () => {
    const fx = createPropFracture(1)
    const base = new THREE.MeshStandardMaterial({ vertexColors: true })
    runtimeDefines(base)
    const snapshot = entries(base)
    fx.break(cone(), base, new THREE.Matrix4(), new THREE.Vector3())
    expect(entries(base)).toEqual(snapshot)
    expect(pieceOf(fx).defines).not.toBe(base.defines)
    fx.dispose()
  })
})
