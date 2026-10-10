// src/content/edition-schema.ts — the runtime's view of an edition preset.
//
// **This file follows `content/editions/_schema.json`, not the other way
// round.** The JSON is the gate (`tests/unit/edition-content.test.ts` validates
// both presets against it, and refuses a key it has never heard of); these
// types describe what the presets carry. If the two disagree, the JSON is right
// and this file is stale — the same rule `level-schema.ts` lives under.
//
// ── What an edition is ───────────────────────────────────────────────────
//
// docs/plan/ANNIVERSARY.md §0: the product is *Faceted Flight: 10th Anniversary
// Edition*, and inside it are two PRESETS. `classic` is the ledger as it stands
// — every DEV row, every kept bug, byte-faithful where the port is faithful.
// `anniversary` is a curated set of further deviations, each one a DEV row like
// any other, each individually switchable here.
//
// THE PRESET IS CONTENT, NOT CODE. A feature's flag AND its tuning numbers live
// in the preset JSON, and `src/` reads them (hard rule 6; rule 3's reasoning —
// a number typed into `render/` is indistinguishable from an extracted one in
// six months). Adding a tuning key means: this file, the schema, and BOTH
// preset files, or the content test says so.
//
// ── What it must never touch ─────────────────────────────────────────────
//
// Nothing the golden trajectories, the oracle sweep or the ghost replays can
// see. Every Phase 1 feature is render, audio or cockpit art and reaches no
// further than that.
//
// **Phase 2's first row is the exception that proves the shape of the rule**
// (T1 / DEV-085): the detail ring hands four numbers to `sim/terrain/detail.ts`,
// because the thing being re-tuned IS a generator parameter and a number typed
// into the generator would be indistinguishable from an extracted one. What
// makes that safe is not the layer, it is the reach — the ring can only produce
// geometry at a level BELOW 0, LOD 0 and above are untouched byte for byte, and
// the collision height field is a different surface built from a different grid
// (DEV-041). If a preset key ever moves a number the oracle compares or the sim
// integrates, that is a different kind of change and it needs a different
// argument.
//
// A GAMEPLAY lever (ANNIVERSARY.md §4.1) is a separate, explicitly tagged
// section that does not exist yet, lives in `src/game/`, and gets its own DEV
// row and tests when it arrives. Classic never reads it.

// A LEAF with no imports of its own, so reading the comfort aperture's floor
// here costs nothing: importing `render/vignette.ts` for the same number would
// drag `three` into `audio/engine.ts` and into every node-environment unit test
// that reads this schema. `aperture.ts`'s header says why the four numbers moved.
import { R_CLOSED_STRONG } from '@/render/aperture'
// The sim owns the numbers it is tuned by; this schema derives from them
// (type-only, erased), so a field cannot be added to one side alone (XC-16).
import type { BoatSpec } from '@/sim/life/boats'
import type { PodSpec } from '@/sim/life/pods'
import type { DressingBand } from '@/sim/props/dressing'
import { PROP_KINDS as PROP_KIND_LIST, type PropKind } from '@/sim/props/generate-shapes'
import type { ProximitySpec } from '@/sim/proximity'

/** The two presets. Matches the basenames under `content/editions/`. */
export const EDITION_IDS = ['classic', 'anniversary'] as const
export type EditionId = (typeof EDITION_IDS)[number]

/** three.js tone mapping, by name. `none` is what shipped. */
export const TONE_MAPPINGS = ['none', 'aces', 'agx', 'neutral'] as const
export type ToneMappingId = (typeof TONE_MAPPINGS)[number]

/**
 * What the speed row on the cockpit readout is measured in.
 *
 * `ms` is what shipped: `HudState.speed` is metres per second and 2016 prints
 * `Math.round` of it with no unit at all. 170 is 612 km/h and nothing tells the
 * player (ANNIVERSARY.md §2.2, §2.5 S8).
 *
 * NOT a feature — it is an enum with no "off", so it does not appear in
 * `editionFeatures` and Classic's value is not `false`, it is `ms`. The Classic
 * invariant that matters here is stricter than a flag being off: the panel must
 * be PIXEL-IDENTICAL, same text, no unit, and `render/hud.ts` reaches that by
 * defaulting to this and printing exactly what it printed before.
 */
export const SPEED_UNITS = ['ms', 'kmh'] as const
export type SpeedUnitId = (typeof SPEED_UNITS)[number]

/**
 * The generated prop families a `props.scatter` band may ask for.
 *
 * Imported from the generator rather than re-typed, so the enum in
 * `_schema.json`, the type here and the shape table in `sim/props/
 * generate-shapes.ts` cannot drift apart into three lists that disagree. A
 * preset naming a fourth kind is then a *missing shape*, which fails loudly,
 * rather than a silently empty scatter.
 */
export type PropKindId = PropKind
export { PROP_KINDS } from '@/sim/props/generate-shapes'

/**
 * The shape every switchable feature shares: on or off, and a line for the
 * person reading the file. A feature that grows tuning keys extends its OWN
 * interface below rather than this one, so the schema can stay a gate per
 * feature.
 */
export interface EditionFeature {
  readonly enabled: boolean
  readonly note?: string
}

/**
 * Aerial perspective as its own term — NOT the mission fog, whose numbers are
 * settled (DEV-018/018b) and which nothing here touches. ANNIVERSARY.md V4,
 * DEV-082.
 *
 * Keeps `EditionFeature`'s shape (`enabled`, optional `note`) and adds the
 * tuning, so `editionFeatures` can still walk it as a feature while the numbers
 * live where every other preset number lives.
 */
export interface EditionHaze extends EditionFeature {
  /** Nothing nearer than this is touched. Metres. */
  readonly startDistance: number
  /** Metres from `startDistance` to full strength. */
  readonly range: number
  /** How far toward `tint` at full range. 0..1. */
  readonly strength: number
  /** How far toward the colour's own luminance at full range. 0..1. */
  readonly desaturate: number
  /** sRGB 0..1, like `fog.color` in a level. Linearised in `render/unity-fog.ts`. */
  readonly tint: readonly [number, number, number]
}

/**
 * The illustrative diffuse warp — a Half-Lambert ramp in place of
 * `saturate(N·L)`, so the cool/warm shift lives inside the shadow term.
 * ANNIVERSARY.md V7, DEV-092.
 *
 * The three stops are LINEAR rgb and that is not the haze's convention by
 * accident: the haze's `tint` is a COLOUR someone picked and gets linearised on
 * the way to the shader, while these are the multiplier the sun's own radiance
 * is scaled by — a light RESPONSE, like `fx.motes.colorLight` and the cabin
 * lamps. Nothing converts them.
 *
 * The stops' POSITIONS are not here, because they are derived rather than
 * chosen: Half-Lambert puts `N·L = 0` at exactly 0.5, so the middle stop is the
 * terminator and the two ends are the two poles. `render/illustrative.ts` says
 * so where the ramp is evaluated.
 */
export interface EditionIllustrative extends EditionFeature {
  /** LINEAR response at Half-Lambert 0 — a face turned fully away from the sun. */
  readonly shadow: readonly [number, number, number]
  /** LINEAR response at Half-Lambert 0.5, which is `N·L = 0`: the terminator. */
  readonly terminator: readonly [number, number, number]
  /** LINEAR response at Half-Lambert 1 — a face square to the sun. */
  readonly lit: readonly [number, number, number]
  /** Flat gain over the whole ramp: the TF2 paper's post-lookup `×N`. */
  readonly overbright: number
  /** 0..1 cross-fade from the stock Lambert response. 0 is the exact identity. */
  readonly strength: number
}

/**
 * One directional shadow map from the mission sun. ANNIVERSARY.md V3, DEV-086.
 *
 * Every number is in METRES except `mapSize` (texels) and `radius` (texels),
 * and `bias` deliberately so: three's `shadow.bias` is in NORMALISED depth and
 * therefore means a different distance every time the box moves, which is a
 * number nobody can argue about. `render/shadows.ts` converts.
 */
export interface EditionShadows extends EditionFeature {
  /** Shadow map edge, in texels. A power of two, 256..4096. */
  readonly mapSize: number
  /** Half the follow box, in METRES. 2016's `shadowDistance` was 384. */
  readonly boxHalfSize: number
  /** METRES up-sun of the box that casters are gathered from. */
  readonly castDistance: number
  /** METRES of depth bias, pulling the receiver toward the light. */
  readonly bias: number
  /** METRES of offset along the receiver's own normal before the lookup. */
  readonly normalBias: number
  /** PCF disk radius, in shadow texels. */
  readonly radius: number
  /**
   * METRES inside the box's edge over which the map hands its verdict to the
   * far-field terms, so the edge is a gradient and not a line. DEV-453.
   * Zero is 2016's hard edge; it must be less than `boxHalfSize`.
   */
  readonly edgeFade: number
}

/**
 * The cockpit's shadow on ITSELF — a second, NEAR map over the ship alone.
 * DEV-323, Matt: *"in first person, i'd expect the cockpit to cast shadows on
 * itself."*
 *
 * `render.shadows`' units: METRES except `mapSize` and `radius` (texels). The
 * box is NOT here: it is the cockpit shell's own bounding sphere, measured off
 * the mesh every frame, because a box that is a number can be wrong and a box
 * that is the geometry cannot. `render/cockpit-self-shadow.ts` has the rest.
 */
export interface EditionCockpitSelfShadow extends EditionFeature {
  /** Near-map edge, in texels. A power of two, 256..4096. */
  readonly mapSize: number
  /** METRES of depth bias toward the light, scaled up to 5x by the facet's slope. */
  readonly bias: number
  /** METRES of offset along the receiver's own normal before the lookup. */
  readonly normalBias: number
  /** Tap spacing of the 3x3 PCF grid, in near-map texels. */
  readonly radius: number
}

/**
 * The near cascade: a second sun shadow map whose box follows the eye. DEV-582,
 * `render/near-shadow.ts`, which has the mechanism. `render.shadows`' units:
 * METRES except `mapSize` and `radius` (texels). Off wherever the sun's map is
 * off (quality `low`, Classic), because the sun's lookup skips into it.
 */
export interface EditionNearShadow extends EditionFeature {
  /** Map edge, texels. A power of two, 256..4096. */
  readonly mapSize: number
  /** METRES: half the box on both lateral axes, round the camera. */
  readonly boxHalfSize: number
  /** METRES inside the faces over which the box hands back to the sun's map. Less than `boxHalfSize`. */
  readonly edgeFade: number
  /** METRES of depth bias toward the light. */
  readonly bias: number
  /** METRES of offset along the receiver's own normal before the lookup. */
  readonly normalBias: number
  /** PCF tap radius, in near-map texels. */
  readonly radius: number
}

/**
 * The far-field shadow term: for every ground texel, the height below which a
 * point is in terrain shadow, swept once per mission from the collision field
 * and the mission sun. Exact at every distance, on the sea and in the cockpit;
 * `render/shadows.ts`'s map takes the minimum with it inside its box. DEV-116.
 *
 * Not gated on the quality setting: one texture fetch per lit fragment.
 */
export interface EditionSunHeight extends EditionFeature {
  /**
   * METRES over which a fragment fades from shadow to lit: for the ground, the
   * first metres of swept DEPTH at its texel (so along flat ground under a sun
   * at elevation `e` a shadow's tip is soft over `softMetres / tan(e)`); for
   * everything else, the metres of height below the swept top. Floored at one
   * pixel in the shader, so 0 is an anti-aliased hard edge and not a shimmer
   * (DEV-116, re-derived in DEV-133 — the old centred fade left lit ground
   * half-lit with per-vertex noise, which is what a smaller number could not
   * have fixed).
   */
  readonly softMetres: number
}

/**
 * Baked contact darkening under the prop scatter — the forest floor is darker
 * than the open field. Wishlist #13, DEV-295.
 *
 * A **restoration**, not a new effect, and that is what decides its shape:
 * when it landed, `render.props.scatterShadows` was false on both presets
 * (DEV-224 — the scatter is 88–93 % of desert's and alpine's world pass), so a
 * tree cast nothing on the ground it stands on and nothing else darkened it.
 * Swept once per mission by `sim/props/canopy.ts` onto the land's own collision
 * grid, and carried in the spare channel of DEV-116's sun texture, so it costs
 * no second fetch.
 *
 * **DEV-304 made that premise conditional.** `props.scatterShadows` is true on
 * Anniversary in flat, so the bake's DIRECT half hands over to the shadow map
 * there and keeps it in a headset, where `vr.disable` turns the caster set off.
 * The INDIRECT half never hands over — a shadow map does not touch ambient or
 * hemisphere light. `render/shadows.ts`'s `canopyDirectWeight` is the whole of
 * that decision and `tests/unit/canopy-direct.test.ts` is the guard.
 */
export interface EditionCanopyShade extends EditionFeature {
  /** Canopy radius as a multiple of the prop's DRAWN half-width. */
  readonly radiusScale: number
  /**
   * The COVERAGE at which 63 % of the sky is gone. Lower is a darker forest.
   *
   * The number that makes this a RATIO — a lone palm on a beach against Matt's
   * thick forest — rather than a wash. `sim/props/canopy.ts` measures what a
   * canopy and a stand actually lay down; the ratio follows from that and from
   * this, and `strength` is the absolute darkness on top.
   */
  readonly saturation: number
  /** How dark the most occluded ground gets, 0..1. **0 is the current image.** */
  readonly strength: number
}

/**
 * The clouds' shadows on the ground, the sea, the props, the racers and the
 * cockpit. DEV-585, `render/cloud-shadow.ts`, which projects the LIVE cloud
 * placements along the mission sun once per mission and multiplies the sun by
 * the result inside far-shadow's term. Anniversary only, every tier, and in
 * the headset (Matt, 2026-10-03: *"We should have clouds and their shadows in
 * vr"*).
 */
export interface EditionCloudShadow extends EditionFeature {
  /** How much of the direct sun a cloud takes away, 0..1. **0 is no shadow.** */
  readonly strength: number
  /**
   * DEGREES. At or below this the term is off; it reaches full strength at
   * twice it. Keeps a sun on the horizon (`int_02_hoverJet`, 0.08 degrees)
   * from stretching every cloud across the map.
   */
  readonly minSunElevation: number
}

/**
 * The sea reflects the islands again: 2016's realtime mirror (`Water.mat`'s
 * `V_LP_REFLECTIVE_REALTIME`), restored on a MONITOR under the ultra tier only.
 * DEV-583, `render/sea-reflection.ts`. Needs BOTH this flag and
 * `ultraFor(settings, presenting)?.seaReflection`, and the second is null in a
 * headset, so a headset never renders it whatever this says. The 2016 numbers
 * (tint and strength, Fresnel, distortion) are the sheet's, not this block's.
 */
export interface EditionSeaReflection extends EditionFeature {
  /**
   * The mirror's size as a FRACTION of the drawing buffer, per axis: 0.5 is
   * half resolution, a quarter of the pixels. In (0, 1].
   */
  readonly resolutionScale: number
}

/**
 * The terrain shading the sky it hides, and lighting the shade it throws.
 * `render/sky-visibility.ts`, DEV-333, `docs/plan/SKY-VISIBILITY.md`. Both
 * terms act on the LAND's indirect light only; the sun is DEV-116's.
 */
export interface EditionSkyVisibility extends EditionFeature {
  /** How much the hidden sky darkens the probe, 0..1. **0 leaves it alone.** */
  readonly sky: number
  /** How much of the lit terrain's bounce comes back, 0..1+. **0 adds nothing.** */
  readonly bounce: number
}

/**
 * A far shore of paper-cut ridges where the sea met the sky in a line. Two
 * bands of flat one-colour cards round the eye, coloured from the mission's
 * own sky at the horizon and fogged by the mission fog; one draw call. 2016
 * had nothing here. `render/horizon-geo.ts`, DEV-119.
 */
export interface EditionHorizonGeo extends EditionFeature {
  /** METRES from the eye to the outer band. Under the 6 km far plane, past the island. */
  readonly radius: number
  /** METRES the tallest card stands above sea level (or a valley floor). 0 is a no-op. */
  readonly peakMetres: number
  /** Multiplier on the sky's horizon colour behind a card, 0..1. 1 is invisible. */
  readonly silhouette: number
}

/**
 * The shoreline: shallows and a foam line at the one place two known scales
 * touch. ANNIVERSARY.md §1.3 item 5 and V6, DEV-087.
 *
 * The depths are chosen as BAND WIDTHS rather than as depths — the width is the
 * bathymetry's, not ours, and on Simonet's measured 1:1 shore 50 m of water is a
 * mean 34.7 m of sea and 16 m is 8.5 m. `render/coast.ts` carries the
 * measurement; `content/editions/_schema.json` carries the table.
 */
export interface EditionCoast extends EditionFeature {
  /** Metres of water past which the sea is untouched. Must be > 0 — it is a divisor. */
  readonly shallowDepth: number
  /** 0..1, how far toward `shallowColor` at zero depth. */
  readonly shallowStrength: number
  /** sRGB 0..1, like `fog.color`. Linearised in `render/coast.ts`. */
  readonly shallowColor: readonly [number, number, number]
  /** Metres. Foam lives strictly inside `(0, this)`. Must be > 0. */
  readonly foamDepth: number
  /** 0..1, peak foam at the waterline. Start faint (§6's king-tide warning). */
  readonly foamStrength: number
  /** sRGB 0..1. An albedo, not a light. */
  readonly foamColor: readonly [number, number, number]
  /** 0..1, how much of the foam the per-fragment chop takes away. */
  readonly foamBreakup: number
}

/**
 * A wider lens with speed, on the FLAT build only. ANNIVERSARY.md S7, DEV-093.
 *
 * The one feature in this file with a place it is FORBIDDEN rather than merely
 * absent: research 05 §R7 says never write `camera.fov` while presenting, so
 * `render/flat-fov.ts` returns before it reads anything in session and restores
 * the base at both ends of one. It never reaches a headset, so — unlike S1, S2,
 * S3 and S6 — it is NOT scaled by the `speedFx` comfort slider; DEV-093 carries
 * that argument and the one line that would change it.
 */
export interface EditionFlatFov extends EditionFeature {
  /**
   * The resting lens in degrees of VERTICAL fov, or `null` for the renderer's
   * own (70, from `render/renderer.ts`).
   *
   * `null` in both presets today. ANNIVERSARY.md §1.5 item 8 argues 55-60° would
   * make the world feel larger on a monitor at some cost to the sense of speed —
   * one number, Matt's, and every A/B frame ever taken would move with it.
   */
  readonly base: number | null
  /** Airspeed m/s -> DEGREES ADDED to `base`. Not a multiplier, not an absolute. */
  readonly addBySpeed: Breakpoints
  /** SECONDS: the time constant while the lens opens. 63 % of the way in this long. */
  readonly attackSeconds: number
  /** SECONDS: the time constant while it closes. Slower than the attack. */
  readonly releaseSeconds: number
}

/**
 * A player-switchable third-person camera, in the manner of Unreal's
 * SpringArm. DEV-128. Anniversary-only: the Steam build had no such camera —
 * `adv_01_hoverJet_3rdPerson.unity` is in the project and not in the build
 * settings, and the shipped ship prefab's `Art/ThirdPerson` is inactive with
 * nothing to switch it.
 *
 * Every number is a knob `render/spring-arm.ts` reads live; the schema JSON
 * carries the argument for each. NEVER live in an XR session — `boot/app.ts`
 * refuses the toggle while presenting, and the row says why.
 */
export interface EditionThirdPerson extends EditionFeature {
  /** METRES, pivot to camera along the lagged arm, before the probe shortens it. */
  readonly armLength: number
  /** METRES the probe will not shorten below. */
  readonly minArmLength: number
  /** [x, y, z] METRES from the SHIP ORIGIN, ship frame as three sees it (−z forward). */
  readonly pivotOffset: readonly [number, number, number]
  /** DEGREES the arm is raised above the ship's lagged horizon. */
  readonly armPitchDeg: number
  /** DEGREES of camera pitch relative to the arm. Negative lifts the ship in frame. */
  readonly aimPitchDeg: number
  /** SECONDS: position lag time constant. */
  readonly positionLagSeconds: number
  /** SECONDS: rotation lag time constant. */
  readonly rotationLagSeconds: number
  /** METRES the lagged pivot may trail the true one. */
  readonly maxLagMetres: number
  /** 0..1 of the ship's pitch the arm inherits. */
  readonly pitchFollow: number
  /** 0..1 of the ship's bank the horizon tilts by. */
  readonly rollFollow: number
  /** METRES of clearance between the lens and the collision surface. */
  readonly probeRadius: number
  /** Airspeed m/s -> DEGREES added to the resting lens, × the speed-FX slider. */
  readonly fovAddBySpeed: Breakpoints
  /** [x, y, z] METRES from the camera, camera frame, for the re-parented readout. */
  readonly hudOffset: readonly [number, number, number]
  /** Scale on the readout while it rides the lens. */
  readonly hudScale: number
}

/**
 * Clouds that are clouds. ANNIVERSARY.md §1.3 item 4, §1.5 item 4, V5, DEV-090.
 *
 * Two halves in one block, because they are one feature: the LOOK (`wrap`,
 * `rimStrength`, `rimPower`, `sunTint`, `emissive`) is what a cloud does that a
 * rock cannot, and the PLACEMENT (`scaleMultiplier`, `altitudeLift`, the drift)
 * is *"larger, higher"* and a wind. §3.2 V5: *"Faithful placement stays in
 * Classic"*, which is what the identity values 1 and 0 are for.
 *
 * There is no COLOUR here, and that is the thing worth noticing: the sun's is
 * the mission's (`lighting.sun`, per-mission and not per-environment), the
 * cloud's own is `GL-Tex-01.mat`'s in `game/clouds.ts`. Nothing to pick.
 */
export interface EditionClouds extends EditionFeature {
  /** 0..1 half-Lambert wrap of the DIRECT diffuse. 0 is three's hard terminator. */
  readonly wrap: number
  /** Peak rim at the silhouette, in the same units as the wrap: 1 is about a fully lit face. */
  readonly rimStrength: number
  /** Fresnel exponent on `1 - N·V`. Higher is thinner. Never 0 — `x^0` is 1. */
  readonly rimPower: number
  /** 0..1: how far the added light takes the sun's colour rather than a neutral of the same luminance. */
  readonly sunTint: number
  /** `emissiveIntensity` on the cloud's own colour. 0.22 is what both presets shipped (DEV-028). */
  readonly emissive: number
  /** Multiplies 2016's scale on all three axes, so the authored flattening survives. 1 is 2016. */
  readonly scaleMultiplier: number
  /** METRES added to every cloud's y. 0 is 2016. */
  readonly altitudeLift: number
  /** METRES PER SECOND on the RENDER clock. 0 is 2016's still sky. */
  readonly driftSpeed: number
  /** Direction of travel, THREE space. Normalised in `render/cloud-look.ts`. */
  readonly driftDirection: readonly number[]
  /**
   * Cull the cloud's BACK faces. DEV-276.
   *
   * `false` is what the port has always drawn — `DoubleSide`, so a lobed blob
   * does not show holes between its knots at a grazing angle — and is Classic's
   * answer. `true` means a cloud you are **inside** draws nothing, because every
   * face between you and the world is then a back face.
   *
   * **Read even when `enabled` is false.** This is not part of V5's look; it is
   * which faces the mesh has, and Classic has a mesh.
   */
  readonly singleSided: boolean
  /**
   * The cloud whiteout, 0-1, and 0 is off. DEV-277.
   *
   * Matt: *"fade to white immediately when entering and softly fade out when
   * you exit."* Instant in, linear out over `whiteoutRelease`.
   *
   * This is what `singleSided` made room for. The opaque hull WAS doing this by
   * accident -- an enveloping white shell reads as dense fog -- and it could not
   * be tuned, could not have an onset, and showed its own facets through itself.
   * A level here does the same job on purpose.
   */
  readonly whiteout: number
  /** Seconds to fade the whiteout out on exit. Linear, and it reaches 0. */
  readonly whiteoutRelease: number
  /**
   * The variant pool's size: the TOTAL number of unique blobs the sky builds,
   * one `InstancedMesh` each. DEV-785, Matt 2026-10-07 ("Variant pool").
   *
   * `game/cloud-pool.ts` shares it out over the shapes by what the placements
   * ask for. A pool at least as big as the sky shares nothing: every placement
   * keeps the blob it always had. **Read when the sky is built, even when
   * `enabled` is false, and not pushed again on a preset flip**: a pool is
   * geometry, and both presets build the same one.
   */
  readonly poolSize: number
  /**
   * How far a placement that SHARES a pool member strays from the authored
   * colour, 0..1: its albedo is multiplied by `1 + tintSpread * t` for a
   * deterministic `t` in -1..1. 0 is no tint. An owner is never tinted. DEV-785.
   */
  readonly tintSpread: number
}

/**
 * Bloom, on the FLAT build only. ANNIVERSARY.md V2, DEV-091.
 *
 * Four numbers on an `EffectComposer` — `RenderPass` + `UnrealBloomPass` +
 * `OutputPass` — and none of them reaches a material, so a flip or a slider
 * costs no recompile. `render/bloom.ts` carries the 2016 archaeology, the
 * translation of 2016's `threshold: 0.63` into the composer's linear-HDR domain,
 * and the reason a post pass is never run under `renderer.xr`.
 */
export interface EditionBloom extends EditionFeature {
  /** Rec.709 luminance, LINEAR, above which a pixel glows. 2016's was 0.63. */
  readonly threshold: number
  /** `UnrealBloomPass.strength`. NOT 2016's `intensity` — the preset says why. */
  readonly strength: number
  /**
   * 0..1: how much of the glow lives in the WIDE mips.
   *
   * `lerpBloomFactor(f) = mix(f, 1.2 - f, radius)`, so 0 leaves the five weights
   * at [1, .8, .6, .4, .2] — the half-res mip dominating, a tight glow — and 1
   * inverts them to [.2, .4, .6, .8, 1], the 1/32-res mip dominating, a wide
   * halo. It is not a distance and it is not in pixels.
   */
  readonly radius: number
  /**
   * Multiplies the drawing-buffer size the bloom CHAIN is built at.
   *
   * `UnrealBloomPass.setSize` halves whatever it is handed before it makes the
   * first mip, so **1 is already the half-resolution bloom of §3.2** and 0.5
   * starts the chain at a quarter. The Quest lever, if the VR variant ever
   * happens; 0 < x <= 1.
   */
  readonly resolutionScale: number
  /** The headset's bloom: halos on the gate studs and the sun. DEV-336. */
  readonly vrHalo: EditionVrHalo
}

/**
 * Bloom in a headset, the cheap way: halo billboards, no post pass. DEV-336,
 * `render/vr-halo.ts`. Drawn only while presenting and only where `enabled`
 * is on, so the monitor keeps the real bloom and Classic gets neither.
 */
export interface EditionVrHalo {
  /** A stud halo's radius as a multiple of the stud's own mean scale. */
  readonly studRadius: number
  /** A stud halo's peak additive brightness, in the studs' glow colour. */
  readonly studIntensity: number
  /** The sun halo's radius as an angle at the eye, degrees. */
  readonly sunAngleDeg: number
  /** The sun halo's peak additive brightness, in the mission sun's colour. */
  readonly sunIntensity: number
}

export interface EditionRender {
  readonly toneMapping: ToneMappingId
  /** `renderer.toneMappingExposure`. 1 is unity. */
  readonly exposure: number
  /** Aerial perspective as its own term — not the mission fog. ANNIVERSARY.md V4. */
  readonly haze: EditionHaze
  /** The illustrative diffuse warp on the LAND terrains. ANNIVERSARY.md V7. */
  readonly illustrative: EditionIllustrative
  /** Real cast shadows from the mission sun. ANNIVERSARY.md V3. */
  readonly shadows: EditionShadows
  /** The ship's own hull casts while you are sitting in it. DEV-305. */
  readonly shipShadow: EditionFeature
  /** The cockpit shell RECEIVES the shadow map. DEV-306. */
  readonly cockpitShadow: EditionFeature
  /**
   * The cockpit shell shadows ITSELF, through a second map over the ship.
   * DEV-323. While on, the shell's lookup into the SUN's map skips the ship's
   * own occluders, which is what takes look call 6's blob away.
   */
  readonly cockpitSelfShadow: EditionCockpitSelfShadow
  /**
   * A second sun map over the ~100 m round the eye, which the sun map skips
   * into inside its box. DEV-582, `render/near-shadow.ts`.
   */
  readonly nearShadow: EditionNearShadow
  /**
   * Bake the sky dome smooth — per vertex, no cell variation — instead of
   * faceted. DEV-320, wishlist #22a, *"toggle the faceted sky"*.
   *
   * The flag names the DEVIATION, which is the smooth one: **Classic has every
   * flag off** (`edition-content.test.ts`), and the faceted dome is the
   * FAITHFUL answer — SkyJ is a low-poly sky pack and `sim/sky-dome.ts` opened
   * its six faces to say so. Anniversary ships it on (Matt, 2026-09-23:
   * *"faceted sky off by default"*). `render/sky.ts`'s `bake` has what changes.
   */
  readonly smoothSky: EditionFeature
  /** Terrain shadow at EVERY distance, swept once from the height field. DEV-116. */
  readonly sunHeight: EditionSunHeight
  /** The clouds' shadows on everything lit, projected along the sun. DEV-585. */
  readonly cloudShadow: EditionCloudShadow
  /** Baked darkening under the forest, swept once from the placements. DEV-295. */
  readonly canopyShade: EditionCanopyShade
  /** Terrain hiding the sky, and the lit terrain's bounce in its place. DEV-333. */
  readonly skyVisibility: EditionSkyVisibility
  /** A far shore of paper-cut ridges round the eye, fogged into the sky. DEV-119. */
  readonly horizonGeo: EditionHorizonGeo
  /** Shallows and a foam line at the waterline. ANNIVERSARY.md V6. */
  readonly coast: EditionCoast
  /** The islands in the sea, flat ultra only. DEV-583. */
  readonly seaReflection: EditionSeaReflection
  /** Dynamic field of view with airspeed. FLAT ONLY. ANNIVERSARY.md S7. */
  readonly flatFov: EditionFlatFov
  /** A soft terminator, a lit rim, drift, and the placements grown. ANNIVERSARY.md V5. */
  readonly clouds: EditionClouds
  /** Bloom, flat build only, from 2016's own numbers. ANNIVERSARY.md V2. */
  readonly bloom: EditionBloom
  /** A spring-arm third-person camera. FLAT ONLY. DEV-128. */
  readonly thirdPerson: EditionThirdPerson
  /** The AI racers solid, lit, and each in its own colour. DEV-350. */
  readonly racerLivery: EditionRacerLivery
  /** A colour filter over the world, per mission. DEV-446. */
  readonly sceneTint: EditionSceneTint
}

/**
 * One scene tint: a colour to lean the displayed world toward, and how far.
 * DEV-446, `render/scene-tint.ts`, which has the arithmetic.
 */
export interface SceneTintValue {
  /**
   * sRGB 0..1, as a colour picker gives it. Only its HUE and SATURATION matter:
   * the gain is this divided by its own Rec. 709 luma, so a neutral pixel keeps
   * its brightness and white is no tint at any strength.
   */
  readonly color: readonly [number, number, number]
  /** 0..1. 0 is no tint whatever the colour; 1 is the whole of it. */
  readonly strength: number
}

/**
 * A colour filter over the world, authored per MISSION. DEV-446.
 *
 * 2016 had no such thing on any camera (the row has the walk), so this is an
 * Anniversary tool: Classic has it off, and Anniversary ships it on with a
 * neutral `default` and no `missions`, so no pixel moves until one is authored
 * (`?lookdev=1`). NOT in `gameplay`: it moves no ship, so it restarts no board.
 */
export interface EditionSceneTint extends EditionFeature {
  /** Every level the block does not name. Neutral as shipped. */
  readonly default: SceneTintValue
  /** By level id — `content/levels/<id>.json`, or an authored course's id. */
  readonly missions: Readonly<Record<string, SceneTintValue>>
}

/**
 * The AI racers wear the player's own hull, opaque and lit like it, repainted
 * one colour per racer — 2016's `GhostRacer.prefab` look rather than its
 * playback ghost's. DEV-350; `render/racer-livery.ts` has the channel and the
 * evidence. Off, they wear the translucent hologram (`racerMaterial`).
 */
export interface EditionRacerLivery extends EditionFeature {
  /**
   * One colour per racer, in racer order, wrapping: the livery PANEL's colour,
   * sRGB 0..1, in the units 2016's FBX carries. Read at load.
   */
  readonly palette: readonly (readonly [number, number, number])[]
  /** The solid hulls cast into the sun's map. Inert while `enabled` is false. */
  readonly shadow: EditionFeature
}

/**
 * Re-author 2016's speed-line tube so it reads. ANNIVERSARY.md S2, DEV-079.
 *
 * Every number here reaches the particle SHADER and nothing else — the
 * emitters, rates, speeds, thresholds, lifetimes and the authored streak length
 * stay on the generated spec, because they are the shipped design and the
 * complaint was never that it was wrong, only that it was invisible.
 */
export interface EditionSpeedLines extends EditionFeature {
  /** Multiplies the rendered streak WIDTH. 1 is 2016's 5-8 cm hairline. */
  readonly widthScale: number
  /** Multiplies the particle alpha. 1 is 2016. */
  readonly alphaScale: number
  /** Soft-edged and laid OVER the sky rather than added to it. False is 2016. */
  readonly softEdge: boolean
  /** 0-1, the centre line's darkening. Needs `softEdge`. 0 is 2016. */
  readonly coreDarkness: number
  /**
   * METRES the three boost tubes are lifted toward the eye, in the ship frame.
   * 0 is 2016's placement, whose axis is 6.6 m below the eye — under the seat.
   * `game/particle-fx.ts`'s `speedLineLift` says why, with the measurement.
   */
  readonly tubeLift: number
}

/**
 * The speed lines RAMP instead of switching. DEV-351.
 *
 * 2016 plays exactly one of the three boost systems, cut at the prefab's
 * thresholds; this crossfades them by emission rate and ramps the first one in,
 * in count, alpha and spawn speed. Every speed the ramp turns on is 2016's own
 * (the cuts and `maxSpeed`, off the generated sheet) except `onsetSpeed`, and no
 * multiplier ever exceeds the sheet. `game/speed-line-ramp.ts` is the arithmetic.
 * Off at the comfort slider's 0, like S2; drawn whole above it.
 */
export interface EditionSpeedRamp extends EditionFeature {
  /**
   * Metres per second of forward speed at which the first stage starts to
   * emit. It reaches 2016's own numbers at the middle of stage 1's band.
   */
  readonly onsetSpeed: number
  /** 0-1. The alpha multiplier the first streaks are born at. */
  readonly alphaFloor: number
  /** 0-1. The spawn-speed (and so stretch) multiplier they are born at. */
  readonly speedFloor: number
}

/**
 * Wing-tip trails at speed, on the player's ship and on every AI racer.
 * DEV-358.
 *
 * Two thin ribbons per HoverJet, from the tips' trailing corners as measured
 * off the hull (`render/wing-trails.ts`). They fade in between the HoverJet's
 * unboosted and boosted terminal speeds, both off the sheet
 * (`game/wing-trail-fade.ts`), and ride the speed-FX comfort slider: 0 is off,
 * above it the slider multiplies `alpha`. No speed here is a preset number.
 */
export interface EditionWingTrails extends EditionFeature {
  /** Seconds a point of vapour lives. The ribbon is this long times the speed. */
  readonly seconds: number
  /** Metres across at the tip. */
  readonly startWidth: number
  /** Metres across at the tail: the vapour spreads as it thins. */
  readonly endWidth: number
  /** 0-1. Opacity at the tip, at whole strength and the slider's `full`. */
  readonly alpha: number
  /** Metres a tip travels before a point is committed to the ribbon. */
  readonly minVertexDistance: number
  /**
   * Metres from the eye inside which the ribbon fades out: nothing at the eye,
   * whole at this distance. 0 is no fade.
   */
  readonly nearFade: number
  /**
   * 0-1. How far each craft's trail is drawn from white toward its own livery's
   * hue at full brightness: a racer's palette colour, the player's orange. 0 is
   * white. No channel falls below `1 - tint`, and a colour with no hue (a
   * grey, as DEV-350's charcoal was) stays white. DEV-358 follow-up.
   */
  readonly tint: number
  /**
   * The centre line's brightness, linear, times the tint. Above the bloom's
   * threshold (1.0) is what makes it glow on a monitor.
   */
  readonly glow: number
  /** 0-1. The bright core's half-width as a fraction of the glow's. */
  readonly core: number
  /** 0-1. The brightness at the core's edge as a fraction of the centre's. */
  readonly halo: number
  /** Degrees. The widest the ribbon may subtend at the eye; 0 is no cap. */
  readonly maxWidthDeg: number
  /**
   * Whether the player's OWN trails show from the cockpit seat. False: third
   * person only. The racers' show from anywhere. `docs/DEVIATIONS.md` DEV-358
   * has the comfort argument, and its 2026-09-25 follow-up Matt's call that
   * turned it on for Anniversary.
   */
  readonly fromCockpit: boolean
}

/** The near-field air, scaled by the `speedFx` comfort setting. S1, DEV-080. */
export interface EditionMotes extends EditionFeature {
  /** Pool size at speed FX `full`; the comfort slider multiplies it. */
  readonly count: number
  /** Metres from the eye. Inside this is the cockpit, not the air. */
  readonly innerRadius: number
  /** Metres. Past this a mote respawns. */
  readonly outerRadius: number
  /** Metres across. */
  readonly size: number
  /** Seconds of travel drawn as length: `size + this * relative speed`. */
  readonly stretchSeconds: number
  /** Peak alpha at `fullSpeed`, before the comfort slider. */
  readonly alpha: number
  /** Below this speed (m/s) the field draws nothing. */
  readonly minSpeed: number
  /** The speed (m/s) at which alpha reaches `alpha`. */
  readonly fullSpeed: number
  /** 0-1: how much of the shell sits ahead of the velocity. */
  readonly aheadBias: number
  /** Linear RGB. Each mote takes a shade between this and `colorDark`. */
  readonly colorLight: readonly number[]
  /** Linear RGB, the dark end of the shade range. */
  readonly colorDark: readonly number[]
}

/**
 * The gate pass as an event: a peripheral streak pulse. S6, DEV-108.
 *
 * The ring burst and the whoosh are already there — `game/particle-fx.ts` fires
 * 2016's one-shot emitters and `audio/engine.ts` the S4 cue, from the same call
 * site as this. What was missing was the third channel, and R7 is the whole
 * constraint on its shape: *"chromatic/vignette pulses at the periphery only"*.
 *
 * `render/gate-pulse.ts` is the arithmetic and says what each number is OF.
 */
export interface EditionGatePulse extends EditionFeature {
  /**
   * Peak OVERLAY ALPHA at the outermost pixel, before the speed curve and the
   * comfort slider. Not a luminance and not a gain: the quad composites
   * source-over, so this is literally the fraction of the frame edge replaced
   * by `tint` on the frame the gate was crossed.
   */
  readonly strength: number
  /** Seconds the pulse lasts. Wall clock, never the fixed step. */
  readonly seconds: number
  /** Decay exponent. 1 is linear; above 1 spends most of the window already dim. */
  readonly decayShape: number
  /**
   * UV radius where the band begins — centre 0, edge midpoint 0.5, corner
   * 0.707. **Must be at or outside `R_CLOSED_STRONG`**, the aperture the
   * strongest comfort vignette is willing to black out, so the pulse can only
   * reach pixels the comfort layer already treats as peripheral. 0 would be a
   * flash over the whole frame, which is the other half of S6 and the half R7
   * refuses.
   */
  readonly innerRadius: number
  /** UV width of the band's soft inner edge. A hard rim is a second thing moving. */
  readonly feather: number
  /**
   * Wedges around the ring: a COUNT, not a frequency in hertz, and a WHOLE one.
   * The shader's angle comes from `atan`, whose branch cut runs along -x, and
   * the wedge function is continuous across it only for integer counts.
   */
  readonly streaks: number
  /** 0-1: how deep the wedges cut. 0 is a smooth band, 1 is gaps between streaks. */
  readonly streakDepth: number
  /**
   * 0-1 blend from the ring's OWN glow colour toward white.
   *
   * The colour itself is not here, because it is extracted rather than tuned:
   * `PROPS.checkpointRing.frameGlowColor` is 2016's colour for the glow of the
   * thing you just flew through, and DEV-069's lesson is to import the key the
   * sheet already has rather than to type a plausible number beside it.
   */
  readonly tint: number
  /**
   * Gain against **forward speed in m/s**. The same x, and deliberately the
   * same breakpoints, as `audio.speedCurves.gateWhooshGain`: one event, two
   * channels, one shape. A gate taken at 40 m/s is not the gate taken at 240.
   */
  readonly gainBySpeed: Breakpoints
}

/**
 * How much of the gate burst's AUTHORED CONE survives. DEV-272.
 *
 * Unity 5's ShapeModule carries `randomDirection` as a BOOL — the raw YAML on
 * `Checkpoint_Ring.prefab` says `randomDirection: 1`, with no
 * `randomDirectionAmount` field in the file at all — and the port read that as
 * *"replace the shape's direction with a uniform sample on the sphere"*.
 *
 * That reading may well be right about Unity; it cannot be settled from the
 * project, and it would need Unity itself. What it is definitely wrong about is
 * the picture. Two of the gate's three one-shot bursts are authored as tight
 * forward jets — **7.78 and 18.9 degrees** — and a sphere is roughly 1,100x the
 * solid angle of the first, so the same particle count arrives at about a
 * thousandth of the density in the direction the player is looking. Matt,
 * 2026-09-21, from the cockpit: *"i don't see them. maybe they're oriented the
 * wrong direction? it should be a spray in the direction of travel, but it's
 * not."*
 *
 * The third one-shot is a `circleEdge` with `randomDirection: false` — it
 * sprays radially outward in the plane of the ring BY DESIGN, and this flag
 * does not touch it. Part of what reads as sideways is 2016.
 */
export interface EditionRingBurst extends EditionFeature {
  /**
   * 0-1, how much of the direction is random. **1 is what the port has always
   * done, to the bit** — the uniform sphere replaces the cone, and the sampling
   * path is byte-identical, so Classic does not move. Below 1 the random
   * direction is blended TOWARD the authored cone rather than replacing it; 0
   * is the cone exactly as authored.
   *
   * THE NUMBER TO ARGUE WITH, and it has to be argued from the cockpit at
   * speed — a gate burst is a quarter of a second long and you are leaving.
   */
  readonly randomDirection: number
}

export interface EditionFx {
  readonly speedLines: EditionSpeedLines
  /** The boost stages crossfade and ramp in rather than cut. DEV-351. */
  readonly speedRamp: EditionSpeedRamp
  /** Wing-tip trails at speed, player and racers. DEV-358. */
  readonly wingTrails: EditionWingTrails
  readonly motes: EditionMotes
  readonly gatePulse: EditionGatePulse
  /** How much of the gate burst's authored cone survives. DEV-272. */
  readonly ringBurst: EditionRingBurst
  /** Spray off the sea under a ship skimming it. DEV-429. */
  readonly waterSpray: EditionWaterSpray
  /** The burst a struck plant throws in its own colours. DEV-428. */
  readonly propBurst: EditionPropBurst
  /** A splash where anything goes into the sea or comes out of it. DEV-613. */
  readonly splash: EditionSplash
}

/**
 * DEV-429 — **the sea throws spray at a ship skimming it.** Matt, 2026-09-26:
 * *"plz continue the polish elements like water over the hull when going over
 * water"* — NEXT.md P3 #2, water first.
 *
 * Authored, like DEV-428's burst: `game/particle-fx.ts`'s `waterSpraySpec`
 * builds the spec, and `sprayStrength` decides how much of `rate` runs this
 * frame — nothing unless the surface under the ship is SEA (the ocean's field
 * above the island's), the ship is within `heightMetres` of the water you can
 * see, and it is moving. On the speed-FX comfort slider: spray streaming past
 * the hull is optic flow, and ART_DIRECTION says vection answers to the
 * slider. HoverJet only — the JumpSeat already has 2016's own `ground_fx`.
 *
 * Paper, not light, because water does not glow.
 */
export interface EditionWaterSpray extends EditionFeature {
  /**
   * Metres from the ship to the visible sea at and above which there is no
   * spray. THE NUMBER TO ARGUE WITH: it decides how low "skimming" is.
   */
  readonly heightMetres: number
  /** m/s. Below this, none. */
  readonly minSpeed: number
  /** m/s. The full rate from here up. Above `minSpeed`. */
  readonly fullSpeed: number
  /** Particles per second, at the water and at `fullSpeed`. */
  readonly rate: number
  /** 0-1: how much of the SHIP's velocity the spray is thrown with. */
  readonly carry: number
  /** m/s up off the water. */
  readonly lift: number
  /** Degrees either side of straight up. */
  readonly angleDeg: number
  /** Metres. The disc under the hull it is thrown from. */
  readonly radius: number
  /** Seconds a droplet lives, at most (each draws 60-100 % of it). */
  readonly lifetime: number
  /** Metres. A droplet's size, at most. */
  readonly size: number
  /** × the world's 32 m/s². */
  readonly gravity: number
  /** Per second: how fast the air slows a droplet. */
  readonly drag: number
  /**
   * sRGB, the way the preset's other colours are picked. Anniversary's is the
   * coast's own `foamColor`, typed again rather than read: Classic's coast
   * zeroes its foam, and a spray that borrowed it would be black the day
   * somebody pins the spray on over Classic.
   */
  readonly colour: readonly [number, number, number]
  /** × the colour: an unlit droplet against the lit sea. */
  readonly shade: number
}

/**
 * One of a splash's two parts: a burst of `count` paper triangles off a disc of
 * `radius`, up at `lift` m/s within `angleDeg` of vertical, each living up to
 * `lifetime` s at up to `size` m (every draw is 60-100 % of the number). All of
 * it at a splash of scale 1; `game/particle-fx.ts`'s `splashScale` says how big
 * each splash is, and the engine scales the part by gravity's similarity.
 */
export interface EditionSplashPart {
  readonly count: number
  readonly lift: number
  readonly angleDeg: number
  readonly radius: number
  readonly lifetime: number
  readonly size: number
  /** sRGB, the way the preset's colours are picked. */
  readonly colour: readonly [number, number, number]
}

/**
 * DEV-613: **a splash where anything goes into the sea or comes out of it.**
 * Matt, 2026-10-03: *"can you spawn a "splash" particle fx when anything goes
 * in or out of the water? i'm thinking i'd see it the most w/ dolphins land in
 * the water, and if jets crash into the water"*.
 *
 * Two parts, two fields, one paper program (the spray's): a CROWN, a ring of
 * spray thrown up and out from the rim of a disc, and DROPS, a narrower,
 * faster cone from its middle. A splash's size is `splashScale`: `body` (the
 * crosser's own, below) times the square root of its speed over `refSpeed`,
 * within `minScale`..`maxScale`, and a splash k times the size is k times
 * every length (its height included) and sqrt(k) the time. A fixed pool of
 * `emitters`, so a pod leaping at once recycles its oldest splash rather than
 * adding to the frame. Not on the speed-FX slider: a splash is an event, like
 * the gate's burst, not optic flow. 2016 threw none.
 */
export interface EditionSplash extends EditionFeature {
  /** How many splashes can be in the air at once; past it, the oldest gives way. */
  readonly emitters: number
  /** Metres from the eye past which a splash is not thrown. */
  readonly maxMetres: number
  /** m/s at which a crosser of body 1 throws a splash of scale 1. */
  readonly refSpeed: number
  readonly minScale: number
  /** THE NUMBER TO ARGUE WITH for a crash: the biggest a splash gets. */
  readonly maxScale: number
  /** A HoverJet's body, against a dolphin's 1 (times the animal's own scale). */
  readonly jetBody: number
  readonly dolphinBody: number
  /** × the scale of a splash coming OUT of the water against one going in. */
  readonly outScale: number
  /**
   * Metres a jet that went in must rise over the visible sea before it counts
   * as out again: a skim touches and leaves the water every few ticks, and
   * this is the band that keeps it one splash.
   */
  readonly exitMetres: number
  /** Seconds between two splashes by one jet, at least. */
  readonly minSeconds: number
  /** 0-1: how much of the crosser's velocity the splash carries. */
  readonly carry: number
  /** × the world's 32 m/s², both parts. */
  readonly gravity: number
  /** Per second: how fast the air slows a piece, both parts. */
  readonly drag: number
  /** × both parts' colour: unlit pieces against the lit sea. */
  readonly shade: number
  readonly crown: EditionSplashPart
  readonly drops: EditionSplashPart
}

/**
 * How a PASSED gate goes away. DEV-122.
 *
 * 2016 hides a gate two seconds after the player flies through it, in one
 * frame (`TriggerCheckpoint.Deactivate()`); that timing is on the sheet as
 * `props.checkpointRing.passedHideDelay` and is what Classic runs. This flag
 * swaps the pop for a short shrink about the gate's centre. `game/gate-
 * visibility.ts` is the arithmetic.
 */
export interface EditionPassedFade extends EditionFeature {
  /** Seconds after the ANCHOR before the shrink starts. SIM seconds. */
  readonly delaySeconds: number
  /** Seconds the shrink takes. 0 would be a pop, which is what the flag exists to replace. */
  readonly seconds: number
  /**
   * Start the clock when the ship LEAVES the gate's trigger sphere rather than
   * when it enters it. DEV-195.
   *
   * 2016 counts from `OnTriggerEnter`, and on a 22.619 m trigger sphere that
   * fires a measured median of 21.5 m BEFORE the gate's own plane — so a short
   * shrink anchored there happens entirely while the ship is still flying
   * through the hole. Capped at `game/gate-visibility.ts`'s
   * `EXIT_BACKSTOP_SECONDS`, which is 2016's own hold, so a gate can never fail
   * to go away.
   */
  readonly waitForExit: boolean
}

/**
 * A chequered, crenellated band along the top of the FINISH gate. DEV-123.
 *
 * 2016 tells the finish from a ring by colour and size — the same frame,
 * orange, three times bigger — and a black cut-out of that is a nearer ring
 * (ART_DIRECTION pillar 1). This adds a SILHOUETTE: a row of separated cells,
 * alternating light and dark, sitting on the frame's top edge. A chequered
 * flag is the one finish sign nobody has to be taught, and cells with gaps
 * between them notch the outline where a solid band would not.
 */
export interface EditionFinishBanner extends EditionFeature {
  /** Cells across the band. WHOLE, 2 or more. */
  readonly columns: number
  /** Cells up the band. WHOLE, 1 or more. */
  readonly rows: number
  /**
   * METRES per cell, in the world. Absolute rather than a fraction of the
   * frame, because what the eye reads at 500 m is a size, not a ratio.
   */
  readonly cellMetres: number
  /** 0-1: fraction of each cell's pitch left EMPTY, so the outline is notched. */
  readonly gap: number
  /** METRES between the frame's top edge and the band's bottom row. */
  readonly lift: number
  /** Linear RGB of the light cells. */
  readonly light: readonly number[]
  /** Linear RGB of the dark cells. */
  readonly dark: readonly number[]
  /** Emissive intensity on the LIGHT cells only. Gate frames already glow (ART_DIRECTION). */
  readonly emissive: number
}

export interface EditionGates {
  readonly passedFade: EditionPassedFade
  readonly finishBanner: EditionFinishBanner
}

/**
 * A paper-cut arrow on the glareshield pointing at the next gate. DEV-124.
 *
 * Matt: *"i could use a 'next gate' indicator arrow towards the front of the
 * cockpit to help me understand where to fly."* Mounted on the SHIP, like the
 * HUD — not the head — so it is a fixed instrument a moving head can look at
 * (`render/hud.ts` says why head-locked is the wrong choice). It points along
 * the bearing to the target in the ship's own frame and hides while the target
 * is inside the forward cone, so it says something only when there is
 * something to say. `render/next-gate-arrow.ts` builds it; `game/next-target.ts`
 * decides what it points at.
 */
export interface EditionNextGateArrow extends EditionFeature {
  /** DEGREES off the nose inside which the arrow hides. Above 0, below 90. */
  readonly coneDegrees: number
  /** DEGREES beyond the cone over which it grows from nothing to full size. */
  readonly featherDegrees: number
  /** METRES, base to tip. */
  readonly lengthMetres: number
  /**
   * METRES from the EYE, in the ship's frame — three space, so forward is -z.
   * Where on the dash it sits. It does not move the rig or the cockpit mesh.
   */
  readonly offset: readonly number[]
  /** Linear RGB. */
  readonly color: readonly number[]
  /** Emissive intensity. An instrument lamp, like the dash (DEV-088). */
  readonly emissive: number
}

/**
 * The race map and the live place, on a plate beside the readout. DEV-361.
 * `render/race-map.ts` builds it; `game/race-place.ts` orders the field. Its
 * height is the panel's, so only its width is here.
 */
export interface EditionRaceMap extends EditionFeature {
  /** METRES across the plate. The number to argue with. */
  readonly widthMetres: number
  /** METRES from the panel's right edge to the plate's left edge. */
  readonly gapMetres: number
  /** METRES corner to corner of a racer's hexagon. */
  readonly dotMetres: number
  /** METRES corner to corner of the hexagon whose AREA the player's triangle has (DEV-432), before its ring. */
  readonly playerDotMetres: number
}

/**
 * The buffet. `game/cockpit-shake.ts` is the signal; these are all of its dials.
 *
 * Every one of them is here rather than in `src/` because a tuning number typed
 * into a render module is indistinguishable from an extracted one in six months
 * (§0.2, DEV-008). The one set of numbers the shake does NOT carry is the boost
 * thresholds, which are 2016's and come off the constants sheet.
 */
export interface EditionCockpitShake extends EditionFeature {
  /** Metres per second. Below this there is no buffet, and no slope either. */
  readonly startSpeed: number
  /** Metres per second at which the speed ramp saturates. Must exceed `startSpeed`. */
  readonly fullSpeed: number
  /** METRES. Peak translation of the pivot at ramp 1, stage gain 1, slider full. */
  readonly amplitude: number
  /** RADIANS. Peak roll and pitch of the pivot, same conditions. */
  readonly angle: number
  /** Multiplier per boost stage, indexed 0..3 by `game/cockpit-shake.ts`. */
  readonly stageGain: readonly number[]
  /** HERTZ. The sines summed per channel; mutually incommensurate, and well under half the display rate. */
  readonly frequency: readonly number[]
  /**
   * DEV-426: the buffet's weight by what the ENGINE is doing, Matt's three
   * numbers. Optional: absent is 1 everywhere, the buffet before DEV-426, and
   * Classic carries none (its shake is off). `game/cockpit-shake.ts`'s
   * `throttleShakeGain` is the curve.
   */
  readonly throttle?: EditionShakeThrottle
}

/**
 * DEV-426. AMPLITUDE multipliers on the buffet (Matt: *"multiplier is
 * amplitude, not speed"*), blended by the spooled thrust and the live chain's
 * terminals — `game/cockpit-shake.ts` says how.
 */
export interface EditionShakeThrottle {
  /** At full throttle, unboosted, and below it. */
  readonly fullThrottle: number
  /** The instant a boost spools up from the unboosted terminal. */
  readonly boost: number
  /** Boosting, at the live chain's boosted terminal ("top speed"). */
  readonly topSpeed: number
}

/**
 * One point light in the cabin. ANNIVERSARY.md V8, DEV-088.
 *
 * `offset` is METRES from the EYE, in the ship's frame as three sees it — so
 * −z is forward and +y is up, the same convention `game/flight.ts`'s `EYE` and
 * `ART_POSITION` are written in. Anchoring to the eye rather than to the ship
 * origin is deliberate: these are placements inside a cabin around a head, and
 * the head is the thing they are relative to.
 *
 * `color` is LINEAR rgb, like `fx.motes.colorLight` — a light's colour is
 * radiance, not a swatch somebody picked in an sRGB picker.
 */
export interface EditionCockpitLight {
  readonly color: readonly number[]
  /** three `PointLight.intensity` — candela, with `decay: 2`. */
  readonly intensity: number
  /** Metres. Past this the light contributes nothing. */
  readonly distance: number
  /** 2 is the physically correct inverse square. */
  readonly decay: number
  /** Metres from the EYE: [x, y, z], three space (−z forward). */
  readonly offset: readonly [number, number, number]
}

/**
 * The cabin lighting pass. V8, DEV-088.
 *
 * Two point lights and an emissive floor, and the row says why it is not a
 * layer: three has no per-object light mask, so a light restricted to a layer
 * is OFF rather than scoped (DEV-043). Each light is one `NUM_POINT_LIGHTS`
 * recompile of every lit material, once, at boot and on a flip.
 */
export interface EditionCockpitLighting extends EditionFeature {
  /** High and behind the eye: it rakes the canopy frame from inside. */
  readonly fill: EditionCockpitLight
  /** Low and forward, under the readout. The dashboard glow. */
  readonly dash: EditionCockpitLight
  /**
   * A floor under the cockpit material so the deepest faces never reach true
   * black. LINEAR rgb times a scalar; zero is "do not touch the material".
   * It is uniform over the mesh, so it FLATTENS — keep it far below what the
   * lights do, or it undoes them.
   */
  readonly emissive: { readonly color: readonly number[]; readonly intensity: number }
}

/** The four colours the stand-in pilot and seat are painted with. Linear rgb. */
export interface EditionCockpitBodyPalette {
  readonly seat: readonly number[]
  readonly trim: readonly number[]
  readonly suit: readonly number[]
  readonly glove: readonly number[]
}

/**
 * A body in the seat. V8, DEV-088.
 *
 * 2016 rendered `pilot_scifi_rigged` and `MM_Commander_Chair_01`; neither can
 * ship (CLAUDE.md rule 7), so `render/cockpit-body.ts` builds a first-party
 * stand-in from the measured seat offsets. Optional because a body that is
 * wrong is worse than none, and `hands` is a second escape hatch on the part
 * that goes wrong first.
 */
export interface EditionCockpitBody extends EditionFeature {
  /** Draw the arms, the hands and the two controls they hold. */
  readonly hands: boolean
  /** Metres of trim on the whole assembly, from the measured anchor. */
  readonly offset: readonly [number, number, number]
  readonly palette: EditionCockpitBodyPalette
}

/**
 * Where the cockpit readout sits, from the EYE of whichever vehicle is flying.
 * DEV-129. Not a feature: there is no off, both presets carry the same numbers,
 * and it exists so the lookdev Placement folder edits a value the build reads.
 */
export interface EditionHudPlacement {
  /** [x, y, z] METRES from the eye, ship frame as three sees it (−z forward). */
  readonly offset: readonly [number, number, number]
  /** RADIANS about the ship's x axis. Negative tips the top away from the eye. */
  readonly tilt: number
  /**
   * Uniform scale on the panel: the 0.4 × 0.145 m plate on the lens, or 2016's
   * own two screens in the HoverJet's dash (DEV-362).
   */
  readonly scale: number
}

export interface EditionCockpitPlacement {
  /**
   * The HoverJet's readout — since DEV-362, 2016's upper screen, set into the
   * dash's recess (`render/hud-dash.ts`'s `DASH_POSE_2016`).
   */
  readonly hud: EditionHudPlacement
  /**
   * The JumpSeat's readout (DEV-362). It shared `hud` until the HoverJet's
   * moved into its dash; 2016's JumpSeat gauge was NOT recessed, it stood free
   * in front of the shell, so it keeps the pose it had.
   */
  readonly jumpSeatHud: EditionHudPlacement
}

/**
 * Which placement block a vehicle's readout reads. DEV-362. ONE function, so
 * `boot/app.ts`, the lookdev folder and the test that holds the JumpSeat still
 * cannot pick differently.
 */
export const hudPlacementFor = (
  placement: EditionCockpitPlacement,
  // DEV-399: the glider flies in the HoverJet's cockpit until it has its own
  // (G3), so it reads the HoverJet's dash placement.
  vehicle: 'hoverjet' | 'jumpseat' | 'glider',
): EditionHudPlacement => (vehicle === 'jumpseat' ? placement.jumpSeatHud : placement.hud)

/** The JSON key `hudPlacementFor` reads for `vehicle` — what the lookdev folder pastes back under. */
export const hudPlacementKey = (
  vehicle: 'hoverjet' | 'jumpseat' | 'glider',
): 'hud' | 'jumpSeatHud' => (vehicle === 'jumpseat' ? 'jumpSeatHud' : 'hud')

export interface EditionCockpit {
  /** Cockpit-mesh shake around a still rig. S3. */
  readonly shake: EditionCockpitShake
  /** A dim fill, a dash glow and an emissive floor in the cabin. V8. */
  readonly lighting: EditionCockpitLighting
  /** The pilot and the seat, built rather than bought. V8. */
  readonly body: EditionCockpitBody
  /** Where the readout sits. DEV-129. Presentation, not a feature. */
  readonly placement: EditionCockpitPlacement
}

export interface EditionHud {
  /** The unit on the speed row. S8. */
  readonly speedUnit: SpeedUnitId
  /** The next-gate arrow on the glareshield. DEV-124. */
  readonly nextGateArrow: EditionNextGateArrow
  /** The race map and your place, beside the readout. DEV-361. */
  readonly raceMap: EditionRaceMap
  /**
   * The panel's two bars (DEV-791, Matt 2026-10-07 "go with your recs",
   * QUESTIONS item 7): the gate combo's countdown under GATES and the boost
   * tank under TIME (DEV-615). 2016's `panel_shipUI` drew no bars, so Classic
   * draws none; Anniversary draws both. The JumpSeat's fuel gauge is 2016's own
   * instrument and stays on both looks.
   */
  readonly bars: EditionFeature
}

/**
 * One point on a tuning curve: `[x, y]`.
 *
 * What x IS depends on the curve and is named on every field below, because
 * DEV-027's lesson is that a number nobody says the units of gets quoted in a
 * comment and built on. Here: airspeed in m/s for the wind and the whoosh, the
 * 0..1 throttle demand for the engine.
 */
export type Breakpoint = readonly [number, number]

/**
 * A curve, as points in ascending x. At least two, linear between them and FLAT
 * outside — `src/audio/speed-curves.ts` is the evaluator and says why.
 */
export type Breakpoints = readonly Breakpoint[]

/**
 * S4, and every number it is tuned by.
 *
 * 2016 had none of this: the loops gate on and off at one pitch and one gain
 * from 25 m/s to 340 (`src/audio/engine.ts`'s header traces every gate to a
 * line). Classic keeps the edges; Anniversary puts these curves where they were.
 * DEV-084.
 */
export interface EditionSpeedCurves extends EditionFeature {
  /** Airspeed m/s -> gain 0..1 on `AircraftWind`, the low roar. */
  readonly aircraftWindGain: Breakpoints
  /** Airspeed m/s -> gain 0..1 on `FlightWind`, the bright rush above 120. */
  readonly flightWindGain: Breakpoints
  /** Airspeed m/s -> low-pass cutoff in Hz, on BOTH wind loops. */
  readonly windCutoffHz: Breakpoints
  /** Throttle 0..1 -> playback rate on the thruster loop. 1 is as authored. */
  readonly thrustRate: Breakpoints
  /** Throttle 0..1 -> playback rate on the afterburner loop. */
  readonly afterburnerRate: Breakpoints
  /** Rate multiplier applied to the THRUSTER while the burner is lit. 1 is no step. */
  readonly afterburnerStep: number
  /** Airspeed m/s at the pass -> gain multiplier 0..1 on the gate whoosh. */
  readonly gateWhooshGain: Breakpoints
  /** Airspeed m/s at the pass -> pitch multiplier on the gate whoosh. */
  readonly gateWhooshPitch: Breakpoints
  /**
   * Airspeed m/s -> playback-rate multiplier on BOTH wind loops. 1 is as
   * authored. A noise layer's pitch is its filter band, so this moves every band
   * (and the flight wind's one tone) up with the air. DEV-425.
   */
  readonly windRate: Breakpoints
}

/**
 * A deep rumble under the 2016 engine loops. DEV-137.
 *
 * The 2016 loops are untouched and still on top; this is `engine.rumble` — the
 * Thrusters loop's own tonal layers an octave down plus a sub sine — low-passed
 * and mixed under them, and `engine.growl` beside it while the burner is lit.
 * Every number is a multiplier or a cutoff on those two voices; the voices
 * themselves are `src/audio/cues.ts`.
 */
export interface EditionEngineRumble extends EditionFeature {
  /** Throttle 0..1 -> gain multiplier on the rumble voice. Non-zero at idle. */
  readonly gainByThrottle: Breakpoints
  /** Low-pass cutoff in Hz on the rumble while the burner is out. */
  readonly cutoffHz: number
  /** Multiplies the rumble gain while the afterburner is lit. 1 is no change. */
  readonly boostGain: number
  /** The rumble's low-pass cutoff while the afterburner is lit. */
  readonly boostCutoffHz: number
  /** Gain multiplier on the growl voice, which runs only under the burner. 0 is none. */
  readonly growlGain: number
}

/**
 * Engine pitch that tracks FORWARD SPEED. DEV-137.
 *
 * S4's `thrustRate` is keyed on the throttle and this on airspeed, and the two
 * multiply: the stick answers fast, the air answers slow. It reaches every
 * engine voice — idle, thrusters, afterburner, rumble, growl — and the AI
 * racers' engines, so a racer heard passing changes pitch for its speed as well
 * as for its Doppler.
 */
export interface EditionEnginePitchTracking extends EditionFeature {
  /** Forward speed m/s -> playback-rate multiplier on every engine voice. 1 is as authored. */
  readonly rateBySpeed: Breakpoints
  /** The most the tracked rate may move per second, so a stall glides rather than chirps. */
  readonly slewPerSecond: number
}

/** The engine's own voice, beyond S4. Two flags, because they are two sounds. DEV-137. */
export interface EditionEngineSound {
  readonly rumble: EditionEngineRumble
  readonly pitchTracking: EditionEnginePitchTracking
}

/**
 * The lift's motor, and the clunk when it arrives. DEV-424.
 *
 * 2016's 15.5 s ride is a servo at the press, a loop that ships MUTED, and eight
 * positional whooshes up the shaft (`docs/audio-event-map.md` §1.2, §4.1; AUD-1
 * plays the loop on both editions). None of it follows the platform. This is a
 * motor voice whose pitch and level follow the platform's own speed — derived
 * from the ride curve tick to tick, so it spins up, cruises and spins down with
 * whatever curve the level carries — and a one-shot when the platform comes to
 * rest. Both FF2's, synthesized (`src/audio/cues.ts`), and the numbers here are
 * multipliers on those two voices.
 */
export interface EditionLiftSound extends EditionFeature {
  /** Platform speed m/s -> playback-rate multiplier on `elevator.motor`. 1 is as authored. */
  readonly rateBySpeed: Breakpoints
  /** Platform speed m/s -> gain multiplier 0..1 on `elevator.motor`. 0 at rest. */
  readonly gainBySpeed: Breakpoints
  /**
   * Platform speed m/s below which the lift counts as STOPPED. The motor starts
   * when the platform first rises above it, and stops — with the arrival clunk —
   * when it falls back under it.
   */
  readonly stoppedBelow: number
  /** Gain multiplier on `elevator.arrive`, the clunk at the top. 0 is none. */
  readonly arriveGain: number
}

export interface EditionAudio {
  /** Wind and engine that move with airspeed; a whoosh per gate. S4, DEV-084. */
  readonly speedCurves: EditionSpeedCurves
  /** A sub-octave rumble and a speed-tracking pitch on the engine loops. DEV-137. */
  readonly engine: EditionEngineSound
  /** The lift's motor, following the platform, and its arrival. DEV-424. */
  readonly lift: EditionLiftSound
}

/**
 * The detail ring: the nearest chunks generated at a finer facet. T1, DEV-085.
 *
 * The ONE exception to "nothing under `src/sim/`" at the top of this file, and
 * it is an exception in name only: `sim/terrain/detail.ts` is a pure function of
 * these four numbers, the geometry it produces is never seen by the golden
 * trajectories, the ghost replays or the oracle sweep, and **the collision
 * height field is not touched at all** (DEV-041 — it samples the original grid
 * and never the LOD being drawn). What a preset moves here is what the eye gets,
 * exactly like every other row.
 */
export interface EditionDetailRing extends EditionFeature {
  /** Metres per quad inside the ring. Must be finer than the terrain's own. */
  readonly baseResolution: number
  /** Ring radius in metres — HORIZONTAL, to the chunk footprint, like every LOD band. */
  readonly radius: number
  /** Multiplies the terrain's own `randomOffset` on the finer grid. */
  readonly jitterScale: number
  /** Detail chunks that may be awaiting a worker reply at once. */
  readonly maxInFlight: number
  /**
   * METRES of reconstruction between the height map's 8-bit levels, on the
   * ring's grid only. Zero samples the base map exactly. DEV-131,
   * `sim/terrain/dequantise.ts`.
   */
  readonly smoothMetres: number
}

/**
 * The LOD cross-fade 2016 authored and never got (its alpha material was the
 * opaque one). Screen-door, both meshes drawn for the transition. DEV-130,
 * `render/lod-fade.ts`.
 */
export interface EditionLodFade extends EditionFeature {
  /** Multiplies the sheet's `lodTransitionTime` for the terrain. 1 is 2016's own number. */
  readonly durationScale: number
}

/** One surface class: a roughness and the colour-map swatches that mean it. */
export interface EditionSurfaceClass {
  readonly id: string
  /** GGX roughness 0..1 for every facet nearest one of these swatches. */
  readonly roughness: number
  /** Colour map bytes 0..1, sRGB as stored, untinted — what `vColor` carries. */
  readonly swatches: readonly (readonly number[])[]
}

/**
 * Per-facet roughness from the facet's own colour. DEV-132,
 * `render/terrain-surface.ts`. Classic: one roughness for the whole island,
 * transcribed from `_Shininess`.
 */
export interface EditionSurfaceGloss extends EditionFeature {
  readonly classes: readonly EditionSurfaceClass[]
}

/**
 * How much of the land's shading the bake replaces. DEV-232 built the ladder in
 * prose (`docs/plan/DEV-232-BAKED-LIGHT.md` §4) and shipped only its bottom
 * step; DEV-237 makes the step a number the preset carries.
 *
 * **3** — everything. `outgoingLight = diffuseColor.rgb`. The physical chain,
 * both PMREM fetches, the GGX lobe, the five-tap PCF and `ff2SunHeightTerm`
 * are all behind a dead `totalDiffuse` and the compiler removes them. This is
 * the rung DEV-232 measured at **−0.80 ms p50** on `adv_02_jumpSeat`, and it
 * is the rung that costs the ground its shadows — the ship, the racers and the
 * landmarks stop casting onto it, which `ANNIVERSARY.md` §1.5 ranks second of
 * the eight scale cues.
 *
 * **1** — everything except the shadow multiply. `outgoingLight =
 * diffuseColor.rgb * ff2ShadowOnly()`, which keeps `getShadow` and
 * `ff2SunHeightTerm` per fragment and drops the view-dependent half with the
 * rest. The ground still takes the moving world's shadows. Buys less — and
 * **it is darker than the shipped build by more than the shadows themselves**:
 * three multiplies a shadow into `directLight.color` only, so a shadowed
 * hillside still gets the light probe's irradiance, while a bake that has
 * collapsed direct and indirect into one colour has nothing left to shadow
 * half of. Photographed at 33.9 mean levels of 255 below the shipped build on
 * `adv_02_jumpSeat`'s `island-lit` stand, against 2.07 for rung 3. DEV-237 has
 * the pictures and the correction.
 *
 * **`'split'`** — DEV-240, and it is the correction DEV-237 costed and did not
 * build. The bake stops collapsing the two halves: the ambient goes into the
 * `color` attribute and the direct into a second `vec3` attribute, and the
 * shader writes `ambient + direct * ff2ShadowOnly()`. That is three's own
 * semantics for the diffuse, term for term, so the shadow darkens exactly what
 * three darkens and the ambient is left alone — rung 1's 33.9 levels without
 * giving up the ground's shadows. It costs **12 bytes a vertex** and one more
 * varying.
 *
 * **There is no rung 2** on purpose. The plan's rung 2 is rung 1 with
 * `ff2SunHeightTerm` baked as well, and `render/far-shadow.ts`'s own header
 * says why that is a separate argument rather than a knob: the field is SIGNED
 * "so the bilinear zero crossing — the shadow's edge on the ground — falls
 * inside a texel rather than along the 8 m grid", and a per-vertex bake puts
 * that edge back on the 8 m grid. Under a 4-degree sun that terminator is most
 * of the island. It is not built, so it is not offered.
 *
 * **`'split'` is a NAME and not a number**, deliberately: the plan's ladder is
 * numbered and its rung 2 means something else, so a fourth step that took the
 * next free integer would read as a position on that ladder it does not hold.
 * A reader who sees `2` has to remember which document they are in; a reader
 * who sees `split` does not.
 *
 * The list is the ORDER OF DECREASING FIDELITY and the validator refuses
 * anything not in it. `render/baked-light.ts` imports both — one source of
 * truth for what a rung is, and it lives here because this file is three-free
 * and `edition-schema.ts` is imported by fourteen node-environment tests.
 */
export const BAKED_LIGHT_RUNGS = ['split', 1, 3] as const

/** Which rung of DEV-232's ladder the bake takes. See {@link BAKED_LIGHT_RUNGS}. */
export type BakedLightRung = (typeof BAKED_LIGHT_RUNGS)[number]

/**
 * The land's diffuse lighting computed once into its vertex colours. DEV-232,
 * with the rung DEV-237.
 *
 * `EditionFeature`'s shape plus the one knob, which is not a tuning number: it
 * selects which `#define` the terrain's base material carries, and therefore
 * which program three compiles. A rung is a picture, not a coefficient.
 */
export interface EditionBakedLight extends EditionFeature {
  /**
   * `'split'` shadows only the direct half; 1 shadows the lot; 3 drops the
   * shadow. See {@link BAKED_LIGHT_RUNGS} for what each one keeps, and
   * `docs/DEVIATIONS.md` DEV-237 / DEV-240 for the pictures.
   *
   * **3 is the value that reproduces the build DEV-232 measured**, so both
   * shipped presets carry it and the flag itself stays off.
   */
  readonly rung: BakedLightRung
}

/**
 * How finely the SEA is drawn, band by band. DEV-183.
 *
 * NOT an `EditionFeature`: there is no "off". Every preset draws the ocean at
 * some density, and Classic's is a ladder like any other — six copies of the
 * one number the port has used since DEV-023.
 */
export interface EditionOcean {
  /**
   * Sub-quads per edge at each LOD, index = LOD. `[8, 4, 2, 1, 1, 1]` keeps the
   * dense facets where the faceting reads and drops them at distance.
   *
   * Shorter than the terrain's `lodLevels` is legal: the LAST entry covers
   * every level beyond it, so `[8]` is a flat ladder and `[]` would be no
   * ladder at all (which is why `validateEdition` refuses it).
   *
   * `?ocean=<n>` still overrides the whole ladder with one number, which is
   * what makes `?ocean=1` 2016's own geometry and `?ocean=8` the pre-DEV-183
   * build.
   */
  readonly subdivisionByLod: readonly number[]
}

/**
 * The sea as camera-centred rings (a geometry clipmap) instead of the plate's
 * 8 km chunks. DEV-339, `render/ocean-rings.ts`, docs/plan/OCEAN-PERF.md.
 *
 * `EditionFeature`'s `enabled` plus the ladder as data: `cells` per window side
 * (even), the finest level's `innerCell` in world metres, and how many `levels`
 * (each doubling the cell). Level k is the plate's LOD k at the same split.
 */
export interface EditionOceanRings extends EditionFeature {
  readonly cells: number
  readonly innerCell: number
  readonly levels: number
  /**
   * DEV-340: the face normal comes from the ring vertex shader (a flat varying,
   * one exact normal per triangle, no screen-space derivative) instead of the
   * fragment's `dFdx` / `dFdy`. Off until measured and seen.
   */
  readonly faceNormals: boolean
}

export interface EditionTerrain {
  /** LOD −1 around the ship. ANNIVERSARY.md T1, DEV-085. */
  readonly detailRing: EditionDetailRing
  /** The dithered cross-fade between LODs. DEV-130. */
  readonly lodFade: EditionLodFade
  /**
   * DEV-831 (Matt, 2026-10-08): split each terrain quad along the diagonal 2016's
   * code MEANT to choose, not the one its '.y'-for-'.z' bug chooses
   * ('sim/terrain/faceted.ts', 'faithfulDiagonalBug'). Read when a world is built.
   */
  readonly diagonalFix: EditionFeature
  /** Roughness by surface class. DEV-132. */
  readonly surfaceGloss: EditionSurfaceGloss
  /**
   * The land's diffuse lighting computed once into its vertex colours, with
   * three's physical chain gated out behind it. DEV-232.
   *
   * No numbers of its own: what it bakes is read off the scene's own sun and
   * light probe (`render/baked-light.ts`), so there is nothing here for a
   * preset to get wrong. It ships **off** in both editions until it has been
   * measured and Matt has seen the picture — which also makes the shipped
   * build the A/B's baseline and the harness's arm the treatment, the polarity
   * `VRTO3D_FLAGS_ON` exists for.
   *
   * The one knob is `rung` (DEV-237), and it is a PICTURE rather than a
   * coefficient — which rung the land takes decides whether the ship, the
   * racers and the landmarks still cast onto the ground.
   */
  readonly bakedLight: EditionBakedLight
  /** Sea density per LOD band. DEV-183. */
  readonly ocean: EditionOcean
  /** The sea as camera-centred rings. DEV-339. */
  readonly oceanRings: EditionOceanRings
}

/**
 * One class of scattered object, and the band of ground it belongs on.
 *
 * V9, DEV-089. NOT an `EditionFeature` — a band has no "off", it either exists
 * in the list or it does not, and Classic's list is empty. The flag that
 * `editionFeatures` walks is `props.enabled`, one level up.
 *
 * The units are named on every field because DEV-027's lesson is that a number
 * nobody says the units of gets quoted in a comment and built on.
 */
export interface EditionPropBand extends DressingBand {
  // Every numeric field, the kind and the palette are `DressingBand`'s
  // (`sim/props/dressing.ts`), which owns what each number is OF. `PropKindId`
  // below is that file's `PropKind`.
  readonly note?: string
}

/** Flocks near the course. A flock is a scale cue AND a speed cue. S5, DEV-089. */
export interface EditionBirds extends EditionFeature {
  /** How many, spread evenly by ARC LENGTH along the racing line. */
  readonly flocks: number
  readonly birdsPerFlock: number
  /** METRES above the ground under the loop's centre — not above the sea, not above the route. */
  readonly altitude: number
  /** METRES: the loop's mean radius. */
  readonly radius: number
  /** METRES PER SECOND at that radius. */
  readonly speed: number
  /** METRES, wing tip to wing tip. A gull is about one, and that IS the cue. */
  readonly size: number
  /** Linear RGB triples. */
  readonly palette: readonly (readonly number[])[]
}

/** More classes of familiar-size object. ANNIVERSARY.md §1.5 item 6 / V9, DEV-089. */
export interface EditionProps extends EditionFeature {
  /** The placement PRNG's seed. Not a 2016 concept — 2016's scatter was unseeded. */
  readonly seed: number
  /** METRES of clear air around the racing LINE and every gate centre. */
  readonly clearance: number
  /** Seeded mesh variants per kind. Capped at 4 — one vertex attribute each. */
  readonly variants: number
  /** The bands. EMPTY on Classic. */
  readonly scatter: readonly EditionPropBand[]
  readonly birds: EditionBirds
  readonly unbakedPasses: EditionUnbakedPasses
  /**
   * Per-KIND multipliers on 2016's own scatter scales — DEV-134.
   *
   * Keyed by the palette entry's `kind` as `tools/extract/props.mjs`
   * classified the pack: `tree`, `cactus`, `bush`, `palm`. A kind that is
   * absent is 1. Measured off the glTF bounds through the same instance
   * matrix the renderer composes: alpine's shipped pass stands 15–83 m tall and
   * its never-run pass 11–78 m, against 20–45 m for a mature conifer; desert's
   * cacti 15–46 m against a saguaro's 12–15. Classic's map is EMPTY, so it
   * multiplies nothing and draws 2016's sizes.
   */
  readonly scale: EditionPropScale
  readonly groundSnap: EditionGroundSnap
  readonly scatterShadows: EditionScatterShadows
  readonly meshLod: EditionMeshLod
  readonly maxSlope: EditionMaxSlope
}

/**
 * No scatter prop on a facet steeper than `sin` — DEV-356.
 *
 * Matt, 2026-09-24: *"don't place props on steep slopes."* 2016's generator
 * had no slope rule (one roll per density texel, nothing else), so its trees
 * stood on cliffs as often as the port's do; this is a deviation, off on
 * Classic. The slope is the RENDERED facet's (`sim/terrain/surface.ts`), in
 * the unit the dressing's bands use: `sin` of the angle, 0 flat, 1 a wall.
 * Read at world build, like `groundSnap`: a prop is removed before its
 * collider exists, and a live flip would have to rebuild the forest.
 */
export interface EditionMaxSlope extends EditionFeature {
  /** `sin` of the steepest facet a prop stands on. 0.7 is 44 degrees. */
  readonly sin: number
}

/**
 * Coarser meshes for the far scatter — DEV-338.
 *
 * Matt, 2026-09-24: *"create lods or whatever else you think needs to happen to
 * smooth out the current method of either showing a prop or not at all."* The
 * scatter is the whole worn VR gap (DEV-263) and it drew every prop inside
 * 2016's `LODDistance` at full detail. With this on, a chunk whose nearest
 * point is `rungs[k].from` metres away draws a copy of each mesh kept to
 * `rungs[k].keep` of its corners, simplified at load by
 * `game/props/lod-geometry.ts`, and changes rung by 2016's own staggered
 * reveal rather than as a block. The outer edge is 2016's, untouched.
 *
 * `rungs` is read at world build (it decides which meshes exist); `enabled` is
 * read at every scan, so a live flip walks the forest back to full detail.
 * Off on Classic with no rungs, which builds nothing: Classic is DEV-225's
 * reveal exactly.
 */
export interface EditionMeshLod extends EditionFeature {
  /** Nearest first: `from` strictly ascending, `keep` strictly descending. */
  readonly rungs: readonly EditionMeshLodRung[]
}

export interface EditionMeshLodRung {
  /** Metres from the camera to a chunk's NEAREST point where this rung begins. */
  readonly from: number
  /** Fraction of the mesh's distinct corners it keeps, exclusive of 0 and 1. */
  readonly keep: number
}

/**
 * Whether the SCATTER is in the shadow map's caster set — DEV-224.
 *
 * `enabled` true is 2016's caster set and the port's behaviour up to here: every
 * `InstancedMesh` of the scatter draws into the depth map as well as into the
 * frame. False takes it out, and takes nothing else out — the land at LOD 0,
 * the hand-placed landmarks and the ship's exterior hull all keep casting, and
 * the scatter keeps RECEIVING, so a tree still darkens under the ridge it is
 * standing behind.
 *
 * **It is off on Anniversary**, which is a deviation with a row
 * (`docs/DEVIATIONS.md` DEV-224) rather than a fidelity choice, and it is the
 * only flag in this file whose `false` costs pixels rather than adding them.
 * The reason is arithmetic rather than taste: the scatter is 88–93 % of
 * desert's and alpine's world pass (7.42 M triangles in 18 draw calls on
 * desert, a per-ENVIRONMENT constant across all four of its missions), the
 * shadow pass draws it again, and the whole depth pass measured **2.70 ms p50**
 * on `adv_01_hoverJet` with a 0.01 ms bracket. `docs/plan/VR-PERF-WAVE-3.md` §5.
 *
 * Off on Classic too, where it is inert: `render.shadows.enabled` is false
 * there, so no object is given a flag at all.
 */
export type EditionScatterShadows = EditionFeature

/** The per-kind multipliers. A kind that is absent multiplies by 1. */
export interface EditionPropScale {
  readonly note?: string
  readonly tree?: number
  readonly cactus?: number
  readonly bush?: number
  readonly palm?: number
}

/**
 * Put every scattered prop's base on the RENDERED surface — DEV-134.
 *
 * 2016's `GenerateObjects()` reads `SourceHeightMap`, the smooth map, and the
 * mesh is that map plus `RandomOffset` of jitter per vertex, so a trunk placed
 * by the map stands on a point the facet under it has moved away from — up to
 * 0.8 m on alpine. And the pass that Anniversary alone draws (DEV-102) carries
 * `ObjectHeightOffset -2.6`, which is SUBTRACTED and so raises every one of
 * its trees 2.6 m before the jitter is counted. With this on, a base goes to
 * the surface `sim/terrain/surface.ts` reads off the same vertex grid the
 * chunks are built from, then `sink` metres under it. Classic keeps 2016's
 * rule, buried offsets and all.
 */
export interface EditionGroundSnap extends EditionFeature {
  /** Metres the base is buried below the facet it stands on. */
  readonly sink: number
}

/**
 * 2016's generator passes that 2016 never ran. DEV-102, settled by Matt
 * 2026-09-14: *"keep em for anniversary"*.
 *
 * `FacetedTerrain`'s scatter is an EDITOR-time `GenerateObjects()` whose output
 * is serialised on the component. Three of the port's five passes have a
 * serialised output of **zero objects** — alpine's 6–20x Tree Pack pass, which
 * is also `m_Enabled: 0`, and the palm generators on Simonet and Kauai, which
 * are enabled and empty. So 2016 scattered props in TWO environments and the
 * port drew five passes across four, for four sessions, on the strength of the
 * components having parameters.
 *
 * This is the switch that makes both readings true at once: **Classic draws
 * what 2016 SHIPPED, Anniversary draws what 2016 SET UP.** Neither is a
 * regression and neither needed the other thrown away, which is the preset
 * system doing the job it was built for (§0.2).
 *
 * The predicate is `bakedObjects > 0`, off the environment JSON's own
 * `shipped2016` block, and it is deliberately the COUNT rather than the
 * component's enabled flag — DEV-102's whole lesson is *when a 2016 component's
 * job is to produce objects, count the objects*. `componentEnabled` is
 * corroborating evidence and is not consulted.
 *
 * Read at WORLD BUILD, not per frame, so a live EDITION flip does not restack
 * the trees under you; the next course swap does (DEV-077 rebuilds the world
 * without a reload). Some Anniversary features change on the flip and some
 * need a reload; this is one of the latter, and it says so.
 */
export interface EditionUnbakedPasses extends EditionFeature {}

/**
 * **THE GAMEPLAY BLOCK, and it is the only one that changes the GAME.**
 *
 * §0.2 fenced this before anything was built: *"Anything that changes the GAME
 * — scoring, rules, routes — is a separate, explicitly gameplay-tagged flag,
 * lives in `src/game/` behind the same preset object, and gets its own DEV row
 * and its own tests. Classic never reads them."*
 *
 * Everything else in an edition is presentation — a haze, a shadow, a curve, a
 * pulse — and a Classic run and an Anniversary run of the same flight produce
 * the same score. **Under this block they do not**, and that is the whole reason
 * it is kept apart rather than folded in beside the render flags.
 *
 * ANNIVERSARY.md §4.1's first two levers, and both were Matt's to call
 * (2026-09-14: *"do it"*). DEV-110.
 */
export interface EditionGameplay {
  readonly proximity: EditionProximity
  readonly gateEvents: EditionGateEvents
  /** G2's other half: the speed chain, drawn. No numbers — it shows what the sim has. */
  readonly chainMeter: EditionFeature
  /**
   * DEV-153: the AIM RETICLE inside a gate. 2016 drew nothing in the aperture.
   *
   * In THIS block rather than beside the render flags for the same reason
   * `chainMeter` is: it changes no score, and its RADIUS is `gateEvents`'s own
   * `cleanCentredness` against the gate's trigger radius — it draws a rule, so
   * it belongs with the rule it draws, and a player who can see where CLEAN is
   * flies differently.
   */
  readonly gateBullseye: EditionGateBullseye
  /** DEV-125: how many AI racers stand on the grid, and where. */
  readonly racers: EditionRacers
  /** DEV-126: the arcade crash-and-reset. 2016 never crashed. */
  readonly crash: EditionCrash
  readonly propCollision: EditionPropCollision
  /** DEV-143: boost COSTS energy. 2016 charged nothing for it. */
  readonly energy: EditionEnergy
  /** DEV-144: the energy race. A MODE, not a tweak — the fourth row in `modes.ts`. */
  readonly energyRace: EditionEnergyRace
  /** DEV-146: other missions' ships flying past while you fly yours. */
  readonly ambientTraffic: EditionAmbientTraffic
  /** DEV-380: the aircraft VARIANT step. Classic has one of each aircraft. */
  readonly variants: EditionVariants
  /** DEV-399: the GLIDER, a third aircraft. 2016 authored one and switched it off. */
  readonly glider: EditionGlider
  /**
   * DEV-389: ROOMS — live multiplayer (plan/MULTIPLAYER.md). Its people start
   * on the racers' own starts (DEV-477). **Not in any lap's rules** (`net/lap-courses-build.ts`
   * leaves it out of the hash): a room lap never goes on a solo board (§11 call
   * 10), so a room's settings can move no board.
   */
  readonly rooms: EditionRooms
  /**
   * DEV-466: the COURSE EDITOR and player courses (docs/plan/EDITOR.md §5.7).
   * A switch and nothing else. **Not in any lap's rules** (`RULES_IGNORE`): it
   * decides what the menus offer, not what a lap is.
   */
  readonly editor: EditionEditor
  /**
   * DEV-480: FACETED FLIGHT TV (docs/plan/FF-TV.md). A switch and nothing
   * else. **Not in any lap's rules** (`RULES_IGNORE`): it decides what the
   * menus offer, not what a lap is.
   */
  readonly tv: EditionTv
}

/**
 * DEV-480, **Faceted Flight TV**: watch live races without their code or
 * their names, or the AI racers when nothing is live (docs/plan/FF-TV.md).
 * Matt, 2026-09-30: *"i want it to go out with 1.0 and be easy to share links
 * to view self, others, or random rooms."*
 *
 * A switch and nothing else, the `editor` shape, because `PREVIEW_ONLY`
 * (`content/build-channel.ts`) names `gameplay` blocks and `tv` was on that
 * list until DEV-578 took it off (Matt, 2026-10-03: *"FF-TV - move to
 * production"*). It
 * gates the title's TV row and the `?tv` links, and the results panel's watch
 * link. The menus wear Anniversary (D35), so they read Anniversary's block and
 * Classic's mirrors its shape so a flip changes nothing else.
 */
export interface EditionTv extends EditionFeature {
  /**
   * DEV-481 follow-up. In a headset, TV's comfort CUTS (trackside vantages, a
   * cut through black, teleport and snap turn) instead of the flat camera. OFF
   * at launch: Matt, 2026-10-01, *"let's keep it functionally identical to
   * flat at launch. (don't limit VR users to teleport and snap turn)"*. Kept,
   * with its tests, for a comfort option after launch. Inside `tv`, so it is
   * outside every lap's rules with it (`RULES_IGNORE`).
   */
  readonly headsetCuts: EditionFeature
}

/**
 * DEV-466 — **the course editor**, and playing courses players made
 * (docs/plan/EDITOR.md, the 1.0 slice in §5.7). Matt, 2026-09-27: *"desktop
 * editor first"*, *"it'd be nice to get something in for 1.0"*.
 *
 * A switch and nothing else, the `glider` shape. It is here because
 * `PREVIEW_ONLY` (`content/build-channel.ts`) names `gameplay` blocks, and it
 * was on that list until DEV-470 took it off (D36: the editor ships in 1.0).
 * Menus always wear Anniversary (D35), so the
 * rows it gates read Anniversary's block, and Classic's is never consulted by a
 * menu; it mirrors Anniversary's shape so a flip changes nothing else.
 */
export interface EditionEditor extends EditionFeature {}

/**
 * DEV-389. Matt, 2026-09-25 (§11 call 2): *"go from lobby to loaded in the
 * map, to a shared countdown - everyone gets go at the same time."* A switch
 * and nothing else since DEV-477: a room's people stand on the racers' own
 * starts (Matt, 2026-09-27: *"1 player per start-point (players instead of the
 * ai racers)"*), which `gameplay.racers` already lays out
 * (`game/racer-grid.ts`'s `roomStarts`), so DEV-389's `row.spacing` went with
 * the human row it spaced.
 *
 * `enabled` false: this preset does not race in rooms (Classic, until the
 * plumbing exists, §11 call 4). It was a `PREVIEW_ONLY` block
 * (`content/build-channel.ts`) until DEV-470 (D36: rooms ship in 1.0); a site
 * with no rooms Worker bound says so to the player (`game/room-client.ts`'s
 * `ROOM_OFF`).
 */
export interface EditionRooms extends EditionFeature {}

/**
 * DEV-399 — **the glider**, a third aircraft (docs/plan/AIRCRAFT-VARIANTS.md
 * §5, G1). A switch and nothing else, the `variants` shape: the glider's
 * numbers are its own file's (`content/aircraft/glider.json`), so this block
 * holds none.
 *
 * On, the glider's courses join the level list (`levelIds`' fleet) and the
 * hangar gets a third aircraft table. Off is 2016 exactly: 2016 authored a
 * glider at every level of the game and shipped it switched off at every level
 * (DEV-145), so Classic's hangar has two aircraft and never lists a glider
 * course. In the GAMEPLAY block because an aircraft is the game.
 */
export interface EditionGlider extends EditionFeature {}

/**
 * DEV-380 — **aircraft variants**, a second pick after the aircraft. Matt,
 * 2026-09-24: *"a new selection after the aircraft type"*. docs/plan/
 * AIRCRAFT-VARIANTS.md §8.
 *
 * A switch and nothing else. The variants themselves are properties of the
 * AIRCRAFT, not of a look preset, so they live in `content/aircraft/<vehicle>
 * .json` (§2.1) and this block holds no numbers: Classic carrying twelve
 * multipliers that mean nothing would be twelve rows of noise.
 *
 * In the GAMEPLAY block because a variant changes the machine: a speed variant
 * over the same stick is a different run. `enabled` false is 2016 exactly:
 * `resolveVariant` returns `standard` whatever is stored or in the URL, so a
 * Classic flight is built from the sheet itself — a no-op twice over.
 */
export interface EditionVariants extends EditionFeature {}

/**
 * DEV-146 — **ambient traffic**. Matt's triage, 2026-09-16: *"Interleaved
 * modes: see HoverJets fly while on a JumpSeat course."*
 *
 * WHICH course the traffic flies is the LEVEL's (`Level.ambientTraffic`,
 * emitted by the extractor) because it differs per island. What is here is the
 * switch and the frame budget, which is what an edition is for: 2016 had
 * nothing of the kind, so Classic's `enabled` is false and it never reads the
 * level's field at all.
 *
 * It is in the GAMEPLAY block rather than beside the render flags even though
 * it scores nothing, because it puts bodies in the world: they are stepped by
 * the same flight model on the same fixed tick, so a Classic run and an
 * Anniversary run of the same flight are no longer the same amount of sim.
 * The score is identical; the work is not, and `§0.2`'s fence is about the
 * game and not only about the scoreboard.
 */
export interface EditionAmbientTraffic extends EditionFeature {
  /**
   * The ceiling on a level's `count`, for THIS edition. The frame budget, and
   * the one number a headset pass turns.
   *
   * Distinct from `AMBIENT_TRAFFIC_MAX` in the level schema, which is a
   * structural cap on authored content — that one says "this is not a number
   * anybody meant", this one says "this many ships fit in the frame". 0 is a
   * legal value and means the same as `enabled: false` for the count, which is
   * why Classic says both.
   */
  readonly maxCount: number
  /**
   * Metres from the player inside which a ship that has finished its lap is
   * NOT recycled to the start of its line.
   *
   * A recycle is a teleport. Deferring it until the ship is far away makes it
   * IMPOSSIBLE to see rather than unlikely to be seen — the distinction
   * DEV-041 paid for. A finished ship keeps flying out (climbing away, as every
   * finished racer does) until it is beyond this, so the rule costs nothing
   * when it does not fire.
   */
  readonly recycleClearMetres: number
}

/**
 * One extra starting position, in the PLAYER'S frame at the release point.
 *
 * Metres AHEAD along the spawn heading and metres to the player's RIGHT, at the
 * release altitude, facing the spawn heading — which on every shipped HoverJet
 * course is the route's own first direction. `game/racer-grid.ts` turns these
 * into world positions; nothing here knows what a quaternion is.
 */
export interface EditionRacerSlot {
  readonly ahead: number
  readonly right: number
  /** A key of `AI_RACER_TUNINGS`. Absent: the loader hands out the next unused one. */
  readonly tuning?: string
}

/**
 * DEV-125 — the grid. Matt: *"add 3 more racers to the hover jet. these should
 * be aligned in front of the player at the race start."*
 *
 * `enabled` false is 2016's grid exactly: one racer per AI pad the scene
 * authored, and the slot list is never read. On, the pads come first (when
 * `usePads`) and the slots follow, so the count is `pads + slots`. Nothing
 * about how a racer FLIES is here — the tunings are the sim's.
 */
export interface EditionRacers extends EditionFeature {
  readonly usePads: boolean
  readonly slots: readonly EditionRacerSlot[]
  /** DEV-364: each racer flies its own lane and keeps off the others. Not composed with `enabled`. */
  readonly separation: EditionRacerSeparation
  /** DEV-364: craft touch — a push, never a crash. Not composed with `enabled`. */
  readonly contact: EditionRacerContact
  /**
   * DEV-364 follow-up: what a racer's hit costs the player, on top of the push.
   * Composed with `contact` (nothing touches, nothing is hit), not with `enabled`.
   */
  readonly hit: EditionRacerHit
}

/**
 * DEV-364 — the racers keep apart. `sim/ai-racer.ts` (`laneOffsetAt`,
 * `avoidance`) is the rule; these are its numbers. Off is the one racing line
 * every racer flew before, which is what 2016's recordings amount to.
 *
 * Its own feature and not `gameplay.racers.enabled`: that flag is the GRID
 * (DEV-125), and Classic's two racers on 2016's two pads still fly.
 */
export interface EditionRacerSeparation extends EditionFeature {
  /** Metres between neighbouring lanes. */
  readonly laneSpacing: number
  /** Metres of arc after gate 0 over which a racer moves from its grid slot to its lane. */
  readonly laneEaseMetres: number
  /** 0..1 of a ring's radius the lanes plus a hull may use at the ring. */
  readonly gateFraction: number
  /** Metres of lateral room regained per metre of arc away from a ring. */
  readonly gateFunnel: number
  /** Metres along the course, ahead or behind, inside which another craft is avoided. */
  readonly avoidReach: number
  /** Metres off a racer's own track inside which another craft is avoided. */
  readonly avoidClearance: number
  /** Metres a racer's lane moves at full avoidance. */
  readonly avoidGain: number
}

/**
 * DEV-364 — craft touch. `sim/craft-contact.ts` is the rule. Off is 2016's
 * ghosts: nothing you can meet.
 */
export interface EditionRacerContact extends EditionFeature {
  /** 0..1: how much of the closing speed comes back out as a push. */
  readonly restitution: number
  /** m/s of closing speed under which a contact does not bounce. */
  readonly restingSpeed: number
  /** Sweeps over every pair per tick, a whole number of at least 1. */
  readonly passes: number
}

/**
 * DEV-364 follow-up — a hit costs something. Matt, 2026-09-25: *"sound and
 * physics cost - nudge the players as if they got hit"*. `sim/craft-hit.ts` is
 * the nudge (the speed scrubbed, the nose and the canopy knocked toward the
 * push) and `game/racer-hit.ts` the sound and the cockpit's jolt. The PLAYER
 * only; a racer takes the push alone. Off is DEV-364's push and nothing else.
 */
export interface EditionRacerHit extends EditionFeature {
  /** m/s of closing speed at and under which a contact is a lean, not a hit. */
  readonly minSpeed: number
  /** m/s of closing speed at which a hit is at full strength. Above `minSpeed`. */
  readonly fullSpeed: number
  /** 0..1 of the player's speed a full-strength hit takes away. */
  readonly scrub: number
  /** rad/s swinging the nose toward the push, at full strength. */
  readonly headingKick: number
  /** rad/s tipping the canopy toward the push, at full strength. */
  readonly attitudeKick: number
  /** Seconds the cockpit's jolt takes to die away. Render time. */
  readonly shakeSeconds: number
  /** The jolt's peak at full strength, in multiples of `cockpit.shake`'s `amplitude` and `angle`. */
  readonly shakeGain: number
}

/**
 * DEV-126 — crash too hard and you are put back on the course, a little way
 * behind where you hit, at low speed. Matt: *"like an arcade game"*.
 *
 * `sim/crash.ts` is the rule; these are its five numbers, and every one is a
 * first guess (see the preset's note for how each was reasoned). `enabled`
 * false is 2016: `Ship_HoverShip.OnCollisionEnter` is `Flash()` and a bounce,
 * `endOnCollide` 0.
 */
export interface EditionCrash extends EditionFeature {
  /** m/s of velocity INTO the surface at or above which a contact is a crash. */
  readonly minImpactSpeed: number
  /** Metres of arc length behind the crash, along the course, for the reset. */
  readonly resetBackMetres: number
  /** Metres above the collision surface the reset is lifted to if the line is lower. */
  readonly clearanceMetres: number
  /** m/s along the course the ship is given back. */
  readonly resetSpeed: number
  /** Seconds the sim holds the wreck where it hit before the reset. */
  readonly holdSeconds: number
  /**
   * DEV-185. Metres of arc length per step while walking further BACK along the
   * line looking for a reset that is not inside a tree, bounded by
   * `resetBackMetres`. `clearanceMetres` lifts over the terrain and knows
   * nothing about the forest. 0 switches the rule off.
   */
  readonly resetClearStepMetres: number
}

/**
 * The props are solid, and they break — DEV-136. `sim/props/collision.ts`.
 *
 * In this block and not under `props`, because a contact moves the ship: a
 * Classic run and an Anniversary run of the same stick diverge at the first
 * tree, which is the definition of gameplay §0.2 fenced. 2016 had no prop
 * collision at all; Classic keeps flying through the forest.
 */
export interface EditionPropCollision extends EditionFeature {
  /** m/s at or above which a contact BREAKS the prop rather than bouncing off it. */
  readonly breakSpeed: number
  /** Fraction of the ship's speed a break costs, 0..1. */
  readonly breakSlowdown: number
  /** How much of the velocity into a standing prop comes back out, 0..1. */
  readonly bounceRestitution: number
  /** Collider radius as a fraction of the prop's drawn width, 0..1. */
  readonly radiusFraction: number
  /** Spatial hash cell, metres. */
  readonly cellMetres: number
  /** Seconds the fractured pieces fly and fade before they are removed. */
  readonly fractureSeconds: number
  /**
   * DEV-180: seconds of unbroken contact after which an AI RACER breaks what
   * it is resting on, whatever its speed. 0 switches the escape off.
   *
   * The player never takes this branch. A racer has to, because it cannot let
   * go of the stick: once it finishes it cruises at `minThrottle` and once it
   * crash-resets it arrives at `crash.resetSpeed`, both under `breakSpeed`, so
   * the break branch is closed to it and a palm becomes a wall.
   */
  readonly racerStuckSeconds: number
  /**
   * DEV-428: a struck PLANT stands — its collider kept, the hitter let through
   * once per pass (`sim/props/collision.ts`). Only the switch: the burst it
   * throws is `fx.propBurst`. PLANTS only — every scatter kind is one; a spire
   * (a landmark rock with its own hull) struck at speed is still removed and
   * fractured, because flying through a standing one would put the eye inside
   * stone (`isLandmark`).
   */
  readonly strike: EditionFeature
}

/**
 * DEV-428 — **the burst a struck plant throws, in its own colours.** Matt,
 * 2026-09-26: *"instead of removing props that are collided with, spawn
 * particle burst fx at the collision point, in the color of the collided prop,
 * and give it some velocity from the collision"*, and asked what the tree does:
 * *"stay standing."*
 *
 * TWO switches for one response, and the split is the lap server's: the SIM
 * half — the collider kept, the hitter let through — is
 * `gameplay.propCollision.strike`, because it moves the ship; this, the LOOK,
 * is here, because every number in `gameplay` is hashed into a course's lap
 * rules (`net/lap-courses-build.ts`, DEV-372) and tuning a leaf's size must
 * not start every Anniversary board again. The burst is thrown wherever a
 * strike leaves its prop standing (`strikeStands`); off, the tree stands and
 * nothing is thrown.
 *
 * The burst is AUTHORED (no 2016 system did this): `game/particle-fx.ts`'s
 * `propStrikeSpec` turns these numbers into a particle spec. Paper, not
 * light: the leaves do not glow (ART_DIRECTION, "What may glow").
 */
export interface EditionPropBurst extends EditionFeature {
  /** Particles per strike. A whole number, 1 or more. */
  readonly count: number
  /**
   * 0-1: how much of the HITTER's velocity the burst leaves with. THE NUMBER TO
   * ARGUE WITH. 0 is a puff hanging where the tree was; 1 is a cloud that
   * keeps pace with the ship.
   */
  readonly carry: number
  /** m/s of scatter on top of the carry, in every direction. */
  readonly spread: number
  /** Metres. The ball the burst is born in, about the contact point. */
  readonly radius: number
  /** Seconds a piece lives, at most (each draws 60-100 % of it). */
  readonly lifetime: number
  /** Metres. A piece's size, at most (each draws 60-100 % of it). */
  readonly size: number
  /** × the world's 32 m/s². Paper falls slower than stone. */
  readonly gravity: number
  /** Per second: how fast the air takes a piece's speed away. */
  readonly drag: number
  /** × the prop's own face colours: an unlit piece against the lit tree. */
  readonly shade: number
  /**
   * 0-1 of the prop's height, either side of the contact: the faces whose
   * colours the burst takes. A strike in the crown is leaves; at the foot, bark.
   */
  readonly colourBand: number
  /**
   * Metres from the eye beyond which a strike throws nothing. A racer's strike
   * far down the course is under a pixel; the pool is better spent near you.
   */
  readonly maxMetres: number
}

/**
 * DEV-143 — **boost costs energy.** Matt, 2026-09-16: *"hold gas + boost as
 * much as you can"* feels one-dimensional.
 *
 * It was one-dimensional in 2016 as well, and measurably so: DEV-002 put the
 * net at **+68 energy/s while boosting**, so the tank fills faster than the
 * boost empties it and there is never a reason to let go. `sim/energy.ts` is
 * the arithmetic, and it takes the tank (100), the burn (`engineBurnrate ×
 * BoostBurnrate` = 32/s) and the empty penalty (`RebootTime`, 3 s) off the
 * generated sheet.
 *
 * **This block carries exactly one number**, and it is a multiplier rather than
 * a rate so that `1` is the shipped game and a reader can see how far a preset
 * has moved without doing arithmetic. `enabled` false is 2016 exactly: no tank,
 * boost is a free doubling of thrust, and a Classic run of a given stick is
 * byte-identical to the one that shipped.
 */
export interface EditionEnergy extends EditionFeature {
  /**
   * Multiplier on `hoverjet.energy.rechargeRate` (100/s on the shipped prefab).
   *
   * At or above `burn / rechargeRate` = **0.32** the tank can never empty and
   * boost is free, which is what 2016 does at 1. Anniversary runs **0.16** — a
   * recharge of exactly HALF the burn, which is one design sentence (*you may
   * boost half the lap*) and gives 6.25 s of boost from full, a 6.25 s refill
   * and a 50 % sustainable duty cycle. The validator refuses a negative; it
   * deliberately does NOT refuse a value above 0.32, because "boost is free" is
   * a legal preset — it is the one Classic ships.
   *
   * THE NUMBER TO ARGUE WITH, and it is settled by flying it, not by measuring.
   */
  readonly rechargeScale: number
  /**
   * DEV-410. A multiplier on `hoverjet.energy.RebootTime`. 1 is 2016's 3 s of
   * no boost at an empty tank; Anniversary runs 0, and an empty tank then
   * boosts on what the recharge pays (`sim/energy.ts`).
   */
  readonly lockoutScale: number
  /**
   * DEV-410. The fraction of the tank a ring the player takes puts back. 0 is
   * 2016. Anniversary's 0.5 is derived from `int_01`'s longest leg; see
   * `sim/energy.ts`.
   */
  readonly ringRefill: number
  /**
   * DEV-410 follow-up (Matt, 2026-09-26: an empty tank is *"nothing"*). The
   * fraction of the tank it must hold again, after running dry, before boost
   * lights. A ring's refill clears the wait at once. 0 is no wait.
   */
  readonly reengage: number
  /**
   * DEV-630 (Matt, 2026-10-04: *"boost should be empty at the start"*). The
   * fraction of the tank a run starts with. 1 is 2016 (`Awake()` does
   * `currentEnergy = maxEnergy`); Anniversary runs 0, so the first boost is
   * earned by a ring or by the recharge, and a tank that starts at 0 starts
   * DRY: it waits for `reengage` like any other empty tank.
   */
  readonly startFill: number
}

/**
 * DEV-144 — **the energy race.** *"Gates give energy, run dry and you fall."*
 *
 * A MODE and not a tweak: Ring Attack with a tank under it that only a gate
 * refills, and a ship that falls when the tank empties. `game/modes.ts`'s
 * fourth row is the mode; `sim/energy-race.ts` is the arithmetic; this is the
 * two numbers and the switch that says the mode may be reached at all.
 *
 * **`enabled` false does not disable a mode that is running — it stops the mode
 * being SELECTABLE.** No shipped level chooses it (and none can: see
 * `GameMode`'s note on the generated, hash-guarded level tree), so on Classic
 * this block is unreachable twice over.
 *
 * Both numbers were sized against a MEASUREMENT of the shipped game — the two
 * 2016 ghost recordings of `int_01_hoverJet`, whose gate-to-gate intervals and
 * gateless stretches are tabulated in `sim/energy-race.ts`'s header. They are
 * still design numbers, and the DEV-144 row says which parts are measured and
 * which are chosen.
 */
export interface EditionEnergyRace extends EditionFeature {
  /**
   * Multiplier on `hoverjet.energy.engineBurnrate` (8/s) for the CRUISE drain.
   * Boosting costs `x (1 + BoostBurnrate)` = 5x that, which is 2016's prototype
   * firing both burn branches on a boosting tick.
   *
   * 0.3 is 2.4/s cruising and 12/s boosting — a full tank is 41.7 s of cruise
   * or 8.3 s of boost, against a measured 9.9 s from release to the first gate.
   */
  readonly drainScale: number
  /**
   * What a gate pays, as a FRACTION of the tank. 0.25 is 25 units.
   *
   * Not `scoring.energyBoostAmount` (12), which is in the level JSON already:
   * that field is a `code-default` private constant, identical on every gate of
   * every shipped mission, so it carries no per-course variation to preserve —
   * and at 12 units against a 2.4/s drain a gate would be worth five seconds,
   * which is a survival mode that never bites. A fraction of the tank is the
   * form a person can reason about. `sim/energy-race.ts` says so at length.
   */
  readonly gatePayFraction: number
}

/**
 * G1 — the low line is the fast line. `sim/proximity.ts` is the arithmetic.
 *
 * *"A score multiplier for flying within N metres of terrain or water, shown as
 * a meter — Superflight's whole design in one rule."* It answers §2.3 item 1:
 * perceived speed is optic flow, optic flow falls off with distance, and the one
 * place this port already feels fast is low over a ridge. Nothing rewarded going
 * there.
 *
 * The bonus is a SEPARATE POOL, never a multiplier applied to 2016's scorers —
 * `sim/proximity.ts`'s header says why, and it is what lets the results panel
 * say "4,200 + 900" instead of "5,100".
 */
export interface EditionProximity extends EditionFeature, ProximitySpec {
  // Every number is `ProximitySpec`'s (`sim/proximity.ts`), which says what each is OF.
}

/**
 * DEV-153 — the aim reticle drawn inside a gate's aperture, Anniversary only.
 *
 * Every number here is a FRACTION of the clean radius rather than metres, so a
 * course with tighter rings gets a proportionally tighter reticle and nothing
 * is re-tuned. The radius itself is not here — it is `cleanCentredness`, one
 * block down, and `game/gate-bullseye.ts` says why that matters.
 */
export interface EditionGateBullseye extends EditionFeature {
  /** A mark's length along its radius, as a fraction of the clean radius. */
  readonly markLength: number
  /** A mark's cross-section, as a fraction of the clean radius. */
  readonly markThickness: number
  /** The centre pip's side, as a fraction of the clean radius. 0 draws no pip. */
  readonly pipSize: number
  /** Emissive intensity. The gate's studs sit at 2 — the sheet's own number. */
  readonly emissive: number
}

/** G2 — a gate taken through the middle at speed, and a pass close to the ground. */
export interface EditionGateEvents extends EditionFeature {
  /** 0..1 centredness at or above which a gate is CLEAN. 1 is the exact centre. */
  readonly cleanCentredness: number
  /** METRES PER SECOND. The "at speed" half of "through its centre at speed". */
  readonly minSpeed: number
  /**
   * METRES to the nearest surface below which a tick is a near miss. Since
   * DEV-112 that is `sim/surface-proximity.ts`'s fan — a wall counts.
   */
  readonly nearMissMetres: number
  /** Seconds before another may fire. A long low pass is ONE piece of flying. */
  readonly nearMissCooldown: number
  /**
   * POINTS a near miss banks into G1's pool (DEV-112). The Anniversary score,
   * never the medal — `sim/proximity.ts` says why the pool is separate. 0 on
   * Classic, and the validator refuses a negative: a lever that can punish is
   * a different design than the one §4.1 argues for.
   */
  readonly nearMissPoints: number
}

/**
 * The out-of-bounds countdown, made visible as signal loss. DEV-127.
 *
 * 2016 shows a `panel_outOfBounds` and logs a line a second — no screen effect
 * — so Classic has none and this is the Anniversary term. `render/boundary-
 * fuzz.ts` is the arithmetic and says what the one number is OF, and why it
 * is NOT on the speed-FX comfort slider (it is feedback, not vection).
 */
export interface EditionBoundaryFuzz extends EditionFeature {
  /**
   * OVERLAY ALPHA of the static at the outermost pixel at the moment the clock
   * reaches zero, 0..1. The level is this times the countdown progress, and
   * the clear disc at the centre closes on the same clock — so this is the
   * only number and the one to argue with. 1 is total signal loss.
   */
  readonly strength: number
}

export interface EditionBoundary {
  readonly fuzz: EditionBoundaryFuzz
}

/**
 * The holotable island drawn as a PROJECTION of the terrain's own colours.
 *
 * The colours themselves are not the flag: 2016's `art_levelSel_*` miniatures
 * were full-colour vertex-painted terrain (`Faceted Terrain_miniMaps.mat`,
 * `Marmoset/Vertex Color/Specular IBL`, `_Color` 0.941, emission black), so
 * both presets draw the palette (`content/palettes/`, DEV-140). What this
 * switches on is the port's TELL that the island is a hologram and not a
 * model — a lift in brightness, a lean toward the room's holo tint, a rim
 * where the facets turn away, and faint scanlines. Off, the island is 2016's
 * plain miniature.
 */
export interface EditionHoloTerrainColours extends EditionFeature {
  /** Multiplier on the island's colour. 1 is the colour map's own byte, relief-shaded (DEV-579). */
  readonly brightness: number
  /** 0..1 lean of every face toward the holo tint. The hue tell. */
  readonly holoMix: number
  /** Strength of the grazing-angle rim in the holo tint. 0 is none. */
  readonly rim: number
  /** 0..1 depth of the scanline darkening. 0 is none. */
  readonly scanline: number
}

/**
 * A dark silhouette shell behind the medal, so a pale tier reads against a pale
 * island. DEV-151.
 *
 * DEV-140 gave the holotable islands the terrain's own colours in BOTH presets,
 * which is what 2016 drew — and 2016's medal is the title emblem in the tier's
 * own `_Color` (DEV-113), pale on four tiers of five. Measured over all four
 * palettes, every tier but bronze sits under WCAG's 3:1 for a graphical object
 * across most of every island, and over Simonet's white rock bronze fails too.
 * The tier colours are 2016's and may not move (a fidelity deviation would need
 * its own row and argument), so the readability has to come from the SHAPE:
 * an inverted hull a little larger than the emblem, drawn back-faces-only, which
 * is a dark border round the outline from every angle and for every tier.
 * ART_DIRECTION pillar 1 — spend the budget on the silhouette.
 *
 * Anniversary only. 2016 had the same pale-on-pale problem and shipped it, so
 * Classic keeps it; this is curation, not a bug fix.
 */
export interface EditionMedalOutline extends EditionFeature {
  /**
   * How far the shell stands off the emblem, as a fraction of the emblem's own
   * height. A fraction rather than metres because the emblem is scaled to the
   * table and a fixed offset would be a hairline on one and a blob on another.
   */
  readonly widthFraction: number
  /** The shell's colour, sRGB 0..1. Dark: it is a border, not a glow. */
  readonly colour: readonly [number, number, number]
  /** 0..1 opacity of the shell. 1 is a solid border. */
  readonly opacity: number
}

export interface EditionMenu {
  /** The holotable islands as terrain-coloured projections. DEV-140. */
  readonly holoTerrainColours: EditionHoloTerrainColours
  /** A dark silhouette behind the medal so every tier reads. DEV-151. */
  readonly medalOutline: EditionMedalOutline
}

export interface Edition {
  readonly id: EditionId
  readonly title: string
  readonly note: string
  readonly render: EditionRender
  readonly fx: EditionFx
  readonly cockpit: EditionCockpit
  readonly audio: EditionAudio
  readonly hud: EditionHud
  readonly terrain: EditionTerrain
  readonly props: EditionProps
  /** The course's gates: how a passed one leaves, how the finish is marked. DEV-122/123. */
  readonly gates: EditionGates
  /** The level select's room and tables. Render only. */
  readonly menu: EditionMenu
  /** THE ONLY BLOCK THAT CHANGES THE GAME. See `EditionGameplay`. */
  readonly gameplay: EditionGameplay
  /** The out-of-bounds warning, drawn. See `EditionBoundaryFuzz`. */
  readonly boundary: EditionBoundary
  /**
   * Features this preset turns OFF while a headset is presenting. DEV-263.
   *
   * Optional, and absent means "the same preset in both places", which is what
   * Classic is and what Anniversary was until 2026-09-21.
   */
  readonly vr?: EditionVrOverrides
  /**
   * The life pass: boats first (DEV-447). Scenery that moves, never the sim —
   * outside `gameplay` on purpose, because a `gameplay` key restarts the
   * Anniversary boards and nothing here can change a lap. See `EditionLife`.
   */
  readonly life: EditionLife
}

/**
 * The VR-only half of a preset. DEV-263, Matt: *"off in VR, on in flat."*
 *
 * ── Why this exists at all ────────────────────────────────────────────────
 *
 * Measured worn on 2026-09-21, `rookie_01_hoverJet` at 1512 px an eye: Classic
 * holds **97 %** of its frames at 90 Hz and Anniversary **75 %**, same mission,
 * same minute, same resolution. Flat, the same build runs at ~178 fps with
 * 1.02 ms of GPU — there is nothing to buy there. So the cheaper look is worth
 * having exactly where the headset is and nowhere else, and a preset that is
 * one thing in both places cannot express that.
 *
 * ── Why a LIST OF PATHS rather than a partial preset ──────────────────────
 *
 * A deep-partial `Edition` would let VR change any number, which sounds more
 * powerful and is the trap: two presets to art-direct, two to screenshot, and
 * every future field silently acquiring a second value nobody set. This can do
 * ONE thing — turn a feature off — so the VR look is always a SUBSET of the
 * flat one and "what does VR look like" is answerable by reading a list.
 *
 * Each string is a key of `editionFeatures()`, which is the registry the
 * validator already walks. That is deliberate: a path that is not a feature is
 * refused at load, so a typo cannot quietly disable nothing.
 */
export interface EditionVrOverrides {
  /**
   * `editionFeatures()` paths to force `enabled: false` while presenting.
   *
   * Disabling something already off is allowed and is a no-op — Classic may
   * name the same paths without the file having to know which are on.
   */
  readonly disable: readonly string[]
}

export class EditionSchemaError extends Error {
  constructor(id: string, detail: string) {
    super(`Edition "${id}": ${detail}`)
    this.name = 'EditionSchemaError'
  }
}

const isFeature = (f: unknown): f is EditionFeature =>
  typeof f === 'object' && f !== null && typeof (f as EditionFeature).enabled === 'boolean'

/** `n & (n - 1)` is zero for exactly the powers of two, and for zero. */
const isPowerOfTwo = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0

/**
 * The runtime check, on the shape the code actually reads.
 *
 * Not the schema — that is the content test's job, and it runs over the files
 * in git. This runs over whatever `import.meta.glob` handed back, and it exists
 * so a preset with a hand-edited hole fails at load with a name in the message
 * rather than at frame 400 with `undefined.enabled`.
 */
export const validateEdition = (edition: Edition): Edition => {
  const id = edition?.id ?? '<unnamed>'
  if (!(EDITION_IDS as readonly string[]).includes(id)) {
    throw new EditionSchemaError(id, `id is not one of ${EDITION_IDS.join(', ')}`)
  }
  if (typeof edition.title !== 'string' || !edition.title) {
    throw new EditionSchemaError(id, 'missing title')
  }
  const r = edition.render
  if (!r || !(TONE_MAPPINGS as readonly string[]).includes(r.toneMapping)) {
    throw new EditionSchemaError(id, `render.toneMapping is not one of ${TONE_MAPPINGS.join(', ')}`)
  }
  if (typeof r.exposure !== 'number' || !(r.exposure > 0)) {
    throw new EditionSchemaError(id, 'render.exposure must be a positive number')
  }
  const features: readonly [string, unknown][] = [
    ['render.haze', r.haze],
    ['render.illustrative', r.illustrative],
    ['render.shadows', r.shadows],
    ['render.shipShadow', r.shipShadow],
    ['render.cockpitShadow', r.cockpitShadow],
    ['render.cockpitSelfShadow', r.cockpitSelfShadow],
    ['render.nearShadow', r.nearShadow],
    ['render.smoothSky', r.smoothSky],
    ['render.sunHeight', r.sunHeight],
    ['render.cloudShadow', r.cloudShadow],
    ['render.canopyShade', r.canopyShade],
    ['render.skyVisibility', r.skyVisibility],
    ['render.horizonGeo', r.horizonGeo],
    ['render.coast', r.coast],
    ['render.seaReflection', r.seaReflection],
    ['render.flatFov', r.flatFov],
    ['render.clouds', r.clouds],
    ['render.bloom', r.bloom],
    ['render.thirdPerson', r.thirdPerson],
    ['render.racerLivery', r.racerLivery],
    ['render.racerLivery.shadow', r.racerLivery?.shadow],
    ['render.sceneTint', r.sceneTint],
    ['fx.speedLines', edition.fx?.speedLines],
    ['fx.speedRamp', edition.fx?.speedRamp],
    ['fx.wingTrails', edition.fx?.wingTrails],
    ['fx.motes', edition.fx?.motes],
    ['fx.waterSpray', edition.fx?.waterSpray],
    ['fx.propBurst', edition.fx?.propBurst],
    ['fx.splash', edition.fx?.splash],
    ['menu.holoTerrainColours', edition.menu?.holoTerrainColours],
    ['menu.medalOutline', edition.menu?.medalOutline],
    ['cockpit.shake', edition.cockpit?.shake],
    ['cockpit.lighting', edition.cockpit?.lighting],
    ['cockpit.body', edition.cockpit?.body],
    ['audio.speedCurves', edition.audio?.speedCurves],
    ['audio.engine.rumble', edition.audio?.engine?.rumble],
    ['audio.engine.pitchTracking', edition.audio?.engine?.pitchTracking],
    ['audio.lift', edition.audio?.lift],
    ['terrain.detailRing', edition.terrain?.detailRing],
    ['terrain.lodFade', edition.terrain?.lodFade],
    ['terrain.diagonalFix', edition.terrain?.diagonalFix],
    ['terrain.surfaceGloss', edition.terrain?.surfaceGloss],
    ['terrain.bakedLight', edition.terrain?.bakedLight],
    ['terrain.oceanRings', edition.terrain?.oceanRings],
    ['props', edition.props],
    ['props.birds', edition.props?.birds],
    ['props.unbakedPasses', edition.props?.unbakedPasses],
    ['props.groundSnap', edition.props?.groundSnap],
    ['props.scatterShadows', edition.props?.scatterShadows],
    ['props.meshLod', edition.props?.meshLod],
    ['props.maxSlope', edition.props?.maxSlope],
    ['gameplay.proximity', edition.gameplay?.proximity],
    ['gameplay.gateEvents', edition.gameplay?.gateEvents],
    ['gameplay.chainMeter', edition.gameplay?.chainMeter],
    ['gameplay.gateBullseye', edition.gameplay?.gateBullseye],
    ['boundary.fuzz', edition.boundary?.fuzz],
    ['gates.passedFade', edition.gates?.passedFade],
    ['gates.finishBanner', edition.gates?.finishBanner],
    ['hud.nextGateArrow', edition.hud?.nextGateArrow],
    ['hud.raceMap', edition.hud?.raceMap],
    ['hud.bars', edition.hud?.bars],
    ['gameplay.racers', edition.gameplay?.racers],
    ['gameplay.racers.separation', edition.gameplay?.racers?.separation],
    ['gameplay.racers.contact', edition.gameplay?.racers?.contact],
    ['gameplay.racers.hit', edition.gameplay?.racers?.hit],
    ['gameplay.crash', edition.gameplay?.crash],
    ['gameplay.propCollision', edition.gameplay?.propCollision],
    ['gameplay.propCollision.strike', edition.gameplay?.propCollision?.strike],
    ['gameplay.energy', edition.gameplay?.energy],
    ['gameplay.energyRace', edition.gameplay?.energyRace],
    ['gameplay.ambientTraffic', edition.gameplay?.ambientTraffic],
    ['gameplay.variants', edition.gameplay?.variants],
    ['gameplay.glider', edition.gameplay?.glider],
    ['gameplay.rooms', edition.gameplay?.rooms],
    ['gameplay.editor', edition.gameplay?.editor],
    ['gameplay.tv', edition.gameplay?.tv],
    ['gameplay.tv.headsetCuts', edition.gameplay?.tv?.headsetCuts],
    ['life.boats', edition.life?.boats],
    ['life.dolphins', edition.life?.dolphins],
  ]
  for (const [path, f] of features) {
    if (!isFeature(f)) throw new EditionSchemaError(id, `missing ${path}.enabled`)
  }
  // ── DEV-263: the VR override list, checked against the REGISTRY ──────────
  //
  // A path that is not a feature is refused here rather than ignored at run
  // time, because the failure mode of ignoring it is the worst kind: the
  // headset renders the expensive thing, the file says it does not, and the
  // only symptom is a frame rate. `editionFeatures` is the same registry the
  // loop above walks, so there is one list of what a feature IS.
  const vr = edition.vr
  if (vr !== undefined) {
    if (!Array.isArray(vr.disable)) {
      throw new EditionSchemaError(id, 'vr.disable must be an array of feature paths')
    }
    const known = new Set(features.map(([path]) => path))
    for (const path of vr.disable) {
      if (typeof path !== 'string' || !known.has(path)) {
        throw new EditionSchemaError(
          id,
          `vr.disable names "${String(path)}", which is not one of editionFeatures()`,
        )
      }
    }
    if (new Set(vr.disable).size !== vr.disable.length) {
      throw new EditionSchemaError(id, 'vr.disable repeats a path')
    }
  }
  // The shake's own numbers, because a hole in them is not `undefined.enabled`
  // at frame 400 — it is a silent NaN that propagates into `art_pivot.position`
  // and takes the entire cockpit out of the frustum. `fullSpeed <= startSpeed`
  // is the one that divides by zero.
  const shake = edition.cockpit.shake
  for (const key of ['startSpeed', 'fullSpeed', 'amplitude', 'angle'] as const) {
    if (!Number.isFinite(shake[key])) {
      throw new EditionSchemaError(id, `cockpit.shake.${key} must be a finite number`)
    }
  }
  if (!(shake.fullSpeed > shake.startSpeed)) {
    throw new EditionSchemaError(id, 'cockpit.shake.fullSpeed must exceed startSpeed')
  }
  for (const key of ['stageGain', 'frequency'] as const) {
    const a = shake[key]
    if (!Array.isArray(a) || a.length === 0 || a.some((n) => !Number.isFinite(n))) {
      throw new EditionSchemaError(id, `cockpit.shake.${key} must be a non-empty array of numbers`)
    }
  }
  // DEV-426: the throttle curve's weights multiply the buffet, so a hole is the
  // same NaN in `art_pivot`, and a negative one turns the buffet inside out.
  if (shake.throttle !== undefined) {
    for (const key of ['fullThrottle', 'boost', 'topSpeed'] as const) {
      const w = shake.throttle[key]
      if (!Number.isFinite(w) || w < 0) {
        throw new EditionSchemaError(
          id,
          `cockpit.shake.throttle.${key} must be a number, 0 or more`,
        )
      }
    }
  }
  if (!(SPEED_UNITS as readonly string[]).includes(edition.hud?.speedUnit)) {
    throw new EditionSchemaError(id, `hud.speedUnit is not one of ${SPEED_UNITS.join(', ')}`)
  }
  // The haze's tuning, because a hole in it is not a hole you can see: a
  // missing `range` packs as a NaN reciprocal, every fragment multiplies by it,
  // and the terrain renders BLACK with no error anywhere. DEV-082.
  const h = r.haze
  for (const key of ['startDistance', 'range', 'strength', 'desaturate'] as const) {
    if (typeof h[key] !== 'number' || !Number.isFinite(h[key])) {
      throw new EditionSchemaError(id, `render.haze.${key} must be a finite number`)
    }
  }
  if (!(h.range > 0)) throw new EditionSchemaError(id, 'render.haze.range must be greater than 0')
  if (!Array.isArray(h.tint) || h.tint.length !== 3 || h.tint.some((c) => !Number.isFinite(c))) {
    throw new EditionSchemaError(id, 'render.haze.tint must be three finite numbers (sRGB 0..1)')
  }
  // The warp's ramp, and the failure mode is the same shape as the haze's: a
  // hole in a stop reaches `Color.setRGB` as `undefined`, three writes NaN into
  // the uniform, and every LAND fragment multiplies its diffuse by it — so the
  // island renders BLACK on a preset whose flag is on, with nothing thrown
  // anywhere. `strength` is the one that has to be checked even on Classic,
  // because 0 is what makes the whole term the identity. DEV-092.
  const w = r.illustrative
  for (const key of ['overbright', 'strength'] as const) {
    if (typeof w[key] !== 'number' || !Number.isFinite(w[key])) {
      throw new EditionSchemaError(id, `render.illustrative.${key} must be a finite number`)
    }
  }
  if (w.strength < 0 || w.strength > 1) {
    throw new EditionSchemaError(id, 'render.illustrative.strength must be between 0 and 1')
  }
  if (w.overbright < 0) {
    throw new EditionSchemaError(id, 'render.illustrative.overbright must be zero or above')
  }
  for (const key of ['shadow', 'terminator', 'lit'] as const) {
    const c = w[key]
    if (!Array.isArray(c) || c.length !== 3 || c.some((n) => !Number.isFinite(n) || n < 0)) {
      throw new EditionSchemaError(
        id,
        `render.illustrative.${key} must be three finite non-negative numbers (LINEAR rgb)`,
      )
    }
  }
  // The shadow box, because two of these fail SILENTLY and one fails loudly in
  // the wrong place. A `mapSize` that is not a power of two is accepted by
  // WebGL2 and quietly costs the mip chain; a `boxHalfSize` of 0 divides into a
  // texel size of 0 and snaps every frame to the same point, which renders one
  // texel of shadow over the whole world; and a hole in `bias` is a NaN that
  // reaches `shadow.bias` and takes the depth compare with it. DEV-086.
  const sh = r.shadows
  if (!isPowerOfTwo(sh.mapSize) || sh.mapSize < 256 || sh.mapSize > 4096) {
    throw new EditionSchemaError(
      id,
      `render.shadows.mapSize must be a power of two from 256 to 4096, not ${String(sh.mapSize)}`,
    )
  }
  if (!(sh.boxHalfSize > 0)) {
    throw new EditionSchemaError(id, 'render.shadows.boxHalfSize must be greater than 0')
  }
  for (const key of ['castDistance', 'bias', 'normalBias', 'radius'] as const) {
    if (!Number.isFinite(sh[key]) || sh[key] < 0) {
      throw new EditionSchemaError(
        id,
        `render.shadows.${key} must be a finite number, zero or above`,
      )
    }
  }
  // DEV-453. A band as wide as the box would fade the map out at the camera
  // itself, and a hole here is a NaN in every lit fragment's shadow lookup.
  if (!Number.isFinite(sh.edgeFade) || sh.edgeFade < 0 || sh.edgeFade >= sh.boxHalfSize) {
    throw new EditionSchemaError(
      id,
      `render.shadows.edgeFade must be a finite number from 0 up to (not including) boxHalfSize, not ${String(sh.edgeFade)}`,
    )
  }
  // The near map's, for the same two silent failures (DEV-323): a mapSize that
  // is not a power of two, and a hole in a bias that reaches a uniform as NaN
  // and takes every lit fragment of the cockpit with it.
  const near = r.cockpitSelfShadow
  if (!isPowerOfTwo(near.mapSize) || near.mapSize < 256 || near.mapSize > 4096) {
    throw new EditionSchemaError(
      id,
      `render.cockpitSelfShadow.mapSize must be a power of two from 256 to 4096, not ${String(near.mapSize)}`,
    )
  }
  for (const key of ['bias', 'normalBias', 'radius'] as const) {
    if (!Number.isFinite(near[key]) || near[key] < 0) {
      throw new EditionSchemaError(
        id,
        `render.cockpitSelfShadow.${key} must be a finite number, zero or above`,
      )
    }
  }
  // DEV-582's near cascade: the same two silent failures as the cockpit's map,
  // and an edge band as wide as the box, which would fade the whole map out.
  const nearCascade = r.nearShadow
  if (
    !isPowerOfTwo(nearCascade?.mapSize) ||
    nearCascade.mapSize < 256 ||
    nearCascade.mapSize > 4096
  ) {
    throw new EditionSchemaError(
      id,
      `render.nearShadow.mapSize must be a power of two from 256 to 4096, not ${String(nearCascade?.mapSize)}`,
    )
  }
  if (!Number.isFinite(nearCascade.boxHalfSize) || !(nearCascade.boxHalfSize > 0)) {
    throw new EditionSchemaError(id, 'render.nearShadow.boxHalfSize must be a positive number')
  }
  if (
    !Number.isFinite(nearCascade.edgeFade) ||
    nearCascade.edgeFade < 0 ||
    nearCascade.edgeFade >= nearCascade.boxHalfSize
  ) {
    throw new EditionSchemaError(
      id,
      'render.nearShadow.edgeFade must be a finite number from 0 up to (not including) boxHalfSize',
    )
  }
  for (const key of ['bias', 'normalBias', 'radius'] as const) {
    if (!Number.isFinite(nearCascade[key]) || nearCascade[key] < 0) {
      throw new EditionSchemaError(
        id,
        `render.nearShadow.${key} must be a finite number, zero or above`,
      )
    }
  }
  // The far-field term's one number is a smoothstep WIDTH: zero is a hard
  // step (legal, ugly), negative or non-finite is a NaN in every lit fragment.
  if (!Number.isFinite(r.sunHeight.softMetres) || r.sunHeight.softMetres < 0) {
    throw new EditionSchemaError(
      id,
      'render.sunHeight.softMetres must be a finite number, zero or above',
    )
  }
  // DEV-585's two. `strength` multiplies the sun's occlusion and must stay in
  // 0..1 or a cloud's shadow is brighter than the open field; the elevation is
  // a fade's lower end, and a NaN there is a NaN in every lit fragment.
  const cloudShadow = r.cloudShadow
  if (
    !Number.isFinite(cloudShadow?.strength) ||
    cloudShadow.strength < 0 ||
    cloudShadow.strength > 1
  ) {
    throw new EditionSchemaError(id, 'render.cloudShadow.strength must be a number in 0..1')
  }
  if (
    !Number.isFinite(cloudShadow.minSunElevation) ||
    cloudShadow.minSunElevation < 0 ||
    cloudShadow.minSunElevation >= 45
  ) {
    throw new EditionSchemaError(
      id,
      'render.cloudShadow.minSunElevation must be degrees, from 0 up to (not including) 45',
    )
  }
  // DEV-583's one. A fraction of the drawing buffer: 0 is a zero-sized target
  // (three throws), above 1 is a mirror larger than the frame it is read into.
  const seaReflection = r.seaReflection
  if (
    !Number.isFinite(seaReflection?.resolutionScale) ||
    !(seaReflection.resolutionScale > 0) ||
    seaReflection.resolutionScale > 1
  ) {
    throw new EditionSchemaError(
      id,
      'render.seaReflection.resolutionScale must be a fraction of the frame, above 0 and at most 1',
    )
  }
  // The canopy term's three. `strength` is a MULTIPLIER on light and has to
  // stay in 0..1 or a forest floor is brighter than a field or is negative;
  // `saturation` divides, so zero is an infinity in every ground fragment;
  // `radiusScale` negative would make every canopy radius negative and the
  // sweep silently write nothing, which is the failure that looks like the
  // feature being off.
  const canopy = r.canopyShade
  if (!Number.isFinite(canopy.strength) || canopy.strength < 0 || canopy.strength > 1) {
    throw new EditionSchemaError(id, 'render.canopyShade.strength must be a number in 0..1')
  }
  if (!Number.isFinite(canopy.saturation) || canopy.saturation <= 0) {
    throw new EditionSchemaError(id, 'render.canopyShade.saturation must be a positive number')
  }
  if (!Number.isFinite(canopy.radiusScale) || canopy.radiusScale < 0) {
    throw new EditionSchemaError(
      id,
      'render.canopyShade.radiusScale must be a finite number, zero or above',
    )
  }
  // DEV-336's four. Radii and brightnesses: zero is "none", negative or NaN
  // is a shader reading garbage in every halo fragment.
  for (const key of ['studRadius', 'studIntensity', 'sunAngleDeg', 'sunIntensity'] as const) {
    const v = r.bloom.vrHalo?.[key]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new EditionSchemaError(
        id,
        `render.bloom.vrHalo.${key} must be a finite number, zero or above`,
      )
    }
  }
  // DEV-333's two. `sky` mixes toward V and above 1 would push light negative;
  // `bounce` ADDS light, so it may exceed 1 but never go negative or NaN.
  const skyVis = r.skyVisibility
  if (!Number.isFinite(skyVis.sky) || skyVis.sky < 0 || skyVis.sky > 1) {
    throw new EditionSchemaError(id, 'render.skyVisibility.sky must be a number in 0..1')
  }
  if (!Number.isFinite(skyVis.bounce) || skyVis.bounce < 0) {
    throw new EditionSchemaError(
      id,
      'render.skyVisibility.bounce must be a finite number, zero or above',
    )
  }
  // The holotable's projection tell: four multipliers, none of which may be a
  // NaN in a vertex colour or a negative rim that darkens instead of lifting.
  const holo = edition.menu.holoTerrainColours
  for (const key of ['brightness', 'holoMix', 'rim', 'scanline'] as const) {
    if (!Number.isFinite(holo[key]) || holo[key] < 0) {
      throw new EditionSchemaError(
        id,
        `menu.holoTerrainColours.${key} must be a finite number, zero or above`,
      )
    }
  }
  if (holo.holoMix > 1 || holo.scanline > 1) {
    throw new EditionSchemaError(id, 'menu.holoTerrainColours.holoMix and .scanline are 0..1')
  }
  // The medal's silhouette shell (DEV-151). A negative width turns the hull
  // inside out and hides the medal instead of framing it; a width over a
  // quarter of the emblem swallows it; an opacity outside 0..1 is not a blend.
  const outline = edition.menu.medalOutline
  if (!Number.isFinite(outline.widthFraction) || outline.widthFraction < 0) {
    throw new EditionSchemaError(
      id,
      'menu.medalOutline.widthFraction must be a finite number, zero or above',
    )
  }
  if (outline.widthFraction > 0.25) {
    throw new EditionSchemaError(
      id,
      'menu.medalOutline.widthFraction above 0.25 swallows the emblem',
    )
  }
  if (!Number.isFinite(outline.opacity) || outline.opacity < 0 || outline.opacity > 1) {
    throw new EditionSchemaError(id, 'menu.medalOutline.opacity is 0..1')
  }
  if (
    !Array.isArray(outline.colour) ||
    outline.colour.length !== 3 ||
    outline.colour.some((c) => !Number.isFinite(c) || c < 0 || c > 1)
  ) {
    throw new EditionSchemaError(id, 'menu.medalOutline.colour is three numbers in 0..1')
  }
  // The far shore's three numbers. A radius of zero puts every card at the
  // eye; a negative height inverts the cut; a silhouette outside 0..1 is a
  // colour brighter than the sky it is cut from, or a negative one.
  const hg = r.horizonGeo
  if (!Number.isFinite(hg.radius) || !(hg.radius > 0)) {
    throw new EditionSchemaError(id, 'render.horizonGeo.radius must be a positive finite number')
  }
  if (!Number.isFinite(hg.peakMetres) || hg.peakMetres < 0) {
    throw new EditionSchemaError(
      id,
      'render.horizonGeo.peakMetres must be a finite number, zero or above',
    )
  }
  if (!Number.isFinite(hg.silhouette) || hg.silhouette < 0 || hg.silhouette > 1) {
    throw new EditionSchemaError(id, 'render.horizonGeo.silhouette must be within 0..1')
  }
  // The shore's tuning, and the same reasoning as the haze's: the two depths are
  // DIVISORS — `coastPack` takes their reciprocals — and a missing one packs as
  // an infinity that every water fragment multiplies a depth by, which paints
  // the whole sea the shallow colour out to the horizon with nothing erroring.
  const co = r.coast
  for (const key of [
    'shallowDepth',
    'shallowStrength',
    'foamDepth',
    'foamStrength',
    'foamBreakup',
  ] as const) {
    if (typeof co[key] !== 'number' || !Number.isFinite(co[key])) {
      throw new EditionSchemaError(id, `render.coast.${key} must be a finite number`)
    }
  }
  for (const key of ['shallowDepth', 'foamDepth'] as const) {
    if (!(co[key] > 0)) {
      throw new EditionSchemaError(id, `render.coast.${key} must be greater than 0`)
    }
  }
  for (const key of ['shallowColor', 'foamColor'] as const) {
    const c = co[key]
    if (!Array.isArray(c) || c.length !== 3 || c.some((n) => !Number.isFinite(n))) {
      throw new EditionSchemaError(
        id,
        `render.coast.${key} must be three finite numbers (sRGB 0..1)`,
      )
    }
  }
  validateFlatFov(id, r.flatFov)
  validateThirdPerson(id, r.thirdPerson)
  validateRacerLivery(id, r.racerLivery)
  validateSceneTint(id, r.sceneTint)
  // The cloud block, and the same reasoning as every other one here: only the
  // holes that fail SILENTLY are worth a named throw. A missing `wrap` or
  // `rimStrength` is a NaN in a `clamp`, which GLSL is free to resolve either
  // way — so the cloud comes out either exactly as Classic drew it or
  // full-strength white, and neither errors. A `rimPower` of zero is the one
  // that looks like a feature: `x^0` is 1, so the "rim" covers the whole body
  // at full strength and reads as a cloud somebody turned into a light.
  // A negative `scaleMultiplier` mirrors every cloud through its own centre,
  // which on a closed mesh is inside-out triangles rather than a look. DEV-090.
  const cl = r.clouds
  for (const key of [
    'wrap',
    'rimStrength',
    'rimPower',
    'sunTint',
    'emissive',
    'scaleMultiplier',
    'altitudeLift',
    'driftSpeed',
  ] as const) {
    if (typeof cl[key] !== 'number' || !Number.isFinite(cl[key])) {
      throw new EditionSchemaError(id, `render.clouds.${key} must be a finite number`)
    }
  }
  if (!(cl.rimPower > 0)) {
    throw new EditionSchemaError(id, 'render.clouds.rimPower must be greater than 0')
  }
  if (!(cl.scaleMultiplier > 0)) {
    throw new EditionSchemaError(id, 'render.clouds.scaleMultiplier must be greater than 0')
  }
  for (const key of ['wrap', 'rimStrength', 'sunTint', 'emissive', 'driftSpeed'] as const) {
    if (cl[key] < 0) {
      throw new EditionSchemaError(id, `render.clouds.${key} must be zero or above`)
    }
  }
  triple(id, 'render.clouds.driftDirection', cl.driftDirection)
  // The pool (DEV-785). A missing or fractional `poolSize` reaches the plan as a
  // NaN or a half member and silently builds the wrong sky; a `tintSpread`
  // above 1 can multiply a cloud's albedo past zero into a black one.
  if (!Number.isInteger(cl.poolSize) || cl.poolSize < 1) {
    throw new EditionSchemaError(id, 'render.clouds.poolSize must be a whole number, 1 or more')
  }
  if (!Number.isFinite(cl.tintSpread) || cl.tintSpread < 0 || cl.tintSpread > 1) {
    throw new EditionSchemaError(id, 'render.clouds.tintSpread must be a number in 0..1')
  }
  // The bloom's four numbers, and the same test as everywhere above: which holes
  // fail SILENTLY? A missing `threshold` reaches `smoothstep(undefined,
  // undefined + 0.01, v)` as a NaN, and a NaN alpha in the high pass is a BLACK
  // bloom buffer added to the frame — i.e. nothing happens and the row looks
  // unimplemented. A `resolutionScale` of 0 sizes the mip chain at `max(2, 0)`
  // and glows two texels over the whole screen. A `radius` above 1 walks
  // `lerpBloomFactor`'s mix past its own endpoints and the wide mips go NEGATIVE,
  // which subtracts light from a bloom. DEV-091.
  const bl = r.bloom
  for (const key of ['threshold', 'strength', 'radius', 'resolutionScale'] as const) {
    if (typeof bl[key] !== 'number' || !Number.isFinite(bl[key])) {
      throw new EditionSchemaError(id, `render.bloom.${key} must be a finite number`)
    }
  }
  for (const key of ['threshold', 'strength'] as const) {
    if (bl[key] < 0) {
      throw new EditionSchemaError(id, `render.bloom.${key} must not be negative`)
    }
  }
  if (bl.radius < 0 || bl.radius > 1) {
    throw new EditionSchemaError(id, 'render.bloom.radius must be between 0 and 1')
  }
  if (!(bl.resolutionScale > 0) || bl.resolutionScale > 1) {
    throw new EditionSchemaError(id, 'render.bloom.resolutionScale must be above 0 and at most 1')
  }
  validateCockpitInterior(id, edition.cockpit)
  validateSpeedCurves(id, edition.audio.speedCurves)
  validateEngineSound(id, edition.audio.engine)
  validateLiftSound(id, edition.audio.lift)
  // The two tuning blocks that can fail SILENTLY. A hole in the speed-line
  // numbers renders 2016's hairline and a hole in the mote shell renders
  // nothing at all, and neither one throws — which is the whole reason this
  // function exists (a preset with a hand-edited hole should name the key, not
  // wait for frame 400).
  const lines = edition.fx.speedLines
  for (const key of ['widthScale', 'alphaScale', 'coreDarkness', 'tubeLift'] as const) {
    if (!Number.isFinite(lines[key])) {
      throw new EditionSchemaError(id, `fx.speedLines.${key} must be a number`)
    }
  }
  // A negative lift buries the tube further under the seat, which is a
  // preset that quietly does the opposite of what the key is for.
  if (lines.tubeLift < 0) {
    throw new EditionSchemaError(id, 'fx.speedLines.tubeLift must be zero or above')
  }
  if (typeof lines.softEdge !== 'boolean') {
    throw new EditionSchemaError(id, 'fx.speedLines.softEdge must be a boolean')
  }
  // DEV-351. A hole here would not throw anywhere else: `speedLineDrives`
  // clamps, so a missing floor renders a ramp that starts invisible and nobody
  // is told why.
  const ramp = edition.fx.speedRamp
  if (!Number.isFinite(ramp.onsetSpeed) || ramp.onsetSpeed < 0) {
    throw new EditionSchemaError(id, 'fx.speedRamp.onsetSpeed must be zero or above')
  }
  for (const key of ['alphaFloor', 'speedFloor'] as const) {
    if (!Number.isFinite(ramp[key]) || ramp[key] < 0 || ramp[key] > 1) {
      throw new EditionSchemaError(id, `fx.speedRamp.${key} must be between 0 and 1`)
    }
  }
  // DEV-358. `render/wing-trails.ts` clamps and divides by these, so a hole
  // renders an invisible trail or none, and nothing else would say which key.
  const wing = edition.fx.wingTrails
  for (const key of ['seconds', 'minVertexDistance'] as const) {
    if (!Number.isFinite(wing[key]) || !(wing[key] > 0)) {
      throw new EditionSchemaError(id, `fx.wingTrails.${key} must be above zero`)
    }
  }
  for (const key of ['startWidth', 'endWidth', 'nearFade', 'glow', 'maxWidthDeg'] as const) {
    if (!Number.isFinite(wing[key]) || wing[key] < 0) {
      throw new EditionSchemaError(id, `fx.wingTrails.${key} must be zero or above`)
    }
  }
  for (const key of ['alpha', 'tint', 'core', 'halo'] as const) {
    if (!Number.isFinite(wing[key]) || wing[key] < 0 || wing[key] > 1) {
      throw new EditionSchemaError(id, `fx.wingTrails.${key} must be between 0 and 1`)
    }
  }
  if (typeof wing.fromCockpit !== 'boolean') {
    throw new EditionSchemaError(id, 'fx.wingTrails.fromCockpit must be a boolean')
  }
  const motes = edition.fx.motes
  for (const key of [
    'count',
    'innerRadius',
    'outerRadius',
    'size',
    'stretchSeconds',
    'alpha',
    'minSpeed',
    'fullSpeed',
    'aheadBias',
  ] as const) {
    if (!Number.isFinite(motes[key])) {
      throw new EditionSchemaError(id, `fx.motes.${key} must be a number`)
    }
  }
  // An inverted shell is the silent one: every spawn lands outside it and every
  // mote respawns on the frame it was born, forever, drawing nothing.
  if (!(motes.innerRadius < motes.outerRadius)) {
    throw new EditionSchemaError(id, 'fx.motes.innerRadius must be below outerRadius')
  }
  for (const key of ['colorLight', 'colorDark'] as const) {
    const c = motes[key]
    if (!Array.isArray(c) || c.length !== 3 || !c.every((v) => Number.isFinite(v))) {
      throw new EditionSchemaError(id, `fx.motes.${key} must be three linear RGB numbers`)
    }
  }
  // DEV-429. `sprayStrength` divides by the height and by the speed band, so a
  // zero there is a NaN rate — no spray, and nothing to say why.
  const spray = edition.fx.waterSpray
  for (const key of [
    'heightMetres',
    'minSpeed',
    'fullSpeed',
    'rate',
    'carry',
    'lift',
    'angleDeg',
    'radius',
    'lifetime',
    'size',
    'gravity',
    'drag',
    'shade',
  ] as const) {
    if (!Number.isFinite(spray[key]) || spray[key] < 0) {
      throw new EditionSchemaError(id, `fx.waterSpray.${key} must be a non-negative number`)
    }
  }
  if (!(spray.heightMetres > 0) || !(spray.lifetime > 0) || !(spray.size > 0)) {
    throw new EditionSchemaError(
      id,
      'fx.waterSpray.heightMetres, lifetime and size must be above zero',
    )
  }
  if (!(spray.fullSpeed > spray.minSpeed)) {
    throw new EditionSchemaError(id, 'fx.waterSpray.fullSpeed must be above minSpeed')
  }
  if (spray.carry > 1 || spray.angleDeg >= 90) {
    throw new EditionSchemaError(
      id,
      'fx.waterSpray.carry must be 0..1 and angleDeg below 90 (a cone that opens past flat throws spray into the sea)',
    )
  }
  if (
    !Array.isArray(spray.colour) ||
    spray.colour.length !== 3 ||
    !spray.colour.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)
  ) {
    throw new EditionSchemaError(id, 'fx.waterSpray.colour must be three sRGB numbers, 0..1')
  }
  // DEV-428. `propStrikeSpec` builds a particle spec from these, and a hole
  // there draws nothing at all: a count of 0 is a burst of nobody, a NaN size
  // is an invisible one, and neither says which key.
  const burst = edition.fx.propBurst
  for (const key of [
    'count',
    'carry',
    'spread',
    'radius',
    'lifetime',
    'size',
    'gravity',
    'drag',
    'shade',
    'colourBand',
    'maxMetres',
  ] as const) {
    if (!Number.isFinite(burst[key]) || burst[key] < 0) {
      throw new EditionSchemaError(id, `fx.propBurst.${key} must be a non-negative number`)
    }
  }
  if (!Number.isInteger(burst.count) || burst.count < 1) {
    throw new EditionSchemaError(
      id,
      'gameplay.propCollision.burst.count must be a whole number of 1 or more',
    )
  }
  for (const key of ['carry', 'colourBand'] as const) {
    if (burst[key] > 1) {
      throw new EditionSchemaError(id, `fx.propBurst.${key} must be 0..1`)
    }
  }
  if (!(burst.lifetime > 0) || !(burst.size > 0)) {
    throw new EditionSchemaError(
      id,
      'gameplay.propCollision.burst.lifetime and size must be above zero',
    )
  }
  validateSplash(id, edition.fx.splash)
  validateGatePulse(id, edition.fx.gatePulse)
  validateBoundaryFuzz(id, edition.boundary.fuzz)
  validateGameplay(id, edition.gameplay)
  validateDetailRing(id, edition.terrain.detailRing)
  validateLodFade(id, edition.terrain.lodFade)
  validateBakedLight(id, edition.terrain.bakedLight)
  validateSurfaceGloss(id, edition.terrain.surfaceGloss)
  validateOcean(id, edition.terrain.ocean)
  validateOceanRings(id, edition.terrain.oceanRings)
  validateProps(id, edition.props)
  validateGates(id, edition.gates)
  validateNextGateArrow(id, edition.hud.nextGateArrow)
  validateRaceMap(id, edition.hud.raceMap)
  validateLife(id, edition.life)
  return edition
}

/** Three finite numbers, or the named key is refused. */
const requireRgb = (id: string, where: string, c: unknown): void => {
  if (!Array.isArray(c) || c.length !== 3 || !c.every((v) => Number.isFinite(v))) {
    throw new EditionSchemaError(id, `${where} must be three linear RGB numbers`)
  }
}

/**
 * The gates block (DEV-122, DEV-123). A negative delay would hide a gate
 * before it was passed; a `gap` of 1 leaves no cell at all; a `columns` that
 * is not whole cannot alternate.
 */
const validateGates = (id: string, gates: EditionGates): void => {
  const fade = gates.passedFade
  for (const key of ['delaySeconds', 'seconds'] as const) {
    if (!Number.isFinite(fade[key]) || fade[key] < 0) {
      throw new EditionSchemaError(
        id,
        `gates.passedFade.${key} must be a number of seconds, 0 or above`,
      )
    }
  }
  const banner = gates.finishBanner
  for (const key of ['columns', 'rows'] as const) {
    if (!Number.isInteger(banner[key]) || banner[key] < 1) {
      throw new EditionSchemaError(
        id,
        `gates.finishBanner.${key} must be a whole number of 1 or more`,
      )
    }
  }
  if (banner.columns < 2) {
    throw new EditionSchemaError(id, 'gates.finishBanner.columns must be 2 or more to alternate')
  }
  for (const key of ['cellMetres', 'lift', 'emissive', 'gap'] as const) {
    if (!Number.isFinite(banner[key]) || banner[key] < 0) {
      throw new EditionSchemaError(id, `gates.finishBanner.${key} must be a number, 0 or above`)
    }
  }
  if (!(banner.cellMetres > 0)) {
    throw new EditionSchemaError(id, 'gates.finishBanner.cellMetres must be above zero')
  }
  if (!(banner.gap < 1)) {
    throw new EditionSchemaError(id, 'gates.finishBanner.gap must be below 1, or there is no cell')
  }
  requireRgb(id, 'gates.finishBanner.light', banner.light)
  requireRgb(id, 'gates.finishBanner.dark', banner.dark)
}

/**
 * The arrow (DEV-124). A cone of 90 or more would never show it; a cone of 0
 * would never hide it, which is the nag the flag exists to avoid.
 */
const validateNextGateArrow = (id: string, arrow: EditionNextGateArrow): void => {
  if (
    !Number.isFinite(arrow.coneDegrees) ||
    !(arrow.coneDegrees > 0) ||
    !(arrow.coneDegrees < 90)
  ) {
    throw new EditionSchemaError(id, 'hud.nextGateArrow.coneDegrees must be above 0 and below 90')
  }
  if (!Number.isFinite(arrow.featherDegrees) || arrow.featherDegrees < 0) {
    throw new EditionSchemaError(id, 'hud.nextGateArrow.featherDegrees must be 0 or above')
  }
  if (!Number.isFinite(arrow.lengthMetres) || !(arrow.lengthMetres > 0)) {
    throw new EditionSchemaError(id, 'hud.nextGateArrow.lengthMetres must be above zero')
  }
  if (!Number.isFinite(arrow.emissive) || arrow.emissive < 0) {
    throw new EditionSchemaError(id, 'hud.nextGateArrow.emissive must be 0 or above')
  }
  if (
    !Array.isArray(arrow.offset) ||
    arrow.offset.length !== 3 ||
    !arrow.offset.every((v) => Number.isFinite(v))
  ) {
    throw new EditionSchemaError(id, 'hud.nextGateArrow.offset must be three numbers of metres')
  }
  requireRgb(id, 'hud.nextGateArrow.color', arrow.color)
}

/**
 * The race map (DEV-361). Every size must be a real length: a zero-width plate
 * fits the course at scale zero and draws every dot on one point, which looks
 * like a map with nobody on it rather than like an error.
 */
const validateRaceMap = (id: string, map: EditionRaceMap): void => {
  for (const key of ['widthMetres', 'dotMetres', 'playerDotMetres'] as const) {
    if (!Number.isFinite(map[key]) || !(map[key] > 0)) {
      throw new EditionSchemaError(id, `hud.raceMap.${key} must be above zero`)
    }
  }
  if (!Number.isFinite(map.gapMetres) || map.gapMetres < 0) {
    throw new EditionSchemaError(id, 'hud.raceMap.gapMetres must be 0 or above')
  }
}

/**
 * DEV-183. The sea's density ladder, checked for the failures that do NOT
 * throw anywhere downstream.
 *
 * `subdivideFor` clamps, so a bad entry here is a silently different ocean
 * rather than an error: an empty list is the whole ladder missing and the
 * subdivision falls back to 1 — 2016's geometry, on a preset that asked for
 * eight — and a fractional or zero entry lands in `subdivideTriangleSoup`,
 * which allocates `Float32Array(triangles * n * n * 9)` and throws only if the
 * length happens not to be an integer.
 *
 * NOT checked here: that the list is DESCENDING. `[1, 8]` is a legal thing to
 * want to try — it is the measurement that says the near sea is not where the
 * vertices are going — and refusing it would be the schema having an opinion
 * about the answer rather than about the shape.
 */
const validateOcean = (id: string, ocean: EditionOcean): void => {
  const ladder = ocean?.subdivisionByLod
  if (!Array.isArray(ladder) || ladder.length === 0) {
    throw new EditionSchemaError(
      id,
      'terrain.ocean.subdivisionByLod must be a non-empty list of sub-quads per edge, one per LOD',
    )
  }
  for (const [lod, n] of ladder.entries()) {
    if (!Number.isInteger(n) || n < 1) {
      throw new EditionSchemaError(
        id,
        `terrain.ocean.subdivisionByLod[${lod}] must be a whole number of 1 or more — got ${n}. ` +
          '1 is the mesh the generator produced; higher splits each facet into n x n.',
      )
    }
  }
}

/**
 * DEV-339. The shape the rings need: an even window, a cell that is positive,
 * and a level count the plate's LOD ladder (six bands) can follow. Whether the
 * cell divides a given plate's parent quad is the loader's to check, because it
 * depends on the sheet.
 */
const validateOceanRings = (id: string, rings: EditionOceanRings): void => {
  if (!Number.isInteger(rings?.cells) || rings.cells < 4 || rings.cells % 2 !== 0) {
    throw new EditionSchemaError(
      id,
      'terrain.oceanRings.cells must be an even whole number of 4 or more (each window is snapped to its coarser neighbour)',
    )
  }
  if (!Number.isFinite(rings.innerCell) || rings.innerCell <= 0) {
    throw new EditionSchemaError(id, 'terrain.oceanRings.innerCell must be above zero')
  }
  if (typeof rings.faceNormals !== 'boolean') {
    throw new EditionSchemaError(id, 'terrain.oceanRings.faceNormals must be true or false')
  }
  if (!Number.isInteger(rings.levels) || rings.levels < 1 || rings.levels > 6) {
    throw new EditionSchemaError(id, 'terrain.oceanRings.levels must be a whole number from 1 to 6')
  }
}

/**
 * DEV-130. A negative or non-finite scale is a fade that never completes —
 * both meshes drawn for ever, every chunk, silently doubling the terrain.
 */
const validateLodFade = (id: string, fade: EditionLodFade): void => {
  if (!Number.isFinite(fade.durationScale) || fade.durationScale < 0) {
    throw new EditionSchemaError(id, 'terrain.lodFade.durationScale must be zero or above')
  }
}

/**
 * DEV-237. A rung outside the list is the quiet failure, not a loud one.
 *
 * `render/baked-light.ts` maps rung 1 to a `#define` and treats **every other
 * value as rung 3** — which is right at the shader (an unknown rung must not
 * invent a fourth picture) and wrong at the preset, where an unknown rung means
 * somebody meant something. Caught here, a typo is a refused edition; not
 * caught, it is a measurement arm that silently ran the other rung and a
 * millisecond nobody can attribute. That is DEV-232's own §10 lesson with the
 * numbers changed.
 */
const validateBakedLight = (id: string, baked: EditionBakedLight): void => {
  // Cast, because the JSON on disk is not the type: `rung` arrives as whatever
  // the file says and TypeScript would narrow this comparison to a tautology.
  if (!(BAKED_LIGHT_RUNGS as readonly unknown[]).includes(baked.rung)) {
    throw new EditionSchemaError(
      id,
      `terrain.bakedLight.rung must be one of ${BAKED_LIGHT_RUNGS.join(', ')} — got ` +
        `${String(baked.rung)}. 3 drops the shadow multiply with everything else (what ` +
        "DEV-232 measured); 1 keeps it and shadows the ambient with it; 'split' bakes the " +
        'two halves apart and shadows only the direct one (DEV-240). There is no rung 2 — ' +
        'see BAKED_LIGHT_RUNGS.',
    )
  }
}

/**
 * DEV-132. The failures here are the quiet ones: a swatch with two numbers
 * reads its third as 0 and pulls every dark facet into its class; a roughness
 * above 1 is clamped by three into "every class the same", which is exactly
 * the picture the feature exists to remove; more than sixteen swatches are
 * dropped off the end of the uniform table with no error.
 */
const validateSurfaceGloss = (id: string, gloss: EditionSurfaceGloss): void => {
  if (!Array.isArray(gloss.classes)) {
    throw new EditionSchemaError(id, 'terrain.surfaceGloss.classes must be an array')
  }
  let swatches = 0
  for (const c of gloss.classes) {
    if (typeof c.id !== 'string' || !c.id) {
      throw new EditionSchemaError(id, 'terrain.surfaceGloss: every class needs an id')
    }
    if (!Number.isFinite(c.roughness) || c.roughness < 0 || c.roughness > 1) {
      throw new EditionSchemaError(id, `terrain.surfaceGloss.${c.id}.roughness must be in 0..1`)
    }
    if (!Array.isArray(c.swatches) || c.swatches.length === 0) {
      throw new EditionSchemaError(id, `terrain.surfaceGloss.${c.id} needs at least one swatch`)
    }
    for (const s of c.swatches) {
      if (
        !Array.isArray(s) ||
        s.length !== 3 ||
        !s.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)
      ) {
        throw new EditionSchemaError(
          id,
          `terrain.surfaceGloss.${c.id}: a swatch is three colour-map values in 0..1`,
        )
      }
      swatches++
    }
  }
  if (swatches > SURFACE_GLOSS_SWATCH_MAX) {
    throw new EditionSchemaError(
      id,
      `terrain.surfaceGloss holds ${swatches} swatches; the shader's table is ${SURFACE_GLOSS_SWATCH_MAX}`,
    )
  }
}

/**
 * The uniform table's size, stated here rather than imported from
 * `render/terrain-surface.ts` because `src/content` imports no three — and
 * asserted equal to the render constant in `terrain-surface.test.ts`.
 */
export const SURFACE_GLOSS_SWATCH_MAX = 16

/**
 * The gameplay block (DEV-110). The checks that are not "is it a number" are
 * the ones whose failure is a silently WRONG SCORE rather than a crash.
 *
 * `nearMetres >= farMetres` inverts the ramp, so the meter reads full at
 * altitude and empty on the deck — a lever rewarding the exact opposite of what
 * §4.1 argues for, with nothing about the frame looking wrong.
 * `cleanCentredness` outside 0..1 makes every gate clean or none, which reads
 * as "the feature does not work" rather than as a bad number.
 */
const validateGameplay = (id: string, g: EditionGameplay): void => {
  const p = g.proximity
  for (const key of [
    'nearMetres',
    'farMetres',
    'maxBonus',
    'minSpeed',
    'attackSeconds',
    'releaseSeconds',
    'perSecond',
    'awardStep',
  ] as const) {
    if (!Number.isFinite(p[key])) {
      throw new EditionSchemaError(id, `gameplay.proximity.${key} must be a number`)
    }
  }
  if (!(p.nearMetres < p.farMetres)) {
    throw new EditionSchemaError(
      id,
      'gameplay.proximity.nearMetres must be BELOW farMetres — inverted, the meter ' +
        'reads full at altitude and empty on the deck',
    )
  }
  if (p.maxBonus < 0) {
    throw new EditionSchemaError(id, 'gameplay.proximity.maxBonus must not be negative')
  }
  // Both are rewards, and a lever that can PUNISH is a different design from the
  // one §4.1 argues for (`sim/proximity.ts` floors the arithmetic for the same
  // reason). A negative `awardStep` would additionally loop the announcer.
  if (p.perSecond < 0) {
    throw new EditionSchemaError(id, 'gameplay.proximity.perSecond must not be negative')
  }
  if (p.awardStep < 0) {
    throw new EditionSchemaError(id, 'gameplay.proximity.awardStep must not be negative')
  }
  const ev = g.gateEvents
  for (const key of [
    'cleanCentredness',
    'minSpeed',
    'nearMissMetres',
    'nearMissCooldown',
    'nearMissPoints',
  ] as const) {
    if (!Number.isFinite(ev[key])) {
      throw new EditionSchemaError(id, `gameplay.gateEvents.${key} must be a number`)
    }
  }
  if (!(ev.cleanCentredness >= 0 && ev.cleanCentredness <= 1)) {
    throw new EditionSchemaError(id, 'gameplay.gateEvents.cleanCentredness must be 0..1')
  }
  if (ev.nearMissPoints < 0) {
    throw new EditionSchemaError(id, 'gameplay.gateEvents.nearMissPoints must not be negative')
  }
  // ── DEV-125: the grid ───────────────────────────────────────────────────
  //
  // A slot with a NaN in it is a racer spawned at NaN, which three renders as
  // nothing and the sim integrates for ever; two slots within a hull width of
  // each other is two ships drawn through one another on the grid.
  const racers = g.racers
  if (typeof racers.usePads !== 'boolean') {
    throw new EditionSchemaError(id, 'gameplay.racers.usePads must be a boolean')
  }
  if (!Array.isArray(racers.slots)) {
    throw new EditionSchemaError(id, 'gameplay.racers.slots must be an array')
  }
  racers.slots.forEach((slot, i) => {
    if (!Number.isFinite(slot.ahead) || !Number.isFinite(slot.right)) {
      throw new EditionSchemaError(id, `gameplay.racers.slots[${i}] needs finite ahead and right`)
    }
    if (slot.tuning !== undefined && typeof slot.tuning !== 'string') {
      throw new EditionSchemaError(id, `gameplay.racers.slots[${i}].tuning must be a string`)
    }
    for (let j = 0; j < i; j++) {
      const other = racers.slots[j] as EditionRacerSlot
      if (Math.hypot(other.ahead - slot.ahead, other.right - slot.right) < RACER_SLOT_MIN_GAP) {
        throw new EditionSchemaError(
          id,
          `gameplay.racers.slots[${i}] is within ${RACER_SLOT_MIN_GAP} m of slots[${j}] — two ships in one place`,
        )
      }
    }
  })
  // ── DEV-364: lanes and contact ──────────────────────────────────────────
  //
  // Every number reaches the sim, so a NaN is a racer steered at NaN and a
  // zero `passes` is contact switched on that resolves nothing.
  const separation = racers.separation
  for (const key of [
    'laneSpacing',
    'laneEaseMetres',
    'gateFunnel',
    'avoidReach',
    'avoidClearance',
    'avoidGain',
  ] as const) {
    if (!Number.isFinite(separation[key]) || separation[key] < 0) {
      throw new EditionSchemaError(
        id,
        `gameplay.racers.separation.${key} must be a non-negative number`,
      )
    }
  }
  if (!(separation.gateFraction >= 0 && separation.gateFraction <= 1)) {
    throw new EditionSchemaError(id, 'gameplay.racers.separation.gateFraction must be 0..1')
  }
  const contact = racers.contact
  if (!(contact.restitution >= 0 && contact.restitution <= 1)) {
    throw new EditionSchemaError(id, 'gameplay.racers.contact.restitution must be 0..1')
  }
  if (!Number.isFinite(contact.restingSpeed) || contact.restingSpeed < 0) {
    throw new EditionSchemaError(
      id,
      'gameplay.racers.contact.restingSpeed must be a non-negative number',
    )
  }
  if (!Number.isInteger(contact.passes) || contact.passes < 1) {
    throw new EditionSchemaError(id, 'gameplay.racers.contact.passes must be a whole number >= 1')
  }
  // DEV-364 follow-up: every number reaches the player's body or the cockpit.
  const hit = racers.hit
  for (const key of [
    'minSpeed',
    'fullSpeed',
    'headingKick',
    'attitudeKick',
    'shakeSeconds',
    'shakeGain',
  ] as const) {
    if (!Number.isFinite(hit[key]) || hit[key] < 0) {
      throw new EditionSchemaError(id, `gameplay.racers.hit.${key} must be a non-negative number`)
    }
  }
  if (!(hit.fullSpeed > hit.minSpeed)) {
    throw new EditionSchemaError(id, 'gameplay.racers.hit.fullSpeed must exceed minSpeed')
  }
  if (!(hit.scrub >= 0 && hit.scrub <= 1)) {
    throw new EditionSchemaError(id, 'gameplay.racers.hit.scrub must be 0..1')
  }
  // ── DEV-126: the crash ──────────────────────────────────────────────────
  const crash = g.crash
  for (const key of [
    'minImpactSpeed',
    'resetBackMetres',
    'clearanceMetres',
    'resetSpeed',
    'holdSeconds',
    'resetClearStepMetres',
  ] as const) {
    if (!Number.isFinite(crash[key]) || crash[key] < 0) {
      throw new EditionSchemaError(id, `gameplay.crash.${key} must be a non-negative number`)
    }
  }
  // DEV-136. A zero cell divides every position by zero and puts NaN keys in
  // the hash — every prop unreachable, nothing in the console. A fraction
  // outside 0..1 is a bounce that adds energy or a break that reverses you.
  const pc = g.propCollision
  for (const key of [
    'breakSpeed',
    'breakSlowdown',
    'bounceRestitution',
    'radiusFraction',
    'cellMetres',
    'fractureSeconds',
  ] as const) {
    if (!Number.isFinite(pc[key])) {
      throw new EditionSchemaError(id, `gameplay.propCollision.${key} must be a number`)
    }
  }
  if (!(pc.cellMetres > 0)) {
    throw new EditionSchemaError(id, 'gameplay.propCollision.cellMetres must be greater than 0')
  }
  for (const key of ['breakSlowdown', 'bounceRestitution', 'radiusFraction'] as const) {
    if (pc[key] < 0 || pc[key] > 1) {
      throw new EditionSchemaError(id, `gameplay.propCollision.${key} must be 0..1`)
    }
  }
  if (pc.breakSpeed < 0 || pc.fractureSeconds < 0) {
    throw new EditionSchemaError(
      id,
      'gameplay.propCollision speeds and seconds must not be negative',
    )
  }
  // ── DEV-143: the boost tank ─────────────────────────────────────────────
  //
  // One number, and only two things about it are wrong rather than merely
  // aggressive. A NEGATIVE scale is a tank that DRAINS while you fly and fills
  // while you boost — the mechanic inside out, and nothing about the frame
  // would look wrong. A non-finite one puts a NaN in the tank, and `NaN > 0` is
  // false, so boost would be silently dead for the whole run with no error
  // anywhere. Everything above zero is a legal preset: 1 is the shipped game.
  const energy = g.energy
  if (!Number.isFinite(energy.rechargeScale) || energy.rechargeScale < 0) {
    throw new EditionSchemaError(
      id,
      'gameplay.energy.rechargeScale must be a non-negative finite number — it multiplies ' +
        'the shipped recharge rate, and 1 is 2016 (boost is free)',
    )
  }
  // DEV-410. The same NaN argument for both. A NaN lockout blocks boost for
  // the rest of the run, because `NaN <= 0` is false. A NaN refill poisons the
  // tank.
  if (!Number.isFinite(energy.lockoutScale) || energy.lockoutScale < 0) {
    throw new EditionSchemaError(
      id,
      'gameplay.energy.lockoutScale must be a non-negative finite number — it multiplies ' +
        'RebootTime, and 1 is 2016',
    )
  }
  if (!Number.isFinite(energy.reengage) || energy.reengage < 0 || energy.reengage > 1) {
    throw new EditionSchemaError(
      id,
      'gameplay.energy.reengage must be a fraction of the tank, 0..1 — 0 is no wait',
    )
  }
  if (!Number.isFinite(energy.ringRefill) || energy.ringRefill < 0 || energy.ringRefill > 1) {
    throw new EditionSchemaError(
      id,
      'gameplay.energy.ringRefill must be a fraction of the tank, 0..1 — 0 is 2016',
    )
  }
  // DEV-630. A NaN start would poison the tank for the whole run.
  if (!Number.isFinite(energy.startFill) || energy.startFill < 0 || energy.startFill > 1) {
    throw new EditionSchemaError(
      id,
      'gameplay.energy.startFill must be a fraction of the tank, 0..1 (1 is 2016)',
    )
  }
  // ── DEV-144: the energy race ────────────────────────────────────────────
  //
  // Both must be ABOVE zero, not merely non-negative, and the reason is the
  // same for each: a zero is a mode that looks like it is running and is not.
  // A drain of zero is a tank that never empties — Ring Attack wearing a gauge.
  // A gate pay of zero is a tank nothing refills, which makes the mode a fixed
  // 41.7 s timer that no amount of flying can extend, and every run ends in the
  // sea at the same moment for a reason the player cannot see.
  const race = g.energyRace
  for (const key of ['drainScale', 'gatePayFraction'] as const) {
    if (!Number.isFinite(race[key]) || race[key] <= 0) {
      throw new EditionSchemaError(
        id,
        `gameplay.energyRace.${key} must be a finite number above zero — a zero here is a ` +
          'mode that appears to run and cannot',
      )
    }
  }

  // ── DEV-146: ambient traffic ────────────────────────────────────────────
  //
  // `maxCount` is a SHIP COUNT and a fractional or negative one is a loop bound
  // nobody meant; a non-integer would silently truncate and a preset that said
  // 3.5 would draw three, which is worse than refusing. `recycleClearMetres`
  // negative inverts the rule — it would recycle only while the player is
  // watching, which is the exact bug the number exists to prevent.
  const traffic = g.ambientTraffic
  if (!Number.isInteger(traffic.maxCount) || traffic.maxCount < 0) {
    throw new EditionSchemaError(
      id,
      'gameplay.ambientTraffic.maxCount must be a non-negative integer',
    )
  }
  if (!Number.isFinite(traffic.recycleClearMetres) || traffic.recycleClearMetres < 0) {
    throw new EditionSchemaError(
      id,
      'gameplay.ambientTraffic.recycleClearMetres must be a non-negative number',
    )
  }
}

/**
 * Two grid slots closer than this are one place. The HoverJet hull is 5.5–6 m
 * across (`HOVERJET.shipCollisionColliders`), so this is a hull width with a
 * little air — the validator's job is to refuse a typo, not to lay out a grid.
 */
export const RACER_SLOT_MIN_GAP = 7

/**
 * S6's pulse (DEV-108). The two checks that are not "is it a number" are the
 * ones that would fail silently rather than loudly.
 *
 * `seconds` at zero divides by zero inside the envelope and puts a NaN into an
 * overlay alpha, which is a frame edge that is either permanently white or
 * permanently absent depending on the driver. And `innerRadius` is the R7
 * constraint written as a check: below `R_CLOSED_STRONG` the band reaches
 * pixels the comfort layer protects, and a preset that quietly flashes the
 * centre of the frame is the one outcome this feature must not be able to have.
 * The bound is imported rather than restated — trap 24 — so moving the
 * vignette's aperture moves this with it.
 */
const validateGatePulse = (id: string, pulse: EditionGatePulse): void => {
  for (const key of [
    'strength',
    'seconds',
    'decayShape',
    'innerRadius',
    'feather',
    'streaks',
    'streakDepth',
    'tint',
  ] as const) {
    if (!Number.isFinite(pulse[key])) {
      throw new EditionSchemaError(id, `fx.gatePulse.${key} must be a number`)
    }
  }
  if (!(pulse.seconds > 0)) {
    throw new EditionSchemaError(id, 'fx.gatePulse.seconds must be above zero')
  }
  // Whole wedges, and this is correctness rather than tidiness: the shader
  // takes its angle from `atan(y, x)`, whose branch cut runs along -x, and
  // `cos(theta * n + phase)` is continuous across that cut only for integer n.
  // A fractional count draws a seam down the left of the frame, in one place,
  // for ever — the kind of defect that survives because it looks authored.
  if (!Number.isInteger(pulse.streaks) || pulse.streaks < 1) {
    throw new EditionSchemaError(id, 'fx.gatePulse.streaks must be a whole number of 1 or more')
  }
  if (!(pulse.innerRadius >= R_CLOSED_STRONG)) {
    throw new EditionSchemaError(
      id,
      `fx.gatePulse.innerRadius must be ${R_CLOSED_STRONG} or above — ` +
        'research 05 R7 allows peripheral pulses only',
    )
  }
  validateCurve(id, 'fx.gatePulse.gainBySpeed', pulse.gainBySpeed)
}

/**
 * The out-of-bounds static (DEV-127). One number, and the check is the
 * relationship it has to be: an OVERLAY ALPHA, so 0..1. Above 1 the shader
 * would clamp and the preset would be lying about what it draws; below 0 a
 * source-over layer has no meaning at all.
 */
const validateBoundaryFuzz = (id: string, fuzz: EditionBoundaryFuzz): void => {
  if (!Number.isFinite(fuzz.strength) || fuzz.strength < 0 || fuzz.strength > 1) {
    throw new EditionSchemaError(id, 'boundary.fuzz.strength must be a number in 0..1')
  }
}

/** Three finite numbers, or a named throw. Colours and offsets are both that. */
const triple = (id: string, where: string, value: unknown): void => {
  if (!Array.isArray(value) || value.length !== 3 || value.some((n) => !Number.isFinite(n))) {
    throw new EditionSchemaError(id, `${where} must be three finite numbers`)
  }
}

/**
 * V8's two blocks, checked at LOAD. DEV-088.
 *
 * The failure shapes these catch are the silent ones, which is the only reason
 * a runtime check exists next to a JSON schema. A missing `decay` on a
 * `PointLight` is `undefined`, which three writes into the shader's
 * `lightDistance` maths and gets NaN from — every lit fragment in the game goes
 * black, with nothing in the console. A hole in the body's palette is a
 * `THREE.Color` of NaN, which renders the pilot black rather than absent, and
 * "the body looks wrong" is a much longer afternoon than "cockpit.body.palette.
 * suit must be three finite numbers".
 *
 * A negative `intensity` is allowed nowhere: three will happily SUBTRACT light,
 * and a preset that darkens the cabin by asking for a lamp is the kind of thing
 * that gets diagnosed as a shader bug.
 */
const validateCockpitInterior = (id: string, cockpit: EditionCockpit): void => {
  const lighting = cockpit.lighting
  for (const [name, light] of [
    ['fill', lighting.fill],
    ['dash', lighting.dash],
  ] as const) {
    const where = `cockpit.lighting.${name}`
    if (!light || typeof light !== 'object') {
      throw new EditionSchemaError(id, `${where} is missing`)
    }
    for (const key of ['intensity', 'distance', 'decay'] as const) {
      if (!Number.isFinite(light[key])) {
        throw new EditionSchemaError(id, `${where}.${key} must be a finite number`)
      }
    }
    if (light.intensity < 0) {
      throw new EditionSchemaError(id, `${where}.intensity must not be negative`)
    }
    triple(id, `${where}.color`, light.color)
    triple(id, `${where}.offset`, light.offset)
  }
  const emissive = lighting.emissive
  if (!emissive || !Number.isFinite(emissive.intensity)) {
    throw new EditionSchemaError(id, 'cockpit.lighting.emissive.intensity must be a finite number')
  }
  triple(id, 'cockpit.lighting.emissive.color', emissive.color)

  const body = cockpit.body
  if (typeof body.hands !== 'boolean') {
    throw new EditionSchemaError(id, 'cockpit.body.hands must be a boolean')
  }
  triple(id, 'cockpit.body.offset', body.offset)
  for (const key of ['seat', 'trim', 'suit', 'glove'] as const) {
    triple(id, `cockpit.body.palette.${key}`, body.palette?.[key])
  }
  // DEV-129. A hole here is a readout at the ship origin — inside the console
  // mesh, invisible — with nothing in the console to say so. DEV-362: the
  // same for each vehicle's block, because a JumpSeat reading a missing
  // `jumpSeatHud` would be exactly that hole on half the missions.
  for (const key of ['hud', 'jumpSeatHud'] as const) {
    const hud = cockpit.placement?.[key]
    if (!hud) throw new EditionSchemaError(id, `cockpit.placement.${key} is missing`)
    triple(id, `cockpit.placement.${key}.offset`, hud.offset)
    if (!Number.isFinite(hud.tilt)) {
      throw new EditionSchemaError(
        id,
        `cockpit.placement.${key}.tilt must be a finite number of radians`,
      )
    }
    if (!Number.isFinite(hud.scale) || !(hud.scale > 0)) {
      throw new EditionSchemaError(id, `cockpit.placement.${key}.scale must be a positive number`)
    }
  }
}

/**
 * T1's four numbers, checked for the holes that do NOT throw.
 *
 * Each of these has a silent failure with a different shape, which is why they
 * are named one at a time rather than swept up in a loop:
 *
 *  * a negative or zero **radius** is a ring that never opens, and `detailBand`
 *    would answer null forever with nothing to say why;
 *  * a zero or negative **baseResolution** is a division by zero inside
 *    `detailChunkParams`, which arrives as an `Infinity` quad count and a
 *    `Float32Array` allocation of a non-integer length;
 *  * a **maxInFlight** below one starves the queue permanently — the ring is
 *    configured, enabled, and never asks for a single chunk;
 *  * a negative **jitterScale** mirrors the jitter through the vertex it is
 *    displacing, which is not a look, it is inside-out triangles.
 *
 * `baseResolution` must also be a **power of two**. The real invariant is that
 * it divide `chunkSize`, which this function cannot see — the terrain is not
 * loaded yet, and shipped chunks are 256, 512 and 1024 m. A power of two is the
 * checkable half of that, `sim/terrain/detail.ts` throws with the actual chunk
 * size for the other half, and `tests/unit/terrain-detail-ring.test.ts` proves
 * the preset's value against every terrain in the generated sheet.
 */
const validateDetailRing = (id: string, ring: EditionDetailRing): void => {
  for (const key of [
    'baseResolution',
    'radius',
    'jitterScale',
    'maxInFlight',
    'smoothMetres',
  ] as const) {
    if (!Number.isFinite(ring[key])) {
      throw new EditionSchemaError(id, `terrain.detailRing.${key} must be a finite number`)
    }
  }
  if (ring.radius < 0) {
    throw new EditionSchemaError(id, 'terrain.detailRing.radius must be zero or above')
  }
  if (ring.smoothMetres < 0) {
    throw new EditionSchemaError(id, 'terrain.detailRing.smoothMetres must be zero or above')
  }
  if (ring.jitterScale < 0) {
    throw new EditionSchemaError(id, 'terrain.detailRing.jitterScale must be zero or above')
  }
  if (!Number.isInteger(ring.maxInFlight) || ring.maxInFlight < 1) {
    throw new EditionSchemaError(
      id,
      'terrain.detailRing.maxInFlight must be a whole number above 0',
    )
  }
  const r = ring.baseResolution
  if (!(r > 0) || !Number.isInteger(r) || (r & (r - 1)) !== 0) {
    throw new EditionSchemaError(
      id,
      `terrain.detailRing.baseResolution must be a positive power of two — got ${r}. It has to ` +
        'divide the chunk size of every terrain it is applied to, and every shipped chunk is a ' +
        'power of two (256, 512, 1024 m).',
    )
  }
}

/**
 * V9's numbers, checked for the things that fail SILENTLY rather than loudly.
 *
 * The pattern of the whole function above it: a hole in a band renders nothing,
 * or renders everything, and neither one throws. An inverted scale span makes
 * `scaleMin + rnd() * (scaleMax - scaleMin)` walk DOWNWARD out of the band and
 * a preset then quietly ships boulders smaller than its own floor; an inverted
 * slope or altitude band accepts nothing at all and the feature just does not
 * appear. Both are a person's typo, and both should name the key.
 */
const validateProps = (id: string, props: EditionProps): void => {
  for (const key of ['seed', 'clearance', 'variants'] as const) {
    if (!Number.isFinite(props[key])) {
      throw new EditionSchemaError(id, `props.${key} must be a finite number`)
    }
  }
  if (!(props.variants >= 1)) throw new EditionSchemaError(id, 'props.variants must be at least 1')
  if (props.clearance < 0) throw new EditionSchemaError(id, 'props.clearance must not be negative')
  // DEV-134. A scale of zero or less is a prop that draws as a point or
  // inside-out, and a NaN here is an instance matrix full of NaN — a whole
  // pass vanishing with nothing in the console.
  if (props.scale === null || typeof props.scale !== 'object' || Array.isArray(props.scale)) {
    throw new EditionSchemaError(id, 'props.scale must be an object of kind -> multiplier')
  }
  for (const [kind, v] of Object.entries(props.scale)) {
    if (kind === 'note') continue
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      throw new EditionSchemaError(id, `props.scale.${kind} must be a positive number`)
    }
  }
  if (!Number.isFinite(props.groundSnap.sink) || props.groundSnap.sink < 0) {
    throw new EditionSchemaError(
      id,
      'props.groundSnap.sink must be a number of metres, not negative',
    )
  }
  // DEV-338. Out of order, a rung would start inside the one before it and
  // `rungAt` would never pick it; a keep of 1 or more is a second copy of the
  // full mesh drawn for nothing, and 0 or less is a prop that vanishes.
  if (!Array.isArray(props.meshLod?.rungs)) {
    throw new EditionSchemaError(id, 'props.meshLod.rungs must be an array (empty is legal)')
  }
  let lastFrom = 0
  let lastKeep = 1
  for (const [i, rung] of props.meshLod.rungs.entries()) {
    const where = `props.meshLod.rungs[${i}]`
    if (!Number.isFinite(rung.from) || rung.from <= lastFrom) {
      throw new EditionSchemaError(id, `${where}.from must be metres, above the rung before it`)
    }
    if (!Number.isFinite(rung.keep) || rung.keep <= 0 || rung.keep >= lastKeep) {
      throw new EditionSchemaError(
        id,
        `${where}.keep must be in (0, 1) and below the rung before it`,
      )
    }
    lastFrom = rung.from
    lastKeep = rung.keep
  }
  // DEV-356. A sine, so the only numbers are the ends of its range: 0 or less
  // would clear every prop off the flat as well, and above 1 clears nothing
  // while still reading as a limit to whoever tunes it.
  const slope = props.maxSlope?.sin
  if (typeof slope !== 'number' || !Number.isFinite(slope) || slope <= 0 || slope > 1) {
    throw new EditionSchemaError(
      id,
      'props.maxSlope.sin must be the sine of an angle, in (0, 1] — 0.7 is 44 degrees',
    )
  }
  if (!Array.isArray(props.scatter)) {
    throw new EditionSchemaError(id, 'props.scatter must be an array (empty is legal)')
  }
  for (const [i, band] of props.scatter.entries()) {
    const where = `props.scatter[${i}]`
    if (!(PROP_KIND_LIST as readonly string[]).includes(band.kind)) {
      throw new EditionSchemaError(id, `${where}.kind is not one of ${PROP_KIND_LIST.join(', ')}`)
    }
    for (const key of [
      'density',
      'scaleMin',
      'scaleMax',
      'slopeMin',
      'slopeMax',
      'altitudeMin',
      'altitudeMax',
      'tint',
    ] as const) {
      if (!Number.isFinite(band[key])) {
        throw new EditionSchemaError(id, `${where}.${key} must be a finite number`)
      }
    }
    if (band.scaleMax < band.scaleMin) {
      throw new EditionSchemaError(id, `${where}.scaleMax is below scaleMin`)
    }
    if (band.slopeMax < band.slopeMin) {
      throw new EditionSchemaError(id, `${where}.slopeMax is below slopeMin`)
    }
    if (band.altitudeMax < band.altitudeMin) {
      throw new EditionSchemaError(id, `${where}.altitudeMax is below altitudeMin`)
    }
    if (typeof band.nearWater !== 'boolean') {
      throw new EditionSchemaError(id, `${where}.nearWater must be a boolean`)
    }
    validatePalette(id, `${where}.palette`, band.palette)
  }
  const birds = props.birds
  for (const key of ['flocks', 'birdsPerFlock', 'altitude', 'radius', 'speed', 'size'] as const) {
    if (!Number.isFinite(birds[key])) {
      throw new EditionSchemaError(id, `props.birds.${key} must be a finite number`)
    }
  }
  // A zero radius divides into the angular rate and every bird in the world
  // lands on its flock's centre, stationary, in a heap. Zero flocks is the
  // no-op; a zero-radius flock is a typo.
  if (birds.enabled && birds.flocks > 0 && !(birds.radius > 0)) {
    throw new EditionSchemaError(id, 'props.birds.radius must be greater than 0')
  }
  validatePalette(id, 'props.birds.palette', birds.palette)
}

const validatePalette = (
  id: string,
  where: string,
  palette: readonly (readonly number[])[],
): void => {
  if (!Array.isArray(palette)) {
    throw new EditionSchemaError(id, `${where} must be an array of linear RGB triples`)
  }
  for (const [i, c] of palette.entries()) {
    if (!Array.isArray(c) || c.length !== 3 || !c.every((v) => Number.isFinite(v))) {
      throw new EditionSchemaError(id, `${where}[${i}] must be three linear RGB numbers`)
    }
  }
}

/**
 * ONE curve, checked for the shape `sampleCurve` ASSUMES.
 *
 * It assumes ascending x, because it walks the points once and stops at the
 * first whose x is past the argument — a curve authored out of order would
 * answer a plausible wrong number at 82 Hz with nothing to say why, which is the
 * shape of bug the whole of `docs/DEVIATIONS.md`'s agreement lesson is about. So
 * the assumption is checked ONCE, at load, with the curve named in the message,
 * rather than being a comment the evaluator hopes is true.
 *
 * Equal x is allowed: two points at one x is a step, and "silent below 120, half
 * above it" is a legitimate thing to author.
 *
 * Shared by S4's seven curves and S7's one (DEV-084, DEV-093), for the same
 * reason `flat-fov.ts` imports `sampleCurve` rather than reimplementing it:
 * `Breakpoints` is one contract with one evaluator, so it gets one validator.
 * Two that had to agree is the trap.
 */
const validateCurve = (id: string, where: string, curve: Breakpoints): void => {
  // Two, because one point is a constant written as a curve and zero is a
  // hole. Both are content mistakes and neither should reach the game.
  if (!Array.isArray(curve) || curve.length < 2) {
    throw new EditionSchemaError(id, `${where} needs at least two [x, y] points`)
  }
  let previous = Number.NEGATIVE_INFINITY
  for (const [i, point] of curve.entries()) {
    if (!Array.isArray(point) || point.length !== 2) {
      throw new EditionSchemaError(id, `${where}[${i}] is not an [x, y] pair`)
    }
    const [x, y] = point
    if (typeof x !== 'number' || typeof y !== 'number') {
      throw new EditionSchemaError(id, `${where}[${i}] is not two numbers`)
    }
    if (x < previous) {
      throw new EditionSchemaError(id, `${where}[${i}] goes backwards in x — must ascend`)
    }
    previous = x
  }
}

/** The seven curves S4 reads, plus its one scalar. */
const validateSpeedCurves = (id: string, curves: EditionSpeedCurves): void => {
  const named: readonly [string, Breakpoints][] = [
    ['aircraftWindGain', curves.aircraftWindGain],
    ['flightWindGain', curves.flightWindGain],
    ['windCutoffHz', curves.windCutoffHz],
    ['thrustRate', curves.thrustRate],
    ['afterburnerRate', curves.afterburnerRate],
    ['gateWhooshGain', curves.gateWhooshGain],
    ['gateWhooshPitch', curves.gateWhooshPitch],
    ['windRate', curves.windRate],
  ]
  for (const [name, curve] of named) {
    validateCurve(id, `audio.speedCurves.${name}`, curve)
  }
  // DEV-425. A rate becomes `1200 * log2(rate)` cents on the tone and a
  // multiple of every filter band, so a zero is -Infinity cents and a 0 Hz
  // band: the wind silently gone. Same rule as `pitchTracking.rateBySpeed`.
  for (const [i, [, rate]] of curves.windRate.entries()) {
    if (!(rate > 0)) {
      throw new EditionSchemaError(
        id,
        `audio.speedCurves.windRate[${i}] must have a rate > 0 — got ${String(rate)}`,
      )
    }
  }
  if (typeof curves.afterburnerStep !== 'number' || !(curves.afterburnerStep > 0)) {
    throw new EditionSchemaError(id, 'audio.speedCurves.afterburnerStep must be a positive number')
  }
}

/**
 * DEV-137's two blocks, checked for the holes that do not announce themselves.
 *
 * The cutoffs and the slew are DIVIDED INTO or ramped TO by the backend: a zero
 * cutoff is a biquad asked for 0 Hz (clamped to 10 by `audibleHz`, i.e. a voice
 * that is silently gone), and a zero slew is a rate that can never move — the
 * feature technically on and doing nothing, with nothing in the console. The
 * gains may legitimately be zero (Classic's no-ops are), so they are only
 * refused when negative or missing.
 */
const validateEngineSound = (id: string, engine: EditionEngineSound): void => {
  const r = engine.rumble
  validateCurve(id, 'audio.engine.rumble.gainByThrottle', r.gainByThrottle)
  for (const key of ['cutoffHz', 'boostCutoffHz'] as const) {
    if (!Number.isFinite(r[key]) || !(r[key] > 0)) {
      throw new EditionSchemaError(id, `audio.engine.rumble.${key} must be a positive number of Hz`)
    }
  }
  for (const key of ['boostGain', 'growlGain'] as const) {
    if (!Number.isFinite(r[key]) || r[key] < 0) {
      throw new EditionSchemaError(id, `audio.engine.rumble.${key} must be a number >= 0`)
    }
  }
  const p = engine.pitchTracking
  validateCurve(id, 'audio.engine.pitchTracking.rateBySpeed', p.rateBySpeed)
  // A rate the backend turns into `1200 * log2(rate)` cents, so it must be > 0
  // at every point — a zero would be a detune of -Infinity on every oscillator.
  for (const [i, [, rate]] of p.rateBySpeed.entries()) {
    if (!(rate > 0)) {
      throw new EditionSchemaError(
        id,
        `audio.engine.pitchTracking.rateBySpeed[${i}] must have a rate > 0 — got ${String(rate)}`,
      )
    }
  }
  if (!Number.isFinite(p.slewPerSecond) || !(p.slewPerSecond > 0)) {
    throw new EditionSchemaError(
      id,
      'audio.engine.pitchTracking.slewPerSecond must be a positive rate change per second',
    )
  }
}

/**
 * DEV-424's block, checked for the holes that do not announce themselves.
 *
 * A zero rate is `-Infinity` cents on the motor, as on the engine. A
 * `stoppedBelow` of zero or less is a lift that is never stopped — the motor
 * would start on the first tick of a still platform and the arrival clunk could
 * never fire — which is the feature on and wrong with nothing in the console.
 */
const validateLiftSound = (id: string, lift: EditionLiftSound): void => {
  validateCurve(id, 'audio.lift.rateBySpeed', lift.rateBySpeed)
  validateCurve(id, 'audio.lift.gainBySpeed', lift.gainBySpeed)
  for (const [i, [, rate]] of lift.rateBySpeed.entries()) {
    if (!(rate > 0)) {
      throw new EditionSchemaError(
        id,
        `audio.lift.rateBySpeed[${i}] must have a rate > 0 — got ${String(rate)}`,
      )
    }
  }
  if (!Number.isFinite(lift.stoppedBelow) || !(lift.stoppedBelow > 0)) {
    throw new EditionSchemaError(id, 'audio.lift.stoppedBelow must be a positive speed in m/s')
  }
  if (!Number.isFinite(lift.arriveGain) || lift.arriveGain < 0) {
    throw new EditionSchemaError(id, 'audio.lift.arriveGain must be a number >= 0')
  }
}

/**
 * S7's block, checked for the two holes that do NOT announce themselves.
 *
 * `attackSeconds` and `releaseSeconds` are DIVISORS — `flat-fov.ts` eases by
 * `1 - exp(-dt / tau)` — and a zero or a hole there makes the exponent
 * infinite, which snaps the lens instantly every frame: a feature that
 * technically works and has no feel at all, with nothing in the console. And a
 * `base` that is not `null` and not a real lens is the loud one made quiet:
 * `updateProjectionMatrix` takes `tan(fov/2)`, so 180 divides by zero and the
 * projection matrix goes to NaN — which renders an EMPTY frame, not a wrong one.
 * The band is deliberately narrow (20..120): ANNIVERSARY.md §1.5 item 8's whole
 * argument lives between 55 and 70, and nothing outside 20..120 is a lens anybody
 * would ask for on purpose.
 *
 * **Hard rule 3's justification for the two literals**, since they are under
 * `src/content/`: they are a VALIDATION BAND, not tuning — the same kind of
 * number as `mapSize`'s 256..4096 and `triple`'s 3 above, which is to say a
 * statement about what a person could plausibly have meant to type rather than a
 * value anything reads. The lens itself is `render.flatFov.base` in the preset,
 * where every tunable number in this file's world lives. DEV-093.
 */
const validateFlatFov = (id: string, fov: EditionFlatFov): void => {
  for (const key of ['attackSeconds', 'releaseSeconds'] as const) {
    if (!Number.isFinite(fov[key]) || !(fov[key] > 0)) {
      throw new EditionSchemaError(id, `render.flatFov.${key} must be a positive number of seconds`)
    }
  }
  if (fov.base !== null) {
    if (!Number.isFinite(fov.base) || fov.base < 20 || fov.base > 120) {
      throw new EditionSchemaError(
        id,
        `render.flatFov.base must be null or a vertical fov from 20 to 120 degrees — got ${String(fov.base)}`,
      )
    }
  }
  validateCurve(id, 'render.flatFov.addBySpeed', fov.addBySpeed)
}

/**
 * DEV-128's block, checked at LOAD for the holes that fail silently.
 *
 * A non-positive lag is a division by zero inside `1 - exp(-dt / tau)`, which
 * is a camera that snaps and a feature with no feel and nothing in the console;
 * a follow fraction outside 0..1 over-rotates the horizon past the ship's own
 * bank, which reads as a bug in the flight model rather than in the preset;
 * and a pitch past ±89 puts the arm through the pole where yaw and roll are
 * the same axis. The band numbers are validation bands like `validateFlatFov`'s
 * — statements about what a person could have meant to type, not tuning.
 */
const validateThirdPerson = (id: string, tp: EditionThirdPerson): void => {
  for (const key of ['positionLagSeconds', 'rotationLagSeconds', 'maxLagMetres'] as const) {
    if (!Number.isFinite(tp[key]) || !(tp[key] > 0)) {
      throw new EditionSchemaError(id, `render.thirdPerson.${key} must be a positive number`)
    }
  }
  if (!Number.isFinite(tp.armLength) || !(tp.armLength > 0)) {
    throw new EditionSchemaError(
      id,
      'render.thirdPerson.armLength must be a positive number of metres',
    )
  }
  if (!Number.isFinite(tp.minArmLength) || tp.minArmLength < 0 || tp.minArmLength > tp.armLength) {
    throw new EditionSchemaError(id, 'render.thirdPerson.minArmLength must be 0..armLength')
  }
  if (!Number.isFinite(tp.probeRadius) || tp.probeRadius < 0) {
    throw new EditionSchemaError(id, 'render.thirdPerson.probeRadius must be a non-negative number')
  }
  for (const key of ['pitchFollow', 'rollFollow'] as const) {
    if (!Number.isFinite(tp[key]) || tp[key] < 0 || tp[key] > 1) {
      throw new EditionSchemaError(id, `render.thirdPerson.${key} must be 0..1`)
    }
  }
  for (const key of ['armPitchDeg', 'aimPitchDeg'] as const) {
    if (!Number.isFinite(tp[key]) || tp[key] < -89 || tp[key] > 89) {
      throw new EditionSchemaError(id, `render.thirdPerson.${key} must be within ±89 degrees`)
    }
  }
  if (!Number.isFinite(tp.hudScale) || !(tp.hudScale > 0)) {
    throw new EditionSchemaError(id, 'render.thirdPerson.hudScale must be a positive number')
  }
  triple(id, 'render.thirdPerson.pivotOffset', tp.pivotOffset)
  triple(id, 'render.thirdPerson.hudOffset', tp.hudOffset)
  validateCurve(id, 'render.thirdPerson.fovAddBySpeed', tp.fovAddBySpeed)
}

/**
 * DEV-350. The palette is the one hole here that fails SILENTLY: an empty
 * list, a short triple or a NaN paints a racer's livery black or not at all,
 * and nothing errors. Checked on both presets, because Classic's is read at
 * load too — it is what a flip to Anniversary paints.
 */
const validateRacerLivery = (id: string, rl: EditionRacerLivery): void => {
  if (!Array.isArray(rl.palette) || rl.palette.length === 0) {
    throw new EditionSchemaError(id, 'render.racerLivery.palette must list at least one colour')
  }
  rl.palette.forEach((c, i) => {
    if (!Array.isArray(c) || c.length !== 3 || c.some((n) => !(n >= 0 && n <= 1))) {
      throw new EditionSchemaError(
        id,
        `render.racerLivery.palette[${i}] must be three numbers, sRGB 0..1`,
      )
    }
  })
}

/**
 * DEV-446. Every hole here fails SILENTLY — a NaN reaches the quad's uniform
 * and the whole world renders black, or a missing `missions` throws at frame 1
 * as `undefined` — so each is refused at load, naming the key. Checked on both
 * presets: Classic's is what a flip to Anniversary would read.
 */
/**
 * DEV-613. `splashCrownSpec` and `splashDropsSpec` build particle specs from
 * these, and a hole draws nothing and says nothing: a count of 0 is a splash of
 * nobody, a zero `refSpeed` a NaN scale, and a cone past flat throws into the
 * sea. Checked on both presets, since Classic's is what a flip would read.
 */
const validateSplash = (id: string, sp: EditionSplash): void => {
  for (const key of [
    'emitters',
    'maxMetres',
    'refSpeed',
    'minScale',
    'maxScale',
    'jetBody',
    'dolphinBody',
    'outScale',
    'exitMetres',
    'minSeconds',
    'carry',
    'gravity',
    'drag',
    'shade',
  ] as const) {
    if (!Number.isFinite(sp?.[key]) || sp[key] < 0) {
      throw new EditionSchemaError(id, `fx.splash.${key} must be a non-negative number`)
    }
  }
  if (!Number.isInteger(sp.emitters) || sp.emitters < 1) {
    throw new EditionSchemaError(id, 'fx.splash.emitters must be a whole number of 1 or more')
  }
  if (!(sp.refSpeed > 0) || !(sp.minScale > 0) || !(sp.maxScale >= sp.minScale)) {
    throw new EditionSchemaError(
      id,
      'fx.splash.refSpeed and minScale must be above zero, and maxScale at least minScale',
    )
  }
  if (sp.carry > 1) throw new EditionSchemaError(id, 'fx.splash.carry must be 0..1')
  for (const part of ['crown', 'drops'] as const) {
    const pt = sp[part]
    for (const key of ['count', 'lift', 'angleDeg', 'radius', 'lifetime', 'size'] as const) {
      if (!Number.isFinite(pt?.[key]) || pt[key] < 0) {
        throw new EditionSchemaError(id, `fx.splash.${part}.${key} must be a non-negative number`)
      }
    }
    if (!Number.isInteger(pt.count) || pt.count < 1) {
      throw new EditionSchemaError(
        id,
        `fx.splash.${part}.count must be a whole number of 1 or more`,
      )
    }
    if (!(pt.lifetime > 0) || !(pt.size > 0) || !(pt.angleDeg < 90)) {
      throw new EditionSchemaError(
        id,
        `fx.splash.${part}: lifetime and size above zero, angleDeg below 90 (past flat throws into the sea)`,
      )
    }
    const c = pt.colour
    if (
      !Array.isArray(c) ||
      c.length !== 3 ||
      !c.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)
    ) {
      throw new EditionSchemaError(id, `fx.splash.${part}.colour must be three sRGB numbers, 0..1`)
    }
  }
}

const validateSceneTint = (id: string, st: EditionSceneTint): void => {
  const value = (path: string, v: SceneTintValue | undefined): void => {
    const c = v?.color
    if (!Array.isArray(c) || c.length !== 3 || c.some((n) => !(n >= 0 && n <= 1))) {
      throw new EditionSchemaError(id, `${path}.color must be three numbers, sRGB 0..1`)
    }
    const s = v?.strength
    if (typeof s !== 'number' || !(s >= 0 && s <= 1)) {
      throw new EditionSchemaError(id, `${path}.strength must be a number, 0..1`)
    }
  }
  value('render.sceneTint.default', st.default)
  if (typeof st.missions !== 'object' || st.missions === null || Array.isArray(st.missions)) {
    throw new EditionSchemaError(
      id,
      'render.sceneTint.missions must be an object keyed by level id',
    )
  }
  for (const [level, v] of Object.entries(st.missions)) {
    value(`render.sceneTint.missions.${level}`, v)
  }
}

/**
 * Every switchable feature, by dotted path — so a test can walk them and
 * assert the invariant that makes Classic what it is: **every flag off.**
 */
export const editionFeatures = (e: Edition): readonly [string, EditionFeature][] => [
  ['render.haze', e.render.haze],
  ['render.illustrative', e.render.illustrative],
  ['render.shadows', e.render.shadows],
  ['render.shipShadow', e.render.shipShadow],
  ['render.cockpitShadow', e.render.cockpitShadow],
  ['render.cockpitSelfShadow', e.render.cockpitSelfShadow],
  ['render.nearShadow', e.render.nearShadow],
  ['render.smoothSky', e.render.smoothSky],
  ['render.sunHeight', e.render.sunHeight],
  ['render.cloudShadow', e.render.cloudShadow],
  ['render.canopyShade', e.render.canopyShade],
  ['render.skyVisibility', e.render.skyVisibility],
  ['render.horizonGeo', e.render.horizonGeo],
  ['render.coast', e.render.coast],
  ['render.seaReflection', e.render.seaReflection],
  ['render.flatFov', e.render.flatFov],
  ['render.clouds', e.render.clouds],
  ['render.bloom', e.render.bloom],
  ['render.thirdPerson', e.render.thirdPerson],
  ['render.racerLivery', e.render.racerLivery],
  ['render.racerLivery.shadow', e.render.racerLivery.shadow],
  ['render.sceneTint', e.render.sceneTint],
  ['fx.speedLines', e.fx.speedLines],
  ['fx.speedRamp', e.fx.speedRamp],
  ['fx.wingTrails', e.fx.wingTrails],
  ['fx.motes', e.fx.motes],
  ['fx.gatePulse', e.fx.gatePulse],
  ['fx.waterSpray', e.fx.waterSpray],
  ['fx.propBurst', e.fx.propBurst],
  ['fx.splash', e.fx.splash],
  ['menu.holoTerrainColours', e.menu.holoTerrainColours],
  ['menu.medalOutline', e.menu.medalOutline],
  ['cockpit.shake', e.cockpit.shake],
  ['cockpit.lighting', e.cockpit.lighting],
  ['cockpit.body', e.cockpit.body],
  ['audio.speedCurves', e.audio.speedCurves],
  ['audio.engine.rumble', e.audio.engine.rumble],
  ['audio.engine.pitchTracking', e.audio.engine.pitchTracking],
  ['terrain.detailRing', e.terrain.detailRing],
  ['terrain.lodFade', e.terrain.lodFade],
  ['terrain.diagonalFix', e.terrain.diagonalFix],
  ['terrain.surfaceGloss', e.terrain.surfaceGloss],
  ['terrain.bakedLight', e.terrain.bakedLight],
  ['terrain.oceanRings', e.terrain.oceanRings],
  ['props', e.props],
  ['props.birds', e.props.birds],
  ['props.unbakedPasses', e.props.unbakedPasses],
  ['props.groundSnap', e.props.groundSnap],
  ['props.scatterShadows', e.props.scatterShadows],
  ['props.meshLod', e.props.meshLod],
  ['props.maxSlope', e.props.maxSlope],
  ['gameplay.proximity', e.gameplay.proximity],
  ['gameplay.gateEvents', e.gameplay.gateEvents],
  ['gameplay.chainMeter', e.gameplay.chainMeter],
  ['gameplay.gateBullseye', e.gameplay.gateBullseye],
  ['boundary.fuzz', e.boundary.fuzz],
  ['gates.passedFade', e.gates.passedFade],
  ['gates.finishBanner', e.gates.finishBanner],
  ['hud.nextGateArrow', e.hud.nextGateArrow],
  ['hud.raceMap', e.hud.raceMap],
  ['hud.bars', e.hud.bars],
  ['gameplay.racers', e.gameplay.racers],
  ['gameplay.racers.separation', e.gameplay.racers.separation],
  ['gameplay.racers.contact', e.gameplay.racers.contact],
  ['gameplay.racers.hit', e.gameplay.racers.hit],
  ['gameplay.crash', e.gameplay.crash],
  ['gameplay.propCollision', e.gameplay.propCollision],
  ['gameplay.propCollision.strike', e.gameplay.propCollision.strike],
  ['gameplay.energy', e.gameplay.energy],
  ['gameplay.energyRace', e.gameplay.energyRace],
  ['gameplay.ambientTraffic', e.gameplay.ambientTraffic],
  ['gameplay.variants', e.gameplay.variants],
  ['gameplay.glider', e.gameplay.glider],
  ['life.boats', e.life.boats],
  ['life.dolphins', e.life.dolphins],
]

/**
 * The preset with some `editionFeatures()` flags forced on or off. DEV-263.
 *
 * ONE function, three callers, and they differ only in where the map comes from:
 *
 *  - `applyVrOverrides` below — `edition.vr.disable`, off only, while presenting.
 *  - `?feature=<path>:on|off` — a dev pin. It is what lets
 *    `view-toggle-compile.spec.ts` keep testing DEV-186's invariant after the
 *    cockpit lamps stopped shipping: that spec guards its own premise (*"if the
 *    cockpit's lamps are not lit there is nothing here to test"*) and the
 *    preset moving under it removed the question rather than changing the
 *    answer. The pin puts the question back.
 *  - the Advanced pause page, which needs to turn a VR-disabled feature back ON
 *    to look at it — which is the whole reason this takes a BOOLEAN per path
 *    rather than a list of things to disable.
 *
 * Returns the edition UNCHANGED — the same object, by identity — when every
 * override already agrees with the preset. That identity is load-bearing, not
 * an optimisation: see the comment on the no-op check inside.
 */
export const withFeatureOverrides = (
  edition: Edition,
  overrides: Readonly<Record<string, boolean>>,
): Edition => {
  const entries = Object.entries(overrides)
  if (entries.length === 0) return edition
  // Identity when it would be a no-op — every override already agrees with the
  // preset. `editionFeatures` is the registry, so "already in that state" is
  // read from the same place the validator checked against. `game/edition.ts`
  // leans on this: it compares `current` by identity to decide whether a layer
  // change has to notify, and a fresh-but-equal object would rebuild materials
  // to arrive at the preset it already had.
  const live = new Map(editionFeatures(edition))
  // A path that is not a feature is IGNORED here, not thrown on, and that is
  // the opposite of `validateEdition`'s rule on the same strings — deliberately.
  // The edition files are ours and a typo in one must be refused. These come
  // from a URL pin and (DEV-263 stage 2) a player's stored settings, which
  // outlive the build that wrote them: a feature removed in a later version
  // must not brick the menu or the load.
  if (!entries.some(([p, on]) => live.has(p) && live.get(p)?.enabled !== on)) return edition

  const next = structuredClone(edition) as Edition
  // The registry again, over the COPY, so each path resolves to the copy's own
  // feature object rather than to a node walked by splitting the string here.
  // One way to turn a path into an object, shared with the validator.
  //
  // `structuredClone` rather than a shallow copy: the paths are data, so the
  // shape being copied is not known here, and a shallow copy would leave the
  // two presets SHARING the feature objects — writing to one would move the
  // other, which is a bug that survives every test that looks at one at a time.
  const target = new Map(editionFeatures(next))
  for (const [path, on] of entries) {
    const feature = target.get(path)
    // `as` because the registry is typed readonly and this is the one place
    // allowed to write one — the copy is private to this function until it is
    // returned, so nothing else can be holding it.
    if (feature) (feature as { enabled: boolean }).enabled = on
  }
  return next
}

/**
 * The preset as it renders WHILE PRESENTING: `edition.vr.disable` applied.
 *
 * A thin reading of `withFeatureOverrides`: the VR layer can only ever turn
 * things OFF, which is what keeps the VR look a SUBSET of the flat one.
 */
export const applyVrOverrides = (edition: Edition): Edition => {
  const paths = edition.vr?.disable
  if (!paths || paths.length === 0) return edition
  return withFeatureOverrides(edition, Object.fromEntries(paths.map((p) => [p, false])))
}

// ── The life pass (DEV-447 …) ─────────────────────────────────────────────
//
// Scenery that moves: boats first, then the dolphins, each its own row.
// (DEV-448's spectators were cut by DEV-463: *"let's cut them and just go
// with things like the boats and sea life."* DEV-449's fish were cut by
// DEV-545, Matt 2026-09-30: *"kill the fish"*.)
// A TOP-LEVEL block rather than a key in `gameplay`, because nothing in it can
// change a lap (a `gameplay` key restarts the Anniversary boards), and rather
// than a key in `props`, because `props.enabled` is the Advanced page's PROPS
// row and life is not the forest. Each kind is one `editionFeatures()` path, so
// `vr.disable` can name one and the Advanced page can pin one.

/**
 * The quality FLOORS a life kind may name, in rising order: the first three of
 * `boot/settings.ts`'s `QUALITIES`. Not the ladder: `ultra` (DEV-581) is above
 * every floor and is not one, and `qualityAtLeast` compares on the whole ladder.
 */
export const LIFE_QUALITIES = ['low', 'medium', 'high'] as const
export type LifeQuality = (typeof LIFE_QUALITIES)[number]

/** One boat mesh — one draw call. */
export interface EditionLifeBoatKind {
  /** A name for the console line and the probe. */
  readonly id: string
  /** The converted mesh, as `assetUrl` takes it (`assets/life/…`). */
  readonly mesh: string
  /** Relative share of the fleet. 0 leaves the kind out. */
  readonly weight: number
  /** Uniform scale on the mesh as converted, `[min, max]`. */
  readonly scale: readonly [number, number]
  /** How far the keel sits under the water, in MESH metres (before `scale`). */
  readonly draft: number
}

/**
 * Moored and anchored boats on the sea — DEV-447. Placed by rule over the
 * course's own line and spawn (`sim/life/boats.ts`), floated on the facet the
 * sea is DRAWN with (`sim/life/sea-facet.ts`), drawn one instanced mesh per
 * kind (`render/life-boats.ts`). Never collide, never score.
 */
export interface EditionLifeBoats extends EditionFeature, Omit<BoatSpec, 'kinds'> {
  /** The lowest comfort quality that still draws them. Below it they are dropped. */
  readonly minQuality: LifeQuality
  /**
   * The placement fields (`seed`, the reaches, `depth`, `spacing`, `swing`,
   * `search`) are `BoatSpec`'s, so the sim and the preset cannot disagree about
   * them. A kind here also names its mesh and its draft.
   */
  readonly kinds: readonly EditionLifeBoatKind[]
}

/**
 * Animals that leap from the sea — DEV-449: the dolphins, one block, one
 * draw (the fish were a second block until DEV-545 cut them). polyfish's own models (Matt's), placed in pods by
 * rule (`sim/life/pods.ts`), leaping a ballistic arc that is a pure function
 * of the clock, from and into the water the shader drew.
 */
export interface EditionLifeLeapers extends EditionFeature, PodSpec {
  readonly minQuality: LifeQuality
  /** The converted mesh, as `assetUrl` takes it (`assets/life/…`). */
  readonly mesh: string
  /** m/s² the leap falls at — scenery's, not the sim's −32. */
  readonly gravity: number
  // The placement and leap fields (`seed`, the reaches, `depth`, `perPod`,
  // `period`, `height`, `length`, `scale`, `search`, `lineAbove`) are
  // `PodSpec`'s (`sim/life/pods.ts`), so the sim and the preset cannot drift.
  /**
   * DEV-532: the pod leaps together as the player comes at it, timed to put
   * the apex `apexAhead` metres off. Absent: the period alone, as DEV-449 drew.
   */
  readonly breach?: {
    readonly apexAhead: number
    readonly below: number
    readonly ahead: number
    readonly reach: number
    readonly minSpeed: number
    readonly stagger: number
    readonly rest: number
  }
}

export interface EditionLife {
  readonly note?: string
  readonly boats: EditionLifeBoats
  readonly dolphins: EditionLifeLeapers
}

/** `[min, max]` of two finite numbers with `floor <= min <= max`, or refused by name. */
const requireRange = (id: string, where: string, r: unknown, floor: number): void => {
  if (
    !Array.isArray(r) ||
    r.length !== 2 ||
    !r.every((v) => Number.isFinite(v)) ||
    (r[0] as number) < floor ||
    (r[0] as number) > (r[1] as number)
  ) {
    throw new EditionSchemaError(id, `${where} must be [min, max] with ${floor} <= min <= max`)
  }
}

/**
 * The life block. Refuses the holes that would draw nothing without saying
 * so: a kind with no mesh, a scale range upside down, a quality that is not
 * one of the three, a search that cannot move.
 */
const validateLife = (id: string, life: EditionLife | undefined): void => {
  const b = life?.boats
  if (!b) throw new EditionSchemaError(id, 'missing life.boats')
  if (!(LIFE_QUALITIES as readonly string[]).includes(b.minQuality)) {
    throw new EditionSchemaError(
      id,
      `life.boats.minQuality is not one of ${LIFE_QUALITIES.join(', ')}`,
    )
  }
  for (const key of ['alongRoute', 'atStart'] as const) {
    if (!Number.isInteger(b[key]) || b[key] < 0) {
      throw new EditionSchemaError(id, `life.boats.${key} must be a whole number of 0 or more`)
    }
  }
  requireRange(id, 'life.boats.routeReach', b.routeReach, 0)
  requireRange(id, 'life.boats.startReach', b.startReach, 0)
  requireRange(id, 'life.boats.depth', b.depth, 0)
  if (typeof b.startOpenWater !== 'boolean') {
    throw new EditionSchemaError(id, 'life.boats.startOpenWater must be true or false')
  }
  if (!(b.spacing >= 0) || !(b.swing >= 0)) {
    throw new EditionSchemaError(id, 'life.boats.spacing and swing must be 0 or more')
  }
  if (!(b.search?.step > 0) || !Number.isInteger(b.search?.angles) || !(b.search.angles >= 1)) {
    throw new EditionSchemaError(
      id,
      'life.boats.search needs a step above 0 and a whole number of angles',
    )
  }
  if (!Array.isArray(b.kinds) || b.kinds.length === 0) {
    throw new EditionSchemaError(id, 'life.boats.kinds must name at least one mesh')
  }
  for (const [i, k] of b.kinds.entries()) {
    if (typeof k.mesh !== 'string' || !k.mesh || typeof k.id !== 'string' || !k.id) {
      throw new EditionSchemaError(id, `life.boats.kinds[${i}] needs an id and a mesh`)
    }
    requireRange(id, `life.boats.kinds[${i}].scale`, k.scale, Number.MIN_VALUE)
    if (!(k.weight >= 0) || !(k.draft >= 0)) {
      throw new EditionSchemaError(id, `life.boats.kinds[${i}] weight and draft must be 0 or more`)
    }
  }
  validateLeapers(id, 'dolphins', life?.dolphins)
}

/** A leaping kind (DEV-449): the same refusals again, for a pod. */
const validateLeapers = (id: string, key: string, l: EditionLifeLeapers | undefined): void => {
  const where = `life.${key}`
  if (!l) throw new EditionSchemaError(id, `missing ${where}`)
  if (!(LIFE_QUALITIES as readonly string[]).includes(l.minQuality)) {
    throw new EditionSchemaError(
      id,
      `${where}.minQuality is not one of ${LIFE_QUALITIES.join(', ')}`,
    )
  }
  if (typeof l.mesh !== 'string' || !l.mesh) {
    throw new EditionSchemaError(id, `${where}.mesh must name the converted GLB`)
  }
  if (!(l.gravity > 0)) throw new EditionSchemaError(id, `${where}.gravity must be above 0`)
  for (const k of ['alongRoute', 'atStart'] as const) {
    if (!Number.isInteger(l[k]) || l[k] < 0) {
      throw new EditionSchemaError(id, `${where}.${k} must be a whole number of 0 or more`)
    }
  }
  requireRange(id, `${where}.routeReach`, l.routeReach, 0)
  requireRange(id, `${where}.startReach`, l.startReach, 0)
  requireRange(id, `${where}.perPod`, l.perPod, 0)
  requireRange(id, `${where}.period`, l.period, Number.MIN_VALUE)
  requireRange(id, `${where}.height`, l.height, 0)
  requireRange(id, `${where}.length`, l.length, Number.MIN_VALUE)
  requireRange(id, `${where}.scale`, l.scale, Number.MIN_VALUE)
  for (const k of ['depth', 'spacing', 'podRadius', 'swing'] as const) {
    if (!(l[k] >= 0)) throw new EditionSchemaError(id, `${where}.${k} must be 0 or more`)
  }
  if (!(l.search?.step > 0) || !Number.isInteger(l.search?.angles) || !(l.search.angles >= 1)) {
    throw new EditionSchemaError(
      id,
      `${where}.search needs a step above 0 and a whole number of angles`,
    )
  }
  if (l.lineAbove !== undefined && !(l.lineAbove >= 0)) {
    throw new EditionSchemaError(id, `${where}.lineAbove must be 0 or more`)
  }
  if (l.breach !== undefined) {
    const br = l.breach
    for (const k of ['apexAhead', 'reach', 'minSpeed', 'stagger', 'rest'] as const) {
      if (!(br?.[k] >= 0))
        throw new EditionSchemaError(id, `${where}.breach.${k} must be 0 or more`)
    }
    if (!(br.below > 0 && br.below < 90)) {
      throw new EditionSchemaError(id, `${where}.breach.below must be above 0 and under 90 degrees`)
    }
    if (!(br.ahead > 0 && br.ahead < 90)) {
      throw new EditionSchemaError(id, `${where}.breach.ahead must be above 0 and under 90 degrees`)
    }
  }
}
