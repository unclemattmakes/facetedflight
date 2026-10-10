// tests/unit/loading-tone.test.ts — the loading scene wears the MENUS' curve,
// whatever curve the renderer is on. DEV-451.
//
// Since DEV-451 the mission's edition goes on at the black INTO the loading
// scene (so the world is built under the look it is flown in), and a preset's
// tone curve is renderer state. Photographed, a Classic player's loading scene
// came out a lighter grey-blue than an Anniversary player's: Classic's curve
// is none, Anniversary's ACES. So the scene draws the menus' curve into its
// own colours and is not tone-mapped by the renderer at all.
//
// The oracle for the curve is three's own shader chunk, read off disk here:
// the numbers `acesFilmic` must reproduce are parsed out of
// `tonemapping_pars_fragment`, not copied into this file.

import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { acesFilmic, buildEmblem, createLoadingScene } from '@/render/loading-scene'
import { REPO as ROOT } from './helpers/repo-root'

const CHUNK = path.join(
  ROOT,
  'node_modules/three/src/renderers/shaders/ShaderChunk/tonemapping_pars_fragment.glsl.js',
)

/** three's ACES, evaluated from the numbers in its own GLSL. */
const threeAces = (): ((rgb: [number, number, number], exposure: number) => number[]) => {
  const src = fs.readFileSync(CHUNK, 'utf8')
  const fn = src.slice(src.indexOf('vec3 RRTAndODTFit'), src.indexOf('// Matrices for rec 2020'))
  const nums = (s: string): number[] =>
    [...s.matchAll(/-?\s*\d+\.\d+/g)].map((m) => Number(m[0].replace(/\s+/g, '')))
  // `a = v * ( v + n0 ) - n1; b = v * ( n2 * v + n3 ) + n4`: the minus is
  // read WITH its number, so the fit below adds it.
  const fit = nums(fn.slice(0, fn.indexOf('return a / b')))
  const inMat = nums(fn.slice(fn.indexOf('ACESInputMat = mat3'), fn.indexOf('ODT_SAT')))
  const outMat = nums(fn.slice(fn.indexOf('ACESOutputMat = mat3'), fn.indexOf('color *=')))
  const scale = nums(fn.slice(fn.indexOf('color *='), fn.indexOf('color = ACESInputMat')))
  expect(fit, 'the fit’s five numbers').toHaveLength(5)
  expect(inMat).toHaveLength(9)
  expect(outMat).toHaveLength(9)
  expect(scale, 'the exposure divisor').toEqual([0.6])
  // GLSL `mat3(c0, c1, c2) * v` is c0 * v.x + c1 * v.y + c2 * v.z.
  const mul = (m: number[], v: number[]): number[] =>
    [0, 1, 2].map(
      (row) =>
        (m[row] as number) * (v[0] as number) +
        (m[3 + row] as number) * (v[1] as number) +
        (m[6 + row] as number) * (v[2] as number),
    )
  const [a0, a1, b0, b1, b2] = fit as [number, number, number, number, number]
  expect(a1, 'the fit subtracts its second number').toBeLessThan(0)
  const rrt = (v: number): number => (v * (v + a0) + a1) / (v * (b0 * v + b1) + b2)
  return (rgb, exposure) =>
    mul(
      outMat,
      mul(
        inMat,
        rgb.map((c) => (c * exposure) / (scale[0] as number)),
      ).map(rrt),
    ).map((c) => Math.min(1, Math.max(0, c)))
}

describe('the menus’ curve, on the CPU', () => {
  it('is three’s ACESFilmicToneMapping, number for number', () => {
    const reference = threeAces()
    const samples: [number, number, number][] = [
      [0, 0, 0],
      [0.0042, 0.0054, 0.0069],
      [0.023, 0.041, 0.075],
      [0.5, 0.25, 0.1],
      [1, 1, 1],
      [4, 0.2, 0.01],
    ]
    for (const exposure of [1, 0.8]) {
      for (const s of samples) {
        const got = [...s]
        acesFilmic(got, 0, exposure)
        const want = reference(s, exposure)
        for (let k = 0; k < 3; k++) {
          expect(
            Math.abs((got[k] as number) - (want[k] as number)),
            `${s} @ ${exposure}`,
          ).toBeLessThan(1e-9)
        }
      }
    }
  })
})

/** Every vertex colour under the scene's dome and ground, by mesh name. */
const coloursOf = (
  scene: THREE.Object3D,
): Map<string, { toneMapped: boolean; rgb: Float32Array }> => {
  const out = new Map<string, { toneMapped: boolean; rgb: Float32Array }>()
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || !(o.name === 'loading-dome' || o.name === 'loading-ground')) return
    const colour = mesh.geometry.getAttribute('color') as THREE.BufferAttribute
    out.set(o.name, {
      toneMapped: (mesh.material as THREE.Material).toneMapped,
      rgb: colour.array as Float32Array,
    })
  })
  return out
}

/** The plate's canvas, as `loading-emblem.test.ts` stubs it: node has no DOM. */
const stubCanvas = (): void => {
  const ctx = new Proxy(
    {},
    {
      get: (_t, key) => (key === 'measureText' ? () => ({ width: 10 }) : () => undefined),
      set: () => true,
    },
  )
  vi.stubGlobal('document', {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
  })
}

describe('the loading scene under a tone', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    stubCanvas()
  })

  it('is not tone-mapped by the renderer, and carries the curve in its colours instead', () => {
    const plain = coloursOf(createLoadingScene().object)
    const toned = coloursOf(createLoadingScene({ tone: { curve: 'aces', exposure: 1 } }).object)
    expect([...toned.keys()].sort()).toEqual(['loading-dome', 'loading-ground'])
    for (const [name, t] of toned) {
      const p = plain.get(name)
      expect(p?.toneMapped, `${name} without a tone: the renderer's curve, as before`).toBe(true)
      expect(t.toneMapped, `${name} under a tone: not the renderer's`).toBe(false)
      const want = Float32Array.from(p?.rgb ?? [])
      for (let i = 0; i < want.length; i += 3) acesFilmic(want, i, 1)
      expect(t.rgb.length).toBe(want.length)
      for (let i = 0; i < want.length; i++) {
        expect(Math.abs((t.rgb[i] as number) - (want[i] as number)), `${name}[${i}]`).toBeLessThan(
          1e-6,
        )
      }
    }
  })

  it('leaves the colours alone under the curve that is none', () => {
    const plain = coloursOf(createLoadingScene().object)
    const none = coloursOf(createLoadingScene({ tone: { curve: 'none', exposure: 1 } }).object)
    for (const [name, n] of none) {
      expect(n.toneMapped).toBe(false)
      expect([...n.rgb]).toEqual([...(plain.get(name)?.rgb ?? [])])
    }
  })

  it('shades the emblem through the same curve, every turn', () => {
    // A two-mesh stand-in for the title's logo: a turning part and a wordmark.
    const tri = (y: number): THREE.BufferGeometry =>
      new THREE.BufferGeometry().setAttribute(
        'position',
        new THREE.Float32BufferAttribute([0, y, 0, 1, y, 0, 0, y + 1, 0.2], 3),
      )
    const logo = new THREE.Group()
    const top = new THREE.Mesh(tri(0), new THREE.MeshBasicMaterial())
    top.name = 'logo_top'
    const words = new THREE.Mesh(tri(2), new THREE.MeshBasicMaterial())
    words.name = 'title'
    logo.add(top, words)
    const material = new THREE.MeshBasicMaterial({ vertexColors: true })
    const plain = buildEmblem(logo, material)
    const toned = buildEmblem(logo, material, { curve: 'aces', exposure: 1 })
    if (!plain || !toned) throw new Error('the stand-in logo built no emblem')
    for (const yaw of [0, 1.3]) {
      plain.shade(yaw)
      toned.shade(yaw)
      const p = Float32Array.from(
        (plain.spin.geometry.getAttribute('color') as THREE.BufferAttribute).array,
      )
      for (let i = 0; i < p.length; i += 3) acesFilmic(p, i, 1)
      const t = (toned.spin.geometry.getAttribute('color') as THREE.BufferAttribute).array
      for (let i = 0; i < p.length; i++) {
        expect(Math.abs((t[i] as number) - (p[i] as number)), `spin[${i}] @ ${yaw}`).toBeLessThan(
          1e-6,
        )
      }
    }
  })
})
