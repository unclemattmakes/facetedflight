// src/game/orb-art.ts — energy orbs, as something you can see and fly at.
//
// The hit test is `sim/orbs.ts` and the placement is `game/orbs.ts`; this is the
// mesh. Split that way because `game/mission.ts` imports the other two and has
// to keep running in Vitest's node environment — `game/rings.ts` gets away with
// one file because nothing headless imports it.
//
// ── 2016's orb, ported (DEV-327) ──────────────────────────────────────────
//
// Matt, 2026-09-23: *"port the orb too plz."* `EnergyOrb.prefab`'s visible half
// is its child `sphere_fancy_lod_01`: mesh `pSolid2` out of
// `Meshes/sphere_fancy_lod_01.fbx` — a 60-vertex truncated icosahedron, twelve
// pentagons and twenty hexagons with flat normals, every vertex 1 m from its
// centre — scaled 1.6284 by the prefab and wearing `energy_orb.mat`. The
// `_lod_01` is a file name: there is no LODGroup, and the file holds one mesh.
// `energy-orb.glb` is that mesh (`tools/assets/convert-fbx.py`, `MESH_JOBS`) and
// `PROPS.energyOrb` is the prefab and the material, generated.
//
// This header used to say the mesh was *"a bought mesh with no licence in the
// 2016 tree (CLAUDE.md rule 7)"*. Both halves were wrong. The rule was
// rewritten on 2026-09-23: bought geometry may ship to players from R2 and
// never enters git. And this mesh is not bought: it sits in the first-party
// `Assets/Faceted Flight/Meshes/`, beside the HoverJet, and `pSolid2` on
// `lambert1` is Maya's own platonic-solid soccer ball. Either way it follows
// the same path as every mesh the game loads: R2, never git.
//
// ── What you see is INSIDE what you collect ──────────────────────────────
//
// The port drew a translucent shell at the 4.885 m collection radius and a solid
// core inside it, because it had no 2016 mesh and the one size it knew was how
// close you have to be. 2016 drew neither: a 1.63 m ball (the 1 m mesh times
// the prefab's 1.6284) inside the 4.885 m trigger (its `m_Radius 3` times the
// same scale). So the ball is exactly as big as 2016's and you collect it a
// few metres before you touch it, as you did then.
//
// ── The material, as numbers ─────────────────────────────────────────────
//
// `Marmoset/Self-Illumin/Diffuse IBL` is a bought shader, so what travels is its
// inputs. It is Opaque, and both of its `MARMO_SPECULAR_*` defines are commented
// out — no specular term at all, so the `.mat`'s `_Shininess` and `_SpecInt`
// are serialised and never read. What it draws is `_Color` lit, plus
// `_GlowColor * _GlowStrength` as emission (`MarmosetSurf.cginc:439-445`). Both
// colours are `Color` properties in a Linear project, so they go through
// `srgbToLinear`, as the gate's do.
//
// ── A failed fetch is a STAND-IN, not a missing orb ─────────────────────
//
// `energy-orb.glb` reaches players only after `pnpm assets:push`. DEV-322's
// wing can simply be absent when its fetch fails; an orb cannot — it is Free
// Flight's whole objective, and an invisible one is a broken mode. So a failed
// fetch is warned about once, naming the file, and the orbs fly as a
// first-party icosphere of the same size in the same material.
//
// ── Not ported ───────────────────────────────────────────────────────────
//
// The prefab's `Halo` and the root's sparkle `ParticleSystem` are recorded in
// the sheet and not drawn: a Halo is an engine feature (DEV-322 made the same
// call for the wing's `glowyBit`s). `Trigger_Magnet` stays off, as
// `game/orbs.ts` says. The SPIN below is the port's, as it was before: 2016's
// orbs stood still at a per-instance authored rotation the level JSON does not
// carry, and no shipped scene adds a component that turns one.

import * as THREE from 'three'
import { assetUrl } from '@/content/asset-url'
import type { Level } from '@/content/level-schema'
import { liveOrbs, orbPos } from '@/game/orbs'
import { bakedGeometry } from '@/game/rings'
import { PROPS } from '@/generated/constants.generated'
import { type LoadedMesh, loadMesh } from '@/render/load-mesh'
import { srgbToLinear, unityPose } from '@/render/unity-space'

/** 2016's orb, converted by `tools/assets/convert-fbx.py` (`MESH_JOBS`). */
export const ORB_MESH = 'assets/props/energy-orb.glb'

/** `geometry.name` on the art that is drawn — which one is on, readable from outside. */
export const ORB_ART_NAME = 'energy-orb'
export const ORB_STAND_IN_NAME = 'energy-orb-stand-in'
/** The instanced mesh's name, under the `orbs` group. */
export const ORB_MESH_NODE = 'energy-orbs'

const ORB = PROPS.energyOrb

/**
 * The radius of `pSolid2`'s vertices, in the mesh's own metres — the one number
 * the stand-in needs from a file it could not load. Measured, not chosen: every
 * vertex of the FBX and of the GLB sits at 1.0000, and `orb-art.test.ts` holds
 * the GLB to it, so the stand-in is the size of the thing it stands in for.
 */
export const ORB_MESH_RADIUS = 1

/** Radians per second. Slow enough to read as alive, not as a spinner. The port's, not 2016's. */
const SPIN_RATE = 0.6

const linear = (c: readonly number[]) =>
  new THREE.Color(
    srgbToLinear(c[0] as number),
    srgbToLinear(c[1] as number),
    srgbToLinear(c[2] as number),
  )

/**
 * `sphere_fancy_lod_01`'s own pose inside the orb root — the 1.6284 scale —
 * out of the sheet, through the port's one Unity-to-three conversion.
 */
export const orbArtPose = (): THREE.Matrix4 =>
  unityPose(ORB.art.position, ORB.art.rotation, ORB.art.scale)

/**
 * The loaded `energy-orb.glb`, as the orb root sees it: the mesh through the
 * glTF's own node transform (`bakedGeometry`, which the gate uses too) and
 * then through the prefab's pose. Null when the GLB has no mesh in it.
 *
 * UVs are dropped: `energy_orb.mat` binds no texture.
 */
export const orbArtGeometry = (root: THREE.Object3D): THREE.BufferGeometry | null => {
  const geometry = bakedGeometry(root)
  if (!geometry) return null
  geometry.applyMatrix4(orbArtPose())
  geometry.deleteAttribute('uv')
  geometry.name = ORB_ART_NAME
  geometry.computeBoundingSphere()
  geometry.computeBoundingBox()
  return geometry
}

/**
 * The stand-in, for when the GLB did not load: an 80-face icosphere at the
 * mesh's own radius, through the same prefab pose — so it is the size 2016's
 * ball is and nothing else about it is claimed.
 */
export const orbStandInGeometry = (): THREE.BufferGeometry => {
  const geometry = new THREE.IcosahedronGeometry(ORB_MESH_RADIUS, 1)
  geometry.applyMatrix4(orbArtPose())
  geometry.deleteAttribute('uv')
  geometry.name = ORB_STAND_IN_NAME
  geometry.computeBoundingSphere()
  geometry.computeBoundingBox()
  return geometry
}

/**
 * `energy_orb.mat`, as three numbers and a colour. See the header: Opaque, no
 * specular (so roughness 1, metalness 0 — the standard material with its
 * specular lobe as flat as it goes), and the glow as emission. `flatShading`
 * because the mesh's normals are per face, as the stand-in's are not.
 */
export const orbMaterial = (): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({
    color: linear(ORB.color),
    emissive: linear(ORB.glowColor),
    emissiveIntensity: ORB.glowStrength,
    roughness: 1,
    metalness: 0,
    flatShading: true,
  })

export type OrbArt = 'energy-orb' | 'stand-in'

export interface LoadedOrbs {
  readonly object: THREE.Object3D
  readonly count: number
  /** Which art is on — null until {@link setArt} has been called. */
  readonly art: OrbArt | null
  /**
   * Hang the art on: the loaded GLB's root, or null for the stand-in. Nothing
   * is drawn before this is called, because the mesh is fetched and the orbs
   * are built at once. The caller keeps ownership of `root`.
   */
  setArt(root: THREE.Object3D | null): void
  /** Hide one, permanently. `Trigger_EnergyOrb.SelfDestruct()` — nothing re-arms. */
  collect(index: number): void
  /** Render time, not sim time: this is decoration and owes the fixed step nothing. */
  update(seconds: number): void
  dispose(): void
}

export const loadOrbs = (level: Level): LoadedOrbs => {
  const orbs = liveOrbs(level)
  const material = orbMaterial()
  const group = new THREE.Group()
  group.name = 'orbs'

  const taken = orbs.map(() => false)
  const matrix = new THREE.Matrix4()
  const position = new THREE.Vector3()
  const quaternion = new THREE.Quaternion()
  const one = new THREE.Vector3(1, 1, 1)
  const zero = new THREE.Vector3(0, 0, 0)
  const axis = new THREE.Vector3(0.3, 1, 0.15).normalize()

  let mesh: THREE.InstancedMesh | null = null
  let art: OrbArt | null = null
  let clock = 0
  let disposed = false

  const writeAll = (seconds: number): void => {
    if (!mesh) return
    quaternion.setFromAxisAngle(axis, seconds * SPIN_RATE)
    orbs.forEach((orb, i) => {
      // `orbPos`, never `orb.pos`: DEV-067 moves five of kauai's eleven and the
      // ball has to be drawn where `sim/orbs.ts` will actually collect it.
      const p = orbPos(orb)
      position.set(p[0], p[1], p[2])
      ;(mesh as THREE.InstancedMesh).setMatrixAt(
        i,
        matrix.compose(position, quaternion, taken[i] ? zero : one),
      )
    })
    mesh.instanceMatrix.needsUpdate = true
  }

  const setArt = (root: THREE.Object3D | null): void => {
    if (disposed) return
    const geometry = (root && orbArtGeometry(root)) ?? orbStandInGeometry()
    if (mesh) {
      group.remove(mesh)
      mesh.geometry.dispose()
      mesh.dispose()
    }
    // Capacity one at least (three wants a buffer), and COUNT the real number:
    // `int_02_jumpSeat` is forced into Free Flight with all twelve orbs dead,
    // and a capacity-one mesh would otherwise draw its identity matrix — an orb
    // at the world origin.
    mesh = new THREE.InstancedMesh(geometry, material, Math.max(orbs.length, 1))
    mesh.count = orbs.length
    mesh.visible = orbs.length > 0
    mesh.name = ORB_MESH_NODE
    // Rewritten every frame by the spin.
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    // Orbs are scattered across the whole island, so one bounding sphere computed
    // from a single orb at the origin would cull the lot. Same call `rings.ts`
    // makes, for the same reason.
    mesh.frustumCulled = false
    // `m_CastShadows: 0`, `m_ReceiveShadows: 0` on the prefab's MeshRenderer —
    // three's defaults already.
    art = geometry.name === ORB_ART_NAME ? 'energy-orb' : 'stand-in'
    group.add(mesh)
    writeAll(clock)
  }

  return {
    object: group,
    count: orbs.length,
    get art() {
      return art
    },
    setArt,
    collect(index: number) {
      if (index < 0 || index >= taken.length) return
      taken[index] = true
    },
    update(seconds: number) {
      clock = seconds
      writeAll(seconds)
    },
    dispose() {
      disposed = true
      if (mesh) {
        mesh.geometry.dispose()
        mesh.dispose()
      }
      material.dispose()
    },
  }
}

/**
 * Fetch `energy-orb.glb` and hang it on `orbs`.
 *
 * DEV-322's shape (`game/ship-wings.ts`): the one place the file is named and
 * fetched, and a failure is a `console.warn` naming it rather than a thrown
 * mission. Unlike the wing, the fallback is DRAWN — see the header. `load`
 * takes the asset PATH and defaults to `loadMesh(assetUrl(path))`; it is a
 * parameter so a test can fail it, or succeed it, without an asset base.
 */
export const attachOrbArt = async (
  orbs: LoadedOrbs,
  load: (assetPath: string) => Promise<LoadedMesh> = (assetPath) => loadMesh(assetUrl(assetPath)),
): Promise<void> => {
  // Inside the chain, so a missing asset base (`assetUrl` throws) is a failed
  // fetch like any other rather than an unhandled rejection.
  const loaded = await Promise.resolve()
    .then(() => load(ORB_MESH))
    .catch((err: unknown) => {
      console.warn(
        `[orb-art] ${ORB_MESH} did not load, so the orbs fly as the port's stand-in (DEV-327): ${(err as Error)?.message ?? String(err)}`,
      )
      return null
    })
  orbs.setArt(loaded?.object ?? null)
  loaded?.dispose()
}
