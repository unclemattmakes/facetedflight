// tools/extract/unity-light.mjs — how Unity 5.4 hands a light's colour to a
// shader in a Linear project. DEV-454.
//
// `GammaToLinearSpace(m_Color x m_Intensity)`: the inspector's colour is a
// GAMMA value, the intensity is folded in BEFORE the curve, and the product is
// linearised whole. Unity 5.6 added `GraphicsSettings.lightsUseLinearIntensity`
// to change exactly this and left it off by default for the projects built on
// it; 2016's is 5.4.1p4 (`ProjectSettings/ProjectVersion.txt`). DEV-437's
// addendum measured it on the hangar before anybody believed it, and
// `src/render/hangar-light.ts` (`unityLightLinear`) is the runtime's copy.
// `tests/unit/sun-light-rule.test.ts` holds the two equal.
//
// A module of its own because `level.mjs` runs as a CLI on import, and the one
// formula it shares with the runtime has to be importable by a test.

/**
 * Unity's `GammaToLinearSpace` for one channel: the sRGB curve up to 1, and
 * `x^2.2` above it, where the sRGB curve is not defined. At 0.5 it is
 * 0.214041, Unity's linear `unity_ColorSpaceGrey`.
 */
export const unityGammaToLinear = (v) =>
  v <= 0.04045 ? v / 12.92 : v < 1 ? ((v + 0.055) / 1.055) ** 2.4 : v ** 2.2

/** Six decimal places, the level JSON's precision. */
const r6 = (n) => Math.round(n * 1e6) / 1e6

/**
 * A light's LINEAR colour per unit of intensity, as the level JSON carries it:
 * `colorLinear x intensity` is exactly what 2016's shader received. Dividing
 * the intensity back out keeps `intensity` the authored `m_Intensity`, so every
 * reader that multiplies the two (the scene light, the clouds, the sea) gets
 * 2016's product, and every reader that takes the colour alone (the fog's sun
 * glow, the sky's disc) gets the linear colour at the authored level.
 *
 * `color` is `{ r, g, b }` as the YAML serialises it; `intensity` must be > 0.
 */
export const unity54LightLinear = (color, intensity) => [
  r6(unityGammaToLinear(color.r * intensity) / intensity),
  r6(unityGammaToLinear(color.g * intensity) / intensity),
  r6(unityGammaToLinear(color.b * intensity) / intensity),
]
