import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import {
  disposeTree,
  forEachMeshMaterial,
  forEachUniqueMaterial,
  meshesUnder,
  meshMaterials,
  uniqueMaterials,
  uniqueMaterialsOf,
} from '../../src/render/scene-walk'

/** A tree with a shared material, a two-slot mesh, a Line, Points and a Sprite. */
const build = () => {
  const shared = new THREE.MeshBasicMaterial({ name: 'shared' })
  const solo = new THREE.MeshBasicMaterial({ name: 'solo' })
  const slotA = new THREE.MeshBasicMaterial({ name: 'slotA' })
  const slotB = new THREE.MeshBasicMaterial({ name: 'slotB' })
  const lineMaterial = new THREE.LineBasicMaterial({ name: 'line' })
  const pointsMaterial = new THREE.PointsMaterial({ name: 'points' })
  const spriteMaterial = new THREE.SpriteMaterial({ name: 'sprite' })

  const geometryA = new THREE.BoxGeometry()
  const geometryB = new THREE.BoxGeometry()
  const geometryC = new THREE.BoxGeometry()
  const lineGeometry = new THREE.BufferGeometry()
  const pointsGeometry = new THREE.BufferGeometry()

  const root = new THREE.Group()
  const a = new THREE.Mesh(geometryA, shared)
  const b = new THREE.Mesh(geometryB, shared)
  const c = new THREE.Mesh(geometryC, [slotA, slotB])
  const deep = new THREE.Group()
  const d = new THREE.Mesh(new THREE.BoxGeometry(), solo)
  deep.add(d)
  const line = new THREE.Line(lineGeometry, lineMaterial)
  const points = new THREE.Points(pointsGeometry, pointsMaterial)
  const sprite = new THREE.Sprite(spriteMaterial)
  root.add(a, b, c, deep, line, points, sprite)

  const spies = {
    geometries: [geometryA, geometryB, geometryC, d.geometry].map((g) => vi.spyOn(g, 'dispose')),
    lineGeometry: vi.spyOn(lineGeometry, 'dispose'),
    pointsGeometry: vi.spyOn(pointsGeometry, 'dispose'),
    shared: vi.spyOn(shared, 'dispose'),
    solo: vi.spyOn(solo, 'dispose'),
    slotA: vi.spyOn(slotA, 'dispose'),
    slotB: vi.spyOn(slotB, 'dispose'),
    line: vi.spyOn(lineMaterial, 'dispose'),
    points: vi.spyOn(pointsMaterial, 'dispose'),
    sprite: vi.spyOn(spriteMaterial, 'dispose'),
  }
  return { root, a, b, c, d, shared, solo, slotA, slotB, spies }
}

describe('meshMaterials', () => {
  it('normalises one material and an array to an array', () => {
    const { a, c, slotA, slotB, shared } = build()
    expect(meshMaterials(a)).toEqual([shared])
    expect(meshMaterials(c)).toEqual([slotA, slotB])
  })

  it('drops an empty slot', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), [
      new THREE.MeshBasicMaterial(),
      null as unknown as THREE.Material,
    ])
    expect(meshMaterials(mesh)).toHaveLength(1)
  })
})

describe('the material walks', () => {
  it('visits meshes only: Line, Points and Sprite children are skipped', () => {
    const { root, a, b, c, d } = build()
    expect(meshesUnder(root)).toEqual([a, b, c, d])
  })

  it('forEachMeshMaterial visits a shared material once per mesh slot, naming the mesh', () => {
    const { root, a, b, shared } = build()
    const seen: [string, THREE.Mesh][] = []
    forEachMeshMaterial(root, (m, mesh) => seen.push([m.name, mesh]))
    expect(seen.map(([n]) => n)).toEqual(['shared', 'shared', 'slotA', 'slotB', 'solo'])
    expect(seen[0]?.[1]).toBe(a)
    expect(seen[1]?.[1]).toBe(b)
    expect(shared.name).toBe('shared')
  })

  it('uniqueMaterials is first-seen order with the shared material once', () => {
    const { root } = build()
    expect(uniqueMaterials(root).map((m) => m.name)).toEqual(['shared', 'slotA', 'slotB', 'solo'])
    const names: string[] = []
    forEachUniqueMaterial(root, (m) => names.push(m.name))
    expect(names).toEqual(['shared', 'slotA', 'slotB', 'solo'])
  })

  it('uniqueMaterialsOf takes a mesh list the caller already holds', () => {
    const { a, b, c } = build()
    expect(uniqueMaterialsOf([a, b, c]).map((m) => m.name)).toEqual(['shared', 'slotA', 'slotB'])
  })

  it('includes the root itself when the root is a mesh', () => {
    const { a } = build()
    expect(meshesUnder(a)).toEqual([a])
  })
})

describe('disposeTree', () => {
  it('frees every mesh geometry and every material slot, and nothing else', () => {
    const { root, spies } = build()
    disposeTree(root)
    for (const spy of spies.geometries) expect(spy).toHaveBeenCalledTimes(1)
    expect(spies.solo).toHaveBeenCalledTimes(1)
    expect(spies.slotA).toHaveBeenCalledTimes(1)
    expect(spies.slotB).toHaveBeenCalledTimes(1)
    // A material under two meshes is freed under each: not de-duplicated.
    expect(spies.shared).toHaveBeenCalledTimes(2)
    // Line, Points and Sprite are not meshes: none of their resources is touched.
    expect(spies.lineGeometry).not.toHaveBeenCalled()
    expect(spies.pointsGeometry).not.toHaveBeenCalled()
    expect(spies.line).not.toHaveBeenCalled()
    expect(spies.points).not.toHaveBeenCalled()
    expect(spies.sprite).not.toHaveBeenCalled()
  })

  it('geometry only leaves every material alone (the shared-material owner)', () => {
    const { root, spies } = build()
    disposeTree(root, { materials: false })
    for (const spy of spies.geometries) expect(spy).toHaveBeenCalledTimes(1)
    expect(spies.shared).not.toHaveBeenCalled()
    expect(spies.solo).not.toHaveBeenCalled()
    expect(spies.slotA).not.toHaveBeenCalled()
  })

  it('materials only leaves every geometry alone (the room owns them)', () => {
    const { root, spies } = build()
    disposeTree(root, { geometry: false })
    for (const spy of spies.geometries) expect(spy).not.toHaveBeenCalled()
    expect(spies.solo).toHaveBeenCalledTimes(1)
    expect(spies.slotB).toHaveBeenCalledTimes(1)
  })

  it('never disposes a material texture', () => {
    const texture = new THREE.Texture()
    const spy = vi.spyOn(texture, 'dispose')
    const material = new THREE.MeshBasicMaterial({ map: texture })
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material)
    disposeTree(mesh)
    expect(spy).not.toHaveBeenCalled()
  })

  it('takes a null root', () => {
    expect(() => disposeTree(null)).not.toThrow()
    expect(() => disposeTree(undefined)).not.toThrow()
  })
})
