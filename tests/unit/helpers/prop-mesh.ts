// tests/unit/helpers/prop-mesh.ts — the ROCK, not the box round it. DEV-213.
//
// `prop-forest.ts` builds the colliders the game flies against. This file is
// the thing they are a bound ON: the triangles of the mesh, transformed by the
// same instance matrix, with a signed distance query.
//
// ── Why a third measurement of the same rock ──────────────────────────────
//
// A landmark's collider is a VERTICAL CAPSULE sized off the drawn box: radius
// `width * radiusFraction`, spanning the box's bottom to its top. On a rod
// leaning 40 degrees out of vertical that box is much bigger than the rock, and
// the capsule inside it claims a volume the rock does not occupy — DEV-187 §4
// measured 31-68 % of a spire's own vertices inside its own capsule, which
// means the rest of the capsule is air.
//
// So "the authored line is 70 m inside a capsule" and "the authored line flies
// through 70 m of rock" are different claims, and only the second one is a
// gameplay problem. DEV-187 (b') already had to separate them once — a 336 m
// reading on `adv_01_hoverJet` turned out to be 0 of 64 bearings covered, no
// vertex within 25 m — and it did it with a bearing sweep, which answers *is
// this inside the horizontal footprint* and not *is this inside the rock*.
//
// This answers the second one exactly: **ray-parity inside/outside plus the
// distance to the nearest triangle**. Both are computed on the triangles the
// renderer draws, through the matrix the renderer draws them with, and neither
// consults `PropColliders` — so a disagreement between this and the capsule is
// a fact about the capsule.
//
// NOT a `.test.ts`, so vitest does not collect it. Reads under `public/`, so
// every caller is behind `haveForest`.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const PUBLIC = path.join(ROOT, 'public')

/** A mesh's triangles, world-space, flat: 9 floats a triangle. */
export interface PropMesh {
  /** Triangle count. */
  readonly count: number
  /** `count * 9` floats — ax ay az bx by bz cx cy cz, THREE world space. */
  readonly tris: Float32Array
  readonly min: THREE.Vector3
  readonly max: THREE.Vector3
}

interface GlbGeometry {
  readonly positions: Float32Array
  readonly indices: Uint32Array
}

const glbGeometry = (file: string): GlbGeometry => {
  const buf = fs.readFileSync(file)
  const jsonLength = buf.readUInt32LE(12)
  const json = JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8')) as {
    meshes?: { primitives: { attributes: { POSITION: number }; indices?: number }[] }[]
    accessors: { count: number; bufferView: number; byteOffset?: number; componentType: number }[]
    bufferViews: { byteOffset?: number; byteStride?: number }[]
  }
  const binOffset = 20 + jsonLength
  const bin = buf.subarray(binOffset + 8, binOffset + 8 + buf.readUInt32LE(binOffset))

  const positions: number[] = []
  const indices: number[] = []
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives) {
      const base = positions.length / 3
      const pa = json.accessors[prim.attributes.POSITION] as GlbGeometry extends never
        ? never
        : { count: number; bufferView: number; byteOffset?: number }
      const pv = json.bufferViews[pa.bufferView] as { byteOffset?: number; byteStride?: number }
      const po = (pv.byteOffset ?? 0) + (pa.byteOffset ?? 0)
      const ps = pv.byteStride ?? 12
      for (let i = 0; i < pa.count; i++) {
        const o = po + i * ps
        positions.push(bin.readFloatLE(o), bin.readFloatLE(o + 4), bin.readFloatLE(o + 8))
      }
      if (prim.indices === undefined) {
        for (let i = 0; i < pa.count; i++) indices.push(base + i)
        continue
      }
      const ia = json.accessors[prim.indices] as {
        count: number
        bufferView: number
        byteOffset?: number
        componentType: number
      }
      const iv = json.bufferViews[ia.bufferView] as { byteOffset?: number; byteStride?: number }
      const io = (iv.byteOffset ?? 0) + (ia.byteOffset ?? 0)
      // 5121 UNSIGNED_BYTE, 5123 UNSIGNED_SHORT, 5125 UNSIGNED_INT.
      const width = ia.componentType === 5125 ? 4 : ia.componentType === 5123 ? 2 : 1
      const read =
        width === 4
          ? (o: number) => bin.readUInt32LE(o)
          : width === 2
            ? (o: number) => bin.readUInt16LE(o)
            : (o: number) => bin.readUInt8(o)
      for (let i = 0; i < ia.count; i++) indices.push(base + read(io + i * width))
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) }
}

const geometryCache = new Map<string, GlbGeometry>()

/**
 * One prop asset's triangles put through `m` — the same instance matrix the
 * renderer fills its `InstancedMesh` with, so these are the triangles on the
 * screen. THREE world space.
 */
export const propMeshOf = (asset: string, m: THREE.Matrix4): PropMesh => {
  let geo = geometryCache.get(asset)
  if (!geo) {
    geo = glbGeometry(path.join(PUBLIC, asset))
    geometryCache.set(asset, geo)
  }
  const n = Math.floor(geo.indices.length / 3)
  const tris = new Float32Array(n * 9)
  const c = new THREE.Vector3()
  const min = new THREE.Vector3(Infinity, Infinity, Infinity)
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity)
  // Transform each vertex once per use rather than once per reference: a
  // faceted rock is unwelded, so every index is its own vertex anyway.
  const world = new Float32Array(geo.positions.length)
  for (let i = 0; i < geo.positions.length / 3; i++) {
    c.set(
      geo.positions[i * 3] as number,
      geo.positions[i * 3 + 1] as number,
      geo.positions[i * 3 + 2] as number,
    ).applyMatrix4(m)
    world[i * 3] = c.x
    world[i * 3 + 1] = c.y
    world[i * 3 + 2] = c.z
    min.min(c)
    max.max(c)
  }
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < 3; k++) {
      const v = (geo.indices[t * 3 + k] as number) * 3
      tris[t * 9 + k * 3] = world[v] as number
      tris[t * 9 + k * 3 + 1] = world[v + 1] as number
      tris[t * 9 + k * 3 + 2] = world[v + 2] as number
    }
  }
  return { count: n, tris, min, max }
}

/** Squared distance from `p` to triangle `abc`. Ericson, Real-Time Collision Detection §5.1.5. */
const pointTriangleDistSq = (
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): number => {
  const abx = bx - ax
  const aby = by - ay
  const abz = bz - az
  const acx = cx - ax
  const acy = cy - ay
  const acz = cz - az
  const apx = px - ax
  const apy = py - ay
  const apz = pz - az
  const d1 = abx * apx + aby * apy + abz * apz
  const d2 = acx * apx + acy * apy + acz * apz
  let qx: number
  let qy: number
  let qz: number
  if (d1 <= 0 && d2 <= 0) {
    qx = ax
    qy = ay
    qz = az
  } else {
    const bpx = px - bx
    const bpy = py - by
    const bpz = pz - bz
    const d3 = abx * bpx + aby * bpy + abz * bpz
    const d4 = acx * bpx + acy * bpy + acz * bpz
    if (d3 >= 0 && d4 <= d3) {
      qx = bx
      qy = by
      qz = bz
    } else {
      const cpx = px - cx
      const cpy = py - cy
      const cpz = pz - cz
      const d5 = abx * cpx + aby * cpy + abz * cpz
      const d6 = acx * cpx + acy * cpy + acz * cpz
      if (d6 >= 0 && d5 <= d6) {
        qx = cx
        qy = cy
        qz = cz
      } else {
        const vc = d1 * d4 - d3 * d2
        if (vc <= 0 && d1 >= 0 && d3 <= 0) {
          const v = d1 / (d1 - d3)
          qx = ax + abx * v
          qy = ay + aby * v
          qz = az + abz * v
        } else {
          const vb = d5 * d2 - d1 * d6
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const w = d2 / (d2 - d6)
            qx = ax + acx * w
            qy = ay + acy * w
            qz = az + acz * w
          } else {
            const va = d3 * d6 - d5 * d4
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const w = (d4 - d3) / (d4 - d3 + (d5 - d6))
              qx = bx + (cx - bx) * w
              qy = by + (cy - by) * w
              qz = bz + (cz - bz) * w
            } else {
              const denom = 1 / (va + vb + vc)
              const v = vb * denom
              const w = vc * denom
              qx = ax + abx * v + acx * w
              qy = ay + aby * v + acy * w
              qz = az + abz * v + acz * w
            }
          }
        }
      }
    }
  }
  const dx = px - qx
  const dy = py - qy
  const dz = pz - qz
  return dx * dx + dy * dy + dz * dz
}

/** Distance from `p` to the nearest triangle of `mesh`, metres. */
export const distanceToMesh = (mesh: PropMesh, px: number, py: number, pz: number): number => {
  let best = Number.POSITIVE_INFINITY
  const t = mesh.tris
  for (let i = 0; i < mesh.count; i++) {
    const o = i * 9
    const d = pointTriangleDistSq(
      px,
      py,
      pz,
      t[o] as number,
      t[o + 1] as number,
      t[o + 2] as number,
      t[o + 3] as number,
      t[o + 4] as number,
      t[o + 5] as number,
      t[o + 6] as number,
      t[o + 7] as number,
      t[o + 8] as number,
    )
    if (d < best) best = d
  }
  return Math.sqrt(best)
}

/**
 * Crossings of a ray from `p` along `dir` with the mesh. Möller-Trumbore, no
 * backface cull — parity is what is wanted, not the first hit.
 *
 * Returns -1 when the ray grazes an edge (a hit within `EDGE_EPS` of a
 * barycentric boundary), so {@link insideMesh} can try another direction rather
 * than count a crossing twice or not at all.
 */
const EDGE_EPS = 1e-7
const rayCrossings = (
  mesh: PropMesh,
  px: number,
  py: number,
  pz: number,
  dx: number,
  dy: number,
  dz: number,
): number => {
  let hits = 0
  const t = mesh.tris
  for (let i = 0; i < mesh.count; i++) {
    const o = i * 9
    const ax = t[o] as number
    const ay = t[o + 1] as number
    const az = t[o + 2] as number
    const e1x = (t[o + 3] as number) - ax
    const e1y = (t[o + 4] as number) - ay
    const e1z = (t[o + 5] as number) - az
    const e2x = (t[o + 6] as number) - ax
    const e2y = (t[o + 7] as number) - ay
    const e2z = (t[o + 8] as number) - az
    const hx = dy * e2z - dz * e2y
    const hy = dz * e2x - dx * e2z
    const hz = dx * e2y - dy * e2x
    const a = e1x * hx + e1y * hy + e1z * hz
    if (a > -1e-12 && a < 1e-12) continue
    const f = 1 / a
    const sx = px - ax
    const sy = py - ay
    const sz = pz - az
    const u = f * (sx * hx + sy * hy + sz * hz)
    if (u < -EDGE_EPS || u > 1 + EDGE_EPS) continue
    const qx = sy * e1z - sz * e1y
    const qy = sz * e1x - sx * e1z
    const qz = sx * e1y - sy * e1x
    const v = f * (dx * qx + dy * qy + dz * qz)
    if (v < -EDGE_EPS || u + v > 1 + EDGE_EPS) continue
    const dist = f * (e2x * qx + e2y * qy + e2z * qz)
    if (dist <= 1e-9) continue
    // Grazing an edge or a vertex: this direction cannot be trusted.
    if (u < EDGE_EPS || v < EDGE_EPS || u + v > 1 - EDGE_EPS) return -1
    hits++
  }
  return hits
}

/**
 * Is `p` inside the mesh? Ray parity, over several fixed directions, majority.
 *
 * Deliberately deterministic directions rather than random ones — `Math.random`
 * in a test makes a failure that cannot be reproduced. They are irrational-ish
 * so no ray runs down an axis of a faceted rock, and a direction that grazes
 * an edge reports -1 and is dropped.
 */
const DIRECTIONS: readonly (readonly [number, number, number])[] = [
  [0.7213, 0.3141, 0.6169],
  [-0.5774, 0.5774, 0.5774],
  [0.2673, -0.8018, 0.5345],
  [-0.4082, -0.4082, 0.8165],
  [0.8944, 0.4472, -0.0224],
]
export const insideMesh = (mesh: PropMesh, px: number, py: number, pz: number): boolean => {
  if (px < mesh.min.x || px > mesh.max.x) return false
  if (py < mesh.min.y || py > mesh.max.y) return false
  if (pz < mesh.min.z || pz > mesh.max.z) return false
  let inside = 0
  let votes = 0
  for (const d of DIRECTIONS) {
    const n = rayCrossings(mesh, px, py, pz, d[0], d[1], d[2])
    if (n < 0) continue
    votes++
    if (n % 2 === 1) inside++
  }
  if (votes === 0) return false
  return inside * 2 > votes
}

/**
 * The mesh's own long axis, as a SEGMENT CAPSULE: two endpoints and the widest
 * distance any vertex sits from the line through them.
 *
 * 2016's own model of a spire is two capsules **along the rod's own axis**
 * (DEV-187 §1, DEV-196 §1), and the honest port of that is a segment capsule —
 * the vertical one being the special case where the rod happens to stand up.
 * This computes the rod from the DRAWN vertices so it also covers `Spire_C` and
 * `Spire_D`, which are placed from the bare FBX and carry no capsules of their
 * own to be measured against.
 *
 * The axis is the first principal component, by Jacobi eigen-decomposition of
 * the covariance — deterministic, no iteration count to tune and no random
 * seed. For a 92 m rod 20 m across the leading eigenvalue is orders of
 * magnitude clear of the other two, so the choice is not a close one.
 */
export interface Rod {
  readonly ax: number
  readonly ay: number
  readonly az: number
  readonly bx: number
  readonly by: number
  readonly bz: number
  /** Max perpendicular distance from the axis to a vertex — the rock's own girth. */
  readonly maxPerp: number
  /** Mean perpendicular distance. 2016's own capsules sit between this and `maxPerp`. */
  readonly meanPerp: number
  /** Length of the segment. */
  readonly length: number
  /** Degrees between the rod and world up. 0 stands, 90 lies down. */
  readonly tiltDegrees: number
}

/** Symmetric 3x3 eigenvectors, Jacobi. Columns sorted by descending eigenvalue. */
const eigenSym3 = (m: number[][]): { values: number[]; vectors: number[][] } => {
  const a = m.map((r) => [...r])
  let v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]
  for (let sweep = 0; sweep < 64; sweep++) {
    let off = 0
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += (a[p]?.[q] as number) ** 2
    if (off < 1e-20) break
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 3; q++) {
        const apq = a[p]?.[q] as number
        if (Math.abs(apq) < 1e-30) continue
        const theta = ((a[q]?.[q] as number) - (a[p]?.[p] as number)) / (2 * apq)
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        for (let k = 0; k < 3; k++) {
          const akp = a[k]?.[p] as number
          const akq = a[k]?.[q] as number
          ;(a[k] as number[])[p] = c * akp - s * akq
          ;(a[k] as number[])[q] = s * akp + c * akq
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p]?.[k] as number
          const aqk = a[q]?.[k] as number
          ;(a[p] as number[])[k] = c * apk - s * aqk
          ;(a[q] as number[])[k] = s * apk + c * aqk
        }
        const nv = v.map((row) => [...row])
        for (let k = 0; k < 3; k++) {
          const vkp = v[k]?.[p] as number
          const vkq = v[k]?.[q] as number
          ;(nv[k] as number[])[p] = c * vkp - s * vkq
          ;(nv[k] as number[])[q] = s * vkp + c * vkq
        }
        v = nv
      }
    }
  }
  const values = [a[0]?.[0] as number, a[1]?.[1] as number, a[2]?.[2] as number]
  const order = [0, 1, 2].sort((i, j) => (values[j] as number) - (values[i] as number))
  return {
    values: order.map((i) => values[i] as number),
    vectors: order.map((i) => [v[0]?.[i] as number, v[1]?.[i] as number, v[2]?.[i] as number]),
  }
}

export const rodOf = (mesh: PropMesh): Rod => {
  const t = mesh.tris
  const n = mesh.count * 3
  let cx = 0
  let cy = 0
  let cz = 0
  for (let i = 0; i < n; i++) {
    cx += t[i * 3] as number
    cy += t[i * 3 + 1] as number
    cz += t[i * 3 + 2] as number
  }
  cx /= n
  cy /= n
  cz /= n
  const cov = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  for (let i = 0; i < n; i++) {
    const d = [
      (t[i * 3] as number) - cx,
      (t[i * 3 + 1] as number) - cy,
      (t[i * 3 + 2] as number) - cz,
    ]
    for (let p = 0; p < 3; p++)
      for (let q = 0; q < 3; q++)
        (cov[p] as number[])[q] = (cov[p]?.[q] as number) + (d[p] as number) * (d[q] as number)
  }
  for (let p = 0; p < 3; p++)
    for (let q = 0; q < 3; q++) (cov[p] as number[])[q] = (cov[p]?.[q] as number) / n
  const axis = eigenSym3(cov).vectors[0] as number[]
  const ux = axis[0] as number
  const uy = axis[1] as number
  const uz = axis[2] as number
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  let maxPerp = 0
  let perpSum = 0
  for (let i = 0; i < n; i++) {
    const dx = (t[i * 3] as number) - cx
    const dy = (t[i * 3 + 1] as number) - cy
    const dz = (t[i * 3 + 2] as number) - cz
    const s = dx * ux + dy * uy + dz * uz
    if (s < lo) lo = s
    if (s > hi) hi = s
    const perp = Math.hypot(dx - ux * s, dy - uy * s, dz - uz * s)
    if (perp > maxPerp) maxPerp = perp
    perpSum += perp
  }
  return {
    ax: cx + ux * lo,
    ay: cy + uy * lo,
    az: cz + uz * lo,
    bx: cx + ux * hi,
    by: cy + uy * hi,
    bz: cz + uz * hi,
    maxPerp,
    meanPerp: perpSum / n,
    length: hi - lo,
    tiltDegrees: (Math.acos(Math.min(1, Math.abs(uy))) * 180) / Math.PI,
  }
}

/**
 * A STACK OF DISCS along the rod's own axis: `slabs` equal steps from `a` to
 * `b`, each carrying the widest perpendicular reach of any triangle that
 * overlaps it. DEV-213, Matt's call: *"i'd prefer it the colliders were closer
 * to the mesh than rods"*.
 *
 * It is 2016's own model generalised. `Spire_B_w_Collision.prefab` carries TWO
 * hand-placed capsules along the rod at different radii — r 17.08 at local
 * z 40.3 narrowing to r 8.24 at z 76.3 — which is a two-slab taper. This is the
 * same idea at K slabs, so K = 2 reproduces roughly what a human did by hand
 * and larger K converges on the rock.
 *
 * **Conservative by construction, which is the property that matters.** The
 * radius is taken per TRIANGLE, not per vertex, and a triangle contributes its
 * widest vertex to every slab its axial span overlaps. So no part of the
 * surface can poke out between two slabs, and a point outside the stack is
 * outside the rock — the same guarantee the single capsule had, at a fraction
 * of the claimed volume.
 */
export interface DiscStack {
  readonly ax: number
  readonly ay: number
  readonly az: number
  readonly bx: number
  readonly by: number
  readonly bz: number
  /** `slabs` radii, from the `a` end to the `b` end. */
  readonly radii: Float32Array
}

export const discStackOf = (mesh: PropMesh, rod: Rod, slabs: number): DiscStack => {
  const ex = rod.bx - rod.ax
  const ey = rod.by - rod.ay
  const ez = rod.bz - rod.az
  const len2 = ex * ex + ey * ey + ez * ez
  const radii = new Float32Array(slabs)
  const t = mesh.tris
  for (let i = 0; i < mesh.count; i++) {
    const o = i * 9
    let lo = Number.POSITIVE_INFINITY
    let hi = Number.NEGATIVE_INFINITY
    let widest = 0
    for (let k = 0; k < 3; k++) {
      const px = t[o + k * 3] as number
      const py = t[o + k * 3 + 1] as number
      const pz = t[o + k * 3 + 2] as number
      const s = len2 > 0 ? ((px - rod.ax) * ex + (py - rod.ay) * ey + (pz - rod.az) * ez) / len2 : 0
      if (s < lo) lo = s
      if (s > hi) hi = s
      const perp = Math.hypot(
        px - (rod.ax + ex * s),
        py - (rod.ay + ey * s),
        pz - (rod.az + ez * s),
      )
      if (perp > widest) widest = perp
    }
    const first = Math.max(0, Math.min(slabs - 1, Math.floor(lo * slabs)))
    const last = Math.max(0, Math.min(slabs - 1, Math.floor(hi * slabs)))
    for (let k = first; k <= last; k++) {
      if (widest > (radii[k] as number)) radii[k] = widest
    }
  }
  return { ax: rod.ax, ay: rod.ay, az: rod.az, bx: rod.bx, by: rod.by, bz: rod.bz, radii }
}

/**
 * How far OUTSIDE the disc stack a point is: 0 or negative means inside.
 *
 * Off the ends of the axis the nearest slab's radius carries on as a cap, so
 * the shape is closed — a rod's tip is not a hole.
 */
export const gapToDiscStack = (stack: DiscStack, px: number, py: number, pz: number): number => {
  const ex = stack.bx - stack.ax
  const ey = stack.by - stack.ay
  const ez = stack.bz - stack.az
  const len2 = ex * ex + ey * ey + ez * ez
  const s =
    len2 > 0 ? ((px - stack.ax) * ex + (py - stack.ay) * ey + (pz - stack.az) * ez) / len2 : 0
  const n = stack.radii.length
  const k = Math.max(0, Math.min(n - 1, Math.floor(s * n)))
  const tc = Math.max(0, Math.min(1, s))
  const d = Math.hypot(
    px - (stack.ax + ex * tc),
    py - (stack.ay + ey * tc),
    pz - (stack.az + ez * tc),
  )
  return d - (stack.radii[k] as number)
}

/**
 * The mesh's CONVEX HULL, as outward half-space planes `n·p <= d`.
 *
 * A spire is a tapered rock and is close to convex, so this is the tightest
 * shape a hot loop can afford: a point is inside when every plane says so, and
 * `max(n·p - d)` over the planes is a conservative penetration depth with a
 * usable outward normal — which is exactly what `stepPropCollision` needs to
 * push a hull out.
 *
 * Any rotationally symmetric shape is stuck well away from a lumpy rock,
 * whatever its axis: a slab's cross-section is an irregular polygon and `pi r^2`
 * on its circumscribed radius overestimates the area badly. Measured, a disc
 * stack round these rocks is 2.4x their volume at 64 slabs and barely improves
 * after 8. The hull is not symmetric and does not pay that.
 */
export interface HullPlanes {
  /** `count * 4` floats: nx, ny, nz, d — outward normal and offset, `n·p <= d` inside. */
  readonly planes: Float32Array
  readonly count: number
}

export const convexHullOf = (mesh: PropMesh): HullPlanes => {
  const points: THREE.Vector3[] = []
  const t = mesh.tris
  for (let i = 0; i < mesh.count * 3; i++) {
    points.push(
      new THREE.Vector3(t[i * 3] as number, t[i * 3 + 1] as number, t[i * 3 + 2] as number),
    )
  }
  const hull = new ConvexHull().setFromPoints(points)
  const out: number[] = []
  for (const face of hull.faces) {
    // three's `Face.distanceToPoint(p)` is `normal·p - constant`, and its own
    // `containsPoint` calls a point inside when that is <= tolerance for every
    // face. So the half-space is `n·p <= constant` and `d` IS `constant`.
    out.push(face.normal.x, face.normal.y, face.normal.z, face.constant)
  }
  return { planes: new Float32Array(out), count: out.length / 4 }
}

/** How far outside the convex hull a point is: <= 0 is inside. */
export const gapToHull = (h: HullPlanes, px: number, py: number, pz: number): number => {
  let worst = Number.NEGATIVE_INFINITY
  for (let i = 0; i < h.count; i++) {
    const o = i * 4
    const g =
      (h.planes[o] as number) * px +
      (h.planes[o + 1] as number) * py +
      (h.planes[o + 2] as number) * pz -
      (h.planes[o + 3] as number)
    if (g > worst) worst = g
  }
  return worst
}

/** The convex hull's volume, m³ — the same divergence sum over its faces. */
export const hullVolume = (mesh: PropMesh): number => {
  const points: THREE.Vector3[] = []
  const t = mesh.tris
  for (let i = 0; i < mesh.count * 3; i++) {
    points.push(
      new THREE.Vector3(t[i * 3] as number, t[i * 3 + 1] as number, t[i * 3 + 2] as number),
    )
  }
  const hull = new ConvexHull().setFromPoints(points)
  let v = 0
  for (const face of hull.faces) {
    // Walk the face's half-edge loop and fan it from the first vertex.
    const vs: THREE.Vector3[] = []
    let e = face.edge
    if (!e) continue
    do {
      vs.push(e.head().point)
      e = e.next
    } while (e && e !== face.edge)
    for (let i = 1; i + 1 < vs.length; i++) {
      const a = vs[0] as THREE.Vector3
      const b = vs[i] as THREE.Vector3
      const c = vs[i + 1] as THREE.Vector3
      v +=
        a.x * (b.y * c.z - b.z * c.y) -
        a.y * (b.x * c.z - b.z * c.x) +
        a.z * (b.x * c.y - b.y * c.x)
    }
  }
  return Math.abs(v) / 6
}

/**
 * The enclosed volume of a closed mesh, m³, by the divergence theorem — the sum
 * of the signed tetrahedra each triangle makes with the origin.
 *
 * Exact and analytic, so a "how much of this collider is rock" number needs no
 * sampling and carries no seed. Absolute value, because winding is not the
 * question here.
 */
export const meshVolume = (mesh: PropMesh): number => {
  let v = 0
  const t = mesh.tris
  for (let i = 0; i < mesh.count; i++) {
    const o = i * 9
    const ax = t[o] as number
    const ay = t[o + 1] as number
    const az = t[o + 2] as number
    const bx = t[o + 3] as number
    const by = t[o + 4] as number
    const bz = t[o + 5] as number
    const cx = t[o + 6] as number
    const cy = t[o + 7] as number
    const cz = t[o + 8] as number
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)
  }
  return Math.abs(v) / 6
}

/** The disc stack's own volume, m³: a sum of cylinders, analytic. */
export const discStackVolume = (stack: DiscStack): number => {
  const len = Math.hypot(stack.bx - stack.ax, stack.by - stack.ay, stack.bz - stack.az)
  const step = len / stack.radii.length
  let v = 0
  for (const r of stack.radii) v += Math.PI * r * r * step
  return v
}

/** Distance from a point to the rod's axis SEGMENT. */
export const distanceToRod = (rod: Rod, px: number, py: number, pz: number): number => {
  const ex = rod.bx - rod.ax
  const ey = rod.by - rod.ay
  const ez = rod.bz - rod.az
  const len2 = ex * ex + ey * ey + ez * ez
  const tRaw = len2 > 0 ? ((px - rod.ax) * ex + (py - rod.ay) * ey + (pz - rod.az) * ez) / len2 : 0
  const tc = Math.max(0, Math.min(1, tRaw))
  return Math.hypot(px - (rod.ax + ex * tc), py - (rod.ay + ey * tc), pz - (rod.az + ez * tc))
}

/**
 * The fraction of the mesh's own triangle vertices that are watertight-paired:
 * every directed edge matched by exactly one opposite directed edge, on
 * position rather than on index, because the faceted rocks are unwelded.
 *
 * A ray-parity inside test is only meaningful on a closed surface, so the
 * caller asserts this before believing {@link insideMesh}.
 */
export const watertightFraction = (mesh: PropMesh): number => {
  const key = (i: number): string => {
    const t = mesh.tris
    // 1 mm quantisation: the rocks are hundreds of metres across.
    return `${Math.round((t[i] as number) * 1000)},${Math.round((t[i + 1] as number) * 1000)},${Math.round((t[i + 2] as number) * 1000)}`
  }
  const seen = new Map<string, number>()
  let edges = 0
  for (let i = 0; i < mesh.count; i++) {
    const o = i * 9
    const k = [key(o), key(o + 3), key(o + 6)]
    for (let e = 0; e < 3; e++) {
      const from = k[e] as string
      const to = k[(e + 1) % 3] as string
      seen.set(`${from}|${to}`, (seen.get(`${from}|${to}`) ?? 0) + 1)
      edges++
    }
  }
  let paired = 0
  for (const [k, n] of seen) {
    const [from, to] = k.split('|') as [string, string]
    const back = seen.get(`${to}|${from}`) ?? 0
    if (back === n) paired += n
  }
  return edges === 0 ? 0 : paired / edges
}
