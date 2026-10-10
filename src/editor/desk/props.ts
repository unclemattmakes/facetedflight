// src/editor/desk/props.ts — a course's placed props, drawn on the desk.
// DEV-504 (docs/plan/EDITOR-PROPS.md, "Editor UI (desk)").
//
// The desk's world is the SKY's (or, after a Fly, the last playtest's), never
// the draft's, so the draft's props are drawn here, live, as they are edited.
// They are drawn by the FLIGHT's own path, not a likeness of it: the course's
// `level.props` as the expansion makes them (`playerCourseProps`), each through
// `load-props.ts`'s `landmarkMatrixOf` under the land terrain group's own
// world matrix — the one chain `buildLandmarkGroup` hangs a landmark under in
// flight — with every mesh of the glTF and the landmark's own material. So
// where a prop stands and which way it faces on the desk is where it stands
// and faces when the course is flown; `editor-props.spec.ts` reads both and
// compares them.
//
// One `InstancedMesh` per mesh asset (a cactus garden is one draw), each asset
// loaded once. Picked by a RAY at the meshes themselves, with every layer
// enabled on it (DEV-472: bloom re-layers `toneMapped: false` meshes, and a
// raycaster tests layer 0 alone). The picked prop wears a box.
//
// The world's OWN copy of a placed prop — present after a Fly, whose world is
// the course's — is hidden while the desk draws its own (`hideWorldCopies`),
// or a moved prop would stand twice.
//
// ── Seating: the FOOTPRINT, not the pivot ─────────────────────────────────
//
// The island stands a scattered plant on the ground at its pivot, and for a
// plant that is right: its trunk is a metre across. A spire's base is ~290 m
// across (Spire_B at desert's 8.4 x 9.3 x 7.5), and a pivot on a cliff top
// left most of it standing on air over the sea — the first photograph of this
// row. So a prop is seated at the LOWEST ground under its base (`baseRadius`:
// the drawn vertices in the bottom tenth of it), less the preset's sink:
// buried where the ground falls away, as desert's own spires are, never
// floating. For a plant the base is its trunk, and the seat is the island's.

import * as THREE from 'three'
import { assetUrl } from '@/content/asset-url'
import type { MissionProp } from '@/content/level-schema'
import { PLACED_PROP_PATH } from '@/content/prop-library'
import {
  landmarkColliderInputFor,
  landmarkFallbackColour,
  landmarkMatrixOf,
  PLACED_PROP_MESH,
} from '@/game/props/load-props'
import { terrainLocalPosition } from '@/game/terrain/load-terrain'
import { loadMesh } from '@/render/load-mesh'
import type { PropPlacementInput } from '@/sim/props/collision'
import type { DeskTerrains } from './host'

interface AssetPart {
  readonly geometry: THREE.BufferGeometry
  readonly material: THREE.MeshStandardMaterial
  mesh: THREE.InstancedMesh | null
}

interface AssetMeshes {
  readonly parts: AssetPart[]
  /** `course.props` index of each instance, in instance order. */
  index: number[]
  /** The union of the parts' bounds, for the picked prop's box. */
  readonly bounds: THREE.Box3
}

/**
 * DEV-504: how far a prop's BASE reaches from its pivot, metres in plan: the
 * furthest of the drawn vertices (`positions` under `matrix`, world space) that
 * stand in the bottom tenth of the drawn height (at least `minBand` metres of
 * it), measured from `pivot` (x, z). Zero with no vertices.
 */
export const baseRadius = (
  positions: ArrayLike<number>,
  matrix: THREE.Matrix4,
  pivot: { readonly x: number; readonly z: number },
  minBand = 1,
): number => {
  const v = new THREE.Vector3()
  const n = Math.floor(positions.length / 3)
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  const ys = new Float64Array(n)
  const xs = new Float64Array(n)
  const zs = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    v.set(
      positions[i * 3] as number,
      positions[i * 3 + 1] as number,
      positions[i * 3 + 2] as number,
    )
    v.applyMatrix4(matrix)
    xs[i] = v.x
    ys[i] = v.y
    zs[i] = v.z
    if (v.y < minY) minY = v.y
    if (v.y > maxY) maxY = v.y
  }
  const band = Math.max(minBand, (maxY - minY) / 10)
  let r = 0
  for (let i = 0; i < n; i++) {
    if ((ys[i] as number) > minY + band) continue
    r = Math.max(r, Math.hypot((xs[i] as number) - pivot.x, (zs[i] as number) - pivot.z))
  }
  return r
}

/**
 * DEV-504: the pivot's height for a prop whose base reaches `radius` metres:
 * the LOWEST ground you see at the pivot and at eight points round it at that
 * radius, less `sink`. Null where there is no ground at all.
 */
export const footprintSeat = (
  surfaceAt: (x: number, z: number) => number,
  x: number,
  z: number,
  radius: number,
  sink: number,
): number | null => {
  let low = surfaceAt(x, z)
  if (!Number.isFinite(low)) return null
  if (radius > 0) {
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4
      const g = surfaceAt(x + radius * Math.cos(a), z + radius * Math.sin(a))
      if (Number.isFinite(g)) low = Math.min(low, g)
    }
  }
  return low - sink
}

export interface DeskProps {
  readonly object: THREE.Group
  /**
   * Draw `props` (the course's `level.props`, in `course.props` order) over
   * `terrains`' land group; `picked` wears a box.
   */
  set(props: readonly MissionProp[], terrains: DeskTerrains | null, picked: number | null): void
  /** The `course.props` index under a pick ray, or null. */
  pick(ray: THREE.Raycaster): number | null
  /** Where the desk draws prop `index`, world space: its matrix, or null. */
  drawnMatrix(index: number): THREE.Matrix4 | null
  /** The picked prop's box as drawn, world space, or null. */
  pickedBox(): THREE.Box3 | null
  /** How many props the desk draws now (an asset still loading draws none). */
  drawn(): number
  /**
   * How far `landmark`'s base reaches from `pivot` in plan, drawn over
   * `terrains`' land (`baseRadius`); null while its mesh is still loading
   * (which `preload` starts).
   */
  footprint(
    landmark: MissionProp,
    pivot: { readonly x: number; readonly z: number },
    terrains: DeskTerrains | null,
  ): number | null
  /** Start loading a mesh asset, so a prop of it can be seated by its base when placed. */
  preload(asset: string): void
  /**
   * The mesh asset, loaded: resolves true once `footprint` can measure a prop
   * of it, false if it will never load (then a prop of it seats at its pivot).
   * Starts the load. A prop must not be SEATED before this settles: while the
   * mesh is loading `footprint` is null, and a seat taken then stands on the
   * pivot's ground alone — the race behind `editor-props.spec.ts`'s one red.
   */
  ready(asset: string): Promise<boolean>
  /** Hide the world's own copies of placed props (after a Fly); how many meshes it hid. */
  hideWorldCopies(terrains: DeskTerrains | null): number
  /**
   * DEV-503: the collider inputs of the props last `set`, in the terrain's
   * mesh frame, made as the flight makes a landmark's
   * (`landmarkColliderInputFor`): one per mesh of each prop whose asset has
   * loaded. `complete` is false while any is still loading.
   */
  colliderInputs(): { readonly inputs: PropPlacementInput[]; readonly complete: boolean }
  /** DEV-503: is a mesh of the props last `set` still loading? */
  pending(): boolean
  dispose(): void
}

export const createDeskProps = (): DeskProps => {
  const object = new THREE.Group()
  object.name = 'editor-props'
  const assets = new Map<string, AssetMeshes | 'loading' | 'failed'>()
  const box = new THREE.Box3Helper(new THREE.Box3(), 0xffe066)
  box.name = 'editor-prop-picked'
  box.visible = false
  object.add(box)
  let last: {
    props: readonly MissionProp[]
    terrains: DeskTerrains | null
    picked: number | null
  } = { props: [], terrains: null, picked: null }
  const matrices: (THREE.Matrix4 | null)[] = []
  /** DEV-533: each standing prop's collider inputs, by ground and transform (`colliderInputs`). */
  let builtInputs = new Map<string, PropPlacementInput[]>()

  /** One settle per asset: true loaded, false failed. */
  const settled = new Map<string, Promise<boolean>>()
  const load = (asset: string): void => {
    if (assets.has(asset)) return
    assets.set(asset, 'loading')
    let settle: (ok: boolean) => void = () => {}
    settled.set(
      asset,
      new Promise<boolean>((resolve) => {
        settle = resolve
      }),
    )
    void loadMesh(assetUrl(asset)).then(
      (loaded) => {
        // Every renderable in the glTF, as `buildLandmarkGroup` draws them all,
        // in the fallback colour it gives a PLACED prop of this mesh.
        const fallback = landmarkFallbackColour({ path: PLACED_PROP_PATH, meshAsset: asset })
        const parts: AssetPart[] = []
        const bounds = new THREE.Box3()
        loaded.object.traverse((n) => {
          const m = n as THREE.Mesh
          if (!m.isMesh || !m.geometry) return
          const geometry = m.geometry
          const hasColour = geometry.getAttribute('color') !== undefined
          // `buildLandmarkGroup`'s material, so the desk's prop is the flight's.
          const material = new THREE.MeshStandardMaterial({
            vertexColors: hasColour,
            color: hasColour ? 0xffffff : fallback,
            roughness: 1,
            metalness: 0,
            flatShading: true,
          })
          if (!geometry.boundingBox) geometry.computeBoundingBox()
          bounds.union(geometry.boundingBox as THREE.Box3)
          parts.push({ geometry, material, mesh: null })
        })
        if (parts.length === 0) {
          assets.set(asset, 'failed')
          settle(false)
          return
        }
        assets.set(asset, { parts, index: [], bounds })
        redraw()
        settle(true)
      },
      (err: unknown) => {
        console.warn(`editor: the prop mesh ${asset} did not load`, err)
        assets.set(asset, 'failed')
        settle(false)
      },
    )
  }

  const _m = new THREE.Matrix4()
  const redraw = (): void => {
    const { props, terrains, picked } = last
    matrices.length = 0
    const land = terrains?.land ?? null
    const tl = land ? terrainLocalPosition(land.key) : null
    if (land) land.group.updateWorldMatrix(true, false)
    const byAsset = new Map<string, number[]>()
    props.forEach((p, i) => {
      matrices[i] = null
      if (!p.meshAsset) return
      load(p.meshAsset)
      const list = byAsset.get(p.meshAsset) ?? []
      list.push(i)
      byAsset.set(p.meshAsset, list)
      if (land && tl) {
        matrices[i] = land.group.matrixWorld.clone().multiply(landmarkMatrixOf(p, tl, _m))
      }
    })
    for (const [asset, entry] of assets) {
      if (typeof entry === 'string') continue
      const list = land && tl ? (byAsset.get(asset) ?? []) : []
      entry.index = list
      for (const part of entry.parts) {
        if (!part.mesh || part.mesh.instanceMatrix.count < list.length) {
          if (part.mesh) {
            object.remove(part.mesh)
            part.mesh.dispose()
            part.mesh = null
          }
          if (list.length === 0) continue
          const mesh = new THREE.InstancedMesh(
            part.geometry,
            part.material,
            Math.max(8, list.length * 2),
          )
          mesh.name = `editor-prop:${asset.split('/').pop() ?? 'mesh'}`
          mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
          part.mesh = mesh
          object.add(mesh)
        }
        const mesh = part.mesh
        mesh.count = list.length
        list.forEach((i, k) => {
          const m = matrices[i]
          if (m) mesh.setMatrixAt(k, m)
        })
        mesh.instanceMatrix.needsUpdate = true
        mesh.computeBoundingSphere()
        mesh.computeBoundingBox()
      }
    }
    // The picked prop's box: its asset's bounds under its drawn matrix.
    const pm = picked === null ? null : (matrices[picked] ?? null)
    const pa = picked === null ? null : props[picked]?.meshAsset
    const pe = pa ? assets.get(pa) : undefined
    if (pm && pe && typeof pe !== 'string') {
      box.box.copy(pe.bounds).applyMatrix4(pm)
      box.visible = true
    } else {
      box.visible = false
    }
  }

  const targets = (): THREE.InstancedMesh[] => {
    const out: THREE.InstancedMesh[] = []
    for (const e of assets.values()) {
      if (typeof e === 'string') continue
      for (const p of e.parts) if (p.mesh && p.mesh.count > 0) out.push(p.mesh)
    }
    return out
  }

  return {
    object,
    set(props, terrains, picked) {
      last = { props, terrains, picked }
      redraw()
    },
    pick(ray) {
      // DEV-472: every layer, whatever bloom did to these meshes.
      ray.layers.enableAll()
      const hit = ray.intersectObjects(targets(), false)[0]
      if (!hit || hit.instanceId === undefined) return null
      for (const e of assets.values()) {
        if (typeof e === 'string') continue
        if (e.parts.some((p) => p.mesh === hit.object)) return e.index[hit.instanceId] ?? null
      }
      return null
    },
    footprint(landmark, pivot, terrains) {
      const e = landmark.meshAsset ? assets.get(landmark.meshAsset) : undefined
      const land = terrains?.land
      if (!e || typeof e === 'string' || !land) return null
      land.group.updateWorldMatrix(true, false)
      const m = land.group.matrixWorld
        .clone()
        .multiply(landmarkMatrixOf(landmark, terrainLocalPosition(land.key), new THREE.Matrix4()))
      let r = 0
      for (const part of e.parts) {
        const pos = part.geometry.getAttribute('position')
        if (!pos) continue
        // Through the accessor, not `.array`: an interleaved or quantised
        // attribute's array is not x, y, z in a row.
        const xyz = new Float32Array(pos.count * 3)
        for (let i = 0; i < pos.count; i++) {
          xyz[i * 3] = pos.getX(i)
          xyz[i * 3 + 1] = pos.getY(i)
          xyz[i * 3 + 2] = pos.getZ(i)
        }
        r = Math.max(r, baseRadius(xyz, m, pivot))
      }
      return r
    },
    preload(asset) {
      load(asset)
    },
    ready(asset) {
      load(asset)
      return settled.get(asset) ?? Promise.resolve(false)
    },
    drawnMatrix(index) {
      return matrices[index]?.clone() ?? null
    },
    pickedBox() {
      return box.visible ? box.box.clone() : null
    },
    drawn() {
      let n = 0
      for (const e of assets.values()) if (typeof e !== 'string') n += e.index.length
      return n
    },
    pending() {
      return last.props.some((p) => !!p.meshAsset && assets.get(p.meshAsset) === 'loading')
    },
    colliderInputs() {
      const { props, terrains } = last
      const land = terrains?.land ?? null
      const tl = land ? terrainLocalPosition(land.key) : null
      const inputs: PropPlacementInput[] = []
      let complete = true
      if (!tl) return { inputs, complete: props.length === 0 }
      // DEV-533: one prop's hull and triangles are ~0.1–2.4 ms (the tall
      // cactus), and this runs on every evaluation, so a prop is built once
      // per (ground, mesh, transform) and kept while it stands. Without it a
      // course near the file ceiling of 1,024 rebuilt seconds of hulls per
      // edit; with it an edit builds the props it moved.
      const ground = `${land?.key}|${tl.join(',')}`
      const kept = new Map<string, PropPlacementInput[]>()
      for (const p of props) {
        const entry = p.meshAsset ? assets.get(p.meshAsset) : undefined
        if (!entry || entry === 'loading') {
          complete = false
          continue
        }
        if (entry === 'failed') continue
        const key = `${ground}|${JSON.stringify(p)}`
        let built = kept.get(key) ?? builtInputs.get(key)
        if (!built) {
          built = entry.parts.map((part) => landmarkColliderInputFor(p, part.geometry, tl))
        }
        kept.set(key, built)
        inputs.push(...built)
      }
      builtInputs = kept
      return { inputs, complete }
    },
    hideWorldCopies(terrains) {
      let n = 0
      terrains?.land.group.traverse((node) => {
        if (node.userData[PLACED_PROP_MESH] === true && node.visible) {
          node.visible = false
          n++
        }
      })
      return n
    },
    dispose() {
      for (const e of assets.values()) {
        if (typeof e === 'string') continue
        for (const p of e.parts) {
          p.mesh?.dispose()
          p.material.dispose()
        }
      }
      assets.clear()
      box.dispose()
    },
  }
}
