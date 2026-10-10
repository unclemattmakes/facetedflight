// src/game/jumpseat-art.ts — the JumpSeat's own 2016 meshes, placed by the sheet.
//
// DEV-114. This replaces `buildJumpSeatStandIn`, which drew boxes off the
// colliders because a note said the meshes were licence-blocked. They never
// were (DEV-111): `jumpseat_rough_01.fbx` and `jumpseat_shell_04.fbx` sit in
// `Assets/Faceted Flight/Meshes/` beside the HoverJet's, exported from Matt's
// own Maya. What was blocked is the two MATERIALS they wear, and a material's
// colour is a number, so the sheet carries the four `_Color`s and this file
// paints the submeshes by NAME.
//
// ── The rig, out of the sheet, not out of this file ───────────────────────
//
// `JUMPSEAT.art` is `tools/extract/constants.mjs`'s walk of the shipped prefab:
//
//   JumpSeat_Photon                  the rigidbody
//     offset                         (0, 0.42, 0.04)
//       art_pivot (1)                (-0.0203, 0.73, 0.1187)  Rotator_Input
//         art_firstPerson            identity
//           testArt (2)              identity
//             jumpseat_rough_01      (0.0203, -2.585, 0.7213) -> root (0, -1.435, 0.88)
//               seat / console_thing / botton / boxes    the body GLB's four nodes
//               jumpseat_shell_04/shell                  the shell GLB
//             hover_engine (1..3)    three discs, an asymmetric triangle
//
// Identity rotation and unit scale on every link. **The HoverJet's
// `SHIP_MODEL_YAW` does not carry over**, and that is read from the prefab
// rather than assumed: the JumpSeat art has no yaw at all.
//
// ── Which way the GLB faces, and why that is a rotation, not a mirror ──────
//
// `tools/assets/convert-fbx.py` exports these three assemblies in THREE space
// (`unity_to_three`, a half-turn about the vertical), unlike the single-mesh
// jobs, which are exported as Unity draws them (`unmirror_x`). Both rules give
// the same bytes on a mesh symmetric across its fore-aft axis, which is every
// asset before this one; the JumpSeat's seat sits 0.93 m behind the art origin
// and is the first asset the two rules disagree on. So the placement here is
// the sheet's Unity position with z negated and NOTHING else — no per-vertex
// flip, no yaw — and `tests/unit/jumpseat-art.test.ts` measures the loaded
// seat against `collider_head`, a Unity-native box in the same prefab, which is
// the orientation lesson's oracle: a distance, not a quaternion.
//
// ── What is 2016's and what is not ────────────────────────────────────────
//
//  * the body (4 nodes) and the shell — 2016 geometry, 2016 colours;
//  * the three engine discs — Unity's built-in Sphere squashed to (0.54, 0.16,
//    0.54) in `glowyMaterial`, drawn from the sheet's composed transforms as a
//    `SphereGeometry`, which is a reimplementation of a primitive, not an asset;
//  * the three engine CONES (DEV-433) — `Projector04-Faceted`, an upturned
//    holo-table around each disc in `Projector04_Mat`: bought geometry, which
//    hard rule 7 has let ship from R2 since 2026-09-23. One mesh-local copy
//    (`projector04-faceted.glb`, `tools/assets/convert-jumpseat-cone.mjs`)
//    placed three times from the sheet by the discs' own rule. Optional: a
//    build that lands before the R2 push draws the seat without them;
//  * the EIGHT leg struts (DEV-433) — `hexTile.fbx` (2016's own pentagonal
//    prism), two per leg, each at the prefab's own transform in its leg
//    rigidbody's frame (`JUMPSEAT.art.legFrames`), and that frame swung about
//    2016's hinge by the angle the sim holds. Until DEV-433 the port drew ONE
//    per leg, derived from the sim's hinge-to-foot line — the second of each
//    pair, the rod running up into the shell, was missing, and it is what Matt
//    saw: *"it seems like the legs are different in our version."*
//
// NOT drawn: the `Halo` on each engine, a Unity screen-space glow component
// (an engine feature, not an asset; DEV-336's billboards are the port's tool
// for one if it is wanted).
//
// ── One rig for both views, and that is 2016's too ────────────────────────
//
// 2016's `CamChanger` swaps `art_firstPerson` OFF and `art_thirdPerson` ON for
// the chase view (`prevShipArt` is the first). The chase branch's live
// `testArt (3)` is the cockpit branch's `testArt (2)` renderer for renderer —
// same meshes, same materials, composed transforms equal to 4e-8 — and the
// legs hang off `offset`, outside both. So one rig drawn in both views is what
// 2016 draws in both. DEV-433 has the comparison.
//
// ── The legs, and why the far end no longer comes from the sim ────────────
//
// The ART draws what 2016 draws: the frame at its authored pose, turned about
// the prefab's own hinge (`jumpseat.legs[].anchor` and `axis`, in that frame)
// by the sim's angle, with the sign taken so that +θ lifts the foot, as the sim
// defines it. Since DEV-530 the sim builds its legs from the same frames, so
// the drawn foot and the sim's are one point to the sheet's rounding, and
// `tests/unit/jumpseat-flight.test.ts` holds them there. (DEV-433 drew this
// while the sim still reconstructed its hinge from two collider centres, 2.7°
// to 4.2° off, with a foot up to 0.2 m from the capsule's cap.)

import * as THREE from 'three'
import { assetUrl } from '@/content/asset-url'
import { JUMPSEAT, PROPS } from '@/generated/constants.generated'
import { projectorMaterial } from '@/render/hover-glow'
import { loadMesh } from '@/render/load-mesh'
import { disposeTree } from '@/render/scene-walk'
import { applyUnityPose, srgbToLinear } from '@/render/unity-space'
import { createJumpSeatLegSpecs } from '@/sim/jumpseat-legs'

export const JUMPSEAT_MESH_BODY = 'assets/ships/jumpseat-body.glb'
export const JUMPSEAT_MESH_SHELL = 'assets/ships/jumpseat-shell.glb'
export const JUMPSEAT_MESH_STRUT = 'assets/ships/jumpseat-strut.glb'
/** The engine cone, `tools/assets/convert-jumpseat-cone.mjs`'s output (DEV-433). */
export const JUMPSEAT_MESH_CONE = 'assets/ships/projector04-faceted.glb'

const ART = JUMPSEAT.art

/**
 * Where the art root sits in the ship's frame, THREE space: the sheet's
 * composed `jumpseat_rough_01` position with z negated. The HoverJet's
 * `ART_POSITION` is the same idea, and like it this is exported so a second
 * consumer cannot keep a drifting copy (orientation lesson §5).
 */
export const JUMPSEAT_ART_POSITION = new THREE.Vector3(
  ART.root.composed.position.x,
  ART.root.composed.position.y,
  -ART.root.composed.position.z,
)

/**
 * Where `art_pivot (1)` stands in the ship's frame, THREE space — the point the
 * lean turns the seat about (DEV-365, `game/art-pivot.ts`). The sheet's chain
 * from the root to the art, composed as far as the node `Rotator_Input` lives
 * on, which the sheet names too: read, not typed. Unit scale and no rotation on
 * every link to it, which `tests/unit/art-pivot.test.ts` holds, so everything
 * hung on the pivot is placed by a subtraction.
 */
export const JUMPSEAT_ART_PIVOT: THREE.Vector3 = (() => {
  const m = new THREE.Matrix4()
  for (const link of ART.root.chain) {
    const { position: p, rotation: q, scale: s } = link.local
    m.multiply(
      new THREE.Matrix4().compose(
        new THREE.Vector3(p.x, p.y, p.z),
        new THREE.Quaternion(q.x, q.y, q.z, q.w),
        new THREE.Vector3(s.x, s.y, s.z),
      ),
    )
    if (link.name === JUMPSEAT.artRotator.gameObject) {
      const at = new THREE.Vector3().setFromMatrixPosition(m)
      return new THREE.Vector3(at.x, at.y, -at.z)
    }
  }
  throw new Error(`jumpseat-art: no ${JUMPSEAT.artRotator.gameObject} on the sheet's art chain`)
})()

/**
 * The four legs' geometry and tuning, built once from the sheet — shared with
 * the physics ON PURPOSE (it was `jumpseat-flight.ts`'s; it lives with the art
 * now because the art is what consumes it, and `jumpseat-flight.ts` re-exports
 * it so nothing that imported it there has moved).
 */
export const JUMPSEAT_LEG_SPECS = createJumpSeatLegSpecs()

/** Which sheet colour each GLB node wears. Names are the FBX node names. */
const COLOUR_OF: Readonly<Record<string, readonly number[]>> = {
  seat: ART.colors.darkGrey,
  console_thing: ART.colors.darkGrey,
  botton: ART.colors.darkGrey,
  boxes: ART.colors.lambert1Meshes,
  shell: ART.colors.orangeSmooth,
  pCylinder1: ART.colors.grey,
}

/** A `_Color` off the sheet — sRGB as serialised — onto a `THREE.Color`, linear. */
const linear = (c: readonly number[]): THREE.Color =>
  new THREE.Color().setRGB(
    srgbToLinear(c[0] ?? 0),
    srgbToLinear(c[1] ?? 0),
    srgbToLinear(c[2] ?? 0),
    THREE.LinearSRGBColorSpace,
  )

/**
 * Flat, faceted, no vertex colour: these GLBs carry none, and the 2016
 * materials were a plain diffuse `_Color` on Unity's Standard shader and on
 * Marmoset's — neither ported (hard rule 7's inverse trap on the first, DEV-008
 * on the second). The colour is the whole of what crosses.
 */
const flat = (colour: readonly number[]): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({
    color: linear(colour),
    roughness: 0.8,
    metalness: 0,
    flatShading: true,
  })

export interface JumpSeatArt {
  /**
   * Parent this to the ART PIVOT. It is built in the SHIP's frame — the art
   * root's offset and the engines' are inside it — so it hangs at the ship's
   * origin as the pivot sees it: `onPivot(origin, JUMPSEAT_ART_PIVOT)`.
   */
  readonly object: THREE.Object3D
  /**
   * The four legs, in the SHIP's frame, at identity inside `object` as built —
   * so the hangar's table gets the whole aircraft. A FLIGHT re-parents this to
   * the ship, NOT the pivot: 2016 hangs `legs_front` and `legs_back` off
   * `offset`, beside `art_pivot (1)` rather than under it, so the lean never
   * swings them, and they stay on the pads the sim's feet stand on. DEV-365.
   */
  readonly legs: THREE.Object3D
  /** Swing the four legs to the angles the sim is holding. */
  setLegAngles(angles: readonly number[]): void
  dispose(): void
}

export interface JumpSeatArtParts {
  /** `jumpseat-body.glb`'s scene: nodes `seat`, `console_thing`, `botton`, `boxes`. */
  readonly body: THREE.Object3D
  /** `jumpseat-shell.glb`'s scene: node `shell`. */
  readonly shell: THREE.Object3D
  /** `jumpseat-strut.glb`'s scene: node `pCylinder1`, the hexTile prism. */
  readonly strut: THREE.Object3D
  /**
   * `projector04-faceted.glb`'s scene: node `cone`, one `Projector04-Faceted`
   * in its own frame (DEV-433). Absent or `null` draws the seat without its
   * engine cones — a fetch that failed, or a build ahead of the R2 push.
   */
  readonly cone?: THREE.Object3D | null
}

/** Every mesh under `root`, painted from `COLOUR_OF` by its node name. */
const paint = (root: THREE.Object3D, disposables: { dispose(): void }[]): void => {
  root.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    const colour = COLOUR_OF[mesh.name] ?? COLOUR_OF[mesh.parent?.name ?? '']
    if (!colour) throw new Error(`jumpseat-art: no sheet colour for GLB node '${mesh.name}'`)
    const old = mesh.material
    if (Array.isArray(old)) for (const m of old) m.dispose()
    else old?.dispose()
    const material = flat(colour)
    disposables.push(material)
    mesh.material = material
  })
}

/**
 * The first mesh in a GLB scene, its node transform BAKED into a copy of its
 * geometry, so the copy is in the scene's own frame. For the strut that is the
 * exporter's +90° x on `pCylinder1`, which leaves the prism's 0.5 m thickness
 * along +y — Unity's mesh-local y, which is the axis the prefab stretches.
 */
const bakedGeometryOf = (scene: THREE.Object3D, what: string): THREE.Mesh => {
  const meshes: THREE.Mesh[] = []
  scene.updateMatrixWorld(true)
  scene.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (mesh.isMesh) meshes.push(mesh)
  })
  const first = meshes[0]
  if (!first) throw new Error(`jumpseat-art: the ${what} GLB contains no mesh`)
  const baked = new THREE.Mesh(
    first.geometry.clone().applyMatrix4(first.matrixWorld),
    first.material,
  )
  baked.name = first.name
  return baked
}

/** A Unity transform off the sheet, as three-space position / quaternion / scale. */
interface UnityTrs {
  readonly position: { readonly x: number; readonly y: number; readonly z: number }
  readonly rotation: {
    readonly x: number
    readonly y: number
    readonly z: number
    readonly w: number
  }
  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
}

/**
 * Unity -> three, for a TRANSFORM: z negated on the position, x and y negated
 * on the quaternion, scale as it is. The z-flip is a conjugation (F·M·F), so it
 * applies link by link and the composition of converted links is the converted
 * composition — which is why a strut's LOCAL transform can be converted on its
 * own and hung in a converted frame. The geometry it places must itself be in
 * three space (Unity's mesh-local frame with z negated), which is what both
 * converters write.
 */
const placeUnity = (object: THREE.Object3D, t: UnityTrs): void => {
  applyUnityPose(object, t.position, t.rotation)
  object.scale.set(t.scale.x, t.scale.y, t.scale.z)
}

/** One leg, as the art swings it: the frame at rest and the hinge it turns about. */
interface LegRig {
  readonly group: THREE.Group
  /** The frame's rest pose, three space. */
  readonly restPosition: THREE.Vector3
  readonly restQuaternion: THREE.Quaternion
  /** The prefab's hinge, three space: `anchor` and `axis` carried out of the frame. */
  readonly pivot: THREE.Vector3
  readonly axis: THREE.Vector3
  /** +1 or -1: the turn about `axis` that lifts the foot for the sim's +θ. */
  readonly sign: number
}

/**
 * Build the art from already-loaded GLB scenes. Synchronous and renderer-free,
 * so `tests/unit/jumpseat-art.test.ts` can parse the files off disk and MEASURE
 * what this produces — the orientation lesson's whole point.
 */
export const buildJumpSeatArt = (parts: JumpSeatArtParts): JumpSeatArt => {
  const group = new THREE.Group()
  group.name = 'jumpseat_art'
  const disposables: { dispose(): void }[] = []

  // ── the body and the shell, at the art root ─────────────────────────────
  const art = new THREE.Group()
  art.name = 'jumpseat_rough_01'
  art.position.copy(JUMPSEAT_ART_POSITION)
  paint(parts.body, disposables)
  paint(parts.shell, disposables)
  parts.body.name = 'jumpseat_body'
  parts.shell.name = 'jumpseat_shell'
  art.add(parts.body, parts.shell)
  group.add(art)

  // ── the three hover engines: a disc, and the cone around it ─────────────
  //
  // `glowyMaterial.mat`, which is the gate stud material, so the numbers are
  // the ones `game/rings.ts` already reads: opaque, `_GlowStrength` 2.
  const ring = PROPS.checkpointRing
  const glow = new THREE.MeshStandardMaterial({
    color: linear(ring.studColor),
    emissive: linear(ring.studGlowColor),
    emissiveIntensity: ring.studGlowStrength ?? 2,
    roughness: 0.6,
    metalness: 0,
  })
  const disc = new THREE.SphereGeometry(0.5, 16, 10)
  disposables.push(glow, disc)
  // The cone (DEV-433): ONE geometry and ONE material for all three, both from
  // the GLB — `Projector04_Mat`'s numbers ride in its extras, and
  // `projectorMaterial` is the wing's own builder for them, so the seat's cones
  // and the HoverJet's projectors are one material by construction.
  let cone: THREE.Mesh | null = null
  if (parts.cone) {
    cone = bakedGeometryOf(parts.cone, 'cone')
    const arrived = cone.material as THREE.Material
    cone.material = projectorMaterial(arrived)
    arrived.dispose()
    disposables.push(cone.geometry, cone.material as THREE.Material)
  }
  for (const engine of ART.engines) {
    const s = engine.sphere
    if (!engine.live || !s) continue
    const mesh = new THREE.Mesh(disc, glow)
    mesh.name = `engine_${engine.name.replace(/\W+/g, '_')}`
    placeUnity(mesh, s.composed)
    group.add(mesh)
    const p = engine.projector
    if (cone && p?.live) {
      const c = new THREE.Mesh(cone.geometry, cone.material)
      c.name = `cone_${engine.name.replace(/\W+/g, '_')}`
      placeUnity(c, p.composed)
      group.add(c)
    }
  }

  // ── the four legs, eight struts, and they MOVE ──────────────────────────
  //
  // Each leg is a group at its rigidbody's frame (`JUMPSEAT.art.legFrames`),
  // and each of its struts is a child at the prefab's OWN local transform in
  // that frame — so the struts are wherever 2016 authored them, the damper rod
  // included, and nothing about them is derived. `setLegAngles` turns the
  // frame about the prefab's hinge; both struts ride it, as they ride the
  // HingeJoint's body in 2016.
  const strut = bakedGeometryOf(parts.strut, 'strut')
  disposables.push(strut.geometry, strut.material as THREE.Material)
  const strutMaterial = flat(ART.colors.grey)
  disposables.push(strutMaterial)
  // Their own group, because in a flight they do not share the art's parent
  // (DEV-365); here, in it, so a table that shows the art shows the legs.
  const legsGroup = new THREE.Group()
  legsGroup.name = 'jumpseat_legs'
  group.add(legsGroup)

  const rigs: LegRig[] = []
  for (const [i, spec] of JUMPSEAT_LEG_SPECS.entries()) {
    const joint = JUMPSEAT.legs[i]
    const frame = ART.legFrames.find((f) => f.name === spec.name)
    if (!joint || joint.name !== spec.name || !frame) {
      throw new Error(`jumpseat-art: no leg frame for '${spec.name}' on the sheet`)
    }
    const leg = new THREE.Group()
    leg.name = `leg_${i}_${spec.name}`
    placeUnity(leg, frame.composed)
    for (const row of ART.legStruts) {
      if (!row.live || row.leg !== frame.path) continue
      const mesh = new THREE.Mesh(strut.geometry, strutMaterial)
      mesh.name = `strut_${spec.name}_${row.transformFileId}`
      placeUnity(mesh, row.local)
      leg.add(mesh)
    }
    legsGroup.add(leg)

    // The hinge, carried out of the frame: `anchor` and `axis` are in the leg's
    // own local space (HingeJoint `m_Anchor` / `m_Axis`), and the frame's scale
    // is unit on all four, which `jumpseat-art.test.ts` holds.
    leg.updateMatrix()
    const pivot = new THREE.Vector3(joint.anchor.x, joint.anchor.y, -joint.anchor.z).applyMatrix4(
      leg.matrix,
    )
    const axis = new THREE.Vector3(joint.axis.x, joint.axis.y, -joint.axis.z)
      .applyQuaternion(leg.quaternion)
      .normalize()
    // Which way is "+θ"? The sim's: the way `spec.swing` says the foot moves.
    // Taken from geometry — the leg's own origin, a metre down the leg from the
    // hinge, and the direction a turn about `axis` carries it — so it holds
    // whatever handedness the axis arrived in.
    const lever = leg.position.clone().sub(pivot)
    const carried = new THREE.Vector3().crossVectors(axis, lever)
    const swing = new THREE.Vector3(spec.swing.x, spec.swing.y, -spec.swing.z)
    rigs.push({
      group: leg,
      restPosition: leg.position.clone(),
      restQuaternion: leg.quaternion.clone(),
      pivot,
      axis,
      sign: carried.dot(swing) < 0 ? -1 : 1,
    })
  }

  const turn = new THREE.Quaternion()
  const setLegAngles = (angles: readonly number[]): void => {
    for (const [i, rig] of rigs.entries()) {
      turn.setFromAxisAngle(rig.axis, rig.sign * (angles[i] ?? 0))
      rig.group.quaternion.multiplyQuaternions(turn, rig.restQuaternion)
      rig.group.position.copy(rig.restPosition).sub(rig.pivot).applyQuaternion(turn).add(rig.pivot)
    }
  }
  // Draw them where they start, so a seat that is never stepped still has legs.
  setLegAngles([0, 0, 0, 0])

  return {
    object: group,
    legs: legsGroup,
    setLegAngles,
    dispose: () => {
      for (const d of disposables) d.dispose()
      for (const scene of [parts.body, parts.shell, parts.strut, parts.cone]) {
        disposeTree(scene, { materials: false })
      }
    },
  }
}

/**
 * Fetch the GLBs and build the art.
 *
 * The cone is fetched like the HoverJet's wing (`game/ship-wings.ts`): a failed
 * fetch is a missing PART, warned about once and named, and the seat flies
 * without its cones. `projector04-faceted.glb` reaches players only when
 * somebody pushes it to R2 (hard rule 7: bought geometry, never git), and a
 * deploy of this code that lands first must still fly. Every other mesh still
 * throws: a seat whose body did not load IS a broken mission.
 */
export const loadJumpSeatArt = async (): Promise<JumpSeatArt> => {
  const [body, shell, strut, cone] = await Promise.all([
    loadMesh(assetUrl(JUMPSEAT_MESH_BODY)),
    loadMesh(assetUrl(JUMPSEAT_MESH_SHELL)),
    loadMesh(assetUrl(JUMPSEAT_MESH_STRUT)),
    loadMesh(assetUrl(JUMPSEAT_MESH_CONE)).catch((err: unknown) => {
      console.warn(
        `[jumpseat-art] ${JUMPSEAT_MESH_CONE} did not load, so the seat flies without its engine cones (DEV-433): ${(err as Error)?.message ?? String(err)}`,
      )
      return null
    }),
  ])
  return buildJumpSeatArt({
    body: body.object,
    shell: shell.object,
    strut: strut.object,
    cone: cone?.object ?? null,
  })
}
