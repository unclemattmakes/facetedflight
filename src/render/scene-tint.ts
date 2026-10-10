// src/render/scene-tint.ts — a colour filter over the world, authored per
// mission. DEV-446.
//
// Matt, 2026-09-27: *"would like to be able to "tint" the overall scene color -
// similar to how i did in 2016."*
//
// ── What 2016 had, and therefore what this is ────────────────────────────
//
// **Nothing that tints the whole frame.** DEV-446's row has the walk: every
// camera on the shipped rig (`Prefabs/Cameras_gameplay.prefab`), every
// `m_Modifications` row the thirteen missions put on it, and every colour-
// correction script guid in the project. No shipped camera carries a colour
// grade, a curve, a lookup or an overlay; the one Unity effect that has a
// `tint` field lives only in a bought pack's example scenes. What 2016 DID
// author per scene is four colours — fog, sun, the sky's grey `_Tint` and the
// terrain's `_Color` — and every one of them is already ported.
//
// So Classic has no tint (its flag is off, like every Classic flag), and this is
// an Anniversary tool: a colour Matt can put over the world, per mission, that
// **defaults to identity** — `content/editions/anniversary.json` ships
// `render.sceneTint` on with a neutral default and no missions, so not one pixel
// moves until he authors a value. `?lookdev=1` is where he authors it.
//
// ── Per MISSION, because that is where 2016 authored its colour ─────────
//
// Of the four levers above, the three that set a scene's mood — fog, sun, sky —
// are per-mission in 2016 (CLAUDE.md: *"the sun is per-MISSION, not
// per-environment"*); only the terrain's albedo is per-environment. A tint is a
// mood, so it keys on the level id, with a default for every level the block
// does not name. A new mission gets the default with no `src/` change (hard
// rule 6).
//
// ── What the tint IS: a luma-preserving colour filter ────────────────────
//
// `{ color, strength }`. The colour's HUE and SATURATION are what it tints
// toward; its brightness does not matter, because the gain is the colour
// divided by its own Rec. 709 luma — so a neutral pixel keeps its luma exactly
// and only its hue moves. `strength` is how far, 0 (nothing) to 1 (all the way).
// The level of the frame is `render.exposure`'s job, and keeping the two apart
// is what lets the tint be argued about as a colour.
//
//     gain = mix(1, color / luma(color), strength),  each channel in [0, 2]
//
// The multiply is on the DISPLAYED frame — after the tone curve and the sRGB
// encode — so the colour means what the picker shows: a filter held over the
// picture. That is also what makes it the SAME filter on all three render paths
// (below), which a multiply in linear light could not be.
//
// ── How it is drawn: one blended quad, and only when it has work ─────────
//
// The same shape as `render/vignette.ts`: a clip-space quad with no camera
// matrices, so it fills whichever viewport is being drawn — each eye gets its
// own in a headset for free — and cannot clip against the near plane. It blends
// `dst × src × 2` (`DstColor`, `SrcColor`) and writes `gain / 2`, so a gain of
// up to 2 fits in a source that clamps at 1: a warm tint can LIFT red rather
// than only pull the other two down.
//
// **At identity it is not drawn at all** — `visible` is false, so it costs no
// draw call and no fill, which is every mission on both presets today. Why not
// ride the vignette's quad, which the vignette's own header calls the only
// full-screen quad in the game: that quad alpha-blends (`src·a + dst·(1−a)`),
// and a multiply cannot be written in that blend. Why not a term in the
// materials' shared patches: there is no patch every world material shares —
// the widest, the fog, is applied material by material (`applyAtmosphere` in
// `boot/app.ts`: the land, the sea, the props, the clouds, the racers) and the
// sky dome is a plain `MeshBasicMaterial` it never touches — and adding one to
// every material would re-key every program in the game for a feature that
// ships at identity. One blended draw per eye, only while a tint is authored,
// is the smaller cost; DEV-446's row has the measurement.
//
// ── Where it sits in the frame, and why that is one number ───────────────
//
// It is `toneMapped: false`, which is `render/tone.ts`'s line for *"a surface
// that exists to modify the frame rather than to be in the world"* — and that
// flag is exactly what `render/bloom.ts` classifies onto the UI layer. So:
//
//  * **Flat Anniversary (the bloom composite):** the world goes through the
//    composer to the canvas, tone-mapped and encoded; then the UI pass draws
//    this FIRST — its `renderOrder` is below every UI surface — so it multiplies
//    the finished world and nothing after it.
//  * **In a headset, and on any frame the composer refuses:** one pass, and
//    three sorts the transparent list by `renderOrder`. `SCENE_TINT_ORDER` is
//    below the lowest UI surface a mission draws (the comfort horizon, 5) and
//    above every world transparent at the default 0, so the world is under it
//    and the HUD, the plates and the vignette are over it.
//
// **The one asymmetry, stated:** in the single pass, the two world transparents
// that sort ABOVE 4.5 — the motes (9) and the particles (10) — draw after the
// filter and keep their own colour; in the composite they are in the world pass
// and are tinted. Both are small additive light. Moving them would move two
// files that are not this row's.

import * as THREE from 'three'
import type { EditionSceneTint, SceneTintValue } from '@/content/edition-schema'
import { clamp } from '@/sim/math/scalar'

/** No tint: any colour at strength 0. The shipped default. */
export const SCENE_TINT_IDENTITY: SceneTintValue = Object.freeze({
  color: Object.freeze([1, 1, 1] as const),
  strength: 0,
})

/**
 * Rec. 709 luma weights. The quad multiplies DISPLAYED values, so the luma a
 * neutral pixel keeps is Y', the video one — not the linear-light Y.
 */
export const LUMA_709 = Object.freeze([0.2126, 0.7152, 0.0722] as const)

/**
 * The most one channel may be lifted. The blend is `2 × src × dst` and the
 * source clamps at 1 in an 8-bit target, so 2 is the ceiling the hardware has,
 * not a taste.
 */
export const MAX_GAIN = 2

/**
 * Below this luma a colour has no hue worth dividing out, so the division stops
 * growing and a colour dragged all the way to black DARKENS instead of blowing
 * up. Continuous: above it the colour's brightness does not matter at all.
 */
export const MIN_LUMA = 0.01

/**
 * A gain this close to 1 moves no pixel of an 8-bit frame: at the brightest
 * value, 255, it is a quarter of a level, which rounds away. Closer than this
 * the quad is not drawn.
 */
export const IDENTITY_EPSILON = 1 / 1024

/**
 * Where the filter sorts in a single-pass frame. See the header: below the
 * comfort horizon (5, the lowest UI surface a mission draws) and above every
 * world transparent at the default 0. `tests/unit/scene-tint.test.ts` holds it
 * against the horizon and the vignette, and `tests/e2e/scene-tint.spec.ts`
 * against every UI surface in a live mission.
 */
export const SCENE_TINT_ORDER = 4.5

/**
 * The per-channel gain a value asks for. Pure, three-free, node-testable.
 *
 * Writes into `out` and returns it, so the per-frame call allocates nothing.
 */
export const sceneTintGain = (
  value: SceneTintValue,
  out: [number, number, number] = [1, 1, 1],
): [number, number, number] => {
  const [r, g, b] = value.color
  const luma = Math.max(LUMA_709[0] * r + LUMA_709[1] * g + LUMA_709[2] * b, MIN_LUMA)
  const s = clamp(value.strength, 0, 1)
  out[0] = clamp(1 + (r / luma - 1) * s, 0, MAX_GAIN)
  out[1] = clamp(1 + (g / luma - 1) * s, 0, MAX_GAIN)
  out[2] = clamp(1 + (b / luma - 1) * s, 0, MAX_GAIN)
  return out
}

/** True when a gain would move no pixel. */
export const isIdentityGain = (gain: readonly number[]): boolean =>
  gain.every((g) => Math.abs(g - 1) < IDENTITY_EPSILON)

/**
 * The value a level gets from the preset: its own row if the block names it,
 * the block's default if not, and identity when the feature is off — Classic,
 * a `vr.disable`, or `?feature=render.sceneTint:off`.
 */
export const resolveSceneTint = (
  block: EditionSceneTint,
  levelId: string | null | undefined,
): SceneTintValue => {
  if (!block.enabled) return SCENE_TINT_IDENTITY
  if (levelId && Object.hasOwn(block.missions, levelId)) {
    return block.missions[levelId] as SceneTintValue
  }
  return block.default
}

export interface SceneTintReport {
  /** Per-channel gain on the displayed frame. `[1, 1, 1]` is none. */
  readonly gain: readonly [number, number, number]
  /** Whether the quad is in the draw list this frame. */
  readonly drawn: boolean
  /** The lookdev value, or null when the preset's is live. */
  readonly override: SceneTintValue | null
}

export interface SceneTint {
  readonly object: THREE.Mesh
  /**
   * Once a frame. `onScreen` is whether a mission's world is what is being
   * drawn — the title and the hangar are other scenes, and a tint is a
   * mission's. Cheap when nothing moved: a lookup, nine multiplies and a
   * comparison.
   *
   * `course` (DEV-476) is a player course's own tint, saved in the course:
   * when given it stands in for the preset's value for that level (`missions`
   * or `default`), so it is applied on that course only. The lookdev override
   * still wins over it, and the flag still gates it: on Classic, or with the
   * feature off, no course tints the frame either.
   */
  update(
    block: EditionSceneTint,
    levelId: string | null | undefined,
    onScreen: boolean,
    course?: SceneTintValue | null,
  ): void
  /**
   * The authoring value (`?lookdev=1`, the `__ff2` handle). Wins over the
   * preset's while set; `null` hands back to it. It does NOT outrank the flag:
   * on Classic, or with the feature switched off, the frame stays untinted,
   * because Classic is 2016 and 2016 had none.
   */
  setOverride(value: SceneTintValue | null): void
  readonly report: SceneTintReport
  dispose(): void
}

const VERTEX = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

// Half the gain, because the blend doubles it. Nothing else: the value is
// already in the displayed frame's units, so there is no transfer function to
// apply and no colour-space chunk to include.
const FRAGMENT = /* glsl */ `
uniform vec3 uHalfGain;
void main() {
  gl_FragColor = vec4(uHalfGain, 1.0);
}
`

export const createSceneTint = (): SceneTint => {
  const uniforms = { uHalfGain: { value: new THREE.Vector3(0.5, 0.5, 0.5) } }
  const material = new THREE.ShaderMaterial({
    name: 'scene-tint',
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    // The line `render/tone.ts` states and `render/bloom.ts` classifies on: this
    // modifies the frame rather than being in it. It is also what puts the quad
    // in the composite's UI pass, AFTER the tone curve — see the header.
    toneMapped: false,
    // dst' = src·dst + dst·src = 2·src·dst. Alpha is left exactly as it was.
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.DstColorFactor,
    blendDst: THREE.SrcColorFactor,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  })
  // The geometry IS the viewport: positions are already ±1 and pass straight
  // through as NDC, as the vignette's do.
  const geometry = new THREE.PlaneGeometry(2, 2)
  const object = new THREE.Mesh(geometry, material)
  object.name = 'scene-tint'
  // Its transform is meaningless (clip space), so a bounding sphere at the
  // origin would cull it a kilometre out. Correctness, not optimisation.
  object.frustumCulled = false
  object.renderOrder = SCENE_TINT_ORDER
  object.castShadow = false
  object.receiveShadow = false
  object.visible = false

  const gain: [number, number, number] = [1, 1, 1]
  let override: SceneTintValue | null = null

  return {
    object,
    update(block, levelId, onScreen, course = null) {
      const value = block.enabled ? (override ?? course ?? resolveSceneTint(block, levelId)) : null
      if (value) sceneTintGain(value, gain)
      else gain.fill(1)
      object.visible = onScreen && !isIdentityGain(gain)
      uniforms.uHalfGain.value.set(gain[0] / 2, gain[1] / 2, gain[2] / 2)
    },
    setOverride(value) {
      override = value
    },
    get report(): SceneTintReport {
      return { gain: [gain[0], gain[1], gain[2]], drawn: object.visible, override }
    },
    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}
