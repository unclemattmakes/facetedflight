// src/render/coast.ts — the shoreline: shallows and a foam line.
//
// ── The problem, from nine photographed frames ────────────────────────────
//
// ANNIVERSARY.md §1.3 item 5: *"The sea is a tiled floor. The land's 8 m facets
// meet the water's 32 m facets (256 m in 2016) at a hard line with nothing at
// the join — no shore band, no foam, no shallows. A 4:1 (in 2016, 32:1) jump in
// element size across one edge is a strong 'these are two different scales'
// signal."*
//
// The join is the one place in the world where two known scales touch, so it is
// the one place the eye can catch the port out. Everything in this file is an
// attempt to put something AT that join that behaves like water over a beach.
//
// ── What the shader is actually given ─────────────────────────────────────
//
// The ISLAND's height map, as a texture, plus where the island is in the world.
// A water fragment can then ask how much water is under it —
//
//     depth = surfaceY - (islandOriginY + heightMapSample * heightScale)
//
// — which is the same subtraction the collision height field makes on the CPU
// (`sim/terrain/height-field.ts`), and the same map the land's own vertices came
// out of. It is not an approximation of the coastline; it IS the coastline,
// sampled per pixel.
//
// **`importUnityTexture`, never the raw PNG.** Both Simonet maps are 1025x1025
// with `nPOTScale: 1`, so Unity rescaled them to 1024 at import and the
// generator sampled THAT (DEV-007, worth up to 30 m of height inland). The
// texture this file uploads is read back out of the `MapSampler` the land was
// generated from, at the sampler's own post-rescale resolution — so there is one
// filtered image in the process and the water and the land cannot disagree about
// where the shore is.
//
// ── Two coordinate conventions, both of which have cost a session ─────────
//
//  1. **The z mirror.** The generator emits UNITY coordinates and
//     `chunkGeometry` flips z on the way into three space, so a land vertex at
//     map (u, v) lands at world `(originX + u * sizeX, ..., originZ - v * sizeZ)`
//     — note the MINUS. Get it wrong and the shallows appear on the far side of
//     the island from the beach, which on a scattered archipelago looks entirely
//     plausible. `coastUv` is that mapping and `tests/unit/coast.test.ts` checks
//     it against a real generated vertex rather than against itself (trap 24).
//  2. **The plate's 8x scale is the OCEAN's, not the island's.** The water plate
//     is `(8, 1, 8)` and the island is `(1, 1, 1)`; the depth question is asked
//     at a world position, so the ocean's scale never enters. What DOES enter is
//     the island's own scale and its `levelOffset` parent — which is why the map
//     is built from the live `THREE.Group` the land was hung on rather than from
//     a re-derivation of `worldOffset + local + envRoot` (DEV-042 got that wrong
//     for a day, and the fix is to read the answer instead of computing it
//     twice).
//
// ── Texel addressing, which is half a texel away from being right ─────────
//
// `GetPixelBilinear` addresses texels as `u * width` — the coordinate spans the
// texture (DEV-007 again). GL's `texture2D` addresses them as `s * width - 0.5`,
// because its `s` runs between texel CENTRES. The two differ by exactly half a
// texel, so the shader is handed `0.5 / width` and `0.5 / height` and adds them.
// On Simonet that is 2 m of shoreline, which is a quarter of a land facet and
// would never have looked wrong.
//
// ── What it must not touch ────────────────────────────────────────────────
//
// The wave (`render/water.ts`'s `WAVE_GLSL`), the generator, the collision
// field, the ocean's geometry and Classic's output. The shallows and the foam
// are a change to `diffuseColor` and nothing else: they compose BEFORE the
// specular, the sky reflection (DEV-021), the haze (DEV-082) and the fog, all of
// which then run on top exactly as they did. With both strengths at zero every
// `mix` returns its first argument exactly and the fragment never reaches the
// texture fetch — which is what makes Classic identical rather than nearly so,
// the same bargain `render/haze.ts` strikes and for the same reason.

import * as THREE from 'three'
import type { EditionState } from '@/game/edition'
import { clamp01, mix } from '@/sim/math/scalar'
import { grayscale } from '@/sim/terrain/faceted'
import type { MapSampler, Rgb } from '@/sim/terrain/image-sampler'
import { srgbToLinear } from './unity-space'

/**
 * Where the island is, in THREE world space, and how big its map is.
 *
 * Every field is read off the loaded terrain rather than recomputed — see
 * `coastMapFromTerrain`. The one number that is not a placement is the texture's
 * resolution, which decides the half-texel shift above.
 */
export interface CoastMap {
  /** World x of map u = 0. */
  readonly originX: number
  /** World y of height 0 — the terrain group's own y, which is NOT sea level. */
  readonly originY: number
  /** World z of map v = 0. The map runs toward SMALLER z: see the z mirror above. */
  readonly originZ: number
  /** `terrainSize * scale.x`, metres. */
  readonly sizeX: number
  /** `terrainSize * scale.z`, metres. */
  readonly sizeZ: number
  /** `terrainHeight * scale.y`, metres per unit of normalised height. */
  readonly heightScale: number
  /** Texels across, AFTER `importUnityTexture`'s rescale. */
  readonly width: number
  /** Texels down, after the same rescale. */
  readonly height: number
}

/**
 * The tuning, resolved: depths in metres, strengths in 0..1, colours already
 * LINEAR.
 *
 * The preset JSON carries the colours in sRGB, the way `fog.color` in a level
 * and `render.haze.tint` both do, because that is the space a colour is picked
 * in. `coastSettings` below is the one place that conversion happens.
 */
export interface CoastSettings {
  /** Metres. At and beyond this depth the water is untouched. Must be > 0. */
  readonly shallowDepth: number
  /** 0..1. How far toward `shallowColor` at zero depth. */
  readonly shallowStrength: number
  /** LINEAR rgb. */
  readonly shallowColor: readonly [number, number, number]
  /** Metres. Foam lives strictly inside `(0, foamDepth)`. Must be > 0. */
  readonly foamDepth: number
  /** 0..1. Peak foam, at the waterline, with the breakup at its brightest. */
  readonly foamStrength: number
  /** LINEAR rgb. */
  readonly foamColor: readonly [number, number, number]
  /** 0..1. How much of the foam the chop takes away. 0 is an unbroken band. */
  readonly foamBreakup: number
}

/**
 * No shore at all — what Classic runs, and what a water material carries until
 * a coast is attached.
 *
 * The depths are 1 rather than 0 because the pack takes their reciprocals; with
 * both strengths at zero the depths are unobservable either way, and a 1 keeps
 * the reciprocal finite so the shader never sees an infinity it would have to be
 * trusted to multiply by zero. `render/haze.ts`'s `HAZE_OFF` makes the same move
 * for the same reason.
 */
export const COAST_OFF: CoastSettings = Object.freeze({
  shallowDepth: 1,
  shallowStrength: 0,
  shallowColor: Object.freeze([0, 0, 0]) as readonly [number, number, number],
  foamDepth: 1,
  foamStrength: 0,
  foamColor: Object.freeze([0, 0, 0]) as readonly [number, number, number],
  foamBreakup: 0,
})

/**
 * The depth returned where there is no land in the map at all.
 *
 * A fragment outside the island's footprint is open sea, and open sea has no
 * shore: this is large enough that both ramps clamp to zero and small enough to
 * survive a float32 uniform without becoming an infinity somebody has to reason
 * about. The alternative — clamping the map's uv, which is what
 * `MapSampler.sample` itself does — would smear the island's edge texel across
 * 260 km of ocean and put a shallow band on the horizon.
 */
export const COAST_NO_LAND = 1e6

/**
 * World (x, z) to the height map's (u, v).
 *
 * The z term is a SUBTRACTION because `chunkGeometry` mirrors the generator's z
 * on the way into three space, so the map runs toward smaller world z. Outside
 * [0, 1] there is no land here and the caller must say so rather than clamp.
 */
export const coastUv = (map: CoastMap, x: number, z: number): [number, number] => [
  (x - map.originX) / map.sizeX,
  (map.originZ - z) / map.sizeZ,
]

/** Is this (u, v) inside the map's footprint? Outside it there is no land. */
export const insideCoastMap = (uv: readonly [number, number]): boolean =>
  uv[0] >= 0 && uv[0] <= 1 && uv[1] >= 0 && uv[1] <= 1

/**
 * The land's world y under a world (x, z), read from the same sampler the
 * generator read.
 *
 * The TypeScript twin of the shader's texture fetch — and the CPU half of the
 * test that the two agree. `null` outside the footprint, because "no land" and
 * "land at y = 0" are different facts and only one of them is true out at sea.
 */
export const coastLandY = (
  map: CoastMap,
  sampler: MapSampler,
  x: number,
  z: number,
): number | null => {
  const uv = coastUv(map, x, z)
  if (!insideCoastMap(uv)) return null
  const rgb: Rgb = { r: 0, g: 0, b: 0 }
  sampler.sample(uv[0], uv[1], rgb)
  return map.originY + grayscale(rgb.r, rgb.g, rgb.b) * map.heightScale
}

/**
 * The water column under a fragment, in metres. NEGATIVE means the land is above
 * the water here — which is most of the island, and where the land mesh is drawn
 * over the sea anyway.
 */
export const coastDepth = (
  map: CoastMap,
  sampler: MapSampler,
  x: number,
  z: number,
  surfaceY: number,
): number => {
  const landY = coastLandY(map, sampler, x, z)
  return landY === null ? COAST_NO_LAND : surfaceY - landY
}

/**
 * `(1 / shallowDepth, 1 / foamDepth, shallowStrength, foamStrength)` — the
 * `uCoastRamp` vec4, in the order the GLSL reads it.
 *
 * The reciprocals are taken on the CPU because they are per-frame-constant and a
 * fragment shader should not divide twice per pixel to learn something a uniform
 * already knows.
 */
export const coastPack = (c: CoastSettings): [number, number, number, number] => [
  c.shallowDepth > 0 ? 1 / c.shallowDepth : 0,
  c.foamDepth > 0 ? 1 / c.foamDepth : 0,
  c.shallowStrength,
  c.foamStrength,
]

/**
 * How shallow this fragment reads: 1 at and above the waterline, 0 at and beyond
 * `shallowDepth`, linear between. Monotone NON-INCREASING in depth, always.
 *
 * It does not stop at depth 0. Water drawn where the land is already above it is
 * water you can only see at a grazing angle past a headland, and the honest
 * colour for it is the shallowest one rather than a step back to open blue.
 */
export const shallowAmount = (depth: number, c: CoastSettings): number =>
  clamp01(1 - depth * coastPack(c)[0])

/**
 * How much foam: a band strictly inside `(0, foamDepth)`, brightest at the
 * waterline.
 *
 * Zero at and below depth 0 — a foam line that carries on under the beach is a
 * drawn outline, which is the one thing §6's king-tide warning says not to ship.
 * The step at exactly 0 is at the waterline, where the land mesh is drawn in
 * front of the water, so it is a step nobody is standing where they can see.
 */
export const foamAmount = (depth: number, c: CoastSettings): number =>
  depth > 0 ? clamp01(1 - depth * coastPack(c)[1]) : 0

/**
 * The term itself. Give it a LINEAR surface colour, a depth in metres and a chop
 * sample in 0..1; get back the colour the lighting should then run on.
 *
 * Exactly `COAST_GLSL`'s `ff2Coast`, line for line — the same bargain
 * `render/haze.ts` strikes, because the shader cannot be unit tested without a
 * GL context and a shore that is wrong by two metres looks exactly like an art
 * choice.
 *
 * `chop` is 1 for "no breakup at all", which is what a caller that does not have
 * the wave to hand should pass; `foamBreakup` at 0 ignores it either way.
 */
export const coastColor = (
  color: readonly [number, number, number],
  depth: number,
  chop: number,
  c: CoastSettings,
): [number, number, number] => {
  if (c.shallowStrength <= 0 && c.foamStrength <= 0) return [color[0], color[1], color[2]]
  const s = shallowAmount(depth, c) * c.shallowStrength
  const f = foamAmount(depth, c) * mix(1, clamp01(chop), c.foamBreakup) * c.foamStrength
  const out: [number, number, number] = [0, 0, 0]
  for (let i = 0; i < 3; i++) {
    out[i] = mix(
      mix(color[i] as number, c.shallowColor[i] as number, s),
      c.foamColor[i] as number,
      f,
    )
  }
  return out
}

/**
 * A number GLSL will read as a float — `1` is an int in GLSL ES 1.00 and a
 * `float` parameter will not take one.
 *
 * Interpolating the TypeScript constant rather than retyping it is the point:
 * `COAST_NO_LAND` cannot drift between the oracle above and the shader below.
 */
const glslFloat = (n: number): string => (Number.isInteger(n) ? `${n}.0` : String(n))

/**
 * The shader half, injected into the WATER material only.
 *
 * ONE variant: every value it reads is a uniform, so Classic and Anniversary
 * compile the same program and `render/program-cache-key.ts`'s `water:` tag
 * still names exactly one source. The early return is a branch on a uniform —
 * uniform across the whole draw, so there is no divergence and Classic never
 * pays for the texture fetch.
 */
export const COAST_GLSL = /* glsl */ `
uniform vec4 uCoastRamp;   // (1/shallowDepth, 1/foamDepth, shallowStrength, foamStrength)
uniform vec4 uCoastPlane;  // (originX, originZ, 1/sizeX, 1/sizeZ)
uniform vec4 uCoastLand;   // (originY, heightScale, 0.5/texWidth, 0.5/texHeight)
uniform vec3 uCoastShallow;
uniform vec3 uCoastFoam;
uniform float uCoastBreakup;
uniform sampler2D uCoastMap;

// The water column under this fragment, in metres. NEGATIVE means the land is
// above the water here. COAST_NO_LAND means there is no island in frame at all.
//
// The v term SUBTRACTS, because the generator's z is mirrored into three space
// (render/terrain-mesh.ts), and the half-texel add is GetPixelBilinear's
// \`u * width\` against GL's \`s * width - 0.5\`. Both are in coast.ts's header.
float ff2CoastDepth(vec3 world) {
  vec2 uv = vec2(
    (world.x - uCoastPlane.x) * uCoastPlane.z,
    (uCoastPlane.y - world.z) * uCoastPlane.w
  );
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) {
    return ${glslFloat(COAST_NO_LAND)};
  }
  float h = texture2D(uCoastMap, uv + uCoastLand.zw).r;
  return world.y - (uCoastLand.x + h * uCoastLand.y);
}

// Shallows and foam, on the surface's OWN colour, before any of the lighting
// runs on it. Mirrored by coastColor() in render/coast.ts, which is what the
// unit tests can actually reach.
vec3 ff2Coast(vec3 color, vec3 world, float chop) {
  // Classic: both strengths are zero, so there is nothing to compute and — more
  // to the point — no texture to fetch. A uniform branch, so the whole draw
  // takes the same side of it.
  if (uCoastRamp.z <= 0.0 && uCoastRamp.w <= 0.0) return color;
  float depth = ff2CoastDepth(world);
  float s = clamp(1.0 - depth * uCoastRamp.x, 0.0, 1.0) * uCoastRamp.z;
  float band = depth > 0.0 ? clamp(1.0 - depth * uCoastRamp.y, 0.0, 1.0) : 0.0;
  float f = band * mix(1.0, clamp(chop, 0.0, 1.0), uCoastBreakup) * uCoastRamp.w;
  return mix(mix(color, uCoastShallow, s), uCoastFoam, f);
}
`

/**
 * The same numbers with the colours still in sRGB — which is how the preset JSON
 * carries them, the way `fog.color` in a level and `render.haze.tint` both are.
 */
export interface CoastTuning {
  readonly shallowDepth: number
  readonly shallowStrength: number
  /** sRGB 0..1. */
  readonly shallowColor: readonly number[]
  readonly foamDepth: number
  readonly foamStrength: number
  /** sRGB 0..1. */
  readonly foamColor: readonly number[]
  readonly foamBreakup: number
}

const linear3 = (c: readonly number[]): [number, number, number] => [
  srgbToLinear((c[0] as number) ?? 0),
  srgbToLinear((c[1] as number) ?? 0),
  srgbToLinear((c[2] as number) ?? 0),
]

/** Resolve a preset's coast block into the linear settings the shader wants. */
export const coastSettings = (t: CoastTuning | null): CoastSettings =>
  t === null
    ? COAST_OFF
    : {
        shallowDepth: t.shallowDepth,
        shallowStrength: t.shallowStrength,
        shallowColor: linear3(t.shallowColor),
        foamDepth: t.foamDepth,
        foamStrength: t.foamStrength,
        foamColor: linear3(t.foamColor),
        foamBreakup: t.foamBreakup,
      }

// ── Getting the island's height map onto the GPU ──────────────────────────

/**
 * Read a `MapSampler` back out at its own texel grid, as normalised heights.
 *
 * **Exactly the texel centres `GetPixelBilinear` addresses.** `createMapSampler`
 * computes `fx = u * width` and `fy = (height - 1) - v * height` and lerps
 * between the two neighbouring texels, so it returns a stored texel EXACTLY when
 * those land on integers: column `x` at `u = x / width`, and the bottom-origin
 * row `j` at `v = j / height`. Sampling at `(x + 0.5) / width` instead — the
 * reading that looks right — blends two columns and quietly softens the whole
 * map by half a texel.
 *
 * Rows come out BOTTOM-ORIGIN, which is what a `DataTexture` wants: its first
 * row is uv (0, 0), and Unity's v = 0 is the bottom of the image too.
 *
 * The value stored is `grayscale(r, g, b)` — Unity's luminance, not a channel
 * average and not the red channel — because that is the number `buildVertexGrid`
 * and `buildHeightField` both turn into metres. A greyscale PNG makes the three
 * agree; a colour one does not, and the generator's answer is the one that has
 * to win.
 */
export const coastHeightSamples = (sampler: MapSampler): Float32Array => {
  const { width, height } = sampler
  const out = new Float32Array(width * height)
  const rgb: Rgb = { r: 0, g: 0, b: 0 }
  for (let j = 0; j < height; j++) {
    const v = j / height
    for (let x = 0; x < width; x++) {
      sampler.sample(x / width, v, rgb)
      out[j * width + x] = grayscale(rgb.r, rgb.g, rgb.b)
    }
  }
  return out
}

/**
 * The height map as a texture the water shader can read.
 *
 * **Half float, not eight bit.** The shallows ramp over ~25 m of a 1,536 m
 * terrain, so an 8-bit code is 6 m — four visible steps across the whole ramp,
 * which would read as contour lines drawn on the sea. A half float near the
 * shoreline's own value (h ~ 0.13) has a step of about 0.19 m, and R16F is
 * filterable in core WebGL2 so the hardware still does the bilinear the CPU
 * sampler does. One channel, so Simonet's 1024x1024 costs 2 MB.
 *
 * `flipY` stays false — `coastHeightSamples` already emits bottom-origin rows,
 * and a flip here would mirror the island north-to-south, which on a scattered
 * archipelago looks entirely plausible (`image-sampler.ts` says the same thing
 * about the same axis).
 */
export const coastHeightTexture = (sampler: MapSampler): THREE.DataTexture => {
  const samples = coastHeightSamples(sampler)
  const half = new Uint16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    half[i] = THREE.DataUtils.toHalfFloat(samples[i] as number)
  }
  const texture = new THREE.DataTexture(
    half,
    sampler.width,
    sampler.height,
    THREE.RedFormat,
    THREE.HalfFloatType,
  )
  texture.name = 'coast:height'
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  // Clamp, like every 2016 terrain map (`wrapMode: 1`) — though the shader
  // refuses a uv outside the footprint before the sampler ever sees it, so this
  // is a belt on top of a brace.
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.generateMipmaps = false
  texture.needsUpdate = true
  return texture
}

/**
 * The shape of a loaded terrain this file needs — its live group and its params.
 *
 * Written as a structural type rather than importing `LoadedTerrain` so that
 * `render/` does not depend on `game/terrain/`, and so a test can hand this a
 * plain object without building a `THREE.Group`.
 */
export interface CoastTerrainLike {
  readonly position: { readonly x: number; readonly y: number; readonly z: number }
  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
  readonly terrainSize: number
  readonly terrainHeight: number
  readonly mapWidth: number
  readonly mapHeight: number
}

/**
 * Where the island is, READ off the object the land was hung on.
 *
 * Not `worldOffset + local + envRoot` computed a second time. That sum has been
 * wrong twice — once as a centre/corner convention that happened to be right on
 * the only environment the port had ever loaded (DEV-042), and once in the
 * opposite direction on its first fix — and a second copy of it here would be a
 * third chance. The group's `position` and `scale` ARE the placement; this reads
 * them.
 */
export const coastMapFrom = (t: CoastTerrainLike): CoastMap => ({
  originX: t.position.x,
  originY: t.position.y,
  originZ: t.position.z,
  sizeX: t.terrainSize * t.scale.x,
  sizeZ: t.terrainSize * t.scale.z,
  heightScale: t.terrainHeight * t.scale.y,
  width: t.mapWidth,
  height: t.mapHeight,
})

/** Anything that can be handed a coast. `Water` is the only implementation. */
export interface CoastTarget {
  setCoast(settings: CoastSettings): void
}

/**
 * Wire a water surface to the live preset: set it now, and again on every flip.
 *
 * `null` when the feature is off, rather than the preset's own numbers with the
 * flag ignored — so Classic's tuning values are unobservable and cannot become
 * load-bearing by accident. The same contract as `attachEditionHaze`, and it
 * returns the unsubscribe for the same reason nobody calls it: the app reloads
 * the document on a level change.
 */
export const attachEditionCoast = (
  target: CoastTarget,
  editionState: EditionState,
): (() => void) => {
  const push = (): void => {
    const c = editionState.current.render.coast
    target.setCoast(coastSettings(c.enabled ? c : null))
  }
  push()
  return editionState.subscribe(push)
}
