// tests/unit/gate-draw-order.test.ts — DEV-422. The translucent parts of a
// gate draw FIRST among the translucent things in the world, and write depth.
//
// Matt, 2026-09-26: *"check draw order on ring and arrow material - it seems to
// draw on top of other things?"* The ring frame and the turn indicator's arrow
// wear one material, 2016's `checkpoint_enabled`: translucent, and with
// `depthWrite` off. Against the terrain, the props and the ship it was always
// right — they are opaque, drawn first, and write depth. Against every OTHER
// translucent thing it was decided by the wrong point:
//
//  · §1 three sorts its transparent list back to front by ONE point per
//    object, and an `InstancedMesh` sorts at its instances' bounding-sphere
//    centre. All of a course's ring frames are one `InstancedMesh`, so they
//    sort as one point in the middle of the course. Read out of three's build
//    here, the way `draw-order.test.ts` and `xr-eye-layers.test.ts` read it.
//  · with neither side writing depth, whichever drew second painted over the
//    other. `tests/e2e/gate-draw-order.spec.ts` photographs the case: the
//    orange finish frame, 237.6 m past the last ring, drawn over it.
//
// §2 holds the SHIPPED objects — `loadRings` and `loadTurnIndicators` on
// `int_01_hoverJet`, with the two GLB fetches stood in by a box, which moves
// no material and no draw state — and asserts the two properties that make the
// order right whatever point three sorts by: the gates draw before any
// translucent thing at three's default order, and they write depth, so a
// translucent thing drawn after them is hidden where it is behind a bar and
// drawn over them where it is in front.

import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import type { Level } from '@/content/level-schema'
import { GATE_FRAME_ORDER, loadRings } from '@/game/rings'
import { loadTurnIndicators } from '@/game/turn-indicators'
import int01 from '../../content/levels/int_01_hoverJet.json'
import { REPO as ROOT } from './helpers/repo-root'

// The GLBs are fetched by URL, which node cannot do. A box stands in for the
// frame and the arrow: the builders read a mesh's geometry and nothing else
// off it, and every material, pose and order under test is built by them.
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
const three = (): string =>
  fs.readFileSync(path.join(ROOT, 'node_modules/three/build/three.module.js'), 'utf8')

/** The keys `reversePainterSortStable` compares, in order. The transparent list's sort. */
const transparentSortKeys = (): string[] => {
  const text = three()
  const start = text.indexOf('function reversePainterSortStable(')
  expect(start, 'three no longer has reversePainterSortStable').toBeGreaterThan(-1)
  const end = text.indexOf('\nfunction ', start + 10)
  const body = text.slice(start, end > start ? end : start + 600)
  // z is compared the other way round (`b.z - a.z`, far first); the rest ascend.
  expect(body, 'the transparent list is no longer drawn far-to-near').toContain('b.z - a.z')
  return [...body.matchAll(/a\.([\w.]+)\s*!==\s*b\.\1/g)].map((m) => m[1] as string)
}

interface Item {
  readonly object: THREE.Object3D
  /** Camera-space depth of the object's SORT POINT, three's convention (larger = farther). */
  readonly z: number
}

/** Three's transparent order over `items`, with the comparison read from three's source. */
const transparentSort = (items: readonly Item[]): Item[] => {
  const keys = transparentSortKeys()
  const read = (item: Item, key: string): number => {
    if (key === 'groupOrder') return 0
    if (key === 'renderOrder') return item.object.renderOrder
    if (key === 'z') return item.z
    throw new Error(`reversePainterSortStable compares a key this test does not model: ${key}`)
  }
  const indexed = items.map((item, id) => ({ item, id }))
  indexed.sort((a, b) => {
    for (const key of keys) {
      const av = read(a.item, key)
      const bv = read(b.item, key)
      if (av !== bv) return key === 'z' ? bv - av : av - bv
    }
    return a.id - b.id
  })
  return indexed.map((e) => e.item)
}

const materialsOf = (o: THREE.Object3D): THREE.Material[] => {
  const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
  return m ? (Array.isArray(m) ? m : [m]) : []
}

/** Every drawable under `root` with a translucent material, by name. */
const translucent = (root: THREE.Object3D): THREE.Mesh[] => {
  const out: THREE.Mesh[] = []
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && materialsOf(o).some((m) => m.transparent)) {
      out.push(o as THREE.Mesh)
    }
  })
  return out
}

describe('DEV-422 §1 — what three sorts a translucent object by', () => {
  it('compares renderOrder BEFORE depth, so an order wins whatever the depths', () => {
    const keys = transparentSortKeys()
    expect(keys).toContain('renderOrder')
    expect(keys).toContain('z')
    expect(keys.indexOf('renderOrder')).toBeLessThan(keys.indexOf('z'))
  })

  it('sorts an InstancedMesh at ONE point: its own bounding sphere', () => {
    // `projectObject` reads `object.boundingSphere` when the OBJECT has one —
    // which `InstancedMesh` does and a plain `Mesh` does not — and the
    // geometry's otherwise. So every instance of a gate shares one sort point.
    expect(three()).toMatch(
      /if \( object\.boundingSphere !== undefined \) \{[\s\S]{0,160}object\.boundingSphere\.center/,
    )
    const box = new THREE.BoxGeometry(1, 1, 1)
    const material = new THREE.MeshBasicMaterial()
    expect(new THREE.InstancedMesh(box, material, 1).boundingSphere).toBeNull()
    expect((new THREE.Mesh(box, material) as { boundingSphere?: unknown }).boundingSphere).toBe(
      undefined,
    )
  })
})

describe('DEV-422 §2 — the shipped gates on int_01', () => {
  it('finds the three translucent gate parts: ring frames, finish frame, turn arrows', async () => {
    const rings = await loadRings(LEVEL)
    const turns = await loadTurnIndicators(LEVEL)
    const names = [...translucent(rings.object), ...translucent(turns.object)].map((m) => m.name)
    expect(names.sort()).toEqual(['finish-gate', 'rings', 'turn-indicator-arrows'])
    // And the frames really are ONE instanced object whose single sort point is
    // far from the gates at its ends — the reason no depth order can be
    // trusted for it. Measured, not assumed: the farthest gate from the sort
    // point on int_01.
    const frames = rings.object.getObjectByProperty('isInstancedMesh', true) as THREE.InstancedMesh
    expect(frames.name).toBe('rings')
    frames.computeBoundingSphere()
    const centre = (frames.boundingSphere as THREE.Sphere).center
    const far = Math.max(...rings.triggers.map((t) => t.centre.distanceTo(centre)))
    console.info(
      `DEV-422: int_01's ${rings.count} frames sort at one point, ${far.toFixed(0)} m from the farthest`,
    )
    expect(far).toBeGreaterThan(1000)
    rings.dispose()
    turns.dispose()
  })

  it('every translucent gate part WRITES DEPTH', async () => {
    // So a translucent thing drawn after it is hidden where a bar is in front
    // of it, and passes where it is in front of the bar — instead of whichever
    // drew second painting over the other.
    const rings = await loadRings(LEVEL)
    const turns = await loadTurnIndicators(LEVEL)
    for (const mesh of [...translucent(rings.object), ...translucent(turns.object)]) {
      for (const m of materialsOf(mesh)) {
        expect(m.depthWrite, `${mesh.name} writes depth`).toBe(true)
        // Still translucent: this is the draw order, not the look.
        expect(m.transparent, `${mesh.name} stays translucent`).toBe(true)
      }
    }
    rings.dispose()
    turns.dispose()
  })

  it('every translucent gate part draws BEFORE a default-ordered translucent thing, near or far', async () => {
    // The adversarial pair is the one the e2e photographs: the other thing
    // NEARER than the gate's sort point and then FARTHER. By depth alone the
    // two cases draw in opposite orders; the gate has to be first in both,
    // because a racer hologram, a ghost, a wing trail or a burst particle is
    // correct over a gate it is in front of only if the gate is already there.
    const rings = await loadRings(LEVEL)
    const turns = await loadTurnIndicators(LEVEL)
    const other = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ transparent: true, depthWrite: false }),
    )
    expect(other.renderOrder, 'three’s default order').toBe(0)
    for (const gate of [...translucent(rings.object), ...translucent(turns.object)]) {
      for (const [gz, oz] of [
        [900, 300],
        [300, 900],
      ] as const) {
        const first = transparentSort([
          { object: other, z: oz },
          { object: gate, z: gz },
        ])[0]
        expect(
          first?.object,
          `${gate.name} first with it at ${gz} m and the other at ${oz} m`,
        ).toBe(gate)
      }
      expect(gate.renderOrder).toBe(GATE_FRAME_ORDER)
    }
    rings.dispose()
    turns.dispose()
  })
})
