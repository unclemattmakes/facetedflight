// tests/unit/cloud-instancing.test.ts: DEV-785, what `loadClouds` builds from the plan.
//
// `cloud-pool.test.ts` holds the plan and `cloud-look.test.ts` holds that every
// placement's instance matrix is the old mesh matrix. This file holds the rest of
// what instancing can quietly change: that a placement which owns its pool member
// keeps the blob it always had, that the sky is one draw per member on one
// material, that the tint is on the instance and exact for an owner, that the
// hulls the whiteout and the shadow read are still one per placement, and that
// dispose frees what the pool allocated.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { CLOUD_SEED_BASE, loadClouds } from '@/game/clouds'
import { cloudShape, generateCloud } from '@/sim/clouds'
import int01 from '../../content/levels/int_01_hoverJet.json'
import int02 from '../../content/levels/int_02_hoverJet.json'

type Placements = Parameters<typeof loadClouds>[0]
const INT01 = int01.clouds as unknown as Placements
const INT02 = int02.clouds as unknown as Placements
const POOL = { poolSize: 12, tintSpread: 0.08 } as const

const colourOf = (mesh: THREE.InstancedMesh, slot: number): [number, number, number] => {
  const c = mesh.instanceColor as THREE.InstancedBufferAttribute
  return [c.getX(slot), c.getY(slot), c.getZ(slot)]
}

describe('the pool is one draw per member, on one material', () => {
  it('draws int_01 in twelve InstancedMeshes instead of nineteen meshes', () => {
    const clouds = loadClouds(INT01, { pool: POOL })
    expect(clouds.group.children.length).toBe(12)
    expect(clouds.pool.length).toBe(12)
    for (const child of clouds.group.children) {
      expect((child as THREE.InstancedMesh).isInstancedMesh).toBe(true)
    }
    const instances = clouds.pool.reduce((n, d) => n + d.mesh.count, 0)
    expect(instances).toBe(INT01.length)
    expect(clouds.count).toBe(INT01.length)
    clouds.dispose()
  })

  it('shares ONE material, so the sky is one program however many members', () => {
    const clouds = loadClouds(INT01, { pool: POOL })
    const materials = new Set(clouds.pool.map((d) => d.mesh.material))
    expect(materials.size).toBe(1)
    // Every member carries an instance colour, or three would key a second variant
    // of every patch on the material (USE_INSTANCING_COLOR is in the cache key).
    for (const d of clouds.pool) expect(d.mesh.instanceColor).not.toBeNull()
    clouds.dispose()
  })

  it('with no edition and no pool it is one blob per cloud, as before the pool', () => {
    const clouds = loadClouds(INT01)
    expect(clouds.pool.length).toBe(INT01.length)
    for (const d of clouds.pool) expect(d.mesh.count).toBe(1)
    clouds.dispose()
  })

  it('a small sky shares nothing even with the shipped pool size', () => {
    const clouds = loadClouds(INT02, { pool: POOL })
    expect(clouds.pool.length).toBe(INT02.length)
    clouds.dispose()
  })

  it('is the same sky on every load', () => {
    const a = loadClouds(INT01, { pool: POOL })
    const b = loadClouds(INT01, { pool: POOL })
    expect(a.hulls.map((h) => Array.from(h.positions.slice(0, 30)))).toEqual(
      b.hulls.map((h) => Array.from(h.positions.slice(0, 30))),
    )
    for (const [i, d] of a.pool.entries()) {
      expect(Array.from(d.mesh.instanceMatrix.array)).toEqual(
        Array.from((b.pool[i] as (typeof b.pool)[number]).mesh.instanceMatrix.array),
      )
      expect(Array.from((d.mesh.instanceColor as THREE.InstancedBufferAttribute).array)).toEqual(
        Array.from(
          (
            (b.pool[i] as (typeof b.pool)[number]).mesh
              .instanceColor as THREE.InstancedBufferAttribute
          ).array,
        ),
      )
    }
    a.dispose()
    b.dispose()
  })
})

describe('a placement that owns its member keeps the blob it always had', () => {
  it('draws exactly the old per-placement geometry for every owner, and shares the rest', () => {
    const clouds = loadClouds(INT01, { pool: POOL })
    let owners = 0
    for (const d of clouds.pool) {
      const owner = d.users[0] as number
      const placement = INT01[owner] as Placements[number]
      const old = generateCloud(cloudShape(placement.shape), CLOUD_SEED_BASE + placement.i)
      expect(Array.from(d.mesh.geometry.getAttribute('position').array)).toEqual(
        Array.from(old.positions),
      )
      expect(Array.from(d.mesh.geometry.getAttribute('normal').array)).toEqual(
        Array.from(old.normals),
      )
      owners++
    }
    expect(owners).toBe(12)
    // The seven that share (19 placements, 12 members) read their member's blob.
    expect(INT01.length - owners).toBe(7)
    clouds.dispose()
  })

  it('serves the whiteout and the shadow one hull per placement, in placement order', () => {
    const clouds = loadClouds(INT01, { pool: POOL })
    expect(clouds.hulls.length).toBe(INT01.length)
    clouds.hulls.forEach((h, i) => {
      expect(h.placement).toBe(INT01[i])
      const draw = clouds.pool.find((d) => d.users.includes(i)) as (typeof clouds.pool)[number]
      // The very array the member's geometry holds: nothing is copied.
      expect(h.positions).toBe(draw.mesh.geometry.getAttribute('position').array)
    })
    clouds.dispose()
  })
})

describe('the tint rides the instance', () => {
  it('is exactly white for an owner and a small, different value for a sharer', () => {
    const clouds = loadClouds(INT01, { pool: POOL })
    let sharers = 0
    const seen = new Set<number>()
    for (const d of clouds.pool) {
      d.users.forEach((_, slot) => {
        const [r, g, b] = colourOf(d.mesh, slot)
        expect(g).toBe(r)
        expect(b).toBe(r)
        if (slot === 0) {
          expect(r).toBe(1)
          return
        }
        sharers++
        expect(r).not.toBe(1)
        expect(Math.abs(r - 1)).toBeLessThanOrEqual(POOL.tintSpread + 1e-6)
        seen.add(r)
      })
    }
    expect(sharers).toBe(INT01.length - 12)
    expect(seen.size).toBe(sharers)
    clouds.dispose()
  })

  it('is no tint at all at a spread of 0', () => {
    const clouds = loadClouds(INT01, { pool: { poolSize: 12, tintSpread: 0 } })
    for (const d of clouds.pool) {
      for (let slot = 0; slot < d.users.length; slot++) {
        expect(colourOf(d.mesh, slot)).toEqual([1, 1, 1])
      }
    }
    clouds.dispose()
  })
})

describe('each member culls itself per pass, cloud by cloud', () => {
  // Three culls an InstancedMesh by one sphere around all its instances, so a
  // member two far-apart clouds share would be drawn whenever either is in view
  // (measured: nine calls where the old meshes drew six or seven). The member
  // tests its own clouds and sets its draw count to 0 on a pass that sees none of its clouds.
  const passWith = (
    clouds: ReturnType<typeof loadClouds>,
    camera: THREE.Camera,
  ): { drawn: number[]; counts: number[] } => {
    const counts: number[] = []
    for (const d of clouds.pool) {
      ;(d.mesh.onBeforeRender as unknown as (r: unknown, s: unknown, c: THREE.Camera) => void)(
        null,
        null,
        camera,
      )
      counts.push(d.mesh.count)
    }
    return { drawn: counts.flatMap((n, i) => (n > 0 ? [i] : [])), counts }
  }
  const lookAt = (eye: THREE.Vector3, target: THREE.Vector3): THREE.PerspectiveCamera => {
    const camera = new THREE.PerspectiveCamera(70, 16 / 9, 1, 20000)
    camera.position.copy(eye)
    camera.lookAt(target)
    camera.updateMatrixWorld(true)
    return camera
  }

  it("keeps three's own union cull ON as the first reject, so an unseen sky stays out of the list", () => {
    // With it off the members are in the render list every frame and the material
    // compiles in the first frames of a world, before the point-light scope has
    // patched it: one wasted program (adv_01_jumpSeat read 97 against 96).
    const clouds = loadClouds(INT01, { pool: POOL })
    for (const d of clouds.pool) {
      expect(d.mesh.frustumCulled).toBe(true)
      expect((d.mesh.boundingSphere as THREE.Sphere).radius).toBeGreaterThan(0)
    }
    clouds.dispose()
  })

  it('draws exactly the members that hold a cloud in the camera frustum', () => {
    const clouds = loadClouds(INT01, { pool: POOL })
    const eye = new THREE.Vector3(0, 600, 0)
    for (const target of [
      new THREE.Vector3(1315, 1038, -278),
      new THREE.Vector3(-1045, 1306, -305),
      new THREE.Vector3(449, 1163, 1898),
      new THREE.Vector3(300, 1100, -1700),
    ]) {
      const camera = lookAt(eye, target)
      // The oracle: the old meshes' own test, three's Frustum against each
      // placement's sphere built independently from the authored fields.
      const frustum = new THREE.Frustum().setFromProjectionMatrix(
        new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
      )
      const matrix = new THREE.Matrix4()
      const seen = new Set<number>()
      clouds.pool.forEach((d, m) => {
        for (const i of d.users) {
          clouds.matrixOf(i, matrix)
          const blob = d.mesh.geometry.boundingSphere as THREE.Sphere
          const sphere = new THREE.Sphere(blob.center.clone(), blob.radius).applyMatrix4(matrix)
          if (frustum.intersectsSphere(sphere)) seen.add(m)
        }
      })
      const { drawn } = passWith(clouds, camera)
      // Everything the oracle sees is drawn (never a visible cloud missing)...
      for (const m of seen) expect(drawn, `member ${m} holds a visible cloud`).toContain(m)
      // ...and the pass is no wider than the visible clouds could make it.
      expect(drawn.length).toBeLessThanOrEqual(INT01.length)
      expect(drawn.length).toBeLessThan(clouds.pool.length)
      expect(drawn.length).toBeGreaterThan(0)
    }
    clouds.dispose()
  })

  it('draws nothing from a camera that is looking at no cloud', () => {
    const clouds = loadClouds(INT01, { pool: POOL })
    const camera = lookAt(new THREE.Vector3(0, 200, 0), new THREE.Vector3(0, -5000, 1))
    expect(passWith(clouds, camera).drawn).toEqual([])
    clouds.dispose()
  })

  it('puts the full count back when the wind moves the clouds, so the sort sphere is whole', () => {
    const clouds = loadClouds(INT01, { pool: POOL })
    const camera = lookAt(new THREE.Vector3(0, 200, 0), new THREE.Vector3(0, -5000, 1))
    passWith(clouds, camera)
    expect(clouds.pool.every((d) => d.mesh.count === 0)).toBe(true)
    clouds.setCloudLook({
      enabled: true,
      wrap: 0,
      rimStrength: 0,
      rimPower: 1,
      sunTint: 0,
      emissive: 0.22,
      scaleMultiplier: 1,
      altitudeLift: 0,
      driftSpeed: 3,
      driftDirection: [1, 0, 0],
      singleSided: false,
    })
    clouds.update(0)
    clouds.update(10)
    for (const d of clouds.pool) {
      expect(d.mesh.count).toBe(d.users.length)
      expect((d.mesh.boundingSphere as THREE.Sphere).radius).toBeGreaterThan(0)
    }
    clouds.dispose()
  })

  it('draws an array camera in full, rather than guess at its sub-cameras', () => {
    const clouds = loadClouds(INT01, { pool: POOL })
    const camera = new THREE.ArrayCamera([lookAt(new THREE.Vector3(), new THREE.Vector3(0, -1, 0))])
    expect(passWith(clouds, camera).counts).toEqual(clouds.pool.map((d) => d.users.length))
    clouds.dispose()
  })
})

describe('dispose frees what the pool allocated', () => {
  it('disposes every member mesh and every geometry, and empties the group', () => {
    const clouds = loadClouds(INT01, { pool: POOL })
    let meshes = 0
    let geometries = 0
    for (const d of clouds.pool) {
      d.mesh.addEventListener('dispose', () => meshes++)
      d.mesh.geometry.addEventListener('dispose', () => geometries++)
    }
    clouds.dispose()
    expect(meshes).toBe(12)
    expect(geometries).toBe(12)
    expect(clouds.group.children.length).toBe(0)
  })
})
