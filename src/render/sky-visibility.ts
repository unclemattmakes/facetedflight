// src/render/sky-visibility.ts — the terrain shading the sky it hides, and
// lighting the shade it throws. DEV-333, `docs/plan/SKY-VISIBILITY.md`.
//
// ── What it does to a facet ───────────────────────────────────────────────
//
// Two terms, both on the LAND's indirect light only, never the sun:
//
//   indirect *= mix(1, V, sky)                        the sky a wall hides
//   indirect += bounce · B · sunColour · BRDF_Lambert  the wall, lit, in its place
//
// `V` and `B` come from `sim/terrain/sky-visibility.ts`, baked once per world.
// V alone only removes light, and Matt's report was the opposite: *"right now
// the shadows are very dark"*, *"mesa canyon is a good example"*. B is the
// answer to that: in a canyon the sunlit wall opposite throws its own colour
// into the shade, and a pocket under a shadowed ridge gets nothing back. Sun
// height (DEV-116) still owns the direct sun exactly, so nothing here darkens
// or lightens anything twice.
//
// ── One value per FACET, with no new attribute ────────────────────────────
//
// Every land facet already carries its BARYCENTRE as its uv, on all three
// vertices (`sim/terrain/faceted.ts`, where the colour is sampled), and the
// detail ring's subdivision interpolates three identical values, which is the
// identity. So a fetch at the interpolated uv reads ONE texel position per
// facet: the per-face constancy ART_DIRECTION's pillar 2 asks for, with no
// worker plumbing and no gradient across a face. three declares
// `attribute vec2 uv` for every program, so the vertex half only forwards it.
//
// ── Classic ──────────────────────────────────────────────────────────────
//
// `render.skyVisibility.enabled` false, or both strengths 0, sets the gate
// uniform to 0 and the shader skips the fetch on a uniform branch: exactly the
// image before this existed. 2016 had no such term.
//
// ── The texture ──────────────────────────────────────────────────────────
//
// RGBA half float, `samplesPerSide`², rgb = B (per unit of sun), a = V. Texel
// (i, j) is grid texel (i·stride, j·stride) of the land's height field, whose
// axes are the facet uv's axes, [z][x] with no transpose
// (`sim/terrain/height-field.ts`). `sky-visibility-mapping.test.ts` holds that
// against a facet built by the real generator.

import * as THREE from 'three'
import type { EditionState } from '@/game/edition'
import { smoothstep } from '@/sim/math/scalar'
import { runSteps, type Steps } from '@/sim/steps'
import type { HeightField } from '@/sim/terrain/height-field'
import type { MapSampler, Rgb } from '@/sim/terrain/image-sampler'
import {
  buildSunRadiance,
  type SkyVisibilityField,
  skyVisibilitySteps,
} from '@/sim/terrain/sky-visibility'
import type { SunHeightField } from '@/sim/terrain/sun-height'
import { AOMAP_INCLUDE } from './far-shadow'
import { chainShaderPatch } from './program-cache-key'

/** Largest bake per side. Above it the stride doubles: V and B are landform-scale. */
export const SKY_VISIBILITY_MAX_SIDE = 257

/** The smallest stride that brings `vertPerSide` to at most {@link SKY_VISIBILITY_MAX_SIDE}. */
export const strideFor = (vertPerSide: number): number => {
  let stride = 1
  while (
    (vertPerSide - 1) / stride + 1 > SKY_VISIBILITY_MAX_SIDE &&
    (vertPerSide - 1) % (stride * 2) === 0
  )
    stride *= 2
  return stride
}

/** The texture coordinate a facet uv reads: texel centres of an m-wide bake. */
export const texcoordFor = (uv: number, samplesPerSide: number): number =>
  (uv * (samplesPerSide - 1) + 0.5) / samplesPerSide

/**
 * The land's albedo per grid texel, RGB, `[(z * n + x) * 3]`: the colour map
 * sampled where the facets sample it (u = x / (n − 1), v = z / (n − 1)), RAW,
 * as the facets use it (DEV-014).
 */
export const albedoGrid = (field: HeightField, colorMap: MapSampler): Float32Array => {
  const n = field.vertPerSide
  const out = new Float32Array(n * n * 3)
  const rgb: Rgb = { r: 0, g: 0, b: 0 }
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      colorMap.sample(x / (n - 1), z / (n - 1), rgb)
      const i = (z * n + x) * 3
      out[i] = rgb.r
      out[i + 1] = rgb.g
      out[i + 2] = rgb.b
    }
  }
  return out
}

/** 0..1 sun per texel from the sun-height field's own verdict, softened as the render softens it. */
export const sunLitGrid = (sun: SunHeightField, softMetres: number): Float32Array => {
  const out = new Float32Array(sun.depths.length)
  // `sunGroundVisibilityAt`'s rule, per texel: the render term's own edge.
  const soft = Math.max(softMetres, 1e-3)
  for (let i = 0; i < out.length; i++) out[i] = 1 - smoothstep(0, soft, sun.depths[i] as number)
  return out
}

/**
 * The sky-visibility bake proper, from the albedo grid on: radiance, then the
 * horizon march. ONE body for the runtime bake below and for the content-time
 * bake (`terrain-bake.ts`, DEV-955), so the file on disk is this function's
 * output and not a second implementation's.
 */
export function* skyFieldSteps(
  land: HeightField,
  albedo: Float32Array,
  sun: SunHeightField,
  softMetres: number,
): Steps<SkyVisibilityField> {
  const radiance = buildSunRadiance(land, sun.towardSun, albedo, sunLitGrid(sun, softMetres))
  yield 0
  return yield* skyVisibilitySteps(land, { stride: strideFor(land.vertPerSide) }, radiance)
}

/**
 * The half-float RGBA the GPU receives for a sky field: rgb = bounce, a = V.
 * DEV-955: exported so the byte-identity proof can compare THESE bytes (what is
 * uploaded) rather than the Float32 field, whose last-bit transcendental
 * differences between Node's V8 and Chrome's (about 4e-19, on values that are
 * themselves near zero) cannot survive half-float storage.
 */
export const skyTextureData = (f: SkyVisibilityField): Uint16Array => {
  const m = f.samplesPerSide
  const data = new Uint16Array(m * m * 4)
  const b = f.bounce as Float32Array
  for (let i = 0; i < m * m; i++) {
    data[i * 4] = THREE.DataUtils.toHalfFloat(b[i * 3] as number)
    data[i * 4 + 1] = THREE.DataUtils.toHalfFloat(b[i * 3 + 1] as number)
    data[i * 4 + 2] = THREE.DataUtils.toHalfFloat(b[i * 3 + 2] as number)
    data[i * 4 + 3] = THREE.DataUtils.toHalfFloat(f.values[i] as number)
  }
  return data
}

const VERTEX_PRELUDE = 'varying vec2 vFf2SkyUv;'
const VERTEX_HOOK = '#include <begin_vertex>'
const FRAGMENT_PRELUDE = `#define FF2_SKY_VISIBILITY
uniform sampler2D uSkyVisMap;
uniform vec4 uSkyVisC;
uniform vec3 uSkyVisSun;
varying vec2 vFf2SkyUv;`

/** The vertex half: forward the facet's barycentre uv. */
export const skyVisibilityPatchVertex = (vertexShader: string): string => {
  if (!vertexShader.includes(VERTEX_HOOK)) {
    throw new Error(`sky-visibility: '${VERTEX_HOOK}' is not in this vertex shader`)
  }
  return `${VERTEX_PRELUDE}\n${vertexShader}`.replace(
    VERTEX_HOOK,
    `${VERTEX_HOOK}\n\tvFf2SkyUv = uv;`,
  )
}

/**
 * The fragment half, after `aomap_fragment`, where three's own AO multiplies
 * the indirect light: the same slot the canopy term uses (DEV-295).
 *
 * `uSkyVisC` = (gate, sky, bounce, samplesPerSide). The gate is a UNIFORM
 * branch, so Classic skips the fetch without a second program.
 */
export const skyVisibilityPatchFragment = (fragmentShader: string): string => {
  if (!fragmentShader.includes(AOMAP_INCLUDE)) {
    throw new Error(
      `sky-visibility: the anchor '${AOMAP_INCLUDE}' is not in this shader. ` +
        "Re-read three's meshphysical fragment shader.",
    )
  }
  return `${FRAGMENT_PRELUDE}\n${fragmentShader}`.replace(
    AOMAP_INCLUDE,
    `${AOMAP_INCLUDE}
	if ( uSkyVisC.x > 0.5 ) {
		float ff2SkyM = uSkyVisC.w;
		vec4 ff2Sky = texture2D( uSkyVisMap, ( vFf2SkyUv * ( ff2SkyM - 1.0 ) + 0.5 ) / ff2SkyM );
		float ff2SkyV = mix( 1.0, ff2Sky.a, uSkyVisC.y );
		reflectedLight.indirectDiffuse *= ff2SkyV;
		reflectedLight.indirectSpecular *= ff2SkyV;
		reflectedLight.indirectDiffuse += uSkyVisC.z * ff2Sky.rgb * uSkyVisSun * BRDF_Lambert( material.diffuseColor );
	}`,
  )
}

export interface SkyVisibility {
  /** Patch a LAND material. Idempotent. Nothing else should carry it. */
  applyTo(material: THREE.Material): void
  /**
   * The world to bake for, or nulls to clear. `sunColour` is the directional
   * light's `color × intensity`, linear. The bake itself runs the first time
   * the flag is on for this world (here, or on a later preset flip), so
   * Classic never pays for it. Returns the bake if it ran now.
   */
  setWorld(
    land: HeightField | null,
    colorMap: MapSampler | null,
    sun: SunHeightField | null,
    sunColour: THREE.Color | null,
  ): SkyVisibilityField | null
  /**
   * `setWorld`, as a bake that can stop after every row (DEV-355). `setWorld`
   * IS this, drained in one go; `boot/slice.ts` drains it a frame's budget at a
   * time. The field stays at the placeholder until the last row is in.
   */
  setWorldSteps(
    land: HeightField | null,
    colorMap: MapSampler | null,
    sun: SunHeightField | null,
    sunColour: THREE.Color | null,
    /** DEV-955: the albedo grid and/or the field, when the caller already has them. */
    prior?: SkyBakePrior,
  ): Steps<SkyVisibilityField | null>
  readonly field: SkyVisibilityField | null
  /** Milliseconds the last bake took. */
  readonly bakeMs: number
  /** Is the term live on the current preset and world? */
  readonly on: boolean
  dispose(): void
}

interface Pending {
  readonly land: HeightField
  readonly colorMap: MapSampler
  readonly sun: SunHeightField
  readonly sunColour: THREE.Color
  /** DEV-955: the albedo grid already taken for the bake key. */
  readonly albedo?: Float32Array | undefined
  /** DEV-955: a field baked earlier for these exact inputs. */
  readonly baked?: SkyVisibilityField | null | undefined
}

/** DEV-955: what a caller that already paid for the key hands back in, so nothing is done twice. */
export interface SkyBakePrior {
  readonly albedo?: Float32Array | undefined
  readonly baked?: SkyVisibilityField | null | undefined
}

/** Does the live preset ask for the bake at all? `apply`'s own gate, for a caller deciding whether to fetch one. */
export const skyBakeWantedBy = (s: {
  readonly enabled: boolean
  readonly sky: number
  readonly bounce: number
}): boolean => s.enabled && (s.sky > 0 || s.bounce > 0)

export const skyBakeWanted = (editionState: EditionState): boolean =>
  skyBakeWantedBy(editionState.current.render.skyVisibility)

export const createSkyVisibility = (editionState: EditionState): SkyVisibility => {
  const placeholder = new THREE.DataTexture(
    new Uint16Array([0, 0, 0, THREE.DataUtils.toHalfFloat(1)]),
    1,
    1,
    THREE.RGBAFormat,
    THREE.HalfFloatType,
  )
  placeholder.needsUpdate = true
  let texture: THREE.DataTexture | null = null
  let field: SkyVisibilityField | null = null
  let pending: Pending | null = null
  let bakeMs = 0

  const uniforms = {
    uSkyVisMap: { value: placeholder as THREE.Texture },
    uSkyVisC: { value: new THREE.Vector4(0, 0, 0, 1) },
    uSkyVisSun: { value: new THREE.Vector3(0, 0, 0) },
  }
  const patched = new WeakSet<THREE.Material>()

  // DEV-355: a bake that can stop between rows. `bakeMs` is then the wall time
  // from the first row to the upload, pauses included, when it is sliced.
  function* bakeSteps(w: Pending): Steps<void> {
    const t0 = performance.now()
    const soft = editionState.current.render.sunHeight.softMetres
    // DEV-955: a field baked at content-build time (or kept from an earlier
    // load) stands in for the march; the texture below is built from it either way.
    const f =
      w.baked ??
      (yield* skyFieldSteps(w.land, w.albedo ?? albedoGrid(w.land, w.colorMap), w.sun, soft))
    const m = f.samplesPerSide
    const data = skyTextureData(f)
    // A preset flip landing while a sliced bake is suspended bakes once more
    // through `apply`; the later of the two wins and the earlier is not leaked.
    texture?.dispose()
    texture = new THREE.DataTexture(data, m, m, THREE.RGBAFormat, THREE.HalfFloatType)
    texture.magFilter = THREE.LinearFilter
    texture.minFilter = THREE.LinearFilter
    texture.wrapS = THREE.ClampToEdgeWrapping
    texture.wrapT = THREE.ClampToEdgeWrapping
    texture.generateMipmaps = false
    texture.needsUpdate = true
    uniforms.uSkyVisMap.value = texture
    uniforms.uSkyVisSun.value.set(w.sunColour.r, w.sunColour.g, w.sunColour.b)
    field = f
    bakeMs = performance.now() - t0
  }
  const bake = (w: Pending): void => runSteps(bakeSteps(w))

  const apply = (): void => {
    const s = editionState.current.render.skyVisibility
    const wanted = s.enabled && (s.sky > 0 || s.bounce > 0)
    if (wanted && field === null && pending !== null) bake(pending)
    uniforms.uSkyVisC.value.set(
      wanted && field !== null ? 1 : 0,
      s.sky,
      s.bounce,
      field?.samplesPerSide ?? 1,
    )
  }
  const unsubscribe = editionState.subscribe(apply)
  apply()

  const self: SkyVisibility = {
    applyTo(material) {
      chainShaderPatch(
        material,
        {
          tag: 'sky-visibility',
          uniforms,
          vertex: skyVisibilityPatchVertex,
          fragment: skyVisibilityPatchFragment,
        },
        patched,
      )
    },
    setWorld(land, colorMap, sun, sunColour) {
      return runSteps(self.setWorldSteps(land, colorMap, sun, sunColour))
    },
    *setWorldSteps(land, colorMap, sun, sunColour, prior) {
      texture?.dispose()
      texture = null
      field = null
      bakeMs = 0
      uniforms.uSkyVisMap.value = placeholder
      uniforms.uSkyVisSun.value.set(0, 0, 0)
      pending =
        land && colorMap && sun && sunColour && !land.analytic
          ? {
              land,
              colorMap,
              sun,
              sunColour: sunColour.clone(),
              albedo: prior?.albedo,
              baked: prior?.baked,
            }
          : null
      // The bake `apply` would run, run HERE a row at a time (DEV-355); `apply`
      // then finds the field built and only writes the uniforms. The gate is
      // `apply`'s own, read from the same preset.
      const s = editionState.current.render.skyVisibility
      if (s.enabled && (s.sky > 0 || s.bounce > 0) && pending !== null) {
        yield* bakeSteps(pending)
      }
      apply()
      return field
    },
    get field() {
      return field
    },
    get bakeMs() {
      return bakeMs
    },
    get on() {
      return uniforms.uSkyVisC.value.x > 0.5
    },
    dispose() {
      unsubscribe()
      texture?.dispose()
      placeholder.dispose()
    },
  }
  return self
}
