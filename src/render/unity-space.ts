// src/render/unity-space.ts — the one definition of the coordinate conversion.
//
// FF2 has two coordinate systems and they are both load-bearing:
//
//   **Unity space**, left-handed, +Z forward. The sim lives here, and so does
//   the terrain generator's output. That is not nostalgia — it is what makes the
//   flight model comparable with the 2016 constants (thrust really is along body
//   +Z, `FacetedTerrain`'s vertices really do run 0..TerrainSize) and what lets
//   the oracle sweep diff generated chunks against the baked ones directly.
//
//   **three space**, right-handed, -Z forward. Everything the renderer touches,
//   and — importantly — everything in `content/levels/*.json`, which the level
//   extractor already converted.
//
// So content arrives in three space and has to go INTO the sim converted, and
// sim state has to come OUT converted. Two conversions, opposite directions,
// and both easy to forget in exactly the way that looks fine at first:
//
//   * Seed the ship with a three-space spawn quaternion and it thrusts along
//     three's BACKWARD. It flies, it handles, it just leaves the course behind
//     it.
//   * Draw a Unity-space mesh without converting and the world is mirrored. It
//     still looks like the world (CLAUDE.md's warning), until the rings turn
//     out to be over water.
//
// Both of those have now happened, which is why this file exists rather than a
// negated `z` at each call site.
//
// ── The conversion ────────────────────────────────────────────────────────
//
//   position:   (x, y, z)     ->  (x, y, -z)
//   quaternion: (x, y, z, w)  ->  (-x, -y, z, w)
//
// Determinant -1, so it is a reflection: any MESH that goes through it must
// also have its triangle winding reversed (`render/terrain-mesh.ts` does that).
// Both operations are their own inverse, which is why there is one function per
// kind rather than two.
//
// Matches `tools/extract/level.mjs`'s `toThreePos` / `toThreeQuat` exactly. If
// one changes, the other has to, and `tests/unit/unity-space.test.ts` asserts
// they agree against a level file the extractor produced.

import * as THREE from 'three'

export interface Vec3Like {
  x: number
  y: number
  z: number
}

export interface QuatLike {
  x: number
  y: number
  z: number
  w: number
}

/**
 * Convert a position between Unity and three space. **Its own inverse** — the
 * same call converts either way, which is why the name says "flip" rather than
 * naming a direction it cannot enforce.
 */
export const flipPosition = <T extends Vec3Like>(out: T, p: Vec3Like): T => {
  out.x = p.x
  out.y = p.y
  out.z = -p.z
  return out
}

/** Convert an orientation between Unity and three space. Its own inverse. */
export const flipQuaternion = <T extends QuatLike>(out: T, q: QuatLike): T => {
  out.x = -q.x
  out.y = -q.y
  out.z = q.z
  out.w = q.w
  return out
}

/** Read a `[x, y, z]` tuple from level JSON into a Unity-space vector. */
export const threeTupleToUnity = <T extends Vec3Like>(out: T, t: readonly number[]): T => {
  out.x = t[0] as number
  out.y = t[1] as number
  out.z = -(t[2] as number)
  return out
}

/** Read an `[x, y, z, w]` tuple from level JSON into a Unity-space quaternion. */
export const threeQuatTupleToUnity = <T extends QuatLike>(out: T, t: readonly number[]): T => {
  out.x = -(t[0] as number)
  out.y = -(t[1] as number)
  out.z = t[2] as number
  out.w = t[3] as number
  return out
}

// The three helpers below are the same flip as the tuple readers above, spelled
// for the other direction (a Unity-space value read INTO three space) and for
// the shapes sheet and prefab data arrive in: optional fields and short tuples.
// A missing component is 0 (w is 1), exactly as the call sites they replace
// defaulted it, so none of them is a different rule. `tests/unit/unity-flips.test.ts`
// holds each replaced inline expression as an oracle and compares bit for bit.

/** A Unity-space position tuple (possibly absent or short) as a three-space vector. */
export const unityPositionTupleToThree = (
  t: readonly number[] | undefined,
  out: THREE.Vector3 = new THREE.Vector3(),
): THREE.Vector3 => out.set(t?.[0] ?? 0, t?.[1] ?? 0, -(t?.[2] ?? 0))

/** A Unity-space `{x, y, z}` (possibly absent, fields optional) as a three-space vector. */
export const unityVecToThree = (
  v: { readonly x?: number; readonly y?: number; readonly z?: number } | undefined,
  out: THREE.Vector3 = new THREE.Vector3(),
): THREE.Vector3 => out.set(v?.x ?? 0, v?.y ?? 0, -(v?.z ?? 0))

/** A Unity-space `[x, y, z, w]` tuple (possibly short) as a three-space quaternion. */
export const unityQuatTupleToThree = (
  q: readonly number[],
  out: THREE.Quaternion = new THREE.Quaternion(),
): THREE.Quaternion => out.set(-(q[0] ?? 0), -(q[1] ?? 0), q[2] ?? 0, q[3] ?? 1)

/** Apply a Unity-space pose to a three object, converting on the way. */
export const applyUnityPose = (
  object: THREE.Object3D,
  position: Vec3Like,
  orientation: QuatLike,
): void => {
  object.position.set(position.x, position.y, -position.z)
  object.quaternion.set(-orientation.x, -orientation.y, orientation.z, orientation.w)
}

/**
 * Compose a Unity-space TRS into a three-space matrix.
 *
 * Everything the extractor writes is in UNITY space — that is the rule, so the
 * one flip lives here rather than scattered through `tools/extract`. Prefab-local
 * parts (a gate's frame and studs, a turn indicator's arrow and bars) therefore
 * arrive as Unity TRS triples that have to be flipped and then composed with
 * their instance's world matrix.
 *
 * ── Why composing FLIPPED poses is the same as flipping the composite ─────
 *
 * It matters, because the turn indicator's bars are children of a node that is
 * itself transformed, so the port multiplies two independently-flipped matrices
 * and has to know that is legitimate.
 *
 * It is, and the reason is that the handedness flip is a CONJUGATION. Writing
 * `F = diag(1, 1, -1)`, a Unity matrix `M` becomes `F·M·F⁻¹` in three space, and
 * conjugation distributes over products:
 *
 *     F·(A·B)·F⁻¹  =  (F·A·F⁻¹)·(F·B·F⁻¹)
 *
 * `flipPosition` (negate z) and `flipQuaternion` (negate x and y) are exactly
 * that conjugation applied to a translation and a rotation, and a diagonal scale
 * commutes with `F` untouched. So a chain of flipped local poses composes to the
 * same thing as flipping the chain — which is what lets a nested prefab be
 * rebuilt one node at a time.
 *
 * Note the corollary: a rotated child under a NON-UNIFORMLY scaled parent is a
 * shear, and it survives the flip intact. Keep the multiplication; do not try to
 * collapse such a pair into a single TRS.
 */
export const unityPose = (
  position: readonly number[],
  rotation: readonly number[],
  scale: readonly number[],
  out: THREE.Matrix4 = new THREE.Matrix4(),
): THREE.Matrix4 =>
  out.compose(
    flipPosition(new THREE.Vector3(), {
      x: position[0] as number,
      y: position[1] as number,
      z: position[2] as number,
    }),
    flipQuaternion(new THREE.Quaternion(), {
      x: rotation[0] as number,
      y: rotation[1] as number,
      z: rotation[2] as number,
      w: rotation[3] as number,
    }),
    new THREE.Vector3(scale[0] as number, scale[1] as number, scale[2] as number),
  )

/**
 * The sRGB electro-optical transfer function — Unity's own, exactly.
 *
 * A material property declared `Color` (rather than `Vector`) in a shader's
 * Properties block is converted by Unity on upload when the project is Linear,
 * and `int_01`'s is (`m_ActiveColorSpace: 1`). So a colour read out of a `.mat`
 * has to come through here before it reaches a three material, and a colour
 * read out of a VERTEX stream must not (DEV-014) — the two paths differ.
 *
 * This is the one definition: four private copies (`game/rings.ts`,
 * `game/turn-indicators.ts`, `render/terrain-mesh.ts`, `render/hud-fuel.ts`)
 * were folded onto it by the code-reuse audit (RC-5). `render/sky.ts` and
 * `render/unity-fog.ts` keep a private pair ON PURPOSE: `unity-fog.ts` says why
 * (two different reasons for the same number; the horizon seams if one moves).
 */
export const srgbToLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4

/** sRGB's transfer function, forward: the inverse of {@link srgbToLinear}. */
export const linearToSrgb = (c: number): number =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055
