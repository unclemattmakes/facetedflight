// src/render/hover-glow.ts — the HoverJet's anti-grav wings: 2016's own art,
// ported. DEV-322, superseding DEV-310's first-party rebuild.
//
// Matt, wishlist #23: *"HoverJet hover engines should glow."* DEV-310 found the
// part and rebuilt it from primitives, because hard rule 7 then forbade
// shipping bought geometry. Matt, 2026-09-23: *"right idea, but port the actual
// art from the other game as opposed to making your own"* — and he rewrote hard
// rule 7 the same day. So this now draws the 2016 part itself, converted by
// `tools/assets/convert-wings.mjs` into `hoverjet-wings.glb` and served from R2
// like every other mesh the game loads. It never goes in git.
//
// ── What the part is ─────────────────────────────────────────────────────
//
// Matt's own kitbash, and his memory of it is exact: *"holo-tables flipped
// upside down to look like anti-grav generators under the wings. spheres
// stuffed in the engines to glow."* In the files:
//
//   * `projectors` — `Mesh1-Combined`, `Projector04_Mat`: SIX `Projector04`
//     holo-tables, upside down, three under each wing.
//   * `glow` — `Mesh2-Combined`, `glowyMaterial`: TEN glowing pieces, which are
//     the ten `glowyBit`s of `GhostRacer.prefab` to the millimetre — a disc in
//     each of the six projectors, three in the engines, one under the nose.
//
// DEV-310's reading from the AABB alone was "a ship-wide underbody, hanging
// 0.607 m below the belly". The x and z of that envelope were right to 3 cm.
// The y was not: it is the box of a ROTATED box, and the part's inner node is
// pitched ~7.5 degrees, so the envelope is 2.84 m tall around a part that is
// 1.39 m tall. Nothing of the real part hangs below the hull's lowest vertex.
// **An envelope bounds a part; it never located one** — DEV-310's own lesson,
// one axis further than it took it.
//
// ── The frame: the HULL's, so the wing is a plain child of the hull ──────
//
// Both 2016 prefabs hang the wing and the hull off ONE parent, each at its
// origin with identity rotation. The converter composes each mesh through its
// own prefab chain into that frame, so `hoverjet-wings.glb` is in the frame
// `hoverjet-exterior.glb` is in, and it is added to the hull's art object AS
// IS. `ART_POSITION`, `SHIP_MODEL_YAW` and `ART_SCALE` reach it through the
// hull, exactly as `Art/ThirdPerson`'s transform reaches both in 2016.
//
// That retires DEV-310's inverse-matrix group, whose only job was to undo the
// art transform for geometry authored in the SHIP frame. It also means the
// wing is hidden with the hull for free: `game/flight.ts` hides the exterior by
// one line, and this is a child of that object.
//
// **One wing, not a pair of wings.** The player prefab's ThirdPerson branch has
// a second `anti-grav_rightWing` at Unity scale (1, 1, -1), and its
// `m_Children` is `[]` — it draws nothing. Each combined mesh already spans
// both sides of the ship. `tests/unit/hover-glow.test.ts` asserts that the
// mirrored node is empty, and measures the small inboard projector's side
// against the prefab.
//
// ── The materials ────────────────────────────────────────────────────────
//
// * The GLOW wears `glowyMaterial.mat`'s colours, which are the gate stud
//   material's and already in the sheet (`PROPS.checkpointRing.stud*`) — the
//   same material DEV-310 built, unchanged. No Marmoset shader is translated.
// * The PROJECTORS on the player's ship wear `Projector04_Mat`: Marmoset
//   Vertex Color, so vertex colour times `_Color`. The GLB carries the vertex
//   colour and the `.mat`'s numbers (`material.userData.unity`, from the
//   converter), and the material is built from those here.
// * On a hologram — the ghosts, and the AI racers, which the port draws in the
//   same holo material — the projectors wear the HULL's material, because that
//   is what 2016 does on its own hologram ship: `playbackGhost/ThirdPerson
//   (1)`'s `Mesh1-Combined` wears `holo_ghost 1.mat`, the ghost hull's own.
//   (`GhostRacer.prefab` is an OPAQUE hull and wears `Projector04_Mat`; the
//   port's racers are holograms, so they follow the ghost. DEV-322 flags it.)
//   The glow keeps its colour on every ship, in both prefabs.
//
// ── Where it goes, and where it does not ─────────────────────────────────
//
// The same three consumers DEV-310 wired: the chase view (`game/flight.ts`),
// the AI racers (`game/racers.ts`) and the ghosts (`game/ghosts.ts`), all
// through `game/ship-wings.ts`, which does the fetch — and since DEV-546 the
// level select's parked jet (`boot/app.ts`): the hangar parks the RAW glTF
// object in the GLB's own frame, which is the frame this file's geometry is
// in, so the parked jet takes the wing as a plain child. `Environment_Hangar.prefab`
// carries the same two meshes, materials and transforms, beside
// `hoverJet_exterior_orange` under one parent (read off both prefabs). There
// the room's dress gives the projectors the hull's material and keeps the
// glow's (`render/hangar-art.ts`, `dressParkedJet`). NOT the title flypast,
// for DEV-310's scope reasons.
//
// ── The Halos, which are NOT here ────────────────────────────────────────
//
// Each `glowyBit` in `GhostRacer.prefab` also carries a live Unity `Halo`
// component — a camera-facing soft glow, colour (105, 213, 234), size 0.2 to
// 0.43. That is an engine feature, not an asset, and it is the one piece of
// "the glow" this row does not port. DEV-322 records the numbers.

import * as THREE from 'three'
import { PROPS } from '@/generated/constants.generated'
import { shininessToRoughness } from '@/render/terrain-mesh'
import { srgbToLinear } from '@/render/unity-space'

const RING = PROPS.checkpointRing

/**
 * DEV-310's envelope: `Mesh2-Combined`'s own `m_LocalAABB`, pushed through its
 * prefab transforms into the port's ship frame (THREE, metres).
 *
 * Kept, and now TESTED against the real part rather than used to place a
 * stand-in: the ported glow's x and z faces land within 4 cm of it, which is two
 * independent compositions of the same prefab agreeing. Its y is loose by
 * ~0.7 m each way (see the header) and says nothing about where the part hangs.
 * `game/racers.ts`'s trail emitter is checked against its aft face.
 */
export const GLOW_ENVELOPE_2016 = Object.freeze({
  min: Object.freeze([-2.7004, -1.4423, -1.4697] as const),
  max: Object.freeze([2.7047, 1.4019, 4.1503] as const),
})

/**
 * The hull's own extents in the same frame, measured off the shipped GLB.
 *
 * `hoverjet-exterior.glb` put through `ART_POSITION` / `SHIP_MODEL_YAW` /
 * `ART_SCALE`. Re-measured by `tests/unit/hover-glow.test.ts`.
 */
export const HULL_EXTENTS = Object.freeze({
  min: Object.freeze([-2.898, -0.835, -2.244] as const),
  max: Object.freeze([2.886, 1.133, 4.435] as const),
})

/** The two nodes `convert-wings.mjs` writes, by the names the GLB gives them. */
export const WING_PARTS = Object.freeze(['projectors', 'glow'] as const)

/**
 * The names a spec, a census or a sweep looks for, in `WING_PARTS` order.
 *
 * The group is `hover-glow`, as it was under DEV-310, so a toggle written
 * against the old part still finds the new one.
 */
export const HOVER_GLOW_NAMES = Object.freeze(['hover-glow:projectors', 'hover-glow:glow'] as const)

const linearColour = (c: readonly number[]): THREE.Color =>
  new THREE.Color(
    srgbToLinear(c[0] as number),
    srgbToLinear(c[1] as number),
    srgbToLinear(c[2] as number),
  )

/**
 * `glowyMaterial.mat`, as the studs wear it.
 *
 * Byte for byte the material on 2016's `Mesh2-Combined`, and
 * `ghost-trail.test.ts` already pins that `PROPS.ghostTrail.color ===
 * PROPS.checkpointRing.studColor`. Same treatment as `game/rings.ts`: opaque
 * (no `_ALPHABLEND_ON`, so the 0.891 alpha never reached a framebuffer),
 * `_GlowStrength` 2, Marmoset sharpness mapped to roughness.
 */
export const glowMaterial = (): THREE.MeshStandardMaterial => {
  const material = new THREE.MeshStandardMaterial({
    color: linearColour(RING.studColor),
    emissive: linearColour(RING.studGlowColor),
    emissiveIntensity: RING.studGlowStrength ?? 2,
    roughness: shininessToRoughness(RING.shader, RING.studSpecular?.shininess ?? 4),
    metalness: 0,
    transparent: RING.studBlends,
    opacity: RING.studBlends ? (RING.studColor[3] as number) : 1,
    depthWrite: !RING.studBlends,
  })
  material.name = 'hover-glow'
  return material
}

/** `Projector04_Mat`'s numbers, as `convert-wings.mjs` read them off the `.mat`. */
export interface UnityMaterialRecord {
  readonly name: string
  readonly shader: string | null
  readonly colorSrgb: readonly [number, number, number]
  readonly shininess: number
  readonly specInt: number
}

const unityRecordOf = (material: THREE.Material | undefined): UnityMaterialRecord | null => {
  const record = (material?.userData as { unity?: Partial<UnityMaterialRecord> } | undefined)?.unity
  if (!record || !Array.isArray(record.colorSrgb) || typeof record.shininess !== 'number')
    return null
  return record as UnityMaterialRecord
}

/**
 * `Projector04_Mat`: Marmoset Vertex Color Specular IBL — vertex colour times
 * `_Color`, the reading `render/lambert1.ts` records for this shader family.
 *
 * `_Color` is sRGB in the file and goes through the transfer function (a
 * `Color` property in a Linear project); the vertex colours arrive RAW in the
 * GLB, as they are on the hull (DEV-014). Throws if the GLB did not carry the
 * record, because a projector painted with a default would look like a port
 * and be a guess.
 */
export const projectorMaterial = (
  source: THREE.Material | undefined,
): THREE.MeshStandardMaterial => {
  const record = unityRecordOf(source)
  if (!record) {
    throw new Error(
      'hover-glow: the projectors carry no Projector04_Mat record (re-run convert-wings)',
    )
  }
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: shininessToRoughness(record.shader, record.shininess),
    metalness: 0,
  })
  material.color.setRGB(
    record.colorSrgb[0],
    record.colorSrgb[1],
    record.colorSrgb[2],
    THREE.SRGBColorSpace,
  )
  material.name = record.name
  material.userData.unity = record
  return material
}

export interface HoverGlowOptions {
  /**
   * Put THIS on the projectors instead of `Projector04_Mat` — the hull's own
   * hologram material, on a ghost or a racer. Owned by the caller: `dispose`
   * leaves it alone.
   */
  readonly projectorMaterial?: THREE.Material
}

export interface HoverGlow {
  /** The wing, as it hangs off the hull's art object. Empty if it did not load. */
  readonly object: THREE.Object3D
  dispose(): void
}

/**
 * Hang the wing off a loaded `SHIP_MESH_EXTERIOR` art object.
 *
 * `wings` is `hoverjet-wings.glb`'s scene, ALREADY LOADED — `game/ship-wings.ts`
 * does the fetch — and it is added to `art` as it arrived, at identity, because
 * it is in the hull GLB's own frame. Pass `null` when the fetch failed: the hull
 * then flies without it, which is a missing part and not a broken mission.
 *
 * Same shape and same call site as `applyLambert1`: every consumer of the
 * exterior hull gets the part by one call rather than keeping its own copy of
 * where the wing goes — the drift that sent every ghost in the game flying
 * backwards once already (`game/flight.ts`'s `ART_SCALE` note).
 */
export const attachHoverGlow = (
  art: THREE.Object3D,
  wings: THREE.Object3D | null,
  options: HoverGlowOptions = {},
): HoverGlow => {
  const object = wings ?? new THREE.Group()
  object.name = 'hover-glow'
  const owned: THREE.Material[] = []
  const geometries: THREE.BufferGeometry[] = []
  if (wings) {
    WING_PARTS.forEach((part, i) => {
      const mesh = wings.getObjectByName(part) as THREE.Mesh | undefined
      if (!mesh?.isMesh) throw new Error(`hover-glow: hoverjet-wings.glb has no mesh named ${part}`)
      const arrived = mesh.material as THREE.Material
      if (part === 'glow') {
        mesh.material = glowMaterial()
        owned.push(mesh.material)
      } else if (options.projectorMaterial) {
        mesh.material = options.projectorMaterial
      } else {
        mesh.material = projectorMaterial(arrived)
        owned.push(mesh.material)
      }
      arrived.dispose()
      mesh.name = HOVER_GLOW_NAMES[i] as string
      geometries.push(mesh.geometry)
    })
  }
  art.add(object)
  return {
    object,
    dispose() {
      for (const g of geometries) g.dispose()
      for (const m of owned) m.dispose()
      object.removeFromParent()
    },
  }
}
