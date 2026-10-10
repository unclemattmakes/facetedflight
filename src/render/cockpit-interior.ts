// src/render/cockpit-interior.ts — the cabin, lit, and somebody in it.
//
// ANNIVERSARY.md §3.2 V8, DEV-088. Everything here is behind
// `cockpit.lighting.enabled` / `cockpit.body.enabled`: on Classic nothing is
// constructed, nothing is added to the scene graph, and the ship's material is
// not touched. That is stricter than "the flag is off" and it is what the word
// Classic has to mean.
//
// ── Why the interior needed anything at all ───────────────────────────────
//
// The canopy struts rendered as flat near-black polygons. Three things multiply
// to produce that, and DEV-088 has the arithmetic:
//
//  1. their own `COLOR_0` is 0.1559 grey — 2016's interior IS a dark frame;
//  2. the GLB carried MAYA's `lambert1` (0.5 grey) instead of Unity's
//     (0.822 sRGB), so every facet was 1.28-1.42x too dark. **That is a bug and
//     it is fixed for BOTH presets** — `render/lambert1.ts`;
//  3. indoors, the only diffuse light in the game is the Skyshop probe at
//     intensity 0.5974, because `suppressEnvMapDiffuse` (DEV-008) takes the env
//     map's diffuse out GLOBALLY and correctly — and the mission sun is 4
//     degrees above the horizon and rakes the OUTSIDE of the hull.
//
// (3) is not a bug. There is genuinely almost no light inside a closed canopy at
// sunset, and 2016 had the same probe. What 2016 also had, and we do not, is a
// bloom pass and a `CockpitLight` tag. This is the Anniversary answer: put a
// little light in the cabin, where a cabin would have some.
//
// ── Why two point lights and not a layer ──────────────────────────────────
//
// The tempting shape is "a light restricted to the cockpit's layer". It does
// not exist in three. `WebGLRenderer.projectObject` gathers a light inside
// `if ( object.isLight && object.layers.test( camera.layers ) )`
// (`three.module.js:17387`) and then every gathered light lights every lit
// material — there is no per-object light mask. So a layer can only turn the
// light OFF for the camera, which is DEV-043's trap exactly and not a scoping
// mechanism. Two `PointLight`s with a small `distance` and `decay: 2` are the
// honest version: their falloff is what confines them, and nothing else in the
// game is within a metre of the pilot's seat.
//
// **They cost one program recompile each, once.** `NUM_POINT_LIGHTS` is a
// `#define`, so going from zero point lights to two invalidates every lit
// material's program — at boot on Anniversary, and again on each preset flip.
// That is a one-frame hitch on a flip, not a per-frame cost, and it is the same
// bill `attachEditionTone` pays (DEV-081's last section explains why three
// handles the invalidation itself).
//
// ── What it must never touch ──────────────────────────────────────────────
//
// The XR RIG, the camera, the near plane, and the HUD's placement. The lights
// and the body hang off the ART PIVOT, which is the node DEV-083's buffet and
// DEV-010's lean already move and which the camera does not inherit — so the
// cabin leans with the cockpit around a still head, which is what 2016 did with
// the pilot and the chair (they are under `art_pivot` in the prefab too).

import * as THREE from 'three'
import type { EditionCockpit, EditionCockpitLight } from '@/content/edition-schema'
import { buildCockpitBody, type CockpitBody } from './cockpit-body'
import { forEachUniqueMaterial } from './scene-walk'

/**
 * DEV-640: the cabin lamps' boost glow. A warm amber the lamp's own colour is
 * brought `mix` of the way toward, and a share of its intensity added, both
 * scaled by the glow level (0..1). The lamps are the ones already in the scene,
 * so the light COUNT is unchanged and nothing recompiles. LINEAR rgb. The shell's
 * emissive is a uniform, so it recompiles nothing either.
 */
export const BOOST_GLOW = {
  color: [1, 0.42, 0.12] as readonly number[],
  mix: 0.65,
  intensityGain: 1.1,
  /**
   * The same amber added to the cockpit shell's own `emissive` at full glow
   * (LINEAR, a share of the colour). Because the cabin point lights are OFF in
   * both shipped presets (`cockpit.lighting.enabled` is false since 2026-09-21,
   * Matt: "we don't need the cockpit point lights"), the lamps alone would
   * glow nothing; the shell's emissive is what the player sees warm.
   */
  emissiveGain: 0.08,
} as const

export interface CockpitInterior {
  /**
   * Parent this to the ART PIVOT. It is placed at the EYE by the caller, which
   * is the frame every number in the preset is expressed in.
   */
  readonly object: THREE.Object3D
  /** Apply the live preset. Idempotent, and cheap enough to call on every flip. */
  set(cockpit: EditionCockpit): void
  /**
   * Show or hide the cabin — the pilot and the chair — WITHOUT hiding the
   * lamps. DEV-186.
   *
   * `game/flight.ts` used to write `interior.object.visible` directly, and
   * three's `projectObject` opens `if ( object.visible === false ) return;`
   * (`three.module.js:17827`), so an invisible subtree contributes no lights.
   * Hiding the cabin therefore moved `numPointLights` 2 → 0 for the whole
   * scene, which bumps `WebGLLights`' `state.version`, which is the branch of
   * `needsProgramChange` that re-fetches a program for **every lit material in
   * the frame** — and the count is in the cache key, so the first press of a
   * session recompiled the island, the sea, the props and the ship.
   *
   * **Measured: 15 programs, 100 → 115** on one press of V
   * (`tests/e2e/view-toggle-compile.spec.ts`). `render/warm-up.ts` cannot help,
   * because it warms the count that is live when it runs, and that is 2.
   *
   * So the lamps stay in the scene and go to zero intensity instead. They cost
   * two `RE_Direct_Physical` evaluations on every lit fragment either way —
   * measured at 0.15 ms against a 0.19 ms drift, i.e. inside the noise
   * (`docs/plan/VR-PERF-WAVE-2-WORK.md` §7) — and that is the trade: a cost
   * too small to measure, against a compile storm that is not.
   */
  setShown(shown: boolean): void
  /**
   * DEV-640: the cabin lamps warm and brighten while boost burns, `level` 0..1
   * (the caller eases it). Both lamps, intensity and colour only: no light is
   * added or removed, so no program recompiles. A no-op with no lamps (Classic).
   * Survives `set` and `setShown`, which re-apply it.
   */
  setBoostGlow(level: number): void
  dispose(): void
}

/** Linear RGB off the preset, straight onto a `THREE.Color`. */
const linear = (rgb: readonly number[]): THREE.Color =>
  new THREE.Color().setRGB(rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0, THREE.LinearSRGBColorSpace)

const GLOW_COLOR = linear(BOOST_GLOW.color)

const applyLight = (
  light: THREE.PointLight,
  spec: EditionCockpitLight,
  shown: boolean,
  glow = 0,
): void => {
  light.color.copy(linear(spec.color))
  // DEV-640: a lamp warms toward amber and brightens while boost burns.
  if (glow > 0) light.color.lerp(GLOW_COLOR, BOOST_GLOW.mix * glow)
  // Zero rather than invisible: an invisible light is not in the scene's light
  // list at all, and the COUNT is what recompiles the world. See `setShown`.
  light.intensity = shown ? spec.intensity * (1 + BOOST_GLOW.intensityGain * glow) : 0
  light.distance = spec.distance
  light.decay = spec.decay
  light.position.set(spec.offset[0] ?? 0, spec.offset[1] ?? 0, spec.offset[2] ?? 0)
}

/**
 * The interior for one ship.
 *
 * `meshRoot` is the loaded cockpit GLB — the emissive floor goes on ITS material
 * and the original value is captured first, so a flip back to Classic restores
 * what the loader made rather than assuming black. (It is black today. Assuming
 * it is the kind of thing that is true until somebody adds a glowing decal.)
 *
 * Nothing is constructed until a preset asks for it: `createCockpitInterior`
 * followed by `set(classic)` adds no lights, no meshes and no material change.
 */
export const createCockpitInterior = (meshRoot: THREE.Object3D): CockpitInterior => {
  const object = new THREE.Group()
  object.name = 'cockpit_interior'

  // The materials the emissive floor is written to, and what they held before.
  const emissiveOriginals = new Map<THREE.Material & { emissive?: THREE.Color }, THREE.Color>()
  /** DEV-640: what each material's emissive is WITHOUT the boost glow, whichever preset wrote it. */
  const emissiveBase = new Map<THREE.Material & { emissive?: THREE.Color }, THREE.Color>()
  const glowEmissive = new THREE.Color()
  /** Put the glow's share on top of every shell material's base emissive. */
  const applyEmissiveGlow = (level: number): void => {
    glowEmissive.copy(GLOW_COLOR).multiplyScalar(BOOST_GLOW.emissiveGain * level)
    for (const [material, base] of emissiveBase) {
      material.emissive?.copy(base).add(glowEmissive)
    }
  }
  forEachUniqueMaterial(meshRoot, (m) => {
    const material = m as THREE.Material & { emissive?: THREE.Color }
    if (!material.emissive) return
    emissiveOriginals.set(material, material.emissive.clone())
    emissiveBase.set(material, material.emissive.clone())
  })

  let fill: THREE.PointLight | null = null
  let dash: THREE.PointLight | null = null
  let body: CockpitBody | null = null
  /**
   * The cabin's own node. Everything that is GEOMETRY hangs here; the lamps do
   * not, so `setShown` can hide one without hiding the other.
   *
   * LAZY, like the lamps and the body: Classic asks for none of the three and
   * *"adds no lights and no objects"* is a test, not a turn of phrase. An empty
   * `Group` is not drawn, but it is a `projectObject` visit and a child on a
   * node this file promises to leave alone.
   */
  let cabin: THREE.Group | null = null
  const cabinNode = (): THREE.Group => {
    if (cabin) return cabin
    cabin = new THREE.Group()
    cabin.name = 'cockpit_cabin'
    cabin.visible = shown
    object.add(cabin)
    return cabin
  }
  /** Is the cabin showing? `setShown`'s state, read back by `set`. */
  let shown = true
  /** The configured intensities, so `setShown` can restore them without the preset. */
  let fillIntensity = 0
  let dashIntensity = 0
  /** DEV-640: the boost glow in force, 0..1, and the specs it is applied over. */
  let glow = 0
  let fillSpec: EditionCockpitLight | null = null
  let dashSpec: EditionCockpitLight | null = null

  return {
    object,

    set(cockpit) {
      const lighting = cockpit.lighting
      if (lighting.enabled) {
        if (!fill) {
          // Named so they are findable in a scene inspector, and so the Classic
          // test can assert by name rather than by counting.
          fill = new THREE.PointLight()
          fill.name = 'cockpit_fill'
          dash = new THREE.PointLight()
          dash.name = 'cockpit_dash'
          object.add(fill, dash)
        }
        // `shown` re-applied here as well as in `setShown`, because the preset
        // can flip while the camera is outside and `applyLight` writes the
        // configured intensity back over the zero.
        fillIntensity = lighting.fill.intensity
        dashIntensity = lighting.dash.intensity
        fillSpec = lighting.fill
        dashSpec = lighting.dash
        applyLight(fill, lighting.fill, shown, glow)
        if (dash) applyLight(dash, lighting.dash, shown, glow)
        const emissive = linear(lighting.emissive.color).multiplyScalar(lighting.emissive.intensity)
        for (const [material, base] of emissiveBase) {
          base.copy(emissive)
          material.emissive?.copy(emissive)
        }
        if (glow > 0) applyEmissiveGlow(glow)
      } else {
        if (fill) {
          object.remove(fill)
          fill.dispose()
          fill = null
        }
        if (dash) {
          object.remove(dash)
          dash.dispose()
          dash = null
        }
        for (const [material, original] of emissiveOriginals) {
          emissiveBase.get(material)?.copy(original)
          material.emissive?.copy(original)
        }
        if (glow > 0) applyEmissiveGlow(glow)
      }

      if (cockpit.body.enabled) {
        if (!body) {
          body = buildCockpitBody()
          cabinNode().add(body.object)
        }
        body.set(cockpit.body)
      } else if (body) {
        cabin?.remove(body.object)
        body.dispose()
        body = null
      }
    },

    setShown(next) {
      if (shown === next) return
      shown = next
      if (cabin) cabin.visible = next
      // The lamps are NOT hidden — see the interface. Their spec is the live
      // preset's, so re-reading it is the caller's `set`; here the intensity is
      // simply scaled to nothing and restored by the next `set`.
      if (fill) fill.intensity = next ? fillIntensity * (1 + BOOST_GLOW.intensityGain * glow) : 0
      if (dash) dash.intensity = next ? dashIntensity * (1 + BOOST_GLOW.intensityGain * glow) : 0
    },

    setBoostGlow(level) {
      const next = level > 0 ? (level > 1 ? 1 : level) : 0
      if (next === glow) return
      glow = next
      if (fill && fillSpec) applyLight(fill, fillSpec, shown, glow)
      if (dash && dashSpec) applyLight(dash, dashSpec, shown, glow)
      applyEmissiveGlow(glow)
    },

    dispose() {
      fill?.dispose()
      dash?.dispose()
      body?.dispose()
      for (const [material, original] of emissiveOriginals) material.emissive?.copy(original)
      object.clear()
    },
  }
}
