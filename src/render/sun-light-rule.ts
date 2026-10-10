// src/render/sun-light-rule.ts — which rule a mission's sun colour is drawn by.
// DEV-446 found it, DEV-454 ships it.
//
// Matt, 2026-09-27, on where 2016's scene tint lived: *"i think it was either on
// the main light, or part of the marmoset sky prefab."* Both, and they are one
// object: every `LevelArt_<env>.prefab` hangs a `Directional light` under its
// Skyshop sky (`sky/ibl_sky`), and each mission carries a disconnected copy of
// it — `int_01_hoverJet`'s is `Directional light (1)`, `&118365897`. Its colour
// is the per-mission tint 2016 authored. Then, on DEV-446's table: *"plz add
// the 2016 tints to each of our missions."*
//
// ── The two rules ─────────────────────────────────────────────────────────
//
// **`unity54`, the default since DEV-454.** A Linear project on Unity 5.4
// (2016's is 5.4.1p4) hands a shader `GammaToLinearSpace(m_Color × intensity)`.
// The extractor now writes exactly that into the level JSON:
// `lighting.sun.colorLinear × intensity` IS 2016's product
// (`tools/extract/unity-light.mjs`). So this rule touches nothing — the level
// is drawn as it loads, and every reader of the sun (the scene light, the fog's
// sun glow, the clouds, the sea, the sky's disc, the far shore, the baked
// light, the headset's sun halo) takes 2016's colour from the one field.
//
// **`port`, `?sunlight=port`**: the rule the port shipped until DEV-454, the
// raw `m_Color` drawn as if it were linear, which is paler and, for every
// mission with intensity under 1, brighter. Kept for the A/B and nothing else.
// It is applied the same way — by swapping the one field at LOAD — so the A/B
// reaches every reader too, and neither arm is a partial picture.

import type { Level } from '@/content/level-schema'

/** `unity54`: 2016's rule, the default. `port`: the pre-DEV-454 rule, for A/B. */
export type SunLightRule = 'unity54' | 'port'

/** `?sunlight=port` is the only way to the old rule; anything else is 2016's. */
export const sunLightRuleFrom = (param: string | null): SunLightRule =>
  param === 'port' ? 'port' : 'unity54'

/**
 * The level as the frame should light it under `rule`.
 *
 * Under `unity54` it is the SAME object — the level JSON already carries
 * 2016's colour, so there is nothing to do and nothing to copy. Under `port`
 * it is a copy whose `lighting.sun.colorLinear` is the raw `colorGamma`: the
 * old rule, in every reader at once, and the loaded level untouched.
 */
export const withSunLightRule = (level: Level, rule: SunLightRule): Level => {
  const sun = level.lighting?.sun
  if (rule === 'unity54' || !sun) return level
  return {
    ...level,
    lighting: {
      ...level.lighting,
      sun: {
        ...sun,
        colorLinear: [sun.colorGamma[0], sun.colorGamma[1], sun.colorGamma[2]],
      },
    },
  }
}
