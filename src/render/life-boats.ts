// src/render/life-boats.ts — the moored boats, drawn, riding the sea. DEV-447.
//
// `sim/life/boats.ts` decides where; `sim/life/sea-facet.ts` finds the drawn
// sea triangle under each hull point; this turns both into one `InstancedMesh`
// per kind and moves the instances every frame with the wave.
//
// ── What a boat floats on ─────────────────────────────────────────────────
//
// Each boat carries four hull points — bow, stern, port, starboard, a hull's
// half-length and half-beam out from its centre. Each point knows the drawn
// triangle it is over (three corners, WORLD space, at the plate's rest height)
// and its barycentric weights in it. A frame is then:
//
//     corner height = rest y + waterDisplacement(corner) + the plate's bob
//     point height  = the weighted sum of its three corners
//
// which is what the vertex shader does to those three vertices and what the
// rasteriser does between them — `WAVE_GLSL` displaces each vertex by the
// function this file calls (`render/water.ts`'s `waterDisplacement`, the oracle
// the shader is tested against), evaluated at the vertex's world (x, -z), and
// the plate's `group.position.y` carries `bobAt`. The boat stands at the mean
// of its four points and its up is the normal of the plane they span, so it
// heaves, pitches and rolls with the facets it straddles.
//
// ── The one thing that is not bit for bit ─────────────────────────────────
//
// The shader's noise is `fract(sin(x * 12.9898 + z * 142.17))` on world
// coordinates in the thousands: an argument near 10^6, which a GPU's float32
// holds to about 0.06 rad and this file's float64 holds exactly. So the GPU's
// per-vertex noise and this file's can differ by that much, and the height by
// a few tenths of a metre (the noise enters the amplitude and the phase; each
// moves the height at most ~4 m per unit of noise). The static half — the
// jitter, the diagonal, the 8x split — is exact, because it is JavaScript on
// both sides. `draft` is sized with that in mind.
//
// ── What it costs ─────────────────────────────────────────────────────────
//
// One draw call per kind, and the kinds are data (`life.boats.kinds`). The
// material is the scatter props' recipe exactly — standard, vertex colour,
// flat, rough, the same atmosphere patch applied by the caller — so it asks
// the renderer for the program the palms already compiled rather than a new
// one. No `onBeforeCompile` of this file's own, so nothing new to tag.

import * as THREE from 'three'
import { type WaterDisplace, waterDisplacement } from '@/render/water'

/** One hull point: the drawn sea triangle under it and where it sits in it. */
export interface HullSample {
  /** a.xyz, b.xyz, c.xyz — THREE world, the plate at rest (no bob). */
  readonly corners: Float64Array
  /** Barycentric weights of the point in `corners`, plan. */
  readonly weights: readonly [number, number, number]
}

/** One boat, placed. THREE world. */
export interface BoatPose {
  readonly kind: number
  readonly x: number
  readonly z: number
  /** Heading of the hull's LONG axis, radians about +y, THREE world. */
  readonly yaw: number
  readonly scale: number
  /** Metres bow to stern and port to starboard between the hull samples. */
  readonly span: readonly [number, number]
  /** Bow, stern, port, starboard. */
  readonly hull: readonly [HullSample, HullSample, HullSample, HullSample]
}

export interface BoatKindMesh {
  readonly id: string
  readonly geometry: THREE.BufferGeometry
  /** Keel under the water, MESH metres (before scale). */
  readonly draft: number
  /**
   * The rotation that puts the mesh's LONG axis on +x — identity when it
   * already is, a quarter turn when the mesh was modelled along z. Measured
   * off the geometry by the caller, never assumed.
   */
  readonly align: THREE.Quaternion
}

export interface BoatFleet {
  readonly group: THREE.Group
  readonly meshes: readonly THREE.InstancedMesh[]
  /** Per mesh, the boat (index into the poses) each instance slot draws. */
  readonly slots: readonly (readonly number[])[]
  /** The boats as placed, in the order `slots` indexes them. */
  readonly poses: readonly BoatPose[]
  readonly count: number
  readonly triangles: number
  /**
   * One frame. `seconds` is the clock the sea's `setTime` was given this
   * frame; `bob` is how far the plate stands above its rest height now.
   */
  update(seconds: number, bob: number): void
  /** Where boat `i` floats now: its centre's surface height, THREE world y. */
  surfaceAt(i: number): number
  dispose(): void
}

/** Scratch. Valid only inside one synchronous call — never stored (trap 19). */
const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _scale = new THREE.Vector3()
const _matrix = new THREE.Matrix4()
const _basis = new THREE.Matrix4()
const _up = new THREE.Vector3()
const _fwd = new THREE.Vector3()
const _side = new THREE.Vector3()
const _long = new THREE.Vector3()
const _beam = new THREE.Vector3()

/** The height of one hull point this frame, THREE world y. */
export const hullHeight = (
  h: HullSample,
  d: WaterDisplace,
  seconds: number,
  bob: number,
): number => {
  let y = 0
  for (let k = 0; k < 3; k++) {
    const cx = h.corners[k * 3] as number
    const cy = h.corners[k * 3 + 1] as number
    const cz = h.corners[k * 3 + 2] as number
    // THREE -> UNITY for the wave: the shader's `uz = -wp.z` (water.ts).
    y += (h.weights[k] as number) * (cy + waterDisplacement(d, cx, -cz, seconds))
  }
  return y + bob
}

/**
 * The boat's rotation for four hull heights: its long axis tilted to the bow
 * and stern heights, its up the normal of the plane both diagonals span.
 * Into `out`. Exported so the geometry can be tested without a mesh: the long
 * axis is the one `yaw` points (`(cos, 0, -sin)` about +y), a flat sea leaves
 * it level, and the basis is a ROTATION — `makeBasis` of a left-handed triple
 * would mirror the hull, which is the class DEV-044 is about.
 */
export const hullRotation = (
  yaw: number,
  span: readonly [number, number],
  bow: number,
  stern: number,
  port: number,
  starboard: number,
  out: THREE.Quaternion,
): THREE.Quaternion => {
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  _long.set(c * span[0], bow - stern, -s * span[0])
  _beam.set(s * span[1], port - starboard, c * span[1])
  // beam x long is UP on a flat sea: (s,0,c) x (c,0,-s) = (0, 1, 0).
  _up.crossVectors(_beam, _long).normalize()
  _fwd.copy(_long).normalize()
  // x cross y = z, so the three columns are a right-handed rotation.
  _side.crossVectors(_fwd, _up)
  _basis.makeBasis(_fwd, _up, _side)
  return out.setFromRotationMatrix(_basis)
}

export const createBoatFleet = (
  kinds: readonly BoatKindMesh[],
  boats: readonly BoatPose[],
  displace: WaterDisplace,
  applyFog?: (material: THREE.Material) => void,
): BoatFleet => {
  const group = new THREE.Group()
  group.name = 'life:boats'
  const meshes: THREE.InstancedMesh[] = []
  const slots: number[][] = []
  const materials: THREE.Material[] = []
  let triangles = 0

  for (const [k, kind] of kinds.entries()) {
    const list: number[] = []
    for (const [i, b] of boats.entries()) if (b.kind === k) list.push(i)
    if (list.length === 0) continue
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      color: 0xffffff,
      roughness: 1,
      metalness: 0,
      flatShading: true,
    })
    applyFog?.(material)
    materials.push(material)
    const mesh = new THREE.InstancedMesh(kind.geometry, material, list.length)
    mesh.name = `life:boats:${kind.id}`
    mesh.castShadow = false
    mesh.receiveShadow = false
    meshes.push(mesh)
    slots.push(list)
    group.add(mesh)
    const tris = kind.geometry.index
      ? kind.geometry.index.count / 3
      : (kind.geometry.getAttribute('position')?.count ?? 0) / 3
    triangles += tris * list.length
  }

  const surface = new Float64Array(boats.length)
  let bounded = false

  const update = (seconds: number, bob: number): void => {
    for (const [m, mesh] of meshes.entries()) {
      const list = slots[m] as number[]
      for (let slot = 0; slot < list.length; slot++) {
        const i = list[slot] as number
        const b = boats[i] as BoatPose
        const kind = kinds[b.kind] as BoatKindMesh
        const yb = hullHeight(b.hull[0], displace, seconds, bob)
        const ys = hullHeight(b.hull[1], displace, seconds, bob)
        const yp = hullHeight(b.hull[2], displace, seconds, bob)
        const yr = hullHeight(b.hull[3], displace, seconds, bob)
        const y = (yb + ys + yp + yr) / 4
        surface[i] = y
        hullRotation(b.yaw, b.span, yb, ys, yp, yr, _quat).multiply(kind.align)
        _pos.set(b.x, y - kind.draft * b.scale, b.z)
        _scale.set(b.scale, b.scale, b.scale)
        _matrix.compose(_pos, _quat, _scale)
        mesh.setMatrixAt(slot, _matrix)
      }
      mesh.instanceMatrix.needsUpdate = true
      if (!bounded) {
        mesh.computeBoundingSphere()
        // Once, from the first pose, then padded by the whole heave — the
        // plate's bob and the chop are each up to `amplitude` — so a boat on
        // the top of a wave is never culled for being out of its sphere.
        const sphere = mesh.boundingSphere
        if (sphere) sphere.radius += 4 * Math.abs(displace.amplitude)
      }
    }
    bounded = true
  }

  return {
    group,
    meshes,
    slots,
    poses: boats,
    count: boats.length,
    triangles,
    update,
    surfaceAt: (i) => surface[i] as number,
    dispose() {
      for (const m of materials) m.dispose()
      for (const mesh of meshes) mesh.dispose()
    },
  }
}
