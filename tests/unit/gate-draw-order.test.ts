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
import { drawAsGateFrame, GATE_FRAME_ORDER, loadRings, ringFrameMaterial } from '@/game/rings'
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

describe('DEV-422 §2, superseded by DEV-922: the shipped gates on int_01', () => {
  // Matt, 2026-10-12, of four photographs: "front only + opaque wins it for
  // me". DEV-422's problem was the TRANSPARENT list (one sort point for a whole
  // course of frames, and neither side writing depth). An opaque gate is not in
  // that list: three draws every opaque before any transparent thing and the
  // depth test orders the rest, which is what §1's sort could only approximate.
  const GATE_PARTS = ['finish-gate', 'rings', 'turn-indicator-arrows']
  const gateParts = (...roots: THREE.Object3D[]): THREE.Mesh[] => {
    const out: THREE.Mesh[] = []
    for (const root of roots)
      root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh && GATE_PARTS.includes(o.name)) out.push(o as THREE.Mesh)
      })
    return out
  }

  it('finds the three gate parts, and none of them is translucent any more', async () => {
    const rings = await loadRings(LEVEL)
    const turns = await loadTurnIndicators(LEVEL)
    const parts = gateParts(rings.object, turns.object)
    expect(parts.map((m) => m.name).sort()).toEqual(GATE_PARTS)
    // The loud counterpart: the old finder still runs and now finds nothing.
    expect(
      [...translucent(rings.object), ...translucent(turns.object)].map((m) => m.name),
    ).not.toEqual(expect.arrayContaining(GATE_PARTS))
    for (const mesh of parts) {
      for (const m of materialsOf(mesh)) {
        expect(m.transparent, `${mesh.name} is opaque`).toBe(false)
        expect(m.opacity, `${mesh.name} at full opacity`).toBe(1)
        expect(m.side, `${mesh.name} front faces only`).toBe(THREE.FrontSide)
        expect(m.depthWrite, `${mesh.name} writes depth`).toBe(true)
      }
      expect(mesh.renderOrder, `${mesh.name} keeps the gates' order`).toBe(GATE_FRAME_ORDER)
    }
    rings.dispose()
    turns.dispose()
  })

  it('leaves the shared factory as it was, for the hangar bands and the mode marks', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), ringFrameMaterial())
    const before = mesh.material as THREE.Material
    expect([before.side, before.transparent]).toEqual([THREE.DoubleSide, true])
    drawAsGateFrame(mesh)
    expect(before.side).toBe(THREE.FrontSide)
    expect(before.transparent).toBe(false)
    const fresh = ringFrameMaterial()
    expect([fresh.side, fresh.transparent]).toEqual([THREE.DoubleSide, true])
  })
})
