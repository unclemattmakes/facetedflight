// src/render/sky.ts — FF2's own sky, and the image-based lighting it feeds.
//
// ── What this replaces, and why it has to be replaced ─────────────────────
//
// 2016 lit the terrain with `Marmoset/Shader/VertexColor/Marmoset Specular
// IBL.shader` against a `Skybox/6 Sided` material — `Quantum Theory/PolyWorld
// Skies/SkyJ.mat`, six cubemap faces from a bought pack. Neither the shader nor
// the faces can ship (D26).
//
// The *technique* is not theirs, though. Image-based lighting means: prefilter
// an environment map into a diffuse irradiance term and a roughness-indexed
// specular chain, then light from that instead of from a light rig. three does
// exactly this in `PMREMGenerator`, and `MeshStandardMaterial` consumes it. So
// FF2 authors its own sky and gets the same class of lighting from it.
//
// Unity also computed the scene's ambient from that skybox — `m_AmbientMode: 0`
// — which means the `m_AmbientSkyColor` / `Equator` / `Ground` values in
// `RenderSettings` were INERT for these missions, and the `HemisphereLight`
// built from them was standing in for something Unity never used. The scene
// stores no baked probe (`m_LightingDataAsset: {fileID: 0}`), so the real
// ambient is not recoverable from the project at any effort. It has to be
// re-derived from a new sky, which is what this does.
//
// ── The sky is now the REAL sky's colour ──────────────────────────────────
//
// It used to be invented from the fog colour: horizon = `m_FogColor`, zenith and
// nadir derived from it. The reasoning was that the horizon must match the fog
// or distant terrain fades to one colour against a sky of another and the seam
// shows. Sound reasoning, wrong premise — and it had a cost nobody attributed
// to it, because with sky and fog the same colour the WHOLE FRAME is one pink
// wash and the island's own colours disappear into it. Matt, twice: "fog —
// still too thick to really see anything." Some of that was never the fog.
//
// `tools/extract/sky.mjs` now projects the six faces of the shipped skybox onto
// nine spherical-harmonic coefficients, which `lighting.sky.sh` carries. The
// faces are bought art and never ship; nine coefficients per channel are a
// description, not the picture, and the extractor reports the residual (37.6 %
// on SkyJ) so what was thrown away is on the record rather than implied.
//
// The measured horizon is (0.52, 0.32, 0.23) linear toward the sun. The fog
// colour is (0.71, 0.39, 0.44). Half again as bright, nearly twice as blue: the
// old sky was not a near-miss.
//
// ── What is faithful here and what is FF2's own art ───────────────────────
//
// Faithful, from the mission JSON:
//   * the sun's direction and colour
//   * the sky's colour in every direction, to nine coefficients — including
//     which way the sunset glow faces, which the extractor validates against the
//     mission's sun (1.5° on `int_01_hoverJet`)
//
// FF2's own, and marked as such in docs/DEVIATIONS.md (DEV-008):
//   * the sun disc's size and falloff — SH cannot hold a disc, and the residual
//     is mostly this plus cloud detail
//   * the whole gradient for the TEN missions whose skybox is a Unity
//     `.cubemap` binary the extractor cannot decode yet. Three decode — the two
//     other SkyJ missions and `int_01_hoverJet`, which is the one M1 ships.
//     The rest fall back to the old fog-derived gradient, and
//     `usedExtractedSky` says which happened.
//
// Deliberately dropped: the skybox material's `_Rotation: 71`. Applying it puts
// the sunset glow 71° away from the mission's own sun; dropping it lands 1.5°
// away. It is a stale serialised property — `_Rotation` belongs to
// `Skybox/Cubemap`, and SkyJ is a `Skybox/6 Sided`. See `tools/extract/sky.mjs`.

import * as THREE from 'three'
import { SKY_FIRST_ORDER, setSkyLast } from '@/render/draw-order'
import { smoothstep } from '@/sim/math/scalar'
import {
  generateSkyDome,
  generateSunCap,
  shRadiance,
  skyCloudLobes,
  skyCloudMask,
  sunCapTriangles,
} from '@/sim/sky-dome'
import { makeRandom } from '@/sim/terrain/faceted'

/**
 * Icosphere subdivisions for the dome.
 *
 * Mean cell size is `sqrt(4*pi / faces)`: subdivision 2 is 320 faces at 11.4
 * degrees, 3 is 1,280 at 5.7, 4 is 5,120 at 2.8, 5 is 20,480 at 1.4.
 *
 * SkyJ's own cells span roughly a tenth of a cube face — 6 to 11 degrees — so
 * matching the reference exactly says 3. Matt has asked for four times the
 * density twice, which is 3 -> 4 -> 5, and both times after looking at it.
 *
 * That is a deliberate walk AWAY from the 2016 cell size and toward a sky that
 * holds up at a headset's angular resolution, where a 5.7 degree facet is a
 * wall. 1.4 degrees is around the limit of the exercise: below it the facets
 * stop being a look and become dither, and the sky is smooth again, which is
 * where this started.
 *
 * It also decides the sun: at 1.4 degrees the disc spans several facets, so it
 * reads as a small faceted blob rather than the single hexagon subdivision 3
 * gave. Still faceted, still not a circle.
 */
const SKY_SUBDIVISIONS = 5
/** Fixed, so two loads of a mission give the same sky. */
const SKY_SEED = 0x5cf1
/** How many cloud banks. */
const SKY_CLOUD_LOBES = 11
/** How far a bank pulls the sky toward `CLOUD_TINT`. */
const SKY_CLOUD_DEPTH = 0.62
/**
 * Per-face brightness variation, +/- this fraction.
 *
 * The facets are only as visible as the difference between neighbours, and the
 * field they sample is nine coefficients smooth — so quantising it per face
 * gives flat polygons nobody can see. SkyJ's cells differ visibly in
 * brightness, which is what makes them read as cells at all.
 *
 * This is the sky's version of the vertex jitter on the terrain and the clouds:
 * the geometry is faceted, and the noise is what makes the faceting legible.
 * Multiplicative, so it varies a face's brightness without shifting its hue,
 * and small enough to average out in the prefilter that lights the world.
 */
const SKY_FACET_JITTER = 0.06
/**
 * Arbitrary: the dome does not depth-test, so it occupies no depth range and
 * never meets the far plane. Large enough that nothing rounds to zero.
 */
const SKY_RADIUS = 1000

// ── The sun disc: a surface of its own, and one dial for its size ──────────
//
// DEV-293, wishlist #22b. The falloff's two angles and the gain came UNCHANGED
// out of the face loop they used to live in, and that discipline is what made
// the before/after readable: a 49 x 38 shard became a 30 x 30 disc at the same
// area, so the shape was the whole visible delta and there was one thing to
// judge.
//
// **DEV-294 is that judgement.** Matt, having looked at it: *"i'd love to be
// able to tweak the sun's size — for now i'd like it to be 3x the current
// size."* So the size is now a TUNING field with a lookdev slider, and it
// ships at 3.
//
// The size is FF2's own art and always was (DEV-008): the real sun is 0.27
// degrees of radius and SkyJ's is a bright hexagon several times that, so
// there was never a faithful number to hold to here — which is exactly why it
// belongs on a slider rather than in an argument.
//
// ── Why these are ANGLES now and were cosines before ──────────────────────
//
// Because "three times the size" has to mean something, and the only thing it
// can mean is three times the ANGULAR RADIUS. Scaling a cosine is not scaling
// an angle — `0.9995 * 3` is not a cosine at all — so a multiplier applied to
// the old constants would have produced nonsense in a way that still compiled
// and still drew a sun. The cosines are derived at the point of use.

/** Angular radius at 1x where the falloff reaches zero. 1.812 degrees. */
const SUN_DISC_EDGE_RADIANS_1X = Math.acos(0.9995)
/** Angular radius at 1x inside which the disc is at full strength. 0.573 degrees. */
const SUN_DISC_CORE_RADIANS_1X = Math.acos(0.99995)
/**
 * The cap's outer radius at `size`, DERIVED from the edge the falloff ends at.
 *
 * This is the one place the profile and the surface it is painted on have to
 * agree, and the agreement is structural rather than tested: `bake` hands this
 * function's result straight to `generateSunCap` and passes the same `size` to
 * `sunDiscAt`. A rim inside the falloff would clip the sun back into a polygon
 * — the exact bug DEV-293 removes — and a rim outside it would spend rings on
 * black; neither is reachable from here, and saying so is worth more than a
 * test that re-derives the same `acos` and calls it evidence.
 */
export const sunDiscOuterRadians = (size: number): number => SUN_DISC_EDGE_RADIANS_1X * size
/**
 * The disc's core, as a multiple of the sun's linear colour.
 *
 * Eight puts `int_01_hoverJet`'s sun at 6.6 in red against a bloom threshold of
 * 1.0, so the disc clears the high pass on its own rather than the threshold
 * being lowered to meet it — DEV-091's rule, and `content/editions/
 * anniversary.json`'s bloom note already names the sun disc as one of the three
 * things that glow.
 *
 * **`sunSize` does NOT scale this, and that is a choice with a consequence.**
 * The disc's radiance per steradian is held while its solid angle goes as the
 * square, so at 3x the sun puts roughly **nine times the energy** into the
 * frame and into the PMREM that lights the world. That is what "a bigger sun"
 * means physically and it is what Matt asked for; it is written down here
 * because it is the thing to look at first if the frame reads washed out, and
 * the dial to reach for then is this one and not the size.
 */
const SUN_DISC_GAIN = 8
/**
 * The shipped sun's angular radius, as a multiple of DEV-293's 1.812 degrees.
 *
 * **3, and it is Matt's call** — *"i'd like it to be 3x the current size"*,
 * 2026-09-22, having looked at the 1x frame. That is 5.44 degrees to the rim
 * and a 1.72-degree core, against a real sun's 0.27 and SkyJ's own bright
 * hexagon somewhere between. Hard rule 9: fidelity is deviated from
 * deliberately where the game is better for it, and there was never a faithful
 * number here to deviate FROM (DEV-008 marks the sun's size as FF2's own art).
 *
 * The gain is deliberately NOT scaled with it — see `SUN_DISC_GAIN`.
 */
const SUN_DISC_SIZE = 3
/** Rings across the cap's radius. See `generateSunCap` for why they are linear. */
const SUN_CAP_RINGS = 10
/**
 * Segments around it.
 *
 * The silhouette is NOT this polygon: the rim carries a disc value of exactly
 * zero, so what the eye reads as the sun's edge is where the falloff crosses
 * the tone curve, several rings inside the geometry. That is why 32 is enough
 * and why a count chosen for roundness would have been buying nothing.
 */
const SUN_CAP_SEGMENTS = 32
/**
 * Triangles the sun costs, on top of the dome's own.
 *
 * Exported because two e2e assertions pin the drawn dome's face count, and a
 * spec that imports this cannot go stale against a cap that is retuned — the
 * *"give the default ONE exported name"* rule (DEV-266).
 *
 * **It does not move with `sunSize`, and that is deliberate.** The slider
 * scales the ANGLES; the tessellation is fixed. So dragging it changes no draw
 * call, no vertex count and no census row — which is what lets it be a live
 * slider rather than a rebuild you have to think about, and what keeps
 * `lookdev.spec.ts`'s two dome counts and `census-baseline.json` independent
 * of a look decision.
 */
export const SUN_CAP_TRIANGLES = sunCapTriangles(SUN_CAP_RINGS, SUN_CAP_SEGMENTS)

/**
 * The disc's brightness at `cos(angle from the sun)`, as a multiple of the
 * sun's linear colour.
 *
 * Exported so the SHAPE of the sun can be asserted without a GL context — that
 * it is a plateau with a monotonic shoulder rather than a spike, and that it is
 * bright enough to clear the bloom's high pass on its own. See
 * `tests/unit/sun-disc.test.ts`, and `sunDiscOuterRadians` for the one thing
 * that is guaranteed by derivation instead.
 *
 * `size` scales the two angles, so the profile keeps its SHAPE — the core is
 * always the inner 31.6 % of the radius — and only its scale on the sky
 * changes. A profile whose core grew at a different rate to its shoulder would
 * be a different sun at every setting, which is not a size control.
 */
export const sunDiscAt = (cosAngle: number, size: number): number =>
  smoothstep(
    Math.cos(SUN_DISC_EDGE_RADIANS_1X * size),
    Math.cos(SUN_DISC_CORE_RADIANS_1X * size),
    cosAngle,
  ) * SUN_DISC_GAIN

/**
 * Everything about the sky a slider may move.
 *
 * Separated from `SkyParams` because these are FF2's ART and those are the
 * MISSION's data: a level supplies a sun and nine coefficients, and this is how
 * they get drawn. A mission cannot override them and the lookdev panel cannot
 * change the mission.
 */
export interface SkyTuning {
  /** Icosphere subdivisions. See `SKY_SUBDIVISIONS`. */
  readonly subdivisions: number
  /** How many cloud banks. */
  readonly cloudLobes: number
  /** How far a bank pulls the sky toward the cloud tint, 0..1. */
  readonly cloudDepth: number
  /** Per-face brightness variation, +/- this fraction. */
  readonly facetJitter: number
  /**
   * The sun's angular radius, as a MULTIPLE of DEV-293's 1.812 degrees.
   *
   * Scales the falloff's two angles and the cap that carries them together, so
   * the sun keeps its shape and changes its size. See `SUN_DISC_SIZE`.
   */
  readonly sunSize: number
  /** Fixed, so two loads of a mission give the same sky. */
  readonly seed: number
  /**
   * Colour the dome per VERTEX instead of per face, with no cell variation —
   * the same sky, smooth. DEV-320, wishlist #22a; `render.smoothSky` is the
   * flag that sets it and `bake` below says what changes and what does not.
   */
  readonly smooth: boolean
}

/** What ships. The lookdev panel starts here. */
export const SKY_TUNING: Readonly<SkyTuning> = Object.freeze({
  subdivisions: SKY_SUBDIVISIONS,
  cloudLobes: SKY_CLOUD_LOBES,
  cloudDepth: SKY_CLOUD_DEPTH,
  facetJitter: SKY_FACET_JITTER,
  sunSize: SUN_DISC_SIZE,
  seed: SKY_SEED,
  smooth: false,
})

/**
 * The colour of a sky-cloud bank, LINEAR.
 *
 * FF2's own, read off SkyJ's own banks: a desaturated blue-violet, darker than
 * the sky it sits in, which is what an unlit cloud against a sunset is.
 */
const CLOUD_TINT = new THREE.Color(0.055, 0.052, 0.088)

export interface SkyParams {
  /** Unit vector the sun TRAVELS along, three space — level `lighting.sun.direction`. */
  readonly sunDirection: readonly [number, number, number]
  /** Linear rgb. Level `lighting.sun.colorLinear`. */
  readonly sunColor: readonly [number, number, number]
  /** sRGB rgb. Level `fog.color`. The FALLBACK gradient's horizon. */
  readonly horizonColor: readonly [number, number, number]
  /**
   * Nine SH coefficients of the real skybox, UNITY space, linear rgb — level
   * `lighting.sky.sh`. Null for the missions whose skybox we cannot decode.
   */
  readonly skySh?: readonly (readonly number[])[] | null
}

export interface Sky {
  /**
   * Prefiltered environment. Assign to `scene.environment`.
   *
   * NOT to `scene.background` any more. A PMREM's sharpest mip is 256 px a
   * face, which is a quarter of a degree per texel at best and blurs five
   * thousand facets back into the gradient they replaced. The background is now
   * `dome`, drawn as geometry, and this texture does the LIGHTING job only —
   * where blurring is not a loss but the entire point of a prefilter.
   */
  readonly environment: THREE.Texture
  /**
   * The sky as a mesh. Add it to the scene and keep it on the camera.
   *
   * Drawn first with depth testing OFF, so it never occludes anything and needs
   * no far-plane budget of its own. Its radius is arbitrary for the same
   * reason.
   */
  readonly dome: THREE.Mesh
  /** Put the dome on the camera. Call once a frame, with the camera's WORLD position. */
  follow(eye: THREE.Vector3): void
  /** The tuning the dome was last built with. */
  readonly tuning: Readonly<SkyTuning>
  /**
   * Rebuild the dome with new tuning, and return the NEW environment texture.
   *
   * For the lookdev panel. The returned texture has to be assigned to
   * `scene.environment` by the caller — returning it rather than reaching into
   * a scene keeps this file ignorant of where its output is used, which is the
   * same reason `follow` takes a position instead of a camera.
   *
   * The MESH is reused, so the dome stays in whatever scene it was added to and
   * keeps the position `follow` last gave it. Only the geometry and the
   * prefilter are replaced.
   */
  retune(next: Partial<SkyTuning>): THREE.Texture
  /**
   * DEV-476: move the sun. The dome is baked again with its disc and glow at
   * `sunDirection` (the way the light TRAVELS, as `SkyParams` has it) in
   * `sunColor`, and prefiltered again; the returned texture is the new
   * environment, for the caller to assign, exactly as `retune`'s is. The
   * mission's nine coefficients and the fallback gradient do not move: the sky
   * is the donor's (a player course's light, `content/player-course-light.ts`).
   */
  resun(
    sunDirection: readonly [number, number, number],
    sunColor: readonly [number, number, number],
  ): THREE.Texture
  /** False when the mission's skybox could not be decoded and the gradient stood in. */
  readonly usedExtractedSky: boolean
  dispose(): void
}

// ── Why there is no sky shader any more ──────────────────────────────────
//
// There was one, and it evaluated the spherical harmonics and the sun per
// FRAGMENT on a smooth 64x32 sphere. Two things were wrong with that and only
// one of them was the smoothness.
//
// The colour of a sky is a low-frequency field — that is the whole premise of
// describing it with nine coefficients — so evaluating it a million times a
// frame buys nothing over evaluating it once per FACE at load. Five thousand
// faces, once, and then the sky is a static vertex-coloured mesh that costs one
// draw call and no shader work at all.
//
// And per-face is not a compromise here, it is the look: SkyJ is flat polygons.

const srgbToLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4

/**
 * The drawable dome: the material, the mesh, and the draw order it ships in.
 *
 * ── It is drawn LAST now, and the old reasoning is why it CAN be ─────────
 *
 * This block used to read *"`depthTest: false` and a very negative
 * `renderOrder` make it a true background: drawn first, never occluding, and
 * needing no far-plane budget — which is why its radius is arbitrary and why
 * nothing in it ever z-fights the terrain."* Every clause of that is still
 * true and the dome is now drawn **last among the world's opaques**, at the far
 * plane, with the depth test back ON (DEV-241).
 *
 * Nothing in the old sentence was wrong; it was a statement about what the dome
 * must NOT do, and *drawn first* was one way of guaranteeing it rather than the
 * only one. `z = w` with `depthWrite` off is the other, and it guarantees the
 * same three things by a stronger route — the dome now draws only where the
 * depth buffer is still at its cleared 1.0, so *never occluding* is a property
 * of the depth test instead of a property of the submission order, and the
 * radius stops being consulted at all rather than merely not mattering. What it
 * buys is the pixels the world covers: **-0.18 to -0.25 ms p50 on four missions
 * across three environments**, measured in `docs/plan/VR-PERF-WAVE-4.md` §3.5,
 * queue E. `render/draw-order.ts`'s `setSkyLast` has the clause-by-clause
 * argument and the pin.
 *
 * ── Why the OLD state is what is constructed here ────────────────────────
 *
 * The mesh is built at `SKY_FIRST_ORDER` with `depthTest: false` and the
 * default is then thrown on it in one line. That is deliberate and it is the
 * whole reason `__ff2.drawOrderSwitch('sky', false)` can be trusted: the switch
 * records what it found, so the OFF arm hands back the state this constructor
 * made — the build every wave-3 and wave-4 baseline was taken on — instead of a
 * second opinion about what that state was (trap 24: assert the relationship,
 * do not write the value twice).
 *
 * `fog` is off. It is the one surface in the scene that must not be fogged:
 * distant geometry fades TOWARD the sky, and fogging the sky as well would fade
 * it toward itself and wash the whole frame. 2016's `excludeFarPixels` says the
 * same thing about its own skybox.
 *
 * Exported so a node test can hold the shipped dome without a GL context —
 * `createSky` needs a renderer for the PMREM prefilter and this does not.
 */
export const createSkyDomeMesh = (geometry: THREE.BufferGeometry): THREE.Mesh => {
  // `BackSide` because we are inside it.
  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
    fog: false,
    toneMapped: true,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'sky-dome'
  mesh.scale.setScalar(SKY_RADIUS)
  mesh.renderOrder = SKY_FIRST_ORDER
  mesh.frustumCulled = false
  mesh.matrixAutoUpdate = false
  // The default, DEV-241. One line, and the line above is what it undoes.
  setSkyLast(mesh, true)
  return mesh
}

/** A mission's sky, ready to bake at any tuning. See `skyBaker`. */
export interface SkyBaker {
  /** The dome's geometry, coloured, at `tuning`. A new geometry every call. */
  bake(tuning: SkyTuning): THREE.BufferGeometry
  /** False when the mission's skybox could not be decoded and the gradient stood in. */
  readonly usedExtractedSky: boolean
}

/**
 * Everything `createSky` does except the prefilter: the dome's geometry and its
 * colours, from the mission and the tuning.
 *
 * Split out so a node test can hold the bake — `createSky` needs a renderer for
 * the PMREM and this does not, the same reason `createSkyDomeMesh` is exported.
 */
export const skyBaker = (p: SkyParams): SkyBaker => {
  // The extracted sky, if this mission has one. Nine coefficients or nothing:
  // a partial array would reconstruct a different sky rather than a worse one.
  const sh = p.skySh && p.skySh.length === 9 ? p.skySh : null

  const horizon = new THREE.Color(
    srgbToLinear(p.horizonColor[0]),
    srgbToLinear(p.horizonColor[1]),
    srgbToLinear(p.horizonColor[2]),
  )

  // FF2's own art. Derived from the horizon so the sky stays coherent with
  // whatever fog a mission authored — every mission gets a sky that belongs to
  // it rather than one tuned for Simonet and reused.
  const zenith = horizon
    .clone()
    .multiplyScalar(0.3)
    .lerp(new THREE.Color(0.06, 0.1, 0.22), 0.55)
  const nadir = horizon.clone().multiplyScalar(0.12)

  const sunDir = new THREE.Vector3(...p.sunDirection).normalize()
  const sunColor = new THREE.Color(p.sunColor[0], p.sunColor[1], p.sunColor[2])
  const rgb = { r: 0, g: 0, b: 0 }

  /**
   * Cosine of the angle between a view direction and the SUN, clamped at zero.
   *
   * `sunDirection` is the direction the light TRAVELS, so the sun is at
   * `-sunDir` and the dot product is negated. One negation, in one place, for
   * the same reason the SH evaluation keeps its z-flip in one place.
   */
  const cosA = (dx: number, dy: number, dz: number): number => {
    const d = -(dx * sunDir.x + dy * sunDir.y + dz * sunDir.z)
    return d > 0 ? d : 0
  }

  // ── colour every face, once ─────────────────────────────────────────────
  //
  // A function of the tuning rather than a straight line, so the lookdev panel
  // can re-run it. Everything it needs from the MISSION — the coefficients, the
  // sun, the fallback gradient — is captured; everything from the ART is an
  // argument.
  const bake = (tuning: SkyTuning): THREE.BufferGeometry => {
    const dome = generateSkyDome(tuning.subdivisions, tuning.seed)
    const lobes = skyCloudLobes(tuning.cloudLobes, tuning.seed + 1)
    const cap = generateSunCap(
      // The sun SITS where the light comes FROM, and `sunDirection` is the
      // direction it TRAVELS — the same negation the face loop's `cosA` does.
      [-sunDir.x, -sunDir.y, -sunDir.z],
      sunDiscOuterRadians(tuning.sunSize),
      SUN_CAP_RINGS,
      SUN_CAP_SEGMENTS,
    )
    const totalTriangles = dome.triangleCount + cap.triangleCount
    const positions = new Float32Array(totalTriangles * 9)
    const colors = new Float32Array(totalTriangles * 9)
    positions.set(dome.positions, 0)
    positions.set(cap.positions, dome.triangleCount * 9)

    // One draw per face, fixed by the seed, so two loads give the same sky.
    const facetRnd = makeRandom(tuning.seed + 2)

    // ── the sky in one direction, without the disc and without the cell ────
    //
    // Everything the dome and the cap agree about, factored out so they cannot
    // disagree. The dome then quantises this per FACE and multiplies in its
    // cell variation; the cap evaluates it per VERTEX and adds the disc. Split
    // here rather than duplicated because the cap's rim has to meet the dome
    // it sits on — at the rim the disc is exactly zero, so the only difference
    // left across that seam is the facet step that is already everywhere else
    // in this sky (DEV-293).
    const radianceAt = (dx: number, dy: number, dz: number): void => {
      let r: number
      let g: number
      let b: number
      if (sh) {
        // The coefficients are in UNITY space, so the direction goes back into it
        // before evaluation — one negated z, in one place, rather than nine
        // pre-rotated coefficients.
        shRadiance(sh, dx, dy, -dz, rgb)
        r = rgb.r
        g = rgb.g
        b = rgb.b
      } else {
        // The fallback gradient, for the ten missions whose skybox is a Unity
        // `.cubemap` binary the extractor cannot decode. Same shape the fragment
        // shader had: a tight horizon band, because that is what makes a low sun
        // read as a low sun rather than as a wash.
        const up = dy > 0 ? (dy > 1 ? 1 : dy) : 0
        const down = dy < 0 ? (dy < -1 ? 1 : -dy) : 0
        const t = up ** 0.42
        const u = down ** 0.5
        r = (horizon.r + (zenith.r - horizon.r) * t) * (1 - u) + nadir.r * u
        g = (horizon.g + (zenith.g - horizon.g) * t) * (1 - u) + nadir.g * u
        b = (horizon.b + (zenith.b - horizon.b) * t) * (1 - u) + nadir.b * u
      }

      // ── the cloud banks ───────────────────────────────────────────────────
      //
      // SkyJ's upper sky is full of chunky dark-blue cloud masses, and nine
      // coefficients cannot hold them — they are most of the extractor's 37.6%
      // residual. FF2's own, and the same construction as the real clouds: a few
      // directional lobes, per face, so they arrive already faceted.
      const mask = skyCloudMask(lobes, tuning.cloudLobes, dx, dy, dz) * tuning.cloudDepth
      if (mask > 0) {
        r += (CLOUD_TINT.r - r) * mask
        g += (CLOUD_TINT.g - g) * mask
        b += (CLOUD_TINT.b - b) * mask
      }

      // ── the sun's GLOW, but not its disc ──────────────────────────────────
      //
      // The broad warmth the sun throws into the sky around it. This is a
      // low-frequency field like everything else here — `c ** 6` is 90 degrees
      // wide and `c ** 96` is seven — so quantising it per face is the look
      // rather than a loss.
      //
      // The DISC used to be added here too, as `smoothstep(0.9995, 0.99995,
      // cosA) * 8`, and that was the bug: a feature 1.8 degrees across, sampled
      // once per 1.4-degree triangle, is three or four polygons whose union is
      // an asymmetric shard. It is on the cap now. See `generateSunCap`.
      const c = cosA(dx, dy, dz)
      const glow = c ** 96 * 0.55 + c ** 6 * 0.2
      r += sunColor.r * glow
      g += sunColor.g * glow
      b += sunColor.b * glow

      rgb.r = r
      rgb.g = g
      rgb.b = b
    }

    // ── smooth: the same field per VERTEX, and no cell (DEV-320) ───────────
    //
    // Wishlist #22a, *"toggle the faceted sky"*. Every vertex takes the sky's
    // colour in its OWN direction, so the copies of a shared vertex agree and
    // the rasteriser interpolates one continuous gradient across the same
    // triangles. The cell variation is dropped because it is what makes the
    // facets legible (`SKY_FACET_JITTER`'s note). Nothing else moves: the mesh,
    // its draw order, layer and material, the sun cap (per vertex already), and
    // the environment, which is still the prefilter of whatever is drawn.
    //
    // DEV-307 tried this as `scene.background` instead and the world vanished
    // on Anniversary. three draws its background box FIRST in every
    // `renderer.render` call, and bloom's UI pass is a second call over the
    // finished frame. A dome-layer mesh never reaches that pass; this is one.
    //
    // Normalised because the dome's vertices are jittered off the unit sphere
    // (`generateSkyDome`), and the coefficients want a direction.
    if (tuning.smooth) {
      for (let v = 0; v < dome.triangleCount * 3; v++) {
        const o = v * 3
        const px = positions[o] as number
        const py = positions[o + 1] as number
        const pz = positions[o + 2] as number
        const length = Math.hypot(px, py, pz)
        radianceAt(px / length, py / length, pz / length)
        colors[o] = rgb.r
        colors[o + 1] = rgb.g
        colors[o + 2] = rgb.b
      }
    } else {
      for (let f = 0; f < dome.triangleCount; f++) {
        const dx = dome.faceDirections[f * 3] as number
        const dy = dome.faceDirections[f * 3 + 1] as number
        const dz = dome.faceDirections[f * 3 + 2] as number
        radianceAt(dx, dy, dz)

        // The cell variation. It is the LAST thing the dome does, and the sun's
        // disc is no longer among the things it could dim — which is what the
        // old ordering note here was protecting, now guaranteed by the disc
        // living on a surface this loop does not touch.
        const cell = 1 + (facetRnd() * 2 - 1) * tuning.facetJitter
        const r = rgb.r * cell
        const g = rgb.g * cell
        const b = rgb.b * cell

        const o = f * 9
        for (let k = 0; k < 3; k++) {
          colors[o + k * 3] = r
          colors[o + k * 3 + 1] = g
          colors[o + k * 3 + 2] = b
        }
      }
    }

    // ── and the disc, per VERTEX, on its own surface ───────────────────────
    //
    // The same two-edged falloff the face loop used to carry, evaluated where
    // the geometry can resolve it. `vertexCosines` is the cosine of the angle
    // from the sun at each vertex, so the profile is a function of the cap's
    // own parameter rather than of a dot product recomputed from a position —
    // one fewer place for the negation to go the wrong way.
    const capBase = dome.triangleCount * 9
    for (let t = 0; t < cap.triangleCount; t++) {
      for (let k = 0; k < 3; k++) {
        const o = capBase + t * 9 + k * 3
        const px = positions[o] as number
        const py = positions[o + 1] as number
        const pz = positions[o + 2] as number
        radianceAt(px, py, pz)
        const disc = sunDiscAt(cap.vertexCosines[t * 3 + k] as number, tuning.sunSize)
        colors[o] = rgb.r + sunColor.r * disc
        colors[o + 1] = rgb.g + sunColor.g * disc
        colors[o + 2] = rgb.b + sunColor.b * disc
      }
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    return geometry
  }

  return { bake, usedExtractedSky: sh !== null }
}

/**
 * Build the sky and prefilter it.
 *
 * `PMREMGenerator.fromScene` renders the sky into a cubemap and runs the
 * roughness prefilter in one step. It is a one-off cost at load — a few
 * milliseconds — and after it the environment is a plain texture that costs
 * nothing per frame.
 *
 * The renderer is needed because the prefilter runs on the GPU. Call this AFTER
 * the renderer exists and before the first frame.
 *
 * `initial` is laid over `SKY_TUNING` for the FIRST bake, so a sky that is
 * going to be smooth (DEV-320) is not baked and prefiltered faceted first.
 */
export const createSky = (
  renderer: THREE.WebGLRenderer,
  p: SkyParams,
  initial: Partial<SkyTuning> = {},
): Sky => {
  let baker = skyBaker(p)
  let tuning: SkyTuning = { ...SKY_TUNING, ...initial }
  let geometry = baker.bake(tuning)

  const mesh = createSkyDomeMesh(geometry)
  const material = mesh.material as THREE.MeshBasicMaterial

  // ── and the same sky, prefiltered, for lighting ────────────────────────
  //
  // The dome itself goes through `PMREMGenerator`, so what lights the world is
  // exactly what is behind it — including the cloud banks and the sun, which
  // the old shader-sphere route also gave but which would be lost if the
  // background and the environment were built from different things.
  const prefilter = (g: THREE.BufferGeometry): THREE.WebGLRenderTarget => {
    const skyScene = new THREE.Scene()
    const probeMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.BackSide,
      fog: false,
    })
    const probe = new THREE.Mesh(g, probeMaterial)
    skyScene.add(probe)

    const pmrem = new THREE.PMREMGenerator(renderer)
    pmrem.compileEquirectangularShader()
    const built = pmrem.fromScene(skyScene, 0, 0.1, 100)
    skyScene.remove(probe)
    probeMaterial.dispose()
    pmrem.dispose()
    return built
  }
  let target = prefilter(geometry)

  /** The dome baked again from `baker`, under the SAME mesh, and prefiltered again. */
  const rebake = (next: Partial<SkyTuning>): THREE.Texture => {
    tuning = { ...tuning, ...next }
    const rebuilt = baker.bake(tuning)
    // Swap under the SAME mesh, so the dome keeps its place in whatever scene
    // it was added to and the position `follow` last gave it.
    const old = mesh.geometry
    mesh.geometry = rebuilt
    old.dispose()
    geometry = rebuilt

    const previous = target
    target = prefilter(rebuilt)
    previous.dispose()
    return target.texture
  }

  return {
    get environment() {
      return target.texture
    },
    dome: mesh,
    get tuning() {
      return tuning
    },
    resun(sunDirection, sunColor) {
      // A new baker over the same mission, the sun moved; then `retune`'s own
      // swap, so the mesh, its scene and its place are kept.
      baker = skyBaker({ ...p, sunDirection, sunColor })
      return rebake({})
    },
    retune(next) {
      return rebake(next)
    },
    follow(eye: THREE.Vector3) {
      // The camera's WORLD position, and the caller is responsible for that
      // being a world position — in the cockpit `camera.position` is the head
      // pose inside the XR rig, which is the origin. A sky pinned to the origin
      // parallaxes against a world 4 km across. See `render/unity-fog.ts` for
      // the same mistake costing a visible artifact.
      mesh.position.copy(eye)
      mesh.updateMatrix()
    },
    usedExtractedSky: baker.usedExtractedSky,
    dispose() {
      target.dispose()
      mesh.geometry.dispose()
      material.dispose()
    },
  }
}
