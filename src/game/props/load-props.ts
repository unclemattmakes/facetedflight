// src/game/props/load-props.ts — fetch the density map, scatter, draw the trees.
//
// The same three-layer seam `load-terrain.ts` sits on:
//
//   src/content/  fetches and decodes the map and the meshes   (DOM, network)
//   src/sim/      turns the map into placements                 (pure)
//   src/render/   turns placements into InstancedMesh           (three)
//
// ── Parented to the terrain, not placed beside it ─────────────────────────
//
// The props group is added as a CHILD of the terrain group, so it inherits that
// group's position and scale for free. The alternative — recomputing
// `worldOffset + localPos + envRoot` here — is a second copy of the arithmetic
// that DEV-042 already cost a session, and the two copies would silently
// disagree the moment one of them learned about a `levelOffset` parent the
// other did not. Compose the parent chain; do not re-derive it.
//
// What that leaves is a single conversion: the scatter works in Unity mesh
// space (x and z running 0..terrainSize, +z forward) and `chunkGeometry` has
// already flipped the terrain into three space, so the props flip with it.
//
// ── One InstancedMesh per palette entry, with a per-CHUNK reveal inside it ─
//
// Alpine is 6,069 trees across 10 meshes, so this is 10 draw calls. Each mesh
// carries a real bounding sphere (DEV-118) rather than `frustumCulled = false`,
// so the whole scatter is skipped when none of it is in view; a grid that split
// each entry into culling cells was built and measured SLOWER — see `cells.ts`
// for the table — and ships at one cell.
//
// **DEV-225 wired the chunked reveal that this header used to say was not
// wired**, and it did it the way that header asked for: one mesh per palette
// entry with the instances ORDERED BY CHUNK, so a visible set is a prefix of
// one buffer rather than one object per (chunk x palette). The draw count does
// not move — 18 on desert before and after — while the instance count does, by
// a lot: 2016's own `LODDistance` (1280 m on three environments, 1920 on
// alpine's first pass) keeps 42 % of desert's 5,943 in the worst of nine camera
// positions, 44 % of Simonet's and 20 % of Kauai's. **That number was extracted
// from Unity, sitting in `content/environments/*.json`, read by nothing, for
// the life of the port** — so the port drew MORE forest than the game it is a
// port of, at every distance.
//
// `instance-plan.ts` is the arithmetic, `sim/props/lod.ts` is 2016's policy,
// and `createPassLod` below is the twenty lines that join them. The only part
// that is neither is `ScatterBatch`: the drawn buffer is a compacted prefix of
// a source buffer, which is why an `InstanceRef` is two methods now and not an
// index — slot `k` holds a different prop after every repack.

import * as THREE from 'three'
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js'
import { assetUrl } from '@/content/asset-url'
import type { EditionPropScale } from '@/content/edition-schema'
import type {
  EnvironmentProps,
  MeshTransform,
  PropLandmark,
  PropScatter,
} from '@/content/load-environment'
import { loadEnvironmentProps } from '@/content/load-environment'
import { isPlacedProp, propEntryByAsset } from '@/content/prop-library'
import { isMeshLoadError, warnMissingAssetOnce } from '@/game/missing-asset'
import { loadMesh } from '@/render/load-mesh'
import { unityPositionTupleToThree, unityQuatTupleToThree } from '@/render/unity-space'
import type { NoPropVolume } from '@/sim/props/clearing'
import type { PropPlacementInput, PropShapeDims } from '@/sim/props/collision'
import {
  initPropLod,
  PROP_LOD_DEFAULTS,
  type PropLodParams,
  type PropLodRuntime,
  rungShare,
  stepPropLod,
} from '@/sim/props/lod'
import { decodeBase64, expandPlacements } from '@/sim/props/placements'
import {
  type ScatteredProps,
  withoutDrowned,
  withoutSteep,
  withoutVolumes,
} from '@/sim/props/scatter'
import { buildVertexGrid, type FacetedTerrainParams, grayscale } from '@/sim/terrain/faceted'
import { importUnityTexture, type MapSampler } from '@/sim/terrain/image-sampler'
import {
  renderSurfaceHeightAt,
  renderSurfaceSlopeAt,
  type SurfaceGrid,
  snapToRenderSurface,
} from '@/sim/terrain/surface'
import { cellIndices, scatterExtent } from './cells'
import { type ChunkRun, type DrawPlan, layoutByChunk, packRange, passChunks } from './instance-plan'
import { propRungGeometries } from './lod-geometry'

export interface LoadedProps {
  /** Parent this to the TERRAIN group, not to the scene. */
  readonly group: THREE.Group
  readonly instanceCount: number
  readonly drawCalls: number
  /**
   * How many placements the ground snap moved DOWN by more than
   * `FLOATING_METRES` — i.e. how many were floating before it. Zero when the
   * snap is off, because then nothing was measured. DEV-134's number.
   */
  readonly floatingFixed: number
  /**
   * How many placements the authored no-prop volumes removed — DEV-287.
   *
   * A RECEIPT, and it is the only way to tell "the volume is doing its job"
   * from "the volume resolved to somewhere there was never a tree". Zero with
   * no volumes authored, which is every environment but `menu` and `alpine`.
   */
  readonly clearedByVolumes: number
  /**
   * How many placements stood on a rendered facet steeper than
   * `props.maxSlope` and were not built — DEV-356. Zero with the limit off,
   * which is Classic. Counted AFTER the volumes, so the two never share a prop.
   */
  readonly clearedBySlope: number
  /**
   * How many placements stood below the sea's high-water mark and were not
   * built, DEV-862. Zero with no `seaLine` (a land-locked environment).
   */
  readonly clearedByWater: number
  /** Hand-placed landmarks drawn (DEV-135): desert 16, Simonet 1, the rest 0. */
  readonly landmarkCount: number
  /**
   * The SCATTER's drawn meshes, and the LANDMARKS', as two lists — DEV-224.
   *
   * Kept apart because the shadow caster set is per class and the scatter is
   * the class a preset may take out of it. They are collected as the meshes are
   * BUILT, not found afterwards by walking `group` and matching a name: the two
   * group names are written in this file and a consumer re-deriving the split
   * from them would be a second copy of that decision, which is the shape
   * DEV-042 already cost a session. `group.children` remains the whole forest.
   */
  readonly scatterMeshes: readonly THREE.InstancedMesh[]
  readonly landmarkMeshes: readonly THREE.InstancedMesh[]
  /**
   * One collider input per drawn prop, in the order `sim/props/collision.ts`
   * indexes them — the scatter passes first, then the landmarks. Mesh-space
   * positions; the dims are the DRAWN bounds at scale 1 through the same
   * instance matrix the renderer composes. DEV-136.
   */
  readonly colliderInputs: readonly PropPlacementInput[]
  /**
   * DEV-502: how many of `colliderInputs` are SCATTER — ids `0 … scatterCount
   * − 1`; the landmarks follow. A line clearing masks only these.
   */
  readonly scatterCount: number
  /**
   * DEV-503: the collider ids of a course's PLACED props (DEV-504), which the
   * editor draws from the draft instead (`editor/desk/props.ts` hides the
   * world's copy), so its warnings leave these out and judge the draft's.
   */
  readonly placedColliderIds: readonly number[]
  /**
   * DEV-502: hide (`hidden`) or restore the scatter instances with these
   * collider ids, in ONE repack per batch touched. Restore puts back the
   * matrix the instance was built with. Ids past `scatterCount` are ignored:
   * a landmark is never cleared. The COLLIDER is the caller's
   * (`setPropCleared`), so what is drawn and what is solid are set together.
   */
  mask(ids: readonly number[], hidden: boolean): void
  /**
   * Advance 2016's per-chunk prop reveal — DEV-225.
   *
   * Takes the CAMERA, not a position, for the two reasons
   * `SunShadows.update` does: in the cockpit `camera.position` is the head
   * pose inside the XR rig and is the origin until you lean (trap 18), so the
   * world position has to be ASKED for; and the world -> mesh-frame flip
   * belongs in this file, beside `instanceMatrixOf`, rather than at a call
   * site re-deriving it (DEV-042).
   *
   * `dt` is seconds since the last call. Returns how many instances are drawn
   * across every pass, or **-1 when nothing was repacked this frame** — the
   * reveal is throttled to 2016's own 1/30 s scan, so most frames answer -1
   * and the caller should keep whatever it had.
   *
   * Safe to never call: the world loads with every instance drawn, which is
   * the frame the port drew before this existed.
   */
  updateLod(camera: THREE.Object3D, dt: number): number
  /** Take the instance with this collider id out of the picture. */
  hide(id: number): void
  /** The geometry and material the instance was drawn with, for the fracture, and its matrix. */
  drawn(
    id: number,
  ): { geometry: THREE.BufferGeometry; material: THREE.Material; matrix: THREE.Matrix4 } | null
  dispose(): void
}

/**
 * The drawn bounds of a geometry under a matrix, as collider dims at scale 1,
 * plus WHERE that box sits horizontally — which for a landmark is not where
 * the matrix's own translation is. See {@link landmarkColliderInput}.
 */
export interface DrawnBox extends PropShapeDims {
  /** Centre of the drawn box in x, three space, in the matrix's own frame. */
  readonly centreX: number
  /** Centre of the drawn box in z, three space, in the matrix's own frame. */
  readonly centreZ: number
}

/**
 * Running min and max on x, y and z of the points handed to {@link add}, and
 * the {@link DrawnBox} they make. The one accumulator behind
 * {@link drawnBoxOf} (eight corners) and {@link drawnBoxOfVertices} (every
 * vertex), so the two cannot drift apart in how a box becomes collider dims.
 */
class DrawnExtents {
  #minX = Infinity
  #maxX = -Infinity
  #minY = Infinity
  #maxY = -Infinity
  #minZ = Infinity
  #maxZ = -Infinity

  add(c: THREE.Vector3): void {
    this.#minY = Math.min(this.#minY, c.y)
    this.#maxY = Math.max(this.#maxY, c.y)
    this.#minX = Math.min(this.#minX, c.x)
    this.#maxX = Math.max(this.#maxX, c.x)
    this.#minZ = Math.min(this.#minZ, c.z)
    this.#maxZ = Math.max(this.#maxZ, c.z)
  }

  box(): DrawnBox {
    return {
      height: this.#maxY,
      base: this.#minY,
      width: Math.max(this.#maxX - this.#minX, this.#maxZ - this.#minZ),
      centreX: (this.#minX + this.#maxX) / 2,
      centreZ: (this.#minZ + this.#maxZ) / 2,
    }
  }
}

/** The drawn bounds of a geometry under a matrix, as collider dims at scale 1. */
export const drawnBoxOf = (min: THREE.Vector3, max: THREE.Vector3, m: THREE.Matrix4): DrawnBox => {
  const extents = new DrawnExtents()
  const c = new THREE.Vector3()
  for (const x of [min.x, max.x])
    for (const y of [min.y, max.y])
      for (const z of [min.z, max.z]) extents.add(c.set(x, y, z).applyMatrix4(m))
  return extents.box()
}

const dimsOf = (geometry: THREE.BufferGeometry, m: THREE.Matrix4): DrawnBox => {
  if (!geometry.boundingBox) geometry.computeBoundingBox()
  const bb = geometry.boundingBox as THREE.Box3
  return drawnBoxOf(bb.min, bb.max, m)
}

/**
 * The same box, measured on the VERTICES instead of on the eight corners of the
 * mesh's own AABB. DEV-187, and it is only worth doing where the matrix has a
 * rotation in it.
 *
 * The AABB of a rotated AABB is a bound on a bound: turn a box and the new
 * axis-aligned box round it is bigger than the one round the points. For the
 * scatter that costs nothing — `dimsOf` is called at yaw 0 with an unrotated
 * child matrix, so the two boxes are the same box — but a landmark carries an
 * authored quaternion and a 3–9× scale, and there it ran to **1.58×**: desert's
 * `Spire_C (2)` is a 131 m rock whose capsule spanned 219 m, putting 56 m of
 * solid air under it and 32 m over it. `adv_01_hoverJet`'s racing line flies
 * through that air, and with DEV-187's reach fix in place it would have become
 * a wall made of nothing — 85 m of that mission's line rather than 336 m, which
 * is the difference this function is worth. **When a collider is going to be
 * believed, bound the mesh and not a box round it.**
 *
 * Seventeen landmarks of ~3,000 vertices each, once at world build.
 */
export const drawnBoxOfVertices = (
  positions: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  m: THREE.Matrix4,
): DrawnBox => {
  const extents = new DrawnExtents()
  const c = new THREE.Vector3()
  for (let i = 0; i < positions.count; i++) {
    extents.add(c.fromBufferAttribute(positions, i).applyMatrix4(m))
  }
  return extents.box()
}

/**
 * One hand-placed landmark's collider, in the frame `buildPropColliders` takes.
 *
 * **The axis goes under the MESH, not at the placement point** — DEV-187, and
 * the difference is the whole function. `out`'s translation is where the glTF's
 * own origin lands, and a spire's origin is not inside a spire: `spire-b.glb`'s
 * vertices run z −92.37…0, so the pivot is at one END of a 92 m rod, and the
 * file's mesh node adds another (27.19, −35.19, 74.55) on top. Composed under
 * the landmark's authored rotation and its 3–9× scale, that pivot lands **up to
 * 254.6 m** from the rock it is supposed to be the middle of — so the capsule
 * stood in open desert beside its spire and the spire was hollow.
 *
 * It survived because of the agreement lesson. Five of the seventeen live
 * landmarks are rotated so the rod stands close to UP, and for those the pivot
 * offset goes mostly into y, where the capsule spans it anyway: their error was
 * 5.7–43.0 m and reads as rounding on a 600 m rock. The twelve that LEAN put
 * the same offset into the horizontal plane, and they are the ones with
 * 109–255 m of it — eleven had the axis further from their own mesh's centroid
 * than the capsule's whole radius.
 *
 * The SCATTER keeps its axis at the placement point and is right to: 2016 put a
 * trunk there, and a palm's drawn box is centred on its FRONDS — moving the
 * capsule to the box centre would take it off the trunk (`gl-palmtree-02`'s box
 * centre is 1.52 m from its placement point against a 1.10 m collider radius).
 * Measured for every palette entry in all four environments: the largest
 * scatter offset is that 1.52 m, so nothing there is displaced by its own mesh.
 */
export const landmarkColliderInput = (
  landmark: PropLandmark,
  box: DrawnBox,
  out: THREE.Matrix4,
  hull?: Float32Array | null,
  mesh?: Float32Array | null,
): PropPlacementInput => {
  const y = new THREE.Vector3().setFromMatrixPosition(out).y
  return {
    x: box.centreX,
    y,
    // Back to Unity mesh space, the frame the collider builder takes.
    z: -box.centreZ,
    scale: 1,
    dims: { height: box.height - y, base: box.base - y, width: box.width },
    kind: landmark.kind ?? 'landmark',
    hull: hull ?? null,
    mesh: mesh ?? null,
  }
}

/**
 * The drawn geometry's CONVEX HULL, as planes in the frame
 * {@link PropPlacementInput} takes. DEV-213.
 *
 * ── Why a hull and not a capsule of some arrangement ──────────────────────
 *
 * **Because 2016 collided on the MESH.** `Spire_B_w_Collision.prefab` carries a
 * live `MeshCollider` (`m_Enabled: 1`, `m_IsTrigger: 0`, `m_Convex: 0`) and its
 * two hand-placed capsules are `m_IsActive: 0`. So the capsules were never the
 * collision shape; they are a measurement aid (DEV-196 uses them as one), and
 * the faithful port of the shape is the tightest convex thing a hot loop can
 * afford.
 *
 * Measured, claimed volume ÷ the rock's own volume across the seventeen live
 * landmarks: shipped vertical cylinder **1.58x**, convex hull **1.39x**, and a
 * disc stack along the rod's own axis — 2016's two capsules generalised to K
 * slabs — **never better than 2.40x** at any K. Refining a rotationally
 * symmetric shape refines it ALONG the axis and the loss is ACROSS it: a
 * slab's cross-section is an irregular polygon, and `pi r^2` on its
 * circumscribed radius overestimates that badly however many slabs there are.
 *
 * ── The frame ─────────────────────────────────────────────────────────────
 *
 * `out` is the drawn matrix, so the hull comes out in THREE space. The
 * collider builder works in SIM, which is that mirrored in z, and a plane
 * `n·p <= d` with `p = (q.x, q.y, -q.z)` is `(nx, ny, -nz)·q <= d`. The offset
 * is unchanged; only the normal's z flips. `buildPropColliders` then shifts `d`
 * by the terrain origin.
 *
 * Seventeen hulls of ~2,900 points, once at world build.
 */
export const landmarkHullPlanes = (
  positions: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  out: THREE.Matrix4,
): Float32Array => {
  const points: THREE.Vector3[] = []
  const c = new THREE.Vector3()
  for (let i = 0; i < positions.count; i++) {
    points.push(c.fromBufferAttribute(positions, i).applyMatrix4(out).clone())
  }
  const hull = new ConvexHull().setFromPoints(points)
  const planes = new Float32Array(hull.faces.length * 4)
  let w = 0
  for (const face of hull.faces) {
    // three's `Face.distanceToPoint` is `normal·p - constant` and its own
    // `containsPoint` calls a point inside when that is <= tolerance for every
    // face, so the half-space is `n·p <= constant`.
    planes[w++] = face.normal.x
    planes[w++] = face.normal.y
    // THREE -> SIM is the z mirror, and for a PLANE that is the normal's z.
    planes[w++] = -face.normal.z
    planes[w++] = face.constant
  }
  return planes
}

/**
 * The drawn geometry's TRIANGLES, `count * 9` floats in the frame
 * {@link PropPlacementInput} takes. DEV-345.
 *
 * The hull above is the tightest CONVEX thing round the rock, and on a concave
 * rock it claims air: Simonet's sea stack has a shoulder `int_01_jumpSeat`'s
 * pad 5 is built on, and the hull wraps over it — the bullseye is 5.3 m clear
 * of the rock and 22.4 m inside the hull. 2016's collider is the `MeshCollider`
 * with `m_Convex: 0`, i.e. these triangles; `sim/props/landmark-mesh.ts`
 * collides on them behind the hull.
 *
 * Same frame as {@link landmarkHullPlanes}: through `out` into THREE, then the
 * z mirror into SIM, which reverses every triangle's winding — the sim side
 * discovers the winding from the signed volume rather than trusting it.
 * Indexed or not: a faceted rock is often unwelded, and `index` null walks the
 * positions three at a time.
 */
export const landmarkTriangles = (
  positions: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  index: THREE.BufferAttribute | null,
  out: THREE.Matrix4,
): Float32Array => {
  const corners = index ? index.count : positions.count
  const tris = new Float32Array(Math.floor(corners / 3) * 9)
  const c = new THREE.Vector3()
  for (let k = 0; k < tris.length / 3; k++) {
    c.fromBufferAttribute(positions, index ? index.getX(k) : k).applyMatrix4(out)
    tris[k * 3] = c.x
    tris[k * 3 + 1] = c.y
    // THREE -> SIM is the z mirror.
    tris[k * 3 + 2] = -c.z
  }
  return tris
}

/**
 * Where one collider id is drawn: one slot of one batch.
 *
 * **It is an interface with two methods rather than `{inst, index}`** since
 * DEV-225, and that is the whole reason it changed: a scatter batch's drawn
 * buffer is now a compacted PREFIX of its source, so slot `k` of
 * `inst.instanceMatrix` holds a different prop from one frame to the next.
 * Writing `ZERO_MATRIX` at a live slot would hide whichever tree happened to be
 * there and un-hide the fractured one on the next repack. The scatter's
 * implementation writes the SOURCE and re-applies; the landmarks', which never
 * move and have no LOD, writes the mesh directly.
 */
export interface InstanceRef {
  readonly inst: THREE.InstancedMesh
  /** Take this instance out of the picture, permanently (DEV-148's fracture). */
  hide(): void
  /** The matrix this instance is drawn with, into `out`. */
  matrix(out: THREE.Matrix4): THREE.Matrix4
  /**
   * DEV-502: hide or restore this instance WITHOUT a repack, and say which
   * batch to repack. A scatter instance only; a landmark has none (it is never
   * cleared: DEV-218).
   */
  readonly mask?: (hidden: boolean) => ScatterBatch
}

const ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0)

/** Floats per instance matrix. three's `InstancedMesh` layout, not ours. */
const MATRIX_STRIDE = 16

/**
 * One `InstancedMesh` of the scatter, plus the source order behind it.
 *
 * `inst.instanceMatrix` holds only what is DRAWN, compacted to the front;
 * `source` holds every instance the batch owns, in chunk order (DEV-225's
 * `layoutByChunk`). `apply` copies the spans of a `DrawPlan` from one to the
 * other and moves `inst.count`. Nothing else may write `instanceMatrix`.
 */
export interface ScatterBatch {
  /** Rung 0: the full mesh. The one the fracture and the colliders are sized from. */
  readonly inst: THREE.InstancedMesh
  /**
   * Every rung's mesh, `inst` first — DEV-338. One entry when the preset has no
   * mesh LOD, which is Classic. All of them read the one `source` below, so a
   * hidden prop is hidden on every rung by one write.
   */
  readonly rungs: readonly THREE.InstancedMesh[]
  /** Chunk ids to contiguous runs of `source`, ascending. */
  readonly runs: readonly ChunkRun[]
  /** Write one source slot. */
  setSource(index: number, m: THREE.Matrix4): void
  /** Read one source slot. */
  getSource(index: number, out: THREE.Matrix4): THREE.Matrix4
  /** Draw the plan on rung 0 and nothing on the others. */
  apply(plan: DrawPlan): void
  /** Draw one plan per rung, in rung order. A missing plan draws nothing. */
  applyRungs(plans: readonly DrawPlan[]): void
  /** Draw the plans this batch last applied. For a source write after the fact. */
  reapply(): void
  /**
   * DEV-502: zero one source slot (`hidden`), or put back the matrix it was
   * BUILT with. No repack: the caller reapplies each batch it touched once.
   * The built matrices are copied the first time anything is masked, so a
   * batch nobody masks carries no second buffer.
   */
  maskSource(index: number, hidden: boolean): void
}

/**
 * An `InstanceRef` onto one slot of a scatter batch's SOURCE order.
 *
 * `hide` zeroes the source and re-applies the plan, rather than zeroing the
 * live slot: the live buffer is a compacted prefix and slot `k` holds a
 * different prop after every repack, so a write to it is a write to whatever
 * happened to be standing there.
 */
export const scatterRef = (batch: ScatterBatch, index: number): InstanceRef => ({
  inst: batch.inst,
  hide() {
    batch.setSource(index, ZERO_MATRIX)
    batch.reapply()
  },
  matrix(out) {
    return batch.getSource(index, out)
  },
  mask(hidden) {
    batch.maskSource(index, hidden)
    return batch
  },
})

/** An `InstanceRef` onto a landmark, which has no LOD and no source buffer. */
const directRef = (inst: THREE.InstancedMesh, index: number): InstanceRef => ({
  inst,
  hide() {
    inst.setMatrixAt(index, ZERO_MATRIX)
    inst.instanceMatrix.needsUpdate = true
  },
  matrix(out) {
    inst.getMatrixAt(index, out)
    return out
  },
})

const EMPTY_PLAN: DrawPlan = { count: 0, spans: [] }

export const createScatterBatch = (
  inst: THREE.InstancedMesh,
  runs: readonly ChunkRun[],
  /** DEV-338: the coarser rungs' meshes, each with `inst.count` capacity. */
  lowerRungs: readonly THREE.InstancedMesh[] = [],
): ScatterBatch => {
  const total = inst.count
  const source = new Float32Array(total * MATRIX_STRIDE)
  const rungs = [inst, ...lowerRungs]
  let last: readonly DrawPlan[] = [{ count: total, spans: [{ src: 0, dst: 0, count: total }] }]
  /** DEV-502: the built matrices, copied at the first mask (`maskSource`). */
  let pristine: Float32Array | null = null
  const drawOn = (mesh: THREE.InstancedMesh, plan: DrawPlan): void => {
    const live = mesh.instanceMatrix.array as Float32Array
    for (const span of plan.spans) {
      live.set(
        source.subarray(span.src * MATRIX_STRIDE, (span.src + span.count) * MATRIX_STRIDE),
        span.dst * MATRIX_STRIDE,
      )
    }
    // An upload only where something was written, or where a rung that was
    // drawing stops: `needsUpdate` on a rung that stays empty is a buffer
    // upload per repack for nothing, three rungs times every batch.
    if (plan.spans.length > 0) mesh.instanceMatrix.needsUpdate = true
    mesh.count = plan.count
  }
  const batch: ScatterBatch = {
    inst,
    rungs,
    runs,
    setSource(index, m) {
      m.toArray(source, index * MATRIX_STRIDE)
    },
    getSource(index, out) {
      return out.fromArray(source, index * MATRIX_STRIDE)
    },
    apply(plan) {
      batch.applyRungs([plan])
    },
    applyRungs(plans) {
      last = plans
      for (let r = 0; r < rungs.length; r++) {
        drawOn(rungs[r] as THREE.InstancedMesh, plans[r] ?? EMPTY_PLAN)
      }
    },
    reapply() {
      batch.applyRungs(last)
    },
    maskSource(index, hidden) {
      // The copy is taken at the FIRST mask, which for a player course is at
      // world build, before anything has flown (and so before any fracture
      // has zeroed a slot). A world masked later, in the editor, may carry a
      // fractured slot's zeros in the copy — which is the right thing to put
      // back, since that tree is gone (`course-clearing.ts` never shows an id
      // it did not hide).
      if (!pristine) pristine = source.slice()
      const at = index * MATRIX_STRIDE
      if (hidden) ZERO_MATRIX.toArray(source, at)
      else source.set(pristine.subarray(at, at + MATRIX_STRIDE), at)
    },
  }
  return batch
}

/**
 * A prop whose base is this far above the rendered surface reads as floating
 * from the seat. Under it, a trunk's own foot hides the gap; over it, there is
 * sky between the roots and the ground. The reporting threshold DEV-134 asked
 * for, and a report threshold rather than a tuning: nothing is placed by it.
 */
export const FLOATING_METRES = 0.3

/**
 * Anniversary's ground snap. `edition.props.groundSnap` — DEV-134.
 *
 * 2016 placed every scattered prop on the SOURCE HEIGHT MAP minus the pass's
 * `ObjectHeightOffset`, and the mesh you see is that map plus a per-vertex
 * jitter (`RandomOffset`, 0.8 m on alpine) — so a trunk stood on a point the
 * facet under it had moved away from. Alpine's never-run big-tree pass carries
 * `heightOffset -2.6`, which RAISES it: on Anniversary, which is the only
 * preset that draws that pass, those trees hung 0.4–2.4 m in the air before the
 * jitter was counted. With this on, a prop's base goes to the RENDERED surface
 * at its own (x, z) and then `sink` metres under it.
 */
export interface GroundSnapOptions {
  /** The terrain's full generator params — the snap rebuilds its vertex grid. */
  readonly params: FacetedTerrainParams
  /** Metres the base is buried below the facet. */
  readonly sink: number
}

/**
 * Anniversary's slope limit. `edition.props.maxSlope` — DEV-356.
 *
 * Matt: *"don't place props on steep slopes."* A placement whose RENDERED
 * facet is steeper than `sin` is not built — not drawn, not a collider, not in
 * a chunk's reveal — because it is dropped before any of those is derived.
 * 2016 had no such rule (its generator reads the density map and nothing
 * else), so absent or null is 2016's forest, which is Classic.
 */
export interface MaxSlopeOptions {
  /** The terrain's full generator params — the facet is looked up on its vertex grid. */
  readonly params: FacetedTerrainParams
  /** `sin` of the steepest facet a prop may stand on: 0 flat, 1 a wall. */
  readonly sin: number
}

export interface LoadPropsOptions {
  /** `TerrainSize` / `TerrainHeight` / `ChunkSize` for this environment. */
  readonly terrain: { terrainSize: number; terrainHeight: number; chunkSize: number }
  /** The terrain's own height map, already through `importUnityTexture`. */
  readonly heightMap: MapSampler
  /** Deterministic. Not a 2016 concept — its scatter was unseeded. */
  readonly seed?: number
  /**
   * Per-KIND scale multipliers, `edition.props.scale` (DEV-134). Keyed by the
   * palette entry's `kind` (`tree`, `cactus`, `bush`, `palm`, as the extractor
   * classified the pack); a kind that is absent multiplies by 1. Classic passes
   * nothing and draws 2016's scales.
   */
  readonly scale?: EditionPropScale
  /** Snap every base to the rendered surface. Null or absent is 2016's rule. */
  readonly groundSnap?: GroundSnapOptions | null
  /** Leave facets steeper than this bare. Null or absent is 2016's rule. DEV-356. */
  readonly maxSlope?: MaxSlopeOptions | null
  /**
   * The lowest a scattered prop's BASE may stand, per (x, z) in the terrain's
   * MESH frame: the sea's rest surface there plus the most the drawn sea ever
   * lifts it (`game/props/sea-line.ts`). A placement below it is not built, on
   * either look. Absent or null is an environment with no sea. DEV-862.
   */
  readonly seaLine?: ((x: number, z: number) => number) | null
  /**
   * Draw the environment's hand-placed landmarks — DEV-135: desert's sixteen
   * canyon spires and Simonet's one. `terrainLocalPosition` is the terrain's
   * own position under the LevelArt root (`terrainLocalPosition(key)`), the
   * frame the landmarks are composed in; absent, no landmark is drawn. Only
   * `live` landmarks are drawn, on EVERY preset: 2016 shipped them.
   */
  readonly landmarks?: { readonly terrainLocalPosition: readonly number[] } | null
  /**
   * Scenery the MISSION places, on top of the environment's own — DEV-218, and
   * DEV-219 for Simonet's palms. `level.props`, which is structurally a
   * `PropLandmark` in the same frame, so it is CONCATENATED with
   * `env.landmarks` rather than drawn by a second path: three missions carry
   * some and adding a fourth is a JSON change, not a code change (rule 6).
   *
   * Absent or empty is the ten missions that place none.
   */
  readonly missionProps?: readonly PropLandmark[] | null
  /**
   * Draw the passes 2016 authored and never RAN. `edition.props.unbakedPasses`.
   *
   * **Defaults to FALSE, and the default is the decision.** An absent option
   * means a caller that has not thought about the preset, and the answer for
   * one of those is the shipped 2016 game — DEV-102 exists because the port
   * drew five passes for four sessions on the strength of nobody having asked.
   */
  readonly unbakedPasses?: boolean
  /**
   * Authored no-prop volumes for this world — DEV-287, Matt's *"place geo
   * where i didn't want props to be"*.
   *
   * Already resolved into the terrain's own mesh space by
   * `game/props/no-prop-volumes.ts`, which is the only module that knows about
   * anchors and about `terrainOriginSim`. This file receives capsules and does
   * one thing with them: drop the placements inside.
   *
   * Absent or empty draws every placement the bake produced, which is every
   * environment nobody has authored art direction for.
   */
  readonly noPropVolumes?: readonly NoPropVolume[]
  /** Culling cells per axis. `PROP_CELLS_PER_AXIS` when absent; `?propCells=` sets it. */
  readonly cellsPerAxis?: number
  /**
   * Override every pass's own `lodDistance` — DEV-225, and a MEASUREMENT knob.
   *
   * Absent keeps each generator's extracted 2016 value (desert, Simonet and
   * Kauai 1280 m; alpine 1920 and 1280), which is the shipped behaviour.
   * `Infinity` draws the whole scatter at every distance, which is the frame
   * the port drew before DEV-225 and the A/B's baseline arm. `?propLod=` sets
   * it and nothing else reads it.
   */
  readonly lodDistance?: number
  /**
   * Coarser meshes for the far scatter — DEV-338, `edition.props.meshLod`.
   *
   * `rungs` is read at WORLD BUILD, like `groundSnap`: it decides which
   * geometries exist, and making them costs tens of milliseconds a mesh. Empty
   * or absent builds none, and the scatter is DEV-225's — which is Classic.
   * `enabled` is read at every SCAN, so a live flip (the Advanced page,
   * `?feature=props.meshLod:off`) walks the forest back to the full meshes by
   * the staggered swap rather than waiting for the next world.
   */
  readonly meshLod?: MeshLodOptions | null
  readonly signal?: AbortSignal
}

/** One coarser rung: where it starts, and how much of the mesh it keeps. */
export interface MeshLodRung {
  /** Metres to a chunk's NEAREST point at which this rung takes over. */
  readonly from: number
  /** Fraction of the mesh's distinct corners it keeps, 0..1 exclusive. */
  readonly keep: number
}

export interface MeshLodOptions {
  /** Nearest first; `from` ascending, `keep` descending. */
  readonly rungs: readonly MeshLodRung[]
  /** Whether the rungs are in use right now. A getter, never cached. */
  readonly enabled: () => boolean
}

/**
 * Did the 2016 build actually draw this pass? DEV-102.
 *
 * **The predicate is the COUNT**, because that is the lesson the row cost:
 * *when a 2016 component's job is to PRODUCE objects, count the objects.* A
 * `FacetedTerrain` scatter is an editor-time `GenerateObjects()` whose output is
 * serialised on the component as `_StoredChunks[*].Objects`, so an empty list is
 * a pass nobody ran and `m_Enabled: 0` is a pass switched off. Alpine's Tree
 * Pack pass is both; Simonet's and Kauai's palm generators are enabled and
 * empty, which is the case that reads as working and is not.
 *
 * `componentEnabled` is corroborating evidence and is deliberately NOT
 * consulted: a pass that was disabled but had baked output would still have
 * drawn those objects, because they are GameObjects in the scene by then and
 * nothing re-runs the generator at play time.
 *
 * A pass with NO `shipped2016` block answers **false** — unknown is not
 * "shipped", and `props-2016-bake.test.ts` refuses an environment that has one,
 * so this branch is a guard rather than a policy.
 */
export const shippedIn2016 = (entry: PropScatter): boolean =>
  (entry.shipped2016?.bakedObjects ?? 0) > 0

// The Unity -> three flip of a quaternion is `render/unity-space.ts`'s
// (`unityQuatTupleToThree`): a conjugation by the z mirror, `(x, y, z, w) ->
// (-x, -y, z, w)`. Trap 22 is the same fact showing up as a mesh that flies
// backwards; here a dropped sign is a prop whose lean goes the wrong way, which
// is subtler and therefore worse.

/** Scratch. Valid only inside one synchronous call — never stored (trap 19). */
const _root = new THREE.Matrix4()
/** Scratch for the LOD frame conversion. One synchronous call only (trap 19). */
const _lodPoint = new THREE.Vector3()
const _child = new THREE.Matrix4()
const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _scale = new THREE.Vector3()
const _yAxis = new THREE.Vector3(0, 1, 0)

/**
 * The wrapper prefab's subtree transform, converted to three space, as one
 * matrix. `meshTransform` is the composed Unity transform from the prop
 * prefab's root (exclusive) to its mesh node (inclusive); the position's z
 * flips and the quaternion conjugates under the z mirror.
 */
export const childMatrixOf = (mt: MeshTransform | null, out: THREE.Matrix4): THREE.Matrix4 => {
  const childPos = unityPositionTupleToThree(mt?.position)
  const childQuat = mt ? unityQuatTupleToThree(mt.rotation) : new THREE.Quaternion()
  const childScale = new THREE.Vector3(mt?.scale[0] ?? 1, mt?.scale[1] ?? 1, mt?.scale[2] ?? 1)
  return out.compose(childPos, childQuat, childScale)
}

/**
 * One scattered instance's matrix in the TERRAIN group's frame.
 *
 * `(x, y, z)` is the placement in Unity mesh space (the frame `scatterProps`
 * writes), `yaw` the Unity yaw about +y, `s` the uniform scale, `child` the
 * matrix `childMatrixOf` built for the palette entry, and `source` the mesh's
 * own local matrix inside the glTF (identity for the usual single-mesh prop).
 *
 * Exported so a test can measure the SAME composition the renderer draws —
 * DEV-134's heights and base offsets are read off this matrix applied to the
 * glTF's own accessor bounds, not reasoned out of the prefab YAML.
 */
export const instanceMatrixOf = (
  x: number,
  y: number,
  z: number,
  yaw: number,
  s: number,
  child: THREE.Matrix4,
  source: THREE.Matrix4 | null,
  out: THREE.Matrix4,
): THREE.Matrix4 => {
  // Unity +z -> three -z, the same flip `chunkGeometry` applied to the terrain
  // this group hangs under. A Unity yaw about +y becomes its negation in a
  // right-handed frame.
  _pos.set(x, y, -z)
  _quat.setFromAxisAngle(_yAxis, -yaw)
  _scale.set(s, s, s)
  _root.compose(_pos, _quat, _scale)
  out.multiplyMatrices(_root, child)
  if (source) out.multiply(source)
  return out
}

/**
 * One pass's placements as the game builds them: expanded from the baked blob,
 * then the authored no-prop volumes (DEV-287), the slope limit (DEV-356), the
 * ground snap (DEV-134) and the sea (DEV-862), in that order. Pure and
 * GLB-free, so a test sweeps the very list `buildScatterGroup` draws from
 * rather than a transcription of it.
 */
export const placeScatter = (
  entry: PropScatter,
  options: LoadPropsOptions,
  seed: number,
  grid: SurfaceGrid | null,
): {
  placed: ScatteredProps
  floating: number
  clearedByVolumes: number
  clearedBySlope: number
  clearedByWater: number
} => {
  const expanded = expandPlacements(
    decodeBase64(entry.placements.data),
    { width: entry.placements.mapWidth, height: entry.placements.mapHeight },
    options.heightMap,
    options.terrain,
    {
      probabilityScale: entry.probabilityScale,
      heightOffset: entry.heightOffset,
      scaleMin: entry.scaleMin,
      scaleMax: entry.scaleMax,
      paletteSize: entry.palette.length,
      seed,
    },
  )

  // ── DEV-287: the ground the art direction says to leave alone ──────────
  //
  // Here — after the expansion, before the buckets, the cells, the chunk
  // layout and the collider inputs — because every one of those is derived
  // from the placement list and a prop removed at this point is removed from
  // all of them at once. Filtering later would need `layoutByChunk`'s runs to
  // survive a hole in the middle of a batch (DEV-225), and a collider whose
  // mesh was never drawn is the shape of bug DEV-136 exists to avoid.
  const { props: unvolumed, removed: clearedByVolumes } = withoutVolumes(
    expanded,
    options.noPropVolumes ?? [],
  )
  // ── DEV-356: the ground too steep to stand a tree on ──────────────────
  //
  // Beside the volumes and for the same reason: before the snap, the buckets,
  // the cells, the chunk layout and the collider inputs, so a prop that goes
  // here goes from all of them at once and there is no invisible rock. The
  // slope is the RENDERED facet's — the one the snap stands the trunk on —
  // not the map's, which is flatter than what you see exactly where it matters
  // (DEV-288). Its own receipt, so the census's conservation law can tell art
  // direction from terrain.
  const limit = options.maxSlope
  const { props: sloped, removed: clearedBySlope } =
    grid && limit
      ? withoutSteep(unvolumed, limit.sin, (x, z) =>
          renderSurfaceSlopeAt(grid, options.heightMap, limit.params, x, z),
        )
      : { props: unvolumed, removed: 0 }

  // DEV-134, Anniversary only. AFTER the expansion and BEFORE the buckets, so
  // the y every instance is drawn at is the rendered surface's — and the
  // count of what MOVED is the count of what was floating, measured against
  // the same `FLOATING_METRES` the ledger row quotes.
  let floating = 0
  if (grid && options.groundSnap) {
    floating = snapToRenderSurface(
      sloped.positions,
      sloped.count,
      grid,
      options.heightMap,
      options.groundSnap.params,
      options.groundSnap.sink,
      FLOATING_METRES,
    )
  }
  // ── DEV-862: nothing stands in the sea ────────────────────────────────
  //
  // After the snap, so the base compared is the base drawn, and before the
  // buckets, the cells, the chunk layout and the collider inputs, so a drowned
  // palm leaves all of them at once. Both looks: the bake is height-blind, and
  // a palm on the seabed is wrong in either.
  const { props: placed, removed: clearedByWater } = options.seaLine
    ? withoutDrowned(sloped, options.seaLine)
    : { props: sloped, removed: 0 }
  return { placed, floating, clearedByVolumes, clearedBySlope, clearedByWater }
}

const buildScatterGroup = async (
  entry: PropScatter,
  options: LoadPropsOptions,
  seed: number,
  grid: SurfaceGrid | null,
): Promise<{
  group: THREE.Group
  count: number
  draws: number
  floating: number
  /** DEV-287: placements this pass lost to an authored no-prop volume. */
  clearedByVolumes: number
  /** DEV-356: placements this pass lost to `props.maxSlope`. */
  clearedBySlope: number
  /** DEV-862: placements this pass lost to the sea. */
  clearedByWater: number
  inputs: PropPlacementInput[]
  refs: InstanceRef[][]
  meshes: THREE.InstancedMesh[]
  /** DEV-225: this pass's batches, and 2016's reveal policy for them. */
  lod: PassLod | null
  dispose: () => void
}> => {
  const group = new THREE.Group()
  group.name = `props:scatter:${entry.index}`
  /** Every `InstancedMesh` this pass draws, for the shadow caster set (DEV-224). */
  const meshes: THREE.InstancedMesh[] = []
  /** DEV-225: the same meshes with their source order and runs beside them. */
  const batches: ScatterBatch[] = []
  // DEV-136: one collider input and one list of drawn slots PER PLACEMENT, in
  // placement order, so a collider id maps back to what to hide.
  const inputs: PropPlacementInput[] = []
  const refs: InstanceRef[][] = []

  // No fetch. The scatter was run once at bake time and the answer is in the
  // environment JSON — see `sim/props/placements.ts` for why that is possible
  // (the PRNG never sees the height map or the terrain) and why the blob
  // belongs to THIS entry and must never be flattened across the environment
  // (alpine's two generators are 7.6 m apart in `heightOffset` alone).
  //
  // `seed` is still derived here and still passed, but only so a mismatch is
  // loud: the bake records what it drew with, and the two must agree.
  if (entry.placements.seed !== seed) {
    throw new Error(
      `props: ${entry.index} was baked with seed ${entry.placements.seed} but the ` +
        `loader derived ${seed}. Re-run \`node tools/assets/bake-placements.mjs\`.`,
    )
  }

  const { placed, floating, clearedByVolumes, clearedBySlope, clearedByWater } = placeScatter(
    entry,
    options,
    seed,
    grid,
  )
  // ON THE GROUP, so a spec counting instances can close the books without a
  // second API. `spawn-clearing.spec.ts` asserts that a pass HOLDS its baked
  // `placements.count`, which DEV-287 makes false by design: the honest form is
  // the conservation law `held + cleared === count`, and every term of it is
  // read from the same scene walk. Each removal has its own receipt, so the
  // census can tell art direction (volumes) from terrain (slope) from sea.
  group.userData.clearedByVolumes = clearedByVolumes
  group.userData.clearedBySlope = clearedBySlope
  group.userData.clearedByWater = clearedByWater
  // The scatter's footprint, for the culling cells below. Once per pass — every
  // palette entry of this pass shares the same grid, so a cell's sphere means
  // the same ground whichever prop it holds.
  const extent = scatterExtent(placed.positions, placed.count)

  // One bucket per palette INDEX, not per mesh: the palette is weighted by
  // repetition (`bush_desert_01` is 7 of desert's 13 entries) and collapsing
  // duplicates would silently reweight the scatter.
  const buckets: number[][] = entry.palette.map(() => [])
  for (let i = 0; i < placed.count; i++) {
    const bucket = buckets[placed.palette[i] ?? 0]
    if (bucket) bucket.push(i)
  }

  const disposers: (() => void)[] = []
  let draws = 0
  /** DEV-898: meshes of this pass that failed to load, and the placements that cost it. */
  const missingHere = new Set<string>()
  let skippedPlacements = 0
  /** DEV-338: what each coarser rung keeps. Empty builds rung 0 alone. */
  const rungKeeps = (options.meshLod?.rungs ?? []).map((r) => r.keep)

  for (let p = 0; p < entry.palette.length; p++) {
    const bucket = buckets[p]
    const spec = entry.palette[p]
    if (!bucket || bucket.length === 0 || !spec?.meshAsset) continue

    // DEV-898: a mesh that will not load costs THIS palette entry and nothing else. Its
    // placements are not built, so they have no collider either (an invisible rock is worse
    // than a missing one), and every other entry in the pass, first-party rocks included, is
    // drawn as usual. The warning is once per asset, not once per palette slot.
    if (missingHere.has(spec.meshAsset)) {
      skippedPlacements += bucket.length
      continue
    }
    let loaded: Awaited<ReturnType<typeof loadMesh>>
    try {
      loaded = await loadMesh(assetUrl(spec.meshAsset))
    } catch (err) {
      if (!isMeshLoadError(err)) throw err
      missingHere.add(spec.meshAsset)
      skippedPlacements += bucket.length
      warnMissingAssetOnce(spec.meshAsset, 'the scatter prop', err)
      continue
    }
    disposers.push(() => loaded.dispose())

    // Collect every renderable in the glTF. A prop is usually one mesh, but
    // nothing guarantees it, and dropping the extras would lose geometry
    // silently — the failure mode that hid the missing finish gate for a
    // whole port (DEV-045).
    const sources: THREE.Mesh[] = []
    loaded.object.updateWorldMatrix(true, true)
    loaded.object.traverse((node) => {
      const mesh = node as THREE.Mesh
      if (mesh.isMesh && mesh.geometry) sources.push(mesh)
    })
    if (sources.length === 0) continue

    // The wrapper prefab's subtree transform, converted to three space.
    childMatrixOf(spec.meshTransform, _child)
    // DEV-134: the per-kind multiplier, Anniversary's `props.scale`. 1 when the
    // preset carries nothing for this kind, which is every kind on Classic.
    const kindScaleRaw = (options.scale as Record<string, unknown> | undefined)?.[spec.kind ?? '']
    const kindScale = typeof kindScaleRaw === 'number' ? kindScaleRaw : 1

    for (const source of sources) {
      const geometry = source.geometry
      // DEV-338: rung 0 is this geometry; the coarser rungs are simplified from
      // it once, here, and shared by every culling cell of the entry.
      const rungGeometries = rungKeeps.length
        ? propRungGeometries(geometry, rungKeeps)
        : { rungs: [geometry], owned: [] }
      for (const g of rungGeometries.owned) disposers.push(() => g.dispose())
      const material = new THREE.MeshStandardMaterial({
        vertexColors: geometry.getAttribute('color') !== undefined,
        color: geometry.getAttribute('color') !== undefined ? 0xffffff : SCATTER_FALLBACK_COLOUR,
        roughness: 1,
        metalness: 0,
        // The meshes are already split per triangle (`vertexCount ===
        // indexCount` on every Materialized Mesh bake), so they are flat by
        // construction — this is belt and braces for the raw-FBX entries.
        flatShading: true,
      })
      // ── one InstancedMesh per culling CELL of the palette entry (DEV-118) ─
      //
      // `cells.ts` splits the entry over a grid; the shipped grid is one cell,
      // so this is one mesh per entry as before, and `?propCells=` opens it
      // up for a measurement. Whatever the grid, the frame is the same: same
      // instances, same matrices, same material, only the draw order differs.
      const cells = cellIndices(bucket, placed.positions, extent, options.cellsPerAxis)
      for (const cell of cells) {
        const inst = new THREE.InstancedMesh(geometry, material, cell.length)
        inst.name = `props:${spec.meshAsset?.split('/').pop() ?? 'mesh'}`
        // NOT `StaticDrawUsage` any more — DEV-225. The buffer holds the
        // compacted visible prefix and is rewritten whenever the visible chunk
        // set moves, which at flying speed is a few times a second. Telling
        // three the data never changes when it does is how a driver ends up
        // re-uploading a buffer it has pinned in immutable storage.
        inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage)

        // ── DEV-225: chunk order, so a visible set is a few block copies ────
        //
        // The batch's instances are written in `layout.order` — grouped by
        // terrain chunk, shuffled inside each — so `packVisible` can express
        // "these chunks and not those" as a prefix of one buffer. The seed is
        // the pass's, plus the palette index, so two entries of one pass do not
        // share a shuffle; it picks a DRAW ORDER only and can never move a prop.
        const layout = layoutByChunk(cell, (i) => placed.chunk[i] ?? 0, seed + p * 131)
        // DEV-338: one more mesh per coarser rung, same material, same
        // capacity, reading the same source order. Named by rung so the
        // census and a reader of `renderer.info` can tell them apart.
        const lowerRungs = rungGeometries.rungs.slice(1).map((g, r) => {
          const lower = new THREE.InstancedMesh(g, material, cell.length)
          lower.name = `${inst.name}:lod${r + 1}`
          lower.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
          return lower
        })
        const batch = createScatterBatch(inst, layout.runs, lowerRungs)

        // The source's own transform inside the glTF, for the multi-mesh case.
        const sourceMatrix = source.matrixWorld.equals(_child) ? null : source.matrix
        const out = new THREE.Matrix4()
        // The drawn bounds at scale 1, the collider's dims (DEV-136). Per source
        // mesh; the first source of a placement is the one the collider is
        // sized from, which for every shipped prop is the only one.
        const dims = dimsOf(
          geometry,
          instanceMatrixOf(0, 0, 0, 0, 1, _child, sourceMatrix, new THREE.Matrix4()),
        )
        for (let k = 0; k < layout.order.length; k++) {
          const i = layout.order[k] as number
          instanceMatrixOf(
            placed.positions[i * 3] ?? 0,
            placed.positions[i * 3 + 1] ?? 0,
            placed.positions[i * 3 + 2] ?? 0,
            placed.yaw[i] ?? 0,
            (placed.scale[i] ?? 1) * kindScale,
            _child,
            sourceMatrix,
            out,
          )
          batch.setSource(k, out)
          let slots = refs[i]
          if (!slots) {
            slots = []
            refs[i] = slots
            inputs[i] = {
              x: placed.positions[i * 3] ?? 0,
              y: placed.positions[i * 3 + 1] ?? 0,
              z: placed.positions[i * 3 + 2] ?? 0,
              scale: (placed.scale[i] ?? 1) * kindScale,
              dims,
              kind: spec.kind ?? 'prop',
            }
          }
          slots.push(scatterRef(batch, k))
        }
        const everything: DrawPlan = {
          count: layout.order.length,
          spans: [{ src: 0, dst: 0, count: layout.order.length }],
        }
        // The sphere three culls against: every instance's transformed mesh
        // sphere, which is what `InstancedMesh.computeBoundingSphere` walks.
        // Computed once, at FULL count and before anything is culled, so it
        // stays a conservative bound as the prefix shrinks — a sphere round a
        // superset can never cull something that is in view (DEV-118, DEV-225).
        //
        // EVERY rung is filled for the measurement, not only rung 0 (DEV-338):
        // a coarser rung starts empty, and a sphere computed round nothing
        // culls that rung for the life of the world.
        batch.applyRungs(batch.rungs.map(() => everything))
        for (const mesh of batch.rungs) {
          if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere()
          mesh.computeBoundingSphere()
          mesh.frustumCulled = true
          group.add(mesh)
          meshes.push(mesh)
          draws++
        }
        // Everything drawn, on rung 0, until the first `updateLod` says
        // otherwise. That is deliberately the pre-DEV-225 frame: a world that
        // loads before anyone has told it where the camera is draws the whole
        // forest rather than none of it — and at full detail, because a world
        // with no camera yet has no distance to coarsen by.
        batch.apply(everything)
        batches.push(batch)
      }
      disposers.push(() => material.dispose())
    }
  }

  return {
    group,
    // What is actually built: a placement whose mesh would not load is not counted (DEV-898).
    count: placed.count - skippedPlacements,
    draws,
    floating,
    clearedByVolumes,
    clearedBySlope,
    clearedByWater,
    inputs,
    refs,
    meshes,
    lod: createPassLod(entry, batches, placed.chunkPerSide, options),
    dispose: () => {
      for (const d of disposers) d()
    },
  }
}

/** One scatter pass's reveal: 2016's policy, over this pass's own batches. */
export interface PassLod {
  /**
   * Advance the reveal. `x`/`z` are the camera in the pass's own MESH frame,
   * `dt` the seconds since the last call. Returns how many instances are drawn
   * across the pass, or -1 when nothing moved.
   */
  step(x: number, z: number, dt: number): number
}

/**
 * Wire one pass's batches to `sim/props/lod.ts` — DEV-225.
 *
 * Per PASS and not per batch, because a chunk holds every palette entry of its
 * pass at once and 2016 kept one pool per chunk: one timer per batch and a
 * chunk's trees would arrive on a different second from its bushes.
 *
 * Returns null when the pass has no batches, and when the distance is infinite
 * — `?propLod=off`, the pre-DEV-225 frame, where the answer is "all of it"
 * every frame and running the machinery to say so is worse than not having it.
 */
export const createPassLod = (
  entry: PropScatter,
  batches: readonly ScatterBatch[],
  chunkPerSide: number,
  options: LoadPropsOptions,
): PassLod | null => {
  // 2016's own per-generator number, extracted, in the environment JSON — and
  // NEVER the C# initialiser's 300 (DEV-214, hard rule 2). `?propLod=` is the
  // measurement override and nothing else reads it.
  const lodDistance = options.lodDistance ?? entry.lodDistance
  if (batches.length === 0 || !Number.isFinite(lodDistance) || lodDistance <= 0) return null

  const rungCount = Math.max(1, ...batches.map((b) => b.rungs.length))
  const rungFrom = (options.meshLod?.rungs ?? []).slice(0, rungCount - 1).map((r) => r.from)
  const base: PropLodParams = {
    lodDistance,
    transitionSeconds: entry.lodTransitionTime,
    hysteresis: entry.flipFlopPercent,
    ...PROP_LOD_DEFAULTS,
  }
  const withRungs: PropLodParams = { ...base, rungEdges: rungFrom }
  // DEV-338: the edges are live — `enabled` is a getter, read at every scan,
  // so a flip mid-flight is honoured by the next scan. No rungs built, one
  // params object and nothing to ask.
  const paramsNow = (): PropLodParams =>
    rungFrom.length > 0 && options.meshLod?.enabled() === true ? withRungs : base
  const chunks = passChunks(
    batches.map((b) => b.runs),
    chunkPerSide,
    options.terrain.chunkSize,
  )
  if (chunks.length === 0) return null

  let rt: PropLodRuntime | null = null
  let pending = 0
  /** Per chunk id, `[from, to)` fractions for each rung, flattened at `2 * rung`. */
  const ranges = new Map<number, Float64Array>()
  const changed: number[] = []

  /** Read `rt` into the chunk-id-keyed ranges `packRange` asks for. */
  const readRanges = (): void => {
    if (!rt) return
    for (let i = 0; i < chunks.length; i++) {
      const state = rt.chunks[i]
      const meta = chunks[i]
      if (!state || !meta) continue
      let row = ranges.get(meta.chunk)
      if (!row) {
        row = new Float64Array(2 * rungCount)
        ranges.set(meta.chunk, row)
      }
      for (let r = 0; r < rungCount; r++) {
        const [from, to] = rungShare(state, r)
        row[2 * r] = state.total === 0 ? 0 : from / state.total
        row[2 * r + 1] = state.total === 0 ? 0 : to / state.total
      }
    }
  }

  /** A chunk nobody has state for draws whole on rung 0 — `packVisible`'s default. */
  const unknown = (r: number): readonly [number, number] | undefined =>
    r === 0 ? undefined : [0, 0]

  const repack = (): number => {
    let drawn = 0
    for (const batch of batches) {
      const plans: DrawPlan[] = []
      for (let r = 0; r < batch.rungs.length; r++) {
        const plan = packRange(batch.runs, (chunk) => {
          const row = ranges.get(chunk)
          return row ? [row[2 * r] as number, row[2 * r + 1] as number] : unknown(r)
        })
        plans.push(plan)
        drawn += plan.count
      }
      batch.applyRungs(plans)
    }
    return drawn
  }

  return {
    step(x, z, dt) {
      if (!rt) {
        // First call: 2016's `Start()`, from wherever the camera actually is.
        // Doing it here rather than at build is what lets the loader stay
        // ignorant of the ship — and the world still draws in full until this
        // runs, so a missed call costs frame time and never a missing forest.
        rt = initPropLod(chunks, x, z, paramsNow())
        readRanges()
        return repack()
      }
      // ── the repack is throttled to the SCAN, not to the frame ────────────
      //
      // `stepPropLod` is cheap — a loop that mostly `continue`s — but a repack
      // is a memcpy plus a buffer upload per batch, and during a 1 s staggered
      // reveal the revealed count moves EVERY frame. 2016 ran its own distance
      // scan in a coroutine at 1/30 s for the same reason; stepping at that
      // cadence with the accumulated dt gives the identical ramp in 33 ms
      // steps, which is below anything an eye resolves on a tree appearing,
      // and bounds the uploads at 30 a second instead of 90.
      pending += dt
      if (pending < base.scanIntervalSeconds) return -1
      const elapsed = pending
      pending = 0
      if (stepPropLod(rt, x, z, paramsNow(), elapsed, changed).length === 0) return -1
      readRanges()
      return repack()
    },
  }
}

/**
 * One hand-placed landmark's matrix in the TERRAIN group's frame — DEV-135.
 *
 * `landmark.position` is composed to the LevelArt root in Unity space (the
 * extractor's frame); subtracting the terrain's own local position puts it in
 * the terrain's mesh frame, and the z flip and quaternion conjugation take it
 * to three. Non-uniform scale is kept: desert's spires are authored at
 * (8.4, 9.3, 7.5) and the like.
 *
 * Which way up a spire is was settled by GEOMETRY, not by reading the FBX
 * (the orientation lesson): with the glTF as-is under the extracted rotation,
 * 13 of desert's 16 live spires put their base below the rendered ground and
 * their top 200-600 m above it; every ±90° alternative buries more tops than
 * it lifts. `tests/unit/landmarks.test.ts` keeps that measurement.
 *
 * ── There is NO glTF node matrix in it. DEV-196, and it used to take one ──
 *
 * A Unity `MeshFilter` draws the **Mesh ASSET** at its GameObject's transform,
 * and an imported mesh's vertices are NODE-LOCAL: the FBX node's own placement
 * goes on the model prefab Unity generates, which `Spire_B_w_Collision.prefab`
 * does not use — it is hand-built, a root carrying the MeshFilter, a
 * MeshCollider and the authored transform, plus two capsules. So a landmark's
 * drawn matrix is the authored transform and nothing else.
 *
 * This function used to take the mesh node's own matrix as a fourth argument
 * and post-multiply it, and `buildLandmarkGroup` handed it the one out of the
 * GLB. `tools/assets/convert-fbx.py`'s `orient_prop()` ends
 * `transform_apply(location=False, rotation=True, scale=True)` — it bakes the
 * axis conversion into the VERTICES and leaves the file's own location on the
 * object — and **the three spires are the only meshes in the bucket whose node
 * translation is non-zero**: (27.19, −35.19, 74.55) on `spire-b`, and the like.
 * Under the authored 2.9–9.3× scale that was 238–684 m of displacement on every
 * one of the seventeen live landmarks, which is eleven of desert's sixteen
 * spires buried whole and Simonet's one floating 339 m over the sea.
 *
 * **The argument is gone rather than passed as `null`**, because three call
 * sites were composing it and all three had to agree: the renderer, the
 * collider input beside it, and `tests/unit/helpers/prop-forest.ts`, which
 * exists precisely to be the renderer's numbers instead of a second guess at
 * them. A decision one call site can undo is not a decision.
 * `tests/unit/spire-pivot.test.ts` holds the result to the prefab's own
 * Unity-native capsules.
 */
export const landmarkMatrixOf = (
  landmark: PropLandmark,
  terrainLocalPosition: readonly number[],
  out: THREE.Matrix4,
): THREE.Matrix4 => {
  const p = landmark.position
  _pos.set(
    (p[0] ?? 0) - (terrainLocalPosition[0] ?? 0),
    (p[1] ?? 0) - (terrainLocalPosition[1] ?? 0),
    -((p[2] ?? 0) - (terrainLocalPosition[2] ?? 0)),
  )
  if (landmark.rotation) unityQuatTupleToThree(landmark.rotation, _quat)
  else _quat.identity()
  const s = landmark.scale ?? [1, 1, 1]
  _scale.set(s[0] ?? 1, s[1] ?? 1, s[2] ?? 1)
  out.compose(_pos, _quat, _scale)
  return out
}

/**
 * How close two authored props must be, in metres, to be THE SAME ROCK drawn
 * twice — see {@link drawnLandmarks}. DEV-218a.
 *
 * The coincident pairs are at **0.000 m** and the nearest non-coincident pair
 * `rookie_02_jumpSeat` has is **13.7 m**, so any threshold in that gap gives the
 * same answer and none of them is a tuned number. Half a metre is chosen to sit
 * far below the smallest real separation rather than near it: the value is not
 * load-bearing, and `tests/unit/mission-props.test.ts` pins the gap that makes
 * it safe so a future mission cannot quietly narrow it without a red test.
 */
export const COINCIDENT_PROP_METRES = 0.5

/** Same mesh, same place, same size — one rock authored into two files. */
const isSameProp = (a: PropLandmark, b: PropLandmark): boolean => {
  if (a.mesh !== b.mesh) return false
  const ap = a.position
  const bp = b.position
  const d = Math.hypot(
    (ap[0] ?? 0) - (bp[0] ?? 0),
    (ap[1] ?? 0) - (bp[1] ?? 0),
    (ap[2] ?? 0) - (bp[2] ?? 0),
  )
  if (d > COINCIDENT_PROP_METRES) return false
  // Scale too, so "same spot, different size" stays two props. A 0.1 % relative
  // tolerance: the extractor rounds to six decimals and the environment and the
  // mission read the same authored numbers, so real twins agree to ~1e-6.
  const as = a.scale ?? [1, 1, 1]
  const bs = b.scale ?? [1, 1, 1]
  for (let i = 0; i < 3; i++) {
    const x = as[i] ?? 1
    const y = bs[i] ?? 1
    if (Math.abs(x - y) > Math.max(1e-3, Math.abs(x) * 1e-3)) return false
  }
  return true
}

/**
 * The landmarks 2016 DREW: live, with a mesh the bucket has.
 *
 * `missionProps` are the scenery a MISSION places (DEV-218 / DEV-219). They are
 * the same shape in the same frame, so they concatenate here rather than being
 * drawn by a second path — which is what keeps "add a mission's props" a JSON
 * change. Environment first, so a mission's props layer on top in draw order.
 *
 * ── The duplicates 2016 itself drew, and why they stop here ──────────────
 *
 * `rookie_02_jumpSeat` re-instantiates `DesertSpires.prefab`, and desert's
 * `LevelArt_Desert.prefab` carries its own embedded copy of the same authored
 * field. Five of them were never moved, so 2016 drew five rocks **exactly on top
 * of themselves** — coincident geometry that z-fights rather than adding
 * anything. Matt's call (2026-09-18): **do not draw the second copy.**
 *
 * It is a DEVIATION and it is deliberate, so it lives here and not in the
 * extractor. `content/levels/*.json` still carries all sixteen authored props,
 * because that file is what 2016 HAD; this function is what the game DRAWS.
 * Deleting them at extraction time would have destroyed the provenance to fix a
 * rendering problem, and the two are not the same question (rule 9, DEV-218a).
 *
 * **It removes nothing but redundancy, and that is checked rather than assumed:**
 * a dropped prop is coincident with one already in the list, so the drawn union
 * and the collided union are unchanged — `rookie_02_jumpSeat`'s line attribution
 * reads the same 439 m of rock after this as before it. The four copies 2016
 * MOVED (13.7–50 m off) are real separate rock and are all kept, as are two that
 * are live here and switched off in the environment.
 */
export const drawnLandmarks = (
  // Only the landmark list is read, and saying so lets a test harness holding a
  // narrower shape of the environment JSON call the renderer's OWN filter rather
  // than writing a second copy of it. Optional because an environment with no
  // landmarks is a legitimate state and two of the four have none.
  env: { readonly landmarks?: readonly PropLandmark[] },
  missionProps: readonly PropLandmark[] | null = null,
): PropLandmark[] => {
  const drawn = (env.landmarks ?? []).filter((l) => l.live === true && !!l.meshAsset)
  for (const m of missionProps ?? []) {
    if (m.live !== true || !m.meshAsset) continue
    // Against what is ALREADY drawn, so a mission prop can never hide another
    // mission prop's rock — only a copy of something the world already has.
    if (drawn.some((d) => isSameProp(d, m))) continue
    drawn.push(m)
  }
  return drawn
}

/**
 * The colour a prop mesh with no vertex colours is drawn in: the scatter's
 * green, a landmark's rock. Neither path reads a glTF's own material (both
 * build their own), so for the GL palms and plants and the AxeyWorks bushes,
 * which carry none, this IS their colour.
 */
export const SCATTER_FALLBACK_COLOUR = 0x6d7f52
export const LANDMARK_FALLBACK_COLOUR = 0x8a7a66

/**
 * DEV-504: a landmark's fallback colour. A course's placed prop of a mesh the
 * islands SCATTER takes the scatter's, so a placed palm is the green the
 * island draws its palms in, not rock brown (the first photograph of a placed
 * GL palm was brown). Everything else, the landmark's.
 */
export const landmarkFallbackColour = (l: {
  readonly path?: string
  readonly meshAsset?: string | null
}): number =>
  isPlacedProp(l) && l.meshAsset && propEntryByAsset(l.meshAsset)?.from === 'scatter'
    ? SCATTER_FALLBACK_COLOUR
    : LANDMARK_FALLBACK_COLOUR

/**
 * DEV-504: the `userData` key a mesh of a course's PLACED props carries (true),
 * so the editor can find the world's copy of them and hide it while it draws
 * the draft's own (`editor/desk/props.ts`).
 */
export const PLACED_PROP_MESH = 'placedProps'
/** The prefix `buildLandmarkGroup` keys a placed prop's mesh asset under. */
const PLACED_KEY = 'placed|'

/**
 * One landmark's collider input for one of its mesh's geometries, drawn under
 * `out` (its matrix in the terrain group's frame, `landmarkMatrixOf`'s): the
 * drawn box, the hull and the triangles, exactly as `buildLandmarkGroup` makes
 * them for the flight. DEV-503: the editor builds a DRAFT's placed props'
 * colliders with it, so the props a desk judges are the props a flight hits.
 */
export const landmarkColliderInputFor = (
  landmark: PropLandmark,
  geometry: THREE.BufferGeometry,
  terrainLocalPosition: readonly number[],
  out: THREE.Matrix4 = new THREE.Matrix4(),
): PropPlacementInput => {
  landmarkMatrixOf(landmark, terrainLocalPosition, out)
  return landmarkColliderInput(
    landmark,
    drawnBoxOfVertices(geometry.getAttribute('position'), out),
    out,
    // And the SHAPE is the mesh's convex hull, because 2016's own collider
    // was the mesh (DEV-213). The cylinder survives as the cheap reject that
    // contains it.
    landmarkHullPlanes(geometry.getAttribute('position'), out),
    // And inside the hull, the rock itself: 2016's `m_Convex: 0` (DEV-345).
    // The hull alone buried two JumpSeat pads.
    landmarkTriangles(geometry.getAttribute('position'), geometry.getIndex(), out),
  )
}

const buildLandmarkGroup = async (
  env: EnvironmentProps,
  terrainLocalPosition: readonly number[],
  missionProps: readonly PropLandmark[] | null = null,
): Promise<{
  group: THREE.Group
  count: number
  draws: number
  inputs: PropPlacementInput[]
  refs: InstanceRef[][]
  meshes: THREE.InstancedMesh[]
  /** DEV-503: the ids, in `inputs`, of a course's PLACED props' colliders. */
  placedIds: number[]
  dispose: () => void
}> => {
  const group = new THREE.Group()
  group.name = 'props:landmarks'
  const placedIds: number[] = []
  /** Every `InstancedMesh` drawn here, for the shadow caster set (DEV-224). */
  const meshes: THREE.InstancedMesh[] = []
  const disposers: (() => void)[] = []
  let draws = 0
  const inputs: PropPlacementInput[] = []
  const refs: InstanceRef[][] = []
  /** DEV-898: landmarks whose mesh would not load; they are neither drawn nor counted. */
  let skippedLandmarks = 0

  // One InstancedMesh per mesh asset, so the twelve Spire_B are one draw.
  // DEV-504: a course's PLACED props in meshes of their own (keyed apart and
  // marked `PLACED_PROP_MESH`), so the editor can hide the world's copy while
  // it draws the draft's; drawn, and solid, exactly as any other landmark.
  const byAsset = new Map<string, PropLandmark[]>()
  for (const l of drawnLandmarks(env, missionProps)) {
    const key = `${isPlacedProp(l) ? PLACED_KEY : ''}${l.meshAsset as string}`
    const list = byAsset.get(key) ?? []
    list.push(l)
    byAsset.set(key, list)
  }

  for (const [key, list] of byAsset) {
    const placed = key.startsWith(PLACED_KEY)
    const asset = placed ? key.slice(PLACED_KEY.length) : key
    // One mesh holds one kind of landmark (placed or not, one asset), so the
    // first stands for the rest in choosing a fallback colour.
    const l0 = list[0] as PropLandmark
    // DEV-898: a landmark mesh that will not load is skipped with its collider (its `inputs`
    // slots are never made, so the rest of the pass's ids stay compact and nothing invisible is
    // solid). The other landmarks, and the whole scatter, are drawn as usual.
    let loaded: Awaited<ReturnType<typeof loadMesh>>
    try {
      loaded = await loadMesh(assetUrl(asset))
    } catch (err) {
      if (!isMeshLoadError(err)) throw err
      skippedLandmarks += list.length
      warnMissingAssetOnce(asset, 'the landmark', err)
      continue
    }
    disposers.push(() => loaded.dispose())
    const sources: THREE.Mesh[] = []
    loaded.object.updateWorldMatrix(true, true)
    loaded.object.traverse((node) => {
      const mesh = node as THREE.Mesh
      if (mesh.isMesh && mesh.geometry) sources.push(mesh)
    })
    for (const source of sources) {
      const geometry = source.geometry
      const material = new THREE.MeshStandardMaterial({
        vertexColors: geometry.getAttribute('color') !== undefined,
        color: geometry.getAttribute('color') !== undefined ? 0xffffff : landmarkFallbackColour(l0),
        roughness: 1,
        metalness: 0,
        flatShading: true,
      })
      const inst = new THREE.InstancedMesh(geometry, material, list.length)
      inst.name = `landmark:${placed ? 'placed:' : ''}${asset.split('/').pop() ?? 'mesh'}`
      if (placed) inst.userData[PLACED_PROP_MESH] = true // DEV-504
      inst.instanceMatrix.setUsage(THREE.StaticDrawUsage)
      inst.frustumCulled = false
      const out = new THREE.Matrix4()
      for (let k = 0; k < list.length; k++) {
        const l = list[k] as PropLandmark
        // The authored transform, and nothing from the GLB's node — DEV-196.
        landmarkMatrixOf(l, terrainLocalPosition, out)
        inst.setMatrixAt(k, out)
        // The collider (DEV-136): a landmark's scale is non-uniform and its
        // rotation is authored, so its dims are measured on the DRAWN matrix at
        // scale 1 — off the VERTICES, because under a rotation a box round the
        // mesh's box is up to 1.58x the box round the mesh — and its axis goes
        // under that box rather than at the glTF's pivot (DEV-187).
        const id = inputs.length
        refs[id] = [directRef(inst, k)]
        // The hull and the triangles too (`landmarkColliderInputFor`).
        inputs[id] = landmarkColliderInputFor(l, geometry, terrainLocalPosition, out)
        if (placed) placedIds.push(id) // DEV-503
      }
      inst.instanceMatrix.needsUpdate = true
      group.add(inst)
      meshes.push(inst)
      draws++
      disposers.push(() => material.dispose())
    }
  }

  let count = -skippedLandmarks
  for (const list of byAsset.values()) count += list.length
  return {
    group,
    count,
    draws,
    inputs,
    refs,
    meshes,
    placedIds,
    dispose: () => {
      for (const d of disposers) d()
    },
  }
}

/**
 * Load and build every scatter pass for one environment.
 *
 * Returns `null` when the environment has no prop data, which is not an error —
 * see `loadEnvironmentProps`.
 */
export const loadProps = async (
  /**
   * The environment's id — or, for a PLAYER's ground (DEV-489), its props
   * already re-scattered over that ground (`customEnvironmentProps`), which
   * are the same shape and go through every line below unchanged.
   */
  environment: string | EnvironmentProps,
  options: LoadPropsOptions,
): Promise<LoadedProps | null> => {
  const env: EnvironmentProps | null =
    typeof environment === 'string' ? await loadEnvironmentProps(environment) : environment
  if (!env) return null
  const environmentId = env.id
  // DEV-135: landmarks are drawn whether or not a scatter pass is. Classic on
  // Simonet has no scatter (its palms were never baked) and one spire.
  const landmarks =
    options.landmarks && drawnLandmarks(env, options.missionProps).length > 0
      ? await buildLandmarkGroup(env, options.landmarks.terrainLocalPosition, options.missionProps)
      : null

  const group = new THREE.Group()
  group.name = `props:${environmentId}`
  const disposers: (() => void)[] = []
  let instanceCount = 0
  let drawCalls = 0

  // DEV-102, settled by Matt 2026-09-14: Classic draws what 2016 SHIPPED and
  // Anniversary draws what 2016 SET UP. Filtered HERE rather than at the call
  // site so that `instanceCount` and `drawCalls` — the numbers the perf overlay
  // and the console line report — are the numbers actually drawn.
  const passes = options.unbakedPasses ? env.scatter : env.scatter.filter(shippedIn2016)
  if (passes.length === 0 && !landmarks) return null

  // DEV-134: the RENDERED surface, built once for every pass. It is the same
  // `buildVertexGrid` the terrain worker runs — same map, same params, same
  // seed — so the y a prop is snapped to is the y of the facet drawn under it.
  // DEV-356's slope limit asks the same grid which facet a prop stands on, so
  // either option builds it; both carry the same terrain's params.
  const surfaceParams = options.groundSnap?.params ?? options.maxSlope?.params ?? null
  const grid = surfaceParams ? buildVertexGrid(options.heightMap, surfaceParams) : null
  let floatingFixed = 0
  /** DEV-287: placements the authored volumes took out, across every pass. */
  let clearedByVolumes = 0
  /** DEV-356: placements on facets steeper than `props.maxSlope`, across every pass. */
  let clearedBySlope = 0
  /** DEV-862: placements under the sea's high-water mark, across every pass. */
  let clearedByWater = 0
  const builtPasses: { inputs: PropPlacementInput[]; refs: InstanceRef[][] }[] = []
  /** DEV-224: the scatter's meshes, in the order they were added to `group`. */
  const scatterMeshes: THREE.InstancedMesh[] = []
  /** DEV-225: one reveal per pass — alpine's two are 1920 m and 1280 m apart. */
  const passLods: PassLod[] = []

  for (const entry of passes) {
    // A different seed per pass, or alpine's two passes over ONE density map
    // would accept exactly the same texels and stack a big tree inside every
    // small one. They are meant to be two independent draws.
    //
    // Seeded on `entry.index`, which is the pass's index in the ENVIRONMENT
    // rather than in this filtered list — so alpine's surviving pass gets the
    // same seed on both presets and its 6,097 trees do not move when the
    // Anniversary pass beside it is switched off.
    const built = await buildScatterGroup(
      entry,
      options,
      (options.seed ?? 1) + entry.index * 7919,
      grid,
    )
    group.add(built.group)
    disposers.push(built.dispose)
    instanceCount += built.count
    drawCalls += built.draws
    floatingFixed += built.floating
    clearedByVolumes += built.clearedByVolumes
    clearedBySlope += built.clearedBySlope
    clearedByWater += built.clearedByWater
    builtPasses.push(built)
    scatterMeshes.push(...built.meshes)
    if (built.lod) passLods.push(built.lod)
  }

  if (landmarks) {
    group.add(landmarks.group)
    disposers.push(landmarks.dispose)
    instanceCount += landmarks.count
    drawCalls += landmarks.draws
  }

  // DEV-136: the collider ids. Scatter passes in order, then the landmarks;
  // a placement whose palette entry had no mesh is skipped, so the ids are
  // compact and every one maps to something drawn.
  const colliderInputs: PropPlacementInput[] = []
  const refsById: InstanceRef[][] = []
  const pushAll = (b: { inputs: PropPlacementInput[]; refs: InstanceRef[][] }): void => {
    for (let i = 0; i < b.inputs.length; i++) {
      const input = b.inputs[i]
      const slots = b.refs[i]
      if (!input || !slots) continue
      colliderInputs.push(input)
      refsById.push(slots)
    }
  }
  for (const b of builtPasses) pushAll(b)
  const scatterCount = colliderInputs.length
  if (landmarks) pushAll(landmarks)

  return {
    group,
    instanceCount,
    drawCalls,
    floatingFixed,
    clearedByVolumes,
    clearedBySlope,
    clearedByWater,
    landmarkCount: landmarks?.count ?? 0,
    scatterMeshes,
    landmarkMeshes: landmarks?.meshes ?? [],
    colliderInputs,
    scatterCount,
    // Landmark ids follow the scatter's, compact (`pushAll`).
    placedColliderIds: (landmarks?.placedIds ?? []).map((id) => scatterCount + id),
    mask(ids, hidden) {
      const touched = new Set<ScatterBatch>()
      for (const id of ids) {
        if (!(id >= 0 && id < scatterCount)) continue
        for (const slot of refsById[id] ?? []) {
          const batch = slot.mask?.(hidden)
          if (batch) touched.add(batch)
        }
      }
      for (const batch of touched) batch.reapply()
    },
    updateLod(camera, dt) {
      if (passLods.length === 0) return -1
      // ── world -> this group's MESH frame, in the one file that owns the flip ─
      //
      // The props hang under the terrain group, and `instanceMatrixOf` is the
      // single place the Unity->three z mirror is written down. Converting HERE
      // rather than at the call site is the same decision as
      // `groundUnderGroupPoint` below and for the same reason: a caller
      // composing `worldOffset + levelOffset + envRoot` itself is the second
      // copy of the arithmetic DEV-042 already cost a session.
      camera.getWorldPosition(_lodPoint)
      group.worldToLocal(_lodPoint)
      let drawn = -1
      for (const lod of passLods) {
        const n = lod.step(_lodPoint.x, -_lodPoint.z, dt)
        if (n >= 0) drawn = Math.max(drawn, 0) + n
      }
      return drawn
    },
    hide(id) {
      const slots = refsById[id]
      if (!slots) return
      for (const s of slots) s.hide()
    },
    drawn(id) {
      const s = refsById[id]?.[0]
      if (!s) return null
      const matrix = s.matrix(new THREE.Matrix4())
      return { geometry: s.inst.geometry, material: s.inst.material as THREE.Material, matrix }
    },
    dispose: () => {
      for (const d of disposers) d()
    },
  }
}

/** Re-exported so callers building a height sampler do not import two modules. */
export { grayscale, importUnityTexture }

/**
 * The ground under a point in the TERRAIN GROUP's frame, metres. DEV-148.
 *
 * `instanceMatrixOf` above is the one place the mesh->group flip is written
 * down — `_pos.set(x, y, -z)`, Unity +z to three -z — so the inverse belongs
 * beside it rather than at a call site that would be re-deriving it. Anything
 * DRAWN under the terrain group and asking "where is the hill under me"
 * (DEV-148's fracture pieces, and whatever lands next) goes through here.
 *
 * The RENDERED surface, at LOD 0: the jittered vertex grid the chunks were
 * built from. NOT `terrainHeightAt`, which is the collision field without the
 * jitter — they differ by up to `randomOffset` per vertex and resting a
 * visible object on the invisible one is DEV-134's floating forest.
 */
export const groundUnderGroupPoint =
  (grid: SurfaceGrid, heightMap: MapSampler, params: FacetedTerrainParams) =>
  (x: number, z: number): number =>
    renderSurfaceHeightAt(grid, heightMap, params, x, -z)
