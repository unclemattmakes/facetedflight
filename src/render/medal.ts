// src/render/medal.ts — the medal that spins over a finished course's table.
//
// Matt, 2026-09-15: *"when a course is finished - it's medal should be displayed
// in the menu on it's holo table. (the 2016 game had them floating above the
// terrain table)"*
//
// 2016 does it with `Slot_Medal.cs` on `missionSelect_holoTable.prefab`: read the
// medal string out of PlayerPrefs, instantiate `medal_<Tier>.prefab` under the
// slot at unit scale, yaw it 55 deg/s from a random start. The medal is the
// TITLE EMBLEM — `logo_polys.fbx`'s `logo_top` and `logo_bottom`, the same two
// meshes `render/title.ts` stands in the valley — in one tinted material per
// tier. So the port builds it out of the logo glTF it already loads, and every
// number below is the sheet's (`PROPS.medals`, DEV-113), not this file's.
//
// ── Where it sits, as a RATIO of the table ──────────────────────────────────
//
// 2016's slot is at (0, 0.523, 0.252) over a table whose top is 0.466 m up and
// whose footprint is 0.501 x 0.548 m; the emblem hangs a further 0.046 m up
// inside the slot. The port's tables are 0.50 m across — the same width to
// four parts in a thousand — so the offsets carry almost 1:1, but they carry as
// a ratio of the table width regardless, so a wider table in a later room moves
// its medal with it (`medalPlacement`).
//
// ── What is deliberately NOT ported ─────────────────────────────────────────
//
//  * `medal_missing.prefab`: silver at 7.2 % alpha through a glass shader, on
//    every unflown course. At 0.077 m and 1.5 m, on a Quest, that is a smudge
//    nobody can read as anything, and the orientation lesson (§5c) says a thing
//    too small or too dim to see has been rendered, not reviewed. An unflown
//    table simply has no medal, which is what the smudge was trying to say.
//  * `medal_lead.prefab`: exists, and 2016 never writes "Lead" to PlayerPrefs
//    (`LevelEnd.cs:198`), so no table ever showed it. Nor here.
//
// Render-side only. The spin is on the frame clock and the start yaw is
// `Math.random()`, both of which `src/sim/` may not touch and neither of which
// the sim needs.

import * as THREE from 'three'
import type { EditionMedalOutline } from '@/content/edition-schema'
import type { MedalTier } from '@/game/best-medal'
import { PROPS } from '@/generated/constants.generated'
import { srgbToLinear } from '@/render/unity-space'
import { turntableYaw } from './turntable'

const SHEET = PROPS.medals

/** Radians per second, about the slot's own vertical. `Slot_Medal.cs` `Update()`. */
export const MEDAL_SPIN = (SHEET.spinDegPerSecond * Math.PI) / 180

/** The random start yaw's ceiling, radians. `Random.RandomRange(0, 270)` on enable. */
export const MEDAL_START_YAW_MAX = (SHEET.startYawMaxDeg * Math.PI) / 180

export interface MedalPlacement {
  /** Horizontal distance from the table's axis to the medal's axis, metres. */
  readonly out: number
  /** From the table's TOP to the emblem's origin, metres. */
  readonly lift: number
  /** Per-axis scale on the emblem mesh. 2016's slot is stretched 1.129 in y. */
  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
}

/**
 * 2016's slot geometry, rescaled to a table whose half-extent — from its axis
 * to its edge, on the side the medal stands — is `tableHalfExtent` metres.
 *
 * Every term is the sheet's: the slot transform and the emblem's child
 * transform off the prefabs, and the table mesh's own bounds times the
 * `holotable` node's scale for the 2016 top and edge. 2016's slot is offset
 * along the table's z, so the ratio is taken along THAT axis: the slot stands
 * at 0.252 m of a 0.274 m half-depth, 92 % of the way to the edge, and the
 * emblem's outer lip overhangs it by a millimetre and a half. One ratio — port
 * half-extent over 2016's — multiplies all three outputs, so the medal is the
 * same fraction of its table it was.
 */
export const medalPlacement = (tableHalfExtent: number): MedalPlacement => {
  const table = SHEET.table
  const slot = SHEET.slot
  const emblem = SHEET.emblem
  const halfDepth2016 = table.extent[2] * table.scale[2]
  const top2016 = (table.center[1] + table.extent[1]) * table.scale[1]
  const k = tableHalfExtent / halfDepth2016
  return {
    out: Math.hypot(slot.position[0], slot.position[2]) * k,
    lift: (slot.position[1] - top2016 + emblem.position[1] * slot.scale[1]) * k,
    scale: {
      x: slot.scale[0] * emblem.scale[0] * k,
      y: slot.scale[1] * emblem.scale[1] * k,
      z: slot.scale[2] * emblem.scale[2] * k,
    },
  }
}

/** The tier's `_Color`, sRGB in the sheet, linear for the material. */
export const medalColour = (tier: MedalTier): THREE.Color => {
  const c = SHEET.colors[tier]
  return new THREE.Color(srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2]))
}

/**
 * The emblem's material for a tier.
 *
 * Same reading `render/title.ts` gives the logo: 2016's `Marmoset Specular IBL`
 * is a specular/gloss shader, so `_Color` is the DIFFUSE albedo and goes on
 * `color`, with a little metalness for the sheen rather than a metal workflow
 * that would throw the albedo away. `_SpecInt` is 0.58 on every tier but lead,
 * so the four live tiers share one roughness.
 *
 * The emissive floor is the port's: a 0.077 m object under one point light in
 * a dark room has to carry its own colour, or it reads as a dark shape on a
 * Quest. It is the tier's own colour, dimmed, so it cannot change the hue.
 */
const medalMaterial = (tier: MedalTier): THREE.MeshStandardMaterial => {
  const colour = medalColour(tier)
  return new THREE.MeshStandardMaterial({
    color: colour,
    metalness: 0.22,
    roughness: 0.36,
    emissive: colour.clone().multiplyScalar(0.3),
    flatShading: true,
  })
}

/**
 * The silhouette shell, an inverted hull. DEV-151.
 *
 * The same geometry, scaled up about the emblem's own centre, drawn BACK faces
 * only: every front face is hidden by the emblem itself, so what survives is a
 * band of `colour` around the outline, the same width from every angle and
 * under every tier. `depthWrite: false` keeps it from z-fighting its own
 * emblem at the grazing edges where the two surfaces nearly meet, and
 * `renderOrder: -1` puts it behind — it is a border, not a coat.
 *
 * WHY A SHELL AND NOT A TINT: the tier colours are 2016's (`PROPS.medals`,
 * DEV-113) and moving one is a fidelity deviation needing its own row. A border
 * changes no medal's hue; it changes what the medal is read AGAINST, which is
 * the actual complaint — DEV-140 gave the islands the terrain's real colours
 * and a pale medal then sat on pale rock.
 *
 * `widthFraction` is a fraction of the emblem's own HEIGHT rather than metres,
 * so a table of a different size keeps the same border.
 */
const buildOutline = (
  emblem: THREE.Object3D,
  block: EditionMedalOutline,
): { object: THREE.Object3D; material: THREE.Material } | null => {
  if (!block.enabled || !(block.widthFraction > 0) || !(block.opacity > 0)) return null
  const box = new THREE.Box3().setFromObject(emblem)
  const height = box.max.y - box.min.y
  if (!Number.isFinite(height) || height <= 0) return null

  const shell = emblem.clone(true)
  shell.name = 'medal-outline'
  const material = new THREE.MeshBasicMaterial({
    color: new THREE.Color(
      srgbToLinear(block.colour[0]),
      srgbToLinear(block.colour[1]),
      srgbToLinear(block.colour[2]),
    ),
    side: THREE.BackSide,
    transparent: block.opacity < 1,
    opacity: block.opacity,
    depthWrite: false,
  })
  shell.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (mesh.isMesh) mesh.material = material
  })
  // Scale about the emblem's CENTRE, not its origin: the origin is the spin
  // axis at the emblem's base, so scaling about it would grow the shell upward
  // only and leave the bottom edge bare.
  //
  // A point `r` from the centre moves out by (grow − 1)·r, so the band at the
  // top and bottom edges — `height / 2` from the centre — is
  // (grow − 1)·height/2. Setting that to `widthFraction · height` gives:
  const grow = 1 + 2 * block.widthFraction
  const centre = box.getCenter(new THREE.Vector3())
  const holder = new THREE.Group()
  holder.name = 'medal-outline-holder'
  holder.position.copy(centre)
  shell.position.sub(centre)
  holder.scale.setScalar(grow)
  holder.add(shell)
  holder.renderOrder = -1
  return { object: holder, material }
}

export interface MedalArt {
  /** Add this. Its origin is the spin axis at the emblem's base. */
  readonly object: THREE.Group
  readonly tier: MedalTier
  /**
   * The emblem's lowest vertex, metres below (negative) or above the object's
   * origin. Measured off the mesh, so whoever places the medal can put THIS
   * over the ground rather than the origin (DEV-140). Invariant under the spin.
   */
  readonly bottom: number
  /**
   * How far from the spin axis the emblem reaches, horizontally, metres — the
   * radius of the disc it sweeps as it turns. The footprint to clear.
   */
  readonly reach: number
  /**
   * DEV-574: the yaw that turns the emblem's FACE to +z, read off its own box:
   * 0 where it is thinner in z than in x (its face looks along z), a quarter
   * turn where it is thinner in x.
   */
  readonly front: number
  /** DEV-574: rest at this yaw while its table is not selected; puts it there at once. */
  rest(yaw: number): void
  /**
   * Turn it while `spinning` (the default, 2016's: always), or ease it to its
   * rest (`render/turntable.ts`). Render time: this is decoration.
   */
  update(seconds: number, spinning?: boolean): void
  dispose(): void
}

/**
 * Build a medal out of the loaded title logo.
 *
 * `logo` is the glTF scene root from `assets/props/title-logo.glb`; it is
 * cloned, never mutated, and the clone's own placement is reset because the
 * title screen may have moved the original. The `title` wordmark comes off —
 * 2016's medal prefabs carry only `logo_top` and `logo_bottom` — and both
 * remaining meshes get the tier's material.
 *
 * `startYaw` is injectable so a test can build a determinate one; the game
 * passes nothing and gets 2016's random start.
 */
export const createMedal = (
  logo: THREE.Object3D,
  tier: MedalTier,
  tableHalfExtent: number,
  startYaw: number = Math.random() * MEDAL_START_YAW_MAX,
  outlineBlock: EditionMedalOutline | null = null,
): MedalArt => {
  const placement = medalPlacement(tableHalfExtent)
  const emblem = logo.clone(true)
  emblem.name = 'medal-emblem'
  emblem.position.set(0, 0, 0)
  emblem.quaternion.identity()
  emblem.scale.set(placement.scale.x, placement.scale.y, placement.scale.z)

  // Matched BY NAME, as `title.ts` paints its submeshes: a glTF exporter is
  // free to reorder primitives.
  const wordmarks: THREE.Object3D[] = []
  emblem.traverse((node) => {
    if (/^title/i.test(node.name)) wordmarks.push(node)
  })
  for (const node of wordmarks) node.removeFromParent()

  const material = medalMaterial(tier)
  emblem.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (mesh.isMesh) mesh.material = material
  })

  const object = new THREE.Group()
  object.name = 'hangar-medal'
  object.userData = { tier }
  object.add(emblem)

  // The silhouette shell, if the preset asks for one. Added BEFORE the box is
  // measured, so DEV-140's clearance lifts the shell clear of the island too —
  // a border that dips into a peak is the bug it was drawn to fix.
  const outline = outlineBlock ? buildOutline(emblem, outlineBlock) : null
  if (outline) object.add(outline.object)

  // Measured BEFORE the start yaw goes on, in the object's own frame: the box
  // of the emblem as scaled, plus the shell around it. `bottom` is its floor;
  // `reach` is the furthest any corner stands from the y axis, which is the
  // disc the spin sweeps.
  object.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(object)
  const bottom = Number.isFinite(box.min.y) ? box.min.y : 0
  const reach = Number.isFinite(box.min.x)
    ? Math.hypot(
        Math.max(Math.abs(box.min.x), Math.abs(box.max.x)),
        Math.max(Math.abs(box.min.z), Math.abs(box.max.z)),
      )
    : 0
  const front =
    Number.isFinite(box.min.x) && box.max.x - box.min.x < box.max.z - box.min.z ? Math.PI / 2 : 0
  object.rotation.y = startYaw

  let restYaw: number | null = null
  return {
    object,
    tier,
    bottom,
    reach,
    front,
    rest(yaw: number) {
      restYaw = yaw
      object.rotation.y = yaw
    },
    update(seconds: number, spinning = true) {
      object.rotation.y = turntableYaw(object.rotation.y, restYaw, seconds, spinning, MEDAL_SPIN)
    },
    dispose() {
      // Geometry is the logo's, shared with the clone's source; only the
      // materials are this medal's own.
      material.dispose()
      outline?.material.dispose()
      object.removeFromParent()
    },
  }
}
