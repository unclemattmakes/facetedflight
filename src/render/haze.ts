// src/render/haze.ts — aerial perspective, as its own term.
//
// ── Why this is NOT the fog ───────────────────────────────────────────────
//
// The mission fog (`render/unity-fog.ts`) is 2016's, reimplemented from
// Lengyel and thinned to 0.50 by Matt's own call after flying three values
// (DEV-018, DEV-018b). Its numbers are settled and nothing here touches them.
//
// What it does NOT do is aerial perspective. ANNIVERSARY.md §1.3 item 3, from
// nine photographed frames: *"In the `?fog=off` frames the far islands are as
// crisp and saturated as the near cliff and the whole archipelago collapses
// into a tabletop; with the shipped fog the far ones soften, but the middle
// distance (300 m – 1.5 km, where the course lives) is unchanged."*
//
// Fog is an OPACITY term: it replaces the surface colour with the sky's. Aerial
// perspective is a CONTRAST term: air between you and a ridge scatters the
// ridge's own light out of the ray before any sky is added, so the ridge loses
// saturation and cools toward the scattering colour while still being visibly
// the ridge. Doing it by thickening the fog would buy the desaturation and the
// colour shift together with an opacity the ledger has already said no to
// twice. So: a separate term, applied to the surface colour BEFORE the fog mix
// runs on top of it, with nothing at all inside `startDistance`.
//
// ── Opacity-free, and composing with DEV-030 ─────────────────────────────
//
// The fog fades toward the SKY's own colour along the view ray, not toward one
// flat colour (DEV-030). That is a good thing to compose with and a reason not
// to reuse it: the sky on `int_01` is a 4-degree sunset and warm, while aerial
// perspective is cool, and the two are different physics — forward scattering
// of skylight into the ray versus scattering of the surface's light out of it.
// Two terms, two colours, and the fog still gets the last word.
//
// ── The maths lives here in TypeScript, and the GLSL mirrors it ──────────
//
// `hazeColor` and `HAZE_GLSL` are the same four lines twice, on purpose: the
// shader cannot be unit tested without a GL context, and a term that is wrong
// in the middle distance looks exactly like an art choice. Keeping a mirror
// means `tests/unit/haze.test.ts` can pin identity, the endpoint and the
// monotonicity, and a change to one half that is not made to the other is a
// visible diff rather than a silent divergence. Both use `mix(x, y, a) =
// x * (1 - a) + y * a`, which is what the GLSL spec says `mix` is, so at a = 0
// both return `x` EXACTLY rather than nearly — which is what makes Classic's
// zero contribution an identity and not a rounding.

import type { EditionState } from '@/game/edition'
import { clamp01, mix } from '@/sim/math/scalar'

/**
 * Rec. 709 luminance weights.
 *
 * NOT a tuning number and not from the preset: these are the luminance
 * coefficients of the sRGB/Rec.709 primaries, which is the working colour space
 * three renders in and the space this term runs in (the fog blends linear —
 * see the colour-space note in `unity-fog.ts`). Desaturating toward any other
 * grey would be desaturating toward the wrong grey.
 */
export const HAZE_LUMA: readonly [number, number, number] = Object.freeze([0.2126, 0.7152, 0.0722])

/**
 * The tuning, resolved: distances in metres, `strength` and `desaturate` in
 * 0..1, and the tint already LINEAR.
 *
 * The preset JSON carries the tint in sRGB, the way `fog.color` in the level
 * JSON does, because that is the space a colour is picked in. `unity-fog.ts`
 * linearises it with the same function it linearises `RenderSettings.m_FogColor`
 * with, for the same reason — both end up mixed against a linear framebuffer —
 * and hands the result here. Nothing in this file knows about sRGB.
 */
export interface HazeSettings {
  /** Nothing nearer than this is touched at all. Metres. */
  readonly startDistance: number
  /** Metres from `startDistance` to full strength. Must be > 0. */
  readonly range: number
  /** How far toward `tint` at full range. 0..1. */
  readonly strength: number
  /** How far toward the colour's own luminance at full range. 0..1. */
  readonly desaturate: number
  /** LINEAR rgb. */
  readonly tint: readonly [number, number, number]
}

/**
 * No haze at all — what Classic runs, and what any material gets before a
 * preset has been applied.
 *
 * `range` is 1 rather than 0 because the pack takes its reciprocal; with
 * `strength` and `desaturate` both zero the range is unobservable either way,
 * and a 1 keeps the reciprocal finite so the shader never sees an infinity it
 * would have to be trusted to multiply by zero.
 */
export const HAZE_OFF: HazeSettings = Object.freeze({
  startDistance: 0,
  range: 1,
  strength: 0,
  desaturate: 0,
  tint: Object.freeze([0, 0, 0]) as readonly [number, number, number],
})

/**
 * `(startDistance, 1 / range, strength, desaturate)` — the `uHaze` vec4, in the
 * order the GLSL reads it.
 *
 * The reciprocal is taken on the CPU because it is per-frame-constant and a
 * fragment shader should not divide once per pixel to learn something a uniform
 * already knows.
 */
export const hazePack = (h: HazeSettings): [number, number, number, number] => [
  h.startDistance,
  h.range > 0 ? 1 / h.range : 0,
  h.strength,
  h.desaturate,
]

/**
 * How much haze at this distance: 0 at and inside `startDistance`, 1 at and
 * beyond `startDistance + range`, linear between.
 *
 * This is the quantity that is monotone. The COLOUR is not, quite: the
 * desaturation and the tint multiply, so the composed term is quadratic in this
 * amount and a single channel can turn around inside the range. That is a
 * property of two nested lerps and not a bug — see `tests/unit/haze.test.ts`,
 * which asserts the monotonicity of each term separately and of this function
 * always.
 */
export const hazeAmount = (distance: number, h: HazeSettings): number => {
  const [start, invRange] = hazePack(h)
  return clamp01((distance - start) * invRange)
}

/**
 * The term itself. Give it a LINEAR surface colour and a distance in metres;
 * get back the colour the fog should then be mixed on top of.
 *
 * Exactly `HAZE_GLSL`'s `ff2AerialHaze`, line for line.
 */
export const hazeColor = (
  color: readonly [number, number, number],
  distance: number,
  h: HazeSettings,
): [number, number, number] => {
  const t = hazeAmount(distance, h)
  const lum = color[0] * HAZE_LUMA[0] + color[1] * HAZE_LUMA[1] + color[2] * HAZE_LUMA[2]
  const d = h.desaturate * t
  const s = h.strength * t
  return [
    mix(mix(color[0], lum, d), h.tint[0], s),
    mix(mix(color[1], lum, d), h.tint[1], s),
    mix(mix(color[2], lum, d), h.tint[2], s),
  ]
}

/**
 * The shader half, injected into every material the fog patches.
 *
 * ONE variant: every value it reads is a uniform, so Classic and Anniversary
 * compile the same program and `render/program-cache-key.ts`'s `unity-fog` tag
 * still names exactly one source. That is deliberate — a `#define` would make
 * Classic's shader byte-identical to the pre-Anniversary one at the cost of two
 * programs for every fogged material and a second entry in the cache key, and
 * the thing Classic has to be identical in is its OUTPUT. With `uHaze.z` and
 * `uHaze.w` at zero both `mix` calls return their first argument exactly, so it
 * is.
 */
export const HAZE_GLSL = `
uniform vec4 uHaze;     // (startDistance, 1.0 / range, strength, desaturate)
uniform vec3 uHazeTint; // LINEAR rgb

// Aerial perspective: air between the eye and the surface scatters the
// surface's own light out of the ray, so it loses saturation and cools with
// distance while staying itself. Opacity-free — the fog does that, afterwards,
// and toward a different colour (DEV-030). Mirrored by hazeColor() in
// render/haze.ts, which is what the unit tests can actually reach.
vec3 ff2AerialHaze(vec3 color, float dist) {
  float t = clamp((dist - uHaze.x) * uHaze.y, 0.0, 1.0);
  float lum = dot(color, vec3(${HAZE_LUMA[0]}, ${HAZE_LUMA[1]}, ${HAZE_LUMA[2]}));
  vec3 c = mix(color, vec3(lum), uHaze.w * t);
  return mix(c, uHazeTint, uHaze.z * t);
}
`

/**
 * The same numbers with the tint still in sRGB — which is how the preset JSON
 * carries it, the way `fog.color` in a level does, because that is the space a
 * colour gets picked in.
 *
 * `render/unity-fog.ts` does the conversion, in the one place that also
 * linearises `RenderSettings.m_FogColor` and for the same reason: both end up
 * mixed against a linear framebuffer. Getting that wrong for the fog cost a
 * session and left a milky sheet in front of the world — the colour-space note
 * at the top of that file is the whole story.
 */
export interface HazeTuning {
  readonly startDistance: number
  readonly range: number
  readonly strength: number
  readonly desaturate: number
  /** sRGB 0..1. */
  readonly tint: readonly [number, number, number]
}

/**
 * Anything that can be handed a haze. `UnityFog` is the only implementation;
 * the interface exists so this file does not have to import the fog it is
 * injected into, which would be a circle.
 */
export interface HazeTarget {
  setHaze(haze: HazeTuning | null): void
}

/**
 * Wire a fog to the live preset: set it now, and again on every flip.
 *
 * `null` when the feature is off, rather than the preset's own numbers with the
 * flag ignored — so Classic's tuning values are unobservable and cannot become
 * load-bearing by accident. Returns the unsubscribe, and a caller that replaces
 * its fog must call it and attach the new one: `boot/app.ts` builds a fresh fog
 * on every course switch, and its `wiredMissionFog` is the one door that does
 * both (DEV-552 — this line used to say the app reloaded the document per
 * level, which stopped being true long before anybody re-read it).
 */
export const attachEditionHaze = (target: HazeTarget, editionState: EditionState): (() => void) => {
  const push = (): void => {
    const h = editionState.current.render.haze
    target.setHaze(h.enabled ? h : null)
  }
  push()
  return editionState.subscribe(push)
}
