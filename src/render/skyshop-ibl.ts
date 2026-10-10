// src/render/skyshop-ibl.ts — the 2016 ambient light, recovered from nine numbers.
//
// ── What this is ──────────────────────────────────────────────────────────
//
// Every lit surface in Faceted Flight uses a Marmoset Skyshop shader. The
// terrain is `Marmoset/Vertex Color/Specular IBL`, which defines
// MARMO_DIFFUSE_IBL and takes NO light from Unity's ambient at all — its whole
// ambient term is
//
//     Emission += SHLookup(skyRotate(_SkyMatrix, N)) * Albedo * _ExposureIBL.x
//                                      (MarmosetSurf.cginc:524)
//
// and `SHLookup` is nine RGB spherical-harmonic coefficients pushed as shader
// globals by one `Sky` component on `LevelArt_SimonetIslands/sky/ibl_sky`
// (Sky.cs:331). Without it the world is lit by the sun alone and every surface
// facing away from it is black — which is not what the 2016 screenshots show.
//
// The coefficients were BAKED into the prefab, so they survived the cubemaps
// that produced them. That matters twice over: those cubemaps are Marmoset
// Asset Store demo assets we can never ship (CLAUDE.md rule 7), and a baked SH
// is a *measurement* of a sky rather than the sky itself. Nine numbers are the
// whole ambient light of the 2016 game, and we have them exactly.
//
// ── Three coordinate changes, all of them real ────────────────────────────
//
// The coefficients cannot be handed to three as they stand. Three separate
// things differ, and each one is silent if you get it wrong:
//
//  1. **Radiance, not irradiance.** Marmoset's `sEquationConstants` are the
//     bare real-SH basis constants with no cosine lobe folded in, so
//     `SHLookup(N)` reconstructs the sky's RADIANCE in direction N. three's
//     `shGetIrradianceAt` applies the Lambert convolution (A_l = 1, 2/3, 1/4)
//     and a factor of pi. Skip the correction and bands 1 and 2 come out 1.5x
//     and 4x too weak — the sky flattens toward its average colour, which reads
//     as "the lighting is fine but somehow dead".
//
//  2. **Handedness.** Our world is Unity's mirrored in z (`unity-space.ts`).
//     A sky is not symmetric about that plane.
//
//  3. **The sky object is ROTATED.** `Sky.UpdateSkyTransform()` builds
//     `_SkyMatrix` from `ibl_sky`'s transform and `skyRotate()` multiplies the
//     normal by its TRANSPOSE (MarmosetCore.cginc:304-309), so the lookup
//     happens in sky space. On Simonet that transform is 139 degrees of yaw.
//     Ignore it and the light comes from the wrong side of the island.
//
// All three are composed here into one 3x3 map and applied to the coefficients
// analytically — exactly, with no quadrature and no tolerance to tune. The
// tests check the result against a direct transcription of Marmoset's own
// `SHLookup`, which is the only oracle that matters.
//
// ── What is NOT here ──────────────────────────────────────────────────────
//
// The specular half. `_SpecCubeIBL` was `castle_SPEC.cubemap`, which we cannot
// ship, so FF2's specular IBL is its own sky (DEV-013). The diffuse half — the
// one that decides what colour the world is — is exact.

import * as THREE from 'three'

/**
 * Marmoset's SH normalisation constants (`Skyshop/Script/SHEncoding.cs`).
 *
 * `copyToBuffer()` does `cBuffer[i] = c[i] * sEquationConstants[i]`, and these are exactly the
 * textbook real-SH basis constants — Y00, the three Y1m, the five Y2m. That identity is what makes
 * the 2016 numbers portable: `c` is a standard SH projection, not a Marmoset format. The extractor
 * cross-checks it against the serialised `cBuffer` on every run.
 */
export const SH_BASIS_CONSTANT: readonly number[] = [
  0.28209479, 0.4886025, 0.4886025, 0.4886025, 1.09254843, 1.09254843, 0.315391565, 1.09254843,
  0.546274215,
]

/**
 * The Lambert cosine-lobe coefficients, per band.
 *
 * Convolving a radiance SH with a clamped cosine multiplies band l by A_l. three's
 * `shGetIrradianceAt` has these baked into its literals; Marmoset's `SHLookup` does not have them
 * at all. Dividing them out is what lets one set of coefficients drive the other's evaluator.
 */
const LAMBERT_A: readonly number[] = [1, 2 / 3, 2 / 3, 2 / 3, 1 / 4, 1 / 4, 1 / 4, 1 / 4, 1 / 4]

/**
 * The nine polynomials Marmoset's `SHLookup` evaluates, in its order
 * (MarmosetCore.cginc:357-376).
 *
 * `Y_i = SH_BASIS_CONSTANT[i] * basis_i`. Note index 6 is `3z^2 - 1`, not `z^2` — the `-1` is why
 * a mismatched convention shows up as a constant colour shift rather than an obvious break.
 */
const shBasis = (x: number, y: number, z: number): number[] => [
  1,
  y,
  z,
  x,
  x * y,
  y * z,
  3 * z * z - 1,
  x * z,
  x * x - y * y,
]

/** The 27 serialised floats, split into nine RGB triples. */
export const shTriples = (c: readonly number[]): number[][] => {
  if (c.length !== 27) throw new Error(`skyshop: expected 27 SH floats, got ${c.length}`)
  return Array.from({ length: 9 }, (_, i) => [
    c[i * 3] as number,
    c[i * 3 + 1] as number,
    c[i * 3 + 2] as number,
  ])
}

/**
 * Marmoset's `SHLookup`, transcribed.
 *
 * THE ORACLE. Everything below transforms coefficients so that three's evaluator reproduces this
 * function; the tests hold the two side by side. `dir` is in SKY space — the caller applies
 * `skyRotate` — and the `abs()` at the end is Marmoset's, not a safety clamp.
 */
export const marmosetShLookup = (
  c: readonly number[],
  dir: readonly [number, number, number],
): [number, number, number] => {
  const triples = shTriples(c)
  const b = shBasis(dir[0], dir[1], dir[2])
  const out: [number, number, number] = [0, 0, 0]
  for (let i = 0; i < 9; i++) {
    const k = SH_BASIS_CONSTANT[i] as number
    const t = triples[i] as number[]
    const w = (b[i] as number) * k
    out[0] += (t[0] as number) * w
    out[1] += (t[1] as number) * w
    out[2] += (t[2] as number) * w
  }
  return [Math.abs(out[0]), Math.abs(out[1]), Math.abs(out[2])]
}

/* ---------------------------------------------------------------------------------------------
 * Substituting a linear map into the basis.
 *
 * A degree-<=2 polynomial in (x, y, z) is ten numbers: the constant, three linear terms and six
 * quadratic ones. Substituting `d -> A d` into each basis polynomial gives another degree-<=2
 * polynomial, which can be written back in the same basis using x^2 + y^2 + z^2 = 1. That is the
 * whole trick, and it is exact — no sampling, no least squares.
 * ------------------------------------------------------------------------------------------- */

/** `[1, x, y, z, xx, yy, zz, xy, yz, zx]`. */
type Monomials = number[]

const zeroMonomials = (): Monomials => [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]

/** The product of two linear forms `p . d` and `q . d`, as monomials. */
const linearProduct = (p: readonly number[], q: readonly number[]): Monomials => {
  const m = zeroMonomials()
  m[4] = (p[0] as number) * (q[0] as number)
  m[5] = (p[1] as number) * (q[1] as number)
  m[6] = (p[2] as number) * (q[2] as number)
  m[7] = (p[0] as number) * (q[1] as number) + (p[1] as number) * (q[0] as number)
  m[8] = (p[1] as number) * (q[2] as number) + (p[2] as number) * (q[1] as number)
  m[9] = (p[2] as number) * (q[0] as number) + (p[0] as number) * (q[2] as number)
  return m
}

const linear = (p: readonly number[]): Monomials => {
  const m = zeroMonomials()
  m[1] = p[0] as number
  m[2] = p[1] as number
  m[3] = p[2] as number
  return m
}

const addScaled = (a: Monomials, b: Monomials, s: number): Monomials =>
  a.map((v, i) => v + (b[i] as number) * s)

/**
 * Write a degree-<=2 polynomial back in the nine-function basis.
 *
 * The three squared terms are the only interesting part. On the unit sphere they are not
 * independent — `x^2 + y^2 + z^2 = 1` — so `a*x^2 + b*y^2 + g*z^2` collapses onto the constant,
 * `3z^2 - 1` and `x^2 - y^2`:
 *
 *   z^2      = (B6 + 1) / 3
 *   x^2      = ((1 - z^2) + B8) / 2
 *   y^2      = ((1 - z^2) - B8) / 2
 *
 * A polynomial whose degree-1 part survives untouched and whose degree-2 part folds like this is
 * exactly why an order-2 SH is closed under rotation.
 */
const monomialsToBasis = (m: Monomials): number[] => {
  const [k, x, y, z, xx, yy, zz, xy, yz, zx] = m as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  const half = (xx + yy) / 2
  const b6 = (zz - half) / 3
  return [
    // constant: the caller's own constant, plus what the squared terms left behind
    k + half + b6,
    y,
    z,
    x,
    xy,
    yz,
    b6,
    zx,
    (xx - yy) / 2,
  ]
}

/**
 * The 9x9 matrix `T` with `Y_i(A d) = sum_j T[i][j] Y_j(d)`.
 *
 * `A` is row-major. Any 3x3 works, but only orthogonal ones keep the result meaningful — an
 * improper rotation (a mirror, which is exactly what our handedness change is) is fine.
 */
const basisTransform = (A: readonly (readonly number[])[]): number[][] => {
  const ux = A[0] as readonly number[]
  const uy = A[1] as readonly number[]
  const uz = A[2] as readonly number[]

  const constant = zeroMonomials()
  constant[0] = 1

  // B6(u) = 3 uz^2 - 1
  const b6 = addScaled(zeroMonomials(), linearProduct(uz, uz), 3)
  b6[0] = (b6[0] as number) - 1
  // B8(u) = ux^2 - uy^2
  const b8 = addScaled(linearProduct(ux, ux), linearProduct(uy, uy), -1)

  const substituted: Monomials[] = [
    constant,
    linear(uy),
    linear(uz),
    linear(ux),
    linearProduct(ux, uy),
    linearProduct(uy, uz),
    b6,
    linearProduct(ux, uz),
    b8,
  ]

  // Y_i = k_i * B_i, so a row expressed in B needs rescaling on both sides to be expressed in Y.
  return substituted.map((m, i) => {
    const inB = monomialsToBasis(m)
    const ki = SH_BASIS_CONSTANT[i] as number
    return inB.map((v, j) => (v * ki) / (SH_BASIS_CONSTANT[j] as number))
  })
}

/* ------------------------------------------------------------------------------------------- */

export interface SkyshopIbl {
  /** The 27 serialised floats, Unity/sky space, straight from the sheet. */
  readonly sh: readonly number[]
  /** `ibl_sky`'s local rotation, Unity convention `(x, y, z, w)`. */
  readonly rotationUnity: readonly number[]
  /** `_ExposureIBL`. Only `.diffuse` is used here; `.specular` belongs to the env map. */
  readonly exposure: { readonly diffuse: number; readonly specular: number }
}

/**
 * The nine coefficients three needs, in three's world space.
 *
 * Composes all three corrections in one place:
 *
 *   d_unity = M d_three           M = diag(1, 1, -1), the handedness mirror
 *   d_sky   = R^T d_unity         R = ibl_sky's rotation, per `skyRotate`
 *   A       = R^T M
 *
 * then re-expresses `f(A d)` in the same basis and divides out the Lambert lobe so that three's
 * `shGetIrradianceAt(N) / pi` reproduces Marmoset's `SHLookup(skyRotate(N))` exactly.
 */
export const skyshopCoefficients = (ibl: SkyshopIbl): THREE.SphericalHarmonics3 => {
  const [qx, qy, qz, qw] = ibl.rotationUnity as [number, number, number, number]
  // The quaternion is Unity's, applied to Unity-space vectors — same algebra, so three's
  // quaternion-to-matrix is the right tool and no flip belongs here. The flip is `mirror`, below.
  const R = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(qx, qy, qz, qw))
  const mirror = new THREE.Matrix4().makeScale(1, 1, -1)
  const m = new THREE.Matrix4().copy(R).transpose().multiply(mirror)
  const e = m.elements // column-major
  const A = [
    [e[0] as number, e[4] as number, e[8] as number],
    [e[1] as number, e[5] as number, e[9] as number],
    [e[2] as number, e[6] as number, e[10] as number],
  ]

  const T = basisTransform(A)
  const source = shTriples(ibl.sh)
  const sh = new THREE.SphericalHarmonics3()

  for (let j = 0; j < 9; j++) {
    let r = 0
    let g = 0
    let b = 0
    for (let i = 0; i < 9; i++) {
      const w = (T[i] as number[])[j] as number
      const t = source[i] as number[]
      r += (t[0] as number) * w
      g += (t[1] as number) * w
      b += (t[2] as number) * w
    }
    // Undo the cosine lobe three is about to apply. Without this, bands 1 and 2 arrive 1.5x and
    // 4x too weak and the sky collapses toward flat ambient.
    const inv = 1 / (LAMBERT_A[j] as number)
    ;(sh.coefficients[j] as THREE.Vector3).set(r * inv, g * inv, b * inv)
  }
  return sh
}

/**
 * A probe from a RADIANCE SH projected in Unity space — i.e. from the sky the
 * game actually shows, rather than the one its ambient was baked from.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * `ibl_sky` names `castle_BLUR.cubemap`, that file was overwritten in April 2016
 * with Matt's own orange sunset, and the 27 baked SH floats match NEITHER — they
 * are less warm than the file by a non-uniform 0.51/0.61/0.66, so they were baked
 * from an earlier sky and never re-baked. The shipped game is therefore lit by a
 * near-neutral grey ambient under a warm sunset sky, and FF2 reproduces that
 * faithfully (see docs/DEVIATIONS.md).
 *
 * This is the other option: take the nine coefficients `tools/extract/sky.mjs`
 * projects from the mission's VISIBLE skybox and light from those instead. It is
 * a deviation, not a correction — 2016 shipped the mismatch — so it lives behind
 * a switch rather than replacing the faithful path.
 *
 * ── The two conversions, which are the whole job ──────────────────────────
 *
 * 1. **The mirror.** The coefficients are in UNITY space and three's world is
 *    that mirrored in z. In this basis order only the three functions with an
 *    ODD power of z change sign: index 2 (z), 5 (yz) and 7 (xz). 6 is
 *    `3z^2 - 1` and is even, which is exactly the one a hand-written flip gets
 *    wrong.
 * 2. **The cosine lobe.** `THREE.LightProbe` applies Lambert's `A_l` on the way
 *    out, so a RADIANCE projection has to be divided by it first or bands 1 and
 *    2 arrive 1.5x and 4x too weak — the same correction `skyshopCoefficients`
 *    makes, for the same reason.
 */
export const probeFromSkyRadiance = (
  sh: readonly (readonly number[])[],
  intensity = 1,
): THREE.LightProbe => {
  const out = new THREE.SphericalHarmonics3()
  // Odd in z: these flip. See the note above.
  const FLIP_Z = new Set([2, 5, 7])
  for (let i = 0; i < 9; i++) {
    const c = sh[i] ?? [0, 0, 0]
    const sign = FLIP_Z.has(i) ? -1 : 1
    const inv = sign / (LAMBERT_A[i] as number)
    ;(out.coefficients[i] as THREE.Vector3).set(
      (c[0] as number) * inv,
      (c[1] as number) * inv,
      (c[2] as number) * inv,
    )
  }
  const probe = new THREE.LightProbe(out, intensity)
  probe.name = 'sky-radiance-ibl'
  return probe
}

/**
 * The 2016 ambient light, as a three light.
 *
 * `intensity` is `_ExposureIBL.x` = `masterIntensity * diffIntensity` (Sky.cs:582), which the
 * shader multiplies the SH by before it reaches Albedo. Keeping it on the light rather than folded
 * into the coefficients means the sheet's number is visible in a debugger.
 *
 * NOTE: an `envMap` on a `MeshStandardMaterial` ALSO contributes diffuse irradiance in three, so a
 * material lit by this probe must suppress that or the ambient is counted twice — see
 * `suppressEnvMapDiffuse`.
 */
export const createSkyshopProbe = (ibl: SkyshopIbl): THREE.LightProbe => {
  const probe = new THREE.LightProbe(skyshopCoefficients(ibl), ibl.exposure.diffuse)
  probe.name = 'skyshop-ibl'
  return probe
}

/**
 * Adopt Marmoset's split lighting model for the whole app: **env maps supply specular only.**
 *
 * ── The double-count this exists to stop ──────────────────────────────────
 *
 * 2016 fed the two halves of image-based lighting from two different places with two different
 * intensities — the SH at `_ExposureIBL.x` (0.5974 on Simonet) and the cubemap at
 * `_ExposureIBL.y` (1.03). three's standard material takes both from ONE env map scaled by ONE
 * `envMapIntensity`, so the moment a light probe joins a scene that has `scene.environment` set,
 * the ambient arrives twice: once correctly from the probe, once again from the env map's
 * blurriest mip. The result is a world that is roughly twice as bright as it should be in shadow
 * and impossible to fix by turning either source down, because turning the env map down also
 * kills the reflections.
 *
 * ── Why this is global rather than per-material ───────────────────────────
 *
 * Because it is not a workaround for one material, it is the lighting model of the game being
 * ported. Every lit surface in Faceted Flight uses a Marmoset Skyshop shader, and all of them
 * split diffuse (SH) from specular (cubemap) this way. Stating it once, at boot, is more honest
 * than opting each material in and forgetting one.
 *
 * `iblIrradiance` is the diffuse half of three's env-map contribution and `radiance` is the
 * specular half; only the first is dropped. Idempotent, so calling it twice is harmless.
 */
let lightingModelInstalled = false
/**
 * Unity light intensity -> `THREE.DirectionalLight.intensity`, for a Marmoset
 * surface. It is **2 pi**, and the port was running without it.
 *
 * ── What Marmoset's direct diffuse actually is ────────────────────────────
 *
 * `MarmosetDirect.cginc`, the per-pixel path the terrain compiles
 * (`MARMO_DIFFUSE_DIRECT`, `#pragma surface MarmosetSurf MarmosetDirect`):
 *
 *   half dp = saturate(dot(N,L));
 *   half3 diff = (2.0 * dp) * s.Albedo.rgb;   //*2.0 to match Unity
 *   frag.rgb = diff * lightColor;
 *
 * So the shipped term is `2 * dotNL * albedo * colorLinear * intensity`. The
 * comment is Marmoset's own: Unity's forward-base convention of the day folded
 * a 2x into `atten`, and Skyshop matched it.
 *
 * ── What three does ──────────────────────────────────────────────────────
 *
 *   irradiance = dotNL * directLight.color            // lights_physical
 *   directDiffuse += irradiance * BRDF_Lambert(c)     // = RECIPROCAL_PI * c
 *
 * and `directLight.color` is `light.color * light.intensity`. So three gives
 * `dotNL * albedo * color * intensity / pi`.
 *
 * Setting the two equal: **`intensity_three = 2 * pi * intensity_unity`**.
 *
 * ── Why this was invisible, and why it matters so much here ──────────────
 *
 * `int_01_hoverJet`'s sun is **4 degrees above the horizon**. An upward-facing
 * facet has `dotNL` of about 0.07, so the sun contributes almost nothing to
 * flat ground either way and the error hides. What it does NOT hide on is the
 * slopes that face the sun, which is the entire visible shape of a mountain —
 * and running 2 pi light, the whole massif collapsed into the ambient, which on
 * this mission is blue from above (0.313, 0.345, 0.400 at an up normal). That
 * is why the terrain read grey-mauve where the 2016 shots are tan.
 *
 * Matt, on his own reference: *"it looks like the lighting is stronger overall
 * too (note the shadows on the mtn on shot 2)."* He was right, and this is the
 * number.
 *
 * ── The AMBIENT needs no such factor, and that is not luck ───────────────
 *
 * `getLightProbeIrradiance` returns `shGetIrradianceAt(...) * intensity`, and
 * `shGetIrradianceAt` carries a pi that `BRDF_Lambert` divides straight back
 * out. Indirect diffuse therefore lands on `SHLookup * exposure * albedo` —
 * Marmoset's `o.lighting.rgb += diffuseIBL * exposureIBL.x`, exactly. The
 * 512-direction test in `tests/unit/skyshop-ibl.test.ts` is a check of that.
 *
 * ── Not the water ────────────────────────────────────────────────────────
 *
 * The sea is a VacuumShaders legacy shader on Unity's stock
 * `LightingBlinnPhong`, which has **no** 2x, and it is drawn by our own
 * `ShaderMaterial` with its own `uSunColor` rather than by this light. It is
 * unaffected, and correctly so.
 */
export const MARMOSET_DIRECT_SCALE = 2 * Math.PI

/** `intensity_unity` -> the number to hand `THREE.DirectionalLight`. */
export const marmosetSunIntensity = (unityIntensity: number): number =>
  unityIntensity * MARMOSET_DIRECT_SCALE

export const useSkyshopLightingModel = (): void => {
  if (lightingModelInstalled) return
  const chunk = THREE.ShaderChunk.lights_fragment_maps
  if (!chunk.includes('iblIrradiance')) {
    throw new Error(
      'skyshop: three’s lights_fragment_maps no longer mentions iblIrradiance — the ambient would be counted twice',
    )
  }
  THREE.ShaderChunk.lights_fragment_maps = `${chunk}
// ---- FF2 --------------------------------------------------------------------
// Marmoset Skyshop takes DIFFUSE from spherical harmonics and SPECULAR from the
// cubemap, with separate intensities. Our light probe is the diffuse half, so an
// env map must not add its own or the ambient lands twice.
// See src/render/skyshop-ibl.ts.
iblIrradiance = vec3( 0.0 );
// -----------------------------------------------------------------------------`
  lightingModelInstalled = true
}

/** Test seam: `useSkyshopLightingModel` is a one-shot global, and tests need to re-run it. */
export const _resetLightingModelForTests = (original: string): void => {
  THREE.ShaderChunk.lights_fragment_maps = original
  lightingModelInstalled = false
}
