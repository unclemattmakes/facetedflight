// src/render/cloud-look.ts — V5's whole maths: what the Anniversary preset does
// to a cloud. ANNIVERSARY.md §1.5 item 4 / §3.2 V5, DEV-090.
//
// ── The complaint, and what it actually is ────────────────────────────────
//
// ANNIVERSARY.md §1.3 item 4, from nine photographed frames: *"The clouds read
// as boulders. Opaque, hard-lit from one side, sharp silhouettes, no
// translucency at the edges. A 300 m cloud lit like rock, hanging 200 m above a
// 500 m peak, looks like a 30 m rock hanging 20 m up."*
//
// The give-away in `game/clouds.ts`'s own header is the diagnosis: the first
// pass *"looked exactly like the terrain, which is lit by the same sun and is
// the same colour"*. That is the whole problem stated. A cloud is not opaque and
// a rock is, so the two things a cloud does that a rock cannot are the two terms
// here — light rolls AROUND it instead of stopping at the terminator, and its
// thin edge glows when the sun is behind it.
//
// ── The wrap is not a stylisation, it is three's own diffuse re-derived ───
//
// three's `RE_Direct` for a standard material at metalness 0 is exactly
//
//     directDiffuse += saturate(dot(N, L)) * lightColor * albedo * RECIPROCAL_PI
//
// so a wrapped Lambert is the same expression with `saturate(dot(N,L))` replaced
// by `saturate((dot(N,L) + w) / (1 + w))`. This file adds the DIFFERENCE between
// those two, in the same units, with the same 1/pi — so the total is precisely
// the wrapped form and nothing has been invented. `lightColor` is the radiance
// three is handed, which on this game is `colorLinear * intensity * 2 * pi`
// (`MARMOSET_DIRECT_SCALE` — Marmoset's direct diffuse is `2 * dotNL * albedo *
// lightColor` and three's is that over pi), and `cloudSunRadiance` is the one
// place that is composed.
//
// Adding the difference rather than patching three's chunk is deliberate. The
// alternative is a string replace inside `lights_physical_pars_fragment`, which
// is three's own source, changes with every three release, and would apply to
// every material that shares that chunk. This touches one material and reads
// nothing of three's but its published BRDF.
//
// Two consequences worth stating rather than discovering:
//
//  * **Only the DIRECT term is wrapped.** The IBL ambient and `game/clouds.ts`'s
//    emissive floor are untouched, which is right: neither has a terminator.
//  * **A shadowed cloud would be wrong.** three multiplies `directLight.color`
//    by the shadow factor and this term does not know about it, so a cloud that
//    RECEIVED a shadow would get unshadowed wrap light. No cloud does —
//    `Mesh.receiveShadow` defaults to false and the clouds block never sets it,
//    and DEV-086's 700 m box does not reach 539 m of altitude anyway. If a cloud
//    ever becomes a receiver, this term has to take the shadow factor with it.
//
// ── The rim is a fresnel, gated on the sun being BEHIND the cloud ─────────
//
// §1.5 item 4 asks for *"translucent at the rim (light-wrap or a rim term, not a
// transparency pass)"*, and the reason it says "not a transparency pass" is that
// overdraw in VR is V5's named risk: nineteen bodies of up to 893 m, alpha
// blended, would be several full-screen layers of fill on a Quest. An opaque
// body with a bright edge costs nothing but the arithmetic below.
//
// A backlit cumulus edge is light that entered the far side and came out the
// near one, so it appears where the silhouette is AND where the sun is on the
// other side of the cloud from the eye. Both halves are in the term: a fresnel
// on `1 - N.V` for the silhouette, times how far the view ray is pointing at the
// sun. That second factor is remapped `0.5 + 0.5 * x` — the SAME half-Lambert
// remap the wrap uses, and for the same reason: at the hard version a cloud
// anywhere but in front of the sun has no edge at all, which is a rim you have
// to go looking for.
//
// ── Classic renders what it rendered, and it is arithmetic not a define ───
//
// One program: every value below is a uniform, so Classic and Anniversary
// compile the same source and `render/program-cache-key.ts`'s tag names one
// variant. What Classic has to be identical in is its OUTPUT, and it is —
// `cloudWrapLift` is `saturate((d + 0) / (1 + 0)) - saturate(d)`, which is
// exactly zero for every finite d, and `rimStrength` 0 multiplies the other term
// away. The added colour is `vec3(0.0)`, and adding that is exact. DEV-081's
// argument for uniforms over defines, DEV-082's for identity over "nearly
// nothing", and `tests/unit/cloud-look.test.ts` holds both with `toBe`.

import * as THREE from 'three'
import type { EditionClouds } from '@/content/edition-schema'
import type { SunLight } from '@/content/level-schema'
import type { EditionState } from '@/game/edition'
import { chainShaderPatch } from '@/render/program-cache-key'
import { MARMOSET_DIRECT_SCALE } from '@/render/skyshop-ibl'
import { clamp01 as saturate } from '@/sim/math/scalar'

/**
 * Rec. 709 luminance weights.
 *
 * NOT a tuning number and not from the preset, exactly as in `render/haze.ts`:
 * these are the luminance coefficients of the sRGB/Rec.709 primaries, which is
 * the working space three renders in. `sunTint` 0 has to mean "the same amount
 * of light, neutral in colour", and the only grey with the same amount of light
 * is the one at the colour's own luminance.
 */
export const CLOUD_LUMA: readonly [number, number, number] = Object.freeze([0.2126, 0.7152, 0.0722])

/**
 * `BRDF_Lambert`'s normalisation — three's own `RECIPROCAL_PI`.
 *
 * A mathematical constant, not tuning: it is the factor that makes a Lambertian
 * surface conserve energy, and it is here because the terms below are added to
 * the same `outgoingLight` three's `RE_Direct` wrote through it. Move it and the
 * wrap stops being three's diffuse and becomes a number somebody liked.
 */
export const RECIPROCAL_PI = 1 / Math.PI

/**
 * V5's tuning, resolved — the preset's four numbers plus the MISSION's sun.
 *
 * The split matters and is the reason they share one struct: the four knobs come
 * from `content/editions/<id>.json`, and `sunRadiance` / `toSun` come from the
 * level's `lighting.sun`, which is per-MISSION and not per-environment
 * (CLAUDE.md's gotcha, and `int_01_hoverJet` is lit from 4 degrees). Putting a
 * sun colour in the preset would make every mission's clouds lit by one sun,
 * which is exactly the bug the level JSON exists to prevent.
 */
export interface CloudLookSettings {
  /**
   * Half-Lambert wrap of the direct diffuse, 0..1.
   *
   * 0 is the hard terminator three gives a solid; 1 is the full half-Lambert
   * `(d + 1) / 2`, which is light rolling all the way around to the far side.
   */
  readonly wrap: number
  /** Peak rim at the silhouette, in the same units as the wrap: 1 is about a fully lit face. */
  readonly rimStrength: number
  /** Fresnel exponent. Higher is a thinner edge. Must be > 0 — it is an exponent. */
  readonly rimPower: number
  /** 0..1: how far the added light takes the sun's own colour rather than a neutral of the same luminance. */
  readonly sunTint: number
  /** LINEAR rgb radiance as three is handed it: `colorLinear * intensity * 2 * pi`. */
  readonly sunRadiance: readonly [number, number, number]
  /** Unit vector pointing AT the sun, three space — the NEGATED travel direction. */
  readonly toSun: readonly [number, number, number]
}

/**
 * No look at all — what Classic runs, and what a material gets before a preset
 * has been applied.
 *
 * `rimPower` is 1 rather than 0 so `pow` is never asked for `x^0`, which is 1
 * and would be a full-strength rim if the strength were ever non-zero. Belt and
 * braces, the way `classic.json`'s own comments put it.
 */
export const CLOUD_LOOK_OFF: CloudLookSettings = Object.freeze({
  wrap: 0,
  rimStrength: 0,
  rimPower: 1,
  sunTint: 0,
  sunRadiance: Object.freeze([0, 0, 0]) as readonly [number, number, number],
  toSun: Object.freeze([0, 1, 0]) as readonly [number, number, number],
})

/**
 * The extra N.L a wrapped Lambert has and a hard one does not.
 *
 * Non-negative everywhere and EXACTLY zero at `wrap = 0`: both halves are the
 * same `saturate`, so at w = 0 the expression is `saturate(d) - saturate(d)`.
 * It is zero again at d = 1 — the fully lit crown is untouched, which is why
 * this softens a terminator instead of washing a cloud out.
 */
export const cloudWrapLift = (dotNL: number, wrap: number): number =>
  saturate((dotNL + wrap) / (1 + wrap)) - saturate(dotNL)

/**
 * The fresnel rim, silhouette times backlighting.
 *
 * `toPoint` is the view ray — from the EYE to the surface, normalised — so
 * `dot(N, -toPoint)` is N.V and `dot(toPoint, toSun)` is how far the ray
 * continues toward the sun, i.e. how much the sun is behind the cloud.
 */
export const cloudRim = (
  normal: readonly [number, number, number],
  toPoint: readonly [number, number, number],
  s: CloudLookSettings,
): number => {
  const ndv = saturate(-(normal[0] * toPoint[0] + normal[1] * toPoint[1] + normal[2] * toPoint[2]))
  const sunFacing = saturate(
    0.5 + 0.5 * (toPoint[0] * s.toSun[0] + toPoint[1] * s.toSun[1] + toPoint[2] * s.toSun[2]),
  )
  return s.rimStrength * Math.max(0, 1 - ndv) ** s.rimPower * sunFacing
}

/**
 * The light this feature ADDS, in linear rgb — exactly `ff2CloudLook`'s return.
 *
 * `albedo` is the surface's own colour (`diffuseColor.rgb` at the injection
 * point, which at metalness 0 is what three's `material.diffuseColor` is too),
 * so the added light is tinted by the cloud rather than sprayed over it.
 *
 * Give it a unit `normal`, a unit `toPoint` from the eye to the surface, and
 * settings; get back what to add to `outgoingLight`.
 */
export const cloudLookAdd = (
  albedo: readonly [number, number, number],
  normal: readonly [number, number, number],
  toPoint: readonly [number, number, number],
  s: CloudLookSettings,
): [number, number, number] => {
  const dotNL = normal[0] * s.toSun[0] + normal[1] * s.toSun[1] + normal[2] * s.toSun[2]
  const amount = cloudWrapLift(dotNL, s.wrap) + cloudRim(normal, toPoint, s)
  const lum =
    s.sunRadiance[0] * CLOUD_LUMA[0] +
    s.sunRadiance[1] * CLOUD_LUMA[1] +
    s.sunRadiance[2] * CLOUD_LUMA[2]
  const k = amount * RECIPROCAL_PI
  return [
    k * albedo[0] * (lum + (s.sunRadiance[0] - lum) * s.sunTint),
    k * albedo[1] * (lum + (s.sunRadiance[1] - lum) * s.sunTint),
    k * albedo[2] * (lum + (s.sunRadiance[2] - lum) * s.sunTint),
  ]
}

/** `(wrap, rimStrength, rimPower, sunTint)` — the `uCloudLook` vec4, in the order the GLSL reads it. */
export const cloudLookPack = (s: CloudLookSettings): [number, number, number, number] => [
  s.wrap,
  s.rimStrength,
  s.rimPower,
  s.sunTint,
]

/**
 * The shader half, injected into the cloud material only.
 *
 * Mirrored by `cloudLookAdd` above, line for line, because a shader cannot be
 * unit tested without a GL context and a lighting term that is wrong on the
 * shadowed side looks exactly like an art choice (`render/haze.ts` says the same
 * about the middle distance).
 */
export const CLOUD_LOOK_GLSL = /* glsl */ `
uniform vec4 uCloudLook;  // (wrap, rimStrength, rimPower, sunTint)
uniform vec3 uCloudSun;   // LINEAR radiance: colorLinear * intensity * 2 * PI
uniform vec3 uCloudToSun; // unit, points AT the sun, three space

// What a cloud does that a rock cannot: light rolls around it, and its edge
// glows when the sun is behind. Added to outgoingLight in the SAME units three's
// RE_Direct wrote it, so the wrap term is three's own diffuse with a wrapped
// N.L rather than an invented brightness. Mirrored by cloudLookAdd() in
// render/cloud-look.ts, which is what the unit tests can reach.
vec3 ff2CloudLook(vec3 albedo, vec3 n, vec3 world) {
  // Classic: wrap 0 and rimStrength 0, so both terms are exactly zero. A
  // uniform branch — the whole draw takes the same side of it — so Classic does
  // not even pay for the normalize.
  if (uCloudLook.x <= 0.0 && uCloudLook.y <= 0.0) return vec3(0.0);
  float d = dot(n, uCloudToSun);
  // saturate BOTH halves, because that is what three's RE_Direct does to the
  // hard term and it is what makes wrap = 0 an identity rather than a rounding.
  float lift = clamp((d + uCloudLook.x) / (1.0 + uCloudLook.x), 0.0, 1.0) - clamp(d, 0.0, 1.0);
  vec3 toPoint = normalize(world - cameraPosition);
  float ndv = clamp(dot(n, -toPoint), 0.0, 1.0);
  float sunFacing = clamp(0.5 + 0.5 * dot(toPoint, uCloudToSun), 0.0, 1.0);
  float rim = uCloudLook.y * pow(max(1.0 - ndv, 0.0), uCloudLook.z) * sunFacing;
  float lum = dot(uCloudSun, vec3(${CLOUD_LUMA[0]}, ${CLOUD_LUMA[1]}, ${CLOUD_LUMA[2]}));
  vec3 tinted = mix(vec3(lum), uCloudSun, uCloudLook.w);
  return (lift + rim) * tinted * albedo * ${RECIPROCAL_PI};
}
`

// ── The placements, grown ─────────────────────────────────────────────────

/**
 * What the preset does to 2016's nineteen placements. §1.5 item 4: *"larger,
 * higher"*.
 *
 * Classic's values are 1 and 0, which are the identity in the exact sense — a
 * multiply by 1 and an add of 0 return the float they were given — so Classic's
 * clouds are byte-for-byte where `content/levels/*.json` puts them. That is what
 * "Faithful placement stays in Classic" (§3.2 V5) has to mean to be worth
 * writing down.
 */
export interface CloudPlacementSettings {
  /** Multiplies all THREE axes, so the authored flattening (y is 40-50 % of x) survives. */
  readonly scaleMultiplier: number
  /** METRES added to y. */
  readonly altitudeLift: number
}

export const CLOUD_PLACEMENT_OFF: CloudPlacementSettings = Object.freeze({
  scaleMultiplier: 1,
  altitudeLift: 0,
})

/** Drift: slow horizontal motion on the RENDER clock. */
export interface CloudDriftSettings {
  /** METRES PER SECOND along `direction`. 0 is a still sky. */
  readonly speed: number
  /** Direction of travel, three space. Normalised here, so it need not be a unit vector. */
  readonly direction: readonly [number, number, number]
}

export const CLOUD_DRIFT_OFF: CloudDriftSettings = Object.freeze({
  speed: 0,
  direction: Object.freeze([1, 0, 0]) as readonly [number, number, number],
})

/**
 * Where the wind has pushed a cloud after `elapsed` seconds.
 *
 * A pure function of the clock rather than an integrator, exactly like
 * DEV-089's `birdAt`: a paused second costs a cloud nothing, a dropped frame
 * costs it nothing, and two runs of `?snap=` land it in the same place for the
 * same elapsed time. Zero speed returns zeroes without normalising, so a
 * degenerate direction in a preset that does not drift cannot produce a NaN.
 *
 * UNBOUNDED, and that is a decision rather than an oversight. king-tide wraps
 * its field into a torus around the player because its clouds are scenery it
 * spawns; these are 2016's nineteen placements and moving one a kilometre from
 * where it was authored is already most of what the preset should ever do to it.
 * At the shipped speed a 180-second mission — the longest clock in the game —
 * moves a cloud less than its own width. Sit in one course for an hour and they
 * will have left; the elapsed clock is taken from the group's FIRST update
 * rather than from the app's, so "an hour" means an hour in one world and a
 * course switch (DEV-077) starts the sky again.
 */
export const cloudDriftOffset = (
  elapsed: number,
  d: CloudDriftSettings,
): [number, number, number] => {
  if (!(d.speed > 0) || !Number.isFinite(elapsed)) return [0, 0, 0]
  const [x, y, z] = d.direction
  const length = Math.hypot(x as number, y as number, z as number)
  if (!(length > 0)) return [0, 0, 0]
  const k = (d.speed * elapsed) / length
  return [(x as number) * k, (y as number) * k, (z as number) * k]
}

// ── Reading the preset, and the mission's sun ─────────────────────────────

/**
 * The preset's clouds block, as the JSON carries it.
 *
 * No colour here, which is the one thing worth noticing: every colour this
 * feature uses is already in the game — the sun's from `lighting.sun`, the
 * cloud's own from `GL-Tex-01.mat` in `game/clouds.ts` — so there is nothing to
 * pick and nothing to get wrong twice.
 */
export type CloudTuning = Pick<
  EditionClouds,
  | 'enabled'
  | 'wrap'
  | 'rimStrength'
  | 'rimPower'
  | 'sunTint'
  | 'emissive'
  | 'scaleMultiplier'
  | 'altitudeLift'
  | 'driftSpeed'
  | 'driftDirection'
  | 'singleSided'
>

/**
 * The radiance three is handed for this sun, which is what the wrap term has to
 * be measured in.
 *
 * `colorLinear` times `marmosetSunIntensity(intensity)` — composed here rather
 * than restated, because `MARMOSET_DIRECT_SCALE` is the 2 pi Marmoset's direct
 * diffuse carries and `boot/app.ts`'s `applyLighting` hands three exactly that
 * product. If the two ever disagree the wrap stops being three's own diffuse,
 * which is why `tests/unit/cloud-look.test.ts` holds this against a real
 * `THREE.DirectionalLight` built the way the app builds one.
 */
export const cloudSunRadiance = (sun: SunLight | null): [number, number, number] => {
  if (!sun) return [0, 0, 0]
  const k = sun.intensity * MARMOSET_DIRECT_SCALE
  return [sun.colorLinear[0] * k, sun.colorLinear[1] * k, sun.colorLinear[2] * k]
}

/** The unit vector pointing AT the sun. `SunLight.direction` is the way light TRAVELS. */
export const cloudToSun = (sun: SunLight | null): [number, number, number] => {
  if (!sun) return [0, 1, 0]
  const [x, y, z] = sun.direction
  const length = Math.hypot(x, y, z)
  if (!(length > 0)) return [0, 1, 0]
  return [-x / length, -y / length, -z / length]
}

/**
 * Resolve a preset block and a mission sun into what the shader wants.
 *
 * `null` for the tuning is "the feature is off", and it returns `CLOUD_LOOK_OFF`
 * rather than the preset's numbers with the flag ignored — so Classic's values
 * are unobservable and cannot become load-bearing by accident. The same contract
 * `attachEditionHaze` and `attachEditionCoast` keep.
 */
/**
 * Which faces a cloud draws, as one named rule. DEV-276.
 *
 * `null` is Classic, and Classic is `DoubleSide` -- the answer the port has
 * always drawn. Named and exported rather than written inline so the test pins
 * the VALUE somebody has to edit on purpose (DEV-266), and so the one place
 * that decides this is greppable.
 */
/**
 * The cloud whiteout envelope: INSTANT in, soft out. DEV-277.
 *
 * Matt, 2026-09-21: *"let us fade to white immediately when entering and softly
 * fade out when you exit."* The asymmetry is the whole feature, so it is one
 * pure function with the two halves visible side by side rather than a lerp
 * with a direction flag.
 *
 * IN is a jump to `level`, not a ramp: a cloud boundary is a surface, you cross
 * it in one frame at 90 m/s, and anything that eases in would read as the fog
 * arriving LATE, which is the complaint this replaces (*"they should hit
 * faster"*).
 *
 * OUT is linear over `releaseSeconds` rather than exponential. An exponential
 * never reaches zero, so the last few per cent of white would sit over the
 * world indefinitely and every frame after a cloud would be very slightly
 * milky; linear lands on 0 and stays there. `dt` is the RENDER frame, because
 * this is ambience and nothing under `src/sim/` can see a cloud.
 *
 * Total and pure: no clamping surprises, `level` 0 disables it by arithmetic
 * rather than by a branch somewhere else.
 */
export const whiteoutStep = (
  current: number,
  inside: boolean,
  dt: number,
  releaseSeconds: number,
  level: number,
): number => {
  const target = Math.min(1, Math.max(0, level))
  if (inside) return target
  if (!(releaseSeconds > 0)) return 0
  const step = (dt > 0 ? dt : 0) / releaseSeconds
  return Math.min(target, Math.max(0, current - step))
}

export const cloudMaterialSide = (tuning: CloudTuning | null): THREE.Side =>
  tuning?.singleSided ? THREE.FrontSide : THREE.DoubleSide

export const cloudLookSettings = (
  t: CloudTuning | null,
  sun: SunLight | null,
): CloudLookSettings =>
  t === null
    ? CLOUD_LOOK_OFF
    : {
        wrap: t.wrap,
        rimStrength: t.rimStrength,
        rimPower: t.rimPower,
        sunTint: t.sunTint,
        sunRadiance: cloudSunRadiance(sun),
        toSun: cloudToSun(sun),
      }

/** Resolve the placement half. `null` is Classic: 2016's numbers, untouched. */
export const cloudPlacementSettings = (t: CloudTuning | null): CloudPlacementSettings =>
  t === null
    ? CLOUD_PLACEMENT_OFF
    : { scaleMultiplier: t.scaleMultiplier, altitudeLift: t.altitudeLift }

/** Resolve the drift half. `null` is Classic: a still sky, as 2016's was. */
export const cloudDriftSettings = (t: CloudTuning | null): CloudDriftSettings =>
  t === null
    ? CLOUD_DRIFT_OFF
    : {
        speed: t.driftSpeed,
        direction: [
          (t.driftDirection[0] as number) ?? 0,
          (t.driftDirection[1] as number) ?? 0,
          (t.driftDirection[2] as number) ?? 0,
        ],
      }

// ── The material patch ────────────────────────────────────────────────────

/** The three uniforms `CLOUD_LOOK_GLSL` reads, as a block the shader can be handed. */
export interface CloudLookUniforms {
  readonly uCloudLook: { value: THREE.Vector4 }
  readonly uCloudSun: { value: THREE.Color }
  readonly uCloudToSun: { value: THREE.Vector3 }
}

/**
 * A uniform block built OFF, whatever preset is live.
 *
 * The same rule `unity-fog.ts` builds its haze uniforms under: the cloud field
 * exists before the edition is asked, and a term that defaulted to ON would make
 * the order of two unrelated boot steps visible in the picture.
 */
export const cloudLookUniforms = (): CloudLookUniforms => ({
  uCloudLook: { value: new THREE.Vector4(...cloudLookPack(CLOUD_LOOK_OFF)) },
  uCloudSun: { value: new THREE.Color(0, 0, 0) },
  uCloudToSun: { value: new THREE.Vector3(0, 1, 0) },
})

/** Write resolved settings into a uniform block. One call reaches every mesh sharing it. */
export const writeCloudLookUniforms = (u: CloudLookUniforms, s: CloudLookSettings): void => {
  u.uCloudLook.value.set(...cloudLookPack(s))
  u.uCloudSun.value.setRGB(s.sunRadiance[0], s.sunRadiance[1], s.sunRadiance[2])
  u.uCloudToSun.value.set(s.toSun[0], s.toSun[1], s.toSun[2])
}

/**
 * Patch the look into the one shared cloud material. DEV-090.
 *
 * ── The order this chains in, and why it is not arbitrary ────────────────
 *
 * `unity-fog.ts` patches the same `#include <opaque_fragment>` hook, and a
 * chained `onBeforeCompile` runs `previous` FIRST — so the patch registered
 * first does its `String.replace` first, and `replace` with a string pattern hits
 * the FIRST occurrence. The earlier registration therefore lands its block
 * FURTHEST from the hook, i.e. earliest in the shader. This must go on BEFORE
 * `fog.applyTo`, which gives the running order
 *
 *     cloud look  ->  aerial haze (DEV-082)  ->  the mission fog
 *
 * and that is the order the physics happens in: the cloud emits, the air between
 * takes some of it out of the ray, and the sky is mixed over the result. **The
 * fog gets the last word**, which is DEV-030's whole point — a cloud at 3 km has
 * to fade into the sky behind it whatever this term did to it. `render/
 * dressing.ts` records the same trap from the vertex side, where getting it
 * backwards was worth two metres and nobody would ever have seen it; here it
 * would be a rim painted over the fog, which you would see immediately and
 * misread as the rim being too strong.
 *
 * ONE program, gated on uniforms, so a preset flip is a uniform write and not a
 * recompile — DEV-081's argument, and the reason this can be re-pushed from
 * `editionState.subscribe` in the middle of a run.
 */
export const applyCloudLook = (material: THREE.Material, uniforms: CloudLookUniforms): void => {
  // Without this the patched material shares a compiled program with any other
  // `MeshStandardMaterial` carrying the same parameters — see
  // `render/program-cache-key.ts`, where that cost two sessions. ONE constant
  // token: every branch in `CLOUD_LOOK_GLSL` is on a uniform, so there is exactly
  // one variant of this source and Classic compiles the same program.
  // No once-set: the only caller passes a freshly built material.
  chainShaderPatch(material, {
    tag: 'cloud-look',
    uniforms,
    // The world position, off the same `transformed` the fog reads — but its OWN
    // varying under its own name, so the two patches cannot collide and neither
    // depends on the other having run. Every cloud shares this material, so the
    // world position has to be per-vertex.
    //
    // DEV-785: the clouds are `InstancedMesh`es now (the variant pool), and at
    // `begin_vertex` `transformed` is still in the blob's own frame: three applies
    // `instanceMatrix` later, in `project_vertex`. Reading `modelMatrix *
    // transformed` alone would put every cloud's rim and wrap at the origin of
    // the pool member's mesh, which is DEV-096's bug (unity-fog.ts) in a second
    // patch. Gated on three's own `USE_INSTANCING` define, which is already in
    // its program cache key, so no new variant and no new tag.
    vertex: (source) =>
      `varying vec3 vCloudWorldPos;\n${source}`.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
  {
    vec4 ff2CloudLocal = vec4(transformed, 1.0);
    #ifdef USE_INSTANCING
      ff2CloudLocal = instanceMatrix * ff2CloudLocal;
    #endif
    vCloudWorldPos = (modelMatrix * ff2CloudLocal).xyz;
  }`,
      ),
    fragment: (source) =>
      `
varying vec3 vCloudWorldPos;
${CLOUD_LOOK_GLSL}
${source}`.replace(
        '#include <opaque_fragment>',
        `{
  // ── what a cloud does that a rock cannot (DEV-090) ──────────────────
  //
  // ADDED to the light three's own lighting produced, in three's own units.
  // \`normal\` is the face normal AFTER \`normal_fragment_begin\` has flipped it
  // for a back face, which is the same normal the lighting used — so a
  // DoubleSide cloud's far side wraps consistently with its near one.
  // \`diffuseColor.rgb\` is the albedo (metalness is 0, so it is also three's
  // own \`material.diffuseColor\`), which keeps the added light the cloud's warm
  // near-white rather than a grey wash.
  //
  // Zero contribution on Classic: wrap and rimStrength are both 0, the function
  // returns \`vec3(0.0)\`, and adding that is exact.
  //
  // Its own block, so the haze and fog chunks that land below it are untouched
  // byte for byte by this feature.
  outgoingLight += ff2CloudLook(diffuseColor.rgb, normal, vCloudWorldPos);
}
#include <opaque_fragment>`,
      ),
  })
}

/** Anything that can be handed a cloud look. `LoadedClouds` is the only implementation. */
export interface CloudLookTarget {
  setCloudLook(tuning: CloudTuning | null): void
}

/**
 * Wire a cloud field to the live preset: set it now, and again on every flip.
 *
 * Returns the unsubscribe, which `game/clouds.ts` calls from `dispose` — unlike
 * the haze and the coast, a cloud field is rebuilt per level (`buildWorld` calls
 * `loadClouds`), so a field that stayed subscribed after `teardownWorld` would
 * be a listener per course switch (DEV-077) writing uniforms on a disposed
 * material.
 */
export const attachEditionClouds = (
  target: CloudLookTarget,
  editionState: EditionState,
): (() => void) => {
  const push = (): void => {
    const c = editionState.current.render.clouds
    target.setCloudLook(c.enabled ? c : null)
  }
  push()
  return editionState.subscribe(push)
}
