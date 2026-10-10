// src/render/parked-glow.ts: the parked hangar jet's nose glow, scaled down (DEV-562).
//
// Matt, 2026-10-01, in the hangar: *"glow on nose/mouth of the ship needs to be
// scaled down a bit, it's interpenetrating the ship."* It is. The wing's glow
// (`render/hover-glow.ts`, `Mesh2-Combined`) is ten separate pieces in one
// mesh, and the fore-most is a round one in the jet's mouth, under the nose. At
// 2016's size it is bigger than the mouth: it shows through the chin's facets
// as a bright wedge, and a sliver of it pokes out through the hull beside it
// (`docs/DEVIATIONS.md` DEV-562 has the photographs).
//
// ── The parked jet only, the nose piece only ─────────────────────────────
//
// `hover-glow.ts` and `game/ship-wings.ts` are shared with the flown jet, the
// AI racers and the ghosts, and the brief was the hangar's jet: so this runs on
// the parked jet's own copy of the glow geometry and on nothing else. That is
// safe because `loadMesh` caches nothing (`boot/app.ts` says so of the hull):
// every `attachShipWings` parses its own geometry. And it scales the ONE piece
// that interpenetrates, each vertex toward that piece's own centroid, so the
// piece shrinks where it stands; the six projector discs and the three engine
// discs are untouched (they sit in their housings, and nobody asked).
//
// The nose piece is found, not indexed: split the mesh into connected parts by
// welded position (as `tools/assets/unity-mesh-asset.mjs`'s `connectedParts`
// does), and take the one whose centroid lies furthest along the hull's NOSE
// direction in the GLB's own frame. That direction is the ship's forward (−z),
// turned back through `SHIP_MODEL_YAW`, the art's own yaw: +x in the GLB.
//
// The factor was chosen by photograph, not arithmetic (`PARKED_NOSE_GLOW_SCALE`).

import * as THREE from 'three'
import { SHIP_MODEL_YAW } from '@/game/flight'
import { HOVER_GLOW_NAMES } from './hover-glow'

/**
 * How much of 2016's size the parked jet's nose glow keeps (DEV-562). The one
 * number to argue with: chosen from a photographed sweep, see the row.
 */
export const PARKED_NOSE_GLOW_SCALE = 0.7

/** The hull GLB's nose, in its own frame: the ship's forward (−z) turned back through the art's yaw. */
export const glbNose = (): THREE.Vector3 =>
  new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), -SHIP_MODEL_YAW)

/** One connected piece of a mesh: its vertex indices and its centroid. */
export interface GlowPiece {
  readonly vertices: readonly number[]
  readonly centroid: THREE.Vector3
}

/** Split an indexed geometry into its connected pieces, welding vertices by position. */
export const glowPieces = (geometry: THREE.BufferGeometry, eps = 1e-4): GlowPiece[] => {
  const p = geometry.getAttribute('position')
  const n = p.count
  const weld = new Map<string, number>()
  const node = new Int32Array(n)
  for (let v = 0; v < n; v++) {
    const k = `${Math.round(p.getX(v) / eps)},${Math.round(p.getY(v) / eps)},${Math.round(p.getZ(v) / eps)}`
    let id = weld.get(k)
    if (id === undefined) {
      id = weld.size
      weld.set(k, id)
    }
    node[v] = id
  }
  const parent = Array.from({ length: weld.size }, (_, i) => i)
  const find = (a: number): number => {
    let r = a
    while (parent[r] !== r) {
      parent[r] = parent[parent[r] as number] as number
      r = parent[r] as number
    }
    return r
  }
  const index = geometry.getIndex()
  const count = index ? index.count : n
  const at = (k: number) => (index ? index.getX(k) : k)
  for (let t = 0; t + 2 < count; t += 3) {
    const a = find(node[at(t)] as number)
    for (const k of [1, 2]) {
      const b = find(node[at(t + k)] as number)
      if (a !== b) parent[b] = a
    }
  }
  const groups = new Map<number, number[]>()
  for (let v = 0; v < n; v++) {
    const r = find(node[v] as number)
    let group = groups.get(r)
    if (!group) {
      group = []
      groups.set(r, group)
    }
    group.push(v)
  }
  return [...groups.values()].map((vertices) => {
    const centroid = new THREE.Vector3()
    for (const v of vertices) centroid.x += p.getX(v)
    for (const v of vertices) centroid.y += p.getY(v)
    for (const v of vertices) centroid.z += p.getZ(v)
    return { vertices, centroid: centroid.divideScalar(vertices.length) }
  })
}

/**
 * Shrink the nose piece of the glow under `ship` (a parked `SHIP_MESH_EXTERIOR`
 * object carrying its wing) toward its own centroid by `factor`. Returns the
 * piece it scaled, or null where the jet carries no glow (a wing that did not
 * load). Edits the parked jet's own geometry in place: call it on the parked
 * jet and nothing else.
 */
export const shrinkParkedNoseGlow = (
  ship: THREE.Object3D,
  factor: number = PARKED_NOSE_GLOW_SCALE,
): GlowPiece | null => {
  const glow = ship.getObjectByName(HOVER_GLOW_NAMES[1]) as THREE.Mesh | undefined
  if (!glow?.isMesh) return null
  const geometry = glow.geometry
  const pieces = glowPieces(geometry)
  if (pieces.length === 0) return null
  const nose = glbNose()
  const fore = pieces.reduce((m, q) => (q.centroid.dot(nose) > m.centroid.dot(nose) ? q : m))
  const p = geometry.getAttribute('position')
  const c = fore.centroid
  for (const v of fore.vertices) {
    p.setXYZ(
      v,
      c.x + (p.getX(v) - c.x) * factor,
      c.y + (p.getY(v) - c.y) * factor,
      c.z + (p.getZ(v) - c.z) * factor,
    )
  }
  p.needsUpdate = true
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return fore
}
