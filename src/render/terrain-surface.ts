// src/render/terrain-surface.ts — a facet's roughness from what it is. DEV-132.
//
// Matt: *"right now our terrain material all has the same 'sheen' to it. it'd
// be nice if the rocks looked rougher than the ocean, and if the grass looked
// shinier than the rocks."*
//
// ── What 2016 had ────────────────────────────────────────────────────────
//
// One `_Shininess` per material — 5.01 on Simonet and Kauai, 5.45 alpine, 2.66
// desert — and no map to vary it (`_SpecTex` unassigned on every terrain
// material, so gloss is 1 everywhere; `terrain-mesh.ts`, `marmosetGlossLod`).
// `shininessToRoughness` transcribes that to a GGX roughness of 0.17 on
// Simonet, and `terrainMaterial` gives every facet of the island the same one.
// That IS the 2016 material, and the video (11:40, 13:20) shows it reading as
// matte — `_SpecInt` 0.05 behind a Fresnel of 0.402 is an F0 of about 0.02, so
// the sheen Matt sees is mostly the environment map at low roughness. Classic
// keeps the single value.
//
// ── Where a class comes from ─────────────────────────────────────────────
//
// The generator has no classes. `FacetedTerrain.cs:832` stamps each facet with
// one colour off the colour map at its barycentre, and that colour is the only
// thing the mesh knows about its surface. But the colour map was PAINTED by
// class: k-means over the four shipped maps
// (`scratch/terrain-look/palette.mjs`) finds the same six swatches on
// Simonet, alpine and Kauai — a pale `(212,204,173)` on the steepest ground
// (mean slope 60°), a khaki `(141,140,109)`, an olive `(113,120,79)`, a dark
// green `(66,80,63)`, a scree `(173,170,138)`, a dark seabed `(24,32,35)` —
// and a separate red/brown set on the desert. World Machine's default palette,
// used four times. So the class IS the colour, and the honest classifier is
// the nearest swatch to the facet's own vertex colour.
//
// It runs in the VERTEX shader, per vertex, against a small uniform table:
// no attribute, no geometry change, no regeneration when the preset flips, and
// a flat-shaded soup's three vertices agree by construction. Sixteen swatches
// is three multiplies each per vertex; the fragment shader — where a Quest's
// budget lives — sees one varying and one `mix`.
//
// ── What it changes, and what it does not ────────────────────────────────
//
// `roughnessFactor`, and only that: `mix( roughness, vFf2Rough, uMix )` in
// place of the stock `roughnessmap_fragment`'s first line. F0 stays the
// Marmoset-derived coloured one (DEV-008), the tint stays, the vertex colour
// stays raw (DEV-014). At `uMix` 0 GLSL's `mix(x, y, 0.0)` is `x` exactly, so
// Classic compiles the same program and draws the same picture — the same
// identity argument as the illustrative warp's (DEV-092).
//
// The ORDER Matt asked for is a content fact checked in a test:
// `terrain-surface.test.ts` reads the water's own effective roughness off the
// sheet (`shininessToRoughness`, 0.27) and asserts grass sits above it and
// rock above grass. A preset that breaks the order fails the suite, not the
// eye.

import * as THREE from 'three'
import { chainShaderPatch } from '@/render/program-cache-key'

/** The most swatches the uniform table holds. Fourteen are in use. */
export const SURFACE_SWATCH_MAX = 16

export const SURFACE_COLOR_INCLUDE = '#include <color_vertex>'
export const SURFACE_ROUGHNESS_INCLUDE = '#include <roughnessmap_fragment>'

/**
 * Vertex side: declared before `main`, evaluated right after the vertex colour
 * is known. `uSurfaceGloss` is `(mix, swatchCount)`; each swatch is
 * `(r, g, b, roughness)` in the colour map's OWN numbers — the raw sRGB bytes
 * `FacetedTerrain` stamped, untinted, which is what `vColor` carries.
 */
export const SURFACE_PARS_VERTEX = /* glsl */ `
uniform vec2 uSurfaceGloss;
uniform vec4 uSurfaceSwatch[ ${SURFACE_SWATCH_MAX} ];
varying float vFf2Rough;
float ff2SurfaceRoughness( vec3 c ) {
	float best = 1e9;
	float rough = 1.0;
	for ( int i = 0; i < ${SURFACE_SWATCH_MAX}; i ++ ) {
		if ( float( i ) >= uSurfaceGloss.y ) break;
		vec3 d = c - uSurfaceSwatch[ i ].rgb;
		float dist = dot( d, d );
		if ( dist < best ) {
			best = dist;
			rough = uSurfaceSwatch[ i ].w;
		}
	}
	return rough;
}
`

/** A material with no vertex colours has no class; it keeps its roughness. */
export const SURFACE_MAIN_VERTEX = /* glsl */ `
	#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
		vFf2Rough = ff2SurfaceRoughness( vColor.rgb );
	#else
		vFf2Rough = 1.0;
	#endif
`

export const SURFACE_PARS_FRAGMENT = /* glsl */ `
uniform vec2 uSurfaceGloss;
varying float vFf2Rough;
`

/**
 * The stock chunk with its first line replaced. The `USE_ROUGHNESSMAP` branch
 * is kept verbatim so a material that one day carries a roughness map still
 * multiplies it in — this substitutes the BASE, not the whole chunk.
 */
export const surfaceRoughnessChunk = (): string => {
  const chunk = THREE.ShaderChunk.roughnessmap_fragment
  const anchor = 'float roughnessFactor = roughness;'
  if (!chunk.includes(anchor)) {
    throw new Error(
      "terrain-surface: three's roughnessmap_fragment no longer opens with " +
        `"${anchor}". Re-read node_modules/three/src/renderers/shaders/ShaderChunk/` +
        'roughnessmap_fragment.glsl.js and update the anchor.',
    )
  }
  return chunk.replace(
    anchor,
    'float roughnessFactor = mix( roughness, vFf2Rough, uSurfaceGloss.x );',
  )
}

export const surfacePatchVertex = (vertexShader: string): string => {
  if (!vertexShader.includes(SURFACE_COLOR_INCLUDE)) return vertexShader
  const main = vertexShader.indexOf('void main()')
  if (main < 0) return vertexShader
  return (
    vertexShader.slice(0, main) +
    SURFACE_PARS_VERTEX +
    vertexShader
      .slice(main)
      .replace(SURFACE_COLOR_INCLUDE, `${SURFACE_COLOR_INCLUDE}\n${SURFACE_MAIN_VERTEX}`)
  )
}

export const surfacePatchFragment = (fragmentShader: string): string => {
  if (!fragmentShader.includes(SURFACE_ROUGHNESS_INCLUDE)) return fragmentShader
  const main = fragmentShader.indexOf('void main()')
  if (main < 0) return fragmentShader
  return (
    fragmentShader.slice(0, main) +
    SURFACE_PARS_FRAGMENT +
    fragmentShader.slice(main).replace(SURFACE_ROUGHNESS_INCLUDE, surfaceRoughnessChunk())
  )
}

/** One class as the preset carries it. */
export interface SurfaceClass {
  readonly id: string
  /** GGX roughness, 0..1, for every facet nearest one of this class's swatches. */
  readonly roughness: number
  /** Colour map bytes 0..1 (sRGB as stored, untinted), several per class. */
  readonly swatches: readonly (readonly number[])[]
}

export interface SurfaceGlossTuning {
  readonly enabled: boolean
  readonly classes: readonly SurfaceClass[]
}

/** The swatch table flattened, in class order, roughness in `.w`. */
export const flattenSwatches = (classes: readonly SurfaceClass[]): THREE.Vector4[] => {
  const out: THREE.Vector4[] = []
  for (const c of classes) {
    for (const s of c.swatches) {
      out.push(new THREE.Vector4(s[0] ?? 0, s[1] ?? 0, s[2] ?? 0, c.roughness))
    }
  }
  return out
}

/**
 * The classifier in TypeScript, so a test can state which class a colour lands
 * in without a GPU — the GLSL above is this function.
 */
export const classifySurface = (
  classes: readonly SurfaceClass[],
  rgb: readonly number[],
): SurfaceClass | null => {
  let best = Number.POSITIVE_INFINITY
  let found: SurfaceClass | null = null
  for (const c of classes) {
    for (const s of c.swatches) {
      const dr = (rgb[0] ?? 0) - (s[0] ?? 0)
      const dg = (rgb[1] ?? 0) - (s[1] ?? 0)
      const db = (rgb[2] ?? 0) - (s[2] ?? 0)
      const d = dr * dr + dg * dg + db * db
      if (d < best) {
        best = d
        found = c
      }
    }
  }
  return found
}

export interface SurfaceGloss {
  /** Exposed for tests and the console, the way the warp's are. */
  readonly uniforms: {
    readonly uSurfaceGloss: { value: THREE.Vector2 }
    readonly uSurfaceSwatch: { value: THREE.Vector4[] }
  }
  /** Patch one material. Idempotent, chained, tagged. */
  applyTo(material: THREE.Material): void
  /** `null` is off, which is the identity. */
  set(tuning: SurfaceGlossTuning | null): void
  readonly materialCount: number
}

export const createSurfaceGloss = (): SurfaceGloss => {
  const uniforms = {
    // Built at the identity whatever preset is live; `set` is the only writer.
    uSurfaceGloss: { value: new THREE.Vector2(0, 0) },
    uSurfaceSwatch: {
      value: Array.from({ length: SURFACE_SWATCH_MAX }, () => new THREE.Vector4(0, 0, 0, 1)),
    },
  }
  const patched = new WeakSet<THREE.Material>()
  let materialCount = 0

  return {
    uniforms,

    applyTo(material) {
      const installed = chainShaderPatch(
        material,
        {
          tag: 'surface-gloss',
          uniforms,
          vertex: surfacePatchVertex,
          fragment: surfacePatchFragment,
        },
        patched,
      )
      if (installed) materialCount++
    },

    set(tuning) {
      const table = uniforms.uSurfaceSwatch.value
      if (!tuning?.enabled) {
        uniforms.uSurfaceGloss.value.set(0, 0)
        return
      }
      const flat = flattenSwatches(tuning.classes).slice(0, SURFACE_SWATCH_MAX)
      for (let i = 0; i < SURFACE_SWATCH_MAX; i++) {
        const s = flat[i]
        if (s) (table[i] as THREE.Vector4).copy(s)
        else (table[i] as THREE.Vector4).set(0, 0, 0, 1)
      }
      // No swatches is the identity too: the loop finds nothing, the varying is
      // 1, and the mix is 0.
      uniforms.uSurfaceGloss.value.set(flat.length > 0 ? 1 : 0, flat.length)
    },

    get materialCount() {
      return materialCount
    },
  }
}

/** Anything that can be handed a tuning — so tests can watch the pushes. */
export interface SurfaceGlossTarget {
  set(tuning: SurfaceGlossTuning | null): void
}

export interface SurfaceGlossEditionState {
  readonly current: { readonly terrain: { readonly surfaceGloss: SurfaceGlossTuning } }
  subscribe(listener: () => void): () => void
}

/**
 * Wire the gloss to the live preset: set it now and on every flip. `null` when
 * the feature is off, so Classic's class list is unobservable — the same
 * contract as `attachEditionIllustrative`. Returns the unsubscribe.
 */
export const attachEditionSurfaceGloss = (
  target: SurfaceGlossTarget,
  editionState: SurfaceGlossEditionState,
): (() => void) => {
  const push = (): void => {
    const g = editionState.current.terrain.surfaceGloss
    target.set(g.enabled ? g : null)
  }
  push()
  return editionState.subscribe(push)
}
