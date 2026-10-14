// src/render/shadows.ts — one directional shadow map, from the mission sun.
//
// ANNIVERSARY.md §3.2 V3 and §1.5 item 2. `int_01`'s sun is **4 degrees above
// the horizon** (`lighting.sun.elevationDeg`, 4.00003) and nothing in this port
// has ever thrown a shadow: the terrain is lit by N.L alone, every sunward slope
// is the same brightness at every distance, and the massif reads as a relief map
// under a lamp (§1.3 item 2). A shadow's LENGTH is a ruler laid on the ground,
// which is why §1.5 ranks this second of the eight scale cues.
//
// 2016 had them: `shadows: 2` — Unity's `LightShadows.Soft` — on twelve of the
// thirteen missions (`int_02_hoverJet` is `1`, Hard), `ShadowManager`'s
// `shadowDistance = 384`, and `shadowCastingMode = Off` above LOD 0
// (`FacetedTerrain.cs:721`). Research 04 §9.2. So the caster set below is 2016's
// and only the distance is ours.
//
// ── What a 4-degree sun does to the fit, which is the whole problem ───────
//
// king-tide's `scene.ts` follows its bike with a 1024-squared PCF map on a
// ±90 m box, under a high sun. A 4-degree sun has the opposite problem in both
// axes:
//
//  * **Long down-sun.** A 1,536 m height band (Simonet's `terrainHeight`)
//    occupies **22 km** along a 4-degree ray — `1536 / sin(4°)` — so the set of
//    casters that can geometrically reach the box is most of the map and then
//    some. `castDistance` is where we stop looking; it is a preset number
//    because it is the one knob that trades frame time against a shadow that
//    is really there. On Simonet 4 km is the whole island.
//  * **Wrong axis for `normalBias`.** The usual acne fix offsets the receiver
//    along its own normal. With the light 4 degrees off horizontal, moving
//    1 m up a vertical normal moves you 0.998 m SIDEWAYS in the shadow map and
//    0.070 m in depth — so it buys lateral peter-panning rather than depth
//    headroom, and the depth `bias` is doing most of the work here. Both are
//    preset numbers and both are in METRES (see `bias` below).
//
// ── The box follows the CAMERA, not the ship ──────────────────────────────
//
// The thing being shadowed is the frame, and the frame belongs to the camera.
// In the cockpit that is the same point — the rig sits at the ship's eye — and
// in chase it is thirty metres behind it. The case where they differ is
// `?view=cam`, which parks the camera at a viewpoint while the ship sits on the
// start grid: a ship-centred box would put every shadow in the game somewhere
// off screen, on the one path anybody photographs this from. It takes the
// camera's WORLD position (trap 18: in the cockpit `camera.position` is the head
// pose inside the rig and is the origin until you lean).
//
// ── Texel snapping, because the alternative crawls ────────────────────────
//
// An orthographic box that follows anything re-samples the world onto a
// different texel grid every frame, and a shadow edge one texel wide then
// shimmers along its whole length as you fly. The standard fix, and the one
// here: quantise the box's centre to whole texels IN THE LIGHT'S OWN LATERAL
// BASIS, so the grid is stationary in world space and an edge lands on the same
// texels frame after frame. The basis has to be three's own, or the lattice
// would be quantising against axes the shadow camera does not use —
// `lightBasis` transcribes `Matrix4.lookAt`, degenerate branch included.
//
// ── What three 0.185.1 actually does, checked rather than remembered ──────
//
// The same discipline DEV-081 applied to tone mapping, and it lands in the same
// place — the received wisdom is wrong about this build:
//
//  * **`PCFSoftShadowMap` is DEPRECATED.** `WebGLShadowMap.render` warns and
//    substitutes `PCFShadowMap` (`three.module.js:9148-9152`). So this file asks
//    for `PCFShadowMap` and gets what the other name would have given it,
//    without a warning a frame. And `PCFShadowMap` in this revision is not the
//    old 2x2: it is a **five-tap Vogel disk on a `sampler2DShadow`**, rotated
//    per pixel by an interleaved gradient noise, with `shadowRadius` scaling the
//    disk in texels (`shadowmap_pars_fragment`). `radius` is therefore a real
//    penumbra knob and not a no-op.
//  * **`receiveShadow` is a UNIFORM, not a define.** `lights_pars_begin` opens
//    `uniform bool receiveShadow` and `WebGLRenderer` pushes it per object
//    (`:18681-18684`) whenever it differs from the last one drawn with that
//    material. It is NOT in `needsProgramChange`'s list (`:18382-18490`). So
//    changing `receiveShadow` on a flip needs **no `material.needsUpdate`** —
//    which is the opposite of what every article about this says, and is why
//    this file dirties nothing.
//  * **`light.castShadow` recompiles by itself.** It changes
//    `numDirectionalShadows` in `WebGLLights`' hash, which bumps
//    `state.version` (`:8805-8849`), which is the FIRST branch of
//    `needsProgramChange`. So flipping the preset recompiles every lit material
//    without anyone traversing the scene — and it is why this file always moves
//    `shadowMap.enabled` and `sun.castShadow` together. Moving only the former
//    would change `USE_SHADOWMAP` with nothing to notice.
//  * **An invisible object casts nothing.** `renderObject` returns on
//    `object.visible === false` (`:9558`), so the ship's exterior hull — which
//    `flight.ts` hides in first person — cannot cast there.
//  * **The layer test is against the VIEW camera, not the shadow camera**
//    (`:9560`, `object.layers.test( camera.layers )` where `camera` is the one
//    passed to `render()`). DEV-043's trap, one step further along: an object
//    the player's camera cannot see cannot cast either.
//  * **And `material.visible` is read in the shadow pass too**, on the object's
//    OWN material and before the depth material is built. So the three ways
//    anybody would reach for to keep a caster out of the frame are three
//    refusals of the same kind, and what is left is a draw that writes no
//    colour and no depth — `colorWrite` and `depthWrite`, which the shadow
//    pass never reads because it renders `_depthMaterial` instead. DEV-305.
//  * **`castShadow` is read on the MESH, and only on the Mesh** — the test
//    sits inside `if ( visible && ( object.isMesh || ... ) )`, so a flag on a
//    glTF scene root reaches nothing. It is why `SunShadowScene` takes LISTS
//    of meshes; `shadowMeshesOf` has the whole of it, and the hull had never
//    cast a shadow anywhere before DEV-305 because of it.
//
// ── The caster set is a LIST, and one entry of it is a preset's (DEV-224) ─
//
// `shadowFlagsFor` is a transcription of 2016 everywhere except one row. The
// SCATTER — 5,962 instances on desert in 18 `InstancedMesh`es — is 88-93 % of
// the world pass on desert and alpine, and the depth pass draws every one of
// those triangles a second time; `2 x world + 1 x shadow` closes desert's
// stereo frame to 0.01 M. So `props.scatterShadows.enabled` can take that one
// class out of the caster set while the map, the land, the landmarks and the
// hull stay exactly as they were, and while the scatter goes on RECEIVING.
// `ShadowCasters` is the whole of what a preset may argue with; everything
// else in the table is 2016's and is not reachable from the JSON.
//
// ── What it must never touch ──────────────────────────────────────────────
//
// Classic. Every number below is inert while `enabled` is false, no object is
// given a flag, `renderer.shadowMap.enabled` stays false and no program moves.
// And nothing under `src/sim/`: this is a depth pass and two object flags.

import * as THREE from 'three'
import type { ComfortSettings } from '@/boot/settings'
import type { Edition, EditionShadows } from '@/content/edition-schema'
import type { EditionState } from '@/game/edition'
import { forEachMeshMaterial } from './scene-walk'

/**
 * Which classes of object take part, and how. One table, read by this file AND
 * by `game/terrain/load-terrain.ts`, so the LOD-0 rule cannot be written twice
 * and drift.
 */
export type ShadowRole =
  /** A land chunk. Casts at LOD 0 only (2016); receives at every LOD. */
  | 'terrain-chunk'
  /** A water chunk. Neither — see `shadowFlagsFor` for why. */
  | 'ocean-chunk'
  /**
   * One of the SCATTER's `InstancedMesh`es. Receives always; casts only while
   * the caster set carries it (`ShadowCasters.scatter`, DEV-224).
   */
  | 'prop-scatter'
  /** One of the hand-placed landmarks' `InstancedMesh`es. Casts and receives. */
  | 'prop-landmark'
  /** `ship_third_person`, the exterior hull. Casts; does not receive. */
  | 'ship-exterior'
  /** `ship_first_person`, the cockpit shell. Neither. */
  | 'ship-cockpit'
  /**
   * An AI racer's hull, wing and glow (DEV-350). The player's hull's row —
   * casts, does not receive — but only while the caster set carries racers.
   */
  | 'racer-hull'
  /** A generated cloud lobe. Neither. */
  | 'cloud'
  /** A checkpoint ring, an orb, a pad, a turn indicator. Neither. */
  | 'ring'
  /** Particles, motes, trails, the comfort overlays, the HUD. Neither. */
  | 'effect'

/** three's two flags, as the only part of an `Object3D` this file writes. */
export interface ShadowFlags {
  castShadow: boolean
  receiveShadow: boolean
}

export interface ShadowRoleFlags {
  readonly cast: boolean
  readonly receive: boolean
}

const NO_SHADOWS: ShadowRoleFlags = { cast: false, receive: false }

/**
 * Which OPTIONAL classes are in the caster set. DEV-224's scatter, and
 * DEV-350's racers.
 *
 * A class is in here rather than in `ShadowRole` when the answer is a decision
 * somebody took for frame time, not a transcription of what 2016 did. Everything
 * that is not in here casts by the table below and cannot be switched off, which
 * is the point: `ShadowCasters` is the list of things the preset is allowed to
 * argue with.
 */
export interface ShadowCasters {
  /**
   * The scatter's `InstancedMesh`es — `props.scatterShadows.enabled`.
   *
   * 2016's answer, and the port's up to DEV-224, is true. Anniversary ships
   * false because the scatter is 88–93 % of desert's and alpine's world pass
   * and the depth pass draws all of it again.
   */
  readonly scatter: boolean
  /**
   * The AI racers' hulls — `render.racerLivery` AND its `shadow` (DEV-350).
   *
   * 2016's answer is true: `GhostRacer.prefab`'s hull is `m_CastShadows: 1`.
   * The port's racers cast nothing until DEV-350, because a translucent
   * hologram casting a solid shadow would be a lie — which is why this is
   * composed with the LIVERY flag and not only the shadow's, so a flip back to
   * the hologram takes its shadow with it.
   */
  readonly racers: boolean
}

/**
 * 2016's set: everything casts.
 *
 * It is the DEFAULT of `shadowFlagsFor` deliberately. A caller that has not
 * heard of DEV-224 gets the FAITHFUL answer and pays for it, rather than
 * silently shedding pixels somebody else decided to shed — the same polarity
 * `on = false` has, where the safe default is "write nothing".
 */
export const ALL_CASTERS: ShadowCasters = { scatter: true, racers: true }

/**
 * Which OPTIONAL classes RECEIVE. The other half of `ShadowCasters`, DEV-306.
 *
 * Its own bag rather than a field on `ShadowCasters` because that type is
 * named after what it is, and a `cockpit` boolean inside something called
 * "casters" would be a name that had quietly stopped being true. Two bags in
 * one signature read as a pair; one bag with a lie in it reads as a rename
 * nobody did.
 */
export interface ShadowReceivers {
  /**
   * The cockpit shell — `render.cockpitShadow.enabled`. DEV-306.
   *
   * FALSE is 2016, and 2016 is a transcription rather than a decision here:
   * the row below is `NO_SHADOWS` because Unity's cockpit was in neither set,
   * not because anybody weighed it. The file's own argument against the
   * cockpit CASTING — the canopy's shadow across the dashboard at a 0.68 m
   * texel — says nothing about receiving, which is a per-fragment sample on
   * geometry already in the frame and has no shimmer of its own.
   */
  readonly cockpit: boolean
}

/** 2016's receiver set. The cockpit is in neither set there. */
export const RECEIVERS_2016: ShadowReceivers = { cockpit: false }

/**
 * Every MESH in a subtree, as `ShadowFlags`. DEV-305.
 *
 * ── The bug this exists for, and it had been live since DEV-086 ──────────
 *
 * three reads `castShadow` off the object it is about to DRAW.
 * `WebGLShadowMap.renderObject` recurses through the tree and tests
 * `object.castShadow` **inside** `if ( visible && ( object.isMesh || ... ) )`,
 * so the flag is consulted on Meshes and on nothing else. `boot/app.ts` handed
 * the ship's exterior as `getObjectByName('ship_third_person')`, which is the
 * glTF SCENE ROOT — a `Group` — and `hoverjet-exterior.glb` is one node,
 * `ship_ext_orange`, under it. So `castShadow = true` was written on a node
 * three never draws and the one node it does draw kept three's default of
 * false.
 *
 * **The hull has therefore never cast a shadow anywhere** — not in the hangar,
 * not in chase, not once since the map landed. This file's own header said it
 * *"casts only in the hangar and in chase"*, `shadowFlagsFor('ship-exterior')`
 * has returned `{cast: true}` the whole time, and a unit test asserted that
 * row and was right about it: the TABLE was never the thing that was wrong.
 * That is DEV-069's lesson in a new place — a value nothing downstream
 * consults is documentation, not a guard — and it is why this returns the
 * meshes rather than the root.
 *
 * Structural, not `THREE.Object3D`, for `ShadowRenderer`'s reason: the tests
 * that matter here must not need a GL context or a real scene graph. A real
 * `Object3D` satisfies it.
 */
export interface ShadowTree extends ShadowFlags {
  readonly isMesh?: boolean
  readonly children?: readonly ShadowTree[]
}

export const shadowMeshesOf = (root: ShadowTree | null | undefined): ShadowFlags[] => {
  const out: ShadowFlags[] = []
  const walk = (node: ShadowTree): void => {
    if (node.isMesh === true) out.push(node)
    for (const child of node.children ?? []) walk(child)
  }
  if (root) walk(root)
  return out
}

/**
 * Draw a subtree that contributes no colour and no depth. DEV-305.
 *
 * The only way left to keep an object OUT of the frame and IN the shadow map,
 * and the header above says why the other three are not ways: `object.visible`,
 * `material.visible` and the layer test are all read by the shadow pass too,
 * each by a different line, each a flat refusal.
 *
 * `depthWrite` matters as much as `colorWrite` and for a different reason. With
 * colour masked and depth still written the hull punches a silhouette-shaped
 * hole in the depth buffer from a metre in front of the eye, and everything
 * behind it — the whole world — fails the depth test. That is not a subtle
 * artifact; it is the game rendered as a ship-shaped window onto the clear
 * colour, and it is what you get from the obvious half of this fix.
 *
 * The shadow pass reads neither: it renders three's `_depthMaterial`, built by
 * `getDepthMaterial`, which copies `side`, `alphaTest` and the clipping planes
 * and not these. Checked against three's own build in `shadows.test.ts`.
 *
 * Returns how many materials moved, for the same reason `applyShadowFlags`
 * returns a count: "nothing was written" is a stronger claim than "the fields
 * are false", and it is the claim the Classic assertion needs.
 */
export const setColourlessDraw = (root: THREE.Object3D | null | undefined, on: boolean): number => {
  if (!root) return 0
  let changed = 0
  forEachMeshMaterial(root, (material) => {
    // `!==` before the write, not a blind assignment: three's `Material` has
    // no setter here, so a blind write costs nothing at runtime, but the
    // COUNT is what a test reads, and a count that always equals the mesh
    // count says nothing about whether the state moved.
    if (material.colorWrite !== !on) {
      material.colorWrite = !on
      changed++
    }
    if (material.depthWrite !== !on) {
      material.depthWrite = !on
      changed++
    }
  })
  return changed
}

/**
 * What one object's flags should be, for a role, at a LOD, with the map on.
 *
 * `on` false is ALWAYS `{false, false}` — that is the Classic invariant stated
 * once, in the one place both callers go through, rather than as a guard each
 * of them remembers.
 *
 * The four rows that are decisions rather than transcriptions:
 *
 *  * **LOD 0 casts and nothing above it does.** 2016's
 *    `shadowCastingMode = Off` above LOD 0 (`FacetedTerrain.cs:721`). It is also
 *    the only version that is affordable: the coarse chunks are the far ones and
 *    a shadow from 3 km away lands outside the box anyway.
 *  * **Every LOD receives.** A chunk that changes LOD under the shadow would
 *    otherwise pop from shaded to lit, which is a worse artifact than a slightly
 *    coarse receiver.
 *  * **The ocean does neither.** It COULD receive — it is a patched
 *    `MeshStandardMaterial`, not a `ShaderMaterial`, its displacement runs in
 *    `begin_vertex` which is upstream of `shadowmap_vertex`, and a directional
 *    light's shadow coordinate is affine in world position so even an 8 km quad
 *    interpolates it exactly. It is off because of WHERE the sea's sunlight is
 *    computed: `render/water.ts` injects the specular and the sky reflection at
 *    `<opaque_fragment>`, which is downstream of `getShadow`, so a shadowed sea
 *    would keep its full 4-degree glint inside the shadow — and at 4 degrees the
 *    glint band and the shadows lie along the same bearing, so the two would be
 *    in frame together. A dark band with the sun still in it reads as a bug.
 *  * **The cockpit shell does neither, in THIS map.** Casting would put the
 *    canopy's own shadow across the dashboard at a 0.68 m texel and an 0.08 m
 *    near plane, which is shimmer you cannot look away from in a headset. The
 *    cockpit shadows itself through a second map of its own instead, at 3.3 mm
 *    a texel: `render/cockpit-self-shadow.ts`, DEV-323.
 *
 * And two rows that are a PRESET's rather than this table's. The SCATTER casts
 * only while `casters.scatter` says so, and it subtracts exactly one class:
 * the landmarks, the land and the hull are not reachable from it, and the
 * scatter goes on RECEIVING either way. DEV-224. The AI RACERS cast only while
 * `casters.racers` says so, which composes their livery — a hologram casts
 * nothing. DEV-350. Those two flags are the only things in the signature, `on`
 * aside, that can subtract a caster.
 */
export const shadowFlagsFor = (
  role: ShadowRole,
  on: boolean,
  lod = 0,
  casters: ShadowCasters = ALL_CASTERS,
  receivers: ShadowReceivers = RECEIVERS_2016,
): ShadowRoleFlags => {
  if (!on) return NO_SHADOWS
  switch (role) {
    case 'terrain-chunk':
      // `<= 0`, not `=== 0`: DEV-085's detail ring is LOD **-1** — finer than
      // anything 2016 had, and the ground nearest the seat. With `=== 0` the
      // ten chunks within 320 m of the ship were receivers only, measured on
      // `int_01`'s `island-lit` stand: 49 chunks at 2,312 triangles casting, 10
      // at 8,712 not — a 640 m hole in the caster set exactly where §1.5's
      // scale ladder starts. 2016's rule is "nothing COARSER than LOD 0 casts",
      // and the ring is not coarser. DEV-115.
      return { cast: lod <= 0, receive: true }
    case 'prop-scatter':
      // The one row a preset can move (DEV-224). `receive` is NOT conditional:
      // dropping it would light every tree in the ridge's shadow, which is a
      // brighter forest rather than a cheaper one — the receiving is per
      // fragment on geometry that is already in the frame, and what DEV-224
      // buys back is the depth pass's second draw of it.
      return { cast: casters.scatter, receive: true }
    case 'prop-landmark':
      return { cast: true, receive: true }
    case 'ship-exterior':
      return { cast: true, receive: false }
    case 'ship-cockpit':
      // DEV-306, wishlist #30. 2016's answer is `{false, false}` and it stays
      // the default (`RECEIVERS_2016`); a preset may turn the RECEIVE half on
      // and may not turn the cast half on at all — the canopy's own shadow
      // across the dashboard at a 0.68 m texel is the argument the header
      // makes, and it is about casting.
      return { cast: false, receive: receivers.cockpit }
    case 'racer-hull':
      // DEV-350. The player's hull's answer, `{true, false}`, behind the one
      // flag a preset may argue with. Not receiving is the player's row too,
      // and for the same reason: a racer is lit exactly like the ship beside it.
      return { cast: casters.racers, receive: false }
    default:
      return NO_SHADOWS
  }
}

/** An object and what it is, for `applyShadowFlags`. */
export interface ShadowSubject {
  readonly role: ShadowRole
  readonly target: ShadowFlags
  /** Terrain only. Ignored by every other role. */
  readonly lod?: number
}

/**
 * Write the flags for a list of subjects. Returns how many objects moved.
 *
 * The count is what the Classic test asserts: applying Classic to a scene that
 * has never had shadows must move **zero** objects, which is a stronger claim
 * than "the flags are false" — it says nothing was written at all.
 */
export const applyShadowFlags = (
  subjects: Iterable<ShadowSubject>,
  on: boolean,
  casters: ShadowCasters = ALL_CASTERS,
  receivers: ShadowReceivers = RECEIVERS_2016,
): number => {
  let changed = 0
  for (const { role, target, lod } of subjects) {
    const want = shadowFlagsFor(role, on, lod ?? 0, casters, receivers)
    if (target.castShadow !== want.cast) {
      target.castShadow = want.cast
      changed++
    }
    if (target.receiveShadow !== want.receive) {
      target.receiveShadow = want.receive
      changed++
    }
  }
  return changed
}

// ── the frustum fit ───────────────────────────────────────────────────────

export type Vec3 = readonly [number, number, number]

/**
 * The smallest `sin(elevation)` `casterSpan` will divide by — 0.5 degrees.
 *
 * A sun ON the horizon casts a shadow of infinite length. Nothing in the fit
 * divides by it; this only keeps the diagnostic finite.
 */
export const MIN_SUN_SIN = 0.0087265

/**
 * ── The light does not move, and that is the point ───────────────────────
 *
 * The obvious shape for a follow frustum is to fly the light along with the box
 * — put it at `centre - sunDirection * D` and aim it at `centre`. This does not,
 * and the reason is `boot/app.ts`: `applyLighting` places the mission sun at
 * `-direction x 10000` with its target at the origin, and the frame loop
 * REWRITES that position every frame, because the title screen and the mission
 * share one directional light and swap its direction between them. A follow
 * that also wrote the position would be two owners of one transform, resolved by
 * whichever ran later in the loop — the exact shape of bug that is invisible
 * until somebody reorders two statements.
 *
 * So the light is left alone and the BOX is offset instead: three puts the
 * shadow camera on the light looking at its target, and `left/right/top/bottom/
 * near/far` are ours to place anywhere in that view. An asymmetric orthographic
 * frustum is the whole trick, and it costs nothing — the depth RANGE is
 * `2 x boxHalfSize + castDistance` either way, so precision is identical; only
 * the near plane's absolute value differs, and an orthographic depth is linear,
 * so an absolute value means nothing to it.
 *
 * The second thing it buys is that the sun's DIRECTION is read off the light
 * rather than re-derived. `boot/app.ts` decides per frame whether the sun is the
 * mission's or the title's; a copy of that ternary here would be a second
 * derivation of a thing the scene already knows, which is DEV-042's lesson
 * exactly — compose, do not re-derive.
 */
export interface ShadowFitInput {
  /** Where the box is centred — the camera's WORLD position. Metres. */
  readonly centre: Vec3
  /** The light's WORLD position (`getWorldPosition`, not `.position`). */
  readonly lightPosition: Vec3
  /** The light TARGET's world position. Together these give three's view basis. */
  readonly lightTarget: Vec3
  /** Half the box, in metres. The box is `2 x this` on both lateral axes. */
  readonly boxHalfSize: number
  /** Shadow map edge in texels. A power of two. */
  readonly mapSize: number
  /** Metres up-sun of the box that casters are gathered from. */
  readonly castDistance: number
}

export interface ShadowFit {
  readonly left: number
  readonly right: number
  readonly bottom: number
  readonly top: number
  readonly near: number
  readonly far: number
  /** Metres per shadow texel: `2 * boxHalfSize / mapSize`. */
  readonly texelSize: number
  /** The snapped centre, back in WORLD space. What the tests measure. */
  readonly centre: Vec3
}

const normalise = (v: Vec3): Vec3 => {
  const len = Math.hypot(v[0], v[1], v[2])
  if (!(len > 0)) return [0, 0, 1]
  return [v[0] / len, v[1] / len, v[2] / len]
}

const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/**
 * The shadow camera's own axes, transcribed from `Matrix4.lookAt`.
 *
 * three builds the light's view with `shadowCamera.lookAt( target )`, which is
 * `Matrix4.lookAt( eye, target, up )` with `up` the camera's own — the shadow
 * camera's untouched default `(0, 1, 0)`. Its `z` is `normalize(eye - target)`,
 * its `x` is `normalize(cross(up, z))` and its `y` is `cross(z, x)`. Any other
 * basis would be quantising the snap against axes the map is not sampled on,
 * which is a snap that does nothing.
 *
 * The degenerate branch is three's own rather than an approximation of it: with
 * `up` parallel to `z` — a sun directly overhead — three nudges `z.z` by 1e-4
 * and retries. `|up.z|` is 0 here and never 1, so the other arm of three's
 * branch is unreachable and is not reproduced.
 */
export const lightBasis = (
  lightPosition: Vec3,
  lightTarget: Vec3,
): { x: Vec3; y: Vec3; z: Vec3 } => {
  let z = normalise([
    lightPosition[0] - lightTarget[0],
    lightPosition[1] - lightTarget[1],
    lightPosition[2] - lightTarget[2],
  ])
  const up: Vec3 = [0, 1, 0]
  let x = cross(up, z)
  if (dot(x, x) === 0) {
    z = normalise([z[0], z[1], z[2] + 0.0001])
    x = cross(up, z)
  }
  x = normalise(x)
  return { x, y: cross(z, x), z }
}

/**
 * How far along the light a band of `heightSpan` metres of relief reaches.
 *
 * `heightSpan / sin(elevation)`, and at `int_01`'s 4 degrees on Simonet's
 * 1,536 m `terrainHeight` that is **22.0 km**: the true set of casters that can
 * geometrically reach the box under this sun. Exported because it is the number
 * that says why `castDistance` exists and why `castDistance` is not the honest
 * answer — a diagnostic to quote in a review, never called by the fit.
 */
export const casterSpan = (heightSpan: number, sunDirection: Vec3): number => {
  const l = normalise(sunDirection)
  return heightSpan / Math.max(-l[1], MIN_SUN_SIN)
}

/**
 * Fit the orthographic shadow box to a sphere of `boxHalfSize` about `centre`,
 * and snap it to the texel lattice.
 *
 * The box's lateral half-width is a whole number of texels by construction
 * (`boxHalfSize / texelSize` is `mapSize / 2`), so quantising the CENTRE to
 * texels puts `left` and `bottom` on the lattice too — which is what makes the
 * grid stationary in world space rather than merely coarser.
 *
 * Pure: no three, no module scratch, no state. Called twice with one input it
 * returns one answer, which is what makes the snapping testable at all.
 */
export const fitSunShadow = (input: ShadowFitInput): ShadowFit => {
  const { x, y, z } = lightBasis(input.lightPosition, input.lightTarget)
  const half = Math.max(input.boxHalfSize, 0)
  const texelSize = (2 * half) / Math.max(input.mapSize, 1)

  // The box centre, in the light's own view space: `x`/`y` lateral, `z` back
  // toward the light. `dLocal` is how far in FRONT of the light the centre is.
  const rel: Vec3 = [
    input.centre[0] - input.lightPosition[0],
    input.centre[1] - input.lightPosition[1],
    input.centre[2] - input.lightPosition[2],
  ]
  const cx = dot(rel, x)
  const cy = dot(rel, y)
  const dLocal = -dot(rel, z)

  // Quantise the two LATERAL axes and leave depth alone: depth does not sample a
  // texel grid, so snapping it would move the near plane for nothing.
  const sx = texelSize > 0 ? Math.round(cx / texelSize) * texelSize : cx
  const sy = texelSize > 0 ? Math.round(cy / texelSize) * texelSize : cy

  const cast = Math.max(input.castDistance, 0)
  return {
    left: sx - half,
    right: sx + half,
    bottom: sy - half,
    top: sy + half,
    // Up-sun by `castDistance` past the box, and down-sun to its far side.
    near: dLocal - half - cast,
    far: dLocal + half,
    texelSize,
    centre: [
      input.lightPosition[0] + sx * x[0] + sy * y[0] - dLocal * z[0],
      input.lightPosition[1] + sx * x[1] + sy * y[1] - dLocal * z[1],
      input.lightPosition[2] + sx * x[2] + sy * y[2] - dLocal * z[2],
    ],
  }
}

/**
 * three's `shadow.bias` from a bias in METRES.
 *
 * `shadowmap_pars_fragment` does `shadowCoord.z += shadowBias` on a coordinate
 * that has already been divided through, so three's number is in NORMALISED
 * depth: its value in metres is `bias x (far - near)`, and it silently changes
 * meaning whenever `boxHalfSize` or `castDistance` move. A preset that carried
 * three's units would be a number nobody could reason about and that DEV-027's
 * rule — say what a number is the distance OF — would have no answer for. So the
 * preset carries metres, positive, and this is the conversion. The sign flips
 * because the depth compare is `LEQUAL`: pulling the receiver TOWARD the light
 * is what stops it shadowing itself.
 */
export const shadowBiasFor = (metres: number, fit: ShadowFit): number => {
  const range = fit.far - fit.near
  if (!(range > 0)) return 0
  return -Math.abs(metres) / range
}

/**
 * `render.shadows.edgeFade` in the SHADOW MAP'S OWN UNITS: the fraction of
 * the box's lateral width, and of its depth range, that the band is. DEV-453.
 *
 * ── Why the fade is in the map's coordinates and not the camera's distance ─
 *
 * The line Matt saw is where `getShadow` stops answering, and that is the
 * box's FACES — across the sun at `±boxHalfSize`, and down-sun at the far
 * plane — not a sphere round the eye. A distance fade would leave a corner of
 * the box's footprint hard and fade shadows the map really has. So the shader
 * measures the fragment's own shadow coordinate against the faces, which is
 * the one quantity that is exactly zero where the map ends.
 *
 * `x` is `edgeFade / (right - left)` and `y` is `edgeFade / (far - near)`.
 * Both are read off `fitSunShadow`'s OWN extents rather than re-derived: its
 * lateral width is `2 x boxHalfSize` and its depth range is `2 x boxHalfSize
 * + castDistance` whatever the centre or the sun, and `shadows.test.ts` holds
 * this function against a real fit so the two cannot drift. Only the FAR
 * plane fades. The near one sits `castDistance` up-sun of the box, and a
 * receiver that reaches it has nothing between it and the light inside the
 * map, so the map is already answering lit there: there is no shadow to cut.
 */
export const shadowEdgeFadeUv = (
  shadows: Pick<EditionShadows, 'boxHalfSize' | 'castDistance' | 'edgeFade'>,
): { readonly lateral: number; readonly depth: number } => {
  const width = 2 * Math.max(shadows.boxHalfSize, 0)
  const depth = width + Math.max(shadows.castDistance, 0)
  const band = Math.max(shadows.edgeFade, 0)
  return {
    lateral: width > 0 ? band / width : 0,
    depth: depth > 0 ? band / depth : 0,
  }
}

// ── the live system ───────────────────────────────────────────────────────

/**
 * Whether the map runs at all, from the preset AND the player's quality tier.
 *
 * `low` is the tier a Quest that could not hold 72 Hz was dropped to, and a
 * depth pass over every LOD-0 chunk in a 5.8 km prism is the single most
 * expensive thing this preset adds. So `low` says no whatever the JSON says —
 * and because the preset flag is above it, a headset session that finds the
 * frame time gone can turn the whole thing off from the Edition page without
 * touching the quality tier it wanted.
 */
export const shadowsEnabled = (edition: Edition, settings: ComfortSettings): boolean =>
  edition.render.shadows.enabled && settings.quality !== 'low'

/**
 * Whether the sun's map runs in a MISSION. DEV-932.
 *
 * `shadowsEnabled` is the machinery, and it is every scene's: the hangar's key
 * light (`hangar-light.ts`, DEV-440) and the title's sun cast under it alone.
 * This composes it with `render.missionShadows`, the one key Anniversary's
 * `vr.disable` names, so a headset drops the map from a mission and the menus
 * keep theirs. Every pass that only exists in a mission and rides the sun's map
 * reads THIS: the cockpit's own map, the near cascade, the hull's shadow draw,
 * the cockpit receiving. With it off nothing samples a map that is not drawn,
 * and `far-shadow.ts`'s no-map branch keeps the terrain shadowed.
 */
export const missionShadowsEnabled = (edition: Edition, settings: ComfortSettings): boolean =>
  shadowsEnabled(edition, settings) && edition.render.missionShadows.enabled

/**
 * The caster set the live preset and the live quality tier ask for.
 *
 * Composed from `shadowsEnabled` rather than beside it, so a tier that has no
 * shadow map at all cannot report a caster in it. `low` therefore answers false
 * for the same reason the map is off there, and without a second copy of that
 * rule.
 */
export const shadowCastersFor = (edition: Edition, settings: ComfortSettings): ShadowCasters => ({
  scatter: shadowsEnabled(edition, settings) && edition.props.scatterShadows.enabled,
  // DEV-350: the livery AND its shadow — a hologram never casts.
  racers:
    shadowsEnabled(edition, settings) &&
    edition.render.racerLivery.enabled &&
    edition.render.racerLivery.shadow.enabled,
})

/**
 * The receiver set the live preset and the live quality tier ask for.
 *
 * Composed from `shadowsEnabled` for `shadowCastersFor`'s reason: a tier with
 * no map at all cannot report a receiver of it, and that rule is written once.
 */
export const shadowReceiversFor = (
  edition: Edition,
  settings: ComfortSettings,
): ShadowReceivers => ({
  // DEV-932: the cockpit is only ever in a mission.
  cockpit: missionShadowsEnabled(edition, settings) && edition.render.cockpitShadow.enabled,
})

/**
 * How much of the DIRECT sun under a prop the BAKED canopy still owns, 0..1.
 *
 * ── The bug this is the whole of ─────────────────────────────────────────
 *
 * DEV-295 darkens the ground under the scatter by multiplying **all four**
 * `reflectedLight` accumulators — the two `direct` ones included — and it is
 * allowed to touch the direct sun for exactly one reason, stated in its own
 * schema entry: *"`render.props.scatterShadows` is false on both presets, so a
 * tree casts nothing on the ground it stands on ... there is no live shadow to
 * double."* The moment `scatterShadows` goes true that premise is gone: the
 * forest floor is shadowed by the depth pass AND by the bake, once each, and
 * the result does not read as a double count. **It reads as "the 2D shadows
 * are too dark"**, which is a sentence that sends the next session to
 * `render.shadows.bias` and the sun elevation. DEV-304.
 *
 * ── Why it is HERE, and why it is a number ───────────────────────────────
 *
 * `far-shadow.ts` could have asked `edition.props.scatterShadows.enabled`
 * directly and been wrong twice: at quality `low` there is no map at all, and
 * while a headset is presenting `vr.disable` has already turned the flag off.
 * `shadowCastersFor` is the one expression that composes all three, so the
 * answer is composed FROM it rather than beside it — the same discipline
 * `shadowCastersFor` itself applies to `shadowsEnabled`.
 *
 * A number rather than a boolean because it is fed to a uniform and multiplied,
 * and because a partial handover is a knob somebody may want: see the note on
 * the 700 m box in `far-shadow.ts`'s `canopyPatchFragment`. Nothing ships a
 * value between 0 and 1 today and the shader is linear in it, so a preset that
 * wanted 0.5 would need no shader change.
 */
export const canopyDirectWeight = (edition: Edition, settings: ComfortSettings): number =>
  shadowCastersFor(edition, settings).scatter ? 0 : 1

/** A terrain that can flag its own chunks — `LoadedTerrain` satisfies it. */
export interface ShadowTerrain {
  setShadows(on: boolean): void
}

/**
 * The two properties of the renderer this file writes.
 *
 * Structural rather than a `Pick<THREE.WebGLRenderer, 'shadowMap'>` because
 * `shadowMap` is an OBJECT: a `Pick` would demand a whole `WebGLShadowMap`, and
 * a test would then need a GL context to assert that Classic touches nothing —
 * which is the one assertion that most needs to be cheap enough to always run.
 * A real `WebGLRenderer` satisfies this.
 */
export interface ShadowRenderer {
  shadowMap: { enabled: boolean; type: THREE.ShadowMapType }
}

/** What the world hands over once it has loaded. Everything is optional. */
export interface SunShadowScene {
  /** Land and ocean alike; each knows which of its chunks are at LOD 0. */
  readonly terrains?: readonly ShadowTerrain[]
  /**
   * The SCATTER's `InstancedMesh`es. Instanced geometry casts like any other —
   * and is the one class a preset can take out of the caster set (DEV-224), so
   * it arrives apart from the landmarks rather than flattened in with them.
   */
  readonly scatter?: readonly ShadowFlags[]
  /** The hand-placed landmarks' `InstancedMesh`es: desert 16, Simonet 1. */
  readonly landmarks?: readonly ShadowFlags[]
  /**
   * The exterior hull's MESHES — `shadowMeshesOf(ship_third_person)`. Empty on
   * the JumpSeat, which has no exterior model.
   *
   * A LIST and not the glTF scene root, and that is the whole of DEV-305's
   * first half: three tests `castShadow` on the object it draws, so the flag
   * on a `Group` had never reached the one `Mesh` under it. `shadowMeshesOf`
   * carries the argument.
   */
  readonly shipExterior?: readonly ShadowFlags[]
  /**
   * The cockpit shell's MESHES — `shadowMeshesOf(ship_first_person)`. DEV-306.
   *
   * It has no entry here at all before DEV-306: `shadowFlagsFor` has carried a
   * `ship-cockpit` row since the map landed and nothing ever handed one in, so
   * the cockpit's two flags were three's defaults rather than this table's
   * answer. They agreed — `{false, false}` either way — which is exactly why
   * nobody noticed, and is the same shape as the `Group` above.
   */
  readonly shipCockpit?: readonly ShadowFlags[]
  /**
   * The AI racers' MESHES — `LoadedRacers.shadowMeshes`, hull, projectors and
   * glow, as `shipExterior` is the player's. DEV-350. Whether they cast is
   * `ShadowCasters.racers`; the list is handed in whatever the preset says.
   */
  readonly racers?: readonly ShadowFlags[]
  /**
   * Which world this is. DEV-932: `title` keeps the map under `render.shadows`
   * alone, like the hangar; a `mission` (the default, and the editor's
   * playtest) also asks `render.missionShadows`, which a headset turns off.
   */
  readonly world?: 'mission' | 'title'
}

export interface SunShadows {
  /** Hand over the world once it has landed. Applies the live preset at once. */
  attach(scene: SunShadowScene): void
  /**
   * Refit the box. Once a frame, from the per-frame Anniversary seam.
   *
   * Takes the CAMERA rather than a position: in the cockpit `camera.position` is
   * the head pose inside the XR rig and is the origin until you lean (trap 18),
   * so the world position has to be asked for.
   */
  update(camera: THREE.Object3D): void
  /** The live fit, or null while the map is off. For tests and the console. */
  readonly fit: ShadowFit | null
  /** Whether the map is on right now. */
  readonly on: boolean
  dispose(): void
}

/** Scratch. Valid only inside one synchronous call — never stored (trap 19). */
const _centre = new THREE.Vector3()
const _lightPos = new THREE.Vector3()
const _lightTarget = new THREE.Vector3()

/**
 * The mission sun's shadow map, wired to the live preset.
 *
 * `sun` is the light `applyLighting` built, or null for a mission with no
 * directional light — in which case every method is a no-op and Classic and
 * Anniversary are identical, which is the right answer for a scene with no sun
 * to cast from.
 */
export const createSunShadows = (
  renderer: ShadowRenderer,
  sun: THREE.DirectionalLight | null,
  editionState: EditionState,
): SunShadows => {
  let scene: SunShadowScene = {}
  let fit: ShadowFit | null = null
  let on = false
  /** The last centre we fitted to, so `apply` can refit without a camera. */
  let centre: Vec3 = [0, 0, 0]
  /** What `shadow.map` was sized for. A change has to throw the target away. */
  let sizedFor = 0

  const subjects = (): ShadowSubject[] => {
    const list: ShadowSubject[] = []
    for (const p of scene.scatter ?? []) list.push({ role: 'prop-scatter', target: p })
    for (const p of scene.landmarks ?? []) list.push({ role: 'prop-landmark', target: p })
    for (const m of scene.shipExterior ?? []) list.push({ role: 'ship-exterior', target: m })
    for (const m of scene.shipCockpit ?? []) list.push({ role: 'ship-cockpit', target: m })
    for (const m of scene.racers ?? []) list.push({ role: 'racer-hull', target: m })
    return list
  }

  /** Rebuild the ortho box and push it at three. Cheap; safe every frame. */
  const refit = (): void => {
    if (!sun || !on) return
    const s = editionState.current.render.shadows
    // The light's world transform, not its local one — `boot/app.ts` adds both
    // the light and its target to the scene root today, but a file that reads
    // `.position` is a file that breaks silently the day one of them is
    // parented. And `matrixWorld` is stale here, because three does not
    // recompute it until `render()` (the same fact that makes `grip.matrixWorld`
    // stale inside an XR frame callback).
    sun.updateWorldMatrix(true, false)
    sun.target.updateWorldMatrix(true, false)
    const next = fitSunShadow({
      centre,
      lightPosition: sun.getWorldPosition(_lightPos).toArray() as [number, number, number],
      lightTarget: sun.target.getWorldPosition(_lightTarget).toArray() as [number, number, number],
      boxHalfSize: s.boxHalfSize,
      mapSize: s.mapSize,
      castDistance: s.castDistance,
    })
    const cam = sun.shadow.camera
    // `updateProjectionMatrix` only when one of the six actually moved. With the
    // snap they move in whole texels, so a ship holding station moves none of
    // them and this is a comparison and nothing else.
    if (
      cam.left !== next.left ||
      cam.right !== next.right ||
      cam.bottom !== next.bottom ||
      cam.top !== next.top ||
      cam.near !== next.near ||
      cam.far !== next.far
    ) {
      cam.left = next.left
      cam.right = next.right
      cam.bottom = next.bottom
      cam.top = next.top
      cam.near = next.near
      cam.far = next.far
      cam.updateProjectionMatrix()
    }
    // In NORMALISED depth, from the preset's metres — and it has to be redone
    // whenever the fit changes, because three's number means `metres / (far -
    // near)` and the range is the preset's to move. See `shadowBiasFor`.
    sun.shadow.bias = shadowBiasFor(s.bias, next)
    sun.shadow.normalBias = s.normalBias
    sun.shadow.radius = s.radius
    fit = next
  }

  /**
   * Put the live preset on the renderer, the light and every object.
   *
   * `renderer.shadowMap.enabled` and `sun.castShadow` ALWAYS move together, and
   * that is load-bearing rather than tidy: `shadowMap.enabled` alone changes the
   * `USE_SHADOWMAP` define with nothing to notice, while `castShadow` changes
   * `numDirectionalShadows` in `WebGLLights`' hash, which bumps
   * `state.version`, which is the first branch of `needsProgramChange`. Moving
   * both is what makes the flip recompile itself.
   */
  const apply = (): void => {
    // DEV-932: the MACHINERY is every scene's (the hangar's key light casts
    // through this same `renderer.shadowMap`), the SUN's map is the world's.
    // With the machinery on and the sun not casting, three draws no depth pass
    // (`WebGLShadowMap.render` returns on no casting light) and compiles no
    // `USE_SHADOWMAP` (`shadowMapEnabled` wants a casting light too).
    const machinery = sun !== null && shadowsEnabled(editionState.current, editionState.settings)
    const want =
      machinery &&
      (scene.world === 'title' ||
        missionShadowsEnabled(editionState.current, editionState.settings))
    on = want
    renderer.shadowMap.enabled = machinery
    for (const terrain of scene.terrains ?? []) terrain.setShadows(want)
    // The caster set, not just the switch: `props.scatterShadows` takes the
    // scatter out of the depth pass while the map itself stays on (DEV-224).
    applyShadowFlags(
      subjects(),
      want,
      shadowCastersFor(editionState.current, editionState.settings),
      shadowReceiversFor(editionState.current, editionState.settings),
    )
    if (!sun) return
    sun.castShadow = want
    if (!want) return
    // Asked for by name rather than left at three's default, because the name
    // that reads as "the soft one" is the deprecated one: `PCFSoftShadowMap`
    // makes `WebGLShadowMap.render` warn on every frame it is set and then use
    // this anyway (`three.module.js:9148-9152`). Set INSIDE the enabled branch
    // so that Classic leaves `shadowMap` exactly as the renderer built it.
    renderer.shadowMap.type = THREE.PCFShadowMap
    const size = editionState.current.render.shadows.mapSize
    if (sizedFor !== size) {
      // three sizes the target once, at first use, and never looks again — so a
      // preset with a different `mapSize` needs the old one thrown away.
      sun.shadow.map?.dispose()
      sun.shadow.map = null
      sun.shadow.mapSize.set(size, size)
      sizedFor = size
    }
    refit()
  }

  apply()
  const unsubscribe = editionState.subscribe(apply)

  return {
    attach(next) {
      scene = next
      apply()
    },
    update(camera) {
      if (!on) return
      centre = camera.getWorldPosition(_centre).toArray() as [number, number, number]
      refit()
    },
    get fit() {
      return on ? fit : null
    },
    get on() {
      return on
    },
    dispose() {
      unsubscribe()
    },
  }
}
