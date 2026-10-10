/**
 * tests/unit/render-census.test.ts — the census counts what a draw would draw.
 *
 * DEV-118. The pure half: folding three's render items into per-group rows.
 * The overdraw half needs a GL context and is exercised by
 * `tests/e2e/render-census.spec.ts`.
 */
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  type CensusItem,
  censusRows,
  itemTriangles,
  topGroupName,
} from '../../src/boot/render-census'

const tri = (n: number, indexed: boolean): THREE.BufferGeometry => {
  const g = new THREE.BufferGeometry()
  const verts = indexed ? 3 : n * 3
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3))
  if (indexed) g.setIndex(new Array(n * 3).fill(0))
  return g
}

const item = (object: THREE.Object3D, geometry: THREE.BufferGeometry): CensusItem => ({
  object,
  geometry,
  material: (object as THREE.Mesh).material as THREE.Material,
  group: null,
})

describe('render census — DEV-118', () => {
  it('counts triangles from the index when there is one, the positions otherwise', () => {
    const indexed = new THREE.Mesh(tri(10, true))
    const soup = new THREE.Mesh(tri(7, false))
    expect(itemTriangles(item(indexed, indexed.geometry))).toBe(10)
    expect(itemTriangles(item(soup, soup.geometry))).toBe(7)
  })

  it('multiplies by the instance count, honours the draw range and a material group', () => {
    const inst = new THREE.InstancedMesh(tri(4, true), new THREE.MeshBasicMaterial(), 25)
    expect(itemTriangles(item(inst, inst.geometry))).toBe(100)
    const ranged = new THREE.Mesh(tri(10, true))
    ranged.geometry.setDrawRange(0, 9)
    expect(itemTriangles(item(ranged, ranged.geometry))).toBe(3)
    expect(itemTriangles({ ...item(ranged, ranged.geometry), group: { start: 0, count: 6 } })).toBe(
      2,
    )
    expect(itemTriangles({ ...item(ranged, ranged.geometry), geometry: null })).toBe(0)
  })

  it('names a draw by the scene child it hangs under, however deep', () => {
    const scene = new THREE.Scene()
    const terrain = new THREE.Group()
    terrain.name = 'world-terrain'
    const props = new THREE.Group()
    props.name = 'props'
    const palm = new THREE.Mesh(tri(1, true))
    terrain.add(props)
    props.add(palm)
    scene.add(terrain)
    const loose = new THREE.Mesh(tri(1, true))
    scene.add(loose)
    expect(topGroupName(palm, scene)).toBe('world-terrain')
    expect(topGroupName(loose, scene), 'a nameless direct child reports its type').toBe('Mesh')
  })

  it('folds items into rows, sorted by triangles, with transparent calls counted apart', () => {
    const scene = new THREE.Scene()
    const land = new THREE.Group()
    land.name = 'world-terrain'
    const sea = new THREE.Group()
    sea.name = 'terrain:simonet.sea'
    scene.add(land, sea)
    const chunks = [0, 1, 2].map((i) => {
      const m = new THREE.Mesh(tri(100, true))
      m.name = `chunk_${i}_7`
      land.add(m)
      return m
    })
    // The props hang under the land (DEV-089): one level deeper, their own row,
    // so a census cannot fold a forest into the ground it stands on.
    const props = new THREE.Group()
    props.name = 'props'
    const palms = new THREE.InstancedMesh(tri(20, true), new THREE.MeshBasicMaterial(), 10)
    props.add(palms)
    land.add(props)
    const water = new THREE.Mesh(tri(50, true), new THREE.MeshBasicMaterial({ transparent: true }))
    sea.add(water)
    const rows = censusRows(
      scene,
      [...chunks.map((c) => item(c, c.geometry)), item(palms, palms.geometry)],
      [item(water, water.geometry)],
    )
    expect(rows).toEqual([
      { group: 'world-terrain/chunks', calls: 3, triangles: 300, transparentCalls: 0 },
      { group: 'world-terrain/props', calls: 1, triangles: 200, transparentCalls: 0 },
      { group: 'terrain:simonet.sea', calls: 1, triangles: 50, transparentCalls: 1 },
    ])
  })

  it('does not count an instanced mesh whose count is 0: three issues no draw for it (DEV-785)', () => {
    const scene = new THREE.Scene()
    const clouds = new THREE.Group()
    clouds.name = 'clouds'
    scene.add(clouds)
    const seen = new THREE.InstancedMesh(tri(4, true), new THREE.MeshBasicMaterial(), 3)
    const unseen = new THREE.InstancedMesh(tri(4, true), new THREE.MeshBasicMaterial(), 3)
    unseen.count = 0
    clouds.add(seen, unseen)
    const rows = censusRows(scene, [item(seen, seen.geometry), item(unseen, unseen.geometry)], [])
    expect(rows).toEqual([{ group: 'clouds', calls: 1, triangles: 12, transparentCalls: 0 }])
  })
})
