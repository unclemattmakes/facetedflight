// src/editor/desk/ground.ts — the RENDER surface, in the level's frame, for the
// editor core's warnings and for placing a point. DEV-469.
//
// DEV-468's `Ground.surfaceAt(x, z)` is the height of what you can SEE at
// level-frame x, z. So it is built from `renderSurfaceHeightAt` over the
// jittered vertex grid the chunks were cut from (`LoadedTerrain.surfaceGrid`,
// LOD 0), never from `heightField`, which is the surface you HIT and misses
// what you see by up to 21.8 m on steep desert (CLAUDE.md, DEV-288).
//
// ── Three frames, and the one conversion ──────────────────────────────────
//
// level frame (THREE world) --inverse(group.matrixWorld)--> the terrain GROUP's
// frame --(x, y, -z)--> the terrain's MESH frame, where x and z run
// 0..terrainSize and `renderSurfaceHeightAt` answers. The group carries the
// island's offset and, for the sea, its 8x scale (`load-terrain.ts` sets both
// on the group), so composing its matrix covers every environment without a
// rule per island — the agreement lesson's cure (DEVIATIONS; DEV-042). The
// z flip is `load-props.ts`'s `groundUnderGroupPoint`, the one place it is
// written; this file composes that function rather than restating it.
//
// ── Land, and sea ─────────────────────────────────────────────────────────
//
// Over the sea the land's render surface is the SEABED, and a ring at seabed
// plus clearance is under water. What you see there is the sea, so the answer
// is the higher of the two: the land where its extent covers the point, the
// sea's own faceted surface where there is one. Outside both there is nothing
// to see, and the answer is −∞, which no warning's arithmetic can mistake for
// ground.
//
// ── Which sea: the HIGH-water mark (DEV-501 follow-up) ────────────────────
//
// The drawn sea moves: 2016's whole-plate bob (±3.459 m on Simonet) and a
// per-vertex wave (up to 4 m) ride on its rest surface. The collision surface
// does not (the plate's `heightField` is built once, at rest). So the sea the
// editor judges against is the rest surface plus the most the two ever lift it
// (`LoadedTerrain.highWater`): a pure function of the terrain, never of the
// frame the ground was built in (reading the live transform put one seed's new
// pad on a shore in one run and 1.3 km inland in the next), and never lower
// than the sea anyone will see. A pad on a seeded shore at 116-117 m sat under
// a sea drawn up to 120 at the top of every wave.

import * as THREE from 'three'
import type { Ground } from '@/editor/core'
import type { DeskTerrains } from '@/editor/desk/host'
import { groundUnderGroupPoint } from '@/game/props/load-props'
import type { LoadedTerrain } from '@/game/terrain/load-terrain'

/**
 * The terrain group's world matrix AT REST: its own transform with its y put
 * back to `restY`, under its parent's. DEV-501 follow-up: a water plate's
 * group carries 2016's whole-plate bob (`setWaveTime`, ±3.459 m on Simonet)
 * and moves every frame, so its live `matrixWorld` is the sea at whatever
 * phase the frame that built the ground happened to have — the same seed's
 * new pad then stood on the shore in one run and on a plateau 1.3 km away in
 * the next, as the sea over that shore came and went. The ground is a
 * function of the terrain, not of the clock.
 */
const restMatrix = (terrain: LoadedTerrain): THREE.Matrix4 => {
  const group = terrain.group
  group.updateWorldMatrix(true, false)
  const y = Number.isFinite(terrain.restY) ? terrain.restY : group.position.y
  const local = new THREE.Matrix4().compose(
    new THREE.Vector3(group.position.x, y, group.position.z),
    group.quaternion,
    group.scale,
  )
  return group.parent ? group.parent.matrixWorld.clone().multiply(local) : local
}

/** One terrain's render surface in the level frame, AT REST, or −∞ outside its extent. */
export const terrainSurface = (terrain: LoadedTerrain): ((x: number, z: number) => number) => {
  const toWorld = restMatrix(terrain)
  const toGroup = toWorld.clone().invert()
  const inGroup = groundUnderGroupPoint(terrain.surfaceGrid, terrain.heightMap, terrain.params)
  const size = terrain.params.terrainSize
  const p = new THREE.Vector3()
  return (x: number, z: number): number => {
    p.set(x, 0, z).applyMatrix4(toGroup)
    // The group frame's z is the mesh frame's −z (see the header).
    const meshX = p.x
    const meshZ = -p.z
    if (!(meshX >= 0 && meshX <= size && meshZ >= 0 && meshZ <= size)) {
      return Number.NEGATIVE_INFINITY
    }
    p.y = inGroup(p.x, p.z)
    return p.applyMatrix4(toWorld).y
  }
}

/**
 * The ground the editor core measures against: the higher of the land and the
 * sea. DEV-500: with `waterY` (a course's water, world metres) the sea IS that
 * flat surface — the plate the world built is moved there, and the game's sea
 * is a crash surface (`game/terrain/course-water.ts`), so a ring under it is
 * buried and a pad on it is on the water. Read from the course, not the plate,
 * so a level being dragged is judged before the world is built again.
 */
export const deskGround = (terrains: DeskTerrains, waterY: number | null = null): Ground => {
  const land = terrainSurface(terrains.land)
  // DEV-501 follow-up: the HIGH-water mark — the plate at rest plus the most
  // its bob and wave ever lift it (`highWater`), the same number at any frame.
  // A course's water is that plate moved, so it rises the same.
  const rise =
    terrains.ocean && Number.isFinite(terrains.ocean.highWater) ? terrains.ocean.highWater : 0
  const rest =
    waterY !== null && Number.isFinite(waterY)
      ? () => waterY
      : terrains.ocean
        ? terrainSurface(terrains.ocean)
        : null
  const sea = rest && rise > 0 ? (x: number, z: number) => rest(x, z) + rise : rest
  return landAndSea(land, sea)
}

/** The higher of a land surface and a sea surface, and where the sea shows. Pure. */
export const landAndSea = (
  land: (x: number, z: number) => number,
  sea: ((x: number, z: number) => number) | null,
): Ground => ({
  surfaceAt: (x: number, z: number): number => {
    const l = land(x, z)
    return sea ? Math.max(l, sea(x, z)) : l
  },
  // DEV-475: the sea is what you see where its resting plane stands over
  // the land (or where there is no land to see).
  waterAt: (x: number, z: number): boolean => {
    if (!sea) return false
    const s = sea(x, z)
    return Number.isFinite(s) && s >= land(x, z)
  },
})
