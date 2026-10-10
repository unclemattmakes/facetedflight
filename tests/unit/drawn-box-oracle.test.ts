import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { type DrawnBox, drawnBoxOf, drawnBoxOfVertices } from '@/game/props/load-props'
import { lcg } from './helpers/seeded'

// Reuse audit, last clones (DEV-780): `drawnBoxOf` and `drawnBoxOfVertices`
// shared one extents accumulator, written out twice. They now share it. This
// oracle keeps the two ORIGINAL bodies, byte for byte, and compares every field
// over fuzzed boxes, vertex clouds and matrices (rotation, scale, mirror,
// translation, degenerate scale 0, empty cloud) with Object.is, so a changed
// operation order, a -0 or a NaN would fail.

const legacyBoxOf = (min: THREE.Vector3, max: THREE.Vector3, m: THREE.Matrix4): DrawnBox => {
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  const c = new THREE.Vector3()
  for (const x of [min.x, max.x])
    for (const y of [min.y, max.y])
      for (const z of [min.z, max.z]) {
        c.set(x, y, z).applyMatrix4(m)
        minY = Math.min(minY, c.y)
        maxY = Math.max(maxY, c.y)
        minX = Math.min(minX, c.x)
        maxX = Math.max(maxX, c.x)
        minZ = Math.min(minZ, c.z)
        maxZ = Math.max(maxZ, c.z)
      }
  return {
    height: maxY,
    base: minY,
    width: Math.max(maxX - minX, maxZ - minZ),
    centreX: (minX + maxX) / 2,
    centreZ: (minZ + maxZ) / 2,
  }
}

const legacyBoxOfVertices = (
  positions: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  m: THREE.Matrix4,
): DrawnBox => {
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  const c = new THREE.Vector3()
  for (let i = 0; i < positions.count; i++) {
    c.fromBufferAttribute(positions, i).applyMatrix4(m)
    minY = Math.min(minY, c.y)
    maxY = Math.max(maxY, c.y)
    minX = Math.min(minX, c.x)
    maxX = Math.max(maxX, c.x)
    minZ = Math.min(minZ, c.z)
    maxZ = Math.max(maxZ, c.z)
  }
  return {
    height: maxY,
    base: minY,
    width: Math.max(maxX - minX, maxZ - minZ),
    centreX: (minX + maxX) / 2,
    centreZ: (minZ + maxZ) / 2,
  }
}

const KEYS = ['height', 'base', 'width', 'centreX', 'centreZ'] as const

const same = (actual: DrawnBox, expected: DrawnBox): void => {
  for (const key of KEYS) expect(Object.is(actual[key], expected[key])).toBe(true)
  expect(Object.keys(actual)).toEqual(Object.keys(expected))
}

const randomMatrix = (rng: () => number): THREE.Matrix4 => {
  const span = (n: number) => (rng() - 0.5) * 2 * n
  const scale = new THREE.Vector3(
    rng() < 0.15 ? 0 : 0.2 + rng() * 8,
    rng() < 0.15 ? -1 - rng() : 0.2 + rng() * 8,
    0.2 + rng() * 8,
  )
  return new THREE.Matrix4().compose(
    new THREE.Vector3(span(3000), span(300), span(3000)),
    new THREE.Quaternion().setFromEuler(
      new THREE.Euler(span(Math.PI), span(Math.PI), span(Math.PI), 'YXZ'),
    ),
    scale,
  )
}

describe('drawn box accumulator, old bodies against the shared one (DEV-780)', () => {
  it('drawnBoxOf agrees field for field over fuzzed boxes and matrices', () => {
    const rng = lcg(780)
    for (let i = 0; i < 400; i++) {
      const a = new THREE.Vector3(rng() * 40 - 20, rng() * 40 - 20, rng() * 40 - 20)
      const b = new THREE.Vector3(rng() * 40 - 20, rng() * 40 - 20, rng() * 40 - 20)
      const min = a.clone().min(b)
      const max = a.clone().max(b)
      const m = randomMatrix(rng)
      same(drawnBoxOf(min, max, m), legacyBoxOf(min, max, m))
    }
  })

  it('drawnBoxOfVertices agrees field for field over fuzzed clouds and matrices', () => {
    const rng = lcg(781)
    for (let i = 0; i < 200; i++) {
      const count = 1 + Math.floor(rng() * 300)
      const verts = new Float32Array(count * 3)
      for (let k = 0; k < verts.length; k++) verts[k] = (rng() - 0.5) * 120
      const attribute = new THREE.BufferAttribute(verts, 3)
      const m = randomMatrix(rng)
      same(drawnBoxOfVertices(attribute, m), legacyBoxOfVertices(attribute, m))
    }
  })

  it('drawnBoxOfVertices agrees on an interleaved attribute', () => {
    const rng = lcg(782)
    const data = new Float32Array(50 * 8)
    for (let k = 0; k < data.length; k++) data[k] = (rng() - 0.5) * 60
    const attribute = new THREE.InterleavedBufferAttribute(
      new THREE.InterleavedBuffer(data, 8),
      3,
      2,
    )
    const m = randomMatrix(rng)
    same(drawnBoxOfVertices(attribute, m), legacyBoxOfVertices(attribute, m))
  })

  it('an empty cloud agrees too (the infinities and their NaN centre)', () => {
    const attribute = new THREE.BufferAttribute(new Float32Array(0), 3)
    const m = new THREE.Matrix4()
    same(drawnBoxOfVertices(attribute, m), legacyBoxOfVertices(attribute, m))
  })
})
