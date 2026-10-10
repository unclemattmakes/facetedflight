// src/render/vr-halo.ts — bloom in a headset, the cheap way: halos. DEV-336.
//
// Matt, 2026-09-23: *"i also didn't see bloom working in vr, no matter what i
// had the settings set to"*, and on being told why, *"if there's a cheap way
// to do it, let's do it."*
//
// ── Why the real bloom never runs in a headset ─────────────────────────────
//
// `render/bloom.ts` is a post pass, and under `renderer.xr` a post pass means
// an off-screen target per eye, a threshold, a blur chain and a full-screen
// composite over both eyes, on a frame that is already at its GPU line
// (`docs/perf-baseline.md`). It also never ran in 2016's headset: the
// component sat on the MONO camera (bloom.ts's header has the walk).
//
// ── What this is instead ──────────────────────────────────────────────────
//
// ANNIVERSARY.md §V2's second option, written down on 2026-09-13 and never
// built: *"no pass at all and fake it per material (soft halo sprites on studs
// and the sun)"*. Those are the two things the flat bloom actually lights
// (its threshold is 1.0; the studs' emissive is 2 and the sun cap's is 3; the
// frame's 0.25 never reaches it), and ART_DIRECTION's glow rule already lets
// both glow.
//
//   * STUD HALOS: one `InstancedMesh` of camera-facing quads that SHARES the
//     studs' `instanceMatrix` attribute, so every halo sits on its stud and a
//     passed gate's shrink takes its halos with it for free. One draw call for
//     the whole course.
//   * THE SUN HALO: one quad, placed along the sun direction each frame.
//
// Additive, depth-TESTED (terrain in front hides a halo) and depth-WRITE off.
// Tone-mapped, because a halo is light in the world rather than UI, and on
// layer 0, never an eye layer (DEV-141). Pixel cost is only where a halo is.
//
// ── When it draws ─────────────────────────────────────────────────────────
//
// Only while a headset is presenting AND the preset's `render.bloom` is on:
// the monitor keeps the real bloom, and Classic, whose bloom is off, gets
// neither. So the Advanced page's Bloom row now controls something in a
// headset, which it never did.

import * as THREE from 'three'

const VERTEX = /* glsl */ `
uniform float uRadius;
uniform float uSizeFromScale;
uniform float uFadeFar;
varying vec2 vCorner;
varying float vFade;
void main() {
  #ifdef USE_INSTANCING
    mat4 local = instanceMatrix;
  #else
    mat4 local = mat4(1.0);
  #endif
  vec4 centre = modelViewMatrix * local * vec4(0.0, 0.0, 0.0, 1.0);
  // The halo's size follows its instance's scale when asked to: a stud's box
  // is its own size, and a passed gate shrinks every stud to nothing.
  float meanScale = (length(local[0].xyz) + length(local[1].xyz) + length(local[2].xyz)) / 3.0;
  float scale = mix(1.0, meanScale, uSizeFromScale);
  centre.xy += position.xy * uRadius * scale;
  vCorner = position.xy;
  // The flat bloom lights the FOGGED pixel, so a far gate barely blooms. A
  // halo is not fogged, so it fades with distance instead, or distant gates
  // would glow through the fog as bright dots. 0 = never fades (the sun).
  vFade = uFadeFar > 0.0 ? clamp(1.0 - length(centre.xyz) / uFadeFar, 0.0, 1.0) : 1.0;
  gl_Position = projectionMatrix * centre;
}
`

const FRAGMENT = /* glsl */ `
uniform vec3 uColour;
uniform float uIntensity;
varying vec2 vCorner;
varying float vFade;
void main() {
  float r2 = dot(vCorner, vCorner);
  if (r2 >= 1.0) discard;
  float fall = 1.0 - r2;
  fall *= fall;
  gl_FragColor = vec4(uColour * (uIntensity * fall * vFade), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

const haloMaterial = (colour: THREE.Color, sizeFromScale: boolean, fadeFar: number) =>
  new THREE.ShaderMaterial({
    name: 'vr-halo',
    uniforms: {
      uColour: { value: colour.clone() },
      uIntensity: { value: 0 },
      uRadius: { value: 0 },
      uSizeFromScale: { value: sizeFromScale ? 1 : 0 },
      uFadeFar: { value: fadeFar },
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    toneMapped: true,
  })

/** A unit quad, corners at ±1, facing +z: the billboard the vertex shader turns to the eye. */
const quad = (): THREE.BufferGeometry => new THREE.PlaneGeometry(2, 2)

const uniformsOf = (m: THREE.Mesh) =>
  (m.material as THREE.ShaderMaterial).uniforms as {
    uColour: { value: THREE.Color }
    uIntensity: { value: number }
    uRadius: { value: number }
  }

export interface InstancedHalos {
  readonly object: THREE.InstancedMesh
  /** Radius as a multiple of each instance's own mean scale, and peak brightness. */
  setLook(radiusPerScale: number, intensity: number): void
}

/**
 * How far out a stud halo has faded to nothing, metres. Past the distance a
 * 20 m gate is a few pixels across, and inside the mission fog's range.
 */
export const STUD_HALO_FADE_METRES = 1500

/**
 * Halos for an instanced set of glowing parts, sharing their instance matrix.
 * Parent the result beside `source`: the shared matrices are in its space.
 */
export const createInstancedHalos = (
  source: THREE.InstancedMesh,
  colour: THREE.Color,
): InstancedHalos => {
  const object = new THREE.InstancedMesh(
    quad(),
    haloMaterial(colour, true, STUD_HALO_FADE_METRES),
    source.count,
  )
  // SHARED, not copied: the studs' shrink and any later move reach the halos
  // on the same upload.
  object.instanceMatrix = source.instanceMatrix
  object.name = `${source.name}-halos`
  object.frustumCulled = false
  object.renderOrder = source.renderOrder + 1
  object.visible = false
  const u = uniformsOf(object)
  return {
    object,
    setLook(radiusPerScale, intensity) {
      u.uRadius.value = radiusPerScale
      u.uIntensity.value = intensity
    },
  }
}

export interface SunHalo {
  readonly object: THREE.Mesh
  /** Radius as an angle at the eye (degrees), peak brightness, linear colour. */
  setLook(angleDeg: number, intensity: number, colour: THREE.Color): void
  /** Place the halo along `towardSun` (unit) from the eye. Call each frame it shows. */
  place(eyeWorld: THREE.Vector3, towardSun: THREE.Vector3): void
}

/**
 * The sun's halo: one billboard `distance` metres out along the sun direction.
 * Inside the far plane, so the terrain between the eye and the horizon can
 * hide it.
 */
export const createSunHalo = (distance: number): SunHalo => {
  const object = new THREE.Mesh(quad(), haloMaterial(new THREE.Color(0, 0, 0), false, 0))
  object.name = 'sun-halo'
  object.frustumCulled = false
  object.visible = false
  const u = uniformsOf(object)
  return {
    object,
    setLook(angleDeg, intensity, colour) {
      u.uRadius.value = distance * Math.tan((angleDeg * Math.PI) / 180)
      u.uIntensity.value = intensity
      u.uColour.value.copy(colour)
    },
    place(eyeWorld, towardSun) {
      object.position.copy(eyeWorld).addScaledVector(towardSun, distance)
      object.updateMatrixWorld()
    },
  }
}
