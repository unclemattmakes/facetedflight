// src/render/start-deck.ts — 2016's start deck, with a lift under every pad (DEV-549).
//
// Matt, 2026-09-30, answering DEV-461's call — *"port 2016's deck with an
// opening per pad"*: *"sure"*. And the fiction it serves (DEV-461): *"racers
// commute to the next mission space via underground networks. they rise via
// elevators at the launch point."* A pad is the top of a lift; the launch point
// is a built deck with lifts in it.
//
// ── What 2016 drew, and what FF2 drew until now ───────────────────────────
//
// 2016's deck is nine PolyWorld Woodland floor tiles (`Floor_A`..`D`, scale
// 6.857, 17.1 m a side and 1.7 m thick) over a Materialized-Mesh kitbash
// (`MM_Corner_Short_01`: the frame and the footings, 97 x 22 x 62 m, down into
// the sea). Its three `startingPlatform_collision` cubes are the walking
// surface, and their renderers are OFF — so FF2's grey slabs (`start-grid.ts`)
// were 2016's invisible colliders, drawn. Once this file's art lands the slabs
// hide, as 2016's did; they stay the fallback if it never does.
//
// One tile cell is empty on every deck: the lift's. 2016 stood its tenth tile
// at the sea, inside the shaft (`spawn.startGrid.artInShaft`), where the lift
// rises through it; the port does not draw it (`tools/extract/level.mjs`).
//
// ── The openings ──────────────────────────────────────────────────────────
//
// Every pad on the deck stands in an opening: the deck is cut down the pad's
// own footprint, grown by `COLUMN_MARGIN` — `lift-seal.ts`'s `trimColumn`, the
// cut DEV-460 makes down the lift's column in 2016's shaft — and the opening is
// lined with a WELL, `WELL_DEPTH` deep, in the deck's own colour. The pad is
// the car at the top of its lift. Every other pad waits `ARRIVAL_DROP` metres
// down its well and comes up with the player's (DEV-553, which made DEV-461's
// `?arrival=rise` the behaviour), and not through the deck.
//
// ── One draw, and no new program ──────────────────────────────────────────
//
// Every tile, the moulding and the wells are baked into ONE world-space
// geometry at load — 1,500 triangles on a deck — in ONE material:
// `MeshStandardMaterial` with vertex colours, which is the program the pads'
// `Projector04_Mat` already compiles (`hover-glow.ts`'s `projectorMaterial`:
// vertex colours, no maps). Marmoset's Diffuse IBL has no specular, so roughness
// 1. Flat-shaded the way the pads are not: by face normals baked into a
// non-indexed geometry, rather than `flatShading`, which is a define and so a
// second program.

import * as THREE from 'three'
import { COLUMN_MARGIN, grownHull, hullXZ, trimColumn, type Xz } from './lift-seal'

/** 2016's deck art, one GLB of five mesh-local parts (`tools/assets/convert-start-deck.mjs`). */
export const START_DECK_MESH = 'assets/hangar/start-deck.glb'

/** The deck's mesh, by name: what a spec or a census reads. */
export const START_DECK_ART = 'start-deck-2016'

/** The parts the GLB carries, in the names `spawn.startGrid.art[].part` uses. */
export const START_DECK_PARTS = Object.freeze([
  'floor-a',
  'floor-b',
  'floor-c',
  'floor-d',
  'moulding',
] as const)

/**
 * Metres every other pad waits under its start while the player's lift comes
 * up (DEV-553), and so how far it rises with it.
 */
export const ARRIVAL_DROP = 4.5

/**
 * Metres an opening's well reaches under the deck's top: a pad lowered by
 * `ARRIVAL_DROP`, a pad's height (the lift's dish, 1.67 m) under that, and a
 * metre more, so the well's foot is under a waiting pad's.
 */
export const WELL_DEPTH = ARRIVAL_DROP + 1.67 + 1

/** One of 2016's deck renderers: a part, at its node's world pose (three space). */
export interface DeckPlacement {
  readonly part: string
  readonly pos: readonly number[]
  readonly quat: readonly number[]
  readonly scale: readonly number[]
}

/** A placed tile: its footprint (world x/z, convex, counter-clockwise) and its top. */
export interface DeckTile {
  readonly hull: readonly Xz[]
  readonly top: number
}

/** A floor tile, as opposed to the moulding under them. */
export const isTile = (part: string): boolean => part.startsWith('floor-')

/**
 * Every placement baked into one world-space, non-indexed geometry of position
 * and colour. Throws on a part the file does not carry, or a mirrored node
 * (none on any deck; a negative scale would turn its faces inside out here).
 */
export const placeDeck = (
  parts: ReadonlyMap<string, THREE.BufferGeometry>,
  art: readonly DeckPlacement[],
): { geometry: THREE.BufferGeometry; tiles: DeckTile[]; top: number } => {
  const positions: number[] = []
  const colors: number[] = []
  const tiles: DeckTile[] = []
  let top = Number.NEGATIVE_INFINITY
  const m = new THREE.Matrix4()
  const v = new THREE.Vector3()
  for (const a of art) {
    const source = parts.get(a.part)
    if (!source) throw new Error(`start-deck: the deck file carries no part '${a.part}'`)
    m.compose(
      new THREE.Vector3().fromArray(a.pos as number[]),
      new THREE.Quaternion().fromArray(a.quat as number[]),
      new THREE.Vector3().fromArray(a.scale as number[]),
    )
    if (m.determinant() <= 0) throw new Error(`start-deck: '${a.part}' is mirrored or flat`)
    const flat = source.index ? source.toNonIndexed() : source
    const p = flat.getAttribute('position')
    const c = flat.getAttribute('color')
    const footprint: Xz[] = []
    let tileTop = Number.NEGATIVE_INFINITY
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m)
      positions.push(v.x, v.y, v.z)
      if (c) colors.push(c.getX(i), c.getY(i), c.getZ(i))
      else colors.push(1, 1, 1)
      if (isTile(a.part)) {
        footprint.push({ x: v.x, z: v.z })
        tileTop = Math.max(tileTop, v.y)
      }
    }
    if (isTile(a.part)) {
      tiles.push({ hull: hullXZ(footprint), top: tileTop })
      top = Math.max(top, tileTop)
    }
    if (flat !== source) flat.dispose()
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  return { geometry, tiles, top }
}

/** Is `p` inside the convex, counter-clockwise polygon? */
export const insideConvex = (polygon: readonly Xz[], p: Xz): boolean => {
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i] as Xz
    const b = polygon[(i + 1) % polygon.length] as Xz
    if ((b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x) < 0) return false
  }
  return polygon.length >= 3
}

/**
 * Each pad's opening, world x/z: the hull of what the pad DRAWS (its visible
 * meshes — 2016's dish once dressed, the octagon before), grown by
 * `COLUMN_MARGIN`. Read off the meshes, never off `size`: the dish's footprint
 * stands 0.2 m off its node's origin, and an opening centred on the origin would
 * leave a crescent of deck under one side of the rim.
 */
export const padOpenings = (pads: readonly THREE.Object3D[]): Xz[][] => {
  const v = new THREE.Vector3()
  return pads.map((pad) => {
    pad.updateWorldMatrix(true, true)
    const points: Xz[] = []
    pad.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh || (!mesh.visible && mesh !== pad)) return
      const p = mesh.geometry.getAttribute('position')
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld)
        points.push({ x: v.x, z: v.z })
      }
    })
    return points.length >= 3 ? grownHull(hullXZ(points), COLUMN_MARGIN) : []
  })
}

/**
 * The well down an opening: its walls from the top of the tile they stand in
 * (2016's tiles differ by up to 0.3 m) to `WELL_DEPTH` under the deck's top,
 * both faces, along every stretch of the opening's edge that stands inside a
 * tile — an edge out over the sea (a slot pad at the deck's rim) is not walled.
 * Steps of at most half a metre along each edge.
 */
export const wellGeometry = (
  opening: readonly Xz[],
  deckTop: number,
  tiles: readonly DeckTile[],
  colour: readonly [number, number, number],
): { positions: number[]; colors: number[] } => {
  const positions: number[] = []
  const colors: number[] = []
  const bottom = deckTop - WELL_DEPTH
  const quad = (a: Xz, b: Xz, top: number) => {
    const corners = [
      [a.x, top, a.z],
      [b.x, top, b.z],
      [b.x, bottom, b.z],
      [a.x, bottom, a.z],
    ] as const
    for (const [i, j, k] of [
      [0, 1, 2],
      [0, 2, 3],
      [0, 2, 1],
      [0, 3, 2],
    ] as const) {
      for (const n of [i, j, k]) {
        positions.push(...(corners[n] as readonly number[]))
        colors.push(colour[0], colour[1], colour[2])
      }
    }
  }
  for (let e = 0; e < opening.length; e++) {
    const a = opening[e] as Xz
    const b = opening[(e + 1) % opening.length] as Xz
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.5))
    for (let s = 0; s < steps; s++) {
      const p = { x: a.x + ((b.x - a.x) * s) / steps, z: a.z + ((b.z - a.z) * s) / steps }
      const q = {
        x: a.x + ((b.x - a.x) * (s + 1)) / steps,
        z: a.z + ((b.z - a.z) * (s + 1)) / steps,
      }
      const mid = { x: (p.x + q.x) / 2, z: (p.z + q.z) / 2 }
      const tile = tiles.find((t) => insideConvex(t.hull, mid))
      if (tile) quad(p, q, tile.top)
    }
  }
  return { positions, colors }
}

/** The mean colour of the deck's upward faces near its top: the wells wear it. */
const topColourOf = (geometry: THREE.BufferGeometry, top: number): [number, number, number] => {
  const p = geometry.getAttribute('position')
  const c = geometry.getAttribute('color')
  let n = 0
  let r = 0
  let g = 0
  let b = 0
  for (let i = 0; i < p.count; i++) {
    if (top - p.getY(i) > 0.3) continue
    r += c.getX(i)
    g += c.getY(i)
    b += c.getZ(i)
    n++
  }
  return n === 0 ? [0.3, 0.3, 0.3] : [r / n, g / n, b / n]
}

/** The deck's material: vertex colour, no specular — the pads' program (see the header). */
export const deckMaterial = (): THREE.MeshStandardMaterial => {
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1,
    metalness: 0,
  })
  material.name = 'PW-Woodland'
  return material
}

export interface StartDeck {
  /** The deck, one mesh named `START_DECK_ART`, in world space. */
  readonly object: THREE.Mesh
  /** Each pad's opening, in the order the pads were given. */
  readonly openings: readonly (readonly Xz[])[]
  /** The deck's walking surface: the highest point of any tile. */
  readonly top: number
  /** Every tile's footprint and top, as placed. */
  readonly tiles: readonly DeckTile[]
  dispose(): void
}

/**
 * 2016's deck from `start-deck.glb`'s scene (`art` — the caller loaded it and
 * disposes it; the geometry is copied), placed by `placements`, an opening cut
 * and lined under every one of `pads`. `prepare` sees the material before
 * anything draws it.
 */
export const createStartDeck = (
  art: THREE.Object3D,
  placements: readonly DeckPlacement[],
  pads: readonly THREE.Object3D[],
  prepare?: (material: THREE.Material) => void,
): StartDeck => {
  art.updateMatrixWorld(true)
  const parts = new Map<string, THREE.BufferGeometry>()
  for (const name of START_DECK_PARTS) {
    const mesh = art.getObjectByName(name) as THREE.Mesh | undefined
    if (!mesh?.isMesh) throw new Error(`start-deck: the deck file has no mesh named ${name}`)
    parts.set(name, mesh.geometry)
  }
  const placed = placeDeck(parts, placements)
  const openings = padOpenings(pads)
  let geometry = placed.geometry
  for (const opening of openings) {
    if (opening.length < 3) continue
    const cut = trimColumn(geometry, opening)
    if (cut !== geometry) geometry.dispose()
    geometry = cut
  }
  const colour = topColourOf(geometry, placed.top)
  const wells = openings.map((o) =>
    o.length >= 3 ? wellGeometry(o, placed.top, placed.tiles, colour) : null,
  )
  const positions = Array.from(geometry.getAttribute('position').array as ArrayLike<number>)
  const colors = Array.from(geometry.getAttribute('color').array as ArrayLike<number>)
  for (const w of wells) {
    if (!w) continue
    positions.push(...w.positions)
    colors.push(...w.colors)
  }
  geometry.dispose()
  const deck = new THREE.BufferGeometry()
  deck.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  deck.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  // Non-indexed: every corner takes its own face's normal, which is the facet.
  deck.computeVertexNormals()
  deck.computeBoundingBox()
  deck.computeBoundingSphere()
  const material = deckMaterial()
  prepare?.(material)
  const object = new THREE.Mesh(deck, material)
  object.name = START_DECK_ART
  return {
    object,
    openings,
    top: placed.top,
    tiles: placed.tiles,
    dispose() {
      deck.dispose()
      material.dispose()
      object.removeFromParent()
    },
  }
}
