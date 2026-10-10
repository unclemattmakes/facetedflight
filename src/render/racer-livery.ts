// src/render/racer-livery.ts — every AI racer in its own colour, painted the
// way 2016 painted its own. DEV-350.
//
// Matt, 2026-09-24, on his before-shipping list: *"replace ai 'ghosts' as ai
// 'racers' - solid shaded, different coloration than the player's orange
// hoverjet."*
//
// ── The orange is in the VERTEX COLOURS, and 2016 says so ────────────────
//
// `hoverjet-exterior.glb` is one mesh, one material and no texture. The
// material is Maya's `lambert1`, which `render/lambert1.ts` repaints with the
// shipped `.mat`'s near-white `_Color` — a multiplier, the same on every face.
// So the livery can only be in `COLOR_0`, and it is: 115 of the hull's 1,144
// vertices are orange, and every other vertex is a grey or a pale cyan.
//
// And 2016 repainted a hull through exactly that channel. `GhostRacer.prefab`,
// its AI racer, wears `hoverJet_exterior_blue.fbx` under the SAME
// `lambert1.mat` the player's orange hull wears — opaque, `m_CastShadows: 1`.
// The blue is only in the FBX's vertex colours, and its main panel is the
// orange panel with the HSL hue turned from 25.2 to 210.8 degrees and the
// saturation (0.569) and lightness (0.450) untouched, to the ninth digit:
//
//     orange  (0.705882370, 0.408867717, 0.193771616)
//     blue    (0.193771616, 0.443134129, 0.705882370)
//
// So a repaint here is that operation — a turn of the hue, in the FBX's own
// sRGB. DEV-350's palette led with that blue; since its follow-up (Matt,
// 2026-09-25: *"bright rainbow colors"*) the palette is a rainbow with the
// orange left out, and its blue keeps GhostRacer's hue, brightened.
// `tests/unit/racer-livery.test.ts` pins both triples and the claim, and holds
// every palette colour clear of the player's orange in OKLab, under neutral
// light and under `int_01`'s 4-degree sun.
//
// ── Which vertices are livery ───────────────────────────────────────────
//
// Hue within `LIVERY_HUE_TOLERANCE_DEG` of the panel's, and saturation at
// least `LIVERY_MIN_SATURATION`. Measured on the shipped GLB, which the test
// sweeps vertex by vertex whenever it is on disk: every orange vertex sits
// between 20 and 26 degrees at a saturation above 0.45, and the hull's warm
// greys, which share that hue, stay below 0.1. The cyan is 155
// degrees away. Both thresholds sit in an empty gap, and the sweep asserts the
// gap is still empty rather than only that a count came out right.
//
// **One deliberate difference from 2016's blue hull**: it turned the main
// panel and left a family of darker accents orange — (0.8256, 0.3376, 0.0279)
// and its shades, 138 face-corners of them against the blue's 156. This turns
// those too, each by the same amount, because the ask is a racer that is not
// the player's colour and half an orange ship is still an orange ship.
// DEV-350's row records it.
//
// ── How a vertex is repainted ────────────────────────────────────────────
//
// In HSL, relative to the panel: the hue moves by (target − panel), and the
// saturation and lightness scale by (target / panel). For 2016's blue both
// ratios are 1 and it is a pure turn; for a lighter or a grey target the
// accents keep their relationship to the panel instead of collapsing onto it.
// The GLB's `COLOR_0` is linear (glTF's rule, and what the converter wrote:
// 0.7059 in the FBX is 0.4564 in the GLB), so each vertex goes back to sRGB,
// is turned where 2016 turned it, and comes forward again. The racer's hull is
// then in whatever space the player's is, which is the point: the same
// channel, carrying a different colour.
//
// ── What this file does NOT touch ────────────────────────────────────────
//
// The player's hull (`paintLivery` clones the attribute it writes, so a GLB
// that ever shared its buffer with another load could not leak a repaint into
// the player's ship); the wing's glow (DEV-322 — `glowyMaterial`, on every
// ship, in both looks); and Classic, where the racers wear the hologram and a
// hologram does not read vertex colour at all.

import * as THREE from 'three'
import { hexToSrgb, srgbToHex } from '@/content/colour-hex'
import { HOVER_GLOW_NAMES } from '@/render/hover-glow'
import { linearToSrgb, srgbToLinear } from '@/render/unity-space'
import { clamp01 } from '@/sim/math/scalar'

// The forward transfer function lives in `unity-space.ts`; this module has always exported it.
export { linearToSrgb }

/** An sRGB triple, 0..1 — the units the palette is authored in and 2016's FBX carries. */
export type Srgb = readonly [number, number, number]

/**
 * The player's livery panel: `hoverJet_exterior_orange.fbx`'s
 * `LayerElementColor`, the most-used saturated triple. Full precision, as the
 * FBX stores it; `tools/extract/fbx-bounds.mjs`'s `parseFbx` reads it.
 */
export const LIVERY_PANEL_SRGB: Srgb = [0.70588237, 0.408867717, 0.193771616]

/**
 * `GhostRacer.prefab`'s hull, `hoverJet_exterior_blue.fbx`: the same panel,
 * blue. The evidence that a livery is a hue turn, and the hue of the rainbow
 * palette's blue (DEV-350 follow-up).
 */
export const GHOST_RACER_BLUE_SRGB: Srgb = [0.193771616, 0.443134129, 0.70588237]

/**
 * How far a vertex's hue may sit from the panel's and still be livery.
 *
 * The livery lies within 6 degrees of the panel; the nearest SATURATED colour
 * on the hull that is not livery is that cyan, 155 away. Thirty is far
 * from both.
 */
export const LIVERY_HUE_TOLERANCE_DEG = 30

/**
 * The least saturation a livery vertex has.
 *
 * The livery's least is above 0.45 and the warm greys' most is below 0.1 — the
 * greys share the orange's HUE, so this is the threshold that actually
 * separates. `racer-livery.test.ts` holds both sides of the gap.
 */
export const LIVERY_MIN_SATURATION = 0.3

// ── colour maths ─────────────────────────────────────────────────────────

/** [hue degrees 0..360, saturation 0..1, lightness 0..1]. */
export type Hsl = readonly [number, number, number]

export const rgbToHsl = (c: Srgb): Hsl => {
  const [r, g, b] = c
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return [0, 0, l]
  const s = d / (1 - Math.abs(2 * l - 1))
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [(h * 60 + 360) % 360, s, l]
}

export const hslToRgb = (hsl: Hsl): [number, number, number] => {
  const [h, s, l] = hsl
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const m = l - c / 2
  const [r, g, b] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x]
  return [r + m, g + m, b + m]
}

const PANEL_HSL = rgbToHsl(LIVERY_PANEL_SRGB)

/** Shortest distance between two hues, degrees. */
const hueDistance = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

/** Is this sRGB colour part of the player's livery? */
export const isLivery = (c: Srgb): boolean => {
  const [h, s] = rgbToHsl(c)
  return s >= LIVERY_MIN_SATURATION && hueDistance(h, PANEL_HSL[0]) <= LIVERY_HUE_TOLERANCE_DEG
}

/**
 * One livery colour, repainted so the PANEL lands on `target`.
 *
 * Relative to the panel, so every shade of the livery keeps its place: the hue
 * moves by the panel's move, the saturation and lightness scale by the
 * panel's ratio. Handed the panel itself it returns `target`.
 */
export const repaintSrgb = (c: Srgb, target: Srgb): [number, number, number] => {
  const [h, s, l] = rgbToHsl(c)
  const [ht, st, lt] = rgbToHsl(target)
  const [hp, sp, lp] = PANEL_HSL
  return hslToRgb([h + (ht - hp), clamp01((s * st) / sp), clamp01((l * lt) / lp)])
}

/** `#rrggbb`, which is what a canvas `fillStyle` and a console line both read. */
export const srgbHex = (c: Srgb): string => srgbToHex(c)

/**
 * `#rrggbb` to sRGB 0..1, the palette's units — {@link srgbHex} backwards. The
 * lesson's instructor colour is authored this way (`lesson.instructor.colour`),
 * and both the instructor's paint (`game/lesson-session.ts`) and its hull on
 * the Flight School table (`render/mode-mark.ts`, DEV-379) read it through here.
 */
export const hexSrgb = (hex: string): Srgb => hexToSrgb(hex)

/** The palette's colour for racer `i`, wrapping — a content number is not a code limit. */
export const paletteColour = (palette: readonly Srgb[], i: number): Srgb => {
  if (palette.length === 0) throw new Error('racer-livery: an empty palette paints nobody')
  return palette[i % palette.length] as Srgb
}

// ── the hull ─────────────────────────────────────────────────────────────

/**
 * Repaint the livery on every mesh under `root`. Returns how many vertices
 * took the colour.
 *
 * Call it on the HULL before the wing is attached: the projectors carry
 * vertex colours of their own and are not livery.
 *
 * The colour attribute is REPLACED, never written in place: a copy of the
 * source — same array type, same normalisation, same item size, so every
 * vertex that is not livery keeps its exact bits and the program (which keys
 * on `vertexAlphas`) is the one the player's hull compiles. A mesh that shared
 * the source attribute keeps it untouched.
 */
export const paintLivery = (root: THREE.Object3D, target: Srgb): number => {
  let painted = 0
  root.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    const source = mesh.geometry.getAttribute('color') as
      | THREE.BufferAttribute
      | THREE.InterleavedBufferAttribute
      | undefined
    if (!source) return
    // `clone` copies the array. An interleaved attribute would clone its whole
    // shared buffer, so that shape is copied out by value instead; no GLB this
    // game ships interleaves its colours today.
    const out =
      'isInterleavedBufferAttribute' in source && source.isInterleavedBufferAttribute
        ? new THREE.Float32BufferAttribute(
            Array.from({ length: source.count * source.itemSize }, (_, k) =>
              source.getComponent(Math.floor(k / source.itemSize), k % source.itemSize),
            ),
            source.itemSize,
          )
        : (source as THREE.BufferAttribute).clone()
    const srgb: [number, number, number] = [0, 0, 0]
    for (let i = 0; i < source.count; i++) {
      srgb[0] = linearToSrgb(source.getX(i))
      srgb[1] = linearToSrgb(source.getY(i))
      srgb[2] = linearToSrgb(source.getZ(i))
      if (!isLivery(srgb)) continue
      const next = repaintSrgb(srgb, target)
      out.setXYZ(i, srgbToLinear(next[0]), srgbToLinear(next[1]), srgbToLinear(next[2]))
      painted++
    }
    mesh.geometry.setAttribute('color', out)
  })
  return painted
}

/**
 * The two looks a racer's hull can wear, and the switch between them.
 *
 * `solid` is what each mesh arrived with — the hull's own `lambert1` and the
 * wing's `Projector04_Mat`, exactly what the player's ship wears. `hologram`
 * is `racers.ts`'s `racerMaterial()`, the one Classic keeps. The wing's GLOW
 * is never switched: it wears `glowyMaterial` on every ship in both (DEV-322).
 */
export interface RacerLook {
  /** Wear the livery (true) or the hologram (false). */
  setSolid(on: boolean): void
  readonly solid: boolean
  /** The solid look's materials, for the fog and far-shadow doors. Deduplicated. */
  readonly solidMaterials: readonly THREE.Material[]
  /** Every mesh under the art, for the sun's map — the player's hull hands in the same set. */
  readonly shadowMeshes: readonly THREE.Mesh[]
  /** Disposes the SOLID materials. The hologram belongs to whoever made it. */
  dispose(): void
}

/**
 * Record `root`'s meshes and their own materials, then put it in one look.
 *
 * Call it once the art is complete — after `attachShipWings`, when there is a
 * wing — because only the meshes present now are switched.
 */
export const racerLook = (
  root: THREE.Object3D,
  hologram: THREE.Material,
  solid: boolean,
): RacerLook => {
  const switched: { mesh: THREE.Mesh; own: THREE.Material }[] = []
  const meshes: THREE.Mesh[] = []
  root.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    meshes.push(mesh)
    if (mesh.name === HOVER_GLOW_NAMES[1]) return
    switched.push({ mesh, own: mesh.material as THREE.Material })
  })
  const solidMaterials = [...new Set(switched.map((s) => s.own))]
  let wearing = !solid
  const look: RacerLook = {
    setSolid(on) {
      if (on === wearing) return
      wearing = on
      for (const s of switched) s.mesh.material = on ? s.own : hologram
    },
    get solid() {
      return wearing
    },
    solidMaterials,
    shadowMeshes: meshes,
    dispose() {
      for (const m of solidMaterials) m.dispose()
    },
  }
  look.setSolid(solid)
  return look
}
