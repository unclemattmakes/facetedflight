// src/render/lambert1.ts — 2016's ship material, which the glTF could not carry.
//
// ── The bug this exists to fix ────────────────────────────────────────────
//
// `hoverjet-cockpit.glb` and `hoverjet-exterior.glb` declare one material named
// `lambert1` with `baseColorFactor = [0.5, 0.5, 0.5, 1]`. That is **Maya's**
// `lambert1` — the default shader every Maya scene is born with, whose Color is
// 0.5 grey — carried through the FBX by the Blender exporter. It is not the
// material the game renders with.
//
// The shipped one is `Assets/Faceted Flight/Meshes/lowPolyArt/Materials/
// lambert1.mat`, shader `Marmoset/Vertex Color/Specular IBL`, and its diffuse
// is
//
//     _Color = (0.82233995, 0.83045423, 0.8602941)
//
// — a near-white with a cool cast. The port was rendering the whole ship at
// 0.5 grey, so every facet of it was **1.28 to 1.42x too dark** and had lost
// that cast. On the cockpit INTERIOR, whose own vertex colours are 0.04 to 0.16
// and which no sun reaches, that is the difference between a dark frame and a
// black one. DEV-088 has the measurement.
//
// ── The precedent, which is exact ─────────────────────────────────────────
//
// DEV-043, on the title logo: *"The glTF carries the geometry and the vertex
// colours. It does not carry the MATERIAL, and the material is where the colour
// lives."* `render/title.ts` fixes it there by painting the submeshes from the
// prefab's own `.mat` files. Four shipped GLBs still arrive with Maya's grey —
// `title-logo` (overridden in `title.ts`), `turn-indicator` (not), and the
// ship's two. This is the ship's half of the same fix.
//
// ── Why sRGB ─────────────────────────────────────────────────────────────
//
// `_Color` is declared `Color` in the shader's Properties block, and the 2016
// project is Linear (`m_ActiveColorSpace: 1`; the sheet's `terrain.*.ibl`
// records it as `linearSpace: true`). Unity converts a `Color` property from
// sRGB to linear on upload, so the number the shader multiplies by is
// **(0.6423, 0.6566, 0.7111)**. This is the same reading, on the same shader
// family, that `render/terrain-mesh.ts` applies to the terrain's `_Color` —
// and it is the reading the VERTEX colours deliberately do NOT get, because
// those were matched raw against the 2016 bake to 0.000000 (DEV-014).
//
// Not extracted, hand-carried with the file and the field cited, exactly as
// `title.ts` carries the logo's two: the extractor reads terrain and vehicle
// PHYSICS, not arbitrary prefab materials. `tests/unit/cockpit-interior.test.ts`
// asserts the round trip back to the serialised sRGB triple rather than to the
// linear one, so the assertion is against Unity's file and not against our own
// arithmetic repeated twice.

import * as THREE from 'three'
import { forEachUniqueMaterial } from './scene-walk'

/**
 * `lambert1.mat`'s `_Color`, exactly as serialised — sRGB 0..1.
 *
 * Kept in the file's own units so it can be diffed against the `.mat` by eye.
 * The conversion to the renderer's working space happens once, below.
 */
export const LAMBERT1_COLOR_SRGB: readonly [number, number, number] = [
  0.82233995, 0.83045423, 0.8602941,
]

/**
 * The rest of `lambert1.mat`, recorded and NOT yet ported.
 *
 * `_SpecInt` 0.25, `_Shininess` 3.85 (on the shader's `Range(2, 8)`), `_Fresnel`
 * absent from the file and therefore the shader's default 0, `_SpecColor` white.
 * Marmoset's specular/gloss model is DEV-008's queue and the terrain is the only
 * surface that has been through it; the ship keeps three's glTF roughness until
 * it gets there. Written down here so the next person does not have to re-read
 * the `.mat` to find out what was left.
 */
export const LAMBERT1_SPECULAR = Object.freeze({
  specInt: 0.25,
  shininess: 3.85,
  fresnel: 0,
  specColorSrgb: [1, 1, 1] as const,
})

/**
 * Put `lambert1.mat`'s diffuse on every material under `root`.
 *
 * Sets the colour and nothing else: the vertex colours, the roughness, the
 * double-sidedness and the emissive are all left as they arrived. A material
 * shared between meshes is only written once, which matters because both ship
 * GLBs are a single mesh with a single material and a traverse would otherwise
 * write it twice for no reason.
 *
 * Idempotent — `Color.setRGB` with the same arguments is a write of the same
 * three floats — so a caller that runs it twice loses nothing.
 */
export const applyLambert1 = (root: THREE.Object3D): void => {
  forEachUniqueMaterial(root, (material) => {
    const coloured = material as THREE.Material & { color?: THREE.Color }
    // `setRGB` with an explicit colour space rather than `setHex`: the triple
    // is three floats in the `.mat` and rounding it through eight-bit bytes to
    // write it as 0xd2d4db throws away precision for no gain.
    coloured.color?.setRGB(
      LAMBERT1_COLOR_SRGB[0],
      LAMBERT1_COLOR_SRGB[1],
      LAMBERT1_COLOR_SRGB[2],
      THREE.SRGBColorSpace,
    )
  })
}
