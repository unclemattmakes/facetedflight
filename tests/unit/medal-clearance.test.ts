// tests/unit/medal-clearance.test.ts — a table's medal floats ABOVE its island
// on every shipped course (DEV-140).
//
// Matt, 2026-09-16: *"level select medals should float above the terrain."*
// DEV-113 put the emblem at 2016's fixed height, and 2016's miniature never
// reached it; the port's does. The rule is `medalRestY`; the assertion here does
// NOT re-derive it (trap 24) — it measures the medal's box against the island's
// own vertices, read straight off the diorama geometry, and asks only that
// the one is above the other by the clearance, on all thirteen tables and at
// every bearing a page can put a table on.
//
// Two halves: the rule on a synthetic field (no assets), and the thirteen real
// tables (height maps + the logo glTF, gitignored, loud skips).

import fs from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { describe, expect, it } from 'vitest'
import { createDiorama } from '@/render/diorama'
import {
  DIORAMA_LIFT,
  MEDAL_CLEARANCE,
  MODEL_SIZE,
  medalLocal,
  medalRestY,
  TABLE_RIM_RADIUS,
  tableBearings,
} from '@/render/hangar'
import { createMedal, medalPlacement } from '@/render/medal'
import { buildHeightField } from '@/sim/terrain/height-field'
import type { MapSampler } from '@/sim/terrain/image-sampler'
import { fieldFor, haveMaps, loadLevelJson, MISSIONS } from './helpers/terrain-field'

const GLB = 'public/assets/props/title-logo.glb'
const haveLogo = fs.existsSync(GLB)

const parse = async (): Promise<THREE.Object3D> => {
  const bytes = fs.readFileSync(GLB)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  return await new Promise((resolve, reject) => {
    new GLTFLoader().parse(buffer as ArrayBuffer, '', (gltf) => resolve(gltf.scene), reject)
  })
}

/** The highest island vertex within `radius` of `(x, z)` in TABLE space, read off the mesh. */
const islandTopUnder = (diorama: THREE.Object3D, x: number, z: number, radius: number): number => {
  let top = -Infinity
  diorama.updateWorldMatrix(true, true)
  diorama.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh || mesh.name !== 'diorama-island') return
    const p = mesh.geometry.attributes.position as THREE.BufferAttribute
    const w = new THREE.Vector3()
    for (let i = 0; i < p.count; i++) {
      w.set(p.getX(i), p.getY(i), p.getZ(i)).applyMatrix4(mesh.matrixWorld)
      if (Math.hypot(w.x - x, w.z - z) <= radius && w.y > top) top = w.y
    }
  })
  return top
}

describe('medalRestY — the rule', () => {
  it('keeps 2016’s height when nothing is under the medal', () => {
    expect(medalRestY(0.55, 0.5, -Infinity, -0.03)).toBe(0.55)
    expect(medalRestY(0.55, 0.5, Number.NaN, -0.03)).toBe(0.55)
  })
  it('keeps 2016’s height when the island is low enough', () => {
    // Peak 0.01 over a lift of 0.5, emblem hanging 0.03 below its origin at
    // 0.55: the emblem's floor is at 0.52, the peak at 0.51 + clearance.
    expect(medalRestY(0.55, 0.5, 0.01 - MEDAL_CLEARANCE, -0.03)).toBe(0.55)
  })
  it('lifts, and never lowers', () => {
    const y = medalRestY(0.55, 0.5, 0.15, -0.03)
    expect(y).toBeCloseTo(0.5 + 0.15 + MEDAL_CLEARANCE + 0.03, 9)
    expect(y).toBeGreaterThan(0.55)
  })
})

describe('peakUnder — the diorama knows its own heights', () => {
  it('reports the clamped mesh, waterline and all, inside a footprint', () => {
    // A synthetic field: a single cone in the middle of a 4 km map, sea at 0.
    const sampler: MapSampler = {
      width: 64,
      height: 64,
      sample(u, v, out) {
        const d = Math.hypot(u - 0.5, v - 0.5)
        const h = Math.max(0, 1 - d * 6)
        out.r = h
        out.g = h
        out.b = h
      },
    }
    const field = buildHeightField(
      sampler,
      {
        terrainSize: 4096,
        terrainHeight: 900,
        chunkSize: 256,
        baseResolution: 16,
        randomOffset: 0,
        seed: 1,
      },
      { position: [0, 0, 0], scale: [1, 1, 1] },
    )
    const d = createDiorama({ field, route: null, size: MODEL_SIZE })
    const centre = d.peakUnder(0, 0, 0.02)
    const edge = d.peakUnder(0.15, 0.15, 0.02)
    expect(centre).toBeGreaterThan(0.05)
    // Sea, clamped to the waterline: exactly zero, not a depth.
    expect(edge).toBe(0)
    expect(d.peakUnder(5, 5, 0.01)).toBe(-Infinity)
    d.dispose()
  })
})

describe.skipIf(!(haveMaps && haveLogo))('every shipped table, at every bearing', () => {
  it('floats its medal clear of the island by the clearance', async () => {
    const logo = await parse()
    const placement = medalPlacement(TABLE_RIM_RADIUS)
    const bearings = [
      ...tableBearings(1),
      ...tableBearings(2),
      ...tableBearings(3),
      ...tableBearings(4),
    ]
    const lifted: string[] = []
    for (const id of MISSIONS) {
      const level = loadLevelJson(id)
      const field = fieldFor(level)
      const diorama = createDiorama({ field, route: null, size: MODEL_SIZE })
      for (const bearing of bearings) {
        const table = new THREE.Group()
        diorama.object.position.set(0, DIORAMA_LIFT, 0)
        table.add(diorama.object)
        const medal = createMedal(logo, 'gold', TABLE_RIM_RADIUS, 0)
        const at = medalLocal(bearing, placement)
        const peak = diorama.peakUnder(at.x, at.z, medal.reach + MEDAL_CLEARANCE)
        const y = medalRestY(at.y, DIORAMA_LIFT, peak, medal.bottom)
        medal.object.position.set(at.x, y, at.z)
        table.add(medal.object)
        table.updateWorldMatrix(true, true)

        // ── measured, not derived ──────────────────────────────────────────
        const box = new THREE.Box3().setFromObject(medal.object)
        const reach = Math.hypot(
          Math.max(Math.abs(box.min.x - at.x), Math.abs(box.max.x - at.x)),
          Math.max(Math.abs(box.min.z - at.z), Math.abs(box.max.z - at.z)),
        )
        const ground = islandTopUnder(diorama.object, at.x, at.z, reach + MEDAL_CLEARANCE)
        expect(
          box.min.y - ground,
          `${id} at bearing ${((bearing * 180) / Math.PI).toFixed(1)}: emblem floor ${box.min.y.toFixed(3)} over island top ${ground.toFixed(3)}`,
        ).toBeGreaterThanOrEqual(MEDAL_CLEARANCE * 0.999)
        // And never lowered below 2016's height.
        expect(y).toBeGreaterThanOrEqual(at.y)
        if (y > at.y + 1e-6)
          lifted.push(`${id}@${((bearing * 180) / Math.PI).toFixed(0)}:+${(y - at.y).toFixed(3)}`)
        medal.dispose()
        table.remove(diorama.object)
      }
      diorama.dispose()
    }
    // For the row: which tables needed lifting, and by how much.
    console.info(
      `medal-clearance: ${lifted.length} of ${MISSIONS.length * bearings.length} placements lifted — ${lifted.join(' ')}`,
    )
  }, 120_000)
})

describe.skipIf(haveMaps && haveLogo)('height maps or the logo are not on disk', () => {
  it('so the thirteen-table sweep above was SKIPPED, not passed', () => {
    expect(haveMaps && haveLogo).toBe(false)
  })
})
