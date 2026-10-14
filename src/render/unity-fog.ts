// src/render/unity-fog.ts — Faceted Flight's fog, which three.js cannot express.
//
// ── Why not `scene.fog` ───────────────────────────────────────────────────
//
// three has exactly two fogs: `Fog` (linear) and `FogExp2` (exponential
// squared). The 2016 game needs neither of them on their own.
//
// What it actually runs is `UnityStandardAssets.ImageEffects.GlobalFog`, driven
// by Matt's own `LevelEffects_GlobalFog` wrapper, and it has two terms that add
// before the falloff curve is applied:
//
//  1. **Distance fog**, using the scene's `RenderSettings` mode — and
//     `int_01_hoverJet` is mode **2, plain exponential**, which three does not
//     have at all. Substituting `FogExp2` over-fogs badly: at 3 km and density
//     0.0005 the correct factor is exp(-1.55) = 0.21, while exp2 gives
//     exp(-2.4) = 0.09. Less than half the visibility.
//
//  2. **Height fog** — a half-space integral that makes the fog dense below
//     `height` metres and thin above it. On Simonet that plane sits at **164 m**
//     with a density of 0.2, so the sea is buried and the peaks stand clear of
//     it. That is not a detail; it is the shape of every screenshot the game
//     ever shipped, and a uniform fog cannot produce it at any density.
//
// So the fog is computed in the terrain material instead. All the geometry is
// opaque, so a per-material fog gives the same result as the post-process pass
// without needing a depth prepass or a full-screen quad.
//
// ── Provenance ────────────────────────────────────────────────────────────
//
// The half-space term is Lengyel's unified fog — "Unified Distance Formulas for
// Halfspace Fog", terathon.com/lengyel/Lengyel-UnifiedFog.pdf — which is the
// paper Unity's own shader cites. This is a reimplementation from the maths and
// the parameter packing, not a copy of that shader: Standard Assets are
// third-party and cannot ship (D26).
//
// ── Colour space: LINEAR, and this file used to claim the opposite ────────
//
// The blend comment here read: "The 2016 project renders in GAMMA colour space
// (confirmed empirically: a linear-space heightmap read would not agree with
// the 2016 bake to 4 mm)". Both halves were wrong, and the cost was visible.
//
//  * `ProjectSettings.asset` says `m_ActiveColorSpace: 1` — **Linear**. The
//    whole Skyshop IBL port rests on that, and `ibl_sky`'s `Sky` component
//    sets `linearSpace: 1` independently.
//  * The empirical claim was a non-sequitur. A heightmap read is
//    `Texture2D.GetPixelBilinear` on the CPU. It says nothing whatever about
//    the framebuffer the fog blends against.
//
// What 2016 runs is `lerp(unity_FogColor, sceneColor, fogFac)`
// (GlobalFog.shader:146), a post-process over `_MainTex`. In a Linear project
// that texture samples linear and `unity_FogColor` is the LINEARISED
// `RenderSettings.m_FogColor` — note that `GlobalFog.cs` never sets a fog
// colour at all, which is exactly why it gets Unity's built-in conversion.
//
// So: linearise the colour, and mix in linear. The old sRGB round trip reached
// mid-grey far too early AND left the fog a paler rose than the sky, so distant
// terrain faded to something BRIGHTER than the horizon behind it — a milky
// sheet in front of the world. `render/sky.ts` had been linearising the same
// number all along to build its horizon, so the two disagreed by a whole
// transfer function, and the seam was the tell.
//
// Unity's parameter packing, which the numbers below have to match:
//
//   _HeightParams  = (height, cameraY - height, cameraY <= height ? 1 : 0,
//                     heightDensity * 0.5)
//   _DistanceParams.x = -max(startDistance, 0)
//   _SceneFogParams.x = density * 1.2011224087   // density / sqrt(ln 2), exp2
//   _SceneFogParams.y = density * 1.4426950408   // density / ln 2,       exp
//
// Those two magic constants exist because the shader uses `exp2`, so a natural
// exponential has to be rescaled into base 2. Reproduced here for the same
// reason.

// ── Directional fog colour, and the seam it exists to close ──────────────
//
// Matt: *"how can we get the horizon to blend into the sky better?"*
//
// 2016's fog is one colour, `RenderSettings.m_FogColor`, applied in every
// direction. On `int_01` that is (0.723, 0.392, 0.445) linear — and the sky it
// fades into is nothing like it. Measured off the extracted SH at the horizon:
//
//   bearing      0    45    90   135   180   225   270   315
//   red       0.39  0.27  0.33  0.49  0.51  0.43  0.44  0.48
//   blue      0.24  0.23  0.23  0.23  0.23  0.23  0.24  0.25
//
// So the fog is 1.4x to 2.7x BRIGHTER than the sky behind it, and nearly twice
// as blue. Distant terrain fades up into a pink band and the sky sits darker
// above it — which is the seam, and no single colour can close it, because the
// sky's own horizon swings by a factor of two around the compass.
//
// The fix is to stop treating fog as a colour and treat it as what it is:
// SCATTERED SKYLIGHT. Its colour along a ray is the sky's colour along that
// ray. Evaluate the same nine coefficients the dome is painted from, in the
// view direction, and distant geometry fades into exactly what is behind it —
// at every bearing, for free, and warm toward the sun the way haze actually is.
//
// A DEVIATION from 2016, which had the seam and shipped with it (DEV-030).
// `?fogsky=off` puts the flat colour back for comparison.

// ── And a SECOND atmospheric term, which is not this one ─────────────────
//
// The Anniversary preset adds aerial perspective — a distance-driven
// desaturation and cool shift of the surface's OWN colour, applied before the
// fog mix runs on top of it (ANNIVERSARY.md V4, DEV-082). It is here rather
// than in its own material patch because this file already owns the two things
// it needs — the world position varying and a per-material injection point —
// and a second `onBeforeCompile` on the same materials would be a third thing
// to chain. Its maths is in `render/haze.ts`, mirrored in TypeScript so a unit
// test can reach it; `setHaze(null)` is Classic and contributes nothing.
//
// The fog's own numbers are untouched by it. DEV-018/018b settled those and
// they are Matt's call.

import * as THREE from 'three'

import { GATE_NO_FOG, GATE_NO_HAZE } from './fragment-gates'
import { HAZE_GLSL, HAZE_OFF, type HazeSettings, type HazeTuning, hazePack } from './haze'
import { chainShaderPatch, setFogFlag } from './program-cache-key'

/**
 * Volatile scratch for `update`. Valid only inside one synchronous call.
 *
 * `getWorldPosition` refreshes the camera's world matrix itself, so this does
 * not depend on where in the frame `update` is called.
 */
const _cameraWorld = new THREE.Vector3()

/**
 * The sRGB electro-optical transfer function.
 *
 * `render/sky.ts` has its own copy and applies it to the SAME number to build
 * the horizon. They are deliberately not shared: this one exists because Unity
 * linearises `unity_FogColor`, that one because a sky gradient is authored in
 * sRGB, and collapsing two different reasons into one helper is how a future
 * change to one of them silently breaks the other. If they ever disagree, the
 * horizon seams — which is the symptom that found this bug.
 */
const srgbToLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4

/** Unity `FogMode`. */
export const FOG_LINEAR = 1
export const FOG_EXP = 2
export const FOG_EXP2 = 3

export interface UnityFogParams {
  /** `RenderSettings.m_FogMode`: 1 linear, 2 exponential, 3 exponential squared. */
  readonly mode: number
  readonly density: number
  readonly linearStart: number
  readonly linearEnd: number
  /** `RenderSettings.m_FogColor`, sRGB 0..1. */
  readonly color: readonly [number, number, number]
  readonly distanceFog: boolean
  readonly heightFog: boolean
  /** True: fog by true distance. False: by view-space depth. */
  readonly useRadialDistance: boolean
  /** World Y of the fog plane, metres. */
  readonly height: number
  readonly heightDensity: number
  /**
   * Put the dense half of the fog ABOVE the plane instead of below it.
   *
   * Matt: *"i wonder if we should make the fog thicker when we go higher
   * instead of the other way around."*
   *
   * Unity's half-space fog is an atmosphere: dense at the bottom, thinning
   * upward, because that is what air does. Physically right, and backwards for
   * this game. Fog on terrain 3 km away, by the altitude you are flying at:
   *
   * | camera y | dense below 387 | dense ABOVE 500 |
   * |---|---|---|
   * | 120 m | 0.83 | 0.29 |
   * | 300 m | 0.71 | 0.29 |
   * | 700 m | 0.47 | 0.42 |
   * | 1200 m | 0.39 | 0.81 |
   *
   * The stock model is murkiest at exactly the altitude the course is flown at
   * — `int_01` runs 134 m to 890 m and mostly low — and clears as you climb
   * away from it. Inverted, low flight is crisp because you are under the
   * layer, and climbing dissolves the world into atmosphere, which also hides
   * the edge of the 6 km terrain build.
   *
   * Implemented as a MIRROR of the vertical axis about the plane, not as a
   * second formula: one sign, applied to `FdotP`, `FdotV` and `FdotC`. Lengyel
   * is unchanged underneath, which is why it stays continuous and why the
   * `g0^2 / |FdotV|` term keeps behaving.
   */
  readonly heightFogInverted?: boolean
  /**
   * Nine SH coefficients of the mission's sky, UNITY space, linear rgb — the
   * same `lighting.sky.sh` the dome is painted from. Null or absent falls back
   * to the flat `color`.
   *
   * See the note on DIRECTIONAL FOG COLOUR below for why this is here.
   */
  readonly skySh?: readonly (readonly number[])[] | null
  /** Unit vector the sun TRAVELS along, three space. Only used with `skySh`. */
  readonly sunDirection?: readonly [number, number, number]
  /** Linear rgb. Only used with `skySh`. */
  readonly sunColor?: readonly [number, number, number]
  /** Nothing nearer than this is fogged at all. */
  readonly startDistance: number
}

export interface UnityFog {
  /** Give a material the fog. Call before first render. */
  applyTo(material: THREE.Material): void
  /** Per frame: the half-space term depends on where the camera is. */
  update(camera: THREE.Camera): void
  /**
   * The LINEAR fog colour the shader mixes toward.
   *
   * Exposed so a test can hold it against the sky's horizon. Those two are the
   * same number by necessity — distant terrain fades to the fog colour and the
   * horizon behind it is painted with the same colour, so any disagreement
   * shows up as a visible seam at the skyline. They disagreed by a whole
   * transfer function until 2026-09-09.
   */
  readonly linearColor: THREE.Color
  /**
   * The uniform block, for tests and for the console.
   *
   * Exposed because the altitude bug in `update` is invisible from outside: it
   * produced a perfectly ordinary-looking call and a one-pixel artifact half a
   * kilometre away. `tests/unit/unity-fog.test.ts` reads `uFogHeight` straight
   * out of here and needs no GL context to do it.
   */
  readonly uniforms: {
    readonly uFogHeight: { value: THREE.Vector4 }
    readonly uFogDistance: { value: THREE.Vector2 }
    readonly uFogColor: { value: THREE.Color }
    readonly uFogScene: { value: THREE.Vector4 }
    readonly uFogMode: { value: number }
    readonly uFogFlags: { value: THREE.Vector2 }
    readonly uFogRadial: { value: number }
    /** 1: fog toward the sky's colour along the ray (DEV-030); 0: the flat colour. */
    readonly uFogSkyMode: { value: number }
    readonly uFogHeightSign: { value: number }
    /** The way the sun's light TRAVELS, unit; its glow in the fog. DEV-476 moves it in the editor. */
    readonly uFogSunDir: { value: THREE.Vector3 }
    /** `(startDistance, 1 / range, strength, desaturate)` — DEV-082. */
    readonly uHaze: { value: THREE.Vector4 }
    /** LINEAR rgb the haze shifts toward. DEV-082. */
    readonly uHazeTint: { value: THREE.Color }
  }
  /**
   * Aerial perspective, on or off. `null` is Classic.
   *
   * One call reaches every material this fog has patched, because they all
   * share this uniform block — `Object.assign(shader.uniforms, uniforms)` in
   * `applyTo` hands over the same objects rather than copies. That is why the
   * Anniversary preset can be flipped mid-flight without recompiling anything:
   * the haze is uniforms, not a define, and `render/haze.ts` says why.
   */
  setHaze(haze: HazeTuning | null): void
  /**
   * Change the fog while it is running. For the lookdev panel only.
   *
   * `update()` rewrites the camera-dependent half of `uFogHeight` every frame,
   * so anything that sets `height` or `heightDensity` by poking uniforms gets
   * overwritten within a frame — which is a confusing way to discover that a
   * slider does nothing. This owns the parameters instead.
   */
  retune(next: FogRetune): void
  /**
   * What the fog is running now, every parameter `retune` can move. DEV-455:
   * the lookdev panel starts each control where the build is, and hides the
   * ones this mission's fog would not use (an inert slider is worse than a
   * missing one). A fresh snapshot per read.
   */
  readonly tuning: FogTuning
}

/**
 * Everything `retune` can move. DEV-455 added the colour, the linear pair, the
 * two on-off flags and the sky-colour switch to DEV-018's four, so every
 * parameter that shapes the look is reachable from `?lookdev=1`.
 */
export interface FogRetune {
  density?: number
  heightDensity?: number
  height?: number
  startDistance?: number
  inverted?: boolean
  /** `RenderSettings.m_FogColor`, sRGB 0..1, as the level JSON stores it. */
  colorSrgb?: readonly [number, number, number]
  /** Linear mode's pair, metres. Read by `mode` 1 only. */
  linearStart?: number
  linearEnd?: number
  /** Unity's two halves of the global fog. */
  distanceFog?: boolean
  heightFog?: boolean
  /**
   * Fog toward the sky's own colour along each ray (DEV-030) rather than the
   * flat colour. Only where the mission HAS a decoded sky: without one the
   * nine coefficients are zeros and this would fog to black, so a request for
   * it there is refused.
   */
  skyColour?: boolean
}

/** A snapshot of the fog's live parameters. */
export interface FogTuning {
  readonly mode: number
  readonly density: number
  readonly heightDensity: number
  readonly height: number
  readonly startDistance: number
  readonly inverted: boolean
  readonly colorSrgb: readonly [number, number, number]
  readonly linearStart: number
  readonly linearEnd: number
  readonly distanceFog: boolean
  readonly heightFog: boolean
  readonly skyColour: boolean
  /** Whether this mission has a decoded sky to fog toward at all. */
  readonly skyAvailable: boolean
}

const VERTEX_HOOK = '#include <begin_vertex>'

/**
 * Inject BEFORE this chunk, not after.
 *
 * `<opaque_fragment>` expands to `gl_FragColor = vec4(outgoingLight, ...)`, so
 * code placed after it can still modify `outgoingLight` and change nothing at
 * all — which is exactly what the first version of this file did. The fog
 * simply vanished, and a vanished fog looks like a plausible clear day.
 */
const FRAGMENT_HOOK = '#include <opaque_fragment>'

/**
 * DEV-018. Matt: *"lower the fog to match the values from the other levels
 * (at least be in the same ballpark)."*
 *
 * Three Simonet-sunset missions carry a fog nobody else does — `int_01_hoverJet`,
 * `adv_02_hoverJet` and `hoverJet_kauai_beg`, which are exactly the three that
 * also share the SkyJ skybox and the 4-degree sun. This replaces that one
 * parameter set with the one ten of the thirteen use.
 *
 * ── What is actually different, measured ─────────────────────────────────
 *
 * An earlier version of this note blamed `heightDensity`, which is 0.2 here
 * against 0.03 almost everywhere else, and called it "nearly seven times". That
 * was reading one parameter in isolation and it was wrong: the half-space term
 * goes as `heightDensity x (targetY - height)^2`, so the low 164 m plane squares
 * back most of what the high density adds. 0.2 x 164^2 and 0.03 x 387^2 are
 * within 20 % of each other.
 *
 * Evaluating the whole formula instead — transmittance, 1.0 being clear, from a
 * camera at 800 m:
 *
 *                        peak @2km   sea @2km   peak @5km
 *   int_01 as shipped       41.8 %     1.4 %       9.3 %
 *   median of the other 10  83.9 %     5.3 %      30.5 %
 *
 * Twice as thick at mid range and three times at long range. And the cause is
 * NOT the height fog at all: a 500 m peak is above both fog planes, so the
 * half-space term contributes nothing to it. It is `density` **0.0005**, the
 * joint highest in the game and twice the others' median, on `mode: 2` — plain
 * exponential, which bites harder at short range than the `mode: 3` most
 * missions use.
 *
 * ── What FF2 uses instead ───────────────────────────────────────────────
 *
 * The modal set, and the median density: `height` 387, `heightDensity` 0.03,
 * `density` 0.00025. That is not invented — it is byte-for-byte the fog of
 * `adv_02_jumpSeat`, a real shipped mission. It lands at 64.7 % / 15.9 % /
 * 30.5 %, inside the other ten's range on all three and exactly on their median
 * at 5 km.
 *
 * `mode`, `startDistance` and the fog COLOUR are untouched: the character of the
 * fog is 2016's, only its amount changes.
 *
 * ── Applied to ALL THIRTEEN, and at the call site ───────────────────────
 *
 * It was applied narrowly at first — only to fog carrying the Simonet-sunset
 * signature, so "the other ten missions keep their own values exactly". That
 * was the right instinct and the wrong scope, and DEV-098 is the correction.
 *
 * The narrow version was written when Simonet was the only environment this
 * port had ever loaded. The moment the level select could reach the other
 * three, alpine and desert turned out to be the two worlds that never got it —
 * and with Unity's atmosphere dense BELOW a 387 m plane, at the altitude those
 * courses are flown, they rendered as a flat sheet of fog colour. Measured
 * transmittance at 2 km, 1.00 being clear: **simonet 0.80, alpine 0.07, mesa
 * canyon 0.00.** Matt reported it as *"our mesa canyon and alpine forest maps
 * don't seem to load"*, which is exactly what a 100 % fog fraction looks like.
 *
 * So the treatment is now unconditional. The thinning was never a statement
 * about Simonet — *"our fog is still too thick... it's supposed to give a hint
 * of atmosphere"* is a statement about the game — and it landed narrowly only
 * because it was implemented as part of the sunset REPLACEMENT rather than as
 * the game's fog.
 *
 * `mode`, `startDistance` and the fog COLOUR are still untouched, per mission,
 * so each environment keeps its own character: only the amount, the plane, and
 * which half of it is dense are FF2's. The extracted numbers are untouched too —
 * `content/levels/*.json` still carries 2016's, and the swap happens once in
 * `boot/app.ts` where it is visible.
 *
 * ── What would change our mind ──────────────────────────────────────────
 *
 * A 2016 screenshot of `int_01` in which the shipped fog reads correctly. That
 * would make this a comfort setting rather than a correction, and it should then
 * become one — a slider, not a constant.
 */
/**
 * How much of the modal mission's fog FF2 actually runs. **Matt's call.**
 *
 * *"our fog is still too thick. plz make it significantly thinner. it's
 * supposed to give a hint of atmosphere."* (2026-09-10)
 *
 * DEV-018 originally swapped `int_01`'s thick sunset fog for the set ten of
 * thirteen missions share, on a fidelity argument: be in the ballpark of the
 * rest of the game. This is a second, separate move and it is not a fidelity
 * argument at all — it is art direction, and it is thinner than ANY shipped
 * mission. Kept as a multiplier rather than three baked numbers so the modal
 * set stays visible underneath and the deviation is exactly one figure.
 *
 * What a quarter bought, as fog fraction (0 % is perfectly clear):
 *
 * | | the massif at 930 m | sea at 2 km | island at 4 km | low pass at 600 m |
 * |---|---|---|---|---|
 * | 2016's own `int_01` | 28.6 % | 87.5 % | 84.6 % | 25.1 % |
 * | DEV-018, x1 | 17.4 % | 95.6 % | 93.2 % | **64.7 %** |
 * | x0.25 | 4.3 % | 24.1 % | 29.1 % | 7.8 % |
 *
 * The column that mattered was the last one. DEV-018 raised the fog plane from
 * 164 m to 387 m, and a HoverJet spends its whole run below 387 m — so the
 * replacement, chosen on a shot of a 500 m peak where neither plane reaches,
 * made low flight *murkier* than 2016 rather than clearer. That is the "still
 * too thick" Matt was flying through, and it is why this is a multiplier on
 * both density terms rather than a tweak to one.
 *
 * ── And then a quarter was too far ──────────────────────────────────────
 *
 * Matt, after living with it: *"we thinned it a wee bit too much. thicken it to
 * where you think it should be."*
 *
 * Fraction of the original colour SURVIVING — 1.00 is perfectly clear — for a
 * mountain flank at 150 m seen from 300 m, which is the shot a pilot actually
 * gets:
 *
 * | multiplier | 1 km | 2 km | 3 km | 4 km | 6 km |
 * |---|---|---|---|---|---|
 * | 0.25 | 0.88 | 0.77 | 0.67 | 0.58 | 0.44 |
 * | 0.40 | 0.76 | 0.57 | 0.42 | 0.32 | 0.17 |
 * | **0.50, is** | **0.68** | **0.45** | **0.29** | **0.19** | **0.08** |
 * | 2016's own | 0.65 | 0.37 | 0.21 | 0.12 | 0.04 |
 *
 * 0.25 went too far — the sea stopped 44 % short of the sky at the horizon and
 * the islands did not sit back. 0.40 fixed the horizon. 0.50 is Matt's own
 * call after flying both: *"let's decrease thinning to 0.5."*
 *
 * Which puts it close to 2016 and NOT at it, and the difference is the near
 * field: 0.68 at 1 km against 2016's 0.65, and 0.29 at 3 km against 0.21. The
 * islands keep more of their own colour up close than they did in 2016, and the
 * horizon is nearly gone at 6 km. That is the shape of every note in this file
 * — the fog is atmosphere at range and air up close, rather than one density
 * doing both jobs badly.
 */
export const FF2_FOG_THINNING = 0.5

/**
 * The fog's dense half sits ABOVE the plane, not below it.
 *
 * Matt: *"i wonder if we should make the fog thicker when we go higher instead
 * of the other way around."* See `heightFogInverted` for the table; the short
 * version is that Unity's atmosphere is murkiest at exactly the altitude the
 * course is flown at, and clears as you climb away from it.
 *
 * The plane moves to **500 m** with it, and that is the number that decides how
 * the mission feels. `int_01` runs 134 m to 890 m: under 500 the fog is a flat
 * 0.29 at 3 km, so the racing line is crisp; over it the world softens, and by
 * 1200 m it is 0.81 and the edge of the 6 km terrain build has gone with it.
 *
 * At 387 — the un-inverted plane's height — the murk would start at 387 and
 * catch the top half of the course. The two numbers are not independent, and
 * this is the one to move if low flight ever feels hazy.
 */
export const FF2_FOG_INVERTED = true

export const FF2_FOG_REPLACEMENT = Object.freeze({
  height: 500,
  heightDensity: 0.03 * FF2_FOG_THINNING,
  density: 0.00025 * FF2_FOG_THINNING,
  inverted: FF2_FOG_INVERTED,
})

/**
 * The fog FF2 runs. Every mission, unconditionally.
 *
 * ── Why there is no longer a condition ──────────────────────────────────
 *
 * There used to be one: a `FF2_FOG_REPLACED_SIGNATURE` of `height 164,
 * heightDensity 0.2` that matched the three Simonet-sunset missions and left the
 * other ten alone. It was deliberately a statement about the FOG rather than a
 * hard-coded list of mission ids — and it was still the wrong shape, because
 * what it actually encoded was *"the missions we had looked at"*.
 *
 * The eight alpine and desert missions kept 2016's un-inverted atmosphere and
 * were unflyable to look at (see DEV-098 and the note above). A signature match
 * cannot be right here: there is no property of a mission's fog that should
 * decide whether that mission gets the game's art direction.
 *
 * This is the agreement lesson in `docs/DEVIATIONS.md` in its usual costume —
 * the narrow rule and the broad one give the same answer on Simonet, which is
 * the only place either was ever tested.
 *
 * `tests/unit/fog-deviation.test.ts` sweeps every level JSON and is what stops
 * a fourteenth mission arriving with 2016's fog and nobody noticing.
 */
export const ff2Fog = <T extends { height: number; heightDensity: number; density: number }>(
  fog: T,
): T => ({ ...fog, ...FF2_FOG_REPLACEMENT })

/**
 * Unity's `_SceneFogParams` packing, as four floats.
 *
 * Exported so it can be pinned by a test. The two constants are the whole
 * reason this function exists: Unity's shader evaluates fog with `exp2`, so a
 * natural exponential has to be rescaled into base 2 first —
 * `1.4426950408 = 1/ln 2` for exp, `1.2011224087 = 1/sqrt(ln 2)` for exp2. A
 * typo in either produces fog that is merely the wrong density, which looks
 * like an art choice rather than a bug.
 *
 * Returns `[exp2Coefficient, expCoefficient, linearSlope, linearIntercept]`.
 */
const INV_SQRT_LN2 = 1 / Math.sqrt(Math.LN2)

export const sceneFogParams = (
  mode: number,
  density: number,
  linearStart: number,
  linearEnd: number,
): [number, number, number, number] => {
  const linear = mode === FOG_LINEAR
  const diff = linear ? linearEnd - linearStart : 0
  const invDiff = Math.abs(diff) > 0.0001 ? 1 / diff : 0
  return [
    // Unity writes these as the float literals 1.2011224087f and 1.4426950408f.
    // Those are float32 truncations of exactly these constants, so naming them
    // is not a deviation — it is the same number with the rounding removed, and
    // both land on the same float32 once they reach the GPU.
    density * INV_SQRT_LN2,
    density * Math.LOG2E,
    linear ? -invDiff : 0,
    linear ? linearEnd * invDiff : 0,
  ]
}

/**
 * Materials this fog has already patched.
 *
 * A `WeakSet` so a disposed material is not kept alive by the bookkeeping.
 */
const patched = new WeakSet<THREE.Material>()

export const createUnityFog = (p: UnityFogParams): UnityFog => {
  // Nine coefficients or none: a partial array reconstructs a DIFFERENT sky
  // rather than a worse one, and the fog would then fade toward a colour the
  // dome never paints. Same rule `render/sky.ts` applies.
  const skySh = p.skySh && p.skySh.length === 9 ? p.skySh : null
  // A mutable copy, because `retune` owns these after construction. The caller
  // keeps its readonly params; nothing here writes back to them.
  const live = {
    density: p.density,
    heightDensity: p.heightDensity,
    height: p.height,
    startDistance: p.startDistance,
    inverted: p.heightFogInverted === true,
    // DEV-455: the rest of what `retune` owns, so a panel can start there.
    colorSrgb: [p.color[0], p.color[1], p.color[2]] as [number, number, number],
    linearStart: p.linearStart,
    linearEnd: p.linearEnd,
    distanceFog: p.distanceFog,
    heightFog: p.heightFog,
    skyColour: skySh !== null,
  }
  const uniforms = {
    // sRGB -> LINEAR. `RenderSettings.m_FogColor` is an sRGB byte triple — on
    // `int_01_hoverJet` it is exactly (221, 168, 178)/255, which is a colour
    // picked in the inspector, not a computed linear value — and in a Linear
    // project Unity linearises its built-in `unity_FogColor` before any shader
    // sees it. `render/sky.ts` already did this to the same number to build the
    // horizon; the fog did not, and the two disagreed by the whole transfer
    // function.
    uFogColor: {
      value: new THREE.Color(
        srgbToLinear(p.color[0]),
        srgbToLinear(p.color[1]),
        srgbToLinear(p.color[2]),
      ),
    },
    // (-startDistance, near, 0, 0)
    uFogDistance: { value: new THREE.Vector2(-Math.max(live.startDistance, 0), 0) },
    // (height, FdotC, k, heightDensity * 0.5) — y and z move with the camera.
    uFogHeight: { value: new THREE.Vector4(live.height, 0, 0, live.heightDensity * 0.5) },
    // (exp2 coefficient, exp coefficient, linear slope, linear intercept)
    uFogScene: { value: new THREE.Vector4(0, 0, 0, 0) },
    uFogMode: { value: p.mode },
    uFogFlags: {
      value: new THREE.Vector2(p.distanceFog ? 1 : 0, p.heightFog ? 1 : 0),
    },
    uFogRadial: { value: p.useRadialDistance ? 1 : 0 },
    // +1 keeps Unity's atmosphere (dense below the plane); -1 mirrors the
    // vertical axis and puts the dense half above it.
    uFogHeightSign: { value: live.inverted ? -1 : 1 },
    // Nine is not negotiable: `vec3 uFogSh[9]` in GLSL, so a short array reads
    // garbage rather than failing. Same contract as `render/sky.ts`.
    // One flat Float32Array(27), not nine Vector3: three's array-of-vec3
    // setter runs `flatten` and `Vector3.toArray` on every draw that binds
    // this, and a flat array goes straight to `uniform3fv` (DEV-940).
    uFogSh: {
      value: Float32Array.from(
        { length: 27 },
        (_, i) => (skySh?.[(i / 3) | 0]?.[i % 3] as number) ?? 0,
      ),
    },
    uFogSkyMode: { value: skySh ? 1 : 0 },
    uFogSunDir: {
      value: new THREE.Vector3(...(p.sunDirection ?? [0, -1, 0])).normalize(),
    },
    uFogSunColor: {
      value: new THREE.Color(...((p.sunColor ?? [1, 1, 1]) as [number, number, number])),
    },
    // ── the Anniversary haze, off ───────────────────────────────────────
    //
    // Built zeroed, always, whatever preset is live: the fog exists before the
    // edition is asked (`missionFog` runs off the level JSON), and a term that
    // defaults to ON would make the order of two unrelated boot steps visible
    // in the picture. `setHaze` is the only thing that ever writes these.
    uHaze: { value: new THREE.Vector4(...hazePack(HAZE_OFF)) },
    uHazeTint: { value: new THREE.Color(0, 0, 0) },
  }

  uniforms.uFogScene.value.set(...sceneFogParams(p.mode, live.density, p.linearStart, p.linearEnd))

  return {
    linearColor: uniforms.uFogColor.value,

    /**
     * The uniform block, for tests and for the console.
     *
     * Exposed because the bug above is invisible from outside: the wrong
     * altitude produced a perfectly ordinary-looking `update` call and a
     * one-pixel artifact half a kilometre away. `tests/unit/unity-fog.test.ts`
     * reads `uFogHeight` directly and needs no renderer to do it.
     */
    uniforms,

    applyTo(material: THREE.Material) {
      // three's own fog must be off, or the two composite and the scene reads
      // as twice the density.
      //
      // Above the `patched` guard on purpose, so a second `applyTo` of the same
      // material still settles the flag. That is not enough on its own: a
      // material CLONED before this ran keeps `true`, and `applyTo` must never
      // be handed a clone (DEV-183). The clone sites pin it themselves —
      // `render/water.ts` before it can cut its first band. DEV-194.
      setFogFlag(material, false)

      // ONCE per material, and CHAINED.
      //
      // Chained because the water sets its own `onBeforeCompile` to displace
      // vertices, and whichever of the two assigned last would otherwise
      // silently delete the other — a frozen ocean or an unfogged one, with no
      // error either way.
      //
      // Once because every chunk of a terrain SHARES one material instance and
      // the caller applies this per chunk. Plain assignment was idempotent by
      // accident; chaining is not, and 256 chunks chaining 256 copies of the
      // same prologue is 256 redefinitions of the same varying — which does not
      // fail quietly, it fails to compile.
      //
      // Without a tag the fogged material shares a compiled program with any
      // other MeshStandardMaterial carrying the same parameters — including an
      // UNfogged one. See `render/program-cache-key.ts`. One constant token is
      // enough here: every branch in the injected GLSL below is on a uniform
      // (`uFogFlags`, `uFogMode`, `uFogRadial`), so there is exactly one
      // variant of this source.
      chainShaderPatch(
        material,
        {
          tag: 'unity-fog',
          uniforms,
          // The INSTANCE transform, when there is one. At `begin_vertex` the
          // `transformed` position is still in the mesh's own frame — three applies
          // `instanceMatrix` later, in `project_vertex`. Reading `modelMatrix *
          // transformed` here fogged every palm and every scattered boulder (both
          // `InstancedMesh`) from the TERRAIN GROUP's origin, the map's corner,
          // kilometres from where the instance stands: a palm beside the ship wore
          // the fog of a distant one in every preset, and under Anniversary's haze
          // (DEV-082) came out pale grey. DEV-096.
          vertex: (source) =>
            `varying vec3 vUnityFogWorldPos;\n${source}`.replace(
              VERTEX_HOOK,
              `${VERTEX_HOOK}
  {
    vec4 ff2FogLocal = vec4(transformed, 1.0);
    #ifdef USE_INSTANCING
      ff2FogLocal = instanceMatrix * ff2FogLocal;
    #endif
    vUnityFogWorldPos = (modelMatrix * ff2FogLocal).xyz;
  }`,
            ),
          fragment: (source) =>
            `
varying vec3 vUnityFogWorldPos;
${HAZE_GLSL}
uniform vec3 uFogColor;
uniform vec2 uFogDistance;
uniform vec4 uFogHeight;
uniform vec4 uFogScene;
uniform int  uFogMode;
uniform vec2 uFogFlags;
uniform float uFogRadial;
uniform float uFogHeightSign;
uniform vec3 uFogSh[9];
uniform float uFogSkyMode;
uniform vec3 uFogSunDir;
uniform vec3 uFogSunColor;

// The sky's own radiance along a ray — the same nine coefficients, the same
// basis order and the same zero clamp as the dome in render/sky.ts. Fog IS
// scattered skylight, so this is the colour distant geometry should fade into,
// and using it means the two agree by construction rather than by tuning.
vec3 unityFogSkyColor(vec3 d) {
  // The coefficients are UNITY space. One negated z, in one place.
  vec3 u = vec3(d.x, d.y, -d.z);
  vec3 c = uFogSh[0] * 0.282095;
  c += uFogSh[1] * (0.488603 * u.y);
  c += uFogSh[2] * (0.488603 * u.z);
  c += uFogSh[3] * (0.488603 * u.x);
  c += uFogSh[4] * (1.092548 * u.x * u.y);
  c += uFogSh[5] * (1.092548 * u.y * u.z);
  c += uFogSh[6] * (0.315392 * (3.0 * u.z * u.z - 1.0));
  c += uFogSh[7] * (1.092548 * u.x * u.z);
  c += uFogSh[8] * (0.546274 * (u.x * u.x - u.y * u.y));
  c = max(c, vec3(0.0));

  // The sun's broad glow, but NOT its disc. Haze really is brighter toward the
  // sun and that is half of why aerial perspective reads as distance; the disc
  // is an 8x spike that would burn a hot spot onto a mountainside.
  float cosA = clamp(dot(d, -uFogSunDir), 0.0, 1.0);
  c += uFogSunColor * (pow(cosA, 96.0) * 0.55 + pow(cosA, 6.0) * 0.20);
  return c;
}

// Lengyel's unified halfspace fog. Returns the extra fog "distance"
// contributed by the volume below the plane at uFogHeight.x, which is then
// added to the ordinary distance before the falloff curve runs.
float unityHalfSpace(vec3 wsDir, vec3 wsPos) {
  float FH = uFogHeight.x;
  float FdotC = uFogHeight.y;
  float k = uFogHeight.z;
  vec3 aV = uFogHeight.w * wsDir;
  // uFogHeightSign is +1 for Unity's atmosphere (dense below the plane) and -1
  // to mirror the vertical axis and put the dense half above it. Lengyel is
  // untouched underneath; only which way is "down" changes. FdotC and k are
  // computed with the same sign on the CPU.
  float FdotP = (wsPos.y - FH) * uFogHeightSign;
  float FdotV = wsDir.y * uFogHeightSign;
  float c1 = k * (FdotP + FdotC);
  float c2 = (1.0 - 2.0 * k) * FdotP;
  float g = min(c2, 0.0);
  // The 1e-5 guards a ray exactly parallel to the fog plane, where the
  // integral is a division by zero. Unity's does the same.
  return -length(aV) * (c1 - g * g / abs(FdotV + 1.0e-5));
}

${source}`.replace(
              FRAGMENT_HOOK,
              // ── DEV-238's two arms, and why the directives sit OUTSIDE the braces
              //
              // `#ifndef` / `#endif` around each block, never inside it: the fog
              // chunk between the braces is pinned BYTE FOR BYTE by
              // `tests/unit/haze.test.ts`'s `SHIPPED_FOG_CHUNK`, which is DEV-018's
              // own guard against a line of it moving unannounced. A gate that
              // touched the chunk would trip that test, and rewriting the expected
              // string to make it pass is exactly the move the test exists to
              // refuse. Wrapping the seams leaves the chunk alone.
              //
              // Neither gate is set by anything the game does. The preprocessor
              // removes an `#ifndef` whose name is absent before the driver's code
              // generator sees it, so the shipped program is the one this build has
              // always compiled — DEV-184's mechanism, and `fragment-gates.ts`'s.
              //
              // They are per-MATERIAL, which is the whole reason they are usable
              // here: `__ff2.fragmentGates([...], 'ocean')` prices the SEA's fog
              // and the sea's haze without touching the island's, and the two are
              // separate census rows with separate numbers.
              `#ifndef ${GATE_NO_HAZE}
{
  // ── aerial perspective, FIRST and in its own scope ──────────────────
  //
  // DEV-082. It changes the surface's own colour — desaturate, cool — and the
  // fog block below then mixes the sky over the result, which is the order the
  // physics happens in: light leaves the ridge, the air between takes some of
  // it out of the ray, and skylight is scattered in on the way. Zero
  // contribution on Classic, where uHaze.zw are both 0 and both of
  // ff2AerialHaze's mix() calls return their first argument exactly.
  //
  // RADIAL distance always, unlike the fog below, which follows Unity's
  // \`useRadialDistance\` flag. There is no 2016 packing to match here, and the
  // amount of air between the eye and a point is its true distance whatever a
  // depth buffer would have said.
  //
  // Its own block so the fog chunk under it is untouched, byte for byte, by
  // this feature — which \`tests/unit/haze.test.ts\` holds it to.
  outgoingLight = ff2AerialHaze(outgoingLight, length(vUnityFogWorldPos - cameraPosition));
}
#endif
#ifndef ${GATE_NO_FOG}
{
  vec3 wsDir = vUnityFogWorldPos - cameraPosition;
  float g = uFogDistance.x;
  if (uFogFlags.x > 0.5) {
    // Radial: true distance. Otherwise view depth along the camera's forward.
    float d = uFogRadial > 0.5
      ? length(wsDir)
      : abs(dot(wsDir, normalize(vec3(viewMatrix[0].z, viewMatrix[1].z, viewMatrix[2].z))));
    g += d - uFogDistance.y;
  }
  if (uFogFlags.y > 0.5) {
    g += unityHalfSpace(wsDir, vUnityFogWorldPos);
  }
  g = max(0.0, g);

  float fogFac;
  if (uFogMode == 1) {
    fogFac = g * uFogScene.z + uFogScene.w;
  } else if (uFogMode == 2) {
    fogFac = exp2(-(uFogScene.y * g));
  } else {
    float f = uFogScene.x * g;
    fogFac = exp2(-f * f);
  }
  fogFac = clamp(fogFac, 0.0, 1.0);

  // The colour fogged TOWARD. Flat in 2016; the sky's own colour along this
  // ray when the mission has a decoded sky, which is what closes the seam at
  // the skyline. See the note at the top of unity-fog.ts.
  vec3 fogTint = uFogSkyMode > 0.5 ? unityFogSkyColor(normalize(wsDir)) : uFogColor;

  // The blend is LINEAR. See the note on colour space in unity-fog.ts —
  // this line used to round-trip through sRGB on a premise that turned out
  // to be false, and that is what made the fog a milky sheet.
  outgoingLight = mix(fogTint, outgoingLight, fogFac);
}
#endif
${FRAGMENT_HOOK}`,
            ),
          // The gates are in the OUTPUT, or this throws. Same assertion and same
          // reason as `fragment-gates.ts`'s and `water.ts`'s: a patch that is a
          // no-op wearing a feature's clothes reports 0.00 ms and reads like a
          // result (DEV-069, DEV-238).
          after: (shader) => {
            for (const define of [GATE_NO_HAZE, GATE_NO_FOG]) {
              if (!shader.fragmentShader.includes(define)) {
                throw new Error(
                  `unity-fog: ${define} did not land in the patched shader — its anchor has moved.`,
                )
              }
            }
          },
        },
        patched,
      )
    },

    setHaze(haze) {
      // `null` and "enabled with zeroes" have to be the same picture, and they
      // are: HAZE_OFF packs strength and desaturate as 0, which is the identity
      // (see `render/haze.ts`). Going through the same pack for both means
      // there is one path to test rather than two.
      const resolved: HazeSettings = haze
        ? {
            startDistance: haze.startDistance,
            range: haze.range,
            strength: haze.strength,
            desaturate: haze.desaturate,
            // sRGB -> LINEAR, the same step `uFogColor` takes twenty lines
            // above and for the same reason. The preset carries a colour a
            // person picked; the shader mixes against a linear framebuffer.
            tint: [
              srgbToLinear(haze.tint[0]),
              srgbToLinear(haze.tint[1]),
              srgbToLinear(haze.tint[2]),
            ],
          }
        : HAZE_OFF
      uniforms.uHaze.value.set(...hazePack(resolved))
      uniforms.uHazeTint.value.setRGB(resolved.tint[0], resolved.tint[1], resolved.tint[2])
    },

    retune(next) {
      if (next.density !== undefined) live.density = next.density
      if (next.heightDensity !== undefined) live.heightDensity = next.heightDensity
      if (next.height !== undefined) live.height = next.height
      if (next.startDistance !== undefined) live.startDistance = next.startDistance
      if (next.inverted !== undefined) {
        live.inverted = next.inverted
        uniforms.uFogHeightSign.value = live.inverted ? -1 : 1
      }
      // DEV-455. Every one a uniform, so none of them recompiles anything.
      if (next.colorSrgb !== undefined) {
        live.colorSrgb = [next.colorSrgb[0], next.colorSrgb[1], next.colorSrgb[2]]
        // sRGB -> LINEAR, the step the constructor takes and for its reason.
        uniforms.uFogColor.value.setRGB(
          srgbToLinear(live.colorSrgb[0]),
          srgbToLinear(live.colorSrgb[1]),
          srgbToLinear(live.colorSrgb[2]),
        )
      }
      if (next.linearStart !== undefined) live.linearStart = next.linearStart
      if (next.linearEnd !== undefined) live.linearEnd = next.linearEnd
      if (next.distanceFog !== undefined) live.distanceFog = next.distanceFog
      if (next.heightFog !== undefined) live.heightFog = next.heightFog
      uniforms.uFogFlags.value.set(live.distanceFog ? 1 : 0, live.heightFog ? 1 : 0)
      // Refused where there is no sky: the coefficients are zeros, and a fog
      // toward them is a fog toward black.
      if (next.skyColour !== undefined) live.skyColour = next.skyColour && skySh !== null
      uniforms.uFogSkyMode.value = live.skyColour ? 1 : 0
      uniforms.uFogScene.value.set(
        ...sceneFogParams(p.mode, live.density, live.linearStart, live.linearEnd),
      )
      uniforms.uFogHeight.value.x = live.height
      uniforms.uFogHeight.value.w = live.heightDensity * 0.5
      uniforms.uFogDistance.value.x = -Math.max(live.startDistance, 0)
    },

    get tuning(): FogTuning {
      return {
        mode: p.mode,
        density: live.density,
        heightDensity: live.heightDensity,
        height: live.height,
        startDistance: live.startDistance,
        inverted: live.inverted,
        colorSrgb: [live.colorSrgb[0], live.colorSrgb[1], live.colorSrgb[2]],
        linearStart: live.linearStart,
        linearEnd: live.linearEnd,
        distanceFog: live.distanceFog,
        heightFog: live.heightFog,
        skyColour: live.skyColour,
        skyAvailable: skySh !== null,
      }
    },

    update(camera: THREE.Camera) {
      // ── the camera's WORLD altitude, not its local one ──────────────────
      //
      // In the cockpit the camera is a child of the XR rig, so
      // `camera.position` is the head pose INSIDE the rig — (0, 0, 0) until you
      // lean — while the rig carries the 500 m of altitude. The shader's
      // `cameraPosition` is three's built-in, which is the WORLD position. Read
      // the local one here and the two halves of the same calculation disagree
      // about where the eye is.
      //
      // What that looked like: `k` and `FdotC` were computed as though the eye
      // were at y = 0, i.e. always BELOW the 387 m plane, so `g0` stayed
      // non-zero for every fragment above it — and Lengyel's `g0^2 / |FdotV|`
      // then divided by `fragY - cameraPosition.y`, which is zero at the eye's
      // REAL altitude. `g` blew up, `fogFac` went to zero, and the pixel came
      // out as 100% fog colour: a pink line across the terrain at exactly eye
      // level, following you up and down. Matt: *"the fog horizon seems to draw
      // on top of mountains"* — it was the fog, and it was drawing at eye
      // height rather than at the horizon.
      //
      // It never showed under `?view=cam`, because `applyViewpoint` sets the
      // position on the scene-root camera itself and local == world there.
      // Every screenshot spec we own uses that path.
      camera.getWorldPosition(_cameraWorld)
      const y = _cameraWorld.y
      // The SIGN mirrors the vertical axis about the plane, so `FdotC` and `k`
      // describe which side of it the eye is on in the fog's own frame rather
      // than in the world's. Miss it here and the shader and the CPU disagree
      // about which half is dense, which is the same class of bug as reading
      // the local camera position — silent, and visible half a kilometre away.
      const sign = live.inverted ? -1 : 1
      const FdotC = (y - live.height) * sign
      uniforms.uFogHeight.value.y = FdotC
      // k selects which side of the plane the camera is on. Unity: FdotC <= 0.
      uniforms.uFogHeight.value.z = FdotC <= 0 ? 1 : 0
      const perspective = camera as THREE.PerspectiveCamera
      if (typeof perspective.near === 'number') {
        // Unity's built-in fog starts at the near plane; the post-process
        // subtracts it to match. Keep that, or everything is fogged slightly
        // more than it was.
        uniforms.uFogDistance.value.y = perspective.near
      }
    },
  }
}
