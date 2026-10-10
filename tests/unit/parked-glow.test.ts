// tests/unit/parked-glow.test.ts: the parked jet's nose glow, scaled down (DEV-562).
//
// Matt, 2026-10-01: *"glow on nose/mouth of the ship needs to be scaled down a
// bit, it's interpenetrating the ship."* `render/parked-glow.ts` shrinks ONE
// piece of the wing's glow, toward its own centroid, on the parked jet only.
// The factor is a photograph's (the DEVIATIONS row); what is held here is which
// piece, where it stays, and that nothing else moves. The piece is checked by
// its SHAPE against the direction the code believes is the nose (the
// orientation lesson: a direction is a belief, a shape is not): the piece it
// picks is round, and the piece furthest the OTHER way is an engine disc.
//
// The wing GLB is bought geometry and never in git (hard rule 7): the half that
// reads it is guarded, the disk work is inside each `it`, and the guard has a
// loud counterpart.

import fs from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { describe, expect, it } from 'vitest'
import { SHIP_MESH_WINGS } from '@/game/ship-wings'
import { attachHoverGlow, HOVER_GLOW_NAMES } from '@/render/hover-glow'
import {
  glbNose,
  glowPieces,
  PARKED_NOSE_GLOW_SCALE,
  shrinkParkedNoseGlow,
} from '@/render/parked-glow'

const WINGS_GLB = `public/${SHIP_MESH_WINGS}`
const haveWings = fs.existsSync(WINGS_GLB)

const loadGlb = async (file: string): Promise<THREE.Object3D> => {
  const bytes = fs.readFileSync(file)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(buffer as ArrayBuffer, '', (g) => resolve(g.scene), reject)
  })
}

/** A two-piece "glow" on a "ship": a box at +x (the nose) and one at -x. */
const toyShip = () => {
  const a = new THREE.BoxGeometry(1, 1, 1).translate(3, 0, 0)
  const b = new THREE.BoxGeometry(1, 1, 1).translate(-3, 0, 0)
  const geometry = new THREE.BufferGeometry()
  const pa = a.getAttribute('position').array as Float32Array
  const pb = b.getAttribute('position').array as Float32Array
  const positions = new Float32Array(pa.length + pb.length)
  positions.set(pa)
  positions.set(pb, pa.length)
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  const ia = Array.from(a.getIndex()?.array ?? [])
  const ib = Array.from(b.getIndex()?.array ?? []).map((i) => i + pa.length / 3)
  geometry.setIndex([...ia, ...ib])
  const ship = new THREE.Group()
  const glow = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
  glow.name = HOVER_GLOW_NAMES[1]
  ship.add(glow)
  return { ship, geometry }
}

const extent = (g: THREE.BufferGeometry, vertices: readonly number[]) => {
  const p = g.getAttribute('position')
  return new THREE.Box3().setFromPoints(
    vertices.map((v) => new THREE.Vector3().fromBufferAttribute(p, v)),
  )
}

describe('the parked jet’s nose glow (DEV-562)', () => {
  it('ships a factor under 1, which the row names', () => {
    expect(PARKED_NOSE_GLOW_SCALE).toBeGreaterThan(0.4)
    expect(PARKED_NOSE_GLOW_SCALE).toBeLessThan(1)
  })

  it('points the nose along +x in the hull GLB: the ship’s forward turned back through the art’s yaw', () => {
    const n = glbNose()
    expect(n.x).toBeCloseTo(1, 6)
    expect(Math.hypot(n.y, n.z)).toBeLessThan(1e-6)
  })

  it('shrinks the fore-most piece toward its own centre and leaves the other alone', () => {
    const { ship, geometry } = toyShip()
    const pieces = glowPieces(geometry)
    expect(pieces).toHaveLength(2)
    const before = Float32Array.from(geometry.getAttribute('position').array)
    const scaled = shrinkParkedNoseGlow(ship, 0.5)
    expect(scaled?.centroid.x, 'the +x piece').toBeCloseTo(3, 6)
    const nose = pieces.find((q) => q.centroid.x > 0) as (typeof pieces)[number]
    const tail = pieces.find((q) => q.centroid.x < 0) as (typeof pieces)[number]
    const box = extent(geometry, nose.vertices)
    expect(box.getSize(new THREE.Vector3()).x, 'half its size').toBeCloseTo(0.5, 6)
    expect(box.getCenter(new THREE.Vector3()).x, 'where it stood').toBeCloseTo(3, 6)
    const after = geometry.getAttribute('position').array
    for (const v of tail.vertices)
      for (let k = 0; k < 3; k++) expect(after[v * 3 + k]).toBe(before[v * 3 + k])
  })

  it('finds nothing to do on a jet without its wing', () => {
    expect(shrinkParkedNoseGlow(new THREE.Group())).toBe(null)
  })
})

describe.skipIf(!haveWings)('on hoverjet-wings.glb, as the parked jet carries it', () => {
  it('picks the ROUND piece under the nose, of ten, and the piece furthest aft is an engine DISC', async () => {
    const art = new THREE.Group()
    attachHoverGlow(art, await loadGlb(WINGS_GLB))
    const glow = art.getObjectByName(HOVER_GLOW_NAMES[1]) as THREE.Mesh
    const pieces = glowPieces(glow.geometry)
    expect(pieces, "2016's ten glowyBits").toHaveLength(10)
    const nose = glbNose()
    const aft = pieces.reduce((m, q) => (q.centroid.dot(nose) < m.centroid.dot(nose) ? q : m))
    const aftSize = extent(glow.geometry, aft.vertices).getSize(new THREE.Vector3())
    // Thin along the ship's length: a disc facing aft (`hover-glow.test.ts` reads the same in the ship frame).
    expect(Math.abs(aftSize.dot(nose)) / aftSize.z, 'the aft piece is a disc').toBeLessThan(0.5)

    const before = Float32Array.from(glow.geometry.getAttribute('position').array)
    const fore = shrinkParkedNoseGlow(art) as NonNullable<ReturnType<typeof shrinkParkedNoseGlow>>
    expect(fore).not.toBe(null)
    const size = extent(glow.geometry, fore.vertices).getSize(new THREE.Vector3())
    const was = new THREE.Box3()
      .setFromPoints(fore.vertices.map((v) => new THREE.Vector3().fromArray(before, v * 3)))
      .getSize(new THREE.Vector3())
    expect(was.x / was.z, 'the nose piece is round').toBeGreaterThan(0.8)
    expect(size.x / was.x, 'by the factor').toBeCloseTo(PARKED_NOSE_GLOW_SCALE, 5)
    expect(size.y / was.y).toBeCloseTo(PARKED_NOSE_GLOW_SCALE, 5)
    // Every vertex of the other nine where it was.
    const moved = new Set(fore.vertices)
    const after = glow.geometry.getAttribute('position').array
    let still = 0
    for (let v = 0; v < after.length / 3; v++) {
      if (moved.has(v)) continue
      for (let k = 0; k < 3; k++) expect(after[v * 3 + k]).toBe(before[v * 3 + k])
      still++
    }
    expect(still, 'nine pieces untouched').toBe(after.length / 3 - fore.vertices.length)
  })
})

describe.skipIf(haveWings)('the guarded half of this file', () => {
  it('is skipped only because hoverjet-wings.glb is not hydrated', () => {
    expect(fs.existsSync(WINGS_GLB)).toBe(false)
  })
})
