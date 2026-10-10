// src/render/horizon-geo.ts — a far shore of paper-cut ridges where the sea
// used to meet the sky in a line.
//
// DEV-119. Matt: *"our game could use 'horizon geo' similar to what we do in
// king-tide"*. 2016 had none: at 9:25 of the gameplay video (frame `f0565`,
// the launch pad at sunset) the faceted dome comes down to a hard flat line
// where the matte sea vanishes into the fog, and every Simonet frame from
// 9:50 to 15:00 (`s0059`–`s0090`) is the same. So this is ANNIVERSARY-only,
// behind `render.horizonGeo`, and Classic keeps the line.
//
// ── What king-tide's ring does, and what is taken from it ────────────────
//
// `src/engine/render/horizon-ring.ts` in king-tide: one closed drape of 192
// columns, two vertices each, the top edge shaped by five octaves of sines,
// 1,400 m out and 300 m high, its XZ re-centred on the player every frame
// with y pinned to sea level, coloured from the sky's horizon and darkened
// toward the peaks, fogged by the scene, one draw call. What is taken is the
// PLACEMENT — a ring that follows the eye so its distance never changes, sits
// at sea level, and lets the fog do the dissolving — and the one-draw-call
// discipline. What is NOT taken is the smooth sine drape and the numbers: the
// register here is a paper-cut world (ART_DIRECTION pillars 1, 2 and 5), so
// the silhouette is cut from flat cards with hard creases and one colour per
// face, and the ring is sized to a 4 km island under a 6 km far plane rather
// than a 512 m track.
//
// ── The geometry ─────────────────────────────────────────────────────────
//
// Two bands of columns round the eye. Each column is one flat quad from a
// base under the sea to a ridge height, two triangles, its own four vertices,
// ONE colour — so every crease between columns is hard and every card is one
// colour, which is the terrain's own rule (DEV-014) applied to the far field.
// The ridge is not noise: it is the upper envelope of a handful of triangular
// MOUNTAIN CARDS at seeded angles, each with its own half-width and height,
// sampled at the columns. Overlapping cards make compound peaks; gaps make
// low saddles where the sea shows through to the sky. The outer band is the
// far range; the inner band, at four fifths of the radius and about half the
// height, is a nearer line of hills. Both are fogged by the mission's own
// fog per fragment, so the nearer band comes out darker and the farther one
// paler, which is the depth cue — nothing here shades, lights or textures.
//
// ── Colour ───────────────────────────────────────────────────────────────
//
// A card's colour is the mission SKY behind it, darkened: the sky's own
// radiance at the horizon in that column's direction (the nine SH
// coefficients the dome is painted from, `lighting.sky.sh`; the fog colour
// where a mission has none), times `silhouette`. Land seen against the sky at
// five kilometres is a cut-out of that sky's colour, and deriving it from the
// mission's own sky rather than authoring a colour keeps pillar 4: the sun
// and the fog are the mission's. A per-card jitter of a few percent — the
// sky dome's `facetJitter` and the terrain's `randomOffset`, the same idea —
// is what makes neighbouring cards read as cards. Cards that face the sun
// take a little of the sun's colour, king-tide's forward-scatter cue.
//
// ── Where it sits, and what can go wrong ─────────────────────────────────
//
// `radius` is the one geometric number to argue with. It must clear the far
// plane (6,000 m, `render/renderer.ts` D18) from the highest seat, and it
// must sit past the island: `int_01`'s course keeps the ship within its
// 2,047 m boundary of a 4 km island, so from the boundary's far side the
// island's far hills are up to ~6 km away and a 5.2 km ring passes THROUGH
// them. The ring is depth-tested, so a hill in front hides it, but where the
// two intersect the ring's cards cut the hillside at half fog. That is the
// open question for Matt (DEV-119 §4); the mitigation built in is that the
// ring's base sits 120 m under the sea and its peaks are low on the sky.

import * as THREE from 'three'
import type { EditionHorizonGeo } from '@/content/edition-schema'
import type { EditionState } from '@/game/edition'
import { makeRandom } from '@/sim/terrain/faceted'

/** Columns round the ring: 2.5 degrees each, twice the dome's 1.4 degree cells. */
export const HORIZON_COLUMNS = 144
/** The inner band's radius and height, as fractions of the outer band's. */
export const INNER_RADIUS = 0.8
export const INNER_HEIGHT = 0.55
/** How far under the reference level the cards are anchored, metres. */
export const BASE_DROP = 120
/** Mountain cards per band: enough for a range, few enough for saddles. */
export const CARDS_PER_BAND = 13
/** Per-card brightness jitter, +/- this fraction. The sky dome uses 0.06. */
export const CARD_JITTER = 0.07
/** How much of the sun's colour a card that faces it takes, at most. */
export const SUN_WARMTH = 0.22

export interface HorizonWorld {
  /** World y the ridges stand on: sea level, or a valley floor where there is no sea. */
  readonly referenceY: number
  /** Unit vector the sun TRAVELS along, three space. `lighting.sun.direction`. */
  readonly sunDirection: readonly [number, number, number]
  /** Linear rgb of the sun. */
  readonly sunColor: readonly [number, number, number]
  /**
   * Linear rgb of the sky at the horizon in direction (dx, dz), three space.
   * The dome's SH where the mission has it, the fog colour otherwise.
   */
  horizonColor(dx: number, dz: number, out: { r: number; g: number; b: number }): void
  /** Fixed per mission, so two loads give the same shore. */
  readonly seed: number
}

/**
 * The ridge heights of one band at `columns` angles, as fractions of 1.
 *
 * The upper envelope of `cards` triangular cards: each has a centre angle, a
 * half-width in radians and a height in (0.35, 1], all from the seed. Pure,
 * so a unit test can hold it to its bounds and its determinism.
 */
export const horizonProfile = (
  columns: number,
  seed: number,
  cards: number = CARDS_PER_BAND,
): Float32Array => {
  const rnd = makeRandom(seed)
  const centres: number[] = []
  const halfWidths: number[] = []
  const heights: number[] = []
  for (let c = 0; c < cards; c++) {
    centres.push(rnd() * Math.PI * 2)
    // 6 to 20 degrees of arc: at 5.2 km that is 550 m to 1.8 km across a card.
    halfWidths.push(((6 + rnd() * 14) * Math.PI) / 180)
    heights.push(0.35 + rnd() * 0.65)
  }
  const profile = new Float32Array(columns)
  for (let i = 0; i < columns; i++) {
    const theta = (i / columns) * Math.PI * 2
    let h = 0
    for (let c = 0; c < cards; c++) {
      // Angular distance to the card's centre, wrapped.
      let d = Math.abs(theta - (centres[c] as number))
      if (d > Math.PI) d = Math.PI * 2 - d
      const w = halfWidths[c] as number
      if (d < w) {
        const t = 1 - d / w
        const v = (heights[c] as number) * t
        if (v > h) h = v
      }
    }
    profile[i] = h
  }
  return profile
}

/** One band's worth of columns, appended to the position/colour arrays. */
const appendBand = (
  positions: number[],
  colors: number[],
  radius: number,
  baseY: number,
  peak: number,
  profile: Float32Array,
  world: HorizonWorld,
  spec: EditionHorizonGeo,
  rnd: () => number,
  rgb: { r: number; g: number; b: number },
): void => {
  const columns = profile.length
  const sx = world.sunDirection[0]
  const sz = world.sunDirection[2]
  // The direction the sun's light comes FROM, projected onto the ground.
  const sunLen = Math.hypot(sx, sz) || 1
  const fromX = -sx / sunLen
  const fromZ = -sz / sunLen
  for (let i = 0; i < columns; i++) {
    const a0 = (i / columns) * Math.PI * 2
    const a1 = ((i + 1) / columns) * Math.PI * 2
    const mid = (a0 + a1) / 2
    const ox = Math.cos(mid)
    const oz = Math.sin(mid)
    const h0 = baseY + (profile[i] as number) * peak
    const h1 = baseY + (profile[(i + 1) % columns] as number) * peak

    // Colour: the sky behind this card, darkened, jittered, warmed toward the sun.
    world.horizonColor(ox, oz, rgb)
    const jitter = 1 + (rnd() * 2 - 1) * CARD_JITTER
    const facing = Math.max(0, ox * fromX + oz * fromZ)
    const warm = facing * facing * facing * SUN_WARMTH
    const dark = spec.silhouette * jitter
    const r = Math.min(1, Math.max(0, rgb.r * dark * (1 - warm) + world.sunColor[0] * warm * dark))
    const g = Math.min(1, Math.max(0, rgb.g * dark * (1 - warm) + world.sunColor[1] * warm * dark))
    const b = Math.min(1, Math.max(0, rgb.b * dark * (1 - warm) + world.sunColor[2] * warm * dark))

    // Four corners on the ring, in three space (x = r cos, z = r sin).
    const x0 = Math.cos(a0) * radius
    const z0 = Math.sin(a0) * radius
    const x1 = Math.cos(a1) * radius
    const z1 = Math.sin(a1) * radius
    // Two triangles wound so the face points INWARD, at the eye at the centre.
    // The first draft walked (bottom0, top0, top1) and faced OUT — every one
    // of 370 cards, measured by `horizon-geo.test.ts` from the vertices, which
    // is why the order below is the one the test passes and not the one the
    // comment believed (the orientation lesson, DEVIATIONS.md).
    positions.push(x0, baseY, z0, x1, h1, z1, x0, h0, z0)
    positions.push(x0, baseY, z0, x1, baseY, z1, x1, h1, z1)
    for (let k = 0; k < 6; k++) colors.push(r, g, b)
  }
}

/**
 * Build the ring's geometry: non-indexed, split vertices, one colour per
 * column quad, both bands in one buffer.
 */
export const buildHorizonGeometry = (
  spec: EditionHorizonGeo,
  world: HorizonWorld,
  columns: number = HORIZON_COLUMNS,
): THREE.BufferGeometry => {
  const positions: number[] = []
  const colors: number[] = []
  const rgb = { r: 0, g: 0, b: 0 }
  const baseY = world.referenceY - BASE_DROP
  const outer = horizonProfile(columns, world.seed)
  const inner = horizonProfile(columns, world.seed + 1)
  const rnd = makeRandom(world.seed + 2)
  appendBand(
    positions,
    colors,
    spec.radius,
    baseY,
    BASE_DROP + spec.peakMetres,
    outer,
    world,
    spec,
    rnd,
    rgb,
  )
  appendBand(
    positions,
    colors,
    spec.radius * INNER_RADIUS,
    baseY,
    BASE_DROP + spec.peakMetres * INNER_HEIGHT,
    inner,
    world,
    spec,
    rnd,
    rgb,
  )
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geometry.computeBoundingSphere()
  return geometry
}

export interface HorizonGeo {
  readonly object: THREE.Mesh
  /** The material, for `applyAtmosphere`: the fog is what dissolves the ring. */
  readonly material: THREE.Material
  /**
   * Centre the ring on the eye's x and z. WORLD position — the camera is under
   * the XR rig, so `camera.position` is the head pose, not the eye (trap 18).
   * Takes no orientation and must not grow one: the ring is world-locked.
   */
  update(eyeWorld: Readonly<THREE.Vector3>): void
  dispose(): void
}

/**
 * The far shore for one mission. Built once per world; a preset flip rebuilds
 * the geometry (a few hundred vertices) and shows or hides the mesh.
 */
export const createHorizonGeo = (editionState: EditionState, world: HorizonWorld): HorizonGeo => {
  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    // Wound inward, so the front face is the one the eye sees. Not double —
    // a card seen from outside is a card the ring is not for.
    side: THREE.FrontSide,
    // World geometry, depth-tested like the island: a hill in front hides it.
    // It is a thing in the world and IS tone-mapped (ART_DIRECTION, the glow
    // rule). three's own fog is off because `applyAtmosphere` supplies the
    // mission's, the same as every other fogged material here.
    fog: false,
  })
  let spec = editionState.current.render.horizonGeo
  const mesh = new THREE.Mesh(buildHorizonGeometry(spec, world), material)
  mesh.name = 'horizon-geo'
  // Surrounds the eye, so a sphere test would always pass; skip it.
  mesh.frustumCulled = false
  mesh.visible = spec.enabled
  mesh.castShadow = false
  mesh.receiveShadow = false

  const unsubscribe = editionState.subscribe((edition) => {
    const next = edition.render.horizonGeo
    if (
      next.radius !== spec.radius ||
      next.peakMetres !== spec.peakMetres ||
      next.silhouette !== spec.silhouette
    ) {
      mesh.geometry.dispose()
      mesh.geometry = buildHorizonGeometry(next, world)
    }
    spec = next
    mesh.visible = next.enabled
  })

  return {
    object: mesh,
    material,
    update(eyeWorld) {
      mesh.position.set(eyeWorld.x, 0, eyeWorld.z)
    },
    dispose() {
      unsubscribe()
      mesh.geometry.dispose()
      material.dispose()
    },
  }
}
