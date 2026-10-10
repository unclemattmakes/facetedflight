// src/render/water.ts — the ocean moves.
//
// The 2016 water is not a plane with a blue material on it. It is a SECOND
// faceted terrain — its own height map (`water_height.png`), its own colour map,
// 32 km of it scaled 8x to 262 km so it runs past the horizon — and every vertex
// of it is displaced in the vertex shader by a travelling sine wave.
//
// ── Where the numbers come from, and which copy wins ──────────────────────
//
// `Water.mat` serialises `_DisplaceAmplitude`, `_DisplaceDirection`,
// `_DisplaceFrequency`, `_DisplaceSpeed` and `_DisplaceNoiseCoef`, and reading
// the wave out of the material is the obvious move and the wrong one:
// `LowPoly_Displace.Update()` **writes all five into the material every frame**
// from its own public fields. The material's copies are whatever the inspector
// last left there.
//
// They agree on Simonet — 322 / 2 / 4 / 0.4 / -1 in both places — so this is a
// cross-check rather than a conflict, and the extractor records both.
//
// The component matters for a second reason: it is the only thing that sets
// `_V_LP_Time`, and the material carries `_DisplaceScriptSynchronize: 1`, which
// makes the shader use `_V_LP_Time` INSTEAD of Unity's `_Time.x`. A dead
// component is a frozen ocean, which is why `displace.live` is checked.
//
// ── The formula, from `VacuumShaders/.../cginc/Core.cginc` ────────────────
//
// Reimplemented from the maths, not copied — the shader is third-party and
// cannot ship (D26). What travels is what it computes:
//
//     sincos((_DisplaceDirection - 45) * PI/180, s, c)
//     dir = float2x2(c, -s, s, c) * worldPos.xz
//     n   = frac(sin(dot(worldPos.xzz, float3(12.9898, 78.233, 63.9137))))
//     n  *= _DisplaceNoiseCoef
//     y  += (_DisplaceAmplitude * (n + 1))
//           * sin(dot(dir, _DisplaceFrequency) + time * _DisplaceSpeed + n)
//
// Three details that are easy to get wrong and change the result:
//
//  1. **`dot(dir, _DisplaceFrequency)`** is a float2 dotted with a SCALAR. HLSL
//     promotes the scalar to `float2(f, f)`, so it is `(dir.x + dir.y) * f`, not
//     `dir.x * f`. GLSL will not promote it for you.
//  2. **`worldPos.xzz`** uses z TWICE, so the hash is
//     `x*12.9898 + z*(78.233 + 63.9137)`. Reading it as `.xyz` is a different
//     noise field entirely.
//  3. **`_DisplaceNoiseCoef` is -1**, so `n` lands in (-1, 0] and
//     `amplitude * (n + 1)` lands in (0, 4]. The noise does not add height, it
//     REMOVES it per-vertex — which is what stops the wave reading as one
//     coherent sheet. It also shifts the phase, because `+ n` appears inside the
//     sine as well.
//
// ── Handedness ────────────────────────────────────────────────────────────
//
// The formula is in UNITY space and our world is Unity's mirrored in z
// (`render/unity-space.ts`), so the wave is evaluated at `(x, -z)`. Skip that
// and the waves travel the wrong way across the map — invisible on open water,
// wrong against the islands.
//
// ── Normals ───────────────────────────────────────────────────────────────
//
// Displacing vertices invalidates whatever normals the mesh was built with, and
// the faceted look means they must be per-FACE rather than smoothed. Both are
// solved by deriving the normal in the fragment shader from the world position's
// screen-space derivatives: one flat normal per triangle, exactly following the
// displaced surface, with no vertex-order assumptions and nothing to keep in
// step with the wave.
//
// ── What this actually looks like, which is not what it sounds like ───────
//
// Do not expect rolling swell. Measured against the mesh it runs on:
//
//   phase gradient      0.5657 rad/m  ->  wavelength  11.1 m
//   vertex spacing      32 m of mesh x the plate's 8x scale  =  256 m
//   undersampled by     23x
//   temporal period     2*pi / speed  =  3.14 s
//
// An 11 m wave sampled every 256 m is not a wave. Each vertex gets a
// deterministic value from a sine it can never resolve, so what the surface
// actually does is CHOP: pseudo-random heights in (0, 4] m, every vertex
// independent of its neighbours, the whole field cycling every 3.14 seconds.
//
// That is the low-poly water look, and it is authored rather than accidental —
// the noise term is there to break up coherence that at this sampling rate could
// not have survived anyway. Worth writing down because the natural reaction to
// the first screenshot is "the waves are not working", and the second is to
// start tuning the frequency, which would be inventing.
//
// It also means the wave is invisible from altitude. 4 m of chop on 256 m facets
// is a sub-pixel ripple at 5 km; it reads near the islands and at sea level, and
// nowhere else. The ship flies at 550-900 m.

// ── Why the sea is faceted, and it is NOT the colour map ─────────────────
//
// Matt: *"the water doesn't have a faceted appearance either."* It did not, and
// the reason is worth writing down because the obvious explanation is wrong.
//
// The land is faceted because `islandgroup_color.png` gives every facet its own
// colour — luminance standard deviation 55 at facet resolution. **The water's
// colour map is a single flat colour**: `water_color` is (43, 130, 247) in every
// texel, standard deviation ZERO. There is no per-facet colour to see.
//
// Nor is it the geometry. The ocean's quads are 32 m of mesh times the plate's
// 8x scale = **256 m** in world space, against the land's 8 m. A 4 m wave across
// 256 m is a facet tilt of about a degree; diffuse shading cannot show that.
//
// It is the REFLECTION. `Water.mat` carries `V_LP_REFLECTIVE_REALTIME` and
// `_ReflectionFresnel: 1`, and at a grazing angle a one-degree change in normal
// swings the reflected direction by two degrees across a sky that is changing
// fast near the horizon. Each facet catches a different piece of sky, and THAT
// is the faceting. One degree of geometry, amplified by the reflection into
// something you can see.
//
// FF2 reflects the SKY rather than the scene — see DEV-021 — evaluated from the
// same nine SH coefficients `render/sky.ts` draws the background with, so the
// sea reflects exactly the sky above it and costs no second render pass.

// ── `_DisplaceStrength` is dead ───────────────────────────────────────────
//
// It is 2.31 on the material and it looks exactly like an amplitude scale.
// `Core.cginc` only multiplies by it in the `V_LP_DISPLACE_TEXTURE` branch, and
// this material's keywords are `V_LP_DISPLACE_PARAMETRIC`. Another serialised
// field nothing reads.

// ── The eye spends most of the launch ride UNDER this surface ─────────────
//
// `int_01_hoverJet.json`: the platform starts at `spawn.pos.y` **19.788 m** and
// rises `spawn.launch.rise` **106.647 m** to the respawn marker at 127.862.
// Sea level is about **116 m**. So the eye climbs some 96 m of a 106 m ride
// below the water and breaches in the last tenth of it — twelve seconds of a
// fifteen-second shot, every mission, looking up at a surface this shader was
// written for the other side of. It is the Evangelion hangar launch, and it is
// the first thing anyone will see in a headset.
//
// ── "Sea level" is a range, not a number ──────────────────────────────────
//
// `boot/viewpoints.ts` says 116.6 and that is a good figure NEAR THE ORIGIN —
// but the ocean is a `FacetedTerrain` with its own height map, so its base
// surface is not a plane. Read off the built geometry it carries **5,244
// distinct heights**: 115.29 over the open sea north-west of the island,
// 116.56 near the origin, 117.63 off the massif.
//
// On top of that base sit TWO oscillations, and they add:
//
//   the whole-plate bob   `amplitude * (n + 1)` at the plate's own origin,
//                         which for Simonet is **+/- 3.459 m** (see `bobAt`)
//   the per-vertex wave   **+/- 4 m**
//
// So at the open-sea stand the instantaneous surface lives between about
// **107.8 and 122.8 m**, and an eye anywhere in that band has water above it
// AND below it at once. That is not an edge case to be defended against; it is
// the breach, and it lasts for metres of the climb.
//
// It is also the reason the eye's side is decided per FRAGMENT below rather
// than by comparing the camera against a "sea level" constant. There is no such
// constant to compare against.
//
// ── What 2016 did, measured rather than assumed ───────────────────────────
//
// 2016 rode the same lift: DEV-024 records `LaunchElevator` with `m_Enabled: 1`
// in `int_01_hoverJet.unity` and every ancestor active. So the 2016 camera was
// under the ocean plane too, for fifteen seconds, thirteen times.
//
// And it saw **nothing there**, because the water was back-face culled:
//
//   * `Legacy_Opaque_Diffuse_Specular_Reflective.shader` declares no `_Cull`
//     property, and none of its five runtime passes (ForwardBase, ForwardAdd,
//     two PrePass, Deferred) carries a `Cull` statement — so all five inherit
//     Unity's default **`Cull Back`**. The file's only `Cull Off` is in the
//     **Meta** pass at line 1024, which exists for lightmap baking and never
//     renders at runtime.
//   * `Water.mat` sets no `_Cull` float and `m_CustomRenderQueue: -1`.
//
// 2016 also had an underwater idea and never shipped it:
// `Assets/Faceted Flight/Scripts/WaterHack.cs` swaps an `UnderwaterCeiling`
// object in and takes `RenderSettings.fogDensity` from 0.0012 to 0.01. Its guid
// (`395513c1cc8dbea4cab355a1be8f689e`) appears in **zero** of the 3,522
// `.unity`/`.prefab`/`.asset` files under `Assets/`. Dead code, and evidence of
// intent rather than of behaviour.
//
// **So there is no 2016 behaviour to be faithful to. Whatever this does is a
// DEVIATION — DEV-064 — and the only question is which deviation is better.**
// Not drawing it at all is available and is what 2016 did; a hole in the ceiling
// with the sky showing through is worse in a headset than either alternative,
// and that is what the port had.
//
// ── What the port actually had, which was neither ─────────────────────────
//
// `terrain-mesh.ts` builds the ocean's material `side: THREE.FrontSide`, so the
// underside was culled — but only where the facets face away. The wave gives
// each 32 m quad up to 7.13 degrees of tilt (see `maxFacetTiltRadians`), so from
// below, at a grazing angle, a good half of them face the eye and the other half
// are holes. Measured from y = 60 over open sea, 55.3 m under the base surface:
//
//   looking straight up      almost all sky, a ragged blue band near the horizon
//   looking 4 deg up         a near-solid sheet with the SUN'S GLINT in it
//
// A half-culled ceiling, shaded as though seen from above, complete with a
// specular highlight of a sun that is on the other side of it. Forcing
// `DoubleSide` at runtime filled the zenith in — and filled it with flat blue,
// which is the "up wins" rule rendering a wall.
//
// ── So: the surface is two-sided, and the shading asks which side ─────────
//
// The eye's side is a PER-FRAGMENT fact — the surface is above the eye out to
// the horizon and below it nearer in — and it is decided in the shader from
// three's `cameraPosition` against `vWaterWorld.y`, the same two quantities the
// specular and the reflection already use. That is deliberate. CLAUDE.md's trap
// 18 is a CPU half and a shader half of one calculation disagreeing about where
// the eye is, and in XR there is no CPU answer that could agree: `cameraPosition`
// is set per EYE from the `ArrayCamera`'s sub-camera, while anything read off
// `render.camera` is the rig's midpoint. Asking the question where the answer is
// used is the only version of this that cannot drift.
//
// It also makes the transition a place rather than an event. The boundary is the
// horizon — the locus of surface at exactly eye height — so breaching sweeps it
// down the frame through eight metres of chop instead of flipping the ocean over
// in one frame.
//
// ── The underside is a WINDOW, not a wall ────────────────────────────────
//
// Looking up from under water, the sky is compressed into a cone about the
// vertical — **Snell's window** — and outside it the surface is a mirror of the
// dark water below. Both fall out of one call to GLSL's `refract` with
// `eta = WATER_IOR`: inside the window it returns the transmitted direction, and
// outside it returns zero, which IS total internal reflection. Nothing is tuned;
// the half-angle is `asin(1 / 1.333)` = 48.6 degrees and the edge is where the
// Fresnel transmittance reaches zero of its own accord, so the window has a soft
// rim without a smoothstep anywhere.
//
// The facets then warp that rim, which is the faceted look arriving from the
// other side: a 7-degree quad tilt moves the window's edge by 7 degrees.

import * as THREE from 'three'
import { COAST_GLSL, COAST_OFF, type CoastMap, type CoastSettings, coastPack } from './coast'
import { delegatingClone } from './delegating-clone'
import {
  GATE_WATER_NO_COAST,
  GATE_WATER_NO_NORMAL,
  GATE_WATER_NO_REFLECT,
  GATE_WATER_NO_SPECULAR,
} from './fragment-gates'
import { chainBeforeCompile, setFogFlag, tagProgramCacheKey } from './program-cache-key'

/** `terrain.<env>.terrains.<key>.displace` — the live `LowPoly_Displace`. */
/** `Water.mat`'s surface response — the specular first, the reflection second. */
export interface WaterSurface {
  /**
   * `_SpecColor`, and it is the WHOLE POINT. (0.5, 0.5, 0.5): a legacy
   * Blinn-Phong specular at 50 % reflectance, against the 0.04 a metalness-0
   * standard material gives. Twelve times.
   */
  readonly specColor: readonly number[] | null
  /** `_Shininess`. The legacy exponent is this x 128 — 0.201 gives 25.7. */
  readonly shininess: number | null
  /** The mission's sun: what the specular is a highlight OF. */
  readonly sun: {
    readonly direction: readonly number[]
    readonly colorLinear: readonly number[]
    readonly intensity: number
  } | null
  /** `_ReflectColor`. rgb tints the reflection; ALPHA is its strength. */
  readonly color: readonly number[] | null
  /** `_ReflectionFresnel`. 1 means full strength at grazing angles. */
  readonly fresnel: number | null
  /**
   * DEV-583: `_ReflectionDistortion`, how far the facet normal pushes the
   * mirror's lookup, in 2016's units (clip space, before the divide, so the
   * push shrinks with distance). 0.3 on both shipped oceans. Read only when
   * the mirror is on; absent or null is no push.
   */
  readonly distortion?: number | null
  /**
   * DEV-583: the material's `V_LP_REFLECTIVE_REALTIME` keyword, the sheet's
   * `reflection.realtime`. Whether 2016 rendered a mirrored camera for THIS
   * sea at all, and so whether DEV-583 may restore one. Absent is no.
   */
  readonly realtime?: boolean
  /** Nine SH coefficients of the mission's sky, UNITY space. */
  readonly skySh: readonly (readonly number[])[] | null
  /**
   * The width of one water quad in WORLD metres — the scale the derived normal
   * stops meaning anything below. See `FACET_METRES_DEFAULT`.
   */
  readonly facetMetres?: number | null
}

/**
 * One ocean quad, in world metres: `baseResolution` (32) x the plate's 8x
 * scale, at LOD 0 and no mesh subdivision.
 *
 * Used when the caller does not say. It is the coarsest the mesh ever is AT
 * LOD 0, so a caller that subdivides and forgets to pass the smaller number
 * gets a normal that relaxes to flat slightly too late rather than too early —
 * the direction that preserves detail.
 *
 * It is NOT the coarsest quad in the world: a LOD 5 chunk is a stride of 32
 * over the same grid and its quads are 8,192 m (DEV-183). Nothing reaches this
 * fallback on that path — `materialFor` gives each band its own measured value
 * — and the two are said apart here because the sentence above used to claim
 * otherwise.
 */
export const FACET_METRES_DEFAULT = 256

/**
 * Entries in the launch shaft's hole outline (`Water.setShaftBore`'s `reach`):
 * one every 2.5 degrees. A multiple of four, because the shader packs them four
 * to a `vec4` — 36 uniform vectors, not 144 — and it is compiled into the GLSL.
 * DEV-460.
 */
export const SHAFT_REACH_STEPS = 144

export interface WaterDisplace {
  readonly live: boolean
  readonly direction: number
  readonly speed: number
  readonly amplitude: number
  readonly frequency: number
  readonly noise: number
}

/** DEV-339: what `Water.deriveMaterial` is asked for. */
export interface WaterDerivedMaterial {
  readonly name: string
  /** Appended to the base's program key as `|keySuffix`. Names a GLSL difference. */
  readonly keySuffix: string
  /** This material's own uniforms, applied after the chain's. */
  readonly uniforms: Readonly<Record<string, THREE.IUniform>>
  /** Rewrites the vertex source after the chain ran. Runs once per compile. */
  readonly patch: (shader: THREE.WebGLProgramParametersWithUniforms) => void
}

export interface Water {
  /**
   * The wave this sea's vertices ride, as the shader was handed it — the
   * sheet's `displace`, and `?swell=` if it was pinned. DEV-447: a boat reads
   * THIS rather than the sheet, so a pinned swell moves the boats with the sea.
   */
  readonly displace: WaterDisplace
  /** Advance the wave. `seconds` is Unity's `Time.time` — since the level loaded. */
  setTime(seconds: number): void
  /**
   * DEV-476: move the sun the specular glints toward — `direction` the way the
   * light TRAVELS (`lighting.sun.direction`), as the sea was built with. One
   * uniform, shared by every clone of this material (`materialFor`), so no
   * program changes.
   */
  setSunDirection(direction: readonly number[]): void
  /**
   * Hand the sea the ISLAND's height map and where the island is, so a fragment
   * can ask how much water is under it. Once, after both terrains have loaded.
   *
   * Until this is called — and on any environment whose land map never arrives —
   * the coast is inert whatever the preset says, because a depth read against a
   * map that is not there is worse than no shore at all. See `render/coast.ts`.
   */
  setCoastSource(map: CoastMap | null, heightMap: THREE.Texture | null): void
  /**
   * The shore's tuning, from the live preset. `COAST_OFF` is Classic and
   * contributes nothing — both `mix` calls return their first argument exactly
   * and the fragment never reaches the texture fetch. DEV-087.
   */
  setCoast(settings: CoastSettings): void
  /**
   * The whole-plate bob, in metres, at `seconds`.
   *
   * `LowPoly_Displace.Update()` also moves the TRANSFORM by the same wave
   * evaluated at the object's own origin. The script is written for something
   * floating ON the water; here it is attached TO the water, so the entire
   * 262 km plate rises and falls by up to `amplitude` metres while its vertices
   * wave independently. That is what shipped, so it is reproduced.
   *
   * `originUnity` is the object's own world position in UNITY space, which for
   * the Simonet plate is (-14949, -46.08, -13692).
   */
  bobAt(seconds: number, originUnity: readonly [number, number, number]): number
  /**
   * Cut the sea out of the launch shaft's bore. DEV-106.
   *
   * A vertical cylinder in THREE world space — `(x, z)` its axis, `radius` the
   * bore, `topY` the shaft's rim — inside which no water fragment is drawn.
   * The shaft is a sealed tube from the hangar to the rim and the sea is a
   * 262 km plate that does not know that: on Simonet the surface crosses the
   * tube between 87 and 102 m of a 106 m ride, and it crossed the platform,
   * the ship and the eye — a flooded lift, seen from inside. Every other object
   * in the bore is handled by hiding it until the deck is above it
   * (`render/elevator.ts` `revealRiseFor`); the sea cannot be, because its
   * ceiling is ±7.5 m of bob and wave and the rim is only 1.6 m above its top.
   * So the hole is cut per fragment, in the shader that already discards.
   *
   * Inert until called, and `clearShaftBore` puts it back. Radius 0 is off.
   *
   * DEV-460: `reach`, when given, is the hole's OUTLINE — `SHAFT_REACH_STEPS`
   * distances from the axis, one per world azimuth (`k / steps` of a turn,
   * x = cos, z = sin), drawn straight between — and `radius` is then only a
   * floor under the circle the outline is inside. 2016's shaft is not round,
   * and `render/lift-seal.ts` reads its outline off the art.
   */
  setShaftBore(x: number, z: number, radius: number, topY: number, reach?: ArrayLike<number>): void
  clearShaftBore(): void
  /**
   * Where the eye is, so the sea can pick its shader variant. DEV-167 / W6.
   *
   * Above the water it draws `FrontSide` with **no `discard` in the shader
   * text**: back faces are culled in fixed function instead of rasterised and
   * thrown away, and the depth test can reject a fragment before the water's
   * stack runs. Below it — or within the wave's reach of it, or with a shaft
   * bore live — it draws exactly what shipped.
   *
   * `seaY` is the plate's world y THIS frame, bob included;
   * `game/terrain/load-terrain.ts` has it because it is the thing that moved
   * it. The margin the sea adds to it is its own, from the wave it is carrying.
   *
   * Never called, and the sea stays two-sided for ever — which is the shipped
   * behaviour, so this is safe to leave out.
   */
  setEyeHeight(eyeY: number, seaY: number): void
  /**
   * DEV-583: can this sea carry 2016's realtime mirror at all? The sheet says
   * the material was `V_LP_REFLECTIVE_REALTIME`, and the sea reflects (a tint
   * and a sky to composite the mirror over). False and `setMirror` is a no-op.
   */
  readonly mirrors: boolean
  /**
   * DEV-583: the scene's reflection, `render/sea-reflection.ts`'s target, or
   * null for none. Null takes `FF2_WATER_MIRROR` OUT of the defines, so with
   * the mirror off the shader is byte for byte what it was before DEV-583
   * (absent, not sampling a black texture); a texture puts it in. One more
   * variant axis, rebuilt in place with the other two (DEV-194).
   */
  setMirror(texture: THREE.Texture | null): void
  /**
   * The material for a chunk whose quads are `facetMetres` of WORLD water.
   * DEV-183.
   *
   * `uFacet` and `uTiltCos` are the two uniforms that answer *"how big is one
   * facet here"*, and every ocean chunk shares one material — so one answer
   * has to serve the whole plate, and it is the LOD 0 one. It is wrong for
   * every other chunk even before `subdivisionByLod` widens the spread: LOD is
   * a stride of `1 << lod` over the vertex grid (`sim/terrain/faceted.ts`), so
   * a LOD 3 chunk's quads really are eight times the LOD 0 ones, and at
   * `uFacet` 32 m the far sea flattens everywhere — which removes its facet
   * glint, and on `int_01` the 4-degree sun puts the glint band exactly out
   * there.
   *
   * So the caller asks for the material that matches the geometry it is about
   * to build. The base material serves its own facet; every other size is a
   * pooled CLONE with its own two uniforms and the base's compiled program —
   * `render/lod-fade.ts`'s recipe, and see `materialFor`'s implementation for
   * why the two clone mechanisms nest rather than collide.
   *
   * Per LEVEL rather than per chunk, deliberately: the facet is a pure
   * function of the LOD, a terrain has at most six, and a per-chunk uniform
   * would be a material per chunk with nothing to show for it.
   */
  materialFor(facetMetres: number): THREE.Material
  /**
   * DEV-339: a material that is this sea's WHOLE shader chain (every patch the
   * base carries now or is given later, the variant defines, the uniforms) with
   * a different VERTEX source: the camera-centred rings' (`render/ocean-rings.ts`).
   *
   * Cut the way `materialFor` cuts a band: a delegating clone that shares the
   * base's `defines` by reference and joins the variant switch, so one
   * `applyVariant` moves it with the base. `keySuffix` makes it a second program
   * beside the base's (its vertex text differs), and every clone cut with the
   * same suffix shares that one program. `uniforms` are this clone's OWN (the
   * rings' lattice textures, `uFacet`, `uTiltCos`) and replace the chain's after
   * it ran; `patch` rewrites the vertex source after the chain did.
   */
  deriveMaterial(spec: WaterDerivedMaterial): THREE.Material
  /**
   * Compile BOTH variants under the curtain. Call once, after the world is
   * built and before the curtain lifts.
   *
   * Not optional in practice: a mission starts at the bottom of a shaft that is
   * 95 m under water, so the two-sided variant is the first one drawn and the
   * cheap one is needed at the breach twelve seconds later — a compile at each
   * end of a shot this port keeps on purpose (DEV-094).
   *
   * Returns the number of programs the renderer gained, so the caller can log
   * a zero and know the warm did nothing.
   */
  warmVariants(
    /**
     * Compile the ocean's group as it stands. Supplied by `warmWorld`'s
     * `duringWarm`, so it runs with the FLIGHT's render target bound and the
     * launch room hidden — both of which are in three's program cache key.
     *
     * A plain `renderer.compile(root, camera, scene)` from the caller does NOT
     * do: `outputColorSpace` comes from the bound target
     * (`three.module.js:7814`), so a compile made after the warm returns builds
     * the canvas variant and the real one still compiles in flight. This
     * function reported `+4 programs` while doing exactly that, and would have
     * reported `+4` either way.
     */
    compile: () => void,
  ): void
}

/**
 * `frac(sin(dot(p.xzz, (12.9898, 78.233, 63.9137))))`, the shader's hash.
 *
 * Written as three separate multiplies because that is what `dot` does. Folding
 * the two z constants into `z * 142.1467` is algebraically identical and
 * numerically is not — it moved the result by 2e-10, which is nothing to look at
 * and is still a different number from the one 2016 computed. The hash is
 * `sin()` of a value in the millions; there is no reason to hand it avoidable
 * error.
 */
export const waterNoise = (x: number, z: number): number => {
  // `.xzz` — z twice, so both z constants apply to the same coordinate.
  const r = Math.sin(x * 12.9898 + z * 78.233 + z * 63.9137)
  return r - Math.floor(r)
}

/**
 * Degrees to radians, as the SHADER spells it.
 *
 * `Core.cginc` multiplies by the literal `0.0174533`, which is pi/180 rounded to
 * six places — 2e-6 short. Using `Math.PI / 180` instead is more accurate and
 * less faithful, and it showed up as a 2e-5 disagreement against the
 * transliterated oracle. On a wave whose direction is the whole point, match the
 * source.
 */
const SHADER_DEG_TO_RAD = 0.0174533

/**
 * The displacement, in metres, at a UNITY-space (x, z) and a time.
 *
 * Exported because it is the oracle the shader is tested against: the same
 * arithmetic, in a language a test can call.
 */
export const waterDisplacement = (
  d: WaterDisplace,
  x: number,
  z: number,
  seconds: number,
): number => {
  const a = (d.direction - 45) * SHADER_DEG_TO_RAD
  const s = Math.sin(a)
  const c = Math.cos(a)
  const dirX = c * x - s * z
  const dirZ = s * x + c * z
  const n = waterNoise(x, z) * d.noise
  // `dot(float2, scalar)` promotes the scalar: (dir.x + dir.y) * frequency.
  const phase = (dirX + dirZ) * d.frequency + seconds * d.speed + n
  return d.amplitude * (n + 1) * Math.sin(phase)
}

/**
 * DEV-501 follow-up: the most `waterDisplacement` ever lifts the point
 * (x, z), metres — its envelope over time, `|amplitude * (n + 1)|`, since
 * time enters only the sine's phase. At the plate's own origin it is the
 * whole-plate bob's amplitude (`bobAt`): 3.459 m on Simonet.
 */
export const waveAmplitudeAt = (d: WaterDisplace, x: number, z: number): number =>
  Math.abs(d.amplitude * (waterNoise(x, z) * d.noise + 1))

/**
 * DEV-501 follow-up: the most the wave lifts ANY vertex, metres —
 * `waveAmplitudeAt`'s ceiling over every (x, z). `waterNoise` is in [0, 1), so
 * `n + 1` runs between 1 and `1 + noise`: `|amplitude| * max(1, |1 + noise|)`,
 * 4 m on both shipped oceans. A drawn point between vertices is a blend of
 * theirs, so no drawn point rises further either.
 */
export const waveCeiling = (d: WaterDisplace): number =>
  Math.abs(d.amplitude) * Math.max(1, Math.abs(1 + d.noise))

/**
 * The wave as a 0..1 sample, for anything that wants its SHAPE rather than its
 * metres — today, the foam band's breakup (DEV-087).
 *
 * ── This is not a fix, and the thing it is not fixing is a FINDING ────────
 *
 * *"The ocean's wave is 23x finer than the mesh that carries it"* (DEV-023's
 * companion): the wave's wavelength is 11.1 m and the plate's vertices are 256 m
 * apart, so the geometry cannot carry it and what lands on the vertices is
 * effectively noise. That is faithful, it is what 2016 shipped, and nothing here
 * changes it — the mesh, the vertex displacement and the wave's five parameters
 * are untouched.
 *
 * What this does is read the SAME field at a rate the mesh never could, in the
 * fragment shader, where 11.1 m of structure is exactly the scale a foam line
 * wants at the one place the eye is close to the water. The wave stays a
 * vertex displacement; this is a second reader of the same function.
 *
 * `x`/`z` are UNITY space, as `waterDisplacement` takes them. Divided by the
 * amplitude rather than by `amplitude * (n + 1)`, so the per-vertex noise — the
 * term that "stops the wave reading as one coherent sheet" — survives into the
 * breakup instead of being normalised back out of it.
 */
export const coastChop = (d: WaterDisplace, x: number, z: number, seconds: number): number => {
  const a = Math.max(1e-6, Math.abs(d.amplitude))
  const t = 0.5 + (0.5 * waterDisplacement(d, x, z, seconds)) / a
  return t < 0 ? 0 : t > 1 ? 1 : t
}

/**
 * `coastChop` in GLSL, and the twin it is tested against.
 *
 * Deliberately NOT folded into `WAVE_GLSL`: that block runs per VERTEX and
 * writes `transformed`, and this one runs per FRAGMENT and writes nothing. They
 * share the arithmetic and nothing else, and `tests/unit/coast.test.ts` holds
 * this copy to the same four traps `tests/unit/water.test.ts` holds that one to
 * — both rotated components in the phase, the hash's two separate z terms
 * unfolded, the `(n + 1)` amplitude scale, and the z flip into Unity space.
 */
export const COAST_CHOP_GLSL = /* glsl */ `
// The wave, evaluated HERE rather than at a vertex — see coastChop() in
// render/water.ts for why that is a second reader and not a fix.
float ff2CoastChop(vec3 world) {
  float ux = world.x;
  // UNITY space: our world is Unity's mirrored in z.
  float uz = -world.z;
  float s = sin(uWave.x);
  float c = cos(uWave.x);
  vec2 dir = vec2(c * ux - s * uz, s * ux + c * uz);
  // .xzz in the original: z counts twice, and the two constants are NOT folded.
  float r = sin(ux * 12.9898 + uz * 78.233 + uz * 63.9137);
  float n = (r - floor(r)) * uWave.w;
  // dot(float2, scalar) promotes the scalar, so both components count.
  float phase = (dir.x + dir.y) * uWave.y + uWaveTime * uWaveSpeed + n;
  float displace = uWave.z * (n + 1.0) * sin(phase);
  return clamp(0.5 + 0.5 * displace / max(1e-6, abs(uWave.z)), 0.0, 1.0);
}
`

/**
 * The wave, in GLSL — the twin of `waterDisplacement` above.
 *
 * Exported so `tests/unit/water.test.ts` can assert the two have not drifted.
 * It cannot RUN the GLSL (no GL context in a node test, and a GPU readback for
 * six lines of arithmetic is not worth maintaining), so what it checks is that
 * every detail the numeric tests pin is still spelled the same way here: both
 * rotated components in the phase, the hash's two separate z terms, and the fact
 * that the direction arrives pre-converted with the shader's own rounded
 * literal rather than being converted again in GLSL.
 *
 * Weak compared with running it. Much stronger than nothing, which is what a
 * second implementation buried in a template literal otherwise gets.
 */
export const WAVE_GLSL = /* glsl */ `
    vec3 wp = (modelMatrix * vec4(transformed, 1.0)).xyz;
    // UNITY space: our world is Unity's mirrored in z.
    float ux = wp.x;
    float uz = -wp.z;
    float s = sin(uWave.x);
    float c = cos(uWave.x);
    vec2 dir = vec2(c * ux - s * uz, s * ux + c * uz);
    // .xzz in the original: z counts twice, and the two constants are NOT
    // folded — see waterNoise for why.
    float r = sin(ux * 12.9898 + uz * 78.233 + uz * 63.9137);
    float n = (r - floor(r)) * uWave.w;
    // dot(float2, scalar) promotes the scalar, so both components count.
    float phase = (dir.x + dir.y) * uWave.y + uWaveTime * uWaveSpeed + n;
    float displace = uWave.z * (n + 1.0) * sin(phase);
    // Back to LOCAL space by dividing out the model matrix's y scale, rather
    // than by inverting it: inverse() is GLSL ES 3.00 only, and the plates
    // carry no rotation — position and an axis-aligned scale, (8, 1, 8) on both
    // oceans. Dividing by the y column's length is exact for that and does not
    // silently produce garbage if a future plate is scaled in y.
    float yScale = max(1e-6, length(modelMatrix[1].xyz));
    transformed.y += displace / yScale;
    wp.y += displace;
    vWaterWorld = wp;
`

const VERTEX_HOOK = '#include <begin_vertex>'
const NORMAL_HOOK = '#include <normal_fragment_begin>'
/** After lighting, before the fog blends toward the horizon. */
const REFLECT_HOOK = '#include <opaque_fragment>'
/**
 * After the vertex colour lands in `diffuseColor` and BEFORE any lighting runs
 * on it — which is where a change of albedo belongs.
 *
 * The shore is a different colour of water, not a light: putting it here means
 * the sun, the sky irradiance, the specular (DEV-021's faceting term), the sky
 * reflection, the haze (DEV-082) and the fog all compose on top of it in exactly
 * the order they already did. DEV-087.
 */
const COAST_HOOK = '#include <color_fragment>'

/**
 * Patch a material so its vertices ride the wave.
 *
 * CHAINS onto any existing `onBeforeCompile` rather than replacing it —
 * `unity-fog.ts` patches the same materials, and whichever assigned last would
 * otherwise silently delete the other.
 */
/**
 * The steepest lean one water quad can have, in radians.
 *
 * The wave's whole range is `(0, amplitude]` metres — the noise coefficient is
 * -1, so `amplitude * (n + 1)` lands in that interval and never above it (see
 * the header, detail 3). Two neighbouring vertices of one quad can therefore
 * differ by at most `amplitude`, across `facetMetres` of water.
 *
 * On Simonet that is `atan(4 / 32)` = **7.13 degrees** at the shipped
 * `?ocean=8`, and `atan(4 / 256)` = 0.90 at `?ocean=1`. A normal leaning
 * further than that did not come from the mesh; it came from a degenerate
 * derivative, and the shader clamps it back.
 *
 * `HEADROOM` is 1.5x, because the bound is exact for the MESH and the shader
 * is measuring a pixel: a pixel that straddles two quads sees a slightly
 * steeper step than either quad has, and clamping a real facet would show up
 * as a flat band rather than as removed noise. Well under the 40-90 degrees a
 * garbage normal produces, which is all this has to separate.
 */
export const maxFacetTiltRadians = (amplitude: number, facetMetres: number): number => {
  const HEADROOM = 1.5
  const facet = Math.max(1e-3, facetMetres)
  return Math.min(Math.PI / 2, Math.atan((HEADROOM * Math.abs(amplitude)) / facet))
}

// ── Looking up from underneath ────────────────────────────────────────────

/**
 * The refractive index of sea water, `n_water / n_air`.
 *
 * A physical constant, not a 2016 one — there is no 2016 number for this,
 * because 2016 culled the underside (see the header). Fresh water is 1.333 and
 * sea water 1.339 at 20 C; 1.333 is the figure every optics text and every
 * renderer uses, and the difference is 0.2 degrees of window.
 *
 * It decides two things and nothing else: the half-angle of Snell's window,
 * `asin(1 / WATER_IOR)`, and the normal-incidence reflectance `WATER_F0`.
 * `tests/unit/water-underside.test.ts` pins both against their closed forms.
 */
export const WATER_IOR = 1.333

/**
 * Schlick's F0 for an air/water interface: `((n - 1) / (n + 1))^2` = 0.0204.
 *
 * Derived from `WATER_IOR` rather than written down, so the two cannot drift.
 */
export const WATER_F0 = ((WATER_IOR - 1) / (WATER_IOR + 1)) ** 2

/**
 * Half-angle of Snell's window, radians — `asin(1 / n)` = **48.59 degrees**.
 *
 * The whole sky, horizon to horizon, arrives inside this cone about the
 * vertical. Outside it the surface is a mirror. Exported because it is the
 * number the underside is shaped by and a test should be able to say so.
 */
export const snellWindowRadians = (ior: number = WATER_IOR): number => Math.asin(1 / ior)

/**
 * GLSL's `refract`, in TypeScript — the oracle for the shader's window.
 *
 * `n` must point INTO the incident medium (against `i`), which is what the
 * fragment shader's normal already does once it has been turned toward the eye.
 * Returns `null` on total internal reflection, where GLSL returns the zero
 * vector; a null is harder to use by accident than a vector of zeroes, which is
 * the only reason the two spellings differ.
 */
export const refractDirection = (
  i: readonly [number, number, number],
  n: readonly [number, number, number],
  eta: number = WATER_IOR,
): [number, number, number] | null => {
  const dot = i[0] * n[0] + i[1] * n[1] + i[2] * n[2]
  const k = 1 - eta * eta * (1 - dot * dot)
  if (k < 0) return null
  const s = eta * dot + Math.sqrt(k)
  return [eta * i[0] - s * n[0], eta * i[1] - s * n[1], eta * i[2] - s * n[2]]
}

/**
 * How much of the sky gets through, given the cosine of the angle on the AIR
 * side of the interface.
 *
 * Schlick, evaluated on the TRANSMITTED angle rather than the incident one.
 * That is the form that behaves at an internal interface: as the incident angle
 * approaches the critical angle the transmitted one approaches 90 degrees, so
 * `cosT` reaches zero, `F` reaches 1 and this reaches **exactly zero** — the
 * window closes by itself. Schlick on the incident cosine does not do that, and
 * would need a fade bolted on to hide a hard rim.
 */
export const waterTransmittance = (cosTransmitted: number): number => {
  const c = Math.min(1, Math.max(0, cosTransmitted))
  return 1 - (WATER_F0 + (1 - WATER_F0) * (1 - c) ** 5)
}

/**
 * Turn a derived face normal OUT of the surface on the eye's side.
 *
 * The twin of the shader's `waterEyeSide` line. `surfaceY` is the surface at
 * that fragment, not the mean sea level: the wave puts 8 m of chop through the
 * eye's own altitude at the breach, so "above the sea" is a question about a
 * patch of water rather than about the ocean.
 *
 * It is a REFLECTION about the horizontal plane, so the normal's tilt away from
 * vertical is unchanged and only its hemisphere moves — which is what makes the
 * `maxFacetTiltRadians` clamp below mean the same thing on both sides.
 */
export const orientWaterNormal = (
  faceNormal: readonly [number, number, number],
  eyeY: number,
  surfaceY: number,
): [number, number, number] => {
  const side = eyeY < surfaceY ? -1 : 1
  const out = faceNormal[1] * side < 0 ? -1 : 1
  return [faceNormal[0] * out, faceNormal[1] * out, faceNormal[2] * out]
}

/**
 * A number GLSL will read as a float.
 *
 * `1` is an int in GLSL ES 1.00 and `refract(vec3, vec3, int)` does not compile,
 * so every constant interpolated into a shader goes through here. Interpolating
 * the TypeScript constants rather than retyping them is the point: the oracle
 * above and the shader below cannot disagree about the index of refraction.
 */
const glslFloat = (n: number): string => (Number.isInteger(n) ? `${n}.0` : String(n))

/**
 * The fragment-shader prelude: the sky, the eye's side, and the window.
 *
 * Exported so `tests/unit/water-underside.test.ts` can assert that the GLSL
 * still spells what the TypeScript oracles pin — the same index of refraction,
 * `refract` rather than a hand-rolled Snell, the transmitted-angle Schlick, and
 * the z flip into Unity space for the SH. It cannot RUN it (no GL context in a
 * node test), so this is the same bargain `WAVE_GLSL` already makes and is said
 * plainly for the same reason.
 */
export const WATER_SURFACE_GLSL = /* glsl */ `
// The sky, from the same nine coefficients render/sky.ts draws the background
// with — so the sea reflects exactly the sky above it, at no extra render pass.
vec3 waterSkyRadiance(vec3 d) {
  vec3 c = uReflectSh[0] * 0.282095;
  c += uReflectSh[1] * (0.488603 * d.y);
  c += uReflectSh[2] * (0.488603 * d.z);
  c += uReflectSh[3] * (0.488603 * d.x);
  c += uReflectSh[4] * (1.092548 * d.x * d.y);
  c += uReflectSh[5] * (1.092548 * d.y * d.z);
  c += uReflectSh[6] * (0.315392 * (3.0 * d.z * d.z - 1.0));
  c += uReflectSh[7] * (1.092548 * d.x * d.z);
  c += uReflectSh[8] * (0.546274 * (d.x * d.x - d.y * d.y));
  return max(c, vec3(0.0));
}

// Which side of THIS piece of surface the eye is on: +1 above, -1 below.
//
// \`cameraPosition\` is three's world-space built-in, and in an XR frame it is
// the SUB-CAMERA's position — the actual eye — where anything read off the rig
// on the CPU would be the midpoint between them. Asking here is the only
// version of this question that cannot disagree with the answer's users.
// (CLAUDE.md trap 18.)
float waterEyeSide(vec3 surfaceWorld) {
  return cameraPosition.y < surfaceWorld.y ? -1.0 : 1.0;
}

// The sky seen THROUGH the surface from underneath: Snell's window.
//
// \`n\` points down toward the eye here, so \`refract\` gets the geometry it
// wants, and it returns the zero vector outside the window — which is not a
// failure, it is total internal reflection, and the right answer there is "the
// dark water below, which is what the base colour already is".
vec3 waterThroughSurface(vec3 viewDir, vec3 n) {
  vec3 t = refract(viewDir, n, ${glslFloat(WATER_IOR)});
  if (dot(t, t) < 1e-8) return vec3(0.0);
  // Schlick on the TRANSMITTED angle: it reaches 1 exactly at the critical
  // angle, so the rim of the window fades out on its own. See
  // waterTransmittance.
  float cosT = clamp(dot(t, -n), 0.0, 1.0);
  float f = ${glslFloat(WATER_F0)} + (1.0 - ${glslFloat(WATER_F0)}) * pow(1.0 - cosT, 5.0);
  // UNITY space for the SH, as everywhere else: our world is Unity's mirrored.
  return waterSkyRadiance(vec3(t.x, t.y, -t.z)) * (1.0 - f);
}
`

// ── DEV-583: the scene in the water, flat ultra only ──────────────────────
//
// 2016's `Water.mat` carried `V_LP_REFLECTIVE_REALTIME`: a camera mirrored
// through the sea plane rendered the scene into `_ReflectionTex`, and the water
// read it back at its own SCREEN position, pushed by the facet normal. DEV-021
// replaced that with the sky alone, because in a headset it is two more scene
// renders. `render/sea-reflection.ts` renders the mirror on a monitor under the
// ultra tier, Anniversary only, and these two blocks read it.
//
// What is reimplemented is the behaviour of `GetLowpolyReflectionColor`, not
// its text (D26): the lookup is the fragment's own screen position, the
// projective divide happens AFTER the normal's push (so `_ReflectionDistortion`
// 0.3 is a push in clip units, shrinking with distance), and there is no mip
// bias because `_ReflectionRoughness` is 0. Two choices of this port's own:
//
//  1. **The mirror is composited OVER the sky reflection, not in place of it.**
//     `sea-reflection.ts` clears its target to transparent and does not draw
//     the sky dome, so a texel is the scene where something was drawn and
//     alpha 0 where 2016's mirror would have shown sky. The sky there stays
//     DEV-021's per-facet SH lookup, which is where the sea's faceting comes
//     from (the header above); a mirrored sky shoved by 0.3 / depth would be
//     smoother than the sea is today. Then the sum takes the SAME tint,
//     strength and Fresnel as before: `_ReflectColor` rgb, its alpha 0.5, and
//     `_ReflectionFresnel` 1.
//  2. **The lookup's x is mirrored**, `1 - u`. The mirror camera is a proper
//     rotation (three culls by winding, and a reflected view matrix would turn
//     every mesh inside out), and a proper camera through a horizontal plane
//     sees a point on the plane at the same screen y and the opposite screen
//     x. `tests/unit/sea-reflection.test.ts` holds that by projection.

/** DEV-583's define. Present only while `setMirror` holds a texture. */
export const MIRROR_DEFINE = 'FF2_WATER_MIRROR'

/**
 * The vertex half: the fragment's clip position, for the screen lookup.
 *
 * Computed from `vWaterWorld` (the displaced world position the wave block has
 * just written) rather than read off `gl_Position`, so it needs no anchor of
 * its own: the same matrix product `project_vertex` makes, for a plate that is
 * never instanced. A varying in BOTH halves (two symbol tables).
 */
export const MIRROR_VERTEX_GLSL = /* glsl */ `
  #ifdef ${MIRROR_DEFINE}
  vFf2MirrorClip = projectionMatrix * viewMatrix * vec4(vWaterWorld, 1.0);
  #endif`

/**
 * The fragment half's declarations and the composite. Exported so
 * `tests/unit/sea-reflection.test.ts` can hold its spelling to the behaviour
 * the header names (the push before the divide, the mirrored x, the over
 * composite), the bargain `WAVE_GLSL` already makes.
 */
export const MIRROR_FRAGMENT_GLSL = /* glsl */ `
#ifdef ${MIRROR_DEFINE}
uniform sampler2D uFf2Mirror;
uniform float uFf2MirrorDistortion;
varying vec4 vFf2MirrorClip;
// The scene the mirror saw at this fragment, OVER the sky reflection: the
// target is cleared to transparent and the dome is not drawn into it, so where
// the mirror holds sky its alpha is 0 and the per-facet sky shows through.
vec3 ff2SeaMirror(vec3 sky, vec3 n) {
  // 2016: the screen position plus the normal's push, THEN the divide.
  vec2 uv = (vFf2MirrorClip.xy / vFf2MirrorClip.w) * 0.5 + 0.5
    + n.xz * (uFf2MirrorDistortion / vFf2MirrorClip.w);
  vec4 m = texture2D(uFf2Mirror, vec2(1.0 - uv.x, uv.y));
  return m.rgb + sky * (1.0 - m.a);
}
#endif
`

/**
 * One black texel, so `uCoastMap` is never an unbound sampler.
 *
 * Half float and one channel, matching the real map's format, so binding the
 * real one later is a swap rather than a format change. It is only ever read
 * when a coast has been attached, and a coast is only attached with a real map.
 */
const placeholderCoastMap = (): THREE.DataTexture => {
  const t = new THREE.DataTexture(new Uint16Array(1), 1, 1, THREE.RedFormat, THREE.HalfFloatType)
  t.name = 'coast:none'
  // One row of two bytes against the default four-byte unpack alignment. The
  // real map is 1024 x 2 bytes and does not care; this one would be read past
  // the end of the buffer on a driver that takes the alignment literally.
  t.unpackAlignment = 1
  t.needsUpdate = true
  return t
}

export const applyWaterWaves = (
  material: THREE.Material,
  d: WaterDisplace,
  surface: WaterSurface | null = null,
): Water => {
  /** The base material's own quad, in world metres. See `materialFor`. */
  const baseFacet = Math.max(1e-3, surface?.facetMetres ?? FACET_METRES_DEFAULT)
  const uniforms = {
    uWaveTime: { value: 0 },
    // (direction radians, frequency, amplitude, noise coefficient)
    uWave: {
      value: new THREE.Vector4(
        (d.direction - 45) * SHADER_DEG_TO_RAD,
        d.frequency,
        d.amplitude,
        d.noise,
      ),
    },
    uWaveSpeed: { value: d.speed },
    uFacet: { value: baseFacet },
    uTiltCos: { value: Math.cos(maxFacetTiltRadians(d.amplitude, baseFacet)) },
    // (r, g, b, strength) — `_ReflectColor`, whose ALPHA is the strength.
    uReflect: {
      value: new THREE.Vector4(
        (surface?.color?.[0] as number) ?? 0,
        (surface?.color?.[1] as number) ?? 0,
        (surface?.color?.[2] as number) ?? 0,
        (surface?.color?.[3] as number) ?? 0,
      ),
    },
    uReflectFresnel: { value: surface?.fresnel ?? 0 },
    // (axis x, axis z, radius, rim y) of the launch shaft's bore, THREE world
    // space. Radius 0 is no hole. See `setShaftBore`.
    uShaftBore: { value: new THREE.Vector4(0, 0, 0, 0) },
    // DEV-460: the hole's outline, one reach per world azimuth, four to a vec4.
    uShaftReach: { value: new Float32Array(SHAFT_REACH_STEPS) },
    uReflectSh: {
      value: Array.from(
        { length: 9 },
        (_, i) =>
          new THREE.Vector3(
            (surface?.skySh?.[i]?.[0] as number) ?? 0,
            (surface?.skySh?.[i]?.[1] as number) ?? 0,
            (surface?.skySh?.[i]?.[2] as number) ?? 0,
          ),
      ),
    },
    // (r, g, b, exponent) — `_SpecColor` and `_Shininess * 128`.
    uSpec: {
      value: new THREE.Vector4(
        (surface?.specColor?.[0] as number) ?? 0,
        (surface?.specColor?.[1] as number) ?? 0,
        (surface?.specColor?.[2] as number) ?? 0,
        Math.max(1, (surface?.shininess ?? 0) * 128),
      ),
    },
    /** TOWARD the sun. `sun.direction` is where the light TRAVELS. */
    uSunDir: {
      value: new THREE.Vector3(
        -((surface?.sun?.direction?.[0] as number) ?? 0),
        -((surface?.sun?.direction?.[1] as number) ?? -1),
        -((surface?.sun?.direction?.[2] as number) ?? 0),
      ).normalize(),
    },
    uSunColor: {
      value: new THREE.Vector3(
        ((surface?.sun?.colorLinear?.[0] as number) ?? 1) * (surface?.sun?.intensity ?? 1),
        ((surface?.sun?.colorLinear?.[1] as number) ?? 1) * (surface?.sun?.intensity ?? 1),
        ((surface?.sun?.colorLinear?.[2] as number) ?? 1) * (surface?.sun?.intensity ?? 1),
      ),
    },
    // ── the shore, off ──────────────────────────────────────────────────
    //
    // DEV-087. Uniforms rather than a define, so Classic and Anniversary share
    // one program and `tagProgramCacheKey` below still names one source — the
    // bargain `render/haze.ts` already struck, and the same reasoning: what
    // Classic has to be identical in is its OUTPUT. With both strengths at zero
    // the shader returns before it reads the map at all.
    uCoastRamp: { value: new THREE.Vector4(...coastPack(COAST_OFF)) },
    uCoastPlane: { value: new THREE.Vector4(0, 0, 0, 0) },
    uCoastLand: { value: new THREE.Vector4(0, 0, 0, 0) },
    uCoastShallow: { value: new THREE.Vector3(0, 0, 0) },
    uCoastFoam: { value: new THREE.Vector3(0, 0, 0) },
    uCoastBreakup: { value: 0 },
    // A real 1x1 texture, not null: an unbound sampler is undefined behaviour on
    // some drivers and a console warning on the rest, and this costs two bytes.
    uCoastMap: { value: placeholderCoastMap() as THREE.Texture },
    // ── DEV-583: the mirror, read only under `FF2_WATER_MIRROR` ──────────
    //
    // Null until `setMirror` hands a target over, and never bound while the
    // define is absent: the program then has no such uniform for three to set.
    uFf2Mirror: { value: null as THREE.Texture | null },
    // `_ReflectionDistortion`, from the sheet through `load-terrain.ts`.
    uFf2MirrorDistortion: { value: surface?.distortion ?? 0 },
  }
  const specular = Boolean(surface?.specColor && surface.sun)
  // Nine coefficients or nothing: a partial array reflects a different sky
  // rather than a worse one.
  const reflects = Boolean(surface?.color && surface.skySh?.length === 9)
  // DEV-583: the mirror composites over the sky reflection, so it needs one,
  // and 2016 must have rendered one for this material.
  const mirrors = reflects && surface?.realtime === true

  // Without this the sea shares a compiled program with the LAND, which is the
  // same MeshStandardMaterial with different uniforms — and then either the sea
  // is frozen or the island ripples, depending on which was constructed first.
  // See `render/program-cache-key.ts`. `specular` and `reflects` are in the tag
  // because they gate GLSL, not uniforms.
  tagProgramCacheKey(material, `water:${specular ? 's' : ''}${reflects ? 'r' : ''}`)

  // ── the sea has two sides now ─────────────────────────────────────────
  //
  // `terrain-mesh.ts` builds every terrain material `FrontSide`, which is right
  // for an island and wrong for a surface the launch ride spends 97 m of 106
  // underneath. It did not hide the underside either, which would at least have
  // been 2016's answer: the wave tilts each quad by up to 7.13 degrees, so from
  // below at a grazing angle about half the facets face the eye and the rest are
  // holes. Measured from y = 60, 56.6 m under: looking straight up gave sky with
  // a ragged blue fringe near the horizon; looking 4 degrees up gave a near
  // solid sheet carrying the sun's own glint.
  //
  // Set HERE rather than in `terrainMaterial` because this function is only
  // reached by a terrain with a live `LowPoly_Displace` — the ocean, and nothing
  // else. The island keeps its culling.
  //
  // **This is not free, and the fragment shader pays it back.** Turning culling
  // off globally also un-culls the water ABOVE the waterline, which puts
  // back-facing facets into the sun's glint band and speckles it white — 0.6 %
  // of a box beside the glint carrying a per-pixel step, against 36 %. So the
  // cull is reproduced per FRAGMENT in the normal block, where it can ask which
  // side of that piece of surface the eye is on; a per-draw `side` cannot, and
  // at the breach both sides are in one frame. See the `discard` there.
  //
  // ── and it is a VARIANT, not a constant (DEV-167, W6) ─────────────────
  //
  // Everything above is true of the frame at the BREACH. It is true of no
  // other frame in the game: the eye is above the water for all of every
  // mission except the launch ride, `uShaftBore` is non-zero only during it,
  // and the file's own conclusion — *"above the waterline this is
  // byte-for-byte the old FrontSide, holes and all"* — is the proof that the
  // above-water case can be drawn by the hardware instead.
  //
  // So the sea compiles two programs, chosen per frame by `setEyeHeight`:
  //
  //   ABOVE   FrontSide, and NEITHER discard in the shader text. Back faces
  //           are culled in fixed function rather than rasterised and then
  //           thrown away, and a fragment shader with no `discard` in it can
  //           be depth-tested early — which matters on a 262 km plate whose
  //           fragment stack is three lights of GGX, an SH sky radiance, a
  //           Blinn-Phong glint and two screen-space derivatives.
  //   TWO-SIDED  exactly what shipped before: DoubleSide and both discards.
  //
  // The defines are what make it two programs — three hashes `material.defines`
  // into the program cache key — and `warmVariants` is what stops the second
  // one compiling in the seat. **The ride starts under water**, so the first
  // variant a mission needs is the expensive one and the breach twelve seconds
  // later needs the other; an unwarmed pair would put a compile at each end of
  // the shot this port deliberately keeps.
  material.defines ??= {}
  const defines = material.defines as Record<string, string>
  /**
   * Every material the variant switch has to move: the base, plus each facet
   * clone `materialFor` has cut. DEV-183.
   *
   * A clone's `defines` is a SNAPSHOT — `Material.copy` does
   * `Object.assign({}, source.defines)` — and `side` is copied by value too, so
   * a clone left out of this list would go on drawing whichever variant was
   * current when it was born. Both halves are in the program cache key
   * (`doubleSided` is a cache-key boolean and every define is hashed), so that
   * is not a dim picture, it is a different program: the sea two-sided in the
   * chunks you are over and one-sided in the chunks beyond them.
   */
  const skinned: THREE.Material[] = [material]
  /** Is the two-sided program in force? Null until `applyVariant` first runs. */
  let twoSided: boolean | null = null
  /** Is the bore's test in the shader? Tracked so a change is not missed. */
  let shaftCut: boolean | null = null
  /** Has a caller set a bore? Independent of the side — see `applyVariant`. */
  let shaftLive = false
  /** DEV-583: is the mirror's lookup in the shader? Tracked like the bore. */
  let mirrorIn: boolean | null = null
  /** DEV-583: does a caller hold a mirror target for this sea right now? */
  let mirrorLive = false
  /**
   * DEV-583: has the mirror EVER been on for this sea? Then `warmVariants`
   * warms both of its states, so leaving it (a headset session, the quality
   * row) swaps to a program that is already linked. A sea that has never had
   * it warms exactly the four it always did.
   */
  let mirrorEver = false

  /**
   * Put a variant on the material. Two INDEPENDENT axes, and they have to be
   * independent: on the ride the eye crosses the surface at ~87 m of a 106 m
   * shaft while the rim is at ~102, so for fifteen metres the eye is above the
   * water AND still inside the bore. Folding the bore into the two-sided
   * program would put the sea back across the tube for exactly that stretch —
   * which is the flooded lift DEV-106 exists to fix.
   */
  const applyVariant = (
    side: boolean,
    cut: boolean = shaftLive,
    mirror: boolean = mirrorLive,
  ): void => {
    if (twoSided === side && shaftCut === cut && mirrorIn === mirror) return
    twoSided = side
    shaftCut = cut
    mirrorIn = mirror
    // ── both keys are REBUILT, in this order, every time (DEV-194) ────────
    //
    // The two lines below used to be `if (x) defines.K = '' else delete
    // defines.K`, and that makes the program cache key a function of the
    // HISTORY rather than of the STATE. `getProgramCacheKey` walks
    // `for (const name in parameters.defines)` — JavaScript insertion order —
    // so assigning a key that is already there keeps its slot while a
    // delete-then-re-add moves it to the END. Both defines present is
    // therefore TWO different cache keys for one piece of GLSL:
    //
    //   [TWO_SIDED, SHAFT]  what construction builds, and all `warmVariants`
    //                       ever produces, because it only ever ADDS to a
    //                       state that already has TWO_SIDED first.
    //   [SHAFT, TWO_SIDED]  what the first dive back toward the sea builds,
    //                       because the eye leaving the water deleted
    //                       TWO_SIDED while the bore stayed live.
    //
    // `clearShaftBore` was never called by `boot/app.ts` then, so the bore
    // was live for the whole mission and every mission crosses the surface.
    // (Since DEV-460 it is called once, when the lift plugs the shaft's hatch;
    // the key is the state's either way, which is this block's point.) Measured:
    // that flip is `int_01_hoverJet`'s 178.6 ms freeze at 77.2 s (one program)
    // and half of `adv_02_hoverJet`'s 318.4 ms freeze at 5.0 s (two, because
    // the fog flag below had split the sea into two materials to pay it on).
    //
    // Deleting both first costs two property deletes on a path that already
    // dirties every material, and buys a key that cannot depend on the route
    // the flight took to get here. `STANDARD` is three's own and is never
    // touched, so it keeps its slot at the front.
    //
    // DEV-583 added a third key, the mirror, and it is rebuilt with the other
    // two in the same fixed order: deleted first, re-added LAST. Absent while
    // the mirror is off, so a sea without one compiles the text it always did.
    delete defines.FF2_WATER_TWO_SIDED
    delete defines.FF2_WATER_SHAFT
    delete defines[MIRROR_DEFINE]
    if (side) defines.FF2_WATER_TWO_SIDED = ''
    if (cut) defines.FF2_WATER_SHAFT = ''
    if (mirror) defines[MIRROR_DEFINE] = ''
    // ── every facet clone as well as the base — see `skinned` ──────────
    //
    // This loop looks redundant and is not. `materialFor`'s clones currently
    // share THIS `defines` object by reference, so the two assignments above
    // have already reached them — but `side` has not (it is a field, not a
    // key of that object) and neither has `needsUpdate`, and both are in
    // three's program cache key. A band left behind is not a dim picture: it
    // is the sea two-sided in the chunks you are over and one-sided in the
    // chunks beyond them.
    //
    // And if `materialFor` is ever changed to hand out a COPY of the defines
    // instead of the reference — which is the tidier-looking thing to do —
    // this loop becomes the only thing holding the invariant at all.
    // `ocean-density.test.ts`'s "moves every band when the sea changes
    // variant" asserts the RELATIONSHIP rather than either mechanism, so it
    // stays honest through that change; this comment is here so nobody deletes
    // the loop believing the sharing makes it free.
    for (const m of skinned) {
      m.side = side ? THREE.DoubleSide : THREE.FrontSide
      m.defines = defines
      m.needsUpdate = true
    }
  }

  // ── three's own fog flag, OFF before the first clone exists (DEV-194) ────
  //
  // `unity-fog.ts`'s `applyTo` already sets this, and it is set again here, and
  // that is the point: WHEN it happens decides how many programs the sea has.
  //
  // `boot/app.ts` patches `ocean.materials` — the BASE — only after
  // `loadTerrain` has resolved, and deliberately not the band clones, because
  // handing a clone to `applyTo` splices the fog prologue onto a chain that
  // already delegates through it: `'vUnityFogWorldPos' : redefinition`, and the
  // sea does not compile at all (DEV-183). But `materialFor` cuts its bands
  // WHILE the chunks are being built, i.e. before that patch — and `fog` is a
  // plain property, so `Material.copy` carries whatever it was at the clone's
  // birth. A band cut before the patch kept `true` for the life of the mission
  // while the base went `false`.
  //
  // `material.fog` is `parameters.useFog`, which is bit 1 of three's second
  // `_programLayers` mask and therefore in the cache key. `USE_FOG` is emitted
  // only for `useFog && fog` (three's own prefixes; see
  // `tests/unit/water-fog-flag.test.ts` §1), and `parameters.fog` is the
  // SCENE's fog, which this renderer never sets — `scene.fog` stays null on
  // purpose, that is the first thing `unity-fog.ts` explains. So the two
  // materials compiled **textually identical GLSL** and existed separately
  // because of a flag that cannot reach the shader. Measured on
  // `adv_02_hoverJet`: the sea's variant flip cost two compiles instead of one.
  //
  // ── why here, and not a re-sync in `materialFor` ─────────────────────────
  //
  // Because this is the only version with no ordering in it. Re-syncing a
  // cached band from the base would have to run on every `materialFor` — a
  // band is cut at most once and memoised in `byFacet`, so a birth-time sync
  // is a no-op when the base is still `true` as well — and that repair lands
  // IN FLIGHT, flipping a live material's key and re-resolving its program
  // exactly where the freeze we are removing lives. Pinning the value before
  // the first clone can be cut means the sea has ONE value of this flag,
  // always, and nothing downstream has to know the patch order.
  //
  // The clone-side half of the invariant is still asserted, in
  // `materialFor` and in the unit gate: *every band agrees with its base*. That
  // is the relationship, and it stays true if this mechanism is ever replaced.
  setFogFlag(material, false)

  // Until somebody says where the eye is, draw what shipped. A caller that
  // never calls `setEyeHeight` gets 2026-09-16's sea exactly.
  applyVariant(true)

  // The token was added above (computed from `specular` and `reflects`, which
  // gate GLSL), so this chains the hook alone.
  chainBeforeCompile(material, (shader) => {
    Object.assign(shader.uniforms, uniforms)

    shader.vertexShader = `
uniform float uWaveTime;
uniform vec4 uWave;
uniform float uWaveSpeed;
varying vec3 vWaterWorld;
#ifdef ${MIRROR_DEFINE}
varying vec4 vFf2MirrorClip;
#endif

${shader.vertexShader}`.replace(
      VERTEX_HOOK,
      `${VERTEX_HOOK}
  {${WAVE_GLSL}
  }${MIRROR_VERTEX_GLSL}`,
    )

    shader.fragmentShader = `
varying vec3 vWaterWorld;
/** One water quad in WORLD metres. See the normal block below. */
uniform float uFacet;
/** cos of the steepest lean the wave can give one quad. See the same block. */
uniform float uTiltCos;
uniform vec4 uReflect;
uniform float uReflectFresnel;
/** The launch shaft's bore: (x, z, radius, rim y), world space. See setShaftBore. */
uniform vec4 uShaftBore;
/** The bore's outline: one reach per world azimuth, four to a vec4. DEV-460. */
uniform vec4 uShaftReach[${SHAFT_REACH_STEPS / 4}];
float ff2ShaftReach(int k) {
  vec4 q = uShaftReach[k / 4];
  int c = k - (k / 4) * 4;
  return c == 0 ? q.x : (c == 1 ? q.y : (c == 2 ? q.z : q.w));
}
uniform vec3 uReflectSh[9];
uniform vec4 uSpec;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
/** The wave's own uniforms again, this time for the FRAGMENT. See ff2CoastChop. */
uniform vec4 uWave;
uniform float uWaveTime;
uniform float uWaveSpeed;
${WATER_SURFACE_GLSL}
${MIRROR_FRAGMENT_GLSL}
${COAST_CHOP_GLSL}
${COAST_GLSL}
${shader.fragmentShader}`
      .replace(
        COAST_HOOK,
        `${COAST_HOOK}
  // ── the shore ────────────────────────────────────────────────────────
  //
  // DEV-087, and it is an ALBEDO change: shallow water over a beach is a
  // different colour of water, and foam is high-albedo water, so both belong
  // here — before the lighting, the specular, the sky reflection, the haze and
  // the fog, every one of which then runs on top unchanged.
  //
  // Inert on Classic, and inert before a coast has been attached, without a
  // branch at this call site: ff2Coast returns its first argument when both
  // strengths are zero, which is what setCoast leaves them at.
  //
  // DEV-238's arm. Inert on Classic is not the same as free on Anniversary:
  // with a shore attached this evaluates the wave a SECOND time per fragment
  // (ff2CoastChop) and takes a texture fetch against the island's height map
  // (ff2CoastDepth). The gate removes both, and on Classic it removes a
  // uniform branch that was already returning its first argument — which is
  // the arm saying so rather than a reader assuming it.
  #ifndef ${GATE_WATER_NO_COAST}
  diffuseColor.rgb = ff2Coast(diffuseColor.rgb, vWaterWorld, ff2CoastChop(vWaterWorld));
  #endif`,
      )
      .replace(
        NORMAL_HOOK,
        `${NORMAL_HOOK}
  {
    // ── cull the face you cannot see, PER FRAGMENT ─────────────────────
    //
    // The material is DoubleSide because the underside has to exist at all,
    // and turning culling off globally was not free the way the first pass of
    // this change claimed. Above the waterline it puts back-facing facets —
    // the ones tilted away from the eye, which is exactly the degenerate
    // regime DEV-050 is about — into the sun's glint band, and the
    // 25.728-exponent specular blows them to pure white. Measured on
    // int_01 at y = 112.6, as the fraction of a 140x340 px box beside the
    // glint carrying a per-pixel step of 1.5 to 24 grey levels:
    //
    //     DoubleSide, no discard      35.6 % and 37.4 %   (two samples)
    //     FrontSide                    1.1 % and  0.6 %
    //
    // So: reproduce the culling here instead, where the answer can depend on
    // which side of THIS piece of surface the eye is on. Above it the visible
    // face is the up-facing one, which is the front face; below it the visible
    // face is the underside, which is the back face. Both occur in one frame at
    // the breach, which is why a per-draw side= cannot express it.
    //
    // Above the waterline this is byte-for-byte the old FrontSide, holes and
    // all: a facet that tilts away further than the view is grazing was culled
    // in 2016, was culled by this port before, and is culled here.
    #ifdef FF2_WATER_TWO_SIDED
      if ((waterEyeSide(vWaterWorld) > 0.0) != gl_FrontFacing) discard;
    #endif

    // ── the launch shaft is a hole in the sea ──────────────────────────
    //
    // DEV-106. The shaft is a sealed tube and there is no water inside it;
    // this plate is 262 km wide and would draw straight through. A test in
    // world space, in the shader that is already paying for a discard.
    //
    // DEV-460: the hole has the SHAFT's outline, not a circle. 2016's shaft
    // is a square with its corners let out, 5.6 to 9.4 m from the lift, so
    // a circle either floods the corners (the sea met the eye there) or
    // opens the sea past the thin walls. uShaftBore.z is the circle the
    // outline is inside, and only a fragment within it reads the outline.
    #ifdef FF2_WATER_SHAFT
      if (uShaftBore.z > 0.0 && vWaterWorld.y < uShaftBore.w) {
        vec2 fromAxis = vWaterWorld.xz - uShaftBore.xy;
        float fromR = length(fromAxis);
        if (fromR < uShaftBore.z) {
          float turn = atan(fromAxis.y, fromAxis.x) * (${SHAFT_REACH_STEPS}.0 / 6.28318530718);
          if (turn < 0.0) turn += ${SHAFT_REACH_STEPS}.0;
          int k0 = int(floor(turn));
          float along = turn - float(k0);
          if (k0 >= ${SHAFT_REACH_STEPS}) k0 = 0;
          int k1 = k0 + 1 >= ${SHAFT_REACH_STEPS} ? 0 : k0 + 1;
          if (fromR < mix(ff2ShaftReach(k0), ff2ShaftReach(k1), along)) discard;
        }
      }
    #endif

    // ── DEV-238's arm, and what it leaves behind ──────────────────────────
    //
    // Everything to the end of this block is ONE term: two screen-space
    // derivatives, a cross, a normalize, a second waterEyeSide, a footprint
    // blend and a tilt clamp with a square root in it. Gating it leaves
    // normal exactly as normal_fragment_begin computed it — the MESH's own
    // normal, smoothed and taken before the wave moved a vertex — so the
    // specular and the reflection below still have a normal to shade with and
    // the arm prices the derivation rather than the lighting.
    //
    // The picture is wrong under this arm, on purpose: it is the flat-shaded
    // sea the derivative exists to replace. It is not a candidate cut, it is
    // the number that says whether the sea's fill is the DERIVATION or the
    // terms that consume it — the same question FF2_UNLIT asks of the land.
    //
    // The two discards above are deliberately OUTSIDE it. They are their own
    // variant axis (FF2_WATER_TWO_SIDED / FF2_WATER_SHAFT), DEV-209 has already
    // priced the second at 0.06 ms, and folding them in here would make one arm
    // move two things.
    #ifndef ${GATE_WATER_NO_NORMAL}
    // Per-FACE normal from the displaced surface. The mesh's own normals were
    // computed before the wave moved anything, and the faceted look wants flat
    // shading anyway, so both problems are one derivative.
    vec3 dPdx = dFdx(vWaterWorld);
    vec3 dPdy = dFdy(vWaterWorld);
    vec3 faceNormal = normalize(cross(dPdx, dPdy));

    // ── which way is OUT ────────────────────────────────────────────────
    //
    // Screen-space derivatives do not know. This used to answer "the surface
    // is a sea seen from above, so up wins" — and for 97 m of the 106 m launch
    // ride the eye is UNDER it, so up was the wrong way for twelve seconds of
    // every mission's opening shot. See the header.
    //
    // "up" is now out of the surface ON THE EYE'S SIDE, which is a reflection
    // about the horizontal rather than a different rule: the facet's tilt away
    // from vertical is untouched, so the footprint blend and the tilt clamp
    // below both mean exactly what they meant before. Per fragment, because
    // the surface is above the eye out to the horizon and below it nearer in.
    vec3 up = vec3(0.0, waterEyeSide(vWaterWorld), 0.0);
    faceNormal = dot(faceNormal, up) < 0.0 ? -faceNormal : faceNormal;

    // ── the grazing-angle speckle, and why this is here ─────────────────
    //
    // A screen-space derivative measures the surface across ONE PIXEL. Look
    // along the sea instead of down at it and that pixel covers hundreds of
    // metres of water, so the 2x2 quad the derivative is taken over straddles
    // several facets and several wave periods — and what comes back is not the
    // facet's normal, it is noise. Neighbouring pixels then get wildly
    // different normals, the 25.7-exponent specular amplifies the difference,
    // and the sea fills with salt-and-pepper stipple.
    //
    // Measured from mid-shaft on int_01 at y = 60, looking out across the
    // water, as the fraction of pixels in the band with a horizontal step over
    // 24/255:
    //
    //     baseline                     9.04 %
    //     specular removed             6.49 %
    //     reflection removed           8.27 %
    //     specular AND reflection      6.37 %
    //     FLAT normal, everything on   0.80 %
    //
    // So it is not the specular and it is not the reflection — it is this
    // normal, and the lighting terms only make it visible. ?znear=20 (25x
    // the depth precision) moved it 9.04 -> 7.50, and ?wire=ocean showed
    // clean terrain behind, so it is neither z-fighting nor the seabed.
    //
    // The fix is the one a mip-map makes for a texture: when a pixel covers a
    // whole facet, stop pretending to know which way that facet points and use
    // the surface's mean normal, which for a sea is up. uFacet is one quad in
    // world metres. Nothing changes where the footprint is small, which is
    // every pixel of every view that looks at the water rather than along it.
    //
    // This is FF2's own bug, not 2016's: the 2016 shader shades from VERTEX
    // normals and never takes a derivative. Deriving the flat normal in the
    // fragment shader is this port's substitute (see the header), so this is
    // repairing the substitute rather than deviating from the original.
    float footprint = max(length(dPdx), length(dPdy));
    float flatten = clamp(footprint / uFacet, 0.0, 1.0);
    faceNormal = normalize(mix(faceNormal, up, flatten));

    // ── and a clamp the GEOMETRY justifies, because the blend is not enough
    //
    // The blend above is the mip-map argument and it is correct, but it fades
    // in over the footprint and the worst pixels here are the ones where the
    // two derivatives are nearly PARALLEL — both pointing along the view — so
    // cross() is a near-zero vector whose DIRECTION is floating-point error.
    // A footprint measure cannot see that: the derivatives are long, it is
    // their angle that has collapsed. Measured, the blend alone took the band
    // from 9.04 % to 8.43 %.
    //
    // So: cap how far the normal may lean. A water facet cannot lean far. The
    // wave's whole range is (0, amplitude] metres — 4 m on Simonet — across one
    // quad, so the steepest face the mesh can produce is atan(amplitude/facet):
    // 7.1 degrees at ?ocean=8, 0.9 at ?ocean=1. Anything past that is not a
    // facet, it is noise, and uTiltCos is the cosine of that angle with a
    // little headroom. Exact, cheap, and derived from the two numbers that
    // decide it rather than tuned.
    float lean = dot(faceNormal, up);
    if (lean < uTiltCos) {
      vec3 side = faceNormal - up * lean;
      float sideLen = length(side);
      // Straight up: there is no direction to lean in, and nothing to clamp.
      faceNormal = sideLen > 1e-6
        ? normalize(up * uTiltCos + (side / sideLen) * sqrt(max(0.0, 1.0 - uTiltCos * uTiltCos)))
        : up;
    }
    normal = faceNormal;
    #endif
  }`,
      )

    if (specular) {
      shader.fragmentShader = shader.fragmentShader.replace(
        REFLECT_HOOK,
        `#ifndef ${GATE_WATER_NO_SPECULAR}
{
  // ── the faceting ─────────────────────────────────────────────────────
  //
  // Legacy Blinn-Phong, exactly as the 2016 shader computes it: pow(NdotH,
  // _Shininess * 128) times _SpecColor. _SpecColor is (0.5, 0.5, 0.5) — 50 %
  // reflectance — where a metalness-0 standard material gives 0.04. Twelve
  // times, and it is the whole difference between a sea with a glint on every
  // facet and a sheet of flat colour.
  //
  // The normal here is the per-FACE one from the derivative above, so each
  // 256 m facet answers the sun differently. That is where the faceting comes
  // from: not the colour map (water_color is one flat texel) and not the
  // geometry (a 4 m wave across 256 m is about a degree), but this.
  //
  // ── and only from ABOVE ────────────────────────────────────────────────
  //
  // The sun is on the other side of this surface when the eye is under it, so
  // there is no highlight of it to see: what reaches the underside comes
  // THROUGH, which is what waterThroughSurface is for.
  //
  // This gate is not a tidy-up. The claim it replaces — "with the normal
  // turned down, N.h collapses and the lobe vanishes on its own" — was
  // measured before it was believed, and it is false. Blinn-Phong peaks where
  // the half vector IS the normal, so invert it: toEye = 2 (N . S) N - S is
  // the eye direction that puts h exactly on a given facet, and for a facet
  // tilted the full 7.13 degrees TOWARD the sun's azimuth that eye is UNDER
  // the water, by 0.178 of downward component. N.h is then **1**, and
  // pow(N.h, 25.728) * 0.5 is **0.5** — _SpecColor at full strength, a
  // mirror-sharp highlight of a sun on the other side of the surface. It is a
  // construction rather than a sample, and it is in
  // tests/unit/water-underside.test.ts.
  if (waterEyeSide(vWaterWorld) > 0.0) {
    vec3 toEye = normalize(cameraPosition - vWaterWorld);
    vec3 halfway = normalize(toEye + uSunDir);
    float ndh = max(dot(normal, halfway), 0.0);
    // The sun this glint reflects is the mission sun, and where a mountain
    // stands between the sea and it there is no sun to reflect. DEV-116 put the
    // terrain-shadow term on three's direct light, which is upstream of here;
    // this specular is injected downstream and kept its full 4-degree glint
    // inside 800 m of shadow — a bright band running from a cliff's foot across
    // a bay the same frame had just darkened (DEV-133). Same term, same
    // mountain, same answer. Under #ifdef because the term arrives by a
    // separate patch (render/far-shadow.ts) that defines it; without that
    // patch this line compiles to what it always was.
    float sunSeen = 1.0;
    #ifdef FF2_SUN_HEIGHT
      sunSeen = ff2SunHeightTerm();
    #endif
    outgoingLight += uSpec.rgb * pow(ndh, uSpec.w) * uSunColor * sunSeen;
  }
}
#endif
${REFLECT_HOOK}`,
      )
    }

    if (reflects) {
      shader.fragmentShader = shader.fragmentShader.replace(
        REFLECT_HOOK,
        `#ifndef ${GATE_WATER_NO_REFLECT}
{
  vec3 viewDir = normalize(vWaterWorld - cameraPosition);
  if (waterEyeSide(vWaterWorld) < 0.0) {
    // ── the ceiling ────────────────────────────────────────────────────
    //
    // Under the surface the sky does not bounce off it, it comes THROUGH it,
    // and only through the 48.6-degree cone about the vertical that Snell's
    // law allows. Outside that cone the surface mirrors the water below,
    // which is the dark base colour this is being added to — so there is
    // nothing to add there, and waterThroughSurface returning zero is the
    // right answer rather than a missing case.
    //
    // Tinted by _ReflectColor's rgb and NOT scaled by its alpha: the alpha
    // is 2016's reflection STRENGTH and there is no reflection here. The rgb
    // stays because (0.235, 0.302, 0.420) is a blue-shifted attenuation, which
    // is the right shape for sixty metres of water between the eye and the
    // surface, and because it is a shipped number rather than a taste.
    outgoingLight += waterThroughSurface(viewDir, normal) * uReflect.rgb;
  } else {
    // Schlick, with the shipped _ReflectionFresnel as the exponent scale. At
    // grazing incidence this goes to 1, which is what makes water read as water
    // and what turns a one-degree facet tilt into something you can see.
    vec3 refl = reflect(viewDir, normal);
    float cosine = clamp(1.0 - abs(dot(viewDir, normal)), 0.0, 1.0);
    float f = mix(1.0, pow(cosine, 5.0), 1.0 - uReflectFresnel);
    // UNITY space for the SH, as everywhere else: our world is Unity's mirrored.
    vec3 sky = waterSkyRadiance(vec3(refl.x, refl.y, -refl.z));
    #ifdef ${MIRROR_DEFINE}
    // DEV-583: the islands, the clouds and the racers, over that sky, and the
    // sum takes the same tint, strength and Fresnel the sky alone took.
    sky = ff2SeaMirror(sky, normal);
    #endif
    outgoingLight += sky * uReflect.rgb * (f * uReflect.a);
  }
}
#endif
${REFLECT_HOOK}`,
      )
    }

    // ── the gates are in the OUTPUT, or this throws ───────────────────────
    //
    // DEV-238. Every failure in this family is silent by nature: the shader
    // still compiles, the frame still renders, and the arm simply reports
    // 0.00 ms — which is indistinguishable, from the outside, from a real
    // result. `fragment-gates.ts` makes the same assertion for the same reason
    // and its comment carries the four sessions of DEV-069 that paid for it.
    //
    // The assertion is a PAIR, not a list: *if the statement is in the output,
    // its gate is too.* Keyed off the statement rather than off `specular` /
    // `reflects` / the hooks, because those are three different ways of saying
    // the same thing and only the statement is the thing that costs. A sea with
    // no `_SpecColor` has no glint to guard and no glint to pay for, and a
    // shader handed to this patch without three's `color_fragment` in it never
    // got the shore either — in both cases there is nothing to gate and nothing
    // to measure, and a throw there would be an assertion about the caller.
    const pairs: readonly (readonly [string, string])[] = [
      ['ff2Coast(diffuseColor.rgb', GATE_WATER_NO_COAST],
      ['vec3 dPdx = dFdx(vWaterWorld);', GATE_WATER_NO_NORMAL],
      ['outgoingLight += uSpec.rgb', GATE_WATER_NO_SPECULAR],
      ['outgoingLight += sky * uReflect.rgb', GATE_WATER_NO_REFLECT],
    ]
    for (const [statement, define] of pairs) {
      if (shader.fragmentShader.includes(statement) && !shader.fragmentShader.includes(define)) {
        throw new Error(
          `water: ${define} did not land in the patched shader while the statement it guards did ` +
            '— its anchor has moved, and the arm that names it would measure nothing while ' +
            'looking like a result.',
        )
      }
    }
    // DEV-583: the mirror's varying is written in the VERTEX half and read in
    // the fragment one. A fragment that reads it with no writer compiles and
    // samples the mirror at a garbage position, which is a picture rather than
    // an error, so it is refused here instead.
    if (
      shader.fragmentShader.includes('sky = ff2SeaMirror(sky, normal);') &&
      !shader.vertexShader.includes('vFf2MirrorClip = projectionMatrix')
    ) {
      throw new Error(
        'water: the mirror lookup landed in the fragment shader without its vertex half (DEV-583)',
      )
    }
  })

  // ── one material per FACET SIZE (DEV-183) ─────────────────────────────
  //
  // Keyed by the facet in world metres, seeded with the base so a caller that
  // asks for the size it was constructed with gets the material it passed in
  // and nothing is cloned at all — which is every terrain but a subdivided
  // ocean, and the ocean at one subdivision for every LOD.
  const byFacet = new Map<number, THREE.Material>([[baseFacet, material]])

  // The island's map and placement, or null until `setCoastSource` lands. Held
  // rather than only pushed, because `setCoast` has to be able to REFUSE a
  // preset that arrives before the map does — an Anniversary boot sets the
  // preset from `editionState` at construction and the terrains land seconds
  // later, so the two orders both happen every run.
  let coastSource: CoastMap | null = null

  return {
    displace: d,
    setTime(seconds) {
      uniforms.uWaveTime.value = seconds
    },
    setSunDirection(direction) {
      uniforms.uSunDir.value
        .set(
          -((direction[0] as number) ?? 0),
          -((direction[1] as number) ?? -1),
          -((direction[2] as number) ?? 0),
        )
        .normalize()
    },
    setCoastSource(map, heightMap) {
      coastSource = map
      uniforms.uCoastMap.value = heightMap ?? placeholderCoastMap()
      if (map) {
        uniforms.uCoastPlane.value.set(
          map.originX,
          map.originZ,
          map.sizeX === 0 ? 0 : 1 / map.sizeX,
          map.sizeZ === 0 ? 0 : 1 / map.sizeZ,
        )
        // The half texel between `GetPixelBilinear`'s `u * width` and GL's
        // `s * width - 0.5`. On Simonet that is 2 m of shoreline — a quarter of
        // a land facet, and invisible enough to have shipped. See coast.ts.
        uniforms.uCoastLand.value.set(
          map.originY,
          map.heightScale,
          map.width > 0 ? 0.5 / map.width : 0,
          map.height > 0 ? 0.5 / map.height : 0,
        )
      }
    },
    setCoast(settings) {
      // No map, no shore — whatever the preset says. A depth read against a
      // sampler that is one black texel would put the whole sea at the
      // shallowest colour, which is a louder failure than the one it hides.
      const s = coastSource ? settings : COAST_OFF
      uniforms.uCoastRamp.value.set(...coastPack(s))
      uniforms.uCoastShallow.value.set(...s.shallowColor)
      uniforms.uCoastFoam.value.set(...s.foamColor)
      uniforms.uCoastBreakup.value = s.foamBreakup
    },
    bobAt(seconds, originUnity) {
      return waterDisplacement(d, originUnity[0], originUnity[2], seconds)
    },
    materialFor(facetMetres) {
      const facet = Math.max(1e-3, facetMetres)
      const cached = byFacet.get(facet)
      if (cached) return cached
      // ── the two uniforms this whole clone exists for ──────────────────
      //
      // Their own objects, because the base's chain assigns the base's: one
      // `Object.assign(shader.uniforms, uniforms)` above, shared by every
      // material that runs it. Overriding AFTER the chain is exactly what
      // `render/lod-fade.ts` does with `uLodFade`, and for the same reason:
      // three uploads a material's uniforms once per material per frame, so a
      // per-chunk value has nowhere else to live.
      const own = {
        uFacet: { value: facet },
        uTiltCos: { value: Math.cos(maxFacetTiltRadians(d.amplitude, facet)) },
      }
      // The recipe is `render/delegating-clone.ts`'s. The chain is the base's
      // read at CALL time (so patches `boot/app.ts` adds after this clone is cut
      // are in it too), DEV-192's cut arrives through it, and the key is the
      // base's: `acquireProgram` hands back the program the base already
      // compiled. The facet is a UNIFORM, so there is nothing here to vary: N
      // facet sizes are N materials and ONE program, and `warmVariants` still
      // warms four in total rather than four per size.
      //
      // `defines: 'share'`: the SAME object as the base's, born into the variant
      // that is in force and moved by every later `applyVariant`. See `skinned`.
      // The helper also states `side` and `fog` beside it, because these three
      // ARE the invariant the sea's program count depends on: **a band agrees
      // with its base on every field three hashes into the cache key.** `side`
      // and `defines` are there because `copy()` gets them wrong; `fog` because
      // `copy()` gets it right at a moment that may be wrong (DEV-194, see the
      // pin beside `applyVariant(true)`).
      const clone = delegatingClone(material, {
        defines: 'share',
        override: (shader) => {
          shader.uniforms.uFacet = own.uFacet
          shader.uniforms.uTiltCos = own.uTiltCos
        },
      })
      clone.name = `${material.name || 'water'}:facet${facet}`
      skinned.push(clone)
      byFacet.set(facet, clone)
      return clone
    },
    deriveMaterial(spec) {
      const clone = delegatingClone(material, {
        defines: 'share',
        keySuffix: spec.keySuffix,
        override: (shader) => {
          Object.assign(shader.uniforms, spec.uniforms)
          spec.patch(shader)
        },
      })
      clone.name = `${material.name || 'water'}:${spec.name}`
      skinned.push(clone)
      return clone
    },
    setShaftBore(x, z, radius, topY, reach) {
      // The outline: the one given, or the circle as it always was.
      const table = uniforms.uShaftReach.value
      if (reach && reach.length !== table.length) {
        throw new Error(`water: a shaft reach needs ${table.length} entries, got ${reach.length}`)
      }
      let bound = radius
      for (let k = 0; k < table.length; k++) {
        const r = reach ? (reach[k] as number) : radius
        table[k] = r
        if (r > bound) bound = r
      }
      uniforms.uShaftBore.value.set(x, z, bound, topY)
      // The bore's GLSL is a define now, so setting the uniform is no longer
      // enough on its own — `applyVariant` is what puts the test in the shader.
      // Live on the BOUND: an outline handed in with a zero `radius` is a hole
      // (DEV-460's first browser run read `radius` here, took the define off,
      // and drew the sea straight across the shaft).
      shaftLive = bound > 0
      applyVariant(twoSided ?? true)
    },
    clearShaftBore() {
      uniforms.uShaftBore.value.set(0, 0, 0, 0)
      shaftLive = false
      applyVariant(twoSided ?? true)
    },
    mirrors,
    setMirror(texture) {
      const on = mirrors && texture !== null
      uniforms.uFf2Mirror.value = on ? texture : null
      if (on) mirrorEver = true
      mirrorLive = on
      applyVariant(twoSided ?? true)
    },
    setEyeHeight(eyeY, seaY) {
      // ── the margin, and why it is this shape ────────────────────────────
      //
      // The shader's test is per fragment: `cameraPosition.y < surfaceWorld.y`.
      // The cheap variant is only equivalent to it when EVERY visible piece of
      // surface is below the eye, so the margin has to cover how far up the
      // surface can reach from `seaY`: one wave amplitude at the vertex, and
      // `seaY` already carries the plate's own bob because the caller applied
      // it this frame.
      //
      // The extra metre is not slack for its own sake — it is the distance a
      // wave can climb between the frame this decides on and the frame it is
      // drawn in, which at 4 m of amplitude and 80 ms of latency is nothing
      // like a metre. The hysteresis below is the part that matters.
      const surfaceTop = seaY + d.amplitude + 1
      // Asymmetric on purpose: go two-sided the moment the eye is within reach
      // of the surface, and come back out only 6 m clear of it. A pilot
      // skimming the sea at the threshold would otherwise flip the variant —
      // and a variant flip is a program swap, i.e. a hitch, every frame.
      // The bore is the OTHER axis and is left exactly as it is — the eye
      // spends the top fifteen metres of the shaft above the water and still
      // inside the tube.
      applyVariant(twoSided === false ? eyeY < surfaceTop : eyeY < surfaceTop + 6)
    },
    warmVariants(compile) {
      const wasSide = twoSided === true
      const wasCut = shaftCut === true
      // All FOUR, because a ride uses three of them in twelve seconds —
      // two-sided with the bore at the bottom, above-water with the bore
      // through the last fifteen metres of shaft, above-water without it once
      // the rim clears — and the fourth costs one more cached compile.
      //
      // The caller's `compile` is scoped to the OCEAN's group with the scene
      // supplied for its lights, and `warm-up.ts`'s `duringWarm` is what runs
      // it with the flight's render target bound and the launch room hidden.
      // Both are in three's program cache key; a compile made outside that
      // bracket builds programs the game never draws with (DEV-177(b) measured
      // them: `outputColorSpace = srgb` and `numPointLights = 3` against the
      // flight's `srgb-linear` and 2).
      //
      // DEV-583: and, once the mirror has been on for this sea, both of ITS
      // states, so a headset session or the quality row leaving ultra swaps
      // to a linked program rather than compiling one. Eight then; four for
      // every sea that has never had the mirror, which is every tier but
      // ultra and every headset.
      const wasMirror = mirrorIn === true
      const mirrorStates = mirrorEver ? [true, false] : [false]
      for (const mirror of mirrorStates) {
        for (const side of [true, false]) {
          for (const cut of [true, false]) {
            applyVariant(side, cut, mirror)
            compile()
          }
        }
      }
      // Restored LAST, so a caller that warms after the first `setEyeHeight`
      // does not leave the sea in a variant nobody asked for.
      applyVariant(wasSide, wasCut, wasMirror)
      compile()
    },
  }
}
