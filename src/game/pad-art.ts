// src/game/pad-art.ts — jump pads, drawn as the red-and-white target they were.
//
// Matt, 2026-09-16: *"the old jumpseat landing pads were visually red and white,
// like a practice target."* They were — the 2016 gameplay video at 1:06
// (`f0510.jpg`) shows a cream octagonal dish, a red bullseye octagon lettered
// "100", a cream ring lettered "50" in red, a red outer band, a grey riser
// between the tiers. (DEV-121.)
//
// ── What gets drawn: the COLLIDER, in 2016's colours ──────────────────────
//
// The pad you land on (DEV-120) is a stepped octagonal bowl read off
// `jumpPad_04_collider.fbx` into `level.pads[].solid` as a radial profile.
// The visible 2016 pad — `jumpPad_04.fbx`'s six sub-meshes under `jumpPad_04
// (1)`, at the same transform as the collider — is the same shape dressed:
// `target_center` / `target_mid` / `target_outer` are the three tier floors and
// `ring_inner` / `ring_mid` / `jumpPad_bottom` are the risers and underside.
// So this lathes the collider profile round its eight sides and paints the
// tiers. What you see is exactly what you land on, one colour per facet, no
// texture (ART_DIRECTION pillar 2), and not one vertex is invented: every
// radius and height comes out of the JSON.
//
// ── The colours are 2016's materials, not ours ────────────────────────────
//
// `target_jumppad.prefab`, `MeshRenderer.m_Materials`, `_Color` (Unity gamma):
//
//   target_center   mat_jumpPad_100.mat   (0.838, 0,     0    )   red
//   target_mid      mat_jumpPad_50.mat    (0.875, 0.875, 0.875)   cream
//   target_outer    mat_jumpPad_25.mat    (0.838, 0,     0    )   red
//   ring_inner/mid  Meshes/Materials/lambert3.mat  (0.257 grey)   risers
//   jumpPad_bottom  lambert3.mat                                  underside
//   (on a hit)      Jump Pads/Activated.mat  (0.251, 0.875, 0.359) green
//
// `Trigger_JumpTarget.OnTriggerEnter` swaps `jumpPad_renderer`'s material to
// `triggered_materials[i]`, and `jumpPad_renderer` is `target_mid` on all 17
// plates while all three slots hold `Activated.mat` — so ANY plate hit turns
// the cream 50-ring green, and that is what `takeZone` does here. The plates
// themselves are invisible triggers in 2016 and are not drawn.
//
// The painted numbers ("100", "50", "25" — `canvas_scoreLabels`, Unity UI Text
// on a font this port may not carry) and the 385 m green beacon beam
// (`jumpPad_03.fbx`, `jumpPad_beacon.mat`) are NOT here; see DEV-121's row.

import * as THREE from 'three'
import type { Level, PadSolid } from '@/content/level-schema'
import { livePads, padZones } from '@/game/targets'

/** 2016's `_Color` values, sRGB as Unity stored them. Exported for the test. */
export const PAD_PALETTE = {
  bullseye: [0.83823526, 0, 0],
  mid: [0.875, 0.875, 0.875],
  outer: [0.83823526, 0, 0],
  riser: [0.25735295, 0.25735295, 0.25735295],
  activated: [0.2509191, 0.875, 0.3585193],
} as const

type Rgb = readonly [number, number, number]

/** Linear-space colour from a Unity gamma `_Color`. */
const linear = (rgb: Rgb): THREE.Color =>
  new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace)

/**
 * A profile segment is a FLOOR when it is flat over a real width. The shipped
 * profile's three tiers are exactly level; its lips rise 15–25 cm over
 * 5–25 cm of radius and its risers are steep, so 2 cm of rise per metre and
 * half a metre of width separate the two cleanly. A geometric classification
 * threshold, not a game constant.
 */
const FLOOR_MAX_SLOPE = 0.02
const FLOOR_MIN_WIDTH = 0.5

export interface PadGeometry {
  readonly geometry: THREE.BufferGeometry
  /** Vertex index range [start, end) of the cream 50-ring, for the hit recolour. */
  readonly midRange: readonly [number, number]
}

/**
 * Lathe the collider profile round its n sides, one colour per tier.
 *
 * Non-indexed, so every facet has its own vertices and the creases stay hard;
 * normals are computed per face. Local frame is the collider NODE's — a vertex
 * of the n-gon on local +x, which is how the mesh is authored (measured in
 * `tools/extract/pad-solid.mjs`) — and the mesh takes the node's world pose.
 */
export const buildPadGeometry = (solid: PadSolid): PadGeometry => {
  const n = solid.symmetry
  const profile = solid.profile
  const positions: number[] = []
  const colours: number[] = []

  // Tier floors, lowest first: 100 / 50 / 25.
  const floors: { i: number; y: number }[] = []
  for (let i = 0; i + 1 < profile.length; i++) {
    const [r0, y0] = profile[i] as [number, number]
    const [r1, y1] = profile[i + 1] as [number, number]
    const dr = r1 - r0
    if (dr >= FLOOR_MIN_WIDTH && Math.abs(y1 - y0) <= FLOOR_MAX_SLOPE * dr)
      floors.push({ i, y: y0 })
  }
  floors.sort((a, b) => a.y - b.y)
  const tierColour = new Map<number, Rgb>()
  const tierNames: (keyof typeof PAD_PALETTE)[] = ['bullseye', 'mid', 'outer']
  floors.forEach((f, k) => {
    tierColour.set(
      f.i,
      PAD_PALETTE[tierNames[Math.min(k, tierNames.length - 1)] as keyof typeof PAD_PALETTE],
    )
  })
  const midSegment = floors[1]?.i ?? -1

  const riser = linear(PAD_PALETTE.riser)
  const push = (p: THREE.Vector3, c: THREE.Color) => {
    positions.push(p.x, p.y, p.z)
    colours.push(c.r, c.g, c.b)
  }
  const ring = (r: number, y: number, k: number): THREE.Vector3 => {
    const a = (k / n) * Math.PI * 2
    return new THREE.Vector3(r * Math.cos(a), y, r * Math.sin(a))
  }
  const _n = new THREE.Vector3()
  const _ab = new THREE.Vector3()
  const _ac = new THREE.Vector3()
  /** Emit triangle a-b-c wound so its face normal agrees with `want`. */
  const tri = (
    a: THREE.Vector3,
    b: THREE.Vector3,
    c: THREE.Vector3,
    want: THREE.Vector3,
    col: THREE.Color,
  ) => {
    _ab.subVectors(b, a)
    _ac.subVectors(c, a)
    _n.crossVectors(_ab, _ac)
    if (_n.dot(want) < 0) {
      push(a, col)
      push(c, col)
      push(b, col)
    } else {
      push(a, col)
      push(b, col)
      push(c, col)
    }
  }

  let midRange: [number, number] = [0, 0]
  const band = (r0: number, y0: number, r1: number, y1: number, col: THREE.Color) => {
    // Surface normal in the (radial, y) plane: perpendicular to the profile
    // tangent, upward for a floor, inward for a riser, outward for the skirt.
    const dr = r1 - r0
    const dy = y1 - y0
    for (let k = 0; k < n; k++) {
      const a = ring(r0, y0, k)
      const b = ring(r0, y0, k + 1)
      const c = ring(r1, y1, k + 1)
      const d = ring(r1, y1, k)
      const mid = (k + 0.5) / n
      const want = new THREE.Vector3(
        -dy * Math.cos(mid * Math.PI * 2),
        dr,
        -dy * Math.sin(mid * Math.PI * 2),
      )
      if (r0 > 0) tri(a, b, c, want, col)
      tri(a, c, d, want, col)
    }
  }

  for (let i = 0; i + 1 < profile.length; i++) {
    const [r0, y0] = profile[i] as [number, number]
    const [r1, y1] = profile[i + 1] as [number, number]
    if (r1 === r0 && y1 === y0) continue
    const tier = tierColour.get(i)
    const col = tier ? linear(tier) : riser
    const start = positions.length / 3
    band(r0, y0, r1, y1, col)
    if (i === midSegment) midRange = [start, positions.length / 3]
  }

  // The outer skirt down to the underside, and the underside itself.
  const [rLast, yLast] = profile[profile.length - 1] as [number, number]
  if (solid.bottom < yLast) band(rLast, yLast, rLast, solid.bottom, riser)
  const centre = new THREE.Vector3(0, solid.bottom, 0)
  const down = new THREE.Vector3(0, -1, 0)
  for (let k = 0; k < n; k++) {
    tri(centre, ring(rLast, solid.bottom, k), ring(rLast, solid.bottom, k + 1), down, riser)
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3))
  geometry.computeVertexNormals()
  return { geometry, midRange }
}

export interface LoadedPads {
  readonly object: THREE.Object3D
  /** Live pads. */
  readonly count: number
  /**
   * A plate has been taken: the pad's cream 50-ring turns `Activated` green,
   * as 2016's `jumpPad_renderer` swap did. `index` is into `padZones(level)`.
   */
  takeZone(index: number): void
  dispose(): void
}

/**
 * The pad's material: the vertex colours ARE the paint (2016's `_Color`s, laid
 * on per tier by {@link buildPadGeometry}), faceted, lit.
 *
 * A factory since DEV-354, so the flight-plan table's one large target wears the
 * world's material rather than a second description of it. A new material per
 * call, so each owner disposes its own.
 */
export const padMaterial = (): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.55,
    metalness: 0,
  })

export const loadPads = (level: Level): LoadedPads => {
  const pads = livePads(level)
  const zones = padZones(level)
  const material = padMaterial()
  const group = new THREE.Group()
  group.name = 'pads'
  // Indexed by position in `livePads(level)`, which is what `zone.pad` indexes.
  const meshes = new Map<number, { mesh: THREE.Mesh; midRange: readonly [number, number] }>()
  pads.forEach((pad, padIndex) => {
    const solid = pad.solid
    if (!solid?.live) return
    const { geometry, midRange } = buildPadGeometry(solid)
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = `pad-${pad.i}`
    mesh.position.set(solid.pos[0], solid.pos[1], solid.pos[2])
    mesh.quaternion.set(solid.quat[0], solid.quat[1], solid.quat[2], solid.quat[3])
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)
    meshes.set(padIndex, { mesh, midRange })
  })

  const activated = linear(PAD_PALETTE.activated)
  return {
    object: group,
    count: pads.length,
    takeZone(index: number) {
      const zone = zones[index]
      if (!zone) return
      const entry = meshes.get(zone.pad)
      if (!entry) return
      const colour = entry.mesh.geometry.getAttribute('color') as THREE.BufferAttribute
      for (let v = entry.midRange[0]; v < entry.midRange[1]; v++) {
        colour.setXYZ(v, activated.r, activated.g, activated.b)
      }
      colour.needsUpdate = true
    },
    dispose() {
      for (const { mesh } of meshes.values()) mesh.geometry.dispose()
      material.dispose()
    },
  }
}
