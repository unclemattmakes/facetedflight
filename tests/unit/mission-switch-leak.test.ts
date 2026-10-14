// tests/unit/mission-switch-leak.test.ts: DEV-936. What a course's world made
// for itself, its dispose gives back to the GPU.
//
// Loading missions in one page grew `renderer.info.memory` by two geometries
// a course and a texture an ocean course (measured 2026-10-13 with a registry
// on the renderer's own dispose listeners; the e2e that holds it is
// `tests/e2e/mission-switch-leak.spec.ts`). The three owners, each held here
// at the object that made the thing:
//
//  - `loadRings`: the frame's baked clone (`bakedGeometry`), shared by every
//    ring and the finish frame. Its dispose freed the loaded original and the
//    instance buffer, never the clone.
//  - `loadTurnIndicators`: the arrow's baked clone, the same shape of miss.
//  - the sea (`applyWaterWaves`): the coast height map `build.ts` hands it per
//    world and keeps no handle on. The sea owns it now.
//
// three frees a geometry's or a texture's GPU memory on its `dispose` EVENT,
// so a listener on the object is exactly what the renderer would see.

import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import type { Level } from '@/content/level-schema'
import { loadRings } from '@/game/rings'
import { loadTurnIndicators } from '@/game/turn-indicators'
import { applyWaterWaves } from '@/render/water'
import int01 from '../../content/levels/int_01_hoverJet.json'

// The GLBs are fetched by URL, which node cannot do; a box stands in, as in
// `gate-draw-order.test.ts`. The builders read a mesh's geometry and nothing else.
vi.mock('@/content/asset-url', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/content/asset-url')>()),
  assetUrl: (p: string) => p,
}))
vi.mock('@/render/load-mesh', async (importOriginal) => {
  const T = await import('three')
  return {
    ...(await importOriginal<typeof import('@/render/load-mesh')>()),
    loadMesh: async () => {
      const object = new T.Group()
      object.add(new T.Mesh(new T.BoxGeometry(1, 1, 1)))
      return { object, meshCount: 1, vertexCount: 24, dispose: () => {} }
    },
  }
})

const LEVEL = int01 as unknown as Level

/** Every geometry under `root`, each with a flag its `dispose` event sets. */
const watchGeometries = (root: THREE.Object3D) => {
  const seen = new Map<THREE.BufferGeometry, { name: string; freed: boolean }>()
  root.traverse((o) => {
    const g = (o as THREE.Mesh).geometry
    if (!g?.isBufferGeometry || seen.has(g)) return
    const row = { name: o.name, freed: false }
    seen.set(g, row)
    g.addEventListener('dispose', () => {
      row.freed = true
    })
  })
  return [...seen.values()]
}

describe('DEV-936: a course world gives back every geometry it drew', () => {
  it('the rings free every geometry under their object, the baked frame included', async () => {
    const rings = await loadRings(LEVEL)
    const rows = watchGeometries(rings.object)
    expect(rows.map((r) => r.name)).toContain('rings')
    rings.dispose()
    expect(rows.filter((r) => !r.freed).map((r) => r.name)).toEqual([])
  })

  it('the turn indicators free every geometry under their object, the baked arrow included', async () => {
    const turns = await loadTurnIndicators(LEVEL)
    const rows = watchGeometries(turns.object)
    expect(rows.map((r) => r.name).sort()).toEqual(['turn-indicator-arrows', 'turn-indicator-bars'])
    turns.dispose()
    expect(rows.filter((r) => !r.freed).map((r) => r.name)).toEqual([])
  })
})

describe('DEV-936: the sea owns the coast map it is handed', () => {
  const sea = () => {
    const material = new THREE.MeshStandardMaterial()
    const water = applyWaterWaves(
      material,
      { live: true, direction: 322, speed: 2, amplitude: 4, frequency: 0.4, noise: -1 },
      null,
    )
    return { material, water }
  }
  const watched = () => {
    const texture = new THREE.DataTexture()
    const row = { texture, freed: false }
    texture.addEventListener('dispose', () => {
      row.freed = true
    })
    return row
  }
  const MAP = {
    originX: 0,
    originY: 0,
    originZ: 0,
    sizeX: 1,
    sizeZ: 1,
    heightScale: 1,
    width: 4,
    height: 4,
  }

  it('frees the map it holds when its material is disposed', () => {
    const { material, water } = sea()
    const map = watched()
    water.setCoastSource(MAP, map.texture)
    expect(map.freed).toBe(false)
    material.dispose()
    expect(map.freed).toBe(true)
  })

  it('frees the map a later call replaces, and keeps one handed twice', () => {
    const { water } = sea()
    const first = watched()
    const second = watched()
    water.setCoastSource(MAP, first.texture)
    water.setCoastSource(MAP, first.texture)
    expect(first.freed).toBe(false)
    water.setCoastSource(MAP, second.texture)
    expect(first.freed).toBe(true)
    expect(second.freed).toBe(false)
  })
})
